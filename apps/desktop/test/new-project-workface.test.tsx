import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentMuxDesktopSpaceSelection, AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { projectWorkbenchSpaceSelection, resolveWorkbenchOccurrenceSelection, workbenchObjectLayout, type NavigationState } from '../src/renderer/src/lib/desktop-focus-navigation'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { useWorkbenchObjectLayout } from '../src/renderer/src/hooks/useWorkbenchObjectLayout'
import { useAppStore } from '../src/renderer/src/store'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import type { AppConfig } from '../src/shared/contracts'

// The spatial projection and hook are actual source. The Store leaf supplies immutable Core facts;
// no Runtime, input, files or lifecycle operation is exercised by this owning test.
vi.mock('../src/renderer/src/store', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create(() => ({})) }
})
let root: Root | undefined
let host: HTMLDivElement | undefined
function fixture() {
  const tab = createWorkbenchTab('first-tab', { regionId: 'first-region', kind: 'launcher', workspaceId: 'new-project' })
  const layout = createWorkspaceLayout('first-group', [tab.id])
  const choice: AgentMuxDesktopSpaceSelection = { spaceId: null, zoneId: null, workspaceId: 'new-project',
    groupId: 'first-group', tabId: tab.id, regionId: 'first-region', topicId: null }
  const state: NavigationState = { config: null, sessions: [], tabs: { [tab.id]: tab }, layouts: { 'new-project': layout },
    spaceZoneBindings: {}, spatialRequests: {}, topicCategories: [], scratchTopicSnapshots: {},
    workbenchSpaceSelection: choice, activeWorkspaceId: 'new-project', mainSurface: 'workbench', selectedDemandId: null }
  return { state, tab, layout, choice, catalog: spatialCatalog(state, []) }
}
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {},
  workspaces: [{ id: 'new-project', name: 'New project', hostId: 'local', path: _hygiene_fixturePath("new-project"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true,
    devTools: true, viewport: true, saveBookmark: true, more: true } } }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); host = undefined; vi.unstubAllGlobals() })

it('shows the exact first unbound Launcher without inventing a Space or Zone', () => {
  const f = fixture(), before = structuredClone(f.state)
  expect(f.catalog.tabs[0]?.zoneId).toBeNull()
  expect(f.catalog.locations).toHaveLength(1)
  const result = workbenchObjectLayout(f.state, 'new-project')
  expect(result.confirmed).toBe(true)
  expect(result.layout?.groups.find(group => group.id === 'first-group')?.activeTabId).toBe(f.tab.id)
  expect(result.issues).toEqual([])
  expect(f.state).toEqual(before)
  expect(f.catalog.spaces).toEqual([])
  expect(f.catalog.zones).toEqual([])
})

it('re-resolves the same old unbound choice when normal project discovery confirms its Zone', () => {
  const f = fixture(); f.state.config = config
  const catalog = spatialCatalog(f.state, []), before = structuredClone(f.state)
  const zoneId = workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("new-project")), 'new-project')
  expect(catalog.tabs[0]?.zoneId).toBe(zoneId)
  const result = workbenchObjectLayout(f.state, 'new-project')
  expect(result.confirmed).toBe(true)
  expect(result.layout?.groups[0]?.activeTabId).toBe('first-tab')
  expect(result.choice).toMatchObject({ ...f.choice, spaceId: directoryIdentity('local', _hygiene_fixturePath("new-project")), zoneId })
  expect(f.state).toEqual(before)
  let local: AgentMuxDesktopSpaceSelection | undefined
  expect(() => { local = resolveWorkbenchOccurrenceSelection(f.state, catalog,
    { workspaceId: 'new-project', groupId: 'first-group', tabId: 'first-tab', regionId: 'first-region' }) }).not.toThrow()
  expect(local?.zoneId).toBe(zoneId)
  expect(() => resolveWorkbenchOccurrenceSelection(f.state, catalog,
    { workspaceId: 'new-project', groupId: 'other-group', tabId: 'first-tab', regionId: 'first-region' }))
    .toThrow('This local position is not confirmed')
})

it('keeps newly discovered multiple Space bindings unknown instead of guessing a parent', () => {
  const f = fixture(); f.state.config = config
  const spaceId = directoryIdentity('local', _hygiene_fixturePath("new-project")), zoneId = workspaceZoneId(spaceId, 'new-project')
  f.state.spaceZoneBindings = { [zoneId]: { spaceId, workspaceId: 'new-project', relations: { [("[\"local\",\"" + _hygiene_fixturePath("other-space") + "\"]")]: true } } }
  const result = workbenchObjectLayout(f.state, 'new-project')
  expect(result.confirmed).toBe(false)
  expect(result.layout?.groups[0]?.activeTabId).toBe(f.tab.id)
  expect(result.choice).toBe(f.choice)
  expect(result.issues).toEqual(['Choose the exact Space reference.'])
  expect(f.state.tabs[f.tab.id]).toBe(f.tab)
})

it.each([
  { groupId: 'other-group' }, { regionId: 'other-region' }, { tabId: 'other-tab' },
  { workspaceId: 'other-display' }, { tabId: null, groupId: null, regionId: null }
])('keeps an incorrect or incomplete unbound reference unconfirmed: %j', changed => {
  const f = fixture(), result = projectWorkbenchSpaceSelection(f.layout, f.state.tabs, f.catalog, { ...f.choice, ...changed })
  expect(result.confirmed).toBe(false)
  expect(result.layout).toBeNull()
  expect(result.issues.length).toBeGreaterThan(0)
  expect(f.state.tabs[f.tab.id]).toBe(f.tab)
})

it('refuses duplicated exact facts rather than choosing the first one', () => {
  const f = fixture(), duplicate: AgentMuxSpaceCatalog = { ...f.catalog, locations: [...f.catalog.locations, f.catalog.locations[0]!] }
  expect(projectWorkbenchSpaceSelection(f.layout, f.state.tabs, duplicate, f.choice)).toMatchObject({ layout: null, confirmed: false })
})

it('accepts one exact occurrence among legal foreign locations without changing its resource', () => {
  const f = fixture(), other = { ...f.catalog.locations[0]!, displayWorkspaceId: 'foreign-display', groupId: 'foreign-group' }
  const catalog = { ...f.catalog, locations: [...f.catalog.locations, other] }
  const result = projectWorkbenchSpaceSelection(f.layout, f.state.tabs, catalog, f.choice)
  expect(result.confirmed).toBe(true)
  expect(result.layout?.activeGroupId).toBe('first-group')
  expect(f.tab.workspaceId).toBe('new-project')
  expect(catalog.locations).toHaveLength(2)
})

it('does not treat missing metadata of an originally bound Zone as an unbound Tab', () => {
  const f = fixture(), catalog = { ...f.catalog, tabs: f.catalog.tabs.map(tab => ({ ...tab, zoneId: 'original-zone' })) }
  expect(projectWorkbenchSpaceSelection(f.layout, f.state.tabs, catalog, f.choice)).toMatchObject({ layout: null, confirmed: false })
  expect(projectWorkbenchSpaceSelection(f.layout, f.state.tabs, f.catalog, { ...f.choice, zoneId: 'original-zone' }))
    .toMatchObject({ layout: null, confirmed: false })
})

it('does not confirm an occurrence whose actual Group no longer contains the Tab', () => {
  const f = fixture(), empty = createWorkspaceLayout('first-group')
  const result = projectWorkbenchSpaceSelection(empty, f.state.tabs, f.catalog, f.choice)
  expect(result.confirmed).toBe(false)
  expect(result.layout).toBeNull()
})

it('retains the same unbound body during a gap and never lends it to a different exact Tab', async () => {
  const f = fixture(); useAppStore.setState(f.state)
  let value: ReturnType<typeof useWorkbenchObjectLayout> | undefined
  let renders = 0
  function Probe() { renders++; value = useWorkbenchObjectLayout('new-project'); return createElement('output', null,
    value.layout?.groups.flatMap(group => group.tabOrder).join(',') ?? 'Unconfirmed') }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(createElement(Probe)))
  expect(value?.confirmed).toBe(true)
  expect(host.textContent).toBe('first-tab')
  const beforeUnrelatedSnapshot = renders
  await act(async () => useAppStore.setState({ sessions: [] }))
  expect(renders).toBe(beforeUnrelatedSnapshot)
  // A missing catalog occurrence keeps the previously confirmed body of this exact choice.
  await act(async () => useAppStore.setState({ layouts: {} }))
  expect(value?.confirmed).toBe(false)
  expect(host.textContent).toBe('first-tab')
  expect(value?.issues.length).toBeGreaterThan(0)
  await act(async () => useAppStore.setState({ workbenchSpaceSelection: { ...f.choice, tabId: 'later-tab', regionId: 'later-region' } }))
  expect(value?.confirmed).toBe(false)
  expect(value?.layout).toBeNull()
  expect(host.textContent).toBe('Unconfirmed')
  expect(useAppStore.getState().tabs[f.tab.id]).toBe(f.tab)
})
