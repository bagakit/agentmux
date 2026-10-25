import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session'
import { createPublicationConversationPort } from '../../connectors/src/core-conversation-port'
import { forwardConversationPage, readRoutedConversation } from '../src/conversation-reader'
import { parseRoutedConversationPage, parseConversationReadPageForWindow, consumeConversationWindowPage,
  type AgentConversationReadPage, type ConversationTimelineReadInput } from '../src/conversation-changes'
import * as stream from '../src/conversation-stream'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { try { for (const close of closes.splice(0).reverse()) await close() } finally { vi.restoreAllMocks() } })
async function fixture(body = 'Original routed contribution') {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'original-record', sessionId: 'native-main', message: { role: 'user', content: body } }]))
  closes.push(f.close)
  return { ...f, input: { hostId: 'local', agentSessionId: f.session.agentSessionId } }
}

it('the original Client and publication port retain complete items through inspect and changes routes', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const reference = { ...f.input, hostId: 'selected-route' }
  const port = createPublicationConversationPort(() => [{ hostId: reference.hostId, client: f.client }])
  const digest = vi.spyOn(stream, 'conversationRevision')
  let sourcePage: AgentConversationReadPage | undefined
  const inspect = f.client.readAgentConversation.bind(f.client), changes = f.client.readConversationChanges.bind(f.client)
  vi.spyOn(f.client, 'readAgentConversation').mockImplementation(async (...args) => {
    sourcePage = await inspect(...args); digest.mockClear(); return sourcePage
  })
  vi.spyOn(f.client, 'readConversationChanges').mockImplementation(async (...args) => {
    const page = await changes(...args); sourcePage = page; digest.mockClear(); return page
  })
  const checkpoint = await port.checkpoint({ ...reference, nativePosition: 'beginning' }, signal)
  for (const read of [() => port.inspect(reference, signal), () => port.changes({ ...reference, checkpoint: checkpoint.checkpoint }, signal)]) {
    const page = await read()
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every(entry => entry.kind === 'item')).toBe(true)
    expect(page).toMatchObject({ hostId: 'selected-route', sourceHostId: 'local', window: { checkpoint: { hostId: 'selected-route', frontier: { hostId: 'local' } } } })
    expect(page.items, 'Route envelopes must not copy original immutable content').toBe(sourcePage!.items)
    expect(consumeConversationWindowPage(page).kind).toBe('complete')
    expect(digest, 'The real publication consumer must not rehash the original Reader response').not.toHaveBeenCalled()
    expect(Object.isFrozen(page.items)).toBe(true)
  }
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})

it('the original Reader keeps public local and source aliases without a redundant Client copy', async () => {
  const f = await fixture()
  await f.store.compareAndSwap(f.session, { ...f.session, hostId: 'original-source' })
  for (const hostId of ['local', 'original-source']) {
    const input = { ...f.input, hostId }, page = await f.client.readAgentConversation(input)
    expect(page).toMatchObject({ hostId, sourceHostId: 'original-source', window: { checkpoint: { hostId, frontier: { hostId: 'original-source' } } } })
    const checkpoint = await f.client.conversationCheckpoint({ ...input, nativePosition: 'beginning' })
    const changes = await f.client.readConversationChanges({ ...input, checkpoint: checkpoint.checkpoint })
    expect(changes).toMatchObject({ hostId, sourceHostId: 'original-source', checkpoint: { hostId }, window: { checkpoint: { hostId } } })
    const digest = vi.spyOn(stream, 'conversationRevision')
    expect(parseConversationReadPageForWindow(page, input)).toBe(page)
    expect(digest).not.toHaveBeenCalled(); digest.mockRestore()
  }
})

it('route reuse keeps source, scope, shape and raw accessor validation at the original parser boundary', async () => {
  const f = await fixture(), original = await f.client.readAgentConversation(f.input)
  const input = { ...f.input, hostId: 'selected-route' }, routed = forwardConversationPage(original, input)
  const sourceChanged = { ...routed, sourceHostId: 'foreign-source', window: { ...routed.window,
    checkpoint: { ...routed.window.checkpoint, sourceHostId: 'foreign-source', frontier: { ...routed.window.checkpoint.frontier, hostId: 'foreign-source' } } } }
  expect(() => parseRoutedConversationPage(original, sourceChanged, input), 'A changed envelope cannot borrow the original source content proof').toThrow()
  const scopeChanged = { ...routed, scope: { sources: [] }, coverage: [], window: { ...routed.window,
    checkpoint: { ...routed.window.checkpoint, frontier: { ...routed.window.checkpoint.frontier, scope: { sources: [] }, cuts: [] } } } }
  expect(() => parseRoutedConversationPage(original, scopeChanged, input), 'An empty accepted scope cannot borrow the original native contribution').toThrow()
  const accessor = { ...routed }, getter = vi.fn(() => routed.items)
  Object.defineProperty(accessor, 'items', { enumerable: true, get: getter })
  expect(() => parseRoutedConversationPage(original, accessor, input)).toThrow()
  expect(getter).not.toHaveBeenCalled()
  expect(() => parseRoutedConversationPage(original, routed, { ...input, processDetails: 'deferred' })).toThrow()
  expect(() => parseRoutedConversationPage(original, routed, { ...input, checkpoint: routed.window.checkpoint })).toThrow()
  const raw = structuredClone(original), digest = vi.spyOn(stream, 'conversationRevision')
  const accepted = parseRoutedConversationPage(raw, forwardConversationPage(raw, input), input)
  expect(accepted.items).not.toBe(raw.items); expect(digest).toHaveBeenCalled()
})

it('route expansion reduces the original source budget before accepting its envelope', async () => {
  const f = await fixture('Original larger routed contribution '.repeat(1100))
  const input: ConversationTimelineReadInput = { ...f.input, hostId: 'selected-route', limit: 1, maxBytes: 16_384 }
  const budgets: number[] = [], pages: AgentConversationReadPage[] = []
  const page = await readRoutedConversation(input, async (maxBytes, replay) => {
    budgets.push(maxBytes)
    const source = await f.client.readAgentConversation({ ...input, hostId: 'local', maxBytes, ...(replay ? { cursor: replay } : {}) })
    pages.push(source); return source
  }, 'local')
  expect(budgets.length, 'The fixture must exercise real route-envelope expansion').toBeGreaterThan(1)
  expect(budgets[1]).toBeLessThan(budgets[0]!)
  expect(page.items).toBe(pages.at(-1)!.items)
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(input.maxBytes!)
  expect(page.items[0]?.kind).toBe('fragment')
  expect(parseConversationReadPageForWindow(page, input)).toBe(page)
})

it('an empty original page retains its exact request envelope and no invented content', async () => {
  const f = await nativeHistoryFixture('claude', '')
  closes.push(f.close)
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId }, page = await f.client.readAgentConversation(input)
  expect(page.items).toEqual([]); expect(page.window.itemCount).toBe(0)
  expect(parseConversationReadPageForWindow(page, input)).toBe(page)
  expect(() => parseConversationReadPageForWindow(page, { ...input, agentSessionId: 'other-session' })).toThrow()
})
