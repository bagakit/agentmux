import { parseGoalParticipationConfirm } from './goal-participation.js'
import { isAgentProgressMethod, parseAgentProgressParams, parseAgentProgressResult } from './agent-progress.js'
import { parseAgentAutomationTarget, parseAgentAutomationInspection } from './agent-automation.js'
import { isMobileAssetsMethod, parseMobileAssetsParams, parseMobileAssetsResult, parseMobileWebReportParams, parseMobileWebReportReceipt } from './mobile-web-codec.js'
import { parseExternalConversationReceipt } from './external-conversation.js'
import { isAgentLearningMethod, parseAgentLearningParams, parseAgentLearningResult } from './agent-learning.js'
import { isMoteChatMethod, parseMoteChatParams, parseMoteChatResult } from './mote-chat-codec.js'
import { parseCapsuleInputRequest, parseCapsuleInputResult } from './capsule-input.js'
import { isCapsuleMethod, parseCapsuleRpcParams, parseCapsuleRpcResult } from './capsule.js'
import { isCapsuleRuntimeMethod, parseCapsuleRuntimeResult } from './capsule-runtime.js'
import { parseFileImportParams, parseFileImportResult } from './public-rpc-file-import.js'
import { parseBroadcastReceipt, normalizeBroadcastInput } from './agent-message-broadcast.js'
import { parseMessageEventsPage } from './agent-message-events.js'
import { parseAgentInputContextCaptureReference, parseAgentInputContextCaptureRead } from './agent-input-context-capture.js'
import { isMessageNotificationInput, validateMessageNotification } from './agent-message-notification.js'
import { agentDiscoveryActivity } from './agent-discovery.js'
import { parseTerminalFrontend } from './agent-terminal-frontend.js'
import { noteContentInCatalogScope } from './notebook-observation.js'
import { parseFileShareParams, parseFileShareResult, parseFileShareInspectParams, parseFileShareInspectResult, parseFileShareUndoParams, parseFileShareUndoResult } from './public-rpc-file-share.js'
import { isApplicationAccessMethod, parseApplicationAccessParams, parseApplicationAccessResult } from './application-access.js'
import { parseAgentInputMailboxPage } from './agent-input-mailbox-codec.js'
import { parseRuntimeDiagnostics } from './runtime-observation-codec.js'
import { parseRuntimeNetworkSnapshot } from './runtime-network.js'
import { parseAgentContinuityControlInput, parseAgentContinuityControlResult } from './agent-session-recovery/control-contract.js'
import { parseConversationLandmarkPage, parseConversationLandmarkQuery, parseConversationLandmarkWritePage, parseConversationLandmarkWrite } from './conversation-landmarks.js'
import { isMoteConnectionMethod, parseMoteConnectionParams, parseMoteConnectionResult } from './mote-connection-codec.js'
import { parseConversationViewReleaseResult, parseConversationCheckpointPage, parseConversationChangesPage, parseConversationWatchOpening } from './conversation-changes.js'
import { parseAgentMuxSearchInput, parseAgentMuxSearchPage } from './search-codec.js'
import { isConnectionMethod, parseConnectionParams, parseConnectionResult } from './connections-codec.js'
import { parseConversationReadPage } from './conversation.js'
import { parsePromptSubmissionRecord } from './prompt-submission-record.js'
import { parseAgentInputSubmissionReceipt as inputReceipt } from './agent-input-receipt-codec.js'
import { isGoalDelegationMethod } from './goal-delegation-methods.js'
import { parseGoalDelegationParams, parseGoalDelegationResult } from './goal-delegation.js'
import { isMoteAvatarWriteMethod, parseMoteAvatarWriteParams, parseMoteAvatarWriteResult } from './mote-avatar-write.js'
import { isMoteAvatarSeriesMethod, parseMoteAvatarSeriesParams, parseMoteAvatarSeriesResult } from './mote-avatar-series.js'
import { parseDiagnosticEvidenceResult } from './diagnostic-evidence-codec.js'
import { parseControlEndpointState } from './control-endpoint-state.js'
import { parseNotesStorageOperation } from './notes-storage.js'
import { noteProvenanceResourceKey } from './note-provenance.js'
import type { NoteResource } from './notebook-catalog.js'
import { parseControlDemandActivity } from './control-codec.js'
import { parseDeliveryAttemptLookup, parseDeliveryFailure } from './delivery-attempt.js'
import { validateAgentInputWaitRef, type AgentInputSubmissionReceipt } from './agent-input-wait.js'

import { parseFileUploadIdentity, parseFileUploadParams, parseFileUploadResult } from './public-rpc-files.js';

import { isDeepStrictEqual } from 'node:util'
import { parseAgentMuxSpatialGraph } from './spatial-graph.js'
import { normalizeAgentTimelineMutation } from './session-timeline.js'
import { normalizeSessionHistoryPage, sessionHistoryWithoutMetrics } from './session-history.js'
import { parseAgentContextParams } from './agent-context.js'
import { parseConnectionOffer } from '@agentmux/relay/offer'
import { normalizeMessageChannel } from './message-origin.js'
import { normalizeOperationDevice } from './operation-device.js'
import { parseNotebookGraph, parseNoteContentObservation, parseNotebookObservationParams } from './notebook-observation.js'
import { parseNoteTitleInspection } from './note-title.js'
import { parseNoteCorpusParams, parseNoteCorpusResult } from './note-corpus.js'
import { parseNotebookResolveParams, parseNotebookResolveResult } from './note-links.js'
import { inspectNotebook, notebookFingerprint, parseNotebookState } from './notebook-catalog.js'
import { isTopicMethod, parseTopicParams, parseTopicResult } from './public-rpc-topics.js'
import { isFileMethod, parseFileHistoryParams, parseFileHistoryResult, parseFileCreateParams, parseFileCreateResult, parseFileWriteParams, parseFileWriteResult, parseFileRestoreParams, parseFileRestoreResult, parseFileUndoParams, parseFileUndoResult, parseFileReadParams, parseFileReadResult, parseFileListParams, parseFileListResult } from './public-rpc-files.js'
import { isGitMethod, parseGitParams, parseGitResult } from './public-rpc-git.js'
import { isAppWindowMethod, parseAppWindowPage, parseAppWindowParams } from './public-rpc-windows.js'
import { isScheduleMethod, parseScheduleRpcParams, validateScheduleRpcResult } from './public-rpc-schedules.js'
import { isNativeDesktopMethod, parseNativeDesktopParams, parseNativeDesktopResult } from './public-rpc-native-desktop.js'
import { parseAgentNativeSessionConfirmation } from './agent-native-session-confirmation.js'
import { parseAgentNativeResumeSource } from './agent-native-sessions.js'
import { parseNativeHistoryParams, parseNativeHistoryResult, parseNativeHistoryResourceParams, parseNativeHistoryResourceResult } from './public-rpc-native-history.js'
import { parseNameChangeRecord } from './display-label.js'
import { AgentMuxError, parseAgentMuxStorageFailure } from './errors.js'
import { parseAgentSessionHistoryReadPage, type AgentSessionHistoryReadInput } from './session-history-reader.js'
import { parseSessionHistoryResourceResult, type AgentSessionHistoryResourceParams } from './session-history-resource.js'
import { parseHostedBootstrap } from './hosted-value.js'
import { normalizeInteractionOperationReceipt, normalizeAgentSession, parseAgentCreationFact } from './agent-session-store.js'
import { agentInteractionResponseUnavailableReason } from './agent-interaction-state.js'
import { validateAgentMuxMessageEnvelope } from './agent-global-message-queue.js'
import { agentPromptInputId, validateAgentPromptAdmissionIntent, validateAgentPromptCondition, validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { resolveAgentSessionId } from './agent-session-id.js'
import { assertDispatchEventKind, assertDispatchMessage } from './agent-handoff.js'
import { isAgentDeliveryState } from './agent-message.js'
import { parseRpcControlResult, rpcRecord } from './rpc-business-codec.js'
import type { AgentMuxRpcCredentials, AgentMuxRpcMethod } from './public-rpc.js'
import { isAgentMuxRpcDeviceMethod, parseAgentMuxRpcDeviceParams, parseAgentMuxRpcDeviceResult } from './public-rpc-device.js'
import { isHostSettingsMethod, parseHostSettingsParams, parseHostSettingsResult } from './public-rpc-host-settings.js'

const fail = (): never => { throw new AgentMuxError('Core RPC result is malformed or belongs to another object.', 'CONTROL_PROTOCOL_ERROR') }
const record = (value: unknown, fields?: readonly string[]) => rpcRecord(value, fields, 'CONTROL_PROTOCOL_ERROR')
function string(value: unknown, nullable = false): void {
  if (nullable && value === null) return
  if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)) fail()
}
function text(value: unknown): void { if (typeof value !== 'string') fail() }
function count(value: unknown, nullable = false): void { if (!(nullable && value === null) && (!Number.isSafeInteger(value) || (value as number) < 0)) fail() }
function timestamp(value: unknown): void { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail() }
function bool(value: unknown): void { if (typeof value !== 'boolean') fail() }
function member(value: unknown, values: readonly unknown[]): void { if (!values.includes(value)) fail() }
function array(value: unknown, consume: (item: unknown) => void): void { if (!Array.isArray(value)) return fail(); for (const item of value) consume(item) }

function promptExecution(value: unknown): void {
  if (value === undefined) return
  const capability = record(value, ['immediate'])
  member(capability.immediate, ['terminal-submit', 'interrupt-before-input'])
}
function agentCapabilities(value: unknown): void {
  const capabilities = record(value)
  promptExecution(capabilities.promptExecution)
  if (capabilities.nativeConversationInput !== undefined && record(capabilities.nativeConversationInput, ['managedRuns']).managedRuns !== true) fail()
  if (capabilities.nativeInterruption !== undefined && capabilities.nativeInterruption !== true) fail()
  if (capabilities.asyncQuestionReply !== undefined) member(capabilities.asyncQuestionReply, ['native-input'])
  if (capabilities.terminal !== true) fail()
  member(capabilities.timeline, ['unavailable', 'complete-events', 'streaming'])
  member(capabilities.permission, ['none', 'observe', 'respond']); bool(capabilities.providerResume)
  if (capabilities.providerFork !== undefined) {
    const fork = record(capabilities.providerFork, ['current'])
    if (fork.current !== true) fail()
  }
  member(capabilities.replyCorrelation, ['none', 'native-turn-id', 'acp-turn-id'])
  if (capabilities.usage !== undefined) {
    const usage = record(capabilities.usage, ['kind', 'transcriptFormat'])
    member(usage.kind, ['native-transcript']); member(usage.transcriptFormat, ['claude-jsonl', 'codex-rollout'])
  }
}
function runRef(value: unknown): Record<string, unknown> { const run = record(value, ['runId']); string(run.runId); return run }
function issues(value: unknown, source = false): void {
  array(value, item => { const issue = record(item, source ? ['source', 'code', 'message', 'recovery'] : ['code', 'message', 'recovery'])
    string(issue.code); text(issue.message); string(issue.recovery); if (source) string(issue.source) })
}
export function parseRpcAgentSession(value: unknown): ReturnType<typeof normalizeAgentSession> {
  const source = record(value)
  if (Object.hasOwn(source, 'hookBindingId') || Object.hasOwn(source, 'hookToken') || Object.hasOwn(source, 'nativeActor') || Object.hasOwn(source, 'initialInput')) fail()
  try {
    const session = normalizeAgentSession(source)
    if (source.terminalFrontend !== undefined) session.terminalFrontend = parseTerminalFrontend(source.terminalFrontend, session.run)
    if (source.turnUsage !== undefined) {
      const usage = record(source.turnUsage)
      if (usage.cumulative !== undefined && !isDeepStrictEqual(usage.cumulative, session.turnUsage?.cumulative)) fail()
    }
    if (source.nativeHandlePersistence !== undefined) {
      if (!session.nativeHandle) fail()
      member(source.nativeHandlePersistence, ['confirmed', 'unconfirmed'])
      session.nativeHandlePersistence = source.nativeHandlePersistence as 'confirmed' | 'unconfirmed'
    }
    if (source.currentActivity !== undefined) {
      const activity = record(source.currentActivity, ['state', 'source', 'run', 'nativeSessionId', 'nativeTurnId',
        'sourceId', 'sequence', 'hookReceiptId', 'observedAt', 'interruption'])
      member(activity.state, ['active', 'idle', 'unknown']); member(activity.source, ['native-hook'])
      if (runRef(activity.run).runId !== session.run.runId || session.nativeHandle?.kind !== 'provider' ||
          activity.nativeSessionId !== session.nativeHandle.sessionId) fail()
      for (const key of ['nativeSessionId', 'sourceId', 'hookReceiptId']) string(activity[key])
      if (activity.state !== 'unknown' || activity.nativeTurnId !== undefined) string(activity.nativeTurnId)
      count(activity.sequence); if (activity.sequence === 0) fail(); count(activity.observedAt)
      if (activity.interruption !== undefined) {
        if (activity.state !== 'idle') fail()
        member(activity.interruption, ['interrupted', 'not-interrupted'])
      }
      session.currentActivity = structuredClone(activity) as NonNullable<typeof session.currentActivity>
    }
    return session
  } catch { return fail() }
}
/** Prefix admission belongs to the service's full durable set. The client only
 * verifies that its canonical answer can be the exact requested identity. */
export function rpcSessionTargetMatches(selector: unknown, actual: string, credentials?: AgentMuxRpcCredentials): boolean {
  const expected = selector === 'self' ? credentials?.agentSessionId : selector
  if (typeof expected !== 'string' || !expected) return false
  try { return resolveAgentSessionId(expected, [actual]) === actual } catch { return false }
}
/** Host bootstrap is a read projection of the original SDK, never a new registry. */
export function parseRpcHostedBootstrap(value: unknown): Record<string, unknown> {
  const p = parseHostedBootstrap(value) as unknown as Record<string, unknown>
  array(p.sessions, session => parseRpcAgentSession(session))
  array(p.catalog, item => { const entry = record(item)
    for (const key of ['id', 'label', 'executable', 'expectedProcess']) string(entry[key])
    promptExecution(record(entry.capabilities).promptExecution); array(entry.launchOptions, option => record(option))
  })
  return p
}
function status(value: unknown, expected?: ReturnType<typeof normalizeAgentSession>, routed = false): void {
  const p = record(value, [...(routed ? ['routeHostId', 'lastActivity'] : []), 'session', 'run', 'capabilities', 'observation', 'interactionResponseUnavailableReason']), session = parseRpcAgentSession(p.session)
  if (routed && !isDeepStrictEqual(p.lastActivity, agentDiscoveryActivity(session))) fail()
  const responseReason = session.pendingInteraction && agentInteractionResponseUnavailableReason(session.pendingInteraction)
  if (p.interactionResponseUnavailableReason !== (responseReason || undefined)) fail()
  const run = record(p.run)
  if (run.runId !== session.run.runId || run.agentSessionId !== session.agentSessionId || run.kind !== 'agent' ||
    run.providerId !== session.providerId || run.executorId !== session.executorId || run.workspacePath !== session.workspacePath) fail()
  if (expected && (session.agentSessionId !== expected.agentSessionId || session.run.runId !== expected.run.runId)) fail()
  member(run.state, ['running', 'exited', 'interrupted'])
  for (const key of ['pid', 'cols', 'rows']) count(run[key], true)
  for (const key of ['observedAt', 'latestOutputBytes']) count(run[key])
  count(run.acceptedInputBytes, true)
  agentCapabilities(p.capabilities)
  const observation = record(p.observation)
  if (observation.process !== run.state) fail()
  member(observation.semantic, ['active', 'idle', 'awaiting-input', 'unknown', 'unsupported'])
  member(observation.readiness, ['ready', 'pending', 'unknown']); string(observation.source)
  count(observation.observedAt); bool(observation.stale)
  if (observation.reason !== undefined) {
    member(observation.reason, ['activity-stale', 'activity-unconfirmed'])
    if (observation.semantic !== 'unknown' || observation.process !== 'running') fail()
  }
  if (observation.lastKnownActivity !== undefined) {
    if (observation.reason === undefined) fail()
    const last = record(observation.lastKnownActivity, ['state', 'source', 'observedAt'])
    member(last.state, ['working', 'waiting', 'blocked', 'done', 'error'])
    member(last.source, ['native-hook', 'native-transcript', 'acp']); count(last.observedAt)
  }
}
function role(value: unknown): Record<string, unknown> {
  const binding = record(value, ['role', 'agentSessionId', 'workspacePath', 'providerId', 'registeredAt'])
  for (const key of ['role', 'agentSessionId', 'workspacePath', 'providerId']) string(binding[key])
  count(binding.registeredAt); return binding
}
function delivery(value: unknown): void {
  const p = record(value, ['state', 'at', 'reason']); if (!isAgentDeliveryState(p.state)) fail(); count(p.at)
  if (p.reason !== undefined) text(p.reason)
}
function notificationStatus(value: unknown, envelope: ReturnType<typeof validateAgentMuxMessageEnvelope>, notificationId?: string): void {
  const p = record(value)
  if (notificationId !== undefined) {
    const selected = record(p.notification)
    if (selected.notificationId !== notificationId) fail()
    if (selected.state === 'unassociated') {
      record(selected, ['state', 'notificationId', 'reason'])
      if (selected.reason !== 'notification-not-associated' || p.deliveryMode !== undefined && p.deliveryMode !== 'reference') fail()
      return
    }
  }
  if (p.deliveryMode === undefined) { if (p.notification !== undefined) fail(); return }
  if (p.deliveryMode !== 'reference' || envelope.sender.kind !== 'agent-session' || envelope.recipient.kind !== 'agent-session' || !envelope.recipientRunId) fail()
  const status = record(p.notification, ['state', 'notificationId', 'key', 'reason', 'mode', 'preparedAt', 'resultRecordedAt'])
  member(status.state, ['pending', 'submitted', 'unconfirmed', 'not-applied'])
  if ((status.notificationId === undefined) !== (status.key === undefined) || status.state !== 'pending' && status.key === undefined) fail()
  if (status.key !== undefined) {
    const key = validateAgentPromptInputKey(status.key); string(status.notificationId)
    if (key.kind !== 'prompt' || key.submissionId !== status.notificationId || key.submissionId === envelope.messageId ||
        key.agentSessionId !== envelope.recipientSessionId) fail()
    member(status.mode, ['idle', 'steer']); count(status.preparedAt, true); count(status.resultRecordedAt, true)
    if (status.state === 'pending' && status.resultRecordedAt !== null) fail()
  } else if (status.mode !== undefined || status.preparedAt !== undefined || status.resultRecordedAt !== undefined) fail()
  if (status.reason !== undefined) text(status.reason)
}
function message(value: unknown, notificationId?: string): ReturnType<typeof validateAgentMuxMessageEnvelope> {
  const p = record(value); count(p.sequence); delivery(p.delivery)
  const envelope = validateAgentMuxMessageEnvelope(p.envelope)
  notificationStatus(p, envelope, notificationId)
  if (p.promptCondition !== undefined && p.promptCondition !== null) validateAgentPromptCondition(p.promptCondition)
  return envelope
}
function dispatch(value: unknown, params: Record<string, unknown>): void {
  const p = record(value, ['sourceMessageId', 'ownerAgentSessionId', 'workerAgentSessionId', 'threadId', 'openedAt', 'originAwaits', 'events'])
  if (p.sourceMessageId !== params.sourceMessageId) fail()
  for (const key of ['sourceMessageId', 'ownerAgentSessionId', 'workerAgentSessionId', 'threadId']) string(p[key])
  count(p.openedAt); bool(p.originAwaits)
  array(p.events, value => { const event = record(value, ['kind', 'replyMessageId', 'at']); assertDispatchEventKind(event.kind); string(event.replyMessageId); count(event.at) })
  if (params.replyMessageId !== undefined && !(p.events as Array<Record<string, unknown>>).some(event => event.replyMessageId === params.replyMessageId && event.kind === params.kind)) fail()
}
function dispatchObservation(value: unknown, params: Record<string, unknown>): void {
  const p = record(value, ['dispatch', 'source', 'replies', 'identityDiagnostics', 'hostId'])
  string(p.hostId); if (params.hostId !== undefined && p.hostId !== params.hostId) fail()
  dispatch(p.dispatch, params)
  const supervision = p.dispatch as Record<string, unknown>, source = message(p.source)
  if (source.messageId !== supervision.sourceMessageId || source.senderSessionId !== supervision.ownerAgentSessionId ||
    source.recipientSessionId !== supervision.workerAgentSessionId || source.threadId !== supervision.threadId) fail()
  const events = supervision.events as Array<Record<string, unknown>>
  const envelopes = new Map<string, ReturnType<typeof validateAgentMuxMessageEnvelope>>()
  array(p.replies, value => {
    const reply = message(value), entry = value as Record<string, unknown>
    const admitted = reply.recipientRunId === null && entry.promptCondition
      ? { ...reply, recipientRunId: validateAgentPromptCondition(entry.promptCondition).expectedRun.runId } : reply
    assertDispatchMessage(admitted)
    if (envelopes.has(reply.messageId) || reply.messageId === source.messageId || reply.threadId !== source.threadId ||
      !(reply.senderSessionId === supervision.ownerAgentSessionId && reply.recipientSessionId === supervision.workerAgentSessionId ||
        reply.senderSessionId === supervision.workerAgentSessionId && reply.recipientSessionId === supervision.ownerAgentSessionId)) fail()
    envelopes.set(reply.messageId, reply)
  })
  // Order is the original journal order, not an event/reply positional join.
  // Every actual reply must reach this exact source; dangling/cyclic chains fail.
  const rooted = new Set([source.messageId])
  for (const reply of envelopes.values()) {
    const path = new Set<string>()
    let current = reply
    while (!rooted.has(current.messageId)) {
      if (path.has(current.messageId) || current.replyTo === null) return fail()
      path.add(current.messageId)
      if (rooted.has(current.replyTo)) break
      const parent = envelopes.get(current.replyTo)
      if (!parent) return fail()
      current = parent
    }
    for (const id of path) rooted.add(id)
  }
  for (const event of events) {
    const reply = envelopes.get(String(event.replyMessageId)), cleanup = event.kind === 'cleanup'
    if (!reply || reply.replyTo !== source.messageId ||
      reply.senderSessionId !== (cleanup ? supervision.ownerAgentSessionId : supervision.workerAgentSessionId) ||
      reply.recipientSessionId !== (cleanup ? supervision.workerAgentSessionId : supervision.ownerAgentSessionId)) fail()
  }
  array(p.identityDiagnostics, value => {
    const diagnostic = record(value, ['agentSessionId', 'runId', 'code', 'message'])
    string(diagnostic.agentSessionId); string(diagnostic.runId); text(diagnostic.message)
    member(diagnostic.code, ['DISPATCH_IDENTITY_UNAVAILABLE', 'AGENT_SESSION_STORE_READ_UNCONFIRMED'])
    if (diagnostic.agentSessionId !== supervision.ownerAgentSessionId && diagnostic.agentSessionId !== supervision.workerAgentSessionId) fail()
  })
}
function dispatchPage(value: unknown, params: Record<string, unknown>): void {
  const p = record(value, ['hostId', 'participantSessionId', 'dispatches', 'nextSourceMessageId'])
  string(p.hostId); string(p.participantSessionId)
  if (params.hostId !== undefined && p.hostId !== params.hostId ||
    params.participantSessionId !== undefined && p.participantSessionId !== params.participantSessionId) fail()
  const sources = new Set<unknown>()
  array(p.dispatches, value => {
    const item = record(value)
    dispatch(item, { sourceMessageId: item.sourceMessageId })
    if (sources.has(item.sourceMessageId) || item.ownerAgentSessionId !== p.participantSessionId && item.workerAgentSessionId !== p.participantSessionId) fail()
    sources.add(item.sourceMessageId)
  })
  if (p.nextSourceMessageId !== null) {
    string(p.nextSourceMessageId)
    if (!(p.dispatches as Array<Record<string, unknown>>).length || p.nextSourceMessageId !== (p.dispatches as Array<Record<string, unknown>>).at(-1)!.sourceMessageId) fail()
  }
}
function activity(value: unknown): void {
  array(value, item => { const p = record(item, ['goalId', 'id', 'kind', 'message', 'createdAt', 'actorId', 'operationId', 'nameChangeId']); string(p.goalId); parseControlDemandActivity(p) })
}

/** Finite native DTO consumption. Existing Session, message, Goal and catalog
 * codecs retain their authority; this boundary does not derive Runtime facts. */
export function parseRpcNativeResult(method: AgentMuxRpcMethod, value: unknown, params: unknown,
  credentials?: AgentMuxRpcCredentials): Record<string, unknown> {
  try {
    if (isMobileAssetsMethod(method)) return parseMobileAssetsResult(method, value, parseMobileAssetsParams(method, params)) as unknown as Record<string, unknown>
    if (method === 'app.mobile.report') return parseMobileWebReportReceipt(value, parseMobileWebReportParams(params)) as unknown as Record<string, unknown>
    if (method === 'capsule.input') return parseCapsuleInputResult(value, parseCapsuleInputRequest(params)) as unknown as Record<string, unknown>
    if (isCapsuleRuntimeMethod(method)) return parseCapsuleRuntimeResult(value) as unknown as Record<string, unknown>
    if (isCapsuleMethod(method)) return parseCapsuleRpcResult(method, value, parseCapsuleRpcParams(method, params)) as unknown as Record<string, unknown>
    if (method === 'app.search') return parseAgentMuxSearchPage(value, parseAgentMuxSearchInput(params)) as unknown as Record<string, unknown>
    if (isGoalDelegationMethod(method)) return parseGoalDelegationResult(value, parseGoalDelegationParams(method, params)) as unknown as Record<string, unknown>
    if (isMoteAvatarWriteMethod(method)) return parseMoteAvatarWriteResult(method, value, parseMoteAvatarWriteParams(method, params)) as unknown as Record<string, unknown>
    if (isMoteAvatarSeriesMethod(method)) return parseMoteAvatarSeriesResult(method, value, parseMoteAvatarSeriesParams(method, params)) as unknown as Record<string, unknown>
    if (isAppWindowMethod(method)) return parseAppWindowPage(method, value, parseAppWindowParams(method, params)) as unknown as Record<string, unknown>
    if (isGitMethod(method)) return parseGitResult(method, value, parseGitParams(method, params)) as unknown as Record<string, unknown>
    if (method === 'file.share.undo') return parseFileShareUndoResult(value, parseFileShareUndoParams(params)) as unknown as Record<string, unknown>
    if (method === 'file.share.inspect') return parseFileShareInspectResult(value, parseFileShareInspectParams(params)) as unknown as Record<string, unknown>
    if (method === 'file.share') return parseFileShareResult(value, parseFileShareParams(params)) as unknown as Record<string, unknown>
    if (method === 'file.import') return parseFileImportResult(value, parseFileImportParams(params)) as unknown as Record<string, unknown>
    if (isFileMethod(method)) return (method === 'file.upload' || method === 'file.upload.inspect' ? parseFileUploadResult(value, method === 'file.upload' ? parseFileUploadParams(params) : parseFileUploadIdentity(params)) : method === 'file.history' ? parseFileHistoryResult(value, parseFileHistoryParams(params)) : method === 'file.restore' ? parseFileRestoreResult(value, parseFileRestoreParams(params)) : method === 'file.undo' ? parseFileUndoResult(value, parseFileUndoParams(params)) : method === 'file.create' ? parseFileCreateResult(value, parseFileCreateParams(params)) : method === 'file.write' ? parseFileWriteResult(value, parseFileWriteParams(params)) : method === 'file.list' ? parseFileListResult(value, parseFileListParams(params)) : parseFileReadResult(value, parseFileReadParams(params))) as unknown as Record<string, unknown>
    if (isAgentLearningMethod(method)) return parseAgentLearningResult(method, value, parseAgentLearningParams(method, params)) as unknown as Record<string, unknown>
    if (isMoteChatMethod(method)) return parseMoteChatResult(method, value, parseMoteChatParams(method, params)) as unknown as Record<string, unknown>
    if (isMoteConnectionMethod(method)) return parseMoteConnectionResult(method,value,parseMoteConnectionParams(method,params)) as unknown as Record<string,unknown>
    if (isConnectionMethod(method)) return parseConnectionResult(method, value, parseConnectionParams(method, params)) as unknown as Record<string, unknown>
    if (isApplicationAccessMethod(method)) return parseApplicationAccessResult(method,value,parseApplicationAccessParams(method,params)) as unknown as Record<string,unknown>
    if (isHostSettingsMethod(method)) return parseHostSettingsResult(method, value, parseHostSettingsParams(method, params)) as unknown as Record<string, unknown>
    if (isAgentProgressMethod(method)) return parseAgentProgressResult(method, value, parseAgentProgressParams(method, params)) as unknown as Record<string, unknown>
    if (isScheduleMethod(method)) return validateScheduleRpcResult(method, value, parseScheduleRpcParams(method, params)) as unknown as Record<string, unknown>
    if (isNativeDesktopMethod(method)) return parseNativeDesktopResult(method, value, parseNativeDesktopParams(method, params)) as unknown as Record<string, unknown>
    if (isTopicMethod(method)) return parseTopicResult(method, value, parseTopicParams(method, params)) as unknown as Record<string, unknown>
    if (isAgentMuxRpcDeviceMethod(method)) return parseAgentMuxRpcDeviceResult(method, value,
      parseAgentMuxRpcDeviceParams(method, params)) as unknown as Record<string, unknown>
    const p = record(value), input = record(params)
    if (['schemaVersion', 'requestId', 'operation'].some(key => Object.hasOwn(p, key))) fail()
    switch (method) {
      case 'browser.input.inspect': return parseAgentInputContextCaptureRead(value, parseAgentInputContextCaptureReference(input)) as unknown as Record<string, unknown>
      case 'system.diagnostics.inspect': return parseDiagnosticEvidenceResult(value, input) as unknown as Record<string, unknown>
      case 'message.delivery.inspect': return parseDeliveryAttemptLookup(value, input.logId as string) as unknown as Record<string, unknown>
      case 'message.delivery.report': return parseDeliveryAttemptLookup(value, (input.record as import('./delivery-attempt.js').DeliveryAttempt).logId) as unknown as Record<string, unknown>
      case 'skill.ls': {
        record(p, ['hostId', 'sourceHostId', 'agentSessionId', 'providerId', 'workspacePath', 'skills'])
        string(p.hostId); string(p.sourceHostId); string(p.agentSessionId); string(p.providerId); string(p.workspacePath)
        if (p.hostId !== input.hostId || p.agentSessionId !== input.agentSessionId) fail()
        array(p.skills, value => {
          const skill = record(value, ['name', 'description', 'path', 'source'])
          string(skill.name); text(skill.description); string(skill.path); member(skill.source, ['project', 'user'])
        })
        break
      }
      case 'agent.native.ls': {
        record(p, ['hostId', 'executorId', 'providerId', 'capabilities', 'availability', 'sessions', 'issues'])
        string(p.hostId); string(p.executorId); string(p.providerId)
        record(p.capabilities, ['terminal', 'timeline', 'permission', 'providerResume', 'nativeInterruption', 'providerFork', 'replyCorrelation', 'asyncQuestionReply', 'promptExecution', 'nativeConversationInput', 'usage'])
        agentCapabilities(p.capabilities)
        if (p.hostId !== input.hostId || p.executorId !== input.executorId) fail()
        member(p.availability, ['available', 'unsupported'])
        array(p.sessions, value => {
          const candidate = record(value, ['source', 'title', 'createdAt', 'updatedAt', 'managed'])
          const source = parseAgentNativeResumeSource(candidate.source)
          if (source.nativeHandle.providerId !== p.providerId) fail()
          if (candidate.title !== undefined) text(candidate.title)
          if (candidate.createdAt !== undefined) timestamp(candidate.createdAt)
          timestamp(candidate.updatedAt)
          if (candidate.managed !== undefined) {
            const managed = record(candidate.managed, ['agentSessionId', 'executorId', 'run', 'state', 'retiredAt'])
            string(managed.agentSessionId); string(managed.executorId); runRef(managed.run)
            member(managed.state, ['active', 'retired'])
            if (managed.retiredAt !== undefined) count(managed.retiredAt)
            if (managed.state === 'retired' && managed.retiredAt === undefined) fail()
          }
        })
        if (p.availability === 'unsupported' && (p.sessions as unknown[]).length) fail()
        array(p.issues, value => { const issue = record(value, ['code', 'message']); string(issue.code); text(issue.message) })
        break
      }
      case 'agent.native.history': return parseNativeHistoryResult(value, parseNativeHistoryParams(params)) as unknown as Record<string, unknown>
      case 'agent.native.history.resource': return parseNativeHistoryResourceResult(value, parseNativeHistoryResourceParams(params)) as unknown as Record<string, unknown>
      case 'agent.native.confirm': {
        record(p, ['session', 'confirmation', 'persisted', 'current'])
        const request = parseAgentNativeSessionConfirmation(input), session = parseRpcAgentSession(p.session)
        const confirmation = record(p.confirmation, ['operationId', 'run', 'previousNativeHandle', 'nativeHandle', 'observedAt', 'candidateObservedAt', 'basis', 'previousInteraction', 'previousPromptSubmissionId'])
        if (p.persisted !== true || session.agentSessionId !== request.agentSessionId || session.run.runId !== request.expectedRun.runId ||
          confirmation.operationId !== request.operationId || runRef(confirmation.run).runId !== request.expectedRun.runId ||
          confirmation.candidateObservedAt !== request.expectedObservationAt || !isDeepStrictEqual(confirmation.previousNativeHandle, request.expectedNativeHandle) ||
          !isDeepStrictEqual(confirmation.nativeHandle, request.candidateNativeHandle)) fail()
        bool(p.current)
        if (confirmation.basis !== undefined) member(confirmation.basis, ['current-main', 'run-main-candidate'])
        const current = isDeepStrictEqual(session.nativeConfirmation, confirmation) && isDeepStrictEqual(session.nativeHandle, request.candidateNativeHandle)
        if (p.current !== current || ![session.nativeConfirmation, ...(session.nativeConfirmationHistory ?? [])].some(value => isDeepStrictEqual(value, confirmation))) fail()
        count(confirmation.observedAt)
        break
      }
      case 'agent.context': {
        let nativePage = p.native
        const expected = parseAgentContextParams(input)
        record(p, ['hostId', 'sourceHostId', 'agentSessionId', 'descriptor', 'session', 'status', 'runtimeDiagnostics', 'captured', 'native', 'unavailable', 'nextCursor'])
        if (p.hostId !== expected.hostId || p.agentSessionId !== expected.agentSessionId) fail()
        string(p.sourceHostId)
        const descriptor = record(p.descriptor, ['hostId', 'agentSessionId', 'state', 'retiredAt', 'pendingReopen', 'history'])
        if (descriptor.hostId !== p.sourceHostId || descriptor.agentSessionId !== expected.agentSessionId) fail()
        member(descriptor.state, ['active', 'retired'])
        if (descriptor.state === 'retired') count(descriptor.retiredAt)
        else if (descriptor.retiredAt !== undefined) fail()
        if (descriptor.pendingReopen !== undefined) { const pending = record(descriptor.pendingReopen, ['operationId']); if (pending.operationId !== undefined) string(pending.operationId) }
        if (descriptor.history !== undefined) {
          const h = record(descriptor.history, ['providerId', 'executorId', 'workspacePath', 'createdAt', 'nativeHandle', 'observedNativeHandle', 'previousNativeHandle'])
          for (const key of ['providerId', 'executorId', 'workspacePath']) string(h[key]); count(h.createdAt)
          for (const key of ['nativeHandle', 'observedNativeHandle', 'previousNativeHandle'] as const) if (h[key] !== undefined) {
            const handle = record(h[key], ['kind', 'providerId', 'adapterId', 'sessionId', 'transcriptPath'])
            member(handle.kind, ['provider', 'acp']); string(handle.sessionId)
            if (handle.kind === 'provider') { string(handle.providerId); if (handle.providerId !== h.providerId || handle.adapterId !== undefined) fail() }
            else { string(handle.adapterId); if (handle.providerId !== undefined) fail() }
            if (handle.transcriptPath !== undefined) string(handle.transcriptPath)
          }
        }
        const contextSession = (value: unknown) => {
          const session = parseRpcAgentSession(value)
          if (session.hostId !== p.sourceHostId || session.agentSessionId !== expected.agentSessionId || descriptor.state !== 'active') fail()
          if (descriptor.history !== undefined) {
            const h = record(descriptor.history)
            for (const key of ['providerId', 'executorId', 'workspacePath', 'createdAt'] as const) if (h[key] !== session[key]) fail()
            // Absence in an earlier diagnostic is unknown; a present binding
            // must describe the same exact source rather than another fork.
            if (session.nativeHandle !== undefined && !isDeepStrictEqual(session.nativeHandle, h.nativeHandle)) fail()
          }
          return session
        }
        if (p.session !== null) contextSession(p.session)
        if (p.status !== null) {
          contextSession(record(p.status).session)
          status(p.status, p.session === null ? undefined : contextSession(p.session))
        }
        if (p.captured !== null) {
          const timeline = record(p.captured, ['agentSessionId', 'revision', 'items'])
          if (timeline.agentSessionId !== expected.agentSessionId) fail(); count(timeline.revision)
          array(timeline.items, value => {
            const item = record(value) // The original normalizer below is the sole exhaustive captured-item contract.
            if (item.agentSessionId !== expected.agentSessionId) fail()
            const mutation = normalizeAgentTimelineMutation({ type: 'append', agentSessionId: expected.agentSessionId, item })
            if (mutation.type !== 'append' || !isDeepStrictEqual(mutation.item, item)) fail()
          })
        }
        if (p.native !== null) {
          const page = record(p.native, ['agentSessionId', 'sourceHostId', 'source', 'items', 'nextCursor', 'changesCursor', 'replayCursor', 'sourceSizeBytes'])
          if (page.agentSessionId !== expected.agentSessionId) fail()
          if (page.sourceHostId !== undefined && page.sourceHostId !== p.sourceHostId) fail()
          const source = record(page.source, ['providerId', 'nativeSessionId']); string(source.providerId); string(source.nativeSessionId)
          if (descriptor.history !== undefined && record(descriptor.history).providerId !== source.providerId) fail()
          const handle = descriptor.history === undefined ? undefined : record(descriptor.history).nativeHandle
          if (handle !== undefined && record(handle).kind === 'provider' && (record(handle).sessionId !== source.nativeSessionId || record(handle).providerId !== source.providerId)) fail()
          const normalized = normalizeSessionHistoryPage(source as { providerId: string; nativeSessionId: string }, page, expected.limit ?? 30)
          const { agentSessionId: _sid, sourceHostId, ...body } = page
          if (!isDeepStrictEqual(sessionHistoryWithoutMetrics(normalized), sessionHistoryWithoutMetrics({ ...body, items: body.items as unknown[] }))) fail()
          nativePage = { agentSessionId: page.agentSessionId, ...(sourceHostId === undefined ? {} : { sourceHostId }), ...normalized }
          if (page.sourceSizeBytes !== undefined) count(page.sourceSizeBytes)
        }
        array(p.unavailable, value => { const issue = record(value, ['source', 'code', 'message', 'recovery']); member(issue.source, ['captured', 'native', 'session', 'status', 'runtime']); string(issue.code); text(issue.message); text(issue.recovery) })
        string(p.nextCursor, true)
        if (p.runtimeDiagnostics !== null) parseRuntimeDiagnostics(p.runtimeDiagnostics)
        return { ...p, native: nativePage }
      }
      case 'runtime.network.inspect': return parseRuntimeNetworkSnapshot(value, input.fence as import('./hosted-client-contract.js').AgentMuxRuntimeFence)
      case 'runtime.bootstrap': parseRpcHostedBootstrap(p); break
      case 'runtime.invoke': record(p, ['value']); if (!Object.hasOwn(p, 'value')) fail(); break
      case 'runtime.release-consumer': record(p, ['released']); bool(p.released); break
      case 'agent.interaction.respond': case 'agent.interaction.inspect': {
        const raw = method === 'agent.interaction.inspect' ? record(p, ['receipt']).receipt : p
        if (raw === null && method === 'agent.interaction.inspect') break
        const receipt = normalizeInteractionOperationReceipt(raw)
        if (!isDeepStrictEqual(raw, receipt) || !rpcSessionTargetMatches(input.agentSessionId, receipt.agentSessionId) || receipt.operationId !== input.operationId) fail()
        if (method === 'agent.interaction.respond' && (!isDeepStrictEqual(receipt.run, input.expectedRun) || !isDeepStrictEqual(receipt.response, input.response) || !isDeepStrictEqual(receipt.externalAction, input.externalAction))) fail()
        break
      }
      case 'agent.question.reply': {
        record(p, ['agentSessionId', 'source', 'recordId', 'questionIds', 'operationId', 'outcome'])
        const source = record(p.source, ['providerId', 'nativeSessionId']), expected = record(input.source)
        string(source.providerId); string(source.nativeSessionId)
        if (!rpcSessionTargetMatches(input.agentSessionId, String(p.agentSessionId)) || p.recordId !== input.recordId ||
          p.operationId !== input.operationId || p.outcome !== 'submitted' || source.providerId !== expected.providerId ||
          source.nativeSessionId !== expected.nativeSessionId) fail()
        array(p.questionIds, id => string(id))
        const answers = input.answers as Array<{ questionId: string }>
        if (!Array.isArray(answers) || JSON.stringify(p.questionIds) !== JSON.stringify(answers.map(answer => answer.questionId))) fail()
        break
      }
      case 'agent.history.resource': return parseSessionHistoryResourceResult(value, input as AgentSessionHistoryResourceParams)
      case 'agent.conversation.record': return parseExternalConversationReceipt(value, input as import('./external-conversation.js').AgentExternalConversationReference)
      case 'agent.conversation.release': return parseConversationViewReleaseResult(value, input as import('./conversation.js').ConversationRef)
      case 'agent.conversation.checkpoint': return parseConversationCheckpointPage(value, input as import('./conversation.js').ConversationRef)
      case 'agent.conversation.changes': return parseConversationChangesPage(value, input as import('./conversation-changes.js').ConversationChangesInput)
      case 'agent.conversation.watch': return parseConversationWatchOpening(value, input as import('./conversation.js').ConversationRef)
      case 'agent.conversation.landmark.ls': return parseConversationLandmarkPage(value, parseConversationLandmarkQuery(input))
      case 'agent.conversation.landmark.apply': return parseConversationLandmarkWritePage(value, parseConversationLandmarkWrite(input))
      case 'agent.conversation.inspect': return parseConversationReadPage(value, input as import('./conversation-changes.js').ConversationTimelineReadInput)
      case 'agent.history': return parseAgentSessionHistoryReadPage(value, input as AgentSessionHistoryReadInput)
      case 'agent.continuity.control': {
        const result = parseAgentContinuityControlResult(value, parseAgentContinuityControlInput(input))
        if (result.state === 'active') parseRpcAgentSession(result.session)
        return result as unknown as Record<string, unknown>
      }
      case 'agent.restart': {
        record(p, ['session'])
        const session = parseRpcAgentSession(p.session), expected = record(input.expectedRun)
        const operation = session.continuityOperations?.[String(input.operationId)]
        if (session.agentSessionId !== input.agentSessionId || !operation || operation.action !== 'restart' ||
          operation.previousRun.runId !== expected.runId || operation.kind !== 'resumed' || operation.newRun?.runId !== session.run.runId || session.run.runId === expected.runId) fail()
        break
      }
      case 'agent.restart.inspect': {
        record(p, ['agentSessionId', 'operationId', 'expectedRun', 'previousRun', 'phase', 'canRetry', 'session', 'newRun', 'observedAt', 'detail', 'failure'])
        if (p.agentSessionId !== input.agentSessionId || p.operationId !== input.operationId ||
          record(p.expectedRun).runId !== record(input.expectedRun).runId || record(p.previousRun).runId !== record(input.expectedRun).runId ||
          !['not-found', 'stopping', 'starting', 'restarted', 'failed', 'unconfirmed'].includes(String(p.phase)) || typeof p.canRetry !== 'boolean') fail()
        count(p.observedAt)
        if (p.detail !== undefined) text(p.detail)
        if (p.session !== undefined && parseRpcAgentSession(p.session).agentSessionId !== input.agentSessionId) fail()
        if (p.newRun !== undefined) { if (typeof record(p.newRun).runId !== 'string' || record(p.newRun).runId === record(input.expectedRun).runId) fail() }
        if (p.phase === 'restarted' && (!p.newRun || p.canRetry !== false)) fail()
        if (p.failure !== undefined) { const failure = record(p.failure, ['code', 'message', 'observedAt']); string(failure.code); text(failure.message); count(failure.observedAt); if (p.phase !== 'failed') fail() }
        if (p.phase === 'failed' && (!p.newRun || !p.failure || p.canRetry !== false)) fail()
        break
      }
      case 'agent.refresh': {
        record(p, ['session'])
        const session = parseRpcAgentSession(p.session)
        if (session.agentSessionId !== input.agentSessionId) fail()
        break
      }
      case 'agent.inspect': case 'whoami': {
        record(p, method === 'whoami' ? ['session', 'status', 'view', 'unavailable'] : ['routeHostId', 'session', 'status', 'displayName', 'unavailable'])
        const session = parseRpcAgentSession(p.session), target = method === 'whoami' ? { kind: 'self' } : record(input.target)
        if (target.kind === 'agent-session' && !rpcSessionTargetMatches(target.agentSessionId, session.agentSessionId) ||
          target.kind === 'self' && !rpcSessionTargetMatches('self', session.agentSessionId, credentials) ||
          target.kind === 'run' && runRef(target.run).runId !== session.run.runId) fail()
        if (target.kind === 'provider-native' || target.kind === 'acp-native') {
          const handle = session.nativeHandle
          if (!handle || handle.kind !== (target.kind === 'provider-native' ? 'provider' : 'acp') || handle.sessionId !== target.sessionId ||
            ('providerId' in handle ? handle.providerId !== target.providerId : handle.adapterId !== target.adapterId)) fail()
        }
        if (p.status !== null) status(p.status, session); issues(p.unavailable)
        if (method === 'agent.inspect') { string(p.routeHostId); const name = record(p.displayName, ['override', 'source', 'nameRevision', 'availability']); if (name.override !== null) text(name.override); if (name.source !== null) member(name.source, ['manual', 'launch', 'derived', 'retained']); if (name.nameRevision !== null) count(name.nameRevision); member(name.availability, ['observed', 'unavailable']) }
        else { const view = record(p.view); bool(view.attached)
          if (view.attached) { record(view, ['attached', 'region']); const region = record(view.region); if (region.agentSessionId !== session.agentSessionId) fail()
            // Reuse the existing presentation codec, including geometry and terminal facts.
            const { parseAgentMuxControlReceipt } = controlCodec
            parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'rpc-whoami-view', operation: 'inspect.region', ok: true, result: { region } })
          } else { member(view.reason, ['no-desktop-view', 'view-unavailable']); if (view.reason === 'view-unavailable') { const error = record(view.error, ['code', 'message']); string(error.code); text(error.message) } }
        }
        break
      }
      case 'agent.reopen': case 'agent.reopen.check': {
        record(p, ['session'])
        const session = parseRpcAgentSession(p.session)
        if (session.agentSessionId !== input.agentSessionId || !session.reopenedFrom ||
          session.reopenedFrom.observedAt !== input.expectedRetiredAt ||
          session.run.runId === session.reopenedFrom.run.runId) fail()
        break
      }
      case 'agent.ls': {
        record(p, ['sessions', 'unavailableSessions', 'retired', 'errors', 'nextCursor'])
        const identities = new Set<string>()
        const identity = (route: unknown, sid: unknown) => {
          const key = JSON.stringify([route, sid])
          if (identities.has(key)) fail()
          identities.add(key)
          if (input.agentSessionId !== undefined && sid !== input.agentSessionId) fail()
        }
        const metadata = (session: ReturnType<typeof normalizeAgentSession>, lastActivity: unknown) => {
          if (input.executorId !== undefined && session.executorId !== input.executorId || input.providerId !== undefined && session.providerId !== input.providerId ||
              input.since !== undefined && session.updatedAt < Number(input.since) || input.activitySince !== undefined &&
              (!lastActivity || Number((lastActivity as { observedAt: number }).observedAt) < Number(input.activitySince))) fail()
        }
        array(p.sessions, item => {
          const entry = record(item); string(entry.routeHostId); status(item, undefined, true)
          const session = parseRpcAgentSession(entry.session), observation = record(entry.observation)
          identity(entry.routeHostId, session.agentSessionId); metadata(session, entry.lastActivity)
          for (const [filter, field] of [['status', 'process'], ['semantic', 'semantic'], ['readiness', 'readiness']] as const)
            if (input[filter] !== undefined && observation[field] !== input[filter]) fail()
        })
        array(p.unavailableSessions, item => {
          const entry = record(item, ['routeHostId', 'session', 'code', 'message', 'lastActivity'])
          const session = parseRpcAgentSession(entry.session)
          string(entry.routeHostId); string(entry.code); text(entry.message)
          if (!isDeepStrictEqual(entry.lastActivity, agentDiscoveryActivity(session))) fail()
          identity(entry.routeHostId, session.agentSessionId); metadata(session, entry.lastActivity)
        })
        array(p.retired, item => {
          const retired = record(item, ['agentSessionId', 'hostId', 'routeHostId', 'state', 'retiredAt', 'history', 'pendingReopen'])
          string(retired.agentSessionId); string(retired.hostId); string(retired.routeHostId)
          if (retired.state !== 'retired') fail()
          identity(retired.routeHostId, retired.agentSessionId)
          if (['status', 'semantic', 'readiness', 'since', 'activitySince'].some(key => input[key] !== undefined)) fail()
          count(retired.retiredAt)
          if (retired.pendingReopen !== undefined) {
            const pending = record(retired.pendingReopen, ['operationId'])
            if (pending.operationId !== undefined) string(pending.operationId)
          }
          if (retired.history !== undefined) {
            const history = record(retired.history)
            for (const key of ['providerId', 'executorId', 'workspacePath']) string(history[key])
            count(history.createdAt)
          }
          const history = retired.history as Record<string, unknown> | undefined
          if (input.executorId !== undefined && history?.executorId !== input.executorId || input.providerId !== undefined && history?.providerId !== input.providerId) fail()
        })
        array(p.errors, item => { const error = record(item, ['agentSessionId', 'hostId', 'code', 'message']); string(error.agentSessionId, true); string(error.hostId); string(error.code); text(error.message) })
        if (p.nextCursor !== null) string(p.nextCursor)
        if (identities.size > Number(input.limit ?? 100)) fail()
        break
      }
      case 'agent.role.ls': record(p, ['bindings']); array(p.bindings, item => role(item)); break
      case 'agent.role.register': case 'agent.role.resolve': { record(p, ['binding']); const binding = role(p.binding)
        if (binding.role !== input.role || input.workspacePath !== undefined && binding.workspacePath !== input.workspacePath ||
          method === 'agent.role.register' && credentials && binding.agentSessionId !== credentials.agentSessionId) fail(); break }
      case 'goal.participation.confirm': {
        const original = parseGoalParticipationConfirm(input)
        record(p, ['goal','operationId','diskDurability'])
        parseRpcControlResult('goal.inspect', { goal: p.goal, goalContinuations: [] })
        if ((p.goal as Record<string, unknown>).id !== original.goalId || p.operationId !== original.operationId || p.diskDurability !== 'confirmed') fail()
        break
      }
      case 'agent.automation.pause': case 'agent.automation.inspect': { parseAgentAutomationInspection(p, parseAgentAutomationTarget(input)); break }
      case 'agent.input.submit': {
        record(p, ['key', 'record', 'input'])
        const key = validateAgentPromptInputKey(p.key)
        if (key.kind !== 'prompt' || key.agentSessionId !== input.agentSessionId || key.submissionId !== input.operationId || !isDeepStrictEqual(key.expectedRun, input.expectedRun)) fail()
        if (key.kind !== 'prompt') return fail()
        const observed = p.input === undefined || p.input === null ? null : inputReceipt(p.input)
        if (observed && (!isDeepStrictEqual(observed.key, key) || !isDeepStrictEqual(observed.admission, p.record))) fail()
        if (p.record !== null) {
          const original = parsePromptSubmissionRecord(p.record), message = original.admission?.intent?.message ?? original.launch?.message
          if (original.agentSessionId !== key.agentSessionId || !isDeepStrictEqual(original.run, key.expectedRun) ||
              (original.admission?.submissionId ?? original.launch?.input.submissionId) !== key.submissionId ||
              original.admission?.inputKey && !isDeepStrictEqual(original.admission.inputKey, key) ||
              !message || message.userContent !== input.prompt || !isDeepStrictEqual(message.inputContext, input.inputContext) ||
              message.authorHuman !== undefined || message.authorAgentSessionId !== undefined || message.authorExternal !== undefined ||
              message.systemContext !== undefined || message.inputContextSource !== (input.inputContext === undefined ? undefined : 'caller-declared')) fail()
        }
        break
      }
      case 'agent.input.ls': {
        record(p, ['hostId', 'agentSessionId', 'queueId', 'cut', 'budgetBytes', 'items', 'nextCursor', 'coverage'])
        if (p.hostId !== input.hostId) fail()
        const { hostId: _route, ...page } = p
        const { hostId: _target, ...read } = input
        parseAgentInputMailboxPage(page, read as import('./agent-input-mailbox.js').AgentInputMailboxRead)
        break
      }
      case 'agent.input.inspect': {
        record(p, ['record', 'input'])
        const observed = p.input === null || p.input === undefined ? null : inputReceipt(p.input)
        if (input.kind === 'message-control') {
          if (observed && observed.originalControlOperationId !== input.originalControlOperationId || p.record !== null && !observed ||
              observed && !isDeepStrictEqual(p.record, observed.admission)) fail()
          break
        }
        const key = validateAgentPromptInputKey(input.key)
        if (observed && (!isDeepStrictEqual(observed.key, key) || !isDeepStrictEqual(p.record, observed.admission))) fail()
        if (p.record !== null) {
          const original = parsePromptSubmissionRecord(p.record)
          if (original.agentSessionId !== key.agentSessionId || original.run.runId !== key.expectedRun.runId ||
              (original.admission?.submissionId ?? original.terminalPromptSubmission?.submissionId ?? original.launch?.input.submissionId ?? original.admission?.operationId) !== agentPromptInputId(key) ||
              original.admission?.inputKey && !isDeepStrictEqual(original.admission.inputKey, key)) fail()
        }
        break
      }
      case 'agent.input.stop': {
        record(p, ['ref', 'cancelOperationId', 'outcome', 'at'])
        if (!isDeepStrictEqual(validateAgentInputWaitRef(p.ref), validateAgentInputWaitRef(input.ref)) || p.cancelOperationId !== input.cancelOperationId) fail()
        member(p.outcome, ['stopped-before-dispatch', 'observation-stopped', 'already-settled', 'stale-generation']); timestamp(p.at)
        break
      }
      case 'agent.input.rejoin': {
        const receipt = inputReceipt(p), original = validateAgentInputWaitRef(input.ref)
        if (!isDeepStrictEqual(receipt.key, original.key) || ![original.waitGeneration, original.waitGeneration + 1].includes(receipt.ref.waitGeneration)) fail()
        break
      }
      case 'agent.send': {
        record(p, ['queueId', 'receiptId', 'messageId', 'sequence', 'envelope', 'delivery', 'deliveryMode', 'notification', 'promptCondition', 'agentSessionId', 'sourceChannel', 'sourceDevice', 'admissionIntent', 'inputReceipt'])
        if (p.sourceChannel !== undefined) normalizeMessageChannel(p.sourceChannel)
        if (p.sourceDevice !== undefined) normalizeOperationDevice(p.sourceDevice)
        const envelope = message(p)
        if (input.expectedRun !== undefined) {
          const intent = p.admissionIntent === undefined ? undefined : validateAgentPromptAdmissionIntent(p.admissionIntent)
          const capturedRun = envelope.recipientRunId ?? (p.promptCondition === undefined || p.promptCondition === null ? undefined :
            validateAgentPromptCondition(p.promptCondition).expectedRun.runId) ??
            (intent?.kind === 'exact-condition' ? intent.condition.expectedRun.runId : intent?.expectedRun.runId)
          if (capturedRun !== runRef(input.expectedRun).runId) fail()
        }
        if (p.inputReceipt !== undefined) {
          const receipt = inputReceipt(p.inputReceipt)
          if (receipt.key.kind !== 'message' || receipt.key.messageId !== envelope.messageId || receipt.originalControlOperationId !== envelope.operationId ||
              receipt.key.agentSessionId !== envelope.recipientSessionId || receipt.key.expectedRun.runId !== envelope.recipientRunId ||
              p.delivery && (p.delivery as { state?: string }).state === 'delivered' && receipt.status !== 'admitted' && receipt.status !== 'terminal-confirmed') fail()
        }
        if (p.admissionIntent !== undefined) {
          const intent = validateAgentPromptAdmissionIntent(p.admissionIntent)
          if (intent.kind === 'exact-condition' || input.execution !== 'immediate' || intent.expectedRun.runId !== envelope.recipientRunId) fail()
          if (input.admissionIntent !== undefined && !isDeepStrictEqual(input.admissionIntent, intent)) fail()
        }
        for (const key of ['queueId', 'receiptId', 'messageId']) string(p[key])
        if (p.messageId !== envelope.messageId || input.messageId === undefined && envelope.operationId !== input.operationId || envelope.body !== input.text ||
          input.messageId !== undefined && envelope.messageId !== input.messageId) fail()
        const target = record(input.target)
        if (target.kind === 'agent-session' && !rpcSessionTargetMatches(target.agentSessionId, envelope.recipientSessionId ?? '') ||
          target.kind === 'self' && !rpcSessionTargetMatches('self', envelope.recipientSessionId ?? '', credentials) ||
          p.agentSessionId !== undefined && p.agentSessionId !== envelope.recipientSessionId ||
          credentials && envelope.senderSessionId !== credentials.agentSessionId) fail()
        break
      }
      case 'agent.broadcast': {
        const normalized = normalizeBroadcastInput(input as unknown as import('./agent-message-broadcast.js').AgentMuxMessageBroadcastInput)
        const receipt = parseBroadcastReceipt(p, normalized.operationId, credentials?.agentSessionId, normalized.text)
        if (!isDeepStrictEqual(receipt.targets.map(target => target.agentSessionId), normalized.recipientSessionIds)) fail()
        break
      }
      case 'agent.broadcast.inspect': {
        record(p, ['hostId', 'broadcast']); string(p.hostId)
        if (input.hostId !== undefined && p.hostId !== input.hostId) fail()
        if (p.broadcast !== null) parseBroadcastReceipt(p.broadcast, String(input.operationId), credentials?.agentSessionId)
        break
      }
      case 'agent.discuss': record(p, ['threadId', 'delivery', 'targetAgentSessionId', 'creation']); string(p.threadId); string(p.targetAgentSessionId); if (!isAgentDeliveryState(p.delivery)) fail();
        if (!isDeepStrictEqual(parseAgentCreationFact(p.creation), p.creation)) fail(); break
      case 'agent.spawn.ls': {
        record(p, ['hostId', 'participantSessionId', 'direction', 'creatorRuntimeId', 'records', 'nextCursor', 'coverage'])
        if (p.hostId !== input.hostId || p.participantSessionId !== input.participantSessionId || p.direction !== input.direction ||
          credentials && p.participantSessionId !== credentials.agentSessionId ||
          input.creatorRuntimeId !== undefined && p.creatorRuntimeId !== input.creatorRuntimeId) fail()
        string(p.participantSessionId); member(p.direction, ['created', 'creator']); string(p.creatorRuntimeId, true)
        if (p.nextCursor !== null) string(p.nextCursor)
        const coverage = record(p.coverage, ['scope', 'history'])
        if (coverage.scope !== 'selected-owner' || coverage.history !== 'recorded-creations') fail()
        let previous = ''
        array(p.records, value => {
          const row = record(value, ['agentSessionId', 'phase', 'currentRun', 'createdAt', 'creation'])
          string(row.agentSessionId); const sid = row.agentSessionId as string
          if (Buffer.compare(Buffer.from(sid), Buffer.from(previous)) <= 0) fail(); previous = sid
          member(row.phase, ['prepared', 'active', 'retired']); timestamp(row.createdAt)
          if (row.phase === 'prepared' ? row.currentRun !== null : row.currentRun === null) fail()
          if (row.currentRun !== null) runRef(row.currentRun)
          const creation = parseAgentCreationFact(row.creation)
          const creator = creation.createdBy ?? fail()
          if (!isDeepStrictEqual(creation, row.creation) || row.phase === 'prepared' && creation.createdRun) fail()
          if (p.direction === 'creator' ? sid !== p.participantSessionId : creator.agentSessionId !== p.participantSessionId ||
            (p.creatorRuntimeId === null ? creator.owner.kind !== 'local' : creator.owner.kind !== 'runtime' || creator.owner.runtimeId !== p.creatorRuntimeId)) fail()
        })
        if ((p.records as unknown[]).length > Number(input.limit ?? 50) || p.nextCursor !== null && !(p.records as unknown[]).length) fail()
        break
      }
      case 'agent.handoff': record(p, ['ownerAgentSessionId', 'originAwaits', 'taskId', 'at']); if (!rpcSessionTargetMatches(input.toAgentSessionId, String(p.ownerAgentSessionId)) || p.taskId !== input.taskId || p.originAwaits !== false) fail(); count(p.at); break
      case 'message.inbox.check': case 'message.inbox.ack': {
        record(p, method.endsWith('.check') ? ['consumerId', 'readerRun', 'generation', 'messages'] : ['consumerId', 'readerRun', 'nextGeneration', 'acknowledgedMessageIds'])
        string(p.consumerId); const run = runRef(p.readerRun)
        if (credentials && p.consumerId !== credentials.agentSessionId || input.readerRun !== undefined && run.runId !== runRef(input.readerRun).runId) fail()
        if (method.endsWith('.check')) { count(p.generation); array(p.messages, item => { const envelope = message(item); if (credentials && envelope.recipientSessionId !== credentials.agentSessionId) fail() }) }
        else { count(p.nextGeneration); array(p.acknowledgedMessageIds, item => string(item)) }
        break
      }
      case 'message.dispatch.open': case 'message.dispatch.inspect': case 'message.dispatch.report': dispatch(p, input); break
      case 'message.notify': case 'message.notify.inspect': {
        record(p, ['hostId', 'notification', 'input'])
        if (p.hostId !== input.hostId) fail()
        if (method === 'message.notify.inspect' && p.notification === null) { if (p.input !== null) fail(); break }
        const raw = record(p.notification, ['notificationId', 'key', 'messageIds', 'wire', 'condition', 'mode', 'idle', 'state', 'reason', 'preparedAt', 'resultRecordedAt'])
        const notice = validateMessageNotification(raw as unknown as import('./agent-message-notification.js').AgentMuxMessageNotification)
        if (notice.notificationId !== input.operationId || method === 'message.notify' && (notice.mode !== 'steer' || !isDeepStrictEqual(notice.messageIds, input.messageIds))) fail()
        if (p.input !== null) {
          const receipt = parsePromptSubmissionRecord(p.input)
          if (!isMessageNotificationInput(notice, receipt)) fail()
        }
        break
      }
      case 'message.read': {
        record(p, ['hostId', 'message']); string(p.hostId)
        if (input.hostId !== undefined && p.hostId !== input.hostId) fail()
        if (p.message !== null) {
          const original = record(p.message, ['sequence', 'envelope', 'delivery', 'deliveryMode', 'notification', 'promptCondition', 'execution', 'admissionIntent', 'sourceChannel', 'sourceDevice'])
          const envelope = message(original, input.notificationId as string | undefined)
          if ((input.messageId === undefined ? envelope.operationId !== input.operationId : envelope.messageId !== input.messageId) || credentials && envelope.senderSessionId !== credentials.agentSessionId &&
            envelope.recipientSessionId !== credentials.agentSessionId) fail()
          if (original.execution !== undefined) member(original.execution, ['default', 'immediate'])
          if (original.admissionIntent !== undefined) validateAgentPromptAdmissionIntent(original.admissionIntent)
          if (original.sourceChannel !== undefined) normalizeMessageChannel(original.sourceChannel)
          if (original.sourceDevice !== undefined) normalizeOperationDevice(original.sourceDevice)
        }
        break
      }
      case 'message.events': {
        const page = record(p, ['hostId', 'participantSessionId', 'afterSequence', 'latest', 'beforeSequence', 'throughSequence', 'incarnation', 'messageId', 'broadcastOperationId', 'events', 'nextAfterSequence', 'nextBeforeSequence'])
        string(page.hostId)
        if (input.hostId !== undefined && page.hostId !== input.hostId || credentials && page.participantSessionId !== credentials.agentSessionId) fail()
        const { hostId: _hostId, ...original } = page
        parseMessageEventsPage(original, { ...input, participantSessionId: input.participantSessionId ?? credentials?.agentSessionId } as import('./agent-message-events.js').AgentMuxMessageEventsQuery)
        break
      }
      case 'message.ls': {
        record(p, ['hostId', 'participantSessionId', 'direction', 'messages', 'nextBeforeSequence'])
        string(p.hostId); string(p.participantSessionId); member(p.direction, ['incoming', 'outgoing'])
        if (input.hostId !== undefined && p.hostId !== input.hostId || p.direction !== input.direction ||
          p.participantSessionId !== (input.participantSessionId ?? credentials?.agentSessionId) ||
          credentials && p.participantSessionId !== credentials.agentSessionId) fail()
        const limit = input.limit ?? 50, before = input.beforeSequence ?? Number.MAX_SAFE_INTEGER
        let previous = before as number
        const seen = new Set<string>()
        array(p.messages, item => {
          const entry = record(item, ['sequence', 'envelope', 'delivery', 'deliveryMode', 'notification', 'bodyPreview', 'bodyBytes'])
          count(entry.sequence); count(entry.bodyBytes); text(entry.bodyPreview); delivery(entry.delivery)
          if (entry.sequence === 0 || (entry.sequence as number) >= previous || (entry.bodyPreview as string).length > 240) fail()
          previous = entry.sequence as number
          const metadata = record(entry.envelope, ['schema', 'messageId', 'operationId', 'createdAt', 'sender', 'recipient',
            'threadId', 'correlationId', 'replyTo', 'workspaceId', 'senderSessionId', 'senderRunId', 'recipientSessionId', 'recipientRunId'])
          record(metadata.sender, ['kind', 'agentSessionId']); record(metadata.recipient, ['kind', 'agentSessionId'])
          const envelope = validateAgentMuxMessageEnvelope({ ...metadata, body: '' })
          notificationStatus(entry, envelope)
          if (envelope.sender.kind !== 'agent-session' || envelope.recipient.kind !== 'agent-session' ||
            envelope.sender.agentSessionId !== envelope.senderSessionId || envelope.recipient.agentSessionId !== envelope.recipientSessionId ||
            envelope[p.direction === 'incoming' ? 'recipientSessionId' : 'senderSessionId'] !== p.participantSessionId || seen.has(envelope.messageId)) fail()
          seen.add(envelope.messageId)
        })
        if ((p.messages as unknown[]).length > (limit as number)) fail()
        count(p.nextBeforeSequence, true)
        if (p.nextBeforeSequence !== null && (p.nextBeforeSequence === 0 || p.nextBeforeSequence !== previous ||
          (p.messages as unknown[]).length !== limit)) fail()
        break
      }
      case 'message.dispatch.read': dispatchObservation(p, input); break
      case 'message.dispatch.ls': dispatchPage(p, input); break
      case 'goal.activity': record(p, ['activity', 'diskDurability']); activity(p.activity); member(p.diskDurability, ['confirmed']); break
      case 'app.snapshot': {
        record(p, ['projects', 'workspaces', 'topics', 'motes', 'spaces', 'zones', 'executors', 'agents', 'sessions', 'goals', 'decisions', 'activity', 'unavailable'])
        controlResult('list.projects', { projects: p.projects }); controlResult('list.agents', { agents: p.executors }); controlResult('list.active-agents', { agents: p.agents })
        parseRpcControlResult('goal.ls', { goals: p.goals })
        parseRpcControlResult('space.ls', { catalog: { spaces: p.spaces, zones: p.zones, tabs: [], regions: [], bindings: [], locations: [] } })
        array(p.sessions, item => { string(record(item).routeHostId); status(item, undefined, true) }); activity(p.activity); issues(p.unavailable, true)
        array(p.decisions, item => { const d = record(item, ['goalId', 'decisions']); string(d.goalId); parseRpcControlResult('goal.decisions', d, { goalId: d.goalId }) })
        array(p.workspaces, item => { const w = record(item, ['workspaceId', 'hostId', 'name', 'projectId', 'path', 'kind', 'repoPath', 'branch'])
          for (const key of ['workspaceId', 'hostId', 'path', 'kind']) string(w[key]); text(w.name); for (const key of ['projectId', 'repoPath', 'branch']) string(w[key], true) })
        const topic = (item: unknown) => { const t = record(item, ['id', 'topicId', 'workspaceId', 'hostId', 'path', 'spaceId', 'kind', 'directoryPath', 'topicPath', 'title', 'summary', 'readError', 'soul', 'moteArchive', 'collaborators', 'wiki'])
          for (const key of ['id', 'topicId', 'workspaceId', 'hostId', 'path', 'directoryPath', 'topicPath']) string(t[key]); string(t.spaceId, true); text(t.title); text(t.summary); member(t.kind, ['topic', 'mote', 'unknown'])
          array(t.collaborators, item => { const c = record(item, ['fileName', 'providerId', 'sessionId']); for (const key of ['fileName', 'providerId', 'sessionId']) string(c[key]) })
          if (t.readError !== undefined) text(t.readError)
          if (t.soul !== undefined) { const s = record(t.soul, ['path', 'content', 'version']); string(s.path); text(s.content); string(s.version) }
          if (t.wiki !== undefined) { const w = record(t.wiki, ['path', 'content', 'version', 'source', 'enabled', 'updatedAt']); string(w.path); text(w.content); string(w.version); member(w.source, ['default', 'user']); bool(w.enabled)
            if (w.updatedAt !== null && (typeof w.updatedAt !== 'number' || !Number.isFinite(w.updatedAt) || w.updatedAt < 0)) fail() }
          if (t.moteArchive !== undefined) { const a = record(t.moteArchive); member(a.state, ['active', 'archived', 'unknown']); if (a.state === 'unknown') text(a.issue); else string(a.version) } }
        array(p.topics, topic); array(p.motes, topic); break
      }
      case 'notebook.ls': case 'notebook.apply': {
        record(p, ['state'])
        const state = parseNotebookState(p.state)
        if (method === 'notebook.apply') {
          string(input.operationId)
          const operation = state.operations[input.operationId as string]
          if (!operation || operation.fingerprint !== notebookFingerprint(input.change) ||
            credentials && (operation.actor.kind !== 'agent' || operation.actor.id !== credentials.agentSessionId)) fail()
        }
        break
      }
      case 'notebook.inspect': {
        record(p, ['state', 'notebook', 'pages', 'trail', 'recordedOperation', 'storageOperation', 'resourceChanges', 'conversionIssues', 'content', 'titleOperation'])
        const state = parseNotebookState(p.state)
        const { storageOperation, resourceChanges, conversionIssues, content, titleOperation, ...knowledge } = p
        const observationInput = parseNotebookObservationParams(input, true)
        if (titleOperation !== undefined) { if (!observationInput.operationId) fail(); try { parseNoteTitleInspection(titleOperation, observationInput.operationId!) } catch { fail() } }
        if (observationInput.content === true) { const body = parseNoteContentObservation(content); if (body.noteId !== observationInput.noteId || !noteContentInCatalogScope(state, body)) fail() }
        else if (content !== undefined) fail()
        if (notebookFingerprint(knowledge) !== notebookFingerprint(inspectNotebook(state, input))) fail()
        if (storageOperation !== undefined && storageOperation !== null) { const original = parseNotesStorageOperation(storageOperation); if (input.operationId !== undefined && original.operationId !== input.operationId) fail() }
        if (resourceChanges !== undefined) {
          if (!Array.isArray(resourceChanges)) fail()
          for (const value of resourceChanges as unknown[]) {
            const change = record(value, ['noteId', 'from', 'to', 'conversion']); string(change.noteId)
            for (const original of [change.from, change.to]) {
              record(original, ['hostId', 'workspaceId', 'workspacePath', 'path'])
              try { noteProvenanceResourceKey(original as NoteResource) } catch { fail() }
            }
            if (change.conversion !== undefined) {
              const conversion = record(change.conversion, ['sourceRevision', 'targetRevision'])
              for (const value of [conversion.sourceRevision, conversion.targetRevision]) if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) fail()
            }
          }
        }
        if (conversionIssues !== undefined) {
          if (!Array.isArray(conversionIssues)) fail()
          for (const value of conversionIssues as unknown[]) {
            const issue = record(value, ['noteId', 'resource', 'code', 'message'])
            if (issue.noteId !== null) string(issue.noteId)
            string(issue.code); string(issue.message)
            if (issue.resource !== null) {
              record(issue.resource, ['hostId', 'workspaceId', 'workspacePath', 'path'])
              try { noteProvenanceResourceKey(issue.resource as NoteResource) } catch { fail() }
            }
          }
        }
        break
      }

      case 'notebook.scan': { parseNoteCorpusResult(p, parseNoteCorpusParams(input)); break }
      case 'notebook.graph': { parseNotebookGraph(p, parseNotebookObservationParams(input)); break }
      case 'notebook.resolve': { parseNotebookResolveResult(p, parseNotebookResolveParams(input)); break }

      case 'space.state':
      case 'name.confirm':
      case 'space.commit': {
        record(p,['state'])
        if (p.state === null && method === 'space.state') break
        const state = record(p.state,['schemaVersion','revision','graph','nameCommit'])
        if (state.schemaVersion !== 1) fail(); count(state.revision)
        if ((state.revision as number) < 1) fail()
        if (state.nameCommit !== undefined) {
          const ack = record(state.nameCommit, ['operationId', 'target', 'applied', 'diskDurability', 'issue'])
          string(ack.operationId); const target = record(ack.target, ['kind', 'id']); string(target.kind); string(target.id)
          bool(ack.applied); member(ack.diskDurability, ['confirmed', 'unconfirmed']); if (ack.issue !== null) text(ack.issue)
        }
        parseAgentMuxSpatialGraph(state.graph); break
      }
      case 'name.history': {
        record(p, ['records', 'nextCursor', 'coverage', 'diskAcknowledgement']); array(p.records, item => parseNameChangeRecord(item)); string(p.nextCursor, true); member(p.coverage, ['spatial', 'host']); member(p.diskAcknowledgement, ['not-observed']); break
      }
      case 'space.resolve': {
        record(p,['region','locations'])
        const graph = {spaces:[],zones:[],tabs:[],regions:p.region === null ? [] : [p.region],bindings:[],layouts:{},tabLayouts:{},resources:{}}
        parseAgentMuxSpatialGraph(graph)
        if (p.region !== null && record(p.region).tabId !== record(params).tabId) fail()
        array(p.locations,item => { const l = record(item); if (l.tabId !== record(params).tabId || !p.region || l.regionId !== record(p.region).regionId) fail() })
        break
      }
      case 'system.endpoint': { record(p, ['protocol', 'framing', 'endpoint', 'connection', 'publication']); if (p.publication !== null) parseControlEndpointState(p.publication); member(p.connection, ['responded']); if (p.protocol !== 'jsonrpc-2.0' || p.framing !== 'json-lines') fail()
        const endpoint = record(p.endpoint); member(endpoint.transport, ['unix', 'http', 'ssh', 'relay']); if (endpoint.transport === 'relay') { parseConnectionOffer(endpoint.offer) } else string(endpoint.transport === 'unix' ? endpoint.path : endpoint.transport === 'http' ? endpoint.url : endpoint.host); break }
      case 'system.subscription.cancel': record(p, ['disposed']); bool(p.disposed); break
      case 'system.storage': {
        const p = record(value, ['status', 'run', 'runtime', 'observedAt', 'storage', 'message'])
        const request = rpcRecord(params), run = record(p.run, ['runId']), runtime = record(p.runtime)
        if (run.runId !== request.runId || runtime.hostId !== request.hostId) fail()
        string(run.runId); string(runtime.instanceId); string(runtime.buildIdentity); count(runtime.protocolVersion); count(p.observedAt)
        member(p.status, ['observed', 'unsupported'])
        if (p.status === 'unsupported') { text(p.message); if (p.storage !== undefined) fail(); break }
        if (p.message !== undefined) fail()
        const storage = record(p.storage, ['memory', 'persistence', 'policy'])
        const memory = record(storage.memory, ['firstAvailableByte', 'latestOutputByte'])
        count(memory.firstAvailableByte); count(memory.latestOutputByte)
        if ((memory.firstAvailableByte as number) > (memory.latestOutputByte as number)) fail()
        if (storage.persistence !== null) {
          const owner = record(storage.persistence, ['firstFailure', 'storageFailure', 'actorStopped', 'queuedAppendCommands', 'offeredByte', 'confirmedByte'])
          if (owner.firstFailure !== null) text(owner.firstFailure)
          if (owner.storageFailure !== null) parseAgentMuxStorageFailure(owner.storageFailure)
          bool(owner.actorStopped)
          for (const key of ['queuedAppendCommands', 'offeredByte', 'confirmedByte']) count(owner[key])
        }
        const policy = record(storage.policy, ['memoryPerRunBytes', 'memorySharedBytes', 'replayPerRunBytes', 'replaySharedBytes',
          'databaseBytes', 'walCheckpointBytes', 'terminalHistoryRows', 'terminalCheckpointBytes'])
        for (const key of ['memoryPerRunBytes', 'memorySharedBytes', 'replayPerRunBytes', 'replaySharedBytes',
          'databaseBytes', 'walCheckpointBytes', 'terminalHistoryRows', 'terminalCheckpointBytes']) count(policy[key])
        break
      }
      case 'system.doctor': {
        record(p, ['ok', 'host', 'runtime', 'runtimeAction', 'runtimeStorage', 'runtimeStorageUnavailable', 'hosts', 'agents', 'integration']); bool(p.ok)
        const host = record(p.host); if (host.kind !== 'local') fail(); bool(host.reachable)
        for (const key of ['hostId', 'buildIdentity', 'runtimeInstanceId', 'error', 'action']) { if (host[key] !== null) text(host[key]) }
        count(host.protocolVersion, true); const hosts = record(p.hosts); member(record(hosts.local).status, ['available', 'unavailable']); if (record(hosts.remote).status !== 'unsupported') fail()
        array(p.agents, item => { const a = record(item); string(a.id); string(a.label); string(a.executable); member(a.probe, ['found', 'missing', 'unverifiable', 'blocked']); record(a.capabilities); record(a.hook); record(a.hookInstallation); record(a.acp) })
        if (record(p.integration).hookIngress !== 'authenticated-loopback') fail()
        for (const key of ['runtimeAction', 'runtimeStorageUnavailable']) if (p[key] !== null) text(p[key])
        for (const key of ['runtime', 'runtimeStorage']) if (p[key] !== null) record(p[key])
        break
      }
      case 'agent.output': fail() // Only subscription initial + ordered notifications are public.
      default: fail()
    }
    return p
  } catch (error) {
    if (error instanceof AgentMuxError && error.code === 'CONTROL_PROTOCOL_ERROR') throw error
    return fail()
  }
}

import * as controlCodec from './control-codec.js'
function controlResult(operation: string, result: Record<string, unknown>): void {
  controlCodec.parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'rpc-core-observation', operation, ok: true, result })
}
