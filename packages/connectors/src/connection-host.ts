import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from '@agentmux/core'
import { parseConnectionConfig, parseConnectionObservation, parseConnectionParams, parseConnectionRecord, type ConnectionConfig, type ConnectionConfigureInput, type ConnectionInspectInput, type ConnectionInspectResult, type ConnectionObservation, type ConnectionOperation, type ConnectionPort, type ConnectionRecord } from '@agentmux/core/connections'

/** A Host-owned resolver. Never expose this port or its results through RPC/Renderer diagnostics. */
export interface SecretPort {
  resolve(credentialRef: string): Promise<string | null>
}
/** Only trusted local credential entry uses this port; connection.configure accepts references alone. */
export interface WritableSecretPort extends SecretPort {
  store(input: { operationId: string; secret: string }): Promise<{ credentialRef: string }>
}
export interface ConnectionAdapter {
  readonly adapterId: string
  readonly publication?: import('./publication-adapter.js').PublicationAdapter
  /** Return facts from the original adapter protocol; no implicit send or Agent execution. */
  test(config: ConnectionConfig, credential: string): Promise<ConnectionObservation>
}
export type ConnectionHostOptions = { databasePath?: string; database?: DatabaseSync; secrets: SecretPort; adapters?: readonly ConnectionAdapter[] }
const unknown = (): ConnectionObservation => ({ authentication: { state: 'unknown', reason: 'not-tested' }, transport: { state: 'unknown', reason: 'not-tested' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } })
function disabled(): ConnectionObservation { return { authentication: { state: 'disabled' }, transport: { state: 'disabled' }, intake: { state: 'disabled' }, delivery: { state: 'disabled' } } }
function unavailable(reason: 'credential-missing' | 'adapter-unavailable' | 'check-failed'): ConnectionObservation {
  return { ...unknown(), authentication: { state: reason === 'adapter-unavailable' || reason === 'check-failed' ? 'unknown' : 'unavailable', reason }, transport: { state: reason === 'check-failed' ? 'unknown' : 'unavailable', reason } }
}
/** Optional original Host owner. Configuration and its operation receipt commit in one SQLite transaction. */
export class ConnectionHost implements ConnectionPort {
  bindings?: import('@agentmux/core/connections').RoomBindingsPort
  delivery?: import('@agentmux/core/connections').ConnectionDeliveryPort
  readonly database: DatabaseSync
  private readonly adapters: Map<string, ConnectionAdapter>
  private readonly observations = new Map<string, { revision: number; value: ConnectionObservation }>()
  constructor(private readonly options: ConnectionHostOptions) {
    let ownedDatabase: DatabaseSync | undefined
    try {
      if (!options.database && !options.databasePath) throw new Error('Missing original connection database.')
      if (!options.database && options.databasePath !== ':memory:') mkdirSync(dirname(options.databasePath!), { recursive: true, mode: 0o700 })
      this.database = options.database ?? (ownedDatabase = new DatabaseSync(options.databasePath!))
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS connection_configuration (connection_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS connection_configuration_operation (operation_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, result_json TEXT NOT NULL);')
    } catch {
      try { ownedDatabase?.close() } catch { /* Preserve the original initialization failure without exposing storage details. */ }
      throw new AgentMuxError('Connection configuration storage is unavailable. Existing Agents are retained.', 'CONNECTION_STORAGE_UNAVAILABLE')
    }
    this.adapters = new Map((options.adapters ?? []).map(adapter => [adapter.adapterId, adapter]))
    if (this.adapters.size !== (options.adapters?.length ?? 0)) { if (!options.database) this.database.close(); throw new AgentMuxError('Connection adapter IDs must be unique.', 'INVALID_CONNECTION_DATA') }
  }
  private read(connectionId: string): ConnectionRecord | null {
    const row = this.database.prepare('SELECT config_json, revision FROM connection_configuration WHERE connection_id = ?').get(connectionId)
    if (!row) return null
    const config = parseConnectionConfig(JSON.parse(row.config_json as string)), revision = Number(row.revision), observed = this.observations.get(connectionId)
    return parseConnectionRecord({ config, revision, observation: !config.enabled ? disabled() : observed?.revision === revision ? observed.value : unknown() })
  }
  /** Synchronous exact configuration read for owners joining this same database transaction. */
  readConfiguration(connectionId: string): ConnectionRecord | null { return this.safe(() => this.read(connectionId)) }
  private storedOperation(operationId: string): { input: ConnectionConfigureInput; operation: ConnectionOperation } | null {
    const row = this.database.prepare('SELECT input_json, result_json FROM connection_configuration_operation WHERE operation_id = ?').get(operationId)
    if (!row) return null
    const input = parseConnectionParams('connection.configure', JSON.parse(row.input_json as string))
    const value = JSON.parse(row.result_json as string) as ConnectionOperation
    return { input, operation: { operationId, status: 'configured', connection: parseConnectionRecord(value.connection) } }
  }
  private safe<T>(read: () => T): T {
    try { return read() } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw new AgentMuxError('Connection storage could not confirm the original operation. Inspect the same operation before retrying.', 'CONNECTION_STORAGE_UNCONFIRMED')
    }
  }
  async list(): Promise<{ connections: ConnectionRecord[] }> {
    return this.safe(() => ({ connections: this.database.prepare('SELECT connection_id FROM connection_configuration ORDER BY connection_id').all().map(row => this.read(row.connection_id as string)!) }))
  }
  async inspect(value: ConnectionInspectInput): Promise<ConnectionInspectResult> {
    const input = parseConnectionParams('connection.inspect', value)
    return this.safe(() => {
      const saved = input.operationId ? this.storedOperation(input.operationId) : null
      return { connection: this.read(input.connectionId ?? saved?.operation.connection.config.connectionId ?? ''), operation: saved?.operation ?? null }
    })
  }
  async configure(value: ConnectionConfigureInput): Promise<ConnectionOperation> {
    const input = parseConnectionParams('connection.configure', value)
    return this.safe(() => {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        const saved = this.storedOperation(input.operationId)
        if (saved) {
          if (JSON.stringify(saved.input) !== JSON.stringify(input)) throw new AgentMuxError('The original configuration operation has different input. Inspect it without replacing its identity.', 'CONNECTION_OPERATION_CONFLICT')
          this.database.exec('COMMIT'); return saved.operation
        }
        const current = this.read(input.connection.connectionId)
        if ((current?.revision ?? null) !== input.expectedRevision) throw new AgentMuxError('Connection configuration changed. Read the original connection before saving.', 'CONNECTION_REVISION_CONFLICT')
        if (current && (current.config.adapterId !== input.connection.adapterId || JSON.stringify(current.config.application) !== JSON.stringify(input.connection.application))) throw new AgentMuxError('An existing connection cannot be reassigned to another application. Create a new connection explicitly.', 'CONNECTION_IDENTITY_CONFLICT')
        const connection: ConnectionRecord = { config: input.connection, revision: (current?.revision ?? 0) + 1, observation: input.connection.enabled ? unknown() : disabled() }
        const operation: ConnectionOperation = { operationId: input.operationId, status: 'configured', connection }
        this.database.prepare('INSERT INTO connection_configuration (connection_id, config_json, revision) VALUES (?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET config_json=excluded.config_json, revision=excluded.revision').run(connection.config.connectionId, JSON.stringify(connection.config), connection.revision)
        this.database.prepare('INSERT INTO connection_configuration_operation (operation_id, input_json, result_json) VALUES (?, ?, ?)').run(input.operationId, JSON.stringify(input), JSON.stringify(operation))
        this.database.exec('COMMIT')
        this.observations.delete(connection.config.connectionId)
        return operation
      } catch (error) { try { this.database.exec('ROLLBACK') } catch { /* COMMIT may already have happened. Read the original operation. */ } throw error }
    })
  }
  async test(value: { connectionId: string }): Promise<ConnectionRecord> {
    const input = parseConnectionParams('connection.test', value), record = this.safe(() => this.read(input.connectionId))
    if (!record) throw new AgentMuxError('The exact connection is unknown.', 'UNKNOWN_CONNECTION')
    if (!record.config.enabled) return record
    const adapter = this.adapters.get(record.config.adapterId)
    let observation: ConnectionObservation
    if (!adapter) observation = unavailable('adapter-unavailable')
    else {
      try {
        const credential = await this.options.secrets.resolve(record.config.credentialRef)
        observation = credential ? parseConnectionObservation(await adapter.test(record.config, credential)) : unavailable('credential-missing')
      } catch { observation = unavailable('check-failed') } // Adapter exceptions may contain credentials or raw platform payloads.
    }
    // A late check cannot certify a newer application credential/configuration.
    const current = this.safe(() => this.read(input.connectionId))
    if (!current) throw new AgentMuxError('The exact connection is unknown.', 'UNKNOWN_CONNECTION')
    if (current.revision === record.revision) this.observations.set(input.connectionId, { revision: record.revision, value: observation })
    return { ...current, observation: current.revision === record.revision ? observation : current.observation }
  }
  publicationAdapter(connectionId: string): import('./publication-adapter.js').PublicationAdapter | null {
    const config = this.readConfiguration(connectionId)?.config
    return config?.enabled ? this.adapters.get(config.adapterId)?.publication ?? null : null
  }
  async resolvePublicationCredential(connectionId: string): Promise<string | null> {
    const config = this.readConfiguration(connectionId)?.config
    return config?.enabled ? this.options.secrets.resolve(config.credentialRef) : null
  }
  close(): void { if (!this.options.database) this.database.close() }
}
