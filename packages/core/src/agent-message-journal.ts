import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, link, mkdir, open, rename, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentMuxMessageJournalRecord } from './agent-global-message-queue.js'

const applicationId = 0x414d514a
const sqliteHeader = Buffer.from('SQLite format 3\0')

/** Specific physical journal. Message and cursor admission remain in the queue owner. */
const schema = `
  PRAGMA application_id = ${applicationId};
  PRAGMA user_version = 1;
  CREATE TABLE metadata (incarnation TEXT NOT NULL, source_hash TEXT);
  CREATE TABLE records (sequence INTEGER PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE messages (
    message_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
    message_sequence INTEGER NOT NULL UNIQUE, recipient_id TEXT, recipient_ordinal INTEGER,
    condition_sequence INTEGER, delivery_sequence INTEGER
  );
  CREATE UNIQUE INDEX recipient_position ON messages(recipient_id, recipient_ordinal);
  CREATE TABLE consumers (consumer_id TEXT PRIMARY KEY, acked INTEGER NOT NULL,
    generation INTEGER NOT NULL, reader_run TEXT NOT NULL, delivery_ids TEXT NOT NULL);
  CREATE TABLE dispatches (source_message_id TEXT PRIMARY KEY, open_sequence INTEGER NOT NULL);
  CREATE TABLE dispatch_events (source_message_id TEXT NOT NULL, reply_message_id TEXT NOT NULL,
    event_sequence INTEGER NOT NULL, PRIMARY KEY(source_message_id, reply_message_id));
  CREATE INDEX dispatch_order ON dispatch_events(source_message_id, event_sequence);
`

export function configureMessageJournal(db: DatabaseSync): void {
  // DELETE + EXTRA keeps SQLite's atomic rollback protocol and its directory-sync ACK.
  // No synchronous busy wait may occupy the terminal/Hook event loop.
  db.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA')
}

export async function syncMessageJournal(path: string): Promise<void> {
  for (const target of [path, dirname(path)]) {
    const handle = await open(target, 'r')
    let failure: unknown
    try { await handle.sync() } catch (error) { failure = error }
    try { await handle.close() } catch (error) {
      failure = failure === undefined ? error : Object.assign(
        new Error('Message journal sync failed; closing its handle also failed.', { cause: failure }), { cleanup: [error] })
    }
    if (failure !== undefined) throw failure
  }
}

async function header(path: string): Promise<Buffer | null> {
  let handle
  try { handle = await open(path, 'r') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const value = Buffer.alloc(16)
    const result = await handle.read(value, 0, value.length, 0)
    return value.subarray(0, result.bytesRead)
  } finally { await handle.close() }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function archiveOriginal(path: string, sourceHash: string): Promise<string> {
  const archive = `${path}.original-${sourceHash}`
  const candidate = `${archive}.${process.pid}.${randomUUID()}.tmp`
  let failure: unknown
  try {
    // Publish only complete, flushed archives. A killed copy must not occupy the content-
    // addressed name forever and make an otherwise intact source impossible to reopen.
    await copyFile(path, candidate, constants.COPYFILE_EXCL)
    await chmod(candidate, 0o600)
    if (await hashFile(candidate) !== sourceHash) throw new Error('Original message journal changed during its archive copy.')
    await syncMessageJournal(candidate)
    try { await link(candidate, archive) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (await hashFile(archive) !== sourceHash) throw new Error('Original message journal archive does not match its source bytes.')
    await syncMessageJournal(archive)
    return archive
  } catch (error) { failure = error; throw error
  } finally {
    await unlink(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return
      if (failure !== undefined) throw Object.assign(new Error('Original journal archive failed; temporary cleanup also failed.', { cause: failure }), { cleanup: [error] })
      throw error
    })
  }
}

/** Strict streaming UTF-8; an incomplete or corrupt record never publishes a partial database. */
async function* legacyRecords(path: string): AsyncGenerator<AgentMuxMessageJournalRecord> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let remaining = ''
  for await (const chunk of createReadStream(path)) {
    remaining += decoder.decode(chunk, { stream: true })
    let newline
    while ((newline = remaining.indexOf('\n')) !== -1) {
      const line = remaining.slice(0, newline); remaining = remaining.slice(newline + 1)
      if (line.trim()) yield JSON.parse(line) as AgentMuxMessageJournalRecord
    }
  }
  remaining += decoder.decode()
  if (remaining.trim()) yield JSON.parse(remaining) as AgentMuxMessageJournalRecord
}

/** Called exclusively under the original cross-process mutex, including during the one-time cutover. */
export async function openMessageJournal(
  path: string, mutex: DatabaseSync,
  importRecord: (db: DatabaseSync, record: AgentMuxMessageJournalRecord) => void
): Promise<DatabaseSync> {
  const { DatabaseSync } = await import('node:sqlite')
  mutex.exec('CREATE TABLE IF NOT EXISTS journal_format (incarnation TEXT PRIMARY KEY)')
  const completed = mutex.prepare('SELECT incarnation FROM journal_format').get()?.incarnation
  const prefix = await header(path)
  if (prefix?.equals(sqliteHeader)) {
    const db = new DatabaseSync(path)
    try {
      await chmod(path, 0o600)
      configureMessageJournal(db)
      if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId ||
        db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('Not an AgentMux message journal.')
      const incarnation = db.prepare('SELECT incarnation FROM metadata').get()?.incarnation
      if (typeof incarnation !== 'string' || (completed !== undefined && completed !== incarnation)) {
        throw new Error('Message journal identity changed after its acknowledged format cutover.')
      }
      // A crash between publishing the full database and acknowledging its marker only needs
      // durability confirmation, never another import or a second current writer.
      if (completed === undefined) {
        await syncMessageJournal(path)
        mutex.prepare('INSERT INTO journal_format VALUES (?)').run(incarnation)
      }
      return db
    } catch (error) { db.close(); throw error }
  }
  if (completed !== undefined) {
    throw new Error('The acknowledged SQLite message journal was removed or replaced; its facts cannot be re-imported as new history.')
  }

  let archive: string | undefined
  let sourceHash: string | null = null
  if (prefix !== null) {
    sourceHash = await hashFile(path)
    archive = await archiveOriginal(path, sourceHash)
  }
  const candidate = `${path}.${process.pid}.${randomUUID()}.tmp`
  const incarnation = randomUUID()
  let db: DatabaseSync | undefined
  let published = false
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const reservation = await open(candidate, 'wx', 0o600); await reservation.close()
    db = new DatabaseSync(candidate)
    configureMessageJournal(db)
    db.exec('BEGIN IMMEDIATE')
    db.exec(schema)
    db.prepare('INSERT INTO metadata VALUES (?, ?)').run(incarnation, sourceHash)
    if (archive) for await (const record of legacyRecords(archive)) importRecord(db, record)
    db.exec('COMMIT')
    db.close(); db = undefined
    await syncMessageJournal(candidate)
    if (sourceHash !== null && await hashFile(path) !== sourceHash) throw new Error('Original message journal changed before its atomic cutover.')
    await rename(candidate, path); published = true
    await syncMessageJournal(path)
    mutex.prepare('INSERT INTO journal_format VALUES (?)').run(incarnation)
    db = new DatabaseSync(path)
    configureMessageJournal(db)
    return db
  } catch (error) {
    const cleanup: unknown[] = []
    try { db?.close() } catch (failure) { cleanup.push(failure) }
    if (!published) for (const temporary of [candidate, `${candidate}-journal`]) {
      try { await unlink(temporary) } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') cleanup.push(failure)
      }
    }
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), {
      phase: published ? 'after-replace' : 'before-replace', cleanup
    })
  }
}
