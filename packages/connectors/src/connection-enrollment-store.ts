import { createHash, randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import {
  parseConnectionEnrollmentOperation,
  summarizeConnectionEnrollmentPreset,
  type ConnectionEnrollmentAdvanceInput,
  type ConnectionEnrollmentBeginInput,
  type ConnectionEnrollmentCallContext,
  type ConnectionEnrollmentOperation,
  type ConnectionEnrollmentReceipt
} from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
export type EnrollmentStep = 'begin' | 'authentication' | 'upload' | 'create' | 'credential'
export type EnrollmentActionRecord = {
  input: ConnectionEnrollmentAdvanceInput
  receipt: ConnectionEnrollmentReceipt
}
export type EnrollmentRow = {
  operation: ConnectionEnrollmentOperation
  actor: ConnectionEnrollmentCallContext['actor']
  credentialOperationId: string
  configureOperationId: string
  attemptId: string | null
  attemptKind: EnrollmentStep | 'poll' | null
  snapshotOperationId: string | null
  privateRef: string | null
  version?: 2
  inputDigest?: string
  assetOperationId?: string
  confirmedAccountDigest?: string
  creationAccountDigest?: string
  activeActionId?: string
  /** Omitted on old intents; their original adapter route must not change after renewal. */
  adapterProtocolId?: string
  /** Read-only original record material, never serialized as an added field. */
  savedOperation?: Record<string, unknown>
}
export const enrollmentDigest = (v: unknown): string =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex')
export const sameEnrollmentActor = (
  a: ConnectionEnrollmentCallContext['actor'] | null | undefined,
  b: ConnectionEnrollmentCallContext['actor'] | null | undefined
): boolean => !!a && !!b && a.kind === b.kind && a.id === b.id
/** Only removes private challenge material from original durable records; reading never rewrites them. */
export function projectStoredEnrollmentOperation(value: unknown): ConnectionEnrollmentOperation {
  const source = value as Record<string, unknown>,
    { challenge: _challenge, ...summary } = source
  return parseConnectionEnrollmentOperation(summary)
}
/** The original connector database and attempt journal remain the only enrollment owner. */
export class ConnectionEnrollmentStore {
  constructor(private readonly host: ConnectionHost) {
    host.database.exec(
      'CREATE TABLE IF NOT EXISTS connection_enrollment (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT UNIQUE NOT NULL, connection_id TEXT UNIQUE NOT NULL, record_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connection_enrollment_attempt (attempt_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connection_enrollment_decision (action_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, record_json TEXT NOT NULL);'
    )
  }
  safe<T>(call: () => T): T {
    try {
      return call()
    } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw new AgentMuxError(
        'The original enrollment storage is unconfirmed. Inspect the same operation; existing Agents and connections remain available.',
        'CONNECTION_ENROLLMENT_STORAGE_UNCONFIRMED'
      )
    }
  }
  private transaction<T>(call: () => T): T {
    return this.safe(() => {
      this.host.database.exec('BEGIN IMMEDIATE')
      try {
        const v = call()
        this.host.database.exec('COMMIT')
        return v
      } catch (e) {
        try {
          this.host.database.exec('ROLLBACK')
        } catch {
          /* Inspect the same original operation after an uncertain commit. */
        }
        throw e
      }
    })
  }
  private decode(record: Record<string, unknown> | undefined): EnrollmentRow | null {
    if (!record) return null
    const row = JSON.parse(String(record.record_json)) as EnrollmentRow,
      original = row.operation as unknown as Record<string, unknown>
    row.operation = projectStoredEnrollmentOperation(original)
    if (row.version !== 2)
      Object.defineProperty(row, 'savedOperation', { value: original, enumerable: false })
    return row
  }
  read(operationId: string): EnrollmentRow | null {
    return this.safe(() => this.decode(this.host.database.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(operationId)))
  }
  readByConnection(connectionId: string): EnrollmentRow | null {
    return this.safe(() => this.decode(this.host.database.prepare('SELECT record_json FROM connection_enrollment WHERE connection_id=?').get(connectionId)))
  }
  private write(row: EnrollmentRow): EnrollmentRow {
    row.operation = parseConnectionEnrollmentOperation(row.operation)
    const operation = row.savedOperation
      ? { ...row.savedOperation, ...row.operation }
      : row.operation
    this.host.database
      .prepare('UPDATE connection_enrollment SET record_json=? WHERE operation_id=?')
      .run(JSON.stringify({ ...row, operation }), row.operation.operationId)
    return row
  }
  admit(
    input: ConnectionEnrollmentBeginInput,
    actor: ConnectionEnrollmentCallContext['actor'],
    adapterProtocolId?: string
  ): EnrollmentRow {
    return this.transaction(() => {
      const saved = this.read(input.operationId),
        inputDigest = enrollmentDigest(input)
      if (saved) {
        if (
          saved.version !== 2 ||
          saved.inputDigest !== inputDigest ||
          !sameEnrollmentActor(saved.actor, actor)
        )
          throw new AgentMuxError(
            'The original enrollment has different input or authority. Inspect it without replacing its identity.',
            'CONNECTION_OPERATION_CONFLICT'
          )
        return saved
      }
      if (
        this.host.readConfiguration(input.connectionId) ||
        this.host.database
          .prepare('SELECT operation_id FROM connection_enrollment WHERE connection_id=?')
          .get(input.connectionId)
      )
        throw new AgentMuxError(
          'The Connection identity is already owned by another original operation.',
          'CONNECTION_IDENTITY_CONFLICT'
        )
      const { preset, ...identity } = input
      const row: EnrollmentRow = {
        version: 2,
        inputDigest,
        ...(adapterProtocolId === undefined ? {} : { adapterProtocolId }),
        assetOperationId: randomUUID(),
        operation: {
          ...identity,
          preset: summarizeConnectionEnrollmentPreset(preset),
          revision: 1,
          authorization: 'not-started',
          credential: 'not-started',
          configuration: 'not-started',
          application: null,
          configured: null,
          authentication: { attemptId: randomUUID(), stage: 'not-started' },
          creation: { upload: 'not-started', create: 'not-started' }
        },
        actor: { ...actor },
        credentialOperationId: randomUUID(),
        configureOperationId: randomUUID(),
        attemptId: null,
        attemptKind: null,
        snapshotOperationId: null,
        privateRef: null
      }
      this.host.database
        .prepare(
          'INSERT INTO connection_enrollment(operation_id,connection_id,record_json) VALUES(?,?,?)'
        )
        .run(input.operationId, input.connectionId, JSON.stringify(row))
      return row
    })
  }
  update(
    operationId: string,
    change: (row: EnrollmentRow) => void | false,
    attemptId?: string
  ): EnrollmentRow {
    return this.transaction(() => {
      const row = this.read(operationId)
      if (!row)
        throw new AgentMuxError(
          'The original enrollment operation is unknown.',
          'UNKNOWN_CONNECTION_ENROLLMENT'
        )
      if (attemptId !== undefined && row.attemptId !== attemptId) return row
      if (change(row) === false) return row
      row.operation.revision++
      return this.write(row)
    })
  }
  readAction(operationId: string, actionId: string): EnrollmentActionRecord | null {
    return this.safe(() => {
      const row = this.host.database
        .prepare(
          'SELECT record_json FROM connection_enrollment_decision WHERE action_id=? AND operation_id=?'
        )
        .get(actionId, operationId)
      return row ? (JSON.parse(String(row.record_json)) as EnrollmentActionRecord) : null
    })
  }
  changeReceipt(
    operationId: string,
    actionId: string,
    change: (receipt: ConnectionEnrollmentReceipt) => void
  ): void {
    const record = this.readAction(operationId, actionId)
    if (!record)
      throw new AgentMuxError(
        'The original enrollment decision is unknown.',
        'CONNECTION_OPERATION_CONFLICT'
      )
    change(record.receipt)
    this.host.database
      .prepare(
        'UPDATE connection_enrollment_decision SET record_json=? WHERE action_id=? AND operation_id=?'
      )
      .run(JSON.stringify(record), actionId, operationId)
  }
  action(
    operationId: string,
    input: ConnectionEnrollmentAdvanceInput,
    captured: EnrollmentRow
  ): {
    row: EnrollmentRow
    duplicate: boolean
  } {
    return this.transaction(() => {
      const row = this.read(operationId)!,
        saved = this.readAction(operationId, input.decision.actionId)
      if (saved) {
        if (JSON.stringify(saved.input) !== JSON.stringify(input))
          throw new AgentMuxError(
            'The original decision has different input.',
            'CONNECTION_OPERATION_CONFLICT'
          )
        return { row, duplicate: true }
      }
      if (
        row.version !== 2 ||
        row.operation.revision !== captured.operation.revision ||
        row.operation.revision !== input.ownRevision
      )
        throw new AgentMuxError(
          'Read the current original enrollment before choosing its action.',
          'CONNECTION_REVISION_CONFLICT'
        )
      row.activeActionId = input.decision.actionId
      const record: EnrollmentActionRecord = {
        input,
        receipt: {
          ...input.decision,
          ownRevision: input.ownRevision,
          stepId: randomUUID(),
          state: 'dispatching'
        }
      }
      this.host.database
        .prepare(
          'INSERT INTO connection_enrollment_decision(action_id,operation_id,record_json) VALUES(?,?,?)'
        )
        .run(input.decision.actionId, operationId, JSON.stringify(record))
      row.operation.revision++
      return { row: this.write(row), duplicate: false }
    })
  }
  claim(
    operationId: string,
    kind: EnrollmentStep,
    owner: string,
    captured: EnrollmentRow,
    actionId?: string
  ): {
    row: EnrollmentRow
    claimed: boolean
  } {
    return this.transaction(() => {
      const row = this.read(operationId)!
      if (
        row.operation.revision !== captured.operation.revision ||
        row.attemptId !== captured.attemptId ||
        actionId !== row.activeActionId
      )
        return { row, claimed: false }
      const attemptId = randomUUID()
      this.host.database
        .prepare('INSERT INTO connection_enrollment_attempt VALUES(?,?,?,?,?)')
        .run(attemptId, operationId, kind, owner, 'claimed')
      row.attemptId = attemptId
      row.attemptKind = kind
      row.snapshotOperationId = randomUUID()
      if (kind === 'begin' || kind === 'authentication')
        row.operation.authentication!.stage = 'unknown'
      if (kind === 'upload' || kind === 'create') row.operation.creation![kind] = 'dispatching'
      if (kind === 'credential') row.operation.credential = 'storing'
      row.operation.reason =
        kind === 'begin'
          ? 'begin-unconfirmed'
          : kind === 'credential'
            ? 'credential-unconfirmed'
            : 'poll-unconfirmed'
      delete row.operation.diagnostic
      if (actionId)
        this.changeReceipt(operationId, actionId, (receipt) => {
          receipt.stepId = attemptId
          receipt.state = 'dispatching'
        })
      row.operation.revision++
      return { row: this.write(row), claimed: true }
    })
  }
  settle(
    operationId: string,
    attemptId: string,
    change: (row: EnrollmentRow) => void
  ): EnrollmentRow {
    return this.transaction(() => {
      const row = this.read(operationId)!,
        active = this.host.database
          .prepare(
            'SELECT state FROM connection_enrollment_attempt WHERE attempt_id=? AND operation_id=?'
          )
          .get(attemptId, operationId)
      if (row.attemptId !== attemptId || active?.state !== 'claimed') return row
      change(row)
      row.operation.revision++
      this.write(row)
      this.host.database
        .prepare("UPDATE connection_enrollment_attempt SET state='settled' WHERE attempt_id=?")
        .run(attemptId)
      return row
    })
  }
  claimed(row: EnrollmentRow): boolean {
    return this.safe(
      () =>
        this.host.database
          .prepare(
            'SELECT state FROM connection_enrollment_attempt WHERE attempt_id=? AND operation_id=?'
          )
          .get(row.attemptId, row.operation.operationId)?.state === 'claimed'
    )
  }
  page(
    cursor: string | undefined,
    limit: number,
    actor?: ConnectionEnrollmentCallContext['actor']
  ): {
    operations: ConnectionEnrollmentOperation[]
    next: string | null
  } {
    return this.safe(() => {
      let before = Number.MAX_SAFE_INTEGER
      if (cursor) {
        if (!/^enrollment:[1-9][0-9]*$/u.test(cursor))
          throw new AgentMuxError(
            'The original enrollment cursor is invalid.',
            'INVALID_CONNECTION_ENROLLMENT_DATA'
          )
        before = Number(cursor.slice(11))
        if (!Number.isSafeInteger(before))
          throw new AgentMuxError(
            'The original enrollment cursor is invalid.',
            'INVALID_CONNECTION_ENROLLMENT_DATA'
          )
      }
      const rows = this.host.database
          .prepare(
            actor ? "SELECT sequence,record_json FROM connection_enrollment WHERE sequence<? AND json_extract(record_json,'$.actor.kind')=? AND json_extract(record_json,'$.actor.id')=? ORDER BY sequence DESC LIMIT ?" : 'SELECT sequence,record_json FROM connection_enrollment WHERE sequence<? ORDER BY sequence DESC LIMIT ?'
          )
          .all(...(actor ? [before, actor.kind, actor.id, limit + 1] : [before, limit + 1])),
        page = rows.slice(0, limit)
      return {
        operations: page.map((r) =>
          projectStoredEnrollmentOperation(
            (JSON.parse(String(r.record_json)) as EnrollmentRow).operation
          )
        ),
        next: rows.length > limit ? 'enrollment:' + String(page.at(-1)!.sequence) : null
      }
    })
  }
}
