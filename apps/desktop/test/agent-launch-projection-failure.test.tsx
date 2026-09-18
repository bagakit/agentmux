// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, AgentProviderRegistry, defineAgentProvider,
  AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig } from '../src/shared/contracts'
import type { ConfigStore } from '../src/main/config-store'
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
import { ScratchTopics } from '../src/main/scratch-topics'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { createWorkbenchTab, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'

// Real creation, durable claim, Scratch preparation, projection, registered IPC, preload,
// Store and mounted Pane execute. Native kernel/paint are isolated, not claimed as PTY proof.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-live-terminal /> }))
const initial = useAppStore.getState()
let dir: string, core: AgentMuxClient, runtime: RuntimeController, topics: ScratchTopics
let config: AppConfig, disposeIpc: (() => Promise<void>) | undefined, root: Root, container: HTMLDivElement
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
    scratchTopics: topics, workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function')
    return handler!({ sender } as unknown as IpcMainInvokeEvent, ...values)
  })
  const tab = createWorkbenchTab(launcherId, { regionId, kind: 'launcher', workspaceId: workspace.id }, topicId)
  useAppStore.setState({ ...initial, config, activeWorkspaceId: workspace.id, tabs: { [launcherId]: tab },
    layouts: { [workspace.id]: createWorkspaceLayout('projection-group', [launcherId]) },
    sessions: [], timelines: {}, pendingAgentLaunches: {}, agentComposerDrafts: {}, agentSteerQueues: {},
    error: null, dirtyDocuments: { sibling: true }, documents: { sibling: { content: 'unsaved sibling' } } as never }, true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
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

it.each(['rejection', 'wrong-identity'])('keeps actual Core creation and Scratch identity when Timeline %s fails', async kind => {
  const read = vi.spyOn(core, 'sessionTimeline')
  if (kind === 'rejection') read.mockRejectedValue(new Error('timeline unavailable'))
  else read.mockResolvedValue({ agentSessionId: 'foreign', revision: 0, items: [] })
  const stop = vi.spyOn(core, 'stopAgent'), discard = vi.spyOn(topics, 'discardPreparedIdentity')
  const result = await launchDirect()
  expect(result.created).toMatchObject({ agentSessionId: 'direct-created', run: { runId: 'projection-run-1' } })
  expect(result.session).toMatchObject({ id: 'direct-created', processState: 'running' })
  expect(result.timeline).toBeUndefined()
  expect(result.projectionFailures).toEqual([{ step: 'timeline', message: expect.stringMatching(/Timeline|timeline/) }])
  expect(starts).toHaveLength(1); expect([...runs.keys()]).toEqual(['projection-run-1'])
  expect(stop).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled()
  const topic = await topics.read(config.workspaces[0]!, topicId)
  expect(await readFile(join(dir, topic!.directoryPath, '.agents', 'projection-fixture.direct-created.identity.md'), 'utf8')).toContain('direct-created')
  await core.writeAgent(result.created.agentSessionId, 'still working')
  expect(writes).toEqual(['still working'])
})
it('mounted Pane retains confirmed input and re-reads its Timeline through registered Main/Core without another create', async () => {
  const timeline = vi.spyOn(core, 'sessionTimeline').mockRejectedValue(new Error('Timeline reader offline'))
  const stop = vi.spyOn(core, 'stopAgent')
  const before = useAppStore.getState(), id = await launch()
  await pane(id)
  expect(container.textContent).toContain('Timeline reader offline')
  expect(container.querySelector('[data-live-terminal]')).not.toBeNull()
  const state = useAppStore.getState(); expect(state.layouts).toEqual(before.layouts)
  expect(state.dirtyDocuments).toBe(before.dirtyDocuments); expect(state.documents).toBe(before.documents)
  await api.sessions.write(state.sessions[0]!.control, 'healthy input')
  expect(writes).toEqual(['healthy input']); expect(stop).not.toHaveBeenCalled()
  await act(async () => useAppStore.getState().setAgentComposerDraft(id, 'composer action'))
  const editor = container.querySelector<HTMLElement>('[contenteditable="true"]')
  expect(editor).not.toBeNull()
  await act(async () => editor!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true,
    bubbles: true, cancelable: true })))
  await act(async () => useAppStore.getState().flushAgentSteerQueue(id))
  expect(writes).toEqual(['healthy input', 'composer action\r'])
  timeline.mockRestore()
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('Check again'))
  expect(button).toBeDefined(); await act(async () => button!.click())
  await vi.waitFor(() => expect(useAppStore.getState().pendingAgentLaunches[id]).toBeUndefined())
  expect(useAppStore.getState().timelines[id]?.agentSessionId).toBe(id)
  expect(starts).toHaveLength(1); expect(container.textContent).not.toContain('Timeline reader offline')
})
it('session observation failure is unknown rather than a perpetual launch and Check again uses the exact accepted identity', async () => {
  const subject = vi.spyOn(core, 'runtimeSubject').mockRejectedValue(new Error('Session observer offline'))
  const stop = vi.spyOn(core, 'stopAgent'), id = await launch()
  await pane(id)
  expect(useAppStore.getState().sessions).toEqual([])
  expect(container.textContent).toContain('Agent created')
  expect(container.textContent).toContain('not yet confirmed')
  expect(container.textContent).not.toContain('Starting your agent')
  expect(container.querySelector('[data-live-terminal]')).toBeNull()
  expect(useAppStore.getState().timelines[id]?.agentSessionId).toBe(id)
  subject.mockRestore()
  await act(async () => useAppStore.getState().refreshSession(id))
  expect(useAppStore.getState().sessions).toEqual([expect.objectContaining({ id, processState: 'running', control: {
    kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'projection-run-1' } } })])
  expect(useAppStore.getState().pendingAgentLaunches[id]).toBeUndefined()
  expect(stop).not.toHaveBeenCalled(); expect(starts).toHaveLength(1)
})
it('a Renderer overflow snapshot rejection never rolls back the accepted healthy Run', async () => {
  const create = core.createAgent.bind(core)
  vi.spyOn(core, 'createAgent').mockImplementation(async input => {
    const result = await create(input)
    useAppStore.setState(state => ({ pendingAgentLaunches: { ...state.pendingAgentLaunches,
      [result.agentSessionId]: { ...state.pendingAgentLaunches[result.agentSessionId]!, overflowed: true } } }))
    return result
  })
  vi.spyOn(api.sessions, 'snapshot').mockRejectedValue(new Error('canonical display unavailable'))
  const stop = vi.spyOn(core, 'stopAgent'), id = await launch()
  await pane(id)
  expect(container.textContent).toContain('canonical display unavailable')
  expect(container.querySelector('[data-live-terminal]')).not.toBeNull()
  expect([...runs.keys()]).toEqual(['projection-run-1']); expect(stop).not.toHaveBeenCalled()
  await api.sessions.write(useAppStore.getState().sessions[0]!.control, 'after canonical failure')
  expect(writes).toEqual(['after canonical failure']); expect([...runs.keys()]).toEqual(['projection-run-1'])
  expect(stop).not.toHaveBeenCalled()
})
it('true creation rejection cleans only its prepared identity and keeps the launcher draft', async () => {
  kernel.start = async () => { throw new Error('actual start rejected') }
  const discard = vi.spyOn(topics, 'discardPreparedIdentity')
  await expect(launchDirect('failed-created')).rejects.toThrow('actual start rejected')
  expect(discard).toHaveBeenCalledTimes(1); expect(runs.size).toBe(0)
  await expect(access(discard.mock.calls[0]![0].identityPath)).rejects.toMatchObject({ code: 'ENOENT' })
  useAppStore.getState().setAgentComposerDraft(regionId, 'keep draft')
  await expect(useAppStore.getState().launchAgent('fixture', 'keep draft', 'projection-group', { tabId: launcherId, regionId })).rejects.toThrow('actual start rejected')
  expect(useAppStore.getState().tabs[launcherId]?.regions[regionId]?.kind).toBe('launcher')
  expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe('keep draft')
})
it('sender disappearance keeps the existing explicit cancellation boundary using the accepted Run', async () => {
  destroyed = true
  const stop = vi.spyOn(core, 'stopAgent')
  await expect(api.sessions.launchAgent({ executorId: 'fixture', hostId: 'local', workspacePath: dir,
    scratchTopicId: topicId, agentSessionId: 'cancel-created' })).rejects.toThrow('Desktop View disappeared')
  expect(stop).toHaveBeenCalledWith('cancel-created', { runId: 'projection-run-1' })
  expect(runs.size).toBe(0)
})

it('Control opening retains its exact new Region when canonical re-reading fails', async () => {
  const create = core.createAgent.bind(core)
  vi.spyOn(core, 'createAgent').mockImplementation(async input => {
    const result = await create(input)
    useAppStore.setState(state => ({ pendingAgentLaunches: { ...state.pendingAgentLaunches,
      [result.agentSessionId]: { ...state.pendingAgentLaunches[result.agentSessionId]!, overflowed: true } } }))
    return result
  })
  vi.spyOn(api.sessions, 'snapshot').mockRejectedValue(new Error('Control display re-read unavailable'))
  const stop = vi.spyOn(core, 'stopAgent')
  const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: 'private-open-projection', operation: 'open.agent', content: { kind: 'new-agent', executorId: 'fixture' },
    destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId } } })
  if (result.operation !== 'open.agent') throw new Error('Unexpected Control operation')
  const id = result.region.agentSessionId
  expect(useAppStore.getState().tabs[result.region.tabId]?.regions[result.region.regionId]).toMatchObject({
    kind: 'agent', phase: 'attached', sessionId: id })
  expect(useAppStore.getState().pendingAgentLaunches[id]?.projectionFailures).toEqual([
    { step: 'session', message: 'Launch display re-read failed: Control display re-read unavailable' } ])
  expect([...runs.keys()]).toEqual(['projection-run-1']); expect(stop).not.toHaveBeenCalled()
})
it('an old creation receipt cannot replace a later canonical Run while display refresh is pending', async () => {
  const timeline = vi.spyOn(core, 'sessionTimeline').mockRejectedValue(new Error('reader offline'))
  const id = await launch(), old = useAppStore.getState().sessions[0]!
  if (old.kind !== 'agent') throw new Error('Expected actual Agent projection')
  const subject = core.runtimeSubject.bind(core)
  let release!: () => void
  const gate = new Promise<void>(done => { release = done })
  let entered = false
  vi.spyOn(core, 'runtimeSubject').mockImplementation(async (...args) => {
    const actual = await subject(...args); entered = true; await gate; return actual
  })
  const refresh = useAppStore.getState().refreshSession(id)
  await vi.waitFor(() => expect(entered).toBe(true))
  // A later authoritative Session projection arrives before the old read returns.
  const newer = { ...old, updatedAt: old.updatedAt + 1, control: { ...old.control, run: { runId: 'later-canonical-run' } } }
  useAppStore.setState({ sessions: [newer] })
  release(); await refresh
  expect(useAppStore.getState().sessions).toEqual([newer])
  expect(starts).toHaveLength(1)
  timeline.mockRestore()
})
