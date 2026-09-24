import type { BrowserEvent } from '../../../shared/contracts'
import { removeTab, type WorkspaceLayout } from '@agentmux/layout'
import {
  tabGroupForTab,
  removeWorkbenchRegion,
  workbenchSurfaces,
  type BrowserWorkbenchSurface,
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
  if (event.type === 'unavailable') {
    let tabs = state.tabs
    for (const tab of Object.values(state.tabs)) {
      const affected = workbenchSurfaces(tab).filter((surface): surface is BrowserWorkbenchSurface => surface.kind === 'browser' && surface.browserId === event.id)
      if (affected.length === 0) continue
      const regions = { ...tab.regions }
      for (const surface of affected) regions[surface.regionId] = { ...surface, loading: false, error: event.error }
      tabs = { ...tabs, [tab.id]: { ...tab, regions } }
    }
    return tabs === state.tabs ? state : { ...state, tabs }
  }
  if (event.type === 'updated') {
    let tabs = state.tabs
    for (const [tabId, tab] of Object.entries(state.tabs)) {
      let regions = tab.regions
      for (const surface of Object.values(tab.regions)) {
        if (surface.kind !== 'browser' || surface.browserId !== event.browser.id) continue
        if (Object.entries(event.browser).every(([key, value]) => Object.is(surface[key as keyof BrowserWorkbenchSurface], value))) continue
        if (regions === tab.regions) regions = { ...regions }
        regions[surface.regionId] = { ...surface, ...event.browser, regionId: surface.regionId }
      }
      if (regions === tab.regions) continue
      if (tabs === state.tabs) tabs = { ...tabs }
      tabs[tabId] = { ...tab, regions }
    }
    return tabs === state.tabs ? state : { ...state, tabs }
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
