import { mintObjectId } from './object-id.js'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, link, mkdir, open, rename, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentMuxMessageJournalRecord } from './agent-global-message-queue.js'
import { agentInputJournalKey, validateAgentInputDeliveryKey, validateAgentInputWaitRef } from './agent-input-wait.js'

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

/** Internal projections in the original validated journal/writer transaction. */
export const inputControlJournalSchema = `
  CREATE TABLE IF NOT EXISTS input_intents (
    input_id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL,
    intent_sequence INTEGER NOT NULL UNIQUE, control_sequence INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS input_recipient_order ON input_intents(recipient_id, intent_sequence);
  CREATE INDEX IF NOT EXISTS input_recipient_control ON input_intents(recipient_id, control_sequence);
  CREATE TABLE IF NOT EXISTS input_stops (
    input_id TEXT NOT NULL, generation INTEGER NOT NULL,
    cancel_operation_id TEXT NOT NULL, sequence INTEGER NOT NULL UNIQUE,
    PRIMARY KEY(input_id, generation, cancel_operation_id)
  );
`

/** Delivery aliases are rebuildable positions over immutable original dispatch gates. */
export function initializeInputDeliveryIndex(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='input_delivery_bindings'").get()) {
    // The old derived index allowed only one actual delivery per logical input.
    // Rebuild this position index from immutable gates; no source input or receipt is removed.
    if (!db.prepare("PRAGMA index_list('input_delivery_bindings')").all().some(index => index.origin === 'u')) return
    db.exec('DROP TABLE input_delivery_bindings')
  }
  db.exec('CREATE TABLE input_delivery_bindings (delivery_id TEXT PRIMARY KEY, input_id TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO input_delivery_bindings VALUES (?, ?)')
  for (const row of db.prepare(`SELECT json FROM records WHERE json_extract(json, '$.kind')='input-control'
    AND json_extract(json, '$.control.deliveryKey') IS NOT NULL ORDER BY sequence`).all()) {
    const control = (JSON.parse(String(row.json)) as Extract<AgentMuxMessageJournalRecord, { kind: 'input-control' }>).control
    const ref = validateAgentInputWaitRef(control.ref), key = validateAgentInputDeliveryKey(ref.key, control.deliveryKey)
    insert.run(agentInputJournalKey(key), agentInputJournalKey(ref.key))
  }
}

/** Pending positions over the original input journal; no content or execution authorization is copied. */
export function initializeInputWaitingIndex(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='input_waiting'").get()) return
  db.exec(`CREATE TABLE input_waiting (
    input_id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, intent_sequence INTEGER NOT NULL UNIQUE
  );
  CREATE INDEX input_waiting_recipient ON input_waiting(recipient_id, intent_sequence);
  INSERT INTO input_waiting
    SELECT i.input_id, i.recipient_id, i.intent_sequence FROM input_intents i
      JOIN records original ON original.sequence=i.intent_sequence
      JOIN records latest ON latest.sequence=i.control_sequence
      WHERE json_extract(original.json, '$.kind')='input-intent'
        AND json_extract(original.json, '$.intent.source.kind')='prompt'
        AND json_extract(original.json, '$.intent.source.authorHuman')=1
        AND json_extract(original.json, '$.intent.source.recoveryAuthorization')='local-human'
        AND json_extract(original.json, '$.intent.admissionIntent.kind')='manual-actor'
        AND COALESCE(json_extract(latest.json, '$.control.state'), 'enabled')='enabled';`)
}

/** The source freezes routing before a remote effect; the target alone owns the message. */
export const messageRouteJournalSchema = `
  CREATE TABLE IF NOT EXISTS message_routes (
    message_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, sequence INTEGER NOT NULL UNIQUE
  );
`

/** Derived positions over the same journal. Historical messages are never backfilled or reclassified. */
export const messageNotificationJournalSchema = `
  CREATE TABLE IF NOT EXISTS a2a_message_notifications (
    message_id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, run_id TEXT NOT NULL,
    message_sequence INTEGER NOT NULL UNIQUE, notification_id TEXT, submitted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS a2a_notifications_waiting ON a2a_message_notifications(recipient_id, run_id, message_sequence)
    WHERE submitted=0 AND notification_id IS NULL;
  CREATE INDEX IF NOT EXISTS a2a_notifications_pending ON a2a_message_notifications(recipient_id) WHERE submitted=0;
  CREATE TABLE IF NOT EXISTS a2a_notifications (
    notification_id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, run_id TEXT NOT NULL,
    original_sequence INTEGER NOT NULL UNIQUE, result_sequence INTEGER, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS a2a_notification_unfinished ON a2a_notifications(recipient_id, run_id) WHERE active=1;
  CREATE INDEX IF NOT EXISTS a2a_notification_messages ON a2a_message_notifications(notification_id);
`

/** Derived unresolved reference links over original notices/results, including pre-existing journals. */
export function initializeMessageNotificationReferenceIndex(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='a2a_unresolved_notification_references'").get()) return
  db.exec(`CREATE TABLE a2a_unresolved_notification_references (
    message_id TEXT NOT NULL, notification_id TEXT NOT NULL, original_sequence INTEGER NOT NULL,
    PRIMARY KEY(message_id, notification_id)) WITHOUT ROWID;
    CREATE INDEX a2a_unresolved_notification_by_notice ON a2a_unresolved_notification_references(notification_id);
    INSERT INTO a2a_unresolved_notification_references
      SELECT refs.value, n.notification_id, n.original_sequence FROM a2a_notifications n
      JOIN records original ON original.sequence=n.original_sequence
      LEFT JOIN records result ON result.sequence=n.result_sequence,
      json_each(original.json, '$.notification.messageIds') refs
      WHERE n.result_sequence IS NULL OR json_extract(result.json, '$.state')='unconfirmed';
    CREATE TRIGGER a2a_unresolved_notification_insert AFTER INSERT ON records
      WHEN json_extract(NEW.json, '$.kind')='a2a-notification'
      BEGIN INSERT OR IGNORE INTO a2a_unresolved_notification_references
        SELECT value, json_extract(NEW.json, '$.notification.notificationId'), NEW.sequence
        FROM json_each(NEW.json, '$.notification.messageIds'); END;
    CREATE TRIGGER a2a_unresolved_notification_result AFTER INSERT ON records
      WHEN json_extract(NEW.json, '$.kind')='a2a-notification-result' AND json_extract(NEW.json, '$.state') IN ('submitted','not-applied')
      BEGIN DELETE FROM a2a_unresolved_notification_references WHERE notification_id=json_extract(NEW.json, '$.notificationId'); END;`)
}

/** Future sequence positions only: no history backfill, copied message or consumption state. */
export const messageObservationJournalSchema = `
  CREATE TABLE IF NOT EXISTS message_observation_records (sequence INTEGER PRIMARY KEY);
  CREATE TRIGGER IF NOT EXISTS message_observation_record_insert AFTER INSERT ON records
    WHEN (json_extract(NEW.json, '$.kind') = 'message'
      AND json_extract(NEW.json, '$.envelope.sender.kind') = 'agent-session'
      AND json_extract(NEW.json, '$.envelope.recipient.kind') = 'agent-session')
    OR (json_extract(NEW.json, '$.kind') IN ('delivery', 'delivery-issue') AND EXISTS (
      SELECT 1 FROM messages m JOIN records original ON original.sequence=m.message_sequence
      WHERE m.message_id=json_extract(NEW.json, '$.messageId')
        AND json_extract(original.json, '$.envelope.sender.kind') = 'agent-session'
        AND json_extract(original.json, '$.envelope.recipient.kind') = 'agent-session'))
    BEGIN INSERT INTO message_observation_records VALUES (NEW.sequence); END;
  CREATE TRIGGER IF NOT EXISTS message_notification_observation_record_insert AFTER INSERT ON records
    WHEN json_extract(NEW.json, '$.kind') IN ('a2a-notification', 'a2a-notification-result')
    BEGIN INSERT INTO message_observation_records VALUES (NEW.sequence); END;
  CREATE TRIGGER IF NOT EXISTS message_dispatch_observation_record_insert AFTER INSERT ON records
    WHEN json_extract(NEW.json, '$.kind') IN ('dispatch-open', 'dispatch-event')
    BEGIN INSERT INTO message_observation_records VALUES (NEW.sequence); END;
`

export const messageObservationQuery = `WITH changed AS (
  SELECT position.sequence, json_extract(r.json, '$.kind') AS record_kind,
    COALESCE(json_extract(r.json, '$.envelope.messageId'), json_extract(r.json, '$.messageId'), json_extract(r.json, '$.sourceMessageId')) AS message_id,
    COALESCE(json_extract(r.json, '$.notification.notificationId'), json_extract(r.json, '$.notificationId')) AS notification_id
  FROM message_observation_records position JOIN records r ON r.sequence=position.sequence
  WHERE position.sequence > ? AND position.sequence <= ? ORDER BY position.sequence LIMIT 100),
  expanded AS (
    SELECT sequence, record_kind, message_id FROM changed WHERE message_id IS NOT NULL
    UNION ALL
    SELECT changed.sequence, changed.record_kind, reference.value AS message_id FROM changed
      JOIN a2a_notifications n ON n.notification_id=changed.notification_id
      JOIN records original ON original.sequence=n.original_sequence, json_each(original.json, '$.notification.messageIds') reference)
  SELECT expanded.sequence, expanded.record_kind, expanded.message_id, m.message_sequence,
    json_extract(original.json, '$.envelope.senderSessionId') AS sender_id,
    json_extract(original.json, '$.envelope.recipientSessionId') AS recipient_id,
    json_extract(original.json, '$.envelope.sender.kind') AS sender_kind,
    json_extract(original.json, '$.envelope.recipient.kind') AS recipient_kind
  FROM expanded CROSS JOIN messages m ON m.message_id=expanded.message_id
    JOIN records original ON original.sequence=m.message_sequence ORDER BY expanded.sequence`


/** The original records remain the SSOT. These indexes select one participant's messages. */
export const dispatchDiscoveryJournalSchema = `
  CREATE INDEX IF NOT EXISTS message_sender ON records(json_extract(json, '$.envelope.senderSessionId'))
    WHERE json_extract(json, '$.kind') = 'message';
  CREATE INDEX IF NOT EXISTS message_recipient ON records(json_extract(json, '$.envelope.recipientSessionId'))
    WHERE json_extract(json, '$.kind') = 'message';
`

/** Batch intent and target positions over the same original journal; no delivery engine or copied message. */
export const messageBroadcastJournalSchema = `
  CREATE TABLE IF NOT EXISTS message_broadcasts (operation_id TEXT PRIMARY KEY, original_sequence INTEGER NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS message_broadcast_targets (
    operation_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE,
    claim_sequence INTEGER, result_sequence INTEGER, PRIMARY KEY(operation_id, session_id));
`

/** SQLite has no array expression index. These are rebuildable positions, never message facts. */
function messageEventPositions(source: string): string {
  return `WITH event(sequence, payload) AS (${source}), refs AS (
    SELECT sequence, COALESCE(json_extract(payload, '$.messageId'), json_extract(payload, '$.sourceMessageId'), json_extract(payload, '$.envelope.messageId')) AS mid
      FROM event WHERE json_extract(payload, '$.kind') IN ('message','delivery','delivery-issue','dispatch-open','dispatch-event')
    UNION SELECT event.sequence, ref.value FROM event JOIN json_each(CASE json_extract(event.payload, '$.kind')
      WHEN 'a2a-notification' THEN json_extract(event.payload, '$.notification.messageIds')
      WHEN 'a2a-notification-result' THEN (SELECT json_extract(original.json, '$.notification.messageIds')
        FROM a2a_notifications n JOIN records original ON original.sequence=n.original_sequence
        WHERE n.notification_id=json_extract(event.payload, '$.notificationId')) ELSE '[]' END) ref)
    SELECT refs.sequence AS event_sequence, m.message_id,
      json_extract(original.json, '$.envelope.senderSessionId') AS sender,
      json_extract(original.json, '$.envelope.recipientSessionId') AS recipient
    FROM refs JOIN messages m ON m.message_id=refs.mid JOIN records original ON original.sequence=m.message_sequence
    WHERE json_extract(original.json, '$.envelope.sender.kind')='agent-session'
      AND json_extract(original.json, '$.envelope.recipient.kind')='agent-session'
      AND json_extract(original.json, '$.envelope.sender.agentSessionId')=json_extract(original.json, '$.envelope.senderSessionId')
      AND json_extract(original.json, '$.envelope.recipient.agentSessionId')=json_extract(original.json, '$.envelope.recipientSessionId')`
}
const messageEventRows = (source: string) => `WITH positions AS (${messageEventPositions(source)})
  SELECT sender, event_sequence, message_id FROM positions UNION SELECT recipient, event_sequence, message_id FROM positions`

/** Initialize a physical index once under the original writer transaction; original records never change. */
export function initializeMessageEventIndex(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_event_positions'").get()) {
    db.exec('CREATE INDEX IF NOT EXISTS message_event_by_message ON message_event_positions(participant_id, message_id, event_sequence)')
    return
  }
  db.exec(`CREATE TABLE message_event_positions (
    participant_id TEXT NOT NULL, event_sequence INTEGER NOT NULL, message_id TEXT NOT NULL,
    PRIMARY KEY(participant_id, event_sequence, message_id)) WITHOUT ROWID`)
  db.exec('CREATE INDEX message_event_by_message ON message_event_positions(participant_id, message_id, event_sequence)')
  db.exec(`INSERT OR IGNORE INTO message_event_positions ${messageEventRows('SELECT sequence, json FROM records')}`)
  // The trigger consumes exactly the new record and its original message/notification key.
  // Same transaction as append; rollback cannot publish a partial historical index or miss a concurrent append.
  db.exec(`CREATE TRIGGER message_event_position_insert AFTER INSERT ON records
    WHEN json_extract(NEW.json, '$.kind') IN ('message','delivery','delivery-issue','dispatch-open','dispatch-event','a2a-notification','a2a-notification-result')
    BEGIN INSERT OR IGNORE INTO message_event_positions SELECT * FROM (${messageEventRows('SELECT NEW.sequence, NEW.json')}); END`)
}

/** Explicit Dispatch reads select the original reply lineage, without scanning other messages. */
export const dispatchReplyJournalSchema = `
  CREATE INDEX IF NOT EXISTS message_reply_chain ON records(
    json_extract(json, '$.envelope.replyTo'), json_extract(json, '$.envelope.threadId'),
    json_extract(json, '$.envelope.senderSessionId'), json_extract(json, '$.envelope.recipientSessionId'))
    WHERE json_extract(json, '$.kind') = 'message';
`

export function configureMessageJournal(db: DatabaseSync): void {
  // DELETE + EXTRA keeps SQLite's atomic rollback protocol and its directory-sync ACK.
  // No synchronous busy wait may occupy the terminal/Hook event loop.
  db.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA')
}

/** Open only while holding the original writer mutex; a reader must not race a DELETE-mode commit. */
export async function openMessageJournalSnapshot(path: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 0; BEGIN')
    if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId ||
        db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('The original AgentMux message journal is unconfirmed.')
    return db
  } catch (error) { db.close(); throw error }
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
  const candidate = `${archive}.${process.pid}.${mintObjectId()}.tmp`
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
  const candidate = `${path}.${process.pid}.${mintObjectId()}.tmp`
  const incarnation = mintObjectId()
  let db: DatabaseSync | undefined
  let published = false
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const reservation = await open(candidate, 'wx', 0o600); await reservation.close()
    db = new DatabaseSync(candidate)
    configureMessageJournal(db)
    db.exec('BEGIN IMMEDIATE')
    db.exec(schema)
    db.exec(inputControlJournalSchema)
    initializeInputDeliveryIndex(db)
    initializeInputWaitingIndex(db)
    db.exec(messageBroadcastJournalSchema)
    db.exec(messageRouteJournalSchema)
    db.exec(messageNotificationJournalSchema)
    initializeMessageNotificationReferenceIndex(db)
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
