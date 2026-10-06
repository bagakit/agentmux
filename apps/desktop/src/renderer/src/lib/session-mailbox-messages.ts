import type { AgentSessionUserMessage, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { conversationItemRef, type ConversationItemRef } from '@agentmux/core/conversation'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'

export type MailboxDisplayItem = {
  message: AgentSessionUserMessage
  /** Retain original attribution and lineage; projection does not rewrite the recorded object. */
  original: AgentTimelineItem | AgentSessionUserMessage
  reference: ConversationItemRef | null
}
export function isMailboxUserMessage(item: MailboxDisplayItem['original']): item is AgentSessionUserMessage {
  return typeof item.source === 'object' && item.source !== null
}
/** Preserve existing row and read-marker identities while sharing exact record references. */
export function mailboxMessageKey({ message }: Pick<MailboxDisplayItem, 'message'>): string {
  return message.source.kind === 'captured' ? `timeline:${message.source.submissionId}` : `native:${message.id}`
}
/** Read existing identities and original Core input facts, never merge bodies or infer delivery. */
export function mailboxMessages(sessionId: string | undefined, timeline: AgentTimelineSnapshot | undefined,
  source: readonly AgentSessionUserMessage[], executionHostId?: string): MailboxDisplayItem[] {
  if (!sessionId) return []
  const result: MailboxDisplayItem[] = [], seen = new Set<string>()
  const collect = (message: AgentSessionUserMessage, original: MailboxDisplayItem['original']) => {
    if (message.agentSessionId !== sessionId) return
    const identity = conversationMessageSourceKey(sessionId, message.source)
    if (identity && seen.has(identity)) return
    if (identity) seen.add(identity)
    const recordSource = message.source.kind === 'captured'
      ? { kind: 'captured' as const, recordId: message.source.submissionId } : message.source
    result.push({ message, original, reference: identity ? conversationItemRef({ agentSessionId: sessionId,
      ...(executionHostId === undefined ? {} : { executionHostId }),
      source: recordSource }) : null })
  }
  if (timeline?.agentSessionId === sessionId) {
    const captured = projectSessionUserMessages({ agentSessionId: sessionId, timeline })
    const originals = new Map<string, AgentTimelineItem>()
    for (const item of timeline.items) if (item.agentSessionId === sessionId && item.kind === 'user_message' && !originals.has(item.id)) originals.set(item.id, item)
    for (const message of captured) collect(message, originals.get(message.rawId)!)
  }
  for (const message of source) collect(message, message)
  return result
}
export function mailboxMessageIsIncoming({ message }: MailboxDisplayItem): boolean {
  return message.author.kind === 'agent'
}
