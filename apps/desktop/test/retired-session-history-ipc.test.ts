import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, SessionHistoryReference } from '../src/shared/contracts'
import { RuntimeController } from '../src/main/runtime-controller'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, Function>() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => '/private-retired-history-ipc' },
  ipcMain: { handle: (channel: string, handler: Function) => bridge.handlers.set(channel, handler), removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(), AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
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
  const native = join(root, 'native.jsonl')
  await writeFile(native, JSON.stringify({ sessionId: 'retained-native', uuid: 'native-body', type: 'user', message: { role: 'user', content: 'Original retained input' } }) + '\n')
  const store = new AgentMuxFileAgentSessionStore(join(root, 'agent-sessions.json'))
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'retired-agent', providerId: 'claude', executorId: 'private-claude', hostId: 'private-host', workspacePath: root,
    run: { runId: 'never-controlled-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'private-hook', hookToken: 'private-secret',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'retained-native', transcriptPath: native } }
  await store.compareAndSwap(null, session)
  await store.applyTimelineMutation({ type: 'append', agentSessionId: session.agentSessionId, item: { id: 'captured-body', agentSessionId: session.agentSessionId,
    kind: 'user_message', status: 'complete', source: 'user', createdAt: 100, updatedAt: 100, title: 'Input', content: 'Original captured input' } })
  const reservation = { kind: 'stop' as const, reservationId: 'private-retire', ownerId: 'private-owner', ownerPid: process.pid,
    agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'private-retire-operation', expiresAt: Date.now() + 60_000,
    stopOperation: { daemonInstance: 'private-unconnected', operationKey: 'private-stop', runId: session.run.runId } }
  await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
  const client = new AgentMuxClient({ store })
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('Private Runtime unavailable'))
  const kernel = (client as unknown as { kernel: Record<string, () => Promise<void>> }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name))
  const controller = new RuntimeController(store)
  controller.commit({ hosts: [{ id: 'private-host', client, executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), executors: { 'private-claude': { providerId: 'claude', label: 'Private', command: 'claude', args: [], env: {}, injectAgentMuxGuide: false } } }
  vi.spyOn(controller, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const sender = Object.assign(new EventEmitter(), { id: 91, isDestroyed: () => false, send: vi.fn() })
  let dispose: (() => Promise<void>) | undefined
  try {
    dispose = await registerIpc({ window: { webContents: sender } as unknown as BrowserWindow, runtime: controller,
      configStore: { get: async () => config } as never, progressLoops: { subscribe: () => () => {} } as never,
      scratchTopics: {} as never, workspaceFiles: { dispose: async () => {} } as never })
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
    expect((await bridge.api!.sessions.timeline(reference)).items.map(item => [item.id, item.content])).toEqual([['captured-body', 'Original captured input']])
    await expect(bridge.api!.sessions.historyPage({ ...reference, hostId: 'foreign-host' })).rejects.toThrow('not configured')
    expect(connect).not.toHaveBeenCalled()
    expect(controls).toHaveLength(6)
    for (const control of controls) expect(control).not.toHaveBeenCalled()
  } finally { await dispose?.(); await client.dispose(); await rm(root, { recursive: true, force: true }) }
})
