import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/contracts'
const key = 'agentmux-workbench-v1'
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
let backing: Map<string, string>, store: typeof import('../src/renderer/src/store').useAppStore, api: typeof import('../src/renderer/src/lib/api').api, dispose: (() => void) | undefined
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); backing = new Map()
  vi.stubGlobal('window', { localStorage: { getItem: (name: string) => backing.get(name) ?? null, setItem: (name: string, value: string) => backing.set(name, value), removeItem: (name: string) => backing.delete(name) }, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  store = (await import('../src/renderer/src/store')).useAppStore; api = (await import('../src/renderer/src/lib/api')).api
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue({ catalog: [], warnings: [] })
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
})
afterEach(() => { dispose?.(); dispose = undefined; vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it.each(['absent', 'null'] as const)('hydrates an %s record through the actual Store and admits a real draft checkpoint', async mode => {
  if (mode === 'null') backing.set(key, JSON.stringify({ state: null, version: store.persist.getOptions().version }))
  await store.persist.rehydrate(); expect(store.persist.hasHydrated()).toBe(true)
  dispose = await store.getState().initialize()
  expect(store.getState().loading).toBe(false)
  const documentKey = 'original\0draft.note.json'
  store.setState({ mainSurface: 'recall', documents: { [documentKey]: { path: 'draft.note.json', content: 'Original unsaved draft', revision: 'original-revision' } }, dirtyDocuments: { [documentKey]: true } })
  await (await import('../src/renderer/src/store')).prepareRendererUpdate()
  const saved = JSON.parse(backing.get(key)!)
  expect(saved.state.mainSurface).toBe('recall'); expect(saved.state.documents[documentKey].content).toBe('Original unsaved draft'); expect(saved.state.dirtyDocuments[documentKey]).toBe(true)
  expect(api.ui.requestStorageFlush).toHaveBeenCalled()
})

it('keeps an existing original draft, Note selection and optional avatar handoff while hydrating', async () => {
  const original = { mainSurface: 'recall', recallNotebookId: 'original-book', recallNoteId: 'original-note', documents: { 'original\0note': { path: 'note', content: 'Do not replace my draft', revision: 'original' } }, dirtyDocuments: { 'original\0note': true }, noteBlockSelections: { original: { noteId: 'original-note', blockId: 'original-block' } }, spaceObjectIcons: {} }
  backing.set(key, JSON.stringify({ state: original, version: store.persist.getOptions().version }))
  await store.persist.rehydrate(); expect(store.persist.hasHydrated()).toBe(true)
  for (const name of ['mainSurface', 'recallNotebookId', 'recallNoteId', 'documents', 'dirtyDocuments', 'noteBlockSelections'] as const) expect(store.getState()[name]).toEqual(original[name])
  expect(backing.get(key)).toBe(JSON.stringify({ state: original, version: store.persist.getOptions().version }))
})

it('keeps canonical avatar configuration authoritative while retaining an existing original draft', async () => {
  store.setState({ config: { ...config, appearance: { ...config.appearance, spaceObjectIcons: {} } } })
  backing.set(key, JSON.stringify({ state: { mainSurface: 'survey', launcherNameDrafts: { original: 'My original title' }, spaceObjectIcons: { unknown: 'brain' } }, version: store.persist.getOptions().version }))
  await store.persist.rehydrate(); expect(store.persist.hasHydrated()).toBe(true)
  expect(store.getState().mainSurface).toBe('survey'); expect(store.getState().launcherNameDrafts).toEqual({ original: 'My original title' }); expect(store.getState().spaceObjectIcons).toEqual({})
})

it('keeps an unreadable original record and its write fence instead of treating it as first launch', async () => {
  const unreadable = '{unreadable original workspace record'
  backing.set(key, unreadable)
  dispose = await store.getState().initialize()
  expect(store.persist.hasHydrated()).toBe(false)
  expect(store.getState().error).toContain('Saved workspace state could not be restored')
  store.getState().setRecallSidebarCollapsed(true)
  await vi.advanceTimersByTimeAsync(400)
  expect(backing.get(key)).toBe(unreadable)
})
