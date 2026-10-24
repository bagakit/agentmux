import type { DiagnosticEvidenceAuthority, DiagnosticEvidenceRead, DiagnosticEvidenceRef } from '@agentmux/diagnostic-evidence'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { isDeliveryLogId } from './delivery-log-id.js'
import { parseReadingDiagnosticRecord, type ReadingDiagnosticRecord } from './reading-diagnostic.js'
import type { MobileWebObservation, MobileWebProducer } from './mobile-web.js'
export { clientIncidentPriority } from './client-incident-priority.js'

export const CLIENT_READING_INCIDENT_KINDS = ['conversation-reading-progress', 'conversation-reading-failure',
  'conversation-reading-held', 'conversation-reading-recovered'] as const
export const CLIENT_INCIDENT_KINDS = ['terminal-attach-failed', 'terminal-replay-failed', 'terminal-output-gap', 'terminal-continuation-unavailable',
  'terminal-reveal-deadline', 'terminal-context-lost', 'terminal-refresh', 'terminal-recovered',
  'capability-probe', 'capability-probe-failed', 'capability-probe-recovered', 'connection-failed', 'connection-recovered', 'mobile-web-observation', ...CLIENT_READING_INCIDENT_KINDS] as const
export const CLIENT_INCIDENT_STAGES = ['attach-requested', 'attach-received', 'replay-started', 'replay-applied', 'replay-failed', 'output-gap',
  'live-ready', 'revealed', 'reveal-deadline', 'attach-failed', 'refresh-requested', 'refresh-completed',
  'refresh-failed', 'context-lost', 'visibility', 'resize', 'connection-state', 'probe-started',
  'probe-completed', 'probe-failed', 'observation-unavailable', 'observation-restored', 'reading-observed', 'mobile-observed'] as const
export const CLIENT_INCIDENT_CODES = ['EIO', 'ENOSPC', 'EACCES', 'ENOENT', 'EDQUOT', 'EMFILE', 'ENFILE', 'EPIPE',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EEXIST', 'ENOTDIR', 'EISDIR', 'EROFS', 'EINVAL', 'ABORT_ERR',
  'CONTROL_UNAVAILABLE', 'CONTROL_CONNECTION_FAILED', 'CONTROL_TIMEOUT', 'CONTROL_PROTOCOL_ERROR', 'CONTROL_CANCELLED', 'CONTROL_PERMISSION_DENIED',
  'RUNTIME_UNAVAILABLE', 'RUNTIME_OWNER_CHANGED', 'CTXMUX_DISCONNECTED', 'CTXMUX_run_not_found', 'STALE_AGENT_SESSION', 'STALE_AGENT_SESSION_BINDING',
  'UNKNOWN_AGENT_SESSION', 'INVALID_CONTROL_REQUEST', 'CTXMUX_EVENT_INVALID', 'EXECUTOR_HOST_CHANGED', 'EXECUTOR_CHECK_FAILED',
  'SETTING_RESOURCE_NOT_FOUND', 'EXECUTABLE_SEARCH_UNAVAILABLE', 'EXECUTABLE_WORKSPACE_REQUIRED',
  'EXECUTABLE_NOT_FILE', 'EXECUTABLE_CHECK_FAILED', 'CTXMUX_CONNECTION_OBSERVATION_FAILED'] as const
export type AgentMuxClientIncidentKind = typeof CLIENT_INCIDENT_KINDS[number]
export type AgentMuxClientReadingIncidentKind = typeof CLIENT_READING_INCIDENT_KINDS[number]
export type AgentMuxClientIncidentStage = typeof CLIENT_INCIDENT_STAGES[number]
export type AgentMuxClientIncidentCode = typeof CLIENT_INCIDENT_CODES[number]
export const CLIENT_INCIDENT_MAX_STAGES = 16
// The reading record has its own 32 KiB bound; reserve room for the common envelope.
export const CLIENT_INCIDENT_MAX_REPORT_BYTES = 36 * 1024
export const CLIENT_INCIDENT_MAX_PAGE = 32

/** Only facts already held by the producer. No terminal text, error text or paths. */
export type AgentMuxClientIncidentMetadata = {
  attachmentId?: string | null
  latestOutputBytes?: number; cursorBytes?: number; parserAppliedBytes?: number; pendingBytes?: number; pendingBatches?: number
  cols?: number; rows?: number; clientWidth?: number; clientHeight?: number
  baseY?: number; viewportY?: number; bufferLength?: number; resizeRevision?: number
  renderCallbacks?: number; writeCompletions?: number; liveQueueBytes?: number; liveQueueItems?: number
  historyOverwritten?: number; reporterDropped?: number; recorderReadFailures?: number
  reporterRejected?: number; reporterUnavailable?: number; reporterCoalesced?: number
  reporterQueuedCount?: number; reporterQueuedBytes?: number
  visible?: boolean; revealed?: boolean; liveReady?: boolean; replaying?: boolean; readOnly?: boolean; canControl?: boolean; disposed?: boolean
  attachmentState?: 'attaching' | 'attached' | 'reconnecting' | 'detached' | 'unknown'
  processState?: 'running' | 'exited' | 'lost' | 'unknown'
  bufferType?: 'normal' | 'alternate'
  renderer?: 'webgl' | 'dom' | 'unknown'
  continuationType?: 'not-requested' | 'basic-vt' | 'unknown' | 'unavailable'
  continuationReason?: 'origin_unknown' | 'source_gap' | 'tail_evicted' | 'checkpoint_too_large' | 'invalid_checkpoint'
  executorId?: string
  probeAvailability?: 'unknown' | 'check-failed' | 'missing' | 'available'
  connectionBoundary?: 'consumer-core' | 'core-ctxmux'
  connectionState?: 'lost' | 'retrying' | 'restored' | 'unrecoverable'
}
export type AgentMuxClientIncidentReference =
  | { domain: 'delivery.client' | 'delivery.core'; hostId: string; logId: string; authority?: Pick<DiagnosticEvidenceAuthority, 'kind' | 'id'> }
  | { domain: 'native-recorder-failure'; hostId: string; agentSessionId: string; runId: string }
  | { domain: 'toolkit.performance-failure'; hostId: string; executionId: string }
  | { domain: 'performance.scene'; hostId: string; captureId: string }
type ClientIncidentReportBase = {
  occurrenceId: string
  attemptId: string
  relatedOccurrenceId: string | null
  /** Original execution Host; the archive route is independently selected by the read target. */
  hostId: string
  regionId: string | null
  stage: AgentMuxClientIncidentStage
  code: AgentMuxClientIncidentCode | null
  agentSessionId: string | null
  runId: string | null
  observedAt: number
  /** Same producer clock only; never subtract another producer's wall clock. */
  elapsedMs: number | null
  metadata: AgentMuxClientIncidentMetadata
  stages: Array<{ stage: AgentMuxClientIncidentStage; elapsedMs: number; metadata: AgentMuxClientIncidentMetadata }>
  references: AgentMuxClientIncidentReference[]
}
export type AgentMuxClientReadingIncidentReport = ClientIncidentReportBase & { kind: AgentMuxClientReadingIncidentKind; reading: ReadingDiagnosticRecord }
export type AgentMuxClientIncidentReport = AgentMuxClientReadingIncidentReport |
  ClientIncidentReportBase & { kind: 'mobile-web-observation'; mobile: MobileWebObservation; reading?: never } |
  ClientIncidentReportBase & { kind: Exclude<AgentMuxClientIncidentKind, AgentMuxClientReadingIncidentKind | 'mobile-web-observation'>; reading?: never; mobile?: never }

export function clientReadingIncidentKind(trigger: ReadingDiagnosticRecord['trigger']): AgentMuxClientReadingIncidentKind {
  return trigger === 'failure' || trigger === 'slow-read' ? 'conversation-reading-failure'
    : trigger === 'held' ? 'conversation-reading-held'
      : trigger === 'recovered' ? 'conversation-reading-recovered' : 'conversation-reading-progress'
}
type ClientIncidentProducerBase = {
  appInstanceId: string
  producerInstanceId: string
  windowId: string | null
  documentGeneration: string | null
  buildId: string | null
}
export type AgentMuxClientIncidentProducer = ClientIncidentProducerBase & (
  { kind: 'renderer' | 'main' } | { kind: 'mobile-web'; devicePrincipalId: string; documentId: string; namespaceDigest: string | null })
export type AgentMuxClientIncidentMobileSelector = MobileWebProducer & { kind: 'mobile-web'; buildId?: string | null; namespaceDigest?: string | null }
export type AgentMuxClientIncidentRecord = {
  kind: 'client-incident'
  logId: string
  authority: DiagnosticEvidenceAuthority
  receivedAt: number
  producer: AgentMuxClientIncidentProducer
  report: AgentMuxClientIncidentReport
}
export type AgentMuxClientIncidentRecent = {
  limit?: number; cursor?: string; since?: number; until?: number
  agentSessionId?: string; runId?: string; kind?: AgentMuxClientIncidentKind
  producer?: AgentMuxClientIncidentMobileSelector
}
export type AgentMuxClientIncidentTarget =
  | { domain: 'client.incident'; hostId: string; logId: string; authority?: Pick<DiagnosticEvidenceAuthority, 'kind' | 'id'> }
  | { domain: 'client.incident'; hostId: string; recent: AgentMuxClientIncidentRecent }
export type AgentMuxClientIncidentCoverage = {
  startup: 'ready' | 'loading' | 'unavailable'
  retainedCount: number; retainedBytes: number; pendingWrites: number
  dropped: number; invalid: number; duplicates: number; evicted: number; corrupt: number; writeFailures: number; indexFailures: number; cleanupFailures: number
}
export type AgentMuxClientIncidentPage = {
  kind: 'client-incident-page'
  items: Array<Pick<AgentMuxClientIncidentReport, 'kind' | 'stage' | 'code' | 'agentSessionId' | 'runId' | 'attemptId' | 'occurrenceId'> & {
    recordRef: DiagnosticEvidenceRef
    receivedAt: number
    persistence: 'confirmed' | 'observed' | 'unconfirmed'
    producer?: AgentMuxClientIncidentMobileSelector
  }>
  nextCursor: string | null
  coverage: AgentMuxClientIncidentCoverage
}
export type AgentMuxClientIncidentEvidence = AgentMuxClientIncidentRecord | AgentMuxClientIncidentPage
export type AgentMuxClientIncidentPort = {
  hostId: string
  read(target: AgentMuxClientIncidentTarget, bounds: { signal: AbortSignal; maxBytes: number }):
    Promise<DiagnosticEvidenceRead<AgentMuxClientIncidentTarget, AgentMuxClientIncidentEvidence>>
}

const fail = (): never => { throw new AgentMuxError('Client incident does not satisfy its finite public contract.', 'CONTROL_PROTOCOL_ERROR') }
const validateDeliveryLogId = (value: unknown) => { if (!isDeliveryLogId(value)) fail() }
function object(value: unknown, keys: readonly string[], required = keys): Record<string, unknown> {
  const p = rpcRecord(value, keys, 'CONTROL_PROTOCOL_ERROR')
  if (required.some(key => !Object.hasOwn(p, key))) fail()
  return p
}
function member(value: unknown, values: readonly unknown[]) { if (!values.includes(value)) fail() }
function id(value: unknown, nullable = false) {
  if (nullable && value === null) return
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) fail()
}
function number(value: unknown, nullable = false) {
  if (!(nullable && value === null) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)) fail()
}
function opaque(value: unknown, max: number) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value) || new TextEncoder().encode(value).byteLength > max) fail()
}
export function parseMobileWebObservation(value: unknown): MobileWebObservation {
  const p = rpcRecord(value)
  if (p.kind === 'catalog-partial') {
    object(p, ['kind', 'source', 'code', 'issueCount', 'spaceIds', 'omittedCount'])
    member(p.source, ['space.ls']); member(p.code, [null]); number(p.issueCount); number(p.omittedCount)
    if (!Number.isSafeInteger(p.issueCount) || !Number.isSafeInteger(p.omittedCount) || (p.issueCount as number) < 1) fail()
    const ids = list(p.spaceIds, 4, value => { opaque(value, 512); return value as string })
    if (new Set(ids).size !== ids.length || ids.length + (p.omittedCount as number) !== p.issueCount) fail()
  } else if (p.kind === 'catalog-failed') {
    object(p, ['kind', 'source', 'code']); member(p.source, ['space.ls']); member(p.code, [...CLIENT_INCIDENT_CODES, null])
  } else if (p.kind === 'connection-state') {
    object(p, ['kind', 'source', 'code', 'state', 'boundary']); member(p.source, ['connection-state']); member(p.code, [null])
    member(p.state, ['lost', 'retrying', 'restored', 'unrecoverable']); member(p.boundary, ['consumer-core', 'core-ctxmux', null])
  } else fail()
  return p as MobileWebObservation
}
function mobileSelector(value: unknown): AgentMuxClientIncidentMobileSelector {
  const p = object(value, ['kind', 'devicePrincipalId', 'documentId', 'buildId', 'namespaceDigest'], ['kind', 'devicePrincipalId', 'documentId'])
  member(p.kind, ['mobile-web']); opaque(p.devicePrincipalId, 512); id(p.documentId)
  if (p.buildId !== undefined) id(p.buildId, true)
  if (p.namespaceDigest !== undefined && p.namespaceDigest !== null && (typeof p.namespaceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(p.namespaceDigest))) fail()
  return p as AgentMuxClientIncidentMobileSelector
}
function list<T>(value: unknown, max: number, consume: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) fail()
  const result: T[] = []
  for (let index = 0; index < (value as unknown[]).length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, index)
    if (!entry || !Object.hasOwn(entry, 'value')) fail()
    result.push(consume(entry!.value))
  }
  return result
}
function namespace(value: unknown, durable = false) {
  const p = object(value, durable ? ['kind', 'id', 'lifetime'] : ['kind', 'id'])
  id(p.kind); id(p.id)
  if (durable) member(p.lifetime, ['durable', 'instance', 'unknown'])
}
const metadataNumbers = ['latestOutputBytes', 'cursorBytes', 'parserAppliedBytes', 'pendingBytes', 'pendingBatches', 'cols', 'rows',
  'clientWidth', 'clientHeight', 'baseY', 'viewportY', 'bufferLength', 'resizeRevision', 'renderCallbacks', 'writeCompletions', 'liveQueueBytes', 'liveQueueItems', 'historyOverwritten', 'reporterDropped', 'recorderReadFailures',
  'reporterRejected', 'reporterUnavailable', 'reporterCoalesced', 'reporterQueuedCount', 'reporterQueuedBytes']
const metadataBooleans = ['visible', 'revealed', 'liveReady', 'replaying', 'readOnly', 'canControl', 'disposed']
export function parseClientIncidentMetadata(value: unknown): AgentMuxClientIncidentMetadata {
  const p = object(value, [...metadataNumbers, ...metadataBooleans, 'attachmentId', 'attachmentState', 'processState', 'bufferType', 'renderer',
    'executorId', 'probeAvailability', 'connectionBoundary', 'connectionState', 'continuationType', 'continuationReason'], [])
  for (const key of metadataNumbers) if (Object.hasOwn(p, key)) number(p[key])
  for (const key of metadataBooleans) if (Object.hasOwn(p, key)) member(p[key], [true, false])
  if (Object.hasOwn(p, 'attachmentId')) id(p.attachmentId, true)
  if (Object.hasOwn(p, 'attachmentState')) member(p.attachmentState, ['attaching', 'attached', 'reconnecting', 'detached', 'unknown'])
  if (Object.hasOwn(p, 'processState')) member(p.processState, ['running', 'exited', 'lost', 'unknown'])
  if (Object.hasOwn(p, 'bufferType')) member(p.bufferType, ['normal', 'alternate'])
  if (Object.hasOwn(p, 'renderer')) member(p.renderer, ['webgl', 'dom', 'unknown'])
  if (Object.hasOwn(p, 'continuationType')) member(p.continuationType, ['not-requested', 'basic-vt', 'unknown', 'unavailable'])
  if (Object.hasOwn(p, 'continuationReason')) member(p.continuationReason, ['origin_unknown', 'source_gap', 'tail_evicted', 'checkpoint_too_large', 'invalid_checkpoint'])
  if (Object.hasOwn(p, 'executorId')) id(p.executorId)
  if (Object.hasOwn(p, 'probeAvailability')) member(p.probeAvailability, ['unknown', 'check-failed', 'missing', 'available'])
  if (Object.hasOwn(p, 'connectionBoundary')) member(p.connectionBoundary, ['consumer-core', 'core-ctxmux'])
  if (Object.hasOwn(p, 'connectionState')) member(p.connectionState, ['lost', 'retrying', 'restored', 'unrecoverable'])
  return { ...p } as AgentMuxClientIncidentMetadata
}
function reference(value: unknown) {
  const p = rpcRecord(value), common = ['domain', 'hostId']; id(p.hostId)
  if (p.domain === 'delivery.client' || p.domain === 'delivery.core') {
    object(p, [...common, 'logId', 'authority'], [...common, 'logId']); validateDeliveryLogId(p.logId)
    if (p.authority !== undefined) namespace(p.authority)
  } else if (p.domain === 'native-recorder-failure') {
    object(p, [...common, 'agentSessionId', 'runId']); id(p.agentSessionId); id(p.runId)
  } else if (p.domain === 'toolkit.performance-failure') { object(p, [...common, 'executionId']); id(p.executionId) }
  else if (p.domain === 'performance.scene') { object(p, [...common, 'captureId']); id(p.captureId) }
  else fail()
  const authority = p.authority === undefined ? undefined : rpcRecord(p.authority)
  return { ...p, ...(authority ? { authority: { kind: authority.kind, id: authority.id } } : {}) } as AgentMuxClientIncidentReference
}
export function parseClientIncidentReport(value: unknown): AgentMuxClientIncidentReport {
  const fields = ['occurrenceId', 'attemptId', 'relatedOccurrenceId', 'hostId', 'regionId', 'kind', 'stage', 'code',
    'agentSessionId', 'runId', 'observedAt', 'elapsedMs', 'metadata', 'stages', 'references']
  const p = object(value, [...fields, 'reading', 'mobile'], fields)
  for (const key of ['occurrenceId', 'attemptId', 'hostId']) id(p[key])
  for (const key of ['relatedOccurrenceId', 'regionId', 'agentSessionId', 'runId']) id(p[key], true)
  member(p.kind, CLIENT_INCIDENT_KINDS); member(p.stage, CLIENT_INCIDENT_STAGES); member(p.code, [...CLIENT_INCIDENT_CODES, null])
  number(p.observedAt); number(p.elapsedMs, true)
  const metadata = parseClientIncidentMetadata(p.metadata)
  const stages = list(p.stages, CLIENT_INCIDENT_MAX_STAGES, value => {
    const s = object(value, ['stage', 'elapsedMs', 'metadata'])
    member(s.stage, CLIENT_INCIDENT_STAGES); number(s.elapsedMs)
    return { stage: s.stage, elapsedMs: s.elapsedMs, metadata: parseClientIncidentMetadata(s.metadata) }
  })
  const references = list(p.references, 8, reference)
  let reading: ReadingDiagnosticRecord | undefined
  if ((CLIENT_READING_INCIDENT_KINDS as readonly unknown[]).includes(p.kind)) {
    reading = parseReadingDiagnosticRecord(p.reading)
    const first = reading.events[0], last = reading.events.at(-1)
    if (reading.scope.owner !== 'renderer' || p.kind !== clientReadingIncidentKind(reading.trigger) ||
      p.stage !== 'reading-observed' || p.code !== null || (p.stages as unknown[]).length !== 0 ||
      p.occurrenceId !== reading.logId || p.relatedOccurrenceId !== reading.previousLogId || p.attemptId !== reading.scope.consumerId ||
      p.hostId !== reading.scope.hostId || p.agentSessionId !== reading.scope.agentSessionId || p.runId !== reading.scope.runId ||
      p.observedAt !== (last?.wallMs ?? reading.startedAt) || p.elapsedMs !== (first && last ? last.monoMs - first.monoMs : null)) fail()
  } else if (Object.hasOwn(p, 'reading') || p.stage === 'reading-observed') fail()
  const mobile = p.kind === 'mobile-web-observation' ? parseMobileWebObservation(p.mobile) : undefined
  if (mobile ? p.stage !== 'mobile-observed' || p.code !== mobile.code || p.agentSessionId !== null || p.runId !== null ||
    p.regionId !== null || p.elapsedMs !== null || (p.stages as unknown[]).length !== 0 || (p.references as unknown[]).length !== 0
    : Object.hasOwn(p, 'mobile') || p.stage === 'mobile-observed') fail()
  // Serialize only finite detached data, never a caller's iterator or toJSON.
  const result = { ...p, metadata, stages, references, ...(reading ? { reading } : {}), ...(mobile ? { mobile } : {}) }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > CLIENT_INCIDENT_MAX_REPORT_BYTES) fail()
  return result as AgentMuxClientIncidentReport
}
export function parseClientIncidentTarget(value: unknown): AgentMuxClientIncidentTarget {
  const p = rpcRecord(value); member(p.domain, ['client.incident']); id(p.hostId)
  if (Object.hasOwn(p, 'recent')) {
    object(p, ['domain', 'hostId', 'recent'])
    const r = object(p.recent, ['limit', 'cursor', 'since', 'until', 'agentSessionId', 'runId', 'kind', 'producer'], [])
    if (r.limit !== undefined && (!Number.isSafeInteger(r.limit) || (r.limit as number) < 1 || (r.limit as number) > CLIENT_INCIDENT_MAX_PAGE)) fail()
    if (r.cursor !== undefined && (typeof r.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,768}$/u.test(r.cursor))) fail()
    for (const key of ['agentSessionId', 'runId']) if (r[key] !== undefined) id(r[key])
    for (const key of ['since', 'until']) if (r[key] !== undefined) number(r[key])
    if (r.since !== undefined && r.until !== undefined && (r.since as number) > (r.until as number)) fail()
    if (r.kind !== undefined) member(r.kind, CLIENT_INCIDENT_KINDS)
    if (r.producer !== undefined) mobileSelector(r.producer)
  } else {
    object(p, ['domain', 'hostId', 'logId', 'authority'], ['domain', 'hostId', 'logId']); validateDeliveryLogId(p.logId)
    if (p.authority !== undefined) namespace(p.authority)
  }
  return p as AgentMuxClientIncidentTarget
}
export function parseClientIncidentRecord(value: unknown): AgentMuxClientIncidentRecord {
  const p = object(value, ['kind', 'logId', 'authority', 'receivedAt', 'producer', 'report'])
  member(p.kind, ['client-incident']); validateDeliveryLogId(p.logId); namespace(p.authority, true); number(p.receivedAt)
  const archive = rpcRecord(p.authority)
  if (archive.kind !== 'client-incident-archive' || archive.lifetime !== 'durable') fail()
  const rawProducer = rpcRecord(p.producer)
  const fields = ['kind', 'appInstanceId', 'producerInstanceId', 'windowId', 'documentGeneration', 'buildId']
  const producer = object(rawProducer, rawProducer.kind === 'mobile-web' ? [...fields, 'devicePrincipalId', 'documentId', 'namespaceDigest'] : fields)
  member(producer.kind, ['main', 'renderer', 'mobile-web']); id(producer.appInstanceId); id(producer.producerInstanceId)
  for (const key of ['windowId', 'documentGeneration', 'buildId']) id(producer[key], true)
  if (producer.kind === 'mobile-web') {
    opaque(producer.devicePrincipalId, 512); id(producer.documentId)
    if (producer.namespaceDigest !== null && (typeof producer.namespaceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(producer.namespaceDigest))) fail()
    if (producer.windowId !== null || producer.documentGeneration !== null) fail()
  }
  const report = parseClientIncidentReport(p.report)
  if ((report.kind === 'mobile-web-observation') !== (producer.kind === 'mobile-web')) fail()
  if (report.reading && report.reading.logId !== p.logId) fail()
  return { ...p, producer: { ...producer }, authority: { ...archive }, report } as AgentMuxClientIncidentRecord
}
export function parseClientIncidentPage(value: unknown, target: Extract<AgentMuxClientIncidentTarget, { recent: unknown }>): AgentMuxClientIncidentPage {
  const p = object(value, ['kind', 'items', 'nextCursor', 'coverage']); member(p.kind, ['client-incident-page'])
  const seen = new Set<string>()
  list(p.items, target.recent.limit ?? CLIENT_INCIDENT_MAX_PAGE, value => {
    const fields = ['recordRef', 'kind', 'stage', 'code', 'agentSessionId', 'runId', 'attemptId', 'occurrenceId', 'receivedAt', 'persistence']
    const i = object(value, [...fields, 'producer'], fields)
    const producer = i.producer === undefined ? undefined : mobileSelector(i.producer)
    if ((i.kind === 'mobile-web-observation') !== (producer !== undefined)) fail()
    const ref = object(i.recordRef, ['domain', 'logId', 'authority', 'routeHostId'])
    member(ref.domain, ['client.incident']); validateDeliveryLogId(ref.logId); namespace(ref.authority, true)
    const archive = rpcRecord(ref.authority)
    if (archive.kind !== 'client-incident-archive' || archive.lifetime !== 'durable' || seen.has(ref.logId as string)) fail()
    seen.add(ref.logId as string)
    if (ref.routeHostId !== target.hostId) fail()
    member(i.kind, CLIENT_INCIDENT_KINDS); member(i.stage, CLIENT_INCIDENT_STAGES); member(i.code, [...CLIENT_INCIDENT_CODES, null])
    id(i.agentSessionId, true); id(i.runId, true); id(i.attemptId); id(i.occurrenceId); number(i.receivedAt)
    member(i.persistence, ['confirmed', 'observed', 'unconfirmed'])
    if (target.recent.agentSessionId !== undefined && i.agentSessionId !== target.recent.agentSessionId ||
      target.recent.runId !== undefined && i.runId !== target.recent.runId || target.recent.kind !== undefined && i.kind !== target.recent.kind ||
      target.recent.since !== undefined && (i.receivedAt as number) < target.recent.since || target.recent.until !== undefined && (i.receivedAt as number) > target.recent.until) fail()
    const selected = target.recent.producer
    if (selected && (!producer || selected.devicePrincipalId !== producer.devicePrincipalId || selected.documentId !== producer.documentId ||
      Object.hasOwn(selected, 'buildId') && selected.buildId !== producer.buildId ||
      Object.hasOwn(selected, 'namespaceDigest') && selected.namespaceDigest !== producer.namespaceDigest)) fail()
  })
  if (p.nextCursor !== null && (typeof p.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,768}$/u.test(p.nextCursor))) fail()
  const c = object(p.coverage, ['startup', 'retainedCount', 'retainedBytes', 'pendingWrites', 'dropped', 'invalid', 'duplicates', 'evicted', 'corrupt', 'writeFailures', 'indexFailures', 'cleanupFailures'])
  member(c.startup, ['ready', 'loading', 'unavailable'])
  for (const key of Object.keys(c)) if (key !== 'startup') number(c[key])
  return p as AgentMuxClientIncidentPage
}
export function safeClientIncidentCode(value: unknown): AgentMuxClientIncidentCode | null {
  return (CLIENT_INCIDENT_CODES as readonly unknown[]).includes(value) ? value as AgentMuxClientIncidentCode : null
}
