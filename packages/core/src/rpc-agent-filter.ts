import type { AgentMuxAgentRuntimeStatus } from './client.js'

/** The original process observation is the sole status axis for public Session discovery. */
export function agentSessionStatus(session: AgentMuxAgentRuntimeStatus): string {
  return session.observation.process
}

export type AgentSessionFilter = {
  sessionId?: string | undefined
  status?: string | undefined
  since?: number | undefined
}

export function agentSessionMatches(session: AgentMuxAgentRuntimeStatus, filter: AgentSessionFilter): boolean {
  return (!filter.sessionId || session.session.agentSessionId === filter.sessionId)
    && (!filter.status || agentSessionStatus(session) === filter.status)
    && (filter.since === undefined || session.session.updatedAt >= filter.since)
}
