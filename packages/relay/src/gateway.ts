import { createServer, type Server } from 'node:http'
import { attachRelayRouter } from './routing-server.js'
import { createPublisherAdmission, type RelayPublisherGrant } from './publisher-admission.js'

export { hashPublisherToken, type RelayPublisherGrant } from './publisher-admission.js'
export type { RelayConnectionInfo } from './routing-server.js'

export interface RelayGatewayConfiguration {
  readonly host?: string
  readonly port: number
  readonly publishers: readonly RelayPublisherGrant[]
}

export function parseRelayGatewayConfiguration(value: unknown): RelayGatewayConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Relay gateway configuration must be an object.')
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(key => !['host', 'port', 'publishers'].includes(key)) ||
      v.host !== undefined && (typeof v.host !== 'string' || !v.host || /[\0\r\n]/u.test(v.host)) ||
      !Number.isInteger(v.port) || (v.port as number) < 0 || (v.port as number) > 65535 || !Array.isArray(v.publishers))
    throw new Error('Relay gateway requires a bind host, port and explicit publisher grants.')
  const publishers = v.publishers.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 ||
        Object.keys(item).some(key => !['serverId', 'tokenHash'].includes(key))) throw new Error('Relay publisher grants require serverId and tokenHash only.')
    const grant = item as RelayPublisherGrant
    return { serverId: grant.serverId, tokenHash: grant.tokenHash }
  })
  createPublisherAdmission(publishers)
  return { ...(v.host === undefined ? {} : { host: v.host as string }), port: v.port as number, publishers }
}

/** Borrow an existing gateway listener. Releasing Relay never closes that listener or its other services. */
export function attachRelayGateway(server: Server, options: Pick<RelayGatewayConfiguration, 'publishers'>) {
  return attachRelayRouter(server, { ...createPublisherAdmission(options.publishers), publisherCollision: 'reject' })
}

/** Small standalone host of the same gateway used by an embedded Core service. */
export async function startRelayGateway(input: RelayGatewayConfiguration) {
  const options = parseRelayGatewayConfiguration(input)
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (request.method !== 'GET' || request.url !== '/healthz') { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ service: 'agentmux-relay', protocol: 2 }))
  })
  const gateway = attachRelayGateway(server, options)
  server.on('upgrade', (request, socket) => {
    let path: string
    try { path = new URL(request.url ?? '/', 'http://localhost').pathname } catch { path = '' }
    if (path !== '/ws') socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.removeListener('listening', listening); reject(error) }
    const listening = () => { server.removeListener('error', failed); resolve() }
    server.once('error', failed); server.once('listening', listening)
    server.listen(options.port, options.host ?? '127.0.0.1')
  }).catch(async error => { await gateway.stop(); throw error })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Relay gateway listener is unavailable.')
  let stopped = false
  return { host: address.address, port: address.port,
    connectionInfo: gateway.connectionInfo,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true; await gateway.stop()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
