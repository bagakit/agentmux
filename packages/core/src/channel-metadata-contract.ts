import type { ChannelActorProfile, ChannelActorProfileObservation, ChannelProfileReason } from './channel-profile.js'
import type { ConnectionActor, ConnectionApplication } from './connections-contract.js'
import type { ConnectionEnrollmentCallContext } from './connection-enrollment-contract.js'

export type ChannelMetadataSubject = { kind: 'actor'; actor: ConnectionActor } | { kind: 'conversation'; externalConversationId: string }
export type ChannelConversationProfileObservation = {
  application: ConnectionApplication; externalConversationId: string
  state: 'observed' | 'unknown' | 'unavailable'; profile: ChannelActorProfile | null
  checkedAt: number; freshness: 'current' | 'stale' | 'unknown'; reason?: ChannelProfileReason
}
export type ChannelMetadataEntry = { subject: ChannelMetadataSubject; observation: ChannelActorProfileObservation | ChannelConversationProfileObservation; cacheRevision: string | null }
export type ChannelMetadataGetInput = { connectionId: string; subject: ChannelMetadataSubject }
export type ChannelMetadataInput = ChannelMetadataGetInput & { expectedConnectionRevision: number }
export type ChannelMetadataListInput = { connectionId: string } & { kind: ChannelMetadataSubject['kind']; limit?: number; cursor?: string }
export type ChannelMetadataClearInput = ChannelMetadataInput & { expectedCacheRevision: string | null }
export type ChannelMetadataResult = { connectionId: string; connectionRevision: number; application: ConnectionApplication; entry: ChannelMetadataEntry }
export type ChannelMetadataListResult = Omit<ChannelMetadataResult, 'entry'> & { entries: ChannelMetadataEntry[]; next: string | null }
export type ChannelMetadataChange = { connectionId: string; application: ConnectionApplication; subject: ChannelMetadataSubject }
export interface ChannelMetadataPort {
  /** Host-local change hints for its authenticated person/device; snapshots remain the exact get/list owner. */
  watch(changed: (change: ChannelMetadataChange) => void, ended: (error?: unknown) => void, context?: ConnectionEnrollmentCallContext): Promise<{ dispose(): void }>
  get(input: ChannelMetadataGetInput, context?: ConnectionEnrollmentCallContext): Promise<ChannelMetadataResult>
  list(input: ChannelMetadataListInput, context?: ConnectionEnrollmentCallContext): Promise<ChannelMetadataListResult>
  refresh(input: ChannelMetadataInput, context?: ConnectionEnrollmentCallContext): Promise<ChannelMetadataResult>
  clear(input: ChannelMetadataClearInput, context?: ConnectionEnrollmentCallContext): Promise<ChannelMetadataResult & { cleared: boolean }>
}
export type ChannelMetadataParamsMap = {
  'connection.metadata.watch': Record<string, never>
  'connection.metadata.get': ChannelMetadataGetInput
  'connection.metadata.ls': ChannelMetadataListInput
  'connection.metadata.refresh': ChannelMetadataInput
  'connection.metadata.clear': ChannelMetadataClearInput
}
export type ChannelMetadataResultMap = {
  'connection.metadata.watch': Record<string, never>
  'connection.metadata.get': ChannelMetadataResult
  'connection.metadata.ls': ChannelMetadataListResult
  'connection.metadata.refresh': ChannelMetadataResult
  'connection.metadata.clear': ChannelMetadataResult & { cleared: boolean }
}
export type ChannelMetadataMethod = keyof ChannelMetadataParamsMap
