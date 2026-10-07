import type { ConnectionApplication } from './connections-contract.js'
import type { RoomBindingAuthority } from './room-binding-contract.js'
import type { RoomProvisioningCallContext, RoomMember } from './room-provisioning-contract.js'

export type RoomReadScope = { connectionId: string; expectedConnectionRevision: number }
export type RoomListInput = RoomReadScope & { cursor?: string; limit?: number }
export type RoomSearchInput = RoomListInput & { query: string }
export type RoomGetInput = RoomReadScope & { externalConversationId: string }
export type RoomMembersInput = RoomGetInput & { cursor?: string; limit?: number }
export type RoomDiscoveryReason = 'connection-unavailable' | 'connection-revised' | 'adapter-unavailable' | 'credential-unavailable' | 'permission-denied' | 'room-unavailable' | 'platform-unavailable' | 'response-unconfirmed' | 'authority-unavailable'
export type RoomDiscoveryObservation = { state: 'ready' } | { state: 'unknown' | 'unavailable'; reason: RoomDiscoveryReason }
export type RoomReadResult = { connectionId: string; connectionRevision: number; application: ConnectionApplication | null; observation: RoomDiscoveryObservation }
/** A visible room is not proof of membership, sharing or Agent input authority. */
export type RoomSummary = { externalConversationId: string; name: string | null; state: 'active' | 'dissolved' | 'unknown' }
export type RoomDetails = RoomSummary & { mode: 'group' | 'topic' | 'direct' | 'unknown'; membershipApproval: 'required' | 'not-required' | 'unknown' }
/** Platform user accounts, never a guessed local creator or a chat grant. */
export type RoomDiscoveredMember = RoomMember & { name: string | null }
export type RoomListResult = RoomReadResult & { rooms: RoomSummary[]; next: string | null }
export type RoomGetResult = RoomReadResult & { room: RoomDetails | null }
export type RoomMembersResult = RoomReadResult & { externalConversationId: string; members: RoomDiscoveredMember[]; next: string | null }
export type RoomLinkCreateInput = RoomGetInput & { operationId: string }
/** Confirmation means the platform issued this link, not that a person joined or can chat. */
export type RoomLinkOperation = {
  operationId: string; input: RoomLinkCreateInput; application: ConnectionApplication | null; authorizedBy: RoomBindingAuthority
} & (
  | { state: 'dispatching' | 'unknown' }
  | { state: 'refused'; reason: RoomDiscoveryReason }
  | { state: 'confirmed'; link: { url: string; expiresAtUnixSeconds: number } }
)
export interface RoomDiscoveryPort {
  list(input: RoomListInput): Promise<RoomListResult>
  search(input: RoomSearchInput): Promise<RoomListResult>
  get(input: RoomGetInput): Promise<RoomGetResult>
  members(input: RoomMembersInput): Promise<RoomMembersResult>
  createLink(input: RoomLinkCreateInput, context: RoomProvisioningCallContext): Promise<RoomLinkOperation>
  inspectLink(input: { operationId: string }): Promise<{ operation: RoomLinkOperation | null }>
}
export type RoomDiscoveryParamsMap = {
  'connection.room.ls': RoomListInput
  'connection.room.search': RoomSearchInput
  'connection.room.get': RoomGetInput
  'connection.room.members': RoomMembersInput
  'connection.room.link.create': RoomLinkCreateInput
  'connection.room.link.inspect': { operationId: string }
}
export type RoomDiscoveryResultMap = {
  'connection.room.ls': RoomListResult
  'connection.room.search': RoomListResult
  'connection.room.get': RoomGetResult
  'connection.room.members': RoomMembersResult
  'connection.room.link.create': RoomLinkOperation
  'connection.room.link.inspect': { operation: RoomLinkOperation | null }
}
export type RoomDiscoveryMethod = keyof RoomDiscoveryParamsMap
export type RoomPort = Partial<import('./room-provisioning-contract.js').RoomProvisioningPort & RoomDiscoveryPort>
