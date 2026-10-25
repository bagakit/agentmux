import { AgentMuxError, parseAgentInputChangesPage, parseAgentInputChangesRead, type AgentInputChangesRead, type AgentInputChangesPage } from '@agentmux/core'
import type { ConnectionIngressMessage, ConnectionIngressInspection, RoomBinding } from '@agentmux/core/connections'
import type { PublicationBoundary, PublicationOperation, PublicationStore } from './publication-store.js'
import { queueQueryFeedback } from './publication-query-feedback.js'

const positionKey = 'query-input-changes'
const pending = "json_extract(operation_json,'$.queryPending')=1"
const scope = (binding: PublicationBoundary) => [binding.bindingId, binding.revision] as const
export type QueryInputPosition = Pick<AgentInputChangesRead, 'after' | 'cursor'>
export function queryInputPosition(store: PublicationStore, binding: PublicationBoundary): QueryInputPosition | null {
  const row = store.database.prepare('SELECT checkpoint_json FROM connector_publication_frontier WHERE binding_id=? AND binding_revision=? AND source_key=?').get(...scope(binding), positionKey)
  if (!row) return null
  const { agentSessionId: _id, ...position } = parseAgentInputChangesRead({ agentSessionId: binding.agentSessionId, ...JSON.parse(String(row.checkpoint_json)) })
  return position
}
export function queryInputPage(store: PublicationStore, binding: PublicationBoundary, after: QueryInputPosition | null, page: AgentInputChangesPage): void {
  const current = queryInputPosition(store, binding)
  if (JSON.stringify(current) !== JSON.stringify(after)) throw new AgentMuxError('The original query input position changed.', 'PUBLICATION_SOURCE_CONFLICT')
  // Original indexed ingress lookup is the only relation from an input key to an external query.
  const lookup = store.database.prepare(`SELECT record_json FROM connection_ingress_message
    WHERE json_extract(record_json,'$.input.hostId')=? AND json_extract(record_json,'$.input.agentSessionId')=?
      AND json_extract(record_json,'$.input.expectedRun.runId')=? AND json_extract(record_json,'$.input.messageId')=?`)
  for (const change of page.changes) {
    if (change.key.kind !== 'message') continue
    for (const row of lookup.all(binding.executionHostId, change.key.agentSessionId, change.key.expectedRun.runId, change.key.messageId)) {
      const query = JSON.parse(String(row.record_json)) as ConnectionIngressMessage
      const anchor = store.queryReceived(binding, query.ingressId)
      if (!anchor || anchor.queryFeedback?.messageId !== query.externalMessageId) continue
      // This durable work registration and the position below share the original Outbox transaction.
      store.database.prepare("UPDATE connector_publication_operation SET operation_json=json_set(operation_json,'$.queryPending',json('true')) WHERE operation_id=?")
        .run(anchor.operationId)
    }
  }
  const position: QueryInputPosition = page.nextCursor ? { cursor: page.nextCursor } : { after: page.checkpoint! }
  store.database.prepare('INSERT INTO connector_publication_frontier VALUES(?,?,?,?) ON CONFLICT(binding_id,binding_revision,source_key) DO UPDATE SET checkpoint_json=excluded.checkpoint_json')
    .run(...scope(binding), positionKey, JSON.stringify(position))
}
export function queryInputPending(store: PublicationStore, binding: PublicationBoundary, after: number, through?: number): { through: number; rows: Array<{ ordinal: number; operation: PublicationOperation }> } {
  const cut = through ?? Number(store.database.prepare(`SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND ${pending}`).get(...scope(binding))!.ordinal)
  const rows = store.database.prepare(`SELECT ordinal,operation_json,state FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND ${pending} AND ordinal>? AND ordinal<=? ORDER BY ordinal LIMIT 25`)
    .all(...scope(binding), after, cut).map(row => ({ ordinal: Number(row.ordinal), operation: { ...JSON.parse(String(row.operation_json)), state: row.state } as PublicationOperation }))
  return { through: cut, rows }
}
export function queryInputReceipt(store: PublicationStore, binding: PublicationBoundary, original: PublicationOperation, inspection: ConnectionIngressInspection): void {
  const query = inspection.ingress, receipt = inspection.inputReceipt
  if (!query || query.kind === 'action' || query.state !== 'claimed' || !query.input || !receipt || inspection.observation !== 'observed' ||
      query.ingressId !== original.queryFeedback?.ingressId || query.externalMessageId !== original.queryFeedback.messageId ||
      receipt.key.kind !== 'message' || receipt.key.agentSessionId !== query.input.agentSessionId ||
      receipt.key.expectedRun.runId !== query.input.expectedRun.runId || receipt.key.messageId !== query.input.messageId) return
  if (receipt.status === 'waiting') queueQueryFeedback(store, binding, query, 'queued')
  const delivered = receipt.status === 'terminal-confirmed' || receipt.status === 'admitted'
  if (delivered) queueQueryFeedback(store, binding, query, 'dispatched')
  if (delivered || receipt.status === 'not-applied' || receipt.status === 'stopped' && receipt.control.state === 'stopped-before-dispatch') {
    store.database.prepare("UPDATE connector_publication_operation SET operation_json=json_remove(operation_json,'$.queryPending') WHERE operation_id=?").run(original.operationId)
  }
}

export interface PublicationQueryInputPort {
  observe(binding: RoomBinding, wake: () => void): () => void
  changes(binding: RoomBinding, input: AgentInputChangesRead): Promise<AgentInputChangesPage>
  inspect(input: { ingressId: string }): Promise<ConnectionIngressInspection>
  authorized(query: ConnectionIngressMessage, binding: RoomBinding): boolean
}
/** One optional observer on the original publication lane. No input execution, state mirror or polling timer. */
export class PublicationQueryInputObserver {
  private stop: (() => void) | undefined
  private work: Promise<void> | undefined
  private dirty = false
  failed = false
  constructor(private readonly store: PublicationStore, private readonly binding: RoomBinding, private readonly port: PublicationQueryInputPort,
    private readonly signal: AbortSignal, private readonly authorized: () => boolean, private readonly publish: () => void) {
    signal.addEventListener('abort', () => { this.stop?.(); this.stop = undefined }, { once: true })
  }
  wake(): void {
    if (this.signal.aborted || !this.authorized()) return
    this.dirty = true
    if (this.work) return
    this.work = Promise.resolve().then(async () => {
      this.stop ??= this.port.observe(this.binding, () => this.wake()) // Subscribe before the first cut.
      while (this.dirty && !this.signal.aborted && this.authorized()) {
        this.dirty = false
        await this.pass()
      }
      this.failed = false
    }).catch(() => { this.failed = true }).finally(() => { this.work = undefined })
  }
  private async read<T>(value: Promise<T>): Promise<T> {
    // A transport ignoring its observation budget retains this one slot until it settles.
    // Recovery never accumulates another hung read, and ordinary publication is independent.
    let expired = false
    const timer = setTimeout(() => { expired = true; this.failed = true; this.publish() }, 30_000); timer.unref()
    try { const result = await value; if (expired || this.signal.aborted || !this.authorized()) throw Error('Original query observation ended'); return result }
    finally { clearTimeout(timer) }
  }
  private async pass(): Promise<void> {
    let position = this.store.queryInputPosition(this.binding)
    do {
      const input: AgentInputChangesRead = { agentSessionId: this.binding.agentSessionId, ...position, limit: 25 }
      const page = parseAgentInputChangesPage(await this.read(this.port.changes(this.binding, input)), input)
      this.store.commitQueryInputPage(this.binding, position, page, this.authorized)
      position = this.store.queryInputPosition(this.binding)
      await new Promise<void>(resolve => setImmediate(resolve))
      if (!page.nextCursor) break
    } while (!this.signal.aborted && this.authorized())
    let after = 0, through: number | undefined
    do {
      const page = this.store.queryInputPending(this.binding, after, through)
      through = page.through
      for (const row of page.rows) {
        const id = row.operation.queryFeedback?.ingressId
        if (!id) continue
        const inspection = await this.read(this.port.inspect({ ingressId: id }))
        const query = inspection.ingress
        if (query && query.kind !== 'action' && this.port.authorized(query, this.binding))
          this.store.commitQueryInputReceipt(this.binding, row.operation, inspection, this.authorized)
        after = row.ordinal
      }
      this.publish()
      if (page.rows.length < 25 || after >= through) break
      await new Promise<void>(resolve => setImmediate(resolve))
    } while (!this.signal.aborted && this.authorized())
  }
}
