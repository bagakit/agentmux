import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxControlRequest, AgentMuxControlResult, ExecutionHost } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts.js'
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
// Capture the actual registered Main closure without opening the user's default endpoint.
// Every test below then hosts that closure on the actual public Core server at an owned path.
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class {
    constructor(options: { execute: typeof ipc.execute }) { ipc.execute = options.execute }
    async start() {} async stop() {}
  }
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager.js', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal.js', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'owned.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store.js', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager.js', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))

import { AgentMuxMemoryAgentSessionStore, AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS, AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import { RuntimeController, type RuntimePreparation } from '../src/main/runtime-controller.js'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store.js'
import { registerIpc } from '../src/main/ipc.js'
import { CONFIG_CHANGED_CHANNEL } from '../src/shared/contracts.js'

const roots: string[] = [], exec = promisify(execFile)
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true }))) })
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'owned-durable-write' } as const
const set = { ...envelope, operation: 'settings.set', key: 'copyPathsAsAbsolute', value: 'true' } as const
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function registered() {
  const root = await mkdtemp(join(tmpdir(), 'amux-write-main-')); roots.push(root); ipc.root = root
  const store = new ConfigStore(join(root, 'config.json'))
  const initial = await store.save({ ...structuredClone(DEFAULT_CONFIG), copyPathsAsAbsolute: false,
    browser: { ...DEFAULT_CONFIG.browser, appLinkSchemes: { literal: 'allow' } }, composerShortcuts: [],
    workspaces: [{ id: '__scratch__', name: 'Owned Topics', path: join(root, 'topics'), hostId: 'local', kind: 'folder' }] })
  vi.spyOn(store, 'get').mockResolvedValue(initial)
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
  const preparation: RuntimePreparation = { hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] }
  const trace: string[] = []
  const prepare = vi.spyOn(runtime, 'prepare').mockImplementation(async () => { trace.push('prepare'); return preparation })
  const actualCommit = runtime.commit.bind(runtime)
  const commit = vi.spyOn(runtime, 'commit').mockImplementation(value => { actualCommit(value); trace.push('commit') })
  vi.spyOn(runtime, 'executionHost').mockReturnValue({} as ExecutionHost)
  vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
  const progressLoops = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(root, 'loops.json')),
    async () => 'unknown', undefined, async () => { throw new Error('No private automatic input is admitted') })
  const publications: AppConfig[] = [], published = deferred()
  const sender = Object.assign(new EventEmitter(), { id: 947, isDestroyed: () => false, mainFrame: { framesInSubtree: [] },
    send: vi.fn((channel: string, value: unknown) => {
      if (channel === CONFIG_CHANGED_CHANNEL) { publications.push(value as AppConfig); trace.push('publish'); published.resolve() }
    }) })
  ipc.handlers.clear(); ipc.execute = undefined
  const dispose = await registerIpc({ window: { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow,
    configStore: store, runtime, progressLoops, scratchTopics: {} as ScratchTopics,
    workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  expect(ipc.execute).toBeTypeOf('function')
  prepare.mockClear(); commit.mockClear(); trace.length = 0
  const actualSave = store.save.bind(store)
  const save = vi.spyOn(store, 'save').mockImplementation(async next => {
    trace.push('save.begin'); const saved = await actualSave(next); trace.push('save.end'); return saved
  })
  const core = await vi.importActual<typeof import('@agentmux/core')>('@agentmux/core')
  const path = join(root, 'control.sock'), execute = vi.fn(ipc.execute!)
  const server = new core.AgentMuxControlServer({ execute }, path)
  await server.start()
  return { root, store, prepare, commit, save, trace, publications, published, execute,
    bytes: () => readFile(store.filePath, 'utf8'),
    disk: async () => JSON.parse(await readFile(store.filePath, 'utf8')) as AppConfig,
    request: (input: AgentMuxControlRequest) => core.requestAgentMuxControl(input, path), path,
    holdSave: () => {
      const entered = deferred(), release = deferred()
      save.mockImplementationOnce(async next => {
        trace.push('save.begin'); entered.resolve(); await release.promise
        const saved = await actualSave(next); trace.push('save.end'); return saved
      })
      return { entered, release }
    },
    dispose: async () => {
      // A disconnected peer does not cancel Main's admitted save. Finish owned executions
      // before removing their storage, including when a deliberately short budget fails.
      await Promise.allSettled(execute.mock.results.filter(result => result.type === 'return').map(result => result.value))
      await server.stop(); await dispose(); await progressLoops.stop()
    }
  }
}

describe('Control writes settle through the registered Main owner', () => {
  it('waits past the old short budget for actual durable save, commit and publication before replying', async () => {
    const f = await registered(), before = await f.bytes(), hold = f.holdSave()
    let settled = false
    const reply = f.request(set).then(value => { settled = true; f.trace.push('reply'); return { ok: true, value } },
      error => { settled = true; return { ok: false, error } })
    try {
      await hold.entered.promise
      await new Promise(resolve => setTimeout(resolve, AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS + 150))
      expect(settled).toBe(false)
      expect(await f.bytes()).toBe(before)
      expect(f.commit).not.toHaveBeenCalled(); expect(f.publications).toEqual([])
      const pending = await f.request({ ...envelope, operation: 'settings.get', target: 'copyPathsAsAbsolute' })
      expect(pending.result).toMatchObject({ entries: [{ value: false }] })
      hold.release.resolve()
      const result = await reply
      expect(result.ok).toBe(true)
      if (!result.ok || !('value' in result)) throw new Error('Expected the committed Control reply')
      expect(result.value.result).toMatchObject({ entry: { key: set.key, value: true } })
      expect(await readFile(f.store.previousVersionPath, 'utf8')).toBe(before)
      expect((await f.disk()).copyPathsAsAbsolute).toBe(true)
      expect(f.trace).toEqual(['prepare', 'save.begin', 'save.end', 'commit', 'publish', 'reply'])
      expect(f.save).toHaveBeenCalledTimes(1); expect(f.commit).toHaveBeenCalledTimes(1)
      expect(f.publications).toHaveLength(1)
    } finally { hold.release.resolve(); await reply; await f.dispose() }
  }, 10_000)

  it('finishes one already-entered real save after peer disconnect and lets the next public client read current state', async () => {
    const f = await registered(), before = await f.bytes(), hold = f.holdSave()
    const socket = createConnection(f.path)
    socket.on('error', () => {})
    socket.once('connect', () => socket.write(`${JSON.stringify(set)}\n`))
    try {
      await hold.entered.promise
      await new Promise<void>(resolve => { socket.once('close', resolve); socket.destroy() })
      expect(await f.bytes()).toBe(before); expect(f.commit).not.toHaveBeenCalled()
      expect(f.publications).toEqual([])
      hold.release.resolve(); await f.published.promise
      const current = await f.request({ ...envelope, operation: 'settings.get', target: set.key })
      expect(current.result).toMatchObject({ entries: [{ key: set.key, value: true }] })
      expect((await f.disk()).copyPathsAsAbsolute).toBe(true)
      expect(await readFile(f.store.previousVersionPath, 'utf8')).toBe(before)
      expect(f.trace).toEqual(['prepare', 'save.begin', 'save.end', 'commit', 'publish'])
      expect(f.save).toHaveBeenCalledTimes(1); expect(f.commit).toHaveBeenCalledTimes(1)
      expect(f.publications).toHaveLength(1)
    } finally { socket.destroy(); hold.release.resolve(); await f.dispose() }
  })

  it('does not enter registered Main or mutate any config fact for a valid JSON request without LF', async () => {
    const f = await registered(), before = await f.bytes()
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(f.path); let bytes = ''
        socket.on('error', reject); socket.on('data', chunk => { bytes += chunk.toString('utf8') })
        socket.once('connect', () => socket.end(JSON.stringify(set)))
        socket.once('end', () => { socket.destroy(); resolve(bytes) })
      })
      expect(JSON.parse(reply)).toMatchObject({ ok: false, error: { code: 'CONTROL_PROTOCOL_ERROR',
        message: 'Control connection closed before a complete message was received.' } })
      expect(f.execute).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled()
      expect(f.save).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
      expect(f.publications).toEqual([]); expect(await f.bytes()).toBe(before)
    } finally { await f.dispose() }
  })

  it('routes all six exact write operations through actual Main persistence and leaves invalid/nochange requests untouched', async () => {
    const f = await registered()
    const requests: AgentMuxControlRequest[] = [set,
      { ...envelope, operation: 'settings.browser.links.forget', scheme: 'literal' },
      { ...envelope, operation: 'settings.workspaces.add', input: { hostId: 'local', path: join(f.root, 'literal project') } },
      { ...envelope, operation: 'settings.resource.add', resource: 'prompts', id: 'literal', value: { keyword: 'literal', label: 'Literal', body: '$literal\nbody' } },
      { ...envelope, operation: 'settings.resource.update', resource: 'prompts', id: 'literal', changes: { body: 'updated literal' } },
      { ...envelope, operation: 'settings.resource.remove', resource: 'prompts', id: 'literal' }]
    try {
      expect(requests).toHaveLength(6)
      for (const request of requests) expect(await f.request(request)).toMatchObject({ ok: true, operation: request.operation })
      expect(f.save).toHaveBeenCalledTimes(6); expect(f.prepare).toHaveBeenCalledTimes(6)
      expect(f.commit).toHaveBeenCalledTimes(6); expect(f.publications).toHaveLength(6)
      const before = await f.bytes(), previous = await readFile(f.store.previousVersionPath, 'utf8')
      await expect(f.request(set)).resolves.toMatchObject({ result: { entry: { value: true } } })
      await expect(f.request({ ...set, value: 'TRUE' })).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
      expect(await f.bytes()).toBe(before); expect(await readFile(f.store.previousVersionPath, 'utf8')).toBe(previous)
      expect(f.save).toHaveBeenCalledTimes(6); expect(f.prepare).toHaveBeenCalledTimes(6)
      expect(f.commit).toHaveBeenCalledTimes(6); expect(f.publications).toHaveLength(6)
    } finally { await f.dispose() }
  })

  it('keeps the built CLI pending past the old short budget until actual Main save and publication finish', async () => {
    const f = await registered(), before = await f.bytes(), hold = f.holdSave()
    let settled = false
    const reply = exec(process.execPath, [resolve('packages/core/bin/agentmux'), 'settings', 'set', set.key, set.value],
      { timeout: 10_000, env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: f.root,
        AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined } }).then(value => {
      settled = true; f.trace.push('reply'); return { ok: true, value }
    }, error => { settled = true; return { ok: false, error } })
    try {
      await hold.entered.promise
      await new Promise(resolve => setTimeout(resolve, AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS + 150))
      expect(settled).toBe(false); expect(await f.bytes()).toBe(before)
      expect(f.commit).not.toHaveBeenCalled(); expect(f.publications).toEqual([])
      hold.release.resolve()
      const result = await reply
      expect(result.ok).toBe(true)
      if (!result.ok || !('value' in result)) throw new Error('Expected the committed built CLI reply')
      expect(JSON.parse(result.value.stdout)).toMatchObject({ ok: true, operation: 'settings.set', result: { entry: { key: set.key, value: true } } })
      expect(await readFile(f.store.previousVersionPath, 'utf8')).toBe(before)
      expect((await f.disk()).copyPathsAsAbsolute).toBe(true)
      expect(f.trace).toEqual(['prepare', 'save.begin', 'save.end', 'commit', 'publish', 'reply'])
      expect(f.save).toHaveBeenCalledTimes(1); expect(f.commit).toHaveBeenCalledTimes(1)
      expect(f.publications).toHaveLength(1)
    } finally { hold.release.resolve(); await reply; await f.dispose() }
  }, 10_000)
})
