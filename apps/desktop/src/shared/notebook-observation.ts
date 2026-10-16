import { AgentMuxError, parseNotebookGraph, type NotebookGraph, type NotebookGraphParams, type NoteContentObservation } from '@agentmux/core/notebook-observation'
import { parseNotebookState, type NotebookState } from '@agentmux/core/notebook-catalog'
import type { NotebookResolveParams, NotebookResolveResult } from '@agentmux/core/note-links'

/** One observed directory and its derived saved-file graph. No mutable content owner lives here. */
export type NotebookGraphSnapshot = { catalog: NotebookState; graph: NotebookGraph }
export type NotebookObservationApi = {
  resolve(params: NotebookResolveParams, options?: { signal?: AbortSignal }): Promise<NotebookResolveResult>
  graph(params: NotebookGraphParams, options?: { signal?: AbortSignal }): Promise<NotebookGraphSnapshot>
  content(noteId: string, options?: { signal?: AbortSignal; maxBytes?: number }): Promise<NoteContentObservation>
}
export type NotebookGraphRequest = { requestId: string; params: NotebookGraphParams }
export type NotebookResolveRequest = { requestId: string; params: NotebookResolveParams }
export type NotebookContentRequest = { requestId: string; noteId: string; maxBytes?: number }
/** AbortSignal stays in Renderer; only exact request identities cross contextBridge/IPC. */
export type NotebookObservationPreloadApi = {
  resolve(input: NotebookResolveRequest): Promise<NotebookResolveResult>
  graph(input: NotebookGraphRequest): Promise<NotebookGraphSnapshot>
  content(input: NotebookContentRequest): Promise<NoteContentObservation>
  cancelObservation(requestId: string): Promise<void>
}
const protocol = (message: string): never => { throw new AgentMuxError(message, 'CONTROL_PROTOCOL_ERROR') }
const sameResource = (a: import('@agentmux/core/notebook-catalog').NoteResource, b: import('@agentmux/core/notebook-catalog').NoteResource) =>
  a.hostId === b.hostId && a.workspaceId === b.workspaceId && a.workspacePath === b.workspacePath && a.path === b.path
export function parseNotebookGraphSnapshot(value: unknown, params: NotebookGraphParams): NotebookGraphSnapshot {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['catalog', 'graph'].includes(key))) protocol('The original Note graph snapshot is invalid.')
    const input = value as NotebookGraphSnapshot, catalog = parseNotebookState(input.catalog), graph = parseNotebookGraph(input.graph, params)
    if (graph.catalogRevision !== catalog.revision) protocol('The Note graph and its directory do not belong to the same snapshot.')
    for (const page of Object.values(catalog.pages)) {
      if (!graph.observations.some(item => item.noteId === page.noteId && sameResource(item.resource, page.resource))) protocol('The graph omitted an original catalog resource.')
    }
    const sharedIds = new Set(graph.observations.filter(item => item.kind === 'shared-block' && item.status === 'read').map(item => item.noteId))
    for (const observation of graph.observations) {
      const page = catalog.pages[observation.noteId]
      if (page && sameResource(page.resource, observation.resource)) { continue }
      const duplicate = sharedIds.has(observation.noteId) && graph.duplicateNoteIds.includes(observation.noteId)
      if (observation.status !== 'read' || observation.kind !== 'shared-block' && !duplicate || observation.kind === 'shared-block' && observation.fileIdentity === undefined) protocol('The Note graph contains an unrelated original resource.')
    }
    return { catalog, graph }
  } catch (error) {
    if (error instanceof AgentMuxError && error.code === 'CONTROL_PROTOCOL_ERROR') throw error
    return protocol(error instanceof Error ? error.message : 'The original Note graph snapshot could not be confirmed.')
  }
}
/** Later saved bytes cannot be displayed as the body of an earlier graph observation. */
export function noteContentMatchesGraph(snapshot: NotebookGraphSnapshot, content: NoteContentObservation): boolean {
  if (content.status !== 'read') return false
  const observed = snapshot.graph.observations.find(item => item.noteId === content.noteId && sameResource(item.resource, content.resource))
  return Boolean(!snapshot.graph.duplicateNoteIds.includes(content.noteId) && observed?.status === 'read' && content.actualNoteId === content.noteId &&
    sameResource(observed.resource, content.resource) && observed.revision === content.revision && observed.kind === content.kind)
}
