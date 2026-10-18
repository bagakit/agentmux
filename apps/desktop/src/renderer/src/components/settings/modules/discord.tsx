import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ExternalConnectionsSettings } from '../ExternalConnectionsSettings'
import { ConnectorServiceControl } from '../ConnectorServiceControl'
import type { SettingsModule } from '../settings-catalog'
import '../../../styles/settings-lark.css'
import '../../../styles/settings-discord.css'

export const discordSettingsModule = {
  id: 'discord', group: 'conversation-channels', title: 'Discord',
  description: 'Chat with your Agents in Discord channels.',
  icon: semanticIconComponent('object.conversations'), keywords: 'channel agent conversation discord chat connector application bot token gateway intents 对话 频道 机器人',
  savedSummary: () => 'Bot credentials, connection checks and channel setup',
  Pane({ active, onClose, navigationRequest }) { return <div className="settings-pane-stack lark-settings discord-settings"><ConnectorServiceControl active={active} /><ExternalConnectionsSettings active={active} channel="discord" onClose={onClose} navigationRequest={navigationRequest} /></div> }
} as const satisfies SettingsModule
