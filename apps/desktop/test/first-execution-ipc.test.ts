const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError, AgentMuxMemoryAgentSessionStore, type AgentMuxClient } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AgentSessionControl, AppConfig } from '../src/shared/contracts'
import type { ConfigStore } from '../src/main/config-store'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'
import { RuntimeController } from '../src/main/runtime-controller'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null,
  directory: '', invoke: vi.fn(), handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() },
  webFrame: { getZoomFactor: () => 1 }, app: { getPath: () => bridge.directory, getAppPath: () => bridge.directory },
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
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amux-first-execution-ipc-"))
  bridge.directory = root
  await mkdir(join(root, 'Local Storage', 'leveldb'), { recursive: true })
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
  const durable = { kind: 'agent', agentSessionId: control.agentSessionId, providerId: 'codex', executorId: 'private',
    hostId: 'local', workspacePath: _hygiene_fixturePath("private/fixture"), run: control.run, retiredRuns: [],
     createdAt: 1, updatedAt: 2 }
  const canonical = { ...durable, run: { runId: 'canonical-run' } }
  const client = { connect: vi.fn().mockResolvedValue(undefined), onEvent: vi.fn().mockReturnValue(vi.fn()),
    submitAgentMessage: vi.fn().mockResolvedValue(undefined),
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
    private: { providerId: 'codex', label: 'Private', command: _hygiene_fixturePath("private/codex"), args: [], env: {}, injectAgentMuxGuide: false }
  } }
  const flush = vi.fn(() => {})
  const pauseTarget = vi.fn().mockResolvedValue(undefined)
  const sender = Object.assign(new EventEmitter(), { id: 771, isDestroyed: () => false, send: vi.fn(),
    session: { flushStorageData: flush, getStoragePath: () => root } })
  let release: () => Promise<void>
  try { release = await registerIpc({ window: { webContents: sender } as unknown as BrowserWindow, runtime,
    configStore: { get: async () => config } as unknown as ConfigStore,
    progressLoops: { pauseTarget, subscribe: () => () => {} } as never,
    scratchTopics: {} as ScratchTopics, workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles }) }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error }
  const dispose = async () => { try { await release() } finally { await rm(root, { recursive: true, force: true }) } }
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    const handler = bridge.handlers.get(channel)
    expect(handler).toBeTypeOf('function')
    return await handler!({ sender } as unknown as IpcMainInvokeEvent, ...values)
  })
  expect(bridge.api).not.toBeNull()
  return { client, sender, flush, pauseTarget, dispose }
}

const message: Parameters<AgentMuxPreloadApi['sessions']['submitMessage']>[1] = {
  envelope: { schema: 'agentmux.a2a.v1', messageId: 'private-agent-message', operationId: 'private-message-operation', createdAt: 1,
    sender: { kind: 'agent-session', agentSessionId: 'private-sender' }, recipient: { kind: 'agent-session', agentSessionId: control.agentSessionId },
    senderSessionId: 'private-sender', senderRunId: 'private-sender-run', recipientSessionId: control.agentSessionId,
    recipientRunId: control.run.runId, body: 'original body', threadId: 'private-thread', correlationId: 'private-correlation', replyTo: null, workspaceId: null },
  condition: { expectedRun: control.run, afterSubmissionId: null }, caller: { agentSessionId: 'private-sender', capability: 'private-capability' }
}

it.each(['AGENT_CAPABILITY_INVALID', 'AGENT_CAPABILITY_STALE_RUN', 'AGENT_PROMPT_INPUT_UNCONFIRMED'])(
  'actual message IPC does not pause a healthy recipient when Core rejects %s', async code => {
    const { client, pauseTarget, dispose } = await owningBridge()
    client.submitAgentMessage.mockRejectedValue(new AgentMuxError('private rejected message', code))
    try {
      await expect(bridge.api!.sessions.submitMessage(control, message)).rejects.toMatchObject({ code })
      expect(client.submitAgentMessage).toHaveBeenCalledExactlyOnceWith({ ...message, agentSessionId: control.agentSessionId })
      expect(pauseTarget).not.toHaveBeenCalled()
    } finally { await dispose() }
  })

it('actual message IPC pauses progress only after the authorized delivery completes', async () => {
  const { client, pauseTarget, dispose } = await owningBridge()
  let complete!: () => void
  client.submitAgentMessage.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve }))
  try {
    const pending = bridge.api!.sessions.submitMessage(control, message)
    await vi.waitFor(() => expect(client.submitAgentMessage).toHaveBeenCalledTimes(1))
    expect(pauseTarget).not.toHaveBeenCalled()
    complete(); await pending
    expect(pauseTarget).toHaveBeenCalledExactlyOnceWith(control, 'Paused for your message.')
  } finally { await dispose() }
})

it('actual preload/registered IPC/Main pass one stable intent to Core continuity without a prompt', async () => {
  const { client, dispose } = await owningBridge()
  try {
    await expect(bridge.api!.sessions.recover(control, _hygiene_fixturePath("private/fixture"), 'stable-intent')).resolves.toMatchObject({
      kind: 'reattachable', session: { id: control.agentSessionId, control: { run: { runId: 'canonical-run' } } }
    })
    expect(client.ensureAgentContinuity).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agentSessionId: control.agentSessionId, expectedRun: control.run, operationId: 'stable-intent', commandOverride: _hygiene_fixturePath("private/codex")
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
    await expect(handler!({ sender: {} })).rejects.toThrow('Untrusted storage flush sender')
    expect(flush).not.toHaveBeenCalled()
  } finally { await dispose() }
})
