import { createServer, request, Agent, type IncomingMessage, type ServerResponse } from 'node:http'
import { Socket, isIP } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Session } from 'electron'
import { net } from 'electron'
import type { BrowserProfileNetwork } from '../shared/browser-profile-network.js'
import type { BrowserProfileProxyAuth } from './browser-profile-proxy-auth.js'

type Route = Extract<BrowserProfileNetwork, { mode: 'proxy' }>
export type BrowserProfileSocksCredentialPort = Pick<BrowserProfileProxyAuth, 'withProbeCredentials' | 'hasTransportCredentials'> & Partial<Pick<BrowserProfileProxyAuth, 'transportIssue'>>
export type BrowserProfileSocksTransportPorts = {
  network(profileId: string): BrowserProfileNetwork | undefined
  revision(profileId: string): string | null
  credentials: BrowserProfileSocksCredentialPort
}
class TransportUnavailable extends Error { constructor() { super('The original Profile SOCKS TCP request could not be completed. Its route and page data remain.') } }
const same = (a: BrowserProfileNetwork | undefined, b: Route) => a?.mode === 'proxy' && JSON.stringify(a.server) === JSON.stringify(b.server)
const unavailable = (): never => { throw new TransportUnavailable() }
function socketReader(socket: Socket) {
  let bytes = Buffer.alloc(0), failure: Error | undefined, waiting: { size: number; resolve(bytes: Buffer): void; reject(error: Error): void } | undefined
  const flush = () => { if (!waiting) return; if (failure) { const next = waiting; waiting = undefined; next.reject(failure) } else if (bytes.length >= waiting.size) { const next = waiting; waiting = undefined; const value = bytes.subarray(0, next.size); bytes = bytes.subarray(next.size); next.resolve(value) } }
  const fail = () => { failure ??= new TransportUnavailable(); flush() }
  const data = (part: Buffer) => { bytes = Buffer.concat([bytes, part]); if (bytes.length > 4096) { fail(); socket.destroy() } else flush() }
  socket.on('data', data); socket.on('error', fail); socket.on('end', fail); socket.on('close', fail); socket.setTimeout(5000, () => { fail(); socket.destroy() })
  return {
    read(size: number): Promise<Buffer> { return new Promise((resolve, reject) => { waiting = { size, resolve, reject }; flush() }) },
    release() { socket.setTimeout(0); socket.off('data', data); socket.off('error', fail); socket.off('end', fail); socket.off('close', fail); if (bytes.length) socket.unshift(bytes) }
  }
}
function address(host: string, port: number): Buffer {
  const value = host.replace(/^\[|\]$/gu, ''), kind = isIP(value)
  let result: Buffer
  if (kind === 4) result = Buffer.from([1, ...value.split('.').map(Number)])
  else if (kind === 6) {
    const normalized = value.replace(/\d+\.\d+\.\d+\.\d+$/u, part => { const n = part.split('.').map(Number); return ((n[0]! << 8) | n[1]!).toString(16) + ':' + ((n[2]! << 8) | n[3]!).toString(16) })
    const [left, right] = normalized.split('::'), head = left ? left.split(':') : [], tail = right ? right.split(':') : []
    const groups = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
    result = Buffer.alloc(17); result[0] = 4; groups.forEach((group, index) => result.writeUInt16BE(parseInt(group, 16), 1 + index * 2))
  } else { const name = Buffer.from(value); if (!name.length || name.length > 255) return unavailable(); result = Buffer.concat([Buffer.from([3, name.length]), name]) }
  const suffix = Buffer.alloc(2); suffix.writeUInt16BE(port); return Buffer.concat([result, suffix])
}
function endpoint(value: string, connect = false): { host: string; port: number; path: string } {
  const url = new URL(connect ? 'http://' + value : value), authority = connect ? /^(?:\[[^\]]+\]|[^:]+):(\d{1,5})$/u.exec(value) : null
  if (url.username || url.password || url.hash || !['http:', 'ws:'].includes(url.protocol) || connect && (url.pathname !== '/' || url.search || !authority || Number(authority[1]) < 1 || Number(authority[1]) > 65535)) return unavailable()
  return { host: url.hostname, port: Number(connect ? authority![1] : url.port || 80), path: url.pathname + url.search }
}
function headers(input: IncomingMessage['headers']) { const output = { ...input }; delete output['proxy-authorization']; delete output['proxy-connection'];  return output }

/** Volatile sockets/capabilities only. Original Profile metadata and encrypted credentials remain their sole owners. */
export function createBrowserProfileSocksTransport(ports: BrowserProfileSocksTransportPorts) {
  type Context = { profileId: string; session: Session; route: Route; port: number; token: string; authorization: Buffer; active: boolean; server: ReturnType<typeof createServer>; agent: Agent; sockets: Set<Socket> }
  const contexts = new Map<Session, Context>()
  const current = (context: Context) => context.active && contexts.get(context.session) === context && same(ports.network(context.profileId), context.route)
  const tracked = (context: Context, socket: Socket) => { context.sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => context.sockets.delete(socket)); return socket }
  async function open(context: Context, host: string, port: number): Promise<Socket> {
    if (!current(context)) return unavailable()
    const revision = ports.revision(context.profileId); if (!revision) return unavailable()
    const target = context.route.server, socket = tracked(context, new Socket()), reader = socketReader(socket)
    const stillCurrent = () => current(context) && ports.revision(context.profileId) === revision
    try {
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); socket.once('close', () => reject(new TransportUnavailable())); socket.connect(target.port, target.host.replace(/^\[|\]$/gu, '')) })
      socket.write(Buffer.from([5, 2, 0, 2])); const method = await reader.read(2)
      if (method[0] !== 5) return unavailable()
      if (method[1] === 2) await ports.credentials.withProbeCredentials(context.profileId, { host: target.host, port: target.port, configurationRevision: revision }, async credential => {
        if (!stillCurrent()) return unavailable()
        const user = Buffer.from(credential.username), password = Buffer.from(credential.password)
        if (!user.length || user.length > 255 || !password.length || password.length > 255) return unavailable()
        socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]))
        const accepted = await reader.read(2)
        if (accepted[0] !== 1 || accepted[1] !== 0) { ports.credentials.transportIssue?.(context.profileId, { ...target, configurationRevision: revision }, 'The SOCKS proxy refused this Profile’s sign-in. Update it before retrying the request.'); return unavailable() }
        ports.credentials.transportIssue?.(context.profileId, { ...target, configurationRevision: revision }, null)
      })
      else if (method[1] !== 0) return unavailable()
      if (!stillCurrent()) return unavailable()
      socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address(host, port)]))
      const reply = await reader.read(4); if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) return unavailable()
      if (reply[3] === 1) await reader.read(6); else if (reply[3] === 4) await reader.read(18); else if (reply[3] === 3) await reader.read((await reader.read(1))[0]! + 2); else return unavailable()
      if (!stillCurrent()) return unavailable()
      return socket
    } catch { socket.destroy(); return unavailable() }
    finally { reader.release() }
  }
  function close(context: Context) { context.active = false; context.agent.destroy(); for (const socket of context.sockets) socket.destroy(); context.server.close() }
  const authorized = (context: Context, request: IncomingMessage) => { const value = Buffer.from(request.headers['proxy-authorization'] ?? ''); return context.active && value.length === context.authorization.length && timingSafeEqual(value, context.authorization) }
  const challenge = (response: ServerResponse) => { response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Profile TCP transport"' }); response.end() }
  async function create(profileId: string, session: Session, route: Route): Promise<Context> {
    const token = randomBytes(32).toString('hex'), capability = 'profile:' + token
    const context = { profileId, session, route: structuredClone(route), token, authorization: Buffer.from('Basic ' + Buffer.from(capability).toString('base64')), active: true, port: 0,
      server: createServer(), agent: new Agent({ keepAlive: false }), sockets: new Set<Socket>() }
    context.agent.createConnection = ((options: { host: string; port: number }, callback: (error: Error | null, socket?: Socket) => void) => { void open(context, options.host, Number(options.port)).then(socket => callback(null, socket), () => callback(new TransportUnavailable())); return undefined }) as typeof context.agent.createConnection
    context.server.on('connection', socket => tracked(context, socket))
    context.server.on('request', (request_, response) => {
      if (!authorized(context, request_)) return challenge(response)
      try {
        const to = endpoint(request_.url ?? ''), upstream = request({ host: to.host, port: to.port, path: to.path, method: request_.method, headers: headers(request_.headers), agent: context.agent }, reply => { response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response) })
        upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() }); request_.on('aborted', () => upstream.destroy()); request_.pipe(upstream)
      } catch { response.writeHead(502); response.end() }
    })
    context.server.on('connect', (request_, client, head) => {
      if (!authorized(context, request_)) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Profile TCP transport"\r\nContent-Length: 0\r\n\r\n'); return }
      void (async () => {
        try { const to = endpoint(request_.url ?? '', true), upstream = await open(context, to.host, to.port); client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy()) }
        catch { client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n') }
      })()
    })
    context.server.on('upgrade', (request_, client, head) => {
      if (!authorized(context, request_)) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Profile TCP transport"\r\nContent-Length: 0\r\n\r\n'); return }
      void (async () => { try { const to = endpoint(request_.url ?? ''), upstream = await open(context, to.host, to.port), fields = headers(request_.headers); upstream.write(`${request_.method} ${to.path} HTTP/${request_.httpVersion}\r\n${Object.entries(fields).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => name + ': ' + item)).join('\r\n')}\r\n\r\n`); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy()) } catch { client.destroy() } })()
    })
    await new Promise<void>((resolve, reject) => { context.server.once('error', reject); context.server.listen(0, '127.0.0.1', resolve) }); const bound = context.server.address(); if (!bound || typeof bound === 'string') return unavailable(); context.port = bound.port
    return context
  }
  return {
    async route(profileId: string, session: Session, network: BrowserProfileNetwork | undefined) {
      const previous = contexts.get(session)
      if (network?.mode !== 'proxy' || network.server.scheme !== 'socks5') return null
      const credential = await ports.credentials.hasTransportCredentials(profileId, network.server)
      // Unknown observation cannot retire an existing accurate adapter or its healthy connections.
      if (credential === undefined && previous?.active && same(previous.route, network)) return { proxyRules: `http://127.0.0.1:${previous.port}`, context: previous, retainExisting: true }
      if (credential !== true) return null
      if (previous?.active && same(previous.route, network)) return { proxyRules: `http://127.0.0.1:${previous.port}`, context: previous }
      const next = await create(profileId, session, network)
      // The old adapter remains live until the original Session acknowledges its replacement route.
      return { proxyRules: `http://127.0.0.1:${next.port}`, context: next }
    },
    applied(session: Session, route: { context: Context } | null) { const previous = contexts.get(session); if (route) contexts.set(session, route.context); else contexts.delete(session); if (previous && previous !== route?.context) close(previous) },
    discard(session: Session, route: { context: Context } | null) { if (route && contexts.get(session) !== route.context) close(route.context) },
    answer(session: Session, auth: { isProxy: boolean; host: string; port: number }, callback: (username?: string, password?: string) => void): boolean {
      const context = contexts.get(session)
      if (!context?.active || !auth.isProxy || auth.host !== '127.0.0.1' || auth.port !== context.port) return false
      callback('profile', context.token); return true
    },
    /** Native request login carries the exact Session; no preparatory request or private header reaches a site. */
    async fetch(session: Session, url: string, signal?: AbortSignal): Promise<Response> {
      signal?.throwIfAborted()
      if (!contexts.has(session)) return session.fetch(url, { method: 'GET', cache: 'no-store', redirect: 'follow', ...(signal ? { signal } : {}) })
      return await new Promise<Response>((resolve, reject) => {
        const native = net.request({ session, url, method: 'GET', credentials: 'include', useSessionCookies: true, redirect: 'follow' })
        let stream: ReadableStreamDefaultController<Uint8Array> | undefined, ended = false
        const abort = () => { native.abort(); if (!ended) { ended = true; const error = signal?.reason ?? new TransportUnavailable(); stream?.error(error); reject(error) } }
        if (signal?.aborted) { abort(); return }
        signal?.addEventListener('abort', abort, { once: true })
        native.on('login', (auth, answer) => { if (!this.answer(session, auth, answer)) answer() })
        native.on('error', () => { signal?.removeEventListener('abort', abort); if (!ended) { ended = true; const error = new TransportUnavailable(); stream?.error(error); reject(error) } })
        native.on('response', response => {
          const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller }, cancel() { abort() } })
          response.on('data', (chunk: Buffer) => { if (!ended) stream?.enqueue(new Uint8Array(chunk)) })
          response.on('end', () => { signal?.removeEventListener('abort', abort); if (!ended) { ended = true; stream?.close() } })
          response.on('error', () => { signal?.removeEventListener('abort', abort); if (!ended) { ended = true; stream?.error(new TransportUnavailable()) } })
          const fields = Object.entries(response.headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).filter((value): value is string => typeof value === 'string').map(value => [key, value] as [string, string]))
          try { resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : body, { status: response.statusCode, headers: fields })) }
          catch {
            signal?.removeEventListener('abort', abort)
            if (!ended) { ended = true; const error = new TransportUnavailable(); stream?.error(error); native.abort(); reject(error) }
          }
        }); native.end()
      })
    },
    dispose() { for (const context of contexts.values()) close(context); contexts.clear() }
  }
}
