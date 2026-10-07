import { randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { parseConnectionEnrollmentOperation, parseConnectionEnrollmentParams, type ConnectionEnrollmentBeginInput, type ConnectionEnrollmentCallContext, type ConnectionEnrollmentOperation } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'

export type EnrollmentRow = { operation: ConnectionEnrollmentOperation; actor: ConnectionEnrollmentCallContext['actor']; credentialOperationId: string; configureOperationId: string; attemptId: string | null; attemptKind: 'begin' | 'poll' | null; snapshotOperationId: string | null; privateRef: string | null }
/** Original connector SQLite only. No private protocol bytes or credentials enter these tables. */
export class ConnectionEnrollmentStore {
  constructor(private readonly host: ConnectionHost) {
    host.database.exec('CREATE TABLE IF NOT EXISTS connection_enrollment (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT UNIQUE NOT NULL, connection_id TEXT UNIQUE NOT NULL, record_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connection_enrollment_attempt (attempt_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, state TEXT NOT NULL);')
  }
  safe<T>(call: () => T): T { try { return call() } catch (error) { if (error instanceof AgentMuxError) throw error; throw new AgentMuxError('The original enrollment storage is unconfirmed. Inspect the same operation; existing Agents and connections remain available.', 'CONNECTION_ENROLLMENT_STORAGE_UNCONFIRMED') } }
  private transaction<T>(call: () => T): T {
    return this.safe(() => { this.host.database.exec('BEGIN IMMEDIATE'); try { const v = call(); this.host.database.exec('COMMIT'); return v } catch (e) { try { this.host.database.exec('ROLLBACK') } catch { /* Read original operation after an uncertain commit. */ } throw e } })
  }
  read(operationId: string): EnrollmentRow | null {
    return this.safe(() => { const r = this.host.database.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(operationId); if (!r) return null; const row = JSON.parse(String(r.record_json)) as EnrollmentRow; row.operation = parseConnectionEnrollmentOperation(row.operation); return row })
  }
  private write(row: EnrollmentRow): EnrollmentRow {
    row.operation = parseConnectionEnrollmentOperation(row.operation)
    this.host.database.prepare('UPDATE connection_enrollment SET record_json=? WHERE operation_id=?').run(JSON.stringify(row), row.operation.operationId)
    return row
  }
  admit(input: ConnectionEnrollmentBeginInput, actor: ConnectionEnrollmentCallContext['actor']): EnrollmentRow {
    return this.transaction(() => {
      const saved = this.read(input.operationId)
      if (saved) {
        const { operationId, connectionId, adapterId, domain, label, preset } = saved.operation
        const old = parseConnectionEnrollmentParams('connection.enrollment.begin', { operationId, connectionId, adapterId, domain, label, ...(preset ? { preset } : {}) })
        if (JSON.stringify(old) !== JSON.stringify(input) || JSON.stringify(saved.actor) !== JSON.stringify(actor)) throw new AgentMuxError('The original enrollment has different input or authority. Inspect it without replacing its identity.', 'CONNECTION_OPERATION_CONFLICT')
        return saved
      }
      if (this.host.readConfiguration(input.connectionId) || this.host.database.prepare('SELECT operation_id FROM connection_enrollment WHERE connection_id=?').get(input.connectionId)) throw new AgentMuxError('The Connection identity is already owned by another original operation.', 'CONNECTION_IDENTITY_CONFLICT')
      const row: EnrollmentRow = { operation: { ...input, revision: 1, authorization: 'not-started', credential: 'not-started', configuration: 'not-started', application: null, challenge: null, configured: null }, actor: { ...actor }, credentialOperationId: randomUUID(), configureOperationId: randomUUID(), attemptId: null, attemptKind: null, snapshotOperationId: null, privateRef: null }
      this.host.database.prepare('INSERT INTO connection_enrollment(operation_id,connection_id,record_json) VALUES(?,?,?)').run(input.operationId, input.connectionId, JSON.stringify(row))
      return row
    })
  }
  update(operationId: string, change: (row: EnrollmentRow) => void, attemptId?: string): EnrollmentRow {
    return this.transaction(() => {
      const row = this.read(operationId)
      if (!row) throw new AgentMuxError('The original enrollment operation is unknown.', 'UNKNOWN_CONNECTION_ENROLLMENT')
      if (attemptId !== undefined && row.attemptId !== attemptId) return row
      change(row); row.operation.revision++; return this.write(row)
    })
  }
  claim(operationId: string, kind: 'begin' | 'poll', owner: string, captured: EnrollmentRow): { row: EnrollmentRow; claimed: boolean } {
    return this.transaction(() => {
      const row = this.read(operationId)!
      if (row.operation.revision !== captured.operation.revision || row.attemptId !== captured.attemptId || row.privateRef !== captured.privateRef || kind === 'poll' && (!row.operation.challenge || Date.now() < row.operation.challenge.nextPollAt)) return { row, claimed: false }
      if (kind === 'begin' ? row.attemptId !== null || row.operation.authorization !== 'not-started' : row.operation.authorization !== 'pending') return { row, claimed: false }
      const attemptId = randomUUID()
      this.host.database.prepare('INSERT INTO connection_enrollment_attempt VALUES(?,?,?,?,?)').run(attemptId, operationId, kind, owner, 'claimed')
      row.attemptId = attemptId; row.attemptKind = kind; row.snapshotOperationId = randomUUID()
      row.operation.authorization = 'unknown'; row.operation.reason = kind === 'begin' ? 'begin-unconfirmed' : 'poll-unconfirmed'; row.operation.revision++
      return { row: this.write(row), claimed: true }
    })
  }
  settle(operationId: string, attemptId: string, change: (row: EnrollmentRow) => void): EnrollmentRow {
    return this.transaction(() => {
      const row = this.read(operationId)!
      const active = this.host.database.prepare('SELECT state FROM connection_enrollment_attempt WHERE attempt_id=? AND operation_id=?').get(attemptId, operationId)
      if (row.attemptId !== attemptId || active?.state !== 'claimed') return row
      change(row); row.operation.revision++; this.write(row)
      this.host.database.prepare("UPDATE connection_enrollment_attempt SET state='settled' WHERE attempt_id=?").run(attemptId)
      return row
    })
  }
  page(cursor: string | undefined, limit: number): { operations: ConnectionEnrollmentOperation[]; next: string | null } {
    return this.safe(() => {
      let before = Number.MAX_SAFE_INTEGER
      if (cursor) {
        if (!/^enrollment:[1-9][0-9]*$/u.test(cursor)) throw new AgentMuxError('The original enrollment cursor is invalid.', 'INVALID_CONNECTION_ENROLLMENT_DATA')
        before = Number(cursor.slice(11)); if (!Number.isSafeInteger(before)) throw new AgentMuxError('The original enrollment cursor is invalid.', 'INVALID_CONNECTION_ENROLLMENT_DATA')
      }
      const rows = this.host.database.prepare('SELECT sequence,record_json FROM connection_enrollment WHERE sequence<? ORDER BY sequence DESC LIMIT ?').all(before, limit + 1)
      const page = rows.slice(0, limit)
      return { operations: page.map(r => parseConnectionEnrollmentOperation((JSON.parse(String(r.record_json)) as EnrollmentRow).operation)), next: rows.length > limit ? 'enrollment:' + String(page.at(-1)!.sequence) : null }
    })
  }
}
