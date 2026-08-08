import type { AgentMuxAgentSession } from './types.js'

/** The scheduler's deliberately small, provider-neutral observation contract. */
export type ContinuousProgressObservation = {
  session: Pick<AgentMuxAgentSession, 'agentSessionId' | 'hostId' | 'providerId' | 'workspacePath' | 'run' | 'semanticStatus' | 'pendingInteraction' | 'terminalPromptReadiness'>
  tickId: string
  now: number
  lastTickId?: string
  lastReadinessId?: string
  userInputRevision?: number
  submittedInputRevision?: number
}

export type ContinuousProgressDecision =
  | { kind: 'send'; tickId: string; readinessId: string }
  | { kind: 'skip'; reason: 'working' | 'stale-working' | 'interaction-pending' | 'not-ready' | 'readiness-consumed' | 'duplicate-tick' | 'user-input-changed' | 'unknown-status' }

/**
 * Decide only. It performs no timer work and sends no bytes. The Host calls this
 * immediately before its typed submission, then rechecks the same facts at the
 * Core input boundary. Keeping this pure makes busy/permission/duplicate rules
 * testable without pretending a decision is a delivery receipt.
 */
export function decideContinuousProgress(observation: ContinuousProgressObservation): ContinuousProgressDecision {
  const { session } = observation
  if (observation.lastTickId === observation.tickId) return { kind: 'skip', reason: 'duplicate-tick' }
  if (observation.userInputRevision !== undefined && observation.submittedInputRevision !== undefined && observation.userInputRevision !== observation.submittedInputRevision) {
    return { kind: 'skip', reason: 'user-input-changed' }
  }
  if (session.pendingInteraction) return { kind: 'skip', reason: 'interaction-pending' }
  const semantic = session.semanticStatus?.state
  if (semantic === 'working') {
    const observedAt = session.semanticStatus?.observedAt ?? 0
    return { kind: 'skip', reason: observation.now - observedAt > 30 * 60_000 ? 'stale-working' : 'working' }
  }
  if (semantic !== 'done') return { kind: 'skip', reason: 'unknown-status' }
  const readiness = session.terminalPromptReadiness
  if (!readiness || readiness.run.runId !== session.run.runId || readiness.readyThroughByte === undefined) return { kind: 'skip', reason: 'not-ready' }
  if (readiness.consumedBySubmissionId || observation.lastReadinessId === readiness.id) return { kind: 'skip', reason: 'readiness-consumed' }
  return { kind: 'send', tickId: observation.tickId, readinessId: readiness.id }
}
