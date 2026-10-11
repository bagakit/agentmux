import type { AgentSessionUserMessage } from '@agentmux/core'
import type { AgentTimelineItem } from '../../../shared/contracts'
import { projectConversationRecords } from '@agentmux/core/conversation'
import { speakerOfUserMessage, type ConversationSpeaker } from '@agentmux/client-ui/conversation-speaker'

/** Legacy input callers retain their Core author; captured facts use the same Core timeline. */
export function speakerOf(item: AgentTimelineItem | AgentSessionUserMessage): ConversationSpeaker | null {
  if ('author' in item) return speakerOfUserMessage(item)
  const record = projectConversationRecords({ agentSessionId: item.agentSessionId,
    timeline: { agentSessionId: item.agentSessionId, revision: 0, items: [item] } })[0]
  return record && record.role !== 'process' && record.role !== 'interaction' && record.author
    ? record.author.kind === 'system' ? { role: 'system', id: record.author.providerId ?? 'agentmux' } : speakerOfUserMessage({ author: record.author }) : null
}
export function isConversationTurn(item: AgentTimelineItem | AgentSessionUserMessage): boolean {
  return speakerOf(item) !== null
}
