import { presentKnowledgeSurface } from './knowledge-surface-navigation'
import { formatAmuxObjectLink } from '@agentmux/core/sharing'
import type { AppState } from '../store'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import type { SystemPageOutcome } from '../../../shared/system-web-url'
import type { SurveyBrowserPreparation } from './survey-browser-creation'
import { browserProfiles } from './browser-profiles'
import { surveyPageReuseCandidates } from './survey-page-navigation'
import { isSurveyPage } from './survey-page-references'
import { samePage } from './survey-list'

export type SystemPageState = Pick<AppState,
  'config' | 'tabs' | 'layouts' | 'surveyPageReferences' | 'createSurveyBrowser' | 'surveyProfileView' |
  'setSurveyProfileView' | 'surveyZoneSelection' | 'setSurveyZoneSelection' | 'setMainSurface'>
export type SystemPageHost = { get(): SystemPageState; navigation(): string; subscribe(listener: () => void): () => void }
// Presentation priority only; requests, resource creation and saving keep their original owners.
const latestPresentation = new WeakMap<SystemPageHost['get'], object>()

/** Both exact native inputs use the original Survey preparation and Core spatial owner. */
export async function openSystemPageInSurvey(host: SystemPageHost, request: { url: string }, signal: AbortSignal): Promise<SystemPageOutcome> {
  if (signal.aborted) throw new Error('System page opening was not started because its original request is no longer available.')
  const get = host.get
  const presentation = {}
  latestPresentation.set(get, presentation)
  let navigation = host.navigation(), presenting = false
  let surveySelection = get().surveyZoneSelection, profile = get().surveyProfileView
  const current = () => host.navigation() === navigation && get().surveyZoneSelection === surveySelection && get().surveyProfileView === profile
  let navigationChanged = false
  let focus: Promise<boolean> | undefined
  const unsubscribe = host.subscribe(() => { if (!presenting && !current()) navigationChanged = true })
  let preparation: SurveyBrowserPreparation | null = null
  const present = (choose: () => void) => {
    if (signal.aborted || latestPresentation.get(get) !== presentation || navigationChanged || !current()) return
    presenting = true
    try {
      choose()
      focus ??= presentKnowledgeSurface('survey', get().setMainSurface, { inputPolicy: 'target' })
      navigation = host.navigation(); surveySelection = get().surveyZoneSelection; profile = get().surveyProfileView
    } finally { presenting = false }
  }
  const reveal = (prepared: SurveyBrowserPreparation): void => {
    if (!prepared.reference || prepared.admission?.outcome === 'unknown') return
    const { tabId, regionId } = prepared.reference
    const browser = get().tabs[tabId]?.regions[regionId]
    const page = browser?.kind === 'browser' && prepared.createdBrowser?.id === browser.browserId
    const launcher = browser?.kind === 'launcher' && browser === prepared.surface
    if (!page && !launcher) return
    present(() => get().setSurveyZoneSelection(page ? { kind: 'page', regionId, browserId: browser.browserId }
      : { zoneId: prepared.zone.zoneId, selection: [{ tabId, regionId }], active: { tabId, regionId } }))
  }
  try {
    const hasMatch = surveyPageReuseCandidates(get(), request.url).length > 0
    // The default can change while no Renderer observes Profile pushes. Only a
    // possible reuse needs a fresh default observation before choosing its page.
    if (hasMatch) await browserProfiles.refresh()
    if (signal.aborted) return { state: 'unconfirmed', browserId: null, reference: null, message: 'The original system request is no longer available.' }
    const profiles = browserProfiles.get()
    const defaultProfileId = !profiles.error ? profiles.profiles?.find(item => item.isDefault)?.id : undefined
    const reusable = hasMatch && defaultProfileId && surveyPageReuseCandidates(get(), request.url).find(candidate => candidate.profileId === defaultProfileId)
    if (reusable) {
      const { page, reference } = reusable
      let saveView: Promise<string | null> | undefined
      present(() => {
        const state = get()
        if (state.surveyProfileView.kind === 'profile' && state.surveyProfileView.profileId !== defaultProfileId)
          saveView = state.setSurveyProfileView({ kind: 'default' }).then(save => save.reason, () => 'Saving the original environment view was unconfirmed.')
        const selected = get().surveyZoneSelection
        if (!isSurveyPage(selected) || !samePage(selected, page)) state.setSurveyZoneSelection({ kind: 'page', ...page })
      })
      if (focus && !await focus) return { state: 'unconfirmed', browserId: page.browserId, reference, message: 'The existing page is available. Bringing its Survey window forward was unconfirmed.' }
      const issue = await saveView
      if (issue) return { state: 'unconfirmed', browserId: page.browserId, reference, message: issue }
      return { state: 'opened', browserId: page.browserId, reference }
    }
    const prepared = await get().createSurveyBrowser({ workspaceId: SCRATCH_WORKSPACE_ID, url: request.url, preparation: null, onPrepared(value) { preparation = value; reveal(value) } })
    const browser = get().tabs[prepared.reference.tabId]?.regions[prepared.reference.regionId]
    if (browser?.kind !== 'browser') throw new Error('The original Survey Browser attachment is unconfirmed.')
    reveal(prepared)
    if (focus && !await focus) return { state: 'unconfirmed', browserId: browser.browserId, reference: prepared.reference,
      message: 'The original page is available in Survey. Bringing its window forward was unconfirmed. Show the Survey window to view the page.' }
    if (prepared.admission?.issues.length) return { state: 'unconfirmed', browserId: browser.browserId, reference: prepared.reference, message: 'The page is available. ' + prepared.admission.issues.map(issue => issue.message).join(' ') }
    return { state: 'opened', browserId: browser.browserId, reference: prepared.reference }
  } catch (error) {
    const prepared = preparation as SurveyBrowserPreparation | null
    if (prepared) reveal(prepared)
    const reference = prepared?.reference ?? null, browser = reference ? get().tabs[reference.tabId]?.regions[reference.regionId] : null
    return { state: 'unconfirmed', browserId: browser?.kind === 'browser' ? browser.browserId : null, reference,
      message: `System page opening is unconfirmed. ${error instanceof Error ? error.message : String(error)} ${prepared ? `Original Survey item: ${formatAmuxObjectLink({ kind: 'zone', zoneId: prepared.zone.zoneId })}. ` : ''}The prepared Survey item is kept; inspect it and retry from its original page. Other pages, drafts and healthy Agents are kept.` }
  } finally { unsubscribe(); if (latestPresentation.get(get) === presentation) latestPresentation.delete(get) }
}
