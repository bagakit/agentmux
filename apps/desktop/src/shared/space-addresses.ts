import type { AgentMuxSpaceFact, AgentMuxZoneFact, AgentMuxSpaceDestination, AgentMuxSpaceMutationReport, AgentMuxSpaceBindingFact, AgentMuxSpaceAddress } from '@agentmux/core/control'
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
export type SpaceZoneBinding = {
  /** Original creation/resource context; never a unique display parent. */
  spaceId: string
  workspaceId: string
  /** Current effective relations on this same durable record. */
  relations?: Record<string, boolean>
}
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
  from?: AgentMuxSpaceAddress
  target: Pick<AgentMuxSpaceDestination, 'spaceId' | 'zoneId' | 'tabId' | 'regionId' | 'displayWorkspaceId' | 'groupId'>
  resource?: { hostId: string; path: string; kind: 'directory' | 'worktree'; branch: string | null; sourceWorkspaceId: string }
}
export type SpaceZoneResourceInput = { spaceId: string; resource: NonNullable<AgentMuxSpaceDestination['newZone']> }
export type SpaceZoneResourceResult = {
  config: AppConfig
  workspace: WorkspaceRecord | null
  resource: NonNullable<AgentMuxSpaceMutationReport['resource']>
  issue?: { code: string; message: string }
}

export function spatialSources(config: AppConfig | null, topics: readonly ScratchTopicSnapshot[], bindings: SpaceZoneBindings = {},
  retained: readonly { workspaceId: string; space: { zoneId: string; spaceId: string } }[] = []): {
  spaces: AgentMuxSpaceFact[]; zones: AgentMuxZoneFact[]; bindings: AgentMuxSpaceBindingFact[]
} {
  const spaces = new Map<string, AgentMuxSpaceFact>()
  const zones = new Map<string, AgentMuxZoneFact>()
  const seeds = new Map<string, Set<string>>()
  const conflictingResources = new Set<string>()
  const workspaces = new Map(config?.workspaces.map(workspace => [workspace.id, workspace]))
  const addZone = (zoneId: string, workspaceId: string, spaceId: string, homePath?: string): void => {
    const workspace = workspaces.get(workspaceId)
    // Read the original factory/context pair without minting or rewriting its opaque identity.
    let homeContext: unknown, directoryContext: unknown
    try { homeContext = JSON.parse(zoneId); directoryContext = JSON.parse(spaceId) } catch { /* Unknown original context is retained. */ }
    const originalHome = Array.isArray(homeContext) && homeContext.length === 2 && homeContext[1] === 'home' &&
      typeof homeContext[0] === 'string' && homeZoneId(homeContext[0]) === zoneId
    const resourcePath = homePath ?? (originalHome && zoneId === homeZoneId(spaceId) && workspace?.id === SCRATCH_WORKSPACE_ID &&
      Array.isArray(directoryContext) && directoryContext.length === 2 && directoryContext[0] === workspace.hostId &&
      typeof directoryContext[1] === 'string' && (directoryContext[1].startsWith('/') || /^[A-Za-z]:[\\/]/.test(directoryContext[1]) || directoryContext[1].startsWith('\\\\')) ? directoryContext[1] : undefined)
    const fact: AgentMuxZoneFact = workspace && (!originalHome || resourcePath) ? {
      zoneId, workspaceId, kind: resourcePath ? 'home' : workspace.kind === 'worktree' ? 'worktree' : 'directory',
      hostId: workspace.hostId, directoryPath: resourcePath ?? workspace.path, branch: workspace.branch ?? null
    } : { zoneId, workspaceId, kind: 'unknown', hostId: null, directoryPath: null, branch: null,
      issue: 'The original Zone resource context is unavailable; its identity and bindings are retained.' }
    const previous = zones.get(zoneId)
    if (previous && (previous.workspaceId !== workspaceId || previous.kind === 'home' && fact.kind === 'home' &&
      (previous.hostId !== fact.hostId || previous.directoryPath !== fact.directoryPath))) conflictingResources.add(zoneId)
    if (conflictingResources.has(zoneId)) zones.set(zoneId, { ...(previous ?? fact), kind: 'unknown', hostId: null, directoryPath: null, branch: null,
      issue: 'Original Zone resource contexts conflict; its identity and every saved binding are retained.' })
    else if (!previous || previous.kind === 'unknown' && fact.kind !== 'unknown' || fact.kind === 'home') zones.set(zoneId, fact)
    const members = seeds.get(zoneId) ?? new Set<string>()
    members.add(spaceId)
    seeds.set(zoneId, members)
  }
  for (const workspace of workspaces.values()) {
    if (workspace.id === SCRATCH_WORKSPACE_ID) continue
    const root = workspace.repoPath ?? workspace.path
    const spaceId = directoryIdentity(workspace.hostId, root)
    const existing = spaces.get(spaceId)
    if (!existing || workspace.path === root) spaces.set(spaceId, {
      spaceId, kind: 'folder', name: workspace.path === root ? workspace.name : root.split(/[\\/]/).filter(Boolean).at(-1) ?? root,
      hostId: workspace.hostId, directoryPath: root, projectId: directoryIdentity(workspace.hostId, root)
    })
    addZone(workspaceZoneId(spaceId, workspace.id), workspace.id, spaceId)
  }
  const scratch = workspaces.get(SCRATCH_WORKSPACE_ID)
  if (scratch) {
    const container = directoryIdentity(scratch.hostId, scratch.path)
    spaces.set(container, { spaceId: container, kind: 'container', name: scratch.name,
      hostId: scratch.hostId, directoryPath: scratch.path, projectId: null })
    addZone(homeZoneId(container), scratch.id, container, scratch.path)
    for (const topic of topics) {
      const path = topic.directoryPath.startsWith('/') ? topic.directoryPath : `${scratch.path.replace(/\/$/, '')}/${topic.directoryPath}`
      const spaceId = directoryIdentity(scratch.hostId, path)
      spaces.set(spaceId, { spaceId, kind: topic.id === PMO_TEAMS_TOPIC_ID || topic.soul ? 'mote' : 'topic',
        name: topic.id === PMO_TEAMS_TOPIC_ID ? 'Mote' : topic.title, hostId: scratch.hostId,
        directoryPath: path, projectId: null, topicId: topic.id, ...(topic.readError ? { issue: topic.readError } : {}) })
      addZone(homeZoneId(spaceId), scratch.id, spaceId, path)
    }
  }
  for (const [zoneId, binding] of Object.entries(bindings)) {
    if (binding && typeof binding.spaceId === 'string' && typeof binding.workspaceId === 'string') addZone(zoneId, binding.workspaceId, binding.spaceId)
  }
  for (const tab of retained) addZone(tab.space.zoneId, tab.workspaceId, tab.space.spaceId)
  const relations: AgentMuxSpaceBindingFact[] = []
  for (const [zoneId, members] of seeds) {
    for (const [spaceId, linked] of Object.entries(bindings[zoneId]?.relations ?? {})) {
      if (linked === true) members.add(spaceId)
      else if (linked === false) members.delete(spaceId)
    }
    for (const spaceId of members) {
      // This is the original durable Space identity, not a resource-location inference.
      if (!spaces.has(spaceId)) {
        let identity: unknown
        try { identity = JSON.parse(spaceId) } catch { identity = null }
        if (Array.isArray(identity) && identity.length === 2 && typeof identity[0] === 'string' && typeof identity[1] === 'string') {
          spaces.set(spaceId, { spaceId, kind: 'container', name: identity[1].split('/').filter(Boolean).at(-1) ?? identity[1],
            hostId: identity[0], directoryPath: identity[1], projectId: null,
            issue: 'Filesystem Space discovery is unavailable; its durable Zone binding is retained.' })
        }
      }
      relations.push({ zoneId, spaceId })
    }
  }
  return { spaces: [...spaces.values()], zones: [...zones.values()], bindings: relations }
}
