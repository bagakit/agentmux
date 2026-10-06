import type { ConversationItemRef } from './conversation.js'
import type { ConnectionApplication } from './connections-contract.js'
import type { RoomBindingCallContext } from './room-binding-contract.js'

export type ConnectionDeliveryState = 'pending' | 'dispatching' | 'unknown' | 'confirmed' | 'not-applied' | 'cancelled' | 'superseded'
export type ConnectionDeliveryReceiptReason = 'effect-unconfirmed' | 'platform-rejected' | 'adapter-unavailable' | 'platform-unavailable' | 'rate-limited' | 'thread-unavailable' | 'unsupported-format'
export type ConnectionDeliveryReason = ConnectionDeliveryReceiptReason | 'original-speech-withdrawn'
export type ConnectionDeliveryMapping = { messageId: string; threadId?: string }
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
  reference: ConversationItemRef
  target: { connectionId: string; application: ConnectionApplication; externalConversationId: string }
  effect: 'upsert' | 'withdraw'
  fragment: { ordinal: number; count: number }
  state: ConnectionDeliveryState
  predecessorOperationId?: string
  mapping?: ConnectionDeliveryMapping
  reason?: ConnectionDeliveryReason
  receipt?: ConnectionDeliveryReceipt
}
export type ConnectionDeliveryOperationInput = { operationId: string }
export type ConnectionDeliveryListInput = { connectionId: string; bindingId: string; bindingRevision: number; after?: string; limit?: number }
export type ConnectionDeliveryParamsMap = {
  'connection.delivery.inspect': ConnectionDeliveryOperationInput
  'connection.delivery.ls': ConnectionDeliveryListInput
  'connection.delivery.retry': ConnectionDeliveryOperationInput
}
export type ConnectionDeliveryResultMap = {
  'connection.delivery.inspect': { delivery: ConnectionDelivery | null }
  'connection.delivery.ls': { deliveries: ConnectionDelivery[]; next: string | null }
  'connection.delivery.retry': { delivery: ConnectionDelivery }
}
export type ConnectionDeliveryMethod = keyof ConnectionDeliveryParamsMap
/** Borrow the exact Host owner. Only it can authorize an explicit same-ID retry after known non-application. */
export interface ConnectionDeliveryPort {
  inspect(input: ConnectionDeliveryOperationInput): Promise<ConnectionDeliveryResultMap['connection.delivery.inspect']>
  list(input: ConnectionDeliveryListInput): Promise<ConnectionDeliveryResultMap['connection.delivery.ls']>
  retry(input: ConnectionDeliveryOperationInput, context: RoomBindingCallContext): Promise<ConnectionDeliveryResultMap['connection.delivery.retry']>
}
