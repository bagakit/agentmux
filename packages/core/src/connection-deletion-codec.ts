import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { ConnectionDeleteOperation, ConnectionDeletionMethod, ConnectionDeletionParamsMap, ConnectionDeletionResultMap } from './connection-deletion-contract.js'

export const CONNECTION_DELETION_RPC_METHODS = { 'connection.delete': 'long', 'connection.delete.inspect': 'short' } as const
export const isConnectionDeletionMethod = (value: unknown): value is ConnectionDeletionMethod => typeof value === 'string' && Object.hasOwn(CONNECTION_DELETION_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('The exact local identity deletion request or receipt is invalid.', 'INVALID_CONNECTION_DATA') }
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) fail()
  return value as string
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail()
  return value as number
}
function operation(value: unknown): ConnectionDeleteOperation {
  const p = rpcRecord(value, ['operationId', 'status', 'connectionId', 'application', 'deletedRevision'], 'INVALID_CONNECTION_DATA')
  const a = rpcRecord(p.application, ['domain', 'appId'], 'INVALID_CONNECTION_DATA')
  if (p.status !== 'deleted' || typeof a.domain !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(a.domain)) fail()
  return { operationId: id(p.operationId), status: 'deleted', connectionId: id(p.connectionId),
    application: { domain: a.domain as string, appId: id(a.appId) }, deletedRevision: revision(p.deletedRevision) }
}
export function parseConnectionDeletionParams<M extends ConnectionDeletionMethod>(method: M, value: unknown): ConnectionDeletionParamsMap[M] {
  const p = rpcRecord(value, method === 'connection.delete' ? ['operationId', 'connectionId', 'expectedRevision'] : ['operationId'], 'INVALID_CONNECTION_DATA')
  return (method === 'connection.delete' ? { operationId: id(p.operationId), connectionId: id(p.connectionId), expectedRevision: revision(p.expectedRevision) }
    : { operationId: id(p.operationId) }) as ConnectionDeletionParamsMap[M]
}
export function parseConnectionDeletionResult<M extends ConnectionDeletionMethod>(method: M, value: unknown, input: ConnectionDeletionParamsMap[M]): ConnectionDeletionResultMap[M] {
  const result = method === 'connection.delete' ? operation(value) : (() => {
    const p = rpcRecord(value, ['operation'], 'INVALID_CONNECTION_DATA')
    return { operation: p.operation === null ? null : operation(p.operation) }
  })()
  const observed = method === 'connection.delete' ? result as ConnectionDeleteOperation : (result as { operation: ConnectionDeleteOperation | null }).operation
  if (observed && (observed.operationId !== input.operationId || 'connectionId' in input && (observed.connectionId !== input.connectionId || observed.deletedRevision !== input.expectedRevision))) fail()
  return result as ConnectionDeletionResultMap[M]
}
