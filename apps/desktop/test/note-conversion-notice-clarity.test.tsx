// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import type { NotesResourceChange } from '@agentmux/core/notebook-store'
import { newNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import type { FileDocument } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, documentKey, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { reconcileNotesStorageResources } from '../src/renderer/src/lib/notes-storage-reconciliation'
import { useAppStore } from '../src/renderer/src/store'
import { RetainedDocumentDraftNotice } from '../src/renderer/src/components/RetainedDocumentDraftNotice'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

vi.hoisted(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
const original = useAppStore.getState()
const from = { hostId: 'local', workspaceId: 'conversion-workspace', workspacePath: fixturePath('note-conversion-clarity'), path: 'original.note.json' }
const to = { ...from, path: 'original.note.md' }
const oldKey = documentKey(from.workspaceId, from.path), key = documentKey(to.workspaceId, to.path)
const raw = JSON.stringify(newNoteDocument('原输入\nkept intact', 'original-note', 'original-block'))
const markdown = serializeNoteDocument(newNoteDocument('原输入\nkept intact', 'original-note', 'original-block'))
const change: NotesResourceChange = { noteId: 'original-note', from, to, conversion: { sourceRevision: 'source-revision', targetRevision: 'markdown-revision' } }
const unknown = { kind: 'write-unknown' as const, code: 'LOST_RECEIPT', message: 'Original save unconfirmed', attempted: {
  content: raw + ' ', expectedRevision: 'source-revision', generation: 2, resource: { hostId: from.hostId, path: from.workspacePath }
} }
let root: Root | undefined, container: HTMLDivElement

beforeEach(() => {
  vi.spyOn(api.notesStorage, 'inspect').mockResolvedValue({ directory: to.workspacePath, catalogPath: to.workspacePath + '/notebooks.sqlite', operation: null, resourceChanges: [], directoryChanges: [] })
  vi.spyOn(api.notesStorage, 'onChange').mockReturnValue(() => {})
  container = document.createElement('div'); document.body.append(container)
})
afterEach(async () => {
  if (root) await act(() => root!.unmount())
  root = undefined; container.remove(); vi.restoreAllMocks(); useAppStore.setState(original, true)
})
function converted(dirty: boolean, withUnknown = false): typeof original {
  const tab = createWorkbenchTab('conversion-tab', { kind: 'file', regionId: 'conversion-region', workspaceId: from.workspaceId, path: from.path })
  return reconcileNotesStorageResources({ ...original, tabs: { [tab.id]: tab }, documents: { [oldKey]: { path: from.path, content: raw, revision: 'source-revision' } },
    dirtyDocuments: { [oldKey]: dirty }, documentIssues: withUnknown ? { [oldKey]: unknown } : {}, documentGenerations: { [oldKey]: 3 },
    documentObservationGenerations: {}, savingDocuments: {}, retainedDocumentDrafts: {} }, [change])
}
async function mount() {
  const surface = useAppStore.getState().tabs['conversion-tab']!.regions['conversion-region'] as FileWorkbenchSurface
  root = createRoot(container)
  await act(async () => root!.render(<RetainedDocumentDraftNotice tabId="conversion-tab" surface={surface} />))
}

it.each([
  [false, 'Backup before Markdown conversion'],
  [true, 'Unsaved draft kept before Markdown conversion'],
  [undefined, 'Content kept before Markdown conversion']
] as const)('uses only the recorded original dirty fact (%s) and keeps an accessible collapsed backup', async (dirty, label) => {
  const state = converted(dirty === true)
  if (dirty === undefined) delete state.documents[key]!.noteConversion!.wasDirty
  useAppStore.setState(state, true)
  const write = vi.spyOn(api.files, 'write')
  await mount()
  const details = container.querySelector('details')!
  expect(details.open).toBe(false)
  expect(details.querySelector('summary')?.textContent).toBe(label)
  expect(details.classList.contains('editor-file-notice')).toBe(false)
  expect(details.classList.contains('note-conversion-backup--unsaved')).toBe(dirty === true)
  expect(container.querySelector('[role="status"]')).toBeNull()
  details.open = true
  expect(details.querySelector('pre')?.textContent).toBe(raw)
  if (dirty === undefined) expect(details.textContent).toContain('was not recorded')
  if (dirty === false) expect(details.textContent).toContain('does not indicate a failed conversion')
  await act(async () => useAppStore.getState().updateDocument('conversion-tab', markdown + '\nLater draft', 'conversion-region'))
  expect(details.querySelector('summary')?.textContent).toBe(label)
  const options = useAppStore.persist.getOptions()
  const hydrated = options.merge!(options.partialize!(useAppStore.getState()), original)
  expect(hydrated.documents[key]?.noteConversion).toEqual(state.documents[key]?.noteConversion)
  expect(write).not.toHaveBeenCalled()
})

it('does not invent the original dirty fact for an already retained buffer', () => {
  const state = converted(false)
  state.documents[key]!.content = raw
  delete state.documents[key]!.noteConversion
  state.retainedDocumentDrafts = { [key]: [{ path: to.path, content: raw, revision: 'earlier-retained-revision' }] }
  const convertedAgain = reconcileNotesStorageResources(state, [{ ...change, from: to }])
  expect(convertedAgain.retainedDocumentDrafts[key]?.[0]?.noteConversion?.originalContent).toBe(raw)
  expect(convertedAgain.retainedDocumentDrafts[key]?.[0]?.noteConversion?.wasDirty).toBeUndefined()
})

it('keeps historical save uncertainty visible through real current-file checks, reload, later edit/save and persistence', async () => {
  const state = converted(true, true)
  const config = await api.config.get()
  useAppStore.setState({ ...state, config: { ...config, workspaces: [{ id: to.workspaceId, name: 'Notes', hostId: to.hostId, path: to.workspacePath, kind: 'folder' }] } }, true)
  const read = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: { path: to.path, content: markdown, revision: 'markdown-revision' } })
  const write = vi.spyOn(api.files, 'write').mockImplementation(async (_workspace, params) => ({ status: 'written', revision: noteHistoryRevision(params.content), content: params.content }))
  await mount()
  const checkNotice = () => {
    expect(container.querySelector('details')?.open).toBe(false)
    const notice = container.querySelector('.note-conversion-unknown[role="status"]')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('original save outcome remains unknown')
    expect(container.querySelector('details')?.contains(container.querySelector('[role="status"]'))).toBe(false)
    expect(useAppStore.getState().documents[key]?.noteConversion?.unconfirmedWrite).toEqual(unknown.attempted)
  }
  checkNotice()
  await act(async () => { await useAppStore.getState().reloadDocument('conversion-tab', 'conversion-region') })
  expect(read).toHaveBeenCalledWith(to.workspaceId, to.path)
  expect(useAppStore.getState().documentIssues[key]?.kind).toBe('changed')
  await act(async () => { await useAppStore.getState().reloadDocument('conversion-tab', 'conversion-region') })
  checkNotice()
  await act(async () => {
    useAppStore.getState().updateDocument('conversion-tab', markdown + '\nLater edit', 'conversion-region')
    await useAppStore.getState().saveDocument('conversion-tab', 'conversion-region')
  })
  expect(write).toHaveBeenCalledTimes(1)
  expect(write).toHaveBeenCalledWith(to.workspaceId, { path: to.path, content: markdown + '\nLater edit', expectedRevision: 'markdown-revision' })
  expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
  checkNotice()
  const options = useAppStore.persist.getOptions()
  const hydrated = options.merge!(options.partialize!(useAppStore.getState()), original)
  expect(hydrated.documents[key]?.noteConversion).toEqual(state.documents[key]?.noteConversion)
  await act(async () => useAppStore.setState(hydrated, true))
  checkNotice()
})

it('selects a kept conversion draft through the real notice and preserves both original backups and later current input', async () => {
  const state = converted(true, true)
  const selected = state.documents[key]!
  const otherBackup: NonNullable<FileDocument['noteConversion']> = { originalContent: 'DESTINATION ORIGINAL', originalRevision: 'destination-original-revision', source: to, wasDirty: false }
  state.documents[key] = { ...selected, content: 'CURRENT DESTINATION', revision: 'current-destination-revision', noteConversion: otherBackup }
  state.retainedDocumentDrafts = { [key]: [selected] }
  state.documentIssues = {}
  useAppStore.setState(state, true)
  const write = vi.spyOn(api.files, 'write')
  await mount()
  await act(async () => {
    useAppStore.getState().updateDocument('conversion-tab', 'LATER CURRENT INPUT', 'conversion-region')
    const drafts = container.querySelector<HTMLDetailsElement>('.note-version-history')!
    drafts.open = true; drafts.dispatchEvent(new Event('toggle'))
  })
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use selected draft; keep current')!.click())
  expect(useAppStore.getState().documents[key]).toMatchObject({ content: markdown, revision: 'current-destination-revision', noteConversion: selected.noteConversion })
  expect(useAppStore.getState().retainedDocumentDrafts[key]?.[0]).toMatchObject({ content: 'LATER CURRENT INPUT', noteConversion: otherBackup })
  expect(container.querySelector('[role="status"].note-conversion-unknown')?.textContent).toContain('original save outcome remains unknown')
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use selected draft; keep current')!.click())
  expect(useAppStore.getState().documents[key]).toMatchObject({ content: 'LATER CURRENT INPUT', noteConversion: otherBackup })
  expect(useAppStore.getState().retainedDocumentDrafts[key]?.[0]?.noteConversion).toEqual(selected.noteConversion)
  expect(container.querySelector('.note-conversion-unknown')?.textContent).toContain('A kept draft contains its original input')
  expect(container.querySelector('.note-conversion-unknown')?.textContent).toContain('original save outcome remains unknown')
  expect(write).not.toHaveBeenCalled()
})
