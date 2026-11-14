import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { WorkspaceLayout } from '@agentmux/layout'

/** Explicit existing spatial destination. No focused/first Group is substituted. */
export type AgentNewTabDestination = { zoneId: string; spaceId?: string; displayWorkspaceId: string; groupId: string; newTab: true }
export function agentNewTabDestinations(catalog: AgentMuxSpaceCatalog, layouts: Readonly<Record<string, WorkspaceLayout>>,
  execution?: { hostId: string; cwd?: string }, presentation?: Pick<AgentNewTabDestination, 'displayWorkspaceId' | 'groupId'>) {
  const displays = (presentation ? [[presentation.displayWorkspaceId, layouts[presentation.displayWorkspaceId]]] as const : Object.entries(layouts))
    .flatMap(([displayWorkspaceId, layout]) => (layout?.groups ?? []).filter(group => !presentation || group.id === presentation.groupId)
      .map(group => ({ displayWorkspaceId, groupId: group.id })))
  return catalog.zones.filter(zone => zone.kind !== 'unknown' && !zone.issue && (!execution || zone.hostId === execution.hostId && (execution.cwd === undefined || zone.directoryPath === execution.cwd))).flatMap(zone => {
    const bindings = catalog.bindings.filter(binding => binding.zoneId === zone.zoneId)
    const spaces = bindings.length ? bindings.flatMap(binding => {
      const space = catalog.spaces.find(item => item.spaceId === binding.spaceId && !item.issue)
      return space ? [space] : []
    }) : [null]
    return spaces.flatMap(space => displays.map(({ displayWorkspaceId, groupId }) => {
      const destination: AgentNewTabDestination = { zoneId: zone.zoneId, ...(space ? { spaceId: space.spaceId } : {}), displayWorkspaceId, groupId, newTab: true }
      return { destination, value: JSON.stringify(destination), label: `${space?.name ?? zone.directoryPath ?? zone.zoneId} · ${displayWorkspaceId} · ${groupId}`,
        description: `${zone.hostId} · ${zone.directoryPath ?? zone.zoneId} · New Tab` }
    }))
  })
}
export function requireAgentNewTabDestination(destination: AgentNewTabDestination, catalog: AgentMuxSpaceCatalog,
  layouts: Readonly<Record<string, WorkspaceLayout>>, execution?: { hostId: string; cwd?: string }): AgentNewTabDestination {
  const exact = agentNewTabDestinations(catalog, layouts, execution, destination).find(item => item.value === JSON.stringify(destination))
  if (!exact) throw new Error('The chosen Space, Zone or Group changed. The original Agent is kept; choose an existing destination again.')
  return { ...exact.destination }
}
