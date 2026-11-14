import type { AgentMuxHostedClient } from '@agentmux/core/hosted'

/** The actual capabilities consumed by this view. A member never borrows a
 * missing operation from the connected Source's namesake Session. */
export type MobileConversationClient = Pick<AgentMuxHostedClient, 'dispose' | 'readAgentInputEpoch' | 'readAgentConversation' | 'conversationCheckpoint' |
  'readConversationChanges' | 'releaseConversationView' | 'observeConversation' | 'readAgentSessionHistory' | 'sessionHistoryResource' | 'readAgentInputMailbox'> & Partial<Pick<AgentMuxHostedClient,
  'connect' | 'agentSession' | 'agentSessions' | 'catalog' | 'providers' | 'onEvent' | 'runtimeOwnerIdentity' |
  'statusAgent' | 'readAgentSession' | 'sessionHistorySources' | 'sessionObservation' |
  'forwardRpc' | 'readMessage' | 'inspectMoteInput' | 'submitAgentPrompt' | 'inspectAgentInput' |
  'inspectAgentPromptSubmission' | 'stopAgentInputWaiting' | 'rejoinAgentInputWaiting' |
  'inspectAgentInteractionOperation' | 'respondAgentInteraction' | 'replySessionQuestion' |
  'inspectAgentPosture' | 'setAgentPosture' | 'signalAgent' | 'ensureAgentContinuity' |
  'runtimeIdentity' | 'reattachAgent' | 'readRunReplay' | 'releaseRunAttachment' | 'writeAgent' | 'resizeAgent'>>

export type MobileTerminalClient = Pick<AgentMuxHostedClient, 'runtimeIdentity' | 'agentSession' | 'onEvent' |
  'reattachAgent' | 'readRunReplay' | 'releaseRunAttachment' | 'writeAgent' | 'resizeAgent'>
export function hasMobileTerminal(client: MobileConversationClient | null): client is MobileConversationClient & MobileTerminalClient {
  return !!client && (['runtimeIdentity', 'agentSession', 'onEvent', 'reattachAgent', 'readRunReplay',
    'releaseRunAttachment', 'writeAgent', 'resizeAgent'] as const).every(method => typeof client[method] === 'function')
}

export function mobileCapability<K extends keyof MobileConversationClient>(client: MobileConversationClient | null | undefined,
  method: K): NonNullable<MobileConversationClient[K]> {
  const operation = client?.[method]
  if (typeof operation !== 'function') throw Object.assign(new Error('原目标尚未提供这项操作能力；原对话和草稿保持不变。'), { code: 'MOBILE_MEMBER_CAPABILITY_UNCONFIRMED', capability: method })
  return operation.bind(client) as NonNullable<MobileConversationClient[K]>
}
