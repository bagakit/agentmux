import type { AgentMuxBrowserTarget, AgentMuxBrowserResource } from '@agentmux/core'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'

/** Position facts come only from the original Core graph, not URL/title matching. */
export function browserResourceLocations(targets: readonly AgentMuxBrowserTarget[], graph: AgentMuxSpatialGraph | null): AgentMuxBrowserTarget[] {
  const locations = new Map<string, AgentMuxBrowserResource['locations'][number][]>()
  if (graph) {
    const tabs = new Map(graph.tabs.map(tab => [tab.tabId, tab]))
    for (const region of graph.regions) {
      if (region.kind !== 'browser' || !region.browserId) continue
      const tab = tabs.get(region.tabId)
      if (!tab?.regionIds.includes(region.regionId)) continue
      const list = locations.get(region.browserId) ?? []
      list.push({ workspaceId: tab.workspaceId, tabId: tab.tabId, regionId: region.regionId })
      locations.set(region.browserId, list)
    }
  }
  return targets.map(target => target.source === 'external' ? target : { ...target, resource: {
    ...(target.resource ?? { state: 'unknown' as const, processes: null }),
    locations: locations.get(target.id) ?? []
  } })
}
