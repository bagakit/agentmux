import { afterEach, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { recoveryRuntimeFixture } from './helpers/recovery-runtime-fixture.js'
import { until } from './helpers/headless-runtime-fixture.js'

const scopes: Array<Awaited<ReturnType<typeof recoveryRuntimeFixture>>> = []
afterEach(async () => {
  const results = await Promise.allSettled(scopes.splice(0).reverse().map(scope => scope.cleanup()))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Private closed Codex reopen cleanup failed')
})

type NativeWitness = {
  kind: string
  agentSessionId: string
  resumed?: boolean
  method?: string
  params?: { threadId?: string }
  base64?: string
}
const records = async (path: string): Promise<NativeWitness[]> => (await readFile(path, 'utf8'))
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as NativeWitness)
const command = resolve(import.meta.dirname, 'fixtures/resumed-turn-native-cli.mjs')

it.runIf(process.platform === 'darwin')('public Hosted reopen restores the retired Codex identity across real owner processes without replaying input', async () => {
  const scope = await recoveryRuntimeFixture(); scopes.push(scope)
  const { client } = await scope.connect(), firstOwner = scope.owner
  const witness = join(scope.root, 'closed-codex-native-witness.jsonl')
  const env = { CODEX_HOME: join(scope.root, 'codex'), AGENTMUX_RESUMED_WITNESS: witness, AGENTMUX_RESUMED_OUTCOME: 'completed' }
  const original = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
    commandOverride: command, env, createOperationId: 'private-closed-codex-create', injectAgentMuxGuide: false })
  scope.trackRun(original.run.runId)
  const saved = await until(() => client.agentSession(original.agentSessionId), value => Boolean(value.nativeHandle),
    'original Codex native conversation is bound', 30_000)
  if (saved.nativeHandle?.kind !== 'provider' || !saved.nativeHandle.transcriptPath) throw new Error('Original Codex transcript was not bound')
  expect(saved.creation?.initialPrompt).toBe('not-requested')
  const before = await client.statusAgent(original.agentSessionId)
  scope.trackRun(original.run.runId, before.run.pid)
  expect(before.run.state).toBe('running')
  const historyOptions = { commandOverride: command, env }
  const historyBefore = await client.sessionHistoryPage(original.agentSessionId, historyOptions)
  expect(historyBefore.items.length).toBeGreaterThan(0)
  expect(historyBefore.source).toEqual({ providerId: 'codex', nativeSessionId: saved.nativeHandle.sessionId })
  const transcriptBefore = await readFile(saved.nativeHandle.transcriptPath)

  // This public Stop retires the semantic Session, while ctxmux retains its ended Run.
  // It deliberately differs from killing a process and resuming an active registry entry.
  await client.stopAgent(original.agentSessionId, original.run)
  expect(await client.readAgentSessions()).toEqual([])
  const [retired] = await client.sessionHistorySources({ agentSessionId: original.agentSessionId })
  expect(retired).toMatchObject({ agentSessionId: original.agentSessionId, state: 'retired',
    history: { workspacePath: scope.root, nativeHandle: saved.nativeHandle, createdAt: saved.createdAt } })
  expect(retired?.retiredAt).toEqual(expect.any(Number))
  if (retired?.retiredAt === undefined) throw new Error('Original retirement epoch was not retained')
  const ended = await client.runtimeSubject({ kind: 'terminal-run', runId: original.run.runId })
  expect(ended.run.runId).toBe(original.run.runId)
  expect(['exited', 'interrupted']).toContain(ended.run.state)
  expect((await client.sessionHistoryPage(original.agentSessionId, historyOptions)).items).toEqual(historyBefore.items)

  const nextOwner = await scope.restartOwner()
  expect(nextOwner.processId).not.toBe(firstOwner.processId)
  expect(nextOwner.ownerInstanceId).not.toBe(firstOwner.ownerInstanceId)
  expect(nextOwner.runtimeId).toBe(firstOwner.runtimeId)
  expect(nextOwner.ctxmux).toEqual(firstOwner.ctxmux)
  await until(() => client.runtimeOwnerIdentity(), value => value?.ownerInstanceId === nextOwner.ownerInstanceId && value.availability === 'connected',
    'Hosted client reconnects to another semantic owner process', 30_000)
  expect(await client.readAgentSessions()).toEqual([])
  expect(await client.sessionHistorySources({ agentSessionId: original.agentSessionId })).toEqual([retired])
  expect((await client.runtimeSubject({ kind: 'terminal-run', runId: original.run.runId })).run.state).toBe(ended.run.state)

  const reopened = await client.reopenAgent({ agentSessionId: original.agentSessionId, expectedRetiredAt: retired.retiredAt,
    operationId: 'private-closed-codex-reopen', commandOverride: command, env })
  scope.trackRun(reopened.run.runId)
  expect(reopened.run.runId).not.toBe(original.run.runId)
  expect(reopened).toMatchObject({ agentSessionId: original.agentSessionId, providerId: 'codex', executorId: 'codex',
    workspacePath: scope.root, createdAt: saved.createdAt, nativeHandle: saved.nativeHandle, retiredRuns: [original.run],
    nativeBinding: { run: reopened.run }, reopenedFrom: { run: original.run, source: 'user', observedAt: retired.retiredAt } })
  const running = await client.statusAgent(original.agentSessionId)
  scope.trackRun(reopened.run.runId, running.run.pid)
  expect(running.run).toMatchObject({ runId: reopened.run.runId, state: 'running', workspacePath: scope.root })
  expect(running.run.pid).not.toBe(before.run.pid)
  await until(() => records(witness), values => values.some(value => value.kind === 'rpc' && value.resumed &&
    value.method === 'thread/resume' && value.params?.threadId === saved.nativeHandle?.sessionId),
  'actual Codex backend resumes the original native conversation', 30_000)

  // Another real owner reads the persisted replacement binding; it must not spawn again.
  const finalOwner = await scope.restartOwner()
  expect(finalOwner.processId).not.toBe(nextOwner.processId)
  await until(() => client.runtimeOwnerIdentity(), value => value?.ownerInstanceId === finalOwner.ownerInstanceId && value.availability === 'connected',
    'reopened binding survives another semantic owner process', 30_000)
  const restored = await client.statusAgent(original.agentSessionId)
  expect(restored.session).toMatchObject({ agentSessionId: original.agentSessionId, run: reopened.run,
    workspacePath: scope.root, nativeHandle: saved.nativeHandle, retiredRuns: [original.run], reopenedFrom: reopened.reopenedFrom })
  expect(restored.run).toMatchObject({ runId: reopened.run.runId, pid: running.run.pid, state: 'running' })
  const historyAfter = await client.sessionHistoryPage(original.agentSessionId, historyOptions)
  expect(historyAfter.source).toEqual(historyBefore.source)
  expect(historyAfter.items).toEqual(historyBefore.items)
  expect(await readFile(saved.nativeHandle.transcriptPath)).toEqual(transcriptBefore)
  const received = await records(witness)
  expect(received.filter(value => value.kind === 'backend').map(value => value.resumed)).toEqual([false, true])
  expect(received.filter(value => value.kind === 'frontend')).toHaveLength(2)
  expect(received.filter(value => value.kind === 'input')).toEqual([])
  expect(received.map(value => value.agentSessionId)).toEqual(received.map(() => original.agentSessionId))
  // The fixture receives real PTY bytes. Only terminal capability replies are permitted;
  // retained native history, old prompts and recovery markers must never enter stdin.
  const stdin = received.filter(value => value.kind === 'stdin').map(value => Buffer.from(value.base64!, 'base64').toString('utf8')).join('')
  expect(stdin.replaceAll('\x1b[?0u', '')).toBe('')
  console.log(JSON.stringify({ schema: 'agentmux.closed-codex-reopen-runtime-proof.v1', agentSessionId: original.agentSessionId,
    oldRun: original.run, newRun: reopened.run, nativeSessionId: saved.nativeHandle.sessionId, retiredAt: retired.retiredAt,
    semanticOwnerPids: [firstOwner.processId, nextOwner.processId, finalOwner.processId],
    originalRuntimeRunRetained: true, historyItems: historyAfter.items.length, nativeInputs: 0, priorInputReplayed: false }))
}, 120_000)
