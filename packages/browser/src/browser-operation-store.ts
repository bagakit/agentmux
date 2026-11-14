import { mintObjectId } from '@agentmux/core/object-id'
import { createHash } from 'node:crypto'
import { chmod, link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { durableWriteFile } from '@agentmux/core'
import type { BrowserOperation, BrowserOperationStep, BrowserOperationPhase } from './model/browser-operation.js'
import type { BrowserOperationEvent, BrowserOperationJournalDocument } from './browser-operation-journal.js'

export const BROWSER_OPERATION_JOURNAL_VERSION = 1 as const
// Keep the original pathname: the successful cutover leaves one authoritative store.
export const BROWSER_OPERATION_JOURNAL_FILE = 'browser-operation-journal.json'
const APPLICATION_ID = 0x414d5842
const SQLITE_HEADER = 'SQLite format 3\0'

export type BrowserOperationJournalChanges = {
  readonly writer: string
  readonly revision: number
  readonly operations: ReadonlyArray<{
    readonly metadata: Omit<BrowserOperation, 'steps'>
    readonly steps: readonly BrowserOperationStep[]
  }>
  readonly events: ReadonlyArray<{ readonly id: string; readonly sequence: number; readonly event: BrowserOperationEvent }>
  readonly maxEvents: number
}

export interface BrowserOperationJournalStore {
  /** A complete result is valid too; windowed stores also provide synchronous original identity/detail reads. */
  load(window?: { maxOperations: number; protectedPhases: readonly BrowserOperationPhase[] }): Promise<BrowserOperationJournalDocument | null>
  /** Optional for a full in-memory store; windowed storage retains exact original identity and detail. */
  hasLoadedOperation?(operationId: string): boolean
  readOperation?(operationId: string, loadedIds: readonly string[]): { operation: BrowserOperation; beforeId: string | null } | null
  /** Only immutable facts changed by this save; there is no full-snapshot write path. */
  save(changes: BrowserOperationJournalChanges): Promise<void>
}

/** Electron-independent storage. Damage is reported to the advisory Journal, never replaced. */
export class BrowserOperationFileStore implements BrowserOperationJournalStore {
  private tail: Promise<unknown> = Promise.resolve()
  private loaded = false
  private unavailable = false
  private existed = false
  // Only immutable identities/coordinates observed at load. New live identities stay in Journal's original map.
  private readonly positions = new Map<string, number>()

  constructor(private readonly path: string) {}

  async load(window?: { maxOperations: number; protectedPhases: readonly BrowserOperationPhase[] }): Promise<BrowserOperationJournalDocument | null> {
    const loading = this.tail.catch(() => {}).then(async () => {
      try {
        const header = await this.header()
        if (header === null) {
          if (this.existed) throw new Error('Original Browser journal is temporarily missing.')
          this.loaded = true
          return { version: BROWSER_OPERATION_JOURNAL_VERSION, operations: [], events: [] }
        }
        this.existed = true
        if (header !== SQLITE_HEADER) await this.convertOriginal()
        const database = this.database()
        try {
          // Identity coordinates, body window, steps and events belong to one read snapshot.
          database.exec('BEGIN')
          if (window !== undefined) {
            const positions = database.prepare('SELECT id, ordinal FROM operations ORDER BY ordinal').all()
            this.positions.clear()
            for (const row of positions) this.positions.set(String(row.id), Number(row.ordinal))
          }
          const protectedPhases = window ? JSON.stringify(window.protectedPhases) : ''
          const operations = database.prepare(window === undefined ? 'SELECT metadata FROM operations ORDER BY ordinal' : `SELECT metadata FROM operations
            WHERE COALESCE(json_extract(metadata, '$.phase'), '') IN (SELECT value FROM json_each(?))
              OR ordinal IN (SELECT ordinal FROM operations WHERE COALESCE(json_extract(metadata, '$.phase'), '') NOT IN (SELECT value FROM json_each(?)) ORDER BY ordinal DESC LIMIT ?)
            ORDER BY ordinal`).all(...(window === undefined ? [] : [protectedPhases, protectedPhases, window.maxOperations]))
            .map(row => ({ ...JSON.parse(String(row.metadata)), steps: [] })) as BrowserOperation[]
          if (window === undefined) {
            const byId = new Map(operations.map(operation => [operation.id, operation]))
            for (const row of database.prepare('SELECT operation_id, body FROM steps ORDER BY operation_id, sequence').all()) byId.get(String(row.operation_id))!.steps.push(JSON.parse(String(row.body)))
          } else {
            const readSteps = database.prepare('SELECT body FROM steps WHERE operation_id = ? ORDER BY sequence')
            for (const operation of operations) for (const row of readSteps.all(operation.id)) operation.steps.push(JSON.parse(String(row.body)))
          }
          const events = database.prepare('SELECT events.body FROM events JOIN writers ON writers.id = events.writer ORDER BY writers.ordinal, events.sequence').all()
            .map(row => JSON.parse(String(row.body))) as BrowserOperationEvent[]
          database.exec('COMMIT')
          this.loaded = true
          this.unavailable = false
          return { version: BROWSER_OPERATION_JOURNAL_VERSION, operations, events }
        } finally { database.close() }
      } catch {
        this.unavailable = true
        return null
      }
    })
    this.tail = loading
    return loading
  }

  async save(changes: BrowserOperationJournalChanges): Promise<void> {
    if (!this.loaded && !this.unavailable) await this.load()
    const saving = this.tail.catch(() => {}).then(async () => {
      // An unreadable source is not an empty history. Preserve it and all unsaved live changes.
      if (this.unavailable) throw new Error('Original Browser history is unreadable; restore its storage and reopen the original journal. Live Browser work remains available.')
      if (await this.header() === null) {
        if (this.existed) throw new Error('Original Browser journal is temporarily missing; restore its original file. Live Browser work remains available.')
        await this.create(changes)
        this.existed = true
        return
      }
      const database = this.database()
      try { this.write(database, changes) } finally { database.close() }
    })
    this.tail = saving
    await saving
  }

  hasLoadedOperation(operationId: string): boolean { return this.positions.has(operationId) }

  /** Synchronous after load: a cold miss never yields between original identity admission and dispatch. */
  readOperation(operationId: string, loadedIds: readonly string[]): { operation: BrowserOperation; beforeId: string | null } | null {
    const ordinal = this.positions.get(operationId)
    if (ordinal === undefined) return null
    const database = this.database(this.path, true)
    try {
      database.exec('BEGIN')
      const row = database.prepare('SELECT metadata FROM operations WHERE id = ?').get(operationId)
      if (!row) throw new Error('The original Browser operation is temporarily unavailable; its identity is retained.')
      const operation = { ...JSON.parse(String(row.metadata)), steps: database.prepare('SELECT body FROM steps WHERE operation_id = ? ORDER BY sequence').all(operationId).map(step => JSON.parse(String(step.body))) } as BrowserOperation
      if (operation.id !== operationId) throw new Error('Stored Browser operation identity does not match its original ID.')
      database.exec('COMMIT')
      let beforeId: string | null = null, beforeOrdinal = Infinity
      for (const id of loadedIds) {
        const position = this.positions.get(id)
        if (position === undefined) { beforeId ??= id; continue }
        if (position > ordinal && position < beforeOrdinal) { beforeId = id; beforeOrdinal = position }
      }
      return { operation, beforeId }
    } finally { database.close() }
  }

  private async header(): Promise<string | null> {
    let file
    try { file = await open(this.path, 'r') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const bytes = Buffer.alloc(16)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      return bytes.subarray(0, bytesRead).toString('utf8')
    } finally { await file.close() }
  }

  private database(path = this.path, readOnly = false): DatabaseSync {
    const database = new DatabaseSync(path, { readOnly })
    try {
      database.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON; PRAGMA synchronous = EXTRA;')
      if (Number(database.prepare('PRAGMA application_id').get()!.application_id) !== APPLICATION_ID
        || Number(database.prepare('PRAGMA user_version').get()!.user_version) !== BROWSER_OPERATION_JOURNAL_VERSION) {
        throw new Error('Original Browser journal has an unknown storage format.')
      }
      return database
    } catch (error) { database.close(); throw error }
  }

  private async create(changes: BrowserOperationJournalChanges): Promise<void> {
    const temporary = `${this.path}.${mintObjectId()}.sqlite`
    try {
      await this.initialize(temporary)
      const database = this.database(temporary)
      try { this.write(database, changes) } finally { database.close() }
      const file = await open(temporary, 'r')
      try { await file.sync() } finally { await file.close() }
      // Publish a complete first transaction exclusively. An interrupted private build is
      // never the canonical history, and a concurrent creator's history is never replaced.
      await link(temporary, this.path)
      const directory = await open(dirname(this.path), 'r')
      try { await directory.sync() } finally { await directory.close() }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const file = await open(path, 'wx', 0o600)
    await file.close()
    const database = new DatabaseSync(path)
    try {
      database.exec(`PRAGMA synchronous = EXTRA; PRAGMA journal_mode = DELETE;
        BEGIN IMMEDIATE;
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${BROWSER_OPERATION_JOURNAL_VERSION};
        CREATE TABLE writers (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE) STRICT;
        CREATE TABLE operations (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, metadata TEXT NOT NULL, writer TEXT NOT NULL, revision INTEGER NOT NULL) STRICT;
        CREATE TABLE steps (operation_id TEXT NOT NULL REFERENCES operations(id), sequence INTEGER NOT NULL, body TEXT NOT NULL, writer TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(operation_id, sequence)) WITHOUT ROWID, STRICT;
        CREATE TABLE events (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, writer TEXT NOT NULL, sequence INTEGER NOT NULL, revision INTEGER NOT NULL) STRICT;
        COMMIT;`)
    } finally { database.close() }
  }

  private write(database: DatabaseSync, changes: BrowserOperationJournalChanges): void {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare('INSERT INTO writers(id) VALUES (?) ON CONFLICT(id) DO NOTHING').run(changes.writer)
      const operation = database.prepare('INSERT INTO operations(id, metadata, writer, revision) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET metadata = excluded.metadata, writer = excluded.writer, revision = excluded.revision WHERE (SELECT ordinal FROM writers WHERE id = operations.writer) < (SELECT ordinal FROM writers WHERE id = excluded.writer) OR (operations.writer = excluded.writer AND operations.revision < excluded.revision)')
      const step = database.prepare('INSERT INTO steps(operation_id, sequence, body, writer, revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT(operation_id, sequence) DO UPDATE SET body = excluded.body, writer = excluded.writer, revision = excluded.revision WHERE (SELECT ordinal FROM writers WHERE id = steps.writer) < (SELECT ordinal FROM writers WHERE id = excluded.writer) OR (steps.writer = excluded.writer AND steps.revision < excluded.revision)')
      for (const changed of changes.operations) {
        operation.run(changed.metadata.id, JSON.stringify(changed.metadata), changes.writer, changes.revision)
        for (const changedStep of changed.steps) step.run(changed.metadata.id, changedStep.sequence, JSON.stringify(changedStep), changes.writer, changes.revision)
      }
      const event = database.prepare('INSERT INTO events(id, body, writer, sequence, revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, writer = excluded.writer, revision = excluded.revision WHERE (SELECT ordinal FROM writers WHERE id = events.writer) < (SELECT ordinal FROM writers WHERE id = excluded.writer) OR (events.writer = excluded.writer AND events.revision < excluded.revision)')
      for (const changedEvent of changes.events) event.run(changedEvent.id, JSON.stringify(changedEvent.event), changes.writer, changedEvent.sequence, changes.revision)
      database.prepare('DELETE FROM events WHERE ordinal NOT IN (SELECT events.ordinal FROM events JOIN writers ON writers.id = events.writer ORDER BY writers.ordinal DESC, events.sequence DESC LIMIT ?)').run(changes.maxEvents)
      database.exec('COMMIT')
    } catch (error) {
      // A failed COMMIT may have an unknown durability result. Retry only these same immutable
      // identities; operation/step upserts are idempotent and no Browser action is replayed.
      try { database.exec('ROLLBACK') } catch { /* Preserve the original storage failure. */ }
      throw error
    }
  }

  private async convertOriginal(): Promise<void> {
    const original = await readFile(this.path)
    const parsed = JSON.parse(original.toString('utf8')) as BrowserOperationJournalDocument
    if (parsed.version !== BROWSER_OPERATION_JOURNAL_VERSION || !Array.isArray(parsed.operations) || !Array.isArray(parsed.events)) {
      throw new Error('Original Browser journal is damaged.')
    }
    const temporary = `${this.path}.${mintObjectId()}.sqlite`
    try {
      await this.initialize(temporary)
      const database = this.database(temporary)
      try {
        this.write(database, {
          writer: 'original', revision: 0,
          operations: parsed.operations.map(({ steps, ...metadata }) => ({ metadata, steps })),
          events: parsed.events.map((event, index) => ({ id: `original:${index}`, sequence: index + 1, event })), maxEvents: Math.max(1, parsed.events.length)
        })
      } finally { database.close() }
      const digest = createHash('sha256').update(original).digest('hex')
      await durableWriteFile(`${this.path}.original-${digest}.json`, original, { requireDirectorySync: true })
      // The archive is durable before replacement. No fallback or second writer survives cutover.
      await rename(temporary, this.path)
      await chmod(this.path, 0o600)
      const directory = await open(dirname(this.path), 'r')
      try { await directory.sync() } finally { await directory.close() }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
}
