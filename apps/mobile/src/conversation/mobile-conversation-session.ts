import type { AgentMuxAgentSession } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { errorMessage } from './delivery'

export type MobileConversationMetadata = {
  state: 'loading' | 'active' | 'retired' | 'deleted' | 'unconfirmed'
  issue: string | null
}
export type MobileConversationSession = { session: AgentMuxAgentSession | null; metadata: MobileConversationMetadata }

/** Read this original owner's exact identity; a cache miss supplies no lifecycle fact. */
export async function readMobileConversationSession(client: AgentMuxHostedClient, id: string): Promise<MobileConversationSession> {
  try {
    const session = await client.readAgentSession(id)
    if (session) {
      if (session.agentSessionId !== id) throw new Error('返回的对话信息与当前选择不一致。')
      return { session, metadata: { state: 'active', issue: null } }
    }
    const sources = await client.sessionHistorySources({ agentSessionId: id })
    const exact = sources.filter(source => source.agentSessionId === id)
    if (exact.length === 1 && (exact[0]!.state === 'retired' || exact[0]!.state === 'deleted')) {
      return { session: null, metadata: { state: exact[0]!.state, issue: null } }
    }
    return { session: null, metadata: { state: 'unconfirmed', issue: '对话信息还没确认，可以重新核对。' } }
  } catch (error) {
    return { session: null, metadata: { state: 'unconfirmed', issue: errorMessage(error) } }
  }
}
