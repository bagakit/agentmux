import { link, mkdir, open, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { durableWriteFile, DurableWriteError } from './durable-write.js'
import { AgentMuxError } from './errors.js'
import { deliveryFailure, parseDeliveryAttempt, validateDeliveryLogId, type DeliveryAttempt, type DeliveryAttemptLookup } from './delivery-attempt.js'
import { isObjectId, mintObjectId } from './object-id.js'
import type { AgentMuxDiagnosticAuthorityObservation } from './diagnostic-evidence.js'

const MAX_RECORD_BYTES = 64 * 1024
const MAX_RECORDS = 512
const MAX_BYTES = 8 * 1024 * 1024
const MAX_PENDING = 8
const MAX_MEMORY = 32
const RETENTION_ISSUE = 'No retained record matches this ID. The recent diagnostic window has rotated; earlier coverage is incomplete.'

/** Immutable diagnostic records. No retry queue, Input authority or Runtime cache. */
export class DeliveryAttemptStore {
  private readonly reading = new Map<string, Promise<DeliveryAttemptLookup>>()
  private readonly memory = new Map<string, DeliveryAttemptLookup>()
  private readonly writing = new Map<string, { record: DeliveryAttempt; operation: Promise<DeliveryAttemptLookup> }>()
  private identityRead: Promise<AgentMuxDiagnosticAuthorityObservation> | null = null
  private identityWrite: Promise<void> | null = null
  constructor(readonly directory: string, private readonly options: { clientJournal?: true } = {}) {
    if (options.clientJournal) void this.ensureJournalIdentity()
  }

  /** Storage identity only; never an original click producer or a Core runtime ID.
   * A pending metadata IO is shared, so repeated queries cannot multiply it.
   */
  async readJournalAuthority(): Promise<AgentMuxDiagnosticAuthorityObservation> {
    const operation = this.identityRead ??= this.readJournalIdentity()
    void operation.finally(() => { if (this.identityRead === operation) this.identityRead = null }).catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([operation, new Promise<AgentMuxDiagnosticAuthorityObservation>(resolve => {
      timer = setTimeout(() => resolve({ authority: null, status: 'unavailable', causeCode: null }), 150)
    })]) } finally { clearTimeout(timer) }
  }

  private async readJournalIdentity(): Promise<AgentMuxDiagnosticAuthorityObservation> {
    try {
      const handle = await open(join(this.directory, 'journal-identity.json'), 'r')
      let data: Buffer
      try { const buffer = Buffer.alloc(4097), read = await handle.read(buffer, 0, buffer.length, 0); data = buffer.subarray(0, read.bytesRead) }
      finally { await handle.close() }
      if (data.length > 4096) throw new AgentMuxError('Journal metadata exceeds its budget.', 'DELIVERY_LOG_CORRUPT')
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as Record<string, unknown>
      if (!value || Object.keys(value).sort().join() !== 'journalId,schema' ||
          value.schema !== 'agentmux.delivery-journal.v1' || !isObjectId(value.journalId)) {
        throw new AgentMuxError('Journal metadata is malformed.', 'DELIVERY_LOG_CORRUPT')
      }
      return { authority: { kind: 'client-journal', id: value.journalId as string, lifetime: 'durable' }, status: 'verified', causeCode: null }
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      return { authority: null, status: code === 'ENOENT' ? 'unconfirmed' : 'unavailable',
        causeCode: typeof code === 'string' && code.length <= 512 ? code : null }
    }
  }

  private ensureJournalIdentity(): Promise<void> {
    if (!this.options.clientJournal) return Promise.resolve()
    if (this.identityWrite) return this.identityWrite
    const operation = (async () => {
      const existing = await this.readJournalIdentity()
      if (existing.authority || existing.causeCode !== 'ENOENT') return
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = join(this.directory, `journal-${mintObjectId()}.candidate`)
      try {
        await durableWriteFile(temporary, JSON.stringify({ schema: 'agentmux.delivery-journal.v1', journalId: mintObjectId() }) + '\n', { mode: 0o600, requireDirectorySync: true })
        try { await link(temporary, join(this.directory, 'journal-identity.json')) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        const directory = await open(this.directory, 'r')
        try { await directory.sync() } finally { await directory.close() }
      } finally { await unlink(temporary).catch(() => {}) }
    })().catch(() => { /* Separate metadata observations report failure; original records stay usable. */ })
    this.identityWrite = operation
    void operation.finally(() => { if (this.identityWrite === operation) this.identityWrite = null })
    return operation
  }

  async read(logId: string): Promise<DeliveryAttemptLookup> {
    validateDeliveryLogId(logId)
    let operation = this.reading.get(logId)
    if (!operation) {
      if (this.reading.size >= MAX_PENDING) return { logId, availability: 'unavailable', record: null, persistence: null, issue: 'The original diagnostic reader is busy.' }
      operation = this.readDisk(logId).then(({ lookup }) => {
        const known = this.memory.get(logId)
        // The cache can acknowledge a still-retained exact record or keep an
        // unresolved writer's evidence. It cannot revive a rotated record.
        if (known && (lookup.record && isDeepStrictEqual(known.record, lookup.record) && known.persistence === 'confirmed' ||
            !lookup.record && known.persistence === 'unconfirmed')) return structuredClone(known)
        return lookup
      })
      this.reading.set(logId, operation)
      void operation.finally(() => { if (this.reading.get(logId) === operation) this.reading.delete(logId) }).catch(() => {})
    }
    return await this.finite(operation, () => ({ logId, availability: 'unavailable', record: null, persistence: null, issue: 'The original diagnostic file read is still pending.' }))
  }

  private get databasePath(): string { return join(this.directory, 'recent.sqlite') }

  private async readLegacy(logId: string): Promise<DeliveryAttemptLookup> {
    try {
      const handle = await open(join(this.directory, `${logId}.json`), 'r')
      let content: Buffer
      try {
        if ((await handle.stat()).size > MAX_RECORD_BYTES) throw new AgentMuxError('Delivery log exceeds its record budget.', 'DELIVERY_LOG_CORRUPT')
        const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        content = bytes.subarray(0, bytesRead)
      } finally { await handle.close() }
      const record = this.parseRetained(new TextDecoder('utf-8', { fatal: true }).decode(content), logId)
      return { logId, availability: 'found', record, persistence: 'observed', issue: null }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { logId, availability: 'not-found', record: null, persistence: null, issue: null }
      return { logId, availability: 'unavailable', record: null, persistence: null, issue: error instanceof Error ? error.message : String(error) }
    }
  }

  private async readDisk(logId: string, writing = false): Promise<{ lookup: DeliveryAttemptLookup; path: string }> {
    const legacy = await this.readLegacy(logId)
    if (legacy.availability !== 'not-found') return { lookup: legacy, path: join(this.directory, `${logId}.json`) }
    const path = this.databasePath
    let db: DatabaseSync | undefined
    try {
      if ((await stat(path)).size === 0 && writing) return { path, lookup: legacy }
      const { DatabaseSync } = await import('node:sqlite')
      db = new DatabaseSync(path, { readOnly: true })
      const row = db.prepare('SELECT content FROM attempt WHERE log_id = ?').get(logId)
      if (row) return { path, lookup: { logId, availability: 'found',
        record: this.parseRetained(row.content, logId), persistence: 'observed', issue: null } }
      const coverage = db.prepare('SELECT rotated FROM retention WHERE id = 1').get()
      return { path, lookup: { ...legacy, issue: coverage?.rotated ? RETENTION_ISSUE : null } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, lookup: legacy }
      return { path, lookup: { logId, availability: 'unavailable', record: null, persistence: null,
        issue: error instanceof Error ? error.message : String(error) } }
    } finally { db?.close() }
  }

  private parseRetained(value: unknown, logId: string): DeliveryAttempt {
    if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_RECORD_BYTES) throw new AgentMuxError(
      'Delivery log exceeds its record budget.', 'DELIVERY_LOG_CORRUPT')
    const record = parseDeliveryAttempt(JSON.parse(value))
    if (record.logId !== logId) throw new AgentMuxError('Delivery log identity changed.', 'DELIVERY_LOG_CORRUPT')
    return record
  }

  private async publish(record: DeliveryAttempt, content: string): Promise<DeliveryAttempt> {
    const path = this.databasePath
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // Reserve with the same private mode as the previous files. Neither old
    // records nor the new journal are replaced if another writer wins the race.
    const file = await open(path, 'a', 0o600)
    await file.close()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    try {
      db.exec(`PRAGMA page_size = 4096; PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA; PRAGMA max_page_count = 8192;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS attempt (
          seq INTEGER PRIMARY KEY, log_id TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL, content TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS retention (
          id INTEGER PRIMARY KEY CHECK (id = 1), records INTEGER NOT NULL, bytes INTEGER NOT NULL, rotated INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO retention VALUES (1, 0, 0, 0);`)
      const existing = db.prepare('SELECT content FROM attempt WHERE log_id = ?').get(record.logId)
      if (existing) {
        const first = this.parseRetained(existing.content, record.logId)
        this.sameAttempt(first, record)
        db.exec('COMMIT')
        return first
      }
      const { records, bytes, rotated } = db.prepare('SELECT records, bytes, rotated FROM retention WHERE id = 1').get()!
      let retainedRecords = Number(records), retainedBytes = Number(bytes)
      const contentBytes = Buffer.byteLength(content)
      const evict = db.prepare('DELETE FROM attempt WHERE seq = (SELECT min(seq) FROM attempt) RETURNING bytes')
      while (retainedRecords >= MAX_RECORDS || retainedBytes + contentBytes > MAX_BYTES) {
        const oldest = evict.get()
        if (!oldest) throw new AgentMuxError('Delivery diagnostic retention counters diverged.', 'DELIVERY_LOG_CORRUPT')
        retainedRecords--
        retainedBytes -= Number(oldest.bytes)
      }
      db.prepare('INSERT INTO attempt (log_id, bytes, content) VALUES (?, ?, ?)').run(record.logId, contentBytes, content)
      db.prepare('UPDATE retention SET records = ?, bytes = ?, rotated = ? WHERE id = 1').run(
        retainedRecords + 1, retainedBytes + contentBytes, Number(rotated) || Number(retainedRecords !== records))
      db.exec('COMMIT')
      return record
    } finally { db.close() } // Closing rolls back any uncommitted insertion and eviction together.
  }

  async record(input: DeliveryAttempt): Promise<DeliveryAttemptLookup> {
    if (this.options.clientJournal) void this.ensureJournalIdentity()
    const record = structuredClone(parseDeliveryAttempt(input)), logId = record.logId
    const active = this.writing.get(logId)
    if (active) this.sameAttempt(active.record, record)
    if (!active && this.writing.size >= MAX_PENDING) return { logId, availability: 'unavailable', record: null,
      persistence: null, issue: 'The diagnostic writer is at capacity; this attempt was not persisted by this call.' }
    const operation = active?.operation ?? this.write(record)
    if (!active) this.writing.set(logId, { record, operation })
    // Finite feedback does not cancel a possibly publishing write or create another one.
    // Late completion belongs to this exact immutable record and updates only its journal.
    if (!active) void operation.finally(() => { this.writing.delete(logId) }).catch(() => {})
    return await this.finite(operation, () => {
      const known = this.memory.get(logId)
      return known ? { ...structuredClone(known), issue: 'Diagnostic persistence is still pending; the current owner retains its record in memory.' }
        : { logId, availability: 'unavailable', record: null, persistence: null, issue: 'Diagnostic publication is still pending; this ID is not yet confirmed readable.' }
    })
  }

  private remember(result: DeliveryAttemptLookup): void {
    if (Buffer.byteLength(JSON.stringify(result.record)) > MAX_RECORD_BYTES) return
    this.memory.delete(result.logId)
    this.memory.set(result.logId, structuredClone(result))
    if (this.memory.size > MAX_MEMORY) this.memory.delete(this.memory.keys().next().value!)
  }

  private async finite(operation: Promise<DeliveryAttemptLookup>, pending: () => DeliveryAttemptLookup): Promise<DeliveryAttemptLookup> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([operation, new Promise<DeliveryAttemptLookup>(resolve => {
      timer = setTimeout(() => resolve(pending()), 500)
    })]) } finally { clearTimeout(timer) }
  }

  private sameAttempt(original: DeliveryAttempt, incoming: DeliveryAttempt): void {
    // Receiving time belongs to the first report. A replay cannot refresh the past.
    const payload = ({ reporter, ...rest }: DeliveryAttempt) => ({ ...rest, ...(reporter ? { reporter: { ...reporter, receivedAt: 0 } } : {}) })
    if (!isDeepStrictEqual(payload(original), payload(incoming))) throw new AgentMuxError('This log ID already records a different attempt.', 'DELIVERY_LOG_CONFLICT')
  }

  private async confirm(path: string): Promise<void> {
    // The original file is already published; this retry only confirms durability.
    for (const [target, cleanup] of [[path, 'file-close'], [this.directory, 'directory-close']] as const) {
      const handle = await open(target, 'r')
      let failure: DurableWriteError | undefined
      try { await handle.sync() } catch (error) {
        failure = new DurableWriteError(path, 'after-replace', error)
        throw failure
      } finally {
        try { await handle.close() } catch (error) {
          if (failure) failure.addCleanupFailure(cleanup, error)
          else throw new DurableWriteError(path, 'after-replace', error)
        }
      }
    }
  }

  private async write(incoming: DeliveryAttempt): Promise<DeliveryAttemptLookup> {
    const logId = incoming.logId, known = this.memory.get(logId)
    if (known?.availability === 'found') {
      this.sameAttempt(known.record!, incoming)
    }
    // An unconfirmed in-memory record is retryable. Recheck the immutable disk
    // original rather than letting that cache permanently hide storage recovery.
    const { lookup: disk, path } = await this.readDisk(logId, true)
    if (disk.availability === 'found') {
      this.sameAttempt(disk.record!, incoming)
      if (known?.persistence === 'confirmed' && isDeepStrictEqual(known.record, disk.record)) return structuredClone(known)
    }
    if (disk.availability === 'unavailable' && !known && incoming.source === 'client') throw new AgentMuxError(
      disk.issue ?? 'The original diagnostic record is unavailable.', 'DELIVERY_LOG_UNAVAILABLE')
    const record = disk.record ?? known?.record ?? incoming
    const result: DeliveryAttemptLookup = { logId, availability: 'found', record, persistence: 'unconfirmed', issue: null }
    this.remember(result)
    try {
      if (disk.availability === 'unavailable') throw new AgentMuxError(disk.issue ?? 'The diagnostic directory is unavailable.', 'DELIVERY_LOG_UNAVAILABLE')
      if (disk.record === null) {
        const content = JSON.stringify(record)
        if (Buffer.byteLength(content) > MAX_RECORD_BYTES) throw new AgentMuxError(
          'Delivery log exceeds its record budget.', 'DELIVERY_LOG_CORRUPT')
        result.record = await this.publish(record, content)
      }
      // Readable bytes are not an acknowledged file + directory durability fence.
      await this.confirm(path)
      result.persistence = 'confirmed'
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'DELIVERY_LOG_CONFLICT') throw error
      const failure = deliveryFailure(error)
      result.issue = `Diagnostic persistence is unconfirmed: ${failure.code ? `[${failure.code}] ` : ''}${failure.message.slice(0, 2048)}${failure.detail ? `; ${failure.detail.slice(0, 4096)}` : ''}`
    }
    this.remember(result)
    return structuredClone(result)
  }
}
