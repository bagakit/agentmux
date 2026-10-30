import { AgentMuxError } from './errors.js'
import { createHash } from 'node:crypto'
import { validateAgentPromptInputKey, type AgentPromptInputKey } from './agent-prompt-condition.js'
import {
  parseConversationCheckpoint,
  type ConversationCheckpoint,
  type ConversationWindowBoundary
} from './conversation-changes.js'
import { parseConversationLandmarkRef } from './conversation-landmarks.js'
import { rpcRecord } from './rpc-data.js'
import { isDeepStrictEqual } from 'node:util'
import { moteInputNoticeWire } from './mote-input-notice.js'
export { moteInputNoticeWire } from './mote-input-notice.js'
import type { AgentMuxMessageNotificationStatus } from './agent-message-notification.js'
import { parseAgentInputMoteSource, type AgentInputMoteSource } from './mote-input-source.js'
export { parseAgentInputMoteSource, type AgentInputMoteSource } from './mote-input-source.js'

/** Host-owned snapshot. Later preference edits cannot redirect this original observation. */
export type AgentInputMoteBinding = {
  source: AgentInputMoteSource
  primary: { hostId: string; agentSessionId: string }
  moteRevision: string
  spatialRevision: number
}
export type AgentInputMoteResolver = (input: {
  source: AgentInputMoteSource
  agentSessionId: string
  signal?: AbortSignal
}) => Promise<AgentInputMoteBinding | null>
export type MoteInputOrigin =
  | { kind: 'prompt'; key: AgentPromptInputKey }
  | { kind: 'interaction'; agentSessionId: string; runId: string; operationId: string }
export type MoteInputNoticePhase = 'input' | 'result'
/** One original attempt per authoritative idle opportunity. Only an attempt the input owner proved
 * wholly not applied makes room for the next; unknown attempts are never replaced. */
export function moteInputNoticeId(id: string, phase: MoteInputNoticePhase, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new AgentMuxError('The original Mote notice attempt is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return attempt === 1 ? `${id}-${phase}` : `${id}-${phase}-${attempt}`
}
/** The attempt an original notice ID names for this observation and phase, or null when it names another. */
export function moteInputNoticeAttempt(id: string, phase: MoteInputNoticePhase, notificationId: string): number | null {
  const first = `${id}-${phase}`
  if (notificationId === first) return 1
  if (!notificationId.startsWith(first + '-')) return null
  const suffix = notificationId.slice(first.length + 1), attempt = Number(suffix)
  return Number.isSafeInteger(attempt) && attempt >= 2 && String(attempt) === suffix ? attempt : null
}
/** References and receipts over original owners; never another transcript or task store. */
export type MoteInputObservation = {
  id: string
  revision: number
  origin: MoteInputOrigin
  source: AgentInputMoteSource
  binding: AgentInputMoteBinding | null
  sourceStatus: 'pending' | 'confirmed' | 'unavailable' | 'self'
  issue: string | null
  input:
    'unconfirmed' | 'waiting' | 'terminal-confirmed' | 'admitted' | 'stopped' | 'not-applied' | 'interaction-confirmed'
  confirmedQuestion?: {
    source: { providerId: string; nativeSessionId: string }
    turnId: string
    recordId: string
    questionIds: string[]
  }
  checkpoint?: ConversationCheckpoint
  nativeInput?: {
    source: { providerId: string; nativeSessionId: string }
    turnId: string
    record: ConversationWindowBoundary
  }
  /** Reply records of the exact native turn already read; a later completion read keeps them. */
  replies?: ConversationWindowBoundary[]
  result?:
    | { kind: 'native-turn'; status: 'completed' | 'interrupted' | 'failed'; records: ConversationWindowBoundary[] }
    | {
        kind: 'interaction'
        requestId: string
        responseKind: 'permission' | 'question'
        delivery: string
        nativeAdoption: 'unknown'
        nativeCompleted: boolean
        decision?: string
      }
  notices: Partial<Record<MoteInputNoticePhase, string>>
  /** Phases whose current notice attempt the input owner proved wholly not applied. */
  refused?: MoteInputNoticePhase[]
}
export type MoteInputSubmissionReference = { moteObservationId: string; inputKey: AgentPromptInputKey }
export type MoteInputInspection = {
  observation: MoteInputObservation
  /** Original human text only; images, browser snapshots and permission payloads are not copied. */
  inputText: string | null
  notices: Partial<Record<MoteInputNoticePhase, AgentMuxMessageNotificationStatus>>
}
/** Retained notification bytes need not use today's presentation. Their immutable provenance
 * still names this exact observation; full results and authority come from its original owner. */
export function moteInputNoticeWireMatches(wire: string, value: MoteInputObservation, phase: MoteInputNoticePhase): boolean {
  try {
    const body = JSON.parse(wire) as Record<string, unknown>
    const expected = JSON.parse(moteInputNoticeWire(value, phase)) as Record<string, unknown>
    return body !== null && typeof body === 'object' && !Array.isArray(body) &&
      ['schema', 'observationId', 'phase', 'source', 'memberAgentSessionId', 'origin', 'read']
        .every(field => isDeepStrictEqual(body[field], expected[field]))
  } catch { return false }
}
export function moteInputMember(origin: MoteInputOrigin): string {
  return origin.kind === 'prompt' ? origin.key.agentSessionId : origin.agentSessionId
}
export function moteInputObservationId(origin: MoteInputOrigin): string {
  const tuple =
    origin.kind === 'prompt'
      ? [
          origin.kind,
          origin.key.kind,
          origin.key.agentSessionId,
          origin.key.expectedRun.runId,
          origin.key.kind === 'prompt' ? origin.key.submissionId : origin.key.messageId
        ]
      : [origin.kind, origin.agentSessionId, origin.runId, origin.operationId]
  return 'mote-input-' + createHash('sha256').update(JSON.stringify(tuple)).digest('hex')
}
export function parseMoteInputObservation(value: unknown): MoteInputObservation {
  const fail = (): never => {
    throw new AgentMuxError('The original Mote input observation is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  const text = (value: unknown): string =>
    typeof value === 'string' && value.trim() && !/[\0\r\n]/u.test(value) ? value : fail()
  const obj = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'CONTROL_PROTOCOL_ERROR')
  const p = obj(value, [
    'id',
    'revision',
    'origin',
    'source',
    'binding',
    'sourceStatus',
    'issue',
    'input',
    'confirmedQuestion',
    'checkpoint',
    'nativeInput',
    'replies',
    'result',
    'notices',
    'refused'
  ])
  const rawOrigin = obj(p.origin, ['kind', 'key', 'agentSessionId', 'runId', 'operationId'])
  let origin: MoteInputOrigin
  if (rawOrigin.kind === 'prompt') {
    if (Object.keys(rawOrigin).some((key) => !['kind', 'key'].includes(key))) fail()
    origin = { kind: 'prompt', key: validateAgentPromptInputKey(rawOrigin.key) }
  } else if (rawOrigin.kind === 'interaction' && rawOrigin.key === undefined)
    origin = {
      kind: 'interaction',
      agentSessionId: text(rawOrigin.agentSessionId),
      runId: text(rawOrigin.runId),
      operationId: text(rawOrigin.operationId)
    }
  else return fail()
  const source = parseAgentInputMoteSource(p.source),
    member = moteInputMember(origin)
  if (
    !Number.isSafeInteger(p.revision) ||
    Number(p.revision) < 1 ||
    p.id !== moteInputObservationId(origin) ||
    (p.issue !== null && typeof p.issue !== 'string') ||
    typeof p.input !== 'string' ||
    ![
      'unconfirmed',
      'waiting',
      'terminal-confirmed',
      'admitted',
      'stopped',
      'not-applied',
      'interaction-confirmed'
    ].includes(p.input)
  )
    fail()
  if (
    !['pending', 'confirmed', 'unavailable', 'self'].includes(String(p.sourceStatus)) ||
    (p.sourceStatus === 'confirmed') !== (p.binding !== null)
  )
    fail()
  const notices = obj(p.notices, ['input', 'result'])
  for (const phase of ['input', 'result'] as const)
    if (
      notices[phase] !== undefined &&
      (typeof notices[phase] !== 'string' || moteInputNoticeAttempt(String(p.id), phase, notices[phase]) === null)
    )
      fail()
  let binding: AgentInputMoteBinding | null = null
  if (p.binding !== null) {
    const b = obj(p.binding, ['source', 'primary', 'moteRevision', 'spatialRevision']),
      primary = obj(b.primary, ['hostId', 'agentSessionId'])
    const boundSource = parseAgentInputMoteSource(b.source)
    if (
      !isDeepStrictEqual(boundSource, source) ||
      !Number.isSafeInteger(b.spatialRevision) ||
      Number(b.spatialRevision) < 0
    )
      fail()
    binding = {
      source: boundSource,
      primary: { hostId: text(primary.hostId), agentSessionId: text(primary.agentSessionId) },
      moteRevision: text(b.moteRevision),
      spatialRevision: Number(b.spatialRevision)
    }
  }
  const boundary = (value: unknown): ConversationWindowBoundary => {
    const b = obj(value, ['record', 'revision']),
      record = parseConversationLandmarkRef(b.record)
    if (record.agentSessionId !== member || record.hostId !== 'local' || record.source.kind !== 'native') fail()
    return { record, revision: text(b.revision) }
  }
  const result: MoteInputObservation = {
    id: String(p.id),
    revision: Number(p.revision),
    origin,
    source,
    binding,
    sourceStatus: p.sourceStatus as MoteInputObservation['sourceStatus'],
    issue: p.issue as string | null,
    input: p.input as MoteInputObservation['input'],
    notices: notices as MoteInputObservation['notices']
  }
  if (p.refused !== undefined) {
    if (
      !Array.isArray(p.refused) ||
      !p.refused.length ||
      new Set(p.refused).size !== p.refused.length ||
      p.refused.some((phase) => (phase !== 'input' && phase !== 'result') || !result.notices[phase as MoteInputNoticePhase])
    )
      fail()
    result.refused = [...(p.refused as MoteInputNoticePhase[])]
  }
  if (p.confirmedQuestion !== undefined) {
    const q = obj(p.confirmedQuestion, ['source', 'turnId', 'recordId', 'questionIds']),
      qs = obj(q.source, ['providerId', 'nativeSessionId'])
    if (origin.kind !== 'prompt' || !Array.isArray(q.questionIds) || !q.questionIds.length) fail()
    result.confirmedQuestion = {
      source: { providerId: text(qs.providerId), nativeSessionId: text(qs.nativeSessionId) },
      turnId: text(q.turnId),
      recordId: text(q.recordId),
      questionIds: (q.questionIds as unknown[]).map(text)
    }
  }
  if (p.checkpoint !== undefined) {
    if (origin.kind !== 'prompt') fail()
    result.checkpoint = parseConversationCheckpoint(p.checkpoint, { hostId: 'local', agentSessionId: member })
  }
  if (p.nativeInput !== undefined) {
    const n = obj(p.nativeInput, ['source', 'turnId', 'record']),
      ns = obj(n.source, ['providerId', 'nativeSessionId']),
      record = boundary(n.record)
    if (
      origin.kind !== 'prompt' ||
      record.record.source.kind !== 'native' ||
      record.record.source.providerId !== ns.providerId ||
      record.record.source.nativeSessionId !== ns.nativeSessionId
    )
      fail()
    result.nativeInput = {
      source: { providerId: text(ns.providerId), nativeSessionId: text(ns.nativeSessionId) },
      turnId: text(n.turnId),
      record
    }
  }
  const sameNativeSource = (record: ConversationWindowBoundary) =>
    record.record.source.kind === 'native' &&
    record.record.source.providerId === result.nativeInput?.source.providerId &&
    record.record.source.nativeSessionId === result.nativeInput?.source.nativeSessionId
  if (p.replies !== undefined) {
    if (
      !result.nativeInput ||
      p.result !== undefined ||
      !Array.isArray(p.replies) ||
      !p.replies.length
    )
      fail()
    const replies = (p.replies as unknown[]).map(boundary)
    if (
      replies.some((record) => !sameNativeSource(record)) ||
      new Set(replies.map((record) => JSON.stringify(record.record))).size !== replies.length
    )
      fail()
    result.replies = replies
  }
  if (p.result !== undefined) {
    const r = obj(p.result, [
      'kind',
      'status',
      'records',
      'requestId',
      'responseKind',
      'delivery',
      'nativeAdoption',
      'nativeCompleted',
      'decision'
    ])
    if (r.kind === 'native-turn') {
      if (
        Object.keys(r).some((key) => !['kind', 'status', 'records'].includes(key)) ||
        origin.kind !== 'prompt' ||
        !result.nativeInput ||
        !['completed', 'interrupted', 'failed'].includes(String(r.status)) ||
        !Array.isArray(r.records) ||
        !r.records.length
      )
        fail()
      const records = (r.records as unknown[]).map(boundary)
      if (records.some((record) => !sameNativeSource(record))) fail()
      result.result = { kind: 'native-turn', status: r.status as 'completed' | 'interrupted' | 'failed', records }
    } else if (r.kind === 'interaction') {
      if (
        origin.kind !== 'interaction' ||
        r.status !== undefined ||
        r.records !== undefined ||
        !['permission', 'question'].includes(String(r.responseKind)) ||
        !['bytes-accepted', 'hook-written', 'acp-acknowledged'].includes(String(r.delivery)) ||
        r.nativeAdoption !== 'unknown' ||
        typeof r.nativeCompleted !== 'boolean' ||
        (r.decision !== undefined && r.responseKind !== 'permission')
      )
        fail()
      result.result = {
        kind: 'interaction',
        requestId: text(r.requestId),
        responseKind: r.responseKind as 'permission' | 'question',
        delivery: String(r.delivery),
        nativeAdoption: 'unknown',
        nativeCompleted: r.nativeCompleted as boolean,
        ...(r.decision === undefined ? {} : { decision: text(r.decision) })
      }
    } else fail()
  }
  return structuredClone(result)
}

/** A phase still owes the primary a notice: none was prepared, or its current attempt was proven
 * wholly not applied. Unknown attempts belong to their delivery owner. */
export function moteInputNoticeOwed(record: MoteInputObservation, phase: MoteInputNoticePhase): boolean {
  const current = record.notices[phase]
  if (!current) return true
  if (!record.refused?.includes(phase)) return false
  return true
}

/** Only outstanding coordination, not historical inputs, participates in invalidations.
 * Once a notification has its own original key, its existing delivery owner takes over. */
export function moteInputNeedsObservation(record: MoteInputObservation): boolean {
  if (!record.binding || record.binding.primary.hostId !== 'local')
    return ['unconfirmed', 'waiting'].includes(record.input)
  if (['stopped', 'not-applied'].includes(record.input)) return false
  if (record.origin.kind === 'interaction') return moteInputNoticeOwed(record, 'result')
  return (
    moteInputNoticeOwed(record, 'input') ||
    Boolean(record.checkpoint && !record.result) ||
    Boolean(record.result && moteInputNoticeOwed(record, 'result'))
  )
}
