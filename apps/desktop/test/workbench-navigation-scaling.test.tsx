import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { useWorkbenchObjectLayout } from '../src/renderer/src/hooks/useWorkbenchObjectLayout'
import { workbenchNavigationCatalog, workbenchNavigationTabs } from '../src/renderer/src/lib/workbench-navigation-catalog'
import { createSessionProjectFileContextSelector } from '../src/renderer/src/lib/session-project-file-context'
import * as spatial from '../src/renderer/src/lib/space-agent-control'
import * as workbench from '../src/renderer/src/lib/workbench-tabs'
import { workbenchObjectLayout } from '../src/renderer/src/lib/desktop-focus-navigation'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const initial = useAppStore.getState()
afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function scene(count = 48) {
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }],
    executors: {}, workspaces: [{ id: 'workspace', hostId: 'local', kind: 'folder', name: 'Project', path: _hygiene_fixturePath("repo") }],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const sessions: SessionSnapshot[] = Array.from({ length: count }, (_, n) => ({ id: `agent-${n}`, kind: 'agent',
    providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: _hygiene_fixturePath("repo"), label: `Agent ${n}`,
    createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1), agentSessionUpdatedAt: _historyFixtureEpoch(0, 0, 1), latestOutputBytes: 0, processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: `agent-${n}`, run: { runId: `run-${n}` } } }))
  const tabs = Object.fromEntries(sessions.map(s => [s.id, createWorkbenchTab(s.id,
    { kind: 'agent', phase: 'attached', regionId: `region-${s.id}`, workspaceId: 'workspace', sessionId: s.id })]))
  const browser = { id: 'browser', browserId: 'browser', kind: 'browser' as const, regionId: 'browser-region',
    workspaceId: 'workspace', mode: 'normal' as const, navigationId: 'nav', url: 'https://example.test', title: 'Page', profileId: 'profile',
    driving: false, appLinkPrompt: null, loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive' as const, error: null }
  tabs.browser = createWorkbenchTab('browser', browser)
  const state = { ...initial, config, sessions, tabs, localHome: _hygiene_fixturePath("Users/me"),
    layouts: { workspace: createWorkspaceLayout('group', Object.keys(tabs)) },
    demandPmoTabIds: {}, demands: {}, activeWorkspaceId: 'workspace', mainSurface: 'workbench' as const }
  return { state, browser }
}

it('shares one graph across retained Pane file contexts and ignores Browser page changes', () => {
  const { state, browser } = scene()
  const build = vi.spyOn(spatial, 'spatialCatalog')
  const selectors = state.sessions.map(s => createSessionProjectFileContextSelector(s.id, {
    workspaceId: 'workspace', tabGroupId: 'group', tabId: s.id, regionId: `region-${s.id}`, sessionId: s.id
  }, () => null))
  const values = selectors.map(select => select(state))
  expect(values).toHaveLength(48)
  expect(values.map(value => value.kind)).toEqual(Array(48).fill('session'))
  expect(build).toHaveBeenCalledTimes(1)
  useAppStore.setState(state, true)
  const navigation = workbenchNavigationTabs(state.tabs)
  const resolveRoot = vi.spyOn(workbench, 'workspaceRootForPath')
  for (let n = 0; n < 20; n++) {
    useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...browser,
      title: `Page ${n}`, url: `https://example.test/${n}`, loading: n % 2 === 0 } })
    const current = useAppStore.getState()
    expect(workbenchNavigationTabs(current.tabs)).toBe(navigation)
    expect(selectors.map(select => select(current))).toEqual(values)
  }
  expect(build).toHaveBeenCalledTimes(1)
  for (let n = 0; n < 20; n++) {
    const current = useAppStore.getState()
    const unrelated = { ...current, sessions: current.sessions.map(s => ({ ...s, updatedAt: n + 100 })) }
    expect(selectors.map(select => select(unrelated))).toEqual(values)
  }
  expect(resolveRoot).not.toHaveBeenCalled()
  const current = useAppStore.getState()
  const renamed = { ...current, tabs: { ...current.tabs, 'agent-0': { ...current.tabs['agent-0']!, name: 'Renamed' } } }
  selectors.forEach(select => select(renamed))
  expect(build).toHaveBeenCalledTimes(2)
  expect(workbenchNavigationCatalog(renamed).tabs.find(tab => tab.tabId === 'agent-0')?.name).toBe('Renamed')
  const remote = { ...renamed, sessions: renamed.sessions.map(s => s.id === 'agent-0' ? { ...s, hostId: 'remote' } : s) }
  expect(selectors[0]!(remote).kind).toBe('unconfirmed')
  expect(selectors[1]!(remote).kind).toBe('session')
  expect(resolveRoot).toHaveBeenCalled()
})

it('keeps mounted object layout consumers asleep for page updates and fresh for a real close', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const { state, browser } = scene(3)
  useAppStore.setState(state, true)
  const element = document.createElement('div'); document.body.appendChild(element)
  const root = createRoot(element)
  let renders = 0
  function Probe() { const value = useWorkbenchObjectLayout('workspace'); renders++; return <output>{value.layout?.groups[0]?.tabOrder.join(',')}</output> }
  try {
    await act(async () => root.render(<Probe />))
    expect(element.textContent).toContain('browser')
    const before = renders
    await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...browser, loading: true, title: 'New' } }))
    await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'unavailable', id: browser.id, error: 'Owner unavailable' }))
    expect(useAppStore.getState().tabs.browser?.regions['browser-region']).toMatchObject({ title: 'New', nativeOwnerUnavailable: true })
    expect(renders).toBe(before)
    await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'closed', id: browser.id }))
    expect(renders).toBeGreaterThan(before)
    expect(element.textContent).not.toContain('browser')
    expect(element.textContent).toContain('agent-0')
  } finally { await act(async () => root.unmount()); element.remove() }
})

it('invalidates structural identity, file scope, membership and binding facts', () => {
  const { state } = scene(2)
  const before = workbenchNavigationTabs(state.tabs)
  const tab = state.tabs['agent-0']!
  const variants = [
    { ...tab, name: 'Named' }, { ...tab, workspaceId: 'other' }, { ...tab, topicId: 'topic' },
    { ...tab, space: { spaceId: 'space', zoneId: 'zone' } },
    { ...tab, layout: { ...tab.layout, activeRegionId: 'another' } },
    { ...tab, regions: { ...tab.regions, 'region-agent-0': { ...tab.regions['region-agent-0']!, kind: 'terminal' as const, phase: 'attached' as const, sessionId: 'replacement' } } },
    { ...tab, regions: { 'region-agent-0': { kind: 'file' as const, workspaceId: 'workspace', regionId: 'region-agent-0', path: 'changed.ts' } } }
  ]
  expect(variants).toHaveLength(7)
  for (const changed of variants) expect(workbenchNavigationTabs({ ...state.tabs, [tab.id]: changed })).not.toBe(before)
  const catalog = workbenchNavigationCatalog(state)
  const without = { ...state.tabs }; delete without['agent-1']
  expect(workbenchNavigationCatalog({ ...state, tabs: without }).tabs).toHaveLength(2)
  expect(workbenchNavigationCatalog({ ...state, projectGroups: [{ groupId: 'group', name: 'Project', projectIds: ['project'] }] }).projectGroups).not.toBe(catalog.projectGroups)
  const browser = state.tabs.browser!
  const surface = browser.regions['browser-region']!
  const changed = { ...state, tabs: { ...state.tabs, browser: { ...browser, regions: { 'browser-region': { ...surface, browserId: 'replacement' } } } } }
  expect(workbenchNavigationCatalog(changed).regions.find(region => region.regionId === 'browser-region')?.browserId).toBe('replacement')
})

it('reuses the structural graph through actual Tab activation and mounted layout and file consumers', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const { state } = scene()
  useAppStore.setState(state, true)
  const build = vi.spyOn(spatial, 'spatialCatalog')
  const selectors = state.sessions.map(s => createSessionProjectFileContextSelector(s.id, {
    workspaceId: 'workspace', tabGroupId: 'group', tabId: s.id, regionId: `region-${s.id}`, sessionId: s.id
  }, () => null))
  const original = selectors.map(select => select(state))
  expect(original).toHaveLength(48)
  expect(original.every(context => context.kind === 'session')).toBe(true)
  const catalog = workbenchNavigationCatalog(state)
  const element = document.createElement('div'); document.body.appendChild(element)
  const root = createRoot(element)
  function Probe() {
    const value = useWorkbenchObjectLayout('workspace')
    return <output>{value.layout?.groups.find(group => group.id === 'group')?.activeTabId}</output>
  }
  try {
    await act(async () => root.render(<><Probe /><Probe /></>))
    expect(build).toHaveBeenCalledTimes(1)
    for (let n = 0; n < 12; n++) {
      const id = `agent-${1 + n % 2}`
      await act(async () => useAppStore.getState().activateTab('workspace', 'group', id, 'local'))
      const current = useAppStore.getState(), group = current.layouts.workspace!.groups[0]!
      expect(current.workbenchSpaceSelection).toMatchObject({ groupId: 'group', tabId: id, regionId: `region-${id}` })
      expect(group.activeTabId).toBe(id)
      expect(group.recentTabIds.at(-1)).toBe(id)
      expect([...element.querySelectorAll('output')].map(node => node.textContent)).toEqual([id, id])
      expect(selectors.map(select => select(current))).toEqual(original)
    }
    expect(build).toHaveBeenCalledTimes(1)
    // Later consumers of this same immutable input must not repeat the layout comparison.
    const current = useAppStore.getState(), keys = Object.keys
    expect(workbenchNavigationCatalog(current)).toBe(catalog)
    let layoutReads = 0
    const read = vi.spyOn(Object, 'keys').mockImplementation(value => {
      if (value === current.layouts) layoutReads++
      return keys(value)
    })
    for (let n = 0; n < 5; n++) expect(workbenchNavigationCatalog(current)).toBe(catalog)
    read.mockRestore()
    expect(layoutReads).toBe(0)
    expect(current.sessions).toBe(state.sessions)
    expect(current.tabs).toBe(state.tabs)
  } finally { await act(async () => root.unmount()); element.remove() }
})

it('refreshes original location and file consumers when membership, order, identity or bindings change', () => {
  const { state } = scene(2), first = state.layouts.workspace!
  const second = createWorkspaceLayout('second', ['agent-1'])
  const layout = { ...first, root: { type: 'split' as const, direction: 'horizontal' as const, ratio: .5,
    first: first.root, second: second.root }, groups: [...first.groups, ...second.groups] }
  const baseline = { ...state, layouts: { workspace: layout } }
  const select = createSessionProjectFileContextSelector('agent-1', {
    workspaceId: 'workspace', tabGroupId: 'group', tabId: 'agent-1', regionId: 'region-agent-1', sessionId: 'agent-1'
  }, () => null)
  const build = vi.spyOn(spatial, 'spatialCatalog'), before = workbenchNavigationCatalog(baseline)
  expect(select(baseline).kind).toBe('session')
  const removed = { ...baseline, layouts: { workspace: { ...layout,
    groups: layout.groups.map(group => group.id === 'group' ? { ...group, tabOrder: group.tabOrder.filter(id => id !== 'agent-1') } : group) } } }
  expect(workbenchNavigationCatalog(removed).locations.filter(location => location.tabId === 'agent-1').map(location => location.groupId)).toEqual(['second'])
  expect(select(removed).kind).toBe('unconfirmed')
  expect(workbenchObjectLayout(removed, 'workspace').layout?.groups[0]?.tabOrder).not.toContain('agent-1')

  const reordered = { ...baseline, layouts: { workspace: { ...layout, groups: [...layout.groups].reverse() } } }
  const next = workbenchNavigationCatalog(reordered)
  expect(next.locations[0]?.groupId).toBe('second')
  expect(workbenchObjectLayout(reordered, 'workspace').layout?.groups.map(group => group.id)).toEqual(['second', 'group'])

  const excluded = { ...baseline, layouts: { workspace: { ...layout, root: second.root } } }
  expect(workbenchNavigationCatalog(excluded).locations.every(location => location.groupId === 'second')).toBe(true)
  expect(select(excluded).kind).toBe('unconfirmed')

  const tab = state.tabs['agent-1']!, surface = tab.regions['region-agent-1']!
  const replaced = { ...baseline, tabs: { ...baseline.tabs, [tab.id]: { ...tab,
    regions: { 'region-agent-1': { ...surface, sessionId: 'replacement' } } } } }
  expect(workbenchNavigationCatalog(replaced).regions.find(region => region.regionId === 'region-agent-1')?.agentSessionId).toBe('replacement')
  expect(select(replaced).kind).toBe('unconfirmed')

  const zoneId = before.tabs[0]!.zoneId!, spaceId = JSON.stringify(['local', _hygiene_fixturePath('other')])
  const linked = { ...baseline, spaceZoneBindings: { [zoneId]: { workspaceId: 'workspace', spaceId } } }
  expect(workbenchNavigationCatalog(linked).bindings).toContainEqual({ zoneId, spaceId })
  expect(select(linked).placement?.space).toEqual({ zoneId, spaceId })
  expect(build).toHaveBeenCalledTimes(6)
})

it('rebuilds conservatively for root ratios, workspace membership and unknown layout or group fields', () => {
  const { state } = scene(2), layout = state.layouts.workspace!
  const build = vi.spyOn(spatial, 'spatialCatalog')
  const catalog = workbenchNavigationCatalog(state)
  const variants = [
    { workspace: { ...layout, root: { type: 'split' as const, direction: 'horizontal' as const, ratio: .4,
      first: layout.root, second: layout.root } } },
    { workspace: layout, other: createWorkspaceLayout('empty') },
    { workspace: { ...layout, future: undefined } },
    { workspace: { ...layout, groups: layout.groups.map(group => ({ ...group, future: undefined })) } },
    { workspace: { ...layout, future: 1 } },
    { workspace: { ...layout, next: 1 } }
  ]
  for (const layouts of variants) {
    const before = build.mock.calls.length
    expect(workbenchNavigationCatalog({ ...state, layouts })).toEqual(catalog)
    expect(build).toHaveBeenCalledTimes(before + 1)
  }
})
