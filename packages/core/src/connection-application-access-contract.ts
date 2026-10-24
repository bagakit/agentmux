import type { ConnectionActor, ConnectionGrant } from './connections-contract.js'
import type { RoomBindingCallContext } from './room-binding-contract.js'

/** Same application on this original Host; never a per-room copy of a rule. */
export type ConnectionApplicationGrant = {
  grantId: string; revision: number; adapterId: string; actor: ConnectionActor
  state: ConnectionGrant['state']; capabilities: ConnectionGrant['capabilities']
}
export type ConnectionApplicationAccessGet = { connectionId: string; actor?: ConnectionActor }
export type ConnectionApplicationAccess = {
  connectionId: string; connectionRevision: number; adapterId: string
  application: ConnectionActor['application']; grants: ConnectionApplicationGrant[]
}
export type ConnectionApplicationAccessConfigure = {
  operationId: string; connectionId: string; expectedConnectionRevision: number
  grantId: string; expectedRevision: number | null; actor: ConnectionActor
  state: ConnectionGrant['state']; capabilities: ConnectionGrant['capabilities']
}
export type ConnectionApplicationAccessOperation =
  | { operationId: string; state: 'refused'; code: string }
  | { operationId: string; state: 'applied'; grant: ConnectionApplicationGrant }
export type ConnectionApplicationAccessParamsMap = {
  'connection.application.access.get': ConnectionApplicationAccessGet
  'connection.application.access.configure': ConnectionApplicationAccessConfigure
  'connection.application.access.inspect': { operationId: string }
}
export type ConnectionApplicationAccessResultMap = {
  'connection.application.access.get': ConnectionApplicationAccess
  'connection.application.access.configure': ConnectionApplicationAccessOperation
  'connection.application.access.inspect': { operation: ConnectionApplicationAccessOperation | null }
}
export type ConnectionApplicationAccessMethod = keyof ConnectionApplicationAccessParamsMap
export interface ConnectionApplicationAccessPort {
  get(input: ConnectionApplicationAccessGet): Promise<ConnectionApplicationAccess>
  configure(input: ConnectionApplicationAccessConfigure, context: RoomBindingCallContext): Promise<ConnectionApplicationAccessOperation>
  inspect(input: { operationId: string }): Promise<{ operation: ConnectionApplicationAccessOperation | null }>
}
/** This is a read projection, not a persisted room grant or a member-directory result. */
export type ConnectionEffectiveGrant = {
  actor: ConnectionActor; state: ConnectionGrant['state']; capabilities: ConnectionGrant['capabilities']
  source: { kind: 'room' | 'application'; grantId: string; revision: number }
}
export type ConnectionMemberAccess = {
  actor: ConnectionActor
  local: { kind: 'none'; previousDecision: boolean } | { kind: 'override' | 'review-required'; grant: ConnectionGrant }
  effective: ConnectionEffectiveGrant | null
}

export type ConnectionEffectiveGrants = { grants: ConnectionEffectiveGrant[]; issue: 'application-unconfirmed' | null }
