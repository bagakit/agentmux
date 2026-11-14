// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionOfferUrl, parseConnectionOfferUrl, parseConnectionLinkUrl } from '@agentmux/relay/offer'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const native = vi.hoisted(() => ({ client: null as unknown, observeRelay: null as ((state: 'disconnected') => void) | null,
  interfaces: null as ReturnType<typeof import('node:os')['networkInterfaces']> | null }))
vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>()
  return { ...actual, networkInterfaces: () => native.interfaces ?? actual.networkInterfaces() }
})
vi.mock('@agentmux/relay/server', async original => {
  const actual = await original<typeof import('@agentmux/relay/server')>()
  return { ...actual, startRelayTransport: (options: Parameters<typeof actual.startRelayTransport>[0]) => {
    native.observeRelay = options.onState ?? null
    return actual.startRelayTransport(options)
  } }
})
vi.mock('@agentmux/core', async original => {
  const actual = await original<typeof import('@agentmux/core')>()
  return { ...actual, startHeadlessAgentMux: async (options: Parameters<typeof actual.startHeadlessAgentMux>[0]) => {
    // Native process I/O alone is isolated. Host assembly, authority, service,
    // public transport/parser and the compiled command are production consumers.
    const server = new actual.AgentMuxControlServer({ ...options?.service,
      coreClients: () => native.client ? [{ hostId: 'local', client: native.client as InstanceType<typeof actual.AgentMuxClient> }] : [],
      socketPath: options?.socketPath, http: { host: '127.0.0.1', port: 0, token: 'private-mobile-link-probe' } })
    await server.start()
    return { client: native.client, hosted: {}, server, stop: () => server.stop() }
  } }
})
import * as core from '@agentmux/core'
import { createDeviceAdministration } from '@agentmux/core/device-access'
import { DeviceAuthority } from '@agentmux/core/device-access'
import { startAgentMuxHost } from '../src/host.js'
import { createInterfacePortLabels, mobileLinkCandidates, parsePortLabels } from '../src/mobile-link-candidates.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { native.client = null; native.observeRelay = null; native.interfaces = null; for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function owner() {
  const value = await rpcOwnerFixture(['caller'], { AgentMuxClient: core.AgentMuxClient, AgentMuxFileAgentSessionStore: core.AgentMuxFileAgentSessionStore })
  closes.push(value.close); return value
}
async function authority() {
  const root = await mkdtemp(join(tmpdir(), 'amx-mobile-link-'))
  closes.push(() => rm(root, { recursive: true, force: true }))
  return DeviceAuthority.open(join(root, 'devices.json'))
}
const offer = (hostId: string, endpoint: string, useTls = false) => connectionOfferUrl(
  `${useTls ? 'https' : 'http'}://${endpoint}/`, { v: 2, serverId: hostId,
    daemonPublicKeyB64: 'A'.repeat(43) + '=', relay: { endpoint, useTls } })
/** A link owner with no local-network candidates, as for a TLS Relay endpoint. */
const linked = (url: string) => async () => ({ url, offer: parseConnectionOfferUrl(url)!, candidates: [] })

const nic = (address: string, internal = false) => ({ address, netmask: '255.255.252.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal, cidr: `${address}/22` })
describe('choosing the address a phone connects to', () => {
  it('prefers the default-route adapter, then wired and wireless ones, and keeps link-local and odd adapters last', () => {
    const interfaces = { lo0: [nic('127.0.0.1', true)], en0: [nic('10.69.58.222')], en9: [nic('10.69.47.238')], utun4: [nic('10.8.0.2')],
      en5: [nic('169.254.20.1')], en1: [{ ...nic('fe80::1'), family: 'IPv6' as const }], en2: [nic('8.8.8.8')] }
    const labels = new Map([['en0', 'Wi-Fi'], ['en9', 'USB 10/100/1000 LAN']])
    expect(mobileLinkCandidates(interfaces, 'en9', labels)).toEqual([
      { address: '10.69.47.238', interface: 'en9', label: 'USB 10/100/1000 LAN', preferred: true },
      { address: '10.69.58.222', interface: 'en0', label: 'Wi-Fi', preferred: false },
      { address: '10.8.0.2', interface: 'utun4', preferred: false },
      { address: '169.254.20.1', interface: 'en5', preferred: false }])
    // Without a known default route the plain order holds: named adapters first, in OS order.
    expect(mobileLinkCandidates(interfaces, null).map(c => c.interface)).toEqual(['en0', 'en9', 'utun4', 'en5'])
    expect(mobileLinkCandidates({ lo0: [nic('127.0.0.1', true)] }, null)).toEqual([])
    // A full-tunnel VPN carries the default route, but a phone on Wi-Fi cannot reach it.
    expect(mobileLinkCandidates({ utun4: [nic('10.8.0.2')], en0: [nic('10.69.58.222')] }, 'utun4').map(c => [c.interface, c.preferred]))
      .toEqual([['en0', true], ['utun4', false]])
  })
  it('keeps candidate addresses unique and the result parser bounded', async () => {
    const twice = mobileLinkCandidates({ en0: [nic('10.0.0.5')], en1: [nic('10.0.0.5')] }, null)
    expect(twice.map(c => c.interface)).toEqual(['en0'])
    const original = await authority(), url = offer(original.hostId, '10.0.0.5:8443')
    const page = new URL(url); page.hash = ''
    const result = { hostId: original.hostId, url, pageUrl: page.href, relay: { endpoint: '10.0.0.5:8443', useTls: false },
      mobileAccess: { state: 'connected', message: 'Ready', origin: page.origin } }
    const one = { address: '10.0.0.5', interface: 'en0', preferred: true }
    expect(() => core.parseAgentMuxRpcDeviceResult('device.link', { ...result, candidates: [one, one] }, {})).toThrow()
    expect(() => core.parseAgentMuxRpcDeviceResult('device.link', { ...result, candidates: Array.from({ length: 33 }, (_, i) => ({ ...one, address: `10.0.1.${i}` })) }, {})).toThrow()
    expect(() => core.parseAgentMuxRpcDeviceResult('device.link', { ...result, candidates: [{ ...one, interface: 'x'.repeat(65) }] }, {})).toThrow()
    expect(core.parseAgentMuxRpcDeviceResult('device.link', { ...result, candidates: [one] }, {}).candidates).toEqual([one])
  })
  it.runIf(process.platform === 'darwin')('reads the OS port labels once, keeps the first good read and retries after a failure', async () => {
    const listing = 'Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: 00:00:00:00:00:01\n\nHardware Port: USB 10/100/1000 LAN\nDevice: en9\nEthernet Address: 00:00:00:00:00:02\n'
    expect([...parsePortLabels(listing)]).toEqual([['en0', 'Wi-Fi'], ['en9', 'USB 10/100/1000 LAN']])
    const read = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('timed out')).mockResolvedValue(listing)
    const labels = createInterfacePortLabels(read)
    expect([...await labels()]).toEqual([])
    const [first, second] = await Promise.all([labels(), labels()])
    expect(first).toBe(second); expect(first.get('en0')).toBe('Wi-Fi')
    expect(await labels()).toBe(first)
    expect(read).toHaveBeenCalledTimes(2)
    // An adapter plugged in later is not in the last good read, so asking for it reads again.
    read.mockResolvedValue(listing + '\nHardware Port: Thunderbolt Ethernet\nDevice: en7\nEthernet Address: 00:00:00:00:00:03\n')
    expect((await labels(['en0'])).get('en7')).toBeUndefined(); expect(read).toHaveBeenCalledTimes(2)
    expect((await labels(['en7'])).get('en7')).toBe('Thunderbolt Ethernet'); expect(read).toHaveBeenCalledTimes(3)
  })
  it('reads the link for the requested candidate and refuses an address that is not one', async () => {
    const original = await authority(), endpointFor = (address: string) => `${address}:8443`
    const candidates = [{ address: '10.69.47.238', interface: 'en9', preferred: true }, { address: '10.69.58.222', interface: 'en0', label: 'Wi-Fi', preferred: false }]
    const link = vi.fn(async (address?: string) => {
      const chosen = address === undefined ? candidates[0]! : candidates.find(candidate => candidate.address === address)
      if (!chosen) throw new core.AgentMuxError('Not a candidate', 'INVALID_CONTROL_REQUEST')
      const url = offer(original.hostId, endpointFor(chosen.address))
      return { url, offer: parseConnectionOfferUrl(url)!, candidates }
    })
    const administration = createDeviceAdministration(() => Promise.resolve(original), () => ({ state: 'connected', message: 'Ready' }), link)
    const preferred = await administration.call('device.link', {}, {})
    expect(preferred.relay.endpoint).toBe('10.69.47.238:8443'); expect(preferred.candidates).toEqual(candidates)
    expect(core.parseAgentMuxRpcDeviceResult('device.link', preferred, {})).toEqual(preferred)
    const wifi = await administration.call('device.link', { address: '10.69.58.222' }, {})
    expect(wifi.relay.endpoint).toBe('10.69.58.222:8443'); expect(new URL(wifi.pageUrl).hostname).toBe('10.69.58.222')
    expect(core.parseAgentMuxRpcDeviceResult('device.link', wifi, { address: '10.69.58.222' })).toEqual(wifi)
    // A result for another address than the one asked for, or one not among its candidates, is malformed.
    expect(() => core.parseAgentMuxRpcDeviceResult('device.link', preferred, { address: '10.69.58.222' })).toThrow()
    expect(() => core.parseAgentMuxRpcDeviceResult('device.link', { ...preferred, candidates: [candidates[1]] }, {})).toThrow()
    await expect(administration.call('device.link', { address: '192.168.9.9' }, {})).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(link.mock.calls.map(call => call[0])).toEqual([undefined, '10.69.58.222', '192.168.9.9'])
    for (const address of ['fe80::1', 'example.org', '10.0.0', 42]) expect(() => core.parseAgentMuxRpcDeviceParams('device.link', { address }), String(address)).toThrow()
    expect(() => core.parseAgentMuxRpcDeviceParams('device.link', { address: '10.0.0.1', other: true })).toThrow()
    expect(original.devices()).toEqual([])
  })
})

describe('original mobile link discovery', () => {
  it('refuses the previous link format before opening HTTP or Relay transport in the actual CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-legacy-cli-'))
    closes.push(() => rm(root, { recursive: true, force: true }))
    let connections = 0, requests = 0
    const server = createServer((_request, response) => { requests++; response.writeHead(503); response.end() })
    server.on('connection', () => { connections++ })
    server.on('upgrade', (_request, socket) => { requests++; socket.destroy() })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    closes.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const address = server.address() as { port: number }
    const original = await authority(), saved = { v: 2, serverId: original.hostId,
      daemonPublicKeyB64: 'A'.repeat(43) + '=', relay: { endpoint: `127.0.0.1:${address.port}`, useTls: false } }
    const legacy = `http://127.0.0.1:${address.port}/#offer=` + Buffer.from(JSON.stringify(saved)).toString('base64url')
    const result = await runCompiledObjectCli(['--endpoint', legacy, 'device', 'hello', '--name', 'Legacy input'], objectCliEnvironment(root))
    expect(result.code).not.toBe(0)
    expect(result.stdout + result.stderr).toContain('INVALID_CLI_ARGUMENT')
    expect(result.stdout + result.stderr).toContain('This connection link format is no longer supported.')
    expect(connections).toBe(0); expect(requests).toBe(0); expect(original.devices()).toEqual([])
  })
  it.each([['192.168.1.20:8443', false], ['relay.example.org', true]])('freezes one %s offer and exposes its existing endpoint even while disconnected', async (endpoint, tls) => {
    const original = await authority(), url = offer(original.hostId, endpoint, tls), link = vi.fn(linked(url))
    const state = vi.fn((_url?: string) => ({ state: 'disconnected' as const, message: 'Original connection observation' }))
    const administration = createDeviceAdministration(() => Promise.resolve(original), state, link)
    const result = await administration.call('device.link', {}, {})
    expect(result).toEqual({ hostId: original.hostId, url, pageUrl: url.split('#')[0], relay: { endpoint, useTls: tls },
      mobileAccess: { state: 'disconnected', message: 'Original connection observation', origin: new URL(url).origin }, candidates: [] })
    expect(link).toHaveBeenCalledTimes(1); expect(state).toHaveBeenCalledExactlyOnceWith(url)
    expect(original.devices()).toEqual([])
    expect(core.parseAgentMuxRpcDeviceResult('device.link', result, {})).toEqual(result)
    for (const changes of [{ pageUrl: 'https://another.example/' }, { relay: { endpoint: 'another.example', useTls: true } },
      { mobileAccess: { ...result.mobileAccess, origin: 'https://another.example' } }, { hostId: 'another-host' }]) {
      expect(() => core.parseAgentMuxRpcDeviceResult('device.link', { ...result, ...changes }, {})).toThrow()
    }
  })
  it('authenticates the exact local caller before reading while retaining device administration boundaries', async () => {
    const h = await owner(), original = await authority(), administration = createDeviceAdministration(() => Promise.resolve(original),
      () => ({ state: 'connected', message: 'Ready' }), linked(offer(original.hostId, '192.168.1.20:8443')))
    const call = vi.spyOn(administration, 'call'), service = new core.AgentMuxRpcService({ coreClients: h.coreClients, deviceAdministration: administration })
    expect((await service.call('device.link', {}, { caller: h.credentials, transport: 'unix' })).hostId).toBe(original.hostId)
    expect((await service.call('device.link', {}, { caller: h.credentials, transport: 'http' })).hostId).toBe(original.hostId)
    await expect(service.call('device.link', {}, { caller: { ...h.credentials, capability: 'invalid' }, transport: 'unix' })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    const remoteClient = Object.assign(Object.create(h.client), { forwardRpc: vi.fn(),
      authorizeRetainedAgentCaller: h.client.authorizeRetainedAgentCaller.bind(h.client) })
    const remote = new core.AgentMuxRpcService({ coreClients: () => [{ hostId: 'other-host', client: remoteClient }], deviceAdministration: administration })
    await expect(remote.call('device.link', {}, { caller: h.credentials, transport: 'unix' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(service.call('device.link', {}, { transport: 'http', principal: { kind: 'device', id: 'other-device' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(service.call('device.ls', {}, { caller: h.credentials, transport: 'unix' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(service.call('device.revoke', { deviceId: 'original-device' }, { caller: h.credentials, transport: 'unix' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(service.call('device.hello', { name: 'Phone' }, { caller: h.credentials, transport: 'relay' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(call).toHaveBeenCalledTimes(2); expect(original.devices()).toEqual([])
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('keeps missing original address explicit without affecting the healthy caller', async () => {
    const h = await owner(), original = await authority(), administration = createDeviceAdministration(() => Promise.resolve(original),
      () => ({ state: 'starting', message: 'Starting' }), async () => { throw new core.AgentMuxError('Original address unavailable', 'CONTROL_UNAVAILABLE') })
    const service = new core.AgentMuxRpcService({ coreClients: h.coreClients, deviceAdministration: administration })
    await expect(service.call('device.link', {}, { caller: h.credentials })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(h.client.agentSession('caller').agentSessionId).toBe('caller'); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('returns the same original Host facts through the actual compiled CLI and independent public client', async () => {
    const h = await owner(), assets = join(h.root, 'mobile'), socketPath = join(h.root, 'control.sock')
    const html = '<!doctype html><title>Original phone</title>', digest = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex')
    await mkdir(assets); await writeFile(join(assets, 'index.html'), html)
    const manifest = { schema: 'agentmux.mobile-web-release.v1', buildId: 'original-phone', files: [{ path: 'index.html', bytes: Buffer.byteLength(html), digest: digest(html) }] }
    await writeFile(join(assets, 'mobile-release.json'), JSON.stringify({ ...manifest, digest: digest(JSON.stringify(manifest)) }))
    native.client = h.client
    const host = await startAgentMuxHost({ store: h.store, socketPath, mobileBuildDirectory: assets, mobilePort: 0 })
    closes.push(() => host.dispose())
    const user = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); closes.push(() => user.dispose())
    await vi.waitFor(async () => expect((await user.call('device.ls', {})).mobileAccess).toMatchObject({ state: 'connected' }), { timeout: 10000 })
    const expected = await user.call('device.link', {})
    const env = objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: h.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: h.credentials.capability })
    const cli = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'device', 'link'], env)
    expect(cli.code, cli.stderr).toBe(0)
    const receipt = JSON.parse(cli.stdout)
    expect(receipt).toMatchObject({ ok: true, operation: 'device.link', result: expected })
    const pin = parseConnectionLinkUrl(receipt.result.url)!
    expect(pin.kind).toBe('pin')
    const devicesBeforeMetadata = (await user.call('device.ls', {})).devices
    const metadataResponse = await fetch(new URL('/.well-known/agentmux/connection', expected.pageUrl))
    expect(metadataResponse.headers.get('cache-control')).toBe('no-store')
    const metadata = await metadataResponse.json()
    expect(metadata).toMatchObject({ v: 2, serverId: expected.hostId, relay: expected.relay })
    expect(Object.keys(metadata).sort()).toEqual(['daemonPublicKeyB64', 'relay', 'serverId', 'v'])
    expect(pin.kind === 'pin' && pin.pin.daemonPublicKeyB64).toBe(metadata.daemonPublicKeyB64)
    expect((await user.call('device.ls', {})).devices).toEqual(devicesBeforeMetadata)
    const badHost = await new Promise<number>((resolve, reject) => { const read = request(new URL('/.well-known/agentmux/connection', expected.pageUrl), { headers: { Host: '203.0.113.8:' + new URL(expected.pageUrl).port } }, response => { response.resume(); resolve(response.statusCode!) }); read.on('error', reject); read.end() })
    expect(badHost).toBe(503)
    expect((await fetch(new URL('/.well-known/agentmux/connection', expected.pageUrl), { method: 'POST' })).status).toBe(405)
    const address = host.server.httpAddress!
    const http = await runCompiledObjectCli(['--endpoint', `http://${address.host}:${address.port}/`, 'device', 'link'],
      { ...env, AGENTMUX_RPC_HTTP_TOKEN: 'private-mobile-link-probe' })
    expect(http.code, http.stderr).toBe(0); expect(JSON.parse(http.stdout).result).toEqual(expected)
    expect(native.observeRelay).not.toBeNull(); native.observeRelay!('disconnected')
    const disconnected = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'device', 'link'], env)
    expect(disconnected.code, disconnected.stderr).toBe(0)
    expect(JSON.parse(disconnected.stdout).result).toEqual({ ...expected, mobileAccess: { ...expected.mobileAccess, state: 'disconnected', message: '连接中断，自动重连中；原会话保留。' } })
    expect((await user.call('device.ls', {})).devices).toEqual([])
    // Every candidate the Host lists can be chosen through the CLI; another address is refused.
    for (const candidate of expected.candidates) {
      const chosen = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'device', 'link', '--address', candidate.address], env)
      expect(chosen.code, chosen.stderr).toBe(0)
      expect(new URL(JSON.parse(chosen.stdout).result.pageUrl).hostname).toBe(candidate.address)
    }
    const refused = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'device', 'link', '--address', '203.0.113.9'], env)
    expect(refused.code).not.toBe(0); expect(refused.stdout + refused.stderr).toContain('INVALID_CONTROL_REQUEST')
    const help = await runCompiledObjectCli(['device', 'link', '--help'], env)

    const skill = await runCompiledObjectCli(['device', '--skill'], env)
    expect(help.stdout).toContain('pageUrl'); expect(help.stdout).toContain('does not enroll')
    expect(help.stdout).toContain('--address IPV4'); expect(help.stdout).toContain('never falling back'); expect(help.stdout).toContain('not a VPN tunnel')
    expect(skill.stdout).toContain('address remains readable while disconnected')
    // The actual CLI parses this owner-issued compact URL as a Relay endpoint, performs the real
    // encrypted handshake and reaches this Host's device owner, rather than treating it as HTTP.
    const phone = await runCompiledObjectCli(['--endpoint', expected.url, 'device', 'hello', '--name', 'Private CLI phone'], objectCliEnvironment(h.root))
    expect(phone.code, phone.stdout + phone.stderr).toBe(0)
    expect(JSON.parse(phone.stdout)).toMatchObject({ ok: true, operation: 'device.hello', result: { hostId: expected.hostId, device: { name: 'Private CLI phone' } } })
    if (process.env.AGENTMUX_TEST_MOBILE_LINK_HANDOFF) await writeFile(process.env.AGENTMUX_TEST_MOBILE_LINK_HANDOFF,
      JSON.stringify({ url: expected.url, offer: metadata, hostId: expected.hostId }), { mode: 0o600 })
  }, 30000)
})

it('the original running Host reads changed NIC candidates on the next public link without replacing its identity', async () => {
  const h = await owner(), assets = join(h.root, 'mobile'), socketPath = join(h.root, 'control.sock')
  const originalRun = structuredClone(h.client.agentSession('caller').run)
  const html = '<!doctype html><title>Original phone link</title>', digest = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex')
  await mkdir(assets); await writeFile(join(assets, 'index.html'), html)
  const manifest = { schema: 'agentmux.mobile-web-release.v1', buildId: 'changed-nic', files: [{ path: 'index.html', bytes: Buffer.byteLength(html), digest: digest(html) }] }
  await writeFile(join(assets, 'mobile-release.json'), JSON.stringify({ ...manifest, digest: digest(JSON.stringify(manifest)) }))
  native.client = h.client; native.interfaces = { en0: [nic('192.168.2.45')] }
  const host = await startAgentMuxHost({ store: h.store, socketPath, mobileBuildDirectory: assets, mobilePort: 0 })
  closes.push(() => host.dispose())
  const user = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); closes.push(() => user.dispose())
  await vi.waitFor(async () => expect((await user.call('device.ls', {})).mobileAccess.state).toBe('connected'), { timeout: 10000 })
  const before = await user.call('device.link', {}), beforeLink = parseConnectionLinkUrl(before.url)!
  expect(new URL(before.pageUrl).hostname).toBe('192.168.2.45')
  native.interfaces = { en0: [nic('10.69.59.116')] }
  const after = await user.call('device.link', {}), afterLink = parseConnectionLinkUrl(after.url)!
  expect(new URL(after.pageUrl).hostname).toBe('10.69.59.116')
  expect(after.candidates.map(value => value.address)).toEqual(['10.69.59.116'])
  expect(after.relay.endpoint).toBe('10.69.59.116:' + new URL(before.pageUrl).port)
  expect(after.hostId).toBe(before.hostId)
  expect(beforeLink.kind).toBe('pin'); expect(afterLink.kind).toBe('pin')
  expect(afterLink).toEqual(beforeLink)
  expect((await user.call('device.ls', {})).devices).toEqual([])
  expect(h.client.agentSession('caller').run).toEqual(originalRun)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)
