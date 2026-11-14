import type { IncomingMessage, Server } from 'node:http'
import { mintObjectId } from '@agentmux/identity'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { base64EncryptedWireByteLength } from './encrypted-channel.js'

export interface RelayConnectionInfo { readonly address?: string; readonly userAgent?: string }

/** Mirrors the RPC frame budget in Core, which depends on this package. */
export const RELAY_MAX_RPC_FRAME_BYTES = 64 * 1024 * 1024
/** Client requests remain unauthenticated until the original endpoint completes E2EE admission. */
export const CLIENT_SOCKET_MAX_PAYLOAD = 16 * 1024 * 1024
/** An admitted publisher may forward one maximal RPC frame as base64 ciphertext. */
export const SERVER_SOCKET_MAX_PAYLOAD = base64EncryptedWireByteLength(RELAY_MAX_RPC_FRAME_BYTES)
/** In-flight bytes toward one reader, independent of cumulative connection lifetime. */
export const RELAY_FORWARD_HIGH_WATER_MARK = 16 * 1024 * 1024
export const RELAY_FORWARD_LOW_WATER_MARK = 4 * 1024 * 1024

export interface RelayRouterOptions {
  /** Original admission owner decides known routes; arbitrary URL ids never register publishers. */
  acceptsServer(serverId: string): boolean
  authorizePublisher(request: IncomingMessage, serverId: string): boolean | Promise<boolean>
  /** The existing local adapter owns replace semantics; remote publishers retain a healthy incumbent. */
  publisherCollision: 'replace' | 'reject'
}

type Pair = {
  client: WebSocket; data?: WebSocket; pending: { data: RawData; binary: boolean }[]
  bytes: number; timer: NodeJS.Timeout; info: RelayConnectionInfo
}
type Publisher = { control?: WebSocket; pairs: Map<string, Pair> }

/**
 * V2 routing shared by local, gateway and edge hosts. The host retains HTTP/TLS,
 * publisher admission and lifecycle; encrypted endpoint RPC remains opaque here.
 */
export function attachRelayRouter(server: Server, options: RelayRouterOptions) {
  const clients = new WebSocketServer({ noServer: true, maxPayload: CLIENT_SOCKET_MAX_PAYLOAD, perMessageDeflate: false })
  const publishers = new WebSocketServer({ noServer: true, maxPayload: SERVER_SOCKET_MAX_PAYLOAD, perMessageDeflate: false })
  const routes = new Map<string, Publisher>()
  const forwarded = new WeakMap<WebSocket, number>()
  const drainTimers = new Set<NodeJS.Timeout>()
  let disposed = false
  const byteLength = (data: RawData) => Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength
  const send = (socket: WebSocket | undefined, data: RawData | string, binary = false) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    if (socket.bufferedAmount > 8 * 1024 * 1024) { socket.close(4008, 'Reader exceeded its budget'); return false }
    socket.send(data, { binary }, error => { if (error) socket.terminate() })
    return true
  }
  const forward = (source: WebSocket, target: WebSocket, data: RawData, binary: boolean) => {
    if (target.readyState !== WebSocket.OPEN) return
    forwarded.set(target, (forwarded.get(target) ?? 0) + byteLength(data))
    target.send(data, { binary }, error => { if (error) target.terminate() })
    if (target.bufferedAmount <= RELAY_FORWARD_HIGH_WATER_MARK || source.isPaused) return
    source.pause()
    const timer = setInterval(() => {
      if (target.readyState === WebSocket.OPEN && target.bufferedAmount > RELAY_FORWARD_LOW_WATER_MARK) return
      clearInterval(timer); drainTimers.delete(timer); source.resume()
    }, 25)
    drainTimers.add(timer)
  }
  const notify = (route: Publisher, message: unknown) => send(route.control, JSON.stringify(message))
  const drop = (route: Publisher, id: string) => {
    const pair = route.pairs.get(id)
    if (!pair) return
    route.pairs.delete(id); clearTimeout(pair.timer)
    pair.client.close(4001, 'Connection ended'); pair.data?.close(4001, 'Connection ended')
    notify(route, { type: 'disconnected', connectionId: id })
  }
  const reject = (socket: { end(data: string): unknown }, status = 403) => {
    socket.end(`HTTP/1.1 ${status} ${status === 409 ? 'Conflict' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }
  // Keep this listener separately so releasing the router leaves its host's other services intact.
  const onUpgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    void (async () => {
      let url: URL
      try { url = new URL(request.url ?? '/', 'http://localhost') } catch { return }
      // An embedded gateway owns /ws only; another service may own other upgrade paths.
      if (url.pathname !== '/ws') return
      const role = url.searchParams.get('role'), id = url.searchParams.get('connectionId'), serverId = url.searchParams.get('serverId')
      if (disposed || url.searchParams.get('v') !== '2' || !serverId || !options.acceptsServer(serverId) ||
        role !== 'client' && role !== 'server' || role === 'client' && id || url.searchParams.has('connectionId') && !id ||
        [...url.searchParams.keys()].some(key => !['role', 'connectionId', 'serverId', 'v'].includes(key) || url.searchParams.getAll(key).length !== 1)) { reject(socket); return }
      if (role === 'server' && !await options.authorizePublisher(request, serverId)) { reject(socket); return }
      if (disposed || socket.destroyed || !options.acceptsServer(serverId)) { reject(socket); return }
      let route = routes.get(serverId)
      if (!route) { route = { pairs: new Map() }; routes.set(serverId, route) }
      // A data socket must attach to this original server's original pair.
      const pair = id ? route.pairs.get(id) : undefined
      if (role === 'server' && id && !pair || role === 'client' && route.pairs.size >= 128) { reject(socket); return }
      if (options.publisherCollision === 'reject' && role === 'server' &&
          (id ? pair?.data?.readyState === WebSocket.OPEN : route.control?.readyState === WebSocket.OPEN)) { reject(socket, 409); return }
      const original = route
      ;(role === 'server' ? publishers : clients).handleUpgrade(request, socket, head, ws => {
        if (disposed) { ws.close(1001, 'Relay stopped'); return }
        let alive = true, drained = 0
        const heartbeat = setInterval(() => {
          const progress = (forwarded.get(ws) ?? 0) - ws.bufferedAmount
          if (!alive && !ws.isPaused && progress <= drained) { ws.terminate(); return }
          alive = false; drained = progress; ws.ping()
        }, 15000)
        ws.on('pong', () => { alive = true })
        ws.once('close', () => clearInterval(heartbeat))
        ws.on('error', () => ws.terminate())
        if (role === 'server' && !id) {
          original.control?.close(4001, 'Control replaced'); original.control = ws
          notify(original, { type: 'sync', connectionIds: [...original.pairs.keys()] })
          ws.on('message', data => { try { if (JSON.parse(data.toString()).type === 'ping') send(ws, JSON.stringify({ type: 'pong' })) } catch { ws.close(4002, 'Invalid control frame') } })
          ws.once('close', () => {
            if (original.control !== ws) return
            original.control = undefined
            for (const key of [...original.pairs.keys()]) drop(original, key)
          })
          return
        }
        if (role === 'server' && id) {
          const current = pair!
          current.data?.close(4001, 'Data replaced'); current.data = ws; clearTimeout(current.timer)
          for (const frame of current.pending) forward(current.client, ws, frame.data, frame.binary)
          current.pending = []; current.bytes = 0
          ws.on('message', (data, binary) => { if (current.data === ws) forward(ws, current.client, data, binary) })
          ws.once('close', () => { if (current.data === ws) drop(original, id) })
          return
        }
        if (!original.control || original.control.readyState !== WebSocket.OPEN) { ws.close(4001, 'Publisher reconnecting'); return }
        const key = mintObjectId()
        const address = request.socket.remoteAddress?.replace(/^::ffff:/u, '')
        const userAgent = request.headers['user-agent']
        const current: Pair = { client: ws, pending: [], bytes: 0, timer: setTimeout(() => drop(original, key), 10000),
          info: { ...(address ? { address } : {}), ...(userAgent ? { userAgent } : {}) } }
        original.pairs.set(key, current); notify(original, { type: 'connected', connectionId: key })
        ws.on('message', (data, binary) => {
          if (current.data) { forward(ws, current.data, data, binary); return }
          current.bytes += byteLength(data)
          if (current.bytes > 8 * 1024 * 1024 || current.pending.length >= 128) { drop(original, key); return }
          current.pending.push({ data, binary })
        })
        ws.once('close', () => drop(original, key))
      })
    })().catch(() => { if (!socket.destroyed) reject(socket) })
  }
  server.on('upgrade', onUpgrade)
  return {
    connectionInfo(serverId: string, connectionId: string): RelayConnectionInfo | undefined {
      const info = routes.get(serverId)?.pairs.get(connectionId)?.info
      return info ? { ...info } : undefined
    },
    async stop(): Promise<void> {
      if (disposed) return
      disposed = true; server.removeListener('upgrade', onUpgrade)
      for (const timer of drainTimers) clearInterval(timer)
      drainTimers.clear()
      for (const route of routes.values()) {
        for (const id of [...route.pairs.keys()]) drop(route, id)
        route.control?.terminate()
      }
      for (const sockets of [clients, publishers]) for (const socket of sockets.clients) socket.terminate()
      await Promise.all([clients, publishers].map(sockets => new Promise<void>(resolve => sockets.close(() => resolve()))))
      routes.clear()
    },
  }
}
