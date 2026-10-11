import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { consumeConversationWindowPage, parseConversationUnit, type ConversationWindowAssembly } from '../src/conversation-changes.js'
import * as timeline from '../src/conversation-timeline.js'
import type { AgentTimelineItem } from '../src/types.js'

const ref = { hostId: 'local', agentSessionId: 'private-agent' }
const release: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of release.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function fixture(body = 'Original contribution') {
  const f = await nativeHistoryFixture('claude', jsonl([{ uuid: 'native', type: 'assistant', sessionId: 'native-main',
    timestamp: new Date(_tailFixtureEpoch(0, 0, 100)).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: body }] } }]))
  release.push(f.close)
  const captured: AgentTimelineItem = { id: 'captured', agentSessionId: ref.agentSessionId, kind: 'assistant_message',
    source: 'native-hook', status: 'complete', title: 'Original observation', content: body, createdAt: _tailFixtureEpoch(0, 0, 200), updatedAt: _tailFixtureEpoch(0, 0, 200) }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId, item: captured })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); release.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); release.push(() => rpc.dispose())
  return { ...f, before: await f.bytes(), rpc }
}

it('uses the existing canonical representation while preserving content revisions', () => {
  const a = { z: [1, { b: 'body', a: null }], omitted: undefined, a: true }
  const b = { a: true, z: [1, { a: null, b: 'body' }] }
  expect(timeline.conversationValuesEqual(a, b)).toBe(true)
  const expected = createHash('sha256').update('{"a":true,"z":[1,{"a":null,"b":"body"}]}').digest('hex')
  expect(timeline.conversationRevision(a)).toBe(expected)
  expect(timeline.conversationRevision(b)).toBe(expected)
  expect(timeline.conversationValuesEqual([1, 2], [2, 1])).toBe(false)
  expect(timeline.conversationValuesEqual({ body: 'first' }, { body: 'second' })).toBe(false)
  expect(timeline.conversationValuesEqual([undefined, Number.NaN], [null, null])).toBe(true)
})

it('keeps the record and event hash budget at both decoder and complete-window boundaries', async () => {
  const f = await fixture(), page = await f.rpc.call('agent.conversation.inspect', ref)
  const entries = page.items.filter(entry => entry.kind === 'item')
  expect(entries).toHaveLength(2)
  expect(entries.flatMap(entry => entry.item.records.map(record => record.original.kind)).sort()).toEqual(['captured', 'native'])
  const digest = vi.spyOn(timeline, 'conversationRevision')
  for (const entry of entries) {
    digest.mockClear()
    expect(parseConversationUnit(entry.item, ref, page.scope)).toEqual(entry.item)
    expect.soft(digest, entry.item.records[0]!.original.kind + ': one original record and one event require exactly two content digests').toHaveBeenCalledTimes(2)
  }
  digest.mockClear()
  const consumed = consumeConversationWindowPage(page)
  expect(consumed.kind).toBe('complete')
  expect(digest, 'complete-window validation keeps required digests without hashing equality').toHaveBeenCalledTimes(4)
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})

it('rejects non-normalized original fields for native and captured records', async () => {
  const f = await fixture(), page = await f.rpc.call('agent.conversation.inspect', ref)
  const entries = page.items.filter(entry => entry.kind === 'item')
  expect(entries).toHaveLength(2)
  for (const entry of entries) {
    const invalid = structuredClone(entry.item)
    Object.assign(invalid.records[0]!.original.item, { unexpectedAuthority: 'not a normalized original' })
    expect.soft(() => parseConversationUnit(invalid, ref, page.scope), entry.item.records[0]!.original.kind).toThrow()
  }
})

it('rejects stale revisions when a decoded original is changed before window consumption', async () => {
  const f = await fixture(), page = await f.rpc.call('agent.conversation.inspect', ref)
  const entries = page.items.filter(entry => entry.kind === 'item')
  expect(entries).toHaveLength(2)
  for (const entry of entries) {
    const changed = structuredClone(page)
    const unit = changed.items.find(value => value.kind === 'item' && value.item.event.id === entry.item.event.id)!
    if (unit.kind !== 'item') throw Error('Expected original unit')
    const original = unit.item.records[0]!.original
    if (original.kind === 'captured') original.item.content = 'Changed after decoding'
    else original.item.contentParts = [{ kind: 'text', text: 'Changed after decoding' }]
    expect(() => consumeConversationWindowPage(changed)).toThrow('Original conversation record version changed.')
  }
  const forged = structuredClone(page), first = forged.items[0]!
  if (first.kind !== 'item') throw Error('Expected original unit')
  first.item.event.revision = '0'.repeat(64)
  expect(() => consumeConversationWindowPage(forged)).toThrow('Conversation event version changed.')
  expect(consumeConversationWindowPage(page).kind).toBe('complete')
})

it('preserves public Reader, wire decoding and fragmented window assembly for both sources', async () => {
  const body = 'Original Unicode contribution \u4f60\u597d. '.repeat(1200), f = await fixture(body)
  let cursor: string | undefined, pending: ConversationWindowAssembly | undefined, fragments = 0, pages = 0
  let accepted: ReturnType<typeof consumeConversationWindowPage> | undefined
  do {
    const page = await f.rpc.call('agent.conversation.inspect', { ...ref, maxBytes: 16 * 1024, ...(cursor ? { cursor } : {}) })
    expect(page.sourceHostId).toBe('local')
    fragments += page.items.filter(entry => entry.kind === 'fragment').length
    accepted = consumeConversationWindowPage(page, pending)
    pending = accepted.kind === 'pending' ? accepted.pending : undefined
    cursor = page.nextCursor ?? undefined
    expect(++pages).toBeLessThan(40)
  } while (cursor)
  expect(fragments).toBeGreaterThan(0)
  expect(pending).toBeUndefined()
  if (accepted?.kind !== 'complete') throw Error('Expected complete public window')
  const records = accepted.snapshot.units.flatMap(unit => unit.records)
  expect(records).toHaveLength(2)
  expect(new Set(records.map(record => record.id)).size).toBe(2)
  for (const record of records) {
    if (!record.reference) throw Error('Expected original scoped record reference')
    expect(record.reference.hostId).toBe('local')
    expect(record.reference.agentSessionId).toBe(ref.agentSessionId)
    const original = record.original
    if (original.kind === 'captured') expect(original.item.content).toBe(body)
    else {
      expect(original.item.contentParts).toHaveLength(1)
      expect(original.item.contentParts[0]).toMatchObject({ kind: 'text', text: body })
    }
    expect(record.revision).toBe(timeline.conversationRevision(original.item))
  }
  expect(await f.bytes()).toEqual(f.before)
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})
