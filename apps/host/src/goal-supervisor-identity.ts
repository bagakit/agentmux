import { AgentMuxError } from '@agentmux/core'
import type { Demand } from '@agentmux/demand'
import type { GoalDelegationAuthority } from '@agentmux/core/goal-delegation'
import { goalSupervisorHostWitnesses } from '@agentmux/demand/relations'

type Runtime = { resolveGoalAgent?(agentSessionId: string): Promise<{ hostId: string }> }

/** Saved role witnesses qualify a Session id without reselecting another Runtime's namesake. */
export async function goalSupervisorHost(goal: Demand, runtime: Runtime): Promise<string> {
  const sessionId = goal.supervisorSessionId
  if (sessionId && typeof sessionId !== 'string') throw new AgentMuxError('The Source-qualified Supervisor requires its original current actor and qualified action. Existing Agents and legacy work remain available.', 'CONTROL_UNAVAILABLE')
  if (!sessionId) throw new AgentMuxError('This Goal has no current Supervisor. Original work and input remain available.', 'CONTROL_UNAVAILABLE')
  const hosts = goalSupervisorHostWitnesses(goal)
  if (hosts.length === 1) return hosts[0]!
  if (hosts.length > 1) throw new AgentMuxError('The current Supervisor has conflicting retained Host bindings. Keep its original identities and resolve that exact relationship.', 'AMBIGUOUS_AGENT_SESSION')
  if (!runtime.resolveGoalAgent) throw new AgentMuxError('The current Supervisor Host is not yet confirmed. Its original work and native input remain available.', 'CONTROL_UNAVAILABLE')
  return (await runtime.resolveGoalAgent(sessionId)).hostId
}

export function goalSupervisorRuntimeWitnesses(goal: Demand, id: string): Set<string> {
  return new Set([
    ...(goal.plan?.history ?? []).filter(item => item.change?.assignment.kind !== 'claim' && item.author.kind === 'agent' && item.author.id === id && item.author.runtimeId).map(item => item.author.runtimeId!),
    ...(goal.delegations ?? []).filter(item => item.ownerAgentSessionId === id && item.runtimeIdentity).map(item => item.runtimeIdentity!.ownerRuntimeId)
  ])
}

export async function isGoalSupervisor(goal: Demand, authority: GoalDelegationAuthority, runtime: Runtime): Promise<boolean> {
  if (authority.actor.kind !== 'agent') return true
  if (authority.actor.id !== goal.supervisorSessionId) return false
  const runtimes = goalSupervisorRuntimeWitnesses(goal, authority.actor.id)
  if (runtimes.size > 1) throw new AgentMuxError('The current Supervisor has conflicting original Core Runtime identities. Keep its original work and resolve the exact relationship.', 'AMBIGUOUS_AGENT_SESSION')
  if (runtimes.size === 1) return authority.runtimeId === [...runtimes][0]
  return authority.hostId === await goalSupervisorHost(goal, runtime)
}
