import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig } from '../src/shared/contracts'
import { retiredReopenFixture } from '../../../packages/core/test/fixtures/retired-reopen'
import { RuntimeController } from '../src/main/runtime-controller'
import type { ConfigStore } from '../src/main/config-store'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'
const preload = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, root: '', invoke: vi.fn(), handlers: new Map<string, Function>() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { preload.api = api } },
  ipcRenderer: { invoke: preload.invoke, on: vi.fn(), removeListener: vi.fn(), off: vi.fn(), send: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => preload.root, getAppPath: () => resolve('apps/desktop'), isPackaged: false },
  ipcMain: { handle: (channel: string, handler: Function) => preload.handlers.set(channel, handler),
    removeHandler: (channel: string) => preload.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} }
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function owner() {
  const f = await retiredReopenFixture(); cleanups.push(f.close); preload.root = f.root
  const controller = new RuntimeController(f.store, async () => f.client as never)
  controller.commit({ hosts: [{ id: 'local', client: f.client as never, executionHost: { kind: 'local', dispose: vi.fn() } as never }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), executors: { claude: { providerId: 'claude', label: 'Current Executor',
    command: 'current-private-cli', args: ['--model', 'current-model'], env: { CURRENT_POSTURE: 'configured' }, injectAgentMuxGuide: false } } }
  vi.spyOn(controller, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const sender = Object.assign(new EventEmitter(), { id: 77, isDestroyed: () => false, send: vi.fn() })
  const dispose = await registerIpc({ window: { webContents: sender } as unknown as BrowserWindow, runtime: controller,
    progressLoops: { subscribe: () => () => {} } as never, configStore: { get: async () => config } as unknown as ConfigStore,
    scratchTopics: {} as ScratchTopics, workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  cleanups.push(dispose)
  preload.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const handler = preload.handlers.get(channel); expect(handler).toBeTypeOf('function')
    return structuredClone(await handler!({ sender } as unknown as IpcMainInvokeEvent, ...args))
  })
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
