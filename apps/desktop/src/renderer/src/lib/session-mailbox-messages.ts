import type { AgentSessionUserMessage, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { conversationItemRef, type ConversationItemRef, type SessionInputGroup } from '@agentmux/core/conversation'
import { createCapturedInputSelector } from './session-captured-inputs'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'

export type MailboxDisplayItem = {
  message: AgentSessionUserMessage
  /** Retain original attribution and lineage; projection does not rewrite the recorded object. */
  original: AgentTimelineItem | AgentSessionUserMessage
  reference: ConversationItemRef | null
  group?: SessionInputGroup
}
export function isMailboxUserMessage(item: MailboxDisplayItem['original']): item is AgentSessionUserMessage {
  return typeof item.source === 'object' && item.source !== null
}
/** Preserve existing row and read-marker identities while sharing exact record references. */
export function mailboxMessageKey({ message }: Pick<MailboxDisplayItem, 'message'>): string {
  return message.source.kind === 'captured' ? `timeline:${message.source.submissionId}` : `native:${message.id}`
}
/** Core has already established group membership; this only adapts original reading targets. */
export function mailboxInputMessages(groups: readonly SessionInputGroup[], sourceHostId?: string): MailboxDisplayItem[] {
  return groups.flatMap(group => {
    const message = group.primary
    if (!message || group.mailbox.length) return []
    const source = message.source.kind === 'captured'
      ? { kind: 'captured' as const, recordId: message.source.submissionId } : message.source
    return [{ message, original: message, group, reference: message.sourceRecord?.record ?? conversationItemRef({
      agentSessionId: message.agentSessionId, ...(sourceHostId ? { sourceHostId } : {}), source }) }]
  })
}
/** Read existing identities and original Core input facts, never merge bodies or infer delivery. */
export function createMailboxMessagesSelector() {
  const selectCaptured = createCapturedInputSelector()
  let previous: { sessionId: string | undefined; captured: readonly AgentSessionUserMessage[]
    source: readonly AgentSessionUserMessage[]; executionHostId: string | undefined; result: MailboxDisplayItem[] } | undefined
  return (sessionId: string | undefined, timeline: AgentTimelineSnapshot | undefined,
    source: readonly AgentSessionUserMessage[], executionHostId?: string): MailboxDisplayItem[] => {
    const captured = selectCaptured(sessionId, timeline?.agentSessionId === sessionId ? timeline : undefined, executionHostId)
    if (previous && previous.sessionId === sessionId && previous.captured === captured &&
      previous.source === source && previous.executionHostId === executionHostId) return previous.result
    const result: MailboxDisplayItem[] = [], seen = new Set<string>()
    const collect = (message: AgentSessionUserMessage, original: MailboxDisplayItem['original']) => {
      if (!sessionId || message.agentSessionId !== sessionId) return
      const identity = conversationMessageSourceKey(sessionId, message.source)
      if (identity && seen.has(identity)) return
      if (identity) seen.add(identity)
      const recordSource = message.source.kind === 'captured'
        ? { kind: 'captured' as const, recordId: message.source.submissionId } : message.source
      result.push({ message, original, reference: message.sourceRecord?.record ?? (identity ? conversationItemRef({ agentSessionId: sessionId,
        sourceHostId: timeline?.sourceHostId ?? null, source: recordSource }) : null) })
    }
    if (sessionId && timeline?.agentSessionId === sessionId) {
      const originals = new Map<string, AgentTimelineItem>()
      for (const item of timeline.items) if (item.agentSessionId === sessionId && item.kind === 'user_message' && !originals.has(item.id)) originals.set(item.id, item)
      for (const message of captured) collect(message, originals.get(message.rawId)!)
    }
    for (const message of source) collect(message, message)
    previous = { sessionId, captured, source, executionHostId, result }
    return result
  }
}
