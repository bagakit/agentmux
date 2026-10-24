import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConnectionActor, parseConnectionApplication, parseConnectionGrantCapabilities } from './room-binding-codec.js'
import type { ConnectionApplicationAccessMethod, ConnectionApplicationAccessParamsMap, ConnectionApplicationAccessResultMap, ConnectionApplicationAccessOperation, ConnectionApplicationGrant } from './connection-application-access-contract.js'

export const CONNECTION_APPLICATION_ACCESS_RPC_METHODS = { 'connection.application.access.get': 'long', 'connection.application.access.configure': 'long', 'connection.application.access.inspect': 'long' } as const
export const isConnectionApplicationAccessMethod = (value: unknown): value is ConnectionApplicationAccessMethod => typeof value === 'string' && Object.hasOwn(CONNECTION_APPLICATION_ACCESS_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Application access data does not identify the original scope or operation.', 'INVALID_APPLICATION_ACCESS_DATA') }
const object = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'INVALID_APPLICATION_ACCESS_DATA')
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function id(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) fail(); return value as string }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) fail(); return value as number }
function state(value: unknown): 'active' | 'revoked' { if (value !== 'active' && value !== 'revoked') fail(); return value as 'active' | 'revoked' }
export function parseConnectionApplicationGrant(value: unknown): ConnectionApplicationGrant {
  const p = object(value, ['grantId', 'revision', 'adapterId', 'actor', 'state', 'capabilities'])
  return { grantId: id(p.grantId), revision: revision(p.revision), adapterId: id(p.adapterId), actor: parseConnectionActor(p.actor), state: state(p.state), capabilities: parseConnectionGrantCapabilities(p.capabilities) }
}
export function parseConnectionApplicationAccessOperation(value: unknown): ConnectionApplicationAccessOperation {
  const p = object(value, ['operationId', 'state', 'code', 'grant']), operationId = id(p.operationId)
  if (p.state === 'refused' && p.grant === undefined) return { operationId, state: 'refused', code: id(p.code) }
  if (p.state === 'applied' && p.code === undefined) return { operationId, state: 'applied', grant: parseConnectionApplicationGrant(p.grant) }
  return fail()
}
export function parseConnectionApplicationAccessParams<M extends ConnectionApplicationAccessMethod>(method: M, value: unknown): ConnectionApplicationAccessParamsMap[M] {
  if (method === 'connection.application.access.inspect') return { operationId: id(object(value, ['operationId']).operationId) } as ConnectionApplicationAccessParamsMap[M]
  if (method === 'connection.application.access.get') { const p = object(value, ['connectionId', 'actor']); return { connectionId: id(p.connectionId), ...(p.actor === undefined ? {} : { actor: parseConnectionActor(p.actor) }) } as ConnectionApplicationAccessParamsMap[M] }
  const p = object(value, ['operationId', 'connectionId', 'expectedConnectionRevision', 'grantId', 'expectedRevision', 'actor', 'state', 'capabilities'])
  return { operationId: id(p.operationId), connectionId: id(p.connectionId), expectedConnectionRevision: revision(p.expectedConnectionRevision), grantId: id(p.grantId), expectedRevision: p.expectedRevision === null ? null : revision(p.expectedRevision), actor: parseConnectionActor(p.actor), state: state(p.state), capabilities: parseConnectionGrantCapabilities(p.capabilities) } as ConnectionApplicationAccessParamsMap[M]
}
export function parseConnectionApplicationAccessResult<M extends ConnectionApplicationAccessMethod>(method: M, value: unknown, input: ConnectionApplicationAccessParamsMap[M]): ConnectionApplicationAccessResultMap[M] {
  if (method === 'connection.application.access.get') {
    const p = object(value, ['connectionId', 'connectionRevision', 'adapterId', 'application', 'grants']), expected = input as ConnectionApplicationAccessParamsMap['connection.application.access.get']
    const connectionId = id(p.connectionId), connectionRevision = revision(p.connectionRevision), adapterId = id(p.adapterId), application = parseConnectionApplication(p.application)
    if (!Array.isArray(p.grants) || connectionId !== expected.connectionId || expected.actor && !equal(expected.actor.application, application)) fail()
    const grants = (p.grants as unknown[]).map(parseConnectionApplicationGrant)
    if (new Set(grants.map(g => JSON.stringify(g.actor))).size !== grants.length || grants.some(g => g.adapterId !== adapterId || !equal(g.actor.application, application) || expected.actor && !equal(g.actor, expected.actor))) fail()
    return { connectionId, connectionRevision, adapterId, application, grants } as ConnectionApplicationAccessResultMap[M]
  }
  if (method === 'connection.application.access.inspect') {
    const p = object(value, ['operation']), operation = p.operation === null ? null : parseConnectionApplicationAccessOperation(p.operation)
    if (operation && operation.operationId !== (input as { operationId: string }).operationId) fail()
    return { operation } as ConnectionApplicationAccessResultMap[M]
  }
  const operation = parseConnectionApplicationAccessOperation(value), expected = input as ConnectionApplicationAccessParamsMap['connection.application.access.configure']
  if (operation.operationId !== expected.operationId || operation.state === 'applied' && (operation.grant.grantId !== expected.grantId || operation.grant.revision !== (expected.expectedRevision ?? 0) + 1 || !equal(operation.grant.actor, expected.actor) || operation.grant.state !== expected.state || !equal(operation.grant.capabilities, expected.capabilities))) fail()
  return operation as ConnectionApplicationAccessResultMap[M]
}
