import { formatAmuxObjectLink } from '@agentmux/core'
import type { useAppStore } from '../store'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { isSystemWebUrl, type SystemWebUrlRequest, type SystemWebUrlResult } from '../../../shared/system-web-url'
import type { SurveyBrowserPreparation } from './survey-browser-creation'

type AppState = ReturnType<typeof useAppStore.getState>

/** A system navigation uses the same preparation and Core spatial owner as a new Survey page. */
export async function openSystemUrlInSurvey(host: { get(): AppState; navigation(): string; subscribe(listener: () => void): () => void }, request: SystemWebUrlRequest, signal: AbortSignal): Promise<SystemWebUrlResult> {
  if (!isSystemWebUrl(request.url)) throw new Error('The system link is not a valid HTTP(S) URL. Your current workface is kept.')
  if (signal.aborted) throw new Error('System page opening was not started because its original request is no longer available.')
  const get = host.get, navigation = host.navigation()
  let navigationChanged = false
  const unsubscribe = host.subscribe(() => { if (host.navigation() !== navigation) navigationChanged = true })
  let preparation: SurveyBrowserPreparation | null = null
  const reveal = (prepared: SurveyBrowserPreparation): void => {
    if (signal.aborted || !prepared.reference || navigationChanged || host.navigation() !== navigation) return
    get().setSurveyZoneSelection({ zoneId: prepared.zone.zoneId, selection: [prepared.reference], active: prepared.reference })
    get().setMainSurface('survey')
  }
  try {
    const prepared = await get().createSurveyBrowser({ workspaceId: SCRATCH_WORKSPACE_ID, url: request.url, preparation: null, onPrepared(value) { preparation = value } })
    const browser = get().tabs[prepared.reference.tabId]?.regions[prepared.reference.regionId]
    if (browser?.kind !== 'browser') throw new Error('The original Survey Browser attachment is unconfirmed.')
    reveal(prepared)
    return { operation: request.operation, requestId: request.requestId, state: 'opened', browserId: browser.browserId, reference: prepared.reference }
  } catch (error) {
    const prepared = preparation as SurveyBrowserPreparation | null
    if (prepared) reveal(prepared)
    const reference = prepared?.reference ?? null, browser = reference ? get().tabs[reference.tabId]?.regions[reference.regionId] : null
    return { operation: request.operation, requestId: request.requestId, state: 'unconfirmed', browserId: browser?.kind === 'browser' ? browser.browserId : null, reference,
      message: `System page opening is unconfirmed. ${error instanceof Error ? error.message : String(error)} ${prepared ? `Original Survey item: ${formatAmuxObjectLink({ kind: 'zone', zoneId: prepared.zone.zoneId })}. ` : ''}The prepared Survey item is kept; inspect it and retry from its original page. Other pages, drafts and healthy Agents are kept.` }
  } finally { unsubscribe() }
}
