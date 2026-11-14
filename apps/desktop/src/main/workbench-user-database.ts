import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { durableWriteFile, DurableWriteError, snapshotRecoverySqlite } from '@agentmux/core'
import { parseWorkbenchInputQueueDelta, workbenchInputArchiveEligible,
  type WorkbenchInputArchivePage, type WorkbenchInputArchiveQuery, type WorkbenchInputQueueDelta, type WorkbenchUserStateReceipt } from '../shared/workbench-user-state.js'
import { recoveryUnavailable } from './workbench-recovery-restore.js'

type JsonObject = Record<string, unknown>
type Document = JsonObject & { state: JsonObject; version: number; inputQueueDelta?: WorkbenchInputQueueDelta }
type ArchiveReceipt = Pick<WorkbenchUserStateReceipt, 'inputQueueArchiveOwners' | 'inputQueueArchived'>
type Metadata = { incarnation: string; contentDigest: string; sizeBytes: number } & ArchiveReceipt
const applicationId = 0x414d5857
const version = 1
const draftFields = ['agentComposerDrafts', 'agentComposerNotes']
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const issue = (message: string, code: string) => Object.assign(new Error(message), { code })
const unavailable = () => issue('The original Desktop database is missing or has changed. Restore its original data before saving.', 'WORKBENCH_USER_DATABASE_UNAVAILABLE')
const invalid = () => issue('Desktop user state must have the original document and input queue request shape. Original data is retained.', 'WORKBENCH_USER_STATE_INVALID')
const operationKey = (id: string) => 'operation:' + id

export function decodeWorkbenchUserState(value: unknown): Document {
  if (typeof value !== 'string') throw invalid()
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw invalid() }
  if (!object(parsed) || !object(parsed.state) || typeof parsed.version !== 'number' || !Number.isFinite(parsed.version)) throw invalid()
  const delta = parsed.inputQueueDelta
  if (delta !== undefined) {
    if (Object.hasOwn(parsed.state, 'agentSteerQueues')) throw invalid()
    parseWorkbenchInputQueueDelta(delta)
  }
  return parsed as Document
}

export function workbenchUserDatabasePath(path: string): string {
  return extname(path) === '.json' ? path.slice(0, -'.json'.length) + '.sqlite' : path + '.sqlite'
}

async function syncFile(path: string): Promise<void> {
  const file = await open(path, 'r')
  try { await file.sync() } finally { await file.close() }
}

function transaction<T>(database: DatabaseSync, change: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = change()
    database.exec('COMMIT')
    return result
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK')
    throw error
  }
}

function createSchema(database: DatabaseSync, incarnation: string): void {
  database.exec(`PRAGMA application_id = ${applicationId};
    PRAGMA user_version = ${version};
    CREATE TABLE metadata (
      id INTEGER PRIMARY KEY CHECK(id = 1), incarnation TEXT NOT NULL, content_digest TEXT NOT NULL, size_bytes INTEGER NOT NULL, archive_receipt TEXT
    ) STRICT;
    CREATE TABLE document_rows (
      scope TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope, name)
    ) WITHOUT ROWID, STRICT;
    CREATE TABLE input_queue (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, key TEXT NOT NULL, operation_id TEXT, position INTEGER NOT NULL,
      cold INTEGER NOT NULL CHECK(cold IN (0,1)), enqueued_at REAL NOT NULL, body TEXT NOT NULL, UNIQUE(owner, key)
    ) STRICT;
    CREATE INDEX input_owner_operation ON input_queue (owner, operation_id);
    CREATE INDEX input_hot ON input_queue (owner, position, ordinal) WHERE cold = 0 AND operation_id IS NOT NULL;
    CREATE INDEX input_archive ON input_queue (enqueued_at DESC, ordinal DESC) WHERE cold = 1;
    CREATE INDEX input_archive_owner ON input_queue (owner, enqueued_at DESC, ordinal DESC) WHERE cold = 1;
    CREATE INDEX input_archive_operation ON input_queue (owner, operation_id, enqueued_at DESC, ordinal DESC) WHERE cold = 1;`)
  database.prepare('INSERT INTO metadata VALUES (1, ?, ?, 0, NULL)').run(incarnation, digest(''))
}

function metadata(database: DatabaseSync): Metadata {
  const row = database.prepare('SELECT incarnation, content_digest, size_bytes, archive_receipt FROM metadata WHERE id = 1').get()
  if (typeof row?.incarnation !== 'string' || typeof row.content_digest !== 'string' || typeof row.size_bytes !== 'number') throw unavailable()
  return { incarnation: row.incarnation, contentDigest: row.content_digest, sizeBytes: row.size_bytes,
    ...(typeof row.archive_receipt === 'string' ? JSON.parse(row.archive_receipt) as ArchiveReceipt : {}) }
}

function databaseAt(path: string, incarnation?: string): DatabaseSync {
  const url = pathToFileURL(path)
  url.searchParams.set('mode', 'rw')
  const database = new DatabaseSync(url)
  try {
    database.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = EXTRA; PRAGMA trusted_schema = OFF')
    if (database.prepare('PRAGMA application_id').get()?.application_id !== applicationId ||
        database.prepare('PRAGMA user_version').get()?.user_version !== version ||
        incarnation !== undefined && metadata(database).incarnation !== incarnation) throw unavailable()
    return database
  } catch (error) { database.close(); throw error }
}

function selectedRows(database: DatabaseSync, scope: string): JsonObject {
  const rows = database.prepare('SELECT name, body FROM document_rows WHERE scope = ?').all(scope)
  return Object.fromEntries(rows.map(row => [String(row.name), JSON.parse(String(row.body))]))
}

function currentDocument(database: DatabaseSync): Document {
  const top = selectedRows(database, 'top')
  const state = selectedRows(database, 'state')
  const sections = selectedRows(database, 'sections')
  for (const field of draftFields) if (sections[field] === true) state[field] = selectedRows(database, field)
  if (sections.desktopFragments === true) top.desktopFragments = selectedRows(database, 'desktopFragments')
  if (sections.agentSteerQueues === true) {
    const queues = new Map<string, unknown[]>()
    for (const row of database.prepare('SELECT owner, body FROM input_queue WHERE cold = 0 AND operation_id IS NOT NULL ORDER BY owner, position, ordinal').all()) {
      const owner = String(row.owner)
      const entries = queues.get(owner) ?? []
      entries.push(JSON.parse(String(row.body)))
      queues.set(owner, entries)
    }
    state.agentSteerQueues = Object.fromEntries(queues)
  }
  const document = { ...top, state }
  if (typeof top.version !== 'number') throw unavailable()
  return document as Document
}

function replaceRows(database: DatabaseSync, scope: string, values: JsonObject): void {
  const prior = database.prepare('SELECT name FROM document_rows WHERE scope = ?').all(scope)
  const remove = database.prepare('DELETE FROM document_rows WHERE scope = ? AND name = ?')
  for (const row of prior) if (!Object.hasOwn(values, String(row.name))) remove.run(scope, row.name!)
  const put = database.prepare(`INSERT INTO document_rows (scope, name, body) VALUES (?, ?, ?)
    ON CONFLICT(scope,name) DO UPDATE SET body = excluded.body WHERE body <> excluded.body`)
  for (const [name, value] of Object.entries(values)) put.run(scope, name, JSON.stringify(value))
}

function writeInputQueues(database: DatabaseSync, queues: JsonObject | undefined, delta: WorkbenchInputQueueDelta | undefined): ArchiveReceipt {
  const put = database.prepare(`INSERT INTO input_queue (owner, key, operation_id, position, cold, enqueued_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner,key) DO UPDATE SET position = excluded.position, cold = excluded.cold,
      enqueued_at = excluded.enqueued_at, body = excluded.body
    WHERE position <> excluded.position OR cold <> excluded.cold OR enqueued_at <> excluded.enqueued_at OR body <> excluded.body`)
  const writeEntry = (owner: string, key: string, operationId: string | null, position: number, entry: unknown) => {
    const enqueuedAt = object(entry) && typeof entry.enqueuedAt === 'number' && Number.isFinite(entry.enqueuedAt) ? entry.enqueuedAt : 0
    const cold = operationId !== null && key === operationKey(operationId) && workbenchInputArchiveEligible(entry)
    put.run(owner, key, operationId, position, cold ? 1 : 0, enqueuedAt, JSON.stringify(entry))
    return cold
  }
  if (delta === undefined) {
    database.exec('DELETE FROM input_queue')
    const legacyQueues: JsonObject = Object.create(null)
    for (const [owner, entries] of Object.entries(queues ?? {})) {
      if (!Array.isArray(entries) || !entries.length) { legacyQueues[owner] = entries; continue }
      const seen = new Set<string>(), repeated = new Set<string>()
      for (const entry of entries) if (object(entry) && typeof entry.operationId === 'string') {
        if (seen.has(entry.operationId)) repeated.add(entry.operationId)
        seen.add(entry.operationId)
      }
      for (const [position, entry] of entries.entries()) {
        const operationId = object(entry) && typeof entry.operationId === 'string' && entry.operationId.length > 0 ? entry.operationId : null
        // Keep every original old record; an ambiguous identity has no new write key.
        const exact = operationId !== null && !operationId.includes('\0') && !repeated.has(operationId)
        writeEntry(owner, exact ? operationKey(operationId) : 'legacy:' + position, operationId, position, entry)
      }
    }
    replaceRows(database, 'legacyQueues', legacyQueues)
    return {}
  }
  if (delta.clear) {
    database.exec('DELETE FROM input_queue')
    replaceRows(database, 'legacyQueues', {})
  }
  const remove = database.prepare('DELETE FROM input_queue WHERE owner = ? AND key = ?')
  const order = database.prepare('UPDATE input_queue SET position = ? WHERE owner = ? AND key = ? AND position <> ?')
  const isCold = database.prepare('SELECT cold FROM input_queue WHERE owner = ? AND key = ?')
  const ambiguous = database.prepare("SELECT 1 FROM input_queue WHERE owner = ? AND operation_id = ? AND key <> ? LIMIT 1")
  const checkAddress = (owner: string, id: string) => {
    const key = operationKey(id)
    if (ambiguous.get(owner, id, key)) throw issue(
      'Multiple saved inputs share this original operation. Their original records are retained.', 'WORKBENCH_INPUT_OPERATION_AMBIGUOUS')
    return key
  }
  const archiveOwners = new Set<string>()
  const archived: NonNullable<ArchiveReceipt['inputQueueArchived']> = []
  for (const change of delta.changes) {
    for (const operationId of change.remove) {
      const key = checkAddress(change.ownerKey, operationId)
      if (isCold.get(change.ownerKey, key)?.cold === 1) archiveOwners.add(change.ownerKey)
      remove.run(change.ownerKey, key)
    }
    const positions = new Map(change.order.map((id, index) => [id, index]))
    for (const update of change.upsert) {
      const key = checkAddress(change.ownerKey, update.operationId), wasCold = isCold.get(change.ownerKey, key)?.cold === 1
      const cold = writeEntry(change.ownerKey, key, update.operationId, positions.get(update.operationId)!, update.entry)
      if (cold || wasCold) archiveOwners.add(change.ownerKey)
      if (cold) archived.push({ ownerKey: change.ownerKey, operationId: update.operationId })
    }
    for (const [operationId, position] of positions) order.run(position, change.ownerKey, operationKey(operationId), position)
  }
  return { ...(delta.clear ? { inputQueueArchiveOwners: null } : archiveOwners.size ? { inputQueueArchiveOwners: [...archiveOwners] } : {}),
    ...(archived.length ? { inputQueueArchived: archived } : {}) }
}

function writeDocument(database: DatabaseSync, value: string, document: Document): Metadata {
  const { state: original, inputQueueDelta: delta, ...top } = document
  const state = { ...original }
  const sections = selectedRows(database, 'sections')
  for (const field of draftFields) {
    if (object(state[field])) {
      replaceRows(database, field, state[field])
      sections[field] = true
      delete state[field]
    } else {
      replaceRows(database, field, {})
      delete sections[field]
    }
  }
  if (object(top.desktopFragments)) {
    replaceRows(database, 'desktopFragments', top.desktopFragments)
    sections.desktopFragments = true
    delete top.desktopFragments
  } else {
    replaceRows(database, 'desktopFragments', {})
    delete sections.desktopFragments
  }
  if (delta !== undefined) {
    if (delta.clear) delete sections.agentSteerQueues
    if (delta.changes.some(change => change.order.length > 0)) sections.agentSteerQueues = true
  } else if (object(state.agentSteerQueues)) {
    sections.agentSteerQueues = true
    delete state.agentSteerQueues
  } else delete sections.agentSteerQueues
  replaceRows(database, 'top', top)
  replaceRows(database, 'state', state)
  replaceRows(database, 'sections', sections)
  const archiveReceipt = writeInputQueues(database, object(original.agentSteerQueues) ? original.agentSteerQueues : undefined, delta)
  database.prepare('UPDATE metadata SET content_digest = ?, size_bytes = ?, archive_receipt = ? WHERE id = 1')
    .run(digest(value), Buffer.byteLength(value), Object.keys(archiveReceipt).length ? JSON.stringify(archiveReceipt) : null)
  return metadata(database)
}

function hasArchive(database: DatabaseSync): boolean {
  return database.prepare('SELECT 1 FROM input_queue WHERE cold = 1 LIMIT 1').get() !== undefined
}

/** One native database serves live intent, archived records, and the save receipt under the same transaction. */
export class WorkbenchUserDatabase {
  readonly path: string
  private incarnation: string | undefined
  private readonly witness: string

  constructor(private readonly legacyPath: string, private readonly syncDirectory: (path: string) => Promise<void> = syncFile) {
    this.path = workbenchUserDatabasePath(legacyPath)
    this.witness = this.path + '.identity'
  }

  async presence(): Promise<'database' | 'legacy' | 'missing'> {
    try {
      if (!(await lstat(this.path)).isFile()) throw unavailable()
      return 'database'
    } catch (error) {
      if (!missing(error)) throw error
    }
    if (await this.acknowledged()) throw unavailable()
    try {
      if (!(await lstat(this.legacyPath)).isFile()) throw unavailable()
      return 'legacy'
    } catch (error) {
      if (!missing(error)) throw error
    }
    return 'missing'
  }

  async fileStamp(): Promise<string> {
    const stat = await lstat(this.path, { bigint: true })
    if (!stat.isFile()) throw unavailable()
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
  }

  async acknowledged(): Promise<string | undefined> {
    if (this.incarnation !== undefined) return this.incarnation
    let value: string
    try { value = (await readFile(this.witness, 'utf8')).trim() }
    catch (error) { if (missing(error)) return undefined; throw error }
    if (!/^[a-f0-9-]{36}$/.test(value)) throw unavailable()
    this.incarnation = value
    return value
  }

  private async confirm(incarnation: string): Promise<void> {
    if (this.incarnation === incarnation) return
    await syncFile(this.path)
    await this.syncDirectory(dirname(this.path))
    await durableWriteFile(this.witness, incarnation + '\n', { mode: 0o600, requireDirectorySync: true })
    this.incarnation = incarnation
  }

  private async use<T>(action: (database: DatabaseSync) => T): Promise<T> {
    const expected = await this.acknowledged()
    const database = databaseAt(this.path, expected)
    try { return action(database) } finally { database.close() }
  }

  async read(): Promise<{ value: string; metadata: Metadata }> {
    return this.use(database => {
      database.exec('BEGIN')
      const result = { value: JSON.stringify(currentDocument(database)), metadata: metadata(database) }
      database.exec('COMMIT')
      return result
    })
  }

  async confirmCurrent(): Promise<Metadata> {
    const result = await this.readMetadata()
    await syncFile(this.path)
    await this.confirm(result.incarnation)
    return result
  }

  readMetadata(): Promise<Metadata> {
    return this.use(metadata)
  }

  async write(value: string, document: Document): Promise<Metadata> {
    let repeated = false
    const result = await this.use(database => transaction(database, () => {
      const previous = metadata(database)
      if (previous.contentDigest === digest(value) && previous.sizeBytes === Buffer.byteLength(value)) {
        repeated = true
        return previous
      }
      // Full originals may initialize or replace a complete document. A hot
      // projection can never claim that separately retained archives vanished.
      if (document.inputQueueDelta === undefined && hasArchive(database)) throw issue(
        'A complete original document is required to replace existing archived records. Original data is retained.', 'WORKBENCH_INPUT_ARCHIVE_REPLACE')
      return writeDocument(database, value, document)
    }))
    try {
      if (repeated) await syncFile(this.path)
      await this.confirm(result.incarnation)
    }
    catch (error) { throw new DurableWriteError(this.path, 'after-replace', error) }
    return result
  }

  async create(value: string, document: Document, original?: string): Promise<Metadata> {
    const candidate = this.path + '.' + randomUUID() + '.candidate'
    let published = false
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      if (original !== undefined) await durableWriteFile(this.legacyPath + '.original-' + digest(original) + '.json', original,
        { mode: 0o600, requireDirectorySync: true })
      const reservation = await open(candidate, 'wx', 0o600)
      await reservation.close()
      const database = new DatabaseSync(candidate)
      let result
      try {
        database.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA; PRAGMA trusted_schema = OFF')
        result = transaction(database, () => {
          createSchema(database, randomUUID())
          return writeDocument(database, value, document)
        })
      } finally { database.close() }
      await syncFile(candidate)
      if (original !== undefined && await readFile(this.legacyPath, 'utf8') !== original) throw unavailable()
      // The candidate is complete before publication, and a competing
      // database can never be displaced by another first import.
      await link(candidate, this.path)
      published = true
      await this.confirm(result.incarnation)
      return result
    } catch (error) {
      throw new DurableWriteError(this.path, published ? 'after-replace' : 'before-replace', error)
    } finally {
      await unlink(candidate).catch(error => { if (!missing(error)) throw error })
    }
  }

  async readInputArchive(query: WorkbenchInputArchiveQuery): Promise<WorkbenchInputArchivePage> {
    const { ownerKey, operationId, after, limit = 50 } = query
    let cursor: { enqueuedAt: number; ordinal: number } | undefined
    if (after !== undefined) {
      let value: unknown
      try { value = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')) } catch { throw invalid() }
      if (!Array.isArray(value) || value.length !== 4 || value[0] !== (ownerKey ?? null) || value[1] !== (operationId ?? null) ||
        !Number.isFinite(value[2]) || !Number.isSafeInteger(value[3]) || value[3] < 1) throw invalid()
      cursor = { enqueuedAt: value[2], ordinal: value[3] }
    }
    return this.use(database => {
      const where = ['cold = 1']
      const params: (string | number)[] = []
      if (ownerKey !== undefined) { where.push('owner = ?'); params.push(ownerKey) }
      if (operationId !== undefined) { where.push('operation_id = ?'); params.push(operationId) }
      if (cursor) { where.push('(enqueued_at, ordinal) < (?, ?)'); params.push(cursor.enqueuedAt, cursor.ordinal) }
      const rows = database.prepare('SELECT owner, body, enqueued_at, ordinal FROM input_queue WHERE ' + where.join(' AND ') +
        ' ORDER BY enqueued_at DESC, ordinal DESC LIMIT ?').all(...params, limit + 1)
      const last = rows[limit - 1]
      const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify(
        [ownerKey ?? null, operationId ?? null, last.enqueued_at, last.ordinal])).toString('base64url') : null
      return { entries: rows.slice(0, limit).map(row => ({ ownerKey: String(row.owner), entry: JSON.parse(String(row.body)) })), nextCursor }
    })
  }

  async capture(destination: string): Promise<string> {
    const { incarnation } = await this.readMetadata()
    await snapshotRecoverySqlite(this.path, destination)
    const snapshot = databaseAt(destination, incarnation)
    try { return metadata(snapshot).contentDigest } finally { snapshot.close() }
  }
}

export function isWorkbenchUserDatabase(bytes: Buffer): boolean {
  return bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))
}

/** Recovery freezes prior user intents in a private candidate, before the original owner publishes it. */
export async function holdRecoveredWorkbenchDatabase(bytes: Buffer, expected?: string): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'amux-workbench-restore-'))
  const path = join(directory, 'document.sqlite')
  try {
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
    const database = databaseAt(path, expected)
    try {
      transaction(database, () => {
        const row = database.prepare("SELECT body FROM document_rows WHERE scope = 'state' AND name = 'pendingAgentLaunches'").get()
        if (row) {
          const launches = JSON.parse(String(row.body))
          if (!object(launches)) throw recoveryUnavailable('DESKTOP_RECOVERY_PENDING_LAUNCH_UNCONFIRMED')
          if (Object.keys(launches).length) throw Object.assign(
            recoveryUnavailable('DESKTOP_RECOVERY_PENDING_LAUNCH_UNCONFIRMED'), { agentSessionIds: Object.keys(launches) })
        }
        const hold = database.prepare('UPDATE input_queue SET body = ? WHERE ordinal = ?')
        let changed = false
        for (const row of database.prepare('SELECT ordinal, body FROM input_queue WHERE operation_id IS NOT NULL').all()) {
          const entry = JSON.parse(String(row.body))
          if (!object(entry)) throw recoveryUnavailable('DESKTOP_RECOVERY_QUEUE_INVALID')
          if (entry.awaitingExplicitSend === true) continue
          hold.run(JSON.stringify({ ...entry, awaitingExplicitSend: true }), row.ordinal!)
          changed = true
        }
        if (changed) {
          const current = JSON.stringify(currentDocument(database))
          database.prepare('UPDATE metadata SET content_digest = ?, size_bytes = ?, archive_receipt = NULL WHERE id = 1')
            .run(digest(current), Buffer.byteLength(current))
        }
      })
    } finally { database.close() }
    return await readFile(path)
  } finally { await rm(directory, { recursive: true, force: true }) }
}
