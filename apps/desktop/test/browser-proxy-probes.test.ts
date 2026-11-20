import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Socket } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, BrowserWindow: class {}, session: {}, webContents: { getAllWebContents: () => [] } }))
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { createBrowserProfileNetworkControl } from '../src/main/browser-profile-network-control.js'
import { createBrowserProfileProxyAuth } from '../src/main/browser-profile-proxy-auth.js'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../src/main/browser-profile-control.js'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { parseBrowserProxyProbe, type BrowserProxyProbe } from '../../../packages/core/src/browser-proxy-probe.js'
import { parseBrowserProfileControlPayload, parseBrowserProfileControlResult, assertBrowserProfileControlTarget } from '../../../packages/core/src/browser-profile-control.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const roots: string[] = [], cleanup: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.restoreAllMocks() })
const secret = 'original-private-password', username = 'original-private-user'
const gate = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done }); return { release, promise } }
async function proxy(kind: 'http' | 'socks5', status = 0, greeting = async () => {}) {
  const sockets = new Set<Socket>(), observed = { connections: 0, authentications: 0, matched: 0, greetings: 0 }
  const server = createServer(socket => {
    sockets.add(socket); observed.connections++; socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket))
    if (kind === 'http') return
    let buffer = Buffer.alloc(0), phase = 'greeting'
    socket.on('data', async bytes => {
      buffer = Buffer.concat([buffer, bytes])
      if (phase === 'greeting' && buffer.length >= 4) {
        expect([...buffer.subarray(0, 4)]).toEqual([5, 2, 0, 2]); buffer = buffer.subarray(4); phase = 'authentication'; observed.greetings++
        await greeting(); if (!socket.destroyed) socket.write(Buffer.from([5, 2])); return
      }
      if (phase === 'authentication' && buffer.length >= 3 + buffer[1]! && buffer.length >= 3 + buffer[1]! + buffer[2 + buffer[1]!]!) {
        observed.authentications++
        if (buffer[0] === 1 && buffer.subarray(2, 2 + buffer[1]!).toString() === username && buffer.subarray(3 + buffer[1]!).toString() === secret) observed.matched++
        phase = 'done'; socket.write(Buffer.from([1, status]))
      }
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())) })
  return { port: (server.address() as { port: number }).port, observed, kind }
}
async function fixture(endpoint: Awaited<ReturnType<typeof proxy>>) {
  const root = await mkdtemp(join(tmpdir(), 'proxy-probe-')); roots.push(root)
  const path = join(root, 'profiles.json'), store = new BrowserProfileStore(path), native = { apply: vi.fn(async () => {}), prepare: vi.fn(), observe: vi.fn(),
    observeWebRtc: vi.fn(() => ({ status: 'observed', policy: 'disable_non_proxied_udp', observedPages: 1 })) }
  const manager = new BrowserProfileManager(store, native as never); await manager.initialize()
  const id = manager.defaultProfileId(), revision = manager.listProfiles()[0]!.revision
  await manager.updateProfile(id, { network: { mode: 'proxy', server: `${endpoint.kind}://127.0.0.1:${endpoint.port}` } }, revision)
  const auth = createBrowserProfileProxyAuth({ path: join(root, 'sign-ins.json'), crypto: { available: () => true,
    encrypt: text => Buffer.from([...text].reverse().join('')), decrypt: bytes => [...bytes.toString()].reverse().join('') },
    profileOfSession: () => id, proxyOf: profile => manager.proxyOf(profile), configurationRevision: profile => manager.configurationRevision(profile), report: vi.fn() })
  await auth.set(id, { username, password: secret })
  manager.bindProxyCredentialsBeforeNetworkChange = profile => auth.bindCurrentProxy(profile)
  const checkExit = vi.fn(async () => ({ status: 'reachable' as const, httpStatus: 200, latencyMs: 3, ip: '203.0.113.8' }))
  const network = createBrowserProfileNetworkControl({ profiles: manager, proxyAuth: auth, checkExit, checkAddress: () => 'https://exit.example', reconnect: async () => {} })
  return { root, path, store, manager, native, id, auth, network, checkExit }
}

describe('original Profile protocol diagnostics', () => {
  it('observes real SOCKS authentication separately, preserves configuration tokens and does not repeat an original id', async () => {
    const endpoint = await proxy('socks5'), f = await fixture(endpoint), before = f.manager.listProfiles()[0]!, sequence = f.manager.listSequence()
    const result = await f.network.probe(f.id, 'original-diagnostic')
    expect(result).toMatchObject({ historySaved: true, diagnostic: { id: 'original-diagnostic', profileId: f.id, configurationRevision: before.revision,
      phase: 'observed', tcp: { status: 'connected' }, authentication: { status: 'authenticated' }, exit: { status: 'reachable', ip: '203.0.113.8' } } })
    expect(endpoint.observed).toMatchObject({ connections: 1, authentications: 1, matched: 1 })
    expect(f.checkExit).toHaveBeenCalledWith(f.id, 'https://exit.example')
    expect(f.native.observeWebRtc).toHaveBeenCalledTimes(1)
    expect(f.native.observeWebRtc).toHaveBeenCalledWith(f.id)
    expect(result.diagnostic.webrtc).toEqual({ status: 'observed', policy: 'disable_non_proxied_udp', observedPages: 1 })
    expect(f.manager.listProfiles()[0]).toEqual(before); expect(f.manager.listRevision()).toBe(1); expect(f.manager.listSequence()).toBeGreaterThan(sequence)
    expect(f.native.apply).toHaveBeenCalledTimes(1)
    expect(await f.network.probe(f.id, 'original-diagnostic')).toEqual(result); expect(endpoint.observed.connections).toBe(1)
    const history = await f.manager.networkHistory(f.id)
    expect(history.diagnostics).toEqual([result.diagnostic]); expect(history.nextCursor).toBeNull()
    for (const bytes of [JSON.stringify(result), await readFile(f.path, 'utf8')]) { expect(bytes).not.toContain(secret); expect(bytes).not.toContain(username) }
  })

  it('does not certify authentication because the password was saved or TCP connected', async () => {
    const endpoint = await proxy('socks5', 1), f = await fixture(endpoint)
    const { diagnostic } = await f.network.probe(f.id, 'rejected-diagnostic')
    expect(diagnostic.tcp.status).toBe('connected'); expect(diagnostic.authentication).toMatchObject({ status: 'rejected', reason: 'authentication-rejected' })
    expect(endpoint.observed.matched).toBe(1); expect(diagnostic.exit.status).toBe('reachable')
    const plain = await proxy('http'), g = await fixture(plain), http = await g.network.probe(g.id, 'tcp-only-diagnostic')
    expect(http.diagnostic).toMatchObject({ tcp: { status: 'connected' }, authentication: { status: 'not-applicable', reason: 'not-socks5' } })
    expect(plain.observed.authentications).toBe(0)
  })

  it('rechecks the exact configuration after waiting and sends no password to an old or replacement endpoint', async () => {
    const waiting = gate(), original = await proxy('socks5', 0, () => waiting.promise), replacement = await proxy('socks5')
    const f = await fixture(original), pending = f.network.probe(f.id, 'changing-diagnostic')
    await vi.waitFor(() => expect(original.observed.greetings).toBe(1))
    const current = f.manager.listProfiles()[0]!
    await f.manager.updateProfile(f.id, { network: { mode: 'proxy', server: `socks5://127.0.0.1:${replacement.port}` } }, current.revision)
    waiting.release()
    const result = await pending
    expect(result.diagnostic.authentication).toMatchObject({ status: 'unknown', reason: 'route-changed' }); expect(result.diagnostic.exit).toMatchObject({ status: 'unknown', reason: 'route-changed' })
    expect(result.diagnostic.webrtc).toEqual({ status: 'unknown', reason: 'route-changed', observedPages: 0 })
    expect(f.native.observeWebRtc).not.toHaveBeenCalled()
    expect(original.observed.authentications).toBe(0); expect(replacement.observed.connections).toBe(0); expect(f.checkExit).not.toHaveBeenCalled()
    expect(result.diagnostic.route).toMatchObject({ port: original.port }); expect(f.manager.proxyOf(f.id)).toMatchObject({ port: replacement.port })
  })

  it('retains pending progress after failed history writes and a new owner only inspects it', async () => {
    const endpoint = await proxy('socks5'), f = await fixture(endpoint), record = f.manager.recordNetworkDiagnostic.bind(f.manager)
    let writes = 0
    vi.spyOn(f.manager, 'recordNetworkDiagnostic').mockImplementation(async value => { if (++writes > 1) throw new Error(secret); await record(value) })
    const result = await f.network.probe(f.id, 'write-unconfirmed')
    expect(result).toMatchObject({ historySaved: false, diagnostic: { phase: 'observed', authentication: { status: 'authenticated' } } })
    const restored = new BrowserProfileManager(new BrowserProfileStore(f.path), f.native as never); await restored.initialize()
    const after = createBrowserProfileNetworkControl({ profiles: restored, proxyAuth: f.auth, checkExit: f.checkExit, checkAddress: () => 'https://exit.example', reconnect: async () => {} })
    expect(await after.probe(f.id, 'write-unconfirmed')).toMatchObject({ diagnostic: { id: 'write-unconfirmed', phase: 'pending', tcp: { status: 'unknown' } } })
    expect(endpoint.observed.connections).toBe(1); expect(endpoint.observed.authentications).toBe(1)
    expect(await f.network.checkExit(f.id)).toMatchObject({ status: 'reachable' }); expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('the credential owner refuses an old configuration token even when the proxy endpoint is unchanged', async () => {
    const f = await fixture(await proxy('socks5')), revision = f.manager.configurationRevision(f.id)!, endpoint = f.manager.proxyOf(f.id)!
    await f.manager.updateProfile(f.id, { notes: 'A newer confirmed configuration' }, revision)
    const consume = vi.fn(async () => true)
    await expect(f.auth.withProbeCredentials(f.id, { ...endpoint, configurationRevision: revision }, consume)).rejects.toThrow('no longer current')
    expect(consume).not.toHaveBeenCalled()
  })

  it('paginates without discarding original unfinished ids or invalidating a configuration draft', async () => {
    const f = await fixture(await proxy('http')), current = f.manager.listProfiles()[0]!
    for (let index = 0; index < 43; index++) await f.manager.recordNetworkDiagnostic({ id: `original-${index}`, profileId: f.id, configurationRevision: current.revision,
      route: { mode: 'proxy', scheme: 'http', host: '127.0.0.1', port: 1 }, exitOrigin: null, startedAt: index, phase: 'pending', tcp: { status: 'unknown', reason: 'not-started', latencyMs: 0 },
      authentication: { status: 'unknown', reason: 'not-started', latencyMs: 0 }, exit: { status: 'unknown', reason: 'not-started', latencyMs: 0 } })
    const first = await f.manager.networkHistory(f.id), second = await f.manager.networkHistory(f.id, undefined, first.nextCursor!), third = await f.manager.networkHistory(f.id, undefined, second.nextCursor!)
    expect([first.diagnostics.length, second.diagnostics.length, third.diagnostics.length]).toEqual([20, 20, 3]); expect(third.nextCursor).toBeNull()
    expect(new Set([...first.diagnostics, ...second.diagnostics, ...third.diagnostics].map(item => item.id)).size).toBe(43)
    expect((await f.manager.networkHistory(f.id, 'original-0')).diagnostics[0]?.phase).toBe('pending')
    expect(f.manager.listProfiles()[0]!.revision).toBe(current.revision)
    await expect(f.manager.recordNetworkDiagnostic({ ...first.diagnostics[0]!, profileId: 'wrong-owner' })).rejects.toThrow('immutable')
  }, 20_000)

  it('carries strict non-secret protocol facts and rejects wrong diagnostic identities', async () => {
    const f = await fixture(await proxy('http')), result = await f.network.probe(f.id, 'typed-original')
    expect(() => parseBrowserProxyProbe({ ...result.diagnostic, password: secret })).toThrow()
    expect(() => parseBrowserProfileControlPayload({ operation: 'browser.profile.network.probe', profileId: f.id, operationId: 'original', endpoint: 'another-proxy' }, ['operation'])).toThrow()
    expect(parseBrowserProfileControlResult('browser.profile.network.probe', { profileId: f.id, ...result })).toEqual({ profileId: f.id, ...result })
    expect(() => assertBrowserProfileControlTarget({ operation: 'browser.profile.network.probe', profileId: f.id, operationId: 'different' },
      { operation: 'browser.profile.network.probe', profileId: f.id, ...result })).toThrow()
  })

  it('runs the compiled CLI through original public RPC/Main/Profile owners against a real SOCKS server', async () => {
    const endpoint = await proxy('socks5'), f = await fixture(endpoint)
    const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [], execute: async (request, context) => {
      if (!isBrowserProfileControlRequest(request)) throw new Error('Unexpected operation')
      return await executeBrowserProfileControl(request, { profiles: f.manager, network: f.network, usage: {} as never }, context?.actor)
    } })
    await server.start()
    try {
      const env = objectCliEnvironment(f.root, { NODE_NO_WARNINGS: '1' })
      const run = async (args: string[]) => { const reply = await runCompiledObjectCli(['browser', 'profile', 'network', ...args], env); expect(reply.code, reply.stderr).toBe(0); return JSON.parse(reply.stdout).result }
      const observed = await run(['probe', '--profile', f.id, '--operation-id', 'cli-original'])
      expect(observed.diagnostic.authentication.status).toBe('authenticated'); expect(endpoint.observed.matched).toBe(1)
      expect((await run(['history', '--profile', f.id, '--operation-id', 'cli-original'])).diagnostics).toEqual([observed.diagnostic])
      await run(['probe', '--profile', f.id, '--operation-id', 'cli-original']); expect(endpoint.observed.connections).toBe(1)
      const help = await runCompiledObjectCli(['browser', 'profile', 'network', 'probe', '--help'], env)
      expect(help.stdout).toContain('do not certify Chromium business traffic')
    } finally { await server.stop() }
  }, 30_000)
})
