import type { MoteMainPeriod, MoteMainTransitionPreparation } from './mote-main-period.js'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from './errors.js'
import { parseMoteDialogueLink, sameMoteDialogue, moteDialogueSelection, type MoteDialogueLink, type MoteDialogueRead } from './mote-dialogue-contract.js'
import type { MoteDialogueIdentity } from './mote-dialogue.js'

const applicationId = 0x414d444c
const key = (identity: MoteDialogueIdentity) => JSON.stringify([identity.hostId, identity.moteId])
type Source = MoteDialogueLink extends infer T ? T extends MoteDialogueLink ? Omit<T, 'sequence' | 'operationId' | 'identity'> : never : never
/** Indexed source relationships only. No current role, conversation body or task state is stored here. */
export class MoteDialogueStore {
  constructor(readonly path: string) {}
  private async open(write = false): Promise<DatabaseSync | null> {
    let exists = true
    try { await stat(this.path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false }
    if (!exists && !write) return null
    if (!exists) await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.path, { readOnly: !write })
    try {
      if (!exists) {
        db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
        const existingId = db.prepare('PRAGMA application_id').get()?.application_id
        if (existingId !== applicationId && (existingId !== 0 || db.prepare("SELECT 1 FROM sqlite_master WHERE type='table'").get()))
          throw new AgentMuxError('Another original store occupies the source journal path. Its bytes are retained.', 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
        db.exec(`PRAGMA application_id=${applicationId};
          CREATE TABLE IF NOT EXISTS metadata (incarnation TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS operations (mote_key TEXT NOT NULL, operation_id TEXT NOT NULL, intent TEXT NOT NULL, PRIMARY KEY(mote_key,operation_id));
          CREATE TABLE IF NOT EXISTS links (sequence INTEGER PRIMARY KEY AUTOINCREMENT, mote_key TEXT NOT NULL, kind TEXT NOT NULL, event_id TEXT, operation_id TEXT NOT NULL, json TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS links_scope ON links(mote_key,sequence);
          CREATE INDEX IF NOT EXISTS links_kind ON links(mote_key,kind,sequence);
          CREATE INDEX IF NOT EXISTS links_event ON links(mote_key,event_id,sequence);
          CREATE INDEX IF NOT EXISTS links_operation ON links(mote_key,operation_id,sequence);`)
        if (!db.prepare('SELECT incarnation FROM metadata').get()) db.prepare('INSERT INTO metadata VALUES (?)').run(randomUUID())
        db.exec('COMMIT')
      }
      if (db.prepare('PRAGMA application_id').get()?.application_id !== applicationId || !db.prepare('SELECT incarnation FROM metadata').get()?.incarnation)
        throw new AgentMuxError('The original Mote source journal is unconfirmed. Preserve it and retry its original owner.', 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
      if (write) db.exec(`CREATE TABLE IF NOT EXISTS role_transitions (mote_key TEXT NOT NULL,operation_id TEXT NOT NULL,digest TEXT NOT NULL,json TEXT NOT NULL,confirmed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(mote_key,operation_id)); CREATE INDEX IF NOT EXISTS role_transition_scope ON role_transitions(mote_key,confirmed); CREATE INDEX IF NOT EXISTS role_transition_after ON role_transitions(mote_key,json_extract(json,'$.after.roleRevision')); CREATE INDEX IF NOT EXISTS role_transition_before ON role_transitions(mote_key,json_extract(json,'$.before.roleRevision'));`)
      return db
    } catch (error) { db.close(); throw error }
  }
  private links(db: DatabaseSync, identity: MoteDialogueIdentity, operationId: string): MoteDialogueLink[] {
    const links = db.prepare('SELECT sequence,json FROM links WHERE mote_key=? AND operation_id=? ORDER BY sequence DESC').all(key(identity), operationId)
      .map(row => parseMoteDialogueLink({ ...JSON.parse(String(row.json)), sequence: Number(row.sequence) }))
    if (links.some(link => !sameMoteDialogue(link.identity, identity) || link.operationId !== operationId))
      throw new AgentMuxError('The original source relationship belongs to another Mote or operation. Its journal is retained.', 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
    return links
  }
  async inspect(identity: MoteDialogueIdentity, operationId: string, intent?: string): Promise<MoteDialogueLink[] | null> {
    const db = await this.open()
    if (!db) return null
    try {
      const original = db.prepare('SELECT intent FROM operations WHERE mote_key=? AND operation_id=?').get(key(identity), operationId)
      if (!original) return null
      if (intent !== undefined && !isDeepStrictEqual(JSON.parse(String(original.intent)), JSON.parse(intent))) throw new AgentMuxError('This Mote association operation already has another original source.', 'MOTE_DIALOGUE_OPERATION_CONFLICT')
      return this.links(db, identity, operationId)
    } finally { db.close() }
  }
  async append(identity: MoteDialogueIdentity, operationId: string, intent: string, sources: Source[]): Promise<MoteDialogueLink[]> {
    const db = (await this.open(true))!
    try {
      db.exec('BEGIN IMMEDIATE')
      const original = db.prepare('SELECT intent FROM operations WHERE mote_key=? AND operation_id=?').get(key(identity), operationId)
      if (original) {
        if (!isDeepStrictEqual(JSON.parse(String(original.intent)), JSON.parse(intent))) throw new AgentMuxError('This Mote association operation already has another original source.', 'MOTE_DIALOGUE_OPERATION_CONFLICT')
        db.exec('COMMIT'); return this.links(db, identity, operationId)
      }
      db.prepare('INSERT INTO operations VALUES (?,?,?)').run(key(identity), operationId, intent)
      for (const source of sources) {
        const link = { ...source, identity, operationId }
        parseMoteDialogueLink({ ...link, sequence: 1 })
        db.prepare('INSERT INTO links(mote_key,kind,event_id,operation_id,json) VALUES (?,?,?,?,?)')
          .run(key(identity), link.kind, link.kind === 'work' ? link.eventId : null, operationId, JSON.stringify(link))
      }
      db.exec('COMMIT')
      return this.links(db, identity, operationId)
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error }
    finally { db.close() }
  }
  async transition(identity: MoteDialogueIdentity, operationId: string, digest?: string): Promise<MoteMainTransitionPreparation|null> {
    const db=await this.open();if(!db)return null
    try {
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_transitions'").get())return null
      const row=db.prepare('SELECT digest,json FROM role_transitions WHERE mote_key=? AND operation_id=?').get(key(identity),operationId)
      if(!row)return null
      if(digest!==undefined&&row.digest!==digest)throw new AgentMuxError('The original role transition already names another intent.','MOTE_DIALOGUE_OPERATION_CONFLICT')
      return JSON.parse(String(row.json)) as MoteMainTransitionPreparation
    } finally {db.close()}
  }
  async prepareTransition(value: MoteMainTransitionPreparation): Promise<MoteMainTransitionPreparation> {
    const db=(await this.open(true))!
    try {
      db.exec('BEGIN IMMEDIATE')
      const row=db.prepare('SELECT digest,json FROM role_transitions WHERE mote_key=? AND operation_id=?').get(key(value.identity),value.marker.operationId)
      if(row) {if(row.digest!==value.marker.intentDigest)throw new AgentMuxError('The original role transition already names another intent.','MOTE_DIALOGUE_OPERATION_CONFLICT');db.exec('COMMIT');return JSON.parse(String(row.json))}
      db.prepare('INSERT INTO role_transitions(mote_key,operation_id,digest,json) VALUES (?,?,?,?)').run(key(value.identity),value.marker.operationId,value.marker.intentDigest,JSON.stringify(value));db.exec('COMMIT');return value
    } catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error} finally{db.close()}
  }
  async confirmTransition(identity:MoteDialogueIdentity, marker:import('./mote-preferences.js').MoteMainTransitionMarker, roleRevision:string, reference:import('./mote-preferences.js').MoteDefaultConversation|null) {
    const original=await this.transition(identity,marker.operationId,marker.intentDigest)
    if(!original||original.after.roleRevision!==roleRevision||!isDeepStrictEqual(original.after.reference,reference)||!isDeepStrictEqual(original.marker,marker))throw new AgentMuxError('The saved role does not confirm this original transition.','MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
    const db=(await this.open(true))!;try{db.prepare('UPDATE role_transitions SET confirmed=1 WHERE mote_key=? AND operation_id=?').run(key(identity),marker.operationId)}finally{db.close()}
  }
  private period(db:DatabaseSync, identity:MoteDialogueIdentity, link:Extract<MoteDialogueLink,{kind:'main'}>, current?:import('./mote-dialogue.js').MoteMainSnapshot):MoteMainPeriod|undefined {
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_transitions'").get())return undefined
    const rows=db.prepare("SELECT json FROM role_transitions WHERE mote_key=? AND json_extract(json,'$.after.roleRevision')=? AND (confirmed=1 OR operation_id=?) UNION ALL SELECT json FROM role_transitions WHERE mote_key=? AND json_extract(json,'$.before.roleRevision')=? AND (confirmed=1 OR operation_id=?)").all(key(identity),link.roleRevision,current?.transition?.operationId??'',key(identity),link.roleRevision,current?.transition?.operationId??'')
    const transitions=rows.map(row=>JSON.parse(String(row.json)) as MoteMainTransitionPreparation).filter(t=>t.marker.operationId!==current?.transition?.operationId||t.marker.intentDigest===current.transition.intentDigest&&t.after.roleRevision===current.roleRevision&&isDeepStrictEqual(t.after.reference,current.current))
    const start=transitions.find(t=>t.after.roleRevision===link.roleRevision),end=transitions.find(t=>t.before.roleRevision===link.roleRevision)
    if(!start&&!end)return undefined
    const after=start?.afterCut??null,through=end?.beforeCut??null
    const issue=[start?.issue,end?.issue].filter(Boolean).join('\n')
    return {id:JSON.stringify([identity.hostId,identity.moteId,link.roleRevision]),roleRevision:link.roleRevision,reference:link.reference,
      startedAt:start?.marker.effectiveAt??null,endedAt:end?.marker.effectiveAt??null,start:start?.cause??null,end:end?.cause??null,
      range:after&&start?.afterQualified!==false&&(!end||through)&&(!through||after.sourceHostId===through.sourceHostId&&isDeepStrictEqual(after.frontier.scope,through.frontier.scope))?{kind:'bounded',after,through}:start?{kind:'unconfirmed',issue:issue||'The exact original source boundary is unconfirmed. Keep its original Session.'}:{kind:'whole-session'}}
  }
  async read(identity: MoteDialogueIdentity, query: MoteDialogueRead, current?:import('./mote-dialogue.js').MoteMainSnapshot) {
    const db = await this.open()
    if (!db) {
      if (query.cursor) throw new AgentMuxError('The original Mote source journal is unavailable. Keep its cursor and references.', 'MOTE_DIALOGUE_SOURCE_CHANGED')
      return { links: [] as MoteDialogueLink[], incarnation: null, throughSequence: 0, next: null }
    }
    try {
      const incarnation = String(db.prepare('SELECT incarnation FROM metadata').get()!.incarnation)
      if (query.cursor && (!sameMoteDialogue(query.cursor.identity, identity) || query.cursor.incarnation !== incarnation || query.cursor.selection !== moteDialogueSelection(query)))
        throw new AgentMuxError('The original Mote source cursor belongs to another journal or Mote. Keep the original view.', 'MOTE_DIALOGUE_SOURCE_CHANGED')
      const throughSequence = query.cursor?.throughSequence ?? Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM links WHERE mote_key=?').get(key(identity))!.n)
      const clauses = ['mote_key=?', 'sequence<=?'], args: (string | number)[] = [key(identity), throughSequence]
      if (query.cursor) { clauses.push('sequence<?'); args.push(query.cursor.beforeSequence) }
      if (query.kind) { clauses.push('kind=?'); args.push(query.kind) }
      if (query.eventId) { clauses.push('event_id=?'); args.push(query.eventId) }
      if (query.operationId) { clauses.push('operation_id=?'); args.push(query.operationId) }
      const rows = db.prepare(`SELECT sequence,json FROM links WHERE ${clauses.join(' AND ')} ORDER BY sequence DESC LIMIT ?`).all(...args, (query.limit ?? 50) + 1)
      const links = rows.slice(0, query.limit ?? 50).map(row => {const link=parseMoteDialogueLink({ ...JSON.parse(String(row.json)), sequence: Number(row.sequence) });const period=link.kind==='main'?this.period(db,identity,link,current):undefined;return period?{...link,period}:link})
      return { links, incarnation, throughSequence, next: rows.length > links.length ? { identity, incarnation, selection: moteDialogueSelection(query), throughSequence, beforeSequence: links.at(-1)!.sequence } : null }
    } finally { db.close() }
  }
}
