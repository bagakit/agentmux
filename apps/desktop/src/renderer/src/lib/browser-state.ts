import type { BrowserEvent } from '../../../shared/contracts'
import { removeTab, type WorkspaceLayout } from '@agentmux/layout'
import {
  tabGroupForTab,
  removeWorkbenchRegion,
  workbenchSurfaces,
  type WorkbenchTab
} from './workbench-tabs'

export type BrowserProjectionState = {
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
}

export function reduceBrowserEvent(
  state: BrowserProjectionState,
  event: BrowserEvent
): BrowserProjectionState {
  if (event.type === 'updated') {
    return {
      ...state,
      tabs: Object.fromEntries(Object.entries(state.tabs).map(([id, tab]) => [
        id,
        {
          ...tab,
          regions: Object.fromEntries(Object.entries(tab.regions).map(([regionId, surface]) => [
            regionId,
            surface.kind === 'browser' && surface.browserId === event.browser.id
              ? { ...surface, ...event.browser, regionId: surface.regionId }
              : surface
          ]))
        }
      ]))
    }
  }
  let changed = false
  const tabs = { ...state.tabs }
  let layouts = state.layouts
  for (const tab of Object.values(state.tabs)) {
    const regionIds = workbenchSurfaces(tab).flatMap((surface) => (
      surface.kind === 'browser' && surface.browserId === event.id ? [surface.regionId] : []
    ))
    for (const regionId of regionIds) {
      changed = true
      const currentTab = tabs[tab.id]
      if (!currentTab) continue
      const nextTab = removeWorkbenchRegion(currentTab, regionId)
      if (nextTab) {
        tabs[tab.id] = nextTab
        continue
      }
      delete tabs[tab.id]
      const layout = layouts[tab.workspaceId]
      const groupId = tabGroupForTab(layout, tab.id)
      if (layout && groupId) {
        layouts = { ...layouts, [tab.workspaceId]: removeTab(layout, groupId, tab.id) }
      }
    }
  }
  if (!changed) return state
  return {
    tabs,
    layouts
  }
}
