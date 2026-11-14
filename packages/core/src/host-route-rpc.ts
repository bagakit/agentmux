import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from './errors.js'
import { mintObjectId } from './object-id.js'
import type { HostRouteTransport } from './host-route-gateway.js'
import { hostRouteScope, type AdoptedHostRoute, type HostRouteObservation } from './host-route.js'
import type { AgentMuxRpcClient, AgentMuxRpcSubscriptionOptions, AgentMuxRpcSubscription } from './public-rpc-client.js'
import type { AgentMuxRpcMethod, AgentMuxRpcParams, AgentMuxRpcResult, AgentMuxRpcStreamMethod, AgentMuxRpcStreamParams, AgentMuxRpcStreamInitial, AgentMuxRpcStreamEvent } from './public-rpc.js'
import { decodeHostedValue } from './hosted-value.js'
import { AGENTMUX_HOSTED_TRANSFER_MAX_BYTES } from './hosted-value.js'

type RpcPort = Pick<AgentMuxRpcClient, 'call' | 'subscribe'>
/** Adapt the existing public reader, preserving ordered delivery and its physical in-flight budget. */
export function hostRouteTransport(rpc: RpcPort): HostRouteTransport {
  return {
    identity: signal => rpc.call('route.identity', {}, signal ? { signal } : {}),
    call: (method, params, signal) => rpc.call(method, params, { signal }),
    watch: async (params, emit, signal) => {
      let initial: import('./host-route.js').HostRouteStreamInitial | undefined, closed = false, bytes = 0
      let release!: () => void, reader: AgentMuxRpcSubscription | undefined
      const opening = new Promise<void>(resolve => { release = resolve })
      let tail: Promise<void> = opening
      const fail = async (error: unknown) => {
        if (closed) return; closed = true; release()
        try {
          if (!signal.aborted) await emit({ type: 'error', error: { code: error instanceof AgentMuxError ? error.code : 'HOST_ROUTE_READER_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) } })
        } catch (cause) {
          if (!signal.aborted) console.warn('[host-route] Original reader failure delivery unconfirmed', cause)
        } finally {
          try { await reader?.dispose() }
          catch (cause) { console.warn('[host-route] Original reader release unconfirmed', cause) }
        }
      }
      reader = await rpc.subscribe('route.receive-watch', params, { signal,
        onInitial: value => { initial = value },
        onEvent: event => {
          if (closed || signal.aborted) return
          const value = event.type === 'route-event' ? event.event : event
          const size = Buffer.byteLength(JSON.stringify(value)); bytes += size
          // Same per-reader transfer budget as Hosted; cumulative Space/history is not capped.
          if (bytes > AGENTMUX_HOSTED_TRANSFER_MAX_BYTES * 2) { void fail(new AgentMuxError('This exact route reader fell behind. Reattach its original cursor; Runs and admitted operations remain retained.', 'RUNTIME_READER_BUDGET_EXCEEDED')); return }
          tail = tail.then(async () => { if (!closed && !signal.aborted) await emit(value) }).then(() => { bytes -= size }).catch(fail)
        },
        onEnd: error => { if (error && !signal.aborted) void fail(error) },
      })
      if (!initial) { closed = true; release(); await reader.dispose(); throw new AgentMuxError('The route reader has no original opening.', 'CONTROL_PROTOCOL_ERROR') }
      return { initial, start: release, dispose: async () => { closed = true; release(); await reader!.dispose() } }
    },
  }
}

/** SDK carrier over one explicitly adopted configured route; never auto-discovers or retries. */
export function routedAgentMuxRpc(rpc: RpcPort, routeId: string, adoptedRoute: AdoptedHostRoute): RpcPort {
  const check = (observation: HostRouteObservation, requestId: string) => {
    if (observation.requestId !== requestId || !isDeepStrictEqual(observation.route, adoptedRoute) || observation.logicalHops !== adoptedRoute.hops.length)
      throw new AgentMuxError('The reply names another adopted route. Keep the original operation and inspect its owner.', 'HOST_ROUTE_TARGET_MISMATCH')
  }
  return {
    async call<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, options = {}): Promise<AgentMuxRpcResult<M>> {
      const call = { method, params: params as Record<string, unknown> }; hostRouteScope(call, false)
      const requestId = mintObjectId(), result = await rpc.call('route.call', { routeId, adoptedRoute, requestId, call }, options)
      check(result.observation, requestId)
      // The original receiving dispatcher validates the original result; the route owner does not reinterpret it.
      return result.value as AgentMuxRpcResult<M>
    },
    async subscribe<M extends AgentMuxRpcStreamMethod>(method: M, params: AgentMuxRpcStreamParams<M>, handlers: AgentMuxRpcSubscriptionOptions<M>): Promise<AgentMuxRpcSubscription> {
      const call = { method, params: params as Record<string, unknown> }; hostRouteScope(call, true)
      const requestId = mintObjectId()
      return await rpc.subscribe('route.watch', { routeId, adoptedRoute, requestId, call }, {
        ...(handlers.signal ? { signal: handlers.signal } : {}),
        onInitial: result => { check(result.observation, requestId); handlers.onInitial(result.value as AgentMuxRpcStreamInitial<M>) },
        onEvent: event => handlers.onEvent((event.type === 'route-event' ? event.event : event) as AgentMuxRpcStreamEvent<M>),
        ...(handlers.onEnd ? { onEnd: handlers.onEnd } : {}),
      })
    },
  }
}

/** B's exact child transport. Authority is supplied only by its original admission
 * owner; it is never accepted by route.call or another public business method. */
export function executionRouteRpc(gateway: import('./host-route-gateway.js').HostRouteGateway, adoptedRoute: AdoptedHostRoute,
  authorization: import('./host-route.js').HostRouteExecutionAuthorization,
  helper?: () => import('./host-route.js').HostRouteStatement['helper'], originalContext?: import('./public-rpc-service.js').AgentMuxRpcCallContext): RpcPort {
  let preparationSessionId: string | undefined
  const derived = () => ({ authorization, ...(helper?.() ? { helper: helper()! } : {}), ...(preparationSessionId ? { preparationSessionId } : {}) })
  return {
    async call<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, options = {}): Promise<AgentMuxRpcResult<M>> {
      const input = { routeId: '', adoptedRoute, requestId: mintObjectId(), call: { method, params: params as Record<string,unknown> } }
      const result = await gateway.call(input, { ...originalContext, ...options }, false, derived())
      if (authorization.scope.kind === 'preparation' && method === 'runtime.invoke') {
        const invocation = (params as AgentMuxRpcParams<'runtime.invoke'>).invocation
        if (invocation.method === 'resolveAgentCreationSessionId') {
          const resolved = decodeHostedValue((result.value as AgentMuxRpcResult<'runtime.invoke'>).value)
          if (typeof resolved !== 'string' || !resolved) throw new AgentMuxError('The original target did not confirm this CID Session.', 'HOST_ROUTE_TARGET_MISMATCH')
          preparationSessionId = resolved
        }
      }
      return result.value as AgentMuxRpcResult<M>
    },
    async subscribe<M extends AgentMuxRpcStreamMethod>(method: M, params: AgentMuxRpcStreamParams<M>, handlers: AgentMuxRpcSubscriptionOptions<M>): Promise<AgentMuxRpcSubscription> {
      const input = { routeId: '', adoptedRoute, requestId: mintObjectId(), call: { method, params: params as Record<string,unknown> } }
      const subscription = await gateway.watch(input, event => handlers.onEvent(event as AgentMuxRpcStreamEvent<M>), { ...originalContext, ...(handlers.signal ? { signal: handlers.signal } : {}) }, false, derived())
      try { handlers.onInitial(subscription.initial.value as AgentMuxRpcStreamInitial<M>); await subscription.start?.(); return { subscriptionId: mintObjectId(), dispose: async () => { await subscription.dispose() } } }
      catch (error) { await subscription.dispose(); throw error }
    },
  }
}
