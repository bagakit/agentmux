const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { openNotebookPage } from '../src/renderer/src/lib/recall-notebooks'
import { reconcileNotesStorageResources } from '../src/renderer/src/lib/notes-storage-reconciliation'
import { emptyNotebookState, applyNotebookChange } from '@agentmux/core/notebook-catalog'
import { changeNotebook, useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { AgentMuxNotebookStore } from '../../../packages/core/src/notebook-store'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { desktopSpatialGraph, desktopBindingsFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { act } from 'react'
import { flushSync } from 'react-dom'
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
  recall: [] as Parameters<typeof import('../src/renderer/src/components/GlobalRecallSurface').GlobalRecallSurface>[0][],
  memory: [] as { input: SurfaceMemoryCollectionInput; candidates: { id: string; kind: string; visible: boolean; navigationContextActive: boolean }[] }[],
  terminals: [] as { workbenchVisible: boolean; projectedVisibleTabIds?: ReadonlySet<string> | undefined }[],
  stages: [] as { stage: HTMLElement; host: string | null; update: () => void; stopped: boolean }[]
}))
vi.mock('../src/renderer/src/components/GlobalRecallSurface', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/GlobalRecallSurface')>()
  return { ...actual, GlobalRecallSurface: (props: Parameters<typeof actual.GlobalRecallSurface>[0]) => {
    observation.recall.push(props); return <actual.GlobalRecallSurface {...props} catalog={observation.catalogUnavailable ? { spaces: [], zones: [], bindings: [], tabs: [], regions: [], locations: [] } : props.catalog} />
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
import { NOTES_WORKSPACE_ID } from '../src/shared/notes-library'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { surveyInitialZoneSelection, type SurveyZoneSelection } from '../src/renderer/src/lib/survey-workface'
import { projectWorkbenchProjection, resolveWorkbenchZone, workbenchRegionProjectionSlotId, type WorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { directoryIdentity } from '../src/shared/space-addresses'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '@agentmux/core'
import { useAppStore, restorePersistedUiState } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const realInitialize = useAppStore.getState().initialize
const workspace = composerConfig.workspaces[0]!
const scratchWorkspace = { ...workspace, id: NOTES_WORKSPACE_ID, path: _hygiene_fixturePath("notes"), name: 'Topics' }
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
let nameOwnerCleanup: (() => Promise<void>) | undefined

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
  observation.memory = []; observation.terminals = []; observation.stages = []; observation.recall = []
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const survey = this.closest('.global-recall-surface') !== null
    return new DOMRect(survey ? 200 : 250, 48, 600, 500)
  })
  useAppStore.setState({ loading: false, initialize: vi.fn(async () => () => {}), mainSurface: 'workbench',
    surveySidebarWidth: 220, surveySidebarCollapsed: false,
    recallZoneSelection: null, recallSidebarWidth: 220, recallSidebarCollapsed: false, notebookRecoveries: [], recallNotebookId: null, recallNoteId: null, surveyCollectedZones: {}, surveyExplorationNames: {}, surveyZoneSelection: null, spaceZoneBindings: {}, spatialRequests: {}, scratchTopicSnapshots: {}, surveyToolsOpen: false, config: { ...composerConfig, workspaces: [...composerConfig.workspaces, scratchWorkspace, {...workspace,id:SCRATCH_WORKSPACE_ID,path:_hygiene_fixturePath("scratch"),name:'Topics'}] }, activeWorkspaceId: workspace.id,
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
afterEach(async () => {
  await nameOwnerCleanup?.(); nameOwnerCleanup = undefined
  vi.useRealTimers()
  css?.remove(); vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  if (savedLauncherStorage === null) localStorage.removeItem('agentmux-launcher'); else localStorage.setItem('agentmux-launcher', savedLauncherStorage)
  if (savedStorage === null) localStorage.removeItem('agentmux-workbench-v1'); else localStorage.setItem('agentmux-workbench-v1', savedStorage)
})
async function renderApp() { await dom.render(<DesktopClientUiProvider><App /></DesktopClientUiProvider>) }
/** Name writes require the production durable owner, not the Browser preview transport. */
async function realNameOwner() {
  const directory = await mkdtemp(join(tmpdir(), 'amux-survey-name-'))
  const owner = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  const state = useAppStore.getState()
  await owner.commit({ expectedRevision: 0, graph: desktopSpatialGraph(state, []) })
  vi.spyOn(api.spatial, 'read').mockImplementation(() => owner.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => owner.commit(input))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => owner.retainDisplayLabels(values))
  vi.spyOn(api.spatial, 'renameLabel').mockImplementation(input => owner.mutateDisplayLabel(input, {
    actor: { kind: 'device', id: 'survey-test-user', verified: true }, source: 'desktop-ui',
    entryPoint: 'spatial:renameLabel', transport: 'electron-ipc', location: { windowId: 'survey-test' }
  }))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => owner.subscribe(listener))
  vi.spyOn(api.config, 'get').mockResolvedValue(state.config!)
  const snapshot = await api.sessions.snapshot()
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ ...snapshot, sessions: state.sessions, recoveryCandidates: [] })
  useAppStore.setState({ nameLabels: {}, nameAuthorityRevision: 0, nameAcknowledgementRevision: 0,
    restoredWorkbench: { tabs: state.tabs, layouts: state.layouts } })
  const dispose = await realInitialize()
  nameOwnerCleanup = async () => { await useAppStore.getState().retryWorkbenchSave(); dispose(); await rm(directory, { recursive: true, force: true }) }
}
function savedNotes() { return Object.values(useLauncherState.getState().drafts).flatMap(draft => draft.noteCreation ? [draft.noteCreation] : []) }
function pendingNoteReference() { const receipt = savedNotes().at(-1)!; expect(receipt.launcher).toBeDefined(); return receipt.launcher! }
function noteTransport(status: 'written' | 'unknown' | 'error' = 'written', waiting?: Promise<void>) {
  const writes = new Map<string, string>()
  vi.spyOn(api.files, 'write').mockImplementation(async (_id, input) => { if (input.expectedRevision === null && writes.has(input.path)) return { status: 'conflict', observedRevision: 'note-written' }; writes.set(input.path, input.content); await waiting; return status === 'written' ? { status, revision: 'note-written' } : { status, code: 'NOTE_WRITE', message: 'Note write not confirmed' } })
  vi.spyOn(api.files, 'read').mockImplementation(async (_id, path) => ({ status: 'read', document: { path, content: writes.get(path)!, revision: 'note-written' } }))
  return writes
}
async function recoverSameNote() { const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Recover same note')!; expect(button).toBeDefined(); await act(async () => button.click()) }
async function readyNoteRegion() { await vi.waitFor(async () => { await act(async () => {}); expect(savedNotes().at(-1), JSON.stringify(savedNotes().at(-1))).toMatchObject({ status: 'written', revealed: true }); expect(dom.container.querySelector('.global-recall-surface .note-editor'), dom.container.querySelector('.global-recall-surface')?.textContent).not.toBeNull() }, { timeout: 5000 }); return pendingNoteReference() }
async function fill(field: HTMLInputElement, value: string) {
  expect(field).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function submit(form: HTMLFormElement) {
  expect(form).not.toBeNull(); await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
async function enterSurvey() { await dom.click('[aria-label="Recall: keep and revisit knowledge"]') }
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
const slot = () => [...dom.container.querySelectorAll<HTMLElement>('.global-recall-surface .workbench-tab-slot[data-workbench-tab-id]')].find(slot => slot.dataset.workbenchTabId === useAppStore.getState().recallZoneSelection?.active?.tabId)!
const selectedRegion = () => [...slot().querySelectorAll<HTMLElement>('[data-workbench-region-id]')].find(region => region.dataset.workbenchRegionId === useAppStore.getState().recallZoneSelection?.active?.regionId)!
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
  return resolveWorkbenchZone(selection.zoneId,catalog(),state.layouts,state.tabs,'recall-workbench',selection.selection,vi.fn())!
}




























































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










async function createNotebook(name = 'Research notebook') {
  await openNotebookCreation()
  const input = document.querySelector<HTMLInputElement>('[aria-label="New notebook name"]')!
  expect(input).not.toBeNull()
  await fill(input, name)
  await submit(document.querySelector<HTMLFormElement>('[aria-label="Create notebook"]')!)
  await vi.waitFor(() => expect(useNotebookLibrary.getState().state?.notebooks[useAppStore.getState().recallNotebookId!]?.name).toBe(name))
}
async function openNotebookMenu() {
  const trigger = dom.container.querySelector<HTMLElement>('[aria-label="Switch notebook"]')!
  expect(trigger).not.toBeNull()
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Choose notebook"]')).not.toBeNull())
}
async function openNotebookCreation() {
  await openNotebookMenu()
  await act(async () => document.querySelector<HTMLElement>('[aria-label="New notebook"]')!.click())
}
async function switchNotebook(name: string) {
  await openNotebookMenu()
  await act(async () => document.querySelector<HTMLElement>(`[aria-label="Switch to notebook: ${name}"]`)!.click())
}

async function startNotebookWithPage() {
  await createNotebook()
  await vi.waitFor(() => expect(useAppStore.getState().recallNotebookId).not.toBeNull())
  await dom.click('.notebook-create-page')
}









async function renameNotebookField(label: string, value: string) {
  const field = dom.container.querySelector<HTMLInputElement>(`.global-recall-surface [aria-label="${label}"]`)!
  await act(async () => field.focus()); await fill(field, value)
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
}
async function chooseNotebookSelect(label: string, value: string) {
  const field = dom.container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!
  expect(field).not.toBeNull(); await act(async () => { field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })) })
}











async function archiveCurrentNotebookPage() {
  const trigger = dom.container.querySelector<HTMLElement>('[aria-label="Page options"]')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await vi.waitFor(() => expect([...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent === 'Archive page')).toBe(true))
  const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Archive page')!
  await act(async () => action.click())
}






async function requestDeleteNotebook() { await dom.click('[aria-label="Delete notebook"]'); await vi.waitFor(() => expect(document.querySelector('.confirmation-dialog')).not.toBeNull()) }
async function confirmDeleteNotebook() { await act(async () => document.querySelector<HTMLButtonElement>('.confirmation-dialog [data-confirm-label]')!.click()) }

it('defaults only first Recall entry and keeps the current Notebook tree through product switching', async () => {
  await renderApp(); await enterSurvey()
  await vi.waitFor(() => expect(useAppStore.getState().recallNotebookId).toBe('quick-notes'))
  expect(dom.container.querySelector('.recall-start')).toBeNull()
  await createNotebook('First current book')
  const first = useAppStore.getState().recallNotebookId
  await createNotebook('Second current book')
  await switchNotebook('First current book')
  expect(useAppStore.getState().recallNotebookId).toBe(first)
  expect(dom.container.querySelector('.survey-notebook-navigation')?.getAttribute('data-notebook-id')).toBe(first)
  expect(dom.container.querySelector('.survey-notebook-navigation')?.textContent).not.toContain('Second current book')
  expect(dom.container.querySelector('[aria-label="Switch notebook"]')?.textContent).toContain('First current book')
  expect(dom.container.querySelector('[aria-label="Back to Recall"]')).toBeNull(); healthy()
})

it('closes the Notebook portal after a public surface switch and keeps later Survey input focused', async () => {
  await renderApp(); await dom.click('[aria-label="Survey: browse and explore"]'); await enterSurvey(); await openNotebookMenu()
  const original = useAppStore.getState(), tabs = original.tabs, bookId = original.recallNotebookId
  const hiddenTriggerFocus = vi.spyOn(dom.container.querySelector<HTMLButtonElement>('[aria-label="Switch notebook"]')!, 'focus')
  const later = dom.container.querySelector<HTMLInputElement>('.global-survey-surface [aria-label="Search or enter a web address"]')!
  expect(later).not.toBeNull()
  await act(async () => {
    await original.executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'notebook-menu-hide', operation: 'focus', target: { kind: 'surface', surface: 'survey' }, inputPolicy: 'preserve' }))
    flushSync(() => {})
    expect(document.querySelector('[aria-label="Choose notebook"]')).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(hiddenTriggerFocus).not.toHaveBeenCalled()
    later.focus(); await new Promise(resolve => setTimeout(resolve, 10))
  })
  expect(document.querySelector('[aria-label="Choose notebook"]')).toBeNull()
  expect(document.activeElement).toBe(later)
  expect(useAppStore.getState().tabs).toBe(tabs)
  expect(useAppStore.getState().recallNotebookId).toBe(bookId)
  await enterSurvey()
  expect(document.querySelector('[aria-label="Choose notebook"]')).toBeNull(); healthy()
})

it('closes the Notebook portal when its sidebar collapses without restoring it or stealing later focus', async () => {
  await renderApp(); await enterSurvey(); await openNotebookMenu()
  const hiddenTriggerFocus = vi.spyOn(dom.container.querySelector<HTMLButtonElement>('[aria-label="Switch notebook"]')!, 'focus')
  let later!: HTMLButtonElement
  await act(async () => {
    flushSync(() => useAppStore.getState().setRecallSidebarCollapsed(true))
    expect(document.querySelector('[aria-label="Choose notebook"]')).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(hiddenTriggerFocus).not.toHaveBeenCalled()
    later = dom.container.querySelector<HTMLButtonElement>('[aria-label="Show Recall items"]')!
    later.focus(); await new Promise(resolve => setTimeout(resolve, 10))
  })
  expect(document.querySelector('[aria-label="Choose notebook"]')).toBeNull()
  expect(document.activeElement).toBe(later)
  await act(async () => useAppStore.getState().setRecallSidebarCollapsed(false))
  expect(document.querySelector('[aria-label="Choose notebook"]')).toBeNull(); healthy()
})

it('keeps a restored unavailable Notebook and its original workface instead of replacing it with the default', async () => {
  const selection = { zoneId: originalZoneId(), selection: [referenceA], active: referenceA }
  useAppStore.setState({ recallNotebookId: 'original-unavailable-book', recallNoteId: 'original-unavailable-note', recallZoneSelection: selection })
  const before = useAppStore.getState()
  await renderApp(); await enterSurvey()
  expect(useAppStore.getState().recallNotebookId).toBe('original-unavailable-book')
  expect(useAppStore.getState().recallNoteId).toBe('original-unavailable-note')
  expect(useAppStore.getState().recallZoneSelection).toBe(selection)
  expect(dom.container.querySelector('.survey-notebook-navigation')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Recall items"]')?.textContent).toContain('Original Notebook selection kept')
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().documents[key]?.content).toBe('Unsaved file'); healthy()
})

it('creates and switches Notebooks then reopens the exact original Note through durable Notebook and file owners', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-recall-navigation-')))
  try {
    const path = join(root, 'notes'); await mkdir(path)
    const notesWorkspace = { ...scratchWorkspace, path }
    useAppStore.setState({ config: { ...useAppStore.getState().config!, workspaces: useAppStore.getState().config!.workspaces.map(item => item.id === NOTES_WORKSPACE_ID ? notesWorkspace : item) } })
    const notebooks = new AgentMuxNotebookStore(join(path, 'notebooks.json'))
    const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }))
    vi.spyOn(api.notebooks, 'read').mockImplementation(() => notebooks.read())
    vi.spyOn(api.notebooks, 'apply').mockImplementation(input => notebooks.apply(input, { kind: 'user', id: 'navigation-user' }))
    vi.spyOn(api.notebooks, 'onChange').mockImplementation(listener => notebooks.subscribe(listener))
    vi.spyOn(api.files, 'read').mockImplementation((id, filePath) => { expect(id).toBe(NOTES_WORKSPACE_ID); return files.read(notesWorkspace, filePath) })
    vi.spyOn(api.files, 'write').mockImplementation((id, input) => { expect(id).toBe(NOTES_WORKSPACE_ID); return files.write(notesWorkspace, input) })
    await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
    const original = useAppStore.getState(), bookId = original.recallNotebookId!, noteId = original.recallNoteId!
    const catalog = await notebooks.read(), page = catalog.pages[noteId]!, bytes = await readFile(join(path, page.resource.path), 'utf8')
    const reference = original.recallZoneSelection!.active!, originalZone = page.workface!.zoneId
    expect(JSON.parse(bytes).noteId).toBe(noteId)
    await createNotebook('Other book')
    expect(dom.container.querySelector('.survey-notebook-pages')?.textContent).not.toContain(page.title)
    await switchNotebook('Research notebook')
    expect(useAppStore.getState().recallNotebookId).toBe(bookId)
    await dom.click('.survey-notebook-page')
    await vi.waitFor(() => expect(useAppStore.getState().recallZoneSelection?.active).toEqual(reference))
    expect(useAppStore.getState().recallNoteId).toBe(noteId)
    expect(useAppStore.getState().recallZoneSelection?.zoneId).toBe(originalZone)
    expect(useAppStore.getState().tabs[reference.tabId]?.regions[reference.regionId]).toMatchObject({ kind: 'file', workspaceId: NOTES_WORKSPACE_ID, path: page.resource.path })
    expect(await readFile(join(path, page.resource.path), 'utf8')).toBe(bytes)
    expect((await notebooks.read()).pages[noteId]).toEqual(page)
    expect(api.files.write).toHaveBeenCalledTimes(1)
    expect(api.files.read).toHaveBeenCalledWith(NOTES_WORKSPACE_ID, page.resource.path)
    expect(useAppStore.getState().documents[key]?.content).toBe('Unsaved file'); healthy()
  } finally { await rm(root, { recursive: true, force: true }) }
})



it('creates a Notebook first and adds its Note page in the original Zone without a Browser or spare preparation Tab', async () => {
  const writes = new Map<string, string>()
  vi.spyOn(api.files, 'write').mockImplementation(async (_workspace, input) => { writes.set(input.path, input.content); return { status: 'written', revision: 'note-created' } })
  vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, content: writes.get(path)!, revision: 'note-created' } }))
  await renderApp(); await enterSurvey()
  await vi.waitFor(() => expect(useAppStore.getState().recallNotebookId).toBe('quick-notes'))
  expect(dom.container.querySelector('[aria-label="Switch notebook"]')!.textContent).toContain('随手记')
  expect(dom.container.querySelector('[aria-label="Back to Recall"]')).toBeNull()
  const before = useAppStore.getState()
  expect(before.layouts[NOTES_WORKSPACE_ID]).toBeUndefined()
  await startNotebookWithPage()
  await vi.waitFor(() => expect(useAppStore.getState().recallZoneSelection?.active).toEqual(expect.objectContaining({ tabId: expect.any(String), regionId: expect.any(String) })))
  const current = useAppStore.getState(), selected = current.recallZoneSelection!, ref = selected.active!
  expect(selected.zoneId).not.toBe(originalZoneId())
  expect(current.tabs[ref.tabId]!.space?.zoneId).toBe(selected.zoneId)
  expect(current.tabs[ref.tabId]!.regions[ref.regionId]).toMatchObject({ kind: 'file', workspaceId: NOTES_WORKSPACE_ID })
  expect(current.layouts[NOTES_WORKSPACE_ID]?.groups.some(group => group.tabOrder.includes(ref.tabId))).toBe(true)
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
  const prepared = useAppStore.getState(), zoneId = savedNotes().at(-1)!.target.zoneId!
  expect(zoneId).toBeDefined(); expect(api.files.write).toHaveBeenCalledTimes(1)
  const recover = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Recover same note')!
  expect(recover).not.toBeNull(); await act(async () => recover.click())
  await vi.waitFor(() => expect(useAppStore.getState().recallZoneSelection?.zoneId).toBe(zoneId))
  expect(api.files.write).toHaveBeenCalledTimes(1); expect(api.browser.create).not.toHaveBeenCalled()
  expect(Object.values(useAppStore.getState().tabs).filter(tab => tab.space?.zoneId === zoneId)).toHaveLength(1); healthy()
})

it('recovers the original new exploration when Launcher preparation is unavailable', async () => {
  const create = vi.spyOn(useAppStore.getState(), 'createWorkbenchZone')
  const open = vi.spyOn(useAppStore.getState(), 'openLauncher').mockReturnValueOnce(undefined)
  const writes = new Map<string, string>()
  vi.spyOn(api.files, 'write').mockImplementation(async (_workspace, input) => { writes.set(input.path, input.content); return { status: 'written', revision: 'new' } })
  vi.spyOn(api.files, 'read').mockImplementation(async (_workspace, path) => ({ status: 'read', document: { path, content: writes.get(path)!, revision: 'new' } }))
  await renderApp(); await enterSurvey(); await startNotebookWithPage()
  await vi.waitFor(() => expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('original page location is restoring'))
  const zoneIds = [useNotebookLibrary.getState().state!.notebooks[useAppStore.getState().recallNotebookId!]!.workface!.zoneId]
  expect(zoneIds).toHaveLength(1); expect(create).toHaveBeenCalledTimes(1); expect(api.files.write).not.toHaveBeenCalled()
  const recover = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Recover same note')!
  expect(recover).not.toBeNull(); await act(async () => recover.click())
  await vi.waitFor(() => expect(useAppStore.getState().recallZoneSelection?.zoneId).toBe(zoneIds[0]))
  expect(create).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledTimes(2); expect(api.files.write).toHaveBeenCalledTimes(1); healthy()
})

it('inherits the selected Notebook through the real generic Launcher Note action', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  const state = useAppStore.getState(), bookId = state.recallNotebookId!, page = Object.values((await api.notebooks.read()).pages)[0]!
  const workspaceId = page.resource.workspaceId, groupId = state.layouts[workspaceId]!.activeGroupId
  const tabId = state.openLauncher({ workspaceId, displayWorkspaceId: workspaceId, tabGroupId: groupId, zoneId: page.workface!.zoneId, reveal: false })!
  const tab = useAppStore.getState().tabs[tabId]!, reference = { tabId, regionId: tab.layout.activeRegionId }
  await act(async () => { state.setRecallNotebook(bookId); state.setRecallZoneSelection({ zoneId: page.workface!.zoneId, selection: [reference], active: reference }) })
  await vi.waitFor(() => expect(dom.container.querySelector('.global-recall-surface [aria-label="Create blank note"]')).not.toBeNull())
  await dom.click('.global-recall-surface [aria-label="Create blank note"]')
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

it('keeps every existing Note Region on an ambiguous directory reopen rather than creating another Tab', async () => {
  const files = new Map<string, string>()
  vi.spyOn(api.files, 'write').mockImplementation(async (_id, input) => { files.set(input.path, input.content); return { status: 'written', revision: 'same-note' } })
  vi.spyOn(api.files, 'read').mockImplementation(async (_id, path) => ({ status: 'read', document: { path, content: files.get(path)!, revision: 'same-note' } }))
  await renderApp(); await enterSurvey(); await startNotebookWithPage()
  const state = useAppStore.getState(), page = Object.values((await api.notebooks.read()).pages)[0]!
  const selected = state.recallZoneSelection!.active!, tab = state.tabs[selected.tabId]!, region = tab.regions[selected.regionId]!
  const duplicated = addWorkbenchRegion(tab, selected.regionId, 'right', { ...region, regionId: 'second-note-location' })
  await act(async () => useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: duplicated } }))
  await dom.click(`[aria-label="Notebook directory: ${(await api.notebooks.read()).notebooks[page.notebookId]!.name}"]`)
  const originalTabs = useAppStore.getState().tabs, catalog = await api.notebooks.read()
  await dom.click('.survey-notebook-page')
  await vi.waitFor(() => expect(dom.container.querySelector('.survey-error')?.textContent).toContain('already open in multiple locations'))
  expect(useAppStore.getState().tabs).toEqual(originalTabs)
  expect(await api.notebooks.read()).toEqual(catalog)
  expect(api.files.write).toHaveBeenCalledTimes(1)
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('.global-recall-surface .note-editor .ProseMirror')).not.toBeNull() })
  const secondRegion = dom.container.querySelector<HTMLElement>('.global-recall-surface [data-workbench-region-id="second-note-location"]')!
  expect(secondRegion).not.toBeNull()
  await act(async () => secondRegion.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  await dom.click('.survey-notebook-page')
  await vi.waitFor(() => expect(dom.container.querySelector('.survey-error')).toBeNull())
  expect(useAppStore.getState().recallZoneSelection?.active).toEqual({ tabId: tab.id, regionId: 'second-note-location' })
  expect(useAppStore.getState().tabs).toEqual(originalTabs)
  expect(api.browser.close).not.toHaveBeenCalled(); healthy()
})

it('requires a name and deliberate submission to create a Notebook and cancels without any persistent side effect', async () => {
  const write = vi.spyOn(api.files, 'write')
  await renderApp(); await enterSurvey()
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Switch notebook"]')?.textContent).toContain('随手记'))
  const original = await api.notebooks.read()
  await openNotebookCreation()
  expect(await api.notebooks.read()).toEqual(original)
  const form = document.querySelector<HTMLFormElement>('[aria-label="Create notebook"]')!
  expect(form.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true)
  await fill(document.querySelector<HTMLInputElement>('[aria-label="New notebook name"]')!, 'Cancelled draft')
  await act(async () => [...form.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.click())
  expect(await api.notebooks.read()).toEqual(original)
  await createNotebook('Reading notes')
  await vi.waitFor(() => expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Notebook name"]')?.value).toBe('Reading notes'))
  expect(useAppStore.getState().recallZoneSelection).toBeNull()
  expect(Object.values((await api.notebooks.read()).pages)).toHaveLength(0)
  expect(write).not.toHaveBeenCalled(); expect(api.browser.create).not.toHaveBeenCalled()
  healthy()
})

it('organizes a real Notebook wiki tree through rename, subpage creation, search and subtree move without copying Note blocks', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey()
  await createNotebook()
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Notebook name"]')).not.toBeNull())
  const bookId = useAppStore.getState().recallNotebookId!
  await renameNotebookField('Notebook name', 'Research wiki')
  await vi.waitFor(async () => expect((await api.notebooks.read()).notebooks[bookId]!.name).toBe('Research wiki'))
  await dom.click('.notebook-create-page'); await readyNoteRegion()
  await renameNotebookField('Page title', 'A research question')
  await vi.waitFor(async () => expect(Object.values((await api.notebooks.read()).pages)[0]!.title).toBe('A research question'))
  const parent = Object.values((await api.notebooks.read()).pages)[0]!, before = files.get(parent.resource.path)!
  await dom.click('[aria-label="Add subpage to A research question"]')
  await vi.waitFor(async () => expect(Object.values((await api.notebooks.read()).pages).some(page => page.parentNoteId === parent.noteId)).toBe(true))
  const child = Object.values((await api.notebooks.read()).pages).find(page => page.parentNoteId === parent.noteId)!
  await vi.waitFor(async () => { await act(async () => {}); expect(useAppStore.getState().recallNoteId).toBe(child.noteId); expect(dom.container.querySelector<HTMLInputElement>('.global-recall-surface [aria-label="Page title"]')?.value, JSON.stringify({ selected: useAppStore.getState().recallZoneSelection, projected: observation.recall.at(-1)?.projection, titles: [...dom.container.querySelectorAll<HTMLInputElement>('.global-recall-surface [aria-label="Page title"]')].map(n => ({ value: n.value, region: n.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id'), slot: n.closest('.workbench-tab-slot')?.id })) }, (key, value) => key === 'catalog' ? undefined : value)).toBe(child.title) }); await renameNotebookField('Page title', 'Evidence and findings')
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
  await vi.waitFor(() => expect(dom.container.querySelector<HTMLInputElement>('.global-recall-surface [aria-label="Page title"]')?.value).toBe('A research question'))
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

it('keeps an open standalone Notebook page and every exact foreign Group selected after the original File owner changes its Tab ID', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey(); await createNotebook()
  await dom.click('.notebook-create-page'); const raw = await readyNoteRegion()
  const page = Object.values((await api.notebooks.read()).pages)[0]!, bytes = files.get(page.resource.path)!
  const location = observation.recall.at(-1)!.selection!.active!
  await act(async () => useAppStore.setState({config:{...useAppStore.getState().config!,workspaces:[...useAppStore.getState().config!.workspaces,otherWorkspace]},layouts:{...useAppStore.getState().layouts,[otherWorkspace.id]:createWorkspaceLayout('foreign-note-group',[raw.tabId])}}))
  const selection = useAppStore.getState().recallZoneSelection!
  await act(async () => useAppStore.getState().setRecallZoneSelection({...selection,active:{...selection.active!}}))
  vi.spyOn(api.files,'move').mockImplementation(async input=>{files.set(input.destination.path,files.get(input.source.path)!);files.delete(input.source.path);return {status:'moved'}})
  await act(async () => useAppStore.getState().renamePath(page.resource.path,'Standalone renamed.note.json',page.resource.workspaceId))
  const state = useAppStore.getState(), selected = state.recallZoneSelection!.active!
  expect(selected.tabId).not.toBe(raw.tabId); expect(selected.regionId).toBe(raw.regionId)
  expect(state.tabs[selected.tabId]!.regions[selected.regionId]).toMatchObject({kind:'file',path:'Standalone renamed.note.json'})
  expect(state.layouts[otherWorkspace.id]!.groups[0]!.activeTabId).toBe(selected.tabId)
  expect(state.layouts[otherWorkspace.id]!.groups[0]!.tabOrder).toEqual([selected.tabId])
  expect(observation.recall.at(-1)!.projection!.entity).toEqual({kind:'region',regionId:raw.regionId})
  expect(observation.recall.at(-1)!.selection!.active).toMatchObject({displayWorkspaceId:location.displayWorkspaceId,groupId:location.groupId,tabId:selected.tabId,regionId:raw.regionId})
  expect(dom.container.querySelector('.global-recall-surface .note-editor .ProseMirror')).not.toBeNull()
  expect(files.get('Standalone renamed.note.json')).toBe(bytes);expect(JSON.parse(bytes).noteId).toBe(page.noteId); healthy()
})

it('archives from the actual page menu and reopens and restores the original Note through its archived directory', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  await renameNotebookField('Page title', 'A thought worth keeping')
  const state = useAppStore.getState(), bookId = state.recallNotebookId!, noteId = state.recallNoteId!, reference = state.recallZoneSelection!.active!
  const editor = dom.container.querySelector('.global-recall-surface .note-editor'), body = [...files.values()][0], writeCount = vi.mocked(api.files.write).mock.calls.length
  await archiveCurrentNotebookPage()
  await vi.waitFor(() => expect(useNotebookLibrary.getState().state?.pages[noteId]?.archivedAt).toBeTypeOf('number'))
  await vi.waitFor(() => expect(dom.container.querySelector('.survey-notebook-navigation [aria-label="Archived pages"]')?.getAttribute('aria-pressed')).toBe('true'))
  expect(dom.container.querySelector('.global-recall-surface .note-editor')).toBe(editor)
  expect(dom.container.querySelector('.notebook-archive-status')?.textContent).toContain('Archived')
  await dom.click(`[aria-label="Notebook directory: Research notebook"]`)
  const pagesToggle = [...dom.container.querySelectorAll<HTMLButtonElement>('.survey-notebook-navigation .notebook-directory-views button')].find(button => button.textContent === 'Pages')!
  await act(async () => pagesToggle.click())
  expect(dom.container.querySelector('.survey-notebook-page')).toBeNull()
  expect(dom.container.querySelector('.survey-notebook-navigation')?.textContent).toContain('No pages yet')
  await dom.click('.survey-notebook-navigation [aria-label="Archived pages"]')
  expect(dom.container.querySelector('.survey-notebook-page')?.textContent).toBe('A thought worth keeping')
  await dom.click('.survey-notebook-page')
  await vi.waitFor(() => expect(useAppStore.getState().recallZoneSelection!.active).toEqual(reference))
  await dom.click('.notebook-archive-status button')
  await vi.waitFor(() => expect(useNotebookLibrary.getState().state?.pages[noteId]?.archivedAt).toBeUndefined())
  expect(useAppStore.getState().recallNotebookId).toBe(bookId)
  expect(useAppStore.getState().recallNoteId).toBe(noteId)
  expect([...files.values()][0]).toBe(body); expect(vi.mocked(api.files.write).mock.calls).toHaveLength(writeCount)
  expect((await api.notebooks.read()).trail.filter(event => ['archived', 'restored'].includes(event.action)).map(event => event.action)).toEqual(['archived', 'restored'])
  expect(api.browser.close).not.toHaveBeenCalled(); healthy()
})

it('keeps the original editor and active directory after an archive reply is lost and retries one exact operation', async () => {
  noteTransport(); await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  const noteId = useAppStore.getState().recallNoteId!, editor = dom.container.querySelector('.global-recall-surface .note-editor')
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
  expect(dom.container.querySelector('.global-recall-surface .note-editor')).toBe(editor)
  await dom.click('.notebook-change-issue button')
  await vi.waitFor(() => expect(useNotebookLibrary.getState().state?.pages[noteId]?.archivedAt).toBeTypeOf('number'))
  expect(inputs).toHaveLength(2); expect(inputs[1]!.operationId).toBe(inputs[0]!.operationId)
  expect((await api.notebooks.read()).trail.filter(event => event.action === 'archived')).toHaveLength(1)
  expect(dom.container.querySelector('.global-recall-surface .note-editor')).toBe(editor); healthy()
})

it('keeps a separately archived child when restoring its parent and finds it through the collapsed Notebook home', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  await renameNotebookField('Page title', 'Original question')
  const parent = Object.values((await api.notebooks.read()).pages)[0]!
  await dom.click('[aria-label="Add subpage to Original question"]')
  await vi.waitFor(async () => expect(Object.values((await api.notebooks.read()).pages).some(page => page.parentNoteId === parent.noteId)).toBe(true))
  const child = Object.values((await api.notebooks.read()).pages).find(page => page.parentNoteId === parent.noteId)!
  await vi.waitFor(() => expect(useAppStore.getState().recallNoteId).toBe(child.noteId))
  await renameNotebookField('Page title', 'Independent evidence')
  await archiveCurrentNotebookPage()
  await vi.waitFor(() => expect(useNotebookLibrary.getState().state?.pages[child.noteId]?.archivedAt).toBeTypeOf('number'))
  const pagesButton = [...dom.container.querySelectorAll<HTMLButtonElement>('.survey-notebook-navigation .notebook-directory-views button')].find(button => button.textContent === 'Pages')!
  await act(async () => pagesButton.click())
  expect(dom.container.querySelectorAll('.survey-notebook-page')).toHaveLength(1)
  await dom.click('.survey-notebook-page')
  await vi.waitFor(() => expect(useAppStore.getState().recallNoteId).toBe(parent.noteId))
  await archiveCurrentNotebookPage()
  await vi.waitFor(() => expect(useNotebookLibrary.getState().state?.pages[parent.noteId]?.archivedAt).toBeTypeOf('number'))
  expect(dom.container.querySelectorAll('.survey-notebook-page')).toHaveLength(2)
  await dom.click('.notebook-archive-status button')
  await vi.waitFor(() => expect(useNotebookLibrary.getState().state?.pages[parent.noteId]?.archivedAt).toBeUndefined())
  expect(useNotebookLibrary.getState().state?.pages[child.noteId]?.archivedAt).toBeTypeOf('number')
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.survey-notebook-page')).toHaveLength(1))
  await dom.click('[aria-label="Hide Recall items"]')
  await dom.click('[aria-label="Show notebook directory"]')
  await vi.waitFor(() => expect(dom.container.querySelector('.survey-notebook-home')).not.toBeNull())
  await dom.click('.survey-notebook-home [aria-label="Archived pages"]')
  expect(dom.container.querySelector('.notebook-page-directory')?.textContent).toContain('Independent evidence')
  expect(dom.container.querySelector('.notebook-page-directory')?.textContent).not.toContain('Original question')
  expect((await api.notebooks.read()).pages[child.noteId]?.parentNoteId).toBe(parent.noteId)
  expect(files.size).toBe(2); expect(api.browser.close).not.toHaveBeenCalled(); healthy()
})

it('deletes the selected Notebook only after confirmation and retains the original open Note, archived child and hierarchy in 随手记', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  await renameNotebookField('Page title', 'Original question')
  const parent = Object.values((await api.notebooks.read()).pages)[0]!, bookId = parent.notebookId
  await dom.click('[aria-label="Add subpage to Original question"]'); await readyNoteRegion()
  const child = Object.values((await api.notebooks.read()).pages).find(page => page.parentNoteId === parent.noteId)!
  await archiveCurrentNotebookPage()
  const original = await api.notebooks.read(), body = new Map(files), writes = vi.mocked(api.files.write).mock.calls.length
  const editor = dom.container.querySelector('.global-recall-surface .note-editor .ProseMirror')!
  expect(editor).not.toBeNull()
  const selected = useAppStore.getState().recallZoneSelection
  await requestDeleteNotebook()
  expect(document.querySelector('.confirmation-dialog')?.textContent).toContain('2 pages will move to 随手记')
  await act(async () => document.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')!.click())
  expect(await api.notebooks.read()).toEqual(original)
  await requestDeleteNotebook(); await confirmDeleteNotebook()
  await vi.waitFor(async () => expect((await api.notebooks.read()).notebooks[bookId]).toBeUndefined())
  await vi.waitFor(() => expect(useAppStore.getState().recallNotebookId).toBe('quick-notes'))
  const final = await api.notebooks.read()
  expect(final.pages[parent.noteId]).toMatchObject({ notebookId: 'quick-notes', resource: parent.resource, parentNoteId: null })
  expect(final.pages[child.noteId]).toMatchObject({ notebookId: 'quick-notes', resource: child.resource, parentNoteId: parent.noteId, archivedAt: original.pages[child.noteId]!.archivedAt })
  expect(files).toEqual(body); expect(api.files.write).toHaveBeenCalledTimes(writes)
  expect(useAppStore.getState().recallZoneSelection).toEqual(selected)
  expect(dom.container.querySelector('.global-recall-surface .note-editor .ProseMirror')).toBe(editor)
  expect(dom.container.querySelector('[aria-label="Archived pages"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(dom.container.querySelector('.survey-notebook-page')?.textContent).toBe(child.title)
  expect(final.trail.filter(event => event.operationId === final.trail.at(-1)!.operationId)).toHaveLength(2)
  await dom.click('[aria-label="Page history"]')
  expect(dom.container.querySelector('[aria-label="Note history"]')?.textContent).toContain('Research notebook / Original question → 随手记 / Original question')
  expect(api.browser.close).not.toHaveBeenCalled(); healthy()
})

it('reconciles the same Notebook deletion after a lost reply without removing later navigation', async () => {
  noteTransport(); await renderApp(); await enterSurvey(); await createNotebook('Disposable book')
  const id = useAppStore.getState().recallNotebookId!, original = vi.mocked(api.notebooks.apply).getMockImplementation()!
  vi.mocked(api.notebooks.apply).mockImplementationOnce(async input => { await original(input); throw new Error('Deletion reply lost') })
  await requestDeleteNotebook(); await confirmDeleteNotebook()
  await vi.waitFor(() => expect(document.querySelector('.confirmation-dialog [role="status"]')?.textContent).toContain('Deletion reply lost'))
  const first = vi.mocked(api.notebooks.apply).mock.calls.at(-1)![0]
  expect(first.change).toEqual({ kind: 'delete', notebookId: id })
  await act(async () => document.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')!.click())
  expect(dom.container.querySelector('.notebook-change-issue')?.textContent).toContain('Disposable book')
  const { changeNotebook } = await import('../src/renderer/src/lib/notebook-library')
  await act(async () => { await changeNotebook({ kind: 'create', notebookId: 'later-book', name: 'Later choice' }, 'later-book-create'); useAppStore.getState().setRecallNotebook('later-book') })
  await dom.click('[aria-label="Hide Recall items"]')
  await dom.click('[aria-label="Check notebook deletion"]')
  expect(document.querySelector('.confirmation-dialog__subject')?.textContent).toBe('Disposable book')
  await confirmDeleteNotebook()
  await vi.waitFor(() => expect(document.querySelector('.confirmation-dialog')).toBeNull())
  expect(vi.mocked(api.notebooks.apply).mock.calls.at(-1)![0].operationId).toBe(first.operationId)
  expect(useAppStore.getState().recallNotebookId).toBe('later-book')
  expect((await api.notebooks.read()).notebooks[id]).toBeUndefined(); healthy()
})

it('keeps one exact named creation after a lost reply and does not navigate over a later Notebook choice', async () => {
  await renderApp(); await enterSurvey()
  const original = vi.mocked(api.notebooks.apply).getMockImplementation()!
  vi.mocked(api.notebooks.apply).mockImplementationOnce(async input => { await original(input); throw new Error('Creation reply lost') })
  await openNotebookCreation()
  await fill(document.querySelector<HTMLInputElement>('[aria-label="New notebook name"]')!, 'One exact book')
  await submit(document.querySelector<HTMLFormElement>('[aria-label="Create notebook"]')!)
  await vi.waitFor(() => expect(document.querySelector('.notebook-create-issue')?.textContent).toContain('Creation reply lost'))
  const first = vi.mocked(api.notebooks.apply).mock.calls.at(-1)![0]
  expect(document.querySelector<HTMLInputElement>('[aria-label="New notebook name"]')?.disabled).toBe(true)
  await act(async () => { await changeNotebook({ kind: 'create', notebookId: 'later-created-book', name: 'Later choice' }, 'later-created-book-op'); useAppStore.getState().setRecallNotebook('later-created-book') })
  await submit(document.querySelector<HTMLFormElement>('[aria-label="Create notebook"]')!)
  await vi.waitFor(() => expect(document.querySelector('.notebook-create-dialog')).toBeNull())
  expect(vi.mocked(api.notebooks.apply).mock.calls.at(-1)![0].operationId).toBe(first.operationId)
  expect(Object.values((await api.notebooks.read()).notebooks).filter(book => book.name === 'One exact book')).toHaveLength(1)
  expect(useAppStore.getState().recallNotebookId).toBe('later-created-book'); healthy()
})


it('keeps Browser research and the original Recall page independent through public focus and visible navigation', async () => {
  noteTransport(); await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  const before = useAppStore.getState(), recalled = before.recallZoneSelection!, book = before.recallNotebookId!, note = before.recallNoteId!
  const recalledFile = before.tabs[recalled.active!.tabId]!.regions[recalled.active!.regionId!]
  expect(recalledFile?.kind).toBe('file')
  expect((recalledFile as { workspaceId: string }).workspaceId).toBe(NOTES_WORKSPACE_ID)
  await dom.click('[aria-label="Survey: browse and explore"]')
  expect(dom.container.querySelector('.global-survey-surface .survey-start-input')).not.toBeNull()
  expect(dom.container.querySelector('.global-survey-surface [aria-label="New notebook"]')).toBeNull()
  expect(dom.container.querySelector('.global-survey-surface [aria-label="Add note to research"]')).toBeNull()
  const input = dom.container.querySelector<HTMLInputElement>('.global-survey-surface .survey-start-input input')!
  await fill(input, 'https://example.test/independent'); await submit(input.form!)
  await vi.waitFor(() => expect(useAppStore.getState().surveyZoneSelection?.active).toEqual(expect.objectContaining({tabId:expect.any(String)})))
  const researched = useAppStore.getState().surveyZoneSelection!
  expect(researched.zoneId).not.toBe(recalled.zoneId)
  let pending!: Promise<unknown>
  await act(async () => {
    pending = useAppStore.getState().executeControl(parseAgentMuxControlRequest({schemaVersion:5, requestId:'recall-real-consumer', operation:'focus', target:{kind:'surface',surface:'recall'}, inputPolicy:'preserve'}))
    await Promise.resolve()
  })
  const result = await pending as { operation: string; navigation: { selection: { mainSurface: string } } }
  expect(result.navigation.selection.mainSurface).toBe('recall')
  const { operation, ...body } = result
  expect(parseAgentMuxControlReceipt({schemaVersion:5,requestId:'recall-real-consumer',operation,ok:true,result:body})).toMatchObject({ok:true})
  const current = useAppStore.getState()
  expect(current.recallNotebookId).toBe(book); expect(current.recallNoteId).toBe(note)
  expect(current.recallZoneSelection).toBe(recalled); expect(current.surveyZoneSelection).toBe(researched)
  expect(current.tabs[recalled.active!.tabId]!.regions[recalled.active!.regionId!]).toBe(recalledFile)
  expect(dom.container.querySelector('.global-recall-surface[aria-hidden="false"] .note-editor .ProseMirror')).not.toBeNull()
  await dom.click('[aria-label="Survey: browse and explore"]')
  expect(useAppStore.getState().surveyZoneSelection).toBe(researched)
  expect(dom.container.querySelector('.global-survey-surface [data-native-browser-stage]')).not.toBeNull()
  healthy()
})


it('adds a new managed Note to an old Notebook without changing its original mixed workface or entities', async () => {
  noteTransport()
  const before = useAppStore.getState(), oldFace = {zoneId:originalZoneId(),workspaceId:workspace.id}
  await api.notebooks.apply({expectedRevision:0,operationId:'original-legacy-book',change:{kind:'create',notebookId:'legacy-book',name:'Original research',workface:oldFace}})
  await renderApp(); await enterSurvey()
  await act(async () => useAppStore.getState().setRecallNotebook('legacy-book'))
  await dom.click('.notebook-create-page'); await readyNoteRegion()
  const library = await api.notebooks.read(), page = Object.values(library.pages).find(page => page.notebookId === 'legacy-book')!
  expect(page.resource.workspaceId).toBe(NOTES_WORKSPACE_ID)
  expect(page.resource.workspacePath).toBe(_hygiene_fixturePath("notes"))
  expect(page.workface?.zoneId).not.toBe(oldFace.zoneId)
  expect(library.notebooks['legacy-book']!.workface).toEqual(oldFace)
  expect(useAppStore.getState().tabs[mixed.id]).toBe(before.tabs[mixed.id])
  expect(useAppStore.getState().layouts[workspace.id]).toBe(before.layouts[workspace.id])
  expect(api.browser.create).not.toHaveBeenCalled(); healthy()
})

it('reopens the original foreign-displayed Note when its hidden resource has no display layout', async () => {
  noteTransport(); await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  const before = useAppStore.getState(), reference = before.recallZoneSelection!.active!, originalTab = before.tabs[reference.tabId]!
  const groupId = before.layouts[workspace.id]!.activeGroupId, notesGroup = before.layouts[NOTES_WORKSPACE_ID]!.activeGroupId
  await act(async () => {
    await useAppStore.getState().setTabDisplayPlacement(reference.tabId, workspace.id, groupId, true)
    await useAppStore.getState().setTabDisplayPlacement(reference.tabId, NOTES_WORKSPACE_ID, notesGroup, false)
    // This is the restored graph with the original foreign occurrence, without an empty
    // display container for a hidden file resource. No resource or entity is invented.
    const layouts = { ...useAppStore.getState().layouts }; delete layouts[NOTES_WORKSPACE_ID]
    useAppStore.setState({ layouts })
  })
  const page = (await api.notebooks.read()).pages[before.recallNoteId!]!
  let opened = false
  await act(async () => { opened = await openNotebookPage(page) })
  expect(opened).toBe(true)
  expect(useAppStore.getState().layouts[NOTES_WORKSPACE_ID]).toBeUndefined()
  expect(useAppStore.getState().tabs[reference.tabId]?.regions[reference.regionId]).toBe(originalTab.regions[reference.regionId])
  expect(useAppStore.getState().layouts[workspace.id]?.groups.find(group => group.id === groupId)?.tabOrder).toContain(reference.tabId)
  expect(useAppStore.getState().recallZoneSelection?.active).toEqual(reference)
  expect(api.files.write).toHaveBeenCalledTimes(1); healthy()
})

it('creates the next page in the same original Notebook Zone after a managed directory move and durable round trip', async () => {
  const files = noteTransport(); await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  const before = useAppStore.getState(), reference = before.recallZoneSelection!.active!, zoneId = before.recallZoneSelection!.zoneId
  const origin = before.tabs[reference.tabId]!.space!, oldResource = before.config!.workspaces.find(item => item.id === NOTES_WORKSPACE_ID)!
  const moves = [{ from: oldResource.path, to: _hygiene_fixturePath("Notes moved with spaces") }]
  await act(async () => {
    const moved = reconcileNotesStorageResources(before, [], moves)
    const config = { ...before.config!, workspaces: before.config!.workspaces.map(item => item.id === NOTES_WORKSPACE_ID ? { ...item, path: moves[0]!.to } : item) }
    const graph = desktopSpatialGraph({ ...moved, config }, [])
    useAppStore.setState({ config, spaceZoneBindings: desktopBindingsFromSpatial(graph) })
  })
  expect(useAppStore.getState().spaceZoneBindings[zoneId]?.spaceId).toBe(origin.spaceId)
  const originalNoteId = before.recallNoteId
  await dom.click('.survey-notebook-new-page')
  await vi.waitFor(() => expect(useAppStore.getState().recallNoteId).not.toBe(originalNoteId))
  await readyNoteRegion()
  expect(catalog().zones.find(zone => zone.zoneId === zoneId)).toMatchObject({ kind: 'directory', directoryPath: moves[0]!.to })
  const created = savedNotes().at(-1)!
  expect(created.target).toMatchObject({ zoneId, sourceSpaceId: origin.spaceId, workspaceId: NOTES_WORKSPACE_ID, directoryPath: moves[0]!.to })
  expect(useAppStore.getState().tabs[reference.tabId]?.space).toEqual(origin)
  expect(useAppStore.getState().recallZoneSelection?.zoneId).toBe(zoneId)
  expect(files.size).toBe(2); expect(Object.keys((await api.notebooks.read()).pages)).toHaveLength(2); healthy()
})
