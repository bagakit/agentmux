// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, type AgentMuxClientEvent,
  type AgentMuxClientIncidentRecord, type AgentMuxClientIncidentPage } from '@agentmux/core'
import { AgentMuxControlServer as PublicServer, type AgentMuxControlServerOptions } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import type { AppConfig, AgentMuxPreloadApi } from '../src/shared/contracts.js'
import { ClientIncidentArchive } from '@agentmux/host/client-incident-archive'
import { ClientIncidentRuntimeOwner } from '../src/main/client-incident-runtime.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { refreshSettingsExecutor } from '../src/main/settings-executor-refresh-control.js'

const ipc = vi.hoisted(() => ({ root: '', handlers: new Map<string, Function>(), invoke: vi.fn(), api: null as AgentMuxPreloadApi | null,
  control: null as AgentMuxControlServerOptions | null }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => ipc.root }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  safeStorage: { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: vi.fn(async () => {}), decryptStringAsync: vi.fn(async () => {}) },
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { ipc.api = api } },
  ipcRenderer: { invoke: ipc.invoke, on: vi.fn(), removeListener: vi.fn(), off: vi.fn(), send: vi.fn() },
  webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => ipc.root, getAppPath: () => resolve('apps/desktop'), isPackaged: false },
  ipcMain: { handle: (channel: string, handler: Function) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class {
    constructor(options: AgentMuxControlServerOptions) { ipc.control = options }
    async start() {} async stop() {}
  }
}))
vi.mock('../src/main/browser-profile-manager.js', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal.js', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'isolated-journal.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store.js', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager.js', () => ({ BrowserViewManager: class { dispose() {} release() {} setPresentationWindowOwner() {} } }))
vi.mock('../src/main/native-overlay-windows.js', () => ({ NativeOverlayWindows: class { dispose() {} resourceProcessIds() { return [] } } }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import { RuntimeController } from '../src/main/runtime-controller.js'
import { registerIpc } from '../src/main/ipc.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import '../src/preload/index.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  ipc.handlers.clear(); ipc.invoke.mockReset(); ipc.control = null; vi.restoreAllMocks(); vi.unstubAllEnvs()
})
const bounds = () => ({ signal: new AbortController().signal, maxBytes: 256 * 1024 })
async function records(archive: ClientIncidentArchive) {
  await archive.flush()
  const page = (await archive.read({ domain: 'client.incident', hostId: 'local', recent: {} }, bounds())).data as AgentMuxClientIncidentPage
  return await Promise.all(page.items.map(async item => (await archive.read({ domain: 'client.incident', hostId: 'local',
    logId: item.recordRef.logId! }, bounds())).data as AgentMuxClientIncidentRecord))
}
async function fixture(startupFailure = false) {
  const objectCli = process.env.AGENTMUX_TEST_OBJECT_CLI ?? join(process.cwd(), 'packages/core/bin/amux')
  const root = await mkdtemp(join(tmpdir(), 'amx-incident-sources-')); ipc.root = root
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  for (const name of Object.keys(process.env).filter(name => name.startsWith('AGENTMUX_') || name.startsWith('CTXMUX_'))) vi.stubEnv(name, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', objectCli)
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), hosts: [...structuredClone(DEFAULT_CONFIG.hosts),
    { id: 'healthy-host', kind: 'ssh', label: 'Healthy', hostname: 'healthy.invalid' }], executors: {
    observed: { label: 'Observed', providerId: 'codex', command: 'authored-provider', args: [], env: { PRIVATE_TOKEN: 'private-env' }, injectAgentMuxGuide: false }
  } }
  const core = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  const healthyCore = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  vi.spyOn(healthyCore, 'connect').mockResolvedValue(undefined)
  vi.spyOn(healthyCore, 'connectRuntime').mockResolvedValue(undefined)
  const healthyProbe = vi.spyOn(healthyCore, 'probeExecutorAvailability').mockResolvedValue({ executable: 'authored-provider', availability: 'available' })
  const listeners = new Set<(event: AgentMuxClientEvent) => void>()
  let firstSubscriber = true
  vi.spyOn(core, 'onEvent').mockImplementation(listener => {
    listeners.add(listener)
    if (startupFailure && firstSubscriber) queueMicrotask(() => listener({ type: 'connection-state', state: 'lost',
      observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' },
      diagnostic: { code: 'ECONNREFUSED', message: 'private startup connection body' }, evidence: { source: 'agentmux', observedAt: Date.now() } }))
    firstSubscriber = false
    return () => { listeners.delete(listener) }
  })
  const connect = vi.spyOn(core, 'connect').mockResolvedValue(undefined)
  const connectRuntime = vi.spyOn(core, 'connectRuntime').mockResolvedValue(undefined)
  const probe = vi.spyOn(core, 'probeExecutorAvailability').mockResolvedValue({ executable: 'authored-provider', availability: 'available' })
  const input = vi.spyOn(core, 'writeTerminal'), create = vi.spyOn(core, 'createAgent')
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async host => host.id === 'healthy-host' ? healthyCore : core)
  cleanups.push(async () => await runtime.dispose())
  const archive = new ClientIncidentArchive(join(root, 'archive')); await archive.flush()
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, isLoadingMainFrame: () => false,
    send: vi.fn(), mainFrame: {}, session: { flushStorageData: vi.fn() } })
  const args = { initialConfig: config,
    window: { setBackgroundColor: vi.fn(), id: 1, isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow,
    runtime, clientIncidents: archive, configStore: { get: async () => config, validate: (next: AppConfig) => next, save: async (next: AppConfig) => next },
    scratchTopics: { setNameAudit: () => {} }, workspaceFiles: { read: vi.fn(), listFiles: async () => [], dispose: async () => {} },
    progressLoops: { subscribe: () => () => {} }, workbenchWindows: { setNativeOwner: () => () => {} } } as unknown as Parameters<typeof registerIpc>[0]
  const release = await registerIpc(args)
  let closed = false
  const dispose = async () => { if (!closed) { closed = true; await release() } }
  cleanups.push(dispose)
  ipc.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    const handler = ipc.handlers.get(channel); expect(handler).toBeTypeOf('function')
    return structuredClone(await handler!({ sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent, ...structuredClone(values)))
  })
  await ipc.invoke('notesStorage:inspect')
  const desktop = new PublicServer({ ...ipc.control!, socketPath: join(root, 'desktop.sock') }); await desktop.start()
  cleanups.push(async () => await desktop.stop())
  const owner = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'desktop.sock') } })
  cleanups.push(async () => await owner.dispose())
  const hostPath = join(root, 'default-host.sock')
  const host = new PublicServer({ socketPath: hostPath, coreClients: () => [],
    forwardControl: (method, params, context) => owner.call(method, params, context) })
  await host.start(); cleanups.push(async () => await host.stop())
  const cli = (...args: string[]) => runCompiledObjectCli(['--endpoint', `unix://${hostPath}`, ...args], objectCliEnvironment(root))
  const event = (state: Extract<AgentMuxClientEvent, { type: 'connection-state' }>['state'],
    boundary: 'consumer-core' | 'core-ctxmux' = 'consumer-core', diagnostic?: { code: string; message: string }) => {
    expect(listeners.size).toBeGreaterThan(0)
    for (const receive of listeners) receive({ type: 'connection-state', state, observationOrigin: { kind: 'runtime-connection', boundary },
      ...(diagnostic ? { diagnostic } : {}), evidence: { source: 'agentmux', observedAt: Date.now() } })
  }
  return { archive, probe, healthyProbe, runtime, core, connect, connectRuntime, input, create, cli, event, dispose }
}

it('archives actual startup checks and explicit public refresh through the same finite producer and compiled reader', async () => {
  const f = await fixture()
  const healthy = await ipc.api!.executors.detect('observed', 'local')
  expect(healthy.availability).toBe('available'); expect(await records(f.archive)).toHaveLength(0)
  f.probe.mockResolvedValueOnce({ executable: 'authored-provider', availability: 'check-failed', cause: { code: 'EIO', message: 'private native error body' } })
  const failed = await ipc.api!.executors.detect('observed', 'local')
  expect(failed).toMatchObject({ availability: 'check-failed', cause: { code: 'EIO', message: 'private native error body' } })
  expect(await records(f.archive)).toHaveLength(1)
  // This is the original public business operation, not a retry made by the diagnostic reader.
  const refreshed = await f.cli('settings', 'executors', 'refresh', 'observed', '--host', 'local')
  expect(refreshed.code, refreshed.stderr).toBe(0)
  expect(JSON.parse(refreshed.stdout).result).toMatchObject({ availability: 'available' })
  await f.archive.flush()
  const beforeRead = { probes: f.probe.mock.calls.length, connects: f.connect.mock.calls.length, runtimeConnects: f.connectRuntime.mock.calls.length }
  const found = await f.cli('system', 'diagnostics', 'inspect', '--domain', 'client.incident', '--host-id', 'local', '--recent')
  expect(found.code, found.stderr).toBe(0)
  const page = JSON.parse(found.stdout).result.reads[0].data as AgentMuxClientIncidentPage
  expect(page.items).toHaveLength(3)
  const all = await records(f.archive), failure = all.find(item => item.report.kind === 'capability-probe-failed')!,
    started = all.find(item => item.report.kind === 'capability-probe')!, recovered = all.find(item => item.report.kind === 'capability-probe-recovered')!
  expect(failure.report).toMatchObject({ stage: 'probe-failed', code: 'EIO', hostId: 'local', agentSessionId: null, runId: null,
    metadata: { executorId: 'observed', probeAvailability: 'check-failed' } })
  expect(started.report).toMatchObject({ stage: 'probe-started', relatedOccurrenceId: failure.report.occurrenceId })
  expect(recovered.report).toMatchObject({ stage: 'probe-completed', attemptId: started.report.attemptId,
    relatedOccurrenceId: started.report.occurrenceId, metadata: { probeAvailability: 'available' } })
  expect(started.report.attemptId).not.toBe(failure.report.attemptId)
  expect(all.every(item => item.producer.kind === 'main')).toBe(true)
  const exact = await f.cli('system', 'diagnostics', 'inspect', '--domain', 'client.incident', '--host-id', 'local',
    '--logid', failure.logId, '--authority', failure.authority.id)
  expect(exact.code, exact.stderr).toBe(0)
  expect(JSON.parse(exact.stdout).result.reads[0]).toMatchObject({ availability: 'found', data: failure })
  for (const privateValue of ['private native error body', 'authored-provider', 'private-env', ipc.root]) expect(exact.stdout).not.toContain(privateValue)
  expect({ probes: f.probe.mock.calls.length, connects: f.connect.mock.calls.length, runtimeConnects: f.connectRuntime.mock.calls.length }).toEqual(beforeRead)
  expect(f.probe).toHaveBeenCalledTimes(3); expect(f.input).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled()
}, 30_000)

it('retains a fast initial connection failure emitted during the original Runtime commit', async () => {
  const f = await fixture(true), all = await records(f.archive)
  expect(all).toHaveLength(1)
  expect(all[0]!.report).toMatchObject({ hostId: 'local', kind: 'connection-failed', stage: 'connection-state', code: 'ECONNREFUSED',
    metadata: { connectionBoundary: 'consumer-core', connectionState: 'lost' } })
  const result = await f.cli('system', 'diagnostics', 'inspect', '--domain', 'client.incident', '--host-id', 'local', '--recent')
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result.reads[0].data.items).toHaveLength(1)
  expect(f.probe).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
}, 30_000)

it('keeps independent typed connection boundaries, observation gaps and original restoration readable without reconnecting', async () => {
  const f = await fixture()
  f.event('restored'); expect(await records(f.archive)).toHaveLength(0)
  f.event('lost', 'consumer-core', { code: 'ECONNRESET', message: 'private connection body' })
  f.event('lost', 'consumer-core', { code: 'ECONNRESET', message: 'private connection body' })
  f.event('lost', 'core-ctxmux', { code: 'EIO', message: 'private ctxmux body' })
  f.event('retrying', 'consumer-core')
  f.event('restored', 'consumer-core', { code: 'CTXMUX_CONNECTION_OBSERVATION_FAILED', message: 'private observation body' })
  f.event('restored', 'consumer-core')
  const original = await records(f.archive)
  expect(original).toHaveLength(5)
  const consumer = original.filter(item => item.report.metadata.connectionBoundary === 'consumer-core')
    .sort((a, b) => a.report.stages.length - b.report.stages.length)
  expect(consumer.map(item => item.report.kind)).toEqual(['connection-failed', 'connection-failed', 'connection-failed', 'connection-recovered'])
  expect(new Set(consumer.map(item => item.report.attemptId)).size).toBe(1)
  expect(consumer[0]!.report.relatedOccurrenceId).toBeNull()
  for (let i = 1; i < consumer.length; i++) expect(consumer[i]!.report.relatedOccurrenceId).toBe(consumer[i - 1]!.report.occurrenceId)
  expect(original.find(item => item.report.metadata.connectionBoundary === 'core-ctxmux')!.report.relatedOccurrenceId).toBeNull()
  expect((await ipc.api!.executors.detect('observed', 'healthy-host')).availability).toBe('available')
  expect(f.healthyProbe).toHaveBeenCalledOnce()
  // A connection observation failure is never rewritten into an Executor absence.
  expect((await ipc.api!.executors.detect('observed', 'local')).availability).toBe('available')
  const beforeRead = { probes: f.probe.mock.calls.length, connects: f.connect.mock.calls.length }
  const result = await f.cli('system', 'diagnostics', 'inspect', '--domain', 'client.incident', '--host-id', 'local', '--recent')
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result.reads[0].data.items).toHaveLength(5)
  expect({ probes: f.probe.mock.calls.length, connects: f.connect.mock.calls.length }).toEqual(beforeRead)
  expect(f.connect).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled()
  await f.dispose()
  f.event('lost')
  expect(await records(f.archive)).toHaveLength(5)
}, 30_000)

it('preserves thrown identity and refuses to infer retry scope across a different original configuration or Host owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-incident-scope-')); cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const archive = new ClientIncidentArchive(join(root, 'archive')); await archive.flush()
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), executors: {
    observed: { label: 'Observed', providerId: 'codex', command: 'authored-provider', args: [], env: {}, injectAgentMuxGuide: false }
  } }
  let current = config, owner = {}, receive: ((hostId: string, event: AgentMuxClientEvent) => void) | undefined
  const original = Object.assign(new Error('private thrown body'), { code: 'EIO' })
  const detect = vi.fn(async (executorId: string, hostId: string, actual: AppConfig) => ({
    input: { executorId, providerId: 'codex', command: 'authored-provider', host: actual.hosts.find(item => item.id === hostId)! },
    executable: 'authored-provider', availability: 'available' as const
  })).mockRejectedValueOnce(original)
  const runtime = { detect, executionHost: () => owner,
    observeCoreEvents: (_types: unknown, listener: typeof receive) => { receive = listener; return () => { receive = undefined } } }
  const diagnostic = new ClientIncidentRuntimeOwner(runtime as never, archive, { kind: 'main', appInstanceId: archive.appInstanceId,
    producerInstanceId: archive.appInstanceId, windowId: null, documentGeneration: null, buildId: null })
  cleanups.push(async () => diagnostic.dispose())
  const configOwner = new ConfigOwner({ read: () => current, save: async value => value, publish: value => { current = value } })
  await expect(refreshSettingsExecutor('observed', 'local', configOwner, diagnostic)).rejects.toBe(original)
  expect(await records(archive)).toHaveLength(1)
  current = structuredClone(config)
  await refreshSettingsExecutor('observed', 'local', configOwner, diagnostic)
  expect(await records(archive)).toHaveLength(1)
  const event: Extract<AgentMuxClientEvent, { type: 'connection-state' }> = { type: 'connection-state', state: 'lost',
    observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'agentmux', observedAt: Date.now() } }
  receive!('local', event); owner = {}; receive!('local', { ...event, state: 'restored' })
  const all = await records(archive)
  expect(all.filter(item => item.report.kind === 'connection-recovered')).toHaveLength(0)
  expect(detect).toHaveBeenCalledTimes(2)
})

it.each(['thrown-accessor', 'thrown-proxy', 'cause-accessor', 'cause-code-accessor', 'cause-proxy'] as const)(
  'retains the original refresh failure and recovery when %s cannot supply a diagnostic code', async failure => {
    const root = await mkdtemp(join(tmpdir(), 'amx-incident-code-')); cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const archive = new ClientIncidentArchive(join(root, 'archive')); await archive.flush()
    const config = structuredClone(DEFAULT_CONFIG), executorId = Object.keys(config.executors)[0]!, owner = {}
    const codeGetter = vi.fn(() => { throw Error('private-code-accessor') })
    const causeGetter = vi.fn(() => { throw Error('private-cause-accessor') })
    const inaccessible = failure.endsWith('proxy') ? new Proxy({}, {
      getOwnPropertyDescriptor: () => { throw Error('private-code-proxy') }
    }) : Object.defineProperty(new Error('private-original-body'), 'code', { get: codeGetter })
    const result = { input: { executorId, providerId: 'codex', command: 'authored-provider', host: config.hosts[0]! },
      availability: 'check-failed' as const, executable: 'authored-provider', cause: inaccessible }
    if (failure === 'cause-accessor') Object.defineProperty(result, 'cause', { get: causeGetter })
    const healthy = { input: result.input, availability: 'available' as const, executable: 'authored-provider' }
    const detect = vi.fn(async (): Promise<unknown> => healthy)
    if (failure.startsWith('thrown-')) detect.mockRejectedValueOnce(inaccessible)
    else detect.mockResolvedValueOnce(result)
    const runtime = { detect, executionHost: () => owner, observeCoreEvents: () => () => {} }
    const diagnostic = new ClientIncidentRuntimeOwner(runtime as never, archive, { kind: 'main', appInstanceId: archive.appInstanceId,
      producerInstanceId: archive.appInstanceId, windowId: null, documentGeneration: null, buildId: null })
    cleanups.push(async () => diagnostic.dispose())
    const configOwner = new ConfigOwner({ read: () => config, save: async value => value, publish: () => {} })
    if (failure.startsWith('thrown-')) await expect(refreshSettingsExecutor(executorId, 'local', configOwner, diagnostic)).rejects.toBe(inaccessible)
    else expect(await refreshSettingsExecutor(executorId, 'local', configOwner, diagnostic)).toBe(result)
    expect(codeGetter).not.toHaveBeenCalled(); expect(causeGetter).not.toHaveBeenCalled()
    const first = await records(archive)
    expect(first).toHaveLength(1)
    expect(first[0]!.report).toMatchObject({ kind: 'capability-probe-failed', stage: 'probe-failed', code: null,
      metadata: { executorId, probeAvailability: 'check-failed' } })
    expect(await refreshSettingsExecutor(executorId, 'local', configOwner, diagnostic)).toBe(healthy)
    const all = await records(archive), recovered = all.find(item => item.report.kind === 'capability-probe-recovered')!
    expect(all).toHaveLength(3)
    expect(recovered.report).toMatchObject({ kind: 'capability-probe-recovered', code: null, metadata: { probeAvailability: 'available' } })
    expect(detect).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(all)).not.toContain('private-')
  }
)

it.each(['subscribe-accessor', 'release-accessor', 'subscribe-proxy', 'release-proxy'] as const)(
  'retains an unavailable observation after %s without changing the original check', async failure => {
    const root = await mkdtemp(join(tmpdir(), 'amx-incident-observer-code-')); cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const archive = new ClientIncidentArchive(join(root, 'archive')); await archive.flush()
    const config = structuredClone(DEFAULT_CONFIG), executorId = Object.keys(config.executors)[0]!
    const getter = vi.fn(() => { throw Error('private-observer-code') })
    const original = failure.endsWith('proxy') ? new Proxy({}, {
      getOwnPropertyDescriptor: () => { throw Error('private-observer-proxy') }
    }) : Object.defineProperty(new Error('private-observer-body'), 'code', { get: getter })
    const result = { input: { executorId, providerId: 'codex', command: 'authored-provider', host: config.hosts[0]! },
      availability: 'available' as const, executable: 'authored-provider' }
    const detect = vi.fn(async () => result)
    const runtime = { detect, executionHost: () => ({}), observeCoreEvents: () => {
      if (failure.startsWith('subscribe-')) throw original
      return () => { throw original }
    } }
    const diagnostic = new ClientIncidentRuntimeOwner(runtime as never, archive, { kind: 'main', appInstanceId: archive.appInstanceId,
      producerInstanceId: archive.appInstanceId, windowId: null, documentGeneration: null, buildId: null })
    expect(await diagnostic.detect(executorId, 'local', config)).toBe(result)
    expect(() => diagnostic.dispose()).not.toThrow()
    expect(getter).not.toHaveBeenCalled()
    expect(detect).toHaveBeenCalledExactlyOnceWith(executorId, 'local', config)
    const all = await records(archive)
    expect(all).toHaveLength(1)
    expect(all[0]!.report).toMatchObject({ stage: 'observation-unavailable', code: null,
      metadata: { disposed: failure.startsWith('release-') } })
    expect(JSON.stringify(all)).not.toContain('private-')
  }
)

it.each(['subscribe', 'release', 'admission'] as const)('isolates diagnostic %s failure from the existing business operation', async failure => {
  const root = await mkdtemp(join(tmpdir(), 'amx-incident-isolation-')); cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const archive = new ClientIncidentArchive(join(root, 'archive')); await archive.flush()
  const config = structuredClone(DEFAULT_CONFIG), executorId = Object.keys(config.executors)[0]!
  const result = { input: { executorId, providerId: 'codex', command: 'authored-provider', host: config.hosts[0]! },
    availability: 'check-failed' as const, executable: 'authored-provider', cause: { code: 'EIO', message: 'private-original-result' } }
  const failureError = Object.assign(new Error('private-diagnostic-error'), { code: 'ENOSPC' })
  const detect = vi.fn(async () => result)
  const runtime = { detect, executionHost: () => ({}), observeCoreEvents: () => {
    if (failure === 'subscribe') throw failureError
    return () => { if (failure === 'release') throw failureError }
  } }
  if (failure === 'admission') vi.spyOn(archive, 'enqueue').mockImplementation(() => { throw failureError })
  const diagnostic = new ClientIncidentRuntimeOwner(runtime as never, archive, { kind: 'main', appInstanceId: archive.appInstanceId,
    producerInstanceId: archive.appInstanceId, windowId: null, documentGeneration: null, buildId: null })
  expect(await diagnostic.detect(executorId, 'local', config)).toBe(result)
  expect(() => diagnostic.dispose()).not.toThrow()
  expect(detect).toHaveBeenCalledExactlyOnceWith(executorId, 'local', config)
  if (failure !== 'admission') {
    const unavailable = (await records(archive)).find(record => record.report.stage === 'observation-unavailable')!
    expect(unavailable.report).toMatchObject({ hostId: archive.hostId, runId: null, code: 'ENOSPC', metadata: { disposed: failure === 'release' } })
    expect(JSON.stringify(unavailable)).not.toContain('private-diagnostic-error')
  }
})

it('releases the early diagnostic subscription when the original Runtime commit fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-incident-startup-')); cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const archive = new ClientIncidentArchive(join(root, 'archive')); await archive.flush()
  const original = Object.assign(new Error('private-runtime-commit-failure'), { code: 'EIO' }), release = vi.fn()
  const runtime = { setTerminalViewColors() {}, prepare: async () => ({ runtimeBindings: new Map() }),
    commit: () => { throw original }, observeCoreEvents: () => release }
  const args = { window: { webContents: {} }, initialConfig: structuredClone(DEFAULT_CONFIG), runtime,
    clientIncidents: archive, scratchTopics: { setNameAudit() {} } } as unknown as Parameters<typeof registerIpc>[0]
  await expect(registerIpc(args)).rejects.toBe(original)
  expect(release).toHaveBeenCalledOnce()
})
