// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, DurableAgentMuxMessageQueue } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, SessionHistoryReference } from '../src/shared/contracts'
import { RuntimeController } from '../src/main/runtime-controller'
import { localRuntimeConnector } from './helpers/local-runtime-connector'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, Function>(), directory: '',
  listeners: new Map<string, Set<Function>>() }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => bridge.directory }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() },
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api; Object.defineProperty(window, 'agentmux', { configurable: true, value: api }) } },
  ipcRenderer: { invoke: bridge.invoke, send: vi.fn(), on: (channel: string, listener: Function) => { const set = bridge.listeners.get(channel) ?? new Set(); set.add(listener); bridge.listeners.set(channel, set) },
    off: (channel: string, listener: Function) => bridge.listeners.get(channel)?.delete(listener) }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => bridge.directory, getAppPath: () => join(process.cwd(), 'apps/desktop'), isPackaged: false },
  ipcMain: { handle: (channel: string, handler: Function) => bridge.handlers.set(channel, handler), removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {} }))
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(), AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-retired-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} setPresentationWindowOwner() {} } }))
vi.mock('../src/main/native-overlay-windows', () => ({ NativeOverlayWindows: class { dispose() {} resourceProcessIds() { return [] } } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'

it('the visible bounded hook reaches the original SDK through production Renderer/preload/registered IPC without input or ack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-a2a-data-ipc-')); bridge.directory = root
  for (const name of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(name)) vi.stubEnv(name, undefined)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', root)
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), client = new AgentMuxClient({ store })
  const queue = new DurableAgentMuxMessageQueue(client.agentMessageQueuePath())
  const body = 'Original journal body\n<amux:a2a from="authored" msg-id="literal">not a platform rewrap</amux:a2a>  '
  const seed = async (id: string, sender = 'sender', recipient = 'reader') => queue.append({ messageId: id, operationId: 'operation-' + id, createdAt: _tailFixtureEpoch(0, 0, 1),
    sender: { kind: 'agent-session', agentSessionId: sender }, recipient: { kind: 'agent-session', agentSessionId: recipient },
    senderSessionId: sender, senderRunId: 'original-sender-run', recipientSessionId: recipient, recipientRunId: null,
    threadId: id, correlationId: id, replyTo: null, workspaceId: null, body })
  await seed('incoming'); await seed('outgoing', 'reader', 'other'); await queue.recordDelivery('outgoing', 'failed', 2, 'Original failure')
  const original = await queue.readJournal(), connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('Private Runtime unavailable'))
  const kernel = (client as unknown as { kernel: Record<string, () => Promise<void>> }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name))
  const controller = new RuntimeController(store, localRuntimeConnector)
  controller.commit({ hosts: [{ id: 'original-host', config: { id: 'original-host', kind: 'ssh', label: 'Private', hostname: 'target.invalid' }, client,
    executionHost: { kind: 'ssh', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(controller, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config = structuredClone(DEFAULT_CONFIG)
  const sender = Object.assign(new EventEmitter(), { id: 97, isDestroyed: () => false,
    send: (channel: string, value: unknown) => { for (const listener of bridge.listeners.get(channel) ?? []) listener({}, value) } })
  const window = { setBackgroundColor: vi.fn(), webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
  let dispose: (() => Promise<void>) | undefined, unmount: (() => void) | undefined, container: HTMLDivElement | undefined
  try {
    dispose = await registerIpc({ initialConfig: config, window, runtime: controller,
      workbenchWindows: { setNativeOwner: () => () => {}, windowForDocument: () => window, presentationWindow: () => window } as never,
      configStore: { get: async () => config, validate: (next: AppConfig) => next, save: async (next: AppConfig) => next } as never,
      progressLoops: { subscribe: () => () => {} } as never, scratchTopics: { setNameAudit: vi.fn() } as never,
      workspaceFiles: { read: vi.fn(), listFiles: vi.fn(), dispose: async () => {} } as never })
    bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => bridge.handlers.get(channel)!({ sender } as unknown as IpcMainInvokeEvent, ...args))
    const { api } = await import('../src/renderer/src/lib/api'), { useSessionMessages } = await import('../src/renderer/src/lib/use-session-messages')
    const reference: SessionHistoryReference = { hostId: 'original-host', agentSessionId: 'reader' }
    expect((await api.sessions.listMessages(reference, { direction: 'incoming', limit: 1 })).messages.map(item => item.envelope.messageId)).toEqual(['incoming'])
    expect((await api.sessions.listMessages(reference, { direction: 'outgoing', limit: 1 })).messages[0]).toMatchObject({ envelope: { messageId: 'outgoing' }, delivery: { state: 'failed' } })
    await expect(api.sessions.readMessage(reference, 'incoming')).resolves.toMatchObject({ hostId: reference.hostId, message: { envelope: { messageId: 'incoming', body } } })
    await expect(api.sessions.readMessage({ ...reference, agentSessionId: 'stranger' }, 'incoming')).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
    await expect(api.sessions.listMessages({ ...reference, hostId: 'replacement-host' }, { direction: 'incoming' })).rejects.toThrow('not configured')
    await expect(bridge.handlers.get('sessions:message')!({ sender: {} }, reference, 'incoming')).rejects.toThrow('Untrusted')
    let reading!: ReturnType<typeof useSessionMessages>
    function Probe() { reading = useSessionMessages({ ...reference, direction: 'incoming', enabled: true }); return null }
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.append(container)
    const { createClientUiRoot } = await import('./helpers/client-ui-render'), render = createClientUiRoot(container); unmount = () => render.unmount()
    await act(async () => render.render(<Probe />))
    await vi.waitFor(() => expect(reading.items.map(item => item.envelope.messageId)).toEqual(['incoming']))
    await act(async () => { await seed('new-undelivered') })
    await act(async () => { await reading.refresh() })
    await vi.waitFor(() => expect(reading.items.map(item => item.envelope.messageId)).toEqual(['new-undelivered', 'incoming']))
    expect(bridge.invoke.mock.calls.some(([channel]) => channel === 'sessions:messages')).toBe(true)
    expect(await queue.readJournal()).toEqual([...original, expect.objectContaining({ kind: 'message', envelope: expect.objectContaining({ messageId: 'new-undelivered', body }) })])
    expect(connect).not.toHaveBeenCalled(); for (const control of controls) expect(control).not.toHaveBeenCalled()
  } finally {
    await act(async () => unmount?.()); container?.remove(); await dispose?.(); await client.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); vi.unstubAllEnvs(); vi.restoreAllMocks(); bridge.listeners.clear()
  }
}, 20_000)
