import type { AgentMuxSpaceAddress, AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { summarizeAgentWorkLocations, type AgentWorkLocationSummary } from '@agentmux/client-ui/patterns/agent-work-location'
import type { MobileMemberSelection } from './mobile-member-target'

export type MobileAgentLocations = {
  hostId: string | null
  agentSessionId: string
  addresses: AgentMuxSpaceAddress[]
  summary: AgentWorkLocationSummary
}
export type MobileAgentLocationChoice = { place: AgentMuxSpaceAddress; member: MobileMemberSelection | undefined }
export const agentLocationKey = (hostId: string | null, id: string) => JSON.stringify([hostId, id])
export const locationPositionKey = (place: AgentMuxSpaceAddress) => JSON.stringify([place.displayWorkspaceId, place.groupId, place.tabId, place.regionId])
export const locationContextKey = (place: AgentMuxSpaceAddress) => JSON.stringify([place.spaceId, place.zoneId, place.workspaceId, locationPositionKey(place)])

/** Derive once per original Catalog. Each exact route retains its own membership and resource. */
export function mobileAgentLocations(catalog: AgentMuxSpaceCatalog | null) {
  const byAgent = new Map<string, MobileAgentLocations>()
  const bySession = new Map<string, MobileAgentLocations[]>()
  const regions = new Map<string, AgentMuxSpaceCatalog['regions']>()
  for (const region of catalog?.regions ?? []) {
    if (region.kind !== 'agent' || !region.agentSessionId) continue
    const hostId = region.execution?.hostId ?? null, key = agentLocationKey(hostId, region.agentSessionId)
    if (!byAgent.has(key)) {
      const group: MobileAgentLocations = { hostId, agentSessionId: region.agentSessionId, addresses: [], summary: { state: 'unconfirmed' } }
      byAgent.set(key, group)
      const values = bySession.get(region.agentSessionId) ?? []
      values.push(group)
      bySession.set(region.agentSessionId, values)
    }
    const tuple = JSON.stringify([region.tabId, region.regionId]), values = regions.get(tuple) ?? []
    values.push(region)
    regions.set(tuple, values)
  }
  const contexts = new Map<MobileAgentLocations, Set<string>>()
  for (const place of catalog?.locations ?? []) for (const region of regions.get(JSON.stringify([place.tabId, place.regionId])) ?? []) {
    const group = byAgent.get(agentLocationKey(region.execution?.hostId ?? null, region.agentSessionId!))!
    const seen = contexts.get(group) ?? new Set<string>(), exact = locationContextKey(place)
    if (seen.has(exact)) continue
    group.addresses.push(place)
    seen.add(exact)
    contexts.set(group, seen)
  }
  for (const group of byAgent.values()) if (group.hostId !== null)
    group.summary = summarizeAgentWorkLocations({ state: 'confirmed', positions: group.addresses.map(locationPositionKey) })
  return { byAgent, bySession }
}

function matchingAgents(catalog: AgentMuxSpaceCatalog, hostId: string, id: string, place: AgentMuxSpaceAddress) {
  return catalog.regions.filter(region => region.kind === 'agent' && region.tabId === place.tabId && region.regionId === place.regionId &&
    region.agentSessionId === id && region.execution?.hostId === hostId)
}

/** The selected route and original member must still agree in the fresh Source catalog. */
export function confirmsAgentLocation(catalog: AgentMuxSpaceCatalog, hostId: string, id: string, place: AgentMuxSpaceAddress, original: AgentMuxSpaceCatalog) {
  const exact = locationContextKey(place)
  if (!catalog.locations.some(value => locationContextKey(value) === exact)) return false
  const before = matchingAgents(original, hostId, id, place), after = matchingAgents(catalog, hostId, id, place)
  const [previous] = before, [current] = after
  if (!previous || !current || before.length !== 1 || after.length !== 1) return false
  return previous.execution?.runtimeId === current.execution?.runtimeId &&
    previous.creationOperationId === current.creationOperationId && previous.association?.operationId === current.association?.operationId
}
