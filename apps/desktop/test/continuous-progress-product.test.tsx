const { fixtureEpoch: _batchFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { testAppDocumentSources } from "./helpers/app-document-fixture"
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterAll, beforeAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENTMUX_AGENT_MESSAGING_ENTRY, AgentMuxClient, AgentMuxMemoryAgentSessionStore, AgentMuxRpcService, type AgentMuxStoredAgentSession } from '@agentmux/core'
import { createHostGoals } from '../../host/src/goals.js'
import { composeAgentPrompt } from '@agentmux/core/agent-outbound-message'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import type { WorkspaceFiles } from '../src/main/workspace-files'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const bridge = vi.hoisted(() => ({  api: null as AgentMuxPreloadApi | null, invoke: vi.fn(),
  storagePath: '',
  handlers: new Map<string, (...args: any[]) => any>(), renderer: new Map<string, Set<(...args: any[]) => any>>(),
  main: new Map<string, Set<(...args: any[]) => any>>(), sender: null as any,
  deliver: (channel: string, ...args: any[]) => {}, reply: (channel: string, ...args: any[]) => {} }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: (name: string, api: AgentMuxPreloadApi) => { bridge.api = api; Object.assign(window, { [name]: api }) } },
  ipcRenderer: { invoke: bridge.invoke,
    on: (channel: string, fn: (...args: any[]) => any) => { const set = bridge.renderer.get(channel) ?? new Set(); set.add(fn); bridge.renderer.set(channel, set) },
    off: (channel: string, fn: (...args: any[]) => any) => bridge.renderer.get(channel)?.delete(fn),
    removeListener: (channel: string, fn: (...args: any[]) => any) => bridge.renderer.get(channel)?.delete(fn),
    send: (channel: string, ...args: any[]) => bridge.reply(channel, ...args) },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => bridge.handlers.set(channel, handler),
    removeHandler: (channel: string) => bridge.handlers.delete(channel),
    on: (channel: string, fn: (...args: any[]) => any) => { const set = bridge.main.get(channel) ?? new Set(); set.add(fn); bridge.main.set(channel, set) },
    off: (channel: string, fn: (...args: any[]) => any) => bridge.main.get(channel)?.delete(fn),
    removeListener: (channel: string, fn: (...args: any[]) => any) => bridge.main.get(channel)?.delete(fn) },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  webFrame: { getZoomFactor: () => 1 }, app: { once: vi.fn(), on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), getPath: () => bridge.storagePath, getAppPath: () => join(process.cwd(), 'apps/desktop'), isPackaged: false },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, safeStorage: {}
}))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class {
  storage = { setConfirmationHandler() {} }
  cookieFiles = { setFileOwner() {}, setConfirmationHandler() {} }
  extensions = { setConfirmationHandler() {} }
  onChange() { return () => {} }
  onEnvironmentApplicationChange() { return () => {} }
  listProfiles() { return [] }
  async initialize() {} async dispose() {}
} }))
vi.mock('@agentmux/browser/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('@agentmux/browser/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { setPresentationWindowOwner() {} async release() {} async flushProfileActivity() {} dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
vi.mock('@agentmux/connectors', async actual => ({ ...await actual<typeof import('@agentmux/connectors')>(), createConnectionServices: async () => ({ connections: { list: async () => [] }, secrets: {}, close: async () => {} }) }))
// Install the actual mocked Electron bridge before transitive renderer consumers load api.
await vi.hoisted(async () => { await import('../src/preload/index') })
import '../src/preload/index'
import { RuntimeController } from '../src/main/runtime-controller'
import { ScratchTopics } from '../src/main/scratch-topics'
import { registerIpc } from '../src/main/ipc'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store'
import { ContinuousProgressLoopManager } from '@agentmux/host/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '@agentmux/host/continuous-progress-loop-store'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { mintObjectId } from '@agentmux/core/object-id'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { checkpointLauncherState, useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { privateTracker } from './helpers/continuous-progress-tracker'
import { NotesStorageOwner } from '../src/main/notes-storage-owner'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'

// Actual Composer → preload → registered Main IPC → public Core service → original Host
// Goal/loop owner → original Core input ingress. Electron, Browser and Native I/O are
// private controlled seams; the Desktop has no independent automatic-input owner.
const initial = useAppStore.getState()
let directory: string, client: AgentMuxClient, runtime: RuntimeController, manager: ContinuousProgressLoopManager
let hostGoals: ReturnType<typeof createHostGoals>
let hostService: AgentMuxRpcService
let disposeIpc: (() => Promise<void>) | undefined, disposeStore: (() => void) | undefined
let root: Root, container: HTMLDivElement, config: AppConfig, session: AgentMuxStoredAgentSession
let writes: string[], cursor: number | null, requests: any[], observations: string[]
let snapshot: Extract<SessionSnapshot, { kind: 'agent' }>, ended: boolean
let notesReady: Promise<unknown>[]
let userStateRoot: string, userState: WorkbenchUserStateStore
// This file retains one Renderer document cache. Its native document therefore
// keeps the same owner across cases, as one real App lifetime does.
beforeAll(async () => {
  userStateRoot = await mkdtemp(join(tmpdir(), 'cp-user-'))
  userState = new WorkbenchUserStateStore(join(userStateRoot, 'user-state.json'))
})
afterAll(async () => { await rm(userStateRoot, { recursive: true, force: true }) })
const initializeNotes = NotesStorageOwner.prototype.initialize
beforeEach(async () => {
  notesReady = []
  vi.spyOn(NotesStorageOwner.prototype, 'initialize').mockImplementation(function (this: NotesStorageOwner) {
    const pending = initializeNotes.call(this); notesReady.push(pending); return pending
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // Short fixture names keep Main's Unix socket within the platform address limit.
  directory = await mkdtemp(join(await realpath(tmpdir()), 'cp-'))
  bridge.storagePath = join(directory, 'chromium')
  await mkdir(join(bridge.storagePath, 'Local Storage', 'leveldb'), { recursive: true })
  await mkdir(join(directory, 'home'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(directory, 'r'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'r', 'state')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(directory, 'messages.ndjson'))
  writes = []; requests = []; observations = []; cursor = 0; ended = false
  const store = new AgentMuxMemoryAgentSessionStore(), timestamp = Date.now()
  session = { kind: 'agent', agentSessionId: 'progress-agent', hostId: 'local', providerId: 'codex', executorId: 'codex',
    workspacePath: directory, run: { runId: 'progress-run' }, retiredRuns: [], createdAt: timestamp, updatedAt: timestamp,
    hookBindingId: 'owned-binding', hookToken: 'owned-token', semanticStatus: { state: 'done', source: 'native-hook',
      observedAt: timestamp, stateEnteredAt: timestamp } }
  await store.compareAndSwap(null, session)
  client = new AgentMuxClient({ store }); const inner = client as any
  inner.connected = true; await inner.registry.load('local')
  // The private Native substrate below is already connected; future-intent admission
  // must use this same Core rather than discover a physical Runtime process.
  vi.spyOn(client, 'connect').mockResolvedValue()
  vi.spyOn(client, 'connectRuntime').mockResolvedValue()
  const projection = () => ({ runId: session.run.runId, lifecycleOperationId: null, program: _hygiene_fixturePath("private/generic-input"), args: [],
    workspacePath: directory, pid: 2345, state: ended ? { type: 'exited', code: 0, signal: null } : { type: 'running' },
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
  // Current public raw/prompt input owns a channel independent from output.
  // The private Native seam keeps the same cursor and bytes through that port.
  inner.kernel.openInput = async () => ({ run: projection(), waitWritable: async () => {},
    input: async (data: string) => {
      if (cursor === null) throw new Error('The original Native cursor is unknown')
      const startByte = cursor; writes.push(data); requests.push({ data }); cursor += Buffer.byteLength(data)
      return { appliedByteRange: { startByte, endByte: cursor } }
    } })
  const originalStatus = client.statusAgent.bind(client)
  vi.spyOn(client, 'statusAgent').mockImplementation(async (...args) => { observations.push(args[0]); return originalStatus(...args) })
  vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(0)
  runtime = new RuntimeController(store, localRuntimeConnector)
  runtime.commit({ hosts: [{ id: 'local', config: { id: 'local', name: 'Private local', kind: 'local' }, client, executionHost: { kind: 'local', dispose: vi.fn() } as never }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  config = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: [] }, workspaces: [{ id: '__scratch__', name: 'Owned topics', hostId: 'local', path: directory, kind: 'folder' }] }
  hostGoals = createHostGoals({ configurationPath: join(directory, 'config.json'), projects: async () => [],
    runtime: () => ({ client, ownerIdentity: () => ({ ownerInstanceId: 'original-progress-owner' }) }) as never,
    coreCall: (hostId, method, params, context) => { expect(hostId).toBe('local'); return hostService.call(method, params, context) } })
  manager = hostGoals.schedules; await manager.start()
  hostService = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client }], goalControl: hostGoals.execute, goalChanges: hostGoals.goalChanges,
    progress: hostGoals.progress, schedules: hostGoals.schedules, automaticInput: hostGoals.automaticInput })
  const originalCore = runtime.callOriginalCore.bind(runtime)
  vi.spyOn(runtime, 'callOriginalCore').mockImplementation((hostId, method, params, context) => {
    if (method === 'runtime.owner.identity') return Promise.resolve({ owner: { ownerInstanceId: 'original-progress-owner' } }) as never
    if (method.startsWith('goal.') || method.startsWith('schedule.') || method.startsWith('agent.progress.') || method.startsWith('agent.automation.')) return hostService.call(method, params, context)
    return originalCore(hostId, method, params, context)
  })
  bridge.sender = Object.assign(new EventEmitter(), { id: 7891, isDestroyed: () => false,
    send: (channel: string, ...args: any[]) => bridge.deliver(channel, ...args), session: { flushStorageData: vi.fn(), getStoragePath: () => bridge.storagePath } })
  bridge.deliver = (channel, ...args) => {
    for (const fn of bridge.renderer.get(channel) ?? []) fn({}, ...args)
  }
  bridge.reply = (channel, ...args) => {
    args = structuredClone(args)
    const send = () => { for (const fn of bridge.main.get(channel) ?? []) fn({ senderFrame: Reflect.get(bridge.sender as object, 'mainFrame'), sender: bridge.sender }, ...args) }
    send()
  }
  const configStore = new ConfigStore(join(directory, 'config.json')); config = await configStore.save(config)
  disposeIpc = await registerIpc({ workbenchUserState: userState, appDocumentSources: testAppDocumentSources(bridge.sender), initialConfig: config, window: { setBackgroundColor: vi.fn(), webContents: bridge.sender, isDestroyed: () => false } as unknown as BrowserWindow,
    runtime, configStore,
    workbenchWindows: { setNativeOwner: () => () => {} } as Parameters<typeof registerIpc>[0]['workbenchWindows'],
    applicationAccess: {} as Parameters<typeof registerIpc>[0]['applicationAccess'],
    scratchTopics: new ScratchTopics(), workspaceFiles: { listFiles: async () => [], readDirectory: async () => [], dispose: async () => {} } as unknown as WorkspaceFiles })
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function')
    return handler!({ senderFrame: Reflect.get(bridge.sender as object, 'mainFrame'), sender: bridge.sender } as IpcMainInvokeEvent, ...values)
  })
  window.localStorage.clear()
  useAppStore.setState({ ...initial, loading: true, restoredWorkbench: null, tabs: {}, layouts: {}, sessions: [],
    config: null, agentComposerDrafts: {}, agentSteerQueues: {}, agentSteerInFlight: {} }, true)
  disposeStore = await useAppStore.getState().initialize()
  snapshot = useAppStore.getState().sessions.find(s => s.id === session.agentSessionId) as typeof snapshot
  expect(snapshot).toMatchObject({ kind: 'agent', processState: 'running', control: { run: session.run } })
  expect(useAppStore.getState().loading).toBe(false)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<AgentSessionComposer sessionId={session.agentSessionId} />))
  const mailbox = container.querySelector<HTMLElement>('.composer-mailbox')!, opened = new Event('toggle')
  Object.defineProperty(opened, 'newState', { value: 'open' })
  await act(async () => { mailbox.dispatchEvent(opened); mailbox.querySelector<HTMLButtonElement>('[aria-label="Automation"]')!.click() })
})
afterEach(async () => {
  await act(async () => root?.unmount()); container?.remove(); disposeStore?.(); disposeStore = undefined
  await Promise.allSettled(notesReady)
  useAppStore.setState(initial, true)
  window.dispatchEvent(new Event('pagehide'))
  await api.ui.requestStorageFlush()
  const cleanup = await Promise.allSettled([hostGoals?.dispose(), hostService?.dispose(), disposeIpc?.(), runtime?.dispose()])
  disposeIpc = undefined
  bridge.main.clear(); bridge.renderer.clear(); bridge.handlers.clear(); bridge.invoke.mockReset()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true })
  expect(cleanup.filter(r => r.status === 'rejected'), cleanup.flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []).join('\n')).toEqual([])
})
const target = () => ({ hostId: session.hostId, agentSessionId: session.agentSessionId, providerId: session.providerId, workspacePath: session.workspacePath })
async function create() { return await api.continuousProgress.create({ target: target(), intervalMs: 60_000, prompt: 'continue the assigned work', operationId: 'direct-create-' + mintObjectId() }) }
async function showProgressForm() {
  const edit = container.querySelector<HTMLButtonElement>('[aria-label="Edit continuous progress"]')
  if (edit) await act(async () => edit.click())
  else {
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'New automation')!.click())
    await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Automation type"] input[value="progress"]')!.click())
  }
  expect(container.querySelector('form[aria-label="Continuous progress setup"]')!.closest('[hidden]')).toBeNull()
  expect(container.querySelector<HTMLElement>('[data-automation-view="overview"]')!.hidden).toBe(true)
}
async function click(label: string) {
  const editor = container.querySelector<HTMLElement>('[data-automation-view="editor"]')
  if (editor && !editor.hidden) await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Back to automations"]')!.click())
  const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); expect(button).not.toBeNull()
  const details = button!.closest('details')
  if (details && !details.open) await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  await vi.waitFor(() => expect(button!.disabled).toBe(false))
  const action = vi.spyOn(api.continuousProgress, 'action'), before = action.mock.calls.length
  await act(async () => {
    button!.click()
    await vi.waitFor(() => expect(action.mock.calls.length).toBe(before + 1))
    await action.mock.results[before]!.value
  })
}
const originalProgressDraft = () => useLauncherState.getState().drafts['progress-update:' + JSON.stringify([
  target().hostId, target().agentSessionId, target().providerId, target().workspacePath])]
async function persistedProgressRequest() {
  const document = JSON.parse(await userState.read() ?? '{}')
  const launcher = JSON.parse(document.desktopFragments?.launcher ?? '{"state":{"drafts":{}}}')
  return launcher.state.drafts['progress-update:' + JSON.stringify([target().hostId, target().agentSessionId, target().providerId, target().workspacePath])]?.progressRequest
}
async function prepareOriginalProgress() {
  await showProgressForm()
  const prompt = container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'continue the assigned work')
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(container.querySelector<HTMLButtonElement>('form[aria-label="Continuous progress setup"] button[type="submit"]')!.disabled).toBe(false)
  return container.querySelector<HTMLButtonElement>('form[aria-label="Continuous progress setup"] button[type="submit"]')!
}
async function enableOriginalProgress() {
  const enable = await prepareOriginalProgress()
  await act(async () => enable.click())
  await vi.waitFor(() => expect(manager.list(), JSON.stringify({ ui: container.textContent, calls: bridge.invoke.mock.calls.filter(([channel]) => channel.startsWith('continuousProgress:')), draft: originalProgressDraft() })).toHaveLength(1), { timeout: 5000 })
  await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('form[aria-label="Continuous progress setup"] button[type="submit"]')?.disabled).toBe(false))
}

it('retains the original create request after the actual Host response is lost and only queries that operation', async () => {
  let savedBeforeDispatch: unknown
  const original = bridge.invoke.getMockImplementation()!
  bridge.invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'continuousProgress:create') savedBeforeDispatch = await persistedProgressRequest()
    const result = await original(channel, ...args)
    if (channel === 'continuousProgress:create') throw new Error('The original create response was lost.')
    return result
  })
  await enableOriginalProgress()
  const request = originalProgressDraft()?.progressRequest
  expect(request).toMatchObject({ kind: 'create', dispatch: 'started', input: { target: target(), operationId: manager.list()[0]!.creationOperationId } })
  expect(savedBeforeDispatch, 'The native document must retain the exact request before IPC dispatch.').toEqual(request)
  const creates = bridge.invoke.mock.calls.filter(([channel]) => channel === 'continuousProgress:create')
  expect(creates).toHaveLength(1)
  expect(creates[0]![1]).toMatchObject({ operationId: request!.input.operationId })
  await act(async () => root.render(null))
  await act(async () => root.render(<AgentSessionComposer sessionId={session.agentSessionId} />))
  const mailbox = container.querySelector<HTMLElement>('.composer-mailbox')!, opened = new Event('toggle')
  Object.defineProperty(opened, 'newState', { value: 'open' })
  await act(async () => { mailbox.dispatchEvent(opened); mailbox.querySelector<HTMLButtonElement>('[aria-label="Automation"]')!.click() })
  expect(originalProgressDraft()?.progressRequest).toEqual(request)
  const inspect = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check original request')
  expect(inspect).toBeDefined()
  await vi.waitFor(() => expect(inspect!.disabled).toBe(false))
  await act(async () => inspect!.click())
  await vi.waitFor(() => expect(originalProgressDraft()?.progressRequest).toBeUndefined())
  expect(bridge.invoke.mock.calls.filter(([channel]) => channel === 'continuousProgress:create')).toHaveLength(1)
  expect(manager.list()).toHaveLength(1)
  expect(writes).toEqual([])
})

it('retains the original action after the actual Host response is lost without repeating it on refresh', async () => {
  await enableOriginalProgress()
  let savedBeforeDispatch: unknown
  const original = bridge.invoke.getMockImplementation()!
  bridge.invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'continuousProgress:action') savedBeforeDispatch = await persistedProgressRequest()
    const result = await original(channel, ...args)
    if (channel === 'continuousProgress:action') throw new Error('The original action response was lost.')
    return result
  })
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Back to automations"]')!.click())
  const pause = container.querySelector<HTMLButtonElement>('[aria-label="Pause continuous progress"]')!
  expect(pause).not.toBeNull()
  await act(async () => pause.click())
  await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('paused'))
  const request = originalProgressDraft()?.progressRequest
  expect(request).toMatchObject({ kind: 'action', input: { target: target(), action: 'pause', operationId: manager.list()[0]!.lastMutation?.operationId } })
  expect(savedBeforeDispatch).toEqual(request)
  const inspect = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check original request')
  expect(inspect).toBeDefined()
  await vi.waitFor(() => expect(inspect!.disabled).toBe(false))
  await act(async () => inspect!.click())
  await vi.waitFor(() => expect(originalProgressDraft()?.progressRequest).toBeUndefined())
  expect(bridge.invoke.mock.calls.filter(([channel]) => channel === 'continuousProgress:action')).toHaveLength(1)
  expect(manager.list()[0]?.status).toBe('paused')
  expect(writes).toEqual([])
})
it.each(['prepared', 'started'] as const)('does not dispatch a create when retaining its original request fails at the %s native document boundary', async phase => {
  const enable = await prepareOriginalProgress(), invoke = bridge.invoke.getMockImplementation()!
  bridge.invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'ui:writeWorkbenchState') {
      const document = JSON.parse(args[0].value), launcher = JSON.parse(document.desktopFragments?.launcher ?? '{"state":{"drafts":{}}}')
      if (Object.values(launcher.state.drafts ?? {}).some(draft => (draft as { progressRequest?: { dispatch?: string } }).progressRequest?.dispatch === phase))
        throw new Error('Private original document save failure')
    }
    return invoke(channel, ...args)
  })
  try {
    await act(async () => enable.click())
    await vi.waitFor(() => expect(container.textContent).toContain('No action was dispatched'))
    expect(originalProgressDraft()?.progressRequest).toMatchObject({ kind: 'create', dispatch: 'prepared', input: { target: target(), operationId: expect.any(String) } })
    expect(bridge.invoke.mock.calls.filter(([channel]) => channel === 'continuousProgress:create')).toEqual([])
    expect(manager.list()).toEqual([])
  } finally {
    bridge.invoke.mockImplementation(invoke)
    await checkpointLauncherState()
  }
  expect(manager.list(), 'Recovering storage cannot automatically replay the retained request.').toEqual([])
  const retained = structuredClone(originalProgressDraft()!.progressRequest!)
  const edit = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Keep request and edit')!
  await act(async () => edit.click())
  expect(originalProgressDraft()?.progressRequest).toBeUndefined()
  expect(originalProgressDraft()?.unconfirmedProgressRequests).toEqual([retained])
  const prompt = container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'A new explicit value after storage recovery')
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => container.querySelector<HTMLButtonElement>('form[aria-label="Continuous progress setup"] button[type="submit"]')!.click())
  await vi.waitFor(() => expect(manager.list()[0]?.prompt).toBe('A new explicit value after storage recovery'))
  expect(manager.list()[0]?.creationOperationId).not.toBe(retained.input.operationId)
  await vi.waitFor(() => expect(originalProgressDraft()?.progressRequest).toBeUndefined())
  expect(container.querySelector('.continuous-progress-control')?.getAttribute('data-progress-state'), 'A retained proven-unsent request cannot make the current confirmed automation unknown.').toBe('active')
  expect(bridge.invoke.mock.calls.filter(([channel]) => channel === 'continuousProgress:create')).toHaveLength(1)
  expect(originalProgressDraft()?.unconfirmedProgressRequests).toEqual([retained])
  expect(writes).toEqual([])
})

it('keeps an unknown original action when a later authorized action has replaced its stored operation', async () => {
  await enableOriginalProgress()
  const invoke = bridge.invoke.getMockImplementation()!
  bridge.invoke.mockImplementation(async (channel, ...args) => {
    const result = await invoke(channel, ...args)
    if (channel === 'continuousProgress:action') throw new Error('Private original action response loss')
    return result
  })
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Back to automations"]')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Pause continuous progress"]')!.click())
  await vi.waitFor(() => expect(originalProgressDraft()?.progressRequest?.kind).toBe('action'))
  await vi.waitFor(() => expect(container.textContent).toContain('Private original action response loss'))
  const request = structuredClone(originalProgressDraft()!.progressRequest!)
  bridge.invoke.mockImplementation(invoke)
  const current = manager.list()[0]!
  await api.continuousProgress.action(target(), current.loopId, 'stop', current, 'later-independent-stop')
  const inspect = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check original request')!
  await vi.waitFor(() => expect(inspect.disabled).toBe(false))
  await act(async () => inspect.click())
  await vi.waitFor(() => expect(container.textContent).toContain('Missing records do not prove it was not applied'))
  expect(originalProgressDraft()?.progressRequest).toEqual(request)
  expect(bridge.invoke.mock.calls.filter(([channel]) => channel === 'continuousProgress:action')).toHaveLength(2)
  expect(bridge.invoke.mock.calls.filter(([channel, , operationId]) => channel === 'continuousProgress:list' && operationId === request.input.operationId)).toHaveLength(1)
  expect(manager.list()[0]).toMatchObject({ status: 'stopped', lastMutation: { operationId: 'later-independent-stop' } })
  const returnToLoop = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Return to original loop')!
  await vi.waitFor(() => expect(returnToLoop.disabled).toBe(false))
  await act(async () => returnToLoop.click())
  await vi.waitFor(() => expect(originalProgressDraft()?.progressRequest).toBeUndefined())
  expect(originalProgressDraft()?.unconfirmedProgressRequests).toEqual([request])
  expect(bridge.invoke.mock.calls.filter(([channel]) => channel === 'continuousProgress:action')).toHaveLength(2)
  expect(writes).toEqual([])
})

it('shows the current live loop while recovering an older stored creation observation', async () => {
  const invoke = bridge.invoke.getMockImplementation()!
  bridge.invoke.mockImplementation(async (channel, ...args) => {
    const result = await invoke(channel, ...args)
    if (channel === 'continuousProgress:create') throw new Error('Private creation response loss')
    return result
  })
  await enableOriginalProgress()
  const current = manager.list()[0]!, store = Reflect.get(manager, 'store') as ContinuousProgressLoopStore
  const failure = vi.spyOn(store, 'save').mockRejectedValue(new Error('Private pause save failure'))
  await expect(api.continuousProgress.action(target(), current.loopId, 'pause', current, 'later-independent-pause')).rejects.toThrow('Private pause save failure')
  const inspect = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check original request')!
  await vi.waitFor(() => expect(inspect.disabled).toBe(false))
  await act(async () => inspect.click())
  await vi.waitFor(() => expect(originalProgressDraft()?.progressRequest).toBeUndefined())
  expect(container.querySelector('.continuous-progress-control')?.getAttribute('data-progress-state'), 'Stored old active configuration must not replace the current paused live loop.').toBe('paused')
  expect(manager.list()[0]).toMatchObject({ status: 'paused', lastMutation: { phase: 'prepared' } })
  expect(bridge.invoke.mock.calls.filter(([channel]) => channel === 'continuousProgress:create')).toHaveLength(1)
  expect(writes).toEqual([]); failure.mockRestore()
})

it('keeps a started request with no Host record unknown and offers an explicit independent editing exit', async () => {
  const invoke = bridge.invoke.getMockImplementation()!
  bridge.invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'continuousProgress:create') throw new Error('Private transport ended before the owner was reached')
    return invoke(channel, ...args)
  })
  const enable = await prepareOriginalProgress()
  await act(async () => enable.click())
  await vi.waitFor(() => expect(container.textContent).toContain('Private transport ended'))
  const request = structuredClone(originalProgressDraft()!.progressRequest!)
  expect(request.dispatch).toBe('started'); expect(await persistedProgressRequest()).toEqual(request)
  expect(manager.list()).toEqual([])
  const inspect = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check original request')!
  await vi.waitFor(() => expect(inspect.disabled).toBe(false)); await act(async () => inspect.click())
  await vi.waitFor(() => expect(container.textContent).toContain('Missing records do not prove it was not applied'))
  expect(originalProgressDraft()?.progressRequest).toEqual(request)
  const edit = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Keep unknown request and edit')!
  await vi.waitFor(() => expect(edit.disabled).toBe(false)); await act(async () => edit.click())
  expect(originalProgressDraft()?.unconfirmedProgressRequests).toEqual([request])
  expect(originalProgressDraft()?.progressRequest).toBeUndefined()
  expect(manager.list()).toEqual([])
  bridge.invoke.mockImplementation(invoke)
  const prompt = container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'A separately authorized new intent')
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => container.querySelector<HTMLButtonElement>('form[aria-label="Continuous progress setup"] button[type="submit"]')!.click())
  await vi.waitFor(() => expect(manager.list()[0]?.prompt).toBe('A separately authorized new intent'))
  expect(manager.list()[0]?.creationOperationId).not.toBe(request.input.operationId)
  expect(originalProgressDraft()?.unconfirmedProgressRequests).toEqual([request])
  expect(writes).toEqual([])
})

it('does not confirm an original action from a stored receipt with another complete request body', async () => {
  await enableOriginalProgress()
  const invoke = bridge.invoke.getMockImplementation()!
  bridge.invoke.mockImplementation(async (channel, ...args) => {
    if (channel !== 'continuousProgress:action') return invoke(channel, ...args)
    const altered = structuredClone(args)
    altered[3] = { ...altered[3], nextCheckAt: altered[3].nextCheckAt + 1 }
    await invoke(channel, ...altered)
    throw new Error('Private altered request response loss')
  })
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Back to automations"]')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Pause continuous progress"]')!.click())
  await vi.waitFor(() => expect(container.textContent).toContain('Private altered request response loss'))
  const request = structuredClone(originalProgressDraft()!.progressRequest!)
  const inspect = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check original request')!
  await vi.waitFor(() => expect(inspect.disabled).toBe(false)); await act(async () => inspect.click())
  await vi.waitFor(() => expect(container.textContent).toContain('The original operation remains unconfirmed'))
  expect(originalProgressDraft()?.progressRequest, 'Matching bare id/action/revision does not prove this complete original body.').toEqual(request)
  expect(manager.list()[0]).toMatchObject({ status: 'paused', lastMutation: { operationId: request.input.operationId, phase: 'settled' } })
  expect(bridge.invoke.mock.calls.filter(([channel]) => channel === 'continuousProgress:action')).toHaveLength(1)
  expect(writes).toEqual([])
})

it('mounts the existing Composer leaf and real create/pause/resume/check/stop routes, with no second target work', async () => {
  const mailbox = container.querySelector<HTMLElement>('.composer-mailbox')!; expect(mailbox).not.toBeNull()
  const page = mailbox.querySelector<HTMLElement>('[role="region"][aria-label="Automation settings"]')!; expect(page.hidden).toBe(false)
  await showProgressForm()
  const form = page.querySelector('form[aria-label="Continuous progress setup"]'); expect(form).not.toBeNull()
  const textarea = form!.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    textarea.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'continue the assigned work')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(document.activeElement).toBe(textarea)
  const enable = form!.querySelector<HTMLButtonElement>('button[type="submit"]')!; expect(enable.disabled).toBe(false)
  const created = vi.spyOn(api.continuousProgress, 'create')
  await act(async () => {
    enable.click()
    await vi.waitFor(() => expect(created).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ target: target(), intervalMs: 1_800_000, prompt: 'continue the assigned work', operationId: expect.any(String) })))
    await expect(created.mock.results[0]!.value).resolves.toMatchObject({ status: 'active', agentSessionId: session.agentSessionId })
  })
  expect(manager.list()).toHaveLength(1)
  expect(page.textContent).toContain('active')
  expect(manager.list()[0]).toMatchObject(target())
  await click('Pause continuous progress'); expect(manager.list()[0]!.status).toBe('paused')
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Resume and check continuous progress"]')).not.toBeNull())
  const resume = container.querySelector<HTMLButtonElement>('[aria-label="Resume and check continuous progress"]')!
  expect(resume.textContent).toContain('Resume and check')
  expect(container.querySelector('[aria-label="Check continuous progress now"]')).toBeNull()
  await click('Resume and check continuous progress'); expect(manager.list()[0]!.status).toBe('active')
  const firstInput = [`\u001b[200~${composeAgentPrompt('continue the assigned work', AGENTMUX_AGENT_MESSAGING_ENTRY).text}\u001b[201~`, '\r']
  expect(writes).toEqual(firstInput)
  expect(manager.list()[0]).toMatchObject({ lastOutcome: 'sent', agentSessionId: session.agentSessionId })
  expect(client.agentSession(session.agentSessionId).run).toEqual(session.run)
  await vi.waitFor(() => expect(container.querySelector('.continuous-progress-panel')!.textContent).toContain('Host accepted the request'))
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Pause continuous progress"]')).not.toBeNull())
  await click('Check continuous progress now')
  expect(writes).toEqual(firstInput)
  expect(manager.list()[0]!.lastOutcome).toBe('skipped')
  expect(observations.length).toBeGreaterThan(0); expect(new Set(observations)).toEqual(new Set([session.agentSessionId]))
  await click('Stop continuous progress'); expect(manager.list()[0]!.status).toBe('stopped')
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Check continuous progress now"]')).toBeNull())
})

it('resumes from the Composer and reports a busy check without sending or replacing the original Agent', async () => {
  const original = await create()
  await api.continuousProgress.action(target(), original.loopId, 'pause', original, 'pause-before-busy-resume')
  const status = vi.mocked(client.statusAgent).getMockImplementation()!
  // The private Native observation seam reports working; every owning decision and
  // original public action still runs through the production Host/Core route.
  vi.mocked(client.statusAgent).mockImplementation(async (...args) => {
    const observed = await status(...args)
    return { ...observed, session: { ...observed.session, semanticStatus: { ...session.semanticStatus!, state: 'working' as const } },
      observation: { ...observed.observation, semantic: 'active' as const } }
  })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Resume and check continuous progress"]')).not.toBeNull())
  await click('Resume and check continuous progress')
  expect(manager.list()).toHaveLength(1)
  expect(manager.list()[0]).toMatchObject({ ...target(), loopId: original.loopId, status: 'active', lastOutcome: 'skipped', lastDecision: 'working', intervalMs: original.intervalMs })
  const panel = container.querySelector<HTMLElement>('.continuous-progress-panel')!
  expect(panel.closest('[hidden]')).toBeNull()
  expect(panel.textContent).toMatch(/working|busy/i)
  expect(writes).toEqual([])
  expect(client.agentSession(session.agentSessionId).run).toEqual(session.run)
  await click('Check continuous progress now')
  expect(writes).toEqual([]); expect(manager.list()[0]!.lastDecision).toBe('working')
})

it('saves an existing paused configuration through Composer, preload, IPC and the original Host without recreating or resuming it', async () => {
  const original = await create()
  const paused = await api.continuousProgress.action(target(), original.loopId, 'pause', original, 'pause-before-configuration-edit')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await showProgressForm()
  await vi.waitFor(() => expect(container.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')!.value).toBe(original.prompt))
  const form = container.querySelector<HTMLFormElement>('form[aria-label="Continuous progress setup"]')!
  for (const [selector, value] of [['input[type="number"]', '60'], ['textarea', '检查最新成果并继续原任务']]) {
    const field = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector!)!
    await act(async () => {
      Object.getOwnPropertyDescriptor(field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
  expect(save.disabled).toBe(false); expect(save.textContent).toBe('Save changes')
  const update = vi.spyOn(api.continuousProgress, 'update'), createAgain = vi.spyOn(api.continuousProgress, 'create')
  await act(async () => { save.click(); await vi.waitFor(() => expect(update).toHaveBeenCalledOnce()); await update.mock.results[0]!.value })
  const request = update.mock.calls[0]![0]
  expect(bridge.invoke).toHaveBeenCalledWith('continuousProgress:update', request)
  expect(request).toMatchObject({ target: target(), loopId: original.loopId, intervalMs: 3_600_000, prompt: '检查最新成果并继续原任务' })
  expect(manager.list()).toHaveLength(1)
  expect(manager.list()[0]).toMatchObject({ ...target(), loopId: original.loopId, status: 'paused', nextCheckAt: paused.nextCheckAt,
    intervalMs: 3_600_000, prompt: '检查最新成果并继续原任务', lastMutation: { operationId: request.operationId, action: 'update' } })
  expect(await ContinuousProgressLoopStore.forUserData(directory).load()).toEqual(manager.list())
  expect(client.agentSession(session.agentSessionId).run).toEqual(session.run)
  expect(createAgain).not.toHaveBeenCalled(); expect(writes).toEqual([])
  expect(form.textContent).toContain('Changes saved. Continuous progress remains paused.')
  await expect(api.continuousProgress.update({ ...request, prompt: 'stale edit must not overwrite', operationId: 'stale-configuration-update' }))
    .rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(manager.list()[0]!.prompt).toBe('检查最新成果并继续原任务')
})
it('saved defaults reach both original Composer creation routes and durable tasks without automatic input', async () => {
  await act(async () => root.unmount())
  await act(async () => {
    const before = useAppStore.getState().config!
    await api.config.save({ ...before, automation: { progressIntervalMs: 420000, progressPrompt: 'Continue the precise saved task',
      calendarTimezone: 'Europe/Berlin', checkInSilenceMs: 7200000, checkInMinIntervalMs: 10800000, checkInDailyBudget: 2, checkInQuietStart: new Date(_batchFixtureEpoch(0, 23 * 60 * 60 + 15 * 60)).toISOString().slice(11, 16), checkInQuietEnd: new Date(_batchFixtureEpoch(0, 7 * 60 * 60 + 45 * 60)).toISOString().slice(11, 16) } }, before)
  })
  expect((await new ConfigStore(join(directory, 'config.json')).get()).automation?.progressIntervalMs).toBe(420000)
  // This fixture mounts Composer directly; App normally installs the config-change reader.
  useAppStore.setState({ config: await api.config.get() })
  root = createRoot(container); await act(async () => root.render(<AgentSessionComposer sessionId={session.agentSessionId} />))
  const mailbox = container.querySelector<HTMLElement>('.composer-mailbox')!, opened = new Event('toggle')
  Object.defineProperty(opened, 'newState', { value: 'open' }); await act(async () => mailbox.dispatchEvent(opened))
  await act(async () => mailbox.querySelector<HTMLButtonElement>('[aria-label="Automation"]')!.click())
  await showProgressForm()
  const progress = container.querySelector<HTMLElement>('.calendar-schedules')!, form = progress.querySelector<HTMLFormElement>('form[aria-label="Continuous progress setup"]')!
  expect(form.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('7')
  expect(form.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Continue the precise saved task')
  expect(manager.list()).toEqual([]); expect(writes).toEqual([])
  await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
  await vi.waitFor(() => expect(manager.list().find(loop => !loop.calendar)).toMatchObject({ ...target(), intervalMs: 420000, prompt: 'Continue the precise saved task' }))
  const calendar = container.querySelector<HTMLElement>('.calendar-schedules')!
  await act(async () => calendar.querySelector<HTMLButtonElement>('[aria-label="Back to automations"]')!.click())
  await act(async () => [...calendar.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'New automation')!.click())
  await act(async () => calendar.querySelector<HTMLInputElement>('[aria-label="Arrangement timing"] input[value="calendar"]')!.click())
  const topic = calendar.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(topic, 'One explicit calendar question'); topic.dispatchEvent(new Event('input', { bubbles: true })); calendar.querySelector<HTMLInputElement>('[aria-label="Enable quiet follow-up"]')!.click() })
  expect(calendar.textContent).toContain('2h silence')
  const calendarCreate = vi.spyOn(api.schedule, 'create')
  await act(async () => {
    calendar.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
    await vi.waitFor(() => expect(calendarCreate).toHaveBeenCalledOnce())
    await calendarCreate.mock.results[0]!.value
  })
  await vi.waitFor(() => expect(manager.list().find(loop => loop.calendar)).toMatchObject({ ...target(), calendar: { timezone: 'Europe/Berlin' }, prompt: 'One explicit calendar question',
    checkIn: { silenceMs: 7200000, minIntervalMs: 10800000, dailyBudget: 2, quiet: { start: new Date(_batchFixtureEpoch(0, 23 * 60 * 60 + 15 * 60)).toISOString().slice(11, 16), end: new Date(_batchFixtureEpoch(0, 7 * 60 * 60 + 45 * 60)).toISOString().slice(11, 16) } } }))
  const disk = await ContinuousProgressLoopStore.forUserData(directory).load()
  expect(disk).toHaveLength(2); expect(disk.find(loop => loop.calendar)?.checkIn?.dailyBudget).toBe(2)
  expect(writes).toEqual([])
  const original = manager.list().find(loop => !loop.calendar)!
  await act(async () => {
    const before = await api.config.get()
    await api.config.save({ ...before, automation: { ...before.automation, progressIntervalMs: 660000, progressPrompt: 'A later new task default', checkInDailyBudget: 3 } }, before)
    useAppStore.setState({ config: await api.config.get() })
    await api.continuousProgress.action(target(), original.loopId, 'stop', original, 'stop-original-defaults-loop')
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await vi.waitFor(() => expect(progress.querySelector<HTMLTextAreaElement>('form[aria-label="Continuous progress setup"] textarea')?.value).toBe('A later new task default'))
  expect(progress.querySelector<HTMLInputElement>('form[aria-label="Continuous progress setup"] input[type="number"]')!.value).toBe('11')
  expect(manager.list().find(loop => loop.loopId === original.loopId)).toMatchObject({ status: 'stopped', intervalMs: 420000, prompt: 'Continue the precise saved task' })
  expect(manager.list().find(loop => loop.calendar)?.checkIn?.dailyBudget).toBe(2)
  expect(manager.list()).toHaveLength(2); expect(writes).toEqual([])
})
it('keeps an unconfirmed continuation composition through an independent loop notification and submits only the final text', async () => {
  const existing = await create()
  const stopped = await api.continuousProgress.action(target(), existing.loopId, 'stop', existing, 'stop-original-composition-loop')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await showProgressForm()
  await vi.waitFor(() => expect(container.querySelector('form[aria-label="Continuous progress setup"]')).not.toBeNull())
  const form = container.querySelector<HTMLFormElement>('form[aria-label="Continuous progress setup"]')!
  const textarea = form.querySelector<HTMLTextAreaElement>('textarea')!
  expect(textarea).not.toBeNull()
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  const drafts = structuredClone(useAppStore.getState().agentComposerDrafts)
  const queues = structuredClone(useAppStore.getState().agentSteerQueues)
  const created = vi.spyOn(api.continuousProgress, 'create')
  await act(async () => {
    setValue.call(textarea, 'preedit')
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'preedit' }))
  })
  await act(async () => {
    setValue.call(textarea, 'unconfirmed candidate')
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'unconfirmed candidate' }))
  })
  const reading = vi.spyOn(api.continuousProgress, 'list')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(reading).toHaveBeenCalledWith(target())
  expect(form.querySelector('textarea')).toBe(textarea)
  expect(textarea.value).toBe('unconfirmed candidate')
  expect(created).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts).toEqual(drafts)
  expect(useAppStore.getState().agentSteerQueues).toEqual(queues)
  expect(writes).toEqual([])
  await act(async () => {
    setValue.call(textarea, 'final confirmed continuation')
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'final confirmed continuation' }))
  })
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(created).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ target: target(), intervalMs: 1_800_000,
    prompt: 'final confirmed continuation', operationId: expect.any(String) })))
  await vi.waitFor(() => expect(manager.list().find(loop => loop.status === 'active')?.prompt)
    .toBe('final confirmed continuation'))
  expect(useAppStore.getState().agentComposerDrafts).toEqual(drafts)
  expect(useAppStore.getState().agentSteerQueues).toEqual(queues)
  expect(writes).toEqual([])
})
it('the actual explicit-input signal pauses automatic work without moving its draft into Host eligibility or blocking explicit resume', async () => {
  const loop = await create()
  await act(async () => useAppStore.getState().setAgentComposerDraft(session.agentSessionId, 'my draft'))
  await vi.waitFor(() => expect(manager.list()[0]!.status).toBe('paused'))
  await api.continuousProgress.action(target(), loop.loopId, 'resume', manager.list()[0]!, 'explicit-resume-original-loop')
  const accepted = [`\u001b[200~${composeAgentPrompt(loop.prompt, AGENTMUX_AGENT_MESSAGING_ENTRY).text}\u001b[201~`, '\r']
  expect(writes).toEqual(accepted)
  expect(useAppStore.getState().agentComposerDrafts[session.agentSessionId]).toBe('my draft')
  expect(manager.list()[0]!.status).toBe('active')
  expect(useAppStore.getState().agentSteerQueues).toEqual({})
  await manager.checkNow(loop.loopId)
  expect(writes).toEqual(accepted)
  expect(client.agentSession(session.agentSessionId).run).toEqual(session.run)
})
it('rejects a new automatic claim when real public raw input follows its observation; manual input and its cursor remain intact', async () => {
  const loop = await create()
  const status = client.statusAgent.bind(client)
  vi.mocked(client.statusAgent).mockImplementationOnce(async (...args) => {
    const observed = await status(...args)
    await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: 'manual raw' })
    return observed
  })
  await act(async () => manager.checkNow(loop.loopId))
  expect(writes).toEqual(['manual raw']); expect(cursor).toBe(Buffer.byteLength('manual raw'))
  expect(manager.list()[0]).toMatchObject({ lastOutcome: 'skipped' })
  expect(client.agentSession(session.agentSessionId).promptCompletionAdmission).toBeUndefined()
})
it('cancels a pending Composer resume check without delaying healthy manual input or erasing its action error on refresh', async () => {
  const loop = await create()
  await api.continuousProgress.action(target(), loop.loopId, 'pause', loop, 'pause-before-cancelled-resume')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Resume and check continuous progress"]')).not.toBeNull())
  const resume = container.querySelector<HTMLButtonElement>('[aria-label="Resume and check continuous progress"]')!
  const details = resume.closest('details')!
  await act(async () => { details.open = true })
  let release!: () => void, entered = false
  const blocked = new Promise<void>(resolve => { release = resolve }), status = client.statusAgent.bind(client)
  vi.mocked(client.statusAgent).mockImplementationOnce(async (...args) => { entered = true; await blocked; return status(...args) })
  const action = vi.spyOn(api.continuousProgress, 'action')
  await act(async () => resume.click())
  try {
    await vi.waitFor(() => expect(entered).toBe(true))
    expect(resume.disabled).toBe(true)
    const request = action.mock.calls[0]!
    expect(request.slice(0, 3)).toEqual([target(), loop.loopId, 'resume'])
    await api.sessions.write(snapshot.control, 'still healthy', 'user')
    expect(writes).toEqual(['still healthy'])
    await vi.waitFor(() => expect(manager.list()[0]!.status).toBe('paused'))
  } finally {
    release()
    await act(async () => { await expect(action.mock.results[0]!.value).rejects.toBeDefined() })
  }
  expect(writes).toEqual(['still healthy'])
  expect(client.agentSession(session.agentSessionId).run).toEqual(session.run)
  const notices = () => [...container.querySelectorAll<HTMLElement>('[aria-label="Automation settings"] .continuous-progress-panel [role="status"]')].filter(node => !node.closest('[hidden]'))
  await vi.waitFor(() => expect(notices().length).toBeGreaterThan(0))
  const originalError = notices().map(node => node.textContent).join(' ')
  expect(originalError).toMatch(/cancel|changed|input/i)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(notices().map(node => node.textContent).join(' ')).toContain(originalError)
  expect(action).toHaveBeenCalledTimes(1)
})
it('an unknown original Native cursor admits no automatic input or false zero and recovers on the same Session', async () => {
  const loop = await create(); cursor = null
  expect((await client.statusAgent(session.agentSessionId)).run.acceptedInputBytes).toBeNull()
  await manager.checkNow(loop.loopId)
  expect(writes).toEqual([])
  expect(manager.list()[0]).toMatchObject({ status: 'active', lastOutcome: 'skipped' })
  expect(manager.list()[0]!.lastDecision).toBeTruthy()
  cursor = 0
  await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: 'manual after observation recovery' })
  expect(writes).toEqual(['manual after observation recovery']); expect(client.agentSession(session.agentSessionId).run).toEqual(session.run)
})

it('keeps a late create result on its original workspace while the same Session Composer target has an enabled, empty form', async () => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const store = (manager as unknown as { store: ContinuousProgressLoopStore }).store
  const originalSave = store.save.bind(store)
  const save = vi.spyOn(store, 'save').mockImplementationOnce(async loops => { await blocked; await originalSave(loops) })
  try {
  await showProgressForm()
  const form = container.querySelector('form[aria-label="Continuous progress setup"]')!
  const textarea = form.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'original target prompt')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
  const other = { ...snapshot, workspacePath: join(directory, 'second-workspace') }
  await act(async () => {
    useAppStore.setState({ sessions: [other] })
    root.render(<AgentSessionComposer sessionId={other.id} />)
  })
  const next = container.querySelector('form[aria-label="Continuous progress setup"]')!
  const nextText = next.querySelector<HTMLTextAreaElement>('textarea')!
  expect(nextText.value).toBe('')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(nextText, 'new target draft')
    nextText.dispatchEvent(new Event('input', { bubbles: true }))
    release()
  })
  await vi.waitFor(() => expect(manager.list()).toHaveLength(1))
  expect(manager.list()[0]).toMatchObject({ ...target(), prompt: 'original target prompt' })
  expect(next.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false)
  expect(nextText.value).toBe('new target draft')
  expect(container.querySelector('[aria-label="Pause continuous progress"]')).toBeNull()
  expect(writes).toEqual([])
  } finally { release() }
})


it('binds an explicit real Tracker through the mounted leaf and IPC, keeping done distinct from archived completion', async () => {
  const sourceRoot = join(directory, 'private-tracker'); await mkdir(sourceRoot)
  const tracker = await privateTracker(sourceRoot), binding = await tracker.create('mounted-source')
  await tracker.run('start-task', '--feature', binding.ownerId, '--task', 'T-001')
  await showProgressForm()
  const form = container.querySelector('form[aria-label="Continuous progress setup"]')!; expect(form).not.toBeNull()
  const checkbox = form.querySelector<HTMLInputElement>('input[type="checkbox"]')!; expect(checkbox).not.toBeNull()
  await act(async () => checkbox.click())
  async function type(selector: string, value: string) {
    const input = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!; expect(input).not.toBeNull()
    await act(async () => {
      const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  await type('textarea', 'continue the assigned work')
  await type('[aria-label="Tracker root"]', binding.root)
  await type('[aria-label="Feature ID"]', binding.ownerId)
  await type('[aria-label="Public Tracker script"]', binding.readerPath)
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(manager.list()).toHaveLength(1))
  expect(manager.list()[0]!.taskSource).toEqual(binding)
  await vi.waitFor(() => expect(container.textContent).toContain(binding.ownerId))
  await tracker.run('run-task-gate', '--feature', binding.ownerId, '--task', 'T-001')
  await tracker.run('finish-task', '--feature', binding.ownerId, '--task', 'T-001', '--result', 'done')
  await click('Check continuous progress now')
  await vi.waitFor(() => expect(manager.list()[0]!.status).toBe('paused'))
  await vi.waitFor(() => expect(container.textContent).toContain('closeout is still required'))
  expect(container.textContent).not.toContain('business complete')
  expect(requests).toEqual([])
  await tracker.run('closeout-feature', '--feature', binding.ownerId, '--mode', 'archive', '--execute', ...tracker.closeoutArgs)
  await click('Resume and check continuous progress')
  // Resume already checks the archived source and ends this original loop.
  await vi.waitFor(() => expect(manager.list()[0]!.status).toBe('stopped'))
  await vi.waitFor(() => expect(container.textContent).toContain('business complete (archived)'))
  expect(requests).toEqual([])
}, 30_000)
