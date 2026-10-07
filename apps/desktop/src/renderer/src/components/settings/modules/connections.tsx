import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ExternalConnectionsSettings } from '../ExternalConnectionsSettings'
import type { SettingsModule } from '../settings-catalog'
export const connectionsSettingsModule = {
  id: 'chat-connections', group: 'toolkit', title: 'Agent Conversation Connector',
  description: 'Connect Agent conversations to external chats. Feishu and Lark are included.',
  icon: semanticIconComponent('object.conversations'), keywords: 'mods agent conversation feishu lark chat connector application bot scan qr Agent 对话 飞书 群聊 连接器 扫码 机器人',
  savedSummary: () => 'Bot applications and connection setup',
  Pane({ active }) { return <ExternalConnectionsSettings active={active} /> }
} as const satisfies SettingsModule
