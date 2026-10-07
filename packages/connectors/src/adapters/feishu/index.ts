import { AsyncLocalStorage } from 'node:async_hooks'
import { Client, WSClient, EventDispatcher, AppType, LoggerLevel, defaultHttpInstance, DefaultCache, type HttpInstance, type HttpRequestOptions, type Logger } from '@larksuiteoapi/node-sdk'
import { parseConnectionConfig, type ConnectionConfig, type ConnectionObservation, type ConnectionRecord } from '@agentmux/core/connections'
import type { ConnectionAdapter, ConnectionHost } from '../../connection-host.js'
import type { DurableIngressHost, IngressAuthenticator, VerifiedIngressEvent } from '../../durable-ingress.js'
import { feishuFailure, feishuIdentity, readFeishuMessage, projectFeishuMessage } from './message.js'
import { feishuParentAddressing } from './reply.js'

/** A trusted Host composition port, never populated from RPC or a platform event. */
export type FeishuAdapterOptions = {
  connections: Pick<ConnectionHost, 'readConfiguration'>
  http?: HttpInstance
}
export type FeishuReceiver = {
  observation(): ConnectionObservation
  close(): void
}
type ReceiverState = { record: ConnectionRecord; closed: boolean; botOpenId: string; ws: WSClient | null; observed: boolean }
type Witness = { receiver: ReceiverState; raw: string }
const owners = new Map<string, ReceiverState>()
const applicationKey = (config: ConnectionConfig) => JSON.stringify([config.application.domain, config.application.appId])
const sameConfig = (left: ConnectionConfig, right: ConnectionConfig) => JSON.stringify(parseConnectionConfig(left)) === JSON.stringify(parseConnectionConfig(right))
const muted = () => undefined
// SDK logs can include credentials, connection tickets and complete platform bodies. No SDK argument leaves this sink.
const safeLogger: Logger = { error: muted, warn: muted, info: muted, debug: muted, trace: muted }

export class FeishuAdapter implements ConnectionAdapter, IngressAuthenticator {
  readonly adapterId = 'feishu'
  private readonly witnesses = new WeakSet<object>()
  private readonly callback = new AsyncLocalStorage<Witness>()
  constructor(private readonly options: FeishuAdapterOptions) {}

  private configuration(config: ConnectionConfig): void {
    if (config.adapterId !== this.adapterId || !['open.feishu.cn', 'open.larksuite.com'].includes(config.application.domain)) feishuFailure('FEISHU_APPLICATION_INVALID')
    feishuIdentity(config.application.appId)
  }
  private http(): HttpInstance {
    const transport: HttpInstance = this.options.http ?? defaultHttpInstance as unknown as HttpInstance
    const http = Object.create(transport) as HttpInstance
    http.request = async <T, R = T, D = unknown>(input: HttpRequestOptions<D>): Promise<R> => {
      try {
        const result = await transport.request<T, R, D>(input)
        if (input.url?.endsWith('/callback/ws/endpoint')) {
          const response = result as { code?: unknown; data?: { URL?: unknown } }
          if (response.code === 0) {
            if (typeof response.data?.URL !== 'string') feishuFailure('FEISHU_TRANSPORT_INVALID')
            const url = new URL(response.data.URL)
            if (url.protocol !== 'wss:' || url.username || url.password || url.hash) feishuFailure('FEISHU_TRANSPORT_INVALID')
          }
        }
        return result
      } catch { return feishuFailure('FEISHU_SDK_REQUEST_FAILED') }
    }
    return http
  }
  private client(config: ConnectionConfig, credential: string): Client {
    this.configuration(config)
    try {
      return new Client({ appId: config.application.appId, appSecret: credential, domain: `https://${config.application.domain}`, appType: AppType.SelfBuild, httpInstance: this.http(), cache: new DefaultCache(), logger: safeLogger, loggerLevel: LoggerLevel.error })
    } catch { return feishuFailure('FEISHU_CLIENT_UNAVAILABLE') }
  }
  /** Outbound leaves reuse the official authenticated Client; raw SDK errors never escape this call. */
  async withClient<T>(config: ConnectionConfig, credential: string, call: (client: Client) => Promise<T>): Promise<T> {
    try { return await call(this.client(config, credential)) }
    catch { return feishuFailure('FEISHU_SDK_REQUEST_FAILED') }
  }
  private async bot(client: Client): Promise<string> {
    try {
      const response = await client.request<{ code?: unknown; bot?: { open_id?: unknown } }>({ url: '/open-apis/bot/v3/info', method: 'GET' })
      if (response.code !== 0) feishuFailure('FEISHU_AUTHENTICATION_UNCONFIRMED')
      return feishuIdentity(response.bot?.open_id)
    } catch { return feishuFailure('FEISHU_AUTHENTICATION_UNCONFIRMED') }
  }
  async test(config: ConnectionConfig, credential: string): Promise<ConnectionObservation> {
    await this.bot(this.client(config, credential))
    return { authentication: { state: 'ready' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }
  }
  private current(receiver: ReceiverState): boolean {
    const current = this.options.connections.readConfiguration(receiver.record.config.connectionId)
    return !receiver.closed && !!current?.config.enabled && current.revision === receiver.record.revision && sameConfig(current.config, receiver.record.config) && owners.get(applicationKey(receiver.record.config)) === receiver
  }
  async verify(config: ConnectionConfig, raw: string, proof?: unknown): Promise<VerifiedIngressEvent> {
    if (!proof || typeof proof !== 'object' || !this.witnesses.has(proof)) feishuFailure('FEISHU_TRANSPORT_PROOF_REQUIRED')
    const witness = proof as Witness, receiver = witness.receiver
    if (witness.raw !== raw || !sameConfig(receiver.record.config, config) || !this.current(receiver)) feishuFailure('FEISHU_TRANSPORT_PROOF_MISMATCH')
    const payload = readFeishuMessage(raw, config.application)
    // Original parent/thread IDs stay in raw. Their presence cannot certify a reply to this application.
    if (!this.current(receiver)) feishuFailure('FEISHU_TRANSPORT_PROOF_MISMATCH')
    return projectFeishuMessage(payload, config.application, receiver.botOpenId)
  }
  /** An exact authenticated parent read, performed only after durable admission by the original Host. */
  async qualifyReply(config: ConnectionConfig, event: Readonly<VerifiedIngressEvent>, raw: string, credential: string, signal: AbortSignal): Promise<'reply' | 'message' | 'unknown'> {
    if (signal.aborted || !event.replyToMessageId || event.unsupportedContent) return 'unknown'
    let parentId: string
    try {
      const payload = readFeishuMessage(raw, config.application), { message, sender } = payload.event
      if (payload.header.event_id !== event.eventId || message.message_id !== event.messageId || message.chat_id !== event.externalConversationId ||
        message.parent_id !== event.replyToMessageId || sender.sender_type !== 'user' || message.chat_type !== 'group' || event.actor.idType !== 'open_id' ||
        sender.sender_id?.open_id !== event.actor.userId || event.actor.application.domain !== config.application.domain || event.actor.application.appId !== config.application.appId) return 'unknown'
      parentId = message.parent_id
    } catch { return 'unknown' }
    let abort!: () => void
    const cancelled = new Promise<'unknown'>(resolve => { abort = () => resolve('unknown'); signal.addEventListener('abort', abort, { once: true }) })
    try {
      const reading = this.withClient(config, credential, async client => {
        const response = await client.request<unknown>({ url: `/open-apis/im/v1/messages/${encodeURIComponent(parentId)}`, method: 'GET', params: { user_id_type: 'open_id' }, signal })
        return signal.aborted ? 'unknown' : feishuParentAddressing(response, config.application, parentId, event.externalConversationId)
      }).catch(() => 'unknown' as const)
      return await Promise.race([reading, cancelled])
    } finally { signal.removeEventListener('abort', abort) }
  }
  async openReceiver(config: ConnectionConfig, credential: string, ingress: Pick<DurableIngressHost, 'receive'>): Promise<FeishuReceiver> {
    config = parseConnectionConfig(config)
    this.configuration(config)
    const current = this.options.connections.readConfiguration(config.connectionId)
    if (!current?.config.enabled || !sameConfig(current.config, config)) feishuFailure('FEISHU_CONNECTION_REVISED')
    const key = applicationKey(config)
    if (owners.has(key)) feishuFailure('FEISHU_RECEIVER_ALREADY_OWNED')
    const receiver: ReceiverState = { record: structuredClone(current), closed: false, botOpenId: '', ws: null, observed: false }
    owners.set(key, receiver)
    const close = () => {
      receiver.closed = true
      try { receiver.ws?.close({ force: true }) } catch { /* Only this application's transport is released. */ }
      if (owners.get(key) === receiver) owners.delete(key)
    }
    try {
      const client = this.client(config, credential)
      receiver.botOpenId = await this.bot(client)
      if (!this.current(receiver)) feishuFailure('FEISHU_CONNECTION_REVISED')
      const dispatcher = new EventDispatcher({ logger: safeLogger, loggerLevel: LoggerLevel.error, cache: new DefaultCache() })
      dispatcher.unregister('app_ticket')
      dispatcher.register({ 'im.message.receive_v1': async () => {
        const witness = this.callback.getStore()
        if (!witness || !this.witnesses.has(witness) || witness.receiver !== receiver) feishuFailure('FEISHU_TRANSPORT_PROOF_REQUIRED')
        const payload = readFeishuMessage(witness.raw, config.application)
        // Bot echoes and direct chats are platform scope facts, never inferred from message text.
        if (payload.event.sender.sender_type !== 'user' || payload.event.message.chat_type !== 'group') return
        await ingress.receive({ connectionId: config.connectionId, raw: witness.raw, transportProof: witness }, () => undefined)
        receiver.observed = true
      } })
      const invoke = dispatcher.invoke.bind(dispatcher)
      dispatcher.invoke = async (data, params) => {
        if (params?.needCheck !== false || !this.current(receiver) || receiver.ws?.getConnectionStatus().state !== 'connected') feishuFailure('FEISHU_TRANSPORT_PROOF_REQUIRED')
        const witness: Witness = { receiver, raw: JSON.stringify(data) }
        this.witnesses.add(witness)
        try { return await this.callback.run(witness, () => invoke(data, params)) }
        catch { return feishuFailure('FEISHU_RECEIVE_FAILED') }
        finally { this.witnesses.delete(witness) }
      }
      receiver.ws = new WSClient({ appId: config.application.appId, appSecret: credential, domain: `https://${config.application.domain}`, httpInstance: this.http(), logger: safeLogger, loggerLevel: LoggerLevel.error })
      await receiver.ws.start({ eventDispatcher: dispatcher })
      if (receiver.ws.getConnectionStatus().state === 'idle') feishuFailure('FEISHU_SDK_START_UNCONFIRMED')
      return {
        close,
        observation: () => {
          const active = this.current(receiver), state = receiver.ws?.getConnectionStatus().state, connected = state === 'connected'
          return { authentication: active ? { state: 'ready' } : { state: 'unknown', reason: 'not-tested' },
            transport: receiver.closed ? { state: 'disabled' } : active && connected ? { state: 'ready' } : state === 'failed' ? { state: 'unavailable', reason: 'check-failed' } : { state: 'unknown', reason: 'not-started' },
            intake: active && connected && receiver.observed ? { state: 'ready' } : { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }
        }
      }
    } catch { close(); return feishuFailure('FEISHU_RECEIVER_UNAVAILABLE') }
  }
}
