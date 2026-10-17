import type { AgentMuxSpaceCatalog } from '@agentmux/core'
import type { SessionSnapshot, WorkspaceRecord, ScratchTopicSnapshot } from '../../../shared/contracts'
import { SCRATCH_WORKSPACE_ID, scratchTopicPhysicalPath } from '../../../shared/scratch-topics'
import { originalTopicAddress, topicSpatialAddress } from '../../../shared/space-addresses'
import { workspaceProjectId } from './workspace-projects'
import type { NavigationState } from './desktop-focus-navigation'
import { workbenchNavigationCatalog } from './workbench-navigation-catalog'
import { scratchTopicsForConfig, scratchTopicKind } from './scratch-topic-snapshots'
import { agentSessionPresentationIndex, sessionPresentationsAtPath } from './session-presentation'
import { createWorkspaceAgentSessionsSelector, workspaceAgentSessions, type AgentSessionSnapshot } from './surface-tool-dock'

export type WorkspaceAgentExecutionResolver = (reference: {
  tabId: string; regionId: string; agentSessionId: string
}) => { hostId: string } | null
export type WorkspaceAgentScopeState = Pick<NavigationState,
  'config' | 'sessions' | 'tabs' | 'layouts' | 'spaceZoneBindings' | 'scratchTopicSnapshots' |
  'workbenchSpaceSelection' | 'topicCategories' | 'projectGroups' | 'spatialRequests'>
export type WorkspaceAgentList = { key: string; title: string; sessions: readonly AgentSessionSnapshot[]; issue: string | null }
type Reference = Parameters<WorkspaceAgentExecutionResolver>[0]
type ObjectScope = {
  key: string; title: string; topicId: string; hostId: string; paths: readonly string[]
  collaborators: ScratchTopicSnapshot['collaborators']; kind: 'topic' | 'mote' | 'unknown'
  spaceId: string | null; zoneId: string | null; issue: string | null
}
const noExecution: WorkspaceAgentExecutionResolver = () => null
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, i) => value === b[i])
const sessionKey = (session: AgentSessionSnapshot) => JSON.stringify([session.control.hostId, session.control.agentSessionId])

/** One structural Region index shared across consumers; Runtime publications do not rebuild it. */
const referenceIndexes = new WeakMap<AgentMuxSpaceCatalog, Map<string, Reference[]>>()
function references(catalog: AgentMuxSpaceCatalog, zones: ReadonlySet<string>): Reference[] {
  let index = referenceIndexes.get(catalog)
  if (!index) {
    index = new Map()
    const tabZones = new Map(catalog.tabs.map(tab => [tab.tabId, tab.zoneId]))
    for (const region of catalog.regions) {
      const zoneId = tabZones.get(region.tabId)
      if (region.kind !== 'agent' || !region.agentSessionId || !zoneId) continue
      const bucket = index.get(zoneId) ?? []
      bucket.push({ tabId: region.tabId, regionId: region.regionId, agentSessionId: region.agentSessionId })
      index.set(zoneId, bucket)
    }
    referenceIndexes.set(catalog, index)
  }
  return [...zones].flatMap(zone => index.get(zone) ?? [])
}
function append(target: Map<string, AgentSessionSnapshot>, session: SessionSnapshot, hostId?: string, sid?: string, providerId?: string) {
  if (session.kind !== 'agent' || session.control.kind !== 'agent' || session.hostId !== session.control.hostId ||
    hostId !== undefined && session.control.hostId !== hostId || sid !== undefined && session.control.agentSessionId !== sid ||
    providerId !== undefined && session.providerId !== providerId) return
  const key = sessionKey(session), old = target.get(key)
  if (!old || old.id !== old.control.agentSessionId && session.id === session.control.agentSessionId) target.set(key, session)
}
function addReferences(target: Map<string, AgentSessionSnapshot>, sessions: readonly SessionSnapshot[], refs: readonly Reference[], resolve: WorkspaceAgentExecutionResolver): boolean {
  if (!refs.length) return false
  const index = agentSessionPresentationIndex(sessions)
  let unconfirmed = false
  for (const ref of refs) {
    const execution = resolve(ref)
    if (!execution) { unconfirmed = true; continue }
    for (const session of index.get(ref.agentSessionId) ?? []) append(target, session, execution.hostId, ref.agentSessionId)
  }
  return unconfirmed
}
function addCollaborators(target: Map<string, AgentSessionSnapshot>, sessions: readonly SessionSnapshot[], hostId: string,
  collaborators: ScratchTopicSnapshot['collaborators']) {
  if (!collaborators.length) return
  const index = agentSessionPresentationIndex(sessions)
  for (const plaque of collaborators) for (const session of index.get(plaque.sessionId) ?? []) append(target, session, hostId, plaque.sessionId, plaque.providerId)
}
function catalogFor(state: WorkspaceAgentScopeState) {
  return workbenchNavigationCatalog(state, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots))
}
function objectScope(state: WorkspaceAgentScopeState, workspace: WorkspaceRecord, catalog: AgentMuxSpaceCatalog): ObjectScope | null {
  const choice = state.workbenchSpaceSelection
  if (choice?.workspaceId !== workspace.id) return null
  const resource = state.config?.workspaces.find(value => value.id === SCRATCH_WORKSPACE_ID)
  if (!resource) return null
  const space = catalog.spaces.find(space => space.spaceId === choice.spaceId)
  const topicId = choice.topicId ?? (space?.kind === 'mote' ? space.topicId : undefined) ??
    (space?.kind !== 'folder' && choice.zoneId ? state.spaceZoneBindings[choice.zoneId]?.topicId : undefined)
  if (!topicId) return null
  const topics = scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)
  const topic = topics?.find(value => value.id === topicId)
  const originals = Object.entries(state.spaceZoneBindings).filter(([, value]) => value.topicId === topicId && value.workspaceId === resource.id)
  const record = originals.length === 1 ? originals[0] : undefined
  const address = topic ? originalTopicAddress(resource, topic, state.spaceZoneBindings) : record ? { zoneId: record[0], spaceId: record[1].spaceId } : null
  const origin = address ? state.spaceZoneBindings[address.zoneId] : undefined
  const kind = origin?.contentKind ?? scratchTopicKind(topicId, topics)
  const paths = new Set<string>()
  for (const path of [...topic?.confirmedDirectoryPaths ?? [], topic?.identityDirectoryPath, topic?.physicalDirectoryPath, origin?.directoryPath]) {
    if (path) paths.add(path)
  }
  if (topic && !topic.readError) paths.add(scratchTopicPhysicalPath(resource, topic))
  const hasZone = address && catalog.zones.some(zone => zone.zoneId === address.zoneId)
  const display = topic ? topicSpatialAddress(state.config, topic, state.spaceZoneBindings, state.topicCategories) : address
  const selectionMatches = kind === 'mote' ? choice.spaceId === address?.spaceId && (!choice.zoneId || catalog.bindings.some(binding => binding.spaceId === choice.spaceId && binding.zoneId === choice.zoneId)) : choice.zoneId === address?.zoneId && choice.spaceId === display?.spaceId
  const issue = topic?.readError ?? (!address || !hasZone || !selectionMatches || kind === 'unknown'
    ? 'The selected object membership is unconfirmed. Its exact reference and existing Agents are kept; refresh the original directory or spatial facts.'
    : !topic ? 'Original directory discovery is unavailable. Confirmed spatial membership remains available; retry the same directory.' : null)
  return { key: JSON.stringify(['object-agent-list', resource.id, resource.hostId, topicId]), title: topic?.title ?? catalog.spaces.find(space => space.spaceId === address?.spaceId)?.name ?? 'Agents',
    topicId, hostId: resource.hostId, paths: [...paths], collaborators: topic?.collaborators ?? [], kind,
    spaceId: address?.spaceId ?? null, zoneId: address?.zoneId ?? null, issue }
}
function objectZones(scope: ObjectScope, catalog: AgentMuxSpaceCatalog): Set<string> {
  if (scope.kind === 'mote' && scope.spaceId) return new Set(catalog.bindings.filter(binding => binding.spaceId === scope.spaceId).map(binding => binding.zoneId))
  return new Set(scope.zoneId ? [scope.zoneId] : [])
}
function workspaceZones(state: WorkspaceAgentScopeState, workspace: WorkspaceRecord, catalog: AgentMuxSpaceCatalog): Set<string> {
  if (workspace.id !== SCRATCH_WORKSPACE_ID) {
    const projectId = workspaceProjectId(workspace)
    return new Set(catalog.bindings.filter(binding => binding.spaceId === projectId).map(binding => binding.zoneId))
  }
  const spaces = new Set(Object.values(state.spaceZoneBindings).filter(value => value.workspaceId === workspace.id).map(value => value.spaceId))
  return new Set([...catalog.zones.filter(zone => zone.workspaceId === workspace.id).map(zone => zone.zoneId),
    ...catalog.bindings.filter(binding => spaces.has(binding.spaceId)).map(binding => binding.zoneId)])
}

/** Order validation covers the Workspace total and its exact current logical scope. */
export function workspaceAgentListMembers(state: WorkspaceAgentScopeState, workspace: WorkspaceRecord,
  resolveExecution: WorkspaceAgentExecutionResolver = noExecution): readonly AgentSessionSnapshot[] {
  const topics = scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)
  const natural = workspaceAgentSessions(state.sessions, workspace, topics)
  const result = new Map<string, AgentSessionSnapshot>()
  for (const session of natural) append(result, session)
  if (workspace.id === SCRATCH_WORKSPACE_ID) for (const topic of topics ?? []) addCollaborators(result, state.sessions, workspace.hostId, topic.collaborators)
  const catalog = catalogFor(state)
  addReferences(result, state.sessions, references(catalog, workspaceZones(state, workspace, catalog)), resolveExecution)
  for (const session of createWorkspaceAgentListSelector(resolveExecution)(state, workspace).sessions) append(result, session)
  return [...result.values()]
}

/** A disposable projection over original membership and execution owners, never another registry. */
export function createWorkspaceAgentListSelector(resolveExecution: WorkspaceAgentExecutionResolver = noExecution) {
  const natural = createWorkspaceAgentSessionsSelector()
  let inputs: readonly unknown[] = [], scope: ObjectScope | null = null, held: ObjectScope | null = null
  let refs: readonly Reference[] = [], refInputs: readonly unknown[] = []
  let previous: WorkspaceAgentList | null = null
  return (state: WorkspaceAgentScopeState, workspace: WorkspaceRecord, sourceSessions: readonly SessionSnapshot[] = state.sessions): WorkspaceAgentList => {
    const topics = scratchTopicsForConfig(state.config, state.scratchTopicSnapshots), catalog = catalogFor(state)
    const nextInputs = [workspace, state.workbenchSpaceSelection, topics, state.spaceZoneBindings, catalog]
    if (!same(inputs, nextInputs)) {
      scope = objectScope(state, workspace, catalog)
      if (scope?.issue && held?.key === scope.key && !scope.paths.length) scope = { ...held, issue: scope.issue }
      if (scope && !scope.issue) held = scope
      if (!scope || held?.key !== scope.key) held = scope
      inputs = nextInputs
    }
    const key = scope?.key ?? JSON.stringify(['workspace-agent-list', workspace.id, workspace.hostId, workspace.path])
    const nextRefInputs = [catalog, scope, workspace]
    if (!same(refInputs, nextRefInputs)) {
      refs = references(catalog, scope ? objectZones(scope, catalog) : workspaceZones(state, workspace, catalog))
      refInputs = nextRefInputs
    }
    const result = new Map<string, AgentSessionSnapshot>()
    if (scope) {
      for (const path of scope.paths) for (const session of sessionPresentationsAtPath(sourceSessions, scope.hostId, path)) append(result, session, scope.hostId)
      addCollaborators(result, sourceSessions, scope.hostId, scope.collaborators)
    } else {
      for (const session of natural(sourceSessions, workspace, topics)) append(result, session)
      if (workspace.id === SCRATCH_WORKSPACE_ID) for (const topic of topics ?? []) addCollaborators(result, sourceSessions, workspace.hostId, topic.collaborators)
    }
    const unknownExecution = addReferences(result, sourceSessions, refs, resolveExecution)
    const sessions = [...result.values()], title = scope?.title ?? workspace.name
    const issue = scope?.issue ?? (unknownExecution ? 'Some original Agent execution identities are unconfirmed. Confirmed members remain available; refresh those exact spatial references.' : null)
    if (previous && previous.key === key && previous.title === title && previous.issue === issue && same(previous.sessions, sessions)) return previous
    previous = { key, title, sessions: previous?.key === key && same(previous.sessions, sessions) ? previous.sessions : sessions, issue }
    return previous
  }
}
