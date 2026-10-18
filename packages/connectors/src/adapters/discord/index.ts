import { WebSocketManager, WebSocketShardEvents, type SessionInfo } from '@discordjs/ws'
import { GatewayIntentBits, type GatewayDispatchPayload, type APIMessage, type APIUser } from 'discord-api-types/v10'
import type { ConnectionConfig, ConnectionObservation } from '@agentmux/core/connections'
import type { ConnectionAdapter } from '../../connection-host.js'
import type { IngressAuthenticator, VerifiedIngressEvent } from '../../durable-ingress.js'
import type { ConnectionIngressReceiver, ConnectionIngressTransport } from '../../connection-receivers.js'
import type { ChannelStoragePort } from '../../channel-storage.js'
import { DiscordClients, type DiscordHttpOptions } from './client.js'
import { DiscordPublicationAdapter } from './publication.js'
import { createDiscordProfiles, observeDiscordActor } from './profile.js'
import { discordConfig, discordFailure, discordId, discordMessage } from './protocol.js'

type Receiver = { config: ConnectionConfig; signal: AbortSignal; closed: boolean; botId: string; observed: boolean; failed: boolean }
type Witness = { receiver: Receiver; raw: string }
const owners = new Map<string, Receiver>()
const applicationKey = (config: Pick<ConnectionConfig, 'application'>) => JSON.stringify([config.application.domain, config.application.appId])

/** Native SDK lifecycle and authenticated dispatch only; Core and Outbox retain Agent/effect ownership. */
export class DiscordAdapter implements ConnectionAdapter, IngressAuthenticator {
  readonly adapterId = 'discord'
  readonly transport: ConnectionIngressTransport = { start: input => this.startReceiver(input) }
  readonly ingress = this
  readonly channelProfiles
  readonly publication
  readonly clients: DiscordClients
  private readonly witnesses = new WeakSet<Witness>()
  private readonly stores = new Map<string, () => ChannelStoragePort>()
  constructor(options: { http?: Partial<DiscordHttpOptions> } = {}) {
    this.clients = new DiscordClients(options.http)
    this.channelProfiles = createDiscordProfiles(this.clients)
    this.publication = new DiscordPublicationAdapter(this.clients, target => this.stores.get(applicationKey(target))?.())
  }
  async test(config: ConnectionConfig, credential: string): Promise<ConnectionObservation> {
    try {
      await this.clients.identity(config, credential)
      return { authentication: { state: 'ready' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }
    } catch { return { authentication: { state: 'unavailable', reason: 'check-failed' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } } }
  }
  async verify(config: ConnectionConfig, raw: string, proof?: unknown): Promise<VerifiedIngressEvent> {
    discordConfig(config)
    const witness = proof as Witness
    if (!witness || !this.witnesses.has(witness) || witness.raw !== raw || witness.receiver.closed || witness.receiver.signal.aborted || applicationKey(witness.receiver.config) !== applicationKey(config)) return discordFailure('DISCORD_TRANSPORT_PROOF_REQUIRED')
    return discordMessage(JSON.parse(raw) as GatewayDispatchPayload, config, witness.receiver.botId)
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
    if (owners.has(key) || signal.aborted) return discordFailure('DISCORD_RECEIVER_ALREADY_OWNED')
    const identity = await this.clients.identity(config, credential, signal)
    const receiver: Receiver = { config: structuredClone(config), signal, closed: false, botId: identity.botId, observed: false, failed: false }
    owners.set(key, receiver); this.stores.set(key, input.storage)
    const sessions = new Map<number, SessionInfo | null>(), failed = new AbortController()
    const storage = () => input.storage()
    const readSession = (id: number): SessionInfo | null => {
      try { const row = storage().get('gateway-session:' + id); return row?.value.kind === 'json' ? row.value.value as SessionInfo | null : null }
      catch { receiver.failed = true; return null }
    }
    const saveSession = (id: number, session: SessionInfo | null) => {
      try { const original = storage().get('gateway-session:' + id); storage().put({ key: 'gateway-session:' + id, expectedRevision: original?.revision ?? null, value: { kind: 'json', value: session } }) }
      catch { receiver.failed = true /* The original ingress remains durable; an older cursor may safely replay deduplicated events. */ }
    }
    const manager = new WebSocketManager({ token: credential, rest: this.clients.rest(config, credential), intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.DirectMessages | GatewayIntentBits.MessageContent,
      retrieveSessionInfo: id => sessions.has(id) ? sessions.get(id)! : (() => { const saved = readSession(id); sessions.set(id, saved); return saved })(),
      updateSessionInfo: (id, info) => { sessions.set(id, info); if (info === null) saveSession(id, null) },
      identifyProperties: { os: process.platform, browser: 'AgentMux', device: 'AgentMux' } })
    const close = () => {
      if (receiver.closed) return
      receiver.closed = true; signal.removeEventListener('abort', close)
      void Promise.resolve(manager.destroy()).catch(() => {})
      if (owners.get(key) === receiver) { owners.delete(key); this.stores.delete(key) }
    }
    signal.addEventListener('abort', close, { once: true })
    manager.on(WebSocketShardEvents.Error, () => { receiver.failed = true })
    manager.on(WebSocketShardEvents.SocketError, () => { receiver.failed = true })
    // This only serializes native custody/ACK for a shard. DurableIngress owns all saved messages and Agent input.
    const tails = new Map<number, Promise<void>>()
    manager.on(WebSocketShardEvents.Dispatch, (payload, shard) => {
      const originalSession = sessions.get(shard)
      const previous = tails.get(shard) ?? Promise.resolve()
      const work = previous.then(async () => {
        if (receiver.closed || signal.aborted) return
        if (payload.t === 'READY' && payload.d.user.id !== identity.botId) return discordFailure('DISCORD_APPLICATION_MISMATCH')
        if (payload.t === 'MESSAGE_CREATE') {
          const message = payload.d
          if (message.author.id === identity.botId && message.nonce !== undefined) {
            try { const original = storage().get('effect:nonce:' + String(message.nonce)); storage().put({ key: 'effect:nonce:' + String(message.nonce), expectedRevision: original?.revision ?? null,
              value: { kind: 'json', value: { applicationId: config.application.appId, channelId: discordId(message.channel_id), messageId: discordId(message.id) } } }) } catch { receiver.failed = true }
          } else if (!message.author.bot && !message.webhook_id) {
            const witness = { receiver, raw: JSON.stringify(payload) }; this.witnesses.add(witness)
            try { await input.receive({ raw: witness.raw, transportProof: witness }, () => undefined); receiver.observed = true }
            finally { this.witnesses.delete(witness) }
            try { observeDiscordActor(storage(), { application: config.application, idType: 'snowflake', userId: message.author.id }, message.author as APIUser) } catch { /* Optional display data cannot reject acknowledged input. */ }
          }
        }
        if (originalSession) saveSession(shard, { ...originalSession, sequence: payload.s })
      }).catch(() => { receiver.failed = true; close(); failed.abort() })
      tails.set(shard, work)
    })
    try { await manager.connect() } catch { close(); return discordFailure('DISCORD_RECEIVER_UNAVAILABLE') }
    return { close, closed: failed.signal, observation: () => ({ authentication: { state: 'ready' }, transport: { state: receiver.closed ? 'disabled' : receiver.failed ? 'unknown' : 'ready', ...(receiver.failed ? { reason: 'check-failed' as const } : {}) },
      intake: receiver.failed ? { state: 'unknown', reason: 'check-failed' } : receiver.observed ? { state: 'ready' } : { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }) }
  }
}
