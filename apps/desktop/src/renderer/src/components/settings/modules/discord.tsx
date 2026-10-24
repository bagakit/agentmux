import { ConnectionHostingSettings } from '../ConnectionHostingSettings'
import type { SettingsModule } from '../settings-catalog'
import '../../../styles/settings-lark.css'
import '../../../styles/settings-discord.css'

// Official unmodified platform artwork: https://discord.com/branding (blurple Symbol).
const artwork = new URL('../../../assets/connector-icons/discord.svg', import.meta.url).href
function ChannelIcon({ size = 14 }: { size?: number | undefined }) { return <img src={artwork} width={size} height={size} alt="" /> }

const platform = { adapterId: 'discord', title: 'Discord' } as const
export const discordSettingsModule = {
  id: 'discord', group: 'conversation-channels', title: 'Discord',
  description: 'Chat with your Agents in Discord channels.',
  channel: { adapterId: platform.adapterId, domains: [{ domain: 'discord.com', title: 'Discord' }], icon: ChannelIcon },
  icon: ChannelIcon, keywords: 'channel agent conversation discord chat connector application bot token gateway intents 对话 频道 机器人',
  savedSummary: () => 'Bot credentials, connection checks and channel setup',
  Pane({ active, onClose, navigationRequest }) { return <div className="settings-pane-stack lark-settings discord-settings"><ConnectionHostingSettings platform={platform} active={active} channel="discord" onClose={onClose} navigationRequest={navigationRequest} /></div> }
} as const satisfies SettingsModule
