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
