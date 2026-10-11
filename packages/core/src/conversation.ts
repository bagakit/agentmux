import type { AgentSessionHistoryContentPart, AgentSessionHistoryItem, AgentSessionHistoryPage, AgentSessionHistorySource, AgentSessionUserMessage, AgentTimelineItem, AgentTimelineSnapshot } from './types.js'
import { projectSessionUserMessages } from './session-user-messages.js'
import { projectConversationTimeline, conversationRecordRole, conversationRecordAuthor, type ConversationAuthor, type ConversationEvent, type ConversationSourceRecord, type ConversationProjectionInput } from './conversation-timeline.js'

export type AgentConversationRecordSource =
  | (AgentSessionHistorySource & { kind: 'native'; recordId: string })
  | { kind: 'captured'; recordId: string }

/** A view of already read facts. The original record owns its body and metadata. */
export type AgentConversationRecord = {
  id: string
  rawId: string
  agentSessionId: string
  executionHostId?: string
  sourceHostId?: string | null
  kind: AgentSessionHistoryItem['kind']
  source: AgentConversationRecordSource
  content: string
  contentParts: readonly AgentSessionHistoryContentPart[]
  recordedAt?: number
  author?: ConversationAuthor
  role?: ConversationEvent['role']
  event?: ConversationEvent
  records?: readonly ConversationSourceRecord[]
  input?: AgentSessionUserMessage
  original: { kind: 'native'; item: AgentSessionHistoryItem } | { kind: 'captured'; item: AgentTimelineItem }
}

// The raw time remains in original; an invalid Date cannot acquire a position.
function recordedTime(at: number | undefined): { recordedAt?: number } {
  return at !== undefined && Number.isFinite(at) && Math.abs(at) <= 8.64e15 ? { recordedAt: at } : {}
}

/** Source-record adapter over the one Core timeline. Existing row and input keys remain original. */
export function projectConversationReading(input: ConversationProjectionInput & { routeHostId?: string }): { timeline: ReturnType<typeof projectConversationTimeline>; records: AgentConversationRecord[]; originalRecords: AgentConversationRecord[] } {
  const timeline = projectConversationTimeline(input)
  return adaptConversationTimeline(input, timeline)
}

/** Presentation adapter only: accepted backend events, roles and order are unchanged. */
export function projectConversationWindow(snapshot: import('./conversation-changes.js').ConversationWindowSnapshot) {
  const units = [...snapshot.units].reverse(), records = units.flatMap(unit => unit.records)
  const native = snapshot.scope.sources.find(source => source.kind === 'native')
  const historyPage: AgentSessionHistoryPage | undefined = native?.kind === 'native' ? {
    agentSessionId: snapshot.agentSessionId, sourceHostId: snapshot.sourceHostId,
    source: { providerId: native.providerId, nativeSessionId: native.nativeSessionId },
    items: records.flatMap(record => record.original.kind === 'native' ? [record.original.item] : []), nextCursor: snapshot.window.navigation.older
  } : undefined
  const captured: AgentTimelineSnapshot = { agentSessionId: snapshot.agentSessionId, sourceHostId: snapshot.sourceHostId,
    revision: snapshot.window.revision, items: records.flatMap(record => record.original.kind === 'captured' ? [record.original.item] : []) }
  const timeline: ReturnType<typeof projectConversationTimeline> = {
    reference: { hostId: snapshot.sourceHostId, agentSessionId: snapshot.agentSessionId }, agentSessionId: snapshot.agentSessionId,
    scope: snapshot.scope, records, events: units.map(unit => unit.event), coverage: snapshot.coverage,
    order: { basis: snapshot.order.basis, crossSource: snapshot.order.crossSource }
  }
  return { ...adaptConversationTimeline({ agentSessionId: snapshot.agentSessionId, routeHostId: snapshot.hostId,
    ...(historyPage ? { historyPage } : {}), timeline: captured }, timeline), historyPage, captured }
}

function adaptConversationTimeline(input: ConversationProjectionInput & { routeHostId?: string }, timeline: ReturnType<typeof projectConversationTimeline>) {
  const users = projectSessionUserMessages(input)
  const inputs = new Map(users.map(value => [JSON.stringify([value.source.kind, value.rawId]), value]))
  const records = new Map(timeline.records.map(record => [record.id, record]))
  function adapt(record: ConversationSourceRecord, contentParts: readonly AgentSessionHistoryContentPart[], event?: ConversationEvent): AgentConversationRecord {
    const original = record.original, item = original.item
    const source: AgentConversationRecordSource = original.kind === 'native'
      ? { kind: 'native', ...input.historyPage!.source, recordId: item.id } : { kind: 'captured', recordId: item.id }
    const user = inputs.get(JSON.stringify([source.kind, item.id]))
    const kind: AgentSessionHistoryItem['kind'] = original.kind === 'native' ? original.item.kind
      : original.item.kind === 'user_message' ? 'user-message' : original.item.kind === 'assistant_message' ? 'assistant-message'
      : original.item.kind === 'system_message' ? 'system-message' : 'activity'
    const originalId = event?.id ?? record.id, routeHostId = input.routeHostId ?? input.executionHostId
    return { id: input.routeHostId ? JSON.stringify([input.routeHostId, originalId]) : originalId, rawId: item.id, agentSessionId: input.agentSessionId,
      ...(routeHostId ? { executionHostId: routeHostId } : {}), sourceHostId: record.reference?.hostId ?? null, kind, source,
      content: user?.content ?? contentParts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n'), contentParts,
      ...recordedTime(original.kind === 'native' ? original.item.startedAt : original.item.createdAt),
      author: event?.author ?? user?.author ?? conversationRecordAuthor(record, input.agentSessionId),
      ...(user ? { input: user } : {}), original, role: event?.role ?? conversationRecordRole(record),
      ...(event ? { event } : {}), records: event ? event.recordIds.map(id => records.get(id)!) : [record] }
  }
  function parts(slots: ConversationEvent['content']): readonly AgentSessionHistoryContentPart[] {
    return slots.flatMap(slot => {
      const owner = records.get(slot.recordId)
      if (!owner || owner.revision !== slot.recordRevision) return []
      if (owner.original.kind === 'native' && slot.selector.kind === 'native-part') return [owner.original.item.contentParts[slot.selector.partIndex]!]
      if (owner.original.kind === 'captured' && slot.selector.kind === 'captured-field') return [{ kind: 'text' as const, text: owner.original.item[slot.selector.field]! }]
      return []
    })
  }
  const sourceSlots = new Map<string, ConversationEvent['content'][number][]>()
  for (const event of timeline.events) for (const slot of event.content) {
    const list = sourceSlots.get(slot.recordId) ?? []; list.push(slot); sourceSlots.set(slot.recordId, list)
  }
  const originalRecords = timeline.records.map(record => adapt(record, record.original.kind === 'native' ? record.original.item.contentParts : parts(sourceSlots.get(record.id) ?? [])))
  const projected = timeline.events.map(event => {
    // A canonical anchor may be unread. The complete accepted contribution is still readable.
    const record = records.get(event.anchorId) ?? records.get(event.content[0]?.recordId ?? '') ?? records.get(event.recordIds[0]!)!
    const projectedParts = parts(event.content.filter(slot => slot.placement === 'body'))
    const original = record.original
    const contentParts = original.kind === 'native' && projectedParts.length === original.item.contentParts.length
      && projectedParts.every((part, index) => part === original.item.contentParts[index]) ? original.item.contentParts : projectedParts
    return adapt(record, contentParts, event)
  })
  return { timeline, records: projected, originalRecords }
}

export function projectConversationRecords(input: ConversationProjectionInput & { routeHostId?: string }): AgentConversationRecord[] {
  return projectConversationReading(input).records
}

/** A reference to the original Session, never a new conversation lifecycle. */
export type ConversationRef = import('./session-history-read-codec.js').AgentSessionContextReference

/** Exact original record within its Session and source; never a body or display position. */
export type ConversationItemRef = ConversationRef & { source: AgentConversationRecordSource }

/** Unknown Host does not acquire a navigation identity or hide the recorded content. */
export function conversationItemRef(record: Pick<AgentConversationRecord, 'agentSessionId' | 'executionHostId' | 'sourceHostId' | 'source'>): ConversationItemRef | null {
  const hostId = record.sourceHostId === undefined ? record.executionHostId : record.sourceHostId
  return hostId
    ? { hostId, agentSessionId: record.agentSessionId, source: { ...record.source } }
    : null
}

export { parseAgentSessionHistoryReadPage, consumeJsonReadEntry, type JsonReadAssembly, type JsonReadEntry,
  type AgentSessionHistoryReadPage } from './session-history-read-codec.js'

export * from './conversation-changes.js'
export * from './conversation-questions.js'

export * from './conversation-landmarks.js'

export * from './conversation-timeline.js'
export * from './conversation-author.js'

/** Only original Provider final/completed facts qualify a completed native reply. */
export function completedNativeReply(item: AgentSessionHistoryItem): boolean {
  return item.kind === 'assistant-message' && item.messagePhase !== 'progress'
    && (item.messagePhase === 'final' || item.completedAt !== undefined)
}
