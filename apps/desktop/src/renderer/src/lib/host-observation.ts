import type { HostConfig, SessionInputOperationResult } from '../../../shared/contracts'
import { unwrapSessionInputOperationResult } from '../../../shared/session-input-result'

/** Host reads carry cancellation across contextBridge through the original envelope. */
export function createRendererHostObservation<T>(read: (host: HostConfig, context?: { onAbort?: (cancel: () => void) => () => void }) => Promise<SessionInputOperationResult<T>>) {
  return async (host: HostConfig, context?: { signal?: AbortSignal }): Promise<T> => {
    const signal = context?.signal
    signal?.throwIfAborted()
    try {
      const result = await read(host, signal ? { onAbort: cancel => {
        if (signal.aborted) { cancel(); return () => {} }
        signal.addEventListener('abort', cancel, { once: true })
        return () => signal.removeEventListener('abort', cancel)
      } } : undefined)
      signal?.throwIfAborted()
      return unwrapSessionInputOperationResult(result)
    } catch (error) { signal?.throwIfAborted(); throw error }
  }
}

export function createRendererHostAgentResources(read: import('../../../shared/contracts').AgentMuxPreloadApi['hosts']['agentResources']) {
  return (host: HostConfig, kind: 'records' | 'running', expectedRuntimeId?: string, context?: { signal?: AbortSignal }) =>
    createRendererHostObservation((saved, cancellation) => read(saved, kind, expectedRuntimeId, cancellation))(host, context)
}
