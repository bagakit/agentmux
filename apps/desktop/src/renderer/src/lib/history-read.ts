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

/** Usage shares the original cancellable history-read owner and failure envelope. */
export function createRendererUsageRead(read: AgentMuxPreloadApi['sessions']['readUsage']): AgentMuxDesktopApi['sessions']['readUsage'] {
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
      return unwrapSessionInputOperationResult(result)
    } catch (error) { signal?.throwIfAborted(); throw error }
  }
}

/** Record operations share the existing exact IPC request lifetime, without replaying a failed write. */
function recordOperation<Input, Output>(invoke: (reference: import('../../../shared/contracts').SessionHistoryReference, input: Input,
  context?: { onAbort?: (cancel: () => void) => () => void }) => Promise<import('../../../shared/contracts').SessionInputOperationResult<Output>>) {
  return async (reference: import('../../../shared/contracts').SessionHistoryReference, input: Input, context?: { signal?: AbortSignal }): Promise<Output> => {
    const signal = context?.signal
    signal?.throwIfAborted()
    try {
      const result = await invoke(reference, input, signal ? { onAbort: cancel => {
        if (signal.aborted) { cancel(); return () => {} }
        signal.addEventListener('abort', cancel, { once: true })
        return () => signal.removeEventListener('abort', cancel)
      } } : undefined)
      signal?.throwIfAborted()
      return unwrapSessionInputOperationResult(result)
    } catch (error) { signal?.throwIfAborted(); throw error }
  }
}
export function createRendererRecordInspect(read: AgentMuxPreloadApi['sessions']['inspectRecord']): AgentMuxDesktopApi['sessions']['inspectRecord'] { return recordOperation(read) }
export function createRendererRecordDelete(write: AgentMuxPreloadApi['sessions']['deleteRecord']): AgentMuxDesktopApi['sessions']['deleteRecord'] { return recordOperation(write) }
