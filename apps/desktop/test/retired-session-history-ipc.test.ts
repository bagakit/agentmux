// @vitest-environment happy-dom
const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, SessionHistoryReference } from '../src/shared/contracts'
import { RuntimeController } from '../src/main/runtime-controller'
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, Function>(), directory: '' }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => bridge.directory, getAppPath: () => join(process.cwd(), 'apps/desktop'), isPackaged: false },
  ipcMain: { handle: (channel: string, handler: Function) => bridge.handlers.set(channel, handler), removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(), AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-retired-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'

it('reads retired source, native and captured content through actual preload/IPC/Main without a Run lease or Runtime connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-retired-ipc-'))
  bridge.directory = root
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', root)
  const native = join(root, 'native.jsonl')
  await writeFile(native, JSON.stringify({ sessionId: 'retained-native', uuid: 'native-body', type: 'user', message: { role: 'user', content: 'Original retained input' } }) + '\n')
  const store = new AgentMuxFileAgentSessionStore(join(root, 'agent-sessions.json'))
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'retired-agent', providerId: 'claude', executorId: 'private-claude', hostId: 'private-host', workspacePath: root,
    run: { runId: 'never-controlled-run' }, retiredRuns: [], createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1), hookBindingId: 'private-hook', hookToken: 'private-secret',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'retained-native', transcriptPath: native } }
  await store.compareAndSwap(null, session)
  await store.applyTimelineMutation({ type: 'append', agentSessionId: session.agentSessionId, item: { id: 'captured-body', agentSessionId: session.agentSessionId,
    kind: 'user_message', status: 'complete', source: 'user', createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 100), title: 'Input', content: 'Original captured input' } })
  await store.applyTimelineMutation({ type: 'append', agentSessionId: session.agentSessionId, item: { id: 'large-captured', title: 'Large input', agentSessionId: session.agentSessionId, kind: 'user_message', status: 'complete', source: 'user', createdAt: Date.now(), updatedAt: Date.now(), content: 'large budget ' + 'x'.repeat(8000) } })
  const reservation = { kind: 'stop' as const, reservationId: 'private-retire', ownerId: 'private-owner', ownerPid: process.pid,
    agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'private-retire-operation', expiresAt: Date.now() + 60_000,
    stopOperation: { daemonInstance: 'private-unconnected', operationKey: 'private-stop', runId: session.run.runId } }
  await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
  const client = new AgentMuxClient({ store })
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('Private Runtime unavailable'))
  const kernel = (client as unknown as { kernel: Record<string, () => Promise<void>> }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name))
  const controller = new RuntimeController(store, localRuntimeConnector)
  controller.commit({ hosts: [{ id: 'private-host', config: { id: 'private-host', kind: 'ssh', label: 'Private', hostname: 'target.invalid' }, client, executionHost: { kind: 'ssh', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), executors: { 'private-claude': { providerId: 'claude', label: 'Private', command: 'claude', args: [], env: {}, injectAgentMuxGuide: false } } }
  vi.spyOn(controller, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const sender = Object.assign(new EventEmitter(), { id: 91, isDestroyed: () => false, send: vi.fn() })
  let dispose: (() => Promise<void>) | undefined
  try {
    dispose = await registerIpc({ initialConfig: config, window: { setBackgroundColor: vi.fn(), webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow, runtime: controller,
      configStore: { get: async () => config, validate: (next: AppConfig) => next, save: async (next: AppConfig) => next } as never, progressLoops: { subscribe: () => () => {} } as never,
      scratchTopics: { setNameAudit: vi.fn() } as never, workspaceFiles: { read: vi.fn(), listFiles: vi.fn(), dispose: async () => {} } as never })
    bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function')
      return handler!({ sender } as unknown as IpcMainInvokeEvent, ...args)
    })
    expect(bridge.api).not.toBeNull()
    const reference: SessionHistoryReference = { hostId: 'private-host', agentSessionId: 'retired-agent' }
    const sources = await bridge.api!.sessions.historySources()
    expect(sources.map(source => [source.agentSessionId, source.hostId, source.state])).toEqual([['retired-agent', 'private-host', 'retired']])
    expect(sources[0]).not.toHaveProperty('run')
    expect((await bridge.api!.sessions.historyPage(reference)).items.map(item => [item.id, item.contentParts])).toEqual([['native-body', [{ kind: 'text', text: 'Original retained input' }]]])
    expect((await bridge.api!.sessions.timeline(reference)).items.find(item => item.id === 'captured-body')?.content).toBe('Original captured input')
    const capturedQuery = unwrapSessionInputOperationResult(await bridge.api!.sessions.readHistory(reference, { source: 'captured', kind: 'user-message', query: 'captured' }))
    expect(capturedQuery.hostId).toBe('private-host')
    expect(capturedQuery.userMessages?.map(message => [message.agentSessionId, message.content])).toEqual([['retired-agent', 'Original captured input']])
    const nativeQuery = unwrapSessionInputOperationResult(await bridge.api!.sessions.readHistory(reference, { source: 'native', kind: 'user-message', query: 'retained' }))
    expect(nativeQuery.userMessages?.map(message => [message.agentSessionId, message.content, message.source.kind])).toEqual([
      ['retired-agent', 'Original retained input', 'native']])
    const budgetQuery = await bridge.api!.sessions.readHistory(reference, { source: 'captured', kind: 'user-message', limit: 1, maxBytes: 4096 })
    expect(budgetQuery).toMatchObject({ ok: false, error: { code: 'AGENT_SESSION_HISTORY_BUDGET' } })
    if (budgetQuery.ok) throw new Error('Expected the original typed budget receipt')
    const detail = JSON.parse(budgetQuery.error.detail!)
    expect(detail).toMatchObject({ phase: 'query-result', requiredBytes: expect.any(Number), cursor: expect.any(String) })
    expect(detail.requiredBytes).toBeGreaterThan(4096)
    const expanded = unwrapSessionInputOperationResult(await bridge.api!.sessions.readHistory(reference, { source: 'captured', kind: 'user-message', limit: 1, cursor: detail.cursor, maxBytes: detail.requiredBytes }))
    expect(expanded.userMessages?.[0]?.content).toBe('large budget ' + 'x'.repeat(8000))
    const unavailableQuery = await bridge.api!.sessions.readHistory({ ...reference, hostId: 'foreign-host' }, { source: 'captured', kind: 'user-message' })
    expect(() => unwrapSessionInputOperationResult(unavailableQuery)).toThrow('not configured')
    await expect(bridge.api!.sessions.historyPage({ ...reference, hostId: 'foreign-host' })).rejects.toThrow('not configured')
    expect(connect).not.toHaveBeenCalled()
    expect(controls).toHaveLength(6)
    for (const control of controls) expect(control).not.toHaveBeenCalled()
  } finally { await dispose?.(); await client.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); vi.unstubAllEnvs(); vi.restoreAllMocks() }
})
