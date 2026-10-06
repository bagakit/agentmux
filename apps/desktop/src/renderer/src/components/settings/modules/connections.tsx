import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ExternalConnectionsSettings } from '../ExternalConnectionsSettings'
import type { SettingsModule } from '../settings-catalog'
export const connectionsSettingsModule = {
  id: 'chat-connections', group: 'connections', title: 'Chat applications',
  description: 'Connect Feishu or Lark applications on this environment.',
  icon: semanticIconComponent('object.host'), keywords: 'feishu lark chat connector application 飞书 群聊 连接器',
  savedSummary: () => 'Application connections and delivery status',
  Pane({ active }) { return <ExternalConnectionsSettings active={active} /> }
} as const satisfies SettingsModule
