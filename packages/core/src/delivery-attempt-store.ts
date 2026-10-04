import { link, mkdir, open, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { durableWriteFile } from './durable-write.js'
import { AgentMuxError } from './errors.js'
import { parseDeliveryAttempt, validateDeliveryLogId, type DeliveryAttempt, type DeliveryAttemptLookup } from './delivery-attempt.js'

/** Immutable diagnostic records. No retry queue, Input authority or Runtime cache. */
export class DeliveryAttemptStore {
  private readonly memory = new Map<string, DeliveryAttemptLookup>()
  private readonly writing = new Map<string, Promise<DeliveryAttemptLookup>>()
  constructor(readonly directory: string) {}

  async read(logId: string): Promise<DeliveryAttemptLookup> {
    validateDeliveryLogId(logId)
    const known = this.memory.get(logId)
    if (known) return structuredClone(known)
    return await this.finite(this.readDisk(logId), () => ({ logId, availability: 'unavailable', record: null, persistence: null, issue: 'The original diagnostic file read is still pending.' }))
  }

  private async readDisk(logId: string): Promise<DeliveryAttemptLookup> {
    try {
      const handle = await open(join(this.directory, `${logId}.json`), 'r')
      let content: Buffer
      try {
        if ((await handle.stat()).size > 64 * 1024) throw new AgentMuxError('Delivery log exceeds its record budget.', 'DELIVERY_LOG_CORRUPT')
        const bytes = Buffer.alloc(64 * 1024 + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        content = bytes.subarray(0, bytesRead)
      } finally { await handle.close() }
      if (content.byteLength > 64 * 1024) throw new AgentMuxError('Delivery log exceeds its record budget.', 'DELIVERY_LOG_CORRUPT')
      const record = parseDeliveryAttempt(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)))
      if (record.logId !== logId) throw new AgentMuxError('Delivery log identity changed.', 'DELIVERY_LOG_CORRUPT')
      return { logId, availability: 'found', record, persistence: 'observed', issue: null }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { logId, availability: 'not-found', record: null, persistence: null, issue: null }
      return { logId, availability: 'unavailable', record: null, persistence: null, issue: error instanceof Error ? error.message : String(error) }
    }
  }

  async record(input: DeliveryAttempt): Promise<DeliveryAttemptLookup> {
    const record = structuredClone(parseDeliveryAttempt(input)), logId = record.logId
    const active = this.writing.get(logId)
    if (active) return await this.finite(active.then(() => this.record(record)), () => ({
      logId, availability: 'unavailable', record: null, persistence: null, issue: 'The original immutable report write is still pending.' }))
    const operation = this.write(record)
    this.writing.set(logId, operation)
    // Finite feedback does not cancel a possibly publishing write or create another one.
    // Late completion belongs to this exact immutable record and updates only its journal.
    void operation.finally(() => { if (this.writing.get(logId) === operation) this.writing.delete(logId) }).catch(() => {})
    return await this.finite(operation, () => {
      const known = this.memory.get(logId)
      return known ? { ...structuredClone(known), issue: 'Diagnostic persistence is still pending; the current owner retains its record in memory.' }
        : { logId, availability: 'unavailable', record: null, persistence: null, issue: 'Diagnostic publication is still pending; this ID is not yet confirmed readable.' }
    })
  }

  private async finite(operation: Promise<DeliveryAttemptLookup>, pending: () => DeliveryAttemptLookup): Promise<DeliveryAttemptLookup> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([operation, new Promise<DeliveryAttemptLookup>(resolve => {
      timer = setTimeout(() => resolve(pending()), 500)
    })]) } finally { clearTimeout(timer) }
  }

  private async write(record: DeliveryAttempt): Promise<DeliveryAttemptLookup> {
    const logId = record.logId, old = await this.read(logId)
    if (old.availability === 'found') {
      // Receiving time belongs to the first report. A replay cannot refresh the past.
      const payload = ({ reporter, ...rest }: DeliveryAttempt) => ({ ...rest, ...(reporter ? { reporter: { ...reporter, receivedAt: 0 } } : {}) })
      if (!isDeepStrictEqual(payload(old.record!), payload(record))) throw new AgentMuxError('This log ID already records a different attempt.', 'DELIVERY_LOG_CONFLICT')
      return old
    }
    if (old.availability === 'unavailable' && record.source === 'client') throw new AgentMuxError(
      old.issue ?? 'The original diagnostic record is unavailable.', 'DELIVERY_LOG_UNAVAILABLE')
    const result: DeliveryAttemptLookup = { logId, availability: 'found', record, persistence: 'unconfirmed', issue: null }
    this.memory.set(logId, structuredClone(result))
    try {
      if (old.availability === 'unavailable') throw new AgentMuxError(old.issue ?? 'The diagnostic directory is unavailable.', 'DELIVERY_LOG_UNAVAILABLE')
      const content = JSON.stringify(record) + '\n'
      if (Buffer.byteLength(content) > 64 * 1024) throw new AgentMuxError('Delivery log exceeds its record budget.', 'DELIVERY_LOG_CORRUPT')
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      // Publish without replacement: simultaneous reporters cannot overwrite an
      // existing immutable attempt, even across two independent Host processes.
      const temporary = join(this.directory, `${logId}.${randomUUID()}.candidate`)
      try {
        await durableWriteFile(temporary, content, { mode: 0o600, requireDirectorySync: true })
        try { await link(temporary, join(this.directory, `${logId}.json`)) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          this.memory.delete(logId)
          const existing = await this.read(logId)
          // A concurrently published unreadable original is not permission to substitute
          // our proposed payload in memory. Preserve the original unavailable fact.
          if (existing.availability !== 'found') return existing
          const payload = ({ reporter, ...rest }: DeliveryAttempt) => ({ ...rest, ...(reporter ? { reporter: { ...reporter, receivedAt: 0 } } : {}) })
          if (!isDeepStrictEqual(payload(existing.record!), payload(record))) throw new AgentMuxError('This log ID already records a different attempt.', 'DELIVERY_LOG_CONFLICT')
          return existing
        }
        const directory = await open(this.directory, 'r')
        try { await directory.sync() } finally { await directory.close() }
        result.persistence = 'confirmed'
      } finally { await unlink(temporary).catch(() => {}) }
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'DELIVERY_LOG_CONFLICT') throw error
      result.issue = `Diagnostic persistence is unconfirmed: ${error instanceof Error ? error.message : String(error)}` }
    this.memory.set(logId, structuredClone(result))
    return structuredClone(result)
  }
}
