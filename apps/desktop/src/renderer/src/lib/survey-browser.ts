import type { WorkspaceLayout } from '@agentmux/layout'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { workbenchSurfaces, type BrowserWorkbenchSurface, type WorkbenchTab } from './workbench-tabs'

/** Presentation only: the original Workbench owns every page and its lifecycle. */
export type SurveyBrowserSelection = { workspaceId: string; tabId: string; regionId: string }
export type SurveyBrowserPage = SurveyBrowserSelection & { surface: BrowserWorkbenchSurface }
type Tabs = Readonly<Record<string, WorkbenchTab>>

export function surveyBrowserSurface(tabs: Tabs, selection: SurveyBrowserSelection | null): BrowserWorkbenchSurface | null {
  if (!selection) return null
  const tab = tabs[selection.tabId]
  const surface = tab?.regions[selection.regionId]
  return tab?.workspaceId === selection.workspaceId && surface?.kind === 'browser' && surface.workspaceId === selection.workspaceId
    ? surface : null
}

export function surveyBrowserPages(tabs: Tabs, workspaces: readonly WorkspaceRecord[], layouts: Readonly<Record<string, WorkspaceLayout>>): SurveyBrowserPage[] {
  return workspaces.flatMap(({ id: workspaceId }) => {
    const tabIds = new Set(layouts[workspaceId]?.groups.flatMap(group => group.tabOrder) ?? [])
    return [...tabIds].flatMap(tabId => {
      const tab = tabs[tabId]
      return tab?.workspaceId === workspaceId ? workbenchSurfaces(tab).flatMap(surface => surface.kind === 'browser'
        ? [{ workspaceId, tabId, regionId: surface.regionId, surface }] : []) : []
    })
  })
}

export function sameSurveyBrowserSelection(a: SurveyBrowserSelection | null, b: SurveyBrowserSelection): boolean {
  return a?.workspaceId === b.workspaceId && a.tabId === b.tabId && a.regionId === b.regionId
}

/** Only an explicit topology result may retire a previously resolved reference. */
export function surveySelectionAfterClose(before: Tabs, after: Tabs, selection: SurveyBrowserSelection | null): SurveyBrowserSelection | null {
  return surveyBrowserSurface(before, selection) && !surveyBrowserSurface(after, selection) ? null : selection
}

export function restoredSurveyBrowserSelection(candidate: unknown): SurveyBrowserSelection | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  const { workspaceId, tabId, regionId } = candidate as Record<string, unknown>
  return typeof workspaceId === 'string' && workspaceId !== '' && typeof tabId === 'string' && tabId !== '' && typeof regionId === 'string' && regionId !== ''
    ? { workspaceId, tabId, regionId } : null
}

type CloseOwner = {
  tabs: Tabs
  layouts: Readonly<Record<string, WorkspaceLayout>>
  closeRegion(workspaceId: string, tabId: string, regionId: string): Promise<void>
  closeTab(workspaceId: string, tabGroupId: string, tabId: string): Promise<boolean>
}

/** Dispatch a precise page close through the existing Region/Tab close owners. */
export async function closeSurveyBrowserPage(selection: SurveyBrowserSelection, owner: () => CloseOwner): Promise<void> {
  const initial = owner()
  const surface = surveyBrowserSurface(initial.tabs, selection)
  if (!surface) throw new Error('The original page is still restoring. Retry after its owner is available.')
  if (Object.keys(initial.tabs[selection.tabId]!.regions).length > 1) {
    await initial.closeRegion(selection.workspaceId, selection.tabId, selection.regionId)
  } else {
    // A Tab may have several Group placements. Only the last original close releases its page.
    for (;;) {
      const current = owner()
      const live = surveyBrowserSurface(current.tabs, selection)
      if (!live) {
        if (current.tabs[selection.tabId]?.regions[selection.regionId]) {
          throw new Error('The page changed while closing. Its remaining work surface is kept; review it and close again.')
        }
        break
      }
      if (live.browserId !== surface.browserId || Object.keys(current.tabs[selection.tabId]!.regions).length !== 1) {
        throw new Error('The page changed while closing. Its remaining work surface is kept; review it and close again.')
      }
      const group = current.layouts[selection.workspaceId]?.groups.find(candidate => candidate.tabOrder.includes(selection.tabId))
      if (!group) throw new Error('The original page placement is still restoring. Review it in Space and retry.')
      if (!await current.closeTab(selection.workspaceId, group.id, selection.tabId)) {
        throw new Error('The page could not close. Its work surface is kept; retry here.')
      }
    }
  }
  if (surveyBrowserSurface(owner().tabs, selection)) throw new Error('The page is still present. Review it and close again.')
}
