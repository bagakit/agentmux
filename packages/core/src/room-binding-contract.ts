import type { ConversationCheckpoint } from './conversation-changes.js'
import type { ConnectionApplication, ConnectionGrant } from './connections-contract.js'
import type { AgentSessionHistorySource } from './types.js'

export type RoomBindingAuthority = { kind: 'user' | 'device'; id: string }
export type RoomBindingScope = { input: 'mentions-and-replies' | 'all-messages'; publication: 'future-native-user-facing' }
export type RoomBindingTarget = { executionHostId: string; agentSessionId: string; regionAnchor: { regionId: string } }
/** An immutable authorized audience snapshot. A Region is navigation, never an execution route. */
export type RoomBinding = RoomBindingTarget & {
  bindingId: string
  revision: number
  state: 'active' | 'paused'
  connectionId: string
  application: ConnectionApplication
  externalConversationId: string
  scope: RoomBindingScope
  /** Only original native sources are eligible in this scope. No captured or wall-clock substitute. */
  sourceCheckpoints: ConversationCheckpoint[]
  authorizedBy: RoomBindingAuthority
}
export type RoomBindingBindInput = RoomBindingTarget & {
  operationId: string; bindingId: string; connectionId: string; expectedConnectionRevision: number
  externalConversationId: string; scope: RoomBindingScope; expectedSource: AgentSessionHistorySource
}
/** Relinking includes an explicit fresh source cut, also when continuing a paused binding to the same audience. */
export type RoomBindingRelinkInput = RoomBindingBindInput & { expectedRevision: number }
export type RoomBindingPauseInput = { operationId: string; bindingId: string; expectedRevision: number }
export type RoomBindingGrantInput = {
  operationId: string; bindingId: string; expectedBindingRevision: number
  grantId: string; expectedRevision: number | null
  actor: ConnectionGrant['actor']; capabilities: ConnectionGrant['capabilities']; state: ConnectionGrant['state']
}
export type RoomBindingAction = 'bind' | 'pause' | 'relink' | 'grant'
export type RoomBindingOperation =
  | { operationId: string; action: RoomBindingAction; state: 'preparing' }
  | { operationId: string; action: RoomBindingAction; state: 'refused'; code: string }
  | { operationId: string; action: RoomBindingAction; state: 'applied'; binding: RoomBinding; grant?: ConnectionGrant; reused?: boolean }
export type RoomBindingInspectInput = { bindingId: string; revision?: number; operationId?: never } | { operationId: string; bindingId?: never; revision?: never }
export type RoomBindingInspection = { binding: RoomBinding | null; current: RoomBinding | null; operation: RoomBindingOperation | null; grants: ConnectionGrant[] }
export type RoomBindingListInput = { connectionId?: string; executionHostId?: string; agentSessionId?: string }
export type RoomBindingCallContext = { actor: RoomBindingAuthority; assertCurrent?(): void | Promise<void> }
export interface RoomBindingsPort {
  bind(input: RoomBindingBindInput, context: RoomBindingCallContext): Promise<RoomBindingOperation>
  inspect(input: RoomBindingInspectInput): Promise<RoomBindingInspection>
  list(input: RoomBindingListInput): Promise<{ bindings: RoomBinding[] }>
  pause(input: RoomBindingPauseInput, context: RoomBindingCallContext): Promise<RoomBindingOperation>
  relink(input: RoomBindingRelinkInput, context: RoomBindingCallContext): Promise<RoomBindingOperation>
  grant(input: RoomBindingGrantInput, context: RoomBindingCallContext): Promise<RoomBindingOperation>
}
export type RoomPublicationAuthority = {
  binding: RoomBinding | null
  authorized: boolean
  reason?: 'missing' | 'binding-revised' | 'paused' | 'connection-disabled' | 'publication-not-granted'
}
/** Synchronous reads can join the original connector database transaction. They never query a Region occupant. */
export interface RoomBindingReadPort {
  readExact(bindingId: string, revision: number): RoomBinding | null
  readCurrent(bindingId: string): RoomBinding | null
  listActive(input?: RoomBindingListInput): RoomBinding[]
  publicationAuthority(bindingId: string, revision: number): RoomPublicationAuthority
  readGrant(grantId: string, revision?: number): ConnectionGrant | null
  findGrant(input: { connectionId: string; externalConversationId: string; actor: ConnectionGrant['actor'] }): ConnectionGrant | null
}
