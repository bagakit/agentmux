import type { AgentMuxMessageEnvelope } from './agent-message-envelope.js'
import type { AgentMuxMessageDeliveryState } from './agent-global-message-queue.js'

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
