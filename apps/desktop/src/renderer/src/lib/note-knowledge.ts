import type { NoteLocation } from '@agentmux/client-ui/note/note-knowledge'
import type { FileDocument } from '../../../shared/contracts'
import { NOTE_FILE_EXTENSION } from '../../../shared/note-document'
import { documentKey } from './workbench-tabs'
export * from '@agentmux/client-ui/note/note-knowledge'
export function loadedNoteFiles(documents: Readonly<Record<string, FileDocument>>): { location: NoteLocation; document: FileDocument }[] {
  return Object.entries(documents).flatMap(([key, document]) => {
    const separator = key.indexOf('\0'), workspaceId = key.slice(0, separator)
    return separator > 0 && key === documentKey(workspaceId, document.path) && document.path.endsWith(NOTE_FILE_EXTENSION)
      ? [{ location: { workspaceId, path: document.path }, document }] : []
  })
}

const noteFilesByDocuments = new WeakMap<Readonly<Record<string, FileDocument>>, Readonly<Record<string, FileDocument>>>()
/** Immutable Files input is the cache key; unrelated Store updates do no document enumeration. */
export function noteFilesFromDocuments(documents: Readonly<Record<string, FileDocument>>): Readonly<Record<string, FileDocument>> {
  const noteFiles = noteFilesByDocuments.get(documents)
  if (noteFiles) return noteFiles
  const derived = Object.fromEntries(loadedNoteFiles(documents).map(({ location, document }) => [documentKey(location.workspaceId, location.path), document]))
  noteFilesByDocuments.set(documents, derived)
  return derived
}
