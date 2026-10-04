const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { AgentMuxClient, AgentMuxError, AgentMuxFileAgentSessionStore, AgentMuxHostExecutorOwner,
  type AgentMuxAgentSession } from '@agentmux/core'
import { AgentMuxCreationAuthority } from '../../../packages/core/src/agent-creation-authority.js'
import type { CtxmuxAdapterRun } from '../../../packages/core/src/ctxmux-run-adapter.js'
import type { AgentMuxAgentSessionRegistry } from '../../../packages/core/src/agent-session-registry.js'
import type { AgentLaunchInput, AgentMuxPreloadApi, AppConfig } from '../src/shared/contracts.js'
import type { ConfigStore } from '../src/main/config-store.js'
import type { ScratchTopics } from '../src/main/scratch-topics.js'
import type { WorkspaceFiles } from '../src/main/workspace-files.js'

const ipc = vi.hoisted(() => ({ root: '', handlers: new Map<string, Function>(), invoke: vi.fn(), api: null as AgentMuxPreloadApi | null }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { ipc.api = api } },
  ipcRenderer: { invoke: ipc.invoke, on: vi.fn(), removeListener: vi.fn(), off: vi.fn(), send: vi.fn() },
  webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => ipc.root, getAppPath: () => resolve('apps/desktop'), isPackaged: false },
  ipcMain: { handle: (channel: string, handler: Function) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} }
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager.js', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal.js', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-journal.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store.js', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager.js', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import { RuntimeController } from '../src/main/runtime-controller.js'
import { registerIpc } from '../src/main/ipc.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import '../src/preload/index.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); ipc.handlers.clear(); ipc.invoke.mockReset()
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function owner() {
  const root = await mkdtemp(join(tmpdir(), 'amux-remote-observer-')); ipc.root = root
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  for (const name of Object.keys(process.env).filter(name => name.startsWith('AGENTMUX_'))) vi.stubEnv(name, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'target', 'sessions.json'))
  let core!: AgentMuxClient
  const executors = new AgentMuxHostExecutorOwner({ path: join(root, 'target', 'executors.json'), runtimeId: 'target-runtime', catalog: () => core.catalog() })
  core = new AgentMuxClient({ store, hostExecutorOwner: executors,
    creationAuthority: new AgentMuxCreationAuthority({ stateDirectory: join(root, 'target'), runtimeId: 'target-runtime' }) })
  const registration = await executors.configure({ executorId: 'target-wrapper', config: {
    label: 'Target wrapper', providerId: 'claude', command: '/bin/sh', args: [], env: { TARGET_POSTURE: 'configured' }, injectAgentMuxGuide: false } })
  const inner = core as unknown as { connected: boolean; registry: AgentMuxAgentSessionRegistry; kernel: Record<string, unknown>;
    hookServer: Record<string, unknown>; ensureManagedHooks: unknown; ensureTerminalHandshakeOrDegrade: unknown }
  inner.connected = true; await inner.registry.load('local')
  vi.spyOn(core, 'connect').mockResolvedValue(undefined)
  vi.spyOn(core, 'probeAgent').mockResolvedValue({ providerId: 'claude', executable: '/bin/sh', installed: true,
    capabilities: core.providers.get('claude').catalog.capabilities })
  const entered = deferred(), release = deferred(), runs: CtxmuxAdapterRun[] = []
  // Only native process/Hook I/O is synthetic. The actual preload, registered IPC handler,
  // RuntimeController, target Executor resolution, Core creation and FileStore execute.
  const start = vi.fn(async (input: { operationKey: string; cwd: string; program: string; args: string[] }) => {
    entered.resolve(); await release.promise
    const run: CtxmuxAdapterRun = { nativeService: null, runId: 'target-run', lifecycleOperationId: input.operationKey,
      program: input.program, args: input.args, workspacePath: input.cwd, pid: 1234, state: { type: 'running' },
      cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 }
    runs.push(run); return run
  })
  const stop = vi.fn(), input = vi.fn()
  Object.assign(inner.kernel, { isConnected: () => true, identity: () => ({ daemonInstanceId: 'fixture', protocolVersion: 21, buildIdentity: 'fixture' }),
    start, stop, input, list: async () => runs, status: async () => runs[0] })
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) },
    bindRun: async () => {}, close: async () => {} })
  inner.ensureManagedHooks = async () => {}
  inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'target-host', kind: 'ssh', label: 'Target', hostname: 'private.invalid' }],
    executors: { 'target-wrapper': { label: 'Local unrelated', providerId: 'claude', command: _hygiene_fixturePath("local/should-not-run"),
      args: ['local-only'], env: { LOCAL_SECRET: 'must-not-cross-hosts' }, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'target-workspace', hostId: 'target-host', kind: 'folder', name: 'Target', path: root }] }
  const runtime = new RuntimeController(store, async () => { throw new Error('The fixture explicitly supplies its target Core.') })
  runtime.commit({ hosts: [{ id: 'target-host', config: config.hosts[0]!, client: core,
    executionHost: { kind: 'ssh', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  cleanups.push(async () => await runtime.dispose())
  const stopSession = vi.spyOn(runtime, 'stopSession')
  let destroyed = false
  const sender = Object.assign(new EventEmitter(), { id: 77, isDestroyed: () => destroyed, send: vi.fn() })
  let wireSender = sender
  const dispose = await registerIpc({ window: { id: 88, isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow, runtime,
    progressLoops: { subscribe: () => () => {} } as never, configStore: { get: async () => config } as unknown as ConfigStore,
    scratchTopics: { setNameAudit: () => {} } as unknown as ScratchTopics, workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  cleanups.push(dispose)
  ipc.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const handler = ipc.handlers.get(channel); expect(handler).toBeTypeOf('function')
    try { return structuredClone(await handler!({ sender: wireSender } as unknown as IpcMainInvokeEvent, ...structuredClone(args))) }
    catch (error) {
      // Electron transports a rejected Error message, stripping its custom code/outcome/identity.
      // A fulfilled plain carrier must preserve those fields before preload reconstructs the Error.
      throw new Error(error instanceof Error ? error.message : String(error))
    }
  })
  const request: AgentLaunchInput = { executorId: 'target-wrapper', executorRevision: registration.executor.configRevision,
    hostId: 'target-host', workspacePath: root, agentSessionId: 'target-session', createOperationId: 'observer-launch-original', prompt: 'exact first task' }
  return { core, store, runs, start, stop, input, stopSession, entered, release, request, destroy: () => { destroyed = true },
    untrustedSender: () => { wireSender = Object.assign(new EventEmitter(), { id: 99, isDestroyed: () => false, send: vi.fn() }) } }
}

it.each([false, true])('retains the original remote creation when the launching observer disappears=%s', async disappears => {
  const f = await owner(), launch = ipc.api!.sessions.launchAgent(f.request)
  await f.entered.promise
  if (disappears) f.destroy()
  f.release.resolve()
  if (disappears) await expect(launch).rejects.toMatchObject({ code: 'CONTROL_OWNER_LOST', agentSessionId: f.request.agentSessionId,
    createOperationId: f.request.createOperationId, controlFailure: { disposition: 'unknown', confirmedInputBytes: null } })
  else expect(await launch).toMatchObject({ created: { agentSessionId: 'target-session', hostId: 'target-host', run: { runId: 'target-run' } },
    session: { hostId: 'target-host', control: { hostId: 'target-host', run: { runId: 'target-run' } } } })
  expect(f.stopSession).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled()
  expect(f.runs).toMatchObject([{ runId: 'target-run', state: { type: 'running' }, workspacePath: f.request.workspacePath }])
  expect(JSON.stringify(f.start.mock.calls)).not.toMatch(/should-not-run|local-only|must-not-cross-hosts/)
  expect(await f.store.load()).toMatchObject([{ agentSessionId: 'target-session', hostId: 'local', creation: { createOperationId: f.request.createOperationId }, run: { runId: 'target-run' } }])
  const inspected = await ipc.api!.sessions.creation('target-host', 'target-session')
  expect(inspected).toMatchObject({ agentSessionId: 'target-session', hostId: 'target-host', run: { runId: 'target-run' }, creation: { createOperationId: f.request.createOperationId } })
  expect(f.start).toHaveBeenCalledTimes(1)
})

it('keeps an unknown Core start receipt and its original identity through preload after Electron strips thrown Error fields', async () => {
  const f = await owner(), actualStart = f.start.getMockImplementation()!
  f.start.mockImplementationOnce(async input => { await actualStart(input); throw new Error('native start response was lost after apply') })
  const launch = ipc.api!.sessions.launchAgent(f.request)
  await f.entered.promise; f.release.resolve()
  await expect(launch).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED', agentSessionId: f.request.agentSessionId,
    createOperationId: f.request.createOperationId, controlFailure: { disposition: 'unknown', confirmedInputBytes: null } })
  expect(await f.store.load()).toEqual([])
  const recovered = await ipc.api!.sessions.creation('target-host', 'target-session')
  expect(recovered).toMatchObject({ hostId: 'target-host', run: { runId: 'target-run' },
    creation: { createOperationId: f.request.createOperationId, initialPrompt: 'unknown' } })
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stopSession).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect(f.input).not.toHaveBeenCalled()
})

it('preserves an authoritative not_applied outcome through the actual Main carrier and preload', async () => {
  const f = await owner()
  f.start.mockImplementationOnce(async () => {
    f.entered.resolve(); await f.release.promise
    throw new AgentMuxError('Native start was refused before apply.', 'FIXTURE_START_REJECTED', undefined,
      { disposition: 'not_applied', confirmedInputBytes: null })
  })
  const launch = ipc.api!.sessions.launchAgent(f.request)
  await f.entered.promise; f.release.resolve()
  await expect(launch).rejects.toMatchObject({ code: 'FIXTURE_START_REJECTED', agentSessionId: f.request.agentSessionId,
    createOperationId: f.request.createOperationId, controlFailure: { disposition: 'not_applied', confirmedInputBytes: null } })
  expect(f.runs).toEqual([]); expect(await f.store.load()).toEqual([])
  expect(await f.store.loadCreationCorrelation('target-session')).toBeNull()
  expect(f.stopSession).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})

it.each([false, true])('retains the input identity as unknown on Electron rejection even with misleading custom outcome=%s', async misleadingOutcome => {
  const f = await owner()
  const error = new Error('Electron invocation reply was lost.')
  if (misleadingOutcome) Object.assign(error, { code: 'DO_NOT_TRUST_THIS_TRANSPORT_CODE', agentSessionId: 'other-session',
    createOperationId: 'other-operation', controlFailure: { disposition: 'not_applied', confirmedInputBytes: null } })
  ipc.invoke.mockRejectedValueOnce(error)
  await expect(ipc.api!.sessions.launchAgent(f.request)).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED', agentSessionId: f.request.agentSessionId,
    createOperationId: f.request.createOperationId, controlFailure: { disposition: 'unknown', confirmedInputBytes: null } })
  expect(f.start).not.toHaveBeenCalled(); expect(f.stopSession).not.toHaveBeenCalled()
  expect(f.input).not.toHaveBeenCalled(); expect(await f.store.load()).toEqual([])
})

it('reports an untrusted manual note as not_applied before entering Runtime or creating a Run', async () => {
  const f = await owner(); f.untrustedSender()
  await expect(ipc.api!.sessions.launchAgent({ ...f.request, agentMuxNote: 'trusted Main context only' })).rejects.toMatchObject({
    agentSessionId: f.request.agentSessionId, createOperationId: f.request.createOperationId,
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: null }
  })
  expect(f.start).not.toHaveBeenCalled(); expect(await f.store.load()).toEqual([])
  expect(await f.store.loadCreationCorrelation('target-session')).toBeNull()
  expect(f.stopSession).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})

it('does not call an original operation not_applied when its Executor registry disappears after a lost receipt', async () => {
  const f = await owner(), first = ipc.api!.sessions.launchAgent(f.request)
  await f.entered.promise; f.destroy(); f.release.resolve()
  await expect(first).rejects.toMatchObject({ code: 'CONTROL_OWNER_LOST',
    controlFailure: { disposition: 'unknown', confirmedInputBytes: null } })
  // Removing only this fixture's registration does not undo its retained Core Session or Run.
  await rm(join(f.request.workspacePath, 'target', 'executors.json'))
  expect((await f.core.listHostExecutors()).executors.some(executor => executor.executorId === f.request.executorId)).toBe(false)
  await expect(ipc.api!.sessions.launchAgent(f.request)).rejects.toMatchObject({ code: 'EXECUTOR_UNKNOWN',
    agentSessionId: f.request.agentSessionId, createOperationId: f.request.createOperationId,
    controlFailure: { disposition: 'unknown', confirmedInputBytes: null } })
  expect(await ipc.api!.sessions.creation('target-host', 'target-session')).toMatchObject({
    hostId: 'target-host', run: { runId: 'target-run' }, creation: { createOperationId: f.request.createOperationId }
  })
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stopSession).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect(f.input).not.toHaveBeenCalled()
})
