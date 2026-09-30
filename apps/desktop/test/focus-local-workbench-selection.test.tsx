// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
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
import { useAppStore } from '../src/renderer/src/store'
import { restoreAgentFocus, sanitizeAgentFocus } from '../src/renderer/src/lib/agent-focus'
import { installNativePopover } from './fixtures/mote-workface'
const initial = useAppStore.getState()
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); window.localStorage.clear()
  leaves.mounts = []; leaves.unmounts = []
  const restorePopover = installNativePopover(), config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const resource = { ...config.workspaces.find(item => item.id === 'workspace-demo')!, path: '/private/resource-a' }
  const display = { ...resource, id: 'display-b', name: 'Display B', path: '/private/display-b' }
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
    async close() { await act(async () => root.unmount()); container.remove(); restorePopover()
      useAppStore.setState(initial, true); window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
  }
}
it('actual File pointer selects its original occurrence without changing Agent/history/Space or original DOM/Range', async () => {
  const f = await fixture()
  try {
    const before = useAppStore.getState(), leaf = f.container.querySelector<HTMLElement>('[data-selection-leaf="explicit-exact-tab/exact-r2"]')!
    expect(leaf).not.toBeNull(); const paragraph = leaf.querySelector('p')!, text = paragraph.firstChild!
    const range = document.createRange(); range.setStart(text, 9); range.setEnd(text, 17)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    expect(selection.toString()).toBe('readable')
    const mounts = [...leaves.mounts], reads = { page: vi.spyOn(api.sessions, 'historyPage'), timeline: vi.spyOn(api.sessions, 'timeline'), catalog: vi.spyOn(api.sessions, 'historySources') }
    await f.chooseFile(); const after = useAppStore.getState()
    expect(after.agentFocus.execution.reference).toEqual(f.file)
    expect(after.agentFocus.execution.sessionId).toBe(f.session.id)
    expect(after.agentFocus.execution.history).toBe(before.agentFocus.execution.history)
    expect(after.sessions).toBe(before.sessions); expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts)
    expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(f.container.querySelector('[data-selection-leaf="explicit-exact-tab/exact-r2"]')).toBe(leaf)
    expect(selection.getRangeAt(0)).toBe(range); expect(selection.toString()).toBe('readable')
    expect(leaf.querySelector('textarea')?.value).toBe('Original unsent draft')
    expect(leaves.mounts).toEqual(mounts); expect(leaves.unmounts).toEqual([])
    for (const read of Object.values(reads)) expect(read).not.toHaveBeenCalled()
  } finally { await f.close() }
})
it('Tab-level Focus has no parent Group chrome and keeps the original mixed Tab during resource restoration', async () => {
  const f = await fixture()
  try {
    const before = useAppStore.getState(), slot = f.container.querySelector('.focused-tab-workspace')!
    expect(slot).not.toBeNull()
    expect(slot.querySelectorAll('[data-workbench-region-id]')).toHaveLength(2)
    expect(slot.querySelectorAll('.pane-tabbar')).toHaveLength(0)
    expect(slot.querySelectorAll('button[title="New tab"]')).toHaveLength(0)
    expect(f.container.querySelectorAll('.workspace-workbench-registry .pane-tabbar').length).toBeGreaterThan(0)
    const originalLeaf = slot.querySelector('[data-selection-leaf="explicit-exact-tab/exact-r2"]')
    expect(originalLeaf).not.toBeNull()
    const { [f.resource.id]: _resourceLayout, ...remainingLayouts } = before.layouts
    await act(async () => useAppStore.setState({ layouts: remainingLayouts }))
    expect(f.container.querySelector('.focused-tab-workspace .workbench-restore-notice')?.textContent).toContain('still restoring')
    expect(f.container.querySelector('[data-selection-leaf="explicit-exact-tab/exact-r2"]')).toBe(originalLeaf)
    await act(async () => useAppStore.setState({ layouts: before.layouts }))
    expect(f.container.querySelector('.focused-tab-workspace .workbench-restore-notice')).toBeNull()
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
  } finally { await f.close() }
})
it('the original Launcher submit keeps its resource Workspace and exact display Group at the real API boundary', async () => {
  const f = await fixture()
  try {
    const before = useAppStore.getState(), held = before.agentFocus.execution
    // Create through the existing original Store owner, then explicitly select
    // that Tab occurrence. A Tab-level presentation does not mint parent chrome.
    let created: string | null = null
    await act(async () => {
      created = useAppStore.getState().openLauncher({ workspaceId: f.resource.id,
        displayWorkspaceId: f.display.id, tabGroupId: f.reference.groupId, reveal: false })
      expect(created).not.toBeNull()
      const tab = useAppStore.getState().tabs[created!]!
      useAppStore.getState().selectExecutionFocusReference({ ...f.reference, tabId: tab.id, regionId: tab.layout.activeRegionId }, held)
    })
    const state = useAppStore.getState(), reference = state.agentFocus.execution.reference!
    expect(f.container.querySelector('.focused-tab-workspace .launch-surface')).not.toBeNull()
    const submit = vi.fn(state.launchAgent)
    await act(async () => useAppStore.setState({ launchAgent: submit }))
    // Only the external API reply is left pending; the original Launcher/Store launch path runs.
    const request = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(() => new Promise(() => {}))
    const launch = f.container.querySelector<HTMLButtonElement>('.focused-tab-workspace .launch-surface__footer .primary-button')!
    expect(launch).not.toBeNull(); expect(launch.disabled).toBe(false)
    await act(async () => launch.click())
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![2]).toBe(f.reference.groupId)
    expect(submit.mock.calls[0]![3]).toEqual({ tabId: reference.tabId, regionId: reference.regionId })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![0]).toMatchObject({ workspacePath: f.resource.path, hostId: f.resource.hostId })
    expect(useAppStore.getState().tabs[reference.tabId]!.workspaceId).toBe(f.resource.id)
    expect(useAppStore.getState().activeWorkspaceId).toBe(state.activeWorkspaceId)
    expect(useAppStore.getState().layouts[f.display.id]!.groups.find(group => group.id === f.reference.groupId)!.tabOrder).toContain(reference.tabId)
    expect(useAppStore.getState().sessions.find(session => session.id === f.session.id)?.control).toBe(f.session.control)
    const after = useAppStore.getState()
    expect(after.agentFocus.execution.sessionId).toBe(held.sessionId)
    expect(after.agentFocus.execution.history).toBe(held.history)
    expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(after.activeWorkspaceId).toBe(before.activeWorkspaceId)
    for (const [id, layout] of Object.entries(before.layouts)) {
      expect(after.layouts[id]!.activeGroupId).toBe(layout.activeGroupId)
      expect(after.layouts[id]!.groups.map(group => [group.id, group.activeTabId])).toEqual(layout.groups.map(group => [group.id, group.activeTabId]))
    }
  } finally { await f.close() }
})
it('rejects the late old held tuple and old semantic Agent intent without overwriting newer local selection', async () => {
  const f = await fixture()
  try {
    const old = useAppStore.getState().agentFocus.execution
    await f.chooseFile(); const current = useAppStore.getState()
    await act(async () => current.selectExecutionFocusReference(f.reference, old))
    expect(useAppStore.getState().agentFocus).toBe(current.agentFocus)
    await act(async () => current.focusExecutionSession(f.other.id))
    const newer = useAppStore.getState()
    await act(async () => newer.selectExecutionFocusReference(f.file, current.agentFocus.execution))
    expect(useAppStore.getState().agentFocus).toBe(newer.agentFocus)
    expect(newer.agentFocus.execution.sessionId).toBe(f.other.id)
  } finally { await f.close() }
})
it('actual Settings click rejects old selection and returns the original DOM/Range; another main surface rejects it too', async () => {
  const f = await fixture()
  try {
    const before = useAppStore.getState(), leaf = f.container.querySelector<HTMLElement>('[data-selection-leaf="explicit-exact-tab/exact-r2"]')!
    expect(leaf).not.toBeNull(); const text = leaf.querySelector('p')!.firstChild!, range = document.createRange()
    range.setStart(text, 9); range.setEnd(text, 17); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    const settings = f.container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
    expect(settings).not.toBeNull(); await act(async () => settings.click())
    expect(f.container.querySelector('.settings-page')).not.toBeNull()
    await act(async () => useAppStore.getState().selectExecutionFocusReference(f.file, before.agentFocus.execution))
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    await act(async () => settings.click())
    expect(f.container.querySelector('.settings-page')).toBeNull()
    expect(f.container.querySelector('[data-selection-leaf="explicit-exact-tab/exact-r2"]')).toBe(leaf)
    expect(selection.getRangeAt(0)).toBe(range); expect(selection.toString()).toBe('readable')
    expect(leaf.querySelector('textarea')?.value).toBe('Original unsent draft')
    await act(async () => useAppStore.getState().setMainSurface('survey'))
    const away = useAppStore.getState()
    await act(async () => away.selectExecutionFocusReference(f.file, away.agentFocus.execution))
    expect(useAppStore.getState().agentFocus).toBe(away.agentFocus)
  } finally { await f.close() }
})
it('rejects deleted/root-excluded occurrences, retains the exact reference, and never picks another location', async () => {
  const f = await fixture()
  try {
    const before = useAppStore.getState()
    await act(async () => before.selectExecutionFocusReference({ ...f.file, regionId: 'deleted-region' }, before.agentFocus.execution))
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    const layout = before.layouts[f.display.id]!
    await act(async () => useAppStore.setState({ layouts: { ...before.layouts, [f.display.id]: { ...layout,
      root: { type: 'leaf', groupId: 'display-first-group' } } } }))
    const excluded = useAppStore.getState()
    await act(async () => excluded.selectExecutionFocusReference(f.file, excluded.agentFocus.execution))
    expect(useAppStore.getState().agentFocus).toBe(excluded.agentFocus)
    expect(excluded.agentFocus.execution.reference).toEqual(f.reference)
    expect(f.container.querySelector('.focused-tab-workspace')).toBeNull()
    expect(f.container.querySelector('.focus-location-recovery')?.textContent).toContain('no longer confirmed')
  } finally { await f.close() }
})
it('original durable reference restores a non-Agent content occurrence independently of Agent initial choices', async () => {
  const f = await fixture()
  try {
    await f.chooseFile(); const before = useAppStore.getState()
    expect(before.agentFocus.execution.reference).toEqual(f.file)
    const saved = JSON.parse(JSON.stringify(before.agentFocus)), restored = sanitizeAgentFocus(restoreAgentFocus(saved), before.sessions, () => 'execution')
    await act(async () => useAppStore.setState({ agentFocus: restored }))
    expect(useAppStore.getState().agentFocus.execution.reference).toEqual(f.file)
    expect(f.container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(f.exact.id)
    const unknown = sanitizeAgentFocus(restoreAgentFocus(saved), [], () => 'execution', new Set([f.session.id]))
    expect(unknown.execution.reference).toEqual(f.file)
    await act(async () => useAppStore.setState({ agentFocus: unknown, sessions: [] }))
    expect(f.container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(f.exact.id)
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  } finally { await f.close() }
})
