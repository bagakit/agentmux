const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../../scripts/lib/fixture-values.mjs"))
import { injectedContextCore } from './injected-context-core'
import { startDirectGoal, retryDirectGoal, directGoalRequest } from '../../src/renderer/src/lib/goals-direct-pmo'
import { useLauncherState } from '../../src/renderer/src/lib/launcher-state'
import { goalPmoOperation } from '../../src/shared/goal-pmo-origin'
// @vitest-environment happy-dom
import { localRuntimeConnector } from './local-runtime-connector.js'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, Profiler } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './client-ui-render'
import { afterEach, beforeEach, beforeAll, afterAll, expect, it, vi } from 'vitest'
import { AGENTMUX_AGENT_MESSAGING_GUIDANCE, AgentMuxClient, AgentMuxMemoryAgentSessionStore, normalizeAgentSession, type AgentMuxStoredAgentSession } from '@agentmux/core'
import { composeAgentPrompt } from '@agentmux/core/agent-outbound-message'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, SessionSnapshot } from '../../src/shared/contracts'
import { ConfigStore } from '../../src/main/config-store'
import type { WorkspaceFiles } from '../../src/main/workspace-files'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(),
  storagePath: '', listenerPackagePath: '', controlOptions: null as any,
  handlers: new Map<string, (...args: any[]) => any>(), renderer: new Map<string, Set<(...args: any[]) => any>>(),
  main: new Map<string, Set<(...args: any[]) => any>>(), sender: null as any,
  deliver: (channel: string, ...args: any[]) => {}, reply: (channel: string, ...args: any[]) => {} }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  contextBridge: { exposeInMainWorld: (name: string, api: AgentMuxPreloadApi) => { bridge.api = api; Object.assign(window, { [name]: api }) } },
  ipcRenderer: { invoke: bridge.invoke,
    on: (channel: string, fn: (...args: any[]) => any) => { const set = bridge.renderer.get(channel) ?? new Set(); set.add(fn); bridge.renderer.set(channel, set) },
    off: (channel: string, fn: (...args: any[]) => any) => bridge.renderer.get(channel)?.delete(fn),
    removeListener: (channel: string, fn: (...args: any[]) => any) => bridge.renderer.get(channel)?.delete(fn),
    send: (channel: string, ...args: any[]) => bridge.reply(channel, ...args) },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => bridge.handlers.set(channel, handler),
    removeHandler: (channel: string) => bridge.handlers.delete(channel),
    on: (channel: string, fn: (...args: any[]) => any) => { const set = bridge.main.get(channel) ?? new Set(); set.add(fn); bridge.main.set(channel, set) },
    removeListener: (channel: string, fn: (...args: any[]) => any) => bridge.main.get(channel)?.delete(fn) },
  webFrame: { getZoomFactor: () => 1 }, app: { getPath: () => bridge.storagePath, getAppPath: () => process.env.AGENTMUX_DAILY_GOAL_REPOSITORY + '/apps/desktop', isPackaged: false },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { constructor(options: any) { bridge.controlOptions = options } async start() {} async stop() {} }
}))
import { openDemandStore } from '@agentmux/demand'
import { AgentMuxRpcService } from '../../../../packages/core/src/public-rpc-service'
import { connectAgentMuxRpc } from '../../../../packages/core/src/public-rpc-client'
import { AgentMuxControlServer as PublicServer } from '../../../../packages/core/src/public-rpc-server'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite'))('esbuild')
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { parseAgentMuxCliInvocation } from '../../../../packages/core/src/agentmux-cli-commands'
import { issueAgentCapability, hashAgentCapability } from '../../../../packages/core/src/agent-capability'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { readFile } from 'node:fs/promises'
vi.mock('../../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
// Install the actual mocked Electron bridge before transitive renderer consumers load api.
await vi.hoisted(async () => { await import('../../src/preload/index') })
import '../../src/preload/index'
import { RuntimeController } from '../../src/main/runtime-controller'
import { ScratchTopics } from '../../src/main/scratch-topics'
import { registerIpc } from '../../src/main/ipc'
import { DEFAULT_CONFIG } from '../../src/main/config-store'
import { ContinuousProgressLoopManager } from '../../src/main/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '../../src/main/continuous-progress-loop-store'
import { deliverContinuousProgress } from '../../src/main/continuous-progress-delivery'
import { useAppStore } from '../../src/renderer/src/store'
import { api } from '../../src/renderer/src/lib/api'
import { GoalContinuationControl } from '../../src/renderer/src/components/GoalContinuationControl'
import { GlobalBoardSurface } from '../../src/renderer/src/components/GlobalBoardSurface'
import { MobileGoalActions } from '../../../mobile/src/goals/MobileGoalActions'
import { runDemandCli } from '../../../../packages/demand/src/cli'
import { admittedDemandParticipation, admittedDemandCreateMatches, admittedDemandUpdateMatches } from '../../src/main/demand-participation'
import { GoalDetail } from '../../src/renderer/src/components/GoalDetail'
import { EMPTY_GOAL_ACKNOWLEDGEMENT } from '../../src/renderer/src/components/GoalAlignment'
import { AgentSessionComposer } from '../../src/renderer/src/components/AgentSessionComposer'
import { privateTracker } from './continuous-progress-tracker'
import { CONTINUOUS_PROGRESS_CHANGED } from '../../src/shared/contracts'
import { CONTROL_REQUEST_CHANNEL, SESSION_EVENT_CHANNEL } from '../../src/shared/contracts'

// Target product owners run: Composer → leaf → preload → registered IPC → Main loop → public
// Core ingress; Store initialize installs its actual request handler. Electron transport, startup
// Browser services and Native I/O/screen wait are isolated. No PTY, private renderer or user Run.
let cliRoot: string, sourceCli: string
beforeAll(async () => {
  cliRoot = await mkdtemp(join(tmpdir(), 'ag-goal-cli-')); sourceCli = join(cliRoot, 'agentmux.mjs')
  const repository = process.env.AGENTMUX_DAILY_GOAL_REPOSITORY!, proof = process.env.AGENTMUX_DAILY_GOAL_PROOF ?? process.env.AGENTMUX_GOAL_CONTENT_PROOF
  expect(repository).toBeTruthy()
  const listenerPackage = join(cliRoot, 'source-core'), worker = resolve(repository, 'packages/core/src/control-endpoint-listener-worker.ts')
  await mkdir(join(listenerPackage, 'dist'), { recursive: true }); bridge.listenerPackagePath = join(listenerPackage, 'package.json')
  await writeFile(bridge.listenerPackagePath, JSON.stringify({ name: '@agentmux/core', type: 'module' }))
  process.env.AGENTMUX_PRIVATE_LISTENER_ASSET = join(listenerPackage, 'dist/control-endpoint-listener-worker.js')
  await build({ entryPoints: [worker], outfile: join(listenerPackage, 'dist/control-endpoint-listener-worker.js'), bundle: true, platform: 'node', format: 'esm', logLevel: 'error' })
  if (proof) appendFileSync(proof, JSON.stringify({ file: relative(repository, worker), sha256: createHash('sha256').update(readFileSync(worker)).digest('hex'), consumer: 'actual-source-listener-worker' }) + '\n')
  await build({ entryPoints: [resolve(repository, 'packages/core/src/agentmux.ts')], outfile: sourceCli, alias: { '@agentmux/demand/goals': resolve(repository, 'packages/demand/src/goals.ts'), '@agentmux/demand': resolve(repository, 'packages/demand/src/index.ts'), '@scure/base': resolve(repository, 'node_modules/.pnpm/@scure+base@2.2.0/node_modules/@scure/base/index.js') }, bundle: true, platform: 'node', format: 'esm', logLevel: 'error', banner: { js: "import { createRequire as bundleRequire } from 'node:module'; const require=bundleRequire(import.meta.url);" },
    plugins: [{ name: 'actual-daily-goal-cli-imports', setup(builder: { onLoad(filter: { filter: RegExp }, handler: (args: { path: string }) => { contents: string; loader: 'ts' } | null): void }) { builder.onLoad({ filter: /\.(ts|json)$/ }, args => {
      if (proof && (args.path.startsWith(resolve(repository, 'packages/core/src') + '/') || args.path.startsWith(resolve(repository, 'packages/demand/src') + '/'))) appendFileSync(proof, JSON.stringify({ file: relative(repository, args.path), sha256: createHash('sha256').update(readFileSync(args.path)).digest('hex'), consumer: 'actual-source-cli' }) + '\n')
      const mutant = process.env.AGENTMUX_DAILY_GOAL_MUTANT ? JSON.parse(process.env.AGENTMUX_DAILY_GOAL_MUTANT) : null
      if (mutant && relative(repository, args.path) === mutant.file) {
        const code = readFileSync(args.path, 'utf8')
        if (code.split(mutant.before).length !== 2) throw new Error('One exact Source CLI mutant anchor is required')
        const changed = code.replace(mutant.before, mutant.after)
        if (proof) appendFileSync(proof, JSON.stringify({ file: mutant.file, beforeSha256: createHash('sha256').update(code).digest('hex'), afterSha256: createHash('sha256').update(changed).digest('hex'), consumer: 'actual-source-cli-mutant' }) + '\n')
        return { contents: changed, loader: 'ts' }
      }
      return null
    }) } }] })
})
afterAll(async () => { delete process.env.AGENTMUX_PRIVATE_LISTENER_ASSET; await rm(cliRoot, { recursive: true, force: true }) })
const initial = useAppStore.getState()
let demands: ReturnType<typeof openDemandStore>
let directory: string, client: AgentMuxClient, runtime: RuntimeController, manager: ContinuousProgressLoopManager
let disposeIpc: (() => Promise<void>) | undefined, disposeStore: (() => void) | undefined
let root: Root, container: HTMLDivElement, config: AppConfig, session: AgentMuxStoredAgentSession
let activityCapability: string
let writes: string[], cursor: number | null, requests: any[], observations: string[], now: number
let afterInputObservation: (() => Promise<void>) | undefined, corruptReply: boolean, dropReply: boolean
let snapshot: Extract<SessionSnapshot, { kind: 'agent' }>, ended: boolean
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  directory = await mkdtemp(join(tmpdir(), 'amx-progress-product-'))
  const scratchRoot = join(directory, '.agentmux', 'topics')
  await mkdir(scratchRoot, { recursive: true })
  bridge.storagePath = join(directory, 'chromium')
  await mkdir(join(bridge.storagePath, 'Local Storage', 'leveldb'), { recursive: true })
  await mkdir(join(directory, 'home'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(directory, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'runtime', 'state')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(directory, 'messages.ndjson'))
  writes = []; requests = []; observations = []; cursor = 0; now = _reshape_fixtureEpoch(0, 0, 0); ended = false
  corruptReply = false; dropReply = false; afterInputObservation = undefined
  const store = new AgentMuxMemoryAgentSessionStore(), timestamp = Date.now()
  activityCapability = issueAgentCapability()
  session = { kind: 'agent', agentSessionId: 'progress-agent', hostId: 'local', providerId: 'codex', executorId: 'codex',
    workspacePath: scratchRoot, run: { runId: 'progress-run' }, retiredRuns: [], createdAt: timestamp, updatedAt: timestamp,
    hookBindingId: 'owned-binding', hookToken: 'owned-token', capabilityHash: hashAgentCapability(activityCapability), semanticStatus: { state: 'done', source: 'native-hook',
      observedAt: timestamp, stateEnteredAt: timestamp } }
  await store.compareAndSwap(null, session)
  client = new AgentMuxClient({ store }); const inner = client as any
  inner.connected = true; await inner.registry.load('local')
  const projection = () => ({ runId: session.run.runId, lifecycleOperationId: null, program: _hygiene_fixturePath("private/generic-input"), args: [],
    workspacePath: scratchRoot, pid: 2345, state: ended ? { type: 'exited', code: 0, signal: null } : { type: 'running' },
    cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursor })
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'progress-native-seam', protocolVersion: 18, buildIdentity: 'controlled-I/O' })
  inner.kernel.list = async () => [projection()]
  inner.kernel.status = async () => projection()
  inner.kernel.input = async (_run: string, input: any) => {
    expect(input.expectedByte).toBe(cursor); requests.push(structuredClone(input)); writes.push(input.data)
    cursor! += Buffer.byteLength(input.data)
    return { run: projection(), appliedByteRange: { startByte: input.expectedByte, endByte: cursor } }
  }
  vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(0)
  runtime = new RuntimeController(store, localRuntimeConnector)
  runtime.commit({ hosts: [{ id: 'local', config: { id: 'local', label: 'Private local', kind: 'local' }, client, executionHost: { kind: 'local', dispose: vi.fn() } as never }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: '__scratch__', name: 'Owned topics', hostId: 'local', path: scratchRoot, kind: 'folder' }] }
  demands = openDemandStore({ root: join(directory, 'goals') })
  await demands.create({ id: 'goal', title: 'Original useful work', description: 'Complete the original useful result.', sessionIds: [session.agentSessionId], assigneeSessionIds: [session.agentSessionId], supervisorSessionId: session.agentSessionId, status: 'todo' })
  await demands.update('goal', { alignment: { summary: 'Useful result', criteria: [{ id: 'real', text: 'Original output exists' }], openQuestions: [] } })
  await demands.confirmAlignment('goal', 1)
  manager = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(directory, 'loops.json')),
    (loop, operationId, isCurrent, signal) => deliverContinuousProgress(runtime, loop, operationId, isCurrent, signal),
    () => now, (loop, tickId, time, signal) => runtime.observeContinuousProgress(loop, tickId, time, signal), undefined, { read: id => demands.get(id), subscribe: listener => demands.subscribe(snapshot => listener(snapshot.demands)), inspectInitial: loop => runtime.inspectContinuousProgressInitial(loop) })
  bridge.sender = Object.assign(new EventEmitter(), { id: 7891, isDestroyed: () => false,
    send: (channel: string, ...args: any[]) => bridge.deliver(channel, ...args), session: { flushStorageData: vi.fn(), getStoragePath: () => bridge.storagePath } })
  bridge.deliver = (channel, ...args) => {
    if (channel === CONTROL_REQUEST_CHANNEL && args[0].control) {
      observations.push(args[0].control.agentSessionId)
      if (dropReply) return
    }
    for (const fn of bridge.renderer.get(channel) ?? []) fn({}, ...args)
  }
  bridge.reply = (channel, ...args) => {
    args = structuredClone(args)
    const response = args[0]
    if (corruptReply && response?.ok && response.result?.operation === 'continuous-progress.observeInput') response.result.control.run.runId = 'wrong-run'
    const send = () => { for (const fn of bridge.main.get(channel) ?? []) fn({ sender: bridge.sender }, ...args) }
    if (response?.ok && response.result?.operation === 'continuous-progress.observeInput' && afterInputObservation) {
      const once = afterInputObservation; afterInputObservation = undefined; void once().then(send)
    } else send()
  }
  const fixtureConfigStore = new ConfigStore(join(directory, 'original-config.json'))
  disposeIpc = await registerIpc({ initialConfig: config, window: { setBackgroundColor: vi.fn(), webContents: bridge.sender, isDestroyed: () => false } as unknown as BrowserWindow,
    runtime, progressLoops: manager, demands, configStore: { get: async () => config, validate: (next: AppConfig) => fixtureConfigStore.validate(next), save: async (next: AppConfig) => { config = await fixtureConfigStore.save(next); return config } } as unknown as ConfigStore,
    scratchTopics: new ScratchTopics(), workspaceFiles: { read: vi.fn(), listFiles: vi.fn(), dispose: async () => {} } as unknown as WorkspaceFiles })
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function')
    return handler!({ sender: bridge.sender } as IpcMainInvokeEvent, ...values)
  })
  window.localStorage.clear()
  useAppStore.setState({ ...initial, loading: true, restoredWorkbench: null, tabs: {}, layouts: {}, sessions: [],
    config: null, agentComposerDrafts: {}, agentSteerQueues: {}, agentSteerInFlight: {} }, true)
  const before = await runtime.snapshot(config); expect(before.sessions, JSON.stringify(before.runtimeEndpointWarnings)).toHaveLength(1)
  disposeStore = await useAppStore.getState().initialize()
  snapshot = useAppStore.getState().sessions.find(s => s.id === session.agentSessionId) as typeof snapshot
  expect(snapshot).toMatchObject({ kind: 'agent', processState: 'running', control: { run: session.run } })
  expect(useAppStore.getState().loading).toBe(false)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<AgentSessionComposer sessionId={session.agentSessionId} />))
})
afterEach(async () => {
  await act(async () => root?.unmount()); container?.remove(); disposeStore?.(); disposeStore = undefined
  useAppStore.setState(initial, true)
  window.dispatchEvent(new Event('pagehide'))
  await api.ui.requestStorageFlush()
  const cleanup = await Promise.allSettled([manager?.stop(), disposeIpc?.(), runtime?.dispose()])
  disposeIpc = undefined
  bridge.main.clear(); bridge.renderer.clear(); bridge.handlers.clear(); bridge.invoke.mockReset()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
  expect(cleanup.filter(r => r.status === 'rejected')).toEqual([])
})

const request = (operationId = 'original-start') => ({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: operationId, operation: 'demand.start' as const, demandId: 'goal', sessionId: session.agentSessionId, continuation: { intervalMs: 60_000, alignmentRevision: 1 } })

export { bridge, demands, directory, client, runtime, manager, root, container, config, session, writes, requests, snapshot, sourceCli, request }
