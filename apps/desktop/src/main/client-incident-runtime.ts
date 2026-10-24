import { mintObjectId } from '@agentmux/core/object-id'
import { CLIENT_INCIDENT_MAX_STAGES, safeClientIncidentCode, type AgentMuxClientEvent, type AgentMuxClientIncidentMetadata,
  type AgentMuxClientIncidentProducer, type AgentMuxClientIncidentReport, type AgentMuxClientReadingIncidentKind } from '@agentmux/core'
import type { AppConfig, ExecutorDetection } from '../shared/contracts.js'
import type { ClientIncidentArchive } from '@agentmux/host/client-incident-archive'
import type { RuntimeController } from './runtime-controller.js'

type Runtime = Pick<RuntimeController, 'detect' | 'executionHost' | 'observeCoreEvents'>
type Connection = Extract<AgentMuxClientEvent, { type: 'connection-state' }>
type Stages = AgentMuxClientIncidentReport['stages']
type ProbeScope = { executor: object; host: object; owner: object; sequence: number; settled: number; failure: string | null }
type Attempt = { id: string; started: number; sequence: number; scope: ProbeScope | null; related: string | null; stages: Stages }
type ConnectionScope = { attemptId: string; started: number; occurrenceId: string; state: Connection['state']; diagnostic: boolean; code: string | null; stages: Stages }

function ownErrorData(value: unknown, key: 'cause' | 'code'): unknown {
  try {
    if (!value || typeof value !== 'object') return null
    const property = Object.getOwnPropertyDescriptor(value, key)
    return property && Object.hasOwn(property, 'value') ? property.value : null
  } catch { return null }
}

const incidentCode = (error: unknown): string | null => safeClientIncidentCode(ownErrorData(error, 'code'))

/** Observes existing operations only. Diagnostic admission never changes their result or starts another operation. */
export class ClientIncidentRuntimeOwner {
  private readonly probes = new WeakMap<AppConfig, Map<string, Map<string, ProbeScope>>>()
  private readonly connections = new WeakMap<object, Map<Connection['observationOrigin']['boundary'], ConnectionScope>>()
  private readonly release: () => void
  constructor(private readonly runtime: Runtime, private readonly archive: ClientIncidentArchive,
    private readonly producer: AgentMuxClientIncidentProducer) {
    let release = () => {}
    try {
      release = runtime.observeCoreEvents(['connection-state'], (hostId, event) => {
        if (event.type === 'connection-state') this.observeConnection(hostId, event)
      })
    } catch (error) { this.observationUnavailable(error, false) }
    this.release = release
  }

  dispose(): void {
    try { this.release() }
    catch (error) { this.observationUnavailable(error, true) }
  }

  private observationUnavailable(error: unknown, disposed: boolean): void {
    try {
      // This is the local diagnostic subscription, not a failure of any execution Host or Run.
      const metadata = { disposed }
      const code = incidentCode(error)
      this.record(this.archive.hostId, 'connection-failed', 'observation-unavailable', mintObjectId(), null,
        code, metadata, [{ stage: 'observation-unavailable', elapsedMs: 0, metadata }], 0)
    } catch { /* Even unavailable diagnostic admission cannot block the original IPC owner. */ }
  }

  async detect(executorId: string, hostId: string, config: AppConfig): Promise<ExecutorDetection> {
    const attempt = this.beginProbe(executorId, hostId, config)
    try {
      const result = await this.runtime.detect(executorId, hostId, config)
      this.finishProbe(executorId, hostId, attempt, result)
      return result
    } catch (error) {
      this.finishProbe(executorId, hostId, attempt, null, error)
      throw error
    }
  }

  private scope(executorId: string, hostId: string, config: AppConfig): ProbeScope | null {
    const executor = Object.hasOwn(config.executors, executorId) ? config.executors[executorId] : undefined
    const host = config.hosts.find(item => item.id === hostId)
    if (!executor || !host) return null
    const owner = this.runtime.executionHost(hostId)
    let executors = this.probes.get(config)
    if (!executors) { executors = new Map(); this.probes.set(config, executors) }
    let hosts = executors.get(executorId)
    if (!hosts) { hosts = new Map(); executors.set(executorId, hosts) }
    let scope = hosts.get(hostId)
    if (!scope || scope.executor !== executor || scope.host !== host || scope.owner !== owner) {
      scope = { executor, host, owner, sequence: 0, settled: 0, failure: null }
      hosts.set(hostId, scope)
    }
    return scope
  }

  private beginProbe(executorId: string, hostId: string, config: AppConfig): Attempt | null {
    try {
      const scope = this.scope(executorId, hostId, config)
      const attempt: Attempt = { id: mintObjectId(), started: performance.now(), sequence: scope ? ++scope.sequence : 0,
        scope, related: scope?.failure ?? null, stages: [{ stage: 'probe-started', elapsedMs: 0, metadata: { executorId } }] }
      if (attempt.related) attempt.related = this.record(hostId, 'capability-probe', 'probe-started', attempt.id,
        attempt.related, null, { executorId }, attempt.stages, 0)
      return attempt
    } catch { return null }
  }

  private finishProbe(executorId: string, hostId: string, attempt: Attempt | null, result: ExecutorDetection | null, error?: unknown): void {
    try {
      if (!attempt) return
      const availability = result?.availability ?? 'check-failed', failed = availability !== 'available'
      const metadata: AgentMuxClientIncidentMetadata = { executorId, probeAvailability: availability }
      const elapsed = Math.max(0, performance.now() - attempt.started)
      const stage = failed ? 'probe-failed' : 'probe-completed'
      const code = incidentCode(result ? ownErrorData(result, 'cause') : error)
      const occurrence = failed || attempt.related ? this.record(hostId, failed ? 'capability-probe-failed' : 'capability-probe-recovered',
        stage, attempt.id, attempt.related, code, metadata, [...attempt.stages, { stage, elapsedMs: elapsed, metadata }], elapsed) : null
      if (attempt.scope && attempt.sequence >= attempt.scope.settled) {
        attempt.scope.settled = attempt.sequence
        attempt.scope.failure = failed ? occurrence : null
      }
    } catch { /* Original executable results and thrown identities stay available. */ }
  }

  private observeConnection(hostId: string, event: Connection): void {
    try {
      const origin = event.observationOrigin
      if (origin?.kind !== 'runtime-connection' || (origin.boundary !== 'consumer-core' && origin.boundary !== 'core-ctxmux')) return
      const owner = this.runtime.executionHost(hostId), failed = event.state !== 'restored' || !!event.diagnostic
      let boundaries = this.connections.get(owner)
      if (!boundaries) { boundaries = new Map(); this.connections.set(owner, boundaries) }
      const previous = boundaries.get(origin.boundary), code = incidentCode(event.diagnostic)
      if (!failed && !previous) return
      if (previous?.state === event.state && previous.diagnostic === !!event.diagnostic && previous.code === code) return
      const started = previous?.started ?? performance.now(), elapsed = Math.max(0, performance.now() - started)
      const metadata: AgentMuxClientIncidentMetadata = { connectionBoundary: origin.boundary, connectionState: event.state }
      const stages = [...(previous?.stages ?? []), { stage: 'connection-state' as const, elapsedMs: elapsed, metadata }].slice(-CLIENT_INCIDENT_MAX_STAGES)
      const attemptId = previous?.attemptId ?? mintObjectId()
      const occurrenceId = this.record(hostId, failed ? 'connection-failed' : 'connection-recovered', 'connection-state',
        attemptId, previous?.occurrenceId ?? null, code, metadata, stages, elapsed, event.evidence.observedAt)
      if (failed) boundaries.set(origin.boundary, { attemptId, started, occurrenceId, state: event.state,
        diagnostic: !!event.diagnostic, code, stages })
      else boundaries.delete(origin.boundary)
    } catch { /* This observer never fails or reconnects the original connection owner. */ }
  }

  private record(hostId: string, kind: Exclude<AgentMuxClientIncidentReport['kind'], AgentMuxClientReadingIncidentKind>, stage: AgentMuxClientIncidentReport['stage'], attemptId: string,
    relatedOccurrenceId: string | null, code: unknown, metadata: AgentMuxClientIncidentMetadata, stages: Stages, elapsedMs: number,
    observedAt = Date.now()): string {
    const occurrenceId = mintObjectId()
    this.archive.enqueue({ occurrenceId, attemptId, relatedOccurrenceId, hostId, regionId: null, kind, stage,
      code: safeClientIncidentCode(code), agentSessionId: null, runId: null, observedAt, elapsedMs, metadata, stages, references: [] }, this.producer)
    return occurrenceId
  }
}
