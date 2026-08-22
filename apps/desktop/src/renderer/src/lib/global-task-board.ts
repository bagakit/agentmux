import type { AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import { workspaceForSession } from './workbench-tabs'

export const BOARD_TASK_STATUS_IDS = ['inbox', 'working', 'needs-you', 'done'] as const
export type BoardTaskStatus = (typeof BOARD_TASK_STATUS_IDS)[number]
export const BOARD_TASK_PRIORITY_IDS = ['low', 'normal', 'high', 'urgent'] as const
export type BoardTaskPriority = (typeof BOARD_TASK_PRIORITY_IDS)[number]
export const BOARD_TASK_ARRANGEMENT_IDS = ['columns', 'grid', 'balanced'] as const
export type BoardTaskArrangement = (typeof BOARD_TASK_ARRANGEMENT_IDS)[number]

export type BoardTaskRecord = {
  id: string
  title: string
  description: string
  status: BoardTaskStatus
  priority: BoardTaskPriority
  projectId: string | null
  projectName: string | null
  sessionIds: string[]
  createdAt: number
  updatedAt: number
  source: 'default-topic' | 'session'
}

export type BoardTaskProjection = BoardTaskRecord & {
  sessions: SessionSnapshot[]
  workspacePath: string | null
}

export function boardTaskStatusForSession(session: SessionSnapshot): BoardTaskStatus {
  if (session.status.state === 'error' || session.status.state === 'disconnected' || session.status.state === 'waiting' || session.status.state === 'blocked') return 'needs-you'
  if (session.processState === 'exited' || session.processState === 'interrupted') return 'done'
  if (session.processState === 'running') return 'working'
  return 'inbox'
}

export function projectForSession(config: AppConfig | null, session: SessionSnapshot): { id: string; name: string } | null {
  const workspace = workspaceForSession(config, session)
  if (!workspace || isScratchWorkspaceId(workspace.id)) return null
  return { id: workspace.id, name: workspace.name }
}

export function projectTaskFromSession(config: AppConfig | null, session: SessionSnapshot): BoardTaskRecord {
  const project = projectForSession(config, session)
  return {
    id: `session:${session.id}`,
    title: session.label,
    description: session.status.detail ?? 'Live Session task projection',
    status: boardTaskStatusForSession(session),
    priority: 'normal',
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    sessionIds: [session.id],
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    source: 'session'
  }
}

export function projectBoardTasks(
  config: AppConfig | null,
  sessions: readonly SessionSnapshot[],
  persisted: Readonly<Record<string, BoardTaskRecord>>
): BoardTaskProjection[] {
  const byId = new Map<string, BoardTaskRecord>()
  for (const task of Object.values(persisted)) byId.set(task.id, task)
  // 一个 Session 只能在看板上出现一次。去重键是「这个 Session 被谁认领了」，不是「有没有同名的
  // session: 行」——手写任务的 id 是 `task:<uuid>`，与派生行的 `session:<id>` 分属两个命名空间，
  // 所以只查 `byId.has(derived.id)` 对「手写任务已经挂了这个 Session」完全失明：那个 Session 会
  // 同时作为任务里的一格和它自己的一张卡出现两次。认领关系只存在于 sessionIds 里，必须问它。
  const claimed = new Set(Object.values(persisted).flatMap((task) => task.sessionIds))
  for (const session of sessions) {
    if (claimed.has(session.id)) continue
    const derived = projectTaskFromSession(config, session)
    if (!byId.has(derived.id)) byId.set(derived.id, derived)
  }
  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  return [...byId.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((task) => ({
      ...task,
      sessions: task.sessionIds.flatMap((sessionId) => {
        const session = sessionById.get(sessionId)
        return session ? [session] : []
      }),
      workspacePath: task.sessionIds
        .map((sessionId) => sessionById.get(sessionId)?.workspacePath ?? null)
        .find((path): path is string => Boolean(path)) ?? null
    }))
}

export function boardTaskColumns(tasks: readonly BoardTaskProjection[]): Record<BoardTaskStatus, BoardTaskProjection[]> {
  return BOARD_TASK_STATUS_IDS.reduce((columns, status) => {
    columns[status] = tasks.filter((task) => task.status === status)
    return columns
  }, {} as Record<BoardTaskStatus, BoardTaskProjection[]>)
}
