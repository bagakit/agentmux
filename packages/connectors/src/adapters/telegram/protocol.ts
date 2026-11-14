import { AgentMuxError } from '@agentmux/core'
import type { ConnectionConfig } from '@agentmux/core/connections'
import type { VerifiedIngressMessage } from '../../durable-ingress.js'

export const TELEGRAM_ADAPTER_ID = 'telegram', TELEGRAM_DOMAIN = 'telegram.org'
export function telegramFailure(code = 'TELEGRAM_SOURCE_UNCONFIRMED'): never {
  throw new AgentMuxError('The original Telegram operation is unconfirmed. Existing Agents and their input remain available.', code)
}
export function telegramId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value !== 0) return String(value)
  if (typeof value === 'string' && /^-?[1-9][0-9]{0,15}$/u.test(value) && Number.isSafeInteger(Number(value))) return value
  return telegramFailure('TELEGRAM_IDENTITY_INVALID')
}
export function telegramConfig(config: Pick<ConnectionConfig, 'adapterId' | 'application'>): void {
  if (config.adapterId !== TELEGRAM_ADAPTER_ID || config.application.domain !== TELEGRAM_DOMAIN || ('issuer' in config.application && config.application.issuer !== undefined) || Number(telegramId(config.application.appId)) <= 0) telegramFailure('TELEGRAM_APPLICATION_MISMATCH')
}
export function telegramTarget(value: string): { chatId: string; threadId?: number } {
  const parts = value.split(':')
  if (parts.length > 2) return telegramFailure('TELEGRAM_IDENTITY_INVALID')
  const chatId = telegramId(parts[0])
  if (parts.length === 1) return { chatId }
  const threadId = Number(telegramId(parts[1]))
  if (threadId <= 0) return telegramFailure('TELEGRAM_IDENTITY_INVALID')
  return { chatId, threadId }
}
export type TelegramUser = { id: number; is_bot: boolean; username?: string; first_name?: string; last_name?: string }
export type TelegramMessage = {
  message_id: number; date?: number; chat: { id: number; type: string; title?: string; first_name?: string; username?: string }
  from?: TelegramUser; sender_chat?: { id: number }; text?: string; caption?: string
  entities?: Array<{ type: string; offset: number; length: number; user?: TelegramUser }>
  message_thread_id?: number; is_topic_message?: boolean; reply_to_message?: TelegramMessage
  photo?: unknown; document?: unknown; audio?: unknown; video?: unknown; voice?: unknown; sticker?: unknown
}
export type TelegramUpdate = { update_id: number; message?: TelegramMessage }
export const telegramMessageId = (chatId: string, messageId: unknown): string => chatId + ':' + telegramId(messageId)
export function telegramMessage(update: TelegramUpdate, config: ConnectionConfig, bot: TelegramUser): VerifiedIngressMessage {
  const message = update.message
  if (!message || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return telegramFailure('TELEGRAM_EVENT_UNSUPPORTED')
  if (!['private', 'group', 'supergroup'].includes(message.chat?.type)) return telegramFailure('TELEGRAM_EVENT_UNSUPPORTED')
  const userId = message.sender_chat ? telegramId(message.sender_chat.id) : telegramId(message.from?.id)
  if (!message.sender_chat && userId === telegramId(bot.id)) return telegramFailure('TELEGRAM_EVENT_OUTSIDE_SCOPE')
  const chatId = telegramId(message.chat.id), body = message.text ?? message.caption ?? ''
  const mentioned = message.entities?.some(entity => entity.type === 'text_mention' && entity.user?.id === bot.id ||
    entity.type === 'mention' && bot.username && entity.offset >= 0 && entity.length > 0 &&
    body.slice(entity.offset, entity.offset + entity.length).toLowerCase() === '@' + bot.username.toLowerCase())
  const unsupported = typeof message.text !== 'string' || ['photo', 'document', 'audio', 'video', 'voice', 'sticker'].some(field => Object.hasOwn(message, field))
  return { eventId: 'update:' + update.update_id, messageId: telegramMessageId(chatId, message.message_id),
    externalConversationId: chatId + (message.is_topic_message && message.message_thread_id ? ':' + telegramId(message.message_thread_id) : ''),
    actor: { application: { ...config.application }, idType: message.sender_chat ? 'chat_id' : 'user_id', userId },
    conversationKind: message.chat.type === 'private' ? 'direct' : 'group', body, selection: mentioned ? 'mention' : 'message',
    ...(message.reply_to_message ? { replyToMessageId: telegramMessageId(chatId, message.reply_to_message.message_id) } : {}),
    ...(unsupported ? { unsupportedContent: true as const } : {}) }
}
