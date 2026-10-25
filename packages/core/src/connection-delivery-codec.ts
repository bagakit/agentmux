import { connectionDiagnosisSourceCodes, type ConnectionDeliverySourceObservation } from './connection-diagnosis-source.js'
import { parseExternalConversationAuthor } from './external-conversation.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConversationVersionedAnchor, parseConversationSource } from './conversation-changes.js'
import type { ConversationItemRef } from './conversation.js'
import { conversationRecordId } from './conversation-stream.js'
import { parseAgentExternalMessageAuthor } from './external-author.js'
import type { ConnectionDelivery, ConnectionDeliveryCoverage, ConnectionDeliveryEvent, ConnectionDeliveryGap, ConnectionOriginRepresentation, ConnectionDeliveryMapping, ConnectionDeliveryMethod, ConnectionDeliveryObservation, ConnectionDeliveryParamsMap, ConnectionDeliveryReceipt, ConnectionDeliveryReceiptReason, ConnectionDeliveryReason, ConnectionDeliveryResultMap, ConnectionDeliveryState } from './connection-delivery-contract.js'

export const CONNECTION_DELIVERY_RPC_METHODS = { 'connection.delivery.inspect': 'long', 'connection.delivery.ls': 'long', 'connection.delivery.retry': 'long' } as const
export const isConnectionDeliveryMethod = (value: unknown): value is ConnectionDeliveryMethod => typeof value === 'string' && Object.hasOwn(CONNECTION_DELIVERY_RPC_METHODS, value)
export const CONNECTION_DELIVERY_RECEIPT_REASONS = ['effect-unconfirmed', 'platform-rejected', 'adapter-unavailable', 'platform-unavailable', 'rate-limited', 'thread-unavailable', 'unsupported-format'] as const
export const CONNECTION_DELIVERY_STATES = ['pending', 'dispatching', 'unknown', 'confirmed', 'not-applied', 'cancelled', 'superseded'] as const
export const CONNECTION_DELIVERY_GAP_REASONS = ['public-content-unconfirmed', 'transport-unsupported', 'resource-unavailable', 'start-cut-unconfirmed', 'source-gap', 'version-unavailable'] as const
const fail = (): never => { throw new AgentMuxError('Delivery data does not describe the original operation and audience.', 'INVALID_CONNECTION_DELIVERY_DATA') }
const object = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'INVALID_CONNECTION_DELIVERY_DATA')
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) fail(); return value as string }
function integer(value: unknown, minimum: number): number { if (!Number.isSafeInteger(value) || Number(value) < minimum) fail(); return value as number }
function reason(value: unknown, queue = false): ConnectionDeliveryReason {
  if (!CONNECTION_DELIVERY_RECEIPT_REASONS.includes(value as ConnectionDeliveryReceiptReason) && !(queue && ['binding-revised', 'original-speech-withdrawn', 'outside-conversation-scope', 'private-content', 'public-content-unconfirmed', 'version-unavailable'].includes(String(value)))) fail()
  return value as ConnectionDeliveryReason
}
function mapping(value: unknown): ConnectionDeliveryMapping {
  const p = object(value, ['messageId', 'threadId', 'reactionId', 'nativeCard'])
  const card = p.nativeCard === undefined ? undefined : object(p.nativeCard, ['id', 'operationId'])
  if (card && p.reactionId !== undefined) fail()
  return { messageId: text(p.messageId), ...(p.threadId === undefined ? {} : { threadId: text(p.threadId) }), ...(p.reactionId === undefined ? {} : { reactionId: text(p.reactionId) }), ...(card ? { nativeCard: { id: text(card.id), operationId: text(card.operationId) } } : {}) }
}
function reference(value: unknown): import('./connection-delivery-contract.js').ConnectionDeliveryReference {
  const p = object(value, ['hostId', 'agentSessionId', 'source']), source = object(p.source, ['kind', 'providerId', 'nativeSessionId', 'recordId', 'runId', 'requestId', 'requestDigest', 'operationId', 'event', 'ingressId'])
  const ref = { hostId: text(p.hostId), agentSessionId: text(p.agentSessionId) }
  if (source.kind === 'ingress') {
    object(source, ['kind', 'ingressId'])
    return { ...ref, source: { kind: 'ingress', ingressId: text(source.ingressId) } }
  }
  if (source.ingressId !== undefined) fail()
  if (source.kind === 'binding-operation') {
    object(source, ['kind', 'operationId', 'event', 'ingressId'])
    if (!['connected', 'disconnected', 'paused', 'resumed', 'updated'].includes(String(source.event))) fail()
    return { ...ref, source: { kind: 'binding-operation', operationId: text(source.operationId), event: source.event as import('./room-binding-contract.js').RoomBindingNoticeEvent } }
  }
  if (source.operationId !== undefined || source.event !== undefined) fail()
  if (source.kind === 'interaction') { if (source.providerId !== undefined || source.nativeSessionId !== undefined || source.recordId !== undefined || !/^[a-f0-9]{64}$/u.test(text(source.requestDigest))) fail(); return { ...ref, source: { kind: 'interaction', runId: text(source.runId), requestId: text(source.requestId), requestDigest: text(source.requestDigest) } } }
  if (source.runId !== undefined || source.requestId !== undefined || source.requestDigest !== undefined) fail()
  const recordId = text(source.recordId)
  if (source.kind === 'native') return { ...ref, source: { kind: 'native', providerId: text(source.providerId), nativeSessionId: text(source.nativeSessionId), recordId } }
  if (source.kind !== 'captured' || source.providerId !== undefined || source.nativeSessionId !== undefined) fail()
  return { ...ref, source: { kind: 'captured', recordId } }
}
function version(value: unknown): string { const v = text(value); if (!/^[a-f0-9]{64}$/u.test(v)) fail(); return v }
function event(value: unknown): ConnectionDeliveryEvent {
  const p = object(value, ['id', 'revision'])
  if (typeof p.id !== 'string' || !p.id || p.id.length > 131_072) fail()
  return { id: p.id as string, revision: version(p.revision) }
}
function part(value: unknown): import('./conversation-stream.js').ConversationContentRef {
  const p = object(value, ['record', 'recordRevision', 'selector']), record = reference(p.record), s = object(p.selector, ['kind', 'field', 'partIndex'])
  if (record.source.kind !== 'native' && record.source.kind !== 'captured') fail()
  let selector: import('./conversation-stream.js').ConversationSelector
  if (s.kind === 'native-part' && s.field === undefined && record.source.kind === 'native') selector = { kind: 'native-part', partIndex: integer(s.partIndex, 0) }
  else if (s.kind === 'captured-field' && s.partIndex === undefined && record.source.kind === 'captured' && ['content', 'toolInput', 'toolOutput'].includes(String(s.field))) selector = { kind: 'captured-field', field: s.field as 'content' | 'toolInput' | 'toolOutput' }
  else return fail()
  return { record: record as ConversationItemRef, recordRevision: version(p.recordRevision), selector }
}
function relay(value: unknown, target: ConnectionDelivery['reference']): NonNullable<ConnectionDelivery['relay']> {
  const p = object(value, ['sender', 'sources'])
  if (target.source.kind !== 'native' && target.source.kind !== 'captured' || p.sender !== 'application' || !Array.isArray(p.sources) || !p.sources.length || p.sources.length > 1_000) fail()
  const sources = (p.sources as unknown[]).map(value => {
    const source = object(value, ['part', 'author']), original = part(source.part)
    if (original.record.hostId !== target.hostId || original.record.agentSessionId !== target.agentSessionId || original.record.source.kind !== 'captured' || original.selector.kind !== 'captured-field' || original.selector.field !== 'content') fail()
    const a = object(source.author, ['kind', 'agentSessionId', 'connectionId', 'actor', 'externalConversationId', 'externalMessageId', 'bindingId', 'bindingRevision', 'grantId', 'grantRevision', 'grantSource', 'authoritySource'])
    let author: NonNullable<ConnectionDelivery['relay']>['sources'][number]['author']
    if (a.kind === 'external') { try { author = 'grantId' in a ? parseAgentExternalMessageAuthor(a) : parseExternalConversationAuthor(a) } catch { return fail() } }
    else {
      object(a, a.kind === 'agent' ? ['kind', 'agentSessionId'] : ['kind'])
      if (a.kind === 'agent') author = { kind: 'agent', agentSessionId: text(a.agentSessionId) }
      else if (a.kind === 'human' || a.kind === 'unknown') author = { kind: a.kind }
      else return fail()
    }
    return { part: original, author }
  })
  if (new Set(sources.map(source => JSON.stringify([conversationRecordId(source.part.record), source.part.selector]))).size !== sources.length) fail()
  return { sender: 'application', sources }
}
export function parseConnectionDeliveryCoverage(value: unknown): ConnectionDeliveryCoverage {
  const p = object(value, ['state', 'gaps', 'nextContent', 'origins'])
  if (!['complete', 'incomplete'].includes(String(p.state)) || !Array.isArray(p.gaps) || p.gaps.length > 100 || !Array.isArray(p.origins) || p.origins.length > 100) fail()
  const gaps: ConnectionDeliveryGap[] = (p.gaps as unknown[]).map(value => {
    const g = object(value, ['gapId', 'event', 'part', 'anchor', 'reason', 'source', 'record', 'code'])
    if (!CONNECTION_DELIVERY_GAP_REASONS.includes(g.reason as ConnectionDeliveryGap['reason'])) fail()
    const selected = g.part === undefined ? undefined : part(g.part)
    const a = g.anchor === undefined ? undefined : object(g.anchor, ['record', 'revision', 'frontier'])
    const f = a ? object(a.frontier, ['hostId', 'agentSessionId', 'sourceHostId', 'frontier']) : undefined
    const anchor = a && f ? parseConversationVersionedAnchor(g.anchor, { hostId: text(f.hostId), agentSessionId: text(f.agentSessionId) }) : undefined
    if (selected && anchor && (conversationRecordId(selected.record) !== conversationRecordId(anchor.record) || selected.recordRevision !== anchor.revision)) fail()
    const record = g.record === undefined ? undefined : reference(g.record)
    if (record && record.source.kind !== 'native' && record.source.kind !== 'captured') fail()
    return { gapId: text(g.gapId), reason: g.reason as ConnectionDeliveryGap['reason'], ...(g.event === undefined ? {} : { event: event(g.event) }), ...(selected ? { part: selected } : {}), ...(anchor ? { anchor } : {}), ...(g.source === undefined ? {} : { source: parseConversationSource(g.source) }), ...(record ? { record: record as ConversationItemRef } : {}), ...(g.code === undefined ? {} : { code: text(g.code) }) }
  })
  const origins: ConnectionOriginRepresentation[] = (p.origins as unknown[]).map(value => {
    const r = object(value, ['event', 'part', 'origin']), o = object(r.origin, ['connectionId', 'externalConversationId', 'externalMessageId'])
    return { event: event(r.event), part: part(r.part), origin: { connectionId: text(o.connectionId), externalConversationId: text(o.externalConversationId), externalMessageId: text(o.externalMessageId) } }
  })
  if (p.state === 'complete' && gaps.length) fail()
  return { state: p.state as ConnectionDeliveryCoverage['state'], gaps, origins, nextContent: p.nextContent === null ? null : text(p.nextContent) }
}
export function parseConnectionDeliveryReceipt(value: unknown): ConnectionDeliveryReceipt {
  const p = object(value, ['state', 'mapping', 'reason'])
  if (p.state === 'confirmed') { if (p.reason !== undefined) fail(); return { state: 'confirmed', mapping: mapping(p.mapping) } }
  if (p.state !== 'unknown' && p.state !== 'not-applied' || p.mapping !== undefined) fail()
  return { state: p.state as 'unknown' | 'not-applied', reason: reason(p.reason) as ConnectionDeliveryReceiptReason }
}
export function parseConnectionDelivery(value: unknown): ConnectionDelivery {
  const p = object(value, ['operationId', 'projectionId', 'sourceRevision', 'bindingId', 'bindingRevision', 'reference', 'target', 'effect', 'fragment', 'state', 'predecessorOperationId', 'mapping', 'reason', 'receipt', 'event', 'relay', 'resourceUpload', 'queryFeedback', 'presentation'])
  const target = object(p.target, ['connectionId', 'application', 'externalConversationId']), app = object(target.application, ['domain', 'appId']), fragment = object(p.fragment, ['ordinal', 'count'])
  const domain = text(app.domain), ordinal = integer(fragment.ordinal, 0), count = integer(fragment.count, 0)
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(domain) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text(app.appId))) fail()
  if (p.effect !== 'upsert' && p.effect !== 'withdraw' || p.effect === 'upsert' && ordinal >= count || !CONNECTION_DELIVERY_STATES.includes(p.state as ConnectionDeliveryState)) fail()
  const mapped = p.mapping === undefined ? undefined : mapping(p.mapping), receipt = p.receipt === undefined ? undefined : parseConnectionDeliveryReceipt(p.receipt)
  const why = p.reason === undefined ? undefined : reason(p.reason, true)
  if (p.state === 'confirmed' && (!mapped || why !== undefined) || (p.state === 'unknown' || p.state === 'not-applied') && (why === undefined || !CONNECTION_DELIVERY_RECEIPT_REASONS.includes(why as ConnectionDeliveryReceiptReason))) fail()
  if (p.effect === 'withdraw' && ['dispatching', 'unknown', 'confirmed', 'not-applied'].includes(p.state as string) && !mapped) fail()
  if (receipt?.state === 'confirmed' && (!mapped || receipt.mapping.messageId !== mapped.messageId || receipt.mapping.threadId !== mapped.threadId || receipt.mapping.reactionId !== mapped.reactionId || receipt.mapping.nativeCard?.id !== mapped.nativeCard?.id || receipt.mapping.nativeCard?.operationId !== mapped.nativeCard?.operationId)) fail()
  if (receipt && ['confirmed', 'unknown', 'not-applied'].includes(p.state as string) && (receipt.state !== p.state || receipt.state !== 'confirmed' && receipt.reason !== why)) fail()
  const operationId = text(p.operationId), predecessorOperationId = p.predecessorOperationId === undefined ? undefined : text(p.predecessorOperationId)
  if (predecessorOperationId === operationId) fail()
  const original = reference(p.reference)
  let queryFeedback: ConnectionDelivery['queryFeedback']
  if (p.queryFeedback !== undefined) {
    const q = object(p.queryFeedback, ['stage', 'ingressId', 'messageId'])
    if (!['received', 'queued', 'dispatched', 'started', 'completed'].includes(String(q.stage)) || original.source.kind !== 'ingress' ||
      ordinal !== 0 || count !== 1 || p.relay !== undefined || p.resourceUpload !== undefined ||
      (p.effect === 'upsert' ? predecessorOperationId !== undefined : predecessorOperationId === undefined)) fail()
    queryFeedback = { stage: q.stage as NonNullable<ConnectionDelivery['queryFeedback']>['stage'], ingressId: text(q.ingressId), messageId: text(q.messageId) }
    if (original.source.kind !== 'ingress' || original.source.ingressId !== queryFeedback.ingressId) fail()
    if (mapped && (mapped.messageId !== queryFeedback.messageId || !mapped.reactionId || mapped.threadId !== undefined)) fail()
  } else if (mapped?.reactionId !== undefined || original.source.kind === 'ingress') fail()
  let resourceUpload: ConnectionDelivery['resourceUpload']
  if (p.resourceUpload !== undefined) {
    const upload = object(p.resourceUpload, ['kind', 'part', 'attempt', 'state']), selected = part(upload.part), attempt = integer(upload.attempt, 0)
    if (p.effect !== 'upsert' || ['dispatching', 'unknown', 'confirmed'].includes(String(p.state)) && upload.state !== 'confirmed' || (upload.kind !== 'image' && upload.kind !== 'file') || !['pending', 'dispatching', 'unknown', 'confirmed'].includes(upload.state as string) ||
      !(selected.record.source.kind === 'native' && selected.selector.kind === 'native-part' ||
        upload.kind === 'image' && selected.record.source.kind === 'captured' && selected.selector.kind === 'captured-field' && selected.selector.field === 'content') ||
      selected.record.hostId !== original.hostId || selected.record.agentSessionId !== original.agentSessionId ||
      (upload.state === 'pending' ? attempt !== 0 : attempt < 1)) fail()
    resourceUpload = { kind: upload.kind as NonNullable<ConnectionDelivery['resourceUpload']>['kind'], part: selected, attempt, state: upload.state as NonNullable<ConnectionDelivery['resourceUpload']>['state'] }
  }
  let presentation: ConnectionDelivery['presentation']
  if (p.presentation !== undefined) {
    const v = object(p.presentation, ['entity', 'portrait'])
    const effect = (value: unknown, portrait: boolean) => {
      const e = object(value, ['state', 'reason'])
      if (!(portrait ? ['pending', 'dispatching', 'unknown', 'confirmed', 'not-applied', 'superseded'] : ['dispatching', 'unknown', 'confirmed', 'not-applied']).includes(String(e.state))) fail()
      if (['unknown', 'not-applied'].includes(String(e.state)) ? e.reason === undefined : e.reason !== undefined) fail()
      return { state: e.state, ...(e.reason === undefined ? {} : { reason: reason(e.reason) }) }
    }
    if (v.entity === undefined && v.portrait === undefined || queryFeedback) fail()
    presentation = { ...(v.entity === undefined ? {} : { entity: effect(v.entity, false) }), ...(v.portrait === undefined ? {} : { portrait: effect(v.portrait, true) }) } as ConnectionDelivery['presentation']
  }
  return { operationId, projectionId: text(p.projectionId), sourceRevision: text(p.sourceRevision), bindingId: text(p.bindingId), bindingRevision: integer(p.bindingRevision, 1), reference: original,
    target: { connectionId: text(target.connectionId), application: { domain, appId: text(app.appId) }, externalConversationId: text(target.externalConversationId) }, effect: p.effect as ConnectionDelivery['effect'], fragment: { ordinal, count }, state: p.state as ConnectionDeliveryState,
    ...(predecessorOperationId === undefined ? {} : { predecessorOperationId }), ...(mapped === undefined ? {} : { mapping: mapped }), ...(why === undefined ? {} : { reason: why }), ...(receipt === undefined ? {} : { receipt }), ...(p.event === undefined ? {} : { event: event(p.event) }), ...(p.relay === undefined ? {} : { relay: relay(p.relay, original) }), ...(resourceUpload ? { resourceUpload } : {}), ...(queryFeedback ? { queryFeedback } : {}), ...(presentation ? { presentation } : {}) }
}
export function parseConnectionDeliveryObservation(value: unknown): ConnectionDeliveryObservation {
  const p = object(value, ['state', 'reason'])
  if (!['unknown', 'ready', 'unavailable', 'disabled'].includes(p.state as string) || p.reason !== undefined && !['not-started', 'access-unconfirmed', 'source-unconfirmed', 'source-gap', 'content-unconfirmed', 'storage-unconfirmed', 'adapter-unavailable', 'credential-missing', 'credential-format-unsupported', 'credential-unavailable', 'effect-unconfirmed'].includes(p.reason as string)) fail()
  return { state: p.state as ConnectionDeliveryObservation['state'], ...(p.reason === undefined ? {} : { reason: p.reason as NonNullable<ConnectionDeliveryObservation['reason']> }) }
}
/** Finite source evidence; a successful read does not resolve earlier durable gaps or effects. */
export function parseConnectionDeliverySourceObservation(value: unknown): ConnectionDeliverySourceObservation {
  const p = object(value, ['state', 'reason', 'code', 'codeRecorded', 'checkpointKey'])
  if (!['ready', 'unavailable'].includes(String(p.state)) || typeof p.codeRecorded !== 'boolean' ||
    p.code !== null && (!connectionDiagnosisSourceCodes.includes(p.code as never) || !p.codeRecorded) ||
    p.reason !== undefined && !['source-unconfirmed', 'source-gap', 'storage-unconfirmed'].includes(String(p.reason)) ||
    p.state === 'ready' && (p.reason !== undefined || p.code !== null || p.codeRecorded) || p.state === 'unavailable' && p.reason === undefined) fail()
  return { state: p.state as ConnectionDeliverySourceObservation['state'], ...(p.reason === undefined ? {} : { reason: p.reason as NonNullable<ConnectionDeliverySourceObservation['reason']> }),
    code: p.code as ConnectionDeliverySourceObservation['code'], codeRecorded: p.codeRecorded as boolean, checkpointKey: p.checkpointKey === null ? null : version(p.checkpointKey) }
}
export function parseConnectionDeliveryParams<M extends ConnectionDeliveryMethod>(method: M, value: unknown): ConnectionDeliveryParamsMap[M] {
  if (method !== 'connection.delivery.ls') { const p = object(value, ['operationId']); return { operationId: text(p.operationId) } as ConnectionDeliveryParamsMap[M] }
  const p = object(value, ['connectionId', 'bindingId', 'bindingRevision', 'after', 'afterContent', 'limit', 'order'])
  const limit = p.limit === undefined ? undefined : integer(p.limit, 1); if (limit !== undefined && limit > 100) fail()
  if (p.order !== undefined && p.order !== 'oldest' && p.order !== 'newest') fail()
  return { connectionId: text(p.connectionId), bindingId: text(p.bindingId), bindingRevision: integer(p.bindingRevision, 1), ...(p.after === undefined ? {} : { after: text(p.after) }), ...(p.afterContent === undefined ? {} : { afterContent: text(p.afterContent) }), ...(limit === undefined ? {} : { limit }), ...(p.order === undefined ? {} : { order: p.order }) } as ConnectionDeliveryParamsMap[M]
}
export function parseConnectionDeliveryResult<M extends ConnectionDeliveryMethod>(method: M, value: unknown, input: ConnectionDeliveryParamsMap[M]): ConnectionDeliveryResultMap[M] {
  if (method === 'connection.delivery.ls') {
    const p = object(value, ['deliveries', 'next', 'observation', 'sourceObservation', 'effectObservation', 'coverage']), expected = input as ConnectionDeliveryParamsMap['connection.delivery.ls']
    if (!Array.isArray(p.deliveries) || p.deliveries.length > (expected.limit ?? 30)) fail()
    const deliveries = (p.deliveries as unknown[]).map(parseConnectionDelivery), next = p.next === null ? null : text(p.next)
    if (new Set(deliveries.map(d => d.operationId)).size !== deliveries.length || deliveries.some(d => d.target.connectionId !== expected.connectionId || d.bindingId !== expected.bindingId || d.bindingRevision !== expected.bindingRevision || d.operationId === expected.after) || next !== null && next !== deliveries.at(-1)?.operationId) fail()
    const coverage = p.coverage === undefined ? undefined : parseConnectionDeliveryCoverage(p.coverage)
    if (coverage?.origins.some(o => o.origin.connectionId !== expected.connectionId)) fail()
    return { deliveries, next, ...(p.observation === undefined ? {} : { observation: parseConnectionDeliveryObservation(p.observation) }), ...(p.sourceObservation === undefined ? {} : { sourceObservation: parseConnectionDeliverySourceObservation(p.sourceObservation) }), ...(p.effectObservation === undefined ? {} : { effectObservation: parseConnectionDeliveryObservation(p.effectObservation) }), ...(coverage ? { coverage } : {}) } as ConnectionDeliveryResultMap[M]
  }
  const p = object(value, ['delivery']), expected = input as ConnectionDeliveryParamsMap['connection.delivery.inspect']
  const delivery = p.delivery === null && method === 'connection.delivery.inspect' ? null : parseConnectionDelivery(p.delivery)
  if (delivery && delivery.operationId !== expected.operationId) fail()
  return { delivery } as ConnectionDeliveryResultMap[M]
}
