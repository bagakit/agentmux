import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'

/** The original selected Hosted owner stays fixed for this conversation's notice reader. */
export function createMobileMoteInputReader(client: AgentMuxHostedClient | null, recipient: string | null): NonNullable<ClientUiPlatform['readMoteInput']> {
  return async (owner, memberAgentSessionId, observationId) => {
    if (!client || owner.routeHostId !== 'local' || owner.recipientAgentSessionId !== recipient)
      throw new Error('原通知的 Host 或主 Agent 尚未匹配；原通知与当前输入仍保留。')
    return client.inspectMoteInput({ agentSessionId: memberAgentSessionId, observationId })
  }
}
