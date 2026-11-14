import { parseSurveyProfileView, type AgentMuxSurveyProfileView, type AgentMuxSpaceCatalog, type AgentMuxSurveyPageReference } from '@agentmux/core/control'
import { isSurveyPage, surveyPageOwner, type SurveySelection } from './survey-page-references'
import type { WorkbenchTab } from './workbench-tabs'

export type SurveyProfileView = AgentMuxSurveyProfileView
export type SurveyProfileViewRecovery = { source: unknown; issue: string }
export const DEFAULT_SURVEY_PROFILE_VIEW: SurveyProfileView = { kind: 'default' }
export function readSurveyProfileView(value: unknown): { view: SurveyProfileView; recovery: SurveyProfileViewRecovery | null } {
  if (value === undefined) return { view: DEFAULT_SURVEY_PROFILE_VIEW, recovery: null }
  try { return { view: parseSurveyProfileView(value), recovery: null } }
  catch { return { view: DEFAULT_SURVEY_PROFILE_VIEW, recovery: { source: value,
    issue: 'The saved environment view is unreadable. Its original preference and pages are kept. Choose an environment to replace only this view preference.' } } }
}

type Match = 'match' | 'other' | 'unknown' | 'independent'
function browserMatch(view: SurveyProfileView, surface: WorkbenchTab['regions'][string], defaultProfileId: string | undefined): Match {
  if (surface.kind !== 'browser') return 'independent'
  if (surface.mode === 'private' || surface.capsuleId) return 'independent'
  if (!surface.profileId) return 'unknown'
  const target = view.kind === 'profile' ? view.profileId : defaultProfileId
  return target === undefined ? 'unknown' : surface.profileId === target ? 'match' : 'other'
}
export function surveySelectionProfileMatch(view: SurveyProfileView, selection: SurveySelection | null,
  tabs: Readonly<Record<string, WorkbenchTab>>, defaultProfileId: string | undefined, catalog: AgentMuxSpaceCatalog | null): Match {
  if (!selection) return 'independent'
  if (isSurveyPage(selection)) {
    const owner = surveyPageOwner(tabs, selection)
    return owner ? browserMatch(view, owner.surface, defaultProfileId) : 'unknown'
  }
  const originals = catalog?.tabs.filter(tab => tab.zoneId === selection.zoneId) ?? []
  if (!catalog?.zones.some(zone => zone.zoneId === selection.zoneId)) return 'unknown'
  const matches = originals.flatMap(tab => tabs[tab.tabId]
    ? Object.values(tabs[tab.tabId]!.regions).filter(surface => surface.kind === 'browser').map(surface => browserMatch(view, surface, defaultProfileId))
    : ['unknown' as const])
  if (matches.includes('match')) return 'match'
  if (matches.includes('unknown')) return 'unknown'
  return matches.length && matches.every(match => match === 'other') ? 'other' : 'independent'
}
type SurveyCatalogScope = {
  tabByRegion: Map<string, string | null>
  tabsByZone: Map<string, string[]>
  zoneIds: Set<string>
}
const catalogScopes = new WeakMap<AgentMuxSpaceCatalog, SurveyCatalogScope>()

/** Original immutable topology only; live Browser/Profile facts stay in Tabs. */
function surveyCatalogScope(catalog: AgentMuxSpaceCatalog): SurveyCatalogScope {
  const known = catalogScopes.get(catalog)
  if (known) return known
  const tabByRegion = new Map<string, string | null>(), tabsByZone = new Map<string, string[]>()
  for (const region of catalog.regions) {
    tabByRegion.set(region.regionId, tabByRegion.has(region.regionId) ? null : region.tabId)
  }
  for (const tab of catalog.tabs) if (tab.zoneId !== null) {
    const members = tabsByZone.get(tab.zoneId) ?? []
    members.push(tab.tabId)
    tabsByZone.set(tab.zoneId, members)
  }
  const scope = { tabByRegion, tabsByZone, zoneIds: new Set(catalog.zones.map(zone => zone.zoneId)) }
  catalogScopes.set(catalog, scope)
  return scope
}

/** A derived view over the original references. It never writes membership or creates entities. */
export function surveyProfileReferences(view: SurveyProfileView, pages: readonly AgentMuxSurveyPageReference[], zoneIds: readonly string[],
  tabs: Readonly<Record<string, WorkbenchTab>>, defaultProfileId: string | undefined, catalog: AgentMuxSpaceCatalog | null) {
  // Missing topology cannot remove saved references or justify guessing another
  // Region's identity. The original page/recovery consumer remains available.
  if (!catalog || !pages.length && !zoneIds.length) return { pages: [...pages], zoneIds: new Set(zoneIds) }
  const scope = surveyCatalogScope(catalog)
  const zoneMatches = new Map<string, Match[]>()
  for (const zoneId of zoneIds) {
    const matches: Match[] = []
    for (const tabId of scope.tabsByZone.get(zoneId) ?? []) {
      const tab = tabs[tabId]
      if (!tab) matches.push('unknown')
      else for (const surface of Object.values(tab.regions)) if (surface.kind === 'browser') matches.push(browserMatch(view, surface, defaultProfileId))
    }
    zoneMatches.set(zoneId, matches)
  }
  return {
    pages: pages.filter(page => {
      const tabId = scope.tabByRegion.get(page.regionId)
      const surface = tabId ? tabs[tabId]?.regions[page.regionId] : undefined
      return !surface || surface.kind !== 'browser' || surface.browserId !== page.browserId || browserMatch(view, surface, defaultProfileId) !== 'other'
    }),
    zoneIds: new Set(zoneIds.filter(zoneId => {
      if (!scope.zoneIds.has(zoneId)) return true
      const matches = zoneMatches.get(zoneId) ?? []
      return !matches.length || matches.some(match => match !== 'other')
    }))
  }
}
