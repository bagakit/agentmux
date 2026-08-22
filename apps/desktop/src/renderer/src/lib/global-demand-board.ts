import type { SessionSnapshot } from '../../../shared/contracts'
import type { AgentMuxDemandDecision } from '@agentmux/core/control'

export const DEMAND_STATUS_IDS = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'] as const
export type DemandStatus = (typeof DEMAND_STATUS_IDS)[number]
export const DEMAND_PRIORITY_IDS = ['low', 'normal', 'high', 'urgent'] as const
export type DemandPriority = (typeof DEMAND_PRIORITY_IDS)[number]
export const DEMAND_ARRANGEMENT_IDS = ['columns', 'grid', 'balanced'] as const
export type DemandArrangement = (typeof DEMAND_ARRANGEMENT_IDS)[number]

export type DemandRecord = {
  id: string
  title: string
  description: string
  status: DemandStatus
  priority: DemandPriority
  projectId: string | null
  projectName: string | null
  assigneeExecutorId?: string | null
  activityLog?: string[]
  sessionIds: string[]
  createdAt: number
  updatedAt: number
  source: 'default-topic' | 'session'
  decisionLog?: AgentMuxDemandDecision[]
}

export type DemandProjection = DemandRecord & {
  sessions: SessionSnapshot[]
  workspacePath: string | null
}

export function projectDemands(
  _config: unknown,
  sessions: readonly SessionSnapshot[],
  persisted: Readonly<Record<string, DemandRecord>>
): DemandProjection[] {
  const records = Object.values(persisted)
  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  return [...records]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((demand) => ({
      ...demand,
      sessions: demand.sessionIds.flatMap((sessionId) => {
        const session = sessionById.get(sessionId)
        return session ? [session] : []
      }),
      workspacePath: demand.sessionIds
        .map((sessionId) => sessionById.get(sessionId)?.workspacePath ?? null)
        .find((path): path is string => Boolean(path)) ?? null
    }))
}

export function demandColumns(demands: readonly DemandProjection[]): Record<DemandStatus, DemandProjection[]> {
  return DEMAND_STATUS_IDS.reduce((columns, status) => {
    columns[status] = demands.filter((demand) => demand.status === status)
    return columns
  }, {} as Record<DemandStatus, DemandProjection[]>)
}
