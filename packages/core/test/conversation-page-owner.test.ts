import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session'
import { consumeConversationWindowPage, parseConversationReadPage, parseConversationReadPageForWindow,
  type ConversationTimelineReadInput, type AgentConversationReadPage, type ConversationWindowAssembly } from '../src/conversation'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const row = (body: string) => ({ type: 'user', uuid: 'original-record', sessionId: 'native-main', message: { role: 'user', content: body } })

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
