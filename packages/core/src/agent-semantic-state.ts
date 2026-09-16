import type { AgentMuxStoredAgentSession, AgentStatus } from './types.js'

/** Repeated observations cannot move, or backfill, the entry time of the same state. */
export function transitionAgentSemanticStatus(
  previous: AgentStatus | undefined,
  observation: AgentStatus
): AgentStatus {
  const { stateEnteredAt: _suppliedEntryTime, ...status } = observation
  const stateEnteredAt = previous?.state === status.state
    ? previous.stateEnteredAt
    // Equal or backwards observation clocks cannot identify a new epoch. Keep it unknown
    // rather than inventing a later timestamp or confusing a delayed input ACK with this state.
    : previous && status.observedAt <= previous.observedAt ? undefined : status.observedAt
  return { ...status, ...(stateEnteredAt === undefined ? {} : { stateEnteredAt }) }
}

/** Input consumes idle evidence; it does not prove a new semantic state or recent activity. */
export function invalidateAgentIdleEvidence(
  current: AgentMuxStoredAgentSession,
  expectedStateEnteredAt?: number
): AgentMuxStoredAgentSession {
  const status = current.semanticStatus
  if (status?.state !== 'done' || status.stateEnteredAt === undefined ||
      (expectedStateEnteredAt !== undefined && status.stateEnteredAt !== expectedStateEnteredAt)) return current
  const { stateEnteredAt: _consumedEntryTime, ...semanticStatus } = status
  return { ...current, semanticStatus }
}
