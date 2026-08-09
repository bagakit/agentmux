import type { CreateWorkspaceInput, WorkspaceRecord } from '../../../shared/contracts'
import { joinWorkspacePath } from './workspace-paths'

/**
 * Derive the workspace request for the file-tree “Open as Project” action.
 *
 * Keeping path derivation and naming in one pure seam makes the context-menu
 * action independently testable and keeps the component responsible only for
 * the asynchronous add/select lifecycle.
 */
export function createDirectoryProjectInput(input: {
  workspace: Pick<WorkspaceRecord, 'hostId' | 'path'>
  relativePath: string
  name: string
  isDirectory: boolean
}): CreateWorkspaceInput | null {
  if (!input.isDirectory) return null
  return {
    hostId: input.workspace.hostId,
    path: joinWorkspacePath(input.workspace.path, input.relativePath),
    name: input.name
  }
}

