import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConversationCheckpoint } from './conversation-changes.js'
import type { ConnectionActor, ConnectionApplication, ConnectionGrant } from './connections-contract.js'
import type { RoomBinding, RoomBindingAuthority, RoomBindingMethod, RoomBindingOperation, RoomBindingParamsMap, RoomBindingResultMap, RoomBindingScope } from './room-binding-contract.js'

export const ROOM_BINDING_RPC_METHODS = { 'connection.bind': 'long', 'connection.binding.inspect': 'long', 'connection.binding.ls': 'long', 'connection.binding.pause': 'long', 'connection.binding.relink': 'long', 'connection.grant': 'long' } as const
export const isRoomBindingMethod = (value: unknown): value is RoomBindingMethod => typeof value === 'string' && Object.hasOwn(ROOM_BINDING_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Binding data does not describe the original authorized objects.', 'INVALID_ROOM_BINDING_DATA') }
const object = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'INVALID_ROOM_BINDING_DATA')
function text(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 16_384 || /[\0\r\n]/u.test(value)) fail(); return value as string }
function id(value: unknown): string { const result = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) fail(); return result }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) fail(); return value as number }
function application(value: unknown): ConnectionApplication { const p = object(value, ['domain', 'appId']), domain = text(p.domain); if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(domain)) fail(); return { domain, appId: id(p.appId) } }
function source(value: unknown) { const p = object(value, ['providerId', 'nativeSessionId']); return { providerId: text(p.providerId), nativeSessionId: text(p.nativeSessionId) } }
function scope(value: unknown): RoomBindingScope { const p = object(value, ['input', 'publication']); if (!['mentions-and-replies', 'all-messages'].includes(String(p.input)) || p.publication !== 'future-native-user-facing') fail(); return { input: p.input as RoomBindingScope['input'], publication: 'future-native-user-facing' } }
function target(p: Record<string, unknown>) { const anchor = object(p.regionAnchor, ['regionId']); return { executionHostId: id(p.executionHostId), agentSessionId: id(p.agentSessionId), regionAnchor: { regionId: id(anchor.regionId) } } }
export function parseRoomBindingAuthority(value: unknown): RoomBindingAuthority { const p = object(value, ['kind', 'id']); if (p.kind !== 'user' && p.kind !== 'device') fail(); return { kind: p.kind as RoomBindingAuthority['kind'], id: text(p.id) } }
export function parseConnectionActor(value: unknown): ConnectionActor { const p = object(value, ['application', 'idType', 'userId']); return { application: application(p.application), idType: id(p.idType), userId: id(p.userId) } }
function capabilities(value: unknown): ConnectionGrant['capabilities'] { if (!Array.isArray(value) || value.length > 3 || new Set(value).size !== value.length || value.some(v => !['input', 'answer', 'permission'].includes(v))) fail(); return [...value as ConnectionGrant['capabilities']] }
export function parseConnectionGrant(value: unknown): ConnectionGrant {
  const p = object(value, ['grantId', 'revision', 'bindingId', 'bindingRevision', 'connectionId', 'actor', 'externalConversationId', 'state', 'capabilities'])
  if (p.state !== 'active' && p.state !== 'revoked') fail()
  return { grantId: id(p.grantId), revision: revision(p.revision), bindingId: id(p.bindingId), bindingRevision: revision(p.bindingRevision), connectionId: id(p.connectionId), actor: parseConnectionActor(p.actor), externalConversationId: id(p.externalConversationId), state: p.state as ConnectionGrant['state'], capabilities: capabilities(p.capabilities) }
}
export function parseRoomBinding(value: unknown): RoomBinding {
  const p = object(value, ['bindingId', 'revision', 'state', 'connectionId', 'application', 'externalConversationId', 'scope', 'executionHostId', 'agentSessionId', 'regionAnchor', 'sourceCheckpoints', 'authorizedBy'])
  if (p.state !== 'active' && p.state !== 'paused' || !Array.isArray(p.sourceCheckpoints) || p.sourceCheckpoints.length < 1 || p.sourceCheckpoints.length > 32) fail()
  const t = target(p), checkpoints = (p.sourceCheckpoints as unknown[]).map(parseConversationCheckpoint)
  if (checkpoints.some(c => c.agentSessionId !== t.agentSessionId) || new Set(checkpoints.map(c => JSON.stringify(c.source))).size !== checkpoints.length) fail()
  return { ...t, bindingId: id(p.bindingId), revision: revision(p.revision), state: p.state as RoomBinding['state'], connectionId: id(p.connectionId), application: application(p.application), externalConversationId: id(p.externalConversationId), scope: scope(p.scope), sourceCheckpoints: checkpoints, authorizedBy: parseRoomBindingAuthority(p.authorizedBy) }
}
export function parseRoomBindingOperation(value: unknown): RoomBindingOperation {
  const p = object(value, ['operationId', 'action', 'state', 'binding', 'grant', 'reused', 'code'])
  if (!['bind', 'pause', 'relink', 'grant'].includes(String(p.action))) fail()
  const base = { operationId: id(p.operationId), action: p.action as RoomBindingOperation['action'] }
  if (p.state === 'preparing') { if (['binding', 'grant', 'reused', 'code'].some(k => p[k] !== undefined)) fail(); return { ...base, state: 'preparing' } }
  if (p.state === 'refused') { if (['binding', 'grant', 'reused'].some(k => p[k] !== undefined)) fail(); return { ...base, state: 'refused', code: id(p.code) } }
  if (p.state !== 'applied' || p.code !== undefined || p.reused !== undefined && typeof p.reused !== 'boolean') fail()
  const binding = parseRoomBinding(p.binding), grant = p.grant === undefined ? undefined : parseConnectionGrant(p.grant)
  if (grant && (base.action !== 'grant' || grant.bindingId !== binding.bindingId || grant.bindingRevision !== binding.revision || grant.connectionId !== binding.connectionId || grant.externalConversationId !== binding.externalConversationId || JSON.stringify(grant.actor.application) !== JSON.stringify(binding.application))) fail()
  return { ...base, state: 'applied', binding, ...(grant ? { grant } : {}), ...(p.reused === undefined ? {} : { reused: p.reused as boolean }) }
}
export function parseRoomBindingParams<M extends RoomBindingMethod>(method: M, value: unknown): RoomBindingParamsMap[M] {
  if (method === 'connection.binding.inspect') {
    const p = object(value, ['bindingId', 'revision', 'operationId'])
    if ((p.bindingId === undefined) === (p.operationId === undefined) || p.operationId !== undefined && p.revision !== undefined) fail()
    return (p.operationId !== undefined ? { operationId: id(p.operationId) } : { bindingId: id(p.bindingId), ...(p.revision === undefined ? {} : { revision: revision(p.revision) }) }) as RoomBindingParamsMap[M]
  }
  if (method === 'connection.binding.ls') {
    const p = object(value, ['connectionId', 'executionHostId', 'agentSessionId'])
    return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, id(v)])) as RoomBindingParamsMap[M]
  }
  if (method === 'connection.binding.pause') { const p = object(value, ['operationId', 'bindingId', 'expectedRevision']); return { operationId: id(p.operationId), bindingId: id(p.bindingId), expectedRevision: revision(p.expectedRevision) } as RoomBindingParamsMap[M] }
  if (method === 'connection.grant') {
    const p = object(value, ['operationId', 'bindingId', 'expectedBindingRevision', 'grantId', 'expectedRevision', 'actor', 'capabilities', 'state'])
    if (p.state !== 'active' && p.state !== 'revoked') fail()
    return { operationId: id(p.operationId), bindingId: id(p.bindingId), expectedBindingRevision: revision(p.expectedBindingRevision), grantId: id(p.grantId), expectedRevision: p.expectedRevision === null ? null : revision(p.expectedRevision), actor: parseConnectionActor(p.actor), capabilities: capabilities(p.capabilities), state: p.state as ConnectionGrant['state'] } as RoomBindingParamsMap[M]
  }
  const p = object(value, ['operationId', 'bindingId', 'connectionId', 'expectedConnectionRevision', 'externalConversationId', 'scope', 'expectedSource', 'executionHostId', 'agentSessionId', 'regionAnchor', ...(method === 'connection.binding.relink' ? ['expectedRevision'] : [])])
  return { ...target(p), operationId: id(p.operationId), bindingId: id(p.bindingId), connectionId: id(p.connectionId), expectedConnectionRevision: revision(p.expectedConnectionRevision), externalConversationId: id(p.externalConversationId), scope: scope(p.scope), expectedSource: source(p.expectedSource), ...(method === 'connection.binding.relink' ? { expectedRevision: revision(p.expectedRevision) } : {}) } as RoomBindingParamsMap[M]
}
export function parseRoomBindingResult<M extends RoomBindingMethod>(method: M, value: unknown, input: RoomBindingParamsMap[M]): RoomBindingResultMap[M] {
  if (method === 'connection.binding.ls') {
    const p = object(value, ['bindings']); if (!Array.isArray(p.bindings)) fail()
    const bindings = (p.bindings as unknown[]).map(parseRoomBinding)
    if (new Set(bindings.map(b => b.bindingId)).size !== bindings.length || bindings.some(b => Object.entries(input).some(([k,v]) => b[k as keyof RoomBinding] !== v))) fail()
    return { bindings } as RoomBindingResultMap[M]
  }
  if (method === 'connection.binding.inspect') {
    const p = object(value, ['binding', 'current', 'operation', 'grants']), expected = input as RoomBindingParamsMap['connection.binding.inspect']
    const binding = p.binding === null ? null : parseRoomBinding(p.binding), current = p.current === null ? null : parseRoomBinding(p.current), operation = p.operation === null ? null : parseRoomBindingOperation(p.operation)
    if (!Array.isArray(p.grants)) fail(); const grants = (p.grants as unknown[]).map(parseConnectionGrant)
    if (expected.operationId ? operation && operation.operationId !== expected.operationId || binding && (operation?.state !== 'applied' || JSON.stringify(binding) !== JSON.stringify(operation.binding)) : operation !== null || binding && (binding.bindingId !== expected.bindingId || expected.revision !== undefined && binding.revision !== expected.revision)) fail()
    if (current && current.bindingId !== (binding?.bindingId ?? expected.bindingId) || grants.some(g => !binding || g.bindingId !== binding.bindingId || g.bindingRevision !== binding.revision)) fail()
    return { binding, current, operation, grants } as RoomBindingResultMap[M]
  }
  const op = parseRoomBindingOperation(value), expected = input as RoomBindingParamsMap['connection.bind'] & RoomBindingParamsMap['connection.grant'] & RoomBindingParamsMap['connection.binding.relink']
  const action = method === 'connection.bind' ? 'bind' : method === 'connection.grant' ? 'grant' : method === 'connection.binding.pause' ? 'pause' : 'relink'
  if (op.operationId !== expected.operationId || op.action !== action) fail()
  if (op.state === 'applied') {
    const b = op.binding
    if (b.bindingId !== expected.bindingId && !op.reused || action !== 'bind' && op.reused) fail()
    if (action === 'bind' || action === 'relink') {
      if (b.connectionId !== expected.connectionId || b.executionHostId !== expected.executionHostId || b.agentSessionId !== expected.agentSessionId || b.externalConversationId !== expected.externalConversationId || JSON.stringify(b.scope) !== JSON.stringify(expected.scope) || b.sourceCheckpoints.some(c => JSON.stringify(c.source) !== JSON.stringify(expected.expectedSource)) || action === 'relink' && b.revision !== expected.expectedRevision + 1) fail()
    } else if (action === 'pause' && (b.state !== 'paused' || b.revision !== expected.expectedRevision + 1)) fail()
    else if (action === 'grant' && (!op.grant || b.revision !== expected.expectedBindingRevision || op.grant.grantId !== expected.grantId || op.grant.revision !== (expected.expectedRevision ?? 0) + 1 || JSON.stringify(op.grant.actor) !== JSON.stringify(expected.actor) || JSON.stringify(op.grant.capabilities) !== JSON.stringify(expected.capabilities) || op.grant.state !== expected.state)) fail()
  }
  return op as RoomBindingResultMap[M]
}
