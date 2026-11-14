import type { DesktopHostRoutes, PreloadHostRoutes } from '../../../shared/host-routes'
import { unwrapSessionInputOperationResult } from '../../../shared/session-input-result'

export function createRendererHostRoutes(preload: PreloadHostRoutes): DesktopHostRoutes {
  return { call: async (target, method, params, signal) => {
    signal?.throwIfAborted()
    const result = await preload.call(target, method, params, signal ? { onAbort: cancel => {
      if (signal.aborted) { cancel(); return () => {} }
      signal.addEventListener('abort', cancel, { once: true })
      return () => signal.removeEventListener('abort', cancel)
    } } : undefined)
    signal?.throwIfAborted()
    return unwrapSessionInputOperationResult(result)
  } }
}
