// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxError, AgentMuxMemoryAgentSessionStore, AgentProviderRegistry, defineAgentProvider,
  AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig } from '../src/shared/contracts'
import type { ConfigStore } from '../src/main/config-store'
import type { WorkspaceFiles } from '../src/main/workspace-files'
import { AgentHookServer } from '../../../packages/core/src/hook-server'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null,
  invoke: vi.fn(), handlers: new Map<string, (...args: unknown[]) => unknown>() }))
// Electron transport and unrelated startup services are isolated. The target's Renderer, Store,
// preload, registered IPC, RuntimeController and public Core submission all execute below.
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: AgentMuxPreloadApi) => {
    bridge.api = api; Object.assign(window, { [name]: api })
  } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
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
import { ScratchTopics } from '../src/main/scratch-topics'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { executorDetectionKey, useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { App } from '../src/renderer/src/App'
import { createWorkbenchTab, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'

// Target: actual lifecycle failure crosses Core / Main / registered invoke / Store into mounted
// Launcher and Session feedback. Native PTY is already proven by T-001's private receipt.
// Real creation, durable claim, Scratch preparation, projection, registered IPC, preload,
// Store and mounted Pane execute. Native kernel/paint are isolated, not claimed as PTY proof.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-live-terminal /> }))
const initial = useAppStore.getState()
let dir: string, core: AgentMuxClient, runtime: RuntimeController, topics: ScratchTopics
let config: AppConfig, disposeIpc: (() => Promise<void>) | undefined, disposeStore: (() => void) | undefined, root: Root, container: HTMLDivElement
let starts: any[], runs: Map<string, any>, writes: string[], topicId: string, destroyed: boolean
let kernel: any
const failures: unknown[] = []
const launcherId = 'projection-launcher', regionId = initialWorkbenchRegionId(launcherId)

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  dir = await mkdtemp(join(tmpdir(), 'amx-launch-projection-'))
  await mkdir(join(dir, 'home'), { mode: 0o700 })
  vi.stubEnv('CODEX_HOME', join(dir, 'home'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(dir, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(dir, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(dir, 'messages.ndjson'))
  starts = []; runs = new Map(); writes = []; destroyed = false
  const template = new AgentProviderRegistry().get('codex')
  const provider = defineAgentProvider({
    catalog: { ...template.catalog, id: 'projection-fixture', label: 'Projection fixture',
      executable: 'projection-fixture', expectedProcess: 'projection-fixture', hookStrategy: { kind: 'none' },
      readySignal: { kind: 'foreground-process', expectedProcess: 'projection-fixture' } },
    hook: { rules: [], eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' } },
    buildArgs: (prompt, args) => [...args, prompt],
    buildResumeArgs: (id, _path, prompt, args) => [...args, id, ...(prompt ? [prompt] : [])]
  })
  const durable = new AgentMuxMemoryAgentSessionStore()
  core = new AgentMuxClient({ store: durable, providers: [provider] })
  const inner = core as any
  // Use the actual listener on an OS-assigned private port; parallel private proofs may hash to
  // the same fixed Hook port despite using different isolated Runtime directories.
  inner.hookServer = new AgentHookServer((event, signal) => inner.acceptHookEvent(event, signal), 0)
  inner.connected = true
  await inner.registry.load('local')
  vi.spyOn(core, 'probeAgent').mockResolvedValue({ providerId: provider.id, installed: true,
    executable: provider.executable, capabilities: provider.catalog.capabilities })
  kernel = inner.kernel
  kernel.isConnected = () => true
  kernel.identity = () => ({ daemonInstanceId: 'private-projection', buildIdentity: 'fixture', protocolVersion: 18 })
  kernel.start = async (input: any) => {
    starts.push(input)
    const run = { runId: `projection-run-${starts.length}`, lifecycleOperationId: input.operationKey,
      program: input.program, args: input.args, workspacePath: input.cwd, pid: 12345,
      state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0,
      firstAvailableByte: 0, acceptedInputBytes: 0 }
    runs.set(run.runId, run); return run
  }
  kernel.list = async () => [...runs.values()]
  kernel.status = async (id: string) => { const run = runs.get(id); if (!run) throw new Error('Private Run absent'); return run }
  kernel.input = async (id: string, input: any) => {
    const run = runs.get(id); writes.push(input.data)
    run.acceptedInputBytes = input.expectedByte + Buffer.byteLength(input.data)
    return { run, appliedByteRange: { startByte: input.expectedByte, endByte: run.acceptedInputBytes } }
  }
  kernel.prepareStop = async (runId: string) => ({ daemonInstance: 'private-projection', operationKey: `stop-${runId}`, runId })
  kernel.stop = async (op: any) => { runs.delete(op.runId) }
  topics = new ScratchTopics()
  const workspace = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: dir, kind: 'folder' as const }
  config = { ...structuredClone(DEFAULT_CONFIG), executors: { fixture: { label: 'Fixture', providerId: provider.id,
    command: provider.executable, args: [], env: { CODEX_HOME: join(dir, 'home') }, injectAgentMuxGuide: false } }, workspaces: [workspace] }
  topicId = (await topics.ensureMote(workspace, 'launcher:projection')).id
  runtime = new RuntimeController(durable, topics)
  runtime.commit({ hosts: [{ id: 'local', client: core, executionHost: { kind: 'local', dispose: vi.fn() } as never }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const sender = Object.assign(new EventEmitter(), { id: 9981, isDestroyed: () => destroyed, send: vi.fn(),
    session: { flushStorageData: vi.fn() } })
  disposeIpc = await registerIpc({ window: { webContents: sender } as unknown as BrowserWindow, runtime,
    configStore: { get: async () => config } as unknown as ConfigStore,
    progressLoops: { subscribe: () => () => {}, pauseTarget: async () => {} } as never,
    scratchTopics: topics, workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function')
    return handler!({ sender } as unknown as IpcMainInvokeEvent, ...values)
  })
  disposeStore = await useAppStore.getState().initialize()
  const tab = createWorkbenchTab(launcherId, { regionId, kind: 'launcher', workspaceId: workspace.id }, topicId)
  useAppStore.setState({ ...initial, config, activeWorkspaceId: workspace.id, tabs: { [launcherId]: tab },
    layouts: { [workspace.id]: createWorkspaceLayout('projection-group', [launcherId]) },
    sessions: [], timelines: {}, pendingAgentLaunches: {}, agentComposerDrafts: {}, agentSteerQueues: {},
    error: null, lastError: null, errorNoticeContext: null, errorDismissed: false, noticeReadReceipts: {}, dirtyDocuments: { sibling: true }, documents: { sibling: { content: 'unsaved sibling' } } as never }, true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root?.unmount()); container?.remove()
  disposeStore?.(); disposeStore = undefined
  const results = await Promise.allSettled([disposeIpc?.(), runtime.dispose()])
  disposeIpc = undefined
  useAppStore.setState(initial, true); bridge.invoke.mockReset(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
  for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
  expect(failures).toEqual([])
})
async function launch() {
  await act(async () => useAppStore.getState().launchAgent('fixture', '', 'projection-group', { tabId: launcherId, regionId }))
  const surface = useAppStore.getState().tabs[launcherId]!.regions[regionId]!
  expect(surface).toMatchObject({ kind: 'agent', phase: 'attached' })
  if (surface.kind !== 'agent') throw new Error('Actual Agent Region missing')
  return surface.sessionId
}
async function pane(id: string) {
  await act(async () => root.render(<SessionPane sessionId={id} surfaceKind="agent" interactiveResize visible
    linkOrigin={{ workspaceId: SCRATCH_WORKSPACE_ID, tabGroupId: 'projection-group', tabId: launcherId, regionId }} />))
}
async function launchDirect(id = 'direct-created') {
  return runtime.launchAgent({ executorId: 'fixture', hostId: 'local', workspacePath: dir,
    scratchTopicId: topicId, agentSessionId: id }, config)
}


async function click(label: string, parent: ParentNode = container) {
  const matches = [...parent.querySelectorAll('button')].filter(item => item.textContent?.trim() === label)
  expect(matches, `actual button ${label}`).toHaveLength(1)
  await act(async () => matches[0]!.click())
}
async function collapseFailure(parent: ParentNode = container) {
  const button = parent.querySelector<HTMLButtonElement>('.service-disclosure > .service-disclosure__close')
  expect(button).not.toBeNull()
  await act(async () => button!.click())
  expect(parent.querySelector('.service-disclosure')?.getAttribute('data-unread')).toBe('false')
}
async function viewFailure(parent: ParentNode = container) {
  const button = parent.querySelector<HTMLButtonElement>('.service-disclosure__trigger')
  expect(button).not.toBeNull()
  await act(async () => button!.click())
  expect(parent.querySelector('.service-disclosure__details')?.getAttribute('popover')).toBe('auto')
}
async function launcher() {
  const capability = await core.probeAgent('projection-fixture')
  useAppStore.setState({ executorDetections: { [executorDetectionKey('local', 'fixture')]: { state: 'ready',
    input: { executorId: 'fixture', providerId: config.executors.fixture!.providerId, command: config.executors.fixture!.command,
      host: config.hosts.find(host => host.id === 'local')! },
    result: { ...capability, executorId: 'fixture' } as never } } })
  await act(async () => root.render(<><NewTabSurface tabGroupId="projection-group" tabId={launcherId} regionId={regionId} visible={false} />
    <GlobalSystemNotices /></>))
}
function failureWindow(parent: ParentNode = container) {
  const windows = parent.querySelectorAll('.agent-launch-notice .service-window')
  expect(windows).toHaveLength(1)
  expect(windows[0]!.getAttribute('role')).toBe('status')
  expect(windows[0]!.getAttribute('aria-live')).toBe('polite')
  return windows[0]!
}

it.each([
  ['CTXMUX_persistence', 'ctxmux durable state rejected a mutation: WAL budget failure'],
  ['CTXMUX_io', 'The state volume could not accept a write']
])('actual creation %s reaches the launcher with step, unknown availability and a real retry', async (code, message) => {
  const sibling = await launchDirect('healthy-sibling')
  useAppStore.setState({ sessions: [sibling.session!] })
  useAppStore.getState().setAgentComposerDraft(regionId, 'original draft')
  useAppStore.getState().setLauncherNameDraft(regionId, 'agentName', 'Kept Agent')
  const before = useAppStore.getState(), originalStart = kernel.start
  kernel.start = async () => { throw new AgentMuxError(message, code) }
  // Emulate Electron's documented invoke transport loss; raw text survives, code does not.
  const invoke = bridge.invoke.getMockImplementation()!
  bridge.invoke.mockImplementation(async (channel, ...args) => {
    try { return await invoke(channel, ...args) }
    catch (error) { throw new Error(`Error invoking remote method '${channel}': AgentMuxError: ${(error as Error).message}`) }
  })
  await launcher()
  const stop = vi.spyOn(core, 'stopAgent')
  await click('Launch agent')
  await vi.waitFor(() => expect(container.querySelector('.launch-surface .agent-launch-notice')).not.toBeNull())
  const notice = failureWindow(container.querySelector('.launch-surface')!)
  expect(notice.querySelector('.service-window__step')?.textContent).toBe('Starting this Agent did not complete')
  expect(notice.querySelector('.service-window__mode')?.textContent).toContain(message)
  expect(notice.querySelector('.service-window__mode')?.textContent).toContain('availability is not confirmed')
  expect(notice.querySelector('.service-window__restore')?.textContent).toContain('retry Start agent')
  expect(container.querySelector('.new-tab-error')).toBeNull()
  expect(useAppStore.getState().error).toBe(message)
  expect(useAppStore.getState().tabs[launcherId]!.regions[regionId]?.kind).toBe('launcher')
  expect(useAppStore.getState().layouts).toEqual(before.layouts)
  expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe('original draft')
  expect(useAppStore.getState().launcherNameDrafts[regionId]?.agentName).toBe('Kept Agent')
  expect(useAppStore.getState().sessions).toEqual([sibling.session])
  await api.sessions.write(sibling.session!.control, 'healthy input', 'user')
  expect(writes).toEqual(['healthy input']); expect(stop).not.toHaveBeenCalled()
  await collapseFailure(container.querySelector('.agent-launch-notice')!)
  expect(container.querySelector('.launch-surface .service-disclosure__summary')).toBeNull()
  expect(container.querySelector('.global-system-notices__item')?.textContent).toContain(message)
  const receipts = useAppStore.getState().noticeReadReceipts
  await act(async () => useAppStore.getState().reportError(new Error(message), useAppStore.getState().errorNoticeContext!))
  expect(useAppStore.getState().noticeReadReceipts).toEqual(receipts)
  await viewFailure(container.querySelector('.agent-launch-notice')!)
  expect(failureWindow(container.querySelector('.launch-surface')!).textContent).toContain(message)
  // The draft edited after failure, rather than a captured old prompt, is the retry payload.
  await act(async () => useAppStore.getState().setAgentComposerDraft(regionId, 'latest draft'))
  kernel.start = originalStart
  await click('Retry Start agent', container.querySelector('.agent-launch-notice')!)
  expect(starts).toHaveLength(2)
  expect(starts[1].args).toContain('latest draft')
  expect(useAppStore.getState().errorNoticeContext).toBeNull()
  expect(useAppStore.getState().lastError).toBeNull()
  expect(useAppStore.getState().tabs[launcherId]!.regions[regionId]).toMatchObject({ kind: 'agent', phase: 'attached' })
  expect(container.querySelector('.global-system-notices__item')).toBeNull()
  expect(stop).not.toHaveBeenCalled()
})

it('retry start keeps the current cause until it succeeds, and a foreign launcher does not consume it', async () => {
  const originalStart = kernel.start
  kernel.start = async () => { throw new AgentMuxError('private failure', 'CTXMUX_persistence') }
  await launcher(); await click('Launch agent')
  await vi.waitFor(() => expect(container.querySelector('.launch-surface .agent-launch-notice')).not.toBeNull())
  let resolve!: (value: unknown) => void
  kernel.start = (input: unknown) => new Promise(yes => { resolve = async () => yes(await originalStart(input)) })
  await click('Retry Start agent', container.querySelector('.agent-launch-notice')!)
  expect(useAppStore.getState().error).toBe('private failure')
  expect(failureWindow(container.querySelector('.launch-surface')!).textContent).toContain('private failure')
  expect([...container.querySelectorAll<HTMLButtonElement>('.agent-launch-notice button')].find(button => button.textContent === 'Retry Start agent')!.disabled).toBe(true)
  await act(async () => root.render(<NewTabSurface tabGroupId="projection-group" tabId="foreign" regionId="foreign-region" visible={false} />))
  expect(container.querySelector('.agent-launch-notice')).toBeNull()
  await act(async () => resolve(undefined))
  expect(useAppStore.getState().errorNoticeContext).toBeNull()
})

it('actual Resume failure reaches this same Session service window and inbox without altering identity or input owners', async () => {
  const id = await launch(), session = useAppStore.getState().sessions[0]!
  if (session.kind !== 'agent') throw new Error('owning Agent missing')
  const inner = core as any
  await inner.registry.put({ ...inner.registry.get(id), nativeHandle: {
    kind: 'provider', providerId: 'projection-fixture', sessionId: 'private-native-handle' } })
  runs.get(session.control.run.runId).state = { type: 'exited', exitCode: 0 }
  await useAppStore.getState().refreshSession(id)
  const before = useAppStore.getState(), originalStart = kernel.start
  useAppStore.getState().setAgentComposerDraft(id, 'Session draft')
  kernel.start = async () => { throw new AgentMuxError('private resume write failure', 'CTXMUX_persistence') }
  const stop = vi.spyOn(core, 'stopAgent')
  await pane(id); await click('Resume')
  const notice = failureWindow()
  expect(notice.querySelector('.service-window__step')?.textContent).toBe('Resuming this Session did not complete')
  expect(notice.querySelector('.service-window__mode')?.textContent).toContain('private resume write failure')
  expect(notice.querySelector('.service-window__mode')?.textContent).toContain('last observed exited; current availability is not confirmed')
  expect(notice.querySelector('.service-window__restore')?.textContent).toContain('retry Resume for this same Session')
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(core.agentSession(id).nativeHandle).toMatchObject({ sessionId: 'private-native-handle' })
  expect(useAppStore.getState().agentComposerDrafts[id]).toBe('Session draft')
  expect(container.querySelector('.composer-mailbox [role="tabpanel"][id$="-system"]')?.textContent).toContain('private resume write failure')
  await collapseFailure(container.querySelector('.agent-launch-notice')!)
  expect(container.querySelector('.agent-launch-notice .service-disclosure__summary')).toBeNull()
  expect(container.querySelector('.composer-mailbox [role="tabpanel"][id$="-system"]')?.textContent).toContain('private resume write failure')
  await viewFailure(container.querySelector('.agent-launch-notice')!)
  kernel.start = originalStart
  await click('Retry Resume', container.querySelector('.agent-launch-notice')!)
  expect(useAppStore.getState().sessions[0]).toMatchObject({ id, processState: 'running' })
  expect(core.agentSession(id).nativeHandle).toMatchObject({ sessionId: 'private-native-handle' })
  expect(useAppStore.getState().lastError).toBeNull()
  expect(container.querySelector('.agent-launch-notice')).toBeNull()
  expect(stop).not.toHaveBeenCalled()
})

it('a late old Run rejection cannot replace the current Run feedback', async () => {
  const id = await launch(), current = useAppStore.getState().sessions[0]!
  let reject!: (error: Error) => void
  vi.spyOn(api.sessions, 'recover').mockImplementation(() => new Promise((_yes, no) => { reject = no }))
  const old = useAppStore.getState().recoverSession(id)
  const next = { ...current, control: { ...current.control, run: { runId: 'new-run' } } } as typeof current
  useAppStore.setState({ sessions: [next] })
  reject(new Error('old Run rejection'))
  await old
  expect(useAppStore.getState().sessions).toEqual([next])
  expect(useAppStore.getState().error).toBeNull()
})

it('the actual App offers the same failure through System without a second window-level alarm', async () => {
  kernel.start = async () => { throw new AgentMuxError('one lifecycle cause', 'CTXMUX_persistence') }
  await expect(useAppStore.getState().launchAgent('fixture', '', 'projection-group', { tabId: launcherId, regionId }))
    .rejects.toThrow('one lifecycle cause')
  // Startup/painting are unrelated to this already-observed failure. Real App and its notice
  // consumers execute; the real Core/Main/Store rejection above is not manually fabricated state.
  vi.spyOn(useAppStore.getState(), 'initialize').mockResolvedValue(() => {})
  useAppStore.setState({ loading: false, mainSurface: 'agents' })
  await act(async () => root.render(<App />))
  expect(container.querySelector('main.main-shell')).not.toBeNull()
  expect(container.querySelectorAll('.global-system-notices__item')).toHaveLength(1)
  expect(container.querySelector('.global-system-notices__item')?.textContent).toContain('one lifecycle cause')
  expect(container.querySelector('.main-shell__notices .error-notice')).toBeNull()
  await act(async () => useAppStore.getState().reportError(new Error('unrelated actual failure')))
  expect(container.querySelectorAll('.main-shell__notices .error-notice')).toHaveLength(1)
  expect(container.querySelector('.main-shell__notices .error-notice')?.textContent).toContain('unrelated actual failure')
})
