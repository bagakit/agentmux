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

it('awaits one explicit palette platform commit without changing another tool or clearing an unresolved workbench warning', async () => {
  await initialize()
  const { saveToolkitPalette } = await import('../src/renderer/src/store')
  const config = store.getState().config
  store.getState().reportWorkbenchSaveFailure(Error('Original spatial commit is still unconfirmed'))
  vi.mocked(api.ui.requestStorageFlush).mockClear()
  await saveToolkitPalette('first', 'nord', null)
  expect(api.ui.requestStorageFlush).toHaveBeenCalledOnce()
  expect(persisted().toolkitPresentation.first.theme).toBe('nord')
  expect(store.getState().workbenchSaveWarning).toContain('Original spatial commit is still unconfirmed')
  expect(store.getState().workbenchSaveWarningOwner).toBe('workbench')
  expect(store.getState().config).toBe(config)
  expect(persisted().toolkitPresentation.second).toBeUndefined()
})

it('keeps a newer local save failure when an older full-workbench platform receipt arrives', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { AgentMuxSpatialStateStore } = await import('../../../packages/core/src/spatial-state')
  const { desktopSpatialGraph } = await import('../src/renderer/src/lib/desktop-spatial-state')
  const root = await mkdtemp(join(tmpdir(), 'amx-palette-spatial-'))
  try {
    const owner = new AgentMuxSpatialStateStore(join(root, 'state.json'))
    await owner.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ config, sessions: [], tabs: {}, layouts: {}, spaceZoneBindings: {}, spatialRequests: {} }, []) })
    vi.spyOn(api.spatial, 'read').mockImplementation(() => owner.read())
    vi.spyOn(api.spatial, 'commit').mockImplementation(input => owner.commit(input))
    vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => owner.subscribe(listener))
    await initialize()
    // This scenario starts after unrelated preview-only naming ports have settled.
    store.setState({ workbenchSaveWarning: null, workbenchSaveWarningOwner: null })
    await vi.advanceTimersByTimeAsync(400)
    let resolve!: () => void
    vi.mocked(api.ui.requestStorageFlush).mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
    const older = store.getState().retryWorkbenchSave()
    await vi.advanceTimersByTimeAsync(0)
    expect(resolve).toBeTypeOf('function')
    const { saveToolkitPalette } = await import('../src/renderer/src/store')
    vi.mocked(api.ui.requestStorageFlush).mockRejectedValueOnce(Error('Newer palette platform commit failed'))
    await expect(saveToolkitPalette('first', 'nord', null)).rejects.toThrow('Newer palette platform commit failed')
    resolve(); await older
    expect(store.getState().workbenchSaveWarning).toContain('Newer palette platform commit failed')
    expect(store.getState().workbenchSaveWarningOwner).toBe('local-storage')
  } finally { await rm(root, { recursive: true, force: true }) }
})
