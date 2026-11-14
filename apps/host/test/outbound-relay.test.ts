import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { startRelayGateway, hashPublisherToken } from '@agentmux/relay/gateway'
import { exportPublicKey, generateKeyPair } from '@agentmux/relay/e2ee'
import { parseConnectionOfferUrl } from '@agentmux/relay/offer'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { loadOrCreateRelayKeyPair } from '../../../packages/core/src/rpc-relay-keypair.js'
import { actualRelayOwner, held } from '../../../packages/core/test/helpers/relay-carrier-owner.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'

import { createOutboundRelayAccess } from '../src/outbound-relay.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const exec = promisify(execFile)
async function port() {
  const server = createServer(); await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Private port missing')
  await new Promise<void>(yes => server.close(() => yes())); return address.port
}

it('the actual Host publishes outbound, returns its exact gateway link and admits only pinned encrypted device keys', async () => {
  const relayPort = await port(), keyPair = generateKeyPair(), token = 'private-original-publisher-token'
  const f = await actualRelayOwner({ outboundRelay: { relay: { endpoint: `127.0.0.1:${relayPort}`, useTls: false }, publisherToken: token, allowedClientKeys: [exportPublicKey(keyPair.publicKey)] } })
  const gateway = await startRelayGateway({ host: '127.0.0.1', port: relayPort, publishers: [{ serverId: f.authority.hostId, tokenHash: hashPublisherToken(token) }] })
  cleanup.push(() => gateway.stop())
  const pending = f.local.call('device.link', { via: 'gateway' })
  await expect(pending).resolves.toMatchObject({ via: 'gateway', hostId: f.authority.hostId, candidates: [] })
  await expect.poll(async () => (await f.local.call('device.link', { via: 'gateway' })).mobileAccess.state, { timeout: 10000 }).toBe('connected')
  const link = await pending, offer = parseConnectionOfferUrl(link.url)!
  expect(offer).toMatchObject({ serverId: f.authority.hostId, relay: { endpoint: `127.0.0.1:${relayPort}`, useTls: false } })
  const local = await f.local.call('device.link', {})
  expect(local).not.toHaveProperty('via'); expect(local.relay.endpoint).not.toBe(offer.relay.endpoint)
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer }, relayKeyPair: keyPair }); cleanup.push(() => rpc.dispose())
  const pendingHello = rpc.call('device.hello', { name: 'Original permitted client' })
  await expect(pendingHello).resolves.toMatchObject({ hostId: f.authority.hostId, device: { name: 'Original permitted client' } })
  const hello = await pendingHello
  const before = f.authority.devices().map(device => device.deviceId)
  const stranger = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer }, relayKeyPair: generateKeyPair() }); cleanup.push(() => stranger.dispose())
  await expect(stranger.call('device.hello', { name: 'Unapproved client' })).rejects.toThrow()
  expect(f.authority.devices().map(device => device.deviceId)).toEqual(before)
  expect(f.requests.filter(request => request.frame.method === 'device.hello')).toHaveLength(1)
  await f.authority.revoke(hello.device.deviceId)
  await expect(rpc.call('device.hello', { name: 'Revoked original' })).rejects.toThrow()
  expect((await f.local.call('device.ls', {})).devices.find(device => device.deviceId === hello.device.deviceId)?.revokedAt).toBeDefined()
})

it('actual CLI retrieves the gateway link and reuses its original relay-key identity without printing private key material', async () => {
  const relayPort = await port(), token = 'private-cli-publisher-token'
  const f = await actualRelayOwner({ outboundRelay: { relay: { endpoint: `127.0.0.1:${relayPort}`, useTls: false }, publisherToken: token, allowedClientKeys: [] } })
  const gateway = await startRelayGateway({ host: '127.0.0.1', port: relayPort, publishers: [{ serverId: f.authority.hostId, tokenHash: hashPublisherToken(token) }] }); cleanup.push(() => gateway.stop())
  const env = objectCliEnvironment(f.root)
  const cli = resolve('packages/core/bin/amux'), endpoint = `unix:${join(f.root, 'host.sock')}`
  const result = await exec(process.execPath, [cli, '--endpoint', endpoint, 'device', 'link', '--via', 'gateway'], { env })
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { via: 'gateway', hostId: f.authority.hostId } })
  const keyPath = join(f.root, 'isolated-client', 'key.json'); await mkdir(join(f.root, 'isolated-client'))
  const args = [resolve('packages/core/dist/headless-runtime-cli.js'), 'relay-key', '--file', keyPath]
  const first = JSON.parse((await exec(process.execPath, args, { env })).stdout)
  expect(first).toEqual(JSON.parse((await exec(process.execPath, args, { env })).stdout))
  expect(first.publicKeyB64).toBe(exportPublicKey((await loadOrCreateRelayKeyPair(keyPath)).publicKey))
  expect(first).not.toHaveProperty('secretKeyB64')
  const stored = JSON.parse(await readFile(keyPath, 'utf8'))
  expect(JSON.stringify(first)).not.toContain(stored.secretKeyB64)
  const damaged = 'PRIVATE_RELAY_KEY_MUST_NOT_ENTER_ERROR_OUTPUT'
  await writeFile(keyPath, damaged)
  const failure = await exec(process.execPath, args, { env }).then(() => { throw new Error('Damaged original identity must be refused') }, error => error)
  expect(failure.stderr).toContain('CONTROL_UNAVAILABLE'); expect(failure.stderr).not.toContain(damaged)
  expect(await readFile(keyPath, 'utf8')).toBe(damaged)
  await expect(exec(process.execPath, [cli, '--endpoint', endpoint, 'device', 'link', '--via', 'gateway', '--address', '127.0.0.1'], { env })).rejects.toThrow()
})

it('an invalid optional outbound configuration leaves the original Host and local carrier usable', async () => {
  const f = await actualRelayOwner({ outboundRelay: { relay: { endpoint: 'invalid.example:8444', useTls: false }, publisherToken: 'original-private-token', allowedClientKeys: [] } })
  await expect(f.local.call('device.link', { via: 'gateway' })).rejects.toMatchObject({ code: 'RELAY_CONFIGURATION_UNAVAILABLE' })
  await expect(f.local.call('device.link', {})).resolves.toMatchObject({ hostId: f.authority.hostId })
  expect(f.host.client.agentSession('caller').run).toEqual({ runId: 'run-caller' })
  expect((await f.local.call('agent.ls', {})).sessions.map(session => session.session.agentSessionId)).toContain('caller')
})


it.each(['configuration', 'authority', 'key'] as const)('closing while optional %s is pending settles promptly and never starts late work', async phase => {
  const f = await actualRelayOwner()
  const key = generateKeyPair(), authorityReady = held<typeof f.authority>(), keyReady = held<typeof key>()
  const enteredAuthority = held(), enteredKey = held()
  const configurationPath = join(f.root, 'close-race.json')
  const contents = JSON.stringify({ relay: { endpoint: '127.0.0.1:1', useTls: false }, publisherToken: 'private-close-race', allowedClientKeys: [] })
  await writeFile(configurationPath, contents, { mode: 0o600 })
  const authority = vi.fn(async () => { enteredAuthority.resolve(); return authorityReady.promise })
  const keyPair = vi.fn(async () => { enteredKey.resolve(); return keyReady.promise })
  const access = createOutboundRelayAccess({ configurationPath, authority, keyPair })
  cleanup.push(() => access.close())
  const openAuthenticatedFrames = vi.fn(() => { throw Error('Stopped initialization must not attach RPC') })
  const started = access.start({ openAuthenticatedFrames })
  if (phase !== 'configuration') await enteredAuthority.promise
  if (phase === 'key') { authorityReady.resolve(f.authority); await enteredKey.promise }
  // Both close and pending link must settle before the blocked original owner is released.
  const link = access.link()
  let timer: ReturnType<typeof setTimeout> | undefined
  const closedPromptly = await Promise.race([access.close().then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 250) })])
  clearTimeout(timer)
  if (!closedPromptly) { authorityReady.resolve(f.authority); keyReady.resolve(key) }
  expect(closedPromptly).toBe(true)
  await expect(started).resolves.toBeUndefined()
  await expect(link).rejects.toMatchObject({ code: 'RELAY_STOPPED' })
  if (phase !== 'key') expect(keyPair).not.toHaveBeenCalled()
  if (phase === 'configuration') expect(authority).not.toHaveBeenCalled()
  authorityReady.resolve(f.authority); keyReady.resolve(key)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(keyPair).toHaveBeenCalledTimes(phase === 'key' ? 1 : 0)
  expect(access.accessState()).toMatchObject({ state: 'unavailable', message: expect.stringContaining('已停止') })
  expect(openAuthenticatedFrames).not.toHaveBeenCalled()
  expect(await readFile(configurationPath, 'utf8')).toBe(contents)
  await expect(f.local.call('agent.ls', {})).resolves.toMatchObject({ sessions: expect.any(Array) })
})
