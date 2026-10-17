// @vitest-environment happy-dom
import { act, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxMessageEvent, AgentMuxRpcParams, AgentMuxRpcResult, AgentMuxSpawnRecord } from '@agentmux/core'
import type { RuntimeEvent, SessionHistoryReference } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useCollaborationReading } from '../src/renderer/src/lib/use-collaboration-reading'
import { collaborationSubjectKey, createCollaborationProjector, projectCollaboration, visibleCollaboration, type CollaborationReading } from '../src/renderer/src/lib/agent-collaboration'

type EventOptions = Omit<AgentMuxRpcParams<'message.events'>, 'hostId' | 'participantSessionId'>
type EventPage = AgentMuxRpcResult<'message.events'>
type Reading = ReturnType<typeof useCollaborationReading>
const reader = { hostId: 'original-host', agentSessionId: 'reader' }
const peer = { ...reader, agentSessionId: 'peer' }
const reference = (hostId: string, agentSessionId = 'reader'): SessionHistoryReference => ({ hostId, agentSessionId })
let root: Root | undefined, container: HTMLDivElement, reading: Reading
let listeners: Set<(event: RuntimeEvent) => void>

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function event(sequence: number, messageId = 'message-' + sequence, sender = 'reader', recipient = 'peer'): AgentMuxMessageEvent {
  return { sequence, kind: 'message', at: sequence, messages: [{ messageId, senderSessionId: sender, recipientSessionId: recipient, threadId: 'original-thread', replyTo: null }] }
}
function page(subject: SessionHistoryReference, options: EventOptions = {}, events: AgentMuxMessageEvent[] = [], through = 100,
  cursors: { older?: number | null; newer?: number | null } = {}, incarnation = 'original-journal'): EventPage {
  return { hostId: subject.hostId, participantSessionId: subject.agentSessionId, afterSequence: options.afterSequence ?? 0, latest: options.latest ?? false,
    beforeSequence: options.beforeSequence ?? null, throughSequence: through, incarnation, messageId: options.messageId ?? null,
    broadcastOperationId: options.broadcastOperationId ?? null, events, nextBeforeSequence: cursors.older ?? null, nextAfterSequence: cursors.newer ?? null }
}
function Probe({ subjects, enabled }: { subjects: readonly SessionHistoryReference[]; enabled: boolean }) {
  reading = useCollaborationReading(subjects, enabled)
  return <output>{JSON.stringify(reading.sources.map(source => ({ subject: source.subject, events: source.events, issues: source.issues })))}</output>
}
async function render(subjects: readonly SessionHistoryReference[] = [reader], enabled = true) {
  await act(async () => root!.render(<Probe subjects={subjects} enabled={enabled} />))
}
async function emit(event: RuntimeEvent['event'], hostId = reader.hostId) {
  await act(async () => { for (const listener of [...listeners]) listener({ type: 'core', hostId, event }) })
}
const change = (sequence: number, live = true, sender = 'reader', recipient = 'peer'): RuntimeEvent['event'] => ({ type: 'agent-message-changed',
  sequence, messageSequence: sequence, live, recordKind: 'message', messageId: 'message-' + sequence, senderSessionId: sender, recipientSessionId: recipient })

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); listeners = new Set()
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  vi.spyOn(api.sessions, 'messageEvents').mockImplementation(async (subject, options) => page(subject, options))
  vi.spyOn(api.sessions, 'spawns').mockImplementation(async (subject, options) => ({ hostId: subject.hostId, participantSessionId: subject.agentSessionId,
    direction: options.direction, creatorRuntimeId: null, records: [], nextCursor: null, coverage: { scope: 'selected-owner', history: 'recorded-creations' } }))
  vi.spyOn(api.sessions, 'dispatches').mockImplementation(async subject => ({ hostId: subject.hostId, participantSessionId: subject.agentSessionId, dispatches: [], nextSourceMessageId: null }))
  vi.spyOn(api.sessions, 'readMessage'); vi.spyOn(api.sessions, 'dispatch')
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container.remove(); vi.restoreAllMocks(); vi.useRealTimers() })

it('drains the frozen forward window before opening a new cut for a later observed event', async () => {
  const first = deferred<EventPage>(), second = deferred<EventPage>()
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (subject, options = {}) => {
    if (options.latest) return page(subject, options, [event(100)], 100)
    if (options.afterSequence === 100) return first.promise
    if (options.afterSequence === 150) return second.promise
    expect(options).toEqual({ afterSequence: 200, incarnation: 'original-journal', limit: 50 })
    return page(subject, options, [event(201)], 201)
  })
  await render(); await emit(change(200)); await emit(change(201))
  expect(api.sessions.messageEvents).toHaveBeenCalledTimes(2)
  await act(async () => first.resolve(page(reader, { afterSequence: 100 }, Array.from({ length: 50 }, (_, index) => event(101 + index)), 200, { newer: 150 })))
  expect(api.sessions.messageEvents).toHaveBeenLastCalledWith(reader, { afterSequence: 150, throughSequence: 200, incarnation: 'original-journal', limit: 50 })
  await act(async () => second.resolve(page(reader, { afterSequence: 150, throughSequence: 200 }, Array.from({ length: 50 }, (_, index) => event(151 + index)), 200)))
  expect(api.sessions.messageEvents).toHaveBeenCalledTimes(4)
  expect(reading.sources[0]!.events.map(item => item.sequence)).toEqual(Array.from({ length: 102 }, (_, index) => 100 + index))
  expect(reading.sources[0]!.updates).toEqual({ after: 201, more: false })
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled(); expect(api.sessions.dispatches).not.toHaveBeenCalled()
})

it('retains a newer observer hint received while the very first latest window is in flight', async () => {
  const latest = deferred<EventPage>()
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (subject, options = {}) => options.latest ? latest.promise : page(subject, options, [event(200)], 200))
  await render(); await emit(change(200))
  expect(api.sessions.messageEvents).toHaveBeenCalledTimes(1)
  await act(async () => latest.resolve(page(reader, { latest: true }, [event(100)], 100)))
  expect(api.sessions.messageEvents).toHaveBeenNthCalledWith(1, reader, { latest: true, limit: 50 }); expect(api.sessions.messageEvents).toHaveBeenCalledTimes(2)
  expect(api.sessions.messageEvents).toHaveBeenCalledWith(reader, { afterSequence: 100, incarnation: 'original-journal', limit: 50 })
  expect(reading.sources[0]!.events.map(item => item.sequence)).toEqual([100, 200])
})

it('allows completed slots to read later participants while one Host stays slow', async () => {
  const slow = deferred<EventPage>(), subjects = ['slow', 'fast-a', 'fast-b', 'fast-c', 'fast-d', 'fast-e'].map(id => reference(id))
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (subject, options) => subject.hostId === 'slow' ? slow.promise : page(subject, options, [event(100)]))
  await render(subjects)
  expect(vi.mocked(api.sessions.messageEvents).mock.calls.map(([subject]) => subject.hostId)).toEqual(expect.arrayContaining(['fast-d', 'fast-e']))
  expect(reading.sources.find(source => source.subject.hostId === 'fast-e')!.events).toHaveLength(1)
  expect(reading.sources.find(source => source.subject.hostId === 'slow')!.loading).toContain('events')
  await render(subjects, false)
  const count = vi.mocked(api.sessions.messageEvents).mock.calls.length
  await act(async () => slow.resolve(page(subjects[0]!)))
  expect(api.sessions.messageEvents).toHaveBeenCalledTimes(count)
  expect(reading.sources.map(source => source.subject)).toEqual(subjects)
  expect(reading.sources.find(source => source.subject.hostId === 'fast-e')!.events).toHaveLength(1)
  expect(listeners.size).toBe(0)
})

it('never starts queued participants or follows observer hints after hiding', async () => {
  const blocked = deferred<EventPage>(), subjects = Array.from({ length: 9 }, (_, index) => reference('host-' + index))
  vi.mocked(api.sessions.messageEvents).mockImplementation(() => blocked.promise)
  await render(subjects); expect(api.sessions.messageEvents).toHaveBeenCalledTimes(4)
  const oldListener = [...listeners][0]!
  await render(subjects, false)
  await act(async () => { oldListener({ type: 'core', hostId: subjects[0]!.hostId, event: change(100) }); blocked.resolve(page(subjects[0]!)) })
  expect(api.sessions.messageEvents).toHaveBeenCalledTimes(4); expect(api.sessions.spawns).toHaveBeenCalledTimes(8)
  expect(api.sessions.dispatches).not.toHaveBeenCalled(); expect(reading.pulses).toEqual([])
})

it('keeps exact Host and Session sources isolated across late failures and late successes', async () => {
  const previous = deferred<EventPage>(), replacement = reference('replacement-host')
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (subject, options) => subject.hostId === reader.hostId ? previous.promise : page(subject, options, [event(90, 'replacement')], 90))
  await render(); await render([replacement])
  expect(reading.sources.map(source => source.subject)).toEqual([replacement])
  await act(async () => previous.reject(new Error('OLD SOURCE FAILURE')))
  expect(reading.sources[0]!.events[0]!.messages[0]!.messageId).toBe('replacement')
  expect(reading.sources[0]!.issues).toEqual({}); expect(container.textContent).not.toContain('OLD SOURCE FAILURE')
  const next = deferred<EventPage>()
  vi.mocked(api.sessions.messageEvents).mockImplementationOnce(() => next.promise)
  await act(async () => { reading.act(replacement, 'refresh') }); await render([reference('third-host')])
  await act(async () => next.resolve(page(replacement, {}, [event(99, 'LATE REPLACEMENT')], 99)))
  expect(reading.sources[0]!.subject.hostId).toBe('third-host'); expect(container.textContent).not.toContain('LATE REPLACEMENT')
})

it('fences a first A read even after A-B-A returns to the exact same participant', async () => {
  const firstA = deferred<EventPage>(); let aReads = 0
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (subject, options) => subject.hostId === reader.hostId && ++aReads === 1
    ? firstA.promise : page(subject, options, [event(90, 'CURRENT EPISODE')], 90))
  await render(); await render([reference('other-host')]); await render()
  await act(async () => firstA.resolve(page(reader, { latest: true }, [event(100, 'STALE EPISODE')], 100)))
  expect(reading.sources).toHaveLength(1); expect(reading.sources[0]!.subject).toEqual(reader)
  expect(reading.sources[0]!.events.flatMap(item => item.messages.map(message => message.messageId))).toEqual(['CURRENT EPISODE'])
})

it('retains readable events on wrong-source and failed reads and exposes retry on the original identity', async () => {
  vi.mocked(api.sessions.messageEvents).mockResolvedValueOnce(page(reader, { latest: true }, [event(100)]))
  await render()
  vi.mocked(api.sessions.messageEvents).mockResolvedValueOnce(page(reference('wrong-host'), {}, [event(101, 'WRONG SOURCE')], 101))
  await act(async () => reading.act(reader, 'refresh'))
  expect(reading.sources[0]!.events.map(item => item.sequence)).toEqual([100]); expect(reading.sources[0]!.issues.events).toContain('Host or participant')
  vi.mocked(api.sessions.messageEvents).mockRejectedValueOnce(new Error('Original read unavailable'))
  await act(async () => reading.act(reader, 'refresh'))
  expect(reading.sources[0]!.events.map(item => item.sequence)).toEqual([100]); expect(reading.sources[0]!.issues.events).toBe('Original read unavailable')
  vi.mocked(api.sessions.messageEvents).mockResolvedValueOnce(page(reader, { latest: true }, [event(101)], 101))
  await act(async () => reading.act(reader, 'refresh'))
  expect(reading.sources[0]!.issues).toEqual({}); expect(reading.sources[0]!.events.map(item => item.sequence)).toEqual([100, 101])
  expect(api.sessions.messageEvents).toHaveBeenLastCalledWith(reader, { latest: true, limit: 50 })
})

it('keeps the original backward boundary while live appends advance the independent forward cursor', async () => {
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (subject, options = {}) => options.latest
    ? page(subject, options, [event(90), event(100)], 100, { older: 90 })
    : options.beforeSequence !== undefined ? page(subject, options, [event(80)], 100)
      : page(subject, options, [event(101)], 101))
  await render(); await emit(change(101)); await act(async () => reading.act(reader, 'earlier'))
  expect(api.sessions.messageEvents).toHaveBeenLastCalledWith(reader, { beforeSequence: 90, throughSequence: 100, incarnation: 'original-journal', limit: 50 })
  expect(reading.sources[0]!.events.map(item => item.sequence)).toEqual([80, 90, 100, 101])
  expect(reading.sources[0]!.history).toEqual({ before: null, through: 100, incarnation: 'original-journal' })
  expect(reading.sources[0]!.updates).toEqual({ after: 101, more: false })
})

it('reads bounded original creation pages explicitly and keeps the failed cursor retryable', async () => {
  const child = (agentSessionId: string): AgentMuxSpawnRecord => ({ agentSessionId, phase: 'active', currentRun: { runId: 'original-' + agentSessionId }, createdAt: 1,
    creation: { createOperationId: 'create-' + agentSessionId, initialPrompt: 'not-requested', createdBy: { agentSessionId: reader.agentSessionId,
      run: { runId: 'creator-run' }, owner: { kind: 'local' } } } })
  let olderReads = 0
  vi.mocked(api.sessions.spawns).mockImplementation(async (subject, options) => {
    if (options.cursor && ++olderReads === 1) throw new Error('Original creation page unavailable')
    return { hostId: subject.hostId, participantSessionId: subject.agentSessionId, direction: options.direction, creatorRuntimeId: null,
      records: options.direction === 'creator' ? [] : [child(options.cursor ? 'child-b' : 'child-a')],
      nextCursor: options.direction === 'created' && !options.cursor ? 'original-cursor' : null,
      coverage: { scope: 'selected-owner', history: 'recorded-creations' } }
  })
  await render(); expect(api.sessions.spawns).toHaveBeenCalledTimes(2)
  expect(reading.sources[0]!.spawns.map(item => item.agentSessionId)).toEqual(['child-a'])
  await act(async () => reading.act(reader, 'created'))
  expect(reading.sources[0]!.issues.created).toBe('Original creation page unavailable')
  expect(reading.sources[0]!.spawnCreated!.nextCursor).toBe('original-cursor')
  await act(async () => reading.act(reader, 'created'))
  expect(api.sessions.spawns).toHaveBeenLastCalledWith(reader, { direction: 'created', limit: 25, cursor: 'original-cursor' })
  expect(reading.sources[0]!.spawns.map(item => item.agentSessionId)).toEqual(['child-a', 'child-b'])
  expect(reading.sources[0]!.spawnCreated!.nextCursor).toBeNull(); expect(reading.sources[0]!.issues).toEqual({})
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled(); expect(api.sessions.dispatches).not.toHaveBeenCalled()
})

it('expires old observer sequence watermarks when explicit refresh accepts another journal incarnation', async () => {
  let latestReads = 0, unexpectedReads = 0
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (subject, options = {}) => {
    if (options.latest) return ++latestReads === 1 ? page(subject, options, [event(100)], 100)
      : page(subject, options, [event(10)], 10, {}, 'replacement-journal')
    if (options.incarnation === 'original-journal') throw new Error('The original journal identity changed')
    if (options.afterSequence === 10 && unexpectedReads++ < 3) return page(subject, options, [], 10, {}, 'replacement-journal')
    if (options.afterSequence === 10) throw new Error('A stale observer watermark caused repeated reads')
    return page(subject, options, [event(11)], 11, {}, 'replacement-journal')
  })
  await render(); await emit(change(1000))
  expect(reading.sources[0]!.issues.events).toContain('identity changed'); expect(reading.pulses).toHaveLength(1)
  await act(async () => reading.act(reader, 'refresh'))
  expect(api.sessions.messageEvents).toHaveBeenCalledTimes(3)
  expect(reading.sources[0]!.incarnation).toBe('replacement-journal'); expect(reading.sources[0]!.events.map(item => item.sequence)).toEqual([10])
  expect(reading.pulses).toEqual([])
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (subject, options) => page(subject, options, [event(11)], 11, {}, 'replacement-journal'))
  await emit(change(11))
  expect(reading.pulses).toHaveLength(1); expect(reading.sources[0]!.updates).toEqual({ after: 11, more: false })
})

it('starts observation as unknown, scopes state by Host, and never animates catch-up or duplicate records', async () => {
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (subject, options = {}) => page(subject, options, [event(options.afterSequence === undefined ? 100 : options.afterSequence + 1)], options.afterSequence === undefined ? 100 : options.afterSequence + 1))
  await render([reader, reference('other-host')])
  expect(reading.sources).toHaveLength(2)
  expect(reading.sources.every(source => source.observationIssue?.includes('unconfirmed'))).toBe(true)
  await emit({ type: 'agent-message-observation', state: 'available' })
  expect(reading.sources.find(source => source.subject.hostId === reader.hostId)!.observationIssue).toBeNull()
  expect(reading.sources.find(source => source.subject.hostId === 'other-host')!.observationIssue).toContain('unconfirmed')
  await emit(change(101, false)); expect(reading.pulses).toEqual([])
  await emit(change(102)); expect(reading.pulses).toHaveLength(1)
  await emit(change(102)); expect(reading.pulses).toHaveLength(1)
  const before = vi.mocked(api.sessions.messageEvents).mock.calls.length
  await emit(change(999, true, 'unrelated-a', 'unrelated-b'))
  expect(api.sessions.messageEvents).toHaveBeenCalledTimes(before)
  await emit({ type: 'agent-message-observation', state: 'unavailable', message: 'Original watcher unavailable' })
  expect(reading.sources.find(source => source.subject.hostId === reader.hostId)!.observationIssue).toBe('Original watcher unavailable')
})

const source = (subject: SessionHistoryReference, events: AgentMuxMessageEvent[], incarnation = 'original-journal', extras: Partial<CollaborationReading> = {}): CollaborationReading => ({ subject, incarnation, events, spawns: [], ...extras })
it('deduplicates both participant reads and notification references by original MID and journal while preserving direction', () => {
  const first = event(1, 'same-mid'), notification: AgentMuxMessageEvent = { sequence: 2, kind: 'a2a-notification', at: null,
    notificationId: 'notification', state: 'pending', messages: first.messages }
  const projected = projectCollaboration([source(reader, [first, notification]), source(peer, [first, notification])], new Map())
  expect(projected.agents.size).toBe(2); expect(projected.relations).toHaveLength(1)
  const relation = projected.relations[0]!
  expect(relation.source).toBe(collaborationSubjectKey(reader)); expect(relation.target).toBe(collaborationSubjectKey(peer))
  expect(relation.evidence).toHaveLength(1); expect(relation.evidence[0]!.kind).toBe('communication')
  if (relation.evidence[0]!.kind !== 'communication') throw new Error('Expected communication evidence')
  expect(relation.evidence[0]!.events.map(item => item.sequence)).toEqual([1, 2])
  expect(relation.evidence[0]!.incarnation).toBe('original-journal')
})

it('keeps same MID in different incarnations separate and keeps different Hosts as different Agents', () => {
  const projected = projectCollaboration([source(reader, [event(1, 'same-mid')]), source(peer, [event(1, 'same-mid', 'peer', 'reader')], 'replacement-journal'),
    source(reference('remote-owner'), [event(1, 'same-mid')])], new Map())
  expect(projected.agents.size).toBe(4); expect(projected.relations).toHaveLength(3)
  const communication = projected.relations.flatMap(relation => relation.evidence).filter(item => item.kind === 'communication')
  expect(communication).toHaveLength(3); expect(new Set(communication.map(item => item.id)).size).toBe(3)
  expect(communication.map(item => [item.subject.hostId, item.incarnation])).toEqual(expect.arrayContaining([
    [reader.hostId, 'original-journal'], [reader.hostId, 'replacement-journal'], ['remote-owner', 'original-journal']
  ]))
})

it('preserves all evidence for overlapping area and direct Focus filters without creating new identities', () => {
  const projected = projectCollaboration([source(reader, [event(1), event(2, 'second'), event(3, 'other', 'unrelated', 'peer')])], new Map())
  const allKinds = new Set(['communication'] as const), member = collaborationSubjectKey(reader)
  const areaA = visibleCollaboration(projected.relations, new Set([member]), allKinds)
  const areaB = visibleCollaboration(projected.relations, new Set([member, collaborationSubjectKey(peer)]), allKinds, member)
  expect(areaA).toHaveLength(1); expect(areaB).toHaveLength(1); expect(areaA[0]).toBe(areaB[0]); expect(areaA[0]!.evidence).toHaveLength(2)
  expect(visibleCollaboration(projected.relations, new Set(), new Set(), member)).toEqual([])
})

it('keeps foreign Runtime creation provenance unresolved instead of impersonating a Desktop Host route', () => {
  const creation: AgentMuxSpawnRecord = { agentSessionId: 'child', phase: 'active', currentRun: { runId: 'child-run' }, createdAt: 1,
    creation: { createOperationId: 'original-create', initialPrompt: 'not-requested', createdBy: { agentSessionId: 'reader', run: { runId: 'creator-run' }, owner: { kind: 'runtime', runtimeId: 'foreign-runtime' } } } }
  const projected = projectCollaboration([source(reader, [], 'original-journal', { spawns: [creation] })], new Map())
  expect(projected.relations).toHaveLength(1); expect(projected.relations[0]!.kind).toBe('creation')
  const parent = projected.agents.get(projected.relations[0]!.source)!
  expect(parent.subject).toBeNull(); expect(parent.provenance).toBe('Runtime foreign-runtime')
  expect(parent.id).not.toBe(collaborationSubjectKey(reader)); expect(projected.agents.get(projected.relations[0]!.target)!.subject).toEqual({ hostId: reader.hostId, agentSessionId: 'child' })
})

it('keeps original supervision events separate from communication and never promotes them to a current Task verdict', () => {
  const request = event(1, 'request'), opened: AgentMuxMessageEvent = { ...request, sequence: 2, kind: 'dispatch-open' },
    report: AgentMuxMessageEvent = { ...request, sequence: 4, kind: 'dispatch-event', eventKind: 'worker_done', replyMessageId: 'report' }
  const projected = projectCollaboration([source(reader, [request, opened, report]), source(peer, [opened, report])], new Map())
  expect(projected.relations).toHaveLength(2)
  const supervision = projected.relations.find(relation => relation.kind === 'supervision')!
  expect(supervision.evidence).toHaveLength(1)
  expect(supervision.source).toBe(collaborationSubjectKey(reader)); expect(supervision.target).toBe(collaborationSubjectKey(peer))
  const evidence = supervision.evidence[0]!
  expect(evidence.kind).toBe('supervision'); if (evidence.kind !== 'supervision') throw new Error('Expected original supervision evidence')
  expect(evidence.events.map(item => [item.kind, item.sequence])).toEqual([['dispatch-open', 2], ['dispatch-event', 4]])
  expect(evidence).not.toHaveProperty('dispatch'); expect(evidence).not.toHaveProperty('originAwaits')
  expect(projected.relations.find(relation => relation.kind === 'communication')!.evidence).toHaveLength(1)
})


it('retains the exact facts through status-only loading failure observation and pulse expiration', async () => {
  vi.useFakeTimers()
  vi.mocked(api.sessions.messageEvents).mockResolvedValueOnce(page(reader, { latest: true }, [event(100)]))
  await render()
  const facts = reading.facts, original = facts[0]!, pending = deferred<EventPage>()
  expect(facts).toHaveLength(1); expect(original.events).toHaveLength(1)
  vi.mocked(api.sessions.messageEvents).mockImplementation(() => pending.promise)
  await act(async () => { reading.act(reader, 'refresh') })
  expect(reading.sources[0]!.loading).toContain('events'); expect(reading.facts).toBe(facts)
  await emit({ type: 'agent-message-observation', state: 'unavailable', message: 'Source temporarily unavailable' })
  expect(reading.facts).toBe(facts); expect(reading.facts[0]).toBe(original)
  await emit(change(101)); expect(reading.pulses).toHaveLength(1)
  await act(async () => pending.reject(Error('Original page unavailable')))
  expect(reading.sources[0]!.issues.events).toBe('Original page unavailable'); expect(reading.facts).toBe(facts)
  await act(async () => { await vi.advanceTimersByTimeAsync(1801) })
  expect(reading.pulses).toEqual([]); expect(reading.facts).toBe(facts)
})

it('retains loaded A history while B is demanded and resumes A without an initial query', async () => {
  const b = reference('other-owner')
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (subject, options = {}) => subject.hostId === b.hostId ? page(subject, options)
    : options.latest ? page(subject, options, [event(90), event(100)], 100, { older: 90 })
      : options.beforeSequence === 90 ? page(subject, options, [event(80)], 100, { older: 80 })
        : options.beforeSequence === 80 ? page(subject, options, [event(70)], 100)
          : page(subject, options, [event(101)], 101))
  await render(); await act(async () => reading.act(reader, 'earlier'))
  const a = reading.facts.find(fact => fact.subject.hostId === reader.hostId)!
  expect(a.events.map(item => item.sequence)).toEqual([80, 90, 100])
  const aCalls = () => vi.mocked(api.sessions.messageEvents).mock.calls.filter(([subject]) => subject.hostId === reader.hostId)
  expect(aCalls()).toHaveLength(2)
  await render([b]); await emit(change(101))
  expect(reading.facts.find(fact => fact.subject.hostId === reader.hostId)).toBe(a); expect(aCalls()).toHaveLength(2)
  await render()
  expect(aCalls().map(([, options]) => options)).toEqual([
    { latest: true, limit: 50 }, { beforeSequence: 90, throughSequence: 100, incarnation: 'original-journal', limit: 50 },
    { afterSequence: 100, incarnation: 'original-journal', limit: 50 }
  ])
  expect(reading.sources[0]!.history).toEqual({ before: 80, through: 100, incarnation: 'original-journal' })
  await act(async () => reading.act(reader, 'earlier'))
  expect(aCalls().at(-1)![1]).toEqual({ beforeSequence: 80, throughSequence: 100, incarnation: 'original-journal', limit: 50 })
  expect(reading.sources[0]!.events.map(item => item.sequence)).toEqual([70, 80, 90, 100, 101])
})

it('decodes only a new original page after ten thousand real accumulated rows and leaves other sources stable', async () => {
  let decoded = 0
  const instrumented = (sequence: number) => {
    const row = event(sequence), refs = row.messages
    Object.defineProperty(row, 'messages', { get() { decoded++; return refs } })
    return row
  }
  const rows = Array.from({ length: 10001 }, (_, index) => instrumented(index + 1))
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (subject, options = {}) => {
    if (options.latest) return page(subject, options, rows.slice(9950, 10000), 10000, { older: 9951 })
    if (options.beforeSequence !== undefined) { const before = options.beforeSequence!, start = Math.max(1, before - 50)
      return page(subject, options, rows.slice(start - 1, before - 1), 10000, { older: start === 1 ? null : start }) }
    return page(subject, options, [rows[10000]!], 10001)
  })
  let projection!: ReturnType<ReturnType<typeof createCollaborationProjector>>
  function ProjectionProbe() {
    reading = useCollaborationReading([reader], true)
    const project = useMemo(createCollaborationProjector, [])
    projection = useMemo(() => project(reading.facts), [project, reading.facts])
    return <output>{reading.sources[0]?.events.length}</output>
  }
  await act(async () => root!.render(<ProjectionProbe />))
  for (let index = 0; index < 199; index++) await act(async () => reading.act(reader, 'earlier'))
  expect(reading.sources[0]!.events).toHaveLength(10000); expect(projection.relations).toHaveLength(1)
  expect(projection.relations[0]!.evidence).toHaveLength(10000); expect(decoded).toBe(10000)
  const agents = projection.agents, originalEvidence = projection.relations[0]!.evidence[0]!
  await emit(change(10001))
  expect(decoded).toBe(10001); expect(reading.sources[0]!.events).toHaveLength(10001)
  expect(projection.agents).toBe(agents); expect(projection.relations[0]!.evidence[0]).toBe(originalEvidence)
  expect(projection.relations[0]!.evidence).toHaveLength(10001)
})

it('reuses unrelated projections and folds newly observed sources without replacing unchanged evidence', () => {
  let decodedA = 0, decodedB = 0
  const aRow = event(1), bRow = event(2, 'unrelated', 'another', 'third')
  const aRefs = aRow.messages, bRefs = bRow.messages
  Object.defineProperty(aRow, 'messages', { get() { decodedA++; return aRefs } })
  Object.defineProperty(bRow, 'messages', { get() { decodedB++; return bRefs } })
  const a = source(reader, [aRow]), b = source(reference('other-owner'), [bRow]), project = createCollaborationProjector()
  const first = project([a, b]), unrelated = first.relations.find(relation => relation.source === collaborationSubjectKey(reference('other-owner', 'another')))!
  expect(first.relations).toHaveLength(2); expect(decodedA).toBe(1); expect(decodedB).toBe(1)
  expect(project([a, b])).toBe(first)
  const row = event(3, 'another-message'), next = { ...a, events: [...a.events, row], changes: { previous: undefined, events: [row], spawns: [] } }
  const updated = project([next, b])
  expect(updated.agents).toBe(first.agents); expect(updated.relations.find(relation => relation.id === unrelated.id)).toBe(unrelated)
  expect(decodedA).toBe(1); expect(decodedB).toBe(1)
  expect(updated.relations.find(relation => relation.source === collaborationSubjectKey(reader))!.evidence).toHaveLength(2)
  const folded = project([next, b, source(peer, [aRow, row])])
  expect(folded).toBe(updated); expect(decodedA).toBe(2); expect(decodedB).toBe(1)
  expect(folded.relations.flatMap(relation => relation.evidence)).toHaveLength(3)
})


it('replaces only the exact source incarnation and transfers shared evidence to the surviving original observer', () => {
  const project = createCollaborationProjector(), shared = event(1, 'same-mid')
  const a = source(reader, [shared]), b = source(peer, [shared]), first = project([a, b])
  expect(first.relations).toHaveLength(1); expect(first.relations[0]!.evidence).toHaveLength(1)
  expect(first.relations[0]!.evidence[0]!.subject).toEqual(reader)
  const surviving = project([b])
  expect(surviving.relations).toHaveLength(1); expect(surviving.relations[0]!.evidence[0]!.subject).toEqual(peer)
  const replaced = project([source(reader, [event(1, 'same-mid', 'reader', 'new-peer')], 'new-incarnation'), b])
  expect(replaced.relations).toHaveLength(2); expect(replaced.agents.size).toBe(3)
  expect(replaced.relations.flatMap(relation => relation.evidence).map(item => item.kind === 'creation' ? null : item.incarnation).sort()).toEqual(['new-incarnation', 'original-journal'])
  expect(project([]).agents.size).toBe(0); expect(project([]).relations).toEqual([])
})


it('keeps a live pulse phase and original observer watermark while active viewport demand changes', async () => {
  vi.useFakeTimers()
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (subject, options = {}) => {
    const sequence = options.afterSequence === undefined ? 100 : options.afterSequence + 1
    return page(subject, options, [event(sequence)], sequence)
  })
  await render(); await emit(change(101))
  expect(reading.pulses).toHaveLength(1)
  const pulse = reading.pulses[0]!, b = reference(reader.hostId, 'another-source')
  await act(async () => { await vi.advanceTimersByTimeAsync(900) })
  await render([b]); expect(reading.pulses).toEqual([pulse])
  await render([reader, b]); await emit(change(101))
  expect(reading.pulses).toEqual([pulse]); expect(reading.pulses[0]).toBe(pulse)
  await act(async () => { await vi.advanceTimersByTimeAsync(901) })
  expect(reading.pulses).toEqual([])
  await emit(change(101)); expect(reading.pulses).toEqual([])
})
