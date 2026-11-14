import type { SourceFilesApi, SourceFilesPreloadApi } from '../../../shared/source-files-client.js'
import { unwrapSessionInputOperationResult } from '../../../shared/session-input-result.js'

const cancellation = (signal?: AbortSignal) => signal ? { onAbort: (cancel: () => void) => {
  if (signal.aborted) { cancel(); return () => {} }
  signal.addEventListener('abort', cancel, { once: true }); return () => signal.removeEventListener('abort', cancel)
} } : undefined
export function createRendererSourceFiles(preload: SourceFilesPreloadApi): SourceFilesApi {
  return {
    resolve: async (target, selection, signal) => {
      signal?.throwIfAborted()
      const result = await preload.resolve(target, selection, cancellation(signal)); signal?.throwIfAborted()
      return unwrapSessionInputOperationResult(result)
    },
    call: async (target, method, params, signal) => {
      signal?.throwIfAborted()
      // Preserve a result already returned for the original request even when a
      // later UI cancellation has made its presentation ineligible.
      return unwrapSessionInputOperationResult(await preload.call(target, method, params, cancellation(signal)))
    },
    watch: async (target, params, listener, signal) => {
      signal?.throwIfAborted()
      const reader = unwrapSessionInputOperationResult(await preload.watch(target, params, listener, cancellation(signal)))
      try { signal?.throwIfAborted(); return reader } catch (cause) { reader.dispose(); throw cause }
    }
  }
}
