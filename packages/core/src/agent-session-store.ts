import { MAX_STORED_TEXT_BYTES, parsePromptSubmissionRecord, normalizePromptCompletionAdmission, terminalPromptSubmission, terminalPromptReadinessSource } from './prompt-submission-record.js'
export { parsePromptSubmissionRecord, normalizePromptCompletionAdmission } from './prompt-submission-record.js'
import { normalizeOperationDevice } from './operation-device.js'
import { AgentMuxError } from './errors.js'
import { parseAgentForkSource } from './agent-fork.js'
import { parseAgentMuxCreationOrigin } from './agent-creation-admission.js'
import { assertCurrentAgentCapabilityBinding, type AgentCapabilityBinding } from './agent-capability.js'
import { agentActivityTimelineItem } from './agent-activity-state.js'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { openSessionDatabase, promptAdmissionSchema, readCurrentSessionDatabase, syncSessionDatabase } from './agent-session-database.js'
import { defaultAgentMuxStateDirectory } from './runtime-paths.js'
import { durableWriteFile, DurableWriteError } from './durable-write.js'
import { normalizeAgentInteractionResponse } from './agent-interaction.js'
import { canonicalHookLifecycleEvent, isAgentHookLifecycleEvent } from './agent-hook-event.js'
import { isPermissionOptionKind, isPromptDeliveryDegradedReason, RISK_TIERS } from './types.js'
import { applyNormalizedTimelineMutation } from './session-timeline-reducer.js'
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
  AgentFuturePromptIntent,
  AgentActivityCommit,
  AgentActivityObservation,
  AgentHookReceipt,
  AgentMuxAgentSession,
  AgentMuxEvidence,
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxPendingInteraction,
  AgentMuxRunRef,
  AgentMuxStoredAgentSession,
  AgentPromptSubmissionRecord,
  AgentNativeSessionHandle,
  AgentNativeSessionConfirmationReceipt,
  AgentSessionHistoryMetadata,
  AgentSessionHistoryDescriptor,
  AgentStatus,
  AgentTerminalCapabilityState,
  AgentTerminalPromptDeliveryState,
  AgentTerminalOutputChannelState,
  AgentTerminalPromptReadinessSource,
  AgentTimelineCommit,
  AgentTimelineItem,
  AgentTimelineMutation,
  AgentTimelineSnapshot,
  AgentTurnUsage,
  RiskTier
} from './types.js'

const MAX_ID_BYTES = 512
const MAX_PATH_BYTES = 16 * 1024
// Individual text fields remain bounded; cumulative durable history is not a payload.
/**
 * 锁重试的预算与退避。
 *
 * **退避必须带抖动，这不是可有可无的润色。** 定长退避会让所有等待者同步醒来、一起抢同一个
 * `open(wx)`，形成惊群：每一轮只有一个能进，其余全部原地再等一个整周期。实测（并发写同一份
 * store，持锁 10ms）：定长 10ms 在并发 60 时 60 个里有 9 个耗尽预算抛 BUSY、总耗时 1108ms；
 * 换成 5-15ms 抖动后 BUSY 归零，而且更快——710ms。抖动打散了醒来时刻，队列才真的排得动。
 *
 * 持锁时长这条尺子也别忘：写入走 durable write（fsync 文件 + fsync 父目录），实测约 10ms/次。
 * 也就是说重试间隔与持锁时长是同一个量级——这正是定长退避退化成惊群的原因。谁要把
 * durableWriteFile 改慢，或者把这里的退避改回定长，都得重新量一遍这组数。
 */
const LOCK_ATTEMPTS = 300
const LOCK_RETRY_MIN_MS = 5
const LOCK_RETRY_JITTER_MS = 10

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

/** Prepared before start; no Run or input is invented for this durable creation seed. */
export type AgentMuxPreparedCreation = Pick<AgentMuxStoredAgentSession,
  'kind' | 'agentSessionId' | 'providerId' | 'executorId' | 'hostId' | 'workspacePath' | 'hookBindingId' | 'hookToken' |
  'capabilityHash' | 'createdAt' | 'updatedAt' | 'creation' | 'forkedFrom' | 'nativeHandle' | 'launchOptions'>

export type AgentMuxLifecycleReservation = AgentMuxLifecycleReservationBase & (
  | { kind: 'create'; preparedCreation?: AgentMuxPreparedCreation; ownerReleased?: true; expectedRun?: never; stopOperation?: never }
  | { kind: 'resume'; expectedRun: AgentMuxRunRef; stopOperation?: never }
  | { kind: 'reopen'; expectedRetirement: AgentMuxRetiredAgentSession; callerOperationId?: string; preparedSession?: AgentMuxStoredAgentSession; ownerReleased?: true; expectedRun?: never; stopOperation?: never }
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
  history?: AgentSessionHistoryMetadata
  activityCommit?: AgentActivityCommit
}

export type AgentMuxAgentSessionStore = {
  /** Exclusive in-flight Prompt orchestration; contention rejects without invoking operation. */
  withPromptSubmission<T>(agentSessionId: string, operation: () => Promise<T>): Promise<T>
  /** Flush the current exact binding; reading bytes alone does not acknowledge persistence. */
  confirmDurability(agentSessionId: string, expectedRun: AgentMuxRunRef, expectedSession: AgentMuxStoredAgentSession): Promise<void>
  /** Explicit current Session facts; cumulative original input records are read by their exact location. */
  load(): Promise<readonly unknown[]>
  loadMetadata(): Promise<readonly AgentMuxStoredAgentSession[]>
  readMetadata(agentSessionId: string): Promise<AgentMuxStoredAgentSession | null>
  /** Exact original claim; history is never loaded into ordinary Session metadata. */
  readPromptAdmission(agentSessionId: string, run: AgentMuxRunRef, submissionId: string): Promise<AgentPromptSubmissionRecord | null>
  /** Original outcome CAS. A late receipt cannot move the latest projection back. */
  settlePromptAdmission(expected: AgentPromptSubmissionRecord, next: AgentPromptSubmissionRecord, signal?: AbortSignal): Promise<void>
  /** Resolve one original active/retired source and its reopen correlation, without catalog discovery. */
  readHistorySource(agentSessionId: string): Promise<AgentSessionHistoryDescriptor | null>
  readFuturePromptIntent(agentSessionId: string, intentId: string): Promise<AgentFuturePromptIntent | null>
  listFuturePromptIntents(agentSessionId: string, options?: { afterIntentId?: string; limit?: number }): Promise<AgentMuxFuturePromptPage>
  /**
   * Metadata and an optional exact intent change commit under one Session CAS.
   * An authenticated author binding, when supplied, must also match the current
   * author metadata with no author lifecycle reservation under that same owner.
   * Implementations must reject drift before committing; it is not a grant.
   */
  compareAndSwapMetadata(expected: AgentMuxStoredAgentSession | null, next: AgentMuxStoredAgentSession | null,
    signal?: AbortSignal, future?: AgentMuxSessionFutureChange, author?: Readonly<AgentCapabilityBinding>): Promise<void>
  loadRetiredRuns(): Promise<readonly AgentMuxRunRef[]>
  loadRetiredAgentSessions(): Promise<readonly AgentMuxRetiredAgentSession[]>
  /** Read only the original pending reopen correlation, including unavailable correlations. */
  loadReopenCorrelations(): Promise<readonly { expectedRetirement: AgentMuxRetiredAgentSession; operationId?: string }[]>
  /** Recover an existing creation identity by its caller operation, including no-Run reservations. */
  loadCreationSessionId(createOperationId: string): Promise<string | null>
  /** Original no-Run creation correlation; reading never starts a process or replays input. */
  loadCreationCorrelation(agentSessionId: string): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'create' }> | null>
  /** Abort must cancel queued or active persistence without a late commit. */
  compareAndSwap(
    expected: AgentMuxStoredAgentSession | null,
    next: AgentMuxStoredAgentSession | null,
    signal?: AbortSignal
  ): Promise<void>
  reserveLifecycle(reservation: AgentMuxLifecycleReservation): Promise<void>
  prepareCreate(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'create' }>, seed: AgentMuxPreparedCreation): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'create' }>>
  claimCreate(agentSessionId: string, operationId: string, intentDigest: string, claim: AgentMuxLifecycleClaim): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'create' }> | null>
  prepareReopen(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>, session: AgentMuxStoredAgentSession): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>>
  releaseReopenOwner(ownerId: string): Promise<void>
  claimReopen(agentSessionId: string, operationId: string, expectedRetiredAt: number, claim: AgentMuxLifecycleClaim): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> | null>
  /** A target claims only its original Stop; adapters must preserve this filter. */
  claimStaleLifecycles(claim: AgentMuxLifecycleClaim, target?: { agentSessionId: string; expectedRun: AgentMuxRunRef }): Promise<AgentMuxLifecycleReservation[]>
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

export type AgentMuxSessionFutureChange = {
  intentId: string
  expected: AgentFuturePromptIntent | null
  next: AgentFuturePromptIntent | null
}
export type AgentMuxFuturePromptPage = {
  intents: Array<{ intentId: string; intent: AgentFuturePromptIntent }>
  nextIntentId: string | null
}

/** Only the accumulated business dictionary is separated; no second public DTO is defined here. */
export function agentSessionMetadata(session: AgentMuxStoredAgentSession): AgentMuxStoredAgentSession {
  const { futurePromptIntents: _future, ...metadata } = session
  return metadata
}

function promptAdmissionRecords(session: AgentMuxStoredAgentSession | null | undefined): AgentPromptSubmissionRecord[] {
  if (!session) return []
  const admission = session.promptCompletionAdmission, terminal = session.terminalPromptSubmission
  const shared = admission && terminal && admission.submissionId === terminal.submissionId
  const originals: AgentPromptSubmissionRecord[] = []
  if (admission) originals.push({ agentSessionId: session.agentSessionId, run: admission.intent?.run ?? session.run, admission,
    ...(shared ? { terminalPromptSubmission: terminal } : {}) })
  if (terminal && !shared) originals.push({ agentSessionId: session.agentSessionId, run: terminal.run, terminalPromptSubmission: terminal })
  return structuredClone(originals)
}
function promptAdmissionRecord(session: AgentMuxStoredAgentSession | null | undefined): AgentPromptSubmissionRecord | null {
  return promptAdmissionRecords(session)[0] ?? null
}

function promptRecordId(value: AgentPromptSubmissionRecord): string {
  const id = value.admission?.submissionId ?? value.terminalPromptSubmission?.submissionId
  // A missing logical identity remains missing. This opaque location only keeps its original JSON.
  return id === undefined ? JSON.stringify(['original-slot', value.admission?.operationId]) : JSON.stringify(['submission', id])
}


function assertPromptSettlement(expected: AgentPromptSubmissionRecord, next: AgentPromptSubmissionRecord): void {
  const { acknowledged: _ack, notApplied: _notApplied, native: _native, ...originalClaim } = expected.admission ?? {}
  const { acknowledged: _nextAck, notApplied: _nextNotApplied, native: _nextNative, ...nextClaim } = next.admission ?? {}
  if (expected.agentSessionId !== next.agentSessionId || expected.run.runId !== next.run.runId || promptRecordId(expected) !== promptRecordId(next) ||
      expected.admission?.transport !== 'native' || next.admission?.transport !== 'native' ||
      !isDeepStrictEqual(originalClaim, nextClaim) ||
      !isDeepStrictEqual(expected.admission.native.plan, next.admission.native.plan) ||
      !isDeepStrictEqual(expected.terminalPromptSubmission, next.terminalPromptSubmission)) {
    throw new AgentMuxError('Native receipt changed its original claim.', 'AGENT_PROMPT_OPERATION_CONFLICT')
  }
  if (expected.admission.native.outcome === 'admitted' || expected.admission.native.outcome === 'not-applied') {
    if (!isDeepStrictEqual(expected, next)) throw new AgentMuxError('The original Native terminal receipt cannot be changed.', 'AGENT_PROMPT_OPERATION_CONFLICT')
  }
  parsePromptSubmissionRecord(next)
}

/** Routine Session writes cannot rebind or restart an already claimed Native key. */
function assertPromptRecordWrite(original: AgentPromptSubmissionRecord | undefined, next: AgentPromptSubmissionRecord, receipt = false): void {
  if (!original || isDeepStrictEqual(original, next)) return
  if (original.admission?.transport !== 'native' && next.admission?.transport !== 'native') return
  if (!receipt || next.admission?.native?.outcome === 'claimed') throw new AgentMuxError(
    'The original Native input record can only be changed by its exact receipt owner.', 'AGENT_PROMPT_OPERATION_CONFLICT')
  assertPromptSettlement(original, next)
}

function futurePromptPage(entries: Array<{ intentId: string; intent: AgentFuturePromptIntent }>, limit: number): AgentMuxFuturePromptPage {
  const selected: typeof entries = []
  let bytes = 0
  for (const entry of entries.slice(0, limit)) {
    const size = Buffer.byteLength(JSON.stringify(entry))
    if (selected.length && bytes + size > 4 * 1024 * 1024) break
    selected.push(entry); bytes += size
  }
  return { intents: selected, nextIntentId: selected.length < entries.length ? selected.at(-1)!.intentId : null }
}
function futurePageLimit(limit = 16): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw new AgentMuxError('Future-message read window must be between 1 and 16.', 'INVALID_CONTROL_REQUEST')
  return limit
}
function nativeBindingKey(session: AgentMuxStoredAgentSession): string | null {
  const handle = session.nativeHandle
  return !handle ? null : handle.kind === 'provider'
    ? JSON.stringify(['provider', handle.providerId, handle.sessionId])
    : JSON.stringify(['acp', handle.adapterId, handle.sessionId])
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
  if (source.kind !== 'create' && source.kind !== 'resume' && source.kind !== 'stop' && source.kind !== 'reopen') {
    throw new AgentMuxError('Lifecycle reservation kind is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const expectedRun = source.expectedRun === undefined ? undefined : runRef(source.expectedRun)
  const stopOperation = source.stopOperation === undefined
    ? undefined
    : recoverableStopOperation(source.stopOperation)
  if (
    ((source.kind === 'create' || source.kind === 'reopen') && (expectedRun !== undefined || stopOperation !== undefined)) ||
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
  if (source.kind === 'reopen') {
    const retirement = retiredAgentSession(source.expectedRetirement)
    if (retirement.agentSessionId !== base.agentSessionId) throw new AgentMuxError('Reopen reservation identity is invalid.', 'INVALID_AGENT_SESSION_STORE')
    if (source.ownerReleased !== undefined && source.ownerReleased !== true) throw new AgentMuxError('Reopen owner release fact is invalid.', 'INVALID_AGENT_SESSION_STORE')
    const preparedSession = source.preparedSession === undefined ? undefined : normalizeStoredAgentSession(source.preparedSession)
    if (preparedSession) assertPreparedReopen(retirement, preparedSession)
    const callerOperationId = typeof source.callerOperationId === 'string' &&
      /^[a-zA-Z0-9_-]+$/.test(source.callerOperationId) && Buffer.byteLength(source.callerOperationId) <= MAX_ID_BYTES
      ? source.callerOperationId : undefined
    return { ...base, kind: 'reopen', expectedRetirement: retirement, ...(callerOperationId ? { callerOperationId } : {}), ...(preparedSession ? { preparedSession } : {}), ...(source.ownerReleased === true ? { ownerReleased: true } : {}) }
  }
  if (source.kind === 'create') {
    if (source.ownerReleased !== undefined && source.ownerReleased !== true) throw new AgentMuxError('Invalid create owner release.', 'INVALID_AGENT_SESSION_STORE')
    const preparedCreation = source.preparedCreation === undefined ? undefined : normalizePreparedCreation(source.preparedCreation)
    if (preparedCreation?.agentSessionId !== undefined && preparedCreation.agentSessionId !== base.agentSessionId) throw new AgentMuxError('Prepared creation names another Session.', 'INVALID_AGENT_SESSION_STORE')
    return { ...base, kind: 'create', ...(preparedCreation ? { preparedCreation } : {}), ...(source.ownerReleased ? { ownerReleased: true as const } : {}) }
  }
  if (source.kind === 'resume') return { ...base, kind: 'resume', expectedRun: expectedRun! }
  return { ...base, kind: 'stop', expectedRun: expectedRun!, stopOperation: stopOperation! }
}

function sameSession(
  left: AgentMuxStoredAgentSession | null,
  right: AgentMuxStoredAgentSession | null
): boolean {
  return isDeepStrictEqual(
    left === null ? null : normalizeStoredAgentSession(left),
    right === null ? null : normalizeStoredAgentSession(right)
  )
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
  if (!Array.isArray(value)) {
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
  if (!Array.isArray(value)) {
    throw new AgentMuxError('Unbound retired Runs are invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const runs = value.map(runRef)
  if (new Set(runs.map((run) => run.runId)).size !== runs.length) {
    throw new AgentMuxError('Unbound retired Runs contain duplicates.', 'INVALID_AGENT_SESSION_STORE')
  }
  return runs
}

function activityObservation(value: unknown, agentSessionId: string): AgentActivityObservation {
  const source = record(value, 'accepted activity observation')
  const item = normalizeAgentTimelineMutation({ type: 'append', agentSessionId, item: {
    ...source, agentSessionId, kind: 'lifecycle', status: 'complete', title: 'Accepted activity', updatedAt: source.createdAt
  } })
  if (item.type !== 'append' || !item.item.activityState) {
    throw new AgentMuxError('Accepted activity observation is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  return { id: item.item.id, source: item.item.source, createdAt: item.item.createdAt, activityState: item.item.activityState }
}

function activityCommit(value: unknown, agentSessionId: string): AgentActivityCommit {
  const source = record(value, 'activity commit')
  if (typeof source.latestCommitted !== 'boolean') {
    throw new AgentMuxError('Activity commit acknowledgement is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const latest = activityObservation(source.latest, agentSessionId)
  const pending = source.pending === undefined ? undefined : activityObservation(source.pending, agentSessionId)
  if (pending?.id === latest.id) {
    throw new AgentMuxError('Activity commit duplicates its pending observation.', 'INVALID_AGENT_SESSION_STORE')
  }
  return { latest, latestCommitted: source.latestCommitted, ...(pending ? { pending } : {}) }
}

/** Retirement may race an already accepted append; only that exact persisted observation is authorized. */
function acceptedRetiredActivity(
  retired: readonly AgentMuxRetiredAgentSession[], mutation: AgentTimelineMutation
): boolean {
  if (mutation.type !== 'append' || !mutation.item.activityState) return false
  const commit = retired.find(session => session.agentSessionId === mutation.agentSessionId)?.activityCommit
  return [commit?.pending, commit?.latest].some(observation => observation &&
    JSON.stringify(agentActivityTimelineItem(mutation.agentSessionId, observation)) === JSON.stringify(mutation.item))
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
    observedAt: timestamp(source.observedAt, 'retiredAgentSession.observedAt'),
    ...(source.history === undefined ? {} : { history: normalizeHistoryMetadata(source.history) }),
    ...(source.activityCommit === undefined ? {} : { activityCommit: activityCommit(source.activityCommit, string(source.agentSessionId, 'retiredAgentSession.agentSessionId')) })
  }
}

function normalizeHistoryMetadata(value: unknown): AgentSessionHistoryMetadata {
  const source = record(value, 'Session history metadata')
  const providerId = string(source.providerId, 'history.providerId')
  const handle = source.nativeHandle === undefined ? undefined : nativeHandle(source.nativeHandle)
  const observed = source.observedNativeHandle === undefined ? undefined : nativeHandle(source.observedNativeHandle)
  const previous = source.previousNativeHandle === undefined ? undefined : nativeHandle(source.previousNativeHandle)
  if (previous && (previous.kind !== 'provider' || previous.providerId !== providerId)) throw new AgentMuxError('Previous history identity belongs to another Provider.', 'INVALID_AGENT_SESSION_STORE')
  if (observed?.kind === 'provider' && observed.providerId !== providerId) throw new AgentMuxError('Observed history identity belongs to another Provider.', 'INVALID_AGENT_SESSION_STORE')
  if (handle?.kind === 'provider' && handle.providerId !== providerId) {
    throw new AgentMuxError('History locator belongs to another Provider.', 'INVALID_AGENT_SESSION_STORE')
  }
  return {
    providerId,
    executorId: string(source.executorId, 'history.executorId'),
    workspacePath: string(source.workspacePath, 'history.workspacePath', MAX_PATH_BYTES),
    createdAt: timestamp(source.createdAt, 'history.createdAt'),
    ...(handle === undefined ? {} : { nativeHandle: handle }),
    ...(observed === undefined ? {} : { observedNativeHandle: observed }),
    ...(previous?.kind === 'provider' ? { previousNativeHandle: previous } : {})
  }
}

/** Project only reading identity, never Hook secrets, permissions or lifecycle controls. */
export function sessionHistoryMetadata(session: AgentMuxStoredAgentSession): AgentSessionHistoryMetadata {
  return normalizeHistoryMetadata({ ...session,
    ...(session.nativeConfirmation ? { previousNativeHandle: session.nativeConfirmation.previousNativeHandle } : {}) })
}

function retiredAgentSessions(value: unknown): AgentMuxRetiredAgentSession[] {
  if (!Array.isArray(value)) {
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
  return [...merged.values()]
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
  return [...merged.values()]
}

/**
 * 退役 Session 必须有对应的退役 Run 事实；累计历史不按数量驱逐。
 * 仍出现在当前 Session 列表里的退役身份不在这里消掉，后面的断言继续拒绝。
 */
function retiredAgentSessionsForRuns(
  retiredSessions: readonly AgentMuxRetiredAgentSession[],
  retiredRuns: readonly AgentMuxRunRef[]
): AgentMuxRetiredAgentSession[] {
  const retiredRunIds = new Set(retiredRuns.map((run) => run.runId))
  return retiredSessions.filter((session) => retiredRunIds.has(session.run.runId))
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
  if (source.lifecycleEvent !== undefined && source.lifecycleEvent !== null && !isAgentHookLifecycleEvent(source.lifecycleEvent)) {
    throw new AgentMuxError('hookReceipt.lifecycleEvent is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const lifecycleEvent = canonicalHookLifecycleEvent(eventName, source.lifecycleEvent)
  const outputCursorBytes = source.outputCursorBytes === undefined
    ? undefined
    : timestamp(source.outputCursorBytes, 'hookReceipt.outputCursorBytes')
  // 承重的是**一个方向**：有光标 ⟹ 必须是 turn 收尾回执。它防的是伪造——任何非收尾回执都不许携带
  // 一个「权威输出光标」，否则 composer 就绪判定会以一个 mid-turn 的字节位置为边界，把上一轮的提示符
  // 认成这一轮的。收尾判据取 canonical 生命周期事件而非原始拼法：`Stop` 与 `StopFailure`（以及别家
  // Provider 的收尾方言）都归一到 `turn-end`（agent-hook-event.ts）。比字面 `=== 'Stop'` 会漏掉
  // `StopFailure`——client 摄入侧对它同样取光标，那条合法回执会在这里被误当成伪造而整条 hook 落盘失败。
  //
  // 反方向（收尾 ⟹ 必须有光标）**不承重，且会被 wire 抖动打破**：取光标要向内核问一次 run 状态，
  // 而断线期间那次调用抛 CTXMUX_DISCONNECTED。原先这里写成双条件，逼得 client 要么带着光标一起
  // 失败（则整条收尾丢失、Agent 永久卡 working），要么编一个假光标。两条都比「收尾落盘、光标缺席」
  // 坏。所以这里只守伪造那一侧：缺席就是缺席，下游 readiness 也一并缺席，下一次发 prompt 收到
  // `epoch-missing` 的响亮拒绝，而不是一次静默走错边界的发送。
  if (outputCursorBytes !== undefined && lifecycleEvent !== 'turn-end') {
    throw new AgentMuxError(
      'Only native turn-end receipts may carry an authoritative output cursor.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  const invocation = source.toolInvocation === undefined ? undefined : record(source.toolInvocation, 'hookReceipt.toolInvocation')
  if (invocation && (Object.keys(invocation).some(key => !['nativeSessionId', 'nativeToolCallId', 'nativeTurnId', 'nativeTranscriptPath', 'toolName', 'toolInput', 'ambiguous'].includes(key)) ||
    invocation.ambiguous !== undefined && invocation.ambiguous !== true)) {
    throw new AgentMuxError('hookReceipt.toolInvocation is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  // Tool arguments are content, including empty/multiline text, not an identity.
  // Keep the existing per-text storage bound; ingress separately bounds in-flight bodies.
  if (invocation && (typeof invocation.toolInput !== 'string' || Buffer.byteLength(invocation.toolInput) > MAX_STORED_TEXT_BYTES)) {
    throw new AgentMuxError('hookReceipt.toolInvocation.toolInput is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const nativeTranscriptPath = invocation?.nativeTranscriptPath === undefined
    ? undefined : normalizeNativeTranscriptPath(invocation.nativeTranscriptPath)
  if (invocation?.nativeTranscriptPath !== undefined && nativeTranscriptPath !== invocation.nativeTranscriptPath) {
    throw new AgentMuxError('hookReceipt.toolInvocation.nativeTranscriptPath is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  return {
    id: string(source.id, 'hookReceipt.id'),
    providerId: string(source.providerId, 'hookReceipt.providerId'),
    agentSessionId: string(source.agentSessionId, 'hookReceipt.agentSessionId'),
    run: runRef(source.run),
    eventName,
    ...(source.nativeTurnId === undefined ? {} : { nativeTurnId: string(source.nativeTurnId, 'hookReceipt.nativeTurnId') }),
    ...(invocation ? { toolInvocation: {
      nativeSessionId: string(invocation.nativeSessionId, 'hookReceipt.toolInvocation.nativeSessionId'),
      nativeToolCallId: string(invocation.nativeToolCallId, 'hookReceipt.toolInvocation.nativeToolCallId'),
      ...(invocation.nativeTurnId === undefined ? {} : { nativeTurnId: string(invocation.nativeTurnId, 'hookReceipt.toolInvocation.nativeTurnId') }),
      ...(nativeTranscriptPath === undefined ? {} : { nativeTranscriptPath }),
      toolName: string(invocation.toolName, 'hookReceipt.toolInvocation.toolName'),
      toolInput: invocation.toolInput as string,
      ...(invocation.ambiguous ? { ambiguous: true as const } : {})
    } } : {}),
    ...(source.lifecycleEvent === null ? { lifecycleEvent: null } : lifecycleEvent ? { lifecycleEvent } : {}),
    observedAt: timestamp(source.observedAt, 'hookReceipt.observedAt'),
    ...(source.subject === undefined ? {} : { subject: (() => {
      const subject = record(source.subject, 'hookReceipt.subject')
      if (!['main', 'child', 'foreign', 'unknown'].includes(String(subject.kind)) ||
        !['provider-protocol', 'process-native-record'].includes(String(subject.basis))) throw new AgentMuxError('Invalid Hook subject.', 'INVALID_AGENT_SESSION_STORE')
      return { kind: subject.kind as NonNullable<AgentHookReceipt['subject']>['kind'],
        basis: subject.basis as NonNullable<AgentHookReceipt['subject']>['basis'], reason: string(subject.reason, 'hookReceipt.subject.reason'),
        ...(subject.nativeSessionId === undefined ? {} : { nativeSessionId: string(subject.nativeSessionId, 'hookReceipt.subject.nativeSessionId') }) }
    })() }),
    ...(source.decision === undefined ? {} : { decision: (() => {
      const decision = record(source.decision, 'hookReceipt.decision')
      if (typeof decision.activityApplied !== 'boolean' || typeof decision.lifecycleApplied !== 'boolean') throw new AgentMuxError('Invalid Hook decision.', 'INVALID_AGENT_SESSION_STORE')
      return { activityApplied: decision.activityApplied, lifecycleApplied: decision.lifecycleApplied, reason: string(decision.reason, 'hookReceipt.decision.reason') }
    })() }),
    ...(outputCursorBytes === undefined ? {} : { outputCursorBytes })
  }
}

function semanticStatus(value: unknown): AgentStatus {
  const source = record(value, 'semanticStatus')
  // Native unknown outcome uses the existing agentDisplayState(unknown) === running projection.
  if (!['working', 'waiting', 'blocked', 'done', 'error', 'running'].includes(String(source.state))) {
    throw new AgentMuxError('semanticStatus.state is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (source.source !== 'native-hook' && source.source !== 'native-transcript' && source.source !== 'acp') {
    throw new AgentMuxError('semanticStatus.source is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  const detail = source.detail === undefined
    ? undefined
    : text(source.detail, 'semanticStatus.detail')
  return {
    state: source.state as AgentStatus['state'],
    source: source.source,
    observedAt: timestamp(source.observedAt, 'semanticStatus.observedAt'),
    ...(source.currentActivityRevision === undefined ? {} : { currentActivityRevision: positiveInteger(source.currentActivityRevision, 'semanticStatus.currentActivityRevision') }),
    ...(source.stateEnteredAt === undefined ? {} : {
      stateEnteredAt: timestamp(source.stateEnteredAt, 'semanticStatus.stateEnteredAt')
    }),
    ...(detail ? { detail } : {}),
    ...(source.nativeTurnId === undefined ? {} : { nativeTurnId: text(source.nativeTurnId, 'semanticStatus.nativeTurnId') }),
    ...(source.failure === undefined ? {} : { failure: (() => {
      const failure = record(source.failure, 'semanticStatus.failure')
      if (source.state !== 'error') throw new AgentMuxError('Failure requires an error status.', 'INVALID_AGENT_SESSION_STORE')
      const http = failure.httpStatusCode
      if (http !== undefined && (!Number.isInteger(http) || Number(http) < 100 || Number(http) > 599)) {
        throw new AgentMuxError('Failure HTTP status is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      return { code: text(failure.code, 'failure.code'), message: text(failure.message, 'failure.message'),
        recovery: text(failure.recovery, 'failure.recovery'), nativeTurnId: text(failure.nativeTurnId, 'failure.nativeTurnId'),
        ...(failure.nativeCode === undefined ? {} : { nativeCode: text(failure.nativeCode, 'failure.nativeCode') }),
        ...(http === undefined ? {} : { httpStatusCode: Number(http) }) }
    })() }),
    ...(source.idleEvidenceConsumed === undefined ? {} : { idleEvidenceConsumed: (() => {
      if (source.idleEvidenceConsumed !== true || source.state !== 'done') throw new AgentMuxError('Invalid consumed completion.', 'INVALID_AGENT_SESSION_STORE')
      return true as const
    })() }),
    ...(source.aggregateActivityAt === undefined ? {} : { aggregateActivityAt: timestamp(source.aggregateActivityAt, 'semanticStatus.aggregateActivityAt') })
  }
}

function turnUsage(value: unknown): AgentTurnUsage {
  const source = record(value, 'turnUsage')
  // token 数与观测时刻都是非负安全整数——沿用 timestamp 的校验（它正是这个约束），任一字段不合就整条拒绝，
  // 绝不落一个半残的用量。
  return {
    inputTokens: timestamp(source.inputTokens, 'turnUsage.inputTokens'),
    outputTokens: timestamp(source.outputTokens, 'turnUsage.outputTokens'),
    totalTokens: timestamp(source.totalTokens, 'turnUsage.totalTokens'),
    observedAt: timestamp(source.observedAt, 'turnUsage.observedAt'),
    ...(source.context === undefined ? {} : {
      context: {
        usedTokens: timestamp(record(source.context, 'turnUsage.context').usedTokens, 'turnUsage.context.usedTokens'),
        capacityTokens: timestamp(record(source.context, 'turnUsage.context').capacityTokens, 'turnUsage.context.capacityTokens')
      }
    })
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
      if (!isPermissionOptionKind(option.kind)) {
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
        kind: option.kind,
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
    const request: Extract<AgentMuxInteractionRequest, { kind: 'permission' }> = {
      kind: 'permission',
      ...base,
      title: text(source.title, 'pendingInteraction.request.title'),
      options,
      ...(toolName ? { toolName } : {}),
      ...(toolInput ? { toolInput } : {}),
      ...(source.nativeToolCallId === undefined ? {} : {
        nativeToolCallId: string(source.nativeToolCallId, 'pendingInteraction.request.nativeToolCallId')
      })
    }
    if (source.responseUnavailableReason !== undefined) request.responseUnavailableReason = text(source.responseUnavailableReason, 'pendingInteraction.request.responseUnavailableReason')
    if (source.permissionHook !== undefined) {
      const hook = record(source.permissionHook, 'pendingInteraction.request.permissionHook')
      const receiptId = string(hook.receiptId, 'pendingInteraction.request.permissionHook.receiptId')
      if (receiptId !== request.id || request.evidence.hookReceiptId !== receiptId || request.evidence.source !== 'native-hook' ||
          !request.evidence.run?.runId || hook.closed !== undefined && hook.closed !== 'abstained' && hook.closed !== 'decision-returned') {
        throw new AgentMuxError('Permission callback does not match its original Hook.', 'INVALID_AGENT_SESSION_STORE')
      }
      request.permissionHook = { receiptId, ...(hook.closed ? { closed: hook.closed } : {}),
        ...(hook.nativeSessionId === undefined ? {} : { nativeSessionId: string(hook.nativeSessionId, 'pendingInteraction.request.permissionHook.nativeSessionId') }),
        ...(hook.nativeTurnId === undefined ? {} : { nativeTurnId: string(hook.nativeTurnId, 'pendingInteraction.request.permissionHook.nativeTurnId') }) }
      if (hook.nativeTurnEnded !== undefined) {
        const end = record(hook.nativeTurnEnded, 'pendingInteraction.request.permissionHook.nativeTurnEnded')
        if (!request.permissionHook.nativeSessionId || !request.permissionHook.nativeTurnId) throw new AgentMuxError('Permission Hook turn end lacks its native target.', 'INVALID_AGENT_SESSION_STORE')
        request.permissionHook.nativeTurnEnded = { recordId: string(end.recordId, 'pendingInteraction.request.permissionHook.nativeTurnEnded.recordId'),
          observedAt: timestamp(end.observedAt, 'pendingInteraction.request.permissionHook.nativeTurnEnded.observedAt') }
      }
      if (hook.response !== undefined) {
        const response = record(hook.response, 'pendingInteraction.request.permissionHook.response')
        const value = interactionResponse(response.value, request)
        const responseDigest = string(response.responseDigest, 'pendingInteraction.request.permissionHook.response.responseDigest')
        if (value.kind !== 'permission' || responseDigest !== createHash('sha256').update(JSON.stringify(value)).digest('base64url') ||
            !['saved', 'unknown', 'connection-written'].includes(response.delivery as string)) {
          throw new AgentMuxError('Permission Hook response receipt is invalid.', 'INVALID_AGENT_SESSION_STORE')
        }
        request.permissionHook.response = { value, responseDigest,
          operationId: string(response.operationId, 'pendingInteraction.request.permissionHook.response.operationId'),
          delivery: response.delivery as 'saved' | 'unknown' | 'connection-written' }
      }
    }
    return request
  }
  if (source.kind !== 'question' || !Array.isArray(source.questions) ||
    (source.responseUnavailableReason === undefined ? source.questions.length !== 1 : source.questions.length !== 0)) {
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
  return { kind: 'question', ...base, questions,
    ...(source.responseUnavailableReason === undefined ? {} : {
      responseUnavailableReason: string(source.responseUnavailableReason, 'pendingInteraction.request.responseUnavailableReason')
    }),
    ...(source.nativeToolCallId === undefined ? {} : {
      nativeToolCallId: string(source.nativeToolCallId, 'pendingInteraction.request.nativeToolCallId')
    }) }
}

function pendingInteraction(value: unknown): AgentMuxPendingInteraction {
  const source = record(value, 'pendingInteraction')
  const request = interactionRequest(source.request)
  const nativeCompleted = source.nativeCompleted === undefined ? undefined : interactionEvidence(source.nativeCompleted)
  if (nativeCompleted && (request.evidence.source !== 'native-hook' || !request.nativeToolCallId ||
      nativeCompleted.source !== 'native-hook' || nativeCompleted.run?.runId !== request.evidence.run?.runId)) {
    throw new AgentMuxError('Native completion does not match its request.', 'INVALID_AGENT_SESSION_STORE')
  }
  const native = source.nativeInput === undefined ? undefined : record(source.nativeInput, 'pendingInteraction.nativeInput')
  if (native && native.delivery !== 'unknown' && native.delivery !== 'accepted') {
    throw new AgentMuxError('Native interaction input delivery is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (source.additionalRequests !== undefined && !Array.isArray(source.additionalRequests)) {
    throw new AgentMuxError('Additional native requests must be an array.', 'INVALID_AGENT_SESSION_STORE')
  }
  const additionalRequests = (source.additionalRequests ?? []).map(interactionRequest)
  if (additionalRequests.some(other => other.agentSessionId !== request.agentSessionId ||
      other.evidence.source !== 'native-hook' || other.evidence.run?.runId !== request.evidence.run?.runId) ||
      new Set([request.id, ...additionalRequests.map(other => other.id)]).size !== additionalRequests.length + 1) {
    throw new AgentMuxError('Additional native requests do not match the current Session and Run.', 'INVALID_AGENT_SESSION_STORE')
  }
  const facts = {
    ...(additionalRequests.length ? { additionalRequests } : {}),
    ...(nativeCompleted ? { nativeCompleted } : {}),
    ...(native ? { nativeInput: {
      operationId: string(native.operationId, 'pendingInteraction.nativeInput.operationId'),
      delivery: native.delivery as 'unknown' | 'accepted',
      observedAt: timestamp(native.observedAt, 'pendingInteraction.nativeInput.observedAt')
    } } : {})
  }
  if (source.response === undefined) return { request, ...facts }
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
    ...facts,
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

// The sole runtime whitelist for the prompt-readiness source vocabulary, projected off a total
// `Record<AgentTerminalPromptReadinessSource, true>` table. Hand-copying the members here (as a plain
// `readonly X[]` literal, or as inline `value !== 'a' && value !== 'b'` checks) only enforces ⊆ — every
// listed string is a member — and is blind to ⊇: adding a member to the union in types.ts and forgetting
// to list it here would silently REJECT every legitimate on-disk session carrying the new member with
// INVALID_AGENT_SESSION_STORE, a fail-closed data drop with NO compile error, and addition is the common
// direction. The explicit `Record<Union, true>` annotation turns BOTH directions into a compile error at
// THIS file — a missing key errors (TS2741, the ⊇ drift this guards) and an extra/stale key errors
// (TS2353). That compiler check is the load-bearing thing, not the runtime `.includes`: a hand-written
// array is behaviourally identical to this projection, so only the compiler catches the drift. Blind spot:
// it does not check member order, only the exact set.

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
  const outputCursorBytes = source.outputCursorBytes === undefined ? undefined
    : timestamp(source.outputCursorBytes, 'terminalPromptReadiness.outputCursorBytes')
  const observedAt = source.observedAt === undefined ? undefined
    : timestamp(source.observedAt, 'terminalPromptReadiness.observedAt')
  const readyThroughByte = source.readyThroughByte === undefined
    ? undefined
    : timestamp(source.readyThroughByte, 'terminalPromptReadiness.readyThroughByte')
  const consumedBySubmissionId = source.consumedBySubmissionId === undefined
    ? undefined
    : string(source.consumedBySubmissionId, 'terminalPromptReadiness.consumedBySubmissionId')
  if (
    run.runId !== currentRun.runId ||
    (readinessSource === 'initial-composer' && (outputCursorBytes === undefined || observedAt !== undefined)) ||
    (
      readyThroughByte !== undefined &&
      (outputCursorBytes === undefined || (readinessSource === 'initial-composer'
        ? readyThroughByte <= outputCursorBytes
        : readyThroughByte < outputCursorBytes))
    ) ||
    (readinessSource === 'initial-composer' && consumedBySubmissionId !== undefined && readyThroughByte === undefined)
  ) {
    throw new AgentMuxError(
      'Terminal prompt readiness does not match its Agent Run boundary.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  const base = {
    id: string(source.id, 'terminalPromptReadiness.id'),
    run,
    ...(readyThroughByte === undefined ? {} : { readyThroughByte }),
    ...(consumedBySubmissionId === undefined ? {} : { consumedBySubmissionId })
  }
  return readinessSource === 'initial-composer'
    ? { ...base, source: 'initial-composer', outputCursorBytes: outputCursorBytes! }
    : { ...base, source: 'native-stop', ...(outputCursorBytes === undefined ? {} : { outputCursorBytes }),
        ...(observedAt === undefined ? {} : { observedAt }) }
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
    !isPromptDeliveryDegradedReason(source.reason) ||
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

function terminalOutputChannel(
  value: unknown,
  currentRun: AgentMuxRunRef
): AgentTerminalOutputChannelState {
  const source = record(value, 'terminalOutputChannel')
  const run = runRef(source.run)
  if (
    source.state !== 'severed' ||
    source.mode !== 'degraded' ||
    source.reason !== 'reattach-failed' ||
    run.runId !== currentRun.runId
  ) {
    throw new AgentMuxError(
      'Terminal output channel state does not match its Agent Run.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  return {
    state: 'severed',
    mode: 'degraded',
    reason: 'reattach-failed',
    run,
    observedAt: timestamp(source.observedAt, 'terminalOutputChannel.observedAt')
  }
}

/** Public and durable Session facts share the same validation owner. */
function nativeConfirmation(value: unknown): AgentNativeSessionConfirmationReceipt {
  const p = record(value, 'nativeConfirmation')
  if (Object.keys(p).some(key => !['operationId', 'run', 'previousNativeHandle', 'nativeHandle', 'observedAt', 'candidateObservedAt', 'previousInteraction', 'previousPromptSubmissionId'].includes(key))) {
    throw new AgentMuxError('Invalid native confirmation receipt.', 'INVALID_AGENT_SESSION_STORE')
  }
  const previousNativeHandle = nativeHandle(p.previousNativeHandle), handle = nativeHandle(p.nativeHandle)
  if (previousNativeHandle.kind !== 'provider' || handle.kind !== 'provider' ||
    previousNativeHandle.providerId !== handle.providerId || previousNativeHandle.sessionId === handle.sessionId) {
    throw new AgentMuxError('Native confirmation requires two exact Provider conversations.', 'INVALID_AGENT_SESSION_STORE')
  }
  return { operationId: string(p.operationId, 'nativeConfirmation.operationId'), run: runRef(p.run),
    previousNativeHandle, nativeHandle: handle, observedAt: timestamp(p.observedAt, 'nativeConfirmation.observedAt'),
    candidateObservedAt: timestamp(p.candidateObservedAt, 'nativeConfirmation.candidateObservedAt'),
    ...(p.previousInteraction === undefined ? {} : { previousInteraction: pendingInteraction(p.previousInteraction) }),
    ...(p.previousPromptSubmissionId === undefined ? {} : { previousPromptSubmissionId: string(p.previousPromptSubmissionId, 'nativeConfirmation.previousPromptSubmissionId') }) }
}

function creationFact(value: unknown): NonNullable<AgentMuxAgentSession['creation']> {
  const creation = record(value, 'creation'), initialPrompt = creation.initialPrompt
  if (!['not-requested', 'confirmed', 'unconfirmed', 'unknown'].includes(String(initialPrompt)) ||
    creation.agentMuxContext !== undefined && !['confirmed', 'unconfirmed', 'unknown'].includes(String(creation.agentMuxContext)) ||
    creation.intentDigest !== undefined && (typeof creation.intentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(creation.intentDigest)) ||
    creation.executorRevision !== undefined && (typeof creation.executorRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(creation.executorRevision)) ||
    creation.persistence !== undefined && creation.persistence !== 'unconfirmed') throw new AgentMuxError('Invalid creation receipt.', 'INVALID_AGENT_SESSION_STORE')
  let failure: NonNullable<AgentMuxAgentSession['creation']>['failure']
  if (creation.failure !== undefined) {
    const p = record(creation.failure, 'creation.failure')
    if (Object.keys(p).some(key => !['step', 'code', 'message'].includes(key)) || !['session-commit', 'hook-bind', 'handshake'].includes(String(p.step))) throw new AgentMuxError('Invalid creation failure step.', 'INVALID_AGENT_SESSION_STORE')
    failure = { step: p.step as NonNullable<typeof failure>['step'], code: string(p.code, 'creation.failure.code'), message: text(p.message, 'creation.failure.message') }
  }
  return { createOperationId: string(creation.createOperationId, 'creation.createOperationId'), initialPrompt: initialPrompt as NonNullable<AgentMuxAgentSession['creation']>['initialPrompt'],
    ...(creation.initialMessageOrigin === undefined ? {} : { initialMessageOrigin: parseAgentMuxCreationOrigin(creation.initialMessageOrigin) }),
    ...(creation.executorRevision === undefined ? {} : { executorRevision: creation.executorRevision as string }),
    ...(creation.agentMuxContext === undefined ? {} : { agentMuxContext: creation.agentMuxContext as 'confirmed' | 'unconfirmed' | 'unknown' }),
    ...(creation.intentDigest === undefined ? {} : { intentDigest: creation.intentDigest as string }),
    ...(creation.persistence === undefined ? {} : { persistence: 'unconfirmed' as const }), ...(failure ? { failure } : {}) }
}

function normalizePreparedCreation(value: unknown): AgentMuxPreparedCreation {
  const p = record(value, 'prepared creation')
  if (p.kind !== 'agent' || Object.keys(p).some(key => !['kind', 'agentSessionId', 'providerId', 'executorId', 'hostId', 'workspacePath',
    'hookBindingId', 'hookToken', 'capabilityHash', 'createdAt', 'updatedAt', 'creation', 'forkedFrom', 'nativeHandle', 'launchOptions'].includes(key))) throw new AgentMuxError('Invalid no-Run creation seed.', 'INVALID_AGENT_SESSION_STORE')
  const creation = creationFact(p.creation), forkedFrom = p.forkedFrom === undefined ? undefined : parseAgentForkSource(p.forkedFrom)
  if (!creation.intentDigest || creation.persistence || creation.failure || creation.agentMuxContext !== 'unknown' ||
    forkedFrom && forkedFrom.expectedNativeHandle.providerId !== p.providerId) throw new AgentMuxError('Prepared creation intent is incomplete.', 'INVALID_AGENT_SESSION_STORE')
  return { kind: 'agent', agentSessionId: string(p.agentSessionId, 'agentSessionId'), providerId: string(p.providerId, 'providerId'),
    executorId: string(p.executorId, 'executorId'), hostId: string(p.hostId, 'hostId'), workspacePath: string(p.workspacePath, 'workspacePath', MAX_PATH_BYTES),
    hookBindingId: string(p.hookBindingId, 'hookBindingId'), hookToken: string(p.hookToken, 'hookToken'), capabilityHash: string(p.capabilityHash, 'capabilityHash'),
    createdAt: timestamp(p.createdAt, 'createdAt'), updatedAt: timestamp(p.updatedAt, 'updatedAt'), creation, ...(forkedFrom ? { forkedFrom } : {}),
    ...(p.nativeHandle === undefined ? {} : { nativeHandle: nativeHandle(p.nativeHandle) }),
    ...(p.launchOptions === undefined ? {} : { launchOptions: launchOptionSelection(p.launchOptions) }) }
}

export function normalizeAgentSession(value: unknown): AgentMuxAgentSession {
  const source = record(value, 'Agent Session')
  if (source.kind !== 'agent') {
    throw new AgentMuxError('Only Agent Sessions may be persisted.', 'INVALID_AGENT_SESSION_STORE')
  }
  const currentRun = runRef(source.run)
  const priorRuns = retiredRuns(source.retiredRuns, currentRun)
  const session: AgentMuxAgentSession = {
    kind: 'agent',
    agentSessionId: string(source.agentSessionId, 'agentSessionId'),
    providerId: string(source.providerId, 'providerId'),
    executorId: string(source.executorId, 'executorId'),
    hostId: string(source.hostId, 'hostId'),
    workspacePath: string(source.workspacePath, 'workspacePath', MAX_PATH_BYTES),
    run: currentRun,
    retiredRuns: priorRuns,
    createdAt: timestamp(source.createdAt, 'createdAt'),
    updatedAt: timestamp(source.updatedAt, 'updatedAt'),
    ...(source.launchOptions === undefined
      ? {}
      : { launchOptions: launchOptionSelection(source.launchOptions) }),
    ...(source.reopenedFrom === undefined ? {} : { reopenedFrom: (() => {
      const fact = record(source.reopenedFrom, 'reopenedFrom')
      if (Object.keys(fact).some(key => !['run', 'source', 'observedAt'].includes(key)) || fact.source !== 'user') {
        throw new AgentMuxError('Reopen retirement source is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      return { run: runRef(fact.run), source: 'user' as const, observedAt: timestamp(fact.observedAt, 'reopenedFrom.observedAt') }
    })() }),
    ...(source.forkedFrom === undefined ? {} : { forkedFrom: parseAgentForkSource(source.forkedFrom) }),
    ...(source.creation === undefined ? {} : { creation: creationFact(source.creation) }),
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
    ...(source.promptCompletionAdmission === undefined ? {} : { promptCompletionAdmission: normalizePromptCompletionAdmission(source.promptCompletionAdmission) }),
    ...(source.futurePromptIntents === undefined ? {} : { futurePromptIntents: (() => {
      const intents = record(source.futurePromptIntents, 'future prompt intents')
      return Object.fromEntries(Object.entries(intents).map(([id, value]) => {
        string(id, 'future intent id')
        const intent = record(value, 'future prompt intent'), message = record(intent.message, 'future prompt source')
        if (typeof intent.active !== 'boolean' || message.authorHuman !== undefined) throw new AgentMuxError('Future prompt origin or active state is invalid.', 'INVALID_AGENT_SESSION_STORE')
        const userContent = message.userContent === undefined ? undefined : text(message.userContent, 'future prompt content', MAX_STORED_TEXT_BYTES)
        const systemContext = message.systemContext === undefined ? undefined : text(message.systemContext, 'future prompt context', MAX_STORED_TEXT_BYTES)
        if (userContent === undefined && systemContext === undefined) throw new AgentMuxError('Future prompt source is empty.', 'INVALID_AGENT_SESSION_STORE')
        return [id, { operationId: string(intent.operationId, 'future intent operation'), prompt: text(intent.prompt, 'future prompt', MAX_STORED_TEXT_BYTES), active: intent.active,
          message: { ...(userContent === undefined ? {} : { userContent }), ...(systemContext === undefined ? {} : { systemContext }),
            ...(message.authorAgentSessionId === undefined ? {} : { authorAgentSessionId: string(message.authorAgentSessionId, 'future prompt author') }),
            ...(message.sourceDevice === undefined ? {} : { sourceDevice: normalizeOperationDevice(message.sourceDevice) }) },
          ...(intent.lastOccurrenceAt === undefined ? {} : { lastOccurrenceAt: timestamp(intent.lastOccurrenceAt, 'last future occurrence') }),
          ...(intent.lastOperationId === undefined ? {} : { lastOperationId: string(intent.lastOperationId, 'last future operation') }) }]
      }))
    })() }),
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
    ...(source.terminalOutputChannel === undefined
      ? {}
      : { terminalOutputChannel: terminalOutputChannel(source.terminalOutputChannel, currentRun) }),
    ...(source.semanticStatus === undefined ? {} : { semanticStatus: semanticStatus(source.semanticStatus) }),
    ...(source.pendingInteraction === undefined
      ? {}
      : { pendingInteraction: pendingInteraction(source.pendingInteraction) }),
    ...(source.nativeHandle === undefined ? {} : { nativeHandle: nativeHandle(source.nativeHandle) }),
    ...(source.observedNativeHandle === undefined ? {} : { observedNativeHandle: nativeHandle(source.observedNativeHandle) }),
    ...(source.nativeSourceObservation === undefined ? {} : { nativeSourceObservation: (() => {
      const p = record(source.nativeSourceObservation, 'nativeSourceObservation')
      if (Object.keys(p).some(key => !['state', 'run', 'observedAt', 'reason'].includes(key)) ||
        !['changed', 'unknown', 'ambiguous'].includes(String(p.state))) throw new AgentMuxError('Invalid native source observation.', 'INVALID_AGENT_SESSION_STORE')
      return { state: p.state as 'changed' | 'unknown' | 'ambiguous', run: runRef(p.run),
        observedAt: timestamp(p.observedAt, 'nativeSourceObservation.observedAt'), reason: string(p.reason, 'nativeSourceObservation.reason') }
    })() }),
    ...(source.nativeConfirmation === undefined ? {} : { nativeConfirmation: nativeConfirmation(source.nativeConfirmation) }),
    ...(source.nativeConfirmationHistory === undefined ? {} : { nativeConfirmationHistory: (() => {
      if (!Array.isArray(source.nativeConfirmationHistory)) throw new AgentMuxError('Native confirmation history must be an array.', 'INVALID_AGENT_SESSION_STORE')
      return source.nativeConfirmationHistory.map(nativeConfirmation)
    })() }),
    ...(source.nativeBinding === undefined ? {} : { nativeBinding: (() => {
      const binding = record(source.nativeBinding, 'nativeBinding')
      if (!['native-hook', 'process-witness', 'semantic-resume-target', 'user-confirmed'].includes(String(binding.source))) throw new AgentMuxError('Invalid native binding source.', 'INVALID_AGENT_SESSION_STORE')
      return { source: binding.source as 'native-hook' | 'process-witness' | 'semantic-resume-target' | 'user-confirmed', run: runRef(binding.run), observedAt: timestamp(binding.observedAt, 'nativeBinding.observedAt') }
    })() }),
    ...(source.nativePromptPredecessor === undefined ? {} : { nativePromptPredecessor: (() => {
      const fact = record(source.nativePromptPredecessor, 'nativePromptPredecessor')
      const run = runRef(fact.run), previousRun = runRef(fact.previousRun)
      if (Object.keys(fact).some(key => !['run', 'previousRun', 'sourceId', 'evidenceId'].includes(key)) ||
        run.runId !== currentRun.runId || priorRuns.at(-1)?.runId !== previousRun.runId) {
        throw new AgentMuxError('Native prompt predecessor does not match the exact resumed Run.', 'INVALID_AGENT_SESSION_STORE')
      }
      return { run, previousRun, sourceId: string(fact.sourceId, 'nativePromptPredecessor.sourceId'),
        evidenceId: string(fact.evidenceId, 'nativePromptPredecessor.evidenceId') }
    })() }),
    ...(source.hookReceipt === undefined ? {} : { hookReceipt: hookReceipt(source.hookReceipt) }),
    ...(source.turnUsage === undefined ? {} : { turnUsage: turnUsage(source.turnUsage) })
  }
  const inputKey = session.promptCompletionAdmission?.inputKey
  if (inputKey && (inputKey.agentSessionId !== session.agentSessionId ||
      (inputKey.kind === 'prompt' ? inputKey.submissionId : inputKey.messageId) !== session.promptCompletionAdmission!.submissionId ||
      inputKey.expectedRun.runId !== session.promptCompletionAdmission!.intent?.run.runId)) {
    throw new AgentMuxError('Stored input identity changed its original claim.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (session.terminalPromptReadiness?.source === 'native-stop' &&
    session.terminalPromptReadiness.observedAt !== undefined && session.terminalPromptReadiness.observedAt > session.updatedAt) {
    throw new AgentMuxError('Native turn end observation exceeds the Session time.', 'INVALID_AGENT_SESSION_STORE')
  }
  if ((session.nativeBinding && (!session.nativeHandle || session.nativeBinding.run.runId !== session.run.runId || session.nativeBinding.observedAt > session.updatedAt)) ||
    (session.nativeSourceObservation && (session.nativeSourceObservation.run.runId !== session.run.runId ||
      session.nativeSourceObservation.observedAt > session.updatedAt || session.nativeSourceObservation.state === 'changed' && !session.observedNativeHandle)) ||
    (session.nativeConfirmation && (session.nativeConfirmation.nativeHandle.providerId !== session.providerId ||
      session.nativeConfirmation.observedAt > session.updatedAt || session.nativeConfirmation.candidateObservedAt > session.nativeConfirmation.observedAt ||
      session.nativeConfirmation.previousInteraction && (session.nativeConfirmation.previousInteraction.request.agentSessionId !== session.agentSessionId ||
        session.nativeConfirmation.previousInteraction.request.evidence.run?.runId !== session.nativeConfirmation.run.runId))) ||
    (session.observedNativeHandle?.kind === 'provider' && session.observedNativeHandle.providerId !== session.providerId) ||
    (session.semanticStatus?.aggregateActivityAt !== undefined && session.semanticStatus.aggregateActivityAt > session.updatedAt)) {
    throw new AgentMuxError('Native/activity facts do not match this Session.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (session.nativeHandle?.kind === 'provider'  && session.nativeHandle.providerId !== session.providerId) {
    throw new AgentMuxError('Native session handle provider does not match the Agent.', 'INVALID_AGENT_SESSION_STORE')
  }
  const confirmations = [...(session.nativeConfirmationHistory ?? []), ...(session.nativeConfirmation ? [session.nativeConfirmation] : [])]
  if (new Set(confirmations.map(value => value.operationId)).size !== confirmations.length || confirmations.some(value =>
    value.nativeHandle.providerId !== session.providerId || value.observedAt > session.updatedAt || value.candidateObservedAt > value.observedAt ||
    value.previousInteraction && (value.previousInteraction.request.agentSessionId !== session.agentSessionId ||
      value.previousInteraction.request.evidence.run?.runId !== value.run.runId))) {
    throw new AgentMuxError('Native confirmation history does not match this Session.', 'INVALID_AGENT_SESSION_STORE')
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
  if (session.terminalOutputChannel && session.terminalOutputChannel.observedAt > session.updatedAt) {
    throw new AgentMuxError(
      'Terminal output channel state is newer than its Agent Session.',
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
  const evidence = submission?.readinessEvidence
  if (submission && evidence && (
    evidence.readyThroughByte < evidence.outputCursorBytes ||
    (evidence.source === 'initial-composer' && evidence.readyThroughByte === evidence.outputCursorBytes) ||
    submission.outputCursorBytes < evidence.readyThroughByte
  )) {
    throw new AgentMuxError('Terminal prompt submission does not preserve its readiness boundary.', 'INVALID_AGENT_SESSION_STORE')
  }
  const readiness = session.terminalPromptReadiness
  // A consumed observation may describe an older, completed submission. Only evidence
  // actually associated with this transaction must match its atomic consumption receipt.
  if (submission && evidence && readiness?.id === evidence.id && (
    readiness.source !== evidence.source ||
    readiness.outputCursorBytes !== evidence.outputCursorBytes ||
    readiness.readyThroughByte !== evidence.readyThroughByte ||
    readiness.consumedBySubmissionId !== submission.submissionId
  )) {
    throw new AgentMuxError('Terminal prompt submission did not atomically consume its readiness epoch.', 'INVALID_AGENT_SESSION_STORE')
  }
  return session
}

export function normalizeStoredAgentSession(value: unknown): AgentMuxStoredAgentSession {
  const source = record(value, 'Agent Session')
  return { ...normalizeAgentSession(source),
    hookBindingId: string(source.hookBindingId, 'hookBindingId'),
    hookToken: string(source.hookToken, 'hookToken'),
    ...(source.capabilityHash === undefined ? {} : { capabilityHash: string(source.capabilityHash, 'capabilityHash') }),
    ...(source.activityCommit === undefined ? {} : { activityCommit: activityCommit(source.activityCommit, string(source.agentSessionId, 'agentSessionId')) }) }
}

function normalizeAgentSessions(values: readonly unknown[]): AgentMuxStoredAgentSession[] {
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
 *
 * 同时报出 `complete`：分帧是否覆盖到了记录列表的结尾。只有 complete 时 `blocks.length` 才等于
 * 「盘上原本有多少条记录」，可以充当丢失量的分母；截断（走到 EOF 也没见到闭合的 `]`）或锚点行被
 * 污染时，被抹掉的记录根本不在字节流里，数不出来，分母不可知——差别见 recordCorruptStoreSalvage。
 */
function extractSessionBlocks(content: string): { blocks: string[]; complete: boolean } {
  const lines = content.split('\n')
  const start = lines.indexOf('  "sessions": [')
  // 锚点行都没了：连从哪开始数都不知道，别把「没找到」冒充成「一条都没有」。
  if (start === -1) return { blocks: [], complete: false }
  const blocks: string[] = []
  let current: string[] | null = null
  let closed = false
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (current === null) {
      if (line === '  ]' || line === '  ],') {
        closed = true
        break
      }
      if (/^ {4}\{$/u.test(line)) current = [line]
      continue
    }
    current.push(line)
    if (/^ {4}\},?$/u.test(line)) {
      blocks.push(current.join('\n').replace(/,$/u, ''))
      current = null
    }
  }
  // 见到闭合的 `]` 且没有块悬在半空，才说明这份列表被完整扫过。
  return { blocks, complete: closed && current === null }
}

/** 从原始文本抢救会话：按缩进分帧后逐块 JSON.parse，撕裂/乱码的块解析失败即跳过。 */
function parseSessionBlocks(content: string): unknown[] {
  const values: unknown[] = []
  for (const block of extractSessionBlocks(content).blocks) {
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

export async function loadAgentSessionMetadata(store: AgentMuxAgentSessionStore): Promise<AgentMuxStoredAgentSession[]> {
  return normalizeAgentSessions(await store.loadMetadata())
}

export function agentLifecycleOperationIdentity(kind: 'create' | 'resume' | 'stop' | 'reopen', agentSessionId: string, requestedOperationId: string): string {
  return createHash('sha256').update(JSON.stringify(['agentmux-agent-lifecycle-v1', kind, agentSessionId, requestedOperationId])).digest('base64url')
}

function creationSessionId(sessions: readonly AgentMuxStoredAgentSession[], reservations: readonly AgentMuxLifecycleReservation[], createOperationId: string): string | null {
  const ids = new Set(sessions.filter(session => session.creation?.createOperationId === createOperationId).map(session => session.agentSessionId))
  for (const reservation of reservations) {
    if (reservation.kind === 'create' && (reservation.preparedCreation?.creation?.createOperationId === createOperationId ||
      agentLifecycleOperationIdentity('create', reservation.agentSessionId, createOperationId) === reservation.operationId)) ids.add(reservation.agentSessionId)
  }
  if (ids.size > 1) throw new AgentMuxError('This creation operation names multiple original Sessions. Keep their identities and inspect the original operation.', 'AGENT_CREATION_OPERATION_CONFLICT')
  return ids.values().next().value ?? null
}

function reopenCorrelations(reservations: readonly AgentMuxLifecycleReservation[]) {
  return reservations.filter((reservation): reservation is Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> => reservation.kind === 'reopen')
    .map(reservation => ({ expectedRetirement: structuredClone(reservation.expectedRetirement),
      ...(reservation.callerOperationId && agentLifecycleOperationIdentity('reopen', reservation.agentSessionId, reservation.callerOperationId) === reservation.operationId
        ? { operationId: reservation.callerOperationId } : {}) }))
}

/** One bounded catalogue, derived from the existing durable Store. */
export async function loadSessionHistorySources(store: AgentMuxAgentSessionStore): Promise<AgentSessionHistoryDescriptor[]> {
  const [sessions, retired, correlations] = await Promise.all([loadAgentSessionMetadata(store), store.loadRetiredAgentSessions(), store.loadReopenCorrelations()])
  return sessionHistorySources(sessions, retired, correlations)
}

function sessionHistorySources(
  sessions: readonly AgentMuxStoredAgentSession[], retired: readonly AgentMuxRetiredAgentSession[],
  correlations: readonly ReturnType<typeof reopenCorrelations>[number][]
): AgentSessionHistoryDescriptor[] {
  const activeIds = new Set(sessions.map(session => session.agentSessionId))
  const pending = new Map(correlations.map(correlation => [JSON.stringify(correlation.expectedRetirement), correlation]))
  return [
    ...sessions.map(session => ({ agentSessionId: session.agentSessionId, hostId: session.hostId,
      state: 'active' as const, history: sessionHistoryMetadata(session) })),
    ...retired.filter(session => !activeIds.has(session.agentSessionId)).map(session => ({
      agentSessionId: session.agentSessionId, hostId: session.hostId, state: 'retired' as const,
      retiredAt: session.observedAt,
      ...(pending.has(JSON.stringify(session)) ? { pendingReopen: {
        ...(pending.get(JSON.stringify(session))!.operationId ? { operationId: pending.get(JSON.stringify(session))!.operationId } : {})
      } } : {}),
      ...(session.history === undefined ? {} : { history: structuredClone(session.history) })
    }))
  ]
}

function normalizeLifecycleReservations(
  values: readonly unknown[]
): AgentMuxLifecycleReservation[] {
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
  if (reservation.kind === 'reopen') {
    const retired = retiredSessions.find(session => session.agentSessionId === reservation.agentSessionId)
    if (current || !retired || JSON.stringify(retired) !== JSON.stringify(reservation.expectedRetirement)) {
      throw new AgentMuxError('Agent Session retirement changed before explicit continue.', 'STALE_AGENT_SESSION')
    }
    return
  }
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

function assertPreparedReopen(retirement: AgentMuxRetiredAgentSession, session: AgentMuxStoredAgentSession): void {
  const history = retirement.history
  if (!history || session.agentSessionId !== retirement.agentSessionId || session.hostId !== retirement.hostId ||
    session.providerId !== history.providerId || session.executorId !== history.executorId ||
    session.workspacePath !== history.workspacePath || session.createdAt !== history.createdAt ||
    JSON.stringify(session.nativeHandle) !== JSON.stringify(history.nativeHandle) || session.run.runId !== retirement.run.runId ||
    session.retiredRuns.length !== 0 || !session.hookBindingId || !session.hookToken || !session.capabilityHash) {
    throw new AgentMuxError('Prepared continue identity is invalid.', 'INVALID_AGENT_SESSION_STORE')
  }
}

function preparedCreateReservation(current: AgentMuxLifecycleReservation | undefined,
  requested: Extract<AgentMuxLifecycleReservation, { kind: 'create' }>, seed: AgentMuxPreparedCreation
): Extract<AgentMuxLifecycleReservation, { kind: 'create' }> {
  if (!current || current.kind !== 'create' || !sameReservationOwner(current, requested) || current.operationId !== requested.operationId) throw new AgentMuxError('Creation reservation changed before preparation.', 'STALE_AGENT_SESSION')
  const preparedCreation = normalizePreparedCreation(seed)
  if (preparedCreation.agentSessionId !== current.agentSessionId || current.preparedCreation && !isDeepStrictEqual(current.preparedCreation, preparedCreation)) throw new AgentMuxError('Prepared creation cannot change intent.', 'AGENT_FORK_OPERATION_CONFLICT')
  return { ...current, preparedCreation }
}

/** Atomically reserve a native conversation across different creation operations and Core processes. */
function assertNativeCreationOwner(seed: AgentMuxPreparedCreation, sessions: readonly AgentMuxStoredAgentSession[],
  retired: readonly AgentMuxRetiredAgentSession[], reservations: readonly AgentMuxLifecycleReservation[]): void {
  const source = seed.nativeHandle
  if (source?.kind !== 'provider') return
  const same = (handle: AgentNativeSessionHandle | undefined): boolean => handle?.kind === 'provider' &&
    handle.providerId === source.providerId && handle.sessionId === source.sessionId
  if (sessions.some(session => session.hostId === seed.hostId && (same(session.nativeHandle) ||
      session.nativeSourceObservation?.state === 'changed' && same(session.observedNativeHandle))) ||
      retired.some(session => session.hostId === seed.hostId && same(session.history?.nativeHandle)) ||
      reservations.some(reservation => reservation.agentSessionId !== seed.agentSessionId &&
        (reservation.kind === 'create' && reservation.preparedCreation?.hostId === seed.hostId && same(reservation.preparedCreation.nativeHandle) ||
         reservation.kind === 'reopen' && reservation.expectedRetirement.hostId === seed.hostId && same(reservation.expectedRetirement.history?.nativeHandle)))) {
    throw new AgentMuxError('This native conversation already has an original Core Session or prepared operation. Inspect that identity before continuing.', 'AGENT_NATIVE_SESSION_ALREADY_MANAGED')
  }
}

function claimedCreateReservation(current: AgentMuxLifecycleReservation | undefined, operationId: string, intentDigest: string,
  claim: AgentMuxLifecycleClaim): Extract<AgentMuxLifecycleReservation, { kind: 'create' }> | null {
  if (!current) return null
  if (current.kind !== 'create' || current.operationId !== operationId || current.preparedCreation?.creation?.intentDigest !== intentDigest) throw new AgentMuxError('The original fork creation intent changed or is still preparing.', 'AGENT_FORK_OPERATION_CONFLICT')
  if (!current.ownerReleased && current.ownerId !== claim.ownerId && processIsAlive(current.ownerPid)) throw new AgentMuxError('The original creation owner is still active.', 'AGENT_SESSION_BUSY')
  const { ownerReleased, ...retained } = current
  return { ...retained, ownerId: claim.ownerId, ownerPid: claim.ownerPid, expiresAt: claim.expiresAt }
}

function preparedReopenReservation(current: AgentMuxLifecycleReservation | undefined,
  requested: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>, session: AgentMuxStoredAgentSession
): Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> {
  if (!current || current.kind !== 'reopen' || !sameReservationOwner(current, requested) ||
    current.operationId !== requested.operationId || current.callerOperationId !== requested.callerOperationId || JSON.stringify(current.expectedRetirement) !== JSON.stringify(requested.expectedRetirement)) {
    throw new AgentMuxError('Continue reservation changed before preparation.', 'STALE_AGENT_SESSION')
  }
  const preparedSession = normalizeStoredAgentSession(session)
  assertPreparedReopen(current.expectedRetirement, preparedSession)
  if (current.preparedSession && JSON.stringify(current.preparedSession) !== JSON.stringify(preparedSession)) {
    throw new AgentMuxError('Prepared continue facts cannot be replaced.', 'STALE_AGENT_SESSION')
  }
  return { ...current, preparedSession }
}

function claimedReopenReservation(current: AgentMuxLifecycleReservation | undefined, operationId: string,
  expectedRetiredAt: number, claim: AgentMuxLifecycleClaim
): Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> | null {
  if (!current) return null
  if (current.kind !== 'reopen' || current.operationId !== operationId || current.expectedRetirement.observedAt !== expectedRetiredAt) {
    throw new AgentMuxError('The original continue operation changed.', 'STALE_AGENT_SESSION')
  }
  if (!current.ownerReleased && current.ownerId !== claim.ownerId && processIsAlive(current.ownerPid)) {
    throw new AgentMuxError('The original continue owner is still active.', 'AGENT_SESSION_BUSY')
  }
  const { ownerReleased, ...retained } = current
  return { ...retained, ownerId: claim.ownerId, ownerPid: claim.ownerPid, expiresAt: claim.expiresAt }
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
  if (reservation.kind === 'create' && reservation.preparedCreation) {
    const { run, retiredRuns, creation, terminalPromptReadiness, ...actual } = next
    const { creation: intended, ...prepared } = reservation.preparedCreation
    // Initial composer readiness belongs to the just-started exact Run. It cannot
    // exist in a no-Run preparation; normalizeAgentSession already checks its Run.
    if (terminalPromptReadiness && terminalPromptReadiness.source !== 'initial-composer') throw new AgentMuxError('A creation cannot import another composer readiness epoch.', 'INVALID_AGENT_SESSION_STORE')
    if (!isDeepStrictEqual(actual, prepared) || !isDeepStrictEqual(creation, intended) || retiredRuns.length) throw new AgentMuxError('Creation commit changed its prepared identity or intent.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (reservation.kind === 'reopen') {
    const retirement = reservation.expectedRetirement, history = retirement.history
    if (!history || next.hostId !== retirement.hostId || next.providerId !== history.providerId ||
      next.executorId !== history.executorId || next.workspacePath !== history.workspacePath ||
      next.createdAt !== history.createdAt || JSON.stringify(next.nativeHandle) !== JSON.stringify(history.nativeHandle) ||
      JSON.stringify(next.reopenedFrom) !== JSON.stringify({ run: retirement.run, source: retirement.source, observedAt: retirement.observedAt }) ||
      next.run.runId === retirement.run.runId || !next.retiredRuns.some(run => run.runId === retirement.run.runId)) {
      throw new AgentMuxError('Reopen commit changed its original identity or retirement fact.', 'INVALID_AGENT_SESSION_STORE')
    }
    if (reservation.preparedSession) {
      for (const key of ['hookBindingId', 'hookToken', 'capabilityHash', 'launchOptions'] as const) {
        if (JSON.stringify(next[key]) !== JSON.stringify(reservation.preparedSession[key])) {
          throw new AgentMuxError('Continue commit changed its prepared configuration or credential.', 'INVALID_AGENT_SESSION_STORE')
        }
      }
    }
    return
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
  private readonly promptSubmissions = new Set<string>()
  private readonly sessions = new Map<string, AgentMuxStoredAgentSession>()
  private readonly promptAdmissions = new Map<string, AgentPromptSubmissionRecord>()
  private readonly reservations = new Map<string, AgentMuxLifecycleReservation>()
  private retiredRuns: AgentMuxRunRef[] = []
  private retiredAgentSessions: AgentMuxRetiredAgentSession[] = []
  private readonly timelines = new Map<string, AgentTimelineSnapshot>()

  private promptRecordKey(value: AgentPromptSubmissionRecord): string {
    return JSON.stringify([value.agentSessionId, value.run.runId, promptRecordId(value)])
  }
  /** All metadata, complete and lifecycle writes pass here before moving/removing latest. */
  private setSession(id: string, next: AgentMuxStoredAgentSession | null): void {
    const originals = [...promptAdmissionRecords(this.sessions.get(id)), ...promptAdmissionRecords(next)]
    const writes = new Map<string, AgentPromptSubmissionRecord>()
    for (const value of originals) {
      const key = this.promptRecordKey(value)
      assertPromptRecordWrite(writes.get(key) ?? this.promptAdmissions.get(key), value)
      writes.set(key, value)
    }
    for (const [key, value] of writes) this.promptAdmissions.set(key, value)
    if (next) this.sessions.set(id, next)
    else this.sessions.delete(id)
  }

  async readPromptAdmission(agentSessionId: string, run: AgentMuxRunRef, submissionId: string): Promise<AgentPromptSubmissionRecord | null> {
    const originals = ['submission', 'original-slot'].flatMap(kind => {
      const value = this.promptAdmissions.get(JSON.stringify([agentSessionId, run.runId, JSON.stringify([kind, submissionId])]))
      return value ? [value] : []
    })
    if (originals.length > 1) throw new AgentMuxError('The original input location is ambiguous.', 'AGENT_PROMPT_OPERATION_CONFLICT')
    return structuredClone(originals[0] ?? null)
  }

  async settlePromptAdmission(expected: AgentPromptSubmissionRecord, next: AgentPromptSubmissionRecord, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted(); assertPromptRecordWrite(expected, next, true); assertPromptSettlement(expected, next)
    const key = this.promptRecordKey(expected), current = this.promptAdmissions.get(key)
    if (!isDeepStrictEqual(current, expected)) throw new AgentMuxError('The original Native receipt changed.', 'STALE_AGENT_SESSION')
    const latest = this.sessions.get(expected.agentSessionId), projected = promptAdmissionRecord(latest)
    this.promptAdmissions.set(key, structuredClone(next))
    if (latest && projected && this.promptRecordKey(projected) === key) {
      this.sessions.set(latest.agentSessionId, { ...latest, promptCompletionAdmission: structuredClone(next.admission!),
        updatedAt: Math.max(latest.updatedAt, Date.now()) })
    }
  }

  async withPromptSubmission<T>(agentSessionId: string, operation: () => Promise<T>): Promise<T> {
    string(agentSessionId, 'agentSessionId')
    if (this.promptSubmissions.has(agentSessionId)) {
      throw new AgentMuxError('Another Client is delivering a prompt for this Session. Keep this message and retry.', 'AGENT_PROMPT_SUBMISSION_BUSY')
    }
    this.promptSubmissions.add(agentSessionId)
    try {
      return await operation()
    } finally {
      this.promptSubmissions.delete(agentSessionId)
    }
  }

  async confirmDurability(agentSessionId: string, expectedRun: AgentMuxRunRef, expectedSession: AgentMuxStoredAgentSession): Promise<void> {
    const current = this.sessions.get(agentSessionId)
    if (!current || current.run.runId !== expectedRun.runId || !sameSession(agentSessionMetadata(current), agentSessionMetadata(expectedSession))) {
      throw new AgentMuxError('Session snapshot changed before confirmation. Refresh the original binding and retry.', 'STALE_AGENT_SESSION')
    }
  }

  async load(): Promise<readonly unknown[]> {
    return [...this.sessions.values()].map((session) => structuredClone(session))
  }

  async loadMetadata(): Promise<readonly AgentMuxStoredAgentSession[]> {
    return [...this.sessions.values()].map(session => structuredClone(agentSessionMetadata(session)))
  }
  async readMetadata(agentSessionId: string): Promise<AgentMuxStoredAgentSession | null> {
    const value = this.sessions.get(agentSessionId)
    return value ? structuredClone(agentSessionMetadata(value)) : null
  }
  async readHistorySource(agentSessionId: string): Promise<AgentSessionHistoryDescriptor | null> {
    const active = this.sessions.get(agentSessionId)
    const retired = active ? undefined : this.retiredAgentSessions.find(session => session.agentSessionId === agentSessionId)
    const reservation = this.reservations.get(agentSessionId)
    return sessionHistorySources(active ? [active] : [], retired ? [retired] : [],
      reservation ? reopenCorrelations([reservation]) : [])[0] ?? null
  }
  async readFuturePromptIntent(agentSessionId: string, intentId: string): Promise<AgentFuturePromptIntent | null> {
    return structuredClone(this.sessions.get(agentSessionId)?.futurePromptIntents?.[intentId] ?? null)
  }
  async listFuturePromptIntents(agentSessionId: string, options: { afterIntentId?: string; limit?: number } = {}): Promise<AgentMuxFuturePromptPage> {
    const limit = futurePageLimit(options.limit)
    const entries = Object.entries(this.sessions.get(agentSessionId)?.futurePromptIntents ?? {})
    const index = options.afterIntentId === undefined ? -1 : entries.findIndex(([id]) => id === options.afterIntentId)
    if (options.afterIntentId !== undefined && index < 0) throw new AgentMuxError('Future-message cursor does not name an original intent.', 'INVALID_CONTROL_REQUEST')
    return futurePromptPage(entries.slice(index + 1, index + 2 + limit).map(([intentId, intent]) => ({ intentId, intent: structuredClone(intent) })), limit)
  }
  async compareAndSwapMetadata(expected: AgentMuxStoredAgentSession | null, next: AgentMuxStoredAgentSession | null,
    signal?: AbortSignal, future?: AgentMuxSessionFutureChange, author?: Readonly<AgentCapabilityBinding>): Promise<void> {
    signal?.throwIfAborted()
    if (author) {
      const currentAuthor = this.sessions.get(author.agentSessionId)
      assertCurrentAgentCapabilityBinding(author, currentAuthor ? { agentSessionId: currentAuthor.agentSessionId,
        workspacePath: currentAuthor.workspacePath, runId: currentAuthor.run.runId, capabilityHash: currentAuthor.capabilityHash ?? '' } : null)
      if (this.reservations.has(author.agentSessionId)) throw new AgentMuxError('The original message author has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
    }
    const id = expected?.agentSessionId ?? next?.agentSessionId
    if (!id || expected && next && expected.agentSessionId !== next.agentSessionId) throw new AgentMuxError('Agent Session CAS identity is invalid.', 'INVALID_AGENT_SESSION_STORE')
    const current = this.sessions.get(id) ?? null
    if (!sameSession(current ? agentSessionMetadata(current) : null, expected)) throw new AgentMuxError('Agent Session changed before persistence completed.', 'STALE_AGENT_SESSION')
    if (future && !isDeepStrictEqual(current?.futurePromptIntents?.[future.intentId] ?? null, future.expected)) throw new AgentMuxError('The exact future intent changed before admission.', 'AGENT_FUTURE_INTENT_CHANGED')
    const reservation = this.reservations.get(id)
    if (reservation && (!next || !expected || next.run.runId !== expected.run.runId)) throw new AgentMuxError('Agent Session has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
    if (!next) { this.setSession(id, null); this.timelines.delete(id); return }
    const normalized = normalizeStoredAgentSession(agentSessionMetadata(next))
    const values = [...this.sessions.values()].filter(session => session.agentSessionId !== id).map(agentSessionMetadata)
    const all = normalizeAgentSessions([...values, normalized])
    assertUnboundRetiredRuns(all, this.retiredRuns); assertRetiredAgentSessions(all, this.retiredRuns, this.retiredAgentSessions)
    for (const original of promptAdmissionRecords(normalized)) assertPromptRecordWrite(this.promptAdmissions.get(this.promptRecordKey(original)), original)
    let intents = current?.futurePromptIntents
    if (future) {
      string(future.intentId, 'future intent id')
      const value = future.next === null ? null : normalizeStoredAgentSession({ ...normalized,
        futurePromptIntents: { [future.intentId]: future.next } }).futurePromptIntents![future.intentId]!
      // The Store owns this map and all reads clone their result. Mutate one entry only
      // after validation; copying every unrelated key would recreate the same growth cost.
      intents ??= {}
      if (future.next === null) delete intents[future.intentId]
      else intents[future.intentId] = value!
    }
    this.setSession(id, { ...normalized, ...(intents === undefined ? {} : { futurePromptIntents: intents }) })
  }

  async loadRetiredRuns(): Promise<readonly AgentMuxRunRef[]> {
    return this.retiredRuns.map((run) => ({ ...run }))
  }

  async loadRetiredAgentSessions(): Promise<readonly AgentMuxRetiredAgentSession[]> {
    return structuredClone(this.retiredAgentSessions)
  }

  async loadReopenCorrelations() {
    return reopenCorrelations([...this.reservations.values()])
  }

  async loadCreationSessionId(createOperationId: string): Promise<string | null> {
    return creationSessionId([...this.sessions.values()], [...this.reservations.values()], createOperationId)
  }

  async loadCreationCorrelation(agentSessionId: string) {
    const reservation = this.reservations.get(agentSessionId)
    return reservation?.kind === 'create' ? structuredClone(reservation) : null
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
      this.setSession(agentSessionId, structuredClone(normalized))
    } else {
      this.setSession(agentSessionId, null)
      this.timelines.delete(agentSessionId)
    }
  }

  async reserveLifecycle(value: AgentMuxLifecycleReservation): Promise<void> {
    const reservation = lifecycleReservation(value)
    if (this.reservations.has(reservation.agentSessionId)) {
      throw new AgentMuxError('Agent Session already has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
    }
    assertReservationPrecondition(
      reservation,
      [...this.sessions.values()],
      this.retiredAgentSessions
    )
    this.reservations.set(reservation.agentSessionId, structuredClone(reservation))
  }

  async prepareReopen(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>, session: AgentMuxStoredAgentSession): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>> {
    const next = preparedReopenReservation(this.reservations.get(reservation.agentSessionId), reservation, session)
    assertReservationPrecondition(next, [...this.sessions.values()], this.retiredAgentSessions)
    this.reservations.set(next.agentSessionId, structuredClone(next))
    return structuredClone(next)
  }

  async prepareCreate(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'create' }>, seed: AgentMuxPreparedCreation): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'create' }>> {
    const next = preparedCreateReservation(this.reservations.get(reservation.agentSessionId), reservation, seed)
    assertReservationPrecondition(next, [...this.sessions.values()], this.retiredAgentSessions)
    assertNativeCreationOwner(next.preparedCreation!, [...this.sessions.values()], this.retiredAgentSessions, [...this.reservations.values()])
    this.reservations.set(next.agentSessionId, structuredClone(next))
    return structuredClone(next)
  }

  async claimCreate(agentSessionId: string, operationId: string, intentDigest: string, claim: AgentMuxLifecycleClaim): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'create' }> | null> {
    const next = claimedCreateReservation(this.reservations.get(agentSessionId), operationId, intentDigest, claim)
    if (next) this.reservations.set(agentSessionId, structuredClone(next))
    return next ? structuredClone(next) : null
  }

  async releaseReopenOwner(ownerId: string): Promise<void> {
    for (const [id, reservation] of this.reservations) {
      if ((reservation.kind === 'reopen' || reservation.kind === 'create' && reservation.preparedCreation) && reservation.ownerId === ownerId) this.reservations.set(id, { ...reservation, ownerReleased: true })
    }
  }

  async claimReopen(agentSessionId: string, operationId: string, expectedRetiredAt: number, claim: AgentMuxLifecycleClaim): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> | null> {
    const next = claimedReopenReservation(this.reservations.get(agentSessionId), operationId, expectedRetiredAt, claim)
    if (next) this.reservations.set(agentSessionId, structuredClone(next))
    return next ? structuredClone(next) : null
  }

  async claimStaleLifecycles(claim: AgentMuxLifecycleClaim, target?: { agentSessionId: string; expectedRun: AgentMuxRunRef }): Promise<AgentMuxLifecycleReservation[]> {
    const claimed: AgentMuxLifecycleReservation[] = []
    const original = target ? this.reservations.get(target.agentSessionId) : undefined
    const candidates: Iterable<[string, AgentMuxLifecycleReservation]> = target
      ? original ? [[target.agentSessionId, original]] : [] : this.reservations
    for (const [agentSessionId, reservation] of candidates) {
      if (target && (reservation.kind !== 'stop' || reservation.expectedRun.runId !== target.expectedRun.runId)) continue
      if (
        !((reservation.kind === 'reopen' || reservation.kind === 'create') && reservation.ownerReleased) && reservation.ownerId !== claim.ownerId &&
        processIsAlive(reservation.ownerPid)
      ) continue
      const next = lifecycleReservation({
        ...reservation,
        ...(reservation.kind === 'reopen' || reservation.kind === 'create' ? { ownerReleased: undefined } : {}),
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
    const retainedSessions = retiredAgentSessionsForRuns(this.retiredAgentSessions, merged)
    assertUnboundRetiredRuns([...this.sessions.values()], merged)
    assertRetiredAgentSessions(
      [...this.sessions.values()],
      merged,
      retainedSessions
    )
    this.retiredRuns = merged
    this.retiredAgentSessions = retainedSessions
    this.pruneTimelines()
    this.reservations.delete(reservation.agentSessionId)
  }

  async retireRuns(runs: readonly AgentMuxRunRef[]): Promise<void> {
    const merged = mergeRetiredRuns(this.retiredRuns, runs)
    const retainedSessions = retiredAgentSessionsForRuns(this.retiredAgentSessions, merged)
    assertUnboundRetiredRuns([...this.sessions.values()], merged)
    assertRetiredAgentSessions(
      [...this.sessions.values()],
      merged,
      retainedSessions
    )
    this.retiredRuns = merged
    this.retiredAgentSessions = retainedSessions
    this.pruneTimelines()
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
    assertLifecycleCommit(currentReservation, normalized)
    const values = [...this.sessions.values()].filter(
      (session) => session.agentSessionId !== reservation.agentSessionId
    )
    if (normalized) values.push(normalized)
    const sessions = normalizeAgentSessions(values)
    const retiredRuns = reservation.kind === 'stop' && previous
      ? mergeRetiredRuns(this.retiredRuns, [...previous.retiredRuns, previous.run])
      : reservation.kind === 'reopen'
        ? this.retiredRuns.filter(run => run.runId !== reservation.expectedRetirement.run.runId)
        : this.retiredRuns
    const retiredAgentSessions = retiredAgentSessionsForRuns(
      reservation.kind === 'stop' && previous
        ? mergeRetiredAgentSessions(this.retiredAgentSessions, [{
            agentSessionId: previous.agentSessionId,
            hostId: previous.hostId,
            run: { ...previous.run },
            source: 'user',
            observedAt: Date.now(),
            history: sessionHistoryMetadata(previous),
            ...(previous.activityCommit ? { activityCommit: previous.activityCommit } : {})
          }])
        : this.retiredAgentSessions,
      retiredRuns
    )
    assertUnboundRetiredRuns(sessions, retiredRuns)
    assertRetiredAgentSessions(sessions, retiredRuns, retiredAgentSessions)
    if (normalized) {
      if (reservation.kind === 'create') this.timelines.delete(normalized.agentSessionId)
      this.setSession(normalized.agentSessionId, structuredClone(normalized))
    } else {
      this.setSession(reservation.agentSessionId, null)
    }
    this.retiredRuns = retiredRuns
    this.retiredAgentSessions = retiredAgentSessions
    this.pruneTimelines()
    this.reservations.delete(reservation.agentSessionId)
  }

  private pruneTimelines(): void {
    const retained = new Set([...this.sessions.keys(), ...this.retiredAgentSessions.map(session => session.agentSessionId)])
    for (const id of this.timelines.keys()) if (!retained.has(id)) this.timelines.delete(id)
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
    if (!this.sessions.has(canonicalMutation.agentSessionId) &&
      !acceptedRetiredActivity(this.retiredAgentSessions, canonicalMutation)) {
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
// Compaction is maintenance, never an admission limit or a reason to trim history.
const TIMELINE_COMPACTION_BYTES = 4 * 1024 * 1024

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
  // or re-derive userData. Without an explicit Store, Core owns its user-level durable location.
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
  return join(defaultAgentMuxStateDirectory(), 'agent-sessions.json')
}

const requireNative = createRequire(import.meta.url)

function sessionStorageFailure(error: unknown, stage: string, cleanup: unknown[] = []): Error {
  // Keep business and durability receipts intact: their identity controls Run retention.
  const failure = error instanceof AgentMuxError || error instanceof Error && error.name === 'AbortError'
    ? error : new AgentMuxError('Session persistence is unavailable. Keep its original binding and retry the same operation.',
      'AGENT_SESSION_STORE_UNAVAILABLE', JSON.stringify({ stage, cause: error instanceof Error
        ? { name: error.name, message: error.message, ...('code' in error ? { code: error.code } : {}), ...('errcode' in error ? { errcode: error.errcode } : {}) }
        : String(error) }))
  if (failure !== error) Object.defineProperty(failure, 'cause', { value: error, configurable: true })
  if (cleanup.length) Object.defineProperty(failure, 'cleanup', { value: cleanup, configurable: true })
  return failure
}

/** Confirmed readable replacement or unknown COMMIT outcome; neither is a durable success ACK. */
export class AgentMuxSessionDurabilityError extends AgentMuxError {
  readonly replacementApplied: boolean
  constructor(cause: unknown, readonly commitOutcome: 'applied' | 'unknown' = 'applied') {
    super(commitOutcome === 'applied'
      ? 'The Session is readable, but its durable save is not confirmed. Its Run is retained; retry save confirmation.'
      : 'The Session commit outcome is unknown. Its Run is retained; read its original binding and retry save confirmation.',
      'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED', JSON.stringify({ commitOutcome, cause: cause instanceof Error ? { name: cause.name, message: cause.message, ...('code' in cause ? { code: cause.code } : {}), ...('errcode' in cause ? { errcode: cause.errcode } : {}) } : String(cause) }))
    this.replacementApplied = commitOutcome === 'applied'
    Object.defineProperty(this, 'cause', { value: cause, configurable: true })
  }
}

export class AgentMuxFileAgentSessionStore implements AgentMuxAgentSessionStore {
  private tail: Promise<void> = Promise.resolve()
  private pendingLockRelease: (() => Promise<void>) | null = null
  /** 已报过的抢救事件（键是隔离文件的内容寻址路径），防同一份坏字节在一次加载里刷多条告警。 */
  private readonly reportedSalvages = new Set<string>()

  private database: DatabaseSync | undefined
  private dirty = false

  private async timelineMutationAllowed(mutation: AgentTimelineMutation, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    if (this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(mutation.agentSessionId)) return true
    const row = this.db.prepare('SELECT json FROM retired_sessions WHERE id=?').get(mutation.agentSessionId)
    return !!row && acceptedRetiredActivity([JSON.parse(String(row.json)) as AgentMuxRetiredAgentSession], mutation)
  }

  private get db(): DatabaseSync {
    if (!this.database) throw new Error('Session database requires its original owner lock.')
    return this.database
  }

  constructor(readonly path = defaultAgentMuxAgentSessionStorePath()) {}

  async withPromptSubmission<T>(agentSessionId: string, operation: () => Promise<T>): Promise<T> {
    string(agentSessionId, 'agentSessionId')
    const native: { tryLock(fd: number): boolean } = requireNative('fs-native-extensions')
    const directory = `${this.path}.prompt-locks`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const key = createHash('sha256').update(agentSessionId).digest('hex')
    // Never unlink or replace this file: all contenders must lock the same stable inode.
    const handle = await open(join(directory, key), 'a+', 0o600)
    try {
      if (!native.tryLock(handle.fd)) {
        throw new AgentMuxError('Another Client is delivering a prompt for this Session. Keep this message and retry.', 'AGENT_PROMPT_SUBMISSION_BUSY')
      }
      return await operation()
    } finally {
      await handle.close()
    }
  }

  async confirmDurability(agentSessionId: string, expectedRun: AgentMuxRunRef, expectedSession: AgentMuxStoredAgentSession): Promise<void> {
    await this.enqueue(async () => {
      const current = this.sessionMetadata(this.db, agentSessionId)
      if (!current || current.run.runId !== expectedRun.runId || !sameSession(current, agentSessionMetadata(expectedSession))) {
        throw new AgentMuxError('Session snapshot changed before confirmation. Refresh the original binding and retry.', 'STALE_AGENT_SESSION')
      }
      this.dirty = true // A previous lost sync ACK must be confirmed, even without new rows.
    })
  }

  async load(): Promise<readonly unknown[]> {
    await this.tail
    const result = await this.withReadDatabase(db => db.prepare('SELECT id FROM sessions ORDER BY rowid').all()
      .map(row => this.completeSession(db, String(row.id))!), document => document.sessions)
    await this.sweepOrphanTimelines()
    return result
  }

  private async sweepOrphanTimelines(): Promise<void> {
    let release: (() => Promise<void>) | undefined
    try {
      release = await this.acquireLock(undefined, 1)
      const current = await readCurrentSessionDatabase(this.path)
      if (!current) return // Partial original-file rescue is not authoritative membership for deletion.
      current.close()
      await this.maintainTimelineFiles(await this.read())
    } catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'AGENT_SESSION_STORE_BUSY') throw error
    } finally { await release?.() }
  }

  async loadMetadata(): Promise<readonly AgentMuxStoredAgentSession[]> {
    await this.tail
    return await this.withReadDatabase(db => this.sessionCatalog(db), document => document.sessions.map(agentSessionMetadata))
  }

  async readMetadata(agentSessionId: string): Promise<AgentMuxStoredAgentSession | null> {
    await this.tail
    return await this.withReadDatabase(db => this.sessionMetadata(db, agentSessionId),
      document => {
        const value = document.sessions.find(session => session.agentSessionId === agentSessionId)
        return value ? agentSessionMetadata(value) : null
      })
  }

  private promptAdmission(db: DatabaseSync, agentSessionId: string, run: AgentMuxRunRef, submissionId: string): AgentPromptSubmissionRecord | null {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='prompt_admissions'").get()) {
      const rows = db.prepare('SELECT record_id,json FROM prompt_admissions WHERE session_id=? AND run_id=? AND record_id IN (?, ?)')
        .all(agentSessionId, run.runId, JSON.stringify(['submission', submissionId]), JSON.stringify(['original-slot', submissionId]))
      if (rows.length > 1) throw new AgentMuxError('The original input location is ambiguous.', 'AGENT_PROMPT_OPERATION_CONFLICT')
      if (rows[0]) {
        const original = parsePromptSubmissionRecord(JSON.parse(String(rows[0].json)))
        if (original.agentSessionId !== agentSessionId || original.run.runId !== run.runId || promptRecordId(original) !== rows[0].record_id) throw new AgentMuxError(
          'The original input object does not match its stored location.', 'INVALID_AGENT_SESSION_STORE')
        return original
      }
    }
    // An old database may still have only its original latest slot. Reading that
    // object does not backfill a producer, input key, generation or receipt.
    return promptAdmissionRecords(this.sessionMetadata(db, agentSessionId)).find(original => original.run.runId === run.runId &&
      [JSON.stringify(['submission', submissionId]), JSON.stringify(['original-slot', submissionId])].includes(promptRecordId(original))) ?? null
  }

  async readPromptAdmission(agentSessionId: string, run: AgentMuxRunRef, submissionId: string): Promise<AgentPromptSubmissionRecord | null> {
    await this.tail
    return await this.withReadDatabase(db => this.promptAdmission(db, agentSessionId, run, submissionId), document => {
      return promptAdmissionRecords(document.sessions.find(s => s.agentSessionId === agentSessionId)).find(original => original.run.runId === run.runId &&
        [JSON.stringify(['submission', submissionId]), JSON.stringify(['original-slot', submissionId])].includes(promptRecordId(original))) ?? null
    })
  }

  async settlePromptAdmission(expected: AgentPromptSubmissionRecord, next: AgentPromptSubmissionRecord, signal?: AbortSignal): Promise<void> {
    assertPromptRecordWrite(expected, next, true); assertPromptSettlement(expected, next)
    await this.enqueue(async () => {
      const id = expected.admission!.submissionId!
      const original = this.promptAdmission(this.db, expected.agentSessionId, expected.run, id)
      if (!isDeepStrictEqual(original, expected)) throw new AgentMuxError('The original Native receipt changed.', 'STALE_AGENT_SESSION')
      const latest = this.sessionMetadata(this.db, expected.agentSessionId), projected = promptAdmissionRecord(latest)
      if (latest && projected && projected.run.runId === expected.run.runId && promptRecordId(projected) === promptRecordId(expected)) {
        this.saveSession(this.db, { ...latest, promptCompletionAdmission: structuredClone(next.admission!),
          updatedAt: Math.max(latest.updatedAt, Date.now()) }, false, true)
      }
      this.savePromptAdmission(this.db, next, true)
      this.dirty = true
    }, signal)
  }

  async readHistorySource(agentSessionId: string): Promise<AgentSessionHistoryDescriptor | null> {
    await this.tail
    return await this.withReadDatabase(db => {
      const active = this.sessionMetadata(db, agentSessionId)
      if (active) return sessionHistorySources([active], [], [])[0]!
      const row = db.prepare('SELECT json FROM retired_sessions WHERE id=?').get(agentSessionId)
      if (!row) return null
      const retired = retiredAgentSession(JSON.parse(String(row.json)))
      const pending = db.prepare('SELECT json FROM reservations WHERE id=?').get(agentSessionId)
      return sessionHistorySources([], [retired], pending ? reopenCorrelations([lifecycleReservation(JSON.parse(String(pending.json)))]) : [])[0]!
    }, document => sessionHistorySources(
      document.sessions.filter(session => session.agentSessionId === agentSessionId),
      document.retiredAgentSessions.filter(session => session.agentSessionId === agentSessionId),
      reopenCorrelations(document.reservations.filter(reservation => reservation.agentSessionId === agentSessionId))
    )[0] ?? null)
  }

  async readFuturePromptIntent(agentSessionId: string, intentId: string): Promise<AgentFuturePromptIntent | null> {
    await this.tail
    return await this.withReadDatabase(db => this.futureIntent(db, agentSessionId, intentId),
      document => structuredClone(document.sessions.find(session => session.agentSessionId === agentSessionId)?.futurePromptIntents?.[intentId] ?? null))
  }

  async listFuturePromptIntents(agentSessionId: string, options: { afterIntentId?: string; limit?: number } = {}): Promise<AgentMuxFuturePromptPage> {
    await this.tail
    const limit = futurePageLimit(options.limit)
    return await this.withReadDatabase(db => {
      const cursor = options.afterIntentId === undefined ? null : db.prepare(
        'SELECT ordinal FROM future_intents WHERE session_id=? AND intent_id=?').get(agentSessionId, options.afterIntentId)
      if (options.afterIntentId !== undefined && !cursor) throw new AgentMuxError('Future-message cursor does not name an original intent.', 'INVALID_CONTROL_REQUEST')
      const rows = db.prepare('SELECT intent_id, json FROM future_intents WHERE session_id=? AND ordinal>? ORDER BY ordinal LIMIT ?')
        .all(agentSessionId, cursor ? Number(cursor.ordinal) : 0, limit + 1)
      return futurePromptPage(rows.map(row => ({ intentId: String(row.intent_id), intent: JSON.parse(String(row.json)) as AgentFuturePromptIntent })), limit)
    }, document => {
      const entries = Object.entries(document.sessions.find(session => session.agentSessionId === agentSessionId)?.futurePromptIntents ?? {})
      const index = options.afterIntentId === undefined ? -1 : entries.findIndex(([id]) => id === options.afterIntentId)
      if (options.afterIntentId !== undefined && index < 0) throw new AgentMuxError('Future-message cursor does not name an original intent.', 'INVALID_CONTROL_REQUEST')
      return futurePromptPage(entries.slice(index + 1, index + 2 + limit).map(([intentId, intent]) => ({ intentId, intent })), limit)
    })
  }

  async compareAndSwapMetadata(expected: AgentMuxStoredAgentSession | null, next: AgentMuxStoredAgentSession | null,
    signal?: AbortSignal, future?: AgentMuxSessionFutureChange, author?: Readonly<AgentCapabilityBinding>): Promise<void> {
    await this.enqueue(async () => { await this.swapSession(expected, next, false, signal, future, author) }, signal)
  }

  async loadRetiredRuns(): Promise<readonly AgentMuxRunRef[]> {
    await this.tail
    return await this.withReadDatabase(db => db.prepare('SELECT json FROM retired_runs ORDER BY rowid').all()
      .map(row => runRef(JSON.parse(String(row.json)))), document => document.retiredRuns)
  }

  async loadRetiredAgentSessions(): Promise<readonly AgentMuxRetiredAgentSession[]> {
    await this.tail
    return await this.withReadDatabase(db => db.prepare('SELECT json FROM retired_sessions ORDER BY rowid').all()
      .map(row => retiredAgentSession(JSON.parse(String(row.json)))), document => structuredClone(document.retiredAgentSessions))
  }

  async loadReopenCorrelations() {
    await this.tail
    return await this.withReadDatabase(db => reopenCorrelations(db.prepare("SELECT json FROM reservations WHERE json_extract(json,'$.kind')='reopen'").all()
      .map(row => lifecycleReservation(JSON.parse(String(row.json))))), document => reopenCorrelations(document.reservations))
  }

  async loadCreationSessionId(createOperationId: string): Promise<string | null> {
    await this.tail
    return await this.withReadDatabase(db => creationSessionId(
      db.prepare('SELECT json FROM sessions WHERE creation_operation=?').all(createOperationId).map(row => normalizeStoredAgentSession(JSON.parse(String(row.json)))),
      db.prepare("SELECT json FROM reservations WHERE json_extract(json,'$.kind')='create'").all().map(row => lifecycleReservation(JSON.parse(String(row.json)))), createOperationId),
      document => creationSessionId(document.sessions, document.reservations, createOperationId))
  }

  async loadCreationCorrelation(agentSessionId: string) {
    await this.tail
    return await this.withReadDatabase(db => {
      const row = db.prepare('SELECT json FROM reservations WHERE id=?').get(agentSessionId)
      const value = row ? lifecycleReservation(JSON.parse(String(row.json))) : null
      return value?.kind === 'create' ? value : null
    }, document => {
      const value = document.reservations.find(value => value.agentSessionId === agentSessionId)
      return value?.kind === 'create' ? structuredClone(value) : null
    })
  }

  async compareAndSwap(expected: AgentMuxStoredAgentSession | null, next: AgentMuxStoredAgentSession | null, signal?: AbortSignal): Promise<void> {
    await this.enqueue(async () => { await this.swapSession(expected, next, true, signal) }, signal)
  }

  private async swapSession(expected: AgentMuxStoredAgentSession | null, next: AgentMuxStoredAgentSession | null,
    complete: boolean, signal?: AbortSignal, future?: AgentMuxSessionFutureChange, author?: Readonly<AgentCapabilityBinding>): Promise<void> {
    signal?.throwIfAborted()
    if (author) {
      const currentAuthor = this.sessionMetadata(this.db, author.agentSessionId)
      assertCurrentAgentCapabilityBinding(author, currentAuthor ? { agentSessionId: currentAuthor.agentSessionId,
        workspacePath: currentAuthor.workspacePath, runId: currentAuthor.run.runId, capabilityHash: currentAuthor.capabilityHash ?? '' } : null)
      if (this.db.prepare('SELECT 1 FROM reservations WHERE id=?').get(author.agentSessionId)) throw new AgentMuxError('The original message author has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
    }
    const id = expected?.agentSessionId ?? next?.agentSessionId
    if (!id || expected && next && expected.agentSessionId !== next.agentSessionId) throw new AgentMuxError('Agent Session CAS identity is invalid.', 'INVALID_AGENT_SESSION_STORE')
    const current = complete ? this.completeSession(this.db, id) : this.sessionMetadata(this.db, id)
    if (!sameSession(current, expected)) throw new AgentMuxError('Agent Session changed before persistence completed.', 'STALE_AGENT_SESSION')
    const reservation = this.db.prepare('SELECT 1 FROM reservations WHERE id=?').get(id)
    if (reservation && (!next || !expected || next.run.runId !== expected.run.runId)) throw new AgentMuxError('Agent Session has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
    if (future && !isDeepStrictEqual(this.futureIntent(this.db, id, future.intentId), future.expected)) throw new AgentMuxError('The exact future intent changed before admission.', 'AGENT_FUTURE_INTENT_CHANGED')
    if (next && !expected) await this.removeTimelineFile(id)
    if (next) this.saveSession(this.db, normalizeStoredAgentSession(complete ? next : agentSessionMetadata(next)), complete)
    else this.deleteSession(this.db, id)
    if (future && !isDeepStrictEqual(future.expected, future.next)) this.saveFutureIntent(this.db, id, future)
    this.dirty = true
    if (!next) await this.removeTimelineFile(id).catch(() => {})
  }

  async reserveLifecycle(value: AgentMuxLifecycleReservation): Promise<void> {
    await this.enqueue(async () => {
      const reservation = lifecycleReservation(value)
      const document = await this.read()
      if (document.reservations.some((item) => item.agentSessionId === reservation.agentSessionId)) {
        throw new AgentMuxError('Agent Session already has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
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

  async prepareReopen(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>, session: AgentMuxStoredAgentSession): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>> {
    let next: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> | undefined
    await this.enqueue(async () => {
      const document = await this.read()
      next = preparedReopenReservation(document.reservations.find(item => item.agentSessionId === reservation.agentSessionId), reservation, session)
      assertReservationPrecondition(next, document.sessions, document.retiredAgentSessions)
      await this.write({ ...document, reservations: document.reservations.map(item => item.agentSessionId === next!.agentSessionId ? next! : item) })
    })
    return structuredClone(next!)
  }

  async prepareCreate(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'create' }>, seed: AgentMuxPreparedCreation): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'create' }>> {
    let next: Extract<AgentMuxLifecycleReservation, { kind: 'create' }> | undefined
    await this.enqueue(async () => {
      const document = await this.read()
      next = preparedCreateReservation(document.reservations.find(item => item.agentSessionId === reservation.agentSessionId), reservation, seed)
      assertReservationPrecondition(next, document.sessions, document.retiredAgentSessions)
      assertNativeCreationOwner(next.preparedCreation!, document.sessions, document.retiredAgentSessions, document.reservations)
      await this.write({ ...document, reservations: document.reservations.map(item => item.agentSessionId === reservation.agentSessionId ? next! : item) })
    })
    return structuredClone(next!)
  }

  async claimCreate(agentSessionId: string, operationId: string, intentDigest: string, claim: AgentMuxLifecycleClaim): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'create' }> | null> {
    let next: Extract<AgentMuxLifecycleReservation, { kind: 'create' }> | null = null
    await this.enqueue(async () => {
      const document = await this.read()
      next = claimedCreateReservation(document.reservations.find(item => item.agentSessionId === agentSessionId), operationId, intentDigest, claim)
      if (next) await this.write({ ...document, reservations: document.reservations.map(item => item.agentSessionId === agentSessionId ? next! : item) })
    })
    return next ? structuredClone(next) : null
  }

  async releaseReopenOwner(ownerId: string): Promise<void> {
    await this.enqueue(async () => {
      const document = await this.read()
      const retained = (item: AgentMuxLifecycleReservation) => (item.kind === 'reopen' || item.kind === 'create' && item.preparedCreation) && item.ownerId === ownerId
      if (!document.reservations.some(retained)) return
      await this.write({ ...document, reservations: document.reservations.map(item => retained(item) ? { ...item, ownerReleased: true } : item) })
    })
  }

  async claimReopen(agentSessionId: string, operationId: string, expectedRetiredAt: number, claim: AgentMuxLifecycleClaim): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> | null> {
    let next: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> | null = null
    await this.enqueue(async () => {
      const document = await this.read()
      next = claimedReopenReservation(document.reservations.find(item => item.agentSessionId === agentSessionId), operationId, expectedRetiredAt, claim)
      if (next) await this.write({ ...document, reservations: document.reservations.map(item => item.agentSessionId === agentSessionId ? next! : item) })
    })
    return next ? structuredClone(next) : null
  }

  async claimStaleLifecycles(claim: AgentMuxLifecycleClaim, target?: { agentSessionId: string; expectedRun: AgentMuxRunRef }): Promise<AgentMuxLifecycleReservation[]> {
    let claimed: AgentMuxLifecycleReservation[] = []
    await this.enqueue(async () => {
      if (target) {
        const row = this.db.prepare('SELECT json FROM reservations WHERE id=?').get(target.agentSessionId)
        const reservation = row ? lifecycleReservation(JSON.parse(String(row.json))) : null
        if (!reservation || reservation.kind !== 'stop' || reservation.expectedRun.runId !== target.expectedRun.runId ||
          reservation.ownerId !== claim.ownerId && processIsAlive(reservation.ownerPid)) return
        const next = lifecycleReservation({ ...reservation, ownerId: claim.ownerId, ownerPid: claim.ownerPid, expiresAt: claim.expiresAt })
        this.db.prepare('UPDATE reservations SET json=? WHERE id=?').run(JSON.stringify(next), target.agentSessionId)
        this.dirty = true
        claimed = [next]
        return
      }
      const document = await this.read()
      claimed = document.reservations.flatMap((reservation) => {
        if (
          !((reservation.kind === 'reopen' || reservation.kind === 'create') && reservation.ownerReleased) && reservation.ownerId !== claim.ownerId &&
          processIsAlive(reservation.ownerPid)
        ) return []
        return [lifecycleReservation({
          ...reservation,
          ...(reservation.kind === 'reopen' || reservation.kind === 'create' ? { ownerReleased: undefined } : {}),
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
      const retiredAgentSessions = retiredAgentSessionsForRuns(
        document.retiredAgentSessions,
        mergedRetiredRuns
      )
      assertUnboundRetiredRuns(document.sessions, mergedRetiredRuns)
      assertRetiredAgentSessions(
        document.sessions,
        mergedRetiredRuns,
        retiredAgentSessions
      )
      await this.write({
        ...document,
        retiredRuns: mergedRetiredRuns,
        retiredAgentSessions,
        reservations: document.reservations.filter(
          (item) => item.reservationId !== reservation.reservationId
        )
      }, undefined, true)
    })
  }

  async retireRuns(runs: readonly AgentMuxRunRef[]): Promise<void> {
    await this.enqueue(async () => {
      const document = await this.read()
      const retiredRuns = mergeRetiredRuns(document.retiredRuns, runs)
      const retiredAgentSessions = retiredAgentSessionsForRuns(
        document.retiredAgentSessions,
        retiredRuns
      )
      assertUnboundRetiredRuns(document.sessions, retiredRuns)
      assertRetiredAgentSessions(
        document.sessions,
        retiredRuns,
        retiredAgentSessions
      )
      await this.write({
        ...document,
        retiredRuns,
        retiredAgentSessions
      }, undefined, true)
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
      assertLifecycleCommit(currentReservation, normalized)
      const sessions = document.sessions.filter(
        (session) => session.agentSessionId !== reservation.agentSessionId
      )
      if (normalized) sessions.push(normalized)
      const committedSessions = normalizeAgentSessions(sessions)
      const retiredRuns = reservation.kind === 'stop' && previous
        ? mergeRetiredRuns(document.retiredRuns, [...previous.retiredRuns, previous.run])
        : reservation.kind === 'reopen'
          ? document.retiredRuns.filter(run => run.runId !== reservation.expectedRetirement.run.runId)
          : document.retiredRuns
      const retiredAgentSessions = retiredAgentSessionsForRuns(
        reservation.kind === 'stop' && previous
          ? mergeRetiredAgentSessions(document.retiredAgentSessions, [{
              agentSessionId: previous.agentSessionId,
              hostId: previous.hostId,
              run: { ...previous.run },
              source: 'user',
              observedAt: Date.now(),
              history: sessionHistoryMetadata(previous),
              ...(previous.activityCommit ? { activityCommit: previous.activityCommit } : {})
            }])
          : document.retiredAgentSessions,
        retiredRuns
      )
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
      }, undefined, reservation.kind === 'stop')
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
      if (!await this.timelineMutationAllowed(canonicalMutation, signal)) {
        throw new AgentMuxError(`Unknown Agent Session: ${canonicalMutation.agentSessionId}`, 'UNKNOWN_AGENT_SESSION')
      }
      const timeline = await this.readTimeline(canonicalMutation.agentSessionId, signal)
      const items = applyNormalizedTimelineMutation(timeline.items, canonicalMutation)
      const changed = items !== timeline.items
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

  private async withReadDatabase<T>(read: (db: DatabaseSync) => T,
    rescue: (document: AgentSessionStoreDocument) => T): Promise<T> {
    if (this.database) return read(this.database)
    let db: DatabaseSync | null = null
    let failure: unknown
    try {
      db = await readCurrentSessionDatabase(this.path)
      if (!db) {
        let raw: Buffer | undefined
        try { raw = await readFile(this.path) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (raw) {
          try { this.strictOriginalDocument(raw) } catch {
            // Damaged original bytes remain the original rescue source. A partial salvage is
            // readable, observable and never published as a successful physical conversion.
            return rescue(await this.parseStoreDocument(raw))
          }
        }
        await this.enqueue(async () => {})
        db = await readCurrentSessionDatabase(this.path)
        if (!db) throw new AgentMuxError('Session persistence identity is unconfirmed; retry the original read.', 'AGENT_SESSION_STORE_READ_UNCONFIRMED')
      }
      db.exec('BEGIN'); const result = read(db); db.exec('COMMIT'); return result
    } catch (error) { failure = sessionStorageFailure(error, 'read'); throw failure }
    finally {
      try { db?.close() } catch (error) {
        if (failure !== undefined) throw sessionStorageFailure(failure, 'read', [error])
        throw sessionStorageFailure(error, 'read-close')
      }
    }
  }

  private strictOriginalDocument(raw: Buffer): AgentSessionStoreDocument {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)) as Record<string, unknown>
    if (!value || value.version !== 5) throw new AgentMuxError('Agent Session store is invalid.', 'INVALID_AGENT_SESSION_STORE')
    return this.strictStoreDocument(value)
  }

  private async read(signal?: AbortSignal): Promise<AgentSessionStoreDocument> {
    signal?.throwIfAborted()
    return await this.withReadDatabase(db => ({ version: 5,
      sessions: this.sessionCatalog(db),
      reservations: db.prepare('SELECT json FROM reservations ORDER BY rowid').all().map(row => lifecycleReservation(JSON.parse(String(row.json)))),
      retiredRuns: db.prepare('SELECT json FROM retired_runs ORDER BY rowid').all().map(row => runRef(JSON.parse(String(row.json)))),
      retiredAgentSessions: db.prepare('SELECT json FROM retired_sessions ORDER BY rowid').all().map(row => retiredAgentSession(JSON.parse(String(row.json))))
    }), document => document)
  }

  private sessionCatalog(db: DatabaseSync): AgentMuxStoredAgentSession[] {
    return db.prepare('SELECT json FROM sessions ORDER BY rowid').all().map(row => normalizeStoredAgentSession(JSON.parse(String(row.json))))
  }

  private sessionMetadata(db: DatabaseSync, id: string): AgentMuxStoredAgentSession | null {
    const row = db.prepare('SELECT json FROM sessions WHERE id=?').get(id)
    return row ? normalizeStoredAgentSession(JSON.parse(String(row.json))) : null
  }
  private futureIntent(db: DatabaseSync, id: string, intentId: string): AgentFuturePromptIntent | null {
    const row = db.prepare('SELECT json FROM future_intents WHERE session_id=? AND intent_id=?').get(id, intentId)
    return row ? JSON.parse(String(row.json)) as AgentFuturePromptIntent : null
  }
  private completeSession(db: DatabaseSync, id: string): AgentMuxStoredAgentSession | null {
    const current = this.sessionMetadata(db, id)
    if (!current) return null
    const present = db.prepare('SELECT future_present FROM sessions WHERE id=?').get(id)!.future_present
    if (!present) return current
    const entries = db.prepare('SELECT intent_id, json FROM future_intents WHERE session_id=? ORDER BY ordinal').all(id)
    return { ...current, futurePromptIntents: Object.fromEntries(entries.map(row => [String(row.intent_id), JSON.parse(String(row.json))])) }
  }
  private saveFutureIntent(db: DatabaseSync, id: string, change: AgentMuxSessionFutureChange): void {
    string(change.intentId, 'future intent id')
    if (change.next === null) { db.prepare('DELETE FROM future_intents WHERE session_id=? AND intent_id=?').run(id, change.intentId); return }
    const metadata = this.sessionMetadata(db, id)
    if (!metadata) throw new AgentMuxError('Future intent has no current Session owner.', 'STALE_AGENT_SESSION')
    const intent = normalizeStoredAgentSession({ ...metadata, futurePromptIntents: { [change.intentId]: change.next } }).futurePromptIntents![change.intentId]!
    const existing = db.prepare('SELECT ordinal FROM future_intents WHERE session_id=? AND intent_id=?').get(id, change.intentId)
    const ordinal = existing ? Number(existing.ordinal) : Number(db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS next FROM future_intents WHERE session_id=?').get(id)!.next)
    db.prepare('INSERT INTO future_intents VALUES (?, ?, ?, ?) ON CONFLICT(session_id,intent_id) DO UPDATE SET json=excluded.json')
      .run(id, change.intentId, ordinal, JSON.stringify(intent))
    db.prepare('UPDATE sessions SET future_present=1 WHERE id=?').run(id)
  }
  private savePromptAdmission(db: DatabaseSync, value: AgentPromptSubmissionRecord, receipt = false): void {
    const row = db.prepare('SELECT json FROM prompt_admissions WHERE session_id=? AND run_id=? AND record_id=?')
      .get(value.agentSessionId, value.run.runId, promptRecordId(value))
    assertPromptRecordWrite(row ? JSON.parse(String(row.json)) as AgentPromptSubmissionRecord : undefined, value, receipt)
    db.prepare('INSERT INTO prompt_admissions VALUES (?, ?, ?, ?) ON CONFLICT(session_id,run_id,record_id) DO UPDATE SET json=excluded.json')
      .run(value.agentSessionId, value.run.runId, promptRecordId(value), JSON.stringify(value))
  }
  private preservePromptAdmission(db: DatabaseSync, id: string): void {
    const row = db.prepare('SELECT json FROM sessions WHERE id=?').get(id)
    // Keep original stored fields before any normalization of the replacement.
    for (const original of row ? promptAdmissionRecords(JSON.parse(String(row.json)) as AgentMuxStoredAgentSession) : []) this.savePromptAdmission(db, original)
  }
  private deleteSession(db: DatabaseSync, id: string): void {
    this.preservePromptAdmission(db, id)
    db.prepare('DELETE FROM sessions WHERE id=?').run(id)
    db.prepare('DELETE FROM future_intents WHERE session_id=?').run(id)
    db.prepare('DELETE FROM run_bindings WHERE session_id=?').run(id)
    db.prepare('DELETE FROM native_bindings WHERE session_id=?').run(id)
  }
  private saveSession(db: DatabaseSync, session: AgentMuxStoredAgentSession, replaceFuture: boolean, receipt = false): void {
    const id = session.agentSessionId, metadata = agentSessionMetadata(session)
    const retired = db.prepare('SELECT 1 FROM retired_sessions WHERE id=?').get(id)
    if (retired) throw new AgentMuxError('Retired Agent Session conflicts with current identity.', 'INVALID_AGENT_SESSION_STORE')
    for (const run of [session.run, ...session.retiredRuns]) {
      const bound = db.prepare('SELECT session_id FROM run_bindings WHERE run_id=?').get(run.runId)
      if (bound && bound.session_id !== id) throw new AgentMuxError('Run conflicts with another current or retired Session.', 'INVALID_AGENT_SESSION_STORE')
    }
    const native = nativeBindingKey(session)
    if (native) {
      const bound = db.prepare('SELECT session_id FROM native_bindings WHERE native_key=?').get(native)
      if (bound && bound.session_id !== id) throw new AgentMuxError('Native identity conflicts with another Session.', 'INVALID_AGENT_SESSION_STORE')
    }
    const present = replaceFuture || session.futurePromptIntents !== undefined ? Number(session.futurePromptIntents !== undefined)
      : Number(db.prepare('SELECT future_present FROM sessions WHERE id=?').get(id)?.future_present ?? 0)
    this.preservePromptAdmission(db, id)
    for (const original of promptAdmissionRecords(session)) this.savePromptAdmission(db, original, receipt)
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,future_present=excluded.future_present,creation_operation=excluded.creation_operation')
      .run(id, JSON.stringify(metadata), present, session.creation?.createOperationId ?? null)
    db.prepare('DELETE FROM run_bindings WHERE session_id=?').run(id)
    for (const run of [session.run, ...session.retiredRuns]) db.prepare('INSERT INTO run_bindings VALUES (?, ?)').run(run.runId, id)
    db.prepare('DELETE FROM native_bindings WHERE session_id=?').run(id)
    if (native) db.prepare('INSERT INTO native_bindings VALUES (?, ?)').run(native, id)
    if (replaceFuture || session.futurePromptIntents !== undefined) {
      db.prepare('DELETE FROM future_intents WHERE session_id=?').run(id)
      for (const [intentId, intent] of Object.entries(session.futurePromptIntents ?? {})) this.saveFutureIntent(db, id, { intentId, expected: null, next: intent })
    }
  }

  /**
   * 字节到手后的解析与抢救分界：能严格解析就走快路径，绝不留下隔离文件；
   * 一旦是当前格式内的真损坏（撕裂、乱码、单条记录过不了校验），先把还能读的记录救出来，
   * 再把原始字节整段隔离——**顺序不可颠倒**：隔离是尽力而为的旁路诊断，绝不能把它的写盘
   * 成功当成返回抢救结果的前提。磁盘故障既是 store 损坏的主因，又是隔离写失败的主因，
   * 最需要救援的场景恰恰是隔离最可能失败的场景；若让 quarantine 抛错把整份读取带崩，
   * 一个读恢复能力就被一次写成功绑架了。版本不符按 INVALID 上抛——那是迁移的活，本任务只在 v5 内抢救。
   *
   * 断电边界：salvage 只对「盘上还留着可解析记录字节」的残余损坏有效。全零填充和 0 字节
   * （最典型的断电结果）无数据可救，一条也救不回来——真正防住断电的是写入侧的 fsync（T-004），
   * salvage 只是残余损坏的兜底，别指望它包治断电。
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
      //
      // 分母是否诚实，取决于分帧有没有完整扫过记录列表。乱码注入时列表结构还在，块数就是盘上
      // 原本的记录数，`lost N` 算得准；而截断把尾部记录连同其后的一切整段抹掉、锚点行被污染时
      // 连从哪开始数都不知道——被抹掉的记录不在字节流里，「原本有多少条」不可知。那种情况下报
      // `lost 0` 会主动骗运维「一条没丢」，比不报更糟，所以只报救回数、把总数标成 unknown，
      // 由隔离文件承担事后取证。
      const framing = extractSessionBlocks(text)
      const document: AgentSessionStoreDocument = {
        version: 5,
        sessions: salvageSessionList(parseSessionBlocks(text)),
        reservations: [],
        retiredRuns: [],
        retiredAgentSessions: []
      }
      await this.recordCorruptStoreSalvage(
        raw,
        document.sessions.length,
        framing.complete ? framing.blocks.length : 'unknown',
        signal
      )
      return document
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
      const document = this.salvageStoreDocument(value as Record<string, unknown>)
      const candidateCount = asArray((value as Record<string, unknown>).sessions).length
      await this.recordCorruptStoreSalvage(raw, document.sessions.length, candidateCount, signal)
      return document
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
   * 抢救事件的唯一可观察出口：把原始字节尽力隔离，并**无论隔离成败都**发一条 warning，
   * 让运维看得见「救回几条、丢了几条、隔离文件在哪」——否则用户丢了 200/256 条会话
   * 收不到任何信号，唯一痕迹是没人盯的 sidecar。隔离是 best-effort（见 quarantineCorruptStore）：
   * 写盘失败不影响已救回的结果返回，但那次失败本身也要 warn，绝不静默吞掉。
   *
   * `candidates` 传 `'unknown'` 表示**原始记录数不可知**（截断/锚点损坏，见 parseStoreDocument）。
   * 这时绝不报 `lost N`：一个编出来的 0 会让运维以为没丢，而这正是本模块要防的那种沉默。
   *
   * 同一份坏字节在一次进程生命周期里只报一次。registry 的一次逻辑加载会串三次 read()
   * （sessions / retiredRuns / retiredAgentSessions），若不去重，一次损坏会刷三条一模一样的
   * warning，运维会读成「坏了三次」。去重键就是隔离文件用的那个内容摘要——同内容同一份告警，
   * 内容变了（另一次损坏）照常再报。
   */
  private async recordCorruptStoreSalvage(
    raw: Buffer,
    recovered: number,
    candidates: number | 'unknown',
    signal?: AbortSignal
  ): Promise<void> {
    const quarantinePath = this.corruptStorePath(raw)
    const quarantined = await this.quarantineCorruptStore(raw, quarantinePath, signal)
    if (this.reportedSalvages.has(quarantinePath)) return
    this.reportedSalvages.add(quarantinePath)
    const tally =
      candidates === 'unknown'
        ? `salvaged ${recovered} readable record(s); the store was truncated or its record framing was ` +
          `destroyed, so the original record count is UNKNOWN — an unknown number of records is lost`
        : `salvaged ${recovered} of ${candidates} readable record(s), lost ${Math.max(0, candidates - recovered)}`
    const where = quarantined
      ? `quarantined to ${quarantinePath}`
      : `quarantine write FAILED (bytes not isolated; see prior warning): would-be ${quarantinePath}`
    process.emitWarning(`Agent Session store was corrupt: ${tally}; ${where}.`, {
      code: 'AGENT_SESSION_STORE_SALVAGED'
    })
  }

  private corruptStorePath(raw: Buffer): string {
    const digest = createHash('sha256').update(raw).digest('base64url').slice(0, 16)
    return `${this.path}.corrupt-${digest}`
  }

  /**
   * 把损坏的原始字节原样落到一个内容寻址的隔离文件（sha256 命名），事后可据此诊断。
   * **Best-effort**：写盘失败不抛给调用方——抢救结果绝不能被这次旁路写成功绑架。返回是否落盘成功；
   * 失败时自己 warn（含原因）后返回 false，交由上层把这次失败一并写进 salvage warning，不静默吞掉。
   * 调用方 abort 属于取消而非 I/O 故障，照常上抛。
   *
   * 去重是内容寻址的：同一份坏文件被反复读到只隔离一次。但这只对**相同内容**成立——
   * 不同内容的损坏会各自完整保留一份 sidecar，不按累计字节裁剪原始恢复证据。
   * 当前需求下损坏是罕见事件，堆积不构成实际问题，故不加清理/预算层（那会是预防性抽象）；
   * 若日后 sidecar 真的堆起来，再引入有界回收，别把这里的注释读成「永不堆积」。
   */
  private async quarantineCorruptStore(
    raw: Buffer,
    path: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    signal?.throwIfAborted()
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await durableWriteFile(path, raw, { mode: 0o600, ...(signal ? { signal } : {}) })
      return true
    } catch (error) {
      // 调用方取消不是磁盘故障：照常上抛，尊重取消语义。
      if (signal?.aborted) throw error
      process.emitWarning(
        `Agent Session store salvage could not isolate corrupt bytes to ${path}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { code: 'AGENT_SESSION_STORE_QUARANTINE_FAILED' }
      )
      return false
    }
  }


  private async write(document: AgentSessionStoreDocument, signal?: AbortSignal, pruneTimelines = false): Promise<void> {
    signal?.throwIfAborted()
    this.writeDocument(this.db, document)
    this.dirty = true
    if (pruneTimelines) await this.maintainTimelineFiles(document)
  }

  private writeDocument(db: DatabaseSync, document: AgentSessionStoreDocument): void {
    // Lifecycle operations explicitly inspect metadata identities and reconcile their ownership;
    // preserved future bodies never join this catalog or its JSON serialization.
    const nextIds = new Set(document.sessions.map(session => session.agentSessionId))
    for (const row of db.prepare('SELECT id FROM sessions').all()) if (!nextIds.has(String(row.id))) this.deleteSession(db, String(row.id))
    for (const [table, values, id] of [
      ['reservations', document.reservations, (value: AgentMuxLifecycleReservation) => value.agentSessionId],
      ['retired_runs', document.retiredRuns, (value: AgentMuxRunRef) => value.runId],
      ['retired_sessions', document.retiredAgentSessions, (value: AgentMuxRetiredAgentSession) => value.agentSessionId]
    ] as const) {
      const entries = new Map(values.map(value => [(id as (value: unknown) => string)(value), JSON.stringify(value)]))
      for (const row of db.prepare(`SELECT id, json FROM ${table}`).all()) {
        const key = String(row.id), next = entries.get(key)
        if (next === undefined) db.prepare(`DELETE FROM ${table} WHERE id=?`).run(key)
        else if (next !== row.json) db.prepare(`UPDATE ${table} SET json=? WHERE id=?`).run(next, key)
        entries.delete(key)
      }
      for (const [key, json] of entries) db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run(key, json)
    }
    // Lifecycle transitions can exchange current/retired ownership in this same transaction.
    db.exec('DELETE FROM run_bindings; DELETE FROM native_bindings')
    for (const run of document.retiredRuns) db.prepare('INSERT INTO run_bindings VALUES (?, NULL)').run(run.runId)
    for (const session of document.sessions) this.saveSession(db, session, false)
  }

  private async maintainTimelineFiles(document: AgentSessionStoreDocument): Promise<void> {
    try {
      await this.removeOrphanTimelineFiles(document.sessions, document.retiredAgentSessions)
    } catch (error) {
      // Persistence already succeeded. Maintenance must not reject that lifecycle
      // and send the public Client down its uncommitted-Run rollback path.
      process.emitWarning(`Agent Session timeline cleanup failed; retained history and committed Sessions remain usable. ` +
        `Cleanup will retry on the next Store load: ${error instanceof Error ? error.message : String(error)}`, {
        code: 'AGENT_SESSION_TIMELINE_CLEANUP_FAILED'
      })
    }
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
      if (!metadata.isFile()) {
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
        const next = applyNormalizedTimelineMutation(items, mutation)
        if (next !== items) revision = nextTimelineRevision(revision)
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
    sessions: readonly AgentMuxStoredAgentSession[],
    retired: readonly AgentMuxRetiredAgentSession[]
  ): Promise<void> {
    const directory = join(dirname(this.path), 'agent-timelines')
    const currentPaths = new Set([...sessions, ...retired].map((session) => this.timelinePath(session.agentSessionId)))
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
    const current = this.tail.then(async () => {
      signal?.throwIfAborted()
      if (this.pendingLockRelease) {
        // Retry cleanup of the same owned handle in-band. A prior close error is not a permanent
        // sentence for a healthy Store, nor permission to unlock another writer's inode.
        await this.pendingLockRelease()
        this.pendingLockRelease = null
      }
      const release = await this.acquireLock(signal)
      let committed = false
      let failure: unknown
      let stage = 'open'
      try {
        this.database = await openSessionDatabase(this.path, (db, raw) => this.writeDocument(db, this.strictOriginalDocument(raw)))
        this.dirty = false
        stage = 'begin'; this.db.exec('BEGIN IMMEDIATE')
        // Existing validated databases acquire the same owner's internal table
        // in this transaction; absence never means an old input was unapplied.
        if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='prompt_admissions'").get()) {
          this.db.exec(promptAdmissionSchema); this.dirty = true
        }
        stage = 'mutation'
        await operation()
        signal?.throwIfAborted()
        stage = 'commit'; this.db.exec('COMMIT'); committed = true
        if (this.dirty) {
          try { await syncSessionDatabase(this.path) } catch (error) { throw new AgentMuxSessionDurabilityError(error) }
        }
      } catch (error) {
        // A failed SQLite COMMIT can leave the old transaction active (known rollback), or
        // an uncertain durable outcome. Neither proves Native input was not applied.
        failure = !committed && this.database && !this.database.isTransaction && this.dirty
          ? new AgentMuxSessionDurabilityError(error, 'unknown') : sessionStorageFailure(error, stage)
        throw failure
      } finally {
        const cleanup: unknown[] = [], database = this.database
        try { if (database?.isTransaction) database.exec('ROLLBACK') } catch (error) { cleanup.push(error) }
        let closed = false
        try { database?.close(); closed = true } catch (error) { cleanup.push(error) }
        this.database = undefined
        const finishRelease = async () => { if (!closed) { database?.close(); closed = true }; await release() }
        await finishRelease().catch(error => {
            const failure = new AgentMuxError('Agent Session store lock cleanup is unconfirmed; retry the same operation to release its original handle.',
              'AGENT_SESSION_STORE_LOCK_RELEASE_FAILED', error instanceof Error ? error.message : String(error))
            this.pendingLockRelease = finishRelease; process.emitWarning(failure.message, { code: failure.code })
        })
        if (cleanup.length) {
          if (failure !== undefined) throw sessionStorageFailure(failure, stage, cleanup)
          if (committed) throw new AgentMuxSessionDurabilityError(sessionStorageFailure(cleanup[0], 'close', cleanup.slice(1)))
          throw sessionStorageFailure(cleanup[0], 'close', cleanup.slice(1))
        }
      }
    })
    this.tail = current.then(() => {}, () => {})
    await current
  }

  private async acquireLock(
    signal?: AbortSignal,
    attempts = LOCK_ATTEMPTS
  ): Promise<() => Promise<void>> {
    const native: { tryLock(fd: number): boolean } = requireNative('fs-native-extensions')
    const path = `${this.path}.lock`
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    // All writers keep this inode. Kernel ownership ends on close or process death;
    // a dead owner's pathname is never unlinked underneath a new healthy owner.
    const handle = await open(path, 'a+', 0o600)
    try {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        signal?.throwIfAborted()
        if (native.tryLock(handle.fd)) return async () => { await handle.close() }
        if (attempt + 1 < attempts) {
          await delay(LOCK_RETRY_MIN_MS + Math.random() * LOCK_RETRY_JITTER_MS, signal)
        }
      }
      throw new AgentMuxError('Agent Session store is busy. Retry the same operation.', 'AGENT_SESSION_STORE_BUSY')
    } catch (error) {
      await handle.close()
      throw error
    }
  }
}
