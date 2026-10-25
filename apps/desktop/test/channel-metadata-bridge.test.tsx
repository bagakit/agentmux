import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import type { ChannelMetadataChange, ConnectionConfig, RoomBinding } from '@agentmux/core/connections'
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'

const bridge = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await vi.importActual<typeof import('node:os')>('node:os')
  const { join } = await import('node:path')
  const { EventEmitter } = await import('node:events')
  const { Window } = await import('happy-dom')
  // Main must retain Node's file import URLs while the original reader has a real DOM.
  const window = new Window({ url: 'http://localhost' })
  window.document.write('<!doctype html><html><body></body></html>')
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('navigator', window.navigator)
  const directory = await mkdtemp(join(tmpdir(), 'amux-metadata-bridge-'))
  // Desktop publishes beside the Runtime endpoint, independently of its state/profile paths.
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', directory)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'state'))
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(directory, 'state', 'spatial-state.json'))
  vi.stubEnv('AGENTMUX_DESKTOP_USER_DATA', join(directory, 'profile'))
  vi.stubEnv('AGENTMUX_RPC_HTTP_BIND', undefined); vi.stubEnv('AGENTMUX_RPC_HTTP_TOKEN', undefined)
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return { directory, window, profile: join(directory, 'profile'), socket: join(directory, 'public.sock'),
    events: new EventEmitter(), api: null as AgentMuxPreloadApi | null,
    handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>>(),
    invoke: vi.fn(), releaseMetadata: vi.fn() }
})
vi.mock('node:os', async load => ({ ...await load<typeof import('node:os')>(), homedir: () => join(bridge.directory, 'home') }))
vi.mock('electron', () => ({
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => bridge.profile, getAppPath: () => bridge.profile, isPackaged: false, once: vi.fn() },
  safeStorage: { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false }) },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>) => bridge.handlers.set(channel, handler),
    removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: (key: string, api: AgentMuxPreloadApi) => {
    bridge.api = api; Object.defineProperty(window, key, { value: api, configurable: true })
  } },
  ipcRenderer: { invoke: bridge.invoke, on: (channel: string, listener: (...args: any[]) => void) => bridge.events.on(channel, listener),
    removeListener: (channel: string, listener: (...args: any[]) => void) => bridge.events.removeListener(channel, listener) },
  webFrame: { getZoomFactor: () => 1 }, globalShortcut: { register: () => true, unregister: vi.fn() }, clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, session: {}
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ list: async () => [], snapshot: async () => ({ demands: [] }), subscribe: () => () => {} }) }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
vi.mock('../../../packages/connectors/src/connection-services.js', async load => {
  const actual = await load<typeof import('../../../packages/connectors/src/connection-services.js')>()
  return { ...actual, createConnectionServices: async (options: Parameters<typeof actual.createConnectionServices>[0]) => {
    const owner = await actual.createConnectionServices(options), watch = owner.connections.metadata!.watch
    owner.connections.metadata!.watch = async (...args) => {
      const subscription = await watch(...args)
      return { dispose() { bridge.releaseMetadata(); subscription.dispose() } }
    }
    return owner
  } }
})

import { AgentMuxControlServer, AgentMuxMemoryAgentSessionStore, connectAgentMuxRpc, LocalExecutionHost } from '@agentmux/core'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { registerIpc } from '../src/main/ipc.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { desktopBusinessSocketPath } from '../src/main/desktop-host.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { CONNECTION_METADATA_CHANGED_CHANNEL } from '../src/shared/contracts'
import '../src/preload/index'
import { api } from '../src/renderer/src/lib/api'
import { useConnectorRoomName } from '../src/renderer/src/lib/use-connector-room-name'

const cleanup: Array<() => void | Promise<void>> = []
afterAll(async () => { for (const close of cleanup.reverse()) await close(); bridge.events.removeAllListeners(); await bridge.window.happyDOM.abort(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(bridge.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })
const connection: ConnectionConfig = { connectionId: 'original-connection', adapterId: 'feishu',
  application: { domain: 'open.feishu.cn', appId: 'cli_0123456789abcdef' }, label: 'Original', enabled: false, credentialRef: '' }
const binding = { connectionId: connection.connectionId, application: connection.application, externalConversationId: 'original-room' } as RoomBinding
function RoomName() { const read = useConnectorRoomName(binding); return <output data-loading={read.loading}>{read.label} | {read.issue}</output> }

it('delivers original Host metadata through Main, preload and the mounted reader, then releases both ends', async () => {
  expect(api.connections).toBe(bridge.api!.connections)
  expect(desktopBusinessSocketPath()).toBe(join(bridge.directory, 'control.sock.desktop'))
  expect(desktopBusinessSocketPath()).not.toBe(bridge.socket)
  let groupName = 'Original native group', windowDestroyed = false, contentsDestroyed = false
  // The native SDK is declared by Connectors, rather than a new Desktop dependency.
  const { defaultHttpInstance } = createRequire(resolve(import.meta.dirname, '../../../packages/connectors/package.json'))('@larksuiteoapi/node-sdk') as {
    defaultHttpInstance: { request(input: { url?: string }): Promise<unknown> }
  }
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(async input => {
    if (input.url?.includes('/auth/v3/')) return { code: 0, tenant_access_token: 'owned-transport-token', app_access_token: 'owned-transport-token', expire: 3600 }
    if (input.url?.includes('/im/v1/chats/')) return { code: 0, data: { name: groupName } }
    throw Error('Unexpected original protocol request')
  })
  const send = vi.fn((channel: string, payload: unknown) => bridge.events.emit(channel, {}, payload))
  const sender = Object.assign(new EventEmitter(), { id: 783, isDestroyed: () => contentsDestroyed, send, mainFrame: { framesInSubtree: [] } })
  let holdSnapshot = false, snapshotHeld = false, releaseSnapshot!: () => void
  const snapshotDelay = new Promise<void>(resolve => { releaseSnapshot = resolve })
  bridge.invoke.mockImplementation(async (channel: string, ...args: any[]) => {
    const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function')
    const result = await handler!({ sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent, ...args)
    if (holdSnapshot && channel === 'connections:call' && args[0] === 'connection.metadata.get') {
      holdSnapshot = false; snapshotHeld = true; await snapshotDelay
    }
    return result
  })
  let config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: 'resource', name: 'Owned', hostId: 'local', path: bridge.profile, kind: 'folder' as const }] }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] })
  vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
  // Main borrows the exact Host owner; the real metadata service and wire live at a separate endpoint.
  const services = await createConnectionServices({ directory: join(bridge.directory, 'connections') }); cleanup.push(() => services.close())
  const server = new AgentMuxControlServer({ socketPath: bridge.socket, connections: services.connections }); await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const hostingTarget = { hostId: 'local', runtimeId: 'original-metadata-runtime' }
  vi.spyOn(runtime, 'connectionHostingTarget').mockImplementation(async (hostId = 'local') => { expect(hostId).toBe(hostingTarget.hostId); return hostingTarget })
  vi.spyOn(runtime, 'callConnectionHost').mockImplementation((target, method, params) => { expect(target).toEqual(hostingTarget); return rpc.call(method, params) })
  vi.spyOn(runtime, 'watchConnectionMetadata').mockImplementation((target, handlers) => { expect(target).toEqual(hostingTarget); return rpc.subscribe('connection.metadata.watch', {}, handlers) })
  const dispose = await registerIpc({ initialConfig: config,
    window: { setBackgroundColor: vi.fn(), isDestroyed: () => windowDestroyed, webContents: sender } as unknown as BrowserWindow, runtime,
    workbenchWindows: { setNativeOwner: () => () => {} } as Parameters<typeof registerIpc>[0]['workbenchWindows'],
    configStore: { get: async () => config, validate: (value: typeof config) => value, save: async (value: typeof config) => { config = value; return value } } as never,
    progressLoops: { subscribe: () => () => {} } as never, scratchTopics: { setNameAudit: vi.fn() } as never,
    workspaceFiles: new WorkspaceFiles(() => new LocalExecutionHost()) })
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const subject = { kind: 'conversation' as const, externalConversationId: binding.externalConversationId }
  const change: ChannelMetadataChange = { connectionId: connection.connectionId, application: connection.application, subject }
  const refresh = (target = subject) => rpc.call('connection.metadata.refresh', { connectionId: connection.connectionId, expectedConnectionRevision: 1, subject: target })
  const settled = async (text: string) => { await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toBe(text + ' | '); expect(container.querySelector('output')?.dataset.loading).toBe('false') }) }
  const gets = () => bridge.invoke.mock.calls.filter(([channel, method]) => channel === 'connections:call' && method === 'connection.metadata.get').length
  let released = false, unmounted = false
  try {
    const credential = await services.secrets.store({ operationId: 'original-credential', secret: 'owned-transport-secret' })
    await api.connections.call('connection.configure', { operationId: 'original-configure', expectedRevision: null, connection: { ...connection, credentialRef: credential.credentialRef } })
    await refresh()
    holdSnapshot = true
    await act(async () => root.render(<RoomName />))
    await vi.waitFor(() => expect(snapshotHeld).toBe(true))
    const originalWatchId = bridge.invoke.mock.calls.find(([channel]) => channel === 'connections:metadataStart')?.[1]
    expect(originalWatchId).toBeTypeOf('string')
    expect(bridge.events.listenerCount(CONNECTION_METADATA_CHANGED_CHANNEL)).toBe(1)
    groupName = 'Latest native group while the initial snapshot is pending'
    await act(async () => { await refresh() }); await settled(groupName)
    await act(async () => releaseSnapshot()); await settled(groupName)
    const initialGets = gets()
    await act(async () => { await refresh({ ...subject, externalConversationId: 'another-room' }) })
    expect(gets()).toBe(initialGets)
    groupName = 'Renamed original group'
    await act(async () => { await refresh() }); await settled(groupName)
    expect(send.mock.calls.filter(([channel]) => channel === CONNECTION_METADATA_CHANGED_CHANNEL).at(-1)).toEqual([CONNECTION_METADATA_CHANGED_CHANNEL, { watchId: originalWatchId, change }])
    expect(gets()).toBe(initialGets + 1)
    const surviving = vi.fn(), releaseSurviving = api.connections.onMetadataChanged(surviving)
    await act(async () => root.unmount()); unmounted = true
    expect(bridge.events.listenerCount(CONNECTION_METADATA_CHANGED_CHANNEL)).toBe(1)
    const before = gets()
    await refresh(); await vi.waitFor(() => expect(surviving).toHaveBeenCalledExactlyOnceWith(change)); expect(gets()).toBe(before)
    const delivered = send.mock.calls.length
    windowDestroyed = true; await refresh(); expect(send).toHaveBeenCalledTimes(delivered)
    windowDestroyed = false; contentsDestroyed = true; await refresh(); expect(send).toHaveBeenCalledTimes(delivered)
    contentsDestroyed = false
    releaseSurviving(); expect(bridge.events.listenerCount(CONNECTION_METADATA_CHANGED_CHANNEL)).toBe(0)
    await vi.waitFor(() => expect(bridge.releaseMetadata).toHaveBeenCalledTimes(2))
    await bridge.invoke('notesStorage:inspect')
    await dispose(); released = true
    expect(bridge.handlers.size).toBe(0)
  } finally {
    releaseSnapshot()
    if (!unmounted) await act(async () => root.unmount())
    container.remove()
    if (!released) await dispose()
  }
})
