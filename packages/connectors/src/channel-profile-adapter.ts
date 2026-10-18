import type { ChannelActorProfileObservation, ConnectionActor, ConnectionConfig } from '@agentmux/core/connections'
import type { ChannelConversationProfileObservation, ChannelMetadataEntry, ChannelMetadataSubject } from '@agentmux/core/connections'
import type { ChannelStoragePort } from './channel-storage.js'

export type ChannelActorProfileRead = { actor: ConnectionActor; storage: ChannelStoragePort }
/** Host-internal native leaf. Profiles are observations, never input or sharing authority. */
export interface ChannelProfileAdapter {
  readActor(input: ChannelActorProfileRead): ChannelActorProfileObservation
  refreshActor(input: ChannelActorProfileRead & { config: ConnectionConfig }, credential: string, signal: AbortSignal): Promise<ChannelActorProfileObservation>
  getMetadata?(input: { config: ConnectionConfig; subject: ChannelMetadataSubject; storage: ChannelStoragePort }): ChannelMetadataEntry
  listMetadata?(input: { config: ConnectionConfig; kind: ChannelMetadataSubject['kind']; limit: number; cursor?: string; storage: ChannelStoragePort }): { entries: ChannelMetadataEntry[]; next: string | null }
  clearMetadata?(input: { config: ConnectionConfig; subject: ChannelMetadataSubject; expectedCacheRevision: string | null; storage: ChannelStoragePort }): boolean
  refreshConversation?(input: { config: ConnectionConfig; externalConversationId: string; storage: ChannelStoragePort }, credential: string, signal: AbortSignal): Promise<ChannelConversationProfileObservation>
}
