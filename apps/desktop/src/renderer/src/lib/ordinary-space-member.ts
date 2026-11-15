import type { SpaceSnapshot } from '@agentmux/core'
import { spatialAgentOpenRecord, type AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { SpaceMountMemberTarget, SpaceMountRecord } from '../../../shared/space-mount'
import { desktopAgentPresentationFromSpatial } from './desktop-agent-presentation'
import { spaceSessionMemberKey, type SpaceSessionMember } from '@agentmux/core/space-sessions'
import { mountedSessionFact, type MountedSessionObservation } from './space-mount-sessions'
import { mountedRegionKey, type MountedSpaceRegion } from './space-mount-view'

export type OrdinaryMemberReference = { tabId: string; regionId: string; sessionId: string | null }
type ExistingPresentation = { id: string; hostId: string; control: { kind: 'agent'; hostId: string; agentSessionId: string } }
export type OrdinarySpaceMember = { kind: 'existing' } | { kind: 'unconfirmed'; issue: string } | {
  kind: 'foreign'; source: SpaceMountRecord; member: SpaceMountMemberTarget; metadataMember: SpaceSessionMember; presentation: MountedSpaceRegion; creationOperationId: string
}
const existing: OrdinarySpaceMember = Object.freeze({ kind: 'existing' })
const unknown = (): OrdinarySpaceMember => ({ kind: 'unconfirmed', issue: 'The original Space member reference is unconfirmed. Its Region and unsent inputs are kept; no other Session was selected.' })
const cache = new WeakMap<AgentMuxSpatialGraph, { values: Map<string, OrdinarySpaceMember>; regions: Map<string, AgentMuxSpatialGraph['regions'][number]>; tabs: Map<string, AgentMuxSpatialGraph['tabs'][number]>; zones: Map<string, AgentMuxSpatialGraph['zones'][number]>; bindings: Set<string> }>()
/** A presentation address from the accepted original document, never a permission or Run decision. */
export function ordinarySpaceMember(graph: AgentMuxSpatialGraph | null | undefined, reference: OrdinaryMemberReference, sourceHostId: string | undefined, observed?: ExistingPresentation): OrdinarySpaceMember {
  if (!graph) return existing
  const key = JSON.stringify([sourceHostId, reference.tabId, reference.regionId, reference.sessionId, observed?.id, observed?.hostId, observed?.control.hostId, observed?.control.agentSessionId])
  let index = cache.get(graph)
  if (!index) {
    index = { values: new Map(), regions: new Map(graph.regions.map(region => [JSON.stringify([region.tabId, region.regionId]), region])),
      tabs: new Map(graph.tabs.map(tab => [tab.tabId, tab])), zones: new Map(graph.zones.map(zone => [zone.zoneId, zone])), bindings: new Set(graph.bindings.map(binding => JSON.stringify([binding.spaceId, binding.zoneId]))) }
    cache.set(graph, index)
  }
  const prior = index.values.get(key)
  if (prior) return prior
  const project = (): OrdinarySpaceMember => {
    const region = index.regions.get(JSON.stringify([reference.tabId, reference.regionId]))
    if (!region || region.kind !== 'agent') return existing
    // Core's association placeholder is not a local Session or execution.
    if ('association' in region && region.association !== undefined) return unknown()
    if (!region.execution) return existing
    // Core's local selector is local to this original source, not a display label.
    const foreignSelector = region.execution.hostId !== 'local'
    const presentation = desktopAgentPresentationFromSpatial(graph, region)
    // Preserve the original pre-admission consumer only for its exact Core presentation.
    // This does not qualify a new member or borrow a same-SID local Session.
    const legacy = () => !foreignSelector || Boolean(presentation && observed && observed.id === reference.sessionId &&
      presentation.sessionId === observed.id && presentation.agentSessionId === observed.control.agentSessionId &&
      presentation.hostId === observed.hostId && observed.control.hostId === presentation.hostId) ? existing : unknown()
    if (!region.creationOperationId) return legacy()
    let admission: ReturnType<typeof spatialAgentOpenRecord>
    try { admission = spatialAgentOpenRecord(graph, region.creationOperationId) } catch { return foreignSelector ? unknown() : existing }
    if (!admission) return legacy()
    const sourceRuntimeId = admission?.placement?.runtimeId, executionRuntimeId = region.execution.runtimeId
    if (!sourceRuntimeId || !executionRuntimeId) return legacy()
    if (sourceRuntimeId === executionRuntimeId) return existing
    const tab = index.tabs.get(reference.tabId)
    if (!sourceHostId || !admission || !admission.address.spaceId || !admission.address.zoneId || !admission.address.workspaceId || !region.agentSessionId || !region.runId ||
        reference.sessionId !== region.agentSessionId && reference.sessionId !== presentation?.sessionId ||
        admission.agentSessionId !== region.agentSessionId || admission.address.tabId !== reference.tabId || admission.address.regionId !== reference.regionId ||
        !tab || tab.zoneId !== admission.address.zoneId || tab.workspaceId !== admission.address.workspaceId ||
        !index.bindings.has(JSON.stringify([admission.address.spaceId, tab.zoneId]))) return unknown()
    const source: SpaceMountRecord = { hostId: sourceHostId, reference: { runtimeId: sourceRuntimeId, spaceId: admission.address.spaceId }, zoneId: admission.address.zoneId, workspaceId: admission.address.workspaceId }
    return { kind: 'foreign', source, creationOperationId: region.creationOperationId,
      presentation: { key: mountedRegionKey(source.reference, tab.tabId, region.regionId), reference: source.reference, tab, region, zone: tab.zoneId === null ? undefined : index.zones.get(tab.zoneId) },
      metadataMember: { hostId: region.execution.hostId, runtimeId: executionRuntimeId, agentSessionId: region.agentSessionId },
      member: { hostId: sourceHostId, target: { reference: source.reference, regionId: region.regionId, runtimeId: executionRuntimeId, agentSessionId: region.agentSessionId,
        expectedRun: { runId: region.runId }, expectedAdmission: { kind: 'creation', operationId: region.creationOperationId } } } }
  }
  const result = project(); index.values.set(key, result); return result
}

/** A current Session owner supplies the Run address; membership and access remain Core decisions. */
function ordinaryMemberObservedRun(occurrence: Extract<OrdinarySpaceMember, { kind: 'foreign' }>, observation: MountedSessionObservation | undefined): string | undefined {
  const reference = occurrence.source.reference, opening = observation?.opening
  if (!observation || !opening || opening.reference.runtimeId !== reference.runtimeId || opening.reference.spaceId !== reference.spaceId || opening.source.runtimeId !== reference.runtimeId) return
  const key = spaceSessionMemberKey(occurrence.metadataMember), current = observation.members[key]
  const fact = current?.state.status === 'observed' ? current : observation.lastConfirmed[key], state = fact?.state
  if (state?.status === 'observed' && state.authority.runtimeId === occurrence.member.target.runtimeId && state.session.agentSessionId === occurrence.member.target.agentSessionId)
    return state.session.run?.runId
}

/** Renderer values for one occurrence. The roster and its revisions stay with the source reader. */
export function ordinaryMemberObservation(occurrence: Extract<OrdinarySpaceMember, { kind: 'foreign' }>, snapshot: SpaceSnapshot | undefined, observation: MountedSessionObservation | undefined) {
  const reference = occurrence.source.reference
  const fact = snapshot?.reference.runtimeId === reference.runtimeId && snapshot.reference.spaceId === reference.spaceId
    ? mountedSessionFact(snapshot, observation, occurrence.presentation.key) : undefined
  const member = fact?.current?.member, relation = fact?.occurrence
  return {
    current: fact?.current, last: fact?.last, stale: fact?.stale,
    reading: observation?.reading, observedRun: ordinaryMemberObservedRun(occurrence, observation),
    relation: member && spaceSessionMemberKey(member) === spaceSessionMemberKey(occurrence.metadataMember) &&
      relation?.regionId === occurrence.member.target.regionId && relation.creationOperationId === occurrence.creationOperationId ? relation : undefined
  }
}
