import { ConnectionHostingSettings } from '../ConnectionHostingSettings'
import type { SettingsModule } from '../settings-catalog'
import '../../../styles/settings-lark.css'
const feishuArtwork = new URL('../../../assets/connector-icons/feishu.ico', import.meta.url).href
function ChannelIcon({ size = 14 }: { size?: number | undefined }) { return <img src={feishuArtwork} width={size} height={size} alt="" /> }
const platform = { adapterId: 'feishu', title: 'Lark' } as const
export const larkSettingsModule = {
  id: 'lark', group: 'conversation-channels', title: 'Lark',
  description: 'Chat with your Agents from Feishu or Lark.',
  channel: { adapterId: platform.adapterId, domains: [{ domain: 'open.feishu.cn', title: 'Feishu' }, { domain: 'open.larksuite.com', title: 'Lark' }], icon: ChannelIcon },
  icon: ChannelIcon, keywords: 'channel agent conversation feishu lark chat connector application bot scan qr Agent 对话 飞书 群聊 连接器 扫码 机器人',
  savedSummary: () => 'Service control, bot applications and connection setup',
  Pane({ active, onClose, navigationRequest }) { return <div className="settings-pane-stack lark-settings"><ConnectionHostingSettings platform={platform} active={active} onClose={onClose} navigationRequest={navigationRequest} /></div> }
} as const satisfies SettingsModule
