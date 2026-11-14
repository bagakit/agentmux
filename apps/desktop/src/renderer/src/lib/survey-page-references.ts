import { parseSurveyPageReferences, type AgentMuxSurveyPageReference as Page, type AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { selectSpatialCatalog } from '@agentmux/core/spatial-graph'
import { sameWorkbenchProjectionSelection, type WorkbenchProjection, type WorkbenchProjectionSelection } from './workbench-projection'
import { findWorkbenchRegion, type WorkbenchTab } from './workbench-tabs'
import { persistedSurveyZoneSelection, restoredSurveyZoneSelection, type SurveyZoneSelection } from './survey-workface'

export type SurveyPageSelection = { kind: 'page'; zoneId?: never; selection?: never; active?: never } & Page
export type SurveySelection = SurveyZoneSelection | SurveyPageSelection
export type SurveyPageReadRecovery = { source: unknown; issue: string }
export const isSurveyPage = (value: SurveySelection | null | undefined): value is SurveyPageSelection =>
  !!value && 'kind' in value && value.kind === 'page'

/** Readable references are a projection; an unread original field remains at its original durable key. */
export function readSurveyPagePreferences(value: unknown): { references: Page[]; recovery: SurveyPageReadRecovery | null } {
  if (value === undefined) return { references: [], recovery: null }
  try { return { references: parseSurveyPageReferences(value), recovery: null } }
  catch {
    const byRegion = new Map<string, Page | null>()
    if (Array.isArray(value)) for (const entry of value) {
      try {
        const page = parseSurveyPageReferences([entry])[0]!, previous = byRegion.get(page.regionId)
        if (previous === undefined) byRegion.set(page.regionId, page)
        else if (previous !== null && previous.browserId !== page.browserId) byRegion.set(page.regionId, null)
      } catch { /* Retain the unread original entry in this same source. */ }
    }
    const references = [...byRegion.values()].filter((page): page is Page => page !== null)
    return { references, recovery: { source: value,
      issue: 'Some saved Survey page references could not be read. Their original data and all work surfaces are kept. Restore the original preference source, then read these page references again.' } }
  }
}

export function restoredSurveyPages(value: unknown): Page[] { return readSurveyPagePreferences(value).references }
export function persistedSurveySelection(value: SurveySelection | null) {
  return isSurveyPage(value) ? { kind: 'page' as const, regionId: value.regionId, browserId: value.browserId } : persistedSurveyZoneSelection(value)
}
export function restoredSurveySelection(value: unknown): SurveySelection | null {
  if (value && typeof value === 'object' && 'kind' in value && value.kind === 'page') {
    const raw = value as Record<string, unknown>
    try { return { kind: 'page', ...parseSurveyPageReferences([{ regionId: raw.regionId, browserId: raw.browserId }])[0]! } }
    catch { return null }
  }
  return restoredSurveyZoneSelection(value)
}

type SurveyCatalogScope = {
  regionsById: Map<string, Pick<AgentMuxSpaceCatalog['regions'][number], 'tabId' | 'kind'>[]>
  tabsByZone: Map<string, string[]>
  zoneIds: Set<string>
  occurrencesByRegion: Map<string, WorkbenchProjectionSelection[]>
  projectionCatalogs: Map<string, AgentMuxSpaceCatalog>
}
const catalogScopes = new WeakMap<AgentMuxSpaceCatalog, SurveyCatalogScope>()

/** Original immutable topology and slices; no live Browser, permission or callback cache. */
export function surveyCatalogScope(catalog: AgentMuxSpaceCatalog): SurveyCatalogScope {
  const known = catalogScopes.get(catalog)
  if (known) return known
  const regionsById: SurveyCatalogScope['regionsById'] = new Map()
  const tabsByZone = new Map<string, string[]>()
  for (const region of catalog.regions) {
    const members = regionsById.get(region.regionId) ?? []
    members.push({ tabId: region.tabId, kind: region.kind })
    regionsById.set(region.regionId, members)
  }
  for (const tab of catalog.tabs) if (tab.zoneId !== null) {
    const members = tabsByZone.get(tab.zoneId) ?? []
    members.push(tab.tabId)
    tabsByZone.set(tab.zoneId, members)
  }
  const occurrencesByRegion = new Map<string, WorkbenchProjectionSelection[]>(), seen = new Set<string>()
  for (const location of catalog.locations) {
    const reference = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId,
      tabId: location.tabId, regionId: location.regionId }
    const key = JSON.stringify(reference)
    if (seen.has(key)) continue
    seen.add(key)
    const members = occurrencesByRegion.get(reference.regionId) ?? []
    members.push(reference)
    occurrencesByRegion.set(reference.regionId, members)
  }
  const scope = { regionsById, tabsByZone, occurrencesByRegion, zoneIds: new Set(catalog.zones.map(zone => zone.zoneId)),
    projectionCatalogs: new Map<string, AgentMuxSpaceCatalog>() }
  catalogScopes.set(catalog, scope)
  return scope
}

/** The original Region must still contain that exact Browser; placement cannot select a replacement. */
export function surveyPageOwner(tabs: Readonly<Record<string, WorkbenchTab>>, page: Page, catalog?: AgentMuxSpaceCatalog | null) {
  if (catalog) {
    const facts = surveyCatalogScope(catalog).regionsById.get(page.regionId)
    const tab = facts?.length === 1 ? tabs[facts[0]!.tabId] : undefined
    const surface = tab?.regions[page.regionId]
    if (tab && surface?.kind === 'browser' && surface.browserId === page.browserId) return { tab, surface }
  }
  // Unconfirmed or stale display topology cannot take away the original page's
  // title/tools or change control callers' existing exact-owner recovery path.
  const owner = findWorkbenchRegion(tabs, page.regionId)
  return owner?.surface.kind === 'browser' && owner.surface.browserId === page.browserId ? owner : null
}

export function surveyPageProjection(page: Page, catalog: AgentMuxSpaceCatalog | null, tabs: Readonly<Record<string, WorkbenchTab>>,
  onSelect: WorkbenchProjection['onSelect'], preferred: WorkbenchProjectionSelection | null = null): WorkbenchProjection | null {
  if (!catalog) return null
  const owner = surveyPageOwner(tabs, page, catalog)
  if (!owner) return null
  const scope = surveyCatalogScope(catalog)
  const facts = (scope.regionsById.get(page.regionId) ?? []).filter(region => region.tabId === owner.tab.id && region.kind === 'browser')
  if (facts.length !== 1) return null
  const choices = (scope.occurrencesByRegion.get(page.regionId) ?? []).filter(reference => reference.tabId === owner.tab.id)
  const original = choices.filter(reference => reference.displayWorkspaceId === owner.tab.workspaceId)
  // Composition changes the Tab, not this confirmed display Group. Prefer the same original
  // Region occurrence before the existing unique-placement resolution.
  const retained = preferred?.regionId === page.regionId ? choices.filter(choice =>
    choice.displayWorkspaceId === preferred.displayWorkspaceId && choice.groupId === preferred.groupId && choice.regionId === preferred.regionId) : []
  const chosen = preferred && choices.find(choice => sameWorkbenchProjectionSelection(preferred, choice)) ||
    retained.length === 1 && retained[0] || original.length === 1 && original[0] || choices.length === 1 && choices[0]
  if (!chosen) return null
  const reference = { ...chosen }
  const key = JSON.stringify([reference.displayWorkspaceId, reference.groupId, reference.tabId])
  let selected = scope.projectionCatalogs.get(key)
  if (!selected) {
    selected = selectSpatialCatalog(catalog, { displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId })
    scope.projectionCatalogs.set(key, selected)
  }
  return {
    entity: { kind: 'region', regionId: page.regionId }, presentationId: 'survey-workbench', displayWorkspaceId: reference.displayWorkspaceId,
    catalog: selected,
    selection: [reference], onSelect
  }
}
