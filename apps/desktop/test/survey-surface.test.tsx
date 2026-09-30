// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
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
  survey: [] as Parameters<typeof import('../src/renderer/src/components/GlobalSurveySurface').GlobalSurveySurface>[0][],
  memory: [] as { input: SurfaceMemoryCollectionInput; candidates: { id: string; kind: string; visible: boolean; navigationContextActive: boolean }[] }[],
  terminals: [] as { workbenchVisible: boolean; projectedVisibleTabIds?: ReadonlySet<string> | undefined }[],
  stages: [] as { stage: HTMLElement; host: string | null; update: () => void; stopped: boolean }[]
}))
vi.mock('../src/renderer/src/components/GlobalSurveySurface', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/GlobalSurveySurface')>()
  return { ...actual, GlobalSurveySurface: (props: Parameters<typeof actual.GlobalSurveySurface>[0]) => {
    observation.survey.push(props); return <actual.GlobalSurveySurface {...props} />
  } }
})
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
    const record = { stage: reference, host: reference.closest('[id^="survey-workbench-slot:"]')?.id ?? reference.closest('.workbench-tab-slot')?.id ?? null, update, stopped: false }
    observation.stages.push(record); update(); return () => { record.stopped = true }
  } }
})
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab, documentKey, workbenchSurfaces } from '../src/renderer/src/lib/workbench-tabs'
import { collectTerminalColdParkCandidates } from '../src/renderer/src/lib/terminal-cold-parking-coordinator'
import { projectPersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { surveyInitialZoneSelection, type SurveyZoneSelection } from '../src/renderer/src/lib/survey-workface'
import { projectWorkbenchProjection, type WorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { directoryIdentity } from '../src/shared/space-addresses'
import { useAppStore, restorePersistedUiState } from '../src/renderer/src/store'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'
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
const mixed = addWorkbenchRegion(addWorkbenchRegion(addWorkbenchRegion(createWorkbenchTab('mixed', agent), agent.regionId, 'right', pageA), pageA.regionId, 'down', pageB), agent.regionId, 'down', file)
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
  observation.memory = []; observation.terminals = []; observation.stages = []; observation.survey = []
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const survey = this.closest('.global-survey-surface') !== null
    return new DOMRect(survey ? 200 : 250, 48, 600, 500)
  })
  useAppStore.setState({ loading: false, initialize: vi.fn(async () => () => {}), mainSurface: 'workbench',
    surveySidebarWidth: 220,
    surveyZoneSelection: null, spaceZoneBindings: {}, spatialRequests: {}, scratchTopicSnapshots: {}, surveyToolsOpen: false, config: composerConfig, activeWorkspaceId: workspace.id,
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
  css?.remove(); vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  if (savedStorage === null) localStorage.removeItem('agentmux-workbench-v1'); else localStorage.setItem('agentmux-workbench-v1', savedStorage)
})
async function fill(field: HTMLInputElement, value: string) {
  expect(field).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function submit(form: HTMLFormElement) {
  expect(form).not.toBeNull(); await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
async function enterSurvey() { await dom.click('[aria-label="Survey: browse and manage pages"]') }
const catalog = () => spatialCatalog(useAppStore.getState(), [])
const originalZoneId = () => catalog().tabs.find(tab => tab.tabId === mixed.id)!.zoneId!
async function choose(zoneId = originalZoneId()) {
  const row = [...dom.container.querySelectorAll<HTMLElement>('[data-survey-zone-id]')].find(row => row.dataset.surveyZoneId === zoneId)
  expect(row).toBeDefined(); await act(async () => row!.querySelector<HTMLButtonElement>('.survey-item')!.click())
}
const slot = () => [...dom.container.querySelectorAll<HTMLElement>('.global-survey-surface .workbench-tab-slot[data-workbench-tab-id]')].find(slot => slot.dataset.workbenchTabId === useAppStore.getState().surveyZoneSelection?.active?.tabId)!
const selectedRegion = () => [...slot().querySelectorAll<HTMLElement>('[data-workbench-region-id]')].find(region => region.dataset.workbenchRegionId === useAppStore.getState().surveyZoneSelection?.active?.regionId)!
const address = () => selectedRegion().querySelector<HTMLInputElement>('[aria-label="Browser address"]')!
async function selectRegion(regionId: string) {
  const region = slot().querySelector<HTMLElement>(`[data-workbench-region-id="${regionId}"]`)!
  expect(region).not.toBeNull(); await act(async () => region.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
}
function healthy() {
  const state = useAppStore.getState()
  expect(state.sessions).toEqual([session]); expect(state.sessions[0]!.control.run.runId).toBe('run-agent-1')
  expect(state.agentComposerDrafts[session.id]).toBe('Keep my draft'); expect(state.agentFocus.execution.sessionId).toBe(session.id)
  expect(state.tabs[mixed.id]?.regions[agent.regionId]).toEqual(agent)
  expect(state.documents[key]?.content).toBe('Unsaved file'); expect(api.sessions.stop).not.toHaveBeenCalled()
}
function scope(selection: SurveyZoneSelection): WorkbenchProjection {
  return { entity: { kind: 'zone', zoneId: selection.zoneId }, presentationId: 'survey-workbench', displayWorkspaceId: workspace.id,
    catalog: catalog(), selection: selection.selection, onSelect: vi.fn() }
}

it('loads one Zone item for multiple mixed original Tabs and reuses the original complete content tree', async () => {
  const second = createWorkbenchTab('second', pageC)
  const foreign = createWorkbenchTab('foreign', { ...pageA, workspaceId: otherWorkspace.id, regionId: 'foreign-page', browserId: 'foreign-browser' })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, otherWorkspace] }, tabs: { [mixed.id]: mixed, [second.id]: second, [foreign.id]: foreign },
    layouts: { [workspace.id]: createWorkspaceLayout('original-group', [mixed.id, second.id]), [otherWorkspace.id]: createWorkspaceLayout('foreign-group', [foreign.id]) } })
  await dom.render(<App />)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-file-probe]')).not.toBeNull() })
  const before = useAppStore.getState(), terminal = dom.container.querySelector('[data-terminal-probe]'), fileNode = dom.container.querySelector('[data-file-probe]')
  const stage = dom.container.querySelector(`[data-native-browser-stage="${browser.id}"]`)
  expect(terminal).not.toBeNull(); expect(stage).not.toBeNull(); await enterSurvey()
  expect([...dom.container.querySelectorAll('[data-survey-zone-id]')].map(row => row.getAttribute('data-survey-zone-id'))).toEqual(catalog().zones.map(zone => zone.zoneId))
  expect(dom.container.querySelectorAll('[data-survey-zone-id]')).toHaveLength(2)
  await choose()
  expect(useAppStore.getState().surveyZoneSelection).toMatchObject({ zoneId: originalZoneId(), active: { tabId: mixed.id, regionId: agent.regionId } })
  expect(slot().querySelector('[data-native-browser-stage]')).toBe(stage); expect(slot().querySelector('[data-terminal-probe]')).toBe(terminal)
  expect(slot().querySelector('[data-file-probe]')).toBe(fileNode)
  expect([...slot().querySelectorAll('[data-workbench-region-id]')].map(region => region.getAttribute('data-workbench-region-id'))).toEqual(['agent-region', 'file-region', 'page-a', 'page-b'])
  expect(dom.container.querySelectorAll(`[data-native-browser-stage="${browser.id}"]`)).toHaveLength(1)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(api.browser.create).not.toHaveBeenCalled(); healthy()
})

it('keeps original content attached when the same addressed slot is replaced by a multi-Group tree', async () => {
  const second = createWorkbenchTab('second', pageC)
  useAppStore.setState({ tabs: { [mixed.id]: mixed, [second.id]: second }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [mixed.id, second.id]) } })
  await dom.render(<App />); await enterSurvey(); await choose(); await selectRegion(pageB.regionId)
  const original = slot().querySelector('.retained-workbench-view')!, field = address(), terminal = slot().querySelector('[data-terminal-probe]')!
  await fill(field, 'Retain multi-Group input'); field.setSelectionRange(2, 11)
  const state = useAppStore.getState(), first = { ...state.layouts[workspace.id]!.groups[0]!, tabOrder: [mixed.id], activeTabId: mixed.id }
  const other = { id: 'second-group', tabOrder: [second.id], recentTabIds: [second.id], activeTabId: second.id }
  const a = state.surveyZoneSelection!.active!, b = { ...a, groupId: other.id, tabId: second.id, regionId: pageC.regionId }
  const layout = { ...state.layouts[workspace.id]!, groups: [first, other], root: { type: 'split' as const, direction: 'horizontal' as const, ratio: 0.58,
    first: { type: 'leaf' as const, groupId: first.id }, second: { type: 'leaf' as const, groupId: other.id } } }
  await act(async () => useAppStore.setState({ layouts: { [workspace.id]: layout }, surveyZoneSelection: { zoneId: originalZoneId(), selection: [a, b], active: a } }))
  expect(slot().querySelector('.retained-workbench-view')).toBe(original); expect(original.isConnected).toBe(true)
  expect(slot().querySelector('[data-terminal-probe]')).toBe(terminal); expect(address()).toBe(field)
  expect(field.value).toBe('Retain multi-Group input'); expect([field.selectionStart, field.selectionEnd]).toEqual([2, 11])
  expect(dom.container.querySelectorAll('.global-survey-surface .retained-workbench-view')).toHaveLength(2)
  expect(dom.container.querySelector('.global-survey-surface [data-native-browser-stage="browser-c"]')).not.toBeNull()
  await act(async () => useAppStore.setState({ surveyZoneSelection: { zoneId: originalZoneId(), selection: [a, b, { ...b, tabId: 'unknown-tab', regionId: 'unknown-region' }], active: a } }))
  expect(slot().querySelector('.retained-workbench-view')).toBe(original); expect(address()).toBe(field)
  expect(dom.container.querySelector('.global-survey-surface')!.textContent).toContain('More than one selection refers')
  expect(dom.container.querySelectorAll('.global-survey-surface .retained-workbench-view')).toHaveLength(1)
  expect(useAppStore.getState().layouts[workspace.id]).toBe(layout); expect(api.browser.create).not.toHaveBeenCalled(); healthy()
})

it('keeps the spatial projection stable for status clocks and unreferenced Sessions but updates exact execution facts', async () => {
  const unrelated = composerSession('unreferenced-agent')
  useAppStore.setState({ sessions: [session, unrelated] })
  await dom.render(<App />); await enterSurvey(); await choose(); await selectRegion(pageB.regionId)
  const first = observation.survey.at(-1)!, original = slot().querySelector('.retained-workbench-view')!, field = address()
  await fill(field, 'Retain stable directory input'); field.setSelectionRange(3, 12)
  const statusOnly = { ...session, updatedAt: 5, latestOutputBytes: 120, status: { ...session.status, observedAt: 5 } }
  const unrelatedChanged = { ...unrelated, updatedAt: 6, hostId: 'another-host', workspacePath: '/unrelated', status: { ...unrelated.status, observedAt: 6 } }
  await act(async () => useAppStore.setState({ sessions: [statusOnly, unrelatedChanged] }))
  const after = observation.survey.at(-1)!
  expect(after.catalog).toBe(first.catalog); expect(after.projection).toBe(first.projection); expect(after.viewTargets).toBe(first.viewTargets)
  expect(slot().querySelector('.retained-workbench-view')).toBe(original); expect(address()).toBe(field)
  expect([field.selectionStart, field.selectionEnd]).toEqual([3, 12]); expect(field.value).toBe('Retain stable directory input')
  const changed = { ...statusOnly, hostId: 'changed-host', workspacePath: '/changed-resource', control: { ...statusOnly.control, run: { ...statusOnly.control.run, runId: 'changed-run' } } }
  await act(async () => useAppStore.setState({ sessions: [changed, unrelatedChanged] }))
  const related = observation.survey.at(-1)!
  expect(related.catalog).not.toBe(first.catalog)
  expect(related.catalog!.regions.find(region => region.regionId === agent.regionId)).toMatchObject({ runId: 'changed-run', execution: { hostId: 'changed-host', cwd: '/changed-resource' } })
  await dom.click('[aria-label="Space: show terminal and file workbench"]')
  const hidden = observation.survey.at(-1)!
  await act(async () => useAppStore.setState({ sessions: [{ ...changed, updatedAt: 9, workspacePath: '/hidden-resource' }, unrelatedChanged] }))
  expect(observation.survey.at(-1)!.catalog).toBe(hidden.catalog)
  expect(api.browser.create).not.toHaveBeenCalled(); expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs[mixed.id]!.regions[agent.regionId]).toEqual(agent)
})

it('groups original Zones by the existing resource Project owner and keeps worktrees, Scratch and unknown sources exact', async () => {
  const branch = { ...workspace, id: 'branch-workspace', kind: 'worktree' as const, path: '/repo/.worktrees/research', repoPath: '/repo', branch: 'research' }
  const remote = { ...workspace, id: 'remote-workspace', hostId: 'remote' }
  const different = { ...workspace, id: 'different-workspace', path: '/different' }
  const scratch = { ...workspace, id: SCRATCH_WORKSPACE_ID, path: '/topics', name: 'Scratch' }
  const unknown = createWorkbenchTab('unknown-resource-tab', { ...pageC, workspaceId: 'missing-workspace', browserId: 'unknown-browser', regionId: 'unknown-resource-region' })
  unknown.space = { zoneId: 'retained-unknown-zone', spaceId: directoryIdentity('local', '/missing') }
  const additional = [branch, remote, different, scratch].map(resource => createWorkbenchTab(`tab-${resource.id}`, { ...pageC, workspaceId: resource.id, browserId: `browser-${resource.id}`, regionId: `region-${resource.id}` }))
  const topics = ['a', 'b'].map(id => ({ id, title: 'Same Topic', summary: '', directoryPath: `/topics/${id}`, topicPath: `/topics/${id}/topic.md`, collaborators: [] }))
  const originalZone = originalZoneId(), rootSpace = directoryIdentity(workspace.hostId, workspace.path)
  useAppStore.setState({ config: { ...composerConfig, workspaces: [branch, workspace, remote, different, scratch] },
    tabs: Object.fromEntries([mixed, ...additional, unknown].map(tab => [tab.id, tab])),
    layouts: Object.fromEntries([workspace, branch, remote, different, scratch, { id: 'missing-workspace' }].map(resource => [resource.id, createWorkspaceLayout(`group-${resource.id}`, resource.id === workspace.id ? [mixed.id] : resource.id === 'missing-workspace' ? [unknown.id] : [`tab-${resource.id}`])])),
    spaceZoneBindings: { [originalZone]: { spaceId: rootSpace, workspaceId: workspace.id, relations: Object.fromEntries(topics.map(topic => [directoryIdentity(scratch.hostId, topic.directoryPath), true])) } },
    scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1, topics, error: null, reading: false } } })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  const source = vi.spyOn(useAppStore.getState(), 'selectWorkspace').mockResolvedValue(undefined)
  await dom.render(<App />); await enterSurvey(); await choose(originalZone)
  const grouped = [...dom.container.querySelectorAll<HTMLElement>('[data-survey-project-id]')]
  expect(grouped.map(group => [group.dataset.surveyProjectId, group.querySelectorAll('[data-survey-zone-id]').length])).toEqual([
    [workspaceProjectId(workspace), 2], [workspaceProjectId(remote), 1], [workspaceProjectId(different), 1], ['scratch', 1], ['unknown', 1]])
  const original = useAppStore.getState()
  expect(grouped[0]!.querySelector('header button')!.textContent).toBe(workspace.name)
  expect(grouped[0]!.querySelector('[data-survey-zone-id]')!.textContent).not.toContain('No Topic links')
  expect(grouped[0]!.querySelector('[data-survey-zone-id]')!.textContent).not.toContain('Human control')
  expect(grouped.at(-1)!.textContent).toContain('Unknown source'); expect(grouped.at(-1)!.querySelector('[aria-label="Resource unknown"]')).not.toBeNull()
  expect(grouped.at(-1)!.querySelector('.survey-item strong')!.textContent).toBe('Same title')
  await act(async () => grouped[0]!.querySelector<HTMLButtonElement>('header button')!.click())
  expect(source).toHaveBeenCalledExactlyOnceWith(workspace.id)
  expect(useAppStore.getState().surveyZoneSelection).toBe(original.surveyZoneSelection); expect(useAppStore.getState().tabs).toBe(original.tabs)
  expect(useAppStore.getState().layouts).toBe(original.layouts); expect(api.browser.create).not.toHaveBeenCalled(); healthy()
})

it('resizes the actual Survey sidebar with pointer and keyboard while preserving its original work surface and saved preference in narrow space', async () => {
  await dom.render(<App />); await enterSurvey(); await choose(); await selectRegion(pageB.regionId)
  const sidebar = dom.container.querySelector<HTMLElement>('[aria-label="Survey items"]')!, handle = sidebar.querySelector<HTMLElement>('[aria-label="Resize Survey items"]')!
  const state = useAppStore.getState(), original = slot().querySelector('.retained-workbench-view')!, field = address()
  await fill(field, 'Original sidebar input'); field.setSelectionRange(2, 9)
  expect(handle.getAttribute('aria-orientation')).toBe('vertical'); expect(sidebar.style.width).toBe('220px')
  await act(async () => handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 220 })))
  await act(async () => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: 260 })); await new Promise(requestAnimationFrame) })
  expect(sidebar.style.width).toBe('260px'); expect(useAppStore.getState().surveySidebarWidth).toBe(220)
  await act(async () => window.dispatchEvent(new MouseEvent('mouseup')))
  expect(useAppStore.getState().surveySidebarWidth).toBe(260)
  for (const [key, width] of [['ArrowRight', 276], ['End', 280], ['Home', 176], ['ArrowLeft', 176]] as const) {
    await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    expect(useAppStore.getState().surveySidebarWidth).toBe(width); expect(handle.getAttribute('aria-valuenow')).toBe(String(width))
  }
  await act(async () => useAppStore.getState().setSurveySidebarWidth(400))
  expect(sidebar.style.width).toBe('280px'); expect(useAppStore.getState().surveySidebarWidth).toBe(400)
  const saved = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
  expect(saved.surveySidebarWidth).toBe(400); expect(restorePersistedUiState(composerConfig, saved).surveySidebarWidth).toBe(400)
  expect(restorePersistedUiState(composerConfig, { ...saved, surveySidebarWidth: Number.NaN }).surveySidebarWidth).toBe(220)
  expect(useAppStore.getState().layouts).toBe(state.layouts); expect(useAppStore.getState().tabs).toBe(state.tabs)
  await dom.click('[aria-label="Space: show terminal and file workbench"]'); await enterSurvey()
  expect(sidebar.style.width).toBe('280px'); expect(useAppStore.getState().surveySidebarWidth).toBe(400)
  expect(slot().querySelector('.retained-workbench-view')).toBe(original); expect(address()).toBe(field); expect(field.value).toBe('Original sidebar input')
  expect([field.selectionStart, field.selectionEnd]).toEqual([2, 9]); expect(useAppStore.getState().layouts).toEqual(state.layouts)
  expect(projectPersistedWorkbench(useAppStore.getState())).toEqual(projectPersistedWorkbench(state))
  expect(useAppStore.getState().surveyZoneSelection).toEqual(state.surveyZoneSelection)
  expect(api.browser.create).not.toHaveBeenCalled(); healthy()
})

it('controls Tab and Region selection without moving Space focus or the original editor caret', async () => {
  const second = createWorkbenchTab('second', pageC)
  useAppStore.setState({ tabs: { [mixed.id]: mixed, [second.id]: second }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [mixed.id, second.id]) } })
  await dom.render(<App />); await act(async () => useAppStore.getState().focusRegion(workspace.id, mixed.id, agent.regionId, 'keyboard'))
  const before = useAppStore.getState(), terminal = dom.container.querySelector('[data-terminal-probe]')!
  await enterSurvey(); await choose(); await selectRegion(pageB.regionId)
  const field = address(); await fill(field, 'Unsubmitted address'); field.focus(); field.setSelectionRange(3, 14)
  const originalLayout = useAppStore.getState().layouts
  await act(async () => field.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  expect(useAppStore.getState().surveyZoneSelection?.active?.regionId).toBe(pageB.regionId)
  expect(useAppStore.getState().regionCaretFocus).toBeNull(); expect(useAppStore.getState().retainedSpatialFocus).toBe(before.retainedSpatialFocus)
  expect(useAppStore.getState().layouts).toBe(originalLayout); expect([field.selectionStart, field.selectionEnd]).toEqual([3, 14])
  await dom.click('.global-survey-surface [data-workbench-tab-id="second"].workbench-tab')
  expect(useAppStore.getState().surveyZoneSelection?.active?.tabId).toBe(second.id)
  expect(useAppStore.getState().layouts).toBe(originalLayout)
  await dom.click('.global-survey-surface [data-workbench-tab-id="mixed"].workbench-tab')
  await selectRegion(pageB.regionId)
  expect(address()).toBe(field); expect(address().value).toBe('Unsubmitted address')
  expect(slot().querySelector('[data-terminal-probe]')).toBe(terminal); healthy()
})

it('creates an original temporary Zone from raw central input and navigates the same Browser in Survey', async () => {
  await dom.render(<App />); await enterSurvey()
  const before = useAppStore.getState(), createZone = vi.spyOn(before, 'createWorkbenchZone')
  await fill(dom.container.querySelector<HTMLInputElement>('.survey-start-input input')!, '  protocol notes  ')
  await submit(dom.container.querySelector<HTMLFormElement>('.survey-start-input')!)
  const selection = useAppStore.getState().surveyZoneSelection!, reference = selection.active!
  expect(createZone).toHaveBeenCalledExactlyOnceWith({ workspaceId: workspace.id, spaceIds: [] })
  expect(selection.zoneId).not.toBe(originalZoneId())
  expect(useAppStore.getState().tabs[reference.tabId]!.space?.zoneId).toBe(selection.zoneId)
  expect(api.browser.create).toHaveBeenCalledExactlyOnceWith(reference.regionId, '  protocol notes  ', workspace.id)
  expect(useAppStore.getState().layouts[workspace.id]!.groups[0]!.activeTabId).toBe(mixed.id)
  await fill(address(), '  second raw query  '); await submit(address().form!)
  expect(api.browser.navigate).toHaveBeenLastCalledWith(reference.regionId, '  second raw query  ')
  expect(useAppStore.getState().surveyZoneSelection).toBe(selection); expect(useAppStore.getState().mainSurface).toBe('survey')
  healthy()
})

it('retries an attached Browser after a late reply failure without creating another Zone or Browser', async () => {
  const realCreate = useAppStore.getState().createBrowser, createZone = vi.spyOn(useAppStore.getState(), 'createWorkbenchZone')
  const create = vi.fn(async (...args: Parameters<typeof realCreate>) => { await realCreate(...args); throw new Error('Late attachment receipt failed') })
  useAppStore.setState({ createBrowser: create })
  await dom.render(<App />); await enterSurvey()
  const field = dom.container.querySelector<HTMLInputElement>('.survey-start-input input')!
  await fill(field, 'Retain this query'); await submit(field.form!)
  expect(createZone).toHaveBeenCalledTimes(1); expect(api.browser.create).toHaveBeenCalledTimes(1)
  const attachedTabs = useAppStore.getState().tabs
  const attached = Object.values(attachedTabs).find(tab => tab.id !== mixed.id)!
  expect(attached.regions[attached.layout.activeRegionId]?.kind).toBe('browser')
  expect(dom.container.querySelector('.survey-error')?.textContent).toContain('Late attachment receipt failed')
  await dom.click('.survey-error button')
  expect(createZone).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledTimes(1); expect(api.browser.create).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().tabs).toBe(attachedTabs)
  expect(useAppStore.getState().surveyZoneSelection?.active?.tabId).toBe(attached.id); healthy()
})

it('keeps the same failed exact preparation and refuses to reclaim it after another healthy Region appears', async () => {
  vi.mocked(api.browser.create).mockRejectedValueOnce(new Error('Native create failed')).mockRejectedValueOnce(new Error('Retry failed'))
  const createZone = vi.spyOn(useAppStore.getState(), 'createWorkbenchZone')
  await dom.render(<App />); await enterSurvey()
  const field = dom.container.querySelector<HTMLInputElement>('.survey-start-input input')!
  await fill(field, 'Keep query'); await submit(field.form!)
  const launcher = Object.values(useAppStore.getState().tabs).find(tab => tab.id !== mixed.id)!
  await submit(field.form!)
  expect(createZone).toHaveBeenCalledTimes(1); expect(api.browser.create).toHaveBeenCalledTimes(2)
  expect(api.browser.create).toHaveBeenNthCalledWith(2, launcher.layout.activeRegionId, 'Keep query', workspace.id)
  await act(async () => useAppStore.getState().splitRegion(workspace.id, launcher.id, launcher.layout.activeRegionId, 'right'))
  const changed = useAppStore.getState().tabs[launcher.id]
  await submit(field.form!)
  expect(createZone).toHaveBeenCalledTimes(1); expect(api.browser.create).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().tabs[launcher.id]).toBe(changed); expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(2)
  expect(dom.container.querySelector('.survey-error')?.textContent).toContain('content and exact reference are kept'); healthy()
})

it('adds a Tab and splits a Region through the original default Zone controls', async () => {
  const launcher = vi.spyOn(useAppStore.getState(), 'openLauncher')
  await dom.render(<App />); await enterSurvey(); await choose()
  const before = useAppStore.getState(); await dom.click('.global-survey-surface [title="New tab"]')
  const selection = useAppStore.getState().surveyZoneSelection!, reference = selection.active!
  expect(launcher).toHaveBeenLastCalledWith({ workspaceId: workspace.id, displayWorkspaceId: workspace.id, tabGroupId: 'original-group', zoneId: selection.zoneId, reveal: false })
  expect(useAppStore.getState().tabs[reference.tabId]?.space?.zoneId).toBe(selection.zoneId)
  expect(useAppStore.getState().layouts[workspace.id]!.groups[0]!.activeTabId).toBe(before.layouts[workspace.id]!.groups[0]!.activeTabId)
  expect(slot().querySelector('[aria-label="Split current tab to the right"]')).toBeNull()
  await dom.click('.global-survey-surface [aria-label="Split current tab to the right"]')
  expect(Object.keys(useAppStore.getState().tabs[reference.tabId]!.regions)).toHaveLength(2)
  expect(useAppStore.getState().tabs[reference.tabId]!.layout.root.type).toBe('split')
  expect(useAppStore.getState().surveyZoneSelection?.active?.tabId).toBe(reference.tabId); healthy()
})

it('opens a new Tab directly at an exact foreign display Group without moving the resource layout', async () => {
  const source = useAppStore.getState().layouts[workspace.id]!, foreignLayout = createWorkspaceLayout('display-first', [])
  foreignLayout.groups.push({ id: 'display-second', tabOrder: [mixed.id], activeTabId: mixed.id, recentTabIds: [mixed.id] })
  foreignLayout.root = { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', groupId: 'display-first' }, second: { type: 'leaf', groupId: 'display-second' } }
  const reference = { displayWorkspaceId: otherWorkspace.id, groupId: 'display-second', tabId: mixed.id, regionId: pageB.regionId }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, otherWorkspace] },
    layouts: { [workspace.id]: source, [otherWorkspace.id]: foreignLayout }, surveyZoneSelection: { zoneId: originalZoneId(), selection: [reference], active: reference } })
  const launcher = vi.spyOn(useAppStore.getState(), 'openLauncher')
  await dom.render(<App />); await enterSurvey(); await dom.click('.global-survey-surface [title="New tab"]')
  const current = useAppStore.getState(), created = current.surveyZoneSelection!.active!
  expect(launcher).toHaveBeenLastCalledWith({ workspaceId: workspace.id, displayWorkspaceId: otherWorkspace.id, tabGroupId: 'display-second', zoneId: originalZoneId(), reveal: false })
  expect(current.tabs[created.tabId]?.workspaceId).toBe(workspace.id); expect(current.layouts[workspace.id]).toBe(source)
  expect(current.layouts[otherWorkspace.id]!.groups.map(group => group.tabOrder)).toEqual([[], [mixed.id, created.tabId]])
  expect(current.activeWorkspaceId).toBe(workspace.id); expect(current.mainSurface).toBe('survey'); healthy()
})

it('preserves conflicting unknown plus valid Group selections rather than picking a winner', async () => {
  const valid = surveyInitialZoneSelection(catalog(), originalZoneId(), useAppStore.getState().layouts, useAppStore.getState().tabs, workspace.id).active!
  const unknown = { ...valid, tabId: 'retained-tab', regionId: 'retained-region' }
  const selected = { zoneId: originalZoneId(), selection: [unknown, valid], active: valid }
  useAppStore.setState({ surveyZoneSelection: selected })
  await dom.render(<App />); await enterSurvey()
  expect(useAppStore.getState().surveyZoneSelection).toBe(selected)
  expect(dom.container.querySelector('.global-survey-surface')!.textContent).toContain('More than one selection refers')
  expect(dom.container.querySelector('.global-survey-surface .retained-workbench-view')).toBeNull()
  expect(projectWorkbenchProjection(useAppStore.getState().layouts[workspace.id], useAppStore.getState().tabs, scope(selected)).layout?.groups[0]!.activeTabId).toBeNull()
  healthy()
})

it('does not multiply Tabs by linked Topics or Regions, and keeps simultaneous original placements honest', async () => {
  const selected = surveyInitialZoneSelection(catalog(), originalZoneId(), useAppStore.getState().layouts, useAppStore.getState().tabs, workspace.id)
  const original = catalog(), projection = scope(selected)
  projection.catalog = { ...original, locations: original.locations.flatMap(location => [location, { ...location, spaceId: 'second-topic' }]) }
  const projected = projectWorkbenchProjection(useAppStore.getState().layouts[workspace.id], useAppStore.getState().tabs, projection)
  expect(projected.layout?.groups[0]!.tabOrder).toEqual([mixed.id]); expect(projected.unsupportedTabIds.size).toBe(0)
  const layout = createWorkspaceLayout('original-group', [mixed.id])
  layout.groups.push({ id: 'other-group', tabOrder: [mixed.id], activeTabId: mixed.id, recentTabIds: [mixed.id] })
  layout.root = { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', groupId: 'original-group' }, second: { type: 'leaf', groupId: 'other-group' } }
  const ref = { ...selected.active!, groupId: 'other-group' }
  useAppStore.setState({ layouts: { [workspace.id]: layout }, surveyZoneSelection: { ...selected, selection: [selected.active!, ref] } })
  await dom.render(<App />); await enterSurvey()
  const slots = [...dom.container.querySelectorAll<HTMLElement>('.global-survey-surface .workbench-tab-slot')]
  expect(slots).toHaveLength(2); expect(new Set(slots.map(slot => slot.id)).size).toBe(2)
  expect(dom.container.querySelector('.global-survey-surface')!.textContent).toContain('Simultaneous live presentation is not available')
  expect(dom.container.querySelector('.global-survey-surface .retained-workbench-view')).toBeNull()
  expect(dom.container.querySelectorAll('[data-terminal-probe]')).toHaveLength(1); healthy()
})

it('feeds visibility and memory owners only the selected original tree and hides it through Settings', async () => {
  const foreign = createWorkbenchTab('foreign', { ...pageA, workspaceId: otherWorkspace.id, regionId: 'foreign-page', browserId: 'foreign-browser' })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, otherWorkspace] }, tabs: { [mixed.id]: mixed, [foreign.id]: foreign },
    layouts: { ...useAppStore.getState().layouts, [otherWorkspace.id]: createWorkspaceLayout('foreign-group', [foreign.id]) } })
  await dom.render(<App />); await enterSurvey(); await choose()
  const latest = observation.memory.at(-1)!
  expect([...latest.input.projectedVisibleTabIds!]).toEqual([mixed.id])
  expect(latest.candidates.map(({ id, visible }) => ({ id, visible }))).toEqual([
    { id: 'page-a', visible: true }, { id: 'page-b', visible: true }, { id: 'file-region', visible: true }, { id: 'foreign-page', visible: false }])
  const state = useAppStore.getState(), terminalOptions = observation.terminals.at(-1)!
  const terminalInput: TerminalParkingCollectionInput = { tabs: state.tabs, layouts: state.layouts, sessions: state.sessions, activeWorkspaceId: state.activeWorkspaceId, ...terminalOptions }
  expect(collectTerminalColdParkCandidates(terminalInput).map(({ id, visible }) => ({ id, visible }))).toEqual([{ id: 'agent-region', visible: true }])
  await dom.click('[aria-label="Settings"]')
  expect([...observation.memory.at(-1)!.input.projectedVisibleTabIds!]).toEqual([]); healthy()
})

it('restores exact Zone references through storage and original Browser rebuild after restart', async () => {
  const layout = useAppStore.getState().layouts[workspace.id]!, original = surveyInitialZoneSelection(catalog(), originalZoneId(), useAppStore.getState().layouts, useAppStore.getState().tabs, workspace.id)
  const reference = { ...original.active!, regionId: pageB.regionId }, selection = { ...original, selection: [reference], active: reference }
  const durable = { mainSurface: 'survey', activeWorkspaceId: workspace.id, surveyZoneSelection: selection,
    restoredWorkbench: projectPersistedWorkbench({ tabs: useAppStore.getState().tabs, layouts: { [workspace.id]: layout } }),
    documents: { [key]: { path: file.path, content: 'Unsaved file', revision: 'disk' } }, dirtyDocuments: { [key]: true },
    agentComposerDrafts: { [session.id]: 'Keep my draft' }, agentFocus: useAppStore.getState().agentFocus }
  useAppStore.setState({ loading: true, mainSurface: 'workbench', surveyZoneSelection: null, tabs: {}, layouts: {}, restoredWorkbench: null, sessions: [] })
  localStorage.setItem('agentmux-workbench-v1', JSON.stringify({ version: 1, state: durable })); await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().surveyZoneSelection).toEqual(selection)
  useAppStore.setState({ loading: false }); await dom.render(<App />)
  expect(dom.container.querySelector('.global-survey-surface')!.textContent).toContain('exact reference is kept')
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig); vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.mocked(api.browser.create).mockImplementation(async id => id === browser.id ? browser : { ...browser, ...pageB, id })
  let dispose!: () => void
  await act(async () => { dispose = await realInitialize() })
  try {
    expect(useAppStore.getState().surveyZoneSelection).toEqual(selection)
    expect(selectedRegion().querySelector('[data-native-browser-stage]')?.getAttribute('data-native-browser-stage')).toBe(pageB.browserId)
    expect(useAppStore.getState().layouts[workspace.id]).toEqual(layout); expect(api.browser.create).toHaveBeenCalledTimes(2); healthy()
  } finally { dispose() }
})

it('consumes real Topic relations by exact same-name IDs and retains cancellation when discovery becomes unknown', async () => {
  const scratch = { ...workspace, id: SCRATCH_WORKSPACE_ID, name: 'Scratch', path: '/topics' }
  const topics = ['a', 'b'].map(id => ({ id, title: 'Research', summary: '', directoryPath: `/topics/${id}`, topicPath: `/topics/${id}/topic.md`, collaborators: [] }))
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, scratch] }, scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1, topics, error: null, reading: false } } })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  const change = vi.spyOn(useAppStore.getState(), 'setZoneSpaceRelation')
  await dom.render(<App />); await enterSurvey(); await choose()
  const openMenu = async () => { const trigger = dom.container.querySelector<HTMLElement>('[aria-label="Link Topics"]')!; await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) }) }
  await openMenu()
  const spaceB = directoryIdentity(scratch.hostId, topics[1]!.directoryPath)
  const checkbox = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"][data-survey-topic-id]')].find(item => item.dataset.surveyTopicId === spaceB)!
  expect(checkbox()).not.toBeNull(); expect(checkbox().getAttribute('aria-checked')).toBe('false')
  await act(async () => checkbox().click())
  expect(change).toHaveBeenCalledExactlyOnceWith(originalZoneId(), spaceB, true)
  expect(checkbox().getAttribute('aria-checked')).toBe('true')
  expect(dom.container.querySelector('.survey-topic-relations')!.textContent).toContain('final disk confirmation is pending')
  await act(async () => useAppStore.setState({ scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 2, topics: null, error: 'Topic discovery failed', reading: false } } }))
  expect(checkbox().getAttribute('aria-checked')).toBe('true'); expect(document.querySelector('[role="menu"]')!.textContent).toContain('Unconfirmed linked spaces')
  expect(dom.container.querySelector('.survey-topic-relations')!.textContent).toContain('Topic discovery failed')
  vi.mocked(api.scratch.listTopics).mockResolvedValue([])
  await act(async () => checkbox().click())
  expect(change).toHaveBeenLastCalledWith(originalZoneId(), spaceB, false)
  expect(useAppStore.getState().tabs[mixed.id]).toBe(mixed); expect(useAppStore.getState().mainSurface).toBe('survey'); healthy()
})

it('keeps the live sidebar width and original work surface when its original save owner reports a host failure', async () => {
  const state = useAppStore.getState()
  useAppStore.setState({ restoredWorkbench: projectPersistedWorkbench(state) })
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig); vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.mocked(api.browser.create).mockImplementation(async id => id === browser.id ? browser : { ...browser, ...pageB, id })
  const dispose = await realInitialize()
  try {
    await dom.render(<App />); await enterSurvey(); await choose(); await selectRegion(pageB.regionId)
    const before = useAppStore.getState(), original = slot().querySelector('.retained-workbench-view')!, selected = before.surveyZoneSelection
    // Settle the prior selection through the original unload writer, then hold its trailing
    // debounce. The completed gesture itself must request a receipt, rather than borrowing a
    // later unrelated write's warning.
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const flush = vi.spyOn(api.ui, 'requestStorageFlush').mockRejectedValue(new Error('Sidebar save is temporarily unavailable.'))
    await dom.click('[aria-label="Resize Survey items"]')
    const handle = dom.container.querySelector('[aria-label="Resize Survey items"]')!
    await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(useAppStore.getState().workbenchSaveWarning).toContain('Sidebar save is temporarily unavailable.')
    expect(flush).toHaveBeenCalled(); expect(useAppStore.getState().surveySidebarWidth).toBe(236)
    expect(slot().querySelector('.retained-workbench-view')).toBe(original); expect(useAppStore.getState().surveyZoneSelection).toBe(selected)
    expect(useAppStore.getState().layouts).toBe(before.layouts); expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(dom.container.textContent).toContain('Sidebar save is temporarily unavailable.'); expect(api.sessions.stop).not.toHaveBeenCalled()
  } finally { vi.useRealTimers(); dispose() }
})

it('does not let a delayed new item steal a later explicit Zone selection', async () => {
  let finish!: (snapshot: BrowserSnapshot) => void
  vi.mocked(api.browser.create).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await dom.render(<App />); await enterSurvey()
  await dom.click('[aria-label="New survey item"]')
  const nativeId = vi.mocked(api.browser.create).mock.calls[0]![0]
  await choose(); const chosen = useAppStore.getState().surveyZoneSelection
  await act(async () => finish({ ...browser, id: nativeId, url: 'about:blank' }))
  expect(useAppStore.getState().surveyZoneSelection).toBe(chosen)
  expect(Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).filter(region => region.kind === 'browser').map(region => region.regionId)).toEqual([pageA.regionId, pageB.regionId, nativeId])
  expect(useAppStore.getState().mainSurface).toBe('survey'); healthy()
})

it.each(['close', 'promote'] as const)('follows the real Region %s result while retaining the original Zone and healthy siblings', async operation => {
  await dom.render(<App />); await enterSurvey(); await choose(); await selectRegion(pageB.regionId)
  const zoneId = useAppStore.getState().surveyZoneSelection!.zoneId
  await act(async () => {
    if (operation === 'close') await useAppStore.getState().closeRegion(workspace.id, mixed.id, pageB.regionId)
    else useAppStore.getState().promoteRegionToTab(workspace.id, mixed.id, pageB.regionId)
  })
  const selected = useAppStore.getState().surveyZoneSelection!
  expect(selected.zoneId).toBe(zoneId); expect(selected.active).not.toBeNull()
  if (operation === 'close') {
    expect(api.browser.close).toHaveBeenCalledExactlyOnceWith(pageB.browserId)
    expect(selected.active?.regionId).not.toBe(pageB.regionId)
    expect(Object.keys(useAppStore.getState().tabs[mixed.id]!.regions)).toEqual(['agent-region', 'page-a', 'file-region'])
  } else {
    expect(selected.active?.tabId).not.toBe(mixed.id); expect(selected.active?.regionId).toBe(pageB.regionId)
    expect(slot().querySelector('[data-native-browser-stage]')?.getAttribute('data-native-browser-stage')).toBe(pageB.browserId)
  }
  expect(dom.container.querySelector('.survey-restore-notice')).toBeNull(); healthy()
})

it('creates a Scratch temporary Zone and a new Tab without inheriting another active Topic', async () => {
  const scratch = { ...workspace, id: SCRATCH_WORKSPACE_ID, name: 'Scratch', path: '/topics' }
  const existing = createWorkbenchTab('topic-tab', { kind: 'launcher', regionId: 'topic-launcher', workspaceId: scratch.id })
  existing.topicId = 'topic-a'
  const topic = { id: 'topic-a', title: 'Topic', summary: '', directoryPath: '/topics/topic--a', topicPath: '/topics/topic--a/topic.md', collaborators: [] }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, scratch] }, activeWorkspaceId: scratch.id,
    tabs: { [mixed.id]: mixed, [existing.id]: existing }, layouts: { ...useAppStore.getState().layouts, [scratch.id]: createWorkspaceLayout('scratch-group', [existing.id]) },
    scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1, topics: [topic], error: null, reading: false } } })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic])
  await dom.render(<App />); await enterSurvey(); await dom.click('[aria-label="New survey item"]')
  const selected = useAppStore.getState().surveyZoneSelection!, tab = useAppStore.getState().tabs[selected.active!.tabId]!
  expect(tab.workspaceId).toBe(scratch.id); expect(tab.topicId).toBeUndefined(); expect(tab.space?.zoneId).toBe(selected.zoneId)
  await dom.click('.global-survey-surface [title="New tab"]')
  const next = useAppStore.getState().tabs[useAppStore.getState().surveyZoneSelection!.active!.tabId]!
  expect(next.id).not.toBe(tab.id); expect(next.topicId).toBeUndefined(); expect(next.space?.zoneId).toBe(selected.zoneId)
  expect(useAppStore.getState().tabs[existing.id]).toBe(existing); healthy()
})

it('keeps Browser control unknown while its native owner is unavailable without retiring the Zone or reusing a completed operator', async () => {
  await dom.render(<App />); await enterSurvey(); await choose()
  const selected = useAppStore.getState().surveyZoneSelection
  const operation = { id: 'op', browserId: browser.id, operator: { id: session.id, name: 'Live operator' }, startedAt: 1, phase: 'running' as const, summary: 'Working', url: browser.url, steps: [] }
  const snapshot = { ...browser, driving: true, activity: { control: 'agent' as const, operation } }
  const control = () => dom.container.querySelector<HTMLElement>('[data-survey-zone-id] .survey-item-activity > span')!
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: snapshot }))
  expect(control().title).toContain('Live operator')
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'unavailable', id: browser.id, error: 'Native owner destroyed' }))
  expect(control().title).toContain('page-a: Control unknown'); expect(control().title).not.toContain('Live operator')
  expect(useAppStore.getState().surveyZoneSelection).toBe(selected)
  expect(JSON.stringify(projectPersistedWorkbench(useAppStore.getState()))).not.toContain('nativeOwnerUnavailable')
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...snapshot, error: 'Native owner destroyed' } }))
  expect(control().title).toContain('Live operator')
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...snapshot, activity: { control: 'agent', operation: { ...operation, phase: 'completed', finishedAt: 2 } } } }))
  expect(control().title).not.toContain('Live operator'); healthy()
})


it('retains an unsupported direct Region reference without painting its parent Tab or sibling Regions', async () => {
  const before = useAppStore.getState(), reference = { displayWorkspaceId: workspace.id, groupId: 'original-group', tabId: mixed.id, regionId: pageB.regionId }
  const projection: WorkbenchProjection = { entity: { kind: 'region', regionId: pageB.regionId }, presentationId: 'region-surface', displayWorkspaceId: workspace.id, catalog: catalog(), selection: [reference], onSelect: vi.fn() }
  expect(projection.catalog.tabs.find(tab => tab.tabId === mixed.id)!.regionIds).toEqual(['agent-region', 'file-region', 'page-a', 'page-b'])
  await dom.render(<WorkspaceWorkbench workspaceId={workspace.id} viewOwnership="projection" projection={projection} />)
  expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('Direct Region presentation is not available')
  expect(dom.container.querySelector('.pane-group')).toBeNull()
  expect(dom.container.querySelector('[data-workbench-region-id]')).toBeNull()
  expect(projection.selection).toEqual([reference]); expect(projection.onSelect).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts); healthy()
})
