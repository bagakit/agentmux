import { AgentMuxError, routedAgentMuxRpc } from '@agentmux/core'
import { parseHostRouteParams, parseHostRouteResult, type HostRouteParams, type HostRouteResults } from '@agentmux/core/host-route'
import { DESKTOP_HOST_ROUTE_METHODS, parseDesktopHostRouteTarget, type DesktopHostRouteMethod, type DesktopHostRouteTarget } from '../shared/host-routes'
import { callOriginalDesktopHost, subscribeOriginalDesktopHost, type DesktopRuntimeClient } from './desktop-host'

/** One explicit trusted App request over the original configured transport, never an RPC proxy. */
export function callDesktopHostRoute<M extends DesktopHostRouteMethod>(
  configuredClient: (hostId: string) => DesktopRuntimeClient, target: DesktopHostRouteTarget,
  method: M, input: HostRouteParams[M], signal?: AbortSignal
): Promise<HostRouteResults[M]>
export async function callDesktopHostRoute(
  configuredClient: (hostId: string) => DesktopRuntimeClient, target: DesktopHostRouteTarget,
  method: DesktopHostRouteMethod, input: HostRouteParams[DesktopHostRouteMethod], signal?: AbortSignal
): Promise<HostRouteResults[DesktopHostRouteMethod]> {
  if (!DESKTOP_HOST_ROUTE_METHODS.some(value => value === method)) throw new AgentMuxError('Unknown Desktop route settings method.', 'INVALID_CONTROL_REQUEST')
  const original = parseDesktopHostRouteTarget(target, method), params = parseHostRouteParams(method, input), client = configuredClient(original.hostId)
  const assertCurrent = () => {
    signal?.throwIfAborted()
    if (configuredClient(original.hostId) !== client) throw new AgentMuxError('The original route carrier changed. Retain this request and inspect the same owner before saving again.', 'RUNTIME_OWNER_MISMATCH')
  }
  assertCurrent()
  const context = signal ? { signal } : {}
  const { owner } = await callOriginalDesktopHost(client, 'runtime.owner.identity',
    original.via ? { expectedRuntimeId: original.via.adoptedRoute.source.runtimeId }
      : original.expectedRuntimeId === undefined ? {} : { expectedRuntimeId: original.expectedRuntimeId }, context)
  assertCurrent()
  const expectedCarrier = original.via?.adoptedRoute.source.runtimeId ?? original.expectedRuntimeId
  if (expectedCarrier !== undefined && owner.runtimeId !== expectedCarrier) throw new AgentMuxError('The route carrier reply belongs to another original Core.', 'RUNTIME_OWNER_MISMATCH')
  const fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
  const value = original.via
    ? await routedAgentMuxRpc({ call: (method, input, options) => callOriginalDesktopHost(client, method, input, options ?? {}, fence),
      subscribe: (method, input, handlers) => subscribeOriginalDesktopHost(client, method, input, handlers, fence) }, original.via.routeId, original.via.adoptedRoute).call(method, params, context)
    : await callOriginalDesktopHost(client, method, params, context, fence)
  assertCurrent()
  // Routed values share the original public result parser rather than trusting an untyped nested value.
  const result = parseHostRouteResult(method, value) as HostRouteResults[DesktopHostRouteMethod]
  const identity = 'settings' in result ? result.settings.identity : 'identity' in result ? result.identity : result
  if (identity.runtimeId !== (original.expectedRuntimeId ?? owner.runtimeId)) throw new AgentMuxError('The route settings reply belongs to another original Runtime. Retain the draft and request.', 'RUNTIME_OWNER_MISMATCH')
  return result
}
