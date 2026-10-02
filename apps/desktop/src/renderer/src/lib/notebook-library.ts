import { create } from 'zustand'
import { type NotebookChange, type NotebookState, type NoteSource, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { api } from './api'
import { presentError } from '@agentmux/client-ui/error-presentation'
/** Read model of the original Core catalog. It owns no persistence or Note lifecycle. */
export const useNotebookLibrary = create<{ state: NotebookState | null; issue: string | null }>(() => ({ state: null, issue: null }))
export async function refreshNotebookLibrary(): Promise<NotebookState> {
  try { const state = await api.notebooks.read(); useNotebookLibrary.setState({ state, issue: null }); return state }
  catch (error) { useNotebookLibrary.setState({ issue: presentError(error) }); throw error }
}
export function observeNotebookLibrary(): () => void {
  void refreshNotebookLibrary().catch(() => {})
  if (!api.notebooks) { useNotebookLibrary.setState({ issue: 'Notebook service is unavailable. Existing pages and browsing are kept; refresh the directory when it reconnects.' }); return () => {} }
  return api.notebooks.onChange(event => {
    if ('state' in event) useNotebookLibrary.setState({ state: event.state, issue: null })
    else useNotebookLibrary.setState({ issue: event.issue })
  })
}
export async function changeNotebook(change: NotebookChange, operationId: string = crypto.randomUUID()): Promise<NotebookState> {
  try {
    const original = await api.notebooks.read()
    const state = await api.notebooks.apply({ expectedRevision: original.revision, operationId, change })
    useNotebookLibrary.setState({ state, issue: null }); return state
  } catch (error) { useNotebookLibrary.setState({ issue: presentError(error) }); throw error }
}
export type NoteNotebookContext = { notebookId?: string; parentNoteId?: string | null; source?: NoteSource }
export function notebookPageResourceMatches(page: NotebookPage, config: { workspaces: { id: string; hostId: string; path: string }[] } | null): boolean {
  const workspace = config?.workspaces.find(item => item.id === page.resource.workspaceId)
  return workspace?.hostId === page.resource.hostId && workspace.path === page.resource.workspacePath
}
