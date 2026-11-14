import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

export type ContinuousProgressDefinitionReference = { intentId: string; operationId: string }
/** A selected immutable definition. The original creation operation keeps its own identity. */
export type ContinuousProgressDefinition = ContinuousProgressDefinitionReference & { baseIntentId: string; guidanceRevision: string }
/** Original-operation bookkeeping on the existing loop; never an input or permission receipt. */
export type ContinuousProgressGuidanceAdoption = {
  operationId: string
  requestDigest: string
  actor: { kind: 'user' | 'device'; id: string }
  expectedRevision: number
  oldDefinition: ContinuousProgressDefinitionReference
  newDefinition: ContinuousProgressDefinition
  guidance: string
  preparedAt: number
  state: 'prepared' | 'adopted' | 'unconfirmed' | 'refused'
  publishedAt?: number
  issue: string | null
}
const invalid = (code: string): never => { throw new AgentMuxError('The original guidance definition or adoption receipt is invalid.', code) }
function id(value: unknown, code: string): string {
  return typeof value === 'string' && !!value.trim() && !/[\0\r\n]/u.test(value) ? value : invalid(code)
}
function time(value: unknown, code: string, minimum = 0): number {
  return Number.isSafeInteger(value) && Number(value) >= minimum ? Number(value) : invalid(code)
}
export function parseContinuousProgressDefinitionReference(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): ContinuousProgressDefinitionReference {
  const p = rpcRecord(value, ['intentId', 'operationId'], code)
  return { intentId: id(p.intentId, code), operationId: id(p.operationId, code) }
}
export function parseContinuousProgressDefinition(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): ContinuousProgressDefinition {
  const p = rpcRecord(value, ['intentId', 'operationId', 'baseIntentId', 'guidanceRevision'], code)
  return { intentId: id(p.intentId, code), operationId: id(p.operationId, code), baseIntentId: id(p.baseIntentId, code), guidanceRevision: id(p.guidanceRevision, code) }
}
export function parseContinuousProgressGuidanceAdoption(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): ContinuousProgressGuidanceAdoption {
  const p = rpcRecord(value, ['operationId', 'requestDigest', 'actor', 'expectedRevision', 'oldDefinition', 'newDefinition', 'guidance', 'preparedAt', 'state', 'publishedAt', 'issue'], code)
  const actor = rpcRecord(p.actor, ['kind', 'id'], code)
  if (actor.kind !== 'user' && actor.kind !== 'device' || typeof p.requestDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(p.requestDigest) ||
      typeof p.guidance !== 'string' || !p.guidance.trim() || p.guidance.includes('\0') ||
      !['prepared', 'adopted', 'unconfirmed', 'refused'].includes(String(p.state)) || !(p.issue === null || typeof p.issue === 'string')) return invalid(code)
  const oldDefinition = parseContinuousProgressDefinitionReference(p.oldDefinition, code), newDefinition = parseContinuousProgressDefinition(p.newDefinition, code)
  const preparedAt = time(p.preparedAt, code), publishedAt = p.publishedAt === undefined ? undefined : time(p.publishedAt, code)
  if (oldDefinition.intentId === newDefinition.intentId || oldDefinition.operationId === newDefinition.operationId ||
      p.state === 'adopted' && (publishedAt === undefined || p.issue !== null) ||
      (p.state === 'prepared' || p.state === 'refused') && publishedAt !== undefined ||
      (p.state === 'unconfirmed' || p.state === 'refused') && (typeof p.issue !== 'string' || !p.issue.trim())) return invalid(code)
  return { operationId: id(p.operationId, code), requestDigest: p.requestDigest, actor: { kind: actor.kind, id: id(actor.id, code) },
    expectedRevision: time(p.expectedRevision, code, 1), oldDefinition, newDefinition, guidance: p.guidance,
    preparedAt, state: p.state as ContinuousProgressGuidanceAdoption['state'], ...(publishedAt === undefined ? {} : { publishedAt }), issue: p.issue as string | null }
}
export function parseContinuousProgressGuidanceAdoptions(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): ContinuousProgressGuidanceAdoption[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return invalid(code)
  const records = Array.from(value, item => parseContinuousProgressGuidanceAdoption(item, code))
  if (new Set(records.map(item => item.operationId)).size !== records.length) return invalid(code)
  return records
}
