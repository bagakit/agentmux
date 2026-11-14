import type { ConnectionConfig, ConnectionObservation } from '@agentmux/core/connections'
import type { ConnectionAdapter } from '../../connection-host.js'
import type { ConnectionIngressTransport, ConnectionReceiverEnd } from '../../connection-receivers.js'
import type { IngressAuthenticator } from '../../durable-ingress.js'
import type { RoomDiscoveryAdapter } from '../../room-discovery-adapter.js'
import type { ChannelStoragePort } from '../../channel-storage.js'
import { TelegramClient } from './client.js'
import { TelegramPublicationAdapter } from './publication.js'
import { createTelegramApi } from './api.js'
import { telegramConfig, telegramFailure, telegramId, telegramMessage, telegramTarget, type TelegramMessage, type TelegramUpdate, type TelegramUser } from './protocol.js'

type Witness = { raw: string; application: ConnectionConfig['application']; signal: AbortSignal; bot: TelegramUser; sourceBoundaryUnconfirmed: boolean }
const owners = new Set<string>()
const applicationKey = (config: ConnectionConfig) => JSON.stringify([config.application.domain, config.application.appId])
const unknown = (): ConnectionObservation => ({ authentication: { state: 'ready' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } })
const unavailable = { state: 'unavailable', reason: 'platform-unavailable' } as const

/** Official Bot API long polling. Core input, durable intake and Publication remain the only delivery owners. */
export class TelegramAdapter implements ConnectionAdapter, IngressAuthenticator {
  readonly adapterId = 'telegram'
  readonly ingress = this
  readonly client: TelegramClient
  readonly publication: TelegramPublicationAdapter
  readonly api: NonNullable<ConnectionAdapter['api']>
  readonly transport: ConnectionIngressTransport = { start: input => this.start(input) }
  private readonly witnesses = new WeakSet<Witness>()
  private readonly receivers = new Set<AbortController>()
  constructor(options: { fetch?: typeof fetch } = {}) {
    this.client = new TelegramClient(options.fetch)
    this.publication = new TelegramPublicationAdapter(this.client)
    this.api = createTelegramApi(this.client)
  }
  releaseConnection(connectionId: string): void { this.client.release(connectionId) }
  close(): void { for (const receiver of this.receivers) receiver.abort(); this.client.close() }
  async test(config: ConnectionConfig, credential: string): Promise<ConnectionObservation> {
    try { await this.client.identity(config, credential, undefined, true); return unknown() }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      return { ...unknown(), authentication: { state: code === 'TELEGRAM_AUTHENTICATION_REJECTED' || code === 'TELEGRAM_APPLICATION_MISMATCH' || code === 'TELEGRAM_REQUEST_INVALID' ? 'unavailable' : 'unknown', reason: 'check-failed' } }
    }
  }
  readonly profile: NonNullable<ConnectionAdapter['profile']> = { get: async (config, revision, credential, signal) => {
    const bot = await this.client.identity(config, credential, signal, true)
    return { connectionId: config.connectionId, connectionRevision: revision, application: config.application, language: null,
      state: 'observed', profile: bot.first_name || bot.username ? { name: bot.first_name ?? bot.username! } : {}, metadata: null, botId: telegramId(bot.id),
      onlineVersionId: null, reviewingVersionId: null, version: null, managementUrl: 'https://t.me/BotFather' }
  } }
  async verify(config: ConnectionConfig, raw: string, proof?: unknown) {
    telegramConfig(config)
    const witness = proof as Witness
    if (!witness || !this.witnesses.has(witness) || witness.signal.aborted || witness.raw !== raw ||
      witness.application.domain !== config.application.domain || witness.application.appId !== config.application.appId) return telegramFailure('TELEGRAM_TRANSPORT_PROOF_REQUIRED')
    return { ...telegramMessage(JSON.parse(raw) as TelegramUpdate, config, witness.bot), ...(witness.sourceBoundaryUnconfirmed ? { sourceBoundaryUnconfirmed: true as const } : {}) }
  }
  readonly qualifyReply: NonNullable<IngressAuthenticator['qualifyReply']> = async (_config, event, raw) => {
    if (event.kind === 'action' || !event.replyToMessageId) return 'message'
    const update = JSON.parse(raw) as TelegramUpdate, original = update.message?.reply_to_message
    if (!original?.from) return 'unknown'
    return telegramId(original.from.id) === event.actor.application.appId ? 'reply' : 'message'
  }
  private async start(input: Parameters<ConnectionIngressTransport['start']>[0]) {
    const { config, credential } = input
    telegramConfig(config); input.signal.throwIfAborted()
    const key = applicationKey(config)
    if (owners.has(key)) return telegramFailure('TELEGRAM_RECEIVER_ALREADY_OWNED')
    owners.add(key)
    let bot: TelegramUser
    try { bot = await this.client.identity(config, credential, input.signal, true) }
    catch (error) { owners.delete(key); throw error }
    const stopped = new AbortController(), ended = new AbortController(), signal = AbortSignal.any([input.signal, stopped.signal])
    let observed = false, connected = false, gaps = false
    this.receivers.add(stopped)
    const finish = (end: ConnectionReceiverEnd) => {
      if (ended.signal.aborted) return
      owners.delete(key); this.receivers.delete(stopped); ended.abort(end); stopped.abort()
    }
    signal.addEventListener('abort', () => finish({ automatic: false, reason: 'sdk-ended' }), { once: true })
    const save = (storage: ChannelStoragePort, name: string, value: unknown) => {
      const previous = storage.get(name); storage.put({ key: name, expectedRevision: previous?.revision ?? null, value: { kind: 'json', value } })
    }
    void (async () => {
      try {
        while (!signal.aborted) {
          const cursor = input.storage().get('telegram-update-offset')
          if (cursor && cursor.value.kind !== 'json') return telegramFailure('TELEGRAM_CURSOR_UNCONFIRMED')
          const offset = cursor?.value.kind === 'json' ? cursor.value.value as number : undefined
          if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) return telegramFailure('TELEGRAM_CURSOR_UNCONFIRMED')
          const boundary = input.storage().get('telegram-initial-stream-boundary')
          const live = boundary?.value.kind === 'json' && boundary.value.value === true
          const response = await this.client.call(credential, 'getUpdates', { ...(offset === undefined ? {} : { offset }), timeout: live ? 30 : 0, limit: 100, allowed_updates: ['message'] }, signal)
          if (response.status !== 200 || response.data.ok !== true || !Array.isArray(response.data.result)) {
            // 409 includes an existing webhook/other poller. Never delete it or steal the native consumer.
            finish({ automatic: ![401, 403, 409].includes(response.data.error_code!), reason: 'check-failed', retryAt: Date.now() + 5_000 }); return
          }
          connected = true
          // An exact empty short-poll response establishes the initial native cut.
          // Continuing traffic must never be required to fall silent for a long poll.
          if (!live && response.data.result.length === 0) save(input.storage(), 'telegram-initial-stream-boundary', true)
          let previous = (offset ?? 0) - 1
          for (const update of response.data.result as TelegramUpdate[]) {
            if (!Number.isSafeInteger(update.update_id) || update.update_id <= previous) return telegramFailure('TELEGRAM_CURSOR_UNCONFIRMED')
            previous = update.update_id
            const raw = JSON.stringify(update), acknowledge = () => save(input.storage(), 'telegram-update-offset', update.update_id + 1)
            if (!update.message || !update.message.from && !update.message.sender_chat || update.message.from?.id === bot.id) {
              // Keep exact original protocol disposition before advancing a non-conversation update.
              save(input.storage(), 'telegram-unmapped-update:' + update.update_id, { raw, disposition: update.message ? 'unmapped-message' : 'non-message-update' })
              gaps ||= !!update.message && update.message.from?.id !== bot.id
              acknowledge(); continue
            }
            const witness: Witness = { raw, application: { ...config.application }, signal, bot, sourceBoundaryUnconfirmed: !live }; this.witnesses.add(witness)
            try { await input.receive({ raw, transportProof: witness }, acknowledge); observed = true }
            finally { this.witnesses.delete(witness) }
          }
        }
      } catch { if (!signal.aborted) finish({ automatic: true, reason: 'check-failed', retryAt: Date.now() + 5_000 }) }
    })()
    return { close: () => finish({ automatic: false, reason: 'sdk-ended' }), closed: ended.signal,
      lifecycle: () => ended.signal.aborted ? { state: 'ended' as const, reason: (ended.signal.reason as ConnectionReceiverEnd).reason } : { state: connected ? 'ready' as const : 'starting' as const },
      observation: (): ConnectionObservation => ({ ...unknown(), transport: { state: ended.signal.aborted ? 'unavailable' : connected ? 'ready' : 'unknown', ...(!connected || ended.signal.aborted ? { reason: 'check-failed' as const } : {}) },
        intake: gaps ? { state: 'unknown', reason: 'check-failed' } : observed ? { state: 'ready' } : { state: 'unknown', reason: 'not-started' } }) }
  }
  readonly roomDiscovery: RoomDiscoveryAdapter = {
    list: async () => ({ observation: unavailable, rooms: [], next: null }),
    search: async (input, credential, signal) => {
      const result = await this.readRoom(input.config, credential, input.query, signal)
      return { observation: result.observation, rooms: result.room ? [result.room] : [], next: null }
    },
    get: async (input, credential, signal) => this.readRoom(input.config, credential, input.externalConversationId, signal),
    members: async () => ({ observation: unavailable, members: [], next: null }),
    createLink: async (input, credential, signal) => {
      await this.client.identity(input.config, credential, signal)
      const target = telegramTarget(input.externalConversationId), expiresAtUnixSeconds = Math.floor(Date.now() / 1000) + 604800
      try {
        const response = await this.client.call(credential, 'createChatInviteLink', { chat_id: target.chatId, expire_date: expiresAtUnixSeconds }, signal)
        const link = response.data.result as { invite_link?: string; expire_date?: number } | undefined
        if (response.data.ok === true && link?.invite_link && link.expire_date === expiresAtUnixSeconds) return { kind: 'confirmed', link: { url: link.invite_link, expiresAtUnixSeconds } }
        return response.data.ok === false ? { kind: 'refused', reason: 'permission-denied' } : { kind: 'unknown' }
      } catch { return { kind: 'unknown' } }
    }
  }
  private async readRoom(config: ConnectionConfig, credential: string, value: string, signal?: AbortSignal) {
    await this.client.identity(config, credential, signal)
    const target = value.startsWith('@') ? { chatId: value } : telegramTarget(value)
    const response = await this.client.call(credential, 'getChat', { chat_id: target.chatId }, signal), chat = response.data.result as TelegramMessage['chat'] | undefined
    if (response.data.ok !== true || !chat || !target.chatId.startsWith('@') && telegramId(chat.id) !== target.chatId) return { observation: unavailable, room: null }
    return { observation: { state: 'ready' as const }, room: { externalConversationId: telegramId(chat.id) + (target.threadId === undefined ? '' : ':' + target.threadId), name: chat.title ?? chat.first_name ?? chat.username ?? null,
      state: target.threadId === undefined ? 'active' as const : 'unknown' as const, mode: target.threadId !== undefined ? 'topic' as const : chat.type === 'private' ? 'direct' as const : 'group' as const, membershipApproval: 'unknown' as const } }
  }
}
