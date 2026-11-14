// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
const meter = vi.hoisted(() => ({ inside: false, inGlobal: false, inProjection: false, countCatalog: false, calls: 0, unrelatedTabRegions: 0, unrelatedRegionEntries: 0,
  globalTabEntries: 0, projectionTabEntries: 0, globalTabRegions: 0, projectionTabRegions: 0,
  globalCatalogRecords: { tabs: 0, regions: 0, zones: 0 }, projectionCatalogRecords: { tabs: 0, regions: 0, zones: 0 },
  catalogRecords: { tabs: 0, regions: 0, zones: 0 }, catalogRecordsInsideHelper: { tabs: 0, regions: 0, zones: 0 },
  catalogRecordFieldReads: { tabs: 0, regions: 0, zones: 0 } }))
vi.mock('../src/renderer/src/lib/survey-profile-view', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/src/lib/survey-profile-view')>()
  return { ...actual, surveyProfileReferences: (...args: Parameters<typeof actual.surveyProfileReferences>) => {
    meter.calls++; const before = meter.inside; meter.inside = true
    try { return actual.surveyProfileReferences(...args) } finally { meter.inside = before }
  } }
})
vi.mock('../src/renderer/src/components/GlobalSurveySurface', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/GlobalSurveySurface')>()
  const react = await import('react')
  return { ...actual, GlobalSurveySurface: react.memo((props: Parameters<typeof actual.GlobalSurveySurface>[0]) => {
    const before = meter.inGlobal; meter.inGlobal = true
    try { return (actual.GlobalSurveySurface as any).type(props) } finally { meter.inGlobal = before }
  }) }
})
vi.mock('react-resizable-panels', () => createRequire(process.cwd() + '/package.json')(
  process.cwd() + '/apps/desktop/node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// Native adapter only; the actual Workbench and retained Region portal still consume the projection.
vi.mock('../src/renderer/src/components/BrowserPane', () => ({
  BrowserPane: ({ tab }: { tab: { browserId: string } }) => React.createElement('div', { 'data-original-browser-pane': tab.browserId })
}))
vi.mock('../src/renderer/src/components/TerminalView', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/TerminalView')>()
  return { ...actual, TerminalView: () => React.createElement('div', { 'data-private-terminal-adapter': true }) }
})
import { surveyProfileReferences } from '../src/renderer/src/lib/survey-profile-view'
import { GlobalSurveySurface } from '../src/renderer/src/components/GlobalSurveySurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { browserProfiles } from '../src/renderer/src/lib/browser-profiles'
import { addWorkbenchRegion, createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { config, agent } from './helpers/workface-control-fixture'
import { surveyPageProjection } from '../src/renderer/src/lib/survey-page-references'
import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { workbenchRegionProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
const initial = useAppStore.getState(), profileId = 'related-profile'
const page = { regionId: 'survey-one-region', browserId: 'survey-one-browser' }
const receipts: unknown[] = []
function reset() {
  meter.calls = meter.unrelatedTabRegions = meter.unrelatedRegionEntries = 0
  meter.catalogRecords = { tabs: 0, regions: 0, zones: 0 }
  meter.catalogRecordsInsideHelper = { tabs: 0, regions: 0, zones: 0 }
  meter.catalogRecordFieldReads = { tabs: 0, regions: 0, zones: 0 }
  meter.globalTabEntries = meter.projectionTabEntries = meter.globalTabRegions = meter.projectionTabRegions = 0
  meter.globalCatalogRecords = { tabs: 0, regions: 0, zones: 0 }
  meter.projectionCatalogRecords = { tabs: 0, regions: 0, zones: 0 }
}
function sample() {
  return { ...meter, catalogRecords: { ...meter.catalogRecords }, catalogRecordsInsideHelper: { ...meter.catalogRecordsInsideHelper },
    catalogRecordFieldReads: { ...meter.catalogRecordFieldReads }, globalCatalogRecords: { ...meter.globalCatalogRecords },
    projectionCatalogRecords: { ...meter.projectionCatalogRecords } }
}
function measuredCatalogArray<T extends object>(values: T[], key: 'tabs' | 'regions' | 'zones') {
  const records = values.map((value, index) => index === 0 ? value : new Proxy(value, { get(target, property, receiver) {
    if (meter.countCatalog && typeof property === 'string' && Object.hasOwn(target, property)) meter.catalogRecordFieldReads[key]++
    return Reflect.get(target, property, receiver)
  } }))
  return new Proxy(records, { get(target, property, receiver) {
    if (meter.countCatalog && typeof property === 'string' && /^(0|[1-9][0-9]*)$/.test(property) && Number(property) > 0 && Number(property) < target.length) {
      meter.catalogRecords[key]++
      if (meter.inside) meter.catalogRecordsInsideHelper[key]++
      if (meter.inGlobal) meter.globalCatalogRecords[key]++
      if (meter.inProjection) meter.projectionCatalogRecords[key]++
    }
    return Reflect.get(target, property, receiver)
  } })
}
function snapshot(title = 'Original related page') {
  return { id: page.browserId, mode: 'normal' as const, profileId, url: 'https://generic.invalid/', title,
    navigationId: 'original-document', canGoBack: false, canGoForward: false, loading: false,
    viewport: 'responsive' as const, error: null, driving: false, appLinkPrompt: null }
}
function fixture(n: number) {
  const tab = createWorkbenchTab('survey-one-tab', { ...snapshot(), ...page, kind: 'browser', workspaceId: 'resource' })
  const tabs: Record<string, WorkbenchTab> = { [tab.id]: tab }
  const sessions = []
  for (let i = 0; i < n; i++) {
    const sid = 'unrelated-session-' + i, regionId = 'unrelated-region-' + i
    const unrelated = createWorkbenchTab('unrelated-tab-' + i, { regionId, kind: i % 2 ? 'terminal' : 'agent',
      phase: 'attached', workspaceId: 'resource', sessionId: sid })
    sessions.push(agent(sid))
    const regions = new Proxy(unrelated.regions, { get(target, key, receiver) {
      if (meter.inside && typeof key === 'string' && Object.hasOwn(target, key)) meter.unrelatedRegionEntries++
      return Reflect.get(target, key, receiver)
    } })
    tabs[unrelated.id] = new Proxy({ ...unrelated, regions }, { get(target, key, receiver) {
      if (meter.inside && key === 'regions') meter.unrelatedTabRegions++
      if (meter.countCatalog && key === 'regions' && meter.inGlobal) meter.globalTabRegions++
      if (meter.countCatalog && key === 'regions' && meter.inProjection) meter.projectionTabRegions++
      return Reflect.get(target, key, receiver)
    } })
  }
  const catalog = {
    zones: measuredCatalogArray(Object.values(tabs).map((tab, i) => ({ zoneId: i ? 'unrelated-zone-' + (i - 1) : 'related-task-zone', workspaceId: 'resource' })), 'zones'),
    tabs: measuredCatalogArray(Object.values(tabs).map((tab, i) => ({ tabId: tab.id, workspaceId: tab.workspaceId, zoneId: i ? 'unrelated-zone-' + (i - 1) : 'related-task-zone' })), 'tabs'),
    regions: measuredCatalogArray(Object.values(tabs).map((tab, i) => ({ tabId: tab.id, regionId: Object.keys(tab.regions)[0]!, kind: i ? (i % 2 ? 'agent' : 'terminal') : 'browser' })), 'regions'),
    locations: Object.values(tabs).map((tab, i) => ({ spaceId: null, zoneId: i ? 'unrelated-zone-' + (i - 1) : 'related-task-zone',
      workspaceId: 'resource', displayWorkspaceId: 'resource', groupId: 'original-group', tabId: tab.id, regionId: Object.keys(tab.regions)[0]! })), bindings: [], spaces: []
  }
  return { tabs, sessions, catalog }
}
afterEach(() => { meter.countCatalog = false; browserProfiles.reset(); vi.restoreAllMocks(); useAppStore.setState(initial, true); receipts.length = 0 })
it('counts the actual helper with one exact reference and unrelated Agent/Terminal tabs', () => {
  for (const unrelatedTabs of [0, 16, 64]) {
    const f = fixture(unrelatedTabs); reset(); meter.countCatalog = true
    const result = surveyProfileReferences({ kind: 'profile', profileId }, [page], [], f.tabs, profileId, f.catalog as never)
    expect(result.pages).toEqual([page]); expect(result.zoneIds.size).toBe(0)
    receipts.push({ phase: 'direct-production-helper', unrelatedTabs, pages: 1, research: 0, ...sample() })
    expect(meter.calls).toBe(1)
  }
})
it('measures the real GlobalSurveySurface after one original Store Browser update and separately while hidden', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const originalValues = Object.values
  vi.spyOn(Object, 'values').mockImplementation((value: object) => {
    if (meter.countCatalog && value === useAppStore.getState().tabs) {
      const unrelated = Object.keys(value).filter(key => key.startsWith('unrelated-tab-')).length
      if (meter.inGlobal) meter.globalTabEntries += unrelated
      if (meter.inProjection) meter.projectionTabEntries += unrelated
    }
    return originalValues(value)
  })
  vi.spyOn(api.browser, 'readProfiles').mockResolvedValue({ revision: 1, sequence: 1,
    profiles: [{ id: profileId, label: 'Related', createdAt: 1, isDefault: true, source: null }], folders: [], views: [] })
  for (const unrelatedTabs of [0, 16, 64]) {
    browserProfiles.reset()
    const f = fixture(unrelatedTabs)
    useAppStore.setState({ config, tabs: f.tabs, sessions: f.sessions, layouts: {}, activeWorkspaceId: 'resource', surveyProfileView: { kind: 'profile', profileId },
      surveyProfileViewReadRecovery: null, surveyPageReferences: [page], surveyCollectedZones: {}, surveyZoneSelection: null,
      surveyToolsOpen: false, surveySidebarCollapsed: false, mainSurface: 'survey' })
    const element = document.createElement('div'); document.body.append(element); const root = createRoot(element)
    try {
      reset(); meter.countCatalog = true
      await act(async () => root.render(<GlobalSurveySurface visible catalog={f.catalog as never} projection={null} selection={null} />))
      expect(element.querySelectorAll('[data-survey-page-browser-id]')).toHaveLength(1)
      receipts.push({ phase: 'mount-and-topology-establishment-not-hot-path', unrelatedTabs, ...sample() })
      reset()
      await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: snapshot('Related update once') } as never))
      const visible = { phase: 'visible-real-consumer-related-browser-updated', unrelatedTabs, unrelatedSessionRecords: f.sessions.length,
        pages: element.querySelectorAll('[data-survey-page-browser-id]').length, research: 0, ...sample() }
      receipts.push(visible)
      expect(useAppStore.getState().tabs['survey-one-tab']!.regions[page.regionId]).toMatchObject({ title: 'Related update once' })
      expect(element.textContent).toContain('Related update once')
      await act(async () => root.render(<GlobalSurveySurface visible={false} catalog={f.catalog as never} projection={null} selection={null} />))
      reset()
      await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: snapshot('Related update while hidden') } as never))
      receipts.push({ phase: 'hidden-real-consumer-related-browser-updated', unrelatedTabs, ...sample() })
      expect(meter.calls).toBe(0)
      expect(meter.unrelatedRegionEntries).toBe(0)
    } finally { await act(async () => root.unmount()); element.remove() }
  }
  const priorMoveBefore = Object.getOwnPropertyDescriptor(Element.prototype, 'moveBefore')
  Object.defineProperty(Element.prototype, 'moveBefore', { configurable: true, value(this: Element, node: Node, before: Node | null) { this.insertBefore(node, before) } })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  try { for (const unrelatedTabs of [0, 16, 64]) {
    browserProfiles.reset()
    const f = fixture(unrelatedTabs), selected = { kind: 'page' as const, ...page }
    useAppStore.setState({ config, tabs: f.tabs, sessions: f.sessions,
      layouts: { resource: createWorkspaceLayout('original-group', Object.keys(f.tabs)) }, activeWorkspaceId: 'resource',
      surveyProfileView: { kind: 'profile', profileId }, surveyProfileViewReadRecovery: null,
      surveyPageReferences: [page], surveyCollectedZones: {}, surveyZoneSelection: selected,
      surveyToolsOpen: false, surveySidebarCollapsed: false, mainSurface: 'survey',
      workbenchSpaceSelection: null, retainedSpatialFocus: null, workbenchNavigationInputPolicy: null })
    const element = document.createElement('div'); document.body.append(element); const root = createRoot(element)
    const project = () => {
      const before = meter.inProjection; meter.inProjection = true
      try { return surveyPageProjection(selected, f.catalog as never, useAppStore.getState().tabs, () => {})! }
      finally { meter.inProjection = before }
    }
    const render = (projection: NonNullable<ReturnType<typeof surveyPageProjection>>) => {
      const reference = projection.selection[0]!, hostId = workbenchRegionProjectionSlotId('survey-workbench-slot', reference)
      const targets = { 'survey-one-tab': [{ hostId, surface: 'survey' as const, visible: true, active: true, reference, projection }] }
      return <><GlobalSurveySurface visible catalog={f.catalog as never} projection={projection} selection={null} pageSelection={selected} viewTargets={targets} />
        <WorkspaceWorkbench workspaceId="resource" viewTargets={targets} visible={false} /></>
    }
    try {
      const projection = project()
      expect(projection?.entity).toEqual({ kind: 'region', regionId: page.regionId })
      expect(projection.selection).toHaveLength(1)
      await act(async () => root.render(render(projection)))
      await act(async () => new Promise(resolve => setTimeout(resolve, 40)))
      expect(element.querySelectorAll('[data-original-browser-pane="survey-one-browser"]')).toHaveLength(1)
      const originalHostId = workbenchRegionProjectionSlotId('survey-workbench-slot', projection.selection[0]!)
      expect(document.getElementById(originalHostId)?.querySelectorAll('[data-original-browser-pane="survey-one-browser"]')).toHaveLength(1)
      expect(element.querySelector('[data-survey-page-browser-id="survey-one-browser"]')?.getAttribute('data-selected')).toBe('true')
      expect(element.textContent).not.toContain('The original Browser Region is not confirmed')
      reset(); meter.countCatalog = true
      await act(async () => {
        useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: snapshot('Selected related update once') } as never)
        // App.tsx's surveyProjection useMemo calls this exact production function when tabs changes.
        root.render(render(project()))
      })
      receipts.push({ phase: 'selected-exact-page-related-browser-updated', unrelatedTabs, pages: 1, research: 0, ...sample() })
      expect(useAppStore.getState().surveyZoneSelection).toEqual(selected)
      expect(element.querySelectorAll('[data-original-browser-pane="survey-one-browser"]')).toHaveLength(1)
      expect(document.getElementById(originalHostId)?.querySelectorAll('[data-original-browser-pane="survey-one-browser"]')).toHaveLength(1)
      expect(element.textContent).toContain('Selected related update once')
      expect(element.querySelectorAll('[data-survey-page-browser-id]')).toHaveLength(1)
    } finally { await act(async () => root.unmount()); element.remove() }
  } } finally {
    if (priorMoveBefore) Object.defineProperty(Element.prototype, 'moveBefore', priorMoveBefore)
    else Reflect.deleteProperty(Element.prototype, 'moveBefore')
    vi.unstubAllGlobals()
  }
  const active = receipts.filter((r: any) => r.phase === 'visible-real-consumer-related-browser-updated') as any[]
  expect(active).toHaveLength(3)
  expect(active.map(r => r.calls)).toEqual([1, 1, 1])
  const hidden = receipts.filter((r: any) => r.phase === 'hidden-real-consumer-related-browser-updated') as any[]
  expect(hidden).toHaveLength(3)
  expect(hidden.map(r => r.calls)).toEqual([0, 0, 0])
  for (const key of ['tabs', 'regions', 'zones']) expect(hidden.map(r => r.catalogRecords[key])).toEqual([0, 0, 0])
  // The acceptance: a single related Browser update may not traverse unrelated Session regions in Survey projection.
  expect(active.map(r => r.unrelatedRegionEntries)).toEqual([0, 0, 0])
  for (const key of ['tabs', 'regions', 'zones']) expect(active.map(r => r.catalogRecords[key])).toEqual([0, 0, 0])
  for (const key of ['tabs', 'regions', 'zones']) expect(active.map(r => r.catalogRecordFieldReads[key])).toEqual([0, 0, 0])
  const selected = receipts.filter((r: any) => r.phase === 'selected-exact-page-related-browser-updated') as any[]
  expect(selected).toHaveLength(3)
  for (const key of ['tabs', 'regions', 'zones']) {
    expect(selected.map(r => r.globalCatalogRecords[key])).toEqual([0, 0, 0])
    expect(selected.map(r => r.projectionCatalogRecords[key])).toEqual([0, 0, 0])
    expect(selected.map(r => r.catalogRecordFieldReads[key])).toEqual([0, 0, 0])
  }
  expect(selected.map(r => r.globalTabEntries)).toEqual([0, 0, 0])
  expect(selected.map(r => r.projectionTabEntries)).toEqual([0, 0, 0])
})

it('caches only immutable catalog structure, reads current Profile facts and invalidates on the original new topology snapshot', () => {
  const f = fixture(0), catalog = f.catalog as unknown as AgentMuxSpaceCatalog
  const original = f.tabs['survey-one-tab']!
  expect(surveyProfileReferences({ kind: 'profile', profileId }, [page], [], f.tabs, profileId, catalog).pages).toEqual([page])
  const changed = { ...original, regions: { [page.regionId]: { ...original.regions[page.regionId]!, profileId: 'other-profile' } as never } }
  expect(surveyProfileReferences({ kind: 'profile', profileId }, [page], [], { [original.id]: changed }, profileId, catalog).pages).toEqual([])
  const moved = createWorkbenchTab('new-original-placement', { ...snapshot(), ...page, kind: 'browser', workspaceId: 'resource', profileId: 'other-profile' })
  const nextCatalog = { ...catalog, tabs: [{ ...catalog.tabs[0]!, tabId: moved.id }], regions: [{ ...catalog.regions[0]!, tabId: moved.id }] }
  expect(surveyProfileReferences({ kind: 'profile', profileId }, [page], [], { [moved.id]: moved }, profileId, nextCatalog).pages).toEqual([])
  expect(surveyProfileReferences({ kind: 'profile', profileId: 'other-profile' }, [page], [], { [moved.id]: moved }, profileId, nextCatalog).pages).toEqual([page])
})
it('preserves private, Capsule and the same complete mixed research while filtering only confirmed normal pages', () => {
  const f = fixture(0), otherProfile = 'other-profile', root = f.tabs['survey-one-tab']!
  const other = { regionId: 'other-page', browserId: 'other-browser' }, privatePage = { regionId: 'private-page', browserId: 'private-browser' }, capsule = { regionId: 'capsule-page', browserId: 'capsule-browser' }
  let mixed = addWorkbenchRegion(root, page.regionId, 'right', { ...snapshot(), ...other, kind: 'browser', workspaceId: 'resource', profileId: otherProfile })
  mixed = addWorkbenchRegion(mixed, other.regionId, 'down', { ...snapshot(), ...privatePage, kind: 'browser', workspaceId: 'resource', mode: 'private', profileId: null })
  mixed = addWorkbenchRegion(mixed, privatePage.regionId, 'down', { ...snapshot(), ...capsule, kind: 'browser', workspaceId: 'resource', capsuleId: 'original-capsule', profileId: otherProfile })
  mixed = addWorkbenchRegion(mixed, capsule.regionId, 'down', { regionId: 'related-file', kind: 'file', workspaceId: 'resource', path: 'original-unsaved.md' })
  const tabs = { [mixed.id]: mixed }, original = structuredClone(mixed)
  const catalog = { ...f.catalog, regions: Object.values(mixed.regions).map(surface => ({ regionId: surface.regionId, tabId: mixed.id, kind: surface.kind })) } as unknown as AgentMuxSpaceCatalog
  for (const selected of [profileId, otherProfile]) {
    const result = surveyProfileReferences({ kind: 'profile', profileId: selected }, [page, other, privatePage, capsule], ['related-task-zone'], tabs, profileId, catalog)
    expect(result.pages).toEqual([selected === profileId ? page : other, privatePage, capsule])
    expect([...result.zoneIds]).toEqual(['related-task-zone'])
    expect(tabs[mixed.id]).toEqual(original)
  }
})
it('retains exact cold or ambiguous references when catalog placement is absent rather than scanning or selecting another Browser', () => {
  const f = fixture(0), missing = { regionId: 'cold-region', browserId: 'cold-browser' }
  const unavailable = { ...f.catalog, regions: [] } as unknown as AgentMuxSpaceCatalog
  expect(surveyProfileReferences({ kind: 'profile', profileId: 'other-profile' }, [page, missing], ['missing-research'], f.tabs, profileId, null))
    .toEqual({ pages: [page, missing], zoneIds: new Set(['missing-research']) })
  expect(surveyProfileReferences({ kind: 'profile', profileId: 'other-profile' }, [page, missing], [], f.tabs, profileId, unavailable).pages).toEqual([page, missing])
  const ambiguous = { ...f.catalog, regions: [...f.catalog.regions, { ...f.catalog.regions[0]!, tabId: 'unknown-second-owner' }] } as unknown as AgentMuxSpaceCatalog
  expect(surveyProfileReferences({ kind: 'profile', profileId: 'other-profile' }, [page], [], f.tabs, profileId, ambiguous).pages).toEqual([page])
  const replacement = { ...page, browserId: 'original-different-browser' }
  expect(surveyProfileReferences({ kind: 'profile', profileId: 'other-profile' }, [replacement], [], f.tabs, profileId, f.catalog as unknown as AgentMuxSpaceCatalog).pages).toEqual([replacement])
})
