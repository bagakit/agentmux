import type { SpaceMountPreloadApi, SpaceMountPort, SpaceMountMemberRoute, SpaceMountMemberSurface } from '../../../shared/space-mount'
import { unwrapSessionInputOperationResult } from '../../../shared/session-input-result'

const cancellation = (signal?: AbortSignal) => signal ? { onAbort: (cancel: () => void) => {
  if (signal.aborted) { cancel(); return () => {} }
  signal.addEventListener('abort', cancel, { once: true }); return () => signal.removeEventListener('abort', cancel)
} } : undefined
export function createRendererSpaceMount(preload: SpaceMountPreloadApi): SpaceMountPort {
  const member = async (input: SpaceMountMemberRoute, listener: Parameters<SpaceMountPort['member']>[1], signal?: AbortSignal): Promise<SpaceMountMemberSurface> => {
    signal?.throwIfAborted()
    const result = unwrapSessionInputOperationResult(await preload.member(input, listener, cancellation(signal)))
    try {
      signal?.throwIfAborted()
      return { initial: result.initial, dispose: result.dispose, call: async (method, input, requestSignal) => {
        requestSignal?.throwIfAborted()
        const reply = await result.call(method, input, cancellation(requestSignal))
        requestSignal?.throwIfAborted()
        return reply
      } }
    } catch (error) { await result.dispose(); throw error }
  }
  return {
    member,
    reading: member,
    call: async (method, input, signal) => {
      signal?.throwIfAborted()
      const result = await preload.call(method, input, cancellation(signal))
      if (method !== 'register' && method !== 'close') signal?.throwIfAborted() // Preserve obtained original effect receipts.
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
