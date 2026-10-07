import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { ConversationItemRef, ConversationRef } from './conversation.js'

/** A user-named reference, never a second conversation body or availability fact. */
export type ConversationLandmark = { id: string; name: string; reference: ConversationItemRef }
export type ConversationLandmarkActor = { kind: 'user' | 'device' | 'agent'; id: string }
export type ConversationLandmarkChange =
  | { kind: 'create'; point: ConversationLandmark }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'remove'; id: string }
export type ConversationLandmarkQuery = ConversationRef & { operationId?: string }
export type ConversationLandmarkWrite = ConversationRef & { operationId: string; expectedRevision: number; change: ConversationLandmarkChange }
export type ConversationLandmarkOperation = { input: ConversationLandmarkWrite; actor: ConversationLandmarkActor; revision: number }
export type ConversationLandmarkPage = ConversationRef & { revision: number; points: ConversationLandmark[]; recordedOperation: ConversationLandmarkOperation | null }
export type ConversationLandmarkApi = {
  list(input: ConversationLandmarkQuery): Promise<ConversationLandmarkPage>
  apply(input: ConversationLandmarkWrite): Promise<ConversationLandmarkPage>
}
const fail = (message: string): never => { throw new AgentMuxError(message + ' Original records and Agents are retained.', 'CONVERSATION_LANDMARK_INVALID') }
const object = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'CONVERSATION_LANDMARK_INVALID')
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) fail('An exact identity or nonempty name is required.')
  return value as string
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail('The original metadata revision is required.')
  return value as number
}
export function parseConversationLandmarkRef(value: unknown): ConversationItemRef {
  const p = object(value, ['hostId', 'agentSessionId', 'source']), source = object(p.source, ['kind', 'providerId', 'nativeSessionId', 'recordId'])
  const ref = { hostId: text(p.hostId), agentSessionId: text(p.agentSessionId) }, recordId = text(source.recordId)
  if (source.kind === 'native') return { ...ref, source: { kind: 'native', providerId: text(source.providerId), nativeSessionId: text(source.nativeSessionId), recordId } }
  if (source.kind !== 'captured' || source.providerId !== undefined || source.nativeSessionId !== undefined) fail('The original record source is required.')
  return { ...ref, source: { kind: 'captured', recordId } }
}
export function parseConversationLandmark(value: unknown): ConversationLandmark {
  const p = object(value, ['id', 'name', 'reference'])
  return { id: text(p.id), name: text(p.name), reference: parseConversationLandmarkRef(p.reference) }
}
export function parseConversationLandmarkQuery(value: unknown): ConversationLandmarkQuery {
  const p = object(value, ['hostId', 'agentSessionId', 'operationId'])
  return { hostId: text(p.hostId), agentSessionId: text(p.agentSessionId), ...(p.operationId === undefined ? {} : { operationId: text(p.operationId) }) }
}
export function sameLandmarkScope(a: ConversationRef, b: ConversationRef): boolean { return a.hostId === b.hostId && a.agentSessionId === b.agentSessionId }
export function parseConversationLandmarkWrite(value: unknown): ConversationLandmarkWrite {
  const p = object(value, ['hostId', 'agentSessionId', 'operationId', 'expectedRevision', 'change'])
  const scope = parseConversationLandmarkQuery({ hostId: p.hostId, agentSessionId: p.agentSessionId }), c = object(p.change, ['kind', 'point', 'id', 'name'])
  let change: ConversationLandmarkChange
  if (c.kind === 'create') {
    object(c, ['kind', 'point']); const point = parseConversationLandmark(c.point)
    if (!sameLandmarkScope(scope, point.reference)) fail('The point belongs to another original conversation.')
    change = { kind: 'create', point }
  } else if (c.kind === 'rename') { object(c, ['kind', 'id', 'name']); change = { kind: 'rename', id: text(c.id), name: text(c.name) } }
  else if (c.kind === 'remove') { object(c, ['kind', 'id']); change = { kind: 'remove', id: text(c.id) } }
  else return fail('Choose an explicit create, rename or remove action.')
  return { ...scope, operationId: text(p.operationId), expectedRevision: revision(p.expectedRevision), change }
}
export function parseConversationLandmarkOperation(value: unknown): ConversationLandmarkOperation {
  const p = object(value, ['input', 'actor', 'revision']), a = object(p.actor, ['kind', 'id'])
  if (!['user', 'device', 'agent'].includes(String(a.kind))) fail('The metadata operation author is unconfirmed.')
  const input = parseConversationLandmarkWrite(p.input), committedRevision = revision(p.revision)
  if (committedRevision !== input.expectedRevision + 1) fail('The recorded revision does not follow the original metadata intent.')
  return { input, actor: { kind: a.kind as ConversationLandmarkActor['kind'], id: text(a.id) }, revision: committedRevision }
}
export function parseConversationLandmarkPage(value: unknown, query: ConversationLandmarkQuery): ConversationLandmarkPage {
  try {
    const p = object(value, ['hostId', 'agentSessionId', 'revision', 'points', 'recordedOperation'])
    if (!sameLandmarkScope(p as ConversationRef, query) || !Array.isArray(p.points)) return fail('The metadata response belongs to another conversation.')
    const points = p.points.map(parseConversationLandmark), ids = new Set<string>()
    for (const point of points) {
      if (!sameLandmarkScope(point.reference, query) || ids.has(point.id)) fail('The original point identity is unconfirmed.')
      ids.add(point.id)
    }
    const operation = p.recordedOperation === null ? null : parseConversationLandmarkOperation(p.recordedOperation)
    const currentRevision = revision(p.revision)
    if (operation && (!sameLandmarkScope(operation.input, query) || operation.input.operationId !== query.operationId || operation.revision > currentRevision)) fail('The original metadata operation is unconfirmed.')
    return { hostId: query.hostId, agentSessionId: query.agentSessionId, revision: currentRevision, points, recordedOperation: operation }
  } catch (error) { throw new AgentMuxError('The named reading-point response is unconfirmed. Original records and Agents are retained.', 'CONTROL_PROTOCOL_ERROR', error instanceof Error ? error.message : String(error)) }
}

export function parseConversationLandmarkWritePage(value: unknown, input: ConversationLandmarkWrite): ConversationLandmarkPage {
  const expected = parseConversationLandmarkWrite(input), page = parseConversationLandmarkPage(value, expected)
  if (!page.recordedOperation || JSON.stringify(page.recordedOperation.input) !== JSON.stringify(expected)) throw new AgentMuxError('The reading-point receipt describes another original intent.', 'CONTROL_PROTOCOL_ERROR')
  return page
}
