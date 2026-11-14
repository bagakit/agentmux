import { dequal } from 'dequal'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseAutomaticInputSource, type AutomaticInputSource } from './automatic-input-source.js'
import { agentPromptInputId, agentPromptNotApplied, validateAgentPromptInputKey, type AgentPromptInputKey } from './agent-prompt-condition.js'
import type { AgentPromptSubmissionRecord } from './types.js'

/** Original automatic-input address only; never content, native location or input-control authority. */
export type ContinuousProgressInputReference = {
  inputKey: Extract<AgentPromptInputKey, { kind: 'prompt' }>
  futureIntent: { intentId: string; occurrenceAt: number }
  definitionOperationId: string
  managedSource?: AutomaticInputSource
  preparedAt: number
}
export type ContinuousProgressInputReading = {
  reference: ContinuousProgressInputReference
  /** The original record matched, not a claim that delivery or work succeeded. */
  status: 'confirmed' | 'unconfirmed'
  delivery: 'unconfirmed' | 'not-applied' | 'terminal-confirmed' | 'native-admitted'
  nativeResult: { state: 'unknown' | 'unsupported' } |
    { state: 'completed' | 'failed' | 'interrupted'; observedAt: number; nativeObservedAt?: number }
  returnedIdle?: { state: 'returned-idle'; observedAt: number }
}
const invalid = (code: string): never => { throw new AgentMuxError('The original automatic-input reference or safe reading is invalid.', code) }
const identity = (value: unknown, code: string): string => typeof value === 'string' && !!value.trim() && value.length <= 16384 && !/[\0\r\n]/u.test(value) ? value : invalid(code)
const time = (value: unknown, code: string): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : invalid(code)

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
  if (typeof p.status !== 'string' || !['confirmed', 'unconfirmed'].includes(p.status) || typeof p.delivery !== 'string' || !['unconfirmed', 'not-applied', 'terminal-confirmed', 'native-admitted'].includes(p.delivery)) return invalid(code)
  const native = rpcRecord(p.nativeResult, ['state', 'observedAt', 'nativeObservedAt'], code)
  let nativeResult: ContinuousProgressInputReading['nativeResult']
  if (native.state === 'unknown' || native.state === 'unsupported') {
    if (native.observedAt !== undefined || native.nativeObservedAt !== undefined) return invalid(code)
    nativeResult = { state: native.state }
  } else {
    if (typeof native.state !== 'string' || !['completed', 'failed', 'interrupted'].includes(native.state) || p.delivery !== 'native-admitted') return invalid(code)
    nativeResult = { state: native.state as 'completed' | 'failed' | 'interrupted', observedAt: time(native.observedAt, code),
      ...(native.nativeObservedAt === undefined ? {} : { nativeObservedAt: time(native.nativeObservedAt, code) }) }
  }
  let returnedIdle: ContinuousProgressInputReading['returnedIdle']
  if (p.returnedIdle !== undefined) {
    const idle = rpcRecord(p.returnedIdle, ['state', 'observedAt'], code)
    if (idle.state !== 'returned-idle') return invalid(code)
    returnedIdle = { state: 'returned-idle', observedAt: time(idle.observedAt, code) }
  }
  if (p.status === 'unconfirmed' && (p.delivery !== 'unconfirmed' || nativeResult.state !== 'unknown' || returnedIdle)) return invalid(code)
  return { reference, status: p.status as ContinuousProgressInputReading['status'], delivery: p.delivery as ContinuousProgressInputReading['delivery'], nativeResult,
    ...(returnedIdle ? { returnedIdle } : {}) }
}

/** The original source owner qualifies access before calling. This projection cannot grant that access. */
export function projectContinuousProgressInput(value: ContinuousProgressInputReference, original: AgentPromptSubmissionRecord | null): ContinuousProgressInputReading {
  const reference = parseContinuousProgressInputReference(value), key = reference.inputKey, id = agentPromptInputId(key)
  const unknown: ContinuousProgressInputReading = { reference, status: 'unconfirmed', delivery: 'unconfirmed', nativeResult: { state: 'unknown' } }
  const claim = original?.admission
  if (!original || original.agentSessionId !== key.agentSessionId || original.run.runId !== key.expectedRun.runId ||
      !claim || claim.submissionId !== id || !dequal(claim.inputKey, key) || !dequal(claim.futureIntent, reference.futureIntent)) return unknown
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
  return parseContinuousProgressInputReading({ reference, status: 'confirmed', delivery, nativeResult,
    ...(idle?.state === 'idle' && idle.run.runId === key.expectedRun.runId && idle.promptSubmissionId === id
      ? { returnedIdle: { state: 'returned-idle', observedAt: idle.observedAt } } : {}) }, reference)
}
