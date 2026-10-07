import type { ConnectionConfig, RoomDiscoveryObservation, RoomDiscoveryReason, RoomSummary, RoomDetails, RoomDiscoveredMember } from '@agentmux/core/connections'

type Page = { cursor?: string; limit?: number }
type Scope = { config: ConnectionConfig }
type Target = Scope & { externalConversationId: string }
export type RoomAdapterPage = { observation: RoomDiscoveryObservation; rooms: RoomSummary[]; next: string | null }
export type RoomAdapterMembers = { observation: RoomDiscoveryObservation; members: RoomDiscoveredMember[]; next: string | null }
export type RoomLinkAdapterReceipt = { kind: 'confirmed'; link: { url: string; expiresAtUnixSeconds: number } } | { kind: 'unknown' } | { kind: 'refused'; reason: RoomDiscoveryReason }
/** Application-local native reads and one link effect. No local user or grant is inferred here. */
export interface RoomDiscoveryAdapter {
  list(input: Scope & Page, credential: string, signal?: AbortSignal): Promise<RoomAdapterPage>
  search(input: Scope & Page & { query: string }, credential: string, signal?: AbortSignal): Promise<RoomAdapterPage>
  get(input: Target, credential: string, signal?: AbortSignal): Promise<{ observation: RoomDiscoveryObservation; room: RoomDetails | null }>
  members(input: Target & Page, credential: string, signal?: AbortSignal): Promise<RoomAdapterMembers>
  createLink(input: Target, credential: string, signal?: AbortSignal): Promise<RoomLinkAdapterReceipt>
}
