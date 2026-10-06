import { AgentMuxError } from '@agentmux/core'
import { parseConnectionObservation, type ConnectionConfig, type ConnectionObservation, type ConnectionRecord } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import type { DurableIngressHost } from './durable-ingress.js'

/** Private transport proof is owned by the registered adapter, never accepted through public RPC. */
export type ConnectionTransportEvent = { raw: string; transportProof?: unknown }
export type ConnectionIngressReceiver = { close(): void; observation(): ConnectionObservation }
export interface ConnectionIngressTransport {
  start(input: {
    config: ConnectionConfig
    credential: string
    signal: AbortSignal
    receive(input: ConnectionTransportEvent, acknowledge: () => void | Promise<void>): ReturnType<DurableIngressHost['receive']>
  }): Promise<ConnectionIngressReceiver>
}
type Lane = { record: ConnectionRecord; abort: AbortController; receiver?: ConnectionIngressReceiver; opening: boolean; failed?: 'credential-missing' | 'check-failed'; after?: string }
type ReceiverObservation = Pick<ConnectionObservation, 'authentication' | 'transport' | 'intake'>

/** Own only registered transport lifetimes. Durable intake and original Core queues retain their facts. */
export class ConnectionReceivers {
  private readonly lanes = new Map<string, Lane>()
  private closed = false
  private reading = false
  private dirty = false
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly connections: ConnectionHost, private readonly ingress: DurableIngressHost) {
    connections.receiverObservation = (id, revision) => this.observation(id, revision)
    this.timer = setInterval(() => this.refresh(), 5_000); this.timer.unref()
    this.refresh()
  }
  refresh(): void {
    if (this.closed) return
    this.dirty = true
    if (this.reading) return
    this.reading = true; this.dirty = false
    void this.connections.list().then(({ connections }) => {
      if (this.closed) return
      const current = new Map(connections.map(record => [record.config.connectionId, record]))
      for (const [id, lane] of this.lanes) if (current.get(id)?.revision !== lane.record.revision || !current.get(id)?.config.enabled) {
        this.release(lane); this.lanes.delete(id)
      }
      for (const record of connections) {
        const adapter = this.connections.registeredAdapter(record.config.adapterId)
        if (!record.config.enabled || !adapter?.ingress || !adapter.transport) continue
        let lane = this.lanes.get(record.config.connectionId)
        if (!lane) {
          lane = { record, abort: new AbortController(), opening: false }
          this.lanes.set(record.config.connectionId, lane)
        }
        if (!lane.receiver && !lane.opening) void this.start(lane, adapter.transport)
        // One bounded page per connection and recovery tick. Unknown qualification cannot starve later intake.
        try {
          const page = this.ingress.received(record.config.connectionId, lane.after)
          if (page.nextAfterIngressId) lane.after = page.nextAfterIngressId
          else delete lane.after
          for (const id of page.ingressIds) this.defer(lane, id)
        } catch { lane.failed = 'check-failed' }
      }
    }, () => { for (const lane of this.lanes.values()) lane.failed = 'check-failed' }).finally(() => {
      this.reading = false; if (this.dirty && !this.closed) this.refresh()
    })
  }
  private current(lane: Lane): boolean {
    if (this.closed || lane.abort.signal.aborted) return false
    const current = this.connections.readConfiguration(lane.record.config.connectionId)
    return current?.config.enabled === true && current.revision === lane.record.revision
  }
  private async start(lane: Lane, transport: ConnectionIngressTransport): Promise<void> {
    lane.opening = true
    try {
      const credential = await this.connections.resolveIngressCredential(lane.record.config.connectionId)
      if (!credential) { lane.failed = 'credential-missing'; return }
      if (!this.current(lane)) return
      const receiver = await transport.start({ config: structuredClone(lane.record.config), credential,
        signal: lane.abort.signal,
        receive: async (input, acknowledge) => {
          if (!this.current(lane)) throw new AgentMuxError('This original connection receiver is no longer current. Existing Agents are retained.', 'INGRESS_CONNECTION_REVISED')
          const accepted = await this.ingress.receive({ connectionId: lane.record.config.connectionId, raw: input.raw,
            ...(input.transportProof === undefined ? {} : { transportProof: input.transportProof }) }, acknowledge)
          // ACK covers durable retention alone. Leave the SDK callback before entering Core or reply observation.
          this.defer(lane, accepted.ingress.ingressId)
          return accepted
        }
      })
      if (!this.current(lane)) { receiver.close(); return }
      lane.receiver = receiver; delete lane.failed
    } catch { if (!lane.abort.signal.aborted) lane.failed = 'check-failed' }
    finally { lane.opening = false }
  }
  private defer(lane: Lane, ingressId: string): void {
    setImmediate(() => {
      if (this.closed || lane.abort.signal.aborted) return
      void this.ingress.dispatch(ingressId).then(() => { delete lane.failed }, () => { if (!lane.abort.signal.aborted) lane.failed = 'check-failed' })
    }).unref()
  }
  observation(connectionId: string, revision: number): ReceiverObservation | null {
    const lane = this.lanes.get(connectionId)
    if (!lane || lane.record.revision !== revision) return null
    if (lane.failed) return { authentication: { state: 'unknown', reason: 'not-tested' }, transport: { state: 'unavailable', reason: lane.failed }, intake: { state: 'unknown', reason: 'not-started' } }
    if (!lane.receiver) return { authentication: { state: 'unknown', reason: 'not-tested' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' } }
    try {
      const { authentication, transport, intake } = parseConnectionObservation(lane.receiver.observation())
      return { authentication, transport, intake }
    } catch { return { authentication: { state: 'unknown', reason: 'not-tested' }, transport: { state: 'unknown', reason: 'check-failed' }, intake: { state: 'unknown', reason: 'not-started' } } }
  }
  private release(lane: Lane): void {
    lane.abort.abort()
    try { lane.receiver?.close() } catch { /* This receiver does not own any Agent lifecycle. */ }
  }
  close(): void {
    if (this.closed) return
    this.closed = true; clearInterval(this.timer)
    for (const lane of this.lanes.values()) this.release(lane)
    this.lanes.clear(); this.connections.receiverObservation = undefined
  }
}
