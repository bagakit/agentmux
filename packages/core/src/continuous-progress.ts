import { agentTurnCompletionIdentity } from './agent-session-identity.js'
import type { AgentObservation } from './agent-status-freshness.js'
import type { AgentMuxAgentSession } from './types.js'

/** The scheduler's deliberately small, provider-neutral observation contract. */
export type ContinuousProgressObservation = {
  session: Pick<AgentMuxAgentSession, 'agentSessionId' | 'hostId' | 'providerId' | 'workspacePath' | 'run' | 'semanticStatus' | 'pendingInteraction' | 'promptCompletionAdmission'>
  observation: AgentObservation
  tickId: string
  now: number
  lastTickId?: string
  lastCompletionId?: string
  /** Candidate only; the final nullable Native fence authorizes new admission. */
  inputByte: number
  inputOccupied: boolean
}

export type ContinuousProgressDecision =
  | { kind: 'send'; tickId: string; completionId: string }
  | { kind: 'skip'; reason: 'working' | 'stale-working' | 'interaction-pending' | 'readiness-unconfirmed' | 'completion-consumed' | 'duplicate-tick' | 'user-input-changed' | 'unknown-status' }

/**
 * Decide only. It performs no timer work and sends no bytes. The Host calls this
 * immediately before its typed submission, then rechecks the same facts at the
 * Core input boundary. Keeping this pure makes busy/permission/duplicate rules
 * testable without pretending a decision is a delivery receipt.
 */
export function decideContinuousProgress(observation: ContinuousProgressObservation): ContinuousProgressDecision {
  const { session, observation: current } = observation
  if (observation.lastTickId === observation.tickId) return { kind: 'skip', reason: 'duplicate-tick' }
  if (observation.inputOccupied) {
    return { kind: 'skip', reason: 'user-input-changed' }
  }
  if (current.process !== 'running') return { kind: 'skip', reason: 'unknown-status' }
  if (session.pendingInteraction || current.semantic === 'awaiting-input') return { kind: 'skip', reason: 'interaction-pending' }
  if (current.readiness !== 'ready') return { kind: 'skip', reason: 'readiness-unconfirmed' }
  if (current.semantic === 'active') return { kind: 'skip', reason: 'working' }
  // Decayed working is an observation limit, not a completed turn. Freshness belongs
  // to the shared observation owner; the clock must not invent another threshold.
  if (session.semanticStatus?.state === 'working') return { kind: 'skip', reason: current.stale ? 'stale-working' : 'working' }
  const completionId = agentTurnCompletionIdentity(session)
  if (current.semantic !== 'idle' || completionId === undefined) return { kind: 'skip', reason: 'unknown-status' }
  if (observation.lastCompletionId === completionId || session.promptCompletionAdmission?.completionId === completionId) return { kind: 'skip', reason: 'completion-consumed' }
  return { kind: 'send', tickId: observation.tickId, completionId }
}
