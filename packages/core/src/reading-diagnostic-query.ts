import { DIAGNOSTIC_EVIDENCE_AVAILABILITIES, DIAGNOSTIC_EVIDENCE_ISSUE_CODES } from '@agentmux/diagnostic-evidence'
import type { DiagnosticEvidenceAuthority, DiagnosticEvidenceRead, DiagnosticEvidenceRef } from '@agentmux/diagnostic-evidence'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { isObjectId } from './object-id.js'
import { parseReadingDiagnosticRecord, parseReadingDiagnosticScope, READING_DIAGNOSTIC_MAX_FIELD_BYTES, READING_DIAGNOSTIC_MAX_EVENTS, READING_DIAGNOSTIC_TRIGGERS, type ReadingDiagnosticScope, type ReadingDiagnosticRecord } from './reading-diagnostic.js'

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

/** The source namespace is explicit: current Core memory is never silently replaced by a client archive. */
export type ReadingDiagnosticExactTarget = {
  domain: 'reading.lifecycle'
  hostId: string
  logId: string
  authority?: Pick<DiagnosticEvidenceAuthority, 'kind' | 'id'>
}
export type ReadingDiagnosticRecent = {
  limit?: number
  cursor?: string
  since?: number
  until?: number
  agentSessionId?: string
  runId?: string
}
export type ReadingDiagnosticTarget = ReadingDiagnosticExactTarget | {
  domain: 'reading.lifecycle'
  hostId: string
  recent: ReadingDiagnosticRecent
}
export type ReadingDiagnosticFindParams = ReadingDiagnosticRecent & {
  hostId: string
  maxBytes?: number
}
export type ReadingDiagnosticSummary = {
  reference: DiagnosticEvidenceRef
  scope: ReadingDiagnosticScope
  trigger: ReadingDiagnosticRecord['trigger']
  observedAt: number
  startedAt: number
  endedAt: number | null
  firstSequence: number | null
  lastSequence: number | null
  eventCount: number
}
export type ReadingDiagnosticFindResult = {
  query: ReadingDiagnosticFindParams
  availability: 'found' | 'unavailable' | 'unsupported' | 'forbidden'
  authority: DiagnosticEvidenceAuthority | null
  records: ReadingDiagnosticSummary[]
  nextCursor: string | null
  coverage: {
    retainedRecords: number | null
    evictedRecords: number | null
    rejectedRecords: number | null
    examinedRecords: number
    /** Completeness of this index page only; never continuous observation or absence of anomalies. */
    complete: boolean
  }
  issue: 'source-unavailable' | 'source-unsupported' | 'source-forbidden' | 'source-busy' | 'query-budget' | 'query-cancelled' | 'query-deadline' | null
}
export interface ReadingDiagnosticEvidencePort {
  hostId: string
  read(target: ReadingDiagnosticExactTarget, bounds: { signal: AbortSignal; maxBytes: number }):
    Promise<DiagnosticEvidenceRead<ReadingDiagnosticExactTarget, ReadingDiagnosticRecord>>
  find(params: ReadingDiagnosticFindParams, bounds: { signal: AbortSignal; maxBytes: number }): Promise<ReadingDiagnosticFindResult>
}
export const READING_DIAGNOSTIC_MAX_FIND_RESULTS = 32
export const READING_DIAGNOSTIC_MAX_FIND_BYTES = 128 * 1024

function parseAuthority(value: unknown): DiagnosticEvidenceAuthority | null {
  if (value === null) return null
  const p = object(value, ['kind', 'id', 'lifetime'])
  return { kind: text(p.kind), id: text(p.id), lifetime: member(p.lifetime, ['durable', 'instance', 'unknown']) }
}
export function parseReadingDiagnosticFindParams(value: unknown): ReadingDiagnosticFindParams {
  const p = object(value, ['hostId', 'limit', 'cursor', 'since', 'until', 'agentSessionId', 'runId', 'maxBytes'], ['hostId'])
  const result: ReadingDiagnosticFindParams = { hostId: text(p.hostId) }
  for (const key of ['cursor', 'agentSessionId', 'runId'] as const) if (p[key] !== undefined) result[key] = text(p[key])
  for (const key of ['since', 'until'] as const) if (p[key] !== undefined) result[key] = time(p[key])
  if (p.limit !== undefined) { result.limit = integer(p.limit, 1); if (result.limit > READING_DIAGNOSTIC_MAX_FIND_RESULTS) return invalid() }
  if (p.maxBytes !== undefined) {
    result.maxBytes = integer(p.maxBytes, 4096)
    if (result.maxBytes > READING_DIAGNOSTIC_MAX_FIND_BYTES) return invalid()
  }
  if (result.since !== undefined && result.until !== undefined && result.since > result.until) return invalid()
  return result
}
export function parseReadingDiagnosticTarget(value: unknown): ReadingDiagnosticTarget {
  const p = rpcRecord(value, ['domain', 'hostId', 'logId', 'authority', 'recent'], 'CONTROL_PROTOCOL_ERROR')
  if (p.domain !== 'reading.lifecycle') return invalid()
  const base = { domain: 'reading.lifecycle' as const, hostId: text(p.hostId) }
  if (p.recent !== undefined) {
    if (p.logId !== undefined || p.authority !== undefined) return invalid()
    const recent = object(p.recent, ['limit', 'cursor', 'since', 'until', 'agentSessionId', 'runId'], [])
    const { hostId: _hostId, ...parsed } = parseReadingDiagnosticFindParams({ hostId: base.hostId, ...recent })
    return { ...base, recent: parsed }
  }
  if (p.logId === undefined) return invalid()
  const result: ReadingDiagnosticExactTarget = { ...base, logId: logId(p.logId) }
  if (p.authority !== undefined) { const a = object(p.authority, ['kind', 'id']); result.authority = { kind: text(a.kind), id: text(a.id) } }
  return result
}
export function parseReadingDiagnosticFindResult(value: unknown, request: ReadingDiagnosticFindParams): ReadingDiagnosticFindResult {
  const p = object(value, ['query', 'availability', 'authority', 'records', 'nextCursor', 'coverage', 'issue'])
  const query = parseReadingDiagnosticFindParams(p.query), expected = parseReadingDiagnosticFindParams(request)
  if (Object.keys(query).length !== Object.keys(expected).length || Object.keys(expected).some(key => query[key as keyof typeof query] !== expected[key as keyof typeof expected])) return invalid()
  if (!Array.isArray(p.records) || p.records.length > (expected.limit ?? READING_DIAGNOSTIC_MAX_FIND_RESULTS)) return invalid()
  const authority = parseAuthority(p.authority)
  if (p.availability === 'found' && authority === null || authority && (authority.kind !== 'core-reading-observer' || authority.lifetime !== 'instance')) return invalid()
  const records = p.records.map(value => {
    const r = object(value, ['reference', 'scope', 'trigger', 'observedAt', 'startedAt', 'endedAt', 'firstSequence', 'lastSequence', 'eventCount'])
    const f = object(r.reference, ['domain', 'logId', 'authority', 'routeHostId'])
    if (f.domain !== 'reading.lifecycle' || f.routeHostId !== expected.hostId) return invalid()
    const reference: DiagnosticEvidenceRef = { domain: 'reading.lifecycle', logId: logId(f.logId), authority: parseAuthority(f.authority), routeHostId: expected.hostId }
    if (reference.authority?.kind !== authority?.kind || reference.authority?.id !== authority?.id || reference.authority?.lifetime !== authority?.lifetime) return invalid()
    const scope = parseReadingDiagnosticScope(r.scope)
    if (scope.owner !== 'core' || authority && scope.ownerInstanceId !== authority.id || expected.agentSessionId !== undefined && scope.agentSessionId !== expected.agentSessionId || expected.runId !== undefined && scope.runId !== expected.runId) return invalid()
    const eventCount = integer(r.eventCount)
    if (eventCount > READING_DIAGNOSTIC_MAX_EVENTS) return invalid()
    return { reference, scope, trigger: member(r.trigger, READING_DIAGNOSTIC_TRIGGERS), observedAt: time(r.observedAt), startedAt: time(r.startedAt), endedAt: r.endedAt === null ? null : time(r.endedAt),
      firstSequence: r.firstSequence === null ? null : integer(r.firstSequence, 1), lastSequence: r.lastSequence === null ? null : integer(r.lastSequence, 1), eventCount }
  })
  const c = object(p.coverage, ['retainedRecords', 'evictedRecords', 'rejectedRecords', 'examinedRecords', 'complete'])
  if (typeof c.complete !== 'boolean') return invalid()
  const coverage = { retainedRecords: c.retainedRecords === null ? null : integer(c.retainedRecords), evictedRecords: c.evictedRecords === null ? null : integer(c.evictedRecords),
    rejectedRecords: c.rejectedRecords === null ? null : integer(c.rejectedRecords), examinedRecords: integer(c.examinedRecords), complete: c.complete }
  const result: ReadingDiagnosticFindResult = { query, availability: member(p.availability, ['found', 'unavailable', 'unsupported', 'forbidden']), authority, records,
    nextCursor: nullableText(p.nextCursor), coverage, issue: p.issue === null ? null : member(p.issue, ['source-unavailable', 'source-unsupported', 'source-forbidden', 'source-busy', 'query-budget', 'query-cancelled', 'query-deadline'] as const) }
  if (result.availability !== 'found' && (records.length || result.nextCursor !== null || coverage.complete) || encoder.encode(JSON.stringify(result)).byteLength > (expected.maxBytes ?? READING_DIAGNOSTIC_MAX_FIND_BYTES)) return invalid()
  return result
}


/** The raw owner Host is checked before an aggregate service wraps its external route. */
export function parseReadingDiagnosticSourceFind(value: unknown, request: ReadingDiagnosticFindParams): ReadingDiagnosticFindResult {
  const result = parseReadingDiagnosticFindResult(value, request)
  if (result.records.some(record => record.scope.hostId !== request.hostId)) return invalid()
  return result
}

/** The exact Core-owner reply at the Hosted wire boundary, independent of aggregate RPC presentation. */
export function parseReadingDiagnosticSourceRead(value: unknown, request: ReadingDiagnosticExactTarget): DiagnosticEvidenceRead<ReadingDiagnosticExactTarget, ReadingDiagnosticRecord> {
  const p = object(value, ['target', 'recordRef', 'readAuthority', 'authorityStatus', 'availability', 'data', 'persistence', 'scope', 'observedAt', 'readAt', 'completeness', 'raw', 'issue'])
  const target = parseReadingDiagnosticTarget(p.target), expected = parseReadingDiagnosticTarget(request)
  if (!('logId' in target) || !('logId' in expected) || target.hostId !== expected.hostId || target.logId !== expected.logId ||
    target.authority?.kind !== expected.authority?.kind || target.authority?.id !== expected.authority?.id) return invalid()
  const readAuthority = parseAuthority(p.readAuthority), authorityStatus = member(p.authorityStatus, ['verified', 'unconfirmed', 'unavailable'])
  const availability = member(p.availability, DIAGNOSTIC_EVIDENCE_AVAILABILITIES)
  if (p.scope !== 'record' || !['observed', 'unconfirmed', null].includes(p.persistence as string | null)) return invalid()
  const raw = object(p.raw, ['retention', 'returned', 'truncated'])
  if (!['retained', 'not-retained', 'unknown'].includes(String(raw.retention)) || !['withheld', 'unavailable'].includes(String(raw.returned)) || ![true, false, null].includes(raw.truncated as boolean | null)) return invalid()
  let issue: DiagnosticEvidenceRead<ReadingDiagnosticExactTarget, ReadingDiagnosticRecord>['issue'] = null
  if (p.issue !== null) {
    const i = object(p.issue, ['code', 'stage', 'causeCode'])
    if (i.causeCode !== null) return invalid()
    issue = { code: member(i.code, DIAGNOSTIC_EVIDENCE_ISSUE_CODES), stage: member(i.stage, ['read', 'authority', 'projection', 'query']), causeCode: null }
  }
  let recordRef: DiagnosticEvidenceRef | null = null, data: ReadingDiagnosticRecord | null = null
  if (availability === 'found') {
    const r = object(p.recordRef, ['domain', 'logId', 'authority', 'routeHostId'])
    const authority = parseAuthority(r.authority)
    data = parseReadingDiagnosticRecord(p.data)
    if (data.logId !== target.logId || data.scope.owner !== 'core' || data.scope.hostId !== target.hostId || r.domain !== 'reading.lifecycle' || r.logId !== target.logId || r.routeHostId !== target.hostId ||
      authority === null || readAuthority === null || authority.kind !== 'core-reading-observer' || authority.id !== data.scope.ownerInstanceId ||
      authority.kind !== readAuthority.kind || authority.id !== readAuthority.id || authority.lifetime !== 'instance' || readAuthority.lifetime !== 'instance' || authorityStatus !== 'verified' ||
      p.persistence !== 'observed' || raw.returned !== 'withheld' || raw.retention !== 'not-retained') return invalid()
    if (target.authority && (target.authority.kind !== authority.kind || target.authority.id !== authority.id)) return invalid()
    recordRef = { domain: 'reading.lifecycle', logId: target.logId, authority, routeHostId: target.hostId }
  } else if (p.data !== null || p.recordRef !== null) return invalid()
  return { target, recordRef, readAuthority, authorityStatus, availability, data, persistence: p.persistence as 'observed' | 'unconfirmed' | null,
    scope: 'record', observedAt: p.observedAt === null ? null : time(p.observedAt), readAt: time(p.readAt), completeness: member(p.completeness, ['complete', 'partial', 'unknown']),
    raw: { retention: raw.retention as 'retained' | 'not-retained' | 'unknown', returned: raw.returned as 'withheld' | 'unavailable', truncated: raw.truncated as boolean | null }, issue }
}
