import { appendFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'
import { projectConversationTimeline, consumeJsonReadEntry, parseConversationUnit, type ConversationUnit, type JsonReadAssembly,
  type ConversationTimelineReadInput, type AgentConversationReadPage } from '../src/conversation.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { AgentMuxError } from '../src/errors.js'
import { forwardConversationPage, forwardConversationInput } from '../src/conversation-reader.js'
import { parseConversationReadPage, consumeConversationWindowPage, type ConversationWindowAssembly } from '../src/conversation-changes.js'
import { conversationRevision, conversationRecordId } from '../src/conversation-stream.js'
import { projectConversationReading, conversationItemRef, parseAgentSessionHistoryReadPage } from '../src/conversation.js'
import { savedQuestionFixture, savedQuestionEvent, savedQuestionReply, savedQuestionId } from './helpers/codex-saved-question.js'
import { unifiedConversationOriginals } from './helpers/conversation-unified-originals.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import type { AgentTimelineMutation, AgentMuxEvidence } from '../src/types.js'
import type { AgentTimelineItem } from '../src/types.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxClient } from '../src/client.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const ref = { hostId: 'local', agentSessionId: 'private-agent' }
const release: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of release.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const row = (id: string, at: number, text = id) => ({ uuid: id, type: 'assistant', sessionId: 'native-main',
  timestamp: new Date(at).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const captured = (id: string, at: number, content = id): AgentTimelineItem => ({ id, agentSessionId: ref.agentSessionId,
  kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Original reply observation', content, createdAt: at, updatedAt: at })
async function fixture(rows = [row('native', _historyFixtureEpoch(0, 0, 100))]) {
  const f = await nativeHistoryFixture('claude', jsonl(rows)); release.push(f.close)
  return f
}
async function collect(read: (input: ConversationTimelineReadInput) => Promise<AgentConversationReadPage>, input: ConversationTimelineReadInput = ref) {
  let units: readonly ConversationUnit[] = []
  const pages: AgentConversationReadPage[] = []
  let cursor: string | undefined = input.cursor, pending: ConversationWindowAssembly | undefined
  for (let i = 0; i < 200; i++) {
    const page = await read({ ...input, ...(cursor ? { cursor } : {}) }); pages.push(page)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(page.budgetBytes)
    const assembled = consumeConversationWindowPage(page, pending)
    if (assembled.kind === 'pending') pending = assembled.pending
    else { pending = undefined; units = assembled.snapshot.units }
    if (!page.nextCursor) { expect(pending).toBeUndefined(); return { units, pages } }
    expect(page.nextCursor).not.toBe(cursor); cursor = page.nextCursor
  }
  throw new Error('Conversation traversal failed to make bounded progress')
}

it('the backend Reader retains every accepted contribution when an exact event crosses three source batches', async () => {
  const originalText = 'Complete original native contribution. '.repeat(400)
  const f = await fixture([row('n1', _historyFixtureEpoch(0, 0, 100), originalText), row('n2', _historyFixtureEpoch(0, 0, 200))])
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: {
    ...captured('s1', _historyFixtureEpoch(0, 0, 300)), conversation: { sameEvent: { ...ref, source: {
      kind: 'native', providerId: 'claude', nativeSessionId: 'native-main', recordId: 'n1'
    } } }
  } })
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] }); release.push(() => service.dispose())
  let acceptedEvents: unknown
  for (const read of [input => f.client.readAgentConversation(input), input => service.call('agent.conversation.inspect', input)] as Array<(input: ConversationTimelineReadInput) => Promise<AgentConversationReadPage>>) {
    for (const budget of [{ limit: 1 }, { limit: 30 }, { limit: 1, maxBytes: 16 * 1024 }]) {
      const result = await collect(read, { ...ref, ...budget })
      const original = result.units.filter(unit => unit.records.some(record => record.original.item.id === 'n1')).at(-1)!
      expect(original.records.map(record => record.original.item.id).sort()).toEqual(['n1', 's1'])
      expect(original.records.find(record => record.original.item.id === 'n1')!.original).toMatchObject({ item: { contentParts: [{ kind: 'text', text: originalText }] } })
      expect(new Set(result.units.map(unit => unit.event.id)).size).toBe(2)
      const events = result.units.map(unit => unit.event)
      if (acceptedEvents === undefined) acceptedEvents = events
      else expect(events).toEqual(acceptedEvents)
      if (budget.maxBytes) expect(result.pages.some(page => page.items.some(entry => entry.kind === 'fragment'))).toBe(true)
    }
  }
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
})

it('one backend window replaces late relationships through its original cut and rejects another epoch before comparing revisions', async () => {
  const f = await fixture(), original = captured('late-submission', _historyFixtureEpoch(0, 0, 300))
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: original })
  const opened = await collect(input => f.client.readAgentConversation(input)), before = opened.pages.at(-1)!
  expect(opened.units).toHaveLength(2)
  await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: ref.agentSessionId, item: { ...original, updatedAt: _historyFixtureEpoch(0, 0, 400),
    conversation: { sameEvent: { ...ref, source: { kind: 'native', providerId: 'claude', nativeSessionId: 'native-main', recordId: 'native' } } } } })
  const changed = await f.client.readConversationChanges({ ...ref, checkpoint: before.window.checkpoint, view: before.window.view! })
  const assembled = consumeConversationWindowPage(changed)
  expect(assembled.kind).toBe('complete')
  if (assembled.kind !== 'complete') throw Error('Expected one bounded complete replacement')
  expect(assembled.snapshot.units).toHaveLength(1)
  expect(assembled.snapshot.units[0]!.records.map(record => record.original.item.id).sort()).toEqual(['late-submission', 'native'])
  expect(changed.window).toMatchObject({ id: before.window.id, revision: before.window.revision + 1, complete: true })
  const other = await fixture(), foreign = await other.client.conversationCheckpoint(ref)
  expect(foreign.checkpoint.frontier.scope).not.toEqual(before.scope)
  await expect(f.client.readConversationChanges({ ...ref, checkpoint: foreign.checkpoint, view: changed.window.view! })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  const stillReadable = await f.client.readConversationChanges({ ...ref, checkpoint: changed.checkpoint, view: changed.window.view! })
  expect(consumeConversationWindowPage(stillReadable)).toMatchObject({ kind: 'complete', snapshot: { units: [expect.objectContaining({ records: expect.any(Array) })] } })
  expect(f.controls.every(control => !control.mock.calls.length) && other.controls.every(control => !control.mock.calls.length)).toBe(true)
})

it('window assembly rejects duplicate contributions, missing inventory and foreign revisions without replacing the displayed snapshot', async () => {
  const f = await fixture(), page = await f.client.readAgentConversation(ref)
  const original = consumeConversationWindowPage(page)
  expect(original.kind).toBe('complete')
  expect(() => consumeConversationWindowPage({ ...page, items: [...page.items, ...page.items], window: { ...page.window, itemCount: 2 } })).toThrow()
  expect(() => consumeConversationWindowPage({ ...page, items: [] })).toThrow()
  const pending = consumeConversationWindowPage({ ...page, window: { ...page.window, complete: false, view: null }, nextCursor: 'exact-pending-page' })
  expect(pending.kind).toBe('pending')
  if (pending.kind !== 'pending') throw Error('Expected wire-only pending assembly')
  expect(() => consumeConversationWindowPage({ ...page, items: [], window: { ...page.window, revision: page.window.revision + 1 } }, pending.pending)).toThrow()
  const wrong = structuredClone(page)
  wrong.window.checkpoint.frontier.scope.sources = [{ kind: 'captured', epoch: 'another-source' }]
  expect(() => parseConversationReadPage(wrong, ref)).toThrow()
  const wrongHost = structuredClone(page)
  wrongHost.window.checkpoint.sourceHostId = 'another-original-host'
  wrongHost.window.checkpoint.frontier.hostId = 'another-original-host'
  expect(() => parseConversationReadPage(wrongHost, ref)).toThrow()
  const cancelled = new AbortController(); cancelled.abort(new Error('Only this consumer was cancelled'))
  await expect(f.client.readConversationChanges({ ...ref, checkpoint: page.window.checkpoint, view: page.window.view! }, { signal: cancelled.signal })).rejects.toThrow('Only this consumer')
  const resumed = await f.client.readConversationChanges({ ...ref, checkpoint: page.window.checkpoint, view: page.window.view! })
  expect(consumeConversationWindowPage(resumed)).toMatchObject({ kind: 'complete' })
  expect(original).toMatchObject({ kind: 'complete', snapshot: { window: { id: page.window.id, revision: page.window.revision } } })
})

it('a watched exact view survives unrelated reads, unsubscribe parks it, and explicit release frees only its temporary window', async () => {
  const f = await fixture(), page = await f.client.readAgentConversation(ref)
  const watch = await f.client.observeConversation({ ...ref, view: page.window.view! }, () => {})
  for (let count = 0; count < 24; count++) await f.client.readAgentConversation(ref)
  const observedRead = f.client.readConversationChanges({ ...ref, checkpoint: page.window.checkpoint, view: page.window.view! })
  await expect(observedRead).resolves.toMatchObject({ window: { id: page.window.id } })
  const current = await observedRead
  watch.dispose()
  await expect(f.client.readAgentConversation({ ...ref, view: current.window.view! })).resolves.toMatchObject({ window: { id: page.window.id } })
  expect(await f.client.releaseConversationView({ ...ref, view: current.window.view! })).toMatchObject({ viewId: page.window.id, released: true })
  await expect(f.client.readConversationChanges({ ...ref, checkpoint: current.checkpoint, view: current.window.view! })).rejects.toMatchObject({ code: 'AGENT_CONVERSATION_VIEW_EXPIRED' })
  expect(await f.client.releaseConversationView({ ...ref, view: current.window.view! })).toMatchObject({ viewId: page.window.id, released: false })
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] }); release.push(() => service.dispose())
  const another = await service.call('agent.conversation.inspect', ref)
  const released = await service.call('agent.conversation.release', { ...ref, view: another.window.view! })
  expect(released).toMatchObject({ viewId: another.window.id, released: true })
  expect(parseRpcNativeResult('agent.conversation.release', released, { ...ref, view: another.window.view! })).toEqual(released)
  expect((await f.client.readAgentConversation(ref)).items).toHaveLength(1)
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
})

it('a repeated source operation and its route-budget replay return the same frozen replacement revision', async () => {
  const f = await fixture(), service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] }); release.push(() => service.dispose())
  const opened = await service.call('agent.conversation.inspect', ref)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: captured('new-original', _historyFixtureEpoch(0, 0, 400)) })
  const input = { ...ref, checkpoint: opened.window.checkpoint, view: opened.window.view!, maxBytes: 32 * 1024 }
  const first = await service.call('agent.conversation.changes', input)
  const repeat = await service.call('agent.conversation.changes', input)
  expect(repeat).toEqual(first)
  const replay = await service.call('agent.conversation.changes', { ...input, cursor: first.window.replay, maxBytes: 16 * 1024 })
  expect(replay.window).toEqual(first.window)
  expect(replay.items).toEqual(first.items)
})

it('the original native page cut prevents an overlapping changes prefix from replacing its newer accepted version', async () => {
  const f = await fixture(), checkpoint = f.client.sessionHistoryCheckpoint.bind(f.client)
  vi.spyOn(f.client, 'sessionHistoryCheckpoint').mockImplementationOnce(async (...args) => {
    const before = await checkpoint(...args)
    await appendFile(f.path, jsonl([row('overlapping', _historyFixtureEpoch(0, 0, 200), 'intermediate version'), row('overlapping', _historyFixtureEpoch(0, 0, 300), 'accepted newest version')]))
    return before
  })
  const page = await f.client.readAgentConversation({ ...ref, limit: 1 })
  expect(page.items[0]).toMatchObject({ kind: 'item', item: { records: [{ original: { item: { contentParts: [{ text: 'accepted newest version' }] } } }] } })
  const changes = await f.client.readConversationChanges({ ...ref, limit: 1, checkpoint: page.window.checkpoint, view: page.window.view! })
  expect(changes.items[0]).toMatchObject({ kind: 'item', item: { records: [{ original: { item: { contentParts: [{ text: 'accepted newest version' }] } } }] } })
  expect(changes.more).toBe(false)
  await appendFile(f.path, jsonl([row('overlapping', _historyFixtureEpoch(0, 0, 400), 'later native version')]))
  const later = await f.client.readConversationChanges({ ...ref, limit: 1, checkpoint: changes.checkpoint, view: changes.window.view! })
  expect(later.items[0]).toMatchObject({ kind: 'item', item: { records: [{ original: { item: { contentParts: [{ text: 'later native version' }] } } }] } })
})

it('the saved canonical Provider shares the same exact page-to-changes cut under a concurrent append', async () => {
  const f = await savedQuestionFixture([], { unifiedCapturedRead: true }); release.push(f.close)
  const reference = { hostId: 'local', agentSessionId: f.session.agentSessionId }, checkpoint = f.client.sessionHistoryCheckpoint.bind(f.client)
  const native = (text: string) => ({ type: 'response_item', payload: { type: 'message', id: 'overlapping', role: 'assistant', content: [{ type: 'output_text', text }] } })
  vi.spyOn(f.client, 'sessionHistoryCheckpoint').mockImplementationOnce(async (...args) => {
    const before = await checkpoint(...args)
    await appendFile(f.transcriptPath, jsonl([native('intermediate version'), native('accepted newest version')]))
    return before
  })
  const page = await f.client.readAgentConversation({ ...reference, limit: 1 })
  const changes = await f.client.readConversationChanges({ ...reference, limit: 1, checkpoint: page.window.checkpoint, view: page.window.view! })
  expect(changes.items[0]).toMatchObject({ kind: 'item', item: { records: [{ original: { item: { contentParts: [{ text: 'accepted newest version' }] } } }] } })
  expect(changes.more).toBe(false)
})

it('a Provider without a page cut preserves its original readable window and reports the changes join as unknown', async () => {
  const f = await fixture(), original = f.client.sessionHistoryPage.bind(f.client)
  vi.spyOn(f.client, 'sessionHistoryPage').mockImplementation(async (...args) => { const { changesCursor: _unestablished, ...page } = await original(...args); return page })
  const page = await f.client.readAgentConversation(ref)
  expect(page.items).toHaveLength(1)
  expect(page.window.checkpoint.frontier.cuts.every(cut => cut.kind !== 'native')).toBe(true)
  expect(page.coverage.flatMap(source => source.gaps)).toContainEqual(expect.objectContaining({ code: 'AGENT_CONVERSATION_READ_CUT_UNAVAILABLE' }))
  const current = await f.client.readConversationChanges({ ...ref, checkpoint: page.window.checkpoint, view: page.window.view! })
  expect(current.items).toEqual(page.items)
  expect(current.coverage.find(source => source.source.kind === 'native')?.current).toBe('unsupported')
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
})

it('a bounded source window traverses cumulative history beyond its retained inventory and keeps original page order and evicted anchors', async () => {
  const rows = Array.from({ length: 1205 }, (_, index) => row('ordered-' + index, _historyFixtureEpoch(0, 2, 0) - index))
  const f = await fixture(rows), nativePages = vi.spyOn(f.client, 'sessionHistoryPage')
  const result = await collect(input => f.client.readAgentConversation(input), { ...ref, limit: 100, maxBytes: 1024 * 1024 })
  expect(result.units).toHaveLength(1200)
  expect(result.units.map(unit => unit.records[0]!.original.item.id)).toEqual(rows.slice(0, 1200).reverse().map(item => item.uuid))
  expect(result.pages.every(page => page.window.itemCount <= 1200)).toBe(true)
  expect(nativePages).toHaveBeenCalledTimes(13)
  expect(result.pages.length).toBeLessThan(110)
  const last = result.pages.at(-1)!, outside = last.window.outside.newer!
  expect(outside.record.source.recordId).toBe('ordered-1200')
  const original = await f.client.readAgentConversation({ ...ref, anchor: { ...outside, frontier: last.window.checkpoint } })
  expect(original.items[0]).toMatchObject({ kind: 'item', item: { records: [{ original: { item: { id: 'ordered-1200' } } }] } })
  const witnesses = result.units.map(unit => unit.records[0]!.order)
  expect(witnesses.every(order => order.kind === 'native-page' && !!order.pageWitness)).toBe(true)
  expect(new Set(witnesses.map(order => order.kind === 'native-page' && order.pageWitness)).size).toBe(13)
}, 30_000)

it('the accepted byte window evicts complete events before projection and keeps the exact displaced original readable', async () => {
  const f = await fixture([]), store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, f.session)
  const client = new AgentMuxClient({ store }); release.push(() => client.dispose())
  const body = 'x'.repeat(120 * 1024)
  for (let index = 0; index < 280; index++) await store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: captured('large-' + index, index, body) })
  const result = await collect(input => client.readAgentConversation(input), { ...ref, limit: 100, maxBytes: 4 * 1024 * 1024 })
  const last = result.pages.at(-1)!
  expect(result.units.length).toBeGreaterThan(200); expect(result.units.length).toBeLessThan(280)
  expect(Buffer.byteLength(JSON.stringify(result.units))).toBeLessThanOrEqual(32 * 1024 * 1024)
  expect(last.window.outside.newer).not.toBeNull()
  const anchor = { ...last.window.outside.newer!, frontier: last.window.checkpoint }
  const located = await client.readAgentConversation({ ...ref, anchor, maxBytes: 1024 * 1024 })
  const read = consumeConversationWindowPage(located)
  expect(read).toMatchObject({ kind: 'complete', snapshot: { units: [{ records: [{ reference: anchor.record, original: { item: { content: body } } }] }] } })
}, 30_000)

it('actual SDK and public RPC preserve source order with one tail policy, independently of wire page limits', async () => {
  const f = await fixture([row('older-native', _historyFixtureEpoch(0, 0, 200)), row('n100', _historyFixtureEpoch(0, 0, 100)), row('n1', _historyFixtureEpoch(0, 0, 1))])
  for (const item of [captured('older-captured', _historyFixtureEpoch(0, 0, 20)), captured('c50', _historyFixtureEpoch(0, 0, 50))]) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item })
  const native = await f.client.sessionHistoryPage(ref.agentSessionId), timeline = await f.client.sessionTimeline(ref.agentSessionId)
  const pure = projectConversationTimeline({ ...ref, executionHostId: ref.hostId, historyPage: native, timeline })
  expect(pure.events.map(event => event.reference!.source.recordId)).toEqual(['older-native', 'n100', 'n1', 'older-captured', 'c50'])
  const expected = pure.events.map(e => e.id)
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] }); release.push(() => service.dispose())
  for (const limit of [1, 100]) {
    const result = await collect(input => service.call('agent.conversation.inspect', input) as Promise<AgentConversationReadPage>, { ...ref, limit })
    expect(result.units.map(unit => unit.event.id).reverse()).toEqual(expected)
    expect(result.units.flatMap(unit => unit.records.map(record => record.original.item.id)).sort()).toEqual(['c50', 'n1', 'n100', 'older-captured', 'older-native'].sort())
    expect(result.units.find(unit => unit.records[0]?.original.item.id === 'c50')!.event.role).toBe('observation')
    expect(result.pages.every(page => page.order.direction === 'newest-first')).toBe(true)
  }
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
})

it('a native source without an accepted ID remains unavailable and never hides captured records or enters a cut', async () => {
  const f = await fixture(), original = await f.store.readMetadata(ref.agentSessionId)
  const withoutNative = { ...original! }; delete withoutNative.nativeHandle
  await f.store.compareAndSwap(original, withoutNative)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: captured('only-captured', _historyFixtureEpoch(0, 0, 10)) })
  const result = await collect(input => f.client.readAgentConversation(input))
  expect(result.units).toHaveLength(1)
  expect(result.units[0]!.records[0]!.original.item.id).toBe('only-captured')
  expect(result.pages[0]!.scope.sources).toContainEqual({ kind: 'native-unavailable', providerId: 'claude' })
  expect(result.pages[0]!.coverage.find(c => c.source.kind === 'native-unavailable')!.current).toBe('unavailable')
  const cut = await f.client.conversationCheckpoint(ref)
  expect(cut.checkpoint.frontier.cuts.map(c => c.kind)).toEqual(['captured'])
  await f.store.compareAndSwap(await f.store.readMetadata(ref.agentSessionId), original!)
  const changes = await f.client.readConversationChanges({ ...ref, checkpoint: cut.checkpoint })
  expect(changes.scope).toEqual(cut.scope)
  expect(changes.checkpoint.frontier.cuts.map(c => c.kind)).toEqual(['captured'])
})

it('future and foreign captured cuts fail this read instead of advancing from an empty range', async () => {
  const f = await fixture(), cut = await f.client.conversationCheckpoint(ref)
  const change = (field: object) => ({ ...cut.checkpoint, frontier: { ...cut.checkpoint.frontier, cuts: cut.checkpoint.frontier.cuts.map(c => c.kind === 'captured' ? { ...c, ...field } : c) } })
  await expect(f.client.readConversationChanges({ ...ref, checkpoint: change({ sequence: 9000 }) })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await expect(f.client.readConversationChanges({ ...ref, checkpoint: change({ epoch: 'foreign' }) })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect((await f.client.readConversationChanges({ ...ref, checkpoint: cut.checkpoint })).checkpoint).toEqual(cut.checkpoint)
})

it('a transient native failure retains its exact source retry position without an empty continuation loop', async () => {
  const f = await fixture([row('first', _historyFixtureEpoch(0, 0, 100)), row('last', _historyFixtureEpoch(0, 0, 200))])
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: captured('captured', _historyFixtureEpoch(0, 0, 300)) })
  const retained = join(f.root, 'retained.jsonl'); await rename(f.path, retained)
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] }); release.push(() => service.dispose())
  const page = await service.call('agent.conversation.inspect', ref)
  expect(page.items).toHaveLength(1)
  const gap = page.coverage.find(c => c.source.kind === 'native')!.gaps[0]!
  expect(gap.continuation).toBeTruthy()
  expect(page.nextCursor).toBeNull()
  await rename(retained, f.path)
  const retry = await collect(input => service.call('agent.conversation.inspect', input), { ...ref, cursor: gap.continuation! })
  expect(retry.units.map(unit => unit.records[0]!.original.item.id)).toEqual(['last', 'first'])
  expect(retry.pages.every(page => page.scope.sources.length === 1 && page.scope.sources[0]!.kind === 'native')).toBe(true)
})

it('complete unit fragments preserve all original Unicode bytes and hold changes cuts until assembly completes', async () => {
  const f = await fixture(), cut = await f.client.conversationCheckpoint(ref), body = ' original 中🙂\n'.repeat(1200)
  const original = row('large', _historyFixtureEpoch(0, 0, 300), body)
  original.message.content.push({ type: 'tool_use', id: 'fragmented-call', name: 'Read', input: { path: 'original' } } as never)
  await appendFile(f.path, jsonl([original]))
  const input = { ...ref, checkpoint: cut.checkpoint, maxBytes: 12 * 1024 }
  const first = await f.client.readConversationChanges(input)
  expect(first.items[0]?.kind).toBe('fragment'); expect(first.checkpoint).toEqual(cut.checkpoint)
  const units: ConversationUnit[] = []; let pending: JsonReadAssembly | undefined, page = first
  for (let i = 0; i < 100; i++) {
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(input.maxBytes)
    for (const entry of page.items) { const value = consumeJsonReadEntry({ entry, ...(pending ? { pending } : {}), scopeKey: JSON.stringify(cut.checkpoint), maxTotalBytes: 32 * 1024 * 1024 }); if (value.kind === 'pending') pending = value.pending; else { pending = undefined; units.push(parseConversationUnit(value.value, ref, page.scope)) } }
    if (!page.nextCursor) break
    page = await f.client.readConversationChanges({ ...input, cursor: page.nextCursor })
  }
  expect(pending).toBeUndefined(); expect(units).toHaveLength(1)
  expect(units[0]!.records[0]!.original).toMatchObject({ kind: 'native', item: { contentParts: [{ kind: 'text', text: body }, {kind:'tool-call',callId:'fragmented-call'}] } })
  expect(units[0]!.event.relations).toContainEqual(expect.objectContaining({kind:'invocation-member', part:expect.objectContaining({selector:{kind:'native-part',partIndex:1}})}))
  const projected = projectConversationTimeline({ ...ref, executionHostId: ref.hostId, historyPage: await f.client.sessionHistoryPage(ref.agentSessionId) })
  expect(units[0]!.event).toEqual(projected.events.find(event => event.reference?.source.recordId === 'large'))
  expect(page.checkpoint).not.toEqual(cut.checkpoint)
  expect((await f.client.readConversationChanges({ ...ref, checkpoint: page.checkpoint })).items).toEqual([])
})

it('real HTTP Hosted SDK and routed public RPC serialize every unit and fragment reference in one chosen Host namespace', async () => {
  const f = await fixture(), body = 'original routed 中🙂\n'.repeat(700)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: captured('remote-body', _historyFixtureEpoch(0, 0, 500), body) })
  vi.spyOn(f.client, 'connect').mockRejectedValue(new AgentMuxError('Private Runtime is offline; original reads remain available.', 'CTXMUX_DISCONNECTED'))
  const hostedOwner = new AgentMuxHostedRuntimeService(f.client, f.storePath, () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: null })); release.push(() => hostedOwner.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'hosted.sock'), hostedRuntime: () => hostedOwner,
    coreClients: () => [{ hostId: 'local', client: f.client }], http: { host: '127.0.0.1', port: 0, token: 'private-unified-test' } })
  await server.start(); release.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: `http://127.0.0.1:${server.httpAddress!.port}/`, token: 'private-unified-test' } }); release.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc }); release.push(() => hosted.dispose())
  const remote = { ...ref, hostId: 'retained-remote-route' }
  const routed = new AgentMuxRpcService({ coreClients: () => [{ hostId: remote.hostId, client: hosted }] }); release.push(() => routed.dispose())
  const cut = await routed.call('agent.conversation.checkpoint', remote)
  expect(cut.checkpoint.hostId).toBe(remote.hostId)
  const output = await collect(input => routed.call('agent.conversation.inspect', input), { ...remote, maxBytes: 12 * 1024 })
  expect(output.pages.some(page => page.items.some(entry => entry.kind === 'fragment'))).toBe(true)
  expect(output.units.flatMap(unit => unit.records).map(record => record.reference!.hostId)).toEqual(['local', 'local'])
  expect(output.pages.every(page => page.hostId === remote.hostId && page.sourceHostId === 'local')).toBe(true)
  expect(output.units.find(unit => unit.event.role === 'observation')!.records[0]!.original.item).toMatchObject({ content: body })
  expect(output.units.every(unit => unit.event.reference!.hostId === 'local')).toBe(true)
  await expect(routed.call('agent.conversation.inspect', { ...ref, hostId: 'unselected-host' })).rejects.toThrow()
  await expect(rpc.call('agent.conversation.inspect', { ...ref, referenceHostId: 'forged-host' } as never)).rejects.toThrow()
  const events: unknown[] = [], observer = await hosted.observeConversation(ref, event => events.push(event))
  await appendFile(f.path, jsonl([row('hosted-new', _historyFixtureEpoch(0, 0, 900))]))
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ ...ref, kind: 'invalidated', source: { kind: 'native', providerId: 'claude', nativeSessionId: 'native-main' } })))
  await expect(hosted.readAgentConversation(ref, { referenceHostId: 'forged-host' } as never)).rejects.toThrow()
  await expect(hosted.observeConversation(ref, () => {}, { referenceHostId: 'forged-host' } as never)).rejects.toThrow()
  const delta = await hosted.readConversationChanges({ ...ref, checkpoint: { ...cut.checkpoint, hostId: 'local' } })
  expect(delta.items[0]).toMatchObject({ kind: 'item', item: { records: [{ original: { item: { id: 'hosted-new' } } }] } })
  observer.dispose(); expect(observer.closed.aborted).toBe(true)
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
})

it('captured watch dispatch scopes original commits to its Session and cancellation releases only that reader', async () => {
  const f = await fixture(), a = vi.fn(), b = vi.fn()
  const otherId = 'other-retained-session'
  const otherSession = { ...f.session, agentSessionId: otherId, run: { runId: 'other-retained-run' } }; delete otherSession.nativeHandle
  await f.store.compareAndSwap(null, otherSession)
  const one = await f.client.observeConversation(ref, a), two = await f.client.observeConversation({ ...ref, agentSessionId: otherId }, b)
  const producer = f.client as unknown as { persistAndPublishTimeline(mutation: AgentTimelineMutation, evidence: AgentMuxEvidence): Promise<void> }
  const publish = (item: AgentTimelineItem) => producer.persistAndPublishTimeline({ type: 'append', agentSessionId: item.agentSessionId, item }, { source: 'native-hook', observedAt: item.updatedAt })
  await publish(captured('commit-one', _historyFixtureEpoch(0, 1, 0)))
  expect(a).toHaveBeenCalledOnce(); expect(b).not.toHaveBeenCalled()
  one.dispose(); a.mockClear()
  await publish(captured('commit-after-release', _historyFixtureEpoch(0, 1, 1)))
  expect(a).not.toHaveBeenCalled(); expect(b).not.toHaveBeenCalled()
  await publish({ ...captured('other-commit', _historyFixtureEpoch(0, 1, 2)), agentSessionId: otherId })
  expect(b).toHaveBeenCalledOnce(); expect(two.closed.aborted).toBe(false)
  expect((await f.client.readAgentConversation(ref)).items).not.toHaveLength(0)
  two.dispose(); expect(two.closed.aborted).toBe(true)
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
})

it('the original diagnostic context codec retains typed captured provenance and public content without admitting unknown fields', async () => {
  const f = await fixture(), item = { ...captured('typed-context', _historyFixtureEpoch(0, 1, 0)), kind: 'user_message' as const, source: 'user' as const, publicContent: 'confirmed' as const,
    authorHuman: true, conversation: { observes: { ...ref, source: { kind: 'native' as const, providerId: 'claude', nativeSessionId: 'native-main', recordId: 'native' } } } }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item })
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] }); release.push(() => service.dispose())
  const result = await service.call('agent.context', ref)
  const decoded = parseRpcNativeResult('agent.context', result, ref) as typeof result
  expect(decoded.captured!.items).toContainEqual(item)
  expect(decoded.captured).not.toHaveProperty('stream')
  const forged = structuredClone(result); (forged.captured!.items[0] as unknown as Record<string, unknown>).unrecognizedAuthority = 'forged'
  expect(() => parseRpcNativeResult('agent.context', forged, ref)).toThrow()
})

it('canonical question and recorded answer stay complete through public units with an honest unresolved request gap', async () => {
  const reply = savedQuestionReply(), second = { ...reply, payload: { ...reply.payload, id: 'second-original-answer-record' } }
  const f = await savedQuestionFixture([savedQuestionEvent(), reply, second], { unifiedCapturedRead: true }); release.push(f.close)
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] }); release.push(() => service.dispose())
  const all = await collect(value => service.call('agent.conversation.inspect', value), { ...input, limit: 1 })
  expect(all.units).toHaveLength(3)
  const localAnswers = all.units.flatMap(unit => unit.event.relations).filter(relation => relation.kind === 'answers')
  expect(localAnswers.map(relation => relation.from.source.recordId).sort()).toEqual(['original-answer-record', 'second-original-answer-record'])
  const request = all.units.find(unit => unit.event.role === 'interaction')!
  expect(request.records[0]!.original.item).toMatchObject({ questionRequest: { delivery: 'async', questions: [{ id: savedQuestionId }] } })
  const answer = all.units.find(unit => unit.records[0]!.original.kind === 'native' && unit.records[0]!.original.item.questionAnswers)!
  expect(answer.records[0]!.original.item).toMatchObject({ questionAnswers: [{ questionId: savedQuestionId, answer: 'Keep the original work' }] })
  expect(all.pages.flatMap(page => page.coverage.flatMap(c => c.gaps)).some(gap => gap.code === 'CONVERSATION_QUESTION_TARGET_UNREAD' && gap.record?.source.recordId === answer.records[0]!.original.item.id)).toBe(true)
  const loaded = projectConversationTimeline({ ...input, executionHostId: 'local', historyPage: await f.client.sessionHistoryPage(input.agentSessionId) })
  expect(loaded.events.flatMap(event => event.relations).filter(r => r.kind === 'answers')).toHaveLength(2)
  const byId = new Map(loaded.records.map(record => [record.id, record]))
  for (const event of loaded.events) {
    const unit = { event, records: event.recordIds.map(id => byId.get(id)!) }
    expect(parseConversationUnit(unit, input, loaded.scope).event).toEqual(event)
    const forged = structuredClone(unit), relation = forged.event.relations.find(value => value.kind === 'answers')
    if (!relation || relation.kind !== 'answers') continue
    const resign = (value: ConversationUnit) => {
      const { revision: _, ...changed } = value.event
      value.event.revision = conversationRevision({ policy: 1, versions: value.records.map(record => [record.id, record.revision]), event: changed })
      return value
    }
    for (const field of ['host', 'session', 'provider', 'native', 'question', 'from', 'missing', 'duplicate'] as const) {
      const candidate = structuredClone(unit), answer = candidate.event.relations.find(value => value.kind === 'answers')!
      if (answer.kind !== 'answers') throw Error('An original answer must retain its local relation')
      if (field === 'host') answer.question.hostId = 'other-host'
      if (field === 'session') answer.question.agentSessionId = 'other-session'
      if (field === 'provider') answer.question.source.providerId = 'other-provider'
      if (field === 'native') answer.question.source.nativeSessionId = 'other-native'
      if (field === 'question') answer.question.questionId = 'other-question'
      if (field === 'from') answer.from.source.recordId = request.records[0]!.original.item.id
      if (field === 'missing') candidate.event.relations = candidate.event.relations.filter(value => value.kind !== 'answers')
      if (field === 'duplicate') candidate.event.relations = [...candidate.event.relations, structuredClone(answer)]
      expect(() => parseConversationUnit(resign(candidate), input, loaded.scope), field).toThrow()
    }
    const targetOnly = { event: structuredClone(request.event), records: structuredClone(request.records) }
    targetOnly.event.relations = [structuredClone(relation)]
    expect(() => parseConversationUnit(resign(targetOnly), input, loaded.scope)).toThrow()
  }
})

it('real Claude invocation evidence preserves surrounding speech and exact part identities without promoting invocation membership to same-event', async () => {
  const original = unifiedConversationOriginals(), source = original.source
  const f = await nativeHistoryFixture('claude', jsonl([original.claudeTool]), { nativeSessionId: source.nativeSessionId }); release.push(f.close)
  const item = { ...original.capturedTool, agentSessionId: ref.agentSessionId }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item })
  const historyPage = await f.client.sessionHistoryPage(ref.agentSessionId), timeline = await f.client.sessionTimeline(ref.agentSessionId)
  const projected = projectConversationTimeline({ ...ref, executionHostId: ref.hostId, historyPage, timeline })
  expect(projected.events).toHaveLength(2)
  expect(projected.events.flatMap(e => e.relations).filter(r => r.kind === 'invocation-member')).toHaveLength(2)
  const originals = new Map(projected.records.map(record => [record.id, record]))
  for (const event of projected.events) {
    const unit = { event, records: event.recordIds.map(id => originals.get(id)!) }
    expect(parseConversationUnit(unit, ref, projected.scope).event).toEqual(event)
    for (const damage of ['missing', 'duplicate', 'call', 'host', 'session', 'provider', 'native-session', 'subject', 'turn', 'selector', 'revision', 'external-part', 'legacy-pair']) {
      const forged = structuredClone(unit), relation = forged.event.relations.find(value => value.kind === 'invocation-member')!
      if (relation.kind !== 'invocation-member') throw new Error('Original relation must name its invocation')
      if (damage === 'missing') forged.event.relations = forged.event.relations.filter(value => value !== relation)
      if (damage === 'duplicate') forged.event.relations = [...forged.event.relations, relation]
      if (damage === 'call') relation.invocation.callId = 'unrelated-invocation'
      if (damage === 'host') relation.invocation.hostId = 'foreign-host'
      if (damage === 'session') relation.invocation.agentSessionId = 'foreign-session'
      if (damage === 'provider') relation.invocation.source.providerId = 'foreign-provider'
      if (damage === 'native-session') relation.invocation.source.nativeSessionId = 'foreign-native'
      if (damage === 'subject') relation.invocation.subject = { kind: 'child', nativeActorId: 'other-child' }
      if (damage === 'turn') relation.invocation.scope = { kind: 'turn', nativeTurnId: 'other-turn' }
      if (damage === 'selector') relation.part.selector = { kind: 'native-part', partIndex: 0 }
      if (damage === 'revision') relation.part.recordRevision = '0'.repeat(64)
      if (damage === 'external-part') relation.part.record.source.recordId = 'not-in-unit'
      if (damage === 'legacy-pair') forged.event.relations = [{ kind: 'same-invocation', from: relation.part, to: relation.part, invocation: relation.invocation } as never]
      const { revision: _, ...changed } = forged.event
      forged.event.revision = conversationRevision({ policy: 1, versions: forged.records.map(record => [record.id, record.revision]), event: changed })
      expect(() => parseConversationUnit(forged, ref, projected.scope), damage).toThrow()
    }
  }
  expect(historyPage.items[0]!.contentParts[0]).toEqual({ kind: 'text', text: 'Original surrounding speech', contentEligibility: 'public' })
  const units = await collect(value => f.client.readAgentConversation(value))
  expect(units.units.flatMap(unit => unit.records).flatMap(record => record.original.kind === 'native' ? record.original.item.contentParts : [])).toEqual(historyPage.items[0]!.contentParts)
  expect(units.units.map(unit => unit.event.role).sort()).toEqual(['message', 'process'])
  expect(units.units.map(unit => unit.event).reverse()).toEqual(projected.events)
  const foreign = { ...item, conversation: { invocations: item.conversation.invocations.map(fact => ({ ...fact, invocation: { ...fact.invocation, callId: 'other-call' } })) } }
  expect(projectConversationTimeline({ ...ref, executionHostId: ref.hostId, historyPage, timeline: { ...timeline, items: [foreign] } }).events.flatMap(e => e.relations).filter(r => r.kind === 'invocation-member')).toHaveLength(2)
  const wrongNative = structuredClone(historyPage)
  wrongNative.items[0]!.conversation!.nativeInvocationScope!.source = { ...source, nativeSessionId: 'not-the-original-native-source' }
  const isolated = projectConversationTimeline({ ...ref, executionHostId: ref.hostId, historyPage: wrongNative })
  expect(isolated.events[0]!.relations).toEqual([])
  expect(isolated.records[0]!.original.item).toEqual(wrongNative.items[0])
  const forged = { event: structuredClone(isolated.events[0]!), records: isolated.records }
  const member = structuredClone(projected.events.flatMap(event => event.relations).find(relation => relation.kind === 'invocation-member' && relation.part.record.source.kind === 'native')!)
  if (member.kind !== 'invocation-member') throw Error('The original native membership must be present')
  member.part.recordRevision = isolated.records[0]!.revision
  member.invocation.source = wrongNative.items[0]!.conversation!.nativeInvocationScope!.source
  forged.event.relations = [member]
  const { revision: _old, ...changed } = forged.event
  forged.event.revision = conversationRevision({ policy: 1, versions: forged.records.map(record => [record.id, record.revision]), event: changed })
  expect(() => parseConversationUnit(forged, ref, isolated.scope)).toThrow()

})

it('strict observation links retain the original typed target even when an unrelated target has a recomputed event revision', async () => {
  const f = await fixture(), historyPage = await f.client.sessionHistoryPage(ref.agentSessionId)
  const target = { ...ref, source: { kind: 'native' as const, ...historyPage.source, recordId: historyPage.items[0]!.id } }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: { ...captured('observed', _historyFixtureEpoch(0, 0, 500)), conversation: { observes: target } } })
  const timeline = projectConversationTimeline({ ...ref, executionHostId: ref.hostId, historyPage, timeline: await f.client.sessionTimeline(ref.agentSessionId) })
  const byId = new Map(timeline.records.map(record => [record.id, record]))
  const native = timeline.events.find(event => event.reference?.source.kind === 'native')!
  expect(native).toEqual(projectConversationTimeline({ ...ref, executionHostId: ref.hostId, historyPage }).events[0])
  expect(native.relations.filter(relation => relation.kind === 'observes')).toEqual([])
  const observer = timeline.events.find(event => event.reference?.source.kind === 'captured')!
  const unit = { event: observer, records: observer.recordIds.map(id => byId.get(id)!) }
  expect(parseConversationUnit(unit, ref, timeline.scope).event).toEqual(observer)
  const resign = (value: ConversationUnit) => {
    const { revision: _, ...changed } = value.event
    value.event.revision = conversationRevision({ policy: 1, versions: value.records.map(record => [record.id, record.revision]), event: changed })
    return value
  }
  const incoming = { event: structuredClone(native), records: native.recordIds.map(id => byId.get(id)!) }
  incoming.event.relations = structuredClone(observer.relations)
  expect(() => parseConversationUnit(resign(incoming), ref, timeline.scope)).toThrow()
  for (const change of ['target', 'missing', 'duplicate'] as const) {
    const forged = structuredClone(unit), relation = forged.event.relations.find(value => value.kind === 'observes')!
    if (relation.kind !== 'observes' || !('recordId' in relation.target.source)) throw new Error('Original observation must name its exact source record')
    if (change === 'target') relation.target.source.recordId = 'unrelated-record'
    else if (change === 'missing') forged.event.relations = []
    else forged.event.relations = [...forged.event.relations, structuredClone(relation)]
    expect(() => parseConversationUnit(resign(forged), ref, timeline.scope)).toThrow()
  }
})

it('versioned anchors retain exact old captured bytes; malformed scope and changed native versions never substitute current content', async () => {
  const f = await fixture(), first = captured('versioned', _historyFixtureEpoch(0, 0, 400), 'original version')
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: first })
  const cut = await f.client.conversationCheckpoint(ref)
  await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: ref.agentSessionId, item: { ...first, updatedAt: _historyFixtureEpoch(0, 0, 500), content: 'newer version' } })
  const anchor = { record: { ...ref, source: { kind: 'captured' as const, recordId: first.id } }, revision: conversationRevision(first), frontier: cut.checkpoint }
  const result = await collect(value => f.client.readAgentConversation(value), { ...ref, anchor })
  expect(result.units[0]!.records[0]!.original.item).toMatchObject({ content: 'original version' })
  await expect(f.client.readAgentConversation({ ...ref, anchor: { ...anchor, record: { ...anchor.record, hostId: 'another-host' } } })).rejects.toThrow()
  const noVersion = await f.client.readAgentConversation({ ...ref, anchor: { ...anchor, revision: 'a'.repeat(64) } })
  expect(noVersion.items).toEqual([]); expect(noVersion.nextCursor).toBeNull()
  expect(noVersion.coverage.flatMap(c => c.gaps)).toContainEqual(expect.objectContaining({ code: 'AGENT_CONVERSATION_VERSION_UNAVAILABLE', record: anchor.record }))
})

it('strict unit validation rejects changed roles, omitted or reordered content, unknown fields, and forged relations even with a recomputed event revision', async () => {
  const f = await fixture(), page = await f.client.readAgentConversation(ref), entry = page.items[0]!
  if (entry.kind !== 'item') throw new Error('Small fixture must remain a complete unit')
  const rewrite = (change: (value: ConversationUnit) => void) => { const value = structuredClone(entry.item); change(value); const { revision: _, ...event } = value.event
    value.event.revision = conversationRevision({ policy: 1, versions: value.records.map(record => [record.id, record.revision]), event }); return value }
  expect(() => parseConversationUnit(rewrite(value => { value.event.role = 'interaction' }), ref, page.scope)).toThrow()
  expect(() => parseConversationUnit(rewrite(value => {
    const source = value.records[0]!.reference!.source
    const reference = { ...ref, source: { ...source, recordId: 'never-reported-canonical' } }
    value.event.reference = reference; value.event.id = conversationRecordId(reference); value.event.anchorId = value.event.id
  }), ref, page.scope)).toThrow()
  expect(() => parseConversationUnit(rewrite(value => { value.event.content = [] }), ref, page.scope)).toThrow()
  expect(() => parseConversationUnit(rewrite(value => { (value.records[0] as unknown as Record<string, unknown>).unexpected = 'authority' }), ref, page.scope)).toThrow()
  expect(() => parseConversationUnit(rewrite(value => { value.event.relations = [{ kind: 'same-event', from: value.records[0]!.reference!, to: value.records[0]!.reference! }] }), ref, page.scope)).toThrow()
  expect(() => parseConversationUnit(rewrite(value => {
    const source = value.records[0]!.reference!.source
    value.event.relations = [{ kind: 'same-event', from: { ...ref, source: { ...source, recordId: 'unrelated-from' } }, to: { ...ref, source: { ...source, recordId: 'unrelated-to' } } }]
  }), ref, page.scope)).toThrow()
  expect(() => parseConversationUnit(entry.item, { ...ref, hostId: 'foreign' }, page.scope)).toThrow()
})

it('strict canonical identity retains typed unread chains and original cycle fallback, while unrelated records cannot be coalesced', async () => {
  const f = await fixture(), page = await f.client.sessionHistoryPage(ref.agentSessionId), source = page.source
  const target = (recordId: string) => ({ ...ref, source: { kind: 'native' as const, ...source, recordId } })
  const middle = { ...page.items[0]!, id: 'middle', conversation: { sameEvent: target('unread-canonical') } }
  const observed = { ...captured('canonical-contribution', _historyFixtureEpoch(0, 0, 500)), conversation: { sameEvent: target('middle') } }
  const timeline = projectConversationTimeline({ ...ref, executionHostId: ref.hostId, historyPage: { ...page, items: [middle] },
    timeline: { agentSessionId: ref.agentSessionId, revision: 1, items: [observed], stream: { epoch: 'test-epoch', sequence: 1, revision: 1, origin: 'beginning', gaps: [], positions: [{ id: observed.id, firstSequence: 1, sequence: 1, revision: conversationRevision(observed) }] } } })
  expect(timeline.events).toHaveLength(1)
  expect(timeline.events[0]!.reference).toEqual(target('unread-canonical'))
  expect(parseConversationUnit({ event: timeline.events[0]!, records: timeline.records }, ref, timeline.scope).event).toEqual(timeline.events[0])
  const wrongCoalesce = structuredClone({ event: timeline.events[0]!, records: timeline.records })
  wrongCoalesce.event.coalesces![0]!.fromEventIds = [wrongCoalesce.records.find(record => record.id !== wrongCoalesce.event.coalesces![0]!.fromEventIds[0])!.id]
  const { revision: _coalesced, ...coalescedEvent } = wrongCoalesce.event
  wrongCoalesce.event.revision = conversationRevision({ policy: 1, versions: wrongCoalesce.records.map(record => [record.id, record.revision]), event: coalescedEvent })
  expect(() => parseConversationUnit(wrongCoalesce, ref, timeline.scope)).toThrow()
  const cyclic = projectConversationTimeline({ ...ref, executionHostId: ref.hostId, historyPage: { ...page, items: [
    { ...page.items[0]!, id: 'cycle-a', conversation: { sameEvent: target('cycle-b') } },
    { ...page.items[0]!, id: 'cycle-b', conversation: { sameEvent: target('cycle-a') } }
  ] } })
  const byId = new Map(cyclic.records.map(record => [record.id, record]))
  for (const event of cyclic.events) expect(parseConversationUnit({ event, records: event.recordIds.map(id => byId.get(id)!) }, ref, cyclic.scope).event).toEqual(event)
  const independent = projectConversationTimeline({ ...ref, executionHostId: ref.hostId, historyPage: { ...page, items: [page.items[0]!, { ...page.items[0]!, id: 'independent' }] } })
  const joined = structuredClone({ event: independent.events[0]!, records: independent.records })
  joined.event.recordIds = joined.records.map(record => record.id)
  joined.event.content = joined.records.flatMap((record, n) => record.original.kind === 'native' ? record.original.item.contentParts.map((_, partIndex) => ({ recordId: record.id, recordRevision: record.revision, selector: { kind: 'native-part' as const, partIndex }, placement: n === 0 ? 'body' as const : 'detail' as const })) : [])
  const { revision: _, ...event } = joined.event
  joined.event.revision = conversationRevision({ policy: 1, versions: joined.records.map(record => [record.id, record.revision]), event })
  expect(() => parseConversationUnit(joined, ref, independent.scope)).toThrow()
})

it('route-scoped checkpoint, anchor and signed continuation cannot move between two selected Hosts with identical source facts', async () => {
  const f = await fixture(), body = 'Original scoped body 中🙂\n'.repeat(1000)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: captured('scoped-body', _historyFixtureEpoch(0, 0, 500), body) })
  const routeA = { ...ref, hostId: 'route-a-' + 'a'.repeat(400) }, routeB = { ...ref, hostId: 'route-b' }
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: routeA.hostId, client: f.client }, { hostId: routeB.hostId, client: f.client }] }); release.push(() => service.dispose())
  const cut = await service.call('agent.conversation.checkpoint', routeA)
  expect(cut.checkpoint).toMatchObject({ ...routeA, sourceHostId: 'local', frontier: { ...ref } })
  await expect(service.call('agent.conversation.changes', { ...routeB, checkpoint: cut.checkpoint })).rejects.toThrow()
  const original = (await f.store.readCapturedHistory(ref.agentSessionId, { limit: 1 })).records[0]!
  const anchor = { record: { ...ref, source: { kind: 'captured' as const, recordId: original.item.id } }, revision: original.revision, frontier: cut.checkpoint }
  await expect(service.call('agent.conversation.inspect', { ...routeB, anchor })).rejects.toThrow()
  const first = await service.call('agent.conversation.inspect', { ...routeA, maxBytes: 12 * 1024 })
  expect(first.items[0]?.kind).toBe('fragment'); expect(first.nextCursor).toBeTruthy()
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(12 * 1024)
  await expect(service.call('agent.conversation.inspect', { ...routeB, cursor: first.nextCursor! })).rejects.toThrow()
  const [encoded, signature] = first.nextCursor!.split('.'), cursor = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'))
  const forged = Buffer.from(JSON.stringify({ ...cursor, routeHostId: routeB.hostId })).toString('base64url') + '.' + signature
  await expect(service.call('agent.conversation.inspect', { ...routeB, cursor: forged })).rejects.toThrow()
  const all = await collect(input => service.call('agent.conversation.inspect', input), { ...routeA, maxBytes: 12 * 1024 })
  expect(all.units.find(unit => unit.event.role === 'observation')!.records[0]!.original.item).toMatchObject({ content: body })
  expect(all.pages.every(page => Buffer.byteLength(JSON.stringify(page)) <= 12 * 1024)).toBe(true)
  await expect(service.call('agent.conversation.inspect', { ...routeA, maxBytes: 4096 })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_BUDGET' })
  expect((await collect(input => service.call('agent.conversation.inspect', input), { ...routeA, maxBytes: 32 * 1024 })).units).toHaveLength(2)
})

it('the routed codec roundtrips a legal long opaque source cursor without truncation or rewriting', async () => {
  const f = await fixture(), original = await f.client.readAgentConversation(ref), cursor = 'opaque-original-'.repeat(1800)
  const source = { ...original, nextCursor: cursor, budgetBytes: 128 * 1024 }, input = { ...ref, hostId: 'remote-route', maxBytes: 128 * 1024 }
  const forwarded = forwardConversationPage(source, input)
  expect(forwarded.nextCursor!.length).toBeGreaterThan(32_768)
  const decoded = parseConversationReadPage(forwarded, input)
  expect(forwardConversationInput({ ...input, cursor: decoded.nextCursor! }).input.cursor).toBe(cursor)
  expect(decoded.items).toEqual(source.items)
})

it('the actual retained source namespace is stable across local and descriptor addressing and matches raw, public and presentation consumers', async () => {
  const f = await fixture(), sourceHostId = 'original-source-host', routeHostId = 'selected-client-route'
  const session = await f.store.readMetadata(ref.agentSessionId)
  await f.store.compareAndSwap(session, { ...session!, hostId: sourceHostId })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: captured('source-captured', _historyFixtureEpoch(0, 0, 500)) })
  const direct = await collect(value => f.client.readAgentConversation(value)), named = await collect(value => f.client.readAgentConversation(value), { ...ref, hostId: sourceHostId })
  expect(direct.units.map(unit => unit.event)).toEqual(named.units.map(unit => unit.event))
  expect(direct.pages.every(page => page.hostId === 'local' && page.sourceHostId === sourceHostId)).toBe(true)
  expect(direct.units.every(unit => unit.event.reference!.hostId === sourceHostId)).toBe(true)
  const historyPage = await f.client.sessionHistoryPage(ref.agentSessionId), timeline = await f.client.sessionTimeline(ref.agentSessionId)
  expect(historyPage.sourceHostId).toBe(sourceHostId); expect(timeline.sourceHostId).toBe(sourceHostId)
  const rawInput = { ...ref, source: 'captured' as const }, raw = await f.client.readAgentSessionHistory(rawInput)
  expect(parseAgentSessionHistoryReadPage(raw, rawInput).sourceHostId).toBe(sourceHostId)
  const reading = projectConversationReading({ agentSessionId: ref.agentSessionId, routeHostId, historyPage, timeline })
  expect(reading.timeline.events).toEqual([...direct.units].reverse().map(unit => unit.event))
  expect(reading.records.every(record => record.executionHostId === routeHostId && conversationItemRef(record)!.hostId === sourceHostId)).toBe(true)
  const otherRoute = projectConversationReading({ agentSessionId: ref.agentSessionId, routeHostId: 'other-client-route', historyPage, timeline })
  expect(reading.records.every(record => !otherRoute.records.some(other => other.id === record.id))).toBe(true)
  expect(reading.timeline.events).toEqual(otherRoute.timeline.events)
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: routeHostId, client: f.client }] }); release.push(() => service.dispose())
  const publicRead = await collect(value => service.call('agent.conversation.inspect', value), { ...ref, hostId: routeHostId })
  expect(publicRead.units).toEqual(direct.units)
  expect(publicRead.pages.every(page => page.hostId === routeHostId && page.sourceHostId === sourceHostId)).toBe(true)
  const cut = await service.call('agent.conversation.checkpoint', { ...ref, hostId: routeHostId })
  expect(cut.checkpoint.frontier.hostId).toBe(sourceHostId)
  expect((await service.call('agent.conversation.changes', { ...ref, hostId: routeHostId, checkpoint: cut.checkpoint })).sourceHostId).toBe(sourceHostId)
})

it('conflicting original source Hosts retain each exact reference and content without cross-Host same-event or invocation joins', async () => {
  const f = await fixture(), historyPage = await f.client.sessionHistoryPage(ref.agentSessionId)
  const nativeRef = { ...ref, hostId: 'source-a', source: { kind: 'native' as const, ...historyPage.source, recordId: 'native' } }
  const item = { ...captured('foreign-host-observation', _historyFixtureEpoch(0, 0, 500)), conversation: { sameEvent: nativeRef } }
  const reading = projectConversationReading({ agentSessionId: ref.agentSessionId, routeHostId: 'route', historyPage: { ...historyPage, sourceHostId: 'source-a' },
    timeline: { agentSessionId: ref.agentSessionId, sourceHostId: 'source-b', revision: 1, items: [item] } })
  expect(reading.timeline.reference).toBeNull(); expect(reading.timeline.events).toHaveLength(2)
  expect(reading.timeline.events.map(event => event.reference!.hostId).sort()).toEqual(['source-a', 'source-b'])
  expect(reading.timeline.events.flatMap(event => event.relations).filter(relation => relation.kind === 'same-event')).toEqual([])
  expect(reading.timeline.coverage.flatMap(source => source.gaps).filter(gap => gap.code === 'CONVERSATION_SOURCE_HOST_CONFLICT')).toHaveLength(2)
  expect(reading.records.map(record => record.content).sort()).toEqual(['native', 'foreign-host-observation'].sort())
  const unknown = projectConversationReading({ agentSessionId: ref.agentSessionId, routeHostId: 'route', timeline: { agentSessionId: ref.agentSessionId, revision: 1, items: [captured('unknown-host', _historyFixtureEpoch(0, 0, 500))] } })
  expect(unknown.records[0]!.content).toBe('unknown-host'); expect(conversationItemRef(unknown.records[0]!)).toBeNull()
})

it('one temporarily unavailable changes source retains its exact cut while the other commits and can be resumed without replaying that committed source', async () => {
  const f = await fixture(), cut = await f.client.conversationCheckpoint(ref)
  await appendFile(f.path, jsonl([row('native-after-cut', _historyFixtureEpoch(0, 0, 900))]))
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: captured('captured-after-cut', _historyFixtureEpoch(0, 1, 0)) })
  const provider = f.client.providers.get('claude')
  vi.spyOn(provider as { readConversationChanges: NonNullable<typeof provider.readConversationChanges> }, 'readConversationChanges').mockRejectedValueOnce(new AgentMuxError('The original Provider read is temporarily unavailable.', 'AGENT_SESSION_HISTORY_UNAVAILABLE'))
  const partial = await f.client.readConversationChanges({ ...ref, checkpoint: cut.checkpoint })
  expect(partial.items[0]).toMatchObject({ kind: 'item', item: { records: [{ original: { kind: 'captured', item: { id: 'captured-after-cut' } } }] } })
  const originalNative = cut.checkpoint.frontier.cuts.find(c => c.kind === 'native')!
  expect(partial.checkpoint.frontier.cuts.find(c => c.kind === 'native')).toEqual(originalNative)
  expect(partial.coverage.find(c => c.source.kind === 'native')!.current).toBe('unavailable')
  expect(partial.coverage.find(c => c.source.kind === 'native')!.gaps.every(gap => gap.continuation === undefined)).toBe(true)
  expect(partial.more).toBe(false)
  const resumed = await f.client.readConversationChanges({ ...ref, checkpoint: partial.checkpoint })
  expect(resumed.items).toHaveLength(1)
  expect(resumed.items[0]).toMatchObject({ kind: 'item', item: { records: [{ original: { kind: 'native', item: { id: 'native-after-cut' } } }] } })
  expect(resumed.checkpoint.frontier.cuts.find(c => c.kind === 'captured')).toEqual(partial.checkpoint.frontier.cuts.find(c => c.kind === 'captured'))
})

it('captured changes are idempotent original event upserts rather than additional utterances', async () => {
  const f = await fixture(), item = captured('one-original-event', _historyFixtureEpoch(0, 0, 500), 'original captured bytes')
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item })
  const before = await f.client.readAgentConversation(ref), old = before.items[0]!
  if (old.kind !== 'item') throw new Error('Small original upsert fixture must be a complete unit')
  const cut = await f.client.conversationCheckpoint(ref), updated = { ...item, content: 'complete captured bytes', updatedAt: _historyFixtureEpoch(0, 0, 700) }
  const first = await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: ref.agentSessionId, item: updated })
  const repeat = await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: ref.agentSessionId, item: updated })
  expect(first.changed).toBe(true); expect(repeat.changed).toBe(false)
  const changed = await f.client.readConversationChanges({ ...ref, checkpoint: cut.checkpoint })
  expect(changed.items).toHaveLength(1)
  const entry = changed.items[0]!; if (entry.kind !== 'item') throw new Error('Small changed event must be a complete unit')
  expect(entry.item.event.id).toBe(old.item.event.id); expect(entry.item.event.revision).not.toBe(old.item.event.revision)
  expect(entry.item.records[0]!.original.item).toEqual(updated)
  expect((await f.client.readConversationChanges({ ...ref, checkpoint: changed.checkpoint })).items).toEqual([])
})

it.runIf(process.env.AGENTMUX_UNIFIED_COMPILED === '1')('the real compiled CLI consumes unified inspect/checkpoint/changes, exact anchors and discovery instead of the old raw alias', async () => {
  const f = await fixture(), compiled = await import('../dist/index.js')
  const original = new compiled.AgentMuxClient({ store: new compiled.AgentMuxFileAgentSessionStore(f.storePath) }); release.push(() => original.dispose())
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(Reflect.get(original, 'kernel'), name))
  const server = new compiled.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: original }] })
  await server.start(); release.push(() => server.stop())
  const env = objectCliEnvironment(f.root)
  const read = await runCompiledObjectCli(['agent', 'conversation', 'inspect', '--host', 'local', '--session', ref.agentSessionId], env)
  expect(read.code, read.stderr).toBe(0)
  const result = JSON.parse(read.stdout)
  expect(result.operation).toBe('agent.conversation.inspect')
  expect(result.result).toMatchObject({ ...ref, sourceHostId: 'local', items: [{ kind: 'item', item: { records: [{ original: { item: { id: 'native' } } }] } }] })
  const checkpoint = await runCompiledObjectCli(['agent', 'conversation', 'checkpoint', '--host', 'local', '--session', ref.agentSessionId], env)
  expect(checkpoint.code, checkpoint.stderr).toBe(0)
  const cut = JSON.parse(checkpoint.stdout).result.checkpoint
  await appendFile(f.path, jsonl([row('compiled-delta', _historyFixtureEpoch(0, 1, 0))]))
  const changes = await runCompiledObjectCli(['agent', 'conversation', 'changes', '--input', '-'], env, JSON.stringify({ ...ref, checkpoint: cut }))
  expect(changes.code, changes.stderr).toBe(0)
  expect(JSON.parse(changes.stdout).result).toMatchObject({ ...ref, items: [{ kind: 'item', item: { records: [{ original: { item: { id: 'compiled-delta' } } }] } }], more: false })
  const unit = result.result.items[0].item as ConversationUnit
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: { ...captured('compiled-late-contribution', _historyFixtureEpoch(0, 1, 100)),
    conversation: { sameEvent: { ...ref, source: { kind: 'native', providerId: 'claude', nativeSessionId: 'native-main', recordId: 'native' } } } } })
  const continued = await runCompiledObjectCli(['agent', 'conversation', 'changes', '--input', '-'], env,
    JSON.stringify({ ...ref, checkpoint: result.result.window.checkpoint, view: result.result.window.view }))
  expect(continued.code, continued.stderr).toBe(0)
  const accepted = JSON.parse(continued.stdout).result
  expect(accepted.window.id).toBe(result.result.window.id)
  expect(accepted.items.find((entry: { item: ConversationUnit }) => entry.item.records.some(record => record.original.item.id === 'native')).item.records.map((record: { original: { item: { id: string } } }) => record.original.item.id).sort()).toEqual(['compiled-late-contribution', 'native'])
  const disposed = await runCompiledObjectCli(['agent', 'conversation', 'release', '--host', 'local', '--session', ref.agentSessionId, '--view', accepted.window.view], env)
  expect(disposed.code, disposed.stderr).toBe(0)
  expect(JSON.parse(disposed.stdout).result).toMatchObject({ viewId: accepted.window.id, released: true })
  const anchor = await runCompiledObjectCli(['agent', 'conversation', 'inspect', '--input', '-'], env, JSON.stringify({ ...ref, anchor: { record: unit.records[0]!.reference, revision: unit.records[0]!.revision, frontier: cut } }))
  expect(anchor.code, anchor.stderr).toBe(0)
  expect(JSON.parse(anchor.stdout).result.items[0].item.records[0].original.item.id).toBe('native')
  const sourceAlias = await runCompiledObjectCli(['agent', 'conversation', 'inspect', '--host', 'local', '--session', ref.agentSessionId, '--source', 'native'], env)
  expect(sourceAlias.code).not.toBe(0)
  const help = await runCompiledObjectCli(['agent', 'conversation', 'inspect', '--help'], env)
  expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('--input FILE|-'); expect(help.stdout).toContain('versioned anchor')
  const skill = await runCompiledObjectCli(['agent', '--skill'], env)
  expect(skill.code, skill.stderr).toBe(0); expect(skill.stdout).toContain('newest-first semantic units'); expect(skill.stdout).toContain('watch invalidates')
  expect(controls.every(control => !control.mock.calls.length)).toBe(true)
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
})

it.runIf(process.env.AGENTMUX_UNIFIED_COMPILED === '1')('the original four Codex records have equal full event versions through SDK page sizes, actual RPC and compiled CLI', async () => {
  const original = unifiedConversationOriginals()
  const f = await savedQuestionFixture(original.codexRows, { unifiedCapturedRead: true }); release.push(f.close)
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const compiled = await import('../dist/index.js')
  const client = new compiled.AgentMuxClient({ store: new compiled.AgentMuxFileAgentSessionStore(join(f.root, 'sessions.json')) }); release.push(() => client.dispose())
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(Reflect.get(client, 'kernel'), name))
  const connected = vi.spyOn(client, 'connect')
  const server = new compiled.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await server.start(); release.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); release.push(() => rpc.dispose())
  const native = await client.sessionHistoryPage(input.agentSessionId), captured = await client.sessionTimeline(input.agentSessionId)
  const full = projectConversationTimeline({ agentSessionId: input.agentSessionId, historyPage: native, timeline: captured })
  const expected = [...full.events].reverse()
  const recordFacts = (records: readonly typeof full.records[number][]) => records.map(({ order: _pageWitness, ...record }) => record)
  expect(expected).toHaveLength(4)
  expect(full.events.flatMap(event => event.relations).filter(relation => relation.kind === 'answers')).toHaveLength(1)
  expect(full.events.find(event => event.role === 'interaction')!.relations.filter(relation => relation.kind === 'answers')).toEqual([])
  for (const limit of [1, 100]) {
    const sdk = await collect(value => client.readAgentConversation(value), { ...input, limit })
    const remote = await collect(value => rpc.call('agent.conversation.inspect', value), { ...input, limit })
    for (const result of [sdk, remote]) {
      expect(result.units.map(unit => unit.event)).toEqual(expected)
      expect(recordFacts(result.units.flatMap(unit => unit.records).reverse())).toEqual(recordFacts(full.records))
    }
  }
  const cli = await collect(async value => {
    const result = await runCompiledObjectCli(['agent', 'conversation', 'inspect', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(value))
    expect(result.code, result.stderr).toBe(0)
    return JSON.parse(result.stdout).result
  }, { ...input, limit: 1 })
  expect(cli.units.map(unit => unit.event)).toEqual(expected)
  expect(recordFacts(cli.units.flatMap(unit => unit.records).reverse())).toEqual(recordFacts(full.records))
  expect(native.items.filter(item => item.questionAnswers).map(item => item.contentParts)).toHaveLength(1)
  expect(await f.client.sessionHistoryPage(input.agentSessionId)).toEqual(native)
  expect(controls.every(control => !control.mock.calls.length)).toBe(true)
  expect(connected).not.toHaveBeenCalled()
})
