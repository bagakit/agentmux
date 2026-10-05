const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, beforeAll, afterAll, expect, it, vi } from 'vitest'
import { AGENTMUX_AGENT_MESSAGING_GUIDANCE, AgentMuxClient, AgentMuxMemoryAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
import { composeAgentPrompt } from '@agentmux/core/agent-outbound-message'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import type { ConfigStore } from '../src/main/config-store'
import type { WorkspaceFiles } from '../src/main/workspace-files'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(),
  storagePath: '', controlOptions: null as any,
  handlers: new Map<string, (...args: any[]) => any>(), renderer: new Map<string, Set<(...args: any[]) => any>>(),
  main: new Map<string, Set<(...args: any[]) => any>>(), sender: null as any,
  deliver: (channel: string, ...args: any[]) => {}, reply: (channel: string, ...args: any[]) => {} }))
vi.mock('electron', () => ({
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
  webFrame: { getZoomFactor: () => 1 }, app: { getPath: () => bridge.storagePath, getAppPath: () => bridge.storagePath, isPackaged: false },
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
import { CONTROL_REQUEST_CHANNEL } from '../src/shared/contracts'

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
  writes = []; requests = []; observations = []; cursor = 0; now = 0; ended = false
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
  await demands.create({ id: 'goal', title: 'Original useful work', description: 'Complete the original useful result.', sessionIds: [session.agentSessionId], status: 'todo' })
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
  disposeIpc = await registerIpc({ window: { webContents: bridge.sender, isDestroyed: () => false } as unknown as BrowserWindow,
    runtime, progressLoops: manager, demands, configStore: { get: async () => config } as unknown as ConfigStore,
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
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true })
  expect(cleanup.filter(r => r.status === 'rejected')).toEqual([])
})

const request = (operationId = 'original-start') => ({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: operationId, operation: 'demand.start' as const, demandId: 'goal', sessionId: session.agentSessionId, continuation: { intervalMs: 60_000, alignmentRevision: 1 } })
it('original activity public Source CLI authenticates the author and reaches Main owner and the same GoalDetail with recoverable operations', async () => {
  await demands.addActivity('goal', { kind: 'note', message: 'Retained prior evidence', actorId: null, id: 'old-activity', createdAt: 1 })
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
    expect((await execute(process.execPath, [sourceCli, '--skill'], { env: environment })).stdout).toContain('goal activity inspect')
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
    expect(read.result.activity).toContainEqual({ goalId: 'goal', id: 'old-activity', kind: 'note', message: 'Retained prior evidence', actorId: null, createdAt: 1 })
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
    if (failure === 'permission') await (client as any).registry.update(session.agentSessionId, session.run, (current: AgentMuxStoredAgentSession) => ({ ...current, pendingInteraction: { request: { kind: 'permission', id: 'finite-permission', agentSessionId: session.agentSessionId, title: 'Pending human choice', options: [{ id: 'deny', label: 'Deny', kind: 'reject-once' }], evidence: { source: 'native-hook', observedAt: 200, run: session.run } } } }))
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
    expect((await execute(process.execPath, [sourceCli, '--skill'], { env: environment, timeout: 15000 })).stdout).toContain('content provenance')
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
    expect(container.querySelector('[aria-label="Goal assignees"]')?.textContent).toBe('Original supervisor, Peer owner')
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

it('collaboration original provenance authenticates create and requirements while protecting old identities and first-default eligibility', async () => {
  const server = new PublicServer({ socketPath: join(directory, 'origin.sock'), coreClients: () => [{ hostId: 'local', client }], execute: (...args) => bridge.controlOptions.execute(...args) })
  await server.start()
  const typed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: { agentSessionId: session.agentSessionId, capability: activityCapability } })
  const mutate = async (method: string, params: any) => { let result: any; await act(async () => { result = await (typed.call as any)(method, params) }); return result }
  try {
    const created = await mutate('goal.create', { goalId: 'authored-goal', title: 'Precisely authored request', risk: 'low', confirmation: 'user', assigneeSessionIds: ['progress-agent'], supervisorSessionId: 'progress-agent', operationId: 'original-create-source' })
    expect(created.goal.participations).toMatchObject([{ kind: 'create', agentSessionId: 'progress-agent', hostId: 'local', entryPoint: 'goal.create', operationId: 'original-create-source' }])
    expect(created.goal.participations[0].mote).toBeUndefined(); expect(created.goal.creationOrigin).toBeUndefined()
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
    const updated = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'update-op', operation: 'demand.update' as const, demandId: 'goal', patch: { description: 'Authored description' }, expectedUpdatedAt: 7 }
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
    expect((await demands.get('goal'))!).toMatchObject({ assigneeSessionIds: [], supervisorSessionId: null, sessionIds: ['progress-agent'] })
    expect(forwardRpc.mock.calls.every(([, params]) => !Object.hasOwn(params, 'assigneeExecutorId'))).toBe(true)
    expect(writes).toEqual([]); expect(await manager.list()).toEqual([])
  } finally { await typed.dispose(); await server.stop() }
})
