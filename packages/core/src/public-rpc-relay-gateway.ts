import { randomBytes } from 'node:crypto'
import { startAgentMuxRpcRelayPublisher, type AgentMuxRelayDeviceAuthorization } from './rpc-relay-publisher.js'
import { exportPublicKey, type KeyPair } from '@agentmux/relay/e2ee'
import type { AgentMuxControlServer } from './public-rpc-server.js'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { isAbsolute } from 'node:path'
import type { Socket } from 'node:net'
import { createRelayGateway, parseRelayGatewayConfiguration, parseRelayMeshConfiguration, type RelayPublisherGrant, hashPublisherToken } from '@agentmux/relay/gateway'
import { AgentMuxError } from './errors.js'
import { connectionOfferUrl, parseConnectionOffer } from '@agentmux/relay/offer'
import { isDeepStrictEqual } from 'node:util'
import { MeshNetworkState } from './mesh-network-state.js'
import { parseMeshNetworkResult, type MeshNetworkConfiguration, type MeshNetworkInspection, type MeshNetworkMethod, type MeshNetworkParams, type MeshNetworkPort, type MeshNetworkResults, type MeshOwner, type MeshApplyObservation, type MeshEndpointObservation } from './mesh-network.js'

export type AgentMuxMeshEndpointSource = (signal?: AbortSignal) => Promise<{ serverId: string; keyPair: KeyPair; authorize: AgentMuxRelayDeviceAuthorization }>

export type AgentMuxRelayGatewayConfiguration = {
  publishers: readonly RelayPublisherGrant[]
  /** Omit only to borrow this Core's explicitly configured HTTP listener. */
  listen?: { host: string; port: number; tls?: { key: string; cert: string } }
}
export type AgentMuxRelayGatewaySource = AgentMuxRelayGatewayConfiguration | { configurationPath: string }
export type AgentMuxRelayGatewayObservation = {
  state: 'disabled' | 'starting' | 'listening' | 'unavailable'
  listener?: { host: string; port: number; tls: boolean }
  issue?: { code: string; message: string }
}
export type AgentMuxRelayInspection = { gateway: AgentMuxRelayGatewayObservation }

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new AgentMuxError('Relay gateway data is malformed.', 'CONTROL_PROTOCOL_ERROR')
  return value as Record<string, unknown>
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/u.test(value)

export function parseAgentMuxRelayInspection(value: unknown): AgentMuxRelayInspection {
  const p = record(value, ['gateway']), gateway = record(p.gateway, ['state', 'listener', 'issue'])
  if (typeof gateway.state !== 'string' || !['disabled', 'starting', 'listening', 'unavailable'].includes(gateway.state)) throw new AgentMuxError('Relay gateway state is malformed.', 'CONTROL_PROTOCOL_ERROR')
  if ((gateway.state === 'listening') !== (gateway.listener !== undefined) || (gateway.state === 'unavailable') !== (gateway.issue !== undefined))
    throw new AgentMuxError('Relay gateway observation has inconsistent state.', 'CONTROL_PROTOCOL_ERROR')
  if (gateway.listener !== undefined) {
    const listener = record(gateway.listener, ['host', 'port', 'tls'])
    if (!text(listener.host) || !Number.isInteger(listener.port) || Number(listener.port) < 1 || Number(listener.port) > 65535 || typeof listener.tls !== 'boolean')
      throw new AgentMuxError('Relay gateway listener is malformed.', 'CONTROL_PROTOCOL_ERROR')
  }
  if (gateway.issue !== undefined) {
    const issue = record(gateway.issue, ['code', 'message'])
    if (!text(issue.code) || !text(issue.message)) throw new AgentMuxError('Relay gateway issue is malformed.', 'CONTROL_PROTOCOL_ERROR')
  }
  return structuredClone(value) as AgentMuxRelayInspection
}

function configuration(value: unknown): AgentMuxRelayGatewayConfiguration {
  const p = record(value, ['publishers', 'listen'])
  const checked = parseRelayGatewayConfiguration({ port: 0, publishers: p.publishers })
  if (p.listen === undefined) return { publishers: checked.publishers }
  const listen = record(p.listen, ['host', 'port', 'tls'])
  if (!text(listen.host) || !Number.isInteger(listen.port) || Number(listen.port) < 0 || Number(listen.port) > 65535)
    throw new Error('Relay gateway binding is invalid.')
  let tls: { key: string; cert: string } | undefined
  if (listen.tls !== undefined) {
    const source = record(listen.tls, ['key', 'cert'])
    if (typeof source.key !== 'string' || !source.key || typeof source.cert !== 'string' || !source.cert) throw new Error('Relay gateway TLS configuration is invalid.')
    tls = { key: source.key, cert: source.cert }
  }
  return { publishers: checked.publishers, listen: { host: listen.host, port: Number(listen.port), ...(tls ? { tls } : {}) } }
}

/** One optional network/listener owner, embedded in the original Core control server. */
export class CoreRelayGateway implements MeshNetworkPort {
  private state: AgentMuxRelayGatewayObservation
  private startup: Promise<void> | undefined
  private readonly shutdown = new AbortController()
  private runtime: ReturnType<typeof createRelayGateway> | undefined
  private attachment: { detach(): void } | undefined
  private activeListener: { server: Server; tls: boolean; binding: unknown; owned: boolean } | undefined
  private readonly listeners = new Map<Server, Set<Socket>>()
  private releaseObservation: (() => void) | undefined
  private shared: { server: Server; tls: boolean } | undefined
  private readonly settings: MeshNetworkState | undefined
  private applyState: MeshApplyObservation = { state: 'disabled' }
  private sourceKind: MeshNetworkInspection['source'] = 'none'
  private desiredRevision: string | null = null
  private activeRevision: string | null = null
  private activeConfiguration: MeshNetworkConfiguration | undefined
  private activeMesh: import('@agentmux/relay/gateway').RelayMeshConfiguration | undefined
  private endpointObservation: MeshEndpointObservation
  private endpointOpening: ReturnType<AgentMuxMeshEndpointSource> | undefined
  private endpointValue: Awaited<ReturnType<AgentMuxMeshEndpointSource>> | undefined
  private endpointPublisher: ReturnType<typeof startAgentMuxRpcRelayPublisher> | undefined
  private endpointListener: Awaited<ReturnType<CoreRelayGateway['listener']>> | undefined
  private endpointAttachment: { detach(): void } | undefined
  private readonly endpointToken = randomBytes(32).toString('base64url')
  private allowedDeviceKeys = new Set<string>()
  private readonly endpointReaders = new Set<{ publicKey: string; controller: AbortController }>()
  private application: Promise<void> = Promise.resolve()
  constructor(private readonly source: AgentMuxRelayGatewaySource | undefined, private readonly meshState?: { directory: string; owner: MeshOwner; write?: typeof import('./durable-write.js').durableWriteFile }, private readonly localEndpoint?: { source: AgentMuxMeshEndpointSource; server: Pick<AgentMuxControlServer, 'openAuthenticatedFrames'> }) {
    this.state = { state: source === undefined ? 'disabled' : 'starting' }
    this.endpointObservation = { state: localEndpoint ? 'unavailable' : 'not-provided', ...(localEndpoint ? { issue: { code: 'MESH_ENDPOINT_DISABLED', message: 'Enable this original Host endpoint through explicit Mesh settings and allowed device keys.' } } : {}) }
    if (meshState) this.settings = new MeshNetworkState({ ...meshState, signal: this.shutdown.signal, validate: async config => {
      if (config.role !== 'disabled') {
        await this.settings!.initializeIdentity()
        const identity = this.settings!.publicIdentity()!
        if (!config.members.some(member => member.peerId === identity.peerId && member.publicKey === identity.publicKey) || config.peers.some(peer => peer.peerId === identity.peerId)) throw new AgentMuxError('This Mesh configuration must pin its original local network identity.', 'MESH_IDENTITY_MISMATCH')
        if (this.activeConfiguration?.role !== 'disabled' && this.activeConfiguration && this.activeConfiguration.networkId !== config.networkId) throw new AgentMuxError('A live network identity cannot change its network domain. Its current paths and Core remain available.', 'MESH_DOMAIN_MISMATCH')
      }
    }, adopt: state => this.adopt(state) })
  }
  localPeer(): { networkId: string; peerId: string } | undefined {
    return this.activeMesh && { networkId: this.activeMesh.networkId, peerId: this.activeMesh.identity.peerId }
  }
  inspect(): AgentMuxRelayInspection { return { gateway: structuredClone(this.state) } }
  start(shared?: { server: Server; tls: boolean }): void {
    if (this.startup || this.shutdown.signal.aborted) return
    this.shared = shared
    this.startup = (async () => {
      if (this.source !== undefined) try { await this.openStatic() } catch {
        if (!this.shutdown.signal.aborted) this.unavailable('RELAY_GATEWAY_UNAVAILABLE', 'Relay gateway configuration or listener is unavailable. The original Unix Core and Sessions remain available.')
      }
      if (!this.settings || this.shutdown.signal.aborted) return
      try { await this.settings.initializeIdentity() } catch {
        if (!this.shutdown.signal.aborted) this.applyState = { state: 'unavailable', issue: { code: 'MESH_IDENTITY_UNCONFIRMED', message: 'The original Mesh identity is unavailable. Preserve its file; original Core capabilities remain available.' } }
      }
      if (this.shutdown.signal.aborted) return
      try {
        const desired = await this.settings.desired()
        if (this.shutdown.signal.aborted) return
        if (desired) {
          this.desiredRevision = desired.revision
          if (desired.confirmed) this.adopt(desired)
          else this.applyState = { state: 'unavailable', issue: { code: 'MESH_SAVE_UNCONFIRMED', message: 'The original Mesh save is unconfirmed. Inspect that original operation; no network setting was replayed.' } }
        }
      } catch {
        if (!this.shutdown.signal.aborted) this.applyState = { state: 'unavailable', issue: { code: 'MESH_SETTINGS_UNAVAILABLE', message: 'The original Mesh settings are unreadable. Preserve their file; other Core capabilities remain available.' } }
      }
    })()
    void this.startup.catch(() => {})
  }
  private unavailable(code: string, message: string): void { this.state = { state: 'unavailable', issue: { code, message } } }
  private async listener(binding: { host: string; port: number; tls?: { key: string; cert: string } } | undefined, sameBinding: unknown) {
    if (this.activeListener && isDeepStrictEqual(this.activeListener.binding, sameBinding)) return this.activeListener
    if (!binding) {
      if (!this.shared?.server.listening) throw new Error('No explicitly configured HTTP listener can be borrowed.')
      return { ...this.shared, binding: sameBinding, owned: false }
    }
    this.shutdown.signal.throwIfAborted()
    const receive = (_request: unknown, response: import('node:http').ServerResponse) => { response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end() }
    const server = binding.tls ? createHttpsServer(binding.tls, receive) : createServer(receive), sockets = new Set<Socket>()
    this.listeners.set(server, sockets)
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { server.off('error', failed); this.shutdown.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve() }
        const failed = (error: Error) => finish(error)
        const aborted = () => { server.close(() => {}); finish(new Error('Gateway startup stopped.')) }
        server.once('error', failed); this.shutdown.signal.addEventListener('abort', aborted, { once: true })
        server.listen(binding.port, binding.host, () => this.shutdown.signal.aborted ? aborted() : finish())
      })
      this.shutdown.signal.throwIfAborted()
      return { server, tls: binding.tls !== undefined, binding: sameBinding, owned: true }
    } catch (error) { for (const socket of sockets) socket.destroy(); server.close(() => {}); this.listeners.delete(server); throw error }
  }
  private installListener(next: { server: Server; tls: boolean; binding: unknown; owned: boolean } | undefined) {
    if (this.activeListener?.server === next?.server) { if (!next) this.state = { state: 'disabled' }; return }
    const previous = this.activeListener
    this.releaseObservation?.(); this.releaseObservation = undefined
    this.attachment?.detach(); this.attachment = undefined
    this.activeListener = next
    if (next) {
      this.attachment = this.runtime!.attach(next.server)
      const unavailable = () => { if (!this.shutdown.signal.aborted && this.activeListener === next) this.unavailable('RELAY_GATEWAY_LISTENER_UNAVAILABLE', 'The original network listener is unavailable. Other Core services and Sessions are retained.') }
      next.server.on('close', unavailable); next.server.on('error', unavailable)
      this.releaseObservation = () => { next.server.off('close', unavailable); next.server.off('error', unavailable) }
      const address = next.server.address()
      if (!address || typeof address === 'string' || !next.server.listening) throw new Error('Original listener is not confirmed.')
      this.state = { state: 'listening', listener: { host: address.address, port: address.port, tls: next.tls } }
    } else this.state = { state: 'disabled' }
    // Retired acceptance stops immediately; already accepted healthy sockets keep their runtime owner.
    if (previous?.owned) previous.server.close(() => { this.listeners.delete(previous.server) })
  }
  private async openStatic(): Promise<void> {
    let source: unknown = this.source
    if (source && typeof source === 'object' && 'configurationPath' in source) {
      const p = record(source, ['configurationPath'])
      if (!text(p.configurationPath) || !isAbsolute(p.configurationPath)) throw new Error('Gateway configuration requires its exact absolute path.')
      source = JSON.parse(await readFile(p.configurationPath, { encoding: 'utf8', signal: this.shutdown.signal }))
    }
    const config = configuration(source)
    const next = await this.listener(config.listen, config.listen ?? 'borrowed')
    if (this.shutdown.signal.aborted || this.desiredRevision !== null) { if (next.owned) next.server.close(() => {}); return }
    this.runtime = createRelayGateway({ publishers: config.publishers })
    this.installListener(next); this.sourceKind = 'static'
  }
  private adopt(state: { revision: string; configuration: MeshNetworkConfiguration }) {
    if (this.shutdown.signal.aborted || this.activeRevision === state.revision) return
    this.desiredRevision = state.revision
    this.applyState = { state: 'starting' }
    this.application = this.application.then(async () => {
      await this.startup
      if (this.shutdown.signal.aborted || this.activeRevision === state.revision) return
      try { await this.apply(state) }
      catch {
        // Retain the previously active runtime on optional apply failure.
        if (!this.shutdown.signal.aborted) this.applyState = { state: 'unavailable', issue: { code: 'MESH_APPLY_UNAVAILABLE', message: 'The saved Mesh revision could not be applied. The prior active listener, network paths and Core remain available; inspect the original settings.' } }
      }
    })
    void this.application.catch(() => {})
  }
  private async endpoint(): Promise<Awaited<ReturnType<AgentMuxMeshEndpointSource>> | undefined> {
    if (!this.localEndpoint) return undefined
    if (this.endpointValue) return this.endpointValue
    this.endpointObservation = { state: 'starting' }
    this.endpointOpening ??= Promise.resolve().then(() => this.localEndpoint!.source(this.shutdown.signal)).catch(error => { this.endpointOpening = undefined; throw error })
    const original = this.endpointOpening
    const value = await new Promise<Awaited<ReturnType<AgentMuxMeshEndpointSource>>>((resolve, reject) => {
      const aborted = () => reject(this.shutdown.signal.reason)
      this.shutdown.signal.addEventListener('abort', aborted, { once: true })
      original.then(resolve, reject).finally(() => this.shutdown.signal.removeEventListener('abort', aborted))
      if (this.shutdown.signal.aborted) aborted()
    }).catch(error => { if (!this.shutdown.signal.aborted) this.endpointObservation = { state: 'unavailable', issue: { code: 'MESH_ENDPOINT_UNAVAILABLE', message: 'This original Host endpoint identity is unavailable. Preserve its files and inspect the original owner.' } }; throw error })
    this.shutdown.signal.throwIfAborted()
    this.endpointValue = value
    return value
  }
  private async publishEndpoint(value: Awaited<ReturnType<AgentMuxMeshEndpointSource>>, listener: Awaited<ReturnType<CoreRelayGateway['listener']>>) {
    const address = listener.server.address()
    if (!address || typeof address === 'string') throw new Error('Original private endpoint listener unavailable')
    const relay = { endpoint: `127.0.0.1:${address.port}`, useTls: false }
    const offer = parseConnectionOffer({ v: 2, serverId: value.serverId, daemonPublicKeyB64: exportPublicKey(value.keyPair.publicKey), relay })
    this.endpointPublisher = startAgentMuxRpcRelayPublisher({ server: this.localEndpoint!.server, serverId: value.serverId, keyPair: value.keyPair, relay, publisherToken: this.endpointToken,
      onState: state => { if (this.shutdown.signal.aborted) return; this.endpointObservation = state === 'connected' ? { state: 'available', offer } : { state: state === 'starting' ? 'starting' : 'unavailable', ...(state === 'disconnected' ? { issue: { code: 'MESH_ENDPOINT_DISCONNECTED', message: 'This original Host endpoint publisher is disconnected; Sessions remain retained.' } } : {}) } },
      authorize: async (publicKey, metadata) => {
        if (!this.allowedDeviceKeys.has(publicKey)) throw new AgentMuxError('This device key is not admitted by this original Host Mesh endpoint.', 'CONTROL_PERMISSION_DENIED')
        const authorization = await value.authorize(publicKey, metadata)
        if (this.shutdown.signal.aborted || !this.allowedDeviceKeys.has(publicKey) || authorization.principal.kind !== 'device') { await authorization.dispose?.(); throw new AgentMuxError('This original Mesh device pin was revoked.', 'CONTROL_PERMISSION_DENIED') }
        const reader = { publicKey, controller: new AbortController() }; this.endpointReaders.add(reader)
        return { principal: authorization.principal, signal: AbortSignal.any([this.shutdown.signal, reader.controller.signal, ...(authorization.signal ? [authorization.signal] : [])]),
          assertCurrent: async () => { if (!this.allowedDeviceKeys.has(publicKey)) throw new AgentMuxError('The original endpoint device pin was revoked.', 'CONTROL_PERMISSION_DENIED'); await authorization.assertCurrent?.() },
          dispose: async () => { this.endpointReaders.delete(reader); await authorization.dispose?.() } }
      } })
  }
  private async apply(state: { revision: string; configuration: MeshNetworkConfiguration }) {
    const config = state.configuration
    let mesh: import('@agentmux/relay/gateway').RelayMeshConfiguration | undefined
    if (config.role !== 'disabled') mesh = parseRelayMeshConfiguration({ networkId: config.networkId, identity: await this.settings!.reserveEpoch(), members: config.members, peers: config.peers, advertisedIngress: config.advertisedIngress })
    this.shutdown.signal.throwIfAborted()
    // Network forwarding never waits for the optional original RPC identity.
    const endpoint = config.role !== 'disabled' ? this.endpointValue : undefined
    const publishers = [...config.publishers]
    if (endpoint && publishers.some(p => p.serverId === endpoint.serverId)) throw new AgentMuxError('Public gateway admission cannot replace the original local endpoint publisher.', 'MESH_ENDPOINT_COLLISION')
    if (endpoint) publishers.push({ serverId: endpoint.serverId, tokenHash: hashPublisherToken(this.endpointToken) })
    let binding: Parameters<CoreRelayGateway['listener']>[0]
    if (config.listen) {
      let tls: { key: string; cert: string } | undefined
      if (config.listen.tls) {
        const [key, cert] = await Promise.all([readFile(config.listen.tls.keyPath, { encoding: 'utf8', signal: this.shutdown.signal }), readFile(config.listen.tls.certPath, { encoding: 'utf8', signal: this.shutdown.signal })]); tls = { key, cert }
      }
      binding = { host: config.listen.host, port: config.listen.port, ...(tls ? { tls } : {}) }
    }
    const next = config.role === 'gateway' ? await this.listener(binding, config.listen ?? 'borrowed') : undefined
    try {
      this.shutdown.signal.throwIfAborted()
      if (this.runtime) await this.runtime.configure({ publishers, ...(mesh ? { mesh } : {}) })
      else this.runtime = createRelayGateway({ publishers, ...(mesh ? { mesh } : {}) })
      this.shutdown.signal.throwIfAborted()
      this.installListener(next)
      this.allowedDeviceKeys = new Set(config.endpointAccess.allowedClientKeys)
      for (const reader of this.endpointReaders) if (!this.allowedDeviceKeys.has(reader.publicKey)) reader.controller.abort()
      if (config.role === 'disabled' && this.endpointPublisher) { await this.endpointPublisher.stop(); this.endpointPublisher = undefined }
      if (config.role === 'disabled' && this.localEndpoint) this.endpointObservation = { state: 'unavailable', issue: { code: 'MESH_ENDPOINT_DISABLED', message: 'This original Core Mesh endpoint is disabled; Sessions remain retained.' } }
      this.shutdown.signal.throwIfAborted()
      this.activeMesh = mesh
      this.activeRevision = state.revision; this.activeConfiguration = structuredClone(config); this.sourceKind = 'managed'
      this.applyState = { state: config.role === 'disabled' ? 'disabled' : 'active' }
      if (config.role !== 'disabled' && this.localEndpoint) this.scheduleEndpoint(state.revision)
    } catch (error) { if (next?.owned && next.server !== this.activeListener?.server) { next.server.close(() => {}); this.listeners.delete(next.server) }; throw error }
  }
  private scheduleEndpoint(revision: string): void {
    void this.endpoint().then(value => {
      if (!value || this.shutdown.signal.aborted) return
      this.application = this.application.then(async () => {
        if (this.shutdown.signal.aborted || this.activeRevision !== revision || this.desiredRevision !== revision) return
        if (this.endpointPublisher) return
        const config = this.activeConfiguration!
        if (config.role === 'disabled') return
        if (config.publishers.some(p => p.serverId === value.serverId)) throw new AgentMuxError('Public gateway admission cannot replace the original local endpoint publisher.', 'MESH_ENDPOINT_COLLISION')
        const publishers = [...config.publishers, { serverId: value.serverId, tokenHash: hashPublisherToken(this.endpointToken) }]
        // Reuse the exact active network identity/epoch, not another Mesh owner.
        await this.runtime!.configure({ publishers, ...(this.activeMesh ? { mesh: this.activeMesh } : {}) })
        this.endpointListener ??= await this.listener({ host: '127.0.0.1', port: 0 }, 'private-original-endpoint')
        this.shutdown.signal.throwIfAborted()
        this.endpointAttachment ??= this.runtime!.attach(this.endpointListener.server)
        await this.publishEndpoint(value, this.endpointListener)
      }).catch(() => {
        if (!this.shutdown.signal.aborted && this.activeRevision === revision) this.endpointObservation = { state: 'unavailable', issue: { code: 'MESH_ENDPOINT_UNAVAILABLE', message: 'The optional original RPC endpoint is unavailable. Original network forwarding, Unix Core and Sessions remain available.' } }
      })
    }).catch(() => {})
  }
  private inspection(): MeshNetworkInspection {
    if (!this.meshState) throw new AgentMuxError('This original Core has no durable Mesh settings owner.', 'MESH_OWNER_UNAVAILABLE')
    const network = this.runtime?.inspectMesh() ?? null, configuredOrigins = this.activeConfiguration?.role !== 'disabled' ? this.activeConfiguration?.members.length ?? 0 : 0
    const observedOrigins = network?.records.filter(record => this.activeConfiguration?.members.some(member => member.peerId === record.originPeerId)).length ?? 0
    return { owner: this.meshState.owner, identity: this.settings?.publicIdentity() ?? null, desiredRevision: this.desiredRevision, activeRevision: this.activeRevision, source: this.sourceKind, apply: structuredClone(this.applyState), gateway: structuredClone(this.state), network, endpoint: structuredClone(this.endpointObservation), observedAt: Date.now(), coverage: { configuredOrigins, observedOrigins, complete: configuredOrigins === observedOrigins } }
  }
  async call<M extends MeshNetworkMethod>(method: M, input: MeshNetworkParams[M], current: () => Promise<void> = async () => {}): Promise<MeshNetworkResults[M]> {
    if (!this.settings) throw new AgentMuxError('This original Core has no durable Mesh settings owner.', 'MESH_OWNER_UNAVAILABLE')
    await current()
    let result: unknown
    if (method === 'settings.mesh.inspect') result = await this.settings.inspect((input as MeshNetworkParams['settings.mesh.inspect']).operationId, current)
    else if (method === 'settings.mesh.configure') {
      // Complete initial identity provisioning before the first settings file can name it.
      // A damaged existing identity still permits an explicit disabled configuration.
      await this.settings.initializeIdentity().catch(() => {})
      result = await this.settings.configure(input as MeshNetworkParams['settings.mesh.configure'], current)
      const saved = (result as MeshNetworkResults['settings.mesh.configure']).settings
      if (saved.operation?.status === 'unknown') { this.desiredRevision = saved.revision; this.applyState = { state: 'unavailable', issue: { code: 'MESH_SAVE_UNCONFIRMED', message: 'The original Mesh save has an unknown disk acknowledgement. Inspect its operation; no new network configuration was applied.' } } }
    } else if (method === 'mesh.inspect') result = this.inspection()
    else {
      const { offer: original, ingress: requested } = input as MeshNetworkParams['mesh.link']
      const route = this.runtime?.resolvePublisher(original.serverId)
      const advertised = this.activeConfiguration?.advertisedIngress
      const ingress = requested ? advertised?.find(item => item.endpoint === requested.endpoint && item.useTls === requested.useTls) : advertised?.[0]
      const identity = this.settings.publicIdentity()
      if (this.shutdown.signal.aborted || !route || !ingress || !identity || !this.activeRevision || this.state.state !== 'listening') throw new AgentMuxError('This original publisher has no confirmed Mesh path and explicitly advertised local ingress. Keep the original offer; other paths and Sessions remain available.', 'MESH_LINK_UNAVAILABLE')
      const offer = parseConnectionOffer({ ...original, relay: ingress }), url = connectionOfferUrl(`${ingress.useTls ? 'https' : 'http'}://${ingress.endpoint}/`, offer)
      result = { offer, url, observation: { owner: this.meshState!.owner, identity, activeRevision: this.activeRevision, observedAt: Date.now(), route, ingress } }
    }
    if (method !== 'settings.mesh.configure') await current()
    return parseMeshNetworkResult(method, result, input)
  }
  async stop(): Promise<void> {
    this.shutdown.abort()
    this.releaseObservation?.(); this.releaseObservation = undefined
    this.attachment?.detach(); this.attachment = undefined
    for (const reader of this.endpointReaders) reader.controller.abort()
    this.endpointReaders.clear(); this.allowedDeviceKeys.clear()
    await this.endpointPublisher?.stop(); this.endpointPublisher = undefined
    this.endpointAttachment?.detach(); this.endpointAttachment = undefined
    const runtime = this.runtime; this.runtime = undefined
    await runtime?.stop()
    await this.settings?.drainMutations()
    for (const [server, sockets] of this.listeners) { for (const socket of sockets) socket.destroy(); server.close(() => {}) }
    this.listeners.clear(); this.activeListener = undefined
    if (this.source !== undefined || this.activeRevision !== null) this.unavailable('RELAY_GATEWAY_STOPPED', 'The original network gateway stopped. Other Core services and Sessions are retained.')
    if (this.localEndpoint) this.endpointObservation = { state: 'unavailable', issue: { code: 'MESH_ENDPOINT_STOPPED', message: 'This original Host Mesh endpoint stopped; original Sessions remain retained.' } }
    if (this.meshState) this.applyState = { state: 'unavailable', issue: { code: 'MESH_STOPPED', message: 'This original Mesh network stopped; original Core objects are retained.' } }
  }
}
