import { spatialAgentOpenRecord } from '@agentmux/core/spatial-state'
import { AgentMuxError, type AgentMuxAgentSession } from '@agentmux/core'
import { contributeGoalDiscussionBinding, parseGoalDiscussionBinding, resolveGoalDiscussionBinding,
  type GoalDiscussionHandoff } from '@agentmux/host/goal-discussion-bindings'

/** Called only after the original Desktop sender has been authenticated by Main. */
export async function handoffGoalDiscussion(input: GoalDiscussionHandoff, ports: {
  spatial: Parameters<typeof contributeGoalDiscussionBinding>[0]['spatial']
  goal(goalId: string): Promise<{ id: string; discussionOperationId?: string } | null>
  agent(hostId: string, agentSessionId: string): Promise<AgentMuxAgentSession>
}) {
  if (!input || Object.keys(input).some(key => key !== 'goalId' && key !== 'binding') || typeof input.goalId !== 'string' || !input.goalId || input.goalId.includes('\0'))
    throw new AgentMuxError('The original saved Goal discussion reference is invalid.', 'INVALID_CONTROL_REQUEST')
  const binding = parseGoalDiscussionBinding(input.binding)
  const goal = await ports.goal(input.goalId), state = await ports.spatial.read()
  if (goal?.id !== input.goalId || !state) throw new AgentMuxError('The original Goal or Core workface is unconfirmed. Its saved Desktop relationship is retained.', 'GOAL_DISCUSSION_UNCONFIRMED')
  resolveGoalDiscussionBinding(state.graph, binding)
  if (goal.discussionOperationId) {
    const creation = spatialAgentOpenRecord(state.graph, goal.discussionOperationId)
    if (!creation || binding.recipient.kind !== 'agent' || creation.address.tabId !== binding.tabId || creation.address.regionId !== binding.regionId ||
        creation.execution.hostId !== binding.recipient.hostId || creation.agentSessionId !== binding.recipient.agentSessionId)
      throw new AgentMuxError('The saved Desktop discussion conflicts with this Goal’s original Host creation. Both sources are retained for review.', 'GOAL_DISCUSSION_UNCONFIRMED')
  }
  if (binding.recipient.kind === 'agent') {
    const agent = await ports.agent(binding.recipient.hostId, binding.recipient.agentSessionId)
    if (agent.kind !== 'agent' || agent.agentSessionId !== binding.recipient.agentSessionId)
      throw new AgentMuxError('The exact original discussion Session is unconfirmed on its execution Host. Its saved relationship is retained.', 'GOAL_DISCUSSION_UNCONFIRMED')
  }
  return contributeGoalDiscussionBinding({ spatial: ports.spatial, goalId: input.goalId, binding })
}
