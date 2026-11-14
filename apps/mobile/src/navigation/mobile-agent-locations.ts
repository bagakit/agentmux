import type { AgentMuxSpaceAddress, AgentMuxSpaceCatalog } from '@agentmux/core/control'

export type MobileAgentLocations = { hostId: string | null; agentSessionId: string; addresses: AgentMuxSpaceAddress[]; count: number }
export const agentLocationKey = (hostId: string | null, id: string) => JSON.stringify([hostId, id])
export const locationContextKey = (place: AgentMuxSpaceAddress) => JSON.stringify([place.spaceId, place.zoneId, place.workspaceId, place.displayWorkspaceId, place.groupId, place.tabId, place.regionId])

/** Derive once per original Catalog, never from Session state, names or execution cwd. */
export function mobileAgentLocations(catalog: AgentMuxSpaceCatalog | null) {
  const byAgent = new Map<string, MobileAgentLocations>()
  const bySession = new Map<string, MobileAgentLocations[]>()
  const regions = new Map<string, AgentMuxSpaceCatalog['regions']>()
  for (const region of catalog?.regions ?? []) {
    if (region.kind !== 'agent' || !region.agentSessionId) continue
    const hostId = region.execution?.hostId ?? null, key = agentLocationKey(hostId, region.agentSessionId)
    if (!byAgent.has(key)) {
      const group = { hostId, agentSessionId: region.agentSessionId, addresses: [], count: 0 }
      byAgent.set(key, group)
      const values = bySession.get(region.agentSessionId) ?? []; values.push(group); bySession.set(region.agentSessionId, values)
    }
    const tuple = JSON.stringify([region.tabId, region.regionId]), values = regions.get(tuple) ?? []
    values.push(region); regions.set(tuple, values)
  }
  const contexts = new Map<string, Set<string>>(), physical = new Map<string, Set<string>>()
  for (const place of catalog?.locations ?? []) for (const region of regions.get(JSON.stringify([place.tabId, place.regionId])) ?? []) {
    const key = agentLocationKey(region.execution?.hostId ?? null, region.agentSessionId!)
    const group = byAgent.get(key)!, seen = contexts.get(key) ?? new Set<string>(), exact = locationContextKey(place)
    if (!seen.has(exact)) group.addresses.push(place)
    seen.add(exact); contexts.set(key, seen)
    const positions = physical.get(key) ?? new Set<string>()
    positions.add(JSON.stringify([place.displayWorkspaceId, place.groupId, place.tabId, place.regionId]))
    physical.set(key, positions); group.count = positions.size
  }
  return { byAgent, bySession }
}

/** A selected context must still bind this exact Host/Session and physical tuple. */
export function confirmsAgentLocation(catalog: AgentMuxSpaceCatalog, hostId: string, id: string, place: AgentMuxSpaceAddress) {
  return catalog.locations.some(value => locationContextKey(value) === locationContextKey(place)) &&
    catalog.regions.some(region => region.kind === 'agent' && region.tabId === place.tabId && region.regionId === place.regionId &&
      region.agentSessionId === id && region.execution?.hostId === hostId)
}
