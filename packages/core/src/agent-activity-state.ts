import type {
  AgentActivityCommit, AgentActivityObservation, AgentMuxRunRef, AgentStatus, AgentTimelineItem
} from './types.js'

/** A transition keeps only the latest observation and the first uncommitted predecessor. */
export function advanceAgentActivityCommit(
  previous: AgentActivityCommit | undefined,
  observation: AgentActivityObservation
): AgentActivityCommit {
  const pending = previous?.pending ?? (previous && !previous.latestCommitted ? previous.latest : undefined)
  return {
    latest: {
      ...observation,
      activityState: {
        ...observation.activityState,
        ...(previous ? { previousObservationId: previous.latest.id } : {})
      }
    },
    latestCommitted: false,
    ...(pending ? { pending } : {})
  }
}

/** Repeated tool, byte and same-state observations do not create or read history. */
export function acceptsAgentActivityState(
  previous: AgentActivityCommit | undefined, run: AgentMuxRunRef, status: AgentStatus
): boolean {
  const latest = previous?.latest.activityState
  return !latest || latest.run.runId !== run.runId || !('state' in latest) || latest.state !== status.state
}

export function agentActivityTimelineItem(
  agentSessionId: string, observation: AgentActivityObservation
): AgentTimelineItem {
  const activity = observation.activityState
  return {
    id: observation.id, agentSessionId, kind: 'lifecycle', status: 'complete',
    source: observation.source, createdAt: observation.createdAt, updatedAt: observation.createdAt,
    title: 'state' in activity ? `Agent state: ${activity.state}` : `Run observation: ${activity.boundary}`,
    activityState: structuredClone(activity)
  }
}
