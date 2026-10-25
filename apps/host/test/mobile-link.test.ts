import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionOfferUrl, parseConnectionOfferUrl } from '@agentmux/relay/offer'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const native = vi.hoisted(() => ({ client: null as unknown, observeRelay: null as ((state: 'disconnected') => void) | null }))
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
import { createDeviceAdministration } from '../src/device-administration.js'
import { DeviceAuthority } from '../src/device-authority.js'
import { startAgentMuxHost } from '../src/host.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { native.client = null; native.observeRelay = null; for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
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

describe('original mobile link discovery', () => {
  it.each([['192.168.1.20:8443', false], ['relay.example.org', true]])('freezes one %s offer and exposes its existing endpoint even while disconnected', async (endpoint, tls) => {
    const original = await authority(), url = offer(original.hostId, endpoint, tls), link = vi.fn(() => url)
    const state = vi.fn((_url?: string) => ({ state: 'disconnected' as const, message: 'Original connection observation' }))
    const administration = createDeviceAdministration(Promise.resolve(original), state, link)
    const result = await administration.call('device.link', {}, {})
    expect(result).toEqual({ hostId: original.hostId, url, pageUrl: url.split('#')[0], relay: { endpoint, useTls: tls },
      mobileAccess: { state: 'disconnected', message: 'Original connection observation', origin: new URL(url).origin } })
    expect(link).toHaveBeenCalledTimes(1); expect(state).toHaveBeenCalledExactlyOnceWith(url)
    expect(original.devices()).toEqual([])
    expect(core.parseAgentMuxRpcDeviceResult('device.link', result, {})).toEqual(result)
    for (const changes of [{ pageUrl: 'https://another.example/' }, { relay: { endpoint: 'another.example', useTls: true } },
      { mobileAccess: { ...result.mobileAccess, origin: 'https://another.example' } }, { hostId: 'another-host' }]) {
      expect(() => core.parseAgentMuxRpcDeviceResult('device.link', { ...result, ...changes }, {})).toThrow()
    }
  })
  it('authenticates the exact local caller before reading while retaining device administration boundaries', async () => {
    const h = await owner(), original = await authority(), administration = createDeviceAdministration(Promise.resolve(original),
      () => ({ state: 'connected', message: 'Ready' }), () => offer(original.hostId, '192.168.1.20:8443'))
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
    const h = await owner(), original = await authority(), administration = createDeviceAdministration(Promise.resolve(original),
      () => ({ state: 'starting', message: 'Starting' }), () => { throw new core.AgentMuxError('Original address unavailable', 'CONTROL_UNAVAILABLE') })
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
    expect(receipt.result.relay).toEqual(parseConnectionOfferUrl(receipt.result.url)!.relay)
    const address = host.server.httpAddress!
    const http = await runCompiledObjectCli(['--endpoint', `http://${address.host}:${address.port}/`, 'device', 'link'],
      { ...env, AGENTMUX_RPC_HTTP_TOKEN: 'private-mobile-link-probe' })
    expect(http.code, http.stderr).toBe(0); expect(JSON.parse(http.stdout).result).toEqual(expected)
    expect(native.observeRelay).not.toBeNull(); native.observeRelay!('disconnected')
    const disconnected = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'device', 'link'], env)
    expect(disconnected.code, disconnected.stderr).toBe(0)
    expect(JSON.parse(disconnected.stdout).result).toEqual({ ...expected, mobileAccess: { ...expected.mobileAccess, state: 'disconnected', message: '连接中断，自动重连中；原会话保留。' } })
    expect((await user.call('device.ls', {})).devices).toEqual([])
    const help = await runCompiledObjectCli(['device', 'link', '--help'], env)
    const skill = await runCompiledObjectCli(['device', '--skill'], env)
    expect(help.stdout).toContain('pageUrl'); expect(help.stdout).toContain('does not enroll')
    expect(skill.stdout).toContain('address remains readable while disconnected')
  })
})
