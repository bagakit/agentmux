import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import type { AgentMuxClient } from './client.js'
import type { AgentSessionHistoryItem, AgentTimelineItem, AgentSessionHistorySource, AgentSessionHistoryDescriptor } from './types.js'
import { readAgentUserMessageHistory } from './session-history-query.js'

export * from './session-history-read-codec.js'
import { validateSessionHistoryReadInput, isUserMessageHistoryRead, type AgentSessionContextReference, type AgentSessionHistoryReadInput, type AgentSessionHistoryReadPage, type AgentSessionHistoryReadEntry } from './session-history-read-codec.js'

export type AgentSessionHistoryReader = Pick<AgentMuxClient, 'sessionHistorySources' | 'sessionTimeline' | 'sessionHistoryPage' | 'sessionHistoryResource'>
type Reader = Pick<AgentSessionHistoryReader, 'sessionHistorySources' | 'sessionTimeline' | 'sessionHistoryPage'> & Partial<Pick<AgentSessionHistoryReader, 'sessionHistoryResource'>>
/** Host-local owner port, never a wire parameter or caller-supplied source fact. */
export type AgentSessionHistoryReadContext = { signal?: AbortSignal; resolveSource?: (agentSessionId: string) => Promise<AgentSessionHistoryDescriptor> }
type Cursor = AgentSessionContextReference & { version: 1; source: 'captured' | 'native';
  revision?: string; index: number; offset: number; nativeCursor?: string; nativeLimit?: number }
// A cursor is a scoped read continuation, not a second history ledger. Host restart invalidates it.
const cursorKey = randomBytes(32)
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fail = (message: string, code = 'INVALID_AGENT_SESSION_HISTORY_OPTIONS'): never => {
  throw new AgentMuxError(message, code)
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
export async function readAgentSessionHistory(client: Reader, input: AgentSessionHistoryReadInput, options: AgentSessionHistoryReadContext = {}): Promise<AgentSessionHistoryReadPage> {
  validateSessionHistoryReadInput(input)
  options.signal?.throwIfAborted()
  if (isUserMessageHistoryRead(input)) return await readAgentUserMessageHistory(client, input, options)
  const cursor = decode(input)
  const descriptor = options.resolveSource ? await options.resolveSource(input.agentSessionId)
    : (await client.sessionHistorySources()).find(entry => entry.hostId === input.hostId && entry.agentSessionId === input.agentSessionId)
  if (!descriptor || descriptor.hostId !== input.hostId || descriptor.agentSessionId !== input.agentSessionId) return fail('No exact retained Session exists at the requested Host.', 'UNKNOWN_AGENT_SESSION')
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
      limit: cursor.nativeLimit ?? limit, ...(cursor.nativeCursor === undefined ? {} : { cursor: cursor.nativeCursor }), ...(options.signal ? { signal: options.signal } : {})
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
