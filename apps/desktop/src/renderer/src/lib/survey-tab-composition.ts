import { AgentMuxError } from '@agentmux/core/control'
import { composeSpatialTabs, type AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { addTabOccurrence, groupIds, regionIds, type WorkspaceLayout } from '@agentmux/layout'
import { mintObjectId } from '@agentmux/core/object-id'
import type { AppState } from '../store'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import { spatialCatalog, zoneContext, planSpatialZone } from './space-agent-control'
import { desktopSpatialGraph } from './desktop-spatial-state'
import { sameSpatialValue } from './spatial-merge'
import { findWorkbenchRegion, type WorkbenchTab } from './workbench-tabs'
import { promoteRegionToTab } from './promote-region-to-tab'
import { sameWorkbenchSurfaceOwner, workbenchViewCloseAllowsView } from './workbench-view-close'
import { scratchTopicsForWorkspace, scratchTopicKind } from './scratch-topic-snapshots'
import { moteDefaultConversation } from './mote-quick-preferences'
import type { SurveyZoneSelection } from './survey-workface'

export type SurveyCompositionSource = {
  tab: WorkbenchTab
  zoneId: string | null
} & ({ kind: 'tab' } | { kind: 'page'; regionId: string; browserId: string; promotedTabId: string })
export type SurveyCompositionTarget = { kind: 'existing' | 'new-research'; zoneId: string; workspaceId: string; displayWorkspaceId: string; groupId: string }
export type SurveyCompositionRequest = {
  requestId: string
  sources: readonly SurveyCompositionSource[]
  target: SurveyCompositionTarget
  /** User list placement, distinct from the target's physical display Group. */
  surveyGroupId?: string | null
}
export type SurveyCompositionPlan = {
  graph: AgentMuxSpatialGraph
  tabIds: string[]
  sourceZoneIds: string[]
  promoted: { tabId: string; previousTabId: string; regionId: string }[]
}
export type SurveyCompositionReport = {
  requestId: string
  outcome: 'moved' | 'partial' | 'refused' | 'unknown'
  targetZoneId: string
  tabIds: readonly string[]
  issue?: string
  save?: import('@agentmux/core/control').AgentMuxSpatialSave
}

/** Follow the same selected original Region, without changing an unrelated research or global input focus. */
export function reconcileResearchCompositionSelection(selected: SurveyZoneSelection | null, graph: AgentMuxSpatialGraph): SurveyZoneSelection | null {
  if (!selected) return selected
  const owner = (regionId: string) => {
    const region = graph.regions.find(region => region.regionId === regionId)
    return region && graph.tabs.find(tab => tab.tabId === region.tabId)
  }
  const active = selected.active && owner(selected.active.regionId)
  const zoneId = active?.zoneId ?? selected.zoneId
  const references = selected.selection.flatMap(reference => {
    const tab = owner(reference.regionId)
    return !tab ? [reference] : tab.zoneId === zoneId ? [{ ...reference, tabId: tab.tabId }] : []
  })
  if (zoneId === selected.zoneId && references.length === selected.selection.length && references.every((reference, index) =>
    reference.tabId === selected.selection[index]!.tabId && reference.regionId === selected.selection[index]!.regionId)) return selected
  return { zoneId, selection: references, active: selected.active && active ? { ...selected.active, tabId: active.tabId } : selected.active }
}
function changed(message: string): never { throw new AgentMuxError(message + ' No content was moved; review these original sources and target before another request.', 'SPACE_COMPOSITION_CHANGED') }

/** Capture original immutable surfaces; later metadata updates do not become identity checks. */
export function captureSurveyCompositionSource(state: Pick<AppState, 'tabs'>, catalog: AgentMuxSpaceCatalog,
  input: { kind: 'tab'; tabId: string } | { kind: 'page'; regionId: string; browserId: string }): SurveyCompositionSource | null {
  const owner = input.kind === 'page' ? findWorkbenchRegion(state.tabs, input.regionId) : undefined
  const tab = input.kind === 'tab' ? state.tabs[input.tabId] : owner?.tab
  const fact = tab && catalog.tabs.find(fact => fact.tabId === tab.id)
  if (!tab || !fact) return null
  if (input.kind === 'tab') return { kind: 'tab', tab, zoneId: fact.zoneId }
  return owner?.surface.kind === 'browser' && owner.surface.browserId === input.browserId
    ? { kind: 'page', tab, zoneId: fact.zoneId, regionId: input.regionId, browserId: input.browserId, promotedTabId: mintObjectId() } : null
}

function keepDisplaySelection(before: WorkspaceLayout | undefined, after: WorkspaceLayout): WorkspaceLayout {
  if (!before) return after
  return { ...after, activeGroupId: before.activeGroupId, groups: after.groups.map(group => {
    const previous = before.groups.find(item => item.id === group.id)
    return previous?.activeTabId && group.tabOrder.includes(previous.activeTabId)
      ? { ...group, activeTabId: previous.activeTabId, recentTabIds: previous.recentTabIds } : group
  }) }
}

/** Pure whole-request preparation. Promotion has no side effect until one original Core CAS accepts the complete graph. */
export function planSurveyTabComposition(state: AppState, topics: readonly ScratchTopicSnapshot[], base: AgentMuxSpatialGraph,
  request: SurveyCompositionRequest): SurveyCompositionPlan {
  if (request.surveyGroupId !== undefined && request.surveyGroupId !== null && !state.surveyOrganization.groups.some(group => group.groupId === request.surveyGroupId))
    changed('The selected Survey list group no longer exists.')
  // A full-graph CAS must start from the same authoritative revision the client has actually consumed.
  if (!sameSpatialValue(desktopSpatialGraph(state, topics, base), base)) changed('The displayed workface has not consumed the original Core graph.')
  let planningState = state
  if (request.target.kind === 'new-research') {
    const creation = planSpatialZone({ ...state, originalSpatialGraph: base }, topics,
      { zoneId: request.target.zoneId, workspaceId: request.target.workspaceId, spaceIds: [] })
    planningState = { ...state, spaceZoneBindings: creation.spaceZoneBindings }
  }
  const catalog = spatialCatalog(planningState, topics), target = catalog.zones.find(zone => zone.zoneId === request.target.zoneId)
  const destination = state.layouts[request.target.displayWorkspaceId]
  if (!target || target.workspaceId !== request.target.workspaceId || !destination || !groupIds(destination.root).includes(request.target.groupId) ||
    !destination.groups.some(group => group.id === request.target.groupId)) changed('The exact destination Zone or display Group changed.')
  const context = zoneContext(planningState, topics, target)
  const targetTopicId = catalog.spaces.find(space => space.spaceId === context)?.topicId
  const held = new Set<string>(), wholeTabs = new Set(request.sources.filter(source => source.kind === 'tab').map(source => source.tab.id))
  if (!request.sources.length) changed('No original content was selected.')
  for (const source of request.sources) {
    const current = state.tabs[source.tab.id], fact = catalog.tabs.find(tab => tab.tabId === source.tab.id)
    if (!current || fact?.zoneId !== source.zoneId || !workbenchViewCloseAllowsView(state.closingWorkbenchViews, current.id)) changed('An original source changed or is currently closing.')
    const members = source.kind === 'tab' ? regionIds(source.tab.layout.root) : [source.regionId]
    if (source.kind === 'tab' && (members.length !== regionIds(current.layout.root).length || !members.every(id => current.regions[id]))) changed('The original Tab gained or lost content.')
    if (source.kind === 'page' && wholeTabs.has(source.tab.id)) changed('A page and its entire Tab overlap in the selected scope.')
    for (const id of members) {
      if (held.has(id) || !sameWorkbenchSurfaceOwner(current.regions[id], source.tab.regions[id]!)) changed('An original content binding changed or was selected twice.')
      held.add(id)
    }
    if (source.kind === 'page') {
      const page = current.regions[source.regionId]
      if (page?.kind !== 'browser' || page.browserId !== source.browserId) changed('The original page was replaced.')
    }
  }
  let tabs = { ...state.tabs }, layouts = { ...state.layouts }
  const tabIds: string[] = [], promoted: SurveyCompositionPlan['promoted'] = []
  for (const source of request.sources) {
    if (source.kind === 'tab' || regionIds(tabs[source.tab.id]!.layout.root).length === 1) { tabIds.push(source.tab.id); continue }
    if (tabs[source.promotedTabId]) changed('The reserved promoted Tab identity is already held.')
    const result = promoteRegionToTab({ tabs, layouts, workspaceId: source.tab.workspaceId, tabId: source.tab.id,
      regionId: source.regionId, mint: { tabId: source.promotedTabId }, destination: request.target })
    if (result.kind !== 'promoted') changed('The exact page could not be separated from its original siblings.')
    tabs = result.tabs; layouts = result.layouts; tabIds.push(result.target.tabId)
    promoted.push({ tabId: result.target.tabId, previousTabId: source.tab.id, regionId: source.regionId })
    // Each old presentation continues to expose that same original Region through the promoted Tab.
    for (const [displayId, original] of Object.entries(state.layouts)) for (const group of original.groups) {
      if (!groupIds(original.root).includes(group.id) || !group.tabOrder.includes(source.tab.id)) continue
      const next = addTabOccurrence(layouts[displayId]!, group.id, result.target.tabId)
      if (!next) changed('An original display binding changed.')
      layouts[displayId] = keepDisplaySelection(original, next)
    }
  }
  const prepared = desktopSpatialGraph({ ...planningState, tabs, layouts }, topics, base)
  const composed = composeSpatialTabs(prepared, { target: request.target, tabs: tabIds.map(tabId => {
    const tab = prepared.tabs.find(tab => tab.tabId === tabId)!
    return { tabId, zoneId: tab.zoneId, regionIds: tab.regionIds }
  }) })
  for (const tabId of tabIds) {
    const { space: _space, topicId: _topic, topicPreparation: _preparation, ...original } = tabs[tabId]!
    const fact = composed.tabs.find(tab => tab.tabId === tabId)!
    tabs[tabId] = { ...original, workspaceId: fact.workspaceId, space: { spaceId: context, zoneId: fact.zoneId! },
      ...(targetTopicId ? { topicId: targetTopicId } : {}) }
    const next = addTabOccurrence(layouts[request.target.displayWorkspaceId]!, request.target.groupId, tabId)
    if (!next) changed('The destination display changed.')
    layouts[request.target.displayWorkspaceId] = next
  }
  for (const [displayId, layout] of Object.entries(layouts)) layouts[displayId] = keepDisplaySelection(state.layouts[displayId], layout)
  const nextState = { ...planningState, tabs, layouts }
  for (const owner of state.config?.workspaces ?? []) {
    const owned = scratchTopicsForWorkspace(state.scratchTopicSnapshots, owner) ?? []
    for (const topic of owned) {
      const pin = topic.quickMode?.status === 'saved' ? topic.quickMode.defaults.conversation : undefined
      if (!pin || !request.sources.some(source => source.kind === 'tab' && source.tab.id === pin.tabId) || scratchTopicKind(topic.id, owned) !== 'mote') continue
      const before = moteDefaultConversation(state, topic, owner.id)
      if (before.conversation && !moteDefaultConversation(nextState, topic, owner.id).conversation) changed(
        'This move would remove the original fixed Mote conversation. Unset that conversation in its Profile → Quick mode first.')
    }
  }
  return { graph: desktopSpatialGraph(nextState, topics, composed), tabIds,
    sourceZoneIds: [...new Set(request.sources.flatMap(source => source.zoneId ? [source.zoneId] : []))], promoted }
}
