import { appendFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { consumeConversationWindowPage } from '../src/conversation-changes.js'
import type { ConversationObservation } from '../src/conversation-changes.js'
import { AgentMuxError } from '../src/errors.js'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'
import { transientHistoryFixture } from './helpers/transient-history-fixture.js'

afterEach(() => { vi.restoreAllMocks() })

function complete(page: Parameters<typeof consumeConversationWindowPage>[0]) {
  const result = consumeConversationWindowPage(page)
  expect(result.kind).toBe('complete')
  if (result.kind !== 'complete') throw new Error('This small original source must fit one complete frame')
  return result.snapshot
}
const originals = (snapshot: ReturnType<typeof complete>) => snapshot.units.flatMap(unit => unit.records.map(record => record.original.item.id))

it('Pi original public window consumes linked native appends through its own same-page changes cut', async () => {
  const message = (id: string, parentId: string | null) => ({ type: 'message', id, parentId,
    message: { role: 'user', content: [{ type: 'text', text: 'Same original native input.' }] } })
  const f = await nativeHistoryFixture('pi', cwd => jsonl([
    { type: 'session', version: 3, id: 'native-main', cwd }, message('original', null)
  ]))
  const metadata = await f.store.loadMetadata()
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const appended = jsonl([message('same-body-new', 'original'), message('untimed-new', 'same-body-new')])
  try {
    const initial = await f.client.readAgentConversation(ref)
    expect(originals(complete(initial))).toEqual(['original'])
    await appendFile(f.path, appended)
    const changed = await f.client.readConversationChanges({ ...ref, checkpoint: initial.window.checkpoint, view: initial.window.view! })
    expect(changed.order.direction).toBe('newest-first')
    expect(originals(complete(changed)), JSON.stringify({ coverage: changed.coverage }))
      .toEqual(['untimed-new', 'same-body-new', 'original'])
    expect(complete(changed).units.flatMap(unit => unit.records).every(record =>
      record.original.kind === 'native' && record.reference.source.kind === 'native' &&
      record.reference.source.providerId === 'pi' && record.reference.source.nativeSessionId === 'native-main')).toBe(true)
    expect(await f.store.loadMetadata()).toEqual(metadata)
    expect((await f.bytes()).native).toEqual(Buffer.concat([f.before.native, Buffer.from(appended)]))
    expect(f.controls).toHaveLength(6)
    f.controls.forEach(control => expect(control).not.toHaveBeenCalled())
  } finally { await f.close() }
})

it.each(['metadata', 'witness'] as const)('unified reading consumes the original active transient source and recovers after %s uncertainty', async kind => {
  const f = await transientHistoryFixture()
  const metadata = await f.store.loadMetadata()
  const ref = { hostId: 'local', agentSessionId: f.retained.agentSessionId }
  let observer: Awaited<ReturnType<typeof f.client.observeConversation>> | undefined
  const observations: ConversationObservation[] = []
  try {
    observer = await f.client.observeConversation(ref, value => observations.push(value))
    expect(observer.scope.sources.filter(source => source.kind === 'native')).toEqual([{ kind: 'native', ...f.source }])
    expect(f.discover).toHaveBeenCalledOnce()
    const initial = await f.client.readAgentConversation(ref)
    expect({ sources: initial.scope.sources.filter(source => source.kind === 'native'), ids: originals(complete(initial)) })
      .toEqual({ sources: [{ kind: 'native', ...f.source }], ids: ['original'] })
    f.fail(kind); f.invalidate()
    await vi.waitFor(() => expect(f.changes).toHaveLength(1))
    expect(f.changes[0]).toMatchObject({ kind: 'unavailable', source: f.source,
      code: kind === 'metadata' ? 'EIO' : 'AGENT_SESSION_STORE_BUSY' })
    expect(observations).toMatchObject([{ kind: 'unavailable', source: { kind: 'native', ...f.source },
      code: kind === 'metadata' ? 'EIO' : 'AGENT_SESSION_STORE_BUSY' }])
    expect(observer.closed.aborted).toBe(false)
    expect(f.released).not.toHaveBeenCalled()
    await expect(f.client.writeAgent({ agentSessionId: ref.agentSessionId, expectedRun: f.retained.run, source: 'user', data: 'x' }))
      .resolves.toMatchObject({ appliedByteRange: { startByte: 0, endByte: 1 } })
    expect(f.input).toHaveBeenCalledOnce()
    await f.append(); f.invalidate()
    await vi.waitFor(() => expect(f.changes).toHaveLength(2))
    expect(f.changes[1]).toEqual({ kind: 'invalidated', agentSessionId: ref.agentSessionId, source: f.source })
    expect(observations).toMatchObject([{ kind: 'unavailable' }, { kind: 'invalidated', source: { kind: 'native', ...f.source } }])
    const recovered = await f.client.readConversationChanges({ ...ref, checkpoint: initial.window.checkpoint, view: initial.window.view! })
    expect(recovered.order.direction).toBe('newest-first')
    expect(originals(complete(recovered))).toEqual(['later', 'original'])
    expect(recovered.scope).toEqual(initial.scope)
    expect(f.released).not.toHaveBeenCalled()
    expect(f.observe).toHaveBeenCalledOnce(); expect(f.discover).toHaveBeenCalledOnce(); expect(f.input).toHaveBeenCalledOnce()
    expect(f.client.agentSession(ref.agentSessionId).run).toEqual(f.retained.run)
    expect(f.client.agentSession(ref.agentSessionId).nativeHandle).toEqual(f.retained.nativeHandle)
    expect(await f.store.loadMetadata()).toEqual(metadata)
  } finally { observer?.dispose(); await f.close() }
})

it('a fresh public current observation and its first unified read share the original unsaved native source', async () => {
  const f = await transientHistoryFixture()
  const metadata = await f.store.loadMetadata()
  const ref = { hostId: 'local', agentSessionId: f.retained.agentSessionId }
  let observer: Awaited<ReturnType<typeof f.client.observeConversation>> | undefined
  let bound: Awaited<ReturnType<typeof f.client.observeConversation>> | undefined
  try {
    observer = await f.client.observeConversation(ref, () => {})
    expect(observer.scope.sources.filter(source => source.kind === 'native')).toEqual([{ kind: 'native', ...f.source }])
    const initial = await f.client.readAgentConversation(ref)
    expect(initial.scope).toEqual(observer.scope)
    expect(originals(complete(initial))).toEqual(['original'])
    bound = await f.client.observeConversation({ ...ref, view: initial.window.view! }, () => {})
    expect(bound.scope).toEqual(initial.scope)
    observer.dispose()
    expect(bound.closed.aborted).toBe(false)
    expect(f.released).not.toHaveBeenCalled()
    expect(f.observe).toHaveBeenCalledOnce(); expect(f.discover).toHaveBeenCalledOnce()
    expect(f.input).not.toHaveBeenCalled()
    expect(f.client.agentSession(ref.agentSessionId).run).toEqual(f.retained.run)
    expect(f.client.agentSession(ref.agentSessionId).nativeHandle).toEqual(f.retained.nativeHandle)
    expect(await f.store.loadMetadata()).toEqual(metadata)
    bound.dispose()
    expect(f.released).toHaveBeenCalledOnce()
    // Once this original consumer releases its resource, ordinary saved reads
    // have no operation-local current witness to borrow and never probe Runtime.
    const saved = await f.client.readAgentConversation(ref)
    expect(originals(complete(saved))).toEqual(['old'])
    expect(f.discover).toHaveBeenCalledOnce()
  } finally { bound?.dispose(); observer?.dispose(); await f.close() }
})

it('an accepted original view never advertises a healthy native watch for a different discovered source', async () => {
  const f = await transientHistoryFixture()
  const metadata = await f.store.loadMetadata()
  const ref = { hostId: 'local', agentSessionId: f.retained.agentSessionId }
  let observer: Awaited<ReturnType<typeof f.client.observeConversation>> | undefined
  try {
    const initial = await f.client.readAgentConversation(ref)
    expect(originals(complete(initial))).toEqual(['old'])
    expect(f.discover).not.toHaveBeenCalled()
    expect(f.kernel.status).not.toHaveBeenCalled()
    observer = await f.client.observeConversation({ ...ref, view: initial.window.view! }, () => {})
    expect(observer.scope).toEqual(initial.scope)
    expect(f.observe).toHaveBeenCalledOnce()
    const observedSource = f.observe.mock.calls[0]![0].source
    const native = initial.scope.sources.find(source => source.kind === 'native')!
    expect(native.kind).toBe('native')
    if (native.kind !== 'native') throw new Error('The retained fixture has an original native source')
    const sameSource = native.providerId === observedSource.providerId && native.nativeSessionId === observedSource.nativeSessionId
    const coverage = observer.coverage.find(value => value.source.kind === 'native' &&
      value.source.providerId === native.providerId && value.source.nativeSessionId === native.nativeSessionId)
    const sourceMismatchExposed = coverage?.current === 'unavailable' &&
      coverage.gaps.some(gap => gap.code === 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    expect(sameSource || sourceMismatchExposed, JSON.stringify({ native, observedSource, coverage })).toBe(true)
    expect(f.client.agentSession(ref.agentSessionId).run).toEqual(f.retained.run)
    expect(f.client.agentSession(ref.agentSessionId).nativeHandle).toEqual(f.retained.nativeHandle)
    expect(f.input).not.toHaveBeenCalled()
    expect(await f.store.loadMetadata()).toEqual(metadata)
  } finally { observer?.dispose(); await f.close() }
})

it('an active current witness cannot redirect an accepted view, signed replay, exact record, or original changes cut', async () => {
  const f = await transientHistoryFixture()
  const metadata = await f.store.loadMetadata()
  const ref = { hostId: 'local', agentSessionId: f.retained.agentSessionId }
  let observer: Awaited<ReturnType<typeof f.client.observeConversation>> | undefined
  try {
    const saved = await f.client.readAgentConversation(ref)
    const accepted = complete(saved), oldRecord = accepted.units[0]!.records[0]!.reference
    expect(originals(accepted)).toEqual(['old'])
    expect(f.discover).not.toHaveBeenCalled()
    expect(f.kernel.status).not.toHaveBeenCalled()
    observer = await f.client.observeConversation(ref, () => {})
    expect(observer.scope.sources.filter(source => source.kind === 'native')).toEqual([{ kind: 'native', ...f.source }])
    for (const selection of [{ view: saved.window.view! }, { cursor: saved.window.replay }, { record: oldRecord },
      { nativeSource: { providerId: 'claude', nativeSessionId: 'retained-old' } }]) {
      const original = await f.client.readAgentConversation({ ...ref, ...selection })
      expect(original.scope).toEqual(saved.scope)
      expect(originals(complete(original))).toEqual(['old'])
    }
    const unchanged = await f.client.readConversationChanges({ ...ref, view: saved.window.view!, checkpoint: saved.window.checkpoint })
    expect(unchanged.scope).toEqual(saved.scope)
    expect(originals(complete(unchanged))).toEqual(['old'])
    expect(observer.closed.aborted).toBe(false)
    expect(f.observe).toHaveBeenCalledOnce(); expect(f.discover).toHaveBeenCalledOnce()
    expect(f.released).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
    expect(f.client.agentSession(ref.agentSessionId).run).toEqual(f.retained.run)
    expect(f.client.agentSession(ref.agentSessionId).nativeHandle).toEqual(f.retained.nativeHandle)
    expect(await f.store.loadMetadata()).toEqual(metadata)
  } finally { observer?.dispose(); await f.close() }
})

it('cancelling a fresh current watch releases its eventual original handle and allows a new observer without retaining its witness', async () => {
  const f = await transientHistoryFixture()
  const metadata = await f.store.loadMetadata()
  const ref = { hostId: 'local', agentSessionId: f.retained.agentSessionId }
  const originalObserve = f.observe.getMockImplementation()!
  let releaseOpening!: () => void
  const opening = new Promise<void>(resolve => { releaseOpening = resolve })
  f.observe.mockImplementationOnce(async context => {
    const handle = await originalObserve(context)
    await opening
    return handle
  })
  const controller = new AbortController(), cancellation = new Error('Original current consumer cancelled')
  let observer: Awaited<ReturnType<typeof f.client.observeConversation>> | undefined
  try {
    const pending = f.client.observeConversation(ref, () => {}, { signal: controller.signal })
    const cancelled = expect(pending).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_CANCELLED' })
    await vi.waitFor(() => expect(f.observe).toHaveBeenCalledOnce())
    controller.abort(cancellation)
    await cancelled
    expect(f.released).not.toHaveBeenCalled()
    releaseOpening()
    await vi.waitFor(() => expect(f.released).toHaveBeenCalledOnce())
    const saved = await f.client.readAgentConversation(ref)
    expect(originals(complete(saved))).toEqual(['old'])
    expect(f.discover).toHaveBeenCalledOnce()
    observer = await f.client.observeConversation(ref, () => {})
    const current = await f.client.readAgentConversation(ref)
    expect(current.scope).toEqual(observer.scope)
    expect(originals(complete(current))).toEqual(['original'])
    expect(observer.closed.aborted).toBe(false)
    expect(f.observe).toHaveBeenCalledTimes(2); expect(f.discover).toHaveBeenCalledTimes(2)
    expect(f.released).toHaveBeenCalledOnce(); expect(f.input).not.toHaveBeenCalled()
    expect(f.client.agentSession(ref.agentSessionId).run).toEqual(f.retained.run)
    expect(f.client.agentSession(ref.agentSessionId).nativeHandle).toEqual(f.retained.nativeHandle)
    expect(await f.store.loadMetadata()).toEqual(metadata)
  } finally { controller.abort(cancellation); releaseOpening(); observer?.dispose(); await f.close() }
})

it('uncertain current native qualification preserves the independent captured page and exact captured record', async () => {
  const f = await transientHistoryFixture()
  const metadata = await f.store.loadMetadata()
  const ref = { hostId: 'local', agentSessionId: f.retained.agentSessionId }
  const captured = { id: 'independent-captured', agentSessionId: ref.agentSessionId, kind: 'assistant_message' as const,
    source: 'native-hook' as const, status: 'complete' as const, title: 'Original captured reply',
    content: 'Independent captured content remains readable.', createdAt: 1, updatedAt: 1 }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: captured })
  let observer: Awaited<ReturnType<typeof f.client.observeConversation>> | undefined
  try {
    observer = await f.client.observeConversation(ref, () => {})
    f.fail('witness')
    const page = await f.client.readAgentConversation(ref)
    const snapshot = complete(page), record = snapshot.units.flatMap(unit => unit.records).find(record => record.original.kind === 'captured')
    expect(record?.original.item).toEqual(captured)
    // A single failed checkpoint can recover at the same-page original read.
    // Sustained native uncertainty must stay local to that independent source.
    f.witness.mockRejectedValue(new AgentMuxError('Private current witness is busy', 'AGENT_SESSION_STORE_BUSY'))
    const unavailable = await f.client.readAgentConversation(ref)
    expect(complete(unavailable).units.flatMap(unit => unit.records).find(record => record.original.kind === 'captured')?.original.item).toEqual(captured)
    expect(unavailable.coverage.find(coverage => coverage.source.kind === 'native')).toMatchObject({
      current: 'unavailable', gaps: [{ code: 'AGENT_SESSION_STORE_BUSY' }] })
    if (!record) throw new Error('The independent original captured record must remain in the complete public frame')
    const exact = await f.client.readAgentConversation({ ...ref, record: record.reference })
    expect(originals(complete(exact))).toEqual([captured.id])
    expect(observer.closed.aborted).toBe(false)
    expect(f.observe).toHaveBeenCalledOnce(); expect(f.discover).toHaveBeenCalledOnce()
    expect(f.released).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
    expect(f.client.agentSession(ref.agentSessionId).run).toEqual(f.retained.run)
    expect(f.client.agentSession(ref.agentSessionId).nativeHandle).toEqual(f.retained.nativeHandle)
    expect(await f.store.loadMetadata()).toEqual(metadata)
  } finally { observer?.dispose(); await f.close() }
})
