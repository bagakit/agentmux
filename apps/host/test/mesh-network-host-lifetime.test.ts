import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { startAgentMuxHost } from '../src/host.js'
import { DeviceAuthority } from '@agentmux/core/device-access'
import { AgentMuxClient } from '../../../packages/core/src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../../packages/core/src/agent-session-store.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { exportPublicKey, generateKeyPair } from '@agentmux/relay/e2ee'
import { loadOrCreateRelayKeyPair } from '../../../packages/core/src/rpc-relay-keypair.js'
import * as relayIdentity from '../../../packages/core/src/rpc-relay-keypair.js'
import { startHeadlessAgentMux } from '../../../packages/core/src/headless-runtime.js'

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) => actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js') ? fileURLToPath(new URL('../../../packages/core/src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('actual Host dispose releases an unacquired DeviceAuthority observation and never adopts it or creates a daemon key after close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-host-held-authority-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  // This bounded lifecycle case uses the real Host/Core/Unix owner; Native I/O is
  // proved independently by mesh-network-core.test.ts's official daemon/PTY chain.
  vi.spyOn(AgentMuxClient.prototype, 'connect').mockResolvedValue()
  const originalAuthority = await DeviceAuthority.open(join(root, 'retained-original-device-authority.json'))
  const flushed = vi.spyOn(originalAuthority, 'flush')
  let release!: (value: DeviceAuthority) => void
  const held = new Promise<DeviceAuthority>(resolve => { release = resolve })
  const opening = vi.spyOn(DeviceAuthority, 'open')
    .mockRejectedValueOnce(Error('original device file temporarily unreadable'))
    .mockImplementationOnce(async () => await held)
  const host = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), socketPath: join(root, 'control.sock'), mobileBuildDirectory: join(root, 'unused-mobile-assets'), mobilePort: 0 })
  cleanup.push(() => host.dispose())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.server.path } }); cleanup.push(() => rpc.dispose())
  const settings = await vi.waitFor(async () => { const value = await rpc.call('settings.mesh.inspect', {}); expect(value.identity).not.toBeNull(); return value })
  await rpc.call('settings.mesh.configure', { expectedRevision: settings.revision, operationId: 'held-original-host-authority', configuration: { ...settings.configuration, role: 'participant', members: [{ peerId: settings.identity!.peerId, publicKey: settings.identity!.publicKey }] } })
  await vi.waitFor(() => expect(opening).toHaveBeenCalledTimes(2))
  const stopping = host.dispose()
  try {
    const completedWhileAuthorityHeld = await Promise.race([stopping.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000))])
    expect(completedWhileAuthorityHeld).toBe(true)
    await expect(readFile(join(root, 'agentmux-relay-keypair.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { release(originalAuthority); await stopping }
  await vi.waitFor(() => expect(flushed).toHaveBeenCalledTimes(1))
  await expect(host.deviceAuthority()).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  await expect(readFile(join(root, 'agentmux-relay-keypair.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(host.mobilePort()).toBeNull()
})

it('closing this authority ends only its readers and drains accepted metadata without durable device revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-authority-close-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'original-devices.json'), owner = await DeviceAuthority.open(path), key = exportPublicKey(generateKeyPair().publicKey)
  const device = await owner.authorizeKey(key), reader = owner.observe(device)
  const accepted = owner.hello(device.deviceId, 'accepted before close')
  owner.close()
  expect(reader.signal.aborted).toBe(true)
  await accepted; await owner.flush()
  await expect(owner.hello(device.deviceId, 'new write after close')).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const restored = await DeviceAuthority.open(path)
  expect(restored.hostId).toBe(owner.hostId)
  expect(await restored.authorizeKey(key)).toMatchObject({ deviceId: device.deviceId, name: 'accepted before close' })
  expect(restored.devices()[0]!.revokedAt).toBeUndefined()
})

it('a missing original Host device file is not replaced when its retained daemon key proves an existing endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-host-missing-device-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.spyOn(AgentMuxClient.prototype, 'connect').mockResolvedValue()
  const keyPath = join(root, 'agentmux-relay-keypair.json'); await loadOrCreateRelayKeyPair(keyPath)
  const retainedKey = await readFile(keyPath, 'utf8')
  const host = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), socketPath: join(root, 'control.sock'), mobileBuildDirectory: join(root, 'unused-mobile-assets'), mobilePort: 0 })
  cleanup.push(() => host.dispose())
  await expect(host.deviceAuthority()).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(root, 'agentmux-devices.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(keyPath, 'utf8')).toBe(retainedKey)
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.server.path } }); cleanup.push(() => rpc.dispose())
  expect((await rpc.call('system.endpoint', {})).publication?.state).toBe('available')
})

it('Host holds the semantic lease for an already dispatched daemon-key write without adopting a late endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-host-held-key-write-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.spyOn(AgentMuxClient.prototype, 'connect').mockResolvedValue()
  const actualLoad = relayIdentity.loadOrCreateRelayKeyPair
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  vi.spyOn(relayIdentity, 'loadOrCreateRelayKeyPair').mockRejectedValueOnce(Error('original key read temporarily unavailable')).mockImplementationOnce(async (path, options) => {
    const pair = await actualLoad(path, { ...options, observeMutation: work => {
      // Hold the actual writer's completion after its real wx/write/sync. The
      // owner cannot infer an ACK or release its lease while that Promise is held.
      const mutation = work.then(async () => { entered(); await held })
      options?.observeMutation?.(mutation)
    } })
    await held; return pair
  })
  const options = { store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), socketPath: join(root, 'control.sock'), mobileBuildDirectory: join(root, 'unused-mobile-assets'), mobilePort: 0 }
  const host = await startAgentMuxHost(options); cleanup.push(() => host.dispose())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.server.path } }); cleanup.push(() => rpc.dispose())
  const settings = await vi.waitFor(async () => { const value = await rpc.call('settings.mesh.inspect', {}); expect(value.identity).not.toBeNull(); return value })
  await rpc.call('settings.mesh.configure', { expectedRevision: settings.revision, operationId: 'held-original-daemon-write', configuration: { ...settings.configuration, role: 'participant', members: [{ peerId: settings.identity!.peerId, publicKey: settings.identity!.publicKey }] } })
  await started
  const stopping = host.dispose()
  try {
    const returned = await Promise.race([stopping.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))])
    expect(returned).toBe(false)
    await expect(startHeadlessAgentMux({ store: options.store, socketPath: options.socketPath })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_BUSY' })
  } finally { release(); await stopping }
  const retained = await actualLoad(join(root, 'agentmux-relay-keypair.json'), { createIfMissing: false })
  expect(exportPublicKey(retained.publicKey)).toEqual(expect.any(String))
  expect(host.mobilePort()).toBeNull()
  await expect(host.deviceAuthority()).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
})

it('a retained original daemon public binding prevents a missing private key from becoming a new endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-host-missing-daemon-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.spyOn(AgentMuxClient.prototype, 'connect').mockResolvedValue()
  const options = { store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), socketPath: join(root, 'control.sock'), mobileBuildDirectory: join(root, 'unused-mobile-assets'), mobilePort: 0 }
  const first = await startAgentMuxHost(options); cleanup.push(() => first.dispose())
  const authority = await first.deviceAuthority(), binding = authority.daemonPublicKeyB64
  expect(binding).toEqual(expect.any(String))
  await first.dispose(); await rm(join(root, 'agentmux-relay-keypair.json'))
  const second = await startAgentMuxHost(options); cleanup.push(() => second.dispose())
  expect((await second.deviceAuthority()).hostId).toBe(authority.hostId)
  expect((await second.deviceAuthority()).daemonPublicKeyB64).toBe(binding)
  await expect(readFile(join(root, 'agentmux-relay-keypair.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: second.server.path } }); cleanup.push(() => rpc.dispose())
  expect((await rpc.call('system.endpoint', {})).publication?.state).toBe('available')
})
