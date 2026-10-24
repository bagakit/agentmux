/** External application identity. Domain belongs to the issuer, never a local account alias. */
export type ConnectionApplication = { domain: string; appId: string }
export type ConnectionConfig = {
  connectionId: string
  adapterId: string
  application: ConnectionApplication
  label: string
  enabled: boolean
  /** Opaque reference resolved only by the executing Host. Never a credential value or path. */
  credentialRef: string
}
export type ConnectionStageState = 'unknown' | 'ready' | 'unavailable' | 'disabled'
export type ConnectionStage = { state: ConnectionStageState; reason?: 'not-tested' | 'credential-missing' | 'credential-format-unsupported' | 'credential-unavailable' | 'adapter-unavailable' | 'check-failed' | 'not-started' }
export type ConnectionObservation = {
  authentication: ConnectionStage
  transport: ConnectionStage
  intake: ConnectionStage
  delivery: ConnectionStage
}
export type ConnectionRecord = {
  config: ConnectionConfig
  revision: number
  observation: ConnectionObservation
  /** Original registered adapter implementations, not native permission or readiness. Absent means unknown. */
  capabilities?: { roomDiscovery: boolean; roomCreation: boolean; roomLink: boolean }
  /** The matching managed initial flow's recorded outcome, distinct from current platform readiness. */
  initialSetup?: { state: 'incomplete' | 'complete' | 'unconfirmed' }
}
export type ConnectionConfigureInput = { operationId: string; expectedRevision: number | null; connection: ConnectionConfig }
/** A saved operation and its original configuration remain inspectable after credential rotation. */
export type ConnectionOperation = { operationId: string; status: 'configured'; connection: ConnectionRecord }
export type ConnectionInspectInput = { connectionId: string; operationId?: never } | { operationId: string; connectionId?: never }
export type ConnectionInspectResult = { connection: ConnectionRecord | null; operation: ConnectionOperation | null }
/** Registration on this exact endpoint, independent of storage, leases or platform health. */
export type ConnectionOwnerObservation = { ownership: 'local' | 'forwarded' | 'unavailable' }
export type ConnectionMethod = keyof ConnectionParamsMap
export type ConnectionParamsMap = import('./connection-api-contract.js').ConnectionApiParamsMap & import('./connection-application-access-contract.js').ConnectionApplicationAccessParamsMap & import('./connection-credential-contract.js').ConnectionCredentialParamsMap & import('./channel-metadata-contract.js').ChannelMetadataParamsMap & import('./connection-deletion-contract.js').ConnectionDeletionParamsMap & import('./connection-setup-contract.js').ConnectionSetupParamsMap & import('./connection-service-contract.js').ConnectionServiceParamsMap & import('./connection-profile-contract.js').ConnectionProfileParamsMap & import('./connection-enrollment-contract.js').ConnectionEnrollmentParamsMap & import('./room-discovery-contract.js').RoomDiscoveryParamsMap & import('./room-provisioning-contract.js').RoomProvisioningParamsMap & import('./room-binding-contract.js').RoomBindingParamsMap & import('./connection-delivery-contract.js').ConnectionDeliveryParamsMap & import('./ingress-contract.js').ConnectionIngressParamsMap & import('./connection-diagnosis-contract.js').ConnectionDiagnosisParamsMap & {
  'connection.owner.inspect': Record<string, never>
  'connection.ls': Record<string, never>
  'connection.inspect': ConnectionInspectInput
  'connection.configure': ConnectionConfigureInput
  'connection.test': { connectionId: string }
}
export type ConnectionResultMap = import('./connection-api-contract.js').ConnectionApiResultMap & import('./connection-application-access-contract.js').ConnectionApplicationAccessResultMap & import('./connection-credential-contract.js').ConnectionCredentialResultMap & import('./channel-metadata-contract.js').ChannelMetadataResultMap & import('./connection-deletion-contract.js').ConnectionDeletionResultMap & import('./connection-setup-contract.js').ConnectionSetupResultMap & import('./connection-service-contract.js').ConnectionServiceResultMap & import('./connection-profile-contract.js').ConnectionProfileResultMap & import('./connection-enrollment-contract.js').ConnectionEnrollmentResultMap & import('./room-discovery-contract.js').RoomDiscoveryResultMap & import('./room-provisioning-contract.js').RoomProvisioningResultMap & import('./room-binding-contract.js').RoomBindingResultMap & import('./connection-delivery-contract.js').ConnectionDeliveryResultMap & import('./ingress-contract.js').ConnectionIngressResultMap & import('./connection-diagnosis-contract.js').ConnectionDiagnosisResultMap & {
  'connection.owner.inspect': ConnectionOwnerObservation
  'connection.ls': { connections: ConnectionRecord[] }
  'connection.inspect': ConnectionInspectResult
  'connection.configure': ConnectionOperation
  'connection.test': ConnectionRecord
}
/** Borrow the Host's original connection owner. Core never constructs adapters or stores credentials. */
export interface ConnectionPort {
  api?: import('./connection-api-contract.js').ConnectionApiPort
  applicationAccess?: import('./connection-application-access-contract.js').ConnectionApplicationAccessPort
  credential?: import('./connection-credential-contract.js').ConnectionCredentialPort
  metadata?: import('./channel-metadata-contract.js').ChannelMetadataPort
  delete?(input: import('./connection-deletion-contract.js').ConnectionDeleteInput, context?: import('./connection-enrollment-contract.js').ConnectionEnrollmentCallContext): Promise<import('./connection-deletion-contract.js').ConnectionDeleteOperation>
  inspectDeletion?(input: { operationId: string }): Promise<{ operation: import('./connection-deletion-contract.js').ConnectionDeleteOperation | null }>
  /** Original enrollment journal ownership, never a display label or credential-derived grant. */
  ownsEnrollmentConnection?(connectionId: string, agentSessionId: string): Promise<boolean>
  setup?: import('./connection-setup-contract.js').ConnectionSetupPort
  service?: import('./connection-service-contract.js').ConnectionServicePort
  profile?: import('./connection-profile-contract.js').ConnectionProfilePort
  enrollment?: import('./connection-enrollment-contract.js').ConnectionEnrollmentPort
  rooms?: import('./room-discovery-contract.js').RoomPort
  delivery?: import('./connection-delivery-contract.js').ConnectionDeliveryPort
  ingress?: import('./ingress-contract.js').ConnectionIngressReadPort
  bindings?: import('./room-binding-contract.js').RoomBindingsPort
  list(): Promise<ConnectionResultMap['connection.ls']>
  inspect(input: ConnectionInspectInput): Promise<ConnectionInspectResult>
  configure(input: ConnectionConfigureInput): Promise<ConnectionOperation>
  test(input: ConnectionParamsMap['connection.test']): Promise<ConnectionRecord>
}
export type ConnectionActor = { application: ConnectionApplication; idType: string; userId: string }
/** Attribution is not authorization. Grants remain scoped to the original external conversation. */
export type ConnectionGrant = {
  grantId: string; revision: number; bindingId: string; bindingRevision: number; connectionId: string; actor: ConnectionActor
  externalConversationId: string; state: 'active' | 'revoked'; capabilities: Array<'input' | 'answer' | 'permission'>
}
