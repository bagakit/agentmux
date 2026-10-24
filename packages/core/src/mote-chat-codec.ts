import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseMoteConnectionValues, parseMotePreferencesTarget, sameMotePreferencesTarget } from './mote-preferences.js'
import { parseConnectionActor } from './room-binding-codec.js'
import { parseMoteChatDiagnosis } from './mote-chat-diagnosis.js'
import type { MoteChatConfiguration, MoteChatGeneration, MoteChatMethod, MoteChatOperation, MoteChatParamsMap, MoteChatPerson, MoteChatResultMap, MoteChatValues } from './mote-chat-contract.js'

export const MOTE_CHAT_RPC_METHODS = {
  'space.mote.chat.configure': 'long', 'space.mote.chat.inspect': 'short', 'space.mote.chat.history': 'short',
  'space.mote.chat.audience': 'short', 'space.mote.chat.allocate': 'short', 'space.mote.chat.diagnose': 'short'
} as const
export function isMoteChatMethod(value: unknown): value is MoteChatMethod {
  return typeof value === 'string' && Object.hasOwn(MOTE_CHAT_RPC_METHODS, value)
}
type Code = 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR'
const fail = (code: Code): never => { throw new AgentMuxError('Mote chat requires exact original identities, revisions and JSON facts.', code) }
const fields = (v: unknown, allowed: string[], required: string[], code: Code) => {
  const p = rpcRecord(v, allowed, code)
  if (required.some(k => !Object.hasOwn(p, k))) fail(code)
  return p
}
const text = (v: unknown, code: Code): string => {
  if (typeof v !== 'string' || !v.trim() || /[\u0000-\u001f\u007f]/u.test(v)) fail(code)
  return v as string
}
const count = (v: unknown, code: Code, min = 0): number => {
  if (!Number.isSafeInteger(v) || Number(v) < min) fail(code)
  return v as number
}
const revision = (v: unknown, code: Code) => v === null ? null : count(v, code, 1)
const actor = (v: unknown, code: Code) => { try { return parseConnectionActor(v) } catch { return fail(code) } }
const target = (v: unknown, code: Code) => parseMotePreferencesTarget(v, code)
function application(v: unknown, code: Code) {
  const a = fields(v, ['domain', 'appId'], ['domain', 'appId'], code)
  const ref = parseMoteConnectionValues({ connection: { connectionId: 'application', application: a } }, code).connection!
  return ref.application
}
export function parseMoteChatValues(v: unknown, code: Code = 'INVALID_CONTROL_REQUEST'): MoteChatValues {
  const p = fields(v, ['enabled', 'connection', 'conversationIdleMs', 'strangerMessageLimit'], ['enabled', 'connection', 'conversationIdleMs', 'strangerMessageLimit'], code)
  if (typeof p.enabled !== 'boolean') fail(code)
  const connection = parseMoteConnectionValues({ connection: p.connection }, code).connection
  if (p.enabled && !connection) fail(code)
  return { enabled: p.enabled as boolean, connection, conversationIdleMs: count(p.conversationIdleMs, code, 1), strangerMessageLimit: count(p.strangerMessageLimit, code) }
}
export function parseMoteChatConfiguration(v: unknown, code: Code = 'CONTROL_PROTOCOL_ERROR'): MoteChatConfiguration {
  const p = fields(v, ['target', 'revision', 'values', 'creator'], ['target', 'revision', 'values', 'creator'], code)
  const values = parseMoteChatValues(p.values, code), creator = p.creator === null ? null : actor(p.creator, code)
  if (creator && (!values.connection || JSON.stringify(creator.application) !== JSON.stringify(values.connection.application)) || values.enabled && !creator) fail(code)
  return { target: target(p.target, code), revision: count(p.revision, code, 1), values, creator }
}
export function parseMoteChatPerson(v: unknown, code: Code = 'CONTROL_PROTOCOL_ERROR'): MoteChatPerson {
  const p = fields(v, ['actor', 'creator', 'revision', 'total', 'used', 'remaining', 'name'], ['actor', 'creator', 'revision', 'total', 'used', 'remaining'], code)
  if (typeof p.creator !== 'boolean') fail(code)
  const total = p.total === null ? null : count(p.total, code), used = count(p.used, code), remaining = p.remaining === null ? null : count(p.remaining, code)
  if (p.creator ? total !== null || remaining !== null : total === null || remaining !== Math.max(0, total - used)) fail(code)
  return { actor: actor(p.actor, code), creator: p.creator as boolean, revision: count(p.revision, code, 1), total, used, remaining,
    ...(p.name === undefined ? {} : { name: text(p.name, code) }) }
}
export function parseMoteChatGeneration(v: unknown, code: Code = 'CONTROL_PROTOCOL_ERROR'): MoteChatGeneration {
  const keys = ['generationId', 'target', 'application', 'externalConversationId', 'actor', 'executionHostId', 'agentSessionId', 'createOperationId', 'phase', 'createdAt', 'lastActivityAt']
  const p = fields(v, keys, keys, code), original = actor(p.actor, code), app = application(p.application, code)
  if (p.phase !== 'preparing' && p.phase !== 'ready' || JSON.stringify(original.application) !== JSON.stringify(app)) fail(code)
  return { generationId: text(p.generationId, code), target: target(p.target, code), application: app, externalConversationId: text(p.externalConversationId, code), actor: original,
    executionHostId: text(p.executionHostId, code), agentSessionId: text(p.agentSessionId, code), createOperationId: text(p.createOperationId, code), phase: p.phase as 'preparing' | 'ready',
    createdAt: count(p.createdAt, code), lastActivityAt: count(p.lastActivityAt, code) }
}
function operation(v: unknown, code: Code): MoteChatOperation {
  const p = fields(v, ['operationId', 'action', 'configuration', 'person'], ['operationId', 'action', 'configuration'], code)
  const base = { operationId: text(p.operationId, code), configuration: parseMoteChatConfiguration(p.configuration, code) }
  if (p.action === 'configure') { if (Object.hasOwn(p, 'person')) fail(code); return { ...base, action: 'configure' } }
  if (p.action !== 'allocate') fail(code)
  return { ...base, action: 'allocate', person: parseMoteChatPerson(p.person, code) }
}
export function parseMoteChatParams<M extends MoteChatMethod>(method: M, value: unknown): MoteChatParamsMap[M] {
  const code: Code = 'INVALID_CONTROL_REQUEST'
  if (!isMoteChatMethod(method)) fail(code)
  if (method === 'space.mote.chat.diagnose') {
    const p = fields(value, ['target'], ['target'], code)
    return { target: target(p.target, code) } as MoteChatParamsMap[M]
  }
  if (method === 'space.mote.chat.configure') {
    const p = fields(value, ['operationId', 'target', 'expectedRevision', 'expectedConnectionRevision', 'values'], ['operationId', 'target', 'expectedRevision', 'expectedConnectionRevision', 'values'], code)
    const values = parseMoteChatValues(p.values, code), connectionRevision = revision(p.expectedConnectionRevision, code)
    if (!!values.connection !== (connectionRevision !== null)) fail(code)
    return { operationId: text(p.operationId, code), target: target(p.target, code), expectedRevision: revision(p.expectedRevision, code), expectedConnectionRevision: connectionRevision, values } as MoteChatParamsMap[M]
  }
  if (method === 'space.mote.chat.inspect') {
    const p = fields(value, ['target', 'operationId'], [], code)
    if (Object.hasOwn(p, 'target') === Object.hasOwn(p, 'operationId')) fail(code)
    return (p.target === undefined ? { operationId: text(p.operationId, code) } : { target: target(p.target, code) }) as MoteChatParamsMap[M]
  }
  if (method === 'space.mote.chat.allocate') {
    const keys = ['operationId', 'target', 'expectedConfigurationRevision', 'actor', 'expectedPersonRevision', 'total'], p = fields(value, keys, keys, code)
    return { operationId: text(p.operationId, code), target: target(p.target, code), expectedConfigurationRevision: count(p.expectedConfigurationRevision, code, 1),
      actor: actor(p.actor, code), expectedPersonRevision: count(p.expectedPersonRevision, code, 1), total: count(p.total, code) } as MoteChatParamsMap[M]
  }
  const p = fields(value, ['target', ...(method === 'space.mote.chat.history' ? ['actor'] : []), 'cursor', 'limit'], ['target'], code)
  const limit = p.limit === undefined ? 20 : count(p.limit, code, 1)
  if (limit > 100) fail(code) // One RPC page, not a limit on durable history or audience size.
  return { target: target(p.target, code), limit, ...(p.cursor === undefined ? {} : { cursor: text(p.cursor, code) }), ...(p.actor === undefined ? {} : { actor: actor(p.actor, code) }) } as MoteChatParamsMap[M]
}
export function parseMoteChatResult<M extends MoteChatMethod>(method: M, value: unknown, input?: MoteChatParamsMap[M]): MoteChatResultMap[M] {
  const code: Code = 'CONTROL_PROTOCOL_ERROR'
  if (!isMoteChatMethod(method)) fail(code)
  if (method === 'space.mote.chat.diagnose') return parseMoteChatDiagnosis(value, input as MoteChatParamsMap['space.mote.chat.diagnose'] | undefined) as MoteChatResultMap[M]
  if (method === 'space.mote.chat.configure' || method === 'space.mote.chat.allocate') {
    const o = operation(value, code), i = input as MoteChatParamsMap['space.mote.chat.configure'] | MoteChatParamsMap['space.mote.chat.allocate'] | undefined
    if (o.action !== (method === 'space.mote.chat.configure' ? 'configure' : 'allocate') || i && (o.operationId !== i.operationId || !sameMotePreferencesTarget(o.configuration.target, i.target))) fail(code)
    if (i && 'values' in i && JSON.stringify(o.configuration.values) !== JSON.stringify(i.values)) fail(code)
    if (i && 'total' in i && (o.action !== 'allocate' || JSON.stringify(o.person.actor) !== JSON.stringify(i.actor) || o.person.total !== i.total)) fail(code)
    return o as MoteChatResultMap[M]
  }
  if (method === 'space.mote.chat.inspect') {
    const p = fields(value, ['configuration', 'operation'], ['configuration', 'operation'], code), i = input as MoteChatParamsMap['space.mote.chat.inspect'] | undefined
    const configuration = p.configuration === null ? null : parseMoteChatConfiguration(p.configuration, code), o = p.operation === null ? null : operation(p.operation, code)
    if (i?.target && configuration && !sameMotePreferencesTarget(configuration.target, i.target) || i?.operationId && o && o.operationId !== i.operationId) fail(code)
    return { configuration, operation: o } as MoteChatResultMap[M]
  }
  const history = method === 'space.mote.chat.history', name = history ? 'generations' : 'people', p = fields(value, [name, 'next'], [name, 'next'], code)
  const values = p[name]
  if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype || Reflect.ownKeys(values).length !== values.length + 1 || !(p.next === null || typeof p.next === 'string' && p.next.trim())) fail(code)
  const rows = Array.from({ length: (values as unknown[]).length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(values, String(index))
    if (!entry?.enumerable || !('value' in entry)) fail(code)
    return history ? parseMoteChatGeneration(entry!.value, code) : parseMoteChatPerson(entry!.value, code)
  })
  if (new Set(rows.map(row => history ? (row as MoteChatGeneration).generationId : JSON.stringify(row.actor))).size !== rows.length) fail(code)
  const i = input as MoteChatParamsMap['space.mote.chat.history'] | undefined
  if (i && rows.length > (i.limit ?? 20)) fail(code)
  if (history && i && rows.some(row => !sameMotePreferencesTarget((row as MoteChatGeneration).target, i.target) || i.actor && JSON.stringify(row.actor) !== JSON.stringify(i.actor))) fail(code)
  return { [name]: rows, next: p.next } as MoteChatResultMap[M]
}
