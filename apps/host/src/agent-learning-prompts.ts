import type { AgentLearningBinding, AgentLearningOperation } from '@agentmux/core/agent-learning'
import { getAmuxProtocolTemplate, renderAmuxProtocol } from '@agentmux/core/amux-protocol'

/** These are stage-specific task producers, separate from evidence of adoption. */
export function composeAgentExtraction(operation: Pick<AgentLearningOperation, 'operationId' | 'ownerRuntimeId' | 'source'>): string {
  return renderAmuxProtocol('agent-learning', 'extract', {
    original: JSON.stringify({ hostId: 'local', ...operation })
  })
}

export function composeAgentLearning(binding: AgentLearningBinding, content: string): string {
  const topic = binding.target.kind === 'topic'
  return renderAmuxProtocol('agent-learning', 'learn', {
    operation: binding.operationId,
    binding: JSON.stringify(binding),
    resource: getAmuxProtocolTemplate('agent-learning', topic ? 'topic-resource' : 'mote-resource'),
    targetModule: topic ? 'topic' : 'mote',
    candidate: content
  })
}
