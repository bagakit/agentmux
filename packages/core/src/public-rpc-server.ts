import { timingSafeEqual } from 'node:crypto'
import { mkdir, chmod, lstat, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createJSONRPCErrorResponse } from 'json-rpc-2.0'
import { AgentMuxError } from './errors.js'
import { AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS } from './control.js'
import { defaultAgentMuxControlSocketPath } from './runtime-paths.js'
import { probeSocketLiveness } from './socket-liveness.js'
import { AgentMuxRpcService, type AgentMuxRpcServiceOptions } from './public-rpc-service.js'
import { AgentMuxRpcDispatcher, AgentMuxRpcLines, rpcEncode, AGENTMUX_RPC_MAX_MESSAGE_BYTES,
  type AgentMuxRpcFrame, type AgentMuxRpcConnection } from './public-rpc-wire.js'
import type { AgentMuxRpcStreamMethod, AgentMuxRpcPrincipal } from './public-rpc.js'

export type AgentMuxRpcHttpAuthorization = {
  principal: AgentMuxRpcPrincipal;
  /** Original device authority can revoke this request/Reader. */
  signal?: AbortSignal;
  dispose?(): void | Promise<void>
}
export type AgentMuxRpcHttpOptions = {
  host: string; port: number;
  /** Shared bearer authorizes one local user, not separate devices. */
  token?: string;
  tls?: { key: string; cert: string };
  /** Standard Web seam; null leaves the request to the same RPC dispatcher. */
  route?(request: Request): Response | null | Promise<Response | null>;
  /** Original transport/device authority verifies headers/cookies and approves a stable identity. */
  authorize?(request: Request): AgentMuxRpcHttpAuthorization | null | Promise<AgentMuxRpcHttpAuthorization | null>
}
export type AgentMuxControlServerOptions = AgentMuxRpcServiceOptions & {
  socketPath?: string
  /** HTTP is absent by default. Binding and authorization must both be explicit. */
  http?: AgentMuxRpcHttpOptions
}
export function agentMuxRpcHttpOptions(env: Readonly<Record<string, string | undefined>> = process.env): AgentMuxRpcHttpOptions | undefined {
  const bind = env.AGENTMUX_RPC_HTTP_BIND, token = env.AGENTMUX_RPC_HTTP_TOKEN
  if (!bind && !token) return undefined
  if (!bind || !token) throw new AgentMuxError('HTTP RPC requires an explicit bind address and authorization token.', 'INVALID_CONTROL_REQUEST')
  let url: URL
  try { url = new URL(`http://${bind}`) } catch { throw new AgentMuxError('HTTP RPC bind address is invalid.', 'INVALID_CONTROL_REQUEST') }
  if (!url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new AgentMuxError('HTTP RPC requires host:port without a URL path.', 'INVALID_CONTROL_REQUEST')
  }
  return { host: url.hostname.replace(/^\[|\]$/gu, ''), port: Number(url.port), token }
}

/** The Desktop and headless hosts register the same public business service. */
export class AgentMuxControlServer {
  private server: Server | undefined
  private httpServer: HttpServer | undefined
  private readonly sockets = new Set<Socket>()
  private readonly service: AgentMuxRpcService
  private readonly dispatcher: AgentMuxRpcDispatcher
  private endpointIdentity: { dev: number; ino: number } | undefined
  private httpFailure: AgentMuxError | null = null
  private readonly localPrincipal: AgentMuxRpcPrincipal = { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` }
  readonly path: string
  constructor(private readonly options: AgentMuxControlServerOptions = {}, path?: string) {
    this.path = path ?? options.socketPath ?? defaultAgentMuxControlSocketPath()
    this.service = new AgentMuxRpcService({ ...options, endpoint: { transport: 'unix', path: this.path } })
    this.dispatcher = new AgentMuxRpcDispatcher(this.service)
    if (options.http && (!options.http.host || !Number.isInteger(options.http.port) || options.http.port < 0 || options.http.port > 65535 ||
      (!options.http.authorize && (typeof options.http.token !== 'string' || !options.http.token || /[\r\n]/u.test(options.http.token))) ||
      options.http.authorize !== undefined && (typeof options.http.authorize !== 'function' || options.http.token !== undefined))) {
      throw new AgentMuxError('HTTP RPC requires explicit valid binding and authorization.', 'INVALID_CONTROL_REQUEST')
    }
  }
  get httpAddress(): { host: string; port: number } | null {
    const address = this.httpServer?.address()
    return address && typeof address === 'object' ? { host: address.address, port: address.port } : null
  }
  get httpUnavailable(): AgentMuxError | null { return this.httpFailure }
  async start(): Promise<void> {
    if (this.server) return
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); await chmod(dirname(this.path), 0o700)
    try {
      const existing = await lstat(this.path), uid = process.getuid?.() ?? existing.uid
      if (!existing.isSocket() || existing.uid !== uid) throw new AgentMuxError('Another owner occupies the RPC endpoint.', 'CONTROL_OWNER_BUSY')
      const liveness = await probeSocketLiveness(this.path)
      if (liveness !== 'dead') throw new AgentMuxError('RPC endpoint owner is alive or unconfirmed.', liveness === 'alive' ? 'CONTROL_OWNER_BUSY' : 'CONTROL_UNAVAILABLE')
      await rm(this.path)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const server = createServer(socket => this.accept(socket))
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.path, resolve) })
      await chmod(this.path, 0o600)
      const identity = await lstat(this.path); this.endpointIdentity = { dev: identity.dev, ino: identity.ino }
    } catch (error) { await this.stop(); throw error }
    if (this.options.http) {
      try {
        const receive = (request: IncomingMessage, response: ServerResponse) => { void this.acceptHttp(request, response) }
        const http = this.options.http.tls ? createHttpsServer(this.options.http.tls, receive) : createHttpServer(receive)
        this.httpServer = http
        http.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)) })
        await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(this.options.http!.port, this.options.http!.host, resolve) })
        this.httpFailure = null
      } catch (error) {
        const http = this.httpServer; this.httpServer = undefined
        if (http?.listening) await new Promise<void>(resolve => http.close(() => resolve()))
        this.httpFailure = new AgentMuxError('HTTP RPC is unavailable; the existing Unix service and Core remain available.',
          'CONTROL_UNAVAILABLE', error instanceof Error ? error.message : String(error))
      }
    }
  }
  async stop(): Promise<void> {
    const server = this.server, http = this.httpServer; this.server = undefined; this.httpServer = undefined
    for (const socket of this.sockets) socket.destroy()
    await Promise.all([server, http].filter(Boolean).map(owner => new Promise<void>(resolve => owner!.close(() => resolve()))))
    if (this.endpointIdentity) {
      try { const identity = await lstat(this.path)
        if (identity.dev === this.endpointIdentity.dev && identity.ino === this.endpointIdentity.ino) await rm(this.path)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      this.endpointIdentity = undefined
    }
    await this.service.dispose()
  }
  private connection(send: (frame: AgentMuxRpcFrame) => void | Promise<void>, close: () => void,
    transport: 'unix' | 'http', principal: AgentMuxRpcPrincipal = this.localPrincipal, authority?: AgentMuxRpcHttpAuthorization) {
    const controller = new AbortController()
    const subscriptions = new Map<string, { method: AgentMuxRpcStreamMethod; dispose(): void | Promise<void> }>()
    const context: AgentMuxRpcConnection = {
      principal, transport, signal: authority?.signal ? AbortSignal.any([controller.signal, authority.signal]) : controller.signal,
      stream: true, send, afterResponse: [],
      activate: (id, method, dispose) => { subscriptions.set(id, { method, dispose }) },
      cancel: async id => { const sub = subscriptions.get(id); if (!sub) return false
        subscriptions.delete(id); await sub.dispose(); return true }
    }
    let closed = false
    const result = { context, subscriptions, dispose: () => {
      if (closed) return; closed = true; controller.abort(); close()
      for (const { dispose } of subscriptions.values()) void Promise.resolve().then(dispose).catch(() => {})
      subscriptions.clear()
      authority?.signal?.removeEventListener('abort', revoked)
      void Promise.resolve().then(() => authority?.dispose?.()).catch(() => {})
    } }
    function revoked() { connection.dispose() }
    const connection = result
    authority?.signal?.addEventListener('abort', revoked, { once: true })
    if (authority?.signal?.aborted) connection.dispose()
    return connection
  }
  private accept(socket: Socket): void {
    this.sockets.add(socket)
    const lines = new AgentMuxRpcLines()
    const channel = this.connection(async frame => {
      if (socket.destroyed || socket.writableEnded) return
      let encoded: string
      try { encoded = rpcEncode(frame) } catch { channel.dispose(); return }
      if (socket.writableLength + Buffer.byteLength(encoded) > AGENTMUX_RPC_MAX_MESSAGE_BYTES) {
        channel.dispose(); return
      }
      if (!socket.write(encoded)) await new Promise<void>(resolve => {
        const done = () => { socket.off('drain', done); socket.off('close', done); resolve() }
        socket.once('drain', done); socket.once('close', done)
      })
    }, () => socket.destroy(), 'unix')
    socket.setTimeout(AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS, () => channel.dispose())
    socket.on('error', () => channel.dispose())
    socket.once('end', () => { try { lines.end() } catch { /* An incomplete reader cannot own a business rollback. */ } channel.dispose() })
    socket.once('close', () => { this.sockets.delete(socket); channel.dispose() })
    socket.on('data', chunk => {
      try { lines.accept(chunk, value => {
        socket.setTimeout(0)
        const context = { ...channel.context, afterResponse: [] as Array<() => void | Promise<void>> }
        let responded = false
        void this.dispatcher.receive(value, context).then(async response => {
          if (context.signal.aborted) return
          if (response) { await channel.context.send(response as AgentMuxRpcFrame); responded = true }
          for (const flush of context.afterResponse) await flush()
        }).catch(error => {
          if (responded) channel.dispose()
          else if (!socket.destroyed) socket.end(rpcEncode(createJSONRPCErrorResponse(null, -32603, error instanceof Error ? error.message : 'RPC service failed.')))
        })
      }) } catch {
        if (!socket.destroyed) socket.end(rpcEncode(createJSONRPCErrorResponse(null, -32700, 'Invalid JSON RPC frame.')))
      }
    })
  }
  private async authorized(request: Request): Promise<AgentMuxRpcHttpAuthorization | null> {
    if (this.options.http!.authorize) {
      const authorization = await this.options.http!.authorize(request)
      const principal = authorization?.principal
      if (principal && (principal.kind === 'user' || principal.kind === 'device') &&
        typeof principal.id === 'string' && principal.id.length > 0 && !principal.id.includes('\0') && !authorization!.signal?.aborted) return authorization
      await authorization?.dispose?.()
      return null
    }
    const received = request.headers.get('authorization'), expected = `Bearer ${this.options.http!.token}`
    return typeof received === 'string' && Buffer.byteLength(received) === Buffer.byteLength(expected) &&
      timingSafeEqual(Buffer.from(received), Buffer.from(expected)) ? { principal: this.localPrincipal } : null
  }
  private async acceptHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    const transport = new AbortController(), abort = () => transport.abort()
    response.once('close', abort); request.once('aborted', abort)
    let channel: ReturnType<AgentMuxControlServer['connection']> | undefined, streamed = false
    try {
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk)
        if (size > AGENTMUX_RPC_MAX_MESSAGE_BYTES) { response.writeHead(413); response.end(); return }
        chunks.push(chunk)
      }
      const body = Buffer.concat(chunks), headers = new Headers()
      for (const [key, value] of Object.entries(request.headers)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(key, item)
      }
      const protocol = this.options.http!.tls ? 'https' : 'http'
      const origin = `${protocol}://${request.headers.host ?? 'localhost'}`
      const web = new Request(new URL(request.url ?? '/', origin), { method: request.method ?? 'GET', headers,
        signal: transport.signal, ...(!['GET', 'HEAD'].includes(request.method ?? 'GET') ? { body: new Uint8Array(body) } : {}) })
      const routed = await this.options.http!.route?.(web.clone())
      if (routed) {
        for (const [key, value] of routed.headers) if (key !== 'set-cookie') response.setHeader(key, value)
        const cookies = routed.headers.getSetCookie(); if (cookies.length) response.setHeader('Set-Cookie', cookies)
        response.writeHead(routed.status)
        if (routed.body && request.method !== 'HEAD') await pipeline(Readable.fromWeb(routed.body as Parameters<typeof Readable.fromWeb>[0]), response)
        else response.end()
        return
      }
      let authorization: AgentMuxRpcHttpAuthorization | null
      try { authorization = await this.authorized(web.clone()) } catch { authorization = null }
      if (!authorization) { response.writeHead(401); response.end(); return }
      channel = this.connection(async frame => {
        if (response.destroyed || response.writableEnded) return
        let encoded: string
        try { encoded = `data: ${rpcEncode(frame).trimEnd()}\n\n` } catch { channel!.dispose(); return }
        if (response.writableLength + Buffer.byteLength(encoded) > AGENTMUX_RPC_MAX_MESSAGE_BYTES) { channel!.dispose(); return }
        if (!response.write(encoded)) await new Promise<void>(resolve => {
          const done = () => { response.off('drain', done); response.off('close', done); resolve() }
          response.once('drain', done); response.once('close', done)
        })
      }, () => { if (!response.writableEnded) response.destroy() }, 'http', authorization.principal, authorization)
      response.once('close', () => channel!.dispose()); request.once('aborted', () => channel!.dispose())
      if (web.method !== 'POST' || new URL(web.url).pathname !== '/' || new URL(web.url).search) { response.writeHead(405, { Allow: 'POST' }); response.end(); return }
      if (web.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') { response.writeHead(415); response.end(); return }
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) }
      catch { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(createJSONRPCErrorResponse(null, -32700, 'Invalid JSON RPC body.'))); return }
      const result = await this.dispatcher.receive(value, channel.context)
      if (channel.context.signal.aborted) return
      streamed = channel.subscriptions.size > 0
      if (streamed) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
        if (result) await channel.context.send(result as AgentMuxRpcFrame)
        for (const flush of channel.context.afterResponse) await flush()
      } else {
        if (!result) response.writeHead(204)
        else { const encoded = rpcEncode(result as AgentMuxRpcFrame); response.setHeader('Content-Type', 'application/json'); response.write(encoded) }
        response.end()
      }
    } catch {
      if (!response.headersSent) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(createJSONRPCErrorResponse(null, -32603, 'RPC transport failed.'))) }
      else response.destroy()
    } finally {
      if (!streamed) { channel?.dispose(); response.off('close', abort); request.off('aborted', abort) }
    }
  }
}
