import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxError } from '../src/errors.js'
import { AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION } from '../src/runtime-owner-protocol.js'
import { NodePublishingOwner } from '../src/node-publishing-owner.js'
import { startAgentMuxRpcRelayPublisher } from '../src/rpc-relay-publisher.js'
import { generateKeyPair, exportPublicKey } from '@agentmux/relay/e2ee'
import { hashPublisherToken } from '@agentmux/relay/gateway'
import { CoreRelayGateway } from '../src/public-rpc-relay-gateway.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { parseMeshNetworkParams, parseMeshNetworkResult } from '../src/mesh-network.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import type { AgentMuxRpcMethod } from '../src/public-rpc.js'
import type { AgentMuxRpcCallContext, AgentMuxRpcService } from '../src/public-rpc-service.js'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); vi.restoreAllMocks() })
async function pair(cold = false) {
  const a = await rpcOwnerFixture(['original-a']), b = await rpcOwnerFixture(['original-a'])
  cleanup.push(a.close, b.close)
  const aOwner = { runtimeId: 'original-runtime-a', ownerInstanceId: 'original-instance-a' }
  const bOwner = { runtimeId: 'original-runtime-b', ownerInstanceId: 'original-instance-b' }
  const runtime = (owner: typeof aOwner): AgentMuxHostedRuntimeService => ({
    call: async () => ({ owner: { ...owner, protocolVersion: AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION, processId: process.pid, ctxmux: null, availability: 'connected' } }),
    assertFence(fence: typeof aOwner) { if (fence.runtimeId !== owner.runtimeId || fence.ownerInstanceId !== owner.ownerInstanceId) throw new AgentMuxError('Original owner changed.', 'RUNTIME_OWNER_MISMATCH') }
  }) as unknown as AgentMuxHostedRuntimeService
  const bs = new AgentMuxControlServer({ socketPath: join(b.root, 'b.sock'), coreClients: b.coreClients,
    meshState: { directory: join(b.root, 'mesh'), owner: bOwner }, nodePublishing: new NodePublishingOwner({ stateDirectory: b.root, ...bOwner }), hostedRuntime: () => runtime(bOwner),
    http: { host: '127.0.0.1', port: 0, authorize: request => request.headers.get('authorization') === 'Bearer original-device-token' ? { principal: { kind: 'device', id: 'limited-original-device' } } : null } })
  await bs.start(); cleanup.push(() => bs.stop())
  const bRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: bs.path } }); cleanup.push(() => bRpc.dispose())
  const limited = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: 'http://127.0.0.1:' + bs.httpAddress!.port, token: 'original-device-token' } }); cleanup.push(() => limited.dispose())
  const received: Array<{ method: string; context: AgentMuxRpcCallContext; params: unknown }> = []
  const bService = Reflect.get(bs, 'service') as AgentMuxRpcService
  const originalCall = bService.call.bind(bService)
  vi.spyOn(bService, 'call').mockImplementation(async (method, params, context = {}) => {
    received.push({ method, params, context }); return originalCall(method, params, context)
  })
  let afterReply: ((method: AgentMuxRpcMethod, value: any) => Promise<void> | void) | undefined
  const remote = await connectHostedAgentMux({ connectOnDemand: true, rpc: bRpc, expectedRuntimeId: bOwner.runtimeId,
    forwardRpc: async (method, params, context = {}) => {
      const value = await bRpc.call(method, params, { ...(context.caller ? { credentials: context.caller } : {}), ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}), ...(context.signal ? { signal: context.signal } : {}) })
      await afterReply?.(method, value); return value
    } })
  const published = await connectHostedAgentMux({ connectOnDemand: true, rpc: limited, expectedRuntimeId: bOwner.runtimeId,
    forwardRpc: (method, params, context = {}) => limited.call(method, params, { ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}), ...(context.signal ? { signal: context.signal } : {}) }) })
  cleanup.push(() => remote.dispose(), () => published.dispose())
  const host = { id: 'remote-b', kind: 'ssh' as const, label: 'Original B', hostname: 'original-operator.invalid', runtimeId: bOwner.runtimeId }
  let prepared = !cold
  const preparations: string[] = []
  const as = new AgentMuxControlServer({ socketPath: join(a.root, 'a.sock'),
    coreClients: (hostId, read) => {
      if (read) { preparations.push(hostId ?? 'unqualified'); if (hostId === 'remote-b') prepared = true }
      return [...a.coreClients(), ...(prepared ? [{ hostId: 'remote-b', client: remote }] : []), { hostId: 'published-b', client: published }].filter(scope => hostId === undefined || scope.hostId === hostId)
    },
    hostConfiguration: id => ['remote-b', 'published-b'].includes(id) ? { ...host, id } : null,
    meshState: { directory: join(a.root, 'mesh'), owner: aOwner }, nodePublishing: new NodePublishingOwner({ stateDirectory: a.root, ...aOwner }), hostedRuntime: () => runtime(aOwner),
    http: { host: '127.0.0.1', port: 0, authorize: request => request.headers.get('authorization') === 'Bearer a-device-token' ? { principal: { kind: 'device', id: 'original-a-device' } } : null } })
  await as.start(); cleanup.push(() => as.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: as.path }, credentials: a.credentials }); cleanup.push(() => rpc.dispose())
  await vi.waitFor(async () => expect((await bRpc.call('settings.mesh.inspect', {})).identity).not.toBeNull())
  const settings = await bRpc.call('settings.mesh.inspect', {}), local = await rpc.call('settings.mesh.inspect', {})
  const target = { hostId: host.id, expectedRuntimeId: bOwner.runtimeId }
  const configuration = { ...settings.configuration, role: 'participant' as const, networkId: 'original-pair', members: [{ peerId: settings.identity!.peerId, publicKey: settings.identity!.publicKey }] }
  return { a, b, as, bs, rpc, bRpc, received, preparations, host, aOwner, bOwner, target, settings, local, configuration,
    afterReply(value: typeof afterReply) { afterReply = value },
    input: (operationId: string) => ({ target, expectedRevision: settings.revision, operationId, configuration }) }
}

it('the original managed caller configures the selected Core through real SDK and CLI consumers', async () => {
  const f = await pair(), before = f.local.revision
  const inspected = await f.rpc.call('settings.mesh.inspect', { target: f.target }).then(value => ({ value }), error => ({ value: null, error: error.code, message: error.message }))
  expect(inspected, JSON.stringify(inspected)).toMatchObject({ value: { owner: f.bOwner } })
  const saved = await f.rpc.call('settings.mesh.configure', f.input('original-sdk-operation'))
  expect(saved).toMatchObject({ settings: { owner: f.bOwner, operation: { operationId: 'original-sdk-operation', status: 'confirmed' } }, diskDurability: 'confirmed' })
  await vi.waitFor(async () => expect((await f.rpc.call('mesh.inspect', { target: f.target })).activeRevision).toBe(saved.settings.revision))
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.as.path, 'settings', 'mesh', 'inspect', '--host', f.target.hostId, '--expected-runtime', f.target.expectedRuntimeId, '--operation-id', 'original-sdk-operation'],
    objectCliEnvironment(f.a.root, { AGENTMUX_AGENT_SESSION_ID: f.a.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: f.a.credentials.capability }))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result).toMatchObject({ owner: f.bOwner, operation: { operationId: 'original-sdk-operation' } })
  const cliSave = await runCompiledObjectCli(['--endpoint', 'unix:' + f.as.path, 'settings', 'mesh', 'configure', '--host', f.target.hostId, '--expected-runtime', f.target.expectedRuntimeId, '--input', '-'],
    objectCliEnvironment(f.a.root, { AGENTMUX_AGENT_SESSION_ID: f.a.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: f.a.credentials.capability }), JSON.stringify({ expectedRevision: saved.settings.revision, operationId: 'original-cli-operation', configuration: f.configuration }))
  expect(cliSave.code, cliSave.stderr).toBe(0)
  expect(JSON.parse(cliSave.stdout).result).toMatchObject({ settings: { owner: f.bOwner, operation: { operationId: 'original-cli-operation', status: 'confirmed' } }, diskDurability: 'confirmed' })
  expect((await f.rpc.call('settings.mesh.inspect', {})).revision).toBe(before)
  expect(f.received.filter(row => row.method === 'settings.mesh.configure')).toHaveLength(2)
  expect(f.received.filter(row => row.method.startsWith('settings.mesh.')).every(row => !row.context.caller && !('target' in (row.params as object)))).toBe(true)
  expect(f.a.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.b.inner.kernel.input).not.toHaveBeenCalled()
})

it('a wrong original Runtime is refused before configuration with a not-applied receipt', async () => {
  const f = await pair()
  await expect(f.rpc.call('settings.mesh.configure', { ...f.input('wrong-runtime'), target: { ...f.target, expectedRuntimeId: f.aOwner.runtimeId } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH', controlFailure: { disposition: 'not_applied' } })
  expect(f.received.filter(row => row.method === 'settings.mesh.configure')).toHaveLength(0)
  expect((await f.bRpc.call('settings.mesh.inspect', {})).revision).toBe(f.settings.revision)
})

it('the settings writer refuses a changed gateway process before dispatching its draft', async () => {
  const f = await pair()
  const changed = { ...f.target, expectedOwnerInstanceId: 'previous-gateway-instance' }
  await expect(f.rpc.call('settings.mesh.configure', { ...f.input('gateway-process-changed'), target: changed }))
    .rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH', controlFailure: { disposition: 'not_applied' } })
  expect(f.received.filter(row => row.method === 'settings.mesh.configure')).toHaveLength(0)
  expect((await f.bRpc.call('settings.mesh.inspect', {})).revision).toBe(f.settings.revision)
})

it('the entry Core rejects an invalid original Agent capability before borrowing the operator carrier', async () => {
  const f = await pair()
  const invalid = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.as.path }, credentials: { ...f.a.credentials, capability: 'invalid-original-capability' } }); cleanup.push(() => invalid.dispose())
  const rejected = await invalid.call('settings.mesh.configure', f.input('invalid-caller')).then(value => ({ value }), error => ({ error: error.code }))
  expect(rejected).toHaveProperty('error')
  expect(f.received.filter(row => row.method === 'settings.mesh.configure')).toHaveLength(0)
  expect((await f.bRpc.call('settings.mesh.inspect', {})).revision).toBe(f.settings.revision)
})

it('the receiving Core refuses a device-only saved carrier instead of granting operator authority', async () => {
  const f = await pair()
  await expect(f.rpc.call('settings.mesh.configure', { ...f.input('limited-carrier'), target: { ...f.target, hostId: 'published-b' } })).rejects.toHaveProperty('code', 'CONTROL_PERMISSION_DENIED')
  expect((await f.bRpc.call('settings.mesh.inspect', {})).revision).toBe(f.settings.revision)
  expect(f.received.filter(row => row.method === 'settings.mesh.configure' && row.context.principal?.kind === 'user')).toHaveLength(0)
})

it('an entry device can read its own Mesh but cannot borrow a selected remote operator route', async () => {
  const f = await pair(), device = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: 'http://127.0.0.1:' + f.as.httpAddress!.port, token: 'a-device-token' } }); cleanup.push(() => device.dispose())
  expect((await device.call('mesh.inspect', {})).owner).toEqual(f.aOwner)
  const before = f.received.length
  await expect(device.call('mesh.inspect', { target: f.target })).rejects.toHaveProperty('code', 'CONTROL_PERMISSION_DENIED')
  expect(f.received).toHaveLength(before)
})

it('a changed selected route rejects a late read without adopting another owner', async () => {
  const f = await pair()
  f.afterReply(method => { if (method === 'settings.mesh.inspect') f.host.hostname = 'replaced-operator.invalid' })
  await expect(f.rpc.call('settings.mesh.inspect', { target: f.target })).rejects.toHaveProperty('code', 'RUNTIME_OWNER_MISMATCH')
})

it('a remote reply with the same Runtime but another owner instance is rejected', async () => {
  const f = await pair()
  f.afterReply((method, value) => { if (method === 'settings.mesh.inspect') value.owner.ownerInstanceId = 'unrelated-instance' })
  const result = await f.rpc.call('settings.mesh.inspect', { target: f.target }).then(value => ({ value }), error => ({ error: error.code }))
  expect(result).toMatchObject({ error: 'CONTROL_PROTOCOL_ERROR' })
})

it('a confirmed original save ACK survives a later route change and remains inspectable by its original operation', async () => {
  const f = await pair()
  f.afterReply(method => { if (method === 'settings.mesh.configure') f.host.hostname = 'later-operator.invalid' })
  const result = await f.rpc.call('settings.mesh.configure', f.input('ack-before-route-change')).then(value => ({ value }), error => ({ value: null, error: error.code }))
  expect(result).toMatchObject({ value: { settings: { owner: f.bOwner, operation: { operationId: 'ack-before-route-change', status: 'confirmed' } }, diskDurability: 'confirmed' } })
  f.afterReply(undefined); f.host.hostname = 'original-operator.invalid'
  const observed = await f.rpc.call('settings.mesh.inspect', { target: f.target, operationId: 'ack-before-route-change' })
  expect(observed.operation?.operationId).toBe('ack-before-route-change')
  expect(f.received.filter(row => row.method === 'settings.mesh.configure')).toHaveLength(1)
})

it('the original local Mesh save does not replace an obtained ACK with its observation tail', async () => {
  const f = await pair(), gateway = new CoreRelayGateway(undefined, { directory: join(f.a.root, 'ack-owner'), owner: f.aOwner })
  cleanup.push(() => gateway.stop()); gateway.start()
  const original = await gateway.call('settings.mesh.inspect', {})
  let returned = false
  const inner = Reflect.get(gateway, 'settings'), configure = inner.configure.bind(inner)
  vi.spyOn(inner, 'configure').mockImplementation(async (...args: unknown[]) => { const result = await configure(...args); returned = true; return result })
  const result = await gateway.call('settings.mesh.configure', { expectedRevision: original.revision, operationId: 'local-original-ack', configuration: original.configuration }, async () => { if (returned) throw Error('Observer was cancelled after the original ACK') }).then(value => ({ value }), error => ({ value: null, error: error.message }))
  expect(result).toMatchObject({ value: { settings: { operation: { operationId: 'local-original-ack', status: 'confirmed' } }, diskDurability: 'confirmed' } })
})

it('Mesh CLI selects one complete literal target and rejects partial or duplicate selection', async () => {
  const f = await pair(), file = join(f.a.root, 'original.json')
  await writeFile(file, JSON.stringify({ target: f.target }))
  const parsed = await parseAgentMuxCliInvocation(['mesh', 'inspect', '--host=remote-b', '--expected-runtime=' + f.bOwner.runtimeId])
  expect(parsed.params).toEqual({ target: f.target })
  for (const args of [['mesh', 'inspect', '--host', 'remote-b'], ['mesh', 'inspect', '--host', 'remote-b', '--expected-runtime', f.bOwner.runtimeId, '--input', file]]) await expect(parseAgentMuxCliInvocation(args)).rejects.toHaveProperty('code', 'INVALID_CLI_ARGUMENT')
  expect(parseMeshNetworkParams('mesh.inspect', { target: f.target })).toEqual({ target: f.target })
  expect(() => parseMeshNetworkResult('settings.mesh.inspect', f.local, { target: f.target })).toThrow()
})

it('a cold saved B is prepared exactly once without initializing an unrelated Host', async () => {
  const f = await pair(true)
  const result = await f.rpc.call('settings.mesh.inspect', { target: f.target }).then(value => ({ value }), error => ({ value: null, error: error.code }))
  expect(result, JSON.stringify(result)).toMatchObject({ value: { owner: f.bOwner } })
  expect(f.preparations).toEqual(['remote-b'])
})

it('the shared operator route retains original Node policy reads and saves', async () => {
  const f = await pair(true), local = await f.rpc.call('settings.node.inspect', {})
  const original = await f.rpc.call('settings.node.inspect', { target: f.target })
  const policy = { ...original.policy, alias: 'selected-b' }
  const result = await f.rpc.call('settings.node.configure', { target: f.target, expectedRevision: original.policyRevision, operationId: 'selected-node-original', policy })
  expect(result).toMatchObject({ node: f.bOwner, policy, operation: { operationId: 'selected-node-original', status: 'confirmed' } })
  expect((await f.rpc.call('settings.node.inspect', {})).policyRevision).toBe(local.policyRevision)
  expect(f.received.filter(call => call.method.startsWith('settings.node.')).every(call => !call.context.caller)).toBe(true)
})

it('a lost original write response stays unknown and is inspected without reapplying the configuration', async () => {
  const f = await pair()
  f.afterReply(method => { if (method === 'settings.mesh.configure') throw new AgentMuxError('Original response was lost after the owner saved.', 'CONTROL_UNAVAILABLE') })
  const failure = await f.rpc.call('settings.mesh.configure', f.input('original-lost-response')).then(() => undefined, error => error)
  expect(failure).toHaveProperty('code', 'CONTROL_UNAVAILABLE')
  expect(failure).not.toHaveProperty('controlFailure.disposition', 'not_applied')
  f.afterReply(undefined)
  const observed = await f.rpc.call('settings.mesh.inspect', { target: f.target, operationId: 'original-lost-response' })
  expect(observed.operation?.operationId).toBe('original-lost-response')
  expect(observed.configuration).toEqual(f.configuration)
  expect(f.received.filter(row => row.method === 'settings.mesh.configure')).toHaveLength(1)
})

it('the existing local Mesh default route still hot-configures its original Core only', async () => {
  const f = await pair()
  await vi.waitFor(async () => expect((await f.rpc.call('settings.mesh.inspect', {})).identity).not.toBeNull())
  const local = await f.rpc.call('settings.mesh.inspect', {}), configuration = { ...local.configuration, role: 'participant' as const, networkId: 'original-local', members: [{ peerId: local.identity!.peerId, publicKey: local.identity!.publicKey }] }
  const saved = await f.rpc.call('settings.mesh.configure', { expectedRevision: local.revision, operationId: 'local-default-original', configuration })
  expect(saved).toMatchObject({ settings: { owner: f.aOwner, operation: { operationId: 'local-default-original', status: 'confirmed' } }, diskDurability: 'confirmed' })
  await vi.waitFor(async () => expect((await f.rpc.call('mesh.inspect', {})).activeRevision).toBe(saved.settings.revision))
  expect((await f.bRpc.call('settings.mesh.inspect', {})).revision).toBe(f.settings.revision)
})

it('an explicit local owner target preserves managed operator access and refuses another Runtime before saving', async () => {
  const f = await pair(), target = { hostId: 'local', expectedRuntimeId: f.aOwner.runtimeId }
  await expect(f.rpc.call('settings.mesh.configure', { target: { ...target, expectedRuntimeId: f.bOwner.runtimeId }, expectedRevision: f.local.revision, operationId: 'wrong-local-runtime', configuration: f.local.configuration })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH', controlFailure: { disposition: 'not_applied' } })
  expect((await f.rpc.call('settings.mesh.inspect', {})).revision).toBe(f.local.revision)
  const selected = await f.rpc.call('settings.mesh.inspect', { target })
  const saved = await f.rpc.call('settings.mesh.configure', { target, expectedRevision: selected.revision, operationId: 'explicit-local-original', configuration: selected.configuration })
  expect(saved).toMatchObject({ settings: { owner: f.aOwner, operation: { operationId: 'explicit-local-original', status: 'confirmed' } }, diskDurability: 'confirmed' })
})

it('a local device pin preserves actual Mesh reads and links without gaining settings authority', async () => {
  const f = await pair()
  await vi.waitFor(async () => expect((await f.rpc.call('settings.mesh.inspect', {})).identity).not.toBeNull())
  const settings = await f.rpc.call('settings.mesh.inspect', {}), relay = { endpoint: '127.0.0.1:' + f.as.httpAddress!.port, useTls: false }
  const token = 'private-original-publisher', serverId = 'original-a-publisher', keyPair = generateKeyPair()
  const saved = await f.rpc.call('settings.mesh.configure', { expectedRevision: settings.revision, operationId: 'local-device-link-gateway', configuration: {
    ...settings.configuration, role: 'gateway', networkId: 'private-local-link', members: [{ peerId: settings.identity!.peerId, publicKey: settings.identity!.publicKey }],
    publishers: [{ serverId, tokenHash: hashPublisherToken(token) }], advertisedIngress: [relay]
  } })
  await vi.waitFor(async () => expect((await f.rpc.call('mesh.inspect', {})).activeRevision).toBe(saved.settings.revision))
  let connected = false
  const publisher = startAgentMuxRpcRelayPublisher({ server: f.as, serverId, keyPair, relay, publisherToken: token,
    authorize: async () => { throw new AgentMuxError('The descriptor grants no endpoint client authority.', 'CONTROL_PERMISSION_DENIED') }, onState: state => { connected = state === 'connected' } })
  cleanup.push(() => publisher.stop()); await vi.waitFor(() => expect(connected).toBe(true))
  await vi.waitFor(async () => expect((await f.rpc.call('mesh.inspect', {})).network?.routes.some(route => route.serverId === serverId)).toBe(true))
  const device = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: 'http://' + relay.endpoint, token: 'a-device-token' } }); cleanup.push(() => device.dispose())
  const target = { hostId: 'local', expectedRuntimeId: f.aOwner.runtimeId }, offer = { v: 2 as const, serverId, daemonPublicKeyB64: exportPublicKey(keyPair.publicKey), relay }
  const observed = await device.call('mesh.inspect', { target }).then(value => ({ value }), error => ({ error: error.code }))
  expect(observed).toMatchObject({ value: { owner: f.aOwner, apply: { state: 'active' } } })
  const plain = await device.call('mesh.link', { offer })
  const pinned = await device.call('mesh.link', { target, offer }).then(value => ({ value }), error => ({ error: error.code }))
  expect(pinned).toMatchObject({ value: { offer: plain.offer, observation: { owner: f.aOwner } } })
  await expect(device.call('mesh.inspect', { target: { ...target, expectedRuntimeId: f.bOwner.runtimeId } })).rejects.toHaveProperty('code', 'RUNTIME_OWNER_MISMATCH')
  await expect(device.call('settings.mesh.configure', { target, expectedRevision: saved.settings.revision, operationId: 'device-pin-no-write', configuration: saved.settings.configuration })).rejects.toHaveProperty('code', 'CONTROL_PERMISSION_DENIED')
  expect((await f.rpc.call('settings.mesh.inspect', {})).revision).toBe(saved.settings.revision)
})
