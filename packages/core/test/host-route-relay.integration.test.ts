import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { exportPublicKey } from '@agentmux/relay/e2ee'
import { createRelayMeshIdentity, startRelayGateway } from '@agentmux/relay/gateway'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { loadOrCreateRelayKeyPair } from '../src/rpc-relay-keypair.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function originalCore() {
  const ownerEntry = process.env.AGENTMUX_HEADLESS_ENDPOINT_ENTRY
  const loader = process.env.AGENTMUX_HEADLESS_ENDPOINT_SOURCE_LOADER
  const scope = await headlessFixture({ cli: true, ...(ownerEntry ? { ownerEntry } : {}),
    ...(loader ? { ownerNodeArgs: ['--experimental-transform-types', '--import', loader] } : {}) })
  cleanup.push(scope.cleanup)
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
  cleanup.push(() => rpc.dispose())
  return { scope, rpc }
}

it('persists an authenticated Relay edge and uses it for signed calls and readers on the original Core', async () => {
  const source = await originalCore(), receiver = await originalCore()
  const key = await loadOrCreateRelayKeyPair(join(source.scope.env.HOME!, '.agentmux', 'relay-client-keypair.json'))
  const settings = await until(() => receiver.rpc.call('settings.mesh.inspect', {}), value => value.identity !== null, 'receiver Mesh identity')
  const identity = { ...createRelayMeshIdentity(), epoch: 1 }, member = settings.identity!
  const members = [{ peerId: member.peerId, publicKey: member.publicKey }, { peerId: identity.peerId, publicKey: identity.publicKey }]
  const networkId = 'original-route-relay-network'
  const gateway = await startRelayGateway({ host: '127.0.0.1', port: 0, publishers: [], mesh: { networkId, identity, members,
    peers: [{ peerId: member.peerId, endpoints: [] }] } })
  cleanup.push(() => gateway.stop())
  const relay = { endpoint: `127.0.0.1:${gateway.port}`, useTls: false }
  await receiver.rpc.call('settings.mesh.configure', { expectedRevision: settings.revision, operationId: 'adopt-receiver-mesh', configuration: {
    ...settings.configuration, role: 'participant', networkId, members, peers: [{ peerId: identity.peerId, endpoints: [relay] }],
    endpointAccess: { allowedClientKeys: [exportPublicKey(key.publicKey)] },
  } })
  const published = await until(() => receiver.rpc.call('mesh.inspect', {}), value => value.endpoint.state === 'available', 'receiver business endpoint')
  if (published.endpoint.state !== 'available') throw Error('Original receiver did not publish')
  const offer = { ...published.endpoint.offer, relay }
  await until(() => gateway.resolvePublisher(offer.serverId), Boolean, 'original gateway publisher')

  const { identity: sourceIdentity, actor } = await source.rpc.call('route.choices', {})
  expect((await source.rpc.call('route.edges', {})).edges).toEqual([])
  const target = await receiver.rpc.call('route.identity', {})
  const edge = { edgeId: 'receiver-via-relay', label: 'Original receiver', target, offer }
  const route = { source: sourceIdentity, hops: [{ edgeId: edge.edgeId, kind: 'relay' as const, target }] }
  const routes = [{ id: 'original-receiver', route }]
  const expectedRevision = (await source.rpc.call('route.inspect', {})).revision
  const configured = await source.rpc.call('route.configure', { expectedRevision, operationId: 'adopt-relay-edge', configuration: { routes, grants: [], relayEdges: [edge] } })
  expect(configured).toMatchObject({ diskDurability: 'confirmed', settings: { relayEdges: [edge] } })
  expect((await source.rpc.call('route.edges', {})).edges).toEqual([{ edgeId: edge.edgeId, kind: 'relay', label: edge.label, runtimeId: target.runtimeId }])
  expect(await source.rpc.call('route.edge.inspect', { edgeId: edge.edgeId })).toMatchObject({ identity: sourceIdentity, actor, target })

  const call = { routeId: routes[0]!.id, adoptedRoute: route, requestId: 'original-relay-call', call: { method: 'runtime.owner.identity', params: {} } }
  await expect(source.rpc.call('route.call', call)).rejects.toMatchObject({ code: 'HOST_ROUTE_NOT_DELEGATED' })
  const grants = [{ id: 'original-actor-read', delegator: sourceIdentity, actor, destination: target,
    scopes: ['runtime.owner.identity', 'runtime.events'] }]
  const receiverPolicy = await receiver.rpc.call('route.inspect', {})
  const granted = await receiver.rpc.call('route.configure', { expectedRevision: receiverPolicy.revision, operationId: 'grant-original-reader', configuration: { routes: [], grants } })
  const owner = (await receiver.rpc.call('runtime.owner.identity', {})).owner
  expect(await source.rpc.call('route.call', call)).toMatchObject({ value: { owner }, observation: { actor, route, requestId: call.requestId, logicalHops: 1 } })

  const opening: unknown[] = []
  const watch = { ...call, requestId: 'original-relay-reader', call: { method: 'runtime.events', params: {
    consumerId: 'original-relay-consumer', fence: { ownerInstanceId: owner.ownerInstanceId, runtimeId: owner.runtimeId },
  } } }
  const reader = await source.rpc.subscribe('route.watch', watch, { onInitial: value => opening.push(value), onEvent: () => {} })
  cleanup.push(() => reader.dispose())
  expect(opening).toMatchObject([{ observation: { actor, route, requestId: 'original-relay-reader', logicalHops: 1 } }])
  await reader.dispose()

  const observed = await source.rpc.call('route.configure', { expectedRevision: configured.settings.revision,
    operationId: 'preserve-relay-on-policy-save', configuration: { routes, grants: [] } })
  expect(observed.settings.relayEdges).toEqual([edge])
  await source.rpc.dispose()
  await source.scope.restart()
  const resumed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: source.scope.socketPath } })
  cleanup.push(() => resumed.dispose())
  expect(await resumed.call('route.call', call)).toMatchObject({ value: { owner }, observation: { actor, route } })

  const mismatchingPin = { ...target, runtimeId: 'another-original-runtime' }
  const wrongPin = await resumed.call('route.configure', { expectedRevision: observed.settings.revision,
    operationId: 'pin-another-core', configuration: { routes, grants: [], relayEdges: [{ ...edge, target: mismatchingPin }] } })
  await expect(resumed.call('route.edge.inspect', { edgeId: edge.edgeId })).rejects.toMatchObject({ code: 'HOST_ROUTE_TARGET_MISMATCH' })
  await expect(resumed.call('route.call', call)).rejects.toMatchObject({ code: 'HOST_ROUTE_TARGET_MISMATCH' })
  const restored = await resumed.call('route.configure', { expectedRevision: wrongPin.settings.revision,
    operationId: 'restore-original-pin', configuration: { routes, grants: [], relayEdges: [edge] } })
  const readerEnds: unknown[] = []
  const active = await resumed.subscribe('route.watch', { ...watch, requestId: 'original-reader-revocation' },
    { onInitial: () => {}, onEvent: event => { if (event.type === 'error') readerEnds.push(event.error) }, onEnd: error => readerEnds.push(error) })
  cleanup.push(() => active.dispose())
  await receiver.rpc.call('route.configure', { expectedRevision: granted.settings.revision, operationId: 'revoke-original-grant', configuration: { routes: [], grants: [] } })
  await until(() => readerEnds.length, Boolean, 'revoked original reader closes', 5_000)
  await expect(resumed.call('route.call', call)).rejects.toMatchObject({ code: 'HOST_ROUTE_NOT_DELEGATED' })
  await resumed.call('route.configure', { expectedRevision: restored.settings.revision, operationId: 'remove-original-edge', configuration: { routes, grants: [], relayEdges: [] } })
  await expect(resumed.call('route.call', call)).rejects.toMatchObject({ code: 'HOST_ROUTE_EDGE_UNAVAILABLE' })
  expect((await receiver.rpc.call('runtime.owner.identity', {})).owner).toEqual(owner)
})
