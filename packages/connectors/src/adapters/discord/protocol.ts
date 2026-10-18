import { AgentMuxError } from '@agentmux/core'
import type { ConnectionConfig } from '@agentmux/core/connections'
import type { GatewayDispatchPayload, APIMessage, APIUser } from 'discord-api-types/v10'
import type { VerifiedIngressEvent } from '../../durable-ingress.js'

export const DISCORD_ADAPTER_ID = 'discord'
export const DISCORD_DOMAIN = 'discord.com'
export function discordFailure(code = 'DISCORD_SOURCE_UNCONFIRMED'): never {
  throw new AgentMuxError('This original Discord operation is unconfirmed. Existing Agents and their input remain available.', code)
}
export function discordId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{1,20}$/u.test(value)) return discordFailure('DISCORD_IDENTITY_INVALID')
  return value
}
export function discordConfig(config: ConnectionConfig): void {
  if (config.adapterId !== DISCORD_ADAPTER_ID || config.application.domain !== DISCORD_DOMAIN) discordFailure('DISCORD_APPLICATION_MISMATCH')
  discordId(config.application.appId)
}
export function discordAvatar(user: Pick<APIUser, 'id' | 'avatar'>): string | undefined {
  return typeof user.avatar === 'string' && /^[a-zA-Z0-9_]+$/u.test(user.avatar)
    ? `https://cdn.discordapp.com/avatars/${discordId(user.id)}/${user.avatar}.png?size=128` : undefined
}
/** Interpret only the original authenticated Gateway payload. Text never supplies addressing or identity. */
export function discordMessage(payload: GatewayDispatchPayload, config: ConnectionConfig, botId: string): VerifiedIngressEvent {
  if (payload.t !== 'MESSAGE_CREATE' || !Number.isSafeInteger(payload.s)) return discordFailure('DISCORD_EVENT_UNSUPPORTED')
  const message = payload.d as APIMessage
  const author = message.author
  if (!author || author.bot || message.webhook_id || author.id === botId) discordFailure('DISCORD_EVENT_OUTSIDE_SCOPE')
  if (typeof message.content !== 'string' || !Array.isArray(message.mentions) || !Array.isArray(message.attachments)) discordFailure('DISCORD_CONTENT_UNCONFIRMED')
  const mentioned = message.mentions.some(user => user.id === botId)
  // Unsupported native content is retained as the complete raw event by DurableIngress.
  const unsupported = message.attachments.length > 0 || (message.embeds?.length ?? 0) > 0 || (message.sticker_items?.length ?? 0) > 0
  return { eventId: 'message:' + discordId(message.id), messageId: message.id, externalConversationId: discordId(message.channel_id),
    actor: { application: { ...config.application }, idType: 'snowflake', userId: discordId(author.id) },
    conversationKind: 'guild_id' in message && message.guild_id ? 'group' : 'direct', body: message.content,
    selection: mentioned ? 'mention' : 'message', ...(message.message_reference?.message_id ? { replyToMessageId: discordId(message.message_reference.message_id) } : {}),
    ...(unsupported ? { unsupportedContent: true as const } : {}) }
}
