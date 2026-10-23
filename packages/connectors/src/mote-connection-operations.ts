import { mintObjectId } from '@agentmux/core/object-id'
import type { DatabaseSync } from 'node:sqlite'
import {
  AgentMuxError,
  parseMoteConnectionParams,
  parseMoteConnectionOperation,
  type MoteConnectionPort,
  type MoteConnectionCreate,
  type MoteConnectionSync,
  type MoteConnectionOperation,
  type MoteConnectionAdvanceInput,
  type MoteConnectionListInput
} from '@agentmux/core'
import {
  moteConnectionBaseline,
  parseMotePreferencesSaveParams,
  parseMotePreferencesSaveResult,
  type MoteConnectionBaseline,
  type MoteConnectionPreferencesReadInput,
  type MoteConnectionPreferencesReadResult,
  type MoteConnectionPreferencesSaveParams,
  type MoteConnectionPreferencesSaveResult
} from '@agentmux/core/mote-preferences'
import {
  parseConnectionEnrollmentResult,
  parseConnectionEnrollmentParams,
  type ConnectionEnrollmentAdvanceInput,
  parseConnectionProfileResult,
  type ConnectionEnrollmentCallContext,
  type ConnectionEnrollmentBeginInput,
  parseConnectionSetupResult,
  type ConnectionSetupBegin,
  connectionProfileAvatarDigest,
  type ConnectionSetupAdvance
} from '@agentmux/core/connections'
import type { ConnectionServices } from './connection-services.js'

type Input = MoteConnectionCreate | MoteConnectionSync
type Row = {
  input: unknown
  actor: ConnectionEnrollmentCallContext['actor']
  operation: MoteConnectionOperation
  baseline: MoteConnectionBaseline | null
  enrollmentInput: ConnectionEnrollmentBeginInput | null
  setupInput?: ConnectionSetupBegin | null
  defaultOperationId: string
  defaultPhase: 'pending' | 'dispatching' | 'settled'
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sameActor = (
  a: ConnectionEnrollmentCallContext['actor'],
  b: ConnectionEnrollmentCallContext['actor']
) => a.kind === b.kind && a.id === b.id
const failure = (code = 'MOTE_CONNECTION_STORAGE_UNCONFIRMED') =>
  new AgentMuxError(
    'This original Mote robot setup is unconfirmed. Keep its operation and inspect it; existing files, robots and conversations remain available.',
    code
  )
/** A finite parent over existing owners. Files and child journals remain their own authorities. */
export class MoteConnectionOperations implements MoteConnectionPort {
  private closed = false
  private database: DatabaseSync | undefined
  private opening: Promise<DatabaseSync> | undefined
  private readonly active = new Map<string, Promise<MoteConnectionOperation>>()
  constructor(
    private readonly ports: {
      connections: Pick<ConnectionServices, 'openDatabase' | 'connections'>
      assertTarget(target: MoteConnectionCreate['source']['target']): Promise<void>
      preferences: {
        read(input: MoteConnectionPreferencesReadInput): Promise<MoteConnectionPreferencesReadResult>
        save(input: MoteConnectionPreferencesSaveParams, context?: ConnectionEnrollmentCallContext): Promise<MoteConnectionPreferencesSaveResult>
      }
    }
  ) {}
  close(): void {
    this.closed = true
  }
  private safe<T>(call: () => T): T {
    try {
      return call()
    } catch (e) {
      if (e instanceof AgentMuxError) throw e
      throw failure()
    }
  }
  private async db(): Promise<DatabaseSync> {
    if (this.closed) throw failure()
    if (this.database) return this.database
    this.opening ??= (async () => {
      try {
        const db = await this.ports.connections.openDatabase()
        if (this.closed) throw failure()
        this.safe(() =>
          db.exec(
            'CREATE TABLE IF NOT EXISTS mote_connection_operation (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, target_json TEXT NOT NULL, record_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS mote_connection_target ON mote_connection_operation(target_json, ordinal);'
          )
        )
        return (this.database = db)
      } finally {
        this.opening = undefined
      }
    })()
    return this.opening
  }
  private txn<T>(call: () => T): T {
    return this.safe(() => {
      const db = this.database!
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = call()
        db.exec('COMMIT')
        return result
      } catch (e) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* Original operation may be read after an uncertain commit. */
        }
        throw e
      }
    })
  }
  private read(id: string): Row | null {
    return this.safe(() => {
      const value = this.database!.prepare(
        'SELECT record_json FROM mote_connection_operation WHERE operation_id=?'
      ).get(id)
      return value ? (JSON.parse(String(value.record_json)) as Row) : null
    })
  }
  private save(row: Row): void {
    this.project(row)
    this.database!.prepare('UPDATE mote_connection_operation SET record_json=? WHERE operation_id=?').run(
      JSON.stringify(row),
      row.operation.operationId
    )
  }
  private update(id: string, change: (row: Row) => void): Row {
    return this.txn(() => {
      const row = this.read(id)
      if (!row) throw failure('UNKNOWN_MOTE_CONNECTION_OPERATION')
      change(row)
      this.save(row)
      return row
    })
  }
  private project(row: Row): MoteConnectionOperation {
    const op = structuredClone(row.operation)
    // Original child summaries may contain retired private challenge material. Read without rewriting it.
    if (op.enrollment) delete (op.enrollment as unknown as Record<string, unknown>).challenge
    if (row.defaultPhase === 'dispatching') {
      op.defaultLink.state = 'unknown'
      op.issue = 'default-unconfirmed'
    }
    return parseMoteConnectionOperation(op)
  }
  private async authority(context: ConnectionEnrollmentCallContext, row?: Row): Promise<void> {
    if (this.closed) throw failure()
    if (row && !sameActor(row.actor, context.actor)) throw failure('CONTROL_PERMISSION_DENIED')
    context.signal?.throwIfAborted()
    await context.assertCurrent?.()
    if (this.closed) throw failure()
    context.signal?.throwIfAborted()
  }
  private context(context: ConnectionEnrollmentCallContext): ConnectionEnrollmentCallContext {
    return {
      ...context,
      actor: { kind: context.actor.kind, id: context.actor.id },
      assertCurrent: () => this.authority(context)
    }
  }
  async inspect(value: { operationId: string }, context?: ConnectionEnrollmentCallContext) {
    const input = parseMoteConnectionParams('space.mote.connection.inspect', value)
    await this.db()
    const row = this.read(input.operationId)
    if (context?.actor.kind === 'agent' && row) await this.authority(context, row)
    return { operation: row ? this.project(row) : null }
  }
  async list(value: MoteConnectionListInput, context?: ConnectionEnrollmentCallContext) {
    const input = parseMoteConnectionParams('space.mote.connection.ls', value)
    await this.db()
    const before = input.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(input.cursor)
    if (
      !Number.isSafeInteger(before) ||
      before < 1 ||
      (input.cursor !== undefined && !/^[1-9][0-9]*$/u.test(input.cursor))
    )
      throw failure('INVALID_MOTE_CONNECTION_DATA')
    return this.safe(() => {
      const limit = input.limit ?? 25,
        rows = this.database!.prepare(
          context?.actor.kind === 'agent' ? "SELECT ordinal,record_json FROM mote_connection_operation WHERE target_json=? AND ordinal<? AND json_extract(record_json,'$.actor.kind')=? AND json_extract(record_json,'$.actor.id')=? ORDER BY ordinal DESC LIMIT ?" : 'SELECT ordinal,record_json FROM mote_connection_operation WHERE target_json=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?'
        ).all(...(context?.actor.kind === 'agent' ? [JSON.stringify(input.target), before, context.actor.kind, context.actor.id, limit + 1] : [JSON.stringify(input.target), before, limit + 1]))
      return {
        operations: rows.slice(0, limit).map((r) => this.project(JSON.parse(String(r.record_json)) as Row)),
        next: rows.length > limit ? String(rows[limit - 1]!.ordinal) : null
      }
    })
  }
  async create(value: MoteConnectionCreate, context: ConnectionEnrollmentCallContext) {
    return this.admit('create', parseMoteConnectionParams('space.mote.connection.create', value), context)
  }
  async sync(value: MoteConnectionSync, context: ConnectionEnrollmentCallContext) {
    return this.admit('sync', parseMoteConnectionParams('space.mote.connection.sync', value), context)
  }
  private async admit(
    action: 'create' | 'sync',
    input: Input,
    context: ConnectionEnrollmentCallContext
  ): Promise<MoteConnectionOperation> {
    await this.authority(context)
    await this.db()
    let row = this.read(input.operationId)
    if (row) {
      if (!same(row.input, input) || row.operation.action !== action)
        throw failure('CONNECTION_OPERATION_CONFLICT')
      await this.authority(context, row)
      return this.project(row)
    }
    await this.ports.assertTarget(input.source.target)
    const source = {
      name: input.desired.name, description: input.desired.description,
      pngDataUrl: input.desired.avatar?.pngDataUrl ?? null,
      avatarSha256: input.desired.avatar ? connectionProfileAvatarDigest(input.desired.avatar.pngDataUrl) : null
    }
    const baseline =
      action === 'create'
        ? moteConnectionBaseline(
            await this.ports.preferences.read({ kind: 'connection', target: input.source.target })
          )
        : null
    if (action === 'create' && !baseline) throw failure('MOTE_CONNECTION_SOURCE_UNCONFIRMED')
    if (action === 'sync') {
      const sync = input as MoteConnectionSync,
        current = (
          await this.ports.connections.connections.inspect({ connectionId: sync.connection.connectionId })
        ).connection
      if (
        !current ||
        current.revision !== sync.expectedConnectionRevision ||
        !same(current.config.application, sync.connection.application)
      )
        throw failure('CONNECTION_REVISION_CONFLICT')
    }
    await this.authority(context)
    row = this.txn(() => {
      const old = this.read(input.operationId)
      if (old) {
        if (
          !same(old.input, input) ||
          !sameActor(old.actor, context.actor) ||
          old.operation.action !== action
        )
          throw failure('CONNECTION_OPERATION_CONFLICT')
        return old
      }
      const name = source.name,
        enrollmentOperationId = action === 'create' ? mintObjectId() : null,
        setupOperationId = action === 'sync' ? mintObjectId() : null,
        connectionId =
          action === 'create' ? mintObjectId() : (input as MoteConnectionSync).connection.connectionId
      const operation: MoteConnectionOperation = {
        operationId: input.operationId,
        action,
        source: input.source,
        snapshot: { name, description: source.description, avatarSha256: source.avatarSha256 },
        connection: action === 'sync' ? (input as MoteConnectionSync).connection : null,
        enrollmentOperationId,
        profileOperationId: null,
        ...(setupOperationId ? { setupOperationId, setup: null } : {}),
        defaultSave: null,
        enrollment: null,
        profile: null,
        defaultLink: { state: action === 'create' ? 'pending' : 'not-requested', current: null },
        issue: null
      }
      const enrollmentInput =
        action === 'create'
          ? {
              operationId: enrollmentOperationId!,
              connectionId,
              adapterId: (input as MoteConnectionCreate).adapterId,
              domain: (input as MoteConnectionCreate).domain,
              label: name,
              ...((input as MoteConnectionCreate).initialPublication ? { initialPublication: (input as MoteConnectionCreate).initialPublication } : {}),
              preset: {
                name,
                ...(source.description === null ? {} : { description: source.description }),
                avatar: { pngDataUrl: source.pngDataUrl! }
              }
            }
          : null
      const row: Row = {
        input,
        actor: context.actor,
        operation,
        baseline,
        enrollmentInput,
        setupInput: action === 'sync' ? {
          operationId: setupOperationId!, connectionId,
          expectedConnectionRevision: (input as MoteConnectionSync).expectedConnectionRevision,
          goal: { kind: 'profile-update', desired: {
            name, description: source.description ?? '',
            ...(source.pngDataUrl ? { avatar: { pngDataUrl: source.pngDataUrl } } : {})
          }, publication: { notes: 'Update bot identity from the saved Mote profile.' } }
        } : null,
        defaultOperationId: mintObjectId(),
        defaultPhase: 'pending'
      }
      parseMoteConnectionOperation(operation)
      this.database!.prepare(
        'INSERT INTO mote_connection_operation(operation_id,target_json,record_json) VALUES(?,?,?)'
      ).run(input.operationId, JSON.stringify(input.source.target), JSON.stringify(row))
      return row
    })
    return this.runJoined(row.operation.operationId, context, false)
  }
  async advance(value: MoteConnectionAdvanceInput, context: ConnectionEnrollmentCallContext) {
    const input = parseMoteConnectionParams('space.mote.connection.advance', value)
    await this.db()
    const row = this.read(input.operationId)
    if (!row) throw failure('UNKNOWN_MOTE_CONNECTION_OPERATION')
    await this.authority(context, row)
    if (input.enrollment && input.enrollment.operationId !== row.enrollmentInput?.operationId ||
      input.setup && input.setup.operationId !== row.setupInput?.operationId) throw failure('CONNECTION_OPERATION_CONFLICT')
    return this.runJoined(input.operationId, context, true, input.enrollment, input.setup)
  }
  private async runJoined(
    id: string,
    context: ConnectionEnrollmentCallContext,
    advance: boolean,
    enrollment?: ConnectionEnrollmentAdvanceInput,
    setup?: ConnectionSetupAdvance
  ): Promise<MoteConnectionOperation> {
    const active = this.active.get(id)
    if (active) return this.project(this.read(id)!)
    const work = this.run(id, context, advance, enrollment, setup)
    this.active.set(id, work)
    try {
      return await work
    } finally {
      if (this.active.get(id) === work) this.active.delete(id)
    }
  }
  private async run(
    id: string,
    context: ConnectionEnrollmentCallContext,
    advance: boolean,
    enrollment?: ConnectionEnrollmentAdvanceInput,
    setup?: ConnectionSetupAdvance
  ): Promise<MoteConnectionOperation> {
    let row = this.read(id)!,
      childContext = this.context(context)
    await this.authority(context, row)
    if (row.enrollmentInput) {
      const port = this.ports.connections.connections.enrollment!
      try {
        const childId = row.enrollmentInput.operationId
        const original = await port.inspect({ operationId: childId }, childContext)
        let receipt = original.operation
        if (!receipt) {
          // An old raw request without the new frozen asset remains readable; it cannot start a new route.
          const input = parseConnectionEnrollmentParams('connection.enrollment.begin', row.enrollmentInput)
          receipt = parseConnectionEnrollmentResult(
            'connection.enrollment.begin',
            await port.begin(input, childContext),
            input
          ).operation
        } else if (enrollment) {
          receipt = parseConnectionEnrollmentResult(
            'connection.enrollment.advance',
            await port.advance(enrollment, childContext),
            enrollment
          ).operation
        }
        if (!receipt) throw failure('UNKNOWN_CONNECTION_ENROLLMENT')
        const accepted = receipt
        row = this.update(id, (current) => {
          if (current.operation.enrollment && current.operation.enrollment.revision > accepted.revision)
            return
          current.operation.enrollment = accepted
          if (current.operation.issue === 'child-unconfirmed') current.operation.issue = null
          if (accepted.configuration === 'configured' && accepted.configured)
            current.operation.connection = {
              connectionId: accepted.connectionId,
              application: accepted.configured.connection.config.application
            }
        })
      } catch {
        return this.project(
          this.update(id, (r) => {
            r.operation.issue = 'child-unconfirmed'
          })
        )
      }
      if (!row.operation.connection) return this.project(row)
    }
    if (row.baseline && !row.operation.defaultSave) {
      row = this.update(id, (r) => {
        if (!r.operation.defaultSave) r.operation.defaultSave = {
            params: parseMotePreferencesSaveParams({
              kind: 'connection',
              target: r.operation.source.target,
              operationId: r.defaultOperationId,
              baseline: r.baseline!,
              values: { connection: r.operation.connection! }
            }) as MoteConnectionPreferencesSaveParams,
            observedReceipt: null
          }
      })
    }
    if (row.operation.defaultSave && row.defaultPhase === 'pending') {
      await this.authority(context, row)
      let claimed = false
      row = this.update(id, (r) => {
        if (r.defaultPhase === 'pending') {
          r.defaultPhase = 'dispatching'
          claimed = true
        }
      })
      if (claimed) {
        try {
          const input = row.operation.defaultSave!.params
          const receipt = parseMotePreferencesSaveResult(
            await this.ports.preferences.save(input, childContext),
            input
          )
          row = this.update(id, (r) => {
            r.operation.defaultSave!.observedReceipt = receipt as MoteConnectionPreferencesSaveResult
            r.defaultPhase = 'settled'
            r.operation.defaultLink.state =
              receipt.status === 'saved' || receipt.status === 'unchanged'
                ? 'saved'
                : receipt.status === 'refused-before-write'
                  ? 'conflict'
                  : 'unknown'
            r.operation.issue =
              receipt.status === 'refused-before-write'
                ? 'default-conflict'
                : receipt.status === 'unconfirmed'
                  ? 'default-unconfirmed'
                  : null
          })
        } catch {
          row = this.update(id, (r) => {
            r.operation.issue = 'default-unconfirmed'
          })
        }
      }
    }
    // Observing current values cannot manufacture an ACK or release a previously dispatched File save.
    if (row.operation.defaultSave && (advance || row.defaultPhase !== 'pending')) {
      try {
        const current = moteConnectionBaseline(
          await this.ports.preferences.read({ kind: 'connection', target: row.operation.source.target })
        )
        if (current)
          row = this.update(id, (r) => {
            r.operation.defaultLink.current = {
              connection: current.values.connection,
              fileRevision: current.document?.revision ?? null
            }
          })
      } catch {
        /* Keep the original File save and child receipts. */
      }
    }
    if (row.operation.action === 'create') return this.project(row)
    try {
      const input = row.setupInput
      if (input) {
        const port = this.ports.connections.connections.setup!
        const original = await port.inspect({ operationId: input.operationId }, childContext)
        const result = !original.operation
          ? parseConnectionSetupResult('connection.setup.begin', await port.begin(input, childContext), input)
          : setup
            ? parseConnectionSetupResult('connection.setup.advance', await port.advance(setup, childContext), setup)
            : original
        if (!result.operation) throw failure('UNKNOWN_CONNECTION_OPERATION')
        row = this.update(id, current => {
          if (current.operation.setup && current.operation.setup.revision > result.operation!.revision) return
          current.operation.setup = result.operation
          if (current.operation.issue === 'child-unconfirmed') current.operation.issue = null
        })
        return this.project(row)
      }
      // Historical writes remain readable. New management never executes an old profile child.
      const inputId = row.operation.profileOperationId
      if (!inputId) throw failure('UNKNOWN_CONNECTION_OPERATION')
      const receipt = parseConnectionProfileResult('connection.profile.inspect', await this.ports.connections.connections.profile!.inspect({ operationId: inputId }, childContext), { operationId: inputId }).operation
      row = this.update(id, (r) => {
        r.operation.profile = receipt
        if (r.operation.issue === 'child-unconfirmed') r.operation.issue = null
      })
    } catch (error) {
      row = this.update(id, (r) => {
        if (!r.operation.issue)
          r.operation.issue =
            error instanceof AgentMuxError && error.code === 'CONNECTION_REVISION_CONFLICT'
              ? 'connection-revised'
              : 'child-unconfirmed'
      })
    }
    return this.project(row)
  }
}
