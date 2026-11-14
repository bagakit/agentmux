// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { surveyPageOwner, surveyPageProjection } from '../src/renderer/src/lib/survey-page-references'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { config } from './helpers/workface-control-fixture'
const initial = useAppStore.getState(), page = { regionId: 'original-page-region', browserId: 'separate-Main-browser' }
afterEach(() => useAppStore.setState(initial, true))
function fixture() {
  const tab = createWorkbenchTab('original-page-tab', { ...page, id: page.browserId, kind: 'browser', workspaceId: 'resource', mode: 'normal', profileId: 'original-profile',
    navigationId: 'original-document', url: 'https://generic.invalid/', title: 'Healthy original page', canGoBack: false, canGoForward: false, loading: false,
    viewport: 'responsive', error: null, driving: false, appLinkPrompt: null })
  const tabs = { [tab.id]: tab }, layouts = { resource: createWorkspaceLayout('original-group', [tab.id]), display: createWorkspaceLayout('mirror-group', [tab.id]) }
  useAppStore.setState({ config, tabs, layouts, spaceZoneBindings: {}, sessions: [] })
  const catalog = spatialCatalog(useAppStore.getState(), [])
  return { tab, tabs, layouts, catalog }
}
it('cached topology and slices never retain a live Browser binding or an old selection callback', () => {
  const f = fixture(), first = vi.fn(), second = vi.fn()
  const scope = surveyPageProjection(page, f.catalog, f.tabs, first)!
  expect(scope.entity).toEqual({ kind: 'region', regionId: page.regionId })
  const next = surveyPageProjection(page, f.catalog, f.tabs, second, scope.selection[0])!
  next.onSelect(next.selection[0]!)
  expect(second).toHaveBeenCalledExactlyOnceWith(next.selection[0]); expect(first).not.toHaveBeenCalled()
  const replacement = { ...f.tab, regions: { [page.regionId]: { ...f.tab.regions[page.regionId]!, browserId: 'replacement-browser', id: 'replacement-browser' } } }
  expect(surveyPageOwner({ [f.tab.id]: replacement }, page, f.catalog)).toBeNull()
  expect(surveyPageProjection(page, f.catalog, { [f.tab.id]: replacement }, second)).toBeNull()
})
it('each projection validates the current preferred occurrence and does not guess between multiple original placements', () => {
  const f = fixture(), original = { displayWorkspaceId: 'resource', groupId: 'original-group', tabId: f.tab.id, regionId: page.regionId }
  const mirror = { ...original, displayWorkspaceId: 'display', groupId: 'mirror-group' }
  const a = surveyPageProjection(page, f.catalog, f.tabs, () => {}, original)!
  const b = surveyPageProjection(page, f.catalog, f.tabs, () => {}, mirror)!
  expect(a.selection).toEqual([original]); expect(b.selection).toEqual([mirror])
  expect(b.catalog.locations.every(location => location.displayWorkspaceId === 'display')).toBe(true)
  const extra = { ...f.catalog.locations.find(location => location.displayWorkspaceId === 'resource')!, groupId: 'another-original-group' }
  const ambiguous = { ...f.catalog, locations: [...f.catalog.locations, extra] }
  expect(surveyPageProjection(page, ambiguous, f.tabs, () => {})).toBeNull()
  expect(surveyPageProjection(page, ambiguous, f.tabs, () => {}, mirror)?.selection).toEqual([mirror])
  // Mutating a returned selection cannot mutate the original cached choices.
  b.selection[0]!.groupId = 'external-old-selection'
  expect(surveyPageProjection(page, f.catalog, f.tabs, () => {}, mirror)?.selection).toEqual([mirror])
})
it('missing, stale or ambiguous catalog locators preserve the original live owner and keep projection uncertainty read-only', () => {
  const f = fixture(), before = structuredClone(f.tab), empty = { ...f.catalog, regions: [] }
  for (const catalog of [null, empty, { ...f.catalog, regions: f.catalog.regions.map(region => ({ ...region, tabId: 'stale-original-parent' })) }]) {
    expect(surveyPageOwner(f.tabs, page, catalog)?.surface).toMatchObject({ title: 'Healthy original page', browserId: page.browserId })
    expect(surveyPageProjection(page, catalog, f.tabs, () => {})).toBeNull()
  }
  const ambiguous = { ...f.catalog, regions: [...f.catalog.regions, ...f.catalog.regions] }
  expect(surveyPageOwner(f.tabs, page, ambiguous)?.surface).toMatchObject({ browserId: page.browserId })
  expect(surveyPageProjection(page, ambiguous, f.tabs, () => {})).toBeNull()
  expect(f.tabs[f.tab.id]).toEqual(before)
})
