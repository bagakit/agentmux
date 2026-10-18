import { AgentMuxError } from '@agentmux/core'
import { parseConnectionObservation, type ConnectionConfig, type ConnectionObservation, type ConnectionRecord } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import type { DurableIngressHost } from './durable-ingress.js'
import type { ChannelStoragePort } from './channel-storage.js'
import type { ChannelMetadataSubject } from '@agentmux/core/connections'

/** Private transport proof is owned by the registered adapter, never accepted through public RPC. */
export type ConnectionTransportEvent = { raw: string; transportProof?: unknown }
export type ConnectionIngressReceiver = { close(): void; observation(): ConnectionObservation; closed?: AbortSignal }
export interface ConnectionIngressTransport {
  start(input: {
    config: ConnectionConfig
    credential: string
    signal: AbortSignal
    storage(): ChannelStoragePort
    metadataChanged?(subject: ChannelMetadataSubject): void
    receive(input: ConnectionTransportEvent, acknowledge: () => void | Promise<void>): ReturnType<DurableIngressHost['receive']>
  }): Promise<ConnectionIngressReceiver>
}
type Lane = { record: ConnectionRecord; abort: AbortController; receiver?: ConnectionIngressReceiver; opening: boolean; failed?: 'credential-missing' | 'check-failed'; recoveryFailed?: boolean; dispatchFailures: Set<string>; rechecks?: Iterator<string>; after?: string }
type ReceiverObservation = Pick<ConnectionObservation, 'authentication' | 'transport' | 'intake'>
const RECOVERY_BATCH = 25

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
    try {
      if (!this.connections.readService().enabled) {
        for (const lane of this.lanes.values()) this.release(lane)
        this.lanes.clear(); return
      }
    } catch { return } // Policy unknown retains existing lanes; each new admission still reads the original owner.
    this.dirty = true
    if (this.reading) return
    this.reading = true; this.dirty = false
    void this.connections.list().then(({ connections }) => {
      if (this.closed) return
      const current = new Map(connections.map(record => [record.config.connectionId, record]))
      for (const [id, lane] of this.lanes) if (current.get(id)?.revision !== lane.record.revision || !current.get(id)?.config.enabled) {
        this.release(lane); this.lanes.delete(id)
      }
      for (const [id, lane] of this.lanes) if (lane.receiver?.closed?.aborted) { this.release(lane); this.lanes.delete(id) }
      for (const record of connections) {
        const adapter = this.connections.registeredAdapter(record.config.adapterId)
        if (!record.config.enabled || !adapter?.ingress || !adapter.transport) continue
        let lane = this.lanes.get(record.config.connectionId)
        if (!lane) {
          lane = { record, abort: new AbortController(), opening: false, dispatchFailures: new Set() }
          this.lanes.set(record.config.connectionId, lane)
        }
        if (!lane.receiver && !lane.opening) void this.start(lane, adapter.transport)
        // Bound intake and failed-observation work separately. Neither cursor is an admission limit.
        const retry = new Set<string>()
        try {
          const page = this.ingress.received(record.config.connectionId, lane.after, RECOVERY_BATCH)
          if (page.nextAfterIngressId) lane.after = page.nextAfterIngressId
          else delete lane.after
          delete lane.recoveryFailed
          for (const id of page.ingressIds) retry.add(id)
        } catch { lane.recoveryFailed = true }
        // A previously failed original may have been claimed elsewhere. Recheck it without
        // replaying a claimed input; keep an iterator so earlier failures cannot starve later ones.
        const rechecks = lane.rechecks ??= lane.dispatchFailures.values()
        for (let n = 0; n < RECOVERY_BATCH; n++) {
          const next = rechecks.next()
          if (next.done) { delete lane.rechecks; break }
          retry.add(next.value)
        }
        for (const id of retry) this.defer(lane, id)
      }
    }, () => { for (const lane of this.lanes.values()) lane.recoveryFailed = true }).finally(() => {
      this.reading = false; if (this.dirty && !this.closed) this.refresh()
    })
  }
  private current(lane: Lane): boolean {
    if (this.closed || lane.abort.signal.aborted) return false
    this.connections.assertServiceEnabled()
    const current = this.connections.readConfiguration(lane.record.config.connectionId)
    return current?.config.enabled === true && current.revision === lane.record.revision
  }
  private async start(lane: Lane, transport: ConnectionIngressTransport): Promise<void> {
    lane.opening = true
    try {
      const credential = await this.connections.resolveCredential(lane.record.config.connectionId)
      if (!credential) { lane.failed = 'credential-missing'; return }
      if (!this.current(lane)) return
      const receiver = await transport.start({ config: structuredClone(lane.record.config), credential,
        signal: lane.abort.signal,
        storage: () => this.connections.channelStorage(lane.record.config),
        receive: async (input, acknowledge) => {
          this.connections.assertServiceEnabled()
          if (!this.current(lane)) throw new AgentMuxError('This original connection receiver is no longer current. Existing Agents are retained.', 'INGRESS_CONNECTION_REVISED')
          const accepted = await this.ingress.receive({ connectionId: lane.record.config.connectionId, raw: input.raw,
            ...(input.transportProof === undefined ? {} : { transportProof: input.transportProof }) }, acknowledge)
          // ACK covers durable retention alone. Leave the SDK callback before entering Core or reply observation.
          this.defer(lane, accepted.ingress.ingressId)
          return accepted
        }
      })
      try {
        if (!this.current(lane)) return
        lane.receiver = receiver; delete lane.failed
      } finally {
        if (lane.receiver !== receiver) receiver.close()
      }
    } catch { if (!lane.abort.signal.aborted) lane.failed = 'check-failed' }
    finally { lane.opening = false }
  }
  private defer(lane: Lane, ingressId: string): void {
    setImmediate(() => {
      if (this.closed || lane.abort.signal.aborted) return
      void this.ingress.dispatch(ingressId).then(() => { lane.dispatchFailures.delete(ingressId) }, () => { if (!lane.abort.signal.aborted) lane.dispatchFailures.add(ingressId) })
    }).unref()
  }
  observation(connectionId: string, revision: number): ReceiverObservation | null {
    const lane = this.lanes.get(connectionId)
    if (!lane || lane.record.revision !== revision) return null
    if (!lane.receiver) return { authentication: { state: 'unknown', reason: 'not-tested' }, transport: lane.failed ? { state: 'unavailable', reason: lane.failed } : { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' } }
    try {
      const { authentication, transport, intake } = parseConnectionObservation(lane.receiver.observation())
      return { authentication, transport, intake: lane.recoveryFailed || lane.dispatchFailures.size ? { state: 'unknown', reason: 'check-failed' } : intake }
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
