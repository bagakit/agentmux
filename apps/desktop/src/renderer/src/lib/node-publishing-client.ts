import type { DesktopNodePublishingPort } from '../../../shared/node-publishing'
import type { AgentMuxPreloadApi } from '../../../shared/contracts'
import { unwrapSessionInputOperationResult } from '../../../shared/session-input-result'

/** Keeps the original method/target/operation and transfers only this reader's cancellation. */
export function createRendererNodePublishing(preload: AgentMuxPreloadApi['nodePublishing']): DesktopNodePublishingPort {
  return { call: async (method, params, signal) => {
    return invoke(context => preload.call(method, params, context), signal)
  }, owner: async (target, method, params, signal) => {
    return invoke(context => preload.owner(target, method, params, context), signal)
  }, deviceLocation: (link, signal) => invoke(context => preload.deviceLocation(link, context), signal) }
}
type Cancellation = { onAbort: (cancel: () => void) => () => void }
async function invoke<T>(call: (context?: Cancellation) => Promise<import('../../../shared/contracts').SessionInputOperationResult<T>>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  try {
    const reply = await call(signal ? { onAbort: cancel => {
      if (signal.aborted) { cancel(); return () => {} }
      signal.addEventListener('abort', cancel, { once: true })
      return () => signal.removeEventListener('abort', cancel)
    } } : undefined)
    signal?.throwIfAborted()
    return unwrapSessionInputOperationResult(reply)
  } catch (cause) { signal?.throwIfAborted(); throw cause }
}
