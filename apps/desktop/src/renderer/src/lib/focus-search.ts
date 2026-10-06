import { parseAmuxObjectLink, type AmuxObjectLinkTarget } from '@agentmux/core/sharing'
import type { AgentMuxSpaceCatalog, AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { AgentFocusHistoryEntry } from './agent-focus'
import type { FocusContext } from './focus-context'
import { focusProjectKey, type FocusProjectLane, type FocusRetainedProject } from './focus-project-lanes'
import type { WorkbenchProjectionSelection } from './workbench-projection'

type Identity = { agent: Set<string>; region: Set<string>; tab: Set<string>; space: Set<string>; zone: Set<string>; ids: Set<string>; text: string[] }
const identity = (): Identity => ({ agent: new Set(), region: new Set(), tab: new Set(), space: new Set(), zone: new Set(), ids: new Set(), text: [] })
const add = (set: Set<string>, ...values: (string | null | undefined)[]) => { for (const value of values) if (value) set.add(value) }
const targetId = (target: AmuxObjectLinkTarget) => target.kind === 'agent' ? target.agentSessionId : target.kind === 'region' ? target.regionId : target.kind === 'tab' ? target.tabId : target.kind === 'space' ? target.spaceId : target.zoneId
export const focusSearchContextKey = (hostId: string, sessionId: string) => JSON.stringify([hostId, sessionId])
export type FocusSearchLocation = { reference: WorkbenchProjectionSelection; name: string; kind: string; address: string; sessionId: string | null }

/** Disposable filtering of original facts. Links keep their type and exact identity. */
export function searchFocus(query: string, input: {
  rows: readonly FocusContext[]; lanes: readonly FocusProjectLane[]; catalog: AgentMuxSpaceCatalog
  sources: readonly AgentSessionHistoryDescriptor[]; history: readonly AgentFocusHistoryEntry[]; retained: readonly FocusRetainedProject[]
}) {
  const raw = query.trim(), text = raw.toLocaleLowerCase()
  if (!raw) return { contextKeys: new Set(input.rows.map(row => focusSearchContextKey(row.hostId, row.id))), projectKeys: new Set(input.retained.map(project => project.key)), locations: [] as FocusSearchLocation[], sources: [] as AgentSessionHistoryDescriptor[], unplaced: [] as { kind: 'space' | 'zone' | 'tab' | 'region'; id: string; name: string }[], issue: null as string | null }
  let target: AmuxObjectLinkTarget | undefined, issue: string | null = null
  if (/^amux:/iu.test(raw)) {
    try { target = parseAmuxObjectLink(raw) } catch (error) { issue = error instanceof Error ? error.message : String(error) }
  }
  const matches = (fact: Identity) => !issue && (!raw || (target
    ? fact[target.kind].has(targetId(target))
    : [...fact.agent, ...fact.region, ...fact.tab, ...fact.space, ...fact.zone, ...fact.ids].some(id => id.includes(raw)) || fact.text.some(value => value.toLocaleLowerCase().includes(text))))
  const agents = new Map<string, Identity>()
  const hostsBySession = new Map<string, Set<string>>()
  const agent = (id: string, host: string) => {
    const key = focusSearchContextKey(host, id); let fact = agents.get(key)
    if (!fact) { fact = identity(); add(fact.agent, id); agents.set(key, fact); const hosts = hostsBySession.get(id) ?? new Set<string>(); hosts.add(host); hostsBySession.set(id, hosts) }
    return fact
  }
  for (const row of input.rows) {
    const fact = agent(row.id, row.hostId)
    add(fact.ids, row.runId, row.nativeSessionId, row.workspaceId, row.hostId, row.topicId, ...row.retainedRunIds ?? [])
    fact.text.push(row.name, row.detail, row.recap?.text ?? '', row.stateLabel, row.workspacePath, row.workspaceName, row.providerId ?? '')
  }
  for (const lane of input.lanes) for (const id of lane.contextIds) {
    const fact = agent(id, lane.hostId); add(fact.ids, lane.workspaceId, lane.projectWorkspaceId, lane.topicId); fact.text.push(lane.name)
  }
  for (const source of input.sources) {
    const fact = agent(source.agentSessionId, source.hostId), history = source.history
    add(fact.ids, source.hostId, history?.nativeHandle?.sessionId, history?.observedNativeHandle?.sessionId, history?.previousNativeHandle?.sessionId)
    fact.text.push(history?.workspacePath ?? '', history?.providerId ?? '')
  }
  for (const entry of input.history) {
    const fact = agent(entry.sessionId, entry.identity?.hostId ?? ''), saved = entry.identity
    if (saved) { add(fact.ids, saved.hostId, saved.project?.id, saved.topicId); fact.text.push(saved.name, saved.workspacePath, saved.project?.name ?? '', saved.branch ?? '', saved.topicId ?? '') }
  }
  const tabs = new Map(input.catalog.tabs.map(tab => [tab.tabId, tab]))
  const zones = new Map(input.catalog.zones.map(zone => [zone.zoneId, zone]))
  const spaces = new Map(input.catalog.spaces.map(space => [space.spaceId, space]))
  const spacesByZone = new Map<string, string[]>()
  for (const binding of input.catalog.bindings) {
    const members = spacesByZone.get(binding.zoneId) ?? []; members.push(binding.spaceId); spacesByZone.set(binding.zoneId, members)
  }
  const zonesByWorkspace = new Map<string, typeof input.catalog.zones>()
  for (const zone of input.catalog.zones) {
    const key = JSON.stringify([zone.hostId, zone.workspaceId]); const group = zonesByWorkspace.get(key) ?? []
    group.push(zone); zonesByWorkspace.set(key, group)
  }
  const locationsByRegion = new Map<string, typeof input.catalog.locations>(), placed = identity()
  for (const location of input.catalog.locations) {
    const key = JSON.stringify([location.tabId, location.regionId]); const group = locationsByRegion.get(key) ?? []
    group.push(location); locationsByRegion.set(key, group)
    add(placed.space, location.spaceId); add(placed.zone, location.zoneId); add(placed.tab, location.tabId); add(placed.region, location.regionId)
  }
  // A resource Workspace confirms a Project reference, never membership of
  // every Zone using that Workspace. Spatial links require original placements.
  for (const row of input.rows) for (const zone of zonesByWorkspace.get(JSON.stringify([row.hostId, row.workspaceId])) ?? []) {
    for (const id of spacesByZone.get(zone.zoneId) ?? []) {
      const space = spaces.get(id)
      if (!space || space.hostId !== row.hostId || (row.topicId ? space.topicId !== row.topicId : space.kind !== 'folder')) continue
      const fact = agent(row.id, row.hostId); add(fact.ids, space.projectId, space.topicId)
    }
  }
  const locations: FocusSearchLocation[] = [], seen = new Set<string>()
  for (const region of input.catalog.regions) {
    const tab = tabs.get(region.tabId), zone = tab?.zoneId ? zones.get(tab.zoneId) : undefined
    const fact = identity()
    add(fact.region, region.regionId); add(fact.tab, region.tabId); add(fact.zone, tab?.zoneId)
    add(fact.agent, region.agentSessionId); add(fact.ids, region.runId, region.browserId, tab?.workspaceId, zone?.hostId)
    fact.text.push(tab?.name ?? '', region.kind, zone?.directoryPath ?? '', zone?.branch ?? '', region.file?.path ?? '')
    for (const id of tab?.zoneId ? spacesByZone.get(tab.zoneId) ?? [] : []) {
      const space = spaces.get(id); add(fact.space, id); add(fact.ids, space?.projectId, space?.topicId); fact.text.push(space?.name ?? '')
    }
    const occurrences = locationsByRegion.get(JSON.stringify([region.tabId, region.regionId])) ?? []
    const hosts = region.agentSessionId ? hostsBySession.get(region.agentSessionId) : undefined
    const host = region.execution?.hostId ?? (hosts?.size === 1 ? hosts.values().next().value : undefined)
    const row = region.agentSessionId && host !== undefined ? agents.get(focusSearchContextKey(host, region.agentSessionId)) : undefined
    if (row) for (const key of ['agent', 'region', 'tab', 'space', 'zone', 'ids'] as const) for (const id of fact[key]) row[key].add(id)
    if (row) for (const location of occurrences) add(row.ids, location.workspaceId, location.displayWorkspaceId, location.groupId)
    // Resource entries keep every exact occurrence. They never borrow an Agent's target.
    if (raw) for (const location of occurrences) {
      const own = { ...fact, ids: new Set(fact.ids) }
      add(own.ids, location.workspaceId, location.displayWorkspaceId, location.groupId)
      if (!matches(own)) continue
      const reference = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
      const address = JSON.stringify(Object.values(reference))
      if (seen.has(address)) continue
      seen.add(address); locations.push({ reference, address, kind: region.kind, name: tab?.name || region.file?.path || region.regionId, sessionId: region.agentSessionId })
    }
  }
  const unplaced = [
    ...input.catalog.spaces.map(space => ({ kind: 'space' as const, id: space.spaceId, name: space.name, fact: (() => { const fact = identity(); add(fact.space, space.spaceId); add(fact.ids, space.projectId, space.topicId, space.hostId); fact.text.push(space.name); return fact })() })),
    ...input.catalog.zones.map(zone => ({ kind: 'zone' as const, id: zone.zoneId, name: zone.directoryPath ?? zone.zoneId, fact: (() => { const fact = identity(); add(fact.zone, zone.zoneId); add(fact.ids, zone.workspaceId, zone.hostId); return fact })() })),
    ...input.catalog.tabs.map(tab => ({ kind: 'tab' as const, id: tab.tabId, name: tab.name ?? tab.tabId, fact: (() => { const fact = identity(); add(fact.tab, tab.tabId); add(fact.ids, tab.workspaceId); return fact })() })),
    ...input.catalog.regions.map(region => ({ kind: 'region' as const, id: region.regionId, name: region.regionId, fact: (() => { const fact = identity(); add(fact.region, region.regionId); return fact })() }))
  ].filter(object => raw && matches(object.fact) && !placed[object.kind].has(object.id))
  const rowIds = new Set(input.rows.map(row => focusSearchContextKey(row.hostId, row.id)))
  const sources = raw ? input.sources.filter(source => !rowIds.has(focusSearchContextKey(source.hostId, source.agentSessionId)) && matches(agent(source.agentSessionId, source.hostId))) : []
  const contextKeys = new Set(input.rows.filter(row => matches(agent(row.id, row.hostId))).map(row => focusSearchContextKey(row.hostId, row.id)))
  const projectKeys = new Set<string>()
  const membersByProject = new Map<string, AgentFocusHistoryEntry[]>()
  for (const entry of input.history) if (entry.identity?.project) {
    const key = focusProjectKey(entry.identity.hostId, entry.identity.project.id), members = membersByProject.get(key) ?? []
    members.push(entry); membersByProject.set(key, members)
  }
  for (const project of input.retained) {
    const members = membersByProject.get(project.key) ?? []
    if (members.some(entry => matches(agent(entry.sessionId, entry.identity?.hostId ?? '')))) projectKeys.add(focusProjectKey(project.hostId, project.projectId))
  }
  return { contextKeys, projectKeys, locations, sources, unplaced, issue }
}
