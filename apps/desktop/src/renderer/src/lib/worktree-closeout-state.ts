import type { AppConfig } from '../../../shared/contracts'
import type { SpatialWorkbench } from './space-agent-control'
import { desktopSpatialGraph, desktopBindingsFromSpatial } from './desktop-spatial-state'
import { directoryIdentity, workspaceZoneId } from '../../../shared/space-addresses'

/** Retain live Region objects and local editors; only their containing workface changes. */
export function rehomeClosedWorkspaces(state: SpatialWorkbench & { activeWorkspaceId: string | null }, config: AppConfig) {
  const closed = config.workspaces.filter(workspace => workspace.closeout)
  if (!closed.length) return {}
  const owners = new Set([...Object.keys(state.layouts), ...Object.values(state.tabs).map(tab => tab.workspaceId)])
  const closing = closed.filter(workspace => owners.has(workspace.id))
  if (!closing.length) return {}
  const graph = desktopSpatialGraph({ ...state, config }, [], null)
  const sources = new Set(closing.map(workspace => workspace.id))
  const zones = new Set(closing.map(workspace => workspaceZoneId(directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path), workspace.id)))
  for (const [id, binding] of Object.entries(state.spaceZoneBindings)) if (sources.has(binding.workspaceId)) zones.add(id)
  const tabs = { ...state.tabs }
  for (const fact of graph.tabs) {
    const tab = tabs[fact.tabId]
    if (!tab || !sources.has(tab.workspaceId) && !zones.has(tab.space?.zoneId ?? '')) continue
    const metadata = graph.resources['tab:' + fact.tabId]
    const space = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata.space : null
    tabs[fact.tabId] = { ...tab, workspaceId: fact.workspaceId,
      ...(space && typeof space === 'object' && !Array.isArray(space) ? { space: space as unknown as NonNullable<typeof tab.space> } : {}) }
  }
  const active = closing.find(workspace => workspace.id === state.activeWorkspaceId)
  const sourceLayout = active ? state.layouts[active.id] : null
  if (active && sourceLayout && graph.layouts[active.closeout!.targetWorkspaceId]?.groups.some(group => group.id === sourceLayout.activeGroupId)) {
    graph.layouts[active.closeout!.targetWorkspaceId]!.activeGroupId = sourceLayout.activeGroupId
  }
  return { tabs, layouts: graph.layouts, spaceZoneBindings: desktopBindingsFromSpatial(graph) }
}
