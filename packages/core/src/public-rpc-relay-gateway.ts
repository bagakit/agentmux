import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { isAbsolute } from 'node:path'
import type { Socket } from 'node:net'
import { attachRelayGateway, parseRelayGatewayConfiguration, type RelayPublisherGrant } from '@agentmux/relay/gateway'
import { AgentMuxError } from './errors.js'

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

/** One optional transport owner, embedded in the original Core control server. */
export class CoreRelayGateway {
  private state: AgentMuxRelayGatewayObservation
  private startup: Promise<void> | undefined
  private readonly shutdown = new AbortController()
  private ownedListener: Server | undefined
  private readonly sockets = new Set<Socket>()
  private gateway: ReturnType<typeof attachRelayGateway> | undefined
  private releaseObservation: (() => void) | undefined
  constructor(private readonly source: AgentMuxRelayGatewaySource | undefined) {
    this.state = { state: source === undefined ? 'disabled' : 'starting' }
  }
  inspect(): AgentMuxRelayInspection { return { gateway: structuredClone(this.state) } }
  /** Start asynchronously: optional configuration/IO never holds the original Core startup. */
  start(shared?: { server: Server; tls: boolean }): void {
    if (this.source === undefined || this.startup || this.shutdown.signal.aborted) return
    this.startup = this.open(shared).catch(async () => {
      if (!this.shutdown.signal.aborted) this.unavailable('RELAY_GATEWAY_UNAVAILABLE', 'Relay gateway configuration or listener is unavailable. The original Unix Core and Sessions remain available.')
      await this.release()
    })
  }
  private unavailable(code: string, message: string): void { this.state = { state: 'unavailable', issue: { code, message } } }
  private async open(shared?: { server: Server; tls: boolean }): Promise<void> {
    let source: unknown = this.source
    if (source && typeof source === 'object' && 'configurationPath' in source) {
      const p = record(source, ['configurationPath'])
      if (!text(p.configurationPath) || !isAbsolute(p.configurationPath)) throw new Error('Gateway configuration requires its exact absolute path.')
      source = JSON.parse(await readFile(p.configurationPath, { encoding: 'utf8', signal: this.shutdown.signal }))
    }
    const config = configuration(source)
    this.shutdown.signal.throwIfAborted()
    let server: Server, tls: boolean
    if (config.listen) {
      const receive = (_request: unknown, response: import('node:http').ServerResponse) => { response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end() }
      server = config.listen.tls ? createHttpsServer(config.listen.tls, receive) : createServer(receive)
      this.ownedListener = server; tls = config.listen.tls !== undefined
      server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)) })
    } else {
      if (!shared) throw new Error('No explicitly configured HTTP listener can be borrowed.')
      server = shared.server; tls = shared.tls
    }
    this.gateway = attachRelayGateway(server, { publishers: config.publishers })
    const unavailable = () => { if (!this.shutdown.signal.aborted) this.unavailable('RELAY_GATEWAY_LISTENER_UNAVAILABLE', 'The original Relay gateway listener is unavailable. Other Core services and Sessions are retained.') }
    server.on('close', unavailable); server.on('error', unavailable)
    this.releaseObservation = () => { server.off('close', unavailable); server.off('error', unavailable) }
    if (config.listen) await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { server.off('error', failed); this.shutdown.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve() }
      const failed = (error: Error) => finish(error)
      const aborted = () => { server.close(() => {}); finish(new Error('Gateway startup stopped.')) }
      server.once('error', failed); this.shutdown.signal.addEventListener('abort', aborted, { once: true })
      server.listen(config.listen!.port, config.listen!.host, () => this.shutdown.signal.aborted ? aborted() : finish())
    })
    this.shutdown.signal.throwIfAborted()
    const address = server.address()
    if (!server.listening || !address || typeof address === 'string') throw new Error('Gateway listener is unconfirmed.')
    this.state = { state: 'listening', listener: { host: address.address, port: address.port, tls } }
  }
  private async release(): Promise<void> {
    this.releaseObservation?.(); this.releaseObservation = undefined
    const gateway = this.gateway; this.gateway = undefined
    await gateway?.stop()
    const server = this.ownedListener; this.ownedListener = undefined
    if (server) {
      for (const socket of this.sockets) socket.destroy()
      this.sockets.clear()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
  async stop(): Promise<void> {
    this.shutdown.abort(); await this.startup; await this.release()
    if (this.source !== undefined) this.unavailable('RELAY_GATEWAY_STOPPED', 'The original Relay gateway has stopped. Other Core services and Sessions are retained.')
  }
}
