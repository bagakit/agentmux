import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { WorkspaceRecord } from './contracts'
import { directoryIdentity, workspaceZoneId } from './space-addresses'

/** A completed display move never changes an execution or file resource descriptor. */
export function closeWorktreeGraph(
  original: AgentMuxSpatialGraph,
  source: WorkspaceRecord,
  target: WorkspaceRecord
): { graph: AgentMuxSpatialGraph; movedTabIds: string[] } {
  const graph = structuredClone(original)
  const oldZones = new Set(graph.zones.filter(zone => zone.workspaceId === source.id).map(zone => zone.zoneId))
  const spaceId = directoryIdentity(target.hostId, target.repoPath ?? target.path)
  const zoneId = workspaceZoneId(spaceId, target.id)
  if (!graph.zones.some(zone => zone.zoneId === zoneId)) {
    graph.zones.push({ zoneId, workspaceId: target.id, kind: 'directory', hostId: target.hostId,
      directoryPath: target.path, branch: target.branch ?? null })
    graph.bindings.push({ zoneId, spaceId })
    graph.resources['zone:' + zoneId] = { spaceId, workspaceId: target.id }
  }
  if (!graph.spaces.some(space => space.spaceId === spaceId)) {
    graph.spaces.push({ spaceId, kind: 'folder', name: target.name, hostId: target.hostId,
      directoryPath: target.repoPath ?? target.path, projectId: spaceId })
  }
  const movedTabIds: string[] = []
  for (const tab of graph.tabs) {
    if (tab.workspaceId !== source.id && !oldZones.has(tab.zoneId ?? '')) continue
    movedTabIds.push(tab.tabId)
    tab.workspaceId = target.id
    tab.zoneId = zoneId
    // This Tab's resource membership is now exact; its old membership diagnostic
    // does not apply to the new Zone. Region/Host availability remains separate.
    delete tab.issue
    const metadata = graph.resources['tab:' + tab.tabId]
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const descriptor = metadata.space
      metadata.space = { ...(descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor) ? descriptor : {}), spaceId, zoneId }
    }
  }
  const sourceLayout = graph.layouts[source.id], targetLayout = graph.layouts[target.id]
  if (sourceLayout) {
    if (!targetLayout) graph.layouts[target.id] = sourceLayout
    else {
      const used = new Set(targetLayout.groups.map(group => group.id))
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
      const hasRoot = (root: typeof targetLayout.root): boolean => same(root, sourceLayout.root) || root.type === 'split' && (hasRoot(root.first) || hasRoot(root.second))
      const alreadyMoved = sourceLayout.groups.every(group => targetLayout.groups.some(current => current.id === group.id && same(current, group))) && hasRoot(targetLayout.root)
      if (!alreadyMoved && sourceLayout.groups.some(group => used.has(group.id))) {
        throw new Error('Source and default workspace share a Group identity. Keep both workfaces and inspect their original layout.')
      }
      if (!alreadyMoved) graph.layouts[target.id] = { ...targetLayout,
        root: { type: 'split', direction: 'vertical', ratio: 0.5, first: targetLayout.root, second: sourceLayout.root },
        groups: [...targetLayout.groups, ...sourceLayout.groups] }
    }
    delete graph.layouts[source.id]
  }
  graph.zones = graph.zones.filter(zone => !oldZones.has(zone.zoneId))
  graph.bindings = graph.bindings.filter(binding => !oldZones.has(binding.zoneId))
  for (const id of oldZones) delete graph.resources['zone:' + id]
  return { graph, movedTabIds }
}

/** Closed records retain resource ownership, never ordinary navigation membership. */
export function openWorkspaces(workspaces: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return workspaces.filter(workspace => !workspace.closeout)
}

export function closeoutDestination(workspaces: readonly WorkspaceRecord[], source: WorkspaceRecord): WorkspaceRecord | undefined {
  return openWorkspaces(workspaces).find(workspace => workspace.id !== source.id && workspace.kind === 'folder' &&
    workspace.hostId === source.hostId && workspace.path === source.repoPath)
}
