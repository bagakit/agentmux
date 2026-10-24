import { AgentMuxError } from './errors.js'
import { mintObjectId } from './object-id.js'
import { groupIds, type WorkspaceLayout } from './spatial-layout.js'
import type { AgentMuxSpaceAddress, AgentMuxSpaceCatalog, AgentMuxSpaceDestination, AgentMuxSpaceSelector, AgentMuxSpatialIssue } from './space-control.js'

export class AgentMuxSpatialTargetError extends AgentMuxError {
  constructor(readonly issue: AgentMuxSpatialIssue) { super(issue.message, issue.code) }
}
function failure(code: string, message: string, candidates?: AgentMuxSpaceSelector[]): never {
  throw new AgentMuxSpatialTargetError({ step: 'target', code, message,
    recovery: 'Use amux space ls, then choose the exact Space/Zone/Tab/Region.', ...(candidates ? { candidates } : {}) })
}
type LooseSelector = { [K in keyof AgentMuxSpaceSelector]?: string | undefined }
function match(selector: LooseSelector, address: Partial<Record<keyof AgentMuxSpaceSelector, string | null>>): boolean {
  return Object.entries(selector).every(([key, value]) => value === undefined || address[key as keyof typeof address] === value)
}

export function selectSpatialCatalog(catalog: AgentMuxSpaceCatalog, target: AgentMuxSpaceSelector): AgentMuxSpaceCatalog {
  if (!Object.values(target).some(Boolean)) return catalog
  if (target.spaceId && !catalog.spaces.some(space => space.spaceId === target.spaceId) ||
    target.zoneId && !catalog.zones.some(zone => zone.zoneId === target.zoneId) ||
    target.tabId && !catalog.tabs.some(tab => tab.tabId === target.tabId) ||
    target.regionId && !catalog.regions.some(region => region.regionId === target.regionId)) {
    failure('SPACE_TARGET_UNKNOWN', 'The exact spatial entity is not currently known.')
  }
  const region = target.regionId ? catalog.regions.find(region => region.regionId === target.regionId) : undefined
  const tabId = target.tabId ?? region?.tabId
  if (target.tabId && region && target.tabId !== region.tabId) failure('SPACE_PARENT_MISMATCH', 'The Region is not a member of this Tab.')
  const tab = tabId ? catalog.tabs.find(tab => tab.tabId === tabId) : undefined
  if (target.zoneId && tab && target.zoneId !== tab.zoneId) failure('SPACE_PARENT_MISMATCH', 'The Tab is not a member of this Zone.')
  const zoneId = target.zoneId ?? tab?.zoneId
  const bindings = catalog.bindings.filter(binding => (!target.spaceId || binding.spaceId === target.spaceId) && (!zoneId || binding.zoneId === zoneId))
  if (target.spaceId && zoneId && !bindings.length) failure('SPACE_PARENT_MISMATCH', 'This Zone is not bound to the specified Space.')
  const zoneIds = zoneId ? new Set([zoneId]) : target.spaceId ? new Set(bindings.map(binding => binding.zoneId)) : null
  const locations = catalog.locations.filter(location => match(target, location) && (!tabId || location.tabId === tabId))
  if ((target.groupId || target.displayWorkspaceId) && !locations.length) failure('SPACE_LOCATION_UNKNOWN', 'The exact display occurrence is not currently known.')
  const locationConstrained = Boolean(target.groupId || target.displayWorkspaceId)
  const locationTabIds = new Set(locations.map(location => location.tabId))
  const selectedTabs = catalog.tabs.filter(tab => (!tabId || tab.tabId === tabId) &&
    (!zoneIds || tab.zoneId !== null && zoneIds.has(tab.zoneId)) && (!locationConstrained || locationTabIds.has(tab.tabId)))
  const selectedIds = new Set(selectedTabs.map(tab => tab.tabId))
  const selectedZoneIds = locationConstrained ? new Set(selectedTabs.flatMap(tab => tab.zoneId ? [tab.zoneId] : []))
    : zoneIds ?? new Set(selectedTabs.flatMap(tab => tab.zoneId ? [tab.zoneId] : []))
  const selectedBindings = bindings.filter(binding => selectedZoneIds.has(binding.zoneId))
  const selectedSpaceIds = new Set(selectedBindings.map(binding => binding.spaceId))
  return {
    ...(catalog.motePresentation ? { motePresentation: catalog.motePresentation.filter(value => target.spaceId ? value.spaceId === target.spaceId : selectedSpaceIds.has(value.spaceId)) } : {}),
    ...(catalog.agentPresentation ? { agentPresentation: catalog.agentPresentation.filter(value => catalog.regions.some(region => region.agentSessionId === value.agentSessionId && selectedIds.has(region.tabId))) } : {}),
    ...(catalog.appearance ? { appearance: catalog.appearance.filter(value => target.spaceId ? value.spaceId === target.spaceId : selectedSpaceIds.has(value.spaceId)) } : {}),
    spaces: catalog.spaces.filter(space => target.spaceId ? space.spaceId === target.spaceId : selectedSpaceIds.has(space.spaceId)),
    zones: catalog.zones.filter(zone => selectedZoneIds.has(zone.zoneId)),
    tabs: selectedTabs, regions: catalog.regions.filter(region => selectedIds.has(region.tabId) && (!target.regionId || region.regionId === target.regionId)),
    bindings: selectedBindings, locations: locations.filter(location => selectedIds.has(location.tabId))
  }
}


export type AgentMuxSpatialDestination = { address: AgentMuxSpaceAddress; kind: 'new-tab' | 'empty' | 'split'; anchor?: string; split?: AgentMuxSpaceDestination['split'] }
export function exactSpatialDisplayLayout(layouts: Readonly<Record<string, WorkspaceLayout>>, displayWorkspaceId: string, groupId?: string): WorkspaceLayout {
  const layout = layouts[displayWorkspaceId]
  if (!layout || groupId && (!groupIds(layout.root).includes(groupId) || !layout.groups.some(group => group.id === groupId))) {
    failure('SPACE_LOCATION_UNKNOWN', 'The requested display Workspace or Group is not available.')
  }
  return layout
}
export function spatialDestination(catalog: AgentMuxSpaceCatalog, dest: AgentMuxSpaceDestination,
  mint: { tabId: string; regionId: string }, layouts: Readonly<Record<string, WorkspaceLayout>>): AgentMuxSpatialDestination {
  const selected = selectSpatialCatalog(catalog, { ...(dest.spaceId ? { spaceId: dest.spaceId } : {}),
    ...(dest.zoneId ? { zoneId: dest.zoneId } : {}), ...(dest.tabId ? { tabId: dest.tabId } : {}), ...(dest.regionId ? { regionId: dest.regionId } : {}) })
  if (dest.regionId || dest.tabId) {
    if (dest.newTab) failure('SPACE_TARGET_CONFLICT', 'A new Tab cannot also target an existing Tab/Region.')
    const tab = dest.tabId ? selected.tabs.find(tab => tab.tabId === dest.tabId)
      : selected.tabs.find(tab => tab.tabId === selected.regions.find(region => region.regionId === dest.regionId)?.tabId)
    if (!tab) failure('SPACE_TARGET_UNKNOWN', 'The exact Tab is not known.')
    const regions = selected.regions.filter(region => region.tabId === tab.tabId)
    const region = dest.regionId ? regions.find(region => region.regionId === dest.regionId) : regions.filter(region => region.kind === 'launcher').length === 1 && !dest.split ? regions.find(region => region.kind === 'launcher') : undefined
    if (!region) failure('SPACE_REGION_REQUIRED', 'Choose one exact Region.', regions.map(region => ({ tabId: tab.tabId, regionId: region.regionId })))
    if (!dest.split && region.kind !== 'launcher') failure('SPACE_REGION_OCCUPIED', 'Use an empty Region or an explicit split.')
    const candidates = selected.locations.filter(location => location.tabId === tab.tabId && location.regionId === region.regionId &&
      (!dest.displayWorkspaceId || location.displayWorkspaceId === dest.displayWorkspaceId) && (!dest.groupId || location.groupId === dest.groupId))
    if (candidates.length !== 1) failure('SPACE_LOCATION_REQUIRED', 'Choose the exact display Workspace, Group and Space reference.',
      candidates.map(({ spaceId, zoneId, tabId, regionId, displayWorkspaceId, groupId }) => ({ ...(spaceId ? { spaceId } : {}), ...(zoneId ? { zoneId } : {}), tabId, regionId, displayWorkspaceId, groupId })))
    return { address: { ...candidates[0]!, regionId: dest.split ? mint.regionId : region.regionId },
      kind: dest.split ? 'split' : 'empty', anchor: region.regionId, ...(dest.split ? { split: dest.split } : {}) }
  }
  if (dest.split) failure('SPACE_REGION_REQUIRED', 'A split requires an exact Region.')
  if (selected.zones.length !== 1) failure('SPACE_ZONE_REQUIRED', 'Choose one exact Zone.', selected.zones.map(zone => ({ ...(dest.spaceId ? { spaceId: dest.spaceId } : {}), zoneId: zone.zoneId })))
  const zone = selected.zones[0]!
  const members = selected.bindings.filter(binding => binding.zoneId === zone.zoneId)
  if (!dest.spaceId && members.length > 1) failure('SPACE_LOCATION_REQUIRED', 'Choose the exact Space reference for this Zone.', members.map(binding => binding))
  const displayWorkspaceId = dest.displayWorkspaceId ?? zone.workspaceId
  const layout = dest.displayWorkspaceId ? exactSpatialDisplayLayout(layouts, displayWorkspaceId, dest.groupId) : layouts[displayWorkspaceId]
  if (dest.groupId && (!layout || !groupIds(layout.root).includes(dest.groupId))) failure('SPACE_LOCATION_UNKNOWN', 'The requested Group is not available.')
  const groupId = dest.groupId ?? layout?.activeGroupId ?? mintObjectId()
  return { kind: 'new-tab', address: { spaceId: dest.spaceId ?? members[0]?.spaceId ?? null, zoneId: zone.zoneId,
    workspaceId: zone.workspaceId, displayWorkspaceId, groupId, ...mint } }
}
