import { act } from 'react'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, ConnectionHostingTarget, HostConfig } from '../src/shared/contracts'

const bridge = await vi.hoisted(async () => {
  const { Window } = await import('happy-dom'), window = new Window({ url: 'http://localhost' })
  const { EventEmitter } = await import('node:events')
  const { mkdtemp } = await import('node:fs/promises'), { tmpdir } = await vi.importActual<typeof import('node:os')>('node:os'), { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'amux-manual-owner-'))
  for (const key of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLSelectElement','Element','Node','Event','PointerEvent'] as const) vi.stubGlobal(key, key === 'window' ? window : window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return { window, directory, profile: directory, api: null as AgentMuxPreloadApi | null, events: new EventEmitter(), invoke: vi.fn(), handlers: new Map<string, (...args: any[]) => Promise<any>>() }
})
vi.mock('node:os', async load => ({ ...await load<typeof import('node:os')>(), homedir: () => bridge.directory }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (key: string, api: AgentMuxPreloadApi) => {
  bridge.api = api; Object.defineProperty(window, key, { configurable: true, value: api })
} }, ipcRenderer: { invoke: bridge.invoke, on: (channel: string, listener: (...args: any[]) => void) => bridge.events.on(channel, listener), removeListener: (channel: string, listener: (...args: any[]) => void) => bridge.events.off(channel, listener) }, webFrame: { getZoomFactor: () => 1 },
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => Promise<any>) => bridge.handlers.set(channel, fn), removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => bridge.profile, getAppPath: () => bridge.profile }, clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, session: {}
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ list: async () => [], snapshot: async () => ({ demands: [] }), subscribe: () => () => {} }) }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import '../src/preload/index'
import * as core from '../../../packages/core/src/index.js'
import { connectHostedAgentMux } from '@agentmux/core/hosted'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { startAgentMuxHost } from '../../host/src/host.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { registerIpc } from '../src/main/ipc.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { feishuSdkTransport } from '../../../packages/connectors/test/fixtures/feishu.js'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { restoredManualConnectionIntents, manualConnectionScope } from '../src/renderer/src/lib/manual-connection-intent'
import { larkSettingsModule } from '../src/renderer/src/components/settings/modules/lark'
import { composerConfig } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'

const closes: Array<() => void | Promise<void>> = [], initial = useAppStore.getState()
const facts: unknown[] = []
afterAll(async () => { if (process.env.MANUAL_OWNER_FACTS) await writeFile(process.env.MANUAL_OWNER_FACTS, JSON.stringify({ scope: 'Synthetic same-Runtime instance replacement through public bootstrap and original configure/inspect.', facts }, null, 2) + '\n') })
afterAll(async () => { const { rm } = await import('node:fs/promises'); await bridge.window.happyDOM.abort(); await rm(bridge.directory, { recursive: true, force: true }) })
let root: ReturnType<typeof createClientUiRoot> | undefined, container: HTMLDivElement
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined; container?.remove()
  for (const close of closes.splice(0).reverse()) await close()
  bridge.handlers.clear(); bridge.invoke.mockReset(); vi.restoreAllMocks(); vi.unstubAllEnvs(); useAppStore.setState(initial, true)
})
async function originalHost(withConnections = true) {
  const f = await rpcOwnerFixture([], core); closes.push(f.close)
  const directory = join(f.root, 'connections'), socketPath = join(f.root, 'host.sock')
  const launchEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:AGENTMUX_|CTXMUX_)/u.test(key)))
  await mkdir(directory, { mode: 0o700 }); const kernel = f.inner.kernel
  await f.client.dispose()
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  const start = async (connections: boolean, desktopSocketPath = join(f.root, 'no-desktop.sock')) => {
    const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:AGENTMUX_|CTXMUX_)/u.test(key)))
    for (const key of Object.keys(process.env)) if (/^(?:AGENTMUX_|CTXMUX_)/u.test(key)) delete process.env[key]
    Object.assign(process.env, launchEnvironment)
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
      const inner = this as unknown as typeof f.inner; await inner.registry.load('local'); inner.connected = true
      for (const key of ['isConnected','status','identity','input','observeOutput','attach','detach','stop']) inner.kernel[key] = kernel[key]
    })
    try { host = await startAgentMuxHost({ store: f.store, socketPath, desktopSocketPath, mobileBuildDirectory: join(f.root, 'no-mobile'), ...(connections ? { connections: { directory } } : {}) }) }
    finally {
      connect.mockRestore()
      for (const key of Object.keys(process.env)) if (/^(?:AGENTMUX_|CTXMUX_)/u.test(key)) delete process.env[key]
      Object.assign(process.env, previous)
    }
  }
  await start(withConnections)
  closes.push(() => host.dispose())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); closes.push(() => rpc.dispose())
  const { owner } = await rpc.call('runtime.owner.identity', {})
  return { host: host!, rpc, owner, f, socketPath, restart: async (connections: boolean, desktopSocketPath?: string) => { await host.dispose(); await start(connections, desktopSocketPath) } }
}
async function fixture() {
  const a = await originalHost(), b = await originalHost()
  const configs: HostConfig[] = [{ id: 'local', kind: 'local', label: 'Local Host' }, { id: 'owner-a', kind: 'ssh', label: 'Build Host A', hostname: 'owner-a.invalid' }, { id: 'owner-b', kind: 'ssh', label: 'Build Host B', hostname: 'owner-b.invalid' }]
  const targets = { a: { hostId: 'owner-a', runtimeId: a.owner.runtimeId }, b: { hostId: 'owner-b', runtimeId: b.owner.runtimeId } }
  const config: AppConfig = { ...structuredClone(composerConfig), hosts: configs, workspaces: [] }
  let replaceAfterOwnerInspection = false
  const runtime = new RuntimeController(new core.AgentMuxMemoryAgentSessionStore(), async host => {
    const original = host.id === 'owner-b' ? b : a
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: original.socketPath } })
    const client = await connectHostedAgentMux({ rpc, expectedRuntimeId: original.owner.runtimeId,
      subscribeRpc: (method, params, handlers) => rpc.subscribe(method, params, handlers),
      forwardRpc: async (method, params, context = {}) => {
        const result = await rpc.call(method, params, { ...(context.signal ? { signal: context.signal } : {}), ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}) })
        if (host.id === 'owner-a' && method === 'connection.owner.inspect' && replaceAfterOwnerInspection) {
          replaceAfterOwnerInspection = false; await a.restart(false, b.socketPath)
          client.disconnect(); await client.connect()
          const current = client.runtimeOwnerIdentity(), native = (await a.rpc.call('runtime.owner.identity', {})).owner
          expect(current?.runtimeId).toBe(a.owner.runtimeId); expect(current?.ownerInstanceId).toBe(native.ownerInstanceId)
          expect(current?.ownerInstanceId).not.toBe(a.owner.ownerInstanceId)
        }
        return result
      } })
    const dispose = client.dispose.bind(client); client.dispose = async () => { await dispose(); await rpc.dispose() }
    return client
  })
  runtime.commit(await runtime.prepare(config)); closes.push(() => runtime.dispose())
  bridge.profile = join(a.f.root, 'desktop'); await mkdir(bridge.profile, { mode: 0o700 })
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(bridge.profile, 'spatial.json'))
  const { EventEmitter } = await import('node:events')
  const sender = Object.assign(new EventEmitter(), { id: 752, isDestroyed: () => false, send: (channel: string, ...values: unknown[]) => { bridge.events.emit(channel, {}, ...values) }, mainFrame: { framesInSubtree: [] } })
  const releaseMain = await registerIpc({ initialConfig: config,
    window: { setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow, runtime,
    workbenchWindows: { setNativeOwner: () => () => {} } as Parameters<typeof registerIpc>[0]['workbenchWindows'],
    configStore: { get: async () => config, validate: (value: AppConfig) => value, save: async (value: AppConfig) => value } as never,
    progressLoops: { subscribe: () => () => {} } as never, scratchTopics: { setNameAudit: vi.fn() } as never,
    workspaceFiles: new WorkspaceFiles(() => new core.LocalExecutionHost()) })
  closes.push(releaseMain)
  const mainFallback = vi.fn()
  let lostSave = false, lostCredential = false, heldMetadata = false, heldList = false, metadataStarted = false, listStarted = false, releaseMetadata!: () => void, releaseList!: () => void
  const metadataDelay = new Promise<void>(resolve => { releaseMetadata = resolve })
  const listDelay = new Promise<void>(resolve => { releaseList = resolve })
  bridge.invoke.mockImplementation(async (channel: string, ...args: any[]) => {
    if (channel === 'config:get') return config
    if (channel === 'hosts:inspect') {
      const host = args[1] as HostConfig, target = host.id === 'owner-a' ? a : b
      return { ok: true, value: { routeHostId: host.id, configuration: host, owner: { state: 'available', value: target.owner, readAt: 1 } } }
    }
    if (channel === 'connections:storeCredential' && lostCredential) { lostCredential = false; throw Error('Credential store result unconfirmed') }
    const handler = bridge.handlers.get(channel)
    if (!handler) return undefined
    if ((channel === 'connections:storeCredential' || channel === 'connections:call' && args[0] === 'connection.configure') && args.at(-1)?.hostId === undefined) mainFallback(channel)
    const result = await handler({ sender, senderFrame: sender.mainFrame }, ...structuredClone(args))
    if (channel === 'connections:call' && args[0] === 'connection.configure' && lostSave) { lostSave = false; throw Error('Original save ACK lost') }
    if (channel === 'connections:call' && args[0] === 'connection.metadata.ls' && args[1].kind === 'conversation' && heldMetadata) { heldMetadata = false; metadataStarted = true; await metadataDelay }
    if (channel === 'connections:call' && args[0] === 'connection.ls' && heldList) { heldList = false; listStarted = true; await listDelay }
    return result
  })
  useAppStore.setState({ config, sessions: [], manualConnectionIntents: {}, manualConnectionSelections: {}, botTaskSelections: {} })
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  const nativeCalls: unknown[] = [], native = feishuSdkTransport(); let nativeName = 'Native room'
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(async input => {
    nativeCalls.push({ url: input.url, data: input.data })
    if (input.url?.includes('/auth/v3/')) return { code: 0, tenant_access_token: 'synthetic-native-access', app_access_token: 'synthetic-native-access', expire: 3600 }
    if (input.url?.includes('/im/v1/chats/')) return { code: 0, data: { name: nativeName } }
    if (input.url?.endsWith('/bot/v3/info')) return { code: 0, bot: { open_id: 'synthetic-bot' } }
    return await native.request(input.url ? { url: input.url } : {})
  })
  const mount = async () => { await act(async () => root!.render(<larkSettingsModule.Pane active config={config} onClose={() => {}} onNavigate={() => {}} />)) }
  await mount()
  const select = async (id: string) => { await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Connector hosting Host"]')!; select.value = 'host:' + id; select.dispatchEvent(new Event('change', { bubbles: true }))
  }); await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).not.toContain('Reading the original Host identity…'); expect(container.querySelector('[data-connection-hosting]')?.textContent).toContain(id) }) }
  return { a, b, runtime, targets, config, mount, select, mainFallback, nativeCalls, loseSave: () => { lostSave = true }, loseCredential: () => { lostCredential = true }, holdMetadata: () => { heldMetadata = true }, metadataStarted: () => metadataStarted, releaseMetadata, holdList: () => { heldList = true }, listStarted: () => listStarted, releaseList, nativeName: (value: string) => { nativeName = value }, replaceAfterOwnerInspection: () => { replaceAfterOwnerInspection = true } }
}
async function click(selector: string) { await vi.waitFor(async () => { await act(async () => {}); const button = container.querySelector<HTMLButtonElement>(selector); expect(button).toBeDefined(); expect(button).not.toBeNull(); expect(button!.disabled).not.toBe(true) }); await act(async () => container.querySelector<HTMLElement>(selector)!.click()) }
async function clickText(text: string) { await vi.waitFor(async () => { await act(async () => {}); const button = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === text); expect(button).toBeDefined(); expect(button!.disabled).not.toBe(true) }); await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === text)!.click()) }
async function fill(label: string, value: string) { const input = container.querySelector<HTMLInputElement>('[aria-label="' + label + '"]'); expect(input).not.toBeNull(); await act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input!.dispatchEvent(new Event('input', { bubbles: true }))
}) }
async function settle(text: string) { await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain(text) }) }
async function seed(f: Awaited<ReturnType<typeof fixture>>, target: ConnectionHostingTarget, label: string) {
  const original = target.hostId === 'owner-a' ? f.a : f.b, runtimeFence = { runtimeId: original.owner.runtimeId, ownerInstanceId: original.owner.ownerInstanceId }
  const credential = await original.rpc.call('connection.credential.store', { operationId: 'same-credential', secret: 'synthetic-' + label }, { runtimeFence })
  return await original.rpc.call('connection.configure', { operationId: 'same-configure', expectedRevision: null, connection: {
    connectionId: 'same-connection', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'synthetic-app' }, label, enabled: true, credentialRef: credential.credentialRef
  } })
}

it('the mounted manual pane keeps colliding IDs on the exact hosting owner through preload and original configured transport', async () => {
  const f = await fixture()
  await seed(f, f.targets.a, 'Owner A'); await seed(f, f.targets.b, 'Owner B')
  await f.select('owner-a'); await settle('Owner A'); expect(container.textContent).not.toContain('Owner B')
  await click('[data-connection="same-connection"] button'); await settle('Owner A')
  await click('[data-connection-check]'); await settle('Connection checked.')
  expect(JSON.stringify(f.nativeCalls)).toContain('synthetic-Owner A'); expect(JSON.stringify(f.nativeCalls)).not.toContain('synthetic-Owner B')
  await f.select('owner-b'); await settle('Owner B'); expect(container.textContent).not.toContain('Owner A')
  await click('[data-connection="same-connection"] button'); await click('[data-connection-check]'); await settle('Connection checked.')
  expect(JSON.stringify(f.nativeCalls)).toContain('synthetic-Owner B'); expect(f.mainFallback).not.toHaveBeenCalled()
})

it('a lost save ACK survives page unmount and serialized UI restore with the original target, operation and credential reference', async () => {
  const f = await fixture(); await seed(f, f.targets.b, 'Owner B')
  await f.select('owner-a'); await settle('Connect a bot'); await click('[data-enrollment-existing]')
  await fill('Connection app ID', 'synthetic-manual'); await fill('Connection app secret', 'synthetic-private-input')
  await act(async () => { const enabled = container.querySelector<HTMLInputElement>('[aria-label="Connection enabled"]')!; enabled.click() })
  f.loseSave(); await click('[data-connection-save]'); await settle('Save result not confirmed.')
  const key = manualConnectionScope('lark', f.targets.a), original = useAppStore.getState().manualConnectionIntents[key]!
  expect(original.pending).toBeDefined(); expect(original.target).toEqual(f.targets.a)
  const serialized = JSON.stringify(useAppStore.getState().manualConnectionIntents), selections = structuredClone(useAppStore.getState().manualConnectionSelections)
  expect(serialized).not.toContain('synthetic-private-input'); expect(original.pending!.connection.credentialRef).not.toBe('')
  await f.select('owner-b'); await settle('Owner B')
  await act(async () => root!.render(null))
  useAppStore.setState({ manualConnectionIntents: restoredManualConnectionIntents(JSON.parse(serialized)), manualConnectionSelections: selections })
  await f.mount(); await settle('Check this save'); await click('[data-connection-save]'); await settle('The original application save is confirmed.')
  const saved = await api.connections.call('connection.inspect', { operationId: original.pending!.operationId }, f.targets.a)
  expect(saved.operation?.connection.config.credentialRef).toBe(original.pending!.connection.credentialRef)
  await act(async () => {})
  expect(useAppStore.getState().manualConnectionIntents[key]?.pending).toBeUndefined()
  expect((await api.connections.call('connection.inspect', { operationId: original.pending!.operationId }, f.targets.b)).operation).toBeNull()
  expect(f.mainFallback).not.toHaveBeenCalled()
})

it('an unconfirmed replacement credential retains its empty original reference across remount and cannot silently reuse the previous credential', async () => {
  const f = await fixture(), seeded = await seed(f, f.targets.a, 'Owner A')
  await f.select('owner-a'); await settle('Owner A'); await click('[data-connection="same-connection"] button'); await clickText('Edit connection')
  await fill('Connection app secret', 'synthetic-replacement'); f.loseCredential(); await click('[data-connection-save]'); await settle('Save result not confirmed.')
  const key = manualConnectionScope('lark', f.targets.a), original = useAppStore.getState().manualConnectionIntents[key]!.pending!
  expect(original).toBeDefined(); expect(original.connection.credentialRef).toBe('')
  const serialized = JSON.stringify(useAppStore.getState().manualConnectionIntents); expect(serialized).not.toContain('synthetic-replacement')
  await act(async () => root!.render(null)); useAppStore.setState({ manualConnectionIntents: restoredManualConnectionIntents(JSON.parse(serialized)) })
  await f.mount(); await settle('Check this save'); await click('[data-connection-save]'); await settle('Continue this save'); await click('[data-connection-save]'); await settle('Provide the secret again')
  expect((await f.a.rpc.call('connection.inspect', { operationId: original.operationId })).operation).toBeNull()
  expect((await f.a.rpc.call('connection.inspect', { connectionId: 'same-connection' })).connection!.config.credentialRef).toBe(seeded.connection.config.credentialRef)
  await fill('Connection app secret', 'synthetic-replacement'); await click('[data-connection-save]'); await settle('Application saved.')
  const confirmed = (await f.a.rpc.call('connection.inspect', { operationId: original.operationId })).operation!
  expect(confirmed.connection.revision).toBe(2); expect(confirmed.connection.config.credentialRef).not.toBe(seeded.connection.config.credentialRef)
})

it('late profile readings cannot enter another owner with colliding application and connection identities', async () => {
  const f = await fixture(); await seed(f, f.targets.a, 'Owner A'); await seed(f, f.targets.b, 'Owner B')
  const subject = { kind: 'conversation' as const, externalConversationId: 'same-room' }
  f.nativeName('A native group'); await api.connections.call('connection.metadata.refresh', { connectionId: 'same-connection', expectedConnectionRevision: 1, subject }, f.targets.a)
  f.nativeName('B native group'); await api.connections.call('connection.metadata.refresh', { connectionId: 'same-connection', expectedConnectionRevision: 1, subject }, f.targets.b)
  const open = async () => { await act(async () => { const details = container.querySelector<HTMLDetailsElement>('.channel-metadata')!; expect(details).not.toBeNull(); details.open = true; details.dispatchEvent(new Event('toggle')) }); await clickText('Groups') }
  await f.select('owner-a'); await settle('Owner A'); await click('[data-connection="same-connection"] button')
  f.holdMetadata(); await open(); await vi.waitFor(() => expect(f.metadataStarted()).toBe(true))
  await f.select('owner-b'); await settle('Owner B'); await click('[data-connection="same-connection"] button'); await open(); await settle('B native group')
  await act(async () => f.releaseMetadata()); await settle('B native group'); expect(container.textContent).not.toContain('A native group')
})

it('a restored edit waits for its exact original record instead of creating a new connection during a delayed read', async () => {
  const f = await fixture(); await seed(f, f.targets.a, 'Owner A')
  await f.select('owner-a'); await settle('Owner A'); await click('[data-connection="same-connection"] button'); await clickText('Edit connection'); await fill('Connection name', 'Original edit draft')
  await act(async () => root!.render(null)); f.holdList(); await f.mount()
  await vi.waitFor(() => expect(f.listStarted()).toBe(true)); await fill('Connection app secret', 'synthetic-edit-secret'); await click('[data-connection-save]'); await settle('The original saved application is not confirmed yet.')
  const before = await f.a.rpc.call('connection.ls', {}); expect(before.connections).toHaveLength(1); expect(before.connections[0]!.revision).toBe(1)
  expect(useAppStore.getState().manualConnectionIntents[manualConnectionScope('lark', f.targets.a)]?.pending).toBeUndefined()
  await act(async () => f.releaseList()); await settle('Edit bot connection'); await click('[data-connection-save]'); await settle('Application saved.')
  const after = await f.a.rpc.call('connection.ls', {}); expect(after.connections).toHaveLength(1); expect(after.connections[0]).toMatchObject({ revision: 2, config: { connectionId: 'same-connection', label: 'Original edit draft' } })
})

it('an already provided foreign Runtime fence refuses before a write; registered, bridge-only and absent ports report only endpoint ownership', async () => {
  const f = await fixture(), bare = await originalHost(false)
  expect(await f.a.rpc.call('connection.owner.inspect', {})).toEqual({ ownership: 'local' })
  expect(await bare.rpc.call('connection.owner.inspect', {})).toEqual({ ownership: 'forwarded' })
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.a.socketPath, 'connection', 'owner', 'inspect'], objectCliEnvironment(f.a.f.root, {
    pnpm_config_verify_deps_before_run: 'false', NODE_OPTIONS: '--import ' + JSON.stringify(new URL('./helpers/manual-owner-node-loader.mjs', import.meta.url).href)
  }))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result).toMatchObject({ ownership: 'local' })
  const absent = new core.AgentMuxRpcService({})
  expect(await absent.call('connection.owner.inspect', {}, { principal: { kind: 'user', id: 'synthetic-user' } })).toEqual({ ownership: 'unavailable' })
  await expect(f.b.rpc.call('connection.configure', { operationId: 'wrong-runtime', expectedRevision: null, connection: {
    connectionId: 'wrong-runtime', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'synthetic-app' }, label: 'Must not save', enabled: false, credentialRef: 'unresolved' }
  }, { runtimeFence: { runtimeId: f.a.owner.runtimeId, ownerInstanceId: f.a.owner.ownerInstanceId } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect((await f.b.rpc.call('connection.inspect', { operationId: 'wrong-runtime' })).operation).toBeNull()
  await expect(f.runtime.callConnectionHost({ hostId: 'owner-a', runtimeId: f.b.owner.runtimeId }, 'connection.ls', {})).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  await absent.dispose()
})

it('the exact destination instance fences dispatch when the same Runtime restarts from local connections to a forwarded bridge', async () => {
  const f = await fixture(); f.replaceAfterOwnerInspection()
  const outcome = await api.connections.call('connection.configure', { operationId: 'original-instance-save', expectedRevision: null, connection: {
    connectionId: 'original-instance-connection', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'synthetic-app' }, label: 'Retain original owner', enabled: false, credentialRef: 'unresolved' }
  }, f.targets.a).then(result => ({ state: 'confirmed' as const, operationId: result.operationId }), error => ({ state: 'refused' as const, code: error.code }))
  const witness = (await f.b.rpc.call('connection.inspect', { operationId: 'original-instance-save' })).operation
  const { owner } = await f.a.rpc.call('runtime.owner.identity', {})
  facts.push({ case: 'destination-instance', outcome, operationRecorded: witness !== null, recordedOperationId: witness?.operationId ?? null,
    recordedConnectionId: witness?.connection.config.connectionId ?? null, previousOwner: { runtimeId: f.a.owner.runtimeId, ownerInstanceId: f.a.owner.ownerInstanceId }, currentOwner: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
  expect(witness).toBeNull()
  expect(outcome).toEqual({ state: 'refused', code: 'RUNTIME_OWNER_CHANGED' })
  expect(owner.runtimeId).toBe(f.a.owner.runtimeId); expect(owner.ownerInstanceId).not.toBe(f.a.owner.ownerInstanceId)
  expect(await f.a.rpc.call('connection.owner.inspect', {})).toEqual({ ownership: 'forwarded' })
  await expect(api.connections.call('connection.ls', {}, f.targets.a)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.mainFallback).not.toHaveBeenCalled()
})

it('default trusted IPC and per-reader metadata borrow the background owner without a Main connection factory', async () => {
  const f = await fixture()
  await seed(f, f.targets.a, 'Owner A'); await seed(f, f.targets.b, 'Owner B')
  expect(await api.connections.hostingTarget()).toEqual({ hostId: 'local', runtimeId: f.a.owner.runtimeId })
  expect((await api.connections.call('connection.ls', {})).connections.map(value => value.config.label)).toEqual(['Owner A'])
  const changesA: unknown[] = [], changesB: unknown[] = [], statesA: string[] = [], statesB: string[] = []
  const releaseA = api.connections.onMetadataChanged(value => changesA.push(value), value => statesA.push(value), f.targets.a)
  const releaseB = api.connections.onMetadataChanged(value => changesB.push(value), value => statesB.push(value), f.targets.b)
  closes.push(releaseA, releaseB)
  await vi.waitFor(() => { expect(statesA).toEqual(['ready']); expect(statesB).toEqual(['ready']) })
  const subject = { kind: 'conversation' as const, externalConversationId: 'same-room' }
  f.nativeName('Original A room')
  await api.connections.call('connection.metadata.refresh', { connectionId: 'same-connection', expectedConnectionRevision: 1, subject }, f.targets.a)
  await vi.waitFor(() => expect(changesA).toHaveLength(1))
  expect(changesB).toEqual([])
  releaseA()
  f.nativeName('Original B room')
  await api.connections.call('connection.metadata.refresh', { connectionId: 'same-connection', expectedConnectionRevision: 1, subject }, f.targets.b)
  await vi.waitFor(() => expect(changesB).toHaveLength(1))
  expect(changesA).toHaveLength(1)
  f.nativeName('Later A room')
  await api.connections.call('connection.metadata.refresh', { connectionId: 'same-connection', expectedConnectionRevision: 1, subject }, f.targets.a)
  expect(changesA).toHaveLength(1)
  expect((await api.connections.call('connection.ls', {})).connections[0]!.config.label).toBe('Owner A')
  expect((await api.connections.call('connection.ls', {}, f.targets.b)).connections[0]!.config.label).toBe('Owner B')
})
