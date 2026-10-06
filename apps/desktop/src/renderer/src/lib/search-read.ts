import { readAgentMuxSearch } from '@agentmux/core/search'
import type { AgentMuxDesktopApi, AgentMuxPreloadApi } from '../../../shared/contracts'
import { unwrapSessionInputOperationResult } from '../../../shared/session-input-result'

/** Only transport lifetime crosses contextBridge; Core owns scope, paging and budget recovery. */
export function createRendererSearchRead(read: AgentMuxPreloadApi['search']['query']): AgentMuxDesktopApi['search']['query'] {
  return (input, context) => readAgentMuxSearch(input, async value => {
    const signal = context?.signal
    signal?.throwIfAborted()
    try {
      const result = await read(value, signal ? { onAbort: cancel => {
        if (signal.aborted) { cancel(); return () => {} }
        signal.addEventListener('abort', cancel, { once: true })
        return () => signal.removeEventListener('abort', cancel)
      } } : undefined)
      signal?.throwIfAborted()
      return unwrapSessionInputOperationResult(result)
    } catch (error) { signal?.throwIfAborted(); throw error }
  }, context)
}
