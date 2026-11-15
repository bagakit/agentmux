import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AgentMuxError, parseMoteGroupMessage, parseMoteGroupSummary, type MoteGroupDelivery,
  type MoteGroupMember, type MoteGroupMessage, type MoteGroupSummary } from '@agentmux/core'
import type { MoteChatPreparedLaunch } from '@agentmux/connectors'

const applicationId = 0x414d4752
export type GroupInputKey = { kind: 'prompt'; agentSessionId: string; expectedRun: { runId: string }; submissionId: string }
export type GroupDeliveryRecord = {
  delivery: MoteGroupDelivery
  key?: GroupInputKey
  note?: string
  inputEpoch?: string
}
export type GroupMemberRecord = { member: MoteGroupMember; prepared?: MoteChatPreparedLaunch }
type MessageBody = Omit<MoteGroupMessage, 'sequence' | 'deliveries'>
type StoredMessage = { message: MoteGroupMessage; digest: string }
type Row = Record<string, SQLInputValue>
const decode = <T>(value: SQLInputValue | undefined): T => JSON.parse(String(value)) as T
export const groupFailure = (message: string, code: string): never => { throw new AgentMuxError(message, code) }

/** One public stream, distinct member bindings and private delivery references. No provider output goes here. */
export class MoteGroupStore {
  constructor(readonly path: string) {}

  private async open(write: boolean): Promise<DatabaseSync | null> {
    let exists = true
    try { await stat(this.path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      exists = false
    }
    if (!exists && !write) return null
    if (!exists) await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.path, { readOnly: !write })
    try {
      if (write) db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON')
      if (!exists) {
        db.exec('BEGIN IMMEDIATE')
        const existing = db.prepare('PRAGMA application_id').get()?.application_id
        if (existing !== applicationId && (existing !== 0 || db.prepare("SELECT 1 FROM sqlite_master WHERE type='table'").get()))
          return groupFailure('The original Group store belongs to another application.', 'MOTE_GROUP_STORE_UNCONFIRMED')
        db.exec(`PRAGMA application_id=${applicationId};
          CREATE TABLE IF NOT EXISTS groups (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, name TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS members (group_id TEXT NOT NULL REFERENCES groups(id), mote_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(group_id,mote_id));
          CREATE INDEX IF NOT EXISTS groups_by_member ON members(mote_id,group_id);
          CREATE TABLE IF NOT EXISTS messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL REFERENCES groups(id), operation_id TEXT NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(group_id,operation_id));
          CREATE INDEX IF NOT EXISTS messages_by_group ON messages(group_id,sequence);
          CREATE TABLE IF NOT EXISTS deliveries (message_id TEXT NOT NULL REFERENCES messages(id), mote_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, PRIMARY KEY(message_id,mote_id));`)
        db.exec('COMMIT')
      }
      if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId)
        return groupFailure('The original Group store identity is unconfirmed.', 'MOTE_GROUP_STORE_UNCONFIRMED')
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  private async read<T>(empty: T, callback: (db: DatabaseSync) => T): Promise<T> {
    const db = await this.open(false)
    if (!db) return empty
    try { return callback(db) } finally { db.close() }
  }

  private async write<T>(callback: (db: DatabaseSync) => T): Promise<T> {
    const db = (await this.open(true))!
    try {
      db.exec('BEGIN IMMEDIATE')
      const result = callback(db)
      db.exec('COMMIT')
      return result
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    } finally { db.close() }
  }

  private message(db: DatabaseSync, row: Row): MoteGroupMessage {
    const deliveries = db.prepare('SELECT data FROM deliveries WHERE message_id=? ORDER BY rowid').all(row.id!)
      .map(entry => decode<GroupDeliveryRecord>(entry.data).delivery)
    const message = parseMoteGroupMessage({ ...decode<MessageBody>(row.data), sequence: row.sequence, deliveries })
    if (message.id !== row.id || message.groupId !== row.group_id)
      return groupFailure('The original public message has another Group identity.', 'MOTE_GROUP_STORE_UNCONFIRMED')
    return message
  }

  private group(db: DatabaseSync, row: Row): MoteGroupSummary {
    const memberRows = db.prepare('SELECT data FROM members WHERE group_id=? ORDER BY rowid').all(row.id!)
    const recent = db.prepare('SELECT * FROM messages WHERE group_id=? ORDER BY sequence DESC LIMIT 1').get(row.id!)
    return parseMoteGroupSummary({ id: row.id, name: row.name,
      members: memberRows.map(value => decode<GroupMemberRecord>(value.data).member),
      lastMessage: recent ? this.message(db, recent) : null })
  }

  private originalGroup(db: DatabaseSync, groupId: string): Row {
    return db.prepare('SELECT * FROM groups WHERE id=?').get(groupId)
      ?? groupFailure('The original Group was not found.', 'UNKNOWN_MOTE_GROUP')
  }

  async created(operationId: string, digest: string): Promise<MoteGroupSummary | null> {
    return this.read(null, db => {
      const row = db.prepare('SELECT * FROM groups WHERE operation_id=?').get(operationId)
      if (!row) return null
      if (row.digest !== digest) return groupFailure('This Group creation operation already has another request.', 'MOTE_GROUP_OPERATION_CONFLICT')
      return this.group(db, row)
    })
  }

  async create(id: string, operationId: string, digest: string, name: string, members: MoteGroupMember[]): Promise<MoteGroupSummary> {
    return this.write(db => {
      const prior = db.prepare('SELECT * FROM groups WHERE operation_id=?').get(operationId)
      if (prior) {
        if (prior.digest !== digest) return groupFailure('This Group creation operation already has another request.', 'MOTE_GROUP_OPERATION_CONFLICT')
        return this.group(db, prior)
      }
      db.prepare('INSERT INTO groups(id,operation_id,digest,name) VALUES (?,?,?,?)').run(id, operationId, digest, name)
      const insert = db.prepare('INSERT INTO members(group_id,mote_id,data) VALUES (?,?,?)')
      for (const member of members) insert.run(id, member.moteId, JSON.stringify({ member } satisfies GroupMemberRecord))
      return this.group(db, this.originalGroup(db, id))
    })
  }

  async list(moteId: string | undefined, before: number, limit: number): Promise<{ groups: MoteGroupSummary[]; nextBeforeSequence: number | null }> {
    return this.read({ groups: [], nextBeforeSequence: null }, db => {
      const rows = moteId === undefined
        ? db.prepare('SELECT * FROM groups WHERE sequence < ? ORDER BY sequence DESC LIMIT ?').all(before, limit + 1)
        : db.prepare('SELECT groups.* FROM members JOIN groups ON groups.id=members.group_id WHERE members.mote_id=? AND groups.sequence < ? ORDER BY groups.sequence DESC LIMIT ?').all(moteId, before, limit + 1)
      return { groups: rows.slice(0, limit).map(row => this.group(db, row)),
        nextBeforeSequence: rows.length > limit ? Number(rows[limit - 1]!.sequence) : null }
    })
  }

  async inspect(groupId: string, before: number, limit: number): Promise<{ group: MoteGroupSummary; messages: MoteGroupMessage[]; nextBeforeSequence: number | null }> {
    const result = await this.read(null, db => {
      const group = this.group(db, this.originalGroup(db, groupId))
      const rows = db.prepare('SELECT * FROM messages WHERE group_id=? AND sequence < ? ORDER BY sequence DESC LIMIT ?').all(groupId, before, limit + 1)
      return { group, messages: rows.slice(0, limit).reverse().map(row => this.message(db, row)),
        nextBeforeSequence: rows.length > limit ? Number(rows[limit - 1]!.sequence) : null }
    })
    return result ?? groupFailure('The original Group was not found.', 'UNKNOWN_MOTE_GROUP')
  }

  async messageById(groupId: string, messageId: string): Promise<MoteGroupMessage> {
    const result = await this.read(null, db => {
      const row = db.prepare('SELECT * FROM messages WHERE group_id=? AND id=?').get(groupId, messageId)
      return row ? this.message(db, row) : null
    })
    return result ?? groupFailure('The original public message was not found in this Group.', 'UNKNOWN_MOTE_GROUP_MESSAGE')
  }

  async member(groupId: string, moteId: string): Promise<GroupMemberRecord> {
    const result = await this.read(null, db => {
      const row = db.prepare('SELECT data FROM members WHERE group_id=? AND mote_id=?').get(groupId, moteId)
      return row ? decode<GroupMemberRecord>(row.data) : null
    })
    return result ?? groupFailure('The original Mote is not a member of this Group.', 'UNKNOWN_MOTE_GROUP_MEMBER')
  }

  async saveMember(groupId: string, record: GroupMemberRecord): Promise<void> {
    await this.write(db => {
      const result = db.prepare('UPDATE members SET data=? WHERE group_id=? AND mote_id=?')
        .run(JSON.stringify(record), groupId, record.member.moteId)
      if (result.changes !== 1) groupFailure('The original Group member binding is unconfirmed.', 'MOTE_GROUP_STORE_UNCONFIRMED')
    })
  }

  async append(operationId: string, digest: string, body: MessageBody, recipients: MoteGroupDelivery[]): Promise<{ message: MoteGroupMessage; fresh: boolean }> {
    return this.write(db => {
      this.originalGroup(db, body.groupId)
      const find = db.prepare('SELECT * FROM messages WHERE group_id=? AND operation_id=?')
      const prior = find.get(body.groupId, operationId)
      if (prior) {
        if (prior.digest !== digest) return groupFailure('This Group operation already has another original message.', 'MOTE_GROUP_OPERATION_CONFLICT')
        return { message: this.message(db, prior), fresh: false }
      }
      if (body.replyToMessageId && !db.prepare('SELECT id FROM messages WHERE group_id=? AND id=?').get(body.groupId, body.replyToMessageId))
        return groupFailure('The original reply message belongs to another Group or is unavailable.', 'UNKNOWN_MOTE_GROUP_MESSAGE')
      const readMember = db.prepare('SELECT data FROM members WHERE group_id=? AND mote_id=?')
      if (recipients.some(recipient => !readMember.get(body.groupId, recipient.moteId)))
        return groupFailure('A selected recipient is not a member of this Group.', 'UNKNOWN_MOTE_GROUP_MEMBER')
      db.prepare('INSERT INTO messages(id,group_id,operation_id,digest,data) VALUES (?,?,?,?,?)')
        .run(body.id, body.groupId, operationId, digest, JSON.stringify(body))
      const insert = db.prepare('INSERT INTO deliveries(message_id,mote_id,operation_id,data) VALUES (?,?,?,?)')
      for (const delivery of recipients) insert.run(body.id, delivery.moteId, delivery.operationId, JSON.stringify({ delivery } satisfies GroupDeliveryRecord))
      return { message: this.message(db, find.get(body.groupId, operationId)!), fresh: true }
    })
  }

  async delivery(gid: string, messageId: string, moteId: string): Promise<GroupDeliveryRecord | null> {
    return this.read(null, db => {
      const row = db.prepare('SELECT deliveries.data FROM deliveries JOIN messages ON messages.id=deliveries.message_id WHERE messages.group_id=? AND message_id=? AND mote_id=?').get(gid, messageId, moteId)
      return row ? decode<GroupDeliveryRecord>(row.data) : null
    })
  }

  async byInput(groupId: string, operationId: string): Promise<{ messageId: string; record: GroupDeliveryRecord } | null> {
    return this.read(null, db => {
      const row = db.prepare('SELECT message_id,deliveries.data FROM deliveries JOIN messages ON messages.id=deliveries.message_id WHERE messages.group_id=? AND deliveries.operation_id=?').get(groupId, operationId)
      return row ? { messageId: String(row.message_id), record: decode<GroupDeliveryRecord>(row.data) } : null
    })
  }

  async saveDelivery(messageId: string, record: GroupDeliveryRecord): Promise<void> {
    await this.write(db => {
      const updated = db.prepare('UPDATE deliveries SET data=? WHERE message_id=? AND mote_id=? AND operation_id=?')
        .run(JSON.stringify(record), messageId, record.delivery.moteId, record.delivery.operationId)
      if (updated.changes !== 1) groupFailure('The original Group delivery is unconfirmed.', 'MOTE_GROUP_STORE_UNCONFIRMED')
    })
  }
}
