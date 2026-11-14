import { afterEach, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { generateKeyPair, exportPublicKey } from '@agentmux/relay/e2ee'
import { createRelayMeshIdentity, startRelayGateway, hashPublisherToken } from '@agentmux/relay/gateway'
import { parseConnectionOffer } from '@agentmux/relay/offer'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
it('the real headless CLI publishes its original E2EE business endpoint and retains it through Core restart', async () => {
  const entry = process.env.AGENTMUX_HEADLESS_ENDPOINT_ENTRY
  const scope = await headlessFixture({ cli: true, ...(entry ? { ownerEntry: entry } : {}) }); cleanup.push(() => scope.cleanup())
  const local = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } }); cleanup.push(() => local.dispose())
  const settings = await until(() => local.call('settings.mesh.inspect', {}), value => value.identity !== null, 'original network identity')
  const key = generateKeyPair(), networkIdentity = { ...createRelayMeshIdentity(), epoch: 1 }
  const members = [{ peerId: settings.identity!.peerId, publicKey: settings.identity!.publicKey }, { peerId: networkIdentity.peerId, publicKey: networkIdentity.publicKey }]
  const gateway = await startRelayGateway({ host: '127.0.0.1', port: 0, publishers: [], mesh: { networkId: 'headless-endpoint-network', identity: networkIdentity, members,
    peers: [{ peerId: settings.identity!.peerId, endpoints: [] }] } }); cleanup.push(() => gateway.stop())
  const relay = { endpoint: `127.0.0.1:${gateway.port}`, useTls: false }
  const configuration = { ...settings.configuration, role: 'participant' as const, networkId: 'headless-endpoint-network', members,
    peers: [{ peerId: networkIdentity.peerId, endpoints: [relay] }], endpointAccess: { allowedClientKeys: [exportPublicKey(key.publicKey)] } }
  const saved = await local.call('settings.mesh.configure', { expectedRevision: settings.revision, operationId: 'enable-original-headless-endpoint', configuration })
  expect(saved.diskDurability).toBe('confirmed')
  await until(() => local.call('mesh.inspect', {}), value => value.activeRevision === saved.settings.revision, 'original Mesh adoption')
  const initial = await local.call('mesh.inspect', {})
  expect(initial.endpoint.state, 'Original headless endpoint business path must be composed by the real serve entry').not.toBe('not-provided')
  const published = await until(() => local.call('mesh.inspect', {}), value => value.endpoint.state === 'available', 'original endpoint publication')
  if (published.endpoint.state !== 'available') throw Error('Original headless endpoint missing')
  const offer = parseConnectionOffer({ ...published.endpoint.offer, relay })
  await until(() => gateway.resolvePublisher(offer.serverId), Boolean, 'real gateway path to original headless endpoint')
  const client = await scope.client()
  const session = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root, injectAgentMuxGuide: false,
    createOperationId: 'headless-endpoint-agent', commandOverride: resolve(import.meta.dirname, 'fixtures/fake-codex-cli.mjs'), env: { AGENTMUX_FAKE_NATIVE_RECORD: '1' } })
  cleanup.push(async () => { await (await scope.client()).stopAgent(session.agentSessionId, session.run) })
  const original = await client.statusAgent(session.agentSessionId)
  const remote = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer }, relayKeyPair: key }); cleanup.push(() => remote.dispose())
  expect((await remote.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId } })).session).toMatchObject({ agentSessionId: session.agentSessionId, run: session.run })
  const hello = await remote.call('device.hello', { name: 'Private encrypted client' })
  const readerEnds: unknown[] = []
  const reader = await remote.subscribe('agent.output', { agentSessionId: session.agentSessionId, afterByte: 0, follow: true }, {
    onInitial: value => expect(value.run.runId).toBe(session.run.runId), onEvent: () => {}, onEnd: error => readerEnds.push(error)
  }); cleanup.push(() => reader.dispose())
  const collision = await local.call('settings.mesh.configure', { expectedRevision: saved.settings.revision, operationId: 'refuse-cached-endpoint-collision',
    configuration: { ...configuration, publishers: [{ serverId: offer.serverId, tokenHash: hashPublisherToken('another-public-publisher-grant') }] } })
  expect(collision.diskDurability).toBe('confirmed')
  const collisionObservation = await until(() => local.call('mesh.inspect', {}), value => value.desiredRevision === collision.settings.revision && value.apply.state !== 'starting', 'cached endpoint collision observed')
  const continuingRead = await remote.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId } }).then(value => ({ value }), error => ({ error }))
  expect(continuingRead, 'Cached local endpoint collision must preserve the original encrypted business reader').toMatchObject({ value: { session: { agentSessionId: session.agentSessionId, run: session.run } } })
  expect(collisionObservation).toMatchObject({ activeRevision: saved.settings.revision, apply: { state: 'unavailable' }, endpoint: { state: 'available' } })
  expect(readerEnds).toEqual([])
  expect((await remote.call('runtime.owner.identity', {})).owner).toEqual(scope.owner)
  expect((await client.statusAgent(session.agentSessionId)).run).toMatchObject({ runId: original.run!.runId, pid: original.run!.pid, state: 'running' })
  const retained = await local.call('settings.mesh.configure', { expectedRevision: collision.settings.revision, operationId: 'retain-original-endpoint-after-collision', configuration })
  await until(() => local.call('mesh.inspect', {}), value => value.activeRevision === retained.settings.revision, 'explicit original configuration retained')
  const devices = await local.call('device.ls', {})
  expect(devices.hostId).toBe(offer.serverId)
  expect(devices.devices.find(value => value.deviceId === hello.device.deviceId)?.keyFingerprint).toBeDefined()
  expect(devices.mobileAccess.state).toBe('unavailable')
  await expect(local.call('device.link', {})).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  await expect(remote.call('settings.mesh.configure', { expectedRevision: saved.settings.revision, operationId: 'device-must-not-administer', configuration })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(remote.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId } }, { runtimeFence: { ownerInstanceId: scope.owner.ownerInstanceId, runtimeId: 'another-core-runtime' } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  const stranger = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer }, relayKeyPair: generateKeyPair() }); cleanup.push(() => stranger.dispose())
  await expect(stranger.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId } })).rejects.toBeDefined()
  const wrongDaemon = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer: { ...offer, daemonPublicKeyB64: exportPublicKey(generateKeyPair().publicKey) } }, relayKeyPair: key }); cleanup.push(() => wrongDaemon.dispose())
  await expect(wrongDaemon.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId } })).rejects.toBeDefined()
  const authorityPath = join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'agentmux-devices.json'), keyPath = join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'agentmux-relay-keypair.json')
  const bytes = await readFile(keyPath), before = scope.owner, nativePid = scope.nativeProcessId
  await reader.dispose(); await remote.dispose(); await local.dispose()
  const restarted = await scope.restart()
  expect(restarted.owner.runtimeId).toBe(before.runtimeId)
  expect(restarted.owner.ownerInstanceId).not.toBe(before.ownerInstanceId)
  expect(restarted.owner.ctxmux).toEqual(before.ctxmux)
  expect(scope.nativeProcessId).toBe(nativePid)
  expect(await readFile(keyPath)).toEqual(bytes)
  const localAfter = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } }); cleanup.push(() => localAfter.dispose())
  const republished = await until(() => localAfter.call('mesh.inspect', {}), value => value.endpoint.state === 'available', 'same original endpoint after real Core restart')
  if (republished.endpoint.state !== 'available') throw Error('Original endpoint not restored')
  expect(republished.endpoint.offer).toMatchObject({ serverId: offer.serverId, daemonPublicKeyB64: offer.daemonPublicKeyB64 })
  expect(republished.identity).toMatchObject({ peerId: published.identity!.peerId, publicKey: published.identity!.publicKey, epoch: published.identity!.epoch + 1 })
  await until(() => gateway.resolvePublisher(offer.serverId), Boolean, 'restarted original publisher route')
  const next = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer }, relayKeyPair: key }); cleanup.push(() => next.dispose())
  const restored = await next.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId } })
  expect(restored.session).toMatchObject({ agentSessionId: session.agentSessionId, run: session.run })
  expect((await (await scope.client()).statusAgent(session.agentSessionId)).run).toMatchObject({ runId: original.run!.runId, pid: original.run!.pid, state: 'running' })
  const revoked = await localAfter.call('device.revoke', { deviceId: hello.device.deviceId })
  expect(revoked.device.revokedAt).toBeDefined()
  await expect(next.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId } })).rejects.toBeDefined()
  const revokedAgain = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer }, relayKeyPair: key }); cleanup.push(() => revokedAgain.dispose())
  await expect(revokedAgain.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId } })).rejects.toBeDefined()
  expect((await localAfter.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId } })).session.run).toEqual(session.run)
  // A damaged optional endpoint cannot close the original Core or healthy Run.
  await next.dispose(); await localAfter.dispose(); await scope.stopOwner()
  const authorityBytes = await readFile(authorityPath)
  await writeFile(authorityPath, 'unreadable-original-authority')
  const damagedRestart = await scope.restart()
  expect(damagedRestart.owner.runtimeId).toBe(before.runtimeId)
  expect(scope.nativeProcessId).toBe(nativePid)
  const retainedLocal = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } }); cleanup.push(() => retainedLocal.dispose())
  await until(() => retainedLocal.call('mesh.inspect', {}), value => value.apply.state === 'active' && value.endpoint.state === 'unavailable', 'network remains active with corrupt endpoint identity')
  expect(await readFile(authorityPath, 'utf8')).toBe('unreadable-original-authority')
  expect((await (await scope.client()).statusAgent(session.agentSessionId)).run).toMatchObject({ runId: original.run!.runId, pid: original.run!.pid, state: 'running' })
  expect(await readFile(keyPath)).toEqual(bytes)
  await writeFile(authorityPath, authorityBytes)
  const desired = await retainedLocal.call('settings.mesh.inspect', {})
  await retainedLocal.call('settings.mesh.configure', { expectedRevision: desired.revision, operationId: 'retry-restored-original-endpoint', configuration: desired.configuration })
  const recovered = await until(() => retainedLocal.call('mesh.inspect', {}), value => value.endpoint.state === 'available', 'explicit retry restores original endpoint identity')
  if (recovered.endpoint.state !== 'available') throw Error('Original endpoint recovery missing')
  expect(recovered.endpoint.offer).toMatchObject({ serverId: offer.serverId, daemonPublicKeyB64: offer.daemonPublicKeyB64 })
  expect((await retainedLocal.call('device.ls', {})).devices.find(value => value.deviceId === hello.device.deviceId)?.revokedAt).toBe(revoked.device.revokedAt)
  if (process.env.AGENTMUX_HEADLESS_ENDPOINT_PROOF) await writeFile(process.env.AGENTMUX_HEADLESS_ENDPOINT_PROOF, JSON.stringify({ before, after: restarted.owner, damagedRestart: damagedRestart.owner, nativePid, session: session.agentSessionId,
    run: session.run, processId: original.run!.pid, endpoint: { serverId: offer.serverId, daemonPublicKeyB64: offer.daemonPublicKeyB64 }, keySha256: createHash('sha256').update(bytes).digest('hex'),
    authoritySchema: JSON.parse(await readFile(authorityPath, 'utf8')).schema, revoked: revoked.device.deviceId, gateway: { path: gateway.resolvePublisher(offer.serverId) } }, null, 2))
}, 120_000)
