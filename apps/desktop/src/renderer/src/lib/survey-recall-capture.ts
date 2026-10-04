import type { NoteSource } from '@agentmux/core/notebook-catalog'
import { NOTES_WORKSPACE_ID } from '../../../shared/notes-library'
import { newNoteDocument, readNoteDocument } from '../../../shared/note-document'
import { registerCreatedNote, useAppStore } from '../store'
import { api } from './api'
import { useLauncherState } from './launcher-state'
import { refreshNotebookLibrary } from './notebook-library'
import type { NoteCreationReceipt } from './note-creation'
import { noteCreationResourceMatches } from './note-creation'
import { createNoteWithAvailableName } from './note-names'
import { prepareNotebookWorkface } from './recall-notebooks'
import { presentError } from '@agentmux/client-ui/error-presentation'

export type SurveyRecallCapture = { draftId: string; source: NoteSource }
const pending = new Map<string, Promise<NoteCreationReceipt>>()

/** Capture through the original file and Notebook owners, without navigating the browser. */
export function saveSurveyToRecall(target: SurveyRecallCapture, notebookId: string, draft: string): Promise<NoteCreationReceipt> {
  const existing = pending.get(target.draftId)
  if (existing) return existing
  const saving = save(target, notebookId, draft).finally(() => pending.delete(target.draftId))
  pending.set(target.draftId, saving)
  return saving
}

async function save(target: SurveyRecallCapture, notebookId: string, draft: string): Promise<NoteCreationReceipt> {
  let receipt = useLauncherState.getState().drafts[target.draftId]?.noteCreation
  const publish = () => useLauncherState.getState().setNoteCreation(target.draftId, receipt!)
  const resourceCurrent = () => noteCreationResourceMatches(useAppStore.getState().config, receipt!.target)
  if (receipt) {
    // A retained operation owns its original source and destination even after the form changes.
    if (!resourceCurrent()) { receipt = { ...receipt, issue: 'The original Notes folder is unavailable. Reconnect that same folder to check this saved intent.' }; publish(); return receipt }
    if (receipt.status === 'unknown' || receipt.status === 'pending') {
      if (!receipt.path) return { ...receipt, issue: 'The original creation is unconfirmed. Its input and target are retained; check this operation before another save.' }
      try {
        const observed = await api.files.read(receipt.target.workspaceId, receipt.path)
        const note = observed.status === 'read' ? readNoteDocument(observed.document.content) : null
        if (observed.status !== 'read' || note?.status !== 'valid' || note.note.noteId !== receipt.noteId) {
          receipt = { ...receipt, status: 'unknown', issue: 'This same Note is not confirmed yet. Your draft and exact path are kept; check it again without creating a replacement.' }; publish(); return receipt
        }
        receipt = { ...receipt, status: 'written', write: { status: 'written', revision: observed.document.revision }, issue: undefined }; publish()
      } catch (error) { receipt = { ...receipt, status: 'unknown', issue: presentError(error) }; publish(); return receipt }
    }
    if (receipt.status === 'written') { receipt = await registerCreatedNote(receipt); publish(); return receipt }
  }
  const state = useAppStore.getState(), workspace = state.config?.workspaces.find(item => item.id === NOTES_WORKSPACE_ID)
  if (!workspace) throw new Error('The Notes folder is unavailable. Your browser and capture draft are kept; reconnect it and retry.')
  const groupId = state.prepareWorkbenchLayout(workspace.id).activeGroupId
  if (!receipt) {
    receipt = { intentId: crypto.randomUUID(), createdAt: Date.now(), noteId: crypto.randomUUID(), blockIds: [crypto.randomUUID()],
      draft, path: '', status: 'pending', revealed: false, notebook: { notebookId, source: target.source },
      target: { workspaceId: workspace.id, hostId: workspace.hostId, workspacePath: workspace.path, directoryPath: workspace.path,
        relativeDirectory: '', zoneId: null, sourceSpaceId: null, displayWorkspaceId: workspace.id, groupId } }
    publish()
  }
  try {
    const library = await refreshNotebookLibrary(), book = library.notebooks[receipt.notebook!.notebookId!]
    if (!book) throw new Error('The selected Notebook is unavailable. This same capture draft and destination are kept.')
    if (!receipt.target.zoneId) {
      // Older Notebook workfaces can belong to another resource. New bodies still use Notes.
      const face = !book.workface || book.workface.workspaceId === workspace.id
        ? await prepareNotebookWorkface(book, workspace.id, ready => { receipt = { ...receipt!, target: { ...receipt!.target, zoneId: ready.zoneId } }; publish() })
        : { zoneId: (await state.createWorkbenchZone({ workspaceId: workspace.id, spaceIds: [] })).zone.zoneId }
      receipt = { ...receipt, target: { ...receipt.target, zoneId: face.zoneId } }; publish()
    }
    if (!resourceCurrent()) throw new Error('The Notes resource changed before this save. The original capture and target are kept.')
    const content = JSON.stringify(newNoteDocument(receipt.draft, receipt.noteId, receipt.blockIds[0]!), null, 2)
    receipt = { ...receipt, status: 'pending', issue: undefined }; publish()
    const named = await createNoteWithAvailableName(new Date(receipt.createdAt), async name => {
      if (!resourceCurrent()) return { status: 'error', code: 'NOTE_RESOURCE_CHANGED', message: 'The original Notes resource changed. No new write was issued; reconnect it to continue this capture.' }
      receipt = { ...receipt!, path: name }; publish()
      const original = receipt!.target
      const read = await api.files.readPublic({ zoneId: original.zoneId!, path: name, expectedResource: {
        hostId: original.hostId, workspaceId: original.workspaceId, workspacePath: original.workspacePath } })
      if (!read.resource || read.result.status === 'unknown') return { status: 'unknown', code: 'NOTE_RESOURCE_UNCONFIRMED', message: 'The original file target is unconfirmed. Your draft and exact path are kept; check this same capture again.' }
      if (read.result.status === 'error') return read.result
      if (read.result.status === 'read' || read.result.status === 'binary') return { status: 'conflict', observedRevision: read.result.status === 'read' ? read.result.document.revision : read.result.revision }
      if (read.result.status !== 'deleted') return { status: 'error', code: 'NOTE_TARGET_OCCUPIED', message: 'The exact Note path is occupied by a directory. Your draft and destination are kept.' }
      const created = await api.files.createPublic({ zoneId: original.zoneId!, path: name,
        expectedResource: read.resource, content, expectedRevision: null })
      return created.result
    })
    receipt = { ...receipt, status: named.result.status, write: named.result, issue: named.result.status === 'written' ? undefined : named.result.message }; publish()
    if (receipt.status === 'written') { receipt = await registerCreatedNote(receipt); publish() }
    return receipt
  } catch (error) { receipt = { ...receipt, status: 'error', issue: presentError(error) }; publish(); return receipt }
}
