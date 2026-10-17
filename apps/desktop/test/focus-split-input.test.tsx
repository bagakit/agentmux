// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRequire } from 'node:module'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNativePopover } from './fixtures/mote-workface'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { App } from '../src/renderer/src/App'

vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// Native PTY painting is outside this DOM test. Original App, SessionPane,
// BrowserPane, retained hosts, panel library and Store remain the consumers.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => createElement('div', { 'data-original-terminal': '' }) }))
const dom = composerDOM(), workspace = composerConfig.workspaces[0]!, session = composerSession('original-agent')
let restorePopover: () => void
beforeEach(() => {
  restorePopover = installNativePopover()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { restorePopover(); vi.unstubAllGlobals() })
async function fixture(mode: 'terminal' | 'activity', direction: 'right' | 'down' = 'right', selected = 'agent-region', nested = false) {
  const browser = await api.browser.create('original-page', 'about:blank', workspace.id)
  let tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id, regionId: 'agent-region', sessionId: session.id })
  tab = addWorkbenchRegion(tab, 'agent-region', direction, { ...browser, kind: 'browser', workspaceId: workspace.id, regionId: 'browser-region', browserId: browser.id })
  if (nested) tab = addWorkbenchRegion(tab, 'browser-region', 'down', { ...browser, kind: 'browser', workspaceId: workspace.id, regionId: 'browser-copy', browserId: browser.id })
  tab = { ...tab, layout: { ...tab.layout, root: { ...tab.layout.root, ratio: 0.63 } as typeof tab.layout.root } }
  useAppStore.setState({ initialize: async () => () => {}, loading: false, sessions: [session], timelines: {},
    tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [tab.id]) },
    scratchTopicSnapshots: {}, mainSurface: 'agents', activeWorkspaceId: workspace.id, workbenchSpaceSelection: null,
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    viewModes: { [session.id]: mode }, agentComposerDrafts: { [session.id]: 'Retain this original draft' } })
  const reference = { displayWorkspaceId: workspace.id, groupId: 'original-group', tabId: tab.id, regionId: selected }
  expect(useAppStore.getState().selectMainRegion(reference, null)).toBe(true)
  await dom.render(<App />)
  const scope = dom.container.querySelector('.focused-tab-workspace')!
  expect(scope).not.toBeNull()
  const slot = scope.querySelector('.workbench-tab-slot')!
  expect(slot).not.toBeNull()
  return { scope, slot, tab, browser, reference }
}

it.each(['terminal', 'activity'] as const)('%s keeps the physical Tab slot through sibling selection and closes an inactive Browser on its first gesture', async mode => {
  const h = await fixture(mode)
  const button = h.scope.querySelector<HTMLButtonElement>('.browser-toolbar__close')!
  expect(button).not.toBeNull()
  const choice = useAppStore.getState().workbenchSpaceSelection
  const originalDrafts = useAppStore.getState().agentComposerDrafts
  // Chromium focuses the pressed button before click. The actual browser proof
  // supplies native down/up; here we isolate that focus/selection interval.
  await act(async () => { button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); button.focus() })
  expect(h.scope.querySelector('.workbench-tab-slot')).toBe(h.slot)
  expect(button.isConnected).toBe(true)
  await act(async () => button.click())
  expect(useAppStore.getState().tabs[h.tab.id]!.regions['browser-region']).toBeUndefined()
  expect(useAppStore.getState().tabs[h.tab.id]!.regions['agent-region']).toMatchObject({ sessionId: session.id })
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ ...choice, regionId: 'agent-region' })
  expect(useAppStore.getState().agentComposerDrafts).toBe(originalDrafts)
  expect(useAppStore.getState().sessions[0]!.control).toBe(session.control)
})

it.each(['right', 'down'] as const)('the secondary Activity/Browser %s split uses the original equalize control and durable ratio owner', async direction => {
  const h = await fixture('activity', direction)
  expect(h.scope.querySelector('.workbench-browser-presentation-split')).not.toBeNull()
  const handle = h.scope.querySelector<HTMLElement>('[aria-label="Resize split"]')
  expect(handle, 'the visible secondary layout has a real split handle').not.toBeNull()
  const selection = useAppStore.getState().workbenchSpaceSelection
  await act(async () => handle!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(useAppStore.getState().tabs[h.tab.id]!.layout.root).toMatchObject({ ratio: 0.5 })
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(selection)
  expect(h.scope.querySelector('.workbench-tab-slot')).toBe(h.slot)
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Retain this original draft')
})


it.each(['terminal', 'activity'] as const)('%s closes the inactive Agent on its first gesture without closing its Browser neighbor', async mode => {
  const h = await fixture(mode, 'right', 'browser-region')
  const closeBrowser = vi.spyOn(api.browser, 'close'), stop = vi.spyOn(api.sessions, 'stop')
  const button = h.scope.querySelector<HTMLButtonElement>('[data-workbench-region-id="agent-region"] .workbench-region__close')!
  expect(button).not.toBeNull()
  await act(async () => { button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); button.focus() })
  expect(h.scope.querySelector('.workbench-tab-slot')).toBe(h.slot)
  expect(button.isConnected).toBe(true)
  await act(async () => button.click())
  expect(useAppStore.getState().tabs[h.tab.id]!.regions['agent-region']).toBeUndefined()
  expect(useAppStore.getState().tabs[h.tab.id]!.regions['browser-region']).toMatchObject({ browserId: h.browser.id })
  expect(closeBrowser).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions[0]!.control).toBe(session.control)
})

it('a secondary nested split commits to its exact subtree without changing its parent ratio or original choice', async () => {
  const h = await fixture('activity', 'right', 'agent-region', true)
  const handles = h.scope.querySelectorAll<HTMLElement>('[aria-label="Resize split"]')
  expect(handles).toHaveLength(2)
  const selection = useAppStore.getState().workbenchSpaceSelection
  await act(async () => handles[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  const root = useAppStore.getState().tabs[h.tab.id]!.layout.root
  expect(root).toMatchObject({ type: 'split', ratio: 0.63, second: { type: 'split', direction: 'vertical', ratio: 0.6 } })
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(selection)
})
