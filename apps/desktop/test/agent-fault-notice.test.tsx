const { fixtureEpoch: _newTailFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { act } from 'react'
import { type Root } from 'react-dom/client'
import '../src/preload/index'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentDisplayState } from '@agentmux/core'
import type { RuntimeController } from '../src/main/runtime-controller'
import type { ConfigStore } from '../src/main/config-store'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'
import type { SessionSnapshot, RuntimeEvent, RuntimeSnapshot } from '../src/shared/contracts'

// The canonical test config defaults to a web preview. This test exercises the
// actual preload/registered Main path, so choose Desktop before api.ts is loaded.
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))

const fixture = vi.hoisted(() => ({
  directory: '',
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  listeners: new Map<string, Set<(...values: unknown[]) => void>>(),
  invokes: [] as Array<{ channel: string; values: unknown[] }>,
  sender: { id: 1, isDestroyed: () => false, send: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn(), removeListener: vi.fn(), session: { flushStorageData: vi.fn() } },
  dock: { setBadge: vi.fn() }
}))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  app: { getAppPath: () => resolve('apps/desktop'), getPath: () => fixture.directory, dock: fixture.dock },
  contextBridge: { exposeInMainWorld: (key: string, value: unknown) => Object.assign(window, { [key]: value }) },
  webFrame: { getZoomFactor: () => 1 },
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => fixture.handlers.set(channel, handler),
    removeHandler: (channel: string) => fixture.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn()
  },
  ipcRenderer: {
    async invoke(channel: string, ...values: unknown[]) {
      fixture.invokes.push({ channel, values })
      const handler = fixture.handlers.get(channel)
      if (!handler) throw new Error(`No registered Main handler: ${channel}`)
      return await handler({ sender: fixture.sender } as unknown as IpcMainInvokeEvent, ...values)
    },
    on(channel: string, listener: (...values: unknown[]) => void) {
      const listeners = fixture.listeners.get(channel) ?? new Set()
      listeners.add(listener); fixture.listeners.set(channel, listeners)
    },
    removeListener: (channel: string, listener: (...values: unknown[]) => void) => fixture.listeners.get(channel)?.delete(listener),
    off: (channel: string, listener: (...values: unknown[]) => void) => fixture.listeners.get(channel)?.delete(listener),
    send: vi.fn()
  },
  safeStorage: { isEncryptionAvailable: () => false }, clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} }
}))
vi.mock('../src/main/connector-host', () => ({ createDesktopConnections: async () => ({ connections: {}, secrets: {}, close() {} }) }))
vi.mock('@agentmux/core/notebook-store', async importOriginal => {
  const actual = await importOriginal<typeof import('@agentmux/core/notebook-store')>()
  return { ...actual, AgentMuxNotesStorage: class extends actual.AgentMuxNotesStorage {
    constructor() { super(join(fixture.directory, 'notes-location.json'), join(fixture.directory, 'notes')) }
  } }
})
// Only native/unrelated owners are isolated. App, Store, rollup, preload and registered Main run.
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ list: async () => [], subscribe: () => () => {} }) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'isolated-journal.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ notify: () => ({ status: 'shown', presentation: 'as-requested' }), dispose() {} }) }))
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))

// Real desktop API must be exposed before api.ts chooses its existing platform binding.
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { currentNotificationRows, notificationEventRows, notificationTrigger, toggleNotificationCenter } from './helpers/notification-center'
import { SESSION_EVENT_CHANNEL } from '../src/shared/contracts'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'

const initial = useAppStore.getState(), originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
let mounted: { root: Root; element: HTMLDivElement } | undefined
let dispose: (() => Promise<void>) | undefined
let sessions: SessionSnapshot[]
const submit = vi.fn(), snapshot = vi.fn(), stop = vi.fn(), recover = vi.fn()
function agent(id: string, state: AgentDisplayState): SessionSnapshot {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: _hygiene_fixturePath("repo"),
    promptSubmissionPredecessor: null, agentSessionUpdatedAt: _newTailFixtureEpoch(0, 0, 1), label: id, createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1), latestOutputBytes: 0, processState: 'running',
    status: { state, source: 'native-hook', observedAt: Date.now() },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } } }
}
function terminal(): SessionSnapshot {
  return { id: 'terminal', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: _hygiene_fixturePath("repo"), label: 'terminal',
    createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1), latestOutputBytes: 0, processState: 'running',
    status: { state: 'waiting', source: 'run-process', observedAt: Date.now() },
    control: { kind: 'terminal', hostId: 'local', runId: 'terminal-run', run: { runId: 'terminal-run' } } }
}
async function settle() { await act(async () => { await new Promise(done => setTimeout(done, 0)) }) }
async function mountApp() {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounted = { root, element }
  const initialize = vi.spyOn(useAppStore.getState(), 'initialize')
  await act(async () => { root.render(<App />) })
  expect(initialize).toHaveBeenCalledOnce()
  await act(async () => { await initialize.mock.results[0]!.value })
  for (let n = 0; n < 30 && useAppStore.getState().loading; n += 1) await settle()
  expect(useAppStore.getState().loading).toBe(false)
  expect(element.querySelector('main.main-shell')).not.toBeNull()
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().sessions.map(session => session.id).sort(), String(useAppStore.getState().error)).toEqual(sessions.map(session => session.id).sort())) })
  await settle()
  return element
}
function canonical(next: SessionSnapshot[]): RuntimeSnapshot {
  return { sessions: next, recoveryCandidates: [], timelines: Object.fromEntries(next.filter(s => s.kind === 'agent').map(s => [s.id,
    { agentSessionId: s.id, revision: 0, items: [] }])) }
}
function processEvent(id = 'waiting', values: Partial<Extract<RuntimeEvent['event'], { type: 'process-state' }>> = {}, hostId = 'local'): RuntimeEvent {
  const current = useAppStore.getState().sessions.find(s => s.id === id)
  const run = current?.control.run ?? { runId: `run-${id}` }
  return { type: 'core', hostId, event: { type: 'process-state', agentSessionId: id, run, state: 'exited', pid: 12,
    exitReason: 'crashed', exitCode: 139, exitSignal: 'SIGSEGV', evidence: { source: 'run-process', observedAt: Date.now() + 100, run }, ...values } }
}
async function emit(event: RuntimeEvent) {
  const listeners = fixture.listeners.get(SESSION_EVENT_CHANNEL)
  expect(listeners?.size).toBeGreaterThan(0)
  await act(async () => { for (const listener of listeners!) listener({}, event) })
  await settle()
}
function notice(element: HTMLElement) { return notificationEventRows(element)[0] ?? null }
function crashed(session: SessionSnapshot): SessionSnapshot {
  return { ...session, processState: 'exited', status: { state: 'error', source: 'run-process', observedAt: Date.now() + 100, exitReason: 'crashed', exitCode: 139, detail: 'signal SIGSEGV' } }
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.directory = await mkdtemp(join(tmpdir(), 'notification-ipc-'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(fixture.directory, 'state'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(fixture.directory, 'runtime'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(fixture.directory, 'messages.ndjson'))
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
  fixture.handlers.clear(); fixture.listeners.clear(); fixture.invokes.length = 0
  fixture.dock.setBadge.mockClear(); submit.mockReset().mockResolvedValue(undefined); stop.mockReset(); recover.mockReset(); snapshot.mockReset().mockImplementation(async () => canonical(sessions))
  sessions = [agent('waiting', 'waiting'), agent('healthy', 'working'), terminal()]
  useAppStore.setState({ ...initial, loading: true, sessions: [terminal()], agentComposerDrafts: { healthy: 'Keep my draft' }, activeWorkspaceId: 'kept-workspace' }, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  const runtime = { resourceSampler: { setObservationSources: () => () => {} },
    observeInputOccupation: () => () => {}, observeCoreEvents: () => () => {}, reserveExecutorConfigEdit: async () => () => {}, setContinuousProgressInputObserver: () => () => {}, setTerminalViewColors: () => {}, prepare: async () => ({}), commit: () => {}, attach: () => () => {},
    runtimeBindings: () => new Map(), endpointWarningSnapshot: () => [], reportBindingSaveFailure: () => {}, providerCatalog: (options?: { observation: true }) => options ? { catalog: [], warnings: [] } : [], sessionHistorySources: async (options?: { observation: true }) => options ? { sources: [], warnings: [] } : [], inspectInput: async () => null, notifyInputOccupation: async () => {}, snapshot, submitPrompt: submit, stop, recover
  } as unknown as RuntimeController
  dispose = await registerIpc({ progressLoops: { subscribe: () => () => {}, pauseTarget: async () => {} } as never, initialConfig: ({ ...structuredClone(DEFAULT_CONFIG), notifications: { mode: 'off' } }), window: { isDestroyed: () => false, setBackgroundColor: vi.fn(), webContents: fixture.sender } as unknown as BrowserWindow, runtime,
    configStore: { validate: (next: unknown) => next, save: async (next: unknown) => next, get: async () => ({ ...structuredClone(DEFAULT_CONFIG), notifications: { mode: 'off' } }) } as unknown as ConfigStore,
    scratchTopics: { listTopics: async () => [], setNameAudit: () => {} } as unknown as ScratchTopics,
    workspaceFiles: { dispose: async () => {}, read: vi.fn(), listFiles: vi.fn(), observe: async () => () => {} } as unknown as WorkspaceFiles })
  expect(fixture.handlers.has('sessions:submitPrompt')).toBe(true)
  // Finish the actual private bootstrap before teardown can remove its files.
  expect((await api.notesStorage.inspect()).directory).toBe(join(fixture.directory, 'notes'))
})
afterEach(async () => {
  try {
    if (mounted) { await act(async () => mounted!.root.unmount()); mounted.element.remove(); mounted = undefined }
    await dispose?.()
  } finally {
    dispose = undefined
    useAppStore.setState(initial, true); vi.restoreAllMocks()
    Object.defineProperty(process, 'platform', originalPlatform)
    vi.unstubAllEnvs(); await rm(fixture.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
})

it('delivers the actual current crash through preload/Store/App as assertive without blocking another healthy Agent', async () => {
  const element = await mountApp(), before = useAppStore.getState()
  expect(before.sessions.map(s => s.id).sort()).toEqual(['healthy', 'terminal', 'waiting'])
  const focus = document.activeElement
  await emit(processEvent())
  expect(notice(element)?.getAttribute('role')).toBe('alert')
  expect(notice(element)?.getAttribute('aria-live')).toBe('assertive')
  expect(notice(element)?.textContent).toContain('Agent "waiting" crashed (signal SIGSEGV, exit code 139)')
  expect(useAppStore.getState().errorNoticeContext).toEqual({ kind: 'agent-broken', subject: before.sessions.find(session => session.id === 'waiting')!.control })
  expect(document.activeElement).toBe(focus)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().sessions.find(s => s.id === 'healthy')).toBe(before.sessions.find(session => session.id === 'healthy'))
  await act(async () => { expect(useAppStore.getState().send('healthy', 'Explicit healthy request', undefined, 'manual', undefined, { execution: 'immediate' })).toBe(true); await useAppStore.getState().flushAgentSteerQueue('healthy') })
  expect(submit).toHaveBeenCalledWith(before.sessions.find(session => session.id === 'healthy')!.control, 'Explicit healthy request', expect.any(String), { expectedRun: before.sessions.find(session => session.id === 'healthy')!.control.run, admissionIntent: { kind: 'manual-actor' } }, undefined, { execution: 'immediate' }, true, undefined, undefined)
  expect(stop).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it.each(['user-stopped', 'unknown', 'interrupted'] as const)('keeps %s nonfatal despite an error-shaped process result', async reason => {
  const element = await mountApp()
  await emit(processEvent('waiting', reason === 'interrupted' ? { state: 'interrupted', exitReason: 'unknown' } : { exitReason: reason }))
  expect(notice(element)).toBeNull()
  expect(useAppStore.getState().errorNoticeContext).toBeNull()
  expect(useAppStore.getState().sessions.find(s => s.id === 'waiting')?.processState).toBe(reason === 'interrupted' ? 'interrupted' : 'exited')
})

it('keeps healthy workflow errors polite and clears the previous crash classification on ordinary errors', async () => {
  const element = await mountApp()
  const healthy = useAppStore.getState().sessions.find(s => s.id === 'healthy')!
  await emit({ type: 'core', hostId: 'local', event: { type: 'agent-error', agentSessionId: healthy.id, code: 'OUTPUT_GAP', message: 'Private replay gap',
    evidence: { source: 'terminal-output', observedAt: Date.now() + 100, run: healthy.control.run } } })
  expect(useAppStore.getState().sessions.find(s => s.id === healthy.id)).toBe(healthy)
  expect(useAppStore.getState().sessions.find(s => s.id === healthy.id)?.status.state).toBe('working')
  expect(useAppStore.getState().sessions.find(s => s.id === healthy.id)?.processState).toBe('running')
  expect(notice(element)?.textContent).toContain('Private replay gap')
  expect(notice(element)?.getAttribute('aria-live')).toBe('polite')
  await emit(processEvent())
  expect(notice(element)?.getAttribute('aria-live')).toBe('assertive')
  await emit({ type: 'core', hostId: 'local', event: { type: 'agent-error', code: 'AGENT_STORE_IO', message: 'Private storage observation failed',
    evidence: { source: 'run-process', observedAt: Date.now() + 200 } } })
  expect(notice(element)?.getAttribute('role')).toBe('status')
  expect(notice(element)?.getAttribute('aria-live')).toBe('polite')
  expect(notice(element)?.textContent).toContain('Private storage observation failed')
  expect(useAppStore.getState().errorNoticeContext).toEqual({ kind: 'indeterminate', summary: 'Host "local": AGENT_STORE_IO: Private storage observation failed' })
})

it.each([false, true])('resets retained crash metadata when startup completes or fails (failure=%s)', async fails => {
  const element = await mountApp()
  await emit(processEvent())
  expect(notice(element)?.getAttribute('aria-live')).toBe('assertive')
  snapshot.mockResolvedValue(canonical(useAppStore.getState().sessions))
  const configuration = fixture.handlers.get('config:get')!
  if (fails) fixture.handlers.set('config:get', () => { throw new Error('Private startup config read failed') })
  let cleanup!: () => void
  await act(async () => { cleanup = await useAppStore.getState().initialize() }); await settle()
  fixture.handlers.set('config:get', configuration)
  expect(useAppStore.getState().errorNoticeContext).toBeNull()
  if (fails) {
    expect(currentNotificationRows(element)[0]?.getAttribute('aria-live')).toBe('polite')
    expect(currentNotificationRows(element)[0]?.textContent).toContain('Private startup config read failed')
    expect(notificationEventRows(element)).toHaveLength(1)
  } else expect(notificationEventRows(element)).toHaveLength(1)
  await act(async () => { cleanup() })
})

it.each(['old-run', 'other-host', 'stale'] as const)('does not announce a %s crash rejected by the actual projection', async cause => {
  const element = await mountApp(), current = useAppStore.getState().sessions.find(session => session.id === 'waiting')!
  const event = processEvent()
  if (event.event.type !== 'process-state') throw new Error('Expected process-state fixture')
  if (cause === 'old-run') event.event.run = { runId: 'old-run' }
  if (cause === 'other-host') event.hostId = 'another-host'
  if (cause === 'stale') event.event.evidence.observedAt = 1
  await emit(event)
  expect(useAppStore.getState().sessions.find(s => s.id === current.id)).toBe(current)
  expect(notice(element)).toBeNull()
})

it('announces a buffered crash after a real membership snapshot through the same accepted Session subscriber', async () => {
  const element = await mountApp(), baseline = canonical(useAppStore.getState().sessions)
  let release!: (value: RuntimeSnapshot) => void
  snapshot.mockImplementationOnce(() => new Promise<RuntimeSnapshot>(done => { release = done }))
  await emit(processEvent('unseen'))
  expect(snapshot).toHaveBeenCalledTimes(2)
  await emit(processEvent())
  expect(notice(element)).toBeNull()
  await act(async () => { release(baseline) }); await settle()
  expect(notice(element)?.getAttribute('role')).toBe('alert')
  expect(notice(element)?.getAttribute('aria-live')).toBe('assertive')
  expect(useAppStore.getState().sessions.map(s => s.id).sort()).toEqual(['healthy', 'terminal', 'waiting'])
  expect(useAppStore.getState().sessions.find(session => session.id === 'waiting')?.status.exitReason).toBe('crashed')
})

it('seeds historical startup crashes quietly but announces a crashed new steady-state member', async () => {
  sessions[0] = crashed(sessions[0]!)
  useAppStore.setState({ sessions: [sessions[0]!, terminal()] })
  const element = await mountApp()
  expect(useAppStore.getState().sessions.find(session => session.id === 'waiting')?.status.exitReason).toBe('crashed')
  expect(notice(element)).toBeNull()
  const admission = crashed(agent('new-member', 'working'))
  snapshot.mockResolvedValueOnce(canonical([...useAppStore.getState().sessions, admission]))
  await emit(processEvent('new-member'))
  expect(useAppStore.getState().sessions.map(s => s.id).sort()).toEqual(['healthy', 'new-member', 'terminal', 'waiting'])
  expect(notice(element)?.getAttribute('aria-live')).toBe('assertive')
  expect(notice(element)?.textContent).toContain('Agent "new-member" crashed')
})

it('keeps an acknowledged exact crash read and treats another current Run as a new event', async () => {
  const element = await mountApp()
  await emit(processEvent())
  const firstMessage = useAppStore.getState().error
  const firstId = notice(element)!.dataset.eventId!
  await toggleNotificationCenter(element, 'open')
  await toggleNotificationCenter(element, 'closed')
  const receipts = useAppStore.getState().noticeReadReceipts
  await emit(processEvent())
  expect(notificationEventRows(element)).toHaveLength(1)
  expect(notificationTrigger(element).getAttribute('aria-expanded')).toBe('false')
  expect(useAppStore.getState().noticeReadReceipts).toEqual(receipts)
  expect(receipts['global:events']?.[firstId]).toBe('read')
  await toggleNotificationCenter(element, 'open')
  expect(notice(element)?.getAttribute('aria-live')).toBe('assertive')
  await toggleNotificationCenter(element, 'closed')
  const previous = useAppStore.getState().sessions.find(session => session.id === 'waiting')!
  if (previous.kind !== 'agent') throw new Error('Expected Agent fixture')
  const fresh: SessionSnapshot = { ...previous, processState: 'running', control: { ...previous.control, run: { runId: 'new-current-run' } }, status: { state: 'working', source: 'native-hook', observedAt: Date.now() } }
  snapshot.mockResolvedValueOnce(canonical(useAppStore.getState().sessions.map(session => session.id === fresh.id ? fresh : session)))
  await emit(processEvent('membership-trigger'))
  expect(useAppStore.getState().sessions.find(session => session.id === 'waiting')?.control.run.runId).toBe('new-current-run')
  expect(notificationEventRows(element)).toHaveLength(1)
  await emit(processEvent())
  expect(useAppStore.getState().error).toBe(firstMessage)
  expect(notificationEventRows(element)).toHaveLength(2)
  expect(notice(element)?.getAttribute('aria-live')).toBe('assertive')
  expect(notice(element)?.dataset.eventId).not.toBe(firstId)
  expect(useAppStore.getState().errorNoticeContext?.subject?.run.runId).toBe('new-current-run')
})
