import { timingSafeEqual } from 'node:crypto'
import { mkdir, chmod, lstat, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createJSONRPCErrorResponse } from 'json-rpc-2.0'
import { AgentMuxError } from './errors.js'
import { AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS } from './control.js'
import { defaultAgentMuxControlSocketPath } from './runtime-paths.js'
import { probeSocketLiveness } from './socket-liveness.js'
import { AgentMuxRpcService, type AgentMuxRpcServiceOptions } from './public-rpc-service.js'
import { AgentMuxRpcDispatcher, AgentMuxRpcLines, rpcEncode, AGENTMUX_RPC_MAX_MESSAGE_BYTES,
  type AgentMuxRpcFrame, type AgentMuxRpcConnection } from './public-rpc-wire.js'
import type { AgentMuxRpcStreamMethod } from './public-rpc.js'

export type AgentMuxRpcHttpOptions = { host: string; port: number; token: string }
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
  readonly path: string
  constructor(private readonly options: AgentMuxControlServerOptions = {}, path?: string) {
    this.path = path ?? options.socketPath ?? defaultAgentMuxControlSocketPath()
    this.service = new AgentMuxRpcService({ ...options, endpoint: { transport: 'unix', path: this.path } })
    this.dispatcher = new AgentMuxRpcDispatcher(this.service)
    if (options.http && (!options.http.host || !Number.isInteger(options.http.port) || options.http.port < 0 || options.http.port > 65535 ||
      typeof options.http.token !== 'string' || !options.http.token || /[\r\n]/u.test(options.http.token))) {
      throw new AgentMuxError('HTTP RPC requires explicit valid binding and authorization.', 'INVALID_CONTROL_REQUEST')
    }
  }
  get httpAddress(): { host: string; port: number } | null {
    const address = this.httpServer?.address()
    return address && typeof address === 'object' ? { host: address.address, port: address.port } : null
  }
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
      if (this.options.http) {
        const http = createHttpServer((request, response) => { void this.acceptHttp(request, response) })
        this.httpServer = http
        http.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)) })
        await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(this.options.http!.port, this.options.http!.host, resolve) })
      }
    } catch (error) { await this.stop(); throw error }
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
  private connection(send: (frame: AgentMuxRpcFrame) => void | Promise<void>, close: () => void) {
    const controller = new AbortController()
    const subscriptions = new Map<string, { method: AgentMuxRpcStreamMethod; dispose(): void | Promise<void> }>()
    const context: AgentMuxRpcConnection = {
      signal: controller.signal, stream: true, send, afterResponse: [],
      activate: (id, method, dispose) => { subscriptions.set(id, { method, dispose }) },
      cancel: async id => { const sub = subscriptions.get(id); if (!sub) return false
        subscriptions.delete(id); await sub.dispose(); return true }
    }
    let closed = false
    return { context, subscriptions, dispose: () => {
      if (closed) return; closed = true; controller.abort(); close()
      for (const { dispose } of subscriptions.values()) void Promise.resolve().then(dispose).catch(() => {})
      subscriptions.clear()
    } }
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
    }, () => socket.destroy())
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
  private authorized(request: IncomingMessage): boolean {
    const received = request.headers.authorization
    const expected = `Bearer ${this.options.http!.token}`
    return typeof received === 'string' && Buffer.byteLength(received) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  }
  private async acceptHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    if (!this.authorized(request)) { response.writeHead(401); response.end(); return }
    if (request.method !== 'POST' || request.url !== '/') { response.writeHead(405, { Allow: 'POST' }); response.end(); return }
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') { response.writeHead(415); response.end(); return }
    let streamed = false
    const channel = this.connection(async frame => {
      if (response.destroyed || response.writableEnded) return
      let encoded: string
      try { encoded = `data: ${rpcEncode(frame).trimEnd()}\n\n` } catch { channel.dispose(); return }
      if (response.writableLength + Buffer.byteLength(encoded) > AGENTMUX_RPC_MAX_MESSAGE_BYTES) { channel.dispose(); return }
      if (!response.write(encoded)) await new Promise<void>(resolve => {
        const done = () => { response.off('drain', done); response.off('close', done); resolve() }
        response.once('drain', done); response.once('close', done)
      })
    }, () => { if (!response.writableEnded) response.destroy() })
    response.once('close', () => channel.dispose())
    request.once('aborted', () => channel.dispose())
    try {
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk)
        if (size > AGENTMUX_RPC_MAX_MESSAGE_BYTES) { response.writeHead(413); response.end(); return }
        chunks.push(chunk)
      }
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
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
    } finally { if (!streamed) channel.dispose() }
  }
}
