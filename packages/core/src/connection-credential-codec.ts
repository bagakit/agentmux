import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { ConnectionCredentialReference, ConnectionCredentialMethod, ConnectionCredentialParamsMap, ConnectionCredentialResultMap } from './connection-credential-contract.js'

export const CONNECTION_CREDENTIAL_RPC_METHODS = { 'connection.credential.store': 'long', 'connection.credential.inspect': 'long' } as const
export const isConnectionCredentialMethod = (value: unknown): value is ConnectionCredentialMethod => typeof value === 'string' && Object.hasOwn(CONNECTION_CREDENTIAL_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Credential data does not describe the original private operation. Secret values are not returned.', 'INVALID_CONNECTION_CREDENTIAL_DATA') }
const object = (value: unknown, fields: string[]) => {
  const row = rpcRecord(value, fields, 'INVALID_CONNECTION_CREDENTIAL_DATA')
  if (Object.keys(row).length !== fields.length) fail()
  return row
}
export function connectionCredentialIdentity(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) fail()
  return value as string
}
function reference(value: unknown): ConnectionCredentialReference { const row = object(value, ['credentialRef']); return { credentialRef: connectionCredentialIdentity(row.credentialRef) } }
export function parseConnectionCredentialParams<M extends ConnectionCredentialMethod>(method: M, value: unknown): ConnectionCredentialParamsMap[M] {
  if (method === 'connection.credential.store') {
    const row = object(value, ['operationId', 'secret'])
    if (typeof row.secret !== 'string' || !row.secret.length || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(row.secret)) !== row.secret) fail()
    return { operationId: connectionCredentialIdentity(row.operationId), secret: row.secret } as ConnectionCredentialParamsMap[M]
  }
  const row = object(value, ['operationId']); return { operationId: connectionCredentialIdentity(row.operationId) } as ConnectionCredentialParamsMap[M]
}
export function parseConnectionCredentialResult<M extends ConnectionCredentialMethod>(method: M, value: unknown): ConnectionCredentialResultMap[M] {
  if (method === 'connection.credential.store') return reference(value) as ConnectionCredentialResultMap[M]
  const row = object(value, ['receipt']); return { receipt: row.receipt === null ? null : reference(row.receipt) } as ConnectionCredentialResultMap[M]
}
