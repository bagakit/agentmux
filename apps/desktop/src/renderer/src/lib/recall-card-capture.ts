import { DEFAULT_NOTEBOOK_ID, type NotebookPage, type NoteResource } from '@agentmux/core/notebook-catalog'
import { recallCardBlocks, recallCardHref, recallDailyDate, type RecallCard } from '@agentmux/core/notebook-observation'
import { mintObjectId } from '@agentmux/core/object-id'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NOTES_WORKSPACE_ID } from '@agentmux/host/notes-library'
import { api } from './api'
import { changeNotebook, notebookPageResourceMatches, refreshNotebookLibrary, sameNoteResource } from './notebook-library'
import { openNotebookPage, prepareNotebookWorkface } from './recall-notebooks'
import { presentKnowledgeSurface } from './knowledge-surface-navigation'
import { persistRecallCardIntent, useAppStore } from '../store'
import { recallIntentKey, type RecallCardIntent } from './recall-card-intent'
import { sessionPresentationById } from './session-presentation'

type SavedCard = { page: NotebookPage; blockId: string }
const pending = new Map<string, Promise<SavedCard>>()

export function saveRecallCard(card: RecallCard, destination: NotebookPage | null, now = new Date()): Promise<SavedCard> {
  const key = recallIntentKey(card)
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const saving = capture(card, destination, now).finally(() => pending.delete(key))
  pending.set(key, saving)
  return saving
}

async function selectTarget(destination: NotebookPage | null, now: Date): Promise<RecallCardIntent['location']> {
  const state = useAppStore.getState()
  if (destination) {
    if (!destination.workface || !notebookPageResourceMatches(destination, state.config)) throw new Error('The chosen Note’s original file location is unavailable.')
    return { resource: destination.resource, noteId: destination.noteId, zoneId: destination.workface.zoneId }
  }
  const workspace = state.config?.workspaces.find(item => item.id === NOTES_WORKSPACE_ID)
  if (!workspace) throw new Error('The default Notes library is unavailable. Choose an available Note or reconnect the library.')
  const catalog = await refreshNotebookLibrary()
  const day = recallDailyDate(now)
  const resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: 'Daily-' + day + '.note.md' }
  const page = Object.values(catalog.pages).find(item => sameNoteResource(item.resource, resource))
  if (page) {
    if (page.noteId !== 'daily-' + day || page.notebookId !== DEFAULT_NOTEBOOK_ID || !page.workface) throw new Error('The Daily address is in use outside the default Notebook. Choose another Note or restore its original directory entry.')
    return { resource, noteId: page.noteId, zoneId: page.workface.zoneId, dailyTitle: page.title }
  }
  const book = catalog.notebooks[DEFAULT_NOTEBOOK_ID]!
  const workface = book.workface && book.workface.workspaceId !== workspace.id
    ? { zoneId: (await state.createWorkbenchZone({ workspaceId: workspace.id, spaceIds: [] })).zone.zoneId }
    : await prepareNotebookWorkface(book, workspace.id)
  return { resource, noteId: null, zoneId: workface.zoneId, dailyTitle: 'Daily · ' + day }
}

async function capture(card: RecallCard, destination: NotebookPage | null, now: Date): Promise<SavedCard> {
  let intent = useAppStore.getState().recallCardIntents[recallIntentKey(card)]
  if (!intent) {
    intent = { card, operationId: mintObjectId(), location: await selectTarget(destination, now), phase: 'ready' }
    await persistRecallCardIntent(intent)
  }
  const { resource, zoneId, noteId, dailyTitle } = intent.location
  if (!notebookPageResourceMatches({ resource }, useAppStore.getState().config)) throw new Error('Reconnect the original Notes file to continue this save.')
  const scope = { zoneId, path: resource.path }
  const { resource: mapping, result } = await api.files.readPublic({ ...scope, expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath } })
  if (!mapping || !sameNoteResource(resource, mapping)) throw new Error('The original Note file could not be confirmed.')
  const original = result.status === 'read' ? readNoteDocument(result.document.content) : null
  if (original?.status === 'invalid' || original?.status === 'valid' && noteId && original.note.noteId !== noteId) throw new Error('The original Note identity or contents could not be confirmed.')
  if (result.status !== 'read' && (result.status !== 'deleted' || noteId || !dailyTitle)) {
    throw new Error(result.status === 'error' || result.status === 'unknown' ? result.message : 'The original Note cannot be read for this save.')
  }
  const dailyId = dailyTitle ? resource.path.slice(0, -'.note.md'.length).toLowerCase() : null
  if (original?.status === 'valid' && !noteId && original.note.noteId !== dailyId) throw new Error('The Daily address is occupied by another document. Choose its exact Note separately.')
  const existing = original?.status === 'valid' ? recallCardBlocks(original.note.content).find(item => item.card.id === intent!.card.id) : undefined
  if (existing && (recallCardHref(existing.card) !== recallCardHref(intent.card))) {
    throw new Error('The destination already contains this card identity with different content. Its existing card is kept.')
  }
  if (intent.phase === 'checking' && intent.writeAttempt && original?.status === 'valid') {
    const { result: history } = await api.files.historyPublic({ ...scope, expectedResource: mapping, noteId: original.note.noteId, eventId: intent.writeAttempt })
    const receipt = history.status === 'read' ? history.entries.find(entry => entry.eventId === intent!.writeAttempt) : undefined
    if (receipt?.status === 'not-applied' && !existing) {
      await persistRecallCardIntent({ ...intent, phase: 'ready' })
      throw new Error('The original write did not apply. Save again to the same Note using its current contents.')
    }
    if (receipt?.status !== 'committed') throw new Error('The original Note write is still unconfirmed. Its exact destination and operation are kept.')
  }
  if (!existing && intent.phase === 'checking') throw new Error('The original card could not be confirmed in this Note. This save and its exact destination are kept for checking.')
  const targetId = original?.status === 'valid' ? original.note.noteId : dailyId!
  const blockId = existing?.blockId ?? intent.operationId
  if (!existing) {
    const block = { type: 'paragraph', attrs: { blockId }, content: [{ type: 'text', text: intent.card.title, marks: [{ type: 'link', attrs: { href: recallCardHref(intent.card) } }] }] }
    const note = newNoteDocument('', targetId, blockId, dailyTitle)
    note.content.content = [block]
    const serialized = serializeNoteDocument(note)
    const body = serialized.slice(serialized.indexOf('\n---\n', 4) + 5)
    const content = result.status === 'read' ? result.document.content + '\n\n' + body : serialized
    const proposed = readNoteDocument(content)
    if (proposed.status !== 'valid' || !recallCardBlocks(proposed.note.content).some(entry => entry.blockId === blockId && recallCardHref(entry.card) === recallCardHref(intent!.card))) {
      throw new Error('The card could not be added to the end of the original Markdown. Check its ending syntax or choose another Note.')
    }
    const ready = intent
    intent = { ...intent, phase: 'checking', ...(result.status === 'read' ? { writeAttempt: mintObjectId() } : {}) }
    try { await persistRecallCardIntent(intent) }
    catch (error) { await persistRecallCardIntent(ready); throw error }
    const query = { ...scope, expectedResource: mapping }
    const saved = result.status === 'read'
      ? await api.files.writePublic({ ...query, content, baseContent: result.document.content, expectedRevision: result.document.revision, operationId: intent.writeAttempt! })
      : await api.files.createPublic({ ...query, content, expectedRevision: null })
    if (saved.result.status === 'conflict' || saved.result.status === 'error') {
      await persistRecallCardIntent({ ...intent, phase: 'ready' })
      throw new Error(saved.result.status === 'error' ? saved.result.message : 'The destination changed while saving. Select Save again to read the updated original.')
    }
    if (saved.result.status !== 'written' || !saved.resource || !sameNoteResource(saved.resource, resource)) {
      throw new Error('The original file write is unconfirmed. Check the same capture to see whether the card is present.')
    }
  }
  let catalog = await refreshNotebookLibrary()
  if (!catalog.pages[targetId] && dailyTitle) {
    catalog = await changeNotebook({ kind: 'register', noteId: targetId, title: dailyTitle, notebookId: DEFAULT_NOTEBOOK_ID, resource,
      workface: { zoneId, workspaceId: resource.workspaceId } }, 'recall-daily:' + targetId)
  }
  const page = catalog.pages[targetId]
  if (!page || !sameNoteResource(page.resource, resource)) throw new Error('The card is in its original file. The Notebook entry still needs to be confirmed.')
  await persistRecallCardIntent(intent, true)
  return { page, blockId }
}

export async function openRecallCardNote(page: NotebookPage, blockId: string, sourceDocument: Document): Promise<void> {
  const state = useAppStore.getState()
  state.setRecallNotebook(page.notebookId, page.noteId)
  if (!await presentKnowledgeSurface('recall', state.setMainSurface, { inputPolicy: 'target', sourceDocument }) ||
    !await openNotebookPage(page, undefined, undefined, { noteId: page.noteId, blockId })) {
    throw new Error('The original Note is kept. Its card position is not currently visible.')
  }
}

export async function openRecallCardRecord(card: RecallCard): Promise<boolean> {
  const state = useAppStore.getState(), session = sessionPresentationById(state.sessions).get(card.reference.agentSessionId)
  if (session?.kind !== 'agent' || session.control.hostId !== card.routeHostId || !state.focusExecutionSession(card.reference.agentSessionId)) {
    return false
  }
  state.setMainSurface('agents')
  const result = await useAppStore.getState().revealConversationItem(card.reference, card.routeHostId)
  if (result.kind === 'unavailable') state.reportError(new Error(result.message), { kind: 'indeterminate' })
  return true
}
