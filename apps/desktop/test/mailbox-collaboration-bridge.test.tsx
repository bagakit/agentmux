// @vitest-environment happy-dom
const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, DurableAgentMuxMessageQueue } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, SessionHistoryReference } from '../src/shared/contracts'
import { RuntimeController } from '../src/main/runtime-controller'
import { act } from 'react'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, Function>(), directory: '' }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() },
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api; Object.defineProperty(window, 'agentmux', { configurable: true, value: api }) } },
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

it('the original Mailbox consumes actual Renderer, preload, IPC, configured Core and journal without a Runtime connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-collaboration-ipc-')); bridge.directory = root; vi.stubEnv('AGENTMUX_STATE_DIRECTORY', root)
  const store = new AgentMuxFileAgentSessionStore(join(root, 'agent-sessions.json')), client = new AgentMuxClient({ store })
  const queue = new DurableAgentMuxMessageQueue(client.agentMessageQueuePath())
  const seed = async (id: string, sender = 'owner-agent', recipient = 'worker-agent', replyTo: string | null = null) => queue.append({ messageId: id, operationId: 'operation-' + id, createdAt: _reshape_fixtureEpoch(1),
    sender: { kind: 'agent-session', agentSessionId: sender }, recipient: { kind: 'agent-session', agentSessionId: recipient },
    senderSessionId: sender, senderRunId: 'recorded-run-' + sender, recipientSessionId: recipient, recipientRunId: 'recorded-run-' + recipient,
    threadId: 'original-thread', correlationId: 'correlation-' + id, replyTo, workspaceId: null, body: 'Original journal body ' + id })
  for (const id of ['source-one', 'source-two']) { await seed(id); await queue.openDispatch({ callerAgentSessionId: 'owner-agent', sourceMessageId: id }, async () => {}) }
  await seed('original-reply', 'worker-agent', 'owner-agent', 'source-one')
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('Private Runtime unavailable'))
  const kernel = (client as unknown as { kernel: Record<string, () => Promise<void>> }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name))
  const controller = new RuntimeController(store, localRuntimeConnector)
  controller.commit({ hosts: [{ id: 'private-host', config: { id: 'private-host', kind: 'ssh', label: 'Private', hostname: 'target.invalid' }, client,
    executionHost: { kind: 'ssh', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(controller, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config = structuredClone(DEFAULT_CONFIG), sender = Object.assign(new EventEmitter(), { id: 97, isDestroyed: () => false, send: vi.fn() })
  let dispose: (() => Promise<void>) | undefined, unmount: (() => void) | undefined, container: HTMLDivElement | undefined
  try {
    dispose = await registerIpc({ initialConfig: config, window: { setBackgroundColor: vi.fn(), webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow, runtime: controller,
      configStore: { get: async () => config, validate: (next: AppConfig) => next, save: async (next: AppConfig) => next } as never,
      progressLoops: { subscribe: () => () => {} } as never, scratchTopics: { setNameAudit: vi.fn() } as never,
      workspaceFiles: { read: vi.fn(), listFiles: vi.fn(), dispose: async () => {} } as never })
    bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => { const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function'); return handler!({ sender } as unknown as IpcMainInvokeEvent, ...args) })
    const reference: SessionHistoryReference = { hostId: 'private-host', agentSessionId: 'owner-agent' }
    const original = await client.listDispatches({ participantSessionId: reference.agentSessionId, limit: 1 })
    await expect(bridge.api!.sessions.dispatches(reference, { limit: 1 })).resolves.toEqual({ ...original, hostId: reference.hostId })
    expect(await bridge.api!.sessions.dispatches(reference, { limit: 1, afterSourceMessageId: 'source-one' })).toMatchObject({ dispatches: [{ sourceMessageId: 'source-two' }], nextSourceMessageId: null })
    const detail = await bridge.api!.sessions.dispatch(reference, 'source-one')
    expect(detail).toHaveProperty('source.envelope.body', 'Original journal body source-one'); expect(detail.replies.map(reply => reply.envelope.messageId)).toEqual(['original-reply'])
    expect(detail.identityDiagnostics.length).toBeGreaterThan(0)
    await expect(bridge.api!.sessions.dispatch({ ...reference, agentSessionId: 'stranger' }, 'source-one')).rejects.toMatchObject({ code: 'DISPATCH_PARTICIPANT_MISMATCH' })
    await expect(bridge.api!.sessions.dispatches({ ...reference, hostId: 'foreign-host' })).rejects.toThrow('not configured')
    const { api } = await import('../src/renderer/src/lib/api'), { SessionMailbox } = await import('../src/renderer/src/components/SessionMailbox')
    const { useAppStore } = await import('../src/renderer/src/store'), { createClientUiRoot } = await import('./helpers/client-ui-render')
    const { composerSession } = await import('./helpers/composer-dom-fixture')
    const session = { ...composerSession('owner-agent'), hostId: reference.hostId, control: { ...composerSession('owner-agent').control, hostId: reference.hostId } }
    useAppStore.setState({ config, sessions: [session] }); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div'); document.body.append(container); const renderRoot = createClientUiRoot(container); unmount = () => renderRoot.unmount()
    await act(async () => renderRoot.render(<SessionMailbox control={session.control} system={{ notices: [], unread: [], acknowledge() {}, available: true } as never} queued={[]} />))
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' }); await act(async () => container!.querySelector('.composer-mailbox')!.dispatchEvent(event))
    await act(async () => container!.querySelector<HTMLButtonElement>('[id$="-collaboration-tab"]')!.click())
    await vi.waitFor(() => expect(container!.querySelector('[data-source-message="source-one"]')).not.toBeNull())
    await act(async () => container!.querySelector<HTMLButtonElement>('[data-source-message="source-one"]')!.click())
    await vi.waitFor(() => expect(container!.querySelector('[data-dispatch-source="source-one"]')).not.toBeNull())
    const body = container.querySelector<HTMLDetailsElement>('[data-message-id="source-one"]')!
    await act(async () => { body.open = true; body.dispatchEvent(new Event('toggle')) })
    expect(container.textContent).toContain('Original journal body source-one'); expect(container.textContent).toContain('recorded-run-owner-agent')
    expect(api.sessions.dispatch).toBeTypeOf('function')
    expect(bridge.invoke.mock.calls.some(([channel]) => channel === 'sessions:dispatch')).toBe(true)
    expect(connect).not.toHaveBeenCalled(); for (const control of controls) expect(control).not.toHaveBeenCalled()
  } finally {
    await act(async () => unmount?.()); container?.remove(); await dispose?.(); await client.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); vi.unstubAllEnvs(); vi.restoreAllMocks()
  }
}, 20_000)

