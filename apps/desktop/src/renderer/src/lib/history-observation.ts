import type { AgentMuxDesktopApi, AgentMuxPreloadApi } from '../../../shared/contracts'

/** AbortSignal stays in its Renderer world; only subscription functions cross contextBridge. */
export function createRendererHistoryObservation(
  observe: AgentMuxPreloadApi['sessions']['observeHistory']
): AgentMuxDesktopApi['sessions']['observeHistory'] {
  return async (session, listener, options) => {
    const signal = options?.signal
    signal?.throwIfAborted()
    try {
      const handle = await observe(session, listener, signal ? {
        onAbort: abort => {
          if (signal.aborted) { abort(); return () => {} }
          signal.addEventListener('abort', abort, { once: true })
          return () => signal.removeEventListener('abort', abort)
        }
      } : undefined)
      if (signal?.aborted) {
        handle.dispose()
        signal.throwIfAborted()
      }
      return handle
    } catch (error) {
      // Bridge errors are copied; cancellation still carries its original local reason.
      signal?.throwIfAborted()
      throw error
    }
  }
}
