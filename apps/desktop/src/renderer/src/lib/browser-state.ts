import type { BrowserEvent } from '../../../shared/contracts'
import type { WorkspaceLayout } from './workbench-layout'
import {
  removeTabsFromLayouts,
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
        tab.kind === 'browser' && tab.browserId === event.browser.id
          ? { ...tab, ...event.browser, id: tab.id }
          : tab
      ]))
    }
  }
  const removedIds = Object.values(state.tabs).flatMap((tab) =>
    tab.kind === 'browser' && tab.browserId === event.id ? [tab.id] : []
  )
  if (removedIds.length === 0) return state
  const tabs = { ...state.tabs }
  for (const tabId of removedIds) delete tabs[tabId]
  return {
    tabs,
    layouts: removeTabsFromLayouts(state.layouts, removedIds)
  }
}
