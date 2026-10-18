import type { NoteSharedOrigin } from '@agentmux/core/note-format'
import { resolveObservedNoteBlock } from '@agentmux/core/notebook-observation'
import type { NotebookGraphSnapshot } from '../../../shared/notebook-observation'
import type { NoteFileTarget } from './file-document-consumers'
import { sameNoteResource } from './notebook-library'
import type { NoteSource } from '@agentmux/client-ui/note/note-knowledge'
import { noteContentSchema } from '@agentmux/client-ui/note/note-content-schema'
import { noteSemanticText } from '@agentmux/client-ui/note/note-wikilinks'
import type { NoteGraphReference } from '@agentmux/core/notebook-observation'

export type NoteSharedUse = ReturnType<typeof noteSharedRelations>['uses'][number]
export type NoteUseContext = { status: 'read'; heading: string; excerpt: string } | { status: 'unknown'; message: string }

/** Position context belongs to the containing original, never the included content. */
export function noteUseContext(source: NoteSource, reference: NoteGraphReference): NoteUseContext {
  const unknown = () => ({ status: 'unknown' as const, message: 'This saved use position is not confirmed in its original.' })
  if (source.note.noteId !== reference.source.noteId || source.location.workspaceId !== reference.sourceResource.workspaceId || source.location.path !== reference.sourceResource.path) return unknown()
  const tree = noteContentSchema.nodeFromJSON(source.note.content)
  let position: number | undefined
  tree.descendants((node, at) => { if (node.attrs.blockId === reference.source.blockId) position = at })
  if (position === undefined) return unknown()
  const node = tree.nodeAt(position)
  if (node?.type.name !== 'noteInclude' || reference.occurrence.kind !== 'stored' || reference.target.kind !== 'page' || node.attrs.referenceId !== reference.occurrence.referenceId || node.attrs.noteId !== reference.target.noteId) return unknown()
  const at = tree.resolve(position)
  const text = (value: typeof tree) => noteSemanticText(value).replace(/\s+/gu, ' ').trim().slice(0, 160)
  let heading = '', excerpt = ''
  for (let depth = at.depth; depth >= 0; depth--) {
    const parent = at.node(depth), index = at.index(depth)
    for (let i = index - 1; i >= 0; i--) {
      const candidate = parent.child(i)
      if (candidate.type.name === 'heading') { heading ||= text(candidate); break }
      if (!excerpt && candidate.type.name === 'paragraph') excerpt = text(candidate)
    }
    if (!excerpt && depth === at.depth) for (let i = index + 1; i < parent.childCount; i++) {
      const candidate = parent.child(i)
      if (candidate.type.name === 'heading') break
      if (candidate.type.name === 'paragraph' && text(candidate)) { excerpt = text(candidate); break }
    }
    if (heading) break
  }
  return { status: 'read', heading, excerpt }
}

/** Direct saved uses of one shared original; ordinary links never become uses. */
export function noteSharedRelations(snapshot: NotebookGraphSnapshot, noteId: string, origin: NoteSharedOrigin | undefined,
  current: { target: NoteFileTarget; referenceId: string }) {
  const source = origin ? resolveObservedNoteBlock(snapshot.graph.observations, { noteId: origin.sourceNoteId, blockId: origin.sourceBlockId }) : null
  const uses = snapshot.graph.references.filter(reference => reference.mode === 'embed' && reference.target.kind === 'page' && reference.target.noteId === noteId && reference.occurrence.kind === 'stored')
    .map(reference => ({ reference,
      source: Boolean(origin && source?.status === 'resolved' && reference.source.noteId === source.target.noteId && reference.source.blockId === source.target.blockId && reference.occurrence.kind === 'stored' && reference.occurrence.referenceId === `${origin.operationId}:source`),
      current: reference.source.noteId === current.target.noteId && sameNoteResource(reference.sourceResource, current.target) && reference.occurrence.kind === 'stored' && reference.occurrence.referenceId === current.referenceId,
      title: snapshot.catalog.pages[reference.source.noteId]?.title ?? reference.sourceResource.path.split('/').at(-1)!.replace(/\.note\.md$/u, '')
    }))
  return { uses, source: uses.find(use => use.source), documents: new Set(uses.map(use => use.reference.source.noteId)).size }
}
