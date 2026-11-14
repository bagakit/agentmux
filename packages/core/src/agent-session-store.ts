import { parseNativeSubagents, agentHasActiveSubagents, subagentScopeMatches } from './agent-subagent-state.js'
import { sessionUsageWindow, sessionUsageMeasurement, type AgentSessionUsagePage } from './agent-session-usage.js'
import { parseAgentSessionRecordDeletion, deletedAgentSessionRecord } from './agent-session-record.js'
import { agentNativeTurnEnd } from './agent-session-identity.js'
import { parseResumeResolution, type AgentMuxResumeResolution } from './agent-session-recovery/resume-resolution.js'
import { assertPreparedResumeBinding, parseResumeResolutionRequest, resumeResolutionDigest, type ResumeResolutionRequest } from './agent-prepared-resume.js'
import { parseAutomaticInputSource } from './automatic-input-source.js'
import { decodePreparedRun, type PreparedRun } from './prepared-run.js'
import { parseCreationRuntime, type AgentMuxCreationRuntime } from './terminal-creation-retirement.js'
import { rpcRecord } from './rpc-data.js'
import { parseAgentToolExecutionBinding } from './agent-tool-execution.js'
import { mintObjectId } from './object-id.js'
import { parseAgentExternalInteractionAuthor } from './external-author.js'
import { parseAgentContinuityControlReceipts, type AgentMuxContinuityControlReceipt } from './agent-session-recovery/control-contract.js'
import { normalizeAgentContinuityOperation, normalizeAgentContinuityLaunchInput, normalizeAgentContinuityPolicy, type AgentMuxContinuityOperation } from './agent-session-recovery/continuity-contract.js'
import { agentPromptInputId, validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { MAX_STORED_TEXT_BYTES, parsePromptSubmissionRecord, normalizePromptCompletionAdmission, terminalPromptSubmission, terminalPromptReadinessSource } from './prompt-submission-record.js'
export { parsePromptSubmissionRecord, normalizePromptCompletionAdmission } from './prompt-submission-record.js'
import { normalizeOperationDevice } from './operation-device.js'
import { AgentMuxError } from './errors.js'
import { agentCreationNotAppliedError, finishAgentCreationCleanup } from './agent-creation-failure.js'
import { parseWorkspaceTrustPreparation } from './workspace-trust-preparation.js'
import { observeRead } from './observation-read.js'
import { parseCumulativeUsage } from './agent-usage-transcript.js'
import { parseAgentForkSource } from './agent-fork.js'
import { parseAgentMuxCreationOrigin } from './agent-creation-admission.js'
import { parseAgentSpawnCreator } from './agent-spawn.js'
import { agentSpawnIndexes, agentSpawnPage, parseAgentSpawnQuery, readAgentSpawnRows,
  type AgentMuxSpawnPage, type AgentMuxSpawnQuery, type AgentMuxSpawnRecord } from './agent-spawn-query.js'
import { assertCurrentAgentCapabilityBinding, type AgentCapabilityBinding } from './agent-capability.js'
import { agentActivityTimelineItem } from './agent-activity-state.js'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { openSessionDatabase, promptAdmissionSchema, promptSubmissionIndexSchema, retiredCreationIndexSchema, readCurrentSessionDatabase, syncSessionDatabase } from './agent-session-database.js'
import { defaultAgentMuxStateDirectory } from './runtime-paths.js'
import { durableWriteFile, DurableWriteError } from './durable-write.js'
import { normalizeAgentInteractionResponse } from './agent-interaction.js'
import { canonicalHookLifecycleEvent, isAgentHookLifecycleEvent } from './agent-hook-event.js'
import { parseAgentRestartInput, type AgentMuxAgentRestartInput } from './agent-session-recovery/restart-contract.js'
import { continuityExecutorEntries } from './agent-session-recovery/executor.js'
import { isPermissionOptionKind, isPromptDeliveryDegradedReason, RISK_TIERS } from './types.js'
import { applyNormalizedTimelineMutation } from './session-timeline-reducer.js'
import { conversationRevision } from './conversation-stream.js'
import { beginCapturedStream, capturedHistorySchema, capturedStream, capturedBodyGaps, commitCapturedMutation, readCapturedPage, readRecentCaptured, readyCapturedStream, readCapturedInputProjection, writeCapturedInputProjection } from './captured-history.js'
import { archiveCapturedOriginal, capturedFileWitness, importCapturedFile } from './captured-history-import.js'
import {
  normalizeAgentTimelineMutation
} from './session-timeline.js'
import { parseAgentStopProgress, parseAgentStopRecord, parseStopSupersededResume, type AgentMuxAgentStopProgress, type AgentMuxAgentStopRecord,
  type AgentMuxStopSupersededResume } from './agent-stop-receipt.js'
import {
  normalizeNativeSessionId,
  normalizeNativeTranscriptPath,
  matchesProviderNativeSessionTarget
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
  AgentMuxInteractionOperationReceipt,
  AgentMuxPendingInteraction,
  AgentMuxRunRef,
  AgentMuxStoredAgentSession,
  AgentPromptSubmissionRecord,
  AgentRecoveryActivity,
  AgentNativeSessionHandle,
  AgentNativeSessionConfirmationReceipt,
  AgentSessionHistoryMetadata,
  AgentSessionHistoryDescriptor,
  AgentSessionHistorySourcesOptions,
  AgentStatus,
  AgentTerminalCapabilityState,
  AgentTerminalPromptDeliveryState,
  AgentTerminalOutputChannelState,
  AgentTerminalPromptReadinessSource,
  AgentCapturedTimelineRead,
  AgentCapturedTimelinePage,
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
  nativeCreationKeys?: import('./types.js').AgentMuxNativeCreationKeys
}

/** Prepared before start; no Run or input is invented for this durable creation seed. */
export type AgentMuxPreparedCreation = Pick<AgentMuxStoredAgentSession,
  'kind' | 'agentSessionId' | 'providerId' | 'executorId' | 'hostId' | 'workspacePath' | 'hookBindingId' | 'hookToken' |
  'capabilityHash' | 'createdAt' | 'updatedAt' | 'toolExecution' | 'creation' | 'forkedFrom' | 'nativeHandle' | 'launchOptions' | 'nativeActor' | 'initialInput' | 'executorInvocation'>

/** Private exact Start material. Never project this onto a public Agent Session. */
export type AgentMuxPreparedResumeDispatch = {
  prepared: PreparedRun
  runtime: AgentMuxCreationRuntime
  nativeTarget: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
}

function preparedResumeDispatch(value: unknown, session: AgentMuxStoredAgentSession | undefined, operationId: string): AgentMuxPreparedResumeDispatch {
  const source = rpcRecord(value, ['prepared', 'runtime', 'nativeTarget'], 'INVALID_AGENT_SESSION_STORE')
  const { prepared } = decodePreparedRun(source.prepared)
  assertPreparedResumeBinding(prepared, session, operationId)
  const runtime = parseCreationRuntime(source.runtime)
  if (!session || session.nativeHandle?.kind !== 'provider' || !isDeepStrictEqual(source.nativeTarget, session.nativeHandle)) throw new AgentMuxError(
    'The original resume dispatch does not match its prepared Session and native target.', 'INVALID_AGENT_SESSION_STORE')
  return { prepared, runtime, nativeTarget: structuredClone(session.nativeHandle) }
}

export type AgentMuxPreparedResumeResolution = { request: ResumeResolutionRequest; receipt: AgentMuxResumeResolution }

export type AgentMuxLifecycleReservation = AgentMuxLifecycleReservationBase & (
  | { kind: 'create'; preparedCreation?: AgentMuxPreparedCreation; ownerReleased?: true; expectedRun?: never; stopOperation?: never }
  | { kind: 'resume'; expectedRun: AgentMuxRunRef; preparedSession?: AgentMuxStoredAgentSession; preparedDispatch?: AgentMuxPreparedResumeDispatch; resolution?: AgentMuxPreparedResumeResolution; stopOperation?: never; ownerReleased?: true; restart?: { requestDigest: string; request: AgentMuxAgentRestartInput; nativeTarget: Extract<AgentNativeSessionHandle, { kind: 'provider' }>; stopOperation: AgentMuxRecoverableStopOperation; startNotApplied?: { code: string; message: string; observedAt: number } } }
  | { kind: 'reopen'; expectedRetirement: AgentMuxRetiredAgentSession; callerOperationId?: string; preparedSession?: AgentMuxStoredAgentSession; ownerReleased?: true; expectedRun?: never; stopOperation?: never }
  | {
      kind: 'stop'
      expectedRun: AgentMuxRunRef
      stopOperation: AgentMuxRecoverableStopOperation
      /** How far this Stop got; written before the Runtime stop and when a stage fails. */
      progress?: AgentMuxAgentStopProgress
      /** The prepared resume this Stop took over, with its Runtime witness. */
      supersededResume?: AgentMuxStopSupersededResume
    }
)

export type AgentMuxLifecycleClaim = {
  ownerId: string
  ownerPid: number
  now: number
  expiresAt: number
}

export type AgentMuxRetiredAgentSession = {
  /** Private key-only lifecycle provenance; excluded from public history/snapshots. */
  nativeCreationKeys?: import('./types.js').AgentMuxNativeCreationKeys
  /** Explicit deletion is terminal for this identity; its original correlations remain. */
  recordDeletion?: import('./agent-session-record.js').AgentSessionRecordDeletion
  continuityControlReceipts?: Record<string, AgentMuxContinuityControlReceipt>
  agentSessionId: string
  hostId: string
  run: AgentMuxRunRef
  source: 'user'
  observedAt: number
  history?: AgentSessionHistoryMetadata
  /** Private original creation invocation retained for exact history/reopen only. */
  executorInvocation?: unknown
  activityCommit?: AgentActivityCommit
  /** The Stop that produced this retirement. */
  stop?: AgentMuxAgentStopRecord
}

type ContinuityControlStoredResult = { receipt: AgentMuxContinuityControlReceipt } & (
  { session: AgentMuxStoredAgentSession; retirement?: never } | { retirement: AgentMuxRetiredAgentSession; session?: never }
)
function continuityControlReceipts(session: AgentMuxStoredAgentSession): Record<string, AgentMuxContinuityControlReceipt> {
  const records = { ...session.continuityControlReceipts }
  for (const root of Object.values(session.continuityOperations ?? {})) {
    for (const [id, receipt] of Object.entries(root.supervision?.controlOperations ?? {})) {
      if (records[id] && !isDeepStrictEqual(records[id], receipt)) throw new AgentMuxError('The original recovery control identity has conflicting receipts.', 'INVALID_AGENT_SESSION_STORE')
      records[id] = receipt
    }
  }
  return records
}
function continuityControlStoredResult(session: AgentMuxStoredAgentSession | null, retirement: AgentMuxRetiredAgentSession | null,
  operationId: string): ContinuityControlStoredResult | null {
  const receipt = session ? continuityControlReceipts(session)[operationId] : retirement?.continuityControlReceipts?.[operationId]
  return receipt ? structuredClone(session ? { receipt, session } : { receipt, retirement: retirement! }) : null
}

/** History is optional to a receipt; either result confirms the exact metadata write. */
export type AgentMuxMetadataTimelineResult =
  | { timeline: AgentTimelineCommit }
  | { timelineFailure: unknown }

function executorDepends(session: Pick<AgentMuxStoredAgentSession, 'hostId' | 'executorId' | 'creation'>, hostId: string, executorId: string): boolean {
  return session.hostId === hostId && session.executorId === executorId &&
    (session.creation?.executorRevision !== undefined || !session.creation?.executorInvocationDigest)
}
function retainedExecutorReference(sessions: readonly AgentMuxStoredAgentSession[], retired: readonly AgentMuxRetiredAgentSession[],
  reservations: readonly AgentMuxLifecycleReservation[], hostId: string, executorId: string): boolean {
  return sessions.some(session => executorDepends(session, hostId, executorId)) ||
    retired.some(session => !session.recordDeletion && session.hostId === hostId && session.history &&
      executorDepends({ ...session.history, hostId: session.hostId }, hostId, executorId)) ||
    reservations.some(value => value.kind === 'create' && value.preparedCreation && executorDepends(value.preparedCreation, hostId, executorId))
}

/** Original execution/recovery paths only; no Run adoption or history-body hydration. */
function retainedExecutionDirectories(sessions: readonly AgentMuxStoredAgentSession[], retired: readonly AgentMuxRetiredAgentSession[],
  reservations: readonly AgentMuxLifecycleReservation[], hostId: string): readonly string[] {
  const paths = new Set<string>()
  const keep = (value: { hostId: string; workspacePath: string } | undefined) => { if (value?.hostId === hostId) paths.add(value.workspacePath) }
  for (const session of sessions) keep(session)
  for (const session of retired) if (session.history && session.recordDeletion?.phase !== 'complete') keep({ hostId: session.hostId, workspacePath: session.history.workspacePath })
  for (const value of reservations) {
    if (value.kind === 'create') keep(value.preparedCreation)
    else if (value.kind === 'resume' || value.kind === 'reopen') {
      keep(value.preparedSession)
      if (value.kind === 'reopen' && value.expectedRetirement.history) keep({ hostId: value.expectedRetirement.hostId, workspacePath: value.expectedRetirement.history.workspacePath })
    }
  }
  return [...paths]
}

export type AgentMuxAgentSessionStore = {
  /** Exact active/retired Run ownership, including preceding admitted binding writes. */
  hasAgentRun(run: AgentMuxRunRef): Promise<boolean>
  /** Cold Files mutation admission; distinct paths from the original metadata owner. */
  retainedExecutionDirectories?(hostId: string): Promise<readonly string[]>

  /** Cold exact Native creation role read; never hydrates Sessions or repairs history. */
  agentCreationKeyRole?(key: string, agentSessionId?: string): Promise<'agent' | 'unclaimed' | 'unknown'>
  /** Exact executing-Host dependency, including durable no-Run creation seeds. */
  hostExecutorReferenced?(hostId: string, executorId: string): Promise<boolean>
  /** Optional read-only observation. Missing support never triggers Session hydration or repair. */
  agentSessionResourceCounts?(hostId: string, signal?: AbortSignal): Promise<{ saved: number; retired: number }>
  runningSavedAgentCount?(hostId: string, runningRunIds: readonly string[], signal?: AbortSignal): Promise<number>
  /** Exclusive in-flight Prompt orchestration; contention rejects without invoking operation. */
  withPromptSubmission<T>(agentSessionId: string, operation: () => Promise<T>): Promise<T>
  /** Flush the current exact binding; reading bytes alone does not acknowledge persistence. */
  confirmDurability(agentSessionId: string, expectedRun: AgentMuxRunRef, expectedSession: AgentMuxStoredAgentSession): Promise<void>
  /** Explicit current Session facts; cumulative original input records are read by their exact location. */
  load(): Promise<readonly unknown[]>
  loadMetadata(signal?: AbortSignal): Promise<readonly AgentMuxStoredAgentSession[]>
  readMetadata(agentSessionId: string): Promise<AgentMuxStoredAgentSession | null>
  /** Exact private original invocation only; never materializes cumulative input/recovery bodies. */
  readExecutorInvocation(agentSessionId: string): Promise<unknown>
  /** Bounded original creation relations; never probes or restores a Run. */
  listSpawns(input: AgentMuxSpawnQuery): Promise<AgentMuxSpawnPage>
  /** Exact original admission, including its retained retirement projection. */
  readContinuityControlReceipt(agentSessionId: string, operationId: string): Promise<ContinuityControlStoredResult | null>
  /** Exact original claim; history is never loaded into ordinary Session metadata. */
  readPromptAdmission(agentSessionId: string, run: AgentMuxRunRef, submissionId: string): Promise<AgentPromptSubmissionRecord | null>
  /** Original outcome CAS. A late receipt cannot move the latest projection back. */
  settlePromptAdmission(expected: AgentPromptSubmissionRecord, next: AgentPromptSubmissionRecord, signal?: AbortSignal): Promise<void>
  /** Resolve one original active/retired source and its reopen correlation, without catalog discovery. */
  readHistorySource(agentSessionId: string, signal?: AbortSignal): Promise<AgentSessionHistoryDescriptor | null>
  /** Existing captured body bytes only; a bounded read, never imports or touches Runtime. */
  readCapturedUsage(agentSessionId: string, input: { cursor?: string; limit?: number }, signal?: AbortSignal): Promise<AgentSessionUsagePage['captured']>
  readFuturePromptIntent(agentSessionId: string, intentId: string): Promise<AgentFuturePromptIntent | null>
  listFuturePromptIntents(agentSessionId: string, options?: { afterIntentId?: string; limit?: number }): Promise<AgentMuxFuturePromptPage>
  /**
   * Metadata and an optional exact intent change commit under one Session CAS.
   * An authenticated author binding, when supplied, must also match the current
   * author metadata with no author lifecycle reservation under that same owner.
   * Implementations must reject drift before committing; it is not a grant.
   * During a restart, this CAS must atomically fence the original reservation's
   * same-ID receipt and pointer against changes to the frozen Session, Run,
   * request digest or native target, retaining any conflicting receipt/input.
   * Unrelated operation IDs remain writable.
   */
  compareAndSwapMetadata(expected: AgentMuxStoredAgentSession | null, next: AgentMuxStoredAgentSession | null,
    signal?: AbortSignal, future?: AgentMuxSessionFutureChange, author?: Readonly<AgentCapabilityBinding>): Promise<void>
  /** One live Session CAS and its optional history contribution, under the original owner.
   * A thrown failure belongs to required persistence; history failure is returned only
   * after metadata ACK. Unknown metadata writes must never be attempted again here. */
  compareAndSwapMetadataWithTimeline(expected: AgentMuxStoredAgentSession, next: AgentMuxStoredAgentSession,
    mutation: AgentTimelineMutation, signal?: AbortSignal): Promise<AgentMuxMetadataTimelineResult>
  loadRetiredRuns(): Promise<readonly AgentMuxRunRef[]>
  loadRetiredAgentSessions(signal?: AbortSignal): Promise<readonly AgentMuxRetiredAgentSession[]>
  /** Exact original retirement authority; history descriptors cannot authorize recovery. */
  readRetiredAgentSession(agentSessionId: string, signal?: AbortSignal): Promise<AgentMuxRetiredAgentSession | null>
  readRecordDeletion(agentSessionId: string, signal?: AbortSignal): Promise<import('./agent-session-record.js').AgentSessionRecordDeletion | null>
  deleteRecord(expected: AgentMuxRetiredAgentSession, operationId: string, signal?: AbortSignal): Promise<{ retirement: AgentMuxRetiredAgentSession; admitted: boolean }>
  confirmRecordDeletion(expected: AgentMuxRetiredAgentSession, signal?: AbortSignal): Promise<AgentMuxRetiredAgentSession>
  /** One bounded target-only payload step; the original terminal operation remains the owner. */
  cleanRecord(expected: AgentMuxRetiredAgentSession, signal?: AbortSignal): Promise<AgentMuxRetiredAgentSession>
  /** Read only the original pending reopen correlation, including unavailable correlations. */
  loadReopenCorrelations(signal?: AbortSignal): Promise<readonly { expectedRetirement: AgentMuxRetiredAgentSession; operationId?: string }[]>
  /** Recover an existing creation identity by its caller operation, including no-Run reservations. */
  loadCreationSessionId(createOperationId: string): Promise<string | null>
  /** Original no-Run creation correlation; reading never starts a process or replays input. */
  loadCreationCorrelation(agentSessionId: string): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'create' }> | null>
  /**
   * Abort must cancel queued or active persistence without a late commit.
   * The same restart reservation, receipt and pointer fence required by
   * compareAndSwapMetadata applies atomically to this full-Session CAS too.
   */
  compareAndSwap(
    expected: AgentMuxStoredAgentSession | null,
    next: AgentMuxStoredAgentSession | null,
    signal?: AbortSignal
  ): Promise<void>
  /**
   * A restart reservation and its initial typed operation receipt must commit
   * atomically; a Store must never expose just one as a completed admission.
   */
  reserveLifecycle(reservation: AgentMuxLifecycleReservation): Promise<void>
  /**
   * Restore or reassert the original restart receipt in one transaction fenced
   * by the same reservation, owner, Run and frozen request/native target. Keep
   * conflicting receipts and inputs, and never issue Runtime side effects.
   */
  recordRestartAdmission(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, mode?: 'continue' | 'restore'): Promise<AgentMuxStoredAgentSession>
  prepareCreate(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'create' }>, seed: AgentMuxPreparedCreation): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'create' }>>
  claimCreate(agentSessionId: string, operationId: string, intentDigest: string, claim: AgentMuxLifecycleClaim): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'create' }> | null>
  /** Exact current lifecycle fact, including pending Stop; a failed read is never absence. */
  readLifecycleReservation(agentSessionId: string): Promise<AgentMuxLifecycleReservation | null>
  loadResumeCorrelation(agentSessionId: string, operationId: string): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'resume' }> | null>
  recordRestartStartNotApplied(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, failure: { code: string; message: string; observedAt: number }): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>>
  prepareResume(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, session: AgentMuxStoredAgentSession, dispatch?: AgentMuxPreparedResumeDispatch): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>>
  admitResumeResolution(original: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, request: ResumeResolutionRequest, claim: AgentMuxLifecycleClaim & { reservationId: string }): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>>
  releaseResumeResolutionOwner(original: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>): Promise<void>
  recordResumeResolutionFailure(original: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, failure: { code: string; message: string }): Promise<AgentMuxStoredAgentSession>
  handoffResumeResolution(original: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, successor: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, session: AgentMuxStoredAgentSession, dispatch: AgentMuxPreparedResumeDispatch, retirement: AgentMuxCreationRuntime): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>>
  prepareReopen(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>, session: AgentMuxStoredAgentSession): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>>
  releaseReopenOwner(ownerId: string): Promise<void>
  claimRestart(agentSessionId: string, operationId: string, claim: AgentMuxLifecycleClaim): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'resume' }> | null>
  claimReopen(agentSessionId: string, operationId: string, expectedRetiredAt: number, claim: AgentMuxLifecycleClaim): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> | null>
  /** A target claims only its original Stop; adapters must preserve this filter. */
  claimStaleLifecycles(claim: AgentMuxLifecycleClaim, target?: { agentSessionId: string; expectedRun: AgentMuxRunRef }): Promise<AgentMuxLifecycleReservation[]>
  releaseLifecycle(
    reservation: AgentMuxLifecycleReservation,
    retiredRuns?: readonly AgentMuxRunRef[]
  ): Promise<void>
  retireRuns(runs: readonly AgentMuxRunRef[]): Promise<void>
  /** Record how far one exact open Stop got, on its own reservation row. */
  recordStopProgress(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'stop' }>, progress: AgentMuxAgentStopProgress): Promise<void>
  /**
   * A user Stop returns the exact retirement it committed, carrying the Stop's own record;
   * every other lifecycle returns null and takes no Stop record.
   */
  commitLifecycle(
    reservation: AgentMuxLifecycleReservation,
    next: AgentMuxStoredAgentSession | null,
    stop?: AgentMuxAgentStopRecord
  ): Promise<AgentMuxRetiredAgentSession | null>
  readCapturedHistory(agentSessionId: string, input?: AgentCapturedTimelineRead): Promise<AgentCapturedTimelinePage>
  readInputConversationProjection(agentSessionId: string, after?: string): Promise<ReturnType<typeof readCapturedInputProjection>>
  recordInputConversationProjection(agentSessionId: string, cut: import('./agent-input-conversation.js').AgentInputJournalCut): Promise<void>
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
  for (const operation of Object.values(session.continuityOperations ?? {})) {
    const launch = operation.launchInput
    if (launch?.delivery === 'launch' && launch.state === 'launch-carried' && launch.key) originals.push({
      agentSessionId: session.agentSessionId, run: launch.key.expectedRun, launch })
  }
  const initial = session.initialInput
  if (initial?.state === 'launch-carried' && initial.key) originals.push({ agentSessionId: session.agentSessionId,
    run: initial.key.expectedRun, launch: initial })
  const idle = session.recoveryActivity
  for (const original of originals) {
    const inputId = original.admission?.submissionId ?? original.launch?.key?.submissionId
    if (inputId && !(subagentScopeMatches(session.nativeSubagents, session) && (session.nativeSubagents.unconfirmed || agentHasActiveSubagents(session.nativeSubagents))) && idle?.state === 'idle' && idle.nativeTurnId && idle.promptSubmissionId === inputId &&
        original.run.runId === idle.run.runId) {
      original.semanticIdle = { ...structuredClone(idle), state: 'idle', source: 'native-hook',
        nativeTurnId: idle.nativeTurnId, promptSubmissionId: inputId }
      continue
    }
    const claim = original.admission
    if (!inputId || claim?.transport !== 'native' || claim.native.outcome !== 'admitted' ||
        !claim.native.turnId || original.run.runId !== session.run.runId || session.nativeHandle?.kind !== 'provider') continue
    const end = agentNativeTurnEnd(session, claim.native.turnId)
    if (end?.sequence === undefined || end.sequence < 1) continue
    original.semanticIdle = { source: 'native-status', state: 'idle', run: structuredClone(original.run),
      observedAt: end.observedAt, recordId: end.recordId,
      sourceId: JSON.stringify([session.providerId, session.nativeHandle]), sequence: end.sequence,
      nativeSessionId: session.nativeHandle.sessionId, nativeTurnId: claim.native.turnId, promptSubmissionId: inputId }
  }
  return structuredClone(originals)
}
function promptAdmissionRecord(session: AgentMuxStoredAgentSession | null | undefined): AgentPromptSubmissionRecord | null {
  return promptAdmissionRecords(session)[0] ?? null
}

function promptRecordId(value: AgentPromptSubmissionRecord): string {
  const id = value.admission?.submissionId ?? value.terminalPromptSubmission?.submissionId ?? value.launch?.input.submissionId
  // A missing logical identity remains missing. This opaque location only keeps its original JSON.
  return id === undefined ? JSON.stringify(['original-slot', value.admission?.operationId]) : JSON.stringify(['submission', id])
}


function assertPromptSettlement(expected: AgentPromptSubmissionRecord, next: AgentPromptSubmissionRecord): void {
  const { acknowledged: _ack, notApplied: _notApplied, native: _native, launch: _launch, ...originalClaim } = expected.admission ?? {}
  const { acknowledged: _nextAck, notApplied: _nextNotApplied, native: _nextNative, launch: _nextLaunch, ...nextClaim } = next.admission ?? {}
  const original = expected.admission, settled = next.admission
  const samePlan = original?.transport === 'native' && settled?.transport === 'native'
    ? isDeepStrictEqual(original.native.plan, settled.native.plan)
    : original?.transport === 'launch' && settled?.transport === 'launch' && isDeepStrictEqual(original.launch.plan, settled.launch.plan)
  if (expected.agentSessionId !== next.agentSessionId || expected.run.runId !== next.run.runId || promptRecordId(expected) !== promptRecordId(next) ||
      !samePlan || !isDeepStrictEqual(originalClaim, nextClaim) ||
      !isDeepStrictEqual(expected.terminalPromptSubmission, next.terminalPromptSubmission)) {
    throw new AgentMuxError('Input receipt changed its original claim.', 'AGENT_PROMPT_OPERATION_CONFLICT')
  }
  const outcome = original?.transport === 'native' ? original.native.outcome : original?.transport === 'launch' ? original.launch.outcome : undefined
  if (outcome === 'admitted' || outcome === 'launch-carried' || outcome === 'not-applied') {
    if (!isDeepStrictEqual(expected, next)) throw new AgentMuxError('The original final input receipt cannot be changed.', 'AGENT_PROMPT_OPERATION_CONFLICT')
  }
  parsePromptSubmissionRecord(next)
}

/** Routine Session writes cannot rebind or settle an already claimed native or launch input. */
function assertPromptRecordWrite(original: AgentPromptSubmissionRecord | undefined, next: AgentPromptSubmissionRecord, receipt = false): void {
  // The original input's first exact native idle is immutable. Later platform turns cannot renew its clock.
  if(original?.semanticIdle)next.semanticIdle=structuredClone(original.semanticIdle)
  if(original&&next.semanticIdle) {
    parsePromptSubmissionRecord(next)
    const {semanticIdle:_previous,...before}=original,{semanticIdle:_next,...after}=next
    if(isDeepStrictEqual(before,after)&&(!original.semanticIdle||isDeepStrictEqual(original.semanticIdle,next.semanticIdle)))return
  }
  if (!original || isDeepStrictEqual(original, next)) return
  if (original.launch || next.launch) throw new AgentMuxError('An original Runtime launch input cannot be replaced by another carrier or body.', 'AGENT_PROMPT_OPERATION_CONFLICT')
  if (!['native', 'launch'].includes(original.admission?.transport ?? 'pty') && !['native', 'launch'].includes(next.admission?.transport ?? 'pty')) return
  if (!receipt || next.admission?.native?.outcome === 'claimed' || next.admission?.launch?.outcome === 'claimed') throw new AgentMuxError(
    'The original input record can only be changed by its exact receipt owner.', 'AGENT_PROMPT_OPERATION_CONFLICT')
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

type NativeCreationKeys = NonNullable<AgentMuxStoredAgentSession['nativeCreationKeys']>
function strictNativeCreationKeys(value: unknown): NativeCreationKeys {
  const r=record(value,'private Native creation keys')
  if(Object.keys(r).some(k=>k!=='keys'&&k!=='coverage')||!Array.isArray(r.keys)||r.keys.some(k=>typeof k!=='string'||!k||k.includes('\0'))||new Set(r.keys).size!==r.keys.length||!['complete','partial'].includes(String(r.coverage)))throw new AgentMuxError('Original Native creation-key facts are invalid.','INVALID_AGENT_SESSION_STORE')
  return {keys:[...r.keys] as string[],coverage:r.coverage as NativeCreationKeys['coverage']}
}
function nativeCreationKeys(value: unknown): NativeCreationKeys {
  try{return strictNativeCreationKeys(value)}catch{
    // A malformed packet cannot launder even matching strings into role authority.
    return {keys:[],coverage:'partial'}
  }
}
function roleNativeCreationKeys(value:unknown):NativeCreationKeys {
  try{return strictNativeCreationKeys(value)}catch{throw new AgentMuxError('Original private Agent creation-key facts are unconfirmed. Existing Session, Run, input and Stop are retained.','AGENT_CREATION_ROLE_UNCONFIRMED')}
}
function appendNativeCreationKeys(prior: NativeCreationKeys | undefined, keys: readonly string[], firstCreate=false): NativeCreationKeys {
  return strictNativeCreationKeys({keys:[...new Set([...(prior?.keys??[]),...keys])],coverage:prior?.coverage??(firstCreate?'complete':'partial')})
}
function mergeNativeCreationKeys(left:NativeCreationKeys|undefined,right:NativeCreationKeys|undefined):NativeCreationKeys {
  return {keys:[...new Set([...(left?.keys??[]),...(right?.keys??[])])],coverage:left?.coverage==='complete'&&right?.coverage==='complete'?'complete':'partial'}
}
function reservationNativeCreationKeys(reservation: AgentMuxLifecycleReservation, current?:AgentMuxStoredAgentSession|null, pending?:AgentMuxLifecycleReservation): NativeCreationKeys {
  let prior=reservation.kind==='reopen'?reservation.expectedRetirement.nativeCreationKeys:current?.nativeCreationKeys
  if(pending)prior=mergeNativeCreationKeys(prior,pending.nativeCreationKeys)
  return appendNativeCreationKeys(prior,reservation.kind==='stop'?(reservation.supersededResume?[reservation.supersededResume.lifecycleOperationId]:[]):[reservation.operationId],reservation.kind==='create')
}
function ordinaryNativeCreationKeys(current:AgentMuxStoredAgentSession|null|undefined,next:AgentMuxStoredAgentSession):AgentMuxStoredAgentSession {
  const {nativeCreationKeys:_untrusted,...rest}=next
  return {...rest,...(current?.nativeCreationKeys?{nativeCreationKeys:current.nativeCreationKeys}:{})}
}
function committedNativeCreationKeys(reservation:AgentMuxLifecycleReservation,current?:AgentMuxStoredAgentSession):NativeCreationKeys {
  return reservation.nativeCreationKeys??appendNativeCreationKeys({keys:current?.nativeCreationKeys?.keys??[],coverage:'partial'},reservation.kind==='stop'?(reservation.supersededResume?[reservation.supersededResume.lifecycleOperationId]:[]):[reservation.operationId])
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
    expiresAt: timestamp(source.expiresAt, 'expiresAt'),
    ...(source.nativeCreationKeys===undefined?{}:{nativeCreationKeys:nativeCreationKeys(source.nativeCreationKeys)})
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
    if (preparedCreation?.agentSessionId !== undefined && preparedCreation.agentSessionId !== base.agentSessionId ||
      preparedCreation?.initialInput && preparedCreation.initialInput.lifecycleOperationId !== base.operationId) throw new AgentMuxError('Prepared creation names another Session or lifecycle.', 'INVALID_AGENT_SESSION_STORE')
    return { ...base, kind: 'create', ...(preparedCreation ? { preparedCreation } : {}), ...(source.ownerReleased ? { ownerReleased: true as const } : {}) }
  }
  if (source.kind === 'resume') {
    const preparedSession = source.preparedSession === undefined ? undefined : normalizeStoredAgentSession(source.preparedSession)
    if (preparedSession && (preparedSession.agentSessionId !== base.agentSessionId || preparedSession.run.runId !== expectedRun!.runId)) throw new AgentMuxError('Prepared resume target mismatch.', 'INVALID_AGENT_SESSION_STORE')
    let restart: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>['restart']
    if (source.restart !== undefined) {
      const saved = record(source.restart, 'restart operation'), request = parseAgentRestartInput(saved.request)
      const nativeTarget = record(saved.nativeTarget, 'restart native target') as unknown as Extract<AgentNativeSessionHandle, { kind: 'provider' }>
      const originalStop = recoverableStopOperation(saved.stopOperation)
      if (typeof saved.requestDigest !== 'string' || !saved.requestDigest || request.agentSessionId !== base.agentSessionId || request.expectedRun.runId !== expectedRun!.runId ||
        nativeTarget.kind !== 'provider' || typeof nativeTarget.providerId !== 'string' || !nativeTarget.providerId ||
        typeof nativeTarget.sessionId !== 'string' || !nativeTarget.sessionId || originalStop.runId !== expectedRun!.runId ||
        base.operationId !== agentLifecycleOperationIdentity('restart', base.agentSessionId, request.operationId)) {
        throw new AgentMuxError('Original restart identity changed.', 'INVALID_AGENT_SESSION_STORE')
      }
      const startNotApplied = saved.startNotApplied === undefined ? undefined : record(saved.startNotApplied, 'original Start not-applied receipt')
      if (startNotApplied && (typeof startNotApplied.code !== 'string' || !startNotApplied.code || typeof startNotApplied.message !== 'string' ||
        !Number.isSafeInteger(startNotApplied.observedAt) || (startNotApplied.observedAt as number) < 0 || preparedSession)) throw new AgentMuxError('Invalid original restart Start receipt.', 'INVALID_AGENT_SESSION_STORE')
      restart = { requestDigest: saved.requestDigest, request, nativeTarget: structuredClone(nativeTarget), stopOperation: originalStop,
        ...(startNotApplied ? { startNotApplied: startNotApplied as { code: string; message: string; observedAt: number } } : {}) }
    }
    let resolution: AgentMuxPreparedResumeResolution | undefined
    if (source.resolution !== undefined) {
      const raw = rpcRecord(source.resolution, ['request', 'receipt'], 'INVALID_AGENT_SESSION_STORE')
      const request = parseResumeResolutionRequest(raw.request), receipt = parseResumeResolution(raw.receipt)
      const dispatch = preparedResumeDispatch(source.preparedDispatch, preparedSession, base.operationId)
      if (restart || request.agentSessionId !== base.agentSessionId || request.expectedRun.runId !== expectedRun!.runId ||
          request.operationId !== receipt.operationId || receipt.originalOperationId !== preparedSession?.continuity?.operationId ||
          receipt.originalCreationKey !== base.operationId || receipt.runtimeId !== dispatch.runtime.runtimeId ||
          receipt.requestDigest !== resumeResolutionDigest(request) || receipt.outcome !== 'pending') throw new AgentMuxError(
        'The original resume resolution changed its exact prepared target.', 'INVALID_AGENT_SESSION_STORE')
      resolution = { request, receipt }
    }
    if (source.ownerReleased !== undefined && (source.ownerReleased !== true || !restart && !resolution)) throw new AgentMuxError('Invalid resume owner release.', 'INVALID_AGENT_SESSION_STORE')
    return { ...base, kind: 'resume', expectedRun: expectedRun!, ...(preparedSession ? { preparedSession } : {}),
      ...(source.preparedDispatch === undefined ? {} : { preparedDispatch: preparedResumeDispatch(source.preparedDispatch, preparedSession, base.operationId) }),
      ...(restart ? { restart } : {}), ...(resolution ? { resolution } : {}), ...(source.ownerReleased === true ? { ownerReleased: true as const } : {}) }
  }
  const supersededResume = source.supersededResume === undefined ? undefined : parseStopSupersededResume(source.supersededResume)
  if (supersededResume?.retainedRun?.runId === expectedRun!.runId) throw new AgentMuxError('A retained resume Run cannot be the Run it resumed.', 'INVALID_AGENT_SESSION_STORE')
  return { ...base, kind: 'stop', expectedRun: expectedRun!, stopOperation: stopOperation!,
    ...(source.progress === undefined ? {} : { progress: parseAgentStopProgress(source.progress) }),
    ...(supersededResume ? { supersededResume } : {}) }
}

function sameSession(
  left: AgentMuxStoredAgentSession | null,
  right: AgentMuxStoredAgentSession | null
): boolean {
  return isDeepStrictEqual(
    left === null ? null : normalizeStoredAgentSession(ordinaryNativeCreationKeys(null,left)),
    right === null ? null : normalizeStoredAgentSession(ordinaryNativeCreationKeys(null,right))
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

function canSupersedeRestartWithStop(
  current: AgentMuxLifecycleReservation,
  requested: AgentMuxLifecycleReservation
): boolean {
  // prepareResume is the durable boundary before Start. Replacing only an
  // unprepared restart under this same Store transaction also fences a late
  // original prepareResume by its old reservationId; close never starts a Run.
  return requested.kind === 'stop' && current.kind === 'resume' && Boolean(current.restart) &&
    current.reservationId !== requested.reservationId &&
    !current.preparedSession && current.agentSessionId === requested.agentSessionId &&
    current.expectedRun.runId === requested.expectedRun.runId &&
    (current.ownerId === requested.ownerId || current.ownerReleased === true || !processIsAlive(current.ownerPid))
}

/**
 * A prepared resume (one that froze its Session before Start) that a Stop of the same Run may take
 * over: its owner is this one, has released it, or has ended. A Stop never fences the creation key of
 * a resume whose owner is still executing it.
 */
export function stoppablePreparedResume(holder: AgentMuxLifecycleReservation | null | undefined, ownerId: string,
  expectedRun: AgentMuxRunRef): Extract<AgentMuxLifecycleReservation, { kind: 'resume' }> | null {
  return holder?.kind === 'resume' && holder.preparedSession && !holder.restart && holder.expectedRun.runId === expectedRun.runId &&
    (holder.ownerId === ownerId || holder.ownerReleased === true || !processIsAlive(holder.ownerPid)) ? holder : null
}

/**
 * A Stop replaces that prepared resume only with the Runtime's witness for its exact creation key:
 * sealed, so no Run can start under it, or retained, so its one Run is known and is stopped with the
 * Session. Time passing or an owner process ending is no witness.
 */
function canSupersedePreparedResumeWithStop(current: AgentMuxLifecycleReservation, requested: AgentMuxLifecycleReservation): boolean {
  if (requested.kind !== 'stop' || current.reservationId === requested.reservationId || current.agentSessionId !== requested.agentSessionId) return false
  const holder = stoppablePreparedResume(current, requested.ownerId, requested.expectedRun)
  return Boolean(holder && requested.supersededResume?.lifecycleOperationId === holder.operationId)
}

function assertLifecycleReceiptFence(reservation: AgentMuxLifecycleReservation | null | undefined,
  current: AgentMuxStoredAgentSession | null, next: AgentMuxStoredAgentSession | null, committing = false): void {
  const resolution = current?.continuity?.resolution
  // A resolution owns its receipt only through a lifecycle reservation. Once a handed-off successor Start is
  // confirmed not applied and its reservation released, nothing executes it and a new manual intent may continue.
  if (reservation && current && next && resolution && current.continuity!.previousRun.runId === current.run.runId) {
    const original = current.continuityOperations?.[resolution.originalOperationId]
    if (next.continuity?.operationId !== resolution.operationId ||
        !(committing && reservation?.kind === 'resume' && reservation.resolution) && !isDeepStrictEqual(next.continuityOperations?.[resolution.originalOperationId], original) ||
        next.continuity?.resolution?.operationId !== resolution.operationId) throw new AgentMuxError(
      'The original resume resolution owns this pending receipt. Late observations cannot replace its current intent.', 'AGENT_CONTINUITY_SUPERSEDED')
  }
  if (reservation?.kind !== 'resume' || !reservation.restart || !next) return
  const restart = reservation.restart, id = restart.request.operationId
  const matches = (value: AgentMuxContinuityOperation | undefined): boolean => Boolean(value && value.action === 'restart' &&
    value.agentSessionId === reservation.agentSessionId && value.previousRun.runId === reservation.expectedRun.runId &&
    value.requestDigest === restart.requestDigest && matchesProviderNativeSessionTarget(restart.nativeTarget, value.nativeTarget))
  const check = (before: AgentMuxContinuityOperation | undefined, after: AgentMuxContinuityOperation | undefined): void => {
    if (isDeepStrictEqual(before, after)) return
    if (before && !matches(before) || !matches(after)) throw new AgentMuxError(
      'The exact operation belongs to an original restart. Its reservation and any existing receipt are retained.', 'AGENT_CONTINUITY_SUPERSEDED')
  }
  check(current?.continuityOperations?.[id], next.continuityOperations?.[id])
  // The pointer may move to a different operation, but cannot impersonate this
  // original restart while the authoritative map retains a different receipt.
  if (next.continuity?.operationId === id) check(current?.continuity?.operationId === id ? current.continuity : undefined, next.continuity)
}

/** The reservation is the authority for this exact frozen restart, never a new request. */
function restartAdmission(session: AgentMuxStoredAgentSession, reservation: AgentMuxLifecycleReservation,
  mode: 'new' | 'restore' | 'continue'): AgentMuxStoredAgentSession {
  if (reservation.kind !== 'resume' || !reservation.restart) return session
  const restart = reservation.restart, id = restart.request.operationId
  if (session.agentSessionId !== reservation.agentSessionId || session.run.runId !== reservation.expectedRun.runId ||
      !matchesProviderNativeSessionTarget(restart.nativeTarget, session.nativeHandle)) throw new AgentMuxError(
    'The original restart Session, Run or native target changed.', 'STALE_AGENT_SESSION')
  const prior = session.continuityOperations?.[id]
  if (prior) {
    if (mode === 'new' || prior.action !== 'restart' || prior.requestDigest !== restart.requestDigest ||
        prior.previousRun.runId !== reservation.expectedRun.runId ||
        !matchesProviderNativeSessionTarget(restart.nativeTarget, prior.nativeTarget)) throw new AgentMuxError(
      'The original restart operation has another receipt. Preserve both original requests.', 'AGENT_RESTART_CONFLICT')
    if (mode === 'restore') return session
  }
  const observedAt = Date.now()
  const admitted: AgentMuxContinuityOperation = { ...prior, operationId: id, agentSessionId: session.agentSessionId,
    action: 'restart', trigger: 'manual', policy: normalizeAgentContinuityPolicy(), previousRun: { ...reservation.expectedRun },
    nativeTarget: structuredClone(restart.nativeTarget), requestDigest: restart.requestDigest,
    admittedAt: prior?.admittedAt ?? observedAt, observedAt, rechecks: 0, kind: 'starting', reason: 'restart-stopping',
    evidence: { kind: 'run-unknown', observedAt, message: mode === 'restore'
      ? 'The original restart reservation was recovered; its admission time was not recorded.' : 'The original explicit restart was admitted.' },
    recoveryInputs: { reminder: '', continuation: '' } }
  delete admitted.nextActionAt; delete admitted.supervision; delete admitted.error; delete admitted.errorCode
  return { ...session, continuity: mode === 'restore' && session.continuity ? session.continuity : admitted,
    continuityOperations: { ...session.continuityOperations, [id]: admitted }, updatedAt: Math.max(session.updatedAt + 1, observedAt) }
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
  const original = retired.find(session => session.agentSessionId === mutation.agentSessionId)
  if (original?.recordDeletion) return false
  const commit = original?.activityCommit
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
    ...(source.nativeCreationKeys===undefined?{}:{nativeCreationKeys:nativeCreationKeys(source.nativeCreationKeys)}),
    hostId: string(source.hostId, 'retiredAgentSession.hostId'),
    run: runRef(source.run),
    source: 'user',
    observedAt: timestamp(source.observedAt, 'retiredAgentSession.observedAt'),
    ...(source.recordDeletion === undefined ? {} : { recordDeletion: parseAgentSessionRecordDeletion(source.recordDeletion) }),
    ...(source.continuityControlReceipts === undefined ? {} : { continuityControlReceipts: parseAgentContinuityControlReceipts(source.continuityControlReceipts, String(source.agentSessionId)) }),
    ...(source.history === undefined ? {} : { history: normalizeSessionHistoryMetadata(source.history) }),
    ...(source.executorInvocation === undefined ? {} : { executorInvocation: structuredClone(source.executorInvocation) }),
    ...(source.activityCommit === undefined ? {} : { activityCommit: activityCommit(source.activityCommit, string(source.agentSessionId, 'retiredAgentSession.agentSessionId')) }),
    ...(source.stop === undefined ? {} : { stop: parseAgentStopRecord(source.stop) })
  }
}

function deletedRetirement(current: AgentMuxRetiredAgentSession | null, expected: AgentMuxRetiredAgentSession,
  operationId: string, active: boolean, reserved: boolean): AgentMuxRetiredAgentSession {
  if (!current || active || reserved || current.agentSessionId !== expected.agentSessionId ||
    current.observedAt !== expected.observedAt || agentSessionRetirementRevision(current) !== agentSessionRetirementRevision(expected)) {
    throw new AgentMuxError('The exact retirement changed or has pending lifecycle work. No AgentMux record was deleted.', 'STALE_AGENT_SESSION')
  }
  if (current.recordDeletion) {
    if (current.recordDeletion.operationId !== operationId) throw new AgentMuxError(
      'This record already has another original deletion operation. Inspect its retained terminal fact.', 'AGENT_SESSION_RECORD_OPERATION_CONFLICT')
    return structuredClone(current)
  }
  return { ...current, recordDeletion: parseAgentSessionRecordDeletion({ operationId,
    retirementRevision: agentSessionRetirementRevision(current), deletedAt: Date.now(), phase: 'pending' }) }
}

/** Only original normalized Store facts form this CAS witness; it is never authorization. */
export function agentSessionRetirementRevision(retired: AgentMuxRetiredAgentSession): string {
  const { recordDeletion: _deletion, ...original } = retired
  return createHash('sha256').update(JSON.stringify(original)).digest('hex')
}

function confirmDeletedRetirement(current: AgentMuxRetiredAgentSession | null | undefined, expected: AgentMuxRetiredAgentSession) {
  if (!current?.recordDeletion || !expected.recordDeletion || agentSessionRetirementRevision(current) !== agentSessionRetirementRevision(expected) ||
    current.recordDeletion.operationId !== expected.recordDeletion.operationId || current.recordDeletion.deletedAt !== expected.recordDeletion.deletedAt ||
    current.recordDeletion.retirementRevision !== expected.recordDeletion.retirementRevision || expected.recordDeletion.phase === 'complete' && current.recordDeletion.phase !== 'complete') {
    throw new AgentMuxError('The original deletion fact changed before confirmation. Inspect its exact operation.', 'STALE_AGENT_SESSION')
  }
  return structuredClone(current)
}

/** The single reading projection shared by durable history and strict public decoding. */
export function normalizeSessionHistoryMetadata(value: unknown): AgentSessionHistoryMetadata {
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
    ...(source.toolExecution === undefined ? {} : { toolExecution: parseAgentToolExecutionBinding(source.toolExecution) }),
    createdAt: timestamp(source.createdAt, 'history.createdAt'),
    ...(source.creation === undefined ? {} : { creation: parseAgentCreationFact(source.creation) }),
    ...(source.forkedFrom === undefined ? {} : { forkedFrom: parseAgentForkSource(source.forkedFrom) }),
    ...(handle === undefined ? {} : { nativeHandle: handle }),
    ...(observed === undefined ? {} : { observedNativeHandle: observed }),
    ...(previous?.kind === 'provider' ? { previousNativeHandle: previous } : {})
  }
}

/** Project only reading identity, never Hook secrets, permissions or lifecycle controls. */
export function sessionHistoryMetadata(session: AgentMuxStoredAgentSession): AgentSessionHistoryMetadata {
  return normalizeSessionHistoryMetadata({ ...session,
    ...(session.nativeConfirmation ? { previousNativeHandle: session.nativeConfirmation.previousNativeHandle } : {}) })
}

// Keep cumulative input/recovery bodies in SQLite, rather than materializing them
// in JS for an exact source read. Raw JSON tokens preserve all original string
// escapes and types. A duplicate selected key needs the original JSON.parse
// last-value semantics: SQLite's path lookup would otherwise select its first.
// The outer query preserves a missing row.
const activeHistorySourceSql = `SELECT (
  SELECT CASE WHEN COUNT(*)=COUNT(DISTINCT key)
    THEN json_group_object(key, json(sessions.json -> fullkey))
    ELSE sessions.json END
  FROM json_each(sessions.json)
  WHERE key IN ('kind','agentSessionId','hostId','providerId','executorId','workspacePath',
    'toolExecution','createdAt','updatedAt','creation','forkedFrom','nativeHandle',
    'observedNativeHandle','nativeConfirmation')
) AS json FROM sessions WHERE id=?`

/** Exact read identity does not consume the Session's cumulative recovery bodies. */
function activeSessionHistorySource(value: unknown, id: string): AgentSessionHistoryDescriptor {
  const source = record(value, 'Agent Session')
  if (source.kind !== 'agent') throw new AgentMuxError('Only Agent Sessions may be persisted.', 'INVALID_AGENT_SESSION_STORE')
  const agentSessionId = string(source.agentSessionId, 'agentSessionId')
  if (agentSessionId !== id) throw new AgentMuxError('History source belongs to another Session.', 'INVALID_AGENT_SESSION_STORE')
  const confirmation = source.nativeConfirmation === undefined ? undefined : nativeConfirmation(source.nativeConfirmation)
  if (confirmation && !nativeConfirmationMatchesSession(confirmation, { agentSessionId,
    providerId: string(source.providerId, 'providerId'), updatedAt: timestamp(source.updatedAt, 'updatedAt') })) {
    throw new AgentMuxError('Native/activity facts do not match this Session.', 'INVALID_AGENT_SESSION_STORE')
  }
  return { agentSessionId, hostId: string(source.hostId, 'hostId'), state: 'active',
    history: normalizeSessionHistoryMetadata({ ...source,
      // The preceding source comes only from its original confirmation receipt.
      previousNativeHandle: confirmation?.previousNativeHandle }) }
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
  // Keep retained bytes when older receipts lack canonical evidence. They remain unqualified;
  // only an explicitly contradictory canonical declaration is invalid, never the whole Session.
  if (outputCursorBytes !== undefined && source.lifecycleEvent !== undefined && lifecycleEvent !== 'turn-end') {
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
        ...(failure.publicMessage === undefined ? {} : { publicMessage: text(failure.publicMessage, 'failure.publicMessage') }),
        recovery: text(failure.recovery, 'failure.recovery'), nativeTurnId: text(failure.nativeTurnId, 'failure.nativeTurnId'),
        ...(failure.nativeCode === undefined ? {} : { nativeCode: text(failure.nativeCode, 'failure.nativeCode') }),
        ...(http === undefined ? {} : { httpStatusCode: Number(http) }) }
    })() }),
    ...(source.idleEvidenceConsumed === undefined ? {} : { idleEvidenceConsumed: (() => {
      if (source.idleEvidenceConsumed !== true || source.state !== 'done') throw new AgentMuxError('Invalid consumed completion.', 'INVALID_AGENT_SESSION_STORE')
      return true as const
    })() }),
  }
}

function turnUsage(value: unknown): AgentTurnUsage {
  const source = record(value, 'turnUsage')
  const cumulative = parseCumulativeUsage(source.cumulative)
  // 必需的响应计数与观测时刻沿 timestamp 校验非负安全整数。
  // 可选累计单独校验，缺失或损坏不删除有效响应与 context。
  return {
    inputTokens: timestamp(source.inputTokens, 'turnUsage.inputTokens'),
    outputTokens: timestamp(source.outputTokens, 'turnUsage.outputTokens'),
    totalTokens: timestamp(source.totalTokens, 'turnUsage.totalTokens'),
    observedAt: timestamp(source.observedAt, 'turnUsage.observedAt'),
    ...(source.scope === 'response' ? { scope: 'response' as const } : {}),
    ...(cumulative ? { cumulative } : {}),
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

export function normalizeAgentInteractionRequest(value: unknown): AgentMuxInteractionRequest {
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
    const toolInput = source.toolInput
    if (toolInput !== undefined && (typeof toolInput !== 'string' ||
        Buffer.byteLength(toolInput) > MAX_PATH_BYTES || toolInput.includes('\0'))) {
      throw new AgentMuxError('pendingInteraction.request.toolInput is invalid.', 'INVALID_AGENT_SESSION_STORE')
    }
    const request: Extract<AgentMuxInteractionRequest, { kind: 'permission' }> = {
      kind: 'permission',
      ...base,
      title: text(source.title, 'pendingInteraction.request.title'),
      options,
      ...(toolName ? { toolName } : {}),
      ...(toolInput !== undefined ? { toolInput } : {}),
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
  const request = normalizeAgentInteractionRequest(source.request)
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
  const additionalRequests = (source.additionalRequests ?? []).map(normalizeAgentInteractionRequest)
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
    ...(source.frontendId === undefined ? {} : { frontendId: string(source.frontendId, 'terminalHandshake.frontendId') }),
    ...(source.outputAfterByte === undefined ? {} : { outputAfterByte: timestamp(source.outputAfterByte, 'terminalHandshake.outputAfterByte') }),
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
    !['handshake-timeout', 'handshake-unconfirmed'].includes(source.reason as string) ||
    run.runId !== currentRun.runId
  ) {
    throw new AgentMuxError(
      'Terminal capability state does not match its Agent Run.',
      'INVALID_AGENT_SESSION_STORE'
    )
  }
  const diagnostic = source.diagnostic === undefined ? undefined : record(source.diagnostic, 'terminalCapability.diagnostic')
  return {
    state: 'unknown',
    mode: 'degraded',
    reason: source.reason as AgentTerminalCapabilityState['reason'],
    ...(diagnostic ? { diagnostic: {
      code: string(diagnostic.code, 'terminalCapability.diagnostic.code'),
      message: text(diagnostic.message, 'terminalCapability.diagnostic.message')
    } } : {}),
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
  if (Object.keys(p).some(key => !['operationId', 'run', 'previousNativeHandle', 'nativeHandle', 'observedAt', 'candidateObservedAt', 'basis', 'previousInteraction', 'previousPromptSubmissionId'].includes(key))) {
    throw new AgentMuxError('Invalid native confirmation receipt.', 'INVALID_AGENT_SESSION_STORE')
  }
  const previousNativeHandle = nativeHandle(p.previousNativeHandle), handle = nativeHandle(p.nativeHandle)
  if (previousNativeHandle.kind !== 'provider' || handle.kind !== 'provider' ||
    previousNativeHandle.providerId !== handle.providerId ||
    p.basis !== undefined && p.basis !== 'current-main' && p.basis !== 'run-main-candidate' ||
    previousNativeHandle.sessionId === handle.sessionId && (p.basis !== 'run-main-candidate' || previousNativeHandle.transcriptPath !== handle.transcriptPath)) {
    throw new AgentMuxError('Native confirmation requires two exact Provider conversations.', 'INVALID_AGENT_SESSION_STORE')
  }
  return { operationId: string(p.operationId, 'nativeConfirmation.operationId'), run: runRef(p.run),
    previousNativeHandle, nativeHandle: handle, observedAt: timestamp(p.observedAt, 'nativeConfirmation.observedAt'),
    candidateObservedAt: timestamp(p.candidateObservedAt, 'nativeConfirmation.candidateObservedAt'),
    ...(p.basis === undefined ? {} : { basis: p.basis as 'current-main' | 'run-main-candidate' }),
    ...(p.previousInteraction === undefined ? {} : { previousInteraction: pendingInteraction(p.previousInteraction) }),
    ...(p.previousPromptSubmissionId === undefined ? {} : { previousPromptSubmissionId: string(p.previousPromptSubmissionId, 'nativeConfirmation.previousPromptSubmissionId') }) }
}

function nativeConfirmationMatchesSession(confirmation: AgentNativeSessionConfirmationReceipt,
  session: Pick<AgentMuxAgentSession, 'agentSessionId' | 'providerId' | 'updatedAt'>): boolean {
  return confirmation.nativeHandle.providerId === session.providerId && confirmation.observedAt <= session.updatedAt &&
    confirmation.candidateObservedAt <= confirmation.observedAt && (!confirmation.previousInteraction ||
      confirmation.previousInteraction.request.agentSessionId === session.agentSessionId &&
      confirmation.previousInteraction.request.evidence.run?.runId === confirmation.run.runId)
}

export function parseAgentCreationSpatialIntent(value: unknown): import('./types.js').AgentMuxAgentCreationSpatialIntent {
  const intent = record(value, 'creation.spatialIntent')
  if (Object.keys(intent).some(key => !['tabId', 'regionId', 'executionWorkspaceId'].includes(key)))
    throw new AgentMuxError('Creation spatial intent requires only its exact original position and execution Workspace.', 'INVALID_AGENT_SESSION_STORE')
  return { tabId: string(intent.tabId, 'creation.spatialIntent.tabId'), regionId: string(intent.regionId, 'creation.spatialIntent.regionId'),
    executionWorkspaceId: string(intent.executionWorkspaceId, 'creation.spatialIntent.executionWorkspaceId') }
}

export function parseAgentCreationFact(value: unknown): NonNullable<AgentMuxAgentSession['creation']> {
  const creation = record(value, 'creation'), initialPrompt = creation.initialPrompt
  if (typeof initialPrompt !== 'string' || !['not-requested', 'confirmed', 'unconfirmed', 'unknown'].includes(initialPrompt) ||
    creation.agentMuxContext !== undefined && (typeof creation.agentMuxContext !== 'string' || !['confirmed', 'unconfirmed', 'unknown'].includes(creation.agentMuxContext)) ||
    creation.intentDigest !== undefined && (typeof creation.intentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(creation.intentDigest)) ||
    creation.executorInvocationDigest !== undefined && (typeof creation.executorInvocationDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(creation.executorInvocationDigest)) ||
    creation.executorRevision !== undefined && (typeof creation.executorRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(creation.executorRevision)) ||
    creation.persistence !== undefined && creation.persistence !== 'unconfirmed') throw new AgentMuxError('Invalid creation receipt.', 'INVALID_AGENT_SESSION_STORE')
  let failure: NonNullable<AgentMuxAgentSession['creation']>['failure']
  if (creation.failure !== undefined) {
    const p = record(creation.failure, 'creation.failure')
    if (Object.keys(p).some(key => !['step', 'code', 'message'].includes(key)) || typeof p.step !== 'string' || !['session-commit', 'hook-bind', 'handshake'].includes(p.step)) throw new AgentMuxError('Invalid creation failure step.', 'INVALID_AGENT_SESSION_STORE')
    failure = { step: p.step as NonNullable<typeof failure>['step'], code: string(p.code, 'creation.failure.code'), message: text(p.message, 'creation.failure.message') }
  }
  return { createOperationId: string(creation.createOperationId, 'creation.createOperationId'), initialPrompt: initialPrompt as NonNullable<AgentMuxAgentSession['creation']>['initialPrompt'],
    ...(creation.workspaceTrust === undefined ? {} : { workspaceTrust: parseWorkspaceTrustPreparation(creation.workspaceTrust) }),
    ...(creation.spatialIntent === undefined ? {} : { spatialIntent: parseAgentCreationSpatialIntent(creation.spatialIntent) }),
    ...(creation.initialInputKey === undefined ? {} : { initialInputKey: (() => {
      const key = validateAgentPromptInputKey(creation.initialInputKey)
      if (key.kind !== 'prompt') throw new AgentMuxError('Creation requires its original prompt key.', 'INVALID_AGENT_SESSION_STORE')
      return key
    })() }),
    ...(creation.createdBy === undefined ? {} : { createdBy: parseAgentSpawnCreator(creation.createdBy) }),
    ...(creation.createdRun === undefined ? {} : { createdRun: runRef(creation.createdRun) }),
    ...(creation.initialMessageId === undefined ? {} : { initialMessageId: string(creation.initialMessageId, 'creation.initialMessageId') }),
    ...(creation.initialMessageOrigin === undefined ? {} : { initialMessageOrigin: parseAgentMuxCreationOrigin(creation.initialMessageOrigin) }),
    ...(creation.executorRevision === undefined ? {} : { executorRevision: creation.executorRevision as string }),
    ...(creation.executorInvocationDigest === undefined ? {} : { executorInvocationDigest: creation.executorInvocationDigest as string }),
    ...(creation.agentMuxContext === undefined ? {} : { agentMuxContext: creation.agentMuxContext as 'confirmed' | 'unconfirmed' | 'unknown' }),
    ...(creation.intentDigest === undefined ? {} : { intentDigest: creation.intentDigest as string }),
    ...(creation.persistence === undefined ? {} : { persistence: 'unconfirmed' as const }), ...(failure ? { failure } : {}) }
}

/** Only the creation owner writes this private packet; its text and author are immutable. */
function normalizeInitialInput(value: unknown, agentSessionId: string): NonNullable<AgentMuxStoredAgentSession['initialInput']> {
  const p = record(value, 'initialInput'), input = record(p.input, 'initialInput.input'), message = record(p.message, 'initialInput.message')
  const body = (value: unknown) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= MAX_STORED_TEXT_BYTES
  if (Object.keys(p).some(key => !['input', 'prompt', 'message', 'digest', 'delivery', 'lifecycleOperationId', 'launchPlan', 'state', 'key', 'receipt'].includes(key)) ||
      Object.keys(input).some(key => !['submissionId', 'prompt'].includes(key)) ||
      Object.keys(message).some(key => !['userContent', 'systemContext', 'authorAgentSessionId'].includes(key)) ||
      typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt) > MAX_STORED_TEXT_BYTES ||
      message.userContent !== (input.prompt.trim() ? input.prompt : undefined) ||
      !body(p.prompt) || p.digest !== createHash('sha256').update(p.prompt as string).digest('base64url')) {
    throw new AgentMuxError('Invalid original creation input.', 'INVALID_AGENT_SESSION_STORE')
  }
  string(input.submissionId, 'initialInput.submissionId')
  string(p.lifecycleOperationId, 'initialInput.lifecycleOperationId')
  if (p.launchPlan !== undefined) {
    const plan = record(p.launchPlan, 'initialInput.launchPlan')
    if (Object.keys(plan).some(key => !['program', 'argsDigest'].includes(key)) ||
      typeof plan.argsDigest !== 'string' || !/^[a-zA-Z0-9_-]{43}$/u.test(plan.argsDigest)) throw new AgentMuxError('Invalid initial launch provenance.', 'INVALID_AGENT_SESSION_STORE')
    string(plan.program, 'initialInput.launchPlan.program', MAX_PATH_BYTES)
  }
  if (p.receipt !== undefined) {
    const receipt = record(p.receipt, 'initialInput.receipt')
    if (Object.keys(receipt).some(key => !['kind', 'operationId', 'run', 'observedAt'].includes(key))) throw new AgentMuxError('Invalid initial launch receipt.', 'INVALID_AGENT_SESSION_STORE')
    runRef(receipt.run)
  }
  for (const key of ['userContent', 'systemContext'] as const) if (message[key] !== undefined && !body(message[key])) throw new AgentMuxError('Invalid initial input message.', 'INVALID_AGENT_SESSION_STORE')
  if (message.authorAgentSessionId !== undefined) string(message.authorAgentSessionId, 'initialInput.author')
  const normalized = normalizeAgentContinuityLaunchInput(p)
  if (normalized.key && normalized.key.agentSessionId !== agentSessionId ||
      normalized.state !== 'prepared' && !normalized.key || normalized.delivery === 'launch' &&
      !['prepared', 'launch-carried'].includes(normalized.state)) throw new AgentMuxError('Initial input changed its original target or carrier.', 'INVALID_AGENT_SESSION_STORE')
  return normalized
}

function assertInitialInputWrite(previous: AgentMuxStoredAgentSession | null, next: AgentMuxStoredAgentSession): void {
  if (!previous?.initialInput) return
  const { state: _before, ...original } = previous.initialInput
  const { state: _after, ...updated } = next.initialInput ?? {}
  if (!isDeepStrictEqual(original, updated)) throw new AgentMuxError('The original creation input body and identity are immutable.', 'AGENT_PROMPT_OPERATION_CONFLICT')
}

function normalizePreparedCreation(value: unknown): AgentMuxPreparedCreation {
  const p = record(value, 'prepared creation')
  if (p.kind !== 'agent' || Object.keys(p).some(key => !['kind', 'agentSessionId', 'providerId', 'executorId', 'hostId', 'workspacePath',
    'hookBindingId', 'hookToken', 'capabilityHash', 'createdAt', 'updatedAt', 'toolExecution', 'creation', 'forkedFrom', 'nativeHandle', 'launchOptions', 'nativeActor', 'initialInput', 'executorInvocation'].includes(key))) throw new AgentMuxError('Invalid no-Run creation seed.', 'INVALID_AGENT_SESSION_STORE')
  const creation = parseAgentCreationFact(p.creation), forkedFrom = p.forkedFrom === undefined ? undefined : parseAgentForkSource(p.forkedFrom)
  const initialInput = p.initialInput === undefined ? undefined : normalizeInitialInput(p.initialInput, String(p.agentSessionId))
  if (!creation.intentDigest || creation.createdRun || creation.initialInputKey || creation.persistence || creation.failure ||
    initialInput && (initialInput.key || initialInput.receipt || initialInput.state !== 'prepared') ||
    creation.agentMuxContext !== undefined && creation.agentMuxContext !== 'unknown' ||
    forkedFrom && forkedFrom.expectedNativeHandle.providerId !== p.providerId) throw new AgentMuxError('Prepared creation intent is incomplete.', 'INVALID_AGENT_SESSION_STORE')
  return { kind: 'agent', agentSessionId: string(p.agentSessionId, 'agentSessionId'), providerId: string(p.providerId, 'providerId'),
    executorId: string(p.executorId, 'executorId'), hostId: string(p.hostId, 'hostId'), workspacePath: string(p.workspacePath, 'workspacePath', MAX_PATH_BYTES),
    ...(p.toolExecution === undefined ? {} : { toolExecution: parseAgentToolExecutionBinding(p.toolExecution) }),
    hookBindingId: string(p.hookBindingId, 'hookBindingId'), hookToken: string(p.hookToken, 'hookToken'), capabilityHash: string(p.capabilityHash, 'capabilityHash'),
    createdAt: timestamp(p.createdAt, 'createdAt'), updatedAt: timestamp(p.updatedAt, 'updatedAt'), creation, ...(forkedFrom ? { forkedFrom } : {}),
    ...(p.nativeHandle === undefined ? {} : { nativeHandle: nativeHandle(p.nativeHandle) }),
    ...(p.nativeActor === undefined ? {} : { nativeActor: normalizePrivateNativeActor(p.nativeActor) }),
    ...(p.executorInvocation === undefined ? {} : { executorInvocation: structuredClone(p.executorInvocation) }),
    ...(initialInput ? { initialInput } : {}),
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
    ...(source.toolExecution === undefined ? {} : { toolExecution: parseAgentToolExecutionBinding(source.toolExecution) }),
    ...(source.continuityControlReceipts === undefined ? {} : { continuityControlReceipts: parseAgentContinuityControlReceipts(source.continuityControlReceipts, String(source.agentSessionId)) }),
    ...(source.continuity === undefined ? {} : { continuity: normalizeAgentContinuityOperation(source.continuity) }),
    ...(source.continuityOperations === undefined ? {} : { continuityOperations: Object.fromEntries(Object.entries(record(source.continuityOperations, 'continuity operations')).map(([id, value]) => {
      const operation = normalizeAgentContinuityOperation(value)
      if (operation.operationId !== id || operation.agentSessionId !== source.agentSessionId) throw new AgentMuxError('Continuity operation target mismatch.', 'INVALID_AGENT_SESSION_STORE')
      return [id, operation]
    })) }),
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
    ...(source.creation === undefined ? {} : { creation: parseAgentCreationFact(source.creation) }),
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
        return [id, { ...(intent.continuitySource === undefined ? {} : { continuitySource: parseAutomaticInputSource(intent.continuitySource) }), operationId: string(intent.operationId, 'future intent operation'), prompt: text(intent.prompt, 'future prompt', MAX_STORED_TEXT_BYTES), active: intent.active,
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
    ...(source.nativeSubagents === undefined ? {} : { nativeSubagents: parseNativeSubagents(source.nativeSubagents) }),
    ...(source.pendingInteraction === undefined
      ? {}
      : { pendingInteraction: pendingInteraction(source.pendingInteraction) }),
    ...(source.nativeHandle === undefined ? {} : { nativeHandle: nativeHandle(source.nativeHandle) }),
    ...(source.observedNativeHandle === undefined ? {} : { observedNativeHandle: nativeHandle(source.observedNativeHandle) }),
    ...(source.nativeSourceObservation === undefined ? {} : { nativeSourceObservation: (() => {
      const p = record(source.nativeSourceObservation, 'nativeSourceObservation')
      if (Object.keys(p).some(key => !['state', 'run', 'observedAt', 'reason', 'candidates'].includes(key)) ||
        !['changed', 'unknown', 'ambiguous'].includes(String(p.state))) throw new AgentMuxError('Invalid native source observation.', 'INVALID_AGENT_SESSION_STORE')
      const candidates = p.candidates === undefined ? undefined : (() => {
        if (p.state !== 'ambiguous' || !Array.isArray(p.candidates) || p.candidates.length === 0) {
          throw new AgentMuxError('Native candidates require an ambiguous Run observation.', 'INVALID_AGENT_SESSION_STORE')
        }
        const handles = p.candidates.map(nativeHandle)
        if (handles.some(handle => handle.kind !== 'provider' || handle.providerId !== source.providerId) ||
          new Set(handles.map(handle => handle.sessionId)).size !== handles.length) {
          throw new AgentMuxError('Native candidates must be distinct main conversations of this Provider.', 'INVALID_AGENT_SESSION_STORE')
        }
        return handles as Extract<AgentNativeSessionHandle, { kind: 'provider' }>[]
      })()
      return { state: p.state as 'changed' | 'unknown' | 'ambiguous', run: runRef(p.run),
        ...(candidates ? { candidates } : {}),
        observedAt: timestamp(p.observedAt, 'nativeSourceObservation.observedAt'), reason: string(p.reason, 'nativeSourceObservation.reason') }
    })() }),
    ...(source.nativeConfirmation === undefined ? {} : { nativeConfirmation: nativeConfirmation(source.nativeConfirmation) }),
    ...(source.nativeConfirmationHistory === undefined ? {} : { nativeConfirmationHistory: (() => {
      if (!Array.isArray(source.nativeConfirmationHistory)) throw new AgentMuxError('Native confirmation history must be an array.', 'INVALID_AGENT_SESSION_STORE')
      return source.nativeConfirmationHistory.map(nativeConfirmation)
    })() }),
    ...(source.nativeBinding === undefined ? {} : { nativeBinding: (() => {
      const binding = record(source.nativeBinding, 'nativeBinding')
      if (!['native-hook', 'process-witness', 'semantic-resume-target', 'user-confirmed', 'user-selected'].includes(String(binding.source))) throw new AgentMuxError('Invalid native binding source.', 'INVALID_AGENT_SESSION_STORE')
      return { source: binding.source as 'native-hook' | 'process-witness' | 'semantic-resume-target' | 'user-confirmed' | 'user-selected', run: runRef(binding.run), observedAt: timestamp(binding.observedAt, 'nativeBinding.observedAt') }
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
  if (session.nativeSubagents && (session.nativeSubagents.providerId !== session.providerId ||
      ![currentRun, ...priorRuns].some(run => run.runId === session.nativeSubagents!.run.runId) ||
      session.nativeSubagents.sessions.some(child => child.observedAt > session.updatedAt))) throw new AgentMuxError('Child observation scope is invalid.', 'INVALID_AGENT_SESSION_STORE')
  const inputKey = session.promptCompletionAdmission?.inputKey
  const initialKey = session.creation?.initialInputKey
  if (initialKey && (initialKey.agentSessionId !== session.agentSessionId ||
    ![currentRun, ...priorRuns].some(run => run.runId === initialKey.expectedRun.runId))) throw new AgentMuxError('Creation input key names another original Session or Run.', 'INVALID_AGENT_SESSION_STORE')
  if (inputKey && (inputKey.agentSessionId !== session.agentSessionId ||
      agentPromptInputId(inputKey) !== session.promptCompletionAdmission!.submissionId ||
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
    (session.nativeConfirmation && !nativeConfirmationMatchesSession(session.nativeConfirmation, session)) ||
    (session.observedNativeHandle?.kind === 'provider' && session.observedNativeHandle.providerId !== session.providerId)) {
    throw new AgentMuxError('Native/activity facts do not match this Session.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (session.nativeHandle?.kind === 'provider'  && session.nativeHandle.providerId !== session.providerId) {
    throw new AgentMuxError('Native session handle provider does not match the Agent.', 'INVALID_AGENT_SESSION_STORE')
  }
  const confirmations = [...(session.nativeConfirmationHistory ?? []), ...(session.nativeConfirmation ? [session.nativeConfirmation] : [])]
  if (new Set(confirmations.map(value => value.operationId)).size !== confirmations.length ||
    confirmations.some(value => !nativeConfirmationMatchesSession(value, session))) {
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

export function normalizeInteractionOperationReceipt(value: unknown): AgentMuxInteractionOperationReceipt {
  const source = record(value, 'interaction operation')
  const expectedRequest = normalizeAgentInteractionRequest(source.expectedRequest)
  const run = runRef(source.run), agentSessionId = string(source.agentSessionId, 'interaction Session')
  if (Object.keys(source).some(key => !['operationId', 'agentSessionId', 'run', 'expectedRequest', 'response', 'delivery', 'inputByteRange', 'nativeAdoption', 'nativeHandle', 'nativeCompleted', 'externalAction', 'authorHuman', 'moteObservationId'].includes(key)) || source.authorHuman !== undefined && source.authorHuman !== true || expectedRequest.agentSessionId !== agentSessionId || expectedRequest.evidence.run?.runId !== run.runId) throw new AgentMuxError('Interaction operation target mismatch.', 'INVALID_AGENT_SESSION_STORE')
  const delivery = source.delivery
  if (!['saved', 'unknown', 'bytes-accepted', 'hook-written', 'acp-acknowledged'].includes(String(delivery)) ||
      source.nativeAdoption !== 'unknown') throw new AgentMuxError('Invalid interaction operation facts.', 'INVALID_AGENT_SESSION_STORE')
  const range = source.inputByteRange === undefined ? undefined : record(source.inputByteRange, 'interaction byte range')
  const inputByteRange = range && { startByte: timestamp(range.startByte, 'interaction start byte'), endByte: timestamp(range.endByte, 'interaction end byte') }
  if (inputByteRange && inputByteRange.endByte <= inputByteRange.startByte) throw new AgentMuxError('Invalid interaction byte range.', 'INVALID_AGENT_SESSION_STORE')
  const nativeCompleted = source.nativeCompleted === undefined ? undefined : interactionEvidence(source.nativeCompleted)
  if (nativeCompleted && (nativeCompleted.source !== 'native-hook' || nativeCompleted.run?.runId !== run.runId) || delivery === 'bytes-accepted' && !inputByteRange || delivery === 'hook-written' && (expectedRequest.kind !== 'permission' || !expectedRequest.permissionHook) || delivery === 'acp-acknowledged' && expectedRequest.evidence.source !== 'acp') throw new AgentMuxError('Interaction operation receipt mismatch.', 'INVALID_AGENT_SESSION_STORE')
  return { operationId: string(source.operationId, 'interaction operation id'), agentSessionId, run,
    ...(source.authorHuman === true ? {authorHuman:true as const} : {}),
    ...(source.moteObservationId === undefined ? {} : {moteObservationId:string(source.moteObservationId,'Mote input observation')}),
    expectedRequest, response: interactionResponse(source.response, expectedRequest),
    ...(source.externalAction === undefined ? {} : { externalAction: parseAgentExternalInteractionAuthor(source.externalAction) }),
    delivery: delivery as AgentMuxInteractionOperationReceipt['delivery'], nativeAdoption: 'unknown',
    ...(inputByteRange ? { inputByteRange } : {}),
    ...(source.nativeHandle === undefined ? {} : { nativeHandle: nativeHandle(source.nativeHandle) }),
    ...(nativeCompleted === undefined ? {} : { nativeCompleted }) }
}

function nativeTurnEnds(value: unknown): NonNullable<AgentMuxStoredAgentSession['nativeTurnEnds']> {
  const source = record(value, 'nativeTurnEnds')
  if (Object.keys(source).some(key => !['run', 'providerId', 'nativeHandle', 'turns'].includes(key))) {
    throw new AgentMuxError('Native turn ends contain an unknown field.', 'INVALID_AGENT_SESSION_STORE')
  }
  const handle = nativeHandle(source.nativeHandle)
  const rawHandle = record(source.nativeHandle, 'nativeTurnEnds.nativeHandle')
  if (!isDeepStrictEqual(rawHandle, handle)) {
    throw new AgentMuxError('Native turn ends must retain the exact source locator.', 'INVALID_AGENT_SESSION_STORE')
  }
  const providerId = string(source.providerId, 'nativeTurnEnds.providerId')
  if (handle.kind === 'provider' && handle.providerId !== providerId) {
    throw new AgentMuxError('Native turn ends conflict with their Provider.', 'INVALID_AGENT_SESSION_STORE')
  }
  return { run: runRef(source.run), providerId, nativeHandle: handle,
    turns: Object.fromEntries(Object.entries(record(source.turns, 'nativeTurnEnds.turns')).map(([turnId, value]) => {
      string(turnId, 'nativeTurnEnds native turn ID')
      const end = record(value, 'nativeTurnEnds end')
      if (Object.keys(end).some(key => !['recordId', 'observedAt', 'nativeObservedAt', 'sequence'].includes(key))) {
        throw new AgentMuxError('Native turn end contains an unknown field.', 'INVALID_AGENT_SESSION_STORE')
      }
      return [turnId, { recordId: string(end.recordId, 'nativeTurnEnds.recordId'),
        ...(end.sequence === undefined ? {} : { sequence: positiveInteger(end.sequence, 'nativeTurnEnds.sequence') }),
        observedAt: timestamp(end.observedAt, 'nativeTurnEnds.observedAt'),
        ...(end.nativeObservedAt === undefined ? {} : { nativeObservedAt: timestamp(end.nativeObservedAt, 'nativeTurnEnds.nativeObservedAt') }) }]
    })) }
}

function nativeInteractionEnds(value: unknown): NonNullable<AgentMuxStoredAgentSession['nativeInteractionEnds']> {
  const source = record(value, 'nativeInteractionEnds'), handle = nativeHandle(source.nativeHandle)
  const providerId = string(source.providerId, 'nativeInteractionEnds.providerId')
  if (Object.keys(source).some(key => !['run', 'providerId', 'nativeHandle', 'calls'].includes(key)) ||
      !isDeepStrictEqual(source.nativeHandle, handle) || handle.kind !== 'provider' || handle.providerId !== providerId) {
    throw new AgentMuxError('Native interaction ends do not retain their exact Provider source.', 'INVALID_AGENT_SESSION_STORE')
  }
  return { run: runRef(source.run), providerId, nativeHandle: handle,
    calls: Object.fromEntries(Object.entries(record(source.calls, 'nativeInteractionEnds.calls')).map(([key, value]) => {
      const end = record(value, 'native interaction end'), nativeToolCallId = string(end.nativeToolCallId, 'native interaction call ID')
      if (Object.keys(end).some(key => !['kind', 'nativeToolCallId', 'hookReceiptId', 'observedAt'].includes(key)) ||
          end.kind !== 'question' && end.kind !== 'permission' || key !== JSON.stringify([end.kind, nativeToolCallId])) {
        throw new AgentMuxError('Native interaction end identity is invalid.', 'INVALID_AGENT_SESSION_STORE')
      }
      return [key, { kind: end.kind, nativeToolCallId, hookReceiptId: string(end.hookReceiptId, 'native interaction completion receipt'),
        observedAt: timestamp(end.observedAt, 'native interaction completion observedAt') }]
    })) }
}

function recoveryActivity(value: unknown, session: AgentMuxAgentSession): AgentRecoveryActivity {
  const source = record(value, 'recoveryActivity')
  const run = runRef(source.run)
  const handle = session.nativeHandle
  if (Object.keys(source).some(key => !['state', 'interruption', 'nativeSessionId', 'nativeTurnId', 'sourceId',
    'sequence', 'run', 'hookReceiptId', 'observedAt', 'promptSubmissionId', 'mainState'].includes(key)) ||
    !['active', 'idle', 'unknown'].includes(String(source.state)) || run.runId !== session.run.runId ||
    handle?.kind !== 'provider' || handle.providerId !== session.providerId || source.nativeSessionId !== handle.sessionId ||
    source.interruption !== undefined && (source.state !== 'idle' || !['interrupted', 'not-interrupted'].includes(String(source.interruption)))) {
    throw new AgentMuxError('Recovery activity does not match its original native Run.', 'INVALID_AGENT_SESSION_STORE')
  }
  const observedAt = timestamp(source.observedAt, 'recoveryActivity.observedAt')
  if (observedAt > session.updatedAt) {
    throw new AgentMuxError('Recovery activity exceeds the Session time.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (source.mainState !== undefined && !['active', 'idle', 'unknown'].includes(String(source.mainState))) throw new AgentMuxError('Main activity is invalid.', 'INVALID_AGENT_SESSION_STORE')
  return { run, state: source.state as AgentRecoveryActivity['state'],
    ...(source.mainState === undefined ? {} : { mainState: source.mainState as AgentRecoveryActivity['state'] }),
    nativeSessionId: string(source.nativeSessionId, 'recoveryActivity.nativeSessionId'),
    sourceId: string(source.sourceId, 'recoveryActivity.sourceId'),
    sequence: positiveInteger(source.sequence, 'recoveryActivity.sequence'),
    hookReceiptId: string(source.hookReceiptId, 'recoveryActivity.hookReceiptId'), observedAt,
    ...(source.state !== 'unknown' || source.nativeTurnId !== undefined
      ? { nativeTurnId: string(source.nativeTurnId, 'recoveryActivity.nativeTurnId') } : {}),
    ...(source.interruption === undefined ? {} : { interruption: source.interruption as NonNullable<AgentRecoveryActivity['interruption']> }),
    ...(source.promptSubmissionId === undefined ? {} : { promptSubmissionId: string(source.promptSubmissionId, 'recoveryActivity.promptSubmissionId') }) }
}

function normalizePrivateNativeActor(value: unknown): import('./types.js').AgentPrivateNativeActor {
  const v = record(value, 'private native actor')
  const launch = record(v.launch, 'original Provider launch')
  if (Object.keys(v).some(k => !['protocolId', 'actorId', 'lifecycleOperationId', 'token', 'launch', 'frontendControl', 'initializationControl'].includes(k)) || typeof v.token !== 'string' || !/^[a-f0-9]{64}$/u.test(v.token) ||
      v.frontendControl !== undefined && v.frontendControl !== true ||
      v.initializationControl !== undefined && (v.initializationControl !== true || v.frontendControl !== true) ||
      Object.keys(launch).some(k => k !== 'command' && k !== 'args') || !Array.isArray(launch.args) || launch.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new AgentMuxError('Invalid private native actor.', 'INVALID_AGENT_SESSION_STORE')
  return { protocolId: string(v.protocolId, 'native protocol'), actorId: string(v.actorId, 'native actor'), lifecycleOperationId: string(v.lifecycleOperationId, 'native lifecycle'), token: v.token,
    ...(v.frontendControl === true ? { frontendControl: true as const } : {}),
    ...(v.initializationControl === true ? { initializationControl: true as const } : {}),
    launch: { command: string(launch.command, 'original Provider command', MAX_PATH_BYTES), args: [...launch.args] as string[] } }
}

export function normalizeStoredAgentSession(value: unknown): AgentMuxStoredAgentSession {
  const source = record(value, 'Agent Session')
  const session = normalizeAgentSession(source)
  const initialInput = source.initialInput === undefined ? undefined : normalizeInitialInput(source.initialInput, session.agentSessionId)
  if (initialInput && (!initialInput.key || !isDeepStrictEqual(initialInput.key, session.creation?.initialInputKey) ||
      ![session.run, ...session.retiredRuns].some(run => run.runId === initialInput.key!.expectedRun.runId))) throw new AgentMuxError('Initial input lost its original creation Run.', 'INVALID_AGENT_SESSION_STORE')
  return { ...session,
    ...(source.nativeCreationKeys===undefined?{}:{nativeCreationKeys:nativeCreationKeys(source.nativeCreationKeys)}),
    ...(initialInput ? { initialInput } : {}),
    ...(source.recoveryActivity === undefined ? {} : { recoveryActivity: recoveryActivity(source.recoveryActivity, session) }),
    ...(source.nativeActor === undefined ? {} : { nativeActor: normalizePrivateNativeActor(source.nativeActor) }),
    ...(source.continuityExecutors === undefined ? {} : { continuityExecutors: structuredClone(source.continuityExecutors) }),
    ...(source.executorInvocation === undefined ? {} : { executorInvocation: structuredClone(source.executorInvocation) }),
    ...(source.nativeTurnEnds === undefined ? {} : { nativeTurnEnds: nativeTurnEnds(source.nativeTurnEnds) }),
    ...(source.nativeInteractionEnds === undefined ? {} : { nativeInteractionEnds: nativeInteractionEnds(source.nativeInteractionEnds) }),
    ...(source.interactionOperations === undefined ? {} : { interactionOperations: Object.fromEntries(Object.entries(record(source.interactionOperations, 'interaction operations')).map(([id, receipt]) => {
      const normalized = normalizeInteractionOperationReceipt(receipt)
      if (id !== normalized.operationId || normalized.agentSessionId !== source.agentSessionId) throw new AgentMuxError('Interaction operation identity mismatch.', 'INVALID_AGENT_SESSION_STORE')
      return [id, normalized]
    })) }),
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

export async function loadAgentSessionMetadata(store: AgentMuxAgentSessionStore, signal?: AbortSignal): Promise<AgentMuxStoredAgentSession[]> {
  signal?.throwIfAborted()
  const values = await store.loadMetadata(signal)
  signal?.throwIfAborted()
  return normalizeAgentSessions(values)
}

export function agentLifecycleOperationIdentity(kind: 'create' | 'resume' | 'stop' | 'reopen' | 'restart', agentSessionId: string, requestedOperationId: string): string {
  return createHash('sha256').update(JSON.stringify(['agentmux-agent-lifecycle-v1', kind, agentSessionId, requestedOperationId])).digest('base64url')
}

function creationSessionId(sessions: readonly AgentMuxStoredAgentSession[], reservations: readonly AgentMuxLifecycleReservation[],
  retired: readonly AgentMuxRetiredAgentSession[], createOperationId: string): string | null {
  const ids = new Set(sessions.filter(session => session.creation?.createOperationId === createOperationId).map(session => session.agentSessionId))
  for (const session of retired) if (session.history?.creation?.createOperationId === createOperationId) ids.add(session.agentSessionId)
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
export async function loadSessionHistorySources(store: AgentMuxAgentSessionStore, options: AgentSessionHistorySourcesOptions = {}): Promise<AgentSessionHistoryDescriptor[]> {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['agentSessionId', 'signal'].includes(key)) ||
    options.agentSessionId !== undefined && (typeof options.agentSessionId !== 'string' || !options.agentSessionId || /[\0\r\n]/u.test(options.agentSessionId)) ||
    options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new AgentMuxError('Source observation requires an exact optional Session selector and AbortSignal.', 'INVALID_AGENT_SESSION_HISTORY_OPTIONS')
  const { signal, agentSessionId } = options
  signal?.throwIfAborted()
  return await observeRead((async () => {
    if (agentSessionId !== undefined) {
      const source = await store.readHistorySource(agentSessionId, signal)
      signal?.throwIfAborted()
      return source ? [source] : []
    }
    const [sessions, retired, correlations] = await Promise.all([loadAgentSessionMetadata(store, signal), store.loadRetiredAgentSessions(signal), store.loadReopenCorrelations(signal)])
    signal?.throwIfAborted()
    return sessionHistorySources(sessions, retired, correlations)
  })(), signal)
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
    ...retired.filter(session => !activeIds.has(session.agentSessionId)).map(session => session.recordDeletion ? {
      agentSessionId: session.agentSessionId, hostId: session.hostId, state: 'deleted' as const,
      retiredAt: session.observedAt, recordDeletion: structuredClone(session.recordDeletion)
    } : ({
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
  if (retiredSessions.some(session => session.agentSessionId === reservation.agentSessionId && session.recordDeletion)) deletedAgentSessionRecord(reservation.agentSessionId)
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
  if (reservation.kind === 'resume' && reservation.preparedSession &&
    ['hostId', 'providerId', 'executorId', 'workspacePath', 'toolExecution', 'nativeHandle', 'launchOptions'].some(key =>
      !isDeepStrictEqual(current[key as keyof AgentMuxStoredAgentSession], reservation.preparedSession![key as keyof AgentMuxStoredAgentSession]))) {
    throw new AgentMuxError('The original prepared resume target changed.', 'STALE_AGENT_SESSION')
  }
}

/**
 * The earlier Runs a reopened Session carries, before the Run it was closed on.
 *
 * A retirement keeps only its last Run, but the Session's own creation fact still names the
 * Run it was created on. Without that Run in its lineage the reopened Session fails the
 * creation-key invariant, so a Session resumed even once before closing could never reopen.
 */
export function reopenedPriorRuns(retirement: AgentMuxRetiredAgentSession): AgentMuxRunRef[] {
  const creation = retirement.history?.creation
  const named = [creation?.createdRun, creation?.initialInputKey?.expectedRun].filter((run): run is AgentMuxRunRef => Boolean(run))
  return [...new Set(named.map(run => run.runId))].filter(runId => runId !== retirement.run.runId).map(runId => ({ runId }))
}

/** A reopen rebinds the closed Run and every prior Run it restores to the reopened Session. */
function withoutReopenedRuns(retiredRuns: readonly AgentMuxRunRef[], retirement: AgentMuxRetiredAgentSession): AgentMuxRunRef[] {
  const rebound = new Set([retirement.run, ...reopenedPriorRuns(retirement)].map(run => run.runId))
  return retiredRuns.filter(run => !rebound.has(run.runId))
}

function assertPreparedReopen(retirement: AgentMuxRetiredAgentSession, session: AgentMuxStoredAgentSession): void {
  const history = retirement.history
  if (!history || session.agentSessionId !== retirement.agentSessionId || session.hostId !== retirement.hostId ||
    session.providerId !== history.providerId || session.executorId !== history.executorId ||
    session.workspacePath !== history.workspacePath || !isDeepStrictEqual(session.toolExecution, history.toolExecution) || session.createdAt !== history.createdAt ||
    JSON.stringify(session.nativeHandle) !== JSON.stringify(history.nativeHandle) || session.run.runId !== retirement.run.runId ||
    !isDeepStrictEqual(session.retiredRuns, reopenedPriorRuns(retirement)) || !session.hookBindingId || !session.hookToken || !session.capabilityHash) {
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
      session.nativeSourceObservation?.state === 'changed' && same(session.observedNativeHandle) ||
      session.nativeSourceObservation?.candidates?.some(same))) ||
      retired.some(session => session.hostId === seed.hostId && same(session.history?.nativeHandle)) ||
      reservations.some(reservation => reservation.agentSessionId !== seed.agentSessionId &&
        (reservation.kind === 'create' && reservation.preparedCreation?.hostId === seed.hostId && same(reservation.preparedCreation.nativeHandle) ||
         reservation.kind === 'reopen' && reservation.expectedRetirement.hostId === seed.hostId && same(reservation.expectedRetirement.history?.nativeHandle)))) {
    throw new AgentMuxError('This native conversation already has an original Core Session or prepared operation. Inspect that identity before continuing.', 'AGENT_NATIVE_SESSION_ALREADY_MANAGED')
  }
}

type ResumeReservation = Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>

/** One admission rotates the original callback owner; it does not infer any Native outcome. */
function admittedResumeResolution(current: AgentMuxLifecycleReservation | undefined, expected: ResumeReservation,
  session: AgentMuxStoredAgentSession | undefined, value: ResumeResolutionRequest,
  claim: AgentMuxLifecycleClaim & { reservationId: string }): { reservation: ResumeReservation; session: AgentMuxStoredAgentSession } {
  const request = parseResumeResolutionRequest(value), digest = resumeResolutionDigest(request)
  if (!current || current.kind !== 'resume' || current.operationId !== expected.operationId || !session ||
      current.agentSessionId !== request.agentSessionId || session.run.runId !== request.expectedRun.runId ||
      current.expectedRun.runId !== request.expectedRun.runId || !current.preparedDispatch || !current.preparedSession?.continuity || current.restart ||
      !matchesProviderNativeSessionTarget(current.preparedDispatch.nativeTarget, session.nativeHandle)) throw new AgentMuxError(
    'Resolution requires the exact original prepared resume and dispatch source. The Session and request were kept.', 'AGENT_RESUME_SOURCE_UNCONFIRMED')
  if (current.resolution) {
    if (current.resolution.receipt.operationId !== request.operationId || current.resolution.receipt.requestDigest !== digest) throw new AgentMuxError(
      'Another explicit resolution already owns this original Start. Read its safe receipt and retry that same operation.', 'AGENT_RESUME_RESOLUTION_CONFLICT')
    if (!current.ownerReleased && current.ownerId !== claim.ownerId && processIsAlive(current.ownerPid)) throw new AgentMuxError(
      'The original resolution owner is still executing. Its exact operation remains available for observation.', 'AGENT_SESSION_BUSY')
    const { ownerReleased, ...retained } = current
    return { reservation: { ...retained, ownerId: claim.ownerId, ownerPid: claim.ownerPid, expiresAt: claim.expiresAt }, session }
  }
  if (!sameReservationOwner(current, expected) || session.continuityOperations?.[request.operationId]) throw new AgentMuxError(
    'The original resume owner or new manual operation changed before admission.', 'AGENT_RESUME_RESOLUTION_CONFLICT')
  const receipt: AgentMuxResumeResolution = parseResumeResolution({ operationId: request.operationId,
    originalOperationId: current.preparedSession.continuity.operationId, originalCreationKey: current.operationId,
    runtimeId: current.preparedDispatch.runtime.runtimeId, requestDigest: digest, admittedAt: claim.now, outcome: 'pending' })
  const original = session.continuityOperations?.[receipt.originalOperationId] ?? current.preparedSession.continuity
  const continuity: AgentMuxContinuityOperation = { operationId: request.operationId, agentSessionId: request.agentSessionId,
    trigger: 'manual', policy: normalizeAgentContinuityPolicy({ activeRecovery: 'manual', reminderMode: 'off', continuationEnabled: false }),
    previousRun: { ...request.expectedRun }, nativeTarget: structuredClone(current.preparedDispatch.nativeTarget),
    admittedAt: claim.now, observedAt: claim.now, rechecks: 0, kind: 'pending', reason: 'operation-unconfirmed',
    evidence: { kind: 'run-unknown', observedAt: claim.now, message: 'Explicit resolution admitted for the original prepared Start.' },
    recoveryInputs: { reminder: '', continuation: '' }, resolution: receipt }
  const nextSession = normalizeStoredAgentSession({ ...session, continuity,
    continuityOperations: { ...session.continuityOperations, [receipt.originalOperationId]: { ...original, resolution: receipt }, [request.operationId]: continuity },
    updatedAt: Math.max(session.updatedAt + 1, claim.now) })
  const reservation = lifecycleReservation({ ...current, reservationId: claim.reservationId, ownerId: claim.ownerId,
    ownerPid: claim.ownerPid, expiresAt: claim.expiresAt, resolution: { request, receipt } }) as ResumeReservation
  return { reservation, session: nextSession }
}

function resumeResolutionFailure(current: AgentMuxLifecycleReservation | undefined, expected: ResumeReservation,
  canonical: AgentMuxStoredAgentSession | undefined, failure: { code: string; message: string }): AgentMuxStoredAgentSession {
  if (!canonical) throw new AgentMuxError('The original resolution Session is unavailable.', 'STALE_AGENT_SESSION')
  if (!current || current.kind !== 'resume' || !sameReservationOwner(current, expected) || !current.resolution ||
      !isDeepStrictEqual(current.resolution, expected.resolution) || canonical.run.runId !== expected.expectedRun.runId ||
      canonical.continuity?.operationId !== current.resolution.receipt.operationId || canonical.continuity.resolution?.outcome !== 'pending') return canonical
  const receipt = { ...canonical.continuity, kind: 'pending' as const, reason: 'operation-unconfirmed', observedAt: Date.now(), errorCode: failure.code, error: failure.message }
  return normalizeStoredAgentSession({ ...canonical, continuity: receipt,
    continuityOperations: { ...canonical.continuityOperations, [receipt.operationId]: receipt }, updatedAt: Math.max(canonical.updatedAt + 1, Date.now()) })
}

/** Exact Native fence and fully prepared successor become one durable Store fact. */
function handedOffResumeResolution(current: AgentMuxLifecycleReservation | undefined, expected: ResumeReservation,
  canonical: AgentMuxStoredAgentSession | undefined, successor: ResumeReservation, session: AgentMuxStoredAgentSession,
  dispatch: AgentMuxPreparedResumeDispatch, runtime: AgentMuxCreationRuntime): { reservation: ResumeReservation; session: AgentMuxStoredAgentSession } {
  const resolution = current?.kind === 'resume' ? current.resolution : undefined
  if (!current || current.kind !== 'resume' || !sameReservationOwner(current, expected) || !resolution ||
      !isDeepStrictEqual(current.resolution, expected.resolution) || !canonical || canonical.run.runId !== current.expectedRun.runId ||
      canonical.continuity?.operationId !== resolution.receipt.operationId ||
      parseCreationRuntime(runtime).runtimeId !== resolution.receipt.runtimeId || dispatch.runtime.runtimeId !== resolution.receipt.runtimeId ||
      successor.operationId !== agentLifecycleOperationIdentity('resume', current.agentSessionId, resolution.request.operationId) ||
      successor.agentSessionId !== current.agentSessionId || successor.expectedRun.runId !== current.expectedRun.runId ||
      successor.ownerId !== current.ownerId || successor.reservationId === current.reservationId || successor.restart || successor.resolution ||
      session.continuity?.operationId !== resolution.receipt.operationId || session.continuity.launchInput || session.continuity.recoveryDelivery ||
      session.continuity.recoveryInputs?.reminder !== '' || session.continuity.recoveryInputs?.continuation !== '') throw new AgentMuxError(
    'The exact resolution, Native fence or no-input successor changed before atomic handoff.', 'AGENT_RESUME_RESOLUTION_CONFLICT')
  const receipt = parseResumeResolution({ ...resolution.receipt, outcome: 'retired',
    continuedBy: { operationId: resolution.receipt.operationId, creationKey: successor.operationId } })
  const original = canonical.continuityOperations?.[receipt.originalOperationId]
  if (!original) throw new AgentMuxError('The original unknown Start receipt must be retained.', 'AGENT_RESUME_RESOLUTION_CONFLICT')
  const continuity = { ...session.continuity, resolution: receipt }
  const operations = { ...canonical.continuityOperations, [receipt.originalOperationId]: { ...original, resolution: receipt }, [receipt.operationId]: continuity }
  const prepared = normalizeStoredAgentSession({ ...session, continuity, continuityOperations: operations })
  const successorFacts=appendNativeCreationKeys(mergeNativeCreationKeys(canonical.nativeCreationKeys,current.nativeCreationKeys),[current.operationId,successor.operationId])
  const ownedSuccessor={...successor,nativeCreationKeys:successorFacts}
  const reservation = preparedResumeReservation(ownedSuccessor, ownedSuccessor, prepared, dispatch)
  const pending = { ...continuity, kind: 'pending' as const, reason: 'operation-unconfirmed' }
  const next = normalizeStoredAgentSession({ ...canonical, nativeCreationKeys:successorFacts, continuity: pending,
    continuityOperations: { ...operations, [receipt.operationId]: pending }, updatedAt: Math.max(canonical.updatedAt + 1, Date.now()) })
  return { reservation, session: next }
}

function claimedRestartReservation(current: AgentMuxLifecycleReservation | undefined, operationId: string,
  claim: AgentMuxLifecycleClaim): Extract<AgentMuxLifecycleReservation, { kind: 'resume' }> | null {
  if (!current) return null
  if (current.kind !== 'resume' || !current.restart || current.operationId !== operationId) throw new AgentMuxError('The exact restart lifecycle changed.', 'AGENT_RESTART_CONFLICT')
  if (!current.ownerReleased && current.ownerId !== claim.ownerId && processIsAlive(current.ownerPid)) throw new AgentMuxError('The original restart owner is still active.', 'AGENT_SESSION_BUSY')
  const { ownerReleased, ...retained } = current
  return { ...retained, ownerId: claim.ownerId, ownerPid: claim.ownerPid, expiresAt: claim.expiresAt }
}

function claimedCreateReservation(current: AgentMuxLifecycleReservation | undefined, operationId: string, intentDigest: string,
  claim: AgentMuxLifecycleClaim): Extract<AgentMuxLifecycleReservation, { kind: 'create' }> | null {
  if (!current) return null
  if (current.kind !== 'create' || current.operationId !== operationId || current.preparedCreation?.creation?.intentDigest !== intentDigest) throw new AgentMuxError('The original fork creation intent changed or is still preparing.', 'AGENT_FORK_OPERATION_CONFLICT')
  if (!current.ownerReleased && current.ownerId !== claim.ownerId && processIsAlive(current.ownerPid)) throw new AgentMuxError('The original creation owner is still active.', 'AGENT_SESSION_BUSY')
  const { ownerReleased, ...retained } = current
  return { ...retained, ownerId: claim.ownerId, ownerPid: claim.ownerPid, expiresAt: claim.expiresAt }
}

function assertSupervisedResumeClaim(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, sessions: readonly AgentMuxStoredAgentSession[]): void {
  const operation = reservation.preparedSession?.continuity
  const rootId = operation?.intentOperationId ?? (operation?.supervision ? operation.operationId : undefined)
  if (!rootId) return
  const current = sessions.find(session => session.agentSessionId === reservation.agentSessionId), root = current?.continuityOperations?.[rootId]
  if (!root?.supervision || !operation || root.supervision.activeAttemptOperationId !== operation.operationId ||
    ['cancelled', 'settled', 'paused'].includes(root.supervision.phase) || !matchesProviderNativeSessionTarget(root.nativeTarget, reservation.preparedSession!.nativeHandle) ||
    !matchesProviderNativeSessionTarget(root.nativeTarget, current?.nativeHandle) ||
    !matchesProviderNativeSessionTarget(reservation.preparedSession!.nativeHandle, current?.nativeHandle)) {
    throw new AgentMuxError('The original recovery intent no longer authorizes this unclaimed attempt.', 'AGENT_CONTINUITY_SUPERSEDED', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
  }
}

function restartStartNotAppliedReservation(current: AgentMuxLifecycleReservation | undefined,
  expected: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, failure: { code: string; message: string; observedAt: number }
): Extract<AgentMuxLifecycleReservation, { kind: 'resume' }> {
  if (!current || current.kind !== 'resume' || !current.restart || !current.preparedSession || !sameReservationOwner(current, expected) ||
    !sameSession(current.preparedSession, expected.preparedSession ?? null)) throw new AgentMuxError('The original restart Start owner changed before its not-applied receipt.', 'STALE_AGENT_SESSION')
  const { preparedSession, preparedDispatch, ...retained } = current
  return lifecycleReservation({ ...retained, restart: { ...current.restart, startNotApplied: failure } }) as Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>
}

type StopReservation = Extract<AgentMuxLifecycleReservation, { kind: 'stop' }>

/** Progress belongs to the same Stop owner and keeps the caller identity recorded at admission. */
function stopProgressReservation(current: AgentMuxLifecycleReservation | undefined, expected: StopReservation, value: AgentMuxAgentStopProgress): StopReservation {
  const progress = parseAgentStopProgress(value)
  if (!current || current.kind !== 'stop' || !sameReservationOwner(current, expected) || current.expectedRun.runId !== expected.expectedRun.runId) {
    throw new AgentMuxError('The original Stop owner changed before its progress was recorded.', 'STALE_AGENT_SESSION')
  }
  if (current.progress && current.progress.operationId !== progress.operationId) {
    throw new AgentMuxError('Stop progress belongs to another operation.', 'INVALID_AGENT_SESSION_STORE')
  }
  return lifecycleReservation({ ...current, progress }) as StopReservation
}

/** A Stop retires the Session's Runs and the one Run a taken-over resume left under its key. */
export function stopRetiredRuns(previous: AgentMuxStoredAgentSession, reservation: Extract<AgentMuxLifecycleReservation, { kind: 'stop' }>): AgentMuxRunRef[] {
  const retained = reservation.supersededResume?.retainedRun
  return [...previous.retiredRuns, previous.run, ...(retained ? [retained] : [])]
}

/** Only a Stop retirement carries a Stop record, and only the record of that same lifecycle operation. */
function stopRecordFor(reservation: AgentMuxLifecycleReservation, value: AgentMuxAgentStopRecord | undefined,
  expected: AgentMuxLifecycleReservation): AgentMuxAgentStopRecord | undefined {
  if (reservation.kind === 'stop' && (expected.kind !== 'stop' || !isDeepStrictEqual(reservation.supersededResume, expected.supersededResume)))
    throw new AgentMuxError('The original Stop takeover witness changed. Read its complete original record before continuing.', 'STALE_AGENT_SESSION')
  if (value === undefined) return undefined
  const record = parseAgentStopRecord(value)
  if (reservation.kind !== 'stop' || record.lifecycleOperationId !== reservation.operationId) {
    throw new AgentMuxError('The Stop record belongs to another lifecycle operation.', 'INVALID_AGENT_SESSION_STORE')
  }
  // The record reports the takeover the reservation admitted, adding only how its retained Run stopped.
  const { retainedStop: _stopped, ...reported } = record.supersededResume ?? {}
  if (!isDeepStrictEqual(record.supersededResume ? reported : undefined, reservation.supersededResume)) {
    throw new AgentMuxError('The Stop record names another taken-over resume.', 'INVALID_AGENT_SESSION_STORE')
  }
  return record
}

function preparedResumeReservation(current: AgentMuxLifecycleReservation | undefined,
  expected: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, session: AgentMuxStoredAgentSession, dispatch?: AgentMuxPreparedResumeDispatch): Extract<AgentMuxLifecycleReservation, { kind: 'resume' }> {
  if (!current || current.kind !== 'resume' || !sameReservationOwner(current, expected)) throw new AgentMuxError('Resume reservation changed before preparation.', 'STALE_AGENT_SESSION')
  if (current.preparedSession && (!sameSession(current.preparedSession, session) || !isDeepStrictEqual(current.preparedDispatch, dispatch))) throw new AgentMuxError('Original resume preparation is immutable.', 'STALE_AGENT_SESSION')
  const restart = current.restart ? { ...current.restart } : undefined
  if (restart) delete restart.startNotApplied
  return lifecycleReservation({ ...current, ...(restart ? { restart } : {}), preparedSession: session, ...(dispatch ? { preparedDispatch: dispatch } : {}) }) as Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>
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

/** The lifecycle owns its one operation; concurrent decisions retain their original records. */
function preserveContinuityOperations(previous: AgentMuxStoredAgentSession | undefined, next: AgentMuxStoredAgentSession, originalId?: string): AgentMuxStoredAgentSession {
  if (!previous?.continuityOperations || !next.continuity?.newRun || next.continuity.newRun.runId !== next.run.runId) return next
  const previousRoot = previous.continuityOperations[next.continuity.operationId]
  let continuity = previousRoot?.supervision ? { ...next.continuity, supervision: structuredClone(previousRoot.supervision) } : next.continuity
  if (previousRoot?.messageInput) {
    const { plan, ...original } = previousRoot.messageInput
    const { plan: candidatePlan, ...candidate } = continuity.messageInput ?? {}
    if (continuity.messageInput && (!isDeepStrictEqual(original, candidate) || plan && candidatePlan && !isDeepStrictEqual(plan, candidatePlan))) throw new AgentMuxError(
      'Resume commit changed its original message recipe.', 'INVALID_AGENT_SESSION_STORE')
    const retainedPlan = plan ?? candidatePlan
    continuity = { ...continuity, messageInput: { ...original, ...(retainedPlan ? { plan: retainedPlan } : {}) } }
  }
  return { ...next, continuity, continuityOperations: { ...next.continuityOperations, ...previous.continuityOperations,
    ...(originalId && next.continuityOperations?.[originalId] ? { [originalId]: next.continuityOperations[originalId] } : {}),
    [continuity.operationId]: continuity },
    ...(previous.continuityExecutors === undefined ? {} : { continuityExecutors: continuityExecutorEntries(previous.continuityExecutors) && continuityExecutorEntries(next.continuityExecutors)
      ? { ...continuityExecutorEntries(next.continuityExecutors), ...continuityExecutorEntries(previous.continuityExecutors) }
      : previous.continuityExecutors }) }
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
    const { nativeCreationKeys: _privateNativeKeys, run, retiredRuns, creation, terminalPromptReadiness, initialInput, ...actual } = next
    const { creation: intended, initialInput: preparedInput, ...prepared } = reservation.preparedCreation
    const { createdRun, initialInputKey, ...creationIntent } = creation!
    const { key: _key, receipt: _receipt, state: _state, ...boundInput } = initialInput ?? {}
    const { state: _preparedState, ...inputIntent } = preparedInput ?? {}
    if (Boolean(initialInput) !== Boolean(preparedInput) || initialInput &&
      (!isDeepStrictEqual(boundInput, inputIntent) || initialInput.lifecycleOperationId !== reservation.operationId ||
        !isDeepStrictEqual(initialInput.key, initialInputKey) || initialInput.key?.expectedRun.runId !== run.runId ||
        initialInput.state !== (initialInput.delivery === 'launch' ? 'launch-carried' : 'prepared'))) throw new AgentMuxError('Creation input changed its prepared body or binding.', 'INVALID_AGENT_SESSION_STORE')
    // Initial composer readiness belongs to the just-started exact Run. It cannot
    // exist in a no-Run preparation; normalizeAgentSession already checks its Run.
    if (terminalPromptReadiness && terminalPromptReadiness.source !== 'initial-composer') throw new AgentMuxError('A creation cannot import another composer readiness epoch.', 'INVALID_AGENT_SESSION_STORE')
    if (createdRun && createdRun.runId !== run.runId || !isDeepStrictEqual(actual, prepared) ||
      !isDeepStrictEqual(creationIntent, intended) || retiredRuns.length) throw new AgentMuxError('Creation commit changed its prepared identity or intent.', 'INVALID_AGENT_SESSION_STORE')
  }
  if (reservation.kind === 'reopen') {
    const retirement = reservation.expectedRetirement, history = retirement.history
    if (!history || next.hostId !== retirement.hostId || next.providerId !== history.providerId ||
      next.executorId !== history.executorId || next.workspacePath !== history.workspacePath || !isDeepStrictEqual(next.toolExecution, history.toolExecution) ||
      next.createdAt !== history.createdAt || JSON.stringify(next.nativeHandle) !== JSON.stringify(history.nativeHandle) ||
      JSON.stringify(next.reopenedFrom) !== JSON.stringify({ run: retirement.run, source: retirement.source, observedAt: retirement.observedAt }) ||
      next.run.runId === retirement.run.runId || !isDeepStrictEqual(next.retiredRuns, [...reopenedPriorRuns(retirement), retirement.run])) {
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
  if (reservation.kind === 'resume' && reservation.preparedSession) {
    const prepared = reservation.preparedSession, original = prepared.continuity, operation = reservation.resolution && original
      ? next.continuityOperations?.[original.operationId] : next.continuity
    if (reservation.resolution && (!next.continuity?.resolution || next.continuity.operationId !== reservation.resolution.receipt.operationId ||
        !isDeepStrictEqual(next.continuity.resolution, { ...reservation.resolution.receipt, outcome: 'retained', retainedRun: next.run }) ||
        !isDeepStrictEqual(operation?.resolution, next.continuity.resolution))) throw new AgentMuxError(
      'The retained Run must complete the exact admitted resolution and original request together.', 'AGENT_RESUME_RESOLUTION_CONFLICT')
    if (['hostId', 'providerId', 'executorId', 'workspacePath', 'toolExecution', 'nativeHandle', 'hookBindingId', 'hookToken', 'capabilityHash'].some(
      key => !isDeepStrictEqual(next[key as keyof AgentMuxStoredAgentSession], prepared[key as keyof AgentMuxStoredAgentSession])) ||
      original && (!operation || operation.operationId !== original.operationId || operation.requestDigest !== original.requestDigest || operation.action !== original.action ||
        !isDeepStrictEqual(operation.restartLaunch, original.restartLaunch) ||
        !isDeepStrictEqual(operation.messageInput, original.messageInput) ||
        !isDeepStrictEqual(operation.previousRun, original.previousRun) || !isDeepStrictEqual(operation.nativeTarget, original.nativeTarget) ||
        original.launchInput && ['input', 'prompt', 'message', 'digest', 'delivery', 'lifecycleOperationId', 'launchPlan'].some(
          key => !isDeepStrictEqual(operation.launchInput?.[key as keyof NonNullable<typeof operation.launchInput>], original.launchInput![key as keyof NonNullable<typeof original.launchInput>])))) {
      throw new AgentMuxError('Resume commit changed its original prepared identity or input.', 'INVALID_AGENT_SESSION_STORE')
    }
  }
  if (reservation.kind === 'create') return
  if (
    next.run.runId === reservation.expectedRun?.runId ||
    !next.retiredRuns.some((run) => run.runId === reservation.expectedRun?.runId)
  ) {
    throw new AgentMuxError('Resume lifecycle did not replace and retire the expected Run.', 'INVALID_AGENT_SESSION_STORE')
  }
}

function spawnRecord(phase: AgentMuxSpawnRecord['phase'], value: unknown): AgentMuxSpawnRecord | null {
  if (phase === 'retired') {
    const retired = retiredAgentSession(value), creation = retired.history?.creation
    return creation?.createdBy ? { agentSessionId: retired.agentSessionId, phase, currentRun: retired.run,
      createdAt: retired.history!.createdAt, creation: { ...creation, createdBy: creation.createdBy } } : null
  }
  if (phase === 'prepared') {
    const reservation = lifecycleReservation(value)
    if (reservation.kind !== 'create' || !reservation.preparedCreation?.creation?.createdBy) return null
    const seed = reservation.preparedCreation, creation = seed.creation!
    return { agentSessionId: seed.agentSessionId, phase, currentRun: null, createdAt: seed.createdAt,
      creation: { ...creation, createdBy: creation.createdBy! } }
  }
  const session = normalizeStoredAgentSession(value), creation = session.creation
  return creation?.createdBy ? { agentSessionId: session.agentSessionId, phase, currentRun: session.run,
    createdAt: session.createdAt, creation: { ...creation, createdBy: creation.createdBy } } : null
}

export function agentSessionHasCreationKey(session: Pick<AgentMuxStoredAgentSession, 'agentSessionId' | 'creation' | 'continuity' | 'continuityOperations' | 'nativeActor' | 'nativeCreationKeys'>, key: string): boolean {
  if(session.nativeActor?.lifecycleOperationId===key)return true
  if (session.creation && agentLifecycleOperationIdentity('create',session.agentSessionId,session.creation.createOperationId)===key) return true
  const applied=[session.continuity,...Object.values(session.continuityOperations??{})].some(value=>value && (
    value.launchInput?.lifecycleOperationId===key || value.resolution?.originalCreationKey===key || value.resolution?.continuedBy?.creationKey===key ||
    value.newRun && value.previousRun && value.newRun.runId!==value.previousRun.runId && agentLifecycleOperationIdentity(value.action==='restart'?'restart':'resume',session.agentSessionId,value.operationId)===key))
  return applied || session.nativeCreationKeys!==undefined&&roleNativeCreationKeys(session.nativeCreationKeys).keys.includes(key)
}

type MemoryCapturedHistory = { stream: AgentCapturedTimelinePage['stream'];
  heads: Map<string, Extract<AgentCapturedTimelinePage['records'][number], { item: AgentTimelineItem }>>;
  versions: AgentCapturedTimelinePage['records']; retirementAfterSequence?: number }

export class AgentMuxMemoryAgentSessionStore implements AgentMuxAgentSessionStore {
  private readonly sessionRunIds = new Set<string>()
  private retiredRunIds = new Set<string>()

  async hasAgentRun(value: AgentMuxRunRef): Promise<boolean> {
    const run = runRef(value)
    return this.sessionRunIds.has(run.runId) || this.retiredRunIds.has(run.runId)
  }
  async agentCreationKeyRole(key: string, agentSessionId?: string): Promise<'agent'|'unclaimed'|'unknown'> {
    let incomplete=false
    for(const r of this.reservations.values())if(!agentSessionId||r.agentSessionId===agentSessionId) {
      if(r.kind!=='stop'&&r.operationId===key||r.kind==='stop'&&r.supersededResume?.lifecycleOperationId===key)return 'agent'
      if(r.nativeCreationKeys!==undefined&&roleNativeCreationKeys(r.nativeCreationKeys).keys.includes(key))return 'agent'
      if(r.nativeCreationKeys?.coverage!=='complete')incomplete=true
    }
    for(const r of this.sessions.values())if(!agentSessionId||r.agentSessionId===agentSessionId) {
      const {nativeCreationKeys:privateKeys,...independent}=r
      if(agentSessionHasCreationKey(independent,key))return 'agent'
      if(privateKeys!==undefined&&roleNativeCreationKeys(privateKeys).keys.includes(key))return 'agent'
      if(r.nativeCreationKeys?.coverage!=='complete')incomplete=true
    }
    for(const r of this.retiredAgentSessions)if(!agentSessionId||r.agentSessionId===agentSessionId) {
      if(r.stop?.supersededResume?.lifecycleOperationId===key||r.history&&agentSessionHasCreationKey({...r.history,agentSessionId:r.agentSessionId},key))return 'agent'
      if(r.nativeCreationKeys!==undefined&&roleNativeCreationKeys(r.nativeCreationKeys).keys.includes(key))return 'agent'
      if(r.nativeCreationKeys?.coverage!=='complete')incomplete=true
    }
    if(incomplete)return 'unknown'
    if(!agentSessionId) {
      const coveredRetirements=new Set<string>()
      for(const retired of this.retiredAgentSessions) {
        coveredRetirements.add(retired.run.runId)
        for(const run of reopenedPriorRuns(retired))coveredRetirements.add(run.runId)
        if(retired.stop?.supersededResume?.retainedRun)coveredRetirements.add(retired.stop.supersededResume.retainedRun.runId)
      }
      if(this.retiredRuns.some(run=>!this.sessionRunIds.has(run.runId)&&!coveredRetirements.has(run.runId)))return 'unknown'
    }
    return 'unclaimed'
  }
  async agentSessionResourceCounts(hostId: string, signal?: AbortSignal): Promise<{ saved: number; retired: number }> {
    signal?.throwIfAborted()
    return { saved: [...this.sessions.values()].filter(s => s.hostId === hostId && s.creation?.persistence !== 'unconfirmed').length,
      retired: this.retiredAgentSessions.filter(s => s.hostId === hostId && !s.recordDeletion).length }
  }

  async runningSavedAgentCount(hostId: string, runningRunIds: readonly string[], signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted()
    const running = new Set(runningRunIds)
    return [...this.sessions.values()].filter(s => s.hostId === hostId && s.creation?.persistence !== 'unconfirmed' && running.has(s.run.runId)).length
  }
  private readonly spawnQueryOwner = mintObjectId()
  private readonly promptSubmissions = new Set<string>()
  private readonly sessions = new Map<string, AgentMuxStoredAgentSession>()
  private readonly promptAdmissions = new Map<string, Map<string, AgentPromptSubmissionRecord>>()
  private readonly reservations = new Map<string, AgentMuxLifecycleReservation>()
  private retiredRuns: AgentMuxRunRef[] = []
  private retiredAgentSessions: AgentMuxRetiredAgentSession[] = []
  private readonly inputConversationCuts = new Map<string, import('./agent-input-conversation.js').AgentInputJournalCut>()
  private readonly timelines = new Map<string, MemoryCapturedHistory>()

  private assertMemoryRecordReadable(id: string): void {
    if (this.sessions.has(id)) return
    if (this.retiredAgentSessions.find(value => value.agentSessionId === id)?.recordDeletion) deletedAgentSessionRecord(id)
  }

  private promptRecordKey(value: AgentPromptSubmissionRecord): string {
    return JSON.stringify([value.agentSessionId, value.run.runId, promptRecordId(value)])
  }
  private saveMemoryPromptAdmission(value: AgentPromptSubmissionRecord): void {
    let records = this.promptAdmissions.get(value.agentSessionId)
    if (!records) this.promptAdmissions.set(value.agentSessionId, records = new Map())
    records.set(this.promptRecordKey(value), value)
  }
  /** All metadata, complete and lifecycle writes pass here before moving/removing latest. */
  private setSession(id: string, next: AgentMuxStoredAgentSession | null): void {
    this.stageSession(id, next)()
  }

  private stageSession(id: string, next: AgentMuxStoredAgentSession | null): () => void {
    const originals = [...promptAdmissionRecords(this.sessions.get(id)), ...promptAdmissionRecords(next)]
    const writes = new Map<string, AgentPromptSubmissionRecord>()
    for (const value of originals) {
      const key = this.promptRecordKey(value)
      assertPromptRecordWrite(writes.get(key) ?? this.promptAdmissions.get(value.agentSessionId)?.get(key), value)
      writes.set(key, value)
    }
    return () => {
      for (const value of writes.values()) this.saveMemoryPromptAdmission(value)
      for (const run of sessionRuns(this.sessions.get(id) ?? null)) this.sessionRunIds.delete(run.runId)
      if (next) this.sessions.set(id, next)
      else this.sessions.delete(id)
      for (const run of sessionRuns(next)) this.sessionRunIds.add(run.runId)
    }
  }

  async readPromptAdmission(agentSessionId: string, run: AgentMuxRunRef, submissionId: string): Promise<AgentPromptSubmissionRecord | null> {
    this.assertMemoryRecordReadable(agentSessionId)

    const originals = ['submission', 'original-slot'].flatMap(kind => {
      const value = this.promptAdmissions.get(agentSessionId)?.get(JSON.stringify([agentSessionId, run.runId, JSON.stringify([kind, submissionId])]))
      return value ? [value] : []
    })
    if (originals.length > 1) throw new AgentMuxError('The original input location is ambiguous.', 'AGENT_PROMPT_OPERATION_CONFLICT')
    return structuredClone(originals[0] ?? null)
  }

  async settlePromptAdmission(expected: AgentPromptSubmissionRecord, next: AgentPromptSubmissionRecord, signal?: AbortSignal): Promise<void> {
    this.assertMemoryRecordReadable(expected.agentSessionId)

    signal?.throwIfAborted(); assertPromptRecordWrite(expected, next, true); assertPromptSettlement(expected, next)
    const key = this.promptRecordKey(expected), current = this.promptAdmissions.get(expected.agentSessionId)?.get(key)
    if (!isDeepStrictEqual(current, expected)) throw new AgentMuxError('The original Native receipt changed.', 'STALE_AGENT_SESSION')
    const latest = this.sessions.get(expected.agentSessionId), projected = promptAdmissionRecord(latest)
    this.saveMemoryPromptAdmission(structuredClone(next))
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

  async retainedExecutionDirectories(hostId: string): Promise<readonly string[]> {
    return retainedExecutionDirectories([...this.sessions.values()], this.retiredAgentSessions, [...this.reservations.values()], hostId)
  }

  async hostExecutorReferenced(hostId: string, executorId: string): Promise<boolean> {
    return retainedExecutorReference([...this.sessions.values()], this.retiredAgentSessions, [...this.reservations.values()], hostId, executorId)
  }

  async loadMetadata(signal?: AbortSignal): Promise<readonly AgentMuxStoredAgentSession[]> {
    signal?.throwIfAborted()
    return [...this.sessions.values()].map(session => structuredClone(agentSessionMetadata(session)))
  }
  async readMetadata(agentSessionId: string): Promise<AgentMuxStoredAgentSession | null> {
    const value = this.sessions.get(agentSessionId)
    return value ? structuredClone(agentSessionMetadata(value)) : null
  }
  async readExecutorInvocation(agentSessionId: string): Promise<unknown> {
    const active = this.sessions.get(agentSessionId)
    return structuredClone(active ? active.executorInvocation : this.retiredAgentSessions.find(session => session.agentSessionId === agentSessionId)?.executorInvocation)
  }
  async listSpawns(input: AgentMuxSpawnQuery): Promise<AgentMuxSpawnPage> {
    const query = parseAgentSpawnQuery(input)
    const rows = [
      ...[...this.sessions.values()].map(value => spawnRecord('active', value)),
      ...this.retiredAgentSessions.filter(value => !this.sessions.has(value.agentSessionId)).map(value => spawnRecord('retired', value)),
      ...[...this.reservations.values()].filter(value => !this.sessions.has(value.agentSessionId) &&
        !this.retiredAgentSessions.some(retired => retired.agentSessionId === value.agentSessionId)).map(value => spawnRecord('prepared', value))
    ].filter((value): value is AgentMuxSpawnRecord => value !== null)
    return structuredClone(agentSpawnPage(query, this.spawnQueryOwner, rows))
  }
  async readHistorySource(agentSessionId: string, signal?: AbortSignal): Promise<AgentSessionHistoryDescriptor | null> {
    signal?.throwIfAborted()
    const active = this.sessions.get(agentSessionId)
    const retired = active ? undefined : this.retiredAgentSessions.find(session => session.agentSessionId === agentSessionId)
    const reservation = this.reservations.get(agentSessionId)
    return sessionHistorySources(active ? [active] : [], retired ? [retired] : [],
      reservation ? reopenCorrelations([reservation]) : [])[0] ?? null
  }
  async readCapturedUsage(id: string, input: { cursor?: string; limit?: number }, signal?: AbortSignal): Promise<AgentSessionUsagePage['captured']> {
    this.assertMemoryRecordReadable(id)

    signal?.throwIfAborted()
    const timeline = this.timelines.get(id)
    if (!timeline) return { status: 'not-measured', reason: 'No existing captured stream has been observed. Native and other Core records are not measured.' }
    const window = sessionUsageWindow(id, timeline.stream.epoch, timeline.stream.sequence, input.cursor)
    const limit = input.limit ?? 100
    // Captured versions are append-only with sequence == array index + 1.
    const rows = timeline.versions.slice(window.afterSequence, Math.min(window.throughSequence, window.afterSequence + limit + 1))
      .map(record => ({ sequence: record.sequence, logicalBytes: record.item === null ? 0 : Buffer.byteLength(JSON.stringify(record.item)) }))
    return sessionUsageMeasurement(window, rows, limit)
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
    this.stageMetadataSwap(expected, next, signal, future, author)()
  }

  async compareAndSwapMetadataWithTimeline(expected: AgentMuxStoredAgentSession, next: AgentMuxStoredAgentSession,
    mutation: AgentTimelineMutation, signal?: AbortSignal): Promise<AgentMuxMetadataTimelineResult> {
    if (expected.agentSessionId !== next.agentSessionId || expected.run.runId !== next.run.runId || !isDeepStrictEqual(expected.nativeHandle, next.nativeHandle))
      throw new AgentMuxError('A Tool history write must retain its original Session, Run and native target.', 'INVALID_AGENT_SESSION_STORE')
    const writeMetadata = this.stageMetadataSwap(expected, next, signal)
    let history: ReturnType<AgentMuxMemoryAgentSessionStore['stageTimelineMutation']>
    try {
      const canonical = normalizeAgentTimelineMutation(mutation)
      if (canonical.agentSessionId !== next.agentSessionId) throw new AgentMuxError('History contribution names another Session.', 'INVALID_AGENT_TIMELINE_STORE')
      history = this.stageTimelineMutation(canonical)
    } catch (timelineFailure) {
      signal?.throwIfAborted()
      writeMetadata()
      return { timelineFailure }
    }
    signal?.throwIfAborted()
    writeMetadata()
    history.write()
    return { timeline: history.commit }
  }

  private stageMetadataSwap(expected: AgentMuxStoredAgentSession | null, next: AgentMuxStoredAgentSession | null,
    signal?: AbortSignal, future?: AgentMuxSessionFutureChange, author?: Readonly<AgentCapabilityBinding>): () => void {
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
    assertLifecycleReceiptFence(reservation, current, next)
    if (!next) return this.stageSession(id, null)
    const normalized = normalizeStoredAgentSession(ordinaryNativeCreationKeys(current,agentSessionMetadata(next)))
    assertInitialInputWrite(current, normalized)
    const values = [...this.sessions.values()].filter(session => session.agentSessionId !== id).map(agentSessionMetadata)
    const all = normalizeAgentSessions([...values, normalized])
    assertUnboundRetiredRuns(all, this.retiredRuns); assertRetiredAgentSessions(all, this.retiredRuns, this.retiredAgentSessions)
    for (const original of promptAdmissionRecords(normalized)) assertPromptRecordWrite(this.promptAdmissions.get(original.agentSessionId)?.get(this.promptRecordKey(original)), original)
    const intents = current?.futurePromptIntents ?? (future ? {} : undefined)
    let futureValue: AgentFuturePromptIntent | null = null
    if (future) {
      string(future.intentId, 'future intent id')
      futureValue = future.next === null ? null : normalizeStoredAgentSession({ ...normalized,
        futurePromptIntents: { [future.intentId]: future.next } }).futurePromptIntents![future.intentId]!
    }
    const write = this.stageSession(id, { ...normalized, ...(intents === undefined ? {} : { futurePromptIntents: intents }) })
    return () => {
      // The original map remains owned here; stage one entry rather than copying its history.
      if (future) {
        if (futureValue === null) delete intents![future.intentId]
        else intents![future.intentId] = futureValue
      }
      write()
    }
  }

  async loadRetiredRuns(): Promise<readonly AgentMuxRunRef[]> {
    return this.retiredRuns.map((run) => ({ ...run }))
  }

  async loadRetiredAgentSessions(signal?: AbortSignal): Promise<readonly AgentMuxRetiredAgentSession[]> {
    signal?.throwIfAborted()
    return structuredClone(this.retiredAgentSessions)
  }

  async readRetiredAgentSession(agentSessionId: string, signal?: AbortSignal): Promise<AgentMuxRetiredAgentSession | null> {
    string(agentSessionId, 'agentSessionId')
    signal?.throwIfAborted()
    const value = this.retiredAgentSessions.find(session => session.agentSessionId === agentSessionId)
    if (value && this.sessions.has(agentSessionId)) throw new AgentMuxError('Session is both active and retired.', 'INVALID_AGENT_SESSION_STORE')
    return value ? retiredAgentSession(value) : null
  }

  async readRecordDeletion(agentSessionId: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (this.sessions.has(agentSessionId)) return null
    const fact = this.retiredAgentSessions.find(value => value.agentSessionId === agentSessionId)?.recordDeletion
    return fact ? structuredClone(fact) : null
  }

  async deleteRecord(expected: AgentMuxRetiredAgentSession, operationId: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const index = this.retiredAgentSessions.findIndex(value => value.agentSessionId === expected.agentSessionId)
    const next = deletedRetirement(this.retiredAgentSessions[index] ?? null, retiredAgentSession(expected), operationId,
      this.sessions.has(expected.agentSessionId), this.reservations.has(expected.agentSessionId))
    const stored = structuredClone(next), receipt = structuredClone(next)
    signal?.throwIfAborted()
    const admitted = !this.retiredAgentSessions[index]?.recordDeletion
    this.retiredAgentSessions[index] = stored
    return { retirement: receipt, admitted }
  }

  async confirmRecordDeletion(expected: AgentMuxRetiredAgentSession, signal?: AbortSignal) {
    signal?.throwIfAborted()
    return confirmDeletedRetirement(this.retiredAgentSessions.find(value => value.agentSessionId === expected.agentSessionId), expected)
  }

  async cleanRecord(expected: AgentMuxRetiredAgentSession, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const index = this.retiredAgentSessions.findIndex(value => value.agentSessionId === expected.agentSessionId)
    const current = confirmDeletedRetirement(this.retiredAgentSessions[index], expected)
    const next = { ...current, recordDeletion: { ...current.recordDeletion!, phase: 'complete' as const } }
    const stored = structuredClone(next), receipt = structuredClone(next)
    const history = this.timelines.get(expected.agentSessionId)
    // Preserve the original stream and future-body retirement cut; terminal
    // record fences make it unreadable, while its payload maps no longer retain bodies.
    const retainedHistory = history ? structuredClone({ stream: history.stream, heads: new Map(), versions: [],
      ...(history.retirementAfterSequence === undefined ? {} : { retirementAfterSequence: history.retirementAfterSequence }) }) : undefined
    signal?.throwIfAborted()
    if (retainedHistory) this.timelines.set(expected.agentSessionId, retainedHistory)
    this.promptAdmissions.delete(expected.agentSessionId)
    this.inputConversationCuts.delete(expected.agentSessionId)
    this.retiredAgentSessions[index] = stored
    return receipt
  }

  async loadReopenCorrelations(signal?: AbortSignal) {
    signal?.throwIfAborted()
    return reopenCorrelations([...this.reservations.values()])
  }

  async loadCreationSessionId(createOperationId: string): Promise<string | null> {
    return creationSessionId([...this.sessions.values()], [...this.reservations.values()], this.retiredAgentSessions, createOperationId)
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
    assertLifecycleReceiptFence(reservation, current, next)
    if (next) {
      const normalized = normalizeStoredAgentSession(ordinaryNativeCreationKeys(current,next))
      const values = [...this.sessions.values()].filter((session) => session.agentSessionId !== agentSessionId)
      const sessions = normalizeAgentSessions([...values, normalized])
      assertUnboundRetiredRuns(sessions, this.retiredRuns)
      assertRetiredAgentSessions(sessions, this.retiredRuns, this.retiredAgentSessions)
      this.setSession(agentSessionId, structuredClone(normalized))
    } else {
      this.setSession(agentSessionId, null)
    }
  }

  async reserveLifecycle(value: AgentMuxLifecycleReservation): Promise<void> {
    const parsed=lifecycleReservation(value),reservation={...parsed,nativeCreationKeys:reservationNativeCreationKeys(parsed,this.sessions.get(parsed.agentSessionId),this.reservations.get(parsed.agentSessionId))}
    const current = this.reservations.get(reservation.agentSessionId)
    if (current && !canSupersedeRestartWithStop(current, reservation) && !canSupersedePreparedResumeWithStop(current, reservation)) {
      throw new AgentMuxError('Agent Session already has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
    }
    assertReservationPrecondition(
      reservation,
      [...this.sessions.values()],
      this.retiredAgentSessions
    )
    const session = this.sessions.get(reservation.agentSessionId)
    const nextSession = session ? restartAdmission(session, reservation, 'new') : undefined
    const savedReservation = structuredClone(reservation)
    const savedSession = nextSession && nextSession !== session ? structuredClone(nextSession) : undefined
    try {
      if (savedSession) this.setSession(reservation.agentSessionId, savedSession)
      this.reservations.set(reservation.agentSessionId, savedReservation)
    }
    catch (error) {
      if (reservation.kind !== 'create') throw error
      const failure = agentCreationNotAppliedError(error, reservation.operationId)
      await finishAgentCreationCleanup(failure, [async () => { await this.releaseLifecycle(reservation) }])
      throw failure
    }
  }

  async recordRestartAdmission(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, mode: 'continue' | 'restore' = 'continue'): Promise<AgentMuxStoredAgentSession> {
    const current = this.reservations.get(reservation.agentSessionId)
    if (!current || current.kind !== 'resume' || !sameReservationOwner(current, reservation) || current.operationId !== reservation.operationId || !current.restart || current.preparedSession || current.expectedRun.runId !== reservation.expectedRun.runId || !isDeepStrictEqual(current.restart, reservation.restart)) throw new AgentMuxError('The original restart reservation changed.', 'STALE_AGENT_SESSION')
    const session = this.sessions.get(reservation.agentSessionId)
    if (!session) throw new AgentMuxError('The original Session is unavailable.', 'STALE_AGENT_SESSION')
    const next = restartAdmission(session, current, mode)
    this.setSession(session.agentSessionId, structuredClone(next))
    return structuredClone(next)
  }

  async readContinuityControlReceipt(agentSessionId: string, operationId: string): Promise<ContinuityControlStoredResult | null> {
    return continuityControlStoredResult(this.sessions.get(agentSessionId) ?? null,
      this.retiredAgentSessions.find(session => session.agentSessionId === agentSessionId) ?? null, operationId)
  }

  async readLifecycleReservation(agentSessionId: string): Promise<AgentMuxLifecycleReservation | null> {
    const reservation = this.reservations.get(agentSessionId)
    return reservation ? structuredClone(reservation) : null
  }
  async loadResumeCorrelation(agentSessionId: string, operationId: string) {
    const reservation = this.reservations.get(agentSessionId)
    return reservation?.kind === 'resume' && reservation.operationId === operationId ? structuredClone(reservation) : null
  }
  async recordRestartStartNotApplied(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, failure: { code: string; message: string; observedAt: number }) {
    const next = restartStartNotAppliedReservation(this.reservations.get(reservation.agentSessionId), reservation, failure)
    this.reservations.set(next.agentSessionId, structuredClone(next))
    return structuredClone(next)
  }

  async prepareResume(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, session: AgentMuxStoredAgentSession, dispatch?: AgentMuxPreparedResumeDispatch) {
    const next = preparedResumeReservation(this.reservations.get(reservation.agentSessionId), reservation, session, dispatch)
    assertReservationPrecondition(next, [...this.sessions.values()], this.retiredAgentSessions)
    assertSupervisedResumeClaim(next, [...this.sessions.values()])
    this.reservations.set(next.agentSessionId, structuredClone(next))
    return structuredClone(next)
  }

  async admitResumeResolution(original: ResumeReservation, request: ResumeResolutionRequest, claim: AgentMuxLifecycleClaim & { reservationId: string }) {
    const next = admittedResumeResolution(this.reservations.get(original.agentSessionId), original, this.sessions.get(original.agentSessionId), request, claim)
    assertReservationPrecondition(next.reservation, [...this.sessions.values()], this.retiredAgentSessions)
    this.setSession(original.agentSessionId, structuredClone(next.session))
    this.reservations.set(original.agentSessionId, structuredClone(next.reservation))
    return structuredClone(next.reservation)
  }

  async releaseResumeResolutionOwner(original: ResumeReservation) {
    const current = this.reservations.get(original.agentSessionId)
    if (current?.kind === 'resume' && current.resolution && sameReservationOwner(current, original)) {
      this.reservations.set(original.agentSessionId, { ...current, ownerReleased: true })
    }
  }

  async recordResumeResolutionFailure(original: ResumeReservation, failure: { code: string; message: string }) {
    const next = resumeResolutionFailure(this.reservations.get(original.agentSessionId), original, this.sessions.get(original.agentSessionId), failure)
    this.setSession(original.agentSessionId, structuredClone(next))
    return structuredClone(next)
  }

  async handoffResumeResolution(original: ResumeReservation, successor: ResumeReservation, session: AgentMuxStoredAgentSession,
    dispatch: AgentMuxPreparedResumeDispatch, retirement: AgentMuxCreationRuntime) {
    const next = handedOffResumeResolution(this.reservations.get(original.agentSessionId), original, this.sessions.get(original.agentSessionId), successor, session, dispatch, retirement)
    assertReservationPrecondition(next.reservation, [...this.sessions.values()], this.retiredAgentSessions)
    this.setSession(original.agentSessionId, structuredClone(next.session))
    this.reservations.set(original.agentSessionId, structuredClone(next.reservation))
    return structuredClone(next.reservation)
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
      if ((reservation.kind === 'reopen' || reservation.kind === 'create' && reservation.preparedCreation || reservation.kind === 'resume' && (reservation.restart || reservation.resolution)) && reservation.ownerId === ownerId) this.reservations.set(id, { ...reservation, ownerReleased: true })
    }
  }

  async claimRestart(agentSessionId: string, operationId: string, claim: AgentMuxLifecycleClaim) {
    const next = claimedRestartReservation(this.reservations.get(agentSessionId), operationId, claim)
    if (next) this.reservations.set(agentSessionId, structuredClone(next))
    return next ? structuredClone(next) : null
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
        !((reservation.kind === 'reopen' || reservation.kind === 'create' || reservation.kind === 'resume') && reservation.ownerReleased) && reservation.ownerId !== claim.ownerId &&
        processIsAlive(reservation.ownerPid)
      ) continue
      const next = lifecycleReservation({
        ...reservation,
        ...(reservation.kind === 'resume' && reservation.resolution ? { ownerReleased: reservation.ownerReleased || !processIsAlive(reservation.ownerPid) ? true : undefined } :
          reservation.kind === 'reopen' || reservation.kind === 'create' || reservation.kind === 'resume' ? { ownerReleased: undefined } : {}),
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
    this.retiredRunIds = new Set(merged.map(run => run.runId))
    this.retiredAgentSessions = retainedSessions
    const owner=this.sessions.get(reservation.agentSessionId)
    if(owner)this.setSession(owner.agentSessionId,{...owner,nativeCreationKeys:mergeNativeCreationKeys(owner.nativeCreationKeys,current.nativeCreationKeys)})
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
    this.retiredRunIds = new Set(merged.map(run => run.runId))
    this.retiredAgentSessions = retainedSessions
  }

  async recordStopProgress(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'stop' }>, progress: AgentMuxAgentStopProgress): Promise<void> {
    const next = stopProgressReservation(this.reservations.get(reservation.agentSessionId), reservation, progress)
    this.reservations.set(next.agentSessionId, structuredClone(next))
  }

  async commitLifecycle(
    value: AgentMuxLifecycleReservation,
    next: AgentMuxStoredAgentSession | null,
    stop?: AgentMuxAgentStopRecord
  ): Promise<AgentMuxRetiredAgentSession | null> {
    const reservation = lifecycleReservation(value)
    const currentReservation = this.reservations.get(reservation.agentSessionId)
    if (!currentReservation || !sameReservationOwner(currentReservation, reservation)) {
      throw new AgentMuxError('Lifecycle reservation is no longer current.', 'STALE_AGENT_SESSION')
    }
    // The Store's own row is the admitted takeover; the caller's copy cannot add or drop one.
    const stopRecord = stopRecordFor(currentReservation, stop, reservation)
    assertReservationPrecondition(
      reservation,
      [...this.sessions.values()],
      this.retiredAgentSessions
    )
    const previous = this.sessions.get(reservation.agentSessionId)
    const normalized = next ? normalizeStoredAgentSession({...preserveContinuityOperations(previous, next, currentReservation.kind === 'resume' ? currentReservation.resolution?.receipt.originalOperationId : undefined),nativeCreationKeys:committedNativeCreationKeys(currentReservation,previous)}) : null
    assertLifecycleReceiptFence(currentReservation, previous ?? null, normalized, true)
    assertLifecycleCommit(currentReservation, normalized)
    const values = [...this.sessions.values()].filter(
      (session) => session.agentSessionId !== reservation.agentSessionId
    )
    if (normalized) values.push(normalized)
    const sessions = normalizeAgentSessions(values)
    const retiredRuns = currentReservation.kind === 'stop' && previous
      ? mergeRetiredRuns(this.retiredRuns, stopRetiredRuns(previous, currentReservation))
      : reservation.kind === 'reopen'
        ? withoutReopenedRuns(this.retiredRuns, reservation.expectedRetirement)
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
            nativeCreationKeys:committedNativeCreationKeys(currentReservation,previous),
            ...(previous.executorInvocation === undefined ? {} : { executorInvocation: structuredClone(previous.executorInvocation) }),
            continuityControlReceipts: continuityControlReceipts(previous),
            ...(previous.activityCommit ? { activityCommit: previous.activityCommit } : {}),
            ...(stopRecord ? { stop: stopRecord } : {})
          }])
        : this.retiredAgentSessions,
      retiredRuns
    )
    assertUnboundRetiredRuns(sessions, retiredRuns)
    assertRetiredAgentSessions(sessions, retiredRuns, retiredAgentSessions)
    if (normalized) {
      this.setSession(normalized.agentSessionId, structuredClone(normalized))
    } else {
      this.setSession(reservation.agentSessionId, null)
    }
    this.retiredRuns = retiredRuns
    this.retiredRunIds = new Set(retiredRuns.map(run => run.runId))
    this.retiredAgentSessions = retiredAgentSessions
    this.reservations.delete(reservation.agentSessionId)
    const retired = reservation.kind === 'stop' && previous
      ? retiredAgentSessions.find(session => session.agentSessionId === reservation.agentSessionId)
      : undefined
    return retired ? structuredClone(retired) : null
  }

  private memoryCaptured(id: string) {
    this.assertMemoryRecordReadable(id)

    let history = this.timelines.get(id);
    if (!history) {
      history = { stream: { epoch: mintObjectId(), sequence: 0, revision: 0, origin: 'beginning' as const, gaps: [] }, heads: new Map(), versions: [] };
      this.timelines.set(id, history);
    }
    return history;
  }

  async readInputConversationProjection(id: string, after = ''): Promise<ReturnType<typeof readCapturedInputProjection>> {
    const rows = [...this.memoryCaptured(id).heads.values()].filter(({ item }) => item.id > after && item.inputOrigin && item.inputRef && item.inputSubmission &&
      (item.inputSubmission.status === 'waiting' || item.inputSubmission.status === 'unknown' || item.inputSubmission.observation === 'owned'))
      .sort((a, b) => a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0).slice(0, 101)
    return structuredClone({ cut: this.inputConversationCuts.get(id) ?? null,
      pending: rows.slice(0, 100).map(({ item }) => ({ recordId: item.id, key: item.inputRef! })), next: rows.length > 100 ? rows[99]!.item.id : null })
  }
  async recordInputConversationProjection(id: string, cut: import('./agent-input-conversation.js').AgentInputJournalCut): Promise<void> {
    this.assertMemoryRecordReadable(id)

    const previous = this.inputConversationCuts.get(id)
    if (previous && (previous.queueId !== cut.queueId || previous.incarnation !== cut.incarnation)) throw new AgentMuxError('The original input projection journal changed.', 'AGENT_INPUT_READ_UNCONFIRMED')
    if (!previous || previous.sequence < cut.sequence) this.inputConversationCuts.set(id, structuredClone(cut))
  }

  async readCapturedHistory(id: string, input: AgentCapturedTimelineRead = {}): Promise<AgentCapturedTimelinePage> {
    if (!this.timelines.has(id) && !this.sessions.has(id) && !this.retiredAgentSessions.some(session => session.agentSessionId === id))
      throw new AgentMuxError(`Unknown Agent Session: ${id}`, "UNKNOWN_AGENT_SESSION");
    const history = this.memoryCaptured(id), stream = history.stream, cut = input.throughSequence ?? stream.sequence, limit = input.limit ?? 100;
    if (input.epoch !== undefined && input.epoch !== stream.epoch || !Number.isSafeInteger(cut) || cut < 0 || cut > stream.sequence || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
      [input.beforeFirstSequence, input.afterSequence].some(v => v !== undefined && (!Number.isSafeInteger(v) || v < 0)) || input.recordRevision !== undefined && !input.recordId)
      throw new AgentMuxError('Captured continuation does not identify this original stream/cut.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED');
    let rows: AgentCapturedTimelinePage['records'];
    if (input.afterSequence !== undefined)
      rows = history.versions.filter(r => r.sequence > input.afterSequence! && r.sequence <= cut);
    else if (input.recordId !== undefined && input.recordRevision !== undefined)
      rows = history.versions.filter(r => (r.item === null ? r.recordId : r.item.id) === input.recordId && r.revision === input.recordRevision && r.sequence <= cut).slice(-1);
    else {
      const atCut = new Map<string, AgentCapturedTimelinePage['records'][number]>();
      for (const row of history.versions)
        if (row.sequence <= cut)
          atCut.set(row.item === null ? row.recordId : row.item.id, row);
      rows = [...atCut.values()].filter(r => r.firstSequence < (input.beforeFirstSequence ?? Number.MAX_SAFE_INTEGER) && (input.recordId === undefined || (r.item === null ? r.recordId : r.item.id) === input.recordId)).sort((a, b) => b.firstSequence - a.firstSequence);
    }
    const more = rows.length > limit, records = rows.slice(0, limit);
    return structuredClone({ agentSessionId: id, stream: { ...stream, sequence: cut, revision: cut, gaps: [...stream.gaps, ...capturedBodyGaps(records)] }, records, nextBeforeFirstSequence: more && input.afterSequence === undefined ? records.at(-1)!.firstSequence : null, more });
  }

  async loadTimeline(agentSessionId: string): Promise<AgentTimelineSnapshot> {
    if (!this.timelines.has(agentSessionId) && !this.sessions.has(agentSessionId) && !this.retiredAgentSessions.some(session => session.agentSessionId === agentSessionId))
      return { agentSessionId, revision: 0, items: [] };
    const history = this.memoryCaptured(agentSessionId), all = [...history.heads.values()].sort((a, b) => a.firstSequence - b.firstSequence);
    const counts = [0, 0, 0], rows = all.reverse().filter(({ item }) => { const index = item.activityState ? 0 : item.kind === 'user_message' ? 1 : 2; counts[index] = counts[index]! + 1; return counts[index]! <= 200; }).reverse();
    return structuredClone({ agentSessionId, revision: history.stream.revision, items: rows.map(r => r.item), stream: { ...history.stream, positions: rows.map(({ item, ...r }) => ({ id: item.id, ...r })) } });
  }

  async applyTimelineMutation(mutation: AgentTimelineMutation, signal?: AbortSignal): Promise<AgentTimelineCommit> {
    signal?.throwIfAborted()
    const canonical = normalizeAgentTimelineMutation(mutation)
    this.assertMemoryRecordReadable(canonical.agentSessionId)
    if (!this.sessions.has(canonical.agentSessionId) && !acceptedRetiredActivity(this.retiredAgentSessions, canonical))
      throw new AgentMuxError(`Unknown Agent Session: ${canonical.agentSessionId}`, 'UNKNOWN_AGENT_SESSION')
    const staged = this.stageTimelineMutation(canonical)
    signal?.throwIfAborted()
    staged.write()
    return staged.commit
  }

  private stageTimelineMutation(mutation: AgentTimelineMutation): { commit: AgentTimelineCommit; write(): void } {
    const id = mutation.agentSessionId
    const history: MemoryCapturedHistory = this.timelines.get(id) ?? { stream: { epoch: mintObjectId(), sequence: 0, revision: 0,
      origin: 'beginning' as const, gaps: [] }, heads: new Map(), versions: [] }
    const recordId = mutation.type === 'update' ? mutation.itemId : mutation.item.id, previous = history.heads.get(recordId)
    const current = previous ? [previous.item] : [], next = applyNormalizedTimelineMutation(current, mutation), changed = next !== current
    const sequence = changed ? nextTimelineRevision(history.stream.sequence) : history.stream.sequence
    const revision = changed ? nextTimelineRevision(history.stream.revision) : history.stream.revision
    const head = changed ? { item: next[0]!, firstSequence: previous?.firstSequence ?? sequence,
      sequence, revision: conversationRevision(next[0]!) } : previous!
    const retirementAfter = history.retirementAfterSequence === undefined ? history.stream.sequence : history.retirementAfterSequence
    if (changed && (!Number.isSafeInteger(retirementAfter) || retirementAfter < 0 || retirementAfter > history.stream.sequence))
      throw new AgentMuxError('The original captured retirement cut is unconfirmed. Retain its records.', 'AGENT_SESSION_HISTORY_CAPTURE_UNCONFIRMED')
    const retired = changed && previous && previous.sequence > retirementAfter
      ? { item: null, recordId, firstSequence: previous.firstSequence, sequence: previous.sequence, revision: previous.revision } as const : undefined
    const commit = structuredClone({ agentSessionId: id, revision, changed, mutation,
      stream: { ...history.stream, sequence, revision }, position: { id: recordId,
        firstSequence: head.firstSequence, sequence: head.sequence, revision: head.revision } })
    return { commit, write: () => {
      if (changed) {
        history.retirementAfterSequence ??= retirementAfter
        if (retired) history.versions[retired.sequence - 1] = retired
        history.versions.push(head)
        history.heads.set(recordId, head)
        history.stream.sequence = sequence
        history.stream.revision = revision
      }
      this.timelines.set(id, history)
    } }
  }

}

type AgentSessionStoreDocument = {
  version: 5
  sessions: AgentMuxStoredAgentSession[]
  reservations: AgentMuxLifecycleReservation[]
  retiredRuns: AgentMuxRunRef[]
  retiredAgentSessions: AgentMuxRetiredAgentSession[]
}

/** SQLITE_BUSY: another connection holds the lock this step needs; nothing was applied. */
function sqliteBusy(error: unknown): boolean {
  return (error as { errcode?: unknown } | null)?.errcode === 5
}

/**
 * Repeat one side-effect-free read step while another connection holds the lock it needs. A
 * rollback-journal writer refuses new readers while it commits, from the first validation PRAGMA;
 * the writer's COMMIT already waits out readers, and a read waits out the writer on the same
 * budget. Only pure reads go through here: a write keeps its own single retry budget.
 */
async function whileBusy<T>(step: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted()
    try { return await step() } catch (error) {
      // A failed cleanup leaves the original connection unconfirmed; opening another reader
      // cannot confirm that release or make its failure disappear.
      if (!sqliteBusy(error) || (error as { cleanup?: unknown[] } | null)?.cleanup?.length || attempt >= LOCK_ATTEMPTS) throw error
      await delay(LOCK_RETRY_MIN_MS + Math.random() * LOCK_RETRY_JITTER_MS, signal)
    }
  }
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

function sessionStorageFailure(error: unknown, stage: string, cleanup: unknown[] = [], preserveError = false): Error {
  // Keep business and durability receipts intact: their identity controls Run retention.
  const failure = error instanceof AgentMuxError || error instanceof Error && (preserveError || error.name === 'AbortError')
    ? error : new AgentMuxError('Session persistence is unavailable. Keep its original binding and retry the same operation.',
      'AGENT_SESSION_STORE_UNAVAILABLE', JSON.stringify({ stage, cause: error instanceof Error
        ? { name: error.name, message: error.message, ...('code' in error ? { code: error.code } : {}), ...('errcode' in error ? { errcode: error.errcode } : {}) }
        : String(error) }))
  if (failure !== error) Object.defineProperty(failure, 'cause', { value: error, configurable: true })
  if (cleanup.length) {
    const previous = (failure as { cleanup?: readonly unknown[] }).cleanup ?? []
    Object.defineProperty(failure, 'cleanup', { value: [...previous, ...cleanup], configurable: true })
  }
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

/** Optional history context cannot replace the required metadata operation's Error. */
function retainTimelineFailure(error: unknown, timelineFailure: unknown): unknown {
  if (error !== timelineFailure && error instanceof Error && Object.isExtensible(error))
    Object.defineProperty(error, 'timelineFailure', { value: timelineFailure, configurable: true })
  return error
}

/** Facts from this original writer only; never inferred by callers from an Error. */
type MetadataTimelineSettlement = { rolledBackCleanly: boolean; releaseFailure?: unknown }

/** Scope marker for a write that may change rows of any Session. */
const CROSS_SESSION_WRITE = Symbol('cross-session-write')

/** Capture identity-bearing refs without copying cumulative input/recovery bodies. */
function captureSessionRuns(value: AgentMuxStoredAgentSession | null): AgentMuxStoredAgentSession | null {
  return value ? { ...value, run: runRef(value.run), retiredRuns: value.retiredRuns.map(runRef) } : null
}
function sessionRuns(...values: Array<AgentMuxStoredAgentSession | null>): AgentMuxRunRef[] {
  return values.flatMap(value => value ? [value.run, ...value.retiredRuns] : [])
}

export class AgentMuxFileAgentSessionStore implements AgentMuxAgentSessionStore {
  /** Pending original writes only, never ownership or receipt facts. */
  private readonly runBindingWrites = new Map<string, Set<Promise<unknown>>>()

  private withRunBindingWrites<T>(runs: readonly AgentMuxRunRef[], write: () => Promise<T>): Promise<T> {
    const ids = new Set(runs.map(run => runRef(run).runId)), pending = write()
    for (const id of ids) {
      const writes = this.runBindingWrites.get(id) ?? new Set<Promise<unknown>>()
      writes.add(pending); this.runBindingWrites.set(id, writes)
    }
    const release = () => { for (const id of ids) {
      const writes = this.runBindingWrites.get(id)
      writes?.delete(pending)
      if (!writes?.size) this.runBindingWrites.delete(id)
    } }
    void pending.then(release, release)
    return pending
  }

  async hasAgentRun(value: AgentMuxRunRef): Promise<boolean> {
    const id = runRef(value).runId
    // An admitted binding is not absent because its SQL write is still queued.
    await Promise.all(this.runBindingWrites.get(id) ?? [])
    return await this.withReadDatabase(db => !!db.prepare('SELECT 1 FROM run_bindings WHERE run_id=?').get(id), () => {
      throw new AgentMuxError('Original Run ownership is unconfirmed. Keep the Run and inspect its original Store.', 'AGENT_SESSION_STORE_READ_UNCONFIRMED')
    }, undefined, this.database ? false : 'observation')
  }
  async agentCreationKeyRole(key: string, agentSessionId?: string): Promise<'agent'|'unclaimed'|'unknown'> {
    // Called before enqueueing a new adoption, never from within this writer queue.
    try {await this.tail
    return await this.withReadDatabase(db=>{
      if(db.prepare("SELECT 1 FROM retired_sessions WHERE json_extract(json,'$.stop.supersededResume.lifecycleOperationId')=? AND (? IS NULL OR id=?) LIMIT 1").get(key,agentSessionId??null,agentSessionId??null))return 'agent'
      if(db.prepare("SELECT 1 FROM reservations WHERE ((json_extract(json,'$.kind')<>'stop' AND json_extract(json,'$.operationId')=?) OR json_extract(json,'$.supersededResume.lifecycleOperationId')=?) AND (? IS NULL OR id=?) LIMIT 1").get(key,key,agentSessionId??null,agentSessionId??null)) return 'agent'
      for(const [table,prefix] of [['sessions','$'],['retired_sessions','$.history']] as const) {
        if(table==='sessions'&&db.prepare(`SELECT 1 FROM ${table} WHERE json_extract(json,'${prefix}.nativeActor.lifecycleOperationId')=? AND (? IS NULL OR id=?) LIMIT 1`).get(key,agentSessionId??null,agentSessionId??null))return 'agent'
        for(const row of db.prepare(`SELECT id,json_extract(json,'${prefix}.creation.createOperationId') AS op FROM ${table} WHERE (? IS NULL OR id=?)`).iterate(agentSessionId??null,agentSessionId??null)) {
          if(typeof row.op==='string' && agentLifecycleOperationIdentity('create',String(row.id),row.op)===key) return 'agent'
        }
        if(table!=='sessions')continue // Public history has no continuity/native-actor contract.
        const paths=['operationId','action','launchInput.lifecycleOperationId','resolution.originalCreationKey','resolution.continuedBy.creationKey','newRun.runId','previousRun.runId']
        const names=['op','action','native_key','original_key','successor_key','new_run','previous_run']
        const selected=(source:string,path:string)=>paths.map((field,index)=>`json_extract(${source},'${path}.${field}') AS ${names[index]}`).join(',')
        const query=`SELECT s.id,${selected('value','$')} FROM sessions s,json_each(s.json,'$.continuityOperations') WHERE (? IS NULL OR s.id=?) UNION ALL SELECT id,${selected('json','$.continuity')} FROM sessions WHERE (? IS NULL OR id=?)`
        for(const row of db.prepare(query).iterate(agentSessionId??null,agentSessionId??null,agentSessionId??null,agentSessionId??null)) if(row.native_key===key || row.original_key===key || row.successor_key===key || typeof row.new_run==='string' && typeof row.previous_run==='string' && row.new_run!==row.previous_run && typeof row.op==='string' &&
          agentLifecycleOperationIdentity(row.action==='restart'?'restart':'resume',String(row.id),row.op)===key) return 'agent'
      }
      let incomplete=false
      for(const table of ['sessions','retired_sessions','reservations']) for(const row of db.prepare(`SELECT json_type(json,'$.nativeCreationKeys') AS fact_type,json_extract(json,'$.nativeCreationKeys') AS facts FROM ${table} WHERE (? IS NULL OR id=?)`).iterate(agentSessionId??null,agentSessionId??null)) {
        if(row.fact_type===null){incomplete=true;continue}
        let fact:unknown;try{fact=JSON.parse(String(row.facts))}catch{throw new AgentMuxError('Original private Agent key facts cannot be read.','AGENT_CREATION_ROLE_UNCONFIRMED')}
        const validated=roleNativeCreationKeys(fact)
        if(validated.keys.includes(key))return 'agent'
        if(validated.coverage!=='complete')incomplete=true
      }
      if(incomplete)return 'unknown'
      if(!agentSessionId && db.prepare(`SELECT id FROM retired_runs
        EXCEPT SELECT json_extract(json,'$.run.runId') FROM sessions
        EXCEPT SELECT json_extract(value,'$.runId') FROM sessions,json_each(sessions.json,'$.retiredRuns')
        EXCEPT SELECT json_extract(json,'$.run.runId') FROM retired_sessions
        EXCEPT SELECT json_extract(json,'$.history.creation.createdRun.runId') FROM retired_sessions
        EXCEPT SELECT json_extract(json,'$.history.creation.initialInputKey.expectedRun.runId') FROM retired_sessions
        EXCEPT SELECT json_extract(json,'$.stop.supersededResume.retainedRun.runId') FROM retired_sessions LIMIT 1`).get())return 'unknown'
      return 'unclaimed'
    },()=>{throw new AgentMuxError('Original Agent creation-key ownership is unconfirmed.','AGENT_SESSION_STORE_READ_UNCONFIRMED')},undefined,this.database?false:'observation')
    } catch(error) {
      if(error instanceof AgentMuxError && error.code==='AGENT_CREATION_ROLE_UNCONFIRMED')throw error
      const failure=new AgentMuxError('Original Agent creation-key facts could not be observed. Existing Agents and Runs are retained.','AGENT_CREATION_ROLE_UNCONFIRMED')
      Object.defineProperty(failure,'cause',{value:error});throw failure
    }
  }
  async agentSessionResourceCounts(hostId: string, signal?: AbortSignal): Promise<{ saved: number; retired: number }> {
    return await this.withReadDatabase(db => ({
      saved: Number(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(json,'$.hostId')=? AND COALESCE(json_extract(json,'$.creation.persistence'),'')<>'unconfirmed'").get(hostId)!.n),
      retired: Number(db.prepare("SELECT COUNT(*) AS n FROM retired_sessions WHERE json_extract(json,'$.hostId')=? AND json_extract(json,'$.recordDeletion') IS NULL").get(hostId)!.n)
    }), () => { throw new AgentMuxError('Original Agent record counts are unavailable.', 'AGENT_RESOURCE_UNAVAILABLE') }, signal, 'observation')
  }

  async runningSavedAgentCount(hostId: string, runningRunIds: readonly string[], signal?: AbortSignal): Promise<number> {
    return await this.withReadDatabase(db => {
      const current = db.prepare("SELECT 1 FROM run_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.run_id=? AND json_extract(s.json,'$.run.runId')=b.run_id AND json_extract(s.json,'$.hostId')=? AND COALESCE(json_extract(s.json,'$.creation.persistence'),'')<>'unconfirmed'")
      let count = 0
      for (const id of new Set(runningRunIds)) { signal?.throwIfAborted(); if (current.get(id, hostId)) count += 1 }
      return count
    }, () => { throw new AgentMuxError('Original running Agent count is unavailable.', 'AGENT_RESOURCE_UNAVAILABLE') }, signal, 'observation')
  }
  private tail: Promise<void> = Promise.resolve()
  // Exact reads join preceding writes to their own Session, using the original
  // writer's settlement Promise. This index holds no metadata or receipt facts.
  private readonly sessionWriteTails = new Map<string, Promise<void>>()
  // The latest write that may change any Session's rows (whole-document lifecycle
  // reconciliation). An exact read joins it too, so it never misses such a write.
  private crossSessionWriteTail: Promise<void> = Promise.resolve()
  /** Preceding writes that can change this Session's rows: its own and any cross-Session one. */
  private async sessionWrites(agentSessionId: string, signal?: AbortSignal): Promise<void> {
    await observeRead(Promise.all([this.sessionWriteTails.get(agentSessionId), this.crossSessionWriteTail]), signal)
  }
  private readonly timelineTails = new Map<string, Promise<void>>()
  private readonly capturedPreparations = new Map<string, Promise<AgentCapturedTimelinePage['stream']['gaps']>>()
  private pendingLockRelease: (() => Promise<void>) | null = null
  /** 已报过的抢救事件（键是隔离文件的内容寻址路径），防同一份坏字节在一次加载里刷多条告警。 */
  private readonly reportedSalvages = new Set<string>()

  private database: DatabaseSync | undefined
  private dirty = false

  private assertRecordReadable(db: DatabaseSync, id: string): void {
    const fact = db.prepare("SELECT json_extract(json,'$.recordDeletion') AS fact FROM retired_sessions WHERE id=?").get(id)?.fact
    if (fact != null) { parseAgentSessionRecordDeletion(JSON.parse(String(fact))); deletedAgentSessionRecord(id) }
  }

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
    }, undefined, agentSessionId)
  }

  async load(): Promise<readonly unknown[]> {
    await this.tail
    const result = await this.withReadDatabase(db => db.prepare('SELECT id FROM sessions ORDER BY rowid').all()
      .map(row => this.completeSession(db, String(row.id))!), document => document.sessions)
    return result
  }

  async retainedExecutionDirectories(hostId: string): Promise<readonly string[]> {
    await this.tail
    // DISTINCT path projection stays in this Store; no Session/Run/input hydration.
    return await this.withReadDatabase(db => db.prepare(`SELECT DISTINCT cwd FROM (
      SELECT json_extract(json,'$.workspacePath') AS cwd FROM sessions WHERE json_extract(json,'$.hostId')=?
      UNION ALL SELECT json_extract(json,'$.history.workspacePath') FROM retired_sessions
        WHERE json_extract(json,'$.hostId')=? AND COALESCE(json_extract(json,'$.recordDeletion.phase'),'')!='complete'
      UNION ALL SELECT json_extract(json,'$.preparedCreation.workspacePath') FROM reservations WHERE json_extract(json,'$.preparedCreation.hostId')=?
      UNION ALL SELECT json_extract(json,'$.preparedSession.workspacePath') FROM reservations WHERE json_extract(json,'$.preparedSession.hostId')=?
      UNION ALL SELECT json_extract(json,'$.expectedRetirement.history.workspacePath') FROM reservations WHERE json_extract(json,'$.expectedRetirement.hostId')=?
    ) WHERE cwd IS NOT NULL`).all(hostId, hostId, hostId, hostId, hostId).map(row => {
      if (typeof row.cwd !== 'string' || !row.cwd.length || row.cwd.includes('\0')) throw new AgentMuxError('An original execution directory reference is unreadable.', 'EXECUTION_DIRECTORY_REFERENCES_UNCONFIRMED')
      return row.cwd
    }), document => retainedExecutionDirectories(document.sessions, document.retiredAgentSessions, document.reservations, hostId), undefined, true)
  }

  async hostExecutorReferenced(hostId: string, executorId: string): Promise<boolean> {
    await this.tail
    // Query only matching metadata; never hydrate history/inputs or touch Runtime.
    return await this.withReadDatabase(db => {
      const dependency = "(json_extract(json,'$.creation.executorRevision') IS NOT NULL OR json_extract(json,'$.creation.executorInvocationDigest') IS NULL)"
      if (db.prepare("SELECT 1 FROM sessions WHERE json_extract(json,'$.hostId')=? AND json_extract(json,'$.executorId')=? AND " + dependency + ' LIMIT 1').get(hostId, executorId)) return true
      if (db.prepare("SELECT 1 FROM retired_sessions WHERE json_extract(json,'$.hostId')=? AND json_extract(json,'$.recordDeletion') IS NULL AND json_extract(json,'$.history.executorId')=? AND (json_extract(json,'$.history.creation.executorRevision') IS NOT NULL OR json_extract(json,'$.history.creation.executorInvocationDigest') IS NULL) LIMIT 1").get(hostId, executorId)) return true
      return !!db.prepare("SELECT 1 FROM reservations WHERE json_extract(json,'$.kind')='create' AND json_extract(json,'$.preparedCreation.hostId')=? AND json_extract(json,'$.preparedCreation.executorId')=? AND (json_extract(json,'$.preparedCreation.creation.executorRevision') IS NOT NULL OR json_extract(json,'$.preparedCreation.creation.executorInvocationDigest') IS NULL) LIMIT 1").get(hostId, executorId)
    }, document => retainedExecutorReference(document.sessions, document.retiredAgentSessions, document.reservations, hostId, executorId), undefined, true)
  }

  async loadMetadata(signal?: AbortSignal): Promise<readonly AgentMuxStoredAgentSession[]> {
    await observeRead(this.tail, signal)
    return await this.withReadDatabase(db => this.sessionCatalog(db), document => document.sessions.map(agentSessionMetadata), signal)
  }

  async readMetadata(agentSessionId: string): Promise<AgentMuxStoredAgentSession | null> {
    await this.sessionWriteTails.get(agentSessionId)
    return await this.withReadDatabase(db => this.sessionMetadata(db, agentSessionId),
      document => {
        const value = document.sessions.find(session => session.agentSessionId === agentSessionId)
        return value ? agentSessionMetadata(value) : null
      }, undefined, true)
  }

  async readExecutorInvocation(agentSessionId: string): Promise<unknown> {
    await this.sessionWriteTails.get(agentSessionId)
    return await this.withReadDatabase(db => {
      const row = db.prepare("SELECT json -> '$.executorInvocation' AS value FROM sessions WHERE id=?").get(agentSessionId)
        ?? db.prepare("SELECT json -> '$.executorInvocation' AS value FROM retired_sessions WHERE id=?").get(agentSessionId)
      return row?.value == null ? undefined : JSON.parse(String(row.value))
    }, document => {
      const active = document.sessions.find(session => session.agentSessionId === agentSessionId)
      return structuredClone(active ? active.executorInvocation : document.retiredAgentSessions.find(session => session.agentSessionId === agentSessionId)?.executorInvocation)
    }, undefined, true)
  }
  async listSpawns(input: AgentMuxSpawnQuery): Promise<AgentMuxSpawnPage> {
    const query = parseAgentSpawnQuery(input)
    await this.tail
    const available = () => { throw new AgentMuxError('The original indexed Session owner is unconfirmed; creation records remain retained.', 'AGENT_SESSION_STORE_READ_UNCONFIRMED') }
    if (query.direction === 'created' && !await this.withReadDatabase(db =>
      Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='spawn_creator_reservations'").get()), available)) {
      // Rebuildable indexes use the same original writer/lock. No business fact is
      // copied and index failure never becomes a lifecycle or input precondition.
      await this.enqueue(async () => { this.db.exec(agentSpawnIndexes); this.dirty = true })
    }
    return await this.withReadDatabase(db => {
      const result = readAgentSpawnRows(db, query)
      const records = result.rows.map(row => spawnRecord(row.phase, row.value)).filter((value): value is AgentMuxSpawnRecord => value !== null)
      return agentSpawnPage(query, result.owner, records)
    }, available)
  }

  private promptAdmission(db: DatabaseSync, agentSessionId: string, run: AgentMuxRunRef, submissionId: string): AgentPromptSubmissionRecord | null {
    this.assertRecordReadable(db, agentSessionId)

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
    await this.sessionWriteTails.get(agentSessionId)
    return await this.withReadDatabase(db => this.promptAdmission(db, agentSessionId, run, submissionId), document => {
      return promptAdmissionRecords(document.sessions.find(s => s.agentSessionId === agentSessionId)).find(original => original.run.runId === run.runId &&
        [JSON.stringify(['submission', submissionId]), JSON.stringify(['original-slot', submissionId])].includes(promptRecordId(original))) ?? null
    }, undefined, true)
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
    }, signal, expected.agentSessionId)
  }

  async readHistorySource(agentSessionId: string, signal?: AbortSignal): Promise<AgentSessionHistoryDescriptor | null> {
    await this.sessionWrites(agentSessionId, signal)
    return await this.withReadDatabase(db => {
      const activeRow = db.prepare(activeHistorySourceSql).get(agentSessionId)
      if (activeRow) return activeSessionHistorySource(JSON.parse(String(activeRow.json)), agentSessionId)
      const row = db.prepare('SELECT json FROM retired_sessions WHERE id=?').get(agentSessionId)
      if (!row) return null
      const retired = retiredAgentSession(JSON.parse(String(row.json)))
      const pending = db.prepare('SELECT json FROM reservations WHERE id=?').get(agentSessionId)
      return sessionHistorySources([], [retired], pending ? reopenCorrelations([lifecycleReservation(JSON.parse(String(pending.json)))]) : [])[0]!
    }, document => sessionHistorySources(
      document.sessions.filter(session => session.agentSessionId === agentSessionId),
      document.retiredAgentSessions.filter(session => session.agentSessionId === agentSessionId),
      reopenCorrelations(document.reservations.filter(reservation => reservation.agentSessionId === agentSessionId))
    )[0] ?? null, signal, true)
  }

  async readCapturedUsage(id: string, input: { cursor?: string; limit?: number }, signal?: AbortSignal): Promise<AgentSessionUsagePage['captured']> {
    await this.sessionWrites(id, signal)
    return await this.withReadDatabase(db => {
      this.assertRecordReadable(db, id)

      // Inspect existing committed storage only. Do not prepare/import a captured stream.
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='captured_streams'").get())
        return { status: 'not-measured', reason: 'The existing captured store is unavailable; no history has been imported for this inspection.' }
      const stream = capturedStream(db, id)
      if (!stream) return { status: 'not-measured', reason: 'No existing captured stream has been observed. Native and other Core records are not measured.' }
      if (stream.state !== 'ready') return { status: 'not-measured', reason: 'Captured source handover is unconfirmed. Original records are kept; this inspection does not import or repair them.' }
      const window = sessionUsageWindow(id, stream.epoch, stream.sequence, input.cursor)
      const limit = input.limit ?? 100
      // The original (session_id,epoch,sequence) key bounds both the visit and returned rows.
      const rows = db.prepare(`SELECT sequence, CASE WHEN item_json='null' THEN 0 ELSE octet_length(item_json) END AS logicalBytes
        FROM captured_record_versions WHERE session_id=? AND epoch=? AND sequence>? AND sequence<=?
        ORDER BY sequence LIMIT ?`).all(id, window.epoch, window.afterSequence, window.throughSequence, limit + 1)
        .map(row => ({ sequence: Number(row.sequence), logicalBytes: Number(row.logicalBytes) }))
      signal?.throwIfAborted()
      return sessionUsageMeasurement(window, rows, limit)
    }, () => ({ status: 'not-measured', reason: 'The original store is readable through rescue, but captured storage usage is unconfirmed.' }), signal, true)
  }
  async readFuturePromptIntent(agentSessionId: string, intentId: string): Promise<AgentFuturePromptIntent | null> {
    await this.sessionWrites(agentSessionId)
    return await this.withReadDatabase(db => { this.assertRecordReadable(db, agentSessionId); return this.futureIntent(db, agentSessionId, intentId) },
      document => structuredClone(document.sessions.find(session => session.agentSessionId === agentSessionId)?.futurePromptIntents?.[intentId] ?? null), undefined, true)
  }

  async listFuturePromptIntents(agentSessionId: string, options: { afterIntentId?: string; limit?: number } = {}): Promise<AgentMuxFuturePromptPage> {
    await this.sessionWrites(agentSessionId)
    const limit = futurePageLimit(options.limit)
    return await this.withReadDatabase(db => {
      this.assertRecordReadable(db, agentSessionId)
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
    }, undefined, true)
  }

  async compareAndSwapMetadata(expected: AgentMuxStoredAgentSession | null, next: AgentMuxStoredAgentSession | null,
    signal?: AbortSignal, future?: AgentMuxSessionFutureChange, author?: Readonly<AgentCapabilityBinding>): Promise<void> {
    expected = captureSessionRuns(expected); next = captureSessionRuns(next)
    await this.withRunBindingWrites(sessionRuns(expected, next), () => this.enqueue(async () => {
      await this.swapSession(expected, next, false, signal, future, author)
    }, signal, expected?.agentSessionId ?? next?.agentSessionId))
  }

  async compareAndSwapMetadataWithTimeline(expected: AgentMuxStoredAgentSession, next: AgentMuxStoredAgentSession,
    mutation: AgentTimelineMutation, signal?: AbortSignal): Promise<AgentMuxMetadataTimelineResult> {
    expected = captureSessionRuns(expected)!; next = captureSessionRuns(next)!
    if (expected.agentSessionId !== next.agentSessionId || expected.run.runId !== next.run.runId || !isDeepStrictEqual(expected.nativeHandle, next.nativeHandle))
      throw new AgentMuxError('A Tool history write must retain its original Session, Run and native target.', 'INVALID_AGENT_SESSION_STORE')
    const id = expected.agentSessionId
    const current = (this.timelineTails.get(id) ?? Promise.resolve()).then(async (): Promise<AgentMuxMetadataTimelineResult> => {
      signal?.throwIfAborted()
      let canonical: AgentTimelineMutation
      try {
        canonical = normalizeAgentTimelineMutation(mutation)
        if (canonical.agentSessionId !== id) throw new AgentMuxError('History contribution names another Session.', 'INVALID_AGENT_TIMELINE_STORE')
        // Preparation owns a different write. Its failure is not an attempt of this receipt.
        await this.prepareCapturedHistory(id, signal)
      } catch (timelineFailure) {
        signal?.throwIfAborted()
        try { await this.compareAndSwapMetadata(expected, next, signal) }
        catch (error) { throw retainTimelineFailure(error, timelineFailure) }
        return { timelineFailure }
      }
      const settlement: MetadataTimelineSettlement = { rolledBackCleanly: false }
      let outcome!: AgentMuxMetadataTimelineResult, historyFailed = false, timelineFailure: unknown
      try {
        await this.enqueue(async () => {
          await this.swapSession(expected, next, false, signal)
          try {
            this.db.exec('SAVEPOINT hook_history')
            if (!await this.timelineMutationAllowed(canonical, signal))
              throw new AgentMuxError(`Unknown Agent Session: ${id}`, 'UNKNOWN_AGENT_SESSION')
            const commit = structuredClone(commitCapturedMutation(this.db, canonical))
            this.dirty = true
            this.db.exec('RELEASE hook_history')
            outcome = { timeline: commit }
          } catch (error) {
            historyFailed = true
            timelineFailure = sessionStorageFailure(error, 'mutation')
            const cleanup: unknown[] = []
            try { this.db.exec('ROLLBACK TO hook_history') } catch (failure) { cleanup.push(failure) }
            try { this.db.exec('RELEASE hook_history') } catch (failure) { cleanup.push(failure) }
            if (cleanup.length) throw sessionStorageFailure(timelineFailure, 'mutation', cleanup)
            outcome = { timelineFailure }
          }
        }, signal, id, settlement)
        // COMMIT + sync already confirmed this metadata. Retain the original lease
        // cleanup warning/retry without turning that acknowledged save into uncertainty.
        return outcome
      } catch (error) {
        // Only this writer can confirm no COMMIT was attempted and its handles were released.
        // Its queue item has settled before the original exact metadata CAS is attempted.
        if (historyFailed && settlement.rolledBackCleanly && !signal?.aborted) {
          try { await this.compareAndSwapMetadata(expected, next, signal) }
          catch (metadataFailure) { throw retainTimelineFailure(metadataFailure, timelineFailure) }
          return { timelineFailure }
        }
        const failure = 'releaseFailure' in settlement
          ? sessionStorageFailure(error, 'release', [settlement.releaseFailure]) : error
        throw historyFailed ? retainTimelineFailure(failure, timelineFailure) : failure
      }
    })
    const settled = current.then(() => {}, () => {})
    this.timelineTails.set(id, settled)
    void settled.then(() => { if (this.timelineTails.get(id) === settled) this.timelineTails.delete(id) })
    return await this.withRunBindingWrites(sessionRuns(expected, next), () => current)
  }

  async loadRetiredRuns(): Promise<readonly AgentMuxRunRef[]> {
    await this.tail
    return await this.withReadDatabase(db => db.prepare('SELECT json FROM retired_runs ORDER BY rowid').all()
      .map(row => runRef(JSON.parse(String(row.json)))), document => document.retiredRuns)
  }

  async loadRetiredAgentSessions(signal?: AbortSignal): Promise<readonly AgentMuxRetiredAgentSession[]> {
    await observeRead(this.tail, signal)
    return await this.withReadDatabase(db => db.prepare('SELECT json FROM retired_sessions ORDER BY rowid').all()
      .map(row => retiredAgentSession(JSON.parse(String(row.json)))), document => structuredClone(document.retiredAgentSessions), signal)
  }

  async readRetiredAgentSession(agentSessionId: string, signal?: AbortSignal): Promise<AgentMuxRetiredAgentSession | null> {
    string(agentSessionId, 'agentSessionId')
    await this.sessionWrites(agentSessionId, signal)
    return await this.withReadDatabase(db => {
      const row = db.prepare('SELECT json FROM retired_sessions WHERE id=?').get(agentSessionId)
      if (!row) return null
      const value = retiredAgentSession(JSON.parse(String(row.json)))
      if (value.agentSessionId !== agentSessionId || this.sessionMetadata(db, agentSessionId)) throw new AgentMuxError(
        'Original retirement does not match its stored location or conflicts with an active Session.', 'INVALID_AGENT_SESSION_STORE')
      return value
    }, document => {
      const value = document.retiredAgentSessions.find(session => session.agentSessionId === agentSessionId)
      if (value && document.sessions.some(session => session.agentSessionId === agentSessionId)) throw new AgentMuxError(
        'Session is both active and retired.', 'INVALID_AGENT_SESSION_STORE')
      return value ? retiredAgentSession(value) : null
    }, signal)
  }

  async readRecordDeletion(agentSessionId: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    // Committed terminal point only: an error/cancel observer must not wait for a queued
    // writer. An uncommitted deletion is not evidence to purge a healthy reading view.
    return await this.withReadDatabase(db => {
      const row = db.prepare("SELECT json_extract(json,'$.recordDeletion') AS fact FROM retired_sessions WHERE id=?").get(agentSessionId)
      return row?.fact == null ? null : parseAgentSessionRecordDeletion(JSON.parse(String(row.fact)))
    }, document => {
      const fact = document.retiredAgentSessions.find(value => value.agentSessionId === agentSessionId)?.recordDeletion
      return fact ? parseAgentSessionRecordDeletion(fact) : null
    }, signal, true)
  }

  async deleteRecord(expected: AgentMuxRetiredAgentSession, operationId: string, signal?: AbortSignal) {
    let result!: AgentMuxRetiredAgentSession, admitted = false
    await this.enqueue(async () => {
      const original = retiredAgentSession(expected), id = original.agentSessionId
      const current = this.retiredSession(this.db, id)
      admitted = !current?.recordDeletion
      result = deletedRetirement(current, original, operationId,
        !!this.sessionMetadata(this.db, id), !!this.reservationRow(this.db, id))
      this.db.prepare('UPDATE retired_sessions SET json=? WHERE id=?').run(JSON.stringify(result), id)
      this.dirty = true // Also confirms a prior applied deletion whose sync ACK was lost.
    }, signal, expected.agentSessionId)
    return { retirement: structuredClone(result), admitted }
  }

  async confirmRecordDeletion(expected: AgentMuxRetiredAgentSession, signal?: AbortSignal) {
    let result!: AgentMuxRetiredAgentSession
    await this.enqueue(async () => {
      result = confirmDeletedRetirement(this.retiredSession(this.db, expected.agentSessionId), expected)
      this.dirty = true // Sync only the already observed original fact; no deletion is repeated.
    }, signal, expected.agentSessionId)
    return result
  }

  async cleanRecord(expected: AgentMuxRetiredAgentSession, signal?: AbortSignal) {
    let result!: AgentMuxRetiredAgentSession
    await this.enqueue(async () => {
      const id = expected.agentSessionId
      result = confirmDeletedRetirement(this.retiredSession(this.db, id), expected)
      if (result.recordDeletion!.phase === 'complete') return
      // Only known Session-owned indexed tables. Remaining original rows are the work queue;
      // no count scan, cursor ledger, file action or cross-target rewrite is needed.
      for (const table of ['captured_record_versions', 'captured_record_heads', 'captured_input_pending',
        'captured_input_projection', 'captured_streams', 'prompt_admissions', 'future_intents']) {
        if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) continue
        const deleted = this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE session_id=? LIMIT 128)`).run(id)
        if (deleted.changes) { this.dirty = true; return }
      }
      result = { ...result, recordDeletion: { ...result.recordDeletion!, phase: 'complete' } }
      this.db.prepare('UPDATE retired_sessions SET json=? WHERE id=?').run(JSON.stringify(result), id)
      this.dirty = true
    }, signal, expected.agentSessionId)
    return structuredClone(result)
  }

  async loadReopenCorrelations(signal?: AbortSignal) {
    await observeRead(this.tail, signal)
    return await this.withReadDatabase(db => reopenCorrelations(db.prepare("SELECT json FROM reservations WHERE json_extract(json,'$.kind')='reopen'").all()
      .map(row => lifecycleReservation(JSON.parse(String(row.json))))), document => reopenCorrelations(document.reservations), signal)
  }

  async loadCreationSessionId(createOperationId: string): Promise<string | null> {
    await this.tail
    return await this.withReadDatabase(db => creationSessionId(
      db.prepare('SELECT json FROM sessions WHERE creation_operation=?').all(createOperationId).map(row => normalizeStoredAgentSession(JSON.parse(String(row.json)))),
      db.prepare("SELECT json FROM reservations WHERE json_extract(json,'$.kind')='create'").all().map(row => lifecycleReservation(JSON.parse(String(row.json)))),
      db.prepare("SELECT json FROM retired_sessions WHERE json_extract(json,'$.history.creation.createOperationId')=?").all(createOperationId)
        .map(row => retiredAgentSession(JSON.parse(String(row.json)))), createOperationId),
      document => creationSessionId(document.sessions, document.reservations, document.retiredAgentSessions, createOperationId))
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
    expected = captureSessionRuns(expected); next = captureSessionRuns(next)
    await this.withRunBindingWrites(sessionRuns(expected, next), () => this.enqueue(async () => {
      await this.swapSession(expected, next, true, signal)
    }, signal, expected?.agentSessionId ?? next?.agentSessionId))
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
    const reservationRow = this.db.prepare('SELECT json FROM reservations WHERE id=?').get(id)
    const reservation = reservationRow ? lifecycleReservation(JSON.parse(String(reservationRow.json))) : null
    if (reservation && (!next || !expected || next.run.runId !== expected.run.runId)) throw new AgentMuxError('Agent Session has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
    assertLifecycleReceiptFence(reservation, current, next)
    if (future && !isDeepStrictEqual(this.futureIntent(this.db, id, future.intentId), future.expected)) throw new AgentMuxError('The exact future intent changed before admission.', 'AGENT_FUTURE_INTENT_CHANGED')
    if (next) {
      const normalized = normalizeStoredAgentSession(ordinaryNativeCreationKeys(current,complete ? next : agentSessionMetadata(next)))
      assertInitialInputWrite(current, normalized)
      this.saveSession(this.db, normalized, complete)
    }
    else this.deleteSession(this.db, id)
    if (future && !isDeepStrictEqual(future.expected, future.next)) this.saveFutureIntent(this.db, id, future)
    this.dirty = true
  }

  async reserveLifecycle(value: AgentMuxLifecycleReservation): Promise<void> {
    let reservation = lifecycleReservation(value)
    let admissionChecked = false
    try { await this.enqueue(async () => {
      reservation={...reservation,nativeCreationKeys:reservationNativeCreationKeys(reservation,this.sessionMetadata(this.db,reservation.agentSessionId),this.reservationRow(this.db,reservation.agentSessionId))}
      if (reservation.kind === 'resume' && reservation.restart) {
        const row = this.db.prepare('SELECT json FROM reservations WHERE id=?').get(reservation.agentSessionId)
        if (row) throw new AgentMuxError('Agent Session already has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
        const session = this.sessionMetadata(this.db, reservation.agentSessionId)
        if (!session) throw new AgentMuxError('The original Session is unavailable.', 'UNKNOWN_AGENT_SESSION')
        assertReservationPrecondition(reservation, [session], [])
        const admitted = restartAdmission(session, reservation, 'new')
        this.saveSession(this.db, admitted, false)
        this.db.prepare('INSERT INTO reservations (id, json) VALUES (?, ?)').run(reservation.agentSessionId, JSON.stringify(reservation))
        this.dirty = true
        return
      }
      // One target: its reservation, current Session and retirement rows are the whole precondition.
      // A row-level read keeps unrelated Sessions and the accumulated history out of this admission.
      const row = this.db.prepare('SELECT json FROM reservations WHERE id=?').get(reservation.agentSessionId)
      const current = row ? lifecycleReservation(JSON.parse(String(row.json))) : undefined
      if (current && !canSupersedeRestartWithStop(current, reservation) && !canSupersedePreparedResumeWithStop(current, reservation)) {
        throw new AgentMuxError('Agent Session already has a lifecycle operation in progress.', 'AGENT_SESSION_BUSY')
      }
      const session = this.sessionMetadata(this.db, reservation.agentSessionId)
      const retired = this.retiredSession(this.db, reservation.agentSessionId)
      assertReservationPrecondition(reservation, session ? [session] : [], retired ? [retired] : [])
      // Only this locked new reservation has proved there is no existing owner.
      // Lock/open/read and competing operation failures cannot make this claim.
      admissionChecked = reservation.kind === 'create'
      if (current) {
        // Superseding keeps the original rowid, so stale-claim recovery keeps its original order.
        const updated = this.db.prepare('UPDATE reservations SET json=? WHERE id=? AND json=?')
          .run(JSON.stringify(reservation), reservation.agentSessionId, String(row!.json))
        if (updated.changes !== 1) throw new AgentMuxError('Lifecycle reservation changed before supersession.', 'STALE_AGENT_SESSION')
        this.dirty = true
      } else this.insertReservation(this.db, reservation)
    }, undefined, reservation.agentSessionId) } catch (error) {
      if (!admissionChecked) throw error
      const failure = agentCreationNotAppliedError(error, reservation.operationId)
      await finishAgentCreationCleanup(failure, [async () => { await this.releaseLifecycle(reservation) }])
      throw failure
    }
  }

  async recordRestartAdmission(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, mode: 'continue' | 'restore' = 'continue'): Promise<AgentMuxStoredAgentSession> {
    let result!: AgentMuxStoredAgentSession
    await this.enqueue(async () => {
      const row = this.db.prepare('SELECT json FROM reservations WHERE id=?').get(reservation.agentSessionId)
      const current = row ? lifecycleReservation(JSON.parse(String(row.json))) : null
      if (!current || current.kind !== 'resume' || !sameReservationOwner(current, reservation) || current.operationId !== reservation.operationId || !current.restart || current.preparedSession || current.expectedRun.runId !== reservation.expectedRun.runId || !isDeepStrictEqual(current.restart, reservation.restart)) throw new AgentMuxError('The original restart reservation changed.', 'STALE_AGENT_SESSION')
      const session = this.sessionMetadata(this.db, reservation.agentSessionId)
      if (!session) throw new AgentMuxError('The original Session is unavailable.', 'STALE_AGENT_SESSION')
      result = restartAdmission(session, current, mode)
      if (result !== session) { this.saveSession(this.db, result, false); this.dirty = true }
    }, undefined, reservation.agentSessionId)
    return structuredClone(result)
  }

  async readContinuityControlReceipt(agentSessionId: string, operationId: string): Promise<ContinuityControlStoredResult | null> {
    await this.sessionWrites(agentSessionId)
    return await this.withReadDatabase(db => {
      const session = this.sessionMetadata(db, agentSessionId)
      const row = session ? undefined : db.prepare('SELECT json FROM retired_sessions WHERE id=?').get(agentSessionId)
      return continuityControlStoredResult(session, row ? retiredAgentSession(JSON.parse(String(row.json))) : null, operationId)
    }, document => continuityControlStoredResult(document.sessions.find(session => session.agentSessionId === agentSessionId) ?? null,
      document.retiredAgentSessions.find(session => session.agentSessionId === agentSessionId) ?? null, operationId), undefined, true)
  }

  async readLifecycleReservation(agentSessionId: string): Promise<AgentMuxLifecycleReservation | null> {
    await this.sessionWrites(agentSessionId)
    return await this.withReadDatabase(db => {
      const row = db.prepare('SELECT json FROM reservations WHERE id=?').get(agentSessionId)
      return row ? lifecycleReservation(JSON.parse(String(row.json))) : null
    }, document => structuredClone(document.reservations.find(item => item.agentSessionId === agentSessionId) ?? null), undefined, true)
  }
  async loadResumeCorrelation(agentSessionId: string, operationId: string) {
    await this.sessionWrites(agentSessionId)
    return await this.withReadDatabase(db => {
      const row = db.prepare('SELECT json FROM reservations WHERE id=?').get(agentSessionId)
      const reservation = row ? lifecycleReservation(JSON.parse(String(row.json))) : null
      return reservation?.kind === 'resume' && reservation.operationId === operationId ? structuredClone(reservation) : null
    }, document => {
      const reservation = document.reservations.find(item => item.agentSessionId === agentSessionId)
      return reservation?.kind === 'resume' && reservation.operationId === operationId ? structuredClone(reservation) : null
    }, undefined, true)
  }
  async recordRestartStartNotApplied(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, failure: { code: string; message: string; observedAt: number }) {
    let next!: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>
    await this.enqueue(async () => {
      next = restartStartNotAppliedReservation(this.reservationRow(this.db, reservation.agentSessionId), reservation, failure)
      this.replaceReservation(this.db, next)
    }, undefined, reservation.agentSessionId)
    return structuredClone(next)
  }

  async prepareResume(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>, session: AgentMuxStoredAgentSession, dispatch?: AgentMuxPreparedResumeDispatch) {
    let next!: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }>
    await this.enqueue(async () => {
      next = preparedResumeReservation(this.reservationRow(this.db, reservation.agentSessionId), reservation, session, dispatch)
      const target = this.lifecycleTarget(this.db, reservation.agentSessionId)
      assertReservationPrecondition(next, target.sessions, target.retired)
      assertSupervisedResumeClaim(next, target.sessions)
      this.replaceReservation(this.db, next)
    }, undefined, reservation.agentSessionId)
    return structuredClone(next)
  }

  async admitResumeResolution(original: ResumeReservation, request: ResumeResolutionRequest, claim: AgentMuxLifecycleClaim & { reservationId: string }) {
    let result!: ResumeReservation
    await this.enqueue(async () => {
      const target = this.lifecycleTarget(this.db, original.agentSessionId)
      const next = admittedResumeResolution(this.reservationRow(this.db, original.agentSessionId), original, target.session ?? undefined, request, claim)
      assertReservationPrecondition(next.reservation, target.sessions, target.retired)
      this.saveSession(this.db, normalizeStoredAgentSession(next.session), false)
      this.replaceReservation(this.db, next.reservation)
      result = next.reservation
    }, undefined, original.agentSessionId)
    return structuredClone(result)
  }

  async releaseResumeResolutionOwner(original: ResumeReservation) {
    await this.enqueue(async () => {
      const row = this.db.prepare('SELECT json FROM reservations WHERE id=?').get(original.agentSessionId)
      const current = row ? lifecycleReservation(JSON.parse(String(row.json))) : null
      if (current?.kind === 'resume' && current.resolution && sameReservationOwner(current, original)) {
        this.db.prepare('UPDATE reservations SET json=? WHERE id=?').run(JSON.stringify({ ...current, ownerReleased: true }), original.agentSessionId)
        this.dirty = true
      }
    }, undefined, original.agentSessionId)
  }

  async recordResumeResolutionFailure(original: ResumeReservation, failure: { code: string; message: string }) {
    let result!: AgentMuxStoredAgentSession
    await this.enqueue(async () => {
      const canonical = this.sessionMetadata(this.db, original.agentSessionId) ?? undefined
      result = resumeResolutionFailure(this.reservationRow(this.db, original.agentSessionId), original, canonical, failure)
      if (result !== canonical) { this.saveSession(this.db, normalizeStoredAgentSession(result), false); this.dirty = true }
    }, undefined, original.agentSessionId)
    return structuredClone(result)
  }

  async handoffResumeResolution(original: ResumeReservation, successor: ResumeReservation, session: AgentMuxStoredAgentSession,
    dispatch: AgentMuxPreparedResumeDispatch, retirement: AgentMuxCreationRuntime) {
    let result!: ResumeReservation
    await this.enqueue(async () => {
      const target = this.lifecycleTarget(this.db, original.agentSessionId)
      const next = handedOffResumeResolution(this.reservationRow(this.db, original.agentSessionId), original, target.session ?? undefined,
        successor, session, dispatch, retirement)
      assertReservationPrecondition(next.reservation, target.sessions, target.retired)
      this.saveSession(this.db, normalizeStoredAgentSession(next.session), false)
      this.replaceReservation(this.db, next.reservation)
      result = next.reservation
    }, undefined, original.agentSessionId)
    return structuredClone(result)
  }

  async prepareReopen(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>, session: AgentMuxStoredAgentSession): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>> {
    let next: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> | undefined
    await this.enqueue(async () => {
      next = preparedReopenReservation(this.reservationRow(this.db, reservation.agentSessionId), reservation, session)
      const target = this.lifecycleTarget(this.db, reservation.agentSessionId)
      assertReservationPrecondition(next, target.sessions, target.retired)
      this.replaceReservation(this.db, next)
    }, undefined, reservation.agentSessionId)
    return structuredClone(next!)
  }

  async prepareCreate(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'create' }>, seed: AgentMuxPreparedCreation): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'create' }>> {
    let next: Extract<AgentMuxLifecycleReservation, { kind: 'create' }> | undefined
    await this.enqueue(async () => {
      next = preparedCreateReservation(this.reservationRow(this.db, reservation.agentSessionId), reservation, seed)
      const target = this.lifecycleTarget(this.db, reservation.agentSessionId)
      assertReservationPrecondition(next, target.sessions, target.retired)
      const owners = this.nativeOwnerCandidates(this.db, next.preparedCreation!.nativeHandle)
      assertNativeCreationOwner(next.preparedCreation!, owners.sessions, owners.retired, owners.reservations)
      this.replaceReservation(this.db, next)
    }, undefined, reservation.agentSessionId)
    return structuredClone(next!)
  }

  async claimCreate(agentSessionId: string, operationId: string, intentDigest: string, claim: AgentMuxLifecycleClaim): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'create' }> | null> {
    let next: Extract<AgentMuxLifecycleReservation, { kind: 'create' }> | null = null
    await this.enqueue(async () => {
      next = claimedCreateReservation(this.reservationRow(this.db, agentSessionId), operationId, intentDigest, claim)
      if (next) this.replaceReservation(this.db, next)
    }, undefined, agentSessionId)
    return next ? structuredClone(next) : null
  }

  async releaseReopenOwner(ownerId: string): Promise<void> {
    await this.enqueue(async () => {
      const retained = (item: AgentMuxLifecycleReservation) => (item.kind === 'reopen' || item.kind === 'create' && item.preparedCreation || item.kind === 'resume' && (item.restart || item.resolution)) && item.ownerId === ownerId
      // Reservations are the open lifecycle operations only; reading them all never touches Sessions or history.
      for (const row of this.db.prepare('SELECT json FROM reservations ORDER BY rowid').all()) {
        const item = lifecycleReservation(JSON.parse(String(row.json)))
        if (retained(item)) this.replaceReservation(this.db, { ...item, ownerReleased: true } as AgentMuxLifecycleReservation)
      }
    }, undefined, CROSS_SESSION_WRITE)
  }

  async claimRestart(agentSessionId: string, operationId: string, claim: AgentMuxLifecycleClaim) {
    let next: Extract<AgentMuxLifecycleReservation, { kind: 'resume' }> | null = null
    await this.enqueue(async () => {
      next = claimedRestartReservation(this.reservationRow(this.db, agentSessionId), operationId, claim)
      if (next) this.replaceReservation(this.db, next)
    }, undefined, agentSessionId)
    return next ? structuredClone(next) : null
  }

  async claimReopen(agentSessionId: string, operationId: string, expectedRetiredAt: number, claim: AgentMuxLifecycleClaim): Promise<Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> | null> {
    let next: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }> | null = null
    await this.enqueue(async () => {
      next = claimedReopenReservation(this.reservationRow(this.db, agentSessionId), operationId, expectedRetiredAt, claim)
      if (next) this.replaceReservation(this.db, next)
    }, undefined, agentSessionId)
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
      const reservations = this.db.prepare('SELECT json FROM reservations ORDER BY rowid').all().map(row => lifecycleReservation(JSON.parse(String(row.json))))
      claimed = reservations.flatMap((reservation) => {
        if (
          !((reservation.kind === 'reopen' || reservation.kind === 'create' || reservation.kind === 'resume') && reservation.ownerReleased) && reservation.ownerId !== claim.ownerId &&
          processIsAlive(reservation.ownerPid)
        ) return []
        return [lifecycleReservation({
          ...reservation,
          ...(reservation.kind === 'resume' && reservation.resolution ? { ownerReleased: reservation.ownerReleased || !processIsAlive(reservation.ownerPid) ? true : undefined } :
          reservation.kind === 'reopen' || reservation.kind === 'create' || reservation.kind === 'resume' ? { ownerReleased: undefined } : {}),
          ownerId: claim.ownerId,
          ownerPid: claim.ownerPid,
          expiresAt: claim.expiresAt
        })]
      })
      for (const reservation of claimed) this.replaceReservation(this.db, reservation)
    }, undefined, CROSS_SESSION_WRITE)
    return claimed.map((reservation) => structuredClone(reservation))
  }

  async releaseLifecycle(
    value: AgentMuxLifecycleReservation,
    retiredRuns: readonly AgentMuxRunRef[] = []
  ): Promise<void> {
    const reservation = lifecycleReservation(value)
    retiredRuns = retiredRuns.map(runRef)
    await this.withRunBindingWrites(retiredRuns, () => this.enqueue(async () => {
      const current = this.reservationRow(this.db, reservation.agentSessionId)
      if (!current) return
      if (!sameReservationOwner(current, reservation)) {
        throw new AgentMuxError('Lifecycle reservation belongs to another owner.', 'AGENT_SESSION_BUSY')
      }
      this.retireRunRows(this.db, retiredRuns)
      const owner=this.sessionMetadata(this.db,reservation.agentSessionId)
      if(owner)this.saveSession(this.db,{...owner,nativeCreationKeys:mergeNativeCreationKeys(owner.nativeCreationKeys,current.nativeCreationKeys)},false)
      this.db.prepare('DELETE FROM reservations WHERE id=?').run(reservation.agentSessionId)
      this.dirty = true
    }, undefined, CROSS_SESSION_WRITE))
  }

  async retireRuns(runs: readonly AgentMuxRunRef[]): Promise<void> {
    runs = runs.map(runRef)
    await this.withRunBindingWrites(runs, () => this.enqueue(async () => {
      this.retireRunRows(this.db, runs)
    }, undefined, CROSS_SESSION_WRITE))
  }

  async recordStopProgress(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'stop' }>, progress: AgentMuxAgentStopProgress): Promise<void> {
    await this.enqueue(async () => {
      this.replaceReservation(this.db, stopProgressReservation(this.reservationRow(this.db, reservation.agentSessionId), reservation, progress))
    }, undefined, reservation.agentSessionId)
  }

  async commitLifecycle(
    value: AgentMuxLifecycleReservation,
    next: AgentMuxStoredAgentSession | null,
    stop?: AgentMuxAgentStopRecord
  ): Promise<AgentMuxRetiredAgentSession | null> {
    const reservation = lifecycleReservation(value)
    next = captureSessionRuns(next)
    const retained = reservation.kind === 'stop' ? reservation.supersededResume?.retainedRun : undefined
    let committed: AgentMuxRetiredAgentSession | null = null
    await this.withRunBindingWrites([...sessionRuns(next), ...(retained ? [retained] : [])], () => this.enqueue(async () => {
      if (reservation.kind === 'stop') { committed = this.commitStop(reservation, next, stop); return }
      stopRecordFor(reservation, stop, reservation) // refuses a Stop record on any other lifecycle
      this.commitSessionLifecycle(reservation, next)
    }, undefined, reservation.agentSessionId))
    return committed
  }

  /**
   * Create, resume and reopen commit one Session by its own rows. The prepared Session replaces
   * the current row; a reopen also moves its exact retirement and Runs back from retired history.
   * Cross-Session uniqueness (id, Run, native identity, prompt operation) is enforced by the binding
   * tables, the unique prompt index and saveSession's exact lookups, never by reading the catalog.
   */
  private commitSessionLifecycle(reservation: Exclude<AgentMuxLifecycleReservation, { kind: 'stop' }>, next: AgentMuxStoredAgentSession | null): void {
    const db = this.db, id = reservation.agentSessionId
    const current = this.reservationRow(db, id)
    if (!current || !sameReservationOwner(current, reservation)) {
      throw new AgentMuxError('Lifecycle reservation is no longer current.', 'STALE_AGENT_SESSION')
    }
    const target = this.lifecycleTarget(db, id), previous = target.session ?? undefined
    assertReservationPrecondition(reservation, target.sessions, target.retired)
    const normalized = next ? normalizeStoredAgentSession({...preserveContinuityOperations(previous, next,
      current.kind === 'resume' ? current.resolution?.receipt.originalOperationId : undefined),nativeCreationKeys:committedNativeCreationKeys(current,previous)}) : null
    assertLifecycleReceiptFence(current, previous ?? null, normalized, true)
    assertLifecycleCommit(current, normalized)
    if (reservation.kind === 'reopen') {
      // The exact retirement leaves history together with the closed Run and the earlier Runs its
      // creation fact names (reopenedPriorRuns). Any other retired Run the prepared Session names
      // stays retired, so saveSession refuses it through its NULL binding.
      const retirement = reservation.expectedRetirement
      db.prepare('DELETE FROM retired_sessions WHERE id=?').run(id)
      for (const run of [retirement.run, ...reopenedPriorRuns(retirement)]) {
        db.prepare('DELETE FROM retired_runs WHERE id=?').run(run.runId)
        db.prepare('DELETE FROM run_bindings WHERE run_id=? AND session_id IS NULL').run(run.runId)
      }
    }
    if (normalized) this.saveSession(db, normalized, false)
    else this.deleteSession(db, id)
    db.prepare('DELETE FROM reservations WHERE id=?').run(id)
    this.dirty = true
  }

  /**
   * A user Stop retires exactly one Session: its rows move from current to retired in one
   * transaction. Every check reads only that Session's rows; unrelated Sessions, accumulated
   * retirements and their prompt records are neither read nor rewritten.
   */
  private commitStop(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'stop' }>, next: AgentMuxStoredAgentSession | null, stop: AgentMuxAgentStopRecord | undefined): AgentMuxRetiredAgentSession {
    const db = this.db, id = reservation.agentSessionId
    const row = db.prepare('SELECT json FROM reservations WHERE id=?').get(id)
    const current = row ? lifecycleReservation(JSON.parse(String(row.json))) : null
    if (!current || current.kind !== 'stop' || !sameReservationOwner(current, reservation)) {
      throw new AgentMuxError('Lifecycle reservation is no longer current.', 'STALE_AGENT_SESSION')
    }
    // The Store's own row is the admitted takeover; the caller's copy cannot add or drop one.
    const record = stopRecordFor(current, stop, reservation)
    const previous = this.sessionMetadata(db, id)
    if (!previous) throw new AgentMuxError(`Unknown Agent Session: ${id}`, 'UNKNOWN_AGENT_SESSION')
    assertReservationPrecondition(reservation, [previous], [])
    assertLifecycleReceiptFence(current, previous, null, true)
    assertLifecycleCommit(current, next)
    const runs = stopRetiredRuns(previous, current).map(runRef)
    for (const run of runs) {
      const bound = db.prepare('SELECT session_id FROM run_bindings WHERE run_id=?').get(run.runId)
      if (bound && bound.session_id !== id) throw new AgentMuxError('Unbound retired Run conflicts with an Agent Session.', 'INVALID_AGENT_SESSION_STORE')
    }
    if (this.retiredSession(db, id)) {
      throw new AgentMuxError('Retired Agent Session conflicts with current Session or Run truth.', 'INVALID_AGENT_SESSION_STORE')
    }
    db.prepare('DELETE FROM reservations WHERE id=?').run(id)
    this.deleteSession(db, id)
    this.retireRunRows(db, runs)
    const retired = retiredAgentSession({
      agentSessionId: previous.agentSessionId,
      hostId: previous.hostId,
      run: { ...previous.run },
      source: 'user',
      observedAt: Date.now(),
      history: sessionHistoryMetadata(previous),
      nativeCreationKeys:committedNativeCreationKeys(current,previous),
            ...(previous.executorInvocation === undefined ? {} : { executorInvocation: structuredClone(previous.executorInvocation) }),
      continuityControlReceipts: continuityControlReceipts(previous),
      ...(previous.activityCommit ? { activityCommit: previous.activityCommit } : {}),
      ...(record ? { stop: record } : {})
    })
    db.prepare('INSERT INTO retired_sessions (id, json) VALUES (?, ?)').run(id, JSON.stringify(retired))
    this.dirty = true
    return structuredClone(retired)
  }

  private retiredSession(db: DatabaseSync, id: string): AgentMuxRetiredAgentSession | null {
    const row = db.prepare('SELECT json FROM retired_sessions WHERE id=?').get(id)
    return row ? retiredAgentSession(JSON.parse(String(row.json))) : null
  }

  /** The exact lifecycle reservation row of one Session; no other Session's rows are read. */
  private reservationRow(db: DatabaseSync, id: string): AgentMuxLifecycleReservation | undefined {
    const row = db.prepare('SELECT json FROM reservations WHERE id=?').get(id)
    return row ? lifecycleReservation(JSON.parse(String(row.json))) : undefined
  }

  /**
   * Append Runs to the retired history by their own rows. A Run bound to a current Session cannot
   * retire unbound; re-retiring keeps one row moved to the end, as mergeRetiredRuns orders history.
   */
  private retireRunRows(db: DatabaseSync, runs: readonly AgentMuxRunRef[]): void {
    for (const value of runs) {
      const run = runRef(value)
      const bound = db.prepare('SELECT session_id FROM run_bindings WHERE run_id=?').get(run.runId)
      if (bound && bound.session_id !== null) throw new AgentMuxError('Unbound retired Run conflicts with an Agent Session.', 'INVALID_AGENT_SESSION_STORE')
      db.prepare('DELETE FROM retired_runs WHERE id=?').run(run.runId)
      db.prepare('INSERT INTO retired_runs (id, json) VALUES (?, ?)').run(run.runId, JSON.stringify(run))
      db.prepare('INSERT INTO run_bindings (run_id, session_id) VALUES (?, NULL) ON CONFLICT(run_id) DO UPDATE SET session_id=NULL').run(run.runId)
    }
    if (runs.length) this.dirty = true
  }

  /** Admit one new lifecycle reservation row. */
  private insertReservation(db: DatabaseSync, reservation: AgentMuxLifecycleReservation): void {
    db.prepare('INSERT INTO reservations (id, json) VALUES (?, ?)').run(reservation.agentSessionId, JSON.stringify(reservation))
    this.dirty = true
  }

  /** Replace one reservation in place, keeping its rowid so stale-claim recovery keeps its order. */
  private replaceReservation(db: DatabaseSync, next: AgentMuxLifecycleReservation): void {
    const updated = db.prepare('UPDATE reservations SET json=? WHERE id=?').run(JSON.stringify(lifecycleReservation(next)), next.agentSessionId)
    if (updated.changes !== 1) throw new AgentMuxError('Lifecycle reservation changed before its update.', 'STALE_AGENT_SESSION')
    this.dirty = true
  }

  /**
   * The rows that could already own one native conversation, found through SQLite instead of the
   * whole catalog: current Sessions naming it as handle, observed handle or candidate, retirements
   * naming it in their history, and prepared creations or reopens naming it. The original predicate
   * (assertNativeCreationOwner) still decides on exactly these rows.
   */
  private nativeOwnerCandidates(db: DatabaseSync, handle: AgentNativeSessionHandle | undefined) {
    if (handle?.kind !== 'provider') return { sessions: [], retired: [], reservations: [] }
    const like = `%${JSON.stringify(handle.sessionId).slice(1, -1)}%`
    const sessions = db.prepare('SELECT json FROM sessions WHERE json LIKE ?').all(like).map(row => normalizeStoredAgentSession(JSON.parse(String(row.json))))
    const retired = db.prepare('SELECT json FROM retired_sessions WHERE json LIKE ?').all(like).map(row => retiredAgentSession(JSON.parse(String(row.json))))
    const reservations = db.prepare('SELECT json FROM reservations WHERE json LIKE ?').all(like).map(row => lifecycleReservation(JSON.parse(String(row.json))))
    return { sessions, retired, reservations }
  }

  /** The one Session a lifecycle precondition can name, as the single-element catalog its assertions read. */
  private lifecycleTarget(db: DatabaseSync, id: string) {
    const session = this.sessionMetadata(db, id), retired = this.retiredSession(db, id)
    return { session, sessions: session ? [session] : [], retired: retired ? [retired] : [] }
  }

  private async withCapturedRead<T>(read: (db: DatabaseSync) => T): Promise<T> {
    // Reuse the original connection/cleanup owner, with a committed public reader.
    return await this.withReadDatabase(read, () => {
      throw new AgentMuxError('Original Session persistence is unavailable for this captured read.', 'AGENT_SESSION_STORE_READ_UNCONFIRMED')
    }, undefined, true)
  }

  private async prepareCapturedHistory(id: string, signal?: AbortSignal): Promise<AgentCapturedTimelinePage['stream']['gaps']> {
    if (await this.readRecordDeletion(id, signal)) deletedAgentSessionRecord(id)

    const pending = this.capturedPreparations.get(id);
    if (pending)
      return await pending;
    const work = (async () => {
      await this.sessionWrites(id, signal);
      // Schema creation and initial source ownership use the original writer, once.
      const committed = await readCurrentSessionDatabase(this.path);
      let existing: ReturnType<typeof capturedStream>;
      try {
        existing = committed?.prepare("SELECT 1 FROM sqlite_schema WHERE name='captured_streams'").get() ? capturedStream(committed, id) : undefined;
      }
      finally {
        committed?.close();
      }
      const path = this.timelinePath(id);
      if (existing?.state === 'ready') {
        try {
          const observed = await capturedFileWitness(path);
          return observed !== null && observed !== existing.source_witness
            ? [{ code: 'CAPTURED_ORIGINAL_CHANGED_AFTER_HANDOVER', message: 'The preserved original JSONL changed after its acknowledged handover. The original SQLite epoch and accepted facts remain readable; the changed original file is retained for exact repair.' }]
            : [];
        } catch (error) {
          return [{ code: 'CAPTURED_ORIGINAL_OBSERVATION_UNAVAILABLE', message: `The preserved original file could not be observed: ${error instanceof Error ? error.message : String(error)}. Accepted SQLite facts and ordinary input remain available.` }];
        }
      }
      const witness = await capturedFileWitness(path);
      await this.enqueue(async () => {
        this.assertRecordReadable(this.db, id)

        const row = capturedStream(this.db, id);
        if (row?.state === 'ready')
          return;
        if (!this.db.prepare('SELECT 1 FROM sessions WHERE id=? UNION ALL SELECT 1 FROM retired_sessions WHERE id=?').get(id, id))
          throw new AgentMuxError(`Unknown Agent Session: ${id}`, 'UNKNOWN_AGENT_SESSION');
        const stream = beginCapturedStream(this.db, id, witness);
        if (stream.source_witness !== witness)
          throw new AgentMuxError('Original captured source changed before handover confirmation; retain its original file and retry repair.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED');
        this.dirty = true;
      }, signal, id);
      let index = 0, gaps: Array<{
        code: string;
        message: string;
      }> = [];
      if (witness !== null) {
        const imported = await importCapturedFile(path, id, async (units) => {
          const start = index;
          index += units.length;
          await this.enqueue(async () => {
        this.assertRecordReadable(this.db, id)

            const stream = capturedStream(this.db, id)!;
            if (stream.state === 'ready')
              return;
            for (let at = 0; at < units.length; at++) {
              const ordinal = start + at + 1;
              if (ordinal <= stream.import_index)
                continue;
              const unit = units[at]!;
              if (unit.kind === 'snapshot') {
                this.db.prepare('UPDATE captured_streams SET revision=? WHERE session_id=?').run(unit.revision, id);
                this.db.prepare('UPDATE captured_record_versions SET timeline_revision=? WHERE session_id=? AND epoch=? AND sequence=(SELECT sequence FROM captured_streams WHERE session_id=?)').run(unit.revision, id, stream.epoch, id);
              }
              else
                commitCapturedMutation(this.db, unit.kind === 'item' ? { type: 'append', agentSessionId: id, item: unit.item } : unit.mutation, true);
              this.db.prepare('UPDATE captured_streams SET import_index=? WHERE session_id=?').run(ordinal, id);
              this.dirty = true;
            }
          }, signal, id);
        }, signal);
        gaps = imported.gaps;
        if (await capturedFileWitness(path) !== witness)
          throw new AgentMuxError('Original captured source changed during handover; no ready stream was published.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED');
        if (await this.readRecordDeletion(id, signal)) deletedAgentSessionRecord(id)
        await archiveCapturedOriginal(path, imported.sha256);
      }
      await this.enqueue(async () => {
        this.assertRecordReadable(this.db, id)

        if (capturedStream(this.db, id)?.state === 'ready') {
          this.dirty = true;
          return;
        }
        if (await capturedFileWitness(path) !== witness)
          throw new AgentMuxError('Original captured source changed before its handover ACK.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED');
        const row = capturedStream(this.db, id)!;
        readyCapturedStream(this.db, id, witness, row.revision, gaps);
        this.dirty = true;
      }, signal, id);
      return [];
    })();
    this.capturedPreparations.set(id, work);
    try {
      return await work;
    }
    finally {
      if (this.capturedPreparations.get(id) === work)
        this.capturedPreparations.delete(id);
    }
  }

  async readInputConversationProjection(id: string, after = ''): Promise<ReturnType<typeof readCapturedInputProjection>> {
    await this.timelineTails.get(id); await this.sessionWrites(id)
    await this.prepareCapturedHistory(id)
    return this.withCapturedRead(db => { this.assertRecordReadable(db, id); return readCapturedInputProjection(db, id, after) })
  }
  async recordInputConversationProjection(id: string, cut: import('./agent-input-conversation.js').AgentInputJournalCut): Promise<void> {
    await this.prepareCapturedHistory(id)
    await this.enqueue(async () => { this.assertRecordReadable(this.db, id); writeCapturedInputProjection(this.db, id, cut); this.dirty = true }, undefined, id)
  }

  async readCapturedHistory(agentSessionId: string, input: AgentCapturedTimelineRead = {}): Promise<AgentCapturedTimelinePage> {
    await this.timelineTails.get(agentSessionId);
    await this.sessionWrites(agentSessionId);
    const observedGaps = await this.prepareCapturedHistory(agentSessionId);
    const page = await this.withCapturedRead(db => { this.assertRecordReadable(db, agentSessionId); return readCapturedPage(db, agentSessionId, input) });
    page.stream.gaps.push(...observedGaps);
    return page;
  }

  async loadTimeline(agentSessionId: string): Promise<AgentTimelineSnapshot> {
    await this.timelineTails.get(agentSessionId);
    await this.sessionWrites(agentSessionId);
    let observedGaps: AgentCapturedTimelinePage['stream']['gaps'];
    try { observedGaps = await this.prepareCapturedHistory(agentSessionId); }
    catch (error) {
      if (error instanceof AgentMuxError && error.code === 'UNKNOWN_AGENT_SESSION') return { agentSessionId, revision: 0, items: [] };
      throw error;
    }
    const snapshot = await this.withCapturedRead(db => { this.assertRecordReadable(db, agentSessionId); return readRecentCaptured(db, agentSessionId) });
    snapshot.stream!.gaps.push(...observedGaps);
    return snapshot;
  }

  async applyTimelineMutation(mutation: AgentTimelineMutation, signal?: AbortSignal): Promise<AgentTimelineCommit> {
    const canonicalMutation = normalizeAgentTimelineMutation(mutation), id = canonicalMutation.agentSessionId;
    const current = (this.timelineTails.get(id) ?? Promise.resolve()).then(async () => {
      await this.prepareCapturedHistory(id, signal);
      let result!: AgentTimelineCommit;
      await this.enqueue(async () => {
        if (!await this.timelineMutationAllowed(canonicalMutation, signal))
          throw new AgentMuxError(`Unknown Agent Session: ${id}`, 'UNKNOWN_AGENT_SESSION');
        result = commitCapturedMutation(this.db, canonicalMutation);
        // Replaying the same original record also confirms a previous lost sync ACK.
        // This does not add a version, move its position or publish a new event.
        this.dirty = true;
      }, signal, id);
      return structuredClone(result);
    });
    const settled = current.then(() => { }, () => { });
    this.timelineTails.set(id, settled);
    void settled.then(() => { if (this.timelineTails.get(id) === settled)
      this.timelineTails.delete(id); });
    return await current;
  }

  private async withReadDatabase<T>(read: (db: DatabaseSync) => T,
    rescue: (document: AgentSessionStoreDocument) => T, signal?: AbortSignal, committedOnly: boolean | 'observation' = false): Promise<T> {
    signal?.throwIfAborted()
    if (this.database && !committedOnly) return read(this.database)
    let db: DatabaseSync | null = null
    let failure: unknown
    try {
      db = committedOnly === 'observation' ? await readCurrentSessionDatabase(this.path, { readOnly: true }) : await whileBusy(() => readCurrentSessionDatabase(this.path), signal)
      signal?.throwIfAborted()
      if (!db) {
        // Metrics never initialize, convert, salvage or repair original user data.
        if (committedOnly === 'observation') throw new AgentMuxError('The original committed Agent Store is unavailable for observation.', 'AGENT_RESOURCE_UNAVAILABLE')
        let raw: Buffer | undefined
        try { raw = await readFile(this.path, signal ? { signal } : undefined) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (raw) {
          signal?.throwIfAborted()
          try { this.strictOriginalDocument(raw) } catch {
            // Damaged original bytes remain the original rescue source. A partial salvage is
            // readable, observable and never published as a successful physical conversion.
            const document = await this.parseStoreDocument(raw)
            signal?.throwIfAborted()
            return rescue(document)
          }
        }
        signal?.throwIfAborted()
        await this.enqueue(async () => {}, signal)
        db = await whileBusy(() => readCurrentSessionDatabase(this.path), signal)
        signal?.throwIfAborted()
        if (!db) throw new AgentMuxError('Session persistence identity is unconfirmed; retry the original read.', 'AGENT_SESSION_STORE_READ_UNCONFIRMED')
      }
      const reader = db
      const consume = () => {
        try { reader.exec('BEGIN'); const result = read(reader); reader.exec('COMMIT'); return result }
        catch (error) {
          try { if (reader.isTransaction) reader.exec('ROLLBACK') }
          catch (cleanup) { throw sessionStorageFailure(error, 'read', [cleanup]) }
          throw error
        }
      }
      // A busy writer makes only this optional count unavailable, never a wait on its queue.
      return committedOnly === 'observation' ? consume() : await whileBusy(consume, signal)
    } catch (error) {
      failure = signal?.aborted ? signal.reason : sessionStorageFailure(error, 'read')
      throw failure
    }
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
    this.assertRecordReadable(db, value.agentSessionId)

    const row = db.prepare('SELECT json FROM prompt_admissions WHERE session_id=? AND run_id=? AND record_id=?')
      .get(value.agentSessionId, value.run.runId, promptRecordId(value))
    const original = row ? JSON.parse(String(row.json)) as AgentPromptSubmissionRecord : undefined
    if (isDeepStrictEqual(original, value)) return
    assertPromptRecordWrite(original, value, receipt)
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
    const submission = session.terminalPromptSubmission?.submissionId
    if (submission && db.prepare("SELECT 1 FROM sessions WHERE json_extract(json,'$.terminalPromptSubmission.submissionId')=? AND id<>?").get(submission, id)) {
      throw new AgentMuxError('Agent Session store contains a duplicate prompt operation.', 'INVALID_AGENT_SESSION_STORE')
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


  /** One-time physical import of an original JSON document into a fresh database; never a lifecycle write. */
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

  private timelinePath(agentSessionId: string): string {
    const filename = createHash('sha256').update(agentSessionId).digest('base64url');
    return join(dirname(this.path), 'agent-timelines', `${filename}.jsonl`);
  }

  private async enqueue(operation: () => Promise<void>, signal?: AbortSignal, sessionId?: string | typeof CROSS_SESSION_WRITE,
    settlement?: MetadataTimelineSettlement): Promise<void> {
    const current = this.tail.then(async () => {
      signal?.throwIfAborted()
      if (this.pendingLockRelease) {
        // Retry cleanup of the same owned handle in-band. A prior close error is not a permanent
        // sentence for a healthy Store, nor permission to unlock another writer's inode.
        await this.pendingLockRelease()
        this.pendingLockRelease = null
      }
      const release = await this.acquireLock(signal)
      let committed = false, began = false, commitAttempted = false
      let failure: unknown
      let stage = 'open'
      try {
        this.database = await openSessionDatabase(this.path, (db, raw) => this.writeDocument(db, this.strictOriginalDocument(raw)))
        this.dirty = false
        stage = 'begin'; this.db.exec('BEGIN IMMEDIATE'); began = true
        // Existing validated databases acquire the same owner's internal table
        // in this transaction; absence never means an old input was unapplied.
        if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='prompt_admissions'").get()) {
          this.db.exec(promptAdmissionSchema); this.dirty = true
        }
        if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='retired_creation_operation'").get()) {
          this.db.exec(retiredCreationIndexSchema); this.dirty = true
        }
        if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='terminal_prompt_submission'").get()) {
          this.db.exec(promptSubmissionIndexSchema); this.dirty = true
        }
        if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='captured_streams'").get()) { this.db.exec(capturedHistorySchema); this.dirty=true }
        stage = 'mutation'
        await operation()
        signal?.throwIfAborted()
        stage = 'commit'; await this.commit(signal, () => { commitAttempted = true }); committed = true
        if (this.dirty) {
          try { await syncSessionDatabase(this.path) } catch (error) { throw new AgentMuxSessionDurabilityError(error) }
        }
      } catch (error) {
        // A failed SQLite COMMIT can leave the old transaction active (known rollback), or
        // an uncertain durable outcome. Neither proves Native input was not applied.
        failure = commitAttempted && !committed && this.database && !this.database.isTransaction && this.dirty
          ? new AgentMuxSessionDurabilityError(error, 'unknown') : sessionStorageFailure(error, stage, [], signal?.aborted && error === signal.reason)
        throw failure
      } finally {
        const cleanup: unknown[] = [], database = this.database
        let rolledBack = began && stage === 'mutation' && !commitAttempted && !!database && !database.isTransaction
        try {
          if (database?.isTransaction) {
            database.exec('ROLLBACK')
            rolledBack = began && stage === 'mutation' && !commitAttempted
          }
        } catch (error) { rolledBack = false; cleanup.push(error) }
        let closed = false
        try { database?.close(); closed = true } catch (error) { cleanup.push(error) }
        this.database = undefined
        const finishRelease = async () => { if (!closed) { database?.close(); closed = true }; await release() }
        let released = false
        await finishRelease().then(() => { released = true }, error => {
            if (settlement) settlement.releaseFailure = error
            const failure = new AgentMuxError('Agent Session store lock cleanup is unconfirmed; retry the same operation to release its original handle.',
              'AGENT_SESSION_STORE_LOCK_RELEASE_FAILED', error instanceof Error ? error.message : String(error))
            this.pendingLockRelease = finishRelease; process.emitWarning(failure.message, { code: failure.code })
        })
        if (settlement) settlement.rolledBackCleanly = rolledBack && closed && released
        if (cleanup.length) {
          if (failure !== undefined) throw sessionStorageFailure(failure, stage, cleanup, signal?.aborted && failure === signal.reason)
          if (committed) throw new AgentMuxSessionDurabilityError(sessionStorageFailure(cleanup[0], 'close', cleanup.slice(1)))
          throw sessionStorageFailure(cleanup[0], 'close', cleanup.slice(1))
        }
      }
    })
    const settled = current.then(() => {}, () => {})
    this.tail = settled
    if (sessionId === CROSS_SESSION_WRITE) this.crossSessionWriteTail = settled
    else if (sessionId !== undefined) {
      this.sessionWriteTails.set(sessionId, settled)
      void settled.then(() => {
        if (this.sessionWriteTails.get(sessionId) === settled) this.sessionWriteTails.delete(sessionId)
      })
    }
    await current
  }

  private async commit(signal?: AbortSignal, onAttempt?: () => void): Promise<void> {
    const database = this.db
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted()
      try {
        onAttempt?.()
        database.exec('COMMIT')
        return
      } catch (error) {
        // A rollback-journal reader can briefly prevent COMMIT. SQLite keeps
        // this transaction active: yield for that reader, never replay mutation.
        if (!sqliteBusy(error) || !database.isTransaction || attempt + 1 >= LOCK_ATTEMPTS) throw error
        await delay(LOCK_RETRY_MIN_MS + Math.random() * LOCK_RETRY_JITTER_MS, signal)
        signal?.throwIfAborted()
        if (!database.isTransaction) throw error
      }
    }
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
