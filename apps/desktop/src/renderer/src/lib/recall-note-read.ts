import { notebookFingerprint, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { recallCardBlocks } from '@agentmux/core/notebook-observation'
import { api } from './api'
import { noteKnowledge } from './note-knowledge'
import { sameNoteResource } from './notebook-library'

async function readOriginalNote(page: NotebookPage, signal: AbortSignal) {
  const read = await api.notebooks.content(page.noteId, { signal })
  signal.throwIfAborted()
  if (!sameNoteResource(read.resource, page.resource)) throw Error('The original Note moved. Refresh the Reading Points list to check its current location.')
  if (read.status !== 'read') throw Error(read.message)
  const { workspaceId, path } = read.resource
  const knowledge = noteKnowledge([{ location: { workspaceId, path }, document: { path, content: read.content, revision: read.revision } }])
  const note = knowledge.sources[0]?.note
  const occurrences = note?.noteId === page.noteId ? recallCardBlocks(note.content) : []
  return { knowledge, occurrences: new Map(occurrences.map(occurrence => [occurrence.blockId, occurrence])) }
}

type NoteRead = { controller: AbortController; readers: number; result: ReturnType<typeof readOriginalNote> }
export type RecallNoteObservation = Awaited<NoteRead['result']>
const pending = new Map<string, NoteRead>()

/** Share only concurrent reads of the same original resource. Never retain resolved bodies here. */
export function observeRecallNote(page: NotebookPage) {
  const key = notebookFingerprint([page.noteId, page.resource])
  let held = pending.get(key)
  if (!held) {
    const controller = new AbortController()
    const result = readOriginalNote(page, controller.signal).finally(() => {
      if (pending.get(key)?.controller === controller) pending.delete(key)
    })
    held = { controller, readers: 0, result }
    pending.set(key, held)
  }
  const note = held
  note.readers++
  return {
    result: note.result,
    release() {
      note.readers--
      if (note.readers === 0 && pending.get(key) === note) {
        pending.delete(key)
        note.controller.abort()
      }
    }
  }
}
