import { dequal } from 'dequal'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseAutomaticInputSource, sameAutomaticInputSource, type AutomaticInputSource } from './automatic-input-source.js'
import { agentPromptInputId, agentPromptNotApplied, optionalInputEpoch, validateAgentPromptInputKey, type AgentPromptInputKey } from './agent-prompt-condition.js'
import type { AgentFuturePromptIntent, AgentPromptSubmissionRecord } from './types.js'

/** Original automatic-input address only; never content, native location or input-control authority. */
export type ContinuousProgressInputReference = {
  inputKey: Extract<AgentPromptInputKey, { kind: 'prompt' }>
  futureIntent: { intentId: string; occurrenceAt: number }
  definitionOperationId: string
  managedSource?: AutomaticInputSource
  preparedAt: number
}
export type ContinuousProgressInputFacts = {
  delivery: 'unconfirmed' | 'not-applied' | 'terminal-confirmed' | 'native-admitted'
  nativeResult: { state: 'unknown' } | { state: 'unsupported' } |
    { state: 'completed' | 'failed' | 'interrupted'; observedAt: number; nativeObservedAt?: number }
  returnedIdle?: { state: 'returned-idle'; observedAt: number }
}
export type ContinuousProgressInputReading = ContinuousProgressInputFacts & {
  reference: ContinuousProgressInputReference
  /** The original record matched, not a claim that delivery or work succeeded. */
  status: 'confirmed' | 'unconfirmed'
}

export type ScheduledInputRecoverySource = {
  reference: ContinuousProgressInputReference
  providerId: string
  workspacePath: string
  inputEpoch?: string
}

/** On a committed Session snapshot, a different Run fences the original
 * producer. The future-intent watermark and exact admission must both agree. */
export function supersededInputWasUnclaimed(source: ScheduledInputRecoverySource,
  session: Pick<import('./types.js').AgentMuxStoredAgentSession, 'agentSessionId' | 'providerId' | 'workspacePath' | 'run' | 'retiredRuns' | 'inputEpoch'> | null,
  intent: AgentFuturePromptIntent | null, admission: AgentPromptSubmissionRecord | null): boolean {
  const { inputKey, futureIntent, managedSource, definitionOperationId } = source.reference
  return !!session && session.agentSessionId === inputKey.agentSessionId && session.providerId === source.providerId &&
    session.workspacePath === source.workspacePath && session.inputEpoch === source.inputEpoch && session.run.runId !== inputKey.expectedRun.runId &&
    session.retiredRuns.some(run => run.runId === inputKey.expectedRun.runId) &&
    !admission && !!intent?.active && intent.operationId === definitionOperationId && sameAutomaticInputSource(intent.continuitySource, managedSource) &&
    (intent.lastOccurrenceAt === undefined || intent.lastOccurrenceAt < futureIntent.occurrenceAt)
}

/** Compare the original claim with one owner-qualified frozen definition. */
export function matchesScheduledInputSource(reference: Omit<ContinuousProgressInputReference, 'preparedAt'>,
  record: AgentPromptSubmissionRecord | null, intent: AgentFuturePromptIntent | null): boolean {
  const key = reference.inputKey, admission = record?.admission, message = admission?.intent?.message
  return !!record && record.agentSessionId === key.agentSessionId && dequal(record.run, key.expectedRun) &&
    dequal(admission?.inputKey, key) && admission?.submissionId === agentPromptInputId(key) &&
    dequal(admission.futureIntent, reference.futureIntent) && dequal(admission.intent?.run, key.expectedRun) &&
    !!intent && intent.operationId === reference.definitionOperationId && sameAutomaticInputSource(intent.continuitySource, reference.managedSource) &&
    !!message && message.userContent === intent.message.userContent && message.systemContext === intent.message.systemContext
}
const invalid = (code: string): never => { throw new AgentMuxError('The original automatic-input reference or safe reading is invalid.', code) }
const identity = (value: unknown, code: string): string => typeof value === 'string' && !!value.trim() && value.length <= 16384 && !/[\0\r\n]/u.test(value) ? value : invalid(code)
const time = (value: unknown, code: string): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : invalid(code)

export function parseScheduledInputRecoverySource(value: unknown): ScheduledInputRecoverySource {
  const code = 'INVALID_CONTROL_REQUEST'
  const source = rpcRecord(value, ['reference', 'providerId', 'workspacePath', 'inputEpoch'], code)
  return { reference: parseContinuousProgressInputReference(source.reference, code), providerId: identity(source.providerId, code),
    workspacePath: identity(source.workspacePath, code), ...optionalInputEpoch(source.inputEpoch) }
}

export function parseContinuousProgressInputReference(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): ContinuousProgressInputReference {
  const p = rpcRecord(value, ['inputKey', 'futureIntent', 'definitionOperationId', 'managedSource', 'preparedAt'], code)
  const raw = rpcRecord(p.inputKey, ['kind', 'agentSessionId', 'expectedRun', 'submissionId', 'attemptId'], code)
  rpcRecord(raw.expectedRun, ['runId'], code)
  let key: AgentPromptInputKey
  try { key = validateAgentPromptInputKey(raw) } catch { return invalid(code) }
  if (key.kind !== 'prompt') return invalid(code)
  const future = rpcRecord(p.futureIntent, ['intentId', 'occurrenceAt'], code)
  return { inputKey: key, futureIntent: { intentId: identity(future.intentId, code), occurrenceAt: time(future.occurrenceAt, code) },
    definitionOperationId: identity(p.definitionOperationId, code), preparedAt: time(p.preparedAt, code),
    ...(p.managedSource === undefined ? {} : { managedSource: parseAutomaticInputSource(p.managedSource) }) }
}

export function parseContinuousProgressInputReading(value: unknown, expectedReference?: ContinuousProgressInputReference): ContinuousProgressInputReading {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['reference', 'status', 'delivery', 'nativeResult', 'returnedIdle'], code)
  const reference = parseContinuousProgressInputReference(p.reference, code)
  if (expectedReference && !dequal(reference, parseContinuousProgressInputReference(expectedReference))) return invalid(code)
  if (p.status !== 'confirmed' && p.status !== 'unconfirmed') return invalid(code)
  const { delivery, nativeResult } = parseContinuousProgressDelivery(p.delivery, p.nativeResult)
  let returnedIdle: ContinuousProgressInputReading['returnedIdle']
  if (p.returnedIdle !== undefined) {
    const idle = rpcRecord(p.returnedIdle, ['state', 'observedAt'], code)
    if (idle.state !== 'returned-idle') return invalid(code)
    returnedIdle = { state: 'returned-idle', observedAt: time(idle.observedAt, code) }
  }
  if (p.status === 'unconfirmed' && (delivery !== 'unconfirmed' || nativeResult.state !== 'unknown' || returnedIdle)) return invalid(code)
  return { reference, status: p.status, delivery, nativeResult, ...(returnedIdle ? { returnedIdle } : {}) }
}

export function parseContinuousProgressOutcome(delivery: unknown, state: unknown): { delivery: ContinuousProgressInputFacts['delivery']; nativeState: ContinuousProgressInputFacts['nativeResult']['state'] } {
  const code = 'CONTROL_PROTOCOL_ERROR'
  if (delivery !== 'unconfirmed' && delivery !== 'not-applied' && delivery !== 'terminal-confirmed' && delivery !== 'native-admitted') return invalid(code)
  if (state !== 'unknown' && state !== 'unsupported' &&
      (delivery !== 'native-admitted' || state !== 'completed' && state !== 'failed' && state !== 'interrupted')) return invalid(code)
  return { delivery, nativeState: state }
}

export function parseContinuousProgressDelivery(rawDelivery: unknown, result: unknown): Pick<ContinuousProgressInputFacts, 'delivery' | 'nativeResult'> {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const native = rpcRecord(result, ['state', 'observedAt', 'nativeObservedAt'], code)
  const { delivery, nativeState } = parseContinuousProgressOutcome(rawDelivery, native.state)
  let nativeResult: ContinuousProgressInputReading['nativeResult']
  if (nativeState === 'unknown' || nativeState === 'unsupported') {
    if (native.observedAt !== undefined || native.nativeObservedAt !== undefined) return invalid(code)
    nativeResult = { state: nativeState }
  } else {
    nativeResult = { state: nativeState, observedAt: time(native.observedAt, code),
      ...(native.nativeObservedAt === undefined ? {} : { nativeObservedAt: time(native.nativeObservedAt, code) }) }
  }
  return { delivery, nativeResult }
}

/** The original source owner qualifies access before calling. This projection cannot grant that access. */
export function projectContinuousProgressInput(value: ContinuousProgressInputReference, original: AgentPromptSubmissionRecord | null): ContinuousProgressInputReading {
  const reference = parseContinuousProgressInputReference(value), key = reference.inputKey, id = agentPromptInputId(key)
  const unknown: ContinuousProgressInputReading = { reference, status: 'unconfirmed', delivery: 'unconfirmed', nativeResult: { state: 'unknown' } }
  const claim = original?.admission
  if (!original || original.agentSessionId !== key.agentSessionId || original.run.runId !== key.expectedRun.runId ||
      !claim || claim.submissionId !== id || !dequal(claim.inputKey, key) || !dequal(claim.futureIntent, reference.futureIntent)) return unknown
  return parseContinuousProgressInputReading({ reference, status: 'confirmed', ...projectContinuousProgressInputFacts(original, claim, key) }, reference)
}

/** Safe receipt fields for an already source-qualified persisted input. */
export function projectContinuousProgressInputFacts(original: AgentPromptSubmissionRecord, claim: NonNullable<AgentPromptSubmissionRecord['admission']>,
  key: ContinuousProgressInputReference['inputKey']): ContinuousProgressInputFacts {
  const id = agentPromptInputId(key)
  let delivery: ContinuousProgressInputReading['delivery'] = 'unconfirmed'
  if (agentPromptNotApplied({ run: original.run, promptCompletionAdmission: claim,
    ...(original.terminalPromptSubmission ? { terminalPromptSubmission: original.terminalPromptSubmission } : {}) })) delivery = 'not-applied'
  else if (claim.transport === 'native' && claim.acknowledged && claim.native.outcome === 'admitted') delivery = 'native-admitted'
  else if (claim.transport !== 'native' && claim.transport !== 'launch' && (claim.acknowledged ||
      original.terminalPromptSubmission?.submissionId === id && original.terminalPromptSubmission.submit.acknowledged)) delivery = 'terminal-confirmed'
  let nativeResult: ContinuousProgressInputReading['nativeResult'] = { state: 'unknown' }
  const result = original.nativeResult
  if (result?.state === 'unsupported') nativeResult = { state: 'unsupported' }
  else if (result && ['completed', 'failed', 'interrupted'].includes(result.state) && 'run' in result && delivery === 'native-admitted' &&
      result.run.runId === key.expectedRun.runId && result.promptSubmissionId === id)
    nativeResult = { state: result.state, observedAt: result.observedAt,
      ...(result.nativeObservedAt === undefined ? {} : { nativeObservedAt: result.nativeObservedAt }) }
  const idle = original.semanticIdle
  return { delivery, nativeResult,
    ...(idle?.state === 'idle' && idle.run.runId === key.expectedRun.runId && idle.promptSubmissionId === id
      ? { returnedIdle: { state: 'returned-idle', observedAt: idle.observedAt } } : {}) }
}
