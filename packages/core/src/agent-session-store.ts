import { AgentMuxError } from './errors.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultAgentMuxRuntimeDirectory } from './runtime-paths.js'
import { normalizeAgentInteractionResponse } from './agent-interaction.js'
import {
  applyAgentTimelineMutation,
  normalizeAgentTimeline,
  normalizeAgentTimelineMutation
} from './session-timeline.js'
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
  AgentTimelineCommit,
  AgentTimelineItem,
  AgentTimelineMutation,
  AgentTimelineSnapshot
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

function nativeHandle(value: unknown): AgentNativeSessionHandle {
  const source = record(value, 'nativeHandle')
  if (source.kind === 'provider') {
    const transcriptPath = source.transcriptPath === undefined
      ? undefined
      : string(source.transcriptPath, 'nativeHandle.transcriptPath', MAX_PATH_BYTES)
    return {
      kind: 'provider',
      providerId: string(source.providerId, 'nativeHandle.providerId'),
      sessionId: string(source.sessionId, 'nativeHandle.sessionId'),
      ...(transcriptPath ? { transcriptPath } : {})
    }
  }
  if (source.kind === 'acp') {
    return {
      kind: 'acp',
      adapterId: string(source.adapterId, 'nativeHandle.adapterId'),
      sessionId: string(source.sessionId, 'nativeHandle.sessionId')
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
      if (option.tier !== undefined && !['safe', 'caution', 'danger'].includes(String(option.tier))) {
        throw new AgentMuxError('Permission option tier is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      return {
        id: string(option.id, `pendingInteraction.request.options[${index}].id`),
        label: text(option.label, `pendingInteraction.request.options[${index}].label`),
        kind: option.kind as 'allow-once' | 'allow-always' | 'reject-once' | 'reject-always',
        ...(description ? { description } : {}),
        ...(option.tier === undefined ? {} : { tier: option.tier as 'safe' | 'caution' | 'danger' })
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
    outputCursorBytes: timestamp(source.outputCursorBytes, 'outputCursorBytes'),
    createdAt: timestamp(source.createdAt, 'createdAt'),
    updatedAt: timestamp(source.updatedAt, 'updatedAt'),
    ...(source.terminalHandshake === undefined
      ? {}
      : { terminalHandshake: terminalHandshake(source.terminalHandshake, currentRun) }),
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

type AgentTimelineStoreDocument = {
  version: 2
  agentSessionId: string
  revision: number
  items: AgentTimelineItem[]
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
      await this.writeTimeline({
        version: 2,
        agentSessionId: canonicalMutation.agentSessionId,
        revision: result.revision,
        items
      }, signal)
    }, signal)
    return structuredClone(result)
  }

  private async read(signal?: AbortSignal): Promise<AgentSessionStoreDocument> {
    try {
      signal?.throwIfAborted()
      const metadata = await stat(this.path)
      if (!metadata.isFile() || metadata.size > MAX_STORE_BYTES) {
        throw new AgentMuxError('Agent Session store is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      const value: unknown = JSON.parse(await readFile(this.path, { encoding: 'utf8', signal }))
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new AgentMuxError('Agent Session store is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      const document = value as {
        version?: unknown
        sessions?: unknown
        reservations?: unknown
        retiredRuns?: unknown
        retiredAgentSessions?: unknown
      }
      if (
        document.version !== 5 ||
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
  }

  private async write(document: AgentSessionStoreDocument, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const content = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(content) > MAX_STORE_BYTES) {
      throw new AgentMuxError('Agent Session store exceeds its size limit.', 'AGENT_SESSION_STORE_LIMIT')
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    let committed = false
    try {
      await writeFile(temporaryPath, content, { mode: 0o600, flag: 'wx', signal })
      signal?.throwIfAborted()
      await rename(temporaryPath, this.path)
      committed = true
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (!committed && error.code !== 'ENOENT') throw error
      })
    }
  }

  private timelinePath(agentSessionId: string): string {
    const filename = createHash('sha256').update(agentSessionId).digest('base64url')
    return join(dirname(this.path), 'agent-timelines', `${filename}.json`)
  }

  private async readTimeline(
    agentSessionId: string,
    signal?: AbortSignal
  ): Promise<AgentTimelineStoreDocument> {
    const path = this.timelinePath(agentSessionId)
    try {
      signal?.throwIfAborted()
      const metadata = await stat(path)
      if (!metadata.isFile() || metadata.size > MAX_TIMELINE_STORE_BYTES) {
        throw new AgentMuxError('Agent Timeline store is invalid.', 'INVALID_AGENT_TIMELINE_STORE')
      }
      const value: unknown = JSON.parse(await readFile(path, { encoding: 'utf8', signal }))
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new AgentMuxError('Agent Timeline store is invalid.', 'INVALID_AGENT_TIMELINE_STORE')
      }
      const document = value as {
        version?: unknown
        agentSessionId?: unknown
        revision?: unknown
        items?: unknown
      }
      if (
        document.version !== 2 ||
        document.agentSessionId !== agentSessionId ||
        !Number.isSafeInteger(document.revision) ||
        (document.revision as number) < 0 ||
        !Array.isArray(document.items)
      ) {
        throw new AgentMuxError('Agent Timeline store is invalid.', 'INVALID_AGENT_TIMELINE_STORE')
      }
      return {
        version: 2,
        agentSessionId,
        revision: document.revision as number,
        items: normalizeAgentTimeline(agentSessionId, document.items)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 2, agentSessionId, revision: 0, items: [] }
      }
      throw error
    }
  }

  private async writeTimeline(
    document: AgentTimelineStoreDocument,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted()
    const content = `${JSON.stringify(document)}\n`
    if (Buffer.byteLength(content) > MAX_TIMELINE_STORE_BYTES) {
      throw new AgentMuxError('Agent Timeline store exceeds its size limit.', 'AGENT_TIMELINE_STORE_LIMIT')
    }
    const path = this.timelinePath(document.agentSessionId)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
    let committed = false
    try {
      await writeFile(temporaryPath, content, { mode: 0o600, flag: 'wx', signal })
      signal?.throwIfAborted()
      await rename(temporaryPath, path)
      committed = true
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (!committed && error.code !== 'ENOENT') throw error
      })
    }
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
      .filter((entry) => entry.endsWith('.json'))
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
