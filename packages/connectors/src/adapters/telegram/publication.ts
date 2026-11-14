import type { PublicationAdapter } from '../../publication-adapter.js'
import type { PublicationMapping, PublicationOperation, PublicationReceipt } from '../../publication-store.js'
import { parsePreparedPublication, type PreparedPublication, type PublicationEffectContext } from '../../publication-wire.js'
import { publicationPlainText } from '../../publication-plain-text.js'
import { TelegramClient, type TelegramResponse } from './client.js'
import { telegramFailure, telegramId, telegramMessageId, telegramTarget, type TelegramMessage } from './protocol.js'
import { createHash } from 'node:crypto'

export const TELEGRAM_PUBLICATION = { adapterId: 'telegram', renderVersion: 'telegram-text-v1', fragmentBytes: 3500, replyMetadata: true } as const
export function telegramRateLimitScopes(prepared: Readonly<PreparedPublication>, target: Readonly<PublicationOperation['target']>) {
  return { request: createHash('sha256').update(JSON.stringify(['telegram', target.application, telegramTarget(target.externalConversationId).chatId, prepared.request.path])).digest('hex') }
}
export function prepareTelegramPublication(operation: Readonly<PublicationOperation>): PreparedPublication {
  const target = telegramTarget(operation.target.externalConversationId), mapping = operation.mapping
  let messageId: number | undefined
  if (mapping) {
    const pieces = mapping.messageId.split(':')
    if (pieces.length !== 2 || pieces[0] !== target.chatId || mapping.reactionId || mapping.threadId || mapping.nativeCard) telegramFailure('TELEGRAM_ORIGINAL_MESSAGE_UNCONFIRMED')
    messageId = Number(telegramId(pieces[1]))
    if (messageId <= 0) telegramFailure('TELEGRAM_ORIGINAL_MESSAGE_UNCONFIRMED')
  }
  if (operation.effect === 'withdraw' && messageId === undefined) telegramFailure('TELEGRAM_ORIGINAL_MESSAGE_UNCONFIRMED')
  const method = operation.effect === 'withdraw' ? 'deleteMessage' : mapping ? 'editMessageText' : 'sendMessage'
  return { adapterId: TELEGRAM_PUBLICATION.adapterId, renderVersion: TELEGRAM_PUBLICATION.renderVersion, requestKey: operation.operationId,
    request: { method: 'POST', path: '/' + method, contentType: 'application/json', body: JSON.stringify({ chat_id: target.chatId,
      ...(messageId === undefined ? target.threadId === undefined ? {} : { message_thread_id: target.threadId } : { message_id: messageId }),
      ...(operation.effect === 'withdraw' ? {} : { text: publicationPlainText(operation), link_preview_options: { is_disabled: true } }) }) } }
}
function failure(response: TelegramResponse): PublicationReceipt {
  const code = response.data.error_code
  return response.data.ok === false && [400, 401, 403, 404, 429].includes(code!) ? { state: 'not-applied', reason: code === 429 ? 'rate-limited' : code === 400 ? 'unsupported-format' : 'platform-rejected' } : { state: 'unknown', reason: 'effect-unconfirmed' }
}
export class TelegramPublicationAdapter implements PublicationAdapter {
  readonly adapterId = TELEGRAM_PUBLICATION.adapterId
  readonly renderVersion = TELEGRAM_PUBLICATION.renderVersion
  readonly supportedRenderVersions = [this.renderVersion]
  readonly fragmentBytes = TELEGRAM_PUBLICATION.fragmentBytes
  readonly replyMetadata = true as const
  prepare = prepareTelegramPublication
  rateLimitScopes = telegramRateLimitScopes
  constructor(private readonly client: TelegramClient) {}
  async dispatch(value: PreparedPublication, target: PublicationOperation['target'], credential: string, signal: AbortSignal, mapping?: Readonly<PublicationMapping>, context?: PublicationEffectContext): Promise<PublicationReceipt> {
    const prepared = parsePreparedPublication(value, this), config = { ...target, adapterId: this.adapterId, label: '', enabled: true, credentialRef: '' }
    let bot
    try { bot = await this.client.identity(config, credential, signal) } catch { return { state: 'not-applied', reason: 'adapter-unavailable' } }
    try {
      const response = await this.client.call(credential, prepared.request.path.slice(1), JSON.parse(prepared.request.body!), signal)
      if (response.status !== 200 || response.data.ok !== true) {
        if (response.data.ok === false && response.data.error_code === 429) context?.reportRateLimit?.({ scopeKey: this.rateLimitScopes(prepared, target).request, observedAt: Date.now(),
          ...(typeof response.data.parameters?.retry_after === 'number' ? { resetSeconds: response.data.parameters.retry_after } : {}) })
        return failure(response)
      }
      if (prepared.request.path === '/deleteMessage') return mapping && response.data.result === true ? { state: 'confirmed', mapping: { ...mapping } } : { state: 'unknown', reason: 'effect-unconfirmed' }
      const message = response.data.result as TelegramMessage | undefined, address = telegramTarget(target.externalConversationId)
      if (!message || telegramId(message.chat?.id) !== address.chatId || message.from?.id !== bot.id || address.threadId !== undefined && message.message_thread_id !== address.threadId) return { state: 'unknown', reason: 'effect-unconfirmed' }
      const messageId = telegramMessageId(address.chatId, message.message_id)
      return !mapping || mapping.messageId === messageId ? { state: 'confirmed', mapping: { messageId } } : { state: 'unknown', reason: 'effect-unconfirmed' }
    } catch { return { state: 'unknown', reason: 'effect-unconfirmed' } }
  }
  // Bot API has no getMessage or client nonce lookup. Absence never proves an unknown send unapplied.
}
