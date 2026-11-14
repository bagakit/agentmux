import type { AgentMuxAgentSession } from '@agentmux/core'
import { mobileCapability, type MobileConversationClient } from './mobile-conversation-client'
import { errorMessage } from './delivery'

export type MobileConversationMetadata = {
  state: 'loading' | 'active' | 'retired' | 'deleted' | 'unconfirmed'
  issue: string | null
}
export type MobileConversationSession = { session: AgentMuxAgentSession | null; metadata: MobileConversationMetadata }

/** Read this original owner's exact identity; a cache miss supplies no lifecycle fact. */
export async function readMobileConversationSession(client: MobileConversationClient, id: string): Promise<MobileConversationSession> {
  try {
    let session: AgentMuxAgentSession | null = null
    try { session = await mobileCapability(client, 'readAgentSession')(id) }
    catch (error) {
      // A deleted current row can reject its point read; still require the exact
      // retained descriptor before adopting any terminal record state.
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'AGENT_SESSION_RECORD_DELETED') throw error
    }
    if (session) {
      if (session.agentSessionId !== id) throw new Error('对话当前不能投递：返回的对话信息与当前选择不一致。')
      return { session, metadata: { state: 'active', issue: null } }
    }
    const sources = await mobileCapability(client, 'sessionHistorySources')({ agentSessionId: id })
    const exact = sources.filter(source => source.agentSessionId === id)
    if (exact.length === 1 && (exact[0]!.state === 'retired' || exact[0]!.state === 'deleted')) {
      return { session: null, metadata: { state: exact[0]!.state, issue: null } }
    }
    return { session: null, metadata: { state: 'unconfirmed', issue: '对话信息还没确认，可以重新核对。' } }
  } catch (error) {
    return { session: null, metadata: { state: 'unconfirmed', issue: errorMessage(error) } }
  }
}
