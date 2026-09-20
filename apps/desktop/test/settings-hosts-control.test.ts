import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'
import type { AppConfig, HostConfig } from '../src/shared/contracts.js'
import type { RuntimePreparation } from '../src/main/runtime-controller.js'
import type { ScratchTopics } from '../src/main/scratch-topics.js'
import type { WorkspaceFiles } from '../src/main/workspace-files.js'

const ipc = vi.hoisted(() => ({ root: '',
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  execute: undefined as ((request: AgentMuxControlRequest) => Promise<AgentMuxControlResult>) | undefined
}))
vi.mock('electron', () => ({
  app: { getPath: () => ipc.root || tmpdir() },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
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

import { AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { registerIpc } from '../src/main/ipc.js'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store.js'

const directories: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true }))) })
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'host-settings' } as const
const remote: HostConfig = { id: '--help', kind: 'ssh', label: 'Saved connection', hostname: 'private.invalid', user: 'original', port: 22 }

async function registered() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-host-settings-')); directories.push(root); ipc.root = root
  const store = new ConfigStore(join(root, 'config.json'))
  const config = await store.save({ ...structuredClone(DEFAULT_CONFIG), hosts: [DEFAULT_CONFIG.hosts[0]!, remote],
    workspaces: [{ id: '__scratch__', name: 'Private Topics', path: join(root, 'topics'), hostId: 'local', kind: 'folder' }] })
  const preparation: RuntimePreparation = { hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
  const prepare = vi.spyOn(runtime, 'prepare').mockResolvedValue(preparation)
  const commit = vi.spyOn(runtime, 'commit').mockImplementation(() => {})
  const attach = vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
  vi.spyOn(store, 'get').mockResolvedValue(config)
  const sender = { id: 919, isDestroyed: () => false, send: vi.fn(), mainFrame: { framesInSubtree: [] } }
  const progressLoops = new ContinuousProgressLoopManager(ContinuousProgressLoopStore.forUserData(root),
    async () => { throw new Error('Host diagnostic cannot deliver progress input') }, undefined,
    async () => { throw new Error('Host diagnostic cannot observe progress input') })
  ipc.handlers.clear(); ipc.execute = undefined
  const dispose = await registerIpc({ window: { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow,
    configStore: store, runtime, progressLoops, scratchTopics: {} as ScratchTopics,
    workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  const execute = ipc.execute!
  const native = ipc.handlers.get('hosts:check')!
  expect(execute).toBeTypeOf('function'); expect(native).toBeTypeOf('function')
  return { config, runtime, prepare, commit, attach, sender, dispose, execute,
    native: (input: unknown) => native({ sender } as unknown as IpcMainInvokeEvent, input),
    bytes: () => readFile(store.filePath, 'utf8') }
}

describe('Host diagnostics use the registered Main owner', () => {
  it('preserves Main validation and not-found codes through the actual public Control Server', async () => {
    const f = await registered(), bytes = await f.bytes(), check = vi.spyOn(f.runtime, 'checkHost')
    const core = await vi.importActual<typeof import('@agentmux/core')>('@agentmux/core')
    const socket = join(ipc.root, 'owned-control.sock'), server = new core.AgentMuxControlServer({ execute: f.execute }, socket)
    await server.start()
    try {
      await expect(core.requestAgentMuxControl({ ...envelope, operation: 'settings.hosts.test', input: { ...remote, port: '22' } }, socket)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
      await expect(core.requestAgentMuxControl({ ...envelope, operation: 'settings.hosts.test', id: 'unknown' }, socket)).rejects.toMatchObject({ code: 'SETTING_RESOURCE_NOT_FOUND' })
      expect(check).not.toHaveBeenCalled(); expect(await f.bytes()).toBe(bytes)
    } finally { await server.stop(); await f.dispose() }
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
      await set({ sender: f.sender } as unknown as IpcMainInvokeEvent, changed, f.config)
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
    const publications = f.sender.send.mock.calls.length, preparations = f.prepare.mock.calls.length
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
      expect(await f.bytes()).toBe(bytes); expect(f.sender.send).toHaveBeenCalledTimes(publications)
      expect(f.prepare).toHaveBeenCalledTimes(preparations)
    } finally { await f.dispose() }
  })

  it('keeps unknown read and cleanup failures distinct from explicit REMOTE_UNSUPPORTED', async () => {
    const f = await registered(), bytes = await f.bytes(), check = vi.spyOn(f.runtime, 'checkHost')
    const publications = f.sender.send.mock.calls.length, preparations = f.prepare.mock.calls.length
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
      expect(await f.bytes()).toBe(bytes); expect(f.sender.send).toHaveBeenCalledTimes(publications)
      expect(f.prepare).toHaveBeenCalledTimes(preparations)
    } finally { await f.dispose() }
  })

  it('preserves actual Core SSH refusal without a Runtime preparation seam or a remote launch', async () => {
    const f = await registered(), bytes = await f.bytes(), publications = f.sender.send.mock.calls.length
    try {
      // checkHost, prepareHost, Host factory and connectSshAgentMux are actual production implementations.
      expect(await f.native(remote)).toMatchObject({ input: remote, outcome: 'unsupported', detail: expect.stringContaining('ctxmux Remote contract') })
      expect(await f.execute({ ...envelope, operation: 'settings.hosts.test', id: '--help' })).toMatchObject({ input: remote, outcome: 'unsupported' })
      expect(await f.bytes()).toBe(bytes); expect(f.sender.send).toHaveBeenCalledTimes(publications)
      expect(f.runtime.resourceOwnerCounts()).toEqual({ sessionAttachmentOwners: 0, sessionAttachmentLeases: 0 })
    } finally { await f.dispose() }
  })
})
