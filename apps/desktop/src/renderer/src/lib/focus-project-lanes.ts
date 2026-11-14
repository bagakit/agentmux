import type { AgentFocusHistoryEntry, AgentFocusHistoryIdentity } from './agent-focus'
import type { AppConfig, ScratchTopicSnapshot, WorkspaceBranchesSnapshot } from '../../../shared/contracts'
import { focusLastTaskActivityAt, type FocusContext } from './focus-context'
import type { AgentSessionHistoryDescriptor, AgentTimelineSnapshot } from '@agentmux/core'
import { scratchTopicKind, scratchTopicsForWorkspace, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { topicSpaceIconTarget } from './space-object-appearance'
import { FOCUS_RECENT_PROJECT_HOURS, resolveFocusRecentActivityHours } from '../../../shared/focus-preferences'
import { directoryIdentity } from '../../../shared/space-addresses'
import { compareFocusWork, focusWorkPriority } from '@agentmux/client-ui/focus-order'
import { focusContextIdentityKey, type FocusContextIdentity } from './focus-context-identity'

export type FocusWorktreeFact = { hostId: string; path: string; repoPath: string; branch: string; removed: boolean }
export type FocusHierarchyFacts = {
  topics: Readonly<Record<string, readonly ScratchTopicSnapshot[]>>
  worktrees: readonly FocusWorktreeFact[]
}
export const EMPTY_FOCUS_HIERARCHY: FocusHierarchyFacts = { topics: {}, worktrees: [] }
type ProjectIndex = { roots: ReadonlyMap<string, AppConfig['workspaces'][number]>; workspaces: ReadonlyMap<string, AppConfig['workspaces'][number]> }
const projectIndexes = new WeakMap<Pick<AppConfig, 'workspaces'>, ProjectIndex>()
const emptyIndex: ProjectIndex = { roots: new Map(), workspaces: new Map() }
/** Read-only references belong to each immutable Config, not to the last visible consumer. */
function focusProjectIndex(config: Pick<AppConfig, 'workspaces'> | null): ProjectIndex {
  if (!config) return emptyIndex
  const cached = projectIndexes.get(config)
  if (cached) return cached
  const roots = new Map<string, AppConfig['workspaces'][number]>(), workspaces = new Map<string, AppConfig['workspaces'][number]>()
  for (const workspace of config.workspaces) {
    workspaces.set(workspace.id, workspace)
    const key = JSON.stringify([workspace.hostId, workspace.path])
    if (!roots.has(key)) roots.set(key, workspace)
  }
  const index = { roots, workspaces }; projectIndexes.set(config, index)
  return index
}
export function focusProjectRoots(config: Pick<AppConfig, 'workspaces'> | null) { return focusProjectIndex(config).roots }
/** Map a selected registered resource to the same Host/Project identity as its lanes. */
export function focusWorkspaceProject(workspace: AppConfig['workspaces'][number], config: Pick<AppConfig, 'workspaces'> | null) {
  const project = workspace.repoPath ? focusProjectRoots(config).get(JSON.stringify([workspace.hostId, workspace.repoPath])) : workspace
  const projectId = project?.id ?? (workspace.repoPath ? directoryIdentity(workspace.hostId, workspace.repoPath) : workspace.id)
  return { id: focusProjectKey(workspace.hostId, projectId), name: project?.name ?? workspace.name }
}
export type FocusContextReference = Pick<FocusContext, 'hostId' | 'id'>
export type FocusProjectLane = {
  /** The lane belongs to its Project; each Agent keeps its own qualified identity. */
  id: string; workspaceId: string; projectId: string; name: string; path: string; hostId: string
  locationUnconfirmed?: boolean
  labels: string[]; topicId: string | null; recovery: 'removed' | 'unknown' | null
  projectWorkspaceId: string | null; summary: string | null
  objectKind?: 'topic' | 'mote' | 'unknown'; objectIconKey?: string
  activeAgentRefs: FocusContextReference[]; contextRefs: FocusContextReference[]
  lastActivityAt?: number | null
}
const activityKey = (lane: FocusProjectLane) => lane.topicId ? lane.id : focusProjectKey(lane.hostId, lane.projectId)
/** Preserve the last observed branch/path association when Git confirms its checkout was removed. */
export function retainedWorktreeFacts(previous: readonly FocusWorktreeFact[], snapshot: WorkspaceBranchesSnapshot): FocusWorktreeFact[] {
  if (snapshot.kind !== 'git-repository') return [...previous]
  const other = previous.filter(fact => fact.hostId !== snapshot.hostId || fact.repoPath !== snapshot.repoPath)
  const known = previous.filter(fact => fact.hostId === snapshot.hostId && fact.repoPath === snapshot.repoPath)
  const current = snapshot.branches.flatMap(branch => branch.worktreePath ? [{ hostId: snapshot.hostId, path: branch.worktreePath, repoPath: snapshot.repoPath, branch: branch.name, removed: false }] : [])
  return [...other, ...known.filter(fact => !current.some(item => item.path === fact.path)).map(fact => ({ ...fact, removed: true })), ...current]
}
/** Project/checkout/Topic are held ownership facts, never a guess from Agent liveness. */
export function deriveFocusProjectLanes(rows: readonly FocusContext[], config: Pick<AppConfig, 'workspaces' | 'focus'> | null = null, facts: FocusHierarchyFacts = EMPTY_FOCUS_HIERARCHY, identities?: ReadonlyMap<string, FocusContextIdentity>, now = Date.now(), topicSnapshots?: Readonly<Record<string, ScratchTopicsSnapshot>>): FocusProjectLane[] {
  const lanes = new Map<string, FocusProjectLane>()
  const priorities = new Map<string, number>()
  const groupRanks = new Map<string, number>()
  const members = new Map<string, Set<string>>()
  const { roots: projectRoots, workspaces: workspacesById } = focusProjectIndex(config)
  const activity = new Map<string, number>()
  const recentActivityMs = resolveFocusRecentActivityHours(config?.focus?.recentActivityHours) * 3_600_000
  for (const row of rows) {
    const resource = row.workspace
    const configured = workspacesById.get(resource?.id ?? row.workspaceId)
    const closeout = configured?.closeout ?? resource?.closeout
    const identity = identities?.get(focusContextIdentityKey(row.hostId, row.id))
    const sourceResources = identity?.resources ?? []
    const displayed = new Map<string, AppConfig['workspaces'][number]>()
    if (identities && !row.topicId && !closeout) for (const occurrence of identity?.locations.occurrences ?? []) {
      const candidate = workspacesById.get(occurrence.display.workspaceId)
        ?? (occurrence.display.workspaceId === occurrence.source.workspaceId ? occurrence.source.resource : undefined)
      if (candidate && candidate.hostId === occurrence.display.hostId && !candidate.closeout) displayed.set(candidate.id, candidate)
    }
    const closeoutDisplay = closeout ? workspacesById.get(closeout.targetWorkspaceId) : undefined
    const knownPlacements = [...new Map([...displayed.values(), ...sourceResources].map(value => [JSON.stringify([value.hostId, value.id, value.path]), value])).values()]
    const placements = closeoutDisplay && closeoutDisplay.hostId === row.hostId ? [closeoutDisplay]
      : identities && !row.topicId ? knownPlacements.length ? knownPlacements : [row.access ? resource : undefined] : [resource]
    for (const display of placements) {
      // Focus groups current presentation, while the Context retains its original
      // execution path. A completed closeout must not revive its former branch from
      // retained Git observations after the source resource is withdrawn.
      const located = Boolean(identities && !row.topicId && !row.access && sourceResources.length === 0)
      const gathered = Boolean(display && (closeout || located || sourceResources.length))
      const workspace = gathered ? display : located ? undefined : resource
      const displayPath = gathered ? workspace!.path : located ? '' : row.workspacePath
      const projectHostId = workspace?.hostId ?? row.hostId
      const checkout = gathered || located ? undefined : facts.worktrees.find(item => item.path === row.workspacePath && item.hostId === row.hostId)
      const repoPath = workspace?.repoPath ?? checkout?.repoPath
      const project = repoPath ? projectRoots.get(JSON.stringify([projectHostId, repoPath])) : workspace
      const projectId = project?.id ?? (repoPath ? directoryIdentity(projectHostId, repoPath) : workspace?.id ?? (located ? 'unconfirmed-project' : row.workspaceId))
      const workspaceId = workspace?.id ?? (located ? 'unconfirmed-project' : row.workspaceId)
      const topicId = row.topicId ?? null
      const topics = topicSnapshots ? scratchTopicsForWorkspace(topicSnapshots, workspace) : facts.topics[workspaceId]
      const topic = topicId ? topics?.find(item => item.id === topicId) : undefined
      const labels = [project?.name ?? repoPath ?? (located ? 'Project location unconfirmed' : row.workspaceName)]
      const branch = workspace?.branch ?? checkout?.branch
      if (branch) labels.push(branch)
      if (topicId) labels.push(topic?.title || topicId)
      const id = JSON.stringify([projectHostId, workspaceId, displayPath, topicId])
      const iconTarget = workspace && topic ? topicSpaceIconTarget(workspace, topic) : null
      const lane = lanes.get(id) ?? { id, workspaceId, projectId, projectWorkspaceId: project?.id ?? workspace?.id ?? null,
        name: labels.join(' / '), labels, summary: topic?.readError ? null : topic?.summary.trim() || null,
        path: displayPath, hostId: projectHostId, topicId,
        ...(located && (!workspace || identity?.locations.status !== 'confirmed') ? { locationUnconfirmed: true } : {}),
        ...(topicId ? { objectKind: scratchTopicKind(topicId, topics),
          ...(iconTarget ? { objectIconKey: iconTarget.key } : {}) } : {}),
        recovery: checkout?.removed ? 'removed' : !workspace && config && !located ? 'unknown' : null, activeAgentRefs: [], contextRefs: [] }
      const reference = { hostId: row.hostId, id: row.id }, key = focusContextIdentityKey(row.hostId, row.id)
      const included = members.get(id) ?? new Set<string>()
      if (!included.has(key)) {
        if (row.liveAgent) lane.activeAgentRefs.push(reference)
        lane.contextRefs.push(reference); included.add(key); members.set(id, included)
      }
      lanes.set(id, lane)
      const projectKey = activityKey(lane)
      if (!groupRanks.has(projectKey)) groupRanks.set(projectKey, groupRanks.size)
      const at = row.lastActivityAt
      if (at != null && Number.isFinite(at) && at > 0 && at <= now) activity.set(projectKey, Math.max(activity.get(projectKey) ?? 0, at))
      const priority = focusWorkPriority(row.bucket, at, now, recentActivityMs)
      priorities.set(projectKey, Math.min(priorities.get(projectKey) ?? priority, priority))
    }
  }
  for (const lane of lanes.values()) lane.lastActivityAt = activity.get(activityKey(lane)) ?? null
  return [...lanes.values()].sort((a, b) => {
    const first = activityKey(a), second = activityKey(b)
    return compareFocusWork({ priority: priorities.get(first)!, lastActivityAt: a.lastActivityAt }, { priority: priorities.get(second)!, lastActivityAt: b.lastActivityAt })
      || groupRanks.get(first)! - groupRanks.get(second)!
  })
}

/** Display identity is a Host/Project pair, independent of a checkout or view. */
export const focusProjectKey = (hostId: string, projectId: string) => JSON.stringify([hostId, projectId])
export const focusLaneProjectKey = (lane: FocusProjectLane) => focusProjectKey(lane.hostId, lane.projectId)
/** Every member keeps its original Agent Host; project memberships are sets. */
export function focusLanesByContext(lanes: readonly FocusProjectLane[]): ReadonlyMap<string, readonly FocusProjectLane[]> {
  const result = new Map<string, FocusProjectLane[]>()
  for (const lane of lanes) for (const reference of lane.contextRefs) {
    const key = focusContextIdentityKey(reference.hostId, reference.id), held = result.get(key) ?? []
    if (!held.some(value => value.id === lane.id)) held.push(lane)
    result.set(key, held)
  }
  return result
}
/** A singular decoration cannot choose a principal project from several positions. */
export function uniqueFocusLane(lanes: readonly FocusProjectLane[] | undefined): FocusProjectLane | undefined {
  return lanes?.length === 1 ? lanes[0] : undefined
}
export type FocusRetainedProject = {
  key: string; projectId: string; name: string; hostId: string
  identity: AgentFocusHistoryIdentity; lastFocusedAt: number | null
  lastActivityAt: number | null; recent: boolean; state: 'active' | 'retired' | 'unknown'
  /** Original visit observations for reading, never current Session membership. */
  observations: readonly AgentFocusHistoryEntry[]
}
/** Only retained observations contribute historical projects. Never fabricate
 * current Contexts, control references or task activity from a focus visit. */
export function deriveRetainedFocusProjects(entries: readonly AgentFocusHistoryEntry[], lanes: readonly FocusProjectLane[], options: {
  now?: number; sources?: readonly AgentSessionHistoryDescriptor[]; sourcesAvailable?: boolean
  timelines?: Readonly<Record<string, AgentTimelineSnapshot>>
} = {}): FocusRetainedProject[] {
  const now = options.now ?? Date.now()
  const current = new Set(lanes.flatMap(lane => lane.contextRefs.map(reference => JSON.stringify([reference.hostId, lane.projectId, reference.id]))))
  const projects = new Map<string, FocusRetainedProject>()
  const sources = new Map(options.sources?.map(source => [JSON.stringify([source.hostId, source.agentSessionId]), source]))
  const members = new Map<string, Map<string, AgentSessionHistoryDescriptor | undefined>>()
  const observations = new Map<string, Map<string, AgentFocusHistoryEntry>>()
  for (const entry of entries) {
    const identity = entry.identity
    if (identity?.kind !== 'agent' || !identity.hostId || !identity.project?.id || !identity.project.name) continue
    const key = focusProjectKey(identity.hostId, identity.project.id)
    // One observed Context replaces only its own saved card. Other Sessions in
    // the same project can still be waiting for their first current observation.
    if (current.has(JSON.stringify([identity.hostId, identity.project.id, entry.sessionId]))) continue
    const lastFocusedAt = Number.isSafeInteger(entry.focusedAt) && entry.focusedAt > 0 && entry.focusedAt <= now ? entry.focusedAt : null
    const visits = observations.get(key) ?? new Map<string, AgentFocusHistoryEntry>()
    const visit = visits.get(entry.sessionId)
    const previousAt = visit && Number.isSafeInteger(visit.focusedAt) && visit.focusedAt > 0 && visit.focusedAt <= now ? visit.focusedAt : null
    if (!visit || lastFocusedAt !== null && (previousAt === null || lastFocusedAt > previousAt)) visits.set(entry.sessionId, entry)
    observations.set(key, visits)
    const source = options.sourcesAvailable ? sources.get(JSON.stringify([identity.hostId, entry.sessionId])) : undefined
    const recorded = members.get(key) ?? new Map<string, AgentSessionHistoryDescriptor | undefined>()
    recorded.set(entry.sessionId, source); members.set(key, recorded)
    const timeline = options.timelines?.[entry.sessionId]
    const lastActivityAt = timeline?.agentSessionId === entry.sessionId ? focusLastTaskActivityAt(timeline.items, undefined, now) : null
    const previous = projects.get(key)
    if (previous) {
      previous.lastActivityAt = Math.max(previous.lastActivityAt ?? 0, lastActivityAt ?? 0) || null
      if ((previous.lastFocusedAt ?? -Infinity) >= (lastFocusedAt ?? -Infinity)) continue
    }
    projects.set(key, { key, projectId: identity.project.id, name: identity.project.name, hostId: identity.hostId, identity, lastFocusedAt,
      lastActivityAt: Math.max(previous?.lastActivityAt ?? 0, lastActivityAt ?? 0) || null, recent: false, state: 'unknown', observations: [] })
  }
  for (const project of projects.values()) {
    project.observations = [...observations.get(project.key)!.values()].sort((a, b) => {
      const time = (entry: AgentFocusHistoryEntry) => Number.isSafeInteger(entry.focusedAt) && entry.focusedAt > 0 && entry.focusedAt <= now ? entry.focusedAt : -Infinity
      return time(b) - time(a) || a.sessionId.localeCompare(b.sessionId)
    })
    const recorded = [...members.get(project.key)!.values()]
    project.state = recorded.every(source => source?.state === 'retired') ? 'retired'
      : recorded.some(source => source?.state === 'active') ? 'active' : 'unknown'
    const lastUsedAt = Math.max(project.lastFocusedAt ?? 0, project.lastActivityAt ?? 0)
    project.recent = project.state !== 'retired' && lastUsedAt > 0 && now - lastUsedAt <= FOCUS_RECENT_PROJECT_HOURS * 3_600_000
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
}
