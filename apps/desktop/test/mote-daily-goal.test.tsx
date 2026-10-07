const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { injectedContextCore } from './helpers/injected-context-core'
import { startDirectGoal, retryDirectGoal, directGoalRequest } from '../src/renderer/src/lib/goals-direct-pmo'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { goalPmoOperation } from '../src/shared/goal-pmo-origin'
// @vitest-environment happy-dom
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, Profiler } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, beforeAll, afterAll, expect, it, vi } from 'vitest'
import { AGENTMUX_AGENT_MESSAGING_GUIDANCE, AgentMuxClient, AgentMuxMemoryAgentSessionStore, normalizeAgentSession, type AgentMuxStoredAgentSession } from '@agentmux/core'
import { composeAgentPrompt } from '@agentmux/core/agent-outbound-message'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { ConfigStore } from '../src/main/config-store'
import type { WorkspaceFiles } from '../src/main/workspace-files'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(),
  storagePath: '', controlOptions: null as any,
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
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { AgentMuxControlServer as PublicServer } from '../../../packages/core/src/public-rpc-server'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite'))('esbuild')
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands'
import { issueAgentCapability, hashAgentCapability } from '../../../packages/core/src/agent-capability'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { readFile } from 'node:fs/promises'
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
// Install the actual mocked Electron bridge before transitive renderer consumers load api.
await vi.hoisted(async () => { await import('../src/preload/index') })
import '../src/preload/index'
import { RuntimeController } from '../src/main/runtime-controller'
import { ScratchTopics } from '../src/main/scratch-topics'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store'
import { deliverContinuousProgress } from '../src/main/continuous-progress-delivery'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { GoalContinuationControl } from '../src/renderer/src/components/GoalContinuationControl'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { MobileGoalActions } from '../../mobile/src/goals/MobileGoalActions'
import { runDemandCli } from '../../../packages/demand/src/cli'
import { admittedDemandParticipation, admittedDemandCreateMatches, admittedDemandUpdateMatches } from '../src/main/demand-participation'
import { GoalDetail } from '../src/renderer/src/components/GoalDetail'
import { EMPTY_GOAL_ACKNOWLEDGEMENT } from '../src/renderer/src/components/GoalAlignment'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { privateTracker } from './helpers/continuous-progress-tracker'
import { CONTINUOUS_PROGRESS_CHANGED } from '../src/shared/contracts'
import { CONTROL_REQUEST_CHANNEL, SESSION_EVENT_CHANNEL } from '../src/shared/contracts'

// Target product owners run: Composer → leaf → preload → registered IPC → Main loop → public
// Core ingress; Store initialize installs its actual request handler. Electron transport, startup
// Browser services and Native I/O/screen wait are isolated. No PTY, private renderer or user Run.
let cliRoot: string, sourceCli: string
beforeAll(async () => {
  cliRoot = await mkdtemp(join(tmpdir(), 'ag-goal-cli-')); sourceCli = join(cliRoot, 'agentmux.mjs')
  const repository = process.env.AGENTMUX_DAILY_GOAL_REPOSITORY!, proof = process.env.AGENTMUX_DAILY_GOAL_PROOF ?? process.env.AGENTMUX_GOAL_CONTENT_PROOF
  expect(repository).toBeTruthy()
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
afterAll(async () => { await rm(cliRoot, { recursive: true, force: true }) })
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
    scratchTopics: new ScratchTopics(), workspaceFiles: expect.getState().currentTestName?.startsWith('Mote new-chat origin:')
      ? new MoteOriginWorkspaceFiles(() => ({ kind: 'local' }) as never)
      : { read: vi.fn(), listFiles: vi.fn(), dispose: async () => {} } as unknown as WorkspaceFiles })
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
it('original activity public Source CLI authenticates the author and reaches Main owner and the same GoalDetail with recoverable operations', async () => {
  await demands.addActivity('goal', { kind: 'note', message: 'Retained prior evidence', actorId: null, id: 'old-activity', createdAt: _reshape_fixtureEpoch(0, 0, 1) })
  const server = new PublicServer({ socketPath: join(directory, 'activity.sock'), coreClients: () => [{ hostId: 'local', client }], execute: (...args) => bridge.controlOptions.execute(...args) })
  await server.start()
  const typed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: { agentSessionId: session.agentSessionId, capability: activityCapability } })
  const human = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const execute = promisify(execFile), environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
    AGENTMUX_AGENT_SESSION_ID: session.agentSessionId, AGENTMUX_AGENT_CAPABILITY: activityCapability }
  const run = async (args: string[]) => {
    let response: any
    await act(async () => {
      try { response = JSON.parse((await execute(process.execPath, [sourceCli, '--endpoint', 'unix:' + server.path, ...args], { env: environment, timeout: 15000 })).stdout) }
      catch (error) { const output = (error as { stdout?: string; stderr?: string }).stdout || (error as { stderr?: string }).stderr; if (!output) throw error; response = JSON.parse(output) }
    })
    return response
  }
  const body = { goalId: 'goal', kind: 'review', message: 'The original public activity reaches the same Goal.', operationId: 'activity-original' }
  function Consumer() {
    const demand = useAppStore(state => state.demands.goal)!
    return <GoalDetail demand={{ ...demand, sessions: [], workspacePath: null }} onClose={() => {}} onOpenMote={() => {}} onGrill={() => {}} onGrounding={() => {}}
      acknowledgementFeedback={EMPTY_GOAL_ACKNOWLEDGEMENT} onAcknowledgementFeedbackChange={() => {}} moteError={null} onRetryMote={() => {}} />
  }
  try {
    const help = (await execute(process.execPath, [sourceCli, 'goal', 'activity', 'append', '--help'], { env: environment })).stdout
    expect(help).toContain('--operation-id'); expect(help).toContain('--message')
    expect((await execute(process.execPath, [sourceCli, 'goal', '--skill'], { env: environment })).stdout).toContain('goal activity inspect')
    await act(async () => {
      await useAppStore.getState().refreshDemand('goal')
      root.render(<Consumer />)
    })
    let appended: any
    await act(async () => { appended = await run(['goal', 'activity', 'append', '--goal', body.goalId, '--kind', body.kind, '--message', body.message, '--operation-id', body.operationId]) })
    expect(appended.ok).toBe(true)
    expect(appended.result.receipt).toMatchObject({ goalId: body.goalId, operationId: body.operationId, diskDurability: 'confirmed', replayed: false })
    const activity = appended.result.activity
    expect(activity).toMatchObject({ actorId: session.agentSessionId, operationId: body.operationId, kind: body.kind, message: body.message })
    expect(activity.id).toBeTruthy(); expect(activity.createdAt).toBeGreaterThan(1)
    expect(container.querySelector('.goals-activity')?.textContent).toContain(body.message)
    expect(container.querySelector('.goals-activity')?.textContent).toContain('Retained prior evidence')
    const revision = (await demands.snapshot()).revision
    let replayed: any
    await act(async () => { replayed = await typed.call('goal.activity.append', body) })
    expect(replayed.activity).toEqual(activity); expect(replayed.receipt.replayed).toBe(true)
    expect((await demands.snapshot()).revision).toBe(revision)
    const inspected = await run(['goal', 'activity', 'inspect', '--goal', 'goal', '--operation-id', body.operationId])
    expect(inspected.result).toEqual({ goalId: 'goal', operationId: body.operationId, activity, diskDurability: 'confirmed' })
    const read = await run(['goal', 'activity', '--goal', 'goal'])
    expect(read.result.diskDurability).toBe('confirmed')
    expect(read.result.activity).toContainEqual({ goalId: 'goal', ...activity })
    expect(read.result.activity).toContainEqual({ goalId: 'goal', id: 'old-activity', kind: 'note', message: 'Retained prior evidence', actorId: null, createdAt: _reshape_fixtureEpoch(0, 0, 1) })
    expect((await run(['goal', 'activity', '--goal', 'goal', '--since', String(activity.createdAt)])).result.activity).not.toContainEqual(expect.objectContaining({ id: 'old-activity' }))
    expect((await typed.call('goal.inspect', { goalId: 'goal' })).goal?.activities).toContainEqual(activity)
    await expect(typed.call('goal.activity.append', { ...body, message: 'Different payload' })).rejects.toThrow('different Goal, payload or authenticated author')
    await expect(human.call('goal.activity.append', body)).rejects.toThrow('different Goal, payload or authenticated author')
    await expect(typed.call('goal.activity.append', { ...body, actorId: 'another-agent' } as any)).rejects.toThrow('unsupported business field')
    await expect(typed.call('goal.activity.append', { ...body, operationId: undefined } as any)).rejects.toThrow('explicit operationId')
    expect((await typed.call('goal.activity.inspect', { goalId: 'goal', operationId: 'not-yet-recorded' })).activity).toBeNull()
    const actualActivity = api.demands.activity
    const lost = vi.spyOn(api.demands, 'activity').mockImplementationOnce(async (...args) => { await actualActivity(...args); throw new Error('Original activity receipt was lost') })
    await expect(typed.call('goal.activity.append', { ...body, operationId: 'activity-lost', kind: 'test', message: 'Saved test evidence before receipt loss.' })).rejects.toThrow('receipt was lost')
    lost.mockRestore()
    const recovered = await typed.call('goal.activity.inspect', { goalId: 'goal', operationId: 'activity-lost' })
    expect(recovered.activity).toMatchObject({ operationId: 'activity-lost', actorId: session.agentSessionId, kind: 'test' })
    expect((await demands.get('goal'))?.activities.filter(row => row.operationId === 'activity-lost')).toHaveLength(1)
    const reopened = openDemandStore({ root: join(directory, 'goals') })
    expect(await reopened.inspectActivity('goal', body.operationId)).toMatchObject({ activity, diskDurability: 'confirmed' })
    expect((await reopened.get('goal'))?.activities.some(row => row.id === 'old-activity')).toBe(true)
    expect((await typed.call('app.snapshot', { include: ['goals', 'activity'] })).activity).toContainEqual({ goalId: 'goal', ...activity })
    const failedDiskObservation = vi.spyOn(demands as any, 'confirmSnapshot').mockRejectedValue(new Error('Original activity disk confirmation is unavailable'))
    await expect(typed.call('goal.activity', { goalId: 'goal' })).rejects.toThrow('disk confirmation is unavailable')
    expect((await typed.call('goal.inspect', { goalId: 'goal' })).goal?.activities).toContainEqual(activity)
    expect((await typed.call('goal.ls', {})).goals.find(row => row.id === 'goal')?.id).toBe('goal')
    failedDiskObservation.mockRestore()
    expect(writes).toEqual([]); expect(manager.list()).toEqual([])
    expect(useAppStore.getState().sessions.find(row => row.id === session.agentSessionId)?.control.run).toEqual(session.run)
  } finally { await typed.dispose(); await human.dispose(); await server.stop() }
})
async function start() { return useAppStore.getState().executeControl(request()) }

it('Demand Supervisor: new Continue needs a saved responsible Supervisor while ordinary manual input stays usable', async () => {
  await demands.update('goal', { supervisorSessionId: null })
  useAppStore.getState().setAgentComposerDraft(session.agentSessionId, 'My healthy manual draft')
  await expect(start()).rejects.toThrow('Supervisor')
  expect(manager.list()).toEqual([]); expect(writes).toEqual([])
  expect(useAppStore.getState().agentComposerDrafts[session.agentSessionId]).toBe('My healthy manual draft')
  useAppStore.getState().setAgentComposerDraft(session.agentSessionId, '')
  await expect(useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'finite-without-supervisor', operation: 'demand.start', demandId: 'goal' })).resolves.toMatchObject({ receipt: { sessionId: session.agentSessionId } })
  expect(writes.length).toBeGreaterThan(0); expect(manager.list()).toEqual([])
})

it('Demand Supervisor: finite start uses only the explicit responsible Session or unique assignee and never creates an Agent', async () => {
  const launch = vi.spyOn(useAppStore.getState(), 'launchBoardAgent')
  await demands.update('goal', { sessionIds: [session.agentSessionId, 'last-history-only'] })
  await expect(useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'unique-owner-start', operation: 'demand.start', demandId: 'goal' })).resolves.toMatchObject({ receipt: { sessionId: session.agentSessionId } })
  const before = [...writes]
  await demands.update('goal', { assigneeSessionIds: [session.agentSessionId, 'second-owner'] })
  await expect(useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'ambiguous-owners', operation: 'demand.start', demandId: 'goal' })).rejects.toThrow('responsible Session')
  await expect(useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'history-is-not-assignment', operation: 'demand.start', demandId: 'goal', sessionId: 'last-history-only' })).rejects.toThrow('responsible Session')
  await demands.update('goal', { assigneeSessionIds: [], supervisorSessionId: null })
  await expect(useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'no-assignee', operation: 'demand.start', demandId: 'goal' })).rejects.toThrow('responsible Session')
  await expect(useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'removed-owner-explicit', operation: 'demand.start', demandId: 'goal', sessionId: session.agentSessionId })).rejects.toThrow('responsible Session')
  expect(writes).toEqual(before); expect(launch).not.toHaveBeenCalled()
  expect((await demands.get('goal'))!.sessionIds).toEqual([session.agentSessionId, 'last-history-only', 'second-owner'])
})

it('Demand Supervisor: confirmed original start replays its frozen receipt after Supervisor changes and its Run leaves observation', async () => {
  await start(); const loop = manager.list()[0]!, before = [...writes]
  await demands.update('goal', { assigneeSessionIds: ['new-retained-supervisor'], supervisorSessionId: 'new-retained-supervisor', status: 'done' })
  const originalGoal = (await demands.get('goal'))!
  useAppStore.setState({ sessions: [] })
  await expect(start()).resolves.toMatchObject({ demand: { status: 'done', supervisorSessionId: 'new-retained-supervisor' }, continuation: { loopId: loop.loopId, agentSessionId: session.agentSessionId, status: 'stopped', initialDelivery: { state: 'confirmed' } } })
  const warn = vi.spyOn(useAppStore.getState(), 'reportError')
  vi.spyOn(api.demands, 'list').mockRejectedValueOnce(new Error('Current Goal observation unavailable'))
  await expect(start()).resolves.toMatchObject({ continuation: { loopId: loop.loopId, agentSessionId: session.agentSessionId, initialDelivery: { state: 'confirmed' } } })
  expect(warn).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ kind: 'indeterminate', summary: expect.stringContaining('Reading the current Goal is unconfirmed') }))
  expect(await demands.get('goal')).toEqual(originalGoal); expect(writes).toEqual(before)
  expect(manager.list()).toHaveLength(1)
})

it('Demand Supervisor: the no-Supervisor banner opens the shared choice without starting or changing saved relationships', async () => {
  await demands.update('goal', { supervisorSessionId: null }); await useAppStore.getState().refreshDemand('goal')
  const choose = vi.fn(), goal = useAppStore.getState().demands.goal!
  await act(async () => root.render(<GoalContinuationControl demand={goal} onChooseSupervisor={choose} />))
  await vi.waitFor(() => expect(container.textContent).toContain('Choose one assignee'))
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Choose Supervisor')!
  expect(button).toBeDefined(); await act(async () => button.click())
  expect(choose).toHaveBeenCalledTimes(1); expect(container.querySelector('form')).toBeNull()
  expect((await demands.get('goal'))!.supervisorSessionId).toBeNull(); expect(writes).toEqual([]); expect(manager.list()).toEqual([])
})

it('Demand Supervisor: shared Continue uses the saved Supervisor instead of first historical association', async () => {
  await demands.update('goal', { sessionIds: ['first-history-only', session.agentSessionId] }); await useAppStore.getState().refreshDemand('goal')
  const goal = useAppStore.getState().demands.goal!
  await act(async () => root.render(<GoalContinuationControl demand={goal} />))
  await vi.waitFor(() => expect(container.querySelector('form')).not.toBeNull())
  expect(container.querySelector('[aria-label="Goal continuation Agent"]')).toBeNull()
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Start and continue')!
  expect(button.disabled).toBe(false); await act(async () => button.click())
  await vi.waitFor(() => expect(manager.list()[0]?.initialDelivery?.state).toBe('confirmed'))
  expect(manager.list()[0]).toMatchObject({ agentSessionId: session.agentSessionId, initialDelivery: { condition: { expectedRun: session.run } } })
  expect(writes.length).toBeGreaterThan(0)
})

it('Demand Supervisor: an unknown start retains one original attempt and locks interval changes until explicit inspection', async () => {
  const prepare = api.continuousProgress.prepareGoal
  const calls: any[] = []
  vi.spyOn(api.continuousProgress, 'prepareGoal').mockImplementation(async (...args) => {
    calls.push(structuredClone(args[0])); if (calls.length === 1) throw new Error('Original start receipt is unknown')
    return prepare(...args)
  })
  const goal = useAppStore.getState().demands.goal!
  await act(async () => root.render(<GoalContinuationControl demand={goal} />))
  await vi.waitFor(() => expect(container.querySelector('form')).not.toBeNull())
  const startButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Start and continue')!
  await act(async () => startButton.click())
  await vi.waitFor(() => expect(container.textContent).toContain('Original start receipt is unknown'))
  expect(startButton.disabled).toBe(true)
  expect(container.querySelector<HTMLInputElement>('[aria-label="Goal continuation minutes"]')!.disabled).toBe(true)
  const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Inspect and retry original start')!
  expect(retry).toBeDefined(); await act(async () => retry.click())
  await vi.waitFor(() => expect(manager.list()[0]?.initialDelivery?.state).toBe('confirmed'))
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]); expect(manager.list()).toHaveLength(1)
})
it('Demand Supervisor: canonical identities display their original presentation name and artwork while old loops qualify the exact Host', async () => {
  await start()
  const originalLoops = structuredClone(manager.list()), originalWrites = [...writes]
  const sourceId = 'local:presentation-source', nativeTimeline = await client.sessionTimeline(session.agentSessionId)
  expect(nativeTimeline.items.some(item => item.kind === 'user_message')).toBe(true)
  const source = { ...snapshot, id: sourceId, label: 'Provider fallback only' }
  const artwork = { ...config, executors: { ...config.executors, [source.executorId]: { ...config.executors[source.executorId]!, avatar: { badge: 'shield' as const } } } }
  useAppStore.setState({ sessions: [source], agentNames: { [sourceId]: 'User chosen canonical name' }, timelines: { [sourceId]: nativeTimeline }, config: artwork })
  const goal = useAppStore.getState().demands.goal!, render = vi.fn()
  await act(async () => root.render(<Profiler id="continuation" onRender={render}><GoalContinuationControl demand={goal} /></Profiler>))
  await vi.waitFor(() => expect(container.querySelector('.goals-continuation__saved')).not.toBeNull())
  expect(container.querySelector('.goals-supervisor-identity strong')!.textContent).toBe('User chosen canonical name')
  expect(container.querySelector('.goals-continuation__original-agent strong')!.textContent).toBe('User chosen canonical name')
  expect(container.querySelectorAll('[data-avatar-badge="shield"]')).toHaveLength(2)
  await act(async () => useAppStore.setState({ agentNames: { [sourceId]: '' } }))
  expect(container.querySelector('.goals-supervisor-identity strong')!.textContent).toBe('Complete the original useful result.')
  const previousRenders = render.mock.calls.length
  await act(async () => {
    for (let index = 0; index < 20; index++) useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: index, items: [] } } }))
  })
  expect(render.mock.calls).toHaveLength(previousRenders)
  const otherHost = { ...source, id: 'remote:presentation-source', hostId: 'remote', control: { ...source.control, hostId: 'remote' } }
  await act(async () => useAppStore.setState({ sessions: [source, otherHost], agentNames: { [otherHost.id]: 'Wrong other Host name' } }))
  expect(container.querySelector('.goals-supervisor-identity strong')!.textContent).toBe(`Session ${session.agentSessionId} · Hosts local, remote`)
  expect(container.querySelector('.goals-supervisor-identity [data-avatar-badge]')).toBeNull()
  expect(container.querySelector('.goals-continuation__original-agent strong')!.textContent).toBe('Complete the original useful result.')
  expect(container.querySelector('.goals-continuation__original-agent strong')!.getAttribute('title')).toContain('Host local')
  expect(container.querySelector('.goals-continuation__original-agent [data-avatar-badge="shield"]')).not.toBeNull()
  expect(writes).toEqual(originalWrites); expect(manager.list()).toEqual(originalLoops)
})
it.each(['finite', 'continue'] as const)('Demand Supervisor: canonical %s start reaches original Main/Core through a unique presentation and retains the same unknown operation', async mode => {
  await act(async () => root.render(null))
  const sourceId = 'local:business-presentation', source = { ...snapshot, id: sourceId }
  const otherHost = { ...source, id: 'remote:business-presentation', hostId: 'remote', control: { ...source.control, hostId: 'remote' } }
  useAppStore.setState({ sessions: [source, otherHost], timelines: { [sourceId]: await client.sessionTimeline(session.agentSessionId) } })
  const publicOwner = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client }], execute: request => useAppStore.getState().executeControl(request) })
  const input = { goalId: 'goal', sessionId: session.agentSessionId, operationId: `canonical-${mode}-unknown`, ...(mode === 'continue' ? { continuation: { intervalMs: 60_000, alignmentRevision: 1 } } : {}) }
  await expect(publicOwner.call('goal.start', input)).rejects.toThrow('ambiguous')
  expect(writes).toEqual([]); expect(manager.list()).toEqual([])
  useAppStore.setState({ sessions: [source] })
  const deliver = bridge.deliver, held: any[][] = []
  // Lose the actual observation transport, not the original Core write/receipt. Replay its
  // unchanged native facts after explicit inspection, as a recovered Host subscription does.
  bridge.deliver = (channel, ...args) => {
    if (channel === SESSION_EVENT_CHANNEL && args[0]?.event?.type === 'agent-timeline') { held.push(structuredClone(args)); return }
    deliver(channel, ...args)
  }
  if (mode === 'continue') {
    useAppStore.getState().setAgentComposerDraft(sourceId, 'My original healthy draft')
    await expect(publicOwner.call('goal.start', input)).rejects.toThrow('Keep your draft and queued messages')
    expect(useAppStore.getState().agentComposerDrafts[sourceId]).toBe('My original healthy draft')
    expect(writes).toEqual([]); expect(manager.list()).toEqual([])
    useAppStore.getState().setAgentComposerDraft(sourceId, '')
    const confirm = api.continuousProgress.initialGoalInput; let lost = false
    vi.spyOn(api.continuousProgress, 'initialGoalInput').mockImplementation(async (...args) => {
      const result = await confirm(...args)
      if (args[3] === 'confirm' && !lost) { lost = true; throw new Error('Canonical original prompt receipt lost') }
      return result
    })
    await expect(publicOwner.call('goal.start', input)).rejects.toThrow('prompt receipt lost')
    expect(manager.list()[0]).toMatchObject({ hostId: 'local', agentSessionId: session.agentSessionId, initialDelivery: { operationId: input.operationId, state: 'confirmed', condition: { expectedRun: session.run } } })
  } else {
    const submit = api.sessions.submitPrompt; let lost = false
    vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (...args) => {
      const result = await submit(...args)
      expect(args[0]).toMatchObject({ hostId: 'local', agentSessionId: session.agentSessionId, run: session.run })
      if (!lost) { lost = true; throw new Error('Canonical original finite receipt lost') }
      return result
    })
    await expect(publicOwner.call('goal.start', input)).rejects.toThrow('finite receipt lost')
    expect(useAppStore.getState().agentSteerQueues[sourceId]![0]).toMatchObject({ operationId: input.operationId, execution: 'default', promptCondition: { expectedRun: session.run } })
    expect(useAppStore.getState().agentSteerQueues[session.agentSessionId]).toBeUndefined()
    expect(manager.list()).toEqual([])
  }
  expect(held.some(args => args[0].event.mutation.type === 'append' && args[0].event.mutation.item.id === `prompt:${input.operationId}`)).toBe(true)
  expect(useAppStore.getState().sessions.map(item => item.id)).toEqual([sourceId])
  expect(useAppStore.getState().agentSteerQueues[sourceId]![0]).toMatchObject({ operationId: input.operationId, awaitingExplicitSend: true })
  const ambiguous = { ...source, id: 'same-host:ambiguous-presentation' }
  useAppStore.setState({ sessions: [source, ambiguous] })
  const originalQueues = useAppStore.getState().agentSteerQueues, originalTimelines = useAppStore.getState().timelines
  for (const args of held) deliver(SESSION_EVENT_CHANNEL, ...args)
  expect(useAppStore.getState().agentSteerQueues).toBe(originalQueues)
  expect(useAppStore.getState().timelines).toBe(originalTimelines)
  expect(useAppStore.getState().sessions.map(item => item.id)).toEqual([sourceId, ambiguous.id])
  useAppStore.setState({ sessions: [source] })
  for (const args of held) {
    const foreignHost = structuredClone(args), foreignRun = structuredClone(args)
    foreignHost[0].hostId = 'other-host'
    foreignRun[0].event.evidence.run = { runId: 'other-run' }
    deliver(SESSION_EVENT_CHANNEL, ...foreignHost); deliver(SESSION_EVENT_CHANNEL, ...foreignRun)
  }
  expect(useAppStore.getState().agentSteerQueues).toBe(originalQueues)
  expect(useAppStore.getState().timelines).toBe(originalTimelines)
  const accepted = [...writes]; expect(accepted.length).toBeGreaterThan(0)
  await useAppStore.getState().flushAgentSteerQueue(sourceId)
  expect(writes).toEqual(accepted)
  bridge.deliver = deliver
  for (const args of held) deliver(SESSION_EVENT_CHANNEL, ...args)
  expect(useAppStore.getState().sessions.map(item => item.id)).toEqual([sourceId])
  expect(useAppStore.getState().timelines[sourceId]).toMatchObject({ agentSessionId: session.agentSessionId })
  expect(useAppStore.getState().timelines[sourceId]!.items.some(item => item.id === `prompt:${input.operationId}` && item.agentSessionId === session.agentSessionId)).toBe(true)
  expect(await publicOwner.call('goal.start', input)).toMatchObject({ receipt: { goalId: 'goal', sessionId: session.agentSessionId } })
  expect(writes).toEqual(accepted)
  expect(useAppStore.getState().agentSteerQueues[sourceId] ?? []).toEqual([])
  useAppStore.setState({ timelines: { [sourceId]: { agentSessionId: session.agentSessionId, revision: 0, items: [] } } })
  await useAppStore.getState().resyncTimeline(sourceId)
  expect(useAppStore.getState().timelines[sourceId]!.items.some(item => item.id === `prompt:${input.operationId}`)).toBe(true)
  expect(Object.keys(useAppStore.getState().timelines)).toEqual([sourceId])
  expect(useAppStore.getState().timelines[sourceId]!.agentSessionId).toBe(session.agentSessionId)
  expect((await publicOwner.call('goal.inspect', { goalId: 'goal' })).goal).toMatchObject({ supervisorSessionId: session.agentSessionId, assigneeSessionIds: [session.agentSessionId] })
  expect((await demands.get('goal'))!.sessionIds).toEqual([session.agentSessionId])
})
it.each(['confirmed', 'reconciled', 'missing', 'inspect-failed', 'reconcile-failed', 'still-unknown', 'different-operation'] as const)(
  'Goal replay queue: %s preserves the original input and releases only a confirmed Goal operation', async observation => {
    await act(async () => root.render(null))
    const publicOwner = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client }], execute: request => useAppStore.getState().executeControl(request) })
    const input = { goalId: 'goal', sessionId: session.agentSessionId, operationId: 'replay-queue-original', continuation: { intervalMs: 60_000, alignmentRevision: 1 } }
    const deliver = bridge.deliver
    bridge.deliver = (channel, ...args) => {
      if (channel === SESSION_EVENT_CHANNEL && args[0]?.event?.type === 'agent-timeline') return
      deliver(channel, ...args)
    }
    const confirm = api.continuousProgress.initialGoalInput
    const lost = vi.spyOn(api.continuousProgress, 'initialGoalInput').mockImplementation(async (...args) => {
      const result = await confirm(...args)
      if (args[3] === 'confirm') throw new Error('Original confirmation reply lost')
      return result
    })
    await expect(publicOwner.call('goal.start', input)).rejects.toThrow('confirmation reply lost')
    lost.mockRestore()
    const original = useAppStore.getState().agentSteerQueues[session.agentSessionId]![0]!
    expect(original.goalDispatch).toEqual({ goalId: 'goal', operationId: input.operationId })
    const reference = original.goalDispatch!
    // Confirm the real business owner from its actual Core timeline before losing only
    // an observation reply. No fixture creates a dispatch/Loop/input confirmation.
    const receipt = await api.demands.reconcileDispatch(reference)
    const dispatch = await api.demands.inspectDispatch(reference)
    expect(dispatch?.stage).toBe('confirmed')
    const accepted = [...writes]
    expect(accepted.length).toBeGreaterThan(0)
    const { goalDispatch: _dispatch, goalContinuation: _continuation, ...manual } = original
    const retained = [
      { ...original, goalDispatch: { goalId: 'another-goal', operationId: input.operationId } },
      { ...original, operationId: 'another-operation', goalDispatch: { goalId: 'goal', operationId: 'another-operation' } },
      { ...manual, operationId: 'manual-operation', text: 'My queued manual message', origin: 'manual' as const }
    ]
    const otherQueue = [{ ...manual, operationId: 'another-presentation', text: 'Retain this unrelated presentation' }]
    useAppStore.setState({ agentSteerQueues: { [session.agentSessionId]: [original, ...retained], unrelated: otherQueue } })
    useAppStore.getState().setAgentComposerDraft(session.agentSessionId, 'My healthy unsent draft')
    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('paused'))
    const loops = structuredClone(manager.list())
    const unknown = { ...dispatch!, stage: 'unknown' as const }
    if (observation === 'missing') vi.spyOn(api.demands, 'inspectDispatch').mockResolvedValueOnce(null)
    else if (observation === 'inspect-failed') vi.spyOn(api.demands, 'inspectDispatch').mockRejectedValueOnce(new Error('Original dispatch observation unavailable'))
    else if (observation !== 'confirmed') {
      vi.spyOn(api.demands, 'inspectDispatch').mockResolvedValueOnce(unknown)
      if (observation === 'reconcile-failed') vi.spyOn(api.demands, 'reconcileDispatch').mockRejectedValueOnce(new Error('Original dispatch reconciliation unavailable'))
      else if (observation === 'still-unknown' || observation === 'different-operation') {
        vi.spyOn(api.demands, 'reconcileDispatch').mockResolvedValueOnce({ ...receipt, demand: { ...receipt.demand,
          dispatches: [observation === 'still-unknown' ? unknown : { ...dispatch!, operationId: 'different-confirmed-operation' }] } })
      }
      // 'reconciled' consumes the original Main/Core/Demand reconciliation unchanged.
    }
    expect(await publicOwner.call('goal.start', input)).toMatchObject({ receipt: { goalId: 'goal', sessionId: session.agentSessionId } })
    const confirmed = observation === 'confirmed' || observation === 'reconciled'
    expect(useAppStore.getState().agentSteerQueues[session.agentSessionId]).toEqual(confirmed ? retained : [original, ...retained])
    expect(useAppStore.getState().agentSteerQueues.unrelated).toEqual(otherQueue)
    expect(useAppStore.getState().agentComposerDrafts[session.agentSessionId]).toBe('My healthy unsent draft')
    expect(writes).toEqual(accepted); expect(manager.list()).toEqual(loops)
    expect(useAppStore.getState().sessions[0]).toMatchObject({ id: session.agentSessionId, processState: 'running', control: { run: session.run } })
    bridge.deliver = deliver
  })
function refuseImmediatePreparation() {
  return vi.spyOn((client as any).promptSubmission, 'qualifyInputTransport')
    .mockRejectedValue(new Error('Native immediate preparation is unavailable'))
}
it('finite Goal typed public start freezes ordinary execution before preparation and reaches real Core input', async () => {
  const preparation = refuseImmediatePreparation()
  const refresh = api.sessions.refresh
  const pending: any[] = []
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async (...args) => {
    pending.push(structuredClone(useAppStore.getState().agentSteerQueues[session.agentSessionId]))
    return refresh(...args)
  })
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client }], execute: request => useAppStore.getState().executeControl(request) })
  const attempt = service.call('goal.start', { goalId: 'goal', sessionId: session.agentSessionId, operationId: 'finite-original' })
  await expect(attempt).resolves.toMatchObject({ receipt: { goalId: 'goal', sessionId: session.agentSessionId } })
  const result = await attempt
  expect(pending.length).toBeGreaterThan(0)
  expect(pending[0]).toEqual([expect.objectContaining({ operationId: 'finite-original', execution: 'default', promptCondition: null })])
  expect(result).toMatchObject({ receipt: { goalId: 'goal', sessionId: session.agentSessionId } })
  expect(preparation).not.toHaveBeenCalled()
  expect(writes.length).toBeGreaterThan(0)
  expect(writes.join('')).toContain('Complete the original useful result.')
  expect(writes.join('')).not.toContain('\u0003')
  expect(manager.list()).toEqual([])
  expect(useAppStore.getState().agentSteerQueues[session.agentSessionId] ?? []).toEqual([])
})
it('finite Goal actual Source CLI uses the same ordinary public owner', async () => {
  const preparation = refuseImmediatePreparation()
  const server = new PublicServer({ socketPath: join(directory, 'finite.sock'), coreClients: () => [{ hostId: 'local', client }], execute: request => useAppStore.getState().executeControl(request) })
  await server.start()
  try {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    const response = JSON.parse((await promisify(execFile)(process.execPath, [sourceCli, '--endpoint', 'unix:' + server.path, 'goal', 'start', '--goal', 'goal', '--session', session.agentSessionId, '--operation-id', 'finite-cli'], { env: environment, timeout: 15000 })).stdout)
    expect(response.ok).toBe(true)
    expect(response.result.receipt).toMatchObject({ goalId: 'goal', sessionId: session.agentSessionId })
    expect(preparation).not.toHaveBeenCalled()
    expect(writes.length).toBeGreaterThan(0)
    expect(manager.list()).toEqual([])
  } finally { await server.stop() }
})
it.each(['immediate', undefined] as const)('finite Goal refuses to rewrite an old operation with execution %s', async execution => {
  const preparation = refuseImmediatePreparation()
  const entry = { operationId: 'finite-old', runId: session.run.runId, text: 'Complete the original useful result.', promptCondition: null, status: 'deferred' as const, ...(execution ? { execution } : {}) }
  useAppStore.setState({ agentSteerQueues: { [session.agentSessionId]: [entry] } })
  useAppStore.getState().setAgentComposerDraft(session.agentSessionId, 'Later human draft stays.')
  const input = container.querySelector('[contenteditable="true"]')
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  await expect(useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'demand.start', requestId: 'finite-old', demandId: 'goal', sessionId: session.agentSessionId })).rejects.toThrow()
  expect(useAppStore.getState().agentSteerQueues[session.agentSessionId]).toEqual([entry])
  expect(submit).not.toHaveBeenCalled()
  expect(preparation).not.toHaveBeenCalled()
  expect(writes).toEqual([])
  expect(useAppStore.getState().agentComposerDrafts[session.agentSessionId]).toBe('Later human draft stays.')
  expect(container.querySelector('[contenteditable="true"]')).toBe(input)
})
it('finite Goal unknown submission keeps ordinary mode and waits for explicit same-operation retry', async () => {
  const preparation = refuseImmediatePreparation()
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValueOnce(new Error('Finite original submission outcome unknown'))
  const finite = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'demand.start' as const, requestId: 'finite-lost', demandId: 'goal', sessionId: session.agentSessionId }
  await expect(useAppStore.getState().executeControl(finite)).rejects.toThrow('outcome unknown')
  const retained = useAppStore.getState().agentSteerQueues[session.agentSessionId]![0]!
  expect(retained).toMatchObject({ operationId: 'finite-lost', execution: 'default', promptCondition: { expectedRun: session.run } })
  const before = [...writes]; expect(before).toEqual([])
  await useAppStore.getState().flushAgentSteerQueue(session.agentSessionId)
  expect(writes).toEqual(before)
  expect(submit).toHaveBeenCalledTimes(1)
  expect(await useAppStore.getState().executeControl(finite)).toMatchObject({ receipt: { sessionId: session.agentSessionId } })
  expect(writes.length).toBeGreaterThan(0)
  expect(submit).toHaveBeenCalledTimes(2)
  expect(submit.mock.calls.every(call => call[2] === 'finite-lost' && call[4]?.execution !== 'immediate')).toBe(true)
  expect(preparation).not.toHaveBeenCalled()
})
it.each(['permission', 'changed Run'] as const)('finite Goal keeps its original ordinary intent when %s blocks this submission', async failure => {
  const preparation = refuseImmediatePreparation()
  const refresh = api.sessions.refresh
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async (...args) => {
    if (failure === 'permission') await (client as any).registry.update(session.agentSessionId, session.run, (current: AgentMuxStoredAgentSession) => ({ ...current, pendingInteraction: { request: { kind: 'permission', id: 'finite-permission', agentSessionId: session.agentSessionId, title: 'Pending human choice', options: [{ id: 'deny', label: 'Deny', kind: 'reject-once' }], evidence: { source: 'native-hook', observedAt: _reshape_fixtureEpoch(0, 0, 200), run: session.run } } } }))
    const result = await refresh(...args)
    if (result.kind !== 'agent') throw new Error('The original fixture Agent is required')
    return failure === 'changed Run' ? { ...result, control: { ...result.control, run: { runId: 'later-run' } } } : result
  })
  useAppStore.getState().setAgentComposerDraft(session.agentSessionId, 'Later draft stays.')
  const input = container.querySelector('[contenteditable="true"]')
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  await expect(useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'demand.start', requestId: 'finite-blocked', demandId: 'goal', sessionId: session.agentSessionId })).rejects.toThrow()
  expect(useAppStore.getState().agentSteerQueues[session.agentSessionId]).toEqual([expect.objectContaining({ operationId: 'finite-blocked', execution: 'default', runId: session.run.runId, text: 'Complete the original useful result.' })])
  expect(writes).toEqual([])
  expect(submit).not.toHaveBeenCalled()
  expect(preparation).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[session.agentSessionId]).toBe('Later draft stays.')
  expect(container.querySelector('[contenteditable="true"]')).toBe(input)
})
it('finite Goal retains ordinary healthy input and the original notice when presentation saving fails', async () => {
  const preparation = refuseImmediatePreparation()
  const save = vi.spyOn(api.ui, 'requestStorageFlush').mockRejectedValue(new Error('Original presentation save is unavailable'))
  try {
    await expect(useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'demand.start', requestId: 'finite-save-warning', demandId: 'goal', sessionId: session.agentSessionId })).resolves.toMatchObject({ receipt: { sessionId: session.agentSessionId } })
    await vi.waitFor(() => expect(useAppStore.getState().workbenchSaveWarning).toContain('Original presentation save is unavailable'))
    expect(writes.length).toBeGreaterThan(0)
    expect(preparation).not.toHaveBeenCalled()
  } finally { save.mockRestore() }
})
it('actual original Goal Store, preload, IPC, Manager and Core queue freeze one operation before any input', async () => {
  const originalInput = (client as any).kernel.input
  const beforeInput: any[] = []
  ;(client as any).kernel.input = async (...args: any[]) => {
    const records = JSON.parse(await readFile(join(directory, 'loops.json'), 'utf8'))
    beforeInput.push(records[0]); expect(records[0]).toMatchObject({ status: 'paused', creationOperationId: 'original-start', initialDelivery: { state: 'unknown', operationId: 'original-start', condition: { expectedRun: session.run } } })
    return originalInput(...args)
  }
  const result = await start()
  expect(result).toMatchObject({ operation: 'demand.start', receipt: { sessionId: session.agentSessionId }, continuation: { status: 'active', initialDelivery: { state: 'confirmed' } } })
  expect(beforeInput.length).toBeGreaterThan(0)
  const before = [...writes]
  expect(await start()).toMatchObject({ continuation: { loopId: manager.list()[0]!.loopId, creationOperationId: 'original-start' } })
  expect(writes).toEqual(before)
  expect(manager.list()).toHaveLength(1)
  const inspected = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'inspect', operation: 'demand.show', demandId: 'goal' })
  expect(inspected).toMatchObject({ goalContinuations: [{ initialDelivery: { state: 'confirmed' } }] })
  expect(await demands.get('goal')).toMatchObject({ status: 'in_progress', alignment: { revision: 1 } })
  expect((await demands.get('goal'))!.grounding).toBeUndefined()
})
it('lost original IPC response reuses original Core transaction without another input', async () => {
  const original = api.continuousProgress.initialGoalInput
  let lose = true
  vi.spyOn(api.continuousProgress, 'initialGoalInput').mockImplementation(async (...args) => { const result = await original(...args); if (args[3] === 'confirm' && lose) throw new Error('Actual private lost prompt receipt'); return result })
  await expect(start()).rejects.toThrow('lost prompt receipt')
  const loop = manager.list()[0]!, before = [...writes]
  expect(loop).toMatchObject({ status: 'active', initialDelivery: { state: 'confirmed', operationId: 'original-start' } })
  lose = false
  expect(await start()).toMatchObject({ continuation: { loopId: loop.loopId, initialDelivery: { state: 'confirmed' } } })
  expect(writes).toEqual(before)
})
it('Goal revision, exact association, conflicting operation and foreign loop do not retarget work', async () => {
  await start(); const original = manager.list()[0]!, before = [...writes]
  await expect(useAppStore.getState().executeControl({ ...request(), continuation: { intervalMs: 1, alignmentRevision: 1 } })).rejects.toThrow('different Goal content')
  await expect(useAppStore.getState().executeControl({ ...request('second-start') })).rejects.toThrow('already exists')
  await expect(useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'bad-action', operation: 'demand.continuation-action', demandId: 'other-goal', loopId: original.loopId, action: 'stop', expectedRevision: 1 })).rejects.toThrow('exact Goal')
  await demands.update('goal', { title: 'A harmless display rename' })
  expect(manager.list()[0]!.status).toBe('active')
  await demands.create({ id: 'other-goal', title: 'Unrelated Goal' })
  expect(manager.list()[0]!.status).toBe('active')
  await demands.update('goal', { alignment: { summary: 'Changed scope', criteria: [{ id: 'real', text: 'Different real work' }], openQuestions: [] } })
  expect(manager.list()[0]!).toMatchObject({ status: 'paused', taskSource: { alignmentRevision: 1 } })
  await demands.confirmAlignment('goal', 2)
  await expect(manager.goalAction('goal', original.loopId, 'resume', 1, 'resume-new-scope')).rejects.toThrow('scope changed')
  expect(writes).toEqual(before)
})
it('actual public typed and Source CLI codecs retain Goal loops and action receipts', async () => {
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client }], execute: request => useAppStore.getState().executeControl(request) })
  const invocation = await parseAgentMuxCliInvocation(['goal', 'start', '--goal', 'goal', '--session', session.agentSessionId, '--continue-ms', '60000', '--alignment-revision', '1', '--operation-id', 'original-start'])
  expect(invocation).toMatchObject({ command: { method: 'goal.start' }, params: { operationId: 'original-start', continuation: { intervalMs: 60000, alignmentRevision: 1 } } })
  const response = await service.call(invocation.command.method as 'goal.start', invocation.params as never)
  expect(response).toMatchObject({ goal: { id: 'goal' }, continuation: { creationOperationId: 'original-start' } })
  const inspected = await service.call('goal.inspect', { goalId: 'goal' })
  expect(inspected.goalContinuations).toHaveLength(1)
  const loop = inspected.goalContinuations[0]!
  const paused = await service.call('goal.continuation-action', { goalId: 'goal', loopId: loop.loopId, action: 'pause', expectedRevision: loop.revision!, operationId: 'original-pause' })
  expect(paused).toMatchObject({ goalId: 'goal', continuation: { status: 'paused', revision: 2, lastMutation: { operationId: 'original-pause' } }, diskDurability: 'confirmed' })
  const retry = await service.call('goal.continuation-action', { goalId: 'goal', loopId: loop.loopId, action: 'pause', expectedRevision: 1, operationId: 'original-pause' })
  expect(retry).toEqual(paused)
  await expect(service.call('goal.continuation-action', { goalId: 'goal', loopId: loop.loopId, action: 'resume', expectedRevision: 1, operationId: 'stale' })).rejects.toThrow('revision changed')
  const nativeBefore = [...writes]
  await demands.update('goal', { status: 'done' })
  expect(manager.list()[0]!.status).toBe('stopped')
  expect(writes).toEqual(nativeBefore); expect(ended).toBe(false)
  expect((await demands.get('goal'))!.grounding?.acceptedAt).toBeUndefined()
  await service.dispose()
})

it('changing the original Goal after queue admission cancels its initial input at the native boundary', async () => {
  const original = runtime.submitPrompt.bind(runtime)
  vi.spyOn(runtime, 'submitPrompt').mockImplementationOnce(async (...args) => {
    await demands.update('goal', { alignment: { summary: 'Later human scope', criteria: [{ id: 'late', text: 'Later target' }], openQuestions: [] } })
    return original(...args)
  })
  await expect(start()).rejects.toThrow()
  expect(writes).toEqual([])
  expect(manager.list()[0]).toMatchObject({ status: 'paused', initialDelivery: { operationId: 'original-start', state: 'unknown' } })
  expect(useAppStore.getState().agentSteerQueues[session.agentSessionId]?.[0]).toMatchObject({ operationId: 'original-start', text: 'Complete the original useful result.' })
  expect(useAppStore.getState().sessions.find(item => item.id === session.agentSessionId)).toMatchObject({ processState: 'running' })
})

it('the actual shared Goal control keeps one pause operation through duplicate click and lost ACK', async () => {
  await start()
  const original = api.continuousProgress.goalAction, calls: any[][] = []
  let lose = true
  vi.spyOn(api.continuousProgress, 'goalAction').mockImplementation(async (...args) => { calls.push(structuredClone(args)); const result = await original(...args); if (lose) throw new Error('Actual private action receipt lost'); return result })
  const goal = useAppStore.getState().demands.goal!
  await act(async () => root.render(<><GoalContinuationControl demand={goal} /><AgentSessionComposer sessionId={session.agentSessionId} /></>))
  await vi.waitFor(() => expect([...container.querySelectorAll<HTMLButtonElement>('.goals-continuation button')].find(button => button.textContent === 'Pause')).toBeDefined())
  const pause = [...container.querySelectorAll<HTMLButtonElement>('.goals-continuation button')].find(button => button.textContent === 'Pause')!
  await act(async () => { pause.click(); pause.click() })
  await vi.waitFor(() => expect(container.textContent).toContain('Actual private action receipt lost'))
  expect(calls).toHaveLength(1)
  expect(manager.list()[0]).toMatchObject({ status: 'paused', revision: 2 })
  const saved = calls[0]
  const retry = [...container.querySelectorAll<HTMLButtonElement>('.goals-continuation button')].find(button => button.textContent === 'Inspect and retry original pause')!
  expect(retry).toBeDefined(); lose = false
  await act(async () => retry.click())
  await vi.waitFor(() => expect(calls).toHaveLength(2))
  expect(calls[1]).toEqual(saved)
  expect(manager.list()[0]).toMatchObject({ status: 'paused', revision: 2 })
  await vi.waitFor(() => expect(container.textContent).not.toContain('Actual private action receipt lost'))
})

it('a remounted Goal control recovers the durable original start without replacing the Composer or its later draft', async () => {
  const original = manager.initialGoalInput.bind(manager)
  let lose = true
  const inspection = vi.spyOn(runtime, 'inspectContinuousProgressInitial').mockResolvedValue('pending')
  vi.spyOn(manager, 'initialGoalInput').mockImplementation(async (...args) => { if (lose && args[3] === 'confirm') throw new Error('Actual private initial ACK lost'); return original(...args) })
  await expect(start()).rejects.toThrow('ACK lost')
  expect(manager.list()[0]).toMatchObject({ status: 'paused', creationOperationId: 'original-start', initialDelivery: { state: 'unknown' } })
  const before = [...writes], goal = useAppStore.getState().demands.goal!
  useAppStore.getState().setAgentComposerDraft(session.agentSessionId, 'A later manual draft stays here.')
  await act(async () => root.render(<><div key="goal" /><div key="input"><AgentSessionComposer sessionId={session.agentSessionId} /></div></>))
  const input = container.querySelector<HTMLElement>('[contenteditable="true"]')!
  const text = document.createTreeWalker(input, NodeFilter.SHOW_TEXT).nextNode()!
  input.focus(); const selected = document.createRange(); selected.setStart(text, 2); selected.setEnd(text, 9)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(selected)
  await demands.update('goal', { title: 'A display rename keeps the original operation' })
  await act(async () => root.render(<><div key="goal"><GoalContinuationControl demand={goal} /></div><div key="input"><AgentSessionComposer sessionId={session.agentSessionId} /></div></>))
  await vi.waitFor(() => expect([...container.querySelectorAll<HTMLButtonElement>('.goals-continuation button')].find(button => button.textContent === 'Inspect and retry original start')).toBeDefined())
  const retry = [...container.querySelectorAll<HTMLButtonElement>('.goals-continuation button')].find(button => button.textContent === 'Inspect and retry original start')!
  lose = false; inspection.mockRestore()
  await act(async () => retry.click())
  await vi.waitFor(() => expect(manager.list()[0]!.initialDelivery!.state).toBe('confirmed'))
  expect(manager.list()[0]!.creationOperationId).toBe('original-start'); expect(writes).toEqual(before)
  expect(container.querySelector('[contenteditable="true"]')).toBe(input); expect(input.textContent).toBe('A later manual draft stays here.')
  expect([window.getSelection()!.anchorNode, window.getSelection()!.anchorOffset, window.getSelection()!.focusNode, window.getSelection()!.focusOffset]).toEqual([text, 2, text, 9])
})

it('a real typed socket client and actual Source CLI exercise inspect, initial business operation and exact same-loop action', async () => {
  const server = new PublicServer({ socketPath: join(directory, 'public.sock'), coreClients: () => [{ hostId: 'local', client }], execute: request => useAppStore.getState().executeControl(request) })
  await server.start(); const typed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    const result = await typed.call('goal.start', { goalId: 'goal', sessionId: session.agentSessionId, operationId: 'original-start', continuation: { intervalMs: 60000, alignmentRevision: 1 } })
    expect(result.continuation?.creationOperationId).toBe('original-start')
    const execute = promisify(execFile), environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    const runCli = async (args: string[]) => { const envelope = JSON.parse((await execute(process.execPath, [sourceCli, '--endpoint', 'unix:' + server.path, ...args], { env: environment, timeout: 15000 })).stdout); expect(envelope.ok).toBe(true); return envelope.result }
    const inspected = await runCli(['goal', 'inspect', '--goal', 'goal'])
    expect(inspected.goalContinuations[0]).toMatchObject({ creationOperationId: 'original-start', agentSessionId: session.agentSessionId })
    const loop = inspected.goalContinuations[0]
    const paused = await runCli(['goal', 'continuation-action', '--goal', 'goal', '--loop', loop.loopId, '--action', 'pause', '--revision', '1', '--operation-id', 'source-cli-pause'])
    expect(paused).toMatchObject({ goalId: 'goal', continuation: { status: 'paused', revision: 2, lastMutation: { operationId: 'source-cli-pause' } }, diskDurability: 'confirmed' })
    expect(await runCli(['goal', 'continuation-action', '--goal', 'goal', '--loop', loop.loopId, '--action', 'pause', '--revision', '1', '--operation-id', 'source-cli-pause'])).toEqual(paused)
    const before = [...writes]
    const restarted = await runCli(['goal', 'start', '--goal', 'goal', '--session', session.agentSessionId, '--continue-ms', '60000', '--alignment-revision', '1', '--operation-id', 'original-start'])
    expect(restarted.continuation.loopId).toBe(loop.loopId); expect(writes).toEqual(before)
  } finally { await typed.dispose(); await server.stop() }
})


import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicLogicalPath } from '../src/shared/scratch-topics'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { originalTopicAddress } from '../src/shared/space-addresses'
import { moteGoalContext, goalsForMote } from '../src/renderer/src/lib/mote-goals'
async function exactContentScope() {
  const workspace = config.workspaces[0]!
  const topic = await api.scratch.ensureMote(workspace.id, PMO_TEAMS_TOPIC_ID)
  const rootPath = scratchTopicLogicalPath(workspace, topic)!
  const address = originalTopicAddress(workspace, topic, useAppStore.getState().spaceZoneBindings)!
  expect(rootPath).not.toBeNull(); expect(address).not.toBeNull(); expect(topic.readError).toBeUndefined()
  const tab = { ...createWorkbenchTab('content-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id, regionId: 'content-region', sessionId: session.agentSessionId }), topicId: topic.id, space: address }
  const revision = (useAppStore.getState().workspaceFileRevisions[workspace.id] ?? 0) + 1
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('content-group', [tab.id]) },
    activeWorkspaceId: workspace.id, mainSurface: 'workbench',
    workbenchSpaceSelection: { workspaceId: workspace.id, ...address, topicId: topic.id, groupId: 'content-group', tabId: tab.id, regionId: 'content-region' },
    workspaceFileRevisions: { ...useAppStore.getState().workspaceFileRevisions, [workspace.id]: revision },
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision, topics: [topic], error: null, reading: false } } })
  return { workspace, topic, rootPath, address }
}
it('original SDK and CLI create/update/list/inspect persist exact content refs through the real Store, preload, IPC and owner', async () => {
  const scope = await exactContentScope(), ref = moteGoalContext(useAppStore.getState(), scope).contentRef
  expect(ref).not.toBeNull()
  const server = new PublicServer({ socketPath: join(directory, 'content.sock'), coreClients: () => [], execute: (...args) => bridge.controlOptions.execute(...args) })
  await server.start(); const typed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    const created = await typed.call('goal.create', { goalId: 'content-original', title: 'Original content work', contentRefs: [ref!], risk: 'low', confirmation: 'user', operationId: 'content-create' })
    expect(created.goal.contentRefs).toEqual([ref]); expect((await demands.get('content-original'))?.contentRefs).toEqual([ref])
    const execute = promisify(execFile), environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    const run = async (args: string[]) => JSON.parse((await execute(process.execPath, [sourceCli, '--endpoint', 'unix:' + server.path, ...args], { env: environment, timeout: 15000 })).stdout)
    const help = (await execute(process.execPath, [sourceCli, 'goal', 'update', '--help'], { env: environment, timeout: 15000 })).stdout
    expect(help).toContain('--content-refs'); expect(help).toContain('--expected-updated-at')
    expect((await execute(process.execPath, [sourceCli, 'goal', '--skill'], { env: environment, timeout: 15000 })).stdout).toContain('content provenance')
    const updated = await run(['goal', 'update', '--goal', 'content-original', '--content-refs', JSON.stringify([ref]), '--expected-updated-at', String(created.goal.updatedAt), '--operation-id', 'content-append'])
    expect(updated.result.goal.contentRefs).toEqual([ref])
    const byCli = await run(['goal', 'create', '--goal', 'content-cli', '--title', 'CLI content', '--content-refs', JSON.stringify([ref]), '--risk', 'low', '--confirm', 'user'])
    expect(byCli.result.goal.contentRefs).toEqual([ref])
    expect((await run(['goal', 'ls'])).result.goals.find((item: any) => item.id === 'content-original').contentRefs).toEqual([ref])
    expect((await typed.call('goal.inspect', { goalId: 'content-original' })).goal?.contentRefs).toEqual([ref])
    const catalog = await typed.call('space.ls', { target: {} }), listed = await typed.call('goal.ls', {})
    const catalogFile = join(directory, 'catalog.json'), goalsFile = join(directory, 'goals.json')
    await writeFile(catalogFile, JSON.stringify({ result: catalog })); await writeFile(goalsFile, JSON.stringify({ result: listed }))
    const preview = JSON.parse((await execute(process.execPath, [resolve(process.env.AGENTMUX_DAILY_GOAL_REPOSITORY!, 'apps/desktop/scripts/preview-goal-content-references.ts'), catalogFile, goalsFile], { env: environment, timeout: 15000 })).stdout)
    expect(preview.readOnly).toBe(true); expect(preview.rows.find((row: any) => row.goalId === 'goal')).toMatchObject({ state: 'confirmed', contentRefs: [ref] })
    await writeFile(resolve(process.env.AGENTMUX_DAILY_GOAL_REPOSITORY!, '.tmp/goal-content/maintenance-preview.json'), JSON.stringify(preview, null, 2))

    await expect(typed.call('goal.update', { goalId: 'content-original', expectedUpdatedAt: created.goal.updatedAt, patch: { contentRefs: [ref!], description: 'Stale' } })).rejects.toThrow('Goal changed')
    await expect(typed.call('goal.update', { goalId: 'content-original', patch: { contentRefs: [{ ...ref!, hostId: 'another-host' }] } })).rejects.toThrow('resource is unconfirmed')
    expect((await demands.get('content-original'))?.description).toBe('')
    const held = await typed.call('goal.create', { goalId: 'content-held-before-save', title: 'Held original', risk: 'low', confirmation: 'user' })
    const originalUpdate = api.demands.update
    const lost = vi.spyOn(api.demands, 'update').mockImplementationOnce(async (...args) => { const saved = await originalUpdate(...args); expect(saved.operationId).toBe(args[2]); expect(saved.operationId).toBe('held-content-append'); expect(saved.nameChange).toBeUndefined(); throw new Error('Original content write receipt lost') })
    await expect(typed.call('goal.update', { goalId: held.goal.id, operationId: 'held-content-append', expectedUpdatedAt: held.goal.updatedAt, patch: { contentRefs: [ref!] } })).rejects.toThrow('receipt lost')
    lost.mockRestore()
    const confirmed = await typed.call('goal.inspect', { goalId: held.goal.id })
    expect(confirmed.goal?.contentRefs).toEqual([ref]); expect(confirmed.goal?.id).toBe(held.goal.id)
    await expect(typed.call('goal.update', { goalId: held.goal.id, operationId: 'held-content-append', expectedUpdatedAt: held.goal.updatedAt, patch: { contentRefs: [ref!] } })).rejects.toThrow('Goal changed')
    expect((await typed.call('goal.inspect', { goalId: held.goal.id })).goal).toEqual(confirmed.goal)
    expect(writes).toEqual([]); expect(manager.list()).toEqual([])
  } finally { await typed.dispose(); await server.stop() }
})
it('closing the last actual resource Tab and opening a new discussion retain original Mote Goal discovery across owner restart', async () => {
  const scope = await exactContentScope(), context = moteGoalContext(useAppStore.getState(), scope)
  expect(context.contentRef).not.toBeNull()
  await useAppStore.getState().updateDemand('goal', { contentRefs: [context.contentRef!] })
  const original = await demands.get('goal'), drafts = useAppStore.getState().agentComposerDrafts
  expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'content-group', 'content-tab', { keepAgentSessions: true })).toBe(true)
  expect(useAppStore.getState().tabs['content-tab']).toBeUndefined()
  const after = moteGoalContext(useAppStore.getState(), scope)
  expect(after.sessionIds).toEqual([]); expect(after.contentRef).toEqual(context.contentRef)
  expect(goalsForMote(useAppStore.getState().demands, after.sessionIds, after.contentRef).map(goal => goal.id)).toContain('goal')
  const next = { ...createWorkbenchTab('new-discussion', { kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'new-region' }), topicId: scope.topic.id, space: scope.address }
  useAppStore.setState({ tabs: { [next.id]: next }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('new-group', [next.id]) } })
  const restarted = await openDemandStore({ root: join(directory, 'goals') }).get('goal')
  expect(restarted).toEqual(original)
  const fresh = moteGoalContext(useAppStore.getState(), scope)
  expect(goalsForMote(useAppStore.getState().demands, fresh.sessionIds, fresh.contentRef).map(goal => goal.id)).toContain('goal')
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts); expect(writes).toEqual([])
})


it('collaboration public Source CLI saves exact relations atomically and reaches original Desktop filters and detail', async () => {
  const peer = { ...structuredClone(session), agentSessionId: 'peer-agent', run: { runId: 'peer-run' }, capabilityHash: hashAgentCapability(issueAgentCapability()) }
  await (client as any).store.compareAndSwap(null, peer); await (client as any).registry.load('local')
  await demands.linkSession('goal', 'remote/retained-history')
  await useAppStore.getState().refreshDemand('goal')
  const server = new PublicServer({ socketPath: join(directory, 'relations.sock'), coreClients: () => [{ hostId: 'local', client }], execute: (...args) => bridge.controlOptions.execute(...args) })
  await server.start()
  const typed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: { agentSessionId: session.agentSessionId, capability: activityCapability } })
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))), AGENTMUX_AGENT_SESSION_ID: session.agentSessionId, AGENTMUX_AGENT_CAPABILITY: activityCapability }
  const run = async (args: string[]) => {
    let response: any
    await act(async () => {
      try { response = JSON.parse((await promisify(execFile)(process.execPath, [sourceCli, '--endpoint', 'unix:' + server.path, ...args], { env: environment, timeout: 15000 })).stdout) }
      catch (error) { const output = (error as any).stdout || (error as any).stderr; if (!output) throw error; response = JSON.parse(output) }
    }); return response
  }
  const mutate = async (method: string, params: any) => { let result: any; await act(async () => { result = await (typed.call as any)(method, params) }); return result }
  try {
    const old = (await demands.get('goal'))!
    const assigned = await run(['goal', 'assign', '--goal', 'goal', '--assignees', '["progress-agent","peer-agent"]', '--supervisor', 'progress-agent', '--expected-updated-at', String(old.updatedAt), '--operation-id', 'relations-assignment'])
    expect(assigned.ok, JSON.stringify(assigned)).toBe(true)
    expect(assigned.result.goal).toMatchObject({ assigneeSessionIds: ['progress-agent', 'peer-agent'], supervisorSessionId: 'progress-agent', sessionIds: ['progress-agent', 'remote/retained-history', 'peer-agent'] })
    expect(writes).toEqual([]); expect(await manager.list()).toEqual([])
    const current = (await demands.get('goal'))!, bytes = await readFile(demands.storePath, 'utf8')
    await expect(mutate('goal.assign', { goalId: 'goal', assigneeSessionIds: [], supervisorSessionId: null, start: false, expectedUpdatedAt: old.updatedAt, operationId: 'stale-relations' })).rejects.toThrow('changed')
    expect(await readFile(demands.storePath, 'utf8')).toBe(bytes)
    await expect(mutate('goal.assign', { goalId: 'goal', assigneeSessionIds: ['peer-agent'], start: false, expectedUpdatedAt: current.updatedAt, operationId: 'dangling-supervisor' })).rejects.toThrow('inconsistent')
    expect(await readFile(demands.storePath, 'utf8')).toBe(bytes)
    const filtered = await run(['goal', 'ls', '--assignee', 'peer-agent', '--supervisor', 'progress-agent'])
    expect(filtered.ok).toBe(true); expect(filtered.result.goals.map((goal: any) => goal.id)).toEqual(['goal'])
    expect((await typed.call('app.snapshot', { include: ['goals'], assigneeSessionId: 'peer-agent', supervisorSessionId: 'progress-agent' })).goals.map(goal => goal.id)).toEqual(['goal'])
    expect((await typed.call('goal.ls', { assigneeSessionId: 'remote/retained-history' })).goals).toEqual([])
    expect((await typed.call('goal.ls', { agentSessionId: 'remote/retained-history' })).goals.map(goal => goal.id)).toEqual(['goal'])
    useAppStore.setState({ selectedDemandId: 'goal', agentNames: { 'progress-agent': 'Original supervisor', 'peer-agent': 'Peer owner' } })
    await act(async () => root.render(<GlobalBoardSurface />))
    const assigneeLine = [...container.querySelectorAll('.goal-collaboration__line')].find(line => line.querySelector('strong')?.textContent === 'Assignees')!
    const assigneeMembers = [...assigneeLine.querySelectorAll<HTMLButtonElement>('.goal-collaboration__member')]
    expect(assigneeMembers.map(member => member.title.split(' · ')[0])).toEqual(['Original supervisor', 'peer-agent'])
    expect(assigneeMembers.map(member => member.title.split('\n')[1])).toEqual(['progress-agent', 'peer-agent'])
    expect(assigneeMembers.map(member => member.disabled)).toEqual([false, true])
    expect(assigneeLine.querySelector('[aria-label="Choose Goal assignees"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Goal assignee"]')).toBeNull()
    await act(async () => (container.querySelector('[aria-label="Goal filters"]') as HTMLButtonElement).click())
    const select = container.querySelector('[aria-label="Filter assignee"]') as HTMLSelectElement
    await act(async () => { select.value = 'peer-agent'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.querySelectorAll('[data-demand-id="goal"]')).toHaveLength(1)
    const handoff = await run(['goal', 'handoff', '--goal', 'goal', '--assignees', '["peer-agent"]', '--clear-supervisor', '--expected-updated-at', String(current.updatedAt), '--operation-id', 'relations-handoff'])
    expect(handoff.ok, JSON.stringify(handoff)).toBe(true)
    expect(handoff.result.goal).toMatchObject({ assigneeSessionIds: ['peer-agent'], supervisorSessionId: null, sessionIds: ['progress-agent', 'remote/retained-history', 'peer-agent'] })
    expect((await typed.call('goal.ls', { assigneeSessionId: 'progress-agent' })).goals).toEqual([])
    expect(writes).toEqual([]); expect(await manager.list()).toEqual([])
    await demands.update('goal', { assigneeSessionIds: ['missing/retained-owner'] }); await useAppStore.getState().refreshDemand('goal')
    await mutate('goal.assign', { goalId: 'goal', assigneeSessionIds: ['missing/retained-owner', 'peer-agent'], start: false, operationId: 'retain-unknown-owner' })
    expect((await demands.get('goal'))!.assigneeSessionIds).toEqual(['missing/retained-owner', 'peer-agent'])
    await expect(mutate('goal.assign', { goalId: 'goal', assigneeSessionIds: ['unknown-new-owner'], start: false, operationId: 'new-unknown-owner' })).rejects.toThrow()
  } finally { await typed.dispose(); await server.stop() }
})

it('origin Supervisor first-default public Source CLI settings and authenticated creation reach the same durable Goal and GUI', async () => {
  const server = new PublicServer({ socketPath: join(directory, 'first-default.sock'), coreClients: () => [{ hostId: 'local', client }], execute: (...args) => bridge.controlOptions.execute(...args) })
  await server.start()
  const typed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: { agentSessionId: session.agentSessionId, capability: activityCapability } })
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))), AGENTMUX_AGENT_SESSION_ID: session.agentSessionId, AGENTMUX_AGENT_CAPABILITY: activityCapability }
  const run = async (args: string[]) => { let reply: any; await act(async () => {
    try { reply = JSON.parse((await promisify(execFile)(process.execPath, [sourceCli, '--endpoint', 'unix:' + server.path, ...args], { env: environment, timeout: 15_000 })).stdout) }
    catch (error) { const output = (error as any).stdout || (error as any).stderr; if (!output) throw error; reply = JSON.parse(output) }
  }); return reply }
  const create = async (id: string) => { const result = await run(['goal', 'create', '--goal', id, '--title', 'Original request', '--risk', 'low', '--confirm', 'user', '--operation-id', id + '-create']); expect(result.ok, JSON.stringify(result)).toBe(true); return result.result.goal }
  try {
    const on = await create('public-on')
    expect(on).toMatchObject({ supervisorSessionId: session.agentSessionId, assigneeSessionIds: [session.agentSessionId], sessionIds: [session.agentSessionId], creationOrigin: { operationId: 'public-on-create', requesterAsSupervisor: true, requesterParticipationId: on.participations[0].id, supervisorDefaultPending: false } })
    const settingOff = await run(['settings', 'set', 'goals.requesterAsSupervisor', 'false']); expect(settingOff.ok, JSON.stringify(settingOff)).toBe(true)
    expect(JSON.parse(await readFile(join(directory, 'original-config.json'), 'utf8')).goals.requesterAsSupervisor).toBe(false)
    const off = await create('public-off')
    expect(off).toMatchObject({ supervisorSessionId: null, assigneeSessionIds: [], sessionIds: [], creationOrigin: { requesterAsSupervisor: false, requesterParticipationId: off.participations[0].id, supervisorDefaultPending: false } })
    expect(off.participations[0]).toMatchObject({ kind: 'create', agentSessionId: session.agentSessionId, hostId: 'local' })
    expect((await run(['settings', 'set', 'goals.requesterAsSupervisor', 'true'])).ok).toBe(true)
    const second = await create('public-second')
    expect(second.supervisorSessionId).toBe(session.agentSessionId)
    expect((await demands.get('public-off'))!.supervisorSessionId).toBeNull()
    expect((await demands.get('goal'))!.creationOrigin).toBeUndefined()
    await expect(typed.call('goal.create', { title: 'body claim', creationOrigin: { requesterAsSupervisor: true } } as any)).rejects.toThrow()
    await act(async () => { await useAppStore.getState().refreshDemand('public-on'); root.render(<GoalDetail demand={{ ...useAppStore.getState().demands['public-on']!, sessions: [], workspacePath: null }} onClose={() => {}} onOpenMote={() => {}} onGrill={() => {}} onGrounding={() => {}} acknowledgementFeedback={EMPTY_GOAL_ACKNOWLEDGEMENT} onAcknowledgementFeedbackChange={() => {}} moteError={null} onRetryMote={() => {}} />) })
    expect(useAppStore.getState().demands['public-on']!.supervisorSessionId).toBe(session.agentSessionId)
    expect(container.textContent).toContain('Original request')
    const source = { kind: 'discussion' as const, agentSessionId: session.agentSessionId, hostId: 'local', entryPoint: 'confirmed-original-PMO' }
    const manual = await demands.create({ id: 'manual-origin', title: 'Manual override' }, { operationId: 'manual-create', creationOrigin: { requesterAsSupervisor: true } })
    await demands.update(manual.demand.id, { supervisorSessionId: null })
    const current = (await demands.get(manual.demand.id))!
    const resolved = await demands.resolveCreationOrigin(current.id, { creationOperationId: 'manual-create', source, sourceOperationId: 'manual-original-source' }, { expectedUpdatedAt: current.updatedAt, allowSupervisorDefault: true })
    expect(resolved.demand).toMatchObject({ supervisorSessionId: null, assigneeSessionIds: [], creationOrigin: { requesterParticipationId: resolved.demand.participations[0]!.id, supervisorDefaultPending: false } })
    const replay = await demands.resolveCreationOrigin(current.id, { creationOperationId: 'manual-create', source, sourceOperationId: 'manual-original-source' }, { expectedUpdatedAt: manual.demand.updatedAt, allowSupervisorDefault: true })
    expect(replay.demand.participations).toEqual(resolved.demand.participations)
    await expect(demands.resolveCreationOrigin('goal', { creationOperationId: 'legacy-no-origin', source, sourceOperationId: 'legacy-source' }, { expectedUpdatedAt: _reshape_fixtureEpoch(0, 0, 1), allowSupervisorDefault: true })).rejects.toThrow('original Goal creation')
    await expect(demands.resolveCreationOrigin(current.id, { creationOperationId: 'manual-create', source: { ...source, kind: 'requirements' }, sourceOperationId: 'later-source' }, { expectedUpdatedAt: current.updatedAt, allowSupervisorDefault: true })).rejects.toThrow('Later requirements')
    const stale = await demands.create({ id: 'stale-origin', title: 'Version protected' }, { operationId: 'stale-create', creationOrigin: { requesterAsSupervisor: true } })
    await demands.update(stale.demand.id, { description: 'A later edit' })
    await expect(demands.resolveCreationOrigin(stale.demand.id, { creationOperationId: 'stale-create', source, sourceOperationId: 'stale-source' }, { expectedUpdatedAt: stale.demand.updatedAt, allowSupervisorDefault: true })).rejects.toThrow('Goal changed')
    expect((await demands.get(stale.demand.id))!.participations).toEqual([])
    expect(writes).toEqual([]); expect(manager.list()).toEqual([])
  } finally { await typed.dispose(); await server.stop() }
})

it('origin Supervisor first-default mapped PMO records only confirmed original input and survives focus, manual and loop changes', async () => {
  const privateRoot = join(directory, 'mapped-private-core'); await mkdir(privateRoot)
  const f = await injectedContextCore(privateRoot, { ...session, providerId: 'traex' })
  runtime.commit({ hosts: [{ id: 'local', config: config.hosts.find(host => host.id === 'local')!, client: f.core, executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  ;(runtime as any).agentSessionStore = f.store
  const originalTarget = await api.sessions.refresh(snapshot.control)
  if (originalTarget.kind !== 'agent') throw new Error('Expected original Agent')
  useAppStore.setState({ sessions: [originalTarget] })
  const make = async (id: string) => { await act(async () => { await useAppStore.getState().createDemand({ id, title: 'Fresh GUI request' }) }); return (await demands.get(id))! }
  const first = await make('mapped-origin')
  const tab = { ...createWorkbenchTab('origin-pmo', { kind: 'agent', phase: 'attached', regionId: 'origin-recipient', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: session.agentSessionId }), topicId: PMO_TEAMS_TOPIC_ID }
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('origin-group', [tab.id]) }, demandPmoTabIds: { [first.id]: tab.id } })
  const submit = runtime.submitPrompt.bind(runtime)
  let release!: () => void
  const wait = vi.spyOn(runtime, 'submitPrompt').mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve }); return submit(...args) })
  let receipt: any
  try {
  await act(async () => { expect(await useAppStore.getState().requestDemandPmoTask(first.id, 'grill', { creationOperationId: first.creationOrigin!.operationId, onReceipt: value => { receipt = value } })).toBe(tab.id) })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect((await demands.get(first.id))!.participations).toEqual([])
  expect((await demands.get(first.id))!.supervisorSessionId).toBeNull()
  expect(receipt.agentSessionId).toBe(session.agentSessionId)
  useAppStore.setState({ tabs: { [tab.id]: { ...tab, layout: { ...tab.layout, activeRegionId: 'unrelated-region' }, regions: { ...tab.regions, 'unrelated-region': { kind: 'agent', phase: 'attached', regionId: 'unrelated-region', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'unrelated-focus' } } } } })
  release()
  await act(async () => { await useAppStore.getState().flushAgentSteerQueue(session.agentSessionId) })
  wait.mockRestore()
  const saved = (await demands.get(first.id))!
  expect(saved.participations, JSON.stringify(useAppStore.getState().agentSteerQueues[session.agentSessionId])).toHaveLength(1)
  expect(saved).toMatchObject({ supervisorSessionId: session.agentSessionId, assigneeSessionIds: [session.agentSessionId], sessionIds: [session.agentSessionId], creationOrigin: { supervisorDefaultPending: false, requesterParticipationId: saved.participations[0]!.id } })
  expect(saved.participations[0]).toMatchObject({ kind: 'discussion', agentSessionId: session.agentSessionId, operationId: await goalPmoOperation({ goalId: first.id, creationOperationId: first.creationOrigin!.operationId }, 'discussion') })
  expect(f.writes).toHaveLength(1)
  const second = await make('mapped-second')
  useAppStore.setState({ tabs: { [tab.id]: tab }, demandPmoTabIds: { ...useAppStore.getState().demandPmoTabIds, [second.id]: tab.id } })
  vi.spyOn(demands, 'resolveCreationOrigin').mockRejectedValueOnce(new Error('Original input confirmed; source observation unavailable'))
  await act(async () => { await useAppStore.getState().requestDemandPmoTask(second.id, 'grill', { creationOperationId: second.creationOrigin!.operationId }); await useAppStore.getState().flushAgentSteerQueue(session.agentSessionId) })
  expect((await demands.get(second.id))!.supervisorSessionId).toBeNull()
  expect(f.writes).toHaveLength(2)
  const originalTimeline = await api.sessions.timeline(originalTarget.control)
  useAppStore.setState({ timelines: { ...useAppStore.getState().timelines, [session.agentSessionId]: originalTimeline }, tabs: { [tab.id]: { ...tab, layout: { ...tab.layout, activeRegionId: 'newer-focus' }, regions: { ...tab.regions, 'newer-focus': { kind: 'agent', phase: 'attached', regionId: 'newer-focus', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'another-recipient' } } } } })
  await act(async () => { await useAppStore.getState().flushAgentSteerQueue(session.agentSessionId) })
  const sourceQueue = useAppStore.getState().agentSteerQueues[session.agentSessionId] ?? []
  expect(sourceQueue).toContainEqual(expect.objectContaining({ goalPmo: { goalId: second.id, creationOperationId: second.creationOrigin!.operationId } }))
  const retainedSource = sourceQueue.find(entry => entry.goalPmo?.goalId === second.id)!
  expect(retainedSource).toMatchObject({ goalPmo: { goalId: second.id, creationOperationId: second.creationOrigin!.operationId } })
  const readonlyRetry = vi.spyOn(runtime, 'submitPrompt')
  await act(async () => { await expect(useAppStore.getState().sendQueuedAgentSteer(session.agentSessionId, retainedSource.operationId)).resolves.toBe('submitted') })
  expect(readonlyRetry).not.toHaveBeenCalled(); readonlyRetry.mockRestore()
  await act(async () => { await useAppStore.getState().requestDemandPmoTask(second.id, 'grill', { creationOperationId: second.creationOrigin!.operationId }) })
  expect((await demands.get(second.id))!.supervisorSessionId).toBe(session.agentSessionId)
  expect(f.writes).toHaveLength(2)
  expect(useAppStore.getState().agentSteerQueues[session.agentSessionId] ?? []).toEqual([])
  // Real Core authority stays canonical while this client has a different presentation ID.
  const presentation = { ...originalTarget, id: 'original-pmo-presentation' }
  const foreignPresentation = { ...presentation, id: 'foreign-pmo-presentation', hostId: 'foreign-host', control: { ...presentation.control, hostId: 'foreign-host' } }
  const aliasTab = { ...useAppStore.getState().tabs[tab.id]!, regions: { ...useAppStore.getState().tabs[tab.id]!.regions,
    'origin-recipient': { ...tab.regions['origin-recipient']!, sessionId: presentation.id } } }
  useAppStore.setState({ sessions: [presentation, foreignPresentation], tabs: { [tab.id]: aliasTab }, agentComposerDrafts: { ...useAppStore.getState().agentComposerDrafts, 'origin-recipient': 'Original independent unsent draft' } })
  const beforeAlias = structuredClone(useAppStore.getState().tabs), beforeInput = [...f.writes]
  let aliasReceipt: any
  await act(async () => { await expect(useAppStore.getState().requestDemandPmoTask(second.id, 'grill', { creationOperationId: second.creationOrigin!.operationId, onReceipt: value => { aliasReceipt = value } })).resolves.toBe(tab.id) })
  expect(aliasReceipt).toEqual({ tabId: tab.id, agentSessionId: originalTarget.control.agentSessionId })
  expect(useAppStore.getState().tabs).toEqual(beforeAlias)
  expect(f.writes).toEqual(beforeInput); expect(f.start).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts['origin-recipient']).toBe('Original independent unsent draft')
  const exactAliasState = useAppStore.getState()
  for (const sessions of [[], [foreignPresentation], [presentation, { ...presentation, id: 'ambiguous-pmo-presentation' }]]) {
    useAppStore.setState({ sessions })
    await act(async () => { await expect(useAppStore.getState().requestDemandPmoTask(second.id, 'grill', { creationOperationId: second.creationOrigin!.operationId })).rejects.toThrow('unconfirmed or ambiguous') })
    expect(useAppStore.getState().tabs).toEqual(beforeAlias); expect(f.writes).toEqual(beforeInput); expect(f.start).not.toHaveBeenCalled()
  }
  useAppStore.setState({ sessions: exactAliasState.sessions, tabs: { [tab.id]: { ...aliasTab, regions: { ...aliasTab.regions,
    duplicate: { ...aliasTab.regions['origin-recipient']!, regionId: 'duplicate' } } } } })
  await act(async () => { await expect(useAppStore.getState().requestDemandPmoTask(second.id, 'grill', { creationOperationId: second.creationOrigin!.operationId })).rejects.toThrow('Region is unconfirmed or ambiguous') })
  expect(f.writes).toEqual(beforeInput); expect(f.start).not.toHaveBeenCalled()
  useAppStore.setState({ sessions: exactAliasState.sessions, tabs: { [tab.id]: { ...aliasTab, layout: { ...aliasTab.layout, activeRegionId: 'origin-recipient' } } } })
  const canonicalServer = new PublicServer({ socketPath: join(directory, 'canonical-pmo.sock'), coreClients: () => [{ hostId: 'local', client: f.core }], execute: (...args) => bridge.controlOptions.execute(...args) })
  await canonicalServer.start()
  const canonicalRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: canonicalServer.path } })
  try {
    let publicReceipt: any
    await act(async () => { publicReceipt = await (canonicalRpc.call as any)('goal.discuss', { goalId: second.id, mode: 'open', operationId: 'original-canonical-public-open' }) })
    expect(publicReceipt.receipt).toMatchObject({ tabId: tab.id, agentSessionId: originalTarget.control.agentSessionId })
    expect(publicReceipt.receipt.agentSessionId).not.toBe(presentation.id)
    expect(useAppStore.getState().tabs[tab.id]!.regions['origin-recipient']).toMatchObject({ kind: 'agent', sessionId: presentation.id })
    expect(useAppStore.getState().agentComposerDrafts['origin-recipient']).toBe('Original independent unsent draft')
    expect(f.writes).toEqual(beforeInput); expect(f.start).not.toHaveBeenCalled()
    expect(f.core.agentSession(originalTarget.control.agentSessionId).run).toEqual(session.run)
    expect(f.core.agentSession(originalTarget.control.agentSessionId).workspacePath).toBe(session.workspacePath)
  } finally { await canonicalRpc.dispose(); await canonicalServer.stop() }
  useAppStore.setState({ sessions: [originalTarget], tabs: { [tab.id]: tab } })
  const manual = await make('mapped-manual')
  await demands.update(manual.id, { supervisorSessionId: null }); await useAppStore.getState().refreshDemand(manual.id)
  const manualTarget = await api.sessions.refresh(originalTarget.control)
  expect(manualTarget).toMatchObject({ kind: 'agent', control: { agentSessionId: originalTarget.control.agentSessionId, run: session.run } })
  useAppStore.setState({ sessions: [manualTarget], tabs: { [tab.id]: tab }, demandPmoTabIds: { ...useAppStore.getState().demandPmoTabIds, [manual.id]: tab.id } })
  await act(async () => { await useAppStore.getState().requestDemandPmoTask(manual.id, 'grill', { creationOperationId: manual.creationOrigin!.operationId }); await useAppStore.getState().flushAgentSteerQueue(session.agentSessionId) })
  expect((await demands.get(manual.id))!.supervisorSessionId).toBeNull(); expect((await demands.get(manual.id))!.participations).toHaveLength(1)
  const loopGoal = await make('loop-origin')
  await demands.update(loopGoal.id, { sessionIds: [session.agentSessionId], alignment: { summary: 'Original frozen scope', criteria: [{ id: 'retained-scope', text: 'Original work remains' }], openQuestions: [] } })
  await demands.confirmAlignment(loopGoal.id, 1)
  const loop = await manager.create({ hostId: 'local', agentSessionId: session.agentSessionId, providerId: session.providerId, workspacePath: session.workspacePath, intervalMs: 60_000, prompt: 'Original frozen scope', taskSource: { kind: 'goal', goalId: loopGoal.id, alignmentRevision: 1 } })
  const before = structuredClone(manager.list())
  const intent = { goalId: loopGoal.id, creationOperationId: loopGoal.creationOrigin!.operationId }, operationId = await goalPmoOperation(intent, 'discussion')
  const refreshed = await api.sessions.refresh(snapshot.control)
  if (refreshed.kind !== 'agent') throw new Error('Expected the original Agent snapshot')
  await f.core.submitAgentPrompt({ agentSessionId: session.agentSessionId, operationId, prompt: 'Original source already submitted', allowUncertainTurn: true, expectedRun: session.run, afterSubmissionId: refreshed.promptSubmissionPredecessor ?? null })
  const reconciled = await api.demands.reconcilePmoInput(intent, snapshot.control, operationId)
  expect(reconciled.demand.supervisorSessionId).toBeNull(); expect(reconciled.demand.participations).toHaveLength(1)
  expect(manager.list()).toEqual(before); expect(manager.list()[0]!.loopId).toBe(loop.loopId)
  expect(f.core.agentSession(session.agentSessionId).run).toEqual(session.run)
  } finally { release?.(); await useAppStore.getState().flushAgentSteerQueue(session.agentSessionId); wait.mockRestore() }
})

it('origin Supervisor first-default real NewGoal PMO creation consumes exact Core receipt despite changed active Region and lost observer receipt', async () => {
  const privateRoot = join(directory, 'origin-private-core'); await mkdir(privateRoot)
  const f = await injectedContextCore(privateRoot)
  config.executors = { 'origin-fixture': { providerId: 'claude', label: 'Private origin fixture', command: _hygiene_fixturePath("private/claude"), args: [], env: {}, injectAgentMuxGuide: false } }
  runtime.commit({ hosts: [{ id: 'local', config: config.hosts.find(host => host.id === 'local')!, client: f.core, executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  ;(runtime as any).agentSessionStore = f.store
  useLauncherState.setState({ executors: { [SCRATCH_WORKSPACE_ID]: 'origin-fixture' } })
  useAppStore.setState({ config, sessions: [], tabs: {}, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('fresh-origin-group') }, activeWorkspaceId: SCRATCH_WORKSPACE_ID, mainSurface: 'board', selectedDemandId: null, demandPmoTabIds: {}, pendingAgentLaunches: {} })
  const scratch = (runtime as any).scratchTopics as ScratchTopics, prepare = scratch.prepareAgent.bind(scratch)
  const invoke = bridge.invoke.getMockImplementation()!
  let lostReceipt = false
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    const result = await invoke(channel, ...values)
    if (channel === 'sessions:launchAgent' && !lostReceipt) { lostReceipt = true; throw new Error('Private Main confirmed; observer receipt lost') }
    return result
  })
  let release!: () => void
  const delayed = vi.spyOn(scratch, 'prepareAgent').mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve }); return prepare(...args) })
  let pending!: Promise<void>
  try {
  await act(async () => { pending = startDirectGoal() })
  await vi.waitFor(() => expect(release, JSON.stringify({ direct: directGoalRequest(), error: useAppStore.getState().error, pending: useAppStore.getState().pendingAgentLaunches, tabs: Object.values(useAppStore.getState().tabs).map(tab=>[tab.topicId,tab.topicPreparation,tab.regions]), executors: useAppStore.getState().config?.executors })).toBeTypeOf('function'))
  const goalId = directGoalRequest()!.id, original = (await demands.get(goalId))!, pendingEntries = Object.entries(useAppStore.getState().pendingAgentLaunches)
  expect(pendingEntries).toHaveLength(1)
  const [reservedId, launch] = pendingEntries[0]!, createOperationId = await goalPmoOperation({ goalId, creationOperationId: original.creationOrigin!.operationId }, 'create')
  expect(launch.request).toMatchObject({ createOperationId, goalPmo: { goalId, creationOperationId: original.creationOrigin!.operationId } })
  expect(reservedId).toBe(await f.core.resolveAgentCreationSessionId(createOperationId))
  expect(original.supervisorSessionId).toBeNull(); expect(original.participations).toEqual([]); expect(f.start).not.toHaveBeenCalled()
  const tabId = useAppStore.getState().demandPmoTabIds[goalId]!, tab = useAppStore.getState().tabs[tabId]!
  useAppStore.setState({ tabs: { [tabId]: { ...tab, layout: { ...tab.layout, activeRegionId: 'fresh-other-region' }, regions: { ...tab.regions, 'fresh-other-region': { kind: 'launcher', regionId: 'fresh-other-region', workspaceId: SCRATCH_WORKSPACE_ID } } } } })
  release(); await act(async () => { await pending }); delayed.mockRestore()
  const saved = (await demands.get(goalId))!
  expect(saved).toMatchObject({ supervisorSessionId: reservedId, assigneeSessionIds: [reservedId], sessionIds: [reservedId], creationOrigin: { requesterParticipationId: saved.participations[0]!.id, supervisorDefaultPending: false } })
  expect(saved.participations[0]).toMatchObject({ kind: 'discussion', agentSessionId: reservedId, hostId: 'local', operationId: createOperationId })
  expect(saved.participations[0]!.mote?.topicId).toBe(PMO_TEAMS_TOPIC_ID)
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.writes).toEqual([]); expect(f.stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs[tabId]!.layout.activeRegionId).toBe('fresh-other-region')
  expect(lostReceipt).toBe(true)
  expect(directGoalRequest()).toMatchObject({ id: goalId, phase: 'pmo', pending: false, creationOperationId: original.creationOrigin!.operationId })
  expect(useAppStore.getState().pendingAgentLaunches[reservedId]!.request?.createOperationId).toBe(createOperationId)
  await act(async () => { await retryDirectGoal() })
  expect(directGoalRequest()).toBeNull()
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.writes).toEqual([])
  expect(Object.values(useAppStore.getState().tabs[tabId]!.regions).find(surface => surface.kind === 'agent' && surface.sessionId === reservedId)).toMatchObject({ kind: 'agent', phase: 'attached', sessionId: reservedId })
  const readback = await api.demands.reconcilePmoCreation({ goalId, creationOperationId: original.creationOrigin!.operationId }, 'local', reservedId, createOperationId)
  expect(readback.demand.participations).toEqual(saved.participations)
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.writes).toEqual([]); expect(manager.list()).toEqual([])
  const stored = (await f.store.load()).map(row => normalizeAgentSession(row)).find(row => row.agentSessionId === reservedId)
  expect(stored?.creation?.createOperationId).toBe(createOperationId)
  await expect(api.demands.reconcilePmoCreation({ goalId, creationOperationId: 'different-goal-create' }, 'local', reservedId, createOperationId)).rejects.toThrow('exact original')
  const intent = { goalId, creationOperationId: original.creationOrigin!.operationId }, before = structuredClone(saved)
  const foreign = bridge.handlers.get('demands:reconcilePmoCreation')!
  await expect(foreign({ sender: { id: -1 } }, intent, 'local', reservedId, createOperationId)).rejects.toThrow('Untrusted')
  expect((await demands.get(goalId))!.participations).toEqual(before.participations)
  } finally { release?.(); await pending; delayed.mockRestore() }
})

it('collaboration original provenance authenticates create and requirements while protecting old identities and first-default eligibility', async () => {
  const server = new PublicServer({ socketPath: join(directory, 'origin.sock'), coreClients: () => [{ hostId: 'local', client }], execute: (...args) => bridge.controlOptions.execute(...args) })
  await server.start()
  const typed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: { agentSessionId: session.agentSessionId, capability: activityCapability } })
  const mutate = async (method: string, params: any) => { let result: any; await act(async () => { result = await (typed.call as any)(method, params) }); return result }
  try {
    const created = await mutate('goal.create', { goalId: 'authored-goal', title: 'Precisely authored request', risk: 'low', confirmation: 'user', assigneeSessionIds: ['progress-agent'], supervisorSessionId: 'progress-agent', operationId: 'original-create-source' })
    expect(created.goal.participations).toMatchObject([{ kind: 'create', agentSessionId: 'progress-agent', hostId: 'local', entryPoint: 'goal.create', operationId: 'original-create-source' }])
    expect(created.goal.participations[0].mote).toBeUndefined(); expect(created.goal.creationOrigin).toEqual({ operationId: 'original-create-source', requesterAsSupervisor: true, requesterParticipationId: created.goal.participations[0].id, supervisorDefaultPending: false })
    const requirements = await mutate('goal.update', { goalId: 'authored-goal', patch: { description: 'Actual clarified requirement' }, expectedUpdatedAt: created.goal.updatedAt, operationId: 'actual-requirements-source' })
    expect(requirements.goal.participations.map((source: any) => [source.kind, source.agentSessionId, source.operationId])).toEqual([['create', 'progress-agent', 'original-create-source'], ['requirements', 'progress-agent', 'actual-requirements-source']])
    const body = { goalId: 'authored-goal', kind: 'requirements', message: 'Original append also records its actual participant', operationId: 'requirements-activity' }
    const first = await mutate('goal.activity.append', body); const replay = await mutate('goal.activity.append', body)
    expect(replay.activity.id).toBe(first.activity.id)
    expect((await demands.get('authored-goal'))!.participations.filter(source => source.operationId === body.operationId)).toHaveLength(1)
    await expect(mutate('goal.create', { goalId: 'spoofed-goal', title: 'Untrusted metadata', participations: created.goal.participations, operationId: 'spoofed-source' })).rejects.toThrow()
    await expect(mutate('goal.update', { goalId: 'authored-goal', patch: { creationOrigin: { requesterAsSupervisor: true } }, operationId: 'spoofed-origin' })).rejects.toThrow()
    await expect(mutate('goal.assign', { goalId: 'authored-goal', assigneeExecutorId: 'codex', start: false, operationId: 'legacy-assignee' })).rejects.toThrow()
    await expect(mutate('goal.create', { title: 'Legacy Executor is not an owner', executorId: 'codex', operationId: 'legacy-create' })).rejects.toThrow()
    const oldSnapshot = JSON.parse(await readFile(demands.storePath, 'utf8'))
    const legacy = oldSnapshot.demands.find((goal: any) => goal.id === 'goal')
    delete legacy.assigneeSessionIds; delete legacy.supervisorSessionId; delete legacy.participations; legacy.executorId = 'retained-provider-config'
    await writeFile(demands.storePath, JSON.stringify(oldSnapshot))
    expect(await demands.get('goal')).toMatchObject({ executorId: 'retained-provider-config', sessionIds: ['progress-agent'], assigneeSessionIds: [], supervisorSessionId: null, participations: [] })
    const trusted = await demands.create({ id: 'eligible-goal', title: 'Internal creation eligibility' }, { operationId: 'eligible-create', creationOrigin: { requesterAsSupervisor: true } })
    expect(trusted.demand.creationOrigin).toMatchObject({ operationId: 'eligible-create', requesterAsSupervisor: true, requesterParticipationId: null, supervisorDefaultPending: true })
    await demands.update('eligible-goal', { supervisorSessionId: null }, { expectedUpdatedAt: trusted.demand.updatedAt })
    expect((await demands.get('eligible-goal'))!.creationOrigin!.supervisorDefaultPending).toBe(false)
    const source = { kind: 'discussion' as const, agentSessionId: 'progress-agent', hostId: 'local', entryPoint: 'confirmed-input' }
    const one = await demands.recordParticipation('eligible-goal', source, { operationId: 'discussion-original' })
    const two = await demands.recordParticipation('eligible-goal', source, { operationId: 'discussion-original', expectedUpdatedAt: trusted.demand.updatedAt })
    expect(two.demand.participations).toEqual(one.demand.participations)
    expect(two.demand.creationOrigin!.supervisorDefaultPending).toBe(false)
    await expect(demands.recordParticipation('eligible-goal', { ...source, hostId: 'foreign-host' }, { operationId: 'discussion-original' })).rejects.toThrow('conflicts')
    await expect(demands.update('eligible-goal', { creationOrigin: {} } as any)).rejects.toThrow('trusted host')
    const output: string[] = [], error: string[] = []
    expect(await runDemandCli(['--root', demands.root, 'assign', '--id', 'goal', '--assignee-session-id', 'progress-agent', '--supervisor-session-id', 'progress-agent'], { stdout: value => output.push(value), stderr: value => error.push(value) })).toBe(0)
    expect(JSON.parse(output[0]).demand).toMatchObject({ executorId: 'retained-provider-config', assigneeSessionIds: ['progress-agent'], supervisorSessionId: 'progress-agent' })
    expect(await runDemandCli(['--root', demands.root, 'create', '--title', 'Not a Session', '--executor-id', 'codex'], { stdout: value => output.push(value), stderr: value => error.push(value) })).toBe(1)
    expect(error).toHaveLength(1)
    const context = { actor: { kind: 'agent' as const, id: 'progress-agent', verified: true }, source: 'explicit-edit', entryPoint: 'goal.create', transport: 'unix', location: { callerSessionId: 'progress-agent', hostId: 'local', callerCwd: _hygiene_fixturePath("precise/source") } }
    const scratch = { readForDirectory: vi.fn().mockResolvedValue({ id: 'exact-mote', identityDirectoryPath: _hygiene_fixturePath("precise/mote") }), read: vi.fn().mockResolvedValue({ kind: 'mote' }) }
    expect(await admittedDemandParticipation(context, 'create', config, scratch as any)).toMatchObject({ agentSessionId: 'progress-agent', hostId: 'local', mote: { workspaceId: '__scratch__', topicId: 'exact-mote', identityDirectoryPath: _hygiene_fixturePath("precise/mote") } })
    scratch.read.mockResolvedValue({ kind: 'topic' }); expect((await admittedDemandParticipation(context, 'create', config, scratch as any))?.mote).toBeUndefined()
    expect(await admittedDemandParticipation({ ...context, actor: { kind: 'agent', id: 'body-claim', verified: false } }, 'create', config, scratch as any)).toBeUndefined()
    expect(await admittedDemandParticipation({ ...context, location: { ...context.location, callerSessionId: 'different-verified-source' } }, 'create', config, scratch as any)).toBeUndefined()
    const admitted = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'admit-op', operation: 'demand.create' as const, title: 'Original', projectId: 'project-original', sessionIds: ['accurate-original'] }
    const input = { title: 'Original', projectId: 'project-original', sessionIds: ['accurate-original'] }
    expect(admittedDemandCreateMatches(admitted, input)).toBe(true)
    expect(admittedDemandCreateMatches(admitted, { ...input, projectId: 'other-project' })).toBe(false)
    expect(admittedDemandCreateMatches(admitted, { ...input, sessionIds: ['body-session'] })).toBe(false)
    const updated = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'update-op', operation: 'demand.update' as const, demandId: 'goal', patch: { description: 'Authored description' }, expectedUpdatedAt: _reshape_fixtureEpoch(0, 0, 7) }
    expect(admittedDemandUpdateMatches(updated, 'goal', { description: 'Authored description' }, 7)).toBe(true)
    expect(admittedDemandUpdateMatches(updated, 'goal', { description: 'Authored description', assigneeSessionIds: ['not-authored'] }, 7)).toBe(false)
    expect(admittedDemandUpdateMatches(updated, 'goal', { description: 'Authored description' }, 8)).toBe(false)
  } finally { await typed.dispose(); await server.stop() }
})

it('collaboration Mobile original controls save exact assignees and Supervisor through the public Main owner', async () => {
  const server = new PublicServer({ socketPath: join(directory, 'phone-relations.sock'), coreClients: () => [{ hostId: 'local', client }], execute: (...args) => bridge.controlOptions.execute(...args) })
  await server.start()
  const typed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: { agentSessionId: session.agentSessionId, capability: activityCapability } })
  const forwardRpc = vi.fn((method: any, params: any) => (typed.call as any)(method, params))
  function Consumer() {
    const goal = useAppStore(state => state.demands.goal)!
    return <MobileGoalActions client={{ forwardRpc } as any} goal={goal as any} visible updated={() => {}} deleted={() => {}} />
  }
  try {
    await act(async () => root.render(<Consumer />))
    const input = container.querySelector('[aria-label="分配 Session IDs"]') as HTMLInputElement
    const supervisor = container.querySelector('[aria-label="Supervisor Session ID"]') as HTMLInputElement
    const enter = async (field: HTMLInputElement, value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) }) }
    await enter(input, 'progress-agent'); await enter(supervisor, 'progress-agent')
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存负责人分配')!.click())
    await vi.waitFor(() => expect(container.textContent).toContain('负责人分配已保存'))
    expect(forwardRpc).toHaveBeenCalledWith('goal.assign', expect.objectContaining({ assigneeSessionIds: ['progress-agent'], supervisorSessionId: 'progress-agent', start: false, expectedUpdatedAt: expect.any(Number) }))
    expect((await demands.get('goal'))!).toMatchObject({ assigneeSessionIds: ['progress-agent'], supervisorSessionId: 'progress-agent', sessionIds: ['progress-agent'] })
    await enter(input, ''); await enter(supervisor, '')
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存交接关系')!.click())
    await vi.waitFor(() => expect(container.textContent).toContain('交接关系已保存'))
    await vi.waitFor(async () => expect((await demands.get('goal'))!.assigneeSessionIds).toEqual([]))
  expect((await demands.get('goal'))!).toMatchObject({ assigneeSessionIds: [], supervisorSessionId: null, sessionIds: ['progress-agent'] })
    expect(forwardRpc.mock.calls.every(([, params]) => !Object.hasOwn(params, 'assigneeExecutorId'))).toBe(true)
    expect(writes).toEqual([]); expect(await manager.list()).toEqual([])
  } finally { await typed.dispose(); await server.stop() }
})

// T009: original MOTE.md file owner → Main snapshot → PMO new-chat → original Core.
import { WorkspaceFiles as MoteOriginWorkspaceFiles } from '../src/main/workspace-files'
import { primaryMoteExecutorChoice, primaryMoteExecutorId } from '../src/renderer/src/lib/primary-mote-executor'
import { executorDetectionKey as moteOriginDetectionKey } from '../src/renderer/src/lib/executor-detection'
async function moteOriginFiles() {
  const workspace = config.workspaces[0]!, topic = await api.scratch.ensureMote(workspace.id, PMO_TEAMS_TOPIC_ID)
  const relativePath = scratchTopicLogicalPath(workspace, topic)!
  expect(relativePath).toBeTruthy()
  const path = relativePath + '/MOTE.md'
  return { workspace, topic, path, save: async (content: string) => {
    const read = await api.files.read(workspace.id, path)
    expect(['deleted', 'read']).toContain(read.status)
    const written = await api.files.write(workspace.id, { path, content, expectedRevision: read.status === 'read' ? read.document.revision : null })
    expect(written.status).toBe('written')
    expect((await api.files.read(workspace.id, path))).toMatchObject({ status: 'read', document: { content } })
    const readback = await api.scratch.readTopic(workspace.id, PMO_TEAMS_TOPIC_ID)
    if (!readback) throw new Error('Expected the original Mote file owner readback')
    return readback
  } }
}
async function moteOriginCore(initial?: AgentMuxStoredAgentSession) {
  const privateRoot = join(directory, 'mote-origin-core'); await mkdir(privateRoot)
  const f = await injectedContextCore(privateRoot, initial)
  config.executors = { 'mote-origin-claude': { providerId: 'claude', label: 'Original saved Mote Agent', command: _hygiene_fixturePath("private/claude"), args: [], env: {}, injectAgentMuxGuide: false },
    'workspace-other': { providerId: 'claude', label: 'Unrelated workspace preference', command: _hygiene_fixturePath("private/other"), args: [], env: {}, injectAgentMuxGuide: false } }
  runtime.commit({ hosts: [{ id: 'local', config: config.hosts.find(host => host.id === 'local')!, client: f.core, executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  ;(runtime as any).agentSessionStore = f.store
  useLauncherState.setState({ executors: { [SCRATCH_WORKSPACE_ID]: 'workspace-other' } })
  useAppStore.setState({ config, sessions: [], tabs: {}, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-origin-group') }, activeWorkspaceId: SCRATCH_WORKSPACE_ID, mainSurface: 'board', selectedDemandId: null, demandPmoTabIds: {}, pendingAgentLaunches: {}, scratchTopicSnapshots: {} })
  return f
}
async function moteOriginGoal(id: string, body = 'Original user demand body') {
  await act(async () => { await useAppStore.getState().createDemand({ id, title: id, description: body }) })
  const original = (await demands.get(id))!
  let tabId!: string
  await act(async () => { tabId = await useAppStore.getState().requestDemandPmoTask(id, 'grill', { creationOperationId: original.creationOrigin!.operationId }) })
  return { original, tab: useAppStore.getState().tabs[tabId]! }
}
it('Mote new-chat origin: actual File/Main/PMO/Core saved config wins across two bots and cold observation', async () => {
  const f = await moteOriginCore(), source = await moteOriginFiles()
  const content = '---\nversion: 1\ndefaults:\n  executorId: mote-origin-claude\n---\nOriginal Mote prose stays.\n'
  const saved = await source.save(content)
  expect(saved.quickMode).toMatchObject({ status: 'saved', defaults: { executorId: 'mote-origin-claude' } })
  const first = await moteOriginGoal('mote-new-one'), second = await moteOriginGoal('mote-new-two')
  expect(f.start).toHaveBeenCalledTimes(2)
  const retained = [first.tab, second.tab].map(tab => Object.values(tab.regions).find(region => region.kind === 'agent')!)
  expect(retained.every(region => region.kind === 'agent')).toBe(true)
  const oldIds = retained.map(region => region.kind === 'agent' ? region.sessionId : '')
  expect(new Set(oldIds).size).toBe(2)
  useAppStore.setState({ scratchTopicSnapshots: {} })
  expect(primaryMoteExecutorId(useAppStore.getState())).toBeUndefined()
  const third = await moteOriginGoal('mote-new-three', 'Third exact request with two healthy bots')
  expect(f.start).toHaveBeenCalledTimes(3)
  const target = Object.values(third.tab.regions).find(region => region.kind === 'agent')!
  if (target.kind !== 'agent') throw new Error('Expected new exact Core Agent')
  const stored = (await f.store.load()).map(row => normalizeAgentSession(row))
  expect(stored).toHaveLength(3)
  expect(stored.map(row => row.executorId)).toEqual(['mote-origin-claude', 'mote-origin-claude', 'mote-origin-claude'])
  const current = stored.find(row => row.agentSessionId === target.sessionId)!
  expect(current.creation).toMatchObject({ createOperationId: await goalPmoOperation({ goalId: third.original.id, creationOperationId: third.original.creationOrigin!.operationId }, 'create'), initialPrompt: 'confirmed' })
  expect(f.start.mock.calls[2]![0].cwd).toBe(current.workspacePath)
  expect(current.workspacePath).toBe(saved.identityDirectoryPath)
  const startInput = f.start.mock.calls[2]![0] as unknown as { program: string; args: string[] }
  expect(startInput.program).toBe(_hygiene_fixturePath("private/claude")); expect(startInput.args.join(' ')).toContain('Third exact request with two healthy bots')
  for (const id of oldIds) expect(f.core.agentSession(id).run).toEqual(stored.find(row => row.agentSessionId === id)!.run)
  expect(f.stop).not.toHaveBeenCalled(); expect(f.writes).toEqual([]); expect(manager.list()).toEqual([])
  expect((await demands.get(third.original.id))!.supervisorSessionId).toBe(target.sessionId)
  expect((await api.files.read(source.workspace.id, source.path))).toMatchObject({ status: 'read', document: { content } })
})
it('Mote new-chat origin: unconfirmed and unsaved multiple bots keep original launcher without guessed identity', async () => {
  const f = await moteOriginCore(), source = await moteOriginFiles()
  const unconfirmed = await source.save('---\nversion: 99\ndefaults:\n  executorId: mote-origin-claude\n---\nKept invalid reference\n')
  expect(unconfirmed.quickMode?.status).toBe('unconfirmed')
  if (unconfirmed.quickMode?.status !== 'unconfirmed') throw new Error('Expected original file diagnosis')
  const first = await moteOriginGoal('mote-file-unknown', 'Kept exact original request')
  expect(f.start).not.toHaveBeenCalled(); expect(f.writes).toEqual([])
  expect(Object.values(first.tab.regions)).toMatchObject([{ kind: 'launcher' }])
  expect(useAppStore.getState().agentComposerDrafts[first.tab.layout.activeRegionId]).toBe('Clarify goal')
  expect(useAppStore.getState().error).toContain(unconfirmed.quickMode.message)
  expect((await demands.get(first.original.id))!.creationOrigin).toMatchObject({ requesterParticipationId: null, supervisorDefaultPending: true })
  const saved = await source.save('---\nversion: 1\ndefaults:\n  executorId: mote-origin-claude\n---\n')
  useAppStore.setState({ scratchTopicSnapshots: { [source.workspace.id]: { scope: scratchTopicsScope(source.workspace), revision: 1, topics: [saved], error: null, reading: false } } })
  await act(async () => { await useAppStore.getState().requestDemandPmoTask(first.original.id, 'grill', { creationOperationId: first.original.creationOrigin!.operationId }) })
  expect(f.start).toHaveBeenCalledTimes(1)
  await moteOriginGoal('mote-known-second')
  expect(f.start).toHaveBeenCalledTimes(2)
  const noDefault = await source.save('---\nversion: 1\ndefaults: {}\n---\nOriginal Mote without a saved executor.\n')
  expect(noDefault.quickMode).toMatchObject({ status: 'saved', defaults: {} })
  useAppStore.setState({ scratchTopicSnapshots: { [source.workspace.id]: { scope: scratchTopicsScope(source.workspace), revision: 2, topics: [noDefault], error: null, reading: false } } })
  const before = (await f.store.load()).map(row => normalizeAgentSession(row))
  const blocked = await moteOriginGoal('mote-two-unsaved')
  expect(f.start).toHaveBeenCalledTimes(2); expect(Object.values(blocked.tab.regions)).toMatchObject([{ kind: 'launcher' }])
  expect((await f.store.load()).map(row => normalizeAgentSession(row))).toEqual(before)
  expect(primaryMoteExecutorId(useAppStore.getState())).toBeUndefined()
  expect(f.stop).not.toHaveBeenCalled(); expect(manager.list()).toEqual([])
})
it('Mote new-chat origin: exact Host validation and mapped Core Session survive another new-chat default and unknown file', async () => {
  const f = await moteOriginCore({ ...session, providerId: 'traex' }), source = await moteOriginFiles()
  const saved = await source.save('---\nversion: 1\ndefaults:\n  executorId: mote-origin-claude\n---\n')
  const remote = { id: 'mote-remote', label: 'Exact remote', kind: 'ssh' as const, hostname: 'private-remote', user: 'private', port: 22 }
  const state = useAppStore.getState(), remoteWorkspace = { ...source.workspace, hostId: remote.id }
  const remoteState = { ...state, config: { ...config, hosts: [...config.hosts, remote], workspaces: [remoteWorkspace] },
    scratchTopicSnapshots: { [source.workspace.id]: { scope: scratchTopicsScope(remoteWorkspace), revision: 3, topics: [saved], error: null, reading: false } }, hostExecutorInventories: {} }
  expect(primaryMoteExecutorChoice(remoteState as typeof state)).toMatchObject({ issue: expect.stringContaining('mote-remote') })
  expect(primaryMoteExecutorId(remoteState as typeof state)).toBeUndefined()
  // A local config with the same ID is not metadata from this remote Host.
  const localHost = config.hosts.find(host => host.id === 'local')!
  const detectionKey = moteOriginDetectionKey('local', 'mote-origin-claude')
  const wrongInventory = { ...remoteState, hostExecutorInventories: { [remote.id]: { input: localHost, state: 'ready', result: { executors: [{ executorId: 'mote-origin-claude', providerId: 'claude', label: 'Wrong Host', command: _hygiene_fixturePath("private/claude"), configRevision: 'wrong-host', availability: 'available' }] } } }, executorDetections: { ...state.executorDetections, [detectionKey]: { state: 'ready', input: { executorId: 'mote-origin-claude', providerId: 'claude', command: _hygiene_fixturePath("private/claude"), host: localHost } } } }
  expect(primaryMoteExecutorId(wrongInventory as unknown as typeof state)).toBeUndefined()
  useAppStore.setState({ executorDetections: { [detectionKey]: { state: 'missing', input: { executorId: 'mote-origin-claude', providerId: 'claude', command: _hygiene_fixturePath("private/claude"), host: localHost } } } })
  const missing = await moteOriginGoal('mote-saved-unavailable')
  expect(f.start).not.toHaveBeenCalled(); expect(Object.values(missing.tab.regions)).toMatchObject([{ kind: 'launcher' }])
  expect(useAppStore.getState().error).toContain('mote-origin-claude')
  expect(f.core.agentSession(session.agentSessionId).run).toEqual(session.run)
  useAppStore.setState({ executorDetections: {} })
  const original = await api.sessions.refresh(snapshot.control)
  if (original.kind !== 'agent') throw new Error('Expected original mapped Core Session')
  const tab = { ...createWorkbenchTab('mote-mapped-tab', { kind: 'agent', phase: 'attached', regionId: 'mote-mapped-region', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: original.id }), topicId: PMO_TEAMS_TOPIC_ID }
  await act(async () => { await useAppStore.getState().createDemand({ id: 'mote-mapped', title: 'Mapped original demand' }) })
  const goal = (await demands.get('mote-mapped'))!
  useAppStore.setState({ sessions: [original], tabs: { [tab.id]: tab }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-mapped-group', [tab.id]) }, demandPmoTabIds: { [goal.id]: tab.id } })
  const unknown = await source.save('---\nversion: 999\n---\nExisting Agent remains healthy\n')
  useAppStore.setState({ scratchTopicSnapshots: { [source.workspace.id]: { scope: scratchTopicsScope(source.workspace), revision: 4, topics: [unknown], error: null, reading: false } } })
  await act(async () => { await useAppStore.getState().requestDemandPmoTask(goal.id, 'grill', { creationOperationId: goal.creationOrigin!.operationId }); await useAppStore.getState().flushAgentSteerQueue(original.id) })
  expect(f.start).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(1); expect(f.writes[0]).toContain('Clarify goal'); expect(f.writes[0]).toContain('Mapped original demand')
  expect(f.core.agentSession(original.id).run).toEqual(session.run)
  expect(f.core.agentSession(original.id).workspacePath).toBe(session.workspacePath)
  expect((await demands.get(goal.id))!.supervisorSessionId).toBe(original.id)
  expect(Object.values(useAppStore.getState().tabs[tab.id]!.regions)).toMatchObject([{ kind: 'agent', sessionId: original.id }])
  expect(f.stop).not.toHaveBeenCalled(); expect(manager.list()).toEqual([])
})

// T003: actual Goal detail/picker → original Store/preload/Main → original Core creation.
import { chooseField } from './helpers/selection-field'
import { GoalAgentPicker } from '../src/renderer/src/components/GoalAgentPicker'
import { goalAgentRows, goalCreationDraftKey, restoredGoalAgentCreationDrafts, restoredGoalAgentSelectionDrafts } from '../src/renderer/src/lib/goal-agent-selection'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'
import { scratchTopicIdentityPath } from '../src/shared/scratch-topics'
function PickerDetail() {
  const demand = useAppStore(state => state.demands.goal)!
  return <GoalDetail demand={{ ...demand, sessions: [], workspacePath: null }} onClose={() => {}} onOpenMote={() => {}} onGrill={() => {}} onGrounding={() => {}} acknowledgementFeedback={EMPTY_GOAL_ACKNOWLEDGEMENT} onAcknowledgementFeedbackChange={() => {}} moteError={null} onRetryMote={() => {}} />
}
async function pickerButton(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === label || button.textContent?.trim() === label)
  expect(node, label).toBeDefined(); await act(async () => node!.click()); return node!
}
async function pickerCore() {
  const privateRoot = join(directory, 'picker-private-core'); await mkdir(privateRoot)
  const f = await injectedContextCore(privateRoot, session)
  config.executors = { 'picker-fixture': { providerId: 'claude', label: 'Private picker fixture', command: _hygiene_fixturePath("private/claude"), args: [], env: {}, injectAgentMuxGuide: false } }
  runtime.commit({ hosts: [{ id: 'local', config: config.hosts.find(host => host.id === 'local')!, client: f.core, executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  ;(runtime as any).agentSessionStore = f.store
  useAppStore.setState({ config })
  return f
}
it('Demand picker: common properties and accurate names are in the actual body; source participants rank before Project without changing roles', async () => {
  const workspace = { id: 'picker-project', name: 'Registered Project', hostId: 'local', path: join(directory, 'project'), kind: 'folder' as const }
  const source = { ...snapshot, id: 'source-view', label: 'Source label', control: { ...snapshot.control, agentSessionId: 'accurate-source' } }, project = { ...snapshot, id: 'project-view', label: 'Project Agent', workspacePath: workspace.path, control: { ...snapshot.control, agentSessionId: 'project-agent' } }
  const demand = { ...useAppStore.getState().demands.goal!, sessions: [], workspacePath: null, projectId: workspaceProjectId(workspace), sessionIds: [], assigneeSessionIds: [], supervisorSessionId: null,
    participations: [{ id: 'source-record', operationId: 'origin-op', recordedAt: _reshape_fixtureEpoch(0, 0, 1), kind: 'create' as const, agentSessionId: 'accurate-source', hostId: 'local', entryPoint: 'goal.create' }] }
  const rows = goalAgentRows({ ...useAppStore.getState(), config: { ...config, workspaces: [...config.workspaces, workspace] }, sessions: [project, source], agentNames: { 'source-view': 'Named requester' } }, demand, ['unavailable-original'])
  expect(rows.map(row => row.id)).toEqual(['accurate-source', 'project-agent', 'unavailable-original'])
  expect(rows[0]).toMatchObject({ name: 'Named requester', participated: true, related: false, selectable: true }); expect(demand.sessionIds).toEqual([])
  useAppStore.setState({ sessions: useAppStore.getState().sessions.map(item => item.id === session.agentSessionId ? { ...item, id: 'local:original-presentation' } : item), agentNames: { 'local:original-presentation': 'Named original colleague' } })
  await act(async () => root.render(<PickerDetail />))
  expect(container.querySelector('.goals-common-properties')).not.toBeNull()
  expect(container.querySelector('.goals-common-properties')!.compareDocumentPosition(container.querySelector('.goals-intent-body') ?? container.querySelector('.goals-alignment')!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(container.querySelector('.goal-collaboration')).not.toBeNull(); expect(container.querySelector('.goals-execution')).toBeNull()
  await pickerButton('Choose Goal assignees')
  expect(document.querySelector(`[data-session-id="${session.agentSessionId}"]`)?.textContent).toContain('Named original colleague')
  expect(document.querySelector<HTMLInputElement>(`[data-session-id="${session.agentSessionId}"] input`)!.checked).toBe(true)
  await pickerButton('Save relationships')
  await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker')).toBeNull())
  expect((await demands.get('goal'))!.assigneeSessionIds).toEqual([session.agentSessionId])
  await pickerButton('Choose Goal assignees')
  expect(document.querySelector('input[aria-label="Search Agents"]')).not.toBeNull()
  expect(writes).toEqual([]); expect(manager.list()).toEqual([])
})
it('Demand picker: retained multiselect and opening CAS survive remount and conflict cannot escape through the global retry', async () => {
  const f = await pickerCore(), second = await f.core.createAgent({ providerId: 'claude', executorId: 'picker-fixture', workspacePath: snapshot.workspacePath, injectAgentMuxGuide: false })
  useAppStore.setState({ sessions: (await runtime.snapshot(config)).sessions })
  await act(async () => root.render(<PickerDetail />)); await pickerButton('Choose Goal assignees')
  const opening = (await demands.get('goal'))!.updatedAt
  await act(async () => document.querySelector<HTMLInputElement>(`[data-session-id="${second.agentSessionId}"] input`)!.click())
  expect(useAppStore.getState().goalAgentSelectionDrafts[goalCreationDraftKey('goal', 'assignees')]!.selected).toEqual([session.agentSessionId, second.agentSessionId])
  await pickerButton('Cancel'); await pickerButton('Choose Goal assignees')
  for (const id of [session.agentSessionId, second.agentSessionId]) expect(document.querySelector<HTMLInputElement>(`[data-session-id="${id}"] input`)!.checked).toBe(true)
  await act(async () => document.querySelector<HTMLInputElement>(`[data-session-id="${second.agentSessionId}"] input`)!.click())
  // Retained identities stay explicit even when unavailable; removing the sole Supervisor needs explicit clear.
  await act(async () => document.querySelector<HTMLInputElement>(`[data-session-id="${session.agentSessionId}"] input`)!.click())
  await chooseField(document.querySelector<HTMLElement>('[aria-label="Replacement Supervisor"]')!, '')
  const retained = useAppStore.getState().goalAgentSelectionDrafts[goalCreationDraftKey('goal', 'assignees')]!
  expect(retained).toMatchObject({ selected: [], expectedUpdatedAt: opening, replacement: '' })
  const written = JSON.parse(window.localStorage.getItem('agentmux-workbench-v1')!).state
  expect(restoredGoalAgentSelectionDrafts(written.goalAgentSelectionDrafts)).toEqual(useAppStore.getState().goalAgentSelectionDrafts)
  await pickerButton('Cancel')
  await demands.update('goal', { priority: 'urgent' }); await act(async () => useAppStore.getState().refreshDemand('goal'))
  await pickerButton('Choose Goal assignees')
  expect(document.querySelector<HTMLInputElement>(`[data-session-id="${session.agentSessionId}"] input`)!.checked).toBe(false)
  expect(document.querySelector<HTMLElement>('[aria-label="Replacement Supervisor"]')?.dataset.value).toBe('')
  await pickerButton('Save relationships')
  expect((await demands.get('goal'))!.assigneeSessionIds).toEqual([session.agentSessionId]); expect((await demands.get('goal'))!.supervisorSessionId).toBe(session.agentSessionId)
  await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker')?.textContent).toContain('Relationships are not saved'))
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Retry save')).toBe(false)
  await pickerButton('Use current Goal version for this draft'); await pickerButton('Save relationships')
  await vi.waitFor(async () => expect((await demands.get('goal'))!.assigneeSessionIds).toEqual([]))
  expect((await demands.get('goal'))!).toMatchObject({ assigneeSessionIds: [], supervisorSessionId: null, sessionIds: [session.agentSessionId], priority: 'urgent' })
  expect(writes).toEqual([]); expect(manager.list()).toEqual([])
})
it('Demand picker: Mote creation waits on the original owner, freezes one OP, preserves active Region and inspects a lost receipt without recreating or sending', async () => {
  const scope = await exactContentScope(), f = await pickerCore()
  const scratch = (runtime as any).scratchTopics as ScratchTopics, prepare = scratch.prepareAgent.bind(scratch)
  let release!: () => void
  const delayed = vi.spyOn(scratch, 'prepareAgent').mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve }); return prepare(...args) })
  await act(async () => root.render(<PickerDetail />)); await pickerButton('Choose Goal assignees'); await pickerButton('Mote · new Session')
  await chooseField(document.querySelector<HTMLElement>('[aria-label="Mote for new Session"]')!, scope.topic.id)
  await chooseField(document.querySelector<HTMLElement>('[aria-label="New Session Agent configuration"]')!, 'picker-fixture')
  const actual = useAppStore.getState().executeControl, lost = vi.spyOn(useAppStore.getState(), 'executeControl').mockImplementation(async request => {
    const result = await actual(request); if (request.operation === 'agent.open') throw new Error('Original creation acknowledgement lost'); return result
  })
  useAppStore.getState().setAgentComposerDraft(session.agentSessionId, 'Original useful unsent draft')
  const activeBefore = structuredClone(useAppStore.getState().workbenchSpaceSelection), originalTab = structuredClone(useAppStore.getState().tabs['content-tab'])
  expect(activeBefore).toMatchObject({ tabId: 'content-tab', regionId: 'content-region' })
  expect(originalTab?.regions['content-region']).toMatchObject({ kind: 'agent', sessionId: session.agentSessionId })
  await pickerButton('Create Mote Session'); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const draft = useAppStore.getState().goalAgentCreationDrafts[goalCreationDraftKey('goal', 'assignees')]!
  expect(draft).toMatchObject({ phase: 'may-have-dispatched', request: { focus: false, content: { kind: 'new-agent', executorId: 'picker-fixture' } } })
  expect(draft.request.content).not.toHaveProperty('prompt'); expect(draft.request.content).not.toHaveProperty('executionWorkspaceId')
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Close Agent picker"]')!.disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('.goal-agent-picker button[type=submit]')!.disabled).toBe(true)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(lost.mock.calls.filter(([request]) => request.operation === 'space.inspect')).toEqual([])
  expect(f.start).not.toHaveBeenCalled()
  release(); await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker')!.textContent).toContain('acknowledgement lost'))
  const originalPrepared = await delayed.mock.results[0]!.value
  expect(originalPrepared.absolutePath).toBe(scratchTopicIdentityPath(scope.workspace, scope.topic))
  expect(originalPrepared.prompt).toContain('Mote personality from')
  if (scope.topic.wiki?.enabled) expect(originalPrepared.prompt).toContain(scope.topic.wiki.content)
  delayed.mockRestore(); lost.mockRestore()
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(activeBefore)
  expect(useAppStore.getState().tabs['content-tab']).toEqual(originalTab)
  expect(useAppStore.getState().agentComposerDrafts[session.agentSessionId]).toBe('Original useful unsent draft')
  expect(f.start).toHaveBeenCalledTimes(1)
  expect((f.start.mock.calls[0]![0] as any).cwd).toBe(scratchTopicIdentityPath(scope.workspace, scope.topic))
  expect(f.writes).toEqual([]); expect(manager.list()).toEqual([])
  await pickerButton('Cancel'); await pickerButton('Choose Goal assignees')
  await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker')!.textContent).toContain('Original Session observed'))
  const inspected = useAppStore.getState().spatialRequests[draft.operationId]!
  expect(inspected.requestId).toBe(draft.operationId)
  const createdId = inspected.agentSessionId!
  expect(createdId).toBe(await f.core.resolveAgentCreationSessionId(draft.operationId))
  expect(restoredGoalAgentCreationDrafts(JSON.parse(window.localStorage.getItem('agentmux-workbench-v1')!).state.goalAgentCreationDrafts)[goalCreationDraftKey('goal', 'assignees')]?.operationId).toBe(draft.operationId)
  await pickerButton('Save relationships')
  await vi.waitFor(async () => expect((await demands.get('goal'))!.assigneeSessionIds).toEqual([session.agentSessionId, createdId]))
  expect((await demands.get('goal'))!.assigneeSessionIds).toEqual([session.agentSessionId, createdId]); expect((await demands.get('goal'))!.sessionIds).toContain(createdId)
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.writes).toEqual([])
})
it('Demand picker: failed pre-dispatch save retains the exact request and explicit recovery creates one Agent in the chosen directory', async () => {
  const f = await pickerCore(), path = join(directory, 'chosen-project'); await mkdir(path)
  const workspace = { id: 'picker-chosen', name: 'Chosen directory', hostId: 'local', path, kind: 'folder' as const }
  config.workspaces = [...config.workspaces, workspace]; useAppStore.setState({ config, layouts: { ...useAppStore.getState().layouts, [workspace.id]: createWorkspaceLayout('picker-group') } })
  await act(async () => root.render(<PickerDetail />)); await pickerButton('Choose Goal assignees'); await pickerButton('New Agent')
  await chooseField(document.querySelector<HTMLElement>('[aria-label="New Agent execution directory"]')!, workspace.id)
  await chooseField(document.querySelector<HTMLElement>('[aria-label="New Session Agent configuration"]')!, 'picker-fixture')
  const originalWrite = window.localStorage.setItem.bind(window.localStorage)
  const failed = vi.spyOn(window.localStorage, 'setItem').mockImplementation((...args) => { if (args[0] === 'agentmux-workbench-v1') throw new Error('Private pre-dispatch save failed'); return originalWrite(...args) })
  await pickerButton('Create Agent')
  await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker')!.textContent).toContain('Creation has not been dispatched'))
  const draft = useAppStore.getState().goalAgentCreationDrafts[goalCreationDraftKey('goal', 'assignees')]!
  expect(draft.phase).toBe('not-dispatched'); expect(f.start).not.toHaveBeenCalled()
  failed.mockRestore()
  await pickerButton('Cancel'); await pickerButton('Choose Goal assignees')
  expect(f.start).not.toHaveBeenCalled()
  await pickerButton('Save selection and create once')
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker')!.textContent).toContain('Original Session observed'))
  expect((f.start.mock.calls[0]![0] as any).cwd).toBe(path)
  expect(useAppStore.getState().goalAgentCreationDrafts[goalCreationDraftKey('goal', 'assignees')]!.operationId).toBe(draft.operationId)
  expect((await f.core.resolveAgentCreationSessionId(draft.operationId))).toBe(useAppStore.getState().spatialRequests[draft.operationId]!.agentSessionId)
  expect(f.writes).toEqual([]); expect(manager.list()).toEqual([])
})

it('Demand picker: hidden assignee directory does no work for unrelated Session output and Tab observations', async () => {
  const commits = vi.fn()
  await act(async () => root.render(<Profiler id="actual-goal-directory" onRender={commits}><GlobalBoardSurface /></Profiler>))
  await act(async () => useAppStore.getState().setSelectedDemand('goal'))
  await vi.waitFor(() => expect(container.querySelector('.goal-collaboration')).not.toBeNull())
  await vi.waitFor(() => expect(container.textContent).not.toContain('Checking the original continuation'))
  expect(container.querySelector('.goals-filters')).toBeNull()
  const state = useAppStore.getState(), before = commits.mock.calls.length
  expect(before).toBeGreaterThan(0)
  const unrelated = { ...snapshot, id: 'unrelated-renderer-view', control: { ...snapshot.control, agentSessionId: 'unrelated-core-session' }, latestOutputBytes: 900000 }
  await act(async () => useAppStore.setState({ sessions: [...state.sessions, unrelated], tabs: { ...state.tabs } }))
  expect(commits.mock.calls.length).toBe(before)
  expect(container.querySelector('.goal-collaboration')!.textContent).not.toContain('unrelated-core-session')
})
