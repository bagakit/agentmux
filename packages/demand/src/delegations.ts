import { isGoalTicketHash, parseGoalTicketProof, type GoalTicketProof } from './goal-ticket-proof.js'
import { optionalDemandInputEpoch } from './collaboration.js'
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
  /** Original Goal/owner Host route. Runtime authentication remains with Core. */
  hostId: string
  /** Exact worker route. Absence in an original record means its original shared Host. */
  workerHostId?: string
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
  /** The Goal plan node this attempt works on; absent for work outside a plan. */
  planNodeId?: string
}
export type DemandDelegationReportInput = {
  operationId: string
  replyMessageId: string
  authorAgentSessionId: string
  grounding: DemandGroundingProposal
}
export type GoalDeliveryScope = { ownerRuntimeId: string; namespace: string; authorRuntimeId: string }
export type GoalDeliveryReceipt = { schema: 'agentmux.ticket-delivery.v2'; hash: string; authorRuntimeId: string }
export function isGoalDeliveryHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}
function parseGoalDeliveryReceipt(value: unknown): GoalDeliveryReceipt {
  const data = record(value, 'Ticket delivery receipt', ['schema', 'hash', 'authorRuntimeId'])
  if (data.schema !== 'agentmux.ticket-delivery.v2' || !isGoalDeliveryHash(data.hash)) throw new Error('Invalid Ticket delivery receipt')
  return { schema: data.schema, hash: data.hash, authorRuntimeId: identity(data.authorRuntimeId, 'Delivery author Runtime') }
}
export type DemandDelegationReport = DemandDelegationReportInput & {
  delivery?: GoalDeliveryReceipt
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
  inputEpoch?: string
  operationId: string
  intentId: string
  hostId: string
  supervisorAgentSessionId: string
  supervisorRunId: string
  occurrenceAt: number
  agentMuxNote: string
}
export type DemandDelegationAttention = DemandDelegationAttentionInput & { preparedAt: number; attemptedAt?: number }
/** Original authenticated Core participants, recorded only when the source is linked. */
export type DemandDelegationRuntimeIdentity = { ownerRuntimeId: string; workerRuntimeId: string }
export function parseDemandDelegationRuntimeIdentity(value: unknown): DemandDelegationRuntimeIdentity {
  const data = record(value, 'delegation.runtimeIdentity', ['ownerRuntimeId', 'workerRuntimeId'])
  return { ownerRuntimeId: identity(data.ownerRuntimeId, 'runtimeIdentity.ownerRuntimeId'), workerRuntimeId: identity(data.workerRuntimeId, 'runtimeIdentity.workerRuntimeId') }
}
/** Direct links to the exact passing inputs of this attempt. */
export type GoalPlanPredecessor = { nodeId: string; delegationOperationId: string; reportOperationId: string; reviewOperationId: string; deliveryHash?: string; completionHash?: string }

export function sameGoalPlanPredecessors(expected: readonly GoalPlanPredecessor[], actual: readonly GoalPlanPredecessor[] | null | undefined): boolean {
  if (!actual || expected.length !== actual.length) return false
  return expected.every((ref, index) => {
    const other = actual[index]!
    return ref.nodeId === other.nodeId && ref.delegationOperationId === other.delegationOperationId &&
      ref.reportOperationId === other.reportOperationId && ref.reviewOperationId === other.reviewOperationId && ref.deliveryHash === other.deliveryHash && ref.completionHash === other.completionHash
  })
}

function ticketHash(value: unknown): string {
  if (!isGoalTicketHash(value)) throw new Error('Invalid predecessor completion proof hash')
  return value
}

export function parseGoalPlanPredecessors(value: unknown): GoalPlanPredecessor[] {
  if (!Array.isArray(value)) throw new Error('Goal plan predecessors must be an array')
  const refs = value.map(entry => {
    const item = record(entry, 'Goal plan predecessor', ['nodeId', 'delegationOperationId', 'reportOperationId', 'reviewOperationId', 'deliveryHash', 'completionHash'], ['deliveryHash', 'completionHash'])
    if (item.deliveryHash !== undefined && !isGoalDeliveryHash(item.deliveryHash)) throw new Error('Invalid predecessor delivery hash')
    return {
      ...(typeof item.deliveryHash === 'string' ? { deliveryHash: item.deliveryHash } : {}),
      ...(item.completionHash === undefined ? {} : { completionHash: ticketHash(item.completionHash) }),
      nodeId: identity(item.nodeId, 'predecessor node'),
      delegationOperationId: identity(item.delegationOperationId, 'predecessor delegation'),
      reportOperationId: identity(item.reportOperationId, 'predecessor report'),
      reviewOperationId: identity(item.reviewOperationId, 'predecessor review'),
    }
  })
  if (new Set(refs.map(ref => ref.nodeId)).size !== refs.length) throw new Error('Goal plan predecessors repeat a node')
  return refs
}

export type DemandDelegation = DemandDelegationIntent & {
  predecessors?: GoalPlanPredecessor[]
  claimOperationId?: string
  dispatchProof?: GoalTicketProof
  preparedAt: number
  /** Owner-captured standards retain the meaning of late, old-version reports. */
  capturedCriteria: DemandCriterion[]
  /** Only the verified association to an original Core dispatch, not delivery. */
  linkedAt?: number
  runtimeIdentity?: DemandDelegationRuntimeIdentity
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
/** The original schema used hostId for both participants; it never meant an unknown worker Host. */
export function delegationWorkerHostId(intent: Pick<DemandDelegationIntent, 'hostId' | 'workerHostId'>): string {
  return intent.workerHostId ?? intent.hostId
}
const intentKeys = ['operationId', 'sourceMessageId', 'hostId', 'workerHostId', 'ownerAgentSessionId', 'workerAgentSessionId', 'ownerRunId', 'workerRunId', 'threadId', 'text', 'requestText', 'alignmentRevision', 'criterionIds', 'planNodeId', 'context']
export function parseDemandDelegationIntent(value: unknown): DemandDelegationIntent {
  const data = record(value, 'delegation', intentKeys, ['context', 'requestText', 'planNodeId', 'workerHostId'])
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
    ...(data.workerHostId === undefined ? {} : { workerHostId: identity(data.workerHostId, 'delegation.workerHostId') }),
    workerAgentSessionId: identity(data.workerAgentSessionId, 'delegation.workerAgentSessionId'), ownerRunId: identity(data.ownerRunId, 'delegation.ownerRunId'),
    workerRunId: identity(data.workerRunId, 'delegation.workerRunId'), threadId: identity(data.threadId, 'delegation.threadId'), text: data.text,
    ...(data.requestText === undefined ? {} : { requestText: data.requestText as string }),
    alignmentRevision: positive(data.alignmentRevision, 'delegation.alignmentRevision'), criterionIds, ...(context === undefined ? {} : { context }),
    ...(data.planNodeId === undefined ? {} : { planNodeId: identity(data.planNodeId, 'delegation.planNodeId') }) }
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
const attentionKeys = ['inputEpoch', 'operationId', 'intentId', 'hostId', 'supervisorAgentSessionId', 'supervisorRunId', 'occurrenceAt', 'agentMuxNote']
export function parseDemandDelegationAttentionInput(value: unknown): DemandDelegationAttentionInput {
  const data = record(value, 'delegation.attention', attentionKeys, ['inputEpoch'])
  if (typeof data.agentMuxNote !== 'string' || !data.agentMuxNote.trim() || data.agentMuxNote.includes('\0')) throw new Error('attention.agentMuxNote must be a nonempty frozen platform note')
  return { ...optionalDemandInputEpoch(data.inputEpoch), operationId: identity(data.operationId, 'attention.operationId'), intentId: identity(data.intentId, 'attention.intentId'), hostId: identity(data.hostId, 'attention.hostId'),
    supervisorAgentSessionId: identity(data.supervisorAgentSessionId, 'attention.supervisorAgentSessionId'), supervisorRunId: identity(data.supervisorRunId, 'attention.supervisorRunId'),
    occurrenceAt: positive(data.occurrenceAt, 'attention.occurrenceAt'), agentMuxNote: data.agentMuxNote }
}
export function sameDemandDelegationAttention(left: DemandDelegationAttentionInput, right: DemandDelegationAttentionInput): boolean {
  return attentionKeys.every(key => left[key as keyof DemandDelegationAttentionInput] === right[key as keyof DemandDelegationAttentionInput])
}
export function sameDemandDelegationIntent(left: DemandDelegationIntent, right: DemandDelegationIntent): boolean {
  return delegationWorkerHostId(left) === delegationWorkerHostId(right) && intentKeys.filter(key => key !== 'workerHostId')
    .every(key => JSON.stringify(left[key as keyof DemandDelegationIntent]) === JSON.stringify(right[key as keyof DemandDelegationIntent]))
}
export function parseDemandDelegation(value: unknown): DemandDelegation {
  const data = record(value, 'delegation', [...intentKeys, 'preparedAt', 'capturedCriteria', 'linkedAt', 'runtimeIdentity', 'report', 'collection', 'attention', 'predecessors', 'claimOperationId', 'dispatchProof'], ['context', 'requestText', 'planNodeId', 'workerHostId', 'linkedAt', 'runtimeIdentity', 'report', 'collection', 'attention', 'predecessors', 'claimOperationId', 'dispatchProof'])
  const intent = parseDemandDelegationIntent(Object.fromEntries(intentKeys.filter(key => data[key] !== undefined).map(key => [key, data[key]])))
  if (!Array.isArray(data.capturedCriteria)) throw new Error('delegation.capturedCriteria must be an array')
  const capturedCriteria = data.capturedCriteria.map(value => {
    const item = record(value, 'capturedCriterion', ['id', 'text'])
    if (typeof item.text !== 'string' || !item.text.trim()) throw new Error('capturedCriterion.text must be a nonempty string')
    return { id: identity(item.id, 'capturedCriterion.id'), text: item.text }
  })
  if (capturedCriteria.length !== intent.criterionIds.length || new Set(capturedCriteria.map(item => item.id)).size !== capturedCriteria.length ||
    capturedCriteria.some(item => !intent.criterionIds.includes(item.id))) throw new Error('delegation captured standards differ from its original criteria')
  const runtimeIdentity = data.runtimeIdentity === undefined ? undefined : parseDemandDelegationRuntimeIdentity(data.runtimeIdentity)
  if (runtimeIdentity && data.linkedAt === undefined) throw new Error('delegation Runtime identities lack their verified source association')
  let report: DemandDelegationReport | undefined
  if (data.report !== undefined) {
    const item = record(data.report, 'delegation.report', ['operationId', 'replyMessageId', 'authorAgentSessionId', 'grounding', 'submittedAt', 'recovery', 'delivery'], ['recovery', 'delivery'])
    const recovery = item.recovery === undefined ? undefined : record(item.recovery, 'report.recovery', ['collector', 'recoveredAt'])
    report = { ...parseDemandDelegationReportInput({ operationId: item.operationId, replyMessageId: item.replyMessageId, authorAgentSessionId: item.authorAgentSessionId, grounding: item.grounding }),
      submittedAt: positive(item.submittedAt, 'report.submittedAt'),
      ...(item.delivery === undefined ? {} : { delivery: parseGoalDeliveryReceipt(item.delivery) }),
      ...(recovery === undefined ? {} : { recovery: { collector: parseDemandDelegationCollector(recovery.collector), recoveredAt: positive(recovery.recoveredAt, 'report.recovery.recoveredAt') } }) }
    if (report.delivery && (!intent.planNodeId || runtimeIdentity && report.delivery.authorRuntimeId !== runtimeIdentity.workerRuntimeId)) throw new Error('Ticket delivery belongs to another attempt or Runtime')
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
    const item = record(data.attention, 'delegation.attention', [...attentionKeys, 'preparedAt', 'attemptedAt'], ['inputEpoch', 'attemptedAt'])
    attention = { ...parseDemandDelegationAttentionInput(Object.fromEntries(attentionKeys.map(key => [key, item[key]]))), preparedAt: positive(item.preparedAt, 'attention.preparedAt'),
      ...(item.attemptedAt === undefined ? {} : { attemptedAt: positive(item.attemptedAt, 'attention.attemptedAt') }) }
    if (attention.hostId !== intent.hostId || data.linkedAt === undefined) throw new Error('delegation attention lacks its original linked Host')
  }
  const dispatchProof = data.dispatchProof === undefined ? undefined : parseGoalTicketProof(data.dispatchProof)
  if (dispatchProof && (dispatchProof.record.kind !== 'dispatch' || dispatchProof.record.ticketId !== intent.planNodeId ||
      dispatchProof.record.operationId !== intent.operationId || data.claimOperationId !== undefined))
    throw new Error('Goal Ticket dispatch proof belongs to another execution')
  if ((data.predecessors !== undefined || data.claimOperationId !== undefined) && !intent.planNodeId) throw new Error('Goal plan predecessors require an original node')
  return { ...intent, capturedCriteria, ...(dispatchProof ? { dispatchProof } : {}), preparedAt: positive(data.preparedAt, 'delegation.preparedAt'),
    ...(data.predecessors === undefined ? {} : { predecessors: parseGoalPlanPredecessors(data.predecessors) }),
    ...(data.claimOperationId === undefined ? {} : { claimOperationId: identity(data.claimOperationId, 'delegation.claimOperationId') }),
    ...(data.linkedAt === undefined ? {} : { linkedAt: positive(data.linkedAt, 'delegation.linkedAt') }),
    ...(runtimeIdentity ? { runtimeIdentity } : {}),
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
