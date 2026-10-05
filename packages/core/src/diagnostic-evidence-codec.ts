import { diagnosticCauseCode, DELIVERY_EVIDENCE_STAGES } from './delivery-evidence-reader.js'
import { DIAGNOSTIC_EVIDENCE_DEFAULT_BUDGET, DIAGNOSTIC_EVIDENCE_AVAILABILITIES,
  DIAGNOSTIC_EVIDENCE_ISSUE_CODES, DIAGNOSTIC_EVIDENCE_RELATION_KINDS, DIAGNOSTIC_EVIDENCE_BASIS_KINDS } from '@agentmux/diagnostic-evidence'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseDeliveryAttempt, parseDeliveryInputObservation, validateDeliveryLogId } from './delivery-attempt.js'
import type { AgentMuxDiagnosticEvidenceInspectParams, AgentMuxDiagnosticEvidenceResult, AgentMuxDiagnosticEvidenceTarget } from './diagnostic-evidence.js'

const bad = (code = 'CONTROL_PROTOCOL_ERROR'): never => { throw new AgentMuxError('Diagnostic evidence does not satisfy its public contract.', code) }
const member = (v: unknown, values: readonly unknown[]) => { if (!values.includes(v)) bad() }
const text = (v: unknown, nullable = false) => {
  if (nullable && v === null) return
  if (typeof v !== 'string' || !v || /[\0\r\n]/u.test(v) || Buffer.byteLength(v) > 512) bad()
}
const number = (v: unknown, nullable = false) => { if (!(nullable && v === null) && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) bad() }
const object = (v: unknown, keys: readonly string[]) => {
  const r = rpcRecord(v, keys, 'CONTROL_PROTOCOL_ERROR')
  if (keys.some(key => !Object.hasOwn(r, key))) bad()
  return r
}
function array(v: unknown, max: number, consume: (v: unknown) => void) {
  if (!Array.isArray(v) || v.length > max) bad()
  for (const item of v as unknown[]) consume(item)
}
function code(v: unknown) { if (v !== null && diagnosticCauseCode(v) !== v) bad() }
function authority(v: unknown) {
  if (v === null) return
  const r = object(v, ['kind', 'id', 'lifetime']); text(r.kind); text(r.id); member(r.lifetime, ['durable', 'instance', 'unknown'])
}
function ref(v: unknown) {
  const r = object(v, ['domain', 'logId', 'authority', 'routeHostId']); text(r.domain); validateDeliveryLogId(r.logId); authority(r.authority); text(r.routeHostId, true)
}
function issue(v: unknown) {
  if (v === null) return
  const r = object(v, ['code', 'stage', 'causeCode']); member(r.code, DIAGNOSTIC_EVIDENCE_ISSUE_CODES)
  member(r.stage, ['read', 'authority', 'projection', 'query']); code(r.causeCode)
}
export function parseDiagnosticEvidenceParams(value: unknown): AgentMuxDiagnosticEvidenceInspectParams {
  try {
    const p = rpcRecord(value, ['target', 'includeRaw', 'includeRelated', 'budget'])
    for (const key of ['includeRaw', 'includeRelated']) if (p[key] !== undefined && typeof p[key] !== 'boolean') bad()
    if (p.target !== undefined) parseTarget(p.target)
    if (p.budget !== undefined) {
      const b = rpcRecord(p.budget, Object.keys(DIAGNOSTIC_EVIDENCE_DEFAULT_BUDGET))
      for (const key of Object.keys(b) as Array<keyof typeof DIAGNOSTIC_EVIDENCE_DEFAULT_BUDGET>) {
        const v = b[key]
        if (!Number.isSafeInteger(v) || (v as number) < (key === 'maxDepth' ? 0 : key === 'maxBytes' ? 4096 : 1) ||
          (v as number) > DIAGNOSTIC_EVIDENCE_DEFAULT_BUDGET[key]) bad()
      }
    }
    if (!p.target && (p.includeRaw !== undefined || p.includeRelated !== undefined || p.budget !== undefined)) bad()
    return p as AgentMuxDiagnosticEvidenceInspectParams
  } catch { return bad('INVALID_CONTROL_REQUEST') }
}
function parseTarget(v: unknown): AgentMuxDiagnosticEvidenceTarget {
  const p = rpcRecord(v)
  if (p.domain === 'delivery.client' || p.domain === 'delivery.core') {
    rpcRecord(p, ['domain', 'hostId', 'logId', 'authority']); text(p.hostId); validateDeliveryLogId(p.logId)
    if (p.authority !== undefined) { const a = object(p.authority, ['kind', 'id']); text(a.kind); text(a.id) }
  } else if (p.domain === 'native-recorder-failure') {
    object(p, ['domain', 'hostId', 'agentSessionId', 'runId']); text(p.hostId); text(p.agentSessionId); text(p.runId)
  } else bad()
  if (Buffer.byteLength(JSON.stringify(p)) > 1024) bad()
  return p as AgentMuxDiagnosticEvidenceTarget
}
function delivery(v: unknown, includeRaw: boolean) {
  const p = object(v, ['kind', 'source', 'agentSessionId', 'operationId', 'hostId', 'expectedRunId', 'afterSubmissionId',
    'execution', 'startedAt', 'failedAt', 'stage', 'error', 'coreLogId', 'observation', 'reporter', 'original', 'missingEvidence'])
  member(p.kind, ['delivery']); member(p.source, ['core', 'client'])
  for (const key of ['agentSessionId', 'operationId', 'hostId', 'expectedRunId', 'afterSubmissionId', 'coreLogId']) text(p[key], true)
  member(p.execution, ['default', 'immediate', null]); number(p.startedAt); number(p.failedAt); member(p.stage, [...DELIVERY_EVIDENCE_STAGES, null])
  const e = object(p.error, ['code', 'causeCodes', 'controlFailure']); code(e.code); array(e.causeCodes, 8, code)
  if (e.controlFailure !== null) {
    const c = object(e.controlFailure, ['disposition', 'confirmedInputBytes'])
    member(c.disposition, ['not_applied', 'unknown']); number(c.confirmedInputBytes, true)
  }
  if (p.original !== null) { if (!includeRaw) bad(); parseDeliveryAttempt(p.original) }
  if (p.observation !== null) { if (p.source !== 'core') bad(); parseDeliveryInputObservation(p.observation) }
  if (p.reporter !== null) {
    if (p.source !== 'client') bad()
    const reporter = object(p.reporter, ['kind', 'receivedAt', 'routeHostId'])
    member(reporter.kind, ['user', 'device']); number(reporter.receivedAt); text(reporter.routeHostId)
  }
  array(p.missingEvidence, 1, item => { const r = object(item, ['source', 'availability']); member(r.source, ['native-recorder-first-failure']); member(r.availability, ['not-exposed']) })
}

/** Only the actual JSON-RPC boundary needs runtime validation; readers remain ordinary typed code. */
export function parseDiagnosticEvidenceResult(value: unknown, request: unknown): AgentMuxDiagnosticEvidenceResult {
  try {
    const params = parseDiagnosticEvidenceParams(request)
    const p = object(value, ['reads', 'relations', 'issues', 'completeness', 'budget', 'capabilities'])
    const limits = { ...DIAGNOSTIC_EVIDENCE_DEFAULT_BUDGET, ...params.budget }
    if (Buffer.byteLength(JSON.stringify(p)) > limits.maxBytes) bad()
    array(p.reads, limits.maxReads, item => {
      const r = object(item, ['target', 'recordRef', 'readAuthority', 'authorityStatus', 'availability', 'data', 'persistence',
        'scope', 'observedAt', 'readAt', 'completeness', 'raw', 'issue'])
      const target = parseTarget(r.target)
      if (r.recordRef !== null) {
        ref(r.recordRef); const original = rpcRecord(r.recordRef)
        if (!('logId' in target) || original.logId !== target.logId || original.domain !== target.domain || original.routeHostId !== target.hostId) bad()
      }
      authority(r.readAuthority); member(r.authorityStatus, ['verified', 'unconfirmed', 'unavailable'])
      member(r.availability, DIAGNOSTIC_EVIDENCE_AVAILABILITIES); member(r.persistence, ['confirmed', 'observed', 'unconfirmed', null])
      member(r.scope, ['record', 'point-observation', 'interval-observation', 'artifact']); number(r.observedAt, true); number(r.readAt)
      member(r.completeness, ['complete', 'partial', 'unknown']); issue(r.issue)
      const raw = object(r.raw, ['retention', 'returned', 'truncated']); member(raw.retention, ['retained', 'not-retained', 'unknown'])
      member(raw.returned, ['included', 'withheld', 'unavailable']); member(raw.truncated, [true, false, null])
      if (!params.includeRaw && raw.returned === 'included') bad()
      if (r.availability === 'found') {
        if (target.domain === 'native-recorder-failure' || r.recordRef === null) bad()
        delivery(r.data, params.includeRaw === true)
        if (rpcRecord(r.data).source !== (target.domain === 'delivery.core' ? 'core' : 'client')) bad()
      } else if (r.data !== null || r.recordRef !== null) bad()
    })
    const reads = p.reads as Array<{ target: AgentMuxDiagnosticEvidenceTarget }>
    if (params.target ? !reads[0] || JSON.stringify(reads[0].target) !== JSON.stringify(params.target) : reads.length) bad()
    array(p.relations, limits.maxReads * 2, item => {
      const r = object(item, ['from', 'to', 'declaredBy', 'kind', 'verification', 'basis']); ref(r.from); ref(r.to); ref(r.declaredBy)
      member(r.kind, DIAGNOSTIC_EVIDENCE_RELATION_KINDS); member(r.verification, ['declared', 'target-matched', 'owner-confirmed', 'unverifiable', 'conflict'])
      array(r.basis, 4, item => { const b = object(item, ['kind', 'refs']); member(b.kind, DIAGNOSTIC_EVIDENCE_BASIS_KINDS); array(b.refs, 4, ref) })
    })
    array(p.issues, 9, issue); member(p.completeness, ['complete', 'partial'])
    const b = object(p.budget, ['maxReads', 'maxDepth', 'maxBytes', 'deadlineMs', 'usedReads', 'usedBytes', 'elapsedMs'])
    for (const key of Object.keys(limits)) if (b[key] !== limits[key as keyof typeof limits]) bad()
    for (const key of ['usedReads', 'usedBytes', 'elapsedMs']) number(b[key])
    if (b.usedReads !== reads.length || b.usedBytes !== Buffer.byteLength(JSON.stringify(p))) bad()
    array(p.capabilities, 8, item => { const c = object(item, ['domain', 'target', 'raw', 'read']); member(c.domain, ['delivery.client', 'delivery.core', 'native-recorder-failure']); member(c.target, ['log-id', 'session-run']); member(c.raw, [true, false]); member(c.read, ['supported', 'not-exposed']) })
    return p as AgentMuxDiagnosticEvidenceResult
  } catch { return bad() }
}
