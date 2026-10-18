import { createContext, useContext } from 'react'
import type { NoteResource } from '@agentmux/core/notebook-catalog'
import type { NotebookGraph } from '@agentmux/core/notebook-observation'

/** Resource of the original body, including when rendered inside another Note. */
export const NoteFileContext = createContext<NoteResource | null>(null)
export function useNoteFileResource(): NoteResource | null { return useContext(NoteFileContext) }

/** The containing workface owns navigation; each body still supplies its own resource. */
export type NoteFileLinkOpener = (resource: NoteResource | null, href: string) => Promise<boolean>
export const NoteFileLinkContext = createContext<NoteFileLinkOpener | null>(null)

/** An observed source location never inherits another Workspace's Host or root. */
export function resolveNoteSourceResource(parent: NoteResource | null, location: { workspaceId: string; path: string }, graph?: NotebookGraph): NoteResource | null {
  const found = graph?.observations.filter(item => item.status === 'read' && item.fileIdentity === 'confirmed' && item.resource.workspaceId === location.workspaceId && item.resource.path === location.path) ?? []
  if (found.length > 1) return null
  if (found.length === 1) return found[0]!.resource
  return parent?.workspaceId === location.workspaceId ? { ...parent, path: location.path } : null
}
