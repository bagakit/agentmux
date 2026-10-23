import type { AgentMuxRpcCallContext } from './public-rpc-service.js'

export type ConnectionCredentialReference = { credentialRef: string }
/** Transient protected transport input; never part of configuration, activity or diagnosis. */
export type ConnectionCredentialStoreInput = { operationId: string; secret: string }
export type ConnectionCredentialParamsMap = {
  'connection.credential.store': ConnectionCredentialStoreInput
  'connection.credential.inspect': { operationId: string }
}
export type ConnectionCredentialResultMap = {
  'connection.credential.store': ConnectionCredentialReference
  'connection.credential.inspect': { receipt: ConnectionCredentialReference | null }
}
export type ConnectionCredentialMethod = keyof ConnectionCredentialParamsMap
/** The executing Host lends its original private SQLite owner; reads return references alone. */
export interface ConnectionCredentialPort {
  store(input: ConnectionCredentialStoreInput, context: AgentMuxRpcCallContext): Promise<ConnectionCredentialReference>
  inspect(input: { operationId: string }, context: AgentMuxRpcCallContext): Promise<{ receipt: ConnectionCredentialReference | null }>
}
