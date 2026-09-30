import type { AgentMuxSpaceCatalog, AgentMuxSpaceLocation } from '@agentmux/core/control'
import { groupIds, removeLeaf, groupLeafId, type WorkspaceLayout } from '@agentmux/layout'
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
  selection: readonly WorkbenchProjectionSelection[]
  onSelect(reference: WorkbenchProjectionSelection): void
}
export const WorkbenchProjectionContext = createContext<(WorkbenchProjection & { unsupportedTabIds: ReadonlySet<string> }) | null>(null)

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
  if (scope.catalog.locations.some(location => workbenchProjectionMatches(scope, location) && sameWorkbenchProjectionSelection(location, reference))) scope.onSelect(reference)
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
} {
  const issues: string[] = []
  const memberIds = workbenchProjectionTabIds(scope)
  const entityKnown = scope.entity.kind === 'zone' ? Boolean(workbenchProjectionZone(scope)) : memberIds.size > 0
  if (!entityKnown || !layout) return { layout: null, issues: ['The original entity or its display layout is still restoring. Its exact reference is kept.'], unsupportedTabIds: new Set() }
  const members = new Map(scope.catalog.tabs.filter(tab => memberIds.has(tab.tabId)).map(tab => [tab.tabId, tab]))
  const placements = new Map<string, Set<string>>()
  for (const location of scope.catalog.locations) {
    if (!workbenchProjectionMatches(scope, location) || location.displayWorkspaceId !== scope.displayWorkspaceId || !members.has(location.tabId)) continue
    const group = placements.get(location.groupId) ?? new Set<string>()
    group.add(location.tabId)
    placements.set(location.groupId, group)
  }
  const selected = new Map<string, WorkbenchProjectionSelection>()
  const referencesByGroup = new Map<string, WorkbenchProjectionSelection[]>()
  for (const reference of scope.selection) {
    if (reference.displayWorkspaceId !== scope.displayWorkspaceId) continue
    const references = referencesByGroup.get(reference.groupId) ?? []
    references.push(reference); referencesByGroup.set(reference.groupId, references)
  }
  for (const [groupId, references] of referencesByGroup) {
    if (references.length !== 1) {
      issues.push('More than one selection refers to the same display Group. The exact references are kept; choose a Tab explicitly.')
      continue
    }
    const reference = references[0]!
    if (!scope.catalog.locations.some(location => workbenchProjectionMatches(scope, location) && sameWorkbenchProjectionSelection(location, reference)) ||
      !tabs[reference.tabId]?.regions[reference.regionId]) {
      issues.push('The selected original Tab or Region occurrence is still restoring. Its exact reference is kept.')
      continue
    }
    selected.set(groupId, reference)
  }
  const groups = layout.groups.map(group => {
    const tabOrder = group.tabOrder.filter(id => placements.get(group.id)?.has(id) && members.get(id)?.workspaceId === tabs[id]?.workspaceId)
    return { ...group, tabOrder, activeTabId: selected.get(group.id)?.tabId ?? null,
      recentTabIds: group.recentTabIds.filter(id => tabOrder.includes(id)) }
  })
  if (!groups.some(group => group.tabOrder.length > 0)) return { layout: null,
    issues: [...issues, 'This original entity has no confirmed display occurrence here. Its content and reference are kept.'], unsupportedTabIds: new Set() }
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
  const projectedActiveGroupId = activeGroupId && visibleGroupIds.has(activeGroupId) ? activeGroupId
    : visibleGroupIds.has(layout.activeGroupId) ? layout.activeGroupId : ''
  return { layout: { root, groups, activeGroupId: projectedActiveGroupId }, issues, unsupportedTabIds }
}
