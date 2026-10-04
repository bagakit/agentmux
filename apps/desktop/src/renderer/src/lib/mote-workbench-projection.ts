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
  const exact = held ? catalog.locations.find(location => sameWorkbenchProjectionSelection(held, location) && location.tabId === tab.id)
    : held === undefined && choices.length === 1 ? choices[0] : undefined
  const parentLocations = !exact && held?.tabId === tab.id && !Object.hasOwn(tab.regions, held.regionId) &&
    workbenchDisplayReferenceMatches(layouts[held.displayWorkspaceId], held)
    ? catalog.locations.filter(location => location.displayWorkspaceId === held.displayWorkspaceId && location.groupId === held.groupId &&
      location.tabId === held.tabId && tab.regions[location.regionId]) : []
  const parentConfirmed = parentLocations.length > 0 && new Set(parentLocations.map(location => location.regionId)).size === parentLocations.length
  const reference = exact ?? (parentConfirmed ? held : undefined)
  const unbound = entity?.zoneId === null && (!tab.space) && reference && (parentConfirmed
    ? parentLocations.every(location => location.zoneId === null && location.spaceId === null)
    : catalog.locations.filter(location => sameWorkbenchProjectionSelection(reference!, location) && location.zoneId === null && location.spaceId === null).length === 1)
  if ((!zone && !unbound) || !reference || !parentConfirmed && !tab.regions[reference.regionId] || !workbenchDisplayReferenceMatches(layouts[reference.displayWorkspaceId], reference)) return { ...retained, choices,
    issue: choices.length > 1 && held === undefined ? 'Choose where to continue this discussion. Every original location is kept.'
      : 'The exact discussion location is not confirmed. Its original content and reference are kept.' }
  return { catalog, retainedTabId: tab.id, choices,
    issue: parentConfirmed ? 'The exact discussion location is not confirmed. Its original content and reference are kept.' : null, projection: {
    entity: zone ? { kind: 'zone', zoneId: zone.zoneId } : { kind: 'tab', tabId: tab.id },
    presentationId: PMO_FLOATING_TAB_SLOT_PREFIX.replace(/-slot$/, ''),
    displayWorkspaceId: reference.displayWorkspaceId, catalog,
    selectionMode: parentConfirmed ? 'parent-occurrence' : 'occurrence',
    selection: [{ displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId }], onSelect
  } }
}
