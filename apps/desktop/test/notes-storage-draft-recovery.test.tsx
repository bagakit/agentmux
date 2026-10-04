const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, documentKey, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { reconcileNotesStorageResources } from '../src/renderer/src/lib/notes-storage-reconciliation'
import { reduceDocumentRead, reduceFileRename } from '../src/renderer/src/lib/file-workbench-state'
import { RetainedDocumentDraftNotice } from '../src/renderer/src/components/RetainedDocumentDraftNotice'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
const original = useAppStore.getState()
let root: Root | undefined, container: HTMLDivElement | undefined
const from = { hostId: 'local', workspaceId: '__scratch__', workspacePath: _hygiene_fixturePath("old"), path: 'original.note.json' }
const to = { ...from, workspaceId: '__notes__', workspacePath: _hygiene_fixturePath("notes") }
const oldKey = documentKey(from.workspaceId, from.path), key = documentKey(to.workspaceId, to.path)
const change = { noteId: 'original-note', from, to }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); container = undefined; vi.restoreAllMocks(); useAppStore.setState(original, true) })
function restoredConflict() {
  const tab = createWorkbenchTab('original-tab', { kind: 'file', regionId: 'original-region', workspaceId: from.workspaceId, path: from.path })
  const layout = createWorkspaceLayout('original-group', [tab.id])
  return reconcileNotesStorageResources({ ...original, tabs: { [tab.id]: tab }, layouts: { [from.workspaceId]: layout },
    documents: { [oldKey]: { path: from.path, content: 'SOURCE UNSAVED', revision: 'source-disk' }, [key]: { path: to.path, content: 'DESTINATION UNSAVED', revision: 'destination-disk' } },
    dirtyDocuments: { [oldKey]: true, [key]: true }, retainedDocumentDrafts: {}, documentIssues: {}, documentGenerations: { [key]: 5 } }, [change])
}
it('recovers either kept draft through a visible File owner, preserving later input and the current resource revision', async () => {
  useAppStore.setState(restoredConflict(), true)
  const write = vi.spyOn(api.files, 'write')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const surface = useAppStore.getState().tabs['original-tab']!.regions['original-region'] as FileWorkbenchSurface
  await act(async () => root!.render(<RetainedDocumentDraftNotice tabId="original-tab" surface={surface} />))
  expect(container.textContent).toContain('Another draft was kept')
  expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
  await act(async () => {
    useAppStore.getState().updateDocument('original-tab', 'LATER DESTINATION INPUT', 'original-region')
    useAppStore.setState(reconcileNotesStorageResources(useAppStore.getState(), [change]))
  })
  expect(useAppStore.getState().documents[key]?.content).toBe('LATER DESTINATION INPUT')
  expect(useAppStore.getState().retainedDocumentDrafts[key]).toHaveLength(1)
  await act(async () => container!.querySelector('button')!.click())
  expect(useAppStore.getState().documents[key]).toMatchObject({ content: 'SOURCE UNSAVED', revision: 'destination-disk' })
  expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  expect(useAppStore.getState().retainedDocumentDrafts[key]?.[0]?.content).toBe('LATER DESTINATION INPUT')
  expect(useAppStore.getState().documentGenerations[key]).toBe(7)
  await act(async () => useAppStore.setState(reconcileNotesStorageResources(useAppStore.getState(), [change])))
  expect(useAppStore.getState().documents[key]?.revision).toBe('destination-disk')
  expect(useAppStore.getState().retainedDocumentDrafts[key]?.[0]?.content).toBe('LATER DESTINATION INPUT')
  await act(async () => container!.querySelector('button')!.click())
  expect(useAppStore.getState().documents[key]?.content).toBe('LATER DESTINATION INPUT')
  expect(useAppStore.getState().retainedDocumentDrafts[key]?.[0]?.content).toBe('SOURCE UNSAVED')
  expect(write).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs['original-tab']?.regions['original-region']).toMatchObject({ workspaceId: to.workspaceId, regionId: 'original-region' })
})
it('keeps both recoverable drafts through a real disk observation, persistence hydration and original file rename', () => {
  const mapped = restoredConflict()
  const read = reduceDocumentRead(mapped, to.workspaceId, to.path, { status: 'read', document: { path: to.path, content: 'ACTUAL DISK', revision: 'actual-disk' } })
  expect(read.documentIssues[key]).toMatchObject({ kind: 'changed', observed: { content: 'ACTUAL DISK' } })
  useAppStore.setState({ ...mapped, ...read }, true)
  const options = useAppStore.persist.getOptions(), saved = options.partialize!(useAppStore.getState()), hydrated = options.merge!(saved, original)
  expect(hydrated.retainedDocumentDrafts[key]?.[0]?.content).toBe('SOURCE UNSAVED')
  expect(hydrated.documents[key]?.content).toBe('DESTINATION UNSAVED')
  const renamed = reduceFileRename(hydrated, to.workspaceId, to.path, 'renamed.note.json')
  expect(renamed.retainedDocumentDrafts?.[documentKey(to.workspaceId, 'renamed.note.json')]?.[0]).toMatchObject({ content: 'SOURCE UNSAVED', path: 'renamed.note.json' })
})
it('releases the old pending save after exact Note relocation and checks the current file before retrying', async () => {
  const initial = restoredConflict(), tab = initial.tabs['original-tab']!
  useAppStore.setState({ ...original, config: { ...await api.config.get(), workspaces: [{ id: from.workspaceId, hostId: 'local', kind: 'folder', path: from.workspacePath, name: 'Topics' }, { id: to.workspaceId, hostId: 'local', kind: 'folder', path: to.workspacePath, name: 'Recall' }] },
    tabs: { [tab.id]: { ...tab, regions: { ...tab.regions, 'original-region': { kind: 'file', regionId: 'original-region', workspaceId: from.workspaceId, path: from.path } } } },
    layouts: initial.layouts, documents: { [oldKey]: { path: from.path, content: 'ORIGINAL UNSAVED', revision: 'old-disk' } }, dirtyDocuments: { [oldKey]: true } }, true)
  let written!: () => void
  const write = vi.spyOn(api.files, 'write').mockImplementation(() => new Promise(resolve => { written = () => resolve({ status: 'written', revision: 'written-old-root' }) }))
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'observe').mockResolvedValue({ status: 'unavailable' } as never)
  const saving = useAppStore.getState().saveDocument(tab.id, 'original-region')
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
  await (await import('../src/renderer/src/store')).applyNotesStorageSnapshot({ directory: to.workspacePath, catalogPath: to.workspacePath + '/notebooks.json', operation: null, resourceChanges: [change], directoryChanges: [] })
  written(); await saving
  expect(useAppStore.getState().savingDocuments[key]).toBe(false)
  expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  expect(useAppStore.getState().documents[key]?.revision).toBe('old-disk')
  expect(useAppStore.getState().documentIssues[key]).toMatchObject({ kind: 'read-error', code: 'NOTE_SAVE_RELOCATED' })
  const read = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: { path: to.path, content: 'ORIGINAL UNSAVED', revision: 'current-disk' } })
  await useAppStore.getState().reloadDocument(tab.id, 'original-region')
  expect(read).toHaveBeenCalledWith(to.workspaceId, to.path)
  expect(useAppStore.getState().documentIssues[key]).toMatchObject({ kind: 'changed', observed: { content: 'ORIGINAL UNSAVED', revision: 'current-disk' } })
  expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  await useAppStore.getState().reloadDocument(tab.id, 'original-region')
  expect(useAppStore.getState().documents[key]?.revision).toBe('current-disk')
  expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
  expect(write).toHaveBeenCalledTimes(1)
})
it('checks the exact moved write-unknown resource without inventing a saved result', async () => {
  const mapped = restoredConflict(), tab = mapped.tabs['original-tab']!
  const unknown = { kind: 'write-unknown' as const, code: 'NO_RECEIPT', message: 'No save receipt', attempted: { content: 'EXACT ATTEMPT', expectedRevision: 'old-disk', generation: 5, resource: { hostId: from.hostId, path: from.workspacePath } } }
  const result = reconcileNotesStorageResources({ ...original, config: { ...await api.config.get(), workspaces: [{ id: to.workspaceId, hostId: 'local', kind: 'folder', path: to.workspacePath, name: 'Recall' }] },
    tabs: { [tab.id]: { ...tab, regions: { ...tab.regions, 'original-region': { kind: 'file', regionId: 'original-region', workspaceId: from.workspaceId, path: from.path } } } },
    documents: { [oldKey]: { path: from.path, content: 'LATER INPUT', revision: 'old-disk' } }, dirtyDocuments: { [oldKey]: true }, documentGenerations: { [oldKey]: 6 }, documentIssues: { [oldKey]: unknown } }, [change])
  useAppStore.setState(result, true)
  expect(useAppStore.getState().documentIssues[key]).toMatchObject({ kind: 'write-unknown', attempted: { content: 'EXACT ATTEMPT', resource: { path: to.workspacePath } } })
  expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  const read = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: { path: to.path, content: 'EXACT ATTEMPT', revision: 'current-disk' } })
  await useAppStore.getState().reloadDocument(tab.id, 'original-region')
  expect(read).toHaveBeenCalledWith(to.workspaceId, to.path)
  expect(useAppStore.getState().documents[key]?.content).toBe('LATER INPUT')
  expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
})
it('does not authorize checking an unknown save that belongs to another resource', () => {
  const initial = restoredConflict(), tab = initial.tabs['original-tab']!
  const issue = { kind: 'write-unknown' as const, code: 'NO_RECEIPT', message: 'No receipt', attempted: { content: 'UNKNOWN ATTEMPT', expectedRevision: 'disk', generation: 1, resource: { hostId: 'remote', path: _hygiene_fixturePath("foreign") } } }
  const mapped = reconcileNotesStorageResources({ ...original, tabs: { [tab.id]: { ...tab, regions: { ...tab.regions, 'original-region': { kind: 'file', regionId: 'original-region', workspaceId: from.workspaceId, path: from.path } } } },
    documents: { [oldKey]: { path: from.path, content: 'ORIGINAL DRAFT', revision: 'disk' } }, dirtyDocuments: { [oldKey]: true }, documentIssues: { [oldKey]: issue } }, [change])
  expect(mapped.documentIssues[key]).toEqual(issue)
  expect(mapped.dirtyDocuments[key]).toBe(true)
})
