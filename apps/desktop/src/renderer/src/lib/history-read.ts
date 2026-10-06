import type { AgentMuxDesktopApi, AgentMuxPreloadApi } from '../../../shared/contracts'
import { unwrapSessionInputOperationResult } from '../../../shared/session-input-result'

/** Cancellation crosses contextBridge as a function; its AbortSignal remains local. */
export function createRendererHistoryRead(read: AgentMuxPreloadApi['sessions']['readHistory']): AgentMuxDesktopApi['sessions']['readHistory'] {
  return async (reference, options, context) => {
    const signal = context?.signal
    signal?.throwIfAborted()
    try {
      const result = await read(reference, options, signal ? { onAbort: cancel => {
        if (signal.aborted) { cancel(); return () => {} }
        signal.addEventListener('abort', cancel, { once: true })
        return () => signal.removeEventListener('abort', cancel)
      } } : undefined)
      signal?.throwIfAborted()
      // Reuse the existing generic IPC result envelope so code/detail survive Electron's Error copy.
      return unwrapSessionInputOperationResult(result)
    } catch (error) { signal?.throwIfAborted(); throw error }
  }
}
