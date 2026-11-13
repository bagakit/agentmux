import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'

export type SavedBrowserUse = { browserId: string; title: string; url: string }

/**
 * Saved Browser Regions that still name a Profile. A Region that has not been
 * shown since restart has no native owner yet, so only the spatial graph knows
 * it needs this Profile to restore. Private and Capsule pages never use one, and
 * a Region outside any Tab cannot be shown, so it does not hold the Profile.
 */
export function savedBrowsersUsingProfile(graph: AgentMuxSpatialGraph, profileId: string): SavedBrowserUse[] {
  return graph.regions.flatMap(region => {
    if (region.kind !== 'browser' || !region.browserId) return []
    if (!graph.tabs.some(tab => tab.tabId === region.tabId && tab.regionIds.includes(region.regionId))) return []
    const data = graph.resources['region:' + region.regionId]
    if (!data || typeof data !== 'object' || Array.isArray(data)) return []
    if (data.mode === 'private' || data.capsuleId !== undefined || data.profileId !== profileId) return []
    return [{ browserId: region.browserId, title: typeof data.title === 'string' ? data.title : '', url: typeof data.url === 'string' ? data.url : '' }]
  })
}
