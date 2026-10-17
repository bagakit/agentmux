import type { ConnectionApplication } from './connections-contract.js'
import type { ConnectionEnrollmentCallContext } from './connection-enrollment-contract.js'

export type ConnectionProfileReason = 'adapter-unavailable' | 'credential-unavailable' | 'connection-revised' | 'source-unconfirmed' | 'storage-unconfirmed' | 'permission-required' | 'creation-origin-unsupported' | 'application-under-review' | 'platform-rejected' | 'effect-unconfirmed' | 'online-unconfirmed'
export type DesiredConnectionProfile = { name?: string; description?: string; avatar?: { pngDataUrl: string } }
export type ConnectionProfileGet = { connectionId: string; expectedConnectionRevision: number }
export type ProfileEffectState = 'not-required' | 'not-dispatched' | 'dispatching' | 'confirmed' | 'refused' | 'unknown'
export const CONNECTION_PROFILE_TRANSPORT_CODES = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'] as const
/** Original Provider facts only. An absent numeric field means it was not recorded. */
export type ConnectionProfileDiagnostic = {
  stage: 'upload' | 'prepare-patch' | 'patch'
  nativeCode?: number
  httpStatus?: number
  transportCode?: typeof CONNECTION_PROFILE_TRANSPORT_CODES[number]
}
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
  upload: { state: ProfileEffectState; diagnostic?: ConnectionProfileDiagnostic }; patch: { state: ProfileEffectState; diagnostic?: ConnectionProfileDiagnostic }
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
  inspect(input: ConnectionProfileOperationInput, context?: ConnectionEnrollmentCallContext): Promise<{ operation: ConnectionProfileOperation | null }>
  list(input: ConnectionProfileListInput, context?: ConnectionEnrollmentCallContext): Promise<ConnectionProfileListResult>
}
export type ConnectionProfileParamsMap = {
  'connection.profile.get': ConnectionProfileGet
  'connection.profile.inspect': ConnectionProfileOperationInput
  'connection.profile.ls': ConnectionProfileListInput
}
export type ConnectionProfileResultMap = {
  'connection.profile.get': ConnectionProfileObservation
  'connection.profile.inspect': { operation: ConnectionProfileOperation | null }
  'connection.profile.ls': ConnectionProfileListResult
}
export type ConnectionProfileMethod = keyof ConnectionProfileParamsMap
