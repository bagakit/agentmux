import type {
  SessionSnapshot,
  WorkspaceBranchesSnapshot,
  WorkspaceRecord
} from '../../../shared/contracts'

export const PROJECT_BOARD_COLUMNS = ['inbox', 'working', 'needs-you', 'done'] as const

export type ProjectBoardColumn = (typeof PROJECT_BOARD_COLUMNS)[number]
export type BranchBindingFilter = 'all' | 'bound' | 'unbound'

export type ProjectBranchLane = {
  branch: WorkspaceBranchesSnapshot['branches'][number]
  workspace: WorkspaceRecord | null
  runsByColumn: Record<ProjectBoardColumn, SessionSnapshot[]>
  sessions: SessionSnapshot[]
  searchText: string
}

function workspaceForBranch(
  branch: WorkspaceBranchesSnapshot['branches'][number],
  workspaces: readonly WorkspaceRecord[],
  hostId: string
): WorkspaceRecord | null {
  return (
    (branch.workspaceId
      ? workspaces.find((workspace) => workspace.id === branch.workspaceId)
      : undefined) ??
    (branch.worktreePath
      ? workspaces.find(
          (workspace) => workspace.hostId === hostId && workspace.path === branch.worktreePath
        )
      : undefined) ??
    null
  )
}

export function sessionBoardColumn(
  session: Pick<SessionSnapshot, 'status'>
): Exclude<ProjectBoardColumn, 'inbox'> {
  switch (session.status.state) {
    case 'starting':
    case 'running':
    case 'working':
      return 'working'
    case 'waiting':
    case 'blocked':
    case 'disconnected':
    case 'error':
      return 'needs-you'
    case 'done':
    case 'exited':
      return 'done'
  }
}

function groupRuns(
  sessions: readonly SessionSnapshot[]
): Record<ProjectBoardColumn, SessionSnapshot[]> {
  const grouped: Record<ProjectBoardColumn, SessionSnapshot[]> = {
    inbox: [],
    working: [],
    'needs-you': [],
    done: []
  }
  for (const session of sessions) grouped[sessionBoardColumn(session)].push(session)
  for (const column of PROJECT_BOARD_COLUMNS) {
    grouped[column].sort((left, right) => right.updatedAt - left.updatedAt)
  }
  return grouped
}

export function buildProjectBranchLanes(
  snapshot: WorkspaceBranchesSnapshot,
  workspaces: readonly WorkspaceRecord[],
  sessions: readonly SessionSnapshot[]
): ProjectBranchLane[] {
  return snapshot.branches
    .map((branch) => {
      const workspace = workspaceForBranch(branch, workspaces, snapshot.hostId)
      const branchSessions = workspace
        ? sessions.filter(
            (session) =>
              session.hostId === workspace.hostId && session.workspacePath === workspace.path
          )
        : []
      return {
        branch,
        workspace,
        sessions: branchSessions,
        runsByColumn: groupRuns(branchSessions),
        searchText: [
          branch.name,
          branch.worktreePath,
          workspace?.name,
          workspace?.path,
          snapshot.hostId,
          ...branchSessions.flatMap((session) => [
            session.label,
            session.agentId ?? 'terminal',
            session.status.state,
            session.status.detail
          ])
        ]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase()
      } satisfies ProjectBranchLane
    })
    .sort((left, right) => {
      if (left.branch.isCurrent !== right.branch.isCurrent) return left.branch.isCurrent ? -1 : 1
      if (Boolean(left.branch.worktreePath) !== Boolean(right.branch.worktreePath)) {
        return left.branch.worktreePath ? -1 : 1
      }
      return left.branch.name.localeCompare(right.branch.name)
    })
}

export function filterProjectBranchLanes(
  lanes: readonly ProjectBranchLane[],
  query: string,
  column: ProjectBoardColumn | 'all',
  binding: BranchBindingFilter
): ProjectBranchLane[] {
  const normalized = query.trim().toLocaleLowerCase()
  return lanes.filter(
    (lane) =>
      (!normalized || lane.searchText.includes(normalized)) &&
      (column === 'all' ||
        (column === 'inbox'
          ? Boolean(lane.branch.worktreePath)
          : lane.runsByColumn[column].length > 0)) &&
      (binding === 'all' || (binding === 'bound') === Boolean(lane.branch.worktreePath))
  )
}
