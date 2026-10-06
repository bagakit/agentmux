import type { AgentMuxRpcCoreClient } from './public-rpc-service.js'
import type { AgentMuxRpcSnapshot } from './public-rpc.js'
import type { AgentMuxSpaceCatalog } from './space-control.js'
import type { AgentMuxSearchInput, AgentMuxSearchIssue, AgentMuxSearchTarget } from './search-contract.js'
import type { AgentMuxSearchMetadata, AgentMuxSearchObject } from './search-metadata.js'
import type { AgentMuxSearchOwner, AgentMuxSearchReadContext, AgentMuxSearchSource } from './search-reader.js'
import type { AgentSessionHistoryDescriptor } from './types.js'

export type AgentMuxSearchObservationPorts<C extends AgentMuxSearchReadContext = AgentMuxSearchReadContext> = {
  clients(): Promise<readonly AgentMuxRpcCoreClient[]>
  catalog(context: C): Promise<AgentMuxSpaceCatalog>
  snapshot(context: C): Promise<Partial<AgentMuxRpcSnapshot>>
  projects(context: C): Promise<AgentMuxRpcSnapshot['projects']>
  history: AgentMuxSearchOwner<C>['history']
}
const issue = (source: string, error: unknown, hostId?: string): AgentMuxSearchIssue => ({ source, ...(hostId ? { hostId } : {}),
  code: typeof error === 'object' && error && 'code' in error && typeof error.code === 'string' ? error.code : 'SEARCH_SOURCE_UNAVAILABLE',
  message: error instanceof Error ? error.message : String(error), recovery: 'Retry the original catalog or exact source. Healthy Sessions and Runs remain available.' })
const emptyCatalog = (): AgentMuxSpaceCatalog => ({ spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] })
type Discovery = { scopes: readonly AgentMuxRpcCoreClient[]; descriptors: Array<{ hostId: string; original: AgentSessionHistoryDescriptor }>; issues: AgentMuxSearchIssue[] }

/** Adapt existing owners once. No filesystem, transcript, live status or UI implementation is read here. */
export function createAgentMuxSearchObservationOwner<C extends AgentMuxSearchReadContext = AgentMuxSearchReadContext>(ports: AgentMuxSearchObservationPorts<C>): AgentMuxSearchOwner<C> {
  const discover = async (input: AgentMuxSearchInput, context: C): Promise<Discovery> => {
    const issues: AgentMuxSearchIssue[] = [], descriptors: Discovery['descriptors'] = []
    let scopes: readonly AgentMuxRpcCoreClient[] = []
    try { scopes = (await ports.clients()).filter(scope => !input.hostId || scope.hostId === input.hostId) }
    catch (error) { issues.push(issue('hosts', error, input.hostId)) }
    const counts = new Map<string, number>()
    for (const scope of scopes) counts.set(scope.hostId, (counts.get(scope.hostId) ?? 0) + 1)
    for (const [hostId, count] of counts) if (count !== 1) issues.push(issue('hosts', new Error('The exact search Host route is ambiguous.'), hostId))
    scopes = scopes.filter(scope => counts.get(scope.hostId) === 1)
    if (input.hostId && !scopes.length && !issues.some(value => value.hostId === input.hostId)) issues.push(issue('hosts', new Error('The exact search Host is unavailable.'), input.hostId))
    const reads = await Promise.allSettled(scopes.map(async scope => {
      return (await scope.client.sessionHistorySources()).filter(source => !input.agentSessionId || source.agentSessionId === input.agentSessionId)
        .map(original => ({ hostId: scope.hostId, original }))
    }))
    context.signal?.throwIfAborted()
    for (let i = 0; i < reads.length; i++) {
      const read = reads[i]!
      if (read.status === 'fulfilled') descriptors.push(...read.value)
      else issues.push(issue('retained-catalog', read.reason, scopes[i]!.hostId))
    }
    if (input.agentSessionId && !descriptors.length && !issues.length) issues.push({ source: 'retained-catalog', hostId: input.hostId!, agentSessionId: input.agentSessionId,
      code: 'UNKNOWN_AGENT_SESSION', message: 'No exact original retained Session was found at this Host.', recovery: 'Inspect the original Session identity or refresh the retained catalog.' })
    return { scopes, descriptors, issues }
  }
  return {
    history: ports.history,
    async sources(input, context) {
      const discovery = await discover(input, context), sources: AgentMuxSearchSource[] = [], issues = [...discovery.issues]
      for (const { hostId, original } of discovery.descriptors) {
        const reference = { hostId, sourceHostId: original.hostId, agentSessionId: original.agentSessionId }
        if (input.source !== 'native') sources.push({ ...reference, source: 'captured' })
        if (input.source !== 'captured') {
          const history = original.history
          if (history?.nativeHandle) sources.push({ ...reference, source: 'native', nativeSource: { providerId: history.providerId, nativeSessionId: history.nativeHandle.sessionId } })
          else issues.push({ source: 'native', hostId, agentSessionId: original.agentSessionId, code: 'AGENT_NATIVE_HISTORY_UNAVAILABLE',
            message: 'This original Session has no confirmed retained native locator; its captured text remains searchable.', recovery: 'Inspect this exact Session native source and retry; do not replace or restore its Run to search.' })
        }
      }
      return { sources, issues }
    },
    async metadata(input, context) {
      const discovery = await discover(input, context), issues = [...discovery.issues], sourceHostIds = new Map<string, string>()
      const facts: AgentMuxSearchMetadata = { sessions: [], projects: [], sources: discovery.descriptors.map(({ hostId, original }) => ({ ...original, hostId })), catalog: emptyCatalog(), objects: [] }
      const sessions: Array<AgentMuxSearchMetadata['sessions'][number]> = [], objects: AgentMuxSearchObject[] = []
      const observations = await Promise.allSettled([
        ports.catalog(context), ports.snapshot(context), ports.projects(context),
        ...discovery.scopes.map(async scope => ({ scope, sessions: await scope.client.readAgentSessions() }))
      ])
      context.signal?.throwIfAborted()
      if (observations[0]!.status === 'fulfilled') facts.catalog = observations[0]!.value as AgentMuxSpaceCatalog
      else issues.push(issue('spatial-catalog', observations[0]!.reason, input.hostId))
      const snapshot = observations[1]!.status === 'fulfilled' ? observations[1]!.value as Partial<AgentMuxRpcSnapshot> : null
      if (!snapshot) issues.push(issue('client-metadata', (observations[1] as PromiseRejectedResult).reason, input.hostId))
      else issues.push(...(snapshot.unavailable ?? []).map(value => ({ ...value, ...(input.hostId ? { hostId: input.hostId } : {}) })))
      const projectObservation = observations[2]!
      const projectFacts = projectObservation.status === 'fulfilled' ? projectObservation.value as AgentMuxRpcSnapshot['projects'] : []
      if (projectObservation.status === 'rejected') issues.push(issue('projects', projectObservation.reason, input.hostId))
      for (let i = 3; i < observations.length; i++) {
        const observation = observations[i]!, scope = discovery.scopes[i - 3]!
        if (observation.status === 'rejected') { issues.push(issue('session-identities', observation.reason, scope.hostId)); continue }
        const value = observation.value as { scope: AgentMuxRpcCoreClient; sessions: Awaited<ReturnType<AgentMuxRpcCoreClient['client']['readAgentSessions']>> }
        for (const session of value.sessions) if (!input.agentSessionId || session.agentSessionId === input.agentSessionId) {
          sourceHostIds.set(JSON.stringify([scope.hostId, session.agentSessionId]), session.hostId)
          sessions.push({ agentSessionId: session.agentSessionId, hostId: scope.hostId, kind: 'agent', workspacePath: session.workspacePath, identities: [session.hostId, session.run.runId, ...session.retiredRuns.map(run => run.runId), session.nativeHandle?.sessionId].filter((value): value is string => Boolean(value)),
            text: [session.agentSessionId, session.workspacePath, session.providerId, session.executorId] })
        }
      }
      const known = new Set(sessions.map(session => JSON.stringify([session.hostId, session.agentSessionId])))
      for (const { hostId, original } of discovery.descriptors) {
        sourceHostIds.set(JSON.stringify([hostId, original.agentSessionId]), original.hostId)
        if (!known.has(JSON.stringify([hostId, original.agentSessionId]))) { known.add(JSON.stringify([hostId, original.agentSessionId])); sessions.push({ agentSessionId: original.agentSessionId, hostId, kind: 'agent', ...(original.history?.workspacePath ? { workspacePath: original.history.workspacePath } : {}), identities: [original.hostId], text: [original.agentSessionId, original.history?.workspacePath ?? '', original.history?.providerId ?? ''] }) }
      }
      const sessionsById = new Map<string, typeof sessions>()
      for (const session of sessions) { const rows = sessionsById.get(session.agentSessionId) ?? []; rows.push(session); sessionsById.set(session.agentSessionId, rows) }
      for (const presentation of facts.catalog.agentPresentation ?? []) {
        const candidates = sessionsById.get(presentation.agentSessionId) ?? []
        if (candidates.length === 1) candidates[0]!.text = [presentation.name, ...candidates[0]!.text, presentation.project, presentation.detail, presentation.group, presentation.state, presentation.providerId, presentation.recap?.text ?? '']
        else if (candidates.length > 1) issues.push({ source: 'agent-presentation', code: 'SEARCH_PRESENTATION_SCOPE_UNCONFIRMED', message: 'An original presentation has several Session Host candidates; its name was not assigned to a guessed Host.', recovery: 'Inspect the original Host/Session presentation scope.' })
      }
      const catalog = facts.catalog, regions = new Map(catalog.regions.map(region => [region.regionId, region])), zones = new Map(catalog.zones.map(zone => [zone.zoneId, zone])), tabs = new Map(catalog.tabs.map(tab => [tab.tabId, tab]))
      const locations = new Map<string, typeof catalog.locations>()
      for (const location of catalog.locations) for (const [kind, id] of [['space', location.spaceId], ['zone', location.zoneId], ['tab', location.tabId], ['region', location.regionId]]) if (id) { const key = JSON.stringify([kind, id]), rows = locations.get(key) ?? []; rows.push(location); locations.set(key, rows) }
      const locationRows = (id: string, name: string, kind: string) => (locations.get(JSON.stringify([kind, id])) ?? []).map(location => {
        const reference = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
        return { reference, address: JSON.stringify(Object.values(reference)), name, kind: regions.get(location.regionId)?.kind ?? kind, sessionId: regions.get(location.regionId)?.agentSessionId ?? null }
      })
      const add = (target: AgentMuxSearchTarget, name: string, identities: readonly (string | null | undefined)[], text: readonly (string | null | undefined)[], originalLocations = locationRows(
        target.kind === 'space' ? target.spaceId : target.kind === 'zone' ? target.zoneId : target.kind === 'tab' ? target.tabId : target.kind === 'region' ? target.regionId : '', name, target.kind)) => {
        if (input.hostId && target.hostId !== input.hostId) return
        objects.push({ target, name, identities: identities.filter((id): id is string => Boolean(id)), text: text.filter((value): value is string => typeof value === 'string'), locations: originalLocations })
      }
      for (const space of catalog.spaces) add({ kind: 'space', spaceId: space.spaceId, hostId: space.hostId }, space.name, [space.projectId, space.topicId], [space.directoryPath])
      for (const zone of catalog.zones) add({ kind: 'zone', zoneId: zone.zoneId, ...(zone.hostId ? { hostId: zone.hostId } : {}) }, zone.directoryPath ?? zone.zoneId, [zone.workspaceId], [zone.directoryPath, zone.branch])
      for (const tab of catalog.tabs) {
        const hostId = tab.zoneId ? zones.get(tab.zoneId)?.hostId : null
        add({ kind: 'tab', tabId: tab.tabId, ...(hostId ? { hostId } : {}) }, tab.name ?? tab.tabId, [tab.workspaceId], [])
      }
      for (const region of catalog.regions) {
        const tab = tabs.get(region.tabId), hostId = region.execution?.hostId ?? (tab?.zoneId ? zones.get(tab.zoneId)?.hostId : null)
        add({ kind: 'region', regionId: region.regionId, ...(hostId ? { hostId } : {}) }, tab?.name ?? region.regionId,
          [region.runId, region.browserId, region.agentSessionId], [region.kind, region.file?.path, region.execution?.cwd])
      }
      if (input.hostId && catalog.zones.some(zone => zone.hostId === null)) issues.push({ source: 'spatial-scope', hostId: input.hostId,
        code: 'SEARCH_HOST_SCOPE_UNCONFIRMED', message: 'Some original spatial objects have no confirmed execution Host; they were not assigned to the selected Host.', recovery: 'Inspect their exact original Zone/Region to confirm scope.' })
      const projects = projectFacts.filter(project => !input.hostId || project.hostId === input.hostId)
      for (const project of projects) add({ kind: 'project', hostId: project.hostId, projectId: project.projectId }, project.name, [], [project.path, project.branch, project.repoPath])
      const workspaces = (snapshot?.workspaces ?? []).filter(workspace => !input.hostId || workspace.hostId === input.hostId)
      for (const workspace of workspaces) add({ kind: 'workspace', hostId: workspace.hostId, workspaceId: workspace.workspaceId }, workspace.name, [workspace.projectId], [workspace.path, workspace.repoPath, workspace.branch])
      for (const topic of [...snapshot?.topics ?? [], ...snapshot?.motes ?? []]) add({ kind: topic.kind === 'mote' ? 'mote' : 'topic', hostId: topic.hostId, topicId: topic.topicId }, topic.title,
        [topic.workspaceId, topic.spaceId], [topic.summary, topic.path, topic.directoryPath])
      // Use exact original Workspace metadata, never path prefix or current cwd.
      const workspacesByPath = new Map<string, typeof workspaces>()
      for (const workspace of workspaces) { const key = JSON.stringify([workspace.hostId, workspace.path]), rows = workspacesByPath.get(key) ?? []; rows.push(workspace); workspacesByPath.set(key, rows) }
      for (const session of sessions) {
        const path = session.workspacePath, candidates = workspacesByPath.get(JSON.stringify([session.hostId, path])) ?? []
        if (candidates.length === 1) { const workspace = candidates[0]!; session.workspaceId = workspace.workspaceId; session.identities = [...session.identities, workspace.workspaceId, ...(workspace.projectId ? [workspace.projectId] : [])]; session.text = [...session.text, workspace.name, workspace.branch ?? ''] }
      }
      return { facts: { ...facts, sessions, objects, projects: projects.map(project => ({ hostId: project.hostId, projectId: project.projectId, name: project.name, sessionIds: project.activeAgentSessionIds })) }, issues, sourceHostIds }
    }
  }
}
