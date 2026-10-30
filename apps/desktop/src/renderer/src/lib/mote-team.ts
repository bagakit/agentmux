import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { WorkbenchTab } from './workbench-tabs'
import { agentSessionPresentationIndex, sessionPresentationById } from './session-presentation'

export type MoteMember = {
  key: string
  hostId: string | null
  agentSessionId: string
  regions: { tabId: string; regionId: string; title: string | null }[]
  locations: WorkbenchProjectionSelection[]
}

/** An original display reference can join its exact snapshot while Core topology is being observed.
 * A known execution Host always wins; it must never fall through to another Host's equal ID. */
export function moteMemberSnapshot(member: MoteMember, tabs: Readonly<Record<string, WorkbenchTab>>, sessions: readonly SessionSnapshot[]) {
  if (member.hostId !== null) {
    const candidates = (agentSessionPresentationIndex(sessions).get(member.agentSessionId) ?? []).filter(session =>
      session.control.hostId === member.hostId && session.control.agentSessionId === member.agentSessionId)
    return candidates.length === 1 ? candidates[0] : undefined
  }
  const index = sessionPresentationById(sessions)
  const candidates = [...new Set(member.regions.flatMap(item => {
    const region = tabs[item.tabId]?.regions[item.regionId]
    const snapshot = region?.kind === 'agent' ? index.get(region.sessionId) : undefined
    return snapshot?.kind === 'agent' && (snapshot.id === member.agentSessionId || snapshot.control.agentSessionId === member.agentSessionId) ? [snapshot] : []
  }))]
  return candidates.length === 1 ? candidates[0] : undefined
}

/** A reading projection of the original graph, including unplaced members. No execution facts. */
export function moteMembers(catalog: AgentMuxSpaceCatalog, spaceId: string): MoteMember[] {
  const zones = new Set(catalog.bindings.filter(binding => binding.spaceId === spaceId).map(binding => binding.zoneId))
  const tabs = new Map(catalog.tabs.filter(tab => tab.zoneId !== null && zones.has(tab.zoneId)).map(tab => [tab.tabId, tab]))
  const members = new Map<string, MoteMember>()
  for (const region of catalog.regions) {
    const tab = tabs.get(region.tabId)
    if (!tab || region.kind !== 'agent' || !region.agentSessionId) continue
    const hostId = region.execution?.hostId ?? null
    // An unavailable execution Host cannot establish that two equal Session strings are one Agent.
    const key = JSON.stringify(hostId ? [hostId, region.agentSessionId] : [null, region.agentSessionId, tab.tabId, region.regionId])
    const member = members.get(key) ?? { key, hostId, agentSessionId: region.agentSessionId, regions: [], locations: [] }
    member.regions.push({ tabId: tab.tabId, regionId: region.regionId, title: tab.name })
    for (const location of catalog.locations) {
      if (location.spaceId !== spaceId || location.tabId !== tab.tabId || location.regionId !== region.regionId) continue
      const reference = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
      if (!member.locations.some(item => JSON.stringify(item) === JSON.stringify(reference))) member.locations.push(reference)
    }
    members.set(key, member)
  }
  return [...members.values()]
}
