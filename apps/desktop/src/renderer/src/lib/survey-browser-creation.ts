import type { AgentMuxSurveyPageAdmission, AgentMuxZoneFact } from '@agentmux/core/control'
import type { AppState } from '../store'
import type { BrowserSnapshot } from '../../../shared/contracts'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import type { WorkbenchSurface } from './workbench-tabs'
import { admitPreparedSurveyPage, type SurveyMembershipGeneration } from './survey-profile-binding'

/** Capabilities of one page preparation, not the whole application controller. */
export type SurveyBrowserCreationState = Pick<AppState,
  'config' | 'layouts' | 'tabs' | 'surveyPageReferences' | 'setSurveyZoneCollected' |
  'openLauncher' | 'createBrowser' | 'registerSurveyBrowserPage' | 'setSurveyPageCollected'>
export type SurveyBrowserCreationPorts = {
  get(): SurveyBrowserCreationState
  prepareZone(workspaceId: string): AgentMuxZoneFact
  checkpointPreparation(): Promise<void>
}

/** One exact creation freezes its environment, address and display-membership intent. */
export type SurveyBrowserPreparation = {
  zone: AgentMuxZoneFact
  mode: import('@agentmux/core').AgentMuxBrowserMode
  profileId?: string
  url: string
  entry: 'page' | 'research'
  membership: SurveyMembershipGeneration
  createdBrowser?: Pick<BrowserSnapshot, 'id' | 'profileId' | 'mode' | 'navigationId'>
  researchCollected?: boolean
  admission?: AgentMuxSurveyPageAdmission
  reference: WorkbenchProjectionSelection | null
  surface: WorkbenchSurface | null
}
export async function createSurveyBrowser({ get, prepareZone, checkpointPreparation }: SurveyBrowserCreationPorts, input: {
  workspaceId: string
  url: string
  profileId?: string
  entry?: 'page' | 'research'
  mode?: import('@agentmux/core').AgentMuxBrowserMode
  preparation: SurveyBrowserPreparation | null
  onPrepared(preparation: SurveyBrowserPreparation): void
}): Promise<SurveyBrowserPreparation & { reference: WorkbenchProjectionSelection; admission?: AgentMuxSurveyPageAdmission }> {
  const before = get(), layout = before.layouts[input.workspaceId]
  if (!before.config?.workspaces.some(workspace => workspace.id === input.workspaceId) || !layout?.activeGroupId) {
    throw new Error('The browser resource is still restoring. Your input and existing pages are kept; retry here.')
  }
  let preparation = input.preparation
  if (preparation && preparation.zone.workspaceId !== input.workspaceId) throw new Error('The original creation belongs to another resource. Recover that same page before starting another here.')
  if (!preparation) {
    // Freeze the original input before preparing its position, including explicit default.
    const mode = input.mode ?? 'normal', profileId = mode === 'private' ? undefined : input.profileId
    const url = input.url, entry = input.entry ?? 'page', membership = before.surveyPageReferences
    // Preparation does not start the generic Zone factory's unrelated save work.
    // The original position owner confirms this Zone and its Launcher below.
    const zone = prepareZone(input.workspaceId)
    preparation = { zone, mode, ...(profileId === undefined ? {} : { profileId }), url, entry, membership, reference: null, surface: null }
    input.onPrepared(preparation)
  }
  if (preparation.entry === 'research' && !preparation.researchCollected) {
    if (!get().setSurveyZoneCollected(preparation.zone.zoneId, true)) throw new Error('The original research creation is kept, but its resource is not confirmed. Retry this same page.')
    preparation.researchCollected = true
  }
  if (!preparation.reference) {
    const tabId = get().openLauncher({ workspaceId: input.workspaceId, zoneId: preparation.zone.zoneId, tabGroupId: layout.activeGroupId, reveal: false })
    const launcher = tabId ? get().tabs[tabId] : undefined
    if (!launcher) throw new Error('The original resource Group is still restoring. This Zone is kept; retry here.')
    preparation.reference = { displayWorkspaceId: input.workspaceId, groupId: layout.activeGroupId, tabId: launcher.id, regionId: launcher.layout.activeRegionId }
    preparation.surface = launcher.regions[preparation.reference.regionId]!
    input.onPrepared(preparation)
  }
  // Confirm the original Zone, Tab, Region and display before sending Native
  // creation. A fast frame never trades away the durable preparation identity.
  await checkpointPreparation()
  const reference = preparation.reference, tab = get().tabs[reference.tabId], surface = tab?.regions[reference.regionId]
  const attached = surface?.kind === 'browser' && preparation.createdBrowser?.id === surface.browserId && tab?.space?.zoneId === preparation.zone.zoneId
  if (surface?.kind === 'browser' && !attached) {
    throw new Error('Another Browser now occupies this original preparation. Both identities are kept; this retry cannot adopt or replace it.')
  }
  if (!attached) {
    if (!tab || Object.keys(tab.regions).length !== 1 || surface !== preparation.surface || preparation.surface?.kind !== 'launcher') {
      throw new Error('The original preparation is unavailable or has changed. Its content and exact reference are kept; review it before retrying.')
    }
    await get().createBrowser(reference.groupId, { tabId: reference.tabId, regionId: reference.regionId }, preparation.url,
      undefined, input.workspaceId, reference.displayWorkspaceId, preparation.mode, undefined, preparation.profileId, {
        onCreated(browser) {
          // Freeze only the original Main receipt, never a later Region occupant.
          if (!preparation!.createdBrowser) preparation!.createdBrowser = { id: browser.id, mode: browser.mode,
            profileId: browser.profileId, navigationId: browser.navigationId }
          input.onPrepared(preparation!)
        }
      })
  }
  const confirmed = get().tabs[reference.tabId]?.regions[reference.regionId]
  if (confirmed?.kind !== 'browser' || !preparation.createdBrowser || confirmed.browserId !== preparation.createdBrowser.id) throw new Error('The original Browser owner has not confirmed attachment. Recover this same page.')
  const expectedProfile = preparation.profileId
  if (preparation.createdBrowser.mode !== preparation.mode || expectedProfile !== undefined && preparation.createdBrowser.profileId !== expectedProfile) {
    throw new Error('The attached original page did not confirm the frozen environment. It is kept; inspect this same Browser before another action.')
  }
  input.onPrepared(preparation)
  if (preparation.entry !== 'research') {
    // This freshly minted page has never been admitted. Another independent
    // page's completed registration is not a withdrawal of this exact original.
    // Retry keeps its frozen generation so a later explicit removal stays removed.
    if (!preparation.admission) preparation.membership = get().surveyPageReferences
    const attempt = await admitPreparedSurveyPage(get, { regionId: reference.regionId, browserId: preparation.createdBrowser.id }, preparation.createdBrowser, preparation.membership)
    preparation.admission = attempt.admission
    preparation.membership = attempt.membership
    input.onPrepared(preparation)
  }
  return { ...preparation, reference }
}
