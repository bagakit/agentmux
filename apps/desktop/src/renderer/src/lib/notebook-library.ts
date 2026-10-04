import { create } from 'zustand'
import { type NotebookChange, type NotebookState, type NoteSource, type NotebookPage, type NoteResource } from '@agentmux/core/notebook-catalog'
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
  // Reading and writing have distinct receipts. A lost write reply does not turn a confirmed
  // directory into an unreadable one; the caller retains its own exact operation and recovery.
  const original = await refreshNotebookLibrary()
  const state = await api.notebooks.apply({ expectedRevision: original.revision, operationId, change })
  useNotebookLibrary.setState({ state, issue: null }); return state
}
export type NoteNotebookContext = { notebookId?: string; parentNoteId?: string | null; source?: NoteSource }
export function notebookPageResourceMatches(page: NotebookPage, config: { workspaces: { id: string; hostId: string; path: string }[] } | null): boolean {
  const workspace = config?.workspaces.find(item => item.id === page.resource.workspaceId)
  return workspace?.hostId === page.resource.hostId && workspace.path === page.resource.workspacePath
}

/** Recovery intents for confirmed original-owner changes, never a second knowledge catalog. */
export type NotebookRecovery = { operationId: string; change: Extract<NotebookChange, { kind: 'organize' | 'relocate' }> }
export function restoreNotebookRecoveries(value: unknown): NotebookRecovery[] {
  // Keep unknown/corrupt intent bytes visible rather than silently dropping them. The original
  // Core parser validates every write at retry, while unrelated editing stays available.
  return Array.isArray(value) ? value as NotebookRecovery[] : []
}
export function notebookRelocations(state: NotebookState, workspace: { id: string; hostId: string; path: string }, from: string, to: string): NotebookRecovery['change'][] {
  return Object.values(state.pages).filter(page => page.resource.hostId === workspace.hostId && page.resource.workspaceId === workspace.id && page.resource.workspacePath === workspace.path &&
    (page.resource.path === from || page.resource.path.startsWith(from + '/'))).map(page => ({ kind: 'relocate', noteId: page.noteId, from: page.resource,
      resource: { ...page.resource, path: to + page.resource.path.slice(from.length) } }))
}
let recovering: Promise<void> | null = null
export async function retryNotebookRecoveries(): Promise<void> {
  if (recovering) return recovering
  recovering = (async () => {
    const { useAppStore } = await import('../store')
    while (useAppStore.getState().notebookRecoveries.length) {
      const original = useAppStore.getState().notebookRecoveries[0]!
      await changeNotebook(original.change, original.operationId)
      useAppStore.setState(state => ({ notebookRecoveries: state.notebookRecoveries.filter(item => item.operationId !== original.operationId) }))
    }
  })().finally(() => { recovering = null })
  return recovering
}
/** Only call after the File/position owner confirms the underlying operation. */
export async function recordNotebookChanges(changes: NotebookRecovery['change'][], operationId: string): Promise<void> {
  if (!changes.length) return
  const { useAppStore } = await import('../store')
  const held = changes.map(change => ({ change, operationId: operationId + ':' + change.noteId }))
  useAppStore.setState(state => ({ notebookRecoveries: [...state.notebookRecoveries, ...held.filter(item => !state.notebookRecoveries.some(old => old.operationId === item.operationId))] }))
  await retryNotebookRecoveries()
}
export function sameNoteResource(a: NoteResource, b: NoteResource): boolean {
  return a.hostId === b.hostId && a.workspaceId === b.workspaceId && a.workspacePath === b.workspacePath && a.path === b.path
}
