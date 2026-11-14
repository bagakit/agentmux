import { formatAmuxObjectLink } from '@agentmux/core/sharing'
import type { AppState } from '../store'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import type { SystemPageOutcome } from '../../../shared/system-web-url'
import type { SurveyBrowserPreparation } from './survey-browser-creation'

export type SystemPageHost = { get(): AppState; navigation(): string; subscribe(listener: () => void): () => void }

/** Both exact native inputs use the original Survey preparation and Core spatial owner. */
export async function openSystemPageInSurvey(host: SystemPageHost, request: { url: string }, signal: AbortSignal): Promise<SystemPageOutcome> {
  if (signal.aborted) throw new Error('System page opening was not started because its original request is no longer available.')
  const get = host.get, navigation = host.navigation()
  let navigationChanged = false
  const unsubscribe = host.subscribe(() => { if (host.navigation() !== navigation) navigationChanged = true })
  let preparation: SurveyBrowserPreparation | null = null
  const reveal = (prepared: SurveyBrowserPreparation): void => {
    if (signal.aborted || !prepared.reference || navigationChanged || host.navigation() !== navigation) return
    const browser = get().tabs[prepared.reference.tabId]?.regions[prepared.reference.regionId]
    if (browser?.kind !== 'browser' || prepared.createdBrowser?.id !== browser.browserId || prepared.admission?.outcome === 'unknown') return
    get().setSurveyZoneSelection({ kind: 'page', regionId: prepared.reference.regionId, browserId: browser.browserId })
    get().setMainSurface('survey')
  }
  try {
    const prepared = await get().createSurveyBrowser({ workspaceId: SCRATCH_WORKSPACE_ID, url: request.url, preparation: null, onPrepared(value) { preparation = value } })
    const browser = get().tabs[prepared.reference.tabId]?.regions[prepared.reference.regionId]
    if (browser?.kind !== 'browser') throw new Error('The original Survey Browser attachment is unconfirmed.')
    reveal(prepared)
    if (prepared.admission?.issues.length) return { state: 'unconfirmed', browserId: browser.browserId, reference: prepared.reference, message: 'The page is available. ' + prepared.admission.issues.map(issue => issue.message).join(' ') }
    return { state: 'opened', browserId: browser.browserId, reference: prepared.reference }
  } catch (error) {
    const prepared = preparation as SurveyBrowserPreparation | null
    if (prepared) reveal(prepared)
    const reference = prepared?.reference ?? null, browser = reference ? get().tabs[reference.tabId]?.regions[reference.regionId] : null
    return { state: 'unconfirmed', browserId: browser?.kind === 'browser' ? browser.browserId : null, reference,
      message: `System page opening is unconfirmed. ${error instanceof Error ? error.message : String(error)} ${prepared ? `Original Survey item: ${formatAmuxObjectLink({ kind: 'zone', zoneId: prepared.zone.zoneId })}. ` : ''}The prepared Survey item is kept; inspect it and retry from its original page. Other pages, drafts and healthy Agents are kept.` }
  } finally { unsubscribe() }
}
