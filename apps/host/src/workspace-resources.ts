import { basename } from 'node:path'
import { AgentMuxError, type AgentMuxSpatialStateStore, type FolderSpaceResource } from '@agentmux/core'
import { folderDirectoryFacts } from '@agentmux/core/space-folder-resources'
import { SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'
import { readOriginalMoteConfiguration } from './mote-resources.js'
import type { WorkspaceRecord } from './content-types.js'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export type HostWorkspaceResources = ReturnType<typeof createHostWorkspaceResources>
/** One read-only resource resolver shared by Source discovery, Files and Folder admission. */
export function createHostWorkspaceResources(configurationPath: string, spatial?: Pick<AgentMuxSpatialStateStore, 'read'>, runtimeId?: () => string) {
  async function read() {
    const workspaces: Array<WorkspaceRecord & { name: string }> = [], issues: Array<{ code: string; message: string }> = []
    let complete = true
    try {
      const raw = await readOriginalMoteConfiguration(configurationPath)
      if (!object(raw) || !Array.isArray(raw.workspaces)) throw Error('The original Workspace configuration is unreadable.')
      for (const value of raw.workspaces) {
        if (!object(value) || ![value.id, value.hostId, value.path].every(item => typeof item === 'string' && item !== '') || value.repoPath !== undefined && typeof value.repoPath !== 'string') {
          complete = false; issues.push({ code: 'SPACE_RESOURCE_UNAVAILABLE', message: 'An original configured Workspace is unreadable; its input is retained.' }); continue
        }
        workspaces.push({ id: value.id as string, hostId: value.hostId as string, path: value.path as string,
          name: typeof value.name === 'string' ? value.name : basename(value.path as string),
          ...(typeof value.kind === 'string' ? { kind: value.kind } : {}), ...(typeof value.repoPath === 'string' ? { repoPath: value.repoPath } : {}),
          ...(typeof value.branch === 'string' ? { branch: value.branch } : {}),
          ...(object(value.closeout) && typeof value.closeout.targetWorkspaceId === 'string' ? { closeout: { targetWorkspaceId: value.closeout.targetWorkspaceId } } : {}) })
      }
    } catch (cause) { complete = false; issues.push({ code: 'SPACE_RESOURCE_UNAVAILABLE', message: cause instanceof Error ? cause.message : String(cause) }) }
    if (spatial) try {
      const state = await spatial.read(), owned = state ? folderDirectoryFacts(state.graph) : { folders: [], issues: [] }
      issues.push(...owned.issues); if (owned.issues.length) complete = false
      const byId = new Map<string, typeof workspaces>()
      for (const workspace of workspaces) { const values = byId.get(workspace.id) ?? []; values.push(workspace); byId.set(workspace.id,values) }
      for (const fact of owned.folders) {
        if (runtimeId && fact.runtimeId !== runtimeId()) { complete = false; issues.push({ code: 'RUNTIME_OWNER_MISMATCH', message: 'The saved Folder belongs to another original Core Runtime. Its reference is retained; no current resource was substituted.' }); continue }
        const { resource } = fact
        const configured = byId.get(resource.id) ?? []
        if (!configured.length) workspaces.push(resource)
        else if (configured.length !== 1 || configured[0]!.hostId !== resource.hostId || configured[0]!.path !== resource.path ||
          (configured[0]!.repoPath ?? configured[0]!.path) !== (resource.repoPath ?? resource.path)) {
          complete = false; issues.push({ code: 'SPACE_RESOURCE_CHANGED', message: 'A Core Folder and configured Workspace claim different original resources. Both records are retained.' })
          // An ambiguous identity cannot be used by Files while other resources remain available.
          workspaces.push(resource)
        }
      }
    } catch (cause) { complete = false; issues.push({ code: 'SPACE_RESOURCE_UNAVAILABLE', message: cause instanceof Error ? cause.message : String(cause) }) }
    return { workspaces, complete, issues }
  }
  async function folder(workspaceId: string): Promise<FolderSpaceResource> {
    const current = await read(), matches = current.workspaces.filter(value => value.id === workspaceId && !value.closeout)
    const item = matches.length === 1 ? matches[0] : undefined
    if (!item || workspaceId === SCRATCH_WORKSPACE_ID) throw new AgentMuxError('Choose one exact original Folder resource. Existing Spaces and Agents are retained.', current.complete ? 'SPACE_RESOURCE_UNKNOWN' : 'SPACE_RESOURCE_UNAVAILABLE')
    return { ...item }
  }
  return { read, folder }
}
