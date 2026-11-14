import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { createServer as tcpServer, connect, type Server as TcpServer, type Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { net, type Session } from 'electron'
vi.mock('electron', () => ({ net: { request: vi.fn() } }))
import { createBrowserProfileSocksTransport } from '../src/main/browser-profile-socks-transport.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function listen(server: Server | TcpServer) { await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); return (server.address() as { port: number }).port }
async function fixture() {
 const sockets = new Set<Socket>(), observed = { authentication: 0, requests: [] as { path: string; cookie?: string; proxyAuthorization?: string }[], issues: [] as (string | null)[] }
 const target = createServer((req, res) => { observed.requests.push({ path: req.url!, ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}), ...(req.headers['proxy-authorization'] ? { proxyAuthorization: req.headers['proxy-authorization'] } : {}) }); res.end('native transport payload') })
 const port = await listen(target)
 let refuse = false, beforeCredential: (() => Promise<void>) | undefined, credentialPresent: boolean | undefined = true, revision = 'exact-config-one'
 const proxy = tcpServer(socket => {
  sockets.add(socket);socket.on('error', () => {});socket.once('close', () => sockets.delete(socket))
  let bytes = Buffer.alloc(0), phase = 'greeting'
  socket.on('data', part => { bytes = Buffer.concat([bytes, part]); for (;;) {
   if (phase === 'greeting') { if (bytes.length < 2 || bytes.length < 2 + bytes[1]!) return; expect([...bytes.subarray(2, 2 + bytes[1]!)]).toContain(2); bytes = bytes.subarray(2 + bytes[1]!); socket.write(Buffer.from([5, 2])); phase = 'authentication' }
   else if (phase === 'authentication') {
    if (bytes.length < 2 || bytes.length < 3 + bytes[1]! || bytes.length < 3 + bytes[1]! + bytes[2 + bytes[1]!]!) return
    observed.authentication++; const n = bytes[1]!, m = bytes[2 + n]!, accepted = !refuse && bytes.subarray(2, 2 + n).toString() === 'private-profile-user' && bytes.subarray(3 + n, 3 + n + m).toString() === 'private-profile-password'
    bytes = bytes.subarray(3 + n + m);socket.write(Buffer.from([1, accepted ? 0 : 1]));phase = accepted ? 'request' : 'done'
   } else if (phase === 'request') {
    if (bytes.length < 5) return; const address = bytes[3] === 1 ? 4 : bytes[3] === 3 ? bytes[4]! + 1 : 16, length = 4 + address + 2
    if (bytes.length < length) return; expect(bytes[1]).toBe(1);expect(bytes.readUInt16BE(length - 2)).toBe(port);bytes = bytes.subarray(length);phase = 'pipe'
    const upstream = connect(port, '127.0.0.1', () => { socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));if(bytes.length)upstream.write(bytes);socket.pipe(upstream);upstream.pipe(socket) })
    sockets.add(upstream);upstream.on('error', () => socket.destroy());upstream.once('close', () => sockets.delete(upstream));socket.once('close', () => upstream.destroy());socket.removeAllListeners('data');return
   } else return
  } })
 })
 const proxyPort = await listen(proxy), route = { mode: 'proxy' as const, server: { scheme: 'socks5' as const, host: '127.0.0.1', port: proxyPort } }, session = {} as Session
 const transport = createBrowserProfileSocksTransport({ network: () => route, revision: () => revision, credentials: {
  hasTransportCredentials: async () => credentialPresent,
  withProbeCredentials: async (_id, expected, use) => { await beforeCredential?.();expect(expected.host).toBe('127.0.0.1');expect(expected.port).toBe(proxyPort);return use({ username: 'private-profile-user', password: 'private-profile-password' }) },
  transportIssue: (_id, _expected, reason) => { observed.issues.push(reason) }
 } })
 const selected = await transport.route('original-profile', session, route);expect(selected).not.toBeNull();transport.applied(session, selected)
 const localPort = Number(new URL(selected!.proxyRules).port)
 let authorization = ''
 expect(transport.answer(session, { isProxy: true, host: '127.0.0.1', port: localPort }, (user, password) => { authorization = 'Basic ' + Buffer.from(user + ':' + password).toString('base64') })).toBe(true)
 const call = (capability = authorization) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: localPort, path: `http://127.0.0.1:${port}/original-target`, agent: false, headers: { 'Proxy-Authorization': capability, Cookie: 'original_site=retained' } }, res => { let body = '';res.on('data', chunk => { body += chunk });res.on('end', () => resolve({ status: res.statusCode!, body })) });req.on('error', reject);req.end()
 })
 cleanup.push(async () => { transport.dispose();for(const socket of sockets)socket.destroy();await Promise.all([target, proxy].map(server => new Promise<void>(done => server.close(() => done())))) })
 return { transport, selected, session, route, localPort, observed, call, refuse: () => { refuse = true }, unknown: () => { credentialPresent = undefined }, clear: () => { credentialPresent = false }, duringCredential: (work: () => Promise<void>) => { beforeCredential = work }, changeRevision: () => { revision = 'exact-config-two' } }
}

describe('Authenticated SOCKS TCP slice; UDP/QUIC acceptance remains separate', () => {
 it('forwards actual HTTP bytes through RFC1929 and CMD1 without forwarding its local capability', async () => {
  const f = await fixture(), result = await f.call()
  expect(result).toEqual({ status: 200, body: 'native transport payload' });expect(f.observed.authentication).toBe(1)
  expect(f.observed.requests).toEqual([{ path: '/original-target', cookie: 'original_site=retained' }])
 })
 it('keeps arbitrary local requests and another Session outside the exact Profile capability', async () => {
  const f = await fixture();expect(await f.call('Basic unrelated')).toMatchObject({ status: 407 });expect(f.observed.authentication).toBe(0)
  const answer = vi.fn();expect(f.transport.answer({} as Session, { isProxy: true, host: '127.0.0.1', port: f.localPort }, answer)).toBe(false);expect(answer).not.toHaveBeenCalled()
 })
 it('reports a real authentication rejection without forwarding a site request', async () => {
  const f = await fixture();f.refuse();expect(await f.call()).toMatchObject({ status: 502 });expect(f.observed.requests).toEqual([]);expect(f.observed.issues).toContain('The SOCKS proxy refused this Profile’s sign-in. Update it before retrying the request.')
 })
 it('rechecks the original configuration after awaiting credentials and before sending their bytes', async () => {
  const f = await fixture();f.duringCredential(async () => { f.changeRevision() });expect(await f.call()).toMatchObject({ status: 502 });expect(f.observed.authentication).toBe(0);expect(f.observed.requests).toEqual([])
 })
 it('contains an incompatible upstream HTTP status at the native response boundary', async () => {
  const f = await fixture(), native = Object.assign(new EventEmitter(), { end() {}, abort() {} })
  vi.mocked(net.request).mockReturnValueOnce(native as any)
  const result = f.transport.fetch(f.session, 'http://target.invalid/exit')
  const response = Object.assign(new EventEmitter(), { statusCode: 600, headers: {} })
  expect(() => native.emit('response', response)).not.toThrow()
  await expect(result).rejects.toThrow('original Profile SOCKS TCP request')
 })
 it('does not allocate a native request after its original reader was already canceled', async () => {
  const f = await fixture(), native = Object.assign(new EventEmitter(), { end() {}, abort() {} })
  const calls = vi.mocked(net.request).mock.calls.length
  vi.mocked(net.request).mockReturnValueOnce(native as any)
  const controller = new AbortController(); controller.abort(new Error('original reader canceled'))
  await expect(f.transport.fetch(f.session, 'http://target.invalid/exit', controller.signal)).rejects.toThrow('original reader canceled')
  expect(vi.mocked(net.request).mock.calls).toHaveLength(calls)
  vi.mocked(net.request).mockReset()
 })
 it('retains its accurate adapter when credential observation becomes unknown, then switches only for confirmed absence', async () => {
  const f = await fixture();expect(await f.call()).toMatchObject({ status: 200 });f.unknown()
  const unknown = await f.transport.route('original-profile', f.session, f.route);expect(unknown).toMatchObject({ proxyRules: f.selected!.proxyRules, retainExisting: true });f.transport.applied(f.session, unknown)
  expect(await f.call()).toMatchObject({ status: 200 });f.clear();expect(await f.transport.route('original-profile', f.session, f.route)).toBeNull()
 })
})
