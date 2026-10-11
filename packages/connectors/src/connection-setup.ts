import { randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { parseConnectionSetupChallenge, parseConnectionSetupOperation, parseConnectionSetupParams, type ConnectionEnrollmentCallContext, type ConnectionSetupBegin, type ConnectionSetupOperation, type ConnectionSetupPort, type ConnectionSetupView } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import type { EnrollmentSecrets } from './connection-enrollment-adapter.js'

type Row = { operation: ConnectionSetupOperation; actor: ConnectionEnrollmentCallContext['actor']; privateRef: string | null }
type PrivateEnvelope = { operationId: string; connectionId: string; attemptId: string; challenge: ConnectionSetupView['challenge']; privateState: string }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sameActor = (a: ConnectionEnrollmentCallContext['actor'], b: ConnectionEnrollmentCallContext['actor']) => a.kind === b.kind && a.id === b.id
const failure = (message: string, code = 'CONNECTION_SETUP_UNCONFIRMED') => new AgentMuxError(message, code)
const admitted = (o: ConnectionSetupOperation): ConnectionSetupBegin => ({ operationId: o.operationId, connectionId: o.connectionId, expectedConnectionRevision: o.expectedConnectionRevision, goal: o.goal })

/** Finite authentication intent in the original Connection DB. Never owns current bot configuration. */
export class ConnectionSetupHost implements ConnectionSetupPort {
  private closed = false
  private readonly pending = new Map<string, Promise<ConnectionSetupView>>()
  private readonly nativeRequests = new Set<string>()
  private readonly unsettled = new Map<string, PrivateEnvelope>()
  constructor(private readonly connections: ConnectionHost, private readonly secrets?: EnrollmentSecrets) {
    connections.database.exec('CREATE TABLE IF NOT EXISTS connection_setup_operation (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT UNIQUE NOT NULL, connection_id TEXT NOT NULL, actor_json TEXT NOT NULL, record_json TEXT NOT NULL, private_ref TEXT)')
    connections.database.exec('CREATE INDEX IF NOT EXISTS connection_setup_by_connection ON connection_setup_operation(connection_id,ordinal)')
  }
  close(): void { this.closed = true; this.nativeRequests.clear(); this.unsettled.clear() }
  private safe<T>(run: () => T): T {
    try { return run() } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw failure('The original management request storage is unconfirmed. Retain its identity and inspect it after storage is available. Existing bots and Agents remain available.')
    }
  }
  private read(operationId: string): Row | null {
    return this.safe(() => {
      const row = this.connections.database.prepare('SELECT actor_json,record_json,private_ref FROM connection_setup_operation WHERE operation_id=?').get(operationId)
      return row ? { operation: parseConnectionSetupOperation(JSON.parse(String(row.record_json))), actor: JSON.parse(String(row.actor_json)), privateRef: row.private_ref === null ? null : String(row.private_ref) } : null
    })
  }
  private async authority(context: ConnectionEnrollmentCallContext, row?: Row | null): Promise<void> {
    if (!context?.actor || !['user', 'device'].includes(context.actor.kind) || !context.actor.id || row && !sameActor(row.actor, context.actor)) throw failure('This management request belongs to its original transport-approved actor.', 'CONNECTION_SETUP_AUTHORITY_REQUIRED')
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    if (this.closed) throw failure('The original management owner is closed. Continue the same request on its executing Host.')
  }
  private current(row: Row): boolean {
    const current = this.connections.readConfiguration(row.operation.connectionId)
    return current?.revision === row.operation.expectedConnectionRevision && current.config.adapterId === row.operation.adapterId && same(current.config.application, row.operation.application)
  }
  private save(row: Row, change: (operation: ConnectionSetupOperation) => void, privateRef = row.privateRef): Row {
    return this.safe(() => {
      const operation = structuredClone(row.operation); change(operation)
      if (same(operation, row.operation) && privateRef === row.privateRef) {
        const current = this.read(row.operation.operationId)
        if (!current) throw failure('The original management record is unconfirmed. Retain its identity and inspect it after storage is available.')
        return current
      }
      operation.revision++
      parseConnectionSetupOperation(operation)
      const result = this.connections.database.prepare("UPDATE connection_setup_operation SET record_json=?,private_ref=? WHERE operation_id=? AND json_extract(record_json,'$.revision')=?").run(JSON.stringify(operation), privateRef, operation.operationId, row.operation.revision)
      if (result.changes !== 1) throw failure('The original management request changed. Read that same request before continuing.', 'CONNECTION_OPERATION_CONFLICT')
      return { ...row, operation, privateRef }
    })
  }
  private summary(row: Row): ConnectionSetupOperation {
    const operation = structuredClone(row.operation)
    // A durable preclaim is not a live dispatcher or an ACK. A fresh owner reports
    // the unresolved outcome without rewriting that original claim or replaying it.
    if (operation.request.state === 'dispatching' && !this.nativeRequests.has(operation.request.attemptId!)) {
      operation.request.state = 'unknown'
      operation.reason = 'request-unconfirmed'
    }
    return operation
  }
  private async view(row: Row | null, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    await this.authority(context, row)
    if (!row) return { operation: null, challenge: null }
    const operation = this.summary(row)
    if (!this.current(row)) return { operation, challenge: null, reason: 'connection-revised' }
    if (operation.secureStorage !== 'stored' || !row.privateRef || !this.secrets) return { operation, challenge: null, ...(operation.request.state === 'confirmed' ? { reason: 'challenge-unavailable' as const } : {}) }
    try {
      const value = await this.secrets.resolve(row.privateRef)
      const envelope = this.envelope(value, row)
      if (!envelope?.challenge || envelope.challenge.expiresAt !== null && envelope.challenge.expiresAt <= Date.now()) return { operation, challenge: null, reason: 'challenge-unavailable' }
      await this.authority(context, row)
      // Credential service calls can yield; a later configuration cannot receive this challenge.
      if (this.closed || !this.current(row)) return { operation, challenge: null, reason: 'connection-revised' }
      return { operation, challenge: envelope.challenge }
    } catch { return { operation, challenge: null, reason: 'challenge-unavailable' } }
  }
  private envelope(value: string | null, row: Row): PrivateEnvelope | null {
    try {
      if (value === null) return null
      const p = JSON.parse(value) as PrivateEnvelope
      if (p.operationId !== row.operation.operationId || p.connectionId !== row.operation.connectionId || p.attemptId !== row.operation.request.attemptId || typeof p.privateState !== 'string') return null
      return { operationId: p.operationId, connectionId: p.connectionId, attemptId: p.attemptId, challenge: parseConnectionSetupChallenge(p.challenge), privateState: p.privateState }
    } catch { return null }
  }
  private secretOperation(row: Row): string { return `connection-setup-auth:${row.operation.request.attemptId!}` }
  private async secure(row: Row): Promise<Row> {
    if (!this.secrets || !row.operation.request.attemptId) return row
    try {
      await this.secrets.assertAvailable()
      let saved = await this.secrets.inspect(this.secretOperation(row))
      const live = this.unsettled.get(row.operation.operationId)
      if (!saved && live?.attemptId === row.operation.request.attemptId) saved = await this.secrets.store({ operationId: this.secretOperation(row), secret: JSON.stringify(live) })
      if (!saved || !this.envelope(await this.secrets.resolve(saved.credentialRef), row)) return row
      row = this.save(row, o => { o.request.state = 'confirmed'; o.secureStorage = 'stored'; delete o.reason }, saved.credentialRef)
      this.unsettled.delete(row.operation.operationId)
      return row
    } catch {
      // A lost secure-store ACK is reconciled only through its original operation, never new QR work.
      return this.save(row, o => { o.secureStorage = 'unknown'; o.reason = 'challenge-unconfirmed' })
    }
  }
  async begin(value: ConnectionSetupBegin, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    const input = parseConnectionSetupParams('connection.setup.begin', value)
    await this.authority(context)
    let row = this.safe(() => {
      const db = this.connections.database; db.exec('BEGIN IMMEDIATE')
      try {
        let row = this.read(input.operationId)
        if (row) {
          if (!sameActor(row.actor, context.actor)) throw failure('The original management request belongs to another actor.', 'CONNECTION_SETUP_AUTHORITY_REQUIRED')
          if (!same(admitted(row.operation), input)) throw failure('This original management request has different input. Inspect it without replacing its identity.', 'CONNECTION_OPERATION_CONFLICT')
        } else {
          const current = this.connections.readConfiguration(input.connectionId)
          if (!current) throw failure('The exact saved bot is unknown.', 'UNKNOWN_CONNECTION')
          if (current.revision !== input.expectedConnectionRevision) throw failure('The exact saved bot revision changed. Read it before admitting a new request.', 'CONNECTION_REVISION_CONFLICT')
          const operation: ConnectionSetupOperation = { ...input, revision: 1, adapterId: current.config.adapterId, application: current.config.application, request: { state: 'not-dispatched', attemptId: null }, secureStorage: 'not-started' }
          parseConnectionSetupOperation(operation)
          db.prepare('INSERT INTO connection_setup_operation(operation_id,connection_id,actor_json,record_json) VALUES(?,?,?,?)').run(input.operationId, input.connectionId, JSON.stringify(context.actor), JSON.stringify(operation))
          row = { operation, actor: { kind: context.actor.kind, id: context.actor.id }, privateRef: null }
        }
        db.exec('COMMIT'); return row
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    const running = this.pending.get(input.operationId)
    if (running) { await running; return this.view(this.read(input.operationId), context) }
    const work = this.run(row, context)
    this.pending.set(input.operationId, work)
    try { return await work } finally { this.pending.delete(input.operationId) }
  }
  private async run(original: Row, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    let row = original
    await this.authority(context, row)
    if (!this.current(row)) return this.view(row, context)
    if (row.operation.request.state !== 'not-dispatched') {
      if (row.operation.secureStorage !== 'stored') row = await this.secure(row)
      return this.view(row, context)
    }
    const adapter = this.connections.registeredAdapter(row.operation.adapterId)?.setup
    if (!adapter?.domains.includes(row.operation.application.domain)) return this.view(this.save(row, o => { o.reason = 'adapter-unavailable' }), context)
    try { if (!this.secrets) throw new Error(); await this.secrets.assertAvailable() }
    catch { return this.view(this.save(row, o => { o.reason = 'secure-storage-unavailable' }), context) }
    await this.authority(context, row)
    if (!this.current(row)) return this.view(row, context)
    row = this.save(row, o => { o.request = { state: 'dispatching', attemptId: randomUUID() }; delete o.reason })
    let receipt: Awaited<ReturnType<typeof adapter.begin>>
    this.nativeRequests.add(row.operation.request.attemptId!)
    try { receipt = await adapter.begin({ operationId: row.operation.operationId, connectionId: row.operation.connectionId, attemptId: row.operation.request.attemptId!, application: row.operation.application }, context.signal) }
    catch { receipt = { kind: 'unknown' } }
    finally { this.nativeRequests.delete(row.operation.request.attemptId!) }
    if (this.closed) return { operation: this.summary(row), challenge: null, reason: 'challenge-unavailable' }
    if (receipt.kind !== 'challenge') return this.view(this.save(row, o => { o.request.state = 'unknown'; o.reason = 'request-unconfirmed' }), context)
    try {
      const envelope: PrivateEnvelope = { operationId: row.operation.operationId, connectionId: row.operation.connectionId, attemptId: row.operation.request.attemptId!, challenge: parseConnectionSetupChallenge(receipt.challenge), privateState: receipt.privateState }
      if (typeof envelope.privateState !== 'string') throw new Error()
      this.unsettled.set(row.operation.operationId, envelope)
      row = this.save(row, o => { o.request.state = 'confirmed'; o.secureStorage = 'storing' })
      row = await this.secure(row)
      return this.view(row, context)
    } catch { return this.view(this.save(row, o => { o.secureStorage = 'unknown'; o.reason = 'challenge-unconfirmed' }), context) }
  }
  async inspect(value: { operationId: string }, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    const input = parseConnectionSetupParams('connection.setup.inspect', value), row = this.read(input.operationId)
    await this.authority(context, row)
    return this.view(row, context)
  }
  async list(value: { connectionId: string; cursor?: string; limit?: number }) {
    const input = parseConnectionSetupParams('connection.setup.ls', value), limit = input.limit ?? 25
    let before = Number.MAX_SAFE_INTEGER
    if (input.cursor !== undefined) {
      if (!/^[1-9][0-9]*$/u.test(input.cursor) || !Number.isSafeInteger(Number(input.cursor))) throw failure('The original management page cursor is invalid.', 'INVALID_CONNECTION_SETUP_DATA')
      before = Number(input.cursor)
    }
    return this.safe(() => {
      const rows = this.connections.database.prepare('SELECT operation_id,ordinal FROM connection_setup_operation WHERE connection_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?').all(input.connectionId, before, limit + 1)
      return { operations: rows.slice(0, limit).map(r => this.summary(this.read(String(r.operation_id))!)), next: rows.length > limit ? String(rows[limit - 1]!.ordinal) : null }
    })
  }
}
