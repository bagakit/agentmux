import { sha256 } from '@noble/hashes/sha2.js'
import type { AgentSessionHistoryItem, AgentSessionHistoryPage, AgentSessionHistorySource, AgentSessionUserMessageAuthor, AgentTimelineItem, AgentTimelineItemKind, AgentTimelineSnapshot } from './types.js'
import type { ConversationItemRef, ConversationRef } from './conversation.js'
import { recordedConversationAuthor } from './conversation-author.js'
import { conversationQuestionIdentity, type ConversationQuestionIdentity } from './conversation-questions.js'
import { agentPromptInputId, type AgentPromptInputKey } from './agent-prompt-condition.js'

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
  /** Canonical Provider item identity; physical recordId remains independent. */
  nativeInput?: { source: AgentSessionHistorySource; semanticItemId: string; turnId: string; clientCorrelation: string }
  /** Core confirmed this native item against the original durable input claim. No sharing/control authority. */
  adoptedInput?: { key: import('./agent-prompt-condition.js').AgentPromptInputKey; purpose?: 'a2a-notification' }
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
/** Bounded original-reading witnesses, not a claim of whole-Session uniqueness. No bodies or write authority. */
export type ConversationInputWitness = { record: ConversationItemRef; recordRevision: string; semanticItemId: string; turnId: string; clientCorrelation: string; key?: AgentPromptInputKey }
export type ConversationInputAdoptionContext = { unconfirmed?: true; witnesses: readonly ConversationInputWitness[] }
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
  inputAdoption?: ConversationInputAdoptionContext
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
  inputAdoption?: ConversationInputAdoptionContext
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]))
  return value
}
/** Compare the same canonical values as content versions, without computing two digests. */
export function conversationValuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
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
  if (original.kind === 'native') return original.item.conversation?.adoptedInput?.purpose === 'a2a-notification' ? 'notice' : original.item.questionRequest ? 'interaction'
    : original.item.kind === 'activity' ? 'process' : original.item.kind === 'system-message' ? 'notice' : 'message'
  const item = original.item
  if (item.kind === 'assistant_message' && item.source === 'native-hook' && recordedConversationAuthor(item).kind === 'unknown') return 'observation'
  return capturedRoles[item.kind]
}
export function conversationRecordAuthor(record: ConversationSourceRecord, sessionId: string): ConversationAuthor {
  if (record.original.kind === 'native') return record.original.item.conversation?.adoptedInput?.purpose === 'a2a-notification' ? { kind: 'system' } : record.original.item.kind === 'assistant-message' ? { kind: 'agent', agentSessionId: sessionId }
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
export function conversationSameEventTarget(record: ConversationSourceRecord, nativeSource?: AgentSessionHistorySource, adoptedTarget?: ConversationItemRef): ConversationItemRef | undefined {
  const target = record.original.item.conversation?.sameEvent ?? adoptedTarget, reference = record.reference
  return target && reference && target.hostId === reference.hostId && target.agentSessionId === reference.agentSessionId && target.source.kind === 'native' &&
    (!nativeSource || sameSource(target.source, nativeSource)) ? target : undefined
}
/** Explicit identity coalesces name the exact original contributing edge. */
export function conversationEventCoalesces(records: readonly ConversationSourceRecord[], anchorId: string, nativeSource?: AgentSessionHistorySource, adoptedTargets?: ReadonlyMap<string, ConversationItemRef>): NonNullable<ConversationEvent['coalesces']> {
  return records.flatMap(record => {
    const target = conversationSameEventTarget(record, nativeSource, adoptedTargets?.get(record.id))
    return record.id !== anchorId && target && conversationRecordId(target) !== record.id
      ? [{ fromEventIds: [record.id], relation: { kind: 'same-event' as const, from: record.reference!, to: target } }] : []
  })
}

export function conversationInputKey(record: ConversationSourceRecord): string | undefined {
  const key = record.original.kind === 'native' ? record.original.item.conversation?.adoptedInput?.key
    : record.original.item.kind === 'user_message' && record.original.item.source === 'user' ||
      record.original.item.kind === 'system_message' && record.original.item.source === 'agentmux' && record.original.item.a2aNotificationId !== undefined
      ? record.original.item.inputRef : undefined
  return key && record.reference && key.agentSessionId === record.reference.agentSessionId
    ? inputIdentity(record.reference.hostId, key) : undefined
}
const inputIdentity = (hostId: string, key: AgentPromptInputKey): string => JSON.stringify([hostId, key.kind, key.agentSessionId, key.expectedRun.runId, agentPromptInputId(key)])
export const conversationInputWitnessKey = (fact: ConversationInputWitness): string | undefined => fact.key ? inputIdentity(fact.record.hostId, fact.key) : undefined
const inputWitnessGroup = (fact: ConversationInputWitness): string => {
  const source = fact.record.source
  return JSON.stringify([fact.record.hostId, fact.record.agentSessionId, source.kind === 'native' ? source.providerId : null,
    source.kind === 'native' ? source.nativeSessionId : null, fact.turnId, fact.clientCorrelation])
}
export function conversationNativeInputWitness(record: ConversationSourceRecord): ConversationInputWitness | undefined {
  if (record.original.kind !== 'native' || record.original.item.kind !== 'user-message' || record.reference?.source.kind !== 'native') return undefined
  const fact = record.original.item.conversation?.nativeInput, adopted = record.original.item.conversation?.adoptedInput
  // A branded canonical candidate supplies no input key or adoption authority.
  // Only an exact qualified witness can relate its complete token/source/turn to a key.
  return fact && fact.clientCorrelation.startsWith('amux-input-v1.') && fact.clientCorrelation.length <= 8192 &&
    (!adopted || conversationInputKey(record)) && record.original.item.turnId === fact.turnId && sameSource(fact.source, record.reference.source)
    ? { record: record.reference, recordRevision: record.revision, semanticItemId: fact.semanticItemId, turnId: fact.turnId,
      clientCorrelation: fact.clientCorrelation, ...(adopted ? { key: adopted.key } : {}) } : undefined
}
/** One edge owner for accepted inventory plus retained, bounded original reading witnesses. */
export function conversationInputAdoptionEdges(records: readonly ConversationSourceRecord[], context?: ConversationInputAdoptionContext): {
  targets: ReadonlyMap<string, ConversationItemRef>; byKey: ReadonlyMap<string, readonly ConversationInputWitness[]>; ambiguous: ReadonlySet<string>; unconfirmed: boolean; witnesses: readonly ConversationInputWitness[]
} {
  const byKey = new Map<string, ConversationInputWitness[]>(), groups = new Map<string, ConversationInputWitness[]>(), ambiguous = new Set<string>(), targets = new Map<string, ConversationItemRef>()
  const current = new Map(records.map(record => [record.id, record]))
  const unconfirmed = !!context?.unconfirmed || (context?.witnesses ?? []).some(fact => {
    const record = current.get(conversationRecordId(fact.record))
    if (!record || record.revision === fact.recordRevision) return false
    const next = conversationNativeInputWitness(record)
    return !next || next.semanticItemId !== fact.semanticItemId || inputWitnessGroup(next) !== inputWitnessGroup(fact) ||
      !!fact.key && conversationInputWitnessKey(next) !== conversationInputWitnessKey(fact)
  })
  for (const fact of [...records.flatMap(record => { const value = conversationNativeInputWitness(record); return value ? [value] : [] }), ...(context?.witnesses ?? [])]) {
    const group = inputWitnessGroup(fact), known = groups.get(group) ?? []
    const duplicate = known.findIndex(value => conversationRecordId(value.record) === conversationRecordId(fact.record) && value.semanticItemId === fact.semanticItemId)
    if (duplicate >= 0) {
      if (!known[duplicate]!.key && fact.key) known[duplicate] = fact
    } else if (known.length < 2) known.push(fact)
    // Two originals suffice for conflict, but later qualification must not be lost
    // behind two earlier candidates. Keep that exact positive and one counterexample.
    else if (fact.key && !known.some(value => value.key)) known[1] = fact
    groups.set(group, known)
  }
  for (const facts of groups.values()) for (const key of new Set(facts.flatMap(fact => { const key = conversationInputWitnessKey(fact); return key ? [key] : [] }))) {
    const known = byKey.get(key) ?? []
    for (const fact of facts) if (!known.some(value => conversationRecordId(value.record) === conversationRecordId(fact.record) && value.semanticItemId === fact.semanticItemId)) known.push(fact)
    byKey.set(key, known)
    if (known.length > 1) ambiguous.add(key)
  }
  for (const record of records) {
    const key = conversationInputKey(record), candidates = key ? byKey.get(key) : undefined
    if (record.original.kind === 'captured' && key && candidates?.length === 1 && candidates[0]!.key && !unconfirmed && !ambiguous.has(key)) targets.set(record.id, candidates[0]!.record)
  }
  return { targets, byKey, ambiguous, unconfirmed, witnesses: [...groups.values()].flat() }
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

type ConversationEventFacts = Omit<ConversationEvent, 'revision'>
type ProjectedConversationTimeline<Event> = Omit<ConversationTimeline, 'events'> & { events: Event[] }

/** One semantic owner over already accepted facts. No IO, state, control authority or transcript copy. */
function projectConversationGraph<Event>(input: ConversationProjectionInput,
  materializeEvent: (event: ConversationEventFacts, records: readonly ConversationSourceRecord[]) => Event): ProjectedConversationTimeline<Event> {
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
  const adopted = conversationInputAdoptionEdges(records, input.inputAdoption)
  const adoptionGaps = new Set<string>()
  const adoptionGap = (record: ConversationSourceRecord, code: string, message: string) => {
    const key = JSON.stringify([sourceKey(sourceOf(record)), code])
    // Source coverage is collective. Exact diagnostics and ref witnesses remain on
    // each original/event; duplicating this status for every row can block reading.
    if (!adoptionGaps.has(key)) { adoptionGaps.add(key); gap(record, code, message) }
  }
  if (conflictingHosts) for (const record of records) gap(record, 'CONVERSATION_SOURCE_HOST_CONFLICT', 'These accepted sources have different original Host namespaces. Original records remain independently readable; they do not authorize a cross-Host association.', record.reference ?? undefined)
  for (const record of records) {
    const provenance = record.original.item.conversation
    const target = provenance?.sameEvent ?? adopted.targets.get(record.id)
    const inputKey = conversationInputKey(record)
    if (inputKey && (adopted.ambiguous.has(inputKey) || adopted.unconfirmed)) adoptionGap(record,
      adopted.ambiguous.has(inputKey) ? 'CONVERSATION_INPUT_ADOPTION_AMBIGUOUS' : 'CONVERSATION_INPUT_ADOPTION_COVERAGE_UNKNOWN',
      'The accepted source contains inputs with conflicting or incomplete native item witnesses. Original utterances and submissions remain independently readable.')
    const diagnostic = record.original.item.conversationDiagnostic
    if (diagnostic?.code === 'CONVERSATION_INPUT_ADOPTION_UNCONFIRMED') adoptionGap(record, diagnostic.code, diagnostic.message)
    if (target && record.reference) {
      if (!conversationSameEventTarget(record, page?.source, adopted.targets.get(record.id))) {
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
  const events = ordered.map(id => {
    const group = groups.get(id)!

    const primary = byId.get(id) ?? group.find(record => record.original.kind === 'native') ?? group[0]!
    const related = [...new Set(group.flatMap(record => [...(relationsByRecord.get(record.id) ?? [])]))]
    const coalesces = conversationEventCoalesces(group, id, page?.source, adopted.targets)
    const localIds = new Set(group.map(record => record.id)), inputKeys = new Set(group.flatMap(record => { const key = conversationInputKey(record); return key ? [key] : [] }))
    const witnesses = [...inputKeys].flatMap(key => adopted.byKey.get(key) ?? []).filter(fact => !localIds.has(conversationRecordId(fact.record)))
    const inputAdoption = inputKeys.size && (witnesses.length || adopted.unconfirmed)
      ? { ...(adopted.unconfirmed ? { unconfirmed: true as const } : {}), witnesses } : undefined
    const body = [primary, ...group.filter(record => record !== primary)]
    const content = body.flatMap(record => selectors(record).map(selector => ({ recordId: record.id, recordRevision: record.revision, selector, placement: record === primary ? 'body' as const : 'detail' as const })))
    const attribution = conversationEventAuthor(group, primary, agentSessionId)
    for (const recordId of attribution.conflictingRecordIds) gap(byId.get(recordId)!, 'CONVERSATION_AUTHOR_CONFLICT',
      'The same event has conflicting recorded authors; original attributions remain readable.', byId.get(recordId)!.reference ?? undefined)
    const event: ConversationEventFacts = { id, anchorId: id, reference: byId.get(id)?.reference ?? canonicalReferences.get(id) ?? primary.reference,
      role: conversationRecordRole(primary), author: attribution.author, recordIds: group.map(record => record.id), content, relations: related,
      ...(inputAdoption ? { inputAdoption } : {}),
      ...(coalesces.length ? { coalesces } : {}) }
    return materializeEvent(event, group)
  })
  return { reference, agentSessionId, scope: { sources }, records, events, coverage,
    order: { basis: 'source-and-relations', crossSource: sources.length > 1 ? 'partial' : 'confirmed' } }
}

export function projectConversationTimeline(input: ConversationProjectionInput): ConversationTimeline {
  return projectConversationGraph(input, (event, group) => ({ ...event,
    revision: conversationRevision({ policy: 1, versions: group.map(record => [record.id, record.revision]), event }) }))
}

/** Internal graph input for the version-free SDK summary adapter. Source record versions remain exact. */
export function projectConversationEventFacts(input: ConversationProjectionInput) {
  return projectConversationGraph(input, event => event)
}
