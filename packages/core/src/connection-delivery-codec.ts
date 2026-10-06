import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { ConversationItemRef } from './conversation.js'
import type { ConnectionDelivery, ConnectionDeliveryMapping, ConnectionDeliveryMethod, ConnectionDeliveryParamsMap, ConnectionDeliveryReceipt, ConnectionDeliveryReceiptReason, ConnectionDeliveryReason, ConnectionDeliveryResultMap, ConnectionDeliveryState } from './connection-delivery-contract.js'

export const CONNECTION_DELIVERY_RPC_METHODS = { 'connection.delivery.inspect': 'long', 'connection.delivery.ls': 'long', 'connection.delivery.retry': 'long' } as const
export const isConnectionDeliveryMethod = (value: unknown): value is ConnectionDeliveryMethod => typeof value === 'string' && Object.hasOwn(CONNECTION_DELIVERY_RPC_METHODS, value)
export const CONNECTION_DELIVERY_RECEIPT_REASONS = ['effect-unconfirmed', 'platform-rejected', 'adapter-unavailable', 'platform-unavailable', 'rate-limited', 'thread-unavailable', 'unsupported-format'] as const
const fail = (): never => { throw new AgentMuxError('Delivery data does not describe the original operation and audience.', 'INVALID_CONNECTION_DELIVERY_DATA') }
const object = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'INVALID_CONNECTION_DELIVERY_DATA')
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) fail(); return value as string }
function integer(value: unknown, minimum: number): number { if (!Number.isSafeInteger(value) || Number(value) < minimum) fail(); return value as number }
function reason(value: unknown, queue = false): ConnectionDeliveryReason {
  if (!CONNECTION_DELIVERY_RECEIPT_REASONS.includes(value as ConnectionDeliveryReceiptReason) && !(queue && value === 'original-speech-withdrawn')) fail()
  return value as ConnectionDeliveryReason
}
function mapping(value: unknown): ConnectionDeliveryMapping {
  const p = object(value, ['messageId', 'threadId'])
  return { messageId: text(p.messageId), ...(p.threadId === undefined ? {} : { threadId: text(p.threadId) }) }
}
function reference(value: unknown): ConversationItemRef {
  const p = object(value, ['hostId', 'agentSessionId', 'source']), source = object(p.source, ['kind', 'providerId', 'nativeSessionId', 'recordId'])
  const ref = { hostId: text(p.hostId), agentSessionId: text(p.agentSessionId) }, recordId = text(source.recordId)
  if (source.kind === 'native') return { ...ref, source: { kind: 'native', providerId: text(source.providerId), nativeSessionId: text(source.nativeSessionId), recordId } }
  if (source.kind !== 'captured' || source.providerId !== undefined || source.nativeSessionId !== undefined) fail()
  return { ...ref, source: { kind: 'captured', recordId } }
}
export function parseConnectionDeliveryReceipt(value: unknown): ConnectionDeliveryReceipt {
  const p = object(value, ['state', 'mapping', 'reason'])
  if (p.state === 'confirmed') { if (p.reason !== undefined) fail(); return { state: 'confirmed', mapping: mapping(p.mapping) } }
  if (p.state !== 'unknown' && p.state !== 'not-applied' || p.mapping !== undefined) fail()
  return { state: p.state as 'unknown' | 'not-applied', reason: reason(p.reason) as ConnectionDeliveryReceiptReason }
}
export function parseConnectionDelivery(value: unknown): ConnectionDelivery {
  const p = object(value, ['operationId', 'projectionId', 'sourceRevision', 'bindingId', 'bindingRevision', 'reference', 'target', 'effect', 'fragment', 'state', 'predecessorOperationId', 'mapping', 'reason', 'receipt'])
  const target = object(p.target, ['connectionId', 'application', 'externalConversationId']), app = object(target.application, ['domain', 'appId']), fragment = object(p.fragment, ['ordinal', 'count'])
  const domain = text(app.domain), ordinal = integer(fragment.ordinal, 0), count = integer(fragment.count, 0)
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(domain) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text(app.appId))) fail()
  if (p.effect !== 'upsert' && p.effect !== 'withdraw' || p.effect === 'upsert' && ordinal >= count || !['pending', 'dispatching', 'unknown', 'confirmed', 'not-applied', 'cancelled', 'superseded'].includes(String(p.state))) fail()
  const mapped = p.mapping === undefined ? undefined : mapping(p.mapping), receipt = p.receipt === undefined ? undefined : parseConnectionDeliveryReceipt(p.receipt)
  const why = p.reason === undefined ? undefined : reason(p.reason, true)
  if (p.state === 'confirmed' && (!mapped || why !== undefined) || (p.state === 'unknown' || p.state === 'not-applied') && (why === undefined || why === 'original-speech-withdrawn')) fail()
  if (p.effect === 'withdraw' && ['dispatching', 'unknown', 'confirmed', 'not-applied'].includes(String(p.state)) && !mapped) fail()
  if (receipt?.state === 'confirmed' && (!mapped || receipt.mapping.messageId !== mapped.messageId || receipt.mapping.threadId !== mapped.threadId)) fail()
  if (receipt && ['confirmed', 'unknown', 'not-applied'].includes(String(p.state)) && (receipt.state !== p.state || receipt.state !== 'confirmed' && receipt.reason !== why)) fail()
  const operationId = text(p.operationId), predecessorOperationId = p.predecessorOperationId === undefined ? undefined : text(p.predecessorOperationId)
  if (predecessorOperationId === operationId) fail()
  return { operationId, projectionId: text(p.projectionId), sourceRevision: text(p.sourceRevision), bindingId: text(p.bindingId), bindingRevision: integer(p.bindingRevision, 1), reference: reference(p.reference),
    target: { connectionId: text(target.connectionId), application: { domain, appId: text(app.appId) }, externalConversationId: text(target.externalConversationId) }, effect: p.effect as ConnectionDelivery['effect'], fragment: { ordinal, count }, state: p.state as ConnectionDeliveryState,
    ...(predecessorOperationId === undefined ? {} : { predecessorOperationId }), ...(mapped === undefined ? {} : { mapping: mapped }), ...(why === undefined ? {} : { reason: why }), ...(receipt === undefined ? {} : { receipt }) }
}
export function parseConnectionDeliveryParams<M extends ConnectionDeliveryMethod>(method: M, value: unknown): ConnectionDeliveryParamsMap[M] {
  if (method !== 'connection.delivery.ls') { const p = object(value, ['operationId']); return { operationId: text(p.operationId) } as ConnectionDeliveryParamsMap[M] }
  const p = object(value, ['connectionId', 'bindingId', 'bindingRevision', 'after', 'limit'])
  const limit = p.limit === undefined ? undefined : integer(p.limit, 1); if (limit !== undefined && limit > 100) fail()
  return { connectionId: text(p.connectionId), bindingId: text(p.bindingId), bindingRevision: integer(p.bindingRevision, 1), ...(p.after === undefined ? {} : { after: text(p.after) }), ...(limit === undefined ? {} : { limit }) } as ConnectionDeliveryParamsMap[M]
}
export function parseConnectionDeliveryResult<M extends ConnectionDeliveryMethod>(method: M, value: unknown, input: ConnectionDeliveryParamsMap[M]): ConnectionDeliveryResultMap[M] {
  if (method === 'connection.delivery.ls') {
    const p = object(value, ['deliveries', 'next']), expected = input as ConnectionDeliveryParamsMap['connection.delivery.ls']
    if (!Array.isArray(p.deliveries) || p.deliveries.length > (expected.limit ?? 30)) fail()
    const deliveries = (p.deliveries as unknown[]).map(parseConnectionDelivery), next = p.next === null ? null : text(p.next)
    if (new Set(deliveries.map(d => d.operationId)).size !== deliveries.length || deliveries.some(d => d.target.connectionId !== expected.connectionId || d.bindingId !== expected.bindingId || d.bindingRevision !== expected.bindingRevision || d.operationId === expected.after) || next !== null && next !== deliveries.at(-1)?.operationId) fail()
    return { deliveries, next } as ConnectionDeliveryResultMap[M]
  }
  const p = object(value, ['delivery']), expected = input as ConnectionDeliveryParamsMap['connection.delivery.inspect']
  const delivery = p.delivery === null && method === 'connection.delivery.inspect' ? null : parseConnectionDelivery(p.delivery)
  if (delivery && delivery.operationId !== expected.operationId) fail()
  return { delivery } as ConnectionDeliveryResultMap[M]
}
