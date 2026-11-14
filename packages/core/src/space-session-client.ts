import { AgentMuxError } from './errors.js'
import { connectHostedAgentMux } from './hosted-client.js'
import { executionRouteRpc } from './host-route-rpc.js'
import type { HostRouteGateway } from './host-route-gateway.js'
import type { AgentMuxHostedRuntimeService } from './hosted-runtime-service.js'
import type { AgentMuxHostedRpcPort, AgentMuxHostedStreamEvent } from './hosted-client-contract.js'
import type { AgentMuxRpcClient } from './public-rpc-client.js'
import type { AgentMuxRpcCoreClient, AgentMuxRpcCallContext } from './public-rpc-service.js'
import type { SpaceSessionSource } from './space-session-owner.js'
import type { SpaceAuthoritySource } from './space-authority.js'
import type { AgentMuxClientEvent } from './types.js'

/** Borrow only original transports. This reader cannot turn an inbound device or
 * delegated actor into the user authenticated by another saved SSH connection. */
export function createSpaceSessionObserver(ports: {
  local: Pick<AgentMuxHostedRuntimeService, 'call' | 'subscribe'>
  clients(hostId: string): Promise<readonly AgentMuxRpcCoreClient[]>
  context: AgentMuxRpcCallContext
  reference: import('./space-authority.js').SpaceAuthorityRef
  gateway?: HostRouteGateway
}) {
  return async (group: { hostId: string; runtimeId: string; agentSessionIds: string[]; adoptedRoute?: SpaceSessionSource['adoptedRoute'] },
    event: (authority: SpaceAuthoritySource, value: AgentMuxClientEvent) => void, signal: AbortSignal) => {
    signal.throwIfAborted()
    const context = { ...ports.context, signal }
    let rpc: AgentMuxHostedRpcPort
    if (group.adoptedRoute) {
      if (!ports.gateway) throw new AgentMuxError('This original Space has no composed verified route reader.', 'HOST_ROUTE_AUTHORIZATION_REQUIRED')
      const authorization = await ports.gateway.authorizeObservation({ kind: 'observation', targetRuntimeId: group.runtimeId,
        agentSessionIds: group.agentSessionIds, source: { kind: 'space-reader', runtimeId: ports.reference.runtimeId, spaceId: ports.reference.spaceId } }, context)
      rpc = executionRouteRpc(ports.gateway, group.adoptedRoute, authorization, undefined, context)
    }
    else if (group.hostId === 'local') rpc = {
      call: async (method: string, params: unknown) => await ports.local.call(method, params, context),
      subscribe: async (method: string, params: unknown, handlers: { onInitial(value: unknown): void; onEvent(value: AgentMuxHostedStreamEvent): void; signal?: AbortSignal }) => {
        const watch = await ports.local.subscribe(method, params, value => handlers.onEvent(value), context)
        try { handlers.onInitial(watch.initial); await watch.start?.(); return { dispose: watch.dispose } }
        catch (error) { await watch.dispose(); throw error }
      }
    } as AgentMuxHostedRpcPort
    else {
      if (context.routeDelegation || context.principal?.kind !== 'user' || context.caller) throw new AgentMuxError(
        'This foreign Session read needs its original verified route and receiver grant. The Space member and existing controls are retained.', 'HOST_ROUTE_AUTHORIZATION_REQUIRED')
      const matches = (await ports.clients(group.hostId)).filter(entry => entry.hostId === group.hostId)
      if (matches.length !== 1) throw new AgentMuxError('The original Session carrier is unavailable or ambiguous.', 'UNKNOWN_HOST')
      const original = matches[0]!.client
      if (!original.forwardRpc || !original.subscribeRpc) throw new AgentMuxError('The original Session carrier has no public scoped observation transport.', 'RUNTIME_UNAVAILABLE')
      const borrowed: Pick<AgentMuxRpcClient, 'call' | 'subscribe'> = {
        call: (method, params) => original.forwardRpc!(method, params, context),
        subscribe: (method, params, handlers) => original.subscribeRpc!(method, params, { ...handlers, signal })
      }
      rpc = borrowed
    }
    const client = await connectHostedAgentMux({ rpc, connectOnDemand: true, sessions: 'summary', agentSessionIds: group.agentSessionIds, expectedRuntimeId: group.runtimeId })
    const dispose = client.dispose.bind(client)
    const unlisten = client.onEvent(value => {
      const owner = client.runtimeOwnerIdentity()
      if (owner && !signal.aborted) event({ runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }, value)
    }, { observeMessages: false })
    client.dispose = async () => { signal.removeEventListener('abort', abort); unlisten(); await dispose() }
    const abort = () => { void client.dispose().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try { signal.throwIfAborted(); await client.connect(); signal.throwIfAborted(); return client }
    catch (error) { await client.dispose().catch(() => {}); throw error }
  }
}
