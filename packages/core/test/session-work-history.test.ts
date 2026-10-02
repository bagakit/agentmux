import { fixturePath } from './helpers/fixture-values.js'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, loadAgentSessions, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import { advanceAgentActivityCommit, agentActivityTimelineItem } from '../src/agent-activity-state.js'
import { applyAgentTimelineMutation, normalizeAgentTimeline, projectAgentWorkHistory, MAX_AGENT_TIMELINE_STATUS_ITEMS } from '../src/session-timeline.js'
import type { AgentMuxAcpBridge } from '../src/acp-adapter.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { CtxmuxAdapterEvent } from '../src/ctxmux-run-adapter.js'
import type { AgentActivityObservation, AgentMuxAcpEvent, AgentMuxClientEvent, AgentMuxStoredAgentSession, AgentTimelineItem, NativeHookEnvelope } from '../src/types.js'

const roots: string[] = []
const clients: AgentMuxClient[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.splice(0).map(client => client.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const sid = 'work-history-agent'
function session(root = fixturePath("repo")): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: sid, providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: root, run: { runId: 'work-run' }, retiredRuns: [], hookBindingId: 'work-binding', hookToken: 'private-token', createdAt: 1, updatedAt: 1 }
}
type Internals = {
  registry: AgentMuxAgentSessionRegistry
  kernel: { status: (...args: unknown[]) => Promise<unknown>; disconnect(): void }
  acp: AgentMuxAcpBridge
  acceptHookEvent(envelope: NativeHookEnvelope, signal: AbortSignal): Promise<void>
  acceptKernelEvent(event: CtxmuxAdapterEvent): void
  persistActivityBoundary(session: AgentMuxStoredAgentSession, boundary: 'lost' | 'restored', at: number): Promise<void>
}
async function harness(store: AgentMuxAgentSessionStore = new AgentMuxMemoryAgentSessionStore()) {
  await store.compareAndSwap(null, session())
  const client = new AgentMuxClient({ store }); clients.push(client)
  const inner = client as unknown as Internals
  await inner.registry.load('local')
  inner.kernel.status = async () => ({ latestOutputBytes: 0 })
  const events: AgentMuxClientEvent[] = []
  client.onEvent(event => events.push(event))
  const hook = (eventName: string, receiptId: string) => inner.acceptHookEvent({ receiptId, agentSessionId: sid,
    providerId: 'codex', runId: 'work-run', eventName, payload: { hook_event_name: eventName } }, AbortSignal.timeout(5_000))
  return { store, client, inner, events, hook, current: () => inner.registry.get(sid),
    history: async () => (await client.sessionTimeline(sid)).items }
}
async function fileHarness() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-work-history-')); roots.push(root)
  const path = join(root, 'agent-sessions.json')
  const store = new AgentMuxFileAgentSessionStore(path)
  const h = await harness(store)
  const timelinePath = join(root, 'agent-timelines', `${createHash('sha256').update(sid).digest('base64url')}.jsonl`)
  return { ...h, root, path, timelinePath }
}
function observation(id: string, at: number, state: 'working' | 'waiting' | 'done', previous?: string, runId = 'work-run'): AgentTimelineItem {
  return agentActivityTimelineItem(sid, { id, source: 'acp', createdAt: at,
    activityState: { run: { runId }, state, stateEnteredAt: at, ...(previous ? { previousObservationId: previous } : {}) } })
}
async function retire(store: AgentMuxAgentSessionStore, value: AgentMuxStoredAgentSession) {
  const reservation = { kind: 'stop' as const, reservationId: 'history-stop', ownerId: 'history-owner', ownerPid: process.pid,
    agentSessionId: sid, expectedRun: value.run, operationId: 'history-stop', expiresAt: Date.now() + 60_000,
    stopOperation: { daemonInstance: 'isolated-unconnected', operationKey: 'history-stop', runId: value.run.runId } }
  await store.reserveLifecycle(reservation)
  await store.commitLifecycle(reservation, null)
}

it('accepted native Hook transitions retain two exact work rounds without per-tool history scans or byte writes', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
  const h = await harness()
  await h.hook('UserPromptSubmit', 'round-one')
  clock.mockReturnValue(200); await h.hook('Stop', 'done-one')
  const loads = vi.spyOn(h.store, 'loadTimeline')
  for (let i = 0; i < 40; i++) await h.hook('PreToolUse', `late-tool-${i}`)
  expect(loads).not.toHaveBeenCalled()
  clock.mockReturnValue(300); await h.hook('UserPromptSubmit', 'round-two')
  clock.mockReturnValue(350); await h.hook('UserPromptSubmit', 'same-working')
  h.inner.acceptKernelEvent({ type: 'data', runId: 'work-run', startByte: 0, endByte: 4, data: 'text', dataBytes: Buffer.from('text') })
  clock.mockReturnValue(400); await h.hook('Stop', 'done-two')
  const typed = (await h.history()).filter(item => item.activityState)
  expect(typed.map(item => [item.createdAt, 'state' in item.activityState! ? item.activityState.state : null])).toEqual([[100, 'working'], [200, 'done'], [300, 'working'], [400, 'done']])
  expect(projectAgentWorkHistory(typed).segments).toEqual([
    { run: { runId: 'work-run' }, startAt: 100, endAt: 200, end: 'state-change', startKnown: true },
    { run: { runId: 'work-run' }, startAt: 300, endAt: 400, end: 'state-change', startKnown: true }
  ])
})

it('actual ACP status accepts working/waiting/done independently of raw tool activity', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
  const h = await harness()
  let emit!: (event: AgentMuxAcpEvent) => void
  let closed = 0
  await h.inner.acp.bind(sid, { adapterId: 'history-adapter', sessionId: 'history-native',
    onEvent: listener => { emit = listener; return () => {} }, respondPermission: async () => {}, close: async () => { closed++ } })
  const feed = async (state: 'working' | 'waiting' | 'done') => {
    emit({ type: 'status', state })
    await (h.inner.acp as unknown as { bindings: Map<string, { eventTail: Promise<void> }> }).bindings.get(sid)!.eventTail
  }
  await feed('working'); clock.mockReturnValue(200); await feed('working')
  clock.mockReturnValue(300); await feed('waiting')
  clock.mockReturnValue(400); await feed('working')
  clock.mockReturnValue(500); await feed('done')
  expect(closed).toBe(0)
  expect(projectAgentWorkHistory(await h.history()).segments.map(s => [s.startAt, s.endAt])).toEqual([[100, 300], [400, 500]])
  expect(h.client.agentSession(sid)).not.toHaveProperty('activityCommit')
})

it('true FileStore I/O failure preserves the first accepted identity/time through done and an old native retry', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
  const h = await fileHarness()
  await mkdir(h.timelinePath, { recursive: true }) // real invalid-file I/O, not a mocked exception
  await h.hook('UserPromptSubmit', 'failed-working')
  const accepted = (await loadAgentSessions(h.store))[0]!.activityCommit!.latest
  expect(h.client.agentSession(sid).semanticStatus?.state).toBe('working')
  expect(h.events.some(e => e.type === 'agent-error' && e.code === 'AGENT_WORK_HISTORY_PERSIST_FAILED')).toBe(true)
  clock.mockReturnValue(200); await h.hook('Stop', 'accepted-done')
  expect(h.current().activityCommit?.pending).toEqual(accepted)
  expect(h.client.agentSession(sid).semanticStatus?.state).toBe('done')
  await rm(h.timelinePath, { recursive: true })
  clock.mockReturnValue(999); await h.hook('UserPromptSubmit', 'failed-working')
  expect(h.client.agentSession(sid).semanticStatus).toMatchObject({ state: 'done', observedAt: 200, stateEnteredAt: 200 })
  const typed = (await h.history()).filter(item => item.activityState)
  expect(typed.map(item => [item.id, item.createdAt])).toEqual([[accepted.id, 100], [h.current().activityCommit!.latest.id, 200]])
  expect(projectAgentWorkHistory(typed).segments[0]).toMatchObject({ startAt: 100, endAt: 200 })
  const before = await readFile(h.timelinePath, 'utf8')
  await h.hook('UserPromptSubmit', 'failed-working')
  expect(await readFile(h.timelinePath, 'utf8')).toBe(before)
})

it('already committed older native receipt cannot roll back latest done after its pending slot was cleared', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
  const h = await harness()
  await h.hook('UserPromptSubmit', 'old-working')
  clock.mockReturnValue(200); await h.hook('Stop', 'new-done')
  const before = await h.history()
  clock.mockReturnValue(900); await h.hook('UserPromptSubmit', 'old-working')
  expect(h.client.agentSession(sid).semanticStatus?.state).toBe('done')
  await h.hook('PreToolUse', 'still-late-tool')
  expect(h.client.agentSession(sid).semanticStatus?.state).toBe('done')
  expect((await h.history()).filter(item => item.activityState)).toEqual(before.filter(item => item.activityState))
})

it('committed old working replay under a now-unreadable Timeline preserves done and marks an explicit gap', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
  const h = await fileHarness()
  await h.hook('UserPromptSubmit', 'committed-working')
  clock.mockReturnValue(200); await h.hook('Stop', 'committed-done')
  const bytes = await readFile(h.timelinePath)
  await rm(h.timelinePath); await mkdir(h.timelinePath)
  clock.mockReturnValue(900); await h.hook('UserPromptSubmit', 'committed-working')
  expect(h.current().semanticStatus).toMatchObject({ state: 'done', observedAt: 200, stateEnteredAt: 200 })
  expect(h.current().activityCommit?.latest.activityState).toMatchObject({ boundary: 'history-gap' })
  await h.hook('UserPromptSubmit', 'committed-working')
  expect(h.current().semanticStatus?.state).toBe('done')
  await rm(h.timelinePath, { recursive: true }); await writeFile(h.timelinePath, bytes)
  await h.hook('UserPromptSubmit', 'committed-working')
  const history = await h.history()
  expect(history.filter(item => item.activityState && 'state' in item.activityState && item.activityState.state === 'working').map(item => item.createdAt)).toEqual([100])
  expect(projectAgentWorkHistory(history).coverage.gaps).toBe(true)
})

it('history I/O does not close an actual ACP binding or reject accepted done', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
  const h = await fileHarness(); await mkdir(h.timelinePath, { recursive: true })
  let emit!: (event: AgentMuxAcpEvent) => void
  let closed = 0
  await h.inner.acp.bind(sid, { adapterId: 'history-adapter', sessionId: 'history-native',
    onEvent: listener => { emit = listener; return () => {} }, respondPermission: async () => {}, close: async () => { closed++ } })
  for (const state of ['working', 'done'] as const) {
    emit({ type: 'status', state })
    await (h.inner.acp as unknown as { bindings: Map<string, { eventTail: Promise<void> }> }).bindings.get(sid)!.eventTail
    clock.mockReturnValue(200)
  }
  expect(closed).toBe(0)
  expect(h.current().semanticStatus?.state).toBe('done')
  expect(h.current().activityCommit?.pending?.createdAt).toBe(100)
})

it('status has an independent 200-entry budget under both tool and input floods, within the original JSONL', () => {
  expect(MAX_AGENT_TIMELINE_STATUS_ITEMS).toBe(200)
  let history = [observation('working', 100, 'working'), observation('done', 200, 'done', 'working')]
  for (let i = 0; i < 250; i++) for (const kind of ['user_message', 'tool_call'] as const) {
    const item: AgentTimelineItem = { id: `${kind}-${i}`, agentSessionId: sid, kind, status: 'complete', source: 'user', createdAt: 300, updatedAt: 300, title: kind }
    history = applyAgentTimelineMutation(history, { type: 'append', agentSessionId: sid, item })
  }
  expect(history.filter(item => item.activityState)).toHaveLength(2)
  expect(history.filter(item => item.kind === 'tool_call')).toHaveLength(200)
  expect(history.filter(item => item.kind === 'user_message')).toHaveLength(200)
  expect(normalizeAgentTimeline(sid, history)).toEqual(history)
  expect(projectAgentWorkHistory(history).segments[0]?.endAt).toBe(200)
  for (let i = 0; i < 210; i++) history = applyAgentTimelineMutation(history, { type: 'append', agentSessionId: sid,
    item: observation(`status-${i}`, 500 + i, i % 2 ? 'done' : 'working', i ? `status-${i - 1}` : 'done') })
  expect(history).toHaveLength(600)
  expect(history.filter(item => item.activityState)).toHaveLength(200)
  expect(projectAgentWorkHistory(history).coverage).toMatchObject({ recorded: true, truncated: true, gaps: true })
})

it('typed JSONL metadata survives fresh store reads and original compaction, without changing the 1MiB/8MiB caps', async () => {
  const h = await fileHarness()
  const work = observation('durable-work', 100, 'working')
  const done = observation('durable-done', 200, 'done', work.id)
  await h.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: work })
  await h.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: done })
  for (let i = 0; i < 260; i++) await h.store.applyTimelineMutation({ type: 'append', agentSessionId: sid,
    item: { id: `tool-${i}`, agentSessionId: sid, kind: 'tool_call', source: 'acp', status: 'complete', title: 'Tool', createdAt: 300, updatedAt: 300 } })
  const restarted = new AgentMuxFileAgentSessionStore(h.path)
  expect(projectAgentWorkHistory((await restarted.loadTimeline(sid)).items).segments[0]).toMatchObject({ startAt: 100, endAt: 200 })
  expect(JSON.parse((await readFile(h.timelinePath, 'utf8')).split('\n')[0]!).items.some((item: AgentTimelineItem) => item.activityState)).toBe(true)
  await writeFile(h.timelinePath, Buffer.alloc(8 * 1024 * 1024 + 1))
  await expect(restarted.loadTimeline(sid)).rejects.toMatchObject({ code: 'INVALID_AGENT_TIMELINE_STORE' })
  await expect(restarted.compareAndSwap(h.current(), { ...h.current(), hookToken: 'x'.repeat(1024 * 1024) })).rejects.toBeTruthy()
})

it('actual process end closes its exact Run, while lost/restored never invent completion or working continuation', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
  const h = await harness(); await h.hook('UserPromptSubmit', 'before-gap')
  await h.inner.persistActivityBoundary(h.current(), 'lost', 150)
  await h.inner.persistActivityBoundary(h.current(), 'restored', 200)
  expect(projectAgentWorkHistory(await h.history(), { now: 250, current: { run: h.current().run, processState: 'running', semanticStatus: h.current().semanticStatus!, available: true } }).segments).toMatchObject([{ startAt: 100, endAt: 150, end: 'observation-gap' }])
  clock.mockReturnValue(300); await h.hook('UserPromptSubmit', 'confirmed-after-gap')
  h.inner.acceptKernelEvent({ type: 'exit', runId: 'work-run', state: { type: 'exited', code: 0, signal: null }, observedAt: 400 })
  await vi.waitFor(async () => { expect((await h.history()).some(item => item.activityState && 'boundary' in item.activityState && item.activityState.boundary === 'exited')).toBe(true) })
  expect(projectAgentWorkHistory(await h.history()).segments.map(segment => [segment.startAt, segment.endAt, segment.end, segment.startKnown])).toEqual([[100, 150, 'observation-gap', true], [300, 400, 'run-ended', false]])
  expect(h.current().semanticStatus?.state).toBe('working') // Run end is not a fabricated semantic done.
})

it('pure projection respects exact current entry identity, predecessor links, clock reversal and cross-Run gaps', () => {
  const work = observation('work', 100, 'working')
  const current = { run: { runId: 'work-run' }, processState: 'running' as const, semanticStatus: { state: 'working' as const, source: 'acp' as const, observedAt: 100, stateEnteredAt: 100 }, available: true }
  expect(projectAgentWorkHistory([work], { now: 200, current }).segments[0]).toMatchObject({ endAt: 200, end: 'current' })
  expect(projectAgentWorkHistory([work], { now: 200, current: { ...current, semanticStatus: { ...current.semanticStatus, stateEnteredAt: 150 } } }).segments[0]).toMatchObject({ endAt: null, end: 'unknown' })
  expect(projectAgentWorkHistory([work], { now: 200, current: { ...current, available: false } }).segments[0]?.endAt).toBeNull()
  expect(projectAgentWorkHistory([work], { now: 100 + 15 * 60_000, current }).segments[0]).toMatchObject({ endAt: null, end: 'unknown' })
  expect(projectAgentWorkHistory([work, observation('reverse', 90, 'done', work.id)]).segments[0]?.endAt).toBeNull()
  expect(projectAgentWorkHistory([work, observation('other-run', 200, 'done', work.id, 'different-run')]).segments[0]?.endAt).toBeNull()
  expect(projectAgentWorkHistory([observation('partial', 300, 'working', 'missing'), observation('partial-close', 400, 'done', 'partial')]).coverage).toEqual({ recorded: true, truncated: true, gaps: true })
  expect(projectAgentWorkHistory([]).coverage).toEqual({ recorded: false, truncated: false, gaps: false })
  expect(projectAgentWorkHistory([observation('end', 200, 'done', 'work'), work]).segments[0]).toMatchObject({ endAt: 200, end: 'state-change' }) // late physical append is not causal order
})

it('bounded pending metadata reveals an unretained intermediate state instead of fabricating a continuous round', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
  const h = await fileHarness(); await mkdir(h.timelinePath, { recursive: true })
  await h.hook('UserPromptSubmit', 'work-1'); clock.mockReturnValue(200); await h.hook('Stop', 'done-1')
  clock.mockReturnValue(300); await h.hook('UserPromptSubmit', 'work-2'); clock.mockReturnValue(400); await h.hook('Stop', 'done-2')
  expect(Object.keys(h.current().activityCommit!)).toEqual(['latest', 'latestCommitted', 'pending'])
  await rm(h.timelinePath, { recursive: true }); clock.mockReturnValue(999); await h.hook('UserPromptSubmit', 'work-1')
  const projection = projectAgentWorkHistory(await h.history())
  expect(projection.segments[0]).toMatchObject({ startAt: 100, endAt: null, end: 'unknown' })
  expect(projection.coverage).toEqual({ recorded: true, truncated: true, gaps: true })
  expect(h.current().semanticStatus?.state).toBe('done')
})

it('retirement racing an accepted append authorizes only the exact durable observation, and public archived reads stay read-only', async () => {
  const h = await fileHarness()
  const accepted: AgentActivityObservation = { id: 'accepted-before-retire', source: 'acp', createdAt: 100,
    activityState: { run: { runId: 'work-run' }, state: 'working', stateEnteredAt: 100 } }
  const next = { ...h.current(), activityCommit: advanceAgentActivityCommit(undefined, accepted) }
  await h.store.compareAndSwap(h.current(), next)
  await retire(h.store, next)
  const item = agentActivityTimelineItem(sid, accepted)
  await expect(h.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item })).resolves.toMatchObject({ changed: true })
  await expect(h.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { ...item, id: 'forged', activityState: { run: { runId: 'another-run' }, state: 'working' } } })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  await expect(h.store.applyTimelineMutation({ type: 'update', agentSessionId: sid, itemId: item.id, updatedAt: 200, title: 'Altered archive' })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  const before = await readFile(h.path, 'utf8')
  const fresh = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.path) }); clients.push(fresh)
  expect((await fresh.sessionHistorySources()).find(source => source.agentSessionId === sid)?.state).toBe('retired')
  expect(projectAgentWorkHistory((await fresh.sessionTimeline(sid)).items).segments[0]?.end).toBe('unknown')
  expect(await readFile(h.path, 'utf8')).toBe(before)
})
