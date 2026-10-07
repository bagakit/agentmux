import type { ConnectionApplication } from './connections-contract.js'
import type { ConnectionEnrollmentCallContext } from './connection-enrollment-contract.js'

export type ConnectionProfileReason = 'adapter-unavailable' | 'credential-unavailable' | 'connection-revised' | 'source-unconfirmed' | 'storage-unconfirmed' | 'permission-required' | 'creation-origin-unsupported' | 'application-under-review' | 'platform-rejected' | 'effect-unconfirmed' | 'online-unconfirmed'
export type DesiredConnectionProfile = { name?: string; description?: string; avatar?: { pngDataUrl: string } }
export type ConnectionProfileGet = { connectionId: string; expectedConnectionRevision: number }
export type ConnectionProfileSync = ConnectionProfileGet & { operationId: string; desired: DesiredConnectionProfile }
export type ProfileEffectState = 'not-required' | 'not-dispatched' | 'dispatching' | 'confirmed' | 'refused' | 'unknown'
/** Online fields are observations, never proof that an original write was published. */
export type ConnectionProfileObservation = {
  connectionId: string; connectionRevision: number; application: ConnectionApplication
  /** Language requested for version description; does not infer the language of native bot fields. */
  language: string | null
  state: 'observed' | 'unknown' | 'unavailable'
  profile: { name?: string; description?: string; avatarUrl?: string } | null
  metadata: { description?: string } | null
  botId: string | null; onlineVersionId: string | null; reviewingVersionId: string | null
  version: { versionId: string; status: 'unknown' | 'approved' | 'rejected' | 'reviewing' | 'unsubmitted' } | null
  managementUrl?: string
  reason?: ConnectionProfileReason
}
export type ConnectionProfileOperation = {
  operationId: string; connectionId: string; connectionRevision: number; application: ConnectionApplication
  language: string | null
  fields: Array<'name' | 'description' | 'avatar'>
  desired: { name?: string; description?: string; avatarSha256?: string }
  upload: { state: ProfileEffectState }; patch: { state: ProfileEffectState }
  publication: 'not-requested' | 'platform-review-required'
  online: ConnectionProfileObservation | null
  managementUrl?: string
  reason?: ConnectionProfileReason
}
export type ConnectionProfileOperationInput = { operationId: string }
export type ConnectionProfileListInput = { connectionId: string; cursor?: string; limit?: number }
export type ConnectionProfileListResult = { operations: ConnectionProfileOperation[]; next: string | null }
export interface ConnectionProfilePort {
  get(input: ConnectionProfileGet, context?: ConnectionEnrollmentCallContext): Promise<ConnectionProfileObservation>
  sync(input: ConnectionProfileSync, context: ConnectionEnrollmentCallContext): Promise<ConnectionProfileOperation>
  advance(input: ConnectionProfileOperationInput, context: ConnectionEnrollmentCallContext): Promise<ConnectionProfileOperation>
  inspect(input: ConnectionProfileOperationInput): Promise<{ operation: ConnectionProfileOperation | null }>
  list(input: ConnectionProfileListInput): Promise<ConnectionProfileListResult>
}
export type ConnectionProfileParamsMap = {
  'connection.profile.get': ConnectionProfileGet; 'connection.profile.sync': ConnectionProfileSync
  'connection.profile.advance': ConnectionProfileOperationInput; 'connection.profile.inspect': ConnectionProfileOperationInput
  'connection.profile.ls': ConnectionProfileListInput
}
export type ConnectionProfileResultMap = {
  'connection.profile.get': ConnectionProfileObservation; 'connection.profile.sync': ConnectionProfileOperation
  'connection.profile.advance': ConnectionProfileOperation; 'connection.profile.inspect': { operation: ConnectionProfileOperation | null }
  'connection.profile.ls': ConnectionProfileListResult
}
export type ConnectionProfileMethod = keyof ConnectionProfileParamsMap
