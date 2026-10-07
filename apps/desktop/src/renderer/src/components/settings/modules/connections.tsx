import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ExternalConnectionsSettings } from '../ExternalConnectionsSettings'
import type { SettingsModule } from '../settings-catalog'
export const connectionsSettingsModule = {
  id: 'chat-connections', group: 'connections', title: 'Feishu & Lark',
  description: 'Connect a bot application, then choose a group for each Agent.',
  icon: semanticIconComponent('object.conversations'), keywords: 'feishu lark chat connector application 飞书 群聊 连接器',
  savedSummary: () => 'Bot applications and connection setup',
  Pane({ active }) { return <ExternalConnectionsSettings active={active} /> }
} as const satisfies SettingsModule
