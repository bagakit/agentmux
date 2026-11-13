import { AgentMuxError } from './errors.js'
import { parseConnectionApplication } from './room-binding-codec.js'
import type { ConnectionApplication } from './connections-contract.js'
import { rpcRecord } from './rpc-data.js'
import { parseConversationCheckpoint, parseConversationVersionedAnchor, type ConversationCheckpoint, type ConversationVersionedAnchor } from './conversation-changes.js'
export type ConnectionSourceReviewAction = { operationId: string } & (
  | { action: 'prepare' }
  | { action: 'inspect'; after?: ConversationCheckpoint; limit?: number }
  | { action: 'approve'; digest: string }
  | { action: 'cancel'; digest?: string })
export type ConnectionSourceReview = {
  target: { connectionId: string; bindingId: string; bindingRevision: number; application: ConnectionApplication; externalConversationId: string }
  operationId: string; state: 'preparing' | 'ready' | 'approved' | 'blocked' | 'cancelled'; digest?: string; acceptedDigest?: string
  original: ConversationCheckpoint; from: ConversationCheckpoint; through: ConversationCheckpoint
  publicRecords: number; excludedRecords: number; unmappedEffects: number; unmappedOperations: string[]
  first: ConversationVersionedAnchor | null; last: ConversationVersionedAnchor | null
  items: { disposition: 'candidate' | 'existing-effect' | 'unconfirmed'; existingOperationId?: string; anchor: ConversationVersionedAnchor; text: string; resources: { partIndex: number; reference: string }[] }[]
  next: ConversationCheckpoint | null
}
const fail = (): never => { throw new AgentMuxError('The source review does not describe the original immutable offer.', 'INVALID_CONNECTION_DELIVERY_DATA') }
const object = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'INVALID_CONNECTION_DELIVERY_DATA')
const text = (value: unknown): string => { if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) fail(); return value as string }
const integer = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) fail(); return value as number }
const digest = (value: unknown): string => { if (!/^[a-f0-9]{64}$/u.test(String(value))) fail(); return value as string }
export function parseConnectionSourceReviewAction(value: unknown): ConnectionSourceReviewAction {
  const p = object(value, ['operationId', 'action', 'after', 'limit', 'digest']), operationId = text(p.operationId)
  if (p.action === 'prepare') { object(p, ['operationId', 'action']); return { operationId, action: 'prepare' } }
  if (p.action === 'inspect') {
    object(p, ['operationId', 'action', 'after', 'limit']); const limit = p.limit === undefined ? undefined : integer(p.limit)
    if (limit !== undefined && (limit < 1 || limit > 100)) fail()
    return { operationId, action: 'inspect', ...(p.after === undefined ? {} : { after: parseConversationCheckpoint(p.after) }), ...(limit === undefined ? {} : { limit }) }
  }
  if (p.action !== 'approve' && p.action !== 'cancel') fail()
  object(p, ['operationId', 'action', 'digest']); return p.action === 'approve' ? { operationId, action: 'approve', digest: digest(p.digest) } : { operationId, action: 'cancel', ...(p.digest === undefined ? {} : { digest: digest(p.digest) }) }
}
export function parseConnectionSourceReview(value: unknown): ConnectionSourceReview {
  const p = object(value, ['target', 'operationId', 'state', 'digest', 'acceptedDigest', 'original', 'from', 'through', 'publicRecords', 'excludedRecords', 'unmappedEffects', 'unmappedOperations', 'first', 'last', 'items', 'next'])
  if (!['preparing', 'ready', 'approved', 'blocked', 'cancelled'].includes(String(p.state)) || !Array.isArray(p.items) || p.items.length > 100 || !Array.isArray(p.unmappedOperations) || p.unmappedOperations.length > 100) fail()
  const from = parseConversationCheckpoint(p.from), through = parseConversationCheckpoint(p.through), original = parseConversationCheckpoint(p.original)
  if ([through, original].some(cp => cp.hostId !== from.hostId || cp.agentSessionId !== from.agentSessionId || cp.sourceHostId !== from.sourceHostId) || from.frontier.cuts.length !== 1 || through.frontier.cuts.length !== 1 || from.frontier.cuts[0]?.kind !== 'native' || through.frontier.cuts[0]?.kind !== 'native') fail()
  const target = object(p.target, ['connectionId', 'bindingId', 'bindingRevision', 'application', 'externalConversationId'])
  if (integer(target.bindingRevision) < 1) fail()
  return { target: { connectionId: text(target.connectionId), bindingId: text(target.bindingId), bindingRevision: integer(target.bindingRevision), application: parseConnectionApplication(target.application), externalConversationId: text(target.externalConversationId) }, operationId: text(p.operationId), state: p.state as ConnectionSourceReview['state'], ...(p.digest === undefined ? {} : { digest: digest(p.digest) }), ...(p.acceptedDigest === undefined ? {} : { acceptedDigest: digest(p.acceptedDigest) }), original, from, through,
    publicRecords: integer(p.publicRecords), excludedRecords: integer(p.excludedRecords), unmappedEffects: integer(p.unmappedEffects), unmappedOperations: (p.unmappedOperations as unknown[]).map(text),
    first: p.first === null ? null : parseConversationVersionedAnchor(p.first, from), last: p.last === null ? null : parseConversationVersionedAnchor(p.last, from),
    items: (p.items as unknown[]).map(value => { const item = object(value, ['anchor', 'text', 'resources', 'disposition', 'existingOperationId']); if (typeof item.text !== 'string' || !Array.isArray(item.resources) || !['candidate','existing-effect','unconfirmed'].includes(String(item.disposition))) fail(); return { disposition: item.disposition as ConnectionSourceReview['items'][number]['disposition'], ...(item.existingOperationId === undefined ? {} : { existingOperationId: text(item.existingOperationId) }), anchor: parseConversationVersionedAnchor(item.anchor, from), text: item.text as string,
      resources: (item.resources as unknown[]).map(value => { const resource = object(value, ['partIndex', 'reference']); return { partIndex: integer(resource.partIndex), reference: text(resource.reference) } }) } }), next: p.next === null ? null : parseConversationCheckpoint(p.next) }
}
