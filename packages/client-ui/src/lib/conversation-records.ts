import type { AgentSessionHistoryContentPart, AgentSessionHistoryItem, AgentSessionHistoryPage, AgentSessionHistorySource, AgentSessionUserMessage, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { speakerOfUserMessage, type ConversationSpeaker } from './conversation-speaker.js'
import { describeConversationInputSource } from './conversation-input-source.js'

export type ConversationRecordSource =
  | (AgentSessionHistorySource & { kind: 'native'; recordId: string })
  | { kind: 'captured'; recordId: string }

/** A view of already read facts. The original record owns its body and metadata. */
export type ConversationRecord = {
  id: string
  rawId: string
  agentSessionId: string
  executionHostId?: string
  kind: AgentSessionHistoryItem['kind']
  source: ConversationRecordSource
  content: string
  contentParts: readonly AgentSessionHistoryContentPart[]
  recordedAt?: number
  speaker?: ConversationSpeaker
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
}): ConversationRecord[] {
  const inputs = projectSessionUserMessages({ agentSessionId, historyPage, timeline })
  const nativeInputs = new Map(inputs.filter(input => input.source.kind === 'native').map(input => [input.rawId, input]))
  const capturedInputs = new Map(inputs.filter(input => input.source.kind === 'captured').map(input => [input.rawId, input]))
  const records: ConversationRecord[] = [], seen = new Set<string>()
  if (historyPage?.agentSessionId === agentSessionId) for (const item of historyPage.items) {
    const source: ConversationRecordSource = { kind: 'native', ...historyPage.source, recordId: item.id }
    const id = JSON.stringify([executionHostId ?? null, agentSessionId, 'native', source.providerId, source.nativeSessionId, item.id])
    if (seen.has(id)) continue
    seen.add(id)
    const input = item.kind === 'user-message' ? nativeInputs.get(item.id) : undefined
    const speaker = input ? speakerOfUserMessage(input) : item.kind === 'assistant-message' ? { role: 'agent' as const, id: agentSessionId }
      : item.kind === 'system-message' ? { role: 'system' as const, id: historyPage.source.providerId } : undefined
    records.push({ id, rawId: item.id, agentSessionId, ...(executionHostId ? { executionHostId } : {}), kind: item.kind, source,
      content: input?.content ?? item.contentParts.filter(part => part.kind === 'text').map(part => part.text).join('\n'),
      contentParts: item.contentParts,
      ...recordedTime(item.startedAt),
      ...(speaker ? { speaker } : {}), ...(input ? { input } : {}), original: { kind: 'native', item } })
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
      speaker: input ? speakerOfUserMessage(input) : { role: 'agent', id: agentSessionId },
      ...(input ? { input } : {}), original: { kind: 'captured', item } })
  }
  return records
}

export function describeConversationRecordSource(record: ConversationRecord): { caption: string; title: string } {
  const inputOrigin = record.input ? describeConversationInputSource(record.input.source) : undefined
  if (record.source.kind === 'native') {
    const origin = inputOrigin ?? describeConversationInputSource(record.source)
    return { caption: origin.caption,
      title: `Native record ${record.source.recordId}\nProvider: ${record.source.providerId}\nNative session: ${record.source.nativeSessionId}\n${origin.title}` }
  }
  const item = record.original.kind === 'captured' ? record.original.item : undefined
  const recordTitle = `Captured record ${record.rawId}\nSession: ${record.agentSessionId}${item ? `\nSource: ${item.source}${item.sourceChannel ? `\nChannel: ${item.sourceChannel}` : ''}` : ''}`
  return inputOrigin ? { caption: inputOrigin.caption, title: `${recordTitle}\n${inputOrigin.title}` }
    : { caption: 'Captured record', title: recordTitle }
}
