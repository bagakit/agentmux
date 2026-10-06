const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../../scripts/lib/fixture-values.mjs"))
import { localRuntimeConnector } from './local-runtime-connector.js'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { AgentMuxError, AgentMuxMemoryAgentSessionStore, type AgentMuxClient, type AgentMuxAgentSessionStore } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AgentSessionControl, AppConfig } from '../../src/shared/contracts'
import type { ConfigStore } from '../../src/main/config-store'
import { ScratchTopics } from '../../src/main/scratch-topics'
import { WorkspaceFiles } from '../../src/main/workspace-files'
import { LocalExecutionHost } from '@agentmux/core'
import { RuntimeController } from '../../src/main/runtime-controller'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null,
  directory: '', invoke: vi.fn(), handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, Set<(...args: unknown[]) => void>>() }))
export { bridge }
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  contextBridge: { exposeInMainWorld: (name: string, api: AgentMuxPreloadApi) => {
    bridge.api = api
    if (typeof window !== 'undefined') Object.assign(window, { [name]: api })
  } },
  ipcRenderer: { invoke: bridge.invoke,
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      const listeners = bridge.listeners.get(channel) ?? new Set()
      listeners.add(listener); bridge.listeners.set(channel, listeners)
    },
    off: (channel: string, listener: (...args: unknown[]) => void) => bridge.listeners.get(channel)?.delete(listener),
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => bridge.listeners.get(channel)?.delete(listener),
    send: vi.fn() },
  webFrame: { getZoomFactor: () => 1 }, app: { getPath: () => bridge.directory, getAppPath: () => bridge.directory },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => bridge.handlers.set(channel, handler),
    removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} }
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ subscribe: () => () => {} }) }))
vi.mock('../../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import '../../src/preload/index'
import { registerIpc } from '../../src/main/ipc'
import { DEFAULT_CONFIG } from '../../src/main/config-store'

export const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: 'private-agent', run: { runId: 'old-run' } }

export async function owningBridge(actual?: { client: AgentMuxClient; store: AgentMuxAgentSessionStore; config: AppConfig; scratchTopics?: ScratchTopics }) {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amux-first-execution-ipc-"))
  bridge.directory = root
  await mkdir(join(root, 'Local Storage', 'leveldb'), { recursive: true })
  const runtime = new RuntimeController(actual?.store ?? new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector, actual?.scratchTopics)
  const durable = { kind: 'agent', agentSessionId: control.agentSessionId, providerId: 'codex', executorId: 'private',
    hostId: 'local', workspacePath: _hygiene_fixturePath("private/fixture"), run: control.run, retiredRuns: [],
     createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 2) }
  const canonical = { ...durable, run: { runId: 'canonical-run' } }
  const client = actual?.client ?? { connect: vi.fn().mockResolvedValue(undefined), onEvent: vi.fn().mockReturnValue(vi.fn()),
    submitAgentMessage: vi.fn().mockResolvedValue(undefined),
    submitAgentPrompt: vi.fn().mockResolvedValue(undefined),
    statusAgent: vi.fn(async () => ({ session: durable, run: { runId: control.run.runId, state: 'running' } })),
    agentSession: vi.fn().mockReturnValue(durable),
    ensureAgentContinuity: vi.fn().mockResolvedValue({ kind: 'conflict', agentSessionId: control.agentSessionId,
      previousRun: control.run, currentRun: canonical.run, reason: 'session-run-changed', evidence: { kind: 'agent-session-store' } }),
    runtimeSubject: vi.fn().mockResolvedValue({ subjectId: 'private-agent', kind: 'agent', hostId: 'local',
      workspacePath: durable.workspacePath, providerId: 'codex', executorId: 'private', agentSession: canonical,
      run: { runId: canonical.run.runId, state: 'running', pid: 123, observedAt: _reshape_fixtureEpoch(0, 0, 3), latestOutputBytes: 0 } }),
    providers: { get: () => ({ catalog: { capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' } } }) } }
  runtime.commit({ hosts: [{ id: 'local', client: client as unknown as AgentMuxClient,
    executionHost: { kind: 'local', dispose: vi.fn() } as never, config: actual?.config.hosts.find(host => host.id === 'local') ?? { id: 'local', kind: 'local', label: 'Private Host' } }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config: AppConfig = actual?.config ?? { ...structuredClone(DEFAULT_CONFIG), executors: {
    private: { providerId: 'codex', label: 'Private', command: _hygiene_fixturePath("private/codex"), args: [], env: {}, injectAgentMuxGuide: false }
  } }
  const flush = vi.fn(() => {})
  const pauseTarget = vi.fn().mockResolvedValue(undefined)
  const sender = Object.assign(new EventEmitter(), { id: 771, isDestroyed: () => false, isLoadingMainFrame: () => false,
    send: vi.fn((channel: string, value: unknown) => {
      for (const listener of bridge.listeners.get(channel) ?? []) listener({}, structuredClone(value))
    }),
    session: { flushStorageData: flush, getStoragePath: () => root } })
  let release: () => Promise<void>
  try { release = await registerIpc({ initialConfig: config, window: { setBackgroundColor: vi.fn(), id: 77, webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow, runtime,
    configStore: { get: async () => config, validate: (input: AppConfig) => input, save: async (input: AppConfig) => input } as unknown as ConfigStore,
    progressLoops: { pauseTarget, subscribe: () => () => {} } as never,
    scratchTopics: actual?.scratchTopics ?? new ScratchTopics(), workspaceFiles: new WorkspaceFiles(() => new LocalExecutionHost()) }) }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error }
  const dispose = async () => { try { await release() } finally { await rm(root, { recursive: true, force: true }) } }
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    const handler = bridge.handlers.get(channel)
    expect(handler).toBeTypeOf('function')
    return await handler!({ sender } as unknown as IpcMainInvokeEvent, ...structuredClone(values))
  })
  expect(bridge.api).not.toBeNull()
  return { client, sender, flush, pauseTarget, dispose, runtime }
}
