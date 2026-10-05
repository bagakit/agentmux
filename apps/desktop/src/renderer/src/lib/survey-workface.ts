import type { AgentMuxSpaceCatalog, AgentMuxSpaceFact, AgentMuxZoneFact } from '@agentmux/core/control'
import { type WorkspaceLayout } from '@agentmux/layout'
import { resolveWorkbenchZone, sameWorkbenchProjectionSelection, type WorkbenchProjection, type WorkbenchProjectionSelection } from './workbench-projection'
import type { BrowserWorkbenchSurface, WorkbenchTab } from './workbench-tabs'

/** Survey owns navigation references, not entities, relationships or layout copies. */
export type SurveyZoneSelection = {
  zoneId: string
  selection: readonly Pick<WorkbenchProjectionSelection, 'tabId' | 'regionId'>[]
  active: Pick<WorkbenchProjectionSelection, 'tabId' | 'regionId'> | null
}
export type ResolvedSurveyZoneSelection = { zoneId: string; selection: readonly WorkbenchProjectionSelection[]; active: WorkbenchProjectionSelection | null }
export type SurveyBrowserTarget = { workspaceId: string; tabId: string; regionId: string }

/** Explicit Survey display references. Entity, resource, Topic and content facts stay at their owners. */
export type SurveyCollection = Readonly<Record<string, true>>

export function restoredSurveyCollection(candidate: unknown): Record<string, true> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {}
  return Object.fromEntries(Object.entries(candidate).filter(([id, collected]) => id.length > 0 && collected === true))
}

export function surveyZoneItems(catalog: AgentMuxSpaceCatalog, collected: SurveyCollection): AgentMuxZoneFact[] {
  return catalog.zones.filter(zone => collected[zone.zoneId] === true)
}

/** Explicit Tab removal retires only its Survey reference; unavailable membership is never emptiness. */
export function surveyCollectionAfterClose(before: Readonly<Record<string, WorkbenchTab>>, after: Readonly<Record<string, WorkbenchTab>>,
  collected: Record<string, true>, catalog: AgentMuxSpaceCatalog): Record<string, true> {
  const facts = new Map(catalog.tabs.map(tab => [tab.tabId, tab]))
  const removedZones = new Set(Object.keys(before).filter(id => !after[id]).flatMap(id => {
    const fact = facts.get(id)
    const zone = catalog.zones.find(zone => zone.zoneId === fact?.zoneId)
    return fact?.zoneId && !fact.issue && zone && zone.kind !== 'unknown' && !zone.issue && collected[fact.zoneId]
      ? [fact.zoneId] : []
  }))
  let next = collected
  for (const zoneId of removedZones) {
    const workspaceId = catalog.zones.find(zone => zone.zoneId === zoneId)!.workspaceId
    const remaining = catalog.tabs.some(fact => !before[fact.tabId] &&
      (fact.zoneId === zoneId || ((fact.zoneId === null || fact.issue) && fact.workspaceId === workspaceId))) || Object.values(after).some(tab => {
      const fact = facts.get(tab.id)
      // An unresolved member in the same resource could still belong to this Zone.
      return fact?.zoneId === zoneId || ((!fact || fact.zoneId === null || fact.issue) && tab.workspaceId === workspaceId)
    })
    if (remaining) continue
    if (next === collected) next = { ...collected }
    delete next[zoneId]
  }
  return next
}

/** Selection is derived from current members; old display coordinates cannot block the Zone. */
export function surveyResolvedZoneSelection(held: SurveyZoneSelection, projection: WorkbenchProjection | null,
  current: WorkbenchProjectionSelection | null = null): ResolvedSurveyZoneSelection {
  const selection = projection?.selection ?? []
  const member = held.active ? selection.filter(reference => reference.tabId === held.active!.tabId && reference.regionId === held.active!.regionId) : []
  const exact = current && member.find(reference => sameWorkbenchProjectionSelection(current, reference))
  const activeGroup = member.filter(reference => reference.groupId === projection?.composition?.activeGroupId)
  const active = exact ?? (member.length === 1 ? member[0]! : activeGroup.length === 1 ? activeGroup[0]! : selection.length === 1 ? selection[0]! : null)
  return { zoneId: held.zoneId, selection, active }
}

export function surveyInitialZoneSelection(catalog: AgentMuxSpaceCatalog, zoneId: string, layouts: Readonly<Record<string, WorkspaceLayout>>,
  tabs: Readonly<Record<string, WorkbenchTab>>, _preferredDisplayWorkspaceId: string | null): SurveyZoneSelection {
  const projection = resolveWorkbenchZone(zoneId, catalog, layouts, tabs, 'survey-workbench', [], () => {})
  const selection = projection?.selection ?? []
  const active = selection.find(reference => reference.groupId === layouts[projection!.displayWorkspaceId]?.activeGroupId) ?? (selection.length === 1 ? selection[0]! : null)
  return persistedSurveyZoneSelection({ zoneId, selection, active })!
}

export function surveySelectReference(selected: SurveyZoneSelection, reference: Pick<WorkbenchProjectionSelection, 'tabId' | 'regionId'>): SurveyZoneSelection {
  const member = { tabId: reference.tabId, regionId: reference.regionId }
  return { zoneId: selected.zoneId, selection: [...selected.selection.filter(previous => previous.tabId !== reference.tabId), member], active: member }
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
  const replacements = new Map<SurveyZoneSelection['selection'][number], SurveyZoneSelection['selection'][number] | null>()
  for (const reference of selected.selection) {
    if (!before[reference.tabId]?.regions[reference.regionId] || after[reference.tabId]?.regions[reference.regionId]) continue
    const tab = after[reference.tabId]
    replacements.set(reference, tab?.regions[tab.layout.activeRegionId] ? { ...reference, regionId: tab.layout.activeRegionId } : null)
    changed = true
  }
  if (!changed) return selected
  return { zoneId: selected.zoneId, selection: selected.selection.flatMap(reference => replacements.has(reference)
    ? replacements.get(reference) ? [replacements.get(reference)!] : [] : [reference]),
    active: selected.active ? replacements.get(selected.selection.find(reference => reference.tabId === selected.active!.tabId && reference.regionId === selected.active!.regionId)!) ??
      (selected.selection.some(reference => replacements.has(reference) && reference.tabId === selected.active!.tabId && reference.regionId === selected.active!.regionId) ? null : selected.active) : null }
}

export function surveySelectionAfterPromote(selected: SurveyZoneSelection | null, from: SurveyBrowserTarget, to: SurveyBrowserTarget): SurveyZoneSelection | null {
  if (!selected) return null
  const replace = (reference: SurveyZoneSelection['selection'][number]) => reference.tabId === from.tabId && reference.regionId === from.regionId
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

/** Stable member preferences are saved verbatim; display coordinates are temporary surface state. */
export type PersistedSurveyZoneSelection = SurveyZoneSelection
export function persistedSurveyZoneSelection(selected: SurveyZoneSelection | null): SurveyZoneSelection | null {
  const member = ({ tabId, regionId }: SurveyZoneSelection['selection'][number]) => ({ tabId, regionId })
  return selected ? { zoneId: selected.zoneId, selection: selected.selection.map(member), active: selected.active ? member(selected.active) : null } : null
}

export function restoredSurveyZoneSelection(candidate: unknown): SurveyZoneSelection | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  const value = candidate as Record<string, unknown>
  if (typeof value.zoneId !== 'string' || !value.zoneId) return null
  const parse = (input: unknown) => {
    if (!input || typeof input !== 'object') return null
    const { tabId, regionId } = input as Record<string, unknown>
    return typeof tabId === 'string' && tabId && typeof regionId === 'string' && regionId ? { tabId, regionId } : null
  }
  return { zoneId: value.zoneId, selection: Array.isArray(value.selection) ? value.selection.flatMap(input => {
    const member = parse(input); return member ? [member] : []
  }) : [], active: parse(value.active) }
}
