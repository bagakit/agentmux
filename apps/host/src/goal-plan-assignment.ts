import { AgentMuxError, type AgentMuxRpcCallContext } from '@agentmux/core'
import type { GoalDelegationAuthority, GoalDelegationParamsMap } from '@agentmux/core/goal-delegation'
import type { Demand, DemandStore } from '@agentmux/demand'
import { delegationWorkerHostId } from '@agentmux/demand/delegations'
import type { GoalPlanAssignmentChange } from '@agentmux/demand/goal-plan'
import { goalSupervisorHostWitnesses, type DemandAgentReference } from '@agentmux/demand/relations'
import type { GoalRuntimePort } from './goal-runtime.js'
import { goalSupervisorRuntimeWitnesses } from './goal-supervisor-identity.js'

type Runtime = Partial<Pick<GoalRuntimePort, 'locateGoalAgentHost'>>
type Request = GoalDelegationParamsMap['goal.plan.assignment' | 'goal.plan.claim']

function denied(message: string): never { throw new AgentMuxError(message, 'CONTROL_PERMISSION_DENIED') }

function originalHost(runtime: Runtime, sessionId: string, expectedHost?: string): string {
  if (!runtime.locateGoalAgentHost) throw new AgentMuxError('The original Goal Agent Host is unconfirmed. Retain its Goal and read its original Session.', 'CONTROL_UNAVAILABLE')
  return runtime.locateGoalAgentHost(sessionId, expectedHost)
}

function assertWorkRole(goal: Demand, claiming: boolean, authority: GoalDelegationAuthority, runtime: Runtime): void {
  const { actor, hostId, runtimeId } = authority
  if (actor.kind !== 'agent') {
    if (claiming) denied('Only an authenticated Agent can claim a node for itself.')
    return
  }
  if (!hostId || !runtimeId) throw new AgentMuxError('The authenticated Agent Host or Runtime is unconfirmed. Read its original Session.', 'CONTROL_UNAVAILABLE')
  const matchesQualified = (ref: DemandAgentReference | null) => ref && typeof ref !== 'string' &&
    ref.execution.agentSessionId === actor.id && ref.execution.runtimeId === runtimeId
  // These execution references were admitted to the current Goal at their original Source.
  if (matchesQualified(goal.supervisorSessionId) || claiming && goal.assigneeSessionIds.some(matchesQualified)) return

  if (goal.supervisorSessionId === actor.id) {
    const hosts = goalSupervisorHostWitnesses(goal), runtimes = goalSupervisorRuntimeWitnesses(goal, actor.id)
    if ((hosts.length ? hosts.length === 1 && hosts[0] === hostId : originalHost(runtime, actor.id) === hostId) &&
        (!runtimes.size || runtimes.size === 1 && runtimes.has(runtimeId))) return
    denied('This action belongs to the original Supervisor Host and Runtime.')
  }
  if (!claiming) denied('Only a person or this Goal’s current Supervisor can manage node assignments.')
  if (!goal.assigneeSessionIds.includes(actor.id)) denied('A related Session has no work role. Claiming requires this Goal’s current Supervisor or assignee.')
  // A bare assignee must resolve uniquely. Earlier claims and delegation receipts
  // keep a Host alias reused by a different Runtime from stealing its original work.
  const matchesOriginal = (goal.plan?.history ?? []).every(entry => entry.change?.assignment.kind !== 'claim' ||
    entry.author.id !== actor.id || entry.author.hostId === hostId && entry.author.runtimeId === runtimeId) &&
    (goal.delegations ?? []).every(entry => entry.workerAgentSessionId !== actor.id ||
      delegationWorkerHostId(entry) === hostId && (!entry.runtimeIdentity || entry.runtimeIdentity.workerRuntimeId === runtimeId))
  if (!matchesOriginal || originalHost(runtime, actor.id) !== hostId) denied('This claim belongs to the original assignee Host and Runtime.')
}

/** This writes the plan only. Starting a delegation still requires its own explicit action. */
export async function changeGoalPlanAssignment(demands: DemandStore, runtime: Runtime, request: Request,
  context: AgentMuxRpcCallContext, authority: GoalDelegationAuthority): Promise<void> {
  const change: GoalPlanAssignmentChange = { nodeId: request.nodeId, assignment: 'assignment' in request ? request.assignment : { kind: 'claim' } }
  context.signal?.throwIfAborted()
  await context.assertCurrent?.()
  await demands.changePlanAssignment(request.goalId, request.expectedRevision, request.operationId, change,
    { ...authority.actor, ...(authority.hostId ? { hostId: authority.hostId } : {}), ...(authority.runtimeId ? { runtimeId: authority.runtimeId } : {}) }, current => {
      context.signal?.throwIfAborted()
      assertWorkRole(current, change.assignment.kind === 'claim', authority, runtime)
      if (change.assignment.kind === 'assign') {
        const target = change.assignment.executor
        if (originalHost(runtime, target.agentSessionId, target.hostId) !== target.hostId)
          throw new AgentMuxError('The selected executor has no confirmed identity at this Host. Read its original Session.', 'CONTROL_UNAVAILABLE')
      }
    })
}
