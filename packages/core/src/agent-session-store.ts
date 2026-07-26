import { AgentMuxError } from './errors.js'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { defaultAgentMuxRuntimeDirectory } from './runtime-paths.js'
import { durableWriteFile } from './durable-write.js'
import { normalizeAgentInteractionResponse } from './agent-interaction.js'
import { RISK_TIERS } from './types.js'
import {
  applyAgentTimelineMutation,
  normalizeAgentTimeline,
  normalizeAgentTimelineMutation
} from './session-timeline.js'
import {
  normalizeNativeSessionId,
  normalizeNativeTranscriptPath
} from './agent-native-locator.js'
import type {
  AgentHookReceipt,
  AgentMuxEvidence,
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxPendingInteraction,
  AgentMuxRunRef,
  AgentMuxStoredAgentSession,
  AgentNativeSessionHandle,
  AgentStatus,
  AgentTerminalCapabilityState,
  AgentTerminalPromptDeliveryState,
  AgentTimelineCommit,
  AgentTimelineItem,
  AgentTimelineMutation,
  AgentTimelineSnapshot,
  RiskTier
} from './types.js'

const MAX_STORED_SESSIONS = 256
const MAX_LIFECYCLE_RESERVATIONS = 256
const MAX_UNBOUND_RETIRED_RUNS = 256
const MAX_RETIRED_AGENT_SESSIONS = 256
const MAX_ID_BYTES = 512
const MAX_PATH_BYTES = 16 * 1024
const MAX_RETIRED_RUNS = 16
const MAX_STORE_BYTES = 1024 * 1024
const MAX_TIMELINE_STORE_BYTES = 4 * 1024 * 1024
const LOCK_ATTEMPTS = 100
const LOCK_RETRY_MS = 10

export type AgentMuxRecoverableStopOperation = {
  daemonInstance: string
  operationKey: string
  runId: string
}

type AgentMuxLifecycleReservationBase = {
  reservationId: string
  ownerId: string
  ownerPid: number
  agentSessionId: string
  operationId: string
  expiresAt: number
}

export type AgentMuxLifecycleReservation = AgentMuxLifecycleReservationBase & (
  | { kind: 'create'; expectedRun?: never; stopOperation?: never }
  | { kind: 'resume'; expectedRun: AgentMuxRunRef; stopOperation?: never }
  | {
      kind: 'stop'
      expectedRun: AgentMuxRunRef
      stopOperation: AgentMuxRecoverableStopOperation
    }
)

export type AgentMuxLifecycleClaim = {
  ownerId: string
  ownerPid: number
  now: number
  expiresAt: number
}

export type AgentMuxRetiredAgentSession = {
  agentSessionId: string
  hostId: string
  run: AgentMuxRunRef
  source: 'user'
  observedAt: number
}

export type AgentMuxAgentSessionStore = {
  load(): Promise<readonly unknown[]>
  loadRetiredRuns(): Promise<readonly AgentMuxRunRef[]>
  loadRetiredAgentSessions(): Promise<readonly AgentMuxRetiredAgentSession[]>
  /** Abort must cancel queued or active persistence without a late commit. */
  compareAndSwap(
    expected: AgentMuxStoredAgentSession | null,
    next: AgentMuxStoredAgentSession | null,
    signal?: AbortSignal
  ): Promise<void>
  reserveLifecycle(reservation: AgentMuxLifecycleReservation): Promise<void>
  claimStaleLifecycles(claim: AgentMuxLifecycleClaim): Promise<AgentMuxLifecycleReservation[]>
  releaseLifecycle(
    reservation: AgentMuxLifecycleReservation,
    retiredRuns?: readonly AgentMuxRunRef[]
  ): Promise<void>
  retireRuns(runs: readonly AgentMuxRunRef[]): Promise<void>
  commitLifecycle(
    reservation: AgentMuxLifecycleReservation,
    next: AgentMuxStoredAgentSession | null
  ): Promise<void>
  loadTimeline(agentSessionId: string): Promise<AgentTimelineSnapshot>
  applyTimelineMutation(
    mutation: AgentTimelineMutation,
    signal?: AbortSignal
  ): Promise<AgentTimelineCommit>
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError(`${name} must be an object.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value as Record<string, unknown>
}

function string(value: unknown, name: string, maxBytes = MAX_ID_BYTES): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maxBytes || /[\0\r\n]/.test(value)) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value
}

function text(value: unknown, name: string, maxBytes = MAX_PATH_BYTES): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maxBytes || value.includes('\0')) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value
}

function timestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value as number
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value as number
}

function nextTimelineRevision(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new AgentMuxError(
      'Agent Timeline revision limit reached.',
      'AGENT_TIMELINE_REVISION_LIMIT'
    )
  }
  return current + 1
}

function runRef(value: unknown): AgentMuxRunRef {
  const source = record(value, 'run')
  if (Object.keys(source).length !== 1 || !Object.hasOwn(source, 'runId')) {
    throw new AgentMuxError('run must contain only runId.', 'INVALID_AGENT_SESSION_STORE')
  }
  return {
    runId: string(source.runId, 'run.runId')
  }
}

function recoverableStopOperation(value: unknown): AgentMuxRecoverableStopOperation {
  const source = record(value, 'recoverable Stop operation')
  if (JSON.stringify(Object.keys(source).sort()) !== JSON.stringify([
    'daemonInstance',
    'operationKey',
    'runId'
  ])) {
    throw new AgentMuxError(
      'Recoverable Stop operation must contain its exact identity.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  return {
    daemonInstance: string(source.daemonInstance, 'stopOperation.daemonInstance'),
    operationKey: string(source.operationKey, 'stopOperation.operationKey'),
    runId: string(source.runId, 'stopOperation.runId')
  }
}

function lifecycleReservation(value: unknown): AgentMuxLifecycleReservation {
  const source = record(value, 'lifecycle reservation')
  if (source.kind !== 'create' && source.kind !== 'resume' && source.kind !== 'stop') {
    throw new AgentMuxError('Lifecycle reservation kind is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const expectedRun = source.expectedRun === undefined ? undefined : runRef(source.expectedRun)
  const stopOperation = source.stopOperation === undefined
    ? undefined
    : recoverableStopOperation(source.stopOperation)
  if (
    (source.kind === 'create' && (expectedRun !== undefined || stopOperation !== undefined)) ||
    (source.kind === 'resume' && (expectedRun === undefined || stopOperation !== undefined)) ||
    (
      source.kind === 'stop' &&
      (
        expectedRun === undefined ||
        stopOperation === undefined ||
        stopOperation.runId !== expectedRun.runId
      )
    )
  ) {
    throw new AgentMuxError('Lifecycle reservation expected Run is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const base: AgentMuxLifecycleReservationBase = {
    reservationId: string(source.reservationId, 'reservationId'),
    ownerId: string(source.ownerId, 'ownerId'),
    ownerPid: positiveInteger(source.ownerPid, 'ownerPid'),
    agentSessionId: string(source.agentSessionId, 'agentSessionId'),
    operationId: string(source.operationId, 'operationId'),
    expiresAt: timestamp(source.expiresAt, 'expiresAt')
  }
  if (source.kind === 'create') return { ...base, kind: 'create' }
  if (source.kind === 'resume') return { ...base, kind: 'resume', expectedRun: expectedRun! }
  return { ...base, kind: 'stop', expectedRun: expectedRun!, stopOperation: stopOperation! }
}

function sameSession(
  left: AgentMuxStoredAgentSession | null,
  right: AgentMuxStoredAgentSession | null
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameReservationOwner(
  current: AgentMuxLifecycleReservation,
  requested: AgentMuxLifecycleReservation
): boolean {
  return current.reservationId === requested.reservationId && current.ownerId === requested.ownerId
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function retiredRuns(value: unknown, current: AgentMuxRunRef): AgentMuxRunRef[] {
  if (!Array.isArray(value) || value.length > MAX_RETIRED_RUNS) {
    throw new AgentMuxError('retiredRuns is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const runs = value.map(runRef)
  const ids = new Set<string>()
  for (const run of runs) {
    if (run.runId === current.runId || ids.has(run.runId)) {
      throw new AgentMuxError('retiredRuns contains a conflicting Run.', 'INVALID_AGENT_SESSION_STORE')
    }
    ids.add(run.runId)
  }
  return runs
}

function unboundRetiredRuns(value: unknown): AgentMuxRunRef[] {
  if (!Array.isArray(value) || value.length > MAX_UNBOUND_RETIRED_RUNS) {
    throw new AgentMuxError('Unbound retired Runs are invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const runs = value.map(runRef)
  if (new Set(runs.map((run) => run.runId)).size !== runs.length) {
    throw new AgentMuxError('Unbound retired Runs contain duplicates.', 'INVALID_AGENT_SESSION_STORE')
  }
  return runs
}

function retiredAgentSession(value: unknown): AgentMuxRetiredAgentSession {
  const source = record(value, 'retired Agent Session')
  if (source.source !== 'user') {
    throw new AgentMuxError('Retired Agent Session source is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  return {
    agentSessionId: string(source.agentSessionId, 'retiredAgentSession.agentSessionId'),
    hostId: string(source.hostId, 'retiredAgentSession.hostId'),
    run: runRef(source.run),
    source: 'user',
    observedAt: timestamp(source.observedAt, 'retiredAgentSession.observedAt')
  }
}

function retiredAgentSessions(value: unknown): AgentMuxRetiredAgentSession[] {
  if (!Array.isArray(value) || value.length > MAX_RETIRED_AGENT_SESSIONS) {
    throw new AgentMuxError('Retired Agent Sessions are invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const sessions = value.map(retiredAgentSession)
  if (
    new Set(sessions.map((session) => session.agentSessionId)).size !== sessions.length ||
    new Set(sessions.map((session) => session.run.runId)).size !== sessions.length
  ) {
    throw new AgentMuxError(
      'Retired Agent Sessions contain duplicate identities or Runs.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  return sessions
}

function mergeRetiredRuns(
  current: readonly AgentMuxRunRef[],
  added: readonly AgentMuxRunRef[]
): AgentMuxRunRef[] {
  const merged = new Map(current.map((run) => [run.runId, run]))
  for (const value of added) {
    const run = runRef(value)
    merged.delete(run.runId)
    merged.set(run.runId, run)
  }
  return [...merged.values()].slice(-MAX_UNBOUND_RETIRED_RUNS)
}

function mergeRetiredAgentSessions(
  current: readonly AgentMuxRetiredAgentSession[],
  added: readonly AgentMuxRetiredAgentSession[]
): AgentMuxRetiredAgentSession[] {
  const merged = new Map(current.map((session) => [session.agentSessionId, session]))
  for (const value of added) {
    const session = retiredAgentSession(value)
    merged.delete(session.agentSessionId)
    merged.set(session.agentSessionId, session)
  }
  return [...merged.values()].slice(-MAX_RETIRED_AGENT_SESSIONS)
}

function assertUnboundRetiredRuns(
  sessions: readonly AgentMuxStoredAgentSession[],
  retiredRuns: readonly AgentMuxRunRef[]
): void {
  const bound = new Set(sessions.flatMap((session) => [
    session.run.runId,
    ...session.retiredRuns.map((run) => run.runId)
  ]))
  if (retiredRuns.some((run) => bound.has(run.runId))) {
    throw new AgentMuxError('Unbound retired Run conflicts with an Agent Session.', 'INVALID_AGENT_SESSION_STORE')
  }
}

function assertRetiredAgentSessions(
  sessions: readonly AgentMuxStoredAgentSession[],
  retiredRuns: readonly AgentMuxRunRef[],
  retiredSessions: readonly AgentMuxRetiredAgentSession[]
): void {
  const currentIds = new Set(sessions.map((session) => session.agentSessionId))
  const retiredRunIds = new Set(retiredRuns.map((run) => run.runId))
  if (retiredSessions.some((session) => (
    currentIds.has(session.agentSessionId) || !retiredRunIds.has(session.run.runId)
  ))) {
    throw new AgentMuxError(
      'Retired Agent Session conflicts with current Session or Run truth.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
}

function launchOptionSelection(value: unknown): Record<string, string> {
  const source = record(value, 'launchOptions')
  const entries = Object.entries(source)
  if (entries.length === 0 || entries.length > 32) {
    throw new AgentMuxError('launchOptions is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const selection: Record<string, string> = {}
  for (const [optionId, choiceId] of entries) {
    selection[string(optionId, 'launchOptions option id')] = string(choiceId, `launchOptions.${optionId}`)
  }
  return selection
}

function nativeHandle(value: unknown): AgentNativeSessionHandle {
  const source = record(value, 'nativeHandle')
  if (source.kind === 'provider') {
    const providerId = normalizeNativeSessionId(source.providerId)
    const sessionId = normalizeNativeSessionId(source.sessionId)
    if (!providerId || !sessionId) {
      throw new AgentMuxError('nativeHandle provider locator is invalid.', 'INVALID_AGENT_SESSION_STORE')
    }
    const transcriptPath = source.transcriptPath === undefined
      ? undefined
      : normalizeNativeTranscriptPath(source.transcriptPath)
    if (source.transcriptPath !== undefined && !transcriptPath) {
      throw new AgentMuxError('nativeHandle.transcriptPath is invalid.', 'INVALID_AGENT_SESSION_STORE')
    }
    return {
      kind: 'provider',
      providerId,
      sessionId,
      ...(transcriptPath ? { transcriptPath } : {})
    }
  }
  if (source.kind === 'acp') {
    const adapterId = normalizeNativeSessionId(source.adapterId)
    const sessionId = normalizeNativeSessionId(source.sessionId)
    if (!adapterId || !sessionId) {
      throw new AgentMuxError('nativeHandle ACP locator is invalid.', 'INVALID_AGENT_SESSION_STORE')
    }
    return {
      kind: 'acp',
      adapterId,
      sessionId
    }
  }
  throw new AgentMuxError('nativeHandle.kind is invalid.', 'INVALID_AGENT_SESSION_STORE')
}

function hookReceipt(value: unknown): AgentHookReceipt {
  const source = record(value, 'hookReceipt')
  const eventName = string(source.eventName, 'hookReceipt.eventName')
  const outputCursorBytes = source.outputCursorBytes === undefined
    ? undefined
    : timestamp(source.outputCursorBytes, 'hookReceipt.outputCursorBytes')
  if ((eventName === 'Stop') !== (outputCursorBytes !== undefined)) {
    throw new AgentMuxError(
      'Only native Stop receipts must carry an authoritative output cursor.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  return {
    id: string(source.id, 'hookReceipt.id'),
    providerId: string(source.providerId, 'hookReceipt.providerId'),
    agentSessionId: string(source.agentSessionId, 'hookReceipt.agentSessionId'),
    run: runRef(source.run),
    eventName,
    observedAt: timestamp(source.observedAt, 'hookReceipt.observedAt'),
    ...(outputCursorBytes === undefined ? {} : { outputCursorBytes })
  }
}

function semanticStatus(value: unknown): AgentStatus {
  const source = record(value, 'semanticStatus')
  if (!['working', 'waiting', 'blocked', 'done', 'error'].includes(String(source.state))) {
    throw new AgentMuxError('semanticStatus.state is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (source.source !== 'native-hook' && source.source !== 'acp') {
    throw new AgentMuxError('semanticStatus.source is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const detail = source.detail === undefined
    ? undefined
    : text(source.detail, 'semanticStatus.detail')
  return {
    state: source.state as AgentStatus['state'],
    source: source.source,
    observedAt: timestamp(source.observedAt, 'semanticStatus.observedAt'),
    ...(detail ? { detail } : {})
  }
}

function interactionEvidence(value: unknown): AgentMuxEvidence {
  const source = record(value, 'pendingInteraction.request.evidence')
  if (source.source !== 'native-hook' && source.source !== 'acp') {
    throw new AgentMuxError('Interaction evidence source is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const evidence: AgentMuxEvidence = {
    source: source.source,
    observedAt: timestamp(source.observedAt, 'pendingInteraction.request.evidence.observedAt'),
    run: runRef(source.run)
  }
  if (source.source === 'native-hook') {
    evidence.hookReceiptId = string(
      source.hookReceiptId,
      'pendingInteraction.request.evidence.hookReceiptId'
    )
  } else {
    evidence.acpAdapterId = string(
      source.acpAdapterId,
      'pendingInteraction.request.evidence.acpAdapterId'
    )
    evidence.acpSessionId = string(
      source.acpSessionId,
      'pendingInteraction.request.evidence.acpSessionId'
    )
  }
  return evidence
}

function interactionRequest(value: unknown): AgentMuxInteractionRequest {
  const source = record(value, 'pendingInteraction.request')
  const base = {
    id: string(source.id, 'pendingInteraction.request.id'),
    agentSessionId: string(source.agentSessionId, 'pendingInteraction.request.agentSessionId'),
    evidence: interactionEvidence(source.evidence)
  }
  if (source.kind === 'permission') {
    if (!Array.isArray(source.options) || source.options.length === 0 || source.options.length > 16) {
      throw new AgentMuxError('Permission options are invalid.', 'INVALID_AGENT_SESSION_STORE')
    }
    const options = source.options.map((value, index) => {
      const option = record(value, `pendingInteraction.request.options[${index}]`)
      if (!['allow-once', 'allow-always', 'reject-once', 'reject-always'].includes(String(option.kind))) {
        throw new AgentMuxError('Permission option kind is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      const description = option.description === undefined
        ? undefined
        : text(option.description, `pendingInteraction.request.options[${index}].description`)
      if (option.tier !== undefined && !RISK_TIERS.includes(option.tier as RiskTier)) {
        throw new AgentMuxError('Permission option tier is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      return {
        id: string(option.id, `pendingInteraction.request.options[${index}].id`),
        label: text(option.label, `pendingInteraction.request.options[${index}].label`),
        kind: option.kind as 'allow-once' | 'allow-always' | 'reject-once' | 'reject-always',
        ...(description ? { description } : {}),
        ...(option.tier === undefined ? {} : { tier: option.tier as RiskTier })
      }
    })
    if (new Set(options.map((option) => option.id)).size !== options.length) {
      throw new AgentMuxError('Permission options contain duplicate identifiers.', 'INVALID_AGENT_SESSION_STORE')
    }
    const toolName = source.toolName === undefined
      ? undefined
      : string(source.toolName, 'pendingInteraction.request.toolName')
    const toolInput = source.toolInput === undefined
      ? undefined
      : text(source.toolInput, 'pendingInteraction.request.toolInput')
    return {
      kind: 'permission',
      ...base,
      title: text(source.title, 'pendingInteraction.request.title'),
      options,
      ...(toolName ? { toolName } : {}),
      ...(toolInput ? { toolInput } : {})
    }
  }
  if (source.kind !== 'question' || !Array.isArray(source.questions) || source.questions.length !== 1) {
    throw new AgentMuxError('Question request is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const questions = source.questions.map((value, questionIndex) => {
    const question = record(value, `pendingInteraction.request.questions[${questionIndex}]`)
    if (!Array.isArray(question.options) || question.options.length === 0 || question.options.length > 9) {
      throw new AgentMuxError('Question options are invalid.', 'INVALID_AGENT_SESSION_STORE')
    }
    const title = question.title === undefined
      ? undefined
      : text(question.title, `pendingInteraction.request.questions[${questionIndex}].title`)
    const options = question.options.map((value, optionIndex) => {
      const option = record(value, `pendingInteraction.request.questions[${questionIndex}].options[${optionIndex}]`)
      const description = option.description === undefined
        ? undefined
        : text(option.description, `pendingInteraction.request.questions[${questionIndex}].options[${optionIndex}].description`)
      return {
        id: string(option.id, `pendingInteraction.request.questions[${questionIndex}].options[${optionIndex}].id`),
        label: text(option.label, `pendingInteraction.request.questions[${questionIndex}].options[${optionIndex}].label`),
        ...(description ? { description } : {})
      }
    })
    if (new Set(options.map((option) => option.id)).size !== options.length) {
      throw new AgentMuxError('Question options contain duplicate identifiers.', 'INVALID_AGENT_SESSION_STORE')
    }
    return {
      id: string(question.id, `pendingInteraction.request.questions[${questionIndex}].id`),
      prompt: text(question.prompt, `pendingInteraction.request.questions[${questionIndex}].prompt`),
      options,
      ...(title ? { title } : {})
    }
  })
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new AgentMuxError('Questions contain duplicate identifiers.', 'INVALID_AGENT_SESSION_STORE')
  }
  return { kind: 'question', ...base, questions }
}

function pendingInteraction(value: unknown): AgentMuxPendingInteraction {
  const source = record(value, 'pendingInteraction')
  const request = interactionRequest(source.request)
  if (source.response === undefined) return { request }
  const response = record(source.response, 'pendingInteraction.response')
  const responseValue = interactionResponse(
    response.value,
    request
  )
  const responseDigest = string(response.responseDigest, 'pendingInteraction.response.responseDigest')
  const expectedDigest = createHash('sha256')
    .update(JSON.stringify(responseValue))
    .digest('base64url')
  if (responseDigest !== expectedDigest) {
    throw new AgentMuxError('Interaction response digest is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (typeof response.acknowledged !== 'boolean') {
    throw new AgentMuxError('Interaction response acknowledgement is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const range = record(response.inputByteRange, 'pendingInteraction.response.inputByteRange')
  const startByte = timestamp(range.startByte, 'pendingInteraction.response.inputByteRange.startByte')
  const endByte = timestamp(range.endByte, 'pendingInteraction.response.inputByteRange.endByte')
  if (endByte <= startByte) {
    throw new AgentMuxError('Interaction response byte range is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  return {
    request,
    response: {
      value: responseValue,
      responseDigest,
      operationId: string(response.operationId, 'pendingInteraction.response.operationId'),
      inputByteRange: { startByte, endByte },
      acknowledged: response.acknowledged
    }
  }
}

function interactionResponse(
  value: unknown,
  request: AgentMuxInteractionRequest
): AgentMuxInteractionResponse {
  const source = record(value, 'pendingInteraction.response.value')
  if (source.kind === 'permission') {
    const decision = record(source.decision, 'pendingInteraction.response.value.decision')
    if (decision.outcome !== 'cancelled' && decision.outcome !== 'selected') {
      throw new AgentMuxError('Permission response is invalid.', 'INVALID_AGENT_SESSION_STORE')
    }
    const normalized: AgentMuxInteractionResponse = decision.outcome === 'cancelled'
      ? {
          kind: 'permission',
          requestId: string(source.requestId, 'pendingInteraction.response.value.requestId'),
          decision: { outcome: 'cancelled' }
        }
      : {
          kind: 'permission',
          requestId: string(source.requestId, 'pendingInteraction.response.value.requestId'),
          decision: {
            outcome: 'selected',
            optionId: string(decision.optionId, 'pendingInteraction.response.value.decision.optionId')
          }
        }
    return normalizeAgentInteractionResponse(request, normalized)
  }
  if (source.kind !== 'question') {
    throw new AgentMuxError('Interaction response kind is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const requestId = string(source.requestId, 'pendingInteraction.response.value.requestId')
  if (source.outcome === 'cancelled') {
    return normalizeAgentInteractionResponse(request, { kind: 'question', requestId, outcome: 'cancelled' })
  }
  if (source.outcome !== 'answered' || !Array.isArray(source.answers)) {
    throw new AgentMuxError('Question response is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const answers = source.answers.map((value, index) => {
    const answer = record(value, `pendingInteraction.response.value.answers[${index}]`)
    return {
      questionId: string(answer.questionId, `pendingInteraction.response.value.answers[${index}].questionId`),
      optionId: string(answer.optionId, `pendingInteraction.response.value.answers[${index}].optionId`)
    }
  })
  return normalizeAgentInteractionResponse(request, {
    kind: 'question',
    requestId,
    outcome: 'answered',
    answers
  })
}

function terminalPromptReadinessSource(
  value: unknown,
  name: string
): 'initial-composer' | 'native-stop' {
  if (value !== 'initial-composer' && value !== 'native-stop') {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value
}

function terminalPromptReadiness(
  value: unknown,
  currentRun: AgentMuxRunRef
): NonNullable<AgentMuxStoredAgentSession['terminalPromptReadiness']> {
  const source = record(value, 'terminalPromptReadiness')
  const run = runRef(source.run)
  const readinessSource = terminalPromptReadinessSource(
    source.source,
    'Terminal prompt readiness source'
  )
  const outputCursorBytes = timestamp(
    source.outputCursorBytes,
    'terminalPromptReadiness.outputCursorBytes'
  )
  const readyThroughByte = source.readyThroughByte === undefined
    ? undefined
    : timestamp(source.readyThroughByte, 'terminalPromptReadiness.readyThroughByte')
  const consumedBySubmissionId = source.consumedBySubmissionId === undefined
    ? undefined
    : string(source.consumedBySubmissionId, 'terminalPromptReadiness.consumedBySubmissionId')
  if (
    run.runId !== currentRun.runId ||
    (
      readyThroughByte !== undefined &&
      (readinessSource === 'initial-composer'
        ? readyThroughByte <= outputCursorBytes
        : readyThroughByte < outputCursorBytes)
    ) ||
    (consumedBySubmissionId !== undefined && readyThroughByte === undefined)
  ) {
    throw new AgentMuxError(
      'Terminal prompt readiness does not match its Agent Run boundary.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  return {
    source: readinessSource,
    id: string(source.id, 'terminalPromptReadiness.id'),
    run,
    outputCursorBytes,
    ...(readyThroughByte === undefined ? {} : { readyThroughByte }),
    ...(consumedBySubmissionId === undefined ? {} : { consumedBySubmissionId })
  }
}

function terminalHandshake(
  value: unknown,
  currentRun: AgentMuxRunRef
): NonNullable<AgentMuxStoredAgentSession['terminalHandshake']> {
  const source = record(value, 'terminalHandshake')
  const run = runRef(source.run)
  const inputByteRange = record(source.inputByteRange, 'terminalHandshake.inputByteRange')
  const startByte = timestamp(
    inputByteRange.startByte,
    'terminalHandshake.inputByteRange.startByte'
  )
  const endByte = positiveInteger(
    inputByteRange.endByte,
    'terminalHandshake.inputByteRange.endByte'
  )
  if (
    run.runId !== currentRun.runId ||
    endByte <= startByte ||
    typeof source.acknowledged !== 'boolean'
  ) {
    throw new AgentMuxError(
      'Terminal handshake does not match its Agent Run.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  return {
    run,
    operationId: string(source.operationId, 'terminalHandshake.operationId'),
    inputByteRange: { startByte, endByte },
    acknowledged: source.acknowledged
  }
}

function terminalCapability(
  value: unknown,
  currentRun: AgentMuxRunRef
): AgentTerminalCapabilityState {
  const source = record(value, 'terminalCapability')
  const run = runRef(source.run)
  if (
    source.state !== 'unknown' ||
    source.mode !== 'degraded' ||
    source.reason !== 'handshake-timeout' ||
    run.runId !== currentRun.runId
  ) {
    throw new AgentMuxError(
      'Terminal capability state does not match its Agent Run.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  return {
    state: 'unknown',
    mode: 'degraded',
    reason: 'handshake-timeout',
    run,
    observedAt: timestamp(source.observedAt, 'terminalCapability.observedAt')
  }
}

function terminalPromptDelivery(
  value: unknown,
  currentRun: AgentMuxRunRef
): AgentTerminalPromptDeliveryState {
  const source = record(value, 'terminalPromptDelivery')
  const run = runRef(source.run)
  if (
    source.state !== 'unverified' ||
    source.mode !== 'degraded' ||
    (source.reason !== 'screen-evidence-gap' && source.reason !== 'prompt-render-timeout') ||
    run.runId !== currentRun.runId
  ) {
    throw new AgentMuxError(
      'Terminal prompt delivery state does not match its Agent Run.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  return {
    state: 'unverified',
    mode: 'degraded',
    reason: source.reason,
    submissionId: string(source.submissionId, 'terminalPromptDelivery.submissionId'),
    run,
    observedAt: timestamp(source.observedAt, 'terminalPromptDelivery.observedAt')
  }
}

function terminalInputPhase(
  value: unknown,
  name: string
): NonNullable<AgentMuxStoredAgentSession['terminalPromptSubmission']>['payload'] {
  const source = record(value, name)
  const inputByteRange = record(source.inputByteRange, `${name}.inputByteRange`)
  const startByte = timestamp(inputByteRange.startByte, `${name}.inputByteRange.startByte`)
  const endByte = positiveInteger(inputByteRange.endByte, `${name}.inputByteRange.endByte`)
  if (endByte <= startByte || typeof source.acknowledged !== 'boolean') {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return {
    operationId: string(source.operationId, `${name}.operationId`),
    inputByteRange: { startByte, endByte },
    acknowledged: source.acknowledged
  }
}

function terminalPromptSubmission(
  value: unknown,
  currentRun: AgentMuxRunRef
): NonNullable<AgentMuxStoredAgentSession['terminalPromptSubmission']> {
  const source = record(value, 'terminalPromptSubmission')
  const run = runRef(source.run)
  const payload = terminalInputPhase(source.payload, 'terminalPromptSubmission.payload')
  const submit = terminalInputPhase(source.submit, 'terminalPromptSubmission.submit')
  const outputCursorBytes = timestamp(
    source.outputCursorBytes,
    'terminalPromptSubmission.outputCursorBytes'
  )
  if (
    run.runId !== currentRun.runId ||
    payload.operationId === submit.operationId ||
    payload.inputByteRange.endByte !== submit.inputByteRange.startByte ||
    (submit.acknowledged && !payload.acknowledged)
  ) {
    throw new AgentMuxError(
      'Terminal prompt submission does not match its Agent Run.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  return {
    run,
    submissionId: string(source.submissionId, 'terminalPromptSubmission.submissionId'),
    promptDigest: string(source.promptDigest, 'terminalPromptSubmission.promptDigest'),
    readinessSource: terminalPromptReadinessSource(
      source.readinessSource,
      'terminalPromptSubmission.readinessSource'
    ),
    readinessId: string(
      source.readinessId,
      'terminalPromptSubmission.readinessId'
    ),
    readinessOutputCursorBytes: timestamp(
      source.readinessOutputCursorBytes,
      'terminalPromptSubmission.readinessOutputCursorBytes'
    ),
    readyThroughByte: timestamp(
      source.readyThroughByte,
      'terminalPromptSubmission.readyThroughByte'
    ),
    outputCursorBytes,
    payload,
    submit
  }
}

export function normalizeStoredAgentSession(value: unknown): AgentMuxStoredAgentSession {
  const source = record(value, 'Agent Session')
  if (source.kind !== 'agent') {
    throw new AgentMuxError('Only Agent Sessions may be persisted.', 'INVALID_AGENT_SESSION_STORE')
  }
  const currentRun = runRef(source.run)
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent',
    agentSessionId: string(source.agentSessionId, 'agentSessionId'),
    providerId: string(source.providerId, 'providerId'),
    executorId: string(source.executorId, 'executorId'),
    hostId: string(source.hostId, 'hostId'),
    workspacePath: string(source.workspacePath, 'workspacePath', MAX_PATH_BYTES),
    run: currentRun,
    retiredRuns: retiredRuns(source.retiredRuns, currentRun),
    hookBindingId: string(source.hookBindingId, 'hookBindingId'),
    hookToken: string(source.hookToken, 'hookToken'),
    // 只有 hash 落盘。缺失是合法的（旧记录或尚未激活），故按可选读取——
    // 但一旦有值就必须是字符串，不接受混入别的类型。
    ...(source.capabilityHash === undefined
      ? {}
      : { capabilityHash: string(source.capabilityHash, 'capabilityHash') }),
    outputCursorBytes: timestamp(source.outputCursorBytes, 'outputCursorBytes'),
    createdAt: timestamp(source.createdAt, 'createdAt'),
    updatedAt: timestamp(source.updatedAt, 'updatedAt'),
    ...(source.launchOptions === undefined
      ? {}
      : { launchOptions: launchOptionSelection(source.launchOptions) }),
    ...(source.terminalHandshake === undefined
      ? {}
      : { terminalHandshake: terminalHandshake(source.terminalHandshake, currentRun) }),
    ...(source.terminalCapability === undefined
      ? {}
      : { terminalCapability: terminalCapability(source.terminalCapability, currentRun) }),
    ...(source.terminalPromptReadiness === undefined
      ? {}
      : {
          terminalPromptReadiness: terminalPromptReadiness(
            source.terminalPromptReadiness,
            currentRun
          )
        }),
    ...(source.terminalPromptSubmission === undefined
      ? {}
      : {
          terminalPromptSubmission: terminalPromptSubmission(
            source.terminalPromptSubmission,
            currentRun
          )
        }),
    ...(source.terminalPromptDelivery === undefined
      ? {}
      : { terminalPromptDelivery: terminalPromptDelivery(source.terminalPromptDelivery, currentRun) }),
    ...(source.semanticStatus === undefined ? {} : { semanticStatus: semanticStatus(source.semanticStatus) }),
    ...(source.pendingInteraction === undefined
      ? {}
      : { pendingInteraction: pendingInteraction(source.pendingInteraction) }),
    ...(source.nativeHandle === undefined ? {} : { nativeHandle: nativeHandle(source.nativeHandle) }),
    ...(source.hookReceipt === undefined ? {} : { hookReceipt: hookReceipt(source.hookReceipt) })
  }
  if (session.nativeHandle?.kind === 'provider' && session.nativeHandle.providerId !== session.providerId) {
    throw new AgentMuxError('Native session handle provider does not match the Agent.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (
    session.hookReceipt &&
    (
      session.hookReceipt.providerId !== session.providerId ||
      session.hookReceipt.agentSessionId !== session.agentSessionId ||
      session.hookReceipt.run.runId !== session.run.runId
    )
  ) {
    throw new AgentMuxError('Hook receipt does not match the Agent Session.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (session.semanticStatus && session.semanticStatus.observedAt > session.updatedAt) {
    throw new AgentMuxError('Semantic status is newer than its Agent Session.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (session.terminalCapability && session.terminalCapability.observedAt > session.updatedAt) {
    throw new AgentMuxError(
      'Terminal capability state is newer than its Agent Session.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  if (session.terminalPromptDelivery && session.terminalPromptDelivery.observedAt > session.updatedAt) {
    throw new AgentMuxError(
      'Terminal prompt delivery state is newer than its Agent Session.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  const interaction = session.pendingInteraction?.request
  if (
    interaction &&
    (
      interaction.agentSessionId !== session.agentSessionId ||
      interaction.evidence.run?.runId !== session.run.runId ||
      interaction.evidence.observedAt > session.updatedAt
    )
  ) {
    throw new AgentMuxError('Pending interaction does not match the Agent Session.', 'INVALID_AGENT_SESSION_STORE')
  }
  const submission = session.terminalPromptSubmission
  if (
    submission &&
    (
      submission.readyThroughByte < submission.readinessOutputCursorBytes ||
      (
        submission.readinessSource === 'initial-composer' &&
        submission.readyThroughByte === submission.readinessOutputCursorBytes
      ) ||
      submission.outputCursorBytes < submission.readyThroughByte
    )
  ) {
    throw new AgentMuxError(
      'Terminal prompt submission does not preserve its readiness boundary.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  const readiness = session.terminalPromptReadiness
  if (
    readiness?.consumedBySubmissionId !== undefined &&
    (
      readiness.readyThroughByte === undefined ||
      !submission ||
      submission.submissionId !== readiness.consumedBySubmissionId ||
      submission.readinessId !== readiness.id
    )
  ) {
    throw new AgentMuxError(
      'Consumed terminal prompt readiness does not identify its prompt submission.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  if (
    submission &&
    readiness?.id === submission.readinessId &&
    (
      readiness.source !== submission.readinessSource ||
      readiness.outputCursorBytes !== submission.readinessOutputCursorBytes ||
      readiness.readyThroughByte !== submission.readyThroughByte ||
      readiness.consumedBySubmissionId !== submission.submissionId
    )
  ) {
    throw new AgentMuxError(
      'Terminal prompt submission did not atomically consume its readiness epoch.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  return session
}

function normalizeAgentSessions(values: readonly unknown[]): AgentMuxStoredAgentSession[] {
  if (values.length > MAX_STORED_SESSIONS) {
    throw new AgentMuxError('Agent Session store exceeds its session limit.', 'AGENT_SESSION_STORE_LIMIT')
  }
  const sessions = values.map(normalizeStoredAgentSession)
  const ids = new Set<string>()
  const runs = new Set<string>()
  const nativeHandles = new Set<string>()
  const promptSubmissions = new Set<string>()
  for (const session of sessions) {
    if (ids.has(session.agentSessionId)) {
      throw new AgentMuxError('Agent Session store contains a duplicate id.', 'INVALID_AGENT_SESSION_STORE')
    }
    if (runs.has(session.run.runId)) {
      throw new AgentMuxError('Agent Session store contains a duplicate Run binding.', 'INVALID_AGENT_SESSION_STORE')
    }
    if (session.retiredRuns.some((run) => runs.has(run.runId))) {
      throw new AgentMuxError('Agent Session store contains a conflicting retired Run.', 'INVALID_AGENT_SESSION_STORE')
    }
    const nativeHandleKey = session.nativeHandle?.kind === 'provider'
      ? JSON.stringify(['provider', session.nativeHandle.providerId, session.nativeHandle.sessionId])
      : session.nativeHandle?.kind === 'acp'
        ? JSON.stringify(['acp', session.nativeHandle.adapterId, session.nativeHandle.sessionId])
        : null
    if (nativeHandleKey && nativeHandles.has(nativeHandleKey)) {
      throw new AgentMuxError('Agent Session store contains a duplicate native binding.', 'INVALID_AGENT_SESSION_STORE')
    }
    if (
      session.terminalPromptSubmission &&
      promptSubmissions.has(session.terminalPromptSubmission.submissionId)
    ) {
      throw new AgentMuxError(
        'Agent Session store contains a duplicate prompt operation.',
        'INVALID_AGENT_SESSION_STORE'
      )
    }
    ids.add(session.agentSessionId)
    runs.add(session.run.runId)
    for (const run of session.retiredRuns) runs.add(run.runId)
    if (nativeHandleKey) nativeHandles.add(nativeHandleKey)
    if (session.terminalPromptSubmission) {
      promptSubmissions.add(session.terminalPromptSubmission.submissionId)
    }
  }
  return sessions
}

/**
 * v5 存储是 `JSON.stringify(document, null, 2)`：每个会话对象独占一段，起止花括号固定落在 4 空格缩进，
 * 更深的嵌套缩进更多。据此按缩进把会话分帧——被截断的尾块或被污染的单块只损失自己，完好的邻居原样取出。
 * 这是在当前格式内抢救，不另立一套落盘格式，故不构成版本迁移。
 */
function extractSessionBlocks(content: string): string[] {
  const lines = content.split('\n')
  const start = lines.indexOf('  "sessions": [')
  if (start === -1) return []
  const blocks: string[] = []
  let current: string[] | null = null
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (current === null) {
      if (line === '  ]' || line === '  ],') break
      if (/^ {4}\{$/u.test(line)) current = [line]
      continue
    }
    current.push(line)
    if (/^ {4}\},?$/u.test(line)) {
      blocks.push(current.join('\n').replace(/,$/u, ''))
      current = null
    }
  }
  return blocks
}

/** 从原始文本抢救会话：按缩进分帧后逐块 JSON.parse，撕裂/乱码的块解析失败即跳过。 */
function parseSessionBlocks(content: string): unknown[] {
  const values: unknown[] = []
  for (const block of extractSessionBlocks(content)) {
    try {
      values.push(JSON.parse(block))
    } catch {
      // 撕裂或被污染的块无法成为候选，跳过——它的字节已随整份文件进了隔离文件。
    }
  }
  return values
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 各字段独立抢救：过不了校验的整段字段宁可回退成空，也不让它拖垮整份读取。 */
function safeNormalize<T>(normalize: () => T[], fallback: T[]): T[] {
  try {
    return normalize()
  } catch {
    return fallback
  }
}

/**
 * 逐条规范化候选会话：坏的略过（它的原始字节已随整份文件进了隔离文件），好的保留；
 * 与已保留记录冲突的后来者让位，硬上限照常生效。全有或全无由此变成尽力抢救。
 */
function salvageSessionList(values: readonly unknown[]): AgentMuxStoredAgentSession[] {
  const sessions: AgentMuxStoredAgentSession[] = []
  const ids = new Set<string>()
  const runs = new Set<string>()
  const nativeHandles = new Set<string>()
  const promptSubmissions = new Set<string>()
  for (const value of values) {
    if (sessions.length >= MAX_STORED_SESSIONS) break
    let session: AgentMuxStoredAgentSession
    try {
      session = normalizeStoredAgentSession(value)
    } catch {
      continue
    }
    const nativeHandleKey = session.nativeHandle?.kind === 'provider'
      ? JSON.stringify(['provider', session.nativeHandle.providerId, session.nativeHandle.sessionId])
      : session.nativeHandle?.kind === 'acp'
        ? JSON.stringify(['acp', session.nativeHandle.adapterId, session.nativeHandle.sessionId])
        : null
    if (
      ids.has(session.agentSessionId) ||
      runs.has(session.run.runId) ||
      session.retiredRuns.some((run) => runs.has(run.runId)) ||
      (nativeHandleKey !== null && nativeHandles.has(nativeHandleKey)) ||
      (session.terminalPromptSubmission !== undefined &&
        promptSubmissions.has(session.terminalPromptSubmission.submissionId))
    ) {
      continue
    }
    ids.add(session.agentSessionId)
    runs.add(session.run.runId)
    for (const run of session.retiredRuns) runs.add(run.runId)
    if (nativeHandleKey !== null) nativeHandles.add(nativeHandleKey)
    if (session.terminalPromptSubmission !== undefined) {
      promptSubmissions.add(session.terminalPromptSubmission.submissionId)
    }
    sessions.push(session)
  }
  return sessions
}

export async function loadAgentSessions(
  store: AgentMuxAgentSessionStore
): Promise<AgentMuxStoredAgentSession[]> {
  return normalizeAgentSessions(await store.load())
}

function normalizeLifecycleReservations(
  values: readonly unknown[]
): AgentMuxLifecycleReservation[] {
  if (values.length > MAX_LIFECYCLE_RESERVATIONS) {
    throw new AgentMuxError('Agent Session store exceeds its reservation limit.', 'AGENT_SESSION_STORE_LIMIT')
  }
  const reservations = values.map(lifecycleReservation)
  const ids = new Set<string>()
  const sessions = new Set<string>()
  for (const reservation of reservations) {
    if (ids.has(reservation.reservationId) || sessions.has(reservation.agentSessionId)) {
      throw new AgentMuxError('Agent Session store contains duplicate lifecycle reservations.', 'INVALID_AGENT_SESSION_STORE')
    }
    ids.add(reservation.reservationId)
    sessions.add(reservation.agentSessionId)
  }
  return reservations
}

function assertReservationPrecondition(
  reservation: AgentMuxLifecycleReservation,
  sessions: readonly AgentMuxStoredAgentSession[],
  retiredSessions: readonly AgentMuxRetiredAgentSession[]
): void {
  const current = sessions.find((session) => session.agentSessionId === reservation.agentSessionId)
  if (reservation.kind === 'create') {
    if (current || retiredSessions.some((session) => session.agentSessionId === reservation.agentSessionId)) {
      throw new AgentMuxError(
        `Agent Session already exists: ${reservation.agentSessionId}`,
        'DUPLICATE_AGENT_SESSION'
      )
    }
    return
  }
  if (!current) {
    throw new AgentMuxError(`Unknown Agent Session: ${reservation.agentSessionId}`, 'UNKNOWN_AGENT_SESSION')
  }
  if (current.run.runId !== reservation.expectedRun?.runId) {
    throw new AgentMuxError('Agent Session changed before lifecycle reservation.', 'STALE_AGENT_SESSION')
  }
}

function assertLifecycleCommit(
  reservation: AgentMuxLifecycleReservation,
  next: AgentMuxStoredAgentSession | null
): void {
  if (reservation.kind === 'stop') {
    if (next !== null) {
      throw new AgentMuxError('Stop lifecycle must retire the Agent Session.', 'INVALID_AGENT_SESSION_STORE')
    }
    return
  }
  if (!next || next.agentSessionId !== reservation.agentSessionId) {
    throw new AgentMuxError('Lifecycle commit does not match its Agent Session.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (reservation.kind === 'create') return
  if (
    next.run.runId === reservation.expectedRun?.runId ||
    !next.retiredRuns.some((run) => run.runId === reservation.expectedRun?.runId)
  ) {
    throw new AgentMuxError('Resume lifecycle did not replace and retire the expected Run.', 'INVALID_AGENT_SESSION_STORE')
  }
}

export class AgentMuxMemoryAgentSessionStore implements AgentMuxAgentSessionStore {
  private readonly sessions = new Map<string, AgentMuxStoredAgentSession>()
  private readonly reservations = new Map<string, AgentMuxLifecycleReservation>()
  private retiredRuns: AgentMuxRunRef[] = []
  private retiredAgentSessions: AgentMuxRetiredAgentSession[] = []
  private readonly timelines = new Map<string, AgentTimelineSnapshot>()

  async load(): Promise<readonly unknown[]> {
    return [...this.sessions.values()].map((session) => structuredClone(session))
  }

  async loadRetiredRuns(): Promise<readonly AgentMuxRunRef[]> {
    return this.retiredRuns.map((run) => ({ ...run }))
  }

  async loadRetiredAgentSessions(): Promise<readonly AgentMuxRetiredAgentSession[]> {
    return structuredClone(this.retiredAgentSessions)
  }

  async compareAndSwap(
    expected: AgentMuxStoredAgentSession | null,
    next: AgentMuxStoredAgentSession | null,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted()
    const agentSessionId = expected?.agentSessionId ?? next?.agentSessionId
    if (!agentSessionId || (expected && next && expected.agentSessionId !== next.agentSessionId)) {
      throw new AgentMuxError('Agent Session CAS identity is invalid.', 'INVALID_AGENT_SESSION_STORE')
    }
    const current = this.sessions.get(agentSessionId) ?? null
    if (!sameSession(current, expected)) {
      throw new AgentMuxError('Agent Session changed before persistence completed.', 'STALE_AGENT_SESSION')
    }
    const reservation = this.reservations.get(agentSessionId)
    if (
      reservation &&
      (next === null || expected === null || next.run.runId !== expected.run.runId)
    ) {
      throw new AgentMuxError('Agent Session has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
    }
    if (next) {
      const normalized = normalizeStoredAgentSession(next)
      const values = [...this.sessions.values()].filter((session) => session.agentSessionId !== agentSessionId)
      const sessions = normalizeAgentSessions([...values, normalized])
      assertUnboundRetiredRuns(sessions, this.retiredRuns)
      assertRetiredAgentSessions(sessions, this.retiredRuns, this.retiredAgentSessions)
      this.sessions.set(agentSessionId, structuredClone(normalized))
    } else {
      this.sessions.delete(agentSessionId)
      this.timelines.delete(agentSessionId)
    }
  }

  async reserveLifecycle(value: AgentMuxLifecycleReservation): Promise<void> {
    const reservation = lifecycleReservation(value)
    if (this.reservations.has(reservation.agentSessionId)) {
      throw new AgentMuxError('Agent Session already has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
    }
    if (this.reservations.size >= MAX_LIFECYCLE_RESERVATIONS) {
      throw new AgentMuxError('Agent Session store exceeds its reservation limit.', 'AGENT_SESSION_STORE_LIMIT')
    }
    assertReservationPrecondition(
      reservation,
      [...this.sessions.values()],
      this.retiredAgentSessions
    )
    this.reservations.set(reservation.agentSessionId, structuredClone(reservation))
  }

  async claimStaleLifecycles(claim: AgentMuxLifecycleClaim): Promise<AgentMuxLifecycleReservation[]> {
    const claimed: AgentMuxLifecycleReservation[] = []
    for (const [agentSessionId, reservation] of this.reservations) {
      if (
        reservation.ownerId !== claim.ownerId &&
        reservation.expiresAt > claim.now &&
        processIsAlive(reservation.ownerPid)
      ) continue
      const next = lifecycleReservation({
        ...reservation,
        ownerId: claim.ownerId,
        ownerPid: claim.ownerPid,
        expiresAt: claim.expiresAt
      })
      this.reservations.set(agentSessionId, next)
      claimed.push(structuredClone(next))
    }
    return claimed
  }

  async releaseLifecycle(
    value: AgentMuxLifecycleReservation,
    retiredRuns: readonly AgentMuxRunRef[] = []
  ): Promise<void> {
    const reservation = lifecycleReservation(value)
    const current = this.reservations.get(reservation.agentSessionId)
    if (!current) return
    if (!sameReservationOwner(current, reservation)) {
      throw new AgentMuxError('Lifecycle reservation belongs to another owner.', 'AGENT_SESSION_BUSY')
    }
    const merged = mergeRetiredRuns(this.retiredRuns, retiredRuns)
    assertUnboundRetiredRuns([...this.sessions.values()], merged)
    assertRetiredAgentSessions(
      [...this.sessions.values()],
      merged,
      this.retiredAgentSessions
    )
    this.retiredRuns = merged
    this.reservations.delete(reservation.agentSessionId)
  }

  async retireRuns(runs: readonly AgentMuxRunRef[]): Promise<void> {
    const merged = mergeRetiredRuns(this.retiredRuns, runs)
    assertUnboundRetiredRuns([...this.sessions.values()], merged)
    assertRetiredAgentSessions(
      [...this.sessions.values()],
      merged,
      this.retiredAgentSessions
    )
    this.retiredRuns = merged
  }

  async commitLifecycle(
    value: AgentMuxLifecycleReservation,
    next: AgentMuxStoredAgentSession | null
  ): Promise<void> {
    const reservation = lifecycleReservation(value)
    const currentReservation = this.reservations.get(reservation.agentSessionId)
    if (!currentReservation || !sameReservationOwner(currentReservation, reservation)) {
      throw new AgentMuxError('Lifecycle reservation is no longer current.', 'STALE_AGENT_SESSION')
    }
    assertReservationPrecondition(
      reservation,
      [...this.sessions.values()],
      this.retiredAgentSessions
    )
    const previous = this.sessions.get(reservation.agentSessionId)
    const normalized = next ? normalizeStoredAgentSession(next) : null
    assertLifecycleCommit(reservation, normalized)
    const values = [...this.sessions.values()].filter(
      (session) => session.agentSessionId !== reservation.agentSessionId
    )
    if (normalized) values.push(normalized)
    const sessions = normalizeAgentSessions(values)
    const retiredRuns = reservation.kind === 'stop' && previous
      ? mergeRetiredRuns(this.retiredRuns, [...previous.retiredRuns, previous.run])
      : this.retiredRuns
    const retiredAgentSessions = reservation.kind === 'stop' && previous
      ? mergeRetiredAgentSessions(this.retiredAgentSessions, [{
          agentSessionId: previous.agentSessionId,
          hostId: previous.hostId,
          run: { ...previous.run },
          source: 'user',
          observedAt: Date.now()
        }])
      : this.retiredAgentSessions
    assertUnboundRetiredRuns(sessions, retiredRuns)
    assertRetiredAgentSessions(sessions, retiredRuns, retiredAgentSessions)
    if (normalized) {
      if (reservation.kind === 'create') this.timelines.delete(normalized.agentSessionId)
      this.sessions.set(normalized.agentSessionId, structuredClone(normalized))
    } else {
      this.sessions.delete(reservation.agentSessionId)
      this.timelines.delete(reservation.agentSessionId)
    }
    this.retiredRuns = retiredRuns
    this.retiredAgentSessions = retiredAgentSessions
    this.reservations.delete(reservation.agentSessionId)
  }

  async loadTimeline(agentSessionId: string): Promise<AgentTimelineSnapshot> {
    return structuredClone(this.timelines.get(agentSessionId) ?? {
      agentSessionId,
      revision: 0,
      items: []
    })
  }

  async applyTimelineMutation(
    mutation: AgentTimelineMutation,
    signal?: AbortSignal
  ): Promise<AgentTimelineCommit> {
    signal?.throwIfAborted()
    const canonicalMutation = normalizeAgentTimelineMutation(mutation)
    if (!this.sessions.has(canonicalMutation.agentSessionId)) {
      throw new AgentMuxError(`Unknown Agent Session: ${canonicalMutation.agentSessionId}`, 'UNKNOWN_AGENT_SESSION')
    }
    const current = this.timelines.get(canonicalMutation.agentSessionId) ?? {
      agentSessionId: canonicalMutation.agentSessionId,
      revision: 0,
      items: []
    }
    const next = applyAgentTimelineMutation(
      current.items,
      canonicalMutation
    )
    const changed = JSON.stringify(next) !== JSON.stringify(current.items)
    const commit: AgentTimelineCommit = {
      agentSessionId: canonicalMutation.agentSessionId,
      revision: changed ? nextTimelineRevision(current.revision) : current.revision,
      changed,
      mutation: canonicalMutation
    }
    if (changed) {
      signal?.throwIfAborted()
      this.timelines.set(canonicalMutation.agentSessionId, {
        agentSessionId: canonicalMutation.agentSessionId,
        revision: commit.revision,
        items: next
      })
    } else {
      signal?.throwIfAborted()
    }
    return structuredClone(commit)
  }

}

type AgentSessionStoreDocument = {
  version: 5
  sessions: AgentMuxStoredAgentSession[]
  reservations: AgentMuxLifecycleReservation[]
  retiredRuns: AgentMuxRunRef[]
  retiredAgentSessions: AgentMuxRetiredAgentSession[]
}

type AgentTimelineFileState = {
  agentSessionId: string
  revision: number
  items: AgentTimelineItem[]
  mutationLines: number
  fileBytes: number
  exists: boolean
}

/** JSONL 追加行数或体积越过阈值时整写一次快照，把重放成本重新压回常数。 */
const TIMELINE_COMPACTION_MUTATION_LINES = 256
const TIMELINE_COMPACTION_BYTES = MAX_TIMELINE_STORE_BYTES / 2

function shouldCompactTimeline(timeline: AgentTimelineFileState): boolean {
  return (
    timeline.mutationLines >= TIMELINE_COMPACTION_MUTATION_LINES ||
    timeline.fileBytes >= TIMELINE_COMPACTION_BYTES
  )
}

function parseTimelineSnapshotLine(
  line: string | undefined,
  agentSessionId: string
): { revision: number; items: unknown[] } {
  // 快照行由临时文件加原子 rename 写入，不会被撕裂；解析失败就是损坏，fail-closed。
  let value: unknown
  try {
    value = JSON.parse(line ?? '')
  } catch {
    throw new AgentMuxError('Agent Timeline store is invalid.', 'INVALID_AGENT_TIMELINE_STORE')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError('Agent Timeline store is invalid.', 'INVALID_AGENT_TIMELINE_STORE')
  }
  const snapshot = value as {
    version?: unknown
    agentSessionId?: unknown
    revision?: unknown
    items?: unknown
  }
  if (
    snapshot.version !== 3 ||
    snapshot.agentSessionId !== agentSessionId ||
    !Number.isSafeInteger(snapshot.revision) ||
    (snapshot.revision as number) < 0 ||
    !Array.isArray(snapshot.items)
  ) {
    throw new AgentMuxError('Agent Timeline store is invalid.', 'INVALID_AGENT_TIMELINE_STORE')
  }
  return { revision: snapshot.revision as number, items: snapshot.items }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export function defaultAgentMuxAgentSessionStorePath(): string {
  // The process that owns the durable location (the desktop, which knows Electron userData) tells every
  // other process — including the CLI each Agent runs — where the store lives. Core must not import Electron
  // or re-derive userData, so it learns the path only from this variable. Absent it, fall back to the
  // machine-level runtime temp directory: the same location the daemon socket/state use.
  const injected = process.env.AGENTMUX_AGENT_SESSION_STORE?.trim()
  if (injected) {
    if (!isAbsolute(injected)) {
      throw new AgentMuxError(
        'AGENTMUX_AGENT_SESSION_STORE must be an absolute path.',
        'INVALID_AGENT_SESSION_STORE'
      )
    }
    return resolve(injected)
  }
  return join(defaultAgentMuxRuntimeDirectory(), 'agent-sessions.json')
}

export class AgentMuxFileAgentSessionStore implements AgentMuxAgentSessionStore {
  private tail: Promise<void> = Promise.resolve()
  private lockReleaseFailure: AgentMuxError | null = null

  constructor(readonly path = defaultAgentMuxAgentSessionStorePath()) {}

  async load(): Promise<readonly unknown[]> {
    let result: AgentMuxStoredAgentSession[] = []
    await this.enqueue(async () => {
      const document = await this.read()
      await this.removeOrphanTimelineFiles(document.sessions)
      result = document.sessions.map((session) => structuredClone(session))
    })
    return result
  }

  async loadRetiredRuns(): Promise<readonly AgentMuxRunRef[]> {
    await this.tail
    return (await this.read()).retiredRuns.map((run) => ({ ...run }))
  }

  async loadRetiredAgentSessions(): Promise<readonly AgentMuxRetiredAgentSession[]> {
    await this.tail
    return structuredClone((await this.read()).retiredAgentSessions)
  }

  async compareAndSwap(
    expected: AgentMuxStoredAgentSession | null,
    next: AgentMuxStoredAgentSession | null,
    signal?: AbortSignal
  ): Promise<void> {
    await this.enqueue(async () => {
      signal?.throwIfAborted()
      const agentSessionId = expected?.agentSessionId ?? next?.agentSessionId
      if (!agentSessionId || (expected && next && expected.agentSessionId !== next.agentSessionId)) {
        throw new AgentMuxError('Agent Session CAS identity is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      const document = await this.read(signal)
      const sessions = new Map(document.sessions.map((item) => [item.agentSessionId, item]))
      const current = sessions.get(agentSessionId) ?? null
      if (!sameSession(current, expected)) {
        throw new AgentMuxError('Agent Session changed before persistence completed.', 'STALE_AGENT_SESSION')
      }
      const reservation = document.reservations.find((item) => item.agentSessionId === agentSessionId)
      if (
        reservation &&
        (next === null || expected === null || next.run.runId !== expected.run.runId)
      ) {
        throw new AgentMuxError('Agent Session has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
      }
      if (next) sessions.set(agentSessionId, normalizeStoredAgentSession(next))
      else sessions.delete(agentSessionId)
      const normalized = normalizeAgentSessions([...sessions.values()])
      assertUnboundRetiredRuns(normalized, document.retiredRuns)
      assertRetiredAgentSessions(
        normalized,
        document.retiredRuns,
        document.retiredAgentSessions
      )
      if (next && !expected) await this.removeTimelineFile(agentSessionId)
      await this.write({ ...document, sessions: normalized }, signal)
      if (!next) await this.removeTimelineFile(agentSessionId).catch(() => {})
    }, signal)
  }

  async reserveLifecycle(value: AgentMuxLifecycleReservation): Promise<void> {
    await this.enqueue(async () => {
      const reservation = lifecycleReservation(value)
      const document = await this.read()
      if (document.reservations.some((item) => item.agentSessionId === reservation.agentSessionId)) {
        throw new AgentMuxError('Agent Session already has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
      }
      if (document.reservations.length >= MAX_LIFECYCLE_RESERVATIONS) {
        throw new AgentMuxError('Agent Session store exceeds its reservation limit.', 'AGENT_SESSION_STORE_LIMIT')
      }
      assertReservationPrecondition(
        reservation,
        document.sessions,
        document.retiredAgentSessions
      )
      await this.write({
        ...document,
        reservations: [...document.reservations, reservation]
      })
    })
  }

  async claimStaleLifecycles(claim: AgentMuxLifecycleClaim): Promise<AgentMuxLifecycleReservation[]> {
    let claimed: AgentMuxLifecycleReservation[] = []
    await this.enqueue(async () => {
      const document = await this.read()
      claimed = document.reservations.flatMap((reservation) => {
        if (
          reservation.ownerId !== claim.ownerId &&
          reservation.expiresAt > claim.now &&
          processIsAlive(reservation.ownerPid)
        ) return []
        return [lifecycleReservation({
          ...reservation,
          ownerId: claim.ownerId,
          ownerPid: claim.ownerPid,
          expiresAt: claim.expiresAt
        })]
      })
      if (claimed.length === 0) return
      const claimedById = new Map(claimed.map((reservation) => [reservation.reservationId, reservation]))
      await this.write({
        ...document,
        reservations: document.reservations.map(
          (reservation) => claimedById.get(reservation.reservationId) ?? reservation
        )
      })
    })
    return claimed.map((reservation) => structuredClone(reservation))
  }

  async releaseLifecycle(
    value: AgentMuxLifecycleReservation,
    retiredRuns: readonly AgentMuxRunRef[] = []
  ): Promise<void> {
    await this.enqueue(async () => {
      const reservation = lifecycleReservation(value)
      const document = await this.read()
      const current = document.reservations.find(
        (item) => item.agentSessionId === reservation.agentSessionId
      )
      if (!current) return
      if (!sameReservationOwner(current, reservation)) {
        throw new AgentMuxError('Lifecycle reservation belongs to another owner.', 'AGENT_SESSION_BUSY')
      }
      const mergedRetiredRuns = mergeRetiredRuns(document.retiredRuns, retiredRuns)
      assertUnboundRetiredRuns(document.sessions, mergedRetiredRuns)
      assertRetiredAgentSessions(
        document.sessions,
        mergedRetiredRuns,
        document.retiredAgentSessions
      )
      await this.write({
        ...document,
        retiredRuns: mergedRetiredRuns,
        reservations: document.reservations.filter(
          (item) => item.reservationId !== reservation.reservationId
        )
      })
    })
  }

  async retireRuns(runs: readonly AgentMuxRunRef[]): Promise<void> {
    await this.enqueue(async () => {
      const document = await this.read()
      const retiredRuns = mergeRetiredRuns(document.retiredRuns, runs)
      assertUnboundRetiredRuns(document.sessions, retiredRuns)
      assertRetiredAgentSessions(
        document.sessions,
        retiredRuns,
        document.retiredAgentSessions
      )
      await this.write({
        ...document,
        retiredRuns
      })
    })
  }

  async commitLifecycle(
    value: AgentMuxLifecycleReservation,
    next: AgentMuxStoredAgentSession | null
  ): Promise<void> {
    await this.enqueue(async () => {
      const reservation = lifecycleReservation(value)
      const document = await this.read()
      const currentReservation = document.reservations.find(
        (item) => item.agentSessionId === reservation.agentSessionId
      )
      if (!currentReservation || !sameReservationOwner(currentReservation, reservation)) {
        throw new AgentMuxError('Lifecycle reservation is no longer current.', 'STALE_AGENT_SESSION')
      }
      assertReservationPrecondition(
        reservation,
        document.sessions,
        document.retiredAgentSessions
      )
      const previous = document.sessions.find(
        (session) => session.agentSessionId === reservation.agentSessionId
      )
      const normalized = next ? normalizeStoredAgentSession(next) : null
      assertLifecycleCommit(reservation, normalized)
      const sessions = document.sessions.filter(
        (session) => session.agentSessionId !== reservation.agentSessionId
      )
      if (normalized) sessions.push(normalized)
      const committedSessions = normalizeAgentSessions(sessions)
      const retiredRuns = reservation.kind === 'stop' && previous
        ? mergeRetiredRuns(document.retiredRuns, [...previous.retiredRuns, previous.run])
        : document.retiredRuns
      const retiredAgentSessions = reservation.kind === 'stop' && previous
        ? mergeRetiredAgentSessions(document.retiredAgentSessions, [{
            agentSessionId: previous.agentSessionId,
            hostId: previous.hostId,
            run: { ...previous.run },
            source: 'user',
            observedAt: Date.now()
          }])
        : document.retiredAgentSessions
      assertUnboundRetiredRuns(committedSessions, retiredRuns)
      assertRetiredAgentSessions(committedSessions, retiredRuns, retiredAgentSessions)
      if (reservation.kind === 'create') {
        await this.removeTimelineFile(reservation.agentSessionId)
      }
      await this.write({
        version: 5,
        sessions: committedSessions,
        reservations: document.reservations.filter(
          (item) => item.reservationId !== reservation.reservationId
        ),
        retiredRuns,
        retiredAgentSessions
      })
      if (!normalized) await this.removeTimelineFile(reservation.agentSessionId).catch(() => {})
    })
  }

  async loadTimeline(agentSessionId: string): Promise<AgentTimelineSnapshot> {
    await this.tail
    const timeline = await this.readTimeline(agentSessionId)
    return structuredClone({
      agentSessionId: timeline.agentSessionId,
      revision: timeline.revision,
      items: timeline.items
    })
  }

  async applyTimelineMutation(
    mutation: AgentTimelineMutation,
    signal?: AbortSignal
  ): Promise<AgentTimelineCommit> {
    let result!: AgentTimelineCommit
    await this.enqueue(async () => {
      signal?.throwIfAborted()
      const canonicalMutation = normalizeAgentTimelineMutation(mutation)
      const document = await this.read(signal)
      if (!document.sessions.some((session) => session.agentSessionId === canonicalMutation.agentSessionId)) {
        throw new AgentMuxError(`Unknown Agent Session: ${canonicalMutation.agentSessionId}`, 'UNKNOWN_AGENT_SESSION')
      }
      const timeline = await this.readTimeline(canonicalMutation.agentSessionId, signal)
      const items = applyAgentTimelineMutation(timeline.items, canonicalMutation)
      const changed = JSON.stringify(items) !== JSON.stringify(timeline.items)
      result = {
        agentSessionId: canonicalMutation.agentSessionId,
        revision: changed ? nextTimelineRevision(timeline.revision) : timeline.revision,
        changed,
        mutation: canonicalMutation
      }
      if (!changed) {
        signal?.throwIfAborted()
        return
      }
      // 热路径是 JSONL 追加一行；只有文件缺失或超过 compaction 阈值才整写快照。
      if (!timeline.exists || shouldCompactTimeline(timeline)) {
        await this.writeTimelineSnapshot({
          agentSessionId: canonicalMutation.agentSessionId,
          revision: result.revision,
          items
        }, signal)
      } else {
        await this.appendTimelineMutation(canonicalMutation, signal)
      }
    }, signal)
    return structuredClone(result)
  }

  private async read(signal?: AbortSignal): Promise<AgentSessionStoreDocument> {
    let raw: Buffer
    try {
      signal?.throwIfAborted()
      const metadata = await stat(this.path)
      if (!metadata.isFile() || metadata.size > MAX_STORE_BYTES) {
        throw new AgentMuxError('Agent Session store is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      // 先拿到字节再解析。瞬时读取错误（EACCES/EIO）在此抛出并原样上抛——绝不进入抢救路径，
      // 否则一次权限抖动就会把一份完好的文件截断进降级态。只有「字节到手但内容坏了」才算真损坏。
      raw = await readFile(this.path, { signal })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          version: 5,
          sessions: [],
          reservations: [],
          retiredRuns: [],
          retiredAgentSessions: []
        }
      }
      throw error
    }
    return await this.parseStoreDocument(raw, signal)
  }

  /**
   * 字节到手后的解析与抢救分界：能严格解析就走快路径，绝不留下隔离文件；
   * 一旦是当前格式内的真损坏（撕裂、乱码、单条记录过不了校验），先把原始字节整段隔离，
   * 再尽力救回能读的记录。版本不符按 INVALID 上抛——那是迁移的活，本任务只在 v5 内抢救。
   */
  private async parseStoreDocument(
    raw: Buffer,
    signal?: AbortSignal
  ): Promise<AgentSessionStoreDocument> {
    const text = raw.toString('utf8')
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      // 整份 JSON 都解析不了（尾块被截断、注入了乱码）：按缩进从原始文本里逐块抢救会话。
      await this.quarantineCorruptStore(raw, signal)
      return {
        version: 5,
        sessions: salvageSessionList(parseSessionBlocks(text)),
        reservations: [],
        retiredRuns: [],
        retiredAgentSessions: []
      }
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value as { version?: unknown }).version !== 5
    ) {
      // 版本不符不是损坏，是退役 schema：fail-closed，既不抢救也不隔离，交给不引入迁移层的约束。
      throw new AgentMuxError('Agent Session store is invalid.', 'INVALID_AGENT_SESSION_STORE')
    }
    try {
      return this.strictStoreDocument(value as Record<string, unknown>)
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'AGENT_SESSION_STORE_LIMIT') throw error
      await this.quarantineCorruptStore(raw, signal)
      return this.salvageStoreDocument(value as Record<string, unknown>)
    }
  }

  private strictStoreDocument(document: Record<string, unknown>): AgentSessionStoreDocument {
    if (
      !Array.isArray(document.sessions) ||
      !Array.isArray(document.reservations) ||
      !Array.isArray(document.retiredRuns) ||
      !Array.isArray(document.retiredAgentSessions)
    ) {
      throw new AgentMuxError('Agent Session store is invalid.', 'INVALID_AGENT_SESSION_STORE')
    }
    const sessions = normalizeAgentSessions(document.sessions)
    const retiredRuns = unboundRetiredRuns(document.retiredRuns)
    const retiredSessions = retiredAgentSessions(document.retiredAgentSessions)
    assertUnboundRetiredRuns(sessions, retiredRuns)
    assertRetiredAgentSessions(sessions, retiredRuns, retiredSessions)
    return {
      version: 5,
      sessions,
      reservations: normalizeLifecycleReservations(document.reservations),
      retiredRuns,
      retiredAgentSessions: retiredSessions
    }
  }

  /**
   * v5 文档内的逐字段抢救：会话逐条救，附属层（reservation / 退役 Run / 退役会话）各自独立校验，
   * 过不了的整层回退成空而不是拖垮整份读取。跨层不变量若因抢救而不成立，就把退役层清空以自洽。
   */
  private salvageStoreDocument(document: Record<string, unknown>): AgentSessionStoreDocument {
    const sessions = salvageSessionList(asArray(document.sessions))
    const reservations = safeNormalize(
      () => normalizeLifecycleReservations(asArray(document.reservations)),
      []
    )
    let retiredRuns = safeNormalize(() => unboundRetiredRuns(asArray(document.retiredRuns)), [])
    let retiredSessions = safeNormalize(
      () => retiredAgentSessions(asArray(document.retiredAgentSessions)),
      []
    )
    try {
      assertUnboundRetiredRuns(sessions, retiredRuns)
      assertRetiredAgentSessions(sessions, retiredRuns, retiredSessions)
    } catch {
      retiredRuns = []
      retiredSessions = []
    }
    return { version: 5, sessions, reservations, retiredRuns, retiredAgentSessions: retiredSessions }
  }

  /**
   * 把损坏的原始字节原样落到一个内容寻址的隔离文件（sha256 命名），不静默丢弃——事后可据此诊断。
   * 内容寻址让同一份坏文件被反复读到时只隔离一次，不会堆积。写到旁路文件，与主文件互不干扰。
   */
  private async quarantineCorruptStore(raw: Buffer, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const digest = createHash('sha256').update(raw).digest('base64url').slice(0, 16)
    const path = `${this.path}.corrupt-${digest}`
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await durableWriteFile(path, raw, { mode: 0o600, ...(signal ? { signal } : {}) })
  }


  private async write(document: AgentSessionStoreDocument, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const content = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(content) > MAX_STORE_BYTES) {
      throw new AgentMuxError('Agent Session store exceeds its size limit.', 'AGENT_SESSION_STORE_LIMIT')
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await durableWriteFile(this.path, content, { mode: 0o600, ...(signal ? { signal } : {}) })
  }

  private timelinePath(agentSessionId: string): string {
    const filename = createHash('sha256').update(agentSessionId).digest('base64url')
    return join(dirname(this.path), 'agent-timelines', `${filename}.jsonl`)
  }

  /**
   * Timeline 文件是 JSONL：首行是原子写入的快照（version 3），其后每行一条已生效的 mutation，
   * 加载时按序重放。追加行可能被崩溃撕裂——只容忍**最后一行**解析或重放失败（当它没发生过），
   * 中间行坏了是数据损坏，fail-closed。
   */
  private async readTimeline(
    agentSessionId: string,
    signal?: AbortSignal
  ): Promise<AgentTimelineFileState> {
    const path = this.timelinePath(agentSessionId)
    let content: string
    try {
      signal?.throwIfAborted()
      const metadata = await stat(path)
      if (!metadata.isFile() || metadata.size > MAX_TIMELINE_STORE_BYTES) {
        throw new AgentMuxError('Agent Timeline store is invalid.', 'INVALID_AGENT_TIMELINE_STORE')
      }
      content = await readFile(path, { encoding: 'utf8', signal })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          agentSessionId,
          revision: 0,
          items: [],
          mutationLines: 0,
          fileBytes: 0,
          exists: false
        }
      }
      throw error
    }
    const lines = content.split('\n').filter((line, index) => line !== '' || index === 0)
    const snapshot = parseTimelineSnapshotLine(lines[0], agentSessionId)
    let revision = snapshot.revision
    let items = normalizeAgentTimeline(agentSessionId, snapshot.items)
    let mutationLines = 0
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index]!
      try {
        const mutation = normalizeAgentTimelineMutation(JSON.parse(line))
        if (mutation.agentSessionId !== agentSessionId) {
          throw new AgentMuxError('Agent Timeline store is invalid.', 'INVALID_AGENT_TIMELINE_STORE')
        }
        const next = applyAgentTimelineMutation(items, mutation)
        if (JSON.stringify(next) !== JSON.stringify(items)) revision = nextTimelineRevision(revision)
        items = next
      } catch (error) {
        if (index === lines.length - 1) break
        throw error instanceof AgentMuxError
          ? error
          : new AgentMuxError('Agent Timeline store is invalid.', 'INVALID_AGENT_TIMELINE_STORE')
      }
      mutationLines += 1
    }
    return {
      agentSessionId,
      revision,
      items,
      mutationLines,
      fileBytes: Buffer.byteLength(content),
      exists: true
    }
  }

  private async writeTimelineSnapshot(
    document: { agentSessionId: string; revision: number; items: readonly AgentTimelineItem[] },
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted()
    const content = `${JSON.stringify({ version: 3, ...document })}\n`
    if (Buffer.byteLength(content) > MAX_TIMELINE_STORE_BYTES) {
      throw new AgentMuxError('Agent Timeline store exceeds its size limit.', 'AGENT_TIMELINE_STORE_LIMIT')
    }
    const path = this.timelinePath(document.agentSessionId)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await durableWriteFile(path, content, { mode: 0o600, ...(signal ? { signal } : {}) })
  }

  private async appendTimelineMutation(
    mutation: AgentTimelineMutation,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted()
    await appendFile(
      this.timelinePath(mutation.agentSessionId),
      `${JSON.stringify(mutation)}\n`,
      { mode: 0o600 }
    )
    signal?.throwIfAborted()
  }

  private async removeTimelineFile(agentSessionId: string): Promise<void> {
    await unlink(this.timelinePath(agentSessionId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }

  private async removeOrphanTimelineFiles(
    sessions: readonly AgentMuxStoredAgentSession[]
  ): Promise<void> {
    const directory = join(dirname(this.path), 'agent-timelines')
    const currentPaths = new Set(sessions.map((session) => this.timelinePath(session.agentSessionId)))
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await Promise.all(entries
      .filter((entry) => entry.endsWith('.json') || entry.endsWith('.jsonl'))
      .map(async (entry) => {
        const path = join(directory, entry)
        if (!currentPaths.has(path)) await unlink(path)
      }))
  }

  private async enqueue(operation: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    const current = this.tail.catch(() => {}).then(async () => {
      signal?.throwIfAborted()
      if (this.lockReleaseFailure) throw this.lockReleaseFailure
      const release = await this.acquireLock(signal)
      try {
        await operation()
      } finally {
        await release().catch((error) => {
          const failure = new AgentMuxError(
            'Agent Session store lock cleanup failed; this Store instance cannot write again.',
            'AGENT_SESSION_STORE_LOCK_RELEASE_FAILED',
            error instanceof Error ? error.message : String(error)
          )
          this.lockReleaseFailure = failure
          process.emitWarning(failure.message, { code: failure.code })
        })
      }
    })
    this.tail = current.then(() => {}, () => {})
    await current
  }

  private async acquireLock(signal?: AbortSignal): Promise<() => Promise<void>> {
    const path = `${this.path}.lock`
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted()
      try {
        const handle = await open(path, 'wx', 0o600)
        await handle.writeFile(`${process.pid}\n`, 'utf8')
        return async () => {
          await handle.close()
          await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await this.removeDeadOwnerLock(path)
        await delay(LOCK_RETRY_MS, signal)
      }
    }
    throw new AgentMuxError('Agent Session store is busy.', 'AGENT_SESSION_STORE_BUSY')
  }

  private async removeDeadOwnerLock(path: string): Promise<void> {
    try {
      const pid = Number((await readFile(path, 'utf8')).trim())
      if (!Number.isSafeInteger(pid) || pid <= 0) return
      try {
        process.kill(pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') await unlink(path)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
