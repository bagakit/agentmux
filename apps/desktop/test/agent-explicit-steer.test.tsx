const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
// Install the actual mocked preload before Source UI helpers read its desktop API.
import '../src/preload/index'
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxClient, AgentMuxError, AgentMuxMemoryAgentSessionStore, agentPromptCondition, issueAgentCapability, hashAgentCapability,
  type AgentMuxControlRequest, type AgentMuxMessageEnvelope, type AgentMuxStoredAgentSession } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig } from '../src/shared/contracts'
import type { ConfigStore } from '../src/main/config-store'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'
import type { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null,
  storageDirectory: _hygiene_fixturePath("private-explicit-steer"), invoke: vi.fn(), handlers: new Map<string, (...args: unknown[]) => unknown>() }))
// Electron transport and unrelated startup services are isolated. The target's Renderer, Store,
// preload, registered IPC, RuntimeController and public Core submission all execute below.
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: AgentMuxPreloadApi) => {
    bridge.api = api; Object.assign(window, { [name]: api })
  } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  webFrame: { getZoomFactor: () => 1 }, app: {
    getPath: () => bridge.storageDirectory, getAppPath: () => resolve(dirname(fileURLToPath(import.meta.url)), '..'), isPackaged: false
  },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => bridge.handlers.set(channel, handler),
    removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} }
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import { RuntimeController } from '../src/main/runtime-controller'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { composerSession } from './helpers/composer-dom-fixture'

const ID = 'explicit-steer-agent', RUN = `run-${ID}`
const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement, client: AgentMuxClient, runtime: RuntimeController
let disposeIpc: (() => Promise<void>) | undefined
let disposeStore: (() => void) | undefined
let gates: { resolve(): void }[] = []
let nativeRunId: string
let writes: string[], holdInput: ((data: string) => Promise<void>) | undefined
let loseSubmitAck: boolean
let privateQueueDirectory: string, capability: string
let immediateCapability: boolean

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  const gate = { promise, resolve }; gates.push(gate); return gate
}
function queue() { return useAppStore.getState().agentSteerQueues[ID] ?? [] }
async function draft(text: string) {
  await act(async () => useAppStore.getState().setAgentComposerDraft(ID, text))
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe(text)
}
async function enter(modifier?: 'metaKey' | 'ctrlKey') {
  const input = container.querySelector<HTMLElement>('[contenteditable="true"]')
  expect(input).not.toBeNull()
  await act(async () => input!.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true, ...(modifier ? { [modifier]: true } : {})
  })))
}
async function settled() {
  await act(async () => { await useAppStore.getState().flushAgentSteerQueue(ID) })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  writes = []; holdInput = undefined; loseSubmitAck = false; nativeRunId = RUN; gates = []
  immediateCapability = false
  privateQueueDirectory = await mkdtemp(join(tmpdir(), 'amx-explicit-steer-'))
  bridge.storageDirectory = privateQueueDirectory
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(privateQueueDirectory, 'messages.ndjson'))
  await mkdir(join(privateQueueDirectory, 'Local Storage', 'leveldb'), { recursive: true })
  capability = issueAgentCapability()
  const store = new AgentMuxMemoryAgentSessionStore()
  const durable: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: ID, providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: _hygiene_fixturePath("private/explicit-steer"), run: { runId: RUN }, retiredRuns: [],
    hookBindingId: 'synthetic-binding', hookToken: 'synthetic-token', capabilityHash: hashAgentCapability(capability),
    createdAt: 1, updatedAt: 1, semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1 }
  }
  await store.compareAndSwap(null, durable)
  client = new AgentMuxClient({ store })
  // A connected private in-memory fixture replaces ctxmux's native facts/receipt boundary. It does
  // not connect a daemon, install hooks, start a provider, or call a model. Core's guard stays real.
  const inner = client as any
  await inner.registry.load('local')
  inner.connected = true
  let cursor = 0
  const nativeRun = () => ({ runId: nativeRunId, lifecycleOperationId: null, program: 'codex', args: [],
    workspacePath: durable.workspacePath, pid: 123, state: { type: 'running' }, cols: 80, rows: 24,
    latestOutputBytes: 100, firstAvailableByte: 0, acceptedInputBytes: cursor })
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'synthetic-daemon' })
  inner.kernel.status = async () => nativeRun()
  const accepted = new Map<string, unknown>()
  inner.kernel.input = async (_runId: string, op: { operationId: string; expectedByte: number; data: string }) => {
    if (accepted.has(op.operationId)) return accepted.get(op.operationId)
    writes.push(op.data)
    await holdInput?.(op.data)
    cursor = op.expectedByte + Buffer.byteLength(op.data)
    const receipt = { run: nativeRun(), appliedByteRange: { startByte: op.expectedByte, endByte: cursor } }
    accepted.set(op.operationId, receipt)
    if (loseSubmitAck && op.data === '\r') { loseSubmitAck = false; throw new Error('Input ACK lost after acceptance') }
    return receipt
  }
  vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(120)
  runtime = new RuntimeController(store, localRuntimeConnector)
  runtime.commit({ hosts: [{ id: 'local', client,
    executionHost: { kind: 'local', dispose: vi.fn() } as never }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), executors: {
    codex: { providerId: 'codex', label: 'Private', command: _hygiene_fixturePath("private/codex"), args: [], env: {}, injectAgentMuxGuide: false }
  }, workspaces: [{ id: 'private', name: 'Fixture', hostId: 'local', path: durable.workspacePath, kind: 'folder' }] }
  const sender = Object.assign(new EventEmitter(), { id: 772, isDestroyed: () => false, send: vi.fn(),
    session: { getStoragePath: () => privateQueueDirectory, flushStorageData: vi.fn() } })
  disposeIpc = await registerIpc({ window: { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow, runtime,
    progressLoops: { subscribe: () => () => {}, pauseTarget: async () => {} } as unknown as ContinuousProgressLoopManager,
    configStore: { get: async () => config } as unknown as ConfigStore,
    scratchTopics: { setNameAudit: vi.fn() } as unknown as ScratchTopics, workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    const handler = bridge.handlers.get(channel)
    expect(handler).toBeTypeOf('function')
    if (channel !== 'sessions:submitPrompt') return await handler!({ sender } as unknown as IpcMainInvokeEvent, ...values)
    try {
      // Electron structured-clones return values but discards custom fields on a rejection.
      return structuredClone(await handler!({ sender } as unknown as IpcMainInvokeEvent, ...values))
    } catch (error) {
      throw new Error(`Error invoking remote method '${channel}': ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  const session = { ...composerSession(ID), workspacePath: durable.workspacePath,
    status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 } }
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  // Existing transport/fence cases use an ordinary Provider capability. Native immediate
  // preparation has its separate complete-frame and actual CLI acceptance fixtures.
  const refresh = api.sessions.refresh
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => {
    const current = await refresh(control)
    if (current.kind !== 'agent') return current
    const {promptExecution:_native,...ordinary}=current.capabilities
    return {...current,capabilities:{...ordinary,...(immediateCapability ? {promptExecution:{immediate:'interrupt-before-input' as const}} : {})}}
  })
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  disposeStore = await useAppStore.getState().initialize()
  useAppStore.setState({ config, sessions: [session], timelines: {}, agentComposerDrafts: {},
    agentSteerQueues: {}, agentSteerInFlight: {}, noticeReadReceipts: {}, error: null })
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<AgentSessionComposer sessionId={ID} />))
})
afterEach(async () => {
  // Bounded fixtures settle every input gate within its test; no native children or live Run exist.
  for (const gate of gates) gate.resolve()
  await settled()
  await act(async () => root.unmount())
  container.remove()
  disposeStore?.(); disposeStore = undefined
  await disposeIpc?.(); disposeIpc = undefined
  await runtime.dispose()
  useAppStore.setState(initial, true)
  bridge.invoke.mockReset(); vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(privateQueueDirectory, { recursive: true, force: true })
})

it('real Cmd/Ctrl+Enter steers the exact new intent through Main/Core despite an older queue-only head', async () => {
  await draft('ordinary queued message'); await enter(); await settled()
  const ordinary = queue()[0]!
  expect(queue(), JSON.stringify(queue())).toEqual([expect.objectContaining({ text: 'ordinary queued message', status: 'queued',
    promptCondition: null, operationId: ordinary.operationId })])
  expect(writes).toEqual([])
  await draft('first explicit steer'); await enter('metaKey'); await settled()
  await draft('second explicit steer'); await enter('ctrlKey'); await settled()
  expect(writes).toEqual(['first explicit steer', '\r', 'second explicit steer', '\r'])
  expect(queue()).toEqual([ordinary])
  const submits = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')
  expect(submits.filter(call => call[2] !== 'ordinary queued message').map(call => [call[2], call[5]])).toEqual([
    ['first explicit steer', { allowUncertainTurn: true }],
    ['second explicit steer', { allowUncertainTurn: true }]
  ])
  expect(submits.filter(call => call[2] === 'ordinary queued message')).toEqual([])
  expect(ordinary.execution).toBeUndefined()
  expect(client.agentSession(ID).run).toEqual({ runId: RUN })
  expect(client.agentSession(ID).terminalPromptDelivery?.reason).toBe('turn-end-unconfirmed')
  await settled()
  expect(writes).toEqual(['first explicit steer', '\r', 'second explicit steer', '\r'])
  // The real Core completion owner makes the ordinary item eligible for its first input.
  await (client as any).registry.update(ID, { runId: RUN }, (current: AgentMuxStoredAgentSession) => ({
    ...current, semanticStatus: { state: 'done', source: 'native-hook', observedAt: Date.now() }, updatedAt: Date.now()
  }))
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local',
    event: { type: 'agent-session', session: client.agentSession(ID) } }))
  await settled()
  expect(writes).toEqual(['first explicit steer', '\r', 'second explicit steer', '\r', 'ordinary queued message', '\r'])
  expect(queue()).toEqual([])
  const ordinaryCalls = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt' && call[2] === ordinary.text)
  expect(ordinaryCalls.map(call => [call[3], call[5]])).toEqual([[ordinary.operationId, undefined]])
})

it('generic immediate capability travels from Cmd+Enter through preload, IPC and Main into the Core Provider plan', async () => {
  immediateCapability = true
  // This case exercises a generic Provider plan, not native transport qualification.
  // The synthetic Run has no actual CLI; the owning qualification tests cover that boundary.
  const providers = (client as any).providers
  const provider = providers.get('codex')
  vi.spyOn(providers, 'get').mockImplementation((id: string) => {
    expect(id).toBe('codex')
    return { ...provider, preparePromptExecutionTransport: undefined }
  })
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(item => item.id === ID
    ? { ...item, capabilities: { ...item.capabilities, promptExecution: { immediate: 'interrupt-before-input' } } } : item) })))
  const prepare = vi.spyOn((client as any).promptSubmission, 'submitInputPlan').mockImplementation(async (...args: any[]) => args[11])
  await draft('one authorized native immediate message'); await enter('metaKey'); await settled()
  expect(prepare).toHaveBeenCalledOnce()
  expect(prepare.mock.calls[0]![4]).toMatchObject({kind:'render-then-submit',prepare:{interrupt:'\x1b',endEvent:'Interrupt'}})
  expect(prepare.mock.calls[0]![12]).toBe('immediate')
  expect(bridge.invoke.mock.calls.find(call=>call[0]==='sessions:submitPrompt')?.[5]).toEqual({allowUncertainTurn:true,execution:'immediate'})
  expect(queue()).toEqual([]);expect(writes).toEqual([])
})

it('ordinary Enter and an old unknown default input do not gain native immediate authorization', async () => {
  immediateCapability = true
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(item => item.id === ID
    ? { ...item, capabilities: { ...item.capabilities, promptExecution: { immediate: 'interrupt-before-input' } } } : item) })))
  const prepare = vi.spyOn((client as any).promptSubmission, 'submitInputPlan').mockImplementation(async (...args: any[]) => args[11])
  await draft('ordinary native queue input'); await enter(); await settled()
  expect(prepare).not.toHaveBeenCalled()
  expect(queue()[0]).toMatchObject({ promptCondition: null })
  expect(queue()[0]!.execution).toBeUndefined()
  await act(async () => {
    useAppStore.setState({agentSteerQueues:{[ID]:[{operationId:'old-unknown-default',text:'original default text',runId:RUN,status:'deferred',promptCondition:{expectedRun:{runId:RUN},afterSubmissionId:null}}]}})
    await useAppStore.getState().sendQueuedAgentSteer(ID,'old-unknown-default')
  })
  expect(prepare.mock.calls.at(-1)![4].prepare).toBeUndefined();expect(prepare.mock.calls.at(-1)![12]).toBeUndefined()
  expect(writes).toEqual([])
})

it('retains multiple exact explicit intents arriving while an earlier real Core receipt is pending', async () => {
  const gate = deferred()
  holdInput = async data => { if (data === 'one pending steer') await gate.promise }
  await draft('one pending steer'); await enter('ctrlKey')
  await vi.waitFor(() => expect(writes).toEqual(['one pending steer']))
  await draft('two pending steer'); await enter('metaKey')
  await draft('three pending steer'); await enter('ctrlKey')
  const pending = queue()
  expect(pending.map(entry => entry.text)).toEqual(['one pending steer', 'two pending steer', 'three pending steer'])
  expect(new Set(pending.map(entry => entry.operationId)).size).toBe(3)
  gate.resolve(); await settled()
  expect(writes).toEqual(['one pending steer', '\r', 'two pending steer', '\r', 'three pending steer', '\r'])
  expect(queue()).toEqual([])
  const submits = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')
  expect(submits.map(call => call[3])).toEqual(pending.map(entry => entry.operationId))
  expect(submits.map(call => call[5])).toEqual(Array(3).fill({ allowUncertainTurn: true }))
})

it('the sole queued Send retries its exact paused operation without an additional Continue action', async () => {
  const first = { operationId: 'paused-exact-op', runId: RUN, text: 'restored explicit retry', status: 'deferred' as const, promptCondition: null,
    awaitingExplicitSend: true as const, error: 'Waiting for explicit execution.' }
  const second = { operationId: 'untouched-op', runId: RUN, text: 'other paused message', status: 'deferred' as const, promptCondition: null,
    awaitingExplicitSend: true as const, error: 'Waiting for explicit execution.' }
  await act(async () => useAppStore.setState({ agentSteerQueues: { [ID]: [first, second] } }))
  const mailbox = container.querySelector('.composer-mailbox')
  expect(mailbox).not.toBeNull()
  const toggle = new Event('toggle'); Object.defineProperty(toggle, 'newState', { value: 'open' })
  await act(async () => mailbox!.dispatchEvent(toggle))
  const outbox = container.querySelector<HTMLElement>('[role="tab"][id$="-outbox-tab"]')
  expect(outbox).not.toBeNull()
  await act(async () => outbox!.click())
  const firstRow = container.querySelector<HTMLButtonElement>('.composer-outbox .composer-mailbox__row')
  expect(firstRow).not.toBeNull()
  await act(async () => firstRow!.click())
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('.composer-outbox__actions button')]
  const send = buttons.filter(button => button.getAttribute('aria-label') === 'Send queued message')
  expect(send).toHaveLength(1)
  expect(buttons.map(button => button.textContent)).not.toContain('Send now — turn may still be running')
  await act(async () => send[0]!.click()); await settled()
  expect(writes).toEqual(['restored explicit retry', '\r'])
  expect(queue()).toEqual([second])
  const submits = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')
  expect(submits.map(call => [call[3], call[5]])).toEqual([['paused-exact-op', { allowUncertainTurn: true }]])
})

it.each(['transport qualification timed out', 'provider has no preparation transport'])('keeps %s through the actual submit IPC and original queued message', async detail => {
  const failure = new AgentMuxError('This send could not finish preparation.', 'AGENT_PROMPT_PREPARATION_FAILED', detail,
    { disposition: 'not_applied', confirmedInputBytes: 0 })
  const submit = vi.spyOn(runtime, 'submitPrompt').mockRejectedValue(failure)
  const condition = agentPromptCondition(client.agentSession(ID))
  const session = useAppStore.getState().sessions[0]!
  if (session.kind !== 'agent') throw new Error('Private Agent fixture missing')
  const control = session.control
  await expect(api.sessions.submitPrompt(control, 'private direct request', 'private-prepare-op', condition)).rejects.toMatchObject({
    code: failure.code, detail, controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 }
  })
  expect(submit).toHaveBeenCalledOnce()
  submit.mockClear()
  const body = `Original preparation message: ${detail}`
  await draft(body); await enter('metaKey'); await settled()
  const original = queue()[0]!
  expect(original, JSON.stringify({queue: queue(), writes, submits: bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt'), draft: useAppStore.getState().agentComposerDrafts[ID]})).toMatchObject({ text: body, runId: RUN,
    promptCondition: condition, errorCode: failure.code, status: 'deferred' })
  expect(original.error).toContain(detail)
  expect(document.body.textContent).toContain('本次准备未完成')
  expect(document.body.textContent).not.toContain('尚未发送，暂无对话位置')
  expect(document.querySelector<HTMLButtonElement>('[aria-label="编辑这条待发消息"]')?.disabled).toBe(true)
  expect(writes).toEqual([])
  await settled(); expect(submit).toHaveBeenCalledOnce()
  // A per-call preparation refusal grants no replay, but keeps the actual ordinary input path.
  await act(async () => { await api.sessions.write(control, 'ordinary terminal input', 'user') })
  expect(writes).toEqual(['ordinary terminal input'])
  expect(queue()).toEqual([original])
})

it('restart pauses authorization while keeping the original unknown operation and its cause', async () => {
  const original = { operationId: 'original-unknown-after-restart', runId: RUN, text: 'keep original unknown body',
    status: 'deferred' as const, promptCondition: agentPromptCondition(client.agentSession(ID)), execution: 'default' as const,
    errorCode: 'CTXMUX_io', error: 'The original submit ACK was lost.' }
  disposeStore?.(); disposeStore = undefined
  useAppStore.setState({ loading: true, agentSteerQueues: { [ID]: [original] } })
  disposeStore = await useAppStore.getState().initialize()
  await settled()
  expect(queue()).toEqual([{ ...original, awaitingExplicitSend: true }])
  expect(writes).toEqual([])
  expect(bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')).toEqual([])
  expect(document.body.textContent).toContain('发送结果待核实')
  expect(useAppStore.getState().agentSteerQueues[ID]![0]!.error).toBe(original.error)
})

it('does not lend explicit authorization to a queue-only message admitted during its receipt', async () => {
  const gate = deferred()
  holdInput = async data => { if (data === 'explicit only') await gate.promise }
  await draft('explicit only'); await enter('metaKey')
  await vi.waitFor(() => expect(writes).toEqual(['explicit only']))
  await draft('bare Enter stays queued'); await enter()
  const pending = queue()
  expect(pending.map(entry => entry.text)).toEqual(['explicit only', 'bare Enter stays queued'])
  gate.resolve(); await settled()
  expect(writes).toEqual(['explicit only', '\r'])
  expect(queue(), JSON.stringify(queue())).toEqual([expect.objectContaining({ text: 'bare Enter stays queued', operationId: pending[1]!.operationId })])
  await settled()
  expect(writes).toEqual(['explicit only', '\r'])
  expect(queue(), JSON.stringify(queue())).toEqual([expect.objectContaining({ text: 'bare Enter stays queued', promptCondition: null, status: 'queued' })])
  const submits = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')
  expect(submits.filter(call => call[2] === 'bare Enter stays queued')).toEqual([])
})

it('retains exact Run and permission boundaries even for explicit input', async () => {
  const session = useAppStore.getState().sessions[0]!
  await act(async () => useAppStore.setState({ sessions: [{ ...session,
    pendingInteraction: { requestId: 'private-permission', kind: 'permission', summary: 'Pending decision',
      options: [{ id: 'allow', label: 'Allow' }], observedAt: 1 } } as never] }))
  await draft('cannot bypass permission'); await enter('ctrlKey'); await settled()
  expect(queue()).toEqual([])
  expect(useAppStore.getState().agentComposerDrafts[ID]).toBe('cannot bypass permission\n')
  await act(async () => { expect(useAppStore.getState().send(ID, 'retained direct intent')).toBe(true) })
  await settled()
  expect(queue().map(entry => entry.text)).toEqual(['retained direct intent'])
  expect(writes).toEqual([])
  expect(bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')).toEqual([])
  const old = queue()[0]!
  await act(async () => useAppStore.setState({ sessions: [{ ...session,
    control: { ...session.control, run: { runId: 'replacement-run' } } } as never] }))
  await act(async () => useAppStore.getState().sendQueuedAgentSteer(ID, old.operationId))
  expect(queue()).toEqual([old])
  expect(writes).toEqual([])
})


it('keeps a newly explicit healthy replacement Run intent when the old pending receipt refuses', async () => {
  const gate = deferred()
  holdInput = async data => { if (data === 'old Run awaiting') { await gate.promise; throw new Error('old Run refused') } }
  await draft('old Run awaiting'); await enter('ctrlKey')
  await vi.waitFor(() => expect(writes).toEqual(['old Run awaiting']))
  const oldEntry = queue()[0]!
  nativeRunId = 'fresh-replacement-run'
  const inner = client as any
  await inner.registry.update(ID, { runId: RUN }, (current: AgentMuxStoredAgentSession) => {
    const { terminalPromptSubmission: _submission, terminalPromptDelivery: _delivery,
      terminalPromptReadiness: _readiness, promptCompletionAdmission: _admission, ...rest } = current
    return { ...rest, run: { runId: nativeRunId }, retiredRuns: [...current.retiredRuns, { runId: RUN }], updatedAt: 2 }
  })
  const session = useAppStore.getState().sessions[0]!
  await act(async () => useAppStore.setState({ sessions: [{ ...session,
    control: { ...session.control, run: { runId: nativeRunId } } } as never] }))
  await draft('new Run explicit'); await enter('metaKey')
  const newEntry = queue()[1]!
  expect(queue().map(entry => [entry.operationId, entry.runId])).toEqual([
    [oldEntry.operationId, RUN], [newEntry.operationId, nativeRunId]
  ])
  gate.resolve(); await settled()
  expect(writes).toEqual(['old Run awaiting', 'new Run explicit', '\r'])
  expect(queue(), JSON.stringify(queue())).toEqual([expect.objectContaining({ operationId: oldEntry.operationId, runId: RUN, status: 'deferred' })])
  const submits = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')
  expect(submits.map(call => [call[1].run.runId, call[3], call[5]])).toEqual([
    [RUN, oldEntry.operationId, { allowUncertainTurn: true }],
    [nativeRunId, newEntry.operationId, { allowUncertainTurn: true }]
  ])
})


it('a synchronous subscriber Send at final in-flight clear starts a live owner rather than losing authorization', async () => {
  let observedInFlight = false, admitted = false
  const release = useAppStore.subscribe(state => {
    if (state.agentSteerInFlight[ID]) observedInFlight = true
    else if (observedInFlight && !admitted) {
      admitted = true
      expect(state.send(ID, 'subscriber explicit steer')).toBe(true)
    }
  })
  try {
    await draft('first finalizing steer'); await enter('metaKey'); await settled()
    await vi.waitFor(() => expect(writes).toEqual(['first finalizing steer', '\r', 'subscriber explicit steer', '\r']))
    await settled()
    expect(admitted).toBe(true)
    expect(queue()).toEqual([])
    const submits = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')
    expect(submits.map(call => [call[2], call[5]])).toEqual([
      ['first finalizing steer', { allowUncertainTurn: true }],
      ['subscriber explicit steer', { allowUncertainTurn: true }]
    ])
  } finally { release() }
})

it('retains a fresh exact authorization arriving during a default Core attempt until its one explicit retry', async () => {
  // A stale running projection permits the first ordinary call; Core still owns its refusal.
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(item =>
    item.id === ID ? { ...item, status: { ...item.status, state: 'running' } } : item) })))
  const refresh = vi.mocked(api.sessions.refresh).getMockImplementation()!
  vi.mocked(api.sessions.refresh).mockImplementation(async control => {
    const fresh = await refresh(control)
    return { ...fresh, status: { ...fresh.status, state: 'running' } }
  })
  const gate = deferred()
  const original = client.submitAgentPrompt.bind(client)
  let first = true
  vi.spyOn(client, 'submitAgentPrompt').mockImplementation(async (...args) => {
    if (first) { first = false; await gate.promise }
    return original(...args)
  })
  await act(async () => expect(useAppStore.getState().enqueueAgentSteer(ID, 'default awaiting explicit choice', undefined, undefined, 'manual')).toBe(true))
  let defaultAttempt!: Promise<void>
  await act(async () => { defaultAttempt = useAppStore.getState().flushAgentSteerQueue(ID) })
  await vi.waitFor(() => expect(client.submitAgentPrompt, JSON.stringify(queue())).toHaveBeenCalledTimes(1))
  const entry = queue()[0]!
  let retry!: Promise<void>
  await act(async () => { retry = useAppStore.getState().sendQueuedAgentSteer(ID, entry.operationId) })
  gate.resolve(); await act(async () => { await defaultAttempt; await retry })
  expect(client.submitAgentPrompt, JSON.stringify({ queue: queue(), calls: bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt'), writes })).toHaveBeenCalledTimes(2)
  expect(writes).toEqual(['default awaiting explicit choice', '\r'])
  expect(queue()).toEqual([])
  const submits = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')
  expect(submits.map(call => [call[3], call[5]])).toEqual([
    [entry.operationId, undefined], [entry.operationId, { allowUncertainTurn: true }]
  ])
})

it('Control send steers its exact message through registered Main and public Core without a turn completion', async () => {
  await draft('first accepted prompt'); await enter('metaKey'); await settled()
  expect(writes).toEqual(['first accepted prompt', '\r'])
  expect(client.agentSession(ID).semanticStatus?.state).toBe('working')
  const message: AgentMuxMessageEnvelope = {
    schema: 'agentmux.a2a.v1', messageId: 'control-exact-message', operationId: 'control-first-request',
    createdAt: 1, sender: { kind: 'agent-session', agentSessionId: ID },
    recipient: { kind: 'agent-session', agentSessionId: ID }, threadId: 'control-thread',
    correlationId: 'control-correlation', replyTo: null, workspaceId: 'private',
    senderSessionId: ID, senderRunId: RUN, recipientSessionId: ID, recipientRunId: RUN,
    body: 'continue this exact work\nkeep the second line'
  }
  const request: AgentMuxControlRequest = {
    schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'control-first-request', operation: 'send',
    target: { kind: 'agent-session', agentSessionId: ID }, text: message.body,
    caller: { agentSessionId: ID, capability }, message, promptCondition: agentPromptCondition(client.agentSession(ID))
  }
  // Core authenticates the real issued capability against the durable Session/Run. No submit method is mocked:
  // Store -> product preload -> registered IPC -> RuntimeController -> public Core all execute.
  const prompt = `[Message from Agent ${ID}]\n${message.body}`
  await act(async () => {
    await expect(useAppStore.getState().executeControl(request)).resolves.toEqual({ operation: 'send', agentSessionId: ID })
  })
  const accepted = ['first accepted prompt', '\r', `\x1b[200~${prompt}\x1b[201~`, '\r']
  expect(writes).toEqual(accepted)
  const session = useAppStore.getState().sessions.find(session => session.id === ID)
  if (session?.kind !== 'agent') throw new Error('The fixture Agent is missing')
  const control = session.control
  const calls = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitMessage' && call[2].envelope.messageId === message.messageId)
  expect(calls).toEqual([['sessions:submitMessage', control, { envelope: message, condition: request.promptCondition,
    caller: { agentSessionId: ID, capability } }]])
  expect(client.agentSession(ID).terminalPromptDelivery).toMatchObject({
    reason: 'turn-end-unconfirmed', submissionId: message.messageId
  })
  expect((await client.sessionTimeline(ID)).items.find(item => item.id === `prompt:${message.messageId}`)).toMatchObject({
    content: prompt, authorAgentSessionId: ID, status: 'complete'
  })

  await act(async () => {
    await expect(useAppStore.getState().executeControl({ ...request, requestId: 'control-replayed-request' })).resolves.toEqual({
      operation: 'send', agentSessionId: ID
    })
  })
  expect(writes).toEqual(accepted)
  await act(async () => {
    await expect(useAppStore.getState().executeControl({ ...request, requestId: 'control-conflicting-request',
      text: 'changed body', message: { ...message, body: 'changed body' }
    })).rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })
  })
  expect(writes).toEqual(accepted)
  await expect(runtime.submitPrompt(control, 'default is still gated', 'control-default', agentPromptCondition(client.agentSession(ID))))
    .rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
  const inputByte = (await client.statusAgent(ID)).run.acceptedInputBytes
  if (inputByte === undefined) throw new Error('The actual fixture input fence is missing')
  await expect(runtime.submitPrompt(control, 'automatic is still gated', 'control-auto', agentPromptCondition(client.agentSession(ID)),
    { completionId: 'not-an-observed-completion', inputByte, isCurrent: () => true, signal: new AbortController().signal },
    { allowUncertainTurn: true }))
    .rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
  expect(writes).toEqual(accepted)
})


it.each([false, true])('real Core receipt preserves a later Composer draft (lost ACK: %s)', async lostAck => {
  const gate = deferred()
  const text = `original exact intent ${lostAck}`
  holdInput = async data => { if (data === text) await gate.promise }
  loseSubmitAck = lostAck
  await draft(text); await enter('metaKey')
  await vi.waitFor(() => expect(writes).toEqual([text]))
  const entry = queue()[0]!
  await draft('later unsent draft')
  gate.resolve(); await settled()
  expect(writes).toEqual([text, '\r'])
  expect(useAppStore.getState().agentComposerDrafts[ID]).toBe('later unsent draft')
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe('later unsent draft')
  if (lostAck) {
    expect(queue()).toEqual([{ ...entry, status: 'deferred', error: expect.stringContaining('Input ACK lost'), errorCode: 'SESSION_INPUT_FAILED' }])
    await act(async () => useAppStore.getState().sendQueuedAgentSteer(ID, entry.operationId))
    expect(writes).toEqual([text, '\r'])
    const calls = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')
    expect(calls.map(call => call[3])).toEqual([entry.operationId, entry.operationId])
  }
  expect(queue()).toEqual([])
  expect(useAppStore.getState().agentComposerDrafts[ID]).toBe('later unsent draft')
  expect(client.agentSession(ID)).toMatchObject({ run: { runId: RUN }, semanticStatus: { state: 'working' } })
})

it('concurrent Renderer calls join the same original operation after its first input has begun', async () => {
  const gate = deferred()
  const body = 'one original operation from two Renderer callers'
  holdInput = async data => { if (data === body) await gate.promise }
  await draft(body); await enter('metaKey')
  await vi.waitFor(() => expect(writes).toEqual([body]))
  const original = structuredClone(queue()[0]!)
  const first = bridge.invoke.mock.calls.find(call => call[0] === 'sessions:submitPrompt')!
  expect(first[3]).toBe(original.operationId)
  let secondSettled = false
  const second = api.sessions.submitPrompt(...first.slice(1) as Parameters<typeof api.sessions.submitPrompt>)
    .finally(() => { secondSettled = true })
  await vi.waitFor(() => expect(bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')).toHaveLength(2))
  expect(secondSettled).toBe(false)
  expect(writes).toEqual([body])
  expect(queue()).toEqual([original])
  expect(client.agentSession(ID).promptCompletionAdmission?.submissionId).toBe(original.operationId)
  await act(async () => { gate.resolve(); await second }); await settled()
  expect(writes).toEqual([body, '\r'])
  const calls = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')
  expect(calls).toEqual([first, first])
  expect(queue()).toEqual([])
  expect(client.agentSession(ID).promptCompletionAdmission?.submissionId).toBe(original.operationId)
})

it('two Renderer consumers preserve their original conditions instead of rebinding the waiting message', async () => {
  const gate = deferred()
  holdInput = async data => { if (data === 'IPC client one') await gate.promise }
  const session = useAppStore.getState().sessions[0]!
  if (session.kind !== 'agent') throw new Error('Missing Agent')
  const condition = agentPromptCondition(client.agentSession(ID))
  const send = (text: string, operationId: string) => api.sessions.submitPrompt(
    session.control, text, operationId, condition, { allowUncertainTurn: true })
  const first = send('IPC client one', 'ipc-one')
  await vi.waitFor(() => expect(writes).toEqual(['IPC client one']))
  const second = send('IPC client two', 'ipc-two').then(() => null, error => error)
  await vi.waitFor(() => expect(bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')).toHaveLength(2))
  expect(writes).toEqual(['IPC client one'])
  gate.resolve(); await first
  expect(await second).toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED', detail: 'unknown' })
  expect(writes).toEqual(['IPC client one', '\r'])
  expect(client.agentSession(ID).promptCompletionAdmission?.submissionId).toBe('ipc-one')
  await api.sessions.submitPrompt(session.control, 'new explicit client two intent', 'ipc-two-new',
    agentPromptCondition(client.agentSession(ID)), { allowUncertainTurn: true })
  expect(writes).toEqual(['IPC client one', '\r', 'new explicit client two intent', '\r'])
  expect(client.agentSession(ID).run).toEqual({ runId: RUN })
  expect(container.querySelector('[contenteditable="true"]')).not.toBeNull()
})


it('Core refuses the final Enter when a new permission arrived during render, retaining the exact outbox and later draft', async () => {
  const gate = deferred(), started = deferred()
  vi.mocked((client as any).screenEvidence.wait).mockImplementationOnce(async () => {
    started.resolve(); await gate.promise; return 120
  })
  await draft('prompt before permission'); await enter('metaKey'); await started.promise
  const entry = queue()[0]!
  await draft('next draft stays editable')
  const pending = { request: {
    kind: 'permission', id: 'late-product-permission', agentSessionId: ID, title: 'Later permission',
    options: [{ id: 'deny', label: 'Deny', kind: 'reject-once' }],
    evidence: { source: 'native-hook', observedAt: 200, run: { runId: RUN }, hookReceiptId: 'late-product-permission' }
  } }
  await (client as any).registry.update(ID, { runId: RUN }, (current: AgentMuxStoredAgentSession) => ({
    ...current, pendingInteraction: pending, updatedAt: Math.max(current.updatedAt, 200)
  }))
  gate.resolve(); await settled()
  expect(writes).toEqual(['prompt before permission'])
  expect(queue()).toEqual([{ ...entry, status: 'deferred', error: 'Answer the pending Agent interaction before submitting another prompt.', errorCode: 'AGENT_INTERACTION_PENDING' }])
  expect(useAppStore.getState().agentComposerDrafts[ID]).toBe('next draft stays editable')
  expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe('next draft stays editable')
  expect(client.agentSession(ID).pendingInteraction).toEqual(pending)
  // The outbox refusal is scoped to Prompt. Original Run and explicit native input remain usable.
  const ack = await client.writeAgent({ agentSessionId: ID, expectedRun: { runId: RUN }, data: 'n\r', source: 'user' })
  expect(ack.runId).toBe(RUN)
  expect(writes).toEqual(['prompt before permission', 'n\r'])
  expect(client.agentSession(ID).pendingInteraction?.request).toEqual(pending.request)
})
