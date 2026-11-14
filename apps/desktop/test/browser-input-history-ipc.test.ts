import { testWorkbenchUserState } from './helpers/workbench-user-state-fixture'
// @vitest-environment happy-dom
import { testAppDocumentSources } from "./helpers/app-document-fixture"
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { BROWSER_PROFILE_RESULT_METHODS, unwrapIpcResultMethods } from '../src/shared/ipc-result.js'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxDesktopApi, AgentMuxPreloadApi, BrowserInputHistoryTarget, BrowserInputHistoryScope, BrowserProfileSummary } from '../src/shared/contracts.js'
import type { AgentMuxSpatialGraph, AgentMuxSpatialState } from '@agentmux/core/spatial-graph'
import type { BrowserRecoveryPreviewStore } from '../src/main/browser-recovery-preview.js'

class TestOwner {
  activity: NonNullable<import('../src/shared/contracts.js').BrowserSnapshot['activity']> = { operation: null, control: 'human' }
  navigationId = 'native-navigation'
  committedNavigationId: string | null = null
  pageAppearanceNavigation: { navigationId: string; requestedUrl: string; committedUrl?: string; title?: string } | undefined
  title = ''
  loading = false
  error: string | null = null
  readonly view = { webContents: { isDestroyed: () => false, isLoading: () => this.loading,
    getURL: () => this.url, getTitle: () => this.title } }
  constructor(public workspaceId: string | null, public storage: { mode: 'normal' | 'private'; profileId: string | null }, public url: string, public id = 'history-page') {}
}
const bridge = vi.hoisted(() => ({
  root: '', api: null as AgentMuxPreloadApi | null,
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  invoke: vi.fn(), owners: new Map<string, TestOwner>(), defaultProfile: (): string => '', profiles: null as import('../src/main/browser-profile-manager.js').BrowserProfileManager | null,
  navigate: vi.fn(), manager: null as unknown,
  previews: null as BrowserRecoveryPreviewStore | null, graph: null as AgentMuxSpatialGraph | null
}))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  app: { on: vi.fn(), off: vi.fn(), once: vi.fn(), getPath: () => bridge.root || tmpdir(), getAppPath: () => process.cwd(), isPackaged: false },
  ipcMain: { handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => bridge.handlers.set(channel, listener),
    removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn(), removeListener: vi.fn() },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn(), isRegistered: vi.fn(() => false) },
  webFrame: { getZoomFactor: () => 1 }, clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, session: {}, safeStorage: {}
}))
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} } }))
// Unrelated connector startup must not open the person's durable connection store.
vi.mock('../../../packages/connectors/src/connection-services.js', () => ({ createConnectionServices: async () => ({
  connections: { list: async () => [] }, secrets: {}, close: async () => {}
}) }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
vi.mock('../src/main/browser-view-manager.js', async original => {
  const actual = await original<typeof import('../src/main/browser-view-manager.js')>()
  return { ...actual, BrowserViewManager: class extends actual.BrowserViewManager {
    constructor(...args: ConstructorParameters<typeof actual.BrowserViewManager>) {
      super(...args)
      bridge.manager = this
      bridge.defaultProfile = () => args[1].defaultProfileId()
      bridge.profiles = args[1] as import('../src/main/browser-profile-manager.js').BrowserProfileManager
      bridge.previews = Reflect.get(this, 'recoveryPreviews') as BrowserRecoveryPreviewStore
      // Only the native page substrate is a Source double. The production scope getter below stays real.
      ;(this as unknown as { entries: Map<string, TestOwner> }).entries = bridge.owners
    }
    async navigate(id: string, text: string) {
      const owner = bridge.owners.get(id)
      if (!owner) throw new Error('Unknown test native page')
      bridge.navigate(id, text)
      owner.url = text
      return { id, mode: owner.storage.mode, profileId: owner.storage.profileId, url: text } as import('../src/shared/contracts.js').BrowserSnapshot
    }
    async restore(id: string) { const owner = bridge.owners.get(id); if (!owner) throw new Error('Unknown test native page'); return { id, mode: owner.storage.mode, profileId: owner.storage.profileId, url: owner.url } as import('../src/shared/contracts.js').BrowserSnapshot }
    dispose() { bridge.owners.clear(); super.dispose() }
  } }
})

import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { ScratchTopics } from '../src/main/scratch-topics.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { registerIpc } from '../src/main/ipc.js'
import '../src/preload/index.js'
import { BrowserInputHistoryStore } from '../src/main/browser-input-history.js'
import { browserPageMemory } from '../src/shared/browser-page-memory.js'
import type { BrowserRecoveryPreviewScope } from '../src/shared/browser-recovery-preview.js'

const roots: string[] = []
const channels = ['browser:listInputHistory', 'browser:recordInputHistory', 'browser:removeInputHistory', 'browser:clearInputHistory']
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  bridge.navigate.mockClear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, maxRetries: 3, retryDelay: 50 })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-input-history-ipc-'))
  roots.push(root); bridge.root = root; bridge.owners.clear(); bridge.handlers.clear()
  bridge.graph = null
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(root, 'private-spatial.json'))
  const spatialRead = vi.spyOn(AgentMuxSpatialStateStore.prototype, 'read').mockImplementation(async () => bridge.graph
    ? { schemaVersion: 1, revision: 1, graph: bridge.graph } as AgentMuxSpatialState : null)
  const config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [
    { id: 'resource-workspace', name: 'Resource', hostId: 'local', path: root, kind: 'folder' as const },
    { id: 'display-workspace', name: 'Display', hostId: 'local', path: join(root, 'display'), kind: 'folder' as const }
  ] }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] })
  const sender = Object.assign(new EventEmitter(), { id: 732, isDestroyed: () => false, send: vi.fn(), mainFrame: { framesInSubtree: [] } })
  const dispose = await registerIpc({ workbenchUserState: testWorkbenchUserState(), appDocumentSources: testAppDocumentSources(sender), initialConfig: config, window: { setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow,
    runtime, applicationAccess: {} as never, configStore: { get: async () => config, validate: (value: unknown) => value, save: async (value: unknown) => value } as never,
    // History requests do not create a native workface window; retain the original IPC owner port.
    workbenchWindows: { setNativeOwner: () => () => {} } as unknown as Parameters<typeof registerIpc>[0]['workbenchWindows'],
    scratchTopics: new ScratchTopics(), workspaceFiles: new WorkspaceFiles(id => runtime.executionHost(id)) })
  const invoke = async (channel: string, values: unknown[], actualSender: unknown = sender) => {
    const handler = bridge.handlers.get(channel)
    expect(handler, `Actual registered channel missing: ${channel}`).toBeTypeOf('function')
    return await handler!({ senderFrame: Reflect.get(actualSender as object, 'mainFrame'), sender: actualSender } as IpcMainInvokeEvent, ...values)
  }
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => structuredClone(await invoke(channel, values)))
  expect(bridge.api).not.toBeNull()
  // The Renderer api layer restores typed Profile refusals from the preload envelope; use the same unwrap.
  const browserApi = unwrapIpcResultMethods<AgentMuxDesktopApi['browser'], typeof BROWSER_PROFILE_RESULT_METHODS[number]>(bridge.api!.browser as never, BROWSER_PROFILE_RESULT_METHODS)
  const profiles = await browserApi.listProfiles()
  expect(profiles.length).toBeGreaterThan(0)
  const defaultProfile = profiles.find(profile => profile.isDefault)
  expect(defaultProfile).toBeDefined()
  expect(defaultProfile!.id).toBe(bridge.defaultProfile())
  bridge.owners.set('history-page', new TestOwner('resource-workspace', { mode: 'normal', profileId: defaultProfile!.id }, 'about:blank'))
  const target: BrowserInputHistoryTarget = { kind: 'browser', browserId: 'history-page', profileId: defaultProfile!.id }
  const scope = { workspaceId: 'resource-workspace', profileId: defaultProfile!.id } satisfies BrowserInputHistoryScope
  const path = join(root, 'browser-input-history', `${createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.profileId])).digest('hex')}.json`)
  const complete = async () => {
    try { await dispose() }
    catch (error) {
      if (error instanceof AggregateError) throw new AggregateError(error.errors, error.errors.map(item => `${item.message}: ${item.cause}`).join('\n'))
      throw error
    }
  }
  return { root, config, sender, invoke, api: browserApi, target, scope, path, spatialRead, previews: bridge.previews!, dispose: complete }
}

function savedHistoryGraph(scopes: BrowserRecoveryPreviewScope[]): AgentMuxSpatialGraph {
  return { spaces: [], zones: [], bindings: [], locations: [], layouts: {}, tabLayouts: {},
    tabs: scopes.map(scope => ({ tabId: 'tab-' + scope.browserId, workspaceId: scope.workspaceId, regionIds: ['region-' + scope.browserId] })),
    regions: scopes.map(scope => ({ tabId: 'tab-' + scope.browserId, regionId: 'region-' + scope.browserId, kind: 'browser', browserId: scope.browserId })),
    resources: Object.fromEntries(scopes.map(scope => ['region:region-' + scope.browserId, { browserId: scope.browserId,
      workspaceId: scope.workspaceId, mode: scope.mode, profileId: scope.profileId, url: 'https://graph.invalid/current-unrelated', title: 'Not a page-memory title' }]))
  } as unknown as AgentMuxSpatialGraph
}

describe('existing history reads real saved page memories through Main', () => {
  it('[existing-appearance] an input known only in back-forward memory needs no current URL match or favicon borrowing', async () => {
    const f = await fixture(), past = 'https://page.invalid/only-past', current = 'https://page.invalid/unsubmitted-current'
    try {
      await f.api.recordInputHistory(f.target, past)
      const scope: BrowserRecoveryPreviewScope = { ...f.scope, browserId: 'back-only-cold', mode: 'normal' }
      bridge.graph = savedHistoryGraph([scope])
      Object.assign(bridge.graph.resources['region:region-back-only-cold']!, { url: current })
      await f.previews.recordPage(scope, browserPageMemory(scope, current, 'data:image/png;base64,AA==', { index: 1,
        entries: [{ url: past, title: 'Actual earlier page' }, { url: current, title: 'Current document is not an input' }] })!, () => true)
      const result = await f.api.listInputHistory(f.target)
      expect(result.entries).toEqual([{ text: past, submittedAt: expect.any(Number), appearance: { url: past, title: 'Actual earlier page' } }])
      expect(result.entries.some(entry => entry.text === current)).toBe(false)
    } finally { await f.dispose() }
  })

  it('[existing-appearance] fills cold back-forward title and only the actual current favicon in one durable batch', async () => {
    const f = await fixture(), past = 'https://page.invalid/past?q=one#part', current = 'https://page.invalid/current', icon = 'data:image/png;base64,AA=='
    try {
      await f.api.recordInputHistory(f.target, past); await f.api.recordInputHistory(f.target, current); await f.api.recordInputHistory(f.target, 'plain human search')
      const before = JSON.parse(await readFile(f.path, 'utf8')).entries
      const cold: BrowserRecoveryPreviewScope = { ...f.scope, browserId: 'cold-page', mode: 'normal' }
      bridge.graph = savedHistoryGraph([cold])
      await f.previews.recordPage(cold, browserPageMemory(cold, current, icon, { index: 1, entries: [{ url: past, title: 'Actual back-forward title' }, { url: current, title: 'Actual current title' }] })!, () => true)
      const read = vi.spyOn(f.previews, 'readPage'), fill = vi.spyOn(BrowserInputHistoryStore.prototype, 'fillAppearance')
      const acquire = vi.spyOn(bridge.manager as import('../src/main/browser-view-manager.js').BrowserViewManager, 'restore')
      f.spatialRead.mockClear()
      const snapshot = await f.api.listInputHistory(f.target)
      expect(snapshot.entries.map(({ appearance: _appearance, ...entry }) => entry)).toEqual(before)
      expect(snapshot.entries.find(entry => entry.text === past)!.appearance).toEqual({ url: past, title: 'Actual back-forward title' })
      expect(snapshot.entries.find(entry => entry.text === current)!.appearance).toEqual({ url: current, title: 'Actual current title', faviconDataUrl: icon })
      expect(snapshot.entries.find(entry => entry.text === 'plain human search')!.appearance).toBeUndefined()
      expect(snapshot.warning).toBeUndefined(); expect(f.spatialRead).toHaveBeenCalledOnce(); expect(fill).toHaveBeenCalledOnce()
      expect(read).toHaveBeenCalledTimes(2); expect(new Set(read.mock.calls.map(([scope]) => scope.browserId)).size).toBe(2)
      expect(acquire).not.toHaveBeenCalled(); expect(bridge.navigate).not.toHaveBeenCalled()
      expect((await new BrowserInputHistoryStore(join(f.root, 'browser-input-history')).list(f.scope)).entries).toEqual(snapshot.entries)
    } finally { await f.dispose() }
  })

  it('[existing-appearance] original live identity excludes foreign/private/unknown scopes and stale cold Profile bindings', async () => {
    const f = await fixture(), url = 'https://page.invalid/original'
    try {
      await f.api.recordInputHistory(f.target, url)
      const foreign: BrowserRecoveryPreviewScope = { ...f.scope, browserId: 'foreign', mode: 'normal', profileId: 'ZyXwVuTs9876' }
      const moved: BrowserRecoveryPreviewScope = { ...f.scope, browserId: 'moved', mode: 'normal' }
      const privateScope: BrowserRecoveryPreviewScope = { ...f.scope, browserId: 'private', mode: 'private', profileId: null }
      const otherWorkspace: BrowserRecoveryPreviewScope = { ...f.scope, browserId: 'other-space', mode: 'normal', workspaceId: 'display-workspace' }
      const capsule: BrowserRecoveryPreviewScope = { ...f.scope, browserId: 'capsule', mode: 'normal' }
      const unknown: BrowserRecoveryPreviewScope = { ...f.scope, browserId: 'unknown-profile', mode: 'normal' }
      bridge.graph = savedHistoryGraph([foreign, moved, privateScope, otherWorkspace, capsule, unknown])
      const manager = bridge.manager as import('../src/main/browser-view-manager.js').BrowserViewManager
      const knownScopes = manager.knownRecoveryPreviewScopes.bind(manager)
      vi.spyOn(manager, 'knownRecoveryPreviewScopes').mockImplementation(() => {
        const known = new Map(knownScopes())
        known.set('unknown-profile', null)
        return known
      })
      bridge.owners.set('moved', new TestOwner(f.scope.workspaceId, { mode: 'normal', profileId: foreign.profileId }, url, 'moved'))
      const capsuleOwner = new TestOwner(f.scope.workspaceId, { mode: 'normal', profileId: null }, url, 'capsule')
      Object.assign(capsuleOwner.storage, { capsule: {} }); bridge.owners.set('capsule', capsuleOwner)
      for (const scope of [foreign, moved, privateScope, otherWorkspace, capsule, unknown]) await f.previews.recordPage(scope, browserPageMemory(scope, url, 'data:image/png;base64,AA==', { index: 0, entries: [{ url, title: 'Foreign title' }] })!, () => true)
      const read = vi.spyOn(f.previews, 'readPage')
      const snapshot = await f.api.listInputHistory(f.target)
      expect(snapshot.entries[0]!.appearance).toBeUndefined(); expect(snapshot.warning).toBeUndefined()
      expect(read).toHaveBeenCalledExactlyOnceWith({ ...f.scope, browserId: 'history-page', mode: 'normal' })
      const privateTarget: BrowserInputHistoryTarget = { kind: 'browser', browserId: 'private', profileId: null }
      bridge.owners.set('private', new TestOwner(f.scope.workspaceId, { mode: 'private', profileId: null }, url, 'private'))
      const before = read.mock.calls.length
      expect(await f.api.listInputHistory(privateTarget)).toEqual({ scope: { ...f.scope, profileId: null }, entries: [] })
      expect(read.mock.calls.length).toBe(before)
    } finally { await f.dispose() }
  })

  it('[existing-appearance] remove and clear finish during saved-memory IO and win the later batch', async () => {
    const f = await fixture(), url = 'https://page.invalid/deleted'
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    try {
      await f.api.recordInputHistory(f.target, url)
      const scope: BrowserRecoveryPreviewScope = { ...f.scope, browserId: 'cold-delete', mode: 'normal' }
      bridge.graph = savedHistoryGraph([scope])
      await f.previews.recordPage(scope, browserPageMemory(scope, url, undefined, { index: 0, entries: [{ url, title: 'Late title' }] })!, () => true)
      const original = f.previews.readPage.bind(f.previews)
      const read = vi.spyOn(f.previews, 'readPage').mockImplementationOnce(async actual => { await held; return original(actual) })
      const listing = f.api.listInputHistory(f.target)
      await vi.waitFor(() => expect(read).toHaveBeenCalled())
      expect((await f.api.removeInputHistory(f.target, f.scope, url)).entries).toEqual([])
      expect((await f.api.clearInputHistory(f.target, f.scope)).entries).toEqual([])
      release()
      expect((await listing).entries).toEqual([])
      expect((await new BrowserInputHistoryStore(join(f.root, 'browser-input-history')).list(f.scope)).entries).toEqual([])
    } finally { release(); await f.dispose() }
  })

  it('[existing-appearance] failed optional reads or saves keep original rows with a nonpersistent notice and retry', async () => {
    const f = await fixture(), url = 'https://page.invalid/retained'
    try {
      await f.api.recordInputHistory(f.target, url)
      const scope: BrowserRecoveryPreviewScope = { ...f.scope, browserId: 'cold-failure', mode: 'normal' }
      bridge.graph = savedHistoryGraph([scope])
      const memory = browserPageMemory(scope, url, undefined, { index: 0, entries: [{ url, title: 'Saved title' }] })!
      await f.previews.recordPage(scope, memory, () => true)
      const before = await readFile(f.path)
      const fill = vi.spyOn(BrowserInputHistoryStore.prototype, 'fillAppearance').mockRejectedValueOnce(new Error('Auxiliary save unavailable'))
      const failed = await f.api.listInputHistory(f.target)
      expect(failed.entries.map(entry => entry.text)).toEqual([url]); expect(failed.warning).toContain('saved page details')
      expect(await readFile(f.path)).toEqual(before)
      const retry = await f.api.listInputHistory(f.target)
      expect(retry.entries[0]!.appearance?.title).toBe('Saved title'); expect(retry.warning).toBeUndefined(); expect(fill).toHaveBeenCalledTimes(2)
      const raw = JSON.parse(await readFile(f.path, 'utf8')); expect(raw.warning).toBeUndefined()
      f.spatialRead.mockRejectedValueOnce(new Error('Original graph read unavailable'))
      expect((await f.api.listInputHistory(f.target)).warning).toContain('saved page details')
      await writeFile(join(f.root, 'browser-recovery-previews', createHash('sha256').update(scope.profileId!).digest('hex'),
        createHash('sha256').update(scope.browserId).digest('hex') + '.page.json'), '{actual corrupt page-memory')
      expect((await f.api.listInputHistory(f.target)).warning).toContain('saved page details')
      await f.api.navigate('history-page', 'https://healthy.invalid/')
      expect(bridge.navigate).toHaveBeenCalledExactlyOnceWith('history-page', 'https://healthy.invalid/')
      await writeFile(f.path, '{actual corrupt human history')
      await expect(f.api.listInputHistory(f.target)).rejects.toThrow()
    } finally { await f.dispose() }
  })
})

describe('actual preload and registered Main input-history path', () => {
  it('[page-appearance] admits a late human record through Main then decorates from its actual committed Browser', async () => {
    const f = await fixture()
    try {
      const owner = bridge.owners.get('history-page')!
      owner.url = 'https://document.invalid/final'; owner.title = 'Actual native title'
      owner.committedNavigationId = owner.navigationId
      owner.pageAppearanceNavigation = { navigationId: owner.navigationId, requestedUrl: 'https://input.invalid/start', committedUrl: owner.url, title: owner.title }
      await f.api.recordInputHistory(f.target, 'https://input.invalid/start')
      const actual = await f.api.listInputHistory(f.target)
      expect(actual.entries).toEqual([{ text: 'https://input.invalid/start', submittedAt: expect.any(Number), appearance: { url: owner.url, title: owner.title } }])
      expect(JSON.parse(await readFile(f.path, 'utf8')).entries).toEqual(actual.entries)
      expect(await f.api.listInputHistory({ kind: 'workspace', workspaceId: 'display-workspace' })).toMatchObject({ entries: [] })
      await f.api.removeInputHistory(f.target, f.scope, 'https://input.invalid/start')
      const manager = bridge.manager as import('../src/main/browser-view-manager.js').BrowserViewManager
      manager.refreshInputHistoryAppearance('history-page', f.scope.profileId)
      expect((await f.api.listInputHistory(f.target)).entries).toEqual([])
    } finally { await f.dispose() }
  })

  it('[page-appearance] a held decoration never delays the committed input result or normal navigation', async () => {
    const f = await fixture(), original = BrowserInputHistoryStore.prototype.decorate
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const decorate = vi.spyOn(BrowserInputHistoryStore.prototype, 'decorate').mockImplementationOnce(async function (this: BrowserInputHistoryStore, scope, requested, appearance) {
      await held
      return original.call(this, scope, requested, appearance)
    })
    try {
      const owner = bridge.owners.get('history-page')!
      owner.url = 'https://document.invalid/page'; owner.title = 'Committed title'; owner.committedNavigationId = owner.navigationId
      owner.pageAppearanceNavigation = { navigationId: owner.navigationId, requestedUrl: owner.url, committedUrl: owner.url, title: owner.title }
      expect(await f.api.recordInputHistory(f.target, owner.url)).toMatchObject({ outcome: 'recorded' })
      expect(decorate).toHaveBeenCalledOnce()
      await f.api.navigate('history-page', 'https://next.invalid/healthy')
      expect(bridge.navigate).toHaveBeenCalledExactlyOnceWith('history-page', 'https://next.invalid/healthy')
      release()
      await vi.waitFor(async () => expect((await f.api.listInputHistory(f.target)).entries[0]!.appearance?.title).toBe('Committed title'))
    } finally { release(); await f.dispose() }
  })

  it('[page-appearance] pending or failed native targets cannot attach an old title to a new address', async () => {
    const f = await fixture()
    try {
      const owner = bridge.owners.get('history-page')!
      owner.url = 'https://new.invalid/target'; owner.title = 'Old page title'
      owner.pageAppearanceNavigation = { navigationId: owner.navigationId, requestedUrl: owner.url, committedUrl: owner.url }
      await f.api.recordInputHistory(f.target, owner.url)
      expect((await f.api.listInputHistory(f.target)).entries[0]!.appearance).toBeUndefined()
      owner.committedNavigationId = owner.navigationId; owner.error = 'Native document failed'
      await f.api.recordInputHistory(f.target, owner.url)
      expect((await f.api.listInputHistory(f.target)).entries[0]!.appearance).toBeUndefined()
    } finally { await f.dispose() }
  })

  it('private input does not read or write persistent history, through actual preload and Main handlers', async () => {
    const f = await fixture()
    try {
      await f.api.recordInputHistory(f.target, 'normal-kept')
      const before = await readFile(f.path, 'utf8'), files = await readdir(join(f.root, 'browser-input-history'))
      bridge.owners.set('private-input', new TestOwner('resource-workspace', { mode: 'private', profileId: null }, 'about:blank', 'private-input'))
      const target: BrowserInputHistoryTarget = { kind: 'browser', browserId: 'private-input', profileId: null }
      expect(await f.api.listInputHistory(target)).toEqual({ scope: { workspaceId: 'resource-workspace', profileId: null }, entries: [] })
      const recorded = await f.api.recordInputHistory(target, 'private-secret-input')
      expect(await readFile(f.path, 'utf8'), 'private input must not change the real persistent history bytes').toBe(before)
      expect(recorded).toMatchObject({ entries: [], outcome: 'private' })
      expect(await readdir(join(f.root, 'browser-input-history'))).toEqual(files)
      expect((await f.api.listInputHistory(f.target)).entries.map(row => row.text)).toEqual(['normal-kept'])
    } finally { await f.dispose() }
  })
  it('round-trips real durable history through the original resource Workspace, not another display location', async () => {
    const f = await fixture()
    try {
      expect(await f.api.listInputHistory(f.target)).toEqual({ scope: f.scope, entries: [] })
      const first = await f.api.recordInputHistory(f.target, 'first human query')
      expect(first).toEqual({ scope: f.scope, entries: [{ text: 'first human query', submittedAt: expect.any(Number) }], outcome: 'recorded' })
      await f.api.recordInputHistory(f.target, 'https://example.invalid/p?q=%2B#fragment')
      expect((await f.api.listInputHistory({ kind: 'workspace', workspaceId: 'resource-workspace' })).entries.map(entry => entry.text))
        .toEqual(['https://example.invalid/p?q=%2B#fragment', 'first human query'])
      expect(await f.api.listInputHistory({ kind: 'workspace', workspaceId: 'display-workspace' })).toEqual({ scope: { ...f.scope, workspaceId: 'display-workspace' }, entries: [] })
      expect((await f.api.removeInputHistory(f.target, first.scope, 'first human query')).entries.map(entry => entry.text))
        .toEqual(['https://example.invalid/p?q=%2B#fragment'])
      expect(JSON.parse(await readFile(f.path, 'utf8')).scope).toEqual(f.scope)
      expect(await f.api.clearInputHistory(f.target, first.scope)).toEqual({ scope: f.scope, entries: [] })
      expect(bridge.invoke.mock.calls.filter(([channel]) => channels.includes(channel)).length).toBeGreaterThan(0)
    } finally { await f.dispose() }
  })

  it('uses the actual Profile manager default before creation and rejects stale Browser/Profile, null and unknown resources', async () => {
    const f = await fixture()
    try {
      const launcher = { kind: 'workspace', workspaceId: 'resource-workspace' } as const
      expect((await f.api.recordInputHistory(launcher, 'before create search')).scope).toEqual(f.scope)
      const profile: BrowserProfileSummary = await bridge.profiles!.createProfile('Other History Profile', 'other-history-profile', { kind: 'user', id: 'history-fixture-user', verified: true })
      expect(profile.id).not.toBe(f.scope.profileId)
      bridge.owners.get('history-page')!.storage.profileId = profile.id
      await expect(f.api.listInputHistory(f.target)).rejects.toThrow('Profile changed')
      const switched = { ...f.target, profileId: profile.id } as BrowserInputHistoryTarget
      const actual = await f.api.recordInputHistory(switched, 'other profile input')
      expect(actual.scope).toEqual({ ...f.scope, profileId: profile.id })
      expect((await f.api.listInputHistory(launcher)).entries.map(entry => entry.text)).toEqual(['before create search'])
      await expect(f.api.removeInputHistory(switched, f.scope, 'other profile input')).rejects.toThrow('scope changed')
      await expect(f.api.clearInputHistory(switched, f.scope)).rejects.toThrow('scope changed')
      expect((await f.api.listInputHistory(switched)).entries.map(entry => entry.text)).toEqual(['other profile input'])
      bridge.owners.get('history-page')!.workspaceId = null
      await expect(f.api.listInputHistory(switched)).rejects.toThrow('no verified Workspace')
      bridge.owners.get('history-page')!.workspaceId = 'absent-workspace'
      await expect(f.api.recordInputHistory(switched, 'unbound')).rejects.toThrow('Unknown workspace')
      await expect(f.api.listInputHistory({ kind: 'workspace', workspaceId: 'absent-workspace' })).rejects.toThrow('Unknown workspace')
      bridge.owners.delete('history-page')
      await expect(f.api.listInputHistory(switched)).rejects.toThrow('Unknown browser')
    } finally { await f.dispose() }
  })

  it('rejects another sender for every history channel while native navigation has no recording side effect', async () => {
    const f = await fixture()
    try {
      const foreign = { id: f.sender.id }
      const values: unknown[][] = [[f.target], [f.target, 'foreign input'], [f.target, f.scope, 'foreign input'], [f.target, f.scope]]
      expect(channels).toHaveLength(4)
      for (const [index, channel] of channels.entries()) {
        await expect(Promise.resolve().then(() => f.invoke(channel, values[index]!, foreign))).rejects.toThrow("Untrusted application")
      }
      expect(await f.api.listInputHistory(f.target)).toEqual({ scope: f.scope, entries: [] })
      await expect(f.invoke('browser:navigate', ['history-page', 'agent page navigation'], foreign)).rejects.toThrow('Untrusted application')
      await f.invoke('browser:navigate', ['history-page', 'agent page navigation'])
      expect(bridge.navigate).toHaveBeenCalledExactlyOnceWith('history-page', 'agent page navigation')
      expect(await f.api.listInputHistory(f.target)).toEqual({ scope: f.scope, entries: [] })
      await expect(readdir(join(f.root, 'browser-input-history'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.dispose() }
  })

  it('does not turn corrupt-history failure into navigation failure or an empty successful list', async () => {
    const f = await fixture()
    try {
      await f.api.recordInputHistory(f.target, 'initial human input')
      const raw = Buffer.from('{invalid retained input history')
      await writeFile(f.path, raw)
      await expect(f.api.listInputHistory(f.target)).rejects.toThrow()
      await expect(f.api.recordInputHistory(f.target, 'later human input')).rejects.toThrow()
      await f.api.navigate('history-page', 'normal navigation still allowed')
      expect(bridge.navigate).toHaveBeenCalledExactlyOnceWith('history-page', 'normal navigation still allowed')
      expect(await readFile(f.path)).toEqual(raw)
      expect(bridge.owners.get('history-page')).toMatchObject({ workspaceId: f.scope.workspaceId, storage: { mode: 'normal', profileId: f.scope.profileId }, url: 'normal navigation still allowed' })
    } finally { await f.dispose() }
  })
})
