const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createClientChannel, exportPublicKey, generateKeyPair, type KeyPair, type Transport } from '../../../packages/relay/dist/e2ee.js'
import { parseConnectionOfferUrl } from '../../../packages/relay/dist/connection-offer.js'
import { buildRelayWebSocketUrl } from '../../../packages/relay/dist/daemon-endpoints.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { parseAgentMuxRpcDeviceParams, parseAgentMuxRpcDeviceResult, parseDeviceConnection } from '../../../packages/core/src/public-rpc-device.js'

const storage = vi.hoisted(() => ({ fail: false, afterReplace: false, hideAfterReplace: false, replaceRetained: false,
  hold: null as Promise<void> | null, writes: 0, active: 0, peak: 0 }))
vi.mock('@agentmux/core', async original => {
  const actual = await original<typeof import('@agentmux/core')>()
  return { ...actual,
    // Only unrelated Native startup is isolated. Production Host assembly, socket
    // upgrade, E2EE, original Authority, service, typed SDK and compiled CLI are real.
    startHeadlessAgentMux: async (options: Parameters<typeof actual.startHeadlessAgentMux>[0]) => {
      const server = new actual.AgentMuxControlServer({ ...options?.service, coreClients: () => [], socketPath: options?.socketPath })
      await server.start()
      return { client: {}, hosted: {}, server, stop: () => server.stop() }
    },
    durableWriteFile: async (...args: Parameters<typeof actual.durableWriteFile>) => {
      if (!args[0].endsWith('devices.json')) return actual.durableWriteFile(...args)
      expect(args[2]?.requireDirectorySync).toBe(true)
      storage.writes++; storage.active++; storage.peak = Math.max(storage.peak, storage.active)
      try {
        if (storage.hold) await storage.hold
        if (storage.fail) throw Object.assign(new Error('Controlled metadata storage failure'), { code: 'EIO' })
        const result = await actual.durableWriteFile(...args)
        if (storage.afterReplace) {
          storage.afterReplace = false
          if (storage.hideAfterReplace) await rename(args[0], args[0] + '.kept')
          if (storage.replaceRetained) {
            const replaced = JSON.parse(await readFile(args[0], 'utf8'))
            replaced.devices[0].credentialHash = 'f'.repeat(64)
            await writeFile(args[0], JSON.stringify(replaced) + '\n')
          }
          throw Object.assign(new Error('Durable write ACK lost after actual replacement'), { code: 'EIO', phase: 'after-replace' })
        }
        return result
      } finally { storage.active-- }
    }
  }
})
import { AgentMuxFileAgentSessionStore, connectAgentMuxRpc } from '@agentmux/core'
import { DeviceAuthority } from '../../../apps/host/src/device-authority.js'
import { startAgentMuxHost } from '../../../apps/host/src/host.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  storage.fail = false; storage.hold = null; storage.afterReplace = false; storage.hideAfterReplace = false; storage.replaceRetained = false
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  storage.writes = 0; storage.active = 0; storage.peak = 0
})
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'amx-device-id-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return root
}
async function ownerFixture() {
  const root = await directory(), path = join(root, 'devices.json')
  let clock = _reshape_fixtureEpoch(0, 0, 10)
  const owner = await DeviceAuthority.open(path, () => clock)
  cleanup.push(() => owner.flush())
  const key = exportPublicKey(generateKeyPair().publicKey), device = await owner.authorizeKey(key)
  return { root, path, owner, key, device, clock: (value: number) => { clock = value } }
}
async function hostFixture(legacyKey?: KeyPair) {
  const root = await directory(), assets = join(root, 'mobile')
  await mkdir(join(assets, 'assets'), { recursive: true }); await writeFile(join(assets, 'index.html'), '<!doctype html><title>Private phone fixture</title>')
  if (legacyKey) await writeFile(join(root, 'agentmux-devices.json'), JSON.stringify({ schema: 'agentmux.device-authority.v1', hostId: 'legacy-original-host',
    devices: [{ deviceId: 'legacy-kept-device', name: 'Original phone', createdAt: _reshape_fixtureEpoch(0, 0, 1),
      credentialHash: createHash('sha256').update(exportPublicKey(legacyKey.publicKey)).digest('hex') }] }) + '\n')
  const socketPath = join(root, 'control.sock')
  const host = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')),
    socketPath, mobileBuildDirectory: assets, mobilePort: 0 })
  cleanup.push(() => host.dispose())
  const local = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  cleanup.push(() => local.dispose())
  await vi.waitFor(async () => expect((await local.call('device.ls', {})).mobileAccess.state).toBe('connected'))
  const link = await local.call('device.link', {}), original = parseConnectionOfferUrl(link.url)!
  const offer = original
  return { root, host, local, offer, socketPath, cli: (args: string[]) => runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, ...args], objectCliEnvironment(root)) }
}
async function phone(f: Awaited<ReturnType<typeof hostFixture>>, key: KeyPair, userAgent: string) {
  const socket = new WebSocket(buildRelayWebSocketUrl({ endpoint: f.offer.relay.endpoint, serverId: f.offer.serverId, useTls: false, role: 'client' }),
    { headers: { 'User-Agent': userAgent, 'X-Forwarded-For': '203.0.113.99' } })
  let address: string | undefined
  socket.once('upgrade', response => { address = response.socket.localAddress?.replace(/^::ffff:/u, '') })
  await new Promise<void>((yes, no) => { socket.once('open', yes); socket.once('error', no) })
  const port: Transport = { send: value => { socket.send(value) }, close: (code, reason) => socket.close(code === 1000 || code && code >= 3000 ? code : 4001, reason), onmessage: null, onclose: null, onerror: null }
  socket.on('message', (data, binary) => port.onmessage?.({ data: binary ? Uint8Array.from(data as Buffer).buffer : data.toString(), isBinary: binary }))
  socket.on('close', (code, reason) => port.onclose?.(code, reason.toString()))
  socket.on('error', error => port.onerror?.(error))
  let ready!: () => void
  const opened = new Promise<void>(yes => { ready = yes })
  const replies = new Map<string, (frame: any) => void>(), seen: any[] = []
  const channel = await createClientChannel(port, f.offer.daemonPublicKeyB64, { onopen: ready,
    onmessage: data => { const frame = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); seen.push(frame); replies.get(String(frame.id))?.(frame) } }, key)
  await opened
  let sequence = 0, closed = false
  const close = async () => {
    if (closed) return; closed = true
    const ended = new Promise<void>(yes => socket.once('close', () => yes()))
    channel.close(); await ended
  }
  cleanup.push(close)
  const call = async (method: string, params: unknown) => {
    const id = String(++sequence)
    const answer = new Promise<any>(yes => replies.set(id, yes))
    await channel.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    const frame = await answer; replies.delete(id); return frame
  }
  return { call, close, seen, address }
}

it('strict device results preserve fingerprints, IP, source time and latest lifecycle through all original methods', () => {
  const device = { deviceId: 'original-device', name: 'Phone', createdAt: _reshape_fixtureEpoch(0, 0, 1), keyFingerprint: 'sha256:' + 'a'.repeat(64),
    connection: { connectedAt: _reshape_fixtureEpoch(0, 0, 2), observedAt: _reshape_fixtureEpoch(0, 0, 3), disconnectedAt: _reshape_fixtureEpoch(0, 0, 4), address: '2001:db8::7', userAgent: 'Declared browser' }, connectionIssue: 'Disk ACK unconfirmed' }
  expect(parseAgentMuxRpcDeviceResult('device.ls', { hostId: 'original-host', devices: [device], mobileAccess: { state: 'connected', message: 'Ready' } }, {}).devices).toEqual([device])
  expect(parseAgentMuxRpcDeviceResult('device.hello', { hostId: 'original-host', device }, { name: 'Phone' }).device).toEqual(device)
  expect(parseAgentMuxRpcDeviceResult('device.revoke', { hostId: 'original-host', device: { ...device, revokedAt: _reshape_fixtureEpoch(0, 0, 5) } }, { deviceId: device.deviceId }).device.connection).toEqual(device.connection)
  expect(parseDeviceConnection({ connectedAt: _reshape_fixtureEpoch(0, 0, 2), userAgent: 'Declared browser '.repeat(100) }).userAgent).toBe('Declared browser '.repeat(100))
  for (const connection of [{ connectedAt: _reshape_fixtureEpoch(0, 0, -1) }, { connectedAt: _reshape_fixtureEpoch(0, 0, 2), disconnectedAt: _reshape_fixtureEpoch(0, 0, 1) }, { connectedAt: _reshape_fixtureEpoch(0, 0, 2), observedAt: _reshape_fixtureEpoch(0, 0, 1) }, { connectedAt: _reshape_fixtureEpoch(0, 0, 2), address: 'bad\naddress' }, { connectedAt: _reshape_fixtureEpoch(0, 0, 2), userAgent: 'bad\nagent' }, { connectedAt: _reshape_fixtureEpoch(0, 0, 2), credential: 'secret' }]) {
    expect(() => parseDeviceConnection(connection)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  }
  expect(() => parseAgentMuxRpcDeviceResult('device.hello', { hostId: 'original-host', device: { ...device, keyFingerprint: 'secret' } }, { name: 'Phone' })).toThrow()
  expect(() => parseAgentMuxRpcDeviceParams('device.hello', { name: 'Phone', address: '203.0.113.99' })).toThrow()
})

it('same-schema legacy secret hashes remain unknown and opening preserves original identity bytes', async () => {
  const root = await directory(), path = join(root, 'devices.json')
  const legacy = JSON.stringify({ schema: 'agentmux.device-authority.v1', hostId: 'original-host', devices: [{ deviceId: 'original-secret-device', name: 'Old phone', createdAt: _reshape_fixtureEpoch(0, 0, 1),
    credentialHash: createHash('sha256').update('legacy bearer secret').digest('hex'), operations: [{ id: 'kept', method: 'agent.send', target: 'SID', at: _reshape_fixtureEpoch(0, 0, 2), result: 'confirmed' }] }] }) + '\n'
  await writeFile(path, legacy)
  const owner = await DeviceAuthority.open(path)
  expect(owner.devices()[0]).toMatchObject({ deviceId: 'original-secret-device', createdAt: _reshape_fixtureEpoch(0, 0, 1), operations: [{ id: 'kept' }] })
  expect(owner.devices()[0]?.keyFingerprint).toBeUndefined(); expect(await readFile(path, 'utf8')).toBe(legacy)
})

it('current key confirmation persists legacy provenance without replacing its identity', async () => {
  const root = await directory(), path = join(root, 'devices.json'), key = exportPublicKey(generateKeyPair().publicKey)
  const hash = createHash('sha256').update(key).digest('hex')
  await writeFile(path, JSON.stringify({ schema: 'agentmux.device-authority.v1', hostId: 'original-host', devices: [{ deviceId: 'kept-device', name: 'Old phone', createdAt: _reshape_fixtureEpoch(0, 0, 1), credentialHash: hash }] }))
  const owner = await DeviceAuthority.open(path)
  expect(owner.devices()[0]?.keyFingerprint).toBeUndefined()
  expect(await owner.authorizeKey(key)).toMatchObject({ deviceId: 'kept-device', createdAt: _reshape_fixtureEpoch(0, 0, 1), keyFingerprint: `sha256:${hash}` })
  await owner.flush()
  const reopened = await DeviceAuthority.open(path)
  expect(reopened.devices()[0]).toMatchObject({ deviceId: 'kept-device', createdAt: _reshape_fixtureEpoch(0, 0, 1), keyFingerprint: `sha256:${hash}` })
})

it('multiple authenticated readers keep one interval and latest source; old/repeated disposal cannot disconnect a new reader', async () => {
  const f = await ownerFixture()
  f.clock(20); const first = f.owner.observe(f.device, { address: '192.0.2.5', userAgent: 'First client' })
  f.clock(30); const second = f.owner.observe(f.device, { address: '2001:db8::7', userAgent: 'Latest client' })
  first.dispose(); first.dispose()
  expect(f.owner.devices()[0]).toMatchObject({ online: true, connection: { connectedAt: _reshape_fixtureEpoch(0, 0, 20), observedAt: _reshape_fixtureEpoch(0, 0, 30), address: '2001:db8::7' } })
  expect(f.owner.devices()[0]?.connection?.disconnectedAt).toBeUndefined()
  f.clock(40); second.dispose(); await f.owner.flush()
  expect(f.owner.devices()[0]).toMatchObject({ online: false, connection: { connectedAt: _reshape_fixtureEpoch(0, 0, 20), observedAt: _reshape_fixtureEpoch(0, 0, 30), disconnectedAt: _reshape_fixtureEpoch(0, 0, 40), address: '2001:db8::7' } })
  f.clock(50); const next = f.owner.observe(f.device, { address: '192.0.2.9' }); second.dispose()
  expect(f.owner.devices()[0]).toMatchObject({ online: true, connection: { connectedAt: _reshape_fixtureEpoch(0, 0, 50), observedAt: _reshape_fixtureEpoch(0, 0, 50), address: '192.0.2.9' } })
  expect(f.owner.devices()[0]?.connection?.disconnectedAt).toBeUndefined(); expect(f.owner.devices()[0]?.connection?.userAgent).toBeUndefined()
  next.dispose(); await f.owner.flush()
  expect((await DeviceAuthority.open(f.path)).devices()[0]?.connection).toEqual(f.owner.devices()[0]?.connection)
})

it('malformed optional connection metadata does not invalidate original authorization or overwrite the file on open', async () => {
  const f = await ownerFixture(), raw = JSON.parse(await readFile(f.path, 'utf8'))
  raw.devices[0].connection = { connectedAt: 'broken', address: 'original bytes retained' }
  const bytes = JSON.stringify(raw) + '\n'; await writeFile(f.path, bytes)
  const owner = await DeviceAuthority.open(f.path)
  expect(owner.devices()[0]?.connection).toBeUndefined(); expect(owner.devices()[0]?.connectionIssue).toBeTruthy()
  expect(await readFile(f.path, 'utf8')).toBe(bytes)
  const device = await owner.authorizeKey(f.key), reader = owner.observe(device, { address: '192.0.2.6' })
  expect(reader.signal.aborted).toBe(false); await owner.flush(); expect(owner.devices()[0]?.connectionIssue).toBeUndefined()
  reader.dispose(); await owner.flush()
})

it('metadata write failure keeps healthy readers and known facts; a later confirmed owner write clears only its service issue', async () => {
  const f = await ownerFixture()
  storage.fail = true
  const reader = f.owner.observe(f.device, { address: '192.0.2.7' }); await f.owner.flush()
  expect(reader.signal.aborted).toBe(false)
  expect(f.owner.devices()[0]).toMatchObject({ online: true, connection: { address: '192.0.2.7' }, connectionIssue: expect.any(String) })
  storage.fail = false
  await f.owner.hello(f.device.deviceId, 'Renamed phone')
  expect(f.owner.devices()[0]?.connectionIssue).toBeUndefined()
  expect((await DeviceAuthority.open(f.path)).devices()[0]).toMatchObject({ deviceId: f.device.deviceId, name: 'Renamed phone', connection: { address: '192.0.2.7' } })
  reader.dispose(); await f.owner.flush()
})

it('unconfirmed legacy key-source bookkeeping preserves authorization while new-device admission still requires a durable write', async () => {
  const root = await directory(), path = join(root, 'devices.json'), key = exportPublicKey(generateKeyPair().publicKey)
  const bytes = JSON.stringify({ schema: 'agentmux.device-authority.v1', hostId: 'original-host', devices: [{ deviceId: 'retained-device', name: 'Retained phone', createdAt: _reshape_fixtureEpoch(0, 0, 1),
    credentialHash: createHash('sha256').update(key).digest('hex') }] }) + '\n'
  await writeFile(path, bytes)
  const owner = await DeviceAuthority.open(path)
  storage.fail = true
  const device = await owner.authorizeKey(key), reader = owner.observe(device)
  await owner.flush()
  expect(device.deviceId).toBe('retained-device'); expect(reader.signal.aborted).toBe(false)
  expect(owner.devices()[0]?.keyFingerprint).toBeTruthy(); expect(owner.devices()[0]?.connectionIssue).toBeTruthy()
  expect(await readFile(path, 'utf8')).toBe(bytes)
  await expect(owner.authorizeKey(exportPublicKey(generateKeyPair().publicKey))).rejects.toMatchObject({ code: 'EIO' })
  expect(owner.devices()).toHaveLength(1); expect(reader.signal.aborted).toBe(false)
  const writes = storage.writes; await owner.flush(); expect(storage.writes).toBe(writes)
  storage.fail = false; await owner.hello(device.deviceId, 'Retained phone')
  expect(owner.devices()[0]?.connectionIssue).toBeUndefined(); reader.dispose(); await owner.flush()
})

it('burst observation work stays bounded and shares serialization with strong authorization and revoke writes', async () => {
  const f = await ownerFixture(), baseline = storage.writes
  let release!: () => void
  storage.hold = new Promise<void>(yes => { release = yes })
  let last = f.owner.observe(f.device, { address: '192.0.2.1' })
  await vi.waitFor(() => expect(storage.active).toBe(1))
  for (let index = 0; index < 20; index++) {
    last.dispose(); f.clock(20 + index); last = f.owner.observe(f.device, { address: `192.0.2.${index % 200 + 1}` })
  }
  const diagnostics = f.owner as unknown as { pendingObservations: Map<string, unknown> }
  expect(diagnostics.pendingObservations.size).toBe(1)
  expect(f.owner.devices()[0]?.connection?.address).toBe('192.0.2.20')
  const other = f.owner.authorizeKey(exportPublicKey(generateKeyPair().publicKey))
  const revoked = f.owner.revoke(f.device.deviceId)
  release(); storage.hold = null
  expect((await other).deviceId).not.toBe(f.device.deviceId); await revoked
  expect(last.signal.aborted).toBe(true)
  last.dispose(); await f.owner.flush()
  expect(storage.peak).toBe(1); expect(storage.writes - baseline).toBeLessThanOrEqual(5)
  const records = (await DeviceAuthority.open(f.path)).devices()
  expect(records).toHaveLength(2); expect(records.find(device => device.deviceId === f.device.deviceId)?.revokedAt).toBeDefined()
  expect(records.find(device => device.deviceId === f.device.deviceId)?.connection?.address).toBe('192.0.2.20')
})

it('metadata cannot erase an original new-device write that reached disk but lost its ACK', async () => {
  const f = await ownerFixture(), key = exportPublicKey(generateKeyPair().publicKey)
  storage.afterReplace = true
  await expect(f.owner.authorizeKey(key)).rejects.toMatchObject({ code: 'EIO', phase: 'after-replace' })
  const unknown = JSON.parse(await readFile(f.path, 'utf8'))
  expect(unknown.devices).toHaveLength(2)
  const reader = f.owner.observe(f.device, { address: '192.0.2.8' }); reader.dispose(); await f.owner.flush()
  const persisted = JSON.parse(await readFile(f.path, 'utf8'))
  expect(persisted.hostId).toBe(unknown.hostId)
  expect(persisted.devices.map((device: any) => [device.deviceId, device.credentialHash, device.createdAt])).toEqual(unknown.devices.map((device: any) => [device.deviceId, device.credentialHash, device.createdAt]))
  expect((await DeviceAuthority.open(f.path)).devices()).toHaveLength(2)
})

it('only original on-disk revokedAt ends its exact readers after a lost write ACK, and metadata never resurrects it', async () => {
  const f = await ownerFixture(), other = await f.owner.authorizeKey(exportPublicKey(generateKeyPair().publicKey))
  const revokedReader = f.owner.observe(f.device), healthyReader = f.owner.observe(other)
  await f.owner.flush(); storage.afterReplace = true
  await expect(f.owner.revoke(f.device.deviceId)).rejects.toMatchObject({ code: 'EIO', phase: 'after-replace' })
  expect(revokedReader.signal.aborted).toBe(true); expect(healthyReader.signal.aborted).toBe(false)
  revokedReader.dispose(); healthyReader.dispose(); await f.owner.flush()
  const reopened = await DeviceAuthority.open(f.path)
  expect(reopened.devices().find(device => device.deviceId === f.device.deviceId)?.revokedAt).toBeDefined()
  await expect(reopened.authorizeKey(f.key)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
})

it('unknown unreadable original storage pauses only metadata writes, retains live facts, and recovers by reading that same file', async () => {
  const f = await ownerFixture(), key = exportPublicKey(generateKeyPair().publicKey)
  storage.afterReplace = true; storage.hideAfterReplace = true
  await expect(f.owner.authorizeKey(key)).rejects.toMatchObject({ code: 'EIO', phase: 'after-replace' })
  const reader = f.owner.observe(f.device, { address: '192.0.2.9' }); await f.owner.flush()
  expect(reader.signal.aborted).toBe(false)
  expect(f.owner.devices()[0]).toMatchObject({ online: true, connection: { address: '192.0.2.9' }, connectionIssue: expect.any(String) })
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const writes = storage.writes; await f.owner.flush(); expect(storage.writes).toBe(writes)
  const original = JSON.parse(await readFile(f.path + '.kept', 'utf8'))
  await rename(f.path + '.kept', f.path)
  await f.owner.hello(f.device.deviceId, 'Original phone')
  expect(f.owner.devices()[0]?.connectionIssue).toBeUndefined(); expect(f.owner.devices()).toHaveLength(2)
  reader.dispose(); await f.owner.flush()
  const restored = JSON.parse(await readFile(f.path, 'utf8'))
  expect(restored.devices.map((device: any) => device.deviceId)).toEqual(original.devices.map((device: any) => device.deviceId))
})

it('a same-Host file with a replaced retained credential stays unknown and cannot be overwritten by metadata', async () => {
  const f = await ownerFixture(), original = await readFile(f.path, 'utf8')
  const reader = f.owner.observe(f.device)
  await f.owner.flush()
  storage.afterReplace = true; storage.replaceRetained = true
  await expect(f.owner.authorizeKey(exportPublicKey(generateKeyPair().publicKey))).rejects.toMatchObject({ code: 'EIO' })
  const replaced = await readFile(f.path, 'utf8')
  const otherReader = f.owner.observe(f.device, { address: '192.0.2.10' }); await f.owner.flush()
  expect(reader.signal.aborted).toBe(false); expect(otherReader.signal.aborted).toBe(false)
  expect(f.owner.devices()[0]?.keyFingerprint).toBe(f.device.keyFingerprint)
  expect(f.owner.devices()[0]?.connectionIssue).toBeTruthy()
  expect(await readFile(f.path, 'utf8')).toBe(replaced)
  const writes = storage.writes; await f.owner.flush(); expect(storage.writes).toBe(writes)
  await writeFile(f.path, original)
  await f.owner.hello(f.device.deviceId, 'Original phone')
  reader.dispose(); otherReader.dispose(); await f.owner.flush()
})

it('production Host joins encrypted peer identity to its exact client socket, then RPC and actual CLI retain the same facts', async () => {
  const key = generateKeyPair(), f = await hostFixture(key)
  expect((await f.local.call('device.ls', {})).devices[0]?.keyFingerprint).toBeUndefined()
  const first = await phone(f, key, 'Declared phone browser A')
  const hello = await first.call('device.hello', { name: 'Same phone name' })
  expect(hello.error).toBeUndefined()
  const result = parseAgentMuxRpcDeviceResult('device.hello', hello.result, { name: 'Same phone name' })
  const expectedFingerprint = `sha256:${createHash('sha256').update(exportPublicKey(key.publicKey)).digest('hex')}`
  expect(result.device.keyFingerprint).toBe(expectedFingerprint)
  expect(result.device).toMatchObject({ deviceId: 'legacy-kept-device', createdAt: _reshape_fixtureEpoch(0, 0, 1) })
  const longUserAgent = 'Declared phone browser B '.repeat(40).trim()
  const second = await phone(f, key, longUserAgent)
  expect((await second.call('device.hello', { name: 'Same phone name' })).result.device.deviceId).toBe(result.device.deviceId)
  const facts = await f.local.call('device.ls', {})
  expect(facts.devices).toHaveLength(1)
  expect(facts.devices[0]).toMatchObject({ deviceId: result.device.deviceId, online: true, keyFingerprint: expectedFingerprint,
    connection: { address: second.address, userAgent: longUserAgent, observedAt: expect.any(Number) } })
  expect(second.address).toBeTruthy(); expect(second.address).not.toBe('127.0.0.1')
  expect(facts.devices[0]?.connection?.address).not.toBe('203.0.113.99')
  expect((await second.call('device.hello', { name: 'Impostor', address: '203.0.113.99' })).error.data.code).toBe('INVALID_CONTROL_REQUEST')
  expect((await second.call('device.ls', {})).error.data.code).toBe('CONTROL_PERMISSION_DENIED')
  expect((await second.call('device.hello', { name: 'Same phone name' })).error).toBeUndefined()
  await first.close()
  const current = await f.local.call('device.ls', {})
  expect(current.devices[0]?.online).toBe(true)
  const cli = await f.cli(['device', 'ls']); expect(cli.code, cli.stderr).toBe(0)
  const publicFacts = JSON.parse(cli.stdout).result
  expect(publicFacts.devices[0]).toEqual(current.devices[0]!)
  const serialized = JSON.stringify(publicFacts)
  expect(serialized).not.toContain('credentialHash'); expect(serialized).not.toContain(exportPublicKey(key.publicKey))
  await second.close()
  await vi.waitFor(async () => expect((await f.local.call('device.ls', {})).devices[0]?.online).toBe(false))
  const authority = await f.host.deviceAuthority(); await authority.flush()
  const after = await f.local.call('device.ls', {})
  expect(after.devices[0]?.connection?.disconnectedAt).toBeGreaterThanOrEqual(after.devices[0]?.connection?.observedAt ?? 0)
  const reopened = await DeviceAuthority.open(join(f.root, 'agentmux-devices.json'))
  expect(reopened.hostId).toBe(facts.hostId); expect(reopened.devices()[0]?.connection).toEqual(after.devices[0]?.connection)
  if (process.env.DEVICE_EVIDENCE_DIRECTORY) {
    await writeFile(join(process.env.DEVICE_EVIDENCE_DIRECTORY, 'host-consumer.json'), JSON.stringify({ nativeSeam: 'Only unrelated Native startup isolated',
      hostId: facts.hostId, deviceId: result.device.deviceId, online: facts, cli: publicFacts, disconnected: after, preservedHostId: reopened.hostId,
      actualEncryptedFrames: first.seen.length + second.seen.length }) + '\n')
  }
})

it('a metadata storage failure keeps the original encrypted channel usable and exposes recovery through local RPC', async () => {
  const f = await hostFixture(), key = generateKeyPair(), first = await phone(f, key, 'Initial browser')
  const admitted = await first.call('device.hello', { name: 'Retained phone' })
  const owner = await f.host.deviceAuthority(); await owner.flush()
  storage.fail = true
  const next = await phone(f, key, 'Updated browser')
  // The first successfully decrypted frame proves possession and admits the peer.
  expect((await next.call('device.ls', {})).error.data.code).toBe('CONTROL_PERMISSION_DENIED')
  await vi.waitFor(async () => {
    await owner.flush()
    expect((await f.local.call('device.ls', {})).devices[0]).toMatchObject({ deviceId: admitted.result.device.deviceId,
      online: true, connection: { userAgent: 'Updated browser' }, connectionIssue: expect.any(String) })
  })
  storage.fail = false
  expect((await next.call('device.hello', { name: 'Recovered phone' })).result.device.deviceId).toBe(admitted.result.device.deviceId)
  expect((await f.local.call('device.ls', {})).devices[0]?.connectionIssue).toBeUndefined()
  await first.close(); await next.close()
})

it('actual phone query consumes the original CLI and omits a disconnected device even when its name matches the connected one', async () => {
  const f = await hostFixture(), connected = await phone(f, generateKeyPair(), 'Connected declared browser'), disconnected = await phone(f, generateKeyPair(), 'Disconnected declared browser')
  await connected.call('device.hello', { name: 'Identical names' }); await disconnected.call('device.hello', { name: 'Identical names' }); await disconnected.close()
  await vi.waitFor(async () => expect((await f.local.call('device.ls', {})).devices.filter(device => device.online === true)).toHaveLength(1))
  const originalPath = resolve('apps/desktop/resources/toolkit/mobile-connection/query.mjs')
  const path = process.env.DEVICE_TOOLKIT_SCRIPT ?? originalPath, script = await readFile(path, 'utf8')
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script, resolve('packages/core/bin/amux'), `unix:${f.socketPath}`, 'status'],
    { env: objectCliEnvironment(f.root), maxBuffer: 1024 * 1024 })
  const document = JSON.parse(stdout)
  expect(document.summary).toBe('1 connected'); expect(document.items).toEqual([{ label: 'Identical names', value: `Connected · ${connected.address}` }])
  if (process.env.DEVICE_EVIDENCE_DIRECTORY) await writeFile(join(process.env.DEVICE_EVIDENCE_DIRECTORY, 'toolkit-consumer.json'), JSON.stringify({ source: path,
    sourceSha256: createHash('sha256').update(script).digest('hex'), document, originalHostFacts: await f.local.call('device.ls', {}) }) + '\n')
})

it('the actual CLI help and skill discover recorded identification and keep the existing management commands', async () => {
  const root = await directory()
  for (const args of [['device', '--help'], ['--skill']]) {
    const output = await runCompiledObjectCli(args, objectCliEnvironment(root))
    expect(output.code, output.stderr).toBe(0)
    expect(output.stdout).toContain('authenticated key fingerprints'); expect(output.stdout).toContain('Unrecorded identification remains unknown')
    expect(output.stdout).toContain('device revoke --device ID')
  }
})
