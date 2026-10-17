import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig } from '../src/shared/contracts'
import { retiredReopenFixture } from '../../../packages/core/test/fixtures/retired-reopen'
import { RuntimeController } from '../src/main/runtime-controller'
import type { ConfigStore } from '../src/main/config-store'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'
const preload = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, root: '', invoke: vi.fn(), handlers: new Map<string, Function>() }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { preload.api = api } },
  ipcRenderer: { invoke: preload.invoke, on: vi.fn(), removeListener: vi.fn(), off: vi.fn(), send: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => preload.root, getAppPath: () => resolve('apps/desktop'), isPackaged: false },
  ipcMain: { handle: (channel: string, handler: Function) => preload.handlers.set(channel, handler),
    removeHandler: (channel: string) => preload.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, safeStorage: { isAsyncEncryptionAvailable: async () => false }
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} }
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ subscribe: () => () => {} }) }))
vi.mock('../src/preload/theme-bootstrap', () => ({ projectInitialTheme: () => () => {} }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { setPresentationWindowOwner() {} release() {} dispose() {} } }))
vi.mock('../src/main/native-overlay-windows', () => ({ NativeOverlayWindows: class { dispose() {} resourceProcessIds() { return [] } } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks()
  if (errors.length) throw new AggregateError(errors, 'Private reopen fixture cleanup failed: ' + errors.map(String).join('; '))
})
async function owner() {
  const f = await retiredReopenFixture(); cleanups.push(f.close); preload.root = f.root
  const controller = new RuntimeController(f.store, async () => f.client as never)
  cleanups.push(() => controller.dispose())
  // Let the Controller's real asynchronous journal reader establish its initial
  // cut before a short rejected operation can tear down the private directory.
  let observed!: () => void
  const messageObservation = new Promise<void>(resolve => { observed = resolve })
  const onEvent = f.client.onEvent.bind(f.client)
  vi.spyOn(f.client, 'onEvent').mockImplementationOnce((listener, options) => onEvent(event => {
    listener(event)
    if (event.type === 'agent-message-observation' && event.state === 'available') observed()
  }, options))
  const host = { id: 'local', kind: 'local' as const, label: 'Local' }
  controller.commit({ hosts: [{ id: host.id, config: host, client: f.client as never, executionHost: { kind: 'local', dispose: vi.fn() } as never }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), executors: { claude: { providerId: 'claude', label: 'Current Executor',
    command: 'current-private-cli', args: ['--model', 'current-model'], env: { CURRENT_POSTURE: 'configured' }, injectAgentMuxGuide: false } } }
  vi.spyOn(controller, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const sender = Object.assign(new EventEmitter(), { id: 77, isDestroyed: () => false, send: vi.fn() })
  const dispose = await registerIpc({ initialConfig: config, window: { setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow, runtime: controller,
    workbenchWindows: { setNativeOwner: () => () => {} } as never,
    progressLoops: { subscribe: () => () => {} } as never, configStore: { get: async () => config,
      validate: (next: AppConfig) => next, save: async (next: AppConfig) => next } as unknown as ConfigStore,
    scratchTopics: { setNameAudit: vi.fn() } as unknown as ScratchTopics,
    workspaceFiles: { read: vi.fn(), listFiles: vi.fn(), dispose: async () => {} } as unknown as WorkspaceFiles })
  cleanups.push(dispose)
  preload.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const handler = preload.handlers.get(channel); expect(handler).toBeTypeOf('function')
    return structuredClone(await handler!({ sender } as unknown as IpcMainInvokeEvent, ...args))
  })
  await preload.api!.notesStorage.inspect()
  await messageObservation
  return { ...f, controller, config, reference: { hostId: 'local', agentSessionId: f.old.agentSessionId } }
}

it('actual preload, registered IPC and RuntimeController pass current Executor configuration to the original Core', async () => {
  const f = await owner(), next = await preload.api!.sessions.reopen(f.reference, f.retired.observedAt, 'desktop-explicit-continue')
  expect(next.control).toEqual({ kind: 'agent', hostId: 'local', agentSessionId: f.old.agentSessionId, run: { runId: 'new-run-1' } })
  expect(next.kind).toBe('agent'); if (next.kind !== 'agent') throw new Error('Core continuation must project an Agent')
  expect(next.nativeSessionId).toBe('native-main'); expect(f.starts).toHaveLength(1)
  expect(f.starts[0]!.program).toBe('current-private-cli'); expect(f.starts[0]!.args).toContain('current-model')
  expect(f.starts[0]!.env.CURRENT_POSTURE).toBe('configured'); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.stops).toEqual([])
})

it.each(['rejected', 'pending'] as const)('reopens the original Session without reading an unrelated %s Host or scanning other Sessions', async failure => {
  const f = await owner()
  let release!: () => void
  const pending = new Promise<never>((_resolve, reject) => { release = () => reject(new Error('Private unrelated read released')) })
  void pending.catch(() => {})
  let observed!: () => void
  const unrelatedObserved = new Promise<{ kind: 'unrelated-read' }>(resolve => { observed = () => resolve({ kind: 'unrelated-read' }) })
  const unrelatedRead = vi.fn(async () => {
    observed()
    if (failure === 'pending') return await pending
    throw new AgentMuxError('Private unrelated owner protocol rejected.', 'CONTROL_PROTOCOL_ERROR')
  })
  const host = { id: 'unrelated', kind: 'ssh' as const, label: 'Unrelated', hostname: 'unrelated.invalid' }
  f.controller.commit({ hosts: [{ id: host.id, config: host,
    client: { sessionHistorySources: unrelatedRead, connect: vi.fn(), onEvent: () => () => {}, dispose: async () => { release() } } as never,
    executionHost: { kind: 'ssh', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const source = vi.spyOn(f.client, 'sessionHistorySources')
  const exact = vi.spyOn(f.store, 'readHistorySource')
  const allRetired = vi.spyOn(f.store, 'loadRetiredAgentSessions')
  const actualReopen = f.client.reopenAgent.bind(f.client)
  let preflightScans = -1
  const reopen = vi.spyOn(f.client, 'reopenAgent').mockImplementation(async input => {
    preflightScans = allRetired.mock.calls.length
    return await actualReopen(input)
  })
  // Observe a forbidden read immediately instead of timing out a pending Host.
  const continuing = preload.api!.sessions.reopen(f.reference, f.retired.observedAt, 'exact-host-continue')
  try {
    const result = await Promise.race([continuing.then(next => ({ kind: 'reopened' as const, next }), error => ({ kind: 'failed' as const, error })), unrelatedObserved])
    expect(result.kind).toBe('reopened')
    if (result.kind !== 'reopened') throw new Error('The original Host must settle independently')
    const next = result.next
    expect(next.control).toEqual({ kind: 'agent', hostId: 'local', agentSessionId: f.old.agentSessionId, run: { runId: 'new-run-1' } })
    expect(next.workspacePath).toBe(f.old.workspacePath)
    expect(next.kind).toBe('agent'); if (next.kind !== 'agent') throw new Error('The original Agent must be projected')
    expect(next.nativeSessionId).toBe(f.old.nativeHandle!.sessionId)
    expect(f.client.agentSession(f.old.agentSessionId).nativeHandle).toEqual(f.old.nativeHandle)
    expect(source).toHaveBeenCalledExactlyOnceWith({ agentSessionId: f.old.agentSessionId })
    expect(exact).toHaveBeenCalledWith(f.old.agentSessionId, undefined)
    expect(preflightScans).toBe(0)
    expect(unrelatedRead).not.toHaveBeenCalled()
    expect(reopen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agentSessionId: f.old.agentSessionId, expectedRetiredAt: f.retired.observedAt, operationId: 'exact-host-continue'
    }))
    expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  } finally { release(); await continuing.catch(() => {}) }
})

it('preserves an original Host source failure as not applied without starting or substituting a Session', async () => {
  const f = await owner()
  vi.spyOn(f.client, 'sessionHistorySources').mockRejectedValueOnce(new AgentMuxError('Original owner protocol rejected.', 'CONTROL_PROTOCOL_ERROR'))
  const reopen = vi.spyOn(f.client, 'reopenAgent')
  await expect(preload.api!.sessions.reopen(f.reference, f.retired.observedAt, 'original-host-failure')).rejects.toMatchObject({
    code: 'CONTROL_PROTOCOL_ERROR', message: 'Original owner protocol rejected.', controlFailure: { disposition: 'not_applied', confirmedInputBytes: null }
  })
  expect(reopen).not.toHaveBeenCalled(); expect(f.starts).toEqual([]); expect(f.stops).toEqual([])
  expect(await f.store.loadRetiredAgentSessions()).toEqual([f.retired])
})

it('rejects an exact Host rebind during the selected source read before dispatch', async () => {
  const f = await owner(), read = f.client.sessionHistorySources.bind(f.client)
  const reopen = vi.spyOn(f.client, 'reopenAgent')
  vi.spyOn(f.client, 'sessionHistorySources').mockImplementationOnce(async options => {
    const sources = await read(options), host = { id: 'local', kind: 'local' as const, label: 'Replacement' }
    f.controller.commit({ hosts: [{ id: host.id, config: host,
      client: { dispose: async () => {}, onEvent: () => () => {} } as never,
      executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
    return sources
  })
  await expect(preload.api!.sessions.reopen(f.reference, f.retired.observedAt, 'host-rebound')).rejects.toMatchObject({
    code: 'CONTROL_UNAVAILABLE', controlFailure: { disposition: 'not_applied', confirmedInputBytes: null }
  })
  expect(reopen).not.toHaveBeenCalled(); expect(f.starts).toEqual([]); expect(f.stops).toEqual([])
  expect(await f.store.loadRetiredAgentSessions()).toEqual([f.retired])
})

it('preserves certain rejection and its no-Run outcome through the real Electron structured-clone boundary', async () => {
  const f = await owner()
  await expect(preload.api!.sessions.reopen(f.reference, f.retired.observedAt + 1, 'stale-desktop-intent')).rejects.toMatchObject({
    code: 'STALE_AGENT_SESSION', controlFailure: { disposition: 'not_applied', confirmedInputBytes: null }
  })
  expect(f.starts).toEqual([]); expect(await f.store.loadRetiredAgentSessions()).toEqual([f.retired])
})

it('a projection failure after apply stays unknown without replaying or revoking the canonical healthy Run', async () => {
  const f = await owner(), status = f.inner.kernel.status.getMockImplementation()!
  f.inner.kernel.status.mockImplementation(async (id: string) => { if (id === 'new-run-1') throw new Error('private projection observation unavailable'); return await status(id) })
  await expect(preload.api!.sessions.reopen(f.reference, f.retired.observedAt, 'projection-unknown')).rejects.toMatchObject({
    controlFailure: { disposition: 'unknown', confirmedInputBytes: null }
  })
  expect(f.client.agentSession(f.old.agentSessionId).run).toEqual({ runId: 'new-run-1' })
  expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('never projects a substituted native result even after the real Core transaction succeeded', async () => {
  const f = await owner(), reopen = f.client.reopenAgent.bind(f.client)
  vi.spyOn(f.client, 'reopenAgent').mockImplementationOnce(async input => ({ ...await reopen(input),
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'foreign-native' } }))
  await expect(preload.api!.sessions.reopen(f.reference, f.retired.observedAt, 'identity-recheck')).rejects.toMatchObject({
    code: 'STALE_AGENT_SESSION', controlFailure: { disposition: 'unknown' }
  })
  expect(f.client.agentSession(f.old.agentSessionId).nativeHandle).toEqual(f.old.nativeHandle)
  expect(f.stops).toEqual([]); expect(f.starts).toHaveLength(1)
})


it('explicit Check again over actual IPC completes only the original prepared Run after lost start ACK', async () => {
  const f = await owner(), operationId = 'desktop-lost-start-ack'
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => { f.starts.push(input); throw new Error('private ACK unavailable') })
  await expect(preload.api!.sessions.reopen(f.reference, f.retired.observedAt, operationId)).rejects.toMatchObject({ controlFailure: { disposition: 'unknown' } })
  expect(await f.client.readAgentSessions()).toEqual([])
  const snapshot = await preload.api!.sessions.reconcileReopen(f.reference, f.retired.observedAt, operationId)
  expect(snapshot.control).toEqual({ kind: 'agent', hostId: 'local', agentSessionId: f.old.agentSessionId, run: { runId: 'new-run-1' } })
  expect(snapshot.kind).toBe('agent'); if (snapshot.kind !== 'agent') throw new Error('Reconciliation must project the original Agent')
  expect(snapshot.nativeSessionId).toBe(f.old.nativeHandle!.sessionId)
  expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
