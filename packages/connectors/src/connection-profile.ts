import { AgentMuxError } from '@agentmux/core'
import {
  parseConnectionProfileParams,
  parseConnectionProfileOperation,
  parseConnectionProfileObservation,
  type ConnectionConfig,
  type ConnectionEnrollmentCallContext,
  type ConnectionProfileOperation,
  type ConnectionProfilePort,
  type ConnectionProfileGet,
  type ConnectionProfileObservation,
  type ConnectionProfileReason
} from '@agentmux/core/connections'
import type { ConnectionHost, SecretPort } from './connection-host.js'
type Row = {
  actor: ConnectionEnrollmentCallContext['actor']
  operation: ConnectionProfileOperation
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const error = (message: string, code = 'CONNECTION_PROFILE_UNCONFIRMED') =>
  new AgentMuxError(message, code)
/** Online reads and immutable original historical receipts. No platform writes or new journal. */
export class ConnectionProfileHost implements ConnectionProfilePort {
  private closed = false
  constructor(
    private readonly connections: ConnectionHost,
    private readonly secrets: SecretPort
  ) {}
  private safe<T>(fn: () => T): T {
    try {
      return fn()
    } catch (e) {
      if (e instanceof AgentMuxError) throw e
      throw error(
        'Original profile history is unavailable. Existing bots remain available.'
      )
    }
  }
  private exists(): boolean {
    return Boolean(
      this.connections.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='connection_profile_operation'"
        )
        .get()
    )
  }
  private read(id: string): Row | null {
    if (!this.exists()) return null
    const r = this.connections.database
      .prepare(
        'SELECT operation_id,connection_id,actor_json,record_json FROM connection_profile_operation WHERE operation_id=?'
      )
      .get(id)
    if (!r) return null
    const operation = parseConnectionProfileOperation(
      JSON.parse(String(r.record_json))
    )
    if (
      operation.operationId !== r.operation_id ||
      operation.connectionId !== r.connection_id
    )
      throw error('The original profile receipt has different identity.')
    for (const step of ['upload', 'patch'] as const)
      if (operation[step].state === 'dispatching') {
        operation[step].state = 'unknown'
        operation.reason = 'effect-unconfirmed'
      }
    return { actor: JSON.parse(String(r.actor_json)), operation }
  }
  private actor(row: Row, context?: ConnectionEnrollmentCallContext): void {
    if (
      context?.actor.kind === 'agent' &&
      (context.actor.kind !== row.actor.kind ||
        context.actor.id !== row.actor.id)
    )
      throw error(
        'The original profile receipt belongs to another actor.',
        'CONTROL_PERMISSION_DENIED'
      )
  }
  async inspect(
    value: {
      operationId: string
    },
    context?: ConnectionEnrollmentCallContext
  ) {
    const i = parseConnectionProfileParams('connection.profile.inspect', value)
    return this.safe(() => {
      const row = this.read(i.operationId)
      if (row) this.actor(row, context)
      return { operation: row?.operation ?? null }
    })
  }
  async list(
    value: {
      connectionId: string
      cursor?: string
      limit?: number
    },
    context?: ConnectionEnrollmentCallContext
  ) {
    const i = parseConnectionProfileParams('connection.profile.ls', value),
      limit = i.limit ?? 25
    let before = Number.MAX_SAFE_INTEGER
    if (i.cursor !== undefined) {
      if (
        !/^[1-9][0-9]*$/u.test(i.cursor) ||
        !Number.isSafeInteger(Number(i.cursor))
      )
        throw error(
          'The original profile history cursor is invalid.',
          'INVALID_CONNECTION_PROFILE_DATA'
        )
      before = Number(i.cursor)
    }
    return this.safe(() => {
      if (!this.exists()) return { operations: [], next: null }
      const actor = context?.actor.kind === 'agent' ? context.actor : undefined
      const rows = this.connections.database
        .prepare(
          actor
            ? "SELECT operation_id,ordinal FROM connection_profile_operation WHERE connection_id=? AND ordinal<? AND json_extract(actor_json,'$.kind')=? AND json_extract(actor_json,'$.id')=? ORDER BY ordinal DESC LIMIT ?"
            : 'SELECT operation_id,ordinal FROM connection_profile_operation WHERE connection_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?'
        )
        .all(
          ...(actor
            ? [i.connectionId, before, actor.kind, actor.id, limit + 1]
            : [i.connectionId, before, limit + 1])
        )
      return {
        operations: rows
          .slice(0, limit)
          .map((row) => this.read(String(row.operation_id))!.operation),
        next: rows.length > limit ? String(rows[limit - 1]!.ordinal) : null
      }
    })
  }
  /** Exact historical application-write fact; it never resolves credentials or executes an old wire. */
  unresolvedApplicationWrite(
    application: ConnectionConfig['application'],
    actor: ConnectionEnrollmentCallContext['actor']
  ): {
    unresolved: true
    original?: { operationId: string; connectionId: string }
  } | null {
    return this.safe(() => {
      if (!this.exists()) return null
      const record = this.connections.database
        .prepare(
          "SELECT operation_id FROM connection_profile_operation WHERE json_extract(record_json,'$.application.domain')=? AND json_extract(record_json,'$.application.appId')=? AND json_extract(record_json,'$.patch.state') IN ('unknown','dispatching') ORDER BY ordinal DESC LIMIT 1"
        )
        .get(application.domain, application.appId)
      if (!record) return null
      const row = this.read(String(record.operation_id))!
      return {
        unresolved: true,
        ...(row.actor.kind === actor.kind && row.actor.id === actor.id
          ? {
              original: {
                operationId: row.operation.operationId,
                connectionId: row.operation.connectionId
              }
            }
          : {})
      }
    })
  }
  private async authority(
    context?: ConnectionEnrollmentCallContext
  ): Promise<void> {
    if (this.closed) throw error('The original profile owner is closed.')
    context?.signal?.throwIfAborted()
    await context?.assertCurrent?.()
    if (this.closed) throw error('The original profile owner is closed.')
    context?.signal?.throwIfAborted()
  }
  private unknown(
    input: ConnectionProfileGet,
    config: ConnectionConfig,
    reason: ConnectionProfileReason
  ): ConnectionProfileObservation {
    return {
      connectionId: input.connectionId,
      connectionRevision: input.expectedConnectionRevision,
      application: config.application,
      language: null,
      state: 'unknown',
      profile: null,
      metadata: null,
      botId: null,
      onlineVersionId: null,
      reviewingVersionId: null,
      version: null,
      reason
    }
  }
  async get(
    value: ConnectionProfileGet,
    context?: ConnectionEnrollmentCallContext
  ): Promise<ConnectionProfileObservation> {
    const i = parseConnectionProfileParams('connection.profile.get', value)
    await this.authority(context)
    const c = this.connections.readConfiguration(i.connectionId)
    if (!c)
      throw error('The exact connection is unknown.', 'UNKNOWN_CONNECTION')
    if (c.revision !== i.expectedConnectionRevision)
      return this.unknown(i, c.config, 'connection-revised')
    const adapter = this.connections.registeredAdapter(
      c.config.adapterId
    )?.profile
    if (!adapter) return this.unknown(i, c.config, 'adapter-unavailable')
    let credential: string | null
    try {
      credential = await this.secrets.resolve(c.config.credentialRef)
    } catch {
      return this.unknown(i, c.config, 'credential-unavailable')
    }
    if (!credential) return this.unknown(i, c.config, 'credential-unavailable')
    await this.authority(context)
    if (
      this.connections.readConfiguration(i.connectionId)?.revision !==
      c.revision
    )
      return this.unknown(i, c.config, 'connection-revised')
    try {
      const observed = parseConnectionProfileObservation(
        await adapter.get(c.config, c.revision, credential, context?.signal)
      )
      if (
        observed.connectionId !== i.connectionId ||
        observed.connectionRevision !== c.revision ||
        !same(observed.application, c.config.application)
      )
        return this.unknown(i, c.config, 'online-unconfirmed')
      if (
        this.closed ||
        this.connections.readConfiguration(i.connectionId)?.revision !==
          c.revision
      )
        return this.unknown(i, c.config, 'connection-revised')
      return observed
    } catch {
      return this.unknown(i, c.config, 'online-unconfirmed')
    }
  }
  close(): void {
    this.closed = true
  }
}
