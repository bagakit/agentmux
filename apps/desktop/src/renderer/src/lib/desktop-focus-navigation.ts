import type { AgentMuxDesktopMainSurface, AgentMuxDesktopSelection, AgentMuxDesktopSpaceSelection,
  AgentMuxDesktopSurface, AgentMuxSpaceCatalog, AgentMuxSpaceSelector, AgentMuxSpatialIssue } from '@agentmux/core'
import type { WorkspaceLayout } from '@agentmux/layout'
import type { WorkbenchTab } from './workbench-tabs'
import { selectSpatialCatalog } from './space-agent-control'
import { isScratchWorkspaceId } from '../../../shared/contracts'

export const desktopMainSurface = { space: 'workbench', focus: 'agents', goals: 'board', search: 'search' } as const
export const desktopSurface: Record<AgentMuxDesktopMainSurface, AgentMuxDesktopSurface> = {
  workbench: 'space', agents: 'focus', board: 'goals', search: 'search'
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
  // The public focus discriminator is not an address field. Project only selectors into
  // the existing catalog's exact parent check, which rejects every foreign field.
  const selected = selectSpatialCatalog(catalog, {
    ...(target.spaceId ? { spaceId: target.spaceId } : {}), ...(target.zoneId ? { zoneId: target.zoneId } : {}),
    ...(target.tabId ? { tabId: target.tabId } : {}), ...(target.regionId ? { regionId: target.regionId } : {})
  })
  if (selected.zones.length !== 1) reject('SPACE_ZONE_REQUIRED', 'Choose the exact Zone of this Space.',
    selected.zones.map(zone => ({ spaceId: zone.spaceId, zoneId: zone.zoneId })))
  const zone = selected.zones[0]!
  const space = selected.spaces.find(space => space.spaceId === zone.spaceId)
  let tab = target.regionId
    ? selected.tabs.find(tab => tab.tabId === selected.regions.find(region => region.regionId === target.regionId)?.tabId)
    : target.tabId ? selected.tabs.find(tab => tab.tabId === target.tabId) : undefined
  if (!tab && (target.tabId || target.regionId)) reject('SPACE_TARGET_UNKNOWN', 'The exact Tab/Region is not currently open.')
  if (!tab) {
    const layout = state.layouts[zone.workspaceId]
    const activeId = layout?.groups.find(group => group.id === layout.activeGroupId)?.activeTabId
    tab = selected.tabs.find(tab => tab.tabId === activeId)
    if (!tab && selected.tabs.length === 1) tab = selected.tabs[0]
    if (!tab && selected.tabs.length > 1) reject('SPACE_TAB_REQUIRED', 'This Zone has no unique durable active Tab; choose an exact Tab.',
      selected.tabs.map(tab => ({ spaceId: tab.spaceId, zoneId: tab.zoneId, tabId: tab.tabId })))
  }
  const base = { spaceId: zone.spaceId, zoneId: zone.zoneId, workspaceId: zone.workspaceId, topicId: space?.topicId ?? null }
  if (!tab) return { ...base, tabId: null, groupId: null, regionId: null }
  const regionId = target.regionId ?? state.tabs[tab.tabId]?.layout.activeRegionId
  if (!regionId || !selected.regions.some(region => region.tabId === tab!.tabId && region.regionId === regionId)) {
    reject('SPACE_REGION_UNKNOWN', 'The saved active Region cannot currently be confirmed; choose an exact Region.',
      selected.regions.filter(region => region.tabId === tab!.tabId).map(region => ({ spaceId: region.spaceId, zoneId: region.zoneId, tabId: region.tabId, regionId: region.regionId })))
  }
  return { ...base, tabId: tab.tabId, groupId: tab.groupId, regionId }
}

export function desktopSelection(state: DesktopSelectionState, catalog: AgentMuxSpaceCatalog): AgentMuxDesktopSelection {
  let space = state.workbenchSpaceSelection?.workspaceId === state.activeWorkspaceId ? state.workbenchSpaceSelection : null
  if (!space && state.activeWorkspaceId) {
    const layout = state.layouts[state.activeWorkspaceId]
    const group = layout?.groups.find(group => group.id === layout.activeGroupId)
    const tab = group?.activeTabId ? catalog.tabs.find(tab => tab.tabId === group.activeTabId) : undefined
    if (tab) space = { spaceId: tab.spaceId, zoneId: tab.zoneId, workspaceId: tab.workspaceId, tabId: tab.tabId,
      groupId: tab.groupId, regionId: state.tabs[tab.tabId]?.layout.activeRegionId ?? null,
      topicId: catalog.spaces.find(space => space.spaceId === tab.spaceId)?.topicId ?? null }
  }
  return { surface: desktopSurface[state.mainSurface], mainSurface: state.mainSurface, space, goalId: state.selectedDemandId }
}

/** A confirmed user close follows the original layout within the same durable parent.
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
  if (!activeGroup || !activeTab || activeTab.workspaceId !== choice.workspaceId ||
    (isScratchWorkspaceId(choice.workspaceId) && (activeTab.topicId ?? null) !== choice.topicId)) return parent
  return { ...choice, tabId: activeTab.id, groupId: activeGroup.id,
    regionId: activeTab.regions[activeTab.layout.activeRegionId] ? activeTab.layout.activeRegionId : null }
}

/** Missing discovery/Runtime snapshots retain this exact durable choice; they never select a peer. */
export function restoreWorkbenchSpaceSelection(value: unknown): AgentMuxDesktopSpaceSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (Object.keys(source).some(key => !['spaceId', 'zoneId', 'workspaceId', 'tabId', 'groupId', 'regionId', 'topicId'].includes(key))) return null
  for (const key of ['spaceId', 'zoneId', 'workspaceId']) if (typeof source[key] !== 'string' || !source[key]) return null
  for (const key of ['tabId', 'groupId', 'regionId', 'topicId']) if (source[key] !== null && (typeof source[key] !== 'string' || !source[key])) return null
  if ((source.tabId === null) !== (source.groupId === null) || (source.regionId !== null && source.tabId === null)) return null
  return source as AgentMuxDesktopSpaceSelection
}
