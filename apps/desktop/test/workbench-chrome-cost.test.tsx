// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act } from 'react'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec'
import { App } from '../src/renderer/src/App'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { MoteWorkfaceContext } from '../src/renderer/src/lib/mote-workface'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import type { SessionSnapshot } from '../src/shared/contracts'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNativePopover, moteTopic } from './fixtures/mote-workface'

const surfaceLoad = vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  const fixture = {
    evaluated: [] as string[], requests: [] as string[], held: '', failed: '', release: undefined as (() => void) | undefined,
    load<T>(surface: string, load: () => Promise<T>): Promise<T> {
      fixture.requests.push(surface)
      if (surface === fixture.failed) return Promise.reject(new Error('Private surface module unavailable'))
      if (surface === fixture.held) return new Promise((resolve, reject) => {
        fixture.release = () => { void load().then(resolve, reject) }
      })
      return load()
    }
  }
  vi.stubGlobal('__agentmuxSurfaceLoad', fixture)
  return fixture
})
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
let layoutCalls: string[]
let restorePopover: () => void

beforeEach(() => {
  window.localStorage.clear()
  surfaceLoad.requests.length = 0
  surfaceLoad.held = surfaceLoad.failed = ''
  surfaceLoad.release = undefined
  restorePopover = installNativePopover()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('__agentmuxCountWorkbenchChromeRead', () => { checks++ })
  layoutCalls = []
  vi.stubGlobal('__agentmuxCountWorkbenchLayout', (workspaceId: string) => { layoutCalls.push(workspaceId) })
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
    mainSurface: 'workbench', focusView: 'list', activeWorkspaceId: active.id, workbenchSpaceSelection: null,
    projectRailOpen: false, toolsOpen: false, sessions, tabs, layouts, timelines: {},
    viewModes: Object.fromEntries(sessions.map(session => [session.id, 'terminal' as const])),
    agentComposerDrafts: drafts, prewarmTerminal: async () => {},
    scratchTopicSnapshots: {}
  })
  return { active, next, sessions, tabs, layouts, drafts }
}

it('loads only the actual requested surface and confirms it through its original public reader', async () => {
  const original = scene(4)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({})
  })
  await dom.render(<App />)
  const originalRegion = region('region-' + original.active.id)
  const originalTerminal = terminal(original.active.id)
  expect(originalTerminal).not.toBeNull()
  expect(surfaceLoad.evaluated).toEqual([])
  expect(surfaceLoad.requests).toEqual([])

  const inspect = await parseAgentMuxCliInvocation(['app', 'inspect'])
  const focus = await parseAgentMuxCliInvocation(['app', 'focus', '--surface', 'goals'])
  expect(inspect.command.method).toBe('app.inspect')
  expect(focus.command.method).toBe('app.focus')
  const control = () => useAppStore.getState()
  const inspectPresentation = () => control().executeControl(rpcControlRequest('app.inspect', inspect.params))
  surfaceLoad.held = 'Goals'
  const navigate = rpcControlRequest('app.focus', focus.params)
  let opening!: ReturnType<ReturnType<typeof control>['executeControl']>
  await act(async () => { opening = control().executeControl(navigate) })
  expect(surfaceLoad.requests).toEqual(['Goals'])
  expect(surfaceLoad.evaluated).toEqual([])
  expect(dom.container.querySelector('[data-loading-phase="loading"]')).not.toBeNull()
  expect(await inspectPresentation()).toMatchObject({ observation: { desktop: { presentation: { state: 'pending' } } } })
  await act(async () => { surfaceLoad.release!(); await vi.dynamicImportSettled() })
  expect(dom.container.querySelector('[data-desktop-goals-view]')).not.toBeNull()
  let firstReceipt!: Awaited<typeof opening>
  await act(async () => { firstReceipt = await opening })
  expect(firstReceipt.operation).toBe('focus')
  if (firstReceipt.operation === 'focus' && firstReceipt.presentation.state !== 'main-visible') {
    expect(firstReceipt).toMatchObject({ partial: true, presentation: { state: 'pending' } })
  }
  expect(await inspectPresentation()).toMatchObject({ observation: { desktop: { presentation: { state: 'main-visible' } } } })
  await act(async () => {
    expect(await control().executeControl(rpcControlRequest('app.focus', focus.params)))
      .toMatchObject({ presentation: { state: 'main-visible' } })
  })

  const retained: Array<{ selector: string; node: Element }> = []
  for (const [surface, name, selector] of [
    ['agents', 'Focus', '[data-desktop-focus-view="list"]'],
    ['recall', 'Recall', '[data-knowledge-surface="recall"]'],
    ['survey', 'Survey', '[data-knowledge-surface="survey"]']
  ] as const) {
    await act(async () => control().setMainSurface(surface))
    await act(async () => vi.dynamicImportSettled())
    const node = dom.container.querySelector(selector)
    expect(node).not.toBeNull()
    retained.push({ selector, node: node! })
    expect(surfaceLoad.evaluated.at(-1)).toBe(name)
    expect(await inspectPresentation()).toMatchObject({ observation: { desktop: { presentation: { state: 'main-visible' } } } })
  }
  await act(async () => control().setMainSurface('workbench'))
  expect(surfaceLoad.evaluated).toEqual(['Goals', 'Focus', 'Recall', 'Survey'])
  expect(surfaceLoad.requests).toEqual(surfaceLoad.evaluated)
  for (const { selector, node } of retained) expect(dom.container.querySelector(selector)).toBe(node)
  expect(region('region-' + original.active.id)).toBe(originalRegion)
  expect(terminal(original.active.id)).toBe(originalTerminal)
  expect(control().sessions).toBe(original.sessions)
  expect(control().agentComposerDrafts).toBe(original.drafts)
})

it('isolates late and failed module loads and returns to the original workface', async () => {
  const original = scene(4)
  await dom.render(<App />)
  const originalTerminal = terminal(original.active.id)
  expect(originalTerminal).not.toBeNull()
  surfaceLoad.held = 'Survey'
  await act(async () => useAppStore.getState().setMainSurface('survey'))
  expect(dom.container.querySelector('[data-loading-phase="loading"]')).not.toBeNull()
  await act(async () => useAppStore.getState().setMainSurface('workbench'))
  await act(async () => { surfaceLoad.release!(); await vi.dynamicImportSettled() })
  expect(dom.container.querySelector('[data-knowledge-surface="survey"]')).toBeNull()
  surfaceLoad.failed = 'Goals'
  await act(async () => useAppStore.getState().setMainSurface('board'))
  expect(dom.container.querySelector('[data-loading-phase="failed"]')?.textContent).toContain('Could not open Goals')
  const back = [...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Return to Space')
  expect(back).toBeDefined()
  await act(async () => back!.click())
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(terminal(original.active.id)).toBe(originalTerminal)
  expect(useAppStore.getState().agentComposerDrafts).toBe(original.drafts)
  expect(surfaceLoad.requests).toEqual(['Survey', 'Goals'])
})

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

it.each([4, 88])('projects layout only after relevant facts change among %i mounted Workspaces', async count => {
  const { active, sessions, drafts } = scene(count)
  await dom.render(<App />)
  const retained = slots()
  expect(retained).toHaveLength(count)
  expect(new Set(layoutCalls)).toEqual(new Set(retained.map(slot => slot.dataset.workspaceId)))
  const originalRegion = region('region-' + active.id)
  const originalTerminal = terminal(active.id)
  expect(originalRegion).not.toBeNull()
  expect(originalTerminal).not.toBeNull()
  const originalLayout = useAppStore.getState().layouts[active.id]
  expect(originalLayout?.groups.map(group => group.id)).toEqual(['group-' + active.id, 'split-group'])

  layoutCalls = []
  await act(async () => useAppStore.setState({ selectedDemandId: 'other-goal' }))
  await act(async () => useAppStore.setState(state => ({ spatialRequests: {
    ...state.spatialRequests, 'other-request': { requestId: 'other-request', inputDigest: 'original-operation',
      operation: 'space.mv', tabId: 'other-tab', regionId: 'other-region',
      agentSessionId: 'other-session', createAgent: false, target: { zoneId: 'other-zone' } }
  } })))
  await act(async () => useAppStore.setState({ mainSurface: 'board' }))
  await act(async () => useAppStore.setState({ mainSurface: 'workbench' }))
  expect(layoutCalls.length, 'Unrelated navigation facts must not derive any Workbench layout').toBe(0)

  const choice = { displayWorkspaceId: active.id, groupId: 'split-group', tabId: 'split-neighbor', regionId: 'split-neighbor-region' }
  await act(async () => {
    expect(useAppStore.getState().selectMainRegion(choice)).toBe(true)
  })
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({
    workspaceId: active.id, groupId: choice.groupId, tabId: choice.tabId, regionId: choice.regionId
  })
  expect(new Set(layoutCalls), 'The actual selection reaches only the matching object projector').toEqual(new Set([active.id]))
  expect(useAppStore.getState().layouts[active.id]).toBe(originalLayout)

  layoutCalls = []
  const added = createWorkbenchTab('new-original-tab', { kind: 'agent', phase: 'attached',
    workspaceId: active.id, regionId: 'new-original-region', sessionId: 'new-original-agent' })
  await act(async () => useAppStore.setState(state => {
    const layout = state.layouts[active.id]!
    return { tabs: { ...state.tabs, [added.id]: added }, layouts: { ...state.layouts, [active.id]: {
      ...layout, groups: layout.groups.map(group => group.id === choice.groupId ? { ...group, tabOrder: [...group.tabOrder, added.id] } : group)
    } } }
  }))
  expect(layoutCalls).toContain(active.id)
  expect(dom.container.querySelector(`button[data-workbench-tab-id="${added.id}"]`)).not.toBeNull()
  expect(region('region-' + active.id)).toBe(originalRegion)
  expect(terminal(active.id)).toBe(originalTerminal)
  expect(useAppStore.getState().sessions).toBe(sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
})
