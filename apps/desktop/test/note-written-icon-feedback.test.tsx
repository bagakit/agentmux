// @vitest-environment happy-dom
import { act, useState, type ReactNode } from 'react'
import { NoteViewToolbarContext } from '../src/renderer/src/lib/note-view-toolbar'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { emptyNotebookState } from '@agentmux/core/notebook-catalog'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import type { FileDocument, WorkspaceFileWriteResult } from '../src/shared/contracts'
import type { NoteWrittenReceipt } from '../src/shared/note-file-editing'
import { newNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import { NoteFileView } from '../src/renderer/src/components/NoteFileView'
import { NoteFileSurfaceView } from '../src/renderer/src/components/NoteFileSurfaceView'
import { noteKnowledge } from '../src/renderer/src/lib/note-knowledge'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { documentKey, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!, path = 'original.note.md'
const resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path }
const surface = { kind: 'file' as const, regionId: 'note-original-region', workspaceId: workspace.id, path }, tab = createWorkbenchTab('note-original-tab', surface), key = documentKey(workspace.id, path)
const presentation = { active: true, retainedRegionId: surface.regionId, tabHostId: 'note-original-host', reference: { displayWorkspaceId: workspace.id, groupId: 'note-original-group', tabId: tab.id, regionId: surface.regionId } }
const onSave = vi.fn(), onChange = vi.fn(), onOpen = vi.fn()
let reduced = false, media: MediaQueryList, target: EventTarget
function documentFor(text = 'Original body'): FileDocument { const content = serializeNoteDocument(newNoteDocument(text, 'note-original', 'block-original')); return { path, content, revision: noteHistoryRevision(content) } }
function written(text: string): FileDocument { const doc = documentFor(text), receipt: NoteWrittenReceipt = { status: 'written', revision: doc.revision }; return { ...doc, noteEditing: { baseline: { content: doc.content, revision: doc.revision }, receipt } } }
function feedback() { return dom.container.querySelector('.note-file-identity-icon [data-icon-animation="feedback"]') }
const icons = () => dom.container.querySelectorAll('.note-file-identity-icon svg[data-semantic-icon="object.note"]')
function OriginalFrame({ children }: { children: ReactNode }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  return <NoteViewToolbarContext.Provider value={element ? { element, documentKey: key } : null}>
    <div className="note-view-controls" ref={setElement} />{children}
  </NoteViewToolbarContext.Provider>
}
async function view(document: FileDocument, options: { dirty?: boolean; active?: boolean; resource?: typeof resource } = {}) {
  await dom.render(<OriginalFrame><WorkbenchPresentationContext.Provider value={{ ...presentation, active: options.active ?? true }}><NoteFileView document={document} resource={options.resource ?? resource} dirty={options.dirty ?? false}
    knowledge={noteKnowledge([{ document, location: { workspaceId: resource.workspaceId, path: document.path } }], 'partial')} onSave={onSave} onChange={onChange} onOpen={onOpen} /></WorkbenchPresentationContext.Provider></OriginalFrame>)
}
async function end() { await act(async () => feedback()!.dispatchEvent(new Event('animationend', { bubbles: true }))) }
beforeEach(() => {
  vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, bottom: 16, right: 16, width: 16, height: 16, toJSON() {} })
  reduced = false; target = new EventTarget(); media = { media: '(prefers-reduced-motion: reduce)', get matches() { return reduced }, onchange: null, addListener() {}, removeListener() {}, addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target) } as MediaQueryList
  const original = window.matchMedia.bind(window); vi.spyOn(window, 'matchMedia').mockImplementation(query => query === media.media ? media : original(query))
  useNotebookLibrary.setState({ state: null, issue: null }); onSave.mockClear(); onChange.mockClear(); onOpen.mockClear()
  useAppStore.setState({ config: composerConfig, tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('note-original-group', [tab.id]) }, documents: { [key]: documentFor() },
    dirtyDocuments: {}, savingDocuments: {}, documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {}, documentRevealTargets: {}, noteBlockSelections: {}, noteDirectorySources: {}, workspaceFileRevisions: {}, retainedDocumentDrafts: {}, mainSurface: 'recall' })
  vi.spyOn(api.files, 'read').mockRejectedValue(new Error('Original read temporarily unconfirmed; current buffer retained'))
  vi.spyOn(api.files, 'observe').mockResolvedValue(); vi.spyOn(api.files, 'unobserve').mockResolvedValue()
  vi.spyOn(api.files, 'readDirectory').mockRejectedValue(new Error('Rendering must not discover other directories'))
  vi.spyOn(api.notebooks, 'actor').mockResolvedValue({ kind: 'user', id: 'original-reader' })
})
afterEach(() => { vi.unstubAllGlobals() })
it('the actual Note surface consumes the original Store settlement after written, preserving editor, input and metadata notice', async () => {
  let release!: (value: WorkspaceFileWriteResult) => void
  const write = vi.spyOn(api.files, 'write').mockImplementation(() => new Promise(resolve => { release = resolve }))
  const mounted = () => <WorkbenchPresentationContext.Provider value={presentation}><NoteFileSurfaceView tabId={tab.id} surface={surface}/></WorkbenchPresentationContext.Provider>
  await dom.render(mounted()); expect(icons()).toHaveLength(1); expect(feedback()).toBeNull()
  const editor = (dom.container.querySelector('.note-block-content') as HTMLElement & { editor: Editor }).editor
  await act(async () => { editor.commands.insertContent('Saved edit '); await Promise.resolve() })
  await vi.waitFor(() => expect(useAppStore.getState().dirtyDocuments[key]).toBe(true))
  const originalControl = useAppStore.getState().sessions[0]!.control
  let saving!: Promise<void>; await act(async () => { saving = useAppStore.getState().saveDocument(tab.id, surface.regionId); await Promise.resolve() })
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce()); expect(feedback()).toBeNull()
  const sent = write.mock.calls[0]![1]; expect(sent.path).toBe(path)
  await act(async () => { release({ status: 'written', content: sent.content, revision: noteHistoryRevision(sent.content), noteAttribution: { status: 'unconfirmed', reason: 'Original metadata still unconfirmed' } }); await saving })
  expect(feedback()).not.toBeNull(); expect(icons()).toHaveLength(1)
  expect(useAppStore.getState().documents[key]!.noteEditing?.receipt?.revision).toBe(useAppStore.getState().documents[key]!.revision)
  expect(useAppStore.getState().documents[key]!.noteEditing?.attempt).toBeUndefined()
  expect(useAppStore.getState().documents[key]!.noteWriteAttribution).toEqual({ status: 'unconfirmed', reason: 'Original metadata still unconfirmed' })
  expect((dom.container.querySelector('.note-block-content') as HTMLElement & { editor: Editor }).editor).toBe(editor)
  expect(editor.isEditable).toBe(true); expect(useAppStore.getState().sessions[0]!.control).toBe(originalControl)
  await end(); expect(feedback()).toBeNull()
  await act(async () => useAppStore.setState({ error: 'Unrelated notice' })); expect(feedback()).toBeNull()
  await dom.render(<div/>); await dom.render(mounted()); expect(icons()).toHaveLength(1); expect(feedback()).toBeNull(); expect(write).toHaveBeenCalledOnce()
})
it('loaded success and original-resource switches stay still; only a new settled receipt plays once', async () => {
  const first = written('Earlier saved body'); first.noteEditing!.receipt!.noteHistory = { status: 'committed', eventId: 'earlier-original-write', batchId: 'earlier-batch' }
  await view(first); expect(feedback()).toBeNull()
  await view({ ...first, noteEditing: { ...first.noteEditing, receipt: { ...first.noteEditing!.receipt!, noteHistory: { status: 'committed', eventId: 'earlier-original-write', batchId: 'earlier-batch', replayed: true } } } }); expect(feedback()).toBeNull()
  const fresh = written('New confirmed body'); await view(fresh); expect(feedback()).not.toBeNull(); await end(); expect(feedback()).toBeNull()
  await view({ ...fresh }); expect(feedback()).toBeNull()
  await view(fresh, { resource: { ...resource, hostId: 'another-original-host' } }); expect(feedback()).toBeNull()
  await view(fresh); expect(feedback()).toBeNull(); expect(icons()).toHaveLength(1); expect(onSave).not.toHaveBeenCalled()
})
it('dirty, wrong revision/body, unknown attempts and unresolved input cannot give save feedback or later replay old success', async () => {
  await view(documentFor())
  for (const kind of ['dirty', 'revision', 'body', 'unknown', 'input'] as const) {
    const fresh = written('Fresh ' + kind), receipt = fresh.noteEditing!.receipt!
    const candidate = kind === 'revision' ? { ...fresh, revision: 'other-current-revision' } : kind === 'body' ? { ...fresh, content: documentFor('Later local draft').content } : kind === 'unknown' ? { ...fresh, noteEditing: { ...fresh.noteEditing, attempt: { operationId: 'original-attempt', noteId: 'note-original', content: fresh.content, expectedRevision: fresh.revision, generation: 1, resource, phase: 'unknown' as const } } } : kind === 'input' ? { ...fresh, noteEditing: { ...fresh.noteEditing, input: { baseContent: fresh.content, observedContent: fresh.content, proposedContent: 'Later draft', resource, phase: 'conflict' as const } } } : fresh
    await view(candidate, { dirty: kind === 'dirty' }); expect(feedback(), kind).toBeNull()
    await view({ ...fresh, noteEditing: { ...fresh.noteEditing, receipt } }); expect(feedback(), kind + ' resolved old receipt').toBeNull()
  }
  expect(onSave).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled()
})
it('only the exact written attempt can await its canonical body; a foreign original resource cannot keep a pending visual event', async () => {
  await view(documentFor())
  const fresh = written('Canonical settled body'), receipt = fresh.noteEditing!.receipt!
  const pending = { ...documentFor(), noteEditing: { receipt, attempt: { operationId: 'original-attempt', noteId: 'note-original', content: fresh.content, expectedRevision: documentFor().revision, generation: 1, resource, phase: 'written' as const, written: receipt } } }
  await view(pending, { dirty: true }); expect(feedback()).toBeNull()
  await view(fresh); expect(feedback()).not.toBeNull(); await end()
  const other = written('Foreign pending body'), foreign = { ...pending, noteEditing: { receipt: other.noteEditing!.receipt, attempt: { ...pending.noteEditing.attempt, written: other.noteEditing!.receipt, resource: { ...resource, hostId: 'foreign-host' } } } }
  await view(foreign, { dirty: true }); expect(feedback()).toBeNull(); await view(other); expect(feedback()).toBeNull()
})
it('parked and hidden writes never replay; hiding an active effect removes it and foreground does not renew the receipt', async () => {
  await view(documentFor()); const parked = written('Parked save')
  await view(parked, { active: false }); expect(feedback()).toBeNull(); await view(parked); expect(feedback()).toBeNull()
  const current = written('Visible save'); await view(current); expect(feedback()).not.toBeNull()
  let hidden = true; vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  await act(async () => document.dispatchEvent(new Event('visibilitychange'))); expect(feedback()).toBeNull()
  const background = written('Background save'); await view(background); expect(feedback()).toBeNull()
  hidden = false; await act(async () => document.dispatchEvent(new Event('visibilitychange'))); await view(background); expect(feedback()).toBeNull()
  expect(onSave).not.toHaveBeenCalled()
})
it('a later draft, inert host or reduced motion stops finite feedback and never resumes the old visual event', async () => {
  await view(documentFor()); let fresh = written('Visible first save'); await view(fresh); expect(feedback()).not.toBeNull()
  await view(fresh, { dirty: true }); expect(feedback()).toBeNull(); await view(fresh); expect(feedback()).toBeNull()
  fresh = written('Visible second save'); await view(fresh); expect(feedback()).not.toBeNull()
  await act(async () => { dom.container.setAttribute('inert', ''); await Promise.resolve() }); expect(feedback()).toBeNull()
  await act(async () => dom.container.removeAttribute('inert')); await view(fresh); expect(feedback()).toBeNull()
  fresh = written('Visible third save'); await view(fresh); expect(feedback()).not.toBeNull()
  reduced = true; await act(async () => media.dispatchEvent(new Event('change'))); expect(feedback()).toBeNull()
  const reducedReceipt = written('Reduced save'); await view(reducedReceipt); expect(feedback()).toBeNull()
  reduced = false; await act(async () => media.dispatchEvent(new Event('change'))); await view(reducedReceipt); expect(feedback()).toBeNull()
})
it('registered Notes keep exactly one original note identity in the file toolbar alongside unconfirmed metadata', async () => {
  const catalog = emptyNotebookState(); catalog.pages['note-original'] = { noteId: 'note-original', title: 'Registered original', notebookId: 'quick-notes', parentNoteId: null, resource, sources: [], topics: [], createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 2) }
  useNotebookLibrary.setState({ state: catalog }); await view(documentFor()); expect(icons()).toHaveLength(1)
  expect(dom.container.querySelectorAll('.notebook-page-heading .note-file-identity-icon')).toHaveLength(0)
  expect(dom.container.querySelectorAll('.note-view-controls .note-file-identity-icon')).toHaveLength(1)
  const fresh = { ...written('Registered fresh'), noteWriteAttribution: { status: 'unconfirmed' as const, reason: 'Metadata observation retained' } }
  await view(fresh); expect(feedback()).not.toBeNull(); expect(icons()).toHaveLength(1)
  expect(onSave).not.toHaveBeenCalled()
})
it('a drawing without an animation end event releases its local cue once, without a later draft render renewing it', async () => {
  await view(documentFor()); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const fresh = written('Saved with a user-selected drawing'); await view(fresh); expect(feedback()).not.toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(600))
    await view({ ...fresh }); expect(feedback()).not.toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(400)); expect(feedback()).toBeNull()
    await view({ ...fresh }); expect(feedback()).toBeNull(); expect(onSave).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
