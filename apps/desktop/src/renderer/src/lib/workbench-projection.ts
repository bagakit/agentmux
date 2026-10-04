import type { AgentMuxSpaceCatalog, AgentMuxSpaceLocation } from '@agentmux/core/control'
import { createWorkspaceLayout, groupIds, removeLeaf, groupLeafId, type WorkspaceLayout } from '@agentmux/layout'
import { createContext } from 'react'
import type { WorkbenchTab } from './workbench-tabs'

/** A surface's selection of an original occurrence, never a copied layout or entity. */
export type WorkbenchProjectionSelection = Pick<AgentMuxSpaceLocation,
  'displayWorkspaceId' | 'groupId' | 'tabId' | 'regionId'>
export type WorkbenchEntityReference =
  | { kind: 'zone'; zoneId: string }
  | { kind: 'tab'; tabId: string }
  | { kind: 'region'; regionId: string }
export type WorkbenchProjection = {
  entity: WorkbenchEntityReference
  presentationId: string
  displayWorkspaceId: string
  catalog: AgentMuxSpaceCatalog
  /** Current presentation composition; does not create a durable placement or resource. */
  composition?: WorkspaceLayout
  /** Confirm exact occurrences; otherwise Zone loading uses member preferences. */
  selectionMode?: 'occurrence'
  selection: readonly WorkbenchProjectionSelection[]
  onSelect(reference: WorkbenchProjectionSelection): void
}
export const WorkbenchProjectionContext = createContext<(WorkbenchProjection & {
  unsupportedTabIds: ReadonlySet<string>
  /** Retained composition stays readable without authorizing placement writes. */
  placementConfirmed?: boolean
}) | null>(null)

export function workbenchProjectionMatches(scope: WorkbenchProjection, location: AgentMuxSpaceLocation): boolean {
  return scope.entity.kind === 'zone' ? location.zoneId === scope.entity.zoneId
    : scope.entity.kind === 'tab' ? location.tabId === scope.entity.tabId : location.regionId === scope.entity.regionId
}
export function workbenchProjectionTabIds(scope: WorkbenchProjection): ReadonlySet<string> {
  const entity = scope.entity
  switch (entity.kind) {
    case 'zone': return new Set(scope.catalog.tabs.filter(tab => tab.zoneId === entity.zoneId).map(tab => tab.tabId))
    case 'tab': return new Set(scope.catalog.tabs.filter(tab => tab.tabId === entity.tabId).map(tab => tab.tabId))
    case 'region': return new Set(scope.catalog.regions.filter(region => region.regionId === entity.regionId).map(region => region.tabId))
  }
}
export function workbenchProjectionZone(scope: WorkbenchProjection) {
  const entity = scope.entity
  if (entity.kind === 'zone') return scope.catalog.zones.find(zone => zone.zoneId === entity.zoneId)
  const tabId = entity.kind === 'tab' ? entity.tabId : scope.catalog.regions.find(region => region.regionId === entity.regionId)?.tabId
  const zoneId = scope.catalog.tabs.find(tab => tab.tabId === tabId)?.zoneId
  return scope.catalog.zones.find(zone => zone.zoneId === zoneId)
}
export function selectWorkbenchProjectionTab(scope: WorkbenchProjection, groupId: string, tab: WorkbenchTab, regionId?: string): void {
  const held = scope.selection.find(reference => reference.displayWorkspaceId === scope.displayWorkspaceId && reference.groupId === groupId && reference.tabId === tab.id)
  const reference = { displayWorkspaceId: scope.displayWorkspaceId, groupId, tabId: tab.id,
    regionId: regionId ?? held?.regionId ?? (scope.entity.kind === 'region' ? scope.entity.regionId : tab.layout.activeRegionId) }
  if (scope.entity.kind === 'zone' && scope.selectionMode !== 'occurrence' || scope.catalog.locations.some(location => workbenchProjectionMatches(scope, location) && sameWorkbenchProjectionSelection(location, reference))) scope.onSelect(reference)
}

export function sameWorkbenchProjectionSelection(a: WorkbenchProjectionSelection | null, b: WorkbenchProjectionSelection): boolean {
  return a?.displayWorkspaceId === b.displayWorkspaceId && a.groupId === b.groupId && a.tabId === b.tabId && a.regionId === b.regionId
}

/** Distinct occurrence slots; Topic and Region products never mint another slot. */
export function workbenchProjectionSlotId(prefix: string, reference: Pick<WorkbenchProjectionSelection, 'displayWorkspaceId' | 'groupId' | 'tabId'>): string {
  return `${prefix}:${JSON.stringify([reference.displayWorkspaceId, reference.groupId, reference.tabId])}`
}

/** One exact Region occurrence; sibling Regions never share its target slot. */
export function workbenchRegionProjectionSlotId(prefix: string, reference: WorkbenchProjectionSelection): string {
  return `${prefix}:${JSON.stringify([reference.displayWorkspaceId, reference.groupId, reference.tabId, reference.regionId])}`
}

/** Read-only projection of the original layout algebra and authoritative typed membership. */
export function projectWorkbenchProjection(layout: WorkspaceLayout | undefined, tabs: Readonly<Record<string, WorkbenchTab>>, scope: WorkbenchProjection, activeGroupId: string | null = null): {
  layout: WorkspaceLayout | null
  issues: string[]
  unsupportedTabIds: ReadonlySet<string>
  selection: WorkbenchProjectionSelection[]
} {
  layout = scope.composition ?? layout
  const issues: string[] = []
  const memberIds = workbenchProjectionTabIds(scope)
  const automaticZoneSelection = scope.entity.kind === 'zone' && scope.selectionMode !== 'occurrence'
  const entityKnown = scope.entity.kind === 'zone' ? Boolean(workbenchProjectionZone(scope)) : memberIds.size > 0
  if (!entityKnown || !layout) return { layout: null, issues: ['The original entity or its display layout is still restoring. Its exact reference is kept.'], unsupportedTabIds: new Set(), selection: [] }
  const members = new Map(scope.catalog.tabs.filter(tab => memberIds.has(tab.tabId)).map(tab => [tab.tabId, tab]))
  // Zero authoritative members is an empty Zone; missing loaded content is not.
  if (scope.entity.kind === 'zone' && members.size === 0 && scope.selection.length === 0) {
    const zone = workbenchProjectionZone(scope)!
    if (zone.kind === 'unknown') return { layout: null, issues: [zone.issue ?? 'The original Zone resource is still unconfirmed. Its reference is kept.'], unsupportedTabIds: new Set(), selection: [] }
    return { layout: createWorkspaceLayout(layout.activeGroupId), issues: [], unsupportedTabIds: new Set(), selection: [] }
  }
  const placements = new Map<string, Set<string>>()
  for (const location of scope.entity.kind === 'zone' ? [] : scope.catalog.locations) {
    if (!workbenchProjectionMatches(scope, location) || location.displayWorkspaceId !== scope.displayWorkspaceId || !members.has(location.tabId)) continue
    const group = placements.get(location.groupId) ?? new Set<string>()
    group.add(location.tabId)
    placements.set(location.groupId, group)
  }
  const selected = new Map<string, WorkbenchProjectionSelection>()
  const inTree = new Set(groupIds(layout.root))
  const referencesByGroup = new Map<string, WorkbenchProjectionSelection[]>()
  for (const reference of scope.selection) {
    if (reference.displayWorkspaceId !== scope.displayWorkspaceId) continue
    const references = referencesByGroup.get(reference.groupId) ?? []
    references.push(reference); referencesByGroup.set(reference.groupId, references)
  }
  for (const [groupId, references] of referencesByGroup) {
    // Zone selection is a preference, never a prerequisite for loading its members.
    if (automaticZoneSelection) continue
    if (references.length !== 1) {
      issues.push('More than one selection refers to the same display Group. The exact references are kept; choose a Tab explicitly.')
      continue
    }
    const reference = references[0]!
    if (!inTree.has(groupId) || !layout.groups.some(group => group.id === groupId && group.tabOrder.includes(reference.tabId)) ||
      !scope.catalog.locations.some(location => workbenchProjectionMatches(scope, location) && sameWorkbenchProjectionSelection(location, reference)) ||
      !tabs[reference.tabId]?.regions[reference.regionId]) {
      issues.push('The selected original Tab or Region occurrence is still restoring. Its exact reference is kept.')
      continue
    }
    selected.set(groupId, reference)
  }
  const groups = layout.groups.map(group => {
    const tabOrder = group.tabOrder.filter(id => (scope.entity.kind === 'zone' ? inTree.has(group.id) : placements.get(group.id)?.has(id)) && members.has(id) && members.get(id)?.workspaceId === tabs[id]?.workspaceId)
    if (automaticZoneSelection) {
      const preferences = scope.selection.filter(reference => tabOrder.includes(reference.tabId))
      const held = preferences.filter(reference => reference.displayWorkspaceId === scope.displayWorkspaceId && reference.groupId === group.id).at(-1) ?? preferences.at(-1)
      const tabId = held?.tabId ?? (group.activeTabId && tabOrder.includes(group.activeTabId) ? group.activeTabId : group.recentTabIds.filter(id => tabOrder.includes(id)).at(-1) ?? tabOrder.at(-1))
      const tab = tabId ? tabs[tabId] : undefined
      if (tab) selected.set(group.id, { displayWorkspaceId: scope.displayWorkspaceId, groupId: group.id, tabId: tab.id,
        regionId: held && tab.regions[held.regionId] ? held.regionId : tab.layout.activeRegionId })
    }
    return { ...group, tabOrder, activeTabId: selected.get(group.id)?.tabId ?? null,
      recentTabIds: group.recentTabIds.filter(id => tabOrder.includes(id)) }
  })
  if (!groups.some(group => group.tabOrder.length > 0)) return { layout: null,
    issues: [...issues, 'This original entity has no confirmed display occurrence here. Its content and reference are kept.'], unsupportedTabIds: new Set(), selection: [] }
  let root = layout.root
  for (const group of groups) if (!group.tabOrder.length) root = removeLeaf(root, groupLeafId, group.id) ?? root
  const visibleGroupIds = new Set(groupIds(root))
  const occurrences = new Map<string, Set<string>>()
  for (const group of groups) if (visibleGroupIds.has(group.id) && group.activeTabId) {
    const displays = occurrences.get(group.activeTabId) ?? new Set<string>()
    displays.add(group.id); occurrences.set(group.activeTabId, displays)
  }
  const unsupportedTabIds = new Set([...occurrences].filter(([id, displays]) => displays.size > 1).map(([id]) => id))
  if (unsupportedTabIds.size) issues.push('The same Tab has more than one presentation reference. Simultaneous live presentation is not available in the current content owner; every exact reference is kept.')
  const confirmedActiveGroupId = activeGroupId && selected.has(activeGroupId) && visibleGroupIds.has(activeGroupId) ? activeGroupId
    : selected.size === 1 ? [...selected.keys()][0]
    : selected.has(layout.activeGroupId) && visibleGroupIds.has(layout.activeGroupId) ? layout.activeGroupId : null
  const projectedActiveGroupId = scope.selectionMode === 'occurrence' ? confirmedActiveGroupId ?? ''
    : activeGroupId && visibleGroupIds.has(activeGroupId) ? activeGroupId
    : visibleGroupIds.has(layout.activeGroupId) ? layout.activeGroupId : ''
  return { layout: { root, groups, activeGroupId: projectedActiveGroupId }, issues, unsupportedTabIds, selection: [...selected.values()] }
}

/** A direct presentation Group is UI composition, never an original placement address. */
export function workbenchZoneUnplacedGroupId(zoneId: string): string { return `zone-unplaced:${zoneId}` }

/** Load a Zone from its resource composition; display aliases never select its content. */
export function resolveWorkbenchZone(zoneId: string, catalog: AgentMuxSpaceCatalog, layouts: Readonly<Record<string, WorkspaceLayout>>,
  tabs: Readonly<Record<string, WorkbenchTab>>, presentationId: string, preferences: readonly Pick<WorkbenchProjectionSelection, 'tabId' | 'regionId'>[], onSelect: WorkbenchProjection['onSelect']): WorkbenchProjection | null {
  const zone = catalog.zones.find(zone => zone.zoneId === zoneId)
  if (!zone) return null
  const members = new Set(catalog.tabs.filter(tab => tab.zoneId === zoneId && tabs[tab.tabId]).map(tab => tab.tabId))
  const original = layouts[zone.workspaceId]
  const groups = new Set(original ? groupIds(original.root) : [])
  const placed = new Set(original?.groups.flatMap(group => groups.has(group.id) ? group.tabOrder : []) ?? [])
  const unplaced = [...members].filter(id => !placed.has(id))
  let composition = original
  if (unplaced.length) {
    const direct = createWorkspaceLayout(workbenchZoneUnplacedGroupId(zoneId), unplaced)
    composition = original && [...members].some(id => placed.has(id)) ? { ...original, groups: [...original.groups, ...direct.groups], root: {
      type: 'split', direction: 'horizontal', ratio: 0.5, first: original.root, second: direct.root
    } } : direct
  }
  const scope: WorkbenchProjection = { entity: { kind: 'zone', zoneId }, presentationId,
    displayWorkspaceId: zone.workspaceId, catalog, ...(composition ? { composition } : {}), selection: composition?.groups.flatMap(group => preferences.filter(member => group.tabOrder.includes(member.tabId))
      .map(member => ({ displayWorkspaceId: zone.workspaceId, groupId: group.id, ...member }))) ?? [], onSelect }
  const resolved = projectWorkbenchProjection(composition, tabs, scope)
  return resolved.layout ? { ...scope, selection: resolved.selection } : null
}
