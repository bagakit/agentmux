import type { BrowserEvent } from '../../../shared/contracts'
import { browserViewportsEqual } from '../../../shared/browser-viewport'
import type { WorkspaceLayout } from '@agentmux/layout'
import {
  removeTabsFromLayouts,
  removeWorkbenchRegion,
  workbenchSurfaces,
  type BrowserWorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'

export type BrowserProjectionState = {
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
}

/** Keep native lifecycle boundaries in order while coalescing only their own snapshot segment. */
export function createBrowserProjectionEventQueue() {
  let events: BrowserEvent[] = []
  const updates = new Map<string, number>()
  return {
    push(event: BrowserEvent): void {
      const id = event.type === 'updated' || event.type === 'native-opened' ? event.browser.id : event.id
      if (event.type === 'updated') {
        const previous = updates.get(id)
        if (previous !== undefined) { events[previous] = event; return }
        updates.set(id, events.length)
      } else updates.delete(id)
      events.push(event)
    },
    drain(): BrowserEvent[] {
      const retained = events
      events = []; updates.clear()
      return retained
    }
  }
}

export function reduceBrowserEvent(
  state: BrowserProjectionState,
  event: BrowserEvent,
  expectedNavigationId?: string
): BrowserProjectionState {
  // Native creation is projected by the Store before ordinary Browser updates.
  if (event.type === 'native-opened') return state
  if (event.type === 'released') {
    let tabs = state.tabs
    for (const tab of Object.values(state.tabs)) {
      const affected = workbenchSurfaces(tab).filter((surface): surface is BrowserWorkbenchSurface =>
        surface.kind === 'browser' && surface.browserId === event.id && surface.navigationId === event.navigationId)
      if (!affected.length) continue
      const regions = { ...tab.regions }
      for (const surface of affected) regions[surface.regionId] = { ...surface, loading: false, nativeOwnerReleased: true }
      tabs = { ...tabs, [tab.id]: { ...tab, regions } }
    }
    return tabs === state.tabs ? state : { ...state, tabs }
  }
  if (event.type === 'unavailable') {
    let tabs = state.tabs
    for (const tab of Object.values(state.tabs)) {
      const affected = workbenchSurfaces(tab).filter((surface): surface is BrowserWorkbenchSurface => surface.kind === 'browser' && surface.browserId === event.id)
      if (affected.length === 0) continue
      const regions = { ...tab.regions }
      for (const surface of affected) regions[surface.regionId] = { ...surface, loading: false, error: event.error, nativeOwnerUnavailable: true }
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
        if (expectedNavigationId !== undefined && surface.navigationId !== expectedNavigationId) continue
        if (!surface.nativeOwnerUnavailable && !surface.nativeOwnerDeferred && !surface.nativeOwnerReleased && Object.entries(event.browser).every(([key, value]) => key === 'viewport'
          ? browserViewportsEqual(surface.viewport, event.browser.viewport)
          : Object.is(surface[key as keyof BrowserWorkbenchSurface], value))) continue
        if (regions === tab.regions) regions = { ...regions }
        const { nativeOwnerUnavailable: _unavailable, nativeOwnerDeferred: _deferred, nativeOwnerReleased: _released, restoredViewportUnknown: _unknownViewport, privateSessionEnded, ...availableSurface } = surface
        regions[surface.regionId] = { ...availableSurface, ...event.browser, regionId: surface.regionId,
          ...(privateSessionEnded && event.browser.mode === 'private' && event.browser.url === 'about:blank' ? { privateSessionEnded } : {}) }
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
      layouts = removeTabsFromLayouts(layouts, [tab.id])
    }
  }
  if (!changed) return state
  return {
    tabs,
    layouts
  }
}
