import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { decodeBase64, encodeBase64 } from './hosted-value.js'
import { normalizeMessageChannel } from './message-origin.js'
import { normalizeOperationDevice } from './operation-device.js'
import { normalizeSessionHistoryPage } from './session-history.js'
import { normalizeAgentTimelineMutation } from './session-timeline.js'
import type { AgentSessionHistoryItem, AgentTimelineItem, AgentSessionHistorySource, AgentSessionUserMessage } from './types.js'

// Pure wire/data contract. Host readers own crypto, source IO and read leases;
// Hosted/browser consumers validate the same result without importing those owners.
const encoder = new TextEncoder()
const byteLength = (value: string) => encoder.encode(value).byteLength
const fail = (message: string, code = 'INVALID_AGENT_SESSION_HISTORY_OPTIONS'): never => { throw new AgentMuxError(message, code) }

/** A read reference carries neither a Run lease nor native/input authority. */
export type AgentSessionContextReference = { hostId: string; agentSessionId: string }
export type AgentSessionHistoryReadInput = AgentSessionContextReference & {
  source: 'captured' | 'native'; limit?: number; cursor?: string; maxBytes?: number
  /** Explicit query view of the original source; text keeps original records, user-message projects inputs. */
  kind?: 'user-message' | 'text'
  /** Case-sensitive literal text, not a regular expression. Defaults to kind=user-message. */
  query?: string
  /** Maximum original records examined, independently of the matching-result limit. */
  scanLimit?: number
}
export type AgentSessionHistoryReadEntry =
  | { kind: 'item'; item: AgentSessionHistoryItem | AgentTimelineItem }
  | { kind: 'fragment'; itemId: string; encoding: 'json-utf8-base64'; sha256: string;
      offsetBytes: number; totalBytes: number; dataBase64: string }
export type AgentSessionHistoryReadPage = AgentSessionContextReference & {
  source: 'captured' | 'native'; revision: string; availability: 'available' | 'empty'; order: 'newest-first' | 'chronological-page';
  items: AgentSessionHistoryReadEntry[]; nextCursor: string | null; budgetBytes: number
  nativeSource?: AgentSessionHistorySource
  /** Text queries retain original items; user-message queries project only original inputs. */
  kind?: 'user-message' | 'text'
  userMessages?: AgentSessionUserMessage[]
  scan?: { examined: number; complete: boolean }
}
export function isUserMessageHistoryRead(input: AgentSessionHistoryReadInput): boolean { return input.kind === 'user-message' || input.kind === undefined && input.query !== undefined }
export function isSessionHistoryQuery(input: AgentSessionHistoryReadInput): boolean { return input.kind === 'text' || isUserMessageHistoryRead(input) }
export function historyReadBudget(input: AgentSessionHistoryReadInput): number { return input.maxBytes ?? (isSessionHistoryQuery(input) ? 1024 * 1024 : 64 * 1024) }
function text(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value) && !/[\0\r\n]/u.test(value) && byteLength(value) <= 4096
}
export function validateSessionHistoryReadInput(input: AgentSessionHistoryReadInput): void {
  if (!text(input.hostId) || !text(input.agentSessionId) || input.agentSessionId === 'self' ||
    !['captured', 'native'].includes(input.source) ||
    !Number.isSafeInteger(input.limit ?? 30) || (input.limit ?? 30) < 1 || (input.limit ?? 30) > 100 ||
    !Number.isSafeInteger(historyReadBudget(input)) || historyReadBudget(input) < 4096 || historyReadBudget(input) > (isSessionHistoryQuery(input) ? 16 * 1024 * 1024 : 128 * 1024) ||
    (input.kind !== undefined && !['user-message', 'text'].includes(input.kind)) ||
    (input.query !== undefined && (typeof input.query !== 'string' || input.query.includes('\0') || byteLength(input.query) > 4096)) ||
    (input.scanLimit !== undefined && (!isSessionHistoryQuery(input) || !Number.isSafeInteger(input.scanLimit) || input.scanLimit < 1 || input.scanLimit > 1000)) ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || /[\0\r\n]/u.test(input.cursor) || input.cursor.length > 32768))) {
    fail('History requires exact Host/Session, explicit source, limit 1–100 and a bounded byte budget; user-message/text queries accept a literal string and scanLimit 1–1000.')
  }
}
/** The public consumer verifies exact reference, source and serialized budget before accepting data. */
export function parseAgentSessionHistoryReadPage(value: unknown, input: AgentSessionHistoryReadInput): AgentSessionHistoryReadPage {
  if (input.kind === 'text') return parseTextHistoryPage(value, input)
  if (isUserMessageHistoryRead(input)) return parseUserMessageHistoryPage(value, input)
  const bad = (): never => fail('History result is malformed, over budget or belongs to another source.', 'CONTROL_PROTOCOL_ERROR')
  const page = rpcRecord(value, ['hostId', 'agentSessionId', 'source', 'revision', 'availability', 'order', 'items', 'nextCursor', 'budgetBytes', 'nativeSource'], 'CONTROL_PROTOCOL_ERROR')
  if (page.hostId !== input.hostId || page.agentSessionId !== input.agentSessionId || page.source !== input.source ||
    typeof page.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(page.revision) ||
    !['available', 'empty'].includes(String(page.availability)) ||
    page.order !== (input.source === 'captured' ? 'newest-first' : 'chronological-page') ||
    page.budgetBytes !== (input.maxBytes ?? 64 * 1024) ||
    !Array.isArray(page.items) || page.items.length > (input.limit ?? 30) ||
    !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 32768) ||
    byteLength(JSON.stringify(page)) > (input.maxBytes ?? 64 * 1024) - 1024) return bad()
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
      let bytes: Uint8Array
      try { bytes = decodeBase64(row.dataBase64) } catch { return bad() }
      if (!bytes.length || encodeBase64(bytes) !== row.dataBase64 || bytes.length + (row.offsetBytes as number) > (row.totalBytes as number)) return bad()
    } else return bad()
  }
  if (page.availability === 'empty' && page.items.length) return bad()
  return page as AgentSessionHistoryReadPage
}

/** Normalizers own record semantics; wire validation must also reject discarded or rewritten fields. */
function sameOriginal(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>, keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameOriginal(a[key], b[key]))
}

function parseTextHistoryPage(value: unknown, input: AgentSessionHistoryReadInput): AgentSessionHistoryReadPage {
  const bad = (): never => fail('Text history result is malformed or belongs to another query source.', 'CONTROL_PROTOCOL_ERROR')
  const page = rpcRecord(value, ['hostId', 'agentSessionId', 'source', 'kind', 'revision', 'availability', 'order', 'items', 'scan', 'nextCursor', 'budgetBytes', 'nativeSource'], 'CONTROL_PROTOCOL_ERROR')
  const scan = rpcRecord(page.scan, ['examined', 'complete'], 'CONTROL_PROTOCOL_ERROR')
  if (page.hostId !== input.hostId || page.agentSessionId !== input.agentSessionId || page.source !== input.source || page.kind !== 'text' ||
    typeof page.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(page.revision) || page.order !== 'newest-first' ||
    !Array.isArray(page.items) || page.items.length > (input.limit ?? 30) || !Number.isSafeInteger(scan.examined) ||
    (scan.examined as number) < page.items.length || (scan.examined as number) > (input.scanLimit ?? 200) || typeof scan.complete !== 'boolean' ||
    !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 32768) ||
    scan.complete !== (page.nextCursor === null) || page.budgetBytes !== historyReadBudget(input) ||
    byteLength(JSON.stringify(page)) > historyReadBudget(input) - 1024 ||
    page.availability !== (page.items.length ? 'available' : 'empty')) return bad()
  const nativeSource = input.source === 'native' ? rpcRecord(page.nativeSource, ['providerId', 'nativeSessionId'], 'CONTROL_PROTOCOL_ERROR') : undefined
  if (input.source === 'captured' && page.nativeSource !== undefined || nativeSource && (!text(nativeSource.providerId) || !text(nativeSource.nativeSessionId))) return bad()
  const ids = new Set<string>()
  for (const value of page.items) {
    const entry = rpcRecord(value, ['kind', 'item'], 'CONTROL_PROTOCOL_ERROR')
    if (entry.kind !== 'item') return bad()
    const item = rpcRecord(entry.item, undefined, 'CONTROL_PROTOCOL_ERROR')
    if (!text(item.id) || ids.has(item.id)) return bad()
    ids.add(item.id)
    try {
      if (input.source === 'captured') {
        if (item.agentSessionId !== input.agentSessionId) return bad()
        const normalized = normalizeAgentTimelineMutation({ type: 'append', agentSessionId: input.agentSessionId, item })
        if (normalized.type !== 'append' || !sameOriginal(normalized.item, item)) return bad()
      } else {
        const normalized = normalizeSessionHistoryPage(nativeSource as AgentSessionHistorySource, { source: nativeSource, items: [item], nextCursor: null }, 1)
        if (!sameOriginal(normalized.items[0], item)) return bad()
      }
    } catch { return bad() }
  }
  return page as AgentSessionHistoryReadPage
}

export function parseUserMessageHistoryPage(value: unknown, input: AgentSessionHistoryReadInput): AgentSessionHistoryReadPage {
  const bad = (): never => fail('User-message history result is malformed or belongs to another query source.', 'CONTROL_PROTOCOL_ERROR')
  const page = rpcRecord(value, ['hostId', 'agentSessionId', 'source', 'kind', 'revision', 'availability', 'order', 'items', 'userMessages', 'scan', 'nextCursor', 'budgetBytes', 'nativeSource'], 'CONTROL_PROTOCOL_ERROR')
  const scan = rpcRecord(page.scan, ['examined', 'complete'], 'CONTROL_PROTOCOL_ERROR')
  if (page.hostId !== input.hostId || page.agentSessionId !== input.agentSessionId || page.source !== input.source || page.kind !== 'user-message' ||
    typeof page.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(page.revision) || page.order !== 'newest-first' || !Array.isArray(page.items) || page.items.length ||
    !Array.isArray(page.userMessages) || page.userMessages.length > (input.limit ?? 30) || !Number.isSafeInteger(scan.examined) || (scan.examined as number) < 0 ||
    (scan.examined as number) > (input.scanLimit ?? 200) || typeof scan.complete !== 'boolean' ||
    !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 32768) ||
    scan.complete !== (page.nextCursor === null) || page.budgetBytes !== (input.maxBytes ?? 1024 * 1024) ||
    byteLength(JSON.stringify(page)) > (input.maxBytes ?? 1024 * 1024) - 1024 ||
    page.availability !== (page.userMessages.length ? 'available' : 'empty')) return bad()
  const nativeSource = input.source === 'native' ? rpcRecord(page.nativeSource, ['providerId', 'nativeSessionId'], 'CONTROL_PROTOCOL_ERROR') : undefined
  if (input.source === 'captured' && page.nativeSource !== undefined || nativeSource &&
    (typeof nativeSource.providerId !== 'string' || !nativeSource.providerId || typeof nativeSource.nativeSessionId !== 'string' || !nativeSource.nativeSessionId)) return bad()
  for (const value of page.userMessages) {
    const message = rpcRecord(value, ['id', 'rawId', 'agentSessionId', 'turnId', 'source', 'author', 'content', 'contentParts', 'questionAnswers', 'recordedAt', 'deliveryStatus'], 'CONTROL_PROTOCOL_ERROR')
    if (typeof message.id !== 'string' || !message.id || typeof message.rawId !== 'string' || !message.rawId || message.agentSessionId !== input.agentSessionId || typeof message.content !== 'string' ||
      !Array.isArray(message.contentParts) || message.recordedAt !== undefined && (!Number.isSafeInteger(message.recordedAt) || (message.recordedAt as number) < 0) ||
      message.deliveryStatus !== undefined && !['complete', 'failed', 'unverified'].includes(String(message.deliveryStatus))) return bad()
    const source = rpcRecord(message.source, input.source === 'native' ? ['kind', 'providerId', 'nativeSessionId', 'recordId'] : ['kind', 'submissionId', 'channel', 'device'], 'CONTROL_PROTOCOL_ERROR')
    const author = rpcRecord(message.author, ['kind', 'agentSessionId'], 'CONTROL_PROTOCOL_ERROR')
    if (input.source === 'native') {
      if (source.kind !== 'native' || source.providerId !== nativeSource!.providerId || source.nativeSessionId !== nativeSource!.nativeSessionId || source.recordId !== message.rawId || author.kind !== 'unknown' || author.agentSessionId !== undefined || message.deliveryStatus !== undefined) return bad()
    } else {
      if (source.kind !== 'captured' || source.submissionId !== message.rawId || !['human', 'agent', 'unknown'].includes(String(author.kind)) ||
        (author.kind === 'agent' ? typeof author.agentSessionId !== 'string' || !author.agentSessionId : author.agentSessionId !== undefined)) return bad()
      try {
        if (source.channel !== undefined) normalizeMessageChannel(source.channel)
        if (source.device !== undefined) normalizeOperationDevice(source.device)
      } catch { return bad() }
    }
    try { normalizeSessionHistoryPage({ providerId: 'query-validation', nativeSessionId: 'query-validation' }, {
      source: { providerId: 'query-validation', nativeSessionId: 'query-validation' }, nextCursor: null,
      items: [{ id: message.rawId, kind: 'user-message', contentParts: message.contentParts, ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        ...(message.questionAnswers === undefined ? {} : { questionAnswers: message.questionAnswers }) }]
    }, 1) } catch { return bad() }
  }
  return page as AgentSessionHistoryReadPage
}
