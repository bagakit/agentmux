import { ApplicationAccessHost } from './application-access.js'
import { parseConnectionDeletionParams, parseConnectionDeletionResult, type ConnectionDeleteInput, type ConnectionDeleteOperation } from '@agentmux/core/connections'
import { ConnectionSetupHost } from './connection-setup.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ConnectionProfileHost } from './connection-profile.js'
import { ConnectionEnrollmentHost } from './connection-enrollment.js'
import { createRoomDiscovery } from './room-discovery.js'
import { ChannelStorage, type ChannelStoragePort, type ChannelStorageScope } from './channel-storage.js'
import type { ChannelProfileAdapter } from './channel-profile-adapter.js'
import type { ChannelActorProfileObservation, ChannelProfileReason, ConnectionActor } from '@agentmux/core/connections'
import type { ChannelMetadataChange, ChannelMetadataPort } from '@agentmux/core/connections'
import { createChannelMetadata } from './channel-metadata.js'
import { credentialLookupFailure } from './credential-observation.js'
import { AgentMuxError } from '@agentmux/core'
import { parseConnectionConfig, parseConnectionObservation, parseConnectionParams, parseConnectionRecord, parseConnectionResult, parseConnectionServiceParams, parseConnectionServiceResult, parseConnectionServiceState, type ConnectionConfig, type ConnectionConfigureInput, type ConnectionInspectInput, type ConnectionInspectResult, type ConnectionObservation, type ConnectionOperation, type ConnectionPort, type ConnectionRecord, type ConnectionServiceState, type ConnectionServicePort, type ConnectionServiceConfigure, type ConnectionServiceOperation, type ConnectionServiceSelector } from '@agentmux/core/connections'

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
  /** Original Host configuration decides retention; this never authorizes platform calls. */
  setClientRetention?(read: (connectionId: string) => boolean): void
  /** Release cached clients only; already admitted requests retain their original lifetime. */
  releaseConnection?(connectionId: string): void
  close?(): void
  readonly channelProfiles?: ChannelProfileAdapter
  readonly api?: import('./connection-api-adapter.js').ConnectionApiAdapter
  readonly profile?: import('./connection-profile-adapter.js').ConnectionProfileAdapter
  readonly setup?: import('./connection-setup-adapter.js').ConnectionSetupAdapter
  readonly enrollment?: import('./connection-enrollment-adapter.js').ConnectionEnrollmentAdapter
  readonly publication?: import('./publication-adapter.js').PublicationAdapter
  readonly rooms?: import('./room-provisioning-adapter.js').RoomProvisioningAdapter
  readonly roomDiscovery?: import('./room-discovery-adapter.js').RoomDiscoveryAdapter
  readonly ingress?: import('./durable-ingress.js').IngressAuthenticator
  readonly transport?: import('./connection-receivers.js').ConnectionIngressTransport
  /** Return facts from the original adapter protocol; no implicit send or Agent execution. */
  test(config: ConnectionConfig, credential: string): Promise<ConnectionObservation>
}
export type ConnectionHostOptions = { databasePath?: string; database?: DatabaseSync; secrets: SecretPort; adapters?: readonly ConnectionAdapter[] }
const unknown = (): ConnectionObservation => ({ authentication: { state: 'unknown', reason: 'not-tested' }, transport: { state: 'unknown', reason: 'not-tested' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } })
function disabled(): ConnectionObservation { return { authentication: { state: 'disabled' }, transport: { state: 'disabled' }, intake: { state: 'disabled' }, delivery: { state: 'disabled' } } }
function unavailable(reason: 'credential-missing' | 'credential-format-unsupported' | 'credential-unavailable' | 'adapter-unavailable' | 'check-failed'): ConnectionObservation {
  return { ...unknown(), authentication: { state: reason === 'adapter-unavailable' || reason === 'check-failed' ? 'unknown' : 'unavailable', reason }, transport: { state: reason === 'check-failed' ? 'unknown' : 'unavailable', reason } }
}
/** Optional original Host owner. Configuration and its operation receipt commit in one SQLite transaction. */
export class ConnectionHost implements ConnectionPort {
  readonly applicationAccess: ApplicationAccessHost
  readonly service: ConnectionServicePort
  readonly metadata: ChannelMetadataPort
  api?: import('@agentmux/core/connections').ConnectionApiPort
  private serviceSchemaReady = false
  profile?: import('@agentmux/core/connections').ConnectionProfilePort
  setup?: import('@agentmux/core/connections').ConnectionSetupPort
  enrollment?: import('@agentmux/core/connections').ConnectionEnrollmentPort
  rooms?: import('@agentmux/core/connections').RoomPort
  bindings?: import('@agentmux/core/connections').RoomBindingsPort
  delivery?: import('@agentmux/core/connections').ConnectionDeliveryPort
  ingress?: import('@agentmux/core/connections').ConnectionIngressReadPort
  receiverObservation?: ((connectionId: string, revision: number) => Pick<ConnectionObservation, 'authentication' | 'transport' | 'intake'> | null) | undefined
  readonly database: DatabaseSync
  private readonly adapters: Map<string, ConnectionAdapter>
  private readonly observations = new Map<string, { revision: number; value: ConnectionObservation }>()
  private readonly closeRoomDiscovery: () => void
  private profileHost: ConnectionProfileHost | undefined
  private setupHost: ConnectionSetupHost | undefined
  private enrollmentHost: ConnectionEnrollmentHost | undefined
  private channelStorageOwner: ChannelStorage | undefined
  private readonly channelProfileAbort = new AbortController()
  private readonly channelProfileReads = new Map<string, Promise<ChannelActorProfileObservation>>()
  private readonly metadataListeners = new Set<(change: ChannelMetadataChange) => void>()
  private readonly conversationProfileReads = new Set<string>()
  private closed = false
  constructor(private readonly options: ConnectionHostOptions) {
    this.applicationAccess = new ApplicationAccessHost(this)
    let ownedDatabase: DatabaseSync | undefined
    try {
      if (!options.database && !options.databasePath) throw new Error('Missing original connection database.')
      if (!options.database && options.databasePath !== ':memory:') mkdirSync(dirname(options.databasePath!), { recursive: true, mode: 0o700 })
      this.database = options.database ?? (ownedDatabase = new DatabaseSync(options.databasePath!))
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS connection_configuration (connection_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS connection_configuration_operation (operation_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, result_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connection_room_link_operation (operation_id TEXT PRIMARY KEY, operation_json TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS connection_deleted_identity ON connection_configuration_operation(json_extract(input_json,\'$.deletion.connectionId\')) WHERE json_extract(input_json,\'$.deletion.connectionId\') IS NOT NULL;')
    } catch {
      try { ownedDatabase?.close() } catch { /* Preserve the original initialization failure without exposing storage details. */ }
      throw new AgentMuxError('Connection configuration storage is unavailable. Existing Agents are retained.', 'CONNECTION_STORAGE_UNAVAILABLE')
    }
    this.service = { get: async input => this.readService(input), configure: async input => this.configureService(input), inspect: async input => {
      const parsed = parseConnectionServiceParams('connection.service.inspect', input)
      return this.serviceSafe(() => { const saved = this.storedOperation(parsed.operationId); return { operation: saved?.kind === 'service' ? saved.operation : null } })
    } }
    this.adapters = new Map((options.adapters ?? []).map(adapter => [adapter.adapterId, adapter]))
    if (this.adapters.size !== (options.adapters?.length ?? 0)) { if (!options.database) this.database.close(); throw new AgentMuxError('Connection adapter IDs must be unique.', 'INVALID_CONNECTION_DATA') }
    for (const adapter of this.adapters.values()) try {
      adapter.setClientRetention?.(connectionId => {
        if (this.closed) return false
        const current = this.readConfiguration(connectionId)?.config
        return current?.enabled === true && current.adapterId === adapter.adapterId
      })
    } catch { process.emitWarning('A connection adapter could not attach its resource owner.', { code: 'CONNECTION_RESOURCE_OWNER_UNAVAILABLE' }) }
    this.metadata = createChannelMetadata(this, options.secrets, this.channelProfileAbort.signal, change => this.publishMetadata(change))
    const discovery = createRoomDiscovery(this, options.secrets)
    this.rooms = discovery.port; this.closeRoomDiscovery = discovery.close
    const profile = (): ConnectionProfileHost => {
      if (this.closed) throw new AgentMuxError('The original profile owner is closed.', 'CONNECTION_PROFILE_UNAVAILABLE')
      if (this.profileHost) return this.profileHost
      try { return this.profileHost = new ConnectionProfileHost(this, options.secrets) }
      catch { throw new AgentMuxError('Profile storage is unavailable. Existing connections remain available; retry this original profile operation.', 'CONNECTION_PROFILE_UNAVAILABLE') }
    }
    this.profile = { get: async (input, context) => profile().get(input, context), inspect: async (input, context) => profile().inspect(input, context), list: async (input, context) => profile().list(input, context) }
    this.setup = { begin: (input, context) => this.setupOwner().begin(input, context), advance: (input, context) => this.setupOwner().advance(input, context), inspect: (input, context) => this.setupOwner().inspect(input, context), list: (input, context) => this.setupOwner().list(input, context) }
    this.enrollment = { begin: async (input, context) => this.enrollmentOwner().begin(input, context), advance: async (input, context) => this.enrollmentOwner().advance(input, context), inspect: async (input, context) => this.enrollmentOwner().inspect(input, context), list: async (input, context) => this.enrollmentOwner().list(input, context) }
  }
  private setupOwner(): ConnectionSetupHost {
    if (this.closed) throw new AgentMuxError('The original management owner is closed. Inspect the same request on its Host.', 'CONNECTION_SETUP_UNCONFIRMED')
    if (this.setupHost) return this.setupHost
    const secrets = this.options.secrets as Partial<import('./connection-enrollment-adapter.js').EnrollmentSecrets>
    try {
      return this.setupHost = new ConnectionSetupHost(this, typeof secrets.store === 'function' && typeof secrets.inspect === 'function' && typeof secrets.assertAvailable === 'function' ? secrets as import('./connection-enrollment-adapter.js').EnrollmentSecrets : undefined, (source, target, context) => this.enrollmentOwner().setupSource(source, target, context))
    } catch { throw new AgentMuxError('Original management request storage is unavailable. Existing bots and Agents remain available; restore storage and inspect the same request.', 'CONNECTION_SETUP_UNCONFIRMED') }
  }
  initialSetupObservation(input: import('@agentmux/core/connections').ConnectionSetupBegin, target: Pick<ConnectionConfig, 'adapterId' | 'application'>): NonNullable<ConnectionRecord['initialSetup']> {
    return this.setupOwner().initialSetupObservation(input, target)
  }
  private enrollmentOwner(): ConnectionEnrollmentHost {
    if (this.closed) throw new AgentMuxError('The original enrollment owner is closed. Inspect the original operation on its Host.', 'CONNECTION_ENROLLMENT_UNAVAILABLE')
    if (this.enrollmentHost) return this.enrollmentHost
    const secrets = this.options.secrets as Partial<import('./connection-enrollment-adapter.js').EnrollmentSecrets>
    try {
      return this.enrollmentHost = new ConnectionEnrollmentHost({ connections: this, ...(typeof secrets.store === 'function' && typeof secrets.inspect === 'function' && typeof secrets.assertAvailable === 'function' ? { secrets: secrets as import('./connection-enrollment-adapter.js').EnrollmentSecrets } : {}) })
    } catch {
      throw new AgentMuxError('Application enrollment storage is unavailable. Existing connections remain available; retry this original enrollment after restoring storage access.', 'CONNECTION_ENROLLMENT_UNAVAILABLE')
    }
  }
  async ownsEnrollmentConnection(connectionId: string, agentSessionId: string): Promise<boolean> { return this.enrollmentOwner().ownsConnection(connectionId, agentSessionId) }
  private read(connectionId: string, includeReceiver = true): ConnectionRecord | null {
    const row = this.database.prepare('SELECT config_json, revision FROM connection_configuration WHERE connection_id = ?').get(connectionId)
    if (!row) return null
    const config = parseConnectionConfig(JSON.parse(row.config_json as string)), revision = Number(row.revision), observed = this.observations.get(connectionId)
    let observation = !config.enabled ? disabled() : { ...(observed?.revision === revision ? observed.value : unknown()), ...(includeReceiver ? this.receiverObservation?.(connectionId, revision) : {}) }
    if (config.enabled && includeReceiver) {
      try { if (!this.automaticTrafficEnabled(config.adapterId)) observation = { ...observation, transport: { state: 'disabled' }, intake: { state: 'disabled' }, delivery: { state: 'disabled' } } }
      catch { observation = { ...observation, transport: { state: 'unknown', reason: 'check-failed' }, intake: { state: 'unknown', reason: 'check-failed' }, delivery: { state: 'unknown', reason: 'check-failed' } } }
    }
    let initialSetup: ConnectionRecord['initialSetup']
    if (includeReceiver) {
      try { initialSetup = this.enrollmentOwner().initialSetupObservation(config) }
      catch { /* Association is unconfirmed; do not manufacture a managed requirement for a manual bot. */ }
    }
    const adapter = this.adapters.get(config.adapterId)
    const capabilities = adapter ? { roomDiscovery: !!adapter.roomDiscovery, roomCreation: !!adapter.rooms, roomLink: !!adapter.roomDiscovery?.createLink } : undefined
    return parseConnectionRecord({ config, revision, observation, ...(initialSetup ? { initialSetup } : {}), ...(capabilities ? { capabilities } : {}) })
  }
  /** Synchronous exact configuration read for owners joining this same database transaction. */
  readConfiguration(connectionId: string): ConnectionRecord | null { return this.safe(() => this.read(connectionId, false)) }
  /** Current service policy, also read synchronously inside original intake/publication transactions. */
  readService(selector: ConnectionServiceSelector = {}): ConnectionServiceState {
    const input = parseConnectionServiceParams('connection.service.get', selector)
    return this.serviceSafe(() => {
      if (this.closed) throw new Error('Original owner closed.')
      if (!this.serviceSchemaReady) {
        this.database.exec('CREATE TABLE IF NOT EXISTS connection_service_policy (singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL CHECK(revision>0)); CREATE TABLE IF NOT EXISTS connection_adapter_service_policy (adapter_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL CHECK(revision>0));')
        this.serviceSchemaReady = true
      }
      const row = input.adapterId === undefined ? this.database.prepare('SELECT enabled,revision FROM connection_service_policy WHERE singleton=1').get()
        : this.database.prepare('SELECT enabled,revision FROM connection_adapter_service_policy WHERE adapter_id=?').get(input.adapterId)
      if (!row) return { enabled: true, revision: 0, ...input }
      if (row.enabled !== 0 && row.enabled !== 1 || Number(row.revision) < 1) throw new Error('Original service policy is malformed.')
      return parseConnectionServiceState({ enabled: row.enabled === 1, revision: Number(row.revision), ...input })
    })
  }
  automaticTrafficEnabled(adapterId: string): boolean { return this.readService().enabled && this.readService({ adapterId }).enabled }
  assertServiceEnabled(adapterId: string): void {
    if (!this.automaticTrafficEnabled(adapterId)) throw new AgentMuxError('Connector automatic traffic is disabled by its global or exact adapter policy. Existing applications, inputs and Agents are retained; inspect the original policy to continue.', 'CONNECTION_SERVICE_DISABLED')
  }
  private serviceSafe<T>(run: () => T): T {
    try { return run() } catch (error) {
      this.serviceSchemaReady = false
      if (error instanceof AgentMuxError && ['CONNECTION_OPERATION_CONFLICT', 'CONNECTION_REVISION_CONFLICT'].includes(error.code)) throw error
      throw new AgentMuxError('Connector service policy storage is unconfirmed. Retain the original operation; inspect its receipt or restore storage and read the same service. Existing application management and Agents remain available.', 'CONNECTION_SERVICE_UNCONFIRMED')
    }
  }
  private storedOperation(operationId: string):
    | { kind: 'application'; input: ConnectionConfigureInput; operation: ConnectionOperation }
    | { kind: 'service'; input: ConnectionServiceConfigure; operation: ConnectionServiceOperation }
    | { kind: 'deletion'; input: ConnectionDeleteInput; operation: ConnectionDeleteOperation }
    | null {
    const row = this.database.prepare('SELECT input_json, result_json FROM connection_configuration_operation WHERE operation_id = ?').get(operationId)
    if (!row) return null
    const raw = JSON.parse(row.input_json as string), result = JSON.parse(row.result_json as string)
    if (Object.hasOwn(raw, 'deletion')) {
      const input = parseConnectionDeletionParams('connection.delete', raw.deletion)
      return { kind: 'deletion', input, operation: parseConnectionDeletionResult('connection.delete', result, input) }
    }
    if (Object.hasOwn(raw, 'service')) {
      const input = parseConnectionServiceParams('connection.service.configure', raw)
      return { kind: 'service', input, operation: parseConnectionServiceResult('connection.service.configure', result, input) }
    }
    const input = parseConnectionParams('connection.configure', raw)
    return { kind: 'application', input, operation: parseConnectionResult('connection.configure', result, input) }
  }
  private configureService(value: ConnectionServiceConfigure): ConnectionServiceOperation {
    const input = parseConnectionServiceParams('connection.service.configure', value)
    return this.serviceSafe(() => {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        const saved = this.storedOperation(input.operationId)
        if (saved) {
          if (saved.kind !== 'service' || JSON.stringify(saved.input) !== JSON.stringify(input)) throw new AgentMuxError('The original configuration operation has different input or method. Inspect it without replacing its identity.', 'CONNECTION_OPERATION_CONFLICT')
          this.database.exec('COMMIT'); return saved.operation
        }
        const scope = input.adapterId === undefined ? {} : { adapterId: input.adapterId }
        const current = this.readService(scope)
        if (current.revision !== input.expectedRevision) throw new AgentMuxError('Connector service policy changed. Read the same service before explicitly saving a new intent.', 'CONNECTION_REVISION_CONFLICT')
        const operation: ConnectionServiceOperation = { operationId: input.operationId, expectedRevision: input.expectedRevision, status: 'configured', service: { enabled: input.service.enabled, revision: current.revision + 1, ...scope } }
        if (input.adapterId === undefined) this.database.prepare('INSERT INTO connection_service_policy (singleton,enabled,revision) VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled, revision=excluded.revision').run(Number(operation.service.enabled), operation.service.revision)
        else this.database.prepare('INSERT INTO connection_adapter_service_policy (adapter_id,enabled,revision) VALUES (?,?,?) ON CONFLICT(adapter_id) DO UPDATE SET enabled=excluded.enabled, revision=excluded.revision').run(input.adapterId, Number(operation.service.enabled), operation.service.revision)
        this.database.prepare('INSERT INTO connection_configuration_operation (operation_id,input_json,result_json) VALUES (?,?,?)').run(input.operationId, JSON.stringify(input), JSON.stringify(operation))
        this.database.exec('COMMIT'); return operation
      } catch (error) { try { this.database.exec('ROLLBACK') } catch { /* Inspect the same operation when commit acknowledgement is unknown. */ } throw error }
    })
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
      const found = input.operationId ? this.storedOperation(input.operationId) : null
      const saved = found?.kind === 'application' ? found : null
      return { connection: this.read(input.connectionId ?? saved?.operation.connection.config.connectionId ?? ''), operation: saved?.operation ?? null }
    })
  }
  async inspectDeletion(value: { operationId: string }): Promise<{ operation: ConnectionDeleteOperation | null }> {
    const input = parseConnectionDeletionParams('connection.delete.inspect', value)
    return this.safe(() => {
      const saved = this.storedOperation(input.operationId)
      return { operation: saved?.kind === 'deletion' ? saved.operation : null }
    })
  }
  async delete(value: ConnectionDeleteInput, context?: import('@agentmux/core/connections').ConnectionEnrollmentCallContext): Promise<ConnectionDeleteOperation> {
    const input = parseConnectionDeletionParams('connection.delete', value)
    await context?.assertCurrent?.()
    return this.safe(() => {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        const saved = this.storedOperation(input.operationId)
        if (saved) {
          if (saved.kind !== 'deletion' || JSON.stringify(saved.input) !== JSON.stringify(input)) throw new AgentMuxError('This original operation has another identity or intent. Inspect its original receipt.', 'CONNECTION_OPERATION_CONFLICT')
          this.database.exec('COMMIT'); return saved.operation
        }
        const current = this.readConfiguration(input.connectionId)
        if (!current || current.revision !== input.expectedRevision) throw new AgentMuxError('This local identity changed or was removed before deletion. No identity was deleted by this operation; read the original identity before choosing another intent.', 'CONNECTION_REVISION_CONFLICT')
        const operation: ConnectionDeleteOperation = { operationId: input.operationId, status: 'deleted', connectionId: input.connectionId, application: current.config.application, deletedRevision: current.revision }
        this.database.prepare('DELETE FROM connection_configuration WHERE connection_id=? AND revision=?').run(input.connectionId, input.expectedRevision)
        this.database.prepare('INSERT INTO connection_configuration_operation (operation_id,input_json,result_json) VALUES (?,?,?)').run(input.operationId, JSON.stringify({ deletion: input }), JSON.stringify(operation))
        this.database.exec('COMMIT'); this.observations.delete(input.connectionId)
        this.releaseAdapterResources(this.adapters.get(current.config.adapterId), input.connectionId)
        return operation
      } catch (error) { try { this.database.exec('ROLLBACK') } catch { /* The same original deletion receipt remains the recovery target. */ } throw error }
    })
  }
  async configure(value: ConnectionConfigureInput): Promise<ConnectionOperation> {
    const input = parseConnectionParams('connection.configure', value)
    return this.safe(() => {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        const saved = this.storedOperation(input.operationId)
        if (saved) {
          if (saved.kind !== 'application' || JSON.stringify(saved.input) !== JSON.stringify(input)) throw new AgentMuxError('The original configuration operation has different input. Inspect it without replacing its identity.', 'CONNECTION_OPERATION_CONFLICT')
          this.database.exec('COMMIT'); return saved.operation
        }
        if (this.database.prepare("SELECT 1 FROM connection_configuration_operation WHERE json_extract(input_json,'$.deletion.connectionId')=?").get(input.connection.connectionId)) throw new AgentMuxError('This original local identity was deleted. Connect the application with a new identity; its old receipts and conversations are retained.', 'CONNECTION_IDENTITY_DELETED')
        const current = this.read(input.connection.connectionId)
        if ((current?.revision ?? null) !== input.expectedRevision) throw new AgentMuxError('Connection configuration changed. Read the original connection before saving.', 'CONNECTION_REVISION_CONFLICT')
        if (current && (current.config.adapterId !== input.connection.adapterId || JSON.stringify(current.config.application) !== JSON.stringify(input.connection.application))) throw new AgentMuxError('An existing connection cannot be reassigned to another application. Create a new connection explicitly.', 'CONNECTION_IDENTITY_CONFLICT')
        const connection: ConnectionRecord = { config: input.connection, revision: (current?.revision ?? 0) + 1, observation: input.connection.enabled ? unknown() : disabled() }
        const operation: ConnectionOperation = { operationId: input.operationId, status: 'configured', connection }
        this.database.prepare('INSERT INTO connection_configuration (connection_id, config_json, revision) VALUES (?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET config_json=excluded.config_json, revision=excluded.revision').run(connection.config.connectionId, JSON.stringify(connection.config), connection.revision)
        this.database.prepare('INSERT INTO connection_configuration_operation (operation_id, input_json, result_json) VALUES (?, ?, ?)').run(input.operationId, JSON.stringify(input), JSON.stringify(operation))
        this.database.exec('COMMIT')
        this.observations.delete(connection.config.connectionId)
        if (current && (!connection.config.enabled || current.config.credentialRef !== connection.config.credentialRef)) {
          this.releaseAdapterResources(this.adapters.get(current.config.adapterId), connection.config.connectionId)
        }
        return operation
      } catch (error) { try { this.database.exec('ROLLBACK') } catch { /* COMMIT may already have happened. Read the original operation. */ } throw error }
    })
  }
  async test(value: { connectionId: string }): Promise<ConnectionRecord> {
    const input = parseConnectionParams('connection.test', value), record = this.safe(() => this.read(input.connectionId))
    if (!record) throw new AgentMuxError('The exact connection is unknown.', 'UNKNOWN_CONNECTION')
    if (!record.config.enabled) return record
    const adapter = this.adapters.get(record.config.adapterId)
    let observation: ConnectionObservation = unavailable('check-failed')
    if (!adapter) observation = unavailable('adapter-unavailable')
    else {
      let credential: string | null | undefined
      try { credential = await this.options.secrets.resolve(record.config.credentialRef) }
      catch (error) { observation = unavailable(credentialLookupFailure(error) ?? 'check-failed') }
      if (credential !== undefined) {
        if (!credential) observation = unavailable('credential-missing')
        else try { observation = parseConnectionObservation(await adapter.test(record.config, credential)) }
        catch { observation = unavailable('check-failed') } // Platform exceptions cannot impersonate the original credential resolver.
      }
    }
    // A late check cannot certify a newer application credential/configuration.
    const current = this.safe(() => this.read(input.connectionId))
    if (!current) throw new AgentMuxError('The exact connection is unknown.', 'UNKNOWN_CONNECTION')
    if (current.revision === record.revision) this.observations.set(input.connectionId, { revision: record.revision, value: observation })
    if (current.revision !== record.revision) return current
    const result = this.safe(() => this.read(input.connectionId))!
    // This explicit check reports its own credential result. Current receiver
    // transport/intake remain independent, and ordinary reads keep their native facts.
    return parseConnectionRecord({ ...result, observation: { ...result.observation, authentication: observation.authentication } })
  }
  roomAdapter(connectionId: string): import('./room-provisioning-adapter.js').RoomProvisioningAdapter | null {
    const config = this.readConfiguration(connectionId)?.config
    return config?.enabled ? this.adapters.get(config.adapterId)?.rooms ?? null : null
  }
  publicationAdapter(connectionId: string): import('./publication-adapter.js').PublicationAdapter | null {
    const config = this.readConfiguration(connectionId)?.config
    return config?.enabled ? this.adapters.get(config.adapterId)?.publication ?? null : null
  }
  /** Private adapter storage; names, local aliases and UI routes never select its namespace. */
  onChannelMetadataChanged(listener: (change: ChannelMetadataChange) => void): () => void { this.metadataListeners.add(listener); return () => { this.metadataListeners.delete(listener) } }
  private publishMetadata(change: ChannelMetadataChange): void { for (const listener of this.metadataListeners) try { listener(change) } catch { /* A display subscriber cannot gate native intake or metadata recovery. */ } }
  async observeChannelConversation(config: ConnectionConfig, externalConversationId: string): Promise<void> {
    const identity = JSON.stringify([config.adapterId, config.application.domain, config.application.appId, externalConversationId])
    if (this.closed || this.conversationProfileReads.has(identity)) return
    this.conversationProfileReads.add(identity)
    try {
      const current = this.readConfiguration(config.connectionId)
      if (!current?.config.enabled) return
      const subject = { kind: 'conversation' as const, externalConversationId }, input = { connectionId: config.connectionId, subject }
      const cached = await this.metadata.get(input)
      if (cached.entry.observation.state === 'observed' && cached.entry.observation.freshness === 'current') return
      await this.metadata.refresh({ ...input, expectedConnectionRevision: current.revision })
    } finally { this.conversationProfileReads.delete(identity) }
  }
  channelStorage(scope: ChannelStorageScope): ChannelStoragePort {
    if (this.closed) throw new AgentMuxError('The original Channel storage owner is closed.', 'CHANNEL_STORAGE_UNAVAILABLE')
    this.channelStorageOwner ??= new ChannelStorage(this.database)
    return this.channelStorageOwner.namespace(scope)
  }
  /** A local display snapshot only. It does not check or grant input/publication permission. */
  readChannelActor(connectionId: string, actor: ConnectionActor): ChannelActorProfileObservation {
    const missing = (reason: ChannelProfileReason): ChannelActorProfileObservation => ({ actor, state: 'unknown', profile: null, checkedAt: Date.now(), freshness: 'unknown', reason })
    try {
      const config = this.readConfiguration(connectionId)?.config
      if (!config || config.application.domain !== actor.application.domain || config.application.appId !== actor.application.appId) return missing('source-unconfirmed')
      const adapter = this.adapters.get(config.adapterId)?.channelProfiles
      return adapter ? adapter.readActor({ actor, storage: this.channelStorage(config) }) : missing('adapter-unavailable')
    } catch { return missing('storage-unconfirmed') }
  }
  /** Called after durable ACK, independently of the original input and platform response. */
  observeChannelActor(config: ConnectionConfig, actor: ConnectionActor): Promise<ChannelActorProfileObservation> {
    const identity = JSON.stringify([config.adapterId, config.application.domain, config.application.appId, actor.idType, actor.userId])
    const pending = this.channelProfileReads.get(identity)
    if (pending) return pending
    const read = async (): Promise<ChannelActorProfileObservation> => {
      const cached = this.readChannelActor(config.connectionId, actor)
      if (this.closed || cached.state === 'observed' && cached.freshness === 'current') return cached
      const unavailable = (reason: ChannelProfileReason): ChannelActorProfileObservation => ({ ...cached, state: 'unavailable', freshness: cached.profile ? 'stale' : 'unknown', checkedAt: Date.now(), reason })
      try {
        const current = this.readConfiguration(config.connectionId)?.config
        if (!current?.enabled || current.adapterId !== config.adapterId || current.application.domain !== actor.application.domain || current.application.appId !== actor.application.appId) return cached
        const adapter = this.adapters.get(current.adapterId)?.channelProfiles
        if (!adapter) return cached
        let credential: string | null
        try { credential = await this.options.secrets.resolve(current.credentialRef) } catch { return unavailable('credential-unavailable') }
        if (!credential || this.channelProfileAbort.signal.aborted) return unavailable('credential-unavailable')
        const observation = await adapter.refreshActor({ actor, config: current, storage: this.channelStorage(current) }, credential, this.channelProfileAbort.signal)
        this.publishMetadata({ connectionId: config.connectionId, application: current.application, subject: { kind: 'actor', actor } })
        return observation
      } catch (error) { return unavailable(error instanceof AgentMuxError && error.code === 'CHANNEL_STORAGE_UNAVAILABLE' ? 'storage-unconfirmed' : 'source-unconfirmed') }
    }
    const work = read().finally(() => { this.channelProfileReads.delete(identity) })
    this.channelProfileReads.set(identity, work)
    return work
  }
  enrollmentAdapters(): ConnectionAdapter[] { return [...this.adapters.values()].filter(a => a.enrollment) }
  registeredAdapter(adapterId: string): ConnectionAdapter | undefined { return this.adapters.get(adapterId) }
  ingressAuthenticators(): import('./durable-ingress.js').IngressAuthenticator[] {
    return [...this.adapters.values()].flatMap(adapter => {
      const ingress = adapter.ingress
      if (!ingress) return []
      return [{ adapterId: adapter.adapterId, verify: (config: ConnectionConfig, raw: string, proof?: unknown) => ingress.verify(config, raw, proof),
        ...(ingress.qualifyReply ? { qualifyReply: (config: ConnectionConfig, event: Readonly<import('./durable-ingress.js').VerifiedIngressEvent>, raw: string, credential: string, signal: AbortSignal) => ingress.qualifyReply!(config, event, raw, credential, signal) } : {}),
        ...(ingress.readHistory ? { readHistory: (config: ConnectionConfig, input: Parameters<NonNullable<import('./durable-ingress.js').IngressAuthenticator['readHistory']>>[1], credential: string, signal: AbortSignal) => ingress.readHistory!(config, input, credential, signal) } : {}) }]
    })
  }
  async resolveCredential(connectionId: string): Promise<string | null> {
    const config = this.readConfiguration(connectionId)?.config
    return config?.enabled ? this.options.secrets.resolve(config.credentialRef) : null
  }
  /** Native business calls borrow this exact registered adapter, never a default external CLI identity. */
  apiAdapter(adapterId: string): import('./connection-api-adapter.js').ConnectionApiAdapter | undefined { return this.adapters.get(adapterId)?.api }
  /** Read-only original Profile fact shared with this application's current Setup owner. */
  unresolvedProfileWrite(application: import('@agentmux/core/connections').ConnectionApplication, actor: import('@agentmux/core/connections').ConnectionEnrollmentCallContext['actor']) {
    this.profileHost ??= new ConnectionProfileHost(this, this.options.secrets)
    return this.profileHost.unresolvedApplicationWrite(application, actor)
  }
  private releaseAdapterResources(adapter: ConnectionAdapter | undefined, connectionId?: string): void {
    try {
      if (connectionId === undefined) adapter?.close?.()
      else adapter?.releaseConnection?.(connectionId)
    } catch {
      // Resource cleanup cannot change an already committed configuration/deletion receipt.
      process.emitWarning('A connection adapter could not release its cached resources.', { code: 'CONNECTION_RESOURCE_RELEASE_FAILED' })
    }
  }
  close(): void {
    if (this.closed) return
    this.closed = true; this.channelProfileAbort.abort(); this.metadataListeners.clear()
    try { this.profileHost?.close(); this.setupHost?.close(); this.enrollmentHost?.close(); this.closeRoomDiscovery() }
    finally {
      for (const adapter of this.adapters.values()) this.releaseAdapterResources(adapter)
      if (!this.options.database) this.database.close()
    }
  }
}
