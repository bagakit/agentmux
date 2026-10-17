// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNativePopover } from './fixtures/mote-workface'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { App } from '../src/renderer/src/App'

vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// Real App, projection owners, BrowserPane and SessionPane; native PTY painting is separate.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => createElement('div', { 'data-original-terminal': '' }) }))
const dom = composerDOM(), workspace = composerConfig.workspaces[0]!, session = composerSession('original-agent')
let restorePopover: () => void
beforeEach(() => {
  restorePopover = installNativePopover()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { restorePopover(); vi.unstubAllGlobals() })
async function fixture(mode: 'terminal' | 'activity', selected: string) {
  const browser = await api.browser.create('original-page', 'about:blank', workspace.id)
  let tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id, regionId: 'agent-region', sessionId: session.id })
  tab = addWorkbenchRegion(tab, 'agent-region', 'right', { ...browser, kind: 'browser', workspaceId: workspace.id, regionId: 'browser-region', browserId: browser.id })
  tab = { ...tab, layout: { ...tab.layout, root: { ...tab.layout.root, ratio: 0.63 } as typeof tab.layout.root } }
  useAppStore.setState({ initialize: async () => () => {}, loading: false, sessions: [session], timelines: {},
    tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [tab.id]) },
    scratchTopicSnapshots: {}, mainSurface: 'agents', activeWorkspaceId: workspace.id, workbenchSpaceSelection: null,
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    viewModes: { [session.id]: mode }, agentComposerDrafts: { [session.id]: 'Original draft' } })
  expect(useAppStore.getState().selectMainRegion({ displayWorkspaceId: workspace.id, groupId: 'original-group', tabId: tab.id, regionId: selected }, null)).toBe(true)
  await dom.render(<App />)
  const slot = dom.container.querySelector<HTMLElement>('.focused-tab-workspace .workbench-tab-slot')!
  expect(slot).not.toBeNull()
  return { slot, tab }
}

it.each(['agent-region', 'browser-region'])('retains the original Focus primary through a mode switch with %s selected and its home temporarily unavailable', async selected => {
  const { slot, tab } = await fixture('terminal', selected)
  const primary = slot.querySelector('[data-workbench-primary-tab-id]')!, terminal = slot.querySelector('[data-original-terminal]')
  expect(primary).not.toBeNull(); expect(terminal).not.toBeNull()
  const home = [...dom.container.querySelectorAll<HTMLElement>('.workbench-tab-slot')].find(element => element !== slot && element.dataset.workbenchTabId === tab.id)!
  expect(home).not.toBeNull()
  const homeId = home.id, layout = useAppStore.getState().tabs[tab.id]!.layout, choice = useAppStore.getState().workbenchSpaceSelection
  home.id += ':pending'
  try {
    const button = slot.querySelector<HTMLButtonElement>('[aria-label="Show Activity"]')!
    await act(async () => button.click())
    expect(slot.children).toHaveLength(1)
    expect(slot.firstElementChild).toBe(primary)
    expect(slot.querySelector('[data-original-terminal]')).toBe(terminal)
    expect(useAppStore.getState().tabs[tab.id]!.layout).toBe(layout)
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(choice)
    expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original draft')
    expect(useAppStore.getState().sessions[0]!.control).toBe(session.control)
  } finally { home.id = homeId }
})

it('keeps a single exact Focus primary across repeated reverse switches, and still navigates it to Space', async () => {
  const { slot, tab } = await fixture('activity', 'agent-region')
  await act(async () => useAppStore.getState().setViewMode(session.id, 'terminal'))
  const primary = slot.querySelector('[data-workbench-primary-tab-id]')!, terminal = slot.querySelector('[data-original-terminal]')
  expect(primary).not.toBeNull(); expect(terminal).not.toBeNull()
  for (const mode of ['activity', 'terminal', 'activity'] as const) {
    await act(async () => useAppStore.getState().setViewMode(session.id, mode))
    expect(slot.children).toHaveLength(1)
    expect(slot.firstElementChild).toBe(primary)
    expect(slot.querySelector('[data-original-terminal]')).toBe(terminal)
  }
  await act(async () => useAppStore.getState().setMainSurface('workbench'))
  const home = [...dom.container.querySelectorAll<HTMLElement>('.workbench-tab-slot')].find(element => element !== slot && element.dataset.workbenchTabId === tab.id)!
  expect(home.querySelector('[data-workbench-primary-tab-id]')).toBe(primary)
  expect(useAppStore.getState().sessions[0]!.control).toBe(session.control)
})
