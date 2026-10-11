import { sha256 } from '@noble/hashes/sha2.js'
import type { AgentSessionHistoryItem, AgentSessionHistoryPage, AgentSessionHistorySource, AgentSessionUserMessageAuthor, AgentTimelineItem, AgentTimelineItemKind, AgentTimelineSnapshot } from './types.js'
import type { ConversationItemRef, ConversationRef } from './conversation.js'
import { recordedConversationAuthor } from './conversation-author.js'
import { projectConversationQuestions, type ConversationQuestionReference } from './conversation-questions.js'

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
  | { kind: 'same-invocation'; from: ConversationContentRef; to: ConversationContentRef; invocation: ConversationInvocationRef }
  | { kind: 'answers'; from: ConversationItemRef; question: ConversationQuestionReference }
  | { kind: 'observes'; from: ConversationItemRef; target: ConversationItemRef | ConversationInvocationRef }
export type ConversationSourceOrder =
  | { kind: 'native-page'; source: AgentSessionHistorySource; pageWitness?: string; indexInPage: number }
  | { kind: 'captured-stream'; epoch: string; firstSequence: number }
  | { kind: 'captured-window'; revision: number; indexInWindow: number }
export type ConversationSourceRef = ({ kind: 'native' } & AgentSessionHistorySource) | { kind: 'captured'; epoch?: string }
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
function sourceKey(source: ConversationSourceRef): string { return JSON.stringify(source.kind === 'native' ? ['native', source.providerId, source.nativeSessionId] : ['captured', source.epoch ?? null]) }
function sameSource(a: AgentSessionHistorySource, b: AgentSessionHistorySource): boolean { return a.providerId === b.providerId && a.nativeSessionId === b.nativeSessionId }
function sourceOf(record: ConversationSourceRecord): ConversationSourceRef {
  return record.original.kind === 'native' ? { kind: 'native', ...(record.order as Extract<ConversationSourceOrder, { kind: 'native-page' }>).source }
    : { kind: 'captured', ...(record.order.kind === 'captured-stream' ? { epoch: record.order.epoch } : {}) }
}
/** Keeps both original source sequences, including backward/missing clocks. Time only selects the next incomparable source head. */
function mergeSources(native: ConversationSourceRecord[], captured: ConversationSourceRecord[]): ConversationSourceRecord[] {
  const result: ConversationSourceRecord[] = []
  let n = 0, c = 0
  while (n < native.length || c < captured.length) {
    if (n === native.length) { result.push(captured[c++]!); continue }
    if (c === captured.length) { result.push(native[n++]!); continue }
    const a = native[n]!, b = captured[c]!, at = time(a), bt = time(b)
    const before = at !== undefined && bt !== undefined && at !== bt ? at < bt : sourceKey(sourceOf(a)) < sourceKey(sourceOf(b))
    result.push(before ? native[n++]! : captured[c++]!)
  }
  return result
}
function validSelector(record: ConversationSourceRecord, selector: ConversationSelector): boolean {
  return record.original.kind === 'native' ? selector.kind === 'native-part' && Number.isSafeInteger(selector.partIndex) && selector.partIndex >= 0 && selector.partIndex < record.original.item.contentParts.length
    : selector.kind === 'captured-field' && record.original.item[selector.field] !== undefined
}

function invocationFacts(record: ConversationSourceRecord): readonly { selector: ConversationSelector; invocation: ConversationInvocation }[] {
  const provenance = record.original.item.conversation
  if (record.original.kind !== 'native' || !provenance?.nativeInvocationScope) return provenance?.invocations ?? []
  const scope = provenance.nativeInvocationScope
  return record.original.item.contentParts.flatMap((part, partIndex) => (part.kind === 'tool-call' || part.kind === 'tool-result') && part.callId
    ? [{ selector: { kind: 'native-part' as const, partIndex }, invocation: { ...scope, callId: part.callId } }] : [])
}

/** One semantic owner over already accepted facts. No IO, state, control authority or transcript copy. */
export function projectConversationTimeline(input: ConversationProjectionInput): ConversationTimeline {
  const { agentSessionId, executionHostId } = input
  const page = input.historyPage?.agentSessionId === agentSessionId ? input.historyPage : undefined
  const timeline = input.timeline?.agentSessionId === agentSessionId ? input.timeline : undefined
  const reference: ConversationRef | null = executionHostId ? { hostId: executionHostId, agentSessionId } : null
  const capturedPositions = new Map(timeline?.stream?.positions.map(position => [position.id, position]) ?? [])
  const unique = (rows: ConversationSourceRecord[]) => [...new Map(rows.map(row => [row.id, row])).values()]
  const make = (original: ConversationSourceRecord['original'], order: ConversationSourceOrder): ConversationSourceRecord => {
    const source: ConversationItemRef['source'] = original.kind === 'native'
      ? { kind: 'native', ...page!.source, recordId: original.item.id } : { kind: 'captured', recordId: original.item.id }
    const id = conversationRecordId({ ...(executionHostId ? { hostId: executionHostId } : {}), agentSessionId, source })
    const position = original.kind === 'captured' ? capturedPositions.get(original.item.id) : undefined
    const sourceOrder = position && timeline?.stream ? { kind: 'captured-stream' as const, epoch: timeline.stream.epoch, firstSequence: position.firstSequence } : order
    return { id, reference: reference ? { ...reference, source } : null, revision: position?.revision ?? conversationRevision(original.item), order: input.sourceOrders?.get(id) ?? sourceOrder, original }
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
  for (const record of records) {
    const provenance = record.original.item.conversation
    const target = provenance?.sameEvent
    if (target && record.reference) {
      if (target.hostId !== executionHostId || target.agentSessionId !== agentSessionId || target.source.kind !== 'native' || page && !sameSource(target.source, page.source)) {
        gap(record, 'CONVERSATION_RELATION_SCOPE', 'The recorded canonical target is outside this accepted source scope.', target)
      } else {
        const relation = { kind: 'same-event' as const, from: record.reference, to: target }
        if (conversationRecordId(target) !== record.id) edges.set(record.id, { target: conversationRecordId(target), relation }); relations.push(relation)
        if (!byId.has(conversationRecordId(target))) gap(record, 'CONVERSATION_ANCHOR_UNREAD', 'The canonical record is unread; accepted contribution content remains readable.', target)
      }
    }
    if (provenance?.observes && record.reference && provenance.observes.hostId === executionHostId && provenance.observes.agentSessionId === agentSessionId) relations.push({ kind: 'observes', from: record.reference, target: provenance.observes })
  }
  const anchors = new Map<string, string>()
  const anchor = (record: ConversationSourceRecord): string => {
    if (anchors.has(record.id)) return anchors.get(record.id)!
    const path: string[] = [], visited = new Set<string>(); let id = record.id
    while (edges.has(id) && !anchors.has(id)) {
      if (visited.has(id)) {
        for (const key of path) { anchors.set(key, key); const original = byId.get(key); if (original) gap(original, 'CONVERSATION_RELATION_CYCLE', 'Conflicting event relations retain the original independent record.') }
        return record.id
      }
      visited.add(id); path.push(id); id = edges.get(id)!.target
    }
    const canonical = anchors.get(id) ?? id
    for (const key of path) anchors.set(key, canonical)
    anchors.set(record.id, canonical)
    return canonical
  }
  const invocations = new Map<string, { record: ConversationSourceRecord; selector: ConversationSelector; invocation: ConversationInvocationRef }[]>()
  for (const record of records) if (record.reference) for (const fact of invocationFacts(record)) {
    if (!validSelector(record, fact.selector) || page && !sameSource(fact.invocation.source, page.source)) continue
    if (record.original.kind === 'native' && fact.selector.kind === 'native-part') {
      const part = record.original.item.contentParts[fact.selector.partIndex]!
      if ((part.kind !== 'tool-call' && part.kind !== 'tool-result') || part.callId !== fact.invocation.callId) continue
    }
    const invocation = { ...reference!, ...fact.invocation }, key = JSON.stringify(canonical(invocation))
    const group = invocations.get(key) ?? []; group.push({ record, selector: fact.selector, invocation }); invocations.set(key, group)
  }
  // A star records the same exact invocation equivalence without quadratic pair expansion.
  for (const group of invocations.values()) {
    const a = group[0]!
    for (const b of group.slice(1)) {
      if (a.record.id === b.record.id) continue
      relations.push({ kind: 'same-invocation', from: { record: a.record.reference!, recordRevision: a.record.revision, selector: a.selector },
        to: { record: b.record.reference!, recordRevision: b.record.revision, selector: b.selector }, invocation: a.invocation })
    }
  }
  if (page && reference) for (const question of projectConversationQuestions({ agentSessionId, executionHostId, historyPage: page })) for (const value of question.questions) if (value.answer) relations.push({ kind: 'answers',
    from: { ...reference, source: { kind: 'native', ...value.answer.source, recordId: value.answer.recordId } }, question: value.reference })
  const relationsByRecord = new Map<string, Set<ConversationRelation>>()
  for (const relation of relations) {
    const from = 'record' in relation.from ? relation.from.record : relation.from
    const targets = relation.kind === 'same-event' ? [relation.to] : relation.kind === 'same-invocation' ? [relation.to.record]
      : relation.kind === 'answers' ? [{ hostId: executionHostId!, agentSessionId, source: { kind: 'native' as const, ...relation.question.source, recordId: relation.question.recordId } }]
      : 'recordId' in relation.target.source ? [relation.target as ConversationItemRef] : []
    for (const ref of [from, ...targets]) {
      const key = conversationRecordId(ref), group = relationsByRecord.get(key) ?? new Set<ConversationRelation>()
      group.add(relation); relationsByRecord.set(key, group)
    }
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
    const coalesces = group.flatMap(record => record.id !== id && edges.has(record.id) ? [{ fromEventIds: [record.id], relation: edges.get(record.id)!.relation }] : [])
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
