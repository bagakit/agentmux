import type { AgentMuxZoneFact } from '@agentmux/core/control'
import type { useAppStore } from '../store'

import type { WorkbenchProjectionSelection } from './workbench-projection'
import type { WorkbenchSurface } from './workbench-tabs'

type AppState = ReturnType<typeof useAppStore.getState>

/** A caller retains the exact unfinished creation, never a second entity registry. */
export type SurveyBrowserPreparation = {
  zone: AgentMuxZoneFact
  reference: WorkbenchProjectionSelection | null
  surface: WorkbenchSurface | null
}

export async function createSurveyBrowser(get: () => AppState, input: {
  workspaceId: string
  url: string
  preparation: SurveyBrowserPreparation | null
  onPrepared(preparation: SurveyBrowserPreparation): void
}): Promise<SurveyBrowserPreparation & { reference: WorkbenchProjectionSelection }> {
  const before = get(), layout = before.layouts[input.workspaceId]
  if (!before.config?.workspaces.some(workspace => workspace.id === input.workspaceId) || !layout?.activeGroupId) {
    throw new Error('The browser resource is still restoring. Your input and existing pages are kept; retry here.')
  }
  let preparation = input.preparation
  if (preparation && preparation.zone.workspaceId !== input.workspaceId) throw new Error('The original creation belongs to another resource. Recover that same page before starting another here.')
  if (!preparation) {
    const created = await before.createWorkbenchZone({ workspaceId: input.workspaceId, spaceIds: [] })
    preparation = { zone: created.zone, reference: null, surface: null }
    input.onPrepared(preparation)
  }
  if (!get().setSurveyZoneCollected(preparation.zone.zoneId, true)) throw new Error('The original creation is kept, but its resource is not confirmed. Retry this same page.')
  if (!preparation.reference) {
    const tabId = get().openLauncher({ workspaceId: input.workspaceId, zoneId: preparation.zone.zoneId, tabGroupId: layout.activeGroupId, reveal: false })
    const launcher = tabId ? get().tabs[tabId] : undefined
    if (!launcher) throw new Error('The original resource Group is still restoring. This Zone is kept; retry here.')
    preparation.reference = { displayWorkspaceId: input.workspaceId, groupId: layout.activeGroupId, tabId: launcher.id, regionId: launcher.layout.activeRegionId }
    preparation.surface = launcher.regions[preparation.reference.regionId]!
  }
  const reference = preparation.reference, tab = get().tabs[reference.tabId], surface = tab?.regions[reference.regionId]
  const attached = surface?.kind === 'browser' && surface.browserId === reference.regionId && tab?.space?.zoneId === preparation.zone.zoneId
  if (!attached) {
    if (!tab || Object.keys(tab.regions).length !== 1 || surface !== preparation.surface || preparation.surface?.kind !== 'launcher') {
      throw new Error('The original preparation is unavailable or has changed. Its content and exact reference are kept; review it before retrying.')
    }
    await get().createBrowser(reference.groupId, { tabId: reference.tabId, regionId: reference.regionId }, input.url, undefined, input.workspaceId)
  }
  const confirmed = get().tabs[reference.tabId]?.regions[reference.regionId]
  if (confirmed?.kind !== 'browser' || confirmed.browserId !== reference.regionId) throw new Error('The original Browser owner has not confirmed attachment. Recover this same page.')
  return { ...preparation, reference }
}
