import type {
  SessionSnapshot,
  WorkspaceBranchRecord,
  WorkspaceBranchesSnapshot,
  WorkspaceRecord
} from '../../../shared/contracts'
import {
  scratchTopicIdFromWorkspacePath,
  workspaceOwnsSessionPath,
  type ScratchTopicSnapshot
} from '../../../shared/scratch-topics'

export const PROJECT_BOARD_COLUMNS = ['inbox', 'working', 'needs-you', 'done'] as const

export type ProjectBoardColumn = (typeof PROJECT_BOARD_COLUMNS)[number]
export type BranchBindingFilter = 'all' | 'bound' | 'unbound'

/**
 * Board 的一行，去掉行来源特有部分之后剩下的那些。
 *
 * 行的**身份**取决于 Workspace 是什么——Git 项目的一行是 Branch，Scratch 的一行是 Topic——
 * 但行的**结构**只有一种：一个稳定的行标识、一个可选的落地 Workspace、按状态分好的 Run。
 * 两种来源共用同一套列与同一套状态归类，因此 Board 只有一个，不是两个。
 */
export type BoardRowBase = {
  /** 行的稳定身份：Branch 名或 Topic id。渲染用作 key，不作寻址。 */
  id: string
  /** 行标题。Branch 是分支名，Topic 是标题。 */
  name: string
  /**
   * 这一行在磁盘上的落点，没有则为 null。
   *
   * Branch 行没有 worktree 时为 null（此时不能起 Agent）；Topic 行始终有目录，
   * 因此恒非 null——"Topic 需要先建目录"这种状态不存在。
   */
  path: string | null
  workspace: WorkspaceRecord | null
  runsByColumn: Record<ProjectBoardColumn, SessionSnapshot[]>
  sessions: SessionSnapshot[]
  searchText: string
}

export type ProjectBranchLane = BoardRowBase & {
  kind: 'branch'
  branch: WorkspaceBranchRecord
}

export type TopicBoardRow = BoardRowBase & {
  kind: 'topic'
  topic: ScratchTopicSnapshot
}

/**
 * 一行 Board。
 *
 * `kind` 是判别式：渲染面用它决定画分支图标还是 Topic 图标、Inbox 格该说什么；它**不参与分组**，
 * 分组只认 `sessions`。凡是能只读 `BoardRowBase` 那几个字段完成的事，都不该去看 `kind`。
 */
export type BoardRow = ProjectBranchLane | TopicBoardRow

/** Compact work-line recap shared by Topic and Branch rows. */
export function boardRowRecap(row: BoardRow): string | null {
  if (row.kind === 'topic') return row.topic.summary || null
  return row.sessions.find((session) => Boolean(session.status.detail))?.status.detail ?? null
}

function workspaceForBranch(
  branch: WorkspaceBranchRecord,
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

/**
 * Which of the Board's four columns a Session belongs in.
 *
 * This is a COARSER question than "does this Agent need you" ({@link isNeedsYouState}), and the two must
 * not be built out of each other. The Board has four columns for nine states, so its needs-you column is
 * the catch-all for everything stalled — `disconnected` and `error` land here because a kanban with no
 * cell for them would drop those runs off the board entirely, which is worse than filing them under a
 * heading that is slightly too broad. The attention vocabulary keeps them out of needs-you for the
 * opposite reason: amber has to mean one thing.
 *
 * That difference is deliberate, and {@link BOARD_COLUMN_DESCRIPTIONS} is where it stops being a lie —
 * the column's own copy has to name what is actually in it, not just the two states someone remembered.
 */
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

/**
 * What each column's subtitle says.
 *
 * Lives beside the mapping above rather than in the components, because it is a claim ABOUT that mapping
 * and drifts the moment the two are apart. It already had: two components each carried
 * `'needs-you': 'Waiting or blocked'` while the column had held `disconnected` and `error` for some time,
 * so the Board told users a stalled or crashed run was "waiting" — and the same words appeared in the
 * Agents dock, so both surfaces were confidently wrong in the same way.
 */
export const BOARD_COLUMN_DESCRIPTIONS: Record<ProjectBoardColumn, string> = {
  inbox: 'Start a discussion',
  working: 'Running now',
  'needs-you': 'Waiting, blocked, disconnected, or failed',
  done: 'Completed runs'
}

/**
 * Count the live Agent Sessions that belong to the Board's working column.
 *
 * Project Rail uses this as a presence signal, rather than re-interpreting individual status
 * strings. Keeping the predicate on the Board projection means `starting`, `running`, and `working`
 * stay in lockstep everywhere a surface says that an Agent is running.
 */
export function workingAgentCount(sessions: readonly SessionSnapshot[]): number {
  return sessions.reduce(
    (count, session) => (
      session.kind === 'agent' && sessionBoardColumn(session) === 'working' ? count + 1 : count
    ),
    0
  )
}

/**
 * `running` is the quiet, process-available state after the semantic activity projection has gone
 * idle.  Keep this count beside workingAgentCount so the Project Rail and Board never invent their
 * own status predicate.
 */
export function idleAgentCount(sessions: readonly SessionSnapshot[]): number {
  return sessions.reduce(
    (count, session) => count + (session.kind === 'agent' && session.status.state === 'running' ? 1 : 0),
    0
  )
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

/**
 * 一行的通用部分：分好列的 Run 与可搜索文本。
 *
 * 两种行来源共用它，因此"哪个状态落哪一列"和"搜什么能搜到"只有一份定义。行**自己特有**的东西
 * （Branch 有没有 worktree、Topic 的目录在哪）留在各自的构造函数里，不渗进来。
 */
function boardRowProjection(
  input: {
    id: string
    name: string
    path: string | null
    workspace: WorkspaceRecord | null
    hostId: string
    /** 行名之外还想被搜到的东西，例如 Branch 的 worktree 路径或 Topic 的摘要。 */
    extraSearchTerms?: readonly (string | null | undefined)[]
  },
  sessions: readonly SessionSnapshot[]
): BoardRowBase {
  return {
    id: input.id,
    name: input.name,
    path: input.path,
    workspace: input.workspace,
    sessions: [...sessions],
    runsByColumn: groupRuns(sessions),
    searchText: [
      input.name,
      input.path,
      ...(input.extraSearchTerms ?? []),
      input.workspace?.name,
      input.workspace?.path,
      input.hostId,
      ...sessions.flatMap((session) => [
        session.label,
        session.providerId ?? 'terminal',
        session.status.state,
        session.status.detail
      ])
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
  }
}

export function buildProjectBranchLanes(
  snapshot: WorkspaceBranchesSnapshot,
  workspaces: readonly WorkspaceRecord[],
  sessions: readonly SessionSnapshot[]
): ProjectBranchLane[] {
  if (snapshot.kind !== 'git-repository') return []
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
        ...boardRowProjection({
          id: branch.name,
          name: branch.name,
          path: branch.worktreePath,
          workspace,
          hostId: snapshot.hostId
        }, branchSessions),
        kind: 'branch',
        branch
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

/**
 * Scratch 的行：一个 Topic 一行。
 *
 * Topic 归属**不另写一份判定**——用与 Topic 面板同一个 `scratchTopicIdFromWorkspacePath`，
 * 于是"这个 Agent 属于哪个 Topic"在 Board 与面板上永远是同一个答案。Topic 列表来自文件系统
 * 快照且是权威的：Session 只被**匹配到**已有 Topic 上，绝不反推出一个磁盘上没有的 Topic。
 *
 * Topic 行恒有 `path`（Topic 就是一个目录），因此不存在 Branch 那种"没有 worktree 不能起 Agent"
 * 的状态——Topic 的 Inbox 永远可用。顺序由调用方（用户拖拽偏好）决定，这里保持输入次序。
 */
export function buildTopicBoardRows(
  topics: readonly ScratchTopicSnapshot[],
  scratch: WorkspaceRecord,
  sessions: readonly SessionSnapshot[]
): TopicBoardRow[] {
  const byTopic = new Map<string, SessionSnapshot[]>()
  for (const session of sessions) {
    if (!workspaceOwnsSessionPath(scratch, session)) continue
    const topicId = scratchTopicIdFromWorkspacePath(scratch.path, session.workspacePath)
    if (!topicId) continue
    const group = byTopic.get(topicId)
    if (group) group.push(session)
    else byTopic.set(topicId, [session])
  }
  return topics.map((topic) => ({
    ...boardRowProjection({
      id: topic.id,
      name: topic.title,
      path: topic.directoryPath,
      workspace: scratch,
      hostId: scratch.hostId,
      extraSearchTerms: [topic.summary]
    }, byTopic.get(topic.id) ?? []),
    kind: 'topic',
    topic
  }))
}

/**
 * 行的筛选。
 *
 * 查询与状态列对两种行来源一视同仁；只有 binding（有没有 worktree）是 Branch 独有的问题——
 * Topic 恒有目录，所以对 Topic 行它恒为 `bound`，`path !== null` 一条判据同时覆盖两者，
 * 不需要为 kind 分支。
 */
export function filterBoardRows<Row extends BoardRowBase>(
  rows: readonly Row[],
  query: string,
  column: ProjectBoardColumn | 'all',
  binding: BranchBindingFilter
): Row[] {
  const normalized = query.trim().toLocaleLowerCase()
  return rows.filter(
    (row) =>
      (!normalized || row.searchText.includes(normalized)) &&
      (column === 'all' ||
        (column === 'inbox' ? row.path !== null : row.runsByColumn[column].length > 0)) &&
      (binding === 'all' || (binding === 'bound') === (row.path !== null))
  )
}
