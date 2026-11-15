import { createHash } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AgentMuxError, parseMoteGroupMessage, parseMoteGroupSummary, type MoteGroupDelivery,
  type MoteGroupMember, type MoteGroupMessage, type MoteGroupSettings, type MoteGroupSummary } from '@agentmux/core'
import { sameMotePreferencesTarget, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { MoteChatPreparedLaunch } from '@agentmux/connectors'

const applicationId = 0x414d4752
export type GroupInputKey = { kind: 'prompt'; agentSessionId: string; expectedRun: { runId: string }; submissionId: string }
export type GroupDeliveryRecord = {
  delivery: MoteGroupDelivery
  key?: GroupInputKey
  note?: string
  inputEpoch?: string
  memberGeneration?: string
}
type GroupInvitation = {
  operationId: string
  announcement: MoteGroupSettings['announcement']
  createdAt: number
  input?: GroupDeliveryRecord
}
export type GroupMemberRecord = { member: MoteGroupMember; prepared?: MoteChatPreparedLaunch; invitation?: GroupInvitation }
type GroupSettingsChange = { avatarMoteIds?: string[]; announcement?: string | null;
  topic?: MotePreferencesTarget | null; adminMoteIds?: string[] }
type GroupChange = { kind: 'settings'; settings: GroupSettingsChange } | { kind: 'invite'; members: MoteGroupMember[] }
  | { kind: 'remove'; moteIds: string[] } | { kind: 'leave' }
type GroupMemberAuthority = { moteId: string; generation: string }

export const groupStableId = (kind: string, ...parts: string[]): string =>
  `mote-group-${kind}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`
export const groupMemberGeneration = (record: GroupMemberRecord): string => record.invitation?.operationId ?? 'original'
const defaults = (): MoteGroupSettings => ({ revision: 1, avatarMoteIds: [], announcement: null, topic: null })
type StoredMember = Omit<GroupMemberRecord, 'invitation'> & { invitationOperationId?: string }
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
      if (write) db.exec(`
        CREATE TABLE IF NOT EXISTS group_settings (group_id TEXT PRIMARY KEY REFERENCES groups(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS group_operations (group_id TEXT NOT NULL REFERENCES groups(id), operation_id TEXT NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(group_id,operation_id));
        CREATE TABLE IF NOT EXISTS group_invitations (operation_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, mote_id TEXT NOT NULL, data TEXT NOT NULL,
          FOREIGN KEY(group_id,mote_id) REFERENCES members(group_id,mote_id));`)
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

  private hasSettings(db: DatabaseSync): boolean {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_settings'").get())
  }

  private settings(db: DatabaseSync, groupId: SQLInputValue): MoteGroupSettings {
    const row = this.hasSettings(db) ? db.prepare('SELECT data FROM group_settings WHERE group_id=?').get(groupId) : undefined
    return row ? decode<MoteGroupSettings>(row.data) : defaults()
  }

  private memberRecord(db: DatabaseSync, groupId: SQLInputValue, value: SQLInputValue | undefined): GroupMemberRecord {
    const { invitationOperationId, ...record } = decode<StoredMember>(value)
    const member = { ...record.member, role: record.member.role ?? 'member', state: record.member.state ?? 'active' } as MoteGroupMember
    if (!invitationOperationId) return { ...record, member }
    const invitation = db.prepare('SELECT data FROM group_invitations WHERE group_id=? AND mote_id=? AND operation_id=?')
      .get(groupId, member.moteId, invitationOperationId)
    if (!invitation) return groupFailure('The original Group member invitation is unconfirmed.', 'MOTE_GROUP_STORE_UNCONFIRMED')
    return { ...record, member, invitation: decode<GroupInvitation>(invitation.data) }
  }

  private members(db: DatabaseSync, groupId: SQLInputValue): GroupMemberRecord[] {
    return db.prepare('SELECT data FROM members WHERE group_id=? ORDER BY rowid').all(groupId).map(row => this.memberRecord(db, groupId, row.data))
  }

  private group(db: DatabaseSync, row: Row): MoteGroupSummary {
    const recent = db.prepare('SELECT * FROM messages WHERE group_id=? ORDER BY sequence DESC LIMIT 1').get(row.id!)
    const members = this.members(db, row.id!).map(({ member, invitation }) =>
      invitation ? { ...member, invitation: invitation.input?.delivery ??
        { moteId: member.moteId, operationId: invitation.operationId, status: 'pending' } } : member)
    return parseMoteGroupSummary({ id: row.id, name: row.name, ...this.settings(db, row.id!), members,
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

  async create(id: string, operationId: string, digest: string, name: string, members: MoteGroupMember[],
    desired: GroupSettingsChange): Promise<MoteGroupSummary> {
    return this.write(db => {
      const prior = db.prepare('SELECT * FROM groups WHERE operation_id=?').get(operationId)
      if (prior) {
        if (prior.digest !== digest) return groupFailure('This Group creation operation already has another request.', 'MOTE_GROUP_OPERATION_CONFLICT')
        return this.group(db, prior)
      }
      db.prepare('INSERT INTO groups(id,operation_id,digest,name) VALUES (?,?,?,?)').run(id, operationId, digest, name)
      const records = members.map(member => ({ member }))
      const now = Date.now()
      const settings = this.applySettings(defaults(), desired, records, operationId, now)
      db.prepare('INSERT INTO group_settings(group_id,data) VALUES (?,?)').run(id, JSON.stringify(settings))
      for (const record of records) this.writeMember(db, id, this.invited(id, record, operationId, settings.announcement, now))
      return this.group(db, this.originalGroup(db, id))
    })
  }

  async list(moteId: string | undefined, before: number, limit: number): Promise<{ groups: MoteGroupSummary[]; nextBeforeSequence: number | null }> {
    return this.read({ groups: [], nextBeforeSequence: null }, db => {
      const rows = moteId === undefined
        ? db.prepare('SELECT * FROM groups WHERE sequence < ? ORDER BY sequence DESC LIMIT ?').all(before, limit + 1)
        : db.prepare(`SELECT groups.* FROM members JOIN groups ON groups.id=members.group_id
          WHERE members.mote_id=? AND coalesce(json_extract(members.data,'$.member.state'),'active')='active' AND groups.sequence < ? ORDER BY groups.sequence DESC LIMIT ?`).all(moteId, before, limit + 1)
      return { groups: rows.slice(0, limit).map(row => this.group(db, row)),
        nextBeforeSequence: rows.length > limit ? Number(rows[limit - 1]!.sequence) : null }
    })
  }

  async boundTopic(groupId: string): Promise<MotePreferencesTarget | null> {
    const result = await this.read(null, db => {
      this.originalGroup(db, groupId)
      return { topic: this.settings(db, groupId).topic }
    })
    return (result ?? groupFailure('The original Group was not found.', 'UNKNOWN_MOTE_GROUP')).topic
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

  private originalMember(db: DatabaseSync, groupId: string, moteId: string): GroupMemberRecord {
    const row = db.prepare('SELECT data FROM members WHERE group_id=? AND mote_id=?').get(groupId, moteId)
    return row ? this.memberRecord(db, groupId, row.data) : groupFailure('The original Mote is not a member of this Group.', 'UNKNOWN_MOTE_GROUP_MEMBER')
  }

  private assertActive(record: GroupMemberRecord, generation: string): void {
    if (record.member.state !== 'active' || groupMemberGeneration(record) !== generation)
      groupFailure('This invitation no longer authorizes new input or actions in the Group.', 'CONTROL_PERMISSION_DENIED')
  }

  async member(groupId: string, moteId: string): Promise<GroupMemberRecord> {
    const result = await this.read(null, db => this.originalMember(db, groupId, moteId))
    return result ?? groupFailure('The original Mote is not a member of this Group.', 'UNKNOWN_MOTE_GROUP_MEMBER')
  }

  async memberForThread(groupId: string, hostId: string, agentSessionId: string): Promise<GroupMemberRecord> {
    const result = await this.read(null, db => {
      const row = db.prepare(`SELECT data FROM members WHERE group_id=? AND json_extract(data,'$.member.thread.hostId')=?
        AND json_extract(data,'$.member.thread.agentSessionId')=?`).get(groupId, hostId, agentSessionId)
      return row ? this.memberRecord(db, groupId, row.data) : null
    })
    return result ?? groupFailure('This Agent does not own an original member Thread in this Group.', 'CONTROL_PERMISSION_DENIED')
  }

  private writeMember(db: DatabaseSync, groupId: string, record: GroupMemberRecord) {
    const { invitation, ...member } = record
    const stored = { ...member, ...(invitation ? { invitationOperationId: invitation.operationId } : {}) } satisfies StoredMember
    db.prepare(`INSERT INTO members(group_id,mote_id,data) VALUES (?,?,?) ON CONFLICT(group_id,mote_id) DO UPDATE SET data=excluded.data`)
      .run(groupId, record.member.moteId, JSON.stringify(stored))
    if (invitation) db.prepare(`INSERT INTO group_invitations(operation_id,group_id,mote_id,data) VALUES (?,?,?,?)
      ON CONFLICT(operation_id) DO UPDATE SET data=excluded.data`).run(invitation.operationId, groupId, record.member.moteId, JSON.stringify(invitation))
  }

  private invited(groupId: string, record: GroupMemberRecord, operationId: string, announcement: MoteGroupSettings['announcement'], createdAt: number) {
    return { ...record, invitation: { operationId: groupStableId('invitation', groupId, record.member.moteId, operationId), announcement, createdAt } }
  }

  private applySettings(settings: MoteGroupSettings, desired: GroupSettingsChange, records: GroupMemberRecord[], operationId: string, now: number): MoteGroupSettings {
    const active = records.filter(record => record.member.state === 'active')
    const requireActive = (ids: string[]) => {
      if (ids.some(id => !active.some(record => record.member.moteId === id)))
        groupFailure('Choose only current active Motes for this Group role or avatar.', 'UNKNOWN_MOTE_GROUP_MEMBER')
    }
    if (desired.adminMoteIds !== undefined) {
      requireActive(desired.adminMoteIds)
      for (const record of active) record.member = { ...record.member, role: desired.adminMoteIds.includes(record.member.moteId) ? 'admin' : 'member' }
    }
    const avatarMoteIds = desired.avatarMoteIds ?? settings.avatarMoteIds
    requireActive(avatarMoteIds)
    return { ...settings, avatarMoteIds, topic: desired.topic === undefined ? settings.topic : desired.topic,
      announcement: desired.announcement === undefined ? settings.announcement : desired.announcement === null ? null
        : { body: desired.announcement, operationId, updatedAt: now } }
  }

  private priorEdit(db: DatabaseSync, groupId: string, operationId: string, digest: string): MoteGroupSummary | null {
    if (!this.hasSettings(db)) return null
    const row = db.prepare('SELECT digest,data FROM group_operations WHERE group_id=? AND operation_id=?').get(groupId, operationId)
    if (!row) return null
    if (row.digest !== digest) return groupFailure('This Group settings operation already has another request.', 'MOTE_GROUP_OPERATION_CONFLICT')
    return parseMoteGroupSummary(decode(row.data))
  }

  async modified(groupId: string, operationId: string, digest: string): Promise<MoteGroupSummary | null> {
    return this.read(null, db => this.priorEdit(db, groupId, operationId, digest))
  }

  async modify(groupId: string, operationId: string, expectedRevision: number, digest: string,
    change: GroupChange, actor?: GroupMemberAuthority): Promise<MoteGroupSummary> {
    return this.write(db => {
      const row = this.originalGroup(db, groupId)
      const prior = this.priorEdit(db, groupId, operationId, digest)
      if (prior) return prior
      const records = this.members(db, groupId)
      if (actor) {
        const source = this.originalMember(db, groupId, actor.moteId)
        this.assertActive(source, actor.generation)
        if (change.kind !== 'leave' && source.member.role !== 'admin' ||
            change.kind === 'settings' && change.settings.adminMoteIds !== undefined)
          return groupFailure('This Group action requires its current administrator or workspace owner.', 'CONTROL_PERMISSION_DENIED')
        if (change.kind === 'remove' && change.moteIds.includes(actor.moteId))
          return groupFailure('Use the original member leave operation for your own Thread.', 'CONTROL_PERMISSION_DENIED')
      }
      let settings = this.settings(db, groupId)
      if (settings.revision !== expectedRevision)
        return groupFailure('This Group changed. Read its current settings before confirming a new operation.', 'MOTE_GROUP_REVISION_CONFLICT')
      const now = Date.now()
      if (change.kind === 'settings') {
        const { announcement, ...otherSettings } = change.settings
        const announcementChanged = announcement !== undefined && announcement !== (settings.announcement?.body ?? null)
        settings = this.applySettings(settings, announcementChanged ? change.settings : otherSettings, records, operationId, now)
        if (announcementChanged) {
          const id = groupStableId('announcement', groupId, operationId)
          const message = { id, groupId, createdAt: now, body: settings.announcement?.body ?? 'Group announcement cleared.',
            author: { kind: 'system' }, event: { kind: 'announcement-updated' } } satisfies MessageBody
          db.prepare('INSERT INTO messages(id,group_id,operation_id,digest,data) VALUES (?,?,?,?,?)').run(id, groupId, id, digest, JSON.stringify(message))
        }
      } else if (change.kind === 'invite') {
        for (const member of change.members) {
          const index = records.findIndex(record => record.member.moteId === member.moteId)
          const retained = records[index]
          if (retained?.member.state === 'active')
            return groupFailure('This Mote is already an active member. Keep the original invitation.', 'MOTE_GROUP_MEMBER_ALREADY_ACTIVE')
          if (retained && !sameMotePreferencesTarget(retained.member.target, member.target))
            return groupFailure('The invited Mote does not match its retained original Group target.', 'MOTE_GROUP_MEMBER_UNCONFIRMED')
          const record = this.invited(groupId, { ...retained, member: { ...member, thread: retained?.member.thread ?? null } }, operationId, settings.announcement, now)
          if (index < 0) records.push(record)
          else records[index] = record
        }
        const active = records.filter(record => record.member.state === 'active')
        if (active.length > 32) return groupFailure('Choose up to 32 active Motes for this Group.', 'INVALID_CONTROL_REQUEST')
      } else {
        if (change.kind === 'leave' && !actor)
          return groupFailure('Leaving a Group requires its own authenticated member Thread.', 'CONTROL_PERMISSION_DENIED')
        const ids = change.kind === 'leave' ? [actor!.moteId] : change.moteIds
        for (const id of ids) {
          const record = records.find(record => record.member.moteId === id)
          if (record?.member.state !== 'active')
            return groupFailure('The requested Mote is not currently active in this Group.', 'UNKNOWN_MOTE_GROUP_MEMBER')
          record.member = { ...record.member, state: change.kind === 'leave' ? 'left' : 'removed' }
        }
        const avatars = settings.avatarMoteIds.filter(id => !ids.includes(id))
        settings = this.applySettings({ ...settings, avatarMoteIds: avatars }, {}, records, operationId, now)
      }
      for (const record of records) this.writeMember(db, groupId, record)
      db.prepare(`INSERT INTO group_settings(group_id,data) VALUES (?,?) ON CONFLICT(group_id) DO UPDATE SET data=excluded.data`)
        .run(groupId, JSON.stringify({ ...settings, revision: settings.revision + 1 }))
      const group = this.group(db, row)
      db.prepare('INSERT INTO group_operations(group_id,operation_id,digest,data) VALUES (?,?,?,?)').run(groupId, operationId, digest, JSON.stringify(group))
      return group
    })
  }

  async saveMember(groupId: string, record: GroupMemberRecord): Promise<void> {
    await this.write(db => {
      const current = this.originalMember(db, groupId, record.member.moteId)
      this.assertActive(current, groupMemberGeneration(record))
      this.writeMember(db, groupId, { ...current, member: { ...current.member, thread: current.member.thread ?? record.member.thread },
        ...(current.prepared || record.prepared ? { prepared: current.prepared ?? record.prepared } : {}) })
    })
  }

  async saveInvitation(groupId: string, record: GroupDeliveryRecord): Promise<void> {
    await this.write(db => {
      const current = this.originalMember(db, groupId, record.delivery.moteId)
      this.assertActive(current, record.delivery.operationId)
      this.writeMember(db, groupId, { ...current, invitation: { ...current.invitation!, input: record } })
    })
  }

  async noteInvitationIssue(groupId: string, moteId: string, generation: string, issue: string): Promise<void> {
    await this.write(db => {
      const current = this.originalMember(db, groupId, moteId)
      const invitation = current.invitation
      if (current.member.state !== 'active' || invitation?.operationId !== generation ||
          invitation.input?.delivery.status === 'accepted') return
      const input: GroupDeliveryRecord = { ...invitation.input, memberGeneration: generation,
        delivery: { moteId, operationId: generation, status: 'unknown', issue } }
      this.writeMember(db, groupId, { ...current, invitation: { ...invitation, input } })
    })
  }

  private publishedMessage(db: DatabaseSync, groupId: string, operationId: string): StoredMessage | null {
    const row = db.prepare('SELECT * FROM messages WHERE group_id=? AND operation_id=?').get(groupId, operationId)
    return row ? { message: this.message(db, row), digest: String(row.digest) } : null
  }

  async messageOperation(groupId: string, operationId: string): Promise<StoredMessage | null> {
    return this.read(null, db => this.publishedMessage(db, groupId, operationId))
  }

  async append(operationId: string, digest: string, body: MessageBody, recipients: MoteGroupDelivery[], actor?: GroupMemberAuthority): Promise<{ message: MoteGroupMessage; fresh: boolean }> {
    return this.write(db => {
      this.originalGroup(db, body.groupId)
      const prior = this.publishedMessage(db, body.groupId, operationId)
      if (prior) {
        if (prior.digest !== digest) return groupFailure('This Group operation already has another original message.', 'MOTE_GROUP_OPERATION_CONFLICT')
        return { message: prior.message, fresh: false }
      }
      if (actor) this.assertActive(this.originalMember(db, body.groupId, actor.moteId), actor.generation)
      if (body.replyToMessageId && !db.prepare('SELECT id FROM messages WHERE group_id=? AND id=?').get(body.groupId, body.replyToMessageId))
        return groupFailure('The original reply message belongs to another Group or is unavailable.', 'UNKNOWN_MOTE_GROUP_MESSAGE')
      const selected = recipients.map(delivery => {
        const record = this.originalMember(db, body.groupId, delivery.moteId)
        const memberGeneration = groupMemberGeneration(record)
        this.assertActive(record, memberGeneration)
        return { delivery, memberGeneration } satisfies GroupDeliveryRecord
      })
      db.prepare('INSERT INTO messages(id,group_id,operation_id,digest,data) VALUES (?,?,?,?,?)')
        .run(body.id, body.groupId, operationId, digest, JSON.stringify(body))
      const insert = db.prepare('INSERT INTO deliveries(message_id,mote_id,operation_id,data) VALUES (?,?,?,?)')
      for (const record of selected) insert.run(body.id, record.delivery.moteId, record.delivery.operationId, JSON.stringify(record))
      return { message: this.publishedMessage(db, body.groupId, operationId)!.message, fresh: true }
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
