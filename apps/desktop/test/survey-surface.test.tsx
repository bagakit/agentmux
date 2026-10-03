const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { emptyNotebookState, applyNotebookChange } from '@agentmux/core/notebook-catalog'
import { changeNotebook, useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import type { KnowledgeTopic, TopicKnowledgeWrite, TopicMethod, TopicParams, TopicResult } from '@agentmux/core/control'
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
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: (props: { surface: { path: string }; preview?: import('react').ReactNode }) => props.surface.path.endsWith('.note.json') && props.preview ? props.preview : <textarea data-file-probe defaultValue="Original file input" /> }))
const observation = vi.hoisted(() => ({
  catalogUnavailable: false,
  survey: [] as Parameters<typeof import('../src/renderer/src/components/GlobalSurveySurface').GlobalSurveySurface>[0][],
  memory: [] as { input: SurfaceMemoryCollectionInput; candidates: { id: string; kind: string; visible: boolean; navigationContextActive: boolean }[] }[],
  terminals: [] as { workbenchVisible: boolean; projectedVisibleTabIds?: ReadonlySet<string> | undefined }[],
  stages: [] as { stage: HTMLElement; host: string | null; update: () => void; stopped: boolean }[]
}))
vi.mock('../src/renderer/src/components/GlobalSurveySurface', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/GlobalSurveySurface')>()
  return { ...actual, GlobalSurveySurface: (props: Parameters<typeof actual.GlobalSurveySurface>[0]) => {
    observation.survey.push(props); return <actual.GlobalSurveySurface {...props} catalog={observation.catalogUnavailable ? { spaces: [], zones: [], bindings: [], tabs: [], regions: [], locations: [] } : props.catalog} />
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
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab, documentKey, workbenchSurfaces } from '../src/renderer/src/lib/workbench-tabs'
import { collectTerminalColdParkCandidates } from '../src/renderer/src/lib/terminal-cold-parking-coordinator'
import { projectPersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { surveyInitialZoneSelection, type SurveyZoneSelection } from '../src/renderer/src/lib/survey-workface'
import { projectWorkbenchProjection, resolveWorkbenchZone, workbenchRegionProjectionSlotId, type WorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { directoryIdentity } from '../src/shared/space-addresses'
import { useAppStore, restorePersistedUiState } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const realInitialize = useAppStore.getState().initialize
const workspace = composerConfig.workspaces[0]!
const scratchWorkspace = { ...workspace, id: SCRATCH_WORKSPACE_ID, path: _hygiene_fixturePath("scratch"), name: 'Topics' }
const session = composerSession()
const agent = { regionId: 'agent-region', kind: 'agent' as const, phase: 'attached' as const, workspaceId: workspace.id, sessionId: session.id }
const browser: BrowserSnapshot = { id: 'browser-a', navigationId: 'navigation-a', profileId: 'default', url: 'https://example.test/a', title: 'Same title', loading: false, canGoBack: true, canGoForward: true, viewport: 'responsive', driving: false, appLinkPrompt: null, error: null }
const pageA = { ...browser, regionId: 'page-a', kind: 'browser' as const, workspaceId: workspace.id, browserId: browser.id }
const pageB = { ...pageA, id: 'browser-b', browserId: 'browser-b', regionId: 'page-b', url: 'https://example.test/b' }
const pageC = { ...pageB, id: 'browser-c', browserId: 'browser-c', regionId: 'page-c' }
const otherWorkspace = { ...workspace, id: 'other-workspace', path: _hygiene_fixturePath("other-project"), name: 'Project' }
const file = { kind: 'file' as const, regionId: 'file-region', workspaceId: workspace.id, path: 'draft.md' }
const mixed = addWorkbenchRegion(addWorkbenchRegion(addWorkbenchRegion(createWorkbenchTab('mixed', agent), agent.regionId, 'right', pageA), pageA.regionId, 'down', pageB), agent.regionId, 'down', file)
mixed.layout = { ...mixed.layout, activeRegionId: agent.regionId }
const referenceA = { workspaceId: workspace.id, tabId: mixed.id, regionId: pageA.regionId }
const referenceB = { ...referenceA, regionId: pageB.regionId }
const key = documentKey(workspace.id, file.path)
let savedStorage: string | null
let savedLauncherStorage: string | null
let css: HTMLStyleElement

beforeEach(() => {
  let catalog = emptyNotebookState()
  vi.spyOn(api.notebooks, 'read').mockImplementation(async () => structuredClone(catalog))
  vi.spyOn(api.notebooks, 'apply').mockImplementation(async input => { catalog = applyNotebookChange(catalog, input, { kind: 'user', id: 'actual-ui-user' }, Date.now()); return structuredClone(catalog) })
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(() => () => {})
  useNotebookLibrary.setState({ state: null, issue: null })

  // The API module already loaded its project-native mock transport. Exercise the real native
  // visibility branch in BrowserPane instead of the web-preview placeholder branch.
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false)
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true })
  savedStorage = localStorage.getItem('agentmux-workbench-v1')
  savedLauncherStorage = localStorage.getItem('agentmux-launcher')
  useLauncherState.setState({ drafts: {}, sections: {}, executors: {}, persistenceIssue: null })
  observation.catalogUnavailable = false;
  observation.memory = []; observation.terminals = []; observation.stages = []; observation.survey = []
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const survey = this.closest('.global-survey-surface') !== null
    return new DOMRect(survey ? 200 : 250, 48, 600, 500)
  })
  useAppStore.setState({ loading: false, initialize: vi.fn(async () => () => {}), mainSurface: 'workbench',
    surveySidebarWidth: 220, surveySidebarCollapsed: false,
    notebookRecoveries: [], surveyNotebookId: null, surveyNoteId: null, surveyCollectedZones: {}, surveyExplorationNames: {}, surveyZoneSelection: null, spaceZoneBindings: {}, spatialRequests: {}, scratchTopicSnapshots: {}, surveyToolsOpen: false, config: { ...composerConfig, workspaces: [...composerConfig.workspaces, scratchWorkspace] }, activeWorkspaceId: workspace.id,
    sessions: [session], viewModes: { [session.id]: 'terminal' }, tabs: { [mixed.id]: mixed }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [mixed.id]), [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group') },
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
  if (savedLauncherStorage === null) localStorage.removeItem('agentmux-launcher'); else localStorage.setItem('agentmux-launcher', savedLauncherStorage)
  if (savedStorage === null) localStorage.removeItem('agentmux-workbench-v1'); else localStorage.setItem('agentmux-workbench-v1', savedStorage)
})
async function renderApp() { await dom.render(<DesktopClientUiProvider><App /></DesktopClientUiProvider>) }
function savedNotes() { return Object.values(useLauncherState.getState().drafts).flatMap(draft => draft.noteCreation ? [draft.noteCreation] : []) }
function pendingNoteReference() { const receipt = savedNotes().at(-1)!; expect(receipt.launcher).toBeDefined(); return receipt.launcher! }
function noteTransport(status: 'written' | 'unknown' | 'error' = 'written', waiting?: Promise<void>) {
  const writes = new Map<string, string>()
  vi.spyOn(api.files, 'write').mockImplementation(async (_id, input) => { if (input.expectedRevision === null && writes.has(input.path)) return { status: 'conflict', observedRevision: 'note-written' }; writes.set(input.path, input.content); await waiting; return status === 'written' ? { status, revision: 'note-written' } : { status, code: 'NOTE_WRITE', message: 'Note write not confirmed' } })
  vi.spyOn(api.files, 'read').mockImplementation(async (_id, path) => ({ status: 'read', document: { path, content: writes.get(path)!, revision: 'note-written' } }))
  return writes
}
async function recoverSameNote() { const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Recover same note')!; expect(button).toBeDefined(); await act(async () => button.click()) }
async function readyNoteRegion() { await vi.waitFor(async () => { await act(async () => {}); expect(savedNotes().at(-1), JSON.stringify(savedNotes().at(-1))).toMatchObject({ status: 'written', revealed: true }); expect(dom.container.querySelector('.global-survey-surface .note-editor')).not.toBeNull() }); return pendingNoteReference() }
async function fill(field: HTMLInputElement, value: string) {
  expect(field).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function submit(form: HTMLFormElement) {
  expect(form).not.toBeNull(); await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
async function enterSurvey() { await dom.click('[aria-label="Survey: browse and manage pages"]') }
async function openItemOptions() {
  const trigger = dom.container.querySelector<HTMLElement>('[aria-label="Exploration options"]')!
  expect(trigger).not.toBeNull()
  if (document.querySelector('.survey-item-menu')) return trigger
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  expect(document.querySelector('.survey-item-menu')).not.toBeNull()
  return trigger
}
async function openItemSubmenu(label: string) {
  await openItemOptions()
  const item = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!
  expect(item).not.toBeNull()
  await act(async () => { item.focus(); item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
}
function knowledgeTransport() {
  const topics: KnowledgeTopic[] = ['a', 'b'].map(id => ({ topicId: `view:${id}`, hostId: 'local', zoneId: `original-topic-zone-${id}`, directoryPath: (_hygiene_fixturePath("topics/") + (id) + ""),
    title: 'Research', summary: '', categorySpaceIds: ['category'], chatIds: [], spatialRevision: 7 }))
  const handler: typeof api.topics.call = async <M extends TopicMethod>(method: M, params: TopicParams<M>) => {
    if (method === 'topic.ls') return { topics, unavailable: [] } as unknown as TopicResult<M>
    if (method === 'topic.inspect') return { topic: topics.find(topic => topic.topicId === (params as { topicId: string }).topicId) ?? null, unavailable: [] } as unknown as TopicResult<M>
    if (method === 'topic.knowledge.write') return { entry: { ...(params as TopicKnowledgeWrite), revision: 'written', updatedAt: 1 }, diskDurability: 'confirmed' } as unknown as TopicResult<M>
    throw new Error(`Unexpected Topic call: ${method}`)
  }
  return vi.spyOn(api.topics, 'call').mockImplementation(handler)
}
const captureDialog = () => document.querySelector<HTMLElement>('[role="dialog"].topic-dialog:not(.topic-knowledge-editor)')!
const knowledgeDialog = () => document.querySelector<HTMLElement>('[role="dialog"].topic-knowledge-editor')!
async function captureScope(scope: 'research' | 'panel') {
  await openItemOptions()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === (scope === 'research' ? 'Save research to Topic…' : 'Save current panel to Topic…'))!
  expect(item).toBeDefined(); await act(async () => item.click())
  expect(captureDialog()).not.toBeNull()
}
async function selectValue(field: HTMLSelectElement, value: string) {
  expect(field).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function dialogButton(dialog: HTMLElement, text: string) {
  const button = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!
  expect(button).toBeDefined(); await act(async () => button.click())
}
const catalog = () => spatialCatalog(useAppStore.getState(), [])
const originalZoneId = () => catalog().tabs.find(tab => tab.tabId === mixed.id)!.zoneId!
async function choose(zoneId = originalZoneId()) {
  if (!useAppStore.getState().surveyCollectedZones[zoneId]) await act(async () => { expect(useAppStore.getState().setSurveyZoneCollected(zoneId, true)).toBe(true) })
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
  const state=useAppStore.getState()
  return resolveWorkbenchZone(selection.zoneId,catalog(),state.layouts,state.tabs,'survey-workbench',selection.selection,vi.fn())!
}

it('loads one Zone item for multiple mixed original Tabs and reuses the original complete content tree', async () => {
  const second = createWorkbenchTab('second', pageC)
  const foreign = createWorkbenchTab('foreign', { ...pageA, workspaceId: otherWorkspace.id, regionId: 'foreign-page', browserId: 'foreign-browser' })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, otherWorkspace] }, tabs: { [mixed.id]: mixed, [second.id]: second, [foreign.id]: foreign },
    layouts: { [workspace.id]: createWorkspaceLayout('original-group', [mixed.id, second.id]), [otherWorkspace.id]: createWorkspaceLayout('foreign-group', [foreign.id]) } })
  useAppStore.setState({ surveyCollectedZones: Object.fromEntries(catalog().zones.map(zone => [zone.zoneId, true])) })
  await renderApp()
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-file-probe]')).not.toBeNull() })
  const before = useAppStore.getState(), terminal = dom.container.querySelector('[data-terminal-probe]'), fileNode = dom.container.querySelector('[data-file-probe]')
  const stage = dom.container.querySelector(`[data-native-browser-stage="${browser.id}"]`)
  expect(terminal).not.toBeNull(); expect(stage).not.toBeNull(); await enterSurvey()
  expect(dom.container.querySelector('.topbar')).toBeNull()
  expect(dom.container.querySelector('main.main-shell--merged')).not.toBeNull()
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
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X)')
  const second = createWorkbenchTab('second', pageC)
  useAppStore.setState({ tabs: { [mixed.id]: mixed, [second.id]: second }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [mixed.id, second.id]) } })
  await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageB.regionId)
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
  const bars = [...dom.container.querySelectorAll('.global-survey-surface .pane-tabbar')]
  expect(bars).toHaveLength(2)
  expect(bars[0]!.querySelectorAll('.survey-window-controls-inset')).toHaveLength(1)
  expect(bars[1]!.querySelector('.survey-window-controls-inset')).toBeNull()
  expect(dom.container.querySelector('.global-survey-surface [data-native-browser-stage="browser-c"]')).not.toBeNull()
  await act(async () => useAppStore.setState({ surveyZoneSelection: { zoneId: originalZoneId(), selection: [a, b, { ...b, tabId: 'unknown-tab', regionId: 'unknown-region' }], active: a } }))
  expect(slot().querySelector('.retained-workbench-view')).toBe(original); expect(address()).toBe(field)
  expect(dom.container.querySelector('.survey-panel-status')).toBeNull()
  expect(dom.container.querySelectorAll('.global-survey-surface .retained-workbench-view')).toHaveLength(2)
  expect(useAppStore.getState().layouts[workspace.id]).toBe(layout); expect(api.browser.create).not.toHaveBeenCalled(); healthy()
})

it('keeps the spatial projection stable for status clocks and unreferenced Sessions but updates exact execution facts', async () => {
  const unrelated = composerSession('unreferenced-agent')
  useAppStore.setState({ sessions: [session, unrelated] })
  await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageB.regionId)
  const first = observation.survey.at(-1)!, original = slot().querySelector('.retained-workbench-view')!, field = address()
  await fill(field, 'Retain stable directory input'); field.setSelectionRange(3, 12)
  const statusOnly = { ...session, updatedAt: 5, latestOutputBytes: 120, status: { ...session.status, observedAt: 5 } }
  const unrelatedChanged = { ...unrelated, updatedAt: 6, hostId: 'another-host', workspacePath: _hygiene_fixturePath("unrelated"), status: { ...unrelated.status, observedAt: 6 } }
  await act(async () => useAppStore.setState({ sessions: [statusOnly, unrelatedChanged] }))
  const after = observation.survey.at(-1)!
  expect(after.catalog).toBe(first.catalog); expect(after.projection).toBe(first.projection); expect(after.viewTargets).toBe(first.viewTargets)
  expect(slot().querySelector('.retained-workbench-view')).toBe(original); expect(address()).toBe(field)
  expect([field.selectionStart, field.selectionEnd]).toEqual([3, 12]); expect(field.value).toBe('Retain stable directory input')
  const changed = { ...statusOnly, hostId: 'changed-host', workspacePath: _hygiene_fixturePath("changed-resource"), control: { ...statusOnly.control, run: { ...statusOnly.control.run, runId: 'changed-run' } } }
  await act(async () => useAppStore.setState({ sessions: [changed, unrelatedChanged] }))
  const related = observation.survey.at(-1)!
  expect(related.catalog).not.toBe(first.catalog)
  expect(related.catalog!.regions.find(region => region.regionId === agent.regionId)).toMatchObject({ runId: 'changed-run', execution: { hostId: 'changed-host', cwd: _hygiene_fixturePath("changed-resource") } })
  await dom.click('[aria-label="Space: show terminal and file workbench"]')
  const hidden = observation.survey.at(-1)!
  await act(async () => useAppStore.setState({ sessions: [{ ...changed, updatedAt: 9, workspacePath: _hygiene_fixturePath("hidden-resource") }, unrelatedChanged] }))
  expect(observation.survey.at(-1)!.catalog).toBe(hidden.catalog)
  expect(api.browser.create).not.toHaveBeenCalled(); expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs[mixed.id]!.regions[agent.regionId]).toEqual(agent)
})

it('flat list keeps exact original order across projects, worktrees, Scratch and unknown sources without group headers', async () => {
  const branch = { ...workspace, id: 'branch-workspace', kind: 'worktree' as const, path: _hygiene_fixturePath("repo/.worktrees/research"), repoPath: _hygiene_fixturePath("repo"), branch: 'research' }
  const remote = { ...workspace, id: 'remote-workspace', hostId: 'remote' }
  const different = { ...workspace, id: 'different-workspace', path: _hygiene_fixturePath("different") }
  const scratch = { ...workspace, id: SCRATCH_WORKSPACE_ID, path: _hygiene_fixturePath("topics"), name: 'Scratch' }
  const unknown = createWorkbenchTab('unknown-resource-tab', { ...pageC, workspaceId: 'missing-workspace', browserId: 'unknown-browser', regionId: 'unknown-resource-region' })
  unknown.space = { zoneId: 'retained-unknown-zone', spaceId: directoryIdentity('local', _hygiene_fixturePath("missing")) }
  const additional = [branch, remote, different, scratch].map(resource => createWorkbenchTab(`tab-${resource.id}`, { ...pageC, workspaceId: resource.id, browserId: `browser-${resource.id}`, regionId: `region-${resource.id}` }))
  const topics = ['a', 'b'].map(id => ({ id, title: 'Same Topic', summary: '', directoryPath: (_hygiene_fixturePath("topics/") + (id) + ""), topicPath: (_hygiene_fixturePath("topics/") + (id) + "/topic.md"), collaborators: [] }))
  const originalZone = originalZoneId(), rootSpace = directoryIdentity(workspace.hostId, workspace.path)
  useAppStore.setState({ config: { ...composerConfig, workspaces: [branch, workspace, remote, different, scratch] },
    tabs: Object.fromEntries([mixed, ...additional, unknown].map(tab => [tab.id, tab])),
    layouts: Object.fromEntries([workspace, branch, remote, different, scratch, { id: 'missing-workspace' }].map(resource => [resource.id, createWorkspaceLayout(`group-${resource.id}`, resource.id === workspace.id ? [mixed.id] : resource.id === 'missing-workspace' ? [unknown.id] : [`tab-${resource.id}`])])),
    spaceZoneBindings: { [originalZone]: { spaceId: rootSpace, workspaceId: workspace.id, relations: Object.fromEntries(topics.map(topic => [directoryIdentity(scratch.hostId, topic.directoryPath), true])) } },
    scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1, topics, error: null, reading: false } } })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  const source = vi.spyOn(useAppStore.getState(), 'selectWorkspace').mockResolvedValue(undefined)
  useAppStore.setState({ surveyCollectedZones: Object.fromEntries(catalog().zones.map(zone => [zone.zoneId, true])) })
  await renderApp(); await enterSurvey(); await choose(originalZone)
  const rows = [...dom.container.querySelectorAll<HTMLElement>('.survey-page-list > [data-survey-zone-id]')]
  expect(rows.map(row => row.dataset.surveyZoneId)).toEqual(catalog().zones.map(zone => zone.zoneId))
  expect(rows).toHaveLength(6)
  expect(dom.container.querySelector('[data-survey-project-id]')).toBeNull()
  const original = useAppStore.getState()
  expect(rows[0]!.textContent).not.toContain('No Topic links')
  expect(rows[0]!.textContent).not.toContain('Human control')
  expect(rows.at(-1)!.dataset.surveyZoneId).toBe('retained-unknown-zone')
  expect(rows.at(-1)!.querySelector('.survey-item strong')!.textContent).toBe('Same title')
  await openItemOptions()
  const sourceAction = document.querySelector<HTMLElement>(`[aria-label="Open resource Workspace: ${workspace.name}, ${workspace.hostId}, ${workspace.path}"]`)!
  expect(sourceAction).not.toBeNull()
  await act(async () => sourceAction.click())
  expect(source).toHaveBeenCalledExactlyOnceWith(workspace.id)
  expect(useAppStore.getState().surveyZoneSelection).toBe(original.surveyZoneSelection); expect(useAppStore.getState().tabs).toBe(original.tabs)
  expect(useAppStore.getState().layouts).toBe(original.layouts); expect(api.browser.create).not.toHaveBeenCalled(); healthy()
})

it('resizes the actual Survey sidebar with pointer and keyboard while preserving its original work surface and saved preference in narrow space', async () => {
  await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageB.regionId)
  const sidebar = dom.container.querySelector<HTMLElement>('[aria-label="Exploration navigation"]')!, handle = sidebar.querySelector<HTMLElement>('[aria-label="Resize Survey items"]')!
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
  await renderApp(); await act(async () => useAppStore.getState().focusRegion(workspace.id, mixed.id, agent.regionId, 'keyboard'))
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
  await renderApp(); await enterSurvey()
  const before = useAppStore.getState(), createZone = vi.spyOn(before, 'createWorkbenchZone')
  await fill(dom.container.querySelector<HTMLInputElement>('.survey-start-input input')!, '  protocol notes  ')
  await submit(dom.container.querySelector<HTMLFormElement>('.survey-start-input')!)
  const selection = useAppStore.getState().surveyZoneSelection!, reference = selection.active!
  expect(createZone).toHaveBeenCalledExactlyOnceWith({ workspaceId: SCRATCH_WORKSPACE_ID, spaceIds: [] })
  expect(selection.zoneId).not.toBe(originalZoneId())
  expect(useAppStore.getState().surveyCollectedZones).toEqual({ [selection.zoneId]: true })
  expect(useAppStore.getState().tabs[reference.tabId]!.space?.zoneId).toBe(selection.zoneId)
  expect(api.browser.create).toHaveBeenCalledExactlyOnceWith(reference.regionId, '  protocol notes  ', SCRATCH_WORKSPACE_ID)
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
  await renderApp(); await enterSurvey()
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
  await renderApp(); await enterSurvey()
  const field = dom.container.querySelector<HTMLInputElement>('.survey-start-input input')!
  await fill(field, 'Keep query'); await submit(field.form!)
  const launcher = Object.values(useAppStore.getState().tabs).find(tab => tab.id !== mixed.id)!
  await submit(field.form!)
  expect(createZone).toHaveBeenCalledTimes(1); expect(api.browser.create).toHaveBeenCalledTimes(2)
  expect(api.browser.create).toHaveBeenNthCalledWith(2, launcher.layout.activeRegionId, 'Keep query', SCRATCH_WORKSPACE_ID)
  await act(async () => useAppStore.getState().splitRegion(SCRATCH_WORKSPACE_ID, launcher.id, launcher.layout.activeRegionId, 'right'))
  const changed = useAppStore.getState().tabs[launcher.id]
  await submit(field.form!)
  expect(createZone).toHaveBeenCalledTimes(1); expect(api.browser.create).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().tabs[launcher.id]).toBe(changed); expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(2)
  expect(dom.container.querySelector('.survey-error')?.textContent).toContain('content and exact reference are kept'); healthy()
})

it('adds a Tab and splits a Region through the original default Zone controls', async () => {
  const launcher = vi.spyOn(useAppStore.getState(), 'openLauncher')
  await renderApp(); await enterSurvey(); await choose()
  const before = useAppStore.getState(); await dom.click('.global-survey-surface [title="New tab"]')
  const selection = useAppStore.getState().surveyZoneSelection!, reference = selection.active!
  expect(launcher).toHaveBeenLastCalledWith({ workspaceId: workspace.id, displayWorkspaceId: workspace.id, tabGroupId: 'original-group', zoneId: selection.zoneId, reveal: false })
  expect(useAppStore.getState().tabs[reference.tabId]?.space?.zoneId).toBe(selection.zoneId)
  expect(useAppStore.getState().tabs[reference.tabId]?.regions[reference.regionId]?.kind).toBe('browser')
  expect(api.browser.create).toHaveBeenLastCalledWith(reference.regionId, 'about:blank', workspace.id)
  const blankInput = selectedRegion().querySelector<HTMLInputElement>('[aria-label="Search or enter a web address"]')!
  expect(blankInput).not.toBeNull(); expect(document.activeElement).toBe(blankInput)
  expect(useAppStore.getState().layouts[workspace.id]!.groups[0]!.activeTabId).toBe(before.layouts[workspace.id]!.groups[0]!.activeTabId)
  expect(slot().querySelector('[aria-label="Split current tab to the right"]')).toBeNull()
  await dom.click('.global-survey-surface [aria-label="Split current tab to the right"]')
  expect(Object.keys(useAppStore.getState().tabs[reference.tabId]!.regions)).toHaveLength(2)
  expect(useAppStore.getState().tabs[reference.tabId]!.layout.root.type).toBe('split')
  expect(useAppStore.getState().surveyZoneSelection?.active?.tabId).toBe(reference.tabId); healthy()
})

it('creates a Tab in the original Zone composition while preserving foreign aliases', async () => {
  const source = useAppStore.getState().layouts[workspace.id]!, foreignLayout = createWorkspaceLayout('display-first', [])
  foreignLayout.groups.push({ id: 'display-second', tabOrder: [mixed.id], activeTabId: mixed.id, recentTabIds: [mixed.id] })
  foreignLayout.root = { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', groupId: 'display-first' }, second: { type: 'leaf', groupId: 'display-second' } }
  const reference = { displayWorkspaceId: otherWorkspace.id, groupId: 'display-second', tabId: mixed.id, regionId: pageB.regionId }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, otherWorkspace] },
    layouts: { [workspace.id]: source, [otherWorkspace.id]: foreignLayout }, surveyZoneSelection: { zoneId: originalZoneId(), selection: [reference], active: reference } })
  const launcher = vi.spyOn(useAppStore.getState(), 'openLauncher')
  await renderApp(); await enterSurvey(); await dom.click('.global-survey-surface [title="New tab"]')
  const current = useAppStore.getState(), created = current.surveyZoneSelection!.active!
  expect(launcher).toHaveBeenLastCalledWith({ workspaceId: workspace.id, displayWorkspaceId: workspace.id, tabGroupId: 'original-group', zoneId: originalZoneId(), reveal: false })
  expect(current.tabs[created.tabId]?.workspaceId).toBe(workspace.id)
  expect(current.layouts[workspace.id]!.groups[0]!.tabOrder).toEqual([mixed.id,created.tabId])
  expect(current.layouts[otherWorkspace.id]).toBe(foreignLayout)
  expect(current.activeWorkspaceId).toBe(workspace.id); expect(current.mainSurface).toBe('survey'); healthy()
})

it('keeps unknown member preferences while loading the original Zone and its known members', async () => {
  const valid = surveyInitialZoneSelection(catalog(), originalZoneId(), useAppStore.getState().layouts, useAppStore.getState().tabs, workspace.id).active!
  const unknown = { ...valid, tabId: 'retained-tab', regionId: 'retained-region' }
  const selected = { zoneId: originalZoneId(), selection: [unknown, valid], active: valid }
  useAppStore.setState({ surveyZoneSelection: selected })
  await renderApp(); await enterSurvey()
  expect(useAppStore.getState().surveyZoneSelection).toBe(selected)
  expect(dom.container.querySelector('.survey-panel-status')).toBeNull()
  expect(dom.container.querySelector('.global-survey-surface .retained-workbench-view')).not.toBeNull()
  expect(projectWorkbenchProjection(useAppStore.getState().layouts[workspace.id], useAppStore.getState().tabs, scope(selected)).layout?.groups[0]!.activeTabId).toBe(mixed.id)
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
  await renderApp(); await enterSurvey()
  const slots = [...dom.container.querySelectorAll<HTMLElement>('.global-survey-surface .workbench-tab-slot')]
  expect(slots).toHaveLength(2); expect(new Set(slots.map(slot => slot.id)).size).toBe(2)
  expect(dom.container.querySelector('.global-survey-surface')!.textContent).toContain('Simultaneous live display is not available')
  expect(dom.container.querySelector('.global-survey-surface .retained-workbench-view')).toBeNull()
  expect(dom.container.querySelectorAll('[data-terminal-probe]')).toHaveLength(1); healthy()
})

it('feeds visibility and memory owners only the selected original tree and hides it through Settings', async () => {
  const foreign = createWorkbenchTab('foreign', { ...pageA, workspaceId: otherWorkspace.id, regionId: 'foreign-page', browserId: 'foreign-browser' })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, otherWorkspace] }, tabs: { [mixed.id]: mixed, [foreign.id]: foreign },
    layouts: { ...useAppStore.getState().layouts, [otherWorkspace.id]: createWorkspaceLayout('foreign-group', [foreign.id]) } })
  await renderApp(); await enterSurvey(); await choose()
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
  useAppStore.setState({ loading: false }); await renderApp()
  expect(dom.container.querySelector('.workbench-zone-state')).not.toBeNull()
  expect(dom.container.querySelector('.survey-panel-status')).toBeNull()
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

it('keeps research capture cancellable when Topic discovery is unknown without changing original bindings', async () => {
  const call = vi.spyOn(api.topics, 'call').mockRejectedValue(new Error('Topic discovery failed'))
  const change = vi.spyOn(useAppStore.getState(), 'setZoneSpaceRelation')
  await renderApp(); await enterSurvey(); await choose()
  const owner = useAppStore.getState(), originalBindings = catalog().bindings
  await captureScope('research')
  expect(call).toHaveBeenCalledExactlyOnceWith('topic.ls', {})
  expect(captureDialog().textContent).toContain('Research: Agent')
  expect(captureDialog().textContent).toContain('Topic discovery failed')
  expect([...captureDialog().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Continue')!.disabled).toBe(true)
  expect(change).not.toHaveBeenCalled()
  await dialogButton(captureDialog(), 'Cancel')
  expect(captureDialog()).toBeNull()
  expect(useAppStore.getState().tabs).toBe(owner.tabs); expect(useAppStore.getState().layouts).toBe(owner.layouts)
  expect(useAppStore.getState().surveyZoneSelection).toBe(owner.surveyZoneSelection)
  expect(useAppStore.getState().spaceZoneBindings).toBe(owner.spaceZoneBindings); expect(catalog().bindings).toEqual(originalBindings)
  expect(useAppStore.getState().mainSurface).toBe('survey'); healthy()
})

it('keeps the live sidebar width and original work surface when its original save owner reports a host failure', async () => {
  const state = useAppStore.getState()
  useAppStore.setState({ restoredWorkbench: projectPersistedWorkbench(state) })
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig); vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.mocked(api.browser.create).mockImplementation(async id => id === browser.id ? browser : { ...browser, ...pageB, id })
  const dispose = await realInitialize()
  try {
    await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageB.regionId)
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
  await renderApp(); await enterSurvey()
  await dom.click('[aria-label="New webpage"]')
  const nativeId = vi.mocked(api.browser.create).mock.calls[0]![0]
  await choose(); const chosen = useAppStore.getState().surveyZoneSelection
  await act(async () => finish({ ...browser, id: nativeId, url: 'about:blank' }))
  expect(useAppStore.getState().surveyZoneSelection).toBe(chosen)
  expect(Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).filter(region => region.kind === 'browser').map(region => region.regionId)).toEqual([pageA.regionId, pageB.regionId, nativeId])
  expect(useAppStore.getState().mainSurface).toBe('survey'); healthy()
})

it.each(['close', 'promote'] as const)('follows the real Region %s result while retaining the original Zone and healthy siblings', async operation => {
  await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageB.regionId)
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
  const scratch = { ...workspace, id: SCRATCH_WORKSPACE_ID, name: 'Scratch', path: _hygiene_fixturePath("topics") }
  const existing = createWorkbenchTab('topic-tab', { kind: 'launcher', regionId: 'topic-launcher', workspaceId: scratch.id })
  existing.topicId = 'topic-a'
  const topic = { id: 'topic-a', title: 'Topic', summary: '', directoryPath: _hygiene_fixturePath("topics/topic--a"), topicPath: _hygiene_fixturePath("topics/topic--a/topic.md"), collaborators: [] }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace, scratch] }, activeWorkspaceId: scratch.id,
    tabs: { [mixed.id]: mixed, [existing.id]: existing }, layouts: { ...useAppStore.getState().layouts, [scratch.id]: createWorkspaceLayout('scratch-group', [existing.id]) },
    scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1, topics: [topic], error: null, reading: false } } })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic])
  await renderApp(); await enterSurvey(); await dom.click('[aria-label="New webpage"]')
  const selected = useAppStore.getState().surveyZoneSelection!, tab = useAppStore.getState().tabs[selected.active!.tabId]!
  expect(tab.workspaceId).toBe(scratch.id); expect(tab.topicId).toBeUndefined(); expect(tab.space?.zoneId).toBe(selected.zoneId)
  await dom.click('.global-survey-surface [title="New tab"]')
  const next = useAppStore.getState().tabs[useAppStore.getState().surveyZoneSelection!.active!.tabId]!
  expect(next.id).not.toBe(tab.id); expect(next.topicId).toBeUndefined(); expect(next.space?.zoneId).toBe(selected.zoneId)
  expect(useAppStore.getState().tabs[existing.id]).toBe(existing); healthy()
})

it('keeps ordinary manual browsers quiet and retains live Agent and unknown control details', async () => {
  const zoneId = 'regular-browser-zone', id = 'regular-browser-id'
  const manual = { ...browser, id, navigationId: 'regular-navigation', driving: false, activity: { control: 'human' as const, operation: null } }
  const regular = { ...createWorkbenchTab('regular-tab', { ...manual, kind: 'browser' as const, browserId: id, workspaceId: workspace.id, regionId: 'regular-region' }), space: { ...mixed.space!, zoneId } }
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [regular.id]: regular }, layouts: { ...state.layouts, [workspace.id]: createWorkspaceLayout('original-group', [mixed.id, regular.id]) } }))
  await renderApp(); await enterSurvey(); await choose(zoneId)
  const badge = () => dom.container.querySelector<HTMLElement>('[data-survey-zone-id="regular-browser-zone"] .survey-item-activity')!
  expect(badge()).not.toBeNull(); expect(badge().childElementCount).toBe(0)
  const before = useAppStore.getState(), page = slot().querySelector('[data-native-browser-stage]')
  expect(page).not.toBeNull()
  await openItemSubmenu('Item details'); expect(document.querySelector('.survey-item-details-content')!.textContent).toContain('Human control')
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  const operation = { id: 'regular-operation', browserId: id, operator: { id: session.id, name: 'Live operator' }, startedAt: 1, phase: 'running' as const, summary: 'Working', url: browser.url, steps: [] }
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...manual, driving: true, activity: { control: 'agent', operation } } }))
  expect(badge().querySelector('svg')).not.toBeNull(); expect(badge().firstElementChild!.getAttribute('aria-label')).toContain('Agent operating'); expect(badge().firstElementChild!.getAttribute('title')).toContain('Live operator')
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...manual, activity: { control: 'human', operation: { ...operation, phase: 'completed', finishedAt: 2 } } } }))
  expect(badge().childElementCount).toBe(0)
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'unavailable', id, error: 'Native owner unavailable' }))
  expect(badge().firstElementChild!.getAttribute('title')).toContain('Control unknown')
  expect(badge().firstElementChild!.getAttribute('title')).not.toContain('Live operator')
  expect(useAppStore.getState().surveyZoneSelection).toBe(before.surveyZoneSelection)
  expect(slot().querySelector('[data-native-browser-stage]')).toBe(page)
  healthy()
})

it('uses the shared avatar roster for actual operators, deduplicates Sessions and preserves overflow and unknown facts', async () => {
  const extra = Array.from({ length: 4 }, (_, index) => ({ ...session, id: `operator-${index}`, executorId: `executor-${index}`, label: `Operator ${index}` }))
  const actors = [session, ...extra]
  let tab = mixed
  for (let index = 0; index < 4; index += 1) {
    const id = `extra-browser-${index}`
    tab = addWorkbenchRegion(tab, pageA.regionId, 'right', { ...browser, id, browserId: id, navigationId: `navigation-${index}`, regionId: id, kind: 'browser', workspaceId: workspace.id })
  }
  useAppStore.setState(state => ({ sessions: actors, tabs: { ...state.tabs, [tab.id]: tab }, config: { ...state.config!, executors: {
    ...state.config!.executors, ...Object.fromEntries(extra.map(actor => [actor.executorId, { ...state.config!.executors[session.executorId]!, id: actor.executorId, avatar: { badge: 'bolt' } }]))
  } } }))
  await renderApp(); await enterSurvey(); await choose()
  const before = useAppStore.getState(), page = slot().querySelector('[data-native-browser-stage]')
  const ids = [browser.id, pageB.browserId, ...extra.map((_, index) => `extra-browser-${index}`)]
  const publish = async (id: string, actor: typeof session, live = true, operationBrowserId = id) => {
    const operation = { id: `operation-${id}`, browserId: operationBrowserId, operator: { id: actor.id, name: actor.label, providerId: actor.providerId }, startedAt: 1,
      phase: live ? 'running' as const : 'completed' as const, ...(live ? {} : { finishedAt: 2 }), summary: 'Research', url: browser.url, steps: [] }
    await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...browser, id, driving: live, activity: { control: live ? 'agent' : 'human', operation } } }))
  }
  await publish(ids[0]!, session); await publish(ids[1]!, session)
  for (let index = 0; index < extra.length; index += 1) await publish(ids[index + 2]!, extra[index]!)
  const badge = () => dom.container.querySelector<HTMLElement>('[data-survey-zone-id] .survey-item-activity')!
  const roster = () => badge().querySelector<HTMLElement>('.selector-presence')!
  expect(roster()).not.toBeNull(); expect(roster().querySelectorAll('.selector-presence__slot')).toHaveLength(4)
  expect(roster().querySelector('em')!.textContent).toBe('+1')
  expect(roster().getAttribute('aria-label')).toBe(`Agents: ${actors.map(actor => actor.label).join(', ')}`)
  const faces = [...roster().querySelectorAll<HTMLElement>('.agent-avatar')]
  expect(faces.map(face => face.dataset.executorId)).toEqual(actors.slice(0, 4).map(actor => actor.executorId))
  expect(faces[1]!.querySelector('[data-avatar-badge="bolt"]')).not.toBeNull()
  // A different Browser's operation does not establish this page's operator.
  await publish(ids[2]!, extra[0]!, true, 'foreign-browser')
  expect(roster().getAttribute('aria-label')).not.toContain(extra[0]!.label)
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'unavailable', id: ids[3]!, error: 'Unconfirmed owner' }))
  expect(roster().getAttribute('aria-label')).not.toContain(extra[1]!.label)
  expect(badge().firstElementChild!.getAttribute('title')).toContain('Control unknown')
  for (const id of ids) await publish(id, session, false)
  expect(badge().childElementCount).toBe(0)
  expect(useAppStore.getState().surveyZoneSelection).toBe(before.surveyZoneSelection)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(slot().querySelector('[data-native-browser-stage]')).toBe(page)
})

it('keeps Browser control unknown while its native owner is unavailable without retiring the Zone or reusing a completed operator', async () => {
  await renderApp(); await enterSurvey(); await choose()
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


it('uses the current exact Region slot without painting its parent Tab or sibling Regions and retains unconfirmed references', async () => {
  const before = useAppStore.getState(), reference = { displayWorkspaceId: workspace.id, groupId: 'original-group', tabId: mixed.id, regionId: pageB.regionId }
  const projection: WorkbenchProjection = { entity: { kind: 'region', regionId: pageB.regionId }, presentationId: 'region-surface', displayWorkspaceId: workspace.id, catalog: catalog(), selection: [reference], onSelect: vi.fn() }
  expect(projection.catalog.tabs.find(tab => tab.tabId === mixed.id)!.regionIds).toEqual(['agent-region', 'file-region', 'page-a', 'page-b'])
  await dom.render(<WorkspaceWorkbench workspaceId={workspace.id} viewOwnership="projection" projection={projection} />)
  const regionSlot = dom.container.querySelector<HTMLElement>('.workbench-region-slot')!
  expect(regionSlot).not.toBeNull()
  expect(regionSlot.id).toBe(workbenchRegionProjectionSlotId(`${projection.presentationId}-slot`, reference))
  expect(regionSlot.dataset.workbenchTabId).toBe(mixed.id)
  expect(regionSlot.dataset.workbenchGroupId).toBe('original-group')
  expect(dom.container.querySelector('.pane-group')).toBeNull()
  expect(dom.container.querySelector('[data-workbench-region-id]')).toBeNull()
  expect(projection.selection).toEqual([reference]); expect(projection.onSelect).not.toHaveBeenCalled()
  const held = { ...projection, selection: [{ ...reference, groupId: 'unconfirmed-group' }] }
  await dom.render(<WorkspaceWorkbench workspaceId={workspace.id} viewOwnership="projection" projection={held} />)
  expect(dom.container.querySelector('.workbench-region-slot')).toBeNull()
  expect(dom.container.querySelector('.workspace-workbench')!.textContent).toContain('The exact Region occurrence is not confirmed')
  expect(held.selection).toEqual([{ ...reference, groupId: 'unconfirmed-group' }]); expect(held.onSelect).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts); healthy()
})

it('retains explicitly saved research after the last Browser closes without discarding the selected mixed workface', async () => {
  await renderApp(); await enterSurvey(); await choose()
  const before = useAppStore.getState(), selected = before.surveyZoneSelection!, layout = before.layouts[workspace.id]
  expect(before.surveyCollectedZones).toEqual({ [selected.zoneId]: true })
  await act(async () => {
    await useAppStore.getState().closeRegion(workspace.id, mixed.id, pageB.regionId)
    await useAppStore.getState().closeRegion(workspace.id, mixed.id, pageA.regionId)
  })
  const current = useAppStore.getState()
  expect(current.surveyZoneSelection).toEqual(selected)
  expect(current.surveyCollectedZones).toEqual({ [selected.zoneId]: true })
  expect(dom.container.querySelectorAll('[data-survey-zone-id]')).toHaveLength(1)
  expect(dom.container.querySelector('.global-survey-surface')!.textContent).not.toContain('outside the Survey list')
  expect(current.layouts[workspace.id]).toBe(layout)
  expect(Object.keys(current.tabs[mixed.id]!.regions)).toEqual(['agent-region', 'file-region'])
  expect(dom.container.querySelector('.global-survey-surface [data-file-probe]')).not.toBeNull(); healthy()
  expect(useAppStore.getState().surveyCollectedZones).toEqual({ [selected.zoneId]: true })
  expect(dom.container.querySelectorAll('[data-survey-zone-id]')).toHaveLength(1)
})

it('keeps the held exact occurrence when the same retained Item is clicked while its catalog is unconfirmed', async () => {
  await renderApp(); await enterSurvey(); await choose(originalZoneId())
  await selectRegion(pageB.regionId)
  const before = useAppStore.getState(), held = before.surveyZoneSelection!
  expect(held.active).toEqual({ tabId: mixed.id, regionId: pageB.regionId })
  await act(async () => {
    before.setSurveyZoneCollected(held.zoneId, true)
    observation.catalogUnavailable = true
    useAppStore.setState({ config: { ...composerConfig } })
  })
  expect(dom.container.querySelector('[aria-label="Show retained survey item"]')).not.toBeNull()
  await dom.click('[aria-label="Show retained survey item"]')
  const current = useAppStore.getState()
  expect(current.surveyZoneSelection).toBe(held)
  expect(current.surveyZoneSelection?.active).toEqual(held.active)
  expect(current.layouts).toBe(before.layouts); expect(current.tabs).toBe(before.tabs)
  expect(current.surveyCollectedZones).toEqual({ [held.zoneId]: true }); healthy()
})

it('explicitly collapses and restores the sidebar without changing the original Item composition or selection', async () => {
  await renderApp(); await enterSurvey(); await choose()
  const before = useAppStore.getState(), original = slot().querySelector('.retained-workbench-view')!
  expect(before.surveySidebarCollapsed).toBe(false)
  await dom.click('[aria-label="Hide Survey items"]')
  const hidden = dom.container.querySelector<HTMLElement>('[aria-label="Survey items"]')!
  expect(hidden.hidden).toBe(true)
  expect(useAppStore.getState().surveySidebarCollapsed).toBe(true)
  expect(slot().querySelector('.retained-workbench-view')).toBe(original)
  expect(useAppStore.getState().layouts).toBe(before.layouts); expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().surveyZoneSelection).toBe(before.surveyZoneSelection)
  const saved = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
  expect(saved.surveySidebarCollapsed).toBe(true); expect(saved.surveySidebarWidth).toBe(before.surveySidebarWidth)
  await dom.click('[aria-label="Show Survey items"]')
  expect(hidden.hidden).toBe(false); expect(useAppStore.getState().surveySidebarCollapsed).toBe(false)
  expect(slot().querySelector('.retained-workbench-view')).toBe(original); healthy()
})













it('keeps a distinct unnamed exploration instead of concatenating its mixed Tab names', async () => {
  const named = { ...mixed, name: 'Reading notes' }, second = { ...createWorkbenchTab('second', pageC), name: 'Interface draft' }
  useAppStore.setState({ tabs: { [named.id]: named, [second.id]: second }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [named.id, second.id]) } })
  await renderApp(); await enterSurvey(); await choose()
  const before = useAppStore.getState(), row = dom.container.querySelector<HTMLElement>('.survey-item-row[data-selected="true"]')!
  expect(row.querySelector('strong')!.textContent).toBe('Untitled exploration')
  expect(row.querySelector('.survey-item')!.getAttribute('title')).toBe('Untitled exploration')
  expect(row.querySelector('.survey-item')!.getAttribute('aria-label')).toBe('Show survey item: Untitled exploration')
  expect(dom.container.querySelector('.survey-view-controls')).toBeNull()
  expect(row.textContent).not.toContain('2 tabs')
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts); healthy()
})

it.each([false, true])('flat list keeps a confirmed shared name and never borrows one Browser for distinct mixed Tabs (single: %s)', async single => {
  const tab = single ? createWorkbenchTab(mixed.id, pageA) : addWorkbenchRegion(createWorkbenchTab(mixed.id, agent), agent.regionId, 'right', pageA)
  const second = createWorkbenchTab('unnamed-file-tab', file)
  useAppStore.setState({ tabs: single ? { [tab.id]: tab } : { [tab.id]: tab, [second.id]: second },
    layouts: { [workspace.id]: createWorkspaceLayout('original-group', single ? [tab.id] : [tab.id, second.id]) } })
  const before = useAppStore.getState()
  await renderApp(); await enterSurvey(); await choose()
  const title = dom.container.querySelector('.survey-item-row[data-selected="true"] strong')!.textContent
  expect(title).toBe(single ? browser.title : 'Untitled exploration')
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().documents).toBe(before.documents)
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep my draft'); expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('flat list exposes one Item-options menu in either sidebar state and keeps the original workface and accurate callbacks', async () => {
  const collection = vi.spyOn(useAppStore.getState(), 'setSurveyZoneCollected')
  const relation = vi.spyOn(useAppStore.getState(), 'setZoneSpaceRelation')
  await renderApp(); await enterSurvey(); await choose()
  const before = useAppStore.getState(), original = slot().querySelector('.retained-workbench-view')!
  expect(original).not.toBeNull()
  expect(dom.container.querySelectorAll('[aria-label="Exploration options"]')).toHaveLength(1)
  const actions = dom.container.querySelector<HTMLElement>('[aria-label="Current exploration actions"]')!
  expect(actions).not.toBeNull()
  expect(actions.closest('[aria-label="Exploration navigation"]')).not.toBeNull()
  expect(actions.querySelector('[aria-label="Exploration options"]')).not.toBeNull()
  expect(actions.querySelector('[aria-label="Add note to this exploration"]')).not.toBeNull()
  expect(dom.container.querySelector('.survey-page-content [aria-label="Exploration options"]')).toBeNull()
  expect(dom.container.querySelector('.survey-page-content [aria-label="Add note to this exploration"]')).toBeNull()
  expect(dom.container.querySelector('.survey-item-details')).toBeNull()
  expect(dom.container.querySelector('.survey-view-controls')).toBeNull()
  collection.mockClear() // Fixture membership was explicitly saved before the menu action.
  const optionsTrigger = await openItemOptions()
  expect(document.querySelector('.survey-item-menu')!.textContent).toContain('Agent')
  await act(async () => document.querySelector('.survey-item-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await vi.waitFor(() => expect(document.activeElement).toBe(optionsTrigger))
  expect(collection).not.toHaveBeenCalled(); expect(relation).not.toHaveBeenCalled()
  await openItemOptions(); await dom.click('[aria-label="Hide Survey items"]')
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(dom.container.querySelectorAll('[aria-label="Exploration options"]')).toHaveLength(1)
  expect(actions.querySelector('[aria-label="Exploration options"]')).not.toBeNull()
  expect(actions.querySelector('[aria-label="Add note to this exploration"]')).not.toBeNull()
  expect(dom.container.querySelector('.survey-page-content [aria-label="Exploration options"]')).toBeNull()
  expect(dom.container.querySelector('.survey-view-controls')).toBeNull()
  await selectRegion(pageB.regionId)
  const exact = { tabId: mixed.id, regionId: pageB.regionId }
  expect(useAppStore.getState().surveyZoneSelection!.active).toEqual(exact)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(slot().querySelector('.retained-workbench-view')).toBe(original)
  expect(collection).not.toHaveBeenCalled(); expect(relation).not.toHaveBeenCalled()
  await openItemOptions(); await act(async () => useAppStore.setState({ mainSurface: 'workbench' }))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(useAppStore.getState().surveyZoneSelection!.active).toEqual(exact); healthy()
})






it('renames an exploration through its real menu without renaming or rebuilding any original Tab', async () => {
  await renderApp(); await enterSurvey(); await choose()
  const zoneId = originalZoneId(), before = useAppStore.getState()
  await openItemOptions()
  const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Rename exploration')!
  expect(rename).not.toBeNull(); await act(async () => rename.click())
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Exploration name"]')!
  await fill(input, 'Understanding the workflow'); await submit(input.closest('form')!)
  expect(useAppStore.getState().surveyExplorationNames).toEqual({ [zoneId]: 'Understanding the workflow' })
  expect(dom.container.querySelector('.survey-item-row[data-selected="true"] strong')!.textContent).toBe('Understanding the workflow')
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().surveyZoneSelection).toBe(before.surveyZoneSelection); healthy()
})

it('creates a Notebook first and adds its Note page in the original Zone without a Browser or spare preparation Tab', async () => {
  const writes = new Map<string, string>()
  vi.spyOn(api.files, 'write').mockImplementation(async (_workspace, input) => { writes.set(input.path, input.content); return { status: 'written', revision: 'note-created' } })
  vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, content: writes.get(path)!, revision: 'note-created' } }))
  await renderApp(); await enterSurvey()
  expect(dom.container.querySelector('.survey-start-heading h1')!.textContent).toBe('Survey')
  const before = useAppStore.getState()
  await startNotebookWithPage()
  await vi.waitFor(() => expect(useAppStore.getState().surveyZoneSelection?.active).not.toBeNull())
  const current = useAppStore.getState(), selected = current.surveyZoneSelection!, ref = selected.active!
  expect(selected.zoneId).not.toBe(originalZoneId())
  expect(current.tabs[ref.tabId]!.space?.zoneId).toBe(selected.zoneId)
  expect(current.tabs[ref.tabId]!.regions[ref.regionId]).toMatchObject({ kind: 'file' })
  expect(Object.values(current.tabs).filter(tab => tab.space?.zoneId === selected.zoneId)).toHaveLength(1)
  expect(api.browser.create).not.toHaveBeenCalled(); expect(api.files.write).toHaveBeenCalledTimes(1)
  expect(current.tabs[mixed.id]).toBe(before.tabs[mixed.id]); expect(current.layouts[workspace.id]!.activeGroupId).toBe(before.layouts[workspace.id]!.activeGroupId); healthy()
})

it('checks the same Note after an unknown write without issuing another create or write', async () => {
  let notePath = '', content = ''
  vi.spyOn(api.files, 'write').mockImplementation(async (_workspace, input) => { notePath = input.path; content = input.content; return { status: 'unknown', code: 'WRITE_ACK_UNKNOWN', message: 'Write acknowledgement unavailable' } })
  vi.spyOn(api.files, 'read').mockImplementation(async () => ({ status: 'read', document: { path: notePath, content, revision: 'confirmed' } }))
  await renderApp(); await enterSurvey(); await startNotebookWithPage()
  await vi.waitFor(() => expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('acknowledgement'))
  const prepared = useAppStore.getState(), zoneId = Object.keys(prepared.surveyCollectedZones)[0]!
  expect(zoneId).toBeDefined(); expect(api.files.write).toHaveBeenCalledTimes(1)
  const recover = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Recover same note')!
  expect(recover).not.toBeNull(); await act(async () => recover.click())
  await vi.waitFor(() => expect(useAppStore.getState().surveyZoneSelection?.zoneId).toBe(zoneId))
  expect(api.files.write).toHaveBeenCalledTimes(1); expect(api.browser.create).not.toHaveBeenCalled()
  expect(Object.values(useAppStore.getState().tabs).filter(tab => tab.space?.zoneId === zoneId)).toHaveLength(1); healthy()
})


it('restores the exact exploration name through the original UI owner without dropping unknown names', () => {
  const names = { [originalZoneId()]: 'Understanding a workflow', 'retained-unknown-zone': 'Unfinished research' }
  const restored = restorePersistedUiState(composerConfig, { workbenchSpaceSelection: null, surveyExplorationNames: names, surveyCollectedZones: { 'retained-unknown-zone': true } })
  expect(restored.surveyExplorationNames).toEqual(names)
  expect(restored.surveyCollectedZones).toEqual({ 'retained-unknown-zone': true })
})

it('opens the exploration name editor from the collapsed left Organize menu while preserving its original workface', async () => {
  await renderApp(); await enterSurvey(); await choose()
  const before = useAppStore.getState(), original = slot().querySelector('.retained-workbench-view')!
  expect(original).not.toBeNull()
  await dom.click('[aria-label="Hide Survey items"]')
  await openItemOptions()
  const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Rename exploration')!
  expect(rename).not.toBeNull()
  await act(async () => { rename.focus(); rename.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(useAppStore.getState().surveySidebarCollapsed).toBe(false)
  expect(dom.container.querySelector('[aria-label="Survey items"]')!.contains(dom.container.querySelector('[aria-label="Exploration name"]'))).toBe(true)
  expect(useAppStore.getState().surveyZoneSelection).toBe(before.surveyZoneSelection)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(slot().querySelector('.retained-workbench-view')).toBe(original); healthy()
})


it('recovers the original new exploration when Launcher preparation is unavailable', async () => {
  const create = vi.spyOn(useAppStore.getState(), 'createWorkbenchZone')
  const open = vi.spyOn(useAppStore.getState(), 'openLauncher').mockReturnValueOnce(undefined)
  const writes = new Map<string, string>()
  vi.spyOn(api.files, 'write').mockImplementation(async (_workspace, input) => { writes.set(input.path, input.content); return { status: 'written', revision: 'new' } })
  vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, content: writes.get(path)!, revision: 'new' } }))
  await renderApp(); await enterSurvey(); await startNotebookWithPage()
  await vi.waitFor(() => expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Group is still restoring'))
  const zoneIds = Object.keys(useAppStore.getState().surveyCollectedZones)
  expect(zoneIds).toHaveLength(1); expect(create).toHaveBeenCalledTimes(1); expect(api.files.write).not.toHaveBeenCalled()
  const recover = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Recover same note')!
  expect(recover).not.toBeNull(); await act(async () => recover.click())
  await vi.waitFor(() => expect(useAppStore.getState().surveyZoneSelection?.zoneId).toBe(zoneIds[0]))
  expect(create).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledTimes(2); expect(api.files.write).toHaveBeenCalledTimes(1); healthy()
})


it('opens the sole confirmed occurrence of a never-activated exploration without another panel choice', async () => {
  const original = createWorkbenchTab('original-browser', pageA), untouched = createWorkbenchTab('untouched-browser', pageC)
  const state = useAppStore.getState()
  const created = await state.createWorkbenchZone({ workspaceId: workspace.id, spaceIds: [] })
  untouched.space = { zoneId: created.zone.zoneId, spaceId: directoryIdentity(workspace.hostId, workspace.path) }
  useAppStore.setState({ tabs: { [original.id]: original, [untouched.id]: untouched }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [original.id, untouched.id]) } })
  const before = useAppStore.getState()
  await renderApp(); await enterSurvey(); await choose(created.zone.zoneId)
  expect(useAppStore.getState().surveyZoneSelection!.active).toEqual({ tabId: untouched.id, regionId: pageC.regionId })
  expect(dom.container.querySelector('.survey-panel-status')).toBeNull()
  expect(dom.container.querySelector('.global-survey-surface [data-workbench-region-id="page-c"]')).not.toBeNull()
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
})

it('uses the shared first-Pane window chrome without replacing the original content or reserving Mac controls on other platforms', async () => {
  const platform = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X)')
  await renderApp(); await enterSurvey(); await choose()
  const surface = dom.container.querySelector<HTMLElement>('.global-survey-surface')!
  expect(surface).not.toBeNull()
  expect(surface.dataset.nativeWindowControls).toBe('true')
  expect(dom.container.querySelector('.topbar')).toBeNull()
  const original = slot().querySelector('.retained-workbench-view')!
  expect(original).not.toBeNull()
  const state = useAppStore.getState(), selection = state.surveyZoneSelection
  const bar = surface.querySelector('.pane-tabbar')!
  expect(bar).not.toBeNull(); expect(bar.querySelectorAll('.survey-window-controls-inset')).toHaveLength(1)
  expect(surface.querySelector('[aria-label="Survey window controls"] [aria-label="Hide Survey items"]')).not.toBeNull()
  await dom.click('[aria-label="Hide Survey items"]')
  expect(surface.style.getPropertyValue('--survey-navigation-width')).toBe('40px')
  expect(bar.querySelectorAll('.survey-window-controls-inset')).toHaveLength(1)
  expect(slot().querySelector('.retained-workbench-view')).toBe(original)
  expect(useAppStore.getState().tabs).toBe(state.tabs); expect(useAppStore.getState().layouts).toBe(state.layouts)
  expect(useAppStore.getState().surveyZoneSelection).toBe(selection)
  platform.mockReturnValue('Mozilla/5.0 (Windows NT 10.0)')
  await dom.click('[aria-label="Show Survey items"]')
  expect(surface.dataset.nativeWindowControls).toBe('false')
  expect(surface.querySelector('.survey-window-controls-inset')).toBeNull()
  expect(slot().querySelector('.retained-workbench-view')).toBe(original); healthy()
})

async function browserMenuAction(label: string) {
  const region = dom.container.querySelector<HTMLElement>(`[data-workbench-region-id="${pageA.regionId}"]`)!
  expect(region).not.toBeNull()
  const more = region.querySelector<HTMLElement>('[aria-label="More browser tools"]')!
  expect(more).not.toBeNull()
  await act(async () => { more.focus(); more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  const action = document.querySelector<HTMLElement>(`.browser-menu [aria-label="${label}"]`)!
  expect(action).not.toBeNull()
  await act(async () => action.click())
}

it('never auto-collects a project Browser or Agent workface when Survey opens', async () => {
  await renderApp()
  const before = useAppStore.getState()
  await enterSurvey()
  expect(dom.container.querySelectorAll('[data-survey-zone-id]')).toHaveLength(0)
  expect(useAppStore.getState().surveyCollectedZones).toEqual({})
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(api.browser.create).not.toHaveBeenCalled(); healthy()
})

it('opens project Browser management locally without creating or collecting Survey content', async () => {
  await renderApp()
  const before = useAppStore.getState()
  await browserMenuAction('Browser tools')
  expect(dom.container.querySelector('[aria-label="Browser management controls"]')).not.toBeNull()
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(useAppStore.getState().surveyCollectedZones).toBe(before.surveyCollectedZones)
  expect(useAppStore.getState().surveyZoneSelection).toBe(before.surveyZoneSelection)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  await dom.click('[aria-label="Close browser tools"]')
  expect(dom.container.querySelector<HTMLElement>('[aria-label="Browser management controls"]')!.hidden).toBe(true)
  expect(api.browser.create).not.toHaveBeenCalled(); healthy()
})

it('creates independent research from the project page, keeping its original identity and layout selection', async () => {
  await renderApp()
  const before = useAppStore.getState(), source = dom.container.querySelector(`[data-native-browser-stage="${pageA.browserId}"]`)!
  expect(source).not.toBeNull()
  await browserMenuAction('Research in Survey')
  await vi.waitFor(() => expect(useAppStore.getState().mainSurface).toBe('survey'))
  const current = useAppStore.getState(), selected = current.surveyZoneSelection!, target = selected.active!
  expect(selected.zoneId).not.toBe(originalZoneId())
  expect(target.tabId).not.toBe(mixed.id); expect(target.regionId).not.toBe(pageA.regionId)
  expect(current.tabs[target.tabId]!.regions[target.regionId]).toMatchObject({ kind: 'browser', url: pageA.url, workspaceId: workspace.id, browserId: target.regionId })
  expect(api.browser.create).toHaveBeenCalledExactlyOnceWith(target.regionId, pageA.url, workspace.id)
  expect(current.tabs[mixed.id]).toBe(mixed)
  expect(current.layouts[workspace.id]!.groups[0]!.activeTabId).toBe(before.layouts[workspace.id]!.groups[0]!.activeTabId)
  expect(current.surveyCollectedZones).toEqual({ [selected.zoneId]: true })
  expect(dom.container.querySelector(`[data-native-browser-stage="${pageA.browserId}"]`)).toBe(source)
  healthy()
})

it('recovers a project research attachment without minting another research after a late receipt failure', async () => {
  const original = useAppStore.getState().createBrowser
  const create = vi.fn(async (...args: Parameters<typeof original>) => { await original(...args); throw new Error('Late research receipt failed') })
  useAppStore.setState({ createBrowser: create })
  const zone = vi.spyOn(useAppStore.getState(), 'createWorkbenchZone')
  await renderApp(); await browserMenuAction('Research in Survey')
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(dom.container.querySelector('.browser-address-error')?.textContent).toContain('Late research receipt failed')
  await dom.click('.browser-address-error button')
  expect(zone).toHaveBeenCalledTimes(1); expect(api.browser.create).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().mainSurface).toBe('survey')
  expect(useAppStore.getState().tabs[mixed.id]).toBe(mixed); healthy()
})

it('keeps later navigation when independent project research finishes late', async () => {
  let finish!: (snapshot: BrowserSnapshot) => void
  vi.mocked(api.browser.create).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await renderApp(); await browserMenuAction('Research in Survey')
  await act(async () => useAppStore.getState().setMainSurface('board'))
  const held = useAppStore.getState(), createdTab = Object.values(held.tabs).find(tab => tab.id !== mixed.id)!
  expect(createdTab).toBeDefined()
  await act(async () => finish({ ...browser, id: createdTab.layout.activeRegionId, url: pageA.url }))
  expect(useAppStore.getState().mainSurface).toBe('board')
  expect(useAppStore.getState().surveyZoneSelection).toBe(held.surveyZoneSelection)
  expect(useAppStore.getState().surveyCollectedZones).toEqual({ [createdTab.space!.zoneId]: true })
  healthy()
})

it('starts ordinary browsing with only Scratch and no selected project', async () => {
  useAppStore.setState({ config: { ...composerConfig, workspaces: [scratchWorkspace] }, activeWorkspaceId: null })
  await renderApp(); await enterSurvey()
  const field = dom.container.querySelector<HTMLInputElement>('.survey-start-input input')!
  expect(field.disabled).toBe(false)
  expect(dom.container.querySelector('.survey-start')!.textContent).not.toContain('Choose a resource workspace')
  await fill(field, 'https://example.test/daily'); await submit(field.form!)
  const state = useAppStore.getState(), reference = state.surveyZoneSelection!.active!
  expect(state.tabs[reference.tabId]!.workspaceId).toBe(SCRATCH_WORKSPACE_ID)
  expect(api.browser.create).toHaveBeenCalledExactlyOnceWith(reference.regionId, 'https://example.test/daily', SCRATCH_WORKSPACE_ID)
  expect(state.activeWorkspaceId).toBeNull(); expect(state.tabs[mixed.id]).toBe(mixed)
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('saves the whole research as a reference to the exact same-name Topic without moving entities or other bindings', async () => {
  const call = knowledgeTransport()
  await renderApp(); await enterSurvey(); await choose()
  const owner = useAppStore.getState(), change = vi.spyOn(owner, 'setZoneSpaceRelation'), zoneId = originalZoneId(), bindings = catalog().bindings
  await captureScope('research')
  expect(call).toHaveBeenCalledExactlyOnceWith('topic.ls', {})
  expect([...captureDialog().querySelectorAll('option')].map(option => option.value)).toEqual(['', '__new_topic__', 'view:a', 'view:b'])
  expect(call.mock.calls.some(([method]) => method === 'topic.knowledge.write')).toBe(false)
  await dialogButton(captureDialog(), 'Cancel')
  expect(change).not.toHaveBeenCalled()
  await captureScope('research'); await selectValue(captureDialog().querySelector('select')!, 'view:b')
  await dialogButton(captureDialog(), 'Continue')
  const editor = knowledgeDialog()
  expect(editor).not.toBeNull(); expect(editor.querySelector('select')!.value).toBe('reference')
  expect(editor.textContent).toContain('Original research')
  await dialogButton(editor, 'Save knowledge')
  expect(call).toHaveBeenLastCalledWith('topic.knowledge.write', expect.objectContaining({ topicId: 'view:b', title: 'Research: Agent',
    form: 'reference', content: '', certainty: 'proposal', expectedRevision: null, sources: [{ kind: 'survey', zoneId }] }))
  expect(knowledgeDialog()).toBeNull(); expect(captureDialog()).toBeNull(); expect(change).not.toHaveBeenCalled()
  const current = useAppStore.getState()
  expect(current.tabs).toBe(owner.tabs); expect(current.layouts).toBe(owner.layouts)
  expect(current.surveyZoneSelection).toBe(owner.surveyZoneSelection); expect(current.surveyCollectedZones).toBe(owner.surveyCollectedZones)
  expect(current.spaceZoneBindings).toBe(owner.spaceZoneBindings); expect(catalog().bindings).toEqual(bindings)
  expect(current.mainSurface).toBe('survey'); healthy()
})

it('captures the exact selected panel as written knowledge and retains its original source through later selection changes', async () => {
  const call = knowledgeTransport()
  await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageB.regionId)
  const owner = useAppStore.getState(), zoneId = originalZoneId(), selected = owner.surveyZoneSelection!.active!
  const change = vi.spyOn(owner, 'setZoneSpaceRelation')
  await captureScope('panel'); expect(captureDialog().textContent).toContain('Current panel: Agent')
  await selectValue(captureDialog().querySelector('select')!, 'view:a'); await dialogButton(captureDialog(), 'Continue')
  const editor = knowledgeDialog()
  await selectValue(editor.querySelector('select')!, 'derived')
  const content = editor.querySelector('textarea')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(content, 'A conclusion from this panel'); content.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => owner.setSurveyZoneSelection({ ...owner.surveyZoneSelection!, active: { ...selected, regionId: pageA.regionId }, selection: [{ ...selected, regionId: pageA.regionId }] }))
  await dialogButton(editor, 'Save knowledge')
  expect(call).toHaveBeenLastCalledWith('topic.knowledge.write', expect.objectContaining({ topicId: 'view:a', form: 'derived', content: 'A conclusion from this panel',
    sources: [{ kind: 'survey', zoneId, tabId: selected.tabId, regionId: selected.regionId }] }))
  expect(change).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs).toBe(owner.tabs)
  expect(useAppStore.getState().layouts).toBe(owner.layouts); expect(useAppStore.getState().spaceZoneBindings).toBe(owner.spaceZoneBindings)
  expect(useAppStore.getState().surveyCollectedZones).toBe(owner.surveyCollectedZones); healthy()
})

it('retains a failed knowledge-save draft and the original research while the content owner is unavailable', async () => {
  const call = knowledgeTransport()
  await renderApp(); await enterSurvey(); await choose()
  const owner = useAppStore.getState(), change = vi.spyOn(owner, 'setZoneSpaceRelation')
  await captureScope('research'); await selectValue(captureDialog().querySelector('select')!, 'view:b'); await dialogButton(captureDialog(), 'Continue')
  const editor = knowledgeDialog(), title = editor.querySelector('input')!
  await fill(title, 'Keep this knowledge draft')
  call.mockRejectedValueOnce(new Error('Save acknowledgement is unavailable'))
  await dialogButton(editor, 'Save knowledge')
  expect(editor.querySelector('input')!.value).toBe('Keep this knowledge draft')
  expect(editor.querySelector('[role="alert"]')!.textContent).toContain('Your draft is kept here.')
  expect(call).toHaveBeenLastCalledWith('topic.knowledge.write', expect.objectContaining({ topicId: 'view:b', title: 'Keep this knowledge draft', sources: [{ kind: 'survey', zoneId: originalZoneId() }] }))
  expect(change).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs).toBe(owner.tabs); expect(useAppStore.getState().layouts).toBe(owner.layouts)
  expect(useAppStore.getState().surveyZoneSelection).toBe(owner.surveyZoneSelection); healthy()
})

it.runIf(process.env.SURVEY_RESTART_PHASE === 'write')('writes new Survey browser identities and Topic bindings for a separate restart process', async () => {
  await renderApp(); await enterSurvey()
  const input = dom.container.querySelector<HTMLInputElement>('.survey-start-input input')!
  await fill(input, 'https://example.test/restart'); await submit(input.form!)
  await dom.click('.global-survey-surface [title="New tab"]')
  const state = useAppStore.getState(), selected = state.surveyZoneSelection!, target = selected.active!
  expect(state.tabs[target.tabId]!.regions[target.regionId]?.kind).toBe('browser')
  await act(async () => state.splitRegion(SCRATCH_WORKSPACE_ID, target.tabId, target.regionId, 'right'))
  await selectRegion(target.regionId)
  const topics = [{ id: 'restart-topic', title: 'Saved research', summary: '', directoryPath: _hygiene_fixturePath("scratch/topic-restart"), topicPath: _hygiene_fixturePath("scratch/topic-restart/topic.md"), collaborators: [] }]
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  const spaceId = directoryIdentity(scratchWorkspace.hostId, topics[0]!.directoryPath)
  const report = await useAppStore.getState().setZoneSpaceRelation(selected.zoneId, spaceId, true)
  expect(report.outcome).toBe('linked')
  const saved = useAppStore.getState(), workbench = projectPersistedWorkbench(saved)
  expect(Object.values(workbench.tabs).filter(tab => tab.space?.zoneId === selected.zoneId)).toHaveLength(2)
  expect(workbench.tabs[target.tabId]!.layout.root.type).toBe('split')
  const ui = { ...useAppStore.persist.getOptions().partialize!(saved), restoredWorkbench: workbench }
  writeFileSync(process.env.SURVEY_RESTART_FILE!, JSON.stringify({ config: saved.config, ui, selected: saved.surveyZoneSelection, layouts: saved.layouts, zoneId: selected.zoneId, spaceId, bindings: saved.spaceZoneBindings, topics }))
  healthy()
})

it.runIf(process.env.SURVEY_RESTART_PHASE === 'read')('restores new Survey browser identities, split layout and Topic binding in a fresh process', async () => {
  const fixture = JSON.parse(readFileSync(process.env.SURVEY_RESTART_FILE!, 'utf8'))
  useAppStore.setState({ loading: true, mainSurface: 'workbench', surveyZoneSelection: null, tabs: {}, layouts: {}, restoredWorkbench: null, sessions: [] })
  localStorage.setItem('agentmux-workbench-v1', JSON.stringify({ version: 1, state: fixture.ui }))
  await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().surveyZoneSelection).toEqual(fixture.selected)
  vi.spyOn(api.config, 'get').mockResolvedValue(fixture.config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(fixture.topics)
  let dispose!: () => void
  await act(async () => { dispose = await realInitialize() })
  try {
    await renderApp()
    const current = useAppStore.getState(), selected = current.surveyZoneSelection!, reference = selected.active!
    expect(selected).toEqual(fixture.selected)
    expect(current.layouts).toEqual(fixture.layouts)
    expect(current.spaceZoneBindings).toEqual(fixture.bindings)
    expect(current.surveyCollectedZones).toEqual({ [fixture.zoneId]: true })
    expect(current.tabs[reference.tabId]!.layout.root.type).toBe('split')
    expect(current.tabs[reference.tabId]!.regions[reference.regionId]?.kind).toBe('browser')
    expect(api.browser.create).toHaveBeenCalledWith(reference.regionId, 'about:blank', SCRATCH_WORKSPACE_ID)
    expect(catalog().bindings.some(binding => binding.zoneId === fixture.zoneId && binding.spaceId === fixture.spaceId)).toBe(true)
    expect(dom.container.querySelector('.global-survey-surface [data-native-browser-stage]')).not.toBeNull()
    healthy()
  } finally { dispose() }
})

it('keeps an old unsaved projection usable without offering to adopt its project Zone or add notes into it', async () => {
  useAppStore.setState({ surveyZoneSelection: surveyInitialZoneSelection(catalog(), originalZoneId(), useAppStore.getState().layouts, useAppStore.getState().tabs, workspace.id) })
  await renderApp(); await enterSurvey()
  expect(dom.container.querySelectorAll('[data-survey-zone-id]')).toHaveLength(0)
  expect(dom.container.querySelector('.survey-page-content')!.textContent).toContain('outside the Survey list')
  expect(dom.container.querySelector('.survey-page-content .survey-relation-notice button')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Add note to this exploration"]')).toBeNull()
  await openItemOptions()
  expect(document.querySelector('.survey-item-menu')!.textContent).not.toContain('Keep in Survey')
  expect(document.querySelector('.survey-item-menu')!.textContent).not.toContain('Save research to Topic')
  expect(document.querySelector('.survey-item-menu')!.textContent).not.toContain('Save current panel to Topic')
  expect(useAppStore.getState().surveyCollectedZones).toEqual({}); healthy()
})


it('loads the complete original Zone after obsolete display coordinates expire, without requiring a location picker', async () => {
  await renderApp()
  const terminal = dom.container.querySelector('[data-terminal-probe]')!
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('[data-file-probe]')).not.toBeNull() })
  const originalFile = dom.container.querySelector('[data-file-probe]')!
  const before = useAppStore.getState()
  const stale = { displayWorkspaceId: 'removed-display', groupId: 'removed-group', tabId: mixed.id, regionId: 'removed-region' }
  await act(async () => { before.setSurveyZoneSelection({ zoneId: originalZoneId(), selection: [stale], active: stale }); before.setMainSurface('survey') })
  await vi.waitFor(() => expect(dom.container.querySelector('.global-survey-surface [data-native-browser-stage]')).not.toBeNull())
  const current = useAppStore.getState()
  expect(current.tabs).toBe(before.tabs); expect(current.layouts).toBe(before.layouts)
  expect(dom.container.querySelector('.global-survey-surface [data-terminal-probe]')).toBe(terminal)
  expect(dom.container.querySelector('.global-survey-surface [data-file-probe]')).toBe(originalFile)
  expect(dom.container.querySelector('.global-survey-surface')!.textContent).not.toContain('Original work surface retained')
  expect(dom.container.querySelector('.survey-panel-status')).toBeNull()
  expect(dom.container.querySelector('.global-survey-surface [data-workbench-zone-id]')?.getAttribute('data-workbench-zone-id')).toBe(originalZoneId())
  healthy()
})

it('uses one whole-Zone unavailable state while preserving its saved reference and other live work', async () => {
  await renderApp()
  const before = useAppStore.getState()
  await act(async () => { before.setSurveyZoneSelection({ zoneId: 'not-available-yet', selection: [], active: null }); before.setMainSurface('survey') })
  expect(dom.container.querySelector('[aria-label="Research unavailable"]')).not.toBeNull()
  expect(dom.container.querySelector('.survey-panel-status')).toBeNull()
  expect(useAppStore.getState().surveyZoneSelection?.zoneId).toBe('not-available-yet')
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  healthy()
})

it('offers the original Zone controls without an address picker or a Tab-only mode', async () => {
  await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageB.regionId)
  const original=slot().querySelector('.retained-workbench-view'),before=useAppStore.getState()
  expect(original).not.toBeNull(); await openItemOptions()
  expect(document.querySelector('[aria-label="Choose original work surface"]')).toBeNull()
  expect(document.querySelector('[aria-label="View current Survey Tab"]')).toBeNull()
  await act(async()=>document.querySelector('.survey-item-menu')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  expect(slot().querySelector('.retained-workbench-view')).toBe(original)
  expect(useAppStore.getState().tabs).toBe(before.tabs);expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().surveyZoneSelection).toBe(before.surveyZoneSelection);healthy()
})

it('ignores stale foreign coordinates while retaining the original page input and every foreign binding', async () => {
  const foreign=createWorkspaceLayout('foreign',[mixed.id])
  useAppStore.setState({config:{...composerConfig,workspaces:[workspace,otherWorkspace]},layouts:{...useAppStore.getState().layouts,[otherWorkspace.id]:foreign}})
  await renderApp();await enterSurvey();await choose();await selectRegion(pageB.regionId)
  const field=address(),original=slot().querySelector('.retained-workbench-view'),before=useAppStore.getState()
  await fill(field,'Keep this address');field.setSelectionRange(1,6)
  await act(async()=>before.setSurveyZoneSelection({zoneId:originalZoneId(),selection:[{displayWorkspaceId:'gone',groupId:'gone',tabId:mixed.id,regionId:pageB.regionId} as never],active:{tabId:mixed.id,regionId:pageB.regionId}}))
  expect(address()).toBe(field);expect(field.value).toBe('Keep this address');expect([field.selectionStart,field.selectionEnd]).toEqual([1,6])
  expect(slot().querySelector('.retained-workbench-view')).toBe(original)
  expect(observation.survey.at(-1)!.projection!.displayWorkspaceId).toBe(workspace.id)
  expect(useAppStore.getState().layouts).toBe(before.layouts);expect(useAppStore.getState().layouts[otherWorkspace.id]).toBe(foreign)
  expect(useAppStore.getState().tabs).toBe(before.tabs);healthy()
})



it('creates a real Note Region beside the Browser with no sidebar form or extra Tab', async () => {
  noteTransport(); await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  const before = useAppStore.getState(), page = dom.container.querySelector(`[data-native-browser-stage="${pageA.browserId}"]`)!
  expect(page).not.toBeNull(); await dom.click('[aria-label="Add note to this exploration"]'); const ref = await readyNoteRegion()
  const current = useAppStore.getState(), tab = current.tabs[mixed.id]!
  expect(ref.tabId).toBe(mixed.id); expect(Object.keys(current.tabs)).toEqual(Object.keys(before.tabs))
  expect(Object.keys(tab.regions)).toHaveLength(Object.keys(mixed.regions).length + 1)
  expect(tab.regions[pageA.regionId]).toBe(before.tabs[mixed.id]!.regions[pageA.regionId])
  expect(tab.regions[ref.regionId]).toMatchObject({ kind: 'file', path: savedNotes().at(-1)!.path })
  expect(current.surveyZoneSelection?.active).toMatchObject(ref)
  expect(dom.container.querySelector(`[data-native-browser-stage="${pageA.browserId}"]`)).not.toBeNull(); expect(api.browser.close).not.toHaveBeenCalled()
  expect(dom.container.querySelector('.survey-note-capture')).toBeNull()
  expect(api.files.write).toHaveBeenCalledTimes(1); expect(api.browser.create).not.toHaveBeenCalled(); healthy()
})

it('carries the old sidebar draft into the same Note and only clears the confirmed original text', async () => {
  const writes = noteTransport(); await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  useLauncherState.getState().setDraft(`region:${pageA.regionId}`, 'note', 'An earlier reading thought')
  await dom.click('[aria-label="Add note to this exploration"]'); await readyNoteRegion()
  const receipt = savedNotes().at(-1)!
  expect(receipt.draft).toBe('An earlier reading thought'); expect(writes.get(receipt.path)).toContain('An earlier reading thought')
  expect(useLauncherState.getState().drafts[`region:${pageA.regionId}`]?.note).toBe('')
  expect(dom.container.querySelector('.global-survey-surface .note-editor')!.textContent).toContain('An earlier reading thought'); healthy()
})

it('keeps a later draft while the original Note Region write completes', async () => {
  let release!: () => void; const waiting = new Promise<void>(yes => { release = yes }); noteTransport('written', waiting)
  await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  useLauncherState.getState().setDraft(`region:${pageA.regionId}`, 'note', 'First thought')
  await dom.click('[aria-label="Add note to this exploration"]'); expect(savedNotes().at(-1)?.status).toBe('pending')
  useLauncherState.getState().setDraft(`region:${pageA.regionId}`, 'note', 'A later thought')
  await act(async () => { release(); await waiting }); await readyNoteRegion()
  expect(useLauncherState.getState().drafts[`region:${pageA.regionId}`]?.note).toBe('A later thought'); healthy()
})

it('recovers an unknown Note write into its original Region without another write or split', async () => {
  noteTransport('unknown'); await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  await dom.click('[aria-label="Add note to this exploration"]')
  const receipt = savedNotes().at(-1)!, prepared = useAppStore.getState().tabs[mixed.id]!, ref = receipt.launcher!
  expect(receipt.status).toBe('unknown'); expect(prepared.regions[ref.regionId]?.kind).toBe('launcher')
  await recoverSameNote(); await readyNoteRegion()
  expect(savedNotes().at(-1)).toMatchObject({ noteId: receipt.noteId, path: receipt.path, revealed: true })
  expect(useAppStore.getState().tabs[mixed.id]!.layout.root).toEqual(prepared.layout.root)
  expect(api.files.write).toHaveBeenCalledTimes(1); expect(useAppStore.getState().tabs[mixed.id]!.regions[pageA.regionId]).toBe(pageA); healthy()
})

it('retries a failed Note write using the same file intent and prepared Region', async () => {
  noteTransport('error'); await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  await dom.click('[aria-label="Add note to this exploration"]'); const receipt = savedNotes().at(-1)!, ref = receipt.launcher!
  expect(receipt.status).toBe('error'); vi.mocked(api.files.write).mockResolvedValue({status:'written',revision:'retry'})
  await recoverSameNote(); await readyNoteRegion()
  expect(savedNotes().at(-1)).toMatchObject({ intentId: receipt.intentId, noteId: receipt.noteId, launcher: ref })
  expect(Object.keys(useAppStore.getState().tabs[mixed.id]!.regions)).toHaveLength(5); healthy()
})

it('keeps real later Survey navigation and reveals the same Note Region only on recovery', async () => {
  let release!: () => void; const waiting = new Promise<void>(yes => { release = yes }); noteTransport('written', waiting)
  await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  await dom.click('[aria-label="Add note to this exploration"]'); const ref = pendingNoteReference()
  await selectRegion(pageB.regionId); await selectRegion(pageA.regionId)
  await act(async () => { release(); await waiting })
  await vi.waitFor(() => expect(savedNotes().at(-1), JSON.stringify(savedNotes().at(-1))).toMatchObject({ status:'written', revealed:false })); expect(useAppStore.getState().surveyZoneSelection?.active?.regionId).toBe(pageA.regionId)
  expect(api.files.read).not.toHaveBeenCalled(); await recoverSameNote(); await readyNoteRegion()
  expect(pendingNoteReference()).toEqual(ref); expect(api.files.write).toHaveBeenCalledTimes(1); healthy()
})

it('opens the same Note Region after an equivalent selection refresh during its write', async () => {
  let release!: () => void; const waiting = new Promise<void>(yes => { release = yes }); noteTransport('written', waiting)
  await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  await dom.click('[aria-label="Add note to this exploration"]'); const held = useAppStore.getState().surveyZoneSelection!
  await act(async () => useAppStore.getState().setSurveyZoneSelection({ ...held, selection: held.selection.map(ref => ({ ...ref })), active: held.active ? { ...held.active } : null }))
  await act(async () => { release(); await waiting }); await readyNoteRegion()
  expect(dom.container.textContent).not.toContain('Note could not open'); expect(api.files.write).toHaveBeenCalledTimes(1); healthy()
})

it('opens a Note Region from collapsed navigation without changing foreign display selections', async () => {
  noteTransport(); const foreign = createWorkspaceLayout('foreign-group', [mixed.id])
  useAppStore.setState({ config:{...composerConfig,workspaces:[workspace,otherWorkspace]}, layouts:{...useAppStore.getState().layouts,[otherWorkspace.id]:foreign}, surveySidebarCollapsed:true })
  await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  await dom.click('[aria-label="Add note to this exploration"]'); await readyNoteRegion()
  expect(useAppStore.getState().surveySidebarCollapsed).toBe(true); expect(useAppStore.getState().layouts[otherWorkspace.id]).toBe(foreign); healthy()
})

it('uses the existing Region menu to show the same Note alone and reopens its canonical file without copying blocks', async () => {
  noteTransport(); await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  const originalTitle = dom.container.querySelector('.survey-item-row[data-selected="true"] strong')!.textContent
  await dom.click('[aria-label="Add note to this exploration"]'); const ref = await readyNoteRegion(), receipt = savedNotes().at(-1)!
  const region = [...dom.container.querySelectorAll<HTMLElement>('.global-survey-surface [data-workbench-region-id]')].find(node => node.dataset.workbenchRegionId === ref.regionId)!
  await act(async () => region.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,clientX:10,clientY:10})))
  const promote = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.includes('Move to New Tab'))!
  expect(promote).toBeDefined(); await act(async () => { promote.focus(); promote.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})) })
  const current = useAppStore.getState(), shown = current.surveyZoneSelection!.active!, note = current.tabs[shown.tabId]!.regions[shown.regionId]!
  expect(dom.container.querySelector('.survey-item-row[data-selected="true"] strong')!.textContent).toBe(originalTitle)
  expect(shown.regionId).toBe(ref.regionId); expect(shown.tabId).not.toBe(mixed.id); expect(note).toMatchObject({kind:'file',path:receipt.path})
  expect(Object.keys(current.tabs[shown.tabId]!.regions)).toHaveLength(1); expect(current.tabs[mixed.id]!.regions[pageA.regionId]).toBe(pageA)
  const originalDocument = current.documents[documentKey(workspace.id, receipt.path)]!, parsed = JSON.parse(originalDocument.content)
  expect(parsed.noteId).toBe(receipt.noteId)
  await act(async () => { await current.openFile(receipt.path, shown.groupId, undefined, workspace.id) })
  expect(useAppStore.getState().documents[documentKey(workspace.id,receipt.path)]).toBe(originalDocument)
  expect(api.files.write).toHaveBeenCalledTimes(1); healthy()
})


it('retains a restored Note Region and publishes its real file read failure without a canonical Tab', async () => {
  noteTransport(); await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  await dom.click('[aria-label="Add note to this exploration"]'); const ref = await readyNoteRegion(), receipt = savedNotes().at(-1)!
  const state = useAppStore.getState(), noteKey = documentKey(workspace.id,receipt.path), documents = {...state.documents}; delete documents[noteKey]
  useAppStore.setState({documents}); vi.mocked(api.files.read).mockResolvedValue({status:'error',code:'UNAVAILABLE',message:'Original Note host is unavailable'})
  await act(async () => { await useAppStore.getState().attachPersistedFileDocument(workspace.id,receipt.path) })
  expect(useAppStore.getState().documentIssues[noteKey]).toMatchObject({kind:'read-error',code:'UNAVAILABLE'})
  expect(useAppStore.getState().tabs[mixed.id]!.regions[ref.regionId]).toMatchObject({kind:'file',path:receipt.path}); healthy()
})

it('refuses to replace a different live Region with a saved Note and keeps its file and page', async () => {
  const writes = noteTransport(); await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  await dom.click('[aria-label="Add note to this exploration"]'); await readyNoteRegion(); const receipt = savedNotes().at(-1)!, before = useAppStore.getState()
  let opened = true
  await act(async () => { opened = await before.openFile(receipt.path,'original-group',undefined,workspace.id,undefined,{displayWorkspaceId:workspace.id,space:{spaceId:receipt.target.sourceSpaceId!,zoneId:receipt.target.zoneId!},resource:{hostId:'local',path:workspace.path},launcher:{tabId:mixed.id,regionId:pageA.regionId}}) })
  expect(opened).toBe(false); expect(useAppStore.getState().tabs[mixed.id]!.regions[pageA.regionId]).toBe(pageA)
  expect(writes.get(receipt.path)).toContain(receipt.noteId); expect(api.files.write).toHaveBeenCalledTimes(1); healthy()
})

async function createNotebook(name = 'Research notebook') {
  await dom.click('[aria-label="New notebook"]')
  const input = document.querySelector<HTMLInputElement>('[aria-label="New notebook name"]')!
  expect(input).not.toBeNull()
  await fill(input, name)
  await submit(document.querySelector<HTMLFormElement>('[aria-label="Create notebook"]')!)
  await vi.waitFor(() => expect(useNotebookLibrary.getState().state?.notebooks[useAppStore.getState().surveyNotebookId!]?.name).toBe(name))
}

async function startNotebookWithPage() {
  await createNotebook()
  await vi.waitFor(() => expect(useAppStore.getState().surveyNotebookId).not.toBeNull())
  await dom.click('.notebook-create-page')
}

it('inherits the selected Notebook through the real generic Launcher Note action', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  const state = useAppStore.getState(), bookId = state.surveyNotebookId!, page = Object.values((await api.notebooks.read()).pages)[0]!
  const workspaceId = page.resource.workspaceId, groupId = state.layouts[workspaceId]!.activeGroupId
  const tabId = state.openLauncher({ workspaceId, displayWorkspaceId: workspaceId, tabGroupId: groupId, zoneId: page.workface!.zoneId, reveal: false })!
  const tab = useAppStore.getState().tabs[tabId]!, reference = { tabId, regionId: tab.layout.activeRegionId }
  await act(async () => { state.setSurveyNotebook(bookId); state.setSurveyZoneSelection({ zoneId: page.workface!.zoneId, selection: [reference], active: reference }) })
  await vi.waitFor(() => expect(dom.container.querySelector('.global-survey-surface [aria-label="Create blank note"]')).not.toBeNull())
  await dom.click('.global-survey-surface [aria-label="Create blank note"]')
  await vi.waitFor(async () => expect(Object.values((await api.notebooks.read()).pages)).toHaveLength(2))
  const saved = Object.values((await api.notebooks.read()).pages)
  expect(saved.every(member => member.notebookId === bookId)).toBe(true)
  expect(savedNotes().at(-1)?.notebook).toEqual({ notebookId: bookId })
  expect(files.size).toBe(2)
  // Same-day names use the original file owner's one conflict followed by its next available name.
  expect(api.files.write).toHaveBeenCalledTimes(3)
  expect(dom.container.querySelectorAll('.survey-notebook-page')).toHaveLength(2)
  expect(dom.container.querySelector('.survey-navigation [data-survey-zone-id]')).toBeNull(); healthy()
})

it('keeps Notebook navigation scoped to its directory and returns to the original Survey overview without changing content', async () => {
  const files = new Map<string, string>()
  vi.spyOn(api.files, 'write').mockImplementation(async (_id, input) => { files.set(input.path, input.content); return { status: 'written', revision: 'same-note' } })
  vi.spyOn(api.files, 'read').mockImplementation(async (_id, path) => ({ status: 'read', document: { path, content: files.get(path)!, revision: 'same-note' } }))
  await renderApp(); await enterSurvey(); await choose()
  const browsers = Object.values(useAppStore.getState().tabs).flatMap(workbenchSurfaces).filter(surface => surface.kind === 'browser')
  await createNotebook()
  await vi.waitFor(() => expect(dom.container.querySelector('.survey-notebook-navigation')).not.toBeNull())
  const bookId = useAppStore.getState().surveyNotebookId!, navigation = dom.container.querySelector('.survey-navigation')!
  expect(navigation.querySelectorAll('[data-survey-zone-id]')).toHaveLength(0)
  expect(navigation.querySelector('[aria-label="New webpage"]')).toBeNull()
  expect(navigation.querySelector('[aria-label="Current exploration actions"]')).toBeNull()
  expect(navigation.textContent).toContain('No pages yet')
  await dom.click('[aria-label="New page in Research notebook"]'); await readyNoteRegion()
  await renameNotebookField('Page title', 'A clear notebook page')
  await vi.waitFor(() => expect(navigation.querySelector('.survey-notebook-page')?.textContent).toBe('A clear notebook page'))
  const saved = structuredClone(await api.notebooks.read()), originalRegion = useAppStore.getState().surveyZoneSelection!.active!, noteBody = [...files.values()][0]!
  const writeCount = vi.mocked(api.files.write).mock.calls.length
  expect(navigation.querySelector('.survey-notebook-page')?.getAttribute('aria-current')).toBe('page')
  await dom.click('[aria-label="Back to Survey"]')
  expect(useAppStore.getState().surveyNotebookId).toBeNull()
  expect(navigation.querySelectorAll('[data-survey-zone-id]').length).toBeGreaterThan(0)
  expect(navigation.querySelector('[aria-label="New webpage"]')).not.toBeNull()
  expect(navigation.querySelector('.survey-notebook-page')).toBeNull()
  const book = navigation.querySelector<HTMLButtonElement>(`[data-notebook-id="${bookId}"]>.survey-notebook-item`)!
  await act(async () => book.click())
  expect(navigation.querySelectorAll('[data-survey-zone-id]')).toHaveLength(0)
  expect(navigation.querySelector('.survey-notebook-page')?.textContent).toBe('A clear notebook page')
  await dom.click('.survey-notebook-page')
  await vi.waitFor(() => expect(useAppStore.getState().surveyNoteId).toBe(Object.keys(saved.pages)[0]))
  expect(useAppStore.getState().surveyZoneSelection!.active).toEqual(originalRegion)
  expect(await api.notebooks.read()).toEqual(saved)
  expect(vi.mocked(api.files.write).mock.calls).toHaveLength(writeCount)
  expect([...files.values()][0]).toBe(noteBody)
  expect(Object.values(useAppStore.getState().tabs).flatMap(workbenchSurfaces).filter(surface => surface.kind === 'browser')).toEqual(browsers)
  expect(api.browser.close).not.toHaveBeenCalled(); healthy()
})

it('keeps an unregistered Note workface reachable without claiming it belongs to 随手记 and avoids duplicating confirmed pages', async () => {
  await renderApp(); await enterSurvey()
  const state = useAppStore.getState(), created = await state.createWorkbenchZone({ workspaceId: workspace.id, spaceIds: [] })
  const note = { kind: 'file' as const, regionId: 'unregistered-note-region', workspaceId: workspace.id, path: 'Unfiled.note.json' }
  const original = createWorkbenchTab('unregistered-note-tab', note, 'An existing note')
  original.space = { zoneId: created.zone.zoneId, spaceId: directoryIdentity(workspace.hostId, workspace.path) }
  await act(async () => { useAppStore.setState({ tabs: { ...state.tabs, [original.id]: original } }); useAppStore.getState().setSurveyZoneCollected(created.zone.zoneId, true) })
  const selectBook = dom.container.querySelector<HTMLButtonElement>('[data-notebook-id="quick-notes"]>.survey-notebook-item')!
  expect(dom.container.querySelector(`[data-survey-zone-id="${created.zone.zoneId}"]`)).not.toBeNull()
  await act(async () => selectBook.click())
  expect(dom.container.querySelector('.survey-navigation [data-survey-zone-id]')).toBeNull()
  expect(dom.container.querySelector('[aria-label="随手记 pages"]')?.textContent).toBe('No pages yet')
  expect((await api.notebooks.read()).pages).toEqual({})
  await dom.click('[aria-label="Back to Survey"]')
  expect(dom.container.querySelector(`[data-survey-zone-id="${created.zone.zoneId}"]`)).not.toBeNull()
  await act(async () => changeNotebook({ kind: 'register', notebookId: 'quick-notes', noteId: 'existing-note', title: 'An existing note',
    resource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: note.path }, workface: { zoneId: created.zone.zoneId, workspaceId: workspace.id } }))
  expect(dom.container.querySelector(`[data-survey-zone-id="${created.zone.zoneId}"]`)).toBeNull()
  expect(useAppStore.getState().tabs[original.id]).toEqual(original)
  const quick = dom.container.querySelector<HTMLButtonElement>('[data-notebook-id="quick-notes"]>.survey-notebook-item')!
  await act(async () => quick.click())
  expect(dom.container.querySelector('[aria-label="随手记 pages"]')?.textContent).toContain('An existing note')
  healthy()
})

it('keeps every existing Note Region on an ambiguous directory reopen rather than creating another Tab', async () => {
  const files = new Map<string, string>()
  vi.spyOn(api.files, 'write').mockImplementation(async (_id, input) => { files.set(input.path, input.content); return { status: 'written', revision: 'same-note' } })
  vi.spyOn(api.files, 'read').mockImplementation(async (_id, path) => ({ status: 'read', document: { path, content: files.get(path)!, revision: 'same-note' } }))
  await renderApp(); await enterSurvey(); await startNotebookWithPage()
  const state = useAppStore.getState(), page = Object.values((await api.notebooks.read()).pages)[0]!
  const selected = state.surveyZoneSelection!.active!, tab = state.tabs[selected.tabId]!, region = tab.regions[selected.regionId]!
  const duplicated = addWorkbenchRegion(tab, selected.regionId, 'right', { ...region, regionId: 'second-note-location' })
  await act(async () => useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: duplicated } }))
  await dom.click(`[aria-label="Notebook directory: ${(await api.notebooks.read()).notebooks[page.notebookId]!.name}"]`)
  const originalTabs = useAppStore.getState().tabs, catalog = await api.notebooks.read()
  await dom.click('.survey-notebook-page')
  await vi.waitFor(() => expect(dom.container.querySelector('.survey-error')?.textContent).toContain('already open in multiple locations'))
  expect(useAppStore.getState().tabs).toEqual(originalTabs)
  expect(await api.notebooks.read()).toEqual(catalog)
  expect(api.files.write).toHaveBeenCalledTimes(1)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('.global-survey-surface .note-editor .ProseMirror')).not.toBeNull() })
  const secondRegion = dom.container.querySelector<HTMLElement>('.global-survey-surface [data-workbench-region-id="second-note-location"]')!
  expect(secondRegion).not.toBeNull()
  await act(async () => secondRegion.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  await dom.click('.survey-notebook-page')
  await vi.waitFor(() => expect(dom.container.querySelector('.survey-error')).toBeNull())
  expect(useAppStore.getState().surveyZoneSelection?.active).toEqual({ tabId: tab.id, regionId: 'second-note-location' })
  expect(useAppStore.getState().tabs).toEqual(originalTabs)
  expect(api.browser.close).not.toHaveBeenCalled(); healthy()
})

it('requires a name and deliberate submission to create a Notebook and cancels without any persistent side effect', async () => {
  const write = vi.spyOn(api.files, 'write')
  await renderApp(); await enterSurvey()
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Notebooks"]')?.textContent).toContain('随手记'))
  const original = await api.notebooks.read()
  await dom.click('[aria-label="New notebook"]')
  expect(await api.notebooks.read()).toEqual(original)
  const form = document.querySelector<HTMLFormElement>('[aria-label="Create notebook"]')!
  expect(form.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true)
  await fill(document.querySelector<HTMLInputElement>('[aria-label="New notebook name"]')!, 'Cancelled draft')
  await act(async () => [...form.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.click())
  expect(await api.notebooks.read()).toEqual(original)
  await createNotebook('Reading notes')
  await vi.waitFor(() => expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Notebook name"]')?.value).toBe('Reading notes'))
  expect(useAppStore.getState().surveyZoneSelection).toBeNull()
  expect(Object.values((await api.notebooks.read()).pages)).toHaveLength(0)
  expect(write).not.toHaveBeenCalled(); expect(api.browser.create).not.toHaveBeenCalled()
  healthy()
})

it('keeps a Browser note in 随手记 after closing its Region and reopens the same file through the Notebook directory', async () => {
  const files = new Map<string, string>()
  vi.spyOn(api.files, 'write').mockImplementation(async (_id, input) => { files.set(input.path, input.content); return { status: 'written', revision: 'same-note' } })
  vi.spyOn(api.files, 'read').mockImplementation(async (_id, path) => ({ status: 'read', document: { path, content: files.get(path)!, revision: 'same-note' } }))
  await renderApp(); await enterSurvey(); await choose()
  await selectRegion(pageA.regionId)
  await dom.click('[aria-label="Add note to this exploration"]')
  await vi.waitFor(async () => expect(Object.keys((await api.notebooks.read()).pages)).toHaveLength(1))
  const saved = (await api.notebooks.read()).pages, page = Object.values(saved)[0]!
  expect(page.notebookId).toBe('quick-notes'); expect(page.sources[0]).toMatchObject({ url: pageA.url, title: pageA.title, position: { regionId: pageA.regionId } })
  const selection = useAppStore.getState().surveyZoneSelection!.active!
  await act(async () => useAppStore.getState().closeRegion(workspace.id, selection.tabId, selection.regionId))
  expect((await api.notebooks.read()).pages).toEqual(saved)
  const book = dom.container.querySelector<HTMLButtonElement>('[data-notebook-id="quick-notes"]>.survey-notebook-item')!
  await act(async () => book.click())
  expect(dom.container.querySelector('[aria-label="Saved pages"]')?.textContent).toContain(page.title)
  await dom.click('[aria-label="Saved pages"] button')
  await vi.waitFor(() => expect(useAppStore.getState().surveyZoneSelection?.active?.regionId).toBeDefined())
  const opened = observation.survey.at(-1)!.selection!.active!, surface = useAppStore.getState().tabs[opened.tabId]!.regions[opened.regionId]!
  expect(surface).toMatchObject({ kind: 'file', workspaceId: workspace.id, path: page.resource.path })
  expect(api.files.write).toHaveBeenCalledTimes(1)
  expect((await api.notebooks.read()).pages[page.noteId]).toEqual(page)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('.global-survey-surface .note-file-view .ProseMirror')).not.toBeNull() })
  await act(async () => useAppStore.getState().closeTab(workspace.id, opened.groupId, opened.tabId))
  expect(useAppStore.getState().surveyNoteId).toBeNull()
  expect(dom.container.querySelector('.survey-notebook-home h1')?.textContent).toBe('随手记')
  expect((await api.notebooks.read()).pages[page.noteId]).toEqual(page)
  healthy()
})

it('keeps a saved Note editable when Notebook registration loses its reply and recovers one original directory entry', async () => {
  const files = new Map<string, string>()
  vi.spyOn(api.files, 'write').mockImplementation(async (_id, input) => { files.set(input.path, input.content); return { status: 'written', revision: 'same-note' } })
  vi.spyOn(api.files, 'read').mockImplementation(async (_id, path) => ({ status: 'read', document: { path, content: files.get(path)!, revision: 'same-note' } }))
  const actual = vi.mocked(api.notebooks.apply).getMockImplementation()!
  vi.mocked(api.notebooks.apply).mockImplementationOnce(async input => { await actual(input); throw new Error('Notebook reply lost') })
  await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  await dom.click('[aria-label="Add note to this exploration"]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('.global-survey-surface .note-file-view .ProseMirror')).not.toBeNull() })
  expect(dom.container.textContent).toContain('Notebook registration is unconfirmed')
  const before = await api.notebooks.read()
  const recover = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry Notebook registration')!
  await act(async () => recover.click())
  await vi.waitFor(() => expect(dom.container.textContent).not.toContain('Notebook registration is unconfirmed'))
  expect(await api.notebooks.read()).toEqual(before)
  expect(api.files.write).toHaveBeenCalledTimes(1)
  healthy()
})


async function renameNotebookField(label: string, value: string) {
  const field = dom.container.querySelector<HTMLInputElement>(`.global-survey-surface [aria-label="${label}"]`)!
  await act(async () => field.focus()); await fill(field, value)
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
}
async function chooseNotebookSelect(label: string, value: string) {
  const field = dom.container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!
  expect(field).not.toBeNull(); await act(async () => { field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })) })
}
it('organizes a real Notebook wiki tree through rename, subpage creation, search and subtree move without copying Note blocks', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey()
  await createNotebook()
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Notebook name"]')).not.toBeNull())
  const bookId = useAppStore.getState().surveyNotebookId!
  await renameNotebookField('Notebook name', 'Research wiki')
  await vi.waitFor(async () => expect((await api.notebooks.read()).notebooks[bookId]!.name).toBe('Research wiki'))
  await dom.click('.notebook-create-page'); await readyNoteRegion()
  await renameNotebookField('Page title', 'A research question')
  await vi.waitFor(async () => expect(Object.values((await api.notebooks.read()).pages)[0]!.title).toBe('A research question'))
  const parent = Object.values((await api.notebooks.read()).pages)[0]!, before = files.get(parent.resource.path)!
  await dom.click('[aria-label="Add subpage to A research question"]')
  await vi.waitFor(async () => expect(Object.values((await api.notebooks.read()).pages).some(page => page.parentNoteId === parent.noteId)).toBe(true))
  const child = Object.values((await api.notebooks.read()).pages).find(page => page.parentNoteId === parent.noteId)!
  await vi.waitFor(async () => { await act(async () => {}); expect(useAppStore.getState().surveyNoteId).toBe(child.noteId); expect(dom.container.querySelector<HTMLInputElement>('.global-survey-surface [aria-label="Page title"]')?.value, JSON.stringify({ selected: useAppStore.getState().surveyZoneSelection, projected: observation.survey.at(-1)?.projection, titles: [...dom.container.querySelectorAll<HTMLInputElement>('.global-survey-surface [aria-label="Page title"]')].map(n => ({ value: n.value, region: n.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id'), slot: n.closest('.workbench-tab-slot')?.id })) }, (key, value) => key === 'catalog' ? undefined : value)).toBe(child.title) }); await renameNotebookField('Page title', 'Evidence and findings')
  await vi.waitFor(async () => expect((await api.notebooks.read()).pages[child.noteId]!.title).toBe('Evidence and findings'))
  const tree = dom.container.querySelector(`[aria-label="Research wiki pages"]`)!
  expect(tree.textContent).toContain('A research question'); expect(tree.textContent).toContain('Evidence and findings')
  await fill(dom.container.querySelector<HTMLInputElement>('[aria-label="Find pages in Research wiki"]')!, 'findings')
  expect(tree.textContent).toContain('A research question'); expect(tree.textContent).toContain('Evidence and findings')
  await fill(dom.container.querySelector<HTMLInputElement>('[aria-label="Find pages in Research wiki"]')!, 'no-match')
  expect(tree.textContent).toContain('No matching pages'); expect(tree.textContent).not.toContain('A research question')
  await fill(dom.container.querySelector<HTMLInputElement>('[aria-label="Find pages in Research wiki"]')!, '')
  const original = useNotebookLibrary.getState().state!.pages[parent.noteId]!
  const parentButton = [...tree.querySelectorAll<HTMLButtonElement>('.survey-notebook-page')].find(button => button.textContent === 'A research question')!
  await act(async () => parentButton.click())
  await vi.waitFor(() => expect(dom.container.querySelector<HTMLInputElement>('.global-survey-surface [aria-label="Page title"]')?.value).toBe('A research question'))
  await dom.click('[aria-label="Move page"]'); await chooseNotebookSelect('Destination notebook', 'quick-notes')
  await submit(dom.container.querySelector<HTMLFormElement>('[aria-label="Move Note page"]')!)
  await vi.waitFor(async () => expect((await api.notebooks.read()).pages[parent.noteId]!.notebookId).toBe('quick-notes'))
  const final = await api.notebooks.read()
  expect(final.pages[child.noteId]).toMatchObject({ notebookId: 'quick-notes', parentNoteId: parent.noteId })
  expect(final.pages[parent.noteId]!.resource).toEqual(original.resource); expect(files.get(parent.resource.path)).toBe(before)
  expect(files.size).toBe(2); expect(new Set([parent.resource.path, child.resource.path]).size).toBe(2); expect(api.files.write).toHaveBeenCalledTimes(3)
  expect(final.trail.filter(event => event.action === 'moved')).toHaveLength(2)
  await dom.click('[aria-label="Page history"]')
  expect(dom.container.querySelector('[aria-label="Note history"]')?.textContent).toContain('Research wiki / Root → 随手记 / Root')
  expect(dom.container.querySelector('[aria-label="Note history"]')?.textContent).toContain('actual-ui-user')
  healthy()
})

it('retains web sources after their Browser closes, shows exact Note history and retries one original rename after a lost reply', async () => {
  noteTransport(); await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  await dom.click('[aria-label="Add note to this exploration"]'); await readyNoteRegion()
  const page = Object.values((await api.notebooks.read()).pages)[0]!, original = useAppStore.getState().documents[documentKey(page.resource.workspaceId, page.resource.path)]!.content
  const actual = vi.mocked(api.notebooks.apply).getMockImplementation()!
  vi.mocked(api.notebooks.apply).mockImplementationOnce(async input => { await actual(input); throw new Error('Rename reply lost') })
  await renameNotebookField('Page title', 'Useful evidence')
  await vi.waitFor(() => expect(dom.container.querySelector('.notebook-change-issue')?.textContent).toContain('Rename reply lost'))
  const changed = await api.notebooks.read(), intent = vi.mocked(api.notebooks.apply).mock.calls.at(-1)![0]
  await dom.click('.notebook-change-issue button')
  await vi.waitFor(() => expect(dom.container.querySelector('.notebook-change-issue')).toBeNull())
  expect(vi.mocked(api.notebooks.apply).mock.calls.at(-1)![0].operationId).toBe(intent.operationId)
  expect(await api.notebooks.read()).toEqual(changed)
  await act(async () => useAppStore.getState().closeRegion(workspace.id, mixed.id, pageA.regionId))
  await dom.click('[aria-label="Page sources"]')
  expect(dom.container.querySelector('[aria-label="Saved web sources"]')?.textContent).toContain(pageA.url)
  await dom.click('[aria-label="Page history"]')
  expect(dom.container.querySelector('[aria-label="Note history"]')?.textContent).toContain('Untitled note → Useful evidence')
  await dom.click('[aria-label="Page sources"]')
  const create = vi.spyOn(useAppStore.getState(), 'createSurveyBrowser')
  await dom.click('[aria-label="Open source Same title"]')
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  expect(create.mock.calls[0]![0]).toMatchObject({ workspaceId: workspace.id, url: pageA.url, preparation: null })
  expect((await api.notebooks.read()).pages[page.noteId]!.sources).toEqual(page.sources)
  expect(useAppStore.getState().documents[documentKey(page.resource.workspaceId, page.resource.path)]!.content).toBe(original)
  expect(api.files.write).toHaveBeenCalledTimes(1); healthy()
})


it('records Note Topic history only after knowledge confirms and retries one lost history receipt without moving its workface', async () => {
  const files = noteTransport(); const call = knowledgeTransport(); await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  await dom.click('[aria-label="Add note to this exploration"]'); await readyNoteRegion()
  const page = Object.values((await api.notebooks.read()).pages)[0]!, bytes = files.get(page.resource.path)
  const binding = vi.spyOn(useAppStore.getState(), 'setZoneSpaceRelation')
  const transport = call.getMockImplementation()!, apply = vi.mocked(api.notebooks.apply).getMockImplementation()!
  let unavailable = true
  call.mockImplementation(async (method, params) => { if (method === 'topic.knowledge.write' && unavailable) throw new Error('Knowledge owner unavailable'); return transport(method, params) })
  await captureScope('panel'); await selectValue(captureDialog().querySelector('select')!, 'view:b')
  await dialogButton(captureDialog(), 'Continue'); await dialogButton(knowledgeDialog(), 'Save knowledge')
  expect((await api.notebooks.read()).trail.some(event => event.action === 'organized')).toBe(false)
  expect(knowledgeDialog().textContent).toContain('Knowledge owner unavailable'); expect(files.get(page.resource.path)).toBe(bytes)
  unavailable = false
  vi.mocked(api.notebooks.apply).mockImplementationOnce(async input => { await apply(input); throw new Error('Topic history receipt lost') })
  await dialogButton(knowledgeDialog(), 'Save knowledge')
  await vi.waitFor(() => expect(useAppStore.getState().notebookRecoveries).toHaveLength(1))
  const confirmed = await api.notebooks.read(), held = useAppStore.getState().notebookRecoveries[0]!
  expect(confirmed.pages[page.noteId]!.topics).toEqual([{ spaceId: directoryIdentity('local', _hygiene_fixturePath("topics/b")), topicId: 'view:b' }])
  expect(confirmed.trail.filter(event => event.action === 'organized')).toHaveLength(1)
  await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry history')!.click())
  await vi.waitFor(() => expect(useAppStore.getState().notebookRecoveries).toHaveLength(0))
  expect(vi.mocked(api.notebooks.apply).mock.calls.at(-1)![0].operationId).toBe(held.operationId)
  expect(await api.notebooks.read()).toEqual(confirmed); expect(files.get(page.resource.path)).toBe(bytes)
  expect(binding).not.toHaveBeenCalled(); expect(api.files.write).toHaveBeenCalledTimes(1); healthy()
})

it('follows a confirmed original file rename with the same Note and durable recovery, and refuses an unconfirmed move', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  await dom.click('[aria-label="Add note to this exploration"]'); const ref = await readyNoteRegion()
  const page = Object.values((await api.notebooks.read()).pages)[0]!, bytes = files.get(page.resource.path)!, next = 'Reading findings.note.json'
  const move = vi.spyOn(api.files,'move').mockResolvedValueOnce({status:'error',code:'MOVE_UNKNOWN',message:'File move is unconfirmed',finalLocation:'unknown'})
  await act(async () => { await expect(useAppStore.getState().renamePath(page.resource.path,next,page.resource.workspaceId)).rejects.toThrow('File move is unconfirmed') })
  expect((await api.notebooks.read()).pages[page.noteId]!.resource).toEqual(page.resource)
  expect((await api.notebooks.read()).trail.some(event=>event.action==='relocated')).toBe(false)
  move.mockImplementation(async input => { files.set(input.destination.path,files.get(input.source.path)!);files.delete(input.source.path);return {status:'moved'} })
  const apply = vi.mocked(api.notebooks.apply).getMockImplementation()!
  vi.mocked(api.notebooks.apply).mockImplementationOnce(async input => { await apply(input); throw new Error('Relocation receipt lost') })
  await act(async () => useAppStore.getState().renamePath(page.resource.path,next,page.resource.workspaceId))
  expect(useAppStore.getState().tabs[ref.tabId]!.regions[ref.regionId]).toMatchObject({kind:'file',path:next})
  const pending = useAppStore.getState().notebookRecoveries
  expect(pending).toHaveLength(1)
  const persisted = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
  expect(restorePersistedUiState(useAppStore.getState().config!,persisted).notebookRecoveries).toEqual(pending)
  const changed = await api.notebooks.read()
  expect(changed.pages[page.noteId]!.resource).toEqual({...page.resource,path:next})
  expect(changed.trail.at(-1)).toMatchObject({action:'relocated',before:{resource:page.resource},after:{resource:{...page.resource,path:next}}})
  await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Retry history')!.click())
  await vi.waitFor(() => expect(useAppStore.getState().notebookRecoveries).toHaveLength(0))
  expect(await api.notebooks.read()).toEqual(changed); expect(move).toHaveBeenCalledTimes(2)
  expect(files.get(next)).toBe(bytes); expect(JSON.parse(bytes).noteId).toBe(page.noteId); healthy()
})

it('keeps editing a copied Note while withholding metadata actions for its different resource and preserves foreign resources', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  await dom.click('[aria-label="Add note to this exploration"]'); const ref = await readyNoteRegion()
  const target = savedNotes().at(-1)!.target
  const page = Object.values((await api.notebooks.read()).pages)[0]!, copied = 'Copied.note.json', bytes = files.get(page.resource.path)!
  files.set(copied,bytes)
  await act(async () => useAppStore.getState().openFile(copied,target.groupId,undefined,page.resource.workspaceId,true,{displayWorkspaceId:target.displayWorkspaceId!,space:{zoneId:page.workface!.zoneId,spaceId:savedNotes().at(-1)!.target.sourceSpaceId!},resource:{hostId:page.resource.hostId,path:page.resource.workspacePath},projection:{...observation.survey.at(-1)!.projection!,entity:{kind:'zone',zoneId:page.workface!.zoneId},onSelect(reference){useAppStore.getState().setSurveyZoneSelection({zoneId:page.workface!.zoneId,selection:[reference],active:reference})}}}))
  const copiedLocation = catalog().locations.find(location => { const region = useAppStore.getState().tabs[location.tabId]?.regions[location.regionId];return region?.kind==='file' && region.path===copied })!
  expect(copiedLocation).toBeDefined()
  await act(async () => useAppStore.getState().setSurveyZoneSelection({zoneId:useAppStore.getState().tabs[copiedLocation.tabId]!.space!.zoneId,selection:[copiedLocation],active:copiedLocation}))
  const copiedView = () => dom.container.querySelector(`.global-survey-surface [data-workbench-region-id="${copiedLocation.regionId}"]`)!
  await vi.waitFor(() => expect(copiedView()?.querySelector('.note-file-view')?.textContent).toContain('different recorded Note location'))
  expect(copiedView().querySelector('[aria-label="Page title"]')).toBeNull()
  expect(copiedView().querySelector('.note-editor .ProseMirror')).not.toBeNull()
  expect((await api.notebooks.read()).pages[page.noteId]!.resource).toEqual(page.resource)
  const {notebookRelocations} = await import('../src/renderer/src/lib/notebook-library')
  expect(notebookRelocations(await api.notebooks.read(),{id:page.resource.workspaceId,hostId:'remote-host',path:page.resource.workspacePath},page.resource.path,'remote.note.json')).toEqual([])
  expect(notebookRelocations(await api.notebooks.read(),{id:page.resource.workspaceId,hostId:page.resource.hostId,path:_hygiene_fixturePath("another-root")},page.resource.path,'wrong.note.json')).toEqual([])
  healthy()
})


it('saves a Notebook source and borrowed-page history without copying Note resources or binding their Zones', async () => {
  const files = noteTransport(); const fileMove = vi.spyOn(api.files,'move'); await renderApp(); await enterSurvey(); await choose(); await selectRegion(pageA.regionId)
  await dom.click('[aria-label="Add note to this exploration"]'); await readyNoteRegion()
  const borrowed = Object.values((await api.notebooks.read()).pages)[0]!
  await createNotebook(); const bookId = useAppStore.getState().surveyNotebookId!
  await dom.click('.notebook-create-page'); await readyNoteRegion()
  const actual = Object.values((await api.notebooks.read()).pages).find(page=>page.noteId!==borrowed.noteId)!
  const {changeNotebook} = await import('../src/renderer/src/lib/notebook-library')
  await act(async () => changeNotebook({kind:'move',noteId:borrowed.noteId,notebookId:bookId,parentNoteId:null},'borrowed-page-location'))
  await dom.click(`[data-notebook-id="${bookId}"] .survey-notebook-item`)
  const before = await api.notebooks.read(), bodies = new Map(files)
  const call = knowledgeTransport(), binding = vi.spyOn(useAppStore.getState(), 'setZoneSpaceRelation')
  await captureScope('research'); await selectValue(captureDialog().querySelector('select')!, 'view:b')
  await dialogButton(captureDialog(), 'Continue'); await dialogButton(knowledgeDialog(), 'Save knowledge')
  await vi.waitFor(async () => expect((await api.notebooks.read()).pages[actual.noteId]!.topics).toHaveLength(1))
  const after = await api.notebooks.read(), destination = directoryIdentity('local', _hygiene_fixturePath("topics/b"))
  expect(call.mock.calls.find(([method]) => method === 'topic.knowledge.write')![1]).toMatchObject({ sources: [{ kind: 'notebook', notebookId: bookId }] })
  expect(binding).not.toHaveBeenCalled()
  expect(after.pages[borrowed.noteId]!.topics).toEqual([{ spaceId: destination, topicId: 'view:b' }])
  expect(after.pages[actual.noteId]!.resource).toEqual(before.pages[actual.noteId]!.resource)
  expect(after.pages[borrowed.noteId]!.resource).toEqual(before.pages[borrowed.noteId]!.resource)
  expect(after.trail.filter(event => event.action === 'organized')).toHaveLength(2); expect(files).toEqual(bodies)
  expect(fileMove).not.toHaveBeenCalled(); healthy()
})


it('keeps an open standalone Notebook page and every exact foreign Group selected after the original File owner changes its Tab ID', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey(); await createNotebook()
  await dom.click('.notebook-create-page'); const raw = await readyNoteRegion()
  const page = Object.values((await api.notebooks.read()).pages)[0]!, bytes = files.get(page.resource.path)!
  const location = observation.survey.at(-1)!.selection!.active!
  await act(async () => useAppStore.setState({config:{...useAppStore.getState().config!,workspaces:[...useAppStore.getState().config!.workspaces,otherWorkspace]},layouts:{...useAppStore.getState().layouts,[otherWorkspace.id]:createWorkspaceLayout('foreign-note-group',[raw.tabId])}}))
  const selection = useAppStore.getState().surveyZoneSelection!
  await act(async () => useAppStore.getState().setSurveyZoneSelection({...selection,active:{...selection.active!}}))
  vi.spyOn(api.files,'move').mockImplementation(async input=>{files.set(input.destination.path,files.get(input.source.path)!);files.delete(input.source.path);return {status:'moved'}})
  await act(async () => useAppStore.getState().renamePath(page.resource.path,'Standalone renamed.note.json',page.resource.workspaceId))
  const state = useAppStore.getState(), selected = state.surveyZoneSelection!.active!
  expect(selected.tabId).not.toBe(raw.tabId); expect(selected.regionId).toBe(raw.regionId)
  expect(state.tabs[selected.tabId]!.regions[selected.regionId]).toMatchObject({kind:'file',path:'Standalone renamed.note.json'})
  expect(state.layouts[otherWorkspace.id]!.groups[0]!.activeTabId).toBe(selected.tabId)
  expect(state.layouts[otherWorkspace.id]!.groups[0]!.tabOrder).toEqual([selected.tabId])
  expect(observation.survey.at(-1)!.projection!.entity).toEqual({kind:'region',regionId:raw.regionId})
  expect(observation.survey.at(-1)!.selection!.active).toMatchObject({displayWorkspaceId:location.displayWorkspaceId,groupId:location.groupId,tabId:selected.tabId,regionId:raw.regionId})
  expect(dom.container.querySelector('.global-survey-surface .note-editor .ProseMirror')).not.toBeNull()
  expect(files.get('Standalone renamed.note.json')).toBe(bytes);expect(JSON.parse(bytes).noteId).toBe(page.noteId); healthy()
})


async function archiveCurrentNotebookPage() {
  const trigger = dom.container.querySelector<HTMLElement>('[aria-label="Page options"]')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await vi.waitFor(() => expect([...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent === 'Archive page')).toBe(true))
  const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Archive page')!
  await act(async () => action.click())
}

it('archives from the actual page menu and reopens and restores the original Note through its archived directory', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  await renameNotebookField('Page title', 'A thought worth keeping')
  const state = useAppStore.getState(), bookId = state.surveyNotebookId!, noteId = state.surveyNoteId!, reference = state.surveyZoneSelection!.active!
  const editor = dom.container.querySelector('.global-survey-surface .note-editor'), body = [...files.values()][0], writeCount = vi.mocked(api.files.write).mock.calls.length
  await archiveCurrentNotebookPage()
  await vi.waitFor(() => expect(useNotebookLibrary.getState().state?.pages[noteId]?.archivedAt).toBeTypeOf('number'))
  await vi.waitFor(() => expect(dom.container.querySelector('.survey-notebook-navigation [aria-label="Archived pages"]')?.getAttribute('aria-pressed')).toBe('true'))
  expect(dom.container.querySelector('.global-survey-surface .note-editor')).toBe(editor)
  expect(dom.container.querySelector('.notebook-archive-status')?.textContent).toContain('Archived')
  await dom.click(`[aria-label="Notebook directory: Research notebook"]`)
  const pagesToggle = [...dom.container.querySelectorAll<HTMLButtonElement>('.survey-notebook-navigation .notebook-directory-views button')].find(button => button.textContent === 'Pages')!
  await act(async () => pagesToggle.click())
  expect(dom.container.querySelector('.survey-notebook-page')).toBeNull()
  expect(dom.container.querySelector('.survey-notebook-navigation')?.textContent).toContain('No pages yet')
  await dom.click('.survey-notebook-navigation [aria-label="Archived pages"]')
  expect(dom.container.querySelector('.survey-notebook-page')?.textContent).toBe('A thought worth keeping')
  await dom.click('.survey-notebook-page')
  await vi.waitFor(() => expect(useAppStore.getState().surveyZoneSelection!.active).toEqual(reference))
  await dom.click('.notebook-archive-status button')
  await vi.waitFor(() => expect(useNotebookLibrary.getState().state?.pages[noteId]?.archivedAt).toBeUndefined())
  expect(useAppStore.getState().surveyNotebookId).toBe(bookId)
  expect(useAppStore.getState().surveyNoteId).toBe(noteId)
  expect([...files.values()][0]).toBe(body); expect(vi.mocked(api.files.write).mock.calls).toHaveLength(writeCount)
  expect((await api.notebooks.read()).trail.filter(event => ['archived', 'restored'].includes(event.action)).map(event => event.action)).toEqual(['archived', 'restored'])
  expect(api.browser.close).not.toHaveBeenCalled(); healthy()
})

it('keeps the original editor and active directory after an archive reply is lost and retries one exact operation', async () => {
  noteTransport(); await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  const noteId = useAppStore.getState().surveyNoteId!, editor = dom.container.querySelector('.global-survey-surface .note-editor')
  const apply = vi.mocked(api.notebooks.apply).getMockImplementation()!, inputs: Parameters<typeof api.notebooks.apply>[0][] = []
  let lost = true
  vi.mocked(api.notebooks.apply).mockImplementation(async input => {
    const state = await apply(input)
    if (input.change.kind === 'archive') { inputs.push(structuredClone(input)); if (lost) { lost = false; throw new Error('Archive reply unavailable') } }
    return state
  })
  await archiveCurrentNotebookPage()
  await vi.waitFor(() => expect(dom.container.querySelector('.notebook-change-issue')?.textContent).toContain('Archive reply unavailable'))
  expect(useNotebookLibrary.getState().state?.pages[noteId]?.archivedAt).toBeUndefined()
  expect(dom.container.querySelector('.survey-notebook-page')).not.toBeNull()
  expect(dom.container.querySelector('.global-survey-surface .note-editor')).toBe(editor)
  await dom.click('.notebook-change-issue button')
  await vi.waitFor(() => expect(useNotebookLibrary.getState().state?.pages[noteId]?.archivedAt).toBeTypeOf('number'))
  expect(inputs).toHaveLength(2); expect(inputs[1]!.operationId).toBe(inputs[0]!.operationId)
  expect((await api.notebooks.read()).trail.filter(event => event.action === 'archived')).toHaveLength(1)
  expect(dom.container.querySelector('.global-survey-surface .note-editor')).toBe(editor); healthy()
})


it('keeps a separately archived child when restoring its parent and finds it through the collapsed Notebook home', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  await renameNotebookField('Page title', 'Original question')
  const parent = Object.values((await api.notebooks.read()).pages)[0]!
  await dom.click('[aria-label="Add subpage to Original question"]')
  await vi.waitFor(async () => expect(Object.values((await api.notebooks.read()).pages).some(page => page.parentNoteId === parent.noteId)).toBe(true))
  const child = Object.values((await api.notebooks.read()).pages).find(page => page.parentNoteId === parent.noteId)!
  await vi.waitFor(() => expect(useAppStore.getState().surveyNoteId).toBe(child.noteId))
  await renameNotebookField('Page title', 'Independent evidence')
  await archiveCurrentNotebookPage()
  await vi.waitFor(() => expect(useNotebookLibrary.getState().state?.pages[child.noteId]?.archivedAt).toBeTypeOf('number'))
  const pagesButton = [...dom.container.querySelectorAll<HTMLButtonElement>('.survey-notebook-navigation .notebook-directory-views button')].find(button => button.textContent === 'Pages')!
  await act(async () => pagesButton.click())
  expect(dom.container.querySelectorAll('.survey-notebook-page')).toHaveLength(1)
  await dom.click('.survey-notebook-page')
  await vi.waitFor(() => expect(useAppStore.getState().surveyNoteId).toBe(parent.noteId))
  await archiveCurrentNotebookPage()
  await vi.waitFor(() => expect(useNotebookLibrary.getState().state?.pages[parent.noteId]?.archivedAt).toBeTypeOf('number'))
  expect(dom.container.querySelectorAll('.survey-notebook-page')).toHaveLength(2)
  await dom.click('.notebook-archive-status button')
  await vi.waitFor(() => expect(useNotebookLibrary.getState().state?.pages[parent.noteId]?.archivedAt).toBeUndefined())
  expect(useNotebookLibrary.getState().state?.pages[child.noteId]?.archivedAt).toBeTypeOf('number')
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.survey-notebook-page')).toHaveLength(1))
  await dom.click('[aria-label="Hide Survey items"]')
  await dom.click('.survey-item-actions .survey-tab-view')
  await vi.waitFor(() => expect(dom.container.querySelector('.survey-notebook-home')).not.toBeNull())
  await dom.click('.survey-notebook-home [aria-label="Archived pages"]')
  expect(dom.container.querySelector('.notebook-page-directory')?.textContent).toContain('Independent evidence')
  expect(dom.container.querySelector('.notebook-page-directory')?.textContent).not.toContain('Original question')
  expect((await api.notebooks.read()).pages[child.noteId]?.parentNoteId).toBe(parent.noteId)
  expect(files.size).toBe(2); expect(api.browser.close).not.toHaveBeenCalled(); healthy()
})


async function requestDeleteNotebook() {
  await openItemOptions()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Delete notebook'))!
  expect(item).not.toBeUndefined()
  await act(async () => item.click())
  await vi.waitFor(() => expect(document.querySelector('.confirmation-dialog')).not.toBeNull())
}
async function confirmDeleteNotebook() { await act(async () => document.querySelector<HTMLButtonElement>('.confirmation-dialog [data-confirm-label]')!.click()) }

it('deletes the selected Notebook only after confirmation and retains the original open Note, archived child and hierarchy in 随手记', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  await renameNotebookField('Page title', 'Original question')
  const parent = Object.values((await api.notebooks.read()).pages)[0]!, bookId = parent.notebookId
  await dom.click('[aria-label="Add subpage to Original question"]'); await readyNoteRegion()
  const child = Object.values((await api.notebooks.read()).pages).find(page => page.parentNoteId === parent.noteId)!
  await archiveCurrentNotebookPage()
  const original = await api.notebooks.read(), body = new Map(files), writes = vi.mocked(api.files.write).mock.calls.length
  const editor = dom.container.querySelector('.global-survey-surface .note-editor .ProseMirror')!
  expect(editor).not.toBeNull()
  const selected = useAppStore.getState().surveyZoneSelection
  await requestDeleteNotebook()
  expect(document.querySelector('.confirmation-dialog')?.textContent).toContain('2 pages will move to 随手记')
  await act(async () => document.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')!.click())
  expect(await api.notebooks.read()).toEqual(original)
  await requestDeleteNotebook(); await confirmDeleteNotebook()
  await vi.waitFor(async () => expect((await api.notebooks.read()).notebooks[bookId]).toBeUndefined())
  await vi.waitFor(() => expect(useAppStore.getState().surveyNotebookId).toBe('quick-notes'))
  const final = await api.notebooks.read()
  expect(final.pages[parent.noteId]).toMatchObject({ notebookId: 'quick-notes', resource: parent.resource, parentNoteId: null })
  expect(final.pages[child.noteId]).toMatchObject({ notebookId: 'quick-notes', resource: child.resource, parentNoteId: parent.noteId, archivedAt: original.pages[child.noteId]!.archivedAt })
  expect(files).toEqual(body); expect(api.files.write).toHaveBeenCalledTimes(writes)
  expect(useAppStore.getState().surveyZoneSelection).toBe(selected)
  expect(dom.container.querySelector('.global-survey-surface .note-editor .ProseMirror')).toBe(editor)
  expect(dom.container.querySelector('[aria-label="Archived pages"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(dom.container.querySelector('.survey-notebook-page')?.textContent).toBe(child.title)
  expect(final.trail.filter(event => event.operationId === final.trail.at(-1)!.operationId)).toHaveLength(2)
  await dom.click('[aria-label="Page history"]')
  expect(dom.container.querySelector('[aria-label="Note history"]')?.textContent).toContain('Research notebook / Original question → 随手记 / Original question')
  expect(api.browser.close).not.toHaveBeenCalled(); healthy()
})

it('reconciles the same Notebook deletion after a lost reply without removing later navigation', async () => {
  noteTransport(); await renderApp(); await enterSurvey(); await createNotebook('Disposable book')
  const id = useAppStore.getState().surveyNotebookId!, original = vi.mocked(api.notebooks.apply).getMockImplementation()!
  vi.mocked(api.notebooks.apply).mockImplementationOnce(async input => { await original(input); throw new Error('Deletion reply lost') })
  await requestDeleteNotebook(); await confirmDeleteNotebook()
  await vi.waitFor(() => expect(document.querySelector('.confirmation-dialog [role="status"]')?.textContent).toContain('Deletion reply lost'))
  const first = vi.mocked(api.notebooks.apply).mock.calls.at(-1)![0]
  expect(first.change).toEqual({ kind: 'delete', notebookId: id })
  await act(async () => document.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')!.click())
  expect(dom.container.querySelector('.notebook-change-issue')?.textContent).toContain('Disposable book')
  const { changeNotebook } = await import('../src/renderer/src/lib/notebook-library')
  await act(async () => { await changeNotebook({ kind: 'create', notebookId: 'later-book', name: 'Later choice' }, 'later-book-create'); useAppStore.getState().setSurveyNotebook('later-book') })
  await dom.click('[aria-label="Hide Survey items"]')
  await dom.click('[aria-label="Check notebook deletion"]')
  expect(document.querySelector('.confirmation-dialog__subject')?.textContent).toBe('Disposable book')
  await confirmDeleteNotebook()
  await vi.waitFor(() => expect(document.querySelector('.confirmation-dialog')).toBeNull())
  expect(vi.mocked(api.notebooks.apply).mock.calls.at(-1)![0].operationId).toBe(first.operationId)
  expect(useAppStore.getState().surveyNotebookId).toBe('later-book')
  expect((await api.notebooks.read()).notebooks[id]).toBeUndefined(); healthy()
})

it('keeps one exact named creation after a lost reply and does not navigate over a later Notebook choice', async () => {
  await renderApp(); await enterSurvey()
  const original = vi.mocked(api.notebooks.apply).getMockImplementation()!
  vi.mocked(api.notebooks.apply).mockImplementationOnce(async input => { await original(input); throw new Error('Creation reply lost') })
  await dom.click('[aria-label="New notebook"]')
  await fill(document.querySelector<HTMLInputElement>('[aria-label="New notebook name"]')!, 'One exact book')
  await submit(document.querySelector<HTMLFormElement>('[aria-label="Create notebook"]')!)
  await vi.waitFor(() => expect(document.querySelector('.notebook-create-issue')?.textContent).toContain('Creation reply lost'))
  const first = vi.mocked(api.notebooks.apply).mock.calls.at(-1)![0]
  expect(document.querySelector<HTMLInputElement>('[aria-label="New notebook name"]')?.disabled).toBe(true)
  await act(async () => useAppStore.getState().setSurveyNotebook('quick-notes'))
  await submit(document.querySelector<HTMLFormElement>('[aria-label="Create notebook"]')!)
  await vi.waitFor(() => expect(document.querySelector('.notebook-create-dialog')).toBeNull())
  expect(vi.mocked(api.notebooks.apply).mock.calls.at(-1)![0].operationId).toBe(first.operationId)
  expect(Object.values((await api.notebooks.read()).notebooks).filter(book => book.name === 'One exact book')).toHaveLength(1)
  expect(useAppStore.getState().surveyNotebookId).toBe('quick-notes'); healthy()
})
