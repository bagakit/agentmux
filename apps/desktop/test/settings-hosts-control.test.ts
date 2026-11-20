import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { CONFIG_CHANGED_CHANNEL } from '../src/shared/contracts.js'
import { settingsScratchTopics, settingsWorkbenchWindows, settingsWorkspaceFiles, prepareSettingsIpcDirectory } from './helpers/settings-ipc-fixture.js'
import { testWorkbenchUserState } from './helpers/workbench-user-state-fixture'
import { testAppDocumentSources } from "./helpers/app-document-fixture"
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'
import type { AppConfig, HostConfig } from '../src/shared/contracts.js'
import type { RuntimePreparation } from '../src/main/runtime-controller.js'

const ipc = vi.hoisted(() => ({ root: '',
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  execute: undefined as ((request: AgentMuxControlRequest) => Promise<AgentMuxControlResult>) | undefined
}))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  app: { on: vi.fn(), off: vi.fn(), once: vi.fn(), removeListener: vi.fn(), getPath: () => ipc.root || tmpdir(), getAppPath: () => process.cwd() + '/apps/desktop' },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  globalShortcut: { register: () => true, unregister: vi.fn() }, clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class {
    constructor(options: { execute: typeof ipc.execute }) { ipc.execute = options.execute }
    async start() {} async stop() {}
  }
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager.js', async () => ({ BrowserProfileManager: (await import('./helpers/settings-ipc-fixture.js')).SettingsBrowserProfiles }))
vi.mock('../../../packages/browser/src/browser-operation-journal.ts', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../../../packages/browser/src/browser-ref-ledger-store.ts', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager.js', async () => ({ BrowserViewManager: (await import('./helpers/settings-ipc-fixture.js')).SettingsBrowserViews }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))

import { AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
vi.mock('../src/main/notes-storage-owner.js', async () => ({ NotesStorageOwner: (await import('./helpers/settings-ipc-fixture.js')).SettingsNotesStorage }))
import { registerIpc } from '../src/main/ipc.js'
import { ContinuousProgressLoopManager } from '@agentmux/host/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '@agentmux/host/continuous-progress-loop-store'

const directories: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true }))) })
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'host-settings' } as const
const remote: HostConfig = { id: '--help', kind: 'ssh', label: 'Saved connection', hostname: 'private.invalid', user: 'original', port: 22 }

async function registered(connector = localRuntimeConnector) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-host-settings-')); directories.push(root); ipc.root = root
  await prepareSettingsIpcDirectory(root)
  const store = new ConfigStore(join(root, 'config.json'))
  const config = await store.save({ ...structuredClone(DEFAULT_CONFIG), hosts: [DEFAULT_CONFIG.hosts[0]!, remote],
    workspaces: [{ id: '__scratch__', name: 'Private Topics', path: join(root, 'topics'), hostId: 'local', kind: 'folder' }] })
  const preparation: RuntimePreparation = { hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), connector)
  const prepare = vi.spyOn(runtime, 'prepare').mockResolvedValue(preparation)
  const commit = vi.spyOn(runtime, 'commit').mockImplementation(() => {})
  const attach = vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
  vi.spyOn(store, 'get').mockResolvedValue(config)
  const sender = Object.assign(new EventEmitter(), { id: 919, isDestroyed: () => false, send: vi.fn(), mainFrame: { framesInSubtree: [] } })
  const progressLoops = new ContinuousProgressLoopManager(ContinuousProgressLoopStore.forUserData(root),
    async () => { throw new Error('Host diagnostic cannot deliver progress input') }, undefined,
    async () => { throw new Error('Host diagnostic cannot observe progress input') })
  ipc.handlers.clear(); ipc.execute = undefined
  const dispose = await registerIpc({ workbenchWindows: settingsWorkbenchWindows({ webContents: sender } as unknown as BrowserWindow), workbenchUserState: testWorkbenchUserState(), appDocumentSources: testAppDocumentSources(sender), initialConfig: await store.get(), window: { setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow,
    configStore: store, runtime, progressLoops, scratchTopics: settingsScratchTopics(),
    workspaceFiles: settingsWorkspaceFiles() })
  const execute = ipc.execute!
  const native = ipc.handlers.get('hosts:check')!
  expect(execute).toBeTypeOf('function'); expect(native).toBeTypeOf('function')
  return {  config, runtime, prepare, commit, attach, sender, dispose, execute,
    native: (input: unknown) => native({ senderFrame: Reflect.get(sender as object, 'mainFrame'), sender } as unknown as IpcMainInvokeEvent, input),
    bytes: () => readFile(store.filePath, 'utf8') }
}

describe('Host diagnostics use the registered Main owner', () => {
  it('preserves Main validation and not-found codes through the actual public Control Server', async () => {
    const f = await registered(), bytes = await f.bytes(), check = vi.spyOn(f.runtime, 'checkHost')
    const core = await vi.importActual<typeof import('@agentmux/core')>('@agentmux/core')
    const socket = join(ipc.root, 'owned-control.sock'), server = new core.AgentMuxControlServer({ execute: f.execute, coreClients: () => [] }, socket)
    await server.start()
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
    try {
      await expect(rpc.call('settings.hosts.test', { input: { ...remote, port: '22' } })).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
      await expect(rpc.call('settings.hosts.test', { id: 'unknown' })).rejects.toMatchObject({ code: 'SETTING_RESOURCE_NOT_FOUND' })
      expect(check).not.toHaveBeenCalled(); expect(await f.bytes()).toBe(bytes)
    } finally { await rpc.dispose(); await server.stop(); await f.dispose() }
  })

  it('lists committed Hosts and captures exact saved IDs while a diagnostic remains pending', async () => {
    const f = await registered(), bytes = await f.bytes()
    const check = vi.spyOn(f.runtime, 'checkHost')
    let resolve!: (value: { detail: string }) => void
    check.mockReturnValue(new Promise(done => { resolve = done }))
    try {
      expect(await f.execute({ ...envelope, operation: 'settings.hosts.list' })).toEqual({ operation: 'settings.hosts.list', hosts: f.config.hosts })
      expect(check).not.toHaveBeenCalled()
      const pending = f.execute({ ...envelope, operation: 'settings.hosts.test', id: '--help' })
      expect(check).toHaveBeenCalledExactlyOnceWith(remote)
      // The Main configuration owner can publish another value without waiting for a temporary Test.
      const set = ipc.handlers.get('config:save')!; expect(set).toBeTypeOf('function')
      const changed: AppConfig = { ...f.config, hosts: [f.config.hosts[0]!, { ...remote, hostname: 'later.invalid' }] }
      await set({ senderFrame: Reflect.get(f.sender as object, 'mainFrame'), sender: f.sender } as unknown as IpcMainInvokeEvent, changed, f.config)
      resolve({ detail: 'Runtime original · protocol 1' })
      expect(await pending).toEqual({ operation: 'settings.hosts.test', input: remote, outcome: 'ready', detail: 'Runtime original · protocol 1' })
      expect(await f.execute({ ...envelope, operation: 'settings.hosts.list' })).toEqual({ operation: 'settings.hosts.list', hosts: changed.hosts })
      check.mockResolvedValue({ detail: 'Runtime later · protocol 1' })
      expect(await f.execute({ ...envelope, operation: 'settings.hosts.test', id: '--help' })).toMatchObject({ input: changed.hosts[1], outcome: 'ready' })
      expect(await f.bytes()).not.toBe(bytes)
    } finally { await f.dispose() }
  })

  it('uses the same strict Host schema for public draft and UI, rejecting invalid input before Runtime', async () => {
    const f = await registered(), bytes = await f.bytes(), check = vi.spyOn(f.runtime, 'checkHost').mockResolvedValue({ detail: 'Runtime private · protocol 1' })
    const publications = f.sender.send.mock.calls.filter(([channel]) => channel === CONFIG_CHANGED_CHANNEL).length, preparations = f.prepare.mock.calls.length
    try {
      for (const input of [{ ...remote, extra: true }, { ...remote, port: '22' }, { ...remote, port: 0 },
        { ...remote, port: 65536 }, { ...remote, port: 2.5 }, { ...remote, user: 1 }, { id: 'draft', kind: 'ssh', label: 'Draft' },
        { id: 'other-local', kind: 'local', label: 'Wrong local ID' }]) {
        await expect(f.native(input)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
        await expect(f.execute({ ...envelope, operation: 'settings.hosts.test', input })).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
      }
      await expect(f.execute({ ...envelope, operation: 'settings.hosts.test', id: 'Saved connection' })).rejects.toMatchObject({ code: 'SETTING_RESOURCE_NOT_FOUND' })
      expect(check).not.toHaveBeenCalled()
      expect(await f.native(remote)).toEqual({ input: remote, outcome: 'ready', detail: 'Runtime private · protocol 1' })
      expect(await f.execute({ ...envelope, operation: 'settings.hosts.test', input: remote })).toEqual({ operation: 'settings.hosts.test', input: remote, outcome: 'ready', detail: 'Runtime private · protocol 1' })
      expect(check).toHaveBeenCalledTimes(2)
      expect(await f.bytes()).toBe(bytes); expect(f.sender.send.mock.calls.filter(([channel]) => channel === CONFIG_CHANGED_CHANNEL)).toHaveLength(publications)
      expect(f.prepare).toHaveBeenCalledTimes(preparations)
    } finally { await f.dispose() }
  })

  it('keeps unknown read and cleanup failures distinct from explicit REMOTE_UNSUPPORTED', async () => {
    const f = await registered(), bytes = await f.bytes(), check = vi.spyOn(f.runtime, 'checkHost')
    const publications = f.sender.send.mock.calls.filter(([channel]) => channel === CONFIG_CHANGED_CHANNEL).length, preparations = f.prepare.mock.calls.length
    try {
      const unsupported = Object.assign(new Error('Remote contract is not supported.'), { code: 'REMOTE_UNSUPPORTED' })
      const failures = [new Error('Runtime identity could not be read.'),
        new AggregateError([unsupported, new Error('Temporary Host cleanup failed.')], 'Preparation and cleanup failed.'), 'Unreadable fact']
      for (const error of failures) {
        check.mockRejectedValueOnce(error)
        expect(await f.execute({ ...envelope, operation: 'settings.hosts.test', id: '--help' })).toMatchObject({ input: remote, outcome: 'check-failed' })
        check.mockRejectedValueOnce(error)
        expect(await f.native(remote)).toMatchObject({ input: remote, outcome: 'check-failed' })
      }
      check.mockRejectedValueOnce(unsupported)
      expect(await f.native(remote)).toEqual({ input: remote, outcome: 'unsupported', detail: unsupported.message })
      expect(await f.bytes()).toBe(bytes); expect(f.sender.send.mock.calls.filter(([channel]) => channel === CONFIG_CHANGED_CHANNEL)).toHaveLength(publications)
      expect(f.prepare).toHaveBeenCalledTimes(preparations)
    } finally { await f.dispose() }
  })

  it('preserves the original Host connection failure without reporting unsupported or changing configuration', async () => {
    const detail = 'The selected Host connection could not be observed.'
    const connector = vi.fn(async () => { throw Object.assign(new Error(detail), { code: 'REMOTE_CONNECTION_UNAVAILABLE' }) })
    const f = await registered(connector), bytes = await f.bytes()
    const publications = f.sender.send.mock.calls.filter(([channel]) => channel === CONFIG_CHANGED_CHANNEL).length
    try {
      expect(await f.native(remote)).toEqual({ input: remote, outcome: 'check-failed', detail })
      expect(await f.execute({ ...envelope, operation: 'settings.hosts.test', id: '--help' })).toEqual({ operation: 'settings.hosts.test', input: remote, outcome: 'check-failed', detail })
      expect(connector.mock.calls.map(([host]) => host)).toEqual([remote, remote])
      expect(await f.bytes()).toBe(bytes)
      expect(f.sender.send.mock.calls.filter(([channel]) => channel === CONFIG_CHANGED_CHANNEL)).toHaveLength(publications)
      expect(f.runtime.resourceOwnerCounts()).toMatchObject({ sessionAttachmentOwners: 0, sessionAttachmentLeases: 0 })
    } finally { await f.dispose() }
  })
})


describe('Host configuration through the compiled public CLI and registered Main owner', () => {
  it('registers an unbound Host, preserves the shared saved fact, rejects identity/CAS/reference errors and removes only an unused route', async () => {
    const f = await registered()
    const core = await vi.importActual<typeof import('@agentmux/core')>('@agentmux/core')
    const originalAgent = await rpcOwnerFixture(['host-config-agent'])
    const originalSessionBytes = await readFile(join(originalAgent.root, 'sessions.json'), 'utf8')
    const socket = join(ipc.root, 'crud.sock'), server = new core.AgentMuxControlServer({ execute: f.execute, coreClients: originalAgent.coreClients }, socket)
    await server.start()
    const env = objectCliEnvironment(ipc.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + socket, AGENTMUX_AGENT_SESSION_ID: originalAgent.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: originalAgent.credentials.capability })
    const run = (args: string[], input?: unknown) => runCompiledObjectCli(['settings', 'hosts', ...args], env, input === undefined ? undefined : JSON.stringify(input))
    const draft = { id: 'uninstalled', kind: 'ssh', label: 'Uninstalled Core', hostname: 'unreachable.invalid', transport: 'ssh', port: 18822 }
    try {
      const before = JSON.parse(await f.bytes()), check = vi.spyOn(f.runtime, 'checkHost').mockResolvedValue({ detail: 'Private original check' })
      const created = await run(['create', draft.id, '--input', '-'], draft)
      expect(created.code).toBe(0)
      expect(JSON.parse(created.stdout).result.host).toEqual(draft)
      expect(check).not.toHaveBeenCalled()
      const list = await run(['ls'])
      expect(JSON.parse(list.stdout).result.hosts).toEqual([...before.hosts, draft])
      const disk = JSON.parse(await f.bytes()); expect(disk.workspaces).toEqual(before.workspaces)
      expect(disk.executors).toEqual(before.executors)
      expect(f.sender.send.mock.calls.some(([channel, value]) => channel === CONFIG_CHANGED_CHANNEL && value.hosts.some((host: HostConfig) => host.id === draft.id))).toBe(true)
      expect((await run(['create', draft.id, '--input', '-'], draft)).code).not.toBe(0)
      const boundForgery = { ...draft, id: 'forged', runtimeId: 'caller-cannot-pin' }
      const forgery = await run(['create', 'forged', '--input', '-'], boundForgery)
      expect(JSON.parse(forgery.stderr).error.code).toBe('SETTING_IDENTITY_IMMUTABLE')
      const edited = { ...draft, label: 'Renamed route', hostname: 'later.invalid' }
      expect((await run(['configure', draft.id, '--input', '-'], { expected: draft, candidate: edited })).code).toBe(0)
      const conflict = await run(['configure', draft.id, '--input', '-'], { expected: draft, candidate: { ...edited, label: 'Stale' } })
      expect(conflict.code).not.toBe(0)
      expect(JSON.parse(conflict.stderr).error.code).toBe('CONFIG_CONFLICT')
      const binding = await run(['configure', draft.id, '--input', '-'], { expected: edited, candidate: { ...edited, runtimeId: 'wrong' } })
      expect(JSON.parse(binding.stderr).error.code).toBe('SETTING_IDENTITY_IMMUTABLE')
      const tested = await run(['test', draft.id]); expect(tested.code).toBe(0)
      expect(JSON.parse(tested.stdout).result.input).toEqual(edited)
      expect(check).toHaveBeenCalledExactlyOnceWith(edited)
      const local = JSON.parse(await f.bytes()).hosts.find((host: HostConfig) => host.id === 'local')
      const denied = await run(['delete', 'local', '--input', '-'], { expected: local })
      expect(JSON.parse(denied.stderr).error.code).toBe('SETTING_IDENTITY_IMMUTABLE')
      const staleDelete = await run(['delete', draft.id, '--input', '-'], { expected: draft })
      expect(JSON.parse(staleDelete.stderr).error.code).toBe('CONFIG_CONFLICT')
      const removed = await run(['delete', draft.id, '--input', '-'], { expected: edited })
      expect(removed.code).toBe(0); expect(JSON.parse(removed.stdout).result).toEqual({ id: draft.id, removed: true })
      expect(JSON.parse(await f.bytes()).hosts).toEqual(before.hosts)
      expect(await readFile(join(originalAgent.root, 'sessions.json'), 'utf8')).toBe(originalSessionBytes)
      expect(originalAgent.inner.kernel.stop).not.toHaveBeenCalled()
      expect(originalAgent.inner.kernel.input).not.toHaveBeenCalled()
      expect(f.runtime.resourceOwnerCounts()).toMatchObject({ sessionAttachmentOwners: 0, sessionAttachmentLeases: 0 })
    } finally { await server.stop(); await f.dispose(); await originalAgent.close() }
  })

  it('keeps referenced Host, saved data and publications after an attempted delete', async () => {
    const f = await registered()
    try {
      const save = ipc.handlers.get('config:save')!
      const referenced: AppConfig = { ...f.config, workspaces: [...f.config.workspaces, { id: 'remote-project', hostId: remote.id, name: 'Saved project', path: '/project', kind: 'folder' }] }
      await save({ senderFrame: Reflect.get(f.sender as object, 'mainFrame'), sender: f.sender } as unknown as IpcMainInvokeEvent, referenced, f.config)
      const bytes = await f.bytes()
      await expect(f.execute({ ...envelope, operation: 'settings.hosts.delete', id: remote.id, expected: remote })).rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
      expect(await f.bytes()).toBe(bytes)
      expect(await f.execute({ ...envelope, operation: 'settings.hosts.list' })).toEqual({ operation: 'settings.hosts.list', hosts: referenced.hosts })
    } finally { await f.dispose() }
  })
})


it('edits and removes a never-bound offline draft through the real Runtime preparation, retaining original bound Sessions and Runs', async () => {
  const clients = new Map<string, { connect: ReturnType<typeof vi.fn>; connectRuntime: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; agentSessions: ReturnType<typeof vi.fn>; readAgentSessions: ReturnType<typeof vi.fn>; listRuns: ReturnType<typeof vi.fn>; sessionHistorySources: ReturnType<typeof vi.fn>; onEvent: ReturnType<typeof vi.fn> }>()
  const connector = vi.fn(async (host: HostConfig) => {
    const client = { connect: vi.fn(async () => {}), connectRuntime: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}), agentSessions: vi.fn(() => []), readAgentSessions: vi.fn(async () => []),
      sessionHistorySources: vi.fn(async () => []), listRuns: vi.fn(async () => []), onEvent: vi.fn(() => () => {}) }
    clients.set(host.id, client)
    return client as never
  })
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), connector)
  const config = structuredClone(DEFAULT_CONFIG)
  const offline: HostConfig = { id: 'offline-draft', kind: 'ssh', label: 'Not installed', hostname: 'offline.invalid' }
  try {
    runtime.commit(await runtime.prepare(config))
    runtime.commit(await runtime.prepare({ ...config, hosts: [...config.hosts, offline] }))
    const draft = clients.get(offline.id)!
    draft.connect.mockRejectedValue(new Error('Core is not installed'))
    const corrected: HostConfig = { ...offline, hostname: 'corrected.invalid' }
    const correction = await runtime.prepare({ ...config, hosts: [...config.hosts, corrected] })
    expect(draft.connect).not.toHaveBeenCalled()
    expect(draft.listRuns).not.toHaveBeenCalled()
    runtime.commit(correction)
    expect(runtime.executionHost(offline.id)).toMatchObject({ id: offline.id })
    const correctedClient = clients.get(offline.id)!
    expect(correctedClient).not.toBe(draft)
    const removal = await runtime.prepare(config)
    expect(correctedClient.connect).not.toHaveBeenCalled()
    expect(draft.listRuns).not.toHaveBeenCalled()
    runtime.commit(removal)
    expect(() => runtime.executionHost(offline.id)).toThrow('not configured')

    const bound: HostConfig = { ...offline, id: 'bound', runtimeId: 'original-runtime' }
    runtime.commit(await runtime.prepare({ ...config, hosts: [...config.hosts, bound] }))
    const original = clients.get(bound.id)!
    original.readAgentSessions.mockResolvedValue([{ agentSessionId: 'original-ended-session', run: null }])
    await expect(runtime.prepare(config)).rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
    expect(runtime.executionHost(bound.id)).toBeDefined()
    expect(original.dispose).not.toHaveBeenCalled()
    original.readAgentSessions.mockResolvedValue([])
    original.listRuns.mockResolvedValue([{ runId: 'retained-ended-terminal', state: 'exited' }])
    await expect(runtime.prepare(config)).rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
    original.listRuns.mockResolvedValue([])
    original.readAgentSessions.mockRejectedValue(new Error('Original Session observation unavailable'))
    await expect(runtime.prepare(config)).rejects.toThrow('Original Session observation unavailable')
    original.readAgentSessions.mockResolvedValue([])
    original.sessionHistorySources.mockResolvedValue([{ agentSessionId: 'retired-resumable-session', hostId: 'bound', state: 'retired' }])
    await expect(runtime.prepare(config)).rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
    expect(original.dispose).not.toHaveBeenCalled()
    original.sessionHistorySources.mockRejectedValue(new Error('Original recovery references unavailable'))
    await expect(runtime.prepare(config)).rejects.toThrow('Original recovery references unavailable')

    expect(original.dispose).not.toHaveBeenCalled()
    expect(runtime.executionHost('local')).toBeDefined()
  } finally { await runtime.dispose() }
})


it('the compiled CLI corrects an unadopted offline Host through registered Main and real Runtime preparation', async () => {
  const clients = new Map<string, { connect: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[]>()
  const connector = vi.fn(async (host: HostConfig) => {
    const client = { connect: vi.fn(async () => { if (host.kind === 'ssh' && host.hostname === remote.hostname) throw new Error('Old SSH address is offline') }),
      connectRuntime: vi.fn(async () => {}), dispose: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}),
      agentSessions: vi.fn(() => []), readAgentSessions: vi.fn(async () => []), listRuns: vi.fn(async () => []),
      sessionHistorySources: vi.fn(async () => []), ...(host.kind === 'ssh' ? { runtimeOwnerIdentity: () => null } : {}) }
    clients.set(host.id, [...(clients.get(host.id) ?? []), client])
    return client as never
  })
  const f = await registered(connector)
  f.prepare.mockRestore(); f.commit.mockRestore()
  f.runtime.commit(await f.runtime.prepare(f.config))
  const original = clients.get(remote.id)![0]!, local = clients.get('local')![0]!
  await vi.waitFor(() => expect(original.connect).toHaveBeenCalledOnce())
  const core = await vi.importActual<typeof import('@agentmux/core')>('@agentmux/core')
  const socket = join(ipc.root, 'edit-real-runtime.sock'), server = new core.AgentMuxControlServer({ execute: f.execute, coreClients: () => [] }, socket)
  await server.start()
  try {
    const candidate = { ...remote, hostname: 'corrected.invalid' }
    const result = await runCompiledObjectCli(['settings', 'hosts', 'configure', remote.id, '--input', '-'],
      objectCliEnvironment(ipc.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + socket }), JSON.stringify({ expected: remote, candidate }), 20_000)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).result.host).toEqual(candidate)
    expect(JSON.parse(await f.bytes()).hosts.find((host: HostConfig) => host.id === remote.id)).toEqual(candidate)
    expect(original.connect).toHaveBeenCalledOnce()
    expect(clients.get(remote.id)).toHaveLength(2)
    expect(local.dispose).not.toHaveBeenCalled()
    expect(f.runtime.executionHost('local')).toBeDefined()
  } finally { await server.stop(); await f.dispose(); await f.runtime.dispose() }
}, 30_000)
