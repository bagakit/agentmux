import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from './errors.js'
import { assertDispatchEventKind, assertDispatchMessage, openDispatch, recordDispatchEvent, type Dispatch, type DispatchEvent, type DispatchEventKind } from './agent-handoff.js'
import { validateAgentPromptCondition, type AgentPromptCondition } from './agent-prompt-condition.js'
import { ackDeliveryBatch, checkDeliveries, type ConsumerCursor, type DeliveryQueue } from './agent-delivery-queue.js'
import { advanceDelivery, type AgentDeliveryState } from './agent-message.js'
import type { AgentMuxMessageTarget } from './control.js'
import { defaultAgentMuxMessageQueuePath } from './runtime-paths.js'
import type { AgentMuxRunRef } from './types.js'

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
}

export type AgentMuxMessageAppendInput = Omit<AgentMuxMessageEnvelope, 'schema' | 'messageId'> & {
  readonly messageId?: string
}

/** Readable recipient-side wrapper; envelope facts have already been validated by Core.
 *
 * Re-exported from `./agent-message-render.js` to preserve the original public API — the
 * pure-string implementation moved to a renderer-safe module so `apps/desktop/src/renderer`
 * can consume it without dragging node:* into the vite/rollup bundle graph. Details:
 * memory renderer-value-import-of-core-barrel-breaks-packaging.
 */
export { renderAgentMuxMessageEnvelope } from './agent-message-render.js'

export type AgentMuxMessageQueueOptions = {
  readonly maxMessages?: number
  readonly maxBytes?: number
}

const processQueueTails = new Map<string, Promise<void>>()

export type AgentMuxMessageJournalRecord =
  | { readonly kind: 'message'; readonly sequence: number; readonly envelope: AgentMuxMessageEnvelope; readonly promptCondition?: null }
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

const DEFAULT_MAX_MESSAGES = 2_048
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024

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

function addressedTo(message: DurableAgentMuxMessage, consumerId: string): boolean {
  return message.envelope.recipient.kind === 'agent-session' &&
    message.envelope.recipient.agentSessionId === consumerId &&
    message.envelope.recipientSessionId === consumerId
}

function deliveryQueue(
  messages: ReadonlyMap<string, DurableAgentMuxMessage>,
  consumers: ReadonlyMap<string, DurableConsumerCursor>,
  consumerId: string
): DeliveryQueue {
  return {
    // Delivery is mutable; filtering on it would make an acknowledged numeric position skip mail.
    pending: [...messages.values()].filter((item) => addressedTo(item, consumerId))
      .sort((left, right) => left.sequence - right.sequence).map((item) => item.envelope.messageId),
    consumers: Object.fromEntries([...consumers].map(([id, cursor]) => [id, {
      acked: cursor.acked, generation: cursor.generation, inFlight: cursor.deliveryIds.length
    }]))
  }
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
  private loaded = false
  private bytes = 0
  private nextSequence = 1
  private readonly messages = new Map<string, DurableAgentMuxMessage>()
  private readonly operations = new Map<string, string>()
  private readonly consumers = new Map<string, DurableConsumerCursor>()
  private readonly dispatches = new Map<string, DispatchProjection>()
  private readonly journal: JournalRecord[] = []
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    readonly path = defaultAgentMuxMessageQueuePath(),
    private readonly options: AgentMuxMessageQueueOptions = {}
  ) {
    this.queueId = queueIdFor(path)
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = `${this.path}.mutex.sqlite`
    const processTail = processQueueTails.get(key) ?? Promise.resolve()
    const instanceTail = this.tail
    const result = processTail.then(() => instanceTail.then(() => this.withFileLock(operation), () => this.withFileLock(operation)), () => this.withFileLock(operation))
    this.tail = result.then(() => undefined, () => undefined)
    processQueueTails.set(key, result.then(() => undefined, () => undefined))
    return result
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    // SQLite's BEGIN IMMEDIATE is the cross-process writer mutex. The kernel releases it when a
    // process dies, including a crash during append, so there is no pathname to reclaim with a
    // check-then-unlink race. A legacy orphan .lock file is deliberately ignored.
    const mutexPath = `${this.path}.mutex.sqlite`
    let mutex: DatabaseSync
    try {
      // Loading the queue's validator or CLI help must not initialize SQLite or put an
      // experimental-module warning in the machine-readable error receipt stream.
      const { DatabaseSync } = await import('node:sqlite')
      mutex = new DatabaseSync(mutexPath)
      await chmod(mutexPath, 0o600)
      mutex.exec('PRAGMA busy_timeout = 10000')
    } catch {
      throw new AgentMuxError('Message queue store is unavailable.', 'MESSAGE_QUEUE_UNAVAILABLE')
    }
    let acquired = false
    try {
      try { mutex.exec('BEGIN IMMEDIATE'); acquired = true } catch (error) {
        if ((error as { code?: string }).code !== 'ERR_SQLITE_ERROR' || !String(error).includes('database is locked')) {
          throw new AgentMuxError('Message queue store is unavailable.', 'MESSAGE_QUEUE_UNAVAILABLE')
        }
      }
      if (!acquired) throw new AgentMuxError('Message queue writer is busy.', 'MESSAGE_QUEUE_BACKPRESSURE')
      this.loaded = false
      this.bytes = 0
      this.nextSequence = 1
      this.messages.clear()
      this.operations.clear()
      this.consumers.clear()
      this.dispatches.clear()
      this.journal.length = 0
      await this.ensureLoaded()
      const result = await operation()
      mutex.exec('COMMIT')
      acquired = false
      return result
    } finally {
      if (acquired) {
        try { mutex.exec('ROLLBACK') } catch { /* A crashed or closed transaction is already released. */ }
      }
      mutex.close()
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    let content = ''
    try { content = await readFile(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AgentMuxError('Message queue store is unavailable.', 'MESSAGE_QUEUE_UNAVAILABLE')
    }
    this.bytes = Buffer.byteLength(content)
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      let record: JournalRecord
      try { record = JSON.parse(line) as JournalRecord } catch { throw new AgentMuxError('Message queue journal is invalid.', 'MESSAGE_QUEUE_UNAVAILABLE') }
      this.journal.push(record)
      this.replay(record)
    }
    this.loaded = true
  }

  private replay(record: JournalRecord): void {
    this.nextSequence = Math.max(this.nextSequence, record.sequence + 1)
    if (record.kind === 'message') {
      const envelope = validateAgentMuxMessageEnvelope(record.envelope)
      const message = { sequence: record.sequence, envelope, delivery: Object.freeze({ state: 'queued' as const, at: envelope.createdAt }),
        ...(record.promptCondition === null ? { promptCondition: null } : {}) }
      this.messages.set(envelope.messageId, message)
      this.operations.set(envelope.operationId, envelope.messageId)
      return
    }
    if (record.kind === 'prompt-condition') {
      const current = this.messages.get(record.messageId)
      if (!current || current.promptCondition !== null) throw new AgentMuxError(
        'Message prompt condition is inconsistent.', 'MESSAGE_QUEUE_UNAVAILABLE')
      const condition = validateAgentPromptCondition(record.condition)
      if (current.envelope.recipientRunId !== null && current.envelope.recipientRunId !== condition.expectedRun.runId) {
        throw new AgentMuxError('Message prompt targets another Run.', 'MESSAGE_RECIPIENT_MISMATCH')
      }
      this.messages.set(record.messageId, { ...current, promptCondition: condition })
      return
    }
    if (record.kind === 'delivery-issue') {
      const current = this.messages.get(record.messageId)
      if (!current || current.delivery.state !== 'queued') throw new AgentMuxError(
        'Message delivery issue contradicts its confirmed receipt.', 'MESSAGE_QUEUE_UNAVAILABLE')
      this.messages.set(record.messageId, { ...current, delivery: { ...current.delivery, reason: record.reason } })
      return
    }
    if (record.kind === 'delivery') {
      const current = this.messages.get(record.messageId)
      if (!current) throw new AgentMuxError('Message queue delivery references an unknown message.', 'MESSAGE_QUEUE_UNAVAILABLE')
      const delivery = advanceDelivery(current.delivery, record.state, record.at)
      this.messages.set(record.messageId, { ...current, delivery: { ...delivery, ...(record.reason === undefined ? {} : { reason: record.reason }) } })
      return
    }
    if (record.kind === 'dispatch-open' || record.kind === 'dispatch-event') {
      const sourceMessageId = nonEmpty(record.sourceMessageId, 'Dispatch source message id')
      finiteTimestamp(record.at, 'Dispatch time')
      const previous = this.dispatches.get(sourceMessageId)
      // References may outlive retained message bodies. Replaying those facts must not break
      // unrelated mail; only a Dispatch read/report requires the actual referenced envelopes.
      if (record.kind === 'dispatch-open') {
        if (!previous) this.dispatches.set(sourceMessageId, { sourceMessageId, openedAt: record.at, events: [] })
      } else {
        if (!previous) throw new AgentMuxError('Dispatch event has no open fact.', 'MESSAGE_QUEUE_UNAVAILABLE')
        const replyMessageId = nonEmpty(record.replyMessageId, 'Dispatch reply message id')
        assertDispatchEventKind(record.eventKind)
        const existing = previous.events.find((event) => event.replyMessageId === replyMessageId)
        if (existing && existing.kind !== record.eventKind) {
          throw new AgentMuxError('Dispatch journal event identity conflicts.', 'MESSAGE_QUEUE_UNAVAILABLE')
        }
        if (!existing) this.dispatches.set(sourceMessageId, { ...previous,
          events: [...previous.events, { kind: record.eventKind, replyMessageId, at: record.at }] })
      }
      return
    }
    if (record.kind !== 'consumer-check' && record.kind !== 'consumer-ack') {
      throw new AgentMuxError('Message queue journal record is invalid.', 'MESSAGE_QUEUE_UNAVAILABLE')
    }
    const identity = reader(record)
    assertGeneration(record.generation)
    if (!Array.isArray(record.deliveryIds) || record.deliveryIds.some((id) => typeof id !== 'string') ||
      new Set(record.deliveryIds).size !== record.deliveryIds.length) {
      throw new AgentMuxError('Message consumer batch is invalid.', 'MESSAGE_QUEUE_UNAVAILABLE')
    }
    const previous = this.consumers.get(identity.consumerId)
    const arithmetic = deliveryQueue(this.messages, this.consumers, identity.consumerId)
    const exact = arithmetic.pending.slice(previous?.acked ?? 0, (previous?.acked ?? 0) + record.deliveryIds.length)
    if (!sameIds(record.deliveryIds, exact)) {
      throw new AgentMuxError('Message consumer batch is not in its recipient domain.', 'MESSAGE_QUEUE_UNAVAILABLE')
    }
    if (record.kind === 'consumer-check') {
      const replacement = previous !== undefined && previous.readerRun.runId !== identity.readerRun.runId
      const expectedGeneration = previous ? previous.generation + (replacement ? 1 : 0) : 1
      if (record.generation !== expectedGeneration ||
        (previous && previous.deliveryIds.length > 0 && !sameIds(previous.deliveryIds, record.deliveryIds))) {
        throw new AgentMuxError('Message consumer check is inconsistent.', 'MESSAGE_QUEUE_UNAVAILABLE')
      }
      this.consumers.set(identity.consumerId, { acked: previous?.acked ?? 0,
        generation: record.generation, readerRun: identity.readerRun, deliveryIds: [...record.deliveryIds] })
    } else {
      this.consumers.set(identity.consumerId, this.cursorAfterAck(record))
    }
  }

  private cursorAfterAck(record: JournalAck): DurableConsumerCursor {
    const current = this.consumers.get(record.consumerId)
    if (!current || current.readerRun.runId !== record.readerRun.runId ||
      !sameIds(current.deliveryIds, record.deliveryIds)) {
      throw new AgentMuxError('Message consumer reader is stale.', 'MESSAGE_ACK_GENERATION_STALE')
    }
    const next = ackDeliveryBatch(deliveryQueue(this.messages, this.consumers, record.consumerId),
      record.consumerId, record.generation).consumers[record.consumerId]!
    return { acked: next.acked, generation: next.generation,
      readerRun: { ...current.readerRun }, deliveryIds: [] }
  }

  private async appendRecord(record: JournalRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    if (this.bytes + Buffer.byteLength(line) > (this.options.maxBytes ?? DEFAULT_MAX_BYTES)) {
      throw new AgentMuxError('Message queue is full; durable append was refused.', 'MESSAGE_QUEUE_BACKPRESSURE')
    }
    const handle = await open(this.path, 'a', 0o600)
    try { await handle.write(line); await handle.sync() } finally { await handle.close() }
    this.bytes += Buffer.byteLength(line)
    this.journal.push(record)
    this.replay(record)
  }

  async append(input: AgentMuxMessageAppendInput): Promise<AgentMuxMessageReceipt> {
    return this.withLock(async () => {
      await this.ensureLoaded()
      const messageId = input.messageId ?? randomUUID()
      const envelope = validateAgentMuxMessageEnvelope({ ...input, schema: 'agentmux.a2a.v1', messageId })
      const existingId = this.operations.get(envelope.operationId)
      if (existingId) {
        const existing = this.messages.get(existingId)!
        if (!sameEnvelope(existing.envelope, envelope)) throw new AgentMuxError('Message operation already names another envelope.', 'MESSAGE_ID_CONFLICT')
        return this.receipt(existing)
      }
      const existing = this.messages.get(messageId)
      if (existing) {
        if (!sameEnvelope(existing.envelope, envelope)) throw new AgentMuxError('Message id already names another envelope.', 'MESSAGE_ID_CONFLICT')
        return this.receipt(existing)
      }
      const maxMessages = this.options.maxMessages ?? DEFAULT_MAX_MESSAGES
      const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES
      const record: JournalMessage = { kind: 'message', sequence: this.nextSequence, envelope, promptCondition: null }
      const encodedBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`)
      if (this.messages.size >= maxMessages || this.bytes + encodedBytes > maxBytes) throw new AgentMuxError('Message queue is full; durable append was refused.', 'MESSAGE_QUEUE_BACKPRESSURE')
      await this.appendRecord(record)
      return this.receipt(this.messages.get(messageId)!)
    })
  }

  async recordDelivery(messageId: string, state: Exclude<AgentDeliveryState, 'queued'>, at = Date.now(), reason?: string): Promise<AgentMuxMessageReceipt> {
    return this.withLock(async () => {
      await this.ensureLoaded()
      const current = this.messages.get(nonEmpty(messageId, 'Message id'))
      if (!current) throw new AgentMuxError('Message is unknown.', 'MESSAGE_NOT_FOUND')
      if (current.delivery.state === state) return this.receipt(current)
      advanceDelivery(current.delivery, state, at)
      const record: JournalDelivery = { kind: 'delivery', sequence: this.nextSequence, messageId, state, at, ...(reason === undefined ? {} : { reason }) }
      await this.appendRecord(record)
      return this.receipt(this.messages.get(messageId)!)
    })
  }

  /** An unavailable Control receipt does not establish terminal failure or erase a known delivery. */
  async recordDeliveryIssue(messageId: string, reason: string, at = Date.now()): Promise<AgentMuxMessageReceipt> {
    return this.withLock(async () => {
      const current = this.messages.get(nonEmpty(messageId, 'Message id'))
      if (!current) throw new AgentMuxError('Message is unknown.', 'MESSAGE_NOT_FOUND')
      if (current.delivery.state !== 'queued') return this.receipt(current)
      await this.appendRecord({ kind: 'delivery-issue', sequence: this.nextSequence, messageId,
        at: finiteTimestamp(at, 'Delivery issue time'), reason })
      return this.receipt(this.messages.get(messageId)!)
    })
  }

  /** The existing journal owns the first condition even if a Control response is lost. */
  async preparePrompt(messageId: string, capture: (envelope: AgentMuxMessageEnvelope) => Promise<AgentPromptCondition>): Promise<AgentPromptCondition> {
    const original = await this.withLock(async () => {
      const current = this.messages.get(nonEmpty(messageId, 'Message id'))
      if (!current) throw new AgentMuxError('Message is unknown.', 'MESSAGE_NOT_FOUND')
      if (current.promptCondition === undefined) throw new AgentMuxError(
        'This message has no original prompt delivery condition. Its delivery is unknown; it will not be prepared as a new message.',
        'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
      const condition = current.promptCondition
      return { envelope: structuredClone(current.envelope), condition: condition === null ? null : structuredClone(condition) }
    })
    if (original.condition !== null) return original.condition
    // Observation is not a journal mutation. A slow target must not hold the global
    // writer while unrelated messages append; the second scope keeps the first binding.
    const candidate = validateAgentPromptCondition(await capture(original.envelope))
    return this.withLock(async () => {
      const current = this.messages.get(messageId)
      if (!current || current.promptCondition === undefined) throw new AgentMuxError(
        'The original message condition can no longer be confirmed.', 'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
      if (current.promptCondition !== null) return structuredClone(current.promptCondition)
      if (current.envelope.recipientRunId !== null && current.envelope.recipientRunId !== candidate.expectedRun.runId) {
        throw new AgentMuxError('Message recipient Run changed before preparation.', 'MESSAGE_RECIPIENT_MISMATCH')
      }
      await this.appendRecord({ kind: 'prompt-condition', sequence: this.nextSequence, messageId, condition: candidate })
      return structuredClone(candidate)
    })
  }

  async listAfter(sequence = 0): Promise<readonly DurableAgentMuxMessage[]> {
    return this.withLock(async () => {
      await this.ensureLoaded()
      return [...this.messages.values()].filter((item) => item.sequence > sequence).sort((left, right) => left.sequence - right.sequence).map((item) => structuredClone(item))
    })
  }

  async readJournal(): Promise<readonly AgentMuxMessageJournalRecord[]> {
    return this.withLock(async () => {
      await this.ensureLoaded()
      return structuredClone(this.journal)
    })
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
      const previous = this.consumers.get(identity.consumerId)
      const replacement = previous !== undefined && previous.readerRun.runId !== identity.readerRun.runId
      const queue = deliveryQueue(this.messages, this.consumers, identity.consumerId)
      const arithmetic = replacement ? { ...queue, consumers: { ...queue.consumers,
        [identity.consumerId]: { ...queue.consumers[identity.consumerId]!, generation: previous.generation + 1 } } } : queue
      const batch = checkDeliveries(arithmetic, identity.consumerId, input.limit)
      const changed = replacement || (previous?.deliveryIds.length ?? 0) === 0 && batch.deliveryIds.length > 0
      if (changed) {
        await this.appendRecord({ kind: 'consumer-check', sequence: this.nextSequence,
          ...identity, generation: batch.generation, deliveryIds: batch.deliveryIds })
      }
      return { ...identity, generation: batch.generation,
        messages: batch.deliveryIds.map((messageId) => structuredClone(this.messages.get(messageId)!)) }
    })
  }

  async ack(
    input: AgentMuxDeliveryReader & { readonly generation: number },
    reauthorize: () => Promise<void>
  ): Promise<AgentMuxDeliveryAcknowledgement> {
    const identity = reader(input)
    assertGeneration(input.generation)
    return this.withLock(async () => {
      await reauthorize()
      const current = this.consumers.get(identity.consumerId)
      const record: JournalAck = { kind: 'consumer-ack', sequence: this.nextSequence,
        ...identity, generation: input.generation, deliveryIds: current?.deliveryIds ?? [] }
      const next = this.cursorAfterAck(record) // Validate before writing, including the pure generation fence.
      await this.appendRecord(record)
      return { ...identity, acknowledgedMessageIds: [...record.deliveryIds], nextGeneration: next.generation }
    })
  }

  private dispatchMessage(messageId: string): AgentMuxMessageEnvelope {
    const message = this.messages.get(nonEmpty(messageId, 'Dispatch message id'))
    if (!message) {
      throw new AgentMuxError('A referenced Dispatch message is not retained in this journal.', 'DISPATCH_MESSAGE_UNAVAILABLE')
    }
    assertDispatchMessage(message.envelope)
    return message.envelope
  }

  private dispatchProjection(sourceMessageId: string): { dispatch: Dispatch; messages: readonly AgentMuxMessageEnvelope[] } {
    const facts = this.dispatches.get(nonEmpty(sourceMessageId, 'Dispatch source message id'))
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
      const existing = this.dispatches.has(input.sourceMessageId) ? this.dispatchProjection(input.sourceMessageId) : null
      const dispatch = existing?.dispatch ?? openDispatch(source, Date.now())
      await reauthorize(existing?.messages ?? [source])
      if (input.callerAgentSessionId !== dispatch.ownerAgentSessionId) {
        throw new AgentMuxError('Only the source sender can open this Dispatch.', 'DISPATCH_PARTICIPANT_MISMATCH')
      }
      if (!existing) await this.appendRecord({ kind: 'dispatch-open', sequence: this.nextSequence,
        sourceMessageId: dispatch.sourceMessageId, at: dispatch.openedAt })
      return structuredClone(dispatch)
    })
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
    })
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
      ...(message.promptCondition === undefined ? {} : { promptCondition: structuredClone(message.promptCondition) })
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
