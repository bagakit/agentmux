import { mintObjectId } from './object-id.js'
import type { DatabaseSync } from 'node:sqlite';
import { AgentMuxError } from './errors.js';
import { conversationRevision } from './conversation-stream.js';
import { normalizeAgentTimelineItem } from './session-timeline.js';
import { applyNormalizedTimelineMutation } from './session-timeline-reducer.js';
import { parseAgentInputJournalCut, type AgentInputJournalCut } from './agent-input-conversation.js'
import type { AgentCapturedTimelinePage, AgentCapturedTimelineRead, AgentCapturedTimelineRecord, AgentCapturedTimelineStream, AgentTimelineCommit, AgentTimelineMutation, AgentTimelineSnapshot } from './types.js';
// These are tables in the original Session database, under its original transaction/flock.
// Bodies exist only in immutable versions. Heads and recent windows are indexes/queries.
export const capturedHistorySchema = `
 CREATE TABLE IF NOT EXISTS captured_streams (
  session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, sequence INTEGER NOT NULL,
  revision INTEGER NOT NULL, state TEXT NOT NULL, origin TEXT NOT NULL,
  gaps_json TEXT NOT NULL, source_witness TEXT, import_ack TEXT, import_index INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS captured_record_heads (
  session_id TEXT NOT NULL, epoch TEXT NOT NULL, record_id TEXT NOT NULL,
  first_sequence INTEGER NOT NULL, latest_sequence INTEGER NOT NULL,
  kind TEXT NOT NULL, activity INTEGER NOT NULL,
  PRIMARY KEY(session_id,epoch,record_id));
 CREATE INDEX IF NOT EXISTS captured_first ON captured_record_heads(session_id,epoch,first_sequence DESC);
 CREATE INDEX IF NOT EXISTS captured_recent ON captured_record_heads(session_id,epoch,activity,kind,first_sequence DESC);
 CREATE TABLE IF NOT EXISTS captured_record_versions (
  session_id TEXT NOT NULL, epoch TEXT NOT NULL, sequence INTEGER NOT NULL,
  record_id TEXT NOT NULL, revision TEXT NOT NULL, timeline_revision INTEGER NOT NULL,
  item_json TEXT NOT NULL, PRIMARY KEY(session_id,epoch,sequence));
 CREATE INDEX IF NOT EXISTS captured_record_version ON captured_record_versions(session_id,epoch,record_id,sequence DESC);
 CREATE INDEX IF NOT EXISTS captured_exact_version ON captured_record_versions(session_id,epoch,record_id,revision,sequence);
`;
type StreamRow = {
  epoch: string;
  sequence: number;
  revision: number;
  state: string;
  origin: AgentCapturedTimelineStream['origin'];
  gaps_json: string;
  source_witness: string | null;
  import_ack: string | null;
  import_index: number;
};
export function capturedStream(db: DatabaseSync, id: string): StreamRow | undefined {
  return db.prepare('SELECT * FROM captured_streams WHERE session_id=?').get(id) as StreamRow | undefined;
}
export function beginCapturedStream(db: DatabaseSync, id: string, witness: string | null): StreamRow {
  db.prepare("INSERT OR IGNORE INTO captured_streams VALUES (?,?,0,0,'preparing',?,'[]',?,NULL,0)")
    .run(id, mintObjectId(), witness === null ? 'beginning' : 'retained-prefix', witness);
  return capturedStream(db, id)!;
}
export function readyCapturedStream(db: DatabaseSync, id: string, witness: string | null, revision: number, gaps: AgentCapturedTimelineStream['gaps']): void {
  const stream = capturedStream(db, id)!;
  if (stream.source_witness !== witness)
    throw new AgentMuxError('Original captured source changed during handover.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED');
  db.prepare("UPDATE captured_streams SET state='ready',revision=?,gaps_json=?,import_ack=? WHERE session_id=?")
    .run(revision, JSON.stringify(gaps), witness ?? 'new-stream', id);
}
function accepted(db: DatabaseSync, id: string): StreamRow {
  const row = capturedStream(db, id);
  if (!row || row.state !== 'ready')
    throw new AgentMuxError('Captured history handover is unconfirmed; retain the original read and retry.', 'AGENT_SESSION_HISTORY_CAPTURE_UNCONFIRMED');
  return row;
}
function decode(row: Record<string, unknown>): AgentCapturedTimelineRecord {
  return { item: normalizeAgentTimelineItem(JSON.parse(String(row.item_json))), firstSequence: Number(row.first_sequence), sequence: Number(row.sequence), revision: String(row.revision) };
}
export function capturedStreamMetadata(db: DatabaseSync, id: string, cut?: number): AgentCapturedTimelineStream {
  const row = accepted(db, id), sequence = cut ?? row.sequence;
  const version = sequence === row.sequence ? row.revision : Number(db.prepare('SELECT timeline_revision FROM captured_record_versions WHERE session_id=? AND epoch=? AND sequence<=? ORDER BY sequence DESC LIMIT 1').get(id, row.epoch, sequence)?.timeline_revision ?? 0);
  return { epoch: row.epoch, sequence, revision: version, origin: row.origin, gaps: JSON.parse(row.gaps_json) };
}
export function commitCapturedMutation(db: DatabaseSync, mutation: AgentTimelineMutation, preparing = false): AgentTimelineCommit {
  const id = mutation.agentSessionId, stream = preparing ? capturedStream(db, id)! : accepted(db, id);
  const recordId = mutation.type === 'update' ? mutation.itemId : mutation.item.id;
  const previousRow = db.prepare(`SELECT v.*,h.first_sequence FROM captured_record_heads h JOIN captured_record_versions v
  ON v.session_id=h.session_id AND v.epoch=h.epoch AND v.sequence=h.latest_sequence
  WHERE h.session_id=? AND h.epoch=? AND h.record_id=?`).get(id, stream.epoch, recordId);
  const previous = previousRow ? decode(previousRow).item : undefined;
  const items = previous ? [previous] : [];
  const next = applyNormalizedTimelineMutation(items, mutation);
  const changed = next !== items;
  const header = { epoch: stream.epoch, sequence: stream.sequence, revision: stream.revision, origin: stream.origin, gaps: JSON.parse(stream.gaps_json) };
  if (!changed)
    return { agentSessionId: id, revision: stream.revision, changed: false, mutation, stream: header,
      position: { id: recordId, firstSequence: Number(previousRow!.first_sequence), sequence: Number(previousRow!.sequence), revision: String(previousRow!.revision) } };
  if (!Number.isSafeInteger(stream.sequence + 1) || !Number.isSafeInteger(stream.revision + 1))
    throw new AgentMuxError('Captured stream sequence limit reached.', 'AGENT_TIMELINE_REVISION_LIMIT');
  const item = next[0]!, sequence = stream.sequence + 1, revision = stream.revision + 1, itemRevision = conversationRevision(item);
  if (item.inputOrigin) {
    initializeInputProjection(db)
    if (item.inputRef && item.inputSubmission && (item.inputSubmission.status === 'waiting' || item.inputSubmission.status === 'unknown' || item.inputSubmission.observation === 'owned'))
      db.prepare('INSERT INTO captured_input_pending VALUES (?,?,?) ON CONFLICT(session_id,record_id) DO UPDATE SET key_json=excluded.key_json').run(id, recordId, JSON.stringify(item.inputRef))
    else db.prepare('DELETE FROM captured_input_pending WHERE session_id=? AND record_id=?').run(id, recordId)
  } else if (previous?.inputOrigin) db.prepare('DELETE FROM captured_input_pending WHERE session_id=? AND record_id=?').run(id, recordId)
  db.prepare('INSERT INTO captured_record_versions VALUES (?,?,?,?,?,?,?)')
    .run(id, stream.epoch, sequence, recordId, itemRevision, revision, JSON.stringify(item));
  db.prepare(`INSERT INTO captured_record_heads VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id,epoch,record_id)
  DO UPDATE SET latest_sequence=excluded.latest_sequence,kind=excluded.kind,activity=excluded.activity`)
    .run(id, stream.epoch, recordId, sequence, sequence, item.kind, Number(item.activityState !== undefined));
  db.prepare('UPDATE captured_streams SET sequence=?,revision=? WHERE session_id=?').run(sequence, revision, id);
  return { agentSessionId: id, revision, changed: true, mutation, stream: { ...header, sequence, revision },
    position: { id: recordId, firstSequence: previousRow ? Number(previousRow.first_sequence) : sequence, sequence, revision: itemRevision } };
}
export function readCapturedInputProjection(db: DatabaseSync, id: string, after = '') {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='captured_input_projection'").get()) return { cut: null, pending: [], next: null }
  const row = db.prepare('SELECT cut_json FROM captured_input_projection WHERE session_id=?').get(id)
  const pending = db.prepare('SELECT record_id,key_json FROM captured_input_pending WHERE session_id=? AND record_id>? ORDER BY record_id LIMIT 101').all(id, after)
  return { cut: row ? parseAgentInputJournalCut(JSON.parse(String(row.cut_json))) : null,
    pending: pending.slice(0, 100).map(row => ({ recordId: String(row.record_id), key: JSON.parse(String(row.key_json)) as import('./agent-prompt-condition.js').AgentPromptInputKey })),
    next: pending.length > 100 ? String(pending[99]!.record_id) : null }
}
function initializeInputProjection(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS captured_input_projection (session_id TEXT PRIMARY KEY, cut_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS captured_input_pending (session_id TEXT NOT NULL, record_id TEXT NOT NULL, key_json TEXT NOT NULL, PRIMARY KEY(session_id,record_id));`)
}
export function writeCapturedInputProjection(db: DatabaseSync, id: string, value: AgentInputJournalCut): void {
  initializeInputProjection(db)
  const cut = parseAgentInputJournalCut(value), row = db.prepare('SELECT cut_json FROM captured_input_projection WHERE session_id=?').get(id)
  const previous = row ? parseAgentInputJournalCut(JSON.parse(String(row.cut_json))) : null
  if (previous && (previous.queueId !== cut.queueId || previous.incarnation !== cut.incarnation)) throw new AgentMuxError('The original input projection journal changed.', 'AGENT_INPUT_READ_UNCONFIRMED')
  if (!previous || previous.sequence < cut.sequence) db.prepare('INSERT INTO captured_input_projection VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET cut_json=excluded.cut_json').run(id, JSON.stringify(cut))
}
export function readCapturedPage(db: DatabaseSync, id: string, input: AgentCapturedTimelineRead = {}): AgentCapturedTimelinePage {
  const stream = accepted(db, id), cut = input.throughSequence ?? stream.sequence, limit = input.limit ?? 100;
  if (input.epoch !== undefined && input.epoch !== stream.epoch || !Number.isSafeInteger(cut) || cut < 0 || cut > stream.sequence || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
    [input.beforeFirstSequence, input.afterSequence].some(v => v !== undefined && (!Number.isSafeInteger(v) || v < 0)) || input.recordRevision !== undefined && !input.recordId) {
    throw new AgentMuxError('Captured continuation does not identify this original stream/cut.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED');
  }
  let rows: Record<string, unknown>[];
  if (input.afterSequence !== undefined) {
    rows = db.prepare(`SELECT v.*,h.first_sequence FROM captured_record_versions v JOIN captured_record_heads h USING(session_id,epoch,record_id)
   WHERE v.session_id=? AND v.epoch=? AND v.sequence>? AND v.sequence<=? ORDER BY v.sequence LIMIT ?`).all(id, stream.epoch, input.afterSequence, cut, limit + 1);
  }
  else if (input.recordId !== undefined && input.recordRevision !== undefined) {
    rows = db.prepare(`SELECT v.*,h.first_sequence FROM captured_record_versions v INDEXED BY captured_exact_version JOIN captured_record_heads h USING(session_id,epoch,record_id)
   WHERE v.session_id=? AND v.epoch=? AND v.record_id=? AND v.revision=? AND v.sequence<=? ORDER BY v.sequence DESC LIMIT 1`)
      .all(id, stream.epoch, input.recordId, input.recordRevision, cut);
  }
  else {
    rows = db.prepare(`SELECT v.*,h.first_sequence FROM captured_record_heads h JOIN captured_record_versions v
   ON v.session_id=h.session_id AND v.epoch=h.epoch AND v.sequence=(SELECT MAX(x.sequence) FROM captured_record_versions x
    WHERE x.session_id=h.session_id AND x.epoch=h.epoch AND x.record_id=h.record_id AND x.sequence<=?)
   WHERE h.session_id=? AND h.epoch=? AND h.first_sequence<? ${input.recordId === undefined ? '' : 'AND h.record_id=?'}
   ORDER BY h.first_sequence DESC LIMIT ?`).all(cut, id, stream.epoch, input.beforeFirstSequence ?? Number.MAX_SAFE_INTEGER, ...(input.recordId === undefined ? [] : [input.recordId]), limit + 1);
  }
  const more = rows.length > limit, records = rows.slice(0, limit).map(decode);
  return { agentSessionId: id, stream: capturedStreamMetadata(db, id, cut), records,
    nextBeforeFirstSequence: more && input.afterSequence === undefined ? records.at(-1)!.firstSequence : null, more };
}
export function readRecentCaptured(db: DatabaseSync, id: string): AgentTimelineSnapshot {
  const stream = capturedStreamMetadata(db, id);
  const rows = db.prepare(`SELECT v.*,h.first_sequence FROM captured_record_heads h JOIN captured_record_versions v
  ON v.session_id=h.session_id AND v.epoch=h.epoch AND v.sequence=h.latest_sequence
  WHERE h.session_id=? AND h.epoch=? AND h.record_id IN (
   SELECT record_id FROM (SELECT record_id FROM captured_record_heads WHERE session_id=? AND epoch=? AND activity=1 ORDER BY first_sequence DESC LIMIT 200)
   UNION ALL SELECT record_id FROM (SELECT record_id FROM captured_record_heads WHERE session_id=? AND epoch=? AND activity=0 AND kind='user_message' ORDER BY first_sequence DESC LIMIT 200)
   UNION ALL SELECT record_id FROM (SELECT record_id FROM captured_record_heads WHERE session_id=? AND epoch=? AND activity=0 AND kind!='user_message' ORDER BY first_sequence DESC LIMIT 200))
  ORDER BY h.first_sequence`).all(id, stream.epoch, id, stream.epoch, id, stream.epoch, id, stream.epoch).map(decode);
  return { agentSessionId: id, revision: stream.revision, items: rows.map(row => row.item), stream: { ...stream,
      positions: rows.map(({ item, ...position }) => ({ id: item.id, ...position })) } };
}
