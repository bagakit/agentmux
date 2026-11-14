import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentPromptSubmissionRecord, NativeHookEnvelope } from '../src/types.js'
import type { AgentPromptInputKey } from '../src/agent-prompt-condition.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { claudeNativeActivitySource } from '../src/providers/claude-plugin.js'
import { activityCertaintyClient } from './fixtures/activity-certainty-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

type ModHandler = (api: unknown, event: Record<string, unknown>, next: (event: Record<string, unknown>) => unknown) => unknown
const shellAndMonitor = [
  { id: 'shell-original', type: 'shell', status: 'running', description: 'Original shell', command: 'private fixture' },
  { id: 'monitor-original', type: 'monitor', status: 'pending', description: 'Original monitor', server: 'private', tool: 'watch' }
]
const subagentAndWorkflow = [
  { id: 'child-original', type: 'subagent', status: 'running', description: 'Original child', agent_type: 'general-purpose' },
  { id: 'workflow-original', type: 'workflow', status: 'pending', description: 'Original workflow', name: 'private workflow' }
]

/** Run the generated module; only process transport is replaced by the actual Core ingress. */
async function harness(id: string) {
  const h = await activityCertaintyClient(id, 'claude')
  closes.push(h.close)
  const path = join(h.directory, 'native-activity.mjs')
  await writeFile(path, claudeNativeActivitySource())
  const mod = await import(/* @vite-ignore */ pathToFileURL(path).href) as {
    register(on: (name: string, handler: ModHandler) => unknown): void
  }
  const handlers = new Map<string, ModHandler>()
  mod.register((name, handler) => { handlers.set(name, handler); return { catch() {} } })
  const delivered: Array<Record<string, unknown>> = [], failures: unknown[] = []
  let received = 0, settled = 0, accept = h.hook
  const api = {
    env: { get: async () => '1' }, session: { id: async () => 'native-main' },
    process: { run: async (_args: string[], input: { stdin: string }) => {
      const payload = JSON.parse(input.stdin) as Record<string, unknown>
      // No queued Inbox notice exists. An opportunity read neither sends nor accepts input.
      if (payload.hook_event_name === 'AgentMuxTurnEnd') return { exitCode: 0, stdout: '{}\n', stderr: '' }
      delivered.push(payload)
      try { await accept(String(payload.hook_event_name), `generated-${++received}`, payload) }
      catch (error) { failures.push(error); throw error }
      finally { settled++ }
      return { exitCode: 0, stdout: '{}\n', stderr: '' }
    } }, ui: { log: async () => {} }
  }
  const emit = async (name: string, event: Record<string, unknown>, sendsActivity = false) => {
    const before = settled, result = { nativeResult: event }, callback = handlers.get(name)
    expect(callback, `Generated module must register ${name}`).toBeTypeOf('function')
    expect(await callback!(api, event, original => { expect(original).toBe(event); return result })).toBe(result)
    if (sendsActivity) await vi.waitFor(() => {
      expect(failures).toEqual([]); expect(settled).toBe(before + 1)
    }, { timeout: 5_000 })
  }
  await emit('session.start', {})
  return { ...h, id, delivered,
    start: (turnId: string, extra: Record<string, unknown> = {}) => emit('turn.start', { turnId, text: 'Original native input', ...extra }, true),
    stop: (payload: Record<string, unknown>) => emit('classic.Stop', { session_id: 'native-main', ...payload }),
    end: (turnId: string, reason = 'answer', extra: Record<string, unknown> = {}) =>
      emit('turn.complete', { turnId, reason, isAborted: reason === 'aborted', ...extra }, true),
    useIngress: (hook: typeof h.hook) => { accept = hook }
  }
}

/** Seed the original admission; its idle is produced and read by the actual FileStore owner. */
async function originalInput(h: Awaited<ReturnType<typeof harness>>, submissionId = 'original-human-query'): Promise<Extract<AgentPromptInputKey, { kind: 'prompt' }>> {
  const key: Extract<AgentPromptInputKey, { kind: 'prompt' }> = { kind: 'prompt', agentSessionId: h.id, expectedRun: { runId: h.run.runId }, submissionId }
  const data = 'Original human Query\r', startByte = h.run.acceptedInputBytes
  h.run.acceptedInputBytes = startByte + Buffer.byteLength(data)
  const registry = (h.client as unknown as { registry: AgentMuxAgentSessionRegistry }).registry
  await registry.update(h.id, key.expectedRun, current => ({ ...current, promptCompletionAdmission: {
    operationId: submissionId, submissionId, inputKey: key, startByte, endByte: h.run.acceptedInputBytes, outputCursorBytes: 17, acknowledged: true,
    inputDispatch: { ref: { key, waitGeneration: 1 }, gateId: `${submissionId}-admission` },
    intent: { run: key.expectedRun, ownerInstanceId: 'private-runtime', prompt: 'Original human Query',
      plan: { kind: 'single-phase', data }, execution: 'immediate',
      message: { userContent: 'Original human Query', authorHuman: true } }
  } }))
  return key
}

function expectOriginalWithoutIdle(record: AgentPromptSubmissionRecord | null | undefined, key: AgentPromptInputKey) {
  expect(record).toMatchObject({ agentSessionId: key.agentSessionId, run: key.expectedRun, admission: { inputKey: key } })
  expect(record).not.toHaveProperty('semanticIdle')
}

it.each([
  ['shell-monitor', shellAndMonitor], ['subagent-workflow', subagentAndWorkflow]
] as const)('generated %s snapshot withholds idle until a later matching empty native end', async (name, tasks) => {
  const h = await harness(`background-${name}`), key = await originalInput(h)
  await h.start('original-native-turn'); await h.stop({ background_tasks: tasks }); await h.end('original-native-turn')
  expect(h.delivered.at(-1)).toMatchObject({ hook_event_name: 'turn.complete', backgroundWork: 'pending', turnId: 'original-native-turn' })
  const status = await h.client.statusAgent(h.id), saved = (await h.sessions())[0]!
  expect(status.observation).toMatchObject({ process: 'running', semantic: 'unknown', readiness: 'ready' })
  expect(status.session.currentActivity).toMatchObject({ state: 'unknown', nativeTurnId: 'original-native-turn' })
  expect(status.session.hookIngressObservation?.message).toContain('ambient')
  expect(saved.recoveryActivity).toMatchObject({ state: 'unknown', promptSubmissionId: key.submissionId, nativeTurnId: 'original-native-turn' })
  expect(saved.recoveryActivity).not.toHaveProperty('interruption')
  expect((await h.client.readAgentInputActivity(key)).state).toBe('unconfirmed')
  expectOriginalWithoutIdle(await h.client.inspectAgentPromptSubmission(key), key)

  // Notifications can be disabled: only another observed main turn with an empty snapshot qualifies.
  await h.start('later-native-turn'); await h.stop({ background_tasks: [] }); await h.end('later-native-turn')
  const after = await h.client.statusAgent(h.id), idle = await h.client.inspectAgentPromptSubmission(key)
  expect(h.delivered.at(-1)).toMatchObject({ backgroundWork: 'none', turnId: 'later-native-turn' })
  expect(after.observation).toMatchObject({ semantic: 'idle', readiness: 'ready' })
  expect(after.session.hookIngressObservation).toBeUndefined()
  expect((await h.client.readAgentInputActivity(key)).state).toBe('idle')
  expect(idle?.semanticIdle).toMatchObject({ nativeTurnId: 'later-native-turn', promptSubmissionId: key.submissionId,
    observedAt: after.session.currentActivity!.observedAt })
  expect(idle!.semanticIdle!.observedAt).toBeGreaterThan(saved.recoveryActivity!.observedAt)
})

it.each([
  ['missing Stop', null], ['missing field', {}], ['non-array', { background_tasks: {} }],
  ['malformed task', { background_tasks: [{ id: 4, type: 'shell', status: 'running' }] }],
  ['impossible wire status', { background_tasks: [{ id: 'ended', type: 'shell', status: 'completed' }] }]
] as const)('%s cannot borrow an earlier empty snapshot or manufacture original-input idle', async (name, snapshot) => {
  const h = await harness(`background-unconfirmed-${name.replaceAll(' ', '-')}`)
  await originalInput(h)
  await h.start('previous-turn'); await h.stop({ background_tasks: [] }); await h.end('previous-turn')
  const key = await originalInput(h, 'later-human-query')
  await h.start('current-turn')
  if (snapshot !== null) await h.stop(snapshot)
  await h.end('current-turn')
  expect(h.delivered.at(-1)).toMatchObject({ backgroundWork: 'unknown', turnId: 'current-turn' })
  expect((await h.client.statusAgent(h.id)).observation).toMatchObject({ semantic: 'unknown', readiness: 'ready' })
  expect((await h.client.readAgentInputActivity(key)).state).toBe('unconfirmed')
  expectOriginalWithoutIdle(await h.client.inspectAgentPromptSubmission(key), key)
})

it('child callbacks cannot clear the main snapshot, and foreign Stop cannot replace an empty main snapshot', async () => {
  const h = await harness('background-subjects')
  await originalInput(h)
  await h.start('main-pending'); await h.stop({ background_tasks: shellAndMonitor })
  await h.start('child-turn', { agentId: 'native-child' })
  await h.stop({ agent_id: 'native-child', background_tasks: [] })
  await h.end('child-turn', 'answer', { agentId: 'native-child' }); await h.end('main-pending')
  expect(h.delivered.at(-1)).toMatchObject({ backgroundWork: 'pending', turnId: 'main-pending' })
  expect((await h.client.statusAgent(h.id)).observation.semantic).toBe('unknown')
  await h.start('main-empty'); await h.stop({ background_tasks: [] })
  await h.stop({ session_id: 'foreign-main', background_tasks: shellAndMonitor }); await h.end('main-empty')
  expect(h.delivered.at(-1)).toMatchObject({ backgroundWork: 'none', turnId: 'main-empty' })
  expect((await h.client.statusAgent(h.id)).observation.semantic).toBe('idle')
})

it('a Stop without matching main start cannot establish idle; old Run/native ends cannot cover new work', async () => {
  const h = await harness('background-exact-turn')
  await h.stop({ background_tasks: [] }); await h.end('unstarted-turn')
  expect(h.delivered.at(-1)).toMatchObject({ backgroundWork: 'unknown', turnId: 'unstarted-turn' })
  expect((await h.client.statusAgent(h.id)).observation.semantic).not.toBe('idle')
  await h.start('current-main')
  const active = h.client.agentSession(h.id).currentActivity!, source = h.delivered.at(-1)!
  const end = { session_id: 'native-main', sourceId: source.sourceId, sequence: Number(source.sequence) + 1,
    turnId: 'old-main', reason: 'answer', isAborted: false, backgroundWork: 'none' }
  await h.hook('turn.complete', 'late-old-turn', end)
  await h.hook('turn.complete', 'foreign-native-end', { ...end, turnId: 'current-main', session_id: 'foreign-main' })
  await h.hook('turn.complete', 'old-run-end', { ...end, turnId: 'current-main' }, 'retired-run')
  expect(h.client.agentSession(h.id).currentActivity).toEqual(active)
  expect((await h.client.statusAgent(h.id)).observation.semantic).toBe('active')
})

it.each(['error', 'aborted', 'refusal'])('a pre-veto empty Stop cannot establish idle for a later native %s end', async reason => {
  const h = await harness(`background-pre-veto-${reason}`), key = await originalInput(h)
  await h.start('non-answer-native-turn'); await h.stop({ background_tasks: [] }); await h.end('non-answer-native-turn', reason)
  expect(h.delivered.at(-1)).toMatchObject({ hook_event_name: 'turn.complete', backgroundWork: 'unknown', turnId: 'non-answer-native-turn' })
  const status = await h.client.statusAgent(h.id)
  expect(status.session.currentActivity?.state).toBe('unknown')
  expect((await h.client.readAgentInputActivity(key)).state).toBe('unconfirmed')
  expectOriginalWithoutIdle(await h.client.inspectAgentPromptSubmission(key), key)
  if (reason === 'error') {
    const outcomes = (await h.client.sessionTimeline(h.id)).items.flatMap(item => item.turnOutcome ? [item.turnOutcome] : [])
    expect(outcomes).toContainEqual(expect.objectContaining({ status: 'failed', failure: expect.objectContaining({ nativeTurnId: 'non-answer-native-turn' }) }))
  }
})

it('unknown background activity retains the native error result and healthy raw input', async () => {
  const h = await harness('background-native-error'), key = await originalInput(h)
  await h.start('failing-native-turn'); await h.end('failing-native-turn', 'error')
  const status = await h.client.statusAgent(h.id)
  expect(status.session.currentActivity?.state).toBe('unknown')
  expect(status.session.semanticStatus).toMatchObject({ state: 'error', failure: { nativeTurnId: 'failing-native-turn', code: 'AGENT_PROVIDER_ERROR' } })
  const outcomes = (await h.client.sessionTimeline(h.id)).items.flatMap(item => item.turnOutcome ? [item.turnOutcome] : [])
  expect(outcomes).toContainEqual(expect.objectContaining({ status: 'failed', failure: expect.objectContaining({ nativeTurnId: 'failing-native-turn' }) }))
  expectOriginalWithoutIdle(await h.client.inspectAgentPromptSubmission(key), key)
  const writes: string[] = [], kernel = (h.client as any).kernel
  kernel.identity = () => ({ daemonInstanceId: 'private-runtime' })
  kernel.input = async (_id: string, input: { expectedByte: number; data: string }) => {
    writes.push(input.data)
    h.run.acceptedInputBytes = input.expectedByte + Buffer.byteLength(input.data)
    return { run: h.run, appliedByteRange: { startByte: input.expectedByte, endByte: h.run.acceptedInputBytes } }
  }
  kernel.openInput = async (runId: string) => ({ run: h.run, waitWritable: async () => {},
    input: (data: string) => kernel.input(runId, { expectedByte: h.run.acceptedInputBytes, data }) })
  await h.client.writeAgent({ agentSessionId: h.id, expectedRun: key.expectedRun, data: 'retained native draft', source: 'user' })
  expect(writes).toEqual(['retained native draft'])
  expect(h.client.agentSession(h.id).currentActivity?.state).toBe('unknown')
  expect((await h.client.statusAgent(h.id)).observation.readiness).toBe('ready')
})

it('actual public service and compiled CLI retain the same unknown activity and original input', async () => {
  const h = await harness('background-public-input'), key = await originalInput(h)
  await h.start('public-native-turn'); await h.stop({ background_tasks: subagentAndWorkflow }); await h.end('public-native-turn')
  const server = new AgentMuxControlServer({ socketPath: join(h.directory, 'bg.sock'), coreClients: () => [{ hostId: 'local', client: h.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  closes.push(() => rpc.dispose())
  const target = { kind: 'agent-session' as const, agentSessionId: h.id }
  expect((await rpc.call('agent.inspect', { target })).status?.observation).toMatchObject({ semantic: 'unknown', readiness: 'ready' })
  const input = await rpc.call('agent.input.inspect', { key, activity: true })
  expect(input.activity?.state).toBe('unconfirmed'); expectOriginalWithoutIdle(input.record, key)
  const args = ['--endpoint', `unix:${server.path}`], env = objectCliEnvironment(h.directory)
  const inspect = await runCompiledObjectCli([...args, 'agent', 'inspect', '--session', h.id], env, '', 60_000)
  expect(inspect.code, inspect.stderr).toBe(0)
  const value = JSON.parse(inspect.stdout).result
  expect(value.status.observation).toMatchObject({ semantic: 'unknown', readiness: 'ready' })
  expect(value.status.session.currentActivity).toMatchObject({ nativeTurnId: 'public-native-turn', state: 'unknown', run: key.expectedRun })
  expect(parseRpcNativeResult('agent.inspect', value, { target })).toEqual(value)
  const original = await runCompiledObjectCli([...args, 'agent', 'input', 'inspect', '--input', '-'], env, JSON.stringify({ key, activity: true }), 60_000)
  expect(original.code, original.stderr).toBe(0)
  const originalValue = JSON.parse(original.stdout).result
  expect(originalValue.activity.state).toBe('unconfirmed'); expectOriginalWithoutIdle(originalValue.record, key)
  expect(parseRpcNativeResult('agent.input.inspect', originalValue, { key, activity: true })).toEqual(originalValue)
}, 90_000)

it('reopening the original FileStore retains unknown input activity and permits later same-Run native recovery', async () => {
  const h = await harness('background-cold-owner'), key = await originalInput(h)
  await h.start('before-owner-close'); await h.stop({ background_tasks: shellAndMonitor }); await h.end('before-owner-close')
  const before = (await h.sessions())[0]!
  await h.client.dispose()
  const store = new AgentMuxFileAgentSessionStore(h.store.path), client = new AgentMuxClient({ store })
  closes.push(() => client.dispose())
  const inner = client as unknown as { connected: boolean; registry: AgentMuxAgentSessionRegistry;
    kernel: { isConnected(): boolean; status(id: string): Promise<typeof h.run> };
    acceptHookEvent(event: NativeHookEnvelope, signal: AbortSignal): Promise<void> }
  await inner.registry.load('local'); inner.connected = true
  inner.kernel.isConnected = () => true; inner.kernel.status = async () => h.run
  const restored = (await loadAgentSessions(store))[0]!
  expect(restored).toMatchObject({ agentSessionId: h.id, run: key.expectedRun, nativeHandle: before.nativeHandle, recoveryActivity: before.recoveryActivity })
  expect(restored.recoveryActivity?.state).toBe('unknown')
  expect((await client.readAgentInputActivity(key)).state).toBe('unconfirmed')
  expectOriginalWithoutIdle(await client.inspectAgentPromptSubmission(key), key)
  expect((await client.statusAgent(h.id)).observation.semantic).not.toBe('idle')
  h.useIngress((eventName, receiptId, payload = {}, hookRunId = h.run.runId) => inner.acceptHookEvent({
    agentSessionId: h.id, providerId: 'claude', runId: hookRunId, eventName, receiptId,
    payload: { hook_event_name: eventName, ...payload }
  }, AbortSignal.timeout(5_000)))
  await h.start('after-owner-close'); await h.stop({ background_tasks: [] }); await h.end('after-owner-close')
  expect((await client.readAgentInputActivity(key)).state).toBe('idle')
  expect((await client.statusAgent(h.id)).session).toMatchObject({ agentSessionId: h.id, run: key.expectedRun, nativeHandle: before.nativeHandle })
  expect((await client.inspectAgentPromptSubmission(key))?.semanticIdle?.nativeTurnId).toBe('after-owner-close')
})
