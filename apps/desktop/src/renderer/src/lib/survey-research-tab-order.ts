import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { findGroup, groupIds } from '@agentmux/layout'
import type { AppState } from '../store'

export type SurveyResearchTabOrder = {
  zoneId: string
  workspaceId: string
  groupId: string
  tabId: string
  order: readonly string[]
  members: readonly string[]
}

/** The sidebar is a projection. Only an unambiguous original Group is sortable. */
export function surveyResearchTabOrder(state: Pick<AppState, 'layouts' | 'tabs'>, catalog: AgentMuxSpaceCatalog, zoneId: string, tabId: string): SurveyResearchTabOrder | null {
  const zone = catalog.zones.find(zone => zone.zoneId === zoneId)
  const layout = zone && state.layouts[zone.workspaceId]
  if (!zone || !layout) return null
  const visible = new Set(groupIds(layout.root))
  const groups = layout.groups.filter(group => visible.has(group.id))
  const placements = groups.filter(group => group.tabOrder.includes(tabId))
  if (placements.length !== 1) return null
  const group = placements[0]!, zoneMembers = new Set(catalog.tabs.filter(tab => tab.zoneId === zoneId).map(tab => tab.tabId))
  const otherPlacements = new Set(groups.flatMap(item => item === group ? [] : item.tabOrder))
  const members = group.tabOrder.filter(id => zoneMembers.has(id) && Object.hasOwn(state.tabs, id) && !otherPlacements.has(id))
  return members.length > 1 && members.includes(tabId)
    ? { zoneId, workspaceId: zone.workspaceId, groupId: group.id, tabId, order: group.tabOrder, members }
    : null
}

export function reorderSurveyResearchTabs(state: Pick<AppState, 'layouts' | 'tabs'>, catalog: AgentMuxSpaceCatalog, before: SurveyResearchTabOrder, target: string) {
  const current = surveyResearchTabOrder(state, catalog, before.zoneId, before.tabId)
  const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index])
  if (!current || current.workspaceId !== before.workspaceId || current.groupId !== before.groupId ||
    !sameOrder(current.order, before.order) || !sameOrder(current.members, before.members) ||
    target === before.tabId || !current.members.includes(target)) return null
  const layout = state.layouts[current.workspaceId]!
  const group = findGroup(layout, current.groupId)!
  const members = [...current.members]
  members.splice(members.indexOf(current.tabId), 1)
  members.splice(current.members.indexOf(target), 0, current.tabId)
  const memberIds = new Set(current.members)
  let index = 0
  const tabOrder = group.tabOrder.map(id => memberIds.has(id) ? members[index++]! : id)
  return { ...layout, groups: layout.groups.map(item => item === group ? { ...group, tabOrder } : item) }
}
