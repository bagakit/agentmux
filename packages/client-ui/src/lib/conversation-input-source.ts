import { NATIVE_CONVERSATION_SOURCE } from './conversation-sources.js'
import type { AgentMessageChannel, AgentPromptInputKey, AgentSessionUserMessageSource } from '@agentmux/core'

/** Submission userContent with a message key retains rendered wire. Captured
 * external journal records instead store envelope.body, just like prompt bodies.
 * These are producer facts, never inferred from tags or a displayed author. */
export function conversationInputTextBoundary(key: AgentPromptInputKey | undefined, hasPublicBody: boolean,
  capturedExternalBody = false,
  fallback: 'wire' | 'body' = 'wire'): 'wire' | 'body' {
  return hasPublicBody ? key?.kind === 'message' && !capturedExternalBody ? 'wire' : 'body' : fallback
}

const channelLabels: Readonly<Record<AgentMessageChannel, string>> = {
  terminal: '终端',
  'message-tool': '消息工具',
  'question-reply': '问题回复',
  cli: 'CLI',
  api: 'API',
  'agent-message': 'Agent 消息',
  reaction: '快捷回复'
}

/** Display only the input origin recorded by Core; a receiving Host is not its sender. */
export function describeConversationInputSource(source: AgentSessionUserMessageSource) {
  const channel = source.kind === 'captured' ? source.channel : undefined
  const device = source.kind === 'captured' ? source.device : undefined
  const channelLabel = channel === undefined ? '渠道未记录' : channelLabels[channel]
  const caption = source.kind === 'native' ? `${NATIVE_CONVERSATION_SOURCE} · 入口未记录`
    : `${channelLabel} · ${device?.name ?? '设备未记录'}`
  const title = source.kind === 'native'
    ? `Provider 原生记录 · ${source.providerId}\n输入渠道与发送设备未记录`
    : `${channelLabel}\n发送设备：${device?.name ?? '未记录'}\n设备 ID：${device?.deviceId ?? '未记录'}\n来源 Host：${device?.hostId ?? '未记录'}`
  return { caption, title, channelLabel, device }
}
