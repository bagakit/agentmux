import { mergeNoteText } from '@agentmux/core/note-merge'
import { readNoteDocument } from './note-document.js'
import { replacesEditedBlock } from './note-merge-identity.js'
import type { NoteLiveMerge } from './note-live-merge.js'

export function computeNoteLiveMerge({ base, current, proposed }: { base: string; current: string; proposed: string }): NoteLiveMerge {
  try {
    const before = readNoteDocument(base), saved = readNoteDocument(current), local = readNoteDocument(proposed)
    if (before.status !== 'valid' || saved.status !== 'valid' || local.status !== 'valid' || before.note.noteId !== saved.note.noteId || before.note.noteId !== local.note.noteId || replacesEditedBlock(before.note, saved.note, local.note)) return { status: 'conflict' }
    const result = mergeNoteText(base, current, proposed)
    if (result.status === 'merged') {
      const merged = readNoteDocument(result.content)
      if (merged.status !== 'valid' || merged.note.noteId !== before.note.noteId) return { status: 'conflict' }
    }
    return result
  } catch (error) { return { status: 'unavailable', message: error instanceof Error ? error.message : String(error) } }
}
if (typeof self !== 'undefined' && typeof document === 'undefined') self.onmessage = (event: MessageEvent<{ base: string; current: string; proposed: string }>) => self.postMessage(computeNoteLiveMerge(event.data))
