import { agentInteractionActiveRequest } from './agent-interaction-state.js'
import { agentTurnCompletionIdentity } from './agent-session-identity.js'
import { agentPromptNotApplied } from './agent-prompt-condition.js'
import type { AgentObservation } from './agent-status-freshness.js'
import type { AgentMuxAgentSession } from './types.js'
import type { AgentFuturePromptOccurrence } from './types.js'

/** The scheduler's deliberately small, provider-neutral observation contract. */
export type ContinuousProgressObservation = {
  session: Pick<AgentMuxAgentSession, 'agentSessionId' | 'hostId' | 'providerId' | 'workspacePath' | 'run' | 'semanticStatus' | 'pendingInteraction' | 'promptCompletionAdmission' | 'terminalPromptSubmission' | 'futurePromptIntents' | 'inputEpoch'>
  observation: AgentObservation
  tickId: string
  now: number
  lastTickId?: string
  lastCompletionId?: string
  /** Candidate only; the final nullable Native fence authorizes new admission. */
  inputByte: number | null
  /** Optional client-owned veto. Absence does not claim that a client has no draft. */
  inputOccupied?: boolean
  /** Read-only candidate for this exact future occurrence; Core independently qualifies native idle at claim. */
  futureInputActivity?: import('./types.js').AgentInputActivity
}

export type ContinuousProgressDecision =
  | { kind: 'send'; tickId: string; completionId: string }
  | { kind: 'skip'; reason: 'working' | 'stale-working' | 'interaction-pending' | 'readiness-unconfirmed' | 'completion-consumed' | 'duplicate-tick' | 'user-input-changed' | 'unknown-status' }
export type FutureProgressDecision = ContinuousProgressDecision | { kind: 'send'; tickId: string; completionId?: never }

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
  if (observation.inputByte === null) return { kind: 'skip', reason: 'unknown-status' }
  if (current.process !== 'running') return { kind: 'skip', reason: 'unknown-status' }
  if (agentInteractionActiveRequest(session.pendingInteraction) || current.semantic === 'awaiting-input') return { kind: 'skip', reason: 'interaction-pending' }
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

/** Calendar eligibility can consider initial native idle without claiming a completed turn. */
export function decideFutureProgress(observation: ContinuousProgressObservation, occurrence: AgentFuturePromptOccurrence): FutureProgressDecision {
  const saved = observation.session.futurePromptIntents?.[occurrence.intentId]
  if (!saved?.active || saved.lastOccurrenceAt !== undefined && saved.lastOccurrenceAt >= occurrence.occurrenceAt) return { kind: 'skip', reason: 'completion-consumed' }
  const { lastCompletionId: _, ...candidate } = observation
  const { promptCompletionAdmission: _admission, ...session } = observation.session
  const result = decideContinuousProgress({ ...candidate, session })
  const activity = observation.futureInputActivity
  if (result.kind === 'skip' && result.reason === 'unknown-status' && activity?.state === 'idle' &&
      activity.key.agentSessionId === session.agentSessionId && activity.key.expectedRun.runId === session.run.runId &&
      observation.inputByte !== null && !observation.inputOccupied && observation.observation.process === 'running' &&
      observation.observation.readiness === 'ready' && !agentInteractionActiveRequest(session.pendingInteraction) &&
      observation.observation.semantic !== 'active' && observation.observation.semantic !== 'awaiting-input' &&
      session.semanticStatus?.state !== 'working' && (observation.session.promptCompletionAdmission === undefined || agentPromptNotApplied(observation.session))) return { kind: 'send', tickId: observation.tickId }
  return result
}
