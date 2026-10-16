import { validateAgentMuxMessageEnvelope, messageEnvelopeString as nonEmpty, messageEnvelopeTimestamp as finiteTimestamp, type AgentMuxMessageEnvelope } from './agent-message-envelope.js'
export { validateAgentMuxMessageEnvelope } from './agent-message-envelope.js'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AgentMuxMessageQuery, AgentMuxMessagePage, AgentMuxMessageMetadata } from './agent-message-query.js'
import { isDeepStrictEqual } from 'node:util'
import { mintObjectId } from './object-id.js'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from './errors.js'
import { assertDispatchEventKind, assertDispatchMessage, openDispatch, recordDispatchEvent, type Dispatch, type DispatchEvent, type DispatchEventKind,
  type DispatchObservation, type DispatchIdentityDiagnostic, type DispatchPage } from './agent-handoff.js'
import { validateAgentPromptAdmissionIntent, validateAgentPromptCondition, type AgentPromptAdmissionIntent, type AgentPromptCondition } from './agent-prompt-condition.js'
import { ackDeliveryBatch, checkDeliveries, type ConsumerCursor, type DeliveryQueue } from './agent-delivery-queue.js'
import { advanceDelivery, type AgentDeliveryState } from './agent-message.js'
import type { AgentMuxMessageTarget } from './control.js'
import { defaultAgentMuxMessageQueuePath } from './runtime-paths.js'
import type { AgentMuxRunRef, AgentPromptExecution, AgentMessageChannel, AgentOperationDevice } from './types.js'
import { normalizeMessageChannel } from './message-origin.js'
import { composeAgentPrompt } from './agent-outbound-message.js'
import { normalizeOperationDevice } from './operation-device.js'
import { configureMessageJournal, inputControlJournalSchema, messageRouteJournalSchema, dispatchDiscoveryJournalSchema, dispatchReplyJournalSchema, openMessageJournal, syncMessageJournal } from './agent-message-journal.js'
import { assertAgentMessageRouteIntent, validateAgentMessageRoute, type AgentMessageRoute } from './agent-message-route.js'
import { agentInputJournalKey, validateAgentInputControlId, validateAgentInputWaitRef,
  type AgentInputJournalIntent, type AgentInputJournalEntry, type AgentInputSelector, type AgentInputWaitControl,
  type AgentInputWaitJournalRecord, type AgentInputWaitReason, type AgentInputWaitRef,
  type AgentInputWaitStopReceipt, type AgentInputDispatchLink } from './agent-input-wait.js'
import { validateAgentPromptInputKey, type AgentPromptInputKey } from './agent-prompt-condition.js'
import { parseAgentInputMailboxRead, type AgentInputMailboxRead } from './agent-input-mailbox.js'

export type { AgentMuxMessageIdentity, AgentMuxMessageRecipient, AgentMuxMessageEnvelope } from './agent-message-envelope.js'
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
  readonly admissionIntent?: AgentPromptAdmissionIntent
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
  readonly admissionIntent?: AgentPromptAdmissionIntent
  readonly sourceChannel?: AgentMessageChannel
  readonly sourceDevice?: AgentOperationDevice
  readonly input?: AgentInputJournalEntry
}

export type AgentMuxMessageAppendInput = Omit<AgentMuxMessageEnvelope, 'schema' | 'messageId'> & {
  readonly messageId?: string
  readonly execution?: AgentPromptExecution
  readonly admissionIntent?: AgentPromptAdmissionIntent
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
const inputMailboxCursorKey = randomBytes(32)
type InputMailboxCursor = { queueId: string; incarnation: string; agentSessionId: string; through: number; before: number; offset?: number; digest?: string }
type InputMailboxJournalItem = { sequence: number; recordedAt: number } & (
  | { kind: 'controlled'; intent: AgentInputJournalIntent; control: AgentInputWaitControl; message?: AgentMuxMessageEnvelope; sourceChannel?: AgentMessageChannel; sourceDevice?: AgentOperationDevice }
  | { kind: 'submission'; key: AgentPromptInputKey }
)

export type AgentMuxMessageJournalRecord =
  | AgentInputWaitJournalRecord
  | { readonly kind: 'message-route'; readonly sequence: number; readonly route: AgentMessageRoute }
  | { readonly kind: 'message'; readonly sequence: number; readonly envelope: AgentMuxMessageEnvelope; readonly promptCondition?: null; readonly execution?: AgentPromptExecution; readonly admissionIntent?: AgentPromptAdmissionIntent; readonly sourceChannel?: AgentMessageChannel; readonly sourceDevice?: AgentOperationDevice }
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
      // Existing journals are validated by their original owner before this
      // writer transaction adds its own bounded internal projections.
      this.db.exec(inputControlJournalSchema)
      this.db.exec(messageRouteJournalSchema)
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
      ...(original.admissionIntent === undefined ? {} : { admissionIntent: validateAgentPromptAdmissionIntent(original.admissionIntent) }),
      ...(original.sourceChannel === undefined ? {} : { sourceChannel: normalizeMessageChannel(original.sourceChannel) }),
      ...(original.sourceDevice === undefined ? {} : { sourceDevice: normalizeOperationDevice(original.sourceDevice) }) }
  }

  private input(key: import('./agent-prompt-condition.js').AgentPromptInputKey): AgentInputJournalEntry | undefined {
    const row = this.db.prepare(`SELECT original.json AS original, latest.json AS latest FROM input_intents i
      JOIN records original ON original.sequence=i.intent_sequence JOIN records latest ON latest.sequence=i.control_sequence
      WHERE i.input_id=?`).get(agentInputJournalKey(key))
    if (!row) return undefined
    const original = JSON.parse(String(row.original)) as Extract<AgentInputWaitJournalRecord, { kind: 'input-intent' | 'input-submission' }>
    if (!isDeepStrictEqual(original.kind === 'input-submission' ? original.key : original.intent.key, key)) throw new AgentMuxError('Another producer owns this original input identity.', 'AGENT_PROMPT_OPERATION_CONFLICT')
    if (original.kind === 'input-submission') return undefined
    const latest = JSON.parse(String(row.latest)) as Extract<AgentInputWaitJournalRecord, { kind: 'input-intent' | 'input-control' }>
    return { sequence: original.sequence, intent: structuredClone(original.intent), control: latest.kind === 'input-intent'
      ? { ref: { key: structuredClone(original.intent.key), waitGeneration: 1 }, state: 'enabled', at: original.at }
      : structuredClone(latest.control) }
  }

  private applyInputRecord(record: AgentInputWaitJournalRecord): void {
    if (record.kind === 'input-submission') {
      const key = validateAgentPromptInputKey(record.key)
      finiteTimestamp(record.at, 'Original input acceptance time')
      this.db.prepare('INSERT INTO input_intents VALUES (?, ?, ?, ?)').run(agentInputJournalKey(key), key.agentSessionId, record.sequence, record.sequence)
      return
    }
    if (record.kind === 'input-intent') {
      const intent = record.intent, key = validateAgentPromptInputKey(intent.key)
      const admissionIntent = validateAgentPromptAdmissionIntent(intent.admissionIntent)
      if (intent.execution !== 'immediate' || admissionIntent.kind === 'exact-condition' || admissionIntent.expectedRun.runId !== key.expectedRun.runId) {
        throw new AgentMuxError('Controlled input must preserve its explicit direct intent.', 'INVALID_AGENT_INPUT_CONTROL')
      }
      finiteTimestamp(record.at, 'Input acceptance time')
      nonEmpty(intent.environment.providerId, 'Input Provider'); nonEmpty(intent.environment.executorId, 'Input executor')
      if (intent.source.kind === 'prompt') {
        if (key.kind !== 'prompt' || typeof intent.source.prompt !== 'string' ||
            intent.source.agentMuxNote !== undefined && typeof intent.source.agentMuxNote !== 'string' ||
            intent.source.authorHuman !== undefined && typeof intent.source.authorHuman !== 'boolean') {
          throw new AgentMuxError('Original prompt intent is invalid.', 'INVALID_AGENT_INPUT_CONTROL')
        }
        if (!composeAgentPrompt(intent.source.prompt, intent.source.agentMuxNote).text.trim()) throw new AgentMuxError('Original prompt intent is empty.', 'INVALID_AGENT_INPUT_CONTROL')
        if (intent.source.sourceChannel !== undefined) normalizeMessageChannel(intent.source.sourceChannel)
        if (intent.source.sourceDevice !== undefined) normalizeOperationDevice(intent.source.sourceDevice)
      } else if (intent.source.kind === 'message') {
        const message = this.message(intent.source.messageId)
        if (key.kind !== 'message' || key.messageId !== intent.source.messageId || !message ||
            message.envelope.operationId !== intent.source.originalControlOperationId ||
            message.envelope.recipientSessionId !== key.agentSessionId || message.envelope.recipientRunId !== key.expectedRun.runId ||
            !isDeepStrictEqual(message.admissionIntent, admissionIntent)) throw new AgentMuxError('Original message intent is invalid.', 'INVALID_AGENT_INPUT_CONTROL')
      } else throw new AgentMuxError('Original input producer is invalid.', 'INVALID_AGENT_INPUT_CONTROL')
      this.db.prepare('INSERT INTO input_intents VALUES (?, ?, ?, ?)').run(agentInputJournalKey(key), key.agentSessionId, record.sequence, record.sequence)
      return
    }
    const ref = validateAgentInputWaitRef(record.kind === 'input-control' ? record.control.ref : record.receipt.ref)
    const current = this.input(ref.key)
    if (!current) throw new AgentMuxError('Original controlled input is unknown.', 'AGENT_INPUT_NOT_FOUND')
    if (record.kind === 'input-stop') {
      const receipt = record.receipt
      validateAgentInputControlId(receipt.cancelOperationId); finiteTimestamp(receipt.at, 'Input stop time')
      if (!['stopped-before-dispatch', 'observation-stopped', 'already-settled', 'stale-generation'].includes(receipt.outcome)) {
        throw new AgentMuxError('Original input stop outcome is invalid.', 'INVALID_AGENT_INPUT_CONTROL')
      }
      this.db.prepare('INSERT INTO input_stops VALUES (?, ?, ?, ?)').run(agentInputJournalKey(ref.key), ref.waitGeneration, receipt.cancelOperationId, record.sequence)
      return
    }
    const next = record.control, prior = current.control
    finiteTimestamp(next.at, 'Input control time')
    if (ref.waitGeneration === prior.ref.waitGeneration + 1) {
      if (prior.state !== 'stopped-before-dispatch' || next.state !== 'enabled' || next.gateId !== undefined) throw new AgentMuxError(
        'An unresolved original dispatch cannot enter another waiting generation.', 'AGENT_INPUT_WAIT_GENERATION_STALE')
    } else if (ref.waitGeneration !== prior.ref.waitGeneration || prior.state !== 'enabled' ||
        !['enabled', 'stopped-before-dispatch', 'dispatch-authorized'].includes(next.state)) {
      throw new AgentMuxError('Original input control generation or state changed.', 'AGENT_INPUT_WAIT_GENERATION_STALE')
    }
    if (next.state === 'dispatch-authorized') validateAgentInputControlId(next.gateId)
    else if (next.gateId !== undefined) throw new AgentMuxError('Unclaimed input cannot invent a dispatch gate.', 'INVALID_AGENT_INPUT_CONTROL')
    this.db.prepare('UPDATE input_intents SET control_sequence=? WHERE input_id=?').run(record.sequence, agentInputJournalKey(ref.key))
  }

  /** The original journal preserves SDK content and its platform note separately. */
  async savePromptInput(intent: AgentInputJournalIntent, originalClaimAbsent?: () => Promise<boolean>): Promise<AgentInputJournalEntry | null> {
    return this.withLock(async () => {
      const key = validateAgentPromptInputKey(intent.key), existing = this.input(key)
      if (existing) {
        if (!isDeepStrictEqual(existing.intent.source, intent.source) || !isDeepStrictEqual(existing.intent.admissionIntent, intent.admissionIntent) || existing.intent.execution !== intent.execution) throw new AgentMuxError('Input identity already names another original content, author or target intent.', 'AGENT_PROMPT_OPERATION_CONFLICT')
        return existing
      }
      if (this.db.prepare('SELECT 1 FROM input_intents WHERE input_id=?').get(agentInputJournalKey(key))) return null
      if (intent.source.kind !== 'prompt') throw new AgentMuxError('Prompt journal requires its original prompt producer.', 'INVALID_AGENT_INPUT_CONTROL')
      if (originalClaimAbsent && !await originalClaimAbsent()) return null
      await this.appendRecord({ kind: 'input-intent', sequence: this.nextSequence, intent: structuredClone(intent), at: Date.now() })
      return this.input(key)!
    }, true)
  }

  /** Called only for a newly accepted original claim. Reopening old claims never backfills rows. */
  async recordInputSubmission(keyValue: AgentPromptInputKey, at: number): Promise<void> {
    const key = validateAgentPromptInputKey(keyValue)
    await this.withLock(async () => {
      const existing = this.db.prepare('SELECT original.json AS json FROM input_intents i JOIN records original ON original.sequence=i.intent_sequence WHERE input_id=?').get(agentInputJournalKey(key))
      if (existing) {
        const original = JSON.parse(String(existing.json)) as Extract<AgentInputWaitJournalRecord, { kind: 'input-intent' | 'input-submission' }>
        if (!isDeepStrictEqual(original.kind === 'input-intent' ? original.intent.key : original.key, key)) throw new AgentMuxError('Another producer owns this original input identity.', 'AGENT_PROMPT_OPERATION_CONFLICT')
        return
      }
      await this.appendRecord({ kind: 'input-submission', sequence: this.nextSequence, key, at })
    }, true)
  }

  /** Membership/order are frozen by the cursor; control and admission remain their original owners. */
  async readInputMailbox(value: AgentInputMailboxRead): Promise<{ items: InputMailboxJournalItem[]; cut: { incarnation: string; throughSequence: number }; offset: number; digest?: string; continuation(index: number, offset?: number, digest?: string): string | null }> {
    const input = parseAgentInputMailboxRead(value)
    return this.withLock(async () => {
      const incarnation = String(this.db.prepare('SELECT incarnation FROM metadata').get()!.incarnation)
      let through = Number(this.db.prepare('SELECT COALESCE(MAX(intent_sequence),0) AS n FROM input_intents WHERE recipient_id=?').get(input.agentSessionId)!.n)
      let before = through + 1, offset = 0
      let digest: string | undefined
      if (input.cursor) {
        try {
          const [body, signature, extra] = input.cursor.split('.')
          if (!body || !signature || extra) throw Error()
          const expected = createHmac('sha256', inputMailboxCursorKey).update(body).digest(), actual = Buffer.from(signature, 'base64url')
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error()
          const cut = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as InputMailboxCursor
          if (cut.queueId !== this.queueId || cut.incarnation !== incarnation || cut.agentSessionId !== input.agentSessionId ||
              !Number.isSafeInteger(cut.through) || cut.through < 0 || cut.through > through ||
              !Number.isSafeInteger(cut.before) || cut.before < 1 || cut.before > cut.through + 1) throw Error()
          if (cut.offset !== undefined && (!Number.isSafeInteger(cut.offset) || cut.offset < 1 || typeof cut.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(cut.digest)) || cut.offset === undefined && cut.digest !== undefined) throw Error()
          through = cut.through; before = cut.before; offset = cut.offset ?? 0; digest = cut.digest
        } catch { throw new AgentMuxError('The input mailbox cursor does not belong to this original journal and recipient.', 'INVALID_AGENT_INPUT_CURSOR') }
      }
      const limit = input.limit ?? 25
      const rows = this.db.prepare(`SELECT original.json AS original FROM input_intents i
        JOIN records original ON original.sequence=i.intent_sequence
        WHERE i.recipient_id=? AND i.intent_sequence<=? AND i.intent_sequence<?
        ORDER BY i.intent_sequence DESC LIMIT ?`).all(input.agentSessionId, through, before, limit + 1)
      const items: InputMailboxJournalItem[] = rows.slice(0, limit).map(row => {
        const original = JSON.parse(String(row.original)) as Extract<AgentInputWaitJournalRecord, { kind: 'input-intent' | 'input-submission' }>
        if (original.kind === 'input-submission') return { kind: 'submission', sequence: original.sequence, recordedAt: original.at, key: original.key }
        const saved = this.input(original.intent.key)!
        const message = saved.intent.source.kind === 'message' ? this.message(saved.intent.source.messageId)! : undefined
        return { kind: 'controlled', sequence: saved.sequence, recordedAt: original.at, intent: saved.intent, control: saved.control, ...(message ? { message: message.envelope, ...(message.sourceChannel ? { sourceChannel: message.sourceChannel } : {}), ...(message.sourceDevice ? { sourceDevice: message.sourceDevice } : {}) } : {}) }
      })
      const continuation = (index: number, offset = 0, digest?: string): string | null => {
        if (index >= items.length && rows.length <= limit) return null
        const before = index < items.length ? items[index]!.sequence + 1 : items.at(-1)!.sequence
        const cut: InputMailboxCursor = { queueId: this.queueId, incarnation, agentSessionId: input.agentSessionId, through, before,
          ...(offset ? { offset, digest: digest! } : {}) }
        const body = Buffer.from(JSON.stringify(cut)).toString('base64url')
        return body + '.' + createHmac('sha256', inputMailboxCursorKey).update(body).digest('base64url')
      }
      return { items, cut: { incarnation, throughSequence: through }, offset, ...(digest ? { digest } : {}), continuation }
    })
  }

  /** Only the original metadata claim runs here; no Provider or Native awaits. */
  async withUncontrolledInputClaim<T>(key: import('./agent-prompt-condition.js').AgentPromptInputKey, claim: () => Promise<T>, originalClaim?: () => Promise<boolean>): Promise<T> {
    return await this.withLock(async () => {
      if (this.input(key)) throw new AgentMuxError('The original controlled input requires its journal gate and intent.', 'AGENT_PROMPT_OPERATION_CONFLICT')
      if (this.db.prepare('SELECT 1 FROM input_intents WHERE input_id=?').get(agentInputJournalKey(key)) && (!originalClaim || !await originalClaim())) throw new AgentMuxError('This accepted original input has no available admission to rejoin. Its recorded identity is retained.', 'AGENT_INPUT_READ_UNCONFIRMED')
      return await claim()
    }, true)
  }

  async inspectInput(selector: AgentInputSelector): Promise<AgentInputJournalEntry | null> {
    return this.withLock(async () => {
      if ('key' in selector) return this.input(validateAgentPromptInputKey(selector.key)) ?? null
      const messageId = this.operationMessageId(validateAgentInputControlId(selector.originalControlOperationId))
      if (!messageId) return null
      const message = this.message(messageId)!
      if (!message.envelope.recipientSessionId || !message.envelope.recipientRunId) return null
      return this.input({ kind: 'message', agentSessionId: message.envelope.recipientSessionId,
        expectedRun: { runId: message.envelope.recipientRunId }, messageId }) ?? null
    }, true)
  }

  async recordInputWaiting(refValue: AgentInputWaitRef, waiting: AgentInputWaitReason): Promise<boolean> {
    const ref = validateAgentInputWaitRef(refValue)
    return await this.withLock(async () => {
      const current = this.input(ref.key)
      if (!current || !isDeepStrictEqual(current.control.ref, ref) || current.control.state !== 'enabled') return false
      if (isDeepStrictEqual(current.control.waiting, waiting)) return true
      await this.appendRecord({ kind: 'input-control', sequence: this.nextSequence, control: { ref, state: 'enabled', at: Date.now(), waiting } })
      return true
    }, true)
  }

  /** Stop and this short gate share one original journal transaction; no Native await. */
  async authorizeInputDispatch(refValue: AgentInputWaitRef, signal?: AbortSignal): Promise<AgentInputDispatchLink | null> {
    const ref = validateAgentInputWaitRef(refValue)
    return this.withLock(async () => {
      signal?.throwIfAborted()
      const current = this.input(ref.key)
      if (!current || !isDeepStrictEqual(current.control.ref, ref) || current.control.state !== 'enabled') return null
      const gateId = mintObjectId()
      await this.appendRecord({ kind: 'input-control', sequence: this.nextSequence,
        control: { ref, state: 'dispatch-authorized', gateId, at: Date.now() } })
      return { ref, gateId }
    }, true)
  }

  async stopInputWaiting(refValue: AgentInputWaitRef, cancelOperationId: string, settled: boolean, originalClaimExists = false): Promise<AgentInputWaitStopReceipt> {
    const ref = validateAgentInputWaitRef(refValue), operationId = validateAgentInputControlId(cancelOperationId)
    return this.withLock(async () => {
      const prior = this.db.prepare('SELECT r.json FROM input_stops s JOIN records r ON r.sequence=s.sequence WHERE s.input_id=? AND s.generation=? AND s.cancel_operation_id=?')
        .get(agentInputJournalKey(ref.key), ref.waitGeneration, operationId)
      if (prior) return structuredClone((JSON.parse(String(prior.json)) as Extract<AgentInputWaitJournalRecord, { kind: 'input-stop' }>).receipt)
      const current = this.input(ref.key)
      if (!current) throw new AgentMuxError('The original input has no controlled waiting contract.', 'AGENT_INPUT_NOT_FOUND')
      const at = Date.now()
      const outcome = !isDeepStrictEqual(current.control.ref, ref) ? 'stale-generation' : settled ? 'already-settled'
        : current.control.state === 'dispatch-authorized' || originalClaimExists ? 'observation-stopped' : 'stopped-before-dispatch'
      if (outcome === 'stopped-before-dispatch' && current.control.state === 'enabled') await this.appendRecord({ kind: 'input-control', sequence: this.nextSequence,
        control: { ref, state: 'stopped-before-dispatch', at } })
      const receipt: AgentInputWaitStopReceipt = { ref, cancelOperationId: operationId, outcome, at }
      await this.appendRecord({ kind: 'input-stop', sequence: this.nextSequence, receipt })
      return structuredClone(receipt)
    }, true)
  }

  async reenableInputWaiting(refValue: AgentInputWaitRef): Promise<AgentInputWaitRef> {
    const ref = validateAgentInputWaitRef(refValue)
    return this.withLock(async () => {
      const current = this.input(ref.key)
      if (!current || !isDeepStrictEqual(current.control.ref, ref)) throw new AgentMuxError('The original waiting generation changed.', 'AGENT_INPUT_WAIT_GENERATION_STALE')
      if (current.control.state === 'dispatch-authorized') throw new AgentMuxError('The original dispatch is unresolved or settled; it cannot be enabled again.', 'AGENT_PROMPT_INPUT_UNCONFIRMED')
      if (current.control.state === 'enabled') return current.control.ref
      const next = { key: ref.key, waitGeneration: ref.waitGeneration + 1 }
      await this.appendRecord({ kind: 'input-control', sequence: this.nextSequence, control: { ref: next, state: 'enabled', at: Date.now() } })
      return next
    }, true)
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
    if (record.kind === 'input-intent' || record.kind === 'input-submission' || record.kind === 'input-control' || record.kind === 'input-stop') {
      this.applyInputRecord(record)
      this.db.prepare('INSERT INTO records VALUES (?, ?)').run(record.sequence, JSON.stringify(record))
      return
    }
    if (record.kind === 'message-route') {
      const route = validateAgentMessageRoute(record.route)
      this.db.prepare('INSERT INTO message_routes VALUES (?, ?, ?)').run(route.messageId, route.operationId, record.sequence)
    } else if (record.kind === 'message') {
      if (record.execution !== undefined && record.execution !== 'default' && record.execution !== 'immediate') throw new AgentMuxError('Message execution is invalid.', 'MESSAGE_QUEUE_UNAVAILABLE')
      const envelope = validateAgentMuxMessageEnvelope(record.envelope)
      if (record.admissionIntent !== undefined) {
        const intent = validateAgentPromptAdmissionIntent(record.admissionIntent)
        if (intent.kind === 'exact-condition' || record.execution !== 'immediate' || envelope.recipientRunId !== intent.expectedRun.runId) throw new AgentMuxError('Message manual intent changed its original Run or execution.', 'MESSAGE_QUEUE_UNAVAILABLE')
      }
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

  async append(input: AgentMuxMessageAppendInput, newMessage?: { admissionIntent?: AgentPromptAdmissionIntent; inputEnvironment?: AgentInputJournalIntent['environment']; originalClaimAbsent?: () => Promise<boolean> }): Promise<AgentMuxMessageReceipt> {
    return this.withLock(async () => {
      const messageId = input.messageId ?? mintObjectId()
      if (input.execution !== undefined && input.execution !== 'default' && input.execution !== 'immediate') throw new AgentMuxError('Message execution is invalid.', 'INVALID_CONTROL_REQUEST')
      const execution = input.execution ?? 'default'
      const admissionIntent = input.admissionIntent === undefined ? undefined : validateAgentPromptAdmissionIntent(input.admissionIntent)
      const sourceChannel = input.sourceChannel === undefined ? undefined : normalizeMessageChannel(input.sourceChannel)
      const sourceDevice = input.sourceDevice === undefined ? undefined : normalizeOperationDevice(input.sourceDevice)
      const sameOrigin = (existing: DurableAgentMuxMessage) => existing.sourceChannel === sourceChannel &&
        JSON.stringify(existing.sourceDevice) === JSON.stringify(sourceDevice) &&
        (newMessage !== undefined && input.admissionIntent === undefined || JSON.stringify(existing.admissionIntent) === JSON.stringify(admissionIntent))
      const envelope = validateAgentMuxMessageEnvelope({ ...input, schema: 'agentmux.a2a.v1', messageId })
      const route = this.messageRoute(envelope.operationId, messageId)
      if (route && (route.hostId !== 'local' || route.agentSessionId !== envelope.recipientSessionId)) throw new AgentMuxError(
        'The original message belongs to another retained route. No local replacement was appended.', 'MESSAGE_RECIPIENT_MISMATCH')
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
      // The direct producer may select intent for a new record only. A retry
      // returns an old record above; it never manufactures a manual tag for it.
      const frozenIntent = admissionIntent ?? (newMessage?.admissionIntent === undefined ? undefined : validateAgentPromptAdmissionIntent(newMessage.admissionIntent))
      const record: JournalMessage = { kind: 'message', sequence: this.nextSequence, envelope, promptCondition: null, execution,
        ...(frozenIntent === undefined ? {} : { admissionIntent: frozenIntent }),
        ...(sourceChannel === undefined ? {} : { sourceChannel }), ...(sourceDevice === undefined ? {} : { sourceDevice }) }
      await this.appendRecord(record)
      if (newMessage?.inputEnvironment !== undefined && (!newMessage.originalClaimAbsent || await newMessage.originalClaimAbsent())) {
        if (!frozenIntent || frozenIntent.kind === 'exact-condition' || execution !== 'immediate' || !envelope.recipientSessionId || !envelope.recipientRunId) {
          throw new AgentMuxError('Controlled message requires its explicit original direct intent.', 'INVALID_AGENT_INPUT_CONTROL')
        }
        const key = { kind: 'message' as const, agentSessionId: envelope.recipientSessionId, expectedRun: { runId: envelope.recipientRunId }, messageId }
        this.input(key) // Also verifies producer ownership for a read-only original submission.
        if (!this.db.prepare('SELECT 1 FROM input_intents WHERE input_id=?').get(agentInputJournalKey(key))) await this.appendRecord({ kind: 'input-intent', sequence: this.nextSequence, at: envelope.createdAt,
          intent: { key, admissionIntent: frozenIntent, execution: 'immediate', environment: structuredClone(newMessage.inputEnvironment),
            source: { kind: 'message', messageId, originalControlOperationId: envelope.operationId } } })
      }
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

  /** Indexed ingress facts never replay or load unrelated messages. */
  private messageRoute(operationId: string, messageId?: string): AgentMessageRoute | null {
    const select = `SELECT r.json FROM message_routes m JOIN records r ON r.sequence=m.sequence WHERE `
    const byOperation = this.db.prepare(select + 'm.operation_id=?').get(operationId)
    const byMessage = messageId === undefined ? undefined : this.db.prepare(select + 'm.message_id=?').get(messageId)
    const parse = (row: Record<string, unknown> | undefined) => row ?
      (JSON.parse(String(row.json)) as Extract<JournalRecord, { kind: 'message-route' }>).route : null
    const original = parse(byOperation), selected = parse(byMessage)
    if (original && messageId !== undefined && original.messageId !== messageId ||
        original && selected && original.messageId !== selected.messageId) throw new AgentMuxError(
      'Message operation and message ID name different original routes.', 'MESSAGE_ID_CONFLICT')
    return original ?? selected
  }

  async readMessageRoute(operationId: string, messageId?: string): Promise<AgentMessageRoute | null> {
    // A retry may follow a committed route whose first fsync ACK was lost. Confirm
    // that same journal before allowing its binding to precede a remote effect.
    return this.withLock(async () => this.messageRoute(nonEmpty(operationId, 'Message operation'), messageId), true)
  }

  /** Atomic first binding and durability ACK precede any remote input or receipt lookup. */
  async claimMessageRoute(input: AgentMessageRoute): Promise<AgentMessageRoute> {
    const candidate = validateAgentMessageRoute(input)
    return this.withLock(async () => {
      const original = this.messageRoute(candidate.operationId, candidate.messageId)
      if (original) { assertAgentMessageRouteIntent(original, candidate); return original }
      if (this.operationMessageId(candidate.operationId) || this.message(candidate.messageId)) throw new AgentMuxError(
        'This message already belongs to the local journal. It cannot acquire a different route.', 'MESSAGE_ID_CONFLICT')
      await this.appendRecord({ kind: 'message-route', sequence: this.nextSequence, route: candidate })
      return candidate
    }, true)
  }

  /** Read the first original operation binding without replaying unrelated communication. */
  async readByOperationId(operationId: string,
    reauthorize?: (message: DurableAgentMuxMessage | null) => Promise<void>): Promise<DurableAgentMuxMessage | null> {
    return this.withLock(async () => {
      const messageId = this.operationMessageId(nonEmpty(operationId, 'Message operation id'))
      const message = messageId ? this.message(messageId)! : null
      await reauthorize?.(message)
      return message
    })
  }

  /** Exact immutable message identity lookup; never discovers unrelated messages. */
  async readByMessageId(messageId: string,
    reauthorize?: (message: DurableAgentMuxMessage | null) => Promise<void>): Promise<DurableAgentMuxMessage | null> {
    return this.withLock(async () => {
      const message = this.message(nonEmpty(messageId, 'Message id')) ?? null
      await reauthorize?.(message)
      return message
    })
  }

  /** Browse the original journal without constructing bodies, delivery batches or consumer cursors. */
  async listMessages(input: AgentMuxMessageQuery, reauthorize: () => Promise<void>): Promise<AgentMuxMessagePage> {
    const participantSessionId = nonEmpty(input.participantSessionId, 'Message participant Session id')
    if (input.direction !== 'incoming' && input.direction !== 'outgoing') throw new AgentMuxError(
      'Message direction must be incoming or outgoing.', 'INVALID_CONTROL_REQUEST')
    const limit = input.limit ?? 50, before = input.beforeSequence ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1) throw new AgentMuxError(
      'Message page requires limit 1–100 and a positive original sequence cursor.', 'MESSAGE_BATCH_LIMIT_INVALID')
    return this.withLock(async () => {
      await reauthorize()
      // Reuse the journal's participant expression indexes. Index initialization is local to
      // discovery: it is never an input/readiness gate and creates no second message store.
      this.db.exec(dispatchDiscoveryJournalSchema)
      const side = input.direction === 'incoming' ? 'recipient' : 'sender'
      const rows = this.db.prepare(`SELECT original.sequence,
        json_remove(original.json, '$.envelope.body') AS metadata,
        substr(json_extract(original.json, '$.envelope.body'), 1, 240) AS preview,
        length(CAST(json_extract(original.json, '$.envelope.body') AS BLOB)) AS body_bytes,
        latest.json AS delivery
        FROM records original INDEXED BY message_${side}
        JOIN messages m ON m.message_sequence=original.sequence
        LEFT JOIN records latest ON latest.sequence=m.delivery_sequence
        WHERE json_extract(original.json, '$.kind') = 'message'
          AND json_extract(original.json, '$.envelope.${side}SessionId') = ?
          AND json_extract(original.json, '$.envelope.sender.kind') = 'agent-session'
          AND json_extract(original.json, '$.envelope.recipient.kind') = 'agent-session'
          AND original.sequence < ? ORDER BY original.sequence DESC LIMIT ?`).all(participantSessionId, before, limit + 1)
      const messages = rows.slice(0, limit).map(row => {
        const original = JSON.parse(String(row.metadata)) as { envelope: Omit<AgentMuxMessageEnvelope, 'body'> }
        const { body: _body, ...envelope } = validateAgentMuxMessageEnvelope({ ...original.envelope, body: '' })
        const last = row.delivery === null ? null : JSON.parse(String(row.delivery)) as Extract<JournalRecord, { kind: 'delivery' | 'delivery-issue' }>
        const delivery: AgentMuxMessageDeliveryState = last?.kind === 'delivery'
          ? { state: last.state, at: last.at, ...(last.reason === undefined ? {} : { reason: last.reason }) }
          : { state: 'queued', at: envelope.createdAt, ...(last ? { reason: last.reason } : {}) }
        return { sequence: Number(row.sequence), envelope, delivery,
          bodyPreview: String(row.preview).slice(0, 240), bodyBytes: Number(row.body_bytes) } satisfies AgentMuxMessageMetadata
      })
      return { participantSessionId, direction: input.direction, messages,
        nextBeforeSequence: rows.length > limit ? messages.at(-1)!.sequence : null }
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

  private dispatchReplies(dispatch: Dispatch): readonly DurableAgentMuxMessage[] {
    // Only explicit reads initialize this index. Ordinary input/open/report must
    // not acquire a new discovery prerequisite to keep a healthy Agent usable.
    this.db.exec(dispatchReplyJournalSchema)
    const select = this.db.prepare(`SELECT sequence, json FROM records INDEXED BY message_reply_chain
      WHERE json_extract(json, '$.kind') = 'message'
        AND json_extract(json, '$.envelope.replyTo') = ?
        AND json_extract(json, '$.envelope.threadId') = ?
        AND json_extract(json, '$.envelope.senderSessionId') = ?
        AND json_extract(json, '$.envelope.recipientSessionId') = ?
        AND json_extract(json, '$.envelope.sender.kind') = 'agent-session'
        AND json_extract(json, '$.envelope.recipient.kind') = 'agent-session'`)
    const pending = [dispatch.sourceMessageId], seen = new Set(pending)
    const replies: DurableAgentMuxMessage[] = []
    for (let index = 0; index < pending.length; index++) {
      for (const [sender, recipient] of [[dispatch.ownerAgentSessionId, dispatch.workerAgentSessionId],
        [dispatch.workerAgentSessionId, dispatch.ownerAgentSessionId]]) {
        for (const row of select.all(pending[index]!, dispatch.threadId, sender!, recipient!)) {
          const original = JSON.parse(String(row.json)) as JournalMessage
          const id = original.envelope.messageId
          if (seen.has(id)) continue
          // Admission facts can supply an originally unresolved recipient Run;
          // the returned immutable envelope itself is never rewritten.
          this.dispatchMessage(id)
          const reply = this.message(id)!
          seen.add(id); pending.push(id); replies.push(reply)
        }
      }
    }
    return replies.sort((left, right) => left.sequence - right.sequence)
  }

  /** No cursor or consumption mutation. Only the original participants may use Agent authority. */
  async readDispatch(
    input: { readonly sourceMessageId: string; readonly callerAgentSessionId?: string },
    reauthorize: (messages: readonly AgentMuxMessageEnvelope[]) => Promise<readonly DispatchIdentityDiagnostic[]>
  ): Promise<DispatchObservation> {
    return this.withLock(async () => {
      const { dispatch, messages } = this.dispatchProjection(input.sourceMessageId)
      if (input.callerAgentSessionId !== undefined && input.callerAgentSessionId !== dispatch.ownerAgentSessionId &&
        input.callerAgentSessionId !== dispatch.workerAgentSessionId) throw new AgentMuxError(
        'Only a Dispatch participant can read it with Agent authority.', 'DISPATCH_PARTICIPANT_MISMATCH')
      // Authorize the caller before building a read projection, then include each
      // original Run in diagnostics even when its reply has no dispatch event.
      await reauthorize(messages)
      const replies = this.dispatchReplies(dispatch)
      const identityDiagnostics = await reauthorize([messages[0]!, ...replies.map(reply => this.dispatchMessage(reply.envelope.messageId))])
      return structuredClone({ dispatch, source: this.message(dispatch.sourceMessageId)!, replies, identityDiagnostics })
    })
  }

  async listDispatches(
    input: { readonly participantSessionId: string; readonly afterSourceMessageId?: string; readonly limit?: number },
    reauthorize: () => Promise<void>
  ): Promise<DispatchPage> {
    const participantSessionId = nonEmpty(input.participantSessionId, 'Dispatch participant Session id')
    const limit = input.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AgentMuxError(
      'Dispatch page limit must be an integer from 1 to 100.', 'MESSAGE_BATCH_LIMIT_INVALID')
    return this.withLock(async () => {
      await reauthorize()
      // Only this discovery operation creates its related projection. Failure to
      // initialize a discovery index cannot become an admission gate for input.
      this.db.exec(dispatchDiscoveryJournalSchema)
      let after = 0
      if (input.afterSourceMessageId !== undefined) {
        const cursor = this.dispatchProjection(input.afterSourceMessageId).dispatch
        if (cursor.ownerAgentSessionId !== participantSessionId && cursor.workerAgentSessionId !== participantSessionId) throw new AgentMuxError(
          'The original page cursor belongs to another participant.', 'DISPATCH_PARTICIPANT_MISMATCH')
        after = Number(this.db.prepare('SELECT open_sequence FROM dispatches WHERE source_message_id=?').get(cursor.sourceMessageId)!.open_sequence)
      }
      // Each side starts from its own expression index, rather than scanning every dispatch
      // or discovering unrelated Sessions. UNION also removes self-directed duplicates.
      const sources = this.db.prepare(`SELECT d.source_message_id, d.open_sequence FROM (
        SELECT sequence FROM records INDEXED BY message_sender
          WHERE json_extract(json, '$.kind') = 'message' AND json_extract(json, '$.envelope.senderSessionId') = ?
        UNION
        SELECT sequence FROM records INDEXED BY message_recipient
          WHERE json_extract(json, '$.kind') = 'message' AND json_extract(json, '$.envelope.recipientSessionId') = ?
      ) original JOIN messages m ON m.message_sequence=original.sequence
        JOIN dispatches d ON d.source_message_id=m.message_id
        WHERE d.open_sequence > ? ORDER BY d.open_sequence LIMIT ?`).all(participantSessionId, participantSessionId, after, limit + 1)
      const page = sources.slice(0, limit).map(row => this.dispatchProjection(String(row.source_message_id)).dispatch)
      return structuredClone({ participantSessionId, dispatches: page,
        nextSourceMessageId: sources.length > limit ? page.at(-1)!.sourceMessageId : null })
    })
  }

  private receipt(message: DurableAgentMuxMessage): AgentMuxMessageReceipt {
    const key = message.envelope.recipientSessionId && message.envelope.recipientRunId
      ? { kind: 'message' as const, agentSessionId: message.envelope.recipientSessionId,
        expectedRun: { runId: message.envelope.recipientRunId }, messageId: message.envelope.messageId } : undefined
    const input = key ? this.input(key) : undefined
    return {
      queueId: this.queueId,
      receiptId: `${this.queueId}:${message.sequence}:${message.envelope.messageId}`,
      messageId: message.envelope.messageId,
      sequence: message.sequence,
      envelope: structuredClone(message.envelope),
      delivery: { ...message.delivery },
      ...(message.promptCondition === undefined ? {} : { promptCondition: structuredClone(message.promptCondition) }),
      ...(message.admissionIntent === undefined ? {} : { admissionIntent: structuredClone(message.admissionIntent) }),
      ...(message.sourceChannel === undefined ? {} : { sourceChannel: message.sourceChannel }),
      ...(message.sourceDevice === undefined ? {} : { sourceDevice: { ...message.sourceDevice } }),
      ...(input ? { input } : {})
    }
  }
}

export async function appendGlobalMessage(input: AgentMuxMessageAppendInput, path = defaultAgentMuxMessageQueuePath(), newMessage?: { admissionIntent?: AgentPromptAdmissionIntent; inputEnvironment?: AgentInputJournalIntent['environment'] }): Promise<AgentMuxMessageReceipt> {
  return await new DurableAgentMuxMessageQueue(path).append(input, newMessage)
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

/** The selected Host route encloses the original queue/cut; it never relabels an input key or inner cursor. */
export async function readRoutedInputMailbox(
  value: import('./agent-input-mailbox.js').AgentInputMailboxRead & { hostId: string },
  read: (input: import('./agent-input-mailbox.js').AgentInputMailboxRead) => Promise<import('./agent-input-mailbox.js').AgentInputMailboxPage>
): Promise<import('./agent-input-mailbox.js').AgentInputMailboxPage & { hostId: string }> {
  const { hostId, ...request } = value
  const input = parseAgentInputMailboxRead(request)
  if (typeof hostId !== 'string' || !hostId || hostId.length > 4096 || /[\0\r\n]/u.test(hostId)) throw new AgentMuxError('The original mailbox route is invalid.', 'INVALID_AGENT_INPUT_READ')
  type Route = { version: 1; hostId: string; agentSessionId: string; queueId: string; cut: { incarnation: string; throughSequence: number }; cursor: string }
  const encode = (route: Route) => {
    const body = Buffer.from(JSON.stringify(route)).toString('base64url')
    return body + '.' + createHmac('sha256', inputMailboxCursorKey).update('input-mailbox-route\0').update(body).digest('base64url')
  }
  let original: Route | undefined
  if (input.cursor) {
    try {
      const [body, signature, extra] = input.cursor.split('.')
      if (!body || !signature || extra) throw Error()
      const expected = createHmac('sha256', inputMailboxCursorKey).update('input-mailbox-route\0').update(body).digest(), actual = Buffer.from(signature, 'base64url')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error()
      original = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Route
      if (original.version !== 1 || original.hostId !== hostId || original.agentSessionId !== input.agentSessionId || typeof original.cursor !== 'string' || !original.cursor) throw Error()
    } catch { throw new AgentMuxError('The mailbox continuation does not belong to this exact Host route and recipient.', 'INVALID_AGENT_INPUT_CURSOR') }
  }
  const { parseAgentInputMailboxPage } = await import('./agent-input-mailbox-codec.js')
  const budget = input.maxBytes ?? 64 * 1024
  let sourceBudget = budget
  for (let attempt = 0; attempt < 4; attempt++) {
    const sourceInput = { ...input, ...(original ? { cursor: original.cursor } : {}), maxBytes: sourceBudget }
    const page = parseAgentInputMailboxPage(await read(sourceInput), sourceInput)
    if (original && (page.queueId !== original.queueId || !isDeepStrictEqual(page.cut, original.cut))) throw new AgentMuxError('The mailbox response belongs to another original journal or accepted cut.', 'CONTROL_PROTOCOL_ERROR')
    const nextCursor = page.nextCursor === null ? null : encode({ version: 1, hostId, agentSessionId: input.agentSessionId, queueId: page.queueId, cut: page.cut, cursor: page.nextCursor })
    const result = { ...page, hostId, budgetBytes: budget, nextCursor }, overflow = Buffer.byteLength(JSON.stringify(result)) - budget
    if (overflow <= 0) return result
    sourceBudget -= overflow + 128
    if (sourceBudget < 4096) break
  }
  throw new AgentMuxError('The original route envelope cannot fit this mailbox read. Increase maxBytes; no input was changed.', 'AGENT_INPUT_READ_BUDGET')
}
