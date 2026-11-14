import type { AgentMuxStoredAgentSession, AgentStatus } from './types.js'

/** Repeated observations cannot move, or backfill, the entry time of the same state. */
export function transitionAgentSemanticStatus(
  previous: AgentStatus | undefined,
  observation: AgentStatus,
  evidenceRevision?: number
): AgentStatus {
  const { stateEnteredAt: _suppliedEntryTime, ...status } = observation
  const stateEnteredAt = previous?.state === status.state && !previous.idleEvidenceConsumed
    ? previous.stateEnteredAt
    // Equal or backwards observation clocks cannot identify a new epoch. Keep it unknown
    // rather than inventing a later timestamp or confusing a delayed input ACK with this state.
    : previous && status.observedAt <= previous.observedAt ? undefined : status.observedAt
  return { ...status,
    ...(evidenceRevision === undefined ? {} : { evidenceRevision }),
    ...(previous?.currentActivityRevision === undefined ? {} : { currentActivityRevision: previous.currentActivityRevision + 1 }),
    ...(stateEnteredAt === undefined ? {} : { stateEnteredAt }) }
}

/** Semantic submission consumes idle evidence; raw terminal ACKs do not. */
export function invalidateAgentIdleEvidence(
  current: AgentMuxStoredAgentSession
): AgentMuxStoredAgentSession {
  const status = current.semanticStatus
  if (status?.state !== 'done' || status.idleEvidenceConsumed) return current
  const { stateEnteredAt: _consumedEntryTime, ...semanticStatus } = status
  return { ...current, semanticStatus: { ...semanticStatus, idleEvidenceConsumed: true,
    currentActivityRevision: (status.currentActivityRevision ?? 0) + 1 } }
}

/** Compare accepted facts, never clocks or the view revision advanced by children/read projections. */
export function activityEvidenceSupersedes(
  status: Pick<AgentStatus, 'evidenceRevision'> | undefined,
  activity: { evidenceRevision?: number } | undefined
): boolean {
  return status?.evidenceRevision !== undefined && activity?.evidenceRevision !== undefined &&
    status.evidenceRevision > activity.evidenceRevision
}

/** Allocate only while accepting an original fact, within the existing Session CAS. */
export function nextActivityEvidenceRevision(session: Pick<AgentMuxStoredAgentSession, 'semanticStatus' | 'recoveryActivity'>): number {
  return Math.max(session.semanticStatus?.currentActivityRevision ?? 0,
    session.recoveryActivity?.evidenceRevision ?? (session.recoveryActivity ? 1 : 0)) + 1
}
