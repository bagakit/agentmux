import { AgentMuxError } from './errors.js'
import { parseConnectionRecord } from './connection-record-codec.js'
import type { ConnectionReceiverMethod, ConnectionReceiverParamsMap, ConnectionReceiverResultMap, ConnectionReceiverRecoveryOperation } from './connection-receiver-contract.js'

export const CONNECTION_RECEIVER_RPC_METHODS = { 'connection.receiver.recover': 'long', 'connection.receiver.inspect': 'long' } as const
export const isConnectionReceiverMethod = (value: unknown): value is ConnectionReceiverMethod => typeof value === 'string' && Object.hasOwn(CONNECTION_RECEIVER_RPC_METHODS, value)
function fail(): never { throw new AgentMuxError('Receiver recovery data is malformed or names another original target.', 'INVALID_CONNECTION_DATA') }
function object(value: unknown, fields: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => !fields.includes(key))) return fail()
  return p
}
function id(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) return fail(); return value }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 1) return fail(); return value as number }
export function parseConnectionReceiverParams<M extends ConnectionReceiverMethod>(method: M, value: unknown): ConnectionReceiverParamsMap[M] {
  const p = object(value, method === 'connection.receiver.inspect' ? ['operationId'] : ['operationId', 'connectionId', 'expectedRevision', 'receiverRef'])
  return (method === 'connection.receiver.inspect' ? { operationId: id(p.operationId) }
    : { operationId: id(p.operationId), connectionId: id(p.connectionId), expectedRevision: revision(p.expectedRevision), receiverRef: p.receiverRef === null ? null : id(p.receiverRef) }) as ConnectionReceiverParamsMap[M]
}
export function parseConnectionReceiverOperation(value: unknown): ConnectionReceiverRecoveryOperation {
  const p = object(value, ['operationId', 'connectionId', 'configurationRevision', 'receiverRef', 'disposition'])
  if (!['already-ready', 'joined', 'scheduled', 'not-current', 'disabled', 'unconfirmed'].includes(p.disposition as string)) return fail()
  return { operationId: id(p.operationId), connectionId: id(p.connectionId), configurationRevision: revision(p.configurationRevision),
    receiverRef: p.receiverRef === null ? null : id(p.receiverRef), disposition: p.disposition as ConnectionReceiverRecoveryOperation['disposition'] }
}
export function parseConnectionReceiverResult<M extends ConnectionReceiverMethod>(method: M, value: unknown, input: ConnectionReceiverParamsMap[M]): ConnectionReceiverResultMap[M] {
  const p = object(value, ['operation', 'connection']), operation = p.operation === null ? null : parseConnectionReceiverOperation(p.operation)
  const connection = p.connection === null ? null : parseConnectionRecord(p.connection)
  if (operation && operation.operationId !== input.operationId || method === 'connection.receiver.recover' && !operation ||
      connection && (!operation || connection.config.connectionId !== operation.connectionId)) return fail()
  if (method === 'connection.receiver.recover') {
    const expected = input as ConnectionReceiverParamsMap['connection.receiver.recover']
    if (operation!.connectionId !== expected.connectionId || operation!.configurationRevision !== expected.expectedRevision ||
        expected.receiverRef !== null && operation!.receiverRef !== expected.receiverRef) return fail()
  }
  return { operation, connection } as ConnectionReceiverResultMap[M]
}
