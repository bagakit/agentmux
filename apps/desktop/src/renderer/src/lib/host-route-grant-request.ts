import { HOST_ROUTE_CALLS, HOST_ROUTE_INVOCATIONS, HOST_ROUTE_STREAMS, parseAdoptedHostRoute, parseHostRouteActor,
  parseHostRouteConfiguration, type AdoptedHostRoute, type HostRouteActor, type HostRouteGrant, type HostRouteIdentity } from '@agentmux/core/host-route'
import { configValuesEqual } from '../../../shared/config-edit'

export const ROUTE_DISCOVERY_SCOPES = ['route.edges', 'route.edge.inspect']
export const ROUTE_WORK_SCOPES = [...HOST_ROUTE_CALLS.filter(method => method !== 'runtime.invoke'),
  ...HOST_ROUTE_STREAMS, ...HOST_ROUTE_INVOCATIONS.map(method => `runtime.invoke/${method}`)]
export type HostRouteGrantRequest = { kind: 'host-route-access'; route: AdoptedHostRoute; actor: HostRouteActor; scopes: string[] }

/** Public identities and finite scopes only. This request grants no permission. */
export function parseHostRouteGrantRequest(value: unknown): HostRouteGrantRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Paste a public route access request.')
  const input = value as Record<string, unknown>
  if (input.kind !== 'host-route-access' || Object.keys(input).some(key => !['kind', 'route', 'actor', 'scopes'].includes(key))) throw Error('Use the original public route access request, without credentials or endpoints.')
  const route = parseAdoptedHostRoute(input.route), actor = parseHostRouteActor(input.actor)
  const grant = parseHostRouteConfiguration({ routes: [], grants: [{ id: 'request', delegator: route.source, actor,
    destination: route.hops.at(-1)!.target, scopes: input.scopes }] }).grants[0]!
  return { kind: 'host-route-access', route, actor, scopes: grant.scopes }
}
export function grantForRouteReceiver(request: HostRouteGrantRequest, identity: HostRouteIdentity, id: string): HostRouteGrant {
  const index = request.route.hops.findIndex(hop => configValuesEqual(hop.target, identity))
  if (index < 0) throw Error('This request does not pass through this original Core. Select the receiving device; no other policy was changed.')
  return { id, delegator: index === 0 ? request.route.source : request.route.hops[index - 1]!.target,
    actor: request.actor, destination: request.route.hops.at(-1)!.target, scopes: request.scopes }
}
