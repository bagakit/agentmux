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
export type ConnectionStage = { state: ConnectionStageState; reason?: 'not-tested' | 'credential-missing' | 'adapter-unavailable' | 'check-failed' | 'not-started' }
export type ConnectionObservation = {
  authentication: ConnectionStage
  transport: ConnectionStage
  intake: ConnectionStage
  delivery: ConnectionStage
}
export type ConnectionRecord = { config: ConnectionConfig; revision: number; observation: ConnectionObservation }
export type ConnectionConfigureInput = { operationId: string; expectedRevision: number | null; connection: ConnectionConfig }
/** A saved operation and its original configuration remain inspectable after credential rotation. */
export type ConnectionOperation = { operationId: string; status: 'configured'; connection: ConnectionRecord }
export type ConnectionInspectInput = { connectionId: string; operationId?: never } | { operationId: string; connectionId?: never }
export type ConnectionInspectResult = { connection: ConnectionRecord | null; operation: ConnectionOperation | null }
export type ConnectionMethod = keyof ConnectionParamsMap
export type ConnectionParamsMap = import('./room-binding-contract.js').RoomBindingParamsMap & import('./connection-delivery-contract.js').ConnectionDeliveryParamsMap & import('./ingress-contract.js').ConnectionIngressParamsMap & {
  'connection.ls': Record<string, never>
  'connection.inspect': ConnectionInspectInput
  'connection.configure': ConnectionConfigureInput
  'connection.test': { connectionId: string }
}
export type ConnectionResultMap = import('./room-binding-contract.js').RoomBindingResultMap & import('./connection-delivery-contract.js').ConnectionDeliveryResultMap & import('./ingress-contract.js').ConnectionIngressResultMap & {
  'connection.ls': { connections: ConnectionRecord[] }
  'connection.inspect': ConnectionInspectResult
  'connection.configure': ConnectionOperation
  'connection.test': ConnectionRecord
}
/** Borrow the Host's original connection owner. Core never constructs adapters or stores credentials. */
export interface ConnectionPort {
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
