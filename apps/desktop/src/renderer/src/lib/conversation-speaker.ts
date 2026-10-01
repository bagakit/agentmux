import type { AgentSessionUserMessage } from '@agentmux/core'
import type { AgentTimelineItem } from '../../../shared/contracts'
import { speakerOfUserMessage, AGENTMUX_SYSTEM_SPEAKER_ID, HUMAN_SPEAKER_ID, UNKNOWN_SPEAKER_ID, type ConversationSpeaker } from '@agentmux/client-ui/conversation-speaker'

/**
 * 这一条条目或消息的说话人；不是一句话（机器上报）时返回 null。
 */
export function speakerOf(
  itemOrMessage: AgentTimelineItem | AgentSessionUserMessage
): ConversationSpeaker | null {
  if ('author' in itemOrMessage && typeof itemOrMessage.author === 'object') {
    return speakerOfUserMessage(itemOrMessage)
  }
  const item = itemOrMessage as AgentTimelineItem
  if (item.kind === 'system_message' && item.source === 'agentmux') {
    return { role: 'system', id: AGENTMUX_SYSTEM_SPEAKER_ID }
  }
  if (item.authorAgentSessionId) {
    return { role: 'agent', id: item.authorAgentSessionId }
  }
  if (item.authorAgentSessionId === undefined && item.authorHuman === true) {
    return { role: 'human', id: HUMAN_SPEAKER_ID }
  }
  if (item.source === 'user' || item.kind === 'user_message') {
    return { role: 'unknown', id: UNKNOWN_SPEAKER_ID }
  }
  if (item.kind === 'assistant_message') {
    return { role: 'agent', id: item.agentSessionId }
  }
  return null
}

/**
 * 这一条是否属于对话体（turn register）而不是机器上报行。
 */
export function isConversationTurn(
  itemOrMessage: AgentTimelineItem | AgentSessionUserMessage
): boolean {
  return speakerOf(itemOrMessage) !== null
}
