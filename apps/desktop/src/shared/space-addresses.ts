import type { AgentMuxSpaceFact, AgentMuxZoneFact, AgentMuxSpaceDestination, AgentMuxSpaceMutationReport, AgentMuxSpaceBindingFact, AgentMuxSpaceAddress, TopicCategory } from '@agentmux/core/control'
import type { AgentMuxAgentForkSource } from '@agentmux/core'
import type { AppConfig, ScratchTopicSnapshot, WorkspaceRecord } from './contracts'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicIdentityPath, scratchTopicPhysicalPath } from './scratch-topics'
import { categorySpaceFact, isKnowledgeTopic, UNCLASSIFIED_TOPIC_CATEGORY_ID } from './topic-categories'

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

/** A failed Host read cannot replace the durable original identity with a logical-path guess. */
export function originalTopicAddress(workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>, topic: Pick<ScratchTopicSnapshot, 'id' | 'directoryPath' | 'identityDirectoryPath' | 'readError'>, bindings: SpaceZoneBindings): { spaceId: string; zoneId: string } | null {
  if (topic.readError && !topic.identityDirectoryPath) {
    const original = Object.entries(bindings).filter(([, binding]) => binding.topicId === topic.id && binding.workspaceId === workspace.id);
    return original.length === 1 ? { spaceId: original[0]![1].spaceId, zoneId: original[0]![0] } : null;
  }
  const spaceId = directoryIdentity(workspace.hostId, scratchTopicIdentityPath(workspace, topic));
  return { spaceId, zoneId: homeZoneId(spaceId) };
}

/** Content identity fixes the Topic Zone; Category membership fixes its display Space. */
export function topicSpatialAddress(config: AppConfig | null, topic: ScratchTopicSnapshot,
  bindings: SpaceZoneBindings = {}, categories: readonly TopicCategory[] = []): { spaceId: string; zoneId: string } | null {
  const workspace = config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  if (!workspace) return null
  const source = originalTopicAddress(workspace, topic, bindings)
  if (!source) return null
  const { spaceId: contentId, zoneId } = source
  const original = bindings[zoneId]
  if (!isKnowledgeTopic(topic) || original?.contentKind === 'mote' || !categories.length) return { spaceId: contentId, zoneId }
  const relationships = bindings[zoneId]?.relations
  if (original?.topicId !== topic.id && !categories.some(category => relationships?.[category.spaceId] === true)) return { spaceId: contentId, zoneId }
  const selected = categories.find(category => relationships?.[category.spaceId] === true) ??
    categories.find(category => category.categoryId === UNCLASSIFIED_TOPIC_CATEGORY_ID && relationships?.[category.spaceId] !== false)
  return selected ? { spaceId: selected.spaceId, zoneId } : null
}

/** Resolve execution resources independently of every display Space and current focus. */
export function projectResourceWorkspace(workspaces: readonly WorkspaceRecord[], projectId: string, sourceWorkspaceId?: string): WorkspaceRecord {
  const candidates = workspaces.filter(workspace => workspace.id !== SCRATCH_WORKSPACE_ID &&
    directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path) === projectId)
  if (!candidates.length) throw Object.assign(new Error('The exact resource Project is unknown. Discover it with agentmux app snapshot.'), { code: 'SPACE_RESOURCE_PROJECT_UNKNOWN' })
  if (sourceWorkspaceId !== undefined) {
    const selected = candidates.find(workspace => workspace.id === sourceWorkspaceId)
    if (!selected) throw Object.assign(new Error('The resource Workspace is not in the specified Project.'), { code: 'SPACE_RESOURCE_PROJECT_UNKNOWN' })
    return selected
  }
  const roots = candidates.filter(workspace => workspace.path === (workspace.repoPath ?? workspace.path) && workspace.kind !== 'worktree')
  if (roots.length === 1) return roots[0]!
  if (roots.length === 0 && candidates.length === 1) return candidates[0]!
  throw Object.assign(new Error('This Project has multiple possible execution sources. Specify --source-workspace using an exact Workspace from app snapshot.'), { code: 'SPACE_RESOURCE_SOURCE_REQUIRED' })
}

/** Extra resource association only; directories, Git and runtime facts remain at their owners. */
export type SpaceZoneBinding = {
  /** Original creation/resource context; never a unique display parent. */
  spaceId: string
  workspaceId: string
  /** Topic content identity and confirmed resource path projected from the same Core Zone. */
  topicId?: string
  directoryPath?: string
  contentKind?: 'topic' | 'mote'
  /** Current effective relations on this same durable record. */
  relations?: Record<string, boolean>
}
export type SpaceZoneBindings = Record<string, SpaceZoneBinding>
/** Correlation references, never a second layout, Session state or prompt body. */
export type SpatialRequestBinding = {
  requestId: string
  inputDigest: string
  operation: 'agent.open' | 'space.mv' | 'agent.message'
  tabId: string
  regionId: string
  agentSessionId: string
  createAgent: boolean
  /** Original Core owner, independent of any later display move. */
  executionHostId?: string
  /** User's recovery choice. Correlation only; Core remains the creation/history owner. */
  recovery?: {
    hostId: string; agentSessionId: string; tabId: string; regionId: string
    mode: 'takeover' | 'analyze'; historySource: 'captured' | 'native'; executorId?: string
  }
  /** An explicit message recipient reference, never a payload or delivery receipt. */
  recoveryRecipient?: { hostId: string; agentSessionId: string; topicId: string; tabId: string; regionId: string }
  /** Exact source of this admitted fork, including before a new Session can be observed. */
  forkSource?: AgentMuxAgentForkSource
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
  retained: readonly { workspaceId: string; space: { zoneId: string; spaceId: string } }[] = [], categories: readonly TopicCategory[] = []): {
  spaces: AgentMuxSpaceFact[]; zones: AgentMuxZoneFact[]; bindings: AgentMuxSpaceBindingFact[]
} {
  const spaces = new Map<string, AgentMuxSpaceFact>()
  const zones = new Map<string, AgentMuxZoneFact>()
  const seeds = new Map<string, Set<string>>()
  const conflictingResources = new Set<string>()
  const categoryByContent = new Map<string, string | null>()
  const workspaces = new Map(config?.workspaces.map(workspace => [workspace.id, workspace]))
  const scratchWorkspace = workspaces.get(SCRATCH_WORKSPACE_ID)
  const topicHomes = new Map<string, string>(scratchWorkspace ? topics.flatMap(topic => {
    const address = originalTopicAddress(scratchWorkspace, topic, bindings);
    if (!address) return [];
    const path = bindings[address.zoneId]?.directoryPath ?? (topic.readError && !topic.physicalDirectoryPath ? null : scratchTopicPhysicalPath(scratchWorkspace, topic));
    return path ? [[address.spaceId, path] as [string, string]] : [];
  }) : [])
  for (const binding of Object.values(bindings)) {
    if (!binding.topicId || binding.contentKind === 'mote' || !categories.length || binding.relations?.[binding.spaceId] === true) continue
    const category = categories.find(category => binding.relations?.[category.spaceId] === true)
    categoryByContent.set(binding.spaceId, category?.spaceId ?? null)
  }
  const addZone = (zoneId: string, workspaceId: string, spaceId: string, homePath?: string): void => {
    const workspace = workspaces.get(workspaceId)
    // Read the original factory/context pair without minting or rewriting its opaque identity.
    let homeContext: unknown, directoryContext: unknown
    try { homeContext = JSON.parse(zoneId); directoryContext = JSON.parse(spaceId) } catch { /* Unknown original context is retained. */ }
    const originalHome = Array.isArray(homeContext) && homeContext.length === 2 && homeContext[1] === 'home' &&
      typeof homeContext[0] === 'string' && homeZoneId(homeContext[0]) === zoneId
    const resourcePath = homePath ?? (originalHome && zoneId === homeZoneId(spaceId) && workspace?.id === SCRATCH_WORKSPACE_ID ? topicHomes.get(spaceId) ?? (
      Array.isArray(directoryContext) && directoryContext.length === 2 && directoryContext[0] === workspace.hostId &&
      typeof directoryContext[1] === 'string' && (directoryContext[1].startsWith('/') || /^[A-Za-z]:[\\/]/.test(directoryContext[1]) || directoryContext[1].startsWith('\\\\')) ? directoryContext[1] : undefined) : undefined)
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
    const displayId = categoryByContent.has(spaceId) ? categoryByContent.get(spaceId) : spaceId
    if (displayId) members.add(displayId)
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
    for (const category of categories) spaces.set(category.spaceId, categorySpaceFact(category))
    for (const topic of topics) {
      const source = originalTopicAddress(scratch, topic, bindings)
      if (!source) continue
      const { spaceId, zoneId } = source
      const path = bindings[zoneId]?.directoryPath ?? scratchTopicPhysicalPath(scratch, topic)
      const knownKind = bindings[zoneId]?.contentKind
      const kind = knownKind ?? (!isKnowledgeTopic(topic) ? 'mote' : topic.readError ? 'container' : 'topic')
      const address = topicSpatialAddress(config, topic, bindings, categories)
      if (kind === 'topic' && categories.length && address?.spaceId !== spaceId) {
        categoryByContent.set(spaceId, address?.spaceId ?? null)
      } else spaces.set(spaceId, { spaceId, kind,
        name: topic.id === PMO_TEAMS_TOPIC_ID ? 'Mote' : topic.title, hostId: scratch.hostId,
        directoryPath: path, projectId: null, topicId: topic.id, ...(topic.readError ? { issue: topic.readError } : {}) })
      addZone(zoneId, scratch.id, spaceId, path)
    }
  }
  for (const [zoneId, binding] of Object.entries(bindings)) {
    if (binding && typeof binding.spaceId === 'string' && typeof binding.workspaceId === 'string') addZone(zoneId, binding.workspaceId, binding.spaceId, binding.directoryPath)
  }
  for (const tab of retained) addZone(tab.space.zoneId, tab.workspaceId, tab.space.spaceId, bindings[tab.space.zoneId]?.directoryPath)
  const relations: AgentMuxSpaceBindingFact[] = []
  for (const [zoneId, members] of seeds) {
    for (const [spaceId, linked] of Object.entries(bindings[zoneId]?.relations ?? {})) {
      if (categoryByContent.has(spaceId)) continue
      if (linked === true) members.add(spaceId)
      else if (linked === false) members.delete(spaceId)
    }
    for (const spaceId of members) {
      // This is the original durable Space identity, not a resource-location inference.
      if (!spaces.has(spaceId)) {
        let identity: unknown
        try { identity = JSON.parse(spaceId) } catch { identity = null }
        if (Array.isArray(identity) && identity.length === 2 && typeof identity[0] === 'string' && typeof identity[1] === 'string') {
          const origin = Object.values(bindings).find(binding => binding.spaceId === spaceId && binding.contentKind === 'mote')
          spaces.set(spaceId, { spaceId, kind: origin ? 'mote' : 'container', ...(origin?.topicId ? { topicId: origin.topicId } : {}), name: origin ? 'Mote' : identity[1].split('/').filter(Boolean).at(-1) ?? identity[1],
            hostId: identity[0], directoryPath: identity[1], projectId: null,
            issue: 'Filesystem Space discovery is unavailable; its durable Zone binding is retained.' })
        }
      }
      relations.push({ zoneId, spaceId })
    }
  }
  return { spaces: [...spaces.values()], zones: [...zones.values()], bindings: relations }
}
