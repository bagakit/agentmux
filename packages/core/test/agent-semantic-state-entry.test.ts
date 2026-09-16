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
})

function session(status?: AgentStatus): AgentMuxStoredAgentSession {
  return {
    kind: 'agent', agentSessionId: 'entry-agent', providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: '/repo', run: { runId: 'entry-run' }, retiredRuns: [],
    hookBindingId: 'entry-binding', hookToken: 'entry-token',
    createdAt: 1, updatedAt: Math.max(1, status?.observedAt ?? 0), ...(status ? { semanticStatus: status } : {})
  }
}

function done(stateEnteredAt?: number): AgentStatus {
  return { state: 'done', source: 'native-hook', observedAt: 100,
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
  if (seed) await store.compareAndSwap(null, initial)
  const client = new AgentMuxClient({ store })
  clients.push(client)
  const inner = client as unknown as Internals
  await inner.registry.load('local')
  inner.connected = true
  let cursor = 0
  const writes: Array<{ runId: string; operationId: string; expectedByte: number; data: AgentMuxRunInputData }> = []
  const accepted = new Map<string, Ack>()
  let beforeAck: (() => Promise<void>) | undefined
  const run = (): CtxmuxAdapterRun => ({
    runId: 'entry-run', lifecycleOperationId: null, program: 'codex', args: [], workspacePath: '/repo',
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
    eventName, payload: { hook_event_name: eventName }
  }, AbortSignal.timeout(5_000))
  const stored = async () => (await loadAgentSessions(store))[0]!
  return { client, inner, store, writes, events, feed, stored,
    beforeAck: (callback?: () => Promise<void>) => { beforeAck = callback },
    submit: (operationId: string) => client.submitAgentPrompt({ agentSessionId: 'entry-agent', operationId, prompt: 'hello' })
  }
}

it('public Hook state keeps its first entry time across repeated native receipts and metadata reads', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const h = await harness()
  await h.feed('Stop', 'stop-one')
  expect(h.client.agentSession('entry-agent').semanticStatus).toMatchObject({
    state: 'done', source: 'native-hook', observedAt: 1_000, stateEnteredAt: 1_000
  })
  clock.mockReturnValue(2_000)
  await h.feed('Stop', 'stop-two')
  expect((await h.client.statusAgent('entry-agent')).session.semanticStatus).toMatchObject({
    state: 'done', observedAt: 2_000, stateEnteredAt: 1_000
  })
  h.inner.acceptKernelEvent({ type: 'data', runId: 'entry-run', startByte: 0, endByte: 3, dataBytes: Buffer.from('out'), data: 'out' })
  await expect(h.client.sessionHistoryPage('entry-agent', { limit: 10 }))
    .rejects.toThrow('The main native Session identity has not been established.')
  expect((await h.stored()).semanticStatus?.stateEnteredAt).toBe(1_000)
  expect(h.events.filter((event) => event.type === 'terminal-output').map((event) => event.data)).toEqual(['out'])
  expect(h.writes).toEqual([])
})

it('same-state native receipts never backfill a missing entry time in an old record', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(2_000)
  const h = await harness(session(done()))
  await h.feed('Stop')
  expect(h.client.agentSession('entry-agent').semanticStatus).toEqual({
    state: 'done', source: 'native-hook', observedAt: 2_000, detail: 'Stop'
  })
  expect((await h.stored()).semanticStatus?.stateEnteredAt).toBeUndefined()
})

it('actual new semantic transitions establish distinct entry times through native Hook input', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000)
  const h = await harness(session(done(100)))
  await h.feed('UserPromptSubmit')
  expect(h.client.agentSession('entry-agent').semanticStatus).toMatchObject({ state: 'working', stateEnteredAt: 2_000 })
  clock.mockReturnValue(3_000)
  await h.feed('Stop')
  expect((await h.stored()).semanticStatus).toMatchObject({ state: 'done', stateEnteredAt: 3_000 })
})

it('ACP binding events use the same semantic entry owner and preserve same-state unknown', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const h = await harness(session({ state: 'done', source: 'acp', observedAt: 100 }))
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
  expect(h.client.agentSession('entry-agent').semanticStatus).toEqual({ state: 'done', source: 'acp', observedAt: 1_000 })
  clock.mockReturnValue(2_000)
  await feed('working')
  clock.mockReturnValue(3_000)
  await feed('working')
  expect((await h.stored()).semanticStatus).toEqual({ state: 'working', source: 'acp', observedAt: 3_000, stateEnteredAt: 2_000 })
  clock.mockReturnValue(4_000)
  await feed('done')
  expect(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt).toBe(4_000)
})

it('the file owner and a fresh public client preserve known and unknown entry facts', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(2_000)
  const directory = await mkdtemp(join(tmpdir(), 'agent-state-entry-'))
  directories.push(directory)
  const path = join(directory, 'sessions.json')
  const first = await harness(session(done(100)), new AgentMuxFileAgentSessionStore(path))
  await first.feed('Stop')
  const second = await harness(session(), new AgentMuxFileAgentSessionStore(path), false)
  expect(second.client.agentSessions().map((entry) => entry.semanticStatus?.stateEnteredAt)).toEqual([100])
  await second.client.writeAgent('entry-agent', '\u001b[0n')
  const third = await harness(session(), new AgentMuxFileAgentSessionStore(path), false)
  expect(third.client.agentSession('entry-agent').semanticStatus).toEqual({
    state: 'done', source: 'native-hook', observedAt: 2_000, detail: 'Stop'
  })
  expect(second.writes.map((input) => input.data)).toEqual(['\u001b[0n'])
})

it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '100'])('rejects invalid persisted entry time %s without inventing one', (value) => {
  expect(() => normalizeStoredAgentSession({ ...session(done()), semanticStatus: { ...done(), stateEnteredAt: value } }))
    .toThrow('semanticStatus.stateEnteredAt is invalid')
})

it('first typed claim invalidates idle evidence before payload and retry does not consume a later done epoch', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const h = await harness(session(done(100)))
  const entryTimesAtInput: Array<number | undefined> = []
  h.beforeAck(async () => { entryTimesAtInput.push(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt) })
  await h.submit('first-execution')
  expect(entryTimesAtInput).toEqual([undefined, undefined])
  expect(h.writes.map((input) => input.data)).toEqual(['hello', '\r'])
  expect((await h.stored()).promptCompletionAdmission).toMatchObject({ submissionId: 'first-execution', completionId: JSON.stringify(['entry-run', 100]) })
  clock.mockReturnValue(2_000)
  await h.feed('UserPromptSubmit')
  clock.mockReturnValue(3_000)
  await h.feed('Stop')
  await h.submit('first-execution')
  expect(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt).toBe(3_000)
  expect(h.writes.map((input) => input.data)).toEqual(['hello', '\r'])
})

it('a failed typed input leaves unknown idle evidence without claiming working or acceptance', async () => {
  const h = await harness(session(done(100)))
  h.inner.kernel.input = async () => { throw new Error('input unavailable') }
  await expect(h.submit('failed-execution')).rejects.toThrow('input unavailable')
  expect(h.client.agentSession('entry-agent').semanticStatus).toEqual(done())
  expect((await h.stored()).promptCompletionAdmission?.submissionId).toBe('failed-execution')
  expect(h.writes).toEqual([])
})

it('empty raw input preserves idle evidence while acknowledged protocol bytes invalidate it only once', async () => {
  const h = await harness(session(done(100)))
  const save = vi.spyOn(h.store, 'compareAndSwap')
  await h.client.writeAgent('entry-agent', '')
  await h.client.writeAgent('entry-agent', new Uint8Array())
  expect(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt).toBe(100)
  expect(save).not.toHaveBeenCalled()
  expect(h.writes).toEqual([])
  await h.client.writeAgent('entry-agent', '\u001b[0n')
  expect(h.client.agentSession('entry-agent').semanticStatus).toEqual(done())
  expect(save).toHaveBeenCalledTimes(1)
  await h.client.writeAgent('entry-agent', 'next')
  expect(save).toHaveBeenCalledTimes(1)
  expect(h.writes.map((input) => input.data)).toEqual(['\u001b[0n', 'next'])
  expect(h.inner.agentInputCursors.get('entry-agent')).toBe(8)
})

it('a failed raw input does not consume durable idle evidence', async () => {
  const h = await harness(session(done(100)))
  h.inner.kernel.input = async () => { throw new Error('input unavailable') }
  await expect(h.client.writeAgent('entry-agent', 'x')).rejects.toThrow('input unavailable')
  expect((await h.stored()).semanticStatus?.stateEnteredAt).toBe(100)
})

it('a newer done epoch arriving before raw ACK is not erased by the old input', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000)
  const h = await harness(session(done(100)))
  h.beforeAck(async () => {
    await h.feed('UserPromptSubmit')
    clock.mockReturnValue(3_000)
    await h.feed('Stop')
  })
  await h.client.writeAgent('entry-agent', 'x')
  expect(h.client.agentSession('entry-agent').semanticStatus).toMatchObject({ state: 'done', stateEnteredAt: 3_000 })
  expect((await h.stored()).semanticStatus?.stateEnteredAt).toBe(3_000)
  expect(h.writes.map((input) => input.data)).toEqual(['x'])
})

it('an exact Run change before raw ACK cannot consume another Runs idle epoch', async () => {
  const h = await harness(session(done(100)))
  h.beforeAck(async () => {
    const current = h.inner.registry.get('entry-agent')
    await h.inner.registry.put({ ...current, run: { runId: 'replacement-run' }, retiredRuns: [{ runId: 'entry-run' }], semanticStatus: done(100) }, current.run)
  })
  await expect(h.client.writeAgent('entry-agent', 'x')).resolves.toEqual({
    runId: 'entry-run', appliedByteRange: { startByte: 0, endByte: 1 }, acceptedThroughByte: 1
  })
  expect(h.client.agentSession('entry-agent').run.runId).toBe('replacement-run')
  expect(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt).toBe(100)
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
  await h.client.writeAgent('entry-agent', 'x')
  expect((await h.stored()).semanticStatus).toMatchObject({ state: 'done' })
  expect((await h.stored()).semanticStatus?.stateEnteredAt).toBeUndefined()
  expect(h.writes.map((input) => input.data)).toEqual(['x'])
})

it('failed idle persistence after accepted input preserves ACK and cursor with an honest non-Agent-failure advisory', async () => {
  const h = await harness(session(done(100)))
  vi.spyOn(h.store, 'compareAndSwap').mockRejectedValueOnce(new Error('private storage denied'))
  await expect(h.client.writeAgent('entry-agent', 'x')).resolves.toEqual({
    runId: 'entry-run', appliedByteRange: { startByte: 0, endByte: 1 }, acceptedThroughByte: 1
  })
  expect(h.inner.agentInputCursors.get('entry-agent')).toBe(1)
  expect(h.events.filter((event) => event.type === 'agent-error')).toEqual([{
    type: 'agent-error', code: 'AGENT_STATE_ENTRY_PERSIST_FAILED',
    message: expect.stringContaining('Input was accepted for Agent entry-agent (Run entry-run), but its idle evidence could not be invalidated durably.'),
    evidence: { source: 'user', observedAt: expect.any(Number), run: { runId: 'entry-run' } }
  }])
  expect((await h.stored()).semanticStatus?.stateEnteredAt).toBe(100)
  await h.client.writeAgent('entry-agent', 'y')
  expect(h.writes.map((input) => [input.expectedByte, input.data])).toEqual([[0, 'x'], [1, 'y']])
  expect((await h.stored()).semanticStatus?.stateEnteredAt).toBeUndefined()
})

it('native interaction first claim invalidates idle but replay preserves the newly completed epoch', async () => {
  const h = await harness({
    ...session(done(100)), pendingInteraction: { request: {
      kind: 'permission', id: 'permission-one', agentSessionId: 'entry-agent', title: 'Allow action?',
      options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow-once' }],
      evidence: { source: 'native-hook', observedAt: 100, run: { runId: 'entry-run' }, hookReceiptId: 'permission-one' }
    } }
  })
  const failAckSave = vi.spyOn(h.store, 'compareAndSwap')
  h.beforeAck(async () => {
    expect(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt).toBeUndefined()
    failAckSave.mockRejectedValueOnce(new Error('response ack save interrupted'))
  })
  const respond = () => h.client.respondAgentInteraction({
    agentSessionId: 'entry-agent', expectedRun: { runId: 'entry-run' },
    response: { kind: 'permission', requestId: 'permission-one', decision: { outcome: 'selected', optionId: 'allow-once' } }
  })
  await expect(respond()).rejects.toThrow('response ack save interrupted')
  h.beforeAck()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000)
  await h.feed('UserPromptSubmit')
  clock.mockReturnValue(3_000)
  await h.feed('Stop')
  await respond()
  expect(h.client.agentSession('entry-agent').semanticStatus?.stateEnteredAt).toBe(3_000)
  expect(h.client.agentSession('entry-agent').pendingInteraction).toBeUndefined()
  expect(h.writes.map((input) => input.data)).toEqual(['1'])
})
