import { AgentMuxError } from '@agentmux/core'
import { parseRoomBindingAuthority, parseConnectionApplicationAccessParams, parseConnectionApplicationAccessOperation, parseConnectionApplicationGrant, type ConnectionApplicationAccessPort, type ConnectionApplicationAccessConfigure, type ConnectionApplicationAccessGet, type ConnectionApplicationGrant, type RoomBindingCallContext, type ConnectionActor } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** One original SQLite owner. App rules never materialize room grants. */
export class ApplicationAccessHost implements ConnectionApplicationAccessPort {
  private initialized = false
  constructor(private readonly connections: ConnectionHost) {}
  private safe<T>(run: () => T): T {
    try { return run() } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw new AgentMuxError('Application access storage is unconfirmed. Inspect the original operation or restore storage before explicitly saving. Existing Agents remain available.', 'APPLICATION_ACCESS_UNCONFIRMED')
    }
  }
  private database() {
    const db = this.connections.database
    if (!this.initialized) { db.exec(`CREATE TABLE IF NOT EXISTS application_grant_revision (grant_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY(grant_id,revision));
      CREATE TABLE IF NOT EXISTS application_grant_head (grant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, adapter_id TEXT NOT NULL, domain TEXT NOT NULL, app_id TEXT NOT NULL, actor_json TEXT NOT NULL, UNIQUE(adapter_id,domain,app_id,actor_json));
      CREATE TABLE IF NOT EXISTS application_grant_operation (operation_id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, result_json TEXT NOT NULL);`); this.initialized = true }
    return db
  }
  /** Synchronous same-transaction reads; no platform call or configuration mirror. */
  grants(connectionId: string, actor?: ConnectionActor): ConnectionApplicationGrant[] {
    return this.safe(() => {
      const config = this.connections.readConfiguration(connectionId)?.config
      if (!config || actor && !equal(actor.application, config.application)) throw new AgentMuxError('The original application is unavailable or does not own this actor.', 'APPLICATION_ACCESS_SCOPE_CHANGED')
      const db = this.database()
      return db.prepare('SELECT r.snapshot_json FROM application_grant_head h JOIN application_grant_revision r ON r.grant_id=h.grant_id AND r.revision=h.revision WHERE h.adapter_id=? AND h.domain=? AND h.app_id=?' + (actor ? ' AND h.actor_json=?' : '') + ' ORDER BY h.grant_id')
        .all(config.adapterId, config.application.domain, config.application.appId, ...(actor ? [JSON.stringify(actor)] : [])).map(row => parseConnectionApplicationGrant(JSON.parse(String(row.snapshot_json))))
    })
  }
  async get(value: ConnectionApplicationAccessGet) {
    const input = parseConnectionApplicationAccessParams('connection.application.access.get', value)
    return this.safe(() => {
      const record = this.connections.readConfiguration(input.connectionId)
      if (!record) throw new AgentMuxError('The original application configuration is unavailable.', 'APPLICATION_ACCESS_SCOPE_CHANGED')
      return { connectionId: input.connectionId, connectionRevision: record.revision, adapterId: record.config.adapterId, application: record.config.application, grants: this.grants(input.connectionId, input.actor) }
    })
  }
  async inspect(value: { operationId: string }) {
    const input = parseConnectionApplicationAccessParams('connection.application.access.inspect', value)
    return this.safe(() => {
      const row = this.database().prepare('SELECT result_json FROM application_grant_operation WHERE operation_id=?').get(input.operationId)
      return { operation: row ? parseConnectionApplicationAccessOperation(JSON.parse(String(row.result_json))) : null }
    })
  }
  async configure(value: ConnectionApplicationAccessConfigure, context: RoomBindingCallContext) {
    const input = parseConnectionApplicationAccessParams('connection.application.access.configure', value)
    const actor = parseRoomBindingAuthority(context.actor)
    if (actor.kind !== 'user' && actor.kind !== 'device') throw new AgentMuxError('Application access requires the original person or device.', 'CONTROL_PERMISSION_DENIED')
    await context.assertCurrent?.()
    return this.safe(() => {
      const db = this.database(), intent = JSON.stringify({ input, actor })
      db.exec('BEGIN IMMEDIATE')
      try {
        const saved = db.prepare('SELECT intent_json,result_json FROM application_grant_operation WHERE operation_id=?').get(input.operationId)
        if (saved) {
          if (saved.intent_json !== intent) throw new AgentMuxError('The original application access operation has different input or authority. Inspect the same operation.', 'APPLICATION_ACCESS_OPERATION_CONFLICT')
          const operation = parseConnectionApplicationAccessOperation(JSON.parse(String(saved.result_json))); db.exec('COMMIT'); return operation
        }
        const record = this.connections.readConfiguration(input.connectionId)
        const row = db.prepare('SELECT snapshot_json FROM application_grant_revision WHERE grant_id=? ORDER BY revision DESC LIMIT 1').get(input.grantId)
        const current = row ? parseConnectionApplicationGrant(JSON.parse(String(row.snapshot_json))) : null
        const other = record && equal(record.config.application, input.actor.application) ? this.grants(input.connectionId, input.actor)[0] : undefined
        const code = !record || !equal(record.config.application, input.actor.application) ? 'APPLICATION_ACCESS_SCOPE_CHANGED'
          : record.revision !== input.expectedConnectionRevision ? 'APPLICATION_ACCESS_CONNECTION_REVISED'
          : (current?.revision ?? null) !== input.expectedRevision ? 'APPLICATION_ACCESS_REVISION_CONFLICT'
          : current && (current.adapterId !== record.config.adapterId || !equal(current.actor, input.actor)) ? 'APPLICATION_ACCESS_ACTOR_MISMATCH'
          : other && other.grantId !== input.grantId ? 'APPLICATION_ACCESS_ACTOR_CONFLICT' : null
        const operation = parseConnectionApplicationAccessOperation(code ? { operationId: input.operationId, state: 'refused', code } : {
          operationId: input.operationId, state: 'applied', grant: { grantId: input.grantId, revision: (current?.revision ?? 0) + 1, adapterId: record!.config.adapterId, actor: input.actor, state: input.state, capabilities: input.capabilities }
        })
        if (operation.state === 'applied') {
          const g = operation.grant
          db.prepare('INSERT INTO application_grant_revision VALUES (?,?,?)').run(g.grantId, g.revision, JSON.stringify(g))
          db.prepare('INSERT INTO application_grant_head VALUES (?,?,?,?,?,?) ON CONFLICT(grant_id) DO UPDATE SET revision=excluded.revision').run(g.grantId, g.revision, g.adapterId, g.actor.application.domain, g.actor.application.appId, JSON.stringify(g.actor))
        }
        db.prepare('INSERT INTO application_grant_operation VALUES (?,?,?)').run(input.operationId, intent, JSON.stringify(operation))
        db.exec('COMMIT'); return operation
      } catch (error) { try { db.exec('ROLLBACK') } catch { /* Inspect the same immutable operation after an uncertain commit. */ } throw error }
    })
  }
}
