import type { NotesResourceChange } from '@agentmux/core/notebook-store'
import { NOTES_WORKSPACE_ID } from './notes-library'
import type { AgentMuxSpatialGraph, SpatialJson } from '@agentmux/core/spatial-graph'
/** Rebind exact file and dedicated Notes directory resources; entity IDs, topology and execution cwd stay intact. */
export function reconcileNotesSpatialResources(graph: AgentMuxSpatialGraph, changes: readonly NotesResourceChange[], directoryChanges: readonly { from: string; to: string }[] = []): AgentMuxSpatialGraph {
  let resources = graph.resources
  for (const region of graph.regions) {
    if (region.kind !== 'file') continue
    const key = 'region:' + region.regionId, saved = resources[key] as Record<string, SpatialJson> | undefined
    if (!saved) continue
    const change = changes.find(c => c.from.workspaceId === saved.workspaceId && c.from.path === saved.path)
    if (!change) continue
    if (resources === graph.resources) resources = { ...resources }
    resources[key] = { ...saved, workspaceId: change.to.workspaceId, path: change.to.path }
  }
  let zones = graph.zones
  for (const move of directoryChanges) zones = zones.map(zone => {
    if (zone.workspaceId !== NOTES_WORKSPACE_ID || !zone.directoryPath || (zone.directoryPath !== move.from && !zone.directoryPath.startsWith(move.from + '/'))) return zone
    const directoryPath = move.to + zone.directoryPath.slice(move.from.length), key = 'zone:' + zone.zoneId, saved = resources[key] as Record<string, SpatialJson> | undefined
    if (resources === graph.resources) resources = { ...resources }
    if (saved) resources[key] = { ...saved, directoryPath }
    return { ...zone, directoryPath }
  })
  return resources === graph.resources && zones.every((zone, index) => zone === graph.zones[index]) ? graph : { ...graph, resources, zones }
}
