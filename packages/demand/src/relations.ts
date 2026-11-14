import { demandAgentReferenceKey, type DemandAgentReference, type DemandSpaceMemberReference } from './agent-reference.js'
import { qualifiedDemandDispatch } from './dispatch.js'
export * from './agent-reference.js'
import type { Demand, DemandStatus } from './demand-types.js'
import { delegationWorkerHostId } from './delegations.js'

/** Saved witnesses only. Current Runtime discovery/control remains with the Host. */
export function goalSupervisorHostWitnesses(goal: Partial<Pick<Demand, 'supervisorSessionId' | 'creationOrigin' | 'participations' | 'plan' | 'delegations'>>): readonly string[] {
  const sessionId = goal.supervisorSessionId
  if (typeof sessionId !== 'string') return []
  const requester = goal.participations?.find(item => item.id === goal.creationOrigin?.requesterParticipationId && item.agentSessionId === sessionId)
  return [...new Set([
    ...(requester ? [requester.hostId] : []),
    ...(goal.plan?.history ?? []).filter(item => item.change?.assignment.kind !== 'claim' && item.author.kind === 'agent' && item.author.id === sessionId && item.author.hostId).map(item => item.author.hostId!),
    ...(goal.delegations ?? []).filter(item => item.ownerAgentSessionId === sessionId).map(item => item.hostId)
  ])]
}

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
  /** Source-qualified original relationship; never decoded as a Host-qualified identity. */
  sourceQualified: ReadonlyMap<string, { reference: DemandSpaceMemberReference; relations: readonly GoalRelation[] }>
  qualified: ReadonlyMap<string, readonly GoalRelation[]>
  /** Original bare references, never a confirmed relationship to any Host. */
  unqualified: ReadonlyMap<string, readonly GoalRelation[]>
}
export const demandRelationKey = (hostId: string, agentSessionId: string) => JSON.stringify([hostId, agentSessionId])

/** Read original business references; this projection grants no current-work or Runtime authority. */
export function projectDemandRelations(goals: Iterable<GoalRelationSource>): DemandRelations {
  type Target = Map<string, { relation: GoalRelation; roles: Map<string, GoalRelationRole> }>
  const qualified = new Map<string, Target>(), unqualified = new Map<string, Target>(), sourceQualified = new Map<string, Target>()
  const sourceReferences = new Map<string, DemandSpaceMemberReference>()
  const add = (index: Map<string, Target>, key: string, goal: GoalRelationSource, role: GoalRelationRole) => {
    const targets = index.get(key) ?? new Map()
    let target = targets.get(goal.id)
    if (!target) { target = { relation: { goalId: goal.id, title: goal.title, status: goal.status, roles: [] }, roles: new Map() }; targets.set(goal.id, target) }
    target.roles.set(JSON.stringify([role.kind, role.source.kind, role.source.id]), role)
    index.set(key, targets)
  }
  for (const goal of goals) {
    const bare = (ref: DemandAgentReference, kind: GoalRelationRoleKind, field: string) => {
      const role: GoalRelationRole = { kind, source: { kind: 'assignment', id: field } }
      if (typeof ref === 'string') add(unqualified, ref, goal, role)
      else { const key = demandAgentReferenceKey(ref); sourceReferences.set(key, ref); add(sourceQualified, key, goal, role) }
    }
    const exact = (hostId: string, sid: string, kind: GoalRelationRoleKind, source: GoalRelationRole['source']) =>
      add(qualified, demandRelationKey(hostId, sid), goal, { kind, source })
    const member = (reference: DemandSpaceMemberReference, kind: GoalRelationRoleKind, source: GoalRelationRole['source']) => {
      const key = demandAgentReferenceKey(reference); sourceReferences.set(key, reference); add(sourceQualified, key, goal, { kind, source })
    }
    for (const sid of goal.sessionIds ?? []) bare(sid, 'related', 'sessionIds')
    for (const sid of goal.assigneeSessionIds ?? []) bare(sid, 'assignee', 'assigneeSessionIds')
    if (goal.supervisorSessionId) bare(goal.supervisorSessionId, 'supervisor', 'supervisorSessionId')
    for (const item of goal.participations ?? []) exact(item.hostId, item.agentSessionId, item.kind, { kind: 'participation', id: item.id })
    for (const item of goal.dispatches ?? []) {
      if (qualifiedDemandDispatch(item)) member(item.target, 'execution', { kind: 'dispatch', id: item.operationId })
      else {
        exact(item.hostId, item.agentSessionId, 'execution', { kind: 'dispatch', id: item.operationId })
        if (item.execution === 'continue') exact(item.hostId, item.agentSessionId, 'continuation', { kind: 'dispatch', id: item.operationId })
      }
      if (item.attention) exact(item.attention.hostId, item.attention.supervisorAgentSessionId, 'supervisor', { kind: 'dispatch-attention', id: item.attention.operationId })
    }
    for (const item of goal.delegations ?? []) {
      exact(item.hostId, item.ownerAgentSessionId, 'delegation-owner', { kind: 'delegation', id: item.operationId })
      exact(delegationWorkerHostId(item), item.workerAgentSessionId, 'delegation-worker', { kind: 'delegation', id: item.operationId })
      if (item.attention) exact(item.attention.hostId, item.attention.supervisorAgentSessionId, 'supervisor', { kind: 'delegation-attention', id: item.attention.operationId })
    }
    for (const item of goal.progressUpdates ?? []) {
      if ('target' in item.execution) member(item.execution.target, 'execution-progress', { kind: 'progress', id: item.operationId })
      else exact(item.execution.hostId, item.execution.agentSessionId, 'execution-progress', { kind: 'progress', id: item.operationId })
      if (item.handoffExecution) {
        if ('target' in item.handoffExecution) member(item.handoffExecution.target, 'execution-handoff', { kind: 'progress', id: item.operationId })
        else exact(item.handoffExecution.hostId, item.handoffExecution.agentSessionId, 'execution-handoff', { kind: 'progress', id: item.operationId })
      }
    }
  }
  const finish = (index: Map<string, Target>) => new Map([...index].map(([key, targets]) => [key,
    [...targets.values()].map(({ relation, roles }) => ({ ...relation, roles: [...roles.values()] }))]))
  return { qualified: finish(qualified), unqualified: finish(unqualified), sourceQualified: new Map([...finish(sourceQualified)].map(([key, relations]) => [key, { reference: sourceReferences.get(key)!, relations }])) }
}
