import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { durableWriteFile } from './durable-write.js'

const applicationId = 0x414d5353
const sqliteHeader = Buffer.from('SQLite format 3\0')
const schema = `
  PRAGMA application_id = ${applicationId};
  PRAGMA user_version = 1;
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
  CREATE TABLE run_bindings (run_id TEXT PRIMARY KEY, session_id TEXT);
  CREATE INDEX session_runs ON run_bindings(session_id);
  CREATE TABLE native_bindings (native_key TEXT PRIMARY KEY, session_id TEXT NOT NULL);
  CREATE INDEX session_natives ON native_bindings(session_id);
`

/** File/directory confirmation also covers an earlier commit whose durability ACK was lost. */
export async function syncSessionDatabase(path: string): Promise<void> {
  for (const target of [path, dirname(path)]) {
    const handle = await open(target, 'r')
    let failure: unknown
    try { await handle.sync() } catch (error) { failure = error }
    try { await handle.close() } catch (error) {
      failure = failure === undefined ? error : Object.assign(new Error('Session sync and cleanup failed.', { cause: failure }), { cleanup: [error] })
    }
    if (failure !== undefined) throw failure
  }
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
  try { return await readFile(`${path}.sqlite-identity`, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function validate(db: DatabaseSync, acknowledged: string | null): string {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId ||
    db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('Not an AgentMux Session database.')
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
export async function readCurrentSessionDatabase(path: string): Promise<DatabaseSync | null> {
  const acknowledged = await marker(path)
  if (!(await prefix(path))?.equals(sqliteHeader)) {
    if (acknowledged !== null) throw new Error('The acknowledged Session database was removed or replaced. Restore its original file.')
    return null
  }
  // A killed cutover may have published SQLite before its marker ACK. Read the complete
  // transaction in place; the next writer confirms the marker under the original lock.
  // Treating this file as legacy JSON would fabricate an empty salvage result.
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
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
        await durableWriteFile(`${path}.sqlite-identity`, incarnation, { mode: 0o600, requireDirectorySync: true })
      }
      return db
    } catch (error) { return closeAfterFailure(db, error) }
  }
  if (acknowledged !== null) throw new Error('The acknowledged Session database was removed or replaced; re-import would lose original facts.')
  let raw: Buffer | undefined
  let hash: string | null = null
  if (header !== null) {
    raw = await readFile(path)
    hash = createHash('sha256').update(raw).digest('hex')
    const archive = `${path}.original-${hash}`
    // durableWriteFile publishes only complete archives. An interrupted write leaves the source intact.
    await durableWriteFile(archive, raw, { mode: 0o600, requireDirectorySync: true })
  }
  const candidate = `${path}.${process.pid}.${randomUUID()}.tmp`
  const incarnation = randomUUID()
  let db: DatabaseSync | undefined
  let published = false
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
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
    await rename(candidate, path); published = true
    await syncSessionDatabase(path)
    await durableWriteFile(`${path}.sqlite-identity`, incarnation, { mode: 0o600, requireDirectorySync: true })
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
