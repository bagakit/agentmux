import type { NoteGraphReference } from '@agentmux/core/notebook-observation'
import type { NotebookGraphSnapshot } from '../../../shared/notebook-observation'

/** A stored occurrence retains its ID; raw syntax evidence is valid only at its exact revision/range. */
export function noteGraphReferenceKey(reference: NoteGraphReference): string {
  const { source, sourceResource: resource, occurrence } = reference
  return JSON.stringify([resource.hostId, resource.workspaceId, resource.workspacePath, resource.path, source.noteId, source.blockId,
    occurrence.kind === 'stored' ? ['stored', occurrence.referenceId] : ['text', occurrence.revision, occurrence.from, occurrence.to]])
}
export function noteGraphReferenceSelectionKey(reference: NoteGraphReference): string {
  return JSON.stringify([noteGraphReferenceKey(reference), reference.mode, reference.target])
}
export function noteGraphReferenceLabel(reference: NoteGraphReference): string {
  return reference.mode === 'embed' ? reference.target.kind === 'page' ? 'Shared content use' : 'Block embed' : reference.mode === 'reference' ? 'Block reference'
    : reference.target.kind === 'page' ? 'Page link' : reference.target.kind === 'block' ? 'Block link' : 'Unbound link'
}
/** Exact saved forward occurrences projected in either direction, never name matching or a second index. */
export function projectNoteLinks(snapshot: NotebookGraphSnapshot, noteId: string, blockId?: string) {
  const incoming: NoteGraphReference[] = [], outgoing: NoteGraphReference[] = []
  const sharedIncoming: NoteGraphReference[] = [], sharedOutgoing: NoteGraphReference[] = []
  let unboundElsewhere = 0
  for (const reference of snapshot.graph.references) {
    const shared = reference.mode === 'embed' && reference.target.kind === 'page' && reference.occurrence.kind === 'stored'
    if (reference.source.noteId === noteId && (!blockId || reference.source.blockId === blockId)) (shared ? sharedOutgoing : outgoing).push(reference)
    if (reference.target.kind !== 'unbound' && reference.target.noteId === noteId &&
      (!blockId || reference.target.kind === 'block' && reference.target.blockId === blockId)) (shared ? sharedIncoming : incoming).push(reference)
    if (reference.target.kind === 'unbound' && reference.source.noteId !== noteId) unboundElsewhere++
  }
  return { incoming, outgoing, sharedIncoming, sharedOutgoing, unboundElsewhere }
}
