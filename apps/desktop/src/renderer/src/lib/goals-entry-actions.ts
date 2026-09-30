import { isFolderWorkspace, type AppConfig, type WorkspaceRecord } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { executionFocusHistory, type AgentFocusContext } from './agent-focus'
import { primaryMoteExecutorId } from './primary-mote-executor'
import { goalProjectContext, goalProjectContextText, type GoalProjectContext } from './goal-project-context'
import { workspaceProjectId } from './workspace-projects'
import { useAppStore } from '../store'

export const GOAL_EXPLORATION_ACTIONS = [
  { id: 'understand', text: '我还不知道能做什么，可以了解我并给我建议吗？' },
  { id: 'ideas', text: '我有一些点子，我们开始尝试一个项目' }
] as const
export type GoalExplorationProject = GoalProjectContext & { source: 'recent' | 'current' }

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
    const root = uniqueWorkspace(identity.project.id)
    if (!validProject(root) || root.hostId !== identity.hostId) continue
    const observed = workspaces.filter(workspace => workspace.hostId === root.hostId &&
      workspace.path === identity.workspacePath && workspaceProjectId(workspace) === workspaceProjectId(root))
    if (observed.length !== 1) continue
    const project = goalProjectContext(config, workspaceProjectId(root), observed[0]!.id)
    if (project) return { ...project, source: 'recent' }
  }
  const selected = activeWorkspaceId ? uniqueWorkspace(activeWorkspaceId) : undefined
  const roots = selected?.repoPath ? workspaces.filter(workspace => workspace.hostId === selected.hostId && workspace.path === selected.repoPath) : []
  const project = selected?.repoPath ? roots.length === 1 ? roots[0] : undefined : selected
  if (!validProject(project)) return null
  const context = goalProjectContext(config, workspaceProjectId(project), selected?.id)
  return context ? { ...context, source: 'current' } : null
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
export function startGoalExploration(text: string, project?: GoalExplorationProject, requestedExecutorId?: string): Promise<void> {
  if (flight) return flight
  let resolve!: () => void, reject!: (cause: unknown) => void
  flight = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const current = flight
  listeners.forEach(listener => listener())
  const state = useAppStore.getState()
  const prompt = project ? `${text}\n\n${goalProjectContextText(project)}` : text
  const executorId = requestedExecutorId ?? primaryMoteExecutorId(state)
  void state.openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, {
    newTab: true, reveal: false, initialRequest: { prompt, ...(executorId ? { executorId } : {}) }
  })
    .then(() => resolve(), reject).finally(() => {
      if (flight === current) { flight = null; listeners.forEach(listener => listener()) }
    })
  return current
}
