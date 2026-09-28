// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { act, type ComponentProps } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import type { BrowserSnapshot } from '../src/shared/contracts'
import type { SurfaceMemoryCollectionInput } from '../src/renderer/src/lib/surface-memory-budget-candidates'
import type { TerminalParkingCollectionInput } from '../src/renderer/src/lib/terminal-cold-parking-coordinator'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
// Use the installed browser PanelGroup, whose child registration effects are absent in its Node build.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
// Native calls are instrumented; the real App, Store, Workbench, Region portal and BrowserPane run.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: (props: { session: { id: string }; visible?: boolean }) => <div data-terminal-probe={props.session.id} data-visible={props.visible}><textarea defaultValue="Original terminal input" /></div> }))
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => <textarea data-file-probe defaultValue="Original file input" /> }))
const observation = vi.hoisted(() => ({
  memory: [] as { input: SurfaceMemoryCollectionInput; candidates: { id: string; kind: string; visible: boolean; navigationContextActive: boolean }[] }[],
  terminals: [] as { workbenchVisible: boolean; projectedVisibleTabIds?: ReadonlySet<string> | undefined }[],
  stages: [] as { stage: HTMLElement; host: string | null; update: () => void; stopped: boolean }[]
}))
vi.mock('../src/renderer/src/lib/surface-memory-budget-candidates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/lib/surface-memory-budget-candidates')>()
  return { ...actual, collectSurfaceMemoryCandidates: (input: SurfaceMemoryCollectionInput) => {
    const candidates = actual.collectSurfaceMemoryCandidates(input)
    observation.memory.push({ input, candidates }); return candidates
  } }
})
vi.mock('../src/renderer/src/lib/terminal-cold-parking-coordinator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/lib/terminal-cold-parking-coordinator')>()
  return { ...actual, useTerminalColdParking: (options: Parameters<typeof actual.useTerminalColdParking>[0]) => {
    observation.terminals.push(options); return actual.useTerminalColdParking(options)
  } }
})
vi.mock('@floating-ui/dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@floating-ui/dom')>()
  return { ...actual, autoUpdate: (...args: Parameters<typeof actual.autoUpdate>) => {
    const [reference, backing, update, options] = args
    if (!(reference instanceof HTMLElement) || !reference.dataset.nativeBrowserStage) return actual.autoUpdate(reference, backing, update, options)
    const record = { stage: reference, host: reference.closest('.survey-browser-slot')?.id ?? reference.closest('.workbench-tab-slot')?.id ?? null, update, stopped: false }
    observation.stages.push(record); update(); return () => { record.stopped = true }
  } }
})
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab, documentKey, workbenchSurfaces } from '../src/renderer/src/lib/workbench-tabs'
import { collectTerminalColdParkCandidates } from '../src/renderer/src/lib/terminal-cold-parking-coordinator'
import { projectPersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { requestPmoTeamsTopicFloatingClose, requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const realInitialize = useAppStore.getState().initialize
const workspace = composerConfig.workspaces[0]!
const session = composerSession()
const agent = { regionId: 'agent-region', kind: 'agent' as const, phase: 'attached' as const, workspaceId: workspace.id, sessionId: session.id }
const browser: BrowserSnapshot = { id: 'browser-a', navigationId: 'navigation-a', profileId: 'default', url: 'https://example.test/a', title: 'Same title', loading: false, canGoBack: true, canGoForward: true, viewport: 'responsive', driving: false, appLinkPrompt: null, error: null }
const pageA = { ...browser, regionId: 'page-a', kind: 'browser' as const, workspaceId: workspace.id, browserId: browser.id }
const pageB = { ...pageA, id: 'browser-b', browserId: 'browser-b', regionId: 'page-b', url: 'https://example.test/b' }
const pageC = { ...pageB, id: 'browser-c', browserId: 'browser-c', regionId: 'page-c' }
const otherWorkspace = { ...workspace, id: 'other-workspace', path: '/other-project', name: 'Project' }
const file = { kind: 'file' as const, regionId: 'file-region', workspaceId: workspace.id, path: 'draft.md' }
const mixed = addWorkbenchRegion(addWorkbenchRegion(addWorkbenchRegion(createWorkbenchTab('mixed', agent), agent.regionId, 'right', pageA), pageA.regionId, 'bottom', pageB), agent.regionId, 'bottom', file)
mixed.layout = { ...mixed.layout, activeRegionId: agent.regionId }
const referenceA = { workspaceId: workspace.id, tabId: mixed.id, regionId: pageA.regionId }
const referenceB = { ...referenceA, regionId: pageB.regionId }
const key = documentKey(workspace.id, file.path)
let savedStorage: string | null
let css: HTMLStyleElement

beforeEach(() => {
  // The API module already loaded its project-native mock transport. Exercise the real native
  // visibility branch in BrowserPane instead of the web-preview placeholder branch.
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false)
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true })
  savedStorage = localStorage.getItem('agentmux-workbench-v1')
  observation.memory = []; observation.terminals = []; observation.stages = []
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const survey = this.closest('#survey-browser-slot') !== null
    return new DOMRect(survey ? 200 : 250, 48, 600, 500)
  })
  useAppStore.setState({ loading: false, initialize: vi.fn(async () => () => {}), mainSurface: 'workbench',
    surveyBrowserSelection: null, surveyToolsOpen: false, config: composerConfig, activeWorkspaceId: workspace.id,
    sessions: [session], viewModes: { [session.id]: 'terminal' }, tabs: { [mixed.id]: mixed }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [mixed.id]) },
    agentFocus: { execution: { sessionId: session.id, history: [{ sessionId: session.id, focusedAt: 1 }] }, pmo: { sessionId: null } },
    projectRailOpen: true, toolsOpen: true, workspaceTool: 'agents', demands: {}, browserAnnotationsByBrowserId: {},
    documents: { [key]: { path: file.path, content: 'Unsaved file', revision: 'disk' } }, dirtyDocuments: { [key]: true },
    error: null, lastError: null, errorDismissed: true, displacedAgentSessionIds: [], retainedSpatialFocus: null, regionCaretFocus: null })
  vi.spyOn(api.browser, 'setBounds').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'create').mockImplementation(async (id, url = 'about:blank') => ({ ...browser, id, url }))
  vi.spyOn(api.browser, 'navigate').mockImplementation(async (id, url) => ({ ...browser, id, url, navigationId: `navigation-${id}` }))
  vi.spyOn(api.browser, 'listProfiles').mockResolvedValue([{ id: 'default', label: 'Default', createdAt: 1, isDefault: true, source: null }])
  vi.spyOn(api.browser, 'close').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  css = document.createElement('style')
  css.textContent = readFileSync(resolve('apps/desktop/src/renderer/src/styles/survey.css'), 'utf8')
  document.head.append(css)
})
afterEach(() => {
  vi.useRealTimers()
  css.remove(); vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  if (savedStorage === null) localStorage.removeItem('agentmux-workbench-v1'); else localStorage.setItem('agentmux-workbench-v1', savedStorage)
})
async function fill(field: HTMLInputElement, value: string) {
  expect(field).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function enterSurvey() { await dom.click('[aria-label="Survey: browse and manage pages"]') }
async function choose(regionId: string) { await dom.click(`[data-survey-select-region-id="${regionId}"]`) }
async function submit(form: HTMLFormElement) {
  expect(form).not.toBeNull(); await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
const slot = () => dom.container.querySelector<HTMLElement>('#survey-browser-slot')!
const selectedRegion = () => [...slot().querySelectorAll<HTMLElement>('[data-workbench-region-id]')].find(region => region.dataset.workbenchRegionId === useAppStore.getState().surveyBrowserSelection?.regionId)!
const address = () => selectedRegion().querySelector<HTMLInputElement>('[aria-label="Browser address"]')!
function healthy() {
  const current = useAppStore.getState()
  expect(current.sessions).toEqual([session]); expect(current.sessions[0]!.control.run.runId).toBe('run-agent-1')
  expect(current.agentComposerDrafts[session.id]).toBe('Keep my draft')
  expect(current.agentFocus.execution.sessionId).toBe(session.id)
  expect(current.tabs[mixed.id]?.regions[agent.regionId]).toEqual(agent)
  expect(current.documents[key]?.content).toBe('Unsaved file')
  expect(api.sessions.stop).not.toHaveBeenCalled()
}

it('uses actual App navigation, nonempty global page rows and the complete original Tab once', async () => {
  const foreign = createWorkbenchTab('foreign', { ...pageA, workspaceId: otherWorkspace.id, regionId: 'foreign-page', browserId: 'foreign-browser' })
  const unplaced = createWorkbenchTab('unplaced', { ...pageA, regionId: 'unplaced-page', browserId: 'unplaced-browser' })
  const originalLayout = useAppStore.getState().layouts[workspace.id]!
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, otherWorkspace] },
    tabs: { [mixed.id]: mixed, [foreign.id]: foreign, [unplaced.id]: unplaced }, layouts: { [workspace.id]: originalLayout, [otherWorkspace.id]: createWorkspaceLayout('other-group', [foreign.id]) } })
  await dom.render(<App />)
  const before = useAppStore.getState()
  const terminal = dom.container.querySelector('[data-terminal-probe]')!
  const fileNode = dom.container.querySelector('[data-file-probe]')!
  expect(terminal).not.toBeNull(); expect(fileNode).not.toBeNull()
  const stageA = dom.container.querySelector(`[data-native-browser-stage="${browser.id}"]`)!
  await enterSurvey()
  const rows = [...dom.container.querySelectorAll('[data-survey-select-region-id]')]
  expect(rows.map(row => row.getAttribute('data-survey-select-region-id'))).toEqual(['page-a', 'page-b', 'foreign-page'])
  expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['Show page: Same title', 'Show page: Same title', 'Show page: Same title'])
  expect(dom.container.querySelector('.survey-start-input')).not.toBeNull()
  expect(slot().childElementCount).toBe(0)
  await choose(pageA.regionId)
  expect(useAppStore.getState().surveyBrowserSelection).toEqual(referenceA)
  expect(slot().querySelector('[data-native-browser-stage]')).toBe(stageA)
  expect(dom.container.querySelectorAll(`[data-native-browser-stage="${browser.id}"]`)).toHaveLength(1)
  expect(dom.container.querySelector('.survey-start-input')).toBeNull()
  expect(dom.container.querySelector('[data-terminal-probe]')).toBe(terminal)
  expect(dom.container.querySelector('[data-file-probe]')).toBe(fileNode)
  expect(slot().querySelector('[data-terminal-probe]')).toBe(terminal)
  expect(slot().querySelector('[data-file-probe]')).toBe(fileNode)
  expect([...slot().querySelectorAll('[data-workbench-region-id]')].map(region => region.getAttribute('data-workbench-region-id'))).toEqual(['agent-region', 'file-region', 'page-a', 'page-b'])
  expect(slot().querySelectorAll('.retained-workbench-view')).toHaveLength(1)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(api.browser.create).not.toHaveBeenCalled(); healthy()
})

it('keeps Space navigation and the same DOM input selection through portal pointers while cancelling pending caret commands on Survey entry', async () => {
  await dom.render(<App />)
  const focus = { workspaceId: workspace.id, spaceId: workspace.id, zoneId: 'original-group', tabId: mixed.id, regionId: agent.regionId }
  // A keyboard handoff is a one-shot input command, not retained Space focus or a DOM caret.
  await act(async () => useAppStore.getState().focusRegion(workspace.id, mixed.id, agent.regionId, 'keyboard'))
  expect(useAppStore.getState().regionCaretFocus?.regionId).toBe(agent.regionId)
  await act(async () => useAppStore.setState({ retainedSpatialFocus: focus }))
  const before = useAppStore.getState()
  const stageA = dom.container.querySelector(`[data-native-browser-stage="${browser.id}"]`)!
  await enterSurvey(); await choose(pageA.regionId)
  const field = address()
  await act(async () => { field.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); field.focus() })
  await fill(field, 'Unsubmitted address draft')
  field.setSelectionRange(3, 14)
  const back = slot().querySelector<HTMLButtonElement>('[aria-label="Back"]')!
  await act(async () => back.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  const current = useAppStore.getState()
  expect(current.layouts).toBe(before.layouts); expect(current.tabs[mixed.id]?.layout).toEqual(before.tabs[mixed.id]!.layout)
  expect(current.retainedSpatialFocus).toBe(focus); expect(current.regionCaretFocus).toBeNull()
  expect([field.selectionStart, field.selectionEnd]).toEqual([3, 14])
  await choose(pageB.regionId); await choose(pageA.regionId)
  expect(address()).toBe(field); expect(address().value).toBe('Unsubmitted address draft')
  expect([field.selectionStart, field.selectionEnd]).toEqual([3, 14]); expect(useAppStore.getState().regionCaretFocus).toBeNull()
  await dom.click('[aria-label="Space: show terminal and file workbench"]')
  expect(stageA.closest('.workbench-tab-slot')?.id).toBe(`workbench-tab-slot:${mixed.id}`)
  await enterSurvey()
  expect(slot().querySelector('[data-native-browser-stage]')).toBe(stageA); expect(address()).toBe(field)
  expect(address().value).toBe('Unsubmitted address draft'); expect([field.selectionStart, field.selectionEnd]).toEqual([3, 14]); healthy()
})

it('creates from the central input without changing original Space active references, then navigates the same page with raw input', async () => {
  await dom.render(<App />); await enterSurvey()
  const before = useAppStore.getState()
  await fill(dom.container.querySelector<HTMLInputElement>('.survey-start-input input')!, '  distributed protocol notes  ')
  await submit(dom.container.querySelector<HTMLFormElement>('.survey-start-input')!)
  const selection = useAppStore.getState().surveyBrowserSelection!
  expect(selection).not.toBeNull(); expect(selection.workspaceId).toBe(workspace.id)
  const page = useAppStore.getState().tabs[selection.tabId]!.regions[selection.regionId]!
  expect(page).toMatchObject({ kind: 'browser', browserId: selection.regionId, url: '  distributed protocol notes  ' })
  expect(api.browser.create).toHaveBeenCalledExactlyOnceWith(selection.regionId, '  distributed protocol notes  ', workspace.id)
  expect(useAppStore.getState().mainSurface).toBe('survey')
  expect(useAppStore.getState().layouts[workspace.id]!.groups[0]!.activeTabId).toBe(mixed.id)
  expect(useAppStore.getState().tabs[mixed.id]).toBe(before.tabs[mixed.id])
  const currentTabs = Object.keys(useAppStore.getState().tabs)
  for (const input of ['https://example.test/reference', '  another multi word query  ']) {
    await fill(address(), input); await submit(slot().querySelector<HTMLFormElement>('.browser-toolbar')!)
    expect(api.browser.navigate).toHaveBeenLastCalledWith(selection.regionId, input)
    expect(useAppStore.getState().surveyBrowserSelection).toBe(selection)
    expect(Object.keys(useAppStore.getState().tabs)).toEqual(currentTabs)
    expect(useAppStore.getState().mainSurface).toBe('survey')
  }
  expect(api.browser.create).toHaveBeenCalledTimes(1); healthy()
})

it('keeps blank input inert and renders one central input in a real blank Browser using its original navigate owner', async () => {
  await dom.render(<App />); await enterSurvey()
  await fill(dom.container.querySelector<HTMLInputElement>('.survey-start-input input')!, '   ')
  await submit(dom.container.querySelector<HTMLFormElement>('.survey-start-input')!)
  expect(api.browser.create).not.toHaveBeenCalled()
  await dom.click('[aria-label="New Browser"]')
  const selection = useAppStore.getState().surveyBrowserSelection!
  expect(selection).not.toBeNull()
  expect(slot().querySelectorAll('[aria-label="Search or enter a web address"]')).toHaveLength(1)
  expect(slot().querySelector('[aria-label="Browser address"]')).toBeNull()
  expect(slot().textContent).not.toContain('Electron Main')
  await fill(slot().querySelector<HTMLInputElement>('.survey-start-input input')!, 'https://example.test/from-blank')
  await submit(slot().querySelector<HTMLFormElement>('.survey-start-input')!)
  expect(api.browser.navigate).toHaveBeenCalledExactlyOnceWith(selection.regionId, 'https://example.test/from-blank')
  expect(api.browser.create).toHaveBeenCalledTimes(1); expect(useAppStore.getState().surveyBrowserSelection).toBe(selection)
  expect(document.activeElement).toBe(address()); healthy()
})

it('keeps failure input and page identities, and a pending create cannot replace a later explicit page or workface choice', async () => {
  vi.mocked(api.browser.create).mockRejectedValueOnce(new Error('Native owner unavailable'))
  await dom.render(<App />); await enterSurvey()
  const field = dom.container.querySelector<HTMLInputElement>('.survey-start-input input')!
  await fill(field, 'Failed query'); await submit(field.form!)
  expect(field.value).toBe('Failed query'); expect(dom.container.querySelector('.survey-error')?.textContent).toContain('Native owner unavailable')
  expect(useAppStore.getState().surveyBrowserSelection).toBeNull()
  let finish!: (result: BrowserSnapshot) => void
  vi.mocked(api.browser.create).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await dom.click('[aria-label="New Browser"]')
  expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="New Browser"]')!.disabled).toBe(true)
  await choose(pageB.regionId)
  const pendingId = vi.mocked(api.browser.create).mock.calls.at(-1)![0]
  await act(async () => finish({ ...browser, id: pendingId, url: 'about:blank' }))
  expect(useAppStore.getState().surveyBrowserSelection).toEqual(referenceB)
  vi.mocked(api.browser.navigate).mockRejectedValueOnce(new Error('Navigation unavailable'))
  await fill(address(), 'Keep failed address'); await submit(address().form!)
  expect(address().value).toBe('Keep failed address')
  expect(slot().querySelector('[role="alert"]')?.textContent).toContain('Your input and page are kept; retry here')
  expect(useAppStore.getState().tabs[mixed.id]?.regions[pageB.regionId]).toEqual(pageB)
  expect(useAppStore.getState().mainSurface).toBe('survey'); healthy()
})

it('closes only the selected Browser in a mixed Tab and leaves all healthy siblings and topology under the original owner', async () => {
  await dom.render(<App />); await enterSurvey(); await choose(pageB.regionId)
  const terminal = dom.container.querySelector('[data-terminal-probe]')!
  await dom.click(`[data-survey-close-region-id="${pageB.regionId}"]`)
  expect(api.browser.close).toHaveBeenCalledExactlyOnceWith(pageB.browserId)
  expect(Object.keys(useAppStore.getState().tabs[mixed.id]!.regions)).toEqual(['agent-region', 'page-a', 'file-region'])
  expect(dom.container.querySelector('[data-terminal-probe]')).toBe(terminal)
  expect(useAppStore.getState().surveyBrowserSelection).toBeNull(); expect(dom.container.querySelector('.survey-start-input')).not.toBeNull()
  expect(useAppStore.getState().layouts[workspace.id]!.groups[0]!.activeTabId).toBe(mixed.id); healthy()
})

it('closes all live Group placements of one exact single-Browser Tab through the original close lease', async () => {
  const single = createWorkbenchTab('single', pageC)
  const layout = createWorkspaceLayout('original-group', [mixed.id, single.id])
  layout.groups.push({ id: 'duplicate-group', tabOrder: [single.id], activeTabId: single.id, recentTabIds: [single.id] })
  useAppStore.setState({ tabs: { [mixed.id]: mixed, [single.id]: single }, layouts: { [workspace.id]: layout } })
  let release!: () => void
  vi.mocked(api.browser.close).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  await dom.render(<App />); await enterSurvey(); await choose(pageC.regionId)
  await dom.click(`[data-survey-close-region-id="${pageC.regionId}"]`)
  expect(useAppStore.getState().closingWorkbenchViews[single.id]).toBeDefined()
  expect(api.browser.close).toHaveBeenCalledExactlyOnceWith(pageC.browserId)
  const during = useAppStore.getState().tabs[single.id]
  useAppStore.getState().splitRegion(workspace.id, single.id, pageC.regionId, 'right')
  expect(useAppStore.getState().tabs[single.id]).toBe(during)
  await act(async () => release())
  expect(useAppStore.getState().tabs[single.id]).toBeUndefined()
  expect(useAppStore.getState().layouts[workspace.id]!.groups.map(group => group.tabOrder)).toEqual([[mixed.id], []])
  expect(useAppStore.getState().surveyBrowserSelection).toBeNull(); expect(useAppStore.getState().mainSurface).toBe('survey'); healthy()
})

it.each(['mixed', 'changed-browser'] as const)('stops last-page closing when its exact owner changes between Group placements: %s', async change => {
  const single = createWorkbenchTab('single', pageC)
  const layout = createWorkspaceLayout('original-group', [mixed.id, single.id])
  layout.groups.push({ id: 'duplicate-group', tabOrder: [single.id], activeTabId: single.id, recentTabIds: [single.id] })
  useAppStore.setState({ tabs: { [mixed.id]: mixed, [single.id]: single }, layouts: { [workspace.id]: layout } })
  const realClose = useAppStore.getState().closeTab
  const close = vi.fn(async (...args: Parameters<typeof realClose>) => {
    const result = await realClose(...args)
    const current = useAppStore.getState()
    const tab = current.tabs[single.id]!
    useAppStore.setState({ tabs: { ...current.tabs, [single.id]: change === 'mixed'
      ? addWorkbenchRegion(tab, pageC.regionId, 'right', { ...agent, regionId: 'new-agent-sibling' })
      : { ...tab, regions: { [pageC.regionId]: { ...pageC, browserId: 'replacement-browser' } } } } })
    return result
  })
  useAppStore.setState({ closeTab: close })
  await dom.render(<App />); await enterSurvey(); await choose(pageC.regionId)
  await dom.click(`[data-survey-close-region-id="${pageC.regionId}"]`)
  expect(close).toHaveBeenCalledTimes(1); expect(api.browser.close).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs[single.id]).toBeDefined()
  expect(dom.container.querySelector('.survey-error')?.textContent).toContain('page changed while closing')
  expect(useAppStore.getState().surveyBrowserSelection).toMatchObject({ tabId: single.id, regionId: pageC.regionId }); healthy()
})

it('feeds the actual App resource owners the selected complete Tab while unselected global Tabs stay hidden', async () => {
  const foreign = addWorkbenchRegion(createWorkbenchTab('foreign', { ...pageA, workspaceId: otherWorkspace.id, regionId: 'foreign-page', browserId: 'foreign-browser' }), 'foreign-page', 'right', { kind: 'terminal', regionId: 'foreign-terminal', workspaceId: otherWorkspace.id, sessionId: 'foreign-session' })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, otherWorkspace] }, tabs: { [mixed.id]: mixed, [foreign.id]: foreign },
    layouts: { ...useAppStore.getState().layouts, [otherWorkspace.id]: createWorkspaceLayout('foreign-group', [foreign.id]) } })
  await dom.render(<App />); await enterSurvey(); await choose(pageA.regionId)
  const latest = observation.memory.at(-1)!
  expect(latest).toBeDefined()
  expect([...latest.input.projectedVisibleTabIds!]).toEqual([mixed.id])
  expect(latest.candidates.map(({ id, visible, navigationContextActive }) => ({ id, visible, navigationContextActive }))).toEqual([
    { id: 'page-a', visible: true, navigationContextActive: true },
    { id: 'page-b', visible: true, navigationContextActive: true },
    { id: 'file-region', visible: true, navigationContextActive: true },
    { id: 'foreign-page', visible: false, navigationContextActive: false }
  ])
  const terminalOptions = observation.terminals.at(-1)!
  expect(terminalOptions).toBeDefined()
  const state = useAppStore.getState()
  const terminalInput: TerminalParkingCollectionInput = { tabs: state.tabs, layouts: state.layouts, sessions: state.sessions, activeWorkspaceId: state.activeWorkspaceId, ...terminalOptions }
  expect(collectTerminalColdParkCandidates(terminalInput).map(({ id, visible, navigationContextActive }) => ({ id, visible, navigationContextActive }))).toEqual([
    { id: 'agent-region', visible: true, navigationContextActive: true },
    { id: 'foreign-terminal', visible: false, navigationContextActive: false }
  ])
  expect(slot().querySelector('[data-terminal-probe]')?.getAttribute('data-visible')).toBe('true')
  await dom.click('[aria-label="Settings"]')
  expect([...observation.memory.at(-1)!.input.projectedVisibleTabIds!]).toEqual([])
  healthy()
})

it('rebinds the original geometry observer on target changes and keeps native input bounds clear of hidden Space dock facts in narrow Survey', async () => {
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
  await dom.render(<App />)
  const stage = dom.container.querySelector(`[data-native-browser-stage="${browser.id}"]`)!
  await enterSurvey(); await choose(pageA.regionId)
  await vi.waitFor(() => expect(vi.mocked(api.browser.setBounds).mock.calls.filter(call => call[0] === browser.id).at(-1)).toEqual([browser.id, { x: 200, y: 48, width: 600, height: 500 }]))
  const survey = observation.stages.filter(record => record.stage === stage && record.host === 'survey-browser-slot').at(-1)!
  expect(survey).toBeDefined(); expect(survey.stopped).toBe(false)
  const calls = vi.mocked(api.browser.setBounds).mock.calls.length
  vi.mocked(api.browser.setBounds).mockClear()
  await act(async () => {
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 46, 600, 500))
    vi.spyOn(stage.closest<HTMLElement>('[data-workbench-region-id]')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 46, 600, 500))
    survey.update()
  })
  await vi.waitFor(() => expect(api.browser.setBounds).toHaveBeenCalledWith(browser.id, { x: 200, y: 46, width: 600, height: 500 }))
  expect(calls).toBeGreaterThan(0)
  await dom.click('[aria-label="Browser management"]')
  await vi.waitFor(() => expect(api.browser.setBounds).toHaveBeenCalledWith(browser.id, null))
  expect(slot().closest('.survey-page-content')?.hasAttribute('inert')).toBe(true)
  expect([...observation.memory.at(-1)!.input.projectedVisibleTabIds!]).toEqual([])
  expect(observation.memory.at(-1)!.candidates.map(({ id, visible }) => ({ id, visible }))).toEqual([
    { id: 'page-a', visible: false }, { id: 'page-b', visible: false }, { id: 'file-region', visible: false }
  ])
  expect(slot().querySelector('[data-terminal-probe]')?.getAttribute('data-visible')).toBe('false')
  await dom.click('[aria-label="Close browser management"]')
  await vi.waitFor(() => expect(vi.mocked(api.browser.setBounds).mock.calls.filter(call => call[0] === browser.id).at(-1)).toEqual([browser.id, { x: 200, y: 46, width: 600, height: 500 }]))
  await dom.click('[aria-label="Space: show terminal and file workbench"]')
  expect(survey.stopped).toBe(true)
  await enterSurvey()
  expect(observation.stages.filter(record => record.stage === stage && record.host === 'survey-browser-slot').at(-1)).toMatchObject({ stopped: false })
  expect(dom.container.querySelectorAll(`[data-native-browser-stage="${browser.id}"]`)).toHaveLength(1); healthy()
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
})

it('retains query, Browser bar save failure and Profile/import drafts through management and actual Space return paths', async () => {
  const save = vi.spyOn(api.config, 'save').mockRejectedValue(new Error('Changed elsewhere; review and save again'))
  vi.spyOn(api.browser, 'detectProfileImportSources').mockResolvedValue([{ token: 'source-draft', browserLabel: 'Source Browser', profileLabel: 'Source Profile' }])
  const createProfile = vi.spyOn(api.browser, 'createProfile'); const importProfile = vi.spyOn(api.browser, 'importProfile')
  await dom.render(<App />); await enterSurvey()
  const query = dom.container.querySelector<HTMLInputElement>('.survey-start-input input')!
  await fill(query, 'Unsubmitted query'); await dom.click('[aria-label="Browser management"]')
  const management = dom.container.querySelector<HTMLElement>('.survey-management')!
  await dom.click('[aria-label="Browser bar settings"]')
  const details = management.querySelector<HTMLDetailsElement>('details')!
  const screenshot = [...details.querySelectorAll('label')].find(label => label.textContent === 'Screenshot')!.querySelector<HTMLInputElement>('input')!
  await act(async () => screenshot.click()); await dom.click('.browser-tools-preferences button')
  const profileName = management.querySelector<HTMLInputElement>('[aria-label="New Browser Profile name"]')!
  await fill(profileName, 'Unsubmitted Profile'); await dom.click('.browser-profiles__import-open')
  const importer = management.querySelector<HTMLElement>('[aria-label="Import Browser Profile"]')!
  const source = importer.querySelector<HTMLSelectElement>('select')!; const importName = importer.querySelector<HTMLInputElement>('input')!
  await act(async () => { source.value = 'source-draft'; source.dispatchEvent(new Event('change', { bubbles: true })) }); await fill(importName, 'Unsubmitted import')
  await dom.click('[aria-label="Close browser management"]'); await dom.click('[aria-label="Browser management"]')
  expect(dom.container.querySelector('.survey-management')).toBe(management)
  await dom.click('[aria-label="Space: show terminal and file workbench"]'); await enterSurvey()
  expect(query.value).toBe('Unsubmitted query'); expect(details.open).toBe(true); expect(screenshot.checked).toBe(false)
  expect(details.querySelector('summary')?.textContent).toContain('Unsaved')
  expect(management.querySelector('[role="alert"]')?.textContent).toBe('Changed elsewhere; review and save again')
  expect(profileName.value).toBe('Unsubmitted Profile'); expect(source.value).toBe('source-draft'); expect(importName.value).toBe('Unsubmitted import')
  expect(save).toHaveBeenCalledTimes(1); expect(createProfile).not.toHaveBeenCalled(); expect(importProfile).not.toHaveBeenCalled(); expect(api.browser.create).not.toHaveBeenCalled(); healthy()
})

it('restores the non-first cross-project selected tuple via actual storage rehydrate and the existing Browser rebuild, preserving unresolved references', async () => {
  const layout = useAppStore.getState().layouts[workspace.id]!
  const foreign = createWorkbenchTab('foreign', { ...pageC, workspaceId: otherWorkspace.id })
  const foreignLayout = createWorkspaceLayout('foreign-group', [foreign.id])
  const durable = { mainSurface: 'survey', activeWorkspaceId: otherWorkspace.id, surveyBrowserSelection: referenceB,
    restoredWorkbench: { tabs: { [mixed.id]: mixed, [foreign.id]: foreign }, layouts: { [workspace.id]: layout, [otherWorkspace.id]: foreignLayout } },
    documents: { [key]: { path: file.path, content: 'Unsaved file', revision: 'disk' } }, dirtyDocuments: { [key]: true },
    agentComposerDrafts: { [session.id]: 'Keep my draft' }, agentFocus: useAppStore.getState().agentFocus }
  useAppStore.setState({ loading: true, mainSurface: 'workbench', surveyBrowserSelection: null, tabs: {}, layouts: {}, restoredWorkbench: null, sessions: [] })
  localStorage.setItem('agentmux-workbench-v1', JSON.stringify({ version: 1, state: durable }))
  await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().surveyBrowserSelection).toEqual(referenceB)
  // An unresolved durable reference is not a close and must not pick the first available page.
  useAppStore.setState({ loading: false })
  await dom.render(<App />)
  expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('selected page is retained')
  expect(useAppStore.getState().surveyBrowserSelection).toEqual(referenceB)
  vi.spyOn(api.config, 'get').mockResolvedValue({ ...composerConfig, workspaces: [workspace, otherWorkspace] }); vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.mocked(api.browser.create).mockImplementation(async id => id === browser.id ? browser : { ...browser, ...pageB, id })
  let dispose!: () => void
  await act(async () => { dispose = await realInitialize() })
  try {
    await act(async () => {})
    expect(useAppStore.getState().mainSurface).toBe('survey'); expect(useAppStore.getState().surveyBrowserSelection).toEqual(referenceB)
    expect(slot().dataset.surveyActiveBrowserId).toBe(pageB.browserId)
    expect(selectedRegion().querySelector('[data-native-browser-stage]')?.getAttribute('data-native-browser-stage')).toBe(pageB.browserId)
    expect(useAppStore.getState().layouts[workspace.id]).toEqual(layout)
    expect(useAppStore.getState().layouts[otherWorkspace.id]).toEqual(foreignLayout)
    expect(useAppStore.getState().activeWorkspaceId).toBe(otherWorkspace.id)
    expect(useAppStore.getState().tabs[mixed.id]?.layout).toEqual(mixed.layout)
    expect(api.browser.create).toHaveBeenCalledTimes(3); healthy()
  } finally { dispose() }
})

it('renders glass only on actual Survey controls with a nonempty scanned material rule and complete selected row and scroll contracts', async () => {
  await dom.render(<App />); await enterSurvey(); await choose(pageA.regionId); await dom.click('[aria-label="Browser management"]')
  const controls = [...dom.container.querySelectorAll('.survey-tabs, .survey-management, .global-survey-surface .browser-toolbar')]
  expect(controls).toHaveLength(4)
  expect(css.sheet).not.toBeNull()
  const sheet = css.sheet!
  expect(sheet.cssRules.length).toBeGreaterThan(0)
  const materialRules = [...sheet.cssRules].filter(rule => 'selectorText' in rule && (rule as CSSStyleRule).selectorText.includes('.survey-tabs, .survey-management')) as CSSStyleRule[]
  expect(materialRules).toHaveLength(1)
  expect(materialRules[0]!.style.getPropertyValue('backdrop-filter')).toContain('blur(')
  for (const control of controls) expect(getComputedStyle(control).getPropertyValue('backdrop-filter')).toContain('blur(')
  const selected = dom.container.querySelector<HTMLElement>('.survey-page-row[data-selected="true"]')!
  expect(selected.dataset.surveyRegionId).toBe(pageA.regionId)
  // HappyDOM discards color-mix() declarations. Match its actual selector against the mounted
  // node, then use Vite's existing PostCSS parser for the source declaration; native proof checks
  // the rendered color and material independently.
  const selectedRules = [...sheet.cssRules].filter(rule => 'selectorText' in rule && (rule as CSSStyleRule).selectorText === '.survey-page-row[data-selected="true"]') as CSSStyleRule[]
  expect(selectedRules).toHaveLength(1)
  expect(selected.matches(selectedRules[0]!.selectorText)).toBe(true)
  const require = createRequire(import.meta.url)
  const postcss = createRequire(require.resolve('vite'))('postcss') as { parse(source: string): { walkRules(fn: (rule: { selector: string; walkDecls(fn: (declaration: { prop: string; value: string }) => void): void }) => void): void } }
  const backgrounds: string[] = []
  postcss.parse(css.textContent!).walkRules(rule => {
    if (rule.selector === selectedRules[0]!.selectorText) rule.walkDecls(declaration => {
      if (declaration.prop === 'background') backgrounds.push(declaration.value)
    })
  })
  expect(backgrounds).toHaveLength(1)
  const selectedBackground = backgrounds[0]!
  expect(selectedBackground.length).toBeGreaterThan(0)
  expect(selectedBackground).not.toMatch(/^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/)
  expect(getComputedStyle(selected.querySelector('strong')!).fontWeight).toBe('600')
  expect(getComputedStyle(dom.container.querySelector('.survey-page-list')!).overflow).toBe('auto')
  expect(getComputedStyle(slot().querySelector('.browser-stage')!).filter).not.toContain('blur')
})

it('focuses and navigates the second Browser of the same original Tab without selecting its Agent or the first address', async () => {
  await dom.render(<App />); await enterSurvey(); await choose(pageA.regionId)
  const firstAddress = address(), tabTree = slot().firstElementChild
  const before = useAppStore.getState()
  await choose(pageB.regionId)
  expect(slot().firstElementChild).toBe(tabTree)
  expect(slot().querySelectorAll('.retained-workbench-view')).toHaveLength(1)
  expect(address()).not.toBe(firstAddress)
  expect(document.activeElement).toBe(address())
  await fill(address(), 'second page query'); await submit(address().form!)
  expect(api.browser.navigate).toHaveBeenCalledExactlyOnceWith(pageB.browserId, 'second page query')
  expect(firstAddress.value).toBe(pageA.url)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().tabs[mixed.id]!.layout).toEqual(before.tabs[mixed.id]!.layout)
  expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
  expect(useAppStore.getState().surveyBrowserSelection).toEqual(referenceB); healthy()
})

it('chooses a same-named cross-project page without navigation and its independent project action jumps to the exact original placement', async () => {
  const foreign = createWorkbenchTab('foreign', { ...pageC, workspaceId: otherWorkspace.id })
  const original = useAppStore.getState()
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, otherWorkspace] },
    tabs: { ...original.tabs, [foreign.id]: foreign }, layouts: { ...original.layouts, [otherWorkspace.id]: createWorkspaceLayout('foreign-group', [foreign.id]) } })
  await dom.render(<App />); await enterSurvey(); await choose(pageC.regionId)
  expect(slot().dataset.surveyActiveTabId).toBe(foreign.id)
  expect(useAppStore.getState().activeWorkspaceId).toBe(workspace.id)
  expect(useAppStore.getState().agentFocus).toBe(original.agentFocus)
  const project = dom.container.querySelector<HTMLElement>(`[data-survey-project-region-id="${pageC.regionId}"]`)!
  expect(project.textContent).toBe('Project'); expect(project.title).toContain(otherWorkspace.path)
  const primary = dom.container.querySelector<HTMLElement>(`[data-survey-project-region-id="${pageA.regionId}"]`)!
  expect(primary.title).toContain(workspace.path); expect(project.title).not.toBe(primary.title)
  await dom.click(`[data-survey-project-region-id="${pageC.regionId}"]`)
  const current = useAppStore.getState()
  expect(current.mainSurface).toBe('workbench'); expect(current.activeWorkspaceId).toBe(otherWorkspace.id)
  expect(current.layouts[otherWorkspace.id]?.activeGroupId).toBe('foreign-group')
  expect(current.layouts[otherWorkspace.id]?.groups[0]?.activeTabId).toBe(foreign.id)
  expect(current.tabs[foreign.id]?.layout.activeRegionId).toBe(pageC.regionId)
  expect(current.surveyBrowserSelection).toEqual({ workspaceId: otherWorkspace.id, tabId: foreign.id, regionId: pageC.regionId }); healthy()
})

it('keeps actual Region pointer input active in the complete Tab while page selection itself does not move Space focus', async () => {
  useAppStore.setState({ tabs: { [mixed.id]: { ...mixed, layout: { ...mixed.layout, activeRegionId: pageA.regionId } } } })
  await dom.render(<App />); await enterSurvey(); await choose(pageB.regionId)
  expect(useAppStore.getState().tabs[mixed.id]!.layout.activeRegionId).toBe(pageA.regionId)
  const terminal = slot().querySelector<HTMLTextAreaElement>('[data-terminal-probe] textarea')!
  expect(terminal).not.toBeNull()
  await act(async () => { terminal.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); terminal.focus(); terminal.value = 'Continue original input' })
  expect(useAppStore.getState().tabs[mixed.id]!.layout.activeRegionId).toBe(agent.regionId)
  expect(document.activeElement).toBe(terminal); expect(terminal.value).toBe('Continue original input')
  expect(useAppStore.getState().surveyBrowserSelection).toEqual(referenceB); healthy()
})

it('projects real public background Browser creation globally without stealing the Survey workface or its explicit and unresolved selections', async () => {
  const foreign = createWorkbenchTab('foreign', { ...pageC, workspaceId: otherWorkspace.id })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, otherWorkspace] },
    tabs: { ...useAppStore.getState().tabs, [foreign.id]: foreign }, layouts: { ...useAppStore.getState().layouts, [otherWorkspace.id]: createWorkspaceLayout('foreign-group', [foreign.id]) } })
  await dom.render(<App />); await enterSurvey(); await choose(pageB.regionId)
  const selected = useAppStore.getState().surveyBrowserSelection
  const open = async (requestId: string) => {
    let result!: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['executeControl']>>
    await act(async () => { result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId, operation: 'open.browser', url: 'https://example.test/background',
      destination: { kind: 'new-tab', after: { kind: 'tab', tabId: foreign.id } }, caller: { agentSessionId: session.id } }) })
    expect(result.operation).toBe('open.browser')
    if (result.operation !== 'open.browser') throw new Error('Expected Browser result')
    expect(dom.container.querySelector(`[data-survey-select-region-id="${result.region.regionId}"]`)).not.toBeNull()
    expect(useAppStore.getState().mainSurface).toBe('survey'); expect(useAppStore.getState().activeWorkspaceId).toBe(workspace.id)
  }
  await open('background-1'); expect(useAppStore.getState().surveyBrowserSelection).toBe(selected)
  const unresolved = { workspaceId: otherWorkspace.id, tabId: 'pending-tab', regionId: 'pending-page' }
  await act(async () => useAppStore.getState().setSurveyBrowserSelection(unresolved))
  await open('background-2'); expect(useAppStore.getState().surveyBrowserSelection).toBe(unresolved)
  expect(dom.container.querySelector('.survey-restore-notice')?.textContent).toContain('selected page is retained'); healthy()
})

it('reuses one exact failed Launcher on retry and never reclaims it after it becomes a mixed healthy work surface', async () => {
  vi.mocked(api.browser.create).mockRejectedValueOnce(new Error('Create failed')).mockRejectedValueOnce(new Error('Retry failed'))
  await dom.render(<App />); await enterSurvey()
  const field = dom.container.querySelector<HTMLInputElement>('.survey-start-input input')!
  await fill(field, 'Keep query'); await submit(field.form!)
  const failedTabs = useAppStore.getState().tabs
  const launcher = Object.values(failedTabs).find(tab => tab.id !== mixed.id)!
  expect(Object.keys(failedTabs)).toHaveLength(2)
  await submit(field.form!)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(Object.keys(failedTabs))
  expect(api.browser.create).toHaveBeenNthCalledWith(2, launcher.layout.activeRegionId, 'Keep query', workspace.id)
  await act(async () => useAppStore.getState().splitRegion(workspace.id, launcher.id, launcher.layout.activeRegionId, 'right'))
  const mixedLauncher = useAppStore.getState().tabs[launcher.id]!
  await submit(field.form!)
  expect(useAppStore.getState().tabs[launcher.id]).toBe(mixedLauncher)
  expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(3)
  expect(api.browser.close).not.toHaveBeenCalled(); healthy()
})

it.each(['region', 'tab'] as const)('clears an explicitly closed selection through its real %s owner without relying on a Browser closed event', async kind => {
  const single = createWorkbenchTab('single', pageC)
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [single.id]: single }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [mixed.id, single.id]) } })
  await dom.render(<App />); await enterSurvey(); await choose(kind === 'region' ? pageB.regionId : pageC.regionId)
  await act(async () => {
    if (kind === 'region') await useAppStore.getState().closeRegion(workspace.id, mixed.id, pageB.regionId)
    else expect(await useAppStore.getState().closeTab(workspace.id, 'original-group', single.id)).toBe(true)
  })
  expect(useAppStore.getState().surveyBrowserSelection).toBeNull()
  expect(dom.container.querySelector('.survey-start-input')).not.toBeNull()
  expect(dom.container.querySelector('.survey-restore-notice')).toBeNull(); healthy()
})

it('keeps failed and unknown references and does not erase a later choice when a delayed close completes', async () => {
  await dom.render(<App />); await enterSurvey(); await choose(pageB.regionId)
  vi.mocked(api.browser.close).mockRejectedValueOnce(new Error('Close failed'))
  await act(async () => useAppStore.getState().closeRegion(workspace.id, mixed.id, pageB.regionId))
  expect(useAppStore.getState().surveyBrowserSelection).toEqual(referenceB)
  let complete!: () => void
  vi.mocked(api.browser.close).mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve }))
  let closing!: Promise<void>
  await act(async () => { closing = useAppStore.getState().closeRegion(workspace.id, mixed.id, pageB.regionId) })
  await choose(pageA.regionId)
  await act(async () => { complete(); await closing })
  expect(useAppStore.getState().surveyBrowserSelection).toEqual(referenceA)
  const unresolved = { ...referenceB, tabId: 'unresolved-tab' }
  await act(async () => { useAppStore.getState().setSurveyBrowserSelection(unresolved); await useAppStore.getState().closeTab(workspace.id, 'original-group', 'absent-tab') })
  expect(useAppStore.getState().surveyBrowserSelection).toBe(unresolved); healthy()
})

it.each(['ui', 'public'] as const)('follows an explicit %s promote result instead of leaving the original selected tuple falsely restoring', async kind => {
  await dom.render(<App />); await enterSurvey(); await choose(pageB.regionId)
  await act(async () => {
    if (kind === 'ui') useAppStore.getState().promoteRegionToTab(workspace.id, mixed.id, pageB.regionId)
    else await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'promote-page', operation: 'promote.region', target: { kind: 'region', regionId: pageB.regionId } })
  })
  const selection = useAppStore.getState().surveyBrowserSelection!
  expect(selection.tabId).not.toBe(mixed.id); expect(selection.regionId).toBe(pageB.regionId)
  expect(useAppStore.getState().tabs[selection.tabId]?.regions[selection.regionId]).toEqual(pageB)
  expect(slot().dataset.surveyActiveTabId).toBe(selection.tabId)
  expect(dom.container.querySelector('.survey-restore-notice')).toBeNull()
  expect(useAppStore.getState().mainSurface).toBe('survey'); healthy()
})

it('shows only current live Agent driving, human control or unknown and does not reuse a completed operator identity', async () => {
  await dom.render(<App />); await enterSurvey()
  const row = () => dom.container.querySelector<HTMLElement>(`[data-survey-region-id="${pageA.regionId}"]`)!
  const update = async (patch: Partial<BrowserSnapshot>) => act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...browser, ...patch } }))
  expect(row().dataset.surveyControl).toBe('unknown')
  await update({ activity: { control: 'human', operation: null } }); expect(row().dataset.surveyControl).toBe('human')
  const operation = { id: 'op', browserId: browser.id, operator: { id: session.id, name: 'Current operator' }, startedAt: 1, phase: 'running' as const, summary: 'Working', url: browser.url, steps: [] }
  await update({ driving: true, activity: { control: 'agent', operation } })
  expect(row().dataset.surveyControl).toBe('agent'); expect(row().textContent).toContain('Current operator')
  await update({ driving: false, activity: { control: 'agent', operation: { ...operation, phase: 'completed', finishedAt: 2 } } })
  expect(row().dataset.surveyControl).toBe('idle'); expect(row().textContent).not.toContain('Current operator')
  await update({ driving: true, activity: { control: 'agent', operation: { ...operation, phase: 'completed', finishedAt: 2 } } })
  expect(row().dataset.surveyControl).toBe('agent'); expect(row().textContent).not.toContain('Current operator')
  await update({ navigationId: '', driving: true, activity: { control: 'agent', operation } }); expect(row().dataset.surveyControl).toBe('unknown'); healthy()
})

it('keeps retained driving unknown across real memory release and a pending original owner restore, then consumes its fresh snapshot', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const single = createWorkbenchTab('single', { ...pageC, activity: { control: 'agent', operation: null } })
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [single.id]: single }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [mixed.id, single.id]) } })
  const released = vi.spyOn(api.browser, 'release').mockResolvedValue(undefined)
  let restored!: (snapshot: BrowserSnapshot) => void
  vi.spyOn(api.browser, 'restore').mockImplementation(() => new Promise(resolve => { restored = resolve }))
  await dom.render(<App />)
  await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
  await act(async () => { await vi.advanceTimersByTimeAsync(210_001) })
  expect(released).toHaveBeenCalledExactlyOnceWith(pageC.browserId)
  // A queued snapshot does not recreate the owner Main already released.
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...browser, id: pageC.browserId, url: pageC.url, driving: true, activity: { control: 'agent', operation: null } } }))
  expect(useAppStore.getState().tabs[single.id]?.regions[pageC.regionId]).toMatchObject({ driving: true })
  await enterSurvey(); await choose(pageC.regionId)
  const row = () => dom.container.querySelector<HTMLElement>(`[data-survey-region-id="${pageC.regionId}"]`)!
  expect(api.browser.restore).toHaveBeenCalledTimes(1)
  expect(row().dataset.surveyControl).toBe('unknown')
  await act(async () => restored({ ...browser, id: pageC.browserId, url: pageC.url, driving: false, activity: { control: 'human', operation: null } }))
  expect(row().dataset.surveyControl).toBe('human'); healthy()
})

it.each([null, 'Navigation failed'] as const)('protects a truly driving unselected Browser owner despite its navigation error (%s) while an unrelated idle page stays hidden and can be reclaimed', async error => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const idle = createWorkbenchTab('idle', pageC)
  const drivingPage = { ...pageC, id: 'browser-driving', browserId: 'browser-driving', regionId: 'driving-page', driving: true, error }
  const driving = createWorkbenchTab('driving', drivingPage)
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [idle.id]: idle, [driving.id]: driving }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [mixed.id, idle.id, driving.id]) } })
  const release = vi.spyOn(api.browser, 'release').mockResolvedValue(undefined)
  await dom.render(<App />)
  await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
  await act(async () => { await vi.advanceTimersByTimeAsync(210_001) })
  expect(release.mock.calls.map(([id]) => id)).toEqual([pageC.browserId])
  expect(observation.memory.at(-1)!.candidates.map(({ id, visible }) => ({ id, visible }))).toEqual([
    { id: 'page-a', visible: true }, { id: 'page-b', visible: true }, { id: 'file-region', visible: true },
    { id: 'page-c', visible: false }, { id: 'driving-page', visible: false }
  ])
  expect(useAppStore.getState().tabs[driving.id]?.regions[drivingPage.regionId]).toBe(drivingPage); healthy()
})

it('projects the exact native unavailable event as unknown without retiring its tuple, clears it even for an equal fresh snapshot and never persists that transient fact', async () => {
  await dom.render(<App />); await enterSurvey(); await choose(pageA.regionId)
  const operation = { id: 'op', browserId: browser.id, operator: { id: session.id, name: 'Live operator' }, startedAt: 1, phase: 'running' as const, summary: 'Working', url: browser.url, steps: [] }
  const snapshot = { ...browser, driving: true, activity: { control: 'agent' as const, operation } }
  const row = () => dom.container.querySelector<HTMLElement>(`[data-survey-region-id="${pageA.regionId}"]`)!
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: snapshot }))
  expect(row().dataset.surveyControl).toBe('agent'); expect(row().textContent).toContain('Live operator')
  const unavailableError = 'Native page destroyed'
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'unavailable', id: browser.id, error: unavailableError }))
  expect(row().dataset.surveyControl).toBe('unknown'); expect(row().textContent).not.toContain('Live operator')
  expect(useAppStore.getState().surveyBrowserSelection).toEqual(referenceA)
  const candidate = observation.memory.at(-1)!.candidates.find(item => item.id === pageA.regionId)!
  expect(candidate).toBeDefined(); expect(candidate).toMatchObject({ protected: false })
  const persisted = projectPersistedWorkbench(useAppStore.getState())
  expect(JSON.stringify(persisted)).not.toContain('nativeOwnerUnavailable')
  // error/loading/driving/activity are equal: the transient flag must defeat the old equality shortcut.
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...snapshot, error: unavailableError } }))
  expect(useAppStore.getState().tabs[mixed.id]?.regions[pageA.regionId]).not.toHaveProperty('nativeOwnerUnavailable')
  expect(row().dataset.surveyControl).toBe('agent')
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: snapshot }))
  expect(row().dataset.surveyControl).toBe('agent'); expect(row().textContent).toContain('Live operator'); healthy()
})

it('gives visible Survey the sole original Tab host ahead of the same Scratch Mote target and restores the latter on exit', async () => {
  const show = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover')
  const hide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidePopover')
  Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value() {} })
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value() {} })
  try {
  const scratch = { ...workspace, id: SCRATCH_WORKSPACE_ID, path: '/scratch', name: 'Topics' }
  const motePage = { ...pageC, workspaceId: scratch.id }
  const mote = { ...createWorkbenchTab('mote-tab', motePage), topicId: PMO_TEAMS_TOPIC_ID }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, scratch] }, tabs: { ...useAppStore.getState().tabs, [mote.id]: mote }, layouts: { ...useAppStore.getState().layouts, [scratch.id]: createWorkspaceLayout('mote-group', [mote.id]) } })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  vi.spyOn(api.scratch, 'ensureMote').mockRejectedValue(new Error('Context preparation gap'))
  await dom.render(<App />)
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: mote.id }))
  const stage = dom.container.querySelector<HTMLElement>(`[data-native-browser-stage="${motePage.browserId}"]`)!
  expect(stage.closest('[id^="mote-floating-tab-slot"]')?.id).toBe('mote-floating-tab-slot:mote-tab')
  await enterSurvey(); await choose(motePage.regionId)
  expect(slot().querySelector(`[data-native-browser-stage="${motePage.browserId}"]`)).toBe(stage)
  expect(dom.container.querySelectorAll(`[data-native-browser-stage="${motePage.browserId}"]`)).toHaveLength(1)
  expect([...observation.memory.at(-1)!.input.projectedVisibleTabIds!]).toEqual([mote.id])
  await dom.click('[aria-label="Space: show terminal and file workbench"]')
  expect(stage.closest('[id^="mote-floating-tab-slot"]')?.id).toBe('mote-floating-tab-slot:mote-tab')
  await act(async () => requestPmoTeamsTopicFloatingClose({ restoreFocus: false })); healthy()
  } finally {
    if (show) Object.defineProperty(HTMLElement.prototype, 'showPopover', show); else delete HTMLElement.prototype.showPopover
    if (hide) Object.defineProperty(HTMLElement.prototype, 'hidePopover', hide); else delete HTMLElement.prototype.hidePopover
  }
})
