import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxControlRequest, AgentMuxControlResult, AgentMuxControlSettingsExecutorRefreshRequest } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts.js'
import type { RuntimePreparation } from '../src/main/runtime-controller.js'
import type { ScratchTopics } from '../src/main/scratch-topics.js'
import type { WorkspaceFiles } from '../src/main/workspace-files.js'

const ipc = vi.hoisted(() => ({ root: '', failurePath: '',
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  execute: undefined as ((request: AgentMuxControlRequest) => Promise<AgentMuxControlResult>) | undefined
}))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, stat: async (...args: Parameters<typeof actual.stat>) => {
    if (ipc.failurePath && String(args[0]) === ipc.failurePath) throw Object.assign(new Error('controlled executable I/O failure'), { code: 'EIO' })
    return await actual.stat(...args)
  } }
})
vi.mock('electron', () => ({
  app: { getPath: () => ipc.root || tmpdir() },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class {
    constructor(options: { execute: typeof ipc.execute }) { ipc.execute = options.execute }
    async start() {} async stop() {}
  }
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager.js', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal.js', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store.js', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager.js', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))

import { AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxClient, AgentMuxMemoryAgentSessionStore, LocalExecutionHost } from '@agentmux/core'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { registerIpc } from '../src/main/ipc.js'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store.js'

const roots: string[] = [], exec = promisify(execFile)
afterEach(async () => { ipc.failurePath = ''; vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true }))) })
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'exact-refresh', operation: 'settings.executors.refresh' } as const

async function registered() {
  const root = await mkdtemp(join(tmpdir(), 'amux-refresh-main-')); roots.push(root); ipc.root = root
  const executable = join(root, 'executable'), directory = join(root, 'directory')
  await writeFile(executable, '#!/bin/sh\n'); await chmod(executable, 0o755); await mkdir(directory)
  const store = new ConfigStore(join(root, 'config.json'))
  const config = await store.save({ ...structuredClone(DEFAULT_CONFIG), hosts: [DEFAULT_CONFIG.hosts[0]!,
    { id: '--help', kind: 'ssh', label: 'Remote label', hostname: 'literal.invalid', user: 'saved', port: 2202 }],
    executors: { first: { label: 'Saved label', providerId: 'codex', command: executable, args: [], env: { PRIVATE_VALUE: 'do-not-expose' }, injectAgentMuxGuide: true },
      second: { label: 'Second label', providerId: 'claude', command: directory, args: [], env: {}, injectAgentMuxGuide: true } },
    workspaces: [{ id: '__scratch__', name: 'Private Topics', path: join(root, 'topics'), hostId: 'local', kind: 'folder' }] })
  // Actual Core classifier and RuntimeController owner; connection lifecycle ports are controlled.
  // The remote client below is not a real SSH Runtime and cannot establish SSH support.
  const clients = config.hosts.map(() => {
    const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
    const internals = client as unknown as { connected: boolean; kernel: { isConnected(): boolean } }
    internals.connected = true; internals.kernel = { isConnected: () => true }
    vi.spyOn(client, 'connect').mockResolvedValue(); vi.spyOn(client, 'dispose').mockResolvedValue()
    vi.spyOn(client, 'probeExecutorAvailability')
    return client
  })
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
  let initialized = false
  const prepare = vi.spyOn(runtime, 'prepare').mockImplementation(async (current): Promise<RuntimePreparation> => {
    const hosts = initialized ? [] : current.hosts.map((host, index) => ({ id: host.id,
      executionHost: new LocalExecutionHost({ id: host.id, label: host.label }), client: clients[index]! }))
    initialized = true
    return { hosts, removedHostIds: [], reservedHostIds: [], hostSignatures: new Map(current.hosts.map(host => [host.id, JSON.stringify(host)])) }
  })
  vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
  vi.spyOn(store, 'get').mockResolvedValue(config)
  const sender = { id: 919, isDestroyed: vi.fn(() => false), send: vi.fn(), mainFrame: { framesInSubtree: [] } }
  const progressLoops = new ContinuousProgressLoopManager(ContinuousProgressLoopStore.forUserData(root),
    async () => { throw new Error('Refresh cannot deliver progress input') }, undefined,
    async () => { throw new Error('Refresh cannot observe progress input') })
  ipc.handlers.clear(); ipc.execute = undefined
  const dispose = await registerIpc({ window: { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow,
    configStore: store, runtime, progressLoops, scratchTopics: {} as ScratchTopics,
    workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  expect(ipc.execute).toBeTypeOf('function'); expect(ipc.handlers.get('executors:detect')).toBeTypeOf('function')
  return { root, config, executable, directory, clients, runtime, prepare, sender, dispose, execute: ipc.execute!,
    native: (executorId: unknown, hostId: unknown) => ipc.handlers.get('executors:detect')!({ sender } as unknown as IpcMainInvokeEvent, executorId, hostId),
    bytes: () => readFile(store.filePath, 'utf8') }
}

describe('Executor Refresh reaches the registered Main configuration owner', () => {
  it('actual public CLI and native IPC use the same Core file fact and exact saved targets without a View', async () => {
    const f = await registered(), before = await f.bytes(), publications = f.sender.send.mock.calls.length, preparations = f.prepare.mock.calls.length
    const core = await vi.importActual<typeof import('@agentmux/core')>('@agentmux/core')
    const server = new core.AgentMuxControlServer({ execute: f.execute }, join(f.root, 'control.sock'))
    await server.start()
    try {
      f.sender.isDestroyed.mockReturnValue(true)
      const result = await exec(process.execPath, [resolve('packages/core/bin/agentmux'), 'settings', 'executors', 'refresh', 'first', '--host', 'local'],
        { timeout: 5_000, env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: f.root, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined } })
      expect(JSON.parse(result.stdout).result).toEqual({ input: { executorId: 'first', providerId: 'codex', command: f.executable, host: f.config.hosts[0] },
        executable: f.executable, availability: 'available' })
      expect(f.clients[0]!.probeExecutorAvailability).toHaveBeenCalledExactlyOnceWith('codex', f.executable)
      const directory = await f.native('second', 'local')
      expect(directory).toEqual({ input: { executorId: 'second', providerId: 'claude', command: f.directory, host: f.config.hosts[0] },
        executable: f.directory, availability: 'missing', cause: { code: 'EXECUTABLE_NOT_FILE', message: `${f.directory} is a directory; expected a regular executable file.` } })
      vi.mocked(f.clients[1]!.connect).mockRejectedValueOnce(Object.assign(new Error('Remote Runtime is not supported.'), { code: 'REMOTE_UNSUPPORTED' }))
      const remote = await core.requestAgentMuxControl({ ...envelope, executorId: 'second', hostId: '--help' }, join(f.root, 'control.sock'))
      expect(remote).toMatchObject({ result: { input: { executorId: 'second', providerId: 'claude', command: f.directory, host: f.config.hosts[1] },
        availability: 'check-failed', cause: { code: 'REMOTE_UNSUPPORTED', message: 'Remote Runtime is not supported.' } } })
      expect(remote.result).not.toHaveProperty('executable'); expect(f.clients[1]!.probeExecutorAvailability).not.toHaveBeenCalled()
      expect(JSON.stringify([directory, remote])).not.toContain('do-not-expose')
      expect(await f.bytes()).toBe(before); expect(f.prepare).toHaveBeenCalledTimes(preparations)
      expect(f.sender.send).toHaveBeenCalledTimes(publications)
    } finally { await server.stop(); await f.dispose() }
  })

  it('preserves actual Core unknown I/O cause and missing facts without configuration publication', async () => {
    const f = await registered(), before = await f.bytes(), publications = f.sender.send.mock.calls.length
    try {
      ipc.failurePath = f.executable
      expect(await f.execute({ ...envelope, executorId: 'first', hostId: 'local' })).toMatchObject({
        availability: 'check-failed', executable: f.executable, cause: { code: 'EIO', message: 'controlled executable I/O failure' }
      })
      ipc.failurePath = ''; await rm(f.executable)
      expect(await f.native('first', 'local')).toMatchObject({ availability: 'missing', executable: f.executable })
      expect(await f.bytes()).toBe(before); expect(f.sender.send).toHaveBeenCalledTimes(publications)
    } finally { await f.dispose() }
  })

  it('captures committed command before an await and takes later commands from the sole current owner', async () => {
    const f = await registered()
    const probe = vi.mocked(f.clients[0]!.probeExecutorAvailability), original = AgentMuxClient.prototype.probeExecutorAvailability
    expect(original).toBeTypeOf('function')
    let release!: () => void
    const held = new Promise<void>(done => { release = done })
    probe.mockImplementationOnce(async (providerId, command) => { await held; return await original.call(f.clients[0]!, providerId, command) })
    const pending = f.execute({ ...envelope, executorId: 'first', hostId: 'local' })
    try {
      const changed: AppConfig = { ...f.config, executors: { ...f.config.executors, first: { ...f.config.executors.first!, command: f.directory } } }
      await ipc.handlers.get('config:save')!({ sender: f.sender } as unknown as IpcMainInvokeEvent, changed, f.config)
      release()
      const observed = await pending
      expect(observed, JSON.stringify(observed)).toMatchObject({ input: { executorId: 'first', command: f.executable }, executable: f.executable, availability: 'available' })
      expect(await f.execute({ ...envelope, executorId: 'first', hostId: 'local' })).toMatchObject({ input: { executorId: 'first', command: f.directory },
        executable: f.directory, availability: 'missing', cause: { code: 'EXECUTABLE_NOT_FILE' } })
      expect(probe).toHaveBeenNthCalledWith(1, 'codex', f.executable); expect(probe).toHaveBeenNthCalledWith(2, 'codex', f.directory)
    } finally { release(); await pending; await f.dispose() }
  })

  it('rejects unknown exact IDs and invalid IPC input before probing; never guesses a label or local target', async () => {
    const f = await registered(), before = await f.bytes()
    try {
      for (const target of [{ executorId: 'Saved label', hostId: 'local' }, { executorId: 'first', hostId: 'Remote label' },
        { executorId: 'unknown', hostId: 'local' }, { executorId: 'first', hostId: 'unknown' }]) {
        await expect(f.execute({ ...envelope, ...target } as AgentMuxControlSettingsExecutorRefreshRequest)).rejects.toMatchObject({ code: 'SETTING_RESOURCE_NOT_FOUND' })
      }
      for (const pair of [[null, 'local'], ['first', 1], ['', 'local']]) await expect(f.native(...pair as [unknown, unknown])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
      expect(f.clients).toHaveLength(2)
      expect(f.clients.map(client => client.probeExecutorAvailability.mock.calls)).toEqual([[], []])
      expect(await f.bytes()).toBe(before)
    } finally { await f.dispose() }
  })
})
