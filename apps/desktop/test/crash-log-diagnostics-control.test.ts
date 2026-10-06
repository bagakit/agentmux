const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm, chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'
import type { AppConfig, HostConfig } from '../src/shared/contracts.js'
import type { RuntimePreparation } from '../src/main/runtime-controller.js'
import type { ScratchTopics } from '../src/main/scratch-topics.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat) }
})

const ipc = vi.hoisted(() => ({ root: '',
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  execute: undefined as ((request: AgentMuxControlRequest) => Promise<AgentMuxControlResult>) | undefined
}))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  app: { getPath: () => ipc.root || tmpdir(), getAppPath: () => ipc.root || tmpdir() },
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
import { CrashLog } from '../src/main/crash-log.js'
import { registerWorkbenchStartupCapture } from '../src/main/workbench-startup-capture.js'
import { reportQuitDisposalFailure } from '../src/main/quit-disposal-failure.js'
import { runOwnerDisposals } from '../src/main/owner-disposal.js'

const directories: string[] = []
afterEach(async () => { vi.mocked(shell.showItemInFolder).mockReset(); vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true }))) })
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'host-settings' } as const
const remote: HostConfig = { id: '--help', kind: 'ssh', label: 'Saved connection', hostname: 'private.invalid', user: 'original', port: 22 }

async function registered(onRendererStartupFailure?: (input: unknown) => boolean) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-host-settings-')); directories.push(root); ipc.root = root
  const store = new ConfigStore(join(root, 'config.json'))
  const config = await store.save({ ...structuredClone(DEFAULT_CONFIG), hosts: [DEFAULT_CONFIG.hosts[0]!, remote],
    workspaces: [{ id: '__scratch__', name: 'Private Topics', path: join(root, 'topics'), hostId: 'local', kind: 'folder' }] })
  const preparation: RuntimePreparation = { hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  const prepare = vi.spyOn(runtime, 'prepare').mockResolvedValue(preparation)
  const commit = vi.spyOn(runtime, 'commit').mockImplementation(() => {})
  const attach = vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
  vi.spyOn(store, 'get').mockResolvedValue(config)
  const sender = Object.assign(new EventEmitter(), { id: 919, isDestroyed: () => false, send: vi.fn(), mainFrame: { framesInSubtree: [] } })
  const progressLoops = new ContinuousProgressLoopManager(ContinuousProgressLoopStore.forUserData(root),
    async () => { throw new Error('Host diagnostic cannot deliver progress input') }, undefined,
    async () => { throw new Error('Host diagnostic cannot observe progress input') })
  ipc.handlers.clear(); ipc.execute = undefined
  const dispose = await registerIpc({ initialConfig: await store.get(), window: { setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow,
    configStore: store, runtime, progressLoops, scratchTopics: { setNameAudit: () => {}, normalizeDirectoryIdentities: async () => {} } as unknown as ScratchTopics,
    workspaceFiles: new WorkspaceFiles(id => runtime.executionHost(id)),
    ...(onRendererStartupFailure ? { onRendererStartupFailure } : {}) })
  const execute = ipc.execute!
  const native = ipc.handlers.get('ui:revealCrashLog')!
  expect(execute).toBeTypeOf('function'); expect(native).toBeTypeOf('function')
  // Observe initial owner publications before measuring traffic caused by a diagnostics query.
  await vi.waitFor(() => {
    expect(sender.send.mock.calls.some(([channel]) => channel === 'notebook:changed')).toBe(true)
    expect(sender.send.mock.calls.some(([channel]) => channel === 'spatial:changed')).toBe(true)
  })
  // The registered Notes reader joins its real startup reconciliation before measuring diagnostics-only traffic.
  await ipc.handlers.get('notesStorage:inspect')!({ sender } as unknown as IpcMainInvokeEvent)
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
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
    try {
      const receipt = await rpc.call('system.crash-log.inspect', {})
      expect(receipt).toEqual({ path: join(f.root, 'crash-log.ndjson'), outcome: 'absent' })
      await expect(rpc.call('system.crash-log.reveal', {})).rejects.toMatchObject({ code: 'CONTROL_FAILED', message: expect.stringContaining('ENOENT') })
      await writeFile(join(f.root, 'crash-log.ndjson'), 'never output this body')
      vi.mocked(shell.showItemInFolder).mockImplementationOnce(() => { throw Object.assign(new Error('Original shell request failed'), { code: 'EIO' }) })
      await expect(rpc.call('system.crash-log.reveal', {})).rejects.toMatchObject({ code: 'CONTROL_FAILED', message: expect.stringContaining('EIO · Original shell request failed') })
      expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(join(f.root, 'crash-log.ndjson'))
    } finally { await rpc.dispose(); await server.stop(); await f.dispose() }
  })

  it('actual public CLI discovers and reveals the same retained quit diagnostic with nested original owner failure', async () => {
    const f = await registered(), core = await vi.importActual<typeof import('@agentmux/core')>('@agentmux/core')
    const socket = join(f.root, 'quit-control.sock'), server = new core.AgentMuxControlServer({ execute: f.execute }, socket)
    await server.start()
    const path = join(f.root, 'crash-log.ndjson'), log = new CrashLog(path), stderr: string[] = []
    const original = new Error('original file observer EIO')
    let failure: unknown
    try {
      await runOwnerDisposals([{ owner: 'file-observations', dispose: () => { throw original } }], 'IPC owners failed')
    } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(AggregateError)
    reportQuitDisposalFailure(new AggregateError([failure], 'Desktop owner disposal failed'), {
      persistDiagnostic: record => log.appendSync(record), stderr: { write: line => stderr.push(line) }, appVersion: 'cli-proof', pid: 4242
    })
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    const cli = fileURLToPath(new URL('../../../packages/core/dist/agentmux.js', import.meta.url))
    const execute = promisify(execFile)
    async function invoke(action: 'inspect' | 'reveal') {
      const output = await execute(process.execPath, [cli, 'system', 'crash-log', action], {
        env: { ...env, AGENTMUX_RPC_ENDPOINT: `unix:${socket}`, AGENTMUX_ENV: '1' }, timeout: 10_000, maxBuffer: 256 * 1024
      })
      const receipts = output.stdout.split('\n').filter(line => line.startsWith('{'))
      expect(receipts).toHaveLength(1)
      return JSON.parse(receipts[0]!) as { ok: boolean; operation: string; result: { path: string; outcome?: string; requested?: boolean } }
    }
    try {
      const inspect = await invoke('inspect')
      expect(inspect).toMatchObject({ ok: true, operation: 'system.crash-log.inspect', result: { path, outcome: 'present' } })
      const bytes = await readFile(inspect.result.path, 'utf8'), record = JSON.parse(bytes.trim())
      expect(record).toMatchObject({ kind: 'quit-disposal-failure', phase: 'dispose-owners', appVersion: 'cli-proof', pid: 4242 })
      expect(record.detail).toContain('file-observations')
      expect(record.detail).toContain(original.message)
      expect(stderr.join('')).toContain(original.message)
      expect(JSON.stringify(inspect)).not.toContain(original.message)
      const reveal = await invoke('reveal')
      expect(reveal).toMatchObject({ ok: true, operation: 'system.crash-log.reveal', result: { path, requested: true } })
      expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(path)
      expect(await readFile(path, 'utf8')).toBe(bytes)
    } finally { await server.stop(); await f.dispose() }
  })

  it('original startup capture reaches trusted Main IPC and actual public RPC/CLI without exposing its body', async () => {
    let capture: ReturnType<typeof registerWorkbenchStartupCapture> | undefined
    const f = await registered(input => capture?.recordRenderer(input) ?? false)
    const core = await vi.importActual<typeof import('@agentmux/core')>('@agentmux/core')
    const path = join(f.root, 'crash-log.ndjson'), log = new CrashLog(path)
    const contents = Object.assign(f.sender, { getOSProcessId: () => 919 })
    capture = registerWorkbenchStartupCapture({ contents, preloadPath: _hygiene_fixturePath("private/preload.cjs"),
      origin: () => ({ mode: 'prod', filePath: _hygiene_fixturePath("private/index.html") }), activeAttempt: () => 'original-loader-token',
      startupAttemptId: 'original-main-attempt', pid: 42, appVersion: 'private-proof', packageIdentity: null,
      sink: record => log.append(record), stderr: () => {} })
    const handler = ipc.handlers.get('ui:recordStartupFailure')!
    expect(handler).toBeTypeOf('function')
    const failure = { attemptId: 'original-loader-token', event: 'renderer-import-error',
      error: { name: 'Error', message: 'ORIGINAL_BOOTSTRAP_IMPORT_PRIVATE_BODY' } }
    expect(() => handler({ sender: {} } as IpcMainInvokeEvent, failure)).toThrow('Untrusted Workbench startup diagnostic sender')
    expect(handler({ sender: f.sender, senderFrame: {} } as unknown as IpcMainInvokeEvent, failure)).toBe(false)
    expect(handler({ sender: f.sender, senderFrame: f.sender.mainFrame } as unknown as IpcMainInvokeEvent,
      { ...failure, attemptId: 'old-loader-token' })).toBe(false)
    const socket = join(f.root, 'startup-control.sock'), server = new core.AgentMuxControlServer({ execute: f.execute }, socket)
    await server.start()
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
    const before = f.prepare.mock.calls.length
    try {
      expect(handler({ sender: f.sender, senderFrame: f.sender.mainFrame } as unknown as IpcMainInvokeEvent, failure)).toBe(true)
      await vi.waitFor(async () => { expect(await readFile(path, 'utf8')).toContain('ORIGINAL_BOOTSTRAP_IMPORT_PRIVATE_BODY') })
      const receipt = await rpc.call('system.crash-log.inspect', {})
      expect(receipt).toEqual({ path, outcome: 'present' })
      expect(JSON.stringify(receipt)).not.toContain('ORIGINAL_BOOTSTRAP')
      const record = JSON.parse((await readFile(path, 'utf8')).trim())
      expect(record).toMatchObject({ kind: 'workbench-startup-failure', sourceEvent: 'renderer-import-error',
        attemptId: 'original-loader-token', startupAttemptId: 'original-main-attempt', pid: 42, rendererPid: 919, packageIdentity: null })
      const cli = fileURLToPath(new URL('../../../packages/core/dist/agentmux.js', import.meta.url))
      const execute = promisify(execFile)
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
      const invoke = async (action: 'inspect' | 'reveal') => {
        const output = await execute(process.execPath, [cli, 'system', 'crash-log', action], {
          env: { ...env, AGENTMUX_RPC_ENDPOINT: `unix:${socket}`, AGENTMUX_ENV: '1' }, timeout: 10_000 })
        expect(output.stdout).not.toContain('ORIGINAL_BOOTSTRAP')
        return JSON.parse(output.stdout.split('\n').find(line => line.startsWith('{'))!)
      }
      expect(await invoke('inspect')).toMatchObject({ ok: true, result: receipt })
      expect(await invoke('reveal')).toMatchObject({ ok: true, result: { path, requested: true } })
      expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(path)
      expect(f.prepare.mock.calls.length).toBe(before)
    } finally { capture.dispose(); await rpc.dispose(); await server.stop(); await f.dispose() }
  })

})
