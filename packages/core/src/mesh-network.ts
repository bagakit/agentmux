import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseConnectionOffer, parseConnectionOfferUrl, type ConnectionOffer } from '@agentmux/relay/offer'
import { parseRelayGatewayConfiguration, parseRelayMeshEndpoint, parseRelayMeshRoute, parseRelayMeshObservation, relayMeshPeerId,
  type RelayPublisherGrant, type RelayMeshConfiguration, type RelayMeshObservation, type RelayMeshRoute } from '@agentmux/relay/gateway'
import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { parseAgentMuxRelayInspection, type AgentMuxRelayGatewayObservation } from './public-rpc-relay-gateway.js'

/** Network roles do not grant Node publication, Runtime or device permissions. */
export type MeshNetworkConfiguration = Pick<RelayMeshConfiguration, 'networkId' | 'members' | 'peers' | 'advertisedIngress'> & {
  role: 'disabled' | 'participant' | 'gateway'
  endpointAccess: { allowedClientKeys: readonly string[] }
  publishers: readonly RelayPublisherGrant[]
  listen?: { host: string; port: number; tls?: { keyPath: string; certPath: string } }
}
export type MeshPublicIdentity = { peerId: string; publicKey: string; epoch: number }
export type MeshOwner = { runtimeId: string; ownerInstanceId: string }
export type MeshSaveOperation = { operationId: string; expectedRevision: string; revision: string; status: 'confirmed' | 'unknown'; updatedAt: number; cause?: { code: string; message: string } }
export type MeshNetworkSettings = { owner: MeshOwner; identity: MeshPublicIdentity | null; revision: string; configuration: MeshNetworkConfiguration; operation: MeshSaveOperation | null }
export type MeshApplyObservation = { state: 'disabled' | 'starting' | 'active' | 'unavailable'; issue?: { code: string; message: string } }
export type MeshEndpointObservation = { state: 'not-provided' | 'starting' | 'unavailable'; issue?: { code: string; message: string } } | { state: 'available'; offer: ConnectionOffer }
export type MeshNetworkInspection = {
  owner: MeshOwner; identity: MeshPublicIdentity | null; desiredRevision: string | null; activeRevision: string | null
  source: 'none' | 'static' | 'managed'; apply: MeshApplyObservation; gateway: AgentMuxRelayGatewayObservation
  network: RelayMeshObservation | null; endpoint: MeshEndpointObservation; observedAt: number
  /** Coverage is only the configured origin advertisements, never fleet/Native health. */
  coverage: { configuredOrigins: number; observedOrigins: number; complete: boolean }
}
export type MeshNetworkLink = { offer: ConnectionOffer; url: string; observation: {
  owner: MeshOwner; identity: MeshPublicIdentity; activeRevision: string; observedAt: number
  route: RelayMeshRoute; ingress: { endpoint: string; useTls: boolean }
} }
export const MESH_NETWORK_METHODS = { 'settings.mesh.inspect': 'short', 'settings.mesh.configure': 'long', 'mesh.inspect': 'short', 'mesh.link': 'short' } as const
export type MeshNetworkMethod = keyof typeof MESH_NETWORK_METHODS
export type MeshNetworkParams = {
  'settings.mesh.inspect': { operationId?: string }
  'settings.mesh.configure': { expectedRevision: string; operationId: string; configuration: MeshNetworkConfiguration }
  'mesh.inspect': Record<string, never>
  'mesh.link': { offer: ConnectionOffer }
}
export type MeshNetworkResults = {
  'settings.mesh.inspect': MeshNetworkSettings
  'settings.mesh.configure': { settings: MeshNetworkSettings; diskDurability: 'confirmed' | 'unknown' }
  'mesh.inspect': MeshNetworkInspection
  'mesh.link': MeshNetworkLink
}
export type MeshNetworkPort = { call<M extends MeshNetworkMethod>(method: M, input: MeshNetworkParams[M], current?: () => Promise<void>): Promise<MeshNetworkResults[M]> }
export const isMeshNetworkMethod = (method: unknown): method is MeshNetworkMethod => typeof method === 'string' && Object.hasOwn(MESH_NETWORK_METHODS, method)
/** The owner attaches this only before dispatching a configuration replacement. */
export function meshConfigurationNotApplied(error: unknown): AgentMuxError {
  const original = error instanceof AgentMuxError ? error : undefined
  return new AgentMuxError(original?.message ?? 'Mesh save preparation failed before a configuration replacement was dispatched.', original?.code ?? 'MESH_SAVE_PREPARATION_UNAVAILABLE', original?.detail, { disposition: 'not_applied', confirmedInputBytes: null }, original?.logId, original?.creationFailure, original?.storageFailure, original?.executionFailure)
}
const invalid = (): never => { throw new AgentMuxError('Mesh network data is malformed or belongs to another original operation.', 'CONTROL_PROTOCOL_ERROR') }
function count(value: unknown, minimum = 0): number { if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid(); return Number(value) }
function list(value: unknown): unknown[] { if (!Array.isArray(value)) invalid(); return value as unknown[] }
function owner(value: unknown): MeshOwner { const p = rpcRecord(value, ['runtimeId', 'ownerInstanceId']); return { runtimeId: rpcString(p.runtimeId, 'Original Runtime'), ownerInstanceId: rpcString(p.ownerInstanceId, 'Original Core instance') } }
function identity(value: unknown): MeshPublicIdentity | null {
  if (value === null) return null
  const p = rpcRecord(value, ['peerId', 'publicKey', 'epoch']), publicKey = rpcString(p.publicKey, 'Mesh public key')
  if (relayMeshPeerId(publicKey) !== p.peerId) invalid()
  return { peerId: rpcString(p.peerId, 'Mesh peer'), publicKey, epoch: count(p.epoch) }
}
function issue(value: unknown) { const p = rpcRecord(value, ['code', 'message']); return { code: rpcString(p.code, 'Mesh issue'), message: rpcString(p.message, 'Mesh issue detail') } }
export function defaultMeshNetworkConfiguration(): MeshNetworkConfiguration { return { role: 'disabled', endpointAccess: { allowedClientKeys: [] }, networkId: 'default', members: [], peers: [], advertisedIngress: [], publishers: [] } }
export function parseMeshNetworkConfiguration(value: unknown): MeshNetworkConfiguration {
  const p = rpcRecord(value, ['role', 'endpointAccess', 'networkId', 'members', 'peers', 'advertisedIngress', 'publishers', 'listen'])
  if (p.role !== 'disabled' && p.role !== 'participant' && p.role !== 'gateway') invalid()
  const access = rpcRecord(p.endpointAccess, ['allowedClientKeys'])
  const allowedClientKeys = list(access.allowedClientKeys).map(value => { const key = rpcString(value, 'Original allowed device public key'), bytes = Buffer.from(key, 'base64'); if (bytes.length !== 32 || bytes.toString('base64') !== key) invalid(); return key })
  if (new Set(allowedClientKeys).size !== allowedClientKeys.length) invalid()
  const members = list(p.members).map(value => { const m = rpcRecord(value, ['peerId', 'publicKey']), publicKey = rpcString(m.publicKey, 'Mesh member public key'); if (relayMeshPeerId(publicKey) !== m.peerId) invalid(); return { peerId: rpcString(m.peerId, 'Mesh member'), publicKey } })
  const pins = new Set(members.map(member => member.peerId)); if (pins.size !== members.length) invalid()
  const peers = list(p.peers).map(value => { const peer = rpcRecord(value, ['peerId', 'endpoints']), peerId = rpcString(peer.peerId, 'Mesh peer'); if (!pins.has(peerId)) invalid(); return { peerId, endpoints: list(peer.endpoints).map(parseRelayMeshEndpoint) } })
  if (new Set(peers.map(peer => peer.peerId)).size !== peers.length) invalid()
  const advertisedIngress = p.advertisedIngress === undefined ? [] : list(p.advertisedIngress).map(parseRelayMeshEndpoint)
  const publishers = parseRelayGatewayConfiguration({ port: 0, publishers: p.publishers }).publishers
  let listen: MeshNetworkConfiguration['listen']
  if (p.listen !== undefined) {
    const l = rpcRecord(p.listen, ['host', 'port', 'tls']), host = rpcString(l.host, 'Mesh listener'), port = count(l.port)
    if (port > 65535 || p.role !== 'gateway') invalid()
    let tls: NonNullable<typeof listen>['tls']
    if (l.tls !== undefined) { const t = rpcRecord(l.tls, ['keyPath', 'certPath']), keyPath = rpcString(t.keyPath, 'Original TLS key path'), certPath = rpcString(t.certPath, 'Original TLS certificate path'); if (!isAbsolute(keyPath) || !isAbsolute(certPath)) invalid(); tls = { keyPath, certPath } }
    listen = { host, port, ...(tls ? { tls } : {}) }
  }
  if (p.role !== 'gateway' && advertisedIngress.length) invalid()
  return { role: p.role as MeshNetworkConfiguration['role'], endpointAccess: { allowedClientKeys }, networkId: rpcString(p.networkId, 'Mesh network'), members, peers, advertisedIngress, publishers, ...(listen ? { listen } : {}) }
}
export function parseMeshNetworkParams<M extends MeshNetworkMethod>(method: M, value: unknown): MeshNetworkParams[M] {
  const p = rpcRecord(value, method === 'settings.mesh.configure' ? ['expectedRevision', 'operationId', 'configuration'] : method === 'settings.mesh.inspect' ? ['operationId'] : method === 'mesh.link' ? ['offer'] : [])
  if (method === 'settings.mesh.configure') return { expectedRevision: rpcString(p.expectedRevision, 'Original Mesh revision'), operationId: rpcString(p.operationId, 'Original Mesh save'), configuration: parseMeshNetworkConfiguration(p.configuration) } as MeshNetworkParams[M]
  if (method === 'settings.mesh.inspect') return (p.operationId === undefined ? {} : { operationId: rpcString(p.operationId, 'Original Mesh save') }) as MeshNetworkParams[M]
  if (method === 'mesh.link') return { offer: parseConnectionOffer(p.offer) } as MeshNetworkParams[M]
  return {} as MeshNetworkParams[M]
}
function settings(value: unknown): MeshNetworkSettings {
  const p = rpcRecord(value, ['owner', 'identity', 'revision', 'configuration', 'operation'])
  let operation: MeshSaveOperation | null = null
  if (p.operation !== null) { const o = rpcRecord(p.operation, ['operationId', 'expectedRevision', 'revision', 'status', 'updatedAt', 'cause']); if (o.status !== 'confirmed' && o.status !== 'unknown' || o.status === 'confirmed' && o.cause !== undefined) invalid(); operation = { operationId: rpcString(o.operationId, 'Mesh save'), expectedRevision: rpcString(o.expectedRevision, 'Mesh previous revision'), revision: rpcString(o.revision, 'Mesh saved revision'), status: o.status as MeshSaveOperation['status'], updatedAt: count(o.updatedAt), ...(o.cause === undefined ? {} : { cause: issue(o.cause) }) } }
  return { owner: owner(p.owner), identity: identity(p.identity), revision: rpcString(p.revision, 'Mesh revision'), configuration: parseMeshNetworkConfiguration(p.configuration), operation }
}
export function parseMeshNetworkResult<M extends MeshNetworkMethod>(method: M, value: unknown, input: MeshNetworkParams[M]): MeshNetworkResults[M] {
  try {
    if (method === 'settings.mesh.inspect' || method === 'settings.mesh.configure') {
      const outer = method === 'settings.mesh.configure' ? rpcRecord(value, ['settings', 'diskDurability']) : null
      const result = settings(outer ? outer.settings : value), expected = input as MeshNetworkParams['settings.mesh.inspect'] & Partial<MeshNetworkParams['settings.mesh.configure']>
      if (expected.operationId && result.operation?.operationId !== expected.operationId && !(method === 'settings.mesh.inspect' && result.operation === null)) invalid()
      if (method === 'settings.mesh.configure') {
        if (!result.operation || result.operation.expectedRevision !== expected.expectedRevision || !['confirmed', 'unknown'].includes(outer!.diskDurability as string) || outer!.diskDurability !== result.operation.status) invalid()
        return { settings: result, diskDurability: outer!.diskDurability } as MeshNetworkResults[M]
      }
      return result as MeshNetworkResults[M]
    }
    if (method === 'mesh.inspect') {
      const p = rpcRecord(value, ['owner', 'identity', 'desiredRevision', 'activeRevision', 'source', 'apply', 'gateway', 'network', 'endpoint', 'observedAt', 'coverage'])
      if (p.source !== 'none' && p.source !== 'static' && p.source !== 'managed') invalid()
      const a = rpcRecord(p.apply, ['state', 'issue']); if (a.state !== 'disabled' && a.state !== 'starting' && a.state !== 'active' && a.state !== 'unavailable' || (a.state === 'unavailable') !== (a.issue !== undefined)) invalid()
      const c = rpcRecord(p.coverage, ['configuredOrigins', 'observedOrigins', 'complete']), configuredOrigins = count(c.configuredOrigins), observedOrigins = count(c.observedOrigins)
      if (typeof c.complete !== 'boolean' || c.complete !== (configuredOrigins === observedOrigins) || observedOrigins > configuredOrigins) invalid()
      const ep = rpcRecord(p.endpoint, ['state', 'offer', 'issue'])
      let endpoint: MeshEndpointObservation
      if (ep.state === 'available') { if (ep.issue !== undefined) invalid(); endpoint = { state: ep.state, offer: parseConnectionOffer(ep.offer) } }
      else { if (ep.state !== 'not-provided' && ep.state !== 'starting' && ep.state !== 'unavailable' || ep.offer !== undefined) invalid(); endpoint = { state: ep.state as 'not-provided' | 'starting' | 'unavailable', ...(ep.issue === undefined ? {} : { issue: issue(ep.issue) }) } }
      return { owner: owner(p.owner), identity: identity(p.identity), desiredRevision: p.desiredRevision === null ? null : rpcString(p.desiredRevision, 'Desired Mesh revision'), activeRevision: p.activeRevision === null ? null : rpcString(p.activeRevision, 'Active Mesh revision'), source: p.source, apply: { state: a.state, ...(a.issue === undefined ? {} : { issue: issue(a.issue) }) }, gateway: parseAgentMuxRelayInspection({ gateway: p.gateway }).gateway, network: p.network === null ? null : parseRelayMeshObservation(p.network), endpoint, observedAt: count(p.observedAt), coverage: { configuredOrigins, observedOrigins, complete: c.complete } } as MeshNetworkResults[M]
    }
    const p = rpcRecord(value, ['offer', 'url', 'observation']), o = rpcRecord(p.observation, ['owner', 'identity', 'activeRevision', 'observedAt', 'route', 'ingress'])
    const offer = parseConnectionOffer(p.offer), original = (input as MeshNetworkParams['mesh.link']).offer, publicIdentity = identity(o.identity)
    const ingress = parseRelayMeshEndpoint(o.ingress)
    const route = parseRelayMeshRoute(o.route)
    if (route.path.at(-1) !== route.originPeerId || !publicIdentity || offer.serverId !== original.serverId || offer.daemonPublicKeyB64 !== original.daemonPublicKeyB64 || route.serverId !== original.serverId || route.path[0] !== publicIdentity.peerId || !isDeepStrictEqual(offer.relay, ingress)) invalid()
    const url = rpcString(p.url, 'Complete Mesh offer URL'), parsed = new URL(url)
    if (!isDeepStrictEqual(parseConnectionOfferUrl(url), offer) || parsed.host !== ingress.endpoint || parsed.protocol !== (ingress.useTls ? 'https:' : 'http:')) invalid()
    return { offer, url, observation: { owner: owner(o.owner), identity: publicIdentity, activeRevision: rpcString(o.activeRevision, 'Active Mesh revision'), observedAt: count(o.observedAt), route, ingress } } as MeshNetworkResults[M]
  } catch { return invalid() }
}
