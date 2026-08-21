import { AgentMuxError } from './errors.js'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { defaultAgentMuxRuntimeDirectory } from './runtime-paths.js'
import { durableWriteFile } from './durable-write.js'
import { normalizeAgentInteractionResponse } from './agent-interaction.js'
import { canonicalHookLifecycleEvent } from './agent-hook-event.js'
import { isPermissionOptionKind, isPromptDeliveryDegradedReason, RISK_TIERS } from './types.js'
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
  AgentTerminalOutputChannelState,
  AgentTerminalPromptReadinessSource,
  AgentTimelineCommit,
  AgentTimelineItem,
  AgentTimelineMutation,
  AgentTimelineSnapshot,
  AgentTurnUsage,
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
const MAX_TIMELINE_STORE_BYTES = 8 * 1024 * 1024
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
// `open(path, 'wx')` and the following owner write are two syscalls. If the process dies between them,
// contenders can observe an empty lock. Keep a just-created owner-less lock for a short grace window so
// a healthy acquirer that is still writing its PID cannot be mistaken for a dead owner; after that window
// the lock is stale because no valid owner could have been recorded.
const LOCK_OWNER_WRITE_GRACE_MS = 250

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
  if (outputCursorBytes !== undefined && canonicalHookLifecycleEvent(eventName) !== 'turn-end') {
    throw new AgentMuxError(
      'Only native turn-end receipts may carry an authoritative output cursor.',
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
const TERMINAL_PROMPT_READINESS_SOURCE_MEMBERS: Record<AgentTerminalPromptReadinessSource, true> = {
  'initial-composer': true,
  'native-stop': true
}
const TERMINAL_PROMPT_READINESS_SOURCES = Object.keys(
  TERMINAL_PROMPT_READINESS_SOURCE_MEMBERS
) as readonly AgentTerminalPromptReadinessSource[]

function terminalPromptReadinessSource(
  value: unknown,
  name: string
): AgentTerminalPromptReadinessSource {
  if (!TERMINAL_PROMPT_READINESS_SOURCES.includes(value as AgentTerminalPromptReadinessSource)) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value as AgentTerminalPromptReadinessSource
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
    ...(source.readinessEvidence === undefined ? {} : { readinessEvidence: (() => {
      const evidence = record(source.readinessEvidence, 'terminalPromptSubmission.readinessEvidence')
      return {
        source: terminalPromptReadinessSource(evidence.source, 'readinessEvidence.source'),
        id: string(evidence.id, 'readinessEvidence.id'),
        outputCursorBytes: timestamp(evidence.outputCursorBytes, 'readinessEvidence.outputCursorBytes'),
        readyThroughByte: timestamp(evidence.readyThroughByte, 'readinessEvidence.readyThroughByte')
      }
    })() }),
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
    ...(source.promptCompletionAdmission === undefined ? {} : { promptCompletionAdmission: (() => {
      const admission = record(source.promptCompletionAdmission, 'promptCompletionAdmission')
      const startByte = timestamp(admission.startByte, 'promptCompletionAdmission.startByte')
      const endByte = positiveInteger(admission.endByte, 'promptCompletionAdmission.endByte')
      if (endByte <= startByte) throw new AgentMuxError('Invalid prompt input range.', 'INVALID_AGENT_SESSION_STORE')
      return {
        ...(admission.submissionId === undefined ? {} : { submissionId: string(admission.submissionId, 'promptCompletionAdmission.submissionId') }),
        ...(admission.completionId === undefined ? {} : { completionId: string(admission.completionId, 'promptCompletionAdmission.completionId') }),
        operationId: string(admission.operationId, 'promptCompletionAdmission.operationId'), startByte, endByte }
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
    ...(source.hookReceipt === undefined ? {} : { hookReceipt: hookReceipt(source.hookReceipt) }),
    ...(source.turnUsage === undefined ? {} : { turnUsage: turnUsage(source.turnUsage) })
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
  /** 已报过的抢救事件（键是隔离文件的内容寻址路径），防同一份坏字节在一次加载里刷多条告警。 */
  private readonly reportedSalvages = new Set<string>()

  constructor(readonly path = defaultAgentMuxAgentSessionStorePath()) {}

  async load(): Promise<readonly unknown[]> {
    // Loading is a read path.  Taking the writer lock here solely to sweep orphan Timeline files
    // made every short-lived CLI (`list`, `inspect`, `output`) contend with the Desktop's high-rate
    // semantic-status writes, so a lifecycle create could exhaust its retry budget without another
    // writer ever being stuck.  Read the atomically-replaced document first, then make cleanup an
    // opportunistic sidecar: if a writer currently owns the lock, leave the orphan for a later load.
    await this.tail
    const document = await this.read()
    const result = document.sessions.map((session) => structuredClone(session))
    await this.sweepOrphanTimelines()
    return result
  }

  private async sweepOrphanTimelines(): Promise<void> {
    let release: (() => Promise<void>) | null = null
    try {
      // One attempt is deliberate: cleanup is maintenance, never a reason to block a read caller.
      release = await this.acquireLock(undefined, 1)
      const document = await this.read()
      await this.removeOrphanTimelineFiles(document.sessions)
    } catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'AGENT_SESSION_STORE_BUSY') throw error
    } finally {
      await release?.()
    }
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
   * 不同内容的损坏会各自留一份 sidecar，每份最多 MAX_STORE_BYTES(1 MiB)，既不回收也无总量上限。
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

  private async acquireLock(
    signal?: AbortSignal,
    attempts = LOCK_ATTEMPTS
  ): Promise<() => Promise<void>> {
    const path = `${this.path}.lock`
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < attempts; attempt += 1) {
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
        await delay(LOCK_RETRY_MIN_MS + Math.random() * LOCK_RETRY_JITTER_MS, signal)
      }
    }
    throw new AgentMuxError('Agent Session store is busy.', 'AGENT_SESSION_STORE_BUSY')
  }

  private async removeDeadOwnerLock(path: string): Promise<void> {
    let content: string
    try {
      content = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return
    }

    const firstToken = content.trim().split(/\s+/u)[0]
    const pid = Number(firstToken)
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      // An empty/malformed lock has no owner to probe. It is only reclaimable once the two-syscall
      // acquisition grace period has elapsed; otherwise the original acquirer may still be writing.
      let metadata
      try {
        metadata = await stat(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return
      }
      if (Date.now() - metadata.mtimeMs < LOCK_OWNER_WRITE_GRACE_MS) return
    } else {
      try {
        process.kill(pid, 0)
        // The owner is alive; never reclaim its lock. Keep waiting for the owner to release it.
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return
      }
    }

    // Re-read before unlinking so a contender that already replaced the observed bytes is not removed.
    // The unlink still remains best-effort: another contender may win the race first.
    try {
      if (await readFile(path, 'utf8') !== content) return
      await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
