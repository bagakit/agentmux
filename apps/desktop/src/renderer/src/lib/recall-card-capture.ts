import { DEFAULT_NOTEBOOK_ID, type NotebookPage, type NoteResource } from '@agentmux/core/notebook-catalog'
import { recallCardBlocks, recallCardHref, recallDailyDate, type RecallCard } from '@agentmux/core/notebook-observation'
import { mintObjectId } from '@agentmux/core/object-id'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NOTES_WORKSPACE_ID } from '@agentmux/host/notes-library'
import { api } from './api'
import { changeNotebook, refreshNotebookLibrary, sameNoteResource } from './notebook-library'
import { noteResourceReadParams } from './note-history-target'
import { scratchTopicsForConfig } from './scratch-topic-snapshots'
import { persistRecallCardIntent, useAppStore } from '../store'
import { recallIntentKey, type RecallCardIntent } from './recall-card-intent'

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

function originalFileRead(resource: NoteResource, position?: { zoneId: string; exact?: boolean }) {
  const state = useAppStore.getState()
  return noteResourceReadParams(state, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots) ?? [], resource, position)
}

async function selectTarget(destination: NotebookPage | null, now: Date): Promise<RecallCardIntent['location']> {
  if (destination) return {
    resource: destination.resource, noteId: destination.noteId,
    zoneId: originalFileRead(destination.resource, destination.workface).zoneId
  }

  const day = recallDailyDate(now)
  const catalog = await refreshNotebookLibrary()
  const daily = catalog.pages['daily-' + day]
  if (daily) return {
    resource: daily.resource, noteId: daily.noteId,
    zoneId: originalFileRead(daily.resource, daily.workface).zoneId
  }

  const workspace = useAppStore.getState().config?.workspaces.find(item => item.id === NOTES_WORKSPACE_ID)
  if (!workspace) throw new Error('The default Notes library is unavailable. Choose an available Note or reconnect the library.')
  const resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: 'Daily-' + day + '.note.md' }
  return { resource, noteId: null, zoneId: originalFileRead(resource).zoneId, dailyTitle: 'Daily · ' + day }
}

async function capture(card: RecallCard, destination: NotebookPage | null, now: Date): Promise<SavedCard> {
  const retained = useAppStore.getState().recallCardIntents[recallIntentKey(card)]
  if (retained?.phase === 'ready') await persistRecallCardIntent(retained, true)
  let intent: RecallCardIntent = retained?.phase === 'checking' ? retained
    : { card, operationId: mintObjectId(), location: await selectTarget(destination, now), phase: 'ready' }
  const { resource, zoneId, noteId, dailyTitle } = intent.location
  const scope = originalFileRead(resource, { zoneId, exact: true })
  const { resource: mapping, result } = await api.files.readPublic(scope)
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
      await persistRecallCardIntent(intent, true)
      throw new Error('The original write did not apply. You can choose a destination and save again.')
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
    intent = { ...intent, phase: 'checking', ...(result.status === 'read' ? { writeAttempt: mintObjectId() } : {}) }
    try { await persistRecallCardIntent(intent) }
    catch (error) { await persistRecallCardIntent(intent, true); throw error }
    const query = { ...scope, expectedResource: mapping }
    const saved = result.status === 'read'
      ? await api.files.writePublic({ ...query, content, baseContent: result.document.content, expectedRevision: result.document.revision, operationId: intent.writeAttempt! })
      : await api.files.createPublic({ ...query, content, expectedRevision: null })
    if (saved.result.status === 'conflict' || saved.result.status === 'error') {
      await persistRecallCardIntent(intent, true)
      throw new Error(saved.result.status === 'error' ? saved.result.message : 'The destination changed while saving. Choose the destination and save again.')
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
