// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({ default: () => <textarea aria-label="Original source editor" /> }))
import { GlobalRecallSurface } from '../src/renderer/src/components/GlobalRecallSurface'
import { FileSurfaceView } from '../src/renderer/src/components/FileSurfaceView'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { WorkbenchPresentationContext, type WorkbenchViewTargets } from '../src/renderer/src/lib/workbench-presentation'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { resolveWorkbenchZone, workbenchProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'
import { surveyResolvedZoneSelection } from '../src/renderer/src/lib/survey-workface'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { newNoteDocument } from '../src/shared/note-document'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteFileWriter } from '../src/main/note-file-writer'
import { NotebookObservationOwner } from '../src/main/notebook-observation-owner'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM(), source = newNoteDocument('Original source', 'source', 'source-block')
source.content.content!.push({ type: 'paragraph', attrs: { blockId: 'second-block' }, content: [{ type: 'text', text: 'Second original block' }] })
const surface = { kind: 'file' as const, workspaceId: 'workspace', regionId: 'original-region', path: 'source.note.json' }, tabId = 'original-tab', groupId = 'original-group'
const sourceKey = documentKey(surface.workspaceId, surface.path)
let directory: string, store: AgentMuxNotebookStore, files: WorkspaceFiles
let zoneId: string
beforeEach(async () => {
  installNoteCanvasGeometry()
  directory = await realpath(await mkdtemp(join(tmpdir(), 'amx-graph-entry-')))
  const workspace = { ...composerConfig.workspaces[0]!, path: directory }, birth = directoryIdentity('local', directory)
  zoneId = homeZoneId(birth)
  const tab = createWorkbenchTab(tabId, surface); tab.space = { spaceId: birth, zoneId }
  files = new WorkspaceFiles(() => new LocalExecutionHost())
  store = new AgentMuxNotebookStore(join(directory, 'catalog.json'))
  for (const [id, title, note] of [['source', 'Source original', source], ['target', 'Target original', newNoteDocument('Target body', 'target', 'target-block')]] as const) {
    const path = id + '.note.json'; await writeFile(join(directory, path), JSON.stringify(note))
    await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'register:' + id, change: { kind: 'register', noteId: id, title, resource: { hostId: 'local', workspaceId: workspace.id, workspacePath: directory, path }, workface: { zoneId, workspaceId: workspace.id } } }, { kind: 'user', id: 'entry-test' })
  }
  const read = await files.read(workspace, surface.path); if (read.status !== 'read') throw Error('Original file must read')
  const owner = new NotebookObservationOwner({ files, workspace: () => workspace }), writer = new NoteFileWriter(files, { state: () => store.read(), owner })
  vi.spyOn(api.notebooks, 'read').mockImplementation(() => store.read())
  vi.spyOn(api.notebooks, 'graph').mockImplementation(async (params, options) => { const catalog = await store.read(); return { catalog, graph: await owner.graph(catalog, params, options) } })
  vi.spyOn(api.notebooks, 'content').mockImplementation(async (id, options) => owner.content(await store.read(), id, options))
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(listener => store.subscribe(listener))
  vi.spyOn(api.files, 'read').mockImplementation((_id, path) => files.read(workspace, path))
  vi.spyOn(api.files, 'write').mockImplementation((_id, input) => writer.write(workspace, input, { actor: { kind: 'user', id: 'entry-test' } }))
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  useNotebookLibrary.setState({ state: await store.read(), issue: null })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace] }, sessions: [], mainSurface: 'recall', activeWorkspaceId: workspace.id,
    recallNotebookId: 'quick-notes', recallNoteId: 'source', recallSidebarCollapsed: false, tabs: { [tabId]: tab }, layouts: { [workspace.id]: createWorkspaceLayout(groupId, [tabId]) },
    recallZoneSelection: { zoneId, selection: [{ tabId, regionId: surface.regionId }], active: { tabId, regionId: surface.regionId } }, documents: { [sourceKey]: read.document },
    dirtyDocuments: {}, savingDocuments: {}, documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {}, documentRevealTargets: {}, noteBlockSelections: {}, noteDirectorySources: {}, workspaceFileRevisions: {}, spaceZoneBindings: {}, scratchTopicSnapshots: {}, spatialRequests: {}, notebookRecoveries: [], noteCanvasLayouts: {}, noteCanvasSaveIssues: {}, regionCaretFocus: null, retainedSpatialFocus: null, error: null, lastError: null })
})
afterEach(async () => { await files.dispose(); await rm(directory, { recursive: true, force: true }) })
function Recall({ visible = true }: { visible?: boolean }) {
  const state = useAppStore(), held = state.recallZoneSelection, catalog = spatialCatalog(state, [])
  const projection = held ? resolveWorkbenchZone(held.zoneId, catalog, state.layouts, state.tabs, 'recall-workbench', held.selection, () => {}) : null
  const viewTargets: WorkbenchViewTargets = Object.fromEntries((projection?.selection ?? []).map(reference => [reference.tabId, [{ hostId: workbenchProjectionSlotId('recall-workbench-slot', reference), active: visible, visible, surface: 'recall', projection: projection!, reference, retainedRegionId: reference.regionId }]]))
  return <DesktopClientUiProvider><div hidden><WorkspaceWorkbench workspaceId="workspace" visible={false} viewTargets={viewTargets} /></div><GlobalRecallSurface visible={visible} catalog={catalog} projection={projection} selection={held ? surveyResolvedZoneSelection(held, projection) : null} viewTargets={viewTargets} /></DesktopClientUiProvider>
}
function editor(): Editor { return dom.container.querySelector<HTMLElement & { editor: Editor }>('.note-block-content')!.editor }
async function noteReady() { await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('.note-block-content')).not.toBeNull() }, { timeout: 30_000 }) }
async function graphReady() { await vi.waitFor(() => { const caption = dom.container.querySelector('.note-canvas-caption'); expect(caption).not.toBeNull(); expect(caption!.textContent).toContain('2/2 originals read') }) }

it('opens the current Notebook Graph directly beside an open page and returns to the same dirty original workface', async () => {
  await dom.render(<Recall />); await noteReady()
  expect(api.notebooks.graph).not.toHaveBeenCalled()
  await act(async () => { editor().view.focus(); editor().commands.setTextSelection(editor().state.doc.content.size - 1); editor().commands.insertContent(' Unsaved research') })
  const before = useAppStore.getState(), draft = before.documents[sourceKey], selection = before.recallZoneSelection, tabs = before.tabs, blockSelections = before.noteBlockSelections
  await dom.click('.recall-directory-graph'); await graphReady()
  expect(useAppStore.getState().recallNoteId).toBe('source'); expect(useAppStore.getState().recallNotebookId).toBe('quick-notes')
  expect(useAppStore.getState().recallZoneSelection).toBe(selection); expect(useAppStore.getState().tabs).toBe(tabs)
  expect(useAppStore.getState().documents[sourceKey]).toBe(draft); expect(useAppStore.getState().dirtyDocuments[sourceKey]).toBe(true)
  expect(api.files.write).not.toHaveBeenCalled(); expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  await dom.click('.recall-return-note'); await noteReady()
  expect(editor().getText()).toContain('Unsaved research'); expect(useAppStore.getState().noteBlockSelections).toEqual(blockSelections)
  expect(useAppStore.getState().documents[sourceKey]).toBe(draft)
  await act(async () => useAppStore.setState({ sessions: [] }))
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
})

it('keeps Graph reachable from the collapsed rail without replacing the original Note or directory filters', async () => {
  await dom.render(<Recall />); await noteReady()
  const query = dom.container.querySelector<HTMLInputElement>('input[aria-label="Find pages in 随手记"]')!
  await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(query, 'Source'); query.dispatchEvent(new Event('input', { bubbles: true })) })
  await dom.click('[aria-label="Hide Recall items"]')
  expect(useAppStore.getState().recallSidebarCollapsed).toBe(true)
  await dom.click('.recall-collapsed-graph'); await graphReady()
  expect(dom.container.querySelector('.recall-collapsed-graph')?.getAttribute('aria-pressed')).toBe('true')
  expect(useAppStore.getState().recallNoteId).toBe('source'); expect(query.value).toBe('Source')
  await dom.click('.recall-return-note'); await noteReady()
  expect(useAppStore.getState().recallSidebarCollapsed).toBe(true)
})

it('does not read Graph while the actual Recall surface is hidden', async () => {
  await dom.render(<Recall />); await noteReady(); await dom.click('.recall-directory-graph'); await graphReady()
  const calls = vi.mocked(api.notebooks.graph).mock.calls.length
  await dom.render(<Recall visible={false} />)
  await act(async () => useAppStore.setState({ sessions: [], workspaceFileRevisions: { workspace: 10 } }))
  expect(api.notebooks.graph).toHaveBeenCalledTimes(calls)
})

it('switches Note/Graph in the real File surface without replacing its editor, and saves only from the original Save action', async () => {
  const state = useAppStore.getState(), reference = { displayWorkspaceId: 'workspace', groupId, tabId, regionId: surface.regionId }
  const projection = resolveWorkbenchZone(zoneId, spatialCatalog(state, []), state.layouts, state.tabs, 'recall-workbench', [reference], () => {})!
  await dom.render(<DesktopClientUiProvider><WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, tabHostId: 'entry-file-host', reference, projection }}><FileSurfaceView tabId={tabId} surface={surface} /></WorkbenchPresentationContext.Provider></DesktopClientUiProvider>)
  await noteReady(); const originalEditor = editor(), originalDom = originalEditor.view.dom
  await act(async () => { originalEditor.view.focus(); originalEditor.commands.setTextSelection(originalEditor.state.doc.content.size - 1); originalEditor.commands.insertContent(' Keep this unsaved draft') })
  const draft = useAppStore.getState().documents[sourceKey], caret = originalEditor.state.selection.toJSON()
  await dom.click('[role="tab"][aria-label="Graph view"]'); await graphReady()
  expect(dom.container.querySelector('.note-original-editor')?.hasAttribute('hidden')).toBe(true)
  expect(editor()).toBe(originalEditor); expect(editor().view.dom).toBe(originalDom); expect(editor().state.selection.toJSON()).toEqual(caret)
  expect(dom.container.textContent).toContain('Saved relationships'); expect(dom.container.textContent).toContain('Save your note to update this graph.')
  expect(api.files.write).not.toHaveBeenCalled(); expect(useAppStore.getState().documents[sourceKey]).toBe(draft)
  const save = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Save')!
  expect(save).toBeDefined(); await act(async () => save.click())
  await vi.waitFor(() => expect(useAppStore.getState().dirtyDocuments[sourceKey]).toBe(false))
  expect(api.files.write).toHaveBeenCalledTimes(1); expect(await readFile(join(directory, surface.path), 'utf8')).toContain('Keep this unsaved draft')
  expect(dom.container.textContent).not.toContain('Save your note to update this graph.')
  await dom.click('[role="tab"][aria-label="Note view"]')
  expect(editor()).toBe(originalEditor); expect(editor().getText()).toContain('Keep this unsaved draft'); expect(editor().state.selection.toJSON()).toEqual(caret)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
})
