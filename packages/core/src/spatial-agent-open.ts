import { mintObjectId } from './object-id.js'
import { AgentMuxError } from './errors.js'
import { agentCreationIntentDigest } from './agent-creation-authority.js'
import { spatialCatalog, type AgentMuxSpatialGraph, type SpatialJson } from './spatial-graph.js'
import { spatialDestination } from './spatial-destination.js'
import { addTabOrThrow, createWorkspaceLayout, createWorkbenchViewLayout, splitWorkbenchRegion } from './spatial-layout.js'

import { AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE, type AgentMuxSpatialAgentOpenRecord, type AgentMuxSpatialAgentOpenRequest } from './spatial-agent-open-contract.js'
export * from './spatial-agent-open-contract.js'

type Document = { schema: 'agentmux.spatial-agent-open.v1'; requests: Record<string, AgentMuxSpatialAgentOpenRecord> }
function document(graph: AgentMuxSpatialGraph): Document {
  const stored = graph.resources[AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE]
  if (stored === undefined) return { schema: 'agentmux.spatial-agent-open.v1', requests: {} }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored) || stored.schema !== 'agentmux.spatial-agent-open.v1' ||
      !stored.requests || typeof stored.requests !== 'object' || Array.isArray(stored.requests)) throw new AgentMuxError(
    'The original spatial creation associations are unreadable. Keep their graph and inspect the original operation.', 'SPATIAL_CREATION_UNCONFIRMED')
  return stored as unknown as Document
}
export function spatialAgentOpenRecord(graph: AgentMuxSpatialGraph, requestId: string): AgentMuxSpatialAgentOpenRecord | null {
  const requests = document(graph).requests
  const original = Object.hasOwn(requests, requestId) ? requests[requestId] : undefined
  if (!original) return null
  if (original.requestId !== requestId || typeof original.digest !== 'string' || typeof original.agentSessionId !== 'string' ||
      !original.address || !original.execution || typeof original.execution.hostId !== 'string' || typeof original.execution.workspacePath !== 'string') throw new AgentMuxError(
    'The exact spatial creation association is unconfirmed. Keep its Session and original request.', 'SPATIAL_CREATION_UNCONFIRMED')
  return structuredClone(original)
}
export function spatialAgentOpenDigest(request: AgentMuxSpatialAgentOpenRequest): string {
  return agentCreationIntentDigest({ operation: request.operation, content: request.content, destination: request.destination,
    focus: request.focus, callerAgentSessionId: request.caller?.agentSessionId ?? null })
}
/** Admission and topology are one graph mutation; no Runtime operation occurs here. */
export function admitSpatialAgentOpen(graph: AgentMuxSpatialGraph, input: { request: AgentMuxSpatialAgentOpenRequest;
  agentSessionId: string; execution: AgentMuxSpatialAgentOpenRecord['execution']; regionResource: SpatialJson }) {
  const digest = spatialAgentOpenDigest(input.request), previous = spatialAgentOpenRecord(graph, input.request.requestId)
  if (previous) {
    if (previous.digest !== digest) throw new AgentMuxError('This operation belongs to another original spatial creation intent.', 'SPACE_REQUEST_CONFLICT')
    const original = graph.regions.find(region => region.tabId === previous.address.tabId && region.regionId === previous.address.regionId)
    const zone = graph.zones.find(zone => zone.zoneId === previous.address.zoneId)
    if (!original || original.kind !== 'agent' || original.agentSessionId !== previous.agentSessionId ||
        JSON.stringify(previous.execution) !== JSON.stringify(input.execution) || !zone || zone.hostId !== previous.execution.hostId ||
        zone.directoryPath !== previous.execution.workspacePath || zone.workspaceId !== previous.execution.workspaceId) throw new AgentMuxError(
      'The exact admitted spatial binding or execution resource changed. Keep the original operation and inspect its Core Session.', 'SPACE_TARGET_CHANGED')
    return { graph, record: previous, admitted: false }
  }
  const next = structuredClone(graph)
  const destination = spatialDestination(spatialCatalog(next), input.request.destination, { tabId: mintObjectId(), regionId: mintObjectId() }, next.layouts)
  const address = destination.address, existingTab = next.tabs.find(tab => tab.tabId === address.tabId)
  const zone = next.zones.find(zone => zone.zoneId === address.zoneId)
  if (input.request.content.kind !== 'new-agent') throw new AgentMuxError('Spatial admission requires the original new Agent intent.', 'INVALID_CONTROL_REQUEST')
  if (!input.request.content.executionWorkspaceId && (!zone || zone.workspaceId !== input.execution.workspaceId ||
      zone.hostId !== input.execution.hostId || zone.directoryPath !== input.execution.workspacePath)) throw new AgentMuxError(
    'The exact original Zone execution resource changed before admission. Existing contents and Agents were retained.', 'SPACE_RESOURCE_CHANGED')
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
  next.regions.push({ tabId: address.tabId, regionId: address.regionId, kind: 'agent', agentSessionId: input.agentSessionId,
    runId: null, execution: { hostId: input.execution.hostId, cwd: input.execution.workspacePath } })
  next.resources['region:' + address.regionId] = structuredClone(input.regionResource)
  const record: AgentMuxSpatialAgentOpenRecord = { executorId: input.request.content.executorId, requestId: input.request.requestId, digest, agentSessionId: input.agentSessionId,
    address, execution: structuredClone(input.execution) }
  const original = document(next); original.requests = Object.fromEntries([...Object.entries(original.requests), [record.requestId, record]])
  next.resources[AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE] = original as unknown as SpatialJson
  return { graph: next, record, admitted: true }
}
