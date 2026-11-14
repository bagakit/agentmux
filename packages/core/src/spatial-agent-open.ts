import { parseAgentTakeoverProvenance, takeoverDestinationOrganization, qualifyTakeoverOrganization, sameTakeoverOrganization, type AgentTakeoverPreparation } from './agent-takeover.js'
import { mintObjectId } from './object-id.js'
import { AgentMuxError } from './errors.js'
import { agentCreationIntentDigest } from './agent-creation-authority.js'
import { spatialCatalog, type AgentMuxSpatialGraph, type SpatialJson } from './spatial-graph.js'
import { spatialDestination } from './spatial-destination.js'
import { addTabOrThrow, createWorkspaceLayout, createWorkbenchViewLayout, splitWorkbenchRegion } from './spatial-layout.js'

import { AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE, parseMoteMainCreationIntent, pendingMoteMainCreation, spatialAgentOpenRecord, spatialAgentOpenDocument, spatialAgentAssociationRecord, type AgentMuxSpatialAgentAssociationRequest, type AgentMuxSpatialAgentAssociationRecord, type AgentMuxSpatialAgentOpenRecord, type AgentMuxSpatialAgentOpenRequest } from './spatial-agent-open-contract.js'
export * from './spatial-agent-open-contract.js'

export function spatialAgentOpenDigest(request: AgentMuxSpatialAgentOpenRequest): string {
  return agentCreationIntentDigest({ operation: request.operation, content: request.content, destination: request.destination,
    focus: request.focus, callerAgentSessionId: request.caller?.agentSessionId ?? null, ...(request.moteMain ? { moteMain: request.moteMain } : {}) })
}
/** One topology allocator for both creation C and external association L. */
function spatialAgentOpenDestination(graph: AgentMuxSpatialGraph, request: AgentMuxSpatialAgentOpenRequest) {
  const next = structuredClone(graph)
  const destination = spatialDestination(spatialCatalog(next), request.destination, { tabId: mintObjectId(), regionId: mintObjectId() }, next.layouts)
  const address = destination.address, existingTab = next.tabs.find(tab => tab.tabId === address.tabId)
  const zone = next.zones.find(zone => zone.zoneId === address.zoneId)
  if (destination.kind === 'new-tab') {
    if (existingTab) throw new AgentMuxError('The reserved Tab already exists. Original contents were retained.', 'SPACE_TARGET_CHANGED')
    next.tabs.push({ tabId: address.tabId, workspaceId: address.workspaceId, zoneId: address.zoneId, name: null, regionIds: [address.regionId] })
    next.tabLayouts[address.tabId] = createWorkbenchViewLayout(address.regionId)
    next.resources['tab:' + address.tabId] = { titleRegionId: address.regionId }
    const layout = next.layouts[address.displayWorkspaceId] ?? createWorkspaceLayout(address.groupId)
    const placed = addTabOrThrow(layout, address.groupId, address.tabId)
    next.layouts[address.displayWorkspaceId] = { ...placed, activeGroupId: layout.activeGroupId, groups: placed.groups.map(group => {
      const before = layout.groups.find(candidate => candidate.id === group.id)
      return before?.activeTabId ? { ...group, activeTabId: before.activeTabId, recentTabIds: before.recentTabIds } : group
    }) }
  } else {
    const original = next.regions.find(region => region.tabId === address.tabId && region.regionId === destination.anchor)
    const layout = next.tabLayouts[address.tabId]
    if (!existingTab || !original || !layout) throw new AgentMuxError('The exact original Region changed. Its contents were retained.', 'SPACE_TARGET_CHANGED')
    if (destination.kind === 'split') {
      const split = splitWorkbenchRegion(layout, original.regionId, destination.split!, address.regionId)
      if (split === layout) throw new AgentMuxError('The exact Region cannot accept this split.', 'SPACE_TARGET_CHANGED')
      next.tabLayouts[address.tabId] = { ...split, activeRegionId: layout.activeRegionId }
      existingTab.regionIds.push(address.regionId)
    } else {
      if (original.kind !== 'launcher') throw new AgentMuxError('The original Region is now occupied. Its contents were retained.', 'SPACE_REGION_OCCUPIED')
      next.regions = next.regions.filter(region => region !== original)
    }
  }
  return { graph: next, address, zone }
}
/** Admission and topology are one graph mutation; no Runtime operation occurs here. */
export function admitSpatialAgentOpen(graph: AgentMuxSpatialGraph, input: { request: AgentMuxSpatialAgentOpenRequest;
  agentSessionId: string; takeover?: { preparation: AgentTakeoverPreparation; requestDigest: string; sourceAgentMuxNote?: string; optionalContext?: AgentMuxSpatialAgentOpenRecord['takeoverOptionalContext'] }; execution: AgentMuxSpatialAgentOpenRecord['execution']; placement?: AgentMuxSpatialAgentOpenRecord['placement'];
  executionBinding?: AgentMuxSpatialAgentOpenRecord['executionBinding']; regionResource: SpatialJson }) {
  if (spatialAgentAssociationRecord(graph, input.request.requestId)) throw new AgentMuxError('This operation already belongs to an external association, not an Agent creation.', 'SPACE_REQUEST_CONFLICT')
  if (input.request.moteMain) {
    const intent = parseMoteMainCreationIntent(input.request.moteMain)
    if (intent.target.expectedResource.hostId !== input.execution.hostId || intent.target.expectedResource.workspaceId !== input.execution.workspaceId ||
      intent.target.spaceId !== input.request.destination.spaceId || intent.target.zoneId !== input.request.destination.zoneId ||
      input.request.content.kind !== 'new-agent' || intent.baseline.defaults.executorId !== input.request.content.executorId)
      throw new AgentMuxError('The Main intent belongs to another original execution resource.', 'SPACE_RESOURCE_CHANGED')
  }
  const digest = spatialAgentOpenDigest(input.request), previous = spatialAgentOpenRecord(graph, input.request.requestId)
  const mainIntent = input.request.moteMain
  const pending = mainIntent ? pendingMoteMainCreation(graph, mainIntent.target, mainIntent.expectedRoleRevision) : null
  if (pending && pending.requestId !== input.request.requestId) throw new AgentMuxError(
    'This Mote already has an original unfinished Main creation. Inspect that operation without starting another Agent.',
    'MOTE_MAIN_CREATION_PENDING', JSON.stringify({ operationId: pending.requestId, target: pending.moteMain!.target }))
  if (previous) {
    if (previous.digest !== digest) throw new AgentMuxError('This operation belongs to another original spatial creation intent.', 'SPACE_REQUEST_CONFLICT')
    const original = graph.regions.find(region => region.tabId === previous.address.tabId && region.regionId === previous.address.regionId)
    const zone = graph.zones.find(zone => zone.zoneId === previous.address.zoneId)
    const placement = previous.placement ?? previous.execution
    if (previous.agentSessionId !== input.agentSessionId || !original || original.kind !== 'agent' || original.agentSessionId !== previous.agentSessionId ||
        original.execution?.hostId !== previous.execution.hostId || original.execution.cwd !== previous.execution.workspacePath ||
        original.execution.runtimeId !== previous.execution.runtimeId ||
        JSON.stringify(previous.execution) !== JSON.stringify(input.execution) || JSON.stringify(previous.placement) !== JSON.stringify(input.placement) ||
        JSON.stringify(previous.executionBinding) !== JSON.stringify(input.executionBinding) || !zone || zone.hostId !== placement.hostId ||
        zone.directoryPath !== placement.workspacePath || zone.workspaceId !== placement.workspaceId) throw new AgentMuxError(
      'The exact admitted spatial binding or execution resource changed. Keep the original operation and inspect its Core Session.', 'SPACE_TARGET_CHANGED')
    return { graph, record: previous, admitted: false }
  }
  const { graph: next, address, zone } = spatialAgentOpenDestination(graph, input.request)
  if (input.takeover) {
    const frozen = input.takeover.preparation.destination
    const actual = takeoverDestinationOrganization(graph, address, frozen.owner.runtimeId)
    if (!sameTakeoverOrganization(actual, frozen.organization)) throw new AgentMuxError('The original Takeover destination organization changed before admission.', 'SPACE_TARGET_CHANGED')
    const origin = input.takeover.preparation.source
    if (origin.organization?.reference.runtimeId === frozen.owner.runtimeId && !sameTakeoverOrganization(qualifyTakeoverOrganization(graph, origin.organization.reference, origin), origin.organization)) throw new AgentMuxError('The original Takeover source organization changed before admission.', 'AGENT_TAKEOVER_SOURCE_CHANGED')
  }
  if (input.request.content.kind !== 'new-agent') throw new AgentMuxError('Spatial admission requires the original new Agent intent.', 'INVALID_CONTROL_REQUEST')
  if (input.request.content.agentTarget && (!input.placement || input.execution.runtimeId !== input.request.content.agentTarget.runtimeId ||
      input.executionBinding && (input.executionBinding.agentSessionId !== input.agentSessionId || input.executionBinding.createOperationId !== input.request.requestId))) throw new AgentMuxError(
    'The source placement and original Agent target are not confirmed together. Keep the original request.', 'SPACE_RESOURCE_CHANGED')
  const placement = input.placement ?? input.execution
  if (!input.request.content.executionWorkspaceId && (!zone || zone.workspaceId !== placement.workspaceId ||
      zone.hostId !== placement.hostId || zone.directoryPath !== placement.workspacePath)) throw new AgentMuxError(
    'The exact original Zone execution resource changed before admission. Existing contents and Agents were retained.', 'SPACE_RESOURCE_CHANGED')
  next.regions.push({ tabId: address.tabId, regionId: address.regionId, kind: 'agent', agentSessionId: input.agentSessionId,
    creationOperationId: input.request.requestId,
    runId: null, execution: { hostId: input.execution.hostId, cwd: input.execution.workspacePath,
      ...(input.execution.runtimeId ? { runtimeId: input.execution.runtimeId } : {}) } })
  next.resources['region:' + address.regionId] = structuredClone(input.regionResource)
  const record: AgentMuxSpatialAgentOpenRecord = { executorId: input.request.content.executorId, requestId: input.request.requestId, digest, agentSessionId: input.agentSessionId,
    address, execution: structuredClone(input.execution), ...(input.takeover ? { takeover: parseAgentTakeoverProvenance({ ...input.takeover.preparation, destination: { ...input.takeover.preparation.destination, address } }), takeoverRequestDigest: input.takeover.requestDigest, takeoverContent: structuredClone(input.request.content), ...(input.takeover.sourceAgentMuxNote === undefined ? {} : { takeoverSourceAgentMuxNote: input.takeover.sourceAgentMuxNote }), ...(input.takeover.optionalContext === undefined ? {} : { takeoverOptionalContext: structuredClone(input.takeover.optionalContext) }) } : {}), ...(input.placement ? { placement: structuredClone(input.placement) } : {}),
    ...(input.executionBinding ? { executionBinding: structuredClone(input.executionBinding) } : {}),
    ...(input.request.moteMain ? { moteMain: structuredClone(input.request.moteMain) } : {}) }
  const original = spatialAgentOpenDocument(next); original.requests = Object.fromEntries([...Object.entries(original.requests), [record.requestId, record]])
  next.resources[AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE] = original as unknown as SpatialJson
  return { graph: next, record, admitted: true }
}

/** Only business membership is admitted. No A transport, Session lookup or execution journal is opened. */
export function admitSpatialAgentAssociation(graph: AgentMuxSpatialGraph, request: AgentMuxSpatialAgentAssociationRequest, sourceRuntimeId: string) {
  const digest = spatialAgentOpenDigest(request), previous = spatialAgentAssociationRecord(graph, request.requestId)
  if (spatialAgentOpenRecord(graph, request.requestId)) throw new AgentMuxError('This operation already belongs to an original creation.', 'SPACE_REQUEST_CONFLICT')
  if (previous && previous.digest !== digest) throw new AgentMuxError('This L names another original association intent.', 'SPACE_REQUEST_CONFLICT')
  const resource = request.content.expectedResource
  const address = previous?.address
  const zone = graph.zones.find(zone => zone.zoneId === (address?.zoneId ?? request.destination.zoneId))
  const spaceId = address?.spaceId ?? request.destination.spaceId
  if (resource.runtimeId !== sourceRuntimeId || !zone || zone.hostId !== 'local' || zone.workspaceId !== resource.workspaceId || zone.directoryPath !== resource.workspacePath ||
      !graph.bindings.some(binding => binding.spaceId === spaceId && binding.zoneId === zone.zoneId)) throw new AgentMuxError('The exact Source Runtime, Space and project resource changed. Keep the original association request.', 'SPACE_RESOURCE_CHANGED')
  if (previous) {
    const region = graph.regions.find(region => region.tabId === address!.tabId && region.regionId === address!.regionId)
    if (!region || region.kind !== 'agent' || region.association?.operationId !== previous.requestId || region.agentSessionId !== null || region.runId !== null || region.execution !== null ||
        previous.placement.runtimeId !== sourceRuntimeId || previous.placement.workspaceId !== zone.workspaceId || previous.placement.hostId !== zone.hostId || previous.placement.workspacePath !== zone.directoryPath) throw new AgentMuxError('The original associated Region or resource changed. No replacement was attached.', 'SPACE_TARGET_CHANGED')
    return { graph, record: previous, admitted: false }
  }
  const placed = spatialAgentOpenDestination(graph, request), next = placed.graph
  const record: AgentMuxSpatialAgentAssociationRecord = { kind: 'association', requestId: request.requestId, digest, address: placed.address,
    reference: structuredClone(request.content.reference), placement: { runtimeId: sourceRuntimeId, hostId: zone.hostId, workspaceId: zone.workspaceId, workspacePath: zone.directoryPath } }
  next.regions.push({ tabId: record.address.tabId, regionId: record.address.regionId, kind: 'agent', agentSessionId: null, runId: null, execution: null, association: { operationId: record.requestId } })
  next.resources['region:' + record.address.regionId] = { workspaceId: zone.workspaceId }
  const document = spatialAgentOpenDocument(next); document.requests = { ...document.requests, [record.requestId]: record }
  next.resources[AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE] = document as unknown as SpatialJson
  spatialAgentAssociationRecord(next, record.requestId)
  return { graph: next, record, admitted: true }
}
