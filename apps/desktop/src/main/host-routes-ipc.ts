import type { IpcMainInvokeEvent } from 'electron'
import { parseHostRouteParams, type HostRouteParams, type HostRouteResults } from '@agentmux/core/host-route'
import { DESKTOP_HOST_ROUTE_METHODS, parseDesktopHostRouteTarget, type DesktopHostRouteMethod, type DesktopHostRouteTarget } from '../shared/host-routes'
import { SessionHistoryReadOwners } from './session-history-read'
import { sessionInputOperationResult } from '../shared/session-input-result'

export function registerHostRoutesIpc(ports: {
  handle<T extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...values: T) => R | Promise<R>): void
  call<M extends DesktopHostRouteMethod>(target: DesktopHostRouteTarget, method: M, params: HostRouteParams[M], signal: AbortSignal): Promise<HostRouteResults[M]>
}) {
  const reads = new SessionHistoryReadOwners()
  ports.handle('hostRoutes:call', (event, token: string, target: unknown, method: unknown, input: unknown) => sessionInputOperationResult(() => {
    if (!DESKTOP_HOST_ROUTE_METHODS.some(value => value === method)) throw Object.assign(new Error('Unknown Desktop route settings method.'), { code: 'INVALID_CONTROL_REQUEST' })
    const originalMethod = method as DesktopHostRouteMethod, original = parseDesktopHostRouteTarget(target, originalMethod), params = parseHostRouteParams(originalMethod, input)
    return reads.read(event.sender, token, signal => ports.call(original, originalMethod, params, signal))
  }))
  ports.handle('hostRoutes:cancel', (event, token: string) => reads.cancel(event.sender.id, token))
  return { dispose: () => reads.dispose() }
}
