// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { AgentMuxApplicationAccessOwner, AgentMuxClient, AgentMuxFileAgentSessionStore, DurableAgentMuxMessageQueue } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, SessionHistoryReference } from '../src/shared/contracts'
import { RuntimeController } from '../src/main/runtime-controller'
import { localRuntimeConnector } from './helpers/local-runtime-connector'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, Function>(), directory: '',
  listeners: new Map<string, Set<Function>>() }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => bridge.directory }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  safeStorage: { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: vi.fn(async () => {}), decryptStringAsync: vi.fn(async () => {}) },
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
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} async release() {} setPresentationWindowOwner() {} } }))
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
  const applicationAccess = new AgentMuxApplicationAccessOwner({ path: join(root, 'application-access.sqlite'),
    resolveHost: async () => { throw new Error('No application endpoint in this read-only fixture') } })
  const queue = new DurableAgentMuxMessageQueue(client.agentMessageQueuePath())
  const body = 'Original journal body\n<amux:a2a from="authored" msg-id="literal">not a platform rewrap</amux:a2a>  '
  const seed = async (id: string, sender = 'sender', recipient = 'reader') => queue.append({ messageId: id, operationId: 'operation-' + id, createdAt: _tailFixtureEpoch(0, 0, 1),
    sender: { kind: 'agent-session', agentSessionId: sender }, recipient: { kind: 'agent-session', agentSessionId: recipient },
    senderSessionId: sender, senderRunId: 'original-sender-run', recipientSessionId: recipient, recipientRunId: null,
    threadId: id, correlationId: id, replyTo: null, workspaceId: null, body })
  await seed('incoming'); await seed('outgoing', 'reader', 'other'); await queue.recordDelivery('outgoing', 'failed', 2, 'Original failure')
  for (const agentSessionId of ['child-a', 'child-b', 'remote-child']) await store.compareAndSwap(null, {
    kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: 'original-' + agentSessionId }, retiredRuns: [], hookBindingId: 'private-hook', hookToken: 'private-token',
    capabilityHash: 'private-capability-hash', createdAt: 1, updatedAt: 1,
    creation: { createOperationId: 'create-' + agentSessionId, initialPrompt: 'not-requested', createdRun: { runId: 'original-' + agentSessionId },
      createdBy: { agentSessionId: 'reader', run: { runId: 'original-creator-run' },
        owner: agentSessionId === 'remote-child' ? { kind: 'runtime', runtimeId: 'original-creator-runtime' } : { kind: 'local' } } }
  })
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
    dispose = await registerIpc({ initialConfig: config, window, runtime: controller, applicationAccess,
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
    // Both relation readers traverse the same Renderer → preload → trusted IPC → exact Host owner.
    // No current Run is supplied, even while Runtime connection is unavailable.
    const bodyRead = vi.spyOn(client, 'readMessage'), storeBefore = await store.loadMetadata()
    const eventsRead = vi.spyOn(client, 'listMessageEvents'), spawnsRead = vi.spyOn(client, 'listAgentSpawns')
    const latest = await api.sessions.messageEvents(reference, { latest: true, limit: 1 })
    expect(latest).toMatchObject({ hostId: 'original-host', participantSessionId: 'reader', latest: true, nextAfterSequence: null })
    expect(latest.events.map(event => [event.sequence, event.kind])).toEqual([[3, 'delivery']])
    expect(latest.nextBeforeSequence).toBe(3)
    const older = await api.sessions.messageEvents(reference, { beforeSequence: latest.nextBeforeSequence!,
      throughSequence: latest.throughSequence, incarnation: latest.incarnation, limit: 1 })
    expect(older.events.map(event => event.messages.map(message => message.messageId))).toEqual([['outgoing']])
    expect(older.beforeSequence).toBe(3); expect(older.nextBeforeSequence).toBe(2)
    expect(JSON.stringify(latest)).not.toContain(body)
    const filteredEvents = await api.sessions.messageEvents(reference, { messageId: 'incoming', afterSequence: 0, limit: 1 })
    expect(filteredEvents.events.map(event => event.messages.map(message => message.messageId))).toEqual([['incoming']])
    await expect(api.sessions.messageEvents(reference, { beforeSequence: 3 })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    await expect(api.sessions.messageEvents(reference, { beforeSequence: 3, throughSequence: latest.throughSequence,
      incarnation: 'another-journal' })).rejects.toMatchObject({ code: 'MESSAGE_EVENT_SOURCE_CHANGED' })
    const created = await api.sessions.spawns(reference, { direction: 'created', limit: 1 })
    expect(created).toMatchObject({ hostId: 'original-host', participantSessionId: 'reader', direction: 'created', creatorRuntimeId: null,
      coverage: { scope: 'selected-owner', history: 'recorded-creations' } })
    expect(created.records.map(record => record.agentSessionId)).toEqual(['child-a'])
    expect(created.nextCursor).not.toBeNull()
    const remaining = await api.sessions.spawns(reference, { direction: 'created', cursor: created.nextCursor!, limit: 1 })
    expect(remaining.records.map(record => record.agentSessionId)).toEqual(['child-b'])
    const creator = await api.sessions.spawns({ ...reference, agentSessionId: 'child-a' }, { direction: 'creator' })
    expect(creator.records.map(record => record.creation.createdBy.agentSessionId)).toEqual(['reader'])
    const remote = await api.sessions.spawns(reference, { direction: 'created', creatorRuntimeId: 'original-creator-runtime' })
    expect(remote.records.map(record => record.agentSessionId)).toEqual(['remote-child'])
    await expect(api.sessions.spawns({ ...reference, agentSessionId: 'child-a' }, { direction: 'creator', cursor: created.nextCursor! })).rejects.toBeDefined()
    for (const [channel, options, read] of [
      ['sessions:messageEvents', { latest: true }, eventsRead], ['sessions:spawns', { direction: 'created' }, spawnsRead]
    ] as const) {
      const before = read.mock.calls.length
      await expect(bridge.handlers.get(channel)!({ sender: {} }, reference, options)).rejects.toThrow('Untrusted')
      expect(read).toHaveBeenCalledTimes(before)
    }
    await expect(api.sessions.messageEvents({ ...reference, hostId: 'replacement-host' })).rejects.toThrow('not configured')
    await expect(api.sessions.spawns({ ...reference, hostId: 'replacement-host' }, { direction: 'creator' })).rejects.toThrow('not configured')
    const sourceFailure = Object.assign(new Error('Original creation journal unavailable'), { code: 'PRIVATE_STORE_UNAVAILABLE' })
    spawnsRead.mockRejectedValueOnce(sourceFailure)
    await expect(api.sessions.spawns(reference, { direction: 'created' })).rejects.toBe(sourceFailure)
    expect(bodyRead).not.toHaveBeenCalled()
    expect(await store.loadMetadata()).toEqual(storeBefore)
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
    await act(async () => unmount?.()); container?.remove(); await dispose?.(); await client.dispose(); await applicationAccess.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); vi.unstubAllEnvs(); vi.restoreAllMocks(); bridge.listeners.clear()
  }
}, 20_000)
