import { mkdtemp, readFile, rm, chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'
import type { AppConfig, HostConfig } from '../src/shared/contracts.js'
import type { RuntimePreparation } from '../src/main/runtime-controller.js'
import type { ScratchTopics } from '../src/main/scratch-topics.js'
import type { WorkspaceFiles } from '../src/main/workspace-files.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat) }
})

const ipc = vi.hoisted(() => ({ root: '',
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  execute: undefined as ((request: AgentMuxControlRequest) => Promise<AgentMuxControlResult>) | undefined
}))
vi.mock('electron', () => ({
  app: { getPath: () => ipc.root || tmpdir() },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: { showItemInFolder: vi.fn() }
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

import { shell } from 'electron'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { registerIpc } from '../src/main/ipc.js'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store.js'

const directories: string[] = []
afterEach(async () => { vi.mocked(shell.showItemInFolder).mockReset(); vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true }))) })
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
  const native = ipc.handlers.get('ui:revealCrashLog')!
  expect(execute).toBeTypeOf('function'); expect(native).toBeTypeOf('function')
  return { config, runtime, prepare, commit, attach, sender, dispose, execute,
    root, native: () => native({ sender } as unknown as IpcMainInvokeEvent),
    bytes: () => readFile(store.filePath, 'utf8') }
}


describe('registered Main crash log diagnostics share one fixed-path owner', () => {
  const get = (f: Awaited<ReturnType<typeof registered>>) => f.execute({ ...envelope, operation: 'diagnostics.crash-log.get' })
  const reveal = (f: Awaited<ReturnType<typeof registered>>) => f.execute({ ...envelope, operation: 'diagnostics.crash-log.reveal' })

  it('reports absent and nonregular facts accurately without any shell or configuration write', async () => {
    const f = await registered(), path = join(f.root, 'crash-log.ndjson'), bytes = await f.bytes()
    const publications = f.sender.send.mock.calls.length, preparations = f.prepare.mock.calls.length
    try {
      expect(await get(f)).toEqual({ operation: 'diagnostics.crash-log.get', path, outcome: 'absent' })
      expect(await f.native()).toEqual({ path, outcome: 'absent' })
      await expect(reveal(f)).rejects.toMatchObject({ code: 'CONTROL_FAILED', detail: 'ENOENT' })
      await mkdir(path)
      const fact = { path, outcome: 'check-failed', cause: { code: 'CRASH_LOG_NOT_FILE', message: 'The crash log path is not a regular file.' } }
      expect(await get(f)).toEqual({ operation: 'diagnostics.crash-log.get', ...fact })
      expect(await f.native()).toEqual(fact)
      await expect(reveal(f)).rejects.toMatchObject({ code: 'CRASH_LOG_NOT_FILE' })
      expect(shell.showItemInFolder).not.toHaveBeenCalled()
      expect(await f.bytes()).toBe(bytes)
      expect(f.sender.send.mock.calls.length).toBe(publications); expect(f.prepare.mock.calls.length).toBe(preparations)
    } finally { await f.dispose() }
  })

  it('only explicit current present reveal requests the actual registered shell owner once per caller', async () => {
    const f = await registered(), path = join(f.root, 'crash-log.ndjson'), original = 'PRIVATE_LOG_BODY_NEVER_OUTPUT\n'
    const bytes = await f.bytes(), publications = f.sender.send.mock.calls.length, preparations = f.prepare.mock.calls.length
    try {
      await writeFile(path, original)
      const fact = await get(f)
      expect(fact).toEqual({ operation: 'diagnostics.crash-log.get', path, outcome: 'present' })
      expect(shell.showItemInFolder).not.toHaveBeenCalled()
      expect(await f.native()).toEqual({ path, outcome: 'requested' })
      expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(path)
      const request = await reveal(f)
      expect(request).toEqual({ operation: 'diagnostics.crash-log.reveal', path, requested: true })
      expect(vi.mocked(shell.showItemInFolder).mock.calls).toEqual([[path], [path]])
      expect(JSON.stringify([fact, request])).not.toContain(original.trim())
      expect(await readFile(path, 'utf8')).toBe(original); expect(await f.bytes()).toBe(bytes)
      expect(f.sender.send.mock.calls.length).toBe(publications); expect(f.prepare.mock.calls.length).toBe(preparations)
    } finally { await f.dispose() }
  })

  it('preserves actual filesystem EACCES and controlled EIO instead of calling original evidence absent', async () => {
    const f = await registered(), path = join(f.root, 'crash-log.ndjson'), original = 'original evidence\n'
    const bytes = await f.bytes(), publications = f.sender.send.mock.calls.length
    try {
      await writeFile(path, original)
      await chmod(f.root, 0o000)
      await expect(stat(path)).rejects.toMatchObject({ code: 'EACCES' })
      const fact = await get(f)
      expect(fact).toMatchObject({ operation: 'diagnostics.crash-log.get', path, outcome: 'check-failed', cause: { code: 'EACCES' } })
      const native = await f.native()
      expect(native).toMatchObject({ path, outcome: 'check-failed', cause: { code: 'EACCES' } })
      await expect(reveal(f)).rejects.toMatchObject({ code: 'CONTROL_FAILED', detail: 'EACCES' })
      expect(shell.showItemInFolder).not.toHaveBeenCalled()
      await chmod(f.root, 0o700)
      vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error('Controlled owned EIO'), { code: 'EIO' }))
      expect(await get(f)).toEqual({ operation: 'diagnostics.crash-log.get', path, outcome: 'check-failed', cause: { code: 'EIO', message: 'Controlled owned EIO' } })
      expect(await get(f)).toEqual({ operation: 'diagnostics.crash-log.get', path, outcome: 'present' })
    } finally {
      await chmod(f.root, 0o700)
      expect(await readFile(path, 'utf8')).toBe(original); expect(await f.bytes()).toBe(bytes)
      expect(f.sender.send.mock.calls.length).toBe(publications)
      await f.dispose()
    }
  })

  it('public Control returns the same Main fact with no View and preserves typed reveal failure', async () => {
    const f = await registered(), core = await vi.importActual<typeof import('@agentmux/core')>('@agentmux/core')
    const socket = join(f.root, 'owned-control.sock'), server = new core.AgentMuxControlServer({ execute: f.execute }, socket)
    await server.start()
    try {
      const receipt = await core.requestAgentMuxControl({ ...envelope, operation: 'diagnostics.crash-log.get' }, socket)
      expect(receipt.result).toEqual({ path: join(f.root, 'crash-log.ndjson'), outcome: 'absent' })
      await expect(core.requestAgentMuxControl({ ...envelope, operation: 'diagnostics.crash-log.reveal' }, socket)).rejects.toMatchObject({ code: 'CONTROL_FAILED', message: expect.stringContaining('ENOENT') })
      await writeFile(join(f.root, 'crash-log.ndjson'), 'never output this body')
      vi.mocked(shell.showItemInFolder).mockImplementationOnce(() => { throw Object.assign(new Error('Original shell request failed'), { code: 'EIO' }) })
      await expect(core.requestAgentMuxControl({ ...envelope, operation: 'diagnostics.crash-log.reveal' }, socket)).rejects.toMatchObject({ code: 'CONTROL_FAILED', message: expect.stringContaining('EIO · Original shell request failed') })
      expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(join(f.root, 'crash-log.ndjson'))
    } finally { await server.stop(); await f.dispose() }
  })
})
