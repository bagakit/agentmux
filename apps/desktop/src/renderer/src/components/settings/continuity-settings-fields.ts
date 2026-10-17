import type { AgentMuxContinuityPolicy } from '@agentmux/core/agent-session-continuity'

export type ExecutionSettings = Pick<AgentMuxContinuityPolicy,
  'activeRecovery' | 'activeRecoveryDelayMs' | 'confirmedIdleWindowMs' | 'resumeAfterExit' |
  'recheckIntervalMs' | 'recheckMaxAttempts' | 'retryInitialDelayMs' | 'retryMaxDelayMs' | 'retryMaxAttempts'>
export type ContinuationSettings = Pick<AgentMuxContinuityPolicy, 'continuationEnabled' | 'activeInterruptionFallback'>

/** Only the fields this editor owns belong in its draft or save expectation. */
export function executionSettings(policy: AgentMuxContinuityPolicy): ExecutionSettings {
  const { activeRecovery, activeRecoveryDelayMs, confirmedIdleWindowMs, resumeAfterExit,
    recheckIntervalMs, recheckMaxAttempts, retryInitialDelayMs, retryMaxDelayMs, retryMaxAttempts } = policy
  return { activeRecovery, activeRecoveryDelayMs, confirmedIdleWindowMs, resumeAfterExit,
    recheckIntervalMs, recheckMaxAttempts, retryInitialDelayMs, retryMaxDelayMs, retryMaxAttempts }
}

export function continuationSettings(policy: AgentMuxContinuityPolicy): ContinuationSettings {
  return { continuationEnabled: policy.continuationEnabled, activeInterruptionFallback: policy.activeInterruptionFallback }
}
