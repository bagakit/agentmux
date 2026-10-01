import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { DeviceAuthority } from '../src/device-authority.js'
import { PrivateAccess, type PrivateAccessAuthorization } from '../src/private-access.js'
import { preparePrivateCertificates } from '../src/private-certificates.js'
import { readPrivateTls } from '../src/private-tls.js'

let directory: string, material: Awaited<ReturnType<typeof preparePrivateCertificates>>, ca: Buffer
let counter = 0
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agentmux-private-access-'))
  material = await preparePrivateCertificates(join(directory, 'certificates'), '127.0.0.1')
  ca = await readFile(join(material.directory, 'issuer.pem'))
})
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

async function fixture() {
  let now = Date.now(), access!: PrivateAccess
  const authority = await DeviceAuthority.open(join(directory, `devices-${++counter}.json`), () => now)
  const live = new Map<string, Set<PrivateAccessAuthorization>>()
  const tls = await readPrivateTls({ host: '127.0.0.1', port: 7443,
    keyPath: material.keyPath, certificatePath: material.certificatePath })
  // This actual TLS fixture consumes only admission hooks. It deliberately contains no RPC,
  // semantic Host or Run and cannot prove the not-yet-delivered public transport integration.
  const server = createServer(tls.tls, (request, response) => {
    const webRequest = new Request(`https://${request.headers.host}${request.url}`, {
      method: request.method, headers: request.headers as Record<string, string>,
      ...(request.method === 'GET' ? {} : { body: Readable.toWeb(request) as ReadableStream, duplex: 'half' })
    } as RequestInit)
    void access.route(webRequest).then(async handled => {
      if (handled) {
        const headers = Object.fromEntries(handled.headers)
        delete headers['set-cookie']
        response.writeHead(handled.status, { ...headers, ...(handled.headers.has('set-cookie')
          ? { 'set-cookie': handled.headers.getSetCookie() } : {}) })
        response.end(await handled.text()); return
      }
      if (request.url !== '/fixture-reader') { response.writeHead(404); response.end(); return }
      try {
        const auth = access.authorize(webRequest)
        if (!auth) { response.writeHead(401); response.end(); return }
        const deviceId = auth.principal.id.slice(authority.hostId.length + 1)
        let readers = live.get(deviceId)
        if (!readers) { readers = new Set(); live.set(deviceId, readers) }
        readers.add(auth)
        const close = () => { auth.signal.removeEventListener('abort', abort); readers.delete(auth); auth.dispose() }
        const abort = () => response.destroy()
        auth.signal.addEventListener('abort', abort, { once: true })
        response.once('close', close)
        response.writeHead(200, { 'Content-Type': 'text/plain' })
        response.write(JSON.stringify(auth.principal))
      } catch { response.writeHead(401); response.end() }
    }).catch(error => response.destroy(error))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TLS listener has no address')
  const origin = `https://127.0.0.1:${address.port}`
  access = new PrivateAccess(authority, { ...tls, port: address.port, origin })
  const send = (path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}, trusted = true, withOrigin = true) =>
    new Promise<{ status: number; value: any; cookies: string[] }>((resolve, reject) => {
      const request = httpsRequest(`${origin}${path}`, { method, ...(trusted ? { ca } : {}),
        headers: { ...(method === 'GET' || headers['X-AgentMux-Transport'] === 'native' || !withOrigin ? {} : { Origin: origin }),
          ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, response => {
        const chunks: Buffer[] = []
        response.on('data', value => chunks.push(value))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString()
          resolve({ status: response.statusCode!, value: text ? JSON.parse(text) : null, cookies: response.headers['set-cookie'] ?? [] })
        })
      })
      request.on('error', reject)
      request.end(data === undefined ? undefined : JSON.stringify(data))
    })
  const begin = async (name = 'Phone') => {
    const invitation = authority.invite()
    const result = await send('/_agentmux/device', 'POST', { hostId: authority.hostId, invitation: invitation.invitation, name })
    expect(result.status).toBe(201)
    return { invitation, pending: result.value, pairCookie: result.cookies[0]!.split(';')[0]! }
  }
  const approve = async (name: string) => {
    const pending = await begin(name)
    await authority.approve(pending.pending.deviceId, pending.pending.confirmationCode)
    const result = await send('/_agentmux/device/claim', 'POST', { hostId: authority.hostId }, { Cookie: pending.pairCookie })
    expect(result.status).toBe(200)
    return { ...pending, result, deviceCookie: result.cookies[0]!.split(';')[0]! }
  }
  const reader = (cookie: string) => new Promise<{ response: IncomingMessage; principal: unknown; closed: Promise<void>; dispose(): void }>((resolve, reject) => {
    const request = httpsRequest(`${origin}/fixture-reader`, { method: 'POST', ca, headers: { Origin: origin, Cookie: cookie } }, response => {
      const closed = new Promise<void>(resolveClose => response.once('close', resolveClose))
      response.once('data', value => resolve({ response, principal: JSON.parse(value.toString()), closed,
        dispose: () => { response.destroy(); request.destroy() } }))
      response.on('error', () => {})
    })
    request.on('error', reject); request.end()
  })
  return { access, authority, origin, live, send, begin, approve, reader, advance: (ms: number) => { now += ms },
    async dispose() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

it('uses actual verified HTTPS and refuses unknown trust or unapproved business access', async () => {
  const f = await fixture()
  try {
    expect(await f.send('/_agentmux/device')).toMatchObject({ status: 200, value: { hostId: f.authority.hostId } })
    await expect(f.send('/_agentmux/device', 'GET', undefined, {}, false)).rejects.toMatchObject({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
    expect((await f.send('/_agentmux/device/status')).status).toBe(401)
    expect((await f.send('/fixture-reader', 'POST')).status).toBe(401)
    expect(f.authority.devices()).toEqual([])
  } finally { await f.dispose() }
})

it('requires the actual local code, issues only HttpOnly secrets and consumes claim once', async () => {
  const f = await fixture()
  try {
    const pending = await f.begin('iPhone')
    expect(Object.keys(pending.pending).sort()).toEqual(['confirmationCode', 'deviceId', 'expiresAt', 'hostId', 'state'])
    expect(pending.pairCookie).toMatch(/^__Host-agentmux-pair=/u)
    expect(await f.send('/_agentmux/device/claim', 'POST', { hostId: f.authority.hostId }, { Cookie: pending.pairCookie })).toMatchObject({ status: 202, value: { state: 'waiting' } })
    await expect(f.authority.approve(pending.pending.deviceId, 'wrong-code')).rejects.toThrow()
    expect((await f.send('/_agentmux/device/approve', 'POST', {})).status).toBe(404)
    await f.authority.approve(pending.pending.deviceId, pending.pending.confirmationCode)
    const granted = await f.send('/_agentmux/device/claim', 'POST', { hostId: f.authority.hostId }, { Cookie: pending.pairCookie })
    expect(Object.keys(granted.value).sort()).toEqual(['device', 'hostId', 'state'])
    expect(granted.value).toMatchObject({ state: 'approved', hostId: f.authority.hostId, device: { name: 'iPhone' } })
    expect(granted.cookies).toHaveLength(2)
    for (const header of granted.cookies) {
      expect(header).toContain('; Secure; HttpOnly; SameSite=Strict;')
      expect(header).toContain('; Path=/;')
      expect(header).not.toContain('Domain=')
    }
    expect(granted.cookies[1]).toContain('Max-Age=0')
    expect((await f.send('/_agentmux/device/claim', 'POST', { hostId: f.authority.hostId }, { Cookie: pending.pairCookie })).status).toBe(401)
    expect((await f.send('/_agentmux/device/status', 'GET', undefined, { Cookie: granted.cookies[0]!.split(';')[0]! })).value.device.deviceId).toBe(pending.pending.deviceId)
  } finally { await f.dispose() }
})

it('rejects cross-origin, missing Origin, forged Host and ambiguous credential cookies', async () => {
  const f = await fixture()
  try {
    const approved = await f.approve('iPhone')
    for (const headers of [{ Origin: 'https://other.example' }, { Origin: '' }, { Host: '192.168.99.1' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      expect((await f.send('/fixture-reader', 'POST', {}, { Cookie: approved.deviceCookie, ...headers })).status).toBe(401)
    }
    const missingOriginInvite = f.authority.invite()
    expect((await f.send('/_agentmux/device', 'POST', { hostId: f.authority.hostId,
      invitation: missingOriginInvite.invitation, name: 'No Origin' }, {}, true, false)).status).toBe(401)
    expect((await f.send('/_agentmux/device/status', 'GET', undefined, { Cookie: `${approved.deviceCookie}; ${approved.deviceCookie}` })).status).toBe(401)
    const wrongHost = approved.deviceCookie.replace(f.authority.hostId, 'other-host')
    expect((await f.send('/_agentmux/device/status', 'GET', undefined, { Cookie: wrongHost })).status).toBe(401)
    expect(f.authority.devices()).toHaveLength(1)
    expect(f.live.size).toBe(0)
  } finally { await f.dispose() }
})

it('rejects expired/replayed invitations, rejected approval and caller fields without manufacturing authorization', async () => {
  const f = await fixture()
  try {
    const expired = f.authority.invite(); f.advance(5 * 60_000)
    expect((await f.send('/_agentmux/device', 'POST', { hostId: expired.hostId, invitation: expired.invitation, name: 'Expired' })).status).toBe(401)
    const pending = await f.begin('Denied')
    expect((await f.send('/_agentmux/device', 'POST', { hostId: pending.invitation.hostId, invitation: pending.invitation.invitation, name: 'Replay' })).status).toBe(401)
    f.authority.reject(pending.pending.deviceId)
    expect((await f.send('/_agentmux/device/claim', 'POST', { hostId: f.authority.hostId }, { Cookie: pending.pairCookie })).status).toBe(401)
    const fresh = f.authority.invite()
    expect((await f.send('/_agentmux/device', 'POST', { hostId: fresh.hostId, invitation: fresh.invitation, name: 'Spoof', caller: { kind: 'human' } })).status).toBe(400)
    expect(f.authority.devices()).toEqual([])
  } finally { await f.dispose() }
})

it('aborts actual connected device readers on durable revoke and preserves the other live device', async () => {
  const f = await fixture()
  try {
    const first = await f.approve('iPhone'), second = await f.approve('Android')
    const a = await f.reader(first.deviceCookie), b = await f.reader(first.deviceCookie), other = await f.reader(second.deviceCookie)
    expect(a.principal).toEqual({ kind: 'device', id: `${f.authority.hostId}:${first.pending.deviceId}` })
    expect([...f.live.get(first.pending.deviceId)!]).toHaveLength(2)
    const request = new Request(`${f.origin}/`, { method: 'POST', headers: {
      Host: new URL(f.origin).host, Origin: f.origin, Cookie: first.deviceCookie } })
    const bounded = Array.from({ length: 126 }, () => f.access.authorize(request)!)
    expect(() => f.access.authorize(request)).toThrow('too many continuing requests')
    expect((await f.send('/_agentmux/device/status', 'GET', undefined, { Cookie: first.deviceCookie })).status).toBe(200)
    const otherAuthorization = [...f.live.get(second.pending.deviceId)!][0]!
    await f.authority.revoke(first.pending.deviceId)
    await Promise.all([a.closed, b.closed])
    expect(bounded.every(value => value.signal.aborted)).toBe(true)
    for (const value of bounded) value.dispose()
    expect(otherAuthorization.signal.aborted).toBe(false)
    expect(other.response.destroyed).toBe(false)
    expect([...f.live.get(first.pending.deviceId)!]).toEqual([])
    expect((await f.send('/fixture-reader', 'POST', {}, { Cookie: first.deviceCookie })).status).toBe(401)
    expect((await f.send('/_agentmux/device/status', 'GET', undefined, { Cookie: second.deviceCookie })).status).toBe(200)
    other.dispose(); await other.closed
  } finally { await f.dispose() }
})

it('shares the original device Authority with a native-only secret exchange and refuses browser or Bearer impersonation', async () => {
  const f = await fixture(), native = { 'X-AgentMux-Transport': 'native' }
  try {
    const invitation = f.authority.invite()
    const input = { hostId: f.authority.hostId, invitation: invitation.invitation, name: 'Native iPhone' }
    for (const headers of [{ ...native, Origin: f.origin }, { ...native, 'Sec-Fetch-Site': 'same-origin' },
      { ...native, Cookie: 'cookie=value' }]) {
      expect((await f.send('/_agentmux/device', 'POST', input, headers)).status).toBe(401)
    }
    const pending = await f.send('/_agentmux/device', 'POST', input, native)
    expect(pending.status).toBe(201)
    expect(pending.cookies).toEqual([])
    expect(pending.value.claim).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    const claim = { hostId: f.authority.hostId, deviceId: pending.value.deviceId, claim: pending.value.claim }
    expect((await f.send('/_agentmux/device/claim', 'POST', claim, native)).status).toBe(202)
    await f.authority.approve(pending.value.deviceId, pending.value.confirmationCode)
    const approved = await f.send('/_agentmux/device/claim', 'POST', claim, native)
    expect(approved.status).toBe(200)
    expect(approved.cookies).toEqual([])
    expect(approved.value.credential).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect((await f.send('/_agentmux/device/claim', 'POST', claim, native)).status).toBe(401)
    const authorization = `AgentMuxDevice ${f.authority.hostId}.${approved.value.credential}`
    expect((await f.send('/_agentmux/device/status', 'GET', undefined, { ...native, Authorization: authorization })).value.device)
      .toEqual(approved.value.device)
    expect((await f.send('/_agentmux/device/status', 'GET', undefined, { ...native, Authorization: `Bearer ${approved.value.credential}` })).status).toBe(401)
    expect((await f.send('/_agentmux/device/status', 'GET', undefined, { Authorization: authorization })).status).toBe(401)
    const request = new Request(`${f.origin}/`, { method: 'POST', headers: { ...native,
      Host: new URL(f.origin).host, Authorization: authorization } })
    const auth = f.access.authorize(request)
    expect(auth?.principal).toEqual({ kind: 'device', id: `${f.authority.hostId}:${approved.value.device.deviceId}` })
    await f.authority.revoke(approved.value.device.deviceId)
    expect(auth?.signal.aborted).toBe(true)
    expect(f.access.authorize(request)).toBeNull()
    auth?.dispose()
  } finally { await f.dispose() }
})
