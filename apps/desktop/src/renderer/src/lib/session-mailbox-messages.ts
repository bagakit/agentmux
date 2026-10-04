import type { AgentSessionUserMessage, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
export type MailboxDisplayItem = AgentTimelineItem | AgentSessionUserMessage
export function isMailboxUserMessage(item: MailboxDisplayItem): item is AgentSessionUserMessage {
  return typeof item.source === 'object' && item.source !== null
}
export function mailboxMessageKey(item: MailboxDisplayItem): string {
  return isMailboxUserMessage(item) ? item.source.kind === 'captured' ? `timeline:${item.source.submissionId}` : `native:${item.id}` : `timeline:${item.id}`
}
/** Read existing identities, never deduplicate equal bodies or invent a delivery receipt. */
export function mailboxMessages(sessionId: string | undefined, timeline: AgentTimelineSnapshot | undefined, source: readonly AgentSessionUserMessage[]): MailboxDisplayItem[] {
  if (!sessionId) return []
  const result: MailboxDisplayItem[] = [], seen = new Set<string>()
  if (timeline?.agentSessionId === sessionId) for (const item of timeline.items) {
    if (item.agentSessionId !== sessionId || item.kind !== 'user_message') continue
    const identity = JSON.stringify(['captured',item.id])
    if (seen.has(identity)) continue
    seen.add(identity); result.push(item)
  }
  for (const item of source) {
    if (item.agentSessionId !== sessionId) continue
    const identity = item.source.kind === 'captured' ? JSON.stringify(['captured',item.source.submissionId])
      : JSON.stringify(['native',item.source.providerId,item.source.nativeSessionId,item.source.recordId])
    if (seen.has(identity)) continue
    seen.add(identity); result.push(item)
  }
  return result
}
export function mailboxMessageIsIncoming(item: MailboxDisplayItem): boolean {
  return isMailboxUserMessage(item) ? item.author.kind === 'agent' : item.authorAgentSessionId !== undefined
}
