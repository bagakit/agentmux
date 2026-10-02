import { connectHostedAgentMux, type AgentMuxHostedBootstrap, type AgentMuxHostedInvocation,
  type AgentMuxHostedRpcPort, type AgentMuxHostedOutputRpcPort, type AgentMuxHostedSubscription } from '@agentmux/core/hosted'
import { AgentMuxError, AgentMuxRpcError, openAgentMuxRpcHttpRequest, parseRpcRequest, parseRpcResponse, rpcRecord,
  rpcResponseError, type AgentMuxRpcHttpReader } from '@agentmux/core/public-rpc-http'
import type { AuthorizedHostedClientFactory } from './private-connection'

type RuntimeSubscription = Parameters<AgentMuxHostedRpcPort['subscribe']>
type OutputSubscription = Parameters<AgentMuxHostedOutputRpcPort['subscribe']>
type Handlers = {
  onInitial(value: unknown): void; onEvent(value: unknown): void
  onEnd?(error?: Error): void; signal?: AbortSignal
}
const protocol = () => new AgentMuxError('The original Host RPC observation is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
const cancelled = () => new AgentMuxError('This device consumer request was cancelled.', 'CONTROL_CANCELLED')

/** Only request correlation and consumer leases; the public leaf owns HTTP, JSON and SSE. */
export class HostedHttpRpcPort implements AgentMuxHostedRpcPort {
  private readonly pending = new Set<() => void>()
  private closed = false
  private readonly url: string
  constructor(private readonly options: { origin: string; fetch?: typeof globalThis.fetch }) {
    const url = new URL(options.origin)
    if (url.protocol !== 'https:' || url.origin !== options.origin || url.username || url.password
      || url.search || url.hash) throw new AgentMuxError('The device request needs its exact approved HTTPS Host.', 'INVALID_CONTROL_REQUEST')
    this.url = `${url.origin}/`
  }

  private exchange(method: string, params: object, handlers?: Handlers, signal?: AbortSignal): Promise<{
    value: unknown; subscription: AgentMuxHostedSubscription
  }> {
    if (this.closed || signal?.aborted) return Promise.reject(cancelled())
    const body = rpcRecord(params)
    if (Object.hasOwn(body, 'caller')) return Promise.reject(new AgentMuxError('A device principal is bound by the Host transport.', 'INVALID_CONTROL_REQUEST'))
    const id = crypto.randomUUID(), controller = new AbortController()
    let reader: AgentMuxRpcHttpReader | undefined, ended = false, admitted = false
    let subscriptionId: string | undefined, sequence = 0
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        if (ended) return
        ended = true; clearTimeout(deadline); signal?.removeEventListener('abort', abort)
        this.pending.delete(abort); controller.abort(); void reader?.dispose().catch(() => {})
        if (!admitted) reject(error ?? protocol())
        else handlers?.onEnd?.(error)
      }
      const abort = () => finish(cancelled())
      const deadline = setTimeout(() => finish(new AgentMuxError(
        'The Host reply is unconfirmed. Inspect the original operation before another explicit write; it is not resent.', 'CONTROL_TIMEOUT')), 60_000)
      const receive = (frame: unknown) => {
        if (ended) return
        try {
          if (!admitted) {
            const response = parseRpcResponse(frame)
            if (response.id !== id) throw protocol()
            const error = rpcResponseError(response); if (error) throw error
            if (handlers) {
              const opening = rpcRecord(response.result, ['subscriptionId', 'method', 'initial'], 'CONTROL_PROTOCOL_ERROR')
              if (typeof opening.subscriptionId !== 'string' || !opening.subscriptionId || opening.method !== method
                || !Object.hasOwn(opening, 'initial')) throw protocol()
              subscriptionId = opening.subscriptionId
              handlers.onInitial(opening.initial)
              if (ended) return
            }
            admitted = true; clearTimeout(deadline)
            resolve({ value: response.result, subscription: { dispose: async () => { finish(); await reader?.dispose() } } })
            if (!handlers) finish()
            return
          }
          if (!handlers) throw protocol()
          const notification = parseRpcRequest(frame)
          if (notification.id !== undefined || notification.method !== 'system.subscription.event') throw protocol()
          const event = rpcRecord(notification.params, ['subscriptionId', 'method', 'sequence', 'event'], 'CONTROL_PROTOCOL_ERROR')
          if (event.subscriptionId !== subscriptionId || event.method !== method || event.sequence !== sequence + 1
            || !Object.hasOwn(event, 'event')) throw protocol()
          sequence++
          // Business values remain in their original public form. The SDK is their single consumer.
          handlers.onEvent(event.event)
          const state = rpcRecord(event.event, undefined, 'CONTROL_PROTOCOL_ERROR')
          if (state.type === 'end') finish()
          if (state.type === 'error') {
            const failure = rpcRecord(state.error, undefined, 'CONTROL_PROTOCOL_ERROR')
            finish(new AgentMuxRpcError(typeof failure.message === 'string' ? failure.message : 'Host observation failed.',
              typeof failure.code === 'string' ? failure.code : 'CONTROL_PROTOCOL_ERROR', -32000,
              failure.details, failure.candidates, typeof failure.detail === 'string' ? failure.detail : undefined))
          }
        } catch (error) { finish(error instanceof Error ? error : protocol()) }
      }
      this.pending.add(abort); signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      void openAgentMuxRpcHttpRequest({ url: this.url, credentials: 'include',
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}) },
      { jsonrpc: '2.0', id, method, params: body }, receive, finish, controller.signal)
        .then(value => { reader = value; if (ended) return value.dispose() })
        .catch(error => finish(error instanceof Error ? error : protocol()))
    })
  }

  call(method: 'runtime.bootstrap', params: { consumerId: string }): Promise<AgentMuxHostedBootstrap>
  call(method: 'runtime.invoke', params: { consumerId: string; invocation: AgentMuxHostedInvocation }, options?: { signal?: AbortSignal }): Promise<{ value: unknown }>
  call(method: 'runtime.release-consumer', params: { consumerId: string }): Promise<{ released: boolean }>
  async call(method: string, params: object, options?: { signal?: AbortSignal }): Promise<never> {
    return (await this.exchange(method, params, undefined, options?.signal)).value as never
  }

  subscribe(...args: OutputSubscription): Promise<AgentMuxHostedSubscription>
  subscribe(...args: RuntimeSubscription): Promise<AgentMuxHostedSubscription>
  async subscribe(...[method, params, handlers]: OutputSubscription | RuntimeSubscription): Promise<AgentMuxHostedSubscription> {
    const value = await this.exchange(method, params, {
      onInitial: value => handlers.onInitial(value as never), onEvent: value => handlers.onEvent(value as never),
      ...(handlers.onEnd ? { onEnd: handlers.onEnd } : {}), ...(handlers.signal ? { signal: handlers.signal } : {})
    }, handlers.signal)
    return value.subscription
  }
  dispose(): void { if (this.closed) return; this.closed = true; for (const abort of [...this.pending]) abort() }
}

/** Admission already confirmed issuer identity. SDK bootstrap and its genuine event lease confirm semantics. */
export const connectPrivateHostedClient: AuthorizedHostedClientFactory = async ({ origin, hostId, signal, fetch }) => {
  if (!hostId) throw new AgentMuxError('The original device issuer is unconfirmed.', 'AGENT_CAPABILITY_INVALID')
  signal.throwIfAborted()
  const rpc = new HostedHttpRpcPort({ origin, ...(fetch ? { fetch } : {}) })
  const abort = () => rpc.dispose()
  signal.addEventListener('abort', abort, { once: true })
  try {
    const client = await connectHostedAgentMux({ rpc })
    if (signal.aborted) { await client.dispose(); throw cancelled() }
    // Later address attempts must not take away this confirmed consumer or its retained projection.
    return client
  } catch (error) { rpc.dispose(); throw error }
  finally { signal.removeEventListener('abort', abort) }
}
