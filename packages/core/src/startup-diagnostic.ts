import { isDeepStrictEqual } from 'node:util'
import type { DiagnosticEvidenceAuthority, DiagnosticEvidenceRead, DiagnosticEvidenceRef } from '@agentmux/diagnostic-evidence'
import { AgentMuxError } from './errors.js'
import { isObjectId } from './object-id.js'
import { rpcRecord } from './rpc-data.js'
import { diagnosticCauseCode } from './delivery-evidence-reader.js'
import type { AgentTerminalFrontendObservation, AgentTerminalInitialization } from './agent-terminal-frontend.js'

/** The original semantic owner supplies this identity; a storage path is never authority. */
export type AgentStartupDiagnosticOwner = { authority: DiagnosticEvidenceAuthority; ownerInstanceId: string }
export type AgentStartupDiagnosticTarget =
  | { domain: 'agent.startup'; hostId: string; logId: string; authority?: Pick<DiagnosticEvidenceAuthority, 'kind' | 'id'> }
  | { domain: 'agent.startup'; hostId: string; recent: {
    limit?: number; cursor?: string; since?: number; until?: number; agentSessionId?: string; runId?: string
  } }
export type AgentStartupDiagnosticExactTarget = Extract<AgentStartupDiagnosticTarget, { logId: string }>
export type AgentStartupDiagnosticRecentTarget = Extract<AgentStartupDiagnosticTarget, { recent: unknown }>
export type AgentStartupDiagnosticMaterial = {
  retention: 'retained' | 'not-retained'; originalBytes: number; retainedBytes: number; truncated: boolean; redacted: boolean
}
export type AgentStartupDiagnosticOriginal = { message: string; code: string | number | null }
export type AgentStartupDiagnosticRecord = {
  kind: 'agent-startup'; logId: string; authority: DiagnosticEvidenceAuthority
  ownerInstanceId: string; receivedAt: number; observedAt: number
  hostId: string; agentSessionId: string; runId: string; actorId: string | null; frontendId: string
  lifecycleOperationId: string; continuityOperationId: string | null
  source: 'managed-process'; event: 'unconfirmed' | 'failed' | 'recovered'
  phase: AgentTerminalInitialization['phase']; frontendState: AgentTerminalFrontendObservation['state']
  backendState: AgentTerminalFrontendObservation['backendState']; native: AgentTerminalInitialization['native']
  failure: { step: NonNullable<AgentTerminalInitialization['failure']>['step']; code: string | number | null } | null
  previousLogId: string | null
  /** An exact reference to existing output, not a copy or a promise that every byte is retained. */
  output: { agentSessionId: string; runId: string; coverage: 'not-captured' }
  material: AgentStartupDiagnosticMaterial
  /** Only explicitly requested private failure material. No launch, environment, Prompt or terminal copy. */
  original: AgentStartupDiagnosticOriginal | null
}
export type AgentStartupDiagnosticCoverage = {
  startup: 'loading' | 'ready' | 'unavailable'; history: 'accepted-observations-only'
  retainedRecords: number; retainedBytes: number; pendingWrites: number
  dropped: number; duplicates: number; evicted: number; corrupt: number
  writeFailures: number; indexFailures: number; cleanupFailures: number
  examinedEntries: number; directoryLimitReached: boolean
  /** No recorder can reconstruct the gap before subscription or across an absent owner. */
  observationGaps: 'unknown'; persistenceGap: boolean
}
export type AgentStartupDiagnosticPage = {
  kind: 'agent-startup-page'
  items: Array<{ recordRef: DiagnosticEvidenceRef; observation: Omit<AgentStartupDiagnosticRecord, 'original'>;
    persistence: 'confirmed' | 'observed' | 'unconfirmed' }>
  nextCursor: string | null; coverage: AgentStartupDiagnosticCoverage
}
export type AgentStartupDiagnosticData = AgentStartupDiagnosticRecord | AgentStartupDiagnosticPage
export type AgentStartupDiagnosticRead = DiagnosticEvidenceRead<AgentStartupDiagnosticTarget, AgentStartupDiagnosticData>

const bad = (): never => { throw new AgentMuxError('Startup diagnostic evidence does not satisfy its original contract.', 'CONTROL_PROTOCOL_ERROR') }
const member = (value: unknown, values: readonly unknown[]) => { if (!values.includes(value)) bad() }
const id = (value: unknown, nullable = false) => {
  if (nullable && value === null) return
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 2048 || /[\0\r\n]/u.test(value)) bad()
}
const number = (value: unknown) => { if (!Number.isSafeInteger(value) || (value as number) < 0) bad() }
const exact = (value: unknown, keys: readonly string[]) => {
  const p = rpcRecord(value, keys, 'CONTROL_PROTOCOL_ERROR')
  if (keys.some(key => !Object.hasOwn(p, key))) bad()
  return p
}
export function startupDiagnosticCode(value: unknown): string | number | null {
  if (value === 'AGENT_NATIVE_INITIALIZATION_OBSERVATION_UNCONFIRMED') return value
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : diagnosticCauseCode(value)
}
export function parseStartupDiagnosticAuthority(value: unknown): DiagnosticEvidenceAuthority {
  const p = exact(value, ['kind', 'id', 'lifetime']); id(p.kind); id(p.id); member(p.lifetime, ['durable', 'instance', 'unknown'])
  return p as DiagnosticEvidenceAuthority
}
export function parseStartupDiagnosticTarget(value: unknown): AgentStartupDiagnosticTarget {
  try {
    const p = rpcRecord(value); member(p.domain, ['agent.startup']); id(p.hostId)
    if ('logId' in p) {
      rpcRecord(p, ['domain', 'hostId', 'logId', 'authority']); if (!isObjectId(p.logId)) bad()
      if (p.authority !== undefined) { const a = exact(p.authority, ['kind', 'id']); id(a.kind); id(a.id) }
    } else {
      exact(p, ['domain', 'hostId', 'recent'])
      const q = rpcRecord(p.recent, ['limit', 'cursor', 'since', 'until', 'agentSessionId', 'runId'])
      if (q.limit !== undefined && (!Number.isSafeInteger(q.limit) || (q.limit as number) < 1 || (q.limit as number) > 32)) bad()
      for (const key of ['since', 'until']) if (q[key] !== undefined) number(q[key])
      if (q.since !== undefined && q.until !== undefined && (q.since as number) > (q.until as number)) bad()
      for (const key of ['cursor', 'agentSessionId', 'runId']) if (q[key] !== undefined) id(q[key])
    }
    return structuredClone(p) as AgentStartupDiagnosticTarget
  } catch { throw new AgentMuxError('An exact startup record or bounded original Host recent query is required.', 'INVALID_CONTROL_REQUEST') }
}
const RECORD_KEYS = ['kind', 'logId', 'authority', 'ownerInstanceId', 'receivedAt', 'observedAt', 'hostId', 'agentSessionId', 'runId', 'actorId', 'frontendId',
  'lifecycleOperationId', 'continuityOperationId', 'source', 'event', 'phase', 'frontendState', 'backendState', 'native', 'failure', 'previousLogId', 'output', 'material', 'original'] as const
export function parseStartupDiagnosticRecord(value: unknown, includeRaw: boolean): AgentStartupDiagnosticRecord {
  const p = exact(value, RECORD_KEYS); member(p.kind, ['agent-startup']); if (!isObjectId(p.logId)) bad()
  parseStartupDiagnosticAuthority(p.authority)
  for (const key of ['ownerInstanceId', 'hostId', 'agentSessionId', 'runId', 'frontendId', 'lifecycleOperationId']) id(p[key])
  for (const key of ['actorId', 'continuityOperationId']) id(p[key], true)
  for (const key of ['receivedAt', 'observedAt']) number(p[key])
  if (p.previousLogId !== null && (!isObjectId(p.previousLogId) || p.previousLogId === p.logId)) bad()
  member(p.source, ['managed-process']); member(p.phase, ['unknown', 'failed', 'ready'])
  if (p.event !== (p.phase === 'unknown' ? 'unconfirmed' : p.phase === 'failed' ? 'failed' : 'recovered')) bad()
  if (p.phase === 'ready' && p.previousLogId === null) bad()
  member(p.frontendState, ['starting', 'attached', 'detached', 'unknown']); member(p.backendState, ['running', 'stopping', 'exited', 'unknown'])
  const native = rpcRecord(p.native, ['state', 'sessionId']); member(native.state, ['not-created', 'confirmed', 'unknown'])
  if (native.state === 'confirmed') id(native.sessionId)
  else if ('sessionId' in native) bad()
  if (p.phase === 'ready' && native.state !== 'confirmed') bad()
  if (p.failure !== null) {
    const f = exact(p.failure, ['step', 'code']); member(f.step, ['connection', 'preflight', 'native-session', 'frontend'])
    if (startupDiagnosticCode(f.code) !== f.code) bad()
  }
  const output = exact(p.output, ['agentSessionId', 'runId', 'coverage'])
  if (output.agentSessionId !== p.agentSessionId || output.runId !== p.runId || output.coverage !== 'not-captured') bad()
  const material = exact(p.material, ['retention', 'originalBytes', 'retainedBytes', 'truncated', 'redacted'])
  member(material.retention, ['retained', 'not-retained']); number(material.originalBytes); number(material.retainedBytes)
  member(material.truncated, [true, false]); member(material.redacted, [true, false])
  if ((material.retainedBytes as number) > 8192) bad()
  if (p.original !== null) {
    if (!includeRaw || material.retention !== 'retained' || p.failure === null) bad()
    const raw = exact(p.original, ['message', 'code'])
    if (typeof raw.message !== 'string' || Buffer.byteLength(raw.message) > 4096 ||
      !(raw.code === null || typeof raw.code === 'number' && Number.isSafeInteger(raw.code) || typeof raw.code === 'string' && Buffer.byteLength(raw.code) <= 2048)) bad()
    if (Buffer.byteLength(JSON.stringify(raw)) !== material.retainedBytes) bad()
  }
  if (material.retention === 'not-retained' && (material.retainedBytes !== 0 || p.original !== null)) bad()
  return structuredClone(p) as AgentStartupDiagnosticRecord
}
export function parseStartupDiagnosticCoverage(value: unknown): AgentStartupDiagnosticCoverage {
  const p = exact(value, ['startup', 'history', 'retainedRecords', 'retainedBytes', 'pendingWrites', 'dropped', 'duplicates', 'evicted', 'corrupt',
    'writeFailures', 'indexFailures', 'cleanupFailures', 'examinedEntries', 'directoryLimitReached', 'observationGaps', 'persistenceGap'])
  member(p.startup, ['loading', 'ready', 'unavailable']); member(p.history, ['accepted-observations-only']); member(p.observationGaps, ['unknown'])
  member(p.persistenceGap, [true, false])
  member(p.directoryLimitReached, [true, false])
  for (const key of ['retainedRecords', 'retainedBytes', 'pendingWrites', 'dropped', 'duplicates', 'evicted', 'corrupt', 'writeFailures', 'indexFailures', 'cleanupFailures', 'examinedEntries']) number(p[key])
  return p as AgentStartupDiagnosticCoverage
}
export function parseStartupDiagnosticRead(value: unknown, input: AgentStartupDiagnosticTarget, includeRaw = false): AgentStartupDiagnosticRead {
  const target = parseStartupDiagnosticTarget(input)
  const p = exact(value, ['target', 'recordRef', 'readAuthority', 'authorityStatus', 'availability', 'data', 'persistence', 'scope', 'observedAt', 'readAt', 'completeness', 'raw', 'issue'])
  if (!isDeepStrictEqual(p.target, target)) bad()
  if (p.readAuthority !== null) parseStartupDiagnosticAuthority(p.readAuthority)
  member(p.authorityStatus, ['verified', 'unconfirmed', 'unavailable']); member(p.availability, ['found', 'not-found', 'unavailable', 'corrupt'])
  member(p.persistence, [null, 'confirmed', 'observed', 'unconfirmed']); member(p.scope, ['record', 'interval-observation']); number(p.readAt)
  if (p.observedAt !== null) number(p.observedAt)
  member(p.completeness, ['complete', 'partial', 'unknown'])
  const raw = exact(p.raw, ['retention', 'returned', 'truncated'])
  member(raw.retention, ['retained', 'not-retained', 'unknown']); member(raw.returned, ['included', 'withheld', 'unavailable']); member(raw.truncated, [true, false, null])
  if (!includeRaw && raw.returned === 'included') bad()
  if (p.issue !== null) {
    const issue = exact(p.issue, ['code', 'stage', 'causeCode'])
    if (typeof issue.code !== 'string' || !['DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE', 'DIAGNOSTIC_EVIDENCE_SOURCE_READ_FAILED', 'DIAGNOSTIC_EVIDENCE_SOURCE_CORRUPT', 'DIAGNOSTIC_EVIDENCE_SOURCE_BUSY', 'DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH', 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNAVAILABLE'].includes(issue.code)) bad()
    member(issue.stage, ['read', 'authority', 'query']); if (diagnosticCauseCode(issue.causeCode) !== issue.causeCode) bad()
  }
  if (p.availability !== 'found') {
    if (p.data !== null || p.recordRef !== null) bad()
    return p as AgentStartupDiagnosticRead
  }
  if ('logId' in target) {
    const r = parseStartupDiagnosticRecord(p.data, includeRaw)
    const ref = exact(p.recordRef, ['domain', 'logId', 'authority', 'routeHostId'])
    if (ref.domain !== 'agent.startup' || ref.logId !== target.logId || r.logId !== target.logId || ref.routeHostId !== target.hostId ||
      !isDeepStrictEqual(ref.authority, r.authority) || p.scope !== 'record' || p.observedAt !== r.observedAt ||
      raw.retention !== r.material.retention || raw.truncated !== r.material.truncated || (r.original !== null) !== (raw.returned === 'included')) bad()
    if (target.authority && (target.authority.kind !== r.authority.kind || target.authority.id !== r.authority.id)) bad()
  } else {
    if (p.recordRef !== null || p.scope !== 'interval-observation' || p.persistence !== null || p.observedAt !== null || raw.retention !== 'not-retained' || raw.returned !== 'withheld' || raw.truncated !== false) bad()
    const page = exact(p.data, ['kind', 'items', 'nextCursor', 'coverage']); member(page.kind, ['agent-startup-page']); id(page.nextCursor, true)
    parseStartupDiagnosticCoverage(page.coverage)
    if (!Array.isArray(page.items) || page.items.length > (target.recent.limit ?? 32)) bad()
    const seen = new Set<string>()
    for (const value of page.items as unknown[]) {
      const item = exact(value, ['recordRef', 'observation', 'persistence'])
      const observation = rpcRecord(item.observation, RECORD_KEYS.filter(key => key !== 'original'))
      const r = parseStartupDiagnosticRecord({ ...observation, original: null }, false)
      const ref = exact(item.recordRef, ['domain', 'logId', 'authority', 'routeHostId'])
      if (ref.domain !== 'agent.startup' || ref.logId !== r.logId || ref.routeHostId !== target.hostId ||
        !isDeepStrictEqual(ref.authority, r.authority) || seen.has(r.logId)) bad()
      seen.add(r.logId); member(item.persistence, ['confirmed', 'observed', 'unconfirmed'])
      const q = target.recent
      if (q.agentSessionId && q.agentSessionId !== r.agentSessionId || q.runId && q.runId !== r.runId || q.since !== undefined && r.observedAt < q.since || q.until !== undefined && r.observedAt > q.until) bad()
    }
  }
  return structuredClone(p) as AgentStartupDiagnosticRead
}
