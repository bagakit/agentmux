import type {
  AgentCapabilitySnapshot,
  AgentCatalogEntry,
  AgentMuxAgentSession,
  AgentMuxRun,
  AgentMuxRunRef,
  AgentNativeSessionHandle
} from './types.js'
import { isAgentActivityStatusSource } from './agent-status-freshness.js'

/** Host-independent policy. Callers persist only authored fields; each admitted operation freezes this complete value. */
export type AgentMuxContinuityPolicy = {
  activeRecovery: 'automatic' | 'manual'
  activeRecoveryDelayMs: number
  confirmedIdleWindowMs: number
  resumeAfterExit: boolean
  recheckIntervalMs: number
  recheckMaxAttempts: number
  reminderMode: 'off' | 'default' | 'default-plus-custom'
  reminderAppend: string
  continuationEnabled: boolean
  continuationPrompt: string
}

export const DEFAULT_AGENT_CONTINUITY_REMINDER = 'This is the same conversation restored after its previous process ended. Preserve the existing task, decisions and user constraints. Previous input with an unknown outcome has not been replayed. Review the retained conversation before taking further action.'
export const DEFAULT_AGENT_CONTINUITY_CONTINUATION = 'Continue the task that was interrupted when the previous process ended, using the retained conversation and current workspace state.'
export const DEFAULT_AGENT_CONTINUITY_POLICY: Readonly<AgentMuxContinuityPolicy> = Object.freeze({
  activeRecovery: 'automatic', activeRecoveryDelayMs: 0,
  confirmedIdleWindowMs: 24 * 60 * 60 * 1000, resumeAfterExit: true,
  recheckIntervalMs: 1000, recheckMaxAttempts: 3,
  reminderMode: 'default', reminderAppend: '', continuationEnabled: true,
  continuationPrompt: DEFAULT_AGENT_CONTINUITY_CONTINUATION
})

export function normalizeAgentContinuityPolicy(authored?: Partial<AgentMuxContinuityPolicy>): AgentMuxContinuityPolicy {
  const policy = { ...DEFAULT_AGENT_CONTINUITY_POLICY, ...authored }
  if (!['automatic', 'manual'].includes(policy.activeRecovery) ||
    !['off', 'default', 'default-plus-custom'].includes(policy.reminderMode) ||
    typeof policy.resumeAfterExit !== 'boolean' || typeof policy.continuationEnabled !== 'boolean' ||
    typeof policy.reminderAppend !== 'string' || typeof policy.continuationPrompt !== 'string' ||
    ![policy.activeRecoveryDelayMs, policy.confirmedIdleWindowMs, policy.recheckIntervalMs, policy.recheckMaxAttempts]
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

export type AgentMuxContinuityPendingReason = 'runtime-unverified' | 'active-manual' | 'active-delay' | 'idle-unknown' | 'not-active' | 'idle-window-expired' | 'resume-disabled' | 'provider-unverified' | 'operation-unconfirmed'
export type AgentMuxContinuityOperation = {
  operationId: string
  agentSessionId: string
  trigger: AgentMuxContinuityTrigger
  timingOverride?: 'startup' | 'on-open'
  policy: AgentMuxContinuityPolicy
  previousRun: AgentMuxRunRef
  newRun?: AgentMuxRunRef
  nativeTarget?: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
  admittedAt: number
  observedAt: number
  rechecks: number
  interruptedWorking?: boolean
  kind: 'pending' | 'starting' | 'resumed' | 'reattachable' | 'unavailable' | 'conflict' | 'retired'
  reason: string
  evidence: AgentMuxAgentContinuityRunEvidence | { kind: 'unknown-session' } | { kind: 'agent-session-store' } | { kind: 'hook-ingress-owner' } | { kind: 'user-retired'; observedAt: number }
  nextActionAt?: number
  error?: string
  /** New inputs, independent of old drafts and unknown earlier input; actual delivery has its own owner. */
  recoveryInputs?: { reminder: string; continuation: string }
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
    op.nativeTarget && (op.nativeTarget.kind !== 'provider' || typeof op.nativeTarget.providerId !== 'string' || typeof op.nativeTarget.sessionId !== 'string') ||
    op.recoveryInputs && (typeof op.recoveryInputs.reminder !== 'string' || typeof op.recoveryInputs.continuation !== 'string')) throw new TypeError('Invalid continuity operation.')
  return { ...structuredClone(op), policy: normalizeAgentContinuityPolicy(op.policy) }
}

/** Automatic eligibility consumes native semantic state; presentation never grants recovery. */
export function agentContinuityAdmission(input: {
  session: AgentMuxAgentSession; trigger: AgentMuxContinuityTrigger; policy: AgentMuxContinuityPolicy;
  admittedAt: number; now: number; timingOverride?: 'startup' | 'on-open'
}): { kind: 'resume'; reason: string; interruptedWorking: boolean } | { kind: 'pending'; reason: AgentMuxContinuityPendingReason; nextActionAt?: number } {
  const { session, policy, trigger, now } = input
  const status = session.semanticStatus
  const working = Boolean(status && isAgentActivityStatusSource(status.source) && status.state === 'working')
  if (trigger === 'manual' || trigger === 'input' || input.timingOverride) return { kind: 'resume', reason: input.timingOverride ? 'timing-override' : 'explicit-request', interruptedWorking: working }
  if (!policy.resumeAfterExit) return { kind: 'pending', reason: 'resume-disabled' }
  if (!status || !isAgentActivityStatusSource(status.source)) return { kind: 'pending', reason: 'idle-unknown' }
  if (working) {
    if (policy.activeRecovery === 'manual') return { kind: 'pending', reason: 'active-manual' }
    const nextActionAt = Math.min(Number.MAX_SAFE_INTEGER, input.admittedAt + policy.activeRecoveryDelayMs)
    return now < nextActionAt ? { kind: 'pending', reason: 'active-delay', nextActionAt } : { kind: 'resume', reason: 'interrupted-working', interruptedWorking: true }
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
    !facts.capability?.installed ||
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
