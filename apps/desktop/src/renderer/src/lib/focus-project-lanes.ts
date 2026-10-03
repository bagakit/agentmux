import type { AgentFocusHistoryEntry, AgentFocusHistoryIdentity } from './agent-focus'
import type { AppConfig, ScratchTopicSnapshot, WorkspaceBranchesSnapshot } from '../../../shared/contracts'
import type { WorkbenchTab } from './workbench-tabs'
import { focusLastTaskActivityAt, type FocusContext } from './focus-context'
import type { AgentSessionHistoryDescriptor, AgentTimelineSnapshot } from '@agentmux/core'
import { scratchTopicKind, scratchTopicsForWorkspace, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { topicSpaceIconTarget } from './space-object-appearance'
import { FOCUS_RECENT_PROJECT_HOURS, resolveFocusRecentActivityHours } from '../../../shared/focus-preferences'

export type FocusWorktreeFact = { hostId: string; path: string; repoPath: string; branch: string; removed: boolean }
export type FocusHierarchyFacts = {
  topics: Readonly<Record<string, readonly ScratchTopicSnapshot[]>>
  worktrees: readonly FocusWorktreeFact[]
}
export const EMPTY_FOCUS_HIERARCHY: FocusHierarchyFacts = { topics: {}, worktrees: [] }
let indexedConfig: AppConfig | null | undefined
let roots: ReadonlyMap<string, AppConfig['workspaces'][number]> = new Map()
/** Cached read-only references to the immutable Config, never an independent ownership registry. */
export function focusProjectRoots(config: AppConfig | null) {
  if (indexedConfig !== config) {
    const next = new Map<string, AppConfig['workspaces'][number]>()
    for (const workspace of config?.workspaces ?? []) {
      const key = JSON.stringify([workspace.hostId, workspace.path])
      if (!next.has(key)) next.set(key, workspace)
    }
    indexedConfig = config; roots = next
  }
  return roots
}
export type FocusProjectLane = {
  id: string; workspaceId: string; projectId: string; name: string; path: string; hostId: string
  labels: string[]; topicId: string | null; recovery: 'removed' | 'unknown' | null
  projectWorkspaceId: string | null; summary: string | null
  objectKind?: 'topic' | 'mote' | 'unknown'; objectIconKey?: string
  activeAgentIds: string[]; contextIds: string[]
}
/** Preserve the last observed branch/path association when Git confirms its checkout was removed. */
export function retainedWorktreeFacts(previous: readonly FocusWorktreeFact[], snapshot: WorkspaceBranchesSnapshot): FocusWorktreeFact[] {
  if (snapshot.kind !== 'git-repository') return [...previous]
  const other = previous.filter(fact => fact.hostId !== snapshot.hostId || fact.repoPath !== snapshot.repoPath)
  const known = previous.filter(fact => fact.hostId === snapshot.hostId && fact.repoPath === snapshot.repoPath)
  const current = snapshot.branches.flatMap(branch => branch.worktreePath ? [{ hostId: snapshot.hostId, path: branch.worktreePath, repoPath: snapshot.repoPath, branch: branch.name, removed: false }] : [])
  return [...other, ...known.filter(fact => !current.some(item => item.path === fact.path)).map(fact => ({ ...fact, removed: true })), ...current]
}
/** Project/checkout/Topic are held ownership facts, never a guess from Agent liveness. */
export function deriveFocusProjectLanes(rows: readonly FocusContext[], config: AppConfig | null = null, facts: FocusHierarchyFacts = EMPTY_FOCUS_HIERARCHY, tabs: Readonly<Record<string, WorkbenchTab>> = {}, now = Date.now(), topicSnapshots?: Readonly<Record<string, ScratchTopicsSnapshot>>, visits: readonly AgentFocusHistoryEntry[] = []): FocusProjectLane[] {
  const tabWorkspace = new Map<string, string>()
  for (const tab of Object.values(tabs)) for (const region of Object.values(tab.regions)) if ('sessionId' in region) tabWorkspace.set(region.sessionId, tab.workspaceId)
  const lanes = new Map<string, FocusProjectLane>()
  const priorities = new Map<string, number>()
  const projectRoots = focusProjectRoots(config)
  const recentActivityMs = resolveFocusRecentActivityHours(config?.focus?.recentActivityHours) * 60 * 60 * 1000
  const focusedAt = new Map<string, number>()
  for (const visit of visits) if (visit.identity?.kind === 'agent' && Number.isSafeInteger(visit.focusedAt) && visit.focusedAt > 0 && visit.focusedAt <= now) {
    const key = JSON.stringify([visit.identity.hostId, visit.sessionId])
    focusedAt.set(key, Math.max(focusedAt.get(key) ?? 0, visit.focusedAt))
  }
  for (const row of rows) {
    const workspace = row.workspace
    const checkout = facts.worktrees.find(item => item.path === row.workspacePath && item.hostId === row.hostId)
    const repoPath = workspace?.repoPath ?? checkout?.repoPath
    const project = repoPath ? projectRoots.get(JSON.stringify([row.hostId, repoPath])) : workspace
    const projectId = project?.id ?? workspace?.id ?? row.workspaceId
    const workspaceId = workspace?.id ?? tabWorkspace.get(row.id) ?? row.workspaceId
    const topicId = row.topicId ?? null
    const topics = topicSnapshots ? scratchTopicsForWorkspace(topicSnapshots, workspace) : facts.topics[workspaceId]
    const topic = topicId ? topics?.find(item => item.id === topicId) : undefined
    const labels = [project?.name ?? row.workspaceName]
    const branch = workspace?.branch ?? checkout?.branch
    if (branch) labels.push(branch)
    if (topicId) labels.push(topic?.title || topicId)
    const id = JSON.stringify([row.hostId, workspaceId, row.workspacePath, topicId])
    const iconTarget = workspace && topic ? topicSpaceIconTarget(workspace, topic) : null
    const lane = lanes.get(id) ?? { id, workspaceId, projectId, projectWorkspaceId: project?.id ?? workspace?.id ?? null,
      name: labels.join(' / '), labels, summary: topic?.readError ? null : topic?.summary.trim() || null,
      path: row.workspacePath, hostId: row.hostId, topicId,
      ...(topicId ? { objectKind: scratchTopicKind(topicId, topics),
        ...(iconTarget ? { objectIconKey: iconTarget.key } : {}) } : {}),
      recovery: checkout?.removed ? 'removed' : !workspace && config ? 'unknown' : null, activeAgentIds: [], contextIds: [] }
    if (row.liveAgent) lane.activeAgentIds.push(row.id)
    lane.contextIds.push(row.id)
    lanes.set(id, lane)
    const lastUsedAt = Math.max(row.lastActivityAt ?? 0, focusedAt.get(JSON.stringify([row.hostId, row.id])) ?? 0)
    const priority = row.bucket === 'attention' ? 0 : row.bucket === 'working' ? 1
      : lastUsedAt > 0 ? (now - lastUsedAt <= recentActivityMs ? 2 : 3) : 4
    priorities.set(id, Math.min(priorities.get(id) ?? priority, priority))
  }
  return [...lanes.values()].sort((a, b) => priorities.get(a.id)! - priorities.get(b.id)!)
}

/** Display identity is a Host/Project pair, independent of a checkout or view. */
export const focusProjectKey = (hostId: string, projectId: string) => JSON.stringify([hostId, projectId])
export type FocusRetainedProject = {
  key: string; projectId: string; name: string; hostId: string
  identity: AgentFocusHistoryIdentity; lastFocusedAt: number | null
  lastActivityAt: number | null; recent: boolean; state: 'active' | 'retired' | 'unknown'
}
/** Only retained observations contribute historical projects. Never fabricate
 * current Contexts, control references or task activity from a focus visit. */
export function deriveRetainedFocusProjects(entries: readonly AgentFocusHistoryEntry[], lanes: readonly FocusProjectLane[], options: {
  now?: number; sources?: readonly AgentSessionHistoryDescriptor[]; sourcesAvailable?: boolean
  timelines?: Readonly<Record<string, AgentTimelineSnapshot>>
} = {}): FocusRetainedProject[] {
  const now = options.now ?? Date.now()
  const current = new Set(lanes.map(lane => focusProjectKey(lane.hostId, lane.projectId)))
  const projects = new Map<string, FocusRetainedProject>()
  const sources = new Map(options.sources?.map(source => [JSON.stringify([source.hostId, source.agentSessionId]), source]))
  const members = new Map<string, Map<string, AgentSessionHistoryDescriptor | undefined>>()
  for (const entry of entries) {
    const identity = entry.identity
    if (identity?.kind !== 'agent' || !identity.hostId || !identity.project?.id || !identity.project.name) continue
    const key = focusProjectKey(identity.hostId, identity.project.id)
    if (current.has(key)) continue
    const lastFocusedAt = Number.isSafeInteger(entry.focusedAt) && entry.focusedAt > 0 && entry.focusedAt <= now ? entry.focusedAt : null
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
      lastActivityAt: Math.max(previous?.lastActivityAt ?? 0, lastActivityAt ?? 0) || null, recent: false, state: 'unknown' })
  }
  for (const project of projects.values()) {
    const recorded = [...members.get(project.key)!.values()]
    project.state = recorded.every(source => source?.state === 'retired') ? 'retired'
      : recorded.some(source => source?.state === 'active') ? 'active' : 'unknown'
    const lastUsedAt = Math.max(project.lastFocusedAt ?? 0, project.lastActivityAt ?? 0)
    project.recent = project.state !== 'retired' && lastUsedAt > 0 && now - lastUsedAt <= FOCUS_RECENT_PROJECT_HOURS * 3_600_000
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
}
