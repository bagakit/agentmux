import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { WorkspaceLayout } from '@agentmux/layout'
import { workbenchDisplayReferenceMatches } from './workbench-resource-display'
import { PMO_FLOATING_TAB_SLOT_PREFIX, type PmoTeamsTopicFloatingState } from './pmo-teams-topic-floating'
import { sameWorkbenchProjectionSelection, type WorkbenchProjection, type WorkbenchProjectionSelection } from './workbench-projection'
import type { WorkbenchTab } from './workbench-tabs'

export type MoteWorkbenchProjectionResult = {
  catalog: AgentMuxSpaceCatalog | null
  projection: WorkbenchProjection | null
  choices: readonly WorkbenchProjectionSelection[]
  retainedTabId: string | undefined
  issue: string | null
}

/** Address resolution only. The shared projector still owns composition, visibility and content. */
export function moteWorkbenchProjection(catalog: AgentMuxSpaceCatalog | null, tab: WorkbenchTab | undefined,
  floating: PmoTeamsTopicFloatingState, onSelect: WorkbenchProjection['onSelect'], layouts: Readonly<Record<string, WorkspaceLayout>>): MoteWorkbenchProjectionResult {
  const retained = { catalog, projection: null, choices: [], retainedTabId: floating.targetTabId ?? tab?.id, issue: null }
  if (!tab || !catalog || floating.targetTopicId && tab.topicId !== floating.targetTopicId) return retained
  const entity = catalog.tabs.find(item => item.tabId === tab.id)
  const zone = entity?.zoneId ? catalog.zones.find(item => item.zoneId === entity.zoneId) : undefined
  const choices = [...new Map(catalog.locations.filter(location => location.tabId === tab.id &&
    location.regionId === tab.layout.activeRegionId).map(({ displayWorkspaceId, groupId, tabId, regionId }) => {
      const reference = { displayWorkspaceId, groupId, tabId, regionId }
      return [JSON.stringify(reference), reference] as const
    })).values()]
  const held = floating.reference
  const reference = held ? catalog.locations.find(location => sameWorkbenchProjectionSelection(held, location) && location.tabId === tab.id)
    : held === undefined && choices.length === 1 ? choices[0] : undefined
  if (!zone || !reference || !tab.regions[reference.regionId] || !workbenchDisplayReferenceMatches(layouts[reference.displayWorkspaceId], reference)) return { ...retained, choices,
    issue: choices.length > 1 && held === undefined ? 'Choose where to continue this discussion. Every original location is kept.'
      : 'The exact discussion location is not confirmed. Its original content and reference are kept.' }
  return { catalog, retainedTabId: tab.id, choices, issue: null, projection: {
    entity: { kind: 'zone', zoneId: zone.zoneId },
    presentationId: PMO_FLOATING_TAB_SLOT_PREFIX.replace(/-slot$/, ''),
    displayWorkspaceId: reference.displayWorkspaceId, catalog,
    selectionMode: 'occurrence',
    selection: [{ displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId }], onSelect
  } }
}
