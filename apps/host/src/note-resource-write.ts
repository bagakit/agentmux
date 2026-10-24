import type { AgentMuxNotesStorage } from '@agentmux/core/notebook-store'
import type { FileWorkspace } from './file-resource-model.js'
import type { WorkspaceFileWriteInput } from './content-types.js'
import { NOTES_WORKSPACE_ID } from './notes-library.js'

/** Original relocation lease and resource checks, shared by every Note writer. */
export async function writeOriginalNoteResource<T, W extends FileWorkspace>(storage: AgentMuxNotesStorage, workspace: W, input: Pick<WorkspaceFileWriteInput, 'path'>, save: (owner: W) => Promise<T>): Promise<T> {
    if (workspace.id !== NOTES_WORKSPACE_ID && !/\.note\.(?:json|md)$/u.test(input.path)) return save(workspace)
    return storage.withLock(async () => {
      const current = await storage.inspect()
      if (current.operation && (workspace.id === NOTES_WORKSPACE_ID || current.operation.resourceChanges.some(change => change.from.workspaceId === workspace.id && change.from.workspacePath === workspace.path && change.from.path === input.path))) throw Object.assign(new Error('The original Notes directory move needs recovery before another Note write. Your draft and existing pages are retained.'), { code: 'NOTEBOOK_BUSY' })
      const relocation = current.resourceChanges.find(change => change.from.hostId === workspace.hostId && change.from.workspaceId === workspace.id && change.from.workspacePath === workspace.path && change.from.path === input.path &&
        (change.from.workspaceId !== change.to.workspaceId || change.from.workspacePath !== change.to.workspacePath || change.from.path !== change.to.path))
      if (relocation) throw Object.assign(new Error('This Note now belongs to its confirmed Notes directory. Its draft is retained; refresh the original resource before saving.'), { code: 'NOTE_RESOURCE_CHANGED' })
      if (workspace.id === NOTES_WORKSPACE_ID && workspace.path !== current.directory) throw Object.assign(new Error('The pinned Notes directory changed before this write. Your original resource and draft are retained; inspect the current directory before retrying.'), { code: 'NOTE_RESOURCE_CHANGED' })
      return save(workspace)
    })
  }
