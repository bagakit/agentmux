import { groupIds, type WorkspaceLayout } from '@agentmux/layout'
import { workbenchProjectionSlotId, type WorkbenchProjectionSelection } from './workbench-projection'
import type { WorkbenchViewTarget, WorkbenchViewTargets } from './workbench-presentation'
import type { WorkbenchTab } from './workbench-tabs'

type Tabs = Readonly<Record<string, WorkbenchTab>>
const resources = new WeakMap<Tabs, ReadonlyMap<string, Record<string, WorkbenchTab>>>()
const memberships = new WeakMap<WorkspaceLayout, WeakMap<Tabs, ReadonlyMap<string, Record<string, WorkbenchTab>>>>()
const layoutMembers = new WeakMap<WorkspaceLayout, {
  visible: ReadonlySet<string>; groups: ReadonlyMap<string, ReadonlySet<string>>
  active: ReadonlyMap<string, string | null>; occurrences: ReadonlyMap<string, number>
}>()

function displayMembership(layout: WorkspaceLayout) {
  let index = layoutMembers.get(layout)
  if (!index) {
    const visible = new Set(groupIds(layout.root)), occurrences = new Map<string, number>()
    const groups = new Map(layout.groups.map(group => [group.id, new Set(group.tabOrder)]))
    for (const [groupId, ids] of groups) if (visible.has(groupId)) for (const id of ids) occurrences.set(id, (occurrences.get(id) ?? 0) + 1)
    index = { visible, groups, occurrences, active: new Map(layout.groups.map(group => [group.id, group.activeTabId])) }
    layoutMembers.set(layout, index)
  }
  return index
}

/** Confirmation is constant work after one pass over a changed display layout. */
export function workbenchDisplayReferenceMatches(layout: WorkspaceLayout | undefined, reference: WorkbenchProjectionSelection): boolean {
  if (!layout) return false
  const index = displayMembership(layout)
  return index.visible.has(reference.groupId) && index.groups.get(reference.groupId)?.has(reference.tabId) === true
}

export function workbenchDisplayOccurrenceAmbiguous(layout: WorkspaceLayout, groupId: string, tabId: string): boolean {
  const index = displayMembership(layout)
  return (index.occurrences.get(tabId) ?? 0) > 1 && !(layout.activeGroupId === groupId && index.active.get(groupId) === tabId)
}

/** Immutable source indexes; no Session output or second placement owner. */
export function workbenchResourceTabs(tabs: Tabs): ReadonlyMap<string, Record<string, WorkbenchTab>> {
  let index = resources.get(tabs)
  if (!index) {
    const next = new Map<string, Record<string, WorkbenchTab>>()
    for (const tab of Object.values(tabs)) {
      if (!next.has(tab.workspaceId)) next.set(tab.workspaceId, {})
      next.get(tab.workspaceId)![tab.id] = tab
    }
    resources.set(tabs, index = next)
  }
  return index
}

/** Keep parked resources, while display chrome reads its actual retained memberships. */
export function workbenchDisplayTabs(tabs: Tabs, workspaceId: string, layout?: WorkspaceLayout): Record<string, WorkbenchTab> {
  const owned = workbenchResourceTabs(tabs).get(workspaceId) ?? {}
  if (!layout) return owned
  let byTabs = memberships.get(layout)
  if (!byTabs) memberships.set(layout, byTabs = new WeakMap())
  let byWorkspace = byTabs.get(tabs)
  if (!byWorkspace) {
    const members = Object.fromEntries(layout.groups.flatMap(group => group.tabOrder.flatMap(id => tabs[id] ? [[id, tabs[id]!]] : [])))
    byTabs.set(tabs, byWorkspace = new Map([[workspaceId, { ...owned, ...members }]]))
  } else if (!byWorkspace.has(workspaceId)) {
    const members = Object.fromEntries(layout.groups.flatMap(group => group.tabOrder.flatMap(id => tabs[id] ? [[id, tabs[id]!]] : [])))
    const next = new Map(byWorkspace); next.set(workspaceId, { ...owned, ...members }); byTabs.set(tabs, byWorkspace = next)
  }
  return byWorkspace.get(workspaceId)!
}

/** All ordinary occurrences; only a confirmed Browser can actually mirror its content. */
export function ordinaryWorkbenchViewTargets(layout: WorkspaceLayout | undefined, tabs: Tabs, displayWorkspaceId: string, prefix = 'workbench-tab-slot'): WorkbenchViewTargets {
  const targets: Record<string, WorkbenchViewTarget[]> = {}
  if (!layout) return targets
  const visibleGroups = displayMembership(layout).visible
  for (const group of layout.groups) if (visibleGroups.has(group.id)) for (const tabId of new Set(group.tabOrder)) {
    const tab = tabs[tabId], regionId = tab?.layout.activeRegionId
    if (!tab || !regionId || !tab.regions[regionId]) continue
    const reference = { displayWorkspaceId, groupId: group.id, tabId, regionId }
    const target: WorkbenchViewTarget = { hostId: workbenchProjectionSlotId(prefix, reference), active: true,
      visible: group.activeTabId === tabId, surface: 'space', reference }
    ;(targets[tabId] ??= []).push(target)
  }
  return targets
}
