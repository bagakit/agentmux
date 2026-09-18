import type { AppConfig, ScratchTopicSnapshot, WorkspaceBranchesSnapshot } from '../../../shared/contracts'
import type { WorkbenchTab } from './workbench-tabs'
import type { FocusContext } from './focus-context'

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
  id: string; workspaceId: string; projectId: string; name: string; path: string
  labels: string[]; topicId: string | null; recovery: 'removed' | 'unknown' | null
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
export function deriveFocusProjectLanes(rows: readonly FocusContext[], config: AppConfig | null = null, facts: FocusHierarchyFacts = EMPTY_FOCUS_HIERARCHY, tabs: Readonly<Record<string, WorkbenchTab>> = {}, now = Date.now()): FocusProjectLane[] {
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
    const topic = topicId ? facts.topics[workspaceId]?.find(item => item.id === topicId) : undefined
    const labels = [project?.name ?? row.workspaceName]
    const branch = workspace?.branch ?? checkout?.branch
    if (branch) labels.push(branch)
    if (topicId) labels.push(topic?.title || topicId)
    const id = JSON.stringify([workspaceId, row.workspacePath, topicId])
    const lane = lanes.get(id) ?? { id, workspaceId, projectId, name: labels.join(' / '), labels, path: row.workspacePath, topicId, recovery: checkout?.removed ? 'removed' : !workspace && config ? 'unknown' : null, activeAgentIds: [], contextIds: [] }
    if (row.liveAgent) lane.activeAgentIds.push(row.id)
    lane.contextIds.push(row.id)
    lanes.set(id, lane)
    const priority = row.bucket === 'attention' ? 0 : row.bucket === 'working' ? 1
      : row.lastActivityAt != null ? (now - row.lastActivityAt <= 24 * 60 * 60 * 1000 ? 2 : 3) : 4
    priorities.set(id, Math.min(priorities.get(id) ?? priority, priority))
  }
  return [...lanes.values()].sort((a, b) => priorities.get(a.id)! - priorities.get(b.id)!)
}
