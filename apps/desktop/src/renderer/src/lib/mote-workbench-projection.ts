import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { WorkspaceLayout } from '@agentmux/layout'
import { workbenchDisplayReferenceMatches } from './workbench-resource-display'
import { pmoTeamsTopicFloatingTargetTabId, pmoTeamsTopicFloatingTargetTopicId, pmoTeamsTopicFloatingAgentIssue, PMO_FLOATING_TAB_SLOT_PREFIX, type PmoTeamsTopicFloatingState } from './pmo-teams-topic-floating'
import { resolveWorkbenchZone, sameWorkbenchProjectionSelection, workbenchProjectionLocationsMatchOwner, type WorkbenchProjection, type WorkbenchProjectionSelection } from './workbench-projection'
import type { WorkbenchTab } from './workbench-tabs'
import { homeZoneId } from '../../../shared/space-addresses'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'

export type MoteWorkbenchProjectionResult = {
  catalog: AgentMuxSpaceCatalog | null
  activeReference?: WorkbenchProjectionSelection | undefined
  projection: WorkbenchProjection | null
  choices: readonly WorkbenchProjectionSelection[]
  retainedTabId: string | undefined
  issue: string | null
  issueKind: 'identity' | 'location' | 'choice' | 'parent-available' | null
}

/** Address resolution only. The shared projector still owns composition, visibility and content. */
export function moteWorkbenchProjection(catalog: AgentMuxSpaceCatalog | null, tabs: Readonly<Record<string, WorkbenchTab>>,
  floating: PmoTeamsTopicFloatingState, onSelect: WorkbenchProjection['onSelect'], layouts: Readonly<Record<string, WorkspaceLayout>>): MoteWorkbenchProjectionResult {
  const tabId = pmoTeamsTopicFloatingTargetTabId(floating, tabs, layouts[SCRATCH_WORKSPACE_ID], null)
  const tab = tabId ? tabs[tabId] : undefined
  // Without an exact occurrence, the public Zone owns composition and selection.
  // A saved empty choice is a preference, not evidence of an empty entity.
  if (catalog && !floating.agentTarget && !floating.targetAgent && (!floating.targetTabId || tab)) {
    const topicId = pmoTeamsTopicFloatingTargetTopicId(floating, tabs)
    const spaces = catalog.spaces.filter(space => space.kind === 'mote' && space.topicId === topicId)
    const zoneId = spaces.length === 1 ? homeZoneId(spaces[0]!.spaceId) : undefined
    const member = tab ? catalog.tabs.find(member => member.tabId === tab.id) : undefined
    const targetMatches = !floating.targetTabId || tab?.workspaceId === SCRATCH_WORKSPACE_ID && tab.topicId === topicId && member?.zoneId === zoneId
    const hasMembers = catalog.tabs.some(member => member.zoneId === zoneId)
    const original = layouts[SCRATCH_WORKSPACE_ID]
    const membersKnown = hasMembers || original && original.groups.every(group => group.tabOrder.every(id => Boolean(tabs[id])))
    const held = floating.reference
    const resourceLayout = zoneId ? catalog.zones.find(zone => zone.zoneId === zoneId) : undefined
    const exactLocations = held ? catalog.locations.filter(location => sameWorkbenchProjectionSelection(held, location)) : []
    const repeatedGroups = held ? new Set(catalog.locations.filter(location => location.tabId === held.tabId &&
      location.displayWorkspaceId === held.displayWorkspaceId).map(location => location.groupId)) : new Set()
    const ordinaryChoice = held === undefined || held === null && !floating.targetTabId || held &&
      held.displayWorkspaceId === resourceLayout?.workspaceId && repeatedGroups.size === 1 &&
      workbenchProjectionLocationsMatchOwner(catalog, held.tabId, exactLocations) &&
      Boolean(tab?.regions[held.regionId]) && workbenchDisplayReferenceMatches(layouts[held.displayWorkspaceId], held)
    const preferences = held ? [held] : tab ? [{ tabId: tab.id, regionId: tab.layout.activeRegionId }] : []
    const projection = zoneId && ordinaryChoice && targetMatches && membersKnown ? resolveWorkbenchZone(zoneId, catalog, layouts, tabs,
      PMO_FLOATING_TAB_SLOT_PREFIX.replace(/-slot$/, ''), preferences, onSelect) : null
    if (projection) {
      const layout = projection.composition ?? layouts[projection.displayWorkspaceId]
      const activeReference = projection.selection.find(reference => reference.tabId === floating.targetTabId) ??
        projection.selection.find(reference => reference.groupId === layout?.activeGroupId) ?? projection.selection[0]
      return { catalog, projection, activeReference, choices: [], retainedTabId: activeReference?.tabId, issue: null, issueKind: null }
    }
  }
  return moteOccurrenceProjection(catalog, tab, floating, onSelect, layouts)
}

/** Exact saved occurrences and Agent bookmarks keep their original recovery boundary. */
function moteOccurrenceProjection(catalog: AgentMuxSpaceCatalog | null, tab: WorkbenchTab | undefined,
  floating: PmoTeamsTopicFloatingState, onSelect: WorkbenchProjection['onSelect'], layouts: Readonly<Record<string, WorkspaceLayout>>): MoteWorkbenchProjectionResult {
  const retained: MoteWorkbenchProjectionResult = { catalog, projection: null, choices: [], retainedTabId: floating.targetTabId ?? tab?.id, issue: null, issueKind: null }
  const identityIssue = pmoTeamsTopicFloatingAgentIssue(floating, tab)
  if (identityIssue) return { ...retained, issue: identityIssue, issueKind: 'identity' }
  if (!tab || !catalog || !floating.agentTarget && floating.targetTopicId && tab.topicId !== floating.targetTopicId) return retained
  const entity = catalog.tabs.find(item => item.tabId === tab.id)
  const zone = entity?.zoneId ? catalog.zones.find(item => item.zoneId === entity.zoneId) : undefined
  const choices = [...new Map(catalog.locations.filter(location => location.tabId === tab.id &&
    location.regionId === (floating.agentTarget && floating.reference ? floating.reference.regionId : tab.layout.activeRegionId)).map(({ displayWorkspaceId, groupId, tabId, regionId }) => {
      const reference = { displayWorkspaceId, groupId, tabId, regionId }
      return [JSON.stringify(reference), reference] as const
    })).values()]
  const held = floating.reference
  const candidate = held ?? (held === undefined && choices.length === 1 ? choices[0] : undefined)
  const exactLocations = candidate ? catalog.locations.filter(location => sameWorkbenchProjectionSelection(candidate, location) && location.tabId === tab.id) : []
  const exact = workbenchProjectionLocationsMatchOwner(catalog, tab.id, exactLocations) ? candidate : undefined
  const parentLocations = !exact && held?.tabId === tab.id && !Object.hasOwn(tab.regions, held.regionId) &&
    workbenchDisplayReferenceMatches(layouts[held.displayWorkspaceId], held)
    ? catalog.locations.filter(location => location.displayWorkspaceId === held.displayWorkspaceId && location.groupId === held.groupId &&
      location.tabId === held.tabId && tab.regions[location.regionId]) : []
  const parentConfirmed = workbenchProjectionLocationsMatchOwner(catalog, tab.id, parentLocations)
  const reference = exact ?? (parentConfirmed ? held : undefined)
  const unbound = entity?.zoneId === null && (!tab.space) && reference && (parentConfirmed
    ? parentLocations.every(location => location.zoneId === null && location.spaceId === null)
    : exactLocations.every(location => location.zoneId === null && location.spaceId === null))
  if (entity?.workspaceId !== tab.workspaceId || tab.space && entity.zoneId !== tab.space.zoneId || (!zone && !unbound) || !reference || !parentConfirmed && !tab.regions[reference.regionId] || !workbenchDisplayReferenceMatches(layouts[reference.displayWorkspaceId], reference)) return { ...retained, choices,
    issueKind: choices.length > 1 && held === undefined ? 'choice' : 'location',
    issue: choices.length > 1 && held === undefined ? 'Choose where to continue this discussion. Every original location is kept.'
      : 'The exact discussion location is not confirmed. Its original content and reference are kept.' }
  return { catalog, retainedTabId: tab.id, choices,
    issueKind: parentConfirmed ? 'parent-available' : null,
    issue: parentConfirmed ? 'The exact discussion location is not confirmed. Its original content and reference are kept.' : null, projection: {
    entity: zone && !floating.agentTarget ? { kind: 'zone', zoneId: zone.zoneId } : { kind: 'tab', tabId: tab.id },
    presentationId: PMO_FLOATING_TAB_SLOT_PREFIX.replace(/-slot$/, ''),
    displayWorkspaceId: reference.displayWorkspaceId, catalog,
    selectionMode: parentConfirmed ? 'parent-occurrence' : 'occurrence',
    selection: [{ displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId }], onSelect
  } }
}
