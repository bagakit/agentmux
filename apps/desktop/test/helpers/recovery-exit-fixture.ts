import { DEFAULT_AGENT_CONTINUITY_POLICY, type AgentMuxContinuityOperation } from '@agentmux/core'
import type { SessionSnapshot } from '../../src/shared/contracts'
import { fixturePath } from '../../scripts/lib/fixture-values.mjs'

export function recoveryExitSession(kind = 'recovery-failed'): Extract<SessionSnapshot, { kind: 'agent' }> {
  const now = Date.now(), run = { runId: 'current-run' }
  const operation: AgentMuxContinuityOperation = {
    operationId: 'original-recovery', agentSessionId: 'retained-agent', kind: 'resumed', reason: 'recent-activity',
    trigger: 'startup', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: { runId: 'previous-run' }, newRun: run,
    admittedAt: now, observedAt: now, rechecks: 0,
    evidence: { kind: 'run-ended', state: 'exited', observedAt: now },
    nativeTarget: { kind: 'provider', providerId: 'codex', sessionId: 'original-conversation' },
    errorCode: 'AGENT_TERMINAL_HANDSHAKE_FAILED', error: 'The original startup request was rejected. Check the executor environment before restoring again.',
    supervision: { phase: 'paused', activeAttemptOperationId: 'original-recovery', attemptCount: 2, attemptLimit: 2,
      observedAt: now, reason: 'retry-budget-exhausted', process: { run, state: 'exited', exitCode: 1, observedAt: now } }
  }
  if (kind === 'unknown-cause') delete operation.error
  if (kind === 'previous-attempt') operation.newRun = { runId: 'another-run' }
  if (kind === 'foreign-session') operation.agentSessionId = 'another-agent'
  const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
    id: 'retained-agent', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: fixturePath('recovery-project'), label: 'Recovery review', promptSubmissionPredecessor: null,
    agentSessionUpdatedAt: now, createdAt: now, updatedAt: now, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    processState: kind === 'healthy' ? 'running' : 'exited',
    status: kind === 'healthy' ? { state: 'running', source: 'run-process', observedAt: now }
      : { state: 'error', source: 'run-process', observedAt: now, exitReason: 'crashed', ...(kind === 'no-exit-code' ? {} : { exitCode: 1 }) },
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'retained-agent', run },
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-conversation' },
    ...(kind === 'ordinary-exit' ? {} : { continuity: operation, continuityOperations: { [operation.operationId]: operation } })
  }
  if (kind === 'healthy') {
    operation.supervision = { ...operation.supervision!, phase: 'observing', reason: 'frontend-attached' }
    session.terminalFrontend = { run, frontendId: 'current-frontend', state: 'attached', backendState: 'running', source: 'managed-process', observedAt: now }
  }
  return session
}
