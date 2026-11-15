import { AgentMuxError, type AgentMuxRpcCallContext } from '@agentmux/core'
import type { GoalDelegationAuthority, GoalDelegationParamsMap } from '@agentmux/core/goal-delegation'
import type { DemandStore } from '@agentmux/demand'
import type { GoalPlanAssignmentChange, GoalPlanOwner } from '@agentmux/demand/goal-plan'
import { goalPlanWorkRoles, type GoalPlanWorkRole } from '@agentmux/demand/relations'
import type { GoalRuntimePort } from './goal-runtime.js'

type Runtime = Partial<Pick<GoalRuntimePort, 'locateGoalAgentHost'>>
type Request = GoalDelegationParamsMap['goal.plan.assignment' | 'goal.plan.claim']

function denied(message: string): never { throw new AgentMuxError(message, 'CONTROL_PERMISSION_DENIED') }

function originalHost(runtime: Runtime, sessionId: string, expectedHost?: string): string {
  if (!runtime.locateGoalAgentHost) throw new AgentMuxError('The original Goal Agent Host is unconfirmed. Retain its Goal and read its original Session.', 'CONTROL_UNAVAILABLE')
  return runtime.locateGoalAgentHost(sessionId, expectedHost)
}

export function assertPlanWorkRole(role: GoalPlanWorkRole | undefined, claiming: boolean, authority: GoalDelegationAuthority, runtime: Runtime): void {
  const { actor, hostId, runtimeId } = authority
  if (actor.kind !== 'agent') {
    if (claiming) denied('Only an authenticated Agent can claim a node for itself.')
    return
  }
  if (!hostId || !runtimeId) throw new AgentMuxError('The authenticated Agent Host or Runtime is unconfirmed. Read its original Session.', 'CONTROL_UNAVAILABLE')
  if (role?.supervisorRuntimes.includes(runtimeId) || claiming && role?.assigneeRuntimes.includes(runtimeId)) return
  if (role?.supervisor) {
    const { hosts, runtimes } = role.supervisor
    if ((hosts.length ? hosts.length === 1 && hosts[0] === hostId : originalHost(runtime, actor.id) === hostId) &&
        (!runtimes.length || runtimes.length === 1 && runtimes[0] === runtimeId)) return
    denied('This action belongs to the original Supervisor Host and Runtime.')
  }
  if (!claiming) denied('Only a person or this Goal’s current Supervisor can manage node assignments.')
  if (!role?.assignee) denied('A related Session has no work role. Claiming requires this Goal’s current Supervisor or assignee.')
  const matchesOriginal = role.assignee.bindings.every(binding => binding.hostId === hostId && (binding.runtimeId === null || binding.runtimeId === runtimeId))
  if (!matchesOriginal || originalHost(runtime, actor.id) !== hostId) denied('This claim belongs to the original assignee Host and Runtime.')
}

/** This writes the plan only. Starting a delegation still requires its own explicit action. */
export async function changeGoalPlanAssignment(demands: DemandStore, runtime: Runtime, request: Request,
  context: AgentMuxRpcCallContext, authority: GoalDelegationAuthority, owner?: GoalPlanOwner): Promise<void> {
  const change: GoalPlanAssignmentChange = { nodeId: request.nodeId, assignment: 'assignment' in request ? request.assignment : { kind: 'claim' } }
  context.signal?.throwIfAborted()
  await context.assertCurrent?.()
  await demands.changePlanAssignment(request.goalId, 'claimToken' in request ? request.claimToken : request.expectedRevision, request.operationId, change,
    { ...authority.actor, ...(authority.hostId ? { hostId: authority.hostId } : {}), ...(authority.runtimeId ? { runtimeId: authority.runtimeId } : {}) }, current => {
      context.signal?.throwIfAborted()
      assertPlanWorkRole(authority.actor.kind === 'agent' ? goalPlanWorkRoles(current).get(authority.actor.id) : undefined, change.assignment.kind === 'claim', authority, runtime)
      if (change.assignment.kind === 'assign') {
        const target = change.assignment.executor
        if (originalHost(runtime, target.agentSessionId, target.hostId) !== target.hostId)
          throw new AgentMuxError('The selected executor has no confirmed identity at this Host. Read its original Session.', 'CONTROL_UNAVAILABLE')
      }
    }, owner)
}
