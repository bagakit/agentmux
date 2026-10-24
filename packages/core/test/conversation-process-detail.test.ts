import { appendFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { consumeConversationWindowPage, parseConversationReadPage, conversationRevision, type ConversationTimelineReadInput, type ConversationWindowAssembly } from '../src/conversation.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const text = 'exact original 中🙂  ' + 'exact-original-'.repeat(8000)
async function fixture(provider: 'claude' | 'codex' = 'claude') {
  const f = await nativeHistoryFixture(provider, root => provider === 'claude' ? jsonl([
    { type: 'user', uuid: 'input', sessionId: 'native-main', message: { role: 'user', content: 'keep speech complete' } },
    { type: 'assistant', uuid: 'tool', sessionId: 'native-main', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'opaque-tool', input: { text } }] } }
  ]) : jsonl([
    { type: 'session_meta', payload: { id: 'native-main', cwd: root } },
    { type: 'response_item', payload: { type: 'message', id: 'input', role: 'user', content: [{ type: 'input_text', text: 'keep speech complete' }] } },
    { type: 'response_item', payload: { type: 'function_call', id: 'tool', call_id: 'call-1', name: 'opaque-tool', arguments: JSON.stringify({ text }) } }
  ]))
  closes.push(f.close)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: { id: 'captured-tool', agentSessionId: f.session.agentSessionId,
    kind: 'tool_call', source: 'native-hook', status: 'failed', title: 'Captured tool', toolName: 'another-tool', toolInput: text, toolOutput: '  original failure output\n',
    createdAt: 1000, updatedAt: 1001, authorAgentSessionId: f.session.agentSessionId } })
  return f
}
async function read(f: Awaited<ReturnType<typeof fixture>>, input: Omit<ConversationTimelineReadInput, 'hostId' | 'agentSessionId'> = {}) {
  let pending: ConversationWindowAssembly | undefined, cursor: string | undefined
  const pages = []
  for (let i = 0; i < 1000; i++) {
    const request = { hostId: 'local', agentSessionId: f.session.agentSessionId, limit: 100, maxBytes: 1048576, ...input, ...(cursor ? { cursor } : {}) }
    const page = await f.client.readAgentConversation(request)
    expect(parseConversationReadPage(page, request)).toEqual(page)
    pages.push(page)
    const result = consumeConversationWindowPage(page, pending)
    if (result.kind === 'complete') return { snapshot: result.snapshot, pages }
    pending = result.pending; cursor = page.nextCursor!
  }
  throw Error('Read did not complete')
}
it.each(['claude', 'codex'] as const)('real %s Provider and FileStore return typed headers, retain speech, and read exact native/captured original versions', async provider => {
  const f = await fixture(provider), full = await read(f), deferred = await read(f, { processDetails: 'deferred' })
  const summaries = deferred.snapshot.units.flatMap(unit => unit.records).filter(record => record.original.kind === 'deferred')
  expect(summaries).toHaveLength(2)
  if (process.env.AGENTMUX_LAZY_COST) appendFileSync(process.env.AGENTMUX_LAZY_COST, JSON.stringify({ provider, originalPayloadBytes: Buffer.byteLength(text), fullWireBytes: Buffer.byteLength(JSON.stringify(full.pages)), deferredWireBytes: Buffer.byteLength(JSON.stringify(deferred.pages)), deferredRecords: summaries.length, nativeSourceBytes: f.before.native.length, sourceIO: 'Initial native scan and captured item_json parse remain; savings are wire and Renderer payload.' }) + '\n')
  expect(JSON.stringify(deferred.pages)).not.toContain(text)
  expect(Buffer.byteLength(JSON.stringify(deferred.pages))).toBeLessThan(Buffer.byteLength(JSON.stringify(full.pages)) / 10)
  expect(JSON.stringify(deferred.pages)).toContain('keep speech complete')
  for (const summary of summaries) {
    const original = full.snapshot.units.flatMap(unit => unit.records).find(record => record.id === summary.id)!
    expect(summary.revision).toBe(original.revision)
    expect(summary.reference).toEqual(original.reference)
    const anchor = { record: summary.reference!, revision: summary.revision, frontier: deferred.snapshot.window.checkpoint }
    if (summary.reference!.source.kind === 'captured') await f.store.applyTimelineMutation({ type: 'update', agentSessionId: f.session.agentSessionId, itemId: 'captured-tool', updatedAt: 1002, toolInput: 'later version' })
    const detail = await read(f, { anchor, maxBytes: 16384 })
    expect(detail.snapshot.units.flatMap(unit => unit.records).map(({ order: _order, ...record }) => record)).toEqual([((({ order: _order, ...record }) => record)(original))])
  }
  for (const spy of f.controls) expect(spy).not.toHaveBeenCalled()
}, 30000)
it('strict public codec rejects unrequested, corrupt and cross-role summaries; view representation cannot change', async () => {
  const f = await fixture(), { pages, snapshot } = await read(f, { processDetails: 'deferred' })
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId, limit: 100, maxBytes: 1048576, processDetails: 'deferred' as const }
  expect(() => parseConversationReadPage(pages[0], { ...input, processDetails: undefined } as ConversationTimelineReadInput)).toThrow()
  const malformed = structuredClone(pages[0]!), entry = malformed.items.find(entry => entry.kind === 'item' && entry.item.event.role === 'process')!
  if (entry.kind !== 'item') throw Error('Expected summary')
  entry.item.event.role = 'message'
  expect(() => parseConversationReadPage(malformed, input)).toThrow()
  await expect(f.client.readAgentConversation({ hostId: 'local', agentSessionId: f.session.agentSessionId, view: snapshot.window.view! })).rejects.toThrow(/representation/)
  const changes = await f.client.readConversationChanges({ ...input, checkpoint: snapshot.window.checkpoint, view: snapshot.window.view! })
  expect(changes.processDetails).toBe('deferred')
  expect(JSON.stringify(changes)).not.toContain(text)
  const native = snapshot.units.flatMap(unit => unit.records).find(record => record.reference?.source.kind === 'native' && record.original.kind === 'deferred')!
  const source = { record: native.reference!, revision: native.revision, frontier: snapshot.window.checkpoint }
  const detail = await read(f, { anchor: source })
  const captured = snapshot.units.flatMap(unit => unit.records).find(record => record.reference?.source.kind === 'captured')!
  expect(() => parseConversationReadPage(detail.pages[0], { ...input, processDetails: undefined, anchor: { ...source, record: captured.reference!, revision: captured.revision } } as ConversationTimelineReadInput)).toThrow()
  const fragment = await f.client.readAgentConversation({ hostId: 'local', agentSessionId: f.session.agentSessionId, anchor: source, maxBytes: 16384 })
  expect(fragment.items.some(entry => entry.kind === 'fragment')).toBe(true)
  expect(() => consumeConversationWindowPage({ ...fragment, window: { ...fragment.window, complete: true, itemCount: 0, view: 'forged-complete-view' } })).toThrow(/incomplete/)
  const lostCall = structuredClone(pages[0]!)
  const nativeEntry = lostCall.items.find(entry => entry.kind === 'item' && entry.item.records.some(record => record.reference?.source.kind === 'native' && record.original.kind === 'deferred'))!
  if (nativeEntry.kind !== 'item') throw Error('Expected native summary')
  const summary = nativeEntry.item.records[0]!
  if (summary.original.kind !== 'deferred' || summary.original.item.kind !== 'native') throw Error('Expected native header')
  const call = summary.original.item.parts.find(part => part.kind === 'tool-call')!
  if (call.kind !== 'tool-call') throw Error('Expected call')
  call.callId = 'foreign-invocation'
  if ('summaryRevision' in summary) summary.summaryRevision = conversationRevision(summary.original.item)
  expect(() => parseConversationReadPage(lostCall, input)).toThrow(/invocation/)

})

it('a Provider without exact-record lookup retains its complete native process path', async () => {
  const f = await nativeHistoryFixture('pi', root => jsonl([
    { type: 'session', version: 3, id: 'native-main', cwd: root },
    { type: 'message', id: 'pi-tool', parentId: null, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'pi-call', name: 'opaque-tool', arguments: { text: 'complete original remains available' } }] } }
  ])); closes.push(f.close)
  const page = await f.client.readAgentConversation({ hostId: 'local', agentSessionId: f.session.agentSessionId, processDetails: 'deferred' })
  const result = consumeConversationWindowPage(page)
  expect(result.kind).toBe('complete')
  if (result.kind !== 'complete') throw Error('Expected complete small record')
  expect(result.snapshot.units.flatMap(unit => unit.records).filter(record => record.original.kind === 'native')).toHaveLength(1)
  expect(JSON.stringify(page)).toContain('complete original remains available')
})

it('an unavailable Provider does not take away captured process history or its exact detail', async () => {
  const f = await fixture()
  f.client.providers.unregister('claude')
  const result = await read(f, { processDetails: 'deferred' })
  const captured = result.snapshot.units.flatMap(unit => unit.records).find(record => record.reference?.source.kind === 'captured')!
  expect(captured.original.kind).toBe('deferred')
  const detail = await read(f, { anchor: { record: captured.reference!, revision: captured.revision, frontier: result.snapshot.window.checkpoint } })
  expect(detail.snapshot.units.flatMap(unit => unit.records).some(record => record.original.kind === 'captured' && record.original.item.toolInput === text)).toBe(true)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})
