import type { ExecutionHost } from '@agentmux/core'
import { findWorkspaceByLocation } from './workspace-location.js'
import type { AppConfig, ScratchTopicSnapshot } from '../shared/contracts.js'
import { SCRATCH_WORKSPACE_ID } from '../shared/scratch-topics.js'
import { spatialSources, type SpaceZoneResourceInput, type SpaceZoneResourceResult } from '../shared/space-addresses.js'
import type { WorktreeService } from './worktree-service.js'
import { WorktreeRetainedError } from './worktree-service.js'

export type SpaceZoneResourcePorts = {
  host(hostId: string): ExecutionHost
  config(): AppConfig
  topics(): Promise<ScratchTopicSnapshot[]>
  worktrees: Pick<WorktreeService, 'createForBranch'>
  register(input: { hostId: string; path: string }): Promise<{ workspace: import('../shared/contracts.js').WorkspaceRecord; changed: boolean }>
}

/** One resource creation via existing owners; failures never compensate by deleting a checkout. */
export async function createSpaceZoneResource(input: SpaceZoneResourceInput, ports: SpaceZoneResourcePorts): Promise<SpaceZoneResourceResult> {
  const config = ports.config()
  const sources = spatialSources(config, await ports.topics())
  const space = sources.spaces.find(item => item.spaceId === input.spaceId)
  if (!space) throw Object.assign(new Error('Space is not known. Run agentmux space ls.'), { code: 'UNKNOWN_SPACE' })
  const resource = input.resource
  if (!resource.path.startsWith('/') || resource.path.includes('\0')) throw new Error('A Zone needs an absolute directory.')
  const fact: SpaceZoneResourceResult['resource'] = { hostId: space.hostId, path: resource.path,
    workspaceId: null, kind: resource.kind, branch: resource.kind === 'worktree' ? resource.branch : null }
  if (findWorkspaceByLocation(config.workspaces, space.hostId, resource.path)) {
    throw Object.assign(new Error('This directory is already bound to a Workspace/Zone; choose its existing Zone or a new directory.'), { code: 'SPACE_RESOURCE_ALREADY_BOUND' })
  }
  if (resource.kind === 'directory') {
    const metadata = await ports.host(space.hostId).run('test', ['-d', resource.path], { timeoutMs: 20_000, maxOutputBytes: 256 * 1024 })
    if (metadata.exitCode === 1) throw Object.assign(new Error('The Zone directory does not exist or is not a directory.'), { code: 'SPACE_DIRECTORY_UNAVAILABLE' })
    if (metadata.exitCode !== 0) throw Object.assign(new Error('The directory probe did not complete; no resource was registered.'), { code: 'SPACE_DIRECTORY_UNKNOWN' })
    const { workspace, changed } = await ports.register({ hostId: space.hostId, path: resource.path })
    if (!changed) throw Object.assign(new Error('This directory was already registered while creating the Zone; its previous space placement is retained.'), { code: 'SPACE_RESOURCE_ALREADY_BOUND' })
    return { config: ports.config(), workspace, resource: { ...fact, path: workspace.path, workspaceId: workspace.id } }
  }
  if (space.kind !== 'folder') throw new Error('A Git worktree Zone requires a Folder Space with a repository.')
  const source = config.workspaces.find(item => item.hostId === space.hostId && item.path === space.directoryPath)
    ?? config.workspaces.find(item => item.hostId === space.hostId && item.repoPath === space.directoryPath && item.id !== SCRATCH_WORKSPACE_ID)
  if (!source) throw new Error('The Space has no configured repository source.')
  try {
    const selected = await ports.worktrees.createForBranch({ workspaceId: source.id, path: resource.path,
      branch: resource.branch, createBranch: resource.createBranch }, config)
    return { config: selected.config, workspace: selected.workspace,
      resource: { ...fact, path: selected.workspace.path, workspaceId: selected.workspace.id } }
  } catch (cause) {
    if (!(cause instanceof WorktreeRetainedError)) throw cause
    return { config: ports.config(), workspace: null, resource: fact,
      issue: { code: 'WORKTREE_REGISTRATION_UNCONFIRMED', message: cause.message } }
  }
}
