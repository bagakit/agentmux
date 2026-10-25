import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session'
import { consumeConversationWindowPage, parseConversationReadPage, parseConversationReadPageForWindow, parseConversationChangesPageForWindow,
  type ConversationTimelineReadInput, type AgentConversationReadPage, type ConversationWindowAssembly } from '../src/conversation'
import * as stream from '../src/conversation-stream'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { try { for (const close of closes.splice(0).reverse()) await close() } finally { vi.restoreAllMocks() } })
const row = (body: string) => ({ type: 'user', uuid: 'original-record', sessionId: 'native-main', message: { role: 'user', content: body } })

it('reuses complete-unit validation only for the original owned page while checking each request again', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([row('Original immutable contribution')]))
  closes.push(f.close)
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const raw = structuredClone(await f.client.readAgentConversation(input))
  const checkpoint = (await f.client.conversationCheckpoint({ ...input, nativePosition: 'beginning' })).checkpoint
  const changesInput = { ...input, checkpoint }, rawChanges = structuredClone(await f.client.readConversationChanges(changesInput))
  const required = (page: AgentConversationReadPage) => page.items.reduce((count, entry) => count + (entry.kind === 'item' ? entry.item.records.length + 1 : 0), 0)
  expect(required(raw)).toBeGreaterThan(0); expect(required(rawChanges)).toBeGreaterThan(0)
  const digest = vi.spyOn(stream, 'conversationRevision')
  const owned = parseConversationReadPageForWindow(raw, input)
  expect(digest, 'One content digest per original record and event at the strict read boundary').toHaveBeenCalledTimes(required(raw))
  digest.mockClear()
  const changes = parseConversationChangesPageForWindow(rawChanges, changesInput)
  expect(digest, 'The strict changes boundary validates each original record and event').toHaveBeenCalledTimes(required(rawChanges))
  digest.mockClear()
  const reads = Array.from({ length: 3 }, () => parseConversationReadPageForWindow(owned, { ...input, limit: 100 }))
  const repeatedChanges = Array.from({ length: 3 }, () => parseConversationChangesPageForWindow(changes, changesInput))
  for (const page of [...reads, ...repeatedChanges]) expect(consumeConversationWindowPage(page).kind).toBe('complete')
  expect(digest, 'Repeated original immutable pages must not recompute record or event digests').not.toHaveBeenCalled()
  expect(reads.every(page => page === owned)).toBe(true); expect(repeatedChanges.every(page => page === changes)).toBe(true)
  const copied = parseConversationReadPageForWindow(structuredClone(owned), input)
  expect(digest, 'A transport or ordinary raw copy must validate independently').toHaveBeenCalledTimes(required(raw))
  expect(copied).not.toBe(owned)
  digest.mockClear()
  parseConversationReadPageForWindow(raw, input); parseConversationReadPageForWindow(raw, input)
  expect(digest, 'Mutable raw objects never acquire an identity cache').toHaveBeenCalledTimes(required(raw) * 2)
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})

it('keeps original request, selected source, representation, checkpoint and serialized byte bounds on owned pages', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([row('Original request-bound body')]))
  closes.push(f.close)
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const raw = structuredClone(await f.client.readAgentConversation(input)), owned = parseConversationReadPageForWindow(raw, input)
  const first = owned.items[0]!
  if (first.kind !== 'item') throw Error('Expected an original complete unit')
  const record = first.item.records[0]!
  const requests: ConversationTimelineReadInput[] = [
    { ...input, hostId: 'another-route' }, { ...input, agentSessionId: 'another-session' },
    { ...input, limit: 0 }, { ...input, maxBytes: owned.budgetBytes - 1 }, { ...input, processDetails: 'deferred' },
    { ...input, nativeSource: { providerId: 'another-provider', nativeSessionId: 'another-source' } },
    { ...input, record: { ...record.reference!, source: { ...record.reference!.source, recordId: 'another-record' } } },
    { ...input, anchor: { record: record.reference!, revision: record.revision, frontier: owned.window.checkpoint } }
  ]
  for (const request of requests) expect(() => parseConversationReadPageForWindow(owned, request), JSON.stringify(request))
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const checkpoint = (await f.client.conversationCheckpoint({ ...input, nativePosition: 'beginning' })).checkpoint
  const changesInput = { ...input, checkpoint }, changes = parseConversationChangesPageForWindow(await f.client.readConversationChanges(changesInput), changesInput)
  const foreignSource = structuredClone(checkpoint); foreignSource.sourceHostId = 'another-source-host'
  const foreignScope = structuredClone(checkpoint); foreignScope.frontier.scope.sources = []
  for (const checkpoint of [foreignSource, foreignScope]) expect(() => parseConversationChangesPageForWindow(changes, { ...input, checkpoint }))
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(() => parseConversationReadPageForWindow(changes, input), 'A changes response does not become an inspect response through its owner')
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(() => parseConversationChangesPageForWindow(owned, changesInput), 'An inspect owner cannot invent a changes checkpoint')
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const oversized = structuredClone(raw), maxBytes = Buffer.byteLength(JSON.stringify(raw)) - 64
  oversized.budgetBytes = maxBytes
  expect(Buffer.byteLength(JSON.stringify(oversized)), 'The fixture must really exceed its edited declared byte budget').toBeGreaterThan(maxBytes)
  expect(() => parseConversationReadPageForWindow(oversized, { ...input, maxBytes }), 'Actual serialized envelope bytes remain bounded, not just its claimed budget')
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(parseConversationReadPageForWindow(owned, input)).toBe(owned)
})

it('does not sanitize raw fields or accept reflected and proxied page owners as original validation', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([row('Original reflection-bound body')]))
  closes.push(f.close)
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const raw = structuredClone(await f.client.readAgentConversation(input)), owned = parseConversationReadPageForWindow(raw, input)
  for (const invalid of [null, undefined, true, 1, 'raw', []]) expect(() => parseConversationReadPageForWindow(invalid, input), 'Unknown raw input keeps its original protocol error')
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const key = Reflect.ownKeys(owned).find(key => typeof key === 'symbol')!, owner = Object.getOwnPropertyDescriptor(owned, key)!.value
  const marked = structuredClone(owned)
  Object.defineProperty(marked, key, { value: owner })
  expect(() => parseConversationReadPageForWindow(marked, input), 'Copying a private marker cannot wash non-JSON raw input')
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const hidden = structuredClone(raw); Object.defineProperty(hidden, 'unexpected', { value: 'hidden' })
  expect(() => parseConversationReadPageForWindow(hidden, input)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const accessor = structuredClone(raw), getter = vi.fn(() => raw.window)
  Object.defineProperty(accessor, 'window', { enumerable: true, get: getter })
  expect(() => parseConversationReadPageForWindow(accessor, input)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(getter, 'Raw JSON validation must reject accessors before reading them').not.toHaveBeenCalled()
  expect(() => parseConversationReadPageForWindow(new Proxy(owned, {}), input), 'A Proxy is not the exact private owned page')
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const target = structuredClone(owned), proxy = new Proxy(target, { getOwnPropertyDescriptor(value, name) {
    return name === key ? { configurable: true, enumerable: false, writable: false, value: owner } : Reflect.getOwnPropertyDescriptor(value, name)
  } })
  const digest = vi.spyOn(stream, 'conversationRevision'), parsed = parseConversationReadPageForWindow(proxy, input)
  const required = raw.items.reduce((count, entry) => count + (entry.kind === 'item' ? entry.item.records.length + 1 : 0), 0)
  expect(required).toBeGreaterThan(0)
  expect(digest, 'A proxy showing another page owner must still execute strict content validation').toHaveBeenCalledTimes(required)
  expect(parsed).not.toBe(proxy); expect(Object.isFrozen(parsed)).toBe(true)
  const first = target.items[0]!
  if (first.kind !== 'item') throw Error('Expected an original complete unit')
  first.item.event.revision = 'b'.repeat(64)
  expect(() => parseConversationReadPageForWindow(proxy, input), 'A reflected owner cannot certify a modified proxy target')
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const frozenRaw = structuredClone(target); Object.freeze(frozenRaw)
  expect(() => parseConversationReadPageForWindow(frozenRaw, input), 'Frozen raw data is not parser ownership')
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
})

it('owns only its original immutable response and never freezes the raw input or ordinary public parser result', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([row('Original complete body')]))
  closes.push(f.close)
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const raw = structuredClone(await f.client.readAgentConversation(input))
  const ordinary = parseConversationReadPage(raw, input)
  expect(Object.isFrozen(ordinary)).toBe(false)
  ordinary.window.revision++
  const owned = parseConversationReadPageForWindow(raw, input)
  const first = owned.items[0]!
  if (first.kind !== 'item') throw new Error('Expected one complete original contribution')
  const revision = first.item.event.revision
  try { first.item.event.revision = 'a'.repeat(64) } catch (error) { if (!(error instanceof TypeError)) throw error }
  const accepted = consumeConversationWindowPage(owned)
  expect(accepted.kind).toBe('complete')
  if (accepted.kind === 'complete') expect(accepted.snapshot.units[0]!.event.revision,
    'A caller cannot rewrite a validated original contribution before window consumption').toBe(revision)
  const rawItem = raw.items[0]!
  if (rawItem.kind !== 'item') throw new Error('Expected raw complete contribution')
  rawItem.item.event.revision = 'a'.repeat(64)
  expect(Object.isFrozen(raw)).toBe(false)
  expect(Object.isFrozen(rawItem.item.event.author), 'Window ownership cannot freeze the caller raw source aliases').toBe(false)
  expect(consumeConversationWindowPage(owned)).toMatchObject({ kind: 'complete' })

  const malformed = structuredClone(owned)
  const item = malformed.items[0]!
  if (item.kind !== 'item') throw new Error('Expected complete copied contribution')
  item.item.event.revision = 'b'.repeat(64)
  expect(() => consumeConversationWindowPage(malformed), 'An ordinary copied raw contribution still needs strict integrity validation')
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const key = Reflect.ownKeys(owned).find(key => typeof key === 'symbol')!
  expect(key).toBeDefined()
  const owner = Object.getOwnPropertyDescriptor(owned, key)!.value
  Object.defineProperty(malformed, key, { value: owner, configurable: true })
  expect(() => consumeConversationWindowPage(malformed), 'A copied owner cannot validate another page object')
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const fake = Object.create(Object.getPrototypeOf(owner))
  Object.defineProperty(malformed, key, { value: fake })
  expect(() => consumeConversationWindowPage(malformed), 'A forged prototype cannot create response ownership')
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(() => new owner.constructor({}, malformed), 'Reflecting a constructor cannot acquire the parser token')
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  try { owner.constructor.owns = () => true } catch (error) { if (!(error instanceof TypeError)) throw error }
  expect(() => consumeConversationWindowPage(malformed), 'A reflected constructor cannot replace the response ownership guard')
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(Object.keys(owned)).toEqual(Object.keys(ordinary))
  expect(structuredClone(owned)).toEqual(parseConversationReadPage(structuredClone(owned), input))
})

it('validates complete fragment contents after original transport integrity and preserves exact continuation', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([row('Original fragment body '.repeat(1500))]))
  closes.push(f.close)
  const input: ConversationTimelineReadInput = { hostId: 'local', agentSessionId: f.session.agentSessionId, limit: 1, maxBytes: 16_384 }
  const pages: AgentConversationReadPage[] = []
  let cursor: string | undefined, pending: ConversationWindowAssembly | undefined
  do {
    const request = { ...input, ...(cursor ? { cursor } : {}) }
    const raw = structuredClone(await f.client.readAgentConversation(request))
    pages.push(raw)
    const result = consumeConversationWindowPage(parseConversationReadPageForWindow(raw, request), pending)
    if (result.kind === 'complete') break
    pending = result.pending; cursor = raw.nextCursor!
    expect(cursor).toBeTruthy(); expect(pages.length).toBeLessThan(100)
  } while (true)
  expect(pages.length).toBeGreaterThan(1)
  const fragments = pages.flatMap(page => page.items)
  expect(fragments.every(entry => entry.kind === 'fragment')).toBe(true)
  const bytes = Buffer.concat(fragments.map(entry => entry.kind === 'fragment' ? Buffer.from(entry.dataBase64, 'base64') : Buffer.alloc(0)))
  const invalid = JSON.parse(bytes.toString('utf8'))
  invalid.event.revision = 'a'.repeat(64)
  const changed = Buffer.from(JSON.stringify(invalid))
  expect(changed.length).toBe(bytes.length)
  const sha256 = createHash('sha256').update(changed).digest('hex')
  const corrupted = structuredClone(pages)
  for (const page of corrupted) for (const entry of page.items) if (entry.kind === 'fragment') {
    const length = Buffer.from(entry.dataBase64, 'base64').length
    entry.dataBase64 = changed.subarray(entry.offsetBytes, entry.offsetBytes + length).toString('base64')
    entry.sha256 = sha256
  }
  expect(() => {
    let assembly: ConversationWindowAssembly | undefined
    for (const page of corrupted) {
      const result = consumeConversationWindowPage(parseConversationReadPageForWindow(page, input), assembly)
      if (result.kind === 'pending') assembly = result.pending
    }
  }, 'A transport-valid fragment must still reject its changed original contribution revision')
    .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(f.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
