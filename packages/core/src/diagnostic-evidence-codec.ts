import { parseReadingDiagnosticRecord } from './reading-diagnostic.js'
import { parseStartupDiagnosticRead, parseStartupDiagnosticTarget } from './startup-diagnostic.js'
import { parseReadingDiagnosticTarget, parseReadingDiagnosticFindResult, parseReadingDiagnosticSourceRead } from './reading-diagnostic-query.js'
import { parsePerformanceSceneEvidence } from './performance-scene-evidence.js'
import { parseClientIncidentTarget, parseClientIncidentRecord, parseClientIncidentPage } from './client-incident.js'
import { relatedClientIncidentEvidence } from './client-incident-evidence.js'
import { isDeepStrictEqual } from 'node:util'
import { parseMoteContextEvidenceTarget, parseMoteContextEvidence } from './mote-context-observation.js'
import { parseClientNotificationsTarget, parseClientNotificationsEvidence } from './client-notifications.js'
import { parseToolkitPerformanceFailure } from './toolkit-performance-failure.js'
import { toolkitFailureEvidenceCode, TOOLKIT_FAILURE_EVIDENCE_SIGNALS } from './toolkit-failure-evidence-reader.js'
import { diagnosticCauseCode, DELIVERY_EVIDENCE_STAGES, relatedDeliveryEvidence } from './delivery-evidence-reader.js'
import { DIAGNOSTIC_EVIDENCE_DEFAULT_BUDGET, DIAGNOSTIC_EVIDENCE_AVAILABILITIES,
  DIAGNOSTIC_EVIDENCE_ISSUE_CODES, DIAGNOSTIC_EVIDENCE_RELATION_KINDS, DIAGNOSTIC_EVIDENCE_BASIS_KINDS } from '@agentmux/diagnostic-evidence'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseDeliveryAttempt, parseDeliveryInputObservation, validateDeliveryLogId } from './delivery-attempt.js'
import type { AgentMuxDiagnosticEvidenceInspectParams, AgentMuxDiagnosticEvidenceResult, AgentMuxDiagnosticEvidenceTarget,
  AgentMuxDiagnosticEvidenceRead } from './diagnostic-evidence.js'

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
  if (p.domain === 'agent.startup') return parseStartupDiagnosticTarget(p)
  if (p.domain === 'reading.lifecycle') { const target = parseReadingDiagnosticTarget(p); if (Buffer.byteLength(JSON.stringify(target)) > 1024) bad(); return target }
  if (p.domain === 'delivery.client' || p.domain === 'delivery.core') {
    rpcRecord(p, ['domain', 'hostId', 'logId', 'authority']); text(p.hostId); validateDeliveryLogId(p.logId)
    if (p.authority !== undefined) { const a = object(p.authority, ['kind', 'id']); text(a.kind); text(a.id) }
  } else if (p.domain === 'performance.scene') {
    object(p, ['domain', 'hostId', 'captureId']); text(p.hostId); text(p.captureId)
  } else if (p.domain === 'toolkit.performance-failure') {
    object(p, ['domain', 'hostId', 'executionId']); text(p.hostId); text(p.executionId)
  } else if (p.domain === 'mote.context.client') {
    parseMoteContextEvidenceTarget(p)
  } else if (p.domain === 'client.incident') {
    parseClientIncidentTarget(p)
  } else if (p.domain === 'client.notifications') {
    parseClientNotificationsTarget(p)
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

function toolkit(v: unknown, includeRaw: boolean, executionId: string) {
  const p = object(v, ['kind', 'failure', 'diagnostics', 'original', 'coverage', 'omissions'])
  member(p.kind, ['toolkit-performance-failure']); member(p.coverage, ['latest-only'])
  array(p.omissions, 1, v => member(v, ['raw-query-budget']))
  const failure = parseToolkitPerformanceFailure(p.failure), d = failure.details
  if (failure.executionId !== executionId || d.error.message !== null || d.error.stack !== null || d.bytes !== null || (d.diagnosticOutput?.length ?? 0) !== 0 ||
    (d.error.code !== null && toolkitFailureEvidenceCode(d.error.code) !== d.error.code)) bad()
  if (d.exit?.signal !== null && d.exit?.signal !== undefined) member(d.exit.signal, TOOLKIT_FAILURE_EVIDENCE_SIGNALS)
  if (p.original !== null) { if (!includeRaw || parseToolkitPerformanceFailure(p.original).executionId !== executionId) bad() }
  const diagnostics = object(p.diagnostics, ['captureEnabled', 'failureEvidence', 'droppedWrites', 'persistence', 'issue', 'cleanupIssue'])
  member(diagnostics.captureEnabled, [true, false]); member(diagnostics.failureEvidence, ['none', 'retained', 'included'])
  number(diagnostics.droppedWrites); member(diagnostics.persistence, ['not-requested', 'pending', 'confirmed', 'unconfirmed', 'observed-on-disk'])
  for (const key of ['issue', 'cleanupIssue']) if (diagnostics[key] !== null) {
    const issue = object(diagnostics[key], ['operation', 'code', 'phase'])
    member(issue.operation, ['read-failure', 'write-failure', 'open-run-port', 'stop', 'release', 'remove', 'clear-admission', 'close-result-channel'])
    member(issue.phase, ['before-replace', 'after-replace', null]); if (issue.code !== null && toolkitFailureEvidenceCode(issue.code) !== issue.code) bad()
  }
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
        if (target.domain === 'agent.startup') {
          parseStartupDiagnosticRead(r, target, params.includeRaw === true)
        } else if (target.domain === 'reading.lifecycle') {
          if ('logId' in target) {
            const data = parseReadingDiagnosticRecord(r.data)
            if (data.logId !== target.logId || data.scope.owner !== 'core' || r.recordRef === null || r.scope !== 'record' || raw.returned !== 'withheld') bad()
            // The aggregate wraps only the route; validate the original instance facts unchanged.
            parseReadingDiagnosticSourceRead({ ...r, target: { ...target, hostId: data.scope.hostId },
              recordRef: { ...rpcRecord(r.recordRef), routeHostId: data.scope.hostId } }, { ...target, hostId: data.scope.hostId })
          } else {
            if (r.recordRef !== null || r.scope !== 'interval-observation' || r.persistence !== null || r.observedAt !== null || raw.returned !== 'withheld' || raw.retention !== 'not-retained' || raw.truncated !== false || r.authorityStatus !== 'verified' || r.issue !== null) bad()
            const query = { hostId: target.hostId, ...target.recent,
              maxBytes: Math.min((rpcRecord(r.data).query as { maxBytes: number }).maxBytes, 128 * 1024) }
            if (!Number.isSafeInteger(query.maxBytes) || query.maxBytes < 4096 || query.maxBytes > limits.maxBytes) bad()
            const page = parseReadingDiagnosticFindResult(r.data, query)
            if (page.availability !== 'found') bad()
            if (!isDeepStrictEqual(r.readAuthority, page.authority) || r.completeness !== (page.coverage.complete && !page.issue ? 'complete' : 'partial')) bad()
          }
        } else if (target.domain === 'client.incident') {
          if (raw.returned !== 'withheld' || raw.truncated !== false) bad()
          if ('recent' in target) {
            if (r.recordRef !== null || r.scope !== 'interval-observation') bad()
            const page = parseClientIncidentPage(r.data, target)
            if (target.authority && (!r.readAuthority || target.authority.kind !== rpcRecord(r.readAuthority).kind || target.authority.id !== rpcRecord(r.readAuthority).id)) bad()
            if (page.items.some(item => r.authorityStatus !== 'verified' || !isDeepStrictEqual(item.recordRef.authority, r.readAuthority))) bad()
          } else {
            if (r.recordRef === null || r.scope !== 'record' || raw.retention !== 'retained') bad()
            const data = parseClientIncidentRecord(r.data), recordRef = rpcRecord(r.recordRef)
            if (data.logId !== target.logId || !isDeepStrictEqual(data.authority, recordRef.authority)) bad()
            if (target.authority && (target.authority.kind !== data.authority.kind || target.authority.id !== data.authority.id)) bad()
            if (r.readAuthority !== null && !isDeepStrictEqual(r.readAuthority, data.authority)) bad()
          }
        } else if (target.domain === 'client.notifications') {
          if (r.recordRef !== null || r.readAuthority !== null || r.authorityStatus !== 'unavailable' ||
            r.persistence !== null || r.scope !== 'point-observation' || r.observedAt !== null || raw.truncated !== null) bad()
          const data = parseClientNotificationsEvidence(r.data, target, params.includeRaw === true)
          if (data.items.some(item => item.original !== null) !== (raw.returned === 'included') ||
            raw.returned === 'included' && raw.retention !== 'retained' ||
            r.completeness !== (data.coverage.state === 'partial' || data.omissions.length ? 'partial' : 'complete')) bad()
        } else if (target.domain === 'mote.context.client') {
          if (r.recordRef !== null || r.readAuthority !== null || r.authorityStatus !== 'unavailable' ||
            r.persistence !== null || r.scope !== 'point-observation' || r.observedAt !== null) bad()
          const data = parseMoteContextEvidence(r.data, target, params.includeRaw === true)
          if ((data.original !== null) !== (raw.returned === 'included')) bad()
        } else if (target.domain === 'performance.scene') {
          if (r.recordRef !== null || r.readAuthority !== null || r.authorityStatus !== 'unconfirmed' || r.persistence !== 'observed' || r.scope !== 'artifact' || raw.returned !== 'withheld' || raw.retention !== 'retained' || r.completeness !== 'partial') bad()
          parsePerformanceSceneEvidence(r.data, target.captureId)
        } else if (target.domain === 'toolkit.performance-failure') {
          if (r.recordRef !== null) bad()
          toolkit(r.data, params.includeRaw === true, target.executionId)
        } else {
          if (target.domain === 'native-recorder-failure' || r.recordRef === null) bad()
          delivery(r.data, params.includeRaw === true)
          if (rpcRecord(r.data).source !== (target.domain === 'delivery.core' ? 'core' : 'client')) bad()
        }
      } else if (r.data !== null || r.recordRef !== null) bad()
    })
    const reads = p.reads as AgentMuxDiagnosticEvidenceRead[]
    if (params.target ? !reads[0] || !isDeepStrictEqual(reads[0].target, params.target) : reads.length) bad()
    if (params.target?.domain === 'client.incident') {
      const declared = [{ target: params.target as AgentMuxDiagnosticEvidenceTarget, depth: 0 }]
      const consumed: AgentMuxDiagnosticEvidenceTarget[] = []
      for (const read of reads) {
        const original = declared.find(candidate => isDeepStrictEqual(candidate.target, read.target))
        if (!original || consumed.some(target => isDeepStrictEqual(target, read.target))) return bad()
        consumed.push(read.target)
        if (params.includeRelated !== false && original.depth < limits.maxDepth && read.availability === 'found') {
          declared.push(...[...relatedClientIncidentEvidence(read), ...relatedDeliveryEvidence(read)]
            .map(target => ({ target, depth: original.depth + 1 })))
        }
      }
    }
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
    array(p.capabilities, 14, item => { const c = object(item, ['domain', 'target', 'raw', 'read']); member(c.domain, ['agent.startup', 'delivery.client', 'delivery.core', 'native-recorder-failure', 'toolkit.performance-failure', 'mote.context.client', 'performance.scene', 'reading.lifecycle', 'client.incident', 'client.notifications']); member(c.target, ['log-id', 'recent', 'session-run', 'execution-id', 'mote-context', 'capture-id', 'reading-lifecycle', 'notification-list', 'notification-id']); member(c.raw, [true, false]); member(c.read, ['supported', 'not-exposed'])
      if ((c.domain === 'reading.lifecycle') !== (c.target === 'reading-lifecycle') || c.domain === 'reading.lifecycle' && c.raw !== false || (c.domain === 'mote.context.client') !== (c.target === 'mote-context') || (c.domain === 'performance.scene') !== (c.target === 'capture-id') || c.domain === 'performance.scene' && c.raw !== false) bad()
      if (c.target === 'recent' && !['client.incident', 'agent.startup'].includes(c.domain as string) || c.domain === 'client.incident' && (c.raw !== false || !['log-id', 'recent'].includes(c.target as string))) bad()
      if (c.domain === 'agent.startup' && (!['log-id', 'recent'].includes(c.target as string) || c.raw !== (c.target === 'log-id'))) bad()
      if ((c.domain === 'client.notifications') !== ['notification-list', 'notification-id'].includes(c.target as string) || c.domain === 'client.notifications' && c.raw !== true) bad()
    })
    return p as AgentMuxDiagnosticEvidenceResult
  } catch { return bad() }
}
