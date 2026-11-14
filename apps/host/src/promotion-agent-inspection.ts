import { AgentMuxError, type AgentMuxRpcCallContext, type AgentMuxRpcParams, type AgentMuxRpcResult } from '@agentmux/core'
import type { AgentPromotionTarget } from '@agentmux/core/agent-promotion'
import type { PromotionAgentInspection } from './agent-promotion.js'

/** The selected original Host supplies Runtime/Session identity; a display Region supplies no execution authority. */
export async function inspectPromotionAgent(call: (hostId: string, params: AgentMuxRpcParams<'agent.inspect'>, context?: AgentMuxRpcCallContext) => Promise<{ runtimeId: string; inspection: AgentMuxRpcResult<'agent.inspect'> }>,
  target: AgentPromotionTarget, context?: AgentMuxRpcCallContext): Promise<PromotionAgentInspection> {
  const { runtimeId, inspection: result } = await call(target.hostId, { target: { kind: 'agent-session', agentSessionId: target.agentSessionId } }, context)
  if (!runtimeId || result.routeHostId !== 'local' || !result.session || result.session.kind !== 'agent' || result.session.agentSessionId !== target.agentSessionId)
    throw new AgentMuxError('The original Agent identity is unconfirmed. No new promotion was admitted.', 'AGENT_PROMOTION_SOURCE_UNCONFIRMED')
  return { hostId: target.hostId, agentSessionId: result.session.agentSessionId, runId: result.session.run.runId, cwd: result.session.workspacePath, runtimeId }
}
