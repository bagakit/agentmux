import { fixturePath } from '../../../test/fixture-values.mjs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError, AgentMuxFileAgentSessionStore, connectAgentMuxRpc,
  type AgentMuxControlServerOptions, type AgentMuxRpcCallContext } from '@agentmux/core'
import { startAgentMuxHost, type AgentMuxHostOptions } from '../src/host.js'
import { DeviceAuthority } from '../src/device-authority.js'
import { createDeviceAdministration } from '../src/device-administration.js'

const policy = vi.hoisted(() => ({ tlsFailure: false, listener: true, listenerFailure: false,
  connectGate: undefined as (() => Promise<void>) | undefined, coreConnections: 0 }))
vi.mock('@agentmux/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@agentmux/core')>()
  return { ...actual,
    // Only Core lifecycle is isolated: no Native, Run or production App is started.
    AgentMuxClient: class { async connect() { policy.coreConnections++; await policy.connectGate?.() } async dispose() {} },
    AgentMuxHostedRuntimeService: class { async dispose() {} },
    AgentMuxControlServer: class extends actual.AgentMuxControlServer {
      private readonly selectedTls: boolean
      constructor(options: AgentMuxControlServerOptions) { const { http, ...unix } = options; super(unix); this.selectedTls = !!http }
      override get httpAddress() { return this.selectedTls && policy.listener && !policy.listenerFailure ? { host: '127.0.0.1', port: 9443 } : null }
      override get httpUnavailable() { return this.selectedTls && policy.listenerFailure
        ? new actual.AgentMuxError('Controlled private listener is unavailable; existing Unix remains available.', 'CONTROL_UNAVAILABLE') : null }
    }
  }
})
vi.mock('../src/private-tls.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/private-tls.js')>()
  return { ...actual, readPrivateTls: async () => {
    if (policy.tlsFailure) throw new Error('Controlled TLS certificate observation failed.')
    return { host: '127.0.0.1', port: 9443, origin: 'https://127.0.0.1:9443', expiresAt: 100,
      certificateFingerprint: Array.from({ length: 32 }, () => 'AB').join(':'), tls: { key: Buffer.from('fixture-key'), cert: Buffer.from('fixture-certificate') } }
  } }
})
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  policy.tlsFailure = false; policy.listener = true; policy.listenerFailure = false; policy.connectGate = undefined })
const local: AgentMuxRpcCallContext = { transport: 'unix', principal: { kind: 'user', id: 'exact-local-request' } }
async function directory() { const root = await mkdtemp(join(tmpdir(), 'amx-host-state-')); cleanups.push(() => rm(root, { recursive: true, force: true })); return root }
async function host(options: Partial<AgentMuxHostOptions> = {}) {
  const root = await directory(), path = join(root, 'control.sock')
  const h = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), socketPath: path, ...options })
  cleanups.push(() => h.dispose())
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanups.push(() => client.dispose())
  return { root, h, client }
}
const configuration = { host: '127.0.0.1', port: 9443, keyPath: fixturePath("explicit/key.pem"), certificatePath: fixturePath("explicit/certificate.pem") }

/** Original Host factory/getter/Authority and real Unix dispatcher/SDK are exercised.
 * TLS/listener facts and Core.connect are controlled ports: no actual HTTPS, Native or Phone claim. */
it('reads the actual Host getter through device.ls and retains a selected missing manifest without guessing programmatic sources', async () => {
  const plain = await host(), plainAuthority = await plain.h.deviceAuthority()
  expect(await plain.client.call('device.ls', {})).toEqual({ hostId: plainAuthority.hostId, devices: [], requests: [], privateAccess: plain.h.privateAccessState() })
  expect(plain.h.privateAccessState()).toMatchObject({ state: 'unconfigured' })
  expect(plain.h.privateAccessState()).not.toHaveProperty('configurationPath')
  expect(plain.h.privateAccessState()).not.toHaveProperty('certificatePreparation')
  const selected = await host({ privateAccessConfigurationPath: fixturePath("explicit/missing.json"), privateAccessIssue: 'Original manifest cannot be read.' })
  const original = await readFile(join(selected.root, 'agentmux-devices.json'))
  const observation = await selected.client.call('device.ls', {})
  expect(observation.privateAccess).toEqual({ state: 'unavailable', message: 'Original manifest cannot be read.', configurationPath: fixturePath("explicit/missing.json") })
  expect(await selected.client.call('device.ls', {})).toEqual(observation)
  expect(await readFile(join(selected.root, 'agentmux-devices.json'))).toEqual(original)
})

it('does not fabricate unconfigured while private initialization is pending, and leaves actual Unix diagnostics usable', async () => {
  const root = await directory(), path = join(root, 'control.sock'); let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); policy.connectGate = async () => await gate
  const connectedBefore = policy.coreConnections
  const pending = startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), socketPath: path })
  await vi.waitFor(() => expect(policy.coreConnections).toBeGreaterThan(connectedBefore))
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanups.push(() => client.dispose())
  try {
    const before = await client.call('device.ls', {})
    expect(before.privateAccess).toMatchObject({ state: 'unavailable', message: expect.stringContaining('not yet confirmed') })
    release(); const h = await pending; cleanups.push(() => h.dispose())
    const after = await client.call('device.ls', {})
    expect(after.privateAccess).toMatchObject({ state: 'unconfigured' }); expect(after.hostId).toBe(before.hostId)
  } finally { release() }
})

it('keeps original issuer/listening facts separate from missing page assets and unavailable configured listeners', async () => {
  const listening = await host({ privateAccess: { ...configuration, mobileBuildDirectory: fixturePath("missing/mobile-build") }, privateAccessConfigurationPath: fixturePath("explicit/access.json") })
  const authority = await listening.h.deviceAuthority(), original = await readFile(join(listening.root, 'agentmux-devices.json'))
  expect((await listening.client.call('device.ls', {})).privateAccess).toMatchObject({ state: 'listening', issuerHostId: authority.hostId,
    origin: 'https://127.0.0.1:9443', certificateFingerprint: Array.from({ length: 32 }, () => 'AB').join(':'), expiresAt: 100,
    configurationPath: fixturePath("explicit/access.json"), assetIssue: expect.stringContaining('mobile build cannot be read') })
  policy.listener = false
  expect((await listening.client.call('device.ls', {})).privateAccess).toMatchObject({ state: 'unavailable', message: expect.stringContaining('not confirmed') })
  policy.listener = true; policy.listenerFailure = true
  expect((await listening.client.call('device.ls', {})).privateAccess).toMatchObject({ state: 'unavailable', message: expect.stringContaining('existing Unix') })
  policy.listenerFailure = false
  expect((await listening.client.call('device.ls', {})).privateAccess.state).toBe('listening')
  expect(await readFile(join(listening.root, 'agentmux-devices.json'))).toEqual(original)
})

it('retains legitimate configuration sources when TLS is unavailable and omits malformed source metadata', async () => {
  policy.tlsFailure = true
  const f = await host({ privateAccess: configuration, privateAccessConfigurationPath: fixturePath("explicit/unreadable.json") })
  expect((await f.client.call('device.ls', {})).privateAccess).toEqual({ state: 'unavailable', message: 'Controlled TLS certificate observation failed.', configurationPath: fixturePath("explicit/unreadable.json") })
  const invalid = ['relative.json', fixturePath('bad\u2028path'), fixturePath('bad\0path'), '/' + '界'.repeat(1366)]
  expect(invalid).toHaveLength(4)
  for (const privateAccessConfigurationPath of invalid) {
    const next = await host({ privateAccessIssue: 'Unconfirmed private access.', privateAccessConfigurationPath })
    expect((await next.client.call('device.ls', {})).privateAccess).toEqual({ state: 'unavailable', message: 'Unconfirmed private access.' })
  }
})

it('authorizes and reads the original Authority before the getter, preserving observer failure without swallowing Authority errors', async () => {
  const root = await directory(), authority = await DeviceAuthority.open(join(root, 'original-authority.json'))
  const original = await readFile(join(root, 'original-authority.json'))
  const getter = vi.fn(() => { throw new Error('Unconfirmed getter') })
  const admin = createDeviceAdministration(Promise.resolve(authority), undefined, getter)
  const rejected = [{ ...local, caller: { agentSessionId: 'managed-session', capability: 'claimed-human' } }, { ...local, transport: 'http' as const },
    { ...local, principal: { kind: 'device' as const, id: 'paired-device' } }]
  expect(rejected).toHaveLength(3)
  for (const context of rejected) await expect(admin.call('device.ls', {}, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(getter).toHaveBeenCalledTimes(0)
  const failure = new AgentMuxError('Original Authority is unreadable.', 'CONTROL_PROTOCOL_ERROR')
  const unreadable = createDeviceAdministration(Promise.reject(failure), undefined, getter)
  await expect(unreadable.call('device.ls', {}, local)).rejects.toBe(failure); expect(getter).toHaveBeenCalledTimes(0)
  const cancel = new AbortController(); cancel.abort(new AgentMuxError('Reader cancelled.', 'CONTROL_CANCELLED'))
  await expect(admin.call('device.ls', {}, { ...local, signal: cancel.signal })).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  expect(getter).toHaveBeenCalledTimes(0)
  const facts = await admin.call('device.ls', {}, local)
  expect(facts).toEqual({ hostId: authority.hostId, devices: [], requests: [], privateAccess: { state: 'unavailable', message: expect.stringContaining('observation is unavailable') } })
  expect(getter).toHaveBeenCalledTimes(1)
  expect(await createDeviceAdministration(Promise.resolve(authority)).call('device.ls', {}, local)).toEqual(facts)
  expect(await readFile(join(root, 'original-authority.json'))).toEqual(original)
})

it('keeps the captured original startup source stable when a programmatic options object is later changed', async () => {
  const root = await directory(), options: AgentMuxHostOptions = { store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')),
    socketPath: join(root, 'control.sock'), privateAccessConfigurationPath: fixturePath("original/startup.json") }
  const h = await startAgentMuxHost(options); cleanups.push(() => h.dispose())
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.socketPath! } }); cleanups.push(() => client.dispose())
  options.privateAccessConfigurationPath = fixturePath("unrelated/later.json"); options.privateAccess = configuration
  expect((await client.call('device.ls', {})).privateAccess).toMatchObject({ state: 'unconfigured', configurationPath: fixturePath("original/startup.json") })
})
