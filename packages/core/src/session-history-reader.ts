import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxClient } from './client.js'
import type { AgentSessionHistoryItem, AgentTimelineItem, AgentSessionHistorySource } from './types.js'

/** A read reference carries neither a Run lease nor native/input authority. */
export type AgentSessionContextReference = { hostId: string; agentSessionId: string }
export type AgentSessionHistoryReadInput = AgentSessionContextReference & {
  source: 'captured' | 'native'; limit?: number; cursor?: string; maxBytes?: number
}
export type AgentSessionHistoryReadEntry =
  | { kind: 'item'; item: AgentSessionHistoryItem | AgentTimelineItem }
  | { kind: 'fragment'; itemId: string; encoding: 'json-utf8-base64'; sha256: string;
      offsetBytes: number; totalBytes: number; dataBase64: string }
export type AgentSessionHistoryReadPage = AgentSessionContextReference & {
  source: 'captured' | 'native'; revision: string; availability: 'available' | 'empty'; order: 'newest-first' | 'chronological-page';
  items: AgentSessionHistoryReadEntry[]; nextCursor: string | null; budgetBytes: number
  nativeSource?: AgentSessionHistorySource
}
type Reader = Pick<AgentMuxClient, 'sessionHistorySources' | 'sessionTimeline' | 'sessionHistoryPage'>
type Cursor = AgentSessionContextReference & { version: 1; source: 'captured' | 'native';
  revision?: string; index: number; offset: number; nativeCursor?: string; nativeLimit?: number }
// A cursor is a scoped read continuation, not a second history ledger. Host restart invalidates it.
const cursorKey = randomBytes(32)
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fail = (message: string, code = 'INVALID_AGENT_SESSION_HISTORY_OPTIONS'): never => {
  throw new AgentMuxError(message, code)
}
function text(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value) && !/[\0\r\n]/u.test(value) && Buffer.byteLength(value) <= 4096
}
export function validateSessionHistoryReadInput(input: AgentSessionHistoryReadInput): void {
  if (!text(input.hostId) || !text(input.agentSessionId) || input.agentSessionId === 'self' ||
    !['captured', 'native'].includes(input.source) ||
    !Number.isSafeInteger(input.limit ?? 30) || (input.limit ?? 30) < 1 || (input.limit ?? 30) > 100 ||
    !Number.isSafeInteger(input.maxBytes ?? 64 * 1024) || (input.maxBytes ?? 64 * 1024) < 4096 || (input.maxBytes ?? 64 * 1024) > 128 * 1024 ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || /[\0\r\n]/u.test(input.cursor) || input.cursor.length > 32768))) {
    fail('History requires exact Host/Session, explicit source, limit 1–100 and a 4096–131072 byte budget.')
  }
}
function encode(cursor: Cursor): string {
  const body = Buffer.from(JSON.stringify(cursor)).toString('base64url')
  return body + '.' + createHmac('sha256', cursorKey).update(body).digest('base64url')
}
function decode(input: AgentSessionHistoryReadInput): Cursor {
  if (!input.cursor) return { version: 1, hostId: input.hostId, agentSessionId: input.agentSessionId, source: input.source, index: 0, offset: 0 }
  try {
    const parts = input.cursor.split('.')
    if (parts.length !== 2) throw new Error('cursor')
    const signed = createHmac('sha256', cursorKey).update(parts[0]!).digest()
    const signature = Buffer.from(parts[1]!, 'base64url')
    if (signed.length !== signature.length || !timingSafeEqual(signed, signature)) throw new Error('signature')
    const cursor = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Cursor
    if (cursor.version !== 1 || cursor.hostId !== input.hostId || cursor.agentSessionId !== input.agentSessionId || cursor.source !== input.source ||
      !Number.isSafeInteger(cursor.index) || cursor.index < 0 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error('scope')
    return cursor
  } catch { return fail('History cursor belongs to another source, was changed, or expired. Read the first page again.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED') }
}

/** Read at the semantic Host, before any RPC serialization; never connect or operate a Run. */
export async function readAgentSessionHistory(client: Reader, input: AgentSessionHistoryReadInput): Promise<AgentSessionHistoryReadPage> {
  validateSessionHistoryReadInput(input)
  const cursor = decode(input)
  const descriptor = (await client.sessionHistorySources()).find(entry => entry.hostId === input.hostId && entry.agentSessionId === input.agentSessionId)
  if (!descriptor) return fail('No exact retained Session exists at the requested Host.', 'UNKNOWN_AGENT_SESSION')
  const limit = input.limit ?? 30
  let items: Array<AgentSessionHistoryItem | AgentTimelineItem>, revision: string, afterNative: string | null = null
  let nativeSource: AgentSessionHistorySource | undefined
  if (input.source === 'captured') {
    const snapshot = await client.sessionTimeline(input.agentSessionId)
    if (snapshot.agentSessionId !== input.agentSessionId) return fail('Captured history belongs to another Session.', 'CONTROL_PROTOCOL_ERROR')
    // Most recent captured items first; each item retains its original fields and provenance.
    items = [...snapshot.items].reverse()
    revision = digest(JSON.stringify(snapshot))
  } else {
    const page = await client.sessionHistoryPage(input.agentSessionId, {
      limit: cursor.nativeLimit ?? limit, ...(cursor.nativeCursor === undefined ? {} : { cursor: cursor.nativeCursor })
    })
    if (page.agentSessionId !== input.agentSessionId || !descriptor.history?.nativeHandle ||
      page.source.providerId !== descriptor.history.providerId || page.source.nativeSessionId !== descriptor.history.nativeHandle.sessionId) {
      return fail('Native history belongs to another Session source.', 'CONTROL_PROTOCOL_ERROR')
    }
    items = page.items
    nativeSource = page.source
    afterNative = page.nextCursor
    revision = digest(JSON.stringify(page))
  }
  if (cursor.revision !== undefined && cursor.revision !== revision) {
    return fail('History changed during this read. Restart from the first page; no content was skipped.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  }
  if (cursor.index > items.length || cursor.offset && cursor.index === items.length) return fail('History cursor exceeds its source.')
  const budgetBytes = input.maxBytes ?? 64 * 1024
  const result: AgentSessionHistoryReadPage = { hostId: input.hostId, agentSessionId: input.agentSessionId,
    source: input.source, revision, availability: items.length ? 'available' : 'empty',
    order: input.source === 'captured' ? 'newest-first' : 'chronological-page', items: [], nextCursor: null, budgetBytes,
    ...(nativeSource ? { nativeSource } : {}) }
  let index = cursor.index, offset = cursor.offset
  const continuation = (nextIndex: number, nextOffset: number): string | null => {
    if (nextIndex < items.length) return encode({ ...cursor, revision, index: nextIndex, offset: nextOffset,
      ...(input.source === 'native' ? { nativeLimit: cursor.nativeLimit ?? limit } : {}) })
    return input.source === 'native' && afterNative !== null
      ? encode({ version: 1, hostId: input.hostId, agentSessionId: input.agentSessionId, source: input.source,
          index: 0, offset: 0, nativeCursor: afterNative, nativeLimit: cursor.nativeLimit ?? limit }) : null
  }
  const fits = (entry: AgentSessionHistoryReadEntry, next: string | null): boolean =>
    Buffer.byteLength(JSON.stringify({ ...result, items: [...result.items, entry], nextCursor: next })) <= budgetBytes - 1024
  while (index < items.length && result.items.length < limit) {
    const item = items[index]!, bytes = Buffer.from(JSON.stringify(item))
    if (offset > bytes.length) return fail('History cursor exceeds its item.')
    const next = continuation(index + 1, 0)
    const whole: AgentSessionHistoryReadEntry = { kind: 'item', item }
    if (offset === 0 && fits(whole, next)) {
      result.items.push(whole); index++; offset = 0; continue
    }
    // Return exact JSON bytes, including resource parts/provenance; reconstruct before interpreting.
    const fragment = (length: number): AgentSessionHistoryReadEntry => ({ kind: 'fragment', itemId: item.id,
      encoding: 'json-utf8-base64', sha256: digest(bytes), offsetBytes: offset, totalBytes: bytes.length,
      dataBase64: bytes.subarray(offset, offset + length).toString('base64') })
    let low = 0, high = bytes.length - offset
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (fits(fragment(middle), continuation(offset + middle === bytes.length ? index + 1 : index,
        offset + middle === bytes.length ? 0 : offset + middle))) low = middle
      else high = middle - 1
    }
    if (!low) break
    result.items.push(fragment(low)); offset += low
    if (offset === bytes.length) { index++; offset = 0 }
    break
  }
  result.nextCursor = continuation(index, offset)
  if (Buffer.byteLength(JSON.stringify(result)) > budgetBytes - 1024) return fail('History continuation cannot fit the requested budget. Increase --max-bytes.', 'AGENT_SESSION_HISTORY_BUDGET')
  if (index < items.length && result.items.length === 0) return fail('History continuation cannot fit the requested budget. Increase --max-bytes.', 'AGENT_SESSION_HISTORY_BUDGET')
  return result
}

/** The public consumer verifies exact reference, source and serialized budget before accepting data. */
export function parseAgentSessionHistoryReadPage(value: unknown, input: AgentSessionHistoryReadInput): AgentSessionHistoryReadPage {
  const bad = (): never => fail('History result is malformed, over budget or belongs to another source.', 'CONTROL_PROTOCOL_ERROR')
  const page = rpcRecord(value, ['hostId', 'agentSessionId', 'source', 'revision', 'availability', 'order', 'items', 'nextCursor', 'budgetBytes', 'nativeSource'], 'CONTROL_PROTOCOL_ERROR')
  if (page.hostId !== input.hostId || page.agentSessionId !== input.agentSessionId || page.source !== input.source ||
    typeof page.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(page.revision) ||
    !['available', 'empty'].includes(String(page.availability)) ||
    page.order !== (input.source === 'captured' ? 'newest-first' : 'chronological-page') ||
    page.budgetBytes !== (input.maxBytes ?? 64 * 1024) ||
    !Array.isArray(page.items) || page.items.length > (input.limit ?? 30) ||
    !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 32768) ||
    Buffer.byteLength(JSON.stringify(page)) > (input.maxBytes ?? 64 * 1024) - 1024) return bad()
  if (input.source === 'native') {
    const source = rpcRecord(page.nativeSource, ['providerId', 'nativeSessionId'], 'CONTROL_PROTOCOL_ERROR')
    if (!text(source.providerId) || !text(source.nativeSessionId)) return bad()
  } else if (page.nativeSource !== undefined) return bad()
  for (const entry of page.items) {
    const row = rpcRecord(entry, undefined, 'CONTROL_PROTOCOL_ERROR')
    if (row.kind === 'item') {
      rpcRecord(row, ['kind', 'item'], 'CONTROL_PROTOCOL_ERROR')
      const item = rpcRecord(row.item, undefined, 'CONTROL_PROTOCOL_ERROR')
      if (!text(item.id) || input.source === 'captured' && item.agentSessionId !== input.agentSessionId) return bad()
    } else if (row.kind === 'fragment') {
      rpcRecord(row, ['kind', 'itemId', 'encoding', 'sha256', 'offsetBytes', 'totalBytes', 'dataBase64'], 'CONTROL_PROTOCOL_ERROR')
      if (!text(row.itemId) || row.encoding !== 'json-utf8-base64' || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256) ||
        !Number.isSafeInteger(row.offsetBytes) || (row.offsetBytes as number) < 0 || !Number.isSafeInteger(row.totalBytes) ||
        (row.totalBytes as number) <= (row.offsetBytes as number) || typeof row.dataBase64 !== 'string') return bad()
      const bytes = Buffer.from(row.dataBase64, 'base64')
      if (!bytes.length || bytes.toString('base64') !== row.dataBase64 || bytes.length + (row.offsetBytes as number) > (row.totalBytes as number)) return bad()
    } else return bad()
  }
  if (page.availability === 'empty' && page.items.length) return bad()
  return page as AgentSessionHistoryReadPage
}
