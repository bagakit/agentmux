import type { Demand, DemandStatus } from './demand-types.js'

export type GoalRelationRoleKind = 'assignee' | 'supervisor' | 'related' | 'create' | 'discussion' | 'requirements'
  | 'execution' | 'continuation' | 'delegation-owner' | 'delegation-worker' | 'execution-progress' | 'execution-handoff'
export type GoalRelationRole = {
  kind: GoalRelationRoleKind
  source: { kind: 'assignment' | 'participation' | 'dispatch' | 'dispatch-attention' | 'delegation' | 'delegation-attention' | 'progress'; id: string }
}
export type GoalRelation = { goalId: string; title: string; status: DemandStatus; roles: readonly GoalRelationRole[] }
export type GoalRelationSource = Pick<Demand, 'id' | 'title' | 'status'> & Partial<Pick<Demand,
  'sessionIds' | 'assigneeSessionIds' | 'supervisorSessionId' | 'participations' | 'dispatches' | 'delegations' | 'progressUpdates'>>
export type DemandRelations = {
  qualified: ReadonlyMap<string, readonly GoalRelation[]>
  /** Original bare references, never a confirmed relationship to any Host. */
  unqualified: ReadonlyMap<string, readonly GoalRelation[]>
}
export const demandRelationKey = (hostId: string, agentSessionId: string) => JSON.stringify([hostId, agentSessionId])

/** Read original business references; this projection grants no current-work or Runtime authority. */
export function projectDemandRelations(goals: Iterable<GoalRelationSource>): DemandRelations {
  type Target = Map<string, { relation: GoalRelation; roles: Map<string, GoalRelationRole> }>
  const qualified = new Map<string, Target>(), unqualified = new Map<string, Target>()
  const add = (index: Map<string, Target>, key: string, goal: GoalRelationSource, role: GoalRelationRole) => {
    const targets = index.get(key) ?? new Map()
    let target = targets.get(goal.id)
    if (!target) { target = { relation: { goalId: goal.id, title: goal.title, status: goal.status, roles: [] }, roles: new Map() }; targets.set(goal.id, target) }
    target.roles.set(JSON.stringify([role.kind, role.source.kind, role.source.id]), role)
    index.set(key, targets)
  }
  for (const goal of goals) {
    const bare = (sid: string, kind: GoalRelationRoleKind, field: string) => add(unqualified, sid, goal, { kind, source: { kind: 'assignment', id: field } })
    const exact = (hostId: string, sid: string, kind: GoalRelationRoleKind, source: GoalRelationRole['source']) =>
      add(qualified, demandRelationKey(hostId, sid), goal, { kind, source })
    for (const sid of goal.sessionIds ?? []) bare(sid, 'related', 'sessionIds')
    for (const sid of goal.assigneeSessionIds ?? []) bare(sid, 'assignee', 'assigneeSessionIds')
    if (goal.supervisorSessionId) bare(goal.supervisorSessionId, 'supervisor', 'supervisorSessionId')
    for (const item of goal.participations ?? []) exact(item.hostId, item.agentSessionId, item.kind, { kind: 'participation', id: item.id })
    for (const item of goal.dispatches ?? []) {
      exact(item.hostId, item.agentSessionId, 'execution', { kind: 'dispatch', id: item.operationId })
      if (item.execution === 'continue') exact(item.hostId, item.agentSessionId, 'continuation', { kind: 'dispatch', id: item.operationId })
      if (item.attention) exact(item.attention.hostId, item.attention.supervisorAgentSessionId, 'supervisor', { kind: 'dispatch-attention', id: item.attention.operationId })
    }
    for (const item of goal.delegations ?? []) {
      exact(item.hostId, item.ownerAgentSessionId, 'delegation-owner', { kind: 'delegation', id: item.operationId })
      exact(item.hostId, item.workerAgentSessionId, 'delegation-worker', { kind: 'delegation', id: item.operationId })
      if (item.attention) exact(item.attention.hostId, item.attention.supervisorAgentSessionId, 'supervisor', { kind: 'delegation-attention', id: item.attention.operationId })
    }
    for (const item of goal.progressUpdates ?? []) {
      exact(item.execution.hostId, item.execution.agentSessionId, 'execution-progress', { kind: 'progress', id: item.operationId })
      if (item.handoffExecution) exact(item.handoffExecution.hostId, item.handoffExecution.agentSessionId, 'execution-handoff', { kind: 'progress', id: item.operationId })
    }
  }
  const finish = (index: Map<string, Target>) => new Map([...index].map(([key, targets]) => [key,
    [...targets.values()].map(({ relation, roles }) => ({ ...relation, roles: [...roles.values()] }))]))
  return { qualified: finish(qualified), unqualified: finish(unqualified) }
}
