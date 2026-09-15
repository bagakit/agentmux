import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AgentMuxError } from './errors.js'
import { ackDeliveryBatch, checkDeliveries, type ConsumerCursor, type DeliveryQueue } from './agent-delivery-queue.js'
import { advanceDelivery, type AgentDeliveryState } from './agent-message.js'
import type { AgentMuxMessageTarget } from './control.js'
import { defaultAgentMuxMessageQueuePath } from './runtime-paths.js'

export type AgentMuxMessageIdentity =
  | { readonly kind: 'agent-session'; readonly agentSessionId: string }
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
}

export type AgentMuxMessageReceipt = {
  readonly queueId: string
  readonly receiptId: string
  readonly messageId: string
  readonly sequence: number
  readonly envelope: AgentMuxMessageEnvelope
  readonly delivery: AgentMuxMessageDeliveryState
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

export type AgentMuxMessageJournalRecord =
  | { readonly kind: 'message'; readonly sequence: number; readonly envelope: AgentMuxMessageEnvelope }
  | { readonly kind: 'delivery'; readonly sequence: number; readonly messageId: string; readonly state: AgentDeliveryState; readonly at: number; readonly reason?: string }
  | { readonly kind: 'consumer-check'; readonly sequence: number; readonly consumerId: string; readonly generation: number; readonly deliveryIds: readonly string[] }
  | { readonly kind: 'consumer-ack'; readonly sequence: number; readonly consumerId: string; readonly generation: number; readonly deliveryIds: readonly string[] }
type JournalMessage = Extract<AgentMuxMessageJournalRecord, { kind: 'message' }>
type JournalDelivery = Extract<AgentMuxMessageJournalRecord, { kind: 'delivery' }>
type JournalCheck = Extract<AgentMuxMessageJournalRecord, { kind: 'consumer-check' }>
type JournalAck = Extract<AgentMuxMessageJournalRecord, { kind: 'consumer-ack' }>
type JournalRecord = AgentMuxMessageJournalRecord

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

function deliveryQueue(messages: ReadonlyMap<string, DurableAgentMuxMessage>, consumers: ReadonlyMap<string, ConsumerCursor>): DeliveryQueue {
  return {
    pending: [...messages.values()].sort((left, right) => left.sequence - right.sequence).map((item) => item.envelope.messageId),
    consumers: Object.fromEntries(consumers.entries())
  }
}

export class DurableAgentMuxMessageQueue {
  readonly queueId: string
  private loaded = false
  private bytes = 0
  private nextSequence = 1
  private readonly messages = new Map<string, DurableAgentMuxMessage>()
  private readonly operations = new Map<string, string>()
  private readonly consumers = new Map<string, ConsumerCursor>()
  private readonly journal: JournalRecord[] = []
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    readonly path = defaultAgentMuxMessageQueuePath(),
    private readonly options: AgentMuxMessageQueueOptions = {}
  ) {
    this.queueId = queueIdFor(path)
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => this.withFileLock(operation), () => this.withFileLock(operation))
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const lockPath = `${this.path}.lock`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try { handle = await open(lockPath, 'wx', 0o600); break } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new AgentMuxError('Message queue store is unavailable.', 'MESSAGE_QUEUE_UNAVAILABLE')
        let stale = false
        try {
          const metadata = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number; acquiredAt?: number }
          const pid = metadata.pid
          if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0) } catch (probeError) {
              stale = (probeError as NodeJS.ErrnoException).code === 'ESRCH'
            }
          } else stale = true
          if (!stale && typeof metadata.acquiredAt === 'number' && Date.now() - metadata.acquiredAt > 30_000) stale = false
        } catch {
          try {
            const stat = await lstat(lockPath)
            stale = Date.now() - stat.mtimeMs > 30_000
          } catch { stale = true }
        }
        if (stale) { await rm(lockPath, { force: true }); continue }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    if (!handle) throw new AgentMuxError('Message queue writer is busy.', 'MESSAGE_QUEUE_BACKPRESSURE')
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }))
      await handle.sync()
      this.loaded = false
      this.bytes = 0
      this.nextSequence = 1
      this.messages.clear()
      this.operations.clear()
      this.consumers.clear()
      this.journal.length = 0
      await this.ensureLoaded()
      return await operation()
    } finally {
      await handle.close()
      await rm(lockPath, { force: true })
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
      const message = { sequence: record.sequence, envelope, delivery: Object.freeze({ state: 'queued' as const, at: envelope.createdAt }) }
      this.messages.set(envelope.messageId, message)
      this.operations.set(envelope.operationId, envelope.messageId)
      return
    }
    if (record.kind === 'delivery') {
      const current = this.messages.get(record.messageId)
      if (!current) throw new AgentMuxError('Message queue delivery references an unknown message.', 'MESSAGE_QUEUE_UNAVAILABLE')
      const delivery = advanceDelivery(current.delivery, record.state, record.at)
      this.messages.set(record.messageId, { ...current, delivery: { ...delivery, ...(record.reason === undefined ? {} : { reason: record.reason }) } })
      return
    }
    const cursor = this.consumers.get(record.consumerId) ?? { acked: 0, generation: 1, inFlight: 0 }
    if (record.kind === 'consumer-check') this.consumers.set(record.consumerId, { ...cursor, generation: record.generation, inFlight: record.deliveryIds.length })
    else this.consumers.set(record.consumerId, { acked: cursor.acked + record.deliveryIds.length, generation: record.generation + 1, inFlight: 0 })
  }

  private async appendRecord(record: JournalRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
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
      const record: JournalMessage = { kind: 'message', sequence: this.nextSequence, envelope }
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
      const record: JournalDelivery = { kind: 'delivery', sequence: this.nextSequence, messageId, state, at, ...(reason === undefined ? {} : { reason }) }
      await this.appendRecord(record)
      return this.receipt(this.messages.get(messageId)!)
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

  async check(consumerId: string, limit: number): Promise<{ readonly generation: number; readonly messages: readonly DurableAgentMuxMessage[] }> {
    return this.withLock(async () => {
      await this.ensureLoaded()
      const id = nonEmpty(consumerId, 'Consumer id')
      const batch = checkDeliveries(deliveryQueue(this.messages, this.consumers), id, limit)
      const cursor = batch.queue.consumers[id]!
      if (cursor.inFlight === 0) return { generation: cursor.generation, messages: [] }
      if ((this.consumers.get(id)?.inFlight ?? 0) === 0) {
        await this.appendRecord({ kind: 'consumer-check', sequence: this.nextSequence, consumerId: id, generation: batch.generation, deliveryIds: batch.deliveryIds })
      }
      return { generation: cursor.generation, messages: batch.deliveryIds.map((messageId) => structuredClone(this.messages.get(messageId)!)) }
    })
  }

  async ack(consumerId: string, generation: number): Promise<void> {
    return this.withLock(async () => {
      await this.ensureLoaded()
      const id = nonEmpty(consumerId, 'Consumer id')
      const queue = deliveryQueue(this.messages, this.consumers)
      const cursor = queue.consumers[id]
      if (!cursor || cursor.inFlight === 0 || cursor.generation !== generation) throw new AgentMuxError('Message consumer generation is stale.', 'MESSAGE_ACK_GENERATION_STALE')
      const next = ackDeliveryBatch(queue, id, generation)
      await this.appendRecord({ kind: 'consumer-ack', sequence: this.nextSequence, consumerId: id, generation, deliveryIds: queue.pending.slice(cursor.acked, cursor.acked + cursor.inFlight) })
      this.consumers.set(id, next.consumers[id]!)
    })
  }

  private receipt(message: DurableAgentMuxMessage): AgentMuxMessageReceipt {
    return {
      queueId: this.queueId,
      receiptId: `${this.queueId}:${message.sequence}:${message.envelope.messageId}`,
      messageId: message.envelope.messageId,
      sequence: message.sequence,
      envelope: structuredClone(message.envelope),
      delivery: { ...message.delivery }
    }
  }
}

export async function appendGlobalMessage(input: AgentMuxMessageAppendInput, path = defaultAgentMuxMessageQueuePath()): Promise<AgentMuxMessageReceipt> {
  return await new DurableAgentMuxMessageQueue(path).append(input)
}

export async function recordGlobalMessageDelivery(messageId: string, state: Exclude<AgentDeliveryState, 'queued'>, at = Date.now(), reason?: string, path = defaultAgentMuxMessageQueuePath()): Promise<AgentMuxMessageReceipt> {
  return await new DurableAgentMuxMessageQueue(path).recordDelivery(messageId, state, at, reason)
}
