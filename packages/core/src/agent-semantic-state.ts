import type { AgentMuxStoredAgentSession, AgentStatus } from './types.js'

/** Repeated observations cannot move, or backfill, the entry time of the same state. */
export function transitionAgentSemanticStatus(
  previous: AgentStatus | undefined,
  observation: AgentStatus
): AgentStatus {
  const { stateEnteredAt: _suppliedEntryTime, ...status } = observation
  const stateEnteredAt = previous?.state === status.state && !previous.idleEvidenceConsumed
    ? previous.stateEnteredAt
    // Equal or backwards observation clocks cannot identify a new epoch. Keep it unknown
    // rather than inventing a later timestamp or confusing a delayed input ACK with this state.
    : previous && status.observedAt <= previous.observedAt ? undefined : status.observedAt
  return { ...status,
    ...(previous?.currentActivityRevision === undefined ? {} : { currentActivityRevision: previous.currentActivityRevision + 1 }),
    ...(stateEnteredAt === undefined ? {} : { stateEnteredAt }) }
}

/** Semantic submission consumes idle evidence; raw terminal ACKs do not. */
export function invalidateAgentIdleEvidence(
  current: AgentMuxStoredAgentSession
): AgentMuxStoredAgentSession {
  const status = current.semanticStatus
  if (status?.state !== 'done' || (status.idleEvidenceConsumed && status.aggregateActivityAt === undefined)) return current
  const { stateEnteredAt: _consumedEntryTime, aggregateActivityAt: _consumedChildActivity, ...semanticStatus } = status
  return { ...current, semanticStatus: { ...semanticStatus, idleEvidenceConsumed: true,
    currentActivityRevision: (status.currentActivityRevision ?? 0) + 1 } }
}
