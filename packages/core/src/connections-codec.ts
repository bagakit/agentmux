import { CONNECTION_DELIVERY_RPC_METHODS, isConnectionDeliveryMethod, parseConnectionDeliveryParams, parseConnectionDeliveryResult } from './connection-delivery-codec.js'
import { INGRESS_RPC_METHODS, isIngressMethod, parseIngressParams, parseIngressResult } from './ingress-codec.js'
import { ROOM_BINDING_RPC_METHODS, isRoomBindingMethod, parseRoomBindingParams, parseRoomBindingResult } from './room-binding-codec.js'
import { ROOM_PROVISIONING_RPC_METHODS, isRoomProvisioningMethod, parseRoomProvisioningParams, parseRoomProvisioningResult } from './room-provisioning-codec.js'
import { AgentMuxError } from './errors.js'
import type { ConnectionConfig, ConnectionMethod, ConnectionObservation, ConnectionOperation, ConnectionParamsMap, ConnectionRecord, ConnectionResultMap } from './connections-contract.js'

export const CONNECTION_RPC_METHODS = { ...ROOM_PROVISIONING_RPC_METHODS, ...ROOM_BINDING_RPC_METHODS, ...CONNECTION_DELIVERY_RPC_METHODS, ...INGRESS_RPC_METHODS, 'connection.ls': 'long', 'connection.inspect': 'long', 'connection.configure': 'long', 'connection.test': 'long' } as const
export const isConnectionMethod = (value: unknown): value is ConnectionMethod => typeof value === 'string' && Object.hasOwn(CONNECTION_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Connection data is malformed or belongs to another original object.', 'INVALID_CONNECTION_DATA') }
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !fields.includes(key))) fail()
  return result
}
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) fail(); return value as string }
function identity(value: unknown): string { const result = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) fail(); return result }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 1) fail(); return value as number }
export function parseConnectionConfig(value: unknown): ConnectionConfig {
  const p = object(value, ['connectionId', 'adapterId', 'application', 'label', 'enabled', 'credentialRef'])
  const app = object(p.application, ['domain', 'appId']), domain = text(app.domain)
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(domain) || typeof p.enabled !== 'boolean') fail()
  return { connectionId: identity(p.connectionId), adapterId: identity(p.adapterId), application: { domain, appId: identity(app.appId) }, label: text(p.label), enabled: p.enabled as boolean, credentialRef: identity(p.credentialRef) }
}
export function parseConnectionObservation(value: unknown): ConnectionObservation {
  const p = object(value, ['authentication', 'transport', 'intake', 'delivery'])
  const stage = (value: unknown) => {
    const s = object(value, ['state', 'reason'])
    if (!['unknown', 'ready', 'unavailable', 'disabled'].includes(s.state as string) || s.reason !== undefined && !['not-tested', 'credential-missing', 'adapter-unavailable', 'check-failed', 'not-started'].includes(s.reason as string)) fail()
    return { state: s.state, ...(s.reason === undefined ? {} : { reason: s.reason }) } as ConnectionObservation['authentication']
  }
  return { authentication: stage(p.authentication), transport: stage(p.transport), intake: stage(p.intake), delivery: stage(p.delivery) }
}
export function parseConnectionRecord(value: unknown): ConnectionRecord {
  const p = object(value, ['config', 'revision', 'observation'])
  return { config: parseConnectionConfig(p.config), revision: revision(p.revision), observation: parseConnectionObservation(p.observation) }
}
function operation(value: unknown): ConnectionOperation {
  const p = object(value, ['operationId', 'status', 'connection'])
  if (p.status !== 'configured') fail()
  return { operationId: identity(p.operationId), status: 'configured', connection: parseConnectionRecord(p.connection) }
}
export function parseConnectionParams<M extends ConnectionMethod>(method: M, value: unknown): ConnectionParamsMap[M] {
  if (isRoomProvisioningMethod(method)) return parseRoomProvisioningParams(method, value) as ConnectionParamsMap[M]
  if (isConnectionDeliveryMethod(method)) return parseConnectionDeliveryParams(method, value) as ConnectionParamsMap[M]
  if (isIngressMethod(method)) return parseIngressParams(method, value) as ConnectionParamsMap[M]
  if (isRoomBindingMethod(method)) return parseRoomBindingParams(method, value) as ConnectionParamsMap[M]
  if (method === 'connection.ls') { object(value, []); return {} as ConnectionParamsMap[M] }
  if (method === 'connection.configure') {
    const p = object(value, ['operationId', 'expectedRevision', 'connection'])
    return { operationId: identity(p.operationId), expectedRevision: p.expectedRevision === null ? null : revision(p.expectedRevision), connection: parseConnectionConfig(p.connection) } as ConnectionParamsMap[M]
  }
  const p = object(value, method === 'connection.test' ? ['connectionId'] : ['connectionId', 'operationId'])
  if (method === 'connection.test') return { connectionId: identity(p.connectionId) } as ConnectionParamsMap[M]
  if ((p.connectionId === undefined) === (p.operationId === undefined)) fail()
  return (p.connectionId === undefined ? { operationId: identity(p.operationId) } : { connectionId: identity(p.connectionId) }) as ConnectionParamsMap[M]
}
export function parseConnectionResult<M extends ConnectionMethod>(method: M, value: unknown, input: ConnectionParamsMap[M]): ConnectionResultMap[M] {
  if (isRoomProvisioningMethod(method)) return parseRoomProvisioningResult(method, value, input as never) as ConnectionResultMap[M]
  if (isConnectionDeliveryMethod(method)) return parseConnectionDeliveryResult(method, value, input as never) as ConnectionResultMap[M]
  if (isIngressMethod(method)) return parseIngressResult(method, value, input as never) as ConnectionResultMap[M]
  if (isRoomBindingMethod(method)) return parseRoomBindingResult(method, value, input as never) as ConnectionResultMap[M]
  if (method === 'connection.ls') {
    const p = object(value, ['connections']); if (!Array.isArray(p.connections)) fail()
    const connections = (p.connections as unknown[]).map(parseConnectionRecord)
    if (new Set(connections.map(c => c.config.connectionId)).size !== connections.length) fail()
    return { connections } as ConnectionResultMap[M]
  }
  if (method === 'connection.configure') {
    const p = operation(value), expected = input as ConnectionParamsMap['connection.configure']
    if (p.operationId !== expected.operationId || JSON.stringify(p.connection.config) !== JSON.stringify(expected.connection) || p.connection.revision !== (expected.expectedRevision ?? 0) + 1) fail()
    return p as ConnectionResultMap[M]
  }
  if (method === 'connection.test') {
    const p = parseConnectionRecord(value); if (p.config.connectionId !== (input as ConnectionParamsMap['connection.test']).connectionId) fail()
    return p as ConnectionResultMap[M]
  }
  const p = object(value, ['connection', 'operation']), expected = input as ConnectionParamsMap['connection.inspect']
  const connection = p.connection === null ? null : parseConnectionRecord(p.connection), saved = p.operation === null ? null : operation(p.operation)
  if (expected.operationId ? saved && saved.operationId !== expected.operationId || connection && connection.config.connectionId !== saved?.connection.config.connectionId : saved !== null || connection && connection.config.connectionId !== expected.connectionId) fail()
  return { connection, operation: saved } as ConnectionResultMap[M]
}
