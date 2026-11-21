import { formatGoalAddress, type AmuxGoalAddress } from '@agentmux/core/sharing'
import { currentGoalGrounding } from '@agentmux/demand/goal-grounding'
import { goalPlanState, projectGoalPlan, type GoalPlanOwner } from '@agentmux/demand/goal-plan'
import type { Demand } from '@agentmux/demand/types'
import type { AgentMuxDemand } from '@agentmux/core/control'

/** Every plan this owner returns carries its derivation of the node states. */
export function hostGoalPlan(goal: Pick<Demand, 'id' | 'plan' | 'delegations' | 'alignment'>, owner?: Pick<AmuxGoalAddress, 'runtimeId' | 'namespace'>): Pick<AgentMuxDemand, 'plan' | 'planState'> {
  const { plan } = goal
  return plan ? { plan, planState: goalPlanState(hostPlanProjection(goal, plan, owner)) } : {}
}

function hostPlanProjection(goal: Pick<Demand, 'id' | 'delegations' | 'alignment'>, plan: NonNullable<Demand['plan']>, owner?: Pick<AmuxGoalAddress, 'runtimeId' | 'namespace'>) {
  return projectGoalPlan(plan, goal.delegations ?? [], goal.alignment?.criteria ?? [],
    owner ? { ...owner, goalId: goal.id } : undefined, goal.alignment?.revision)
}

export function hostGoalResult(goal: Demand, owner?: Pick<AmuxGoalAddress, 'runtimeId' | 'namespace'>): Pick<AgentMuxDemand, 'plan' | 'planState' | 'grounding'> {
  const { plan } = goal
  const projection = plan ? hostPlanProjection(goal, plan, owner) : undefined
  const grounding = currentGoalGrounding(goal, projection)
  return { ...(plan && projection ? { plan, planState: goalPlanState(projection) } : {}), ...(grounding ? { grounding } : {}) }
}

/** Project the original durable record; no Renderer selection or cached board facts. */
export function projectHostGoal(goal: Demand, address?: AmuxGoalAddress): AgentMuxDemand {
  return { id: goal.id, ...(address === undefined ? {} : { address }), title: goal.title, description: goal.description, status: goal.status, priority: goal.priority,
    projectId: goal.projectId, projectName: goal.projectName, executorId: goal.executorId, assigneeSessionIds: [...goal.assigneeSessionIds],
    supervisorSessionId: goal.supervisorSessionId, participations: [...goal.participations],
    ...(goal.creationOrigin ? { creationOrigin: goal.creationOrigin } : {}),
    ...(goal.discussionOperationId ? { discussionOperationId: goal.discussionOperationId } : {}), tags: [...goal.tags],
    plannedStartAt: goal.plannedStartAt, targetAt: goal.targetAt, parentDemandId: goal.parentDemandId, phaseIndex: goal.phaseIndex ?? null,
    decisions: goal.decisions, activityLog: goal.activities.map(activity => `${activity.kind}: ${activity.message}`), activities: goal.activities,
    ...(goal.delegations ? { delegations: goal.delegations } : {}), ...(goal.dispatches ? { dispatches: goal.dispatches } : {}),
    ...(goal.progressUpdates ? { progressUpdates: goal.progressUpdates } : {}), ...(goal.patrols ? { patrols: goal.patrols } : {}), ...hostGoalResult(goal, address),
    sessionIds: [...goal.sessionIds], ...(goal.contentRefs ? { contentRefs: goal.contentRefs } : {}),
    createdAt: goal.createdAt, updatedAt: goal.updatedAt, source: 'default-topic',
    ...(goal.alignment ? { alignment: goal.alignment } : {}) }
}

/** Original board facts; private Host launch context is not a client-owned fact. */
export function hostGoalRecord(goal: AgentMuxDemand): Demand & Pick<AgentMuxDemand, 'planState' | 'planStateIssue' | 'address' | 'addressIssue' | 'approvalObservations' | 'approvalObservationIssue'> {
  if (!goal.activities || !goal.decisions || !goal.tags || goal.executorId === undefined || goal.plannedStartAt === undefined ||
      goal.targetAt === undefined || goal.parentDemandId === undefined)
    throw new Error('The original Host did not return the complete Goal record. Its retained view remains available.')
  const { source: _source, activityLog: _log, ...record } = goal
  return { ...record, activities: goal.activities, decisions: goal.decisions, tags: goal.tags, executorId: goal.executorId,
    plannedStartAt: goal.plannedStartAt, targetAt: goal.targetAt, parentDemandId: goal.parentDemandId }
}

/** Canonical public Goal names are decoded explicitly at the client transport boundary. */
export function publicGoalRecord(goal: import('@agentmux/core').AgentMuxRpcGoal): ReturnType<typeof hostGoalRecord> {
  const { parentGoalId, ...record } = goal
  return hostGoalRecord({ ...record, ...(parentGoalId === undefined ? {} : { parentDemandId: parentGoalId }) })
}

export function hostGoalAddress(goal: Pick<Demand, 'id' | 'creationOrigin'>, owner: GoalPlanOwner): AmuxGoalAddress {
  return formatGoalAddress(goal.id, owner.runtimeId, owner.namespace,
    goal.creationOrigin?.inputRuntimeId === owner.runtimeId ? goal.creationOrigin.operationId : undefined)
}
