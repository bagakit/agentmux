import type { AgentSessionHistoryContentPart, AgentSessionHistoryItem, AgentSessionHistoryPage, AgentSessionHistorySource, AgentSessionUserMessage, AgentTimelineItem, AgentTimelineSnapshot } from './types.js'
import { projectSessionUserMessages } from './session-user-messages.js'

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
  author?: AgentSessionUserMessage['author'] | { kind: 'system'; providerId: string }
  input?: AgentSessionUserMessage
  original: { kind: 'native'; item: AgentSessionHistoryItem } | { kind: 'captured'; item: AgentTimelineItem }
}

// The raw time remains in original; an invalid Date cannot acquire a position.
function recordedTime(at: number | undefined): { recordedAt?: number } {
  return at !== undefined && Number.isFinite(at) && Math.abs(at) <= 8.64e15 ? { recordedAt: at } : {}
}

/** Source order and source-scoped IDs; no reader, body/time matching or record cache. */
export function projectConversationRecords({ agentSessionId, executionHostId, historyPage, timeline }: {
  agentSessionId: string
  executionHostId?: string | undefined
  historyPage?: AgentSessionHistoryPage | undefined
  timeline?: AgentTimelineSnapshot | undefined
}): AgentConversationRecord[] {
  const inputs = projectSessionUserMessages({ agentSessionId, historyPage, timeline })
  const nativeInputs = new Map(inputs.filter(input => input.source.kind === 'native').map(input => [input.rawId, input]))
  const capturedInputs = new Map(inputs.filter(input => input.source.kind === 'captured').map(input => [input.rawId, input]))
  const records: AgentConversationRecord[] = [], seen = new Set<string>()
  if (historyPage?.agentSessionId === agentSessionId) for (const item of historyPage.items) {
    const source: AgentConversationRecordSource = { kind: 'native', ...historyPage.source, recordId: item.id }
    const id = JSON.stringify([executionHostId ?? null, agentSessionId, 'native', source.providerId, source.nativeSessionId, item.id])
    if (seen.has(id)) continue
    seen.add(id)
    const input = item.kind === 'user-message' ? nativeInputs.get(item.id) : undefined
    const author = input?.author ?? (item.kind === 'assistant-message' ? { kind: 'agent' as const, agentSessionId }
      : item.kind === 'system-message' ? { kind: 'system' as const, providerId: historyPage.source.providerId } : undefined)
    records.push({ id, rawId: item.id, agentSessionId, ...(executionHostId ? { executionHostId } : {}), kind: item.kind, source,
      content: input?.content ?? item.contentParts.filter(part => part.kind === 'text').map(part => part.text).join('\n'),
      contentParts: item.contentParts,
      ...recordedTime(item.startedAt),
      ...(author ? { author } : {}), ...(input ? { input } : {}), original: { kind: 'native', item } })
  }
  if (timeline?.agentSessionId === agentSessionId) for (const item of timeline.items) {
    if (item.agentSessionId !== agentSessionId || item.kind !== 'user_message' && item.kind !== 'assistant_message') continue
    const id = JSON.stringify([executionHostId ?? null, agentSessionId, 'captured', item.id])
    if (seen.has(id)) continue
    seen.add(id)
    const input = item.kind === 'user_message' ? capturedInputs.get(item.id) : undefined
    records.push({ id, rawId: item.id, agentSessionId, ...(executionHostId ? { executionHostId } : {}), kind: item.kind === 'user_message' ? 'user-message' : 'assistant-message',
      source: { kind: 'captured', recordId: item.id }, content: item.content ?? '',
      contentParts: input?.contentParts ?? [{ kind: 'text', text: item.content ?? '' }], ...recordedTime(item.createdAt),
      author: input?.author ?? { kind: 'agent', agentSessionId },
      ...(input ? { input } : {}), original: { kind: 'captured', item } })
  }
  return records
}

/** A reference to the original Session, never a new conversation lifecycle. */
export type ConversationRef = import('./session-history-read-codec.js').AgentSessionContextReference

/** Retain the original bounded envelope rather than duplicating scope or body bytes. */
export type AgentConversationReadPage = import('./session-history-read-codec.js').AgentSessionHistoryReadPage
export { parseAgentSessionHistoryReadPage as parseConversationReadPage } from './session-history-read-codec.js'

export * from './conversation-changes.js'
export * from './conversation-questions.js'
