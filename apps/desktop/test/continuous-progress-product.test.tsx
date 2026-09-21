// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import type { ConfigStore } from '../src/main/config-store'
import type { WorkspaceFiles } from '../src/main/workspace-files'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(),
  storagePath: '',
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
  webFrame: { getZoomFactor: () => 1 }, app: { getPath: () => bridge.storagePath },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} }
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ list: async () => [] }) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
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
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { privateTracker } from './helpers/continuous-progress-tracker'
import { CONTINUOUS_PROGRESS_CHANGED } from '../src/shared/continuous-progress'
import { CONTROL_REQUEST_CHANNEL } from '../src/shared/contracts'

// Target product owners run: Composer → leaf → preload → registered IPC → Main loop → public
// Core ingress; Store initialize installs its actual request handler. Electron transport, startup
// Browser services and Native I/O/screen wait are isolated. No PTY, private renderer or user Run.
const initial = useAppStore.getState()
let directory: string, client: AgentMuxClient, runtime: RuntimeController, manager: ContinuousProgressLoopManager
let disposeIpc: (() => Promise<void>) | undefined, disposeStore: (() => void) | undefined
let root: Root, container: HTMLDivElement, config: AppConfig, session: AgentMuxStoredAgentSession
let writes: string[], cursor: number | null, requests: any[], observations: string[], now: number
let afterInputObservation: (() => Promise<void>) | undefined, corruptReply: boolean, dropReply: boolean
let snapshot: Extract<SessionSnapshot, { kind: 'agent' }>, ended: boolean
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  directory = await mkdtemp(join(tmpdir(), 'amx-progress-product-'))
  bridge.storagePath = join(directory, 'chromium')
  await mkdir(join(bridge.storagePath, 'Local Storage'), { recursive: true })
  await mkdir(join(directory, 'home'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(directory, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'runtime', 'state')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(directory, 'messages.ndjson'))
  writes = []; requests = []; observations = []; cursor = 0; now = 0; ended = false
  corruptReply = false; dropReply = false; afterInputObservation = undefined
  const store = new AgentMuxMemoryAgentSessionStore(), timestamp = Date.now()
  session = { kind: 'agent', agentSessionId: 'progress-agent', hostId: 'local', providerId: 'codex', executorId: 'codex',
    workspacePath: directory, run: { runId: 'progress-run' }, retiredRuns: [], createdAt: timestamp, updatedAt: timestamp,
    hookBindingId: 'owned-binding', hookToken: 'owned-token', semanticStatus: { state: 'done', source: 'native-hook',
      observedAt: timestamp, stateEnteredAt: timestamp } }
  await store.compareAndSwap(null, session)
  client = new AgentMuxClient({ store }); const inner = client as any
  inner.connected = true; await inner.registry.load('local')
  const projection = () => ({ runId: session.run.runId, lifecycleOperationId: null, program: '/private/generic-input', args: [],
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
  vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(0)
  runtime = new RuntimeController(store)
  runtime.commit({ hosts: [{ id: 'local', client, executionHost: { kind: 'local', dispose: vi.fn() } as never }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: '__scratch__', name: 'Owned topics', hostId: 'local', path: directory, kind: 'folder' }] }
  manager = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(directory, 'loops.json')),
    (loop, operationId, isCurrent, signal) => deliverContinuousProgress(runtime, loop, operationId, isCurrent, signal),
    () => now, (loop, tickId, time, signal) => runtime.observeContinuousProgress(loop, tickId, time, signal))
  bridge.sender = Object.assign(new EventEmitter(), { id: 7891, isDestroyed: () => false,
    send: (channel: string, ...args: any[]) => bridge.deliver(channel, ...args), session: { flushStorageData: vi.fn(), getStoragePath: () => bridge.storagePath } })
  bridge.deliver = (channel, ...args) => {
    if (channel === CONTROL_REQUEST_CHANNEL) {
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
    runtime, progressLoops: manager, configStore: { get: async () => config } as unknown as ConfigStore,
    scratchTopics: new ScratchTopics(), workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function')
    return handler!({ sender: bridge.sender } as IpcMainInvokeEvent, ...values)
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
const target = () => ({ hostId: session.hostId, agentSessionId: session.agentSessionId, providerId: session.providerId, workspacePath: session.workspacePath })
async function create() { return await api.continuousProgress.create(target(), 60_000, 'continue the assigned work') }
async function click(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); expect(button).not.toBeNull()
  await vi.waitFor(() => expect(button!.disabled).toBe(false))
  await act(async () => button!.click())
}
it('mounts the existing Composer leaf and real create/pause/resume/check/stop routes, with no second target work', async () => {
  const form = container.querySelector('form'); expect(form).not.toBeNull()
  const textarea = form!.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'continue the assigned work')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(manager.list()).toHaveLength(1))
  await vi.waitFor(() => expect(container.textContent).toContain('active'))
  expect(manager.list()[0]).toMatchObject(target())
  await click('Pause continuous progress'); expect(manager.list()[0]!.status).toBe('paused')
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Resume continuous progress"]')).not.toBeNull())
  await click('Resume continuous progress'); expect(manager.list()[0]!.status).toBe('active')
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Pause continuous progress"]')).not.toBeNull())
  await click('Check continuous progress now')
  await vi.waitFor(() => expect(writes).toEqual(['continue the assigned work', '\r']))
  await vi.waitFor(() => expect(container.textContent).toContain('Host accepted the request'))
  expect(observations.length).toBeGreaterThan(0); expect(new Set(observations)).toEqual(new Set([session.agentSessionId]))
  await click('Stop continuous progress'); expect(manager.list()[0]!.status).toBe('stopped')
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Check continuous progress now"]')).toBeNull())
})
it('keeps an unconfirmed continuation composition through an independent loop notification and submits only the final text', async () => {
  const existing = await create()
  const stopped = await api.continuousProgress.action(target(), existing.loopId, 'stop')
  await vi.waitFor(() => expect(container.querySelector('.continuous-progress-control form')).not.toBeNull())
  const form = container.querySelector<HTMLFormElement>('.continuous-progress-control form')!
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
  await act(async () => bridge.deliver(CONTINUOUS_PROGRESS_CHANGED,
    { ...stopped, lastDecision: 'Fresh stopped-loop observation' }))
  expect(container.textContent).toContain('Fresh stopped-loop observation')
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
  await vi.waitFor(() => expect(created).toHaveBeenCalledExactlyOnceWith(target(), 1_800_000,
    'final confirmed continuation', undefined))
  await vi.waitFor(() => expect(manager.list().find(loop => loop.status === 'active')?.prompt)
    .toBe('final confirmed continuation'))
  expect(useAppStore.getState().agentComposerDrafts).toEqual(drafts)
  expect(useAppStore.getState().agentSteerQueues).toEqual(queues)
  expect(writes).toEqual([])
})
it('keeps an existing draft and queue owned by Store, rejects enabling and pauses an active loop without any Native delivery', async () => {
  const loop = await create()
  await act(async () => useAppStore.getState().setAgentComposerDraft(session.agentSessionId, 'my draft'))
  await vi.waitFor(() => expect(manager.list()[0]!.status).toBe('paused'))
  await expect(api.continuousProgress.action(target(), loop.loopId, 'resume')).rejects.toThrow(/draft|queued/)
  await manager.check(1_000_000)
  expect(writes).toEqual([]); expect(useAppStore.getState().agentComposerDrafts[session.agentSessionId]).toBe('my draft')
  useAppStore.setState({ agentComposerDrafts: {}, agentSteerQueues: { [session.agentSessionId]: [{ operationId: 'owned-message', text: 'my queued message', enqueuedAt: 1, status: 'queued', promptCondition: null }] } })
  await expect(api.continuousProgress.action(target(), loop.loopId, 'resume')).rejects.toThrow(/queued/)
  expect(writes).toEqual([])
})
it('rejects a new automatic claim when real public raw input follows its observation; manual input and its cursor remain intact', async () => {
  const loop = await create()
  afterInputObservation = async () => { await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: 'manual raw' }) }
  await act(async () => manager.checkNow(loop.loopId))
  expect(writes).toEqual(['manual raw']); expect(cursor).toBe(Buffer.byteLength('manual raw'))
  expect(manager.list()[0]).toMatchObject({ lastOutcome: 'skipped' })
  expect(client.agentSession(session.agentSessionId).promptCompletionAdmission).toBeUndefined()
})
it('cancels automatic observation on manual input without waiting for a dropped reply, while keeping raw input usable', async () => {
  const loop = await create(); dropReply = true
  const checking = manager.checkNow(loop.loopId)
  await vi.waitFor(() => expect(observations.length).toBeGreaterThan(1))
  await api.sessions.write(snapshot.control, 'still healthy', 'user')
  expect(writes).toEqual(['still healthy']); expect(manager.list()[0]!.status).toBe('paused')
  await checking
  expect(writes).toEqual(['still healthy']); expect(manager.list()[0]!.lastOutcome).toBe('unknown')
})
it('rejects another Run reply and unknown Native cursor only for automatic admission; no false zero or human failure', async () => {
  const loop = await create(); corruptReply = true
  await manager.checkNow(loop.loopId)
  expect(writes).toEqual([]); expect(manager.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown' })
  corruptReply = false
  await api.continuousProgress.action(target(), loop.loopId, 'resume'); cursor = null
  await manager.checkNow(loop.loopId)
  expect(writes).toEqual([])
  expect(manager.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown' })
  expect(manager.list()[0]!.lastDecision).toMatch(/cursor|input/i)
})

it('keeps a late create result on its original workspace while the same Session Composer target has an enabled, empty form', async () => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const store = (manager as unknown as { store: ContinuousProgressLoopStore }).store
  const originalSave = store.save.bind(store)
  const save = vi.spyOn(store, 'save').mockImplementationOnce(async loops => { await blocked; await originalSave(loops) })
  try {
  const form = container.querySelector('form')!
  const textarea = form.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'original target prompt')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(form.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
  const other = { ...snapshot, workspacePath: join(directory, 'second-workspace') }
  await act(async () => {
    useAppStore.setState({ sessions: [other] })
    root.render(<AgentSessionComposer sessionId={other.id} />)
  })
  const next = container.querySelector('form')!
  const nextText = next.querySelector<HTMLTextAreaElement>('textarea')!
  expect(nextText.value).toBe('')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(nextText, 'new target draft')
    nextText.dispatchEvent(new Event('input', { bubbles: true }))
    release()
  })
  await vi.waitFor(() => expect(manager.list()).toHaveLength(1))
  expect(manager.list()[0]).toMatchObject({ ...target(), prompt: 'original target prompt' })
  expect(next.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
  expect(nextText.value).toBe('new target draft')
  expect(container.querySelector('[aria-label="Pause continuous progress"]')).toBeNull()
  expect(writes).toEqual([])
  } finally { release() }
})


it('binds an explicit real Tracker through the mounted leaf and IPC, keeping done distinct from archived completion', async () => {
  const sourceRoot = join(directory, 'private-tracker'); await mkdir(sourceRoot)
  const tracker = await privateTracker(sourceRoot), binding = await tracker.create('mounted-source')
  await tracker.run('start-task', '--feature', binding.ownerId, '--task', 'T-001')
  const form = container.querySelector('form')!; expect(form).not.toBeNull()
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
  await click('Resume continuous progress')
  await click('Check continuous progress now')
  await vi.waitFor(() => expect(manager.list()[0]!.status).toBe('stopped'))
  await vi.waitFor(() => expect(container.textContent).toContain('business complete (archived)'))
  expect(requests).toEqual([])
}, 30_000)
