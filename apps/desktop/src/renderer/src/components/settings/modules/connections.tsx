import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ExternalConnectionsSettings } from '../ExternalConnectionsSettings'
import type { SettingsModule } from '../settings-catalog'
export const connectionsSettingsModule = {
  id: 'chat-connections', group: 'connections', title: 'Feishu & Lark',
  description: 'Create a bot with a scan, or connect an existing application.',
  icon: semanticIconComponent('object.conversations'), keywords: 'feishu lark chat connector application bot scan qr 飞书 群聊 连接器 扫码 机器人',
  savedSummary: () => 'Bot applications and connection setup',
  Pane({ active }) { return <ExternalConnectionsSettings active={active} /> }
} as const satisfies SettingsModule
