import { afterEach, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { recoveryRuntimeFixture } from './helpers/recovery-runtime-fixture.js'
import { until } from './helpers/headless-runtime-fixture.js'

const scopes: Array<Awaited<ReturnType<typeof recoveryRuntimeFixture>>> = []
afterEach(async () => {
  const results = await Promise.allSettled(scopes.splice(0).reverse().map(scope => scope.cleanup()))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Private resumed-turn Runtime cleanup failed')
})
const command = resolve(import.meta.dirname, 'fixtures/resumed-turn-native-cli.mjs')
const root = resolve(import.meta.dirname, '../../..')
const evidenceDirectory = resolve(root, '.tmp/recovery-protocol-convergence/provider-runtime-cases')
const candidateFiles = ['packages/core/src/client.ts', 'packages/core/src/agent-session-resumed-interruption.ts',
  'packages/core/src/agent-session-continuity-input.ts', 'packages/core/src/providers/codex-resumed-turn-interruption.ts',
  'packages/core/src/providers/codex-managed-run.ts', 'packages/core/src/providers/codex-native-input.ts',
  'packages/core/dist/client.js', 'packages/core/dist/agent-session-resumed-interruption.js',
  'packages/core/dist/agent-session-continuity-input.js', 'packages/core/dist/providers/codex-resumed-turn-interruption.js',
  'packages/core/dist/providers/codex-managed-run.js', 'packages/core/dist/providers/codex-native-input.js',
  'packages/core/test/fixtures/resumed-turn-native-cli.mjs', 'packages/core/test/resumed-turn-runtime.integration.test.ts']
const candidateHashes = async () => Object.fromEntries(await Promise.all(candidateFiles.map(async file =>
  [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])))
const records = async (path: string): Promise<Array<Record<string, any>>> => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const inputRecords = (values: Array<Record<string, any>>) => values.filter(value => value.kind === 'input')
const markerCount = (values: Array<Record<string, any>>) => {
  const pty = values.filter(value => value.kind === 'stdin').map(value => Buffer.from(value.base64, 'base64').toString('utf8')).join('')
  const native = inputRecords(values).map(value => value.input.map((part: { text: string }) => part.text).join('\n')).join('\n')
  return (pty.match(/<amux:continue \/>/gu) ?? []).length + (native.match(/<amux:continue \/>/gu) ?? []).length
}

it.runIf(process.platform === 'darwin').each(['interrupted', 'completed', 'unknown'] as const)(
  'real private ctxmux resume refines the original %s turn through native RPC and submits only one authorized marker', async outcome => {
    const scope = await recoveryRuntimeFixture(); scopes.push(scope)
    const { client } = await scope.connect(), witness = join(scope.root, 'native-witness.jsonl')
    const env = { CODEX_HOME: join(scope.root, 'codex'), AGENTMUX_RESUMED_WITNESS: witness, AGENTMUX_RESUMED_OUTCOME: outcome }
    const inputsBefore = await candidateHashes()
    try {
      const original = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
        commandOverride: command, env, createOperationId: 'private-protocol-recovery-original', injectAgentMuxGuide: false })
      scope.trackRun(original.run.runId)
      await until(() => client.agentSession(original.agentSessionId), value => Boolean(value.nativeHandle), 'original native source is bound', 30_000)
      // This ordinary public observation starts the existing native status owner;
      // the fixture has no synthetic Hook or injected semantic status.
      await client.statusAgent(original.agentSessionId)
      const saved = await until(() => client.agentSession(original.agentSessionId),
        value => value.semanticStatus?.state === 'working', 'original exact private native activity', 30_000)
      if (saved.nativeHandle?.kind !== 'provider' || !saved.nativeHandle.transcriptPath) throw new Error('Original native source was not bound')
      const before = await client.statusAgent(original.agentSessionId)
      scope.trackRun(original.run.runId, before.run.pid)
      await scope.stopOwner()
      process.kill(before.run.pid!, 'SIGTERM')
      await until(() => {
        try { process.kill(before.run.pid!, 0); return false } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          return true
        }
      }, value => value, 'private original process actually ends', 15_000)
      const next = await scope.restartOwner()
      await until(() => client.runtimeOwnerIdentity(), value => value?.ownerInstanceId === next.ownerInstanceId && value.availability === 'connected', 'private semantic owner reconnects', 30_000)
      expect((await client.statusAgent(original.agentSessionId)).run.state).toBe('exited')
      const request = { agentSessionId: original.agentSessionId, expectedRun: original.run,
        operationId: 'private-protocol-native-resume', trigger: 'startup' as const, commandOverride: command, env }
      const resumed = await client.ensureAgentContinuity(request)
      expect(resumed.kind).toBe('resumed')
      if (resumed.kind !== 'resumed') throw new Error('Exact native resume was not established')
      scope.trackRun(resumed.run.runId)
      expect(resumed.session).toMatchObject({ agentSessionId: original.agentSessionId, nativeHandle: saved.nativeHandle, workspacePath: scope.root })
      expect(resumed.run.runId).not.toBe(original.run.runId)
      expect(resumed.continuity?.interruption).toMatchObject({ state: 'unknown', support: 'provider',
        nativeTurnId: 'original-retained-turn', reason: 'native-turn-end-unconfirmed' })
      await until(() => records(witness), values => values.some(value => value.kind === 'rpc' && value.resumed && value.method === 'thread/turns/list'), 'actual post-resume original actor turn metadata read', 30_000)
      const expected = outcome === 'interrupted' ? 1 : 0
      if (outcome === 'interrupted') {
        const current = await until(() => client.agentSession(original.agentSessionId),
          value => value.continuity?.recoveryDelivery?.phase === 'accepted', 'original input owner accepts exact marker', 30_000)
        const delivery = current.continuity!.recoveryDelivery!
        expect(current.continuity?.resumedInterruption).toMatchObject({ state: 'interrupted', nativeTurnId: 'original-retained-turn', run: resumed.run })
        expect(delivery.continuation.text).toBe('<amux:continue />')
        expect((await client.inspectAgentPromptSubmission(delivery.key))?.admission).toMatchObject({ acknowledged: true,
          intent: { message: { userContent: '<amux:continue />' } } })
      } else {
        if (outcome === 'completed') await until(() => client.agentSession(original.agentSessionId),
          value => value.continuity?.resumedInterruption?.state === 'not-interrupted', 'accurate native normal end stays non-interrupted', 30_000)
        expect(client.agentSession(original.agentSessionId).continuity?.recoveryDelivery).toBeUndefined()
      }
      await client.ensureAgentContinuity(request)
      const again = await scope.restartOwner()
      await until(() => client.runtimeOwnerIdentity(), value => value?.ownerInstanceId === again.ownerInstanceId && value.availability === 'connected', 'second semantic owner reconnects', 30_000)
      await client.ensureAgentContinuity(request)
      const received = await records(witness)
      expect(markerCount(received)).toBe(expected)
      expect(received.filter(value => value.kind === 'backend')).toHaveLength(2)
      expect(received.some(value => value.kind === 'frontend' && value.args.includes('--dangerously-bypass-hook-trust'))).toBe(true)
      expect(received.find(value => value.kind === 'rpc' && value.method === 'thread/resume')?.params.config).toMatchObject({ bypass_hook_trust: true })
      expect((await readFile(saved.nativeHandle.transcriptPath, 'utf8'))).not.toContain('turn_aborted')
      console.log(JSON.stringify({ schema: 'agentmux.resumed-turn-native-runtime-proof.v1', outcome, agentSessionId: original.agentSessionId,
        oldRun: original.run, newRun: resumed.run, oldPid: before.run.pid, nativeSessionId: saved.nativeHandle.sessionId,
        markerCount: markerCount(received), actualPostResumeRpc: true, semanticOwnerRestartedTwice: true, unknownPriorInputReplayed: false }))
    } finally {
      await mkdir(evidenceDirectory, { recursive: true })
      const inputsAfter = await candidateHashes()
      await writeFile(join(evidenceDirectory, outcome + '.json'), JSON.stringify({ outcome, privateRoot: scope.root,
        witness: await records(witness).catch(error => [{ captureError: String(error) }]), sessions: client.agentSessions(),
        inputsBefore, inputsAfter, candidateStable: JSON.stringify(inputsBefore) === JSON.stringify(inputsAfter) }, null, 2) + '\n', { mode: 0o600 })
      expect(inputsAfter).toEqual(inputsBefore)
    }
  }, 120_000)
