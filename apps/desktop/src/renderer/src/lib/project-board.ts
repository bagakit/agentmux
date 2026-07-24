import type {
  SessionSnapshot,
  WorkspaceBranchesSnapshot,
  WorkspaceRecord
} from '../../../shared/contracts'

export type BranchActivityState = 'attention' | 'active' | 'complete' | 'idle'
export type BranchBindingFilter = 'all' | 'bound' | 'unbound'

export type ProjectBranchLane = {
  branch: WorkspaceBranchesSnapshot['branches'][number]
  workspace: WorkspaceRecord | null
  sessions: SessionSnapshot[]
  activity: BranchActivityState
  searchText: string
}

export type ProjectInboxItem = {
  id: string
  lane: ProjectBranchLane
  session: SessionSnapshot
  reason: string
}

export const ATTENTION_SESSION_STATES = new Set([
  'waiting',
  'blocked',
  'disconnected',
  'error'
])

const ACTIVE_SESSION_STATES = new Set(['starting', 'running', 'working'])

export function branchActivity(sessions: readonly SessionSnapshot[]): BranchActivityState {
  if (sessions.some((session) => ATTENTION_SESSION_STATES.has(session.status.state))) {
    return 'attention'
  }
  if (sessions.some((session) => ACTIVE_SESSION_STATES.has(session.status.state))) {
    return 'active'
  }
  if (sessions.length > 0) return 'complete'
  return 'idle'
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

export function buildProjectBranchLanes(
  snapshot: WorkspaceBranchesSnapshot,
  workspaces: readonly WorkspaceRecord[],
  sessions: readonly SessionSnapshot[]
): ProjectBranchLane[] {
  return snapshot.branches
    .map((branch) => {
      const workspace = workspaceForBranch(branch, workspaces, snapshot.hostId)
      const branchSessions = workspace
        ? sessions
            .filter(
              (session) =>
                session.hostId === workspace.hostId && session.workspacePath === workspace.path
            )
            .sort((left, right) => left.createdAt - right.createdAt)
        : []
      return {
        branch,
        workspace,
        sessions: branchSessions,
        activity: branchActivity(branchSessions),
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
  activity: BranchActivityState | 'all',
  binding: BranchBindingFilter
): ProjectBranchLane[] {
  const normalized = query.trim().toLocaleLowerCase()
  return lanes.filter(
    (lane) =>
      (!normalized || lane.searchText.includes(normalized)) &&
      (activity === 'all' || lane.activity === activity) &&
      (binding === 'all' || (binding === 'bound') === Boolean(lane.branch.worktreePath))
  )
}

function inboxReason(session: SessionSnapshot): string {
  if (session.status.detail) return session.status.detail
  switch (session.status.state) {
    case 'waiting': return 'Waiting for input'
    case 'blocked': return 'Blocked'
    case 'disconnected': return 'Connection lost'
    case 'error': return 'Session failed'
    default: return session.status.state
  }
}

export function buildProjectInbox(lanes: readonly ProjectBranchLane[]): ProjectInboxItem[] {
  return lanes
    .flatMap((lane) =>
      lane.sessions.flatMap((session) =>
        ATTENTION_SESSION_STATES.has(session.status.state)
          ? [{ id: session.id, lane, session, reason: inboxReason(session) }]
          : []
      )
    )
    .sort((left, right) => right.session.updatedAt - left.session.updatedAt)
}
