import type { NotebookObservationPreloadApi } from '../shared/notebook-observation.js'
/** The original preload transports data; no Signal or parser is copied across worlds. */
export function createPreloadNotebookObservation(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): NotebookObservationPreloadApi {
  return {
    resolve: input => invoke('notebook:resolve', input) as ReturnType<NotebookObservationPreloadApi['resolve']>,
    graph: input => invoke('notebook:graph', input) as ReturnType<NotebookObservationPreloadApi['graph']>,
    content: input => invoke('notebook:content', input) as ReturnType<NotebookObservationPreloadApi['content']>,
    cancelObservation: async requestId => { await invoke('notebook:cancelObservation', requestId) }
  }
}
