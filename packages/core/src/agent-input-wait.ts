import { AgentMuxError } from './errors.js'
import { agentPromptNotApplied, agentPromptInputId, validateAgentPromptInputKey, type AgentPromptInputKey } from './agent-prompt-condition.js'
import type { AgentNativeBinding, AgentNativeSessionHandle, AgentOperationDevice, AgentMessageChannel, AgentPromptSubmissionRecord } from './types.js'

/** In-process Host context, never a wire argument or a persisted grant. */
export type AgentInputCallContext = Readonly<{
  /** Trusted Host capture attribution, never accepted from public business arguments. */
  inputContextSource?: import('./browser-input-context.js').BrowserInputContextSource
  captureReader?: import('./agent-input-context-capture.js').AgentInputContextCaptureReader
  /** Ends semantic intake until Core accepts its waiting owner, or raw observation before native dispatch. */
  requestSignal?: AbortSignal
  /** Trusted Host author owner; identity is attribution, while this callback checks current authority. */
  externalAuthor?: { identity: import('./external-author.js').AgentExternalMessageAuthor; assertCurrent(intent: import('./external-author.js').AgentExternalInputIntent): void | Promise<void> }
  externalAction?: { identity: import('./external-author.js').AgentExternalInteractionAuthor; assertCurrent(intent: import('./client.js').AgentMuxAgentInteractionInput): void | Promise<void> }
  externalQuestion?: { identity: import('./external-author.js').AgentExternalInteractionAuthor; assertCurrent(intent: import('./client.js').AgentMuxSessionQuestionReplyInput): void | Promise<void> }
  /** Restricts the original action using its current author owner; cannot mint authority. */
  assertCurrent?(): void | Promise<void>
  /** Automatic producers may forbid steering; this restriction grants no input authority. */
  nativeIdleOnly?: true
}>

/** Original Host restriction for raw bytes, valid only before native dispatch.
 * A lost reply after dispatch never cancels or replays the original operation. */
export type AgentRawInputCallContext = Pick<AgentInputCallContext, 'requestSignal' | 'assertCurrent'>

/** Original input identity, waiting generation and stop action are distinct. */
export type AgentInputWaitRef = { key: AgentPromptInputKey; waitGeneration: number }
export type AgentInputSelector = { key: AgentPromptInputKey } | { kind: 'message-control'; originalControlOperationId: string }
export type AgentInputWaitReason =
  | { phase: 'runtime'; reason: 'runtime-unavailable'; wake: 'runtime-restored'; failure?: import('./delivery-attempt.js').DeliveryFailure }
  | { phase: 'session'; reason: 'session-resume-needed'; wake: 'session-restored'; failure?: import('./delivery-attempt.js').DeliveryFailure }
  | { phase: 'authorization'; reason: 'author-authorization-needed'; wake: 'explicit-rejoin'; failure?: import('./delivery-attempt.js').DeliveryFailure }
  | { phase: 'observer'; reason: 'observer-stopped'; wake: 'explicit-rejoin'; failure: import('./delivery-attempt.js').DeliveryFailure; observation?: { phase: string } }
  | { phase: 'native-environment'; reason: 'original-environment-unconfirmed' | 'original-target-changed'; wake: 'explicit-rejoin';
      mechanism?: 'unconfirmed' | 'unavailable'; observation?: { phase: string; failure: import('./delivery-attempt.js').DeliveryFailure } }
  | { phase: 'input-environment'; reason: 'original-input-unconfirmed' | 'original-target-changed'; wake: 'explicit-rejoin'; failure: import('./delivery-attempt.js').DeliveryFailure; observation?: { phase: string } }
  | { phase: 'service'; reason: 'observation-failed'; wake: 'explicit-rejoin' | 'session-restored'; failure: import('./delivery-attempt.js').DeliveryFailure; observation?: { phase: string } }

/** Provider/executor identify the original target; Native locators are retained observations, not a terminal input gate. */
export type AgentInputSavedEnvironment = {
  providerId: string
  executorId: string
  nativeHandle?: AgentNativeSessionHandle
  nativeBinding?: Pick<AgentNativeBinding, 'source' | 'run'>
}
export type AgentInputJournalIntent = {
  key: AgentPromptInputKey
  admissionIntent: Exclude<import('./agent-prompt-condition.js').AgentPromptAdmissionIntent, { kind: 'exact-condition' }>
  execution: 'immediate'
  environment: AgentInputSavedEnvironment
  source:
    | { kind: 'prompt'; prompt: string; agentMuxNote?: string; authorHuman?: boolean; sourceChannel?: AgentMessageChannel; sourceDevice?: AgentOperationDevice;
        /** Original Core intake confirmed local human authority without an invocation-local restrictor. */
        recoveryAuthorization?: 'local-human';
        inputContext?: import('./browser-input-context.js').BrowserInputContext; inputContextSource?: import('./browser-input-context.js').BrowserInputContextSource;
        inputContextCaptureProof?: import('./agent-input-context-capture.js').AgentInputContextCaptureProof;
        /** Wire frozen at first intake, before waiting or Provider preparation. */
        promptWire?: string }
    | { kind: 'message'; messageId: string; originalControlOperationId: string;
        /** Original quote wire, frozen at the first journal save before waiting. */
        promptWire?: string }
}
export type AgentInputDispatchLink = { ref: AgentInputWaitRef; gateId: string; deliveryKey?: AgentPromptInputKey }
export type AgentInputJournalEntry = { sequence: number; recordedAt: number; intent: AgentInputJournalIntent; control: AgentInputWaitControl }
export type AgentInputWaitControl = {
  ref: AgentInputWaitRef
  state: 'enabled' | 'stopped-before-dispatch' | 'dispatch-authorized'
  at: number
  waiting?: AgentInputWaitReason
  gateId?: string
  /** Frozen only by the original dispatch gate after confirmed same-Session recovery. */
  deliveryKey?: AgentPromptInputKey
}

/** The original journal identity survives an unclaimed input's first delivery to a resumed Run. */
export function agentInputDeliveryKey(value: Pick<AgentInputWaitControl, 'ref' | 'deliveryKey'>): AgentPromptInputKey {
  return value.deliveryKey ?? value.ref.key
}

/** A delivery binding changes only the executing Run, never the original producer or logical input. */
export function validateAgentInputDeliveryKey(originalValue: AgentPromptInputKey, value: unknown): AgentPromptInputKey {
  const original = validateAgentPromptInputKey(originalValue), key = validateAgentPromptInputKey(value)
  if (original.kind !== key.kind || original.agentSessionId !== key.agentSessionId ||
      agentPromptInputId(original) !== agentPromptInputId(key) || original.expectedRun.runId === key.expectedRun.runId) throw new AgentMuxError(
    'A resumed input delivery must retain its original Session, producer and logical identity.', 'INVALID_AGENT_INPUT_CONTROL')
  return key
}
export type AgentInputWaitStopReceipt = {
  ref: AgentInputWaitRef
  cancelOperationId: string
  outcome: 'stopped-before-dispatch' | 'observation-stopped' | 'already-settled' | 'stale-generation'
  at: number
}
/** Admission is a projection of the original Session owner, never journal outcome. */
export type AgentInputSubmissionReceipt = {
  key: AgentPromptInputKey
  ref: AgentInputWaitRef
  originalControlOperationId?: string
  persistence: 'confirmed'
  control: AgentInputWaitControl
  admission: AgentPromptSubmissionRecord | null
  status: 'waiting' | 'stopped' | 'terminal-confirmed' | 'admitted' | 'not-applied' | 'unknown'
  observation: 'owned' | 'rejoin-needed' | 'closed'
}
/** Interpret the original owner receipt once for SDK and strict wire decoding.
 * A linked terminal ACK confirms ordered input bytes, never Native acceptance. */
export function agentInputSubmissionStatus(control: AgentInputWaitControl, admission: AgentPromptSubmissionRecord | null): AgentInputSubmissionReceipt['status'] {
  const claim = admission?.admission
  const deliveryKey = agentInputDeliveryKey(control)
  const linkedKey = claim?.inputDispatch && agentInputDeliveryKey(claim.inputDispatch)
  const linked = claim?.inputDispatch && control.state === 'dispatch-authorized' &&
    claim.inputDispatch.ref.waitGeneration === control.ref.waitGeneration &&
    claim.inputDispatch.ref.key.kind === control.ref.key.kind &&
    claim.inputDispatch.ref.key.agentSessionId === control.ref.key.agentSessionId &&
    claim.inputDispatch.ref.key.expectedRun.runId === control.ref.key.expectedRun.runId &&
    agentPromptInputId(claim.inputDispatch.ref.key) === agentPromptInputId(control.ref.key) && claim.inputDispatch.gateId === control.gateId &&
    linkedKey?.kind === deliveryKey.kind && linkedKey.agentSessionId === deliveryKey.agentSessionId &&
    linkedKey.expectedRun.runId === deliveryKey.expectedRun.runId && agentPromptInputId(linkedKey) === agentPromptInputId(deliveryKey) &&
    claim.inputKey?.kind === deliveryKey.kind && claim.inputKey.agentSessionId === deliveryKey.agentSessionId &&
    claim.inputKey.expectedRun.runId === deliveryKey.expectedRun.runId &&
    agentPromptInputId(claim.inputKey) === agentPromptInputId(deliveryKey)
  if (linked && claim) {
    if (claim.transport === 'native') return claim.native.outcome === 'admitted' && claim.acknowledged ? 'admitted'
      : claim.native.outcome === 'not-applied' && claim.notApplied ? 'not-applied' : 'unknown'
    const phases = admission?.terminalPromptSubmission, plan = claim.intent?.plan
    const first = phases?.prepare?.interrupt ?? phases?.payload
    const byteLength = (data: string) => new TextEncoder().encode(data).byteLength
    const confirmedBytes = !phases
      ? plan?.kind === 'single-phase' && claim.endByte - claim.startByte === byteLength(plan.data)
      : plan?.kind === 'render-then-submit' && phases.run.runId === admission?.run.runId &&
        phases.submissionId === claim.submissionId && first?.operationId === claim.operationId &&
        first.inputByteRange.startByte === claim.startByte && phases.submit.inputByteRange.endByte === claim.endByte &&
        phases.payload.inputByteRange.endByte === phases.submit.inputByteRange.startByte &&
        phases.payload.inputByteRange.endByte - phases.payload.inputByteRange.startByte === byteLength(plan.payload) &&
        phases.submit.inputByteRange.endByte - phases.submit.inputByteRange.startByte === byteLength(plan.submit) &&
        (!phases.prepare?.interrupt || plan.prepare && phases.prepare.interrupt.acknowledged &&
          phases.prepare.interrupt.inputByteRange.endByte === phases.payload.inputByteRange.startByte &&
          phases.prepare.interrupt.inputByteRange.endByte - phases.prepare.interrupt.inputByteRange.startByte === byteLength(plan.prepare.interrupt)) &&
        phases.payload.acknowledged && phases.submit.acknowledged
    if (claim.acknowledged && !claim.notApplied && confirmedBytes) return 'terminal-confirmed'
    if (admission && agentPromptNotApplied({ run: admission.run, promptCompletionAdmission: claim,
      ...(phases ? { terminalPromptSubmission: phases } : {}) })) return 'not-applied'
    return 'unknown'
  }
  return admission || control.state === 'dispatch-authorized' ? 'unknown'
    : control.state === 'stopped-before-dispatch' ? 'stopped' : 'waiting'
}
export type AgentInputWaitJournalRecord =
  | { kind: 'input-intent'; sequence: number; intent: AgentInputJournalIntent; at: number }
  /** An original accepted claim, without controlled waiting or dispatch authority. */
  | { kind: 'input-submission'; sequence: number; key: AgentPromptInputKey; at: number }
  | { kind: 'input-control'; sequence: number; control: AgentInputWaitControl }
  | { kind: 'input-stop'; sequence: number; receipt: AgentInputWaitStopReceipt }

/** Producer kind cannot give a second writer the same original logical ID. */
export function agentInputJournalKey(key: AgentPromptInputKey): string {
  const original = validateAgentPromptInputKey(key)
  return JSON.stringify([original.agentSessionId, original.expectedRun.runId, agentPromptInputId(original)])
}
export function validateAgentInputWaitRef(value: unknown): AgentInputWaitRef {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'key' && k !== 'waitGeneration')) {
    throw new AgentMuxError('The original input waiting reference is invalid.', 'INVALID_AGENT_INPUT_CONTROL')
  }
  const ref = value as AgentInputWaitRef
  if (!Number.isSafeInteger(ref.waitGeneration) || ref.waitGeneration < 1) throw new AgentMuxError(
    'The original input waiting generation is invalid.', 'INVALID_AGENT_INPUT_CONTROL')
  return { key: validateAgentPromptInputKey(ref.key), waitGeneration: ref.waitGeneration }
}
export function validateAgentInputControlId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).byteLength > 512 || /[\0\r\n]/u.test(value)) {
    throw new AgentMuxError('The original input control identity is invalid.', 'INVALID_AGENT_INPUT_CONTROL')
  }
  return value
}
