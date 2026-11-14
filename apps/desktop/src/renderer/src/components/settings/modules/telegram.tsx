import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ConnectionHostingSettings } from '../ConnectionHostingSettings'
import { manualConnectionPlatforms } from '../../../lib/manual-connection-platforms'
import type { SettingsModule } from '../settings-catalog'
const platform = manualConnectionPlatforms.telegram
const ChannelIcon = semanticIconComponent('object.settings-channels')
export const telegramSettingsModule = {
  id: 'telegram', archetype: 'console', group: 'conversation-channels', title: platform.title,
  description: 'Share conversations with your Agents through a Telegram bot.',
  channel: { adapterId: platform.adapterId, domains: [{ domain: platform.domain, title: platform.title }], icon: ChannelIcon },
  icon: ChannelIcon, keywords: 'telegram channel bot token chat group topic 电报 频道 群 机器人',
  savedSummary: () => 'Bot credentials, connection checks and conversation setup',
  Pane({ active, onClose, navigationRequest }) { return <ConnectionHostingSettings platform={platform} active={active} channel="telegram" onClose={onClose} navigationRequest={navigationRequest} /> }
} as const satisfies SettingsModule
