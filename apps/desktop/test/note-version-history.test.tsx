// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/editor/editor.api.js'
import { noteHistoryRevision, noteHistorySnapshot, type NoteHistoryRecord } from '@agentmux/core/note-history'
import type { FileHistoryParams, FileHistoryResult } from '@agentmux/core/files'
import { NoteVersionHistory } from '../src/renderer/src/components/NoteVersionHistory'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { newNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.hoisted(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }) })

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!, path = 'original.note.md', tabId = 'history-tab', regionId = 'history-file'
const resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path }
const target = (noteId = 'original') => ({ noteId, zoneId: 'original-zone', path, expectedResource: { ...resource, zoneId: 'original-zone', zonePath: workspace.path } })
const content = (text: string, noteId = 'original') => serializeNoteDocument(newNoteDocument(text, noteId, 'original-block', 'Original title'))
const records = (noteId = 'original'): NoteHistoryRecord[] => [2, 1].map(sequence => ({
  noteId, resource, originalResource: resource, eventId: `${noteId}-event-${sequence}`, sequence, batchId: `${noteId}-batch`, parentEventId: sequence === 2 ? `${noteId}-event-1` : null,
  actor: { kind: 'agent', id: 'original-agent-session' }, status: 'committed', operation: 'edit', at: sequence, requestFingerprint: 'private',
  beforeContent: content(`Before ${sequence}`, noteId), baseRevision: noteHistoryRevision(content(`Before ${sequence}`, noteId)),
  content: content(`After ${sequence}`, noteId), revision: noteHistoryRevision(content(`After ${sequence}`, noteId))
}))
function history(params: FileHistoryParams, rows = records(params.noteId), window = false): FileHistoryResult {
  const available = rows.filter(row => params.eventId ? row.eventId === params.eventId : params.before === undefined || row.sequence < params.before)
  const selected = window && !params.eventId ? available.slice(0, 1) : available
  return { resource: params.expectedResource, result: noteHistorySnapshot({ noteId: params.noteId, resource, includeContent: params.includeContent }, selected, selected.length < available.length) }
}
const pairs: monaco.editor.IDiffEditorModel[] = []
let baseline: number
beforeEach(async () => {
  baseline = monaco.editor.getModels().length; pairs.length = 0
  vi.spyOn(monaco.editor, 'createDiffEditor').mockImplementation((host => ({
    createViewModel(pair: monaco.editor.IDiffEditorModel) { pairs.push(pair); return { model: pair, dispose() {} } },
    setModel(view: { model: monaco.editor.IDiffEditorModel } | null) { host.textContent = view ? view.model.original.getValue() + '\n' + view.model.modified.getValue() : '' },
    updateOptions() {}, dispose() {}
  })) as unknown as typeof monaco.editor.createDiffEditor)
  vi.spyOn(monaco.editor, 'setTheme').mockImplementation(() => {})
  await act(async () => { await import('../src/renderer/src/components/ReadonlyDiffEditor') })
  const tab = createWorkbenchTab(tabId, { kind: 'file', regionId, workspaceId: workspace.id, path })
  useAppStore.setState({ tabs: { [tabId]: tab }, documents: { [documentKey(workspace.id, path)]: { path, content: content('Keep my current draft'), revision: noteHistoryRevision(content('After 2')) } }, dirtyDocuments: { [documentKey(workspace.id, path)]: true }, agentNames: { 'original-agent-session': 'Research agent' } })
  vi.spyOn(useAppStore.getState(), 'inspectNoteHistory').mockImplementation(async (_tab, _region, noteId) => ({ target: target(noteId), document: { path, content: content('After 2', noteId), revision: noteHistoryRevision(content('After 2', noteId)) } }))
  vi.spyOn(useAppStore.getState(), 'applyNoteHistory').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'historyPublic').mockImplementation(async params => history(params))
})
afterEach(() => { expect(monaco.editor.getModels()).toHaveLength(baseline) })
async function mount(active = true, noteId = 'original') { await dom.render(<NoteVersionHistory tabId={tabId} regionId={regionId} noteId={noteId} active={active} />) }
async function expand(selector = '.note-version-history', open = true) {
  const details = dom.container.querySelector<HTMLDetailsElement>(selector)!
  await act(async () => { details.open = open; details.dispatchEvent(new Event('toggle')) })
}
async function click(text: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)
  expect(button, text).toBeDefined(); await act(async () => button!.click())
}
async function opened() { await mount(); await expand(); await vi.waitFor(() => expect(dom.container.querySelector('.note-version-history__activity')).not.toBeNull()); await expand('.note-version-history__activity') }

it('reads only after explicit expansion in an active view and shows real actor identity without hidden polling', async () => {
  await mount(false)
  expect(api.files.historyPublic).not.toHaveBeenCalled(); expect(useAppStore.getState().inspectNoteHistory).not.toHaveBeenCalled()
  await expand(); expect(api.files.historyPublic).not.toHaveBeenCalled()
  await mount(true); await vi.waitFor(() => expect(api.files.historyPublic).toHaveBeenCalledTimes(1))
  expect(dom.container.textContent).toContain('Agent · Research agent'); expect(dom.container.textContent).toContain('original-agent-session')
  expect(pairs).toHaveLength(0)
  await mount(false)
  await act(async () => useAppStore.setState({ agentNames: { unrelated: 'Other agent' } }))
  expect(api.files.historyPublic).toHaveBeenCalledTimes(1)
})

it('previews exact before/after models read-only and requires explicit whole-document confirmation', async () => {
  await opened(); const before = useAppStore.getState().documents, draft = useAppStore.getState().agentComposerDrafts
  await dom.click('[aria-label="Preview version original-event-2"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Version preview"]'), dom.container.textContent ?? '').not.toBeNull())
  await vi.waitFor(() => expect(pairs).toHaveLength(1))
  expect([pairs[0]!.original.getValue(), pairs[0]!.modified.getValue()]).toEqual([content('Before 2'), content('After 2')])
  expect(useAppStore.getState().documents).toBe(before); expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
  expect(useAppStore.getState().applyNoteHistory).not.toHaveBeenCalled()
  await click('Restore this entire version…')
  expect(dom.container.textContent).toContain('Replace the saved document with this entire version? Your current local draft will be kept.')
  expect(useAppStore.getState().applyNoteHistory).not.toHaveBeenCalled()
  await click('Replace saved document')
  expect(useAppStore.getState().applyNoteHistory).toHaveBeenCalledWith(tabId, regionId, { target: target(), eventId: 'original-event-2' })
  expect(useAppStore.getState().documents).toBe(before)
})

it('pages activity windows without claiming completeness and passes the selected newest tail to the original undo owner', async () => {
  vi.mocked(api.files.historyPublic).mockImplementation(async params => history(params, records(), true))
  await opened()
  expect(dom.container.textContent).toContain('1 loaded revision'); expect(dom.container.textContent).toContain('An activity may continue beyond this window.')
  await click('Load older changes'); await vi.waitFor(() => expect(dom.container.textContent).toContain('2 loaded revisions'))
  expect(api.files.historyPublic).toHaveBeenLastCalledWith({ ...target(), before: 2, limit: 50 })
  await click('Undo this activity…'); expect(useAppStore.getState().applyNoteHistory).not.toHaveBeenCalled()
  await click('Undo selected activity')
  expect(useAppStore.getState().applyNoteHistory).toHaveBeenCalledWith(tabId, regionId, { target: target(), batchId: 'original-batch', batchLastEventId: 'original-event-2' })
})

it('rejects a late history window from the previous Note identity', async () => {
  let release!: (value: FileHistoryResult) => void
  const late = new Promise<FileHistoryResult>(resolve => { release = resolve })
  vi.mocked(api.files.historyPublic).mockImplementation(params => params.noteId === 'original' ? late : Promise.resolve(history(params)))
  await mount(); await expand(); await vi.waitFor(() => expect(api.files.historyPublic).toHaveBeenCalledTimes(1))
  await mount(true, 'second'); await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Preview version second-event-2"]')).not.toBeNull())
  await act(async () => { release(history(target())); await late })
  expect(dom.container.querySelector('[aria-label="Preview version second-event-2"]')).not.toBeNull()
  expect(dom.container.querySelector('[aria-label="Preview version original-event-2"]')).toBeNull()
})

it('keeps the newest explicit version selection when an earlier body read returns late', async () => {
  let release!: (value: FileHistoryResult) => void
  const late = new Promise<FileHistoryResult>(resolve => { release = resolve })
  vi.mocked(api.files.historyPublic).mockImplementation(params => params.eventId === 'original-event-2' ? late : Promise.resolve(history(params)))
  await opened(); await dom.click('[aria-label="Preview version original-event-2"]'); await dom.click('[aria-label="Preview version original-event-1"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Version preview"]'), dom.container.textContent ?? '').not.toBeNull())
  await vi.waitFor(() => expect(pairs).toHaveLength(1))
  await act(async () => { release(history({ ...target(), eventId: 'original-event-2', includeContent: true })); await late })
  expect([pairs[0]!.original.getValue(), pairs[0]!.modified.getValue()]).toEqual([content('Before 1'), content('After 1')])
  await mount(false); expect(monaco.editor.getModels()).toHaveLength(baseline)
})

it('keeps unavailable history explicit and never presents it as an empty saved timeline', async () => {
  vi.mocked(api.files.historyPublic).mockResolvedValue({ resource: target().expectedResource, result: { status: 'unknown', code: 'FILE_HISTORY_UNCONFIRMED', message: 'Original history unavailable' } })
  await mount(); await expand(); await vi.waitFor(() => expect(dom.container.textContent).toContain('Original history unavailable'))
  expect(dom.container.textContent).not.toContain('No saved versions')
  expect(useAppStore.getState().applyNoteHistory).not.toHaveBeenCalled()
})

it('keeps original events and actions usable when a valid protocol timestamp exceeds the display Date range', async () => {
  vi.mocked(api.files.historyPublic).mockImplementation(async params => history(params, records().map(row => ({ ...row, at: 8.7e15 }))))
  await opened()
  expect(dom.container.textContent).toContain('Time unavailable')
  expect(dom.container.textContent).toContain('Agent · Research agent')
  expect(dom.container.querySelector('[aria-label="Preview version original-event-2"]')).not.toBeNull()
  await click('Undo this activity…'); await click('Undo selected activity')
  expect(useAppStore.getState().applyNoteHistory).toHaveBeenCalledWith(tabId, regionId, { target: target(), batchId: 'original-batch', batchLastEventId: 'original-event-2' })
})
