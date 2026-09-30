import type { AgentMuxDesktopMainSurface, AgentMuxDesktopSelection, AgentMuxDesktopSpaceSelection,
  AgentMuxDesktopSurface, AgentMuxSpaceCatalog, AgentMuxSpaceSelector, AgentMuxSpatialIssue } from '@agentmux/core'
import type { WorkspaceLayout } from '@agentmux/layout'
import type { WorkbenchTab } from './workbench-tabs'
import { selectSpatialCatalog } from './space-agent-control'
import { isScratchWorkspaceId } from '../../../shared/contracts'

export const desktopMainSurface = { space: 'workbench', focus: 'agents', goals: 'board', survey: 'survey' } as const
export const desktopSurface: Record<AgentMuxDesktopMainSurface, AgentMuxDesktopSurface> = {
  workbench: 'space', agents: 'focus', board: 'goals', survey: 'survey'
}
export type DesktopSelectionState = {
  activeWorkspaceId: string | null
  mainSurface: AgentMuxDesktopMainSurface
  selectedDemandId: string | null
  workbenchSpaceSelection: AgentMuxDesktopSpaceSelection | null
  tabs: Readonly<Record<string, WorkbenchTab>>
  layouts: Readonly<Record<string, WorkspaceLayout>>
}
export class DesktopFocusFailure extends Error {
  constructor(readonly issue: AgentMuxSpatialIssue) { super(issue.message) }
}
function reject(code: string, message: string, candidates?: AgentMuxSpaceSelector[]): never {
  throw new DesktopFocusFailure({ step: 'target', code, message,
    recovery: 'Inspect the client or list this Space/Zone, then choose an exact existing target.',
    ...(candidates ? { candidates } : {}) })
}

/** Resolve the durable placement, never execution cwd or the first unrelated Tab/Agent. */
export function resolveDesktopSpaceSelection(state: DesktopSelectionState, catalog: AgentMuxSpaceCatalog,
  target: AgentMuxSpaceSelector): AgentMuxDesktopSpaceSelection {
  const selected = selectSpatialCatalog(catalog, {
    ...(target.spaceId ? { spaceId: target.spaceId } : {}), ...(target.zoneId ? { zoneId: target.zoneId } : {}),
    ...(target.tabId ? { tabId: target.tabId } : {}), ...(target.regionId ? { regionId: target.regionId } : {}),
    ...(target.displayWorkspaceId ? { displayWorkspaceId: target.displayWorkspaceId } : {}), ...(target.groupId ? { groupId: target.groupId } : {})
  })
  const tab = target.regionId ? selected.tabs.find(tab => tab.tabId === selected.regions.find(region => region.regionId === target.regionId)?.tabId)
    : target.tabId ? selected.tabs.find(tab => tab.tabId === target.tabId) : undefined
  if (!tab && selected.zones.length !== 1) reject('SPACE_ZONE_REQUIRED', 'Choose one exact Zone.', selected.zones.map(zone => ({ zoneId: zone.zoneId })))
  const zoneId = tab?.zoneId ?? selected.zones[0]?.zoneId ?? null
  const zone = selected.zones.find(zone => zone.zoneId === zoneId)
  const members = selected.bindings.filter(binding => binding.zoneId === zoneId)
  if (!target.spaceId && members.length > 1) reject('SPACE_LOCATION_REQUIRED', 'Choose the exact Space reference.', members)
  const spaceId = target.spaceId ?? members[0]?.spaceId ?? null
  const workspaceId = target.displayWorkspaceId ?? zone?.workspaceId ?? tab?.workspaceId
  if (!workspaceId) reject('SPACE_RESOURCE_UNKNOWN', 'The original entity context is not currently confirmed.')
  const layout = state.layouts[workspaceId]
  let selectedTab = tab
  if (!selectedTab) {
    const group = layout?.groups.find(group => group.id === (target.groupId ?? layout.activeGroupId))
    selectedTab = selected.tabs.find(tab => tab.tabId === group?.activeTabId)
    if (!selectedTab && selected.tabs.length === 1) selectedTab = selected.tabs[0]
    if (!selectedTab && selected.tabs.length > 1) reject('SPACE_TAB_REQUIRED', 'Choose one exact Tab.', selected.tabs.map(tab => ({ tabId: tab.tabId })))
  }
  const base = { spaceId, zoneId, workspaceId, topicId: selected.spaces.find(space => space.spaceId === spaceId)?.topicId ?? null }
  if (!selectedTab) return { ...base, tabId: null, groupId: null, regionId: null }
  const regionId = target.regionId ?? state.tabs[selectedTab.tabId]?.layout.activeRegionId
  const candidates = selected.locations.filter(location => location.tabId === selectedTab!.tabId && location.regionId === regionId &&
    location.spaceId === spaceId && (!target.groupId || location.groupId === target.groupId) &&
    (!target.displayWorkspaceId || location.displayWorkspaceId === target.displayWorkspaceId))
  if (candidates.length !== 1) reject('SPACE_LOCATION_REQUIRED', 'Choose the exact display Workspace and Group.', candidates.map(location => ({
    ...(location.spaceId ? { spaceId: location.spaceId } : {}), ...(location.zoneId ? { zoneId: location.zoneId } : {}),
    tabId: location.tabId, regionId: location.regionId, displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId })))
  const location = candidates[0]!
  return { ...base, workspaceId: location.displayWorkspaceId, tabId: location.tabId, groupId: location.groupId, regionId: location.regionId }
}

export function desktopSelection(state: DesktopSelectionState, catalog: AgentMuxSpaceCatalog): AgentMuxDesktopSelection {
  let space = state.workbenchSpaceSelection?.workspaceId === state.activeWorkspaceId ? state.workbenchSpaceSelection : null
  if (!space && state.activeWorkspaceId) {
    const layout = state.layouts[state.activeWorkspaceId]
    const group = layout?.groups.find(group => group.id === layout.activeGroupId)
    const tab = group?.activeTabId ? catalog.tabs.find(tab => tab.tabId === group.activeTabId) : undefined
    if (tab && group) {
      const members = catalog.bindings.filter(binding => binding.zoneId === tab.zoneId)
      const original = state.tabs[tab.tabId]?.space?.spaceId
      const spaceId = members.some(binding => binding.spaceId === original) ? original! : members.length === 1 ? members[0]!.spaceId : null
      space = { spaceId, zoneId: tab.zoneId, workspaceId: state.activeWorkspaceId, tabId: tab.tabId, groupId: group.id,
        regionId: state.tabs[tab.tabId]?.layout.activeRegionId ?? null, topicId: catalog.spaces.find(space => space.spaceId === spaceId)?.topicId ?? null }
    }
  }
  return { surface: desktopSurface[state.mainSurface], mainSurface: state.mainSurface, space, goalId: state.selectedDemandId }
}

/** A confirmed user close follows only a confirmed member of this exact Zone.
 * Missing Runtime/discovery snapshots never invoke this topology owner. */
export function desktopSpaceSelectionAfterClose(choice: AgentMuxDesktopSpaceSelection | null,
  topology: Pick<DesktopSelectionState, 'tabs' | 'layouts'>,
  closed: { workspaceId: string; tabId: string; groupId?: string; regionId?: string }): AgentMuxDesktopSpaceSelection | null {
  if (!choice || choice.workspaceId !== closed.workspaceId || choice.tabId !== closed.tabId ||
    (closed.groupId && choice.groupId !== closed.groupId) || (closed.regionId && choice.regionId !== closed.regionId)) return choice
  const layout = topology.layouts[choice.workspaceId]
  const previousGroup = layout?.groups.find(group => group.id === choice.groupId)
  const previousTab = choice.tabId ? topology.tabs[choice.tabId] : undefined
  if (previousGroup?.tabOrder.includes(choice.tabId!) && previousTab &&
    (!choice.regionId || previousTab.regions[choice.regionId])) return choice
  const parent = { ...choice, tabId: null, groupId: null, regionId: null }
  const activeGroup = layout?.groups.find(group => group.id === layout.activeGroupId)
  const activeTab = activeGroup?.activeTabId ? topology.tabs[activeGroup.activeTabId] : undefined
  if (!activeGroup || !activeTab || !choice.zoneId || activeTab.space?.zoneId !== choice.zoneId ||
    (isScratchWorkspaceId(activeTab.workspaceId) && (activeTab.topicId ?? null) !== choice.topicId)) return parent
  return { ...choice, tabId: activeTab.id, groupId: activeGroup.id,
    regionId: activeTab.regions[activeTab.layout.activeRegionId] ? activeTab.layout.activeRegionId : null }
}

/** Missing discovery/Runtime snapshots retain this exact durable choice; they never select a peer. */
export function restoreWorkbenchSpaceSelection(value: unknown): AgentMuxDesktopSpaceSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (Object.keys(source).some(key => !['spaceId', 'zoneId', 'workspaceId', 'tabId', 'groupId', 'regionId', 'topicId'].includes(key))) return null
  if (typeof source.workspaceId !== 'string' || !source.workspaceId) return null
  for (const key of ['spaceId', 'zoneId']) if (source[key] !== null && (typeof source[key] !== 'string' || !source[key])) return null
  for (const key of ['tabId', 'groupId', 'regionId', 'topicId']) if (source[key] !== null && (typeof source[key] !== 'string' || !source[key])) return null
  if ((source.tabId === null) !== (source.groupId === null) || (source.regionId !== null && source.tabId === null)) return null
  return source as AgentMuxDesktopSpaceSelection
}
