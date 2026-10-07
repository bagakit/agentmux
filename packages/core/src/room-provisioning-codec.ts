import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConnectionApplication, parseConnectionMember, parseRoomBindingAuthority, parseRoomBindingTarget } from './room-binding-codec.js'
import type { RoomCreationState, RoomMember, RoomMembershipState, RoomProvisioningMethod, RoomProvisioningOperation, RoomProvisioningParamsMap, RoomProvisioningRefusal, RoomProvisioningResultMap } from './room-provisioning-contract.js'

export const ROOM_PROVISIONING_RPC_METHODS = { 'connection.room.create': 'long', 'connection.room.inspect': 'long' } as const
export const isRoomProvisioningMethod = (value: unknown): value is RoomProvisioningMethod => typeof value === 'string' && Object.hasOwn(ROOM_PROVISIONING_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Room provisioning data does not describe the original operation.', 'INVALID_ROOM_PROVISIONING_DATA') }
const object = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'INVALID_ROOM_PROVISIONING_DATA')
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) fail(); return value as string }
function id(value: unknown): string { const result = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) fail(); return result }
function members(value: unknown): RoomMember[] {
  if (!Array.isArray(value)) fail()
  const result = (value as unknown[]).map(parseConnectionMember)
  if (new Set(result.map(member => JSON.stringify(member))).size !== result.length) fail()
  return result
}
const refusals: readonly RoomProvisioningRefusal[] = ['connection-unavailable', 'connection-revised', 'target-unavailable', 'target-changed', 'adapter-unavailable', 'credential-unavailable', 'authority-unavailable', 'existing-operation', 'platform-not-applied']
function reason(value: unknown): RoomProvisioningRefusal { if (!refusals.includes(value as RoomProvisioningRefusal)) fail(); return value as RoomProvisioningRefusal }
function creation(value: unknown): RoomCreationState {
  const p = object(value, ['state', 'attemptId', 'externalConversationId', 'reason', 'originalOperationId'])
  if (p.state === 'pending') { if (Object.keys(p).length !== 1) fail(); return { state: 'pending' } }
  if (p.state === 'created') {
    if (p.reason !== undefined || p.originalOperationId !== undefined) fail()
    return { state: 'created', attemptId: id(p.attemptId), externalConversationId: text(p.externalConversationId) }
  }
  if (p.state === 'dispatching' || p.state === 'unknown') {
    if (p.externalConversationId !== undefined || p.reason !== undefined || p.originalOperationId !== undefined) fail()
    return { state: p.state, attemptId: id(p.attemptId) }
  }
  if (p.state !== 'not-applied' || p.externalConversationId !== undefined) fail()
  const refusal = reason(p.reason)
  if ((refusal === 'existing-operation') !== (p.originalOperationId !== undefined) || refusal === 'platform-not-applied' && p.attemptId === undefined) fail()
  return { state: 'not-applied', reason: refusal, ...(p.attemptId === undefined ? {} : { attemptId: id(p.attemptId) }), ...(p.originalOperationId === undefined ? {} : { originalOperationId: id(p.originalOperationId) }) }
}
function membership(value: unknown, original: RoomMember[]): RoomMembershipState {
  const p = object(value, ['state', 'attemptId', 'results', 'reason'])
  if (p.state === 'pending' || p.state === 'not-requested') {
    if (Object.keys(p).length !== 1 || (p.state === 'not-requested') !== (original.length === 0)) fail()
    return { state: p.state }
  }
  if (!original.length) fail()
  if (p.state === 'not-applied') { if (p.attemptId !== undefined || p.results !== undefined) fail(); return { state: 'not-applied', reason: reason(p.reason) } }
  if (p.state === 'dispatching') { if (p.reason !== undefined || p.results !== undefined) fail(); return { state: 'dispatching', attemptId: id(p.attemptId) } }
  if (p.state !== 'settled' || p.reason !== undefined || !Array.isArray(p.results) || p.results.length !== original.length) fail()
  const results = (p.results as unknown[]).map((entry, index) => {
    const e = object(entry, ['member', 'state']), member = parseConnectionMember(e.member)
    if (JSON.stringify(member) !== JSON.stringify(original[index]) || !['joined', 'not-applied', 'unknown'].includes(String(e.state))) fail()
    return { member, state: e.state as 'joined' | 'not-applied' | 'unknown' }
  })
  return { state: 'settled', attemptId: id(p.attemptId), results }
}
export function parseRoomProvisioningParams<M extends RoomProvisioningMethod>(method: M, value: unknown): RoomProvisioningParamsMap[M] {
  if (method === 'connection.room.inspect') { const p = object(value, ['operationId']); return { operationId: id(p.operationId) } as RoomProvisioningParamsMap[M] }
  const p = object(value, ['operationId', 'connectionId', 'expectedConnectionRevision', 'executionHostId', 'agentSessionId', 'regionAnchor', 'name', 'members'])
  if (!Number.isSafeInteger(p.expectedConnectionRevision) || Number(p.expectedConnectionRevision) < 1) fail()
  return { ...parseRoomBindingTarget({ executionHostId: p.executionHostId, agentSessionId: p.agentSessionId, regionAnchor: p.regionAnchor }), operationId: id(p.operationId), connectionId: id(p.connectionId), expectedConnectionRevision: Number(p.expectedConnectionRevision), name: text(p.name), members: members(p.members) } as RoomProvisioningParamsMap[M]
}
export function parseRoomProvisioningOperation(value: unknown): RoomProvisioningOperation {
  const p = object(value, ['operationId', 'input', 'authorizedBy', 'application', 'adapterId', 'creation', 'membership'])
  const input = parseRoomProvisioningParams('connection.room.create', p.input), operationId = id(p.operationId), created = creation(p.creation), joined = membership(p.membership, input.members)
  const application = p.application === null ? null : parseConnectionApplication(p.application), adapterId = p.adapterId === null ? null : id(p.adapterId)
  if (operationId !== input.operationId || (application === null) !== (adapterId === null) || created.state !== 'not-applied' && (!application || !adapterId) || 'attemptId' in created && (!application || !adapterId)) fail()
  if (created.state !== 'created' && (joined.state === 'dispatching' || joined.state === 'settled') || created.state === 'not-applied' && (created.originalOperationId === operationId || input.members.length > 0 && joined.state !== 'not-applied')) fail()
  if (created.state !== 'created' && created.state !== 'not-applied' && input.members.length > 0 && joined.state !== 'pending') fail()
  return { operationId, input, authorizedBy: parseRoomBindingAuthority(p.authorizedBy), application, adapterId, creation: created, membership: joined }
}
export function parseRoomProvisioningResult<M extends RoomProvisioningMethod>(method: M, value: unknown, input: RoomProvisioningParamsMap[M]): RoomProvisioningResultMap[M] {
  if (method === 'connection.room.inspect') {
    const p = object(value, ['operation']), operation = p.operation === null ? null : parseRoomProvisioningOperation(p.operation)
    if (operation && operation.operationId !== input.operationId) fail()
    return { operation } as RoomProvisioningResultMap[M]
  }
  const operation = parseRoomProvisioningOperation(value)
  if (JSON.stringify(operation.input) !== JSON.stringify(input)) fail()
  return operation as RoomProvisioningResultMap[M]
}
