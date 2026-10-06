import { fixtureEpoch as _tailRefreshFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceLayout } from '@agentmux/layout'
import { emptyNotebookState, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { newNoteDocument } from '../src/shared/note-document'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { GlobalRecallSurface } from '../src/renderer/src/components/GlobalRecallSurface'
import { NoteCanvas } from '../src/renderer/src/components/NoteCanvas'
import { api } from '../src/renderer/src/lib/api'
import { noteCanvasScopeKey } from '../src/renderer/src/lib/note-canvas-state'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM(), scope = { kind: 'note', noteId: 'original-note' } as const
const workspace = { id: 'canvas-original', hostId: 'local', path: join(tmpdir(), 'agentmux-canvas-navigation'), name: 'Original notes', kind: 'folder' as const }
const path = 'original.note.json', docKey = documentKey(workspace.id, path)
const spaceId = directoryIdentity(workspace.hostId, workspace.path), zoneId = homeZoneId(spaceId)
const savedNote = newNoteDocument('Saved original body', scope.noteId, 'exact-original-block')
savedNote.content.content![0]!.content!.push({ type: 'noteLink', attrs: { referenceId: 'self-heading-link', text: 'Original Note #Exact original', target: { noteId: scope.noteId, blockId: 'exact-original-block' } } })
const saved = { path, revision: 'saved-original', content: JSON.stringify(savedNote) }
const draft = { ...saved, content: saved.content.replace('Saved original body', 'Preserved unsaved draft') }
const notebook = { notebookId: 'canvas-book', name: 'Original notebook', createdAt: _tailRefreshFixtureEpoch(0, 0, 1) }
const page: NotebookPage = { noteId: scope.noteId, notebookId: notebook.notebookId, parentNoteId: null, title: 'Original Note', createdAt: _tailRefreshFixtureEpoch(0, 0, 1), updatedAt: _tailRefreshFixtureEpoch(0, 0, 1), sources: [], topics: [],
  resource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path }, workface: { zoneId, workspaceId: workspace.id } }
const initialLibrary = useNotebookLibrary.getState()
beforeEach(() => {
  installNoteCanvasGeometry()
  const catalog = emptyNotebookState(); catalog.notebooks[notebook.notebookId] = notebook; catalog.pages[page.noteId] = page
  useNotebookLibrary.setState({ state: catalog, issue: null })
  const tab = { ...createWorkbenchTab('original-tab', { kind: 'file', regionId: 'original-region', workspaceId: workspace.id, path }), space: { spaceId, zoneId } }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace] }, loading: false, mainSurface: 'recall', activeWorkspaceId: workspace.id,
    recallNotebookId: notebook.notebookId, recallNoteId: null, recallZoneSelection: null, notebookRecoveries: [], recallSidebarCollapsed: false,
    tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [tab.id]) },
    documents: { [docKey]: draft }, dirtyDocuments: { [docKey]: true }, documentRevealTargets: {}, noteCanvasLayouts: {}, noteCanvasSaveIssues: {} })
  vi.spyOn(api.notebooks, 'graph').mockResolvedValue({ catalog, graph: { catalogRevision: catalog.revision, scope: { kind: 'catalog' }, scannedScope: 'catalog', completeness: 'complete', hierarchy: [], references: [], duplicateNoteIds: [],
    observations: [{ noteId: page.noteId, resource: page.resource, status: 'read', actualNoteId: page.noteId, revision: saved.revision, blockIds: ['exact-original-block'] }] } })
  vi.spyOn(api.notebooks, 'content').mockResolvedValue({ noteId: page.noteId, resource: page.resource, status: 'read', actualNoteId: page.noteId, revision: saved.revision, blockIds: ['exact-original-block'], content: saved.content })
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(() => () => {})
  vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: saved })
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
})
afterEach(async () => { await act(async () => useNotebookLibrary.setState(initialLibrary, true)) })

it('forwards a selected saved block through the real Global Recall, NotebookHome and original File consumer without replacing its draft', async () => {
  await dom.render(<GlobalRecallSurface catalog={null} projection={null} selection={null} />)
  await dom.click('[aria-label="Graph view"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-note-id="original-note"].note-canvas-title')).not.toBeNull())
  await dom.click('[aria-label="Read saved body: Original Note"]')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-reader [data-block-id="exact-original-block"]')).not.toBeNull())
  await dom.click('.note-canvas-reader [data-block-id="exact-original-block"]')
  await dom.click('.note-canvas-open-block')
  await vi.waitFor(() => expect(useAppStore.getState().documentRevealTargets[docKey]).toMatchObject({ noteBlock: { noteId: page.noteId, blockId: 'exact-original-block' } }))
  await act(async () => {})
  expect(api.files.read).toHaveBeenCalledWith(workspace.id, path)
  expect(useAppStore.getState().documents[docKey]).toEqual(draft)
  expect(useAppStore.getState().dirtyDocuments[docKey]).toBe(true)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(['original-tab'])
})

it('opens a saved inline target through the original Recall/File navigation while keeping its existing dirty Tab and Region', async () => {
  await dom.render(<GlobalRecallSurface catalog={null} projection={null} selection={null} />)
  await dom.click('[aria-label="Graph view"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-note-id="original-note"].note-canvas-title')).not.toBeNull())
  await dom.click('[aria-label="Read saved body: Original Note"]')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-reader [data-note-inline-link]')).not.toBeNull())
  await dom.click('.note-canvas-reader [data-note-inline-link]')
  await vi.waitFor(() => expect(useAppStore.getState().documentRevealTargets[docKey]).toMatchObject({ noteBlock: { noteId: page.noteId, blockId: 'exact-original-block' } }))
  expect(useAppStore.getState().documents[docKey]).toEqual(draft)
  expect(useAppStore.getState().dirtyDocuments[docKey]).toBe(true)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(['original-tab'])
  expect(Object.keys(useAppStore.getState().tabs['original-tab']!.regions)).toContain('original-region')
})

it('discards a delayed Arrange reply after a later real React Flow keyboard gesture and keeps the completed position', async () => {
  const workers: DelayedWorker[] = []
  class DelayedWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    request: { id: string } | undefined
    terminated = false
    constructor() { workers.push(this) }
    postMessage(input: { id: string }) { this.request = input }
    terminate() { this.terminated = true }
  }
  vi.stubGlobal('Worker', DelayedWorker)
  const key = noteCanvasScopeKey(scope)
  useAppStore.setState({ noteCanvasLayouts: { [key]: { positions: { [page.noteId]: { x: 120, y: 80 } }, viewport: { x: 0, y: 0, zoom: 1 }, expandedNoteIds: [], previewNoteIds: [] } } })
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />)
  await vi.waitFor(() => expect(dom.container.querySelector('.react-flow__node')).not.toBeNull())
  await dom.click('.react-flow__node')
  await dom.click('.note-canvas-tool-text')
  expect(workers).toHaveLength(1)
  const worker = workers[0]!
  await act(async () => dom.container.querySelector<HTMLElement>('.react-flow__node')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
  const manual = useAppStore.getState().noteCanvasLayouts[key]!.positions[page.noteId]
  expect(manual).toBeDefined(); expect(manual).not.toEqual({ x: 120, y: 80 })
  await act(async () => worker.onmessage?.({ data: { id: worker.request!.id, positions: { [page.noteId]: { x: -500, y: -500 } } } } as MessageEvent))
  expect(useAppStore.getState().noteCanvasLayouts[key]!.positions[page.noteId]).toEqual(manual)
  expect(worker.terminated).toBe(true)
  expect(dom.container.querySelector<HTMLElement>('.react-flow__node')!.style.transform).toContain(`${manual!.x}px`)
})
