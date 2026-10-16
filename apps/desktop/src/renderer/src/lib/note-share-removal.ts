import { readNoteDocument } from '../../../shared/note-document'
import type { NoteFileEditing } from '../../../shared/note-file-editing'

/** Recovery wording comes from the original intent and confirmed stage summary, including after restart. */
export function noteShareUndoRecoveryMessage(editing: NoteFileEditing): string {
  const receipt = editing.shareUndoReceipt
  const operationId = editing.shareUndo?.params.destination.operationId ?? editing.share?.params.destination.operationId
  if (receipt?.status === 'partial' && (!operationId || receipt.operationId === operationId)) return `The reference removal and original-source restoration were saved. Shared content is kept. ${[...new Set(receipt.retained.map(value => value.message))].join(' ')}`
  return 'The original shared-reference removal needs confirmation. Its complete request and draft are kept.'
}

/** The editor only identifies removed saved occurrences; the file owner decides their consequences. */
export function removedSavedNoteIncludes(base: string, current: string): string[] {
  const before = readNoteDocument(base), after = readNoteDocument(current)
  if (before.status !== 'valid' || after.status !== 'valid' || before.note.noteId !== after.note.noteId) return []
  const includes = (root: typeof before.note.content): Set<string> => {
    const references = new Set<string>(), visit = (node: typeof root) => { if (node.type === 'noteInclude' && typeof node.attrs?.referenceId === 'string') references.add(node.attrs.referenceId); node.content?.forEach(visit) }
    visit(root); return references
  }
  const kept = includes(after.note.content)
  return [...includes(before.note.content)].filter(referenceId => !kept.has(referenceId))
}
