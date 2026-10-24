import type { AgentMuxMessageEnvelope } from './agent-message-envelope.js'
import type { DurableAgentMuxMessage, AgentMuxMessageDeliveryState } from './agent-global-message-queue.js'

/** Derived original-owner reading facts; never persisted back into the message journal. */
export type AgentMuxMessageReadView = DurableAgentMuxMessage & {
  inputOrigin: import('./agent-input-conversation.js').AgentInputJournalCut | null
}

/** Exact input key from immutable original message facts; no current Session or Run lookup. */
export function originalMessageInputKey(message: DurableAgentMuxMessage): Extract<import('./agent-prompt-condition.js').AgentPromptInputKey, { kind: 'message' }> | null {
  if (message.deliveryMode === 'reference') return null
  const envelope = message.envelope
  const runs = [envelope.recipientRunId, message.admissionIntent?.kind === 'exact-condition'
    ? message.admissionIntent.condition.expectedRun.runId : message.admissionIntent?.expectedRun.runId, message.promptCondition?.expectedRun.runId].filter((id): id is string => Boolean(id))
  if (envelope.recipient.kind !== 'agent-session' || !envelope.recipientSessionId || envelope.recipient.agentSessionId !== envelope.recipientSessionId || !runs.length || runs.some(run => run !== runs[0])) return null
  return { kind: 'message', agentSessionId: envelope.recipientSessionId, expectedRun: { runId: runs[0]! }, messageId: envelope.messageId }
}

/** Select one original immutable message, independently of its consumption. */
export type AgentMuxMessageRead = (
  | { operationId: string; messageId?: never }
  | { messageId: string; operationId?: never }
  ) & {
  /** Select this exact notification's metadata for the original message, without consuming it. */
  notificationId?: string
}

export type AgentMuxMessageDirection = 'incoming' | 'outgoing'
export type AgentMuxMessageQuery = {
  participantSessionId: string
  direction: AgentMuxMessageDirection
  /** Exclusive original sequence cursor; no offsets or mutable timestamps. */
  beforeSequence?: number
  limit?: number
}

/** Bounded original-body prefix, never a separate full-body field or reconstructed wire. */
export type AgentMuxMessageMetadata = {
  sequence: number
  deliveryMode?: 'reference'
  notification?: import('./agent-message-notification.js').AgentMuxMessageNotificationStatus
  envelope: Omit<AgentMuxMessageEnvelope, 'body'>
  delivery: AgentMuxMessageDeliveryState
  bodyPreview: string
  bodyBytes: number
}

export type AgentMuxMessagePage = {
  participantSessionId: string
  direction: AgentMuxMessageDirection
  messages: readonly AgentMuxMessageMetadata[]
  nextBeforeSequence: number | null
}
