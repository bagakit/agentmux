import { parseAgentCreationCancellation, type AgentCreationCancellationInput, type AgentCreationCancellationResult } from './agent-creation-cancellation.js'
import { createHash } from 'node:crypto'
import { mkdir, chmod, open, stat, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, isAbsolute, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { AgentExecutionBridge, ExecutionProtocolFrameError, type AgentExecutionBridgeState, type AgentExecutionBridgePort, type AgentExecutionBridgeSide, type AgentExecutionBridgeConnection } from './agent-execution/bridge.js'
import { inspectSourceExecutionDiagnostics, type ExecutionSourceDiagnosticsOwner, type ExecutionJournalDiagnostics, type AgentExecutionSourceDiagnostics } from './agent-execution-source-diagnostics.js'
import type { AgentMuxClient } from './client.js';
import type { AgentMuxHostAgentCreateInput } from "./client-contract.js";
import type { AgentMuxAgentSession } from './types.js'
import { parseAdoptedHostRoute, type AdoptedHostRoute, type HostRouteExecutionAuthorization } from './host-route.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'
import type { HostRouteExecutionAccess } from './host-route-gateway.js'
import { AgentMuxError, parseAgentExecutionReference } from './errors.js'
import type { AgentExecutionReference, AgentExecutionFailure, AgentExecutionHelperStart, AgentExecutionAssociationWitness } from './agent-execution-contract.js'
import { parseAgentExecutionNotices, type AgentExecutionNotice } from './agent-execution-helper.js'

export type AgentExecutionHostPort = AgentExecutionBridgePort & Pick<AgentMuxClient,
  'prepareAgentExecutionHelper' | 'inspectPreparedTerminal' | 'createPreparedTerminal' | 'createHostAgentWithDelivery' | 'cancelAgentCreation' | 'inspectAgentCreationCancellation' | 'listHostExecutors' | 'readAgentSession'>
export interface AgentExecutionOpenInput {
  bindingId: string
  agentHostId: string
  agentRuntimeId: string
  agentRoute?: AdoptedHostRoute
  resourceRoute?: AdoptedHostRoute
  resourceHostId: string
  resourceRuntimeId: string
  resourceWorkspacePath: string
  /** Original Source request identity; frozen with its full private contribution. */
  sourceRequestDigest?: string
  resourceGrant: import('./agent-execution-helper.js').AgentExecutionResourceGrant
  agent: Omit<AgentMuxHostAgentCreateInput, 'toolExecution'> & { agentSessionId: string; createOperationId: string }
}
type OperationKey = import('./agent-execution/journal.js').AgentExecutionOperationKey
type Diagnostic = { code: string; message: string; generation?: string; operation?: OperationKey }
export type AgentExecutionDiagnostic = Diagnostic & (
  | { scope: 'unclassified'; side?: AgentExecutionBridgeSide; runId?: string }
  | { scope: 'helper' | 'request' | 'generation'; side: AgentExecutionBridgeSide; runId: string }
  | { scope: 'operation'; side: 'executor'; runId: string; generation: string; operation: OperationKey }
)
const originalOperation = (value: unknown, bindingId: string, generation: unknown): value is OperationKey => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const key = value as OperationKey
  return Object.keys(key).length === 3 && key.bindingId === bindingId && typeof key.streamGeneration === 'string' && !!key.streamGeneration &&
    key.streamGeneration === generation && (typeof key.nativeRequestId === 'string' || Number.isSafeInteger(key.nativeRequestId))
}
type RecordValue = { cancellation?: AgentCreationCancellationInput; input: AgentExecutionOpenInput; routeAuthorization?: HostRouteExecutionAuthorization;
  /** Actual target handler observation in this original journal; not caller input or Provider qualification. */
  creationContract?: { ordinaryLaunch: 1; runtimeId: string; executorRevision: string };
  agentControl?: { generation: string; state: 'unconfigured' | 'unverified' | 'available' | 'unavailable'; stage?: 'invocation-registration'; code?: string }; notices?: AgentExecutionNotice[]; diagnostic?: AgentExecutionInspection['diagnostic']; diagnostics?: AgentExecutionDiagnostic[]; attempts?: Partial<Record<'frontend' | 'executor', { ownerInstanceId: string }>>; bridge?: AgentExecutionBridgeState; frontend?: AgentExecutionBridgeState['frontend']; executor?: AgentExecutionBridgeState['executor'] }
export interface AgentExecutionInspection {
  bindingId: string
  agentHostId: string
  resourceHostId: string
  agentSessionId: string
  resourceWorkspacePath: string
  /** Frozen execution chains; an observer access path is reported separately by the route carrier. */
  agentRoute?: AdoptedHostRoute
  resourceRoute?: AdoptedHostRoute
  state: 'unavailable' | 'connected'
  continuation?: AgentExecutionReference
  /** Explicit view:'association' only; not inferred from current Host routes or service state. */
  association?: AgentExecutionAssociationWitness
  helperStarts?: Record<'executor' | 'frontend', AgentExecutionHelperStart>
  notices?: AgentExecutionNotice[]
  /** Current original helper/reader connection only; not native tool qualification. */
  diagnostic?: Diagnostic
  /** Retained local issues; unrelated progress or rejoin cannot settle an operation. */
  diagnostics?: AgentExecutionDiagnostic[]
}
const nativeLock = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
const fail = (message: string, code = 'EXECUTION_BINDING_CONFLICT') => new AgentMuxError(message, code)
const routedIntentSchema = 'agentmux.routed-execution-intent.v1'
const creationId = (binding: string, role: string) => createHash('sha256').update(JSON.stringify([binding, role])).digest('hex')
const reference = (input: AgentExecutionOpenInput): AgentExecutionReference => ({ bindingId: input.bindingId, agentSessionId: input.agent.agentSessionId, createOperationId: input.agent.createOperationId })
function executionFailure(error: unknown, input: AgentExecutionOpenInput, step: Omit<AgentExecutionFailure, 'reference'>): AgentMuxError {
  if (error instanceof AgentMuxError && error.executionFailure) return error
  const original = error instanceof AgentMuxError ? error : undefined
  const result = new AgentMuxError(error instanceof Error ? error.message : String(error), original?.code ?? 'EXECUTION_CREATION_UNCONFIRMED',
    original?.detail, original?.controlFailure, original?.logId, original?.creationFailure, original?.storageFailure, { reference: reference(input), ...step })
  Object.defineProperty(result, 'cause', { value: error, configurable: true })
  return result
}

export interface AgentExecutionCoordinatorOptions {
  resolveHost(hostId: string, adoptedRoute?: AdoptedHostRoute, access?: HostRouteExecutionAccess): Promise<{ runtimeId: string; client: AgentExecutionHostPort; adoptedRoute?: AdoptedHostRoute; dispose?(): Promise<void> }>
  authorize?(input: AgentExecutionOpenInput, context: AgentMuxRpcCallContext | undefined, retained: HostRouteExecutionAuthorization | undefined, existing: boolean): Promise<HostRouteExecutionAuthorization | undefined>
  onObservation?(value: AgentExecutionInspection): void
}
export type AgentExecutionBindingObservation = { bindingId: string; inspection: AgentExecutionInspection | null }
export type AgentExecutionBindingWatch = { initial: AgentExecutionBindingObservation; start(): void; dispose(): void | Promise<void> }
export type AgentExecutionBindingWatchContext = AgentMuxRpcCallContext & { onError?(error: unknown): void }

/** One Core's related execution bindings. Helpers and Agents remain owned by their original Hosts. */
type ResolvedHosts = { agent: AgentExecutionHostPort; resource: AgentExecutionHostPort; adopted: boolean; dispose(): Promise<void> }

export class AgentExecutionCoordinator {
  private readonly lanes = new Map<string, Promise<unknown>>()
  private readonly bridges = new Map<string, { bridge: AgentExecutionBridge; dispose(): Promise<void> }>()
  private readonly observations = new Map<string, AgentExecutionInspection>()
  private readonly projectionFailures = new Map<string, AgentExecutionDiagnostic>()
  private readonly connectionFailures = new Map<string, Diagnostic & { protocolFrame?: Pick<ExecutionProtocolFrameError, 'side' | 'frame'> }>()
  private readonly helperConnections = new Map<string, Map<AgentExecutionBridgeSide, AgentExecutionBridgeConnection>>()
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
    const stored = JSON.parse(row.input) as { schema?: unknown; input?: unknown }
    const qualified = stored?.schema === routedIntentSchema
    if (stored?.schema !== undefined && (!qualified || Object.keys(stored).length !== 2)) throw fail('The original execution intent kind is unconfirmed; it was not interpreted as a direct route.', 'EXECUTION_STORAGE_UNCONFIRMED')
    const record = { ...JSON.parse(String(row.record)), input: qualified ? stored.input : stored } as RecordValue
    if (!qualified && (record.input?.agentRoute || record.input?.resourceRoute || record.routeAuthorization)) throw fail('The original qualified execution intent has no confirmed format. Its binding and Runs were retained.', 'EXECUTION_STORAGE_UNCONFIRMED')
    if (record.input?.bindingId !== bindingId) throw fail('Execution binding storage does not identify the requested operation.', 'EXECUTION_STORAGE_UNCONFIRMED')
    return record
  }
  private save(record: RecordValue): void {
    // SQLite's acknowledged EXTRA transaction is the durability fence. No full
    // native payload is stored here; pending Input references existing Replay.
    // This synchronous read/update is inside the existing exclusive coordinator writer lease.
    const cancellation = this.read(record.input.bindingId)?.cancellation
    if (cancellation && record.cancellation && !isDeepStrictEqual(cancellation, record.cancellation)) throw fail('The original binding has another cancellation control.', 'AGENT_CREATION_CANCELLATION_CONFLICT')
    if (cancellation) record.cancellation = cancellation
    const { input, ...state } = record
    const encoded = JSON.stringify(state)
    const changed = this.db.prepare('UPDATE bindings SET record=? WHERE id=?').run(encoded, input.bindingId)
    if (changed.changes) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // New qualified intent is a distinct semantic kind in this same journal.
      // An older reader must reject this row, not ignore its frozen route/actor
      // fields and silently dispatch through a direct Host. Ordinary intents and
      // all existing rows are neither rewritten nor migrated.
      const qualified = input.agentRoute || input.resourceRoute || record.routeAuthorization
      this.db.prepare('INSERT INTO binding_intents VALUES (?,?)').run(input.bindingId, JSON.stringify(qualified ? { schema: routedIntentSchema, input } : input))
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
  private qualificationNotices(record: RecordValue): AgentExecutionNotice[] | undefined {
    return record.notices?.flatMap(notice => {
      if (notice.capability !== 'agent-control' || !record.agentControl || record.agentControl.state === 'unconfigured') return [notice]
      if (record.agentControl.state === 'available') return []
      return [{ ...notice, state: 'unverified' as const, ...(record.agentControl.code ? { code: record.agentControl.code } : {}),
        message: record.agentControl.stage === 'invocation-registration'
          ? 'Original Agent control invocation registration is unconfirmed. Native execution remains available.'
          : record.agentControl.state === 'unverified'
          ? 'The original Agent control route is configured; its current native generation has not received a confirmed Core response.'
          : 'The original Agent control owner or transport is unconfirmed. Native execution remains available.',
        action: 'Recheck the original Agent control route without replacing the Agent, helper Runs or pending operations.' }]
    })
  }
  private localDiagnostics(record: RecordValue): AgentExecutionDiagnostic[] {
    // Old records did not declare a scope. Preserve exactly what was recorded;
    // neither reader attachment nor a guessed error-code category can settle it.
    return [...(record.diagnostic ? [{ ...record.diagnostic, scope: 'unclassified' as const }] : []), ...(record.diagnostics ?? [])]
  }
  private connectionDiagnostic(bindingId: string): Diagnostic | undefined {
    const failed = this.connectionFailures.get(bindingId)
    if (failed) { const { protocolFrame: _privateFrame, ...diagnostic } = failed; return diagnostic }
    const connections = this.helperConnections.get(bindingId)
    for (const side of ['frontend', 'executor'] as const) {
      const value = connections?.get(side)
      if (!value || value.process === 'unobserved') return { code: 'EXECUTION_OBSERVATION_UNCONFIRMED', message: `The original ${side} helper has not been observed by this reader.` }
      if (value.process !== 'running') return { code: 'EXECUTION_HELPER_UNAVAILABLE', message: `The original ${side} helper Run ${value.runId} is ${value.process}. The Agent and original operations remain retained.` }
      if (value.reader !== 'attached') return value.readerDiagnostic ?? { code: 'EXECUTION_OBSERVATION_UNCONFIRMED', message: `The original ${side} helper reader is unconfirmed. Rejoin its original connection.` }
      const service = value.nativeService
      if (service && (service.owner.type !== 'serving' || !['serving', 'backpressured'].includes(service.output.type) || service.input.phase.type !== 'open'))
        return { code: 'EXECUTION_HELPER_SERVICE_UNAVAILABLE', message: `The original ${side} helper Run ${value.runId} has unconfirmed native input/output service. Its process and operations remain retained.` }
    }
    return undefined
  }
  private operationFacts(record: RecordValue): Pick<AgentExecutionInspection, 'continuation' | 'helperStarts'> {
    const start = (role: 'executor' | 'frontend'): AgentExecutionHelperStart => record[role]
      ? { outcome: 'confirmed', runId: record[role]!.runId }
      : { outcome: record.attempts?.[role] ? 'unknown' : 'not-submitted', runId: null }
    return { continuation: reference(record.input), helperStarts: { executor: start('executor'), frontend: start('frontend') } }
  }
  private observe(input: AgentExecutionOpenInput, failure?: Diagnostic & { protocolFrame?: Pick<ExecutionProtocolFrameError, 'side' | 'frame'> }, notices?: AgentExecutionNotice[]): void {
    if (failure) this.connectionFailures.set(input.bindingId, failure)
    const retained = this.read(input.bindingId)
    if (retained) notices = this.qualificationNotices(retained)
    const diagnostic = this.connectionDiagnostic(input.bindingId)
    const diagnostics = retained ? this.localDiagnostics(retained) : []
    const projectionFailure = this.projectionFailures.get(input.bindingId)
    if (projectionFailure) diagnostics.push(projectionFailure)
    const value: AgentExecutionInspection = { bindingId: input.bindingId, agentHostId: input.agentHostId, resourceHostId: input.resourceHostId,
      agentSessionId: input.agent.agentSessionId, resourceWorkspacePath: input.resourceWorkspacePath,
      ...(input.agentRoute ? { agentRoute: input.agentRoute } : {}), ...(input.resourceRoute ? { resourceRoute: input.resourceRoute } : {}),
      ...(retained ? this.operationFacts(retained) : {}), state: diagnostic ? 'unavailable' : 'connected', ...(notices === undefined ? {} : { notices }), ...(diagnostic ? { diagnostic } : {}),
      ...(diagnostics.length ? { diagnostics } : {}) }
    this.observations.set(input.bindingId, value)
    try { this.options.onObservation?.(structuredClone(value)) } catch { /* A reader cannot change this operation or healthy helpers. */ }
  }
  inspect(bindingId: string, view?: 'association'): AgentExecutionInspection | null {
    const record = this.read(bindingId)
    if (!record) return null
    const association: AgentExecutionAssociationWitness | undefined = view === 'association' ? ((): AgentExecutionAssociationWitness => {
      const input = record.input, original = reference(input)
      if (typeof input.agentRuntimeId !== 'string' || !input.agentRuntimeId || typeof input.resourceRuntimeId !== 'string' || !input.resourceRuntimeId ||
          typeof input.resourceWorkspacePath !== 'string' || !isAbsolute(input.resourceWorkspacePath)) return { state: 'unconfirmed', reference: original,
        issue: { code: 'EXECUTION_RUNTIME_WITNESS_UNCONFIRMED', message: 'The original journal has no complete frozen Runtime/resource tuple. Current routes were not substituted.' } }
      return { state: 'confirmed', reference: original, agentRuntimeId: input.agentRuntimeId, resourceRuntimeId: input.resourceRuntimeId, resourceWorkspacePath: input.resourceWorkspacePath,
        agent: { executorId: input.agent.executorId, executorRevision: input.agent.executorRevision, workspacePath: input.agent.workspacePath },
        ...(input.sourceRequestDigest === undefined ? {} : { sourceRequestDigest: input.sourceRequestDigest }) }
    })() : undefined
    return structuredClone({ ...(this.observations.get(bindingId) ?? { bindingId, agentHostId: record.input.agentHostId,
      resourceHostId: record.input.resourceHostId, agentSessionId: record.input.agent.agentSessionId,
      resourceWorkspacePath: record.input.resourceWorkspacePath, state: 'unavailable',
      ...(record.input.agentRoute ? { agentRoute: record.input.agentRoute } : {}), ...(record.input.resourceRoute ? { resourceRoute: record.input.resourceRoute } : {}),
      ...(record.notices === undefined ? {} : { notices: this.qualificationNotices(record)! }),
      ...(this.localDiagnostics(record).length ? { diagnostics: this.localDiagnostics(record) } : {}),
      diagnostic: { code: 'EXECUTION_OBSERVATION_UNCONFIRMED', message: 'The original helpers have not been observed by this Core connection.' } }), ...this.operationFacts(record), ...(association ? { association } : {}) })
  }
  /** Safe metadata only; caller scope is established by the Source owner. */
  diagnostics(original: AgentExecutionReference): ExecutionJournalDiagnostics | null {
    const record = this.read(original.bindingId)
    if (!record || !isDeepStrictEqual(reference(record.input), original)) return null
    const helpers = Object.fromEntries((['frontend', 'executor'] as const).map(role => [role, {
      start: this.operationFacts(record).helperStarts![role], cursor: record.bridge?.[role].outputByte ?? null,
      ownerInstanceId: record.bridge?.[role].ownerInstanceId ?? null
    }])) as ExecutionJournalDiagnostics['helpers']
    const failure = this.connectionFailures.get(original.bindingId)?.protocolFrame
    return structuredClone({ reference: original, helpers, ...(failure ? { failure: { code: 'EXECUTION_PROTOCOL_INVALID_FRAME' as const,
      hostId: failure.side === 'executor' ? record.input.resourceHostId : record.input.agentHostId, role: failure.side, stage: 'attach' as const, frame: failure.frame } } : {}) })
  }
  /** Resume only retained bridge readers. This never creates or restores an Agent Run. */
  async rejoin(bindingId: string, context?: AgentMuxRpcCallContext): Promise<AgentExecutionInspection> {
    return await this.serialize(bindingId, async () => {
      const record = this.read(bindingId)
      if (!record?.bridge) throw fail('The original execution bridge has no confirmed helper pair.', 'EXECUTION_HELPER_UNAVAILABLE')
      try {
        await this.options.authorize?.(record.input, context, record.routeAuthorization, true)
        const hosts = await this.hosts(record)
        try { await this.attach(record, hosts); return this.inspect(bindingId)! } finally { if (!hosts.adopted) await hosts.dispose() }
      } catch (error) { this.observeFailure(record.input, error); throw error }
    })
  }
  private observeFailure(input: AgentExecutionOpenInput, error: unknown): void {
    const frame = error instanceof ExecutionProtocolFrameError ? error : error instanceof Error && error.cause instanceof ExecutionProtocolFrameError ? error.cause : undefined
    this.observe(input, { code: error instanceof AgentMuxError ? error.code : 'EXECUTION_OBSERVATION_UNCONFIRMED',
      message: error instanceof Error ? error.message : String(error),
      ...(frame ? { protocolFrame: { side: frame.side, frame: frame.frame } } : {}) }, this.read(input.bindingId)?.notices)
  }
  private async hosts(record: RecordValue): Promise<ResolvedHosts> {
    const input = record.input
    const resolve = async (hostId: string, role: 'agent' | 'executor', route?: AdoptedHostRoute) => {
      try {
        const helperRole = role === 'agent' ? 'frontend' : 'executor'
        const host = await this.options.resolveHost(hostId, route, record.routeAuthorization ? { authorization: record.routeAuthorization, helper: () => {
          const original = record[helperRole]
          return original ? { role: helperRole, runId: original.runId, ownerInstanceId: original.ownerInstanceId } : undefined
        } } : undefined)
        if (!isDeepStrictEqual(host.adoptedRoute, route)) { await host.dispose?.(); throw fail('The original resolver did not confirm this exact adopted chain. No execution was dispatched to a replacement route.', 'EXECUTION_ROUTE_UNCONFIRMED') }
        return host
      }
      catch (error) { throw executionFailure(error, input, { hostId, role, stage: 'resolve' }) }
    }
    const results = await Promise.allSettled([resolve(input.agentHostId, 'agent', input.agentRoute), resolve(input.resourceHostId, 'executor', input.resourceRoute)])
    const opened = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    let closed = false
    const dispose = async () => { if (closed) return; closed = true; await Promise.allSettled(opened.map(host => host.dispose?.())) }
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') { await dispose(); throw failed.reason }
    const [agent, resource] = opened
    try {
      for (const [host, expected, hostId, role] of [[agent!, input.agentRuntimeId, input.agentHostId, 'agent'], [resource!, input.resourceRuntimeId, input.resourceHostId, 'executor']] as const)
        if (host.runtimeId !== expected) throw executionFailure(fail('The original Agent or resource Core identity changed; no work was rerouted.', 'EXECUTION_HOST_CHANGED'), input, { hostId, role, stage: 'resolve' })
      return { agent: agent!.client, resource: resource!.client, adopted: false, dispose }
    } catch (error) { await dispose(); throw error }
  }
  private async closeBridge(id: string): Promise<void> {
    const owned = this.bridges.get(id)
    if (!owned) return
    this.bridges.delete(id)
    try { await owned.bridge.close() } finally { await owned.dispose() }
  }
  private async attach(record: RecordValue, hosts: ResolvedHosts): Promise<void> {
    const id = record.input.bindingId
    await this.closeBridge(id)
    const latest = this.read(id)
    if (!latest || !isDeepStrictEqual(latest.input, record.input)) throw fail('The original execution binding changed while its reader was closing.')
    Object.assign(record, latest)
    this.helperConnections.set(id, new Map())
    const bridge = new AgentExecutionBridge({ state: record.bridge!, ports: { frontend: hosts.agent, executor: hosts.resource },
      persist: async state => { record.bridge = state; this.save(record) },
      onFrame: async (side, frame) => {
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return
        const value = frame as { type?: string; scope?: unknown; code?: string; stage?: unknown; state?: unknown; generation?: unknown; operation?: OperationKey }
        if (side === 'frontend' && value.type === 'agent-control-state' && typeof value.generation === 'string' && value.generation &&
            ['unconfigured', 'unverified', 'available', 'unavailable'].includes(String(value.state)) && (Object.keys(value).length === 3 || Object.keys(value).length === 5 && value.stage === 'invocation-registration' && typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value.code))) {
          if (value.state === 'unconfigured' || value.state === 'unverified' || record.agentControl?.generation === value.generation) {
            record.agentControl = { generation: value.generation, state: value.state as NonNullable<RecordValue['agentControl']>['state'], ...(value.stage === 'invocation-registration' && value.code ? { stage: value.stage, code: value.code } : {}) }
            this.save(record); this.observe(record.input, undefined, record.notices)
          }
        }
        if (value.type === 'diagnostic') {
          const operation = originalOperation(value.operation, record.input.bindingId, value.generation) ? structuredClone(value.operation) : undefined
          const base: Diagnostic = { code: typeof value.code === 'string' ? value.code : 'EXECUTION_OBSERVATION_UNCONFIRMED',
            message: 'The original native tool service reported a local diagnostic. Its scope and retained operation are separate from the helper connection.',
            ...(typeof value.generation === 'string' && value.generation ? { generation: value.generation } : {}), ...(operation ? { operation } : {}) }
          const subject = { side, runId: record.bridge![side].runId }
          const diagnostic: AgentExecutionDiagnostic = value.scope === 'operation' && side === 'executor' && operation
            ? { ...base, ...subject, side: 'executor', scope: 'operation', generation: operation.streamGeneration, operation }
            : value.scope === 'helper' || value.scope === 'request' || value.scope === 'generation'
              ? { ...base, ...subject, scope: value.scope } : { ...base, ...subject, scope: 'unclassified' }
          const retained = record.diagnostics ?? []
          if (retained.some(value => isDeepStrictEqual(value, diagnostic))) return
          const diagnostics = [...retained, diagnostic]
          this.save({ ...record, diagnostics }); record.diagnostics = diagnostics
          this.observe(record.input)
        }
        if (side === 'executor' && value.type === 'operation-completed' && originalOperation(value.operation, record.input.bindingId, value.generation)) {
          // The resource helper emits this fact only after its original journal
          // commits. An arbitrary response, success frame or rejoin is insufficient.
          const retained = record.diagnostics ?? []
          const unresolved = retained.filter(diagnostic => !(diagnostic.scope === 'operation' &&
            diagnostic.runId === record.bridge!.executor.runId && isDeepStrictEqual(diagnostic.operation, value.operation)))
          // The bridge already commits its cursor. An ordinary completed tool
          // with no matching issue needs no second write or UI observation.
          if (unresolved.length === retained.length) return
          this.save({ ...record, diagnostics: unresolved }); record.diagnostics = unresolved
          this.observe(record.input)
        }
      },
      onObservationError: side => {
        this.projectionFailures.set(id, { scope: 'helper', side, runId: record.bridge![side].runId,
          code: 'EXECUTION_DIAGNOSTIC_PROJECTION_UNCONFIRMED',
          message: 'The original helper diagnostic could not be recorded. Inspect the original tool operation for its result.' })
        this.observe(record.input)
      },
      onConnection: (side, connection) => {
        const before = this.connectionDiagnostic(id)
        this.helperConnections.get(id)!.set(side, connection)
        // Native byte counters advance independently of the public connection
        // fact. Retain their revision without rereading the durable creation intent.
        if (!isDeepStrictEqual(before, this.connectionDiagnostic(id))) this.observe(record.input)
      },
      onError: error => this.observeFailure(record.input, error) })
    this.bridges.set(id, { bridge, dispose: hosts.dispose }); hosts.adopted = true
    try { await bridge.start() }
    catch (error) {
      await this.closeBridge(id).catch(() => {})
      const side = bridge.failureSide
      if (side) throw executionFailure(error, record.input, { hostId: side === 'frontend' ? record.input.agentHostId : record.input.resourceHostId, role: side, stage: 'attach' })
      throw error
    }
    this.connectionFailures.delete(id)
    this.observe(record.input, undefined, record.notices)
  }
  private creationInput(value: AgentExecutionOpenInput): AgentExecutionOpenInput {
    const input = structuredClone(value)
    for (const [route, runtimeId] of [[input.agentRoute, input.agentRuntimeId], [input.resourceRoute, input.resourceRuntimeId]] as const)
      if (route && parseAdoptedHostRoute(route).hops.at(-1)!.target.runtimeId !== runtimeId) throw fail('The adopted route ends at another original execution Runtime.', 'EXECUTION_HOST_CHANGED')
    if (['bindingId', 'agentHostId', 'agentRuntimeId', 'resourceHostId', 'resourceRuntimeId', 'resourceWorkspacePath'].some(key => typeof input[key as keyof AgentExecutionOpenInput] !== 'string' || !input[key as keyof AgentExecutionOpenInput]) || !input.agent?.agentSessionId || !input.agent.createOperationId || 'toolExecution' in input.agent || input.resourceGrant?.scope !== 'host-user' || input.resourceGrant.bindingId !== input.bindingId)
      throw fail('Execution creation requires its exact original binding, Session and create operation.')
    if (input.sourceRequestDigest !== undefined && (typeof input.sourceRequestDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.sourceRequestDigest))) throw fail('The original Source request digest must be its exact SHA-256 identity.')
    return input
  }
  /** Called only inside this binding's lane. The durable write is independent
   * of later network preparation and advancement; its ACK is never rolled back. */
  private async freeze(input: AgentExecutionOpenInput, context?: AgentMuxRpcCallContext): Promise<RecordValue> {
    let record = this.read(input.bindingId)
    if (record && !isDeepStrictEqual(record.input, input)) throw fail('This execution binding already names another original creation.')
    const routeAuthorization = await this.options.authorize?.(input, context, record?.routeAuthorization, !!record)
    if (!record) { record = { input, ...(routeAuthorization ? { routeAuthorization } : {}) }; this.save(record) }
    return record
  }
  /** Acknowledge the complete frozen intent only. No endpoint preparation,
   * helper Start, Agent creation or first input belongs to this operation. */
  async admit(value: AgentExecutionOpenInput, context?: AgentMuxRpcCallContext): Promise<AgentExecutionReference> {
    const input = this.creationInput(value)
    return await this.serialize(input.bindingId, async () => reference((await this.freeze(input, context)).input))
  }
  /** Convenience intake and advancement share one lane, without nesting a
   * serialized public call or holding a DB transaction over remote work. */
  async create(value: AgentExecutionOpenInput, context?: AgentMuxRpcCallContext): Promise<{ session: AgentMuxAgentSession; execution: AgentExecutionInspection }> {
    const input = this.creationInput(value)
    return await this.serialize(input.bindingId, async () => this.advance(await this.freeze(input, context)))
  }
  async cancelOriginal(value: AgentExecutionReference, request: AgentCreationCancellationInput, context?: AgentMuxRpcCallContext, inspectOnly = false): Promise<AgentCreationCancellationResult> {
    const original = parseAgentExecutionReference(value), input = parseAgentCreationCancellation(request), record = this.read(original.bindingId)
    if (!record || !isDeepStrictEqual(reference(record.input), original) || input.agentSessionId !== original.agentSessionId || input.createOperationId !== original.createOperationId) throw fail('The cancellation names another original execution intent.', 'EXECUTION_INTENT_UNCONFIRMED')
    await this.options.authorize?.(record.input, context, record.routeAuthorization, true)
    if (!inspectOnly) {
      if (record.cancellation && !isDeepStrictEqual(record.cancellation, input)) throw fail('The original binding has another cancellation.', 'AGENT_CREATION_CANCELLATION_CONFLICT')
      record.cancellation = input; this.save(record)
    }
    const host = await this.options.resolveHost(record.input.agentHostId, record.input.agentRoute, record.routeAuthorization ? { authorization: record.routeAuthorization } : undefined)
    try {
      if (host.runtimeId !== record.input.agentRuntimeId) throw fail('The cancellation route answers for another original Runtime.', 'RUNTIME_OWNER_MISMATCH')
      return inspectOnly ? await host.client.inspectAgentCreationCancellation(input) : await host.client.cancelAgentCreation(input)
    } finally { await host.dispose?.() }
  }
  private assertNotCancelled(bindingId: string) {
    if (this.read(bindingId)?.cancellation) throw fail('This original execution intent was cancelled. Its existing helpers and Agent remain retained.', 'AGENT_CREATION_CANCELLED')
  }
  async continueOriginal(value: AgentExecutionReference, context?: AgentMuxRpcCallContext): Promise<{ session: AgentMuxAgentSession; execution: AgentExecutionInspection }> {
    const original = parseAgentExecutionReference(value)
    return await this.serialize(original.bindingId, async () => {
      const record = this.read(original.bindingId)
      if (!record) throw fail('The original frozen execution intent is unavailable. Keep its original request; no input was reconstructed.', 'EXECUTION_INTENT_UNCONFIRMED')
      if (!isDeepStrictEqual(reference(record.input), original)) throw fail('Continuation names another original Session or creation operation.')
      await this.options.authorize?.(record.input, context, record.routeAuthorization, true)
      return await this.advance(record)
    })
  }
  private async advance(record: RecordValue): Promise<{ session: AgentMuxAgentSession; execution: AgentExecutionInspection }> {
    const input = record.input
    this.assertNotCancelled(input.bindingId)
    let step: Omit<AgentExecutionFailure, 'reference'> = { hostId: input.agentHostId, role: 'agent', stage: 'resolve' }
    try {
      const hosts = await this.hosts(record)
      try {
      const toolExecution = { bindingId: input.bindingId, resourceHostId: input.resourceHostId,
        resourceRuntimeId: input.resourceRuntimeId, workspacePath: input.resourceWorkspacePath }
      const existing = await hosts.agent.readAgentSession(input.agent.agentSessionId)
      if (existing) {
        // The target Core validates the complete original creation digest and
        // retained receipt before consulting a possibly changed Executor.
        step = { hostId: input.agentHostId, role: 'agent', stage: 'create' }
        this.assertNotCancelled(input.bindingId)
        const created = await hosts.agent.createHostAgentWithDelivery({ ...input.agent, toolExecution })
        if (record.bridge && !this.bridges.has(input.bindingId)) {
          try { await this.attach(record, hosts) } catch (error) { this.observeFailure(input, error) }
        }
        return { session: created.session, execution: this.inspect(input.bindingId)! }
      }
      step = { hostId: input.agentHostId, role: 'agent', stage: 'inventory' }
      const inventory = await hosts.agent.listHostExecutors({ executorId: input.agent.executorId })
      const selected = inventory.executors.find(executor => executor.executorId === input.agent.executorId)
      if (!selected || selected.configRevision !== input.agent.executorRevision) throw fail('The selected Agent Host Executor configuration changed.', 'EXECUTOR_REVISION_CONFLICT')
      if (input.agent.sourceAgentMuxNote !== undefined) {
        // Provider preparation does not attest this Core's creation wire handler.
        // Once observed for this frozen intent, metadata disappearance is not revocation.
        const receipt = record.creationContract
        if (receipt && (receipt.ordinaryLaunch !== 1 || receipt.runtimeId !== input.agentRuntimeId || receipt.executorRevision !== input.agent.executorRevision)) throw fail(
          'The original target creation contract receipt is unconfirmed. Its intent and helpers were retained.', 'EXECUTION_STORAGE_UNCONFIRMED')
        if (!receipt) {
          if (inventory.runtimeId !== input.agentRuntimeId || selected.creationContract?.ordinaryLaunch !== 1) throw fail(
            'The selected Agent Core has not confirmed this complete Source launch input. Keep the original binding and confirm or update that Core; no new helper was started.', 'EXECUTION_CREATION_CONTRACT_UNCONFIRMED')
          record.creationContract = { ordinaryLaunch: 1, runtimeId: inventory.runtimeId, executorRevision: selected.configRevision }
          this.save(record)
        }
      }
      const preparations = {} as Record<'executor' | 'frontend', import('./agent-execution-helper.js').AgentExecutionHelperPreparation>
      // Both endpoint owners acknowledge required preparation before either Start.
      for (const role of ['executor', 'frontend'] as const) {
        step = { hostId: role === 'executor' ? input.resourceHostId : input.agentHostId, role, stage: 'prepare' }
        const client = role === 'executor' ? hosts.resource : hosts.agent
        this.assertNotCancelled(input.bindingId)
        const original = await client.prepareAgentExecutionHelper({ bindingId: input.bindingId, agentSessionId: input.agent.agentSessionId,
          providerId: selected.providerId, role, workspacePath: role === 'executor' ? input.resourceWorkspacePath : input.agent.workspacePath,
          createOperationId: creationId(input.bindingId, role), ...(role === 'executor' ? { grant: input.resourceGrant } : { toolExecution }) })
        if (original.notices !== undefined) {
          const notices = parseAgentExecutionNotices(original.notices, { providerId: selected.providerId, role })
          record.notices = [...(record.notices ?? []).filter(notice => notice.role !== role), ...notices]
          this.save(record)
        }
        preparations[role] = original
      }
      for (const role of ['executor', 'frontend'] as const) {
        step = { hostId: role === 'executor' ? input.resourceHostId : input.agentHostId, role, stage: 'start' }
        const client = role === 'executor' ? hosts.resource : hosts.agent, original = preparations[role]
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
            this.assertNotCancelled(input.bindingId)
            run = await client.createPreparedTerminal(original.prepared)
          }
          if (run.state !== 'running' || client.runtimeIdentity().instanceId !== ownerInstanceId)
            throw fail('The original helper is not confirmed serving on its original Runtime.', 'EXECUTION_HELPER_UNAVAILABLE')
          record[role] = { runId: run.runId, ownerInstanceId, inputByte: 0, outputByte: 0 }
          this.save(record)
        }
      }
      if (this.bridges.has(input.bindingId)) {
        await this.closeBridge(input.bindingId)
        Object.assign(record, this.read(input.bindingId)!)
      }
      record.bridge ??= { bindingId: input.bindingId, frontend: record.frontend!, executor: record.executor! }
      this.save(record)
      step = { hostId: input.agentHostId, role: 'frontend', stage: 'attach' }
      await this.attach(record, hosts)
      // Endpoint pinning reads the exact original frontend receipt. A not-yet
      // ready helper is returned as unavailable, never silently recreated.
      step = { hostId: input.agentHostId, role: 'agent', stage: 'create' }
      this.assertNotCancelled(input.bindingId)
      const created = await hosts.agent.createHostAgentWithDelivery({ ...input.agent, toolExecution })
      return { session: created.session, execution: this.inspect(input.bindingId)! }
      } finally { if (!hosts.adopted) await hosts.dispose() }
    } catch (error) {
      this.observeFailure(input, error)
      // Bridge endpoint failures already carry their exact step. A local
      // persistence/observation failure cannot be assigned to an invented Host.
      if (step.stage === 'attach') throw error
      throw executionFailure(error, input, step)
    }
  }

  async restoreReaders(): Promise<void> {
    const ids = this.db.prepare('SELECT id FROM bindings').all().map(row => String(row.id))
    await Promise.allSettled(ids.map(id => this.rejoin(id)))
  }
  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.lanes.values()])
    await Promise.allSettled([...this.bridges.keys()].map(id => this.closeBridge(id)))
    this.bridges.clear(); this.db.close(); await this.lease.close()
  }
}

/** Optional service lifetime. Unused Hosts create no execution store; failed
 * observation affects this capability only, never the Host's other Sessions. */
export class AgentExecutionBindingService {
  private readonly observers = new Map<string, Set<(value: AgentExecutionInspection) => void>>()
  private readonly readers = new Set<(error?: unknown) => void>()
  private owner: Promise<AgentExecutionCoordinator> | undefined
  private closed = false
  constructor(private readonly directory: string, private readonly options: AgentExecutionCoordinatorOptions, private readonly source?: ExecutionSourceDiagnosticsOwner) {}
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
      const pending = AgentExecutionCoordinator.open(this.directory, { ...this.options, onObservation: value => {
        try { this.options.onObservation?.(structuredClone(value)) } catch { /* Observation never changes a binding. */ }
        for (const observe of this.observers.get(value.bindingId) ?? []) observe(structuredClone(value))
      } })
      this.owner = pending
      void pending.catch(() => { if (this.owner === pending) this.owner = undefined })
    }
    return this.owner
  }
  async sourceDiagnostics(operationId: string, context: AgentMuxRpcCallContext = {}): Promise<AgentExecutionSourceDiagnostics | null> {
    if (!this.source) throw fail('The original Source diagnostic owner is unavailable.', 'CONTROL_UNAVAILABLE')
    return await inspectSourceExecutionDiagnostics({ source: this.source, operationId, context,
      inspect: bindingId => this.inspect(bindingId, 'association'),
      journal: async original => !this.owner && !await this.retained() ? null : (await this.coordinator()).diagnostics(original) })
  }
  async admit(input: AgentExecutionOpenInput, context?: AgentMuxRpcCallContext): ReturnType<AgentExecutionCoordinator['admit']> {
    return await (await this.coordinator()).admit(input, context)
  }
  async create(input: AgentExecutionOpenInput, context?: AgentMuxRpcCallContext): ReturnType<AgentExecutionCoordinator['create']> {
    return await (await this.coordinator()).create(input, context)
  }
  async cancelOriginal(input: AgentExecutionReference, cancellation: AgentCreationCancellationInput, context?: AgentMuxRpcCallContext, inspectOnly = false): Promise<AgentCreationCancellationResult> {
    if (!this.owner && !await this.retained()) throw fail('The original execution intent is unavailable.', 'EXECUTION_INTENT_UNCONFIRMED')
    return await (await this.coordinator()).cancelOriginal(input, cancellation, context, inspectOnly)
  }
  async continueOriginal(input: AgentExecutionReference, context?: AgentMuxRpcCallContext): ReturnType<AgentExecutionCoordinator['continueOriginal']> {
    if (!this.owner && !await this.retained()) throw fail('The original frozen execution intent is unavailable.', 'EXECUTION_INTENT_UNCONFIRMED')
    return await (await this.coordinator()).continueOriginal(input, context)
  }
  async inspect(bindingId: string, view?: 'association'): Promise<AgentExecutionInspection | null> {
    if (!this.owner && !await this.retained()) return null
    return (await this.coordinator()).inspect(bindingId, view)
  }
  /** One related live snapshot reader, with at most one in-flight and one latest
   * value. Reading or cancelling never advances or closes the Coordinator. */
  async watch(bindingId: string, onSnapshot: (value: AgentExecutionInspection | null) => void | Promise<void>, context: AgentExecutionBindingWatchContext = {}): Promise<AgentExecutionBindingWatch> {
    if (this.closed) throw fail('The original execution reader is closed.', 'EXECUTION_READER_UNAVAILABLE')
    context.signal?.throwIfAborted()
    let active = true, started = false, emitting = false, pending: AgentExecutionInspection | undefined
    const dispose = (error?: unknown) => {
      if (!active) return
      active = false; pending = undefined
      context.signal?.removeEventListener('abort', aborted)
      this.readers.delete(dispose)
      const group = this.observers.get(bindingId); group?.delete(observe)
      if (!group?.size) this.observers.delete(bindingId)
      if (error) try { context.onError?.(error) } catch { /* One reader cannot close another. */ }
    }
    const aborted = () => dispose()
    const drain = () => {
      if (!active || !started || emitting || pending === undefined) return
      const value = pending; pending = undefined; emitting = true
      void Promise.resolve().then(() => { if (active) return onSnapshot(value) }).catch(dispose).finally(() => { emitting = false; drain() })
    }
    const observe = (value: AgentExecutionInspection) => { pending = value; drain() }
    const group = this.observers.get(bindingId) ?? new Set()
    group.add(observe); this.observers.set(bindingId, group); this.readers.add(dispose)
    context.signal?.addEventListener('abort', aborted, { once: true })
    try {
      const value = await this.inspect(bindingId)
      context.signal?.throwIfAborted()
      if (!active) throw fail('The original execution reader closed during inspection.', 'EXECUTION_READER_UNAVAILABLE')
      const initial = { bindingId, inspection: pending ?? value }; pending = undefined
      return { initial, start: () => { started = true; drain() }, dispose }
    } catch (error) { dispose(); throw error }
  }
  async rejoin(bindingId: string, context?: AgentMuxRpcCallContext): Promise<AgentExecutionInspection> {
    if (!this.owner && !await this.retained()) throw fail('The original execution binding is unavailable.', 'EXECUTION_HELPER_UNAVAILABLE')
    return await (await this.coordinator()).rejoin(bindingId, context)
  }
  async restoreReaders(): Promise<void> {
    if (!this.owner && !await this.retained()) return
    await (await this.coordinator()).restoreReaders()
  }
  async dispose(): Promise<void> {
    this.closed = true
    for (const close of [...this.readers]) close(fail('The original Core execution reader is closing. Its bindings and Runs are retained.', 'EXECUTION_READER_UNAVAILABLE'))
    const owner = await this.owner?.catch(() => undefined)
    await owner?.dispose()
  }
}
