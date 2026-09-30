import type { AgentMuxSpaceCatalog, AgentMuxSpaceFact, AgentMuxZoneFact } from '@agentmux/core/control'
import type { WorkspaceLayout } from '@agentmux/layout'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from './workbench-projection'
import type { BrowserWorkbenchSurface, WorkbenchTab } from './workbench-tabs'

/** Survey owns navigation references, not entities, relationships or layout copies. */
export type SurveyZoneSelection = {
  zoneId: string
  selection: readonly WorkbenchProjectionSelection[]
  active: WorkbenchProjectionSelection | null
}
export type SurveyBrowserTarget = { workspaceId: string; tabId: string; regionId: string }

/** Explicit Survey display references. Entity, resource, Topic and content facts stay at their owners. */
export type SurveyCollection = Readonly<Record<string, true>>

export function restoredSurveyCollection(candidate: unknown): Record<string, true> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {}
  return Object.fromEntries(Object.entries(candidate).filter(([id, collected]) => id.length > 0 && collected === true))
}

export function surveyZoneItems(catalog: AgentMuxSpaceCatalog, collected: SurveyCollection): AgentMuxZoneFact[] {
  const browserRegions = new Set(catalog.regions.filter(region => region.kind === 'browser')
    .map(region => JSON.stringify([region.tabId, region.regionId])))
  const discovered = new Set(catalog.tabs.flatMap(tab => tab.zoneId && tab.regionIds.some(regionId =>
    browserRegions.has(JSON.stringify([tab.tabId, regionId]))) ? [tab.zoneId] : []))
  return catalog.zones.filter(zone => discovered.has(zone.zoneId) || collected[zone.zoneId] === true)
}

/** Original active/recent references, with no first-member or resource-workspace fallback. */
export function surveyInitialZoneSelection(catalog: AgentMuxSpaceCatalog, zoneId: string, layouts: Readonly<Record<string, WorkspaceLayout>>,
  tabs: Readonly<Record<string, WorkbenchTab>>, preferredDisplayWorkspaceId: string | null): SurveyZoneSelection {
  const members = new Set(catalog.tabs.filter(tab => tab.zoneId === zoneId).map(tab => tab.tabId))
  const selection: WorkbenchProjectionSelection[] = []
  let active: WorkbenchProjectionSelection | null = null
  for (const [displayWorkspaceId, layout] of Object.entries(layouts)) for (const group of layout.groups) {
    const tabId = group.activeTabId && members.has(group.activeTabId) ? group.activeTabId
      : group.recentTabIds.find(id => members.has(id) && group.tabOrder.includes(id))
    const tab = tabId ? tabs[tabId] : undefined
    if (!tab || !catalog.locations.some(location => location.zoneId === zoneId && location.displayWorkspaceId === displayWorkspaceId &&
      location.groupId === group.id && location.tabId === tab.id && location.regionId === tab.layout.activeRegionId)) continue
    const reference = { displayWorkspaceId, groupId: group.id, tabId: tab.id, regionId: tab.layout.activeRegionId }
    selection.push(reference)
    if (group.id === layout.activeGroupId && displayWorkspaceId === preferredDisplayWorkspaceId) active = reference
  }
  return { zoneId, selection, active }
}

export function surveySelectReference(selected: SurveyZoneSelection, reference: WorkbenchProjectionSelection): SurveyZoneSelection {
  return { zoneId: selected.zoneId, selection: [...selected.selection.filter(previous => previous.displayWorkspaceId !== reference.displayWorkspaceId || previous.groupId !== reference.groupId), reference], active: reference }
}

export function surveySelectedBrowser(tabs: Readonly<Record<string, WorkbenchTab>>, selected: SurveyZoneSelection | null): BrowserWorkbenchSurface | null {
  const reference = selected?.active
  const surface = reference ? tabs[reference.tabId]?.regions[reference.regionId] : undefined
  return surface?.kind === 'browser' ? surface : null
}

/** Only a known original topology result can retire a Region reference; the Zone remains selected. */
export function surveySelectionAfterClose(before: Readonly<Record<string, WorkbenchTab>>, after: Readonly<Record<string, WorkbenchTab>>,
  selected: SurveyZoneSelection | null): SurveyZoneSelection | null {
  if (!selected) return null
  let changed = false
  const replacements = new Map<WorkbenchProjectionSelection, WorkbenchProjectionSelection | null>()
  for (const reference of selected.selection) {
    if (!before[reference.tabId]?.regions[reference.regionId] || after[reference.tabId]?.regions[reference.regionId]) continue
    const tab = after[reference.tabId]
    replacements.set(reference, tab?.regions[tab.layout.activeRegionId] ? { ...reference, regionId: tab.layout.activeRegionId } : null)
    changed = true
  }
  if (!changed) return selected
  return { zoneId: selected.zoneId, selection: selected.selection.flatMap(reference => replacements.has(reference)
    ? replacements.get(reference) ? [replacements.get(reference)!] : [] : [reference]),
    active: selected.active ? replacements.get(selected.selection.find(reference => sameWorkbenchProjectionSelection(reference, selected.active!))!) ??
      (selected.selection.some(reference => replacements.has(reference) && sameWorkbenchProjectionSelection(reference, selected.active!)) ? null : selected.active) : null }
}

export function surveySelectionAfterPromote(selected: SurveyZoneSelection | null, from: SurveyBrowserTarget, to: SurveyBrowserTarget): SurveyZoneSelection | null {
  if (!selected) return null
  const replace = (reference: WorkbenchProjectionSelection) => reference.tabId === from.tabId && reference.regionId === from.regionId
    ? { ...reference, tabId: to.tabId, regionId: to.regionId } : reference
  if (!selected.selection.some(reference => reference.tabId === from.tabId && reference.regionId === from.regionId)) return selected
  return { zoneId: selected.zoneId, selection: selected.selection.map(replace), active: selected.active ? replace(selected.active) : null }
}

export function surveyZoneTopicFacts(catalog: AgentMuxSpaceCatalog, zoneId: string): {
  relatedTopics: AgentMuxSpaceFact[] | null
  unknownRelatedSpaces: AgentMuxSpaceFact[]
} {
  const spaces = new Map(catalog.spaces.map(space => [space.spaceId, space]))
  const relations = catalog.bindings.filter(binding => binding.zoneId === zoneId)
  const linked = relations.flatMap(binding => spaces.get(binding.spaceId) ? [spaces.get(binding.spaceId)!] : [])
  const unknownRelatedSpaces = linked.filter(space => space.kind === 'container' && Boolean(space.issue))
  return { relatedTopics: unknownRelatedSpaces.length || linked.length !== relations.length ? null : linked.filter(space => space.kind === 'topic'), unknownRelatedSpaces }
}

export function restoredSurveyZoneSelection(candidate: unknown): SurveyZoneSelection | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  const value = candidate as Record<string, unknown>
  const parse = (input: unknown): WorkbenchProjectionSelection | null => {
    if (typeof input !== 'object' || input === null) return null
    const reference = input as Record<string, unknown>
    const { displayWorkspaceId, groupId, tabId, regionId } = reference
    return [displayWorkspaceId, groupId, tabId, regionId].every(value => typeof value === 'string' && value !== '')
      ? { displayWorkspaceId: displayWorkspaceId as string, groupId: groupId as string, tabId: tabId as string, regionId: regionId as string } : null
  }
  if (typeof value.zoneId !== 'string' || !value.zoneId || !Array.isArray(value.selection)) return null
  const selection = value.selection.map(parse)
  if (selection.some(reference => reference === null)) return null
  const active = value.active === null ? null : parse(value.active)
  if (value.active !== null && !active) return null
  if (active && !selection.some(reference => reference && sameWorkbenchProjectionSelection(reference, active))) return null
  return { zoneId: value.zoneId, selection: selection as WorkbenchProjectionSelection[], active }
}
