import { defaultAgentMuxStateDirectory } from '@agentmux/core'
import { AgentMuxNotesStorage, type NotesStorageChange, type NotesStorageSnapshot } from '@agentmux/core/notebook-store'
import type { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import type { WorkspaceRecord, WorkspaceFileWriteInput } from '../shared/contracts.js'
import type { ConfigOwner } from './config-owner.js'
import { NOTES_WORKSPACE_ID, NOTES_WORKSPACE_NAME } from '../shared/notes-library.js'
import { SCRATCH_WORKSPACE_ID } from '../shared/scratch-topics.js'
import { workspaceLocationKey } from './workspace-location.js'
import { join } from 'node:path'
import { reconcileNotesSpatialResources } from '../shared/notes-storage-reconciliation.js'
/** Host adapter; the Core locator remains the only directory setting authority. */
export class NotesStorageOwner {
  constructor(private readonly config: ConfigOwner, private readonly spatial: AgentMuxSpatialStateStore, private readonly publish: (snapshot: NotesStorageSnapshot) => void, readonly storage = new AgentMuxNotesStorage()) {}
  inspect(operationId?: string) { return this.storage.inspect(operationId) }
  async initialize() {
    const scratch = this.config.current.workspaces.find(w => w.id === SCRATCH_WORKSPACE_ID)
    if (scratch) await this.storage.bootstrap({ catalogPath: join(defaultAgentMuxStateDirectory(), 'notebooks.json'), workspace: scratch, destinationWorkspaceId: NOTES_WORKSPACE_ID })
    else await this.storage.resume()
    return this.reconcile(await this.inspect())
  }
  async change(input: NotesStorageChange) {
    if (this.config.current.workspaces.some(workspace => workspace.id !== NOTES_WORKSPACE_ID && workspaceLocationKey(workspace.hostId, workspace.path) === workspaceLocationKey('local', input.directory))) throw Object.assign(new Error('This directory already belongs to another Workspace. Choose a separate Notes directory; the original files and workspace are kept.'), { code: 'NOTES_STORAGE_INPUT_INVALID' })
    return this.reconcile(await this.storage.change(input))
  }
  async write<T>(workspace: WorkspaceRecord, input: WorkspaceFileWriteInput, save: (owner: WorkspaceRecord) => Promise<T>): Promise<T> {
    if (workspace.id !== NOTES_WORKSPACE_ID && (workspace.id !== SCRATCH_WORKSPACE_ID || input.path.includes('/') || !input.path.endsWith('.note.json'))) return save(workspace)
    return this.storage.withLock(async () => {
      const current = await this.inspect()
      if (current.operation && (workspace.id === NOTES_WORKSPACE_ID || current.operation.resourceChanges.some(change => change.from.workspaceId === workspace.id && change.from.workspacePath === workspace.path && change.from.path === input.path))) throw Object.assign(new Error('The original Notes directory move needs recovery before another Note write. Your draft and existing pages are retained.'), { code: 'NOTEBOOK_BUSY' })
      const relocation = current.resourceChanges.find(change => change.from.workspaceId === workspace.id && change.from.workspacePath === workspace.path && change.from.path === input.path && change.from.workspaceId !== change.to.workspaceId)
      if (relocation) throw Object.assign(new Error('This Note now belongs to its confirmed Notes directory. Its draft is retained; refresh the original resource before saving.'), { code: 'NOTE_RESOURCE_CHANGED' })
      if (workspace.id === NOTES_WORKSPACE_ID && workspace.path !== current.directory) throw Object.assign(new Error('The pinned Notes directory changed before this write. Your original resource and draft are retained; inspect the current directory before retrying.'), { code: 'NOTE_RESOURCE_CHANGED' })
      return save(workspace)
    })
  }
  async confirmResources(snapshot: NotesStorageSnapshot) {
    for (let attempt = 0; ; attempt++) {
      const state = await this.spatial.readForLayout()
      if (!state) break
      const graph = reconcileNotesSpatialResources(state.graph, snapshot.resourceChanges, snapshot.directoryChanges)
      if (graph === state.graph) break
      try { await this.spatial.commit({ expectedRevision: state.revision, graph }); break }
      catch (error) {
        if ((error as { code?: string }).code !== 'SPATIAL_STATE_CONFLICT' || attempt >= 2) throw error
        // Rebase only this resource mapping on the latest graph; keep concurrent layout edits.
      }
    }
    await this.config.update(current => { const original = current.workspaces.find(w => w.id === NOTES_WORKSPACE_ID)
      if (original?.path === snapshot.directory) return current
      return { ...current, workspaces: [...current.workspaces.filter(w => w.id !== NOTES_WORKSPACE_ID), { id: NOTES_WORKSPACE_ID, name: NOTES_WORKSPACE_NAME, hostId: 'local', kind: 'folder' as const, path: snapshot.directory }] }
    })
    return snapshot
  }
  private async reconcile(snapshot: NotesStorageSnapshot) {
    await this.confirmResources(snapshot); this.publish(snapshot); return snapshot
  }
}
