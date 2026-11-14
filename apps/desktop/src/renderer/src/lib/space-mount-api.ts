import type { SpaceMountPreloadApi, SpaceMountPort } from '../../../shared/space-mount'
import { unwrapSessionInputOperationResult } from '../../../shared/session-input-result'

const cancellation = (signal?: AbortSignal) => signal ? { onAbort: (cancel: () => void) => {
  if (signal.aborted) { cancel(); return () => {} }
  signal.addEventListener('abort', cancel, { once: true }); return () => signal.removeEventListener('abort', cancel)
} } : undefined
export function createRendererSpaceMount(preload: SpaceMountPreloadApi): SpaceMountPort {
  return {
    member: async (input, listener, signal) => {
      signal?.throwIfAborted()
      const result = unwrapSessionInputOperationResult(await preload.member(input, listener, cancellation(signal)))
      try { signal?.throwIfAborted(); return result } catch (error) { await result.dispose(); throw error }
    },
    call: async (method, input, signal) => {
      signal?.throwIfAborted()
      const result = await preload.call(method, input, cancellation(signal)); signal?.throwIfAborted()
      return unwrapSessionInputOperationResult(result)
    },
    sessions: async (input, listener, signal) => {
      signal?.throwIfAborted()
      const result = unwrapSessionInputOperationResult(await preload.sessions(input, listener, cancellation(signal)))
      try { signal?.throwIfAborted(); return result } catch (error) { result.dispose(); throw error }
    },
    watch: async (input, listener, signal) => {
      signal?.throwIfAborted()
      const result = unwrapSessionInputOperationResult(await preload.watch(input, listener, cancellation(signal)))
      try { signal?.throwIfAborted(); return result } catch (error) { result.dispose(); throw error }
    }
  }
}
