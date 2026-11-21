import type { DesktopMeshNetworkPort, MeshNetworkPreloadPort } from '../../../shared/mesh-network'
import { unwrapSessionInputOperationResult } from '../../../shared/session-input-result'

/** Preserve exact input and owner; cancellation releases this observer, never replays a save. */
export function createRendererMeshNetwork(preload: MeshNetworkPreloadPort): DesktopMeshNetworkPort {
  return { call: async (method, params, options = {}) => {
    const { signal, expectedOwner, separateRuntimeId } = options
    signal?.throwIfAborted()
    if (!preload) throw new Error('Mesh requires the original connected Desktop Core. Your draft and existing work are retained.')
    try {
      const result = await preload.call(method, params, {
        ...(expectedOwner ? { expectedOwner } : {}),
        ...(separateRuntimeId ? { separateRuntimeId } : {}),
        ...(signal ? { onAbort: (cancel: () => void) => {
          if (signal.aborted) { cancel(); return () => {} }
          signal.addEventListener('abort', cancel, { once: true })
          return () => signal.removeEventListener('abort', cancel)
        } } : {})
      })
      signal?.throwIfAborted()
      return unwrapSessionInputOperationResult(result)
    } catch (cause) { signal?.throwIfAborted(); throw cause }
  } }
}
