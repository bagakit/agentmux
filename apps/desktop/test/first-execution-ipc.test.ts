import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxMemoryAgentSessionStore, type AgentMuxClient } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AgentSessionControl, AppConfig } from '../src/shared/contracts'
import type { ConfigStore } from '../src/main/config-store'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'
import { RuntimeController } from '../src/main/runtime-controller'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null,
  invoke: vi.fn(), handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() },
  webFrame: { getZoomFactor: () => 1 }, app: { getPath: () => '/private-first-execution-ipc' },
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
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'

afterEach(() => { vi.restoreAllMocks(); bridge.invoke.mockReset() })
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: 'private-agent', run: { runId: 'old-run' } }

async function owningBridge() {
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
  const durable = { kind: 'agent', agentSessionId: control.agentSessionId, providerId: 'codex', executorId: 'private',
    hostId: 'local', workspacePath: '/private/fixture', run: control.run, retiredRuns: [],
    outputCursorBytes: 0, createdAt: 1, updatedAt: 2 }
  const canonical = { ...durable, run: { runId: 'canonical-run' } }
  const client = { connect: vi.fn().mockResolvedValue(undefined), onEvent: vi.fn().mockReturnValue(vi.fn()),
    agentSession: vi.fn().mockReturnValue(durable),
    ensureAgentContinuity: vi.fn().mockResolvedValue({ kind: 'conflict', agentSessionId: control.agentSessionId,
      previousRun: control.run, currentRun: canonical.run, reason: 'session-run-changed', evidence: { kind: 'agent-session-store' } }),
    runtimeSubject: vi.fn().mockResolvedValue({ subjectId: 'private-agent', kind: 'agent', hostId: 'local',
      workspacePath: durable.workspacePath, providerId: 'codex', executorId: 'private', agentSession: canonical,
      run: { runId: canonical.run.runId, state: 'running', pid: 123, observedAt: 3, latestOutputBytes: 0 } }),
    providers: { get: () => ({ catalog: { capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' } } }) } }
  runtime.commit({ hosts: [{ id: 'local', client: client as unknown as AgentMuxClient,
    executionHost: { kind: 'local', dispose: vi.fn() } as never }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), executors: {
    private: { providerId: 'codex', label: 'Private', command: '/private/codex', args: [], env: {}, injectAgentMuxGuide: false }
  } }
  const flush = vi.fn(() => {})
  const sender = Object.assign(new EventEmitter(), { id: 771, isDestroyed: () => false, send: vi.fn(), session: { flushStorageData: flush } })
  const dispose = await registerIpc({ window: { webContents: sender } as unknown as BrowserWindow, runtime,
    configStore: { get: async () => config } as unknown as ConfigStore,
    scratchTopics: {} as ScratchTopics, workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    const handler = bridge.handlers.get(channel)
    expect(handler).toBeTypeOf('function')
    return await handler!({ sender } as unknown as IpcMainInvokeEvent, ...values)
  })
  expect(bridge.api).not.toBeNull()
  return { client, sender, flush, dispose }
}

it('actual preload/registered IPC/Main pass one stable intent to Core continuity without a prompt', async () => {
  const { client, dispose } = await owningBridge()
  try {
    await expect(bridge.api!.sessions.recover(control, '/private/fixture', 'stable-intent')).resolves.toMatchObject({
      kind: 'reattachable', session: { id: control.agentSessionId, control: { run: { runId: 'canonical-run' } } }
    })
    expect(client.ensureAgentContinuity).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agentSessionId: control.agentSessionId, expectedRun: control.run, operationId: 'stable-intent', commandOverride: '/private/codex'
    }))
    expect(client.ensureAgentContinuity.mock.calls[0]?.[0]).not.toHaveProperty('prompt')
  } finally { await dispose() }
})

it('actual flush bridge requests the owning Chromium session without calling the void result a disk acknowledgement', async () => {
  const { flush, dispose } = await owningBridge()
  try {
    await expect(bridge.api!.ui.requestStorageFlush()).resolves.toBeUndefined()
    expect(flush).toHaveBeenCalledExactlyOnceWith()
    expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith('ui:requestStorageFlush')
    flush.mockImplementationOnce(() => { throw new Error('private flush request failure') })
    await expect(bridge.api!.ui.requestStorageFlush()).rejects.toThrow('private flush request failure')
  } finally { await dispose() }
})

it('registered flush handler rejects a foreign sender before touching the owning Chromium storage', async () => {
  const { flush, dispose } = await owningBridge()
  try {
    const handler = bridge.handlers.get('ui:requestStorageFlush')
    expect(handler).toBeTypeOf('function')
    expect(() => handler!({ sender: {} })).toThrow('Untrusted storage flush sender')
    expect(flush).not.toHaveBeenCalled()
  } finally { await dispose() }
})
