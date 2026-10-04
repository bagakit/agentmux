import type { AgentMuxDesktopMainSurface, AgentMuxDesktopSelection, AgentMuxDesktopSpaceSelection,
  AgentMuxDesktopSurface, AgentMuxSpaceCatalog, AgentMuxSpaceSelector, AgentMuxSpatialIssue } from '@agentmux/core'
import type { WorkspaceLayout } from '@agentmux/layout'
import type { WorkbenchTab } from './workbench-tabs'
import { selectSpatialCatalog, spatialCatalog, type SpatialWorkbench } from './space-agent-control'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { scratchTopicsForWorkspace, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { projectWorkbenchProjection, type WorkbenchProjectionSelection } from './workbench-projection'
import { createWorkspaceLayout } from '@agentmux/layout'

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
/** An exact Region address is a view of the existing choice, never a second owner. */
export function mainRegionReference(choice: AgentMuxDesktopSpaceSelection | null): WorkbenchProjectionSelection | null {
  return choice?.groupId && choice.tabId && choice.regionId ? {
    displayWorkspaceId: choice.workspaceId, groupId: choice.groupId, tabId: choice.tabId, regionId: choice.regionId
  } : null
}
export class DesktopFocusFailure extends Error {
  constructor(readonly issue: AgentMuxSpatialIssue) { super(issue.message) }
}

export type NavigationState = SpatialWorkbench & DesktopSelectionState & {
  scratchTopicSnapshots: Readonly<Record<string, ScratchTopicsSnapshot>>
}
let cachedCatalog: { inputs: readonly unknown[]; value: AgentMuxSpaceCatalog } | null = null
/** Structural navigation facts do not subscribe to unrelated Runtime output or Session timelines. */
export function workbenchSelectionCatalog(state: NavigationState): AgentMuxSpaceCatalog {
  const scratch = state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scratch)
  const inputs = [state.config, state.tabs, state.layouts, state.spaceZoneBindings, topics, state.topicCategories]
  if (cachedCatalog && inputs.every((value, index) => value === cachedCatalog!.inputs[index])) return cachedCatalog.value
  const value = spatialCatalog({ ...state, sessions: [] }, topics ?? [])
  cachedCatalog = { inputs, value }
  return value
}

/** A local focus keeps its explicit parent; an explicit jump can resolve another object. */
export function resolveWorkbenchOccurrenceSelection(state: DesktopSelectionState, catalog: AgentMuxSpaceCatalog,
  reference: { workspaceId: string; groupId: string; tabId: string; regionId?: string }, intent: 'local' | 'navigation' = 'local'): AgentMuxDesktopSpaceSelection {
  const choice = state.workbenchSpaceSelection
  const tab = catalog.tabs.find(tab => tab.tabId === reference.tabId)
  const sameSpace = choice?.spaceId && catalog.bindings.some(binding => binding.spaceId === choice.spaceId && binding.zoneId === tab?.zoneId)
  const originalSpace = state.tabs[reference.tabId]?.space?.spaceId
  const sourceSpace = originalSpace && catalog.bindings.some(binding => binding.spaceId === originalSpace && binding.zoneId === tab?.zoneId) ? originalSpace : undefined
  const within = choice?.workspaceId === reference.workspaceId && choice.zoneId === tab?.zoneId &&
    (choice.spaceId === null || catalog.bindings.some(binding => binding.spaceId === choice.spaceId && binding.zoneId === choice.zoneId))
  if (choice && !within && intent === 'local') reject('SPACE_SCOPE_UNCONFIRMED',
    'This local position is not confirmed in the selected object. Its original workface and reference are kept.')
  const selected = resolveDesktopSpaceSelection(state, catalog, {
    ...(sameSpace ? { spaceId: choice.spaceId! } : sourceSpace ? { spaceId: sourceSpace } : {}),
    ...(within && choice?.zoneId ? { zoneId: choice.zoneId } : {}),
    tabId: reference.tabId, ...(reference.regionId ? { regionId: reference.regionId } : {}),
    displayWorkspaceId: reference.workspaceId, groupId: reference.groupId
  })
  const objectTopic = sameSpace && catalog.spaces.some(space => space.spaceId === choice?.spaceId && space.topicId === choice?.topicId)
  return (within || objectTopic) && choice ? { ...selected, topicId: choice.topicId } : {
    ...selected, topicId: selected.topicId ?? state.tabs[reference.tabId]?.topicId ?? null }
}

/** Cold/restored positions derive from their exact occurrence, never a global Topic list. */
export function workbenchObjectLayout(state: NavigationState, workspaceId: string, layout = state.layouts[workspaceId]) {
  const catalog = workbenchSelectionCatalog(state)
  let choice = state.workbenchSpaceSelection?.workspaceId === workspaceId ? state.workbenchSpaceSelection : null
  if (!choice && layout) {
    const group = layout.groups.find(group => group.id === layout.activeGroupId)
    if (group?.activeTabId) {
      try { choice = resolveWorkbenchOccurrenceSelection({ ...state, workbenchSpaceSelection: null }, catalog,
        { workspaceId, groupId: group.id, tabId: group.activeTabId }, 'navigation') }
      catch (error) { return { layout: null, choice: null, confirmed: false, issues: [(error as Error).message] } }
    }
  }
  return choice ? { ...projectWorkbenchSpaceSelection(layout, state.tabs, catalog, choice), choice }
    : { layout: layout ?? null, choice: null, confirmed: Boolean(layout), issues: [] }
}

/** Project original Zone membership, including legal foreign bindings, without changing entities. */
export function projectWorkbenchSpaceSelection(layout: WorkspaceLayout | undefined,
  tabs: Readonly<Record<string, WorkbenchTab>>, catalog: AgentMuxSpaceCatalog,
  choice: AgentMuxDesktopSpaceSelection): { layout: WorkspaceLayout | null; issues: string[]; confirmed: boolean } {
  if (choice.zoneId === null && choice.spaceId !== null && catalog.spaces.some(space => space.spaceId === choice.spaceId)) {
    return layout ? { layout: createWorkspaceLayout(layout.activeGroupId), issues: [], confirmed: true }
      : { layout: null, issues: ['The original Category workface is still restoring.'], confirmed: false }
  }
  if (choice.spaceId === null && choice.zoneId === null && choice.tabId) {
    const entity = catalog.tabs.find(tab => tab.tabId === choice.tabId)
    const matching = catalog.locations.filter(location => location.spaceId === null && location.zoneId === null &&
      location.displayWorkspaceId === choice.workspaceId && location.groupId === choice.groupId && location.tabId === choice.tabId && location.regionId === choice.regionId)
    if (entity?.zoneId === null && layout && matching.length === 1 && choice.groupId && choice.regionId) {
      const projected = projectWorkbenchProjection(layout, tabs, { entity: { kind: 'tab', tabId: choice.tabId },
        presentationId: 'space-workbench', displayWorkspaceId: choice.workspaceId, catalog, selectionMode: 'occurrence',
        selection: [{ displayWorkspaceId: choice.workspaceId, groupId: choice.groupId, tabId: choice.tabId, regionId: choice.regionId }], onSelect: () => {} })
      return { layout: projected.layout, issues: projected.issues, confirmed: projected.selection.length === 1 && projected.layout !== null }
    }
  }
  const zone = catalog.zones.find(zone => zone.zoneId === choice.zoneId)
  if (!zone || !layout || (choice.spaceId !== null && !catalog.bindings.some(binding =>
    binding.spaceId === choice.spaceId && binding.zoneId === choice.zoneId))) return { layout: null, confirmed: false,
      issues: ['The selected object or its original Zone position is not confirmed. Its workface and exact reference are kept.'] }
  const members = catalog.tabs.filter(tab => tab.zoneId === choice.zoneId)
  if (!members.length && choice.tabId === null) {
    if (zone.kind === 'unknown') return { layout: null, confirmed: false,
      issues: [zone.issue ?? 'The original Zone resource is still unconfirmed. Its reference is kept.'] }
    return { layout: createWorkspaceLayout(layout.activeGroupId), issues: [], confirmed: true }
  }
  const projected = projectWorkbenchProjection(layout, tabs, {
    entity: { kind: 'zone', zoneId: zone.zoneId }, presentationId: 'space-workbench', displayWorkspaceId: choice.workspaceId,
    catalog, selection: choice.tabId && choice.groupId && choice.regionId ? [{ displayWorkspaceId: choice.workspaceId,
      groupId: choice.groupId, tabId: choice.tabId, regionId: choice.regionId }] : [], onSelect: () => {}
  })
  const exact = !choice.tabId || catalog.locations.some(location => location.spaceId === choice.spaceId &&
    location.zoneId === choice.zoneId && location.displayWorkspaceId === choice.workspaceId && location.groupId === choice.groupId &&
    location.tabId === choice.tabId && location.regionId === choice.regionId)
  return { layout: projected.layout, issues: exact ? projected.issues : [...projected.issues,
    'The selected original occurrence is still restoring. Its exact reference is kept; choose its current position.'],
    confirmed: exact && projected.layout !== null }
}
function reject(code: string, message: string, candidates?: AgentMuxSpaceSelector[]): never {
  throw new DesktopFocusFailure({ step: 'target', code, message,
    recovery: 'Inspect the client or list this Space/Zone, then choose an exact existing target.',
    ...(candidates ? { candidates } : {}) })
}

/** Resolve the durable placement, never execution cwd or the first unrelated Tab/Agent. */
export function resolveDesktopSpaceSelection(state: DesktopSelectionState & Partial<Pick<SpatialWorkbench, 'spaceZoneBindings' | 'config' | 'topicCategories'>>, catalog: AgentMuxSpaceCatalog,
  target: AgentMuxSpaceSelector): AgentMuxDesktopSpaceSelection {
  const category = target.spaceId && !target.zoneId && !target.tabId && !target.regionId && !target.groupId
    ? state.topicCategories?.find(category => category.spaceId === target.spaceId) : undefined
  if (category) {
    const original = catalog.spaces.find(space => space.spaceId === category.spaceId)
    const workspace = state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID && workspace.hostId === category.hostId)
    if (!original || original.kind !== 'container' || original.hostId !== category.hostId || original.directoryPath !== category.directoryPath || !workspace) {
      reject('SPACE_RESOURCE_UNKNOWN', 'The original Category resource is not currently confirmed.')
    }
    if (target.displayWorkspaceId && target.displayWorkspaceId !== workspace.id) {
      reject('SPACE_LOCATION_REQUIRED', 'The requested display Workspace is not the original Category context.', [{ spaceId: category.spaceId, displayWorkspaceId: workspace.id }])
    }
    return { spaceId: category.spaceId, zoneId: null, workspaceId: workspace.id, topicId: null, tabId: null, groupId: null, regionId: null }
  }
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
  const origin = zoneId ? state.spaceZoneBindings?.[zoneId] : undefined
  const base = { spaceId, zoneId, workspaceId, topicId: selected.spaces.find(space => space.spaceId === spaceId)?.topicId
    ?? (origin?.workspaceId === zone?.workspaceId ? origin?.topicId : undefined) ?? null }
  let selectedTab = tab
  if (!selectedTab) {
    const group = layout?.groups.find(group => group.id === (target.groupId ?? layout.activeGroupId))
    selectedTab = selected.tabs.find(tab => tab.tabId === group?.activeTabId)
    if (!selectedTab && selected.tabs.length === 1) selectedTab = selected.tabs[0]
    // An explicit Zone can be opened without choosing one of its child Tabs.
    if (!selectedTab && target.zoneId && !target.tabId && !target.regionId && !target.groupId) return { ...base, tabId: null, groupId: null, regionId: null }
    if (!selectedTab && selected.tabs.length > 1) reject('SPACE_TAB_REQUIRED', 'Choose one exact Tab.', selected.tabs.map(tab => ({ tabId: tab.tabId })))
  }
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
  if (!activeGroup || !activeTab || !choice.zoneId || activeTab.space?.zoneId !== choice.zoneId) return parent
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
