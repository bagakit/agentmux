import { parseTerminalFrontendObservation, type AgentTerminalFrontendObservation } from '../agent-terminal-frontend.js'
import { agentInputContextCaptureProofFields, parseAgentInputContextCaptureReference } from '../agent-input-context-capture.js'
import { AMUX_CONTINUE_MARKER } from '../amux-protocol-definition.js'
import type {
  AgentCapabilitySnapshot,
  AgentCatalogEntry,
  AgentMuxAgentSession,
  AgentMuxRun,
  AgentMuxRunRef,
  AgentNativeSessionHandle,
  AgentPromptMessageContent,
  AgentMessageChannel,
  AgentOperationDevice
} from '../types.js'
import { parseAgentContinuityControlReceipts } from './control.js'
import type { AgentMuxContinuityControlReceipt } from './control.js'
import { validateAgentPromptInputKey, type AgentPromptInputKey } from '../agent-prompt-condition.js'
import { isAgentActivityStatusSource } from '../agent-status-freshness.js'
import { unconfirmedExecutableObservation } from '../executable-observation.js'
import { browserInputContextFields, parseBrowserInputContext } from '../browser-input-context.js'

/** Host-independent policy. Callers persist only authored fields; each admitted operation freezes this complete value. */
export type AgentMuxContinuityPolicy = {
  activeRecovery: 'automatic' | 'manual'
  activeRecoveryDelayMs: number
  confirmedIdleWindowMs: number
  resumeAfterExit: boolean
  recheckIntervalMs: number
  recheckMaxAttempts: number
  retryInitialDelayMs: number
  retryMaxDelayMs: number
  /** Additional admitted attempt records; the initial native resume is not counted. */
  retryMaxAttempts: number
  reminderMode: 'off' | 'default' | 'default-plus-custom'
  reminderAppend: string
  continuationEnabled: boolean
  continuationPrompt: string
  /** Use the last main activity only when the Provider has no native interruption capability. */
  activeInterruptionFallback: boolean
}

export const DEFAULT_AGENT_CONTINUITY_REMINDER = 'This is the same conversation restored after its previous process ended. Preserve the existing task, decisions and user constraints. Previous input with an unknown outcome has not been replayed. Review the retained conversation before taking further action.'
export const DEFAULT_AGENT_CONTINUITY_CONTINUATION = AMUX_CONTINUE_MARKER
export const DEFAULT_AGENT_CONTINUITY_POLICY: Readonly<AgentMuxContinuityPolicy> = Object.freeze({
  activeRecovery: 'automatic', activeRecoveryDelayMs: 0,
  confirmedIdleWindowMs: 24 * 60 * 60 * 1000, resumeAfterExit: true,
  recheckIntervalMs: 1000, recheckMaxAttempts: 3,
  retryInitialDelayMs: 1000, retryMaxDelayMs: 30_000, retryMaxAttempts: 3,
  reminderMode: 'off', reminderAppend: '', continuationEnabled: true,
  continuationPrompt: DEFAULT_AGENT_CONTINUITY_CONTINUATION, activeInterruptionFallback: false
})

/** One-based additional retry; scheduling offsets remain owned by the supervisor. */
export function agentContinuityRetryBaseDelay(policy: Pick<AgentMuxContinuityPolicy, 'retryInitialDelayMs' | 'retryMaxDelayMs'>, retry: number): number {
  return Math.min(policy.retryMaxDelayMs, policy.retryInitialDelayMs * 2 ** Math.min(retry - 1, 52))
}

export function normalizeAgentContinuityPolicy(authored?: Partial<AgentMuxContinuityPolicy>): AgentMuxContinuityPolicy {
  const policy = { ...DEFAULT_AGENT_CONTINUITY_POLICY, ...authored }
  if (!['automatic', 'manual'].includes(policy.activeRecovery) ||
    !['off', 'default', 'default-plus-custom'].includes(policy.reminderMode) ||
    typeof policy.resumeAfterExit !== 'boolean' || typeof policy.continuationEnabled !== 'boolean' || typeof policy.activeInterruptionFallback !== 'boolean' ||
    typeof policy.reminderAppend !== 'string' || typeof policy.continuationPrompt !== 'string' ||
    policy.retryMaxDelayMs < policy.retryInitialDelayMs ||
    ![policy.activeRecoveryDelayMs, policy.confirmedIdleWindowMs, policy.recheckIntervalMs, policy.recheckMaxAttempts,
      policy.retryInitialDelayMs, policy.retryMaxDelayMs, policy.retryMaxAttempts]
      .every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new TypeError('Invalid Agent continuity policy.')
  }
  return policy
}

export type AgentMuxContinuityTrigger = 'startup' | 'host-restored' | 'mote-startup' | 'mote-open' | 'manual' | 'input'

export function resolveAgentContinuityReminder(policy: AgentMuxContinuityPolicy): string {
  if (policy.reminderMode === 'off') return ''
  return DEFAULT_AGENT_CONTINUITY_REMINDER + (policy.reminderMode === 'default-plus-custom' && policy.reminderAppend.trim() ? '\n\n' + policy.reminderAppend : '')
}

export type AgentMuxContinuityPendingReason = 'runtime-unverified' | 'active-manual' | 'active-delay' | 'idle-unknown' | 'not-active' | 'idle-window-expired' | 'resume-disabled' | 'provider-unverified' | 'operation-unconfirmed' | 'recovery-supervised' | 'intent-cancelled'
/** Frozen against the old Run before a native writer is started. This never authorizes live input. */
export type AgentMuxContinuityInterruption = {
  support: 'provider' | 'unsupported'
  state: 'interrupted' | 'not-interrupted' | 'unknown'
  source: 'native-protocol' | 'active-fallback' | 'none'
  previousRun: AgentMuxRunRef
  nativeTarget: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
  observedAt: number
  nativeObservedAt?: number
  nativeSourceId?: string
  nativeTurnId?: string
  evidenceId?: string
  reason: string
}
/** Each selected part shares one physical input and its actual delivery receipt. */
export type AgentMuxContinuityInputPart = {
  selected: boolean
  status: 'not-selected' | 'waiting' | 'dispatching' | 'unknown' | 'accepted' | 'not-applied' | 'superseded'
  text: string
  digest: string
  receiptRef?: AgentPromptInputKey
}
export type AgentMuxContinuityPreviousInput = {
  /** Only the original typed prompt owner is classified; raw historical input is not replayed. */
  scope: 'typed-prompt'
  outcome: 'none' | 'unknown' | 'terminal-confirmed' | 'native-admitted' | 'not-applied'
  key?: AgentPromptInputKey
}
export type AgentMuxContinuityInputDelivery = {
  context: {
    agentSessionId: string
    previousRun: AgentMuxRunRef
    newRun: AgentMuxRunRef
    nativeTarget: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
    interruptedWorking: true
    runEvidence: AgentMuxContinuityOperation['evidence']
    previousInput: AgentMuxContinuityPreviousInput
  }
  key: Extract<AgentPromptInputKey, { kind: 'prompt' }>
  /** Captured in the same lifecycle commit as the recovered Run. Missing is unknown. */
  initialInputByte?: number
  /** Last contiguous, confirmed terminal-protocol ACK; never adopted from the current cursor. */
  protocolInput?: { operationId: string; startByte: number; endByte: number }
  dispatchOwner?: string
  phase: 'waiting' | 'dispatching' | 'unknown' | 'accepted' | 'not-applied' | 'superseded'
  reason: string
  observedAt: number
  reminder: AgentMuxContinuityInputPart
  continuation: AgentMuxContinuityInputPart
  /** Platform content frozen for this original input, independently of selected parts.
   * Historical packets without it keep their original selected reminder content. */
  systemContext?: string
  receipt?: { key: AgentPromptInputKey; status: 'terminal-confirmed' | 'native-admitted' | 'launch-carried' | 'not-applied' | 'unknown'; observedAt: number }
}
/** New authored input which has not yet acquired its resumed Run binding. */
export type AgentMuxContinuityInputRequest = {
  /** Original Host capture reference; mutually exclusive with a direct context declaration. */
  inputContextCapture?: import('../agent-input-context-capture.js').AgentInputContextCaptureReference
  inputContext?: import('../browser-input-context.js').BrowserInputContext
  submissionId: string
  prompt: string
  agentMuxNote?: string
  authorHuman?: boolean
  sourceChannel?: AgentMessageChannel
  sourceDevice?: AgentOperationDevice
}

/** The original lifecycle owner, never a fabricated terminal or Native acceptance ACK. */
export type AgentMuxContinuityLaunchInput = {
  input: AgentMuxContinuityInputRequest
  prompt: string
  message: AgentPromptMessageContent
  digest: string
  delivery: 'launch' | 'post-launch'
  lifecycleOperationId: string
  launchPlan?: { program: string; argsDigest: string }
  state: 'prepared' | 'launch-carried' | 'unknown' | 'not-applied' | 'terminal-confirmed' | 'native-admitted'
  key?: Extract<AgentPromptInputKey, { kind: 'prompt' }>
  receipt?: { kind: 'runtime-launch'; operationId: string; run: AgentMuxRunRef; observedAt: number }
}

export type AgentMuxContinuityContextEvidence = {
  source: 'native-hook'
  run: AgentMuxRunRef
  nativeTarget: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
  hookReceiptId: string
  observedAt: number
}
export type AgentMuxContinuityCancellation = {
  source: 'native-hook' | 'control' | 'user-stop'
  run: AgentMuxRunRef
  nativeTarget: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
  operationId: string
  /** Exact authenticated Hook receipt, alongside the original native cancellation operation. */
  hookReceiptId?: string
  observedAt: number
}
export type AgentMuxContinuitySupervision = {
  /** Immutable control admissions; current progress is represented by the other fields. */
  controlOperations?: Record<string, AgentMuxContinuityControlReceipt>
  phase: 'observing' | 'retry-wait' | 'paused' | 'settled' | 'cancelled'
  activeAttemptOperationId: string
  /** Zero while waiting for initial admission; includes that resume once admitted. History never resets. */
  attemptCount: number
  /** Total admitted attempts authorized by the frozen policy and exact later control receipts. */
  attemptLimit: number
  nextAttemptAt?: number
  observedAt: number
  reason: string
  process?: { run: AgentMuxRunRef; state: 'running' | 'exited' | 'interrupted' | 'unknown'; observedAt: number;
    exitCode?: number | null; exitSignal?: string | number | null }
  contextEvidence?: AgentMuxContinuityContextEvidence
  cancellation?: AgentMuxContinuityCancellation
  observationError?: { code: string; message: string; observedAt: number }
}

export type AgentMuxContinuityOperation = {
  operationId: string
  agentSessionId: string
  trigger: AgentMuxContinuityTrigger
  timingOverride?: 'startup' | 'on-open'
  policy: AgentMuxContinuityPolicy
  /** This attempt only restores context under the original durable automatic intent. */
  intentOperationId?: string
  supervision?: AgentMuxContinuitySupervision
  previousRun: AgentMuxRunRef
  newRun?: AgentMuxRunRef
  nativeTarget?: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
  admittedAt: number
  observedAt: number
  rechecks: number
  interruptedWorking?: boolean
  interruption?: AgentMuxContinuityInterruption
  /** Run-bound original-turn decision, optionally refined by the exact resumed actor. Never rewrites interruption. */
  resumedInterruption?: AgentMuxContinuityInterruption & { run: AgentMuxRunRef; rootOperationId: string }
  /** Original Start and contiguous protocol ACKs, retained before a delayed continuation decision. */
  resumedInputBoundary?: { initialInputByte: number; protocolInput?: { operationId: string; startByte: number; endByte: number }; superseded?: true }
  kind: 'pending' | 'starting' | 'resumed' | 'reattachable' | 'unavailable' | 'conflict' | 'retired'
  reason: string
  evidence: AgentMuxAgentContinuityRunEvidence | { kind: 'unknown-session' } | { kind: 'agent-session-store' } | { kind: 'hook-ingress-owner' } | { kind: 'user-retired'; observedAt: number }
  nextActionAt?: number
  error?: string
  /** Immutable explicit resume request; independent of its resolved Provider launch plan. */
  requestDigest?: string
  /** Explicit restart owns stopping only its original Run; ordinary continuity never does. */
  action?: 'restart'
  /** Exact no-input restart launch, frozen before the original Start. */
  restartLaunch?: { program: string; argsDigest: string }
  /** Original typed fatal result; text is diagnostic content, never a classifier. */
  errorCode?: string
  /** New inputs, independent of old drafts and unknown earlier input; actual delivery has its own owner. */
  recoveryInputs?: { reminder: string; continuation: string }
  previousInput?: AgentMuxContinuityPreviousInput
  launchInput?: AgentMuxContinuityLaunchInput
  recoveryDelivery?: AgentMuxContinuityInputDelivery
  /** Same-Run frontend action; exact original operation and output boundary survive lost replies. */
  frontendReconnect?: { previousFrontendId: string; outputAfterByte: number; frontendId?: string; operationId?: string }
  /** Original actor bootstrap; never a request to replace its backend or repeat a native creation. */
  initializationRecovery?: { actorId: string; lifecycleOperationId: string; run: AgentMuxRunRef; previousFrontendId: string;
    outputAfterByte: number; observation: AgentTerminalFrontendObservation }
}

export function normalizeAgentContinuityLaunchInput(value: unknown): AgentMuxContinuityLaunchInput {
  const input = value as AgentMuxContinuityLaunchInput
  if (!input || typeof input !== 'object' || !input.input || typeof input.input.submissionId !== 'string' || !input.input.submissionId ||
      typeof input.input.prompt !== 'string' || input.input.agentMuxNote !== undefined && typeof input.input.agentMuxNote !== 'string' ||
      input.input.authorHuman !== undefined && typeof input.input.authorHuman !== 'boolean' ||
      typeof input.prompt !== 'string' || !input.prompt.trim() || typeof input.digest !== 'string' || !input.digest ||
      typeof input.lifecycleOperationId !== 'string' || !input.lifecycleOperationId || !input.message ||
      !['launch', 'post-launch'].includes(input.delivery) || !['prepared', 'launch-carried', 'unknown', 'not-applied', 'terminal-confirmed', 'native-admitted'].includes(input.state) ||
      input.launchPlan && (typeof input.launchPlan.program !== 'string' || typeof input.launchPlan.argsDigest !== 'string') ||
      input.state === 'launch-carried' && (input.delivery !== 'launch' || !input.key || !input.receipt) ||
      ['terminal-confirmed', 'native-admitted'].includes(input.state) && (input.delivery !== 'post-launch' || !input.key) ||
      input.receipt && (input.receipt.kind !== 'runtime-launch' || input.receipt.operationId !== input.lifecycleOperationId ||
        input.receipt.run?.runId !== input.key?.expectedRun.runId || !Number.isSafeInteger(input.receipt.observedAt) || input.receipt.observedAt < 0)) throw new TypeError('Invalid original continuity launch input.')
  if (input.key) {
    const key = validateAgentPromptInputKey(input.key)
    if (key.kind !== 'prompt' || key.submissionId !== input.input.submissionId) throw new TypeError('Conflicting continuity launch input key.')
  }
  return { ...structuredClone(input), input: { ...structuredClone(input.input), ...(input.input.inputContextCapture === undefined ? {} : { inputContextCapture: parseAgentInputContextCaptureReference(input.input.inputContextCapture) }), ...(input.input.inputContext === undefined ? {} : { inputContext: parseBrowserInputContext(input.input.inputContext) }) },
    message: { ...structuredClone(input.message), ...browserInputContextFields(input.message), ...agentInputContextCaptureProofFields(input.message) } }
}

export function normalizeAgentContinuityOperation(value: unknown): AgentMuxContinuityOperation {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid continuity operation.')
  const op = value as AgentMuxContinuityOperation
  if (typeof op.operationId !== 'string' || !op.operationId || typeof op.agentSessionId !== 'string' || !op.agentSessionId ||
    !['startup', 'host-restored', 'mote-startup', 'mote-open', 'manual', 'input'].includes(op.trigger) ||
    !['pending', 'starting', 'resumed', 'reattachable', 'unavailable', 'conflict', 'retired'].includes(op.kind) ||
    !op.previousRun || typeof op.previousRun.runId !== 'string' || typeof op.reason !== 'string' ||
    ![op.admittedAt, op.observedAt, op.rechecks, ...(op.nextActionAt === undefined ? [] : [op.nextActionAt])].every(value => Number.isSafeInteger(value) && value >= 0) ||
    !op.evidence || typeof op.evidence.kind !== 'string' || op.newRun && typeof op.newRun.runId !== 'string' ||
    op.nativeTarget && (op.nativeTarget.kind !== 'provider' || typeof op.nativeTarget.providerId !== 'string' || !op.nativeTarget.providerId || typeof op.nativeTarget.sessionId !== 'string' || !op.nativeTarget.sessionId) ||
    op.restartLaunch && (typeof op.restartLaunch.program !== 'string' || !op.restartLaunch.program || typeof op.restartLaunch.argsDigest !== 'string' || !op.restartLaunch.argsDigest || op.action !== 'restart') ||
    op.action !== undefined && op.action !== 'restart' ||
    op.requestDigest !== undefined && (typeof op.requestDigest !== 'string' || !op.requestDigest) ||
    op.errorCode !== undefined && (typeof op.errorCode !== 'string' || !op.errorCode) ||
    op.recoveryInputs && (typeof op.recoveryInputs.reminder !== 'string' || typeof op.recoveryInputs.continuation !== 'string')) throw new TypeError('Invalid continuity operation.')
  const supervision = op.supervision
  if (op.intentOperationId !== undefined && (typeof op.intentOperationId !== 'string' || !op.intentOperationId || op.intentOperationId === op.operationId) ||
    supervision && (!['observing', 'retry-wait', 'paused', 'settled', 'cancelled'].includes(supervision.phase) ||
      typeof supervision.activeAttemptOperationId !== 'string' || !supervision.activeAttemptOperationId || typeof supervision.reason !== 'string' ||
      supervision.attemptCount < 0 || supervision.attemptLimit < 1 ||
      supervision.attemptCount === 0 && (op.intentOperationId !== undefined || op.newRun !== undefined ||
        supervision.activeAttemptOperationId !== op.operationId || supervision.phase === 'retry-wait') ||
      ![supervision.attemptCount, supervision.attemptLimit, supervision.observedAt, ...(supervision.nextAttemptAt === undefined ? [] : [supervision.nextAttemptAt])].every(value => Number.isSafeInteger(value) && value >= 0) ||
      supervision.process && (!supervision.process.run || typeof supervision.process.run.runId !== 'string' || !supervision.process.run.runId || !['running', 'exited', 'interrupted', 'unknown'].includes(supervision.process.state) ||
        !Number.isSafeInteger(supervision.process.observedAt) || supervision.process.observedAt < 0 ||
        supervision.process.exitSignal !== undefined && supervision.process.exitSignal !== null && typeof supervision.process.exitSignal !== 'string' && !Number.isSafeInteger(supervision.process.exitSignal) ||
        supervision.process.exitCode !== undefined && supervision.process.exitCode !== null && !Number.isSafeInteger(supervision.process.exitCode)) ||
      supervision.contextEvidence && (supervision.contextEvidence.source !== 'native-hook' || typeof supervision.contextEvidence.hookReceiptId !== 'string' || !supervision.contextEvidence.hookReceiptId) ||
      supervision.cancellation && (!['native-hook', 'control', 'user-stop'].includes(supervision.cancellation.source) || typeof supervision.cancellation.operationId !== 'string' || !supervision.cancellation.operationId) ||
      supervision.cancellation?.hookReceiptId !== undefined && (typeof supervision.cancellation.hookReceiptId !== 'string' || !supervision.cancellation.hookReceiptId) ||
      supervision.observationError && (typeof supervision.observationError.code !== 'string' || typeof supervision.observationError.message !== 'string' ||
        !Number.isSafeInteger(supervision.observationError.observedAt) || supervision.observationError.observedAt < 0) ||
      [supervision.contextEvidence, supervision.cancellation].some(fact => fact && (!fact.run || typeof fact.run.runId !== 'string' || !fact.run.runId ||
        fact.nativeTarget?.kind !== 'provider' || typeof fact.nativeTarget.providerId !== 'string' || !fact.nativeTarget.providerId || typeof fact.nativeTarget.sessionId !== 'string' || !fact.nativeTarget.sessionId ||
        !Number.isSafeInteger(fact.observedAt) || fact.observedAt < 0)))) throw new TypeError('Invalid original recovery supervision.')
  if (supervision?.controlOperations !== undefined) parseAgentContinuityControlReceipts(supervision.controlOperations, op.agentSessionId, op.operationId)
  if (op.launchInput) {
    const launched = normalizeAgentContinuityLaunchInput(op.launchInput)
    if (launched.key && (launched.key.agentSessionId !== op.agentSessionId || launched.key.expectedRun.runId !== op.newRun?.runId)) throw new TypeError('Continuity launch input changed its exact Run.')
  }
  const interruption = op.interruption
  if (interruption && (!['provider', 'unsupported'].includes(interruption.support) ||
      !['interrupted', 'not-interrupted', 'unknown'].includes(interruption.state) ||
      !['native-protocol', 'active-fallback', 'none'].includes(interruption.source) ||
      interruption.previousRun?.runId !== op.previousRun.runId || interruption.nativeTarget?.kind !== 'provider' ||
      interruption.nativeTarget.providerId !== op.nativeTarget?.providerId || interruption.nativeTarget.sessionId !== op.nativeTarget?.sessionId ||
      !Number.isSafeInteger(interruption.observedAt) || interruption.observedAt < 0 || typeof interruption.reason !== 'string' ||
      interruption.source === 'active-fallback' && interruption.support !== 'unsupported' ||
      interruption.source === 'native-protocol' && interruption.support !== 'provider' ||
      interruption.nativeObservedAt !== undefined && (!Number.isSafeInteger(interruption.nativeObservedAt) || interruption.nativeObservedAt < 0) ||
      [interruption.evidenceId, interruption.nativeTurnId, interruption.nativeSourceId].some(value => value !== undefined && (typeof value !== 'string' || !value)))) {
    throw new TypeError('Invalid original continuity interruption evidence.')
  }
  const resumed = op.resumedInterruption
  if (resumed && (!['provider', 'unsupported'].includes(resumed.support) || !['native-protocol', 'active-fallback'].includes(resumed.source) ||
      resumed.source === 'native-protocol' && resumed.support !== 'provider' || resumed.source === 'active-fallback' && resumed.support !== 'unsupported' ||
      !['interrupted', 'not-interrupted'].includes(resumed.state) || !op.newRun || resumed.run?.runId !== op.newRun.runId ||
      resumed.rootOperationId !== (op.intentOperationId ?? op.operationId) || typeof resumed.previousRun?.runId !== 'string' || !resumed.previousRun.runId ||
      resumed.nativeTarget?.kind !== 'provider' || resumed.nativeTarget.providerId !== op.nativeTarget?.providerId ||
      resumed.nativeTarget.sessionId !== op.nativeTarget?.sessionId ||
      [resumed.nativeTurnId, resumed.nativeSourceId, resumed.evidenceId].some(value => value !== undefined && (typeof value !== 'string' || !value)) ||
      typeof resumed.reason !== 'string' || !resumed.reason ||
      !Number.isSafeInteger(resumed.observedAt) || resumed.observedAt < 0 ||
      resumed.nativeObservedAt !== undefined && (!Number.isSafeInteger(resumed.nativeObservedAt) || resumed.nativeObservedAt < 0))) {
    throw new TypeError('Invalid recovered original-turn evidence.')
  }
  const boundary = op.resumedInputBoundary
  if (boundary && (!op.newRun || !Number.isSafeInteger(boundary.initialInputByte) || boundary.initialInputByte < 0 ||
      boundary.superseded !== undefined && boundary.superseded !== true || boundary.protocolInput &&
      (typeof boundary.protocolInput.operationId !== 'string' || !boundary.protocolInput.operationId || !Number.isSafeInteger(boundary.protocolInput.startByte) ||
        !Number.isSafeInteger(boundary.protocolInput.endByte) || boundary.protocolInput.startByte < boundary.initialInputByte ||
        boundary.protocolInput.endByte <= boundary.protocolInput.startByte))) throw new TypeError('Invalid resumed input boundary.')
  const delivery = op.recoveryDelivery
  if (delivery && (!delivery.context || delivery.context.agentSessionId !== op.agentSessionId || delivery.context.newRun?.runId !== op.newRun?.runId ||
    delivery.context.previousRun?.runId !== op.previousRun.runId || delivery.context.interruptedWorking !== true ||
    !delivery.context.nativeTarget || !delivery.context.runEvidence || !delivery.context.previousInput || !delivery.key || delivery.key.kind !== 'prompt' || delivery.key.agentSessionId !== op.agentSessionId ||
    delivery.key.expectedRun?.runId !== op.newRun?.runId || typeof delivery.key.submissionId !== 'string' ||
    !['waiting', 'dispatching', 'unknown', 'accepted', 'not-applied', 'superseded'].includes(delivery.phase) ||
    typeof delivery.reason !== 'string' || !Number.isSafeInteger(delivery.observedAt) || delivery.observedAt < 0 ||
    delivery.initialInputByte !== undefined && (!Number.isSafeInteger(delivery.initialInputByte) || delivery.initialInputByte < 0) ||
    delivery.systemContext !== undefined && typeof delivery.systemContext !== 'string' ||
    [delivery.reminder, delivery.continuation].some(part => !part || typeof part.selected !== 'boolean' || typeof part.text !== 'string' ||
      typeof part.digest !== 'string' || !['not-selected', 'waiting', 'dispatching', 'unknown', 'accepted', 'not-applied', 'superseded'].includes(part.status) || part.receiptRef && JSON.stringify(part.receiptRef) !== JSON.stringify(delivery.key)) ||
    delivery.receipt && JSON.stringify(delivery.receipt.key) !== JSON.stringify(delivery.key))) throw new TypeError('Invalid continuity input delivery.')
  if (op.frontendReconnect && (!op.frontendReconnect.previousFrontendId ||
    !Number.isSafeInteger(op.frontendReconnect.outputAfterByte) || op.frontendReconnect.outputAfterByte < 0 ||
    op.frontendReconnect.frontendId !== undefined && !op.frontendReconnect.frontendId ||
    op.frontendReconnect.operationId !== undefined && (typeof op.frontendReconnect.operationId !== 'string' || !op.frontendReconnect.operationId))) throw new TypeError('Invalid original frontend reconnect.')
  if (op.initializationRecovery) {
    const original = op.initializationRecovery
    const observation = parseTerminalFrontendObservation(original.observation)
    if (![original.actorId, original.lifecycleOperationId, original.previousFrontendId].every(value =>
      typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value)) ||
      !Number.isSafeInteger(original.outputAfterByte) || original.outputAfterByte < 0 ||
      observation.initialization?.lifecycleOperationId !== original.lifecycleOperationId ||
      original.run?.runId !== (op.newRun ?? op.previousRun).runId || op.frontendReconnect &&
        (!op.frontendReconnect.operationId || op.frontendReconnect.operationId === op.operationId ||
          observation.initialization?.phase !== 'ready' || observation.initialization.native.state !== 'confirmed' ||
          observation.initialization.native.sessionId !== op.nativeTarget?.sessionId)) {
      throw new TypeError('Invalid original initialization recovery.')
    }
  }
  return { ...structuredClone(op), policy: normalizeAgentContinuityPolicy(op.policy) }
}

/** Automatic eligibility consumes native semantic state; presentation never grants recovery. */
export function agentContinuityAdmission(input: {
  session: AgentMuxAgentSession; trigger: AgentMuxContinuityTrigger; policy: AgentMuxContinuityPolicy;
  admittedAt: number; now: number; timingOverride?: 'startup' | 'on-open'
  /** Last accepted durable main-native activity, supplied only by the original Core owner. */
  lastActivityAt?: number
}): { kind: 'resume'; reason: string; interruptedWorking: boolean } | { kind: 'pending'; reason: AgentMuxContinuityPendingReason; nextActionAt?: number } {
  const { session, policy, trigger, now } = input
  const status = session.semanticStatus
  const working = Boolean(status && isAgentActivityStatusSource(status.source) && status.state === 'working')
  if (trigger === 'manual' || trigger === 'input') return { kind: 'resume', reason: 'explicit-request', interruptedWorking: false }
  if (!policy.resumeAfterExit) return { kind: 'pending', reason: 'resume-disabled' }
  if (!status || !isAgentActivityStatusSource(status.source)) return { kind: 'pending', reason: 'idle-unknown' }
  const activityAt = input.lastActivityAt ?? (status.state === 'done' ? status.stateEnteredAt : status.observedAt)
  if (activityAt === undefined || !Number.isSafeInteger(activityAt) || activityAt < 0 || activityAt > now) return { kind: 'pending', reason: 'idle-unknown' }
  if (now - activityAt > policy.confirmedIdleWindowMs) return { kind: 'pending', reason: 'idle-window-expired' }
  if (working) {
    if (policy.activeRecovery === 'manual' && !input.timingOverride) return { kind: 'pending', reason: 'active-manual' }
    const nextActionAt = Math.min(Number.MAX_SAFE_INTEGER, input.admittedAt + policy.activeRecoveryDelayMs)
    return now < nextActionAt ? { kind: 'pending', reason: 'active-delay', nextActionAt } : { kind: 'resume', reason: 'recent-activity', interruptedWorking: false }
  }
  if (status.state !== 'done') return { kind: 'pending', reason: 'not-active' }
  const enteredAt = status.stateEnteredAt
  if (enteredAt === undefined || !Number.isFinite(enteredAt) || enteredAt < 0 || enteredAt > now) return { kind: 'pending', reason: 'idle-unknown' }
  return now - enteredAt <= policy.confirmedIdleWindowMs
    ? { kind: 'resume', reason: 'confirmed-idle', interruptedWorking: false }
    : { kind: 'pending', reason: 'idle-window-expired' }
}

export type AgentMuxAgentContinuityInput = {
  agentSessionId: string
  expectedRun: AgentMuxRunRef
  operationId: string
  trigger?: AgentMuxContinuityTrigger
  input?: AgentMuxContinuityInputRequest
  policy?: Partial<AgentMuxContinuityPolicy>
  /** A saved Mote timing overrides ordinary automatic admission only. */
  timingOverride?: 'startup' | 'on-open'
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  commandOverride?: string
  cols?: number
  rows?: number
}

export type AgentMuxAgentContinuityUnavailableReason =
  | 'unknown-session'
  | 'native-handle-unavailable'
  | 'provider-resume-unsupported'
  | 'provider-unavailable'

/**
 * 恢复被「占着」的两类。**它们要求用户做的事相反**，所以必须是两个取值而不是一个 conflict 位。
 *
 * - `session-run-changed`：这条 Agent Session **还活着，但已经在一个更新的 Run 上**（别处已经
 *   resume 过它）。于是「等一下」是错建议——被替换掉的 Run 等多久都不会回来；正确的动作是重读
 *   这条 session 的当前快照（按稳定的 agentSessionId 取，不按 run 取）。
 * - `lifecycle-busy`：另一个生命周期操作**此刻**正持有它，这是短暂的。这一类「等」才对。
 *
 * 抽成一个命名类型而不是继续内联：desktop 侧要按它分流出两套文案与两个动作，而内联的字面量
 * 会让两边各写一遍取值域——那是必然 drift 的两处常量。
 */
export type AgentMuxAgentContinuityConflictReason =
  | 'session-run-changed'
  | 'lifecycle-busy'

export type AgentMuxAgentContinuityRunEvidence =
  | { kind: 'run-running'; observedAt: number }
  | { kind: 'run-ended'; state: 'exited' | 'interrupted'; observedAt: number }
  | { kind: 'run-missing'; observedAt: number }
  | { kind: 'run-unknown'; observedAt: number; message: string }

export type AgentMuxAgentContinuityResult = (
  | { kind: 'pending'; agentSessionId: string; previousRun: AgentMuxRunRef; reason: AgentMuxContinuityPendingReason; evidence: AgentMuxAgentContinuityRunEvidence; nextActionAt?: number }
  | {
      kind: 'reattachable'
      session: AgentMuxAgentSession
      previousRun: AgentMuxRunRef
      run: AgentMuxRun
      evidence: Extract<AgentMuxAgentContinuityRunEvidence, { kind: 'run-running' }>
    }
  | {
      kind: 'resumed'
      session: AgentMuxAgentSession
      previousRun: AgentMuxRunRef
      run: AgentMuxRunRef
      evidence: {
        kind: 'provider-native'
        providerId: string
        nativeSessionId: string
        previousRun: AgentMuxAgentContinuityRunEvidence
      }
    }
  | {
      kind: 'unavailable'
      agentSessionId: string
      previousRun: AgentMuxRunRef
      reason: AgentMuxAgentContinuityUnavailableReason
      evidence: AgentMuxAgentContinuityRunEvidence | { kind: 'unknown-session' }
    }
  | {
      kind: 'retired'
      agentSessionId: string
      previousRun: AgentMuxRunRef
      evidence: { kind: 'user-retired'; observedAt: number }
    }
  | {
      kind: 'conflict'
      agentSessionId: string
      previousRun: AgentMuxRunRef
      currentRun?: AgentMuxRunRef
      reason: AgentMuxAgentContinuityConflictReason
      evidence: { kind: 'agent-session-store' } | { kind: 'hook-ingress-owner' }
    }

) & { continuity?: AgentMuxContinuityOperation }

export type AgentMuxAgentContinuityFacts = {
  agentSessionId: string
  hostId: string
  expectedRun: AgentMuxRunRef
  observedAt: number
  session: AgentMuxAgentSession | null
  retirement: {
    agentSessionId: string
    hostId: string
    run: AgentMuxRunRef
    source: 'user'
    observedAt: number
  } | null
  run: AgentMuxRun | null
  catalog: AgentCatalogEntry | null
  capability: AgentCapabilitySnapshot | null
  /** The actual native resume plan's command, independently of installed capability projection. */
  launchExecutable?: string
}

export type AgentMuxAgentContinuityDecision =
  | Exclude<AgentMuxAgentContinuityResult, { kind: 'resumed' }>
  | {
      kind: 'resume'
      session: AgentMuxAgentSession
      previousRun: AgentMuxRunRef
      nativeHandle: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
      evidence: AgentMuxAgentContinuityRunEvidence
    }

function runEvidence(run: AgentMuxRun | null, observedAt: number): AgentMuxAgentContinuityRunEvidence {
  if (!run) return { kind: 'run-missing', observedAt }
  if (run.state === 'running') return { kind: 'run-running', observedAt: run.observedAt }
  return { kind: 'run-ended', state: run.state, observedAt: run.observedAt }
}

/**
 * Maps persisted Semantic Session truth and authoritative Run facts to one
 * continuity action. It does not inspect terminal bytes or execute a Run.
 */
export function decideAgentSessionContinuity(
  facts: AgentMuxAgentContinuityFacts
): AgentMuxAgentContinuityDecision {
  const previousRun = { ...facts.expectedRun }
  const session = facts.session
  if (!session) {
    if (
      facts.retirement?.agentSessionId === facts.agentSessionId &&
      facts.retirement.hostId === facts.hostId &&
      facts.retirement.run.runId === facts.expectedRun.runId
    ) {
      return {
        kind: 'retired',
        agentSessionId: facts.agentSessionId,
        previousRun,
        evidence: { kind: 'user-retired', observedAt: facts.retirement.observedAt }
      }
    }
    return {
      kind: 'unavailable',
      agentSessionId: facts.agentSessionId,
      previousRun,
      reason: 'unknown-session',
      evidence: { kind: 'unknown-session' }
    }
  }
  if (
    session.agentSessionId !== facts.agentSessionId ||
    session.run.runId !== facts.expectedRun.runId
  ) {
    return {
      kind: 'conflict',
      agentSessionId: facts.agentSessionId,
      previousRun,
      currentRun: { ...session.run },
      reason: 'session-run-changed',
      evidence: { kind: 'agent-session-store' }
    }
  }
  if (
    facts.run &&
    (
      facts.run.runId !== session.run.runId ||
      facts.run.kind !== 'agent' ||
      facts.run.agentSessionId !== session.agentSessionId ||
      facts.run.providerId !== session.providerId ||
      facts.run.executorId !== session.executorId ||
      facts.run.workspacePath !== session.workspacePath
    )
  ) {
    return {
      kind: 'conflict',
      agentSessionId: facts.agentSessionId,
      previousRun,
      currentRun: { ...facts.run },
      reason: 'session-run-changed',
      evidence: { kind: 'agent-session-store' }
    }
  }

  const evidence = runEvidence(facts.run, facts.observedAt)
  if (facts.run?.state === 'running') {
    return {
      kind: 'reattachable',
      session: structuredClone(session),
      previousRun,
      run: structuredClone(facts.run),
      evidence: { kind: 'run-running', observedAt: facts.run.observedAt }
    }
  }

  if (
    !facts.catalog ||
    facts.catalog.id !== session.providerId ||
    facts.catalog.resumeStrategy.kind !== 'provider-native'
  ) {
    return {
      kind: 'unavailable',
      agentSessionId: facts.agentSessionId,
      previousRun,
      reason: 'provider-resume-unsupported',
      evidence
    }
  }
  const handle = session.nativeHandle
  if (
    !handle ||
    handle.kind !== 'provider' ||
    handle.providerId !== session.providerId ||
    (facts.catalog.resumeStrategy.locator === 'transcript-path' && !handle.transcriptPath)
  ) {
    return {
      kind: 'unavailable',
      agentSessionId: facts.agentSessionId,
      previousRun,
      reason: 'native-handle-unavailable',
      evidence
    }
  }
  if (
    !facts.capability ||
    (!facts.capability.installed && !unconfirmedExecutableObservation(facts.capability, facts.launchExecutable ?? '')) ||
    facts.capability.providerId !== session.providerId ||
    !facts.capability.capabilities.providerResume
  ) {
    return {
      kind: 'unavailable',
      agentSessionId: facts.agentSessionId,
      previousRun,
      reason: 'provider-unavailable',
      evidence
    }
  }
  return {
    kind: 'resume',
    session: structuredClone(session),
    previousRun,
    nativeHandle: structuredClone(handle),
    evidence
  }
}
