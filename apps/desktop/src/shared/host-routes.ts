import { parseAdoptedHostRoute, type AdoptedHostRoute, type HostRouteParams, type HostRouteResults } from '@agentmux/core/host-route'
import type { SessionInputOperationResult } from './contracts'

export const DESKTOP_HOST_ROUTE_METHODS = ['route.identity', 'route.inspect', 'route.configure', 'route.edges', 'route.edge.inspect'] as const
export type DesktopHostRouteMethod = typeof DESKTOP_HOST_ROUTE_METHODS[number]
/** hostId selects the original configured carrier; a prefix never imports remote Hosts. */
export type DesktopHostRouteTarget = { hostId: string; expectedRuntimeId?: string; via?: { routeId: string; adoptedRoute: AdoptedHostRoute } }
export type DesktopHostRoutes = {
  call<M extends DesktopHostRouteMethod>(target: DesktopHostRouteTarget, method: M, params: HostRouteParams[M], signal?: AbortSignal): Promise<HostRouteResults[M]>
}
export type PreloadHostRoutes = {
  call<M extends DesktopHostRouteMethod>(target: DesktopHostRouteTarget, method: M, params: HostRouteParams[M], context?: { onAbort?: (cancel: () => void) => () => void }): Promise<SessionInputOperationResult<HostRouteResults[M]>>
}
const invalid: () => never = () => { throw Object.assign(new Error('Select the exact original route owner. A saved prefix permits only explicit edge discovery.'), { code: 'INVALID_CONTROL_REQUEST' }) }
const id = (value: unknown): string => typeof value === 'string' && !!value && !/[\0\r\n]/u.test(value) ? value : invalid()
export function parseDesktopHostRouteTarget(value: unknown, method: DesktopHostRouteMethod): DesktopHostRouteTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['hostId', 'expectedRuntimeId', 'via'].includes(key))) invalid()
  const hostId = id(input.hostId), expectedRuntimeId = input.expectedRuntimeId === undefined ? undefined : id(input.expectedRuntimeId)
  if (expectedRuntimeId === undefined && (method !== 'route.identity' || input.via !== undefined)) invalid()
  if (input.via === undefined) return { hostId, ...(expectedRuntimeId === undefined ? {} : { expectedRuntimeId }) }
  if (expectedRuntimeId === undefined) invalid()
  if (method !== 'route.edges' && method !== 'route.edge.inspect' || !input.via || typeof input.via !== 'object' || Array.isArray(input.via)) invalid()
  const via = input.via as Record<string, unknown>
  if (Object.keys(via).some(key => key !== 'routeId' && key !== 'adoptedRoute')) invalid()
  const adoptedRoute = parseAdoptedHostRoute(via.adoptedRoute)
  if (adoptedRoute.hops.at(-1)!.target.runtimeId !== expectedRuntimeId) invalid()
  return { hostId, expectedRuntimeId, via: { routeId: id(via.routeId), adoptedRoute } }
}
