import { createHash } from 'node:crypto'
import { mkdir, chmod, open, stat, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, isAbsolute, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { AgentExecutionBridge, type AgentExecutionBridgeState, type AgentExecutionBridgePort } from './agent-execution-bridge.js'
import type { AgentMuxClient, AgentMuxHostAgentCreateInput } from './client.js'
import type { AgentMuxAgentSession } from './types.js'
import { AgentMuxError } from './errors.js'
import { parseAgentExecutionNotices, type AgentExecutionNotice } from './agent-execution-helper.js'

export type AgentExecutionHostPort = AgentExecutionBridgePort & Pick<AgentMuxClient,
  'prepareAgentExecutionHelper' | 'inspectPreparedTerminal' | 'createPreparedTerminal' | 'createHostAgentWithDelivery' | 'listHostExecutors' | 'readAgentSession'>
export interface AgentExecutionOpenInput {
  bindingId: string
  agentHostId: string
  agentRuntimeId: string
  resourceHostId: string
  resourceRuntimeId: string
  resourceWorkspacePath: string
  resourceGrant: import('./agent-execution-helper.js').AgentExecutionResourceGrant
  agent: Omit<AgentMuxHostAgentCreateInput, 'toolExecution'> & { agentSessionId: string; createOperationId: string }
}
type RecordValue = { input: AgentExecutionOpenInput; notices?: AgentExecutionNotice[]; diagnostic?: AgentExecutionInspection['diagnostic']; attempts?: Partial<Record<'frontend' | 'executor', { ownerInstanceId: string }>>; bridge?: AgentExecutionBridgeState; frontend?: AgentExecutionBridgeState['frontend']; executor?: AgentExecutionBridgeState['executor'] }
export interface AgentExecutionInspection {
  bindingId: string
  agentHostId: string
  resourceHostId: string
  agentSessionId: string
  resourceWorkspacePath: string
  state: 'unavailable' | 'connected'
  notices?: AgentExecutionNotice[]
  diagnostic?: { code: string; message: string; generation?: string; operation?: import('./agent-execution-journal.js').AgentExecutionOperationKey }
}
const nativeLock = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
const fail = (message: string, code = 'EXECUTION_BINDING_CONFLICT') => new AgentMuxError(message, code)
const creationId = (binding: string, role: string) => createHash('sha256').update(JSON.stringify([binding, role])).digest('hex')

export interface AgentExecutionCoordinatorOptions {
  resolveHost(hostId: string): Promise<{ runtimeId: string; client: AgentExecutionHostPort }>
  onObservation?(value: AgentExecutionInspection): void
}

/** One Core's related execution bindings. Helpers and Agents remain owned by their original Hosts. */
export class AgentExecutionCoordinator {
  private readonly lanes = new Map<string, Promise<unknown>>()
  private readonly bridges = new Map<string, AgentExecutionBridge>()
  private readonly observations = new Map<string, AgentExecutionInspection>()
  private disposed = false
  private constructor(private readonly db: DatabaseSync, private readonly lease: FileHandle, private readonly options: AgentExecutionCoordinatorOptions) {}
  static async open(directory: string, options: AgentExecutionCoordinatorOptions): Promise<AgentExecutionCoordinator> {
    if (!isAbsolute(directory)) throw fail('The exact execution coordinator state root must be absolute.')
    const created = await mkdir(directory, { recursive: true, mode: 0o700 })
    if (created) for (let current = directory;; current = dirname(current)) {
      const fd = await open(current, 'r'); try { await fd.sync() } finally { await fd.close() }
      if (current === dirname(created)) break
    }
    const lease = await open(join(directory, 'owner.lock'), 'a', 0o600)
    if (!nativeLock.tryLock(lease.fd)) { await lease.close(); throw fail('The original execution coordinator already has a writer.', 'EXECUTION_OWNER_UNAVAILABLE') }
    const path = join(directory, 'bindings.sqlite')
    let db: DatabaseSync
    try { db = new DatabaseSync(path); await chmod(path, 0o600) } catch (error) { await lease.close(); throw error }
    try {
      db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA')
      const app = Number(db.prepare('PRAGMA application_id').get()!.application_id)
      if (app === 0 && !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table'").get()) db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE binding_intents (id TEXT PRIMARY KEY, input TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE bindings (id TEXT PRIMARY KEY, record TEXT NOT NULL) WITHOUT ROWID;
        PRAGMA application_id=1095587906; PRAGMA user_version=1;
        COMMIT;
      `)
      if (Number(db.prepare('PRAGMA application_id').get()!.application_id) !== 1095587906 || Number(db.prepare('PRAGMA user_version').get()!.user_version) !== 1)
        throw fail('The original execution binding store is unconfirmed; it was not replaced.', 'EXECUTION_STORAGE_UNCONFIRMED')
      const fd = await open(directory, 'r'); try { await fd.sync() } finally { await fd.close() }
      return new AgentExecutionCoordinator(db, lease, options)
    } catch (error) { db.close(); await lease.close(); throw error }
  }
  private read(bindingId: string): RecordValue | null {
    const row = this.db.prepare('SELECT binding_intents.input,bindings.record FROM bindings LEFT JOIN binding_intents ON binding_intents.id=bindings.id WHERE bindings.id=?').get(bindingId)
    if (!row) return null
    if (typeof row.input !== 'string') throw fail('The original execution intent is missing.', 'EXECUTION_STORAGE_UNCONFIRMED')
    const record = { ...JSON.parse(String(row.record)), input: JSON.parse(row.input) } as RecordValue
    if (record.input?.bindingId !== bindingId) throw fail('Execution binding storage does not identify the requested operation.', 'EXECUTION_STORAGE_UNCONFIRMED')
    return record
  }
  private save(record: RecordValue): void {
    // SQLite's acknowledged EXTRA transaction is the durability fence. No full
    // native payload is stored here; pending Input references existing Replay.
    const { input, ...state } = record
    const encoded = JSON.stringify(state)
    const changed = this.db.prepare('UPDATE bindings SET record=? WHERE id=?').run(encoded, input.bindingId)
    if (changed.changes) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO binding_intents VALUES (?,?)').run(input.bindingId, JSON.stringify(input))
      this.db.prepare('INSERT INTO bindings VALUES (?,?)').run(input.bindingId, encoded)
      this.db.exec('COMMIT')
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error }

  }
  private serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      if (this.disposed) throw fail('This execution coordinator reader is closed.', 'EXECUTION_READER_UNAVAILABLE')
      return await action()
    })
    this.lanes.set(id, next)
    void next.finally(() => { if (this.lanes.get(id) === next) this.lanes.delete(id) }).catch(() => {})
    return next
  }
  private observe(input: AgentExecutionOpenInput, diagnostic?: AgentExecutionInspection['diagnostic'], notices?: AgentExecutionNotice[]): void {
    const value: AgentExecutionInspection = { bindingId: input.bindingId, agentHostId: input.agentHostId, resourceHostId: input.resourceHostId,
      agentSessionId: input.agent.agentSessionId, resourceWorkspacePath: input.resourceWorkspacePath,
      state: diagnostic ? 'unavailable' : 'connected', ...(notices === undefined ? {} : { notices }), ...(diagnostic ? { diagnostic } : {}) }
    this.observations.set(input.bindingId, value)
    try { this.options.onObservation?.(structuredClone(value)) } catch { /* A reader cannot change this operation or healthy helpers. */ }
  }
  inspect(bindingId: string): AgentExecutionInspection | null {
    const record = this.read(bindingId)
    if (!record) return null
    return structuredClone(this.observations.get(bindingId) ?? { bindingId, agentHostId: record.input.agentHostId,
      resourceHostId: record.input.resourceHostId, agentSessionId: record.input.agent.agentSessionId,
      resourceWorkspacePath: record.input.resourceWorkspacePath, state: 'unavailable',
      ...(record.notices === undefined ? {} : { notices: record.notices }),
      diagnostic: record.diagnostic ?? { code: 'EXECUTION_OBSERVATION_UNCONFIRMED', message: 'The original helpers have not been observed by this Core connection.' } })
  }
  /** Resume only retained bridge readers. This never creates or restores an Agent Run. */
  async rejoin(bindingId: string): Promise<AgentExecutionInspection> {
    return await this.serialize(bindingId, async () => {
      const record = this.read(bindingId)
      if (!record?.bridge) throw fail('The original execution bridge has no confirmed helper pair.', 'EXECUTION_HELPER_UNAVAILABLE')
      try {
        const hosts = await this.hosts(record.input)
        await this.attach(record, hosts)
        return this.inspect(bindingId)!
      } catch (error) { this.observeFailure(record.input, error); throw error }
    })
  }
  private observeFailure(input: AgentExecutionOpenInput, error: unknown): void {
    this.observe(input, { code: error instanceof AgentMuxError ? error.code : 'EXECUTION_OBSERVATION_UNCONFIRMED',
      message: error instanceof Error ? error.message : String(error) }, this.read(input.bindingId)?.notices)
  }
  private async hosts(input: AgentExecutionOpenInput) {
    const [agent, resource] = await Promise.all([this.options.resolveHost(input.agentHostId), this.options.resolveHost(input.resourceHostId)])
    if (agent.runtimeId !== input.agentRuntimeId || resource.runtimeId !== input.resourceRuntimeId)
      throw fail('The original Agent or resource Core identity changed; no work was rerouted.', 'EXECUTION_HOST_CHANGED')
    return { agent: agent.client, resource: resource.client }
  }
  private async attach(record: RecordValue, hosts: { agent: AgentExecutionHostPort; resource: AgentExecutionHostPort }): Promise<void> {
    const id = record.input.bindingId
    await this.bridges.get(id)?.close()
    const latest = this.read(id)
    if (!latest || !isDeepStrictEqual(latest.input, record.input)) throw fail('The original execution binding changed while its reader was closing.')
    Object.assign(record, latest)
    const bridge = new AgentExecutionBridge({ state: record.bridge!, ports: { frontend: hosts.agent, executor: hosts.resource },
      persist: async state => { record.bridge = state; this.save(record) },
      onFrame: async (_side, frame) => {
        const value = frame as { type?: string; code?: string; generation?: unknown; operation?: import('./agent-execution-journal.js').AgentExecutionOperationKey }
        if (value.type === 'diagnostic') {
          record.diagnostic = { code: value.code ?? 'EXECUTION_OBSERVATION_UNCONFIRMED', message: 'The original native tool service reported an observation diagnostic. Inspect the retained operation.',
            ...(typeof value.generation === 'string' && value.generation.length > 0 ? { generation: value.generation } : {}),
            ...(value.operation?.bindingId === record.input.bindingId && value.operation.streamGeneration === value.generation &&
              (typeof value.operation.nativeRequestId === 'string' || Number.isSafeInteger(value.operation.nativeRequestId)) ? { operation: structuredClone(value.operation) } : {}) }
          this.save(record); this.observe(record.input, record.diagnostic, record.notices)
        }
      },
      onError: error => this.observeFailure(record.input, error) })
    this.bridges.set(id, bridge)
    await bridge.start()
    this.observe(record.input, record.diagnostic, record.notices)
  }
  /** Original user-authorized creation; retries retain both Host identities and all original operation IDs. */
  async create(value: AgentExecutionOpenInput): Promise<{ session: AgentMuxAgentSession; execution: AgentExecutionInspection }> {
    const input = structuredClone(value)
    if (['bindingId', 'agentHostId', 'agentRuntimeId', 'resourceHostId', 'resourceRuntimeId', 'resourceWorkspacePath'].some(key => typeof input[key as keyof AgentExecutionOpenInput] !== 'string' || !input[key as keyof AgentExecutionOpenInput]) || !input.agent?.agentSessionId || !input.agent.createOperationId || 'toolExecution' in input.agent || input.resourceGrant?.scope !== 'host-user' || input.resourceGrant.bindingId !== input.bindingId)
      throw fail('Execution creation requires its exact original binding, Session and create operation.')
    return await this.serialize(input.bindingId, async () => {
      let record = this.read(input.bindingId)
      if (record && !isDeepStrictEqual(record.input, input)) throw fail('This execution binding already names another original creation.')
      if (!record) { record = { input }; this.save(record) }
      try {
        const hosts = await this.hosts(input)
        const toolExecution = { bindingId: input.bindingId, resourceHostId: input.resourceHostId,
          resourceRuntimeId: input.resourceRuntimeId, workspacePath: input.resourceWorkspacePath }
        const existing = await hosts.agent.readAgentSession(input.agent.agentSessionId)
        if (existing) {
          // The target Core validates the complete original creation digest and
          // retained receipt before consulting a possibly changed Executor.
          const created = await hosts.agent.createHostAgentWithDelivery({ ...input.agent, toolExecution })
          if (record.bridge && !this.bridges.has(input.bindingId)) {
            try { await this.attach(record, hosts) } catch (error) { this.observeFailure(input, error) }
          }
          return { session: created.session, execution: this.inspect(input.bindingId)! }
        }
        const inventory = await hosts.agent.listHostExecutors()
        const selected = inventory.executors.find(executor => executor.executorId === input.agent.executorId)
        if (!selected || selected.configRevision !== input.agent.executorRevision) throw fail('The selected Agent Host Executor configuration changed.', 'EXECUTOR_REVISION_CONFLICT')
        for (const role of ['executor', 'frontend'] as const) {
          const client = role === 'executor' ? hosts.resource : hosts.agent
          const original = await client.prepareAgentExecutionHelper({ bindingId: input.bindingId, agentSessionId: input.agent.agentSessionId,
            providerId: selected.providerId, role, workspacePath: role === 'executor' ? input.resourceWorkspacePath : input.agent.workspacePath,
            createOperationId: creationId(input.bindingId, role), ...(role === 'executor' ? { grant: input.resourceGrant } : { toolExecution }) })
          if (original.notices !== undefined) {
            const notices = parseAgentExecutionNotices(original.notices, { providerId: selected.providerId, role })
            record.notices = [...(record.notices ?? []).filter(notice => notice.role !== role), ...notices]
            this.save(record)
          }
          const retained = record[role]
          if (retained) {
            const observed = await client.inspectPreparedTerminal(original.prepared, { runId: retained.runId })
            if (!observed || observed.state !== 'running' || client.runtimeIdentity().instanceId !== retained.ownerInstanceId)
              throw fail('The original execution helper is unavailable; no replacement was started.', 'EXECUTION_HELPER_UNAVAILABLE')
          } else {
            const ownerInstanceId = client.runtimeIdentity().instanceId
            const attempt = record.attempts?.[role]
            if (attempt && attempt.ownerInstanceId !== ownerInstanceId) throw fail('The original helper Start owner changed; its outcome remains unknown.', 'EXECUTION_HELPER_UNAVAILABLE')
            let run = await client.inspectPreparedTerminal(original.prepared)
            if (!run) {
              if (attempt) throw fail('The original helper Start has no confirmed receipt; it was not submitted again.', 'EXECUTION_HELPER_UNAVAILABLE')
              record.attempts = { ...record.attempts, [role]: { ownerInstanceId } }; this.save(record)
              run = await client.createPreparedTerminal(original.prepared)
            }
            if (run.state !== 'running' || client.runtimeIdentity().instanceId !== ownerInstanceId)
              throw fail('The original helper is not confirmed serving on its original Runtime.', 'EXECUTION_HELPER_UNAVAILABLE')
            record[role] = { runId: run.runId, ownerInstanceId, inputByte: 0, outputByte: 0 }
            this.save(record)
          }
        }
        if (this.bridges.has(input.bindingId)) {
          await this.bridges.get(input.bindingId)!.close()
          Object.assign(record, this.read(input.bindingId)!)
        }
        record.bridge ??= { bindingId: input.bindingId, frontend: record.frontend!, executor: record.executor! }
        this.save(record)
        await this.attach(record, hosts)
        // Endpoint pinning reads the exact original frontend receipt. A not-yet
        // ready helper is returned as unavailable, never silently recreated.
        const created = await hosts.agent.createHostAgentWithDelivery({ ...input.agent, toolExecution })
        return { session: created.session, execution: this.inspect(input.bindingId)! }
      } catch (error) { this.observeFailure(input, error); throw error }
    })
  }
  async restoreReaders(): Promise<void> {
    const ids = this.db.prepare('SELECT id FROM bindings').all().map(row => String(row.id))
    await Promise.allSettled(ids.map(id => this.rejoin(id)))
  }
  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.lanes.values()])
    await Promise.allSettled([...this.bridges.values()].map(bridge => bridge.close()))
    this.bridges.clear(); this.db.close(); await this.lease.close()
  }
}

/** Optional service lifetime. Unused Hosts create no execution store; failed
 * observation affects this capability only, never the Host's other Sessions. */
export class AgentExecutionBindingService {
  private owner: Promise<AgentExecutionCoordinator> | undefined
  private closed = false
  constructor(private readonly directory: string, private readonly options: AgentExecutionCoordinatorOptions) {}
  private async retained(): Promise<boolean> {
    try { await stat(join(this.directory, 'bindings.sqlite')); return true }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { await stat(this.directory) }
      catch (directoryError) { if ((directoryError as NodeJS.ErrnoException).code === 'ENOENT') return false; throw directoryError }
      throw fail('The retained execution directory has no confirmed binding store.', 'EXECUTION_STORAGE_UNCONFIRMED')
    }
  }
  private coordinator(): Promise<AgentExecutionCoordinator> {
    if (this.closed) return Promise.reject(fail('This execution service reader is closed.', 'EXECUTION_READER_UNAVAILABLE'))
    if (!this.owner) {
      const pending = AgentExecutionCoordinator.open(this.directory, this.options)
      this.owner = pending
      void pending.catch(() => { if (this.owner === pending) this.owner = undefined })
    }
    return this.owner
  }
  async create(input: AgentExecutionOpenInput): ReturnType<AgentExecutionCoordinator['create']> {
    return await (await this.coordinator()).create(input)
  }
  async inspect(bindingId: string): Promise<AgentExecutionInspection | null> {
    if (!this.owner && !await this.retained()) return null
    return (await this.coordinator()).inspect(bindingId)
  }
  async rejoin(bindingId: string): Promise<AgentExecutionInspection> {
    if (!this.owner && !await this.retained()) throw fail('The original execution binding is unavailable.', 'EXECUTION_HELPER_UNAVAILABLE')
    return await (await this.coordinator()).rejoin(bindingId)
  }
  async restoreReaders(): Promise<void> {
    if (!this.owner && !await this.retained()) return
    await (await this.coordinator()).restoreReaders()
  }
  async dispose(): Promise<void> {
    this.closed = true
    const owner = await this.owner?.catch(() => undefined)
    await owner?.dispose()
  }
}
