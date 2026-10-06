import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { fixturePath } from './helpers/fixture-values.js'
import { BUILT_IN_AGENT_PROVIDERS } from '../src/agent-provider.js'
import { normalizeNativeHook, type AgentNativeHookSpecification } from '../src/hook-normalizer.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, loadAgentSessions, normalizeStoredAgentSession, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentMuxAcpBridge } from '../src/acp-adapter.js'
import type { CtxmuxAdapterEvent, CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import type { AgentMuxAcpEvent, AgentMuxClientEvent, AgentMuxRunInputData, AgentMuxStoredAgentSession, AgentStatus, NativeHookEnvelope } from '../src/types.js'

const clients: AgentMuxClient[] = []
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.splice(0).map((client) => client.dispose()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})

function session(status?: AgentStatus): AgentMuxStoredAgentSession {
  return {
    kind: 'agent', agentSessionId: 'entry-agent', providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: fixturePath("repo"), run: { runId: 'entry-run' }, retiredRuns: [],
    hookBindingId: 'entry-binding', hookToken: 'entry-token',
    createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: Math.max(1, status?.observedAt ?? 0), ...(status ? { semanticStatus: status } : {})
  }
}

function done(stateEnteredAt?: number): AgentStatus {
  return { state: 'done', source: 'native-hook', observedAt: reshapeFixtureEpoch(0, 0, 100),
    ...(stateEnteredAt === undefined ? {} : { stateEnteredAt }), detail: 'Stop' }
}

type Input = { operationId: string; expectedByte: number; data: AgentMuxRunInputData }
type Ack = { run: CtxmuxAdapterRun; appliedByteRange: { startByte: number; endByte: number } }
type Internals = {
  connected: boolean
  registry: AgentMuxAgentSessionRegistry
  kernel: {
    isConnected(): boolean
    identity(): { daemonInstanceId: string }
    status(runId: string): Promise<CtxmuxAdapterRun>
    input(runId: string, input: Input): Promise<Ack>
  }
  agentInputCursors: Map<string, number>
  acp: AgentMuxAcpBridge
  screenEvidence: AgentScreenEvidenceStore
  acceptHookEvent(envelope: NativeHookEnvelope, signal: AbortSignal): Promise<void>
  acceptKernelEvent(event: CtxmuxAdapterEvent): void
}

async function harness(initial = session(), store: AgentMuxAgentSessionStore = new AgentMuxMemoryAgentSessionStore(), seed = true) {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'amux-state-entry-'))
  directories.push(runtimeRoot)
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtimeRoot)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(runtimeRoot, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(runtimeRoot, 'messages.ndjson'))
  if (seed) await store.compareAndSwap(null, initial)
  // A state-entry fixture declares its own completed/start protocol. Codex Stop
  // is pre-veto; its real task_complete authority is tested separately.
  const hook: AgentNativeHookSpecification = { nativeHandle: { sessionIdKeys: ['session_id'] }, rules: [
    { events: ['Stop'], state: 'done', lifecycleEvent: 'turn-end' },
    { events: ['UserPromptSubmit'], state: 'working', lifecycleEvent: 'turn-start' },
    { events: ['PostToolUse'], state: 'working', lifecycleEvent: 'tool-use-end' }
  ] }
  const client = new AgentMuxClient({ store, providers: BUILT_IN_AGENT_PROVIDERS.map(provider => {
    if (provider.id !== 'codex') return provider
    const { observeSessionStatus: _nativeObserver, ...contribution } = provider
    return { ...contribution,
    hook, normalizeHook: (envelope, context) => normalizeNativeHook(hook, envelope, context),
    planInteractionResponse: () => ({ data: '1' }),
    // The fake Runtime PID has no OS record. This unit seam supplies the Provider's
    // exact discovery witness; session-status-authority separately exercises real OS discovery.
    discoverNativeSession: async () => ({ handle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'native-entry' }, assertCurrent: async () => {} })
  } }) })
  clients.push(client)
  const inner = client as unknown as Internals
  await inner.registry.load('local')
  inner.connected = true
  let cursor = 0
  const writes: Array<{ runId: string; operationId: string; expectedByte: number; data: AgentMuxRunInputData }> = []
  const accepted = new Map<string, Ack>()
  let beforeAck: (() => Promise<void>) | undefined
  const run = (): CtxmuxAdapterRun => ({
    nativeService: null,
    runId: 'entry-run', lifecycleOperationId: null, program: 'codex', args: [], workspacePath: fixturePath("repo"),
    pid: 123, state: { type: 'running' }, cols: 80, rows: 24,
    latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursor
  })
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'entry-daemon' })
  inner.kernel.status = async () => run()
  inner.kernel.input = async (runId, input) => {
    const prior = accepted.get(input.operationId)
    if (prior) return prior
    writes.push({ runId, ...input })
    cursor = input.expectedByte + (typeof input.data === 'string' ? Buffer.byteLength(input.data) : input.data.byteLength)
    const receipt = { run: run(), appliedByteRange: { startByte: input.expectedByte, endByte: cursor } }
    accepted.set(input.operationId, receipt)
    await beforeAck?.()
    return receipt
  }
  vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(0)
  const events: AgentMuxClientEvent[] = []
  client.onEvent((event) => { events.push(event) })
  const feed = async (eventName: string, receiptId = `receipt-${events.length}`) => inner.acceptHookEvent({
    receiptId, agentSessionId: 'entry-agent', runId: 'entry-run', providerId: 'codex',
    eventName, payload: { hook_event_name: eventName, session_id: 'native-entry' }
  }, AbortSignal.timeout(5_000))
  const stored = async () => (await loadAgentSessions(store))[0]!
  return { client, inner, store, writes, events, feed, stored,
    beforeAck: (callback?: () => Promise<void>) => { beforeAck = callback },
    submit: (operationId: string) => client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession('entry-agent')), agentSessionId: 'entry-agent', operationId, prompt: 'hello' })
  }
}

it('public Hook state keeps its first entry time across repeated native receipts and metadata reads', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(reshapeFixtureEpoch(0, 0, 1_000))
  const h = await harness()
  await h.feed('Stop', 'stop-one')
  expect(h.client.agentSession('entry-agent').semanticStatus).toMatchObject({
    state: 'done', source: 'native-hook', observedAt: reshapeFixtureEpoch(0, 0, 1_000), stateEnteredAt: reshapeFixtureEpoch(0, 0, 1_000)
  })
  clock.mockReturnValue(reshapeFixtureEpoch(0, 0, 2_000))
  await h.feed('Stop', 'stop-two')
  expect((await h.client.statusAgent('entry-agent')).session.semanticStatus).toMatchObject({
    state: 'done', observedAt: reshapeFixtureEpoch(0, 0, 2_000), stateEnteredAt: reshapeFixtureEpoch(0, 0, 1_000)
  })
  h.inner.acceptKernelEvent({ type: 'data', runId: 'entry-run', startByte: 0, endByte: 3, dataBytes: Buffer.from('out'), data: 'out' })
  await expect(h.client.sessionHistoryPage('entry-agent', { limit: 10 }))
    .rejects.toThrow('The configured native read helper could not start.')
  expect((await h.stored()).semanticStatus?.stateEnteredAt).toBe(reshapeFixtureEpoch(0, 0, 1_000))
  expect(h.events.filter((event) => event.type === 'terminal-output').map((event) => event.data)).toEqual(['out'])
  expect(h.writes).toEqual([])
})

it('same-state native receipts never backfill a missing entry time in an old record', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(reshapeFixtureEpoch(0, 0, 2_000))
  const h = await harness(session(done()))
  await h.feed('Stop')
  expect(h.client.agentSession('entry-agent').semanticStatus).toEqual({
    state: 'done', source: 'native-hook', observedAt: reshapeFixtureEpoch(0, 0, 2_000), detail: 'Stop'
  })
  expect((await h.stored()).semanticStatus?.stateEnteredAt).toBeUndefined()
})

it('actual new semantic transitions establish distinct entry times through native Hook input', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(reshapeFixtureEpoch(0, 0, 2_000))
  const h = await harness(session(done(100)))
  await h.feed('UserPromptSubmit')
  expect(h.client.agentSession('entry-agent').semanticStatus).toMatchObject({ state: 'working', stateEnteredAt: reshapeFixtureEpoch(0, 0, 2_000) })
  clock.mockReturnValue(reshapeFixtureEpoch(0, 0, 3_000))
  await h.feed('Stop')
  expect((await h.stored()).semanticStatus).toMatchObject({ state: 'done', stateEnteredAt: reshapeFixtureEpoch(0, 0, 3_000) })
})

it('ACP binding events use the same semantic entry owner and preserve same-state unknown', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(reshapeFixtureEpoch(0, 0, 1_000))
  const h = await harness(session({ state: 'done', source: 'acp', observedAt: reshapeFixtureEpoch(0, 0, 100) }))
  let emit!: (event: AgentMuxAcpEvent) => void
  await h.inner.acp.bind('entry-agent', {
    adapterId: 'entry-adapter', sessionId: 'native-entry',
    onEvent: (listener) => { emit = listener; return () => {} },
    respondPermission: async () => {}, close: async () => {}
  })
  const feed = async (state: 'done' | 'working') => {
    emit({ type: 'status', state })
    const bound = (h.inner.acp as unknown as { bindings: Map<string, { eventTail: Promise<void> }> }).bindings.get('entry-agent')!
    await bound.eventTail
  }
  await feed('done')
  expect(h.client.agentSession('entry-agent').semanticStatus).toEqual({ state: 'done', source: 'acp', observedAt: reshapeFixtureEpoch(0, 0, 1_000) })
  clock.mockReturnValue(reshapeFixtureEpoch(0, 0, 2_000))
  await feed('working')
  clock.mockReturnValue(reshapeFixtureEpoch(0, 0, 3_000))
  await feed('working')
  expect((await h.stored()).semanticStatus).toEqual({ state: 'working', source: 'acp', observedAt: reshapeFixtureEpoch(0, 0, 3_000), stateEnteredAt: reshapeFixtureEpoch(0, 0, 2_000) })
  clock.mockReturnValue(reshapeFixtureEpoch(0, 0, 4_000))
  await feed('done')
  expect(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt).toBe(reshapeFixtureEpoch(0, 0, 4_000))
})

it('the file owner and a fresh public client preserve known and unknown entry facts', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(reshapeFixtureEpoch(0, 0, 2_000))
  const directory = await mkdtemp(join(tmpdir(), 'agent-state-entry-'))
  directories.push(directory)
  const path = join(directory, 'sessions.json')
  const first = await harness(session(done(100)), new AgentMuxFileAgentSessionStore(path))
  await first.feed('Stop')
  const second = await harness(session(), new AgentMuxFileAgentSessionStore(path), false)
  expect(second.client.agentSessions().map((entry) => entry.semanticStatus?.stateEnteredAt)).toEqual([reshapeFixtureEpoch(0, 0, 100)])
  await second.client.writeAgent({ agentSessionId: 'entry-agent', expectedRun: second.client.agentSession('entry-agent').run, data: '\u001b[0n', source: 'user' })
  const third = await harness(session(), new AgentMuxFileAgentSessionStore(path), false)
  expect(third.client.agentSession('entry-agent').semanticStatus).toEqual({
    state: 'done', source: 'native-hook', observedAt: reshapeFixtureEpoch(0, 0, 2_000), detail: 'Stop', stateEnteredAt: reshapeFixtureEpoch(0, 0, 100)
  })
  expect(second.writes.map((input) => input.data)).toEqual(['\u001b[0n'])
})

it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '100'])('rejects invalid persisted entry time %s without inventing one', (value) => {
  expect(() => normalizeStoredAgentSession({ ...session(done()), semanticStatus: { ...done(), stateEnteredAt: value } }))
    .toThrow('semanticStatus.stateEnteredAt is invalid')
})

it('first typed claim invalidates idle evidence before payload and retry does not consume a later done epoch', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(reshapeFixtureEpoch(0, 0, 1_000))
  const h = await harness(session(done(100)))
  const entryTimesAtInput: Array<number | undefined> = []
  h.beforeAck(async () => { entryTimesAtInput.push(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt) })
  await h.submit('first-execution')
  expect(entryTimesAtInput).toEqual([undefined, undefined])
  expect(h.writes.map((input) => input.data)).toEqual(['hello', '\r'])
  expect((await h.stored()).promptCompletionAdmission).toMatchObject({ submissionId: 'first-execution', completionId: JSON.stringify(['entry-run', 100]) })
  clock.mockReturnValue(reshapeFixtureEpoch(0, 0, 2_000))
  await h.feed('UserPromptSubmit')
  clock.mockReturnValue(reshapeFixtureEpoch(0, 0, 3_000))
  await h.feed('Stop')
  await h.submit('first-execution')
  expect(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt).toBe(reshapeFixtureEpoch(0, 0, 3_000))
  expect(h.writes.map((input) => input.data)).toEqual(['hello', '\r'])
})

it('a failed typed input leaves unknown idle evidence without claiming working or acceptance', async () => {
  const h = await harness(session(done(100)))
  h.inner.kernel.input = async () => { throw new Error('input unavailable') }
  await expect(h.submit('failed-execution')).rejects.toThrow('input unavailable')
  expect(h.client.agentSession('entry-agent').semanticStatus).toEqual({ ...done(), idleEvidenceConsumed: true, currentActivityRevision: 1 })
  expect((await h.stored()).promptCompletionAdmission?.submissionId).toBe('failed-execution')
  expect(h.writes).toEqual([])
})

it.each([
  ['draft editing', 'next'],
  ['return key', '\r'],
  ['SGR wheel reports', '\u001b[<64;20;10M\u001b[<65;20;10M'],
  ['legacy wheel report', Uint8Array.from([27, 91, 77, 96, 52, 42])],
  ['arrow navigation', '\u001b[A'],
  ['terminal response bytes', '\u001b[0n']
] as const)('raw %s preserves idle evidence and the acknowledged input cursor', async (_description, data) => {
  const h = await harness(session(done(100)))
  const save = vi.spyOn(h.store, 'compareAndSwap')
  const metadataSave = vi.spyOn(h.store, 'compareAndSwapMetadata')
  await h.client.writeAgent({ agentSessionId: 'entry-agent', expectedRun: h.client.agentSession('entry-agent').run, data: '', source: 'user' })
  await h.client.writeAgent({ agentSessionId: 'entry-agent', expectedRun: h.client.agentSession('entry-agent').run, data: new Uint8Array(), source: 'user' })
  expect(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt).toBe(reshapeFixtureEpoch(0, 0, 100))
  expect(save).not.toHaveBeenCalled()
  expect(metadataSave).not.toHaveBeenCalled()
  expect(h.writes).toEqual([])
  const ack = await h.client.writeAgent({ agentSessionId: 'entry-agent', expectedRun: h.client.agentSession('entry-agent').run, data, source: 'user' })
  expect(h.client.agentSession('entry-agent').semanticStatus).toEqual(done(100))
  expect(save).not.toHaveBeenCalled()
  expect(metadataSave).not.toHaveBeenCalled()
  expect(h.writes.map((input) => input.data)).toEqual([data])
  const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
  expect(ack.appliedByteRange).toEqual({ startByte: 0, endByte: bytes })
  expect(h.inner.agentInputCursors.get('entry-agent')).toBe(bytes)
})

it('a failed raw input does not consume durable idle evidence', async () => {
  const h = await harness(session(done(100)))
  h.inner.kernel.input = async () => { throw new Error('input unavailable') }
  await expect(h.client.writeAgent({ agentSessionId: 'entry-agent', expectedRun: h.client.agentSession('entry-agent').run, data: 'x', source: 'user' })).rejects.toThrow('input unavailable')
  expect((await h.stored()).semanticStatus?.stateEnteredAt).toBe(reshapeFixtureEpoch(0, 0, 100))
})

it('a newer done epoch arriving before raw ACK is not erased by the old input', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(reshapeFixtureEpoch(0, 0, 2_000))
  const h = await harness(session(done(100)))
  h.beforeAck(async () => {
    await h.feed('UserPromptSubmit')
    clock.mockReturnValue(reshapeFixtureEpoch(0, 0, 3_000))
    await h.feed('Stop')
  })
  await h.client.writeAgent({ agentSessionId: 'entry-agent', expectedRun: h.client.agentSession('entry-agent').run, data: 'x', source: 'user' })
  expect(h.client.agentSession('entry-agent').semanticStatus).toMatchObject({ state: 'done', stateEnteredAt: reshapeFixtureEpoch(0, 0, 3_000) })
  expect((await h.stored()).semanticStatus?.stateEnteredAt).toBe(reshapeFixtureEpoch(0, 0, 3_000))
  expect(h.writes.map((input) => input.data)).toEqual(['x'])
})

it('an exact Run change before raw ACK cannot consume another Runs idle epoch', async () => {
  const h = await harness(session(done(100)))
  h.beforeAck(async () => {
    const current = h.inner.registry.get('entry-agent')
    await h.inner.registry.put({ ...current, run: { runId: 'replacement-run' }, retiredRuns: [{ runId: 'entry-run' }], semanticStatus: done(100) }, current.run)
  })
  await expect(h.client.writeAgent({ agentSessionId: 'entry-agent', expectedRun: h.client.agentSession('entry-agent').run, data: 'x', source: 'user' })).resolves.toEqual({
    runId: 'entry-run', appliedByteRange: { startByte: 0, endByte: 1 }, acceptedThroughByte: 1
  })
  expect(h.client.agentSession('entry-agent').run.runId).toBe('replacement-run')
  expect(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt).toBe(reshapeFixtureEpoch(0, 0, 100))
  expect(h.events.filter((event) => event.type === 'agent-error')).toEqual([])
})

it.each([100, 99])('a non-advancing clock %i keeps a new semantic epoch honestly unknown before raw ACK', async (now) => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const h = await harness(session(done(100)))
  h.beforeAck(async () => {
    await h.feed('UserPromptSubmit')
    await h.feed('Stop')
    expect(h.client.agentSession('entry-agent').semanticStatus).toMatchObject({ state: 'done' })
    expect(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt).toBeUndefined()
  })
  await h.client.writeAgent({ agentSessionId: 'entry-agent', expectedRun: h.client.agentSession('entry-agent').run, data: 'x', source: 'user' })
  expect((await h.stored()).semanticStatus).toMatchObject({ state: 'done' })
  expect((await h.stored()).semanticStatus?.stateEnteredAt).toBeUndefined()
  expect(h.writes.map((input) => input.data)).toEqual(['x'])
})

it('raw ACK requires no semantic Store write and preserves state when that Store is unavailable', async () => {
  const h = await harness(session(done(100)))
  const save = vi.spyOn(h.store, 'compareAndSwap').mockRejectedValue(new Error('private storage denied'))
  const metadataSave = vi.spyOn(h.store, 'compareAndSwapMetadata').mockRejectedValue(new Error('private metadata storage denied'))
  await expect(h.client.writeAgent({ agentSessionId: 'entry-agent', expectedRun: h.client.agentSession('entry-agent').run, data: 'x', source: 'user' })).resolves.toEqual({
    runId: 'entry-run', appliedByteRange: { startByte: 0, endByte: 1 }, acceptedThroughByte: 1
  })
  expect(h.inner.agentInputCursors.get('entry-agent')).toBe(1)
  expect(save).not.toHaveBeenCalled()
  expect(metadataSave).not.toHaveBeenCalled()
  expect(h.events.filter((event) => event.type === 'agent-error')).toEqual([])
  expect((await h.stored()).semanticStatus?.stateEnteredAt).toBe(reshapeFixtureEpoch(0, 0, 100))
  await h.client.writeAgent({ agentSessionId: 'entry-agent', expectedRun: h.client.agentSession('entry-agent').run, data: 'y', source: 'user' })
  expect(h.writes.map((input) => [input.expectedByte, input.data])).toEqual([[0, 'x'], [1, 'y']])
  expect((await h.stored()).semanticStatus?.stateEnteredAt).toBe(reshapeFixtureEpoch(0, 0, 100))
  expect(save).not.toHaveBeenCalled()
  expect(metadataSave).not.toHaveBeenCalled()
})

it('native interaction first claim invalidates idle but replay preserves the newly completed epoch', async () => {
  const h = await harness({
    ...session(done(100)), pendingInteraction: { request: {
      kind: 'permission', id: 'permission-one', nativeToolCallId: 'entry-tool-call', agentSessionId: 'entry-agent', title: 'Allow action?',
      options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow-once' }],
      evidence: { source: 'native-hook', observedAt: reshapeFixtureEpoch(0, 0, 100), run: { runId: 'entry-run' }, hookReceiptId: 'permission-one' }
    } }
  })
  // This state-entry test contributes an explicit synthetic Provider target.
  // Exact native target admission is independently covered by interaction-input-target.
  const provider = h.client.providers.get('codex')
  provider.prepareInteractionResponse = async (context, request, response) => ({
    plan: provider.planInteractionResponse(request, response),
    target: { agentSessionId: context.agentSessionId, run: context.run, requestId: request.id,
      nativeToolCallId: request.nativeToolCallId!, nativeSourceId: 'native-entry', inputByte: context.inputByte,
      frame: { run: context.run, outputThroughByte: 0, geometryRevision: 0, evidenceGeneration: 0 } },
    inspectCurrentTarget: () => true, verifyCurrentTarget: async () => true
  })
  h.inner.screenEvidence.currentCompleteFrame = () => ({
    snapshot: { cols: 80, rows: 24, cursor: { row: 0, column: 0 }, lines: [] },
    outputThroughByte: 0, geometryRevision: 0, evidenceGeneration: 0
  })
  h.beforeAck(async () => {
    expect(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt).toBeUndefined()
    // The fixture already accepted the original bytes; lose only their ACK.
    // Modern Stores may commit through their atomic updater rather than CAS.
    throw new Error('response input acknowledgement lost')
  })
  const respond = () => h.client.respondAgentInteraction({
    agentSessionId: 'entry-agent', expectedRun: { runId: 'entry-run' },
    response: { kind: 'permission', requestId: 'permission-one', decision: { outcome: 'selected', optionId: 'allow-once' } }
  })
  await expect(respond()).rejects.toThrow('response input acknowledgement lost')
  h.beforeAck()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(reshapeFixtureEpoch(0, 0, 2_000))
  await h.feed('UserPromptSubmit')
  clock.mockReturnValue(reshapeFixtureEpoch(0, 0, 3_000))
  await h.feed('Stop')
  await respond()
  expect(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt).toBe(reshapeFixtureEpoch(0, 0, 3_000))
  expect(h.client.agentSession('entry-agent').pendingInteraction).toMatchObject({
    request: { nativeToolCallId: 'entry-tool-call' }, response: { acknowledged: true }
  })
  expect(h.writes.map((input) => input.data)).toEqual(['1'])
})
