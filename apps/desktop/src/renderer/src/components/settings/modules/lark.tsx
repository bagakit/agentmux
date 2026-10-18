import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ExternalConnectionsSettings } from '../ExternalConnectionsSettings'
import { ConnectorServiceControl } from '../ConnectorServiceControl'
import type { SettingsModule } from '../settings-catalog'
import '../../../styles/settings-lark.css'
const feishuArtwork = new URL('../../../assets/connector-icons/feishu.ico', import.meta.url).href
function ChannelIcon({ size = 14 }: { size?: number | undefined }) { return <img src={feishuArtwork} width={size} height={size} alt="" /> }
export const larkSettingsModule = {
  id: 'lark', group: 'conversation-channels', title: 'Lark',
  description: 'Chat with your Agents from Feishu or Lark.',
  channel: { adapterId: 'feishu', domains: [{ domain: 'open.feishu.cn', title: 'Feishu' }, { domain: 'open.larksuite.com', title: 'Lark' }], icon: ChannelIcon },
  icon: semanticIconComponent('object.conversations'), keywords: 'channel agent conversation feishu lark chat connector application bot scan qr Agent 对话 飞书 群聊 连接器 扫码 机器人',
  savedSummary: () => 'Service control, bot applications and connection setup',
  Pane({ active, onClose, navigationRequest }) { return <div className="settings-pane-stack lark-settings"><ConnectorServiceControl active={active} /><ExternalConnectionsSettings active={active} onClose={onClose} navigationRequest={navigationRequest} /></div> }
} as const satisfies SettingsModule
