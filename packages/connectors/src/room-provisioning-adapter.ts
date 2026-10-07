import type { ConnectionApplication, RoomMember, RoomMemberResult } from '@agentmux/core/connections'

export type RoomCreationEffect = { kind: 'created'; externalConversationId: string } | { kind: 'not-applied' | 'unknown' }
/** Protocol facts for every exact requested member, in the original request order. */
export type RoomMembershipEffect = { results: RoomMemberResult[] }
export interface RoomProvisioningAdapter {
  /** Create only the room. Member invitation is a separate original effect and receipt. */
  create(input: { operationId: string; attemptId: string; application: ConnectionApplication; name: string }, credential: string): Promise<RoomCreationEffect>
  addMembers(input: { operationId: string; attemptId: string; application: ConnectionApplication; externalConversationId: string; members: RoomMember[] }, credential: string): Promise<RoomMembershipEffect>
}
