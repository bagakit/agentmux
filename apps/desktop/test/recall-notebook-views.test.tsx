const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
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
    agentFocus: { execution: { sessionId: session.id, history: [{ sessionId: session.id, focusedAt: _reshape_fixtureEpoch(0, 0, 1) }] }, pmo: { sessionId: null } },
    projectRailOpen: true, toolsOpen: true, workspaceTool: 'agents', demands: {}, browserAnnotationsByBrowserId: {},
    documents: { [key]: { path: file.path, content: 'Unsaved file', revision: 'disk' } }, dirtyDocuments: { [key]: true },
    error: null, lastError: null, errorDismissed: true, displacedAgentSessionIds: [], retainedSpatialFocus: null, regionCaretFocus: null })
  vi.spyOn(api.browser, 'setBounds').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'create').mockImplementation(async (id, url = 'about:blank') => ({ ...browser, id, url }))
  vi.spyOn(api.browser, 'navigate').mockImplementation(async (id, url) => ({ ...browser, id, url, navigationId: `navigation-${id}` }))
  vi.spyOn(api.browser, 'listProfiles').mockResolvedValue([{ id: 'default', label: 'Default', createdAt: _reshape_fixtureEpoch(0, 0, 1), isDefault: true, source: null }])
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










import type { Editor } from '@tiptap/core'
import { NOTE_SCHEMA } from '../src/shared/note-document'

async function withActualNotes(run: (owner: AgentMuxNotebookStore, files: WorkspaceFiles, notesWorkspace: typeof scratchWorkspace) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-recall-views-')))
  try {
    const path = join(root, 'notes'); await mkdir(path)
    const notesWorkspace = { ...scratchWorkspace, path }
    useAppStore.setState({ config: { ...useAppStore.getState().config!, workspaces: useAppStore.getState().config!.workspaces.map(item => item.id === NOTES_WORKSPACE_ID ? notesWorkspace : item) } })
    const notebooks = new AgentMuxNotebookStore(join(path, 'notebooks.json'))
    const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }))
    vi.spyOn(api.notebooks, 'read').mockImplementation(() => notebooks.read())
    vi.spyOn(api.notebooks, 'apply').mockImplementation(input => notebooks.apply(input, { kind: 'user', id: 'views-user' }))
    vi.spyOn(api.notebooks, 'onChange').mockImplementation(listener => notebooks.subscribe(listener))
    vi.spyOn(api.files, 'read').mockImplementation((id, filePath) => { expect(id).toBe(NOTES_WORKSPACE_ID); return files.read(notesWorkspace, filePath) })
    vi.spyOn(api.files, 'write').mockImplementation((id, input) => { expect(id).toBe(NOTES_WORKSPACE_ID); return files.write(notesWorkspace, input) })
    await run(notebooks, files, notesWorkspace)
  } finally { await rm(root, { recursive: true, force: true }) }
}
async function directory() {
  const book = useNotebookLibrary.getState().state!.notebooks[useAppStore.getState().recallNotebookId!]!
  await dom.click(`[aria-label="Notebook directory: ${book.name}"]`)
}
function editor() { return dom.container.querySelector<HTMLElement & { editor: Editor }>('.recall-preserved-workbench:not([hidden]) .note-block-content')!.editor }
function intactOriginalWork() {
  const state = useAppStore.getState()
  expect(state.sessions).toEqual([session]); expect(state.sessions[0]!.control.run.runId).toBe('run-agent-1')
  expect(state.tabs[mixed.id]?.regions[agent.regionId]).toEqual(agent)
  expect(state.documents[key]?.content).toBe('Unsaved file'); expect(state.dirtyDocuments[key]).toBe(true)
  expect(api.sessions.stop).not.toHaveBeenCalled()
}

it('switches real Notebook directory views and reopens the exact original dirty editor without extra file IO', async () => withActualNotes(async (owner, _files, notesWorkspace) => {
  await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  const before = useAppStore.getState(), noteId = before.recallNoteId!, reference = before.recallZoneSelection!.active!, selection = before.recallZoneSelection
  const page = (await owner.read()).pages[noteId]!, originalEditor = editor()
  await act(async () => { originalEditor.commands.insertContent('Keep this unsaved finding'); originalEditor.commands.setTextSelection(5) })
  const draft = useAppStore.getState().documents[documentKey(NOTES_WORKSPACE_ID, page.resource.path)]!, caret = originalEditor.state.selection.toJSON()
  const bytes = await readFile(join(notesWorkspace.path, page.resource.path), 'utf8'), reads = vi.mocked(api.files.read).mock.calls.length, writes = vi.mocked(api.files.write).mock.calls.length
  await directory()
  expect(dom.container.querySelector('[aria-label="Tree view"]')?.getAttribute('aria-selected')).toBe('true')
  const picker = dom.container.querySelector<HTMLElement>('[aria-label="Notebook presentation"]')!
  expect(picker.getAttribute('role')).toBe('tablist')
  const tree = picker.querySelector<HTMLButtonElement>('[aria-label="Tree view"]')!
  await act(async () => { tree.focus(); tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Cards view')
  expect(picker.querySelector('[aria-label="Cards view"]')?.getAttribute('aria-selected'), 'Keyboard changes the actual Notebook presentation').toBe('true')
  expect(picker.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })))
  expect(document.activeElement).toBe(tree)
  expect(tree.getAttribute('aria-selected')).toBe('true')
  await openNotebookMenu()
  const currentNotebook = document.querySelector('[aria-label="Choose notebook"] [role="menuitemradio"][aria-checked="true"]')
  expect(currentNotebook?.getAttribute('aria-label'), 'Notebook selection is available to assistive technology').toBe('Switch to notebook: Research notebook')
  await act(async () => currentNotebook!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Choose notebook"]')).toBeNull())
  await vi.waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Switch notebook'))
  for (const view of ['Cards', 'Graph', 'Tree']) {
    await dom.click(`[aria-label="${view} view"]`)
    expect(useAppStore.getState().recallZoneSelection).toBe(selection)
    expect(useAppStore.getState().recallNoteId).toBe(noteId)
    expect(dom.container.querySelector('.recall-preserved-workbench')?.hasAttribute('hidden')).toBe(true)
    expect(dom.container.querySelector('.recall-preserved-workbench .note-block-content')).toBe(originalEditor.view.dom)
    expect(useAppStore.getState().documents[documentKey(NOTES_WORKSPACE_ID, page.resource.path)]).toBe(draft)
  }
  expect(api.files.read).toHaveBeenCalledTimes(reads); expect(api.files.write).toHaveBeenCalledTimes(writes)
  await dom.click('[aria-label="Cards view"]')
  await dom.click(`.recall-note-card[data-note-id="${noteId}"]`)
  await vi.waitFor(() => expect(dom.container.querySelector('.recall-preserved-workbench')?.hasAttribute('hidden')).toBe(false))
  expect(editor()).toBe(originalEditor); expect(editor().state.selection.toJSON()).toEqual(caret)
  expect(useAppStore.getState().recallZoneSelection?.active).toEqual(reference)
  expect(useAppStore.getState().tabs[reference.tabId]!.regions[reference.regionId]).toMatchObject({ workspaceId: NOTES_WORKSPACE_ID, path: page.resource.path })
  expect(useAppStore.getState().dirtyDocuments[documentKey(NOTES_WORKSPACE_ID, page.resource.path)]).toBe(true)
  expect(await readFile(join(notesWorkspace.path, page.resource.path), 'utf8')).toBe(bytes)
  expect((await owner.read()).pages[noteId]).toEqual(page); intactOriginalWork()
}))

it('shows only current Notebook search and archive scope in cards and graph using the durable catalog', async () => withActualNotes(async owner => {
  await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  const firstBook = useAppStore.getState().recallNotebookId!, firstId = useAppStore.getState().recallNoteId!
  await act(async () => { await changeNotebook({ kind: 'rename-page', noteId: firstId, title: 'Visible parent' }) })
  await dom.click('[aria-label="Add subpage to Visible parent"]'); await vi.waitFor(() => expect(useAppStore.getState().recallNoteId).not.toBe(firstId), { timeout: 5000 }); await readyNoteRegion()
  const childId = useAppStore.getState().recallNoteId!
  await act(async () => { await changeNotebook({ kind: 'rename-page', noteId: childId, title: 'Archived child' }); await changeNotebook({ kind: 'archive', noteId: childId }) })
  await createNotebook('Foreign container'); await dom.click('.notebook-create-page'); await vi.waitFor(() => expect(useAppStore.getState().recallNoteId).not.toBeNull(), { timeout: 5000 }); await readyNoteRegion()
  const foreignId = useAppStore.getState().recallNoteId!
  await switchNotebook('Research notebook')
  expect(useAppStore.getState().recallNotebookId).toBe(firstBook)
  await dom.click('[aria-label="Cards view"]')
  expect([...dom.container.querySelectorAll('.recall-note-card')].map(item => item.getAttribute('data-note-id'))).toEqual([firstId])
  await dom.click('[aria-label="Graph view"]')
  expect([...dom.container.querySelectorAll('.recall-graph-node')].map(item => item.getAttribute('data-note-id'))).toEqual([firstId])
  expect(dom.container.querySelector(`[data-note-id="${foreignId}"]`)).toBeNull()
  await dom.click('.global-recall-surface [aria-label="Archived pages"]')
  expect([...dom.container.querySelectorAll('.recall-graph-node')].map(item => item.getAttribute('data-note-id'))).toEqual([childId])
  await dom.click('[aria-label="Cards view"]')
  expect([...dom.container.querySelectorAll('.recall-note-card')].map(item => item.getAttribute('data-note-id'))).toEqual([childId])
  await fill(dom.container.querySelector<HTMLInputElement>('[aria-label="Find pages in Research notebook"]')!, 'does not exist')
  expect(dom.container.querySelectorAll('.recall-note-card')).toHaveLength(0)
  expect(dom.container.querySelector('.survey-notebook-home')?.textContent).toContain('No matching pages')
  expect(Object.keys((await owner.read()).pages)).toHaveLength(3); intactOriginalWork()
}))

it('distinguishes durable hierarchy from exact confirmed references and keeps unread or ambiguous edges unknown', async () => withActualNotes(async owner => {
  await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  const parentId = useAppStore.getState().recallNoteId!, parentRef = useAppStore.getState().recallZoneSelection!.active!
  await act(async () => { await changeNotebook({ kind: 'rename-page', noteId: parentId, title: 'Parent source' }) })
  await dom.click('[aria-label="Add subpage to Parent source"]'); await vi.waitFor(() => expect(useAppStore.getState().recallNoteId).not.toBe(parentId), { timeout: 5000 }); await readyNoteRegion()
  const childId = useAppStore.getState().recallNoteId!, childRef = useAppStore.getState().recallZoneSelection!.active!
  const child = { schema: NOTE_SCHEMA, noteId: childId, content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'confirmed-target' }, content: [{ type: 'text', text: 'Original target' }] }] } }
  const source = { schema: NOTE_SCHEMA, noteId: parentId, content: { type: 'doc', content: [
    { type: 'blockReference', attrs: { blockId: 'source-block', referenceId: 'confirmed-reference', target: { noteId: childId, blockId: 'confirmed-target' }, mode: 'reference' } },
    { type: 'blockReference', attrs: { blockId: 'unknown-block', referenceId: 'unknown-reference', target: { noteId: 'unread-note', blockId: 'unknown-target' }, mode: 'embed' } }
  ] } }
  await act(async () => { useAppStore.getState().updateDocument(childRef.tabId, JSON.stringify(child), childRef.regionId); useAppStore.getState().updateDocument(parentRef.tabId, JSON.stringify(source), parentRef.regionId) })
  const reads = vi.mocked(api.files.read).mock.calls.length, writes = vi.mocked(api.files.write).mock.calls.length
  await directory(); await dom.click('[aria-label="Graph view"]')
  expect(dom.container.querySelectorAll('[data-edge-kind="hierarchy"]')).toHaveLength(1)
  expect(dom.container.querySelectorAll('[data-edge-kind="reference"]')).toHaveLength(1)
  expect(dom.container.querySelector('[data-edge-kind="reference"]')?.getAttribute('data-edge-from')).toBe(parentId)
  expect(dom.container.querySelector('[data-edge-kind="reference"]')?.getAttribute('data-edge-to')).toBe(childId)
  expect(dom.container.querySelector('.recall-graph-legend')?.textContent).toContain('Confirmed block reference / embed')
  expect(dom.container.querySelector('.recall-graph-coverage')?.textContent).toContain('Partial reference coverage · 2 of 2')
  expect(dom.container.querySelector('.recall-graph-coverage')?.textContent).toContain('1 references have an unread')
  const snapshot = useAppStore.getState(), duplicatePath = 'duplicate.note.json'
  await act(async () => useAppStore.setState({ documents: { ...snapshot.documents, [documentKey(NOTES_WORKSPACE_ID, duplicatePath)]: { path: duplicatePath, content: JSON.stringify(child), revision: 'foreign' } } }))
  expect(dom.container.querySelectorAll('[data-edge-kind="reference"]')).toHaveLength(0)
  expect(dom.container.querySelectorAll('[data-edge-kind="hierarchy"]')).toHaveLength(1)
  expect(dom.container.querySelector('.recall-graph-coverage')?.textContent).toContain('2 references have an unread')
  await act(async () => useAppStore.setState({ documents: snapshot.documents, config: { ...snapshot.config!, workspaces: snapshot.config!.workspaces.map(workspace => workspace.id === NOTES_WORKSPACE_ID ? { ...workspace, hostId: 'foreign-host' } : workspace) } }))
  expect(dom.container.querySelectorAll('[data-edge-kind="reference"]')).toHaveLength(0)
  expect(dom.container.querySelector('.recall-graph-coverage')?.textContent).toContain('Partial reference coverage · 0 of 2')
  await act(async () => useAppStore.setState({ config: snapshot.config }))
  expect(api.files.read).toHaveBeenCalledTimes(reads); expect(api.files.write).toHaveBeenCalledTimes(writes)
  await dom.click(`.recall-graph-node[data-note-id="${childId}"]`)
  await vi.waitFor(() => expect(useAppStore.getState().recallZoneSelection?.active).toEqual(childRef))
  expect(useAppStore.getState().recallNoteId).toBe(childId)
  expect((await owner.read()).pages[childId]!.parentNoteId).toBe(parentId); intactOriginalWork()
}))

it('keeps a later directory view when an earlier page write finishes', async () => withActualNotes(async () => {
  let release!: () => void
  const acknowledgement = new Promise<void>(resolve => { release = resolve })
  const write = vi.mocked(api.files.write).getMockImplementation()!
  vi.mocked(api.files.write).mockImplementation(async (workspaceId, input) => { const result = await write(workspaceId, input); await acknowledgement; return result })
  try {
    await renderApp(); await enterSurvey(); await createNotebook()
    await dom.click('.notebook-create-page')
    await vi.waitFor(() => expect(api.files.write).toHaveBeenCalledTimes(1))
    await directory(); await dom.click('[aria-label="Cards view"]')
    const later = dom.container.querySelector<HTMLButtonElement>('[aria-label="Cards view"]')!
    await act(async () => later.focus())
    release(); await readyNoteRegion()
    expect(dom.container.querySelector('[aria-label="Cards view"]')?.getAttribute('aria-selected')).toBe('true')
    expect(dom.container.querySelector('.recall-preserved-workbench')?.hasAttribute('hidden')).toBe(true)
    expect(document.activeElement).toBe(later)
    expect(savedNotes().at(-1)?.status).toBe('written'); intactOriginalWork()
  } finally { release() }
}))

it('keeps the selected dirty parent editor and caret throughout a delayed canonical read with a child active in the shared layout', async () => withActualNotes(async () => {
  await renderApp(); await enterSurvey(); await startNotebookWithPage(); await readyNoteRegion()
  const parentId = useAppStore.getState().recallNoteId!, parentReference = useAppStore.getState().recallZoneSelection!.active!
  await act(async () => { await changeNotebook({ kind: 'rename-page', noteId: parentId, title: 'Retained parent' }) })
  await dom.click('[aria-label="Add subpage to Retained parent"]')
  await vi.waitFor(() => expect(useAppStore.getState().recallNoteId).not.toBe(parentId), { timeout: 5000 }); await readyNoteRegion()
  const childReference = useAppStore.getState().recallZoneSelection!.active!
  const parentButton = [...dom.container.querySelectorAll<HTMLButtonElement>('.survey-notebook-page')].find(button => button.textContent?.includes('Retained parent'))!
  await act(async () => parentButton.click())
  await vi.waitFor(() => expect(useAppStore.getState().recallZoneSelection?.active).toEqual(parentReference))
  const originalEditor = editor()
  await act(async () => { originalEditor.commands.insertContent('Original unsaved parent selection'); originalEditor.commands.setTextSelection(12) })
  const caret = originalEditor.state.selection.toJSON(), before = useAppStore.getState(), layout = before.layouts[NOTES_WORKSPACE_ID]!
  await act(async () => useAppStore.setState({ layouts: { ...before.layouts, [NOTES_WORKSPACE_ID]: { ...layout, groups: layout.groups.map(group => ({ ...group, activeTabId: group.tabOrder.includes(childReference.tabId) ? childReference.tabId : group.activeTabId })) } } }))
  await directory(); await dom.click('[aria-label="Cards view"]')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), read = vi.mocked(api.files.read).getMockImplementation()!
  const delayed = vi.mocked(api.files.read).mockImplementationOnce(async (workspaceId, path) => { await gate; return read(workspaceId, path) })
  try {
    await dom.click(`.recall-note-card[data-note-id="${parentId}"]`)
    await act(async () => {})
    expect(delayed).toHaveBeenCalled()
    expect(editor()).toBe(originalEditor)
    expect(editor().state.selection.toJSON()).toEqual(caret)
    release()
    await vi.waitFor(() => expect(useAppStore.getState().recallZoneSelection?.active).toEqual(parentReference))
    expect(editor()).toBe(originalEditor); expect(editor().state.selection.toJSON()).toEqual(caret)
    expect(useAppStore.getState().recallNoteId).toBe(parentId); intactOriginalWork()
  } finally { release() }
}))
