import { parseAmuxObjectLink, type AmuxObjectLinkTarget } from './sharing.js'
import type { AgentMuxSpaceCatalog, AgentMuxSpaceLocation } from './space-control.js'
import type { AgentMuxSearchTarget } from './search-contract.js'
import type { AgentSessionHistoryDescriptor } from './types.js'

type Identity = { agent: Set<string>; region: Set<string>; tab: Set<string>; space: Set<string>; zone: Set<string>; ids: Set<string>; text: string[] }
const identity = (): Identity => ({ agent: new Set(), region: new Set(), tab: new Set(), space: new Set(), zone: new Set(), ids: new Set(), text: [] })
const add = (set: Set<string>, ...values: (string | null | undefined)[]) => { for (const value of values) if (value) set.add(value) }
const targetId = (target: AmuxObjectLinkTarget) => target.kind === 'agent' ? target.agentSessionId : target.kind === 'region' ? target.regionId : target.kind === 'tab' ? target.tabId : target.kind === 'space' ? target.spaceId : target.zoneId
export const agentMuxSearchSessionKey = (hostId: string, sessionId: string, kind: 'agent' | 'terminal' = 'agent') => JSON.stringify([hostId, kind, sessionId])
export type AgentMuxSearchLocation = { reference: Pick<AgentMuxSpaceLocation, 'displayWorkspaceId' | 'groupId' | 'tabId' | 'regionId'>; name: string; kind: string; address: string; sessionId: string | null }

/** Disposable filtering of original facts. Links keep their type and exact identity. */
export type AgentMuxSearchSession = {
  agentSessionId: string; hostId: string; kind: 'agent' | 'terminal'
  workspaceId?: string; workspacePath?: string; topicId?: string | null
  /** Original observed IDs and searchable presentation; never control authority. */
  identities: readonly string[]; text: readonly string[]
}
export type AgentMuxSearchProject = { hostId: string; projectId: string; name: string; sessionIds: readonly string[] }
export type AgentMuxSearchObject = { target: AgentMuxSearchTarget; name: string; identities: readonly string[]; text: readonly string[]; locations: readonly AgentMuxSearchLocation[] }
export type AgentMuxSearchMetadata = {
  objects?: readonly AgentMuxSearchObject[]
  sessions: readonly AgentMuxSearchSession[]; catalog: AgentMuxSpaceCatalog
  sources: readonly AgentSessionHistoryDescriptor[]; projects: readonly AgentMuxSearchProject[]
}
export type AgentMuxSearchSessionReference = { hostId: string; agentSessionId: string; kind: 'agent' | 'terminal' }
export type AgentMuxSearchProjectReference = { hostId: string; projectId: string }
/** Query only supplied original observations. No IO, history body, global state or Run control. */
export function searchAgentMuxMetadata(query: string, input: AgentMuxSearchMetadata) {
  const raw = query.trim(), text = raw.toLocaleLowerCase()
  if (!raw) {
    const sessions = new Map<string, AgentMuxSearchSessionReference>()
    for (const row of input.sessions) sessions.set(JSON.stringify([row.hostId, row.kind, row.agentSessionId]), { hostId: row.hostId, kind: row.kind, agentSessionId: row.agentSessionId })
    for (const source of input.sources) sessions.set(JSON.stringify([source.hostId, 'agent', source.agentSessionId]), { hostId: source.hostId, kind: 'agent', agentSessionId: source.agentSessionId })
    return { sessions: [...sessions.values()], projects: input.projects.map(({hostId, projectId}) => ({hostId, projectId})), locations: [] as AgentMuxSearchLocation[], objects: [...input.objects ?? []], unplaced: [] as { kind: 'space' | 'zone' | 'tab' | 'region'; id: string; name: string }[], issue: null as string | null }
  }
  let target: AmuxObjectLinkTarget | undefined, issue: string | null = null
  if (/^amux:/iu.test(raw)) {
    try { target = parseAmuxObjectLink(raw) } catch (error) { issue = error instanceof Error ? error.message : String(error) }
  }
  const matches = (fact: Identity) => !issue && (!raw || (target
    ? fact[target.kind].has(targetId(target))
    : [...fact.agent, ...fact.region, ...fact.tab, ...fact.space, ...fact.zone, ...fact.ids].some(id => id.includes(raw)) || fact.text.some(value => value.toLocaleLowerCase().includes(text))))
  const agents = new Map<string, Identity>()
  const hostsBySession = new Map<string, Set<string>>()
  const agent = (id: string, host: string, kind: 'agent' | 'terminal' = 'agent') => {
    const key = JSON.stringify([host, kind, id]); let fact = agents.get(key)
    if (!fact) {
      fact = identity(); add(fact.ids, id); agents.set(key, fact)
      if (kind === 'agent') { const hosts = hostsBySession.get(id) ?? new Set<string>(); hosts.add(host); hostsBySession.set(id, hosts) }
    }
    return fact
  }
  for (const row of input.sessions) {
    const fact = agent(row.agentSessionId, row.hostId, row.kind)
    if (row.kind === 'agent') add(fact.agent, row.agentSessionId)
    add(fact.ids, row.hostId, row.workspaceId, row.topicId, ...row.identities)
    fact.text.push(...row.text)
  }
  for (const source of input.sources) {
    const fact = agent(source.agentSessionId, source.hostId), history = source.history
    add(fact.agent, source.agentSessionId)
    add(fact.ids, source.hostId, history?.nativeHandle?.sessionId, history?.observedNativeHandle?.sessionId, history?.previousNativeHandle?.sessionId)
    fact.text.push(history?.workspacePath ?? '', history?.providerId ?? '')
  }
  for (const project of input.projects) for (const id of project.sessionIds) {
    for (const kind of ['agent', 'terminal'] as const) {
      const fact = agents.get(JSON.stringify([project.hostId, kind, id]))
      if (fact) { add(fact.ids, project.projectId); fact.text.push(project.name) }
    }
  }
  const tabs = new Map(input.catalog.tabs.map(tab => [tab.tabId, tab]))
  const zones = new Map(input.catalog.zones.map(zone => [zone.zoneId, zone]))
  const spaces = new Map(input.catalog.spaces.map(space => [space.spaceId, space]))
  const spacesByZone = new Map<string, string[]>()
  for (const binding of input.catalog.bindings) {
    const members = spacesByZone.get(binding.zoneId) ?? []; members.push(binding.spaceId); spacesByZone.set(binding.zoneId, members)
  }
  // Resource context supplements only scalar Project/Topic IDs. Aggregate each
  // original Zone/binding once; Session count must not multiply catalog traversal.
  const projectIdsByContext = new Map<string, Set<string>>()
  const resourceKey = (host: string | null, workspace: string, topic: string | null) => JSON.stringify([host, workspace, topic])
  for (const zone of input.catalog.zones) for (const id of spacesByZone.get(zone.zoneId) ?? []) {
    const space = spaces.get(id)
    if (!space || space.hostId !== zone.hostId) continue
    const topics = [...(space.kind === 'folder' ? [null] : []), ...(space.topicId ? [space.topicId] : [])]
    for (const topic of topics) {
      const key = resourceKey(zone.hostId, zone.workspaceId, topic), ids = projectIdsByContext.get(key) ?? new Set<string>()
      add(ids, space.projectId, space.topicId); projectIdsByContext.set(key, ids)
    }
  }
  const locationsByRegion = new Map<string, typeof input.catalog.locations>(), placed = identity()
  for (const location of input.catalog.locations) {
    const key = JSON.stringify([location.tabId, location.regionId]); const group = locationsByRegion.get(key) ?? []
    group.push(location); locationsByRegion.set(key, group)
    add(placed.space, location.spaceId); add(placed.zone, location.zoneId); add(placed.tab, location.tabId); add(placed.region, location.regionId)
  }
  // A Workspace relation never confirms membership of its adjacent Zones.
  for (const row of input.sessions) if (row.workspaceId) {
    const ids = projectIdsByContext.get(resourceKey(row.hostId, row.workspaceId, row.topicId || null))
    if (ids) for (const id of ids) agent(row.agentSessionId, row.hostId, row.kind).ids.add(id)
  }
  const locations: AgentMuxSearchLocation[] = [], seen = new Set<string>()
  for (const region of input.catalog.regions) {
    const tab = tabs.get(region.tabId), zone = tab?.zoneId ? zones.get(tab.zoneId) : undefined
    const fact = identity()
    add(fact.region, region.regionId); add(fact.tab, region.tabId); add(fact.zone, tab?.zoneId)
    if (region.kind === 'agent') add(fact.agent, region.agentSessionId); add(fact.ids, region.runId, region.browserId, tab?.workspaceId, zone?.hostId)
    fact.text.push(tab?.name ?? '', region.kind, zone?.directoryPath ?? '', zone?.branch ?? '', region.file?.path ?? '')
    for (const id of tab?.zoneId ? spacesByZone.get(tab.zoneId) ?? [] : []) {
      const space = spaces.get(id); add(fact.space, id); add(fact.ids, space?.projectId, space?.topicId); fact.text.push(space?.name ?? '')
    }
    const occurrences = locationsByRegion.get(JSON.stringify([region.tabId, region.regionId])) ?? []
    const hosts = region.agentSessionId ? hostsBySession.get(region.agentSessionId) : undefined
    const host = region.execution?.hostId ?? (hosts?.size === 1 ? hosts.values().next().value : undefined)
    const row = region.agentSessionId && host !== undefined ? agents.get(JSON.stringify([host, 'agent', region.agentSessionId])) : undefined
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
    ...input.catalog.spaces.map(space => ({ kind: 'space' as const, id: space.spaceId, name: space.name, fact: (() => { const fact = identity(); add(fact.space, space.spaceId); add(fact.ids, space.projectId, space.topicId, space.hostId); fact.text.push(space.name, space.directoryPath); return fact })() })),
    ...input.catalog.zones.map(zone => ({ kind: 'zone' as const, id: zone.zoneId, name: zone.directoryPath ?? zone.zoneId, fact: (() => { const fact = identity(); add(fact.zone, zone.zoneId); add(fact.ids, zone.workspaceId, zone.hostId); fact.text.push(zone.directoryPath ?? '', zone.branch ?? ''); return fact })() })),
    ...input.catalog.tabs.map(tab => ({ kind: 'tab' as const, id: tab.tabId, name: tab.name ?? tab.tabId, fact: (() => { const fact = identity(); add(fact.tab, tab.tabId); add(fact.ids, tab.workspaceId); return fact })() })),
    ...input.catalog.regions.map(region => ({ kind: 'region' as const, id: region.regionId, name: region.regionId, fact: (() => { const fact = identity(); add(fact.region, region.regionId); return fact })() }))
  ].filter(object => raw && matches(object.fact) && !placed[object.kind].has(object.id))
  const sessions: AgentMuxSearchSessionReference[] = []
  for (const [key, fact] of agents) if (matches(fact)) {
    const [hostId, kind, agentSessionId] = JSON.parse(key) as [string, 'agent' | 'terminal', string]
    sessions.push({ hostId, agentSessionId, kind })
  }
  const projects: AgentMuxSearchProjectReference[] = input.projects.filter(project => {
    const fact = identity(); add(fact.ids, project.hostId, project.projectId); fact.text.push(project.name)
    return matches(fact) || project.sessionIds.some(id => (['agent', 'terminal'] as const).some(kind => { const member = agents.get(JSON.stringify([project.hostId, kind, id])); return member ? matches(member) : false }))
  }).map(({hostId, projectId}) => ({hostId, projectId}))
  const objects = (input.objects ?? []).filter(object => {
    const fact = identity(), original = object.target
    if (original.kind === 'agent' || original.kind === 'region' || original.kind === 'tab' || original.kind === 'space' || original.kind === 'zone') add(fact[original.kind], targetId(original))
    else add(fact.ids, original.kind === 'terminal' ? original.terminalId : original.kind === 'project' ? original.projectId : original.kind === 'workspace' ? original.workspaceId : original.topicId)
    add(fact.ids, original.hostId, ...object.identities); fact.text.push(object.name, ...object.text)
    return matches(fact)
  })
  return { sessions, projects, locations, objects, unplaced: unplaced.map(({fact: _fact, ...object}) => object), issue }
}
