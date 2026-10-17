// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, BrowserProfileDeleteApproval } from '../src/shared/contracts.js'
import type { BrowserRecoveryPreview, BrowserRecoveryPreviewScope } from '../src/shared/browser-recovery-preview.js'
import type { BrowserRecoveryPreviewStore } from '../src/main/browser-recovery-preview.js'
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'

type NativeOwner = { workspaceId: string | null; storage: { mode: 'normal'; profileId: string } | { mode: 'private'; profileId: null } }
const bridge = vi.hoisted(() => ({
  root: '', api: null as AgentMuxPreloadApi | null, invoke: vi.fn(),
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  owners: new Map<string, NativeOwner>(), released: new Map<string, NativeOwner>(),
  previews: null as BrowserRecoveryPreviewStore | null, manager: null as unknown
}))
vi.mock('electron', () => ({
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), off: vi.fn() },
  app: { getPath: () => bridge.root || tmpdir(), getAppPath: () => process.cwd(), isPackaged: false },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => bridge.handlers.set(channel, handler),
    removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn(), removeListener: vi.fn() },
  webFrame: { getZoomFactor: () => 1 }, clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, safeStorage: {},
  session: { fromPartition: () => ({ clearStorageData: async () => {}, clearCache: async () => {}, flushStorageData() {} }) }
}))
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('../src/main/connector-host.js', () => ({ createDesktopConnections: async () => ({
  connections: { list: async () => [] }, secrets: {}, close: async () => {}
}) }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
vi.mock('../src/main/browser-view-manager.js', async original => {
  const actual = await original<typeof import('../src/main/browser-view-manager.js')>()
  return { ...actual, BrowserViewManager: class extends actual.BrowserViewManager {
    constructor(...args: ConstructorParameters<typeof actual.BrowserViewManager>) {
      super(...args)
      bridge.manager = this
      bridge.previews = args.at(-1) as BrowserRecoveryPreviewStore
      // Only native owner Sources are doubled. Production scope resolution and Main handlers stay real.
      Object.assign(this, { entries: bridge.owners, releasedEntries: bridge.released })
    }
    dispose() { bridge.owners.clear(); bridge.released.clear(); super.dispose() }
  } }
})

import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import type { AgentMuxSpatialGraph, AgentMuxSpatialState } from '@agentmux/core/spatial-graph'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { ScratchTopics } from '../src/main/scratch-topics.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { registerIpc } from '../src/main/ipc.js'
import '../src/preload/index.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); bridge.invoke.mockReset()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
function savedGraph(id: string, profileId?: string, privateMode = false): AgentMuxSpatialGraph {
  return { spaces: [], zones: [], bindings: [], locations: [], layouts: {}, tabLayouts: {},
    tabs: [{ tabId: 'saved-tab', workspaceId: 'workspace', regionIds: ['saved-region'] }],
    regions: [{ tabId: 'saved-tab', regionId: 'saved-region', kind: 'browser', browserId: id }],
    resources: { 'region:saved-region': { browserId: id, workspaceId: 'workspace', url: 'https://preview.invalid/failed',
      title: 'Current failed target', mode: privateMode ? 'private' : 'normal', ...(profileId ? { profileId } : {}) } }
  } as unknown as AgentMuxSpatialGraph
}
function preview(scope: BrowserRecoveryPreviewScope): BrowserRecoveryPreview {
  return { scope, url: 'https://preview.invalid/older-view', title: 'Old viewed title', navigationId: 'old-document', capturedAt: 1,
    image: { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 320, height: 200 } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-recovery-preview-ipc-'))
  roots.push(root); bridge.root = root; bridge.handlers.clear(); bridge.owners.clear(); bridge.released.clear()
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(root, 'spatial-state.json'))
  const spatialRead = vi.spyOn(AgentMuxSpatialStateStore.prototype, 'read').mockResolvedValue(null)
  const config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [
    { id: 'workspace', name: 'Preview fixture', hostId: 'local', path: root, kind: 'folder' as const }
  ] }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] })
  const sender = Object.assign(new EventEmitter(), { id: 632, isDestroyed: () => false, send: vi.fn(), mainFrame: { framesInSubtree: [] } })
  const stop = await registerIpc({ initialConfig: config,
    window: { setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow,
    runtime, applicationAccess: {} as never,
    configStore: { get: async () => config, validate: (value: unknown) => value, save: async (value: unknown) => value } as never,
    progressLoops: { subscribe: () => () => {} } as never, scratchTopics: new ScratchTopics(),
    workbenchWindows: { setNativeOwner: () => () => {} } as unknown as Parameters<typeof registerIpc>[0]['workbenchWindows'],
    workspaceFiles: { listFiles: async () => [], dispose: async () => {} } as never })
  const invoke = async (channel: string, values: unknown[], source: unknown = sender) => {
    const handler = bridge.handlers.get(channel)
    expect(handler, `Missing production handler ${channel}`).toBeTypeOf('function')
    return await handler!({ sender: source } as IpcMainInvokeEvent, ...values)
  }
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => structuredClone(await invoke(channel, values)))
  const api = bridge.api!.browser, profiles = await api.listProfiles(), defaultProfile = profiles.find(value => value.isDefault)!
  const manager = bridge.manager as BrowserViewManager
  const acquire = [vi.spyOn(manager, 'ensure'), vi.spyOn(manager, 'create'), vi.spyOn(manager, 'restore')]
  const scope: BrowserRecoveryPreviewScope = { browserId: 'original-browser', workspaceId: 'workspace', mode: 'normal', profileId: defaultProfile.id }
  const setGraph = (graph: AgentMuxSpatialGraph) => spatialRead.mockResolvedValue({ schemaVersion: 1, revision: 1, graph } as AgentMuxSpatialState)
  const dispose = async () => { await stop(); await bridge.previews!.dispose() }
  const path = (actual = scope) => join(root, 'browser-recovery-previews', createHash('sha256').update(actual.profileId!).digest('hex'),
    createHash('sha256').update(actual.browserId).digest('hex') + '.json')
  return { root, sender, invoke, api, scope, manager, acquire, setGraph, spatialRead, path, previews: bridge.previews!, dispose }
}

describe('actual preload and registered Main recovery-preview read', () => {
  it.each(['live', 'released'] as const)('reads the real %s scope ahead of a conflicting saved descriptor without acquiring a page', async kind => {
    const f = await fixture()
    try {
      const owner = { workspaceId: f.scope.workspaceId, storage: { mode: 'normal' as const, profileId: f.scope.profileId! } }
      ;(kind === 'live' ? bridge.owners : bridge.released).set(f.scope.browserId, owner)
      f.setGraph(savedGraph(f.scope.browserId, 'wrong-saved-profile'))
      await f.previews.record(f.scope, preview(f.scope), () => true)
      f.spatialRead.mockClear()
      expect(await f.api.getRecoveryPreview(f.scope.browserId)).toEqual({ status: 'available', preview: preview(f.scope) })
      expect(f.spatialRead).not.toHaveBeenCalled()
      expect(bridge.invoke).toHaveBeenCalledWith('browser:getRecoveryPreview', f.scope.browserId)
      for (const method of f.acquire) expect(method).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('reads the exact cold Profile and old URL without defaulting, acquiring or rewriting the failed target', async () => {
    const f = await fixture(), scope = { ...f.scope, profileId: 'original-saved-profile' }
    try {
      const graph = savedGraph(scope.browserId, scope.profileId), before = structuredClone(graph)
      f.setGraph(graph)
      await f.previews.record(scope, preview(scope), () => true)
      expect(await f.api.getRecoveryPreview(scope.browserId)).toEqual({ status: 'available', preview: preview(scope) })
      expect(graph).toEqual(before)
      for (const method of f.acquire) expect(method).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('does not guess a missing cold Profile or confuse unavailable ownership with a missing file', async () => {
    const f = await fixture()
    try {
      await f.previews.record(f.scope, preview(f.scope), () => true)
      f.setGraph(savedGraph(f.scope.browserId))
      expect(await f.api.getRecoveryPreview(f.scope.browserId)).toMatchObject({ status: 'unavailable', warning: expect.stringContaining('Profile') })
      expect(await f.api.getRecoveryPreview('absent-browser')).toMatchObject({ status: 'unavailable', warning: expect.any(String) })
      f.setGraph(savedGraph(f.scope.browserId, 'confirmed-empty-profile'))
      expect(await f.api.getRecoveryPreview(f.scope.browserId)).toEqual({ status: 'missing' })
      for (const method of f.acquire) expect(method).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('projects private cold scope as private memory and never exposes a normal file for the same Browser id', async () => {
    const f = await fixture()
    try {
      await f.previews.record(f.scope, preview(f.scope), () => true)
      const before = await readFile(f.path()), scope: BrowserRecoveryPreviewScope = { ...f.scope, mode: 'private', profileId: null }
      f.setGraph(savedGraph(scope.browserId, f.scope.profileId!, true))
      expect(await f.api.getRecoveryPreview(scope.browserId)).toEqual({ status: 'missing' })
      await f.previews.record(scope, preview(scope), () => true)
      expect(await f.api.getRecoveryPreview(scope.browserId)).toEqual({ status: 'available', preview: preview(scope) })
      expect(await readFile(f.path())).toEqual(before)
      for (const method of f.acquire) expect(method).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('uses a real native owner appearing during the cold read before interpreting a now-absent descriptor', async () => {
    const f = await fixture()
    try {
      await f.previews.record(f.scope, preview(f.scope), () => true)
      f.spatialRead.mockImplementationOnce(async () => {
        bridge.owners.set(f.scope.browserId, { workspaceId: f.scope.workspaceId, storage: { mode: 'normal', profileId: f.scope.profileId! } })
        return null
      })
      expect(await f.api.getRecoveryPreview(f.scope.browserId)).toEqual({ status: 'available', preview: preview(f.scope) })
      for (const method of f.acquire) expect(method).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('rejects a foreign sender before reading scope, spatial data or optional cache', async () => {
    const f = await fixture()
    try {
      const scope = vi.spyOn(f.manager, 'recoveryPreviewScope'), read = vi.spyOn(f.previews, 'read')
      f.spatialRead.mockClear()
      const failure: unknown = await f.invoke('browser:getRecoveryPreview', [f.scope.browserId], { id: f.sender.id })
        .then(() => null, error => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure).toMatchObject({ message: 'Untrusted Browser recovery preview sender' })
      expect(scope).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(f.spatialRead).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('keeps corrupt cache as optional unavailability without acquiring or rewriting the original page', async () => {
    const f = await fixture()
    try {
      f.setGraph(savedGraph(f.scope.browserId, f.scope.profileId!))
      await f.previews.record(f.scope, preview(f.scope), () => true)
      const bytes = Buffer.from('{broken-preview'); await writeFile(f.path(), bytes)
      expect(await f.api.getRecoveryPreview(f.scope.browserId)).toMatchObject({ status: 'unavailable', warning: expect.any(String) })
      expect(await readFile(f.path())).toEqual(bytes)
      for (const method of f.acquire) expect(method).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('retires previews only after the exact Profile deletion was confirmed', async () => {
    const f = await fixture()
    try {
      const profile = await f.api.createProfile('Preview profile'), scope = { ...f.scope, profileId: profile.id }
      await f.previews.record(scope, preview(scope), () => true)
      await expect(f.api.deleteProfile(profile.id, {} as BrowserProfileDeleteApproval)).rejects.toThrow('explicit user approval')
      expect(await f.previews.read(scope)).toMatchObject({ status: 'available' })
      await f.api.deleteProfile(profile.id, { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: profile.id })
      expect((await f.api.listProfiles()).some(value => value.id === profile.id)).toBe(false)
      expect(await f.previews.read(scope)).toEqual({ status: 'missing' })
    } finally { await f.dispose() }
  })
})
