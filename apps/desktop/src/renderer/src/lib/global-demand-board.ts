import type { DemandContentReference } from '@agentmux/demand'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { AgentMuxDemandDecision } from '@agentmux/core/control'
import type { DemandActivity, DemandDecision } from '@agentmux/demand'
import type { DemandAlignment, DemandGrounding } from '@agentmux/demand/goals'

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
  assigneeSessionIds?: string[]
  supervisorSessionId?: string | null
  participations?: import('@agentmux/demand').DemandParticipation[]
  creationOrigin?: import('@agentmux/demand').DemandCreationOrigin
  tags?: string[]
  plannedStartAt?: number | null
  targetAt?: number | null
  parentDemandId?: string | null
  phaseIndex?: number | null
  activityLog?: string[]
  sessionIds: string[]
  contentRefs?: DemandContentReference[]
  createdAt: number
  updatedAt: number
  source: 'default-topic' | 'session'
  decisionLog?: AgentMuxDemandDecision[]
  delegations?: import('@agentmux/demand').DemandDelegation[]
  /** Last original-owner observation; transient reading facts, never persisted Goal state. */
  delegationObservations?: NonNullable<import('@agentmux/core/goal-delegation').GoalDelegationResult['observations']>
  delegationObservationIssue?: string
  delegationReadCut?: { goalUpdatedAt: number; request: number }
  dispatches?: import('@agentmux/demand').DemandDispatch[]
  activities?: DemandActivity[]
  decisions?: DemandDecision[]
  alignment?: DemandAlignment
  grounding?: DemandGrounding
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
