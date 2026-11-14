import { createServer, type Server } from 'node:http'
import { createRelayRouter } from './routing-server.js'
import { RelayMeshNetwork } from './mesh-network.js'
import { parseRelayMeshConfiguration, type RelayMeshConfiguration } from './mesh-protocol.js'
import { createPublisherAdmission, type RelayPublisherGrant } from './publisher-admission.js'

export { hashPublisherToken, type RelayPublisherGrant } from './publisher-admission.js'
export type { RelayConnectionInfo } from './routing-server.js'
export { createRelayMeshIdentity, relayMeshPeerId, parseRelayMeshConfiguration, parseRelayMeshObservation, parseRelayMeshEndpoint, parseRelayMeshRoute } from './mesh-protocol.js'
export type { RelayMeshConfiguration, RelayMeshObservation, RelayMeshRoute, RelayMeshIdentity, RelayMeshEndpoint, RelayMeshMember } from './mesh-protocol.js'
export { acquireRelayMeshIdentity, inspectRelayMeshState, reconcileRelayMeshState } from './mesh-state.js'
export type { RelayMeshStateInspection } from './mesh-state.js'

export interface RelayGatewayConfiguration {
  readonly host?: string
  readonly port: number
  readonly publishers: readonly RelayPublisherGrant[]
  readonly mesh?: RelayMeshConfiguration
}
export type RelayGatewayOptions = Pick<RelayGatewayConfiguration, 'publishers' | 'mesh'>

export function parseRelayGatewayConfiguration(value: unknown): RelayGatewayConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Relay gateway configuration must be an object.')
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(key => !['host', 'port', 'publishers', 'mesh'].includes(key)) ||
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
  return { ...(v.host === undefined ? {} : { host: v.host as string }), port: v.port as number, publishers, ...(v.mesh === undefined ? {} : { mesh: parseRelayMeshConfiguration(v.mesh) }) }
}

/** One volatile routing/network owner, usable before or without HTTP listening. */
export function createRelayGateway(input: RelayGatewayOptions) {
  let options = structuredClone(input)
  let admission = createPublisherAdmission(input.publishers)
  let mesh: RelayMeshNetwork | undefined
  const router = createRelayRouter({ acceptsServer: id => admission.acceptsServer(id),
    authorizePublisher: (request,id) => admission.authorizePublisher(request,id), publisherCollision: 'reject',
    canRouteClient: id => Boolean(mesh?.resolvePublisher(id)),
    openRemoteClient: (id,signal) => mesh!.openClient(id,signal), publisherChanged: () => mesh?.publisherChanged() })
  mesh = new RelayMeshNetwork({ publishers: router.localPublishers, bridge: router.bridge,
    acceptClient: (id,socket) => router.acceptClient(id,socket,{},true) },input.mesh)
  let stopped = false
  return {
    attach(server: Server) {
      const local = router.attach(server)
      try { const network = mesh!.attach(server); return { detach() { local.detach(); network.detach() } } }
      catch(error) { local.detach(); throw error }
    },
    async configure(next: RelayGatewayOptions): Promise<void> {
      const candidate = createPublisherAdmission(next.publishers)
      const network = next.mesh === undefined ? undefined : parseRelayMeshConfiguration(next.mesh)
      mesh!.configure(network)
      const changed = options.publishers.filter(p => !next.publishers.some(n => n.serverId === p.serverId && n.tokenHash === p.tokenHash))
      admission = candidate; options = structuredClone(next)
      for(const publisher of changed) router.revokePublisher(publisher.serverId)
    },
    inspectMesh: () => mesh!.inspect(), resolvePublisher: (serverId:string) => mesh!.resolvePublisher(serverId),
    connectionInfo: router.connectionInfo,
    async stop(): Promise<void> { if(stopped)return;stopped=true;await mesh!.stop();await router.stop() },
  }
}

/** Borrow an existing gateway listener; releasing Relay never closes its host. */
export function attachRelayGateway(server: Server, options: RelayGatewayOptions) {
  const gateway = createRelayGateway(options)
  const attachment = gateway.attach(server)
  return { ...gateway, detach: attachment.detach }
}

/** Small standalone host of the same gateway used by an embedded Core service. */
export async function startRelayGateway(input: RelayGatewayConfiguration) {
  const options = parseRelayGatewayConfiguration(input)
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (request.method !== 'GET' || request.url !== '/healthz') { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    const mesh = gateway.inspectMesh()
    response.end(JSON.stringify({ service: 'agentmux-relay', protocol: 2,
      ...(mesh.state === 'active' ? { mesh: { state: mesh.state, connectedPeers: mesh.peers.filter(p => p.state === 'connected').length, publisherRoutes: mesh.routes.length } } : {}) }))
  })
  const gateway = attachRelayGateway(server, options)
  server.on('upgrade', (request, socket) => {
    if (socket.destroyed || socket.writableEnded) return
    let path: string
    try { path = new URL(request.url ?? '/', 'http://localhost').pathname } catch { path = '' }
    if (!['/ws','/mesh','/mesh/data'].includes(path)) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
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
    connectionInfo: gateway.connectionInfo, inspectMesh: gateway.inspectMesh, resolvePublisher: gateway.resolvePublisher, configure: gateway.configure,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true; await gateway.stop()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
