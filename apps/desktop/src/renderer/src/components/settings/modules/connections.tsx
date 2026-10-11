import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ExternalConnectionsSettings } from '../ExternalConnectionsSettings'
import { ConnectorServiceControl } from '../ConnectorServiceControl'
import type { SettingsModule } from '../settings-catalog'
export const connectionsSettingsModule = {
  id: 'chat-connections', group: 'toolkit', title: 'Agent Conversation Connector',
  description: 'Chat with your Agents from Feishu or Lark.',
  icon: semanticIconComponent('object.conversations'), keywords: 'mods agent conversation feishu lark chat connector application bot scan qr Agent 对话 飞书 群聊 连接器 扫码 机器人',
  savedSummary: () => 'Service control, bot applications and connection setup',
  Pane({ active, onClose, navigationRequest }) { return <div className="settings-pane-stack connector-mod"><ExternalConnectionsSettings active={active} onClose={onClose} navigationRequest={navigationRequest} /><ConnectorServiceControl active={active} /></div> }
} as const satisfies SettingsModule
