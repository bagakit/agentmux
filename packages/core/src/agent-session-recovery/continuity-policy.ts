import { isAgentActivityStatusSource } from '../agent-status-freshness.js'
import { unconfirmedExecutableObservation } from '../executable-observation.js'
import type { AgentMuxAgentSession, AgentMuxRun, AgentMuxStoredAgentSession } from '../types.js'
import { DEFAULT_AGENT_CONTINUITY_REMINDER, type AgentMuxContinuityPolicy, type AgentMuxContinuityTrigger,
  type AgentMuxContinuityPendingReason, type AgentMuxAgentContinuityRunEvidence, type AgentMuxAgentContinuityFacts,
  type AgentMuxAgentContinuityDecision } from './continuity-contract.js'

/** One-based additional retry; scheduling offsets remain owned by the supervisor. */
export function agentContinuityRetryBaseDelay(policy: Pick<AgentMuxContinuityPolicy, 'retryInitialDelayMs' | 'retryMaxDelayMs'>, retry: number): number {
  return Math.min(policy.retryMaxDelayMs, policy.retryInitialDelayMs * 2 ** Math.min(retry - 1, 52))
}

export function resolveAgentContinuityReminder(policy: AgentMuxContinuityPolicy): string {
  if (policy.reminderMode === 'off') return ''
  return DEFAULT_AGENT_CONTINUITY_REMINDER + (policy.reminderMode === 'default-plus-custom' && policy.reminderAppend.trim() ? '\n\n' + policy.reminderAppend : '')
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
  if (status.state === 'done' && status.idleEvidenceConsumed) return { kind: 'pending', reason: 'idle-unknown' }
  const activityAt = input.lastActivityAt ?? (status.state === 'done' ? status.stateEnteredAt : status.observedAt)
  if (activityAt === undefined || !Number.isSafeInteger(activityAt) || activityAt < 0 || activityAt > now) return { kind: 'pending', reason: 'idle-unknown' }
  if (now - activityAt > policy.confirmedIdleWindowMs) return { kind: 'pending', reason: 'idle-window-expired' }
  if (working) {
    if (policy.activeRecovery === 'manual' && !input.timingOverride) return { kind: 'pending', reason: 'active-manual' }
    const nextActionAt = Math.min(Number.MAX_SAFE_INTEGER, input.admittedAt + policy.activeRecoveryDelayMs)
    return now < nextActionAt ? { kind: 'pending', reason: 'active-delay', nextActionAt } : { kind: 'resume', reason: 'recent-activity', interruptedWorking: false }
  }
  if (status.state !== 'done') return { kind: 'pending', reason: 'not-active' }
  return { kind: 'resume', reason: 'confirmed-idle', interruptedWorking: false }
}

function runEvidence(run: AgentMuxRun | null, observedAt: number): AgentMuxAgentContinuityRunEvidence {
  if (!run) return { kind: 'run-missing', observedAt }
  if (run.state === 'running') return { kind: 'run-running', observedAt: run.observedAt }
  return { kind: 'run-ended', state: run.state, observedAt: run.observedAt }
}

type NativeConversationEvidence = Pick<AgentMuxStoredAgentSession, 'nativeHandle' | 'observedNativeHandle' | 'nativeSourceObservation' |
  'retiredRuns' | 'forkedFrom' | 'nativeActor' | 'creation' | 'initialInput' | 'promptCompletionAdmission' | 'terminalPromptSubmission' |
  'semanticStatus' | 'hookReceipt' | 'recoveryActivity' | 'activityCommit'>

/**
 * Whether the Session's own record holds any sign of a native conversation: an identity in any form
 * (handle, observed handle, candidates), an earlier Run or fork parent, a protocol initialization
 * that may have created a native object before its identity was bound, an authored or unknown first
 * prompt, admitted or submitted input, or native status, Hook or activity evidence.
 */
export function agentSessionHoldsNativeEvidence(session: NativeConversationEvidence): boolean {
  if (session.nativeHandle || session.observedNativeHandle || session.nativeSourceObservation) return true
  if (session.retiredRuns.length > 0 || session.forkedFrom || session.nativeActor?.initializationControl) return true
  if (session.creation?.initialPrompt !== 'not-requested') return true
  return Boolean(session.initialInput || session.promptCompletionAdmission || session.terminalPromptSubmission ||
    session.semanticStatus || session.hookReceipt || session.recoveryActivity || session.activityCommit)
}

/**
 * The one owner of "Core holds no native conversation to continue for this ended Session".
 *
 * It answers only what Core recorded, never what the Provider saved. True when Core installs its own
 * identity channel for this Provider (managed native Hooks), the saved state is durably confirmed,
 * the Session's record holds no native evidence, and ctxmux reports that the Run accepted no input
 * beyond the terminal handshake reply. Any other fact, including an unknown input count, keeps the
 * existing identity and recheck paths (native-handle-unavailable). The caller has already
 * established that the Run is not running.
 */
export function agentSessionHasNoNativeConversation(
  session: NativeConversationEvidence & Pick<AgentMuxStoredAgentSession, 'run' | 'terminalHandshake'>,
  facts: { durabilityConfirmed: boolean; managedIdentityChannel: boolean; acceptedInputBytes: number | null | undefined }
): boolean {
  if (!facts.durabilityConfirmed || !facts.managedIdentityChannel || agentSessionHoldsNativeEvidence(session)) return false
  const handshake = session.terminalHandshake
  const protocolBytes = handshake?.acknowledged && handshake.run.runId === session.run.runId && handshake.inputByteRange.startByte === 0
    ? handshake.inputByteRange.endByte : 0
  return facts.acceptedInputBytes === 0 || facts.acceptedInputBytes === protocolBytes
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
      reason: facts.nativeConversationAbsent ? 'native-conversation-absent' : 'native-handle-unavailable',
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
