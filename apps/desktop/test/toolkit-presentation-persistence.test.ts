// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../../../test/fixture-values.mjs'
import type { AppConfig } from '../src/shared/contracts'
import { providerCatalogReader } from './helpers/startup-observation-api-fixture'

const name = 'agentmux-workbench-v1'
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private host' }], executors: {},
  workspaces: [{ id: 'workspace', name: 'Workspace', hostId: 'local', path: fixturePath('toolkit'), kind: 'folder' }], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
let store: typeof import('../src/renderer/src/store').useAppStore
let api: typeof import('../src/renderer/src/lib/api').api
let backing: Map<string, string>, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
let dispose: (() => void) | undefined
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers()
  backing = new Map()
  storage = { getItem: vi.fn(key => backing.get(key) ?? null), setItem: vi.fn((key, value) => { backing.set(key, value) }), removeItem: vi.fn(key => { backing.delete(key) }) }
  vi.spyOn(window, 'localStorage', 'get').mockReturnValue(storage as Storage)
  store = (await import('../src/renderer/src/store')).useAppStore
  api = (await import('../src/renderer/src/lib/api')).api
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [], endpointWarnings: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
})
afterEach(() => { dispose?.(); dispose = undefined; vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers() })
async function initialize() { dispose = await store.getState().initialize(); expect(store.getState().loading).toBe(false); await vi.advanceTimersByTimeAsync(400) }
function persisted() { return JSON.parse(backing.get(name)!).state }

it('writes each tool preference through the actual projection and restores it without changing configuration', async () => {
  await initialize()
  const originalConfig = store.getState().config
  store.getState().setToolkitPresentation('first', { theme: 'nord', size: { width: 950, height: 570 } })
  store.getState().setToolkitPresentation('second', { theme: 'workspace', size: { width: 650, height: 420 } })
  expect(persisted().toolkitPresentation).toEqual({ first: { theme: 'nord', size: { width: 950, height: 570 } }, second: { theme: 'workspace', size: { width: 650, height: 420 } } })
  expect(store.getState().config).toBe(originalConfig)
  dispose?.(); dispose = undefined
  const original = persisted().toolkitPresentation
  store.setState({ toolkitPresentation: {} })
  await store.persist.rehydrate(); await initialize()
  expect(store.getState().toolkitPresentation).toEqual(original)
  store.getState().setToolkitPresentation('first', { theme: null })
  expect(persisted().toolkitPresentation.first).toEqual({ size: { width: 950, height: 570 } })
  expect(persisted().toolkitPresentation.second).toEqual(original.second)
})
it('requests only one platform commit for one completed preference update', async () => {
  await initialize()
  vi.mocked(api.ui.requestStorageFlush).mockClear()
  store.getState().setToolkitPresentation('first', { theme: 'nord' })
  await vi.advanceTimersByTimeAsync(0)
  expect(api.ui.requestStorageFlush).toHaveBeenCalledOnce()
})
it('retains a failed write and current preference, reports through the original save owner, then converges on retry', async () => {
  await initialize()
  const before = backing.get(name)
  vi.mocked(storage.setItem).mockImplementationOnce(() => { throw new Error('Private storage quota unavailable') })
  store.getState().setToolkitPresentation('first', { theme: 'nord', size: { width: 900, height: 500 } })
  expect(store.getState().toolkitPresentation.first).toEqual({ theme: 'nord', size: { width: 900, height: 500 } })
  expect(backing.get(name)).toBe(before)
  expect(store.getState().workbenchSaveWarning).toContain('Private storage quota unavailable')
  await store.getState().retryWorkbenchSave()
  expect(persisted().toolkitPresentation.first).toEqual(store.getState().toolkitPresentation.first)
  expect(store.getState().workbenchSaveWarning).toBeNull()
})
it('does not encode or write for unrelated runtime observations or unchanged presentation choices', async () => {
  await initialize()
  store.getState().setToolkitPresentation('first', { theme: 'nord' })
  await vi.advanceTimersByTimeAsync(400)
  vi.mocked(storage.setItem).mockClear()
  const encode = vi.spyOn(JSON, 'stringify')
  store.setState({ sessions: [] })
  store.getState().setToolkitPresentation('first', { theme: 'nord' })
  await vi.advanceTimersByTimeAsync(400)
  expect(encode).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled()
})
it('restores valid records independently without admitting invalid palettes or dimensions', async () => {
  backing.set(name, JSON.stringify({ version: 1, state: { toolkitPresentation: {
    first: { theme: 'nord', size: { width: 960, height: 500 } }, second: { theme: 'unknown', size: { width: 640, height: 400 } },
    third: { theme: 'workspace', size: { width: -1, height: 300 } }, broken: { size: { width: 0, height: 'bad' } }
  } } }))
  await store.persist.rehydrate(); await initialize()
  expect(store.getState().toolkitPresentation).toEqual({ first: { theme: 'nord', size: { width: 960, height: 500 } }, second: { size: { width: 640, height: 400 } }, third: { theme: 'workspace' } })
})
