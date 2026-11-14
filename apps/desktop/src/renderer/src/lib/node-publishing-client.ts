import type { NodePublishingPort } from '@agentmux/core/node-publishing'
import type { AgentMuxPreloadApi } from '../../../shared/contracts'
import { unwrapSessionInputOperationResult } from '../../../shared/session-input-result'

/** Keeps the original method/target/operation and transfers only this reader's cancellation. */
export function createRendererNodePublishing(preload: AgentMuxPreloadApi['nodePublishing']): NodePublishingPort {
  return { call: async (method, params, signal) => {
    signal?.throwIfAborted()
    try {
      const reply = await preload.call(method, params, signal ? { onAbort: cancel => {
        if (signal.aborted) { cancel(); return () => {} }
        signal.addEventListener('abort', cancel, { once: true })
        return () => signal.removeEventListener('abort', cancel)
      } } : undefined)
      signal?.throwIfAborted()
      return unwrapSessionInputOperationResult(reply)
    } catch (cause) { signal?.throwIfAborted(); throw cause }
  } }
}
