import { parseGroundingProposal, type DemandCriterion, type DemandGroundingProposal } from './goals.js'

/** Task material provenance. Discovery and actual adoption are separate claims. */
export type DemandDelegationContextSource = {
  kind: 'file' | 'context' | 'skill'
  source: string
  revision: string | null
  scope: string
  availability: 'available' | 'missing' | 'unknown' | 'excerpt'
}

/** Frozen business intent; Core remains the owner of transmission and replies. */
export type DemandDelegationIntent = {
  operationId: string
  sourceMessageId: string
  hostId: string
  ownerAgentSessionId: string
  workerAgentSessionId: string
  ownerRunId: string
  workerRunId: string
  threadId: string
  text: string
  /** Original task request before owner-prepared material was added to text. */
  requestText?: string
  alignmentRevision: number
  criterionIds: string[]
  context?: DemandDelegationContextSource[]
}
export type DemandDelegationReportInput = {
  operationId: string
  replyMessageId: string
  authorAgentSessionId: string
  grounding: DemandGroundingProposal
}
export type DemandDelegationReport = DemandDelegationReportInput & {
  submittedAt: number
  /** Restored from Main-verified original Core evidence, with its actual restorer. */
  recovery?: { collector: DemandDelegationCollector; recoveredAt: number }
}
/** Admitted by the host transport, never taken from a report business payload. */
export type DemandDelegationCollector = { kind: 'agent' | 'user' | 'device'; id: string }
export type DemandDelegationCollectionInput = { operationId: string; replyMessageId: string }
export type DemandDelegationCollection = DemandDelegationCollectionInput & {
  collector: DemandDelegationCollector
  collectedAt: number
  groundingSubmissionId?: string
}
/** One frozen responsibility notice reference; Core owns its original input. */
export type DemandDelegationAttentionInput = {
  operationId: string
  intentId: string
  hostId: string
  supervisorAgentSessionId: string
  supervisorRunId: string
  occurrenceAt: number
  agentMuxNote: string
}
export type DemandDelegationAttention = DemandDelegationAttentionInput & { preparedAt: number; attemptedAt?: number }
export type DemandDelegation = DemandDelegationIntent & {
  preparedAt: number
  /** Owner-captured standards retain the meaning of late, old-version reports. */
  capturedCriteria: DemandCriterion[]
  /** Only the verified association to an original Core dispatch, not delivery. */
  linkedAt?: number
  report?: DemandDelegationReport
  collection?: DemandDelegationCollection
  attention?: DemandDelegationAttention
}

function record(value: unknown, label: string, allowed: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !allowed.includes(key)) || allowed.some(key => !optional.includes(key) && !Object.hasOwn(result, key)))
    throw new Error(`${label} has unsupported or missing fields`)
  return result
}
function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) throw new Error(`${label} must be an original nonempty identity`)
  return value
}
function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`)
  return value
}
const intentKeys = ['operationId', 'sourceMessageId', 'hostId', 'ownerAgentSessionId', 'workerAgentSessionId', 'ownerRunId', 'workerRunId', 'threadId', 'text', 'requestText', 'alignmentRevision', 'criterionIds', 'context']
export function parseDemandDelegationIntent(value: unknown): DemandDelegationIntent {
  const data = record(value, 'delegation', intentKeys, ['context', 'requestText'])
  if (typeof data.text !== 'string' || !data.text.trim() || data.text.includes('\0')) throw new Error('delegation.text must be a nonempty frozen body')
  if (data.requestText !== undefined && (typeof data.requestText !== 'string' || !data.requestText.trim() || data.requestText.includes('\0'))) throw new Error('delegation.requestText must be the nonempty original task request')
  if (!Array.isArray(data.criterionIds) || data.criterionIds.length === 0) throw new Error('delegation requires at least one success criterion')
  const criterionIds = data.criterionIds.map(value => identity(value, 'delegation.criterionId'))
  if (new Set(criterionIds).size !== criterionIds.length) throw new Error('delegation criterion IDs must be unique')
  let context: DemandDelegationContextSource[] | undefined
  if (data.context !== undefined) {
    if (!Array.isArray(data.context)) throw new Error('delegation.context must be an array')
    context = data.context.map(value => {
      const item = record(value, 'delegation.context', ['kind', 'source', 'revision', 'scope', 'availability'])
      if (!['file', 'context', 'skill'].includes(String(item.kind)) || !['available', 'missing', 'unknown', 'excerpt'].includes(String(item.availability)))
        throw new Error('delegation.context kind or availability is invalid')
      return { kind: item.kind as DemandDelegationContextSource['kind'], source: identity(item.source, 'context.source'),
        revision: item.revision === null ? null : identity(item.revision, 'context.revision'), scope: identity(item.scope, 'context.scope'),
        availability: item.availability as DemandDelegationContextSource['availability'] }
    })
  }
  return { operationId: identity(data.operationId, 'delegation.operationId'), sourceMessageId: identity(data.sourceMessageId, 'delegation.sourceMessageId'),
    hostId: identity(data.hostId, 'delegation.hostId'), ownerAgentSessionId: identity(data.ownerAgentSessionId, 'delegation.ownerAgentSessionId'),
    workerAgentSessionId: identity(data.workerAgentSessionId, 'delegation.workerAgentSessionId'), ownerRunId: identity(data.ownerRunId, 'delegation.ownerRunId'),
    workerRunId: identity(data.workerRunId, 'delegation.workerRunId'), threadId: identity(data.threadId, 'delegation.threadId'), text: data.text,
    ...(data.requestText === undefined ? {} : { requestText: data.requestText as string }),
    alignmentRevision: positive(data.alignmentRevision, 'delegation.alignmentRevision'), criterionIds, ...(context === undefined ? {} : { context }) }
}
export function parseDemandDelegationReportInput(value: unknown): DemandDelegationReportInput {
  const data = record(value, 'delegation.report', ['operationId', 'replyMessageId', 'authorAgentSessionId', 'grounding'])
  return { operationId: identity(data.operationId, 'report.operationId'), replyMessageId: identity(data.replyMessageId, 'report.replyMessageId'),
    authorAgentSessionId: identity(data.authorAgentSessionId, 'report.authorAgentSessionId'), grounding: parseGroundingProposal(data.grounding) }
}
export function parseDemandDelegationCollector(value: unknown): DemandDelegationCollector {
  const data = record(value, 'delegation.collector', ['kind', 'id'])
  if (data.kind !== 'agent' && data.kind !== 'user' && data.kind !== 'device') throw new Error('delegation.collector kind is invalid')
  return { kind: data.kind, id: identity(data.id, 'collector.id') }
}
export function parseDemandDelegationCollectionInput(value: unknown): DemandDelegationCollectionInput {
  const data = record(value, 'delegation.collection', ['operationId', 'replyMessageId'])
  return { operationId: identity(data.operationId, 'collection.operationId'), replyMessageId: identity(data.replyMessageId, 'collection.replyMessageId') }
}
const attentionKeys = ['operationId', 'intentId', 'hostId', 'supervisorAgentSessionId', 'supervisorRunId', 'occurrenceAt', 'agentMuxNote']
export function parseDemandDelegationAttentionInput(value: unknown): DemandDelegationAttentionInput {
  const data = record(value, 'delegation.attention', attentionKeys)
  if (typeof data.agentMuxNote !== 'string' || !data.agentMuxNote.trim() || data.agentMuxNote.includes('\0')) throw new Error('attention.agentMuxNote must be a nonempty frozen platform note')
  return { operationId: identity(data.operationId, 'attention.operationId'), intentId: identity(data.intentId, 'attention.intentId'), hostId: identity(data.hostId, 'attention.hostId'),
    supervisorAgentSessionId: identity(data.supervisorAgentSessionId, 'attention.supervisorAgentSessionId'), supervisorRunId: identity(data.supervisorRunId, 'attention.supervisorRunId'),
    occurrenceAt: positive(data.occurrenceAt, 'attention.occurrenceAt'), agentMuxNote: data.agentMuxNote }
}
export function sameDemandDelegationAttention(left: DemandDelegationAttentionInput, right: DemandDelegationAttentionInput): boolean {
  return attentionKeys.every(key => left[key as keyof DemandDelegationAttentionInput] === right[key as keyof DemandDelegationAttentionInput])
}
export function sameDemandDelegationIntent(left: DemandDelegationIntent, right: DemandDelegationIntent): boolean {
  return intentKeys.every(key => JSON.stringify(left[key as keyof DemandDelegationIntent]) === JSON.stringify(right[key as keyof DemandDelegationIntent]))
}
export function parseDemandDelegation(value: unknown): DemandDelegation {
  const data = record(value, 'delegation', [...intentKeys, 'preparedAt', 'capturedCriteria', 'linkedAt', 'report', 'collection', 'attention'], ['context', 'requestText', 'linkedAt', 'report', 'collection', 'attention'])
  const intent = parseDemandDelegationIntent(Object.fromEntries(intentKeys.filter(key => data[key] !== undefined).map(key => [key, data[key]])))
  if (!Array.isArray(data.capturedCriteria)) throw new Error('delegation.capturedCriteria must be an array')
  const capturedCriteria = data.capturedCriteria.map(value => {
    const item = record(value, 'capturedCriterion', ['id', 'text'])
    if (typeof item.text !== 'string' || !item.text.trim()) throw new Error('capturedCriterion.text must be a nonempty string')
    return { id: identity(item.id, 'capturedCriterion.id'), text: item.text }
  })
  if (capturedCriteria.length !== intent.criterionIds.length || new Set(capturedCriteria.map(item => item.id)).size !== capturedCriteria.length ||
    capturedCriteria.some(item => !intent.criterionIds.includes(item.id))) throw new Error('delegation captured standards differ from its original criteria')
  let report: DemandDelegationReport | undefined
  if (data.report !== undefined) {
    const item = record(data.report, 'delegation.report', ['operationId', 'replyMessageId', 'authorAgentSessionId', 'grounding', 'submittedAt', 'recovery'], ['recovery'])
    const recovery = item.recovery === undefined ? undefined : record(item.recovery, 'report.recovery', ['collector', 'recoveredAt'])
    report = { ...parseDemandDelegationReportInput({ operationId: item.operationId, replyMessageId: item.replyMessageId, authorAgentSessionId: item.authorAgentSessionId, grounding: item.grounding }),
      submittedAt: positive(item.submittedAt, 'report.submittedAt'),
      ...(recovery === undefined ? {} : { recovery: { collector: parseDemandDelegationCollector(recovery.collector), recoveredAt: positive(recovery.recoveredAt, 'report.recovery.recoveredAt') } }) }
    validateDemandDelegationReport(intent, report)
    if (data.linkedAt === undefined) throw new Error('delegation report lacks its original dispatch association')
  }
  let collection: DemandDelegationCollection | undefined
  if (data.collection !== undefined) {
    const item = record(data.collection, 'delegation.collection', ['operationId', 'replyMessageId', 'collector', 'collectedAt', 'groundingSubmissionId'], ['groundingSubmissionId'])
    collection = { ...parseDemandDelegationCollectionInput({ operationId: item.operationId, replyMessageId: item.replyMessageId }),
      collector: parseDemandDelegationCollector(item.collector), collectedAt: positive(item.collectedAt, 'collection.collectedAt'),
      ...(item.groundingSubmissionId === undefined ? {} : { groundingSubmissionId: identity(item.groundingSubmissionId, 'collection.groundingSubmissionId') }) }
    if (!report || collection.replyMessageId !== report.replyMessageId) throw new Error('delegation collection lacks its original report')
  }
  let attention: DemandDelegationAttention | undefined
  if (data.attention !== undefined) {
    const item = record(data.attention, 'delegation.attention', [...attentionKeys, 'preparedAt', 'attemptedAt'], ['attemptedAt'])
    attention = { ...parseDemandDelegationAttentionInput(Object.fromEntries(attentionKeys.map(key => [key, item[key]]))), preparedAt: positive(item.preparedAt, 'attention.preparedAt'),
      ...(item.attemptedAt === undefined ? {} : { attemptedAt: positive(item.attemptedAt, 'attention.attemptedAt') }) }
    if (attention.hostId !== intent.hostId || data.linkedAt === undefined) throw new Error('delegation attention lacks its original linked Host')
  }
  return { ...intent, capturedCriteria, preparedAt: positive(data.preparedAt, 'delegation.preparedAt'),
    ...(data.linkedAt === undefined ? {} : { linkedAt: positive(data.linkedAt, 'delegation.linkedAt') }),
    ...(report === undefined ? {} : { report }), ...(collection === undefined ? {} : { collection }), ...(attention === undefined ? {} : { attention }) }
}
export function validateDemandDelegationReport(intent: DemandDelegationIntent, report: DemandDelegationReportInput): void {
  const checks = report.grounding.checks
  if (report.authorAgentSessionId !== intent.workerAgentSessionId || report.grounding.alignmentRevision !== intent.alignmentRevision ||
    checks.length !== intent.criterionIds.length || checks.some(check => !intent.criterionIds.includes(check.criterionId)))
    throw new Error('Report must belong to the original worker, proposal version and every delegated criterion')
}
export function parseDemandDelegations(value: unknown): DemandDelegation[] {
  if (!Array.isArray(value)) throw new Error('delegations must be an array')
  const result = value.map(parseDemandDelegation)
  for (const select of [(item: DemandDelegation) => item.operationId, (item: DemandDelegation) => item.sourceMessageId])
    if (new Set(result.map(select)).size !== result.length) throw new Error('delegations contain duplicate original identities')
  const reports = result.flatMap(item => item.report ? [item.report] : [])
  for (const select of [(item: DemandDelegationReport) => item.operationId, (item: DemandDelegationReport) => item.replyMessageId])
    if (new Set(reports.map(select)).size !== reports.length) throw new Error('delegation reports contain duplicate original identities')
  const collections = result.flatMap(item => item.collection ? [item.collection.operationId] : [])
  if (new Set(collections).size !== collections.length) throw new Error('delegation collections contain duplicate operations')
  const attention = result.flatMap(item => item.attention ? [item.attention] : [])
  for (const select of [(item: DemandDelegationAttention) => item.operationId, (item: DemandDelegationAttention) => item.intentId])
    if (new Set(attention.map(select)).size !== attention.length) throw new Error('delegation attention contains duplicate original identities')
  return result
}
