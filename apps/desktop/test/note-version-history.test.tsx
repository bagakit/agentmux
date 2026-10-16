// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
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
  return { resource: params.expectedResource, result: noteHistorySnapshot({ noteId: params.noteId, resource, ...(params.includeContent === undefined ? {} : { includeContent: params.includeContent }) }, selected, selected.length < available.length) }
}
const pairs: monaco.editor.IDiffEditorModel[] = []
let baseline: number
beforeEach(async () => {
  baseline = monaco.editor.getModels().length; pairs.length = 0
  vi.spyOn(monaco.editor, 'createDiffEditor').mockImplementation(((host: HTMLElement) => ({
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
async function expand(selector = '.note-version-history__activity', open = true) {
  const details = dom.container.querySelector<HTMLDetailsElement>(selector)!
  await act(async () => { details.open = open; details.dispatchEvent(new Event('toggle')) })
}
async function click(text: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)
  expect(button, text).toBeDefined(); await act(async () => button!.click())
}
async function opened() { await mount(); await vi.waitFor(() => expect(dom.container.querySelector('.note-version-history__activity')).not.toBeNull()); await expand() }
function presented(element: Element | null) {
  if (!element) return false
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (node.hasAttribute('hidden') || style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

it('reads only when the parent activates Saved versions and keeps full trusted IDs behind activity details without polling', async () => {
  await mount(false)
  expect(api.files.historyPublic).not.toHaveBeenCalled(); expect(useAppStore.getState().inspectNoteHistory).not.toHaveBeenCalled()
  expect(dom.container.querySelector('.note-version-history')).toBeNull()
  await mount(true); await vi.waitFor(() => expect(api.files.historyPublic).toHaveBeenCalledTimes(1))
  expect(dom.container.querySelector('section[aria-label="Saved versions"]')).not.toBeNull()
  expect(dom.container.querySelector('.note-version-history > summary')).toBeNull()
  expect(dom.container.textContent).toContain('Agent · Research agent'); expect(dom.container.textContent).toContain('original-agent-session')
  const activity = dom.container.querySelector('.note-version-history__activity')!, identity = activity.querySelector<HTMLDetailsElement>('.note-version-history__identity')!
  expect(activity.querySelector('summary')!.textContent).not.toContain('original-agent-session')
  expect(identity.open).toBe(false)
  await expand()
  await expand('.note-version-history__identity')
  expect(identity.textContent).toContain('original-batch'); expect(identity.textContent).toContain('original-event-2'); expect(identity.textContent).toContain('agent · original-agent-session')
  expect(api.files.historyPublic).toHaveBeenCalledWith({ ...target(), limit: 50 })
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
  expect(presented(dom.container.querySelector('[aria-label="Version preview"]'))).toBe(true)
  expect(presented(dom.container.querySelector('.note-version-history__activities'))).toBe(false)
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
  await mount(); await vi.waitFor(() => expect(api.files.historyPublic).toHaveBeenCalledTimes(1))
  await mount(true, 'second'); await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Preview version second-event-2"]')).not.toBeNull())
  await act(async () => { release(history(target())); await late })
  expect(dom.container.querySelector('[aria-label="Preview version second-event-2"]')).not.toBeNull()
  expect(dom.container.querySelector('[aria-label="Preview version original-event-2"]')).toBeNull()
})

it('keeps the newest explicit version selection when an earlier body read returns late', async () => {
  let release!: (value: FileHistoryResult) => void
  const late = new Promise<FileHistoryResult>(resolve => { release = resolve })
  vi.mocked(api.files.historyPublic).mockImplementation(params => params.eventId === 'original-event-2' ? late : Promise.resolve(history(params)))
  await opened(); await dom.click('[aria-label="Preview version original-event-2"]'); await click('Back to activities'); await dom.click('[aria-label="Preview version original-event-1"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Version preview"]'), dom.container.textContent ?? '').not.toBeNull())
  await vi.waitFor(() => expect(pairs).toHaveLength(1))
  await act(async () => { release(history({ ...target(), eventId: 'original-event-2', includeContent: true })); await late })
  expect([pairs[0]!.original.getValue(), pairs[0]!.modified.getValue()]).toEqual([content('Before 1'), content('After 1')])
  await mount(false); expect(monaco.editor.getModels()).toHaveLength(baseline)
})

it('discards an old history read after the parent hides and reactivates the same Note', async () => {
  let release!: (value: FileHistoryResult) => void
  const late = new Promise<FileHistoryResult>(resolve => { release = resolve })
  vi.mocked(api.files.historyPublic).mockImplementationOnce(() => late)
  await mount(); await vi.waitFor(() => expect(api.files.historyPublic).toHaveBeenCalledTimes(1))
  await mount(false)
  expect(dom.container.querySelector('.note-version-history')).toBeNull()
  await mount(); await vi.waitFor(() => expect(dom.container.querySelector('.note-version-history__activity')).not.toBeNull())
  await act(async () => { release(history(target(), [])); await late })
  expect(dom.container.querySelector('[aria-label="Preview version original-event-2"]')).not.toBeNull()
  expect(dom.container.textContent).not.toContain('No saved versions')
  expect(api.files.historyPublic).toHaveBeenCalledTimes(2)
})

it('discards a hidden version body without creating diff models or changing the current draft', async () => {
  let release!: (value: FileHistoryResult) => void
  const late = new Promise<FileHistoryResult>(resolve => { release = resolve })
  vi.mocked(api.files.historyPublic).mockImplementation(params => params.eventId ? late : Promise.resolve(history(params)))
  await opened(); const documents = useAppStore.getState().documents
  await dom.click('[aria-label="Preview version original-event-2"]')
  await mount(false)
  await act(async () => { release(history({ ...target(), eventId: 'original-event-2', includeContent: true })); await late })
  expect(dom.container.querySelector('[aria-label="Version preview"]')).toBeNull()
  expect(pairs).toHaveLength(0); expect(monaco.editor.getModels()).toHaveLength(baseline)
  expect(useAppStore.getState().documents).toBe(documents)
  await mount(); await vi.waitFor(() => expect(dom.container.querySelector('.note-version-history__activity')).not.toBeNull())
  expect(dom.container.querySelector('[aria-label="Version preview"]')).toBeNull()
  expect(useAppStore.getState().applyNoteHistory).not.toHaveBeenCalled()
})

it('retains the loaded window and exact original selection when history is partly unconfirmed', async () => {
  vi.mocked(api.files.historyPublic).mockImplementation(async params => {
    const value = history(params)
    return { ...value, result: { ...value.result, status: 'unconfirmed', reason: 'Older activity metadata is unavailable' } } as FileHistoryResult
  })
  await opened()
  expect(dom.container.textContent).toContain('History is partly unconfirmed. Older activity metadata is unavailable')
  expect(dom.container.textContent).not.toContain('No saved versions')
  await dom.click('[aria-label="Preview version original-event-2"]')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Older activity metadata is unavailable'))
  expect(pairs).toHaveLength(0)
  await click('Back to activities')
  await click('Undo this activity…'); await click('Undo selected activity')
  expect(useAppStore.getState().applyNoteHistory).toHaveBeenCalledWith(tabId, regionId, { target: target(), batchId: 'original-batch', batchLastEventId: 'original-event-2' })
})

it('presents a selected version immediately while loading or failed, then restores the same expanded activities without rereading metadata', async () => {
  let reject!: (reason: unknown) => void
  const late = new Promise<FileHistoryResult>((_resolve, fail) => { reject = fail })
  vi.mocked(api.files.historyPublic).mockImplementation(params => params.eventId ? late : Promise.resolve(history(params)))
  await opened(); await expand('.note-version-history__identity')
  const activities = dom.container.querySelector('.note-version-history__activities')!, activity = dom.container.querySelector<HTMLDetailsElement>('.note-version-history__activity')!
  const identity = dom.container.querySelector<HTMLDetailsElement>('.note-version-history__identity')!, opener = dom.container.querySelector<HTMLButtonElement>('[aria-label="Preview version original-event-2"]')!
  await dom.click('[aria-label="Preview version original-event-2"]')
  const preview = dom.container.querySelector('[aria-label="Version preview"]')
  expect(presented(preview)).toBe(true)
  expect(preview!.textContent).toContain('Reading saved version…')
  expect(presented(activities)).toBe(false)
  expect(activities.closest('[hidden]')).not.toBeNull(); expect(activities.closest('[inert]')).not.toBeNull()
  expect(pairs).toHaveLength(0)
  await act(async () => { reject(Error('This selected original version is unavailable')); await late.catch(() => {}) })
  expect(presented(dom.container.querySelector('[aria-label="Version preview"]'))).toBe(true)
  expect(dom.container.querySelector('[aria-label="Version preview"]')!.textContent).toContain('This selected original version is unavailable')
  await click('Back to activities')
  expect(dom.container.querySelector('[aria-label="Version preview"]')).toBeNull()
  expect(dom.container.querySelector('.note-version-history__activities')).toBe(activities)
  expect(presented(activities)).toBe(true); expect(activity.open).toBe(true); expect(identity.open).toBe(true)
  expect(document.activeElement).toBe(opener)
  expect(useAppStore.getState().inspectNoteHistory).toHaveBeenCalledTimes(1)
  expect(api.files.historyPublic).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().applyNoteHistory).not.toHaveBeenCalled()
})

it('returns from a pending selected version without letting its late body allocate models or reopen the preview', async () => {
  let release!: (value: FileHistoryResult) => void
  const late = new Promise<FileHistoryResult>(resolve => { release = resolve })
  vi.mocked(api.files.historyPublic).mockImplementation(params => params.eventId ? late : Promise.resolve(history(params)))
  await opened(); const documents = useAppStore.getState().documents
  await dom.click('[aria-label="Preview version original-event-2"]')
  await click('Back to activities')
  expect(presented(dom.container.querySelector('.note-version-history__activities'))).toBe(true)
  await act(async () => { release(history({ ...target(), eventId: 'original-event-2', includeContent: true })); await late })
  expect(dom.container.querySelector('[aria-label="Version preview"]')).toBeNull()
  expect(pairs).toHaveLength(0); expect(monaco.editor.getModels()).toHaveLength(baseline)
  expect(useAppStore.getState().documents).toBe(documents)
  expect(useAppStore.getState().inspectNoteHistory).toHaveBeenCalledTimes(1)
  expect(api.files.historyPublic).toHaveBeenCalledTimes(2)
})

it('does not make Back cancel a real history write, and keeps its unknown result visible until the user returns', async () => {
  let reject!: (reason: unknown) => void
  const applying = new Promise<void>((_resolve, fail) => { reject = fail })
  vi.mocked(useAppStore.getState().applyNoteHistory).mockImplementation(() => applying)
  await opened(); await dom.click('[aria-label="Preview version original-event-2"]')
  await vi.waitFor(() => expect(pairs).toHaveLength(1))
  await click('Restore this entire version…'); await click('Replace saved document')
  const back = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Back to activities')!
  expect(back.disabled).toBe(true)
  await act(async () => back.click())
  expect(presented(dom.container.querySelector('[aria-label="Version preview"]'))).toBe(true)
  expect(useAppStore.getState().applyNoteHistory).toHaveBeenCalledTimes(1)
  await act(async () => { reject(Error('Original restore outcome is unconfirmed')); await applying.catch(() => {}) })
  expect(back.disabled).toBe(false)
  expect(dom.container.textContent).toContain('Original restore outcome is unconfirmed')
  await click('Back to activities')
  expect(presented(dom.container.querySelector('.note-version-history__activities'))).toBe(true)
  expect(useAppStore.getState().applyNoteHistory).toHaveBeenCalledTimes(1)
  expect(api.files.historyPublic).toHaveBeenCalledTimes(2)
})

it('anchors and focuses an activity undo confirmation beside its trigger in a full 50-activity window without reading bodies or writing before confirmation', async () => {
  const rows = Array.from({ length: 50 }, (_, index) => {
    const sequence = 50 - index
    return { ...records()[0]!, eventId: `window-event-${sequence}`, batchId: `window-activity-${sequence}`, sequence, at: sequence, parentEventId: sequence === 1 ? null : `window-event-${sequence - 1}` }
  })
  vi.mocked(api.files.historyPublic).mockImplementation(async params => history(params, rows))
  await mount(); await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-version-history__activity')).toHaveLength(50))
  await expand('.note-version-history__activity:nth-child(25)')
  const activity = dom.container.querySelectorAll('.note-version-history__activity')[24]!
  const undo = [...activity.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Undo this activity…')!
  await act(async () => { undo.focus(); undo.click() })
  const confirmation = dom.container.querySelector('[aria-label="Confirm history change"]')!
  expect(confirmation.closest('.note-version-history__activity')).toBe(activity)
  expect(presented(confirmation)).toBe(true)
  expect(document.activeElement).toBe(confirmation)
  expect(confirmation.querySelector('p')!.textContent).toContain('Undo all edits in this saved activity while keeping later nonconflicting changes')
  expect(confirmation.querySelector('button')!.textContent).toBe('Undo selected activity')
  expect(useAppStore.getState().applyNoteHistory).not.toHaveBeenCalled()
  expect(api.files.historyPublic).toHaveBeenCalledTimes(1)
  expect(api.files.historyPublic).toHaveBeenCalledWith({ ...target(), limit: 50 })
  await click('Undo selected activity')
  expect(useAppStore.getState().applyNoteHistory).toHaveBeenCalledWith(tabId, regionId, { target: target(), batchId: 'window-activity-26', batchLastEventId: 'window-event-26' })
  expect(api.files.historyPublic).not.toHaveBeenCalledWith(expect.objectContaining({ includeContent: true }))
})

it('keeps unavailable history explicit and never presents it as an empty saved timeline', async () => {
  vi.mocked(api.files.historyPublic).mockResolvedValue({ resource: target().expectedResource, result: { status: 'unknown', code: 'FILE_HISTORY_UNCONFIRMED', message: 'Original history unavailable' } })
  await mount(); await vi.waitFor(() => expect(dom.container.textContent).toContain('Original history unavailable'))
  expect(dom.container.textContent).not.toContain('No saved versions')
  expect(useAppStore.getState().applyNoteHistory).not.toHaveBeenCalled()
})

it('keeps original events and actions usable when a valid protocol timestamp exceeds the display Date range', async () => {
  vi.mocked(api.files.historyPublic).mockImplementation(async params => history(params, records().map(row => ({ ...row, at: _tailFixtureEpoch(0, 0, 8.7e15) }))))
  await opened()
  expect(dom.container.textContent).toContain('Time unavailable')
  expect(dom.container.textContent).toContain('Agent · Research agent')
  expect(dom.container.querySelector('[aria-label="Preview version original-event-2"]')).not.toBeNull()
  await click('Undo this activity…'); await click('Undo selected activity')
  expect(useAppStore.getState().applyNoteHistory).toHaveBeenCalledWith(tabId, regionId, { target: target(), batchId: 'original-batch', batchLastEventId: 'original-event-2' })
})

it('shows a shared-file deletion as an absent after document without inventing an empty saved version or restore action', async () => {
  const row = records()[0]!
  const deleted: NoteHistoryRecord = { ...row, operation: 'delete', source: { eventId: 'original-create-event' }, beforeContent: content('Shared content before collection'), baseRevision: noteHistoryRevision(content('Shared content before collection')), content: null, revision: null }
  vi.mocked(api.files.historyPublic).mockImplementation(async params => history(params, [deleted]))
  await opened(); await dom.click('[aria-label="Preview version original-event-2"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Version preview"]')?.textContent).toContain('It has no saved document after the change.'))
  expect(dom.container.textContent).toContain('Shared file collected')
  expect([...dom.container.querySelectorAll('button')].some(button => button.textContent === 'Restore this entire version…')).toBe(false)
  expect(pairs).toHaveLength(0)
  expect(useAppStore.getState().applyNoteHistory).not.toHaveBeenCalled()
})
