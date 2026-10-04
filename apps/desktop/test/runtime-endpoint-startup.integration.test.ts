const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { privateRuntimeConnector, runtimeOwnerIdentity } from './helpers/private-runtime-connector.js'
import { ConfigStore } from '../src/main/config-store.js'
import { createExecutionHost } from '../src/main/host-factory.js'
import type { AgentMuxPreloadApi, AppConfig, RuntimeEvent } from '../src/shared/contracts.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { projectPersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence.js'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { api } from '../src/renderer/src/lib/api.js'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(), home: _hygiene_fixturePath("tmp/unused-startup-bridge"), appPath: '' }))
const controlled = vi.hoisted(() => ({ paths: new Map<string, string>(),
  gates: new Map<string, { promise: Promise<void>; release(): void; calls: number }>() }))
// The real public client and official local ctxmux are unchanged. Only the remote transport
// selector and connect scheduling are controlled: this is not an SSH/Farm qualification.
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, value: AgentMuxPreloadApi) => { bridge.api = value } },
  ipcRenderer: { invoke: bridge.invoke, send: vi.fn(),
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      const listeners = bridge.listeners.get(channel) ?? new Set(); listeners.add(callback); bridge.listeners.set(channel, listeners)
    }, off: (channel: string, callback: (...args: unknown[]) => void) => bridge.listeners.get(channel)?.delete(callback),
    removeListener: (channel: string, callback: (...args: unknown[]) => void) => bridge.listeners.get(channel)?.delete(callback) },
  webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => bridge.home, getAppPath: () => bridge.appPath, isPackaged: false },
  ipcMain: { handle: (channel: string, callback: (...args: unknown[]) => unknown) => bridge.handlers.set(channel, callback),
    removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ list: async () => [] }) }))
vi.mock('../src/main/browser-profile-manager.js', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal.js', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-startup-journal.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store.js', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager.js', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import '../src/preload/index.js'
import { registerIpc } from '../src/main/ipc.js'

const scopes: Array<Awaited<ReturnType<typeof headlessFixture>>> = []
const controllers: RuntimeController[] = [], disposals: Array<() => void | Promise<void>> = []
const initialStore = useAppStore.getState()
afterEach(async () => {
  for (const gate of controlled.gates.values()) gate.release()
  for (const dispose of disposals.splice(0).reverse()) await dispose()
  for (const controller of controllers.splice(0)) await controller.dispose()
  for (const scope of scopes.splice(0)) await scope.cleanup()
  useAppStore.setState(initialStore, true)
  controlled.paths.clear(); controlled.gates.clear(); bridge.handlers.clear(); bridge.listeners.clear()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
})
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function setup() {
  const local = await headlessFixture(); scopes.push(local)
  const remote = await headlessFixture(); scopes.push(remote)
  for (const [key, value] of Object.entries(local.env)) if (key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_')) vi.stubEnv(key, value!)
  bridge.home = local.root
  bridge.appPath = join(import.meta.dirname, '..')
  controlled.paths.set('pending.fixture', remote.socketPath); controlled.paths.set('replacement.fixture', remote.socketPath)
  let release!: () => void
  const gate = { promise: new Promise<void>(resolve => { release = resolve }), release: () => release(), calls: 0 }
  controlled.gates.set('pending.fixture', gate)
  const localClient = await local.client(), remoteClient = await remote.client()
  const command = ['-e', 'process.stdin.on("data",b=>process.stdout.write(b));process.stdin.resume()']
  const localRun = await localClient.createTerminal({ workspacePath: local.root, command: process.execPath, args: command })
  const remoteRun = await remoteClient.createTerminal({ workspacePath: remote.root, command: process.execPath, args: command })
  const configStore = new ConfigStore(join(local.root, 'desktop-config.json'))
  const defaults = await configStore.get()
  const config: AppConfig = { ...defaults, hosts: [defaults.hosts[0]!, { id: 'build-host', kind: 'ssh', label: 'Pending owner', hostname: 'pending.fixture' }],
    executors: {}, workspaces: [{ id: 'local-space', name: 'Local', hostId: 'local', path: local.root, kind: 'folder' },
      { id: 'remote-space', name: 'Remote', hostId: 'build-host', path: remote.root, kind: 'folder' }] }
  await configStore.save(config)
  const controller = new RuntimeController(new AgentMuxFileAgentSessionStore(join(local.root, 'main-sessions.json')), privateRuntimeConnector(local.socketPath, hostname => controlled.paths.get(hostname)!, async hostname => {
    const gate = controlled.gates.get(hostname); if (gate) { gate.calls++; await gate.promise }
  }))
  controllers.push(controller)
  return { local, remote, gate, localClient, localRun, remoteRun, controller, configStore, config }
}
async function ipc(scope: Awaited<ReturnType<typeof setup>>) {
  const events: RuntimeEvent[] = []
  const sender = Object.assign(new EventEmitter(), { id: 891, isDestroyed: () => false, session: { flushStorageData: () => {} },
    send: (channel: string, value: RuntimeEvent) => {
      if (value?.type === 'core') events.push(value)
      for (const listener of bridge.listeners.get(channel) ?? []) listener({}, value)
    } })
  bridge.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function')
    return await handler!({ sender } as unknown as IpcMainInvokeEvent, ...args)
  })
  const registration = registerIpc({ window: { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow,
    runtime: scope.controller, configStore: scope.configStore, scratchTopics: { setNameAudit: vi.fn(), normalizeDirectoryIdentities: vi.fn().mockResolvedValue([]) } as never,
    progressLoops: { subscribe: () => () => {} } as never, workspaceFiles: { dispose: async () => {} } as never })
  // A still-pending remote connect must not delay actual IPC registration. The latch stays closed.
  try { expect(await Promise.race([registration.then(() => true), pause(3000).then(() => false)])).toBe(true) }
  catch (error) { scope.gate.release(); disposals.push(await registration); throw error }
  disposals.push(await registration)
  expect(bridge.api).not.toBeNull()
  return { events, native: bridge.api! }
}

it('registers actual Main IPC and restores the durable Renderer workface with original local input before the remote handshake completes', async () => {
  const scope = await setup(), { native, events } = await ipc(scope)
  expect(scope.gate.calls).toBe(1)
  const localTab = createWorkbenchTab('saved-local', { regionId: 'saved-local-region', kind: 'terminal', phase: 'attached',
    workspaceId: 'local-space', sessionId: scope.localRun.runId })
  const remoteTab = createWorkbenchTab('saved-remote', { regionId: 'saved-remote-region', kind: 'terminal', phase: 'attached',
    workspaceId: 'remote-space', sessionId: scope.remoteRun.runId })
  const tabs = { [localTab.id]: localTab, [remoteTab.id]: remoteTab }
  const layouts = { 'local-space': createWorkspaceLayout('saved-local-group', [localTab.id]),
    'remote-space': createWorkspaceLayout('saved-remote-group', [remoteTab.id]) }
  // Persist the original Core spatial identities through actual Main IPC. The
  // execution facts come from the independently confirmed private Core owners,
  // rather than deriving execution from the Region's display Workspace.
  const graph = desktopSpatialGraph({ config: scope.config, tabs, layouts, sessions: [], spaceZoneBindings: {}, spatialRequests: {} }, [])
  for (const [regionId, run, hostId] of [['saved-local-region', scope.localRun, 'local'],
    ['saved-remote-region', scope.remoteRun, 'build-host']] as const) {
    const region = graph.regions.find(region => region.regionId === regionId)!
    region.runId = run.runId
    region.execution = { hostId, cwd: run.workspacePath }
  }
  await native.spatial.commit({ expectedRevision: (await native.spatial.read())?.revision ?? 0, graph })
  const saved = JSON.stringify({ version: 1, state: { restoredWorkbench: projectPersistedWorkbench({ tabs, layouts }),
    agentComposerDrafts: { 'saved-agent': 'Original unsent draft' }, activeWorkspaceId: 'local-space' } })
  const storage = new Map([['agentmux-workbench-v1', saved]])
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } })
  vi.spyOn(api.config, 'get').mockImplementation(() => native.config.get())
  vi.spyOn(api.sessions, 'snapshot').mockImplementation(() => native.sessions.snapshot())
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => native.sessions.onEvent(listener))
  vi.spyOn(api.providers, 'list').mockImplementation(native.providers.list)
  vi.spyOn(api.sessions, 'historySources').mockImplementation(native.sessions.historySources)
  vi.spyOn(api.spatial, 'read').mockImplementation(native.spatial.read)
  vi.spyOn(api.spatial, 'commit').mockImplementation(native.spatial.commit)
  vi.spyOn(api.spatial, 'onChange').mockImplementation(native.spatial.onChange)
  vi.spyOn(api.demands, 'list').mockImplementation(() => native.demands.list())
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(() => native.ui.requestStorageFlush())
  const reads = Promise.all([native.providers.list({ observation: true }), native.sessions.historySources({ observation: true })])
  try { expect(await Promise.race([reads.then(() => true), pause(3000).then(() => false)]),
    'Untrusted remote observations must not hold the healthy Host catalog or History read.').toBe(true) }
  catch (error) { scope.gate.release(); await reads; throw error }
  const [catalog, history] = await reads
  expect(catalog.catalog.length).toBeGreaterThan(0)
  expect(catalog.warnings).toEqual([expect.objectContaining({ hostId: 'build-host', scope: 'observation', step: 'Reading Provider catalog', availability: 'unverified' })])
  expect(history.sources).toEqual([])
  expect(history.warnings).toEqual([expect.objectContaining({ hostId: 'build-host', scope: 'observation', step: 'Reading retained History sources', availability: 'unverified' })])
  useAppStore.setState({ loading: true, config: null, restoredWorkbench: null, sessions: [], tabs: {}, layouts: {}, agentComposerDrafts: {} })
  const initialization = useAppStore.getState().initialize()
  try { expect(await Promise.race([initialization.then(() => true), pause(3000).then(() => false)])).toBe(true) }
  catch (error) { scope.gate.release(); disposals.push(await initialization); throw error }
  disposals.push(await initialization)
  const restored = useAppStore.getState()
  expect(restored.loading).toBe(false)
  expect(Object.keys(restored.tabs).sort()).toEqual(['saved-local', 'saved-remote'])
  expect(restored.layouts['local-space']).toEqual(layouts['local-space'])
  expect(restored.layouts['remote-space']).toEqual(layouts['remote-space'])
  expect(restored.activeWorkspaceId).toBe('local-space')
  expect(restored.agentComposerDrafts).toEqual({ 'saved-agent': 'Original unsent draft' })
  expect(restored.sessions.map(session => [session.id, session.hostId])).toEqual([[scope.localRun.runId, 'local']])
  expect(restored.runtimeEndpointWarnings).toHaveLength(3)
  expect(restored.runtimeEndpointWarnings).toEqual(expect.arrayContaining([
    expect.objectContaining({ hostId: 'build-host', scope: 'observation', step: 'Reading Provider catalog', availability: 'unverified' }),
    expect.objectContaining({ hostId: 'build-host', scope: 'observation', step: 'Reading retained History sources', availability: 'unverified' }),
    expect.objectContaining({ hostId: 'build-host', step: 'Connecting to Runtime', availability: 'unverified' })
  ]))
  expect(scope.gate.calls).toBe(1)
  const control = restored.sessions[0]!.control
  const attached = await native.sessions.attach(control, 0)
  await native.sessions.write(control, 'local-input-before-remote\n', 'user')
  await until(() => events, values => values.some(event => event.hostId === 'local' && event.event.type === 'terminal-output' &&
    event.event.data.includes('local-input-before-remote')), 'actual local terminal output')
  const originalLocal = (await scope.localClient.listRuns()).find(run => run.runId === scope.localRun.runId)
  expect([originalLocal?.pid, originalLocal?.state]).toEqual([scope.localRun.pid, 'running'])
  expect(originalLocal!.acceptedInputBytes).toBeGreaterThan(0)
  scope.gate.release()
  const remoteRestored = await until(() => useAppStore.getState(), state => state.runtimeEndpointWarnings?.length === 0 &&
    state.sessions.some(session => session.id === scope.remoteRun.runId), 'fresh remote restoration in real Renderer Store').then(() => true, () => false)
  if (!remoteRestored) {
    console.error(JSON.stringify({ warnings: useAppStore.getState().runtimeEndpointWarnings,
      sessions: useAppStore.getState().sessions.map(session => [session.id, session.hostId]),
      error: useAppStore.getState().error, reads: vi.mocked(api.sessions.snapshot).mock.calls.length,
      events: events.map(event => ({ hostId: event.hostId, type: event.event.type,
        ...(event.event.type === 'connection-state' ? { state: event.event.state } : {}) })) }, null, 2))
  }
  expect(remoteRestored).toBe(true)
  expect(scope.controller.endpointWarningSnapshot()).toEqual([])
  expect(vi.mocked(api.providers.list).mock.calls.filter(([options]) => options?.observation)).not.toHaveLength(0)
  expect(vi.mocked(api.sessions.historySources).mock.calls.filter(([options]) => options?.observation)).not.toHaveLength(0)
  expect(events.filter(event => event.hostId === 'build-host' && event.event.type === 'connection-state')
    .map(event => event.event.type === 'connection-state' && event.event.state)).toEqual(['restored'])
  expect(useAppStore.getState().tabs).toEqual(restored.tabs)
  expect(useAppStore.getState().layouts).toEqual(restored.layouts)
  expect(useAppStore.getState().agentComposerDrafts).toEqual(restored.agentComposerDrafts)
  expect(JSON.parse(await readFile(join(scope.local.root, 'desktop-config.json'), 'utf8')).hosts)
    .toContainEqual(expect.objectContaining({ id: 'build-host', runtimeId: scope.remote.owner.runtimeId }))
  await native.sessions.detach(attached.attachmentId)
}, 90_000)

it('retains the omitted endpoint warning in the actual IPC snapshot when its connection finishes during the local read', async () => {
  const scope = await setup(), { native } = await ipc(scope)
  const local = scope.controller.rpcClients().find(owner => owner.hostId === 'local')!.client
  const original = local.runtimeProjection.bind(local)
  let release!: () => void, readStarted!: () => void
  const started = new Promise<void>(resolve => { readStarted = resolve })
  const readGate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(local, 'runtimeProjection').mockImplementation(async () => { const value = await original(); readStarted(); await readGate; return value })
  const read = native.sessions.snapshot()
  try {
    await started; scope.gate.release()
    await until(() => scope.controller.endpointWarningSnapshot(), warnings => warnings.length === 0, 'actual connection completed during incomplete snapshot')
  } finally { release() }
  const snapshot = await read
  expect(snapshot.sessions.map(session => [session.id, session.hostId])).toEqual([[scope.localRun.runId, 'local']])
  expect(snapshot.runtimeEndpointWarnings).toEqual([expect.objectContaining({ hostId: 'build-host', availability: 'unverified' })])
  const fresh = await native.sessions.snapshot()
  expect(fresh.sessions.map(session => [session.id, session.hostId]).sort())
    .toEqual([[scope.localRun.runId, 'local'], [scope.remoteRun.runId, 'build-host']].sort())
  expect(fresh.runtimeEndpointWarnings).toEqual([])
}, 90_000)

it('ignores a retired client late connection failure instead of marking its healthy replacement unavailable', async () => {
  const scope = await setup()
  scope.controller.commit(await scope.controller.prepare(scope.config))
  expect(scope.gate.calls).toBe(1)
  const config = { id: 'build-host', kind: 'ssh' as const, label: 'Replacement', hostname: 'replacement.fixture' }
  const replacement = await privateRuntimeConnector(scope.local.socketPath, hostname => controlled.paths.get(hostname)!)(config,
    new AgentMuxFileAgentSessionStore(join(scope.local.root, 'replacement-main.json')))
  await replacement.connect()
  scope.controller.commit({ hosts: [{ id: config.id, config, client: replacement, executionHost: createExecutionHost(config) }],
    configs: [config], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  scope.gate.release()
  await pause(50)
  expect(scope.controller.rpcClients().find(owner => owner.hostId === 'build-host')?.client).toBe(replacement)
  expect(runtimeOwnerIdentity(replacement)?.availability).toBe('connected')
  expect(scope.controller.endpointWarningSnapshot()).toEqual([])
}, 90_000)
