import { AgentMuxError } from '../errors.js'
import { rpcRecord } from '../rpc-data.js'
import { parseMoteConnectionValues, parseMotePreferencesTarget, sameMotePreferencesTarget } from './preferences.js'
import { parseConnectionDelivery } from '../connection-delivery-codec.js'
import { parseConnectionActor, parseRoomBinding } from '../room-binding-codec.js'
import { parseMoteChatDiagnosis } from './chat-diagnosis.js'
import type { MoteChatConfiguration, MoteChatEvent, MoteChatGeneration, MoteChatMethod, MoteChatOperation, MoteChatParamsMap, MoteChatPerson, MoteChatResultMap, MoteChatReviewMark, MoteChatValues } from './chat-contract.js'

export const MOTE_CHAT_RPC_METHODS = {
  'space.mote.chat.configure': 'long', 'space.mote.chat.inspect': 'short', 'space.mote.chat.history': 'short',
  'space.mote.chat.audience': 'short', 'space.mote.chat.allocate': 'short', 'space.mote.chat.diagnose': 'short',
  'space.mote.chat.reply': 'long', 'space.mote.chat.events': 'short', 'space.mote.chat.review': 'short'
} as const
/** Unreviewed events are counted only this far, so the count costs the same however large the backlog is. */
export const MOTE_CHAT_UNREVIEWED_BOUND = 99
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
  const a = fields(v, ['domain', 'appId', 'issuer'], ['domain', 'appId'], code)
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
function replyDeliveryMatches(o: Extract<MoteChatOperation, { action: 'reply' }>, delivery: import('../connection-delivery-contract.js').ConnectionDelivery): boolean {
  const binding = o.binding, source = delivery.reference.source
  return o.deliveryOperationIds[delivery.fragment.ordinal] === delivery.operationId && delivery.fragment.count === o.deliveryOperationIds.length && delivery.bindingId === binding.bindingId && delivery.bindingRevision === binding.revision &&
    source.kind === 'mote-chat-reply' && source.operationId === o.operationId && source.ingressId === o.ingressId &&
    delivery.reference.hostId === binding.executionHostId && delivery.reference.agentSessionId === binding.agentSessionId &&
    delivery.target.connectionId === binding.connectionId && delivery.target.externalConversationId === binding.externalConversationId && JSON.stringify(delivery.target.application) === JSON.stringify(binding.application)
}
const nullable = <T>(v: unknown, read: (value: unknown) => T): T | null => v === null ? null : read(v)
function list(v: unknown, code: Code): unknown[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).length !== v.length + 1) fail(code)
  return Array.from({ length: (v as unknown[]).length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(v, String(index))
    if (!entry?.enumerable || !('value' in entry)) fail(code)
    return entry!.value
  })
}
const page = (v: unknown, code: Code) => v === null || typeof v === 'string' && !!v.trim() ? v as string | null : fail(code)
function reviewMark(v: unknown, code: Code): MoteChatReviewMark {
  const p = fields(v, ['through', 'revision', 'reviewedAt', 'actor'], ['through', 'revision', 'reviewedAt', 'actor'], code)
  const a = fields(p.actor, ['kind', 'id'], ['kind', 'id'], code)
  if (a.kind !== 'user' && a.kind !== 'device' && a.kind !== 'agent') fail(code)
  return { through: count(p.through, code, 1), revision: count(p.revision, code, 1), reviewedAt: count(p.reviewedAt, code), actor: { kind: a.kind as MoteChatReviewMark['actor']['kind'], id: text(a.id, code) } }
}
export function parseMoteChatEvent(v: unknown, code: Code = 'CONTROL_PROTOCOL_ERROR'): MoteChatEvent {
  const keys = ['sequence', 'ingressId', 'receivedAt', 'application', 'conversationKind', 'externalConversationId', 'conversationName', 'author', 'authorName',
    'externalMessageId', 'addressing', 'replyToMessageId', 'externalText', 'state', 'code', 'noticeCode', 'handledBy']
  const p = fields(v, keys, keys.filter(key => key !== 'conversationName' && key !== 'authorName' && key !== 'noticeCode'), code), author = actor(p.author, code), app = application(p.application, code)
  if (JSON.stringify(author.application) !== JSON.stringify(app) || p.conversationKind !== 'direct' && p.conversationKind !== 'group' ||
    !['mention', 'reply', 'message'].includes(p.addressing as string) || !['received', 'refused', 'claimed'].includes(p.state as string) ||
    p.externalText !== null && typeof p.externalText !== 'string') fail(code)
  if (p.noticeCode !== undefined && !['MOTE_CHAT_MAIN_EXTERNAL_AUDIENCE', 'MOTE_CHAT_MAIN_UNCONFIRMED', 'MOTE_CHAT_REPLY_ROUTE_UNCONFIRMED'].includes(p.noticeCode as string)) fail(code)
  const handledBy = nullable(p.handledBy, value => {
    const h = fields(value, ['executionHostId', 'agentSessionId'], ['executionHostId', 'agentSessionId'], code)
    return { executionHostId: text(h.executionHostId, code), agentSessionId: text(h.agentSessionId, code) }
  })
  return { sequence: count(p.sequence, code, 1), ingressId: text(p.ingressId, code), receivedAt: nullable(p.receivedAt, value => count(value, code)), application: app,
    conversationKind: p.conversationKind as MoteChatEvent['conversationKind'], externalConversationId: text(p.externalConversationId, code),
    ...(p.conversationName === undefined ? {} : { conversationName: text(p.conversationName, code) }), author,
    ...(p.authorName === undefined ? {} : { authorName: text(p.authorName, code) }), externalMessageId: text(p.externalMessageId, code),
    addressing: p.addressing as MoteChatEvent['addressing'], replyToMessageId: nullable(p.replyToMessageId, value => text(value, code)), externalText: p.externalText as string | null,
    state: p.state as MoteChatEvent['state'], code: nullable(p.code, value => text(value, code)), ...(p.noticeCode === undefined ? {} : { noticeCode: p.noticeCode as NonNullable<MoteChatEvent['noticeCode']> }), handledBy }
}
function operation(v: unknown, code: Code): MoteChatOperation {
  const p = fields(v, ['operationId', 'action', 'configuration', 'person', 'ingressId', 'deliveryOperationIds', 'binding', 'target'], ['operationId', 'action'], code)
  const operationId = text(p.operationId, code)
  if (p.action === 'reply') {
    if (p.person !== undefined || p.configuration !== undefined) return fail(code)
    const ids = list(p.deliveryOperationIds, code).map(value => text(value, code)), binding = parseRoomBinding(p.binding)
    if (!ids.length || new Set(ids).size !== ids.length || !binding.inputOnly) return fail(code)
    return { operationId, action: 'reply', target: target(p.target, code), ingressId: text(p.ingressId, code), deliveryOperationIds: ids, binding }
  }
  if (p.ingressId !== undefined || p.deliveryOperationIds !== undefined || p.binding !== undefined || p.target !== undefined) return fail(code)
  const base = { operationId, configuration: parseMoteChatConfiguration(p.configuration, code) }
  if (p.action === 'configure') { if (Object.hasOwn(p, 'person')) fail(code); return { ...base, action: 'configure' } }
  if (p.action !== 'allocate') return fail(code)
  return { ...base, action: 'allocate', person: parseMoteChatPerson(p.person, code) }
}
export function parseMoteChatParams<M extends MoteChatMethod>(method: M, value: unknown): MoteChatParamsMap[M] {
  const code: Code = 'INVALID_CONTROL_REQUEST'
  if (!isMoteChatMethod(method)) fail(code)
  if (method === 'space.mote.chat.reply') {
    const p = fields(value, ['operationId', 'ingressId', 'body'], ['operationId', 'ingressId', 'body'], code)
    if (typeof p.body !== 'string' || !p.body.trim()) fail(code)
    return { operationId: text(p.operationId, code), ingressId: text(p.ingressId, code), body: p.body } as MoteChatParamsMap[M]
  }
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
  if (method === 'space.mote.chat.review') {
    const p = fields(value, ['target', 'through'], ['target', 'through'], code)
    return { target: target(p.target, code), through: count(p.through, code, 1) } as MoteChatParamsMap[M]
  }
  const events = method === 'space.mote.chat.events'
  const p = fields(value, ['target', ...(method === 'space.mote.chat.history' ? ['actor'] : []), ...(events ? ['order'] : []), 'cursor', 'limit'], ['target'], code)
  const limit = p.limit === undefined ? 20 : count(p.limit, code, 1)
  if (limit > 100) fail(code) // One RPC page, not a limit on durable history or audience size.
  if (events && p.order !== undefined && p.order !== 'unreviewed' && p.order !== 'recent') fail(code)
  return { target: target(p.target, code), ...(events ? { order: p.order ?? 'unreviewed' } : {}), limit, ...(p.cursor === undefined ? {} : { cursor: text(p.cursor, code) }), ...(p.actor === undefined ? {} : { actor: actor(p.actor, code) }) } as MoteChatParamsMap[M]
}
export function parseMoteChatResult<M extends MoteChatMethod>(method: M, value: unknown, input?: MoteChatParamsMap[M]): MoteChatResultMap[M] {
  const code: Code = 'CONTROL_PROTOCOL_ERROR'
  if (!isMoteChatMethod(method)) fail(code)
  if (method === 'space.mote.chat.diagnose') return parseMoteChatDiagnosis(value, input as MoteChatParamsMap['space.mote.chat.diagnose'] | undefined) as MoteChatResultMap[M]
  if (method === 'space.mote.chat.reply') {
    const p = fields(value, ['operation', 'deliveries'], ['operation', 'deliveries'], code), o = operation(p.operation, code)
    if (o.action !== 'reply') return fail(code)
    const deliveries = list(p.deliveries, code).map(parseConnectionDelivery), i = input as MoteChatParamsMap['space.mote.chat.reply'] | undefined
    if (i && (o.operationId !== i.operationId || o.ingressId !== i.ingressId) || deliveries.some(delivery => !replyDeliveryMatches(o, delivery)) || new Set(deliveries.map(d => d.operationId)).size !== deliveries.length) fail(code)
    return { operation: o, deliveries } as MoteChatResultMap[M]
  }
  if (method === 'space.mote.chat.configure' || method === 'space.mote.chat.allocate') {
    const o = operation(value, code), i = input as MoteChatParamsMap['space.mote.chat.configure'] | MoteChatParamsMap['space.mote.chat.allocate'] | undefined
    if (o.action === 'reply') return fail(code)
    if (o.action !== (method === 'space.mote.chat.configure' ? 'configure' : 'allocate') || i && (o.operationId !== i.operationId || !sameMotePreferencesTarget(o.configuration.target, i.target))) fail(code)
    if (i && 'values' in i && JSON.stringify(o.configuration.values) !== JSON.stringify(i.values)) fail(code)
    if (i && 'total' in i && (o.action !== 'allocate' || JSON.stringify(o.person.actor) !== JSON.stringify(i.actor) || o.person.total !== i.total)) fail(code)
    return o as MoteChatResultMap[M]
  }
  if (method === 'space.mote.chat.inspect') {
    const p = fields(value, ['configuration', 'operation', 'deliveries'], ['configuration', 'operation'], code), i = input as MoteChatParamsMap['space.mote.chat.inspect'] | undefined
    const configuration = p.configuration === null ? null : parseMoteChatConfiguration(p.configuration, code), o = p.operation === null ? null : operation(p.operation, code)
    if (i?.target && configuration && !sameMotePreferencesTarget(configuration.target, i.target) || i?.operationId && o && o.operationId !== i.operationId) fail(code)
    const deliveries = p.deliveries === undefined ? undefined : list(p.deliveries, code).map(parseConnectionDelivery)
    if (deliveries && (o?.action !== 'reply' || deliveries.some(delivery => !replyDeliveryMatches(o, delivery)) || new Set(deliveries.map(d => d.operationId)).size !== deliveries.length)) fail(code)
    return { configuration, operation: o, ...(deliveries ? { deliveries } : {}) } as MoteChatResultMap[M]
  }
  if (method === 'space.mote.chat.review') {
    const p = fields(value, ['reviewed'], ['reviewed'], code), reviewed = reviewMark(p.reviewed, code), i = input as MoteChatParamsMap['space.mote.chat.review'] | undefined
    if (i && reviewed.through < i.through) fail(code)
    return { reviewed } as MoteChatResultMap[M]
  }
  if (method === 'space.mote.chat.events') {
    const keys = ['application', 'events', 'next', 'reviewed', 'unreviewed'], p = fields(value, keys, keys, code), i = input as MoteChatParamsMap['space.mote.chat.events'] | undefined
    const app = nullable(p.application, value => application(value, code))
    const rows = list(p.events, code).map(row => parseMoteChatEvent(row, code)), reviewed = nullable(p.reviewed, value => reviewMark(value, code))
    const u = fields(p.unreviewed, ['count', 'more'], ['count', 'more'], code), unreviewed = { count: count(u.count, code), more: u.more }
    if (typeof unreviewed.more !== 'boolean' || unreviewed.count > MOTE_CHAT_UNREVIEWED_BOUND || unreviewed.more && unreviewed.count !== MOTE_CHAT_UNREVIEWED_BOUND) fail(code)
    const ascending = (i?.order ?? 'unreviewed') === 'unreviewed'
    if (rows.some((row, index) => index > 0 && (ascending ? row.sequence <= rows[index - 1]!.sequence : row.sequence >= rows[index - 1]!.sequence)) ||
      rows.some(row => !app || JSON.stringify(row.application) !== JSON.stringify(app)) || !app && (p.next !== null || unreviewed.count > 0) ||
      i && rows.length > (i.limit ?? 20) || i?.order === 'unreviewed' && !i.cursor && reviewed && rows.some(row => row.sequence <= reviewed.through)) fail(code)
    return { application: app, events: rows, next: page(p.next, code), reviewed, unreviewed } as MoteChatResultMap[M]
  }
  const history = method === 'space.mote.chat.history', name = history ? 'generations' : 'people', p = fields(value, [name, 'next'], [name, 'next'], code)
  page(p.next, code)
  const rows = list(p[name], code).map(row => history ? parseMoteChatGeneration(row, code) : parseMoteChatPerson(row, code))
  if (new Set(rows.map(row => history ? (row as MoteChatGeneration).generationId : JSON.stringify(row.actor))).size !== rows.length) fail(code)
  const i = input as MoteChatParamsMap['space.mote.chat.history'] | undefined
  if (i && rows.length > (i.limit ?? 20)) fail(code)
  if (history && i && rows.some(row => !sameMotePreferencesTarget((row as MoteChatGeneration).target, i.target) || i.actor && JSON.stringify(row.actor) !== JSON.stringify(i.actor))) fail(code)
  return { [name]: rows, next: p.next } as MoteChatResultMap[M]
}
