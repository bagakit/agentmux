// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { afterAll, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import { localRuntimeConnector } from './helpers/local-runtime-connector'

const bridge = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-startup-ipc-'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', directory)
  vi.stubEnv('AGENTMUX_DESKTOP_USER_DATA', directory)
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(directory, 'spatial-state.json'))
  return { directory, api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, Function>() }
})
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => bridge.directory, getAppPath: () => process.cwd() + '/apps/desktop', isPackaged: false, once: vi.fn() },
  ipcMain: { handle: (channel: string, handler: Function) => bridge.handlers.set(channel, handler), removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, globalShortcut: { register: () => true, unregister: vi.fn() }
}))
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(), AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-startup-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} async release() {} setPresentationWindowOwner() {} } }))
vi.mock('../src/main/native-overlay-windows', () => ({ NativeOverlayWindows: class { dispose() {} resourceProcessIds() { return [] } } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import { AgentMuxMemoryAgentSessionStore, AgentProviderRegistry, type AgentMuxClient, type AgentMuxClientEvent } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import '../src/preload/index'

afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(bridge.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })

it('actual preload reads the cached Main connection cut before Renderer startup without a Session or Runtime read', async () => {
  const controller = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  let publish!: (event: AgentMuxClientEvent) => void
  const client = { providers: new AgentProviderRegistry(), connect: vi.fn(), writeAgent: vi.fn(), dispose: vi.fn(),
    onEvent: (listener: typeof publish) => { publish = listener; return () => {} } }
  controller.commit({ hosts: [{ id: 'local', config: { id: 'local', kind: 'local', label: 'Local' },
    client: client as unknown as AgentMuxClient, executionHost: { kind: 'local', dispose: vi.fn() } as never }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const snapshot = vi.spyOn(controller, 'snapshot').mockRejectedValue(new Error('Session membership is still being read'))
  const origin = { kind: 'runtime-connection' as const, boundary: 'core-ctxmux' as const }
  publish({ type: 'connection-state', state: 'retrying', observationOrigin: origin,
    diagnostic: { code: 'CTXMUX_CONNECTION_OBSERVATION_PENDING', message: 'The original Native connection is not yet confirmed.' },
    evidence: { source: 'run-process', observedAt: 1 } })
  const original = controller.endpointWarningSnapshot()
  expect(original).toHaveLength(1)
  vi.spyOn(controller, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const sender = Object.assign(new EventEmitter(), { id: 79, isDestroyed: () => false, send: vi.fn() })
  const config = structuredClone(DEFAULT_CONFIG)
  let dispose: (() => Promise<void>) | undefined
  try {
    dispose = await registerIpc({ initialConfig: config, window: { setBackgroundColor: vi.fn(), webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow,
      runtime: controller, applicationAccess: {} as never, workbenchWindows: { setNativeOwner: () => () => {} } as never,
      configStore: { get: async () => config, validate: (value: typeof config) => value, save: async (value: typeof config) => value } as never,
      scratchTopics: { setNameAudit: vi.fn() } as never, workspaceFiles: { listFiles: async () => [], dispose: async () => {} } as never })
    // Settle the unrelated bootstrap writer before the private fixture is removed.
    await bridge.handlers.get('notesStorage:inspect')!({ sender })
    bridge.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function')
      return structuredClone(await handler!({ sender }, ...args))
    })
    await expect(bridge.api!.sessions.endpointWarnings()).resolves.toEqual(original)
    publish({ type: 'connection-state', state: 'restored', observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'agentmux', observedAt: 2 } })
    await expect(bridge.api!.sessions.endpointWarnings()).resolves.toEqual(original)
    publish({ type: 'connection-state', state: 'restored', observationOrigin: origin, evidence: { source: 'run-process', observedAt: 3 } })
    await expect(bridge.api!.sessions.endpointWarnings()).resolves.toEqual([])
    expect(snapshot).not.toHaveBeenCalled(); expect(client.connect).not.toHaveBeenCalled(); expect(client.writeAgent).not.toHaveBeenCalled()
  } finally { if (dispose) await dispose(); else await controller.dispose() }
})
