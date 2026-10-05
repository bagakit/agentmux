import { createHash } from 'node:crypto'
import { mintObjectId } from './object-id.js'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from './errors.js'
import { assertDispatchEventKind, assertDispatchMessage, openDispatch, recordDispatchEvent, type Dispatch, type DispatchEvent, type DispatchEventKind } from './agent-handoff.js'
import { validateAgentPromptCondition, type AgentPromptCondition } from './agent-prompt-condition.js'
import { ackDeliveryBatch, checkDeliveries, type ConsumerCursor, type DeliveryQueue } from './agent-delivery-queue.js'
import { advanceDelivery, type AgentDeliveryState } from './agent-message.js'
import type { AgentMuxMessageTarget } from './control.js'
import { defaultAgentMuxMessageQueuePath } from './runtime-paths.js'
import type { AgentMuxRunRef, AgentPromptExecution, AgentMessageChannel, AgentOperationDevice } from './types.js'
import { normalizeMessageChannel } from './message-origin.js'
import { normalizeOperationDevice } from './operation-device.js'
import { configureMessageJournal, openMessageJournal, syncMessageJournal } from './agent-message-journal.js'

export type AgentMuxMessageIdentity =
  | { readonly kind: 'agent-session'; readonly agentSessionId: string }
  /** Unattributed local ingress. The established wire kind does not authenticate a human;
   * principal records the transport and must never be displayed as participant identity. */
  | { readonly kind: 'human'; readonly principal: 'local-cli' }

export type AgentMuxMessageRecipient =
  | { readonly kind: 'agent-session'; readonly agentSessionId: string }
  | { readonly kind: 'target'; readonly target: AgentMuxMessageTarget }

/** Versioned A2A facts. The body is intentionally opaque and retained byte-for-byte as a string. */
export type AgentMuxMessageEnvelope = {
  readonly schema: 'agentmux.a2a.v1'
  readonly messageId: string
  readonly operationId: string
  readonly createdAt: number
  readonly sender: AgentMuxMessageIdentity
  readonly recipient: AgentMuxMessageRecipient
  readonly threadId: string
  readonly correlationId: string
  readonly replyTo: string | null
  readonly workspaceId: string | null
  readonly senderSessionId: string | null
  readonly senderRunId: string | null
  readonly recipientSessionId: string | null
  readonly recipientRunId: string | null
  readonly body: string
}

export type AgentMuxMessageDeliveryState = {
  readonly state: AgentDeliveryState
  readonly at: number
  readonly reason?: string
}

export type DurableAgentMuxMessage = {
  readonly sequence: number
  readonly envelope: AgentMuxMessageEnvelope
  readonly delivery: AgentMuxMessageDeliveryState
  /** null proves this new journal intent has not yet crossed a prompt RPC. Absence is unknown. */
  readonly promptCondition?: AgentPromptCondition | null
  /** This journal admission freezes the requested execution independently of the opaque envelope. */
  readonly execution?: AgentPromptExecution
  readonly sourceChannel?: AgentMessageChannel
  readonly sourceDevice?: AgentOperationDevice
}

export type AgentMuxDeliveryReader = {
  readonly consumerId: string
  readonly readerRun: AgentMuxRunRef
}

export type AgentMuxDeliveryBatch = AgentMuxDeliveryReader & {
  readonly generation: number
  readonly messages: readonly DurableAgentMuxMessage[]
}

export type AgentMuxDeliveryAcknowledgement = AgentMuxDeliveryReader & {
  readonly acknowledgedMessageIds: readonly string[]
  readonly nextGeneration: number
}

type DurableConsumerCursor = Pick<ConsumerCursor, 'acked' | 'generation'> & {
  readonly readerRun: AgentMuxRunRef
  readonly deliveryIds: readonly string[]
}

export type AgentMuxMessageReceipt = {
  readonly queueId: string
  readonly receiptId: string
  readonly messageId: string
  readonly sequence: number
  readonly envelope: AgentMuxMessageEnvelope
  readonly delivery: AgentMuxMessageDeliveryState
  readonly promptCondition?: AgentPromptCondition | null
  readonly sourceChannel?: AgentMessageChannel
  readonly sourceDevice?: AgentOperationDevice
}

export type AgentMuxMessageAppendInput = Omit<AgentMuxMessageEnvelope, 'schema' | 'messageId'> & {
  readonly messageId?: string
  readonly execution?: AgentPromptExecution
  readonly sourceChannel?: AgentMessageChannel
  readonly sourceDevice?: AgentOperationDevice
}

/** Readable recipient-side wrapper; envelope facts have already been validated by Core.
 *
 * Re-exported from `./agent-message-render.js` to preserve the original public API — the
 * pure-string implementation moved to a renderer-safe module so `apps/desktop/src/renderer`
 * can consume it without dragging node:* into the vite/rollup bundle graph. Details:
 * memory renderer-value-import-of-core-barrel-breaks-packaging.
 */
export { renderAgentMuxMessageEnvelope } from './agent-message-render.js'

const processQueueTails = new Map<string, Promise<void>>()

export type AgentMuxMessageJournalRecord =
  | { readonly kind: 'message'; readonly sequence: number; readonly envelope: AgentMuxMessageEnvelope; readonly promptCondition?: null; readonly execution?: AgentPromptExecution; readonly sourceChannel?: AgentMessageChannel; readonly sourceDevice?: AgentOperationDevice }
  | { readonly kind: 'prompt-condition'; readonly sequence: number; readonly messageId: string; readonly condition: AgentPromptCondition }
  | { readonly kind: 'delivery-issue'; readonly sequence: number; readonly messageId: string; readonly at: number; readonly reason: string }
  | { readonly kind: 'delivery'; readonly sequence: number; readonly messageId: string; readonly state: AgentDeliveryState; readonly at: number; readonly reason?: string }
  | { readonly kind: 'consumer-check'; readonly sequence: number; readonly consumerId: string; readonly readerRun: AgentMuxRunRef; readonly generation: number; readonly deliveryIds: readonly string[] }
  | { readonly kind: 'dispatch-open'; readonly sequence: number; readonly sourceMessageId: string; readonly at: number }
  | { readonly kind: 'dispatch-event'; readonly sequence: number; readonly sourceMessageId: string; readonly replyMessageId: string; readonly eventKind: DispatchEventKind; readonly at: number }
  | { readonly kind: 'consumer-ack'; readonly sequence: number; readonly consumerId: string; readonly readerRun: AgentMuxRunRef; readonly generation: number; readonly deliveryIds: readonly string[] }
type JournalMessage = Extract<AgentMuxMessageJournalRecord, { kind: 'message' }>
type JournalDelivery = Extract<AgentMuxMessageJournalRecord, { kind: 'delivery' }>
type JournalCheck = Extract<AgentMuxMessageJournalRecord, { kind: 'consumer-check' }>
type JournalAck = Extract<AgentMuxMessageJournalRecord, { kind: 'consumer-ack' }>
type JournalRecord = AgentMuxMessageJournalRecord
type DispatchProjection = { readonly sourceMessageId: string; readonly openedAt: number; readonly events: readonly DispatchEvent[] }

function storageCause(error: unknown, depth = 0): Record<string, unknown> {
  if (!error || typeof error !== 'object') return { message: String(error) }
  const value = error as { name?: unknown; message?: unknown; code?: unknown; detail?: unknown;
    phase?: unknown; errcode?: unknown; cause?: unknown; cleanup?: unknown }
  return { name: String(value.name ?? 'Error').slice(0, 128), message: String(value.message ?? error).slice(0, 2048),
    ...(typeof value.code === 'string' ? { code: value.code.slice(0, 128) } : {}),
    ...(typeof value.detail === 'string' ? { detail: value.detail.slice(0, 8192) } : {}),
    ...(typeof value.phase === 'string' ? { phase: value.phase.slice(0, 128) } : {}),
    ...(typeof value.errcode === 'number' ? { errcode: value.errcode } : {}),
    ...(depth >= 3 || !Array.isArray(value.cleanup) || !value.cleanup.length ? {} : {
      cleanup: value.cleanup.slice(0, 4).map(error => storageCause(error, depth + 1)) }),
    ...(depth >= 3 || value.cause === undefined ? {} : { cause: storageCause(value.cause, depth + 1) }) }
}

function storageFailure(stage: string, cause: unknown,
  cleanup: readonly { stage: string; error: unknown }[] = [],
  message = 'Message queue store is unavailable.', code = 'MESSAGE_QUEUE_UNAVAILABLE'): AgentMuxError {
  const original = cause instanceof AgentMuxError ? cause : undefined
  const error = new AgentMuxError(original?.message ?? message, original?.code ?? code,
    JSON.stringify({ stage, cause: storageCause(cause),
      ...(cleanup.length ? { cleanup: cleanup.map(item => ({ stage: item.stage, cause: storageCause(item.error) })) } : {}) }),
    original?.controlFailure, original?.logId)
  Object.defineProperty(error, 'cause', { value: cause, configurable: true })
  return error
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim() || /[\0\r\n]/u.test(value)) throw new AgentMuxError(`${label} is invalid.`, 'MESSAGE_ENVELOPE_INVALID')
  return value
}

function finiteTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new AgentMuxError(`${label} is invalid.`, 'MESSAGE_ENVELOPE_INVALID')
  return value
}

function identity(value: AgentMuxMessageIdentity, label: string): AgentMuxMessageIdentity {
  if (value.kind === 'agent-session') return { kind: value.kind, agentSessionId: nonEmpty(value.agentSessionId, label) }
  if (value.kind === 'human' && value.principal === 'local-cli') return value
  throw new AgentMuxError(`${label} is invalid.`, 'MESSAGE_ENVELOPE_INVALID')
}

function recipient(value: AgentMuxMessageRecipient): AgentMuxMessageRecipient {
  if (value.kind === 'agent-session') return { kind: value.kind, agentSessionId: nonEmpty(value.agentSessionId, 'Message recipient') }
  if (value.kind === 'target') {
    const target = value.target
    if (target.kind === 'self') return { kind: 'target', target }
    if (target.kind === 'agent-session') return { kind: 'target', target: { kind: target.kind, agentSessionId: nonEmpty(target.agentSessionId, 'Message recipient') } }
    if (target.kind === 'region') return { kind: 'target', target: { kind: target.kind, regionId: nonEmpty(target.regionId, 'Message recipient') } }
    if (target.kind === 'tab') return { kind: 'target', target: { kind: target.kind, tabId: nonEmpty(target.tabId, 'Message recipient') } }
  }
  throw new AgentMuxError('Message recipient is invalid.', 'MESSAGE_ENVELOPE_INVALID')
}

/** Validate an envelope crossing the control socket without deriving identity from UI facts. */
export function validateAgentMuxMessageEnvelope(value: unknown): AgentMuxMessageEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Message envelope is invalid.', 'MESSAGE_ENVELOPE_INVALID')
  const source = value as AgentMuxMessageEnvelope
  if (source.schema !== 'agentmux.a2a.v1') throw new AgentMuxError('Message envelope schema is invalid.', 'MESSAGE_ENVELOPE_INVALID')
  const messageId = nonEmpty(source.messageId, 'Message id')
  const operationId = nonEmpty(source.operationId, 'Message operation id')
  if (messageId === operationId) throw new AgentMuxError('Message id must not be the Control request id.', 'MESSAGE_ID_REQUEST_ID_COLLISION')
  if (typeof source.body !== 'string') throw new AgentMuxError('Message body is invalid.', 'MESSAGE_ENVELOPE_INVALID')
  const sender = identity(source.sender, 'Message sender')
  const target = recipient(source.recipient)
  return Object.freeze({
    schema: source.schema,
    messageId,
    operationId,
    createdAt: finiteTimestamp(source.createdAt, 'Message createdAt'),
    sender,
    recipient: target,
    threadId: nonEmpty(source.threadId, 'Message thread id'),
    correlationId: nonEmpty(source.correlationId, 'Message correlation id'),
    replyTo: source.replyTo === null ? null : nonEmpty(source.replyTo, 'Message replyTo'),
    workspaceId: source.workspaceId === null ? null : nonEmpty(source.workspaceId, 'Message workspace id'),
    senderSessionId: source.senderSessionId === null ? null : nonEmpty(source.senderSessionId, 'Message sender session id'),
    senderRunId: source.senderRunId === null ? null : nonEmpty(source.senderRunId, 'Message sender run id'),
    recipientSessionId: source.recipientSessionId === null ? null : nonEmpty(source.recipientSessionId, 'Message recipient session id'),
    recipientRunId: source.recipientRunId === null ? null : nonEmpty(source.recipientRunId, 'Message recipient run id'),
    body: source.body
  })
}

function sameEnvelope(left: AgentMuxMessageEnvelope, right: AgentMuxMessageEnvelope): boolean {
  const comparable = (value: AgentMuxMessageEnvelope): Omit<AgentMuxMessageEnvelope, 'operationId' | 'createdAt'> => {
    const { operationId: _operationId, createdAt: _createdAt, ...rest } = value
    return rest
  }
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right))
}

function queueIdFor(path: string): string {
  return `queue:${createHash('sha256').update(path).digest('hex').slice(0, 24)}`
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function reader(value: AgentMuxDeliveryReader): AgentMuxDeliveryReader {
  return { consumerId: nonEmpty(value.consumerId, 'Consumer id'),
    readerRun: { runId: nonEmpty(value.readerRun?.runId ?? '', 'Reader Run') } }
}

function assertGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AgentMuxError('Message consumer generation is invalid.', 'MESSAGE_ACK_GENERATION_STALE')
  }
}

export class DurableAgentMuxMessageQueue {
  readonly queueId: string
  private database: DatabaseSync | undefined

  private get db(): DatabaseSync {
    if (!this.database) throw new Error('Message journal transaction is not open.')
    return this.database
  }

  private get nextSequence(): number {
    return Number(this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM records').get()!.next)
  }

  constructor(readonly path = defaultAgentMuxMessageQueuePath()) {
    this.queueId = queueIdFor(path)
  }

  private withLock<T>(operation: () => Promise<T>, durableReceipt = false): Promise<T> {
    const key = `${this.path}.mutex.sqlite`
    const processTail = processQueueTails.get(key) ?? Promise.resolve()
    const result = processTail.then(() => this.withFileLock(operation, durableReceipt))
    const tail = result.then(() => undefined, () => undefined)
    processQueueTails.set(key, tail)
    // Do not retain a settled queue path forever; concurrent callers already hold this tail.
    void tail.then(() => { if (processQueueTails.get(key) === tail) processQueueTails.delete(key) })
    return result
  }

  private async withFileLock<T>(operation: () => Promise<T>, durableReceipt: boolean): Promise<T> {
    // SQLite's BEGIN IMMEDIATE is the cross-process writer mutex. The kernel releases it when a
    // process dies, including a crash during append, so there is no pathname to reclaim with a
    // check-then-unlink race. A legacy orphan .lock file is deliberately ignored.
    const mutexPath = `${this.path}.mutex.sqlite`
    let mutex: DatabaseSync | undefined
    let acquired = false
    let failed = false
    let failure: unknown
    let result!: T
    let stage = 'journal-directory'
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      // Loading the queue's validator or CLI help must not initialize SQLite or put an
      // experimental-module warning in the machine-readable error receipt stream.
      const { DatabaseSync } = await import('node:sqlite')
      stage = 'mutex-open'
      mutex = new DatabaseSync(mutexPath)
      stage = 'mutex-configure'
      await chmod(mutexPath, 0o600)
      // A separate writer must not synchronously stall this Core's terminal/Hook event loop.
      // The caller can retry its original operation after the positively busy owner releases it.
      configureMessageJournal(mutex)
      stage = 'mutex-acquire'
      mutex.exec('BEGIN IMMEDIATE'); acquired = true
      stage = 'journal-open'
      this.database = await openMessageJournal(this.path, mutex, (db, record) => {
        this.database = db
        try { this.applyRecord(record) } finally { this.database = undefined }
      })
      stage = 'journal-acquire'
      this.db.exec('BEGIN IMMEDIATE')
      stage = 'operation'
      result = await operation()
      stage = 'journal-commit'
      this.db.exec('COMMIT')
      // An idempotent return also confirms a previous lost durability ACK. Reading a row
      // alone cannot establish that the prior file or directory sync succeeded.
      if (durableReceipt) { stage = 'journal-confirm'; await syncMessageJournal(this.path) }
      stage = 'mutex-commit'
      mutex.exec('COMMIT')
      acquired = false
    } catch (error) {
      failed = true
      const sqlite = error as { code?: string; errcode?: number }
      // SQLite may also report busy while committing/releasing its mutex. The file may already
      // be published: retain that stage and never attach a not-applied input claim to this retry.
      failure = sqlite?.code === 'ERR_SQLITE_ERROR' && sqlite.errcode === 5
        ? storageFailure(stage, error, [], 'Message queue lock is busy.', 'MESSAGE_QUEUE_BACKPRESSURE')
        : error instanceof AgentMuxError || stage === 'operation' && sqlite?.code !== 'ERR_SQLITE_ERROR' ? error : storageFailure(stage, error)
    } finally {
      const cleanup: { stage: string; error: unknown }[] = []
      if (this.database) {
        try {
          if (this.database.isTransaction) this.database.exec('ROLLBACK')
        } catch (error) { cleanup.push({ stage: 'journal-rollback', error }) }
        try { this.database.close() } catch (error) { cleanup.push({ stage: 'journal-close', error }) }
        this.database = undefined
      }
      if (acquired) {
        try { mutex?.exec('ROLLBACK') } catch (error) { cleanup.push({ stage: 'mutex-rollback', error }) }
      }
      try { mutex?.close() } catch (error) { cleanup.push({ stage: 'mutex-close', error }) }
      if (cleanup.length) {
        failure = failed ? storageFailure('mutex-cleanup', failure, cleanup)
          : storageFailure(cleanup[0]!.stage, cleanup[0]!.error, cleanup.slice(1))
        failed = true
      }
    }
    if (failed) throw failure
    return result
  }

  private message(messageId: string): DurableAgentMuxMessage | undefined {
    const row = this.db.prepare(`SELECT m.message_sequence AS sequence, original.json AS original,
      condition.json AS condition, delivery.json AS delivery FROM messages m
      JOIN records original ON original.sequence = m.message_sequence
      LEFT JOIN records condition ON condition.sequence = m.condition_sequence
      LEFT JOIN records delivery ON delivery.sequence = m.delivery_sequence
      WHERE m.message_id = ?`).get(messageId)
    if (!row) return undefined
    const original = JSON.parse(String(row.original)) as JournalMessage
    const envelope = validateAgentMuxMessageEnvelope(original.envelope)
    const condition = row.condition === null ? null : JSON.parse(String(row.condition)) as Extract<JournalRecord, {kind: 'prompt-condition'}>
    const last = row.delivery === null ? null : JSON.parse(String(row.delivery)) as Extract<JournalRecord, {kind: 'delivery' | 'delivery-issue'}>
    const delivery: AgentMuxMessageDeliveryState = last?.kind === 'delivery'
      ? { state: last.state, at: last.at, ...(last.reason === undefined ? {} : { reason: last.reason }) }
      : { state: 'queued', at: envelope.createdAt, ...(last ? { reason: last.reason } : {}) }
    return { sequence: Number(row.sequence), envelope, delivery,
      ...(condition ? { promptCondition: validateAgentPromptCondition(condition.condition) } : original.promptCondition === null ? { promptCondition: null } : {}),
      ...(original.execution === undefined ? {} : { execution: original.execution }),
      ...(original.sourceChannel === undefined ? {} : { sourceChannel: normalizeMessageChannel(original.sourceChannel) }),
      ...(original.sourceDevice === undefined ? {} : { sourceDevice: normalizeOperationDevice(original.sourceDevice) }) }
  }

  private operationMessageId(operationId: string): string | undefined {
    return this.db.prepare('SELECT message_id FROM messages WHERE operation_id = ?').get(operationId)?.message_id as string | undefined
  }

  private consumer(consumerId: string): DurableConsumerCursor | undefined {
    const row = this.db.prepare('SELECT acked, generation, reader_run, delivery_ids FROM consumers WHERE consumer_id = ?').get(consumerId)
    return row ? { acked: Number(row.acked), generation: Number(row.generation),
      readerRun: { runId: String(row.reader_run) }, deliveryIds: JSON.parse(String(row.delivery_ids)) as string[] } : undefined
  }

  private saveConsumer(consumerId: string, cursor: DurableConsumerCursor): void {
    this.db.prepare(`INSERT INTO consumers VALUES (?, ?, ?, ?, ?) ON CONFLICT(consumer_id)
      DO UPDATE SET acked=excluded.acked, generation=excluded.generation,
      reader_run=excluded.reader_run, delivery_ids=excluded.delivery_ids`).run(
      consumerId, cursor.acked, cursor.generation, cursor.readerRun.runId, JSON.stringify(cursor.deliveryIds))
  }

  private inboxIds(consumerId: string, acked: number, limit: number): string[] {
    return this.db.prepare(`SELECT message_id FROM messages
      WHERE recipient_id = ? AND recipient_ordinal > ? ORDER BY recipient_ordinal LIMIT ?`)
      .all(consumerId, acked, limit).map(row => String(row.message_id))
  }

  /** Pure batch arithmetic only receives this consumer's current slice, never unrelated history. */
  private batchQueue(consumerId: string, cursor: DurableConsumerCursor | undefined, pending: readonly string[]): DeliveryQueue {
    return { pending, consumers: cursor ? { [consumerId]: {
      acked: 0, generation: cursor.generation, inFlight: cursor.deliveryIds.length } } : {} }
  }

  private dispatchFacts(sourceMessageId: string): DispatchProjection | undefined {
    const row = this.db.prepare(`SELECT r.json FROM dispatches d JOIN records r
      ON r.sequence=d.open_sequence WHERE d.source_message_id=?`).get(sourceMessageId)
    if (!row) return undefined
    const original = JSON.parse(String(row.json)) as Extract<JournalRecord, {kind: 'dispatch-open'}>
    const events = this.db.prepare(`SELECT r.json FROM dispatch_events e JOIN records r
      ON r.sequence=e.event_sequence WHERE e.source_message_id=? ORDER BY e.event_sequence`).all(sourceMessageId)
      .map(value => JSON.parse(String(value.json)) as Extract<JournalRecord, {kind: 'dispatch-event'}>)
      .map(event => ({ kind: event.eventKind, replyMessageId: event.replyMessageId, at: event.at }))
    return { sourceMessageId, openedAt: original.at, events }
  }

  /** Admission and projection update are the same code for the one import and every new fact. */
  private applyRecord(record: JournalRecord): void {
    if (!Number.isSafeInteger(record.sequence) || record.sequence < this.nextSequence) {
      throw new AgentMuxError('Message journal sequence is invalid or out of order.', 'MESSAGE_QUEUE_UNAVAILABLE')
    }
    if (record.kind === 'message') {
      if (record.execution !== undefined && record.execution !== 'default' && record.execution !== 'immediate') throw new AgentMuxError('Message execution is invalid.', 'MESSAGE_QUEUE_UNAVAILABLE')
      const envelope = validateAgentMuxMessageEnvelope(record.envelope)
      if (record.promptCondition !== undefined && record.promptCondition !== null) throw new AgentMuxError('Message initial condition is invalid.', 'MESSAGE_QUEUE_UNAVAILABLE')
      if (record.sourceChannel !== undefined) normalizeMessageChannel(record.sourceChannel)
      if (record.sourceDevice !== undefined) normalizeOperationDevice(record.sourceDevice)
      const consumerId = envelope.recipient.kind === 'agent-session' && envelope.recipient.agentSessionId === envelope.recipientSessionId
        ? envelope.recipient.agentSessionId : null
      const ordinal = consumerId === null ? null : Number(this.db.prepare(
        'SELECT COALESCE(MAX(recipient_ordinal), 0) + 1 AS next FROM messages WHERE recipient_id = ?').get(consumerId)!.next)
      this.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL, NULL)').run(
        envelope.messageId, envelope.operationId, record.sequence, consumerId, ordinal)
    } else if (record.kind === 'prompt-condition') {
      const current = this.message(record.messageId)
      if (!current || current.promptCondition !== null) throw new AgentMuxError('Message prompt condition is inconsistent.', 'MESSAGE_QUEUE_UNAVAILABLE')
      const condition = validateAgentPromptCondition(record.condition)
      if (current.envelope.recipientRunId !== null && current.envelope.recipientRunId !== condition.expectedRun.runId) {
        throw new AgentMuxError('Message prompt targets another Run.', 'MESSAGE_RECIPIENT_MISMATCH')
      }
      this.db.prepare('UPDATE messages SET condition_sequence=? WHERE message_id=?').run(record.sequence, record.messageId)
    } else if (record.kind === 'delivery' || record.kind === 'delivery-issue') {
      const current = this.message(record.messageId)
      if (!current) throw new AgentMuxError('Message queue delivery references an unknown message.', 'MESSAGE_QUEUE_UNAVAILABLE')
      if (record.kind === 'delivery') advanceDelivery(current.delivery, record.state, record.at)
      else if (current.delivery.state !== 'queued') throw new AgentMuxError('Message delivery issue contradicts its confirmed receipt.', 'MESSAGE_QUEUE_UNAVAILABLE')
      finiteTimestamp(record.at, 'Delivery time')
      if (record.reason !== undefined && typeof record.reason !== 'string') throw new AgentMuxError('Message delivery reason is invalid.', 'MESSAGE_QUEUE_UNAVAILABLE')
      this.db.prepare('UPDATE messages SET delivery_sequence=? WHERE message_id=?').run(record.sequence, record.messageId)
    } else if (record.kind === 'dispatch-open' || record.kind === 'dispatch-event') {
      const sourceMessageId = nonEmpty(record.sourceMessageId, 'Dispatch source message id')
      finiteTimestamp(record.at, 'Dispatch time')
      if (record.kind === 'dispatch-open') {
        this.db.prepare('INSERT OR IGNORE INTO dispatches VALUES (?, ?)').run(sourceMessageId, record.sequence)
      } else {
        if (!this.db.prepare('SELECT 1 FROM dispatches WHERE source_message_id=?').get(sourceMessageId)) {
          throw new AgentMuxError('Dispatch event has no open fact.', 'MESSAGE_QUEUE_UNAVAILABLE')
        }
        nonEmpty(record.replyMessageId, 'Dispatch reply message id'); assertDispatchEventKind(record.eventKind)
        const previous = this.db.prepare(`SELECT r.json FROM dispatch_events e JOIN records r
          ON r.sequence=e.event_sequence WHERE e.source_message_id=? AND e.reply_message_id=?`).get(sourceMessageId, record.replyMessageId)
        if (previous && (JSON.parse(String(previous.json)) as Extract<JournalRecord, {kind: 'dispatch-event'}>).eventKind !== record.eventKind) {
          throw new AgentMuxError('Dispatch journal event identity conflicts.', 'MESSAGE_QUEUE_UNAVAILABLE')
        }
        this.db.prepare('INSERT OR IGNORE INTO dispatch_events VALUES (?, ?, ?)').run(sourceMessageId, record.replyMessageId, record.sequence)
      }
    } else if (record.kind === 'consumer-check' || record.kind === 'consumer-ack') {
      const identity = reader(record); assertGeneration(record.generation)
      if (!Array.isArray(record.deliveryIds) || record.deliveryIds.some(id => typeof id !== 'string') ||
        new Set(record.deliveryIds).size !== record.deliveryIds.length) throw new AgentMuxError('Message consumer batch is invalid.', 'MESSAGE_QUEUE_UNAVAILABLE')
      const previous = this.consumer(identity.consumerId)
      if (!sameIds(record.deliveryIds, this.inboxIds(identity.consumerId, previous?.acked ?? 0, record.deliveryIds.length))) {
        throw new AgentMuxError('Message consumer batch is not in its recipient domain.', 'MESSAGE_QUEUE_UNAVAILABLE')
      }
      if (record.kind === 'consumer-check') {
        const replacement = previous !== undefined && previous.readerRun.runId !== identity.readerRun.runId
        const expectedGeneration = previous ? previous.generation + (replacement ? 1 : 0) : 1
        if (record.generation !== expectedGeneration ||
          (previous && previous.deliveryIds.length > 0 && !sameIds(previous.deliveryIds, record.deliveryIds))) {
          throw new AgentMuxError('Message consumer check is inconsistent.', 'MESSAGE_QUEUE_UNAVAILABLE')
        }
        this.saveConsumer(identity.consumerId, { acked: previous?.acked ?? 0,
          generation: record.generation, readerRun: identity.readerRun, deliveryIds: [...record.deliveryIds] })
      } else this.saveConsumer(identity.consumerId, this.cursorAfterAck(record))
    } else throw new AgentMuxError('Message queue journal record is invalid.', 'MESSAGE_QUEUE_UNAVAILABLE')
    this.db.prepare('INSERT INTO records VALUES (?, ?)').run(record.sequence, JSON.stringify(record))
  }

  private cursorAfterAck(record: JournalAck): DurableConsumerCursor {
    const current = this.consumer(record.consumerId)
    if (!current || current.readerRun.runId !== record.readerRun.runId || !sameIds(current.deliveryIds, record.deliveryIds)) {
      throw new AgentMuxError('Message consumer reader is stale.', 'MESSAGE_ACK_GENERATION_STALE')
    }
    const next = ackDeliveryBatch(this.batchQueue(record.consumerId, current, current.deliveryIds),
      record.consumerId, record.generation).consumers[record.consumerId]!
    return { acked: current.acked + next.acked, generation: next.generation,
      readerRun: { ...current.readerRun }, deliveryIds: [] }
  }

  private async appendRecord(record: JournalRecord): Promise<void> {
    try { this.applyRecord(record) } catch (error) {
      throw error instanceof AgentMuxError ? error : storageFailure('journal-write', error)
    }
  }

  async append(input: AgentMuxMessageAppendInput): Promise<AgentMuxMessageReceipt> {
    return this.withLock(async () => {
      const messageId = input.messageId ?? mintObjectId()
      if (input.execution !== undefined && input.execution !== 'default' && input.execution !== 'immediate') throw new AgentMuxError('Message execution is invalid.', 'INVALID_CONTROL_REQUEST')
      const execution = input.execution ?? 'default'
      const sourceChannel = input.sourceChannel === undefined ? undefined : normalizeMessageChannel(input.sourceChannel)
      const sourceDevice = input.sourceDevice === undefined ? undefined : normalizeOperationDevice(input.sourceDevice)
      const sameOrigin = (existing: DurableAgentMuxMessage) => existing.sourceChannel === sourceChannel &&
        JSON.stringify(existing.sourceDevice) === JSON.stringify(sourceDevice)
      const envelope = validateAgentMuxMessageEnvelope({ ...input, schema: 'agentmux.a2a.v1', messageId })
      const existingId = this.operationMessageId(envelope.operationId)
      if (existingId) {
        const existing = this.message(existingId)!
        if (!sameEnvelope(existing.envelope, envelope) || (existing.execution ?? 'default') !== execution || !sameOrigin(existing)) throw new AgentMuxError('Message operation already names another envelope, execution or source.', 'MESSAGE_ID_CONFLICT')
        return this.receipt(existing)
      }
      const existing = this.message(messageId)
      if (existing) {
        if (!sameEnvelope(existing.envelope, envelope) || (existing.execution ?? 'default') !== execution || !sameOrigin(existing)) throw new AgentMuxError('Message id already names another envelope, execution or source.', 'MESSAGE_ID_CONFLICT')
        return this.receipt(existing)
      }
      const record: JournalMessage = { kind: 'message', sequence: this.nextSequence, envelope, promptCondition: null, execution,
        ...(sourceChannel === undefined ? {} : { sourceChannel }), ...(sourceDevice === undefined ? {} : { sourceDevice }) }
      await this.appendRecord(record)
      return this.receipt(this.message(messageId)!)
    }, true)
  }

  async recordDelivery(messageId: string, state: Exclude<AgentDeliveryState, 'queued'>, at = Date.now(), reason?: string): Promise<AgentMuxMessageReceipt> {
    return this.withLock(async () => {
      const current = this.message(nonEmpty(messageId, 'Message id'))
      if (!current) throw new AgentMuxError('Message is unknown.', 'MESSAGE_NOT_FOUND')
      if (current.delivery.state === state) return this.receipt(current)
      advanceDelivery(current.delivery, state, at)
      const record: JournalDelivery = { kind: 'delivery', sequence: this.nextSequence, messageId, state, at, ...(reason === undefined ? {} : { reason }) }
      await this.appendRecord(record)
      return this.receipt(this.message(messageId)!)
    }, true)
  }

  /** An unavailable Control receipt does not establish terminal failure or erase a known delivery. */
  async recordDeliveryIssue(messageId: string, reason: string, at = Date.now()): Promise<AgentMuxMessageReceipt> {
    return this.withLock(async () => {
      const current = this.message(nonEmpty(messageId, 'Message id'))
      if (!current) throw new AgentMuxError('Message is unknown.', 'MESSAGE_NOT_FOUND')
      if (current.delivery.state !== 'queued') return this.receipt(current)
      await this.appendRecord({ kind: 'delivery-issue', sequence: this.nextSequence, messageId,
        at: finiteTimestamp(at, 'Delivery issue time'), reason })
      return this.receipt(this.message(messageId)!)
    }, true)
  }

  /** The existing journal owns the first condition even if a Control response is lost. */
  async preparePrompt(messageId: string, capture: (envelope: AgentMuxMessageEnvelope) => Promise<AgentPromptCondition>): Promise<AgentPromptCondition> {
    const original = await this.withLock(async () => {
      const current = this.message(nonEmpty(messageId, 'Message id'))
      if (!current) throw new AgentMuxError('Message is unknown.', 'MESSAGE_NOT_FOUND')
      if (current.promptCondition === undefined) throw new AgentMuxError(
        'This message has no original prompt delivery condition. Its delivery is unknown; it will not be prepared as a new message.',
        'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
      const condition = current.promptCondition
      return { envelope: structuredClone(current.envelope), condition: condition === null ? null : structuredClone(condition) }
    }, true)
    if (original.condition !== null) return original.condition
    // Observation is not a journal mutation. A slow target must not hold the global
    // writer while unrelated messages append; the second scope keeps the first binding.
    const candidate = validateAgentPromptCondition(await capture(original.envelope))
    return this.withLock(async () => {
      const current = this.message(messageId)
      if (!current || current.promptCondition === undefined) throw new AgentMuxError(
        'The original message condition can no longer be confirmed.', 'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
      if (current.promptCondition !== null) return structuredClone(current.promptCondition)
      if (current.envelope.recipientRunId !== null && current.envelope.recipientRunId !== candidate.expectedRun.runId) {
        throw new AgentMuxError('Message recipient Run changed before preparation.', 'MESSAGE_RECIPIENT_MISMATCH')
      }
      await this.appendRecord({ kind: 'prompt-condition', sequence: this.nextSequence, messageId, condition: candidate })
      return structuredClone(candidate)
    }, true)
  }

  /** Read the first original operation binding without replaying unrelated communication. */
  async readByOperationId(operationId: string): Promise<DurableAgentMuxMessage | null> {
    return this.withLock(async () => {
      const messageId = this.operationMessageId(nonEmpty(operationId, 'Message operation id'))
      return messageId ? this.message(messageId)! : null
    })
  }

  async listAfter(sequence = 0): Promise<readonly DurableAgentMuxMessage[]> {
    return this.withLock(async () => this.db.prepare(
      'SELECT message_id FROM messages WHERE message_sequence > ? ORDER BY message_sequence').all(sequence)
      .map(row => this.message(String(row.message_id))!))
  }

  async readJournal(): Promise<readonly AgentMuxMessageJournalRecord[]> {
    return this.withLock(async () => this.db.prepare('SELECT json FROM records ORDER BY sequence').all()
      .map(row => JSON.parse(String(row.json)) as JournalRecord))
  }

  async check(
    input: AgentMuxDeliveryReader & { readonly limit: number },
    reauthorize: () => Promise<void>
  ): Promise<AgentMuxDeliveryBatch> {
    const identity = reader(input)
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new AgentMuxError('Message batch limit must be an integer from 1 to 100.', 'MESSAGE_BATCH_LIMIT_INVALID')
    }
    return this.withLock(async () => {
      await reauthorize()
      const previous = this.consumer(identity.consumerId)
      const replacement = previous !== undefined && previous.readerRun.runId !== identity.readerRun.runId
      const pending = previous?.deliveryIds.length ? previous.deliveryIds
        : this.inboxIds(identity.consumerId, previous?.acked ?? 0, input.limit)
      const current = replacement ? { ...previous, generation: previous.generation + 1 } : previous
      const batch = checkDeliveries(this.batchQueue(identity.consumerId, current, pending), identity.consumerId, input.limit)
      const changed = replacement || (previous?.deliveryIds.length ?? 0) === 0 && batch.deliveryIds.length > 0
      if (changed) {
        await this.appendRecord({ kind: 'consumer-check', sequence: this.nextSequence,
          ...identity, generation: batch.generation, deliveryIds: batch.deliveryIds })
      }
      return { ...identity, generation: batch.generation,
        messages: batch.deliveryIds.map((messageId) => structuredClone(this.message(messageId)!)) }
    }, true)
  }

  async ack(
    input: AgentMuxDeliveryReader & { readonly generation: number },
    reauthorize: () => Promise<void>
  ): Promise<AgentMuxDeliveryAcknowledgement> {
    const identity = reader(input)
    assertGeneration(input.generation)
    return this.withLock(async () => {
      await reauthorize()
      const current = this.consumer(identity.consumerId)
      const record: JournalAck = { kind: 'consumer-ack', sequence: this.nextSequence,
        ...identity, generation: input.generation, deliveryIds: current?.deliveryIds ?? [] }
      const next = this.cursorAfterAck(record) // Validate before writing, including the pure generation fence.
      await this.appendRecord(record)
      return { ...identity, acknowledgedMessageIds: [...record.deliveryIds], nextGeneration: next.generation }
    }, true)
  }

  private dispatchMessage(messageId: string): AgentMuxMessageEnvelope {
    const message = this.message(nonEmpty(messageId, 'Dispatch message id'))
    if (!message) {
      throw new AgentMuxError('A referenced Dispatch message is not retained in this journal.', 'DISPATCH_MESSAGE_UNAVAILABLE')
    }
    // The original creation envelope honestly predates its Run. The same journal's
    // immutable delivery condition supplies that Run only for this admission projection.
    const envelope = message.envelope.recipientRunId === null && message.promptCondition
      ? { ...message.envelope, recipientRunId: message.promptCondition.expectedRun.runId } : message.envelope
    assertDispatchMessage(envelope)
    return envelope
  }

  private dispatchProjection(sourceMessageId: string, facts = this.dispatchFacts(nonEmpty(sourceMessageId, 'Dispatch source message id'))): { dispatch: Dispatch; messages: readonly AgentMuxMessageEnvelope[] } {
    if (!facts) throw new AgentMuxError('This source message has no open Dispatch.', 'DISPATCH_NOT_FOUND')
    const source = this.dispatchMessage(sourceMessageId)
    let dispatch = openDispatch(source, facts.openedAt)
    const messages = [source]
    for (const event of facts.events) {
      const reply = this.dispatchMessage(event.replyMessageId)
      messages.push(reply)
      dispatch = recordDispatchEvent(dispatch, reply, event.kind, event.at)
    }
    return { dispatch, messages }
  }

  async openDispatch(
    input: { readonly callerAgentSessionId: string; readonly sourceMessageId: string },
    reauthorize: (messages: readonly AgentMuxMessageEnvelope[]) => Promise<void>
  ): Promise<Dispatch> {
    return this.withLock(async () => {
      const source = this.dispatchMessage(input.sourceMessageId)
      const facts = this.dispatchFacts(input.sourceMessageId)
      const existing = facts ? this.dispatchProjection(input.sourceMessageId, facts) : null
      const dispatch = existing?.dispatch ?? openDispatch(source, Date.now())
      await reauthorize(existing?.messages ?? [source])
      if (input.callerAgentSessionId !== dispatch.ownerAgentSessionId) {
        throw new AgentMuxError('Only the source sender can open this Dispatch.', 'DISPATCH_PARTICIPANT_MISMATCH')
      }
      if (!existing) await this.appendRecord({ kind: 'dispatch-open', sequence: this.nextSequence,
        sourceMessageId: dispatch.sourceMessageId, at: dispatch.openedAt })
      return structuredClone(dispatch)
    }, true)
  }

  async recordDispatchEvent(
    input: { readonly callerAgentSessionId: string; readonly sourceMessageId: string; readonly replyMessageId: string; readonly kind: DispatchEventKind },
    reauthorize: (messages: readonly AgentMuxMessageEnvelope[]) => Promise<void>
  ): Promise<Dispatch> {
    return this.withLock(async () => {
      assertDispatchEventKind(input.kind)
      const { dispatch, messages } = this.dispatchProjection(input.sourceMessageId)
      const reply = this.dispatchMessage(input.replyMessageId)
      await reauthorize([...messages, reply])
      const actor = input.kind === 'cleanup' ? dispatch.ownerAgentSessionId : dispatch.workerAgentSessionId
      if (input.callerAgentSessionId !== actor) {
        throw new AgentMuxError('This caller cannot report that Dispatch event.', 'DISPATCH_PARTICIPANT_MISMATCH')
      }
      const next = recordDispatchEvent(dispatch, reply, input.kind, Date.now())
      if (next !== dispatch) await this.appendRecord({ kind: 'dispatch-event', sequence: this.nextSequence,
        sourceMessageId: input.sourceMessageId, replyMessageId: input.replyMessageId,
        eventKind: input.kind, at: next.events.at(-1)!.at })
      return structuredClone(next)
    }, true)
  }

  async showDispatch(
    input: { readonly callerAgentSessionId: string; readonly sourceMessageId: string },
    reauthorize: (messages: readonly AgentMuxMessageEnvelope[]) => Promise<void>
  ): Promise<Dispatch> {
    return this.withLock(async () => {
      const { dispatch, messages } = this.dispatchProjection(input.sourceMessageId)
      await reauthorize(messages)
      if (input.callerAgentSessionId !== dispatch.ownerAgentSessionId && input.callerAgentSessionId !== dispatch.workerAgentSessionId) {
        throw new AgentMuxError('Only a Dispatch participant can inspect it.', 'DISPATCH_PARTICIPANT_MISMATCH')
      }
      return structuredClone(dispatch)
    })
  }

  private receipt(message: DurableAgentMuxMessage): AgentMuxMessageReceipt {
    return {
      queueId: this.queueId,
      receiptId: `${this.queueId}:${message.sequence}:${message.envelope.messageId}`,
      messageId: message.envelope.messageId,
      sequence: message.sequence,
      envelope: structuredClone(message.envelope),
      delivery: { ...message.delivery },
      ...(message.promptCondition === undefined ? {} : { promptCondition: structuredClone(message.promptCondition) }),
      ...(message.sourceChannel === undefined ? {} : { sourceChannel: message.sourceChannel }),
      ...(message.sourceDevice === undefined ? {} : { sourceDevice: { ...message.sourceDevice } })
    }
  }
}

export async function appendGlobalMessage(input: AgentMuxMessageAppendInput, path = defaultAgentMuxMessageQueuePath()): Promise<AgentMuxMessageReceipt> {
  return await new DurableAgentMuxMessageQueue(path).append(input)
}

export async function recordGlobalMessageDelivery(messageId: string, state: Exclude<AgentDeliveryState, 'queued'>, at = Date.now(), reason?: string, path = defaultAgentMuxMessageQueuePath()): Promise<AgentMuxMessageReceipt> {
  return await new DurableAgentMuxMessageQueue(path).recordDelivery(messageId, state, at, reason)
}

export async function prepareGlobalMessagePrompt(messageId: string,
  capture: (envelope: AgentMuxMessageEnvelope) => Promise<AgentPromptCondition>, path = defaultAgentMuxMessageQueuePath()
): Promise<AgentPromptCondition> {
  return await new DurableAgentMuxMessageQueue(path).preparePrompt(messageId, capture)
}

export async function recordGlobalMessageDeliveryIssue(messageId: string, reason: string, at = Date.now(),
  path = defaultAgentMuxMessageQueuePath()
): Promise<AgentMuxMessageReceipt> {
  return await new DurableAgentMuxMessageQueue(path).recordDeliveryIssue(messageId, reason, at)
}
