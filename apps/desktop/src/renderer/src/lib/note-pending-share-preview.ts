import type { JSONContent } from '@tiptap/core'
import type { NoteDocument } from '../../../shared/note-document'
import type { PendingNoteShare } from '../../../shared/note-file-editing'
import { noteBlockFingerprint, noteNodeAtPath, noteShareRange, noteShareRangeContent, noteShareSiblingRange } from '@agentmux/client-ui/note/note-share-range'

/** The original pending-source range, without subscription, draft cleanup, IO or any write capability. */
export function notePendingSharePreview(note: NoteDocument, ticket: PendingNoteShare, pendingReferences: ReadonlySet<string>): JSONContent | undefined {
  if (note.noteId !== ticket.copy.source.noteId) return undefined
  const promoted: JSONContent[] = []
  const visit = (node: JSONContent) => {
    if (node.type === 'noteInclude' && node.attrs?.noteId === ticket.include.noteId && node.attrs.path === ticket.include.path &&
      (node.attrs.workspaceId ?? ticket.copy.source.workspaceId) === (ticket.include.workspaceId ?? ticket.copy.source.workspaceId) &&
      !pendingReferences.has(node.attrs.referenceId) && (!ticket.copy.block.blockId || node.attrs.blockId === ticket.copy.block.blockId)) promoted.push(node)
    node.content?.forEach(visit)
  }
  visit(note.content)
  if (promoted.length === 1) return promoted[0]
  if (promoted.length > 1) return undefined
  if (ticket.copy.block.blockId) {
    const selected = noteShareRange(note.content, ticket.copy.block.blockId)
    return selected ? noteShareRangeContent(selected) : undefined
  }
  const index = ticket.copy.block.path.at(-1)
  if (index === undefined) return undefined
  const parent = noteNodeAtPath(note.content, ticket.copy.block.path.slice(0, -1)), at = parent?.content?.[index]
  if (!parent || !at || noteBlockFingerprint(at) !== ticket.copy.block.fingerprint) return undefined
  const nodes = noteShareSiblingRange(parent, index)
  return noteShareRangeContent({ parent, index, nodes, count: nodes.length })
}
