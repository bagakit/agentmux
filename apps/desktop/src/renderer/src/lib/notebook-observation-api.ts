import { AgentMuxError, parseNoteContentObservation, parseNotebookObservationParams } from '@agentmux/core/notebook-observation'
import { parseNotebookGraphSnapshot, type NotebookObservationApi, type NotebookObservationPreloadApi } from '../../../shared/notebook-observation'
import { parseNotebookResolveParams, parseNotebookResolveResult } from '@agentmux/core/note-links'

/** Signals and their original cancellation reasons stay in the Renderer world. */
export function createRendererNotebookObservation(preload: NotebookObservationPreloadApi): NotebookObservationApi {
  async function read<T>(start: (requestId: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const requestId = crypto.randomUUID()
    const cancel = () => { void preload.cancelObservation(requestId).catch(() => {}) }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const result = await start(requestId)
      signal?.throwIfAborted()
      return result
    } catch (error) { signal?.throwIfAborted(); throw error }
    finally { signal?.removeEventListener('abort', cancel) }
  }
  return {
    resolve: async (params, options) => {
      const input = parseNotebookResolveParams(params)
      return parseNotebookResolveResult(await read(requestId => preload.resolve({ requestId, params: input }), options?.signal), input)
    },
    graph: async (params, options) => {
      const input = parseNotebookObservationParams(params)
      return parseNotebookGraphSnapshot(await read(requestId => preload.graph({ requestId, params: input }), options?.signal), input)
    },
    content: async (noteId, options) => {
      parseNotebookObservationParams({ noteId, content: true, ...(options?.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }) }, true)
      const result = parseNoteContentObservation(await read(requestId => preload.content({ requestId, noteId, ...(options?.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }) }), options?.signal))
      if (result.noteId !== noteId) throw new AgentMuxError('The original Note reader returned another Note.', 'CONTROL_PROTOCOL_ERROR')
      return result
    }
  }
}
