import { randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { parseRoomProvisioningOperation, type RoomBindingAuthority, type RoomCreateInput, type RoomCreationState, type RoomMembershipState, type RoomProvisioningOperation, type RoomProvisioningRefusal } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'

/** Original provisioning facts join the configured connection's database. No second Binding map. */
export class RoomProvisioningStore {
  private readonly database
  constructor(private readonly connections: ConnectionHost) {
    this.database = connections.database
    this.safe(() => this.database.exec(`
      CREATE TABLE IF NOT EXISTS room_provisioning_operation (operation_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, host_id TEXT NOT NULL, session_id TEXT NOT NULL, creation_state TEXT NOT NULL, snapshot_json TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS room_provisioning_target_claim ON room_provisioning_operation(connection_id,host_id,session_id) WHERE creation_state<>'not-applied';
      CREATE TABLE IF NOT EXISTS room_provisioning_attempt (attempt_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, phase TEXT NOT NULL, receipt_json TEXT NOT NULL, UNIQUE(operation_id,phase));
    `))
  }
  private safe<T>(run: () => T): T {
    try { return run() } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw new AgentMuxError('Room provisioning storage cannot confirm the original operation. Inspect its original identity. Existing Agents remain available.', 'ROOM_PROVISIONING_STORAGE_UNCONFIRMED')
    }
  }
  private transaction<T>(run: () => T): T {
    return this.safe(() => {
      this.database.exec('BEGIN IMMEDIATE')
      try { const value = run(); this.database.exec('COMMIT'); return value }
      catch (error) { try { this.database.exec('ROLLBACK') } catch { /* Inspect the original operation after an uncertain commit. */ } throw error }
    })
  }
  read(operationId: string): RoomProvisioningOperation | null {
    return this.safe(() => {
      const row = this.database.prepare('SELECT creation_state,snapshot_json FROM room_provisioning_operation WHERE operation_id=?').get(operationId)
      if (!row) return null
      const operation = parseRoomProvisioningOperation(JSON.parse(String(row.snapshot_json)))
      if (operation.creation.state !== row.creation_state || operation.operationId !== operationId) throw new Error('Original provisioning identity changed.')
      return operation
    })
  }
  private save(value: RoomProvisioningOperation): RoomProvisioningOperation {
    const operation = parseRoomProvisioningOperation(value)
    this.database.prepare('UPDATE room_provisioning_operation SET creation_state=?,snapshot_json=? WHERE operation_id=?').run(operation.creation.state, JSON.stringify(operation), operation.operationId)
    return operation
  }
  admit(input: RoomCreateInput, actor: RoomBindingAuthority): RoomProvisioningOperation {
    return this.transaction(() => {
      const saved = this.read(input.operationId)
      if (saved) {
        if (JSON.stringify(saved.input) !== JSON.stringify(input) || JSON.stringify(saved.authorizedBy) !== JSON.stringify(actor)) throw new AgentMuxError('The original room operation has different intent or authority. Inspect it without replacing its identity.', 'ROOM_PROVISIONING_OPERATION_CONFLICT')
        return saved
      }
      const connection = this.connections.readConfiguration(input.connectionId)
      let creation: RoomCreationState = !connection?.config.enabled ? { state: 'not-applied', reason: 'connection-unavailable' }
        : connection.revision !== input.expectedConnectionRevision ? { state: 'not-applied', reason: 'connection-revised' } : { state: 'pending' }
      if (creation.state === 'pending') {
        const original = this.database.prepare("SELECT operation_id FROM room_provisioning_operation WHERE connection_id=? AND host_id=? AND session_id=? AND creation_state<>'not-applied'").get(input.connectionId, input.executionHostId, input.agentSessionId)
        if (original) creation = { state: 'not-applied', reason: 'existing-operation', originalOperationId: String(original.operation_id) }
      }
      const membership: RoomMembershipState = !input.members.length ? { state: 'not-requested' }
        : creation.state === 'not-applied' ? { state: 'not-applied', reason: creation.reason } : { state: 'pending' }
      const operation = parseRoomProvisioningOperation({ operationId: input.operationId, input, authorizedBy: actor,
        application: connection?.config.application ?? null, adapterId: connection?.config.adapterId ?? null, creation, membership })
      this.database.prepare('INSERT INTO room_provisioning_operation(operation_id,connection_id,host_id,session_id,creation_state,snapshot_json) VALUES(?,?,?,?,?,?)').run(input.operationId, input.connectionId, input.executionHostId, input.agentSessionId, creation.state, JSON.stringify(operation))
      return operation
    })
  }
  /** A pending phase has no dispatched attempt. Only an explicit exact original call can claim it. */
  claim(operationId: string, phase: 'creation' | 'membership', guard: () => RoomProvisioningRefusal | null): { operation: RoomProvisioningOperation; claimed: boolean } {
    return this.transaction(() => {
      const operation = this.read(operationId)!
      if (operation[phase].state !== 'pending' || phase === 'membership' && operation.creation.state !== 'created') return { operation, claimed: false }
      const refusal = guard()
      if (refusal) return { operation: this.refuse(operation, phase, refusal), claimed: false }
      const attemptId = randomUUID(), receipt = { state: 'dispatching' as const, attemptId }
      this.database.prepare('INSERT INTO room_provisioning_attempt(attempt_id,operation_id,phase,receipt_json) VALUES(?,?,?,?)').run(attemptId, operationId, phase, JSON.stringify(receipt))
      // The confirmed transaction precedes the adapter invocation; dispatching is never replayable.
      return { operation: this.save({ ...operation, [phase]: receipt }), claimed: true }
    })
  }
  private refuse(operation: RoomProvisioningOperation, phase: 'creation' | 'membership', reason: RoomProvisioningRefusal): RoomProvisioningOperation {
    const result = { ...operation, [phase]: { state: 'not-applied', reason } }
    if (phase === 'creation' && operation.membership.state === 'pending') result.membership = { state: 'not-applied', reason }
    return this.save(result)
  }
  refusePending(operationId: string, phase: 'creation' | 'membership', reason: RoomProvisioningRefusal): RoomProvisioningOperation {
    return this.transaction(() => { const operation = this.read(operationId)!; return operation[phase].state === 'pending' ? this.refuse(operation, phase, reason) : operation })
  }
  settle(operationId: string, phase: 'creation', receipt: Exclude<RoomCreationState, { state: 'pending' }>): RoomProvisioningOperation
  settle(operationId: string, phase: 'membership', receipt: Extract<RoomMembershipState, { state: 'settled' }>): RoomProvisioningOperation
  settle(operationId: string, phase: 'creation' | 'membership', receipt: RoomCreationState | RoomMembershipState): RoomProvisioningOperation {
    return this.transaction(() => {
      const operation = this.read(operationId)!, original = operation[phase]
      if (original.state !== 'dispatching') return operation
      if (!('attemptId' in receipt) || receipt.attemptId !== original.attemptId) throw new AgentMuxError('The receipt belongs to another original room attempt.', 'ROOM_PROVISIONING_ATTEMPT_CONFLICT')
      const result = { ...operation, [phase]: receipt }
      if (phase === 'creation' && receipt.state === 'not-applied' && operation.membership.state === 'pending') result.membership = { state: 'not-applied', reason: receipt.reason }
      const validated = this.save(result)
      this.database.prepare('UPDATE room_provisioning_attempt SET receipt_json=? WHERE attempt_id=? AND operation_id=? AND phase=?').run(JSON.stringify(validated[phase]), original.attemptId, operationId, phase)
      return validated
    })
  }
}
