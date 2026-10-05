import { isObjectId, mintObjectId } from './object-id.js'
import { AgentMuxError, type AgentMuxControlFailure } from './errors.js'
import { normalizeOperationDevice } from './operation-device.js'
import type { AgentOperationDevice } from './types.js'
import { rpcRecord } from './rpc-data.js'

/** Diagnostics observe Input; they never admit it or replace its operation identity. */
export type DeliveryFailure = {
  name: string
  message: string
  code?: string
  detail?: string
  stack?: string
  controlFailure?: AgentMuxControlFailure
  logId?: string
  cause?: DeliveryFailure
  truncated?: true
}
export type DeliveryAttempt = {
  logId: string
  source: 'core' | 'client'
  agentSessionId: string | null
  operationId: string | null
  /** The client-selected Host, not an inferred owner for another Run. */
  hostId: string | null
  expectedRunId: string | null
  afterSubmissionId: string | null
  conditionAvailable: boolean
  sourceDevice?: AgentOperationDevice
  promptDigest: string | null
  execution: 'default' | 'immediate' | null
  startedAt: number
  failedAt: number
  stage: string
  error: DeliveryFailure
  /** Only the original Core record owns its Input facts. */
  coreLogId?: string
  observation?: {
    source: 'core-session-projection'
    observedAt: number
    runId: string
    submissionId: string | null
    admissionAcknowledged: boolean | null
    payload: DeliveryInputPhase | null
    submit: DeliveryInputPhase | null
  }
  /** Set by the receiving service, never accepted from a client report. */
  reporter?: { kind: 'user' | 'device'; id: string; receivedAt: number; routeHostId: string }
}
export type DeliveryInputPhase = { operationId: string; startByte: number; endByte: number; acknowledged: boolean; notApplied: boolean }
export type DeliveryAttemptLookup = {
  logId: string
  availability: 'found' | 'not-found' | 'unavailable'
  record: DeliveryAttempt | null
  /** Reading a file is not an acknowledgement of a previous directory fsync. */
  persistence: 'confirmed' | 'observed' | 'unconfirmed' | null
  issue: string | null
}

export const newDeliveryLogId = (): string => mintObjectId()

function isDeliveryLogId(value: unknown): value is string {
  return isObjectId(value) || typeof value === 'string' && /^delivery-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
}

export function validateDeliveryLogId(value: unknown): string {
  if (!isDeliveryLogId(value)) {
    throw new AgentMuxError('A delivery log needs its exact diagnostic ID.', 'INVALID_CONTROL_REQUEST')
  }
  return value
}

/** Preserve the actual cause, with explicit bounds rather than a generic replacement. */
export function deliveryFailure(error: unknown, depth = 0): DeliveryFailure {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : null
  let truncated = false
  const text = (input: unknown, limit = 8192): string | undefined => {
    if (typeof input !== 'string') return undefined
    if (input.length > limit) truncated = true
    return input.slice(0, limit)
  }
  const control = value?.controlFailure as AgentMuxControlFailure | undefined
  return {
    name: text(value?.name, 256) ?? 'Error', message: text(value?.message) ?? String(error).slice(0, 8192),
    ...(typeof value?.code === 'string' ? { code: text(value.code, 512)! } : {}),
    ...(typeof value?.detail === 'string' ? { detail: text(value.detail)! } : {}),
    ...(typeof value?.stack === 'string' ? { stack: text(value.stack, 12_288)! } : {}),
    ...(control && ['not_applied', 'unknown'].includes(control.disposition) &&
      (control.confirmedInputBytes === null || Number.isSafeInteger(control.confirmedInputBytes) && control.confirmedInputBytes >= 0)
      ? { controlFailure: { disposition: control.disposition, confirmedInputBytes: control.confirmedInputBytes } } : {}),
    ...(value && isDeliveryLogId(value.logId) ? { logId: value.logId } : {}),
    ...(value?.cause !== undefined && depth < 2 && value.cause !== error ? { cause: deliveryFailure(value.cause, depth + 1) } : {}),
    ...(truncated || value?.cause !== undefined && depth >= 2 ? { truncated: true as const } : {})
  }
}

const fail = (): never => { throw new AgentMuxError('Delivery diagnostic record is malformed.', 'DELIVERY_LOG_CORRUPT') }
const text = (value: unknown, nullable = false, limit = 8192): void => {
  if (nullable && value === null) return
  if (typeof value !== 'string' || value.length > limit) fail()
}
const count = (value: unknown): void => { if (!Number.isSafeInteger(value) || (value as number) < 0) fail() }
function parseFailure(value: unknown, depth = 0): void {
  const f = rpcRecord(value, ['name', 'message', 'code', 'detail', 'stack', 'controlFailure', 'logId', 'cause', 'truncated'])
  text(f.name, false, 256); text(f.message)
  for (const key of ['code', 'detail', 'stack'] as const) if (f[key] !== undefined) text(f[key], false, key === 'stack' ? 12288 : key === 'code' ? 512 : 8192)
  if (f.logId !== undefined) validateDeliveryLogId(f.logId)
  if (f.truncated !== undefined && f.truncated !== true) fail()
  if (f.controlFailure !== undefined) {
    const c = rpcRecord(f.controlFailure, ['disposition', 'confirmedInputBytes'])
    if (!['not_applied', 'unknown'].includes(c.disposition as string)) fail()
    if (c.confirmedInputBytes !== null) count(c.confirmedInputBytes)
  }
  if (f.cause !== undefined) { if (depth >= 2) fail(); parseFailure(f.cause, depth + 1) }
}
export function parseDeliveryAttempt(value: unknown): DeliveryAttempt {
  const p = rpcRecord(value, ['logId', 'source', 'agentSessionId', 'operationId', 'hostId', 'expectedRunId', 'afterSubmissionId',
    'promptDigest', 'conditionAvailable', 'sourceDevice', 'execution', 'startedAt', 'failedAt', 'stage', 'error', 'coreLogId', 'observation', 'reporter'])
  validateDeliveryLogId(p.logId)
  if (p.source !== 'core' && p.source !== 'client') fail()
  for (const key of ['agentSessionId', 'operationId', 'hostId', 'expectedRunId', 'afterSubmissionId', 'promptDigest'] as const) text(p[key], true, 512)
  if (typeof p.conditionAvailable !== 'boolean') fail()
  if (p.sourceDevice !== undefined) normalizeOperationDevice(p.sourceDevice)
  if (![null, 'default', 'immediate'].includes(p.execution as string | null)) fail()
  count(p.startedAt); count(p.failedAt)
  text(p.stage, false, 128); parseFailure(p.error)
  if (p.coreLogId !== undefined) validateDeliveryLogId(p.coreLogId)
  if (p.observation !== undefined) {
    if (p.source !== 'core') fail()
    const o = rpcRecord(p.observation, ['source', 'observedAt', 'runId', 'submissionId', 'admissionAcknowledged', 'payload', 'submit'])
    if (o.source !== 'core-session-projection') fail()
    count(o.observedAt); text(o.runId, false, 512); text(o.submissionId, true, 512)
    if (o.admissionAcknowledged !== null && typeof o.admissionAcknowledged !== 'boolean') fail()
    for (const key of ['payload', 'submit'] as const) if (o[key] !== null) {
      const f = rpcRecord(o[key], ['operationId', 'startByte', 'endByte', 'acknowledged', 'notApplied'])
      text(f.operationId, false, 512); count(f.startByte); count(f.endByte)
      if ((f.endByte as number) < (f.startByte as number) || typeof f.acknowledged !== 'boolean' || typeof f.notApplied !== 'boolean') fail()
    }
  }
  if (p.reporter !== undefined) {
    if (p.source !== 'client') fail()
    const r = rpcRecord(p.reporter, ['kind', 'id', 'receivedAt', 'routeHostId'])
    if (r.kind !== 'user' && r.kind !== 'device') fail()
    text(r.id, false, 512); count(r.receivedAt); text(r.routeHostId, false, 512)
  }
  return p as DeliveryAttempt
}
export function parseDeliveryAttemptLookup(value: unknown, logId: string): DeliveryAttemptLookup {
  const p = rpcRecord(value, ['logId', 'availability', 'record', 'persistence', 'issue'])
  if (p.logId !== validateDeliveryLogId(logId) || !['found', 'not-found', 'unavailable'].includes(p.availability as string) ||
      ![null, 'confirmed', 'observed', 'unconfirmed'].includes(p.persistence as string | null)) fail()
  text(p.issue, true)
  if (p.record !== null) { const record = parseDeliveryAttempt(p.record); if (record.logId !== logId || p.availability !== 'found') fail() }
  else if (p.availability === 'found' || p.persistence !== null) fail()
  return p as DeliveryAttemptLookup
}
