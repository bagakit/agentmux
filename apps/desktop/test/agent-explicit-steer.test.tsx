// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig } from '../src/shared/contracts'
import type { ConfigStore } from '../src/main/config-store'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null,
  invoke: vi.fn(), handlers: new Map<string, (...args: unknown[]) => unknown>() }))
// Electron transport and unrelated startup services are isolated. The target's Renderer, Store,
// preload, registered IPC, RuntimeController and public Core submission all execute below.
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: AgentMuxPreloadApi) => {
    bridge.api = api; Object.assign(window, { [name]: api })
  } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() },
  webFrame: { getZoomFactor: () => 1 }, app: { getPath: () => '/private-explicit-steer' },
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
import '../src/preload/index'
import { RuntimeController } from '../src/main/runtime-controller'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { useAppStore } from '../src/renderer/src/store'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { composerSession } from './helpers/composer-dom-fixture'

const ID = 'explicit-steer-agent', RUN = `run-${ID}`
const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement, client: AgentMuxClient, runtime: RuntimeController
let disposeIpc: (() => Promise<void>) | undefined
let gates: { resolve(): void }[] = []
let nativeRunId: string
let writes: string[], holdInput: ((data: string) => Promise<void>) | undefined

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
  writes = []; holdInput = undefined; nativeRunId = RUN; gates = []
  const store = new AgentMuxMemoryAgentSessionStore()
  const durable: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: ID, providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: '/private/explicit-steer', run: { runId: RUN }, retiredRuns: [],
    hookBindingId: 'synthetic-binding', hookToken: 'synthetic-token', outputCursorBytes: 100,
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
    return receipt
  }
  vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(120)
  runtime = new RuntimeController(store)
  runtime.commit({ hosts: [{ id: 'local', client,
    executionHost: { kind: 'local', dispose: vi.fn() } as never }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), executors: {
    codex: { providerId: 'codex', label: 'Private', command: '/private/codex', args: [], env: {}, injectAgentMuxGuide: false }
  }, workspaces: [{ id: 'private', name: 'Fixture', hostId: 'local', path: durable.workspacePath, kind: 'folder' }] }
  const sender = Object.assign(new EventEmitter(), { id: 772, isDestroyed: () => false, send: vi.fn(),
    session: { flushStorageData: vi.fn() } })
  disposeIpc = await registerIpc({ window: { webContents: sender } as unknown as BrowserWindow, runtime,
    configStore: { get: async () => config } as unknown as ConfigStore,
    scratchTopics: {} as ScratchTopics, workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    const handler = bridge.handlers.get(channel)
    expect(handler).toBeTypeOf('function')
    return await handler!({ sender } as unknown as IpcMainInvokeEvent, ...values)
  })
  const session = { ...composerSession(ID), workspacePath: durable.workspacePath,
    status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 } }
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
  await disposeIpc?.(); disposeIpc = undefined
  await runtime.dispose()
  useAppStore.setState(initial, true)
  bridge.invoke.mockReset(); vi.restoreAllMocks()
})

it('real Cmd/Ctrl+Enter steers the exact new intent through Main/Core despite an older queue-only head', async () => {
  await draft('ordinary queued message'); await enter(); await settled()
  const ordinary = queue()[0]!
  expect(queue()).toEqual([expect.objectContaining({ text: 'ordinary queued message', status: 'deferred',
    errorCode: 'AGENT_TURN_END_UNCONFIRMED', operationId: ordinary.operationId })])
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
  expect(submits.filter(call => call[2] === 'ordinary queued message').map(call => call[5])).toEqual(Array(4).fill(undefined))
  expect(submits[2]?.[3]).not.toBe(ordinary.operationId)
  expect(client.agentSession(ID).run).toEqual({ runId: RUN })
  expect(client.agentSession(ID).terminalPromptDelivery?.reason).toBe('turn-end-unconfirmed')
  await settled()
  expect(writes).toEqual(['first explicit steer', '\r', 'second explicit steer', '\r'])
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
  const first = { operationId: 'paused-exact-op', runId: RUN, text: 'restored explicit retry', status: 'deferred' as const,
    errorCode: 'AGENT_EXECUTION_NOT_REQUESTED', error: 'Waiting for explicit execution.' }
  const second = { operationId: 'untouched-op', runId: RUN, text: 'other paused message', status: 'deferred' as const,
    errorCode: 'AGENT_EXECUTION_NOT_REQUESTED', error: 'Waiting for explicit execution.' }
  await act(async () => useAppStore.setState({ agentSteerQueues: { [ID]: [first, second] } }))
  const outbox = container.querySelector<HTMLElement>('[role="tab"][id$="-outbox-tab"]')
  expect(outbox).not.toBeNull()
  await act(async () => outbox!.click())
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('.composer-outbox button')]
  const send = buttons.filter(button => button.textContent === 'Send queued message')
  expect(send).toHaveLength(1)
  expect(buttons.map(button => button.textContent)).not.toContain('Send now — turn may still be running')
  await act(async () => send[0]!.click()); await settled()
  expect(writes).toEqual(['restored explicit retry', '\r'])
  expect(queue()).toEqual([second])
  const submits = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')
  expect(submits.map(call => [call[3], call[5]])).toEqual([['paused-exact-op', { allowUncertainTurn: true }]])
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
  expect(queue()).toEqual([expect.objectContaining({ text: 'bare Enter stays queued', operationId: pending[1]!.operationId })])
  await settled()
  expect(writes).toEqual(['explicit only', '\r'])
  expect(queue()).toEqual([expect.objectContaining({ text: 'bare Enter stays queued', errorCode: 'AGENT_TURN_END_UNCONFIRMED' })])
  const submits = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')
  expect(submits.filter(call => call[2] === 'bare Enter stays queued').map(call => call[5])).toEqual([undefined])
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
      terminalPromptReadiness: _readiness, ...rest } = current
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
  expect(queue()).toEqual([expect.objectContaining({ operationId: oldEntry.operationId, runId: RUN, status: 'deferred' })])
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
  const gate = deferred()
  const original = client.submitAgentPrompt.bind(client)
  let first = true
  vi.spyOn(client, 'submitAgentPrompt').mockImplementation(async (...args) => {
    if (first) { first = false; await gate.promise }
    return original(...args)
  })
  await draft('default awaiting explicit choice'); await enter()
  await vi.waitFor(() => expect(client.submitAgentPrompt).toHaveBeenCalledTimes(1))
  const entry = queue()[0]!
  let retry!: Promise<void>
  await act(async () => { retry = useAppStore.getState().sendQueuedAgentSteer(ID, entry.operationId) })
  gate.resolve(); await act(async () => { await retry })
  expect(client.submitAgentPrompt).toHaveBeenCalledTimes(2)
  expect(writes).toEqual(['default awaiting explicit choice', '\r'])
  expect(queue()).toEqual([])
  const submits = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:submitPrompt')
  expect(submits.map(call => [call[3], call[5]])).toEqual([
    [entry.operationId, undefined], [entry.operationId, { allowUncertainTurn: true }]
  ])
})
