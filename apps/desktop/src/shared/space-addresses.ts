import type { AgentMuxSpaceFact, AgentMuxZoneFact, AgentMuxSpaceDestination, AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import type { AppConfig, ScratchTopicSnapshot, WorkspaceRecord } from './contracts'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID } from './scratch-topics'

/** Durable directory identity shared by the Space tree, CLI and Project grouping. */
export function directoryIdentity(hostId: string, path: string): string {
  if (!hostId || !(path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\'))) {
    throw new Error('Space identity requires a host and an absolute durable directory.')
  }
  return JSON.stringify([hostId, path])
}
export function workspaceZoneId(spaceId: string, workspaceId: string): string {
  return JSON.stringify([spaceId, 'workspace', workspaceId])
}
export function homeZoneId(spaceId: string): string { return JSON.stringify([spaceId, 'home']) }

/** Extra resource association only; directories, Git and runtime facts remain at their owners. */
export type SpaceZoneBinding = { spaceId: string; workspaceId: string }
export type SpaceZoneBindings = Record<string, SpaceZoneBinding>
/** Correlation references, never a second layout, Session state or prompt body. */
export type SpatialRequestBinding = {
  requestId: string
  inputDigest: string
  operation: 'agent.open' | 'space.mv'
  tabId: string
  regionId: string
  agentSessionId: string
  createAgent: boolean
  /** Original Core owner, independent of any later display move. */
  executionHostId?: string
  from?: { spaceId: string; zoneId: string; workspaceId: string; tabId: string; regionId: string }
  target: Pick<AgentMuxSpaceDestination, 'spaceId' | 'zoneId' | 'tabId' | 'regionId'>
  resource?: { hostId: string; path: string; kind: 'directory' | 'worktree'; branch: string | null; sourceWorkspaceId: string }
}
export type SpaceZoneResourceInput = { spaceId: string; resource: NonNullable<AgentMuxSpaceDestination['newZone']> }
export type SpaceZoneResourceResult = {
  config: AppConfig
  workspace: WorkspaceRecord | null
  resource: NonNullable<AgentMuxSpaceMutationReport['resource']>
  issue?: { code: string; message: string }
}

export function spatialSources(config: AppConfig, topics: readonly ScratchTopicSnapshot[], bindings: SpaceZoneBindings = {}): {
  spaces: AgentMuxSpaceFact[]; zones: AgentMuxZoneFact[]
} {
  const spaces = new Map<string, AgentMuxSpaceFact>()
  const zones: AgentMuxZoneFact[] = []
  for (const workspace of config.workspaces) {
    if (workspace.id === SCRATCH_WORKSPACE_ID) continue
    const root = workspace.repoPath ?? workspace.path
    const spaceId = directoryIdentity(workspace.hostId, root)
    const existing = spaces.get(spaceId)
    if (!existing || workspace.path === root) spaces.set(spaceId, {
      spaceId, kind: 'folder', name: workspace.path === root ? workspace.name : root.split(/[\\/]/).filter(Boolean).at(-1) ?? root,
      hostId: workspace.hostId, directoryPath: root, projectId: directoryIdentity(workspace.hostId, root)
    })
    zones.push({ zoneId: workspaceZoneId(spaceId, workspace.id), spaceId, workspaceId: workspace.id,
      kind: workspace.kind === 'worktree' ? 'worktree' : 'directory', hostId: workspace.hostId,
      directoryPath: workspace.path, branch: workspace.branch ?? null })
  }
  const scratch = config.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  if (scratch) {
    const container = directoryIdentity(scratch.hostId, scratch.path)
    spaces.set(container, { spaceId: container, kind: 'container', name: scratch.name,
      hostId: scratch.hostId, directoryPath: scratch.path, projectId: null })
    zones.push({ zoneId: homeZoneId(container), spaceId: container, workspaceId: scratch.id,
      kind: 'home', hostId: scratch.hostId, directoryPath: scratch.path, branch: null })
    for (const topic of topics) {
      const path = topic.directoryPath.startsWith('/') ? topic.directoryPath : `${scratch.path.replace(/\/$/, '')}/${topic.directoryPath}`
      const spaceId = directoryIdentity(scratch.hostId, path)
      spaces.set(spaceId, { spaceId, kind: topic.id === PMO_TEAMS_TOPIC_ID || topic.soul ? 'mote' : 'topic',
        name: topic.id === PMO_TEAMS_TOPIC_ID ? 'Mote' : topic.title, hostId: scratch.hostId,
        directoryPath: path, projectId: null, topicId: topic.id, ...(topic.readError ? { issue: topic.readError } : {}) })
      zones.push({ zoneId: homeZoneId(spaceId), spaceId, workspaceId: scratch.id,
        kind: 'home', hostId: scratch.hostId, directoryPath: path, branch: null })
    }
  }
  for (const [zoneId, binding] of Object.entries(bindings)) {
    if (!binding || typeof binding !== 'object') continue
    const workspace = config.workspaces.find(item => item.id === binding.workspaceId)
    if (!workspace) continue
    const defaultSpaceId = directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path)
    const invalidBinding = () => {
      const visible = spaces.get(defaultSpaceId)
      if (visible) spaces.set(defaultSpaceId, { ...visible, issue: 'A saved Zone association is invalid; the existing directory and its default Zone remain available.' })
    }
    if (typeof binding.spaceId !== 'string' || zoneId !== workspaceZoneId(binding.spaceId, workspace.id)) { invalidBinding(); continue }
    if (!spaces.has(binding.spaceId)) {
      // A temporarily absent filesystem snapshot is not deletion of a durable placement.
      // Recover only the address already held by the workbench, never a title or a new registry.
      let identity: unknown
      try { identity = JSON.parse(binding.spaceId) } catch { invalidBinding(); continue }
      if (!Array.isArray(identity) || identity.length !== 2 || identity[0] !== workspace.hostId ||
        typeof identity[1] !== 'string' || !identity[1].startsWith('/')) { invalidBinding(); continue }
      spaces.set(binding.spaceId, { spaceId: binding.spaceId, kind: 'container',
        name: identity[1].split('/').filter(Boolean).at(-1) ?? identity[1], hostId: workspace.hostId,
        directoryPath: identity[1], projectId: null,
        issue: 'Filesystem Space discovery is unavailable; its durable Zone binding is retained.' })
    }
    if (spaces.get(binding.spaceId)!.hostId !== workspace.hostId) { invalidBinding(); continue }
    const defaultZoneId = workspaceZoneId(defaultSpaceId, workspace.id)
    const defaultIndex = zones.findIndex(zone => zone.zoneId === defaultZoneId)
    if (defaultIndex >= 0) zones.splice(defaultIndex, 1)
    zones.push({ zoneId, spaceId: binding.spaceId, workspaceId: workspace.id,
      kind: workspace.kind === 'worktree' ? 'worktree' : 'directory', hostId: workspace.hostId,
      directoryPath: workspace.path, branch: workspace.branch ?? null })
  }
  for (const [spaceId, space] of spaces) {
    if (space.kind === 'folder' && !zones.some(zone => zone.spaceId === spaceId)) spaces.delete(spaceId)
  }
  return { spaces: [...spaces.values()], zones }
}
