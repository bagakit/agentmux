import { parseAgentTurnOutcome, normalizeTurnOutcome } from './turn-outcome.js'
import { parseExternalConversationAuthor } from './external-conversation.js'
export { consumeJsonReadEntry, type JsonReadAssembly, type JsonReadEntry } from './json-read-fragments.js'
import { parseAgentExternalMessageAuthor } from './external-author.js'
import { AgentMuxError } from './errors.js'
import { parseAgentInputJournalCut, parseAgentInputSubmissionObservation } from './agent-input-conversation.js'
import { rpcRecord } from './rpc-data.js'
import { decodeBase64, encodeBase64 } from './hosted-value.js'
import { normalizeMessageChannel } from './message-origin.js'
import { normalizeOperationDevice } from './operation-device.js'
import { normalizeSessionHistoryContentEligibility, normalizeSessionHistoryContentRole, normalizeSessionHistoryMetrics, normalizeSessionHistoryPage, sessionHistoryWithoutMetrics } from './session-history.js'
import { normalizeAgentTimelineMutation } from './session-timeline.js'
import { parseConversationLandmarkRef } from './conversation-landmarks.js'
import { parseConversationProvenance } from './conversation-provenance.js'
import { validateAgentPromptInputKey } from './agent-prompt-condition.js'
import type { AgentSessionHistoryItem, AgentTimelineItem, AgentSessionHistorySource, AgentSessionUserMessage, AgentCapturedTimelineStream } from './types.js'

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
  sourceHostId?: string
  source: 'captured' | 'native'; revision: string; availability: 'available' | 'empty'; order: 'newest-first' | 'chronological-page';
  items: AgentSessionHistoryReadEntry[]; nextCursor: string | null; budgetBytes: number
  nativeSource?: AgentSessionHistorySource
  capturedStream?: AgentCapturedTimelineStream
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
function validateCapturedStream(page: Record<string,unknown>, input: AgentSessionHistoryReadInput): void {
  if(page.capturedStream===undefined)return
  const bad=():never=>fail('Captured history coverage is malformed.','CONTROL_PROTOCOL_ERROR')
  if(input.source!=='captured')return bad()
  const stream=rpcRecord(page.capturedStream,['epoch','sequence','revision','origin','gaps','inputJournal'],'CONTROL_PROTOCOL_ERROR')
  if(stream.inputJournal!==undefined)parseAgentInputJournalCut(stream.inputJournal)
  if(!text(stream.epoch)||!Number.isSafeInteger(stream.sequence)||(stream.sequence as number)<0||!Number.isSafeInteger(stream.revision)||(stream.revision as number)<0||
    !['beginning','retained-prefix','unknown'].includes(String(stream.origin))||!Array.isArray(stream.gaps))return bad()
  for(const value of stream.gaps){const gap=rpcRecord(value,['code','message'],'CONTROL_PROTOCOL_ERROR');if(!text(gap.code)||typeof gap.message!=='string'||!gap.message)return bad()}
}

/** The public consumer verifies exact reference, source and serialized budget before accepting data. */
export function parseAgentSessionHistoryReadPage(value: unknown, input: AgentSessionHistoryReadInput): AgentSessionHistoryReadPage {
  if (input.kind === 'text') return parseTextHistoryPage(value, input)
  if (isUserMessageHistoryRead(input)) return parseUserMessageHistoryPage(value, input)
  const bad = (): never => fail('History result is malformed, over budget or belongs to another source.', 'CONTROL_PROTOCOL_ERROR')
  const page = rpcRecord(value, ['hostId', 'agentSessionId', 'sourceHostId', 'source', 'revision', 'availability', 'order', 'items', 'nextCursor', 'budgetBytes', 'nativeSource', 'capturedStream'], 'CONTROL_PROTOCOL_ERROR')
  validateCapturedStream(page, input)
  if (page.sourceHostId !== undefined && !text(page.sourceHostId)) return fail('Original history source Host is malformed.', 'CONTROL_PROTOCOL_ERROR')
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
  const items: AgentSessionHistoryReadEntry[] = []
  for (const entry of page.items) {
    const row = rpcRecord(entry, undefined, 'CONTROL_PROTOCOL_ERROR')
    if (row.kind === 'item') {
      rpcRecord(row, ['kind', 'item'], 'CONTROL_PROTOCOL_ERROR')
      const item = rpcRecord(row.item, undefined, 'CONTROL_PROTOCOL_ERROR')
      if (!text(item.id) || input.source === 'captured' && item.agentSessionId !== input.agentSessionId) return bad()
      if (input.source === 'native') {
        if (!Array.isArray(item.contentParts)) return bad()
        try { for (const part of item.contentParts) { const value = rpcRecord(part, undefined, 'CONTROL_PROTOCOL_ERROR'); normalizeSessionHistoryContentEligibility(value.contentEligibility); normalizeSessionHistoryContentRole(value.contentRole) } } catch { return bad() }
      }
      if (item.turnOutcome !== undefined) {
        try { parseAgentTurnOutcome(item.turnOutcome, typeof item.turnId === 'string' ? item.turnId : undefined) } catch { return bad() }
      }
      const { metrics: _metrics, metricsDiagnostic: _diagnostic, ...original } = item
      items.push(input.source === 'native' ? { kind: 'item', item: { ...original, ...normalizeSessionHistoryMetrics(item), ...normalizeTurnOutcome(item) } as AgentSessionHistoryItem }
        : row as AgentSessionHistoryReadEntry)
    } else if (row.kind === 'fragment') {
      rpcRecord(row, ['kind', 'itemId', 'encoding', 'sha256', 'offsetBytes', 'totalBytes', 'dataBase64'], 'CONTROL_PROTOCOL_ERROR')
      if (!text(row.itemId) || row.encoding !== 'json-utf8-base64' || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256) ||
        !Number.isSafeInteger(row.offsetBytes) || (row.offsetBytes as number) < 0 || !Number.isSafeInteger(row.totalBytes) ||
        (row.totalBytes as number) <= (row.offsetBytes as number) || typeof row.dataBase64 !== 'string') return bad()
      let bytes: Uint8Array
      try { bytes = decodeBase64(row.dataBase64) } catch { return bad() }
      if (!bytes.length || encodeBase64(bytes) !== row.dataBase64 || bytes.length + (row.offsetBytes as number) > (row.totalBytes as number)) return bad()
      items.push(row as AgentSessionHistoryReadEntry)
    } else return bad()
  }
  if (page.availability === 'empty' && page.items.length) return bad()
  return { ...page, items } as AgentSessionHistoryReadPage
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
  const page = rpcRecord(value, ['hostId', 'agentSessionId', 'sourceHostId', 'source', 'kind', 'revision', 'availability', 'order', 'items', 'scan', 'nextCursor', 'budgetBytes', 'nativeSource', 'capturedStream'], 'CONTROL_PROTOCOL_ERROR')
  validateCapturedStream(page, input)
  if (page.sourceHostId !== undefined && !text(page.sourceHostId)) return fail('Original history source Host is malformed.', 'CONTROL_PROTOCOL_ERROR')
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
  const items: AgentSessionHistoryReadEntry[] = []
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
        items.push(entry as AgentSessionHistoryReadEntry)
      } else {
        const normalized = normalizeSessionHistoryPage(nativeSource as AgentSessionHistorySource, { source: nativeSource, items: [item], nextCursor: null }, 1)
        if (!sameOriginal(sessionHistoryWithoutMetrics(normalized).items[0], sessionHistoryWithoutMetrics({ items: [item] }).items[0])) return bad()
        items.push({ kind: 'item', item: normalized.items[0]! })
      }
    } catch { return bad() }
  }
  return { ...page, items } as AgentSessionHistoryReadPage
}

export function parseUserMessageHistoryPage(value: unknown, input: AgentSessionHistoryReadInput): AgentSessionHistoryReadPage {
  const bad = (): never => fail('User-message history result is malformed or belongs to another query source.', 'CONTROL_PROTOCOL_ERROR')
  const page = rpcRecord(value, ['hostId', 'agentSessionId', 'sourceHostId', 'source', 'kind', 'revision', 'availability', 'order', 'items', 'userMessages', 'scan', 'nextCursor', 'budgetBytes', 'nativeSource', 'capturedStream'], 'CONTROL_PROTOCOL_ERROR')
  validateCapturedStream(page, input)
  if (page.sourceHostId !== undefined && !text(page.sourceHostId)) return fail('Original history source Host is malformed.', 'CONTROL_PROTOCOL_ERROR')
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
    const message = rpcRecord(value, ['id', 'rawId', 'agentSessionId', 'turnId', 'source', 'sourceRecord', 'inputRef', 'inputSubmission', 'conversation', 'author', 'publicContent', 'content', 'contentParts', 'questionAnswers', 'questionDiagnostic', 'recordedAt', 'deliveryStatus'], 'CONTROL_PROTOCOL_ERROR')
    if (typeof message.id !== 'string' || !message.id || typeof message.rawId !== 'string' || !message.rawId || message.agentSessionId !== input.agentSessionId || typeof message.content !== 'string' ||
      !Array.isArray(message.contentParts) || message.recordedAt !== undefined && (!Number.isSafeInteger(message.recordedAt) || (message.recordedAt as number) < 0) ||
      message.deliveryStatus !== undefined && !['complete', 'failed', 'unverified'].includes(String(message.deliveryStatus))) return bad()
    if (message.publicContent !== undefined && message.publicContent !== 'confirmed' && message.publicContent !== 'unknown') return bad()
    const source = rpcRecord(message.source, input.source === 'native' ? ['kind', 'providerId', 'nativeSessionId', 'recordId'] : ['kind', 'submissionId', 'channel', 'device'], 'CONTROL_PROTOCOL_ERROR')
    try {
      if (message.inputRef !== undefined) {
        const key = validateAgentPromptInputKey(message.inputRef)
        if (input.source !== 'captured' || message.publicContent !== 'confirmed' || key.agentSessionId !== message.agentSessionId || !sameOriginal(key, message.inputRef)) return bad()
      }
      if (message.conversation !== undefined) {
        const original = rpcRecord(message.conversation, ['sameEvent', 'nativeInput', 'adoptedInput'], 'CONTROL_PROTOCOL_ERROR')
        // Original optional claims remain readable even when the relation matcher cannot use them.
        if (!sameOriginal(parseConversationProvenance(original), original)) return bad()
      }
    } catch { return bad() }
    if (message.sourceRecord !== undefined) {
      try {
        const boundary = rpcRecord(message.sourceRecord, ['record', 'revision'], 'CONTROL_PROTOCOL_ERROR')
        const reference = parseConversationLandmarkRef(boundary.record)
        if (typeof boundary.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(boundary.revision) ||
          reference.hostId !== page.sourceHostId || reference.agentSessionId !== message.agentSessionId ||
          reference.source.kind !== source.kind || reference.source.recordId !== message.rawId ||
          reference.source.kind === 'native' && (reference.source.providerId !== source.providerId || reference.source.nativeSessionId !== source.nativeSessionId)) return bad()
      } catch { return bad() }
    }
    const author = rpcRecord(message.author, undefined, 'CONTROL_PROTOCOL_ERROR')
    if (message.inputSubmission !== undefined) {
      if (input.source !== 'captured' || message.publicContent !== 'confirmed' || !message.inputRef || author.kind !== 'human') return bad()
      parseAgentInputSubmissionObservation(message.inputSubmission)
    }
    try { if (author.kind === 'external') ('grantId' in author ? parseAgentExternalMessageAuthor(author) : parseExternalConversationAuthor(author)); else rpcRecord(author, ['kind', 'agentSessionId'], 'CONTROL_PROTOCOL_ERROR') } catch { return bad() }
    if (input.source === 'native') {
      if (message.publicContent === 'confirmed') return bad()
      if (source.kind !== 'native' || source.providerId !== nativeSource!.providerId || source.nativeSessionId !== nativeSource!.nativeSessionId || source.recordId !== message.rawId || author.kind !== 'unknown' || author.agentSessionId !== undefined || message.deliveryStatus !== undefined) return bad()
    } else {
      if (source.kind !== 'captured' || source.submissionId !== message.rawId || !['human', 'agent', 'external', 'unknown'].includes(String(author.kind)) ||
        (author.kind === 'agent' ? typeof author.agentSessionId !== 'string' || !author.agentSessionId : author.agentSessionId !== undefined)) return bad()
      try {
        if (source.channel !== undefined) normalizeMessageChannel(source.channel)
        if (source.device !== undefined) normalizeOperationDevice(source.device)
      } catch { return bad() }
    }
    if (message.questionDiagnostic !== undefined) rpcRecord(message.questionDiagnostic, ['code', 'message'], 'CONTROL_PROTOCOL_ERROR')
    try { normalizeSessionHistoryPage({ providerId: 'query-validation', nativeSessionId: 'query-validation' }, {
      source: { providerId: 'query-validation', nativeSessionId: 'query-validation' }, nextCursor: null,
      items: [{ id: message.rawId, kind: 'user-message', contentParts: message.contentParts, ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        ...(message.questionAnswers === undefined ? {} : { questionAnswers: message.questionAnswers }),
        ...(message.questionDiagnostic === undefined ? {} : { questionDiagnostic: message.questionDiagnostic }) }]
    }, 1) } catch { return bad() }
  }
  return page as AgentSessionHistoryReadPage
}
