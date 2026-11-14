import { CHANNEL_PRESENTATIONS } from '../../../shared/channel-presentation'
/** Renderer copy and setup guidance only. The Host adapter verifies protocol support and identity. */
export const manualConnectionPlatforms = {
  discord: {
    ...CHANNEL_PRESENTATIONS.discord, domain: 'discord.com', consoleUrl: 'https://discord.com/developers/applications', consoleLabel: 'Developer Portal',
    appIdLabel: 'Application ID', appIdPlaceholder: 'Application ID from General Information', credentialLabel: 'Bot token',
    credentialHint: 'Find your Application ID in General Information and Bot token on the Bot page.',
    createHint: 'Create an application and add its bot in the Developer Portal, then return here.',
    setupTitle: 'Connect Discord channels',
    steps: ['On the Bot page, enable Message Content Intent for ordinary channel text.', 'Install the bot in your server with View Channels, Send Messages and Read Message History. Attach Files is needed for files; threads also need Send Messages in Threads.', 'In an Agent’s menu, choose the exact channel to share. Member input grants are managed separately.'],
    limits: 'Saving credentials does not confirm Gateway connection, channel access or message delivery. Check this connection and the selected channel separately.'
  },
  telegram: {
    ...CHANNEL_PRESENTATIONS.telegram, domain: 'telegram.org', consoleUrl: 'https://t.me/BotFather', consoleLabel: 'BotFather',
    appIdLabel: 'Bot user ID', appIdPlaceholder: 'Numeric bot ID returned by getMe', credentialLabel: 'Bot token',
    credentialHint: 'Create a bot with BotFather. Enter its numeric user ID and bot token; the connection check verifies they belong to the same bot.',
    createHint: 'Use the Bot API getMe result to read the bot’s numeric id. Keep the complete token private.',
    setupTitle: 'Connect Telegram conversations',
    steps: ['Add the bot to your group, or start a direct chat with it.', 'To share ordinary group conversation, disable Group Privacy in BotFather or grant the bot administrator access. The bot can receive only messages Telegram makes available to it.', 'Choose the exact chat ID in an Agent’s menu. For a forum topic, use chat ID:topic ID. Member input grants remain separate.'],
    limits: 'Text input and replies are supported. Files and native answer buttons are not supported yet. Long polling requires this bot’s existing webhook to be removed by its owner; AgentMux does not remove it. Telegram retains pending updates for at most 24 hours. A lost send receipt remains unknown and is not automatically sent again.'
  }
} as const
export type ManualConnectionPlatform = typeof manualConnectionPlatforms[keyof typeof manualConnectionPlatforms]
export function manualConnectionPlatform(channel: string): ManualConnectionPlatform | undefined {
  return Object.hasOwn(manualConnectionPlatforms, channel) ? manualConnectionPlatforms[channel as keyof typeof manualConnectionPlatforms] : undefined
}
