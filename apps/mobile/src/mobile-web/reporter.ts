import { deriveObjectId, mintObjectId } from '@agentmux/core/object-id'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxClientEvent, AgentMuxRpcResult } from '@agentmux/core'
import type { MobileWebObservation, MobileWebReportParams, MobileWebReportReceipt } from '@agentmux/core/mobile-web'
import type { MobileWebPageIdentity } from './page-identity'

const MAX_REPORT_BYTES = 4096, MAX_REPORTS = 16, MAX_QUEUED_BYTES = 64 * 1024
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
type Client = Pick<AgentMuxHostedClient, 'forwardRpc'>
type Scope = 'catalog' | 'consumer-core' | 'core-ctxmux' | 'unknown'
type Entry = { client: Client; report: MobileWebReportParams; bytes: number }
export type MobileWebReporterStatus = Readonly<{
  inFlight: boolean; queuedCount: number; queuedBytes: number; droppedCount: number
  receipt: MobileWebReportReceipt | null; issue: string | null
}>

/** A finite diagnostic outbox, independent of business requests and notice presentation. */
export class MobileWebReporter {
  private waiting: Entry[] = []
  private active: Entry | null = null
  private client: Client | null = null
  private connected = false
  private stopped = false
  // Fixed original sources, below the 32-scope budget; no per-Space queues or growing index.
  private fingerprints: Record<Scope, string | null> = {
    catalog: null, 'consumer-core': null, 'core-ctxmux': null, unknown: null }
  private notAdmitted: Record<Scope, string | null> = { ...this.fingerprints }
  private listeners = new Set<() => void>()
  private status: MobileWebReporterStatus = { inFlight: false, queuedCount: 0, queuedBytes: 0, droppedCount: 0, receipt: null, issue: null }
  constructor(private readonly page: MobileWebPageIdentity) {}
  matchesClient(client: Client | null) { return this.client === client }
  bindClient(client: Client | null) {
    if (this.client === client) return
    const droppedCount = Math.min(Number.MAX_SAFE_INTEGER, this.status.droppedCount + this.waiting.length)
    this.waiting = []; this.client = client; this.connected = false
    this.fingerprints = { catalog: null, 'consumer-core': null, 'core-ctxmux': null, unknown: null }
    this.notAdmitted = { ...this.fingerprints }
    this.publish({ receipt: null, droppedCount, issue: droppedCount > this.status.droppedCount
      ? '旧连接的待报诊断未保留；原业务和已在途诊断保持。' : null })
  }
  snapshot = () => this.status
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<MobileWebReporterStatus> = {}) {
    this.status = { ...this.status, ...patch, inFlight: this.active !== null,
      queuedCount: this.waiting.length + Number(this.active !== null),
      queuedBytes: this.waiting.reduce((bytes, entry) => bytes + entry.bytes, this.active?.bytes ?? 0) }
    if (!this.stopped) for (const listener of this.listeners) listener()
  }
  private dropped() {
    this.publish({ droppedCount: Math.min(Number.MAX_SAFE_INTEGER, this.status.droppedCount + 1),
      issue: '部分诊断未保留；原提醒和业务仍可使用。可沿原业务入口继续查询。' })
  }
  setConnected(connected: boolean) { this.connected = connected; if (connected) this.pump() }
  retry = () => { if (!this.stopped && this.client) { this.connected = true; this.pump() } }
  dispose() {
    this.stopped = true; this.connected = false; this.listeners.clear(); this.waiting = []
    // An observer going away does not release the actual outstanding IO slot.
    this.publish()
  }
  private enqueue(observation: MobileWebObservation, observedAt = Date.now()) {
    if (this.stopped || !this.client) return
    const scope = observation.kind === 'connection-state' ? observation.boundary ?? 'unknown' : 'catalog'
    const fingerprint = deriveObjectId('mobile-web-observation', JSON.stringify(observation))
    if (this.fingerprints[scope] === fingerprint) return
    if (this.status.queuedCount >= MAX_REPORTS) {
      if (this.notAdmitted[scope] !== fingerprint) { this.notAdmitted[scope] = fingerprint; this.dropped() }
      return
    }
    const report: MobileWebReportParams = { ...this.page, occurrenceId: mintObjectId(), observedAt, observation,
      reporter: { droppedCount: this.status.droppedCount, queuedCount: this.status.queuedCount, queuedBytes: this.status.queuedBytes } }
    const bytes = byteLength(report)
    if (bytes > MAX_REPORT_BYTES || this.status.queuedBytes + bytes > MAX_QUEUED_BYTES) {
      if (this.notAdmitted[scope] !== fingerprint) { this.notAdmitted[scope] = fingerprint; this.dropped() }
      return
    }
    this.fingerprints[scope] = fingerprint; this.notAdmitted[scope] = null
    this.waiting.push({ client: this.client, report, bytes }); this.publish(); this.pump()
  }
  observeCatalog = (catalog: Pick<AgentMuxRpcResult<'space.ls'>['catalog'], 'spaces'>) => {
    if (this.stopped) return
    try {
      let issueCount = 0
      const spaceIds: string[] = []
      for (const space of catalog.spaces) {
        if (!Object.hasOwn(space, 'issue')) continue
        issueCount++
        if (spaceIds.length < 4 && space.spaceId.length <= 3200 && byteLength([...spaceIds, space.spaceId]) <= 3200) spaceIds.push(space.spaceId)
      }
      if (!issueCount) { this.fingerprints.catalog = null; this.notAdmitted.catalog = null; return }
      this.enqueue({ kind: 'catalog-partial', source: 'space.ls', code: null, issueCount, spaceIds, omittedCount: issueCount - spaceIds.length })
    } catch { this.dropped() }
  }
  observeConnection = (event: Extract<AgentMuxClientEvent, { type: 'connection-state' }>) => {
    if (event.observationOrigin?.kind === 'runtime-connection' && event.observationOrigin.boundary === 'consumer-core') this.connected = event.state === 'restored'
    try { this.enqueue({ kind: 'connection-state', source: 'connection-state', code: null, state: event.state,
      boundary: event.observationOrigin?.kind === 'runtime-connection' ? event.observationOrigin.boundary : null }, event.evidence.observedAt) }
    catch { this.dropped() }
    if (this.connected) this.pump()
  }
  private pump() {
    if (this.stopped || !this.connected || this.active || !this.waiting.length) return
    if (!this.waiting[0]!.client.forwardRpc) { this.publish({ issue: '诊断接口暂不可达；原业务仍可使用。连接恢复后可重试诊断报送。' }); return }
    const entry = this.waiting.shift()!
    this.active = entry; this.publish({ issue: null })
    void entry.client.forwardRpc!('app.mobile.report', entry.report).then(receipt => {
      if (this.stopped || entry.client !== this.client) return
      if (receipt.producer.documentId !== entry.report.documentId) throw new Error('Original diagnostic document mismatch')
      if (!receipt.accepted) { this.dropped(); return }
      this.publish({ receipt, issue: null })
    }).then(() => {
      this.active = null; this.publish(); this.pump()
    }).catch(() => {
      this.active = null
      if (!this.stopped && entry.client === this.client) {
        this.waiting.unshift(entry)
        this.publish({ issue: '诊断报送未确认；原业务仍可使用。可重试同一份诊断，不会重试消息或上传。' })
      } else { this.dropped(); this.pump() }
    })
  }
}
