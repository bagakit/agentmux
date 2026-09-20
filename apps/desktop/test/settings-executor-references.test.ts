import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest'
import { AgentMuxClient, AgentMuxError, AgentMuxMemoryAgentSessionStore, AgentProviderRegistry,
  LocalExecutionHost, defineAgentProvider, loadAgentSessions,
  type AgentMuxStoredAgentSession, type AgentMuxRunInputData, type AgentProviderSessionHistoryContext,
  type AgentProviderSessionHistoryPage } from '@agentmux/core'
import type { AgentMuxAgentSessionRegistry } from '../../../packages/core/src/agent-session-registry.js'
import type { CtxmuxAdapterRun, CtxmuxRunAdapter } from '../../../packages/core/src/ctxmux-run-adapter.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { BROWSER_TOOLBAR_ITEM_ORDER } from '../src/shared/browser-toolbar.js'
import { CONFIG_CHANGED_CHANNEL, CONFIG_VERSION, type AppConfig, type AgentSessionControl } from '../src/shared/contracts.js'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'
import type { ScratchTopics } from '../src/main/scratch-topics.js'
import type { WorkspaceFiles } from '../src/main/workspace-files.js'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  execute: undefined as ((request: AgentMuxControlRequest) => Promise<AgentMuxControlResult>) | undefined
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/private-executor-reference-ipc' },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class {
    constructor(options: { execute: (request: AgentMuxControlRequest) => Promise<AgentMuxControlResult> }) { ipc.execute = options.execute }
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
import { ConfigStore } from '../src/main/config-store.js'
import { registerIpc } from '../src/main/ipc.js'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store.js'

// Actual Runtime and Core admission, Store, input and Provider History execute. Only the
// kernel transport and native Provider I/O are synthetic; no OS Run, App or install starts.
type CoreHarness = { connected: boolean; registry: AgentMuxAgentSessionRegistry; kernel: CtxmuxRunAdapter }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}

describe('Executor identity edits use retained Core facts and bounded launch admission', () => {
  let root: string, core: AgentMuxClient, runtime: RuntimeController, store: AgentMuxMemoryAgentSessionStore
  let config: AppConfig, retained: AgentMuxStoredAgentSession, kernel: CtxmuxRunAdapter
  let runs: Map<string, CtxmuxAdapterRun>, writes: Array<{ runId: string; data: AgentMuxRunInputData }>
  let nativeHistory: Mock<(context: AgentProviderSessionHistoryContext) => Promise<AgentProviderSessionHistoryPage>>
  let connect: MockInstance<AgentMuxClient['connect']>

  function record(id: string, executorId = 'kept', providerId = 'codex', hostId = 'local'): AgentMuxStoredAgentSession {
    return { kind: 'agent', agentSessionId: id, executorId, providerId, hostId, workspacePath: root,
      run: { runId: `run-${id}` }, retiredRuns: [], hookBindingId: `binding-${id}`, hookToken: `token-${id}`,
      nativeHandle: { kind: 'provider', providerId, sessionId: `native-${id}` }, createdAt: 1, updatedAt: 1 }
  }

  function run(id: string, state: CtxmuxAdapterRun['state'] = { type: 'running' }): CtxmuxAdapterRun {
    return { runId: id, lifecycleOperationId: null, program: 'reference-fixture', args: [], workspacePath: root,
      pid: 24680, state, cols: 80, rows: 24, latestOutputBytes: 12, firstAvailableByte: 0, acceptedInputBytes: 0 }
  }

  function without(id: string): AppConfig {
    const next = structuredClone(config)
    delete next.executors[id]
    return next
  }

  function control(): AgentSessionControl {
    return { kind: 'agent', hostId: 'local', agentSessionId: retained.agentSessionId, run: { ...retained.run } }
  }

  async function assertHealthyPaths() {
    const before = (await loadAgentSessions(store)).find(entry => entry.agentSessionId === retained.agentSessionId)
    expect(before).toEqual(retained)
    const processBefore = { ...runs.get(retained.run.runId)! }
    const data = '  explicit healthy input\n'
    await expect(runtime.write(control(), data, 'user')).resolves.toBeUndefined()
    expect(writes.at(-1)).toEqual({ runId: retained.run.runId, data })
    const page = await runtime.sessionHistoryPage(control(), { cursor: 'opaque', limit: 5 }, config)
    expect(page).toEqual({ agentSessionId: retained.agentSessionId,
      source: { providerId: retained.providerId, nativeSessionId: `native-${retained.agentSessionId}` },
      items: [{ id: 'native-item', kind: 'user-message', contentParts: [{ kind: 'text', text: '  exact history\n' }] }], nextCursor: null })
    expect(nativeHistory.mock.calls.at(-1)?.[0]).toMatchObject({ command: config.executors.kept!.command,
      args: config.executors.kept!.args, env: config.executors.kept!.env, cursor: 'opaque', limit: 5 })
    const processAfter = runs.get(retained.run.runId)!
    expect({ runId: processAfter.runId, pid: processAfter.pid, state: processAfter.state })
      .toEqual({ runId: processBefore.runId, pid: processBefore.pid, state: processBefore.state })
    expect((await loadAgentSessions(store)).find(entry => entry.agentSessionId === retained.agentSessionId)).toEqual(retained)
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'amux-executor-references-'))
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
    vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'runtime', 'state')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
    store = new AgentMuxMemoryAgentSessionStore()
    retained = record('retained')
    await store.compareAndSwap(null, retained)
    expect(await loadAgentSessions(store)).toEqual([retained])
    nativeHistory = vi.fn(async (context: AgentProviderSessionHistoryContext) => ({ source: context.source,
      items: [{ id: 'native-item', kind: 'user-message' as const,
        contentParts: [{ kind: 'text' as const, text: '  exact history\n' }] }], nextCursor: null }))
    const template = new AgentProviderRegistry().get('codex')
    const provider = (id: string) => defineAgentProvider({
      catalog: { ...template.catalog, id, label: id, executable: id, expectedProcess: id,
        hookStrategy: { kind: 'none' }, readySignal: { kind: 'foreground-process', expectedProcess: id } },
      hook: { rules: [], eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' } },
      buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])], readSessionHistoryPage: nativeHistory
    })
    const primary = provider('codex')
    core = new AgentMuxClient({ store, providers: [primary, provider('claude')] })
    const inner = core as unknown as CoreHarness
    inner.connected = true
    await inner.registry.load('local')
    kernel = inner.kernel
    runs = new Map([[retained.run.runId, run(retained.run.runId)]])
    writes = []
    connect = vi.spyOn(core, 'connect').mockResolvedValue(undefined)
    vi.spyOn(core, 'probeAgent').mockResolvedValue({ providerId: primary.id, installed: true,
      executable: primary.executable, capabilities: primary.catalog.capabilities })
    vi.spyOn(kernel, 'isConnected').mockReturnValue(true)
    vi.spyOn(kernel, 'identity').mockReturnValue({ daemonInstanceId: 'private-reference', buildIdentity: 'fixture', protocolVersion: 18 })
    vi.spyOn(kernel, 'list').mockImplementation(async () => [...runs.values()])
    vi.spyOn(kernel, 'status').mockImplementation(async id => {
      const value = runs.get(id)
      if (!value) throw new AgentMuxError('Private Run absent.', 'CTXMUX_run_not_found')
      return value
    })
    vi.spyOn(kernel, 'start').mockImplementation(async input => {
      const value = { ...run(`created-${runs.size}`), lifecycleOperationId: input.operationKey,
        program: input.program, args: input.args, workspacePath: input.cwd }
      runs.set(value.runId, value)
      return value
    })
    vi.spyOn(kernel, 'input').mockImplementation(async (id, input) => {
      const value = runs.get(id)!
      writes.push({ runId: id, data: input.data })
      value.acceptedInputBytes = input.expectedByte + Buffer.byteLength(input.data)
      return { run: value, appliedByteRange: { startByte: input.expectedByte, endByte: value.acceptedInputBytes } }
    })
    vi.spyOn(kernel, 'prepareStop').mockImplementation(async (runId, operationKey) => {
      if (!operationKey) throw new Error('The private Core stop must carry its lifecycle operation identity.')
      return { daemonInstance: 'private-reference', operationKey, runId }
    })
    vi.spyOn(kernel, 'stop').mockImplementation(async operation => { runs.delete(operation.runId) })
    runtime = new RuntimeController(store)
    runtime.commit({ hosts: [{ id: 'local', client: core,
      executionHost: new LocalExecutionHost({ runner: async () => { throw new Error('This proof must not execute native commands.') } }) }],
      removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
    const executor = { providerId: primary.id, label: 'Private', command: primary.executable,
      args: ['--private', 'literal value'], env: { PRIVATE: ' literal ' }, injectAgentMuxGuide: false }
    config = { version: CONFIG_VERSION, hosts: [{ id: 'local', kind: 'local', label: 'Private host' }],
      executors: { kept: structuredClone(executor), spare: { ...structuredClone(executor), label: 'Spare' } },
      workspaces: [{ id: 'private-workspace', hostId: 'local', name: 'Private', path: root, kind: 'folder' }],
      appearance: { terminalTheme: 'graphite' }, browser: { agentAutomation: false,
        toolbar: Object.fromEntries(BROWSER_TOOLBAR_ITEM_ORDER.map(item => [item, true])) as AppConfig['browser']['toolbar'] } }
    expect(Object.keys(config.executors)).toEqual(['kept', 'spare'])
  })

  afterEach(async () => {
    try { await runtime?.dispose() } finally {
      vi.restoreAllMocks(); vi.unstubAllEnvs()
      if (root) await rm(root, { recursive: true })
    }
  })

  it('retains a Session with an exited Run when rejecting template deletion, without any live/visible filter', async () => {
    runs.get(retained.run.runId)!.state = { type: 'exited', code: 0, signal: null }
    const subject = (await core.runtimeProjection()).subjects.find(value => value.kind === 'agent')
    expect(subject).toMatchObject({ kind: 'agent', agentSession: { agentSessionId: retained.agentSessionId }, run: { state: 'exited' } })
    expect(await loadAgentSessions(store)).toEqual([retained])
    const inventory = vi.spyOn(core, 'runtimeProjection')
    await expect(runtime.reserveExecutorConfigEdit(config, without('kept'))).rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
    expect(inventory).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(await loadAgentSessions(store)).toEqual([retained])
    expect(Object.keys(config.executors)).toEqual(['kept', 'spare'])
  })

  it('uses disconnected retained Sessions from the authoritative Store, then leaves healthy input and History working', async () => {
    const disconnected = record('disconnected', 'spare', 'reference-fixture', 'not-connected')
    await store.compareAndSwap(null, disconnected)
    expect(await loadAgentSessions(store)).toEqual([retained, disconnected])
    await expect(runtime.reserveExecutorConfigEdit(config, without('spare'))).rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
    expect(connect).not.toHaveBeenCalled()
    await assertHealthyPaths()
    expect(await loadAgentSessions(store)).toEqual([retained, disconnected])
  })

  it.each(['matching-first', 'conflicting-first'])('checks all same-ID Provider facts before restoring an orphan: %s', async order => {
    const matching = record('orphan-matching', 'orphan'), conflicting = record('orphan-conflicting', 'orphan', 'claude')
    for (const value of order === 'matching-first' ? [matching, conflicting] : [conflicting, matching]) {
      await store.compareAndSwap(null, value)
    }
    const before = await loadAgentSessions(store)
    expect(before).toHaveLength(3)
    const next = structuredClone(config)
    next.executors.orphan = structuredClone(config.executors.kept!)
    await expect(runtime.reserveExecutorConfigEdit(config, next)).rejects.toMatchObject({ code: 'SETTING_IDENTITY_IMMUTABLE' })
    expect(await loadAgentSessions(store)).toEqual(before)
    expect(connect).not.toHaveBeenCalled()
    await assertHealthyPaths()
  })

  it('permits explicit same-Provider orphan restoration and releases only that identity', async () => {
    const orphan = record('orphan', 'orphan')
    await store.compareAndSwap(null, orphan)
    const next = structuredClone(config)
    next.executors.orphan = structuredClone(config.executors.kept!)
    const release = await runtime.reserveExecutorConfigEdit(config, next)
    try {
      await expect(runtime.launchAgent({ executorId: 'orphan', hostId: 'local', workspacePath: root }, next))
        .rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
      await assertHealthyPaths()
    } finally { release() }
    await expect(runtime.launchAgent({ executorId: 'orphan', hostId: 'local', workspacePath: root,
      agentSessionId: 'explicit-restored-launch' }, next)).resolves.toMatchObject({ created: { executorId: 'orphan', providerId: orphan.providerId } })
    expect((await loadAgentSessions(store)).map(value => value.agentSessionId)).toEqual(['retained', 'orphan', 'explicit-restored-launch'])
  })

  it.each(['transport', 'malformed'])('rejects %s reference unknowns while ordinary fields bypass reference loading entirely', async failure => {
    const read = vi.spyOn(store, 'load')
    if (failure === 'transport') read.mockRejectedValueOnce(new Error('Private Store observation unavailable.'))
    else read.mockResolvedValueOnce([retained, { kind: 'invalid-reference-record' }])
    await expect(runtime.reserveExecutorConfigEdit(config, without('spare'))).rejects.toMatchObject({ code: 'SETTING_RESOURCE_REFERENCES_UNKNOWN' })
    expect(read).toHaveBeenCalledOnce()
    read.mockClear()
    const next = structuredClone(config)
    next.copyPathsAsAbsolute = true
    next.executors.kept!.command = 'edited-command'
    next.executors.kept!.args = []
    next.executors.kept!.env = {}
    const release = await runtime.reserveExecutorConfigEdit(config, next)
    release()
    expect(read).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    await assertHealthyPaths()
    expect(await loadAgentSessions(store)).toEqual([retained])
  })

  it('holds only new launches for a pending dangerous identity edit; same Executor input and History continue', async () => {
    const read = deferred<readonly unknown[]>()
    vi.spyOn(store, 'load').mockImplementationOnce(() => read.promise)
    const edit = runtime.reserveExecutorConfigEdit(config, without('kept'))
    const settled = edit.then(value => ({ value }), error => ({ error }))
    try {
      await expect(runtime.launchAgent({ executorId: 'kept', hostId: 'local', workspacePath: root }, config))
        .rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
      expect(connect).not.toHaveBeenCalled()
      await assertHealthyPaths()
    } finally { read.resolve([retained]); await settled }
    await expect(edit).rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
    await assertHealthyPaths()
    await expect(runtime.launchAgent({ executorId: 'kept', hostId: 'local', workspacePath: root,
      agentSessionId: 'after-reference-check' }, config)).resolves.toMatchObject({ created: { agentSessionId: 'after-reference-check' } })
  })

  it('admits before the first launch await, prevents deletion while held, and releases on failure', async () => {
    const firstAwait = deferred<void>()
    connect.mockImplementationOnce(() => firstAwait.promise)
    const launch = runtime.launchAgent({ executorId: 'spare', hostId: 'local', workspacePath: root }, config)
    const settled = launch.then(value => ({ value }), error => ({ error }))
    // No await separates public launch admission from this competing delete request.
    const deletion = runtime.reserveExecutorConfigEdit(config, without('spare'))
    const deletionSettled = deletion.then(release => ({ release }), error => ({ error }))
    try {
      expect(connect).toHaveBeenCalledOnce()
      expect(kernel.start).not.toHaveBeenCalled()
      expect(await loadAgentSessions(store)).toEqual([retained])
      await expect(deletion).rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
      await assertHealthyPaths()
    } finally {
      firstAwait.reject(new Error('Private launch transport failed.'))
      await settled
      const outcome = await deletionSettled
      if ('release' in outcome) outcome.release()
    }
    await expect(launch).rejects.toThrow('Private launch transport failed.')
    const release = await runtime.reserveExecutorConfigEdit(config, without('spare'))
    release()
    await assertHealthyPaths()
    expect(await loadAgentSessions(store)).toEqual([retained])
  })

  it('releases successful launch admission after Core persistence, retaining protection until explicit semantic retirement', async () => {
    const result = await runtime.launchAgent({ executorId: 'spare', hostId: 'local', workspacePath: root,
      agentSessionId: 'created-spare' }, config)
    expect(result.created).toMatchObject({ agentSessionId: 'created-spare', executorId: 'spare' })
    expect(await loadAgentSessions(store)).toHaveLength(2)
    await expect(runtime.reserveExecutorConfigEdit(config, without('spare'))).rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
    await assertHealthyPaths()
    // Public Runtime -> Core stop retires this private synthetic Session, not the healthy retained one.
    await runtime.stopSession({ kind: 'agent', hostId: 'local', agentSessionId: result.created.agentSessionId, run: result.created.run })
    expect(await loadAgentSessions(store)).toEqual([retained])
    const release = await runtime.reserveExecutorConfigEdit(config, without('spare'))
    release()
    await assertHealthyPaths()
    expect(runs.has(retained.run.runId)).toBe(true)
  })

  it('registered Main owner protects held launch and keeps its reservation until authoritative publication', async () => {
    const disk = new ConfigStore(join(root, 'config.json'))
    config.workspaces.push({ id: '__scratch__', hostId: 'local', name: 'Private Topics', path: join(root, 'topics'), kind: 'folder' })
    config = await disk.save(config)
    // The isolated durable file is already initialized; skip the unrelated default Topics bootstrap.
    vi.spyOn(disk, 'get').mockResolvedValue(config)
    const preparation = { hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map<string, string>() }
    vi.spyOn(runtime, 'prepare').mockResolvedValue(preparation)
    vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
    const sender = Object.assign(new EventEmitter(), { id: 779, isDestroyed: () => false, send: vi.fn(),
      mainFrame: { framesInSubtree: [] } })
    const progressLoops = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(root, 'loops.json')),
      async () => 'unknown', undefined, async () => { throw new Error('No automatic loop is admitted in the Executor reference fixture') })
    ipc.handlers.clear()
    const dispose = await registerIpc({ window: { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow,
      configStore: disk, runtime, progressLoops, scratchTopics: {} as ScratchTopics,
      workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
    const invoke = async (channel: string, ...values: unknown[]) => {
      const handler = ipc.handlers.get(channel)
      expect(handler).toBeTypeOf('function')
      return await handler!({ sender } as unknown as IpcMainInvokeEvent, ...values)
    }
    try {
      expect(ipc.handlers.has('sessions:launchAgent')).toBe(true)
      expect(ipc.handlers.has('config:get')).toBe(true)
      expect(ipc.execute).toBeTypeOf('function')
      const bytes = await readFile(disk.filePath, 'utf8')
      const firstAwait = deferred<void>()
      connect.mockImplementationOnce(() => firstAwait.promise)
      const launch = invoke('sessions:launchAgent', { executorId: 'spare', hostId: 'local', workspacePath: root })
      const settled = launch.then(value => ({ value }), error => ({ error }))
      try {
        // Registered launch admission precedes even the first Core connect await.
        expect(connect).toHaveBeenCalledOnce()
        await expect(ipc.execute!({ operation: 'settings.resource.remove', resource: 'executors', id: 'spare' }))
          .rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
        expect(await readFile(disk.filePath, 'utf8')).toBe(bytes)
        expect(sender.send).not.toHaveBeenCalled()
        await assertHealthyPaths()
      } finally { firstAwait.reject(new Error('Private held launch failed.')); await settled }
      await expect(launch).rejects.toThrow('Private held launch failed.')

      // Observe the actual release boundary without replacing the owner, Store or reservation.
      // A launch attempted in this callback must read the newly published Main config.
      const reserve = runtime.reserveExecutorConfigEdit.bind(runtime)
      const releasedWith: AppConfig[] = []
      const releaseLaunches: Promise<unknown>[] = []
      vi.spyOn(runtime, 'reserveExecutorConfigEdit').mockImplementation(async (...values) => {
        const release = await reserve(...values)
        return () => {
          release()
          const current = ipc.handlers.get('config:get')!({ sender } as unknown as IpcMainInvokeEvent) as AppConfig
          releasedWith.push(current)
          releaseLaunches.push(invoke('sessions:launchAgent', { executorId: 'spare', hostId: 'local', workspacePath: root })
            .then(value => ({ value }), error => ({ error })))
        }
      })
      await expect(ipc.execute!({ operation: 'settings.resource.remove', resource: 'executors', id: 'spare' }))
        .resolves.toEqual({ operation: 'settings.resource.remove', resource: 'executors', id: 'spare', removed: true })
      expect(releasedWith).toHaveLength(1)
      expect(Object.keys(releasedWith[0]!.executors)).toEqual(['kept'])
      expect(await releaseLaunches[0]).toMatchObject({ error: { message: 'Missing Agent Executor configuration: spare' } })
      expect(sender.send).toHaveBeenCalledExactlyOnceWith(CONFIG_CHANGED_CHANNEL, releasedWith[0])
      const saved = JSON.parse(await readFile(disk.filePath, 'utf8')) as AppConfig
      expect(saved.executors).toEqual(releasedWith[0]!.executors)
      expect(await loadAgentSessions(store)).toEqual([retained])
      expect(kernel.start).not.toHaveBeenCalled()
      await assertHealthyPaths()
    } finally { await dispose(); await progressLoops.stop() }
  })
})
