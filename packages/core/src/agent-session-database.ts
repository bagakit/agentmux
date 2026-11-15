import { mintObjectId } from './object-id.js'
import { createHash } from 'node:crypto'
import { lstatSync, readlinkSync } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readFile, readdir, readlink, rename, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { durableWriteFile } from './durable-write.js'
import { immutableIdentityFile } from './immutable-identity-file.js'

const applicationId = 0x414d5353
const sqliteHeader = Buffer.from('SQLite format 3\0')
const legacyFileName = 'agent-sessions.json'
const sqliteFileName = 'agent-sessions.sqlite'

export function canonicalSessionFile(path: string): string | undefined {
  if (basename(path) === legacyFileName) return join(dirname(path), sqliteFileName)
}

export function logicalSessionDatabasePath(path: string): string {
  if (basename(path) !== sqliteFileName) return path
  const legacy = join(dirname(path), legacyFileName)
  try {
    const original = lstatSync(legacy, { bigint: true })
    if (original.isSymbolicLink()) return readlinkSync(legacy) === sqliteFileName ? legacy : path
    if (!original.isFile()) return path
    // Both regular entries can refer to the original inode after an interrupted migration.
    const canonical = lstatSync(path, { bigint: true })
    return canonical.isFile() && canonical.dev === original.dev && canonical.ino === original.ino ? legacy : path
  } catch (error) {
    if (['ENOENT', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) return path
    throw error
  }
}

async function sessionFileInfo(path: string) {
  try { return await lstat(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

/** Preserve the configured path, the stable writer lock, and every old recovery target. */
export async function sessionDatabaseFile(path: string): Promise<string> {
  const canonical = canonicalSessionFile(path)
  if (canonical && (await sessionFileInfo(path))?.isSymbolicLink() && await readlink(path) === sqliteFileName) return canonical
  return path
}

export async function hasLegacySessionDatabaseName(path: string): Promise<boolean> {
  return canonicalSessionFile(path) !== undefined && (await sessionFileInfo(path))?.isFile() === true
}

export async function sessionDatabaseRestoreFile(path: string): Promise<string | null> {
  const target = await sessionDatabaseFile(path)
  const canonical = canonicalSessionFile(path)
  // An absent alias is not proof the original database was lost.
  if (target === path && canonical && !await sessionFileInfo(path) && await sessionFileInfo(canonical)) return null
  return target
}

/** Caller holds the original Store flock. Publish an alias without copying the database. */
export async function migrateSessionDatabaseFile(
  path: string, importOriginal: (db: DatabaseSync, raw: Buffer) => void
): Promise<void> {
  const canonical = canonicalSessionFile(path)
  if (!canonical) return
  if (await sessionDatabaseFile(path) === canonical) {
    const db = await readCurrentSessionDatabase(path, { readOnly: true })
    if (!db) throw new Error('The renamed Session database is unavailable.')
    db.close()
    await syncSessionDatabase(canonical)
    return
  }
  const source = await sessionFileInfo(path)
  if (!source?.isFile()) throw new Error('The original Session database is unavailable.')
  const existing = await sessionFileInfo(canonical)
  if (existing && (!existing.isFile() || existing.ino !== source.ino || existing.dev !== source.dev))
    throw new Error('Both Session filenames contain different files. Both were kept.')

  const db = await openSessionDatabase(path, importOriginal)
  const alias = `${path}.${mintObjectId()}.link`
  try {
    // SQLite also fences readers outside the Store flock. A read or rollback
    // journal must not straddle changing which filename owns the journal.
    db.exec('BEGIN EXCLUSIVE')
    for (const suffix of ['-journal', '-wal', '-shm']) {
      if (await sessionFileInfo(path + suffix) || await sessionFileInfo(canonical + suffix))
        throw new Error('The Session database has an active SQLite sidecar. Try again later.')
    }
    if (!existing) await link(path, canonical)
    await syncSessionFile(dirname(path))
    await symlink(sqliteFileName, alias)
    await rename(alias, path)
    await syncSessionFile(dirname(path))
  } finally {
    try { db.close() } finally {
      await unlink(alias).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    }
  }
}
export const closedCreationSchema = `CREATE TABLE IF NOT EXISTS closed_creations (
  id TEXT PRIMARY KEY, creation_operation TEXT NOT NULL UNIQUE, json TEXT NOT NULL);`
/** Only the original v1 namespace can initialize this formerly nonexistent history.
 * The caller owns the original transaction; acknowledged v2/v3 history is never rebuilt. */
export function initializeLegacyClosedCreationSchema(db: DatabaseSync): boolean {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 1) return false
  db.exec(closedCreationSchema)
  db.exec('PRAGMA user_version = 2')
  return true
}
export const scheduledIntentColumn = "json_extract(json,'$.admission.futureIntent.intentId')"
export const scheduledTimeColumn = "json_extract(json,'$.admission.futureIntent.occurrenceAt')"
export const scheduledOccurrenceIndexSchema = `CREATE INDEX IF NOT EXISTS scheduled_input_occurrence
  ON prompt_admissions(session_id, ${scheduledIntentColumn}, ${scheduledTimeColumn}, run_id, record_id)
  WHERE ${scheduledIntentColumn} IS NOT NULL;`
export const promptAdmissionSchema = `CREATE TABLE IF NOT EXISTS prompt_admissions (
  session_id TEXT NOT NULL, run_id TEXT NOT NULL, record_id TEXT NOT NULL,
  json TEXT NOT NULL, PRIMARY KEY(session_id, run_id, record_id));`
export const retiredCreationIndexSchema = `CREATE INDEX IF NOT EXISTS retired_creation_operation
  ON retired_sessions(json_extract(json,'$.history.creation.createOperationId'));`
/** Two current Sessions can never claim one terminal prompt operation; SQLite enforces it per row. */
export const promptSubmissionIndexSchema = `CREATE UNIQUE INDEX IF NOT EXISTS terminal_prompt_submission
  ON sessions(json_extract(json,'$.terminalPromptSubmission.submissionId'))
  WHERE json_extract(json,'$.terminalPromptSubmission.submissionId') IS NOT NULL;`
const schema = `
  PRAGMA application_id = ${applicationId};
  PRAGMA user_version = 2;
  CREATE TABLE identity (incarnation TEXT NOT NULL, original_hash TEXT);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, json TEXT NOT NULL, future_present INTEGER NOT NULL,
    creation_operation TEXT);
  CREATE INDEX creation_operation ON sessions(creation_operation);
  CREATE TABLE future_intents (session_id TEXT NOT NULL, intent_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(session_id, intent_id));
  CREATE UNIQUE INDEX future_order ON future_intents(session_id, ordinal);
  CREATE TABLE reservations (id TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE retired_runs (id TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE retired_sessions (id TEXT PRIMARY KEY, json TEXT NOT NULL);
  ${retiredCreationIndexSchema}
  ${promptSubmissionIndexSchema}
  CREATE TABLE run_bindings (run_id TEXT PRIMARY KEY, session_id TEXT);
  CREATE INDEX session_runs ON run_bindings(session_id);
  CREATE TABLE native_bindings (native_key TEXT PRIMARY KEY, session_id TEXT NOT NULL);
  CREATE INDEX session_natives ON native_bindings(session_id);
  ${promptAdmissionSchema}
  ${scheduledOccurrenceIndexSchema}
  ${closedCreationSchema}
`

/** File/directory confirmation also covers an earlier commit whose durability ACK was lost. */
export async function syncSessionDatabase(path: string): Promise<void> {
  await syncSessionFile(path)
  await syncSessionFile(dirname(path))
}

async function syncSessionFile(path: string): Promise<void> {
  const handle = await open(path, 'r')
  let failure: unknown
  try { await handle.sync() } catch (error) { failure = error }
  try { await handle.close() } catch (error) {
    failure = failure === undefined ? error : Object.assign(new Error('Session sync and cleanup failed.', { cause: failure }), { cleanup: error })
  }
  if (failure !== undefined) throw failure
}

export function configureSessionDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA')
}

async function prefix(path: string): Promise<Buffer | null> {
  let handle
  try { handle = await open(path, 'r') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const value = Buffer.alloc(16)
    const result = await handle.read(value, 0, 16, 0)
    return value.subarray(0, result.bytesRead)
  } finally { await handle.close() }
}

async function marker(path: string): Promise<string | null> {
  const read = async (target: string) => {
    try { return await readFile(target, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const current = await read(`${path}.sqlite-identity`)
  if (current !== null && !/^[A-Za-z0-9_-]+$/u.test(current)) throw new Error('The original Session incarnation is unreadable.')
  let original: string | null
  try {
    original = await read(`${path}.sqlite-identity.original`)
    if (original !== null && !/^[A-Za-z0-9_-]+$/u.test(original)) throw new Error('The recovery incarnation is unreadable.')
  } catch (error) {
    if (current === null) throw error
    process.emitWarning('The original Session incarnation remains readable, but its recovery copy is unavailable. Keep the database and retry storage recovery.', { code: 'SESSION_INCARNATION_RECOVERY_UNAVAILABLE' })
    return current
  }
  if (original !== null && current !== null && current !== original)
    throw new Error('The Session incarnation contradicts its retained original. Keep both sources and restore the original database.')
  return current ?? original
}

async function assertNewDatabaseNamespace(path: string): Promise<void> {
  let names: string[]
  try { names = await readdir(dirname(path)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const prefix = basename(path) + '.original-'
  if (names.includes(basename(path) + '.sqlite-identity.original') ||
      canonicalSessionFile(path) !== undefined && names.includes(sqliteFileName) && await sessionDatabaseFile(path) === path ||
      names.some(name => name.startsWith(prefix) && /^[a-f0-9]{64}$/u.test(name.slice(prefix.length)))) throw new Error(
    'This used Session namespace lost its database and acknowledgement. Its original archive was retained; inspect or restore the original owner instead of initializing an empty catalog.')
}

async function confirmOriginalIncarnation(path: string, incarnation: string): Promise<void> {
  const identity = await immutableIdentityFile(`${path}.sqlite-identity`, {
    parse: bytes => { if (!/^[A-Za-z0-9_-]+$/u.test(bytes)) throw new Error('Invalid original Session incarnation.'); return bytes },
    create: () => incarnation, encode: value => value,
    onRecoveryIssue: issue => process.emitWarning('The original Session database remains usable, but incarnation recovery custody is unavailable. Retry storage recovery without replacing the database.', { code: issue.code })
  })
  if (identity !== incarnation) throw new Error('The original Session incarnation changed. Retain both sources and restore the original database.')
}

function validate(db: DatabaseSync, acknowledged: string | null): string {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId ||
    ![1, 2, 3].includes(Number(db.prepare('PRAGMA user_version').get()?.user_version))) throw new Error('Not an AgentMux Session database.')
  const incarnation = db.prepare('SELECT incarnation FROM identity').get()?.incarnation
  if (typeof incarnation !== 'string' || acknowledged !== null && acknowledged !== incarnation) {
    throw new Error('The acknowledged Session database identity changed. Restore its original file; no facts have been re-imported.')
  }
  return incarnation
}

function closeAfterFailure(db: DatabaseSync, failure: unknown): never {
  try { db.close() } catch (cleanup) {
    if (failure instanceof Error) Object.defineProperty(failure, 'cleanup', { value: [cleanup], configurable: true })
    else throw Object.assign(new Error(String(failure), { cause: failure }), { cleanup: [cleanup] })
  }
  throw failure
}

/** Current reads never take the old writer lock or read retained future bodies. */
export async function readCurrentSessionDatabase(path: string, options?: { readOnly?: boolean }): Promise<DatabaseSync | null> {
  const acknowledged = await marker(path)
  // Open the stable logical path once. SQLite resolves the managed symlink to
  // the same physical path used by its rollback journal.
  const header = await prefix(path)
  if (!header?.equals(sqliteHeader)) {
    if (acknowledged !== null) throw new Error('The acknowledged Session database was removed or replaced. Restore its original file.')
    if (header === null) await assertNewDatabaseNamespace(path)
    return null
  }
  // A killed cutover may have published SQLite before its marker ACK. Read the complete
  // transaction in place; the next writer confirms the marker under the original lock.
  // Treating this file as legacy JSON would fabricate an empty salvage result.
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path, { readOnly: options?.readOnly ?? false })
  try { db.exec('PRAGMA busy_timeout = 0'); validate(db, acknowledged); return db }
  catch (error) { return closeAfterFailure(db, error) }
}

/** One-time lossless physical cutover, exclusively under the original stable-inode flock. */
export async function openSessionDatabase(
  path: string, importOriginal: (db: DatabaseSync, raw: Buffer) => void
): Promise<DatabaseSync> {
  const { DatabaseSync } = await import('node:sqlite')
  const acknowledged = await marker(path)
  const header = await prefix(path)
  if (header?.equals(sqliteHeader)) {
    const db = new DatabaseSync(path)
    try {
      await chmod(path, 0o600); configureSessionDatabase(db)
      const incarnation = validate(db, acknowledged)
      if (acknowledged === null) {
        await syncSessionDatabase(path)
        await confirmOriginalIncarnation(path, incarnation)
      }
      else await confirmOriginalIncarnation(path, incarnation)
      return db
    } catch (error) { return closeAfterFailure(db, error) }
  }
  if (acknowledged !== null) throw new Error('The acknowledged Session database was removed or replaced; re-import would lose original facts.')
  if (header === null) await assertNewDatabaseNamespace(path)
  let raw: Buffer | undefined
  let hash: string | null = null
  if (header !== null) {
    raw = await readFile(path)
    hash = createHash('sha256').update(raw).digest('hex')
    const archive = `${path}.original-${hash}`
    // durableWriteFile publishes only complete archives. An interrupted write leaves the source intact.
    await durableWriteFile(archive, raw, { mode: 0o600, requireDirectorySync: true })
  }
  const candidate = `${path}.${process.pid}.${mintObjectId()}.tmp`
  const incarnation = mintObjectId()
  let db: DatabaseSync | undefined
  let published = false
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const canonical = canonicalSessionFile(path)
    if (header === null && canonical && !await sessionFileInfo(path) && !await sessionFileInfo(canonical))
      await symlink(sqliteFileName, path)
    const databaseFile = await sessionDatabaseFile(path)
    const reservation = await open(candidate, 'wx', 0o600); await reservation.close()
    db = new DatabaseSync(candidate)
    configureSessionDatabase(db); db.exec('BEGIN IMMEDIATE'); db.exec(schema)
    db.prepare('INSERT INTO identity VALUES (?, ?)').run(incarnation, hash)
    if (raw) importOriginal(db, raw)
    db.exec('COMMIT'); db.close(); db = undefined
    await syncSessionDatabase(candidate)
    if (hash !== null && createHash('sha256').update(await readFile(path)).digest('hex') !== hash) {
      throw new Error('The original Session file changed before its atomic cutover.')
    }
    await rename(candidate, databaseFile); published = true
    await syncSessionDatabase(path)
    await confirmOriginalIncarnation(path, incarnation)
    db = new DatabaseSync(path); configureSessionDatabase(db)
    return db
  } catch (error) {
    const cleanup: unknown[] = []
    try { db?.close() } catch (failure) { cleanup.push(failure) }
    if (!published) for (const temporary of [candidate, `${candidate}-journal`]) {
      try { await unlink(temporary) } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') cleanup.push(failure)
      }
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error), { cause: error }), {
      phase: published ? 'after-replace' : 'before-replace', cleanup
    })
  }
}
