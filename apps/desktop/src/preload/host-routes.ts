import type { IpcRenderer } from 'electron'
import { mintObjectId } from '@agentmux/identity'
import { deliveryFailure } from '@agentmux/core/delivery-attempt'
import type { PreloadHostRoutes } from '../shared/host-routes'

/** Preserve the public failure envelope across contextBridge; an unknown IPC reply never retries a save. */
export function createPreloadHostRoutes(ipc: Pick<IpcRenderer, 'invoke'>): PreloadHostRoutes {
  return { call: async (target, method, params, context) => {
    const token = mintObjectId(), pending = ipc.invoke('hostRoutes:call', token, target, method, params)
    const release = context?.onAbort?.(() => { void ipc.invoke('hostRoutes:cancel', token).catch(() => {}) })
    try { return await pending }
    catch (cause) {
      const failure = deliveryFailure(cause)
      return { ok: false, error: { ...failure, code: failure.code ?? 'HOST_ROUTE_REPLY_UNCONFIRMED', controlFailure: failure.controlFailure ?? { disposition: 'unknown', confirmedInputBytes: null } } }
    }
    finally { release?.() }
  } }
}
