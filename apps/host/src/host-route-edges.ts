import { AgentMuxError, hostRouteTransport, type AgentMuxClient, type HostRouteTransport } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'

/** Borrow only the Host's saved public transports; a route never supplies endpoint/credentials. */
export function configuredRouteEdge(clients: (hostId?: string) => readonly { hostId: string; client: AgentMuxClient | AgentMuxHostedClient }[], edgeId: string): HostRouteTransport {
  const matching = clients(edgeId).filter(item => item.hostId === edgeId)
  const client = matching.length === 1 ? matching[0]!.client : undefined
  if (!client || !('forwardRpc' in client) || !client.forwardRpc || !('subscribeRpc' in client) || !client.subscribeRpc)
    throw new AgentMuxError('This exact configured route edge is unavailable or ambiguous. Retain the adopted route; no direct or alternate Host was selected.', 'HOST_ROUTE_EDGE_UNAVAILABLE')
  const call = client.forwardRpc, subscribe = client.subscribeRpc
  return hostRouteTransport({
    call: (method, params, options) => call(method, params, options?.signal ? { signal: options.signal } : {}),
    subscribe: (method, params, handlers) => subscribe(method, params, handlers),
  })
}
