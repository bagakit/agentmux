import type { AgentSessionHistoryContentPart, AgentSessionHistoryItem, AgentSessionHistoryPage, AgentSessionHistorySource, AgentSessionUserMessage, AgentTimelineItem, AgentTimelineSnapshot } from './types.js'
import { projectSessionUserMessages } from './session-user-messages.js'
import { projectConversationTimeline, type ConversationAuthor, type ConversationEvent, type ConversationSourceRecord, type ConversationProjectionInput } from './conversation-timeline.js'

export type AgentConversationRecordSource =
  | (AgentSessionHistorySource & { kind: 'native'; recordId: string })
  | { kind: 'captured'; recordId: string }

/** A view of already read facts. The original record owns its body and metadata. */
export type AgentConversationRecord = {
  id: string
  rawId: string
  agentSessionId: string
  executionHostId?: string
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
export function projectConversationRecords(input: ConversationProjectionInput): AgentConversationRecord[] {
  const timeline = projectConversationTimeline(input)
  const users = projectSessionUserMessages(input)
  const inputs = new Map(users.map(value => [JSON.stringify([value.source.kind, value.rawId]), value]))
  const records = new Map(timeline.records.map(record => [record.id, record]))
  return timeline.events.map(event => {
    // A canonical anchor may be unread. The complete accepted contribution is still readable.
    const record = records.get(event.anchorId) ?? records.get(event.content[0]?.recordId ?? '') ?? records.get(event.recordIds[0]!)!
    const original = record.original, item = original.item
    const source: AgentConversationRecordSource = original.kind === 'native'
      ? { kind: 'native', ...input.historyPage!.source, recordId: item.id } : { kind: 'captured', recordId: item.id }
    const user = inputs.get(JSON.stringify([source.kind, item.id]))
    const kind: AgentSessionHistoryItem['kind'] = original.kind === 'native' ? original.item.kind
      : original.item.kind === 'user_message' ? 'user-message' : original.item.kind === 'assistant_message' ? 'assistant-message'
      : original.item.kind === 'system_message' ? 'system-message' : 'activity'
    const projectedParts: readonly AgentSessionHistoryContentPart[] = event.content.flatMap(slot => {
      if (slot.placement !== 'body') return []
      const owner = records.get(slot.recordId)
      if (!owner || owner.revision !== slot.recordRevision) return []
      if (owner.original.kind === 'native' && slot.selector.kind === 'native-part') return [owner.original.item.contentParts[slot.selector.partIndex]!]
      if (owner.original.kind === 'captured' && slot.selector.kind === 'captured-field') return [{ kind: 'text' as const, text: owner.original.item[slot.selector.field]! }]
      return []
    })
    const contentParts = original.kind === 'native' && projectedParts.length === original.item.contentParts.length
      && projectedParts.every((part, index) => part === original.item.contentParts[index]) ? original.item.contentParts : projectedParts
    return { id: event.id, rawId: item.id, agentSessionId: input.agentSessionId, ...(input.executionHostId ? { executionHostId: input.executionHostId } : {}), kind, source,
      content: user?.content ?? contentParts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n'), contentParts,
      ...recordedTime(original.kind === 'native' ? original.item.startedAt : original.item.createdAt), author: event.author,
      ...(user ? { input: user } : {}), original, role: event.role, event, records: event.recordIds.map(id => records.get(id)!) }
  })
}

/** A reference to the original Session, never a new conversation lifecycle. */
export type ConversationRef = import('./session-history-read-codec.js').AgentSessionContextReference

/** Exact original record within its Session and source; never a body or display position. */
export type ConversationItemRef = ConversationRef & { source: AgentConversationRecordSource }

/** Unknown Host does not acquire a navigation identity or hide the recorded content. */
export function conversationItemRef(record: Pick<AgentConversationRecord, 'agentSessionId' | 'executionHostId' | 'source'>): ConversationItemRef | null {
  return record.executionHostId
    ? { hostId: record.executionHostId, agentSessionId: record.agentSessionId, source: { ...record.source } }
    : null
}

/** Retain the original bounded envelope rather than duplicating scope or body bytes. */
export type AgentConversationReadPage = import('./session-history-read-codec.js').AgentSessionHistoryReadPage
export { parseAgentSessionHistoryReadPage as parseConversationReadPage } from './session-history-read-codec.js'

export * from './conversation-changes.js'
export * from './conversation-questions.js'

export * from './conversation-landmarks.js'

export * from './conversation-timeline.js'
export * from './conversation-author.js'
