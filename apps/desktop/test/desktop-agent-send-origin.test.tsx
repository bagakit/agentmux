// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { DurableAgentMuxMessageQueue } from '@agentmux/core'
import { app, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig } from '../src/shared/contracts'
import { RuntimeController } from '../src/main/runtime-controller'
import { localRuntimeConnector } from './helpers/local-runtime-connector'

const bridge = vi.hoisted(() => {
  const { mkdtempSync } = process.getBuiltinModule('node:fs')
  const { tmpdir } = process.getBuiltinModule('node:os')
  const { join } = process.getBuiltinModule('node:path')
  const initialHome = mkdtempSync(join(tmpdir(), 'amx-main-origin-home-'))
  return { initialHome, api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, Function>(), directory: initialHome,
  listeners: new Map<string, Set<Function>>(), mainListeners: new Map<string, Function>(), sender: null as unknown, desktopOptions: null as import('@agentmux/core').AgentMuxRpcServiceOptions | null }
})
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => bridge.directory }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  safeStorage: { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: vi.fn(async () => {}), decryptStringAsync: vi.fn(async () => {}) },
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api; Object.defineProperty(window, 'agentmux', { configurable: true, value: api }) } },
  ipcRenderer: { invoke: bridge.invoke, send: (channel: string, ...args: unknown[]) => bridge.mainListeners.get(channel)?.({ sender: bridge.sender }, ...args), on: (channel: string, listener: Function) => { const set = bridge.listeners.get(channel) ?? new Set(); set.add(listener); bridge.listeners.set(channel, set) },
    off: (channel: string, listener: Function) => bridge.listeners.get(channel)?.delete(listener) }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => bridge.directory, getAppPath: () => join(process.cwd(), 'apps/desktop'), isPackaged: false },
  ipcMain: { handle: (channel: string, handler: Function) => bridge.handlers.set(channel, handler), removeHandler: (channel: string) => bridge.handlers.delete(channel), on: (channel: string, listener: Function) => bridge.mainListeners.set(channel, listener), removeListener: (channel: string) => bridge.mainListeners.delete(channel) },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {} }))
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(), AgentMuxControlServer: class { constructor(options: import('@agentmux/core').AgentMuxRpcServiceOptions) { bridge.desktopOptions = options } async start() {} async stop() {} } }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-retired-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} setPresentationWindowOwner() {} } }))
vi.mock('../src/main/native-overlay-windows', () => ({ NativeOverlayWindows: class { dispose() {} resourceProcessIds() { return [] } } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'

import { AgentMuxControlServer as OriginalControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port.js'
import { connectDesktopAgentMuxHost } from '../src/main/desktop-host.js'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import type { AgentMuxControlRequest } from '@agentmux/core'
afterAll(async () => { await rm(bridge.initialHome, { recursive: true, force: true }) })

it.each([true, false])('registered Desktop public send retains the original semantic author and source (managed=%s)', async managed => {
  const f = await rpcOwnerFixture(['sender', 'recipient']); bridge.directory = f.root
  expect(app.getPath('home')).toBe(f.root)
  expect(bridge.initialHome).toMatch(/^\//u)
  const initial = useAppStore.getState()
  const device = { hostId: 'original-host-authority', deviceId: 'local', name: 'Private Desktop' }
  vi.spyOn(f.client, 'connect').mockResolvedValue()
  const submit = vi.spyOn(f.client, 'submitAgentMessage')
  const hosted = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client))
  const host = new OriginalControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: f.coreClients,
    hostedRuntime: () => hosted, operationSource: context => context.caller ? undefined : device })
  await host.start()
  const client = await connectDesktopAgentMuxHost({ id: 'local', kind: 'local', label: 'Private original Host' }, f.store)
  await client.readAgentSessions()
  const controller = new RuntimeController(f.store, localRuntimeConnector)
  controller.commit({ hosts: [{ id: 'local', config: { id: 'local', kind: 'local', label: 'Private original Host' }, client,
    executionHost: { kind: 'local', dispose: vi.fn() } as never }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(controller, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config = structuredClone(composerConfig)
  const sender = Object.assign(new EventEmitter(), { id: 198, isDestroyed: () => false,
    send: (channel: string, value: unknown) => { for (const listener of bridge.listeners.get(channel) ?? []) listener({}, value) } })
  bridge.sender = sender
  const window = { setBackgroundColor: vi.fn(), webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
  let dispose: (() => Promise<void>) | undefined, releaseRenderer: (() => void) | undefined, rpc: AgentMuxRpcService | undefined
  try {
    dispose = await registerIpc({ initialConfig: config, window, runtime: controller,
      workbenchWindows: { setNativeOwner: () => () => {}, windowForDocument: () => window, presentationWindow: () => window } as never,
      configStore: { get: async () => config, validate: (next: AppConfig) => next, save: async (next: AppConfig) => next } as never,
      progressLoops: { subscribe: () => () => {} } as never, scratchTopics: { setNameAudit: vi.fn() } as never,
      workspaceFiles: { read: vi.fn(), listFiles: vi.fn(), dispose: async () => {} } as never })
    bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => bridge.handlers.get(channel)!({ sender } as unknown as IpcMainInvokeEvent, ...args))
    useAppStore.setState({ config, sessions: [composerSession('sender'), composerSession('recipient')], closingWorkbenchViews: {} })
    const { api } = await import('../src/renderer/src/lib/api')
    const operations: string[] = []
    releaseRenderer = api.control.onRequest((request, signal) => {
      operations.push(request.operation)
      return useAppStore.getState().executeControl(request as AgentMuxControlRequest, signal)
    })
    expect(bridge.desktopOptions).not.toBeNull()
    rpc = new AgentMuxRpcService(bridge.desktopOptions!)
    const params = { target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Original public default message',
      operationId: 'private-original-control', messageId: 'private-original-message', sourceChannel: 'cli' as const }
    const context = { principal: { kind: 'user' as const, id: 'private-desktop-user' }, transport: 'unix' as const,
      ...(managed ? { caller: f.credentials } : {}) }
    const outcome = await rpc.call('agent.send', params, context).then(value => ({ value, error: null }), error => ({ value: null, error }))
    expect(outcome.error).toBeNull()
    expect(outcome.value).toMatchObject({ messageId: params.messageId, delivery: { state: 'delivered' }, sourceChannel: 'cli',
      ...(managed ? {} : { sourceDevice: device }) })
    expect(operations).not.toContain('send')
    expect(submit).toHaveBeenCalledOnce()
    expect(submit.mock.calls[0]![0]).toMatchObject({ envelope: { messageId: params.messageId, body: params.text,
      sender: managed ? { kind: 'agent-session', agentSessionId: 'sender' } : { kind: 'human', principal: 'local-cli' } }, sourceChannel: 'cli' })
    expect(submit.mock.calls[0]![0].sourceDevice).toEqual(managed ? undefined : device)
    const writes = f.inner.kernel.input as ReturnType<typeof vi.fn>, queue = new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath())
    const applied = structuredClone(writes.mock.calls)
    expect(applied.length).toBeGreaterThan(0)
    expect(applied.map(call => call[1].data).join('').split(params.text)).toHaveLength(2)
    const original = (await queue.listAfter())[0]!
    expect(original.sourceDevice).toEqual(managed ? undefined : device)
    const claim = await f.client.inspectAgentPromptSubmission({ kind: 'message', agentSessionId: 'recipient',
      expectedRun: { runId: 'run-recipient' }, messageId: params.messageId })
    expect(claim?.admission?.intent?.message?.authorHuman).toBeUndefined()
    expect(claim?.admission?.intent?.message?.authorAgentSessionId).toEqual(managed ? 'sender' : undefined)
    const retry = await rpc.call('agent.send', { ...params, operationId: 'another-control-request' }, context)
    expect(retry.receiptId).toBe(outcome.value!.receiptId)
    expect(retry.envelope).toEqual(outcome.value!.envelope)
    expect(writes.mock.calls).toEqual(applied)
    await expect(rpc.call('agent.send', { ...params, text: 'Changed body' }, context)).rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })
    await expect(rpc.call('agent.send', { ...params, sourceChannel: 'api' }, context)).rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })
    await expect(rpc.call('agent.send', { ...params, sourceDevice: device } as never, context)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    if (managed) await expect(rpc.call('agent.send', { ...params, messageId: 'forged-author', operationId: 'forged-operation' },
      { ...context, caller: { ...f.credentials, capability: 'not-the-original-capability' } })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    expect(await queue.listAfter()).toHaveLength(1)
    expect(writes.mock.calls).toEqual(applied)
  } finally {
    releaseRenderer?.(); await rpc?.dispose(); await dispose?.(); await controller.dispose(); await client.dispose()
    await host.stop(); await hosted.dispose()
    try { await f.close() } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
      await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
    useAppStore.setState(initial, true)
    bridge.handlers.clear(); bridge.listeners.clear(); bridge.mainListeners.clear(); bridge.desktopOptions = null
    vi.restoreAllMocks(); vi.unstubAllEnvs()
  }
}, 20_000)
