import { serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
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
import { openNotebookFile } from '../src/renderer/src/lib/recall-notebooks'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM(), scope = { kind: 'note', noteId: 'original-note' } as const
const workspace = { id: 'canvas-original', hostId: 'local', path: join(tmpdir(), 'agentmux-canvas-navigation'), name: 'Original notes', kind: 'folder' as const }
const path = 'original.note.md', docKey = documentKey(workspace.id, path)
const spaceId = directoryIdentity(workspace.hostId, workspace.path), zoneId = homeZoneId(spaceId)
const savedNote = newNoteDocument('Saved original body', scope.noteId, 'exact-original-block')
savedNote.content.content![0]!.content!.push({ type: 'noteLink', attrs: { referenceId: 'self-heading-link', text: 'Original Note #Exact original', target: { noteId: scope.noteId, blockId: 'exact-original-block' } }, content: [{ type: 'text', text: '[[Original Note #Exact original]]' }] })
const saved = { path, revision: 'saved-original', content: serializeNoteDocument(savedNote) }
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
  await dom.click('[aria-label="Full note: Original Note"]')
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
  await dom.click('[aria-label="Full note: Original Note"]')
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
  await dom.click('[aria-label="Arrange notes"]')
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

function unregisteredShared() {
  const note = newNoteDocument('Shared original evidence', 'independent-shared', 'shared-evidence')
  note.kind = 'shared-block'
  note.content.content![0]!.content!.push({ type: 'noteLink', attrs: { referenceId: 'shared-self-link', text: 'Shared evidence', target: { noteId: note.noteId, blockId: 'shared-evidence' } }, content: [{ type: 'text', text: '[[Shared evidence]]' }] })
  const file = { path, revision: 'shared-saved-revision', content: serializeNoteDocument(note) }
  const currentDraft = { ...file, content: file.content.replace('Shared original evidence', 'Unsaved shared edit preserved') }
  const catalog = emptyNotebookState()
  const observation = { noteId: note.noteId, resource: page.resource, status: 'read' as const, actualNoteId: note.noteId, revision: file.revision, kind: 'shared-block' as const, fileIdentity: 'confirmed' as const, blockIds: ['shared-evidence'] }
  vi.mocked(api.notebooks.graph).mockResolvedValue({ catalog, graph: { catalogRevision: catalog.revision, scope: { kind: 'catalog' }, scannedScope: 'catalog', completeness: 'complete', hierarchy: [], references: [], duplicateNoteIds: [], observations: [observation] } })
  vi.mocked(api.notebooks.content).mockResolvedValue({ ...observation, content: file.content })
  vi.mocked(api.files.read).mockResolvedValue({ status: 'read', document: file })
  useAppStore.setState({ documents: { [docKey]: currentDraft }, dirtyDocuments: { [docKey]: true } })
  return { note, file, currentDraft }
}

it('opens an unregistered shared block and its inline child through the original Files owner preserving its dirty document and region', async () => {
  const { note, currentDraft } = unregisteredShared(), openPage = vi.fn()
  await dom.render(<NoteCanvas scope={{ kind: 'note', noteId: note.noteId }} onOpen={openPage} />)
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-reader [data-note-inline-link]')).not.toBeNull())
  expect(dom.container.querySelector('button.note-canvas-title')?.textContent).toContain('Shared original evidence')
  await dom.click('.note-canvas-reader [data-note-inline-link]')
  await vi.waitFor(() => expect(useAppStore.getState().documentRevealTargets[docKey]).toMatchObject({ noteBlock: { noteId: note.noteId, blockId: 'shared-evidence' } }))
  expect(openPage).not.toHaveBeenCalled()
  expect(useAppStore.getState().documents[docKey]).toEqual(currentDraft)
  expect(useAppStore.getState().dirtyDocuments[docKey]).toBe(true)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(['original-tab'])
  expect(Object.keys(useAppStore.getState().tabs['original-tab']!.regions)).toEqual(['original-region'])
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(useNotebookLibrary.getState().state!.pages[note.noteId]).toBeUndefined()
})

it('keeps a changed shared identity unopenable and preserves later navigation after a delayed read', async () => {
  const { note, file } = unregisteredShared()
  await dom.render(<NoteCanvas scope={{ kind: 'note', noteId: note.noteId }} onOpen={() => { throw new Error('No synthetic page') }} />)
  await vi.waitFor(() => expect(dom.container.querySelector('button.note-canvas-title')).not.toBeNull())
  vi.mocked(api.files.read).mockResolvedValueOnce({ status: 'read', document: { ...file, content: file.content.replace('independent-shared', 'another-note-identity') } })
  await dom.click('button.note-canvas-title')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('The shared file identity changed.'))
  expect(useAppStore.getState().mainSurface).toBe('recall')
  expect(useAppStore.getState().documentRevealTargets[docKey]).toBeUndefined()
  let release!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  vi.mocked(api.files.read).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  await dom.click('button.note-canvas-title')
  await act(async () => useAppStore.setState({ recallNoteId: 'later-choice' }))
  await act(async () => release({ status: 'read', document: file }))
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Your later navigation is kept.'))
  expect(useAppStore.getState().recallNoteId).toBe('later-choice')
  expect(useAppStore.getState().documentRevealTargets[docKey]).toBeUndefined()
})

it.each(['hide', 'supersede'] as const)('cancels shared file navigation during the second original read when the graph intent is %s', async action => {
  const { note, file, currentDraft } = unregisteredShared()
  const signals: AbortSignal[] = []
  const openFile = (original: { noteId: string; resource: NotebookPage['resource'] }, blockId: string | undefined, signal: AbortSignal) => {
    signals.push(signal)
    return openNotebookFile({ ...original, workface: page.workface }, undefined, undefined, blockId ? { noteId: original.noteId, blockId } : undefined, undefined, signal)
  }
  const render = (active: boolean) => dom.render(<NoteCanvas scope={{ kind: 'note', noteId: note.noteId }} active={active} onOpen={() => { throw Error('No catalog page for this file') }} onOpenFile={openFile} />)
  await render(true)
  await vi.waitFor(() => expect(dom.container.querySelector('button.note-canvas-title')).not.toBeNull())
  let release!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  vi.mocked(api.files.read).mockResolvedValueOnce({ status: 'read', document: file })
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  await dom.click('button.note-canvas-title')
  await vi.waitFor(() => expect(signals).toHaveLength(1))
  expect(signals[0]!.aborted).toBe(false)
  if (action === 'hide') await render(false)
  else {
    await dom.click('button.note-canvas-title')
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[1]!.aborted).toBe(false)
  }
  expect(signals[0]!.aborted).toBe(true)
  const afterIntent = useAppStore.getState().recallZoneSelection
  await act(async () => release({ status: 'read', document: file }))
  expect(useAppStore.getState().recallZoneSelection).toBe(afterIntent)
  expect(useAppStore.getState().documents[docKey]).toEqual(currentDraft)
  expect(useAppStore.getState().dirtyDocuments[docKey]).toBe(true)
  expect(useAppStore.getState().mainSurface).toBe('recall')
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(['original-tab'])
})
