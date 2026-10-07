import type { ConnectionActor, ConnectionApplication } from './connections-contract.js'
import type { RoomBindingAuthority, RoomBindingCallContext, RoomBindingTarget } from './room-binding-contract.js'

/** The application comes from the exact configured connection, never a member-supplied identity. */
export type RoomMember = Pick<ConnectionActor, 'idType' | 'userId'>
export type RoomCreateInput = RoomBindingTarget & {
  operationId: string
  connectionId: string
  expectedConnectionRevision: number
  name: string
  members: RoomMember[]
}
export type RoomProvisioningRefusal = 'connection-unavailable' | 'connection-revised' | 'target-unavailable' | 'target-changed' | 'adapter-unavailable' | 'credential-unavailable' | 'authority-unavailable' | 'existing-operation' | 'platform-not-applied'
export type RoomCreationState =
  | { state: 'pending' }
  | { state: 'dispatching' | 'unknown'; attemptId: string }
  | { state: 'created'; attemptId: string; externalConversationId: string }
  | { state: 'not-applied'; reason: RoomProvisioningRefusal; attemptId?: string; originalOperationId?: string }
export type RoomMemberResult = { member: RoomMember; state: 'joined' | 'not-applied' | 'unknown' }
export type RoomMembershipState =
  | { state: 'not-requested' | 'pending' }
  | { state: 'dispatching'; attemptId: string }
  | { state: 'settled'; attemptId: string; results: RoomMemberResult[] }
  | { state: 'not-applied'; reason: RoomProvisioningRefusal }
/** Immutable intent and independent effect receipts. A created room confers no Binding or sharing authority. */
export type RoomProvisioningOperation = {
  operationId: string
  input: RoomCreateInput
  authorizedBy: RoomBindingAuthority
  application: ConnectionApplication | null
  adapterId: string | null
  creation: RoomCreationState
  membership: RoomMembershipState
}
export type RoomProvisioningInspectInput = { operationId: string }
export interface RoomProvisioningPort {
  create(input: RoomCreateInput, context: RoomBindingCallContext): Promise<RoomProvisioningOperation>
  /** Reads durable original facts only. It never creates, adds members or binds. */
  inspect(input: RoomProvisioningInspectInput): Promise<{ operation: RoomProvisioningOperation | null }>
}
export type RoomProvisioningParamsMap = {
  'connection.room.create': RoomCreateInput
  'connection.room.inspect': RoomProvisioningInspectInput
}
export type RoomProvisioningResultMap = {
  'connection.room.create': RoomProvisioningOperation
  'connection.room.inspect': { operation: RoomProvisioningOperation | null }
}
export type RoomProvisioningMethod = keyof RoomProvisioningParamsMap
