import { DEFAULT_NOTEBOOK_ID, type NotebookPage, type NotebookState, type NoteResource } from '@agentmux/core/notebook-catalog'
import { recallDailyDate } from '@agentmux/core/notebook-observation'
import { mintObjectId } from '@agentmux/core/object-id'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NOTES_WORKSPACE_ID } from '@agentmux/host/notes-library'
import { useAppStore } from '../store'
import { api } from './api'
import { noteResourceReadParams } from './note-history-target'
import { changeNotebook, refreshNotebookLibrary, sameNoteResource } from './notebook-library'
import { scratchTopicsForConfig } from './scratch-topic-snapshots'

export function recallDailyAddress(now = new Date()) {
  const day = recallDailyDate(now)
  return { noteId: 'daily-' + day, path: 'Daily-' + day + '.note.md', title: 'Daily · ' + day }
}

export function newRecallDailyResource(path: string): NoteResource {
  const workspace = useAppStore.getState().config?.workspaces.find(item => item.id === NOTES_WORKSPACE_ID)
  if (!workspace) throw new Error('The default Notes library is unavailable. Reconnect it to create today’s Daily.')
  return { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path }
}

export function registerRecallDaily(catalog: NotebookState, noteId: string, title: string, resource: NoteResource, zoneId: string) {
  return catalog.pages[noteId] ? Promise.resolve(catalog)
    : changeNotebook({ kind: 'register', noteId, title, notebookId: DEFAULT_NOTEBOOK_ID, resource,
      workface: { zoneId, workspaceId: resource.workspaceId } }, 'recall-daily:' + noteId)
}

/** A check can finish registering the original file. It never issues a second create. */
export async function createRecallDaily(now = new Date(), action: 'create' | 'check' = 'create'): Promise<NotebookPage | null> {
  const daily = recallDailyAddress(now), catalog = await refreshNotebookLibrary()
  const existing = catalog.pages[daily.noteId]
  if (existing) return existing

  const resource = newRecallDailyResource(daily.path), state = useAppStore.getState()
  const topics = scratchTopicsForConfig(state.config, state.scratchTopicSnapshots) ?? []
  const scope = noteResourceReadParams(state, topics, resource)
  const original = await api.files.readPublic(scope)
  if (!original.resource || !sameNoteResource(resource, original.resource)) throw new Error('The original Daily file location could not be confirmed.')
  if (original.result.status === 'read') {
    const parsed = readNoteDocument(original.result.document.content)
    if (parsed.status !== 'valid' || parsed.note.noteId !== daily.noteId) throw new Error('The Daily address is occupied by another document.')
  } else if (original.result.status === 'deleted') {
    if (action === 'check') return null
    const content = serializeNoteDocument(newNoteDocument('', daily.noteId, mintObjectId(), daily.title))
    const saved = await api.files.createPublic({ ...scope, expectedResource: original.resource, expectedRevision: null, content })
    if (saved.result.status === 'error') throw new Error(saved.result.message)
    if (saved.result.status !== 'written' || !saved.resource || !sameNoteResource(resource, saved.resource)) {
      throw new Error('The original Daily could not be confirmed.')
    }
  } else {
    throw new Error(original.result.status === 'error' || original.result.status === 'unknown'
      ? original.result.message : 'The Daily address is occupied by a non-Note resource.')
  }
  const confirmed = await registerRecallDaily(await refreshNotebookLibrary(), daily.noteId, daily.title, resource, scope.zoneId)
  const page = confirmed.pages[daily.noteId]
  if (!page || !sameNoteResource(page.resource, resource)) throw new Error('The original Daily’s Notebook entry could not be confirmed.')
  return page
}
