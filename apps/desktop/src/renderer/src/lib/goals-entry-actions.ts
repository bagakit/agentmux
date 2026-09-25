import { isFolderWorkspace, type AppConfig, type WorkspaceRecord } from '../../../shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { executionFocusHistory, type AgentFocusContext } from './agent-focus'
import { configuredExecutors } from './executors'
import { useAppStore } from '../store'

export const GOAL_EXPLORATION_ACTIONS = [
  { id: 'understand', text: '我还不知道能做什么，可以了解我并给我建议吗？' },
  { id: 'ideas', text: '我有一些点子，我们开始尝试一个项目' }
] as const
export type GoalExplorationProject = { id: string; name: string; hostId: string; path: string; source: 'recent' | 'current' }

/** History proves recency; configuration alone only proves a current selection. */
export function goalExplorationProject(config: AppConfig | null, focus: AgentFocusContext, activeWorkspaceId: string | null): GoalExplorationProject | null {
  const workspaces = config?.workspaces ?? []
  const uniqueWorkspace = (id: string): WorkspaceRecord | undefined => {
    const matches = workspaces.filter(workspace => workspace.id === id)
    return matches.length === 1 ? matches[0] : undefined
  }
  const validProject = (workspace: WorkspaceRecord | undefined): workspace is WorkspaceRecord => Boolean(workspace &&
    workspace.id !== SCRATCH_WORKSPACE_ID && isFolderWorkspace(workspace) && workspace.name.trim() && workspace.path.trim() &&
    config?.hosts.filter(host => host.id === workspace.hostId).length === 1)
  for (const entry of executionFocusHistory(focus)) {
    const identity = entry.identity
    if (!identity?.project) continue
    const project = uniqueWorkspace(identity.project.id)
    if (!validProject(project) || project.hostId !== identity.hostId) continue
    const knownPath = identity.workspacePath === project.path || workspaces.some(workspace =>
      workspace.hostId === project.hostId && workspace.path === identity.workspacePath && workspace.repoPath === project.path)
    if (knownPath) return { id: project.id, name: project.name, hostId: project.hostId, path: project.path, source: 'recent' }
  }
  const selected = activeWorkspaceId ? uniqueWorkspace(activeWorkspaceId) : undefined
  const roots = selected?.repoPath ? workspaces.filter(workspace => workspace.hostId === selected.hostId && workspace.path === selected.repoPath) : []
  const project = selected?.repoPath ? roots.length === 1 ? roots[0] : undefined : selected
  return validProject(project) ? { id: project.id, name: project.name, hostId: project.hostId, path: project.path, source: 'current' } : null
}

export function goalExplorationNextText(project: GoalExplorationProject): string {
  return project.source === 'recent' ? '根据最近的项目情况，建议我下一步应该做什么' : '根据当前项目的情况，建议我下一步应该做什么'
}

let flight: Promise<void> | null = null
const listeners = new Set<() => void>()
export const goalExplorationPending = (): boolean => flight !== null
export function subscribeGoalExploration(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** One finite operation survives Goals unmounting. The original Topic owner holds the actual request. */
export function startGoalExploration(text: string, project?: GoalExplorationProject): Promise<void> {
  if (flight) return flight
  let resolve!: () => void, reject!: (cause: unknown) => void
  flight = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const current = flight
  listeners.forEach(listener => listener())
  const state = useAppStore.getState()
  const prompt = project ? `${text}\n\n项目：${project.name}\nProject ID: ${project.id}\nHost: ${project.hostId}\nPath: ${project.path}` : text
  const executorId = configuredExecutors(state.config)[0]?.id
  void state.createScratchTopic('mote', { prompt, ...(executorId ? { executorId } : {}) })
    .then(() => resolve(), reject).finally(() => {
      if (flight === current) { flight = null; listeners.forEach(listener => listener()) }
    })
  return current
}
