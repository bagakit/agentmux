import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import type { AgentInputSubmissionReceipt, AgentSessionHistorySource, ChannelQuoteRange, ChannelTranscriptQuote } from '@agentmux/core'
import { channelQuoteWireMatchesEnvelope } from '@agentmux/core/agent-message-render'
import { parseConnectionIngressRecord, type ConnectionIngressMessage, type RoomBinding } from '@agentmux/core/connections'

export type IngressContextRecipient = {
  bindingId: string; bindingRevision: number; hostId: string; agentSessionId: string
  source: AgentSessionHistorySource
}
const scopeKey = (recipient: IngressContextRecipient) => JSON.stringify([
  recipient.bindingId, recipient.bindingRevision, recipient.hostId, recipient.agentSessionId,
  recipient.source.providerId, recipient.source.nativeSessionId
])
/** Frozen intake metadata alone joins context positions; it never grants input authority. */
export const ingressContextRevision = (record: ConnectionIngressMessage, revision: number): number => record.group?.target?.publicationRevision ?? revision

/** Derived positions and unresolved receipt indexes, not an input queue or a second history.
 * Every candidate refers back to its immutable original intake and Core operation. */
export class IngressContextPositions {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS connection_ingress_context_position (
        scope TEXT PRIMARY KEY, ingress_id TEXT NOT NULL, message_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS connection_ingress_context_pending (
        ingress_id TEXT PRIMARY KEY, scope TEXT NOT NULL, sequence INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS connection_ingress_context_pending_scope
        ON connection_ingress_context_pending(scope,sequence);
      CREATE INDEX IF NOT EXISTS connection_ingress_context_publication_origin
        ON connection_ingress_message(json_extract(record_json,'$.group.target.bindingId'),
          coalesce(json_extract(record_json,'$.group.target.publicationRevision'),json_extract(record_json,'$.group.target.bindingRevision')),sequence);
      DROP INDEX IF EXISTS connection_ingress_context_origin;
    `)
  }
  private original(ingressId: string): ConnectionIngressMessage | null {
    const row = this.database.prepare('SELECT record_json FROM connection_ingress_message WHERE ingress_id=?').get(ingressId)
    const value = row ? parseConnectionIngressRecord(JSON.parse(String(row.record_json))) : null
    return value?.kind !== 'action' ? value : null
  }
  private recipient(record: ConnectionIngressMessage): IngressContextRecipient | null {
    const input = record.input
    return input?.contextSource ? { bindingId: input.author.bindingId, bindingRevision: ingressContextRevision(record, input.author.bindingRevision),
      hostId: input.hostId, agentSessionId: input.agentSessionId, source: input.contextSource } : null
  }
  position(recipient: IngressContextRecipient): { ingressId: string; messageId: string } | null {
    const row = this.database.prepare('SELECT ingress_id,message_id FROM connection_ingress_context_position WHERE scope=?').get(scopeKey(recipient))
    return row ? { ingressId: String(row.ingress_id), messageId: String(row.message_id) } : null
  }
  range(record: ConnectionIngressMessage, binding: RoomBinding, source?: AgentSessionHistorySource): ChannelQuoteRange {
    const revision = ingressContextRevision(record, binding.revision)
    const position = source ? this.position({ bindingId: binding.bindingId, bindingRevision: revision,
      hostId: binding.executionHostId, agentSessionId: binding.agentSessionId, source }) : null
    if (position) return { from: { messageId: position.messageId, inclusive: false }, throughMessageId: record.externalMessageId, origin: 'admitted-input' }
    // This is a declared retained baseline, not a claim that bind-to-first-intake
    // history or a paused interval has been observed. Never borrow publication cuts.
    const first = this.database.prepare(`SELECT record_json FROM connection_ingress_message
      WHERE json_extract(record_json,'$.group.target.bindingId')=?
        AND coalesce(json_extract(record_json,'$.group.target.publicationRevision'),json_extract(record_json,'$.group.target.bindingRevision'))=?
      ORDER BY sequence LIMIT 1`).get(binding.bindingId, revision)
    const baseline = first ? parseConnectionIngressRecord(JSON.parse(String(first.record_json))) : null
    return { from: baseline?.kind !== 'action' && baseline ? { messageId: baseline.externalMessageId, inclusive: true } : null,
      throughMessageId: record.externalMessageId, origin: 'first-observed' }
  }
  /** Called in the original intake claim transaction, before any Core effect. */
  claimed(record: ConnectionIngressMessage): void {
    const recipient = this.recipient(record), quote = record.input?.channelQuote
    if (!recipient || quote?.coverage !== 'complete') return
    this.database.prepare(`INSERT INTO connection_ingress_context_pending(ingress_id,scope,sequence)
      SELECT ingress_id,?,sequence FROM connection_ingress_message WHERE ingress_id=?
      ON CONFLICT(ingress_id) DO NOTHING`).run(scopeKey(recipient), record.ingressId)
  }
  /** Late original receipts are read without resubmitting. Resolved old inputs
   * disappear from this index; unrelated rooms never participate in the scan. */
  async reconcile(recipient: IngressContextRecipient,
    inspect: (operationId: string) => Promise<AgentInputSubmissionReceipt | null>): Promise<void> {
    const scope = scopeKey(recipient)
    let after = 0
    for (;;) {
      const rows = this.database.prepare(`SELECT ingress_id,sequence FROM connection_ingress_context_pending
        WHERE scope=? AND sequence>? ORDER BY sequence LIMIT 25`).all(scope, after)
      for (const row of rows) {
        after = Number(row.sequence)
        const record = this.original(String(row.ingress_id)), input = record?.input
        if (!record || !input || !isDeepStrictEqual(this.recipient(record), recipient)) continue
        const receipt = await inspect(input.operationId)
        if (receipt) this.observe(record, receipt)
      }
      if (rows.length < 25) return
    }
  }
  /** Return true only for an original accepted continuous interval. A terminal
   * byte ACK can settle its index entry but never becomes a native position. */
  observe(record: ConnectionIngressMessage, receipt: AgentInputSubmissionReceipt): boolean {
    const input = record.input, recipient = this.recipient(record), quote = input?.channelQuote
    if (!input || !recipient || !quote || receipt.key.kind !== 'message' || receipt.key.messageId !== input.messageId ||
        receipt.key.agentSessionId !== input.agentSessionId || receipt.key.expectedRun.runId !== input.expectedRun.runId ||
        receipt.originalControlOperationId !== input.operationId) return false
    const admission = receipt.admission?.admission
    if (receipt.status === 'terminal-confirmed' || receipt.status === 'not-applied') {
      this.database.prepare('DELETE FROM connection_ingress_context_pending WHERE ingress_id=?').run(record.ingressId)
      return false
    }
    if (receipt.status !== 'admitted' || admission?.transport !== 'native' || !admission.acknowledged ||
        admission.native.outcome !== 'admitted' || admission.native.plan.threadId !== recipient.source.nativeSessionId ||
        quote.coverage !== 'complete' || quote.gaps.length || quote.range.throughMessageId !== record.externalMessageId) return false
    // The original receipt confirms its actual wire. A MID reference is not the
    // retained quote itself; later body reads cannot advance this provided range.
    if (!admission.intent?.prompt) return false
    if (!channelQuoteWireMatchesEnvelope(admission.intent.prompt, { sender: input.author, body: record.body,
      channelQuote: quote, ...(input.channelProfile ? { channelProfile: input.channelProfile } : {}) })) {
      this.database.prepare('DELETE FROM connection_ingress_context_pending WHERE ingress_id=?').run(record.ingressId)
      return false
    }
    const scope = scopeKey(recipient)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.position(recipient)
      let covered = previous?.messageId === record.externalMessageId
      if (previous) covered ||= quote.range.from?.messageId === previous.messageId || quote.records.some(item => item.messageId === previous.messageId)
      else {
        const baseline = this.database.prepare(`SELECT record_json FROM connection_ingress_message
          WHERE json_extract(record_json,'$.group.target.bindingId')=? AND coalesce(json_extract(record_json,'$.group.target.publicationRevision'),json_extract(record_json,'$.group.target.bindingRevision'))=?
          ORDER BY sequence LIMIT 1`).get(recipient.bindingId, recipient.bindingRevision)
        const first = baseline ? parseConnectionIngressRecord(JSON.parse(String(baseline.record_json))) : null
        covered = quote.range.origin === 'first-observed' && quote.range.from?.inclusive === true &&
          first?.kind !== 'action' && first?.externalMessageId === quote.range.from.messageId
      }
      if (!covered) {
        // A later accepted interval can already include this late original input.
        // Retire only that receipt lookup; opaque intake sequence is not native order.
        const current = previous ? this.original(previous.ingressId) : null, currentQuote = current?.input?.channelQuote
        const alreadyIncluded = current && isDeepStrictEqual(this.recipient(current), recipient) &&
          current.externalMessageId === previous?.messageId && currentQuote?.coverage === 'complete' && !currentQuote.gaps.length &&
          currentQuote.range.throughMessageId === previous.messageId && current.externalConversationId === record.externalConversationId &&
          isDeepStrictEqual(current.application, record.application) &&
          (currentQuote.range.from?.messageId === record.externalMessageId || currentQuote.records.some(item => item.messageId === record.externalMessageId))
        if (alreadyIncluded) this.database.prepare('DELETE FROM connection_ingress_context_pending WHERE ingress_id=?').run(record.ingressId)
        this.database.exec('COMMIT'); return false
      }
      if (previous?.messageId !== record.externalMessageId) this.database.prepare(`INSERT INTO connection_ingress_context_position VALUES (?,?,?)
        ON CONFLICT(scope) DO UPDATE SET ingress_id=excluded.ingress_id,message_id=excluded.message_id`).run(scope, record.ingressId, record.externalMessageId)
      this.database.prepare('DELETE FROM connection_ingress_context_pending WHERE ingress_id=?').run(record.ingressId)
      this.database.exec('COMMIT')
      return true
    } catch (error) { try { this.database.exec('ROLLBACK') } catch { /* Original Core receipt remains authoritative. */ } throw error }
  }
}

export function unavailableChannelQuote(record: ConnectionIngressMessage, range: ChannelQuoteRange, reason: string): ChannelTranscriptQuote {
  return { version: 1, application: record.application, externalConversationId: record.externalConversationId,
    observedAt: Date.now(), range, coverage: 'unavailable', gaps: [{ reason }], records: [] }
}
