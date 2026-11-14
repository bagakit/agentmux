import type { AgentMuxMessageEnvelope } from './agent-message-envelope.js'
import type { DurableAgentMuxMessage, AgentMuxMessageDeliveryState } from './agent-global-message-queue.js'
import type { ChannelTranscriptQuote } from './channel-quote.js'
import type { JsonReadEntry } from './json-read-fragments.js'
import { AgentMuxError } from './errors.js'

/** An optional narrowing read selector, never additional journal authority. */
export type AgentMuxMessageParticipantSelection =
  | { participantSessionId: string; participantRuntimeId: string }
  | { participantSessionId?: never; participantRuntimeId?: never }
export function parseMessageParticipantSelection(input: { participantSessionId?: unknown; participantRuntimeId?: unknown }):
  { participantSessionId: string; participantRuntimeId: string } | undefined {
  if (input.participantSessionId === undefined && input.participantRuntimeId === undefined) return undefined
  if (![input.participantSessionId, input.participantRuntimeId].every(value => typeof value === 'string' && !!value.trim() && !/[\0\r\n]/u.test(value)))
    throw new AgentMuxError('Select the original participant Session and Runtime together.', 'INVALID_CONTROL_REQUEST')
  return { participantSessionId: input.participantSessionId as string, participantRuntimeId: input.participantRuntimeId as string }
}
/** Missing Runtime fields retain the original journal's local legacy meaning. */
export function messageHasParticipant(envelope: Pick<AgentMuxMessageEnvelope, 'senderSessionId' | 'recipientSessionId' | 'senderRuntimeId' | 'recipientRuntimeId'>,
  agentSessionId: string, runtimeId?: string): boolean {
  return envelope.senderSessionId === agentSessionId && (envelope.senderRuntimeId === undefined || envelope.senderRuntimeId === runtimeId) ||
    envelope.recipientSessionId === agentSessionId && (envelope.recipientRuntimeId === undefined || envelope.recipientRuntimeId === runtimeId)
}

/** Derived original-owner reading facts; never persisted back into the message journal. */
export type AgentMuxMessageReadView = DurableAgentMuxMessage & {
  inputOrigin: import('./agent-input-conversation.js').AgentInputJournalCut | null
}

/** Exact input key from immutable original message facts; no current Session or Run lookup. */
export function originalMessageInputKey(message: DurableAgentMuxMessage): Extract<import('./agent-prompt-condition.js').AgentPromptInputKey, { kind: 'message' }> | null {
  if (message.deliveryMode === 'reference' || message.deliveryMode === 'outbox') return null
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
  ) & AgentMuxMessageParticipantSelection & {
  /** Select this exact notification's metadata for the original message, without consuming it. */
  notificationId?: string
}

export type AgentMuxMessageField = 'body' | 'channelQuote'
export type AgentMuxMessageFieldRead = AgentMuxMessageRead & {
  field: AgentMuxMessageField
  cursor?: string
  maxBytes?: number
}
export type AgentMuxMessageReadRequest = AgentMuxMessageRead & {
  field?: AgentMuxMessageField | undefined
  cursor?: string
  maxBytes?: number
}
/** Exact field bytes only. No full message, unused quote, profile or input wire. */
export type AgentMuxMessageFieldPage = {
  field: AgentMuxMessageField
  sequence: number
  envelope: Omit<AgentMuxMessageEnvelope, 'body' | 'channelQuote' | 'channelProfile'>
  entry: JsonReadEntry<string | ChannelTranscriptQuote | null>
  budgetBytes: number
  nextCursor: string | null
}

export type AgentMuxMessageDirection = 'incoming' | 'outgoing'
export type AgentMuxMessageQuery = {
  participantSessionId: string
  /** Restrict to this journal's original local Runtime participant, including its legacy records. */
  participantRuntimeId?: string
  direction: AgentMuxMessageDirection
  /** Exclusive original sequence cursor; no offsets or mutable timestamps. */
  beforeSequence?: number
  limit?: number
}

/** Bounded original-body prefix, never a separate full-body field or reconstructed wire. */
export type AgentMuxMessageMetadata = {
  sequence: number
  deliveryMode?: 'reference' | 'outbox'
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
