// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, createElement, Fragment } from 'react'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { parseSurveyPageReferences, parseSurveyCollectionChange } from '@agentmux/core/control'
import { GlobalSurveySurface } from '../src/renderer/src/components/GlobalSurveySurface'
import { useAppStore, restorePersistedUiState } from '../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { surveyPageProjection, readSurveyPagePreferences, persistedSurveySelection } from '../src/renderer/src/lib/survey-page-references'
import { projectWorkbenchProjection, workbenchRegionProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'
import { executeSurveyList } from '../src/renderer/src/lib/survey-list'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { config } from './helpers/workface-control-fixture'
vi.mock('react-resizable-panels', () => createRequire(process.cwd() + '/package.json')(
  process.cwd() + '/apps/desktop/node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// Isolate only the native adapter: the actual Workbench, Region ownership and
// StableWorkbenchView portals remain responsible for destination consumption.
vi.mock('../src/renderer/src/components/BrowserPane', () => ({
  BrowserPane: ({ tab }: { tab: { browserId: string } }) => createElement('div', { 'data-original-browser-pane': tab.browserId })
}))
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'

const initial = useAppStore.getState()
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true) })
const page = { regionId: 'original-browser-region', browserId: 'different-native-browser' }
function arrange() {
  let tab = createWorkbenchTab('mixed-tab', { regionId: 'original-agent', kind: 'agent', phase: 'attached', workspaceId: 'resource', sessionId: 'original-session' })
  tab = addWorkbenchRegion(tab, 'original-agent', 'right', { regionId: page.regionId, kind: 'browser', workspaceId: 'resource', browserId: page.browserId,
    id: page.browserId, url: 'https://generic.invalid/', title: 'Original page', mode: 'normal', profileId: 'profile-one', navigationId: 'original-document',
    canGoBack: false, canGoForward: false, loading: false, viewport: 'responsive', error: null, driving: false, appLinkPrompt: null })
  tab = addWorkbenchRegion(tab, page.regionId, 'down', { regionId: 'dirty-file', kind: 'file', workspaceId: 'resource', path: 'original.md' } as never)
  const tabs = { [tab.id]: tab }, layouts = { resource: createWorkspaceLayout('original-group', [tab.id]) }
  useAppStore.setState({ config, tabs, layouts, surveyPageReferences: [], surveyPageReadRecovery: null, surveyCollectedZones: {},
    surveyZoneSelection: null, documents: { 'resource:original.md': { value: 'unsaved original document' } } as never, dirtyDocuments: { 'resource:original.md': true } })
  return { tab, tabs, layouts, catalog: spatialCatalog(useAppStore.getState(), []) }
}

it('public page codecs retain the exact occupant condition and reject duplicates, authority fields and one-sided CAS', () => {
  expect(parseSurveyPageReferences([page])).toEqual([page])
  expect(() => parseSurveyPageReferences([{ ...page, profileId: 'not-an-authority' }])).toThrow()
  expect(() => parseSurveyPageReferences([page, { ...page, browserId: 'another-browser' }])).toThrow()
  expect(() => parseSurveyCollectionChange({ pageReferences: [page] })).toThrow()
  expect(parseSurveyCollectionChange({ pageReferences: [page], expectedPageReferences: [] })).toEqual({ pageReferences: [page], expectedPageReferences: [] })
})

it('the real shared Region projection selects only the Browser leaf while the original mixed Tab, split and file remain intact', () => {
  const f = arrange(), before = structuredClone(f.tab)
  const projection = surveyPageProjection(page, f.catalog, f.tabs, () => {})
  expect(projection?.entity).toEqual({ kind: 'region', regionId: page.regionId })
  const projected = projectWorkbenchProjection(f.layouts.resource, f.tabs, projection!)
  expect(projected.selection.map(reference => reference.regionId)).toEqual([page.regionId])
  expect(workbenchRegionProjectionSlotId('survey-workbench-slot', projected.selection[0]!)).toContain(page.regionId)
  expect(f.tabs[f.tab.id]).toEqual(before); expect(Object.keys(f.tab.regions)).toHaveLength(3)
})

it('a replacement Browser cannot inherit a saved Region reference, while missing original content remains a retained reference', () => {
  const f = arrange(), original = f.tab.regions[page.regionId]!
  f.tabs[f.tab.id] = { ...f.tab, regions: { ...f.tab.regions, [page.regionId]: { ...original, browserId: 'replacement' } as never } }
  expect(surveyPageProjection(page, f.catalog, f.tabs, () => {})).toBeNull()
  expect(readSurveyPagePreferences([page]).references).toEqual([page])
  expect(persistedSurveySelection({ kind: 'page', ...page })).toEqual({ kind: 'page', ...page })
})

it('malformed page preferences cannot abort full UI restore, erase valid unknown references or overwrite their original recovery material', () => {
  arrange()
  const raw = [page, { regionId: 'temporarily-missing', browserId: 'original-unloaded' }, { unknownField: 'keep exact original material' }]
  const before = useAppStore.getState(), choice = { workspaceId: 'resource', spaceId: null, zoneId: null, topicId: null, tabId: 'mixed-tab', groupId: 'original-group', regionId: page.regionId }
  const restored = restorePersistedUiState(config, { surveyPageReferences: raw, surveyCollectedZones: { 'original-full-study': true }, workbenchSpaceSelection: choice })
  expect(restored.surveyPageReferences).toEqual(raw.slice(0, 2)); expect(restored.surveyPageReadRecovery?.source).toBe(raw)
  expect(restored.workbenchSpaceSelection).toEqual(choice); expect(restored.surveyCollectedZones).toEqual({ 'original-full-study': true })
  useAppStore.setState(restored)
  const after = useAppStore.getState()
  expect([after.tabs, after.layouts, after.documents, after.dirtyDocuments]).toEqual([before.tabs, before.layouts, before.documents, before.dirtyDocuments])
  const persisted = useAppStore.persist.getOptions().partialize!(after) as { surveyPageReferences: unknown }
  expect(persisted.surveyPageReferences).toEqual(raw)
})

it('only the unreadable page membership is unknown; the original Zone preference remains usable and raw source stays protected', async () => {
  arrange(); const f = useAppStore.getState(), raw = { unknown: 'original source' }, read = readSurveyPagePreferences(raw)
  useAppStore.setState({ surveyPageReferences: read.references, surveyPageReadRecovery: read.recovery })
  const list = await f.executeControl({ schemaVersion: 5, requestId: 'unread-original', operation: 'space.survey-list' })
  expect(list).toMatchObject({ outcome: 'unknown', issues: [{ code: 'SURVEY_PAGE_PREFERENCES_UNREADABLE' }] })
  const change = await useAppStore.getState().setSurveyPageCollected(page, true)
  expect(change.outcome).toBe('unknown'); expect(useAppStore.getState().surveyPageReadRecovery?.source).toBe(raw)
})

it('in-band retry re-reads only the original page field and leaves current drafts/layout/Work navigation intact', async () => {
  arrange(); const raw = { unknown: true }, read = readSurveyPagePreferences(raw)
  useAppStore.setState({ surveyPageReferences: read.references, surveyPageReadRecovery: read.recovery })
  const before = useAppStore.getState()
  localStorage.setItem('agentmux-workbench-v1', JSON.stringify({ state: { surveyPageReferences: [page], mainSurface: 'board', documents: { fake: 'must not replace current edits' } }, version: 1 }))
  await before.retrySurveyPagesRead()
  const after = useAppStore.getState()
  expect(after.surveyPageReadRecovery).toBeNull(); expect(after.surveyPageReferences).toEqual([page])
  expect([after.tabs, after.layouts, after.documents, after.dirtyDocuments, after.mainSurface, after.workbenchSpaceSelection])
    .toEqual([before.tabs, before.layouts, before.documents, before.dirtyDocuments, before.mainSurface, before.workbenchSpaceSelection])
})

it('page CAS preserves whole-Zone membership, rejects stale edits and never grants a replacement occupant', async () => {
  let state = { surveyOrganization: { ungrouped: ['whole-zone'], groups: [] }, surveyCollectedZones: { 'whole-zone': true as const }, surveyPageReferences: [page] }
  const save = vi.fn(async () => ({ layoutApplied: false, clientStateWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed' as const, reason: null }))
  const ports = { get: () => state, set: (next: typeof state) => { state = next }, hasZone: () => true, hasPage: (reference: typeof page) => reference.browserId === 'confirmed-new', save }
  const request = { schemaVersion: 5 as const, requestId: 'reference-change', operation: 'space.survey-list' as const }
  expect((await executeSurveyList(ports, { ...request, collection: { pageReferences: [], expectedPageReferences: [] } })).outcome).toBe('refused')
  expect((await executeSurveyList(ports, { ...request, collection: { pageReferences: [page, { regionId: 'new', browserId: 'wrong' }], expectedPageReferences: [page] } })).outcome).toBe('refused')
  const changed = await executeSurveyList(ports, { ...request, collection: { pageReferences: [page, { regionId: 'new', browserId: 'confirmed-new' }], expectedPageReferences: [page] } })
  expect(changed.outcome).toBe('changed'); expect(changed.collectedZoneIds).toEqual(['whole-zone']); expect(save).toHaveBeenCalledTimes(1)
})

it.each(['changed', 'unknown'] as const)('a late original page removal %s receipt preserves a later page selection in the actual Survey component', async outcome => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const a = { regionId: 'original-page-a', browserId: 'browser-a' }, b = { regionId: 'original-page-b', browserId: 'browser-b' }
  let finish!: (value: unknown) => void
  const delayed = vi.fn(() => new Promise(resolve => { finish = resolve }))
  useAppStore.setState({ config, tabs: {}, layouts: {}, surveyPageReferences: [a, b], surveyPageReadRecovery: null,
    surveyCollectedZones: {}, surveyZoneSelection: { kind: 'page', ...a }, setSurveyPageCollected: delayed as never,
    setSurveyZoneSelection: selection => useAppStore.setState({ surveyZoneSelection: selection }) })
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  const render = (page: typeof a) => root.render(createElement(GlobalSurveySurface, {
    visible: false, catalog: null, projection: null, selection: null, pageSelection: { kind: 'page', ...page }
  }))
  try {
    await act(async () => render(a))
    const close = element.querySelector<HTMLButtonElement>('[data-survey-page-browser-id="browser-a"] [aria-label="Remove page from Survey"]')!
    await act(async () => close.click())
    await act(async () => { useAppStore.setState({ surveyZoneSelection: { kind: 'page', ...b } }); render(b) })
    await act(async () => finish({ outcome, issues: outcome === 'unknown' ? [{ message: 'Original page membership is unconfirmed.' }] : [], pageReferences: [b] }))
    expect(useAppStore.getState().surveyZoneSelection).toEqual({ kind: 'page', ...b })
    if (outcome === 'unknown') expect(element.textContent).toContain('Original page membership is unconfirmed.')
    expect(delayed).toHaveBeenCalledExactlyOnceWith(a, false)
  } finally { await act(async () => root.unmount()); element.remove() }
})

it('one exact Browser Region destination has one retained content owner and no competing thin destination', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const priorMoveBefore = Object.getOwnPropertyDescriptor(Element.prototype, 'moveBefore')
  Object.defineProperty(Element.prototype, 'moveBefore', { configurable: true, value(this: Element, node: Node, before: Node | null) {
    this.insertBefore(node, before)
  } })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  const snapshot = (regionId: string, browserId: string) => ({ regionId, browserId, kind: 'browser' as const, workspaceId: 'resource',
    id: browserId, url: 'https://generic.invalid/', title: 'Original Browser', mode: 'normal' as const, profileId: 'profile-a',
    canGoBack: false, canGoForward: false, loading: false, viewport: 'responsive' as const, navigationId: browserId + '-document', error: null, driving: false, appLinkPrompt: null })
  const exact = { regionId: 'exact-region', browserId: 'actual-browser' }
  let tab = createWorkbenchTab('original-tab', snapshot('original-sibling', 'sibling-browser'))
  tab = addWorkbenchRegion(tab, 'original-sibling', 'down', snapshot(exact.regionId, exact.browserId))
  const tabs = { [tab.id]: tab }, layouts = { resource: createWorkspaceLayout('original-group', [tab.id]) }
  useAppStore.setState({ config, tabs, layouts, sessions: [], mainSurface: 'survey', workbenchSpaceSelection: null,
    retainedSpatialFocus: null, workbenchNavigationInputPolicy: null })
  const projection = surveyPageProjection(exact, spatialCatalog(useAppStore.getState(), []), tabs, () => {})!
  const reference = projection.selection[0]!, hostId = workbenchRegionProjectionSlotId('survey-workbench-slot', reference)
  const viewTargets = { [tab.id]: [{ hostId, surface: 'survey' as const, visible: true, active: true, reference, projection }] }
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  try {
    await act(async () => root.render(createElement(Fragment, null,
      createElement(WorkspaceWorkbench, { workspaceId: 'resource', viewOwnership: 'projection', projection, viewTargets }),
      createElement(WorkspaceWorkbench, { workspaceId: 'resource', viewTargets, visible: false })
    )))
    await act(async () => new Promise(resolve => setTimeout(resolve, 40)))
    const host = document.getElementById(hostId)!
    expect(host).not.toBeNull()
    expect(host.querySelectorAll('[data-original-browser-pane="actual-browser"]')).toHaveLength(1)
    expect(host.querySelector('[data-original-browser-pane="sibling-browser"]')).toBeNull()
    expect(host.children).toHaveLength(1)
    expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
  } finally {
    await act(async () => root.unmount()); element.remove()
    if (priorMoveBefore) Object.defineProperty(Element.prototype, 'moveBefore', priorMoveBefore)
    else Reflect.deleteProperty(Element.prototype, 'moveBefore')
  }
})
