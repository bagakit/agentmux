import { mobileCapability, type MobileConversationClient } from './mobile-conversation-client'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'

/** The original selected Hosted owner stays fixed for this conversation's notice reader. */
export function createMobileMoteInputReader(client: MobileConversationClient | null, recipient: string | null): NonNullable<ClientUiPlatform['readMoteInput']> {
  return async (owner, memberAgentSessionId, observationId) => {
    if (!client || owner.routeHostId !== 'local' || owner.recipientAgentSessionId !== recipient)
      throw new Error('这条通知的 Mac 或主 Agent 还没对上。')
    return mobileCapability(client, 'inspectMoteInput')({ agentSessionId: memberAgentSessionId, observationId })
  }
}
