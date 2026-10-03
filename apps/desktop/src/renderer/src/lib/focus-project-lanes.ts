import type { AgentFocusHistoryEntry, AgentFocusHistoryIdentity } from './agent-focus'
import type { AppConfig, ScratchTopicSnapshot, WorkspaceBranchesSnapshot } from '../../../shared/contracts'
import type { WorkbenchTab } from './workbench-tabs'
import type { FocusContext } from './focus-context'
import { scratchTopicKind, scratchTopicsForWorkspace, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { topicSpaceIconTarget } from './space-object-appearance'

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
export function deriveFocusProjectLanes(rows: readonly FocusContext[], config: AppConfig | null = null, facts: FocusHierarchyFacts = EMPTY_FOCUS_HIERARCHY, tabs: Readonly<Record<string, WorkbenchTab>> = {}, now = Date.now(), topicSnapshots?: Readonly<Record<string, ScratchTopicsSnapshot>>): FocusProjectLane[] {
  const tabWorkspace = new Map<string, string>()
  for (const tab of Object.values(tabs)) for (const region of Object.values(tab.regions)) if ('sessionId' in region) tabWorkspace.set(region.sessionId, tab.workspaceId)
  const lanes = new Map<string, FocusProjectLane>()
  const priorities = new Map<string, number>()
  const projectRoots = focusProjectRoots(config)
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
    const priority = row.bucket === 'attention' ? 0 : row.bucket === 'working' ? 1
      : row.lastActivityAt != null ? (now - row.lastActivityAt <= 24 * 60 * 60 * 1000 ? 2 : 3) : 4
    priorities.set(id, Math.min(priorities.get(id) ?? priority, priority))
  }
  return [...lanes.values()].sort((a, b) => priorities.get(a.id)! - priorities.get(b.id)!)
}

/** Display identity is a Host/Project pair, independent of a checkout or view. */
export const focusProjectKey = (hostId: string, projectId: string) => JSON.stringify([hostId, projectId])
export type FocusRetainedProject = {
  key: string; projectId: string; name: string; hostId: string
  identity: AgentFocusHistoryIdentity; lastFocusedAt: number | null
}
/** Only retained observations contribute historical projects. Never fabricate
 * current Contexts, control references or task activity from a focus visit. */
export function deriveRetainedFocusProjects(entries: readonly AgentFocusHistoryEntry[], lanes: readonly FocusProjectLane[]): FocusRetainedProject[] {
  const current = new Set(lanes.map(lane => focusProjectKey(lane.hostId, lane.projectId)))
  const projects = new Map<string, FocusRetainedProject>()
  for (const entry of entries) {
    const identity = entry.identity
    if (identity?.kind !== 'agent' || !identity.hostId || !identity.project?.id || !identity.project.name) continue
    const key = focusProjectKey(identity.hostId, identity.project.id)
    if (current.has(key)) continue
    const lastFocusedAt = Number.isSafeInteger(entry.focusedAt) && entry.focusedAt > 0 && entry.focusedAt <= 8_640_000_000_000_000 ? entry.focusedAt : null
    const previous = projects.get(key)
    if (previous && (previous.lastFocusedAt ?? -Infinity) >= (lastFocusedAt ?? -Infinity)) continue
    projects.set(key, { key, projectId: identity.project.id, name: identity.project.name, hostId: identity.hostId, identity, lastFocusedAt })
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
}
