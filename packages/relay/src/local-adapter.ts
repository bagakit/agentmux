import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { WebSocket } from 'ws'
import { attachRelayRouter, type RelayConnectionInfo } from './routing-server.js'

export type LocalRelayConnectionInfo = RelayConnectionInfo
export { CLIENT_SOCKET_MAX_PAYLOAD, RELAY_FORWARD_HIGH_WATER_MARK, RELAY_FORWARD_LOW_WATER_MARK,
  RELAY_MAX_RPC_FRAME_BYTES, SERVER_SOCKET_MAX_PAYLOAD } from './routing-server.js'

/** Local adapter for the V2 control/data protocol. Encryption remains end to end. */
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
  const router = attachRelayRouter(server, {
    acceptsServer: serverId => serverId === options.serverId,
    authorizePublisher: request => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') &&
      request.headers.authorization === `Bearer ${controlToken}`,
    publisherCollision: 'replace',
  })
  server.on('upgrade', (request, socket) => {
    let path: string
    try { path = new URL(request.url ?? '/', 'http://localhost').pathname } catch { path = '' }
    if (path !== '/ws') socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.removeListener('listening', listening); reject(error) }
    const listening = () => { server.removeListener('error', failed); resolve() }
    server.once('error', failed); server.once('listening', listening)
    server.listen(options.port, '0.0.0.0')
  }).catch(async error => { await router.stop(); throw error })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local Relay address is unavailable.')
  let disposed = false
  return { port: address.port,
    /** Only the original client upgrade supplies identification, never Relay control/data sockets. */
    connectionInfo: (connectionId: string): LocalRelayConnectionInfo | undefined => router.connectionInfo(options.serverId, connectionId),
    hostWebSocket: (url: string) => new WebSocket(url, { headers: { Authorization: `Bearer ${controlToken}` }, handshakeTimeout: 10000, perMessageDeflate: false }),
    async stop() {
      if (disposed) return
      disposed = true; await router.stop()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
