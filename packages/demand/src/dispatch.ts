import { parseAlignmentProposal, type DemandCriterion, type DemandGrounding } from './goals.js'
import { parseDemandDelegationAttentionInput, type DemandDelegationAttention } from './delegations.js'
import { demandAgentReferenceKey, parseDemandAgentReference, type DemandSpaceMemberReference } from './agent-reference.js'

/** Business input provenance owned by explicit Goal Start, separate from Run lifecycle. */
export type DemandLegacyDispatchIntent = {
  operationId: string
  agentSessionId: string
  hostId: string
  runId: string
  execution: 'finite' | 'continue'
  prompt: string
  loopId?: string
  alignmentRevision?: number
}
export type DemandQualifiedDispatchIntent = {
  operationId: string
  target: DemandSpaceMemberReference
  runId: string
  execution: 'finite'
  prompt: string
  agentMuxNote?: string
}
export type DemandDispatchIntent = DemandLegacyDispatchIntent | DemandQualifiedDispatchIntent
export type DemandLegacyDispatchReceipt = { kind: 'core-prompt'; itemId: string; createdAt: number }
export type DemandQualifiedDispatchReceipt = { kind: 'core-input'; inputKey: {
  kind: 'prompt'; agentSessionId: string; expectedRun: { runId: string }; submissionId: string
}; outcome: 'admitted' | 'terminal-confirmed'; observedAt: number }
export type DemandDispatchRequest = { operationId: string; target: DemandSpaceMemberReference }
export type DemandDispatchRequestOrigin = { requestedAt: number; goalUpdatedAt: number }
export type DemandDispatchResultBasis = { alignmentRevision: number | null; criteria: DemandCriterion[]; groundingSubmissionId: string | null }
type QualifiedBusinessRequest = DemandDispatchRequest & {
  execution: 'finite'
  runId?: never; preparedAt?: never; submittedAt?: never; agentMuxNote?: never
  receipt?: never; attention?: never; issue?: never
}
export type DemandQualifiedRequested = QualifiedBusinessRequest & {
  stage: 'requested'; prompt: string; request: DemandDispatchRequestOrigin; resultBasis: DemandDispatchResultBasis
}
export type DemandDispatchRejection = {
  kind: 'goal-start-version-conflict'; goalId: string; operationId: string; currentUpdatedAt: number
} | {
  kind: 'goal-start-assignee-conflict'; goalId: string; operationId: string; currentUpdatedAt: number; target: DemandSpaceMemberReference
}
export type DemandQualifiedRejected = QualifiedBusinessRequest & {
  stage: 'rejected'; requestedAt: number; expectedUpdatedAt?: number; observedGoalUpdatedAt: number; rejection: DemandDispatchRejection
  prompt?: never; resultBasis?: never; request?: never
}
type DispatchState<Receipt> = {
  stage: 'prepared' | 'submitted' | 'confirmed' | 'unknown'
  preparedAt: number
  submittedAt?: number
  /** Reference to Core's durable original input fact; client success/activity is insufficient. */
  receipt?: Receipt
  issue?: string
  /** Captured by the original business owner, never declared by a Start client. */
  resultBasis?: DemandDispatchResultBasis
  /** Reference to an existing Core Supervisor input; not an A2A message or queue. */
  attention?: DemandDelegationAttention
}
export type DemandRunBoundDispatch = (DemandLegacyDispatchIntent & DispatchState<DemandLegacyDispatchReceipt>) |
  (DemandQualifiedDispatchIntent & DispatchState<DemandQualifiedDispatchReceipt> & { request?: DemandDispatchRequestOrigin })
export type DemandDispatch = DemandRunBoundDispatch | DemandQualifiedRequested | DemandQualifiedRejected
export function qualifiedDemandDispatch(value: DemandDispatchIntent | DemandDispatch): value is DemandQualifiedDispatchIntent | DemandQualifiedRequested | DemandQualifiedRejected { return 'target' in value }
/** A saved business request or refusal does not supply a Runtime input identity. */
export function runBoundDemandDispatch(value: DemandDispatch): value is DemandRunBoundDispatch { return value.stage !== 'requested' && value.stage !== 'rejected' }

export type GoalStartObservation = {
  operationId: string
  input: { state: 'confirmed' | 'unknown'; reason?: string; retainedReceipt?: DemandDispatch['receipt']; proof?: {
    kind: 'core-prompt'; agentSessionId: string; runId: string; operationId: string; acknowledged: true; prompt: string;
    inputKey: { kind: 'prompt'; agentSessionId: string; expectedRun: { runId: string }; submissionId: string }
  } }
  originalRun?: { runId: string; state: 'running' | 'exited' | 'interrupted' }
  goalResult?: { grounding: DemandGrounding; association: 'unknown'; basis: 'captured' | 'unknown'; changedSinceStart: boolean | null }
  responsibility: 'working' | 'original-worker-continuation' | 'goal-result-review' | 'observation-unknown'
  supervisor?: { agentSessionId: string; hostId: string; runId: string }
  attention?: { state: 'prepared' | 'confirmed' | 'unknown'; reason: string }
  unknown?: string
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label} must be a nonempty string`)
  return value
}
function time(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive timestamp`)
  return value
}
const intentKeys = ['operationId', 'agentSessionId', 'hostId', 'runId', 'execution', 'prompt', 'loopId', 'alignmentRevision']
const qualifiedIntentKeys = ['operationId', 'target', 'runId', 'execution', 'prompt', 'agentMuxNote']
export function parseDemandDispatchRequest(value: unknown): DemandDispatchRequest {
  const input = record(value, 'dispatch request')
  if (Object.keys(input).some(key => key !== 'operationId' && key !== 'target')) throw new Error('dispatch request has unknown fields')
  const target = parseDemandAgentReference(input.target)
  if (typeof target === 'string') throw new Error('dispatch request requires its exact Source member')
  return { operationId: text(input.operationId, 'dispatch.operationId'), target }
}
function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('dispatch Goal version is invalid')
  return value
}
function requestOrigin(value: unknown): DemandDispatchRequestOrigin {
  const input = record(value, 'dispatch.request')
  if (Object.keys(input).some(key => key !== 'requestedAt' && key !== 'goalUpdatedAt')) throw new Error('dispatch.request has unknown fields')
  return { requestedAt: time(input.requestedAt, 'dispatch.requestedAt'), goalUpdatedAt: version(input.goalUpdatedAt) }
}
function parseResultBasis(value: unknown): DemandDispatchResultBasis {
  const basis = record(value, 'dispatch.resultBasis')
  if (Object.keys(basis).some(key => !['alignmentRevision', 'criteria', 'groundingSubmissionId'].includes(key)) ||
      basis.alignmentRevision !== null && (typeof basis.alignmentRevision !== 'number' || !Number.isSafeInteger(basis.alignmentRevision) || basis.alignmentRevision < 1)) throw new Error('dispatch result basis is invalid')
  const criteria = parseAlignmentProposal({ summary: 'Original Start criteria', criteria: basis.criteria, openQuestions: [] }).criteria
  if (basis.alignmentRevision === null && criteria.length) throw new Error('dispatch result basis has no original alignment')
  return { alignmentRevision: basis.alignmentRevision as number | null, criteria,
    groundingSubmissionId: basis.groundingSubmissionId === null ? null : text(basis.groundingSubmissionId, 'dispatch.resultBasis.groundingSubmissionId') }
}
export function parseDemandDispatchIntent(value: unknown): DemandDispatchIntent {
  const input = record(value, 'dispatch')
  if (Object.hasOwn(input, 'target')) {
    if (Object.keys(input).some(key => !qualifiedIntentKeys.includes(key)) || input.execution !== 'finite') throw new Error('Source-qualified dispatch requires only its original finite target and input')
    const target = parseDemandAgentReference(input.target)
    if (typeof target === 'string') throw new Error('Source-qualified dispatch requires its complete original member')
    return { operationId: text(input.operationId, 'dispatch.operationId'), target, runId: text(input.runId, 'dispatch.runId'), execution: 'finite',
      prompt: text(input.prompt, 'dispatch.prompt'), ...(input.agentMuxNote === undefined ? {} : { agentMuxNote: typeof input.agentMuxNote === 'string' ? input.agentMuxNote : (() => { throw new Error('dispatch.agentMuxNote must remain a string') })() }) }
  }
  if (Object.keys(input).some(key => !intentKeys.includes(key))) throw new Error('dispatch has unknown fields')
  if (input.execution !== 'finite' && input.execution !== 'continue') throw new Error('dispatch execution is invalid')
  if (input.execution === 'continue' && (input.loopId === undefined || input.alignmentRevision === undefined) || input.execution === 'finite' && (input.loopId !== undefined || input.alignmentRevision !== undefined)) throw new Error('dispatch continuation reference is inconsistent')
  if (input.alignmentRevision !== undefined && (typeof input.alignmentRevision !== 'number' || !Number.isSafeInteger(input.alignmentRevision) || input.alignmentRevision < 1)) throw new Error('dispatch alignment revision is invalid')
  return { operationId: text(input.operationId, 'dispatch.operationId'), agentSessionId: text(input.agentSessionId, 'dispatch.agentSessionId'),
    hostId: text(input.hostId, 'dispatch.hostId'), runId: text(input.runId, 'dispatch.runId'), execution: input.execution,
    prompt: text(input.prompt, 'dispatch.prompt'), ...(input.loopId === undefined ? {} : { loopId: text(input.loopId, 'dispatch.loopId') }),
    ...(input.alignmentRevision === undefined ? {} : { alignmentRevision: input.alignmentRevision as number }) }
}
export function parseDemandDispatch(value: unknown, goalId?: string): DemandDispatch {
  const input = record(value, 'dispatch')
  if (input.stage === 'requested' || input.stage === 'rejected') {
    const base = parseDemandDispatchRequest({ operationId: input.operationId, target: input.target })
    if (input.execution !== 'finite') throw new Error('dispatch request requires finite execution')
    if (input.stage === 'requested') {
      if (Object.keys(input).some(key => !['stage', 'operationId', 'target', 'execution', 'prompt', 'request', 'resultBasis'].includes(key))) throw new Error('requested dispatch has unknown fields')
      return { ...base, execution: 'finite', stage: 'requested', prompt: text(input.prompt, 'dispatch.prompt'), request: requestOrigin(input.request), resultBasis: parseResultBasis(input.resultBasis) }
    }
    if (Object.keys(input).some(key => !['stage', 'operationId', 'target', 'execution', 'requestedAt', 'expectedUpdatedAt', 'observedGoalUpdatedAt', 'rejection'].includes(key))) throw new Error('rejected dispatch has unknown fields')
    const observed = version(input.observedGoalUpdatedAt), expected = input.expectedUpdatedAt === undefined ? undefined : version(input.expectedUpdatedAt)
    const refusal = record(input.rejection, 'dispatch.rejection'), owner = text(refusal.goalId, 'dispatch.rejection.goalId')
    if (goalId !== undefined && owner !== goalId || refusal.operationId !== base.operationId || version(refusal.currentUpdatedAt) !== observed) throw new Error('dispatch rejection belongs to another original Goal, OP or version')
    let rejection: DemandDispatchRejection
    if (refusal.kind === 'goal-start-version-conflict') {
      if (Object.keys(refusal).some(key => !['kind', 'goalId', 'operationId', 'currentUpdatedAt'].includes(key)) || expected === undefined || expected === observed) throw new Error('dispatch version rejection is inconsistent')
      rejection = { kind: refusal.kind, goalId: owner, operationId: base.operationId, currentUpdatedAt: observed }
    } else if (refusal.kind === 'goal-start-assignee-conflict') {
      if (Object.keys(refusal).some(key => !['kind', 'goalId', 'operationId', 'currentUpdatedAt', 'target'].includes(key))) throw new Error('dispatch assignee rejection has unknown fields')
      const target = parseDemandAgentReference(refusal.target)
      if (typeof target === 'string' || demandAgentReferenceKey(target) !== demandAgentReferenceKey(base.target)) throw new Error('dispatch rejection names another original member')
      rejection = { kind: refusal.kind, goalId: owner, operationId: base.operationId, currentUpdatedAt: observed, target }
    } else throw new Error('dispatch rejection kind is invalid')
    return { ...base, execution: 'finite', stage: 'rejected', requestedAt: time(input.requestedAt, 'dispatch.requestedAt'), observedGoalUpdatedAt: observed,
      ...(expected === undefined ? {} : { expectedUpdatedAt: expected }), rejection }
  }
  const keys = Object.hasOwn(input, 'target') ? qualifiedIntentKeys : intentKeys
  if (Object.keys(input).some(key => ![...keys, 'stage', 'preparedAt', 'submittedAt', 'receipt', 'issue', 'resultBasis', 'attention', ...(Object.hasOwn(input, 'target') ? ['request'] : [])].includes(key))) throw new Error('dispatch has unknown fields')
  const intent = parseDemandDispatchIntent(Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]])))
  if (!['prepared', 'submitted', 'confirmed', 'unknown'].includes(String(input.stage))) throw new Error('dispatch stage is invalid')
  if ((input.stage === 'confirmed') !== (input.receipt !== undefined) || (input.stage !== 'prepared' && input.submittedAt === undefined)) throw new Error('dispatch stage lacks its original evidence')
  let receipt: DemandDispatch['receipt']
  if (input.receipt !== undefined) {
    const native = record(input.receipt, 'dispatch.receipt')
    if (qualifiedDemandDispatch(intent)) {
      const key = record(native.inputKey, 'dispatch.receipt.inputKey'), run = record(key.expectedRun, 'dispatch.receipt.expectedRun')
      if (Object.keys(native).some(key => !['kind', 'inputKey', 'outcome', 'observedAt'].includes(key)) || native.kind !== 'core-input' ||
        Object.keys(key).some(key => !['kind', 'agentSessionId', 'expectedRun', 'submissionId'].includes(key)) || Object.keys(run).some(key => key !== 'runId') ||
        key.kind !== 'prompt' || key.agentSessionId !== intent.target.execution.agentSessionId || run.runId !== intent.runId || key.submissionId !== intent.operationId ||
        native.outcome !== 'admitted' && native.outcome !== 'terminal-confirmed') throw new Error('Source-qualified dispatch receipt belongs to another original input')
      receipt = { kind: 'core-input', inputKey: { kind: 'prompt', agentSessionId: intent.target.execution.agentSessionId, expectedRun: { runId: intent.runId }, submissionId: intent.operationId },
        outcome: native.outcome, observedAt: time(native.observedAt, 'dispatch.receipt.observedAt') }
    } else {
      if (Object.keys(native).some(key => !['kind', 'itemId', 'createdAt'].includes(key)) || native.kind !== 'core-prompt' || native.itemId !== `prompt:${intent.operationId}`) throw new Error('dispatch receipt belongs to another input')
      receipt = { kind: 'core-prompt', itemId: native.itemId, createdAt: time(native.createdAt, 'dispatch.receipt.createdAt') }
    }
  }
  let resultBasis: DemandDispatch['resultBasis'], attention: DemandDispatch['attention']
  if (input.resultBasis !== undefined) resultBasis = parseResultBasis(input.resultBasis)
  if (input.attention !== undefined) {
    if (qualifiedDemandDispatch(intent)) throw new Error('Source-qualified finite input does not grant automatic Supervisor attention')
    const notice = record(input.attention, 'dispatch.attention'), { preparedAt, attemptedAt, ...attentionIntent } = notice
    attention = { ...parseDemandDelegationAttentionInput(attentionIntent), preparedAt: time(preparedAt, 'dispatch.attention.preparedAt'),
      ...(attemptedAt === undefined ? {} : { attemptedAt: time(attemptedAt, 'dispatch.attention.attemptedAt') }) }
    if (input.execution !== 'finite' || attention.hostId !== input.hostId) throw new Error('dispatch attention belongs to another Start or Host')
  }
  const state = { stage: input.stage as DemandRunBoundDispatch['stage'], preparedAt: time(input.preparedAt, 'dispatch.preparedAt'),
    ...(input.submittedAt === undefined ? {} : { submittedAt: time(input.submittedAt, 'dispatch.submittedAt') }),
    ...(input.issue === undefined ? {} : { issue: text(input.issue, 'dispatch.issue') }),
    ...(resultBasis === undefined ? {} : { resultBasis }), ...(attention === undefined ? {} : { attention }) }
  if (qualifiedDemandDispatch(intent)) {
    if (receipt && receipt.kind !== 'core-input') throw new Error('Source-qualified receipt kind changed')
    return { ...intent, ...state, ...(receipt ? { receipt } : {}), ...(input.request === undefined ? {} : { request: requestOrigin(input.request) }) }
  }
  if (receipt && receipt.kind !== 'core-prompt') throw new Error('Original legacy receipt kind changed')
  return { ...intent, ...state, ...(receipt ? { receipt } : {}) }
}
export function parseDemandDispatches(value: unknown, goalId?: string): DemandDispatch[] {
  if (!Array.isArray(value)) throw new Error('dispatches must be an array')
  const dispatches = value.map(item => parseDemandDispatch(item, goalId))
  if (new Set(dispatches.map(item => item.operationId)).size !== dispatches.length) throw new Error('dispatches contain duplicate original operations')
  const notices = dispatches.flatMap(item => item.attention ? [item.attention] : [])
  if (new Set(notices.map(item => item.operationId)).size !== notices.length || new Set(notices.map(item => item.intentId)).size !== notices.length)
    throw new Error('dispatch attention contains duplicate original inputs')
  return dispatches
}
export function sameDemandDispatchIntent(left: DemandDispatchIntent, right: DemandDispatchIntent): boolean {
  if (qualifiedDemandDispatch(left) || qualifiedDemandDispatch(right)) return qualifiedDemandDispatch(left) && qualifiedDemandDispatch(right) &&
    left.operationId === right.operationId && demandAgentReferenceKey(left.target) === demandAgentReferenceKey(right.target) && left.runId === right.runId &&
    left.execution === right.execution && left.prompt === right.prompt && left.agentMuxNote === right.agentMuxNote
  return intentKeys.every(key => left[key as keyof DemandLegacyDispatchIntent] === right[key as keyof DemandLegacyDispatchIntent])
}
