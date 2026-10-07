import type { ConnectionConfig, RoomMember, RoomMemberResult } from '@agentmux/core/connections'

export type RoomCreationEffect = { kind: 'created'; externalConversationId: string } | { kind: 'not-applied' | 'unknown' }
/** Protocol facts for every exact requested member, in the original request order. */
export type RoomMembershipEffect = { results: RoomMemberResult[] }
export interface RoomProvisioningAdapter {
  /** Create only the room. Member invitation is a separate original effect and receipt. */
  create(input: { operationId: string; attemptId: string; config: ConnectionConfig; name: string }, credential: string, signal?: AbortSignal): Promise<RoomCreationEffect>
  addMembers(input: { operationId: string; attemptId: string; config: ConnectionConfig; externalConversationId: string; members: RoomMember[] }, credential: string, signal?: AbortSignal): Promise<RoomMembershipEffect>
}
