import { AgentMuxError, type AgentMuxAgentCreateInput } from '@agentmux/core'
import { parseMoteChatConfiguration, parseMoteChatGeneration, parseMoteChatPerson, parseMoteChatResult, type MoteChatConfiguration, type MoteChatGeneration, type MoteChatOperation, type MoteChatPerson } from '@agentmux/core/mote-chat'
import { parseConnectionGrant, parseRoomBinding, type ConnectionActor, type ConnectionApplication, type ConnectionEnrollmentCallContext, type ConnectionGrant, type RoomBinding, type RoomBindingListInput } from '@agentmux/core/connections'
import type { DatabaseSync } from 'node:sqlite'

export type MoteChatPreparedLaunch = { executionHostId: string; input: AgentMuxAgentCreateInput }
export type MoteChatGenerationRow = {
  sequence: number
  laneKey: string
  connectionId: string
  configurationRevision: number
  authorizedBy: ConnectionEnrollmentCallContext['actor']
  generation: MoteChatGeneration
  prepared: MoteChatPreparedLaunch | null
  dispatched: boolean
  binding: RoomBinding | null
  grant: ConnectionGrant | null
}
export type MoteChatPersonRow = { key: string; spaceId: string; person: MoteChatPerson }
export type MoteChatAdmission = { ingressId: string; application: ConnectionApplication; externalMessageId: string; actor: ConnectionActor; externalConversationId: string; generationId: string }
const json = JSON.stringify
function generationRow(row: { sequence: unknown; snapshot_json: unknown }): MoteChatGenerationRow {
  const value = JSON.parse(String(row.snapshot_json)) as MoteChatGenerationRow
  return { ...value, sequence: Number(row.sequence), generation: parseMoteChatGeneration(value.generation),
    binding: value.binding === null ? null : parseRoomBinding(value.binding), grant: value.grant === null ? null : parseConnectionGrant(value.grant) }
}

/** The original connector transaction owns all route, count and reservation facts. No input queue. */
export class MoteChatStore {
  constructor(readonly database: DatabaseSync) {
    this.safe(() => database.exec(`
      CREATE TABLE IF NOT EXISTS mote_chat_configuration (space_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, domain TEXT, app_id TEXT, snapshot_json TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS mote_chat_enabled_application ON mote_chat_configuration(domain,app_id) WHERE enabled=1;
      CREATE TABLE IF NOT EXISTS mote_chat_operation (operation_id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, result_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mote_chat_configuration_authority ON mote_chat_operation(json_extract(result_json,'$.configuration.target.spaceId'),json_extract(result_json,'$.configuration.revision')) WHERE json_extract(result_json,'$.action')='configure';
      CREATE TABLE IF NOT EXISTS mote_chat_person (person_key TEXT PRIMARY KEY, space_id TEXT NOT NULL, snapshot_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mote_chat_person_space ON mote_chat_person(space_id,person_key);
      CREATE TABLE IF NOT EXISTS mote_chat_generation (sequence INTEGER PRIMARY KEY AUTOINCREMENT, generation_id TEXT NOT NULL UNIQUE, lane_key TEXT NOT NULL, space_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, binding_id TEXT NOT NULL UNIQUE, grant_id TEXT NOT NULL UNIQUE, snapshot_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mote_chat_generation_lane ON mote_chat_generation(lane_key,sequence DESC);
      CREATE INDEX IF NOT EXISTS mote_chat_generation_space ON mote_chat_generation(space_id,sequence DESC);
      CREATE INDEX IF NOT EXISTS mote_chat_generation_audience ON mote_chat_generation(space_id,json_extract(snapshot_json,'$.generation.application.domain'),json_extract(snapshot_json,'$.generation.application.appId'),json_extract(snapshot_json,'$.generation.externalConversationId'),sequence DESC);
      CREATE INDEX IF NOT EXISTS mote_chat_generation_connection ON mote_chat_generation(json_extract(snapshot_json,'$.connectionId'),sequence);
      CREATE TABLE IF NOT EXISTS mote_chat_admission (domain TEXT NOT NULL, app_id TEXT NOT NULL, message_id TEXT NOT NULL, ingress_id TEXT NOT NULL UNIQUE, snapshot_json TEXT NOT NULL, PRIMARY KEY(domain,app_id,message_id));
    `))
  }
  safe<T>(read: () => T): T {
    try { return read() } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw new AgentMuxError('Mote chat storage is unconfirmed. Keep the original message and operation; inspect them on the same Host. Existing Agents remain available.', 'MOTE_CHAT_STORAGE_UNCONFIRMED')
    }
  }
  transaction<T>(run: () => T): T {
    return this.safe(() => {
      this.database.exec('BEGIN IMMEDIATE')
      try { const value = run(); this.database.exec('COMMIT'); return value }
      catch (error) { try { this.database.exec('ROLLBACK') } catch { /* Unknown commit retains original operation and intake IDs. */ }; throw error }
    })
  }
  configuration(spaceId: string): MoteChatConfiguration | null {
    return this.safe(() => { const row = this.database.prepare('SELECT snapshot_json FROM mote_chat_configuration WHERE space_id=?').get(spaceId); return row ? parseMoteChatConfiguration(JSON.parse(String(row.snapshot_json))) : null })
  }
  route(application: ConnectionApplication): MoteChatConfiguration | null {
    return this.safe(() => { const row = this.database.prepare('SELECT snapshot_json FROM mote_chat_configuration WHERE enabled=1 AND domain=? AND app_id=?').get(application.domain, application.appId); return row ? parseMoteChatConfiguration(JSON.parse(String(row.snapshot_json))) : null })
  }
  saveConfiguration(c: MoteChatConfiguration): void {
    const app = c.values.connection?.application
    this.database.prepare('INSERT INTO mote_chat_configuration(space_id,enabled,domain,app_id,snapshot_json) VALUES(?,?,?,?,?) ON CONFLICT(space_id) DO UPDATE SET enabled=excluded.enabled,domain=excluded.domain,app_id=excluded.app_id,snapshot_json=excluded.snapshot_json').run(c.target.spaceId, Number(c.values.enabled), app?.domain ?? null, app?.appId ?? null, json(c))
  }
  operation(operationId: string): { intent: string; operation: MoteChatOperation } | null {
    return this.safe(() => { const row = this.database.prepare('SELECT intent_json,result_json FROM mote_chat_operation WHERE operation_id=?').get(operationId); return row ? { intent: String(row.intent_json), operation: parseMoteChatResult('space.mote.chat.inspect', { configuration: null, operation: JSON.parse(String(row.result_json)) }).operation! } : null })
  }
  saveOperation(intent: string, operation: MoteChatOperation): void {
    this.database.prepare('INSERT INTO mote_chat_operation(operation_id,intent_json,result_json) VALUES(?,?,?)').run(operation.operationId, intent, json(operation))
  }
  configurationAuthority(configuration: MoteChatConfiguration): ConnectionEnrollmentCallContext['actor'] | null {
    return this.safe(() => {
      const row = this.database.prepare("SELECT intent_json FROM mote_chat_operation WHERE json_extract(result_json,'$.action')='configure' AND json_extract(result_json,'$.configuration.target.spaceId')=? AND json_extract(result_json,'$.configuration.revision')=? LIMIT 1").get(configuration.target.spaceId, configuration.revision)
      return row ? JSON.parse(String(row.intent_json)).actor : null
    })
  }
  person(key: string): MoteChatPersonRow | null {
    return this.safe(() => { const row = this.database.prepare('SELECT space_id,snapshot_json FROM mote_chat_person WHERE person_key=?').get(key); return row ? { key, spaceId: String(row.space_id), person: parseMoteChatPerson(JSON.parse(String(row.snapshot_json))) } : null })
  }
  savePerson(row: MoteChatPersonRow): void {
    this.database.prepare('INSERT INTO mote_chat_person(person_key,space_id,snapshot_json) VALUES(?,?,?) ON CONFLICT(person_key) DO UPDATE SET snapshot_json=excluded.snapshot_json').run(row.key, row.spaceId, json(row.person))
  }
  people(spaceId: string, after: string, limit: number): MoteChatPersonRow[] {
    return this.safe(() => this.database.prepare('SELECT person_key,snapshot_json FROM mote_chat_person WHERE space_id=? AND person_key>? ORDER BY person_key LIMIT ?').all(spaceId, after, limit).map(row => ({ key: String(row.person_key), spaceId, person: parseMoteChatPerson(JSON.parse(String(row.snapshot_json))) })))
  }
  generation(generationId: string): MoteChatGenerationRow | null { return this.findGeneration('generation_id', generationId) }
  generationBySession(id: string): MoteChatGenerationRow | null { return this.findGeneration('session_id', id) }
  generationByBinding(id: string): MoteChatGenerationRow | null { return this.findGeneration('binding_id', id) }
  generationByGrant(id: string): MoteChatGenerationRow | null { return this.findGeneration('grant_id', id) }
  private findGeneration(column: 'generation_id' | 'session_id' | 'binding_id' | 'grant_id', id: string): MoteChatGenerationRow | null {
    return this.safe(() => { const row = this.database.prepare(`SELECT sequence,snapshot_json FROM mote_chat_generation WHERE ${column}=?`).get(id); return row ? generationRow(row as { sequence: unknown; snapshot_json: unknown }) : null })
  }
  latest(laneKey: string): MoteChatGenerationRow | null {
    return this.safe(() => { const row = this.database.prepare('SELECT sequence,snapshot_json FROM mote_chat_generation WHERE lane_key=? ORDER BY sequence DESC LIMIT 1').get(laneKey); return row ? generationRow(row as { sequence: unknown; snapshot_json: unknown }) : null })
  }
  latestAudience(spaceId: string, application: ConnectionApplication, externalConversationId: string): MoteChatGenerationRow | null {
    return this.safe(() => {
      const row = this.database.prepare("SELECT sequence,snapshot_json FROM mote_chat_generation WHERE space_id=? AND json_extract(snapshot_json,'$.generation.application.domain')=? AND json_extract(snapshot_json,'$.generation.application.appId')=? AND json_extract(snapshot_json,'$.generation.externalConversationId')=? ORDER BY sequence DESC LIMIT 1").get(spaceId, application.domain, application.appId, externalConversationId)
      return row ? generationRow(row as { sequence: unknown; snapshot_json: unknown }) : null
    })
  }
  generations(spaceId: string, before: number, limit: number, laneKey?: string, actor?: ConnectionActor): MoteChatGenerationRow[] {
    return this.safe(() => this.database.prepare('SELECT sequence,snapshot_json FROM mote_chat_generation WHERE space_id=? AND sequence<?' + (laneKey === undefined ? '' : ' AND lane_key=?') + (actor === undefined ? '' : " AND json_extract(snapshot_json,'$.generation.actor')=?") + ' ORDER BY sequence DESC LIMIT ?')
      .all(spaceId, before, ...(laneKey === undefined ? [] : [laneKey]), ...(actor === undefined ? [] : [json(actor)]), limit).map(row => generationRow(row as { sequence: unknown; snapshot_json: unknown })))
  }
  allBindings(input: RoomBindingListInput = {}): MoteChatGenerationRow[] {
    const entries = Object.entries(input).filter(([, value]) => value !== undefined), columns = { connectionId: "json_extract(snapshot_json,'$.connectionId')", executionHostId: "json_extract(snapshot_json,'$.generation.executionHostId')", agentSessionId: 'session_id' } as const
    return this.safe(() => this.database.prepare("SELECT sequence,snapshot_json FROM mote_chat_generation WHERE json_extract(snapshot_json,'$.generation.phase')='ready'" + entries.map(([key]) => ` AND ${columns[key as keyof typeof columns]}=?`).join('') + ' ORDER BY sequence')
      .all(...entries.map(([, value]) => value!)).map(row => generationRow(row as { sequence: unknown; snapshot_json: unknown })))
  }
  insertGeneration(row: MoteChatGenerationRow): MoteChatGenerationRow {
    const id = row.generation.generationId
    const saved = this.database.prepare('INSERT INTO mote_chat_generation(generation_id,lane_key,space_id,session_id,binding_id,grant_id,snapshot_json) VALUES(?,?,?,?,?,?,?)').run(id, row.laneKey, row.generation.target.spaceId, row.generation.agentSessionId, `mote-chat-binding:${id}`, `mote-chat-grant:${id}`, json(row))
    return { ...row, sequence: Number(saved.lastInsertRowid) }
  }
  saveGeneration(row: MoteChatGenerationRow): void { this.database.prepare('UPDATE mote_chat_generation SET snapshot_json=? WHERE generation_id=?').run(json(row), row.generation.generationId) }
  admission(application: ConnectionApplication, messageId: string): MoteChatAdmission | null {
    return this.safe(() => { const row = this.database.prepare('SELECT snapshot_json FROM mote_chat_admission WHERE domain=? AND app_id=? AND message_id=?').get(application.domain, application.appId, messageId); return row ? JSON.parse(String(row.snapshot_json)) : null })
  }
  admissionByIngress(ingressId: string): MoteChatAdmission | null {
    return this.safe(() => { const row = this.database.prepare('SELECT snapshot_json FROM mote_chat_admission WHERE ingress_id=?').get(ingressId); return row ? JSON.parse(String(row.snapshot_json)) : null })
  }
  saveAdmission(a: MoteChatAdmission): void {
    this.database.prepare('INSERT INTO mote_chat_admission(domain,app_id,message_id,ingress_id,snapshot_json) VALUES(?,?,?,?,?)').run(a.application.domain, a.application.appId, a.externalMessageId, a.ingressId, json(a))
  }
}
