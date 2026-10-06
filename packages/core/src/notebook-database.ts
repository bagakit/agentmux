import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, link, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from './errors.js'
import { durableWriteFile } from './durable-write.js'
import { emptyNotebookState, notebookFingerprint, parseNotebookState, type NotebookState } from './notebook-catalog.js'
import { noteProvenanceResourceKey, parseNoteProvenanceWrite, type NoteAuthorship, type NoteProvenanceQuery, type NoteProvenanceSnapshot, type NoteProvenanceWrite } from './note-provenance.js'

export const NOTEBOOK_DATABASE_NAME = 'notebooks.sqlite'
export type NotebookDatabaseSnapshot = { incarnation: string; state: NotebookState; provenance: NoteProvenanceWrite[] }
const applicationId = 0x414d4e42, header = Buffer.from('SQLite format 3\0')
const failure = (message: string) => new AgentMuxError(message + ' Original knowledge and files are retained.', 'NOTEBOOK_READ_UNCONFIRMED')
const schema = `PRAGMA application_id = ${applicationId}; PRAGMA user_version = 1;
  CREATE TABLE identity (incarnation TEXT NOT NULL);
  CREATE TABLE notebook_state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
  CREATE TABLE provenance (note_id TEXT NOT NULL, resource TEXT NOT NULL, revision TEXT NOT NULL, json TEXT NOT NULL,
    PRIMARY KEY(note_id,resource,revision));`
const configure = (db: DatabaseSync) => db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA')
export async function syncNotebookDatabase(path: string): Promise<void> {
  for (const target of [path, dirname(path)]) { const handle = await open(target, 'r'); try { await handle.sync() } finally { await handle.close() } }
}
async function identity(path: string) { try { return await readFile(path + '.sqlite-identity', 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } }
function validateIdentity(db: DatabaseSync, acknowledged: string | null): string {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId || db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw failure('This is not the original Notebook database.')
  const incarnation = db.prepare('SELECT incarnation FROM identity').get()?.incarnation
  if (typeof incarnation !== 'string' || acknowledged !== null && acknowledged !== incarnation) throw failure('The acknowledged Notebook database identity changed.')
  return incarnation
}
function provenanceRow(row: Record<string, unknown>): NoteProvenanceWrite {
  const value = parseNoteProvenanceWrite(JSON.parse(String(row.json)))
  if (row.note_id !== value.noteId || row.resource !== noteProvenanceResourceKey(value.resource) || row.revision !== value.revision) throw failure('The original attribution row identity cannot be confirmed.')
  return value
}
function snapshot(db: DatabaseSync, acknowledged: string | null, includeProvenance = true): NotebookDatabaseSnapshot {
  const incarnation = validateIdentity(db, acknowledged)
  const raw = db.prepare('SELECT json FROM notebook_state WHERE id=1').get()?.json
  if (typeof raw !== 'string') throw failure('The original Notebook directory is missing.')
  const provenance = includeProvenance ? db.prepare('SELECT note_id,resource,revision,json FROM provenance ORDER BY note_id,resource,revision').all().map(provenanceRow) : []
  return { incarnation, state: parseNotebookState(JSON.parse(raw)), provenance }
}
/** Read only. A known database never falls back to JSON or an empty directory. */
async function openRead(path: string): Promise<{ db: DatabaseSync; acknowledged: string | null } | null> {
  const acknowledged = await identity(path)
  let file
  try { file = await open(path, 'r') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (acknowledged !== null) throw failure('The acknowledged Notebook database was removed.')
    return null
  }
  const bytes = Buffer.alloc(16)
  try { await file.read(bytes, 0, 16, 0) } finally { await file.close() }
  if (!bytes.equals(header)) throw failure('The original Notebook database is unreadable.')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path, { readOnly: true })
  try { validateIdentity(db, acknowledged); return { db, acknowledged } } catch (error) { db.close(); throw error }
}
export async function readNotebookDatabase(path: string, includeProvenance = true): Promise<NotebookDatabaseSnapshot | null> {
  const original = await openRead(path)
  if (!original) return null
  try { return snapshot(original.db, original.acknowledged, includeProvenance) } finally { original.db.close() }
}
function createdFor(db: DatabaseSync, noteId: string, resource: string, blockId: string): NoteAuthorship | null {
  const row = db.prepare("SELECT p.note_id,p.resource,p.revision,p.json FROM provenance AS p, json_each(p.json,'$.blocks') AS block WHERE p.note_id=? AND p.resource=? AND block.key=? AND json_type(block.value,'$.created')='object' ORDER BY p.rowid LIMIT 1").get(noteId, resource, blockId)
  return row ? provenanceRow(row).blocks[blockId]?.created ?? null : null
}
/** A provenance lookup touches only the requested original, not all saved Notes or revisions. */
export async function readNotebookProvenance(path: string, query: NoteProvenanceQuery): Promise<NoteProvenanceSnapshot> {
  const original = await openRead(path), key = noteProvenanceResourceKey(query.resource)
  let exact: NoteProvenanceWrite | undefined
  const blocks: NoteProvenanceSnapshot['blocks'] = Object.create(null)
  if (original) try {
    const row = original.db.prepare('SELECT note_id,resource,revision,json FROM provenance WHERE note_id=? AND resource=? AND revision=?').get(query.noteId, key, query.revision)
    if (row) exact = provenanceRow(row)
    for (const id of query.blockIds) blocks[id] = { created: exact?.blocks[id]?.created ?? createdFor(original.db, query.noteId, key, id), lastEdited: exact?.blocks[id]?.lastEdited ?? null }
  } finally { original.db.close() }
  if (!original) for (const id of query.blockIds) blocks[id] = { created: null, lastEdited: null }
  const confirmed = exact && query.blockIds.every(id => Object.hasOwn(exact.blocks, id))
  return { noteId: query.noteId, resource: structuredClone(query.resource), revision: query.revision, blocks,
    ...confirmed ? { status: 'recorded' as const } : { status: 'unconfirmed' as const, reason: 'Trusted block attribution is not confirmed for this exact original body revision.' } }
}
export function notebookDatabaseFingerprint(value: NotebookDatabaseSnapshot): string {
  return createHash('sha256').update(notebookFingerprint({ ...value, provenance: [...value.provenance].sort((a, b) => JSON.stringify([a.noteId, noteProvenanceResourceKey(a.resource), a.revision]).localeCompare(JSON.stringify([b.noteId, noteProvenanceResourceKey(b.resource), b.revision]))) })).digest('hex')
}
/** Exclusive publication used by first creation and the original directory journal. */
export async function publishNotebookDatabase(path: string, value: NotebookDatabaseSnapshot): Promise<void> {
  const existing = await readNotebookDatabase(path)
  if (existing) {
    if (notebookDatabaseFingerprint(existing) !== notebookDatabaseFingerprint(value)) throw new AgentMuxError('The destination contains different Notebook metadata. Original data is retained.', 'NOTES_STORAGE_CONFLICT')
    await syncNotebookDatabase(path)
    await durableWriteFile(path + '.sqlite-identity', value.incarnation, { mode: 0o600, requireDirectorySync: true }); return
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const candidate = path + '.' + randomUUID() + '.tmp'
  const reservation = await open(candidate, 'wx', 0o600); await reservation.close()
  let db: DatabaseSync | undefined
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(candidate); configure(db); db.exec('BEGIN IMMEDIATE'); db.exec(schema)
    db.prepare('INSERT INTO identity VALUES (?)').run(value.incarnation)
    db.prepare('INSERT INTO notebook_state VALUES (1,?)').run(JSON.stringify(parseNotebookState(value.state)))
    const insert = db.prepare('INSERT INTO provenance VALUES (?,?,?,?)')
    for (const candidate of value.provenance) { const entry = parseNoteProvenanceWrite(candidate); insert.run(entry.noteId, noteProvenanceResourceKey(entry.resource), entry.revision, JSON.stringify(entry)) }
    db.exec('COMMIT'); db.close(); db = undefined
    await syncNotebookDatabase(candidate)
    try { await link(candidate, path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const observed = await readNotebookDatabase(path)
      if (!observed || notebookDatabaseFingerprint(observed) !== notebookDatabaseFingerprint(value)) throw new AgentMuxError('The target Notebook database was occupied before publication.', 'NOTES_STORAGE_CONFLICT')
    }
    await chmod(path, 0o600); await syncNotebookDatabase(path)
    await durableWriteFile(path + '.sqlite-identity', value.incarnation, { mode: 0o600, requireDirectorySync: true })
  } finally { db?.close(); await unlink(candidate).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
/** Called under the original catalog flock. Legacy bytes are explicit one-time input. */
export async function initializeNotebookDatabase(path: string, legacyPath?: string, required = false): Promise<NotebookDatabaseSnapshot> {
  const existing = await readNotebookDatabase(path, false)
  if (existing) return existing
  let raw: Buffer | null = null
  if (legacyPath) try { raw = await readFile(legacyPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (required && !raw) throw failure('The confirmed original Notebook directory is missing.')
  const state = raw ? parseNotebookState(JSON.parse(raw.toString('utf8'))) : emptyNotebookState()
  if (raw) await durableWriteFile(legacyPath + '.original-' + createHash('sha256').update(raw).digest('hex'), raw, { mode: 0o600, requireDirectorySync: true })
  if (raw && !(await readFile(legacyPath!)).equals(raw)) throw failure('The original JSON directory changed during its explicit import.')
  const value: NotebookDatabaseSnapshot = { incarnation: randomUUID(), state, provenance: [] }
  await publishNotebookDatabase(path, value)
  return value
}
/** Same-directory format cutover under the original catalog lock, never a second body store. */
export async function replaceNotebookDatabase(path: string, value: NotebookDatabaseSnapshot): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const acknowledged = await identity(path), db = new DatabaseSync(path)
  try {
    configure(db)
    if (validateIdentity(db, acknowledged) !== value.incarnation) throw failure('The original Notebook database identity changed before cutover.')
    db.exec('BEGIN IMMEDIATE')
    db.prepare('UPDATE notebook_state SET json=? WHERE id=1').run(JSON.stringify(parseNotebookState(value.state)))
    db.exec('DELETE FROM provenance')
    const insert = db.prepare('INSERT INTO provenance VALUES (?,?,?,?)')
    for (const candidate of value.provenance) { const entry = parseNoteProvenanceWrite(candidate); insert.run(entry.noteId, noteProvenanceResourceKey(entry.resource), entry.revision, JSON.stringify(entry)) }
    db.exec('COMMIT')
  } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error } finally { db.close() }
  await syncNotebookDatabase(path)
}
/** A single SQLite transaction; the full original Note body never enters this database. */
export async function writeNotebookDatabase(path: string, update: { state?: NotebookState; provenance?: NoteProvenanceWrite }): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const acknowledged = await identity(path), db = new DatabaseSync(path)
  try {
    configure(db); validateIdentity(db, acknowledged); db.exec('BEGIN IMMEDIATE')
    if (update.state) db.prepare('UPDATE notebook_state SET json=? WHERE id=1').run(JSON.stringify(parseNotebookState(update.state)))
    if (update.provenance) {
      const value = parseNoteProvenanceWrite(update.provenance)
      const resource = noteProvenanceResourceKey(value.resource)
      for (const [id, block] of Object.entries(value.blocks)) {
        const created = createdFor(db, value.noteId, resource, id)
        if (created) {
          if (block.created && notebookFingerprint(created) !== notebookFingerprint(block.created)) throw new AgentMuxError('The original block creator is already confirmed. Its trusted attribution is retained.', 'NOTE_PROVENANCE_CONFLICT')
          block.created = created
        }
      }
      const old = db.prepare('SELECT note_id,resource,revision,json FROM provenance WHERE note_id=? AND resource=? AND revision=?').get(value.noteId, resource, value.revision)
      if (old && notebookFingerprint(provenanceRow(old)) !== notebookFingerprint(value)) throw new AgentMuxError('This saved body revision already has different trusted attribution. Its original record is retained.', 'NOTE_PROVENANCE_CONFLICT')
      db.prepare('INSERT OR IGNORE INTO provenance VALUES (?,?,?,?)').run(value.noteId, resource, value.revision, JSON.stringify(value))
    }
    db.exec('COMMIT')
  } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error } finally { db.close() }
  await syncNotebookDatabase(path)
}
