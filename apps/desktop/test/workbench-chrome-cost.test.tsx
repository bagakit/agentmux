// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act } from 'react'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../src/renderer/src/App'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { MoteWorkfaceContext } from '../src/renderer/src/lib/mote-workface'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import type { SessionSnapshot } from '../src/shared/contracts'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNativePopover, moteTopic } from './fixtures/mote-workface'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// Only the native drawing leaf is isolated. App, Pane/Tab ownership, SessionPane
// and the global chrome's Store subscription are the actual product code.
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({ session }: { session: SessionSnapshot }) => <div data-test-terminal={session.control.run.runId} />
}))

const dom = composerDOM()
const chromeSelector = '.top-row-leading-chrome'
const slots = () => [...dom.container.querySelectorAll<HTMLElement>('.workspace-workbench-slot')]
const region = (id: string) => dom.container.querySelector<HTMLElement>(`[data-workbench-region-id="${id}"]`)!
const terminal = (id: string) => dom.container.querySelector<HTMLElement>(`[data-test-terminal="run-${id}"]`)!
let checks = 0
let restorePopover: () => void

beforeEach(() => {
  window.localStorage.clear()
  restorePopover = installNativePopover()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('__agentmuxCountWorkbenchChromeRead', () => { checks++ })
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
})
afterEach(() => {
  restorePopover()
  window.localStorage.clear()
})
afterAll(() => vi.unstubAllGlobals())

function scene(count: number) {
  const base = composerConfig.workspaces[0]!
  const workspaces = Array.from({ length: count }, (_, index) => ({
    ...base, id: 'workspace-' + index, name: 'Workspace ' + index, path: base.path + '/workbench-' + index,
    branch: 'branch-' + index
  }))
  const active = workspaces[0]!, next = workspaces.at(-1)!
  // Six live presentation Sessions at the larger size, including the Workspace
  // hidden at startup and opened below.
  const sessions = [...workspaces.slice(0, Math.min(5, count - 1)), next]
    .map(workspace => ({ ...composerSession(workspace.id), workspacePath: workspace.path }))
  const tabs = Object.fromEntries(workspaces.map(workspace => {
    const tab = createWorkbenchTab('tab-' + workspace.id, { kind: 'agent', phase: 'attached',
      workspaceId: workspace.id, regionId: 'region-' + workspace.id, sessionId: workspace.id })
    return [tab.id, tab]
  }))
  const layouts = Object.fromEntries(workspaces.map(workspace => [
    workspace.id, createWorkspaceLayout('group-' + workspace.id, ['tab-' + workspace.id])
  ]))
  const extra = createWorkbenchTab('split-neighbor', { kind: 'agent', phase: 'attached',
    workspaceId: active.id, regionId: 'split-neighbor-region', sessionId: 'retained-neighbor' })
  tabs[extra.id] = extra
  const first = layouts[active.id]!, second = createWorkspaceLayout('split-group', [extra.id])
  layouts[active.id] = { ...first, root: { type: 'split', direction: 'horizontal', ratio: 0.5,
    first: first.root, second: second.root }, groups: [...first.groups, ...second.groups] }
  const drafts = { [active.id]: 'Original unsent draft' }
  useAppStore.setState({
    config: { ...composerConfig, workspaces }, loading: false, initialize: async () => () => {},
    mainSurface: 'workbench', activeWorkspaceId: active.id, workbenchSpaceSelection: null,
    projectRailOpen: false, toolsOpen: false, sessions, tabs, layouts, timelines: {},
    viewModes: Object.fromEntries(sessions.map(session => [session.id, 'terminal' as const])),
    agentComposerDrafts: drafts, prewarmTerminal: async () => {},
    scratchTopicSnapshots: {}
  })
  return { active, next, sessions, tabs, layouts, drafts }
}

it.each([4, 88])('only observes global window controls in the current owner among %i mounted Workspaces', async count => {
  const original = scene(count)
  await dom.render(<App />)
  const retained = slots()
  expect(retained).toHaveLength(count)
  expect(retained.map(slot => slot.querySelectorAll('.pane-tabbar--chrome-owner').length)).toEqual(Array(count).fill(1))
  const firstSlot = retained.find(slot => slot.dataset.workspaceId === original.active.id)!
  const nextSlot = retained.find(slot => slot.dataset.workspaceId === original.next.id)!
  expect(firstSlot.dataset.visible).toBe('true')
  expect(nextSlot.dataset.visible).toBe('false')
  const originalRegion = region('region-' + original.active.id)
  const originalPane = originalRegion.querySelector('.agent-surface')
  const originalTerminal = terminal(original.active.id)
  const nextTerminal = terminal(original.next.id)
  const originalSplit = firstSlot.querySelector('.pane-split')
  expect(originalPane).not.toBeNull()
  expect(originalTerminal).not.toBeNull()
  expect(nextTerminal).not.toBeNull()
  expect(originalSplit).not.toBeNull()
  expect(dom.container.querySelectorAll('[data-test-terminal]')).toHaveLength(original.sessions.length)
  expect(checks).toBeGreaterThan(0)

  const chromeCount = retained.reduce((sum, slot) => sum + slot.querySelectorAll(chromeSelector).length, 0)
  checks = 0
  for (let index = 0; index < 8; index++) await act(async () => {
    useAppStore.setState({ agentNames: { unrelated: 'Other agent ' + index } })
  })
  expect.soft(chromeCount, 'Mounted leading chrome instances').toBe(1)
  expect.soft(checks, 'The actual chrome selector runs once per unrelated Store write').toBe(8)
  expect(firstSlot.querySelector('.breadcrumbs')?.textContent).toBe('branch-0')

  await act(async () => useAppStore.getState().selectWorkspace(original.next.id))
  expect(firstSlot.dataset.visible).toBe('false')
  expect(firstSlot.querySelector(chromeSelector)).toBeNull()
  expect(nextSlot.dataset.visible).toBe('true')
  expect(nextSlot.querySelector('.breadcrumbs')?.textContent).toBe(original.next.branch)
  expect(terminal(original.next.id)).toBe(nextTerminal)
  await act(async () => useAppStore.getState().selectWorkspace(original.active.id))
  expect(firstSlot.querySelector('.breadcrumbs')?.textContent).toBe('branch-0')
  const toggle = firstSlot.querySelector<HTMLButtonElement>('[data-project-rail-toggle]')!
  expect(toggle).not.toBeNull()
  await act(async () => toggle.click())
  expect(useAppStore.getState().projectRailOpen).toBe(true)
  expect(region('region-' + original.active.id)).toBe(originalRegion)
  expect(originalRegion.querySelector('.agent-surface')).toBe(originalPane)
  expect(terminal(original.active.id)).toBe(originalTerminal)
  expect(firstSlot.querySelector('.pane-split')).toBe(originalSplit)
  expect(useAppStore.getState().sessions).toBe(original.sessions)
  expect(useAppStore.getState().tabs).toBe(original.tabs)
  expect(useAppStore.getState().layouts).toBe(original.layouts)
  expect(useAppStore.getState().agentComposerDrafts).toBe(original.drafts)
})

it('only observes window controls in the original workface of a Mote conversation', async () => {
  const { active } = scene(4)
  const topic = moteTopic('launcher:chrome-cost', 'Original Mote', true)
  const scope = { workspace: active, topic, rootPath: topic.directoryPath, floating: false,
    selectTab() {}, selectReference: () => false }
  const render = (presentation: 'conversation' | 'workface') => dom.render(
    <MoteWorkfaceContext.Provider value={{ ...scope, presentation }}>
      <WorkspaceWorkbench workspaceId={active.id} visible />
    </MoteWorkfaceContext.Provider>
  )
  await render('workface')
  const header = dom.container.querySelector<HTMLElement>('.pane-tabbar--chrome-owner')!
  const originalTerminal = terminal(active.id)
  expect(header.hidden).toBe(false)
  expect(header.querySelector(chromeSelector)).not.toBeNull()
  expect(originalTerminal).not.toBeNull()
  await render('conversation')
  expect(header.hidden).toBe(true)
  expect.soft(header.querySelector(chromeSelector)).toBeNull()
  checks = 0
  await act(async () => useAppStore.setState({ agentNames: { unrelated: 'Other Agent' } }))
  expect(checks).toBe(0)
  expect(terminal(active.id)).toBe(originalTerminal)
  await render('workface')
  expect(header.hidden).toBe(false)
  expect(header.querySelector('[data-project-rail-toggle]')).not.toBeNull()
  expect(terminal(active.id)).toBe(originalTerminal)
})
