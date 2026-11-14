import type { AgentMuxSurveyPageAdmission, AgentMuxSurveyPageReference } from '@agentmux/core/control'
import type { BrowserSnapshot } from '../../../shared/contracts'
import type { AppState } from '../store'
import { api } from './api'
import { surveyPageOwner } from './survey-page-references'

export type SurveyMembershipGeneration = AppState['surveyPageReferences']
export type SurveyPageAdmissionState = Pick<AppState,
  'tabs' | 'surveyPageReferences' | 'registerSurveyBrowserPage' | 'setSurveyPageCollected'>
type SurveyProfileBindingState = SurveyPageAdmissionState & Pick<AppState, 'applyBrowserEvent'>
export type SurveyProfileBindingReceipt = {
  reference: AgentMuxSurveyPageReference
  profileId: string
  navigationId: string
  switchOutcome: 'confirmed' | 'unconfirmed'
  admission: AgentMuxSurveyPageAdmission
  /** An original field generation, retained only by this exact unfinished UI operation. */
  membership: SurveyMembershipGeneration
}
export function surveyAdmissionUnknown(reference: AgentMuxSurveyPageReference, code: string, message: string): AgentMuxSurveyPageAdmission {
  return { reference, outcome: 'unknown', save: null, issues: [{ step: 'survey', code, message,
    recovery: 'The original page and binding are kept. Read its exact Survey reference before a new explicit membership change; do not switch or open the page again.' }] }
}

/** Main's exact binding is strong; membership and saving remain a separate weak step. */
export async function admitPreparedSurveyPage(get: () => SurveyPageAdmissionState, reference: AgentMuxSurveyPageReference,
  expected: Pick<BrowserSnapshot, 'mode' | 'profileId'>, generation: SurveyMembershipGeneration): Promise<{ admission: AgentMuxSurveyPageAdmission; membership: SurveyMembershipGeneration }> {
  const unchanged = (admission: AgentMuxSurveyPageAdmission) => ({ admission, membership: generation })
  const state = get(), owner = surveyPageOwner(state.tabs, reference)
  if (!owner || owner.surface.kind !== 'browser' || owner.surface.mode !== expected.mode || owner.surface.profileId !== expected.profileId) {
    return unchanged(surveyAdmissionUnknown(reference, 'SURVEY_PAGE_BINDING_UNCONFIRMED', 'The original Browser no longer confirms this operation’s exact environment binding.'))
  }
  const existing = state.surveyPageReferences.find(page => page.regionId === reference.regionId)
  if (existing && existing.browserId !== reference.browserId) {
    return unchanged(surveyAdmissionUnknown(reference, 'SURVEY_PAGE_OCCUPANT_CONFLICT', 'The saved original Region names another Browser. Both original identities are kept.'))
  }
  if (state.surveyPageReferences !== generation && !existing) {
    return unchanged(surveyAdmissionUnknown(reference, 'SURVEY_PAGE_MEMBERSHIP_SUPERSEDED', 'Survey membership changed while this operation was pending. A withdrawn reference is not added again.'))
  }
  let membership = generation
  const applied = (pages: SurveyMembershipGeneration) => { membership = pages }
  try {
    let admission: AgentMuxSurveyPageAdmission
    if (expected.mode === 'normal' && expected.profileId) admission = await get().registerSurveyBrowserPage(reference, expected.profileId, applied)
    else {
      // Explicit private Survey creation uses the same exact-reference owner.
      const report = await get().setSurveyPageCollected(reference, true, applied)
      admission = { reference, save: report.save, issues: report.issues,
        outcome: report.outcome === 'unknown' || report.outcome === 'refused' ? 'unknown' : report.outcome === 'partial' ? 'partial' : 'registered' }
    }
    if (get().surveyPageReferences !== membership && !get().surveyPageReferences.some(page => page.regionId === reference.regionId && page.browserId === reference.browserId)) {
      admission = { ...surveyAdmissionUnknown(reference, 'SURVEY_PAGE_MEMBERSHIP_SUPERSEDED',
        'This reference was withdrawn while its save was pending. The later membership is kept.'), save: admission.save }
    }
    return { admission, membership }
  } catch {
    return { membership, admission: { reference, outcome: 'partial', save: null, issues: [{ step: 'save', code: 'SURVEY_PAGE_SAVE_UNCONFIRMED',
      message: 'The original page is available. Its Survey preference save is unconfirmed.', recovery: 'Retry only this original reference save; keep the confirmed page and environment.' }] } }
  }
}

export async function switchBrowserProfileForSurvey(get: () => SurveyProfileBindingState, reference: AgentMuxSurveyPageReference, profileId: string): Promise<SurveyProfileBindingReceipt> {
  const before = get(), owner = surveyPageOwner(before.tabs, reference)
  if (!owner || owner.surface.kind !== 'browser') throw new Error('The exact original Browser Region is unavailable. Its current work is kept; inspect that same reference.')
  const originalNavigation = owner.surface.navigationId, membership = before.surveyPageReferences
  let browser: BrowserSnapshot
  try { browser = await api.browser.switchProfile(reference.browserId, profileId) }
  catch (error) {
    // Main's original human-input refusal is a typed, uncommitted result. An
    // arbitrary transport failure cannot prove that the native switch failed.
    if (error instanceof Error && 'code' in error && error.code === 'BROWSER_AGENT_CONTROL_ACTIVE') throw error
    const observed = surveyPageOwner(get().tabs, reference)?.surface
    const targetObserved = observed?.kind === 'browser' && observed.mode === 'normal' && observed.profileId === profileId
    // Retain this operation's original intent/generation in either event order.
    // A later explicit repair rechecks Main's exact binding without replaying it.
    return { reference: { ...reference }, profileId, navigationId: targetObserved ? observed.navigationId : originalNavigation,
      switchOutcome: 'unconfirmed', membership, admission: surveyAdmissionUnknown(reference, 'BROWSER_PROFILE_SWITCH_UNCONFIRMED', targetObserved
        ? 'The switch reply is unconfirmed. Main reports this page in the requested environment; check only its Survey reference without switching again.'
        : 'The switch reply and its current environment are unconfirmed. Keep this exact page and request; check its original binding and Survey reference without switching again.') }
  }
  if (browser.id !== reference.browserId || browser.mode !== 'normal' || browser.profileId !== profileId) {
    throw Object.assign(new Error('Main did not confirm this original Browser and requested Profile. Keep its current page and inspect the original binding.'),
      { code: 'BROWSER_PROFILE_BINDING_UNCONFIRMED', details: { reference, requestedProfileId: profileId, returnedBrowserId: browser.id, returnedProfileId: browser.profileId } })
  }
  // The original reducer guards a late result against a newer native document.
  get().applyBrowserEvent({ type: 'updated', browser }, originalNavigation)
  const attempt = await admitPreparedSurveyPage(get, reference, browser, membership)
  return { reference: { ...reference }, profileId, navigationId: browser.navigationId, switchOutcome: 'confirmed', ...attempt }
}
export async function repairSurveyProfileAdmission(get: () => SurveyPageAdmissionState, receipt: SurveyProfileBindingReceipt): Promise<SurveyProfileBindingReceipt> {
  const attempt = await admitPreparedSurveyPage(get, receipt.reference, { mode: 'normal', profileId: receipt.profileId }, receipt.membership)
  return { ...receipt, ...attempt }
}
