import { parseAgentInformationSnapshot } from './agent-information.js'
import { parseAgentConfigurationSnapshot } from './agent-configuration.js'
import { parseInputRestoration } from './agent-input-epoch.js'
import { parseGoalApprovalAttribution } from './goal-approval.js'
import { parseAgentMuxCreationOrigin } from './agent-creation-admission.js'
import { parseCreationResolution } from './agent-creation-resolution.js'
import { parseAgentForkSource } from './agent-fork.js'
import { isAgentHookLifecycleEvent, canonicalHookLifecycleEvent } from './agent-hook-event.js'
import { normalizeAgentInteractionResponse } from './agent-interaction.js'
import { normalizeNativeSessionId, normalizeNativeTranscriptPath } from './agent-native-locator.js'
import { validateAgentPromptInputKey, agentPromptInputId, optionalInputEpoch } from './agent-prompt-condition.js'
import { normalizeAgentContinuityOperation } from './agent-session-recovery/continuity-contract.js'
import { parseAgentContinuityControlReceipts } from './agent-session-recovery/control-contract.js'
import { parseAgentSpawnCreator } from './agent-spawn.js'
import { parseNativeSubagents } from './agent-subagent-state.js'
import { parseAgentTakeoverProvenance } from './agent-takeover.js'
import { parseAgentToolExecutionBinding } from './agent-tool-execution.js'
import { parseAutomaticInputSource } from './automatic-input-source.js'
import { AgentMuxError } from './errors.js'
import { parseAgentExternalInteractionAuthor } from './external-author.js'
import { normalizeOperationDevice } from './operation-device.js'
import { normalizePromptCompletionAdmission, MAX_STORED_TEXT_BYTES, terminalPromptSubmission, terminalPromptReadinessSource } from './prompt-submission-record.js'
import { type AgentSessionHistoryMetadata, type AgentMuxInteractionRequest, isPermissionOptionKind, RISK_TIERS, type RiskTier, type AgentMuxAgentSession, type AgentNativeSessionHandle, type AgentMuxInteractionOperationReceipt, type AgentMuxEvidence, type AgentMuxInteractionResponse, type AgentMuxRunRef, type AgentMuxStoredAgentSession, type AgentTerminalCapabilityState, type AgentTerminalPromptDeliveryState, isPromptDeliveryDegradedReason, type AgentTerminalOutputChannelState, type AgentStatus, type AgentMuxPendingInteraction, type AgentNativeSessionConfirmationReceipt, type AgentHookReceipt, type AgentTurnUsage } from './types.js'
import { parseWorkspaceTrustPreparation } from './workspace-trust-preparation.js'
import { parseCumulativeUsage } from './agent-cumulative-usage.js'
import { agentLifecycleOperationIdentity } from './agent-session-identity.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64urlnopad } from '@scure/base'
import { dequal } from 'dequal'
import { rpcRecord } from './rpc-data.js'
import { parseTerminalFrontend } from './agent-terminal-frontend.js'
const codecEncoder = new TextEncoder()

export const MAX_ID_BYTES = 512

export const MAX_PATH_BYTES = 16 * 1024

export function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError(`${name} must be an object.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value as Record<string, unknown>
}

export function string(value: unknown, name: string, maxBytes = MAX_ID_BYTES): string {
  if (typeof value !== 'string' || !value.trim() || codecEncoder.encode(value).byteLength > maxBytes || /[\0\r\n]/.test(value)) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value
}

function text(value: unknown, name: string, maxBytes = MAX_PATH_BYTES): string {
  if (typeof value !== 'string' || !value.trim() || codecEncoder.encode(value).byteLength > maxBytes || value.includes('\0')) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value
}

export function timestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value as number
}

export function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_SESSION_STORE')
  }
  return value as number
}

export function runRef(value: unknown): AgentMuxRunRef {
  const source = record(value, 'run')
  if (Object.keys(source).length !== 1 || !Object.hasOwn(source, 'runId')) {
    throw new AgentMuxError('run must contain only runId.', 'INVALID_AGENT_SESSION_STORE')
  }
  return {
    runId: string(source.runId, 'run.runId')
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
    ...optionalInputEpoch(source.inputEpoch),
    ...(source.inputRestoration === undefined ? {} : { inputRestoration: parseInputRestoration(source.inputRestoration,source.inputEpoch) }),
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

export function launchOptionSelection(value: unknown): Record<string, string> {
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

export function nativeHandle(value: unknown): AgentNativeSessionHandle {
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
  if (invocation && (typeof invocation.toolInput !== 'string' || codecEncoder.encode(invocation.toolInput).byteLength > MAX_STORED_TEXT_BYTES)) {
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
    ...(source.evidenceRevision === undefined ? {} : { evidenceRevision: positiveInteger(source.evidenceRevision, 'semanticStatus.evidenceRevision') }),
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
    if (source.acpBindingId !== undefined) evidence.acpBindingId = string(source.acpBindingId, 'pendingInteraction.request.evidence.acpBindingId')
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
        codecEncoder.encode(toolInput).byteLength > MAX_PATH_BYTES || toolInput.includes('\0'))) {
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
        if (value.kind !== 'permission' || responseDigest !== base64urlnopad.encode(sha256(codecEncoder.encode(JSON.stringify(value)))) ||
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
  const expectedDigest = base64urlnopad.encode(sha256(codecEncoder.encode(JSON.stringify(responseValue))))
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
export function nativeConfirmation(value: unknown): AgentNativeSessionConfirmationReceipt {
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

export function nativeConfirmationMatchesSession(confirmation: AgentNativeSessionConfirmationReceipt,
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
  return { ...optionalInputEpoch(creation.inputEpoch), ...(creation.inputRuntimeId === undefined ? {} : { inputRuntimeId: string(creation.inputRuntimeId, 'creation.inputRuntimeId') }), createOperationId: string(creation.createOperationId, 'creation.createOperationId'), initialPrompt: initialPrompt as NonNullable<AgentMuxAgentSession['creation']>['initialPrompt'],
    ...(creation.resolution === undefined ? {} : { resolution: parseCreationResolution(creation.resolution) }),
    ...(creation.workspaceTrust === undefined ? {} : { workspaceTrust: parseWorkspaceTrustPreparation(creation.workspaceTrust) }),
    ...(creation.spatialIntent === undefined ? {} : { spatialIntent: parseAgentCreationSpatialIntent(creation.spatialIntent) }),
    ...(creation.takeover === undefined ? {} : { takeover: parseAgentTakeoverProvenance(creation.takeover) }),
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

export function normalizeAgentSession(value: unknown): AgentMuxAgentSession {
  const source = record(value, 'Agent Session')
  if (source.kind !== 'agent') {
    throw new AgentMuxError('Only Agent Sessions may be persisted.', 'INVALID_AGENT_SESSION_STORE')
  }
  const currentRun = runRef(source.run)
  const priorRuns = retiredRuns(source.retiredRuns, currentRun)
  const session: AgentMuxAgentSession = {
    kind: 'agent',
    ...optionalInputEpoch(source.inputEpoch),
    ...(source.inputRestoration === undefined ? {} : { inputRestoration: parseInputRestoration(source.inputRestoration,source.inputEpoch) }),
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
        return [id, { ...optionalInputEpoch(intent.inputEpoch), ...(intent.continuitySource === undefined ? {} : { continuitySource: parseAutomaticInputSource(intent.continuitySource) }), operationId: string(intent.operationId, 'future intent operation'), prompt: text(intent.prompt, 'future prompt', MAX_STORED_TEXT_BYTES), active: intent.active,
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
  const resolution = session.creation?.resolution
  if (resolution && (resolution.outcome !== 'retained' || resolution.agentSessionId !== session.agentSessionId ||
      resolution.createOperationId !== session.creation?.createOperationId || !session.creation.createdRun ||
      resolution.retainedRun.runId !== session.creation.createdRun.runId ||
      resolution.originalCreationKey !== agentLifecycleOperationIdentity('create', session.agentSessionId, resolution.createOperationId))) throw new AgentMuxError('The original creation resolution changed its Session or first Run.', 'INVALID_AGENT_SESSION_STORE')
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
  if (Object.keys(source).some(key => !['operationId', 'agentSessionId', 'run', 'expectedRequest', 'response', 'delivery', 'inputByteRange', 'nativeAdoption', 'nativeHandle', 'nativeCompleted', 'externalAction', 'authorHuman', 'moteObservationId', 'goalApproval'].includes(key)) || source.authorHuman !== undefined && source.authorHuman !== true || expectedRequest.agentSessionId !== agentSessionId || expectedRequest.evidence.run?.runId !== run.runId) throw new AgentMuxError('Interaction operation target mismatch.', 'INVALID_AGENT_SESSION_STORE')
  const goalApproval = source.goalApproval === undefined ? undefined : parseGoalApprovalAttribution(source.goalApproval)
  if (goalApproval && (expectedRequest.kind !== 'permission' || source.externalAction !== undefined ||
      goalApproval.inputKey.agentSessionId !== agentSessionId || goalApproval.inputKey.expectedRun.runId !== run.runId ||
      goalApproval.inputKey.submissionId !== goalApproval.dispatchOperationId)) throw new AgentMuxError('Approval attribution targets another original input.', 'INVALID_AGENT_SESSION_STORE')
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
    ...(goalApproval ? { goalApproval } : {}),
    ...(source.moteObservationId === undefined ? {} : {moteObservationId:string(source.moteObservationId,'Mote input observation')}),
    expectedRequest, response: interactionResponse(source.response, expectedRequest),
    ...(source.externalAction === undefined ? {} : { externalAction: parseAgentExternalInteractionAuthor(source.externalAction) }),
    delivery: delivery as AgentMuxInteractionOperationReceipt['delivery'], nativeAdoption: 'unknown',
    ...(inputByteRange ? { inputByteRange } : {}),
    ...(source.nativeHandle === undefined ? {} : { nativeHandle: nativeHandle(source.nativeHandle) }),
    ...(nativeCompleted === undefined ? {} : { nativeCompleted }) }
}

export function parseRpcAgentSession(value: unknown): ReturnType<typeof normalizeAgentSession> {
  // Preserve the wire grammar independently from the durable-store field grammar.
  const fail = (): never => { throw new AgentMuxError('Core RPC result is malformed or belongs to another object.', 'CONTROL_PROTOCOL_ERROR') }
  const record = (value: unknown, fields?: readonly string[]) => rpcRecord(value, fields, 'CONTROL_PROTOCOL_ERROR')
  function string(value: unknown): void { if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)) fail() }
  function text(value: unknown): void { if (typeof value !== 'string') fail() }
  function count(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0) fail() }
  function member(value: unknown, values: readonly unknown[]): void { if (!values.includes(value)) fail() }
  function runRef(value: unknown): Record<string, unknown> { const run = record(value, ['runId']); string(run.runId); return run }
  const source = record(value)
  if (Object.hasOwn(source, 'hookBindingId') || Object.hasOwn(source, 'hookToken') || Object.hasOwn(source, 'nativeActor') || Object.hasOwn(source, 'initialInput') || Object.hasOwn(source, 'executorInvocation')) fail()
  try {
    const session = normalizeAgentSession(source)
    if (source.nativeConfiguration !== undefined) session.nativeConfiguration = parseAgentConfigurationSnapshot(source.nativeConfiguration)
    if (source.nativeInformation !== undefined) {
      const information = parseAgentInformationSnapshot(source.nativeInformation)
      if (session.nativeHandle?.kind !== 'provider' || information.nativeSessionId !== session.nativeHandle.sessionId) fail()
      session.nativeInformation = information
    }
    if (source.terminalFrontend !== undefined) session.terminalFrontend = parseTerminalFrontend(source.terminalFrontend, session.run)
    if (source.turnUsage !== undefined) {
      const usage = record(source.turnUsage)
      if (usage.cumulative !== undefined && !dequal(usage.cumulative, session.turnUsage?.cumulative)) fail()
    }
    if (source.nativeHandlePersistence !== undefined) {
      if (!session.nativeHandle) fail()
      member(source.nativeHandlePersistence, ['confirmed', 'unconfirmed'])
      session.nativeHandlePersistence = source.nativeHandlePersistence as 'confirmed' | 'unconfirmed'
    }
    if (source.hookDeliveryObservation !== undefined) {
      // One live delivery loss of this exact Run; a loss of another Run is not this Session's fact.
      const loss = record(source.hookDeliveryObservation, ['run', 'since', 'accepted', 'code', 'reason'])
      if (runRef(loss.run).runId !== session.run.runId || (loss.accepted !== false && loss.accepted !== 'unknown')) fail()
      count(loss.since); string(loss.code); if (loss.reason !== undefined) text(loss.reason)
      session.hookDeliveryObservation = structuredClone(loss) as NonNullable<typeof session.hookDeliveryObservation>
    }
    for (const field of ['currentActivity', 'mainSessionActivity'] as const) if (source[field] !== undefined) {
      const activity = record(source[field], ['state', 'source', 'run', 'nativeSessionId', 'nativeTurnId',
        'sourceId', 'sequence', 'hookReceiptId', 'observedAt', 'interruption', 'mainState', 'evidenceRevision'])
      member(activity.state, ['active', 'idle', 'unknown']); member(activity.source, ['native-hook'])
      if (activity.mainState !== undefined) member(activity.mainState, ['active', 'idle', 'unknown'])
      if (runRef(activity.run).runId !== session.run.runId || session.nativeHandle?.kind !== 'provider' ||
          activity.nativeSessionId !== session.nativeHandle.sessionId) fail()
      for (const key of ['nativeSessionId', 'sourceId', 'hookReceiptId']) string(activity[key])
      if (activity.state !== 'unknown' || activity.nativeTurnId !== undefined) string(activity.nativeTurnId)
      count(activity.sequence); if (activity.sequence === 0) fail(); count(activity.observedAt)
      if (activity.evidenceRevision !== undefined) { count(activity.evidenceRevision); if (activity.evidenceRevision === 0) fail() }
      if (activity.interruption !== undefined) {
        if (activity.state !== 'idle') fail()
        member(activity.interruption, ['interrupted', 'not-interrupted'])
      }
      session[field] = structuredClone(activity) as NonNullable<typeof session.currentActivity>
    }
    return session
  } catch { return fail() }
}
