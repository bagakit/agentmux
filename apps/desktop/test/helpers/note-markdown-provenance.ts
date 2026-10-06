import { fixtureEpoch as _newTailFixtureEpoch } from "../../../../test/fixture-values.mjs"
import { fileUploadRevision } from '@agentmux/core/files'
import type { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import type { NoteResource, NotebookActor } from '@agentmux/core/notebook-catalog'
import { readNoteDocument } from '@agentmux/client-ui/note/note-document'
/** Seed trusted fixture metadata in the original owner, never in Markdown bytes. */
export async function recordMarkdownProvenance(store: AgentMuxNotebookStore, resource: NoteResource, content: string, actor: NotebookActor, at = _newTailFixtureEpoch(0, 0, 1)) {
  const read = readNoteDocument(content)
  if (read.status !== 'valid') throw Error(read.message)
  const blocks: Parameters<AgentMuxNotebookStore['recordProvenance']>[0]['blocks'] = {}
  function visit(node: import('@tiptap/core').JSONContent) {
    if (typeof node.attrs?.blockId === 'string') blocks[node.attrs.blockId] = { created: { actor, at }, lastEdited: { actor, at } }
    node.content?.forEach(visit)
  }
  visit(read.note.content)
  return store.recordProvenance({ noteId: read.note.noteId, resource, revision: fileUploadRevision(new TextEncoder().encode(content)), blocks })
}
