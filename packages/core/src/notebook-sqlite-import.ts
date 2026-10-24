import { open, readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import type { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from './errors.js'
import { parseNotebookState } from './notebook-catalog.js'
import { noteProvenanceResourceKey, parseNoteProvenanceWrite, type NoteProvenanceWrite } from './note-provenance.js'
import { noteHistoryRevision, parseNoteHistoryRecord, parseNoteHistorySource, type NoteHistoryRecord } from './note-history.js'
import type { NotebookFileSnapshot } from './notebook-files.js'
const applicationId = 0x414d4e42, header = Buffer.from('SQLite format 3\0')
const failure = (message: string) => new AgentMuxError(message + ' Original knowledge and files are retained.', 'NOTEBOOK_READ_UNCONFIRMED')
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
function snapshot(db: DatabaseSync, acknowledged: string | null, includeProvenance = true): NotebookFileSnapshot {
  const incarnation = validateIdentity(db, acknowledged)
  const raw = db.prepare('SELECT json FROM notebook_state WHERE id=1').get()?.json
  if (typeof raw !== 'string') throw failure('The original Notebook directory is missing.')
  const provenance = includeProvenance ? db.prepare('SELECT note_id,resource,revision,json FROM provenance ORDER BY rowid').all().map(provenanceRow) : []
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
async function readSnapshot(path: string, includeProvenance = true): Promise<NotebookFileSnapshot | null> {
  const original = await openRead(path)
  if (!original) return null
  try { return snapshot(original.db, original.acknowledged, includeProvenance) } finally { original.db.close() }
}

/** One-time input only. Caller holds the original catalog lease; no SQL is created or written. */
export async function readLegacyNotebookDatabase(path: string): Promise<{ snapshot: NotebookFileSnapshot | null; inputs: { path: string; bytes: Buffer | null }[] }> {
  const optional = (path: string) => readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  const original = await optional(path), acknowledged = await optional(path + '.sqlite-identity')
  const snapshot = await readSnapshot(path)
  const after = await optional(path), identityAfter = await optional(path + '.sqlite-identity')
  const same = (before: Buffer | null, after: Buffer | null) => before === null ? after === null : after !== null && before.equals(after)
  if (!same(original, after) || !same(acknowledged, identityAfter)) throw failure('The original SQLite or identity bytes changed during export.')
  if (snapshot && !original) throw failure('The original SQLite bytes were not observed before export.')
  return { snapshot, inputs: [{ path, bytes: original }, { path: path + '.sqlite-identity', bytes: acknowledged }] }
}
