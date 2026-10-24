// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot } from './helpers/client-ui-render'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { installNativePopover } from './fixtures/mote-workface'

vi.mock('react-resizable-panels', () => createRequire(import.meta.url)(
  '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// Keep App, both presentation owners, SessionPane and BrowserPane actual.
// Native PTY painting cannot run in happy-dom; it owns no placement decisions.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => createElement('div', { 'data-native-paint-isolated': '' }) }))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'

it.each([['terminal', false], ['terminal', true], ['activity', false], ['activity', true]] as const)('Browser toolbar closure retains the exact mixed Focus Tab in %s mode (closed event first: %s)', async (mode, eventFirst) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useAppStore.getState(), launchers = useLauncherState.getState()
  const restorePopover = installNativePopover()
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  try {
    const config = await api.config.get(), snapshot = await api.sessions.snapshot()
    const resource = { ...config.workspaces.find(item => item.id === 'workspace-demo')!, path: fixturePath('focus-close/resource') }
    const display = { ...resource, id: 'close-display', path: fixturePath('focus-close/display') }
    const session = { ...snapshot.sessions.find(item => item.id === 'session-codex')!, workspacePath: resource.path }
    const a = await api.browser.create('close-a', 'https://first.example.test/', resource.id)
    const b = await api.browser.create('close-b', 'https://second.example.test/', resource.id)
    let tab = createWorkbenchTab('close-tab', { kind: 'agent', phase: 'attached', workspaceId: resource.id, regionId: 'agent', sessionId: session.id })
    tab = addWorkbenchRegion(tab, 'agent', 'right', { ...a, kind: 'browser', workspaceId: resource.id, regionId: 'browser-a', browserId: a.id })
    tab = addWorkbenchRegion(tab, 'browser-a', 'down', { ...b, kind: 'browser', workspaceId: resource.id, regionId: 'browser-b', browserId: b.id })
    const layout = createWorkspaceLayout('first-group', [tab.id])
    const exactGroup = { ...layout.groups[0]!, id: 'exact-group' }
    useLauncherState.setState({ persistenceIssue: null, sections: {}, drafts: {}, executors: {} })
    useAppStore.setState({ ...initial, initialize: async () => () => {}, loading: false,
      config: { ...config, workspaces: [resource, display] }, sessions: [session], tabs: { [tab.id]: tab },
      layouts: { [resource.id]: createWorkspaceLayout('resource-group', [tab.id]), [display.id]: {
        ...layout, root: { type: 'split', direction: 'horizontal', ratio: .5, first: layout.root, second: { type: 'leaf', groupId: exactGroup.id } },
        groups: [...layout.groups, exactGroup] } }, mainSurface: 'workbench', activeWorkspaceId: resource.id,
      toolsOpen: false, projectRailOpen: false, agentComposerDrafts: { [session.id]: 'Keep this unsent draft' },
      agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }
    }, true)
    await act(async () => root.render(createElement(App)))
    await act(async () => {
      useAppStore.getState().setViewMode(session.id, 'terminal')
      useAppStore.getState().focusRegion(display.id, tab.id, 'browser-a', 'pointer', exactGroup.id)
      useAppStore.getState().setMainSurface('agents')
    })
    await act(async () => useAppStore.getState().setViewMode(session.id, mode))
    const focus = () => container.querySelector<HTMLElement>('.focused-tab-workspace')!
    const primary = focus().querySelector<HTMLElement>('[data-workbench-primary-tab-id]')!
    expect(primary).not.toBeNull()
    const parent = primary.parentElement
    const before = useAppStore.getState(), originalBrowser = before.tabs[tab.id]!.regions['browser-b']
    if (eventFirst) {
      const close = api.browser.close
      vi.spyOn(api.browser, 'close').mockImplementation(async id => {
        await close(id)
        useAppStore.getState().applyBrowserEvent({ type: 'closed', id })
      })
    }
    const button = focus().querySelector<HTMLButtonElement>('[data-workbench-region-id="browser-a"] .browser-toolbar__close')!
    expect(button).not.toBeNull()
    await act(async () => { button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); button.click() })
    const after = useAppStore.getState()
    expect(Object.keys(after.tabs[tab.id]!.regions).sort()).toEqual(['agent', 'browser-b'])
    expect(after.tabs[tab.id]!.regions['browser-b']).toBe(originalBrowser)
    expect(after.workbenchSpaceSelection).toMatchObject({ workspaceId: display.id, groupId: exactGroup.id, tabId: tab.id })
    expect(focus().querySelector('[data-workbench-primary-tab-id]')).toBe(primary)
    expect(primary.parentElement).toBe(parent)
    expect([...focus().querySelectorAll('[data-workbench-region-id]')].map(node => node.getAttribute('data-workbench-region-id')).sort()).toEqual(['agent', 'browser-b'])
    expect(after.sessions).toBe(before.sessions)
    expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
    // Repeated Launcher closure exercises the same stale-caret branch without
    // granting input to a secondary or changing the surviving Browser identity.
    let launcher: string | undefined
    await act(async () => { launcher = useAppStore.getState().splitRegion(resource.id, tab.id, 'agent', 'down') })
    expect(launcher).toBeDefined()
    await act(async () => useAppStore.getState().focusRegion(display.id, tab.id, launcher!, 'pointer', exactGroup.id))
    await act(async () => useAppStore.getState().closeRegion(resource.id, tab.id, launcher!))
    expect(focus().querySelector('[data-workbench-primary-tab-id]')).toBe(primary)
    expect(primary.parentElement).toBe(parent)
  } finally {
    await act(async () => root.unmount()); container.remove(); restorePopover()
    useAppStore.setState(initial, true); useLauncherState.setState(launchers, true)
    vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})
