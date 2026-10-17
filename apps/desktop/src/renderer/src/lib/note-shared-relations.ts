import type { NoteSharedOrigin } from '@agentmux/core/note-format'
import { resolveObservedNoteBlock } from '@agentmux/core/notebook-observation'
import type { NotebookGraphSnapshot } from '../../../shared/notebook-observation'
import type { NoteFileTarget } from './file-document-consumers'
import { sameNoteResource } from './notebook-library'

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
