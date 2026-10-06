// @vitest-environment happy-dom
const { fixtureEpoch: _newTailFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { applyNotebookChange, emptyNotebookState, type NotesResourceChange } from '@agentmux/core/notebook-store'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { useAppStore, applyNotesStorageSnapshot, registerCreatedNote } from '../src/renderer/src/store'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { reconcileNotesStorageResources, reconcileNotesCreationReceipt } from '../src/renderer/src/lib/notes-storage-reconciliation'
import { reconcileNotesSpatialResources } from '../src/shared/notes-storage-reconciliation'
import { reduceDocumentRead, reduceDocumentReloaded } from '../src/renderer/src/lib/file-workbench-state'
import { RetainedDocumentDraftNotice } from '../src/renderer/src/components/RetainedDocumentDraftNotice'
import { api } from '../src/renderer/src/lib/api'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
vi.hoisted(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
const original = useAppStore.getState()
let root: Root | undefined, container: HTMLDivElement | undefined
const note = newNoteDocument('LATER UNSAVED 中文 INPUT', 'original-note', 'original-block'), raw = JSON.stringify(note), markdown = serializeNoteDocument(note)
const oldRevision = 'sha256:' + 'a'.repeat(64), targetRevision = 'sha256:' + 'b'.repeat(64)
const from = { hostId: 'local', workspaceId: '__scratch__', workspacePath: fixturePath('original-note-root'), path: 'original.note.json' }
const to = { ...from, path: 'original.note.md' }, final = { ...to, workspaceId: '__notes__', workspacePath: fixturePath('notes-root') }
const conversion: NotesResourceChange = { noteId: note.noteId, from, to, conversion: { sourceRevision: oldRevision, targetRevision } }
const move: NotesResourceChange = { noteId: note.noteId, from: to, to: final }
const oldKey = documentKey(from.workspaceId, from.path), key = documentKey(final.workspaceId, final.path)
const unknown = { kind: 'write-unknown' as const, code: 'LOST_RECEIPT', message: 'Unknown original save', attempted: { content: raw + ' ', expectedRevision: oldRevision, generation: 8, resource: { hostId: from.hostId, path: from.workspacePath } } }
function state(attempt = true) {
  const tab = createWorkbenchTab('original-tab', { kind: 'file', regionId: 'original-region', workspaceId: from.workspaceId, path: from.path })
  return { ...original, tabs: { [tab.id]: tab }, layouts: { __scratch__: createWorkspaceLayout('original-group', [tab.id]) },
    documents: { [oldKey]: { path: from.path, content: raw, revision: oldRevision } }, dirtyDocuments: { [oldKey]: true }, documentGenerations: { [oldKey]: 9 },
    documentIssues: attempt ? { [oldKey]: unknown } : {}, savingDocuments: {}, retainedDocumentDrafts: {}, documentRevealTargets: { [oldKey]: { line: 1, noteBlock: { noteId: note.noteId, blockId: 'original-block' } } } }
}
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; container?.remove(); vi.restoreAllMocks(); useAppStore.setState(original, true) })
it('actual storage receipt keeps the original workface, draft, selection and unknown write while adopting exact Markdown resources', async () => {
  useAppStore.setState(state(), true)
  const write = vi.spyOn(api.files, 'write'), observe = vi.spyOn(api.files, 'observe').mockResolvedValue(undefined as never)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  await applyNotesStorageSnapshot({ directory: final.workspacePath, catalogPath: final.workspacePath + '/notebooks.sqlite', operation: null, resourceChanges: [conversion, move], directoryChanges: [] })
  const actual = useAppStore.getState()
  expect(actual.tabs['original-tab']?.regions['original-region']).toMatchObject({ kind: 'file', regionId: 'original-region', workspaceId: final.workspaceId, path: final.path })
  expect(actual.documents[key]).toMatchObject({ content: markdown, revision: oldRevision, noteConversion: { originalContent: raw, originalRevision: oldRevision, source: from, unconfirmedWrite: unknown.attempted } })
  expect(actual.dirtyDocuments[key]).toBe(true)
  expect(actual.documentIssues[key]).toMatchObject({ kind: 'write-unknown', attempted: { content: unknown.attempted.content, expectedRevision: oldRevision } })
  expect(actual.documentRevealTargets[key]?.noteBlock).toEqual({ noteId: note.noteId, blockId: 'original-block' })
  expect(readNoteDocument(actual.documents[key]!.content).status).toBe('valid')
  expect(write).not.toHaveBeenCalled()
  expect(observe).toHaveBeenCalledWith(final.workspaceId, final.path)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<RetainedDocumentDraftNotice tabId="original-tab" surface={actual.tabs['original-tab']!.regions['original-region'] as any} />))
  expect(container.textContent).toContain('original save outcome remains unknown')
  expect(container.textContent).toContain(unknown.attempted.content)
  const options = useAppStore.persist.getOptions(), saved = options.partialize!(actual), restored = options.merge!(saved, original)
  expect(restored.documents[key]?.noteConversion?.unconfirmedWrite).toEqual(unknown.attempted)
})
it('keeps the unknown historical record after explicit current-file checks/reload and persists it when the document becomes clean', () => {
  const moved = reconcileNotesStorageResources(state(), [conversion, move])
  const checked = reduceDocumentRead(moved, final.workspaceId, final.path, { status: 'read', document: { path: final.path, content: markdown, revision: targetRevision } }, moved.documentIssues[key] as typeof unknown)
  const adopted = reduceDocumentReloaded(checked, final.workspaceId, final.path, { path: final.path, content: markdown, revision: targetRevision })
  expect(adopted.documentIssues[key]).toBeUndefined()
  expect(adopted.documents[key]?.noteConversion?.unconfirmedWrite).toEqual(unknown.attempted)
  useAppStore.setState(adopted as typeof original, true)
  const saved = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
  expect(saved.documents?.[key]?.noteConversion?.originalContent).toBe(raw)
})
it('preserves known draft identity and only advances its baseline from the exact conversion receipt', () => {
  const result = reconcileNotesStorageResources(state(false), [conversion, move])
  expect(result.documents[key]).toMatchObject({ content: markdown, revision: targetRevision })
  expect(result.dirtyDocuments[key]).toBe(true)
  const stale = state(false); stale.documents[oldKey]!.revision = 'sha256:' + 'c'.repeat(64)
  expect(reconcileNotesStorageResources(stale, [conversion, move]).documents[key]?.revision).toBe(stale.documents[oldKey]?.revision)
})
it('applies both authoritative resource mappings to spatial and creation identities without changing topology or settling an unknown creation', () => {
  const graph = { regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'file' }], zones: [], resources: { 'region:original-region': { workspaceId: from.workspaceId, path: from.path } } } as any
  const result = reconcileNotesSpatialResources(graph, [conversion, move])
  expect(result.regions).toBe(graph.regions)
  expect(result.resources['region:original-region']).toEqual({ workspaceId: final.workspaceId, path: final.path })
  const receipt = { intentId: 'original-intent', noteId: note.noteId, blockIds: ['original-block'], createdAt: _newTailFixtureEpoch(0, 0, 1), draft: 'LATER UNSAVED 中文 INPUT', path: from.path,
    status: 'unknown', write: { status: 'unknown', code: 'LOST', message: 'Unknown original create' }, revealed: false,
    target: { workspaceId: from.workspaceId, hostId: from.hostId, workspacePath: from.workspacePath, directoryPath: from.workspacePath, relativeDirectory: null, zoneId: 'original-zone', sourceSpaceId: 'original-space', displayWorkspaceId: '__scratch__', groupId: 'original-group' } } as const
  const mapped = reconcileNotesCreationReceipt(receipt as any, [conversion, move], final.workspacePath)
  expect(mapped).toMatchObject({ intentId: receipt.intentId, noteId: receipt.noteId, blockIds: ['original-block'], path: final.path, status: 'unknown', write: receipt.write, target: { workspaceId: final.workspaceId, zoneId: 'original-zone' }, legacyConversion: { path: from.path, expectedRevision: null, write: receipt.write } })
})
it('observes a converted original registration without replaying its old operation against a new resource', async () => {
  let catalog = applyNotebookChange(emptyNotebookState(), { operationId: 'note-register:original-intent', expectedRevision: 0, change: { kind: 'register', noteId: note.noteId, title: 'Original', resource: from } }, { kind: 'user', id: 'original-person' }, 100)
  catalog = applyNotebookChange(catalog, { operationId: 'original-conversion', expectedRevision: catalog.revision, change: { kind: 'relocate', noteId: note.noteId, from, resource: final } }, { kind: 'user', id: 'original-person' }, 110)
  const originalOperation = catalog.operations['note-register:original-intent']
  vi.spyOn(api.notebooks, 'read').mockResolvedValue(catalog)
  const apply = vi.spyOn(api.notebooks, 'apply'), write = vi.spyOn(api.files, 'write')
  const receipt = { intentId: 'original-intent', noteId: note.noteId, blockIds: ['original-block'], createdAt: _newTailFixtureEpoch(0, 0, 1), draft: 'Original', path: from.path,
    status: 'written', revealed: false, target: { ...from, directoryPath: from.workspacePath, relativeDirectory: null, zoneId: 'original-zone', sourceSpaceId: 'original-space', displayWorkspaceId: '__scratch__', groupId: 'original-group' } }
  const mapped = reconcileNotesCreationReceipt(receipt as any, [conversion, move], final.workspacePath)
  expect((await registerCreatedNote(mapped)).notebookRegistered).toBe(true)
  expect(apply).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
  expect(catalog.operations['note-register:original-intent']).toBe(originalOperation)
})
