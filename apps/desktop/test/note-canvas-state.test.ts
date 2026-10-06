import { fixtureEpoch as _tailRefreshFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig } from '../src/shared/contracts'
import type { NotebookPage } from '@agentmux/core/notebook-catalog'
import { newNoteDocument } from '../src/shared/note-document'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { openNotebookPage } from '../src/renderer/src/lib/recall-notebooks'
import { defaultNoteCanvasLayout, mergeNoteCanvasLayout, noteCanvasScopeKey, restoreNoteCanvasLayouts } from '../src/renderer/src/lib/note-canvas-state'
import { restorePersistedUiState, saveNoteCanvasPresentation, useAppStore } from '../src/renderer/src/store'

const initial = useAppStore.getState(), workspacePath = join(tmpdir(), 'agentmux-canvas-fixture')
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {},
  workspaces: [{ id: 'canvas-workspace', name: 'Notes', hostId: 'local', path: workspacePath, kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const scope = { kind: 'note' as const, noteId: 'kept-note' }, key = noteCanvasScopeKey(scope)
const layout = { positions: { 'kept-note': { x: 421, y: -73 }, other: { x: -950, y: 711 } }, viewport: { x: -91, y: 36, zoom: 0.8 }, expandedNoteIds: ['kept-note', 'other'], previewNoteIds: ['other'] }
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initial, true) })

it('round trips the real original UI serialization without losing canvas choices, documents or workspaces', () => {
  const document = { path: 'kept.note.json', revision: 'original', content: 'Unsaved original draft' }
  useAppStore.setState({ config, noteCanvasLayouts: { [key]: layout }, documents: { kept: document }, dirtyDocuments: { kept: true } })
  const serialized = JSON.parse(JSON.stringify(useAppStore.persist.getOptions().partialize!(useAppStore.getState())))
  expect(serialized.noteCanvasLayouts).toEqual({ [key]: layout })
  expect(serialized.documents).toEqual({ kept: document })
  const restored = restorePersistedUiState(config, serialized)
  expect(restored.noteCanvasLayouts).toEqual({ [key]: layout })
  const merged = useAppStore.persist.getOptions().merge!(serialized, initial)
  expect(merged.noteCanvasLayouts).toEqual({ [key]: layout })
})

it('keeps manual geometry through neighbor and preview toggles, and distinguishes collapsed from never opened', () => {
  const changed = mergeNoteCanvasLayout(layout, { expandedNoteIds: [], previewNoteIds: ['kept-note'] })
  expect(changed.positions).toBe(layout.positions)
  expect(changed.viewport).toBe(layout.viewport)
  expect(changed.expandedNoteIds).toEqual([])
  expect(restoreNoteCanvasLayouts({ [key]: changed })).toEqual({ [key]: changed })
  expect(defaultNoteCanvasLayout(scope).expandedNoteIds).toEqual(['kept-note'])
  expect(noteCanvasScopeKey({ kind: 'notebook', notebookId: scope.noteId })).not.toBe(key)
})

it('retains valid scopes and coordinates independently of malformed optional fields without count truncation', () => {
  const positions = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => ['note-' + i, { x: i * 10, y: -i }]))
  expect(Object.keys(restoreNoteCanvasLayouts({ large: { positions, expandedNoteIds: [], previewNoteIds: [] } }).large!.positions)).toHaveLength(1200)
  expect(restoreNoteCanvasLayouts({ [key]: { ...layout, viewport: { x: 0, y: 0, zoom: -1 } }, invalid: null })).toEqual({ [key]: { positions: layout.positions, expandedNoteIds: layout.expandedNoteIds, previewNoteIds: layout.previewNoteIds } })
})

it('keeps an interactive layout and explicit retry state when original presentation saving is unavailable', async () => {
  useAppStore.setState({ noteCanvasLayouts: {}, noteCanvasSaveIssues: {} })
  await saveNoteCanvasPresentation(scope, layout)
  expect(useAppStore.getState().noteCanvasLayouts).toEqual({ [key]: layout })
  // Cold hydration has not authorized writes; the existing original record is retained.
  expect(useAppStore.getState().noteCanvasSaveIssues[key]).toContain('current positions are kept')
  await saveNoteCanvasPresentation(scope, { previewNoteIds: [] })
  expect(useAppStore.getState().noteCanvasLayouts[key]!.positions).toEqual(layout.positions)
})

function seedOriginalNote() {
  const workspaceId = 'canvas-workspace', path = 'original.note.json', spaceId = directoryIdentity('local', workspacePath), zoneId = homeZoneId(spaceId)
  const note = newNoteDocument('Original disk text', scope.noteId, 'original-block')
  const tab = { ...createWorkbenchTab('original-tab', { kind: 'file', regionId: 'original-region', workspaceId, path }), space: { spaceId, zoneId } }
  const docKey = documentKey(workspaceId, path), document = { path, content: JSON.stringify(note).replace('Original disk text', 'Kept unsaved draft'), revision: 'base' }
  useAppStore.setState({ config, loading: false, mainSurface: 'recall', activeWorkspaceId: workspaceId, recallNotebookId: 'quick-notes', recallNoteId: scope.noteId,
    recallZoneSelection: null, tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('original-group', [tab.id]) },
    documents: { [docKey]: document }, dirtyDocuments: { [docKey]: true }, documentRevealTargets: {} })
  vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: { path, content: JSON.stringify(note), revision: 'base' } })
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  const page: NotebookPage = { noteId: note.noteId, notebookId: 'quick-notes', parentNoteId: null, title: 'Original Note', createdAt: _tailRefreshFixtureEpoch(0, 0, 1), updatedAt: _tailRefreshFixtureEpoch(0, 0, 1), sources: [], topics: [],
    resource: { hostId: 'local', workspaceId, workspacePath, path }, workface: { zoneId, workspaceId } }
  return { page, docKey, document, tab }
}
it('opens an exact original block through the real Note/File consumer while preserving its unsaved draft and Region', async () => {
  const { page, docKey, document, tab } = seedOriginalNote()
  const target = { noteId: page.noteId, blockId: 'original-block' }
  const tabs = useAppStore.getState().tabs
  await expect(openNotebookPage(page, undefined, undefined, target)).resolves.toBe(true)
  expect(useAppStore.getState().documentRevealTargets[docKey]).toMatchObject({ noteBlock: target })
  expect(useAppStore.getState().documents[docKey]).toEqual(document)
  expect(useAppStore.getState().dirtyDocuments[docKey]).toBe(true)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([tab.id])
  expect(useAppStore.getState().tabs[tab.id]!.regions).toEqual(tabs[tab.id]!.regions)
})

it('rejects only a mismatched block operation before reading or moving the original healthy Note', async () => {
  const { page, docKey, document } = seedOriginalNote()
  await expect(openNotebookPage(page, undefined, undefined, { noteId: 'other-note', blockId: 'original-block' })).rejects.toThrow('another Note')
  expect(api.files.read).not.toHaveBeenCalled()
  expect(useAppStore.getState().documents[docKey]).toEqual(document)
  expect(useAppStore.getState().documentRevealTargets).toEqual({})
})
