import { conversationProcessWitness, deferConversationProcessRecord, isCompleteConversationRecord, type ConversationDeferredRecord, type ConversationReadRecord } from './conversation-process-detail.js'
export { isCompleteConversationRecord } from './conversation-process-detail.js'
export type { ConversationProcessPart, ConversationProcessHeader, ConversationDeferredRecord, ConversationReadRecord } from './conversation-process-detail.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { normalizeSessionHistoryPage } from './session-history.js'
import { normalizeAgentTimelineItem } from './session-timeline.js'
import { parseConversationProvenance } from './conversation-provenance.js'
import { conversationRecordId, conversationRevision, conversationValuesEqual, conversationRecordRole, conversationEventAuthor, conversationSourceKey, conversationInvocationMembers, conversationRecordRelations, conversationSameEventTarget, conversationRecordAnchors, conversationEventCoalesces, conversationInputAdoptionEdges, mergeConversationInputAdoptionContexts, conversationNativeInputWitness, conversationInputKey,
  type ConversationEvent, type ConversationSourceRecord, type ConversationSourceRef, type ConversationSourceCoverage, type ConversationTimeline } from './conversation-stream.js'
import { parseNativeConversationCheckpoint, parseConversationRef, type NativeConversationCheckpoint } from './session-history-changes.js'
import type { ConversationRef, ConversationItemRef } from './conversation.js'
import { consumeJsonReadEntry, type JsonReadAssembly, type JsonReadEntry } from './json-read-fragments.js'
import { validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { parseAgentInputJournalCut } from './agent-input-conversation.js'
export { parseConversationRef } from './session-history-changes.js'
export * from './session-history-changes.js'

export const CONVERSATION_DEFAULT_READ_BYTES = 64 * 1024
export const CONVERSATION_MAX_READ_BYTES = 4 * 1024 * 1024
export const CONVERSATION_MAX_UNIT_BYTES = 32 * 1024 * 1024
export const CONVERSATION_MAX_WINDOW_RECORDS = 1200
export type ConversationScope = { sources: readonly ConversationSourceRef[] }
export type ConversationFrontier = ConversationRef & { scope: ConversationScope; cuts: readonly (
  | { kind: 'native'; checkpoint: NativeConversationCheckpoint }
  | { kind: 'captured'; epoch: string; sequence: number; inputJournal?: import('./agent-input-conversation.js').AgentInputJournalCut }
)[] }
export type ConversationCheckpoint = ConversationRef & { sourceHostId: string; frontier: ConversationFrontier }
export type ConversationVersionedAnchor = { record: ConversationItemRef; revision: string; frontier: ConversationCheckpoint }
export type ConversationTimelineReadInput = ConversationRef & { limit?: number; cursor?: string; maxBytes?: number; record?: ConversationItemRef; anchor?: ConversationVersionedAnchor; view?: string; nativeSource?: { providerId: string; nativeSessionId: string };
  /** Older expansion must retain every accepted contribution or leave the original view unchanged. */
  preserveCurrent?: boolean; processDetails?: 'deferred' }
export type ConversationUnit = { event: ConversationEvent; records: readonly ConversationReadRecord[] }
export type ConversationUnitEntry = JsonReadEntry<ConversationUnit>
export type ConversationWindowBoundary = { record: ConversationItemRef; revision: string }
/** A complete replacement of one backend-owned accepted window, never an append delta. */
export type ConversationReadWindow = { id: string; revision: number; itemCount: number; complete: boolean;
  view: string | null; replay: string; checkpoint: ConversationCheckpoint; anchor?: ConversationVersionedAnchor;
  outside: { older: ConversationWindowBoundary | null; newer: ConversationWindowBoundary | null };
  navigation: { older: string | null; newer: string | null } }
export type AgentConversationReadPage = ConversationRef & { sourceHostId: string; scope: ConversationScope; coverage: readonly ConversationSourceCoverage[];
  order: ConversationTimeline['order'] & { direction: 'newest-first' }; items: readonly ConversationUnitEntry[]; nextCursor: string | null; budgetBytes: number; window: ConversationReadWindow; processDetails?: 'deferred' }
export type ConversationCheckpointPage = ConversationRef & { sourceHostId: string; scope: ConversationScope; checkpoint: ConversationCheckpoint; coverage: readonly ConversationSourceCoverage[] }
/** Native position only; captured sources retain their current independent cut. Reading grants no sharing authority. */
export type ConversationCheckpointInput = ConversationRef & { nativePosition?: 'beginning' }
export type ConversationChangesInput = ConversationRef & { checkpoint: ConversationCheckpoint; limit?: number; maxBytes?: number; cursor?: string; view?: string; processDetails?: 'deferred' }
export type ConversationChangesPage = AgentConversationReadPage & { checkpoint: ConversationCheckpoint; more: boolean }
export type ConversationWatchInput = ConversationRef & { view?: string }
export type ConversationViewReleaseInput = ConversationRef & { view: string }
export type ConversationViewReleaseResult = ConversationRef & { sourceHostId: string; viewId: string; released: boolean }
export type ConversationWatchOpening = ConversationRef & { sourceHostId: string; scope: ConversationScope; coverage: readonly ConversationSourceCoverage[] }
export type ConversationObservation = ConversationRef & { sourceHostId: string; source: ConversationSourceRef; kind: 'invalidated' | 'unavailable'; code?: string; message?: string }
export type ConversationObservationHandle = ConversationWatchOpening & { closed: AbortSignal; dispose(): void }
/** Cancellation owns this read lease, never the original Agent or its source namespace. */
export type ConversationReadOptions = { signal?: AbortSignal }
export type ConversationWindowSnapshot = Omit<AgentConversationReadPage, 'items'> & { units: readonly ConversationUnit[] }
export type ConversationWindowAssembly = { scopeKey: string; windowId: string; revision: number; itemCount: number;
  units: readonly ConversationUnit[]; bytes: number; eventIds: ReadonlySet<string>; recordIds: ReadonlySet<string>; fragment?: JsonReadAssembly }

// One immutable response owns its complete-unit validation. This never crosses the
// wire: copied/raw pages and completed fragments still enter the strict parser.
const parsedPageOwner = Symbol('conversation-page-owner'), pageOwnerToken = {}
class ConversationPageOwner {
  #page: AgentConversationReadPage
  constructor(token: object, page: AgentConversationReadPage) {
    if (token !== pageOwnerToken) bad('A conversation page needs its original parser owner.')
    this.#page = page
  }
  static owns(page: unknown): page is AgentConversationReadPage {
    if (page === null || typeof page !== 'object') return false
    const owner: unknown = Object.getOwnPropertyDescriptor(page, parsedPageOwner)?.value
    return typeof owner === 'object' && owner !== null && #page in owner && owner.#page === page
  }
}
// The nonenumerable owner can be inspected by local JavaScript. Reflection must
// not let that caller replace the module's private-field validation method.
Object.freeze(ConversationPageOwner)
Object.freeze(ConversationPageOwner.prototype)
function immutablePageValue<T>(value: T): T {
  // Copy before freezing: strict DTO normalization may retain nested source values.
  // A parser must not freeze its caller's original input as a side effect.
  if (Array.isArray(value)) return Object.freeze(value.map(immutablePageValue)) as T
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, immutablePageValue(item)]))) as T
  return value
}
function ownParsedPage<T extends AgentConversationReadPage>(page: T): T {
  const owned = Object.fromEntries(Object.entries(page).map(([key, value]) => [key, immutablePageValue(value)])) as T
  Object.defineProperty(owned, parsedPageOwner, { value: Object.freeze(new ConversationPageOwner(pageOwnerToken, owned)) })
  return Object.freeze(owned)
}

/** Wire assembly only. Semantic accumulation and replacement belong to the backend Reader. */
export function consumeConversationWindowPage(page: AgentConversationReadPage, pending?: ConversationWindowAssembly):
  { kind: 'pending'; pending: ConversationWindowAssembly } | { kind: 'complete'; snapshot: ConversationWindowSnapshot } {
  const validated = ConversationPageOwner.owns(page)
  const scopeKey = JSON.stringify([page.hostId, page.sourceHostId, page.agentSessionId, page.scope, page.window.anchor, page.processDetails])
  if (pending && (pending.scopeKey !== scopeKey || pending.windowId !== page.window.id || pending.revision !== page.window.revision || pending.itemCount !== page.window.itemCount)) return bad('A window fragment belongs to another original scope or revision.')
  const units = [...(pending?.units ?? [])]
  const eventIds = new Set(pending?.eventIds), recordIds = new Set(pending?.recordIds)
  let fragment = pending?.fragment, length = pending?.bytes ?? 0
  for (const entry of page.items) {
    const consumed = consumeJsonReadEntry({ entry, scopeKey: JSON.stringify([scopeKey, page.window.id, page.window.revision]), ...(fragment ? { pending: fragment } : {}), maxTotalBytes: CONVERSATION_MAX_UNIT_BYTES })
    if (consumed.kind === 'pending') { fragment = consumed.pending; continue }
    const unit = validated && entry.kind === 'item' ? entry.item
      : parseConversationUnit(consumed.value, { hostId: page.sourceHostId, agentSessionId: page.agentSessionId }, page.scope)
    if (page.processDetails !== 'deferred' && unit.records.some(record => !isCompleteConversationRecord(record))) return bad('Deferred process body was not requested.')
    if (entry.kind === 'fragment' && entry.itemId !== unit.event.id || eventIds.has(unit.event.id) || unit.records.some(record => recordIds.has(record.id))) return bad('The replacement window repeats an event or original contribution.')
    eventIds.add(unit.event.id); for (const record of unit.records) recordIds.add(record.id)
    fragment = undefined; units.push(unit); length += bytes(unit)
    if (recordIds.size > CONVERSATION_MAX_WINDOW_RECORDS || length > CONVERSATION_MAX_UNIT_BYTES || units.length > page.window.itemCount) return bad('The replacement window exceeds its original bounded inventory.')
  }
  if (!page.window.complete) {
    if (!page.nextCursor) return bad('An incomplete window has no exact continuation.')
    return { kind: 'pending', pending: { scopeKey, windowId: page.window.id, revision: page.window.revision, itemCount: page.window.itemCount, units, bytes: length, eventIds, recordIds, ...(fragment ? { fragment } : {}) } }
  }
  if (fragment || units.length !== page.window.itemCount || !page.window.view) return bad('The replacement window is incomplete.')
  if (page.window.anchor && units.flatMap(unit => unit.records).some(record => !same(record.reference, page.window.anchor!.record) || record.revision !== page.window.anchor!.revision)) return bad('The exact-anchor window contains another original record or version.')
  const originals = units.flatMap(unit => unit.records).filter(isCompleteConversationRecord)
  const adoption = conversationInputAdoptionEdges(originals, mergeConversationInputAdoptionContexts(units.map(unit => ({ records: unit.records.filter(isCompleteConversationRecord), context: unit.event.inputAdoption }))))
  for (const unit of units) for (const record of unit.records) if (isCompleteConversationRecord(record) && record.original.kind === 'captured' && conversationInputKey(record) && !record.original.item.conversation?.sameEvent) {
    const target = adoption.targets.get(record.id), actual = unit.event.relations.find(relation => relation.kind === 'same-event' && conversationRecordId(relation.from) === record.id)
    if (target ? !actual || actual.kind !== 'same-event' || !same(target, actual.to) : actual !== undefined) return bad('Native adoption contradicts the complete accepted window or its retained counterevidence.')
  }
  const { items: _items, ...envelope } = page
  return { kind: 'complete', snapshot: { ...envelope, units } }
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const bad = (message = 'Conversation data changed scope, version or shape.', code = 'CONTROL_PROTOCOL_ERROR'): never => { throw new AgentMuxError(message, code) }
function text(value: unknown, maximum = 16_384): string {
  if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value) || new TextEncoder().encode(value).length > maximum) return bad()
  return value
}
function message(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || new TextEncoder().encode(value).length > 65_536) return bad()
  return value
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) return bad()
  return Number(value)
}
function same(a: unknown, b: unknown): boolean { return conversationValuesEqual(a, b) }
export function parseConversationSource(value: unknown): ConversationSourceRef {
  const p = rpcRecord(value, ['kind', 'providerId', 'nativeSessionId', 'epoch'], 'CONTROL_PROTOCOL_ERROR')
  if (p.kind === 'native') {
    if (p.epoch !== undefined) return bad()
    return { kind: 'native', providerId: text(p.providerId), nativeSessionId: text(p.nativeSessionId) }
  }
  if (p.kind === 'native-unavailable') {
    if (p.epoch !== undefined || p.nativeSessionId !== undefined) return bad()
    return { kind: 'native-unavailable', providerId: text(p.providerId) }
  }
  if (p.kind !== 'captured' || p.providerId !== undefined || p.nativeSessionId !== undefined) return bad()
  return { kind: 'captured', ...(p.epoch === undefined ? {} : { epoch: text(p.epoch) }) }
}
function scope(value: unknown): ConversationScope {
  const p = rpcRecord(value, ['sources'], 'CONTROL_PROTOCOL_ERROR')
  if (!Array.isArray(p.sources) || p.sources.length > 16) return bad()
  const sources = p.sources.map(parseConversationSource)
  if (new Set(sources.map(conversationSourceKey)).size !== sources.length) return bad()
  return { sources }
}
export function parseConversationCheckpointInput(value: unknown): ConversationCheckpointInput {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'nativePosition'])
  const ref = parseConversationRef({ hostId: p.hostId, agentSessionId: p.agentSessionId })
  if (p.nativePosition !== undefined && p.nativePosition !== 'beginning') return bad('Native checkpoint position must be beginning when supplied.', 'INVALID_CONTROL_REQUEST')
  return { ...ref, ...(p.nativePosition === undefined ? {} : { nativePosition: 'beginning' as const }) }
}
export function parseConversationFrontier(value: unknown, expected?: ConversationRef): ConversationFrontier {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'scope', 'cuts'], 'CONTROL_PROTOCOL_ERROR')
  const ref = parseConversationRef({ hostId: p.hostId, agentSessionId: p.agentSessionId }), accepted = scope(p.scope)
  if (expected && (ref.hostId !== expected.hostId || ref.agentSessionId !== expected.agentSessionId) || !Array.isArray(p.cuts) || p.cuts.length > accepted.sources.length) return bad()
  const seen = new Set<string>()
  const cuts = p.cuts.map(value => {
    const cut = rpcRecord(value, ['kind', 'checkpoint', 'epoch', 'sequence', 'inputJournal'], 'CONTROL_PROTOCOL_ERROR')
    let result: ConversationFrontier['cuts'][number], source: ConversationSourceRef
    if (cut.kind === 'native') {
      if (cut.epoch !== undefined || cut.sequence !== undefined || cut.inputJournal !== undefined) return bad()
      const checkpoint = parseNativeConversationCheckpoint(cut.checkpoint)
      if (checkpoint.agentSessionId !== ref.agentSessionId) return bad()
      source = { kind: 'native', ...checkpoint.source }; result = { kind: 'native', checkpoint }
    } else {
      if (cut.kind !== 'captured' || cut.checkpoint !== undefined) return bad()
      const epoch = text(cut.epoch), sequence = integer(cut.sequence)
      source = { kind: 'captured', epoch }; result = { kind: 'captured', epoch, sequence, ...(cut.inputJournal === undefined ? {} : { inputJournal: parseAgentInputJournalCut(cut.inputJournal) }) }
    }
    const key = conversationSourceKey(source)
    if (seen.has(key) || !accepted.sources.some(value => conversationSourceKey(value) === key)) return bad()
    seen.add(key); return result
  })
  return { ...ref, scope: accepted, cuts }
}
/** Route context wraps the original source frontier; it never rewrites source references. */
export function parseConversationCheckpoint(value: unknown, expected?: ConversationRef): ConversationCheckpoint {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'sourceHostId', 'frontier'], 'CONTROL_PROTOCOL_ERROR')
  const target = parseConversationRef({ hostId: p.hostId, agentSessionId: p.agentSessionId }), sourceHostId = text(p.sourceHostId)
  if (expected && (target.hostId !== expected.hostId || target.agentSessionId !== expected.agentSessionId)) return bad()
  return { ...target, sourceHostId, frontier: parseConversationFrontier(p.frontier, { hostId: sourceHostId, agentSessionId: target.agentSessionId }) }
}
function itemRef(value: unknown, ref: ConversationRef, accepted?: ConversationScope): ConversationItemRef {
  const base = { hostId: ref.hostId, agentSessionId: ref.agentSessionId }
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'source'], 'CONTROL_PROTOCOL_ERROR')
  if (p.hostId !== ref.hostId || p.agentSessionId !== ref.agentSessionId) return bad()
  const s = rpcRecord(p.source, ['kind', 'providerId', 'nativeSessionId', 'recordId'], 'CONTROL_PROTOCOL_ERROR')
  const recordId = text(s.recordId)
  if (s.kind === 'native') {
    const source = { kind: 'native' as const, providerId: text(s.providerId), nativeSessionId: text(s.nativeSessionId), recordId }
    if (accepted && !accepted.sources.some(value => value.kind === 'native' && value.providerId === source.providerId && value.nativeSessionId === source.nativeSessionId)) return bad()
    return { ...base, source }
  }
  if (s.kind !== 'captured' || s.providerId !== undefined || s.nativeSessionId !== undefined || accepted && !accepted.sources.some(value => value.kind === 'captured' && value.epoch !== undefined)) return bad()
  return { ...base, source: { kind: 'captured', recordId } }
}
export function parseConversationVersionedAnchor(value: unknown, ref: ConversationRef): ConversationVersionedAnchor {
  const p = rpcRecord(value, ['record', 'revision', 'frontier'], 'CONTROL_PROTOCOL_ERROR'), frontier = parseConversationCheckpoint(p.frontier, ref)
  const revision = text(p.revision)
  if (!/^[a-f0-9]{64}$/u.test(revision)) return bad()
  return { record: itemRef(p.record, frontier.frontier, frontier.frontier.scope), revision, frontier }
}
function options(value: Record<string, unknown>): { limit?: number; maxBytes?: number; cursor?: string; view?: string; processDetails?: 'deferred' } {
  if (value.processDetails !== undefined && value.processDetails !== 'deferred') return bad('Unknown process detail representation.', 'INVALID_CONTROL_REQUEST')
  return { ...(value.processDetails === undefined ? {} : { processDetails: 'deferred' as const }), ...optionValues(value) }
}
function optionValues(value: Record<string, unknown>) {
  return { ...(value.limit === undefined ? {} : { limit: integer(value.limit, 1, 100) }),
    ...(value.maxBytes === undefined ? {} : { maxBytes: integer(value.maxBytes, 4096, CONVERSATION_MAX_READ_BYTES) }),
    ...(value.cursor === undefined ? {} : { cursor: text(value.cursor, 131_072) }),
    ...(value.view === undefined ? {} : { view: text(value.view, 131_072) }) }
}
export function parseConversationTimelineReadInput(value: unknown): ConversationTimelineReadInput {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'limit', 'cursor', 'maxBytes', 'record', 'anchor', 'view', 'nativeSource', 'preserveCurrent', 'processDetails'])
  const ref = parseConversationRef({ hostId: p.hostId, agentSessionId: p.agentSessionId })
  if (p.processDetails !== undefined && (p.record !== undefined || p.anchor !== undefined)) return bad('Exact original detail reads require complete records.')
  if (p.record !== undefined && (p.anchor !== undefined || p.view !== undefined || p.nativeSource !== undefined)) return bad('An exact current record cannot be combined with another read mode.')
  if (p.preserveCurrent !== undefined && typeof p.preserveCurrent !== 'boolean') return bad('Window preservation must be a boolean.')
  if (p.preserveCurrent && (p.cursor === undefined || p.record !== undefined || p.anchor !== undefined || p.view !== undefined || p.nativeSource !== undefined)) return bad('Window preservation requires the original older cursor and its wire continuations.')
  const record = p.record === undefined ? undefined : itemRef(p.record, { hostId: text(rpcRecord(p.record).hostId), agentSessionId: ref.agentSessionId })
  const native = p.nativeSource === undefined ? undefined : rpcRecord(p.nativeSource, ['providerId', 'nativeSessionId'])
  return { ...ref, ...options(p), ...(p.preserveCurrent === undefined ? {} : { preserveCurrent: p.preserveCurrent as boolean }), ...(record ? { record } : {}), ...(native ? { nativeSource: { providerId: text(native.providerId), nativeSessionId: text(native.nativeSessionId) } } : {}),
    ...(p.anchor === undefined ? {} : { anchor: parseConversationVersionedAnchor(p.anchor, ref) }) }
}
export function parseConversationChangesInput(value: unknown): ConversationChangesInput {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'checkpoint', 'limit', 'cursor', 'maxBytes', 'view', 'processDetails'])
  const ref = parseConversationRef({ hostId: p.hostId, agentSessionId: p.agentSessionId })
  const checkpoint = parseConversationCheckpoint(p.checkpoint, ref)
  return { ...ref, checkpoint, ...options(p) }
}
export function parseConversationWatchInput(value: unknown): ConversationWatchInput {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'view'])
  return { ...parseConversationRef({ hostId: p.hostId, agentSessionId: p.agentSessionId }), ...(p.view === undefined ? {} : { view: text(p.view, 131_072) }) }
}
export function parseConversationViewReleaseInput(value: unknown): ConversationViewReleaseInput {
  const input = parseConversationWatchInput(value)
  return { ...input, view: text(input.view, 131_072) }
}
export function parseConversationViewReleaseResult(value: unknown, input: ConversationRef): ConversationViewReleaseResult {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'sourceHostId', 'viewId', 'released'])
  if (p.hostId !== input.hostId || p.agentSessionId !== input.agentSessionId || typeof p.released !== 'boolean') return bad()
  return { hostId: input.hostId, agentSessionId: input.agentSessionId, sourceHostId: text(p.sourceHostId), viewId: text(p.viewId), released: p.released }
}
function coverage(value: unknown, ref: ConversationRef, accepted: ConversationScope): ConversationSourceCoverage[] {
  if (!Array.isArray(value) || value.length !== accepted.sources.length) return bad()
  const seen = new Set<string>()
  return value.map(value => {
    const p = rpcRecord(value, ['source', 'origin', 'readExtent', 'earlier', 'current', 'gaps'], 'CONTROL_PROTOCOL_ERROR')
    const source = parseConversationSource(p.source), key = conversationSourceKey(source), extent = rpcRecord(p.readExtent, ['from', 'through'], 'CONTROL_PROTOCOL_ERROR')
    if (seen.has(key) || !accepted.sources.some(v => conversationSourceKey(v) === key) ||
      !['beginning', 'retained-prefix', 'unknown'].includes(String(p.origin)) || !['complete', 'more', 'unknown-before'].includes(String(p.earlier)) ||
      !['complete-through-cut', 'partial', 'unavailable', 'unsupported'].includes(String(p.current)) || !Array.isArray(p.gaps) || p.gaps.length > 100) return bad()
    seen.add(key)
    return { source, origin: p.origin as ConversationSourceCoverage['origin'],
      readExtent: { ...(extent.from === undefined ? {} : { from: text(extent.from) }), through: text(extent.through) },
      earlier: p.earlier as ConversationSourceCoverage['earlier'], current: p.current as ConversationSourceCoverage['current'],
      gaps: p.gaps.map(value => { const gap = rpcRecord(value, ['code', 'message', 'record', 'continuation'], 'CONTROL_PROTOCOL_ERROR')
        return { code: text(gap.code), message: message(gap.message), ...(gap.record === undefined ? {} : { record: itemRef(gap.record, ref) }), ...(gap.continuation === undefined ? {} : { continuation: text(gap.continuation, 131_072) }) } }) }
  })
}
function selector(value: unknown): import('./conversation-stream.js').ConversationSelector {
  const p = rpcRecord(value, ['kind', 'partIndex', 'field'], 'CONTROL_PROTOCOL_ERROR')
  if (p.kind === 'native-part' && p.field === undefined) return { kind: 'native-part', partIndex: integer(p.partIndex) }
  if (p.kind !== 'captured-field' || p.partIndex !== undefined || !['content', 'toolInput', 'toolOutput'].includes(String(p.field))) return bad()
  return { kind: 'captured-field', field: p.field as 'content' | 'toolInput' | 'toolOutput' }
}
function revision(value: unknown): string { const result = text(value); return /^[a-f0-9]{64}$/u.test(result) ? result : bad() }
/** Validate complete units only. Fragments never acquire event semantics. */
export function parseConversationUnit(value: unknown, ref: ConversationRef, accepted: ConversationScope): ConversationUnit {
  const p = rpcRecord(value, ['event', 'records'], 'CONTROL_PROTOCOL_ERROR')
  if (!Array.isArray(p.records) || !p.records.length) return bad()
  if (!p.records.some(value => rpcRecord(rpcRecord(value).original).kind === 'deferred')) return parseCompleteConversationUnit(value, ref, accepted)
  if (bytes(value) > CONVERSATION_MAX_UNIT_BYTES || p.records.length > CONVERSATION_MAX_WINDOW_RECORDS) return bad()
  const summaries = p.records.map(value => {
    const r = rpcRecord(value, ['id', 'reference', 'revision', 'order', 'original', 'summaryRevision'], 'CONTROL_PROTOCOL_ERROR')
    const original = rpcRecord(r.original, ['kind', 'item'], 'CONTROL_PROTOCOL_ERROR')
    if (original.kind !== 'deferred' || conversationRevision(original.item) !== revision(r.summaryRevision)) return bad('Process summary representation changed.')
    return r as ConversationDeferredRecord
  })
  let witnesses: ConversationSourceRecord[]
  try { witnesses = summaries.map(conversationProcessWitness) } catch { return bad('Invalid process summary metadata.') }
  const complete = parseCompleteConversationUnit({ event: p.event, records: witnesses }, ref, accepted, new Map(summaries.map(record => [record.id, record.revision])))
  if (complete.event.role !== 'process' || complete.records.some(record => conversationRecordRole(record) !== 'process')) return bad('Only original process records may defer their bodies.')
  const normalized = complete.records.map(deferConversationProcessRecord)
  if (!same(normalized, summaries)) return bad('Process summary omitted or changed original typed metadata.')
  return { event: complete.event, records: normalized }
}
function parseCompleteConversationUnit(value: unknown, ref: ConversationRef, accepted: ConversationScope, deferredVersions?: ReadonlyMap<string, string>): { event: ConversationEvent; records: ConversationSourceRecord[] } {
  if (bytes(value) > CONVERSATION_MAX_UNIT_BYTES) return bad()
  const p = rpcRecord(value, ['event', 'records'], 'CONTROL_PROTOCOL_ERROR')
  if (!Array.isArray(p.records) || !p.records.length || p.records.length > CONVERSATION_MAX_WINDOW_RECORDS) return bad()
  const records: ConversationSourceRecord[] = p.records.map(value => {
    const r = rpcRecord(value, ['id', 'reference', 'revision', 'order', 'original'], 'CONTROL_PROTOCOL_ERROR')
    const reference = itemRef(r.reference, ref, accepted), id = text(r.id, 131_072), version = revision(r.revision)
    if (id !== conversationRecordId(reference)) return bad()
    const original = rpcRecord(r.original, ['kind', 'item'], 'CONTROL_PROTOCOL_ERROR'), order = rpcRecord(r.order, ['kind', 'source', 'pageWitness', 'indexInPage', 'epoch', 'firstSequence'], 'CONTROL_PROTOCOL_ERROR')
    let result: ConversationSourceRecord
    if (original.kind === 'native' && reference.source.kind === 'native' && order.kind === 'native-page') {
      const s = parseConversationSource({ kind: 'native', ...rpcRecord(order.source) })
      if (s.kind !== 'native' || s.providerId !== reference.source.providerId || s.nativeSessionId !== reference.source.nativeSessionId || order.epoch !== undefined || order.firstSequence !== undefined) return bad()
      const item = normalizeSessionHistoryPage(s, { source: { providerId: s.providerId, nativeSessionId: s.nativeSessionId }, items: [original.item], nextCursor: null }, 1).items[0]!
      if (item.id !== reference.source.recordId || !same(original.item, item)) return bad()
      result = { id, reference, revision: version, order: { kind: 'native-page', source: { providerId: s.providerId, nativeSessionId: s.nativeSessionId }, indexInPage: integer(order.indexInPage), ...(order.pageWitness === undefined ? {} : { pageWitness: text(order.pageWitness, 32_768) }) }, original: { kind: 'native', item } }
    } else {
      if (original.kind !== 'captured' || reference.source.kind !== 'captured' || order.kind !== 'captured-stream' || order.source !== undefined || order.pageWitness !== undefined || order.indexInPage !== undefined) return bad()
      const epoch = text(order.epoch), item = normalizeAgentTimelineItem(original.item)
      if (!accepted.sources.some(s => s.kind === 'captured' && s.epoch === epoch) || item.id !== reference.source.recordId || item.agentSessionId !== ref.agentSessionId || !same(original.item, item)) return bad()
      result = { id, reference, revision: version, order: { kind: 'captured-stream', epoch, firstSequence: integer(order.firstSequence, 1) }, original: { kind: 'captured', item } }
    }
    if (deferredVersions?.get(id) !== version && conversationRevision(result.original.item) !== version) return bad('Original conversation record version changed.')
    if (result.original.item.conversation?.adoptedInput && !conversationNativeInputWitness(result)?.key) return bad('The native adoption does not belong to this original record.')
    return result
  })
  const byId = new Map(records.map(record => [record.id, record]))
  if (byId.size !== records.length) return bad()
  const e = rpcRecord(p.event, ['id', 'revision', 'anchorId', 'reference', 'role', 'author', 'recordIds', 'content', 'relations', 'coalesces', 'inputAdoption'], 'CONTROL_PROTOCOL_ERROR')
  const rawAdoption = e.inputAdoption === undefined ? undefined : rpcRecord(e.inputAdoption, ['unconfirmed', 'witnesses'], 'CONTROL_PROTOCOL_ERROR')
  if (rawAdoption && (rawAdoption.unconfirmed !== undefined && rawAdoption.unconfirmed !== true || !Array.isArray(rawAdoption.witnesses))) return bad()
  const inputAdoption: import('./conversation-stream.js').ConversationInputAdoptionContext | undefined = rawAdoption ? {
    ...(rawAdoption.unconfirmed ? { unconfirmed: true as const } : {}), witnesses: (rawAdoption.witnesses as unknown[]).map(value => {
      const w = rpcRecord(value, ['record', 'recordRevision', 'semanticItemId', 'turnId', 'clientCorrelation', 'key'], 'CONTROL_PROTOCOL_ERROR'), record = itemRef(w.record, ref, accepted), key = w.key === undefined ? undefined : validateAgentPromptInputKey(w.key), semanticItemId = text(w.semanticItemId), recordRevision = revision(w.recordRevision), turnId = text(w.turnId), clientCorrelation = text(w.clientCorrelation, 8192)
      if (record.source.kind !== 'native' || key && key.agentSessionId !== ref.agentSessionId || !clientCorrelation.startsWith('amux-input-v1.')) return bad()
      const fact = { record, recordRevision, semanticItemId, turnId, clientCorrelation, ...(key ? { key } : {}) }
      const local = byId.get(conversationRecordId(record))
      if (local?.revision === recordRevision && !same(conversationNativeInputWitness(local), fact)) return bad('The retained input witness contradicts a local original.')
      return fact
    }) } : undefined
  const adopted = conversationInputAdoptionEdges(records, inputAdoption)
  const localInputs = new Set([...adopted.recordKeys.values()].flatMap(keys => [...keys]))
  const relevant = [...localInputs].flatMap(key => adopted.byKey.get(key) ?? [])
  if (inputAdoption && (!localInputs.size || inputAdoption.witnesses.some(witness => !relevant.some(value => same(value, witness))))) return bad('The retained witness belongs to another original input.')
  const reference = itemRef(e.reference, ref), id = text(e.id, 131_072)
  if (id !== text(e.anchorId, 131_072) || id !== conversationRecordId(reference) || !Array.isArray(e.recordIds) || e.recordIds.length !== records.length ||
    e.recordIds.some((v, i) => v !== records[i]!.id) || !Array.isArray(e.content) || !Array.isArray(e.relations) || e.relations.length > 100_000) return bad()
  const nativeSource = accepted.sources.find(source => source.kind === 'native')
  const targets = new Map(records.flatMap(record => {
    const target = conversationSameEventTarget(record, nativeSource?.kind === 'native' ? nativeSource : undefined, adopted.targets.get(record.id))
    return target && conversationRecordId(target) !== record.id ? [[record.id, conversationRecordId(target)] as const] : []
  }))
  const anchors = conversationRecordAnchors(records, targets).anchors
  if (records.some(record => record.id !== id && anchors.get(record.id) !== id)) return bad('Conversation event identity has no original canonical relation.')
  const primary = byId.get(id) ?? records.find(record => record.original.kind === 'native') ?? records[0]!
  if (e.role !== conversationRecordRole(primary) || !same(e.author, conversationEventAuthor(records, primary, ref.agentSessionId).author)) return bad()
  const accounted = new Set<string>()
  const content = e.content.map(value => {
    const slot = rpcRecord(value, ['recordId', 'recordRevision', 'selector', 'placement'], 'CONTROL_PROTOCOL_ERROR'), recordId = text(slot.recordId, 131_072), record = byId.get(recordId), selected = selector(slot.selector)
    if (!record || record.revision !== slot.recordRevision || !['body', 'detail'].includes(String(slot.placement)) ||
      record.original.kind === 'native' && (selected.kind !== 'native-part' || selected.partIndex >= record.original.item.contentParts.length) ||
      record.original.kind === 'captured' && (selected.kind !== 'captured-field' || record.original.item[selected.field] === undefined)) return bad()
    const key = JSON.stringify([recordId, selected]); if (accounted.has(key)) return bad(); accounted.add(key)
    return { recordId, recordRevision: record.revision, selector: selected, placement: slot.placement as 'body' | 'detail' }
  })
  const count = records.reduce((n, r) => { const original = r.original; return n + (original.kind === 'native' ? original.item.contentParts.length : (['content', 'toolInput', 'toolOutput'] as const).filter(f => original.item[f] !== undefined).length) }, 0)
  if (accounted.size !== count) return bad('Conversation unit omitted original content slots.')
  // Reuse the original typed provenance parser. These reading links do not confer
  // execution/input authority and never infer an association from content or time.
  const invocation = (value: unknown) => {
    const p = rpcRecord(value, ['hostId', 'agentSessionId', 'source', 'subject', 'scope', 'callId'], 'CONTROL_PROTOCOL_ERROR')
    if (p.hostId !== ref.hostId || p.agentSessionId !== ref.agentSessionId) return bad()
    const original = { source: p.source, subject: p.subject, scope: p.scope, callId: p.callId }
    const fact = parseConversationProvenance({ invocations: [{ selector: { kind: 'captured-field', field: 'content' }, invocation: original }] }).invocations![0]!.invocation
    if (!same(original, fact)) return bad()
    return { hostId: ref.hostId, agentSessionId: ref.agentSessionId, ...fact }
  }
  const partRef = (value: unknown) => {
    const part = rpcRecord(value, ['record', 'recordRevision', 'selector'], 'CONTROL_PROTOCOL_ERROR')
    const record = itemRef(part.record, ref), version = revision(part.recordRevision), selected = selector(part.selector)
    const local = byId.get(conversationRecordId(record))
    if (local && (local.revision !== version || !accounted.has(JSON.stringify([local.id, selected])))) return bad()
    return { record, recordRevision: version, selector: selected }
  }
  const relations = e.relations.map(value => {
    const r = rpcRecord(value)
    if (r.kind === 'same-event') {
      rpcRecord(value, ['kind', 'from', 'to'], 'CONTROL_PROTOCOL_ERROR')
      const from = itemRef(r.from, ref), to = itemRef(r.to, ref), local = byId.get(conversationRecordId(from))
      if (!local && !byId.has(conversationRecordId(to)) || local && !same(conversationSameEventTarget(local, nativeSource?.kind === 'native' ? nativeSource : undefined, adopted.targets.get(local.id)), to)) return bad()
      return { kind: 'same-event' as const, from, to }
    }
    if (r.kind === 'invocation-member') {
      rpcRecord(value, ['kind', 'part', 'invocation'], 'CONTROL_PROTOCOL_ERROR')
      const part = partRef(r.part), original = invocation(r.invocation)
      if (!byId.has(conversationRecordId(part.record))) return bad()
      return { kind: 'invocation-member' as const, part, invocation: original }
    }
    if (r.kind === 'answers') {
      rpcRecord(value, ['kind', 'from', 'question'], 'CONTROL_PROTOCOL_ERROR')
      const q = rpcRecord(r.question, ['hostId', 'agentSessionId', 'source', 'questionId'], 'CONTROL_PROTOCOL_ERROR')
      if (q.hostId !== ref.hostId || q.agentSessionId !== ref.agentSessionId) return bad()
      const source = rpcRecord(q.source, ['providerId', 'nativeSessionId'], 'CONTROL_PROTOCOL_ERROR')
      const from = itemRef(r.from, ref), question = { hostId: ref.hostId, agentSessionId: ref.agentSessionId,
        source: { providerId: text(source.providerId), nativeSessionId: text(source.nativeSessionId) }, questionId: text(q.questionId) }
      if (!byId.has(conversationRecordId(from))) return bad()
      return { kind: 'answers' as const, from, question }
    }
    if (r.kind === 'observes') {
      rpcRecord(value, ['kind', 'from', 'target'], 'CONTROL_PROTOCOL_ERROR')
      const rawTarget = rpcRecord(r.target), from = itemRef(r.from, ref), target = 'recordId' in rpcRecord(rawTarget.source) ? itemRef(rawTarget, ref) : invocation(rawTarget)
      if (!byId.has(conversationRecordId(from))) return bad()
      return { kind: 'observes' as const, from, target }
    }
    return bad()
  })
  if (!same(relations.filter(relation => relation.kind === 'invocation-member'), records.flatMap(record => conversationInvocationMembers(record))))
    return bad('Conversation invocation membership does not match its original content facts.')
  if (!same(relations.filter(relation => relation.kind === 'answers' || relation.kind === 'observes'), records.flatMap(record => conversationRecordRelations(record))))
    return bad('Conversation answer or observation does not match its originating original record facts.')
  const expectedContent = [primary, ...records.filter(record => record !== primary)].flatMap(record => {
    const original = record.original
    const selected = original.kind === 'native' ? original.item.contentParts.map((_, partIndex) => ({ kind: 'native-part' as const, partIndex }))
      : (['content', 'toolInput', 'toolOutput'] as const).filter(field => original.item[field] !== undefined).map(field => ({ kind: 'captured-field' as const, field }))
    return selected.map(selector => ({ recordId: record.id, recordRevision: record.revision, selector, placement: record === primary ? 'body' : 'detail' }))
  })
  if (!same(content, expectedContent)) return bad('Original conversation content order or placement changed.')
  const expectedCoalesces = conversationEventCoalesces(records, id, nativeSource?.kind === 'native' ? nativeSource : undefined, adopted.targets)
  if (!same(e.coalesces, expectedCoalesces.length ? expectedCoalesces : undefined) ||
    expectedCoalesces.some(coalesce => !relations.some(relation => same(relation, coalesce.relation)))) return bad('Conversation coalesce does not name its original contribution.')
  const event = { id, anchorId: id, reference, role: e.role as ConversationEvent['role'], author: e.author as ConversationEvent['author'], recordIds: records.map(r => r.id), content,
    ...(inputAdoption ? { inputAdoption } : {}),
    relations, ...(e.coalesces === undefined ? {} : { coalesces: e.coalesces as NonNullable<ConversationEvent['coalesces']> }) }
  const version = revision(e.revision)
  if (conversationRevision({ policy: 1, versions: records.map(record => [record.id, record.revision]), event }) !== version) return bad('Conversation event version changed.')
  return { event: { ...event, revision: version }, records }
}
function basePage(value: unknown, input: ConversationTimelineReadInput, changes = false, ownedItems?: readonly ConversationUnitEntry[]): AgentConversationReadPage {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'sourceHostId', 'scope', 'coverage', 'order', 'items', 'nextCursor', 'budgetBytes', 'window', 'processDetails', ...(changes ? ['checkpoint', 'more'] : [])], 'CONTROL_PROTOCOL_ERROR')
  if (p.hostId !== input.hostId || p.agentSessionId !== input.agentSessionId || p.budgetBytes !== (input.maxBytes ?? CONVERSATION_DEFAULT_READ_BYTES) || bytes(value) > Number(p.budgetBytes) || !Array.isArray(p.items) || p.items.length > (input.limit ?? 30)) return bad()
  if (p.processDetails !== input.processDetails) return bad('The process detail representation changed during reading.')
  const accepted = scope(p.scope), source = { hostId: text(p.sourceHostId), agentSessionId: input.agentSessionId }, order = rpcRecord(p.order, ['basis', 'crossSource', 'direction'], 'CONTROL_PROTOCOL_ERROR')
  if (input.record && input.record.hostId !== source.hostId || input.nativeSource && !accepted.sources.some(source => source.kind === 'native' && source.providerId === input.nativeSource!.providerId && source.nativeSessionId === input.nativeSource!.nativeSessionId) ||
      input.anchor && (input.anchor.frontier.sourceHostId !== source.hostId || !same(input.anchor.frontier.frontier.scope, accepted))) return bad('The read returned another explicitly selected original source.')
  if (order.direction !== 'newest-first' || order.basis !== 'source-and-relations' || !['partial', 'confirmed'].includes(String(order.crossSource))) return bad()
  const items = ownedItems ?? p.items.map(value => {
    const entry = rpcRecord(value, ['kind', 'item', 'itemId', 'encoding', 'sha256', 'offsetBytes', 'totalBytes', 'dataBase64'], 'CONTROL_PROTOCOL_ERROR')
    if (entry.kind === 'item') { rpcRecord(value, ['kind', 'item'], 'CONTROL_PROTOCOL_ERROR'); return { kind: 'item' as const, item: parseConversationUnit(entry.item, source, accepted) } }
    rpcRecord(value, ['kind', 'itemId', 'encoding', 'sha256', 'offsetBytes', 'totalBytes', 'dataBase64'], 'CONTROL_PROTOCOL_ERROR')
    if (entry.kind !== 'fragment' || entry.encoding !== 'json-utf8-base64' || typeof entry.dataBase64 !== 'string' || !entry.dataBase64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(entry.dataBase64)) return bad()
    const offsetBytes = integer(entry.offsetBytes), totalBytes = integer(entry.totalBytes, 1, CONVERSATION_MAX_UNIT_BYTES)
    if (offsetBytes >= totalBytes) return bad()
    return { kind: 'fragment' as const, itemId: text(entry.itemId, 131_072), encoding: 'json-utf8-base64' as const, sha256: revision(entry.sha256), offsetBytes, totalBytes, dataBase64: entry.dataBase64 }
  })
  if (p.processDetails !== 'deferred' && items.some(entry => entry.kind === 'item' && entry.item.records.some(record => !isCompleteConversationRecord(record)))) return bad('Deferred process body was not requested.')
  const w = rpcRecord(p.window, ['id', 'revision', 'itemCount', 'complete', 'view', 'replay', 'checkpoint', 'outside', 'navigation', 'anchor'], 'CONTROL_PROTOCOL_ERROR')
  const checkpoint = parseConversationCheckpoint(w.checkpoint, input)
  if (typeof w.complete !== 'boolean' || (w.complete ? typeof w.view !== 'string' : w.view !== null) ||
      checkpoint.sourceHostId !== source.hostId || !same(checkpoint.frontier.scope, accepted)) return bad()
  const outside = rpcRecord(w.outside, ['older', 'newer']), boundary = (value: unknown): ConversationWindowBoundary | null => {
    if (value === null) return null
    const point = rpcRecord(value, ['record', 'revision'])
    return { record: itemRef(point.record, source, accepted), revision: revision(point.revision) }
  }
  const navigation = rpcRecord(w.navigation, ['older', 'newer'])
  const navigationCursor = (value: unknown) => value === null ? null : text(value, 131_072)
  if (!w.complete && (navigation.older !== null || navigation.newer !== null)) return bad()
  const anchor = w.anchor === undefined ? undefined : parseConversationVersionedAnchor(w.anchor, input)
  if (input.record && (Number(w.itemCount) > 0 && !anchor || anchor && !same(anchor.record, input.record) || items.some(entry => entry.kind === 'item' && entry.item.records.some(record => !same(record.reference, input.record))))) return bad('The exact-record read returned another original record.')
  if (input.anchor && !same(anchor, input.anchor) || anchor && (changes || !same(anchor.frontier, checkpoint) || Number(w.itemCount) > 1 ||
      navigation.older !== null || navigation.newer !== null || outside.older !== null || outside.newer !== null)) return bad('The exact-anchor window changed its original read intent.')
  const window: ConversationReadWindow = { id: text(w.id), revision: integer(w.revision, 1), itemCount: integer(w.itemCount, 0, CONVERSATION_MAX_WINDOW_RECORDS),
    ...(anchor ? { anchor } : {}), complete: w.complete, view: w.view === null ? null : text(w.view, 131_072), replay: text(w.replay, 131_072), checkpoint,
    outside: { older: boundary(outside.older), newer: boundary(outside.newer) },
    navigation: { older: navigationCursor(navigation.older), newer: navigationCursor(navigation.newer) } }
  return { hostId: input.hostId, agentSessionId: input.agentSessionId, ...(input.processDetails ? { processDetails: input.processDetails } : {}), sourceHostId: source.hostId, scope: accepted, coverage: coverage(p.coverage, source, accepted), order: order as AgentConversationReadPage['order'], items, nextCursor: p.nextCursor === null ? null : text(p.nextCursor, 131_072), budgetBytes: Number(p.budgetBytes), window }
}
export function parseConversationReadPage(value: unknown, input: ConversationTimelineReadInput): AgentConversationReadPage { return basePage(value, input) }
function changesPage(value: unknown, input: ConversationChangesInput, ownedItems?: readonly ConversationUnitEntry[]): ConversationChangesPage {
  const result = basePage(value, input, true, ownedItems), p = rpcRecord(value), checkpoint = parseConversationCheckpoint(p.checkpoint, input)
  if (input.checkpoint.sourceHostId !== result.sourceHostId || checkpoint.sourceHostId !== result.sourceHostId || !same(result.scope, input.checkpoint.frontier.scope) || !same(result.scope, checkpoint.frontier.scope) || !same(result.window.checkpoint, checkpoint) || typeof p.more !== 'boolean') return bad()
  return { ...result, checkpoint, more: p.more }
}
export function parseConversationChangesPage(value: unknown, input: ConversationChangesInput): ConversationChangesPage {
  return changesPage(value, input)
}
/** Retain complete-unit validation on the exact immutable response. Each consumer
 * still validates its own request envelope; ordinary DTO parsers remain strict.
 * Only an original owner may omit its private non-wire marker from that check. */
export function parseConversationReadPageForWindow(value: unknown, input: ConversationTimelineReadInput): AgentConversationReadPage {
  if (!ConversationPageOwner.owns(value)) return ownParsedPage(parseConversationReadPage(value, input))
  basePage({ ...value }, input, false, value.items)
  return value
}
export function parseConversationChangesPageForWindow(value: unknown, input: ConversationChangesInput): ConversationChangesPage {
  if (!ConversationPageOwner.owns(value)) return ownParsedPage(parseConversationChangesPage(value, input))
  changesPage({ ...value }, input, value.items)
  return value as ConversationChangesPage
}
export function parseConversationCheckpointPage(value: unknown, input: ConversationRef): ConversationCheckpointPage {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'sourceHostId', 'scope', 'checkpoint', 'coverage'], 'CONTROL_PROTOCOL_ERROR'), source = { hostId: text(p.sourceHostId), agentSessionId: input.agentSessionId }, checkpoint = parseConversationCheckpoint(p.checkpoint, input), accepted = scope(p.scope)
  if (p.hostId !== input.hostId || p.agentSessionId !== input.agentSessionId || checkpoint.sourceHostId !== source.hostId || !same(accepted, checkpoint.frontier.scope) || bytes(value) > CONVERSATION_MAX_READ_BYTES) return bad()
  return { hostId: input.hostId, agentSessionId: input.agentSessionId, sourceHostId: source.hostId, scope: accepted, checkpoint, coverage: coverage(p.coverage, source, accepted) }
}
export function parseConversationWatchOpening(value: unknown, input: ConversationRef): ConversationWatchOpening {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'sourceHostId', 'scope', 'coverage'], 'CONTROL_PROTOCOL_ERROR'), accepted = scope(p.scope), source = { hostId: text(p.sourceHostId), agentSessionId: input.agentSessionId }
  if (p.hostId !== input.hostId || p.agentSessionId !== input.agentSessionId || bytes(value) > CONVERSATION_MAX_READ_BYTES) return bad()
  return { hostId: input.hostId, agentSessionId: input.agentSessionId, sourceHostId: source.hostId, scope: accepted, coverage: coverage(p.coverage, source, accepted) }
}
export function parseConversationObservation(value: unknown, opening: ConversationWatchOpening): ConversationObservation {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'sourceHostId', 'source', 'kind', 'code', 'message'], 'CONTROL_PROTOCOL_ERROR'), source = parseConversationSource(p.source)
  if (p.hostId !== opening.hostId || p.agentSessionId !== opening.agentSessionId || p.sourceHostId !== opening.sourceHostId || !opening.scope.sources.some(s => conversationSourceKey(s) === conversationSourceKey(source)) || !['invalidated', 'unavailable'].includes(String(p.kind)) || bytes(value) > CONVERSATION_MAX_READ_BYTES || p.kind === 'unavailable' && (p.code === undefined || p.message === undefined)) return bad()
  return { hostId: opening.hostId, agentSessionId: opening.agentSessionId, sourceHostId: opening.sourceHostId, source, kind: p.kind as ConversationObservation['kind'], ...(p.code === undefined ? {} : { code: text(p.code) }), ...(p.message === undefined ? {} : { message: message(p.message) }) }
}
