import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AgentMuxError, type AgentSessionHistoryItem } from '@agentmux/core'
import type { RoomBinding } from '@agentmux/core/connections'
import { parseConversationChangesPage, type ConversationChangesPage, type ConversationCheckpoint, type ConversationItemRef, type ConversationRef } from '@agentmux/core/conversation'

/** The immutable authorized audience; presentation and current focus are deliberately absent. */
export type PublicationBoundary = Pick<RoomBinding, 'bindingId' | 'revision' | 'connectionId' | 'application' | 'executionHostId' | 'agentSessionId' | 'externalConversationId' | 'sourceCheckpoints'>
export type PublicationPayload = {
  kind: 'speech'
  text: string
  phase?: 'progress' | 'final'
  questions?: NonNullable<AgentSessionHistoryItem['questionRequest']>['questions']
}
export type PublicationTarget = Pick<PublicationBoundary, 'connectionId' | 'application' | 'externalConversationId'>
export type PublicationState = 'pending' | 'dispatching' | 'unknown' | 'confirmed' | 'not-applied' | 'cancelled' | 'superseded'
export type PublicationMapping = { messageId: string; threadId?: string }
export type PublicationOperation = {
  operationId: string
  projectionId: string
  sourceRevision: string
  bindingId: string
  bindingRevision: number
  reference: ConversationItemRef
  target: PublicationTarget
  payload: PublicationPayload
  state: PublicationState
  predecessorOperationId?: string
  mapping?: PublicationMapping
  reason?: string
}
type Decision = { recordId: string; revision: string; payload?: PublicationPayload; reason?: 'not-assistant-speech' | 'no-public-text' }
// JSON object property order carries no source or platform identity.
const encode = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const digest = (value: unknown) => createHash('sha256').update(encode(value)).digest('base64url')
const sourceKey = (source: ConversationCheckpoint['source']) => encode([source.providerId, source.nativeSessionId])
const scopeKey = (boundary: PublicationBoundary) => [boundary.bindingId, boundary.revision] as const
const ref = (boundary: PublicationBoundary): ConversationRef => ({ hostId: boundary.executionHostId, agentSessionId: boundary.agentSessionId })
const same = (a: unknown, b: unknown) => encode(a) === encode(b)

/** Select typed original speech only. Native metadata, tool data, resources and reasoning never enter the payload. */
function decide(item: AgentSessionHistoryItem): Decision {
  if (item.kind !== 'assistant-message') return { recordId: item.id, revision: digest(item), reason: 'not-assistant-speech' }
  if (item.contentParts.some(part => part.kind === 'resource' && part.content?.kind === 'text'))
    throw new AgentMuxError('Read the complete original speech resource before publication. Its frontier is retained.', 'PUBLICATION_CONTENT_UNCONFIRMED')
  const text = item.contentParts.filter(part => part.kind === 'text').map(part => part.text).join('\n')
  if (!text && !item.questionRequest?.questions.length) return { recordId: item.id, revision: digest(item), reason: 'no-public-text' }
  const payload: PublicationPayload = { kind: 'speech', text,
    ...(item.messagePhase === undefined ? {} : { phase: item.messagePhase }),
    ...(item.questionRequest === undefined ? {} : { questions: item.questionRequest.questions }) }
  return { recordId: item.id, revision: digest(payload), payload }
}

/** Connector-owned publication facts, not another Agent history or lifecycle. Borrows the Host database. */
export class PublicationStore {
  constructor(readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS connector_publication_frontier (
        binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, source_key TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL, PRIMARY KEY(binding_id, binding_revision, source_key)
      );
      CREATE TABLE IF NOT EXISTS connector_publication_decision (
        binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, source_key TEXT NOT NULL,
        record_id TEXT NOT NULL, source_revision TEXT NOT NULL, reason TEXT NOT NULL,
        PRIMARY KEY(binding_id, binding_revision, source_key, record_id, source_revision)
      );
      CREATE TABLE IF NOT EXISTS connector_publication_operation (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
        projection_id TEXT NOT NULL, source_revision TEXT NOT NULL,
        binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL,
        operation_json TEXT NOT NULL, state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS connector_publication_pending
        ON connector_publication_operation(binding_id, binding_revision, ordinal)
        WHERE state IN ('pending','dispatching','unknown','not-applied');
      CREATE INDEX IF NOT EXISTS connector_publication_audit
        ON connector_publication_operation(binding_id, binding_revision, ordinal);
    `)
  }
  private transaction<T>(action: () => T): T {
    let begun = false
    try { this.database.exec('BEGIN IMMEDIATE'); begun = true; const result = action(); this.database.exec('COMMIT'); return result }
    catch (error) {
      try { if (begun) this.database.exec('ROLLBACK') } catch { /* An unconfirmed commit is inspected through its original operation and frontier. */ }
      if (error instanceof AgentMuxError) throw error
      throw new AgentMuxError('Publication storage could not confirm the original page. Inspect its retained frontier and operations.', 'PUBLICATION_STORAGE_UNCONFIRMED')
    }
  }
  private read(row: Record<string, unknown> | undefined): PublicationOperation | null {
    return row ? { ...JSON.parse(row.operation_json as string), state: row.state as PublicationState } : null
  }
  inspect(operationId: string): PublicationOperation | null {
    return this.read(this.database.prepare('SELECT operation_json, state FROM connector_publication_operation WHERE operation_id=?').get(operationId))
  }
  list(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, limit = 30, after?: string): PublicationOperation[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AgentMuxError('Publication pages require a limit from 1 to 100.', 'INVALID_PUBLICATION_REQUEST')
    const cursor = after === undefined ? undefined : this.database.prepare('SELECT ordinal FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND operation_id=?')
      .get(boundary.bindingId, boundary.revision, after)
    if (after !== undefined && !cursor) throw new AgentMuxError('The publication cursor belongs to another audience or operation.', 'INVALID_PUBLICATION_REQUEST')
    return this.database.prepare('SELECT operation_json, state FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND ordinal>? ORDER BY ordinal LIMIT ?')
      .all(boundary.bindingId, boundary.revision, Number(cursor?.ordinal ?? 0), limit).map(row => this.read(row)!)
  }
  /** The initial durable cut is supplied by Binding. It never reads or exports private earlier records. */
  checkpoint(boundary: PublicationBoundary, initial: ConversationCheckpoint): ConversationCheckpoint {
    if (initial.agentSessionId !== boundary.agentSessionId || !boundary.sourceCheckpoints.some(value => same(value, initial)))
      throw new AgentMuxError('The publication cut must belong to the original Binding source.', 'PUBLICATION_SOURCE_CONFLICT')
    const query = this.database.prepare('SELECT checkpoint_json FROM connector_publication_frontier WHERE binding_id=? AND binding_revision=? AND source_key=?')
    let row = query.get(...scopeKey(boundary), sourceKey(initial.source))
    if (!row) {
      this.database.prepare('INSERT OR IGNORE INTO connector_publication_frontier VALUES (?, ?, ?, ?)')
        .run(...scopeKey(boundary), sourceKey(initial.source), encode(initial))
      row = query.get(...scopeKey(boundary), sourceKey(initial.source))!
    }
    return JSON.parse(row.checkpoint_json as string)
  }
  /** Selection happens before BEGIN; all required effects, explicit skips and the next cut commit together. */
  commitPage(boundary: PublicationBoundary, after: ConversationCheckpoint, value: ConversationChangesPage, authorized: () => boolean): void {
    const page = parseConversationChangesPage(value, { ...ref(boundary), checkpoint: after, limit: 100 })
    const decisions = page.items.map(decide), source = sourceKey(page.source)
    this.transaction(() => {
      if (!authorized()) throw new AgentMuxError('This exact Binding no longer authorizes publication. The original frontier is retained.', 'PUBLICATION_NOT_AUTHORIZED')
      const row = this.database.prepare('SELECT checkpoint_json FROM connector_publication_frontier WHERE binding_id=? AND binding_revision=? AND source_key=?')
        .get(...scopeKey(boundary), source)
      if (!row || !same(JSON.parse(row.checkpoint_json as string), after))
        throw new AgentMuxError('Publication continued from a different saved frontier. Read its original checkpoint.', 'PUBLICATION_CHECKPOINT_CONFLICT')
      for (const decision of decisions) {
        const projectionId = 'projection-' + digest([...scopeKey(boundary), page.source.providerId, page.source.nativeSessionId, decision.recordId, 'speech'])
        const prior = this.read(this.database.prepare('SELECT operation_json, state FROM connector_publication_operation WHERE projection_id=? ORDER BY ordinal DESC LIMIT 1').get(projectionId))
        if (!decision.payload) {
          if (prior?.state === 'pending') this.write({ ...prior, state: 'cancelled', reason: 'original-speech-withdrawn' })
          this.database.prepare('INSERT OR IGNORE INTO connector_publication_decision VALUES (?, ?, ?, ?, ?, ?)')
            .run(...scopeKey(boundary), source, decision.recordId, decision.revision, decision.reason!)
          continue
        }
        if (prior?.sourceRevision === decision.revision && prior.state !== 'cancelled') continue
        // The same text can legitimately return after an intervening original revision.
        // The retained predecessor and source content bind this operation without a clock or global sequence.
        const operationId = 'publication-' + digest([projectionId, prior?.operationId ?? null, decision.revision])
        const predecessor = prior?.state === 'pending' || prior?.state === 'cancelled' ? prior.predecessorOperationId : prior?.operationId
        if (prior?.state === 'pending') this.database.prepare("UPDATE connector_publication_operation SET state='superseded' WHERE operation_id=? AND state='pending'").run(prior.operationId)
        const operation: PublicationOperation = { operationId, projectionId, sourceRevision: decision.revision,
          bindingId: boundary.bindingId, bindingRevision: boundary.revision,
          reference: { ...ref(boundary), source: { kind: 'native', ...page.source, recordId: decision.recordId } },
          target: { connectionId: boundary.connectionId, application: boundary.application, externalConversationId: boundary.externalConversationId },
          payload: decision.payload, state: 'pending', ...(predecessor ? { predecessorOperationId: predecessor } : {}) }
        this.database.prepare('INSERT INTO connector_publication_operation (operation_id, projection_id, source_revision, binding_id, binding_revision, operation_json, state) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(operationId, projectionId, decision.revision, ...scopeKey(boundary), encode(operation), operation.state)
      }
      this.database.prepare('UPDATE connector_publication_frontier SET checkpoint_json=? WHERE binding_id=? AND binding_revision=? AND source_key=?')
        .run(encode(page.checkpoint), ...scopeKey(boundary), source)
    })
  }
  /** Save the exact effect identity before any adapter call. Unknown work blocks this audience alone. */
  claimNext(boundary: PublicationBoundary, authorized: () => boolean): PublicationOperation | null {
    return this.transaction(() => {
      if (!authorized()) return null
      const first = this.read(this.database.prepare("SELECT operation_json, state FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND state IN ('pending','dispatching','unknown','not-applied') ORDER BY ordinal LIMIT 1")
        .get(...scopeKey(boundary)))
      if (!first || first.state !== 'pending') return null
      const predecessor = first.predecessorOperationId ? this.inspect(first.predecessorOperationId) : null
      if (predecessor && (predecessor.state !== 'confirmed' || !predecessor.mapping)) return null
      const claimed = { ...first, state: 'dispatching' as const,
        ...(predecessor?.mapping ? { mapping: predecessor.mapping } : {}) }
      this.write(claimed)
      return claimed
    })
  }
  private write(operation: PublicationOperation): void {
    this.database.prepare('UPDATE connector_publication_operation SET operation_json=?, state=? WHERE operation_id=?')
      .run(encode(operation), operation.state, operation.operationId)
  }
  settle(operationId: string, result: { state: 'confirmed'; mapping: PublicationMapping } | { state: 'unknown' | 'not-applied'; reason: string }): PublicationOperation {
    return this.transaction(() => {
      const original = this.inspect(operationId)
      if (!original) throw new AgentMuxError('The original publication operation is unknown.', 'UNKNOWN_PUBLICATION_OPERATION')
      if (original.state === 'confirmed') {
        if (result.state !== 'confirmed' || !same(original.mapping, result.mapping))
          throw new AgentMuxError('The original confirmed platform mapping cannot be replaced.', 'PUBLICATION_RECEIPT_CONFLICT')
        return original
      }
      if (original.state !== 'dispatching' && original.state !== 'unknown')
        throw new AgentMuxError('This publication operation was not dispatched.', 'PUBLICATION_RECEIPT_CONFLICT')
      if (result.state === 'confirmed' && (typeof result.mapping.messageId !== 'string' || !result.mapping.messageId || result.mapping.messageId.length > 16_384 ||
        result.mapping.threadId !== undefined && (typeof result.mapping.threadId !== 'string' || !result.mapping.threadId || result.mapping.threadId.length > 16_384) ||
        original.mapping && !same(original.mapping, result.mapping)))
        throw new AgentMuxError('The platform did not confirm the original exact message mapping.', 'PUBLICATION_RECEIPT_CONFLICT')
      const { reason: _reason, ...retained } = original
      const settled: PublicationOperation = { ...retained, ...result }
      this.write(settled)
      return settled
    })
  }
  /** Only an explicit retry of an authoritative non-application can return to the dispatch lane. */
  retry(operationId: string, authorized: () => boolean): PublicationOperation {
    return this.transaction(() => {
      const original = this.inspect(operationId)
      if (!original) throw new AgentMuxError('The original publication operation is unknown.', 'UNKNOWN_PUBLICATION_OPERATION')
      if (original.state !== 'not-applied') throw new AgentMuxError('The platform has not confirmed non-application. Inspect the original operation.', 'PUBLICATION_RETRY_UNCONFIRMED')
      if (!authorized()) throw new AgentMuxError('This exact Binding no longer authorizes dispatch.', 'PUBLICATION_NOT_AUTHORIZED')
      const { reason: _reason, ...retained } = original
      const pending: PublicationOperation = { ...retained, state: 'pending' }
      this.write(pending)
      return pending
    })
  }
}
