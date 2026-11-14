import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { SessionSnapshot } from '../../../shared/contracts'

export type DesktopAgentPresentation = { sessionId: string; agentSessionId: string; hostId: string }

/** A Session observation retains an original Core execution only for the exact same subject. */
export function desktopAgentExecutionFromSpatial(region: AgentMuxSpatialGraph['regions'][number], session: SessionSnapshot) {
  if (session.kind !== 'agent') return null
  const sameAgent = region.kind === 'agent' && region.agentSessionId === session.control.agentSessionId
  const execution = region.execution
  return sameAgent && region.runId === session.control.run.runId && execution?.hostId === session.control.hostId &&
    execution.hostId === session.hostId && execution.cwd === session.workspacePath ? execution : null
}

/** A client key is valid only for this original Core Region and execution Host. */
export function desktopAgentPresentationFromSpatial(graph: AgentMuxSpatialGraph, region: AgentMuxSpatialGraph['regions'][number]): DesktopAgentPresentation | null {
  if (region.kind !== 'agent') return null
  const data = graph.resources['region:' + region.regionId]
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const value = data.agentPresentation
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    typeof value.sessionId !== 'string' || typeof value.agentSessionId !== 'string' || typeof value.hostId !== 'string' ||
    value.agentSessionId !== region.agentSessionId || region.execution !== null && region.execution.hostId !== value.hostId) return null
  return { sessionId: value.sessionId, agentSessionId: value.agentSessionId, hostId: value.hostId }
}
