import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'

const fixture = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await vi.importActual<typeof import('node:os')>('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'amux-secret-startup-'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(root, 'state', 'spatial-state.json'))
  vi.stubEnv('AGENTMUX_DESKTOP_USER_DATA', join(root, 'profile'))
  vi.stubEnv('AGENTMUX_RPC_HTTP_BIND', undefined); vi.stubEnv('AGENTMUX_RPC_HTTP_TOKEN', undefined)
  return { root, profile: join(root, 'profile'), socket: join(root, 'business.sock'),
    handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: any[]) => any>() }
})
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => join(fixture.root, 'home') }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => fixture.profile, getAppPath: () => fixture.profile },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: any[]) => any) => fixture.handlers.set(channel, handler),
    removeHandler: (channel: string) => fixture.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, session: {} }))
// Keep the real Main registration and RPC service. Only replace its endpoint with this fixture's socket.
vi.mock('@agentmux/core', async load => {
  const actual = await load<typeof import('@agentmux/core')>()
  return { ...actual, AgentMuxControlServer: class extends actual.AgentMuxControlServer {
    constructor(options: ConstructorParameters<typeof actual.AgentMuxControlServer>[0]) { super(options, fixture.socket) }
  } }
})
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ list: async () => [], snapshot: async () => ({ demands: [] }), subscribe: () => () => {} }) }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))

import { AgentMuxMemoryAgentSessionStore, connectAgentMuxRpc, LocalExecutionHost } from '@agentmux/core'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { ClientIncidentArchive } from '@agentmux/host/client-incident-archive'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { registerIpc } from '../src/main/ipc.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { AgentMuxError } from '@agentmux/core'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'

afterAll(async () => { vi.unstubAllEnvs(); await rm(fixture.root, { recursive: true }) })
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse }); return { promise, resolve, reject } }

it.each(['availability', 'read'] as const)('publishes the real Main owner while original private receiver %s remains pending', async phase => {
  fixture.profile = join(fixture.root, phase)
  vi.stubEnv('AGENTMUX_DESKTOP_USER_DATA', fixture.profile)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(fixture.profile, 'state'))
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(fixture.profile, 'state', 'spatial-state.json'))
  // Configure the original receiver with synthetic private credentials; native requests wait for its exact secret read.
  const seed = await createConnectionServices({ directory: join(fixture.profile, 'connectors') })
  const operationId = 'credential-' + phase, connectionId = 'connection-' + phase
  const receipt = await seed.secrets.store({ operationId, secret: 'owned-fixture-credential' })
  await seed.connections.configure({ operationId: 'configure-' + phase, expectedRevision: null,
    connection: { connectionId, adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'owned-fixture-app' }, label: 'Owned receiver', enabled: true, credentialRef: receipt.credentialRef } })
  await seed.connections.service!.configure({ operationId: 'enable-' + phase, expectedRevision: 0, service: { enabled: true } })
  seed.close()
  const pending = deferred<any>()
  const observed = phase === 'availability'
    ? vi.spyOn(ConnectionSecrets.prototype, 'assertAvailable').mockImplementation(() => pending.promise)
    : vi.spyOn(ConnectionSecrets.prototype, 'resolve').mockImplementation(() => pending.promise)
  fixture.handlers.clear()
  let config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: 'resource', name: 'Owned', hostId: 'local', path: fixture.profile, kind: 'folder' as const }] }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] })
  vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
  const sender = Object.assign(new EventEmitter(), { id: 783, isDestroyed: () => false, send: vi.fn(), mainFrame: { framesInSubtree: [] } })
  const incidents = new ClientIncidentArchive(join(fixture.profile, 'incidents'))
  const dispose = await registerIpc({ initialConfig: config,
    window: { setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow, runtime,
    workbenchWindows: { setNativeOwner: () => () => {} } as Parameters<typeof registerIpc>[0]['workbenchWindows'],
    configStore: { get: async () => config, validate: (value: typeof config) => value, save: async (value: typeof config) => { config = value; return value } } as never,
    progressLoops: { subscribe: () => () => {} } as never, scratchTopics: { setNameAudit: vi.fn() } as never,
    workspaceFiles: new WorkspaceFiles(() => new LocalExecutionHost()), clientIncidents: incidents })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: fixture.socket } })
  const invoke = (channel: string, value?: unknown) => fixture.handlers.get(channel)!({ sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent, value)
  try {
    await vi.waitFor(() => expect(observed).toHaveBeenCalled())
    expect(await rpc.call('connection.service.get', {})).toMatchObject({ enabled: true })
    expect((await rpc.call('connection.ls', {})).connections.map(row => row.config.connectionId)).toContain(connectionId)
    const discovery = await rpc.call('system.diagnostics.inspect', {})
    expect(discovery.capabilities.some(capability => capability.domain === 'client.incident')).toBe(true)
    expect(await invoke('connections:inspectCredential', operationId)).toEqual(receipt)
    // An unavailable private credential read must also stay local after Main's original endpoint has been published.
    phase === 'availability' ? pending.reject(new AgentMuxError('Original private storage unavailable.', 'CONNECTION_CREDENTIAL_UNAVAILABLE')) : pending.resolve(null)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(await rpc.call('connection.service.get', {})).toMatchObject({ enabled: true })
    expect((await rpc.call('system.diagnostics.inspect', {})).capabilities).toEqual(discovery.capabilities)
  } finally {
    phase === 'availability' ? pending.reject(new AgentMuxError('Original private storage unavailable.', 'CONNECTION_CREDENTIAL_UNAVAILABLE')) : pending.resolve(null)
    await invoke('notesStorage:inspect')
    await rpc.dispose(); await dispose(); await incidents.flush(); vi.restoreAllMocks()
  }
})
