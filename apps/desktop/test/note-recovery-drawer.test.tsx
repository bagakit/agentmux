// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { noteHistoryRevision, noteHistorySnapshot, type NoteHistoryRecord } from '@agentmux/core/note-history'
import type { FileHistoryParams } from '@agentmux/core/files'
import type { NotesStorageSnapshot } from '@agentmux/core/notebook-store'
import { EditorPane } from '../src/renderer/src/components/EditorPane'
import { NoteFileSurfaceView } from '../src/renderer/src/components/NoteFileSurfaceView'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { createWorkbenchTab, documentKey, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import * as noteKnowledgeModule from '../src/renderer/src/lib/note-knowledge'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { newNoteDocument, serializeNoteDocument, type NoteDocument } from '../src/shared/note-document'
import type { FileDocument } from '../src/shared/contracts'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const mounts = vi.hoisted(() => ({ rich: 0, richDisposed: 0, source: 0, sourceDisposed: 0, diff: 0 }))
vi.hoisted(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }) })
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('../src/renderer/src/components/NoteBlockEditor', async () => {
  const { useEffect, useState } = await import('react')
  const { serializeNoteDocument } = await import('../src/shared/note-document')
  return { NoteBlockEditor({ note, onChange }: { note: NoteDocument; onChange(raw: string, before: string): void }) {
    const [value, setValue] = useState(() => note.content.content?.[0]?.content?.[0]?.text ?? '')
    useEffect(() => { ++mounts.rich; return () => { ++mounts.richDisposed } }, [])
    return <textarea aria-label="Mounted Note input" data-observed-text={note.content.content?.[0]?.content?.[0]?.text ?? ''} value={value} onChange={event => {
      const text = event.currentTarget.value
      setValue(text)
      onChange(serializeNoteDocument({ ...note, content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'original-block' }, content: [{ type: 'text', text }] }] } }), serializeNoteDocument(note))
    }} />
  } }
})
vi.mock('../src/renderer/src/components/FileSourceEditor', async () => {
  const { useEffect } = await import('react')
  const { useAppStore } = await import('../src/renderer/src/store')
  const { documentKey } = await import('../src/renderer/src/lib/workbench-tabs')
  return { FileSourceEditor({ tabId, surface }: { tabId: string; surface: FileWorkbenchSurface }) {
    const doc = useAppStore(state => state.documents[documentKey(surface.workspaceId, surface.path)])
    useEffect(() => { ++mounts.source; return () => { ++mounts.sourceDisposed } }, [])
    return <textarea aria-label="Mounted Source input" value={doc?.content ?? ''} onChange={event => useAppStore.getState().updateDocument(tabId, event.currentTarget.value, surface.regionId)} />
  } }
})
vi.mock('../src/renderer/src/components/ReadonlyDiffEditor', async () => {
  const { useEffect } = await import('react')
  return { ReadonlyDiffEditor({ original, modified }: { original: string; modified: string }) {
    useEffect(() => { ++mounts.diff }, [])
    return <div aria-label="Mounted readonly comparison"><pre>{original}</pre><pre>{modified}</pre></div>
  } }
})

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!, tabId = 'recovery-tab', regionId = 'recovery-region'
const path = 'original.note.md', key = documentKey(workspace.id, path)
const surface: FileWorkbenchSurface = { kind: 'file', regionId, workspaceId: workspace.id, path }
const resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path }
const target = { noteId: 'original', zoneId: 'original-zone', path, expectedResource: { ...resource, zoneId: 'original-zone', zonePath: workspace.path } }
const content = (text: string, noteId = 'original') => serializeNoteDocument(newNoteDocument(text, noteId, 'original-block', 'Original page'))
const baseline = content('Saved baseline')
const original = (): FileDocument => ({ path, content: content('Current human input'), revision: noteHistoryRevision(baseline), noteEditing: { baseline: { content: baseline, revision: noteHistoryRevision(baseline) } } })
const healthy = (): NotesStorageSnapshot => ({ directory: workspace.path, catalogPath: workspace.path + '/notebook.sqlite', resourceChanges: [], directoryChanges: [], operation: null, conversionIssues: [] })
const saved: NoteHistoryRecord = { noteId: 'original', resource, originalResource: resource, eventId: 'original-event', sequence: 1, batchId: 'original-activity', parentEventId: null,
  actor: { kind: 'agent', id: 'authenticated-agent-session' }, status: 'committed', operation: 'edit', at: _historyFixtureEpoch(0, 0, 1), requestFingerprint: 'private',
  beforeContent: baseline, baseRevision: noteHistoryRevision(baseline), content: content('Saved by the agent'), revision: noteHistoryRevision(content('Saved by the agent')) }
function history(params: FileHistoryParams) { return { resource: params.expectedResource, result: noteHistorySnapshot({ noteId: params.noteId, resource, ...(params.includeContent === undefined ? {} : { includeContent: params.includeContent }) }, [saved], false) } }

beforeEach(() => {
  Object.assign(mounts, { rich: 0, richDisposed: 0, source: 0, sourceDisposed: 0, diff: 0 })
  useNotebookLibrary.setState({ state: null, issue: null })
  useAppStore.setState({ tabs: { [tabId]: createWorkbenchTab(tabId, surface) }, documents: { [key]: original() }, dirtyDocuments: { [key]: true }, documentIssues: {}, retainedDocumentDrafts: {}, editorRegionModes: { [regionId]: 'preview' } })
  vi.spyOn(api.notesStorage, 'inspect').mockImplementation(async () => healthy())
  vi.spyOn(api.notesStorage, 'onChange').mockImplementation(() => () => {})
  vi.spyOn(api.files, 'read').mockRejectedValue(Error('The mounted shell must reuse its original loaded file'))
  vi.spyOn(api.files, 'write').mockRejectedValue(Error('Reviewing activity must not write a file'))
  vi.spyOn(api.files, 'historyPublic').mockImplementation(async params => history(params))
  vi.spyOn(useAppStore.getState(), 'inspectNoteHistory').mockImplementation(async (_tab, _region, noteId) => ({ target: { ...target, noteId }, document: { path, content: baseline, revision: noteHistoryRevision(baseline) } }))
  vi.spyOn(useAppStore.getState(), 'applyNoteHistory').mockResolvedValue(undefined)
})

async function mount({ visible = true, active = true, file = surface }: { visible?: boolean; active?: boolean; file?: FileWorkbenchSurface } = {}) {
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}>
    <EditorPane tabId={tabId} surface={file} visible={visible} preview={<NoteFileSurfaceView tabId={tabId} surface={file} />}
      onTogglePreview={() => { const state = useAppStore.getState(); void state.setEditorRegionMode(file.regionId, file.workspaceId, file.path, state.editorRegionModes[file.regionId] === 'edit' ? 'preview' : 'edit') }} />
  </WorkbenchPresentationContext.Provider>)
}
const drawer = () => dom.container.querySelector<HTMLElement>('[role="dialog"]')
async function click(label: string, root: ParentNode = dom.container) {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => { button!.focus(); button!.click() })
  return button!
}
async function openDrafts() { await click('Open versions and recovery'); await click('Drafts & recovery', drawer()!); return drawer()! }
async function disclose(selector: string) { const details = dom.container.querySelector<HTMLDetailsElement>(selector)!; expect(details).not.toBeNull(); await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) }); return details }
async function type(node: HTMLTextAreaElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })) })
}

it('keeps the original Note and Source input instances through activity open, section changes, expansion and Source switches', async () => {
  await mount()
  const rich = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Mounted Note input"]')!
  expect(mounts.rich).toBe(1); expect(drawer()).toBeNull()
  expect(api.files.historyPublic).not.toHaveBeenCalled(); expect(mounts.diff).toBe(0)
  await type(rich, 'Local typing survives every activity transition')
  expect(useAppStore.getState().documents[key]!.content).toContain('Local typing survives')
  await click('Open versions and recovery')
  await vi.waitFor(() => expect(api.files.historyPublic).toHaveBeenCalledTimes(1))
  await click('Expand review', drawer()!)
  expect(drawer()!.className).toContain('note-recovery-drawer--expanded')
  await click('Drafts & recovery', drawer()!)
  await click('Return to side panel', drawer()!)
  await click('Close versions and recovery', drawer()!)
  await click('Show source')
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Mounted Source input"]')).not.toBeNull())
  const source = dom.container.querySelector('[aria-label="Mounted Source input"]')!
  await click('Preview current content')
  await click('Open versions and recovery'); await click('Close versions and recovery', drawer()!)
  expect(dom.container.querySelector('[aria-label="Mounted Note input"]')).toBe(rich)
  expect(rich.value).toBe('Local typing survives every activity transition')
  expect(dom.container.querySelector('[aria-label="Mounted Source input"]')).toBe(source)
  expect(mounts).toMatchObject({ rich: 1, richDisposed: 0, source: 1, sourceDisposed: 0, diff: 0 })
  expect(api.files.write).not.toHaveBeenCalled()
})

it('keeps ordinary retained input and conversion backups available without making them persistent warnings', async () => {
  const current = original(), kept = { ...current, content: content('A separately kept human draft') }
  current.noteConversion = { source: resource, originalContent: 'Original format backup', originalRevision: 'old-format-revision', wasDirty: false }
  useAppStore.setState({ documents: { [key]: current }, retainedDocumentDrafts: { [key]: [kept] } })
  await mount()
  expect(dom.container.querySelector('.note-recovery-summary')).toBeNull()
  expect(dom.container.querySelector('.editor-file-notices')!.textContent).not.toContain('Another draft')
  expect(dom.container.querySelector('.note-conversion-backup')).toBeNull()
  await click('Open versions and recovery'); await click('Drafts & recovery (1)', drawer()!)
  expect(drawer()!.textContent).toContain('A separately kept human draft')
  const backup = await disclose('.note-conversion-backup')
  expect(backup.textContent).toContain('Original format backup')
  const oldCurrent = useAppStore.getState().documents[key]!.content
  await click('Use selected draft; keep current', drawer()!)
  expect(useAppStore.getState().documents[key]!.content).toBe(kept.content)
  expect(useAppStore.getState().retainedDocumentDrafts[key]!.some(draft => draft.content === oldCurrent)).toBe(true)
  expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  expect(api.files.write).not.toHaveBeenCalled()
})

it('aggregates overlapping recovery facts into one summary while exposing original requests and conflict actions only in recovery', async () => {
  const current = original(), incoming = content('Incoming agent change')
  current.noteEditing!.attempt = { operationId: 'original-unknown-operation', noteId: 'original', content: content('Original submitted body'), expectedRevision: current.revision, generation: 1, resource, phase: 'unknown' }
  current.noteEditing!.input = { baseContent: baseline, observedContent: incoming, proposedContent: current.content, resource, phase: 'conflict' }
  current.noteProvenance = { status: 'unconfirmed', reason: 'Original authorship metadata unavailable', noteId: 'original', resource, revision: current.revision, blocks: {} }
  useAppStore.setState({ documents: { [key]: current }, documentIssues: { [key]: { kind: 'changed', observed: { path, content: incoming, revision: noteHistoryRevision(incoming) }, noteMerge: { baseContent: baseline, proposedContent: current.content, reason: 'These two changes overlap.' } } } })
  const check = vi.spyOn(useAppStore.getState(), 'refreshDocument').mockResolvedValue(undefined)
  const retry = vi.spyOn(useAppStore.getState(), 'retryNoteInput').mockResolvedValue(undefined)
  const useIncoming = vi.spyOn(useAppStore.getState(), 'reloadDocument').mockResolvedValue(undefined)
  const overwrite = vi.spyOn(useAppStore.getState(), 'overwriteDocument').mockResolvedValue(undefined)
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  await mount()
  expect(dom.container.querySelectorAll('.editor-file-notices [role="status"]')).toHaveLength(1)
  expect(dom.container.querySelector('.note-recovery-summary')!.textContent).toContain('Original save unconfirmed')
  expect(dom.container.querySelector('.note-recovery-summary span')!.getAttribute('title')).toContain('Authorship unconfirmed')
  expect(dom.container.querySelector('[aria-label="Mounted readonly comparison"]')).toBeNull()
  expect([...dom.container.querySelectorAll('button')].some(button => button.textContent === 'Overwrite with this draft')).toBe(false)
  await click('View')
  await vi.waitFor(() => expect(drawer()!.querySelector('[aria-label="Mounted readonly comparison"]')).not.toBeNull())
  expect(drawer()!.textContent).toContain('Original authorship metadata unavailable')
  expect(drawer()!.textContent).toContain(incoming); expect(drawer()!.textContent).toContain(current.content)
  await click('Check original request', drawer()!); expect(check).toHaveBeenCalledWith(workspace.id, path)
  await click('Retry merging input', drawer()!); expect(retry).toHaveBeenCalledWith(tabId, regionId)
  await click('Use incoming; keep this draft', drawer()!); expect(useIncoming).toHaveBeenCalledWith(tabId, regionId)
  await click('Overwrite with this draft', drawer()!); expect(overwrite).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  await click('Overwrite with this draft', drawer()!); expect(overwrite).toHaveBeenCalledWith(tabId, regionId)
  expect(useAppStore.getState().documents[key]!.noteEditing!.attempt!.operationId).toBe('original-unknown-operation')
  expect(api.files.write).not.toHaveBeenCalled()
})

it('routes an explicitly selected historical body through the original confirmation and preserves an unknown outcome without retrying', async () => {
  vi.mocked(useAppStore.getState().applyNoteHistory).mockRejectedValue(Error('The original history operation is unconfirmed; inspect its original request.'))
  await mount(); await click('Open versions and recovery')
  await vi.waitFor(() => expect(drawer()!.querySelector('.note-version-history__activity')).not.toBeNull())
  expect(mounts.diff).toBe(0)
  await disclose('.note-version-history__activity')
  await click('Preview version original-event', drawer()!)
  await vi.waitFor(() => expect(drawer()!.querySelector('[aria-label="Mounted readonly comparison"]')).not.toBeNull())
  expect(api.files.historyPublic).toHaveBeenLastCalledWith({ ...target, eventId: 'original-event', includeContent: true, limit: 50 })
  expect(drawer()!.textContent).toContain(saved.content)
  await click('Restore this entire version…', drawer()!)
  expect(useAppStore.getState().applyNoteHistory).not.toHaveBeenCalled()
  await click('Replace saved document', drawer()!)
  await vi.waitFor(() => expect(drawer()!.textContent).toContain('original history operation is unconfirmed'))
  expect(useAppStore.getState().applyNoteHistory).toHaveBeenCalledWith(tabId, regionId, { target, eventId: 'original-event' })
  await click('Close versions and recovery', drawer()!)
  expect(useAppStore.getState().applyNoteHistory).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().documents[key]!.content).toBe(original().content)
})

it('uses the original saved Note identity for history while Source contains an incomplete header', async () => {
  const invalid = { ...original(), content: '---\nagentmux-note: [unfinished' }
  useAppStore.setState({ documents: { [key]: invalid }, editorRegionModes: { [regionId]: 'edit' } })
  await mount()
  expect(api.files.historyPublic).not.toHaveBeenCalled()
  await click('Open versions and recovery')
  await vi.waitFor(() => expect(useAppStore.getState().inspectNoteHistory).toHaveBeenCalledWith(tabId, regionId, 'original'))
  expect(api.files.historyPublic).toHaveBeenCalledWith({ ...target, limit: 50 })
  expect(drawer()!.textContent).not.toContain('original Note identity is unconfirmed')
  expect(useAppStore.getState().documents[key]!.content).toBe(invalid.content)
})

it('returns Escape focus to the opener and stops hidden activity without stealing focus from a neighboring workface', async () => {
  await mount()
  const opener = await click('Open versions and recovery')
  await vi.waitFor(() => expect(drawer()).not.toBeNull())
  await act(async () => drawer()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await vi.waitFor(() => expect(drawer()).toBeNull())
  await vi.waitFor(() => expect(document.activeElement).toBe(opener))
  await click('Open versions and recovery')
  await vi.waitFor(() => expect(api.files.historyPublic).toHaveBeenCalledTimes(2))
  const neighbor = document.createElement('button'); neighbor.textContent = 'Neighboring Agent input'; document.body.append(neighbor)
  try {
    neighbor.focus(); await mount({ visible: false, active: false })
    expect(drawer()).toBeNull(); expect(document.activeElement).toBe(neighbor)
    await act(async () => useAppStore.setState({ agentNames: { unrelated: 'Other agent' } }))
    expect(api.files.historyPublic).toHaveBeenCalledTimes(2)
  } finally { neighbor.remove() }
})

it('does not attach a late conversion retry failure from another original resource to the current Note', async () => {
  const first = healthy(); first.conversionIssues = [{ noteId: 'original', code: 'NOTE_CONVERSION_UNCONFIRMED', message: 'Original conversion needs retry', resource }]
  vi.mocked(api.notesStorage.inspect).mockResolvedValueOnce(first).mockResolvedValue(healthy())
  let reject!: (reason: unknown) => void
  const late = new Promise<NotesStorageSnapshot>((_resolve, fail) => { reject = fail })
  vi.spyOn(api.notesStorage, 'change').mockImplementation(() => late)
  await mount(); await openDrafts()
  await vi.waitFor(() => expect(drawer()!.textContent).toContain('Original conversion needs retry'))
  await click('Retry original Note conversion', drawer()!)
  const other: FileWorkbenchSurface = { ...surface, path: 'other.note.md' }, otherKey = documentKey(workspace.id, other.path)
  await act(async () => useAppStore.setState({ tabs: { [tabId]: createWorkbenchTab(tabId, other) }, documents: { ...useAppStore.getState().documents, [otherKey]: { path: other.path, content: content('Other resource body', 'other'), revision: noteHistoryRevision(content('Other resource body', 'other')) } } }))
  await mount({ file: other })
  await vi.waitFor(() => expect(api.notesStorage.inspect).toHaveBeenCalledTimes(2))
  await act(async () => { reject(Error('The earlier original resource could not be retried')); await late.catch(() => {}) })
  expect(drawer()).toBeNull()
  expect(dom.container.querySelector('.note-recovery-summary')).toBeNull()
  expect(dom.container.textContent).not.toContain('The earlier original resource could not be retried')
})

it('does not derive the global Note graph for hidden updates and delivers the latest projection when visible again', async () => {
  const derive = vi.spyOn(noteKnowledgeModule, 'noteKnowledge')
  await mount()
  const rich = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Mounted Note input"]')!
  expect(derive).toHaveBeenCalled()
  await mount({ visible: false, active: false })
  const calls = derive.mock.calls.length
  const otherPath = 'unrelated.note.md', otherKey = documentKey(workspace.id, otherPath)
  await act(async () => useAppStore.setState({ documents: { ...useAppStore.getState().documents, [otherKey]: { path: otherPath, content: content('Unrelated loaded knowledge', 'unrelated'), revision: noteHistoryRevision(content('Unrelated loaded knowledge', 'unrelated')) } } }))
  expect(derive).toHaveBeenCalledTimes(calls)
  await act(async () => useAppStore.setState({ documents: { ...useAppStore.getState().documents, [key]: { ...useAppStore.getState().documents[key]!, content: content('Newest original Note while hidden') } } }))
  expect(derive).toHaveBeenCalledTimes(calls)
  expect(rich.getAttribute('data-observed-text')).toBe('Current human input')
  await mount()
  expect(derive.mock.calls.length).toBeGreaterThan(calls)
  expect(dom.container.querySelector('[aria-label="Mounted Note input"]')).toBe(rich)
  expect(rich.getAttribute('data-observed-text')).toBe('Newest original Note while hidden')
  expect(derive.mock.calls.at(-1)![0].map(file => file.document.content)).toEqual(expect.arrayContaining([content('Newest original Note while hidden'), content('Unrelated loaded knowledge', 'unrelated')]))
  expect(mounts).toMatchObject({ rich: 1, richDisposed: 0 })
})
