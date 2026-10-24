import { CONNECTION_API_RPC_METHODS, isConnectionApiMethod, parseConnectionApiParams, parseConnectionApiResult } from './connection-api-codec.js'
import { CONNECTION_APPLICATION_ACCESS_RPC_METHODS, isConnectionApplicationAccessMethod, parseConnectionApplicationAccessParams, parseConnectionApplicationAccessResult } from './connection-application-access-codec.js'
import { CONNECTION_CREDENTIAL_RPC_METHODS, isConnectionCredentialMethod, parseConnectionCredentialParams, parseConnectionCredentialResult } from './connection-credential-codec.js'
import { CHANNEL_METADATA_RPC_METHODS, isChannelMetadataMethod, parseChannelMetadataParams, parseChannelMetadataResult } from './channel-metadata-codec.js'
import { CONNECTION_DELETION_RPC_METHODS, isConnectionDeletionMethod, parseConnectionDeletionParams, parseConnectionDeletionResult } from './connection-deletion-codec.js'
import { parseConnectionDiagnosisInput, parseConnectionDiagnosis } from './connection-diagnosis-codec.js'
import { CONNECTION_SETUP_RPC_METHODS, isConnectionSetupMethod, parseConnectionSetupParams, parseConnectionSetupResult } from './connection-setup-codec.js'
import { CONNECTION_SERVICE_RPC_METHODS, isConnectionServiceMethod, parseConnectionServiceParams, parseConnectionServiceResult } from './connection-service-codec.js'
import { parseConnectionConfig, parseConnectionRecord } from './connection-record-codec.js'
export { parseConnectionConfig, parseConnectionRecord, parseConnectionObservation } from './connection-record-codec.js'
import { CONNECTION_PROFILE_RPC_METHODS, isConnectionProfileMethod, parseConnectionProfileParams, parseConnectionProfileResult } from './connection-profile-codec.js'
import { CONNECTION_ENROLLMENT_RPC_METHODS, isConnectionEnrollmentMethod, parseConnectionEnrollmentParams, parseConnectionEnrollmentResult } from './connection-enrollment-codec.js'
import { CONNECTION_DELIVERY_RPC_METHODS, isConnectionDeliveryMethod, parseConnectionDeliveryParams, parseConnectionDeliveryResult } from './connection-delivery-codec.js'
import { INGRESS_RPC_METHODS, isIngressMethod, parseIngressParams, parseIngressResult } from './ingress-codec.js'
import { ROOM_BINDING_RPC_METHODS, isRoomBindingMethod, parseRoomBindingParams, parseRoomBindingResult } from './room-binding-codec.js'
import { ROOM_PROVISIONING_RPC_METHODS, isRoomProvisioningMethod, parseRoomProvisioningParams, parseRoomProvisioningResult } from './room-provisioning-codec.js'
import { ROOM_DISCOVERY_RPC_METHODS, isRoomDiscoveryMethod, parseRoomDiscoveryParams, parseRoomDiscoveryResult } from './room-discovery-codec.js'
import { AgentMuxError } from './errors.js'
import type { ConnectionMethod, ConnectionOperation, ConnectionParamsMap, ConnectionResultMap } from './connections-contract.js'

export const CONNECTION_RPC_METHODS = { ...CONNECTION_API_RPC_METHODS, ...CONNECTION_APPLICATION_ACCESS_RPC_METHODS, ...CONNECTION_CREDENTIAL_RPC_METHODS, ...CHANNEL_METADATA_RPC_METHODS, ...CONNECTION_DELETION_RPC_METHODS, ...CONNECTION_SETUP_RPC_METHODS, ...CONNECTION_SERVICE_RPC_METHODS, ...CONNECTION_PROFILE_RPC_METHODS, ...CONNECTION_ENROLLMENT_RPC_METHODS, ...ROOM_DISCOVERY_RPC_METHODS, ...ROOM_PROVISIONING_RPC_METHODS, ...ROOM_BINDING_RPC_METHODS, ...CONNECTION_DELIVERY_RPC_METHODS, ...INGRESS_RPC_METHODS, 'connection.owner.inspect': 'long', 'connection.diagnose': 'long', 'connection.ls': 'long', 'connection.inspect': 'long', 'connection.configure': 'long', 'connection.test': 'long' } as const
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
function operation(value: unknown): ConnectionOperation {
  const p = object(value, ['operationId', 'status', 'connection'])
  if (p.status !== 'configured') fail()
  return { operationId: identity(p.operationId), status: 'configured', connection: parseConnectionRecord(p.connection) }
}
export function parseConnectionParams<M extends ConnectionMethod>(method: M, value: unknown): ConnectionParamsMap[M] {
  if (isConnectionApiMethod(method)) return parseConnectionApiParams(method, value) as ConnectionParamsMap[M]
  if (isConnectionApplicationAccessMethod(method)) return parseConnectionApplicationAccessParams(method, value) as ConnectionParamsMap[M]
  if (isConnectionCredentialMethod(method)) return parseConnectionCredentialParams(method, value) as ConnectionParamsMap[M]
  if (isChannelMetadataMethod(method)) return parseChannelMetadataParams(method, value) as ConnectionParamsMap[M]
  if (isConnectionDeletionMethod(method)) return parseConnectionDeletionParams(method, value) as ConnectionParamsMap[M]
  if (method === 'connection.diagnose') return parseConnectionDiagnosisInput(value) as ConnectionParamsMap[M]
  if (isConnectionSetupMethod(method)) return parseConnectionSetupParams(method, value) as ConnectionParamsMap[M]
  if (isConnectionServiceMethod(method)) return parseConnectionServiceParams(method, value) as ConnectionParamsMap[M]
  if (isConnectionProfileMethod(method)) return parseConnectionProfileParams(method, value) as ConnectionParamsMap[M]
  if (isConnectionEnrollmentMethod(method)) return parseConnectionEnrollmentParams(method, value) as ConnectionParamsMap[M]
  if (isRoomDiscoveryMethod(method)) return parseRoomDiscoveryParams(method, value) as ConnectionParamsMap[M]
  if (isRoomProvisioningMethod(method)) return parseRoomProvisioningParams(method, value) as ConnectionParamsMap[M]
  if (isConnectionDeliveryMethod(method)) return parseConnectionDeliveryParams(method, value) as ConnectionParamsMap[M]
  if (isIngressMethod(method)) return parseIngressParams(method, value) as ConnectionParamsMap[M]
  if (isRoomBindingMethod(method)) return parseRoomBindingParams(method, value) as ConnectionParamsMap[M]
  if (method === 'connection.ls' || method === 'connection.owner.inspect') { object(value, []); return {} as ConnectionParamsMap[M] }
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
  if (isConnectionApiMethod(method)) return parseConnectionApiResult(method, value, input as never) as ConnectionResultMap[M]
  if (method === 'connection.owner.inspect') {
    const p = object(value, ['ownership'])
    if (p.ownership !== 'local' && p.ownership !== 'forwarded' && p.ownership !== 'unavailable') fail()
    return { ownership: p.ownership } as ConnectionResultMap[M]
  }
  if (isConnectionApplicationAccessMethod(method)) return parseConnectionApplicationAccessResult(method, value, input as never) as ConnectionResultMap[M]
  if (isConnectionCredentialMethod(method)) return parseConnectionCredentialResult(method, value) as ConnectionResultMap[M]
  if (isChannelMetadataMethod(method)) return parseChannelMetadataResult(method, value, input as never) as ConnectionResultMap[M]
  if (isConnectionDeletionMethod(method)) return parseConnectionDeletionResult(method, value, input as never) as ConnectionResultMap[M]
  if (method === 'connection.diagnose') return parseConnectionDiagnosis(value, input as ConnectionParamsMap['connection.diagnose']) as ConnectionResultMap[M]
  if (isConnectionSetupMethod(method)) return parseConnectionSetupResult(method, value, input as never) as ConnectionResultMap[M]
  if (isConnectionServiceMethod(method)) return parseConnectionServiceResult(method, value, input as never) as ConnectionResultMap[M]
  if (isConnectionProfileMethod(method)) return parseConnectionProfileResult(method, value, input as never) as ConnectionResultMap[M]
  if (isConnectionEnrollmentMethod(method)) return parseConnectionEnrollmentResult(method, value, input as never) as ConnectionResultMap[M]
  if (isRoomDiscoveryMethod(method)) return parseRoomDiscoveryResult(method, value, input as never) as ConnectionResultMap[M]
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
