import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

export interface LocalRelayConnectionInfo { readonly address?: string; readonly userAgent?: string }

/** Local adapter for Paseo's V2 control/data protocol. Encryption remains end to end. */
export async function startLocalRelay(options: {
  serverId: string
  port: number
  route: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}) {
  const controlToken = randomBytes(32).toString('hex')
  const server = createServer((request, response) => {
    void Promise.resolve(options.route(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      response.end('Mobile page unavailable. Existing Agent Sessions remain available.')
    })
  })
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false })
  let control: WebSocket | undefined, disposed = false
  const pairs = new Map<string, { client: WebSocket; data?: WebSocket; pending: { data: RawData; binary: boolean }[]; bytes: number; timer: NodeJS.Timeout; info: LocalRelayConnectionInfo }>()
  const send = (socket: WebSocket | undefined, data: RawData | string, binary = false) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    if (socket.bufferedAmount > 8 * 1024 * 1024) { socket.close(4008, 'Reader exceeded its budget'); return false }
    socket.send(data, { binary }, error => { if (error) socket.terminate() })
    return true
  }
  const notify = (message: unknown) => send(control, JSON.stringify(message))
  const drop = (id: string) => {
    const pair = pairs.get(id)
    if (!pair) return
    pairs.delete(id); clearTimeout(pair.timer)
    pair.client.close(4001, 'Connection ended'); pair.data?.close(4001, 'Connection ended')
    notify({ type: 'disconnected', connectionId: id })
  }
  server.on('upgrade', (request, socket, head) => {
    let url: URL
    try { url = new URL(request.url ?? '/', 'http://localhost') } catch { socket.destroy(); return }
    const role = url.searchParams.get('role'), id = url.searchParams.get('connectionId')
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')
    if (url.pathname !== '/ws' || url.searchParams.get('v') !== '2' || url.searchParams.get('serverId') !== options.serverId ||
      role !== 'client' && role !== 'server' || role === 'server' && (!loopback || request.headers.authorization !== `Bearer ${controlToken}`) || role === 'client' && id ||
      role === 'server' && id && !pairs.has(id) || role === 'client' && pairs.size >= 128) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    sockets.handleUpgrade(request, socket, head, ws => {
      if (disposed) { ws.close(1001, 'Host stopped'); return }
      let alive = true
      const heartbeat = setInterval(() => { if (!alive) { ws.terminate(); return }; alive = false; ws.ping() }, 15000)
      ws.on('pong', () => { alive = true })
      ws.once('close', () => clearInterval(heartbeat))
      ws.on('error', () => ws.terminate())
      if (role === 'server' && !id) {
        control?.close(4001, 'Control replaced'); control = ws
        notify({ type: 'sync', connectionIds: [...pairs.keys()] })
        ws.on('message', data => { try { if (JSON.parse(data.toString()).type === 'ping') send(ws, JSON.stringify({ type: 'pong' })) } catch { ws.close(4002, 'Invalid control frame') } })
        ws.once('close', () => { if (control !== ws) return; control = undefined; for (const key of [...pairs.keys()]) drop(key) })
        return
      }
      if (role === 'server' && id) {
        const pair = pairs.get(id)!
        pair.data?.close(4001, 'Data replaced'); pair.data = ws; clearTimeout(pair.timer)
        for (const frame of pair.pending) send(ws, frame.data, frame.binary)
        pair.pending = []; pair.bytes = 0
        ws.on('message', (data, binary) => { if (pair.data === ws) send(pair.client, data, binary) })
        ws.once('close', () => { if (pair.data === ws) drop(id) })
        return
      }
      if (!control || control.readyState !== WebSocket.OPEN) { ws.close(4001, 'Host reconnecting'); return }
      const key = randomUUID()
      const address = request.socket.remoteAddress?.replace(/^::ffff:/u, '')
      const userAgent = request.headers['user-agent']
      const pair = { client: ws, data: undefined as WebSocket | undefined, pending: [] as { data: RawData; binary: boolean }[], bytes: 0,
        timer: setTimeout(() => drop(key), 10000), info: {
          ...(address ? { address } : {}), ...(userAgent ? { userAgent } : {})
        } }
      pairs.set(key, pair); notify({ type: 'connected', connectionId: key })
      ws.on('message', (data, binary) => {
        if (pair.data) { send(pair.data, data, binary); return }
        const bytes = Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength
        pair.bytes += bytes
        if (pair.bytes > 8 * 1024 * 1024 || pair.pending.length >= 128) { drop(key); return }
        pair.pending.push({ data, binary })
      })
      ws.once('close', () => drop(key))
    })
  })
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.removeListener('listening', listening); reject(error) }
    const listening = () => { server.removeListener('error', failed); resolve() }
    server.once('error', failed); server.once('listening', listening)
    server.listen(options.port, '0.0.0.0')
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local Relay address is unavailable.')
  return { port: address.port,
    /** Only the original client upgrade supplies identification, never Relay control/data sockets. */
    connectionInfo: (connectionId: string): LocalRelayConnectionInfo | undefined => {
      const info = pairs.get(connectionId)?.info
      return info ? { ...info } : undefined
    },
    hostWebSocket: (url: string) => new WebSocket(url, { headers: { Authorization: `Bearer ${controlToken}` }, handshakeTimeout: 10000, perMessageDeflate: false }), async stop() {
    if (disposed) return; disposed = true
    for (const id of [...pairs.keys()]) drop(id)
    control?.terminate(); for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>(resolve => sockets.close(() => resolve()))
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}
