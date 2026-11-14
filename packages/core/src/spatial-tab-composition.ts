import { AgentMuxError } from './errors.js'
import type { AgentMuxSpatialGraph } from './spatial-graph.js'

export type AgentMuxSpatialTabCompositionInput = {
  target: { zoneId: string; workspaceId: string }
  tabs: readonly { tabId: string; zoneId: string | null; regionIds: readonly string[] }[]
}

/** Change original Tab membership only. Region resources, layout and all display bindings stay owned by their originals. */
export function composeSpatialTabs(graph: AgentMuxSpatialGraph, input: AgentMuxSpatialTabCompositionInput): AgentMuxSpatialGraph {
  const target = graph.zones.find(zone => zone.zoneId === input.target.zoneId)
  if (!target || target.workspaceId !== input.target.workspaceId) throw new AgentMuxError(
    'The original destination Zone changed. Every original Tab and resource is kept; choose its current exact target.', 'SPACE_COMPOSITION_TARGET_CHANGED')
  const ids = new Set(input.tabs.map(tab => tab.tabId))
  if (!ids.size || ids.size !== input.tabs.length) throw new AgentMuxError(
    'Choose each original Tab once for this composition.', 'SPACE_COMPOSITION_SOURCE_INVALID')
  // Check the whole frozen set before deriving any change. A later member never widens this request.
  for (const expected of input.tabs) {
    const tab = graph.tabs.find(tab => tab.tabId === expected.tabId)
    if (!tab || tab.zoneId !== expected.zoneId || new Set(expected.regionIds).size !== expected.regionIds.length || tab.regionIds.length !== expected.regionIds.length ||
      !expected.regionIds.every(id => tab.regionIds.includes(id))) throw new AgentMuxError(
      'The original Tab composition changed. No part was moved; read these same sources before another request.', 'SPACE_COMPOSITION_SOURCE_CHANGED')
  }
  return { ...graph, tabs: graph.tabs.map(tab => ids.has(tab.tabId)
    ? { ...tab, zoneId: target.zoneId, workspaceId: target.workspaceId } : tab) }
}
