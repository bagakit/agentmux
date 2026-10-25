import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { spawn } from 'node:child_process'
import { chmod, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../../packages/core/src/index.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
import { ConnectionHost } from '../../../packages/connectors/src/connection-host.js'
import { startAgentMuxHost } from '../../host/src/host.js'
import { registerConnectorIpc } from '../src/main/connector-ipc.js'
import type { ConnectionHostIpc } from '../src/main/connection-host-ipc.js'
import type { AgentMuxPreloadApi } from '../src/shared/contracts.js'
import { CONNECTION_METADATA_CHANGED_CHANNEL, CONNECTION_METADATA_OBSERVATION_CHANNEL } from '../src/shared/contracts.js'
import type { AgentSessionUserMessage } from '@agentmux/core'
import type { RoomBinding } from '@agentmux/core/connections'

const bridge = await vi.hoisted(async () => {
  const { Window } = await import('happy-dom'), { EventEmitter } = await import('node:events')
  const window = new Window({ url: 'http://localhost' })
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('navigator', window.navigator)
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return { window, events: new EventEmitter(), invoke: vi.fn(), api: null as AgentMuxPreloadApi | null }
})
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { bridge.api = api; Object.defineProperty(window, 'agentmux', { value: api, configurable: true }) } },
  ipcRenderer: { invoke: bridge.invoke, on: (channel: string, listener: (...args: any[]) => void) => bridge.events.on(channel, listener), removeListener: (channel: string, listener: (...args: any[]) => void) => bridge.events.removeListener(channel, listener) },
  webFrame: { getZoomFactor: () => 1 }
}))
import '../src/preload/index.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useConnectorRoomName } from '../src/renderer/src/lib/use-connector-room-name.js'
import { channelProfileKey, useChannelActorProfiles } from '../src/renderer/src/lib/use-channel-actor-profiles.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { composerConfig } from './helpers/composer-dom-fixture.js'

const close: Array<() => void | Promise<void>> = []
const originalConfig = useAppStore.getState().config
afterEach(async () => { for (const release of close.splice(0).reverse()) await release(); useAppStore.setState({ config: originalConfig }); bridge.events.removeAllListeners(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const application = { domain: 'open.feishu.cn', appId: 'cli_0123456789abcdef' }
const binding = { connectionId: 'original-connection', application, externalConversationId: 'original-room' } as RoomBinding
const author = { kind: 'external', connectionId: binding.connectionId, actor: { application, idType: 'open_id', userId: 'original-person' } } as Extract<AgentSessionUserMessage['author'], { kind: 'external' }>
function Profiles() {
  const room = useConnectorRoomName(binding), profiles = useChannelActorProfiles([author], { hostId: 'local', sourceHostId: 'local' }, true), person = profiles.get(channelProfileKey(author))
  return <><output data-room>{room.label} | {room.issue}</output><output data-person>{person?.observation?.profile?.name ?? 'unknown'} | {person?.issue ?? ''}</output></>
}

/** Real default Host/Core, SQLite and public transport. Only Runtime and native SDK I/O are controlled. */
async function fixture() {
  useAppStore.setState({ config: composerConfig })
  const original = await rpcOwnerFixture(['metadata-agent'], core); close.push(original.close)
  const directory = join(original.root, 'connections'); await mkdir(directory, { mode: 0o700 })
  const path = join(directory, 'connections.sqlite'), database = new DatabaseSync(path); await chmod(path, 0o600)
  const credential = await new ConnectionSecrets(database).store({ operationId: 'original-credential', secret: 'synthetic-native-secret' }); database.close()
  const runtime = original.inner.kernel; await original.client.dispose()
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = runtime[name]
  })
  const socket = join(original.root, 'metadata.sock')
  const host = await startAgentMuxHost({ store: original.store, socketPath: socket, desktopSocketPath: join(original.root, 'absent-desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile'), connections: { directory } })
  connect.mockRestore(); close.push(() => host.dispose())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } }); close.push(() => rpc.dispose())
  await rpc.call('connection.configure', { operationId: 'original-configure', expectedRevision: null, connection: { connectionId: binding.connectionId, adapterId: 'feishu', application, label: 'Same display name', enabled: false, credentialRef: credential.credentialRef } })
  const owner = (await rpc.call('runtime.owner.identity', {})).owner
  const fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
  let groupName = 'Original native group', personName = 'Original native person'
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(async input => {
    if (input.url?.includes('/auth/v3/')) return { code: 0, tenant_access_token: 'synthetic-transport', app_access_token: 'synthetic-transport', expire: 3600 }
    if (input.url?.includes('/im/v1/chats/')) return { code: 0, data: { name: groupName } }
    if (input.url?.includes('/contact/v3/users/')) return { code: 0, data: { user: { open_id: author.actor.userId, name: personName } } }
    throw Error('Unexpected native protocol request')
  })
  const refresh = (kind: 'actor' | 'conversation') => rpc.call('connection.metadata.refresh', { connectionId: binding.connectionId, expectedConnectionRevision: 1,
    subject: kind === 'actor' ? { kind, actor: author.actor } : { kind, externalConversationId: binding.externalConversationId } })
  return { original, host, rpc, socket, fence, refresh, rename: () => { groupName = 'Renamed native group'; personName = 'Renamed native person' } }
}

async function main(socket: string, connect: typeof core.connectAgentMuxRpc = core.connectAgentMuxRpc) {
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>(), states: string[] = []
  const rpc = await connect({ endpoint: { transport: 'unix', path: socket } }); close.push(() => rpc.dispose())
  const { owner } = await rpc.call('runtime.owner.identity', {})
  const target = { hostId: 'local', runtimeId: owner.runtimeId }, runtimeFence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
  const runtime: ConnectionHostIpc = {
    connectionHostingTarget: async (hostId = 'local') => { expect(hostId).toBe(target.hostId); return target },
    callConnectionHost: (original, method, params) => { expect(original).toEqual(target); return rpc.call(method, params, { runtimeFence }) },
    watchConnectionMetadata: (original, handlers) => { expect(original).toEqual(target); return rpc.subscribe('connection.metadata.watch', {}, { ...handlers, runtimeFence }) }
  }
  const ipc = registerConnectorIpc({ runtime, assertTrusted: () => {}, handleWithEvent: (channel, handler) => { handlers.set(channel, handler) },
    metadata: { publish: (watchId, change) => bridge.events.emit(CONNECTION_METADATA_CHANGED_CHANNEL, {}, { watchId, change }),
      observation: (watchId, state) => { states.push(state); bridge.events.emit(CONNECTION_METADATA_OBSERVATION_CHANNEL, {}, { watchId, state }) } } })
  const release = () => ipc.dispose()
  close.push(release)
  bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel); if (!handler) throw Error('Unexpected IPC channel'); return handler({}, ...args)
  })
  return { release, states }
}

it('refreshes mounted names and actors from the original Host callback through public watch, Main and preload, then releases its listener', async () => {
  const active = new Set<() => void>(), originalSubscribe = ConnectionHost.prototype.onChannelMetadataChanged
  vi.spyOn(ConnectionHost.prototype, 'onChannelMetadataChanged').mockImplementation(function (listener) {
    const release = originalSubscribe.call(this, listener), token = () => {}; active.add(token)
    return () => { active.delete(token); release() }
  })
  const f = await fixture(); await f.refresh('conversation'); await f.refresh('actor')
  const baseline = active.size, ipc = await main(f.socket), container = document.createElement('div'), root = createRoot(container)
  document.body.append(container); close.push(async () => { await act(async () => root.unmount()); container.remove() })
  expect(api.connections).toBe(bridge.api!.connections)
  await act(async () => root.render(<Profiles />))
  await vi.waitFor(() => { expect(ipc.states).toContain('ready'); expect(container.querySelector('[data-room]')?.textContent).toBe('Original native group | '); expect(container.querySelector('[data-person]')?.textContent).toBe('Original native person | ') })
  // The room and actor readers each own their explicit preload subscription.
  expect(active.size).toBe(baseline + 2)
  f.rename(); await act(async () => { await f.refresh('conversation'); await f.refresh('actor') })
  await vi.waitFor(() => { expect(container.querySelector('[data-room]')?.textContent).toBe('Renamed native group | '); expect(container.querySelector('[data-person]')?.textContent).toBe('Renamed native person | ') })
  ipc.release(); await vi.waitFor(() => expect(active.size).toBe(baseline))
  expect((await f.rpc.call('connection.metadata.get', { connectionId: binding.connectionId, subject: { kind: 'conversation', externalConversationId: binding.externalConversationId } })).entry.observation.profile?.name).toBe('Renamed native group')
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
})

it('does not make a slow metadata opening a prerequisite for an exact saved-profile read', async () => {
  const f = await fixture(); await f.refresh('conversation')
  let release!: () => void, entered = false
  const held = new Promise<void>(yes => { release = yes })
  const connect: typeof core.connectAgentMuxRpc = async options => {
    const rpc = await core.connectAgentMuxRpc(options), subscribe = rpc.subscribe.bind(rpc)
    rpc.subscribe = async (...args: Parameters<typeof rpc.subscribe>) => { entered = true; await held; return await subscribe(...args) }
    return rpc
  }
  const ipc = await main(f.socket, connect)
  const stopObserver = api.connections.onMetadataChanged(() => {})
  close.push(stopObserver)
  try {
    let result: unknown
    const read = api.connections.call('connection.metadata.get', { connectionId: binding.connectionId, subject: { kind: 'conversation', externalConversationId: binding.externalConversationId } }).then(value => { result = value })
    await vi.waitFor(() => { expect(entered).toBe(true); expect(result).toMatchObject({ entry: { observation: { profile: { name: 'Original native group' } } } }) })
    await read; expect(ipc.states).not.toContain('ready')
    release(); await vi.waitFor(() => expect(ipc.states).toContain('ready'))
  } finally { release() }
})

it('refuses a same-name foreign Runtime and a managed Agent while preserving the original Host observer', async () => {
  const f = await fixture(), events: unknown[] = []
  const wrong = { ...f.fence, runtimeId: 'foreign-original-runtime' }
  await expect(f.rpc.subscribe('connection.metadata.watch', {}, { runtimeFence: wrong, onInitial: () => {}, onEvent: event => events.push(event) })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  const agent = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socket }, credentials: { agentSessionId: 'metadata-agent', capability: f.original.capability } }); close.push(() => agent.dispose())
  await expect(agent.subscribe('connection.metadata.watch', {}, { onInitial: () => {}, onEvent: event => events.push(event) })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const seen: unknown[] = [], observer = await f.rpc.subscribe('connection.metadata.watch', {}, { runtimeFence: f.fence, onInitial: opening => expect(opening).toEqual({}), onEvent: event => seen.push(event) }); close.push(() => observer.dispose())
  await f.refresh('conversation'); await vi.waitFor(() => expect(seen).toHaveLength(1))
  expect(seen).toEqual([{ type: 'change', data: { connectionId: binding.connectionId, application, subject: { kind: 'conversation', externalConversationId: binding.externalConversationId } } }]); expect(events).toEqual([])
})


it('rereads the visible original profiles after watch opening closes the initial-read gap', async () => {
  const f = await fixture(); await f.refresh('conversation'); await f.refresh('actor')
  let release!: () => void
  const held = new Promise<void>(yes => { release = yes })
  const connect: typeof core.connectAgentMuxRpc = async options => {
    const rpc = await core.connectAgentMuxRpc(options), subscribe = rpc.subscribe.bind(rpc)
    rpc.subscribe = async (...args: Parameters<typeof rpc.subscribe>) => { await held; return await subscribe(...args) }
    return rpc
  }
  const ipc = await main(f.socket, connect), container = document.createElement('div'), root = createRoot(container)
  document.body.append(container); close.push(async () => { await act(async () => root.unmount()); container.remove() })
  try {
    await act(async () => root.render(<Profiles />))
    await vi.waitFor(() => expect(container.querySelector('[data-room]')?.textContent).toBe('Original native group | '))
    expect(ipc.states).not.toContain('ready')
    f.rename(); await f.refresh('conversation'); await f.refresh('actor')
    expect(container.querySelector('[data-room]')?.textContent).toBe('Original native group | ')
    await act(async () => release())
    await vi.waitFor(() => { expect(container.querySelector('[data-room]')?.textContent).toBe('Renamed native group | '); expect(container.querySelector('[data-person]')?.textContent).toBe('Renamed native person | ') })
  } finally { release() }
})

it('retains saved profiles on an unavailable watch and reopens only on an explicit observation', async () => {
  const f = await fixture(); await f.refresh('conversation'); await f.refresh('actor')
  let release!: () => void, attempts = 0
  const held = new Promise<void>(yes => { release = yes })
  const connect: typeof core.connectAgentMuxRpc = async options => {
    const rpc = await core.connectAgentMuxRpc(options), subscribe = rpc.subscribe.bind(rpc)
    rpc.subscribe = async (...args: Parameters<typeof rpc.subscribe>) => {
      attempts++
      if (attempts <= 2) { await held; throw new core.AgentMuxError('Controlled observation transport failure', 'CONTROL_UNAVAILABLE') }
      return await subscribe(...args)
    }
    return rpc
  }
  const ipc = await main(f.socket, connect), container = document.createElement('div'), root = createRoot(container)
  document.body.append(container); close.push(async () => { await act(async () => root.unmount()); container.remove() })
  try {
    await act(async () => root.render(<Profiles />))
    await vi.waitFor(() => expect(container.querySelector('[data-room]')?.textContent).toBe('Original native group | '))
    await act(async () => release())
    await vi.waitFor(() => { expect(ipc.states).toContain('unavailable'); expect(container.querySelector('[data-room]')?.textContent).toBe('Original native group | Group name updates unconfirmed'); expect(container.querySelector('[data-person]')?.textContent).toBe('Original native person | Live profile updates unavailable') })
    expect(attempts).toBe(2)
    await act(async () => { await api.connections.call('connection.metadata.get', { connectionId: binding.connectionId, subject: { kind: 'conversation', externalConversationId: binding.externalConversationId } }) })
    expect(attempts).toBe(2)
    await act(async () => root.render(<Profiles key="explicit-observation-reopen" />))
    await vi.waitFor(() => { expect(ipc.states).toContain('ready'); expect(container.querySelector('[data-room]')?.textContent).toBe('Original native group | '); expect(container.querySelector('[data-person]')?.textContent).toBe('Original native person | ') })
    expect(attempts).toBe(4)
  } finally { release() }
})


it('streams actual change hints through the compiled public CLI and cancels only its observer', async () => {
  const f = await fixture(), frames: Array<Record<string, any>> = []
  const child = spawn(process.execPath, [...(process.env.METADATA_WATCH_NODE_IMPORT ? ['--import', process.env.METADATA_WATCH_NODE_IMPORT] : []), resolve(import.meta.dirname, '../../../packages/core/dist/agentmux.js'), '--endpoint', 'unix:' + f.socket, 'connection', 'metadata', 'watch'], { env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', exit: number | null | undefined
  child.stdout.on('data', bytes => { stdout += bytes; const lines = stdout.split('\n'); stdout = lines.pop()!; for (const line of lines) if (line) frames.push(JSON.parse(line)) })
  child.stderr.on('data', bytes => { stderr += bytes })
  const ended = new Promise<void>((yes, no) => { child.once('error', no); child.once('exit', code => { exit = code; yes() }) })
  close.push(async () => { if (exit === undefined) child.kill('SIGINT'); await ended })
  await vi.waitFor(() => { expect(stderr).toBe(''); expect(frames.some(frame => frame.result?.method === 'connection.metadata.watch' && frame.result?.subscriptionId)).toBe(true) }, { timeout: 5_000 })
  await f.refresh('conversation')
  await vi.waitFor(() => expect(frames.some(frame => frame.params?.event?.type === 'change' && frame.params.event.data.subject.externalConversationId === binding.externalConversationId)).toBe(true), { timeout: 5_000 })
  expect(JSON.stringify(frames)).not.toContain('synthetic-native-secret')
  child.kill('SIGINT'); await ended; expect(exit).toBe(0)
  expect((await f.rpc.call('connection.metadata.get', { connectionId: binding.connectionId, subject: { kind: 'conversation', externalConversationId: binding.externalConversationId } })).entry.observation.profile?.name).toBe('Original native group')
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
})
