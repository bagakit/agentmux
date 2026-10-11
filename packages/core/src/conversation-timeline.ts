import { sha256 } from '@noble/hashes/sha2.js'
import type { AgentSessionHistoryItem, AgentSessionHistoryPage, AgentSessionHistorySource, AgentSessionUserMessageAuthor, AgentTimelineItem, AgentTimelineItemKind, AgentTimelineSnapshot } from './types.js'
import type { ConversationItemRef, ConversationRef } from './conversation.js'
import { recordedConversationAuthor } from './conversation-author.js'
import { conversationQuestionIdentity, type ConversationQuestionIdentity } from './conversation-questions.js'

export type ConversationAuthor = AgentSessionUserMessageAuthor | { kind: 'system'; providerId?: string }
export type ConversationSelector = { kind: 'native-part'; partIndex: number }
  | { kind: 'captured-field'; field: 'content' | 'toolInput' | 'toolOutput' }
export type ConversationInvocation = {
  source: AgentSessionHistorySource
  subject: 'main' | { kind: 'child'; nativeActorId: string }
  scope: { kind: 'session' } | { kind: 'turn'; nativeTurnId: string }
  callId: string
}
export type ConversationInvocationRef = ConversationRef & ConversationInvocation
/** Produced at the original Provider/Core normalization boundary, never decoded from an opaque item ID. */
export type ConversationRecordProvenance = {
  sameEvent?: ConversationItemRef
  nativeInvocationScope?: Omit<ConversationInvocation, 'callId'>
  observes?: ConversationItemRef
  invocations?: readonly { selector: ConversationSelector; invocation: ConversationInvocation }[]
}
export type ConversationContentRef = { record: ConversationItemRef; recordRevision: string; selector: ConversationSelector }
export type ConversationRelation =
  | { kind: 'same-event'; from: ConversationItemRef; to: ConversationItemRef }
  | { kind: 'invocation-member'; part: ConversationContentRef; invocation: ConversationInvocationRef }
  | { kind: 'answers'; from: ConversationItemRef; question: ConversationQuestionIdentity }
  | { kind: 'observes'; from: ConversationItemRef; target: ConversationItemRef | ConversationInvocationRef }
export type ConversationSourceOrder =
  | { kind: 'native-page'; source: AgentSessionHistorySource; pageWitness?: string; indexInPage: number }
  | { kind: 'captured-stream'; epoch: string; firstSequence: number }
  | { kind: 'captured-window'; revision: number; indexInWindow: number }
export type ConversationSourceRef = ({ kind: 'native' } & AgentSessionHistorySource)
  | { kind: 'native-unavailable'; providerId: string } | { kind: 'captured'; epoch?: string }
export type ConversationSourceCoverage = {
  source: ConversationSourceRef
  origin: 'beginning' | 'retained-prefix' | 'unknown'
  readExtent: { from?: string; through: string }
  earlier: 'complete' | 'more' | 'unknown-before'
  current: 'complete-through-cut' | 'partial' | 'unavailable' | 'unsupported'
  gaps: readonly { code: string; message: string; record?: ConversationItemRef; continuation?: string }[]
}
export type ConversationSourceRecord = {
  id: string
  reference: ConversationItemRef | null
  revision: string
  order: ConversationSourceOrder
  original: { kind: 'native'; item: AgentSessionHistoryItem } | { kind: 'captured'; item: AgentTimelineItem }
}
export type ConversationEvent = {
  id: string
  revision: string
  anchorId: string
  reference: ConversationItemRef | null
  role: 'message' | 'process' | 'observation' | 'interaction' | 'notice'
  author: ConversationAuthor
  recordIds: readonly string[]
  content: readonly { recordId: string; recordRevision: string; selector: ConversationSelector; placement: 'body' | 'detail' }[]
  relations: readonly ConversationRelation[]
  coalesces?: readonly { fromEventIds: readonly string[]; relation: Extract<ConversationRelation, { kind: 'same-event' }> }[]
}
export type ConversationTimeline = {
  reference: ConversationRef | null
  agentSessionId: string
  scope: { sources: readonly ConversationSourceRef[] }
  records: readonly ConversationSourceRecord[]
  events: readonly ConversationEvent[]
  coverage: readonly ConversationSourceCoverage[]
  order: { basis: 'source-and-relations'; crossSource: 'partial' | 'confirmed' }
}
export type ConversationProjectionInput = {
  agentSessionId: string
  executionHostId?: string | undefined
  historyPage?: AgentSessionHistoryPage | undefined
  timeline?: AgentTimelineSnapshot | undefined
  sourceOrders?: ReadonlyMap<string, ConversationSourceOrder>
  coverage?: readonly ConversationSourceCoverage[]
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]))
  return value
}
/** Content version only: never consulted by association or order. Browser-safe. */
export function conversationRevision(value: unknown): string {
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify(canonical(value)))), byte => byte.toString(16).padStart(2, '0')).join('')
}
export function conversationRecordId(reference: { hostId?: string; agentSessionId: string; source: ConversationItemRef['source'] }): string {
  const { source } = reference
  return JSON.stringify(source.kind === 'native'
    ? [reference.hostId ?? null, reference.agentSessionId, 'native', source.providerId, source.nativeSessionId, source.recordId]
    : [reference.hostId ?? null, reference.agentSessionId, 'captured', source.recordId])
}
/** Original scoped invocation identity, independent of accepted peers or parent events. */
export function conversationInvocationId(ref: ConversationInvocationRef): string {
  return JSON.stringify([ref.hostId, ref.agentSessionId, ref.source.providerId, ref.source.nativeSessionId,
    typeof ref.subject === 'string' ? ['main'] : ['child', ref.subject.nativeActorId],
    ref.scope.kind, ref.scope.kind === 'turn' ? ref.scope.nativeTurnId : null, ref.callId])
}
/** Local facts only: accepting an unrelated peer cannot add relations to this record's event. */
export function conversationRecordRelations(record: ConversationSourceRecord): Extract<ConversationRelation, { kind: 'answers' | 'observes' }>[] {
  const from = record.reference
  if (!from) return []
  const relations: Extract<ConversationRelation, { kind: 'answers' | 'observes' }>[] = []
  const target = record.original.item.conversation?.observes
  if (target && target.hostId === from.hostId && target.agentSessionId === from.agentSessionId) relations.push({ kind: 'observes', from, target })
  if (record.original.kind === 'native' && record.original.item.kind === 'user-message' && from.source.kind === 'native') {
    const source = { providerId: from.source.providerId, nativeSessionId: from.source.nativeSessionId }
    const questions = new Set<string>()
    for (const answer of record.original.item.questionAnswers ?? []) {
      const question = conversationQuestionIdentity({ ...from, source }, answer.questionId)
      if (question && !questions.has(question.questionId)) { questions.add(question.questionId); relations.push({ kind: 'answers', from, question }) }
    }
  }
  return relations
}
const capturedRoles: Record<AgentTimelineItemKind, ConversationEvent['role']> = {
  user_message: 'message', assistant_message: 'message', system_message: 'notice', tool_call: 'process', permission: 'interaction', lifecycle: 'process'
}
export function conversationRecordRole(record: ConversationSourceRecord): ConversationEvent['role'] {
  const { original } = record
  if (original.kind === 'native') return original.item.questionRequest ? 'interaction'
    : original.item.kind === 'activity' ? 'process' : original.item.kind === 'system-message' ? 'notice' : 'message'
  const item = original.item
  if (item.kind === 'assistant_message' && item.source === 'native-hook' && recordedConversationAuthor(item).kind === 'unknown') return 'observation'
  return capturedRoles[item.kind]
}
export function conversationRecordAuthor(record: ConversationSourceRecord, sessionId: string): ConversationAuthor {
  if (record.original.kind === 'native') return record.original.item.kind === 'assistant-message' ? { kind: 'agent', agentSessionId: sessionId }
    : record.original.item.kind === 'system-message' && record.order.kind === 'native-page' ? { kind: 'system', providerId: record.order.source.providerId } : { kind: 'unknown' }
  const explicit = recordedConversationAuthor(record.original.item)
  if (explicit.kind !== 'unknown') return explicit
  return conversationRecordRole(record) === 'message' && record.original.item.kind === 'assistant_message'
    ? { kind: 'agent', agentSessionId: sessionId } : { kind: 'unknown' }
}
/** Exact recorded attribution of one already confirmed event group; never an association or authority test. */
export function conversationEventAuthor(records: readonly ConversationSourceRecord[], primary: ConversationSourceRecord, sessionId: string): {
  author: ConversationAuthor; conflictingRecordIds: readonly string[]
} {
  const explicit = records.flatMap(record => {
    if (record.original.kind !== 'captured') return []
    const author = recordedConversationAuthor(record.original.item)
    return author.kind === 'unknown' ? [] : [{ record, author }]
  })
  const authors = new Map(explicit.map(value => [JSON.stringify(canonical(value.author)), value.author]))
  if (authors.size > 1) return { author: { kind: 'unknown' }, conflictingRecordIds: explicit.map(value => value.record.id) }
  return { author: authors.values().next().value ?? conversationRecordAuthor(primary, sessionId), conflictingRecordIds: [] }
}
function selectors(record: ConversationSourceRecord): ConversationSelector[] {
  const original = record.original
  return original.kind === 'native' ? original.item.contentParts.map((_, partIndex) => ({ kind: 'native-part', partIndex }))
    : (['content', 'toolInput', 'toolOutput'] as const).flatMap(field => original.item[field] === undefined ? [] : [{ kind: 'captured-field' as const, field }])
}
function time(record: ConversationSourceRecord): number | undefined {
  const value = record.original.kind === 'native' ? record.original.item.startedAt : record.original.item.createdAt
  return value !== undefined && Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : undefined
}
export function conversationSourceKey(source: ConversationSourceRef): string { return JSON.stringify(source.kind === 'native' ? ['native', source.providerId, source.nativeSessionId]
  : source.kind === 'native-unavailable' ? ['native-unavailable', source.providerId] : ['captured', source.epoch ?? null]) }
const sourceKey = conversationSourceKey
function sameSource(a: AgentSessionHistorySource, b: AgentSessionHistorySource): boolean { return a.providerId === b.providerId && a.nativeSessionId === b.nativeSessionId }
function sourceOf(record: ConversationSourceRecord): ConversationSourceRef {
  return record.original.kind === 'native' ? { kind: 'native', ...(record.order as Extract<ConversationSourceOrder, { kind: 'native-page' }>).source }
    : { kind: 'captured', ...(record.order.kind === 'captured-stream' ? { epoch: record.order.epoch } : {}) }
}
/** Select the next original tail. A clock only ranks incomparable sources. */
export function conversationTailComesAfter(a: ConversationSourceRecord, b: ConversationSourceRecord): boolean {
  const at = time(a), bt = time(b)
  return at !== undefined && bt !== undefined && at !== bt ? at > bt : sourceKey(sourceOf(a)) > sourceKey(sourceOf(b))
}
/** Prefix extension cannot reorder an already accepted suffix, even with backward clocks. */
function mergeSources(native: ConversationSourceRecord[], captured: ConversationSourceRecord[]): ConversationSourceRecord[] {
  const reversed: ConversationSourceRecord[] = []
  let n = native.length - 1, c = captured.length - 1
  while (n >= 0 || c >= 0) {
    if (n < 0) { reversed.push(captured[c--]!); continue }
    if (c < 0) { reversed.push(native[n--]!); continue }
    reversed.push(conversationTailComesAfter(native[n]!, captured[c]!) ? native[n--]! : captured[c--]!)
  }
  return reversed.reverse()
}
function validSelector(record: ConversationSourceRecord, selector: ConversationSelector): boolean {
  return record.original.kind === 'native' ? selector.kind === 'native-part' && Number.isSafeInteger(selector.partIndex) && selector.partIndex >= 0 && selector.partIndex < record.original.item.contentParts.length
    : selector.kind === 'captured-field' && record.original.item[selector.field] !== undefined
}

/** Exact invocation facts on existing content slots, shared by projection and wire validation. */
export function conversationInvocationFacts(record: ConversationSourceRecord): readonly { selector: ConversationSelector; invocation: ConversationInvocation }[] {
  const provenance = record.original.item.conversation
  const facts = record.original.kind !== 'native' || !provenance?.nativeInvocationScope ? provenance?.invocations ?? []
    : record.original.item.contentParts.flatMap((part, partIndex) => (part.kind === 'tool-call' || part.kind === 'tool-result') && part.callId
      ? [{ selector: { kind: 'native-part' as const, partIndex }, invocation: { ...provenance.nativeInvocationScope!, callId: part.callId } }] : [])
  return facts.filter(fact => {
    if (!validSelector(record, fact.selector)) return false
    if (record.original.kind !== 'native' || fact.selector.kind !== 'native-part') return true
    if (record.order.kind !== 'native-page' || !sameSource(fact.invocation.source, record.order.source)) return false
    const part = record.original.item.contentParts[fact.selector.partIndex]!
    return (part.kind === 'tool-call' || part.kind === 'tool-result') && part.callId === fact.invocation.callId
  })
}

/** Local original memberships form a set; an unread peer is never required or invented. */
export function conversationInvocationMembers(record: ConversationSourceRecord): readonly Extract<ConversationRelation, { kind: 'invocation-member' }>[] {
  if (!record.reference) return []
  const members = conversationInvocationFacts(record).map(fact => ({ kind: 'invocation-member' as const,
    part: { record: record.reference!, recordRevision: record.revision, selector: fact.selector },
    invocation: { hostId: record.reference!.hostId, agentSessionId: record.reference!.agentSessionId, ...fact.invocation } }))
  return [...new Map(members.map(member => [JSON.stringify(canonical(member)), member])).values()]
}

/** A canonical reading target is an exact same-source fact, never an event/version claim. */
export function conversationSameEventTarget(record: ConversationSourceRecord, nativeSource?: AgentSessionHistorySource): ConversationItemRef | undefined {
  const target = record.original.item.conversation?.sameEvent, reference = record.reference
  return target && reference && target.hostId === reference.hostId && target.agentSessionId === reference.agentSessionId && target.source.kind === 'native' &&
    (!nativeSource || sameSource(target.source, nativeSource)) ? target : undefined
}
/** Explicit identity coalesces name the exact original contributing edge. */
export function conversationEventCoalesces(records: readonly ConversationSourceRecord[], anchorId: string, nativeSource?: AgentSessionHistorySource): NonNullable<ConversationEvent['coalesces']> {
  return records.flatMap(record => {
    const target = conversationSameEventTarget(record, nativeSource)
    return record.id !== anchorId && target && conversationRecordId(target) !== record.id
      ? [{ fromEventIds: [record.id], relation: { kind: 'same-event' as const, from: record.reference!, to: target } }] : []
  })
}
/** Resolve only original accepted edges. A cycle retains each original record identity. */
export function conversationRecordAnchors(records: readonly ConversationSourceRecord[], targets: ReadonlyMap<string, string>): { anchors: ReadonlyMap<string, string>; cyclicRecordIds: readonly string[] } {
  const anchors = new Map<string, string>(), cyclic = new Set<string>()
  for (const record of records) {
    if (anchors.has(record.id)) continue
    const path: string[] = [], visited = new Set<string>(); let id = record.id
    while (targets.has(id) && !anchors.has(id)) {
      if (visited.has(id)) {
        for (const key of path) { anchors.set(key, key); cyclic.add(key) }
        break
      }
      visited.add(id); path.push(id); id = targets.get(id)!
    }
    if (anchors.has(record.id)) continue
    const canonical = anchors.get(id) ?? id
    for (const key of path) anchors.set(key, canonical)
    anchors.set(record.id, canonical)
  }
  return { anchors, cyclicRecordIds: [...cyclic] }
}

/** One semantic owner over already accepted facts. No IO, state, control authority or transcript copy. */
export function projectConversationTimeline(input: ConversationProjectionInput): ConversationTimeline {
  const { agentSessionId, executionHostId } = input
  const page = input.historyPage?.agentSessionId === agentSessionId ? input.historyPage : undefined
  const timeline = input.timeline?.agentSessionId === agentSessionId ? input.timeline : undefined
  const nativeHost = page?.sourceHostId ?? executionHostId, capturedHost = timeline?.sourceHostId ?? executionHostId
  const conflictingHosts = page !== undefined && timeline !== undefined && nativeHost !== undefined && capturedHost !== undefined && nativeHost !== capturedHost
  const sourceHost = page ? nativeHost : capturedHost
  const reference: ConversationRef | null = sourceHost && !conflictingHosts ? { hostId: sourceHost, agentSessionId } : null
  const capturedPositions = new Map(timeline?.stream?.positions.map(position => [position.id, position]) ?? [])
  const unique = (rows: ConversationSourceRecord[]) => [...new Map(rows.map(row => [row.id, row])).values()]
  const make = (original: ConversationSourceRecord['original'], order: ConversationSourceOrder): ConversationSourceRecord => {
    const source: ConversationItemRef['source'] = original.kind === 'native'
      ? { kind: 'native', ...page!.source, recordId: original.item.id } : { kind: 'captured', recordId: original.item.id }
    const hostId = original.kind === 'native' ? nativeHost : capturedHost
    const id = conversationRecordId({ ...(hostId ? { hostId } : {}), agentSessionId, source })
    const position = original.kind === 'captured' ? capturedPositions.get(original.item.id) : undefined
    const sourceOrder = position && timeline?.stream ? { kind: 'captured-stream' as const, epoch: timeline.stream.epoch, firstSequence: position.firstSequence } : order
    return { id, reference: hostId ? { hostId, agentSessionId, source } : null, revision: position?.revision ?? conversationRevision(original.item), order: input.sourceOrders?.get(id) ?? sourceOrder, original }
  }
  const native = unique(page?.items.map((item, indexInPage) => make({ kind: 'native', item }, { kind: 'native-page', source: page.source, indexInPage })) ?? [])
  const captured = unique(timeline?.items.flatMap((item, indexInWindow) => item.agentSessionId === agentSessionId ? [make({ kind: 'captured', item }, { kind: 'captured-window', revision: timeline.revision, indexInWindow })] : []) ?? [])
  const records = mergeSources(native, captured), byId = new Map(records.map(record => [record.id, record]))
  const sources = [...new Map(records.map(record => [sourceKey(sourceOf(record)), sourceOf(record)])).values()]
  if (page && !native.length) sources.push({ kind: 'native', ...page.source })
  if (timeline && !captured.length) sources.push({ kind: 'captured', ...(timeline.stream ? { epoch: timeline.stream.epoch } : {}) })
  const sourceSet = new Map(sources.map(source => [sourceKey(source), source]))
  for (const value of input.coverage ?? []) if (!sourceSet.has(sourceKey(value.source))) { sourceSet.set(sourceKey(value.source), value.source); sources.push(value.source) }
  const defaults = sources.map(source => ({ source, origin: source.kind === 'captured' ? timeline?.stream?.origin ?? 'unknown' as const : 'unknown' as const,
    readExtent: { through: source.kind === 'native' ? 'accepted-page' : `accepted-window:${timeline?.revision ?? 0}` },
    earlier: source.kind === 'native' && page?.nextCursor ? 'more' as const : 'unknown-before' as const,
    current: 'partial' as const, gaps: source.kind === 'captured' ? timeline?.stream?.gaps ?? [] : [] }))
  const coverageBySource = new Map(defaults.map(value => [sourceKey(value.source), value as ConversationSourceCoverage]))
  for (const value of input.coverage ?? []) coverageBySource.set(sourceKey(value.source), value)
  const coverage: ConversationSourceCoverage[] = [...coverageBySource.values()].map(value => ({ ...value, gaps: [...value.gaps] }))
  const gap = (record: ConversationSourceRecord, code: string, message: string, target?: ConversationItemRef) => {
    const row = coverage.find(value => sourceKey(value.source) === sourceKey(sourceOf(record)))
    if (row) { row.current = 'partial'; row.gaps = [...row.gaps, { code, message, ...(target ? { record: target } : {}) }] }
  }
  const relations: ConversationRelation[] = [], edges = new Map<string, { target: string; relation: Extract<ConversationRelation, { kind: 'same-event' }> }>()
  if (conflictingHosts) for (const record of records) gap(record, 'CONVERSATION_SOURCE_HOST_CONFLICT', 'These accepted sources have different original Host namespaces. Original records remain independently readable; they do not authorize a cross-Host association.', record.reference ?? undefined)
  for (const record of records) {
    const provenance = record.original.item.conversation
    const target = provenance?.sameEvent
    if (target && record.reference) {
      if (!conversationSameEventTarget(record, page?.source)) {
        gap(record, 'CONVERSATION_RELATION_SCOPE', 'The recorded canonical target is outside this accepted source scope.', target)
      } else {
        const relation = { kind: 'same-event' as const, from: record.reference, to: target }
        if (conversationRecordId(target) !== record.id) edges.set(record.id, { target: conversationRecordId(target), relation }); relations.push(relation)
        if (!byId.has(conversationRecordId(target))) gap(record, 'CONVERSATION_ANCHOR_UNREAD', 'The canonical record is unread; accepted contribution content remains readable.', target)
      }
    }
    relations.push(...conversationRecordRelations(record))
    if (provenance?.observes && record.reference && provenance.observes.hostId === record.reference.hostId && provenance.observes.agentSessionId === agentSessionId) {
      if (!byId.has(conversationRecordId(provenance.observes))) gap(record, 'CONVERSATION_OBSERVED_TARGET_UNREAD', 'The exact observed target is unread; this original observation remains independently readable.', provenance.observes)
    }
  }
  const readQuestions = new Set(native.flatMap(record => record.original.kind === 'native' ? record.original.item.questionRequest?.questions.map(question => question.id) ?? [] : []))
  for (const record of native) if (record.original.kind === 'native' && record.original.item.questionAnswers?.some(answer => !readQuestions.has(answer.questionId))) {
    gap(record, 'CONVERSATION_QUESTION_TARGET_UNREAD', 'This original answer names a question whose request record is unread; its question IDs and original content are retained without guessing a record reference.', record.reference ?? undefined)
  }
  const resolved = conversationRecordAnchors(records, new Map([...edges].map(([id, edge]) => [id, edge.target])))
  for (const id of resolved.cyclicRecordIds) { const original = byId.get(id); if (original) gap(original, 'CONVERSATION_RELATION_CYCLE', 'Conflicting event relations retain the original independent record.') }
  const anchor = (record: ConversationSourceRecord): string => resolved.anchors.get(record.id)!
  for (const record of records) relations.push(...conversationInvocationMembers(record))
  const relationsByRecord = new Map<string, Set<ConversationRelation>>()
  for (const relation of relations) {
    const from = relation.kind === 'invocation-member' ? relation.part.record : relation.from
    const key = conversationRecordId(from), group = relationsByRecord.get(key) ?? new Set<ConversationRelation>()
    group.add(relation); relationsByRecord.set(key, group)
  }
  const groups = new Map<string, ConversationSourceRecord[]>()
  for (const record of records) { const id = anchor(record), group = groups.get(id) ?? []; group.push(record); groups.set(id, group) }
  const canonicalReferences = new Map([...edges.values()].map(edge => [edge.target, edge.relation.to]))
  const forward = new Map<string, Set<string>>(), incoming = new Map([...groups.keys()].map(id => [id, 0]))
  const anchored = new Map(records.map(record => [record.id, anchor(record)]))
  // Source order constrains event placement even when an earlier observation points at a later native record.
  for (const stream of [native, captured]) {
    let before: string | undefined
    for (const record of stream) {
      const id = anchored.get(record.id)!
      if (before !== undefined && before !== id) {
        const next = forward.get(before) ?? new Set<string>()
        if (!next.has(id)) { next.add(id); incoming.set(id, incoming.get(id)! + 1) }
        forward.set(before, next)
      }
      before = id
    }
  }
  const rank = new Map(records.map((record, at) => [record.id, at]))
  const priority = new Map([...groups].map(([id, group]) => [id, rank.get(id) ?? rank.get(group[0]!.id)!]))
  const ready: string[] = [], ordered: string[] = []
  const less = (a: string, b: string) => priority.get(a)! < priority.get(b)!
  const push = (id: string) => {
    ready.push(id); let at = ready.length - 1
    while (at > 0) { const parent = (at - 1) >>> 1; if (!less(ready[at]!, ready[parent]!)) break; [ready[at], ready[parent]] = [ready[parent]!, ready[at]!]; at = parent }
  }
  const pop = () => {
    const id = ready[0]!, last = ready.pop()!
    if (ready.length) {
      ready[0] = last; let at = 0
      for (;;) { const left = at * 2 + 1, right = left + 1; if (left >= ready.length) break
        const child = right < ready.length && less(ready[right]!, ready[left]!) ? right : left
        if (!less(ready[child]!, ready[at]!)) break; [ready[at], ready[child]] = [ready[child]!, ready[at]!]; at = child }
    }
    return id
  }
  for (const [id, degree] of incoming) if (!degree) push(id)
  while (ready.length) { const id = pop(); ordered.push(id); for (const next of forward.get(id) ?? []) { const count = incoming.get(next)! - 1; incoming.set(next, count); if (!count) push(next) } }
  if (ordered.length !== groups.size) for (const [id, group] of groups) if (incoming.get(id)) {
    for (const record of group) gap(record, 'CONVERSATION_ORDER_CONFLICT', 'The accepted source sequences conflict after association; original records remain readable and cross-source order is partial.')
    ordered.push(id)
  }
  const events: ConversationEvent[] = ordered.map(id => {
    const group = groups.get(id)!

    const primary = byId.get(id) ?? group.find(record => record.original.kind === 'native') ?? group[0]!
    const related = [...new Set(group.flatMap(record => [...(relationsByRecord.get(record.id) ?? [])]))]
    const coalesces = conversationEventCoalesces(group, id, page?.source)
    const body = [primary, ...group.filter(record => record !== primary)]
    const content = body.flatMap(record => selectors(record).map(selector => ({ recordId: record.id, recordRevision: record.revision, selector, placement: record === primary ? 'body' as const : 'detail' as const })))
    const attribution = conversationEventAuthor(group, primary, agentSessionId)
    for (const recordId of attribution.conflictingRecordIds) gap(byId.get(recordId)!, 'CONVERSATION_AUTHOR_CONFLICT',
      'The same event has conflicting recorded authors; original attributions remain readable.', byId.get(recordId)!.reference ?? undefined)
    const event = { id, anchorId: id, reference: byId.get(id)?.reference ?? canonicalReferences.get(id) ?? primary.reference,
      role: conversationRecordRole(primary), author: attribution.author, recordIds: group.map(record => record.id), content, relations: related,
      ...(coalesces.length ? { coalesces } : {}) }
    return { ...event, revision: conversationRevision({ policy: 1, versions: group.map(record => [record.id, record.revision]), event }) }
  })
  return { reference, agentSessionId, scope: { sources }, records, events, coverage,
    order: { basis: 'source-and-relations', crossSource: sources.length > 1 ? 'partial' : 'confirmed' } }
}
