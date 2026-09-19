// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, AgentProviderRegistry, defineAgentProvider } from '@agentmux/core'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { ConfigStore } from '../src/main/config-store'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'
import type { AppConfig, RuntimeEvent } from '../src/shared/contracts'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const bridge = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  listeners: new Map<string, Set<(...values: unknown[]) => void>>()
}))
// Isolate native transport/painting and unrelated services, not Core producers, subscription,
// RuntimeController, preload, initialized Store, mounted App or Focus.
vi.mock('electron', () => ({
  app: { getPath: () => '/isolated-flow-diagnostic', dock: { setBadge: vi.fn() } },
  contextBridge: { exposeInMainWorld: (key: string, value: unknown) => Object.assign(window, { [key]: value }) },
  webFrame: { getZoomFactor: () => 1 },
  ipcMain: { handle: (key: string, handler: any) => bridge.handlers.set(key, handler),
    removeHandler: (key: string) => bridge.handlers.delete(key), on: vi.fn(), removeListener: vi.fn() },
  ipcRenderer: {
    async invoke(key: string, ...values: unknown[]) {
      const handler = bridge.handlers.get(key)
      if (!handler) throw new Error(`Missing registered Main handler: ${key}`)
      return await handler({ sender } as unknown as IpcMainInvokeEvent, ...values)
    },
    on(key: string, listener: (...values: unknown[]) => void) {
      const listeners = bridge.listeners.get(key) ?? new Set(); listeners.add(listener); bridge.listeners.set(key, listeners)
    },
    off: (key: string, listener: (...values: unknown[]) => void) => bridge.listeners.get(key)?.delete(listener),
    removeListener: (key: string, listener: (...values: unknown[]) => void) => bridge.listeners.get(key)?.delete(listener), send: vi.fn()
  }, clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} }
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ list: async () => [] }) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ notify: () => ({ status: 'shown', presentation: 'as-requested' }), dispose() {} }) }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-private-terminal /> }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
import '../src/preload/index'
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../src/renderer/src/store'
import { RuntimeController } from '../src/main/runtime-controller'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { SESSION_EVENT_CHANNEL } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { createWorkspaceLayout } from '@agentmux/layout'

const initial = useAppStore.getState()
const ids = ['flow-one', 'flow-two', 'flow-three']
let root: Root, element: HTMLDivElement, dir: string, sender: any
let core: AgentMuxClient, durable: AgentMuxMemoryAgentSessionStore, runtime: RuntimeController, config: AppConfig
let disposeIpc: (() => Promise<void>) | undefined
let events: AgentMuxClientEvent[], wire: RuntimeEvent[], writes: Array<{ runId: string; data: string }>
let records: AgentMuxStoredAgentSession[], kernel: any, semanticTime: number
let runs: Map<string, any>
let beforeDiagnostic: ReturnType<typeof useAppStore.getState>
let stop: ReturnType<typeof vi.fn>, recover: ReturnType<typeof vi.spyOn>
const provider = defineAgentProvider({
  catalog: { ...new AgentProviderRegistry().get('codex').catalog, id: 'flow-fixture', label: 'Flow fixture',
    executable: 'flow-fixture', expectedProcess: 'flow-fixture', hookStrategy: { kind: 'none' },
    readySignal: { kind: 'foreground-process', expectedProcess: 'flow-fixture' } },
  hook: { rules: [{ events: ['FixtureSemanticError'], state: 'error' }],
    eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' } },
  buildArgs: (prompt, args) => [...args, prompt], buildResumeArgs: (_id, _path, prompt, args) => [...args, ...(prompt ? [prompt] : [])]
})
function record(id: string): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: id, providerId: provider.id, executorId: 'fixture', hostId: 'local',
    workspacePath: dir, run: { runId: `run-${id}` }, retiredRuns: [], hookBindingId: `binding-${id}`, hookToken: `token-${id}`,
    createdAt: semanticTime - 10, updatedAt: semanticTime, semanticStatus: { state: 'working', source: 'native-hook', observedAt: semanticTime, stateEnteredAt: semanticTime } }
}
async function settle() { await act(async () => { await new Promise(done => setTimeout(done, 0)) }) }
async function mount() {
  await act(async () => root.render(<App />))
  for (let n = 0; n < 40 && useAppStore.getState().loading; n++) await settle()
  expect(useAppStore.getState().loading).toBe(false)
  await settle()
  expect(element.querySelector('main.main-shell')).not.toBeNull()
  expect(element.querySelector('[aria-label="Focus"]')).not.toBeNull()
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(ids.map(id => `tab-${id}`))
}
function notice() { return element.querySelector('.error-notice') }
function focus() { return element.querySelector('[aria-label="Global execution contexts"]')! }
async function input(data: string) {
  const session = useAppStore.getState().sessions.find(session => session.id === ids[0])!
  await act(async () => api.sessions.write(session.control, data, 'user'))
}
async function produceDiagnostic(id = ids[0]!) {
  const session = core.agentSession(id)
  const fail = vi.spyOn(durable, 'applyTimelineMutation').mockRejectedValueOnce(new Error('Private history save failed'))
  const before = events.length
  await act(async () => core.submitAgentPrompt({ agentSessionId: id, expectedRun: session.run,
    prompt: 'Explicit private request', allowUncertainTurn: true, operationId: `prompt-${events.length}` }))
  fail.mockRestore(); await settle()
  const emitted = events.slice(before).filter(event => event.type === 'agent-error')
  expect(emitted).toHaveLength(1)
  expect(emitted[0]).toMatchObject({ type: 'agent-error', agentSessionId: id,
    code: 'AGENT_TIMELINE_PERSIST_FAILED', message: 'Private history save failed', evidence: { source: 'user', run: session.run } })
  const transported = wire.findLast(event => event.event === emitted[0])!
  expect(transported).toBeDefined()
  return transported
}
async function transport(event: RuntimeEvent) {
  const listeners = bridge.listeners.get(SESSION_EVENT_CHANNEL)
  expect(listeners?.size).toBeGreaterThan(0)
  await act(async () => { for (const listener of listeners!) listener({}, event) }); await settle()
}
function workface() {
  const s = useAppStore.getState()
  return { tabs: s.tabs, layouts: s.layouts, focus: s.agentFocus, drafts: s.agentComposerDrafts, activeWorkspaceId: s.activeWorkspaceId }
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  dir = await mkdtemp(join(tmpdir(), 'amx-flow-diagnostic-'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(dir, 'runtime'));
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(dir, 'runtime', 'state')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(dir, 'messages.ndjson'))
  bridge.handlers.clear(); bridge.listeners.clear(); events = []; wire = []; writes = []
  semanticTime = 1_000
  // A fixed clock gives the mutation and copied control the same freshness inputs.
  vi.spyOn(Date, 'now').mockReturnValue(semanticTime + 1)
  durable = new AgentMuxMemoryAgentSessionStore(); records = ids.map(record)
  for (const session of records) await durable.compareAndSwap(null, session)
  core = new AgentMuxClient({ store: durable, providers: [provider] })
  const inner = core as any; await inner.registry.load('local'); inner.connected = true; kernel = inner.kernel
  runs = new Map(records.map(session => [session.run.runId, {
    runId: session.run.runId, workspacePath: dir, program: 'flow-fixture', args: [], pid: 9000,
    state: { type: 'running' }, cols: 80, rows: 24, acceptedInputBytes: 0, latestOutputBytes: 0, firstAvailableByte: 0
  }]))
  kernel.isConnected = () => true; kernel.identity = () => ({ daemonInstanceId: 'private-flow', buildIdentity: 'fixture', protocolVersion: 18 })
  kernel.list = async () => [...runs.values()]; kernel.status = async (id: string) => runs.get(id)
  kernel.input = async (id: string, operation: any) => {
    const run = runs.get(id)!; writes.push({ runId: id, data: operation.data }); run.acceptedInputBytes = operation.expectedByte + Buffer.byteLength(operation.data)
    return { run, appliedByteRange: { startByte: operation.expectedByte, endByte: run.acceptedInputBytes } }
  }
  kernel.prepareStop = async (runId: string) => ({ daemonInstance: 'private-flow', operationKey: `stop-${runId}`, runId })
  stop = vi.fn(); kernel.stop = stop
  core.onEvent(event => { events.push(event); if (event.type === 'agent-error') beforeDiagnostic = useAppStore.getState() })
  runtime = new RuntimeController(durable, {} as ScratchTopics)
  runtime.commit({ hosts: [{ id: 'local', client: core, executionHost: { kind: 'local', dispose: vi.fn() } as never }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  recover = vi.spyOn(core, 'resumeAgent')
  config = { ...structuredClone(DEFAULT_CONFIG), notifications: { mode: 'off' },
    executors: { fixture: { label: 'Fixture', providerId: provider.id, command: provider.executable, args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'private-workspace', name: 'Private workspace', hostId: 'local', path: dir, kind: 'folder' }] }
  sender = Object.assign(new EventEmitter(), { id: 718, isDestroyed: () => false,
    session: { flushStorageData: vi.fn() }, send: (channel: string, value: RuntimeEvent) => {
      if (channel === SESSION_EVENT_CHANNEL) wire.push(value)
      for (const listener of bridge.listeners.get(channel) ?? []) listener({}, value)
    } })
  disposeIpc = await registerIpc({ window: { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow, runtime,
    configStore: { get: async () => config } as unknown as ConfigStore,
    scratchTopics: { listTopics: async () => [] } as unknown as ScratchTopics,
    workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  const tabs = Object.fromEntries(ids.map(id => [`tab-${id}`, createWorkbenchTab(`tab-${id}`,
    { regionId: `region-${id}`, kind: 'agent', phase: 'attached', sessionId: id, workspaceId: 'private-workspace' })]))
  const layouts = { 'private-workspace': createWorkspaceLayout('private-group', Object.keys(tabs)) }
  useAppStore.setState({ ...initial, loading: true, config: null, mainSurface: 'agents', activeWorkspaceId: 'private-workspace',
    tabs, layouts, restoredWorkbench: projectPersistedWorkbench({ tabs, layouts }),
    agentFocus: { execution: { sessionId: ids[0]!, history: [{ sessionId: ids[0]!, focusedAt: 10 }] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [ids[0]!]: 'Keep this unsent draft' }, sessions: [], timelines: {}, error: null, lastError: null }, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
})
afterEach(async () => {
  if (root) await act(async () => root.unmount()); element?.remove()
  await disposeIpc?.(); disposeIpc = undefined; await runtime.dispose()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

it('shows an actual Core workflow diagnostic without changing authoritative state, clocks, Focus or healthy input', async () => {
  await mount(); await input('before')
  const face = workface()
  expect(useAppStore.getState().sessions).toHaveLength(3)
  expect(focus().textContent).toContain('Working')
  await produceDiagnostic()
  expect(useAppStore.getState().sessions).toBe(beforeDiagnostic.sessions)
  expect(useAppStore.getState().sessions.map(session => session.status.state)).toEqual(['working', 'working', 'working'])
  expect(useAppStore.getState().sessions.map(session => session.status.observedAt)).toEqual([semanticTime, semanticTime, semanticTime])
  expect(useAppStore.getState().sessions.map(session => session.kind === 'agent' && session.agentSessionUpdatedAt)).toEqual(beforeDiagnostic.sessions.map(session => session.kind === 'agent' && session.agentSessionUpdatedAt))
  expect(notice()).not.toBeNull()
  expect(notice()?.getAttribute('role')).toBe('status')
  expect(notice()?.textContent).toContain('AGENT_TIMELINE_PERSIST_FAILED')
  expect(notice()?.textContent).toContain('Private history save failed')
  expect(notice()?.textContent).toContain('working')
  expect(notice()?.textContent).toContain('Check the terminal')
  expect(focus().textContent).not.toContain('Failed')
  expect(workface()).toEqual(face)
  await input('after')
  expect(writes).toEqual([{ runId: 'run-flow-one', data: 'before' }, { runId: 'run-flow-one', data: 'Explicit private request\r' }, { runId: 'run-flow-one', data: 'after' }])
  expect(stop).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it('rejects old Run and wrong Host diagnostics, and presents unconfirmed scope honestly', async () => {
  await mount(); const actual = await produceDiagnostic()
  await act(async () => useAppStore.setState({ error: null, lastError: null, errorNoticeContext: null }))
  const before = useAppStore.getState().sessions
  if (actual.event.type !== 'agent-error') throw new Error('Expected actual Core diagnostic')
  await transport({ ...actual, hostId: 'another-host' })
  expect(notice()).toBeNull()
  await transport({ ...actual, event: { ...actual.event, evidence: { ...actual.event.evidence, run: { runId: 'retired-run' } } } })
  expect(notice()).toBeNull()
  expect(useAppStore.getState().sessions).toBe(before)
  await transport({ ...actual, event: { ...actual.event, evidence: { ...actual.event.evidence, run: undefined } } })
  expect(notice()).not.toBeNull()
  expect(notice()?.textContent).toContain('could not be confirmed')
  expect(useAppStore.getState().sessions).toBe(before)
  await transport({ ...actual, event: { ...actual.event, agentSessionId: undefined } })
  expect(notice()?.textContent).toContain('could not be confirmed')
  expect(notice()?.textContent).toContain('Private history save failed')
  expect(useAppStore.getState().sessions).toBe(before)
})

it('keeps diagnostics visible during membership reconciliation and after its canonical snapshot', async () => {
  await mount()
  const extra = record('flow-four')
  await durable.compareAndSwap(null, extra)
  await (core as any).registry.load('local')
  runs.set(extra.run.runId, { ...runs.get('run-flow-one'), runId: extra.run.runId })
  const snapshot = await runtime.snapshot(config)
  let release!: (value: typeof snapshot) => void
  const pending = new Promise<typeof snapshot>(resolve => { release = resolve })
  const read = vi.spyOn(runtime, 'snapshot').mockReturnValueOnce(pending)
  try {
    await produceDiagnostic(extra.agentSessionId)
    expect(read).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
    await produceDiagnostic()
    expect(notice()).not.toBeNull()
    expect(notice()?.textContent).toContain('AGENT_TIMELINE_PERSIST_FAILED')
    expect(notice()?.textContent).toContain('Agent "Fixture · Private workspace"')
    expect(useAppStore.getState().sessions).toBe(beforeDiagnostic.sessions)
  } finally { await act(async () => release(snapshot)); await settle() }
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual([...ids, extra.agentSessionId])
  expect(useAppStore.getState().sessions.map(session => session.status.state)).toEqual(['working', 'working', 'working', 'working'])
  expect(notice()?.textContent).toContain('Private history save failed')
  expect(focus().textContent).not.toContain('Failed')
  expect(stop).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it('rehydrates the durable workface and initializes again from the same Core facts without a sticky diagnostic state', async () => {
  const snapshots = vi.spyOn(runtime, 'snapshot')
  await mount(); await produceDiagnostic()
  const face = structuredClone(workface())
  const facts = useAppStore.getState().sessions.map(session => ({ id: session.id, control: session.control,
    status: session.status, processState: session.processState, updatedAt: session.kind === 'agent' && session.agentSessionUpdatedAt }))
  prepareRendererUpdate()
  const name = useAppStore.persist.getOptions().name!
  const saved = localStorage.getItem(name)
  expect(saved).not.toBeNull()
  const durableFace = JSON.parse(saved!).state
  expect(Object.keys(durableFace.restoredWorkbench.tabs)).toHaveLength(3)
  expect(durableFace.agentComposerDrafts[ids[0]!]).toBe('Keep this unsent draft')
  expect(durableFace.sessions).toBeUndefined()
  const written = [...writes]
  await act(async () => root.unmount())
  useAppStore.setState({ ...initial, loading: true, config: null }, true)
  vi.mocked(useAppStore.persist.hasHydrated).mockRestore()
  await act(async () => useAppStore.persist.rehydrate())
  expect(localStorage.getItem(name)).toBe(saved)
  expect(useAppStore.getState().restoredWorkbench).toEqual(durableFace.restoredWorkbench)
  root = createRoot(element)
  await mount()
  expect(snapshots).toHaveBeenCalledTimes(2)
  expect(workface()).toEqual(face)
  expect(useAppStore.getState().sessions.map(session => ({ id: session.id, control: session.control,
    status: session.status, processState: session.processState, updatedAt: session.kind === 'agent' && session.agentSessionUpdatedAt }))).toEqual(facts)
  expect(focus().textContent).not.toContain('Failed')
  expect(notice()).toBeNull()
  expect(writes).toEqual(written)
  expect(stop).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it('keeps real semantic errors and Run crashes authoritative while user stops and unknown exits stay honest', async () => {
  await mount()
  await act(async () => (core as any).acceptHookEvent({ receiptId: 'semantic-error', agentSessionId: ids[0],
    runId: 'run-flow-one', providerId: provider.id, eventName: 'FixtureSemanticError',
    payload: { hook_event_name: 'FixtureSemanticError' } }, AbortSignal.timeout(5_000)))
  await settle()
  expect(core.agentSession(ids[0]!).semanticStatus?.state).toBe('error')
  expect(useAppStore.getState().sessions.map(session => session.status.state)).toEqual(['error', 'working', 'working'])
  expect(focus().querySelector(`[data-session-id="${ids[0]}"]`)?.textContent).toContain('Failed')
  // The private native stop acknowledgement arrives while the real Core stop is in flight.
  // Core retirement then removes the stopped Session; the exit must be neutral before that.
  stop.mockImplementationOnce(async () => {
    runs.get('run-flow-two').state = { type: 'exited', code: 0, signal: null }
    ;(core as any).acceptKernelEvent({ type: 'exit', runId: 'run-flow-two',
      state: runs.get('run-flow-two').state, observedAt: Date.now() })
    expect(useAppStore.getState().sessions.find(session => session.id === ids[1])?.status)
      .toMatchObject({ state: 'exited', exitReason: 'user-stopped' })
  })
  await act(async () => {
    runs.get('run-flow-one').state = { type: 'exited', code: 139, signal: 'SIGSEGV' }
    ;(core as any).acceptKernelEvent({ type: 'exit', runId: 'run-flow-one',
      state: runs.get('run-flow-one').state, observedAt: Date.now() })
    await core.stopAgent(ids[1]!, { runId: 'run-flow-two' })
    runs.get('run-flow-three').state = { type: 'exited', code: 0, signal: null }
    ;(core as any).acceptKernelEvent({ type: 'exit', runId: 'run-flow-three',
      state: runs.get('run-flow-three').state, observedAt: Date.now() })
  }); await settle()
  expect(events.filter(event => event.type === 'process-state').map(event => event.exitReason))
    .toEqual(['crashed', 'user-stopped', 'unknown'])
  expect(useAppStore.getState().sessions.map(session => [session.id, session.status.state, session.processState, session.status.exitReason]))
    .toEqual([[ids[0], 'error', 'exited', 'crashed'], [ids[2], 'exited', 'exited', 'unknown']])
  expect(notice()?.getAttribute('role')).toBe('alert')
  expect(notice()?.textContent).toContain('SIGSEGV')
  expect(focus().querySelector(`[data-session-id="${ids[0]}"]`)?.textContent).toContain('Failed')
  expect(focus().querySelector(`[data-session-id="${ids[1]}"]`)).toBeNull()
  expect(focus().querySelector(`[data-session-id="${ids[2]}"]`)?.textContent).not.toContain('Failed')
  expect(writes).toEqual([])
  expect(stop).toHaveBeenCalledTimes(1); expect(recover).not.toHaveBeenCalled()
})

it.each(['before', 'after'])('shows a real output gap %s a Run observation without changing its semantic state', async order => {
  await mount()
  const gap = () => (core as any).acceptKernelEvent({ type: 'gap', runId: 'run-flow-one', latestOutputBytes: 20 })
  const observed = async () => { await core.statusAgent(ids[0]!) }
  await act(async () => { if (order === 'before') gap(); await observed(); if (order === 'after') gap() }); await settle()
  expect(events.filter(event => event.type === 'agent-error').map(event => event.code)).toEqual(['OUTPUT_GAP'])
  expect(notice()).not.toBeNull()
  expect(notice()?.textContent).toContain('CtxMux evicted output')
  expect(useAppStore.getState().sessions.map(session => session.status.state)).toEqual(['working', 'working', 'working'])
  expect(focus().textContent).not.toContain('Failed')
  expect(writes).toEqual([]); expect(stop).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})
