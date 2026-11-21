import { groundingAcceptanceIssue } from '@agentmux/demand/goals'
import { demandAgentReferenceKey, mergeDemandAgentReferences, type DemandSpaceMemberReference } from '@agentmux/demand/relations'
import type { DemandContentReference } from '@agentmux/demand'
import { spatialAgentOpenRecord, spatialAgentAssociationRecord, type AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import { spaceMountKey } from '../../../shared/space-mount'
import type { SpaceAuthorityRef } from '@agentmux/core'
import { memberSpaceInputTarget, mountedRegionKey } from './space-mount-view'
import { mountedSessionFacts } from './space-mount-sessions'
import { directoryIdentity, homeZoneId, originalTopicAddress } from '../../../shared/space-addresses'
import { SCRATCH_WORKSPACE_ID, scratchTopicIdentityPath, scratchTopicLogicalPath } from '@agentmux/host/mote-model'
import type { useAppStore } from '../store'
import type { MoteWorkfaceScope } from './mote-workface'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from './workbench-projection'
import { spatialCatalog } from './space-agent-control'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { confirmedMoteReference } from './mote-materials-actions'
import { workbenchSelectionCatalog } from './desktop-focus-navigation'
import { goalNextStep } from './goal-presentation'
import type { DemandRecord } from './global-demand-board'
import { goalDelegationRows, isHistoricalGoalDelegation } from './goal-delegation-presentation'

/** Read the original resource composition, including unplaced and unloaded Regions. */
export function moteGoalContext(state: ReturnType<typeof useAppStore.getState>, scope: MoteWorkfaceScope,
  reference?: WorkbenchProjectionSelection | null, graph?: AgentMuxSpatialGraph | null, locator?: SpaceAuthorityRef | null) {
  const sourceLocator = locator === undefined ? moteGoalSourceLocator(state, scope, graph) : locator
  const resourceKey = moteGoalResourceKey(state, scope), spaceId = moteGoalSpaceId(state, scope)
  const workspace = state.config?.workspaces.find(item => item.id === scope.workspace.id)
  if (workspace?.hostId !== scope.workspace.hostId || workspace.path !== scope.workspace.path || scratchTopicLogicalPath(workspace, scope.topic) !== scope.rootPath)
    return { ...emptyQualified(), sourceUnconfirmed: true, resourceKey, spaceId, sourceLocator, contentRef: null as DemandContentReference | null, sessionIds: [] as string[], selectedSessionId: undefined as string | undefined, issue: 'The original Mote resource is unconfirmed. Its work is retained.' }
  const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scope.workspace)
  // Membership is structural; an unavailable directory retains the original scope.
  const catalog = topics !== null && scope.workspace.id === SCRATCH_WORKSPACE_ID ? workbenchSelectionCatalog(state)
    : spatialCatalog({ ...state, sessions: [] }, topics ?? [scope.topic])
  const original = originalTopicAddress(scope.workspace, scope.topic, state.spaceZoneBindings)
  const home = original ? catalog.zones.filter(zone => zone.zoneId === homeZoneId(original.spaceId)) : []
  const contentRef: DemandContentReference | null = home.length === 1 && home[0]!.kind === 'home' && !home[0]!.issue &&
    home[0]!.hostId === scope.workspace.hostId && home[0]!.workspaceId === scope.workspace.id &&
    catalog.spaces.filter(space => space.spaceId === spaceId && space.kind === 'mote' && space.hostId === scope.workspace.hostId).length === 1
    ? { hostId: scope.workspace.hostId, workspaceId: scope.workspace.id, zoneId: home[0]!.zoneId } : null
  const zoneIds = new Set(catalog.bindings.filter(binding => binding.spaceId === spaceId).map(binding => binding.zoneId))
  if (!zoneIds.size) return { ...emptyQualified(), sourceUnconfirmed: true, resourceKey, spaceId, sourceLocator, contentRef, sessionIds: [] as string[], selectedSessionId: undefined as string | undefined,
    issue: 'The original Mote bindings are unconfirmed. Its work is retained.' }
  const tabIds = new Set(catalog.tabs.filter(tab => tab.zoneId !== null && zoneIds.has(tab.zoneId)).map(tab => tab.tabId))
  const sessionIds = [...new Set(catalog.regions.filter(region => tabIds.has(region.tabId) && region.kind === 'agent')
    .flatMap(region => region.agentSessionId ? [region.agentSessionId] : []))]
  const selected = reference === undefined ? confirmedMoteReference(state, scope, {}) : reference &&
    catalog.locations.some(location => location.spaceId === spaceId && sameWorkbenchProjectionSelection(location, reference)) ? reference : null
  const region = selected ? state.tabs[selected.tabId]?.regions[selected.regionId] : undefined
  const selectedSessionId = region?.kind === 'agent' && sessionIds.includes(region.sessionId) ? region.sessionId : undefined
  const qualified = moteQualifiedMembers(state, scope, spaceId, graph, sourceLocator)
  return { ...qualified, resourceKey, spaceId, sourceLocator, contentRef, sessionIds, selectedSessionId, issue: scope.issue }
}

/** A discussion read gap affects this work summary only through an original Goal relation. */
export function moteGoalReferenceIssue(context: ReturnType<typeof moteGoalContext>, records: Readonly<Record<string, DemandRecord>>): string | undefined {
  if (!context.sourceUnconfirmed && !context.unconfirmedMembers.length) return undefined
  const unresolved = new Set(context.unconfirmedMembers.map(member => JSON.stringify([member.regionId, member.operationId])))
  const affected = Object.values(records).some(goal => goal.sessionIds.some(ref => typeof ref !== 'string' &&
    ref.source.spaceId === context.spaceId && (context.sourceUnconfirmed || unresolved.has(JSON.stringify([ref.source.regionId, ref.source.admission.operationId])))))
  return affected ? referenceIssue : undefined
}

export function goalsForMote(records: Readonly<Record<string, DemandRecord>>, sessionIds: readonly string[], contentRef?: DemandContentReference | null, agentReferences: readonly DemandSpaceMemberReference[] = []): DemandRecord[] {
  const members = new Set(sessionIds), qualified = new Set(agentReferences.map(demandAgentReferenceKey))
  return Object.values(records).filter(goal => goal.sessionIds.some(id => typeof id === 'string' ? members.has(id) : qualified.has(demandAgentReferenceKey(id))) || Boolean(contentRef && goal.contentRefs?.some(ref =>
      ref.hostId === contentRef.hostId && ref.workspaceId === contentRef.workspaceId && ref.zoneId === contentRef.zoneId)))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}

type UnconfirmedMember = { regionId: string; operationId?: string }
const emptyQualified = () => ({ agentReferences: [] as DemandSpaceMemberReference[], loadedReferenceKeys: [] as string[], unconfirmedMembers: [] as UnconfirmedMember[], sourceUnconfirmed: false, confirmedSource: null as SpaceAuthorityRef | null })
const referenceIssue = 'Some Mote discussions could not be checked.'

const moteGoalSpaceId = (state: ReturnType<typeof useAppStore.getState>, scope: MoteWorkfaceScope) =>
  originalTopicAddress(scope.workspace, scope.topic, state.spaceZoneBindings)?.spaceId ?? directoryIdentity(scope.workspace.hostId, scratchTopicIdentityPath(scope.workspace, scope.topic))
const moteGoalResourceKey = (state: ReturnType<typeof useAppStore.getState>, scope: MoteWorkfaceScope) =>
  JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id, scope.rootPath, moteGoalSpaceId(state, scope)])
const sameSource = (a: SpaceAuthorityRef, b: SpaceAuthorityRef) => a.runtimeId === b.runtimeId && a.spaceId === b.spaceId

/** A saved pin or frozen record locates one observation. Neither grants Source qualification. */
export function moteGoalSourceLocator(state: ReturnType<typeof useAppStore.getState>, scope: MoteWorkfaceScope, graph?: AgentMuxSpatialGraph | null): SpaceAuthorityRef | null {
  const spaceId = moteGoalSpaceId(state, scope)
  if (scope.workspace.hostId !== 'local') {
    const host = state.config?.hosts.find(host => host.id === scope.workspace.hostId)
    return host?.kind === 'ssh' && host.runtimeId ? { runtimeId: host.runtimeId, spaceId } : null
  }
  const members = localMoteMembers(scope, spaceId, graph), runtimes = new Set(members.agentReferences.map(ref => ref.source.runtimeId))
  return runtimes.size === 1 ? { runtimeId: [...runtimes][0]!, spaceId } : null
}

/** Direct access to the captured original Source slot; no all-Space map enumeration. */
export function moteGoalSourceFacts(state: ReturnType<typeof useAppStore.getState>, scope: MoteWorkfaceScope, locator: SpaceAuthorityRef | null): Record<string, unknown> {
  if (!locator) return {}
  const key = spaceMountKey(locator), observation = state.mountedSpaceObservations[key], snapshot = observation?.snapshot ?? observation?.lastPresentSnapshot
  if (!snapshot || !sameSource(snapshot.reference, locator) || snapshot.source.runtimeId !== locator.runtimeId) return {}
  try {
    const target = memberSpaceInputTarget(state.mountedSpaceInputs, key)
    if (target?.hostId !== scope.workspace.hostId || target.workspaceId !== scope.workspace.id || !sameSource(target.reference, locator)) return {}
    return { ['snapshot:' + key]: observation, ['sessions:' + key]: state.mountedSpaceSessions[key] }
  } catch { return {} } // An opaque private entry cannot identify this Source.
}

function localMoteMembers(scope: MoteWorkfaceScope, spaceId: string, graph: AgentMuxSpatialGraph | null | undefined) {
  const result = emptyQualified(), refs = result.agentReferences
  const add = (runtimeId: string, regionId: string, kind: 'creation' | 'association', operationId: string, executionRuntimeId: string, agentSessionId: string) => {
    const ref: DemandSpaceMemberReference = { kind: 'space-member', source: { runtimeId, spaceId, regionId, admission: { kind, operationId } }, execution: { runtimeId: executionRuntimeId, agentSessionId } }
    refs.push(ref)
  }
  // This graph belongs to the local Core. A remote Mote never borrows its Runtime.
  if (scope.workspace.hostId === 'local' && graph?.spaces.some(space => space.spaceId === spaceId && space.hostId === 'local' && space.kind === 'mote')) {
    const bound = new Set(graph.bindings.filter(binding => binding.spaceId === spaceId).map(binding => binding.zoneId))
    const zones = new Map(graph.zones.filter(zone => bound.has(zone.zoneId)).map(zone => [zone.zoneId, zone]))
    const tabs = new Map(graph.tabs.filter(tab => tab.zoneId !== null && zones.has(tab.zoneId)).map(tab => [tab.tabId, tab]))
    for (const region of graph.regions) {
      const tab = tabs.get(region.tabId), zone = tab?.zoneId ? zones.get(tab.zoneId) : undefined
      const operationId = region.association?.operationId ?? region.creationOperationId
      if (region.kind !== 'agent' || !zone || !operationId) continue
      try {
        const record = region.association ? spatialAgentAssociationRecord(graph, operationId) : spatialAgentOpenRecord(graph, operationId)
        const placement = record?.placement
        if (!record || !placement?.runtimeId || record.address.tabId !== region.tabId || record.address.regionId !== region.regionId || record.address.zoneId !== zone.zoneId || record.address.workspaceId !== zone.workspaceId ||
            placement.hostId !== zone.hostId || placement.workspaceId !== zone.workspaceId || placement.workspacePath !== zone.directoryPath) throw Error(referenceIssue)
        if ('kind' in record && record.kind === 'association') {
          if (region.agentSessionId !== null || region.runId !== null || region.execution !== null) throw Error(referenceIssue)
          add(placement.runtimeId, region.regionId, 'association', operationId, record.reference.runtimeId, record.reference.binding.agentSessionId)
        } else if ('agentSessionId' in record && record.agentSessionId === region.agentSessionId && record.execution.runtimeId &&
          record.execution.runtimeId === region.execution?.runtimeId && record.execution.hostId === region.execution.hostId && record.execution.workspacePath === region.execution.cwd) {
          add(placement.runtimeId, region.regionId, 'creation', operationId, record.execution.runtimeId, record.agentSessionId)
        } else throw Error(referenceIssue)
      } catch { result.unconfirmedMembers.push({ regionId: region.regionId, operationId }) }
    }
  } else result.sourceUnconfirmed = true

  return result
}

function moteQualifiedMembers(state: ReturnType<typeof useAppStore.getState>, scope: MoteWorkfaceScope, spaceId: string, graph: AgentMuxSpatialGraph | null | undefined, locator: SpaceAuthorityRef | null) {
  const result = localMoteMembers(scope, spaceId, graph)
  // More than one frozen Runtime is unknown, never one merged Mote source.
  const refs = result.agentReferences.filter(ref => locator && ref.source.runtimeId === locator.runtimeId && ref.source.spaceId === locator.spaceId)
  result.agentReferences = refs
  if (locator && refs.length) result.confirmedSource = locator
  else result.sourceUnconfirmed = true

  const sourceFacts = moteGoalSourceFacts(state, scope, locator)
  for (const [key, value] of Object.entries(sourceFacts)) {
    if (!key.startsWith('snapshot:')) continue
    const observation = value as ReturnType<typeof useAppStore.getState>['mountedSpaceObservations'][string]
    const snapshot = observation.snapshot ?? observation.lastPresentSnapshot, metadata = state.mountedSpaceSessions[key.slice('snapshot:'.length)]
    if (!snapshot || snapshot.source.runtimeId !== snapshot.reference.runtimeId || snapshot.scope.space?.spaceId !== spaceId || snapshot.scope.space.kind !== 'mote') continue
    result.sourceUnconfirmed = false
    result.confirmedSource = snapshot.reference
    const bound = new Set(snapshot.scope.bindings.filter(binding => binding.spaceId === spaceId).map(binding => binding.zoneId))
    const tabs = new Set(snapshot.scope.tabs.filter(tab => tab.zoneId !== null && bound.has(tab.zoneId)).map(tab => tab.tabId))
    const members = mountedSessionFacts(snapshot, metadata)
    const occurrences = new Map<string, { ref: DemandSpaceMemberReference; loaded: boolean }>()
    for (const fact of Object.values(metadata?.members ?? {})) {
      const cut = fact.cut, runtimeId = fact.member.runtimeId
      if (observation.error || observation.reading || metadata?.error || metadata?.reading || !runtimeId || !cut || cut.revision !== snapshot.revision ||
          cut.reference.runtimeId !== snapshot.reference.runtimeId || cut.reference.spaceId !== spaceId || cut.source.ownerInstanceId !== snapshot.source.ownerInstanceId || cut.source.runtimeId !== snapshot.source.runtimeId) continue
      for (const occurrence of fact.occurrences ?? []) {
        const operationId = occurrence.associationOperationId ?? occurrence.creationOperationId
        if (!operationId || occurrence.projectRuntimeId !== snapshot.source.runtimeId || occurrence.agentRuntimeId !== runtimeId) continue
        const ref: DemandSpaceMemberReference = { kind: 'space-member', source: { runtimeId: snapshot.source.runtimeId, spaceId, regionId: occurrence.regionId,
          admission: { kind: occurrence.associationOperationId ? 'association' : 'creation', operationId } }, execution: { runtimeId, agentSessionId: fact.member.agentSessionId } }
        occurrences.set(JSON.stringify([occurrence.regionId,operationId]), { ref, loaded: fact.state.status === 'observed' && fact.state.authority.runtimeId === runtimeId && fact.state.session.agentSessionId === fact.member.agentSessionId })
      }
    }
    for (const region of snapshot.scope.regions) {
      const operationId = region.association?.operationId ?? region.creationOperationId
      if (region.kind !== 'agent' || !tabs.has(region.tabId) || !operationId) continue
      const match = occurrences.get(JSON.stringify([region.regionId,operationId])), member = members.get(mountedRegionKey(snapshot.reference, region.tabId, region.regionId))
      if (match && (region.association ? match.ref.source.admission.kind === 'association' : match.ref.source.admission.kind === 'creation' &&
          member?.occurrence?.creationOperationId === operationId && match.ref.execution.agentSessionId === region.agentSessionId && match.ref.execution.runtimeId === member.current?.member.runtimeId)) {
        refs.push(match.ref); if (match.loaded) result.loadedReferenceKeys.push(demandAgentReferenceKey(match.ref))
      } else result.unconfirmedMembers.push({ regionId: region.regionId, operationId })
    }
  }
  result.agentReferences = mergeDemandAgentReferences(refs) as DemandSpaceMemberReference[]
  return result
}

/** Last-known reading is scoped to the unresolved original Region/admission, never a new control fact. */
export function retainMoteGoalContext(previous: ReturnType<typeof moteGoalContext>, current: ReturnType<typeof moteGoalContext>): ReturnType<typeof moteGoalContext> {
  const originalSource = previous.confirmedSource ?? previous.sourceLocator, currentSource = current.confirmedSource ?? current.sourceLocator
  const sameScope = previous.resourceKey === current.resourceKey && originalSource && (!currentSource || sameSource(originalSource, currentSource))
  if (!sameScope) return current
  const unresolved = new Set(current.unconfirmedMembers.map(member => JSON.stringify([member.regionId, member.operationId])))
  const held = previous.agentReferences.filter(ref => ref.source.runtimeId === originalSource.runtimeId && ref.source.spaceId === originalSource.spaceId &&
    (current.sourceUnconfirmed && !current.unconfirmedMembers.length || unresolved.has(JSON.stringify([ref.source.regionId, ref.source.admission.operationId]))))
  const reading = current.issue && !current.sessionIds.length && !current.contentRef ? { ...current, contentRef: previous.contentRef, sessionIds: previous.sessionIds } : current
  if (!held.length) return reading
  return { ...reading, sourceLocator: current.sourceLocator ?? originalSource, agentReferences: mergeDemandAgentReferences(current.agentReferences, held) as DemandSpaceMemberReference[] }

}

/** Human acknowledgement and original recorded work remain distinct facts. */
export function moteGoalSummary(goal: DemandRecord): { next: string; detail: string | null } {
  const latest = [...(goal.activities ?? []).map(item => ({ at: item.createdAt, text: item.message })),
    ...(goal.decisions ?? []).map(item => ({ at: item.createdAt, text: item.decision }))]
    .sort((left, right) => right.at - left.at)[0]
  return { next: goalNextStep(goal), detail: goal.grounding?.summary ?? latest?.text ?? null }
}

/** A bounded reading summary; original Goal status and acceptance remain authoritative. */
export function moteCurrentGoals(goals: readonly DemandRecord[]): DemandRecord[] {
  const current = []
  for (const goal of goals) {
    if (goal.status === 'cancelled') continue
    const rows = goalDelegationRows(goal).filter(row => !isHistoricalGoalDelegation(row))
    if (goal.status === 'done' && goal.grounding?.acceptedAt != null && groundingAcceptanceIssue(goal.alignment, goal.grounding, true) === null &&
        rows.every(row => row.state === 'accepted')) continue
    const priority = goal.status === 'blocked' || rows.some(row => row.state === 'report' || row.state === 'exited' || row.state === 'question') ? 0
      : goal.status === 'in_review' || goal.grounding?.acceptedAt === null || !goal.alignment || goal.alignment.confirmedAt === null ? 1 : 2
    current.push({ goal, priority })
  }
  return current.sort((a, b) => a.priority - b.priority || b.goal.updatedAt - a.goal.updatedAt || a.goal.id.localeCompare(b.goal.id)).map(({ goal }) => goal)
}
