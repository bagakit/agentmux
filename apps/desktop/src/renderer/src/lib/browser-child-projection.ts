import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentMuxBrowserSource } from '@agentmux/core'
import { addTabPlacement, groupIds, regionIds } from '@agentmux/layout'
import type { BrowserEvent } from '../../../shared/contracts'
import type { BrowserProjectionState } from './browser-state'
import { createWorkbenchTab, workbenchSurfaces } from './workbench-tabs'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from './workbench-projection'

export type BrowserSourceResolution =
  | { status: 'available'; location: WorkbenchProjectionSelection }
  | { status: 'ambiguous'; locations: WorkbenchProjectionSelection[] }
  | { status: 'unavailable'; locations: [] }

function orderedGroups(state: BrowserProjectionState) {
  return Object.keys(state.layouts).sort().filter(id => id.trim()).flatMap(displayWorkspaceId => {
    const layout = state.layouts[displayWorkspaceId]!
    return groupIds(layout.root).flatMap(groupId => {
      const group = groupId.trim() && layout.groups.find(candidate => candidate.id === groupId)
      return group ? [{ displayWorkspaceId, group }] : []
    })
  })
}

const workspaceIdentity = (id: string | null | undefined): string | undefined => id?.trim() ? id : undefined

// All Source controls share this disposable derivation of the immutable Store snapshots.
// It is not another placement owner: actions still resolve against the current snapshots.
const placementCache = new WeakMap<BrowserProjectionState['tabs'], WeakMap<BrowserProjectionState['layouts'], Map<string, WorkbenchProjectionSelection[]>>>()
function browserPlacements(state: BrowserProjectionState) {
  let layouts = placementCache.get(state.tabs)
  if (!layouts) { layouts = new WeakMap(); placementCache.set(state.tabs, layouts) }
  const cached = layouts.get(state.layouts)
  if (cached) return cached
  const index = new Map<string, WorkbenchProjectionSelection[]>()
  for (const { displayWorkspaceId, group } of orderedGroups(state)) {
    for (const tabId of group.tabOrder) {
      const tab = state.tabs[tabId]
      if (!tab) continue
      for (const regionId of regionIds(tab.layout.root)) {
        const surface = tab.regions[regionId]
        if (surface?.kind !== 'browser') continue
        const locations = index.get(surface.browserId) ?? []
        locations.push({ displayWorkspaceId, groupId: group.id, tabId, regionId: surface.regionId })
        index.set(surface.browserId, locations)
      }
    }
  }
  layouts.set(state.layouts, index)
  return index
}

/** Resolve the original Browser object against actual current placements, never human focus. */
export function resolveBrowserSource(state: BrowserProjectionState, source: AgentMuxBrowserSource): BrowserSourceResolution {
  const original = source.location
  if (original) {
    const tab = state.tabs[original.tabId], surface = tab?.regions[original.regionId]
    const layout = state.layouts[original.displayWorkspaceId]
    const group = layout?.groups.find(group => group.id === original.groupId)
    if (surface?.kind === 'browser' && surface.browserId === source.browserId && group?.tabOrder.includes(original.tabId) &&
      groupIds(layout!.root).includes(original.groupId) && regionIds(tab!.layout.root).includes(original.regionId)) return { status: 'available', location: original }
  }
  const locations = browserPlacements(state).get(source.browserId) ?? []
  const exact = original && locations.find(location => sameWorkbenchProjectionSelection(location, original))
  if (exact) return { status: 'available', location: exact }
  // Moving the original Region preserves its identity even if this Browser has other displays.
  const sameRegion = original ? locations.filter(location => location.regionId === original.regionId) : []
  if (sameRegion.length === 1) return { status: 'available', location: sameRegion[0]! }
  if (locations.length === 1) return { status: 'available', location: locations[0]! }
  return locations.length ? { status: 'ambiguous', locations } : { status: 'unavailable', locations: [] }
}

/** A selector retains only the derived answer; every action still resolves current facts. */
export function createBrowserSourceSelector(source: AgentMuxBrowserSource) {
  let previous: BrowserSourceResolution | undefined
  let tabs: BrowserProjectionState['tabs'] | undefined, layouts: BrowserProjectionState['layouts'] | undefined
  return (state: BrowserProjectionState): BrowserSourceResolution => {
    if (previous && tabs === state.tabs && layouts === state.layouts) return previous
    const next = resolveBrowserSource(state, source)
    tabs = state.tabs; layouts = state.layouts
    const locations = (value: BrowserSourceResolution) => value.status === 'available' ? [value.location] : value.locations
    const before = previous && locations(previous), after = locations(next)
    if (previous?.status === next.status && before?.length === after.length &&
      before.every((location, index) => sameWorkbenchProjectionSelection(location, after[index]!))) return previous
    previous = next
    return next
  }
}

/** Pending pages only await a legal layout/Workspace binding, never page activity. */
export function nativeBrowserContainerChanged(state: BrowserProjectionState, previous: BrowserProjectionState): boolean {
  if (state.layouts !== previous.layouts) return true
  if (state.tabs === previous.tabs) return false
  return Object.values(state.layouts).some(layout => layout.groups.some(group => group.tabOrder.some(tabId => {
    const tab = state.tabs[tabId], before = previous.tabs[tabId]
    if (tab?.workspaceId !== before?.workspaceId) return true
    if (tab === before || !tab) return false
    if (tab.layout.root !== before?.layout.root) return true
    return regionIds(tab.layout.root).some(regionId => {
      const surface = tab.regions[regionId], prior = before?.regions[regionId]
      return surface?.workspaceId !== prior?.workspaceId ||
        (surface?.kind === 'browser' ? surface.browserId : null) !== (prior?.kind === 'browser' ? prior.browserId : null)
    })
  })))
}

export function projectNativeBrowserOpening(state: BrowserProjectionState, event: Extract<BrowserEvent, { type: 'native-opened' }>):
  { state: BrowserProjectionState; target: WorkbenchProjectionSelection | null; issue: string | null } {
  // A repeated original event must never create another display or another native window.
  if (Object.values(state.tabs).some(tab => workbenchSurfaces(tab).some(surface => surface.kind === 'browser' && surface.browserId === event.browser.id))) {
    return { state, target: null, issue: null }
  }
  const source = event.browser.source
  const resolution = source ? resolveBrowserSource(state, source) : null
  const locations = resolution?.status === 'available' ? [resolution.location] : resolution?.locations ?? []
  const sourceWorkspaceId = locations.map(location => workspaceIdentity(state.tabs[location.tabId]?.regions[location.regionId]?.workspaceId)).find(Boolean)
  const eventWorkspaceId = workspaceIdentity(event.workspaceId)
  const groups = orderedGroups(state)
  // A container choice is client layout policy, never evidence of the triggering occurrence.
  // In particular, an unknown source must not hide an already healthy native child.
  const preferred = [
    ...(resolution?.status === 'available' ? [resolution.location] : []),
    ...(source?.location ? [source.location] : []),
    ...locations,
    ...groups.filter(({ group }) => eventWorkspaceId && group.tabOrder.some(tabId => {
      const tab = state.tabs[tabId]
      return tab && workbenchSurfaces(tab).some(surface => surface.workspaceId === eventWorkspaceId)
    })).map(({ displayWorkspaceId, group }) => ({ displayWorkspaceId, groupId: group.id })),
    ...groups.map(({ displayWorkspaceId, group }) => ({ displayWorkspaceId, groupId: group.id }))
  ]
  for (const origin of preferred) {
    const container = groups.find(({ displayWorkspaceId, group }) => displayWorkspaceId === origin.displayWorkspaceId && group.id === origin.groupId)
    if (!container) continue
    const tabs = container.group.tabOrder.flatMap(tabId => state.tabs[tabId] ? [state.tabs[tabId]!] : [])
    const sourceTab = 'tabId' in origin ? tabs.find(tab => tab.id === origin.tabId) : undefined
    const workspaceId = eventWorkspaceId ?? sourceWorkspaceId ?? workspaceIdentity(sourceTab?.workspaceId)
      ?? tabs.map(tab => workspaceIdentity(tab.workspaceId)).find(Boolean)
    if (!workspaceId) continue
    const context = sourceTab ?? tabs.find(tab => workbenchSurfaces(tab).some(surface => surface.workspaceId === workspaceId))
    const tabId = mintObjectId(), regionId = event.browser.id
    const tab = { ...createWorkbenchTab(tabId, { ...event.browser, kind: 'browser', browserId: event.browser.id, workspaceId, regionId }),
      ...(context?.space ? { space: { ...context.space } } : {}), ...(context?.topicId ? { topicId: context.topicId } : {}) }
    const layout = state.layouts[origin.displayWorkspaceId]!
    const placed = addTabPlacement(layout, origin.groupId, tabId)
    if (!placed) continue
    // A website's child creation does not authorize changing the person's main workface selection.
    const preserved = { ...placed, activeGroupId: layout.activeGroupId, groups: placed.groups.map(group => {
      const previous = layout.groups.find(candidate => candidate.id === group.id)
      return previous ? { ...group, activeTabId: previous.activeTabId, recentTabIds: previous.recentTabIds } : group
    }) }
    return { state: { tabs: { ...state.tabs, [tabId]: tab }, layouts: { ...state.layouts, [origin.displayWorkspaceId]: preserved } },
      target: { displayWorkspaceId: origin.displayWorkspaceId, groupId: origin.groupId, tabId, regionId }, issue: null }
  }
  return { state, target: null,
    issue: `Browser ${event.browser.id} is open and available to Agents. No existing workspace Group has a usable workspace binding. Restore a workspace layout to show the same page automatically; the original link has not been opened again.` }
}
