import type { JSONContent } from '@tiptap/core'
import type { NoteResource } from '@agentmux/core/notebook-catalog'
import type { NoteInclude } from './note-document.js'

export type NoteReaderDraftSource = { resource: NoteResource; noteId: string; blockId?: string }
/** An ephemeral reading projection supplied by the host, never a saved include or another body owner. */
export type NoteReaderDraftInclude = {
  hostResource: NoteResource
  hostNoteId: string
  include: Pick<NoteInclude, 'referenceId' | 'noteId' | 'path' | 'workspaceId'>
  source: NoteReaderDraftSource
} & ({ status: 'read'; content: JSONContent } | { status: 'unknown'; message: string })

export function sameNoteDraftResource(left: NoteResource | null | undefined, right: NoteResource | null | undefined): boolean {
  return Boolean(left && right && (['hostId', 'workspaceId', 'workspacePath', 'path'] as const).every(key => left[key] === right[key]))
}

/** Match this exact occurrence, including both resource frames; target equality alone grants no preview. */
export function matchingNoteDraftInclude(entries: readonly NoteReaderDraftInclude[] | undefined, resource: NoteResource | null, noteId: string, include: NoteInclude): NoteReaderDraftInclude | undefined {
  const found = entries?.filter(entry => sameNoteDraftResource(entry.hostResource, resource) && entry.hostNoteId === noteId && entry.include.referenceId === include.referenceId) ?? []
  if (found.length !== 1) return undefined
  const entry = found[0]!
  return entry.include.noteId === include.noteId && entry.include.path === include.path &&
    (entry.include.workspaceId ?? entry.hostResource.workspaceId) === (include.workspaceId ?? resource?.workspaceId) &&
    entry.source.noteId.length > 0 ? entry : undefined
}
