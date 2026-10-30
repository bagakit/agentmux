const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement, useEffect } from 'react'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout, splitWorkbenchRegion, type WorkspaceLayout } from '@agentmux/layout'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)(
  '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
const leaves = vi.hoisted(() => ({ mounts: [] as string[], unmounts: [] as string[] }))
// Keep the App/Global/Workbench/Provider tree actual; isolate only PTY painting.
vi.mock('../src/renderer/src/components/SessionPane', () => ({
  SessionPane: ({ sessionId, linkOrigin }: { sessionId: string; linkOrigin: { tabId: string; regionId: string } }) => {
    const key = `${linkOrigin.tabId}/${linkOrigin.regionId}`
    useEffect(() => { leaves.mounts.push(key); return () => { leaves.unmounts.push(key) } }, [key])
    const draft = useAppStore(state => state.agentComposerDrafts[sessionId] ?? '')
    return createElement('section', { 'data-selection-session': sessionId, 'data-selection-leaf': key },
      createElement('p', {}, 'Original readable content stays here'),
      createElement('textarea', { 'aria-label': `Original draft ${key}`, value: draft, readOnly: true }))
  }
}))
// The Launcher's real warm-shell owner also reaches a PTY painting leaf.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => createElement('div', { 'data-warm-pty-paint-isolated': '' }) }))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore, prepareRendererUpdate } from '../src/renderer/src/store'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { providerCatalogReader } from './helpers/startup-observation-api-fixture'
import { webcrypto } from 'node:crypto'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { mainRegionReference } from '../src/renderer/src/lib/desktop-focus-navigation'
import { restoreAgentFocus, sanitizeAgentFocus } from '../src/renderer/src/lib/agent-focus'
import { installNativePopover } from './fixtures/mote-workface'
const initial = useAppStore.getState()
const initialLauncher = useLauncherState.getState()
async function fixture(single = false, persisted = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); window.localStorage.clear()
  useLauncherState.setState({ persistenceIssue: null, sections: {}, drafts: {}, executors: {} })
  leaves.mounts = []; leaves.unmounts = []
  const restorePopover = installNativePopover(), config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const resource = { ...config.workspaces.find(item => item.id === 'workspace-demo')!, path: _hygiene_fixturePath("private/resource-a") }
  const display = { ...resource, id: 'display-b', name: 'Display B', path: _hygiene_fixturePath("private/display-b") }
  const session = { ...snapshot.sessions.find(item => item.id === 'session-codex')!, workspacePath: resource.path }
  const other = { ...snapshot.sessions.find(item => item.id === 'session-claude')!, workspacePath: resource.path }
  expect(session.kind).toBe('agent'); expect(other.kind).toBe('agent')
  const decoy = createWorkbenchTab('decoy-first-tab', { regionId: 'decoy-region', workspaceId: resource.id,
    kind: 'agent', phase: 'attached', sessionId: session.id }, 'Decoy first')
  const exact = createWorkbenchTab('explicit-exact-tab', { regionId: 'exact-r1', workspaceId: resource.id,
    kind: 'file', path: 'selection.txt' }, 'Original mixed Tab')
  exact.regions['exact-r2'] = { regionId: 'exact-r2', workspaceId: resource.id,
    kind: 'agent', phase: 'attached', sessionId: session.id }
  exact.layout = splitWorkbenchRegion(exact.layout, 'exact-r1', 'right', 'exact-r2')
  if (single) { delete exact.regions['exact-r1']; exact.layout = { root: { type: 'leaf', regionId: 'exact-r2' }, activeRegionId: 'exact-r2' }; exact.titleRegionId = 'exact-r2' }
  const first = createWorkspaceLayout('display-first-group', [exact.id])
  const displayLayout: WorkspaceLayout = { ...first, root: { type: 'split', direction: 'horizontal', ratio: .5,
    first: first.root, second: { type: 'leaf', groupId: 'display-exact-group' } },
    groups: [...first.groups, { ...first.groups[0]!, id: 'display-exact-group' }], activeGroupId: first.activeGroupId }
  useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false,
    config: { ...config, workspaces: [resource, display] }, sessions: [session, other],
    tabs: { [decoy.id]: decoy, [exact.id]: exact },
    layouts: { [resource.id]: createWorkspaceLayout('resource-home-group', [decoy.id, exact.id]), [display.id]: displayLayout },
    mainSurface: 'workbench', activeWorkspaceId: resource.id, toolsOpen: false, projectRailOpen: false,
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [session.id]: 'Original unsent draft' } }, true)
  const reference = { displayWorkspaceId: display.id, groupId: 'display-exact-group', tabId: exact.id, regionId: 'exact-r2' }
  let disposeRuntime = () => {}
  if (persisted) {
    const arranged = useAppStore.getState()
    vi.stubGlobal('crypto', webcrypto)
    vi.spyOn(api.config, 'get').mockResolvedValue(arranged.config!)
    vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
    vi.spyOn(api.demands, 'list').mockResolvedValue([])
    vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: arranged.sessions, timelines: arranged.timelines, recoveryCandidates: [] })
    vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
    const saved = await api.spatial.read()
    await api.spatial.commit({ expectedRevision: saved?.revision ?? 0, graph: desktopSpatialGraph(arranged, [], null) })
    disposeRuntime = await initial.initialize()
    useAppStore.setState({ initialize: async () => () => {} })
  }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(createElement(App)))
  expect(container.querySelector('main.main-shell')).not.toBeNull()
  await act(async () => {
    useAppStore.getState().focusRegion(reference.displayWorkspaceId, reference.tabId, reference.regionId, 'pointer', reference.groupId)
    useAppStore.getState().setMainSurface('agents')
  })
  expect(container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(exact.id)
  const file = { ...reference, regionId: 'exact-r1' }
  return { container, reference, file, resource, display, session, other, exact,
    async chooseFile() {
      const node = container.querySelector<HTMLElement>('.focused-tab-workspace [data-workbench-region-id="exact-r1"]')
      expect(node).not.toBeNull()
      await act(async () => node!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
    },
    async close() { await act(async () => root.unmount()); container.remove(); disposeRuntime(); restorePopover()
      useAppStore.setState(initial, true); useLauncherState.setState(initialLauncher, true); window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
  }
}
it.each([[false, false], [true, false], [true, true]])('actual Focus split followed by closing Launcher keeps Agent (single: %s, persisted: %s)', async (single, persisted) => {
 const f = await fixture(single, persisted)
 try {
  const before = useAppStore.getState(), original = f.container.querySelector('[data-selection-leaf="explicit-exact-tab/exact-r2"]')
  expect(original).not.toBeNull()
  let added: string | undefined
  await act(async () => { added = useAppStore.getState().splitRegion(f.resource.id, f.exact.id, f.reference.regionId, 'right') })
  if (persisted) await act(async () => { await prepareRendererUpdate() })
  const split = useAppStore.getState().tabs[f.exact.id]!
  added ??= Object.keys(split.regions).find(id => !before.tabs[f.exact.id]!.regions[id])
  expect(added).toBeDefined()
  const frame = f.container.querySelector<HTMLElement>(`.focused-tab-workspace [data-workbench-region-id="${added}"]`)!
  expect(frame).not.toBeNull()
  await act(async () => frame.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
  const selected = useAppStore.getState()
  expect(selected.workbenchSpaceSelection?.regionId).toBe(added)
  const button = frame.querySelector<HTMLButtonElement>('[aria-label="Close split"]')!
  expect(button).not.toBeNull()
  await act(async () => { button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); button.click() })
  if (persisted) await act(async () => { await prepareRendererUpdate() })
  const after = useAppStore.getState()
  expect(after.tabs[f.exact.id]!.regions[added!]).toBeUndefined()
  expect(after.workbenchSpaceSelection).toMatchObject({ workspaceId: f.display.id, groupId: f.reference.groupId, tabId: f.exact.id })
  expect(after.tabs[f.exact.id]!.regions[after.workbenchSpaceSelection!.regionId!]).toBeDefined()
  expect(f.container.querySelector('.focus-location-recovery')).toBeNull()
  expect(f.container.querySelector('.focused-tab-workspace')).not.toBeNull()
  expect(f.container.querySelector('[data-selection-leaf="explicit-exact-tab/exact-r2"]')).toBe(original)
  expect(after.sessions).toBe(before.sessions)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
 } finally { await f.close() }
})

it('post-close parent membership change keeps the exact remaining workface available with an honest notice', async () => {
 const f = await fixture(true, true)
 try {
  const state = useAppStore.getState()
  await act(async () => state.splitRegion(f.resource.id, f.exact.id, f.reference.regionId, 'right'))
  const split = useAppStore.getState().tabs[f.exact.id]!
  const added = Object.keys(split.regions).find(id => id !== f.reference.regionId)!
  await act(async () => useAppStore.getState().closeRegion(f.resource.id, f.exact.id, added))
  const before = useAppStore.getState(), choice = before.workbenchSpaceSelection!
  const original = f.container.querySelector('[data-selection-leaf="explicit-exact-tab/exact-r2"]')
  expect(original).not.toBeNull(); expect(choice.zoneId).not.toBeNull(); expect(choice.spaceId).not.toBeNull()
  await act(async () => { const receipt = await useAppStore.getState().setZoneSpaceRelation(choice.zoneId!, choice.spaceId!, false); expect(receipt.outcome).toBe('unlinked') })
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(choice)
  expect(f.container.querySelector('.focused-tab-workspace')).not.toBeNull()
  expect(f.container.querySelector('.focus-location-recovery')).toBeNull()
  expect(f.container.querySelector('.focused-tab-workspace')?.textContent).toContain('membership')
  expect(f.container.querySelector('[data-selection-leaf="explicit-exact-tab/exact-r2"]')).toBe(original)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  const confirm = [...f.container.querySelectorAll<HTMLButtonElement>('.focused-tab-workspace button')].find(button => button.textContent === 'Use current location')
  expect(confirm).toBeDefined()
  await act(async () => confirm!.click())
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual({ ...choice, spaceId: null })
  expect(f.container.querySelector('.focused-tab-workspace')?.textContent).not.toContain('membership is no longer confirmed')
  expect(f.container.querySelector('[data-selection-leaf="explicit-exact-tab/exact-r2"]')).toBe(original)
 } finally { await f.close() }
})

it('a missing exact Group is still unknown and never borrows another display occurrence', async () => {
 const f = await fixture(true)
 try {
  const before = useAppStore.getState(), layout = before.layouts[f.display.id]!
  await act(async () => useAppStore.setState({ layouts: { ...before.layouts, [f.display.id]: { ...layout,
   root: { type: 'leaf', groupId: 'display-first-group' } } } }))
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(f.container.querySelector('.focused-tab-workspace')).toBeNull()
  expect(f.container.querySelector('.focus-location-recovery')?.textContent).toContain('no confirmed Region')
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
 } finally { await f.close() }
})

it.each([false, true])('opens an Agent Session with no confirmed Region and keeps its new Focus location (old reference: %s)', async (staleReference) => {
 const f = await fixture()
 try {
  // The fixture's second Agent belongs to the resource Workspace's Host, so its only missing fact is a Region.
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === f.other.id
   ? { ...session, hostId: f.resource.hostId, control: { ...session.control, hostId: f.resource.hostId } } as typeof session : session) })))
  const placeless = f.other.id
  if (staleReference) await act(async () => useAppStore.setState(state => ({ agentFocus: {
   ...state.agentFocus, execution: { ...state.agentFocus.execution, sessionId: placeless,
    reference: { displayWorkspaceId: f.resource.id, groupId: 'removed-group', tabId: 'removed-tab', regionId: 'removed-region' } }
  } })))
  expect(Object.values(useAppStore.getState().tabs).some(tab => Object.values(tab.regions).some(region =>
   (region.kind === 'agent' || region.kind === 'terminal') && region.sessionId === placeless))).toBe(false)
  const card = f.container.querySelector<HTMLButtonElement>(`button.focus-context[data-session-id="${placeless}"]`)
  expect(card).not.toBeNull()
  await act(async () => card!.click())
  const notice = f.container.querySelector('.focus-location-recovery')
  expect(notice?.textContent).toContain(staleReference
   ? 'The selected Tab or Region occurrence is no longer confirmed'
   : 'No work surface occurrence is currently confirmed for this Session')
  expect(notice?.textContent).not.toContain('Choose a confirmed location')
  expect(notice?.textContent).toContain('Its Run is interrupted')
  const before = useAppStore.getState()
  const open = notice!.querySelector<HTMLButtonElement>('button[data-focus-open-placeless]')
  expect(open?.textContent).toContain('Open in a new Tab')
  await act(async () => open!.click())
  const after = useAppStore.getState()
  const placed = Object.values(after.tabs).flatMap(tab => Object.values(tab.regions).flatMap(region =>
   region.kind === 'agent' && region.sessionId === placeless ? [{ tab, region }] : []))
  expect(placed).toHaveLength(1)
  expect(placed[0]!.region.phase).toBe('attached')
  expect(after.mainSurface).toBe('agents')
  expect(f.container.querySelector('.focus-location-recovery')).toBeNull()
  expect(f.container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(placed[0]!.tab.id)
  expect(f.container.querySelector(`[data-selection-session="${placeless}"]`)).not.toBeNull()
  expect(after.sessions).toBe(before.sessions)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(after.tabs[f.exact.id]).toBe(before.tabs[f.exact.id])
  expect(after.agentFocus.execution.reference).toMatchObject({ tabId: placed[0]!.tab.id, regionId: placed[0]!.region.regionId })
  await act(async () => f.container.querySelector<HTMLButtonElement>(`button.focus-context[data-session-id="${placeless}"]`)!.click())
  expect(f.container.querySelector('.focus-location-recovery')).toBeNull()
  expect(f.container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(placed[0]!.tab.id)
 } finally { await f.close() }
})

it('explains an unavailable resource Workspace and keeps the unplaced Agent and retry action', async () => {
 const f = await fixture()
 try {
  // This original preview Agent is on another Host, with no matching resource Workspace.
  const card = f.container.querySelector<HTMLButtonElement>(`button.focus-context[data-session-id="${f.other.id}"]`)
  expect(card).not.toBeNull()
  await act(async () => card!.click())
  const before = useAppStore.getState()
  const open = f.container.querySelector<HTMLButtonElement>('button[data-focus-open-placeless]')
  expect(open).not.toBeNull()
  await act(async () => open!.click())
  const after = useAppStore.getState()
  expect(after.tabs).toBe(before.tabs)
  expect(after.layouts).toBe(before.layouts)
  expect(after.sessions).toBe(before.sessions)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(after.mainSurface).toBe('agents')
  expect(after.notificationEvents.some(event => event.message.includes('resource Workspace is not available'))).toBe(true)
  expect(f.container.querySelector('.focus-location-recovery')?.textContent).toContain('Open in a new Tab')
  expect(f.container.textContent).toContain('resource Workspace is not available')
 } finally { await f.close() }
})

it('an unobserved retained Agent keeps a readable-work-surface action without claiming cached exit as current', async () => {
 const f = await fixture()
 try {
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === f.other.id
   ? { ...session, processState: 'exited', runUnobserved: true } as typeof session : session) })))
  await act(async () => f.container.querySelector<HTMLButtonElement>(`button.focus-context[data-session-id="${f.other.id}"]`)!.click())
  const notice = f.container.querySelector('.focus-location-recovery')
  expect(notice?.textContent).toContain('current Run state is unknown')
  expect(notice?.textContent).not.toContain('Its Run is exited')
  expect(notice?.textContent).toContain('Open the original conversation in a new Tab')
  expect(notice?.querySelector('[data-focus-open-placeless]')).not.toBeNull()
  expect(useAppStore.getState().sessions.find(session => session.id === f.other.id)?.control).toEqual(f.other.control)
 } finally { await f.close() }
})
