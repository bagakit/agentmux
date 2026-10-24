import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import type { ExecutionHost } from '@agentmux/core'
import { applyNotebookChange, emptyNotebookState, parseNotebookState } from '@agentmux/core/notebook-catalog'
import { createWorkspaceLayout } from '@agentmux/layout'

const apiBoundary = vi.hoisted(() => ({ files: { read: vi.fn(), observe: vi.fn(async () => {}), unobserve: vi.fn(async () => {}), write: vi.fn() },
  notebooks: { content: vi.fn() } }))
vi.mock('../../src/renderer/src/lib/api', () => ({ api: apiBoundary }))

import { WorkspaceFiles } from '../../src/main/workspace-files'
import type { AppConfig } from '../../src/shared/contracts'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '../../src/shared/note-document'
import { useAppStore } from '../../src/renderer/src/store'
import { useNotebookLibrary } from '../../src/renderer/src/lib/notebook-library'
import { createWorkbenchTab, documentKey } from '../../src/renderer/src/lib/workbench-tabs'
import { hasFileDocumentConsumer } from '../../src/renderer/src/lib/file-document-consumers'

export const store = useAppStore
export const boundary = apiBoundary
export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const originalState = store.getState(), originalLibrary = useNotebookLibrary.getState()
export const originalStorage = store.persist.getOptions().storage
export const groupId = 'note-retention-group', workspaceId = 'note-retention-workspace'
export const unrelatedTabId = 'unrelated-clean-tab', survivingTabId = 'surviving-tab'
export const sources = Object.fromEntries(['original', 'other', 'shared'].map(name => {
  const noteId = 'retention-' + name, blockId = name + '-block', path = name + '.note.md'
  const note = (text: string) => ({ ...newNoteDocument(text, noteId, blockId), ...(name === 'shared' ? { kind: 'shared-block' as const } : {}) })
  return [name, { noteId, blockId, path, saved: serializeNoteDocument(note('Saved ' + name + ' body.')),
    draft: serializeNoteDocument(note('Unsaved ' + name + ' text, kept with its exact original identity.')) }]
})) as Record<'original' | 'other' | 'shared', { noteId: string; blockId: string; path: string; saved: string; draft: string }>
export type Source = typeof sources.original
export type Fixture = Awaited<ReturnType<typeof noteRetentionFixture>>

/** Main reads real private files. Only IPC transport, watching and write receipts are supplied here. */
export async function noteRetentionFixture(root: string, seed: boolean) {
  const filesRoot = join(root, 'files')
  const workspace = { id: workspaceId, name: 'Note retention', kind: 'folder' as const, hostId: 'local', path: filesRoot }
  const target = (source: Source) => ({ noteId: source.noteId, hostId: workspace.hostId, workspaceId, workspacePath: filesRoot, path: source.path })
  const key = (source: Source) => documentKey(workspaceId, source.path)
  if (seed) {
    await mkdir(filesRoot, { recursive: true })
    let catalog = emptyNotebookState()
    for (const source of Object.values(sources)) {
      await writeFile(join(filesRoot, source.path), source.saved)
      const { noteId, ...resource } = target(source)
      catalog = applyNotebookChange(catalog, { expectedRevision: catalog.revision, operationId: 'register-' + noteId,
        change: { kind: 'register', noteId, title: noteId, resource } }, { kind: 'user', id: 'fixture-user' }, 1)
    }
    const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [workspace],
      appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
    await writeFile(join(root, 'config.json'), JSON.stringify(config))
    await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog))
  }
  const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as AppConfig
  expect(config.workspaces[0]).toEqual(workspace)
  const catalog = parseNotebookState(JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8')))
  useNotebookLibrary.setState({ state: catalog, issue: null })
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' } as ExecutionHost))
  boundary.files.read.mockReset(); boundary.files.observe.mockClear(); boundary.files.unobserve.mockClear(); boundary.files.write.mockReset(); boundary.notebooks.content.mockReset()
  boundary.files.write.mockRejectedValue(new Error('No write authorized in this fixture'))
  boundary.files.read.mockImplementation(async (id: string, path: string) => { expect(id).toBe(workspaceId); return files.read(workspace, path) })
  boundary.notebooks.content.mockImplementation(async (noteId: string) => {
    const page = catalog.pages[noteId]!
    expect(page).toBeDefined()
    const result = await files.read(workspace, page.resource.path)
    expect(result.status).toBe('read')
    if (result.status !== 'read') throw Error('The fixture original was not read')
    const note = readNoteDocument(result.document.content)
    expect(note).toMatchObject({ status: 'valid', note: { noteId } })
    return { status: 'read', actualNoteId: noteId, resource: page.resource }
  })
  const reportError = vi.fn(), releases = new Set<() => void>()
  if (seed) {
    const unrelated = createWorkbenchTab(unrelatedTabId, { regionId: 'unrelated-launcher', kind: 'launcher', workspaceId })
    const surviving = createWorkbenchTab(survivingTabId, { regionId: 'surviving-launcher', kind: 'launcher', workspaceId })
    store.setState({ config, activeWorkspaceId: workspaceId, mainSurface: 'workbench', tabs: { [unrelated.id]: unrelated, [surviving.id]: surviving },
      layouts: { [workspaceId]: createWorkspaceLayout(groupId, [unrelated.id, surviving.id]) }, sessions: [], documents: {}, dirtyDocuments: {}, retainedDocumentDrafts: {},
      documentGenerations: {}, documentObservationGenerations: {}, documentIssues: {}, savingDocuments: {}, closingWorkbenchViews: {}, reportError })
  } else {
    // Host/catalog facts are reread from their original files. No draft, document, Tab or retained state is seeded.
    expect(store.getState().documents).toEqual({})
    store.setState({ config, reportError })
  }
  return { root, files, workspace, catalog, target, key, reportError,
    async observe(source: Source, edit = true) {
      const release = store.getState().observeNoteFile(target(source), 'retention:' + source.noteId)
      releases.add(release)
      await vi.waitFor(() => expect(store.getState().documents[key(source)]).toBeDefined())
      if (edit) store.getState().updateNoteFile(target(source), source.draft, source.saved)
      return () => { releases.delete(release); release() }
    },
    async fileTab(source: Source, edit = true) {
      const tab = createWorkbenchTab('file-' + source.noteId, { regionId: 'region-' + source.noteId, kind: 'file', workspaceId, path: source.path })
      store.setState(state => ({ tabs: { ...state.tabs, [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout(groupId, [...Object.keys(state.tabs), tab.id]) } }))
      await store.getState().attachPersistedFileDocument(workspaceId, source.path)
      expect(store.getState().documents[key(source)]?.content).toBe(source.saved)
      if (edit) store.getState().updateNoteDocument(tab.id, source.draft, source.saved, tab.layout.activeRegionId)
      return tab
    },
    retained(source: Source) {
      const state = store.getState(), id = key(source)
      expect(state.documents[id]?.content).toBe(source.draft)
      expect(state.dirtyDocuments[id]).toBe(true)
      expect(hasFileDocumentConsumer(id)).toBe(false)
      const projected = store.persist.getOptions().partialize!(state) as typeof state
      expect(projected.documents[id]?.content).toBe(source.draft)
      expect(projected.dirtyDocuments[id]).toBe(true)
      return state.documents[id]!
    },
    async originalUnchanged() {
      for (const source of Object.values(sources)) expect(await readFile(join(filesRoot, source.path), 'utf8')).toBe(source.saved)
      expect(useNotebookLibrary.getState().state).toBe(catalog)
      expect(reportError).not.toHaveBeenCalled()
    },
    async dispose() { for (const release of releases) release(); releases.clear(); await files.dispose() }
  }
}

export function restoreRetentionState() {
  store.persist.setOptions({ storage: originalStorage })
  store.setState(originalState, true); useNotebookLibrary.setState(originalLibrary, true)
}
