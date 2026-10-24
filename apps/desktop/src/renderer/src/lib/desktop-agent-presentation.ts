import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'

export type DesktopAgentPresentation = { sessionId: string; agentSessionId: string; hostId: string }

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
