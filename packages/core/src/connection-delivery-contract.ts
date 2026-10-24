import type { ConnectionDeliverySourceObservation } from './connection-diagnosis-source.js'
import type { ConversationItemRef } from './conversation.js'
import type { ConnectionApplication } from './connections-contract.js'
import type { RoomBindingCallContext } from './room-binding-contract.js'
import type { ConversationContentRef, ConversationSourceRef } from './conversation-stream.js'
import type { ConversationVersionedAnchor } from './conversation-changes.js'
import type { AgentSessionUserMessageAuthor } from './types.js'

export type ConnectionDeliveryEvent = { id: string; revision: string }
/** Recorded original attribution; application relay is not platform personal-send authority. */
export type ConnectionDeliveryRelay = {
  sender: 'application'
  sources: Array<{ part: ConversationContentRef; author: AgentSessionUserMessageAuthor }>
}
/** Durable content accounting, distinct from an unknown platform effect. No original body is copied. */
export type ConnectionDeliveryGap = {
  gapId: string
  event?: ConnectionDeliveryEvent
  part?: ConversationContentRef
  anchor?: ConversationVersionedAnchor
  source?: ConversationSourceRef
  /** Exact source-reported reading target; absence does not authorize guessing one. */
  record?: ConversationItemRef
  code?: string
  reason: 'public-content-unconfirmed' | 'transport-unsupported' | 'resource-unavailable' | 'start-cut-unconfirmed' | 'source-gap' | 'version-unavailable'
}
export type ConnectionOriginRepresentation = {
  event: ConnectionDeliveryEvent
  part: ConversationContentRef
  origin: { connectionId: string; externalConversationId: string; externalMessageId: string }
}
export type ConnectionDeliveryCoverage = {
  state: 'complete' | 'incomplete'
  gaps: ConnectionDeliveryGap[]
  nextContent: string | null
  origins: ConnectionOriginRepresentation[]
}

export type ConnectionDeliveryReference = ConversationItemRef | { hostId: string; agentSessionId: string; source: { kind: 'ingress'; ingressId: string } } | { hostId: string; agentSessionId: string; source: { kind: 'binding-operation'; operationId: string; event: import('./room-binding-contract.js').RoomBindingNoticeEvent } } | { hostId: string; agentSessionId: string; source: { kind: 'interaction'; runId: string; requestId: string; requestDigest: string } }

export type ConnectionDeliveryState = 'pending' | 'dispatching' | 'unknown' | 'confirmed' | 'not-applied' | 'cancelled' | 'superseded'
export type ConnectionDeliveryReceiptReason = 'effect-unconfirmed' | 'platform-rejected' | 'adapter-unavailable' | 'platform-unavailable' | 'rate-limited' | 'thread-unavailable' | 'unsupported-format'
export type ConnectionDeliveryReason = ConnectionDeliveryReceiptReason | 'binding-revised' | 'original-speech-withdrawn' | 'outside-conversation-scope' | 'private-content' | 'public-content-unconfirmed' | 'version-unavailable'
export type ConnectionDeliveryMapping = { messageId: string; threadId?: string; reactionId?: string }
/** Original platform outcome remains separate from the operation's current queue fate. */
export type ConnectionDeliveryReceipt =
  | { state: 'confirmed'; mapping: ConnectionDeliveryMapping }
  | { state: 'unknown' | 'not-applied'; reason: ConnectionDeliveryReceiptReason }
/** A safe observation of one original external effect. No body, prepared wire or credentials cross this boundary. */
export type ConnectionDelivery = {
  operationId: string
  projectionId: string
  sourceRevision: string
  bindingId: string
  bindingRevision: number
  reference: ConnectionDeliveryReference
  target: { connectionId: string; application: ConnectionApplication; externalConversationId: string }
  effect: 'upsert' | 'withdraw'
  fragment: { ordinal: number; count: number }
  state: ConnectionDeliveryState
  predecessorOperationId?: string
  mapping?: ConnectionDeliveryMapping
  reason?: ConnectionDeliveryReason
  receipt?: ConnectionDeliveryReceipt
  event?: ConnectionDeliveryEvent
  /** Milestone on the original external query, not another authored message. */
  queryFeedback?: { stage: 'received' | 'started' | 'completed'; ingressId: string; messageId: string }
  relay?: ConnectionDeliveryRelay
  /** Resource upload is distinct from the original chat-message effect. No bytes or platform asset key are exposed. */
  resourceUpload?: { kind: 'image' | 'file'; part: ConversationContentRef; attempt: number; state: 'pending' | 'dispatching' | 'unknown' | 'confirmed' }
}
/** Lane-level source, qualification or effect observation for this Binding scope. Each original delivery receipt owns its specific platform result; this is not Agent health. */
export type ConnectionDeliveryObservation = {
  state: 'unknown' | 'ready' | 'unavailable' | 'disabled'
  reason?: 'not-started' | 'access-unconfirmed' | 'source-unconfirmed' | 'source-gap' | 'content-unconfirmed' | 'storage-unconfirmed' | 'adapter-unavailable' | 'credential-missing' | 'credential-format-unsupported' | 'credential-unavailable' | 'effect-unconfirmed'
}
export type ConnectionDeliveryOperationInput = { operationId: string }
export type ConnectionDeliveryListInput = { connectionId: string; bindingId: string; bindingRevision: number; after?: string; afterContent?: string; limit?: number; order?: 'oldest' | 'newest' }
export type ConnectionDeliveryParamsMap = {
  'connection.delivery.inspect': ConnectionDeliveryOperationInput
  'connection.delivery.ls': ConnectionDeliveryListInput
  'connection.delivery.retry': ConnectionDeliveryOperationInput
}
export type ConnectionDeliveryResultMap = {
  'connection.delivery.inspect': { delivery: ConnectionDelivery | null }
  'connection.delivery.ls': { deliveries: ConnectionDelivery[]; next: string | null; observation?: ConnectionDeliveryObservation; sourceObservation?: ConnectionDeliverySourceObservation; effectObservation?: ConnectionDeliveryObservation; coverage?: ConnectionDeliveryCoverage }
  'connection.delivery.retry': { delivery: ConnectionDelivery }
}
export type ConnectionDeliveryMethod = keyof ConnectionDeliveryParamsMap
/** Borrow the exact Host owner. Retry keeps the same message identity: known non-application, or an upload whose message was never attempted. */
export interface ConnectionDeliveryPort {
  inspect(input: ConnectionDeliveryOperationInput): Promise<ConnectionDeliveryResultMap['connection.delivery.inspect']>
  list(input: ConnectionDeliveryListInput): Promise<ConnectionDeliveryResultMap['connection.delivery.ls']>
  retry(input: ConnectionDeliveryOperationInput, context: RoomBindingCallContext): Promise<ConnectionDeliveryResultMap['connection.delivery.retry']>
}
