import { useCallback } from 'react'
import type { NoteSource } from './note-knowledge'
import { parseNoteFile } from './note-knowledge'
import { useNotebookLibrary, sameNoteResource } from './notebook-library'
import { documentKey } from './workbench-tabs'
import { useAppStore } from '../store'

/** A display name from the existing catalog, never a lookup or a target binding. */
export function useNoteSourceTitle(enabled = true) {
  const catalog = useNotebookLibrary(state => enabled ? state.state : null)
  const workspaces = useAppStore(state => enabled ? state.config?.workspaces : undefined)
  return useCallback((source: Pick<NoteSource, 'location' | 'note'>): string | undefined => {
    const page = catalog?.pages[source.note.noteId]
    const workspace = workspaces?.find(item => item.id === source.location.workspaceId)
    return page && workspace && sameNoteResource(page.resource, { hostId: workspace.hostId, workspaceId: workspace.id,
      workspacePath: workspace.path, path: source.location.path }) ? page.title : undefined
  }, [catalog, workspaces])
}

/** Reuse the immutable document parser shared with the Note reader. No discovery or IO. */
export function useNoteFileName(workspaceId: string | undefined, path: string | undefined): string | undefined {
  const document = useAppStore(state => workspaceId && path?.endsWith('.note.md') ? state.documents[documentKey(workspaceId, path)] : undefined)
  const name = useNoteSourceTitle(Boolean(document))
  if (!document || !workspaceId || !path) return undefined
  const read = parseNoteFile(document)
  if (read.status !== 'valid') return undefined
  return name({ location: { workspaceId, path }, note: read.note })
}
