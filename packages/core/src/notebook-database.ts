import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, link, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from './errors.js'
import { durableWriteFile } from './durable-write.js'
import { emptyNotebookState, notebookFingerprint, parseNotebookState, type NotebookState, type NoteResource } from './notebook-catalog.js'
import { noteProvenanceResourceKey, parseNoteProvenanceWrite, type NoteAuthorship, type NoteProvenanceQuery, type NoteProvenanceSnapshot, type NoteProvenanceWrite } from './note-provenance.js'
import { noteHistoryRevision, noteHistorySnapshot, parseNoteHistoryRecord, parseNoteHistoryQuery, parseNoteHistorySource, type NoteHistoryRecord, type NoteHistoryEntry, type NoteHistoryQuery, type NoteHistorySnapshot } from './note-history.js'

export const NOTEBOOK_DATABASE_NAME = 'notebooks.sqlite'
export type NotebookDatabaseSnapshot = { incarnation: string; state: NotebookState; provenance: NoteProvenanceWrite[]; history?: NoteHistoryRecord[] }
const historySchema = `CREATE TABLE IF NOT EXISTS note_history_content (revision TEXT PRIMARY KEY, content BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS note_history_event (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL, resource TEXT NOT NULL, event_id TEXT NOT NULL, batch_id TEXT NOT NULL, json TEXT NOT NULL,
    UNIQUE(note_id,resource,event_id));
  CREATE INDEX IF NOT EXISTS note_history_original ON note_history_event(note_id,resource,sequence);
  CREATE INDEX IF NOT EXISTS note_history_operation ON note_history_event(event_id);
  CREATE INDEX IF NOT EXISTS note_history_batch ON note_history_event(note_id,resource,batch_id,sequence);`
const applicationId = 0x414d4e42, header = Buffer.from('SQLite format 3\0')
const failure = (message: string) => new AgentMuxError(message + ' Original knowledge and files are retained.', 'NOTEBOOK_READ_UNCONFIRMED')
const schema = `PRAGMA application_id = ${applicationId}; PRAGMA user_version = 2;
  CREATE TABLE identity (incarnation TEXT NOT NULL);
  CREATE TABLE notebook_state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
  CREATE TABLE provenance (note_id TEXT NOT NULL, resource TEXT NOT NULL, revision TEXT NOT NULL, json TEXT NOT NULL,
    PRIMARY KEY(note_id,resource,revision)); ${historySchema}`
const configure = (db: DatabaseSync) => db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA')
export async function syncNotebookDatabase(path: string): Promise<void> {
  for (const target of [path, dirname(path)]) { const handle = await open(target, 'r'); try { await handle.sync() } finally { await handle.close() } }
}
async function identity(path: string) { try { return await readFile(path + '.sqlite-identity', 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } }
function validateIdentity(db: DatabaseSync, acknowledged: string | null): string {
  const version = db.prepare('PRAGMA user_version').get()?.user_version
  if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId || version !== 1 && version !== 2) throw failure('This is not the original Notebook database.')
  const incarnation = db.prepare('SELECT incarnation FROM identity').get()?.incarnation
  if (typeof incarnation !== 'string' || acknowledged !== null && acknowledged !== incarnation) throw failure('The acknowledged Notebook database identity changed.')
  return incarnation
}
function provenanceRow(row: Record<string, unknown>): NoteProvenanceWrite {
  const value = parseNoteProvenanceWrite(JSON.parse(String(row.json)))
  if (row.note_id !== value.noteId || row.resource !== noteProvenanceResourceKey(value.resource) || row.revision !== value.revision) throw failure('The original attribution row identity cannot be confirmed.')
  return value
}
function hasHistory(db: DatabaseSync): boolean {
  const events = !!db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='note_history_event'").get()
  const bodies = !!db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='note_history_content'").get()
  if (events !== bodies || db.prepare('PRAGMA user_version').get()?.user_version === 2 && !events) throw failure('The acknowledged original history schema is unavailable. Restore this same database; readable current Notes remain available.')
  return events
}
function historyBody(db: DatabaseSync, revision: string): string {
  const row = db.prepare('SELECT content FROM note_history_content WHERE revision=?').get(revision)
  if (!(row?.content instanceof Uint8Array)) throw failure('The original history body is missing.')
  const content = gunzipSync(row.content).toString('utf8')
  if (noteHistoryRevision(content) !== revision) throw failure('The original history body digest changed.')
  return content
}
function historyMetadata(row: Record<string, unknown>): Omit<NoteHistoryRecord, 'beforeContent' | 'content'> {
  const value = JSON.parse(String(row.json)) as Omit<NoteHistoryRecord, 'beforeContent' | 'content'>
  if (row.note_id !== value.noteId || row.resource !== noteProvenanceResourceKey(value.resource) || row.event_id !== value.eventId || row.batch_id !== value.batchId ||
      !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1 || (value.operation === 'delete' ? value.revision !== null : !/^sha256:[a-f0-9]{64}$/u.test(value.revision!)) ||
      value.baseRevision !== null && !/^sha256:[a-f0-9]{64}$/u.test(value.baseRevision) ||
      !['prepared', 'committed', 'unconfirmed', 'not-applied'].includes(value.status) || !['edit', 'restore', 'undo', 'delete'].includes(value.operation) ||
      !Number.isSafeInteger(value.at) || value.at < 0 || !value.requestFingerprint ||
      value.actor !== null && (!['user', 'agent', 'device'].includes(value.actor.kind) || typeof value.actor.id !== 'string' || !value.actor.id || /[\0\r\n]/u.test(value.actor.id))) throw failure('The original history event identity cannot be confirmed.')
  parseNoteHistorySource(value.operation, value.source)
  return { ...value, sequence: Number(row.sequence) }
}
function historyRecord(db: DatabaseSync, row: Record<string, unknown>): NoteHistoryRecord {
  const value = historyMetadata(row)
  return parseNoteHistoryRecord({ ...value, beforeContent: value.baseRevision === null ? null : historyBody(db, value.baseRevision), content: value.revision === null ? null : historyBody(db, value.revision) } as NoteHistoryRecord)
}
function putHistory(db: DatabaseSync, candidate: NoteHistoryRecord): NoteHistoryRecord {
  const value = parseNoteHistoryRecord(candidate), key = noteProvenanceResourceKey(value.resource)
  const oldRow = db.prepare('SELECT * FROM note_history_event WHERE note_id=? AND resource=? AND event_id=?').get(value.noteId, key, value.eventId)
  if (oldRow) {
    const old = historyRecord(db, oldRow)
    const immutable = (record: NoteHistoryRecord) => { const { sequence: _sequence, status: _status, provenance: _provenance, fileWitness: _fileWitness, ...entry } = record; if (entry.operation === 'delete') delete entry.retainedPath; return notebookFingerprint(entry) }
    if (immutable(old) !== immutable(value) || value.sequence !== old.sequence ||
        ['committed', 'not-applied'].includes(old.status) && (old.status !== value.status || notebookFingerprint(old.provenance ?? null) !== notebookFingerprint(value.provenance ?? null) || notebookFingerprint(old.fileWitness ?? null) !== notebookFingerprint(value.fileWitness ?? null))) {
      throw new AgentMuxError('This original history operation already records another request or terminal result. Its body and event are retained.', 'NOTE_HISTORY_OPERATION_CONFLICT')
    }
  }
  const content = db.prepare('INSERT OR IGNORE INTO note_history_content VALUES (?,?)')
  if (value.content !== null) content.run(value.revision, gzipSync(value.content))
  if (value.beforeContent !== null) content.run(value.baseRevision, gzipSync(value.beforeContent))
  const { sequence, beforeContent: _before, content: _content, ...metadata } = value
  if (oldRow) db.prepare('UPDATE note_history_event SET json=? WHERE sequence=?').run(JSON.stringify(metadata), sequence)
  else db.prepare('INSERT INTO note_history_event(sequence,note_id,resource,event_id,batch_id,json) VALUES (?,?,?,?,?,?)').run(sequence || null, value.noteId, key, value.eventId, value.batchId, JSON.stringify(metadata))
  return historyRecord(db, db.prepare('SELECT * FROM note_history_event WHERE note_id=? AND resource=? AND event_id=?').get(value.noteId, key, value.eventId)!)
}
/** Paginated metadata reads do not inflate historical bodies or scan unrelated Notes. */
export async function readNotebookHistory(path: string, query: NoteHistoryQuery): Promise<NoteHistorySnapshot> {
  parseNoteHistoryQuery(query)
  const original = await openRead(path)
  if (!original) return noteHistorySnapshot(query, [], false)
  try {
    if (!hasHistory(original.db)) return noteHistorySnapshot(query, [], false)
    const limit = query.limit ?? 50
    const rows = query.eventId
      ? original.db.prepare('SELECT * FROM note_history_event WHERE note_id=? AND resource=? AND event_id=?').all(query.noteId, noteProvenanceResourceKey(query.resource), query.eventId)
      : original.db.prepare('SELECT * FROM note_history_event WHERE note_id=? AND resource=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(query.noteId, noteProvenanceResourceKey(query.resource), query.before ?? Number.MAX_SAFE_INTEGER, limit + 1)
    const entries: NoteHistoryEntry[] = rows.slice(0, limit).map(row => {
      const { requestFingerprint: _fingerprint, ...value } = query.includeContent ? historyRecord(original.db, row) : historyMetadata(row)
      if (!query.includeContent) delete value.provenance
      return value
    })
    return noteHistorySnapshot(query, entries, rows.length > limit)
  } finally { original.db.close() }
}
/** Derived indexes are rebuilt under the original writer lock, never by an independent data owner. */
async function openIndexedHistory(path: string, index: 'operation' | 'batch') {
  let original = await openRead(path)
  if (!original) return null
  const name = index === 'operation' ? 'note_history_operation' : 'note_history_batch'
  const sql = index === 'operation' ? 'CREATE INDEX IF NOT EXISTS note_history_operation ON note_history_event(event_id)' : 'CREATE INDEX IF NOT EXISTS note_history_batch ON note_history_event(note_id,resource,batch_id,sequence)'
  try {
    if (!hasHistory(original.db)) { original.db.close(); return null }
    if (!original.db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name=?").get(name)) {
      original.db.close(); original = null
      const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(path)
      try { configure(db); validateIdentity(db, await identity(path)); hasHistory(db); db.exec(sql) } finally { db.close() }
      await syncNotebookDatabase(path)
      original = await openRead(path)
      if (!original) throw failure('The original operation journal disappeared during lookup.')
    }
    return original
  } catch (error) { original?.db.close(); throw error }
}
/** Trusted writer lookup, not a public timeline. */
export async function readNotebookHistoryOperation(path: string, eventId: string): Promise<NoteHistoryRecord | undefined> {
  const original = await openIndexedHistory(path, 'operation')
  if (!original) return
  try {
    const rows = original.db.prepare('SELECT * FROM note_history_event WHERE event_id=? LIMIT 2').all(eventId)
    if (rows.length > 1) throw failure('This operation identity has ambiguous original events.')
    return rows[0] ? historyRecord(original.db, rows[0]) : undefined
  } finally { original.db.close() }
}
/** Full indexed membership without inflating every intermediate body. The writer selects exact endpoints separately. */
export async function readNotebookHistoryBatch(path: string, query: Pick<NoteHistoryQuery, 'noteId' | 'resource'> & { batchId: string }): Promise<NoteHistoryEntry[]> {
  parseNoteHistoryQuery({ noteId: query.noteId, resource: query.resource })
  if (typeof query.batchId !== 'string' || !query.batchId || /[\0\r\n]/u.test(query.batchId)) throw new AgentMuxError('An exact original history batch is required.', 'NOTE_HISTORY_INVALID')
  const original = await openIndexedHistory(path, 'batch')
  if (!original) return []
  try {
    return original.db.prepare('SELECT * FROM note_history_event WHERE note_id=? AND resource=? AND batch_id=? ORDER BY sequence').all(query.noteId, noteProvenanceResourceKey(query.resource), query.batchId).map(row => {
      const { requestFingerprint: _private, provenance: _provenance, ...entry } = historyMetadata(row)
      return entry
    })
  } finally { original.db.close() }
}
/** Current attribution needs only the newest committed event, never historical body inflation. */
export async function readNotebookHistoryProvenance(path: string, query: NoteProvenanceQuery): Promise<Pick<NoteHistoryRecord, 'status' | 'revision' | 'provenance'> | undefined> {
  const original = await openRead(path)
  if (!original) return
  try {
    if (!hasHistory(original.db)) return
    const row = original.db.prepare("SELECT * FROM note_history_event WHERE note_id=? AND resource=? AND json_extract(json,'$.status') != 'not-applied' ORDER BY sequence DESC LIMIT 1").get(query.noteId, noteProvenanceResourceKey(query.resource))
    const latest = row && historyMetadata(row)
    if (!latest) return
    const provenance = latest.provenance && parseNoteProvenanceWrite(latest.provenance)
    if (provenance && (provenance.noteId !== query.noteId || provenance.revision !== latest.revision || noteProvenanceResourceKey(provenance.resource) !== noteProvenanceResourceKey(query.resource))) throw failure('Historical attribution belongs to another original Note or revision.')
    return { status: latest.status, revision: latest.revision, ...(provenance ? { provenance } : {}) }
  } finally { original.db.close() }
}
/** Original Notebook lock is held by the store; prepare and outcome are separate durable facts. */
export async function writeNotebookHistory(path: string, record: NoteHistoryRecord): Promise<NoteHistoryRecord> {
  const { DatabaseSync } = await import('node:sqlite')
  const acknowledged = await identity(path), db = new DatabaseSync(path)
  let result: NoteHistoryRecord
  try {
    configure(db); validateIdentity(db, acknowledged); db.exec('BEGIN IMMEDIATE')
    // Extend the original v1 metadata database once, without replacing its data or identity.
    // Once v2 acknowledges history, missing tables are a failure, never an empty new journal.
    if (db.prepare('PRAGMA user_version').get()?.user_version === 1) { hasHistory(db); db.exec(historySchema); db.exec('PRAGMA user_version=2') }
    else { hasHistory(db); db.exec('CREATE INDEX IF NOT EXISTS note_history_operation ON note_history_event(event_id); CREATE INDEX IF NOT EXISTS note_history_batch ON note_history_event(note_id,resource,batch_id,sequence)') }
    result = putHistory(db, record); db.exec('COMMIT')
  } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error } finally { db.close() }
  await syncNotebookDatabase(path)
  return result!
}
function snapshot(db: DatabaseSync, acknowledged: string | null, includeProvenance = true): NotebookDatabaseSnapshot {
  const incarnation = validateIdentity(db, acknowledged)
  const raw = db.prepare('SELECT json FROM notebook_state WHERE id=1').get()?.json
  if (typeof raw !== 'string') throw failure('The original Notebook directory is missing.')
  const provenance = includeProvenance ? db.prepare('SELECT note_id,resource,revision,json FROM provenance ORDER BY note_id,resource,revision').all().map(provenanceRow) : []
  const history = includeProvenance && hasHistory(db) ? db.prepare('SELECT * FROM note_history_event ORDER BY sequence').all().map(row => historyRecord(db, row)) : []
  return { incarnation, state: parseNotebookState(JSON.parse(raw)), provenance, ...(history.length ? { history } : {}) }
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
function creatorsFor(db: DatabaseSync, noteId: string, resource: string, blockIds: readonly string[]): Map<string, NoteAuthorship> {
  const remaining = new Set(blockIds), creators = new Map<string, NoteAuthorship>()
  if (!remaining.size) return creators
  const rows = db.prepare('SELECT note_id,resource,revision,json FROM provenance WHERE note_id=? AND resource=? ORDER BY rowid')
  for (const row of rows.iterate(noteId, resource)) {
    const raw = JSON.parse(String(row.json)) as { blocks?: Record<string, { created?: unknown } | null> } | null
    const blocks = raw?.blocks
    if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)) continue
    let checked: NoteProvenanceWrite | undefined
    for (const id of remaining) {
      const created = Object.hasOwn(blocks, id) ? blocks[id]?.created : undefined
      if (!created || typeof created !== 'object' || Array.isArray(created)) continue
      checked ??= provenanceRow(row)
      const original = checked.blocks[id]?.created
      if (original) { creators.set(id, original); remaining.delete(id) }
    }
    if (!remaining.size) break
  }
  return creators
}
/** A provenance lookup touches only the requested original, not all saved Notes or revisions. */
export async function readNotebookProvenance(path: string, query: NoteProvenanceQuery): Promise<NoteProvenanceSnapshot> {
  const original = await openRead(path), key = noteProvenanceResourceKey(query.resource)
  let exact: NoteProvenanceWrite | undefined
  const blocks: NoteProvenanceSnapshot['blocks'] = Object.create(null)
  if (original) try {
    const row = original.db.prepare('SELECT note_id,resource,revision,json FROM provenance WHERE note_id=? AND resource=? AND revision=?').get(query.noteId, key, query.revision)
    if (row) exact = provenanceRow(row)
    const creators = creatorsFor(original.db, query.noteId, key, query.blockIds.filter(id => !exact?.blocks[id]?.created))
    for (const id of query.blockIds) blocks[id] = { created: exact?.blocks[id]?.created ?? creators.get(id) ?? null, lastEdited: exact?.blocks[id]?.lastEdited ?? null }
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
    for (const event of value.history ?? []) putHistory(db, event)
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
    db.exec(historySchema); db.exec('DELETE FROM note_history_event; DELETE FROM note_history_content')
    for (const event of value.history ?? []) putHistory(db, event)
    db.exec('COMMIT')
  } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error } finally { db.close() }
  await syncNotebookDatabase(path)
}
type NoteMetadataRelocation = { noteId: string; from: NoteResource; to: NoteResource }
/** Move only the exact original's metadata. Content blobs and original request identities stay untouched. */
function relocateNoteMetadata(db: DatabaseSync, move: NoteMetadataRelocation, next: NotebookState): void {
  const from = noteProvenanceResourceKey(move.from), to = noteProvenanceResourceKey(move.to)
  const raw = db.prepare('SELECT json FROM notebook_state WHERE id=1').get()?.json
  const before = typeof raw === 'string' ? parseNotebookState(JSON.parse(raw)) : undefined
  if (!before?.pages[move.noteId] || !next.pages[move.noteId] ||
      noteProvenanceResourceKey(before.pages[move.noteId]!.resource) !== from || noteProvenanceResourceKey(next.pages[move.noteId]!.resource) !== to)
    throw failure('The original Note relocation and catalog resources cannot be confirmed.')
  if (from === to) return
  const history = hasHistory(db)
  if (db.prepare('SELECT 1 FROM provenance WHERE note_id=? AND resource=? LIMIT 1').get(move.noteId, to) ||
      history && db.prepare('SELECT 1 FROM note_history_event WHERE note_id=? AND resource=? LIMIT 1').get(move.noteId, to))
    throw new AgentMuxError('The destination already has trusted metadata for this Note. Both original records and the catalog are retained; inspect this same file move before retrying.', 'NOTE_METADATA_RELOCATION_CONFLICT')
  const attribution = db.prepare('SELECT note_id,resource,revision,json FROM provenance WHERE note_id=? AND resource=?').all(move.noteId, from)
  const putAttribution = db.prepare('UPDATE provenance SET resource=?,json=? WHERE note_id=? AND resource=? AND revision=?')
  for (const row of attribution) {
    const value = provenanceRow(row)
    value.resource = structuredClone(move.to)
    putAttribution.run(to, JSON.stringify(value), move.noteId, from, value.revision)
  }
  if (history) {
    const rows = db.prepare('SELECT * FROM note_history_event WHERE note_id=? AND resource=? ORDER BY sequence').all(move.noteId, from)
    const put = db.prepare('UPDATE note_history_event SET resource=?,json=? WHERE sequence=?')
    for (const row of rows) {
      const { sequence, ...value } = historyMetadata(row)
      if (value.provenance) {
        const provenance = parseNoteProvenanceWrite(value.provenance)
        if (provenance.noteId !== move.noteId || noteProvenanceResourceKey(provenance.resource) !== from || provenance.revision !== value.revision)
          throw failure('The original moved history attribution cannot be confirmed.')
        value.provenance = { ...provenance, resource: structuredClone(move.to) }
      }
      value.resource = structuredClone(move.to)
      put.run(to, JSON.stringify(value), sequence)
    }
  }
}
/** Catalog, scoped metadata relocation and attribution share one original SQLite transaction. */
export async function writeNotebookDatabase(path: string, update: { state?: NotebookState; provenance?: NoteProvenanceWrite; relocation?: NoteMetadataRelocation }): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const acknowledged = await identity(path), db = new DatabaseSync(path)
  try {
    configure(db); validateIdentity(db, acknowledged); db.exec('BEGIN IMMEDIATE')
    const state = update.state && parseNotebookState(update.state)
    if (update.relocation) {
      if (!state) throw failure('A Note metadata relocation requires its original catalog transaction.')
      relocateNoteMetadata(db, update.relocation, state)
    }
    if (state) db.prepare('UPDATE notebook_state SET json=? WHERE id=1').run(JSON.stringify(state))
    if (update.provenance) {
      const value = parseNoteProvenanceWrite(update.provenance)
      const resource = noteProvenanceResourceKey(value.resource)
      const creators = creatorsFor(db, value.noteId, resource, Object.keys(value.blocks))
      for (const [id, block] of Object.entries(value.blocks)) {
        const created = creators.get(id)
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
