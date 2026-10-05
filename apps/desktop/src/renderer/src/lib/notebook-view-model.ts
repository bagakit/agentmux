import type { NotebookPage } from '@agentmux/core/notebook-catalog'
import { resolveNoteBlock, type NoteKnowledge } from './note-knowledge'

export type NotebookGraphEdge = { kind: 'hierarchy' | 'reference'; from: string; to: string; id: string; detail: string }
/** Directory facts and exact references from already-read files; no discovery or guessed relationships. */
export function notebookGraph(pages: NotebookPage[], knowledge: NoteKnowledge, resourceConfirmed: (page: NotebookPage) => boolean) {
  const byId = new Map(pages.map(page => [page.noteId, page]))
  const exactSource = (page: NotebookPage, source: NoteKnowledge['sources'][number]) => resourceConfirmed(page) && source.note.noteId === page.noteId && source.location.workspaceId === page.resource.workspaceId && source.location.path === page.resource.path
  const edges: NotebookGraphEdge[] = pages.flatMap(page => page.parentNoteId && byId.has(page.parentNoteId)
    ? [{ kind: 'hierarchy' as const, from: page.parentNoteId, to: page.noteId, id: `parent:${page.noteId}`, detail: 'Notebook parent → child' }] : [])
  let unconfirmedReferences = 0
  for (const reference of knowledge.references) {
    const from = byId.get(reference.source.note.noteId)
    if (!from || !exactSource(from, reference.source)) continue
    const resolved = resolveNoteBlock(knowledge, reference.target), to = byId.get(reference.target.noteId)
    if (resolved.status !== 'resolved' || !to || !exactSource(to, resolved.source)) { unconfirmedReferences += 1; continue }
    edges.push({ kind: 'reference', from: from.noteId, to: to.noteId, id: `reference:${from.noteId}:${reference.referenceId}`, detail: `${reference.mode === 'embed' ? 'Embed' : 'Block reference'}: ${reference.blockId} → ${reference.target.blockId}` })
  }
  const readPages = pages.filter(page => knowledge.sources.filter(source => exactSource(page, source)).length === 1).length
  return { edges, readPages, unconfirmedReferences }
}
