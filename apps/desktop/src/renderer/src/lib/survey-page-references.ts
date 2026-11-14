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

/** The original Region must still contain that exact Browser; placement cannot select a replacement. */
export function surveyPageOwner(tabs: Readonly<Record<string, WorkbenchTab>>, page: Page) {
  const owner = findWorkbenchRegion(tabs, page.regionId)
  return owner?.surface.kind === 'browser' && owner.surface.browserId === page.browserId ? owner : null
}

export function surveyPageProjection(page: Page, catalog: AgentMuxSpaceCatalog | null, tabs: Readonly<Record<string, WorkbenchTab>>,
  onSelect: WorkbenchProjection['onSelect'], preferred: WorkbenchProjectionSelection | null = null): WorkbenchProjection | null {
  const owner = surveyPageOwner(tabs, page)
  if (!owner || !catalog) return null
  const facts = catalog.regions.filter(region => region.regionId === page.regionId && region.tabId === owner.tab.id && region.kind === 'browser')
  if (facts.length !== 1) return null
  const choices = [...new Map(catalog.locations.filter(location => location.regionId === page.regionId && location.tabId === owner.tab.id)
    .map(location => {
      const reference = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
      return [JSON.stringify(reference), reference] as const
    })).values()]
  const original = choices.filter(reference => reference.displayWorkspaceId === owner.tab.workspaceId)
  const reference = preferred && choices.find(choice => sameWorkbenchProjectionSelection(preferred, choice)) ||
    original.length === 1 && original[0] || choices.length === 1 && choices[0]
  if (!reference) return null
  return {
    entity: { kind: 'region', regionId: page.regionId }, presentationId: 'survey-workbench', displayWorkspaceId: reference.displayWorkspaceId,
    catalog: selectSpatialCatalog(catalog, { displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId }),
    selection: [reference], onSelect
  }
}
