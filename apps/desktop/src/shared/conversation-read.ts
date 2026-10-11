import type { AgentMuxClient } from '@agentmux/core'
import type { ConversationObservation, ConversationReadOptions, ConversationWatchInput, ConversationWatchOpening } from '@agentmux/core/conversation'
import type { SessionInputOperationResult } from './contracts'

/** The original public Reader methods; Desktop adds only bridge cancellation. */
export type ConversationReadApi = Pick<AgentMuxClient,
  'readAgentConversation' | 'readConversationChanges' | 'observeConversation' | 'releaseConversationView'>
type BridgeOptions = { onAbort?: (cancel: () => void) => () => void }
export type ConversationReadPreloadApi = {
  readAgentConversation(input: Parameters<ConversationReadApi['readAgentConversation']>[0], options?: BridgeOptions): Promise<SessionInputOperationResult<Awaited<ReturnType<ConversationReadApi['readAgentConversation']>>>>
  readConversationChanges(input: Parameters<ConversationReadApi['readConversationChanges']>[0], options?: BridgeOptions): Promise<SessionInputOperationResult<Awaited<ReturnType<ConversationReadApi['readConversationChanges']>>>>
  releaseConversationView(input: Parameters<ConversationReadApi['releaseConversationView']>[0]): Promise<SessionInputOperationResult<Awaited<ReturnType<ConversationReadApi['releaseConversationView']>>>>
  observeConversation(input: ConversationWatchInput, listener: (value: ConversationObservation) => void,
    options?: BridgeOptions & { onEnd?(message?: string): void }): Promise<SessionInputOperationResult<ConversationWatchOpening & { dispose(): void }>>
}
export type ConversationReadEvent = { token: string } & ({ observation: ConversationObservation } | { ended: true; message?: string })
export const CONVERSATION_READ_EVENT = 'conversation:observation'
export type { ConversationReadOptions }
