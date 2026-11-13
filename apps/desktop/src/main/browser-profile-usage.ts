import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'

/**
 * Saved Browser Regions that still name a Profile. A Region that has not been
 * shown since restart has no native owner yet, so only the spatial graph knows
 * it needs this Profile to restore. Private and Capsule pages never use one.
 */
export function savedBrowsersUsingProfile(graph: AgentMuxSpatialGraph, profileId: string): string[] {
  return graph.regions.flatMap(region => {
    if (region.kind !== 'browser' || !region.browserId) return []
    const data = graph.resources['region:' + region.regionId]
    if (!data || typeof data !== 'object' || Array.isArray(data)) return []
    if (data.mode === 'private' || data.capsuleId !== undefined) return []
    return data.profileId === profileId ? [region.browserId] : []
  })
}
