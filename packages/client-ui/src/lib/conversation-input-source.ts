import type { AgentMessageChannel, AgentSessionUserMessageSource } from '@agentmux/core'

const channelLabels: Readonly<Record<AgentMessageChannel, string>> = {
  terminal: 'Terminal',
  'message-tool': 'Message Tool',
  'question-reply': 'Question reply',
  cli: 'CLI',
  api: 'API',
  'agent-message': 'Agent message',
  reaction: '快捷回复'
}

/** Display only the input origin recorded by Core; a receiving Host is not its sender. */
export function describeConversationInputSource(source: AgentSessionUserMessageSource) {
  const channel = source.kind === 'captured' ? source.channel : undefined
  const device = source.kind === 'captured' ? source.device : undefined
  const channelLabel = channel === undefined ? '渠道未记录' : channelLabels[channel]
  const caption = source.kind === 'native' ? '原生记录 · 来源未记录'
    : `${channelLabel} · ${device?.name ?? '设备未记录'}`
  const title = source.kind === 'native'
    ? `Provider 原生记录 · ${source.providerId}\n输入渠道与发送设备未记录`
    : `${channelLabel}\n发送设备：${device?.name ?? '未记录'}\n设备 ID：${device?.deviceId ?? '未记录'}\n来源 Host：${device?.hostId ?? '未记录'}`
  return { caption, title, channelLabel, device }
}
