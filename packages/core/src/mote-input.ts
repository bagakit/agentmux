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
import type { AgentMuxMessageNotificationStatus } from './agent-message-notification.js'

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
}
export type MoteInputSubmissionReference = { moteObservationId: string; inputKey: AgentPromptInputKey }
export type MoteInputInspection = {
  observation: MoteInputObservation
  /** Original human text only; images, browser snapshots and permission payloads are not copied. */
  inputText: string | null
  notices: Partial<Record<MoteInputNoticePhase, AgentMuxMessageNotificationStatus>>
}
export function moteInputNoticeWire(value: MoteInputObservation, phase: MoteInputNoticePhase): string {
  return JSON.stringify({
    schema: 'agentmux.mote-input-notice.v1',
    observationId: value.id,
    phase,
    source: value.source,
    memberAgentSessionId: moteInputMember(value.origin),
    origin: value.origin,
    input: value.input,
    ...(value.confirmedQuestion ? { confirmedQuestion: value.confirmedQuestion } : {}),
    ...(phase === 'result' ? { result: value.result } : {}),
    read: {
      method: 'agent.input.observation',
      params: { agentSessionId: moteInputMember(value.origin), observationId: value.id }
    },
    cli: ['amux', 'agent', 'input', 'observation', '--session', moteInputMember(value.origin), '--id', value.id],
    guidance:
      'This is a platform observation, not a new human request or permission. Read the original observation and exact result references before coordinating. Do not repeat the member input. Delivery, native turn outcome, task completion and human acceptance are distinct.'
  })
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
    'result',
    'notices'
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
  for (const phase of ['input', 'result'])
    if (notices[phase] !== undefined && notices[phase] !== `${p.id}-${phase}`) fail()
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
      if (
        records.some(
          (record) =>
            record.record.source.kind !== 'native' ||
            record.record.source.providerId !== result.nativeInput!.source.providerId ||
            record.record.source.nativeSessionId !== result.nativeInput!.source.nativeSessionId
        )
      )
        fail()
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

/** A client-selected original workface. This is a locator, never an observer or authority. */
export type AgentInputMoteSource = {
  spaceId: string
  zoneId: string
  tabId: string
  regionId: string
}

export function parseAgentInputMoteSource(value: unknown): AgentInputMoteSource {
  const fields = ['spaceId', 'zoneId', 'tabId', 'regionId'] as const
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key as (typeof fields)[number])) ||
    fields.some(
      (key) =>
        typeof (value as Record<string, unknown>)[key] !== 'string' ||
        !(value as Record<string, string>)[key]!.trim() ||
        /[\0\r\n]/u.test((value as Record<string, string>)[key]!)
    )
  )
    throw new AgentMuxError('The original Mote input source is invalid.', 'INVALID_CONTROL_REQUEST')
  return Object.fromEntries(fields.map((key) => [key, (value as AgentInputMoteSource)[key]])) as AgentInputMoteSource
}

/** Only outstanding coordination, not historical inputs, participates in invalidations.
 * Once a notification has its own original key, its existing delivery owner takes over. */
export function moteInputNeedsObservation(record: MoteInputObservation): boolean {
  if (!record.binding || record.binding.primary.hostId !== 'local')
    return ['unconfirmed', 'waiting'].includes(record.input)
  if (['stopped', 'not-applied'].includes(record.input)) return false
  if (record.origin.kind === 'interaction') return !record.notices.result
  return (
    !record.notices.input ||
    Boolean(record.checkpoint && !record.result) ||
    Boolean(record.result && !record.notices.result)
  )
}
