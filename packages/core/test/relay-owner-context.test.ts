import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { createDaemonChannel, exportPublicKey, generateKeyPair, type Transport } from '@agentmux/relay/e2ee'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectRelayHostedClient } from '../src/relay-hosted.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import { createConnectionServices } from '../../connectors/src/connection-services.js'
import { createCredentialAdministration } from '../../../apps/host/src/credential-administration.js'
import { DeviceAuthority } from '../../../apps/host/src/device-authority.js'
import { createDeviceAdministration } from '../../../apps/host/src/device-administration.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

// Real Core registry/journal, public dispatcher, ConnectionServices database,
// DeviceAuthority and production E2EE over loopback WebSockets. Native byte I/O
// remains the original deterministic fixture; this does not prove a Native turn.
const cleanups: Array<() => unknown | Promise<unknown>> = []
const witness = process.env.AGENTMUX_RELAY_OWNER_WITNESS
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
function transport(socket: WebSocket): Transport {
  const port: Transport = { send: data => { socket.send(data) },
    close: (code, reason) => socket.close(code === 1011 ? 4011 : code, reason),
    onmessage: null, onclose: null, onerror: null }
  socket.on('message', (data, isBinary) => port.onmessage?.({
    data: isBinary ? Uint8Array.from(data as Buffer).buffer : data.toString(), isBinary }))
  socket.on('close', (code, reason) => port.onclose?.(code, reason.toString()))
  socket.on('error', error => port.onerror?.(error))
  return port
}
async function fixture() {
  const f = await rpcOwnerFixture(); cleanups.push(f.close)
  vi.spyOn(f.client, 'connect').mockResolvedValue()
  const owner: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'relay-owner-runtime', ownerInstanceId: 'relay-owner-current',
    protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: f.client.runtimeIdentity() }
  const hosted = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => owner)
  cleanups.push(() => hosted.dispose())
  const services = await createConnectionServices({ directory: join(f.root, 'connections') })
  cleanups.push(() => services.close())
  services.connections.credential = createCredentialAdministration({ target: owner, secrets: services.secrets })
  const authority = await DeviceAuthority.open(join(f.root, 'device-authority.json'))
  cleanups.push(() => authority.flush())
  const administration = createDeviceAdministration(Promise.resolve(authority), () => ({ state: 'connected', message: 'Private loopback' }), () => 'http://127.0.0.1/')
  const deviceCall = vi.spyOn(administration, 'call')
  const credentialStore = vi.spyOn(services.connections.credential, 'store')
  const server = new AgentMuxControlServer({ coreClients: f.coreClients, hostedRuntime: () => hosted,
    connections: services.connections, deviceAdministration: administration })
  cleanups.push(() => server.stop())
  const key = generateKeyPair(), deviceKey = generateKeyPair(), frames: Array<{ method: string; params: Record<string, unknown> }> = []
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => relay.once('listening', resolve))
  cleanups.push(async () => { for (const socket of relay.clients) socket.terminate(); await new Promise<void>(resolve => relay.close(() => resolve())) })
  relay.on('connection', socket => {
    let rpc: ReturnType<AgentMuxControlServer['openAuthenticatedFrames']> | undefined
    let queue = Promise.resolve()
    const channel = createDaemonChannel(transport(socket), key, { onmessage: data => {
      queue = queue.then(async () => {
        const encrypted = await channel
        const publicKey = encrypted.peerPublicKeyB64!
        const device = await authority.authorizeKey(publicKey)
        if (!rpc) {
          const observation = authority.observe(device)
          rpc = server.openAuthenticatedFrames({ authorization: {
            principal: { kind: 'device', id: `${authority.hostId}:${device.deviceId}` }, signal: observation.signal,
            assertCurrent: () => authority.assertCurrentKey({ deviceId: device.deviceId, createdAt: device.createdAt }, publicKey)
          }, send: async frame => { await encrypted.send(JSON.stringify(frame)) }, close: () => socket.close() })
          socket.once('close', () => { rpc?.dispose(); observation.dispose() })
        }
        const frame = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))
        frames.push(frame)
        await rpc.receive(frame)
      }).catch(() => socket.close(4002, 'Private RPC frame unavailable'))
    } })
    void channel.catch(() => socket.close())
  })
  const address = relay.address()
  if (!address || typeof address === 'string') throw Error('Private relay did not bind')
  const controller = new AbortController()
  const client = await connectRelayHostedClient({ name: 'Original relay device', signal: controller.signal, keyPair: deviceKey,
    offer: { v: 2, serverId: authority.hostId, daemonPublicKeyB64: exportPublicKey(key.publicKey),
      relay: { endpoint: `127.0.0.1:${address.port}`, useTls: false } } })
  cleanups.push(async () => { await client.dispose(); controller.abort() })
  const credential = await services.secrets.store({ operationId: 'original-fixture-credential', secret: 'Synthetic relay secret' })
  const configure = (suffix: string) => ({ operationId: 'relay-configure-' + suffix, expectedRevision: null,
    connection: { connectionId: 'relay-connection-' + suffix, adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_relay_' + suffix },
      label: 'Original relay ' + suffix, enabled: false, credentialRef: credential.credentialRef } })
  return { ...f, owner, client, frames, authority, deviceKey, deviceCall, credentialStore, services, configure }
}

it('the real relay forwards the destination fence and preserves normal three-argument writes and its authenticated device', async () => {
  const f = await fixture(), input = f.configure('normal')
  // The inbound context belongs to another hop. Hosted must replace its fence,
  // and only E2EE/DeviceAuthority may supply the receiving principal.
  const foreign = { runtimeId: 'outer-runtime', ownerInstanceId: 'outer-owner' }
  await expect(f.client.forwardRpc!('connection.configure', input, { runtimeFence: foreign,
    principal: { kind: 'user', id: 'untrusted-outer-user' } })).resolves.toMatchObject({ connection: { config: input.connection } })
  expect(await f.services.connections.inspect({ operationId: input.operationId })).toMatchObject({ operation: { connection: { config: input.connection } } })
  expect(f.frames.filter(frame => frame.method === 'connection.configure')).toEqual([
    { jsonrpc: '2.0', id: expect.any(String), method: 'connection.configure', params: { ...input,
      runtimeFence: { runtimeId: f.owner.runtimeId, ownerInstanceId: f.owner.ownerInstanceId } } }
  ])
  await expect(f.client.forwardRpc!('connection.configure', { ...input, runtimeFence: foreign } as never, {}))
    .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(f.frames.filter(frame => frame.method === 'connection.configure')).toHaveLength(1)
  const stored = await f.client.forwardRpc!('connection.credential.store', { operationId: 'relay-device-credential', secret: 'Synthetic device secret' }, {})
  expect(await f.services.secrets.inspect('relay-device-credential')).toEqual(stored)
  const device = f.authority.devices()[0]!
  expect(f.authority.devices()).toHaveLength(1)
  expect(f.deviceCall.mock.calls[0]![2].principal).toEqual({ kind: 'device', id: `${f.authority.hostId}:${device.deviceId}` })
  expect(f.credentialStore.mock.calls[0]![1]).toMatchObject({ transport: 'relay', principal: { kind: 'device', id: `${f.authority.hostId}:${device.deviceId}` } })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('an explicit old destination instance cannot become a fence-free configure on the current owner', async () => {
  const f = await fixture(), input = f.configure('stale')
  const error = await f.client.forwardRpc!('connection.configure', input, {},
    { runtimeId: f.owner.runtimeId, ownerInstanceId: 'relay-owner-previous' }).catch(error => error)
  // Assert the actual original database first: dropping the metadata would make
  // this ordinary configure legal and create a foreign operation/configuration.
  const operation = (await f.services.connections.inspect({ operationId: input.operationId })).operation
  const connectionIds = (await f.services.connections.list()).connections.map(record => record.config.connectionId)
  if (witness) appendFileSync(witness, JSON.stringify({ kind: 'stale-destination-database', operationId: input.operationId,
    operationRecorded: operation !== null, connectionIds }) + '\n')
  expect(operation).toBeNull()
  expect(connectionIds).not.toContain(input.connection.connectionId)
  expect(error).toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  const requests = f.frames.filter(frame => frame.method === 'connection.configure')
  expect(requests).toHaveLength(1)
  expect(requests[0]!.params.runtimeFence).toEqual({ runtimeId: f.owner.runtimeId, ownerInstanceId: 'relay-owner-previous' })
  const normal = f.configure('after-refusal')
  await f.client.forwardRpc!('connection.configure', normal, {})
  expect((await f.services.connections.inspect({ operationId: normal.operationId })).operation).not.toBeNull()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('cancels only the original relay reader through the forwarded signal without replaying its request', async () => {
  const f = await fixture(), controller = new AbortController()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), paused = new Promise<void>(resolve => { release = resolve })
  const original = f.services.connections.inspect.bind(f.services.connections)
  vi.spyOn(f.services.connections, 'inspect').mockImplementationOnce(async input => { entered(); await paused; return original(input) })
  const outcome: { error?: unknown } = {}
  const read = f.client.forwardRpc!('connection.inspect', { operationId: 'cancelled-observation' }, { signal: controller.signal })
    .catch(error => { outcome.error = error })
  await started
  try {
    controller.abort()
    await vi.waitFor(() => expect(outcome.error).toMatchObject({ code: 'CONTROL_CANCELLED' }))
  } finally { release(); await read }
  expect(f.frames.filter(frame => frame.method === 'connection.inspect')).toHaveLength(1)
  const input = f.configure('after-cancel')
  await f.client.forwardRpc!('connection.configure', input, {})
  expect((await f.services.connections.inspect({ operationId: input.operationId })).operation).not.toBeNull()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
