import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { isObjectId } from './object-id.js'

export const READING_DIAGNOSTIC_MAX_FIELD_BYTES = 512
export const READING_DIAGNOSTIC_MAX_EVENTS = 64
export const READING_DIAGNOSTIC_MAX_RECORD_BYTES = 32 * 1024
export type ReadingDiagnosticOwner = 'core' | 'renderer'
export type ReadingDiagnosticConsumerKind = 'conversation-pane' | 'focus-preview' | 'input-summary' | 'mobile-conversation' | 'answer-context' | 'core-reader' | 'unknown'
export type ReadingDiagnosticScope = {
  hostId: string
  agentSessionId: string
  runId: string | null
  sourceHostId: string | null
  owner: ReadingDiagnosticOwner
  ownerInstanceId: string
  producerBuildId: string | null
  consumerId: string
  consumerKind: ReadingDiagnosticConsumerKind
}
export type ReadingDiagnosticPhase =
  | 'consumer-started' | 'consumer-hidden' | 'consumer-visible' | 'consumer-ended'
  | 'source-watch-opening' | 'source-watch-opened' | 'source-invalidated' | 'source-watch-unavailable' | 'source-watch-closed'
  | 'source-read-started' | 'source-read-completed' | 'source-read-failed'
  | 'watch-opening' | 'watch-opened' | 'invalidation-received' | 'watch-unavailable' | 'watch-closed'
  | 'read-started' | 'read-deferred' | 'read-page' | 'assembly-complete' | 'read-failed' | 'read-superseded' | 'read-ended'
  | 'admission-held' | 'admission-accepted' | 'held-released' | 'dom-committed'
export type ReadingDiagnosticReason =
  | 'native-reading-protection' | 'captured-reading-protection' | 'historical' | 'held'
  | 'in-flight' | 'coalesced' | 'hidden' | 'binding' | 'navigation' | 'source-unavailable'
  | 'source-changed' | 'cancelled' | 'disposed' | 'deadline' | 'budget' | 'protocol' | 'unknown'
export type ReadingDiagnosticEvent = {
  sequence: number
  wallMs: number
  monoMs: number
  phase: ReadingDiagnosticPhase
  operation?: 'latest' | 'older' | 'newer' | 'changes' | 'resume' | 'reopen'
  attemptId?: string
  watchId?: string
  windowId?: string
  windowRevision?: number
  itemCount?: number
  sourceHostId?: string | null
  document?: { windowId: string; documentGeneration: string }
  regionId?: string
  presentationId?: string
  sourceKind?: 'native' | 'captured' | 'native-unavailable'
  nativeSource?: { providerId: string; nativeSessionId: string }
  capturedEpoch?: string
  reason?: ReadingDiagnosticReason
}
export type ReadingDiagnosticRecord = {
  version: 'reading-diagnostic.v1'
  logId: string
  /** Actual prior publication by this owner/lifetime; never a guessed causal edge. */
  previousLogId: string | null
  scope: ReadingDiagnosticScope
  trigger: 'progress' | 'failure' | 'slow-read' | 'held' | 'recovered' | 'release'
  startedAt: number
  endedAt: number | null
  events: readonly ReadingDiagnosticEvent[]
  coverage: {
    firstSequence: number | null
    lastSequence: number | null
    overwritten: number
    rejected: number
    publicationFailures: number
  }
}

/** No body, cursor, arbitrary error string or executable serializer crosses this contract. */
export type ReadingDiagnosticEventInput = Omit<ReadingDiagnosticEvent, 'sequence' | 'wallMs' | 'monoMs'>
export type ReadingDiagnosticSink = { publish(record: ReadingDiagnosticRecord): void }

const phases: readonly ReadingDiagnosticPhase[] = [
  'consumer-started', 'consumer-hidden', 'consumer-visible', 'consumer-ended',
  'source-watch-opening', 'source-watch-opened', 'source-invalidated', 'source-watch-unavailable', 'source-watch-closed',
  'source-read-started', 'source-read-completed', 'source-read-failed',
  'watch-opening', 'watch-opened', 'invalidation-received', 'watch-unavailable', 'watch-closed',
  'read-started', 'read-deferred', 'read-page', 'assembly-complete', 'read-failed', 'read-superseded', 'read-ended',
  'admission-held', 'admission-accepted', 'held-released', 'dom-committed',
]
const reasons: readonly ReadingDiagnosticReason[] = [
  'native-reading-protection', 'captured-reading-protection', 'historical', 'held', 'in-flight', 'coalesced',
  'hidden', 'binding', 'navigation', 'source-unavailable', 'source-changed', 'cancelled', 'disposed',
  'deadline', 'budget', 'protocol', 'unknown',
]
const consumerKinds: readonly ReadingDiagnosticConsumerKind[] = [
  'conversation-pane', 'focus-preview', 'input-summary', 'mobile-conversation', 'answer-context', 'core-reader', 'unknown',
]
const operations = ['latest', 'older', 'newer', 'changes', 'resume', 'reopen'] as const
export const READING_DIAGNOSTIC_TRIGGERS = ['progress', 'failure', 'slow-read', 'held', 'recovered', 'release'] as const
const encoder = new TextEncoder()
const invalid = (): never => { throw new AgentMuxError('Reading diagnostic metadata is invalid.', 'CONTROL_PROTOCOL_ERROR') }
function object(value: unknown, fields: readonly string[], required: readonly string[] = fields): Record<string, unknown> {
  const result = rpcRecord(value, fields, 'CONTROL_PROTOCOL_ERROR')
  if (required.some(key => !Object.hasOwn(result, key))) invalid()
  return result
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > READING_DIAGNOSTIC_MAX_FIELD_BYTES || /[\0\r\n]/u.test(value) || encoder.encode(value).byteLength > READING_DIAGNOSTIC_MAX_FIELD_BYTES) return invalid()
  return value
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value) }
function member<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return invalid()
  return value as T
}
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) return invalid()
  return Number(value)
}
function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return invalid()
  return value
}
function logId(value: unknown): string { if (!isObjectId(value)) return invalid(); return value }

export function parseReadingDiagnosticScope(value: unknown): ReadingDiagnosticScope {
  const p = object(value, ['hostId', 'agentSessionId', 'runId', 'sourceHostId', 'owner', 'ownerInstanceId', 'producerBuildId', 'consumerId', 'consumerKind'])
  return { hostId: text(p.hostId), agentSessionId: text(p.agentSessionId), runId: nullableText(p.runId),
    sourceHostId: nullableText(p.sourceHostId), owner: member(p.owner, ['core', 'renderer']),
    ownerInstanceId: text(p.ownerInstanceId), producerBuildId: nullableText(p.producerBuildId),
    consumerId: text(p.consumerId), consumerKind: member(p.consumerKind, consumerKinds) }
}

/** Diagnostic metadata admission; never validates or gates the original read. */
export function parseReadingDiagnosticEventInput(value: unknown): ReadingDiagnosticEventInput {
  const p = object(value, ['phase', 'operation', 'attemptId', 'watchId', 'windowId', 'windowRevision', 'itemCount',
    'sourceHostId', 'document', 'regionId', 'presentationId', 'sourceKind', 'nativeSource', 'capturedEpoch', 'reason'], ['phase'])
  const { sequence: _sequence, wallMs: _wallMs, monoMs: _monoMs, ...result } = parseReadingDiagnosticEvent({ sequence: 1, wallMs: 0, monoMs: 0, ...p })
  return result
}

export function parseReadingDiagnosticEvent(value: unknown): ReadingDiagnosticEvent {
  const p = object(value, ['sequence', 'wallMs', 'monoMs', 'phase', 'operation', 'attemptId', 'watchId', 'windowId',
    'windowRevision', 'itemCount', 'sourceHostId', 'document', 'regionId', 'presentationId', 'sourceKind', 'nativeSource', 'capturedEpoch', 'reason'], ['sequence', 'wallMs', 'monoMs', 'phase'])
  const result: ReadingDiagnosticEvent = { sequence: integer(p.sequence, 1), wallMs: time(p.wallMs), monoMs: time(p.monoMs), phase: member(p.phase, phases) }
  if (p.operation !== undefined) result.operation = member(p.operation, operations)
  for (const key of ['attemptId', 'watchId', 'windowId', 'capturedEpoch', 'regionId', 'presentationId'] as const) if (p[key] !== undefined) result[key] = text(p[key])
  for (const key of ['windowRevision', 'itemCount'] as const) if (p[key] !== undefined) result[key] = integer(p[key])
  if (p.sourceHostId !== undefined) result.sourceHostId = nullableText(p.sourceHostId)
  if (p.document !== undefined) {
    const document = object(p.document, ['windowId', 'documentGeneration'])
    result.document = { windowId: text(document.windowId), documentGeneration: text(document.documentGeneration) }
  }
  if (p.sourceKind !== undefined) result.sourceKind = member(p.sourceKind, ['native', 'captured', 'native-unavailable'] as const)
  if (p.nativeSource !== undefined) {
    const native = object(p.nativeSource, ['providerId', 'nativeSessionId'])
    if (result.sourceKind !== 'native') return invalid()
    result.nativeSource = { providerId: text(native.providerId), nativeSessionId: text(native.nativeSessionId) }
  }
  if (result.capturedEpoch !== undefined && result.sourceKind !== 'captured') return invalid()
  if (p.reason !== undefined) result.reason = member(p.reason, reasons)
  return result
}

/** Parse only the finite owner metadata; return detached JSON values. */
export function parseReadingDiagnosticRecord(value: unknown): ReadingDiagnosticRecord {
  const p = object(value, ['version', 'logId', 'previousLogId', 'scope', 'trigger', 'startedAt', 'endedAt', 'events', 'coverage'])
  if (p.version !== 'reading-diagnostic.v1' || !Array.isArray(p.events) || p.events.length > READING_DIAGNOSTIC_MAX_EVENTS) return invalid()
  const events = p.events.map(parseReadingDiagnosticEvent)
  if (events.some((event, index) => index > 0 && (event.sequence <= events[index - 1]!.sequence || event.monoMs < events[index - 1]!.monoMs))) return invalid()
  const c = object(p.coverage, ['firstSequence', 'lastSequence', 'overwritten', 'rejected', 'publicationFailures'])
  const coverage = { firstSequence: c.firstSequence === null ? null : integer(c.firstSequence, 1),
    lastSequence: c.lastSequence === null ? null : integer(c.lastSequence, 1), overwritten: integer(c.overwritten),
    rejected: integer(c.rejected), publicationFailures: integer(c.publicationFailures) }
  if (coverage.firstSequence !== (events[0]?.sequence ?? null) || coverage.lastSequence !== (events.at(-1)?.sequence ?? null)) return invalid()
  const result: ReadingDiagnosticRecord = { version: 'reading-diagnostic.v1', logId: logId(p.logId),
    previousLogId: p.previousLogId === null ? null : logId(p.previousLogId), scope: parseReadingDiagnosticScope(p.scope),
    trigger: member(p.trigger, READING_DIAGNOSTIC_TRIGGERS), startedAt: time(p.startedAt), endedAt: p.endedAt === null ? null : time(p.endedAt), events, coverage }
  if (result.previousLogId === result.logId || encoder.encode(JSON.stringify(result)).byteLength > READING_DIAGNOSTIC_MAX_RECORD_BYTES) return invalid()
  return result
}

