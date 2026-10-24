import { WebSocketManager, WebSocketShardEvents, type SessionInfo } from '@discordjs/ws'
import { GatewayIntentBits, type GatewayDispatchPayload, type APIMessage, type APIUser } from 'discord-api-types/v10'
import type { ConnectionConfig, ConnectionObservation } from '@agentmux/core/connections'
import type { ConnectionAdapter } from '../../connection-host.js'
import type { IngressAuthenticator, VerifiedIngressEvent } from '../../durable-ingress.js'
import type { ConnectionIngressReceiver, ConnectionIngressTransport } from '../../connection-receivers.js'
import type { ChannelStoragePort } from '../../channel-storage.js'
import { DiscordClients, type DiscordHttpOptions } from './client.js'
import { DiscordPublicationAdapter } from './publication.js'
import { observeDiscordConversation } from './metadata.js'
import { createDiscordProfiles, observeDiscordActor } from './profile.js'
import { createDiscordRooms } from './rooms.js'
import { handleDiscordInteraction } from './actions.js'
import { discordConfig, discordFailure, discordId, discordMessage } from './protocol.js'
import { createDiscordHistory } from './history.js'

type Receiver = { config: ConnectionConfig; signal: AbortSignal; closed: boolean; botId: string; observed: boolean; socketFailed: boolean; cursorFailed: boolean; callbackFailure: string | null }
type Witness = { receiver: Receiver; raw: string; event?: VerifiedIngressEvent }
const owners = new Map<string, Receiver>()
const applicationKey = (config: Pick<ConnectionConfig, 'application'>) => JSON.stringify([config.application.domain, config.application.appId])

/** Native SDK lifecycle and authenticated dispatch only; Core and Outbox retain Agent/effect ownership. */
export class DiscordAdapter implements ConnectionAdapter, IngressAuthenticator {
  readonly adapterId = 'discord'
  readonly transport: ConnectionIngressTransport = { start: input => this.startReceiver(input) }
  readonly ingress = this
  readonly channelProfiles
  readonly roomDiscovery
  readonly publication
  readonly clients: DiscordClients
  readonly readHistory
  private readonly witnesses = new WeakSet<Witness>()
  private readonly stores = new Map<string, () => ChannelStoragePort>()
  constructor(options: { http?: Partial<DiscordHttpOptions> } = {}) {
    this.clients = new DiscordClients(options.http)
    this.readHistory = createDiscordHistory(this.clients)
    this.channelProfiles = createDiscordProfiles(this.clients)
    this.roomDiscovery = createDiscordRooms(this.clients)
    this.publication = new DiscordPublicationAdapter(this.clients, target => this.stores.get(applicationKey(target))?.())
  }
  setClientRetention(read: (connectionId: string) => boolean): void { this.clients.setClientRetention(read) }
  releaseConnection(connectionId: string): void { this.clients.releaseConnection(connectionId) }
  close(): void { this.clients.close() }
  async test(config: ConnectionConfig, credential: string): Promise<ConnectionObservation> {
    try {
      await this.clients.identity(config, credential, undefined, true)
      return { authentication: { state: 'ready' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }
    } catch { return { authentication: { state: 'unavailable', reason: 'check-failed' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } } }
  }
  async verify(config: ConnectionConfig, raw: string, proof?: unknown): Promise<VerifiedIngressEvent> {
    discordConfig(config)
    const witness = proof as Witness
    if (!witness || !this.witnesses.has(witness) || witness.raw !== raw || witness.receiver.closed || witness.receiver.signal.aborted || applicationKey(witness.receiver.config) !== applicationKey(config)) return discordFailure('DISCORD_TRANSPORT_PROOF_REQUIRED')
    return witness.event ?? discordMessage(JSON.parse(raw) as GatewayDispatchPayload, config, witness.receiver.botId)
  }
  async qualifyReply(config: ConnectionConfig, event: Readonly<VerifiedIngressEvent>, _raw: string, credential: string, signal: AbortSignal): Promise<'reply' | 'message' | 'unknown'> {
    if (event.kind === 'action' || !event.replyToMessageId) return 'message'
    try {
      const identity = await this.clients.identity(config, credential, signal)
      const message = await this.clients.rest(config, credential).get(`/channels/${discordId(event.externalConversationId)}/messages/${discordId(event.replyToMessageId)}`, { signal }) as APIMessage
      return message.id === event.replyToMessageId && message.channel_id === event.externalConversationId && message.author?.id ? message.author.id === identity.botId ? 'reply' : 'message' : 'unknown'
    } catch { return 'unknown' }
  }
  private async startReceiver(input: Parameters<ConnectionIngressTransport['start']>[0]): Promise<ConnectionIngressReceiver> {
    const { config, credential, signal } = input
    discordConfig(config)
    const key = applicationKey(config)
    if (signal.aborted) return discordFailure('DISCORD_RECEIVER_CANCELLED')
    if (owners.has(key)) return discordFailure('DISCORD_RECEIVER_ALREADY_OWNED')
    const identity = await this.clients.identity(config, credential, signal)
    const receiver: Receiver = { config: structuredClone(config), signal, closed: false, botId: identity.botId, observed: false, socketFailed: false, cursorFailed: false, callbackFailure: null }
    owners.set(key, receiver); this.stores.set(key, input.storage)
    const sessions = new Map<number, SessionInfo | null>(), failed = new AbortController()
    const storage = () => input.storage()
    const observeActor = (user: APIUser) => {
      try {
        const actor = { application: config.application, idType: 'snowflake', userId: user.id }, local = storage()
        const previous = this.channelProfiles.readActor({ actor, storage: local }), observed = observeDiscordActor(local, actor, user)
        if (previous.profile?.name !== observed.profile?.name || previous.profile?.avatarUrl !== observed.profile?.avatarUrl) input.metadataChanged?.({ kind: 'actor', actor })
      } catch { /* Display observations cannot reject authenticated input or callbacks. */ }
    }
    const readSession = (id: number): SessionInfo | null => {
      try { const row = storage().get('gateway-session:' + id); return row?.value.kind === 'json' ? row.value.value as SessionInfo | null : null }
      catch { receiver.cursorFailed = true; return null }
    }
    const saveSession = (id: number, session: SessionInfo | null) => {
      try { const original = storage().get('gateway-session:' + id); storage().put({ key: 'gateway-session:' + id, expectedRevision: original?.revision ?? null, value: { kind: 'json', value: session } }); receiver.cursorFailed = false }
      catch { receiver.cursorFailed = true /* The original ingress remains durable; an older cursor may safely replay deduplicated events. */ }
    }
    const manager = new WebSocketManager({ token: credential, rest: this.clients.rest(config, credential), intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.DirectMessages | GatewayIntentBits.MessageContent,
      retrieveSessionInfo: id => sessions.has(id) ? sessions.get(id)! : (() => { const saved = readSession(id); sessions.set(id, saved); return saved })(),
      updateSessionInfo: (id, info) => { sessions.set(id, info); if (info === null && !receiver.closed && !signal.aborted) saveSession(id, null) },
      identifyProperties: { os: process.platform, browser: 'AgentMux', device: 'AgentMux' } })
    const close = () => {
      if (receiver.closed) return
      receiver.closed = true; signal.removeEventListener('abort', close)
      void Promise.resolve(manager.destroy()).catch(() => {})
      if (owners.get(key) === receiver) { owners.delete(key); this.stores.delete(key) }
    }
    signal.addEventListener('abort', close, { once: true })
    manager.on(WebSocketShardEvents.Closed, () => { receiver.socketFailed = true })
    manager.on(WebSocketShardEvents.Error, () => { receiver.socketFailed = true })
    manager.on(WebSocketShardEvents.SocketError, () => { receiver.socketFailed = true })
    // This only serializes native custody/ACK for a shard. DurableIngress owns all saved messages and Agent input.
    const tails = new Map<number, Promise<void>>()
    manager.on(WebSocketShardEvents.Dispatch, (payload, shard) => {
      const originalSession = sessions.get(shard)
      const previous = tails.get(shard) ?? Promise.resolve()
      const work = previous.then(async () => {
        if (receiver.closed || signal.aborted) return
        if (payload.t === 'READY' && payload.d.user.id !== identity.botId) return discordFailure('DISCORD_APPLICATION_MISMATCH')
        if (payload.t === 'CHANNEL_UPDATE' || payload.t === 'THREAD_UPDATE') {
          try { if (typeof payload.d.name === 'string' || payload.d.name === null) observeDiscordConversation({ config, storage: storage() }, payload.d); input.metadataChanged?.({ kind: 'conversation', externalConversationId: discordId(payload.d.id) }) } catch { /* Optional rename observations do not gate custody or Agent input. */ }
        }
        if (payload.t === 'INTERACTION_CREATE') {
          let custodyFailed = false
          try { await handleDiscordInteraction({ config, interaction: payload.d, botId: identity.botId, rest: this.clients.rest(config, credential), signal,
            ...(input.questionForm ? { questionForm: input.questionForm } : {}),
            callbackObservation: confirmed => { if (!confirmed) receiver.callbackFailure = payload.d.id; else if (receiver.callbackFailure === payload.d.id) receiver.callbackFailure = null },
            receive: async (event, acknowledge) => {
              const witness: Witness = { receiver, raw: JSON.stringify(payload), event }; this.witnesses.add(witness)
              try { return await input.receive({ raw: witness.raw, transportProof: witness }, acknowledge) }
              catch (error) { custodyFailed = true; throw error }
              finally { this.witnesses.delete(witness) }
            } }) } catch (error) { if (custodyFailed) throw error; receiver.callbackFailure = payload.d.id }
          const user = payload.d.member?.user ?? payload.d.user
          if (payload.d.application_id === config.application.appId && user && !user.bot) observeActor(user)
        }
        if (payload.t === 'MESSAGE_CREATE') {
          const message = payload.d
          if (message.author.id === identity.botId && message.nonce !== undefined) {
            try { const original = storage().get('effect:nonce:' + String(message.nonce)); storage().put({ key: 'effect:nonce:' + String(message.nonce), expectedRevision: original?.revision ?? null,
              value: { kind: 'json', value: { applicationId: config.application.appId, channelId: discordId(message.channel_id), messageId: discordId(message.id) } } }) } catch { /* Only the original publication witness is unconfirmed; native input still works. */ }
          } else if (!message.author.bot && !message.webhook_id) {
            const witness = { receiver, raw: JSON.stringify(payload) }; this.witnesses.add(witness)
            try { await input.receive({ raw: witness.raw, transportProof: witness }, () => undefined); receiver.observed = true }
            finally { this.witnesses.delete(witness) }
            observeActor(message.author as APIUser)
          }
        }
        receiver.socketFailed = false
        if (originalSession) saveSession(shard, { ...originalSession, sequence: payload.s })
      }).catch(() => { receiver.socketFailed = true; close(); failed.abort() })
      tails.set(shard, work)
    })
    try { await manager.connect() } catch { close(); return discordFailure('DISCORD_RECEIVER_UNAVAILABLE') }
    return { close, closed: failed.signal, observation: () => ({ authentication: { state: 'ready' }, transport: { state: receiver.closed ? 'disabled' : receiver.socketFailed ? 'unknown' : 'ready', ...(receiver.socketFailed ? { reason: 'check-failed' as const } : {}) },
      intake: receiver.cursorFailed || receiver.socketFailed || receiver.callbackFailure ? { state: 'unknown', reason: 'check-failed' } : receiver.observed ? { state: 'ready' } : { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }) }
  }
}
