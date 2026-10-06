import type { NoteProvenanceSnapshot } from '@agentmux/core/note-provenance'
import type { NoteDocument } from './note-document.js'

/** Original trusted metadata decorates the in-memory tree; it is never serialized as Markdown. */
export function hydrateNoteProvenance(note: NoteDocument, metadata: NoteProvenanceSnapshot | undefined, revision: string): NoteDocument {
  if (!metadata || metadata.noteId !== note.noteId) return note
  const hydrated = structuredClone(note)
  const current = metadata.revision === revision && metadata.status === 'recorded'
  function visit(node: NoteDocument['content']) {
    const id = node.attrs?.blockId
    if (typeof id === 'string' && Object.hasOwn(metadata!.blocks, id)) {
      const original = metadata!.blocks[id]!
      node.attrs = { ...node.attrs, provenance: { created: original.created, lastEdited: current ? original.lastEdited : null } }
    }
    node.content?.forEach(visit)
  }
  visit(hydrated.content); return hydrated
}
