import { afterEach, expect, it } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { recoveryRuntimeFixture } from './helpers/recovery-runtime-fixture.js'
import { until } from './helpers/headless-runtime-fixture.js'

const scopes: Array<Awaited<ReturnType<typeof recoveryRuntimeFixture>>> = []
afterEach(async () => {
  const results = await Promise.allSettled(scopes.splice(0).reverse().map(scope => scope.cleanup()))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Private native diagnostic Runtime cleanup failed')
})
const root = resolve(import.meta.dirname, '../../..')
const command = resolve(import.meta.dirname, 'fixtures/native-diagnostic-cli.mjs')
const evidenceDirectory = resolve(root, '.tmp/recovery-late-exit-convergence/diagnostic-runtime-cases')
const candidateFiles = ['packages/core/src/client.ts', 'packages/core/src/providers/codex-native-input.ts',
  'packages/core/dist/client.js', 'packages/core/dist/providers/codex-native-input.js',
  'packages/core/src/providers/codex-managed-run.ts', 'packages/core/src/providers/codex-managed-diagnostics.ts',
  'packages/core/src/providers/codex-native-rpc.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/dist/providers/codex-managed-run.js', 'packages/core/dist/providers/codex-managed-diagnostics.js',
  'packages/core/dist/providers/codex-native-rpc.js', 'packages/core/dist/public-rpc-service.js',
  'packages/core/test/fixtures/native-diagnostic-cli.mjs', 'packages/core/test/native-diagnostics-runtime.integration.test.ts']
const hashes = async () => Object.fromEntries(await Promise.all(candidateFiles.map(async file =>
  [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])))
const records = async (path: string): Promise<Array<Record<string, any>>> => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const knownCredentials = (diagnostic: string): string[] => [diagnostic.split('actor=')[1]!.split('\n')[0]!, diagnostic.split('capability=')[1]!.split('\n')[0]!]
const masked = (diagnostic: string, credentials: string[]): string => credentials.reduce((text, credential) => text.replaceAll(credential, '[redacted]'), diagnostic)

it.runIf(process.platform === 'darwin').each(['rpc-rejection', 'transport-close'] as const)(
  'public Agent inspection and exact private Run output retain native %s diagnostics', async failure => {
    const scope = await recoveryRuntimeFixture(); scopes.push(scope)
    const { client } = await scope.connect(), witness = join(scope.root, 'native-diagnostics.jsonl'), before = await hashes()
    const env = { CODEX_HOME: join(scope.root, 'codex'), AGENTMUX_DIAGNOSTIC_WITNESS: witness, AGENTMUX_DIAGNOSTIC_FAILURE: failure }
    let proof: Record<string, unknown> | undefined
    try {
      const original = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
        commandOverride: command, env, createOperationId: 'private-native-diagnostics-original', injectAgentMuxGuide: false })
      scope.trackRun(original.run.runId)
      const saved = await until(() => client.agentSession(original.agentSessionId), value => Boolean(value.nativeHandle), 'private original native binding', 30_000)
      if (saved.nativeHandle?.kind !== 'provider') throw new Error('The exact private native source was not bound')
      const nativeId = saved.nativeHandle.sessionId
      const initial = await client.statusAgent(original.agentSessionId); scope.trackRun(original.run.runId, initial.run.pid)
      await client.signalAgent(original.agentSessionId, original.run, 'SIGINT')
      await until(() => client.statusAgent(original.agentSessionId), value => value.run.state === 'exited', 'private original Run exit')
      const attempt = await client.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: original.run,
        operationId: 'private-native-diagnostic-resume', trigger: 'manual', commandOverride: command, env })
        .then(value => ({ status: 'returned' as const, kind: value.kind }), error => ({ status: 'rejected' as const, code: error.code }))
      // An opening receipt can precede process exit; only the original Run owns that terminal fact.
      if (attempt.status === 'returned') expect(attempt.kind).toBe('resumed')
      else expect(typeof attempt.code).toBe('string')
      const current = await until(() => client.refreshAgentSession(original.agentSessionId),
        value => Boolean(value.continuityOperations?.['private-native-diagnostic-resume']?.errorCode), 'private failed native operation diagnostic', 30_000)
      const operation = current.continuityOperations?.['private-native-diagnostic-resume']
      expect(operation?.previousRun).toEqual(original.run)
      const failedRun = operation?.newRun
      if (!failedRun) throw new Error('The original failed native attempt lost its Run receipt')
      expect(failedRun.runId).not.toBe(original.run.runId)
      scope.trackRun(failedRun.runId)
      expect(current.agentSessionId).toBe(original.agentSessionId)
      expect(current.nativeHandle).toEqual(saved.nativeHandle)
      expect(current.run).toEqual(original.run)
      const agentRecords = await records(witness), agentDiagnostic = agentRecords.find(value => value.kind === 'diagnostic')!.diagnostic as string
      const agentCredentials = knownCredentials(agentDiagnostic)
      const cause = failure === 'rpc-rejection' ? '[code=-32602]: Exact original native configuration rejected; actor=[redacted]' : 'Original native actor transport closed.'
      expect(operation?.error).toContain(cause)
      for (const credential of agentCredentials) expect(operation?.error).not.toContain(credential)
      const agentReplay = await client.readRunReplay(failedRun, 0, 'raw')
        .then(value => ({ state: 'readable', runId: value.run.runId }), error => ({ state: 'unavailable', code: error.code }))
      if (agentReplay.state === 'unavailable') expect('code' in agentReplay && agentReplay.code).toBe('STALE_AGENT_SESSION_BINDING')
      else expect('runId' in agentReplay && agentReplay.runId).toBe(failedRun.runId)
      expect(agentRecords.filter(value => value.kind === 'backend')).toHaveLength(2)
      expect(agentRecords.filter(value => value.kind === 'frontend')).toHaveLength(1)
      expect(agentRecords.filter(value => value.kind === 'rpc' && value.method === 'thread/resume')).toHaveLength(1)

      // Early failed Agent attempts may remain retired. Public inspection retains their cause;
      // this public Terminal exercises complete bytes from the same actual managed entry.
      const terminalWitness = join(scope.root, 'terminal-native-diagnostics.jsonl')
      const terminalCredentials = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
      const plan = { command, args: ['resume', nativeId], serverConfig: [], frontendArgs: [], resume: { threadId: nativeId } }
      const terminal = await client.createTerminal({ createOperationId: 'private-managed-diagnostic-output', workspacePath: scope.root,
        command: process.execPath, args: [resolve(root, 'packages/core/dist/providers/codex-managed-run.js'), JSON.stringify(plan)],
        env: { CODEX_HOME: join(scope.root, 'terminal-codex'), AGENTMUX_DIAGNOSTIC_WITNESS: terminalWitness, AGENTMUX_DIAGNOSTIC_FAILURE: failure,
          AGENTMUX_CODEX_ACTOR_TOKEN: terminalCredentials[0]!, AGENTMUX_AGENT_CAPABILITY: terminalCredentials[1]!,
          AGENTMUX_CODEX_ACTOR_ID: randomUUID(), AGENTMUX_CODEX_ACTOR_LIFECYCLE: randomUUID() } })
      scope.trackRun(terminal.runId, terminal.pid)
      const ended = await until(() => client.readRunReplay(terminal, 0, 'raw'),
        value => value.run.state === 'exited', 'private failed native resume exit', 30_000)
      expect(ended.run).toMatchObject({ runId: terminal.runId, exitCode: 1, acceptedInputBytes: 0 })
      expect(ended.gap).toBeNull()
      const output = Buffer.concat(ended.replay.map(value => Buffer.from(value.dataBytes)))
      const text = output.toString('utf8'), actual = await records(terminalWitness)
      const diagnostic = actual.find(value => value.kind === 'diagnostic')!.diagnostic as string
      const expected = masked(diagnostic, terminalCredentials).replaceAll('\n', '\r\n')
      expect(text).toContain(expected)
      for (const credential of terminalCredentials) expect(text).not.toContain(credential)
      expect(text).toContain(cause)
      expect(actual.filter(value => value.kind === 'backend')).toHaveLength(1)
      expect(actual.filter(value => value.kind === 'frontend')).toHaveLength(0)
      expect(actual.filter(value => value.kind === 'rpc' && value.method === 'thread/resume')).toHaveLength(1)
      const replay = await client.readRunReplay(terminal, 0, 'raw')
      expect(Buffer.concat(replay.replay.map(value => Buffer.from(value.dataBytes)))).toEqual(output)
      proof = { schema: 'agentmux.native-diagnostics-runtime-proof.v1', failure, agentSessionId: original.agentSessionId,
        originalRun: original.run, resumedRun: failedRun, launchAttempt: attempt, publicOutputBytes: output.length,
        outputConsumer: 'Hosted Core readRunReplay on the exact private Terminal managed entry Run', terminalRun: { runId: terminal.runId },
        agentConsumer: 'Hosted Core refreshAgentSession original continuity operation error/newRun', agentReplay,
        agentOperationCauseVisible: true, agentBackendCount: 2, agentFrontendCount: 1,
        completeServerDiagnostic: true, originalNativeCause: true, knownCredentialsMasked: true, acceptedInputBytes: ended.run.acceptedInputBytes,
        backendCount: 1, frontendCount: 0, sameNativeHandle: true }
      console.log(JSON.stringify(proof))
    } finally {
      await mkdir(evidenceDirectory, { recursive: true })
      const after = await hashes()
      await writeFile(join(evidenceDirectory, failure + '.json'), JSON.stringify({ proof, candidateStable: JSON.stringify(before) === JSON.stringify(after),
        inputsBefore: before, inputsAfter: after, sessions: client.agentSessions() }, null, 2) + '\n', { mode: 0o600 })
      expect(after).toEqual(before)
    }
  }, 90_000)
