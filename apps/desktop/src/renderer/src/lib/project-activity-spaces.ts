import type { AgentMuxSpaceCatalog, AgentMuxSpaceLocation } from '@agentmux/core/control'
import type { SessionSnapshot } from '../../../shared/contracts'
import { tabDisplayName, type WorkbenchTab } from './workbench-tabs'

export type AgentSession = Extract<SessionSnapshot, { kind: 'agent' }>
export type ActivityTab = {
  key: string
  label: string
  location: AgentMuxSpaceLocation
  agents: { session: AgentSession; location: AgentMuxSpaceLocation }[]
}
export type ActivityZone = {
  key: string
  zoneId: string | null
  label: string
  path: string | null
  hostId: string | null
  tabs: ActivityTab[]
  sessions: AgentSession[]
}
type RegionReference = { tabId: string; regionId: string; agentSessionId: string }
type ExecutionFor = (reference: RegionReference) => { hostId: string } | null
const subjectKey = (hostId: string, sessionId: string) => JSON.stringify([hostId, sessionId])
const regionKey = (tabId: string, regionId: string) => JSON.stringify([tabId, regionId])

/** Project actual workfaces without changing activity membership or execution identity. */
export function buildActivitySpaces(sessions: readonly SessionSnapshot[], catalog: AgentMuxSpaceCatalog,
  tabs: Readonly<Record<string, WorkbenchTab>>, executionFor: ExecutionFor): { zones: ActivityZone[]; unplaced: AgentSession[] } {
  const subjects = new Map(sessions.filter((session): session is AgentSession => session.kind === 'agent')
    .map(session => [subjectKey(session.hostId, session.id), session]))
  const regions = new Map(catalog.regions.map(region => [regionKey(region.tabId, region.regionId), region]))
  const zoneFacts = new Map(catalog.zones.map(zone => [zone.zoneId, zone]))
  const occurrences = new Set<string>()
  const confirmed: { session: AgentSession; location: AgentMuxSpaceLocation }[] = []
  const regionSessions = new Map<string, AgentSession>()
  for (const location of catalog.locations) {
    const occurrence = JSON.stringify([location.displayWorkspaceId, location.groupId, location.tabId, location.regionId])
    if (occurrences.has(occurrence)) continue
    occurrences.add(occurrence)
    const key = regionKey(location.tabId, location.regionId)
    const region = regions.get(key), surface = tabs[location.tabId]?.regions[location.regionId]
    if (region?.kind !== 'agent' || !region.agentSessionId || surface?.kind !== 'agent') continue
    // A display Host, cwd or navigation-only catalog cannot substitute the original execution Host.
    const execution = executionFor({ tabId: location.tabId, regionId: location.regionId, agentSessionId: region.agentSessionId })
    const session = execution ? subjects.get(subjectKey(execution.hostId, surface.sessionId)) : undefined
    if (!session || session.control.agentSessionId !== region.agentSessionId) continue
    confirmed.push({ session, location })
    regionSessions.set(key, session)
  }

  const zoneMap = new Map<string, ActivityZone>()
  const zoneSubjects = new Map<string, Set<string>>()
  const tabMap = new Map<string, ActivityTab>()
  const placed = new Set<string>()
  for (const agent of confirmed) {
    const { session, location } = agent
    const zoneKey = JSON.stringify([location.zoneId])
    let zone = zoneMap.get(zoneKey)
    if (!zone) {
      const fact = location.zoneId === null ? undefined : zoneFacts.get(location.zoneId)
      const path = fact?.directoryPath ?? null
      zone = { key: zoneKey, zoneId: location.zoneId,
        label: location.zoneId === null ? 'Unbound workfaces' : fact?.branch || path?.split('/').filter(Boolean).at(-1) || fact?.kind || 'unknown',
        path, hostId: fact?.hostId ?? null, tabs: [], sessions: [] }
      zoneMap.set(zoneKey, zone)
      zoneSubjects.set(zoneKey, new Set())
    }
    const tabKey = JSON.stringify([location.displayWorkspaceId, location.groupId, location.tabId])
    let tab = tabMap.get(tabKey)
    if (!tab) {
      const original = tabs[location.tabId]!
      tab = { key: tabKey, location, agents: [], label: tabDisplayName({ tab: original, fallback: 'Workbench',
        agentFactsFor: sessionId => {
          const matches = Object.values(original.regions).flatMap(surface => {
            const match = regionSessions.get(regionKey(original.id, surface.regionId))
            return match?.id === sessionId ? [match] : []
          })
          const match = matches[0]
          return match && matches.every(candidate => candidate.hostId === match.hostId)
            ? { fallbackLabel: match.label, providerLabel: match.providerId } : null
        } }) }
      tabMap.set(tabKey, tab)
      zone.tabs.push(tab)
    }
    tab.agents.push(agent)
    const subject = subjectKey(session.hostId, session.id)
    if (!zoneSubjects.get(zoneKey)!.has(subject)) {
      zoneSubjects.get(zoneKey)!.add(subject)
      zone.sessions.push(session)
    }
    placed.add(subject)
  }
  return { zones: [...zoneMap.values()], unplaced: [...subjects].filter(([key]) => !placed.has(key)).map(([, session]) => session) }
}
