import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { generateKeyPair, exportPublicKey } from '@agentmux/relay/e2ee'
import { parseConnectionOffer } from '@agentmux/relay/offer'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { startHeadlessAgentMux } from '../src/headless-runtime.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { CoreRelayGateway } from '../src/public-rpc-relay-gateway.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { MeshNetworkState } from '../src/mesh-network-state.js'
import { defaultMeshNetworkConfiguration, parseMeshNetworkParams, parseMeshNetworkResult, type MeshNetworkConfiguration } from '../src/mesh-network.js'
import { AgentMuxError } from '../src/errors.js'
import { durableWriteFile, DurableWriteError } from '../src/durable-write.js'
import { hostRouteScope } from '../src/host-route.js'
import type { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'

const writeControl = vi.hoisted(() => ({ intercept: undefined as undefined | ((actual: typeof import('../src/durable-write.js').durableWriteFile, ...args: Parameters<typeof import('../src/durable-write.js').durableWriteFile>) => Promise<void>) }))
vi.mock('../src/durable-write.js', async original => {
  const actual = await original<typeof import('../src/durable-write.js')>()
  return { ...actual, durableWriteFile: (...args: Parameters<typeof actual.durableWriteFile>) => writeControl.intercept ? writeControl.intercept(actual.durableWriteFile, ...args) : actual.durableWriteFile(...args) }
})

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) => actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js') ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); writeControl.intercept = undefined; vi.restoreAllMocks() })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'amux-mesh-core-')); cleanup.push(() => rm(root, { recursive: true, force: true })); return root }
const owner = { runtimeId: 'original-core-runtime', ownerInstanceId: 'original-core-instance' }
async function fixture(options: { endpoint?: NonNullable<ConstructorParameters<typeof AgentMuxControlServer>[0]>['meshEndpoint']; http?: boolean } = {}) {
  const root = await directory()
  // Controlled original semantic port only for these protocol tests, not Native evidence.
  const identity = { ...owner, protocolVersion: 1 as const, processId: process.pid, ctxmux: null, availability: 'connected' as const }
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), meshState: { directory: root, owner },
    ...(options.http ? { http: { host: '127.0.0.1', port: 0, token: 'original-private-operator-token' } } : {}),
    ...(options.endpoint ? { meshEndpoint: options.endpoint } : {}),
    hostedRuntime: () => ({ call: async () => ({ owner: identity }), assertFence: (fence: typeof owner) => { if (fence.runtimeId !== owner.runtimeId || fence.ownerInstanceId !== owner.ownerInstanceId) throw new AgentMuxError('The actual original owner fence differs.', 'RUNTIME_OWNER_MISMATCH') } }) as unknown as AgentMuxHostedRuntimeService })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  await vi.waitFor(async () => expect((await rpc.call('settings.mesh.inspect', {})).identity).not.toBeNull())
  const settings = await rpc.call('settings.mesh.inspect', {})
  const config = (overrides: Partial<MeshNetworkConfiguration> = {}): MeshNetworkConfiguration => ({ ...settings.configuration, role: 'participant', networkId: 'private-test-network', members: [{ peerId: settings.identity!.peerId, publicKey: settings.identity!.publicKey }], ...overrides })
  const save = async (configuration: MeshNetworkConfiguration, operationId: string) => rpc.call('settings.mesh.configure', { expectedRevision: (await rpc.call('settings.mesh.inspect', {})).revision, operationId, configuration })
  return { root, server, rpc, settings, config, save }
}

it('the four real public methods durably hot-configure the original Core and retain its network key with a higher restart epoch', async () => {
  const f = await fixture()
  const before = await f.rpc.call('mesh.inspect', {})
  expect(before).toMatchObject({ owner, activeRevision: null, source: 'none', endpoint: { state: 'not-provided' } })
  const saved = await f.save(f.config(), 'original-mesh-save')
  expect(saved.diskDurability).toBe('confirmed')
  await vi.waitFor(async () => expect((await f.rpc.call('mesh.inspect', {})).activeRevision).toBe(saved.settings.revision))
  const active = await f.rpc.call('mesh.inspect', {})
  expect(active).toMatchObject({ apply: { state: 'active' }, identity: { peerId: before.identity!.peerId, epoch: 1 }, network: { state: 'active' } })
  expect(JSON.stringify(active)).not.toContain('secretKey')
  expect((await f.rpc.call('settings.mesh.inspect', { operationId: 'original-mesh-save' })).operation?.status).toBe('confirmed')
  await f.rpc.dispose(); await f.server.stop()
  const nextOwner = { ...owner, ownerInstanceId: 'next-original-instance' }
  const restarted = new CoreRelayGateway(undefined, { directory: f.root, owner: nextOwner }); cleanup.push(() => restarted.stop()); restarted.start()
  await vi.waitFor(async () => expect((await restarted.call('mesh.inspect', {})).apply.state).toBe('active'))
  expect(await restarted.call('mesh.inspect', {})).toMatchObject({ owner: nextOwner, identity: { peerId: before.identity!.peerId, publicKey: before.identity!.publicKey, epoch: 2 }, activeRevision: saved.settings.revision })
})

it('CAS conflicts and original operation mismatch preserve the accepted Mesh configuration', async () => {
  const f = await fixture(), configuration = f.config()
  const request = { expectedRevision: f.settings.revision, operationId: 'accepted', configuration }
  const saved = await f.rpc.call('settings.mesh.configure', request)
  await expect(f.rpc.call('settings.mesh.configure', { ...request, operationId: 'stale-editor' })).rejects.toMatchObject({ code: 'MESH_REVISION_CHANGED', controlFailure: { disposition: 'not_applied' } })
  await expect(f.rpc.call('settings.mesh.configure', { ...request, configuration: { ...configuration, networkId: 'changed-original-intent' } })).rejects.toMatchObject({ code: 'MESH_OPERATION_MISMATCH' })
  expect((await f.rpc.call('settings.mesh.inspect', {})).revision).toBe(saved.settings.revision)
})

it('unknown directory ACK is read back as the same save, without a second configuration or premature adoption', async () => {
  const root = await directory(), adopted: string[] = [], writes: string[] = []
  let fail = true
  const state = new MeshNetworkState({ directory: root, owner, validate: () => {}, adopt: value => adopted.push(value.revision), write: async (path, bytes, options) => {
    writes.push(path); await durableWriteFile(path, bytes, options)
    if (fail && path.endsWith('/mesh-network.json')) { fail = false; throw new DurableWriteError(path, 'after-replace', Error('directory ACK lost')) }
  } })
  const original = await state.inspect(), input = { expectedRevision: original.revision, operationId: 'uncertain-save', configuration: defaultMeshNetworkConfiguration() }
  const result = await state.configure(input, async () => {})
  expect(result.diskDurability).toBe('unknown'); expect(adopted).toEqual([])
  const read = await state.inspect(input.operationId)
  expect(read.operation).toMatchObject({ operationId: input.operationId, status: 'confirmed', revision: result.settings.revision })
  expect(adopted).toEqual([result.settings.revision])
  expect(writes.filter(path => path.endsWith('/mesh-network.json'))).toHaveLength(2)
  const again = await state.configure(input, async () => {})
  expect(again.diskDurability).toBe('confirmed'); expect(adopted).toHaveLength(1)
})

it('held original ACK inspection cannot overtake or roll back a later CAS save', async () => {
  const root = await directory(), adopted: string[] = []
  let fail = true, hold = false, release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const state = new MeshNetworkState({ directory: root, owner, validate: () => {}, adopt: value => adopted.push(value.revision), write: async (path, bytes, options) => {
    const value = JSON.parse(String(bytes))
    if (path.endsWith('/mesh-network.json') && hold && value.operationId === 'original-A') { entered(); await held }
    await durableWriteFile(path, bytes, options)
    if (path.endsWith('/mesh-network.json') && fail) { fail = false; throw new DurableWriteError(path, 'after-replace', Error('original ACK lost')) }
  } })
  const initial = await state.inspect(), a = await state.configure({ expectedRevision: initial.revision, operationId: 'original-A', configuration: defaultMeshNetworkConfiguration() }, async () => {})
  hold = true
  const inspection = state.inspect('original-A'); await started
  let bEntered = false
  const saving = state.configure({ expectedRevision: a.settings.revision, operationId: 'later-B', configuration: { ...defaultMeshNetworkConfiguration(), networkId: 'later-domain' } }, async () => { bEntered = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  const overtookHeldInspection = bEntered
  release(); await inspection
  const b = await saving, current = await state.inspect()
  expect(overtookHeldInspection).toBe(false)
  expect(current.revision).toBe(b.settings.revision)
  expect(current.configuration.networkId).toBe('later-domain')
  expect(adopted.at(-1)).toBe(b.settings.revision)
})

it('the semantic writer lease remains held until an already dispatched metadata mutation finishes', async () => {
  const root = await directory()
  vi.spyOn(AgentMuxClient.prototype, 'connect').mockResolvedValue()
  const options = { stateDirectory: root, socketPath: join(root, 'control.sock'), store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) }
  const first = await startHeadlessAgentMux(options); cleanup.push(() => first.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: first.socketPath } }); cleanup.push(() => rpc.dispose())
  const initial = await vi.waitFor(async () => { const value = await rpc.call('settings.mesh.inspect', {}); expect(value.identity).not.toBeNull(); return value })
  let release!: () => void, entered!: () => void, heldOnce = false
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  writeControl.intercept = async (actual, path, bytes, writeOptions) => {
    if (!heldOnce && path.endsWith('/mesh-network-peer.json') && JSON.parse(String(bytes)).epoch > 0) {
      heldOnce = true
      // The real rename is already dispatched; cancellation cannot undo it.
      const { signal: _dispatchedSignal, ...dispatchedOptions } = writeOptions ?? {}
      await actual(path, bytes, dispatchedOptions); entered(); await held
    } else await actual(path, bytes, writeOptions)
  }
  await rpc.call('settings.mesh.configure', { expectedRevision: initial.revision, operationId: 'owned-write-before-stop', configuration: { ...initial.configuration, role: 'participant', members: [{ peerId: initial.identity!.peerId, publicKey: initial.identity!.publicKey }] } })
  await started
  let stopped = false
  const stopping = first.stop().then(() => { stopped = true })
  try {
    const returnedBeforeMutation = await Promise.race([stopping.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))])
    expect(returnedBeforeMutation).toBe(false)
    await expect(startHeadlessAgentMux(options)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_BUSY' })
    expect(stopped).toBe(false)
  } finally { release(); await stopping; writeControl.intercept = undefined }
  const next = await startHeadlessAgentMux(options); cleanup.push(() => next.stop())
  const restored = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: next.socketPath } }); cleanup.push(() => restored.dispose())
  await vi.waitFor(async () => expect((await restored.call('mesh.inspect', {})).identity?.epoch).toBe(2))
  expect(next.ownerIdentity().runtimeId).toBe(first.ownerIdentity().runtimeId)
})

it('unconfirmed epoch bytes are never published and explicit recovery confirms the same reservation', async () => {
  const root = await directory(); let fail = true
  const reservations: unknown[] = []
  const state = new MeshNetworkState({ directory: root, owner, validate: () => {}, adopt: () => {}, write: async (path, bytes, options) => {
    await durableWriteFile(path, bytes, options)
    if (path.endsWith('/mesh-network-peer.json')) { const value = JSON.parse(String(bytes)); if (value.epoch > 0) { reservations.push(value); if (fail) { fail = false; throw new DurableWriteError(path, 'after-replace', Error('original epoch ACK lost')) } } }
  } })
  await state.initializeIdentity()
  await expect(state.reserveEpoch()).rejects.toMatchObject({ code: 'MESH_EPOCH_UNCONFIRMED' })
  expect(state.publicIdentity()!.epoch).toBe(0)
  const recovered = await state.reserveEpoch()
  expect(recovered.epoch).toBe(1)
  expect(reservations).toHaveLength(2); expect(reservations[0]).toEqual(reservations[1])
})

it('a damaged original key is retained, remains private, and can be restored without replacing Core', async () => {
  const root = await directory(), original = new MeshNetworkState({ directory: root, owner, validate: () => {}, adopt: () => {} })
  await original.initializeIdentity()
  const path = join(root, 'mesh-network-peer.json'), bytes = await readFile(path, 'utf8')
  const secret = 'damaged-private-key-do-not-print'; await writeFile(path, secret)
  const state = new MeshNetworkState({ directory: root, owner, validate: () => {}, adopt: () => {} })
  await expect(state.initializeIdentity()).rejects.toMatchObject({ code: 'MESH_IDENTITY_UNCONFIRMED' })
  expect(await readFile(path, 'utf8')).toBe(secret)
  expect(JSON.stringify(await state.inspect())).not.toContain(secret)
  await writeFile(path, bytes); await state.initializeIdentity()
  expect(state.publicIdentity()).toEqual(original.publicIdentity())
})

it('epoch reservation never overwrites an original key that became unreadable after startup', async () => {
  const root = await directory(), state = new MeshNetworkState({ directory: root, owner, validate: () => {}, adopt: () => {} })
  await state.initializeIdentity()
  const path = join(root, 'mesh-network-peer.json'), original = await readFile(path, 'utf8')
  await writeFile(path, 'original key temporarily unreadable')
  await expect(state.reserveEpoch()).rejects.toMatchObject({ code: 'MESH_EPOCH_UNCONFIRMED' })
  expect(await readFile(path, 'utf8')).toBe('original key temporarily unreadable')
  await writeFile(path, original)
  expect((await state.reserveEpoch()).epoch).toBe(1)
})

it('restart with a missing configured peer key retains its identity and settings while Unix remains available', async () => {
  const f = await fixture(), configuration = f.config(), saved = await f.save(configuration, 'configured-original-network')
  await vi.waitFor(async () => expect((await f.rpc.call('mesh.inspect', {})).activeRevision).toBe(saved.settings.revision))
  const keyPath = join(f.root, 'mesh-network-peer.json'), original = await readFile(keyPath, 'utf8')
  await f.rpc.dispose(); await f.server.stop(); await rm(keyPath)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'restored.sock'), meshState: { directory: f.root, owner: { ...owner, ownerInstanceId: 'after-key-missing' } } })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  await vi.waitFor(async () => expect((await rpc.call('mesh.inspect', {})).apply.state).toBe('unavailable'))
  await expect(readFile(keyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await rpc.call('settings.mesh.inspect', {}))).toMatchObject({ revision: saved.settings.revision, identity: null, configuration })
  expect((await rpc.call('system.endpoint', {})).publication!.state).toBe('available')
  await writeFile(keyPath, original)
  const restored = await rpc.call('settings.mesh.configure', { expectedRevision: saved.settings.revision, operationId: 'restore-original-network-key', configuration })
  await vi.waitFor(async () => expect((await rpc.call('mesh.inspect', {})).activeRevision).toBe(restored.settings.revision))
  expect((await rpc.call('mesh.inspect', {})).identity).toMatchObject({ peerId: f.settings.identity!.peerId, epoch: 2 })
})

it('a missing previously observed configuration is unavailable rather than a new empty policy', async () => {
  const f = await fixture(), saved = await f.save(f.config(), 'retained-settings')
  await vi.waitFor(async () => expect((await f.rpc.call('mesh.inspect', {})).activeRevision).toBe(saved.settings.revision))
  await rm(join(f.root, 'mesh-network.json'))
  await expect(f.rpc.call('settings.mesh.inspect', {})).rejects.toMatchObject({ code: 'MESH_SETTINGS_UNAVAILABLE' })
  await expect(f.rpc.call('settings.mesh.configure', { expectedRevision: f.settings.revision, operationId: 'cannot-replace-missing-source', configuration: f.config() })).rejects.toMatchObject({ code: 'MESH_SETTINGS_UNAVAILABLE', controlFailure: { disposition: 'not_applied' } })
  await expect(readFile(join(f.root, 'mesh-network.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await f.rpc.call('mesh.inspect', {})).activeRevision).toBe(saved.settings.revision)
  expect((await f.rpc.call('system.endpoint', {})).publication!.state).toBe('available')
})

it('a revoked original operator cannot write after waiting in the settings owner', async () => {
  const root = await directory(), state = new MeshNetworkState({ directory: root, owner, validate: () => {}, adopt: () => {} })
  const original = await state.inspect(); let assertions = 0
  await expect(state.configure({ expectedRevision: original.revision, operationId: 'revoked-before-write', configuration: defaultMeshNetworkConfiguration() }, async () => {
    if (++assertions > 1) throw new AgentMuxError('Original operator revoked.', 'CONTROL_PERMISSION_DENIED')
  })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await state.inspect('revoked-before-write')).operation).toBeNull()
  expect((await state.inspect()).revision).toBe(original.revision)
})

it('a failed new listener retains the exact previous live listener and applied revision', async () => {
  const f = await fixture()
  const saved = await f.save(f.config({ role: 'gateway', listen: { host: '127.0.0.1', port: 0 } }), 'initial-listener')
  await vi.waitFor(async () => expect((await f.rpc.call('mesh.inspect', {})).activeRevision).toBe(saved.settings.revision))
  const before = await f.rpc.call('mesh.inspect', {}), port = before.gateway.listener!.port
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>(resolve => occupied.close(() => resolve())))
  const address = occupied.address(); if (!address || typeof address === 'string') throw Error('Private occupied port missing')
  const newer = await f.save(f.config({ role: 'gateway', listen: { host: '127.0.0.1', port: address.port } }), 'failed-new-listener')
  expect(newer.diskDurability).toBe('confirmed')
  await vi.waitFor(async () => expect((await f.rpc.call('mesh.inspect', {})).apply.state).toBe('unavailable'))
  const after = await f.rpc.call('mesh.inspect', {})
  expect(after).toMatchObject({ desiredRevision: newer.settings.revision, activeRevision: before.activeRevision, gateway: before.gateway })
  expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404)
  expect((await f.rpc.call('system.endpoint', {})).publication!.state).toBe('available')
})

it('device ingress remains device, explicit pins precede original authorization, and removing a pin closes only that reader', async () => {
  const key = generateKeyPair(), daemon = generateKeyPair(), calls: string[] = []
  const f = await fixture({ endpoint: async () => ({ serverId: 'original-host-endpoint', keyPair: daemon, authorize: async publicKey => { calls.push(publicKey); return { principal: { kind: 'device', id: 'original-host:original-device' } } } }) })
  const saved = await f.save(f.config({ role: 'gateway', listen: { host: '127.0.0.1', port: 0 }, endpointAccess: { allowedClientKeys: [exportPublicKey(key.publicKey)] } }), 'enable-original-endpoint')
  await vi.waitFor(async () => expect((await f.rpc.call('mesh.inspect', {})).endpoint.state).toBe('available'))
  const network = await f.rpc.call('mesh.inspect', {}); if (network.endpoint.state !== 'available') throw Error('Original endpoint missing')
  const remote = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer: network.endpoint.offer }, relayKeyPair: key }); cleanup.push(() => remote.dispose())
  expect((await remote.call('system.endpoint', {})).publication!.state).toBe('available')
  await expect(remote.call('settings.mesh.configure', { expectedRevision: saved.settings.revision, operationId: 'device-cannot-configure', configuration: f.config() })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(calls).toEqual([exportPublicKey(key.publicKey)])
  const stranger = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer: network.endpoint.offer }, relayKeyPair: generateKeyPair() }); cleanup.push(() => stranger.dispose())
  await expect(stranger.call('system.endpoint', {})).rejects.toBeDefined(); expect(calls).toHaveLength(1)
  await f.save(f.config({ role: 'gateway', listen: { host: '127.0.0.1', port: 0 }, endpointAccess: { allowedClientKeys: [] } }), 'remove-original-pin')
  await vi.waitFor(async () => expect((await f.rpc.call('mesh.inspect', {})).activeRevision).not.toBe(saved.settings.revision))
  await expect(remote.call('system.endpoint', {})).rejects.toBeDefined()
  expect((await f.rpc.call('system.endpoint', {})).publication!.state).toBe('available')
})

it('a wrong original Runtime fence is rejected before a durable configuration save', async () => {
  const f = await fixture()
  await expect(f.rpc.call('settings.mesh.configure', { expectedRevision: f.settings.revision, operationId: 'wrong-target', configuration: f.config() }, { runtimeFence: { ...owner, runtimeId: 'other-runtime' } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect((await f.rpc.call('settings.mesh.inspect', { operationId: 'wrong-target' })).operation).toBeNull()
})

it('an unauthenticated HTTP guest cannot save settings and signed business routes cannot acquire Mesh administration scopes', async () => {
  const f = await fixture({ http: true })
  const response = await fetch(`http://127.0.0.1:${f.server.httpAddress!.port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'guest', method: 'settings.mesh.configure', params: { expectedRevision: f.settings.revision, operationId: 'guest-save', configuration: f.config() } }) })
  expect(response.status).toBe(401)
  expect((await f.rpc.call('settings.mesh.inspect', { operationId: 'guest-save' })).operation).toBeNull()
  expect(() => hostRouteScope({ method: 'settings.mesh.configure', params: { expectedRevision: f.settings.revision, operationId: 'delegated-save', configuration: f.config() } }, false)).toThrow()
  expect((await f.rpc.call('system.endpoint', {})).publication!.state).toBe('available')
})

it('close does not wait for unacquired optional Host authority and late resources cannot start a publisher', async () => {
  let resolve!: (value: Awaited<ReturnType<NonNullable<NonNullable<ConstructorParameters<typeof AgentMuxControlServer>[0]>['meshEndpoint']>>>) => void
  let entered = false
  const f = await fixture({ endpoint: async () => { entered = true; return await new Promise(value => { resolve = value }) } })
  await f.save(f.config(), 'held-original-authority')
  await vi.waitFor(() => expect(entered).toBe(true))
  await f.server.stop()
  resolve({ serverId: 'late-original-host', keyPair: generateKeyPair(), authorize: async () => { throw Error('late endpoint was used') } })
  await new Promise(value => setTimeout(value, 20))
  expect((await readFile(join(f.root, 'mesh-network.json'), 'utf8'))).toContain('held-original-authority')
})

it('explicit settings adoption can recover the same unavailable Host identity without restarting Core', async () => {
  let attempts = 0
  const keyPair = generateKeyPair()
  const f = await fixture({ endpoint: async () => {
    if (++attempts === 1) throw Error('original identity file unavailable')
    return { serverId: 'restored-original-host', keyPair, authorize: async () => ({ principal: { kind: 'device', id: 'original-device' } }) }
  } })
  await f.save(f.config(), 'first-original-identity-observation')
  await vi.waitFor(async () => expect(await f.rpc.call('mesh.inspect', {})).toMatchObject({ apply: { state: 'active' }, endpoint: { state: 'unavailable', issue: { code: 'MESH_ENDPOINT_UNAVAILABLE' } } }))
  const saved = await f.save(f.config(), 'explicit-original-identity-recovery')
  await vi.waitFor(async () => expect((await f.rpc.call('mesh.inspect', {})).endpoint.state).toBe('available'))
  expect((await f.rpc.call('mesh.inspect', {})).activeRevision).toBe(saved.settings.revision)
  expect(attempts).toBe(2)
  expect((await f.rpc.call('system.endpoint', {})).publication!.state).toBe('available')
})

it.each([
  ['unknown setting', { ...defaultMeshNetworkConfiguration(), secretKey: 'private-value' }],
  ['array role', { ...defaultMeshNetworkConfiguration(), role: ['disabled'] }],
  ['private endpoint key', { ...defaultMeshNetworkConfiguration(), endpointAccess: { allowedClientKeys: ['invalid'] } }],
] as const)('strict public configuration rejects %s', (_name, configuration) => {
  expect(() => parseMeshNetworkParams('settings.mesh.configure', { expectedRevision: 'R', operationId: 'OP', configuration })).toThrow()
})

it('the public link parser refuses a replaced daemon key or a URL carrying another offer', () => {
  const key = generateKeyPair(), original = parseConnectionOffer({ v: 2, serverId: 'original', daemonPublicKeyB64: exportPublicKey(key.publicKey), relay: { endpoint: '127.0.0.1:12345', useTls: false } })
  expect(() => parseMeshNetworkResult('mesh.link', { offer: { ...original, daemonPublicKeyB64: exportPublicKey(generateKeyPair().publicKey) }, url: 'http://127.0.0.1:12345/', observation: {} }, { offer: original })).toThrow()
})
