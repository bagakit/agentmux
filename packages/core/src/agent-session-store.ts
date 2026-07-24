import { AgentMuxError } from './errors.js'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultAgentMuxRuntimeDirectory } from './runtime-paths.js'
import type {
  AgentHookReceipt,
  AgentMuxRunRef,
  AgentMuxStoredAgentSession,
  AgentNativeSessionHandle
} from './types.js'

const MAX_STORED_SESSIONS = 256
const MAX_LIFECYCLE_RESERVATIONS = 256
const MAX_UNBOUND_RETIRED_RUNS = 256
const MAX_ID_BYTES = 512
const MAX_PATH_BYTES = 16 * 1024
const MAX_RETIRED_RUNS = 16
const MAX_STORE_BYTES = 1024 * 1024
const LOCK_ATTEMPTS = 100
const LOCK_RETRY_MS = 10

export type AgentMuxLifecycleReservation = {
  reservationId: string
  ownerId: string
  ownerPid: number
  kind: 'create' | 'resume' | 'stop'
  agentSessionId: string
  operationId: string
  expiresAt: number
  expectedRun?: AgentMuxRunRef
}

export type AgentMuxLifecycleClaim = {
  ownerId: string
  ownerPid: number
  now: number
  expiresAt: number
}

export type AgentMuxAgentSessionStore = {
  load(): Promise<readonly unknown[]>
  loadRetiredRuns(): Promise<readonly AgentMuxRunRef[]>
  compareAndSwap(
    expected: AgentMuxStoredAgentSession | null,
    next: AgentMuxStoredAgentSession | null
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

function runRef(value: unknown): AgentMuxRunRef {
  const source = record(value, 'run')
  if (Object.keys(source).length !== 1 || !Object.hasOwn(source, 'runId')) {
    throw new AgentMuxError('run must contain only runId.', 'INVALID_AGENT_SESSION_STORE')
  }
  return {
    runId: string(source.runId, 'run.runId')
  }
}

function lifecycleReservation(value: unknown): AgentMuxLifecycleReservation {
  const source = record(value, 'lifecycle reservation')
  if (source.kind !== 'create' && source.kind !== 'resume' && source.kind !== 'stop') {
    throw new AgentMuxError('Lifecycle reservation kind is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const expectedRun = source.expectedRun === undefined ? undefined : runRef(source.expectedRun)
  if ((source.kind === 'create') === (expectedRun !== undefined)) {
    throw new AgentMuxError('Lifecycle reservation expected Run is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  return {
    reservationId: string(source.reservationId, 'reservationId'),
    ownerId: string(source.ownerId, 'ownerId'),
    ownerPid: positiveInteger(source.ownerPid, 'ownerPid'),
    kind: source.kind,
    agentSessionId: string(source.agentSessionId, 'agentSessionId'),
    operationId: string(source.operationId, 'operationId'),
    expiresAt: timestamp(source.expiresAt, 'expiresAt'),
    ...(expectedRun ? { expectedRun } : {})
  }
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
    agentId: string(source.agentId, 'hookReceipt.agentId'),
    agentSessionId: string(source.agentSessionId, 'hookReceipt.agentSessionId'),
    run: runRef(source.run),
    eventName,
    observedAt: timestamp(source.observedAt, 'hookReceipt.observedAt'),
    ...(outputCursorBytes === undefined ? {} : { outputCursorBytes })
  }
}

function terminalStopReceipt(
  value: unknown,
  currentRun: AgentMuxRunRef
): NonNullable<AgentMuxStoredAgentSession['terminalStopReceipt']> {
  const source = record(value, 'terminalStopReceipt')
  const run = runRef(source.run)
  const outputCursorBytes = timestamp(
    source.outputCursorBytes,
    'terminalStopReceipt.outputCursorBytes'
  )
  const readyThroughByte = source.readyThroughByte === undefined
    ? undefined
    : timestamp(source.readyThroughByte, 'terminalStopReceipt.readyThroughByte')
  const consumedBySubmissionId = source.consumedBySubmissionId === undefined
    ? undefined
    : string(source.consumedBySubmissionId, 'terminalStopReceipt.consumedBySubmissionId')
  if (
    run.runId !== currentRun.runId ||
    (readyThroughByte !== undefined && readyThroughByte < outputCursorBytes)
  ) {
    throw new AgentMuxError(
      'Terminal Stop receipt does not match its Agent Run boundary.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  return {
    id: string(source.id, 'terminalStopReceipt.id'),
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
    stopReceiptId: string(
      source.stopReceiptId,
      'terminalPromptSubmission.stopReceiptId'
    ),
    stopOutputCursorBytes: timestamp(
      source.stopOutputCursorBytes,
      'terminalPromptSubmission.stopOutputCursorBytes'
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
    agentId: string(source.agentId, 'agentId'),
    hostId: string(source.hostId, 'hostId'),
    workspacePath: string(source.workspacePath, 'workspacePath', MAX_PATH_BYTES),
    run: currentRun,
    retiredRuns: retiredRuns(source.retiredRuns, currentRun),
    hookBindingId: string(source.hookBindingId, 'hookBindingId'),
    outputCursorBytes: timestamp(source.outputCursorBytes, 'outputCursorBytes'),
    createdAt: timestamp(source.createdAt, 'createdAt'),
    updatedAt: timestamp(source.updatedAt, 'updatedAt'),
    ...(source.terminalHandshake === undefined
      ? {}
      : { terminalHandshake: terminalHandshake(source.terminalHandshake, currentRun) }),
    ...(source.terminalStopReceipt === undefined
      ? {}
      : { terminalStopReceipt: terminalStopReceipt(source.terminalStopReceipt, currentRun) }),
    ...(source.terminalPromptSubmission === undefined
      ? {}
      : {
          terminalPromptSubmission: terminalPromptSubmission(
            source.terminalPromptSubmission,
            currentRun
          )
        }),
    ...(source.nativeHandle === undefined ? {} : { nativeHandle: nativeHandle(source.nativeHandle) }),
    ...(source.hookReceipt === undefined ? {} : { hookReceipt: hookReceipt(source.hookReceipt) })
  }
  if (session.nativeHandle?.kind === 'provider' && session.nativeHandle.providerId !== session.agentId) {
    throw new AgentMuxError('Native session handle provider does not match the Agent.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (
    session.hookReceipt &&
    (
      session.hookReceipt.agentId !== session.agentId ||
      session.hookReceipt.agentSessionId !== session.agentSessionId ||
      session.hookReceipt.run.runId !== session.run.runId
    )
  ) {
    throw new AgentMuxError('Hook receipt does not match the Agent Session.', 'INVALID_AGENT_SESSION_STORE')
  }
  const submission = session.terminalPromptSubmission
  if (
    submission &&
    (
      submission.readyThroughByte < submission.stopOutputCursorBytes ||
      submission.outputCursorBytes < submission.readyThroughByte
    )
  ) {
    throw new AgentMuxError(
      'Terminal prompt submission does not preserve its ready Stop boundary.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  const stopReceipt = session.terminalStopReceipt
  if (
    stopReceipt?.consumedBySubmissionId !== undefined &&
    (
      stopReceipt.readyThroughByte === undefined ||
      !submission ||
      submission.submissionId !== stopReceipt.consumedBySubmissionId ||
      submission.stopReceiptId !== stopReceipt.id
    )
  ) {
    throw new AgentMuxError(
      'Consumed terminal Stop receipt does not identify its prompt submission.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  if (
    submission &&
    stopReceipt?.id === submission.stopReceiptId &&
    (
      stopReceipt.outputCursorBytes !== submission.stopOutputCursorBytes ||
      stopReceipt.readyThroughByte !== submission.readyThroughByte ||
      stopReceipt.consumedBySubmissionId !== submission.submissionId
    )
  ) {
    throw new AgentMuxError(
      'Terminal prompt submission did not atomically consume its Stop receipt.',
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
  sessions: readonly AgentMuxStoredAgentSession[]
): void {
  const current = sessions.find((session) => session.agentSessionId === reservation.agentSessionId)
  if (reservation.kind === 'create') {
    if (current) {
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

  async load(): Promise<readonly unknown[]> {
    return [...this.sessions.values()].map((session) => structuredClone(session))
  }

  async loadRetiredRuns(): Promise<readonly AgentMuxRunRef[]> {
    return this.retiredRuns.map((run) => ({ ...run }))
  }

  async compareAndSwap(
    expected: AgentMuxStoredAgentSession | null,
    next: AgentMuxStoredAgentSession | null
  ): Promise<void> {
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
      this.sessions.set(agentSessionId, structuredClone(normalized))
    } else {
      this.sessions.delete(agentSessionId)
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
    assertReservationPrecondition(reservation, [...this.sessions.values()])
    this.reservations.set(reservation.agentSessionId, structuredClone(reservation))
  }

  async claimStaleLifecycles(claim: AgentMuxLifecycleClaim): Promise<AgentMuxLifecycleReservation[]> {
    const claimed: AgentMuxLifecycleReservation[] = []
    for (const [agentSessionId, reservation] of this.reservations) {
      if (reservation.expiresAt > claim.now && processIsAlive(reservation.ownerPid)) continue
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
    this.retiredRuns = merged
    this.reservations.delete(reservation.agentSessionId)
  }

  async retireRuns(runs: readonly AgentMuxRunRef[]): Promise<void> {
    const merged = mergeRetiredRuns(this.retiredRuns, runs)
    assertUnboundRetiredRuns([...this.sessions.values()], merged)
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
    assertReservationPrecondition(reservation, [...this.sessions.values()])
    const normalized = next ? normalizeStoredAgentSession(next) : null
    assertLifecycleCommit(reservation, normalized)
    const values = [...this.sessions.values()].filter(
      (session) => session.agentSessionId !== reservation.agentSessionId
    )
    if (normalized) values.push(normalized)
    const sessions = normalizeAgentSessions(values)
    assertUnboundRetiredRuns(sessions, this.retiredRuns)
    if (normalized) this.sessions.set(normalized.agentSessionId, structuredClone(normalized))
    else this.sessions.delete(reservation.agentSessionId)
    this.reservations.delete(reservation.agentSessionId)
  }
}

type AgentSessionStoreDocument = {
  version: 2
  sessions: AgentMuxStoredAgentSession[]
  reservations: AgentMuxLifecycleReservation[]
  retiredRuns: AgentMuxRunRef[]
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function defaultAgentMuxAgentSessionStorePath(): string {
  return join(defaultAgentMuxRuntimeDirectory(), 'agent-sessions.json')
}

export class AgentMuxFileAgentSessionStore implements AgentMuxAgentSessionStore {
  private tail: Promise<void> = Promise.resolve()

  constructor(readonly path = defaultAgentMuxAgentSessionStorePath()) {}

  async load(): Promise<readonly unknown[]> {
    await this.tail
    return (await this.read()).sessions.map((session) => structuredClone(session))
  }

  async loadRetiredRuns(): Promise<readonly AgentMuxRunRef[]> {
    await this.tail
    return (await this.read()).retiredRuns.map((run) => ({ ...run }))
  }

  async compareAndSwap(
    expected: AgentMuxStoredAgentSession | null,
    next: AgentMuxStoredAgentSession | null
  ): Promise<void> {
    await this.enqueue(async () => {
      const agentSessionId = expected?.agentSessionId ?? next?.agentSessionId
      if (!agentSessionId || (expected && next && expected.agentSessionId !== next.agentSessionId)) {
        throw new AgentMuxError('Agent Session CAS identity is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      const document = await this.read()
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
      await this.write({ ...document, sessions: normalized })
    })
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
      assertReservationPrecondition(reservation, document.sessions)
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
        if (reservation.expiresAt > claim.now && processIsAlive(reservation.ownerPid)) return []
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
      assertReservationPrecondition(reservation, document.sessions)
      const normalized = next ? normalizeStoredAgentSession(next) : null
      assertLifecycleCommit(reservation, normalized)
      const sessions = document.sessions.filter(
        (session) => session.agentSessionId !== reservation.agentSessionId
      )
      if (normalized) sessions.push(normalized)
      const committedSessions = normalizeAgentSessions(sessions)
      assertUnboundRetiredRuns(committedSessions, document.retiredRuns)
      await this.write({
        version: 2,
        sessions: committedSessions,
        reservations: document.reservations.filter(
          (item) => item.reservationId !== reservation.reservationId
        ),
        retiredRuns: document.retiredRuns
      })
    })
  }

  private async read(): Promise<AgentSessionStoreDocument> {
    try {
      const metadata = await stat(this.path)
      if (!metadata.isFile() || metadata.size > MAX_STORE_BYTES) {
        throw new AgentMuxError('Agent Session store is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new AgentMuxError('Agent Session store is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      const document = value as {
        version?: unknown
        sessions?: unknown
        reservations?: unknown
        retiredRuns?: unknown
      }
      if (
        document.version !== 2 ||
        !Array.isArray(document.sessions) ||
        !Array.isArray(document.reservations) ||
        !Array.isArray(document.retiredRuns)
      ) {
        throw new AgentMuxError('Agent Session store is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      const sessions = normalizeAgentSessions(document.sessions)
      const retiredRuns = unboundRetiredRuns(document.retiredRuns)
      assertUnboundRetiredRuns(sessions, retiredRuns)
      return {
        version: 2,
        sessions,
        reservations: normalizeLifecycleReservations(document.reservations),
        retiredRuns
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 2, sessions: [], reservations: [], retiredRuns: [] }
      }
      throw error
    }
  }

  private async write(document: AgentSessionStoreDocument): Promise<void> {
    const content = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(content) > MAX_STORE_BYTES) {
      throw new AgentMuxError('Agent Session store exceeds its size limit.', 'AGENT_SESSION_STORE_LIMIT')
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, content, { mode: 0o600, flag: 'wx' })
      await rename(temporaryPath, this.path)
      await chmod(this.path, 0o600)
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.tail.catch(() => {}).then(async () => {
      const release = await this.acquireLock()
      try {
        await operation()
      } finally {
        await release()
      }
    })
    this.tail = current.then(() => {}, () => {})
    await current
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const path = `${this.path}.lock`
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
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
        await delay(LOCK_RETRY_MS)
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
