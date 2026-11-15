import type { AgentMuxSurveyPageReference } from '@agentmux/core/control'
import type { AppState } from '../store'
import { isSystemWebUrl } from '../../../shared/system-web-url'
import { resolveBrowserInput } from '../../../shared/browser-address'
import { resolveSurveyBrowsing } from '../../../shared/survey-browsing'
import { isSurveyPage } from './survey-page-references'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { samePage } from './survey-list'

type State = Pick<AppState, 'config' | 'tabs' | 'layouts' | 'surveyPageReferences' | 'surveyZoneSelection'>
type SurveyPageMatch = { page: AgentMuxSurveyPageReference; reference: WorkbenchProjectionSelection; profileId: string }

/** Opening an existing page selects the original occurrence. This never navigates its WebContents. */
export function surveyPageReuseCandidates(state: State, input: string): SurveyPageMatch[] {
  if (!state.surveyPageReferences.length || !resolveSurveyBrowsing(state.config?.browser.surveyBrowsing).reuseOpenPages) return []
  let url: string
  try {
    const address = resolveBrowserInput(input)
    if (address.kind !== 'address' || !isSystemWebUrl(address.url)) return []
    url = address.url
  } catch { return [] }

  const saved = new Set(state.surveyPageReferences.map(page => page.regionId))
  const matches = new Map<string, string>()
  for (const tab of Object.values(state.tabs)) {
    for (const [regionId, browser] of Object.entries(tab.regions)) {
      if (!saved.has(regionId) || browser.kind !== 'browser' || browser.mode !== 'normal' || browser.capsuleId || browser.nativeOwnerUnavailable ||
        !browser.profileId || !isSystemWebUrl(browser.url) || new URL(browser.url).href !== url) continue
      matches.set(regionId, tab.id)
    }
  }
  const selected = isSurveyPage(state.surveyZoneSelection) ? state.surveyZoneSelection : null
  const candidates = state.surveyPageReferences.filter(page => matches.has(page.regionId))
  const current = selected && candidates.find(page => samePage(page, selected))
  const resolved: SurveyPageMatch[] = []
  for (const page of current ? [current, ...candidates.filter(candidate => candidate !== current)] : candidates) {
    const tab = state.tabs[matches.get(page.regionId)!]!
    const browser = tab.regions[page.regionId]!
    if (browser.kind !== 'browser' || !browser.profileId || browser.browserId !== page.browserId) continue
    const occurrences: WorkbenchProjectionSelection[] = []
    for (const [displayWorkspaceId, layout] of Object.entries(state.layouts)) {
      for (const group of layout.groups) if (group.tabOrder.includes(tab.id)) {
        occurrences.push({ displayWorkspaceId, groupId: group.id, tabId: tab.id, regionId: page.regionId })
      }
    }
    const original = occurrences.filter(occurrence => occurrence.displayWorkspaceId === tab.workspaceId)
    const shown = current === page && selected?.presentation
    const reference = (shown ? occurrences.find(location => shown.tabId === location.tabId && shown.groupId === location.groupId &&
      shown.displayWorkspaceId === location.displayWorkspaceId) : undefined) ??
      (original.length === 1 ? original[0] : occurrences.length === 1 ? occurrences[0] : undefined)
    if (reference) resolved.push({ page, reference, profileId: browser.profileId })
  }
  return resolved
}
