import { agentPromptLogicalInputId, type AgentPromptInputKey } from '@agentmux/conversation/records'
export { agentPromptInputId, agentPromptLogicalInputId, type AgentPromptInputKey } from '@agentmux/conversation/records'
import { AgentMuxError } from './errors.js'
import type { AgentLaunchPromptInputPlan, AgentMuxAgentSession, AgentMuxRunRef } from './types.js'
import { normalizeNativeSessionId, normalizeNativeTranscriptPath } from './agent-native-locator.js'
import type { AgentMuxHostedAgentSessionSummary } from './hosted-session-summary.js'

/** Capture once before the first possibly executing RPC; retain with the sending intent. */
export type AgentPromptCondition = {
  expectedRun: AgentMuxRunRef
  afterSubmissionId: string | null
  /** Captured with the original request; never renewed on reconnect or retry. */
  inputEpoch?: string
}

/** Host intake binding: explicit new manual input or the original exact condition. */
export type AgentPromptInputBinding = AgentPromptCondition |
  { expectedRun: AgentMuxRunRef; inputEpoch?: string; admissionIntent: AgentDirectedPromptTarget; afterSubmissionId?: never }

/** An explicit selected native source is independent of the TUI's current editor/selection. */
export type AgentDirectedPromptTarget = { kind: 'manual-actor' } | { kind: 'session-conversation' } |
  { kind: 'native-conversation'; source: { providerId: string; nativeSessionId: string }; expectedTurnId?: string }

export function validateAgentPromptInputBinding(value: unknown): AgentPromptInputBinding {
  const input = value as AgentPromptInputBinding | undefined
  if (input && 'admissionIntent' in input) {
    if (Object.keys(input).some(key => !['expectedRun', 'inputEpoch', 'admissionIntent'].includes(key)) ||
        !inputRun(input.expectedRun)) throw new AgentMuxError('The original directed input binding is invalid.', 'INVALID_AGENT_PROMPT')
    return { expectedRun: { ...input.expectedRun }, ...optionalInputEpoch(input.inputEpoch), admissionIntent: validateAgentDirectedPromptTarget(input.admissionIntent) }
  }
  return validateAgentPromptCondition(value)
}

/** Explicit caller intent. A coordination predecessor never supplies manual authority. */
export type AgentPromptAdmissionIntent =
  | { kind: 'exact-condition'; condition: AgentPromptCondition }
  | (AgentDirectedPromptTarget & { expectedRun: AgentMuxRunRef; inputEpoch?: string })

function inputIdentity(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 512 &&
    new TextEncoder().encode(value).byteLength <= 512 && !/[\0\r\n]/u.test(value)
}
function inputRun(value: unknown): value is AgentMuxRunRef {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => key === 'runId') && inputIdentity((value as AgentMuxRunRef).runId))
}

export function validateAgentPromptInputKey(value: unknown): AgentPromptInputKey {
  const v = value as AgentPromptInputKey | undefined
  if (!v || !['prompt', 'message'].includes(v.kind) || !inputIdentity(v.agentSessionId) || !inputRun(v.expectedRun) || !inputIdentity(agentPromptLogicalInputId(v)) ||
      v.attemptId !== undefined && (!inputIdentity(v.attemptId) || v.attemptId === agentPromptLogicalInputId(v)) ||
      Object.keys(v).some(k => !['kind', 'agentSessionId', 'expectedRun', 'attemptId', v.kind === 'prompt' ? 'submissionId' : 'messageId'].includes(k))) {
    throw new AgentMuxError('The original input identity is invalid.', 'INVALID_AGENT_PROMPT')
  }
  return structuredClone(v)
}

/** Shared by the original input claim and its continuity recipe; neither grants Start authority. */
export function validateAgentLaunchPromptInputPlan(value: unknown): AgentLaunchPromptInputPlan {
  const plan = value as AgentLaunchPromptInputPlan | undefined
  const target = plan?.nativeTarget
  const providerId = normalizeNativeSessionId(target?.providerId), sessionId = normalizeNativeSessionId(target?.sessionId)
  const transcriptPath = target?.transcriptPath === undefined ? undefined : normalizeNativeTranscriptPath(target.transcriptPath)
  if (!plan || plan.kind !== 'runtime-launch' ||
      Object.keys(plan).some(key => !['kind', 'lifecycleOperationId', 'nativeTarget', 'program', 'argsDigest'].includes(key)) ||
      !inputIdentity(plan.lifecycleOperationId) || !inputIdentity(plan.argsDigest) ||
      typeof plan.program !== 'string' || !plan.program.trim() || /[\0\r\n]/u.test(plan.program) ||
      !target || target.kind !== 'provider' || !providerId || !sessionId ||
      Object.keys(target).some(key => !['kind', 'providerId', 'sessionId', 'transcriptPath'].includes(key)) ||
      target.transcriptPath !== undefined && !transcriptPath) throw new AgentMuxError(
    'The original Runtime launch input plan is invalid.', 'INVALID_AGENT_SESSION_STORE')
  return { kind: 'runtime-launch', lifecycleOperationId: plan.lifecycleOperationId, program: plan.program, argsDigest: plan.argsDigest,
    nativeTarget: { kind: 'provider', providerId, sessionId, ...(transcriptPath === undefined ? {} : { transcriptPath }) } }
}

export function validateAgentPromptAdmissionIntent(value: unknown): AgentPromptAdmissionIntent {
  const v = value as AgentPromptAdmissionIntent | undefined
  if (v?.kind === 'exact-condition' && Object.keys(v).every(k => k === 'kind' || k === 'condition')) {
    return { kind: v.kind, condition: validateAgentPromptCondition(v.condition) }
  }
  if ((v?.kind === 'manual-actor' || v?.kind === 'session-conversation' || v?.kind === 'native-conversation') && inputRun(v.expectedRun)) {
    const { expectedRun, inputEpoch, ...target } = v
    return { ...validateAgentDirectedPromptTarget(target), expectedRun: { ...expectedRun }, ...optionalInputEpoch(inputEpoch) }
  }
  throw new AgentMuxError('The input admission intent is invalid.', 'INVALID_AGENT_PROMPT')
}

/** Shared strict target decoding. A caller's source is an intent, never an actor credential. */
export function validateAgentDirectedPromptTarget(value: unknown): AgentDirectedPromptTarget {
  const v = value as AgentDirectedPromptTarget | undefined
  if ((v?.kind === 'manual-actor' || v?.kind === 'session-conversation') && Object.keys(v).every(k => k === 'kind')) return { kind: v.kind }
  if (v?.kind === 'native-conversation' && Object.keys(v).every(k => ['kind', 'source', 'expectedTurnId'].includes(k)) &&
      v.source && typeof v.source === 'object' && !Array.isArray(v.source) &&
      Object.keys(v.source).every(k => k === 'providerId' || k === 'nativeSessionId') && inputIdentity(v.source.providerId) &&
      inputIdentity(v.source.nativeSessionId) && (v.expectedTurnId === undefined || inputIdentity(v.expectedTurnId))) {
    return { kind: v.kind, source: { ...v.source }, ...(v.expectedTurnId === undefined ? {} : { expectedTurnId: v.expectedTurnId }) }
  }
  throw new AgentMuxError('The input admission intent is invalid.', 'INVALID_AGENT_PROMPT')
}

export function validateAgentPromptCondition(value: unknown): AgentPromptCondition {
  const condition = value as Partial<AgentPromptCondition> | null | undefined
  if (!condition || typeof condition.expectedRun?.runId !== 'string' || !condition.expectedRun.runId.trim() ||
    !Object.hasOwn(condition, 'afterSubmissionId') || condition.afterSubmissionId !== null &&
    (typeof condition.afterSubmissionId !== 'string' || !condition.afterSubmissionId.trim())) throw new AgentMuxError(
      'The original prompt delivery condition is missing. Your message is kept; use the terminal while its delivery is reviewed.',
      'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
  return { expectedRun: { ...condition.expectedRun }, afterSubmissionId: condition.afterSubmissionId, ...optionalInputEpoch(condition.inputEpoch) }
}

export function agentPromptCondition(
  session: Pick<AgentMuxAgentSession, 'run' | 'promptCompletionAdmission' | 'inputEpoch'>
): AgentPromptCondition {
  const afterSubmissionId = agentPromptPredecessor(session)
  if (afterSubmissionId === undefined) throw new AgentMuxError(
    'The previous prompt admission has no logical identity. Your message is kept; use the terminal while its delivery is reviewed.',
    'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
  return { expectedRun: { ...session.run }, afterSubmissionId, ...optionalInputEpoch(session.inputEpoch) }
}

/** A missing logical identity is unknown; only absent admission proves an empty predecessor. */
export function agentPromptPredecessor(session: Pick<AgentMuxAgentSession, 'promptCompletionAdmission'>): string | null | undefined {
  return session.promptCompletionAdmission === undefined ? null : session.promptCompletionAdmission.submissionId
}

/** Original whole-input refusal, interpreted by Core rather than by a client error callback. */
export type AgentPromptNotApplied = { submissionId: string; run: AgentMuxRunRef }

export function agentPromptNotApplied(
  session: Pick<AgentMuxAgentSession | AgentMuxHostedAgentSessionSummary, 'run' | 'promptCompletionAdmission' | 'terminalPromptSubmission'>
): AgentPromptNotApplied | undefined {
  const admission = session.promptCompletionAdmission
  const summary = admission && 'intentSummary' in admission ? admission.intentSummary : undefined
  const intentRun = admission?.intent?.run ?? summary?.run
  const planKind = admission?.intent?.plan.kind ?? summary?.planKind
  if (!admission?.submissionId || !admission.notApplied || admission.acknowledged ||
      intentRun?.runId !== session.run.runId || !planKind || admission.frameRefresh?.notApplied) return undefined
  const submission = session.terminalPromptSubmission
  if (admission.transport === 'native') {
    return admission.native?.outcome === 'not-applied' && planKind === 'native-rpc' && !submission
      ? { submissionId: admission.submissionId, run: { ...session.run } } : undefined
  }
  if (admission.transport === 'launch') {
    return admission.launch.outcome === 'not-applied' && planKind === 'runtime-launch' && !submission
      ? { submissionId: admission.submissionId, run: { ...session.run } } : undefined
  }
  if (planKind === 'single-phase') {
    if (submission || admission.chunks?.some(chunk => chunk.acknowledged)) return undefined
  } else {
    if (!submission || submission.submissionId !== admission.submissionId || submission.run.runId !== session.run.runId) return undefined
    const first = submission.prepare?.interrupt ?? submission.payload
    // A refusal of the final submit cannot undo an accepted payload. Nor does an
    // independent redraw refusal prove what happened to the original prompt bytes.
    if (admission.operationId !== first.operationId || admission.startByte !== first.inputByteRange.startByte ||
        admission.endByte !== submission.submit.inputByteRange.endByte || submission.prepare?.interrupt?.acknowledged ||
        submission.payload.acknowledged || submission.submit.acknowledged ||
        [submission.prepare?.interrupt, submission.payload, submission.submit].some(phase => phase?.chunks?.some(chunk => chunk.acknowledged))) return undefined
  }
  return { submissionId: admission.submissionId, run: { ...session.run } }
}

/** Absence stays absent for namespaces that have never restored a snapshot. */
export function optionalInputEpoch(value: unknown): { inputEpoch?: string } {
  if (value === undefined) return {}
  if (!inputIdentity(value)) throw new AgentMuxError('The original input restore epoch is invalid.', 'INVALID_AGENT_PROMPT')
  return { inputEpoch: value }
}

/** A matching Run/predecessor cannot prove absence beyond a restored cut. */
export function assertAgentInputEpoch(session: { inputEpoch?: string }, binding: { inputEpoch?: string }): void {
  optionalInputEpoch(binding.inputEpoch)
  if (session.inputEpoch !== binding.inputEpoch) throw new AgentMuxError(
    'This input belongs to an earlier or unconfirmed storage cut. Its original key and history are retained; inspect it before composing a new independent input.',
    'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
}
