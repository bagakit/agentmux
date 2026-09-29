/**
 * 对话体里唯一的说话人判定与身份映射。
 *
 * 说话人身份由 `(role, id)` 共同表达：
 * - `id` 是稳定身份标识，用于寻址、资料解析与头像色相派生。
 * - `role` 决定类别与表示形状（'human'、'agent'、'unknown'）。
 *
 * 全来源原生用户输入与未记录作者如实表达为 `role: 'unknown'`，已知 Agent 作者使用其真实 agentSessionId，
 * 绝不再从 `source=user` 或原生角色盲目猜测 Human。
 */

import type { AgentProviderId, AgentSessionUserMessage } from '@agentmux/core'
import type { AgentTimelineItem } from '../../../shared/contracts'

/**
 * 说话人的类别。**不是身份**——身份是 {@link ConversationSpeaker.id}。
 *
 * `'agent'` 为已知 Agent，`'unknown'` 为未记录或原生用户输入，`'human'` 仅在确知人类身份时保留。
 * 绝不再从 `source=user` 或原生角色盲目猜测 Human。
 */
export type SpeakerRole = 'human' | 'agent' | 'unknown' | 'system'

/**
 * 对话体里的一个说话人。
 *
 * `id` 是身份，用于寻址与取头像；`role` 只用于选表示形状。二者分开是「显示名与身份严格分离」
 * 的同一条约束：不要用 role 当身份（那样所有 Agent 会挤成一个），也不要用 id 选形状（那样每
 * 新增一个身份都得改渲染分支）。
 */
export type ConversationSpeaker = {
  role: SpeakerRole
  /** 这个说话人的稳定标识。agent 为其 agentSessionId，unknown 为 UNKNOWN_SPEAKER_ID。 */
  id: string
}

/**
 * 代表「这台机器前面的人」的身份。
 */
export const HUMAN_SPEAKER_ID = 'human'

/**
 * 未知输入作者的哨兵标识。
 */
export const UNKNOWN_SPEAKER_ID = 'unknown'

/** The producing system, separate from session identities. */
export const AGENTMUX_SYSTEM_SPEAKER_ID = 'agentmux'

/** User-requested display default; recorded authorship remains unchanged. */
export function speakerForDisplay(speaker: ConversationSpeaker): ConversationSpeaker {
  return speaker.role === 'unknown' ? { role: 'human', id: HUMAN_SPEAKER_ID } : speaker
}

/**
 * 把一个身份解析成「叫什么、画哪个 provider」。
 */
export type DescribeSpeaker = (speaker: ConversationSpeaker) => {
  name: string
  providerId?: AgentProviderId
}

/**
 * 共同 speaker resolver：按真实 speaker.id 解析 Agent 资料，缺失时保留原 id 与未知说明，
 * 不用收件人当前资料代填发件人。
 */
export function createSpeakerResolver(options?: {
  lookupAgent?: (agentSessionId: string) => { label?: string; providerId?: AgentProviderId } | undefined
  currentSession?: { id: string; label?: string; providerId?: AgentProviderId } | undefined
}): DescribeSpeaker {
  return (recordedSpeaker: ConversationSpeaker) => {
    const speaker = speakerForDisplay(recordedSpeaker)
    if (speaker.role === 'human') return { name: 'You' }
    if (speaker.role === 'system') return { name: 'AgentMux' }
    if (options?.lookupAgent) {
      const found = options.lookupAgent(speaker.id)
      if (found) {
        return {
          name: found.label ?? speaker.id,
          ...(found.providerId ? { providerId: found.providerId } : {})
        }
      }
    }
    if (options?.currentSession && options.currentSession.id === speaker.id) {
      return {
        name: options.currentSession.label ?? speaker.id,
        ...(options.currentSession.providerId ? { providerId: options.currentSession.providerId } : {})
      }
    }
    return { name: speaker.id }
  }
}

/**
 * 从 AgentSessionUserMessage 得到规范说话人。
 */
export function speakerOfUserMessage(message: AgentSessionUserMessage): ConversationSpeaker {
  if (message.author.kind === 'human') {
    return { role: 'human', id: HUMAN_SPEAKER_ID }
  }
  if (message.author.kind === 'agent') {
    return { role: 'agent', id: message.author.agentSessionId }
  }
  return { role: 'unknown', id: UNKNOWN_SPEAKER_ID }
}

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
