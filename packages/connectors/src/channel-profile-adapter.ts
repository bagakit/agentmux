import type { ChannelActorProfileObservation, ConnectionActor, ConnectionConfig } from '@agentmux/core/connections'
import type { ChannelStoragePort } from './channel-storage.js'

export type ChannelActorProfileRead = { actor: ConnectionActor; storage: ChannelStoragePort }
/** Host-internal native leaf. Profiles are observations, never input or sharing authority. */
export interface ChannelProfileAdapter {
  readActor(input: ChannelActorProfileRead): ChannelActorProfileObservation
  refreshActor(input: ChannelActorProfileRead & { config: ConnectionConfig }, credential: string, signal: AbortSignal): Promise<ChannelActorProfileObservation>
}
