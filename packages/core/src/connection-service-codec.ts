import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { ConnectionServiceMethod, ConnectionServiceOperation, ConnectionServiceParamsMap, ConnectionServiceResultMap, ConnectionServiceState } from './connection-service-contract.js'

export const CONNECTION_SERVICE_RPC_METHODS = { 'connection.service.get': 'long', 'connection.service.configure': 'long', 'connection.service.inspect': 'long' } as const
export const isConnectionServiceMethod = (value: unknown): value is ConnectionServiceMethod => typeof value === 'string' && Object.hasOwn(CONNECTION_SERVICE_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Connector service data does not describe the original policy or operation.', 'INVALID_CONNECTION_SERVICE_DATA') }
const object = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'INVALID_CONNECTION_SERVICE_DATA')
function identity(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) fail(); return value as string }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) fail(); return value as number }
function enabled(value: unknown): boolean { if (typeof value !== 'boolean') fail(); return value as boolean }
export function parseConnectionServiceState(value: unknown): ConnectionServiceState {
  const p = object(value, ['enabled', 'revision'])
  const state = { enabled: enabled(p.enabled), revision: revision(p.revision) }
  if (state.revision === 0 && !state.enabled) fail()
  return state
}
export function parseConnectionServiceOperation(value: unknown): ConnectionServiceOperation {
  const p = object(value, ['operationId', 'expectedRevision', 'status', 'service']), expectedRevision = revision(p.expectedRevision), service = parseConnectionServiceState(p.service)
  if (p.status !== 'configured' || expectedRevision === Number.MAX_SAFE_INTEGER || service.revision !== expectedRevision + 1) fail()
  return { operationId: identity(p.operationId), expectedRevision, status: 'configured', service }
}
export function parseConnectionServiceParams<M extends ConnectionServiceMethod>(method: M, value: unknown): ConnectionServiceParamsMap[M] {
  if (method === 'connection.service.get') { object(value, []); return {} as ConnectionServiceParamsMap[M] }
  if (method === 'connection.service.inspect') { const p = object(value, ['operationId']); return { operationId: identity(p.operationId) } as ConnectionServiceParamsMap[M] }
  const p = object(value, ['operationId', 'expectedRevision', 'service']), service = object(p.service, ['enabled']), expectedRevision = revision(p.expectedRevision)
  if (expectedRevision === Number.MAX_SAFE_INTEGER) fail()
  return { operationId: identity(p.operationId), expectedRevision, service: { enabled: enabled(service.enabled) } } as ConnectionServiceParamsMap[M]
}
export function parseConnectionServiceResult<M extends ConnectionServiceMethod>(method: M, value: unknown, input: ConnectionServiceParamsMap[M]): ConnectionServiceResultMap[M] {
  if (method === 'connection.service.get') return parseConnectionServiceState(value) as ConnectionServiceResultMap[M]
  if (method === 'connection.service.configure') {
    const operation = parseConnectionServiceOperation(value), expected = input as ConnectionServiceParamsMap['connection.service.configure']
    if (operation.operationId !== expected.operationId || operation.expectedRevision !== expected.expectedRevision || operation.service.enabled !== expected.service.enabled) fail()
    return operation as ConnectionServiceResultMap[M]
  }
  const p = object(value, ['operation']), operation = p.operation === null ? null : parseConnectionServiceOperation(p.operation)
  if (operation && operation.operationId !== (input as ConnectionServiceParamsMap['connection.service.inspect']).operationId) fail()
  return { operation } as ConnectionServiceResultMap[M]
}
