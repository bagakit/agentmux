import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConnectionApplication, parseRoomBindingAuthority } from './room-binding-codec.js'
import type { RoomDiscoveryMethod, RoomDiscoveryParamsMap, RoomDiscoveryResultMap, RoomDiscoveryObservation, RoomDiscoveryReason, RoomLinkOperation, RoomSummary, RoomDetails, RoomDiscoveredMember } from './room-discovery-contract.js'

export const ROOM_DISCOVERY_RPC_METHODS = { 'connection.room.ls': 'long', 'connection.room.search': 'long', 'connection.room.get': 'long', 'connection.room.members': 'long', 'connection.room.link.create': 'long', 'connection.room.link.inspect': 'long' } as const
export const isRoomDiscoveryMethod = (value: unknown): value is RoomDiscoveryMethod => typeof value === 'string' && Object.hasOwn(ROOM_DISCOVERY_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Room discovery data does not describe the exact application and room.', 'INVALID_ROOM_DISCOVERY_DATA') }
const object = (v: unknown, keys: string[]) => rpcRecord(v, keys, 'INVALID_ROOM_DISCOVERY_DATA')
function text(v: unknown, max = 4096): string { if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/u.test(v)) fail(); return v as string }
function id(v: unknown): string { const s = text(v, 256); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(s)) fail(); return s }
function integer(v: unknown, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > max) fail(); return Number(v) }
function choice<T extends string>(v: unknown, choices: readonly T[]): T { if (!choices.includes(v as T)) fail(); return v as T }
const reasons: readonly RoomDiscoveryReason[] = ['connection-unavailable', 'connection-revised', 'adapter-unavailable', 'credential-unavailable', 'permission-denied', 'room-unavailable', 'platform-unavailable', 'response-unconfirmed', 'authority-unavailable']
export function parseRoomDiscoveryObservation(value: unknown): RoomDiscoveryObservation {
  const p = object(value, ['state', 'reason'])
  if (p.state === 'ready') { if (p.reason !== undefined) fail(); return { state: 'ready' } }
  return { state: choice(p.state, ['unknown', 'unavailable']), reason: choice(p.reason, reasons) }
}
export function parseRoomDiscoveryParams<M extends RoomDiscoveryMethod>(method: M, value: unknown): RoomDiscoveryParamsMap[M] {
  if (method === 'connection.room.link.inspect') { const p = object(value, ['operationId']); return { operationId: id(p.operationId) } as RoomDiscoveryParamsMap[M] }
  const paged = method === 'connection.room.ls' || method === 'connection.room.search' || method === 'connection.room.members'
  const targeted = method === 'connection.room.get' || method === 'connection.room.members' || method === 'connection.room.link.create'
  const p = object(value, ['connectionId', 'expectedConnectionRevision', ...(paged ? ['cursor', 'limit'] : []), ...(targeted ? ['externalConversationId'] : []), ...(method === 'connection.room.search' ? ['query'] : []), ...(method === 'connection.room.link.create' ? ['operationId'] : [])])
  return { connectionId: id(p.connectionId), expectedConnectionRevision: integer(p.expectedConnectionRevision),
    ...(paged && p.cursor !== undefined ? { cursor: text(p.cursor, 16384) } : {}), ...(paged && p.limit !== undefined ? { limit: integer(p.limit, 100) } : {}),
    ...(targeted ? { externalConversationId: text(p.externalConversationId) } : {}), ...(method === 'connection.room.search' ? { query: text(p.query, 64) } : {}), ...(method === 'connection.room.link.create' ? { operationId: id(p.operationId) } : {}) } as RoomDiscoveryParamsMap[M]
}
function summary(value: unknown, detailed = false): RoomSummary | RoomDetails {
  const p = object(value, ['externalConversationId', 'name', 'state', ...(detailed ? ['mode', 'membershipApproval'] : [])])
  return { externalConversationId: text(p.externalConversationId), name: p.name === null ? null : text(p.name), state: choice(p.state, ['active', 'dissolved', 'unknown']),
    ...(detailed ? { mode: choice(p.mode, ['group', 'topic', 'direct', 'unknown']), membershipApproval: choice(p.membershipApproval, ['required', 'not-required', 'unknown']) } : {}) }
}
export function parseRoomLinkOperation(value: unknown): RoomLinkOperation {
  const p = object(value, ['operationId', 'input', 'application', 'authorizedBy', 'state', 'reason', 'link'])
  const input = parseRoomDiscoveryParams('connection.room.link.create', p.input), operationId = id(p.operationId)
  if (operationId !== input.operationId) fail()
  const base = { operationId, input, application: p.application === null ? null : parseConnectionApplication(p.application), authorizedBy: parseRoomBindingAuthority(p.authorizedBy) }
  if (p.state === 'confirmed') {
    if (p.reason !== undefined || !base.application) fail()
    const l = object(p.link, ['url', 'expiresAtUnixSeconds']), url = text(l.url, 16384)
    try { const u = new URL(url); if (u.protocol !== 'https:' || u.username || u.password || u.hash) fail() } catch { fail() }
    return { ...base, state: 'confirmed', link: { url, expiresAtUnixSeconds: integer(l.expiresAtUnixSeconds) } }
  }
  if (p.link !== undefined) fail()
  if (p.state === 'refused') return { ...base, state: 'refused', reason: choice(p.reason, reasons) }
  if (p.reason !== undefined || !base.application) fail()
  return { ...base, state: choice(p.state, ['dispatching', 'unknown']) }
}
export function parseRoomDiscoveryResult<M extends RoomDiscoveryMethod>(method: M, value: unknown, input: RoomDiscoveryParamsMap[M]): RoomDiscoveryResultMap[M] {
  if (method === 'connection.room.link.inspect') {
    const p = object(value, ['operation']), operation = p.operation === null ? null : parseRoomLinkOperation(p.operation)
    if (operation && operation.operationId !== (input as { operationId: string }).operationId) fail()
    return { operation } as RoomDiscoveryResultMap[M]
  }
  if (method === 'connection.room.link.create') {
    const operation = parseRoomLinkOperation(value)
    if (JSON.stringify(operation.input) !== JSON.stringify(parseRoomDiscoveryParams(method, input))) fail()
    return operation as RoomDiscoveryResultMap[M]
  }
  const targeted = method === 'connection.room.get', members = method === 'connection.room.members'
  const p = object(value, ['connectionId', 'connectionRevision', 'application', 'observation', ...(targeted ? ['room'] : members ? ['externalConversationId', 'members', 'next'] : ['rooms', 'next'])])
  const expected = input as { connectionId: string; expectedConnectionRevision: number; externalConversationId?: string }
  const base = { connectionId: id(p.connectionId), connectionRevision: integer(p.connectionRevision), application: p.application === null ? null : parseConnectionApplication(p.application), observation: parseRoomDiscoveryObservation(p.observation) }
  if (base.connectionId !== expected.connectionId || base.connectionRevision !== expected.expectedConnectionRevision || base.observation.state === 'ready' && !base.application) fail()
  if (targeted) {
    const room = p.room === null ? null : summary(p.room, true) as RoomDetails
    if (room && (room.externalConversationId !== expected.externalConversationId || base.observation.state !== 'ready')) fail()
    return { ...base, room } as RoomDiscoveryResultMap[M]
  }
  const next = p.next === null ? null : text(p.next, 16384)
  if (members && text(p.externalConversationId) !== expected.externalConversationId) fail()
  if (!Array.isArray(p[members ? 'members' : 'rooms'])) fail()
  const items = (p[members ? 'members' : 'rooms'] as unknown[]).map(v => {
    if (!members) return summary(v)
    const m = object(v, ['idType', 'userId', 'name']); return { idType: text(m.idType, 128), userId: text(m.userId), name: m.name === null ? null : text(m.name) } as RoomDiscoveredMember
  })
  if (base.observation.state !== 'ready' && (items.length || next !== null)) fail()
  const identities = items.map(v => members ? JSON.stringify([(v as RoomDiscoveredMember).idType, (v as RoomDiscoveredMember).userId]) : (v as RoomSummary).externalConversationId)
  if (new Set(identities).size !== identities.length) fail()
  return { ...base, ...(members ? { externalConversationId: expected.externalConversationId!, members: items, next } : { rooms: items, next }) } as RoomDiscoveryResultMap[M]
}
