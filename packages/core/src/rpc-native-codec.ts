import { isGoalDelegationMethod, parseGoalDelegationParams, parseGoalDelegationResult } from './goal-delegation.js'
import { isMoteAvatarWriteMethod, parseMoteAvatarWriteParams, parseMoteAvatarWriteResult } from './mote-avatar-write.js'
import { isMoteAvatarSeriesMethod, parseMoteAvatarSeriesParams, parseMoteAvatarSeriesResult } from './mote-avatar-series.js'
import { parseDiagnosticEvidenceResult } from './diagnostic-evidence-codec.js'
import { parseControlEndpointState } from './control-endpoint-state.js'
import { parseNotesStorageOperation } from './notes-storage.js'
import { parseControlDemandActivity } from './control-codec.js'
import { parseDeliveryAttemptLookup, parseDeliveryFailure } from './delivery-attempt.js'
import { validateAgentInputWaitRef, type AgentInputSubmissionReceipt } from './agent-input-wait.js'

import { parseFileUploadIdentity, parseFileUploadParams, parseFileUploadResult } from './public-rpc-files.js';

import { isDeepStrictEqual } from 'node:util'
import { parseAgentMuxSpatialGraph } from './spatial-graph.js'
import { normalizeAgentTimelineMutation } from './session-timeline.js'
import { normalizeSessionHistoryPage } from './session-history.js'
import { parseAgentContextParams } from './agent-context.js'
import { parseConnectionOffer } from '@agentmux/relay/offer'
import { normalizeMessageChannel } from './message-origin.js'
import { normalizeOperationDevice } from './operation-device.js'
import { inspectNotebook, notebookFingerprint, parseNotebookState } from './notebook-catalog.js'
import { isTopicMethod, parseTopicParams, parseTopicResult } from './public-rpc-topics.js'
import { isFileMethod, parseFileCreateParams, parseFileCreateResult, parseFileWriteParams, parseFileWriteResult, parseFileReadParams, parseFileReadResult, parseFileListParams, parseFileListResult } from './public-rpc-files.js'
import { isGitMethod, parseGitParams, parseGitResult } from './public-rpc-git.js'
import { isScheduleMethod, parseScheduleRpcParams, validateScheduleRpcResult } from './public-rpc-schedules.js'
import { parseAgentNativeSessionConfirmation } from './agent-native-session-confirmation.js'
import { parseAgentNativeResumeSource } from './agent-native-sessions.js'
import { parseNativeHistoryParams, parseNativeHistoryResult, parseNativeHistoryResourceParams, parseNativeHistoryResourceResult } from './public-rpc-native-history.js'
import { parseNameChangeRecord } from './display-label.js'
import { AgentMuxError } from './errors.js'
import { parseAgentSessionHistoryReadPage, type AgentSessionHistoryReadInput } from './session-history-reader.js'
import { parseSessionHistoryResourceResult, type AgentSessionHistoryResourceParams } from './session-history-resource.js'
import { parseHostedBootstrap } from './hosted-value.js'
import { AGENTMUX_AGENT_MESSAGING_RULES } from './agent-messaging-guidance.js'
import { normalizeAgentSession, parsePromptSubmissionRecord } from './agent-session-store.js'
import { agentInteractionResponseUnavailableReason } from './agent-interaction-state.js'
import { validateAgentMuxMessageEnvelope } from './agent-global-message-queue.js'
import { agentPromptInputId, validateAgentPromptAdmissionIntent, validateAgentPromptCondition, validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { resolveAgentSessionId } from './agent-session-id.js'
import { assertDispatchEventKind } from './agent-handoff.js'
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
function inputReceipt(value: unknown): AgentInputSubmissionReceipt {
  const p = record(value, ['key', 'ref', 'originalControlOperationId', 'persistence', 'control', 'admission', 'status', 'observation'])
  const key = validateAgentPromptInputKey(p.key), ref = validateAgentInputWaitRef(p.ref)
  if (!isDeepStrictEqual(key, ref.key) || p.persistence !== 'confirmed') fail()
  member(p.observation, ['owned', 'rejoin-needed', 'closed'])
  if (p.originalControlOperationId !== undefined) string(p.originalControlOperationId)
  const control = record(p.control, ['ref', 'state', 'at', 'waiting', 'gateId'])
  if (!isDeepStrictEqual(validateAgentInputWaitRef(control.ref), ref)) fail()
  member(control.state, ['enabled', 'stopped-before-dispatch', 'dispatch-authorized']); timestamp(control.at)
  if (control.state === 'dispatch-authorized') string(control.gateId)
  else if (control.gateId !== undefined) fail()
  if (control.waiting !== undefined) {
    const waiting = record(control.waiting, ['phase', 'reason', 'wake', 'failure', 'mechanism', 'observation'])
    if (waiting.phase === 'runtime') { if (waiting.reason !== 'runtime-unavailable' || waiting.wake !== 'runtime-restored') fail() }
    else if (waiting.phase === 'authorization') { if (waiting.reason !== 'author-authorization-needed' || waiting.wake !== 'explicit-rejoin') fail() }
    else if (waiting.phase === 'observer') { if (waiting.reason !== 'observer-stopped' || waiting.wake !== 'explicit-rejoin' || waiting.failure === undefined) fail() }
    else if (waiting.phase === 'service') { if (waiting.reason !== 'observation-failed' || waiting.wake !== 'explicit-rejoin' || waiting.failure === undefined) fail() }
    else { if (waiting.phase !== 'native-environment' || !['original-environment-unconfirmed', 'original-target-changed'].includes(String(waiting.reason)) || waiting.wake !== 'explicit-rejoin') fail() }
    if (waiting.failure !== undefined) parseDeliveryFailure(waiting.failure)
    if (waiting.mechanism !== undefined) member(waiting.mechanism, ['unconfirmed', 'unavailable'])
    if (waiting.observation !== undefined) {
      const observed = record(waiting.observation, ['phase', 'failure']); string(observed.phase)
      if (observed.failure !== undefined) parseDeliveryFailure(observed.failure)
      else if (waiting.phase === 'native-environment') fail()
    }
  }
  const admission = p.admission === null ? null : parsePromptSubmissionRecord(p.admission)
  if (admission && (admission.agentSessionId !== key.agentSessionId || admission.run.runId !== key.expectedRun.runId ||
      admission.admission?.inputKey && !isDeepStrictEqual(admission.admission.inputKey, key) ||
      (admission.admission?.submissionId ?? admission.terminalPromptSubmission?.submissionId ?? admission.admission?.operationId) !== agentPromptInputId(key))) fail()
  const native = admission?.admission
  const linked = native?.transport === 'native' && native.inputDispatch && control.state === 'dispatch-authorized' &&
    isDeepStrictEqual(native.inputDispatch.ref, ref) && native.inputDispatch.gateId === control.gateId
  const status = native?.transport === 'native' && linked ? native.native.outcome === 'admitted' && native.acknowledged ? 'admitted'
    : native.native.outcome === 'not-applied' && native.notApplied ? 'not-applied' : 'unknown'
    : admission || control.state === 'dispatch-authorized' ? 'unknown' : control.state === 'stopped-before-dispatch' ? 'stopped' : 'waiting'
  if (p.status !== status) fail()
  return value as AgentInputSubmissionReceipt
}
function promptExecution(value: unknown): void {
  if (value === undefined) return
  const capability = record(value, ['immediate'])
  member(capability.immediate, ['interrupt-before-input', 'native-steer'])
}
function agentCapabilities(value: unknown): void {
  const capabilities = record(value)
  promptExecution(capabilities.promptExecution)
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
  if (Object.hasOwn(source, 'hookBindingId') || Object.hasOwn(source, 'hookToken')) fail()
  try {
    const session = normalizeAgentSession(source)
    if (source.nativeHandlePersistence !== undefined) {
      if (!session.nativeHandle) fail()
      member(source.nativeHandlePersistence, ['confirmed', 'unconfirmed'])
      session.nativeHandlePersistence = source.nativeHandlePersistence as 'confirmed' | 'unconfirmed'
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
  const p = record(value, [...(routed ? ['routeHostId'] : []), 'session', 'run', 'capabilities', 'observation', 'interactionResponseUnavailableReason']), session = parseRpcAgentSession(p.session)
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
function message(value: unknown): ReturnType<typeof validateAgentMuxMessageEnvelope> {
  const p = record(value); count(p.sequence); delivery(p.delivery)
  const envelope = validateAgentMuxMessageEnvelope(p.envelope)
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
  if (!Array.isArray(p.replies) || p.replies.length !== events.length) fail()
  let replyIndex = 0
  array(p.replies, value => {
    const reply = message(value), event = events[replyIndex++]!
    const cleanup = event.kind === 'cleanup'
    if (reply.messageId !== event.replyMessageId || reply.replyTo !== source.messageId || reply.threadId !== source.threadId ||
      reply.senderSessionId !== (cleanup ? supervision.ownerAgentSessionId : supervision.workerAgentSessionId) ||
      reply.recipientSessionId !== (cleanup ? supervision.workerAgentSessionId : supervision.ownerAgentSessionId)) fail()
  })
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
    if (isGoalDelegationMethod(method)) return parseGoalDelegationResult(value, parseGoalDelegationParams(method, params)) as unknown as Record<string, unknown>
    if (isMoteAvatarWriteMethod(method)) return parseMoteAvatarWriteResult(method, value, parseMoteAvatarWriteParams(method, params)) as unknown as Record<string, unknown>
    if (isMoteAvatarSeriesMethod(method)) return parseMoteAvatarSeriesResult(method, value, parseMoteAvatarSeriesParams(method, params)) as unknown as Record<string, unknown>
    if (isGitMethod(method)) return parseGitResult(method, value, parseGitParams(method, params)) as unknown as Record<string, unknown>
    if (isFileMethod(method)) return (method === 'file.upload' || method === 'file.upload.inspect' ? parseFileUploadResult(value, method === 'file.upload' ? parseFileUploadParams(params) : parseFileUploadIdentity(params)) : method === 'file.create' ? parseFileCreateResult(value, parseFileCreateParams(params)) : method === 'file.write' ? parseFileWriteResult(value, parseFileWriteParams(params)) : method === 'file.list' ? parseFileListResult(value, parseFileListParams(params)) : parseFileReadResult(value, parseFileReadParams(params))) as unknown as Record<string, unknown>
    if (isHostSettingsMethod(method)) return parseHostSettingsResult(method, value, parseHostSettingsParams(method, params)) as unknown as Record<string, unknown>
    if (isScheduleMethod(method)) return validateScheduleRpcResult(method, value, parseScheduleRpcParams(method, params)) as unknown as Record<string, unknown>
    if (isTopicMethod(method)) return parseTopicResult(method, value, parseTopicParams(method, params)) as unknown as Record<string, unknown>
    if (isAgentMuxRpcDeviceMethod(method)) return parseAgentMuxRpcDeviceResult(method, value,
      parseAgentMuxRpcDeviceParams(method, params)) as unknown as Record<string, unknown>
    const p = record(value), input = record(params)
    if (['schemaVersion', 'requestId', 'operation'].some(key => Object.hasOwn(p, key))) fail()
    switch (method) {
      case 'system.diagnostics.inspect': return parseDiagnosticEvidenceResult(value, input) as unknown as Record<string, unknown>
      case 'message.delivery.inspect': return parseDeliveryAttemptLookup(value, input.logId as string) as unknown as Record<string, unknown>
      case 'message.delivery.report': return parseDeliveryAttemptLookup(value, (input.record as import('./delivery-attempt.js').DeliveryAttempt).logId) as unknown as Record<string, unknown>
      case 'agent.native.ls': {
        record(p, ['hostId', 'executorId', 'providerId', 'capabilities', 'availability', 'sessions', 'issues'])
        string(p.hostId); string(p.executorId); string(p.providerId)
        record(p.capabilities, ['terminal', 'timeline', 'permission', 'providerResume', 'providerFork', 'replyCorrelation', 'promptExecution', 'usage'])
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
        const confirmation = record(p.confirmation, ['operationId', 'run', 'previousNativeHandle', 'nativeHandle', 'observedAt', 'candidateObservedAt', 'previousInteraction', 'previousPromptSubmissionId'])
        if (p.persisted !== true || session.agentSessionId !== request.agentSessionId || session.run.runId !== request.expectedRun.runId ||
          confirmation.operationId !== request.operationId || runRef(confirmation.run).runId !== request.expectedRun.runId ||
          confirmation.candidateObservedAt !== request.expectedObservationAt || !isDeepStrictEqual(confirmation.previousNativeHandle, request.expectedNativeHandle) ||
          !isDeepStrictEqual(confirmation.nativeHandle, request.candidateNativeHandle)) fail()
        bool(p.current)
        const current = isDeepStrictEqual(session.nativeConfirmation, confirmation) && isDeepStrictEqual(session.nativeHandle, request.candidateNativeHandle)
        if (p.current !== current || ![session.nativeConfirmation, ...(session.nativeConfirmationHistory ?? [])].some(value => isDeepStrictEqual(value, confirmation))) fail()
        count(confirmation.observedAt)
        break
      }
      case 'agent.context': {
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
            const item = record(value, ['id', 'agentSessionId', 'kind', 'status', 'source', 'createdAt', 'updatedAt', 'title', 'authorAgentSessionId', 'authorHuman', 'sourceDevice', 'sourceChannel', 'content', 'toolName', 'toolInput', 'toolOutput', 'eventName', 'activityState'])
            if (item.agentSessionId !== expected.agentSessionId) fail()
            const mutation = normalizeAgentTimelineMutation({ type: 'append', agentSessionId: expected.agentSessionId, item })
            if (mutation.type !== 'append' || !isDeepStrictEqual(mutation.item, item)) fail()
          })
        }
        if (p.native !== null) {
          const page = record(p.native, ['agentSessionId', 'source', 'items', 'nextCursor', 'sourceSizeBytes'])
          if (page.agentSessionId !== expected.agentSessionId) fail()
          const source = record(page.source, ['providerId', 'nativeSessionId']); string(source.providerId); string(source.nativeSessionId)
          if (descriptor.history !== undefined && record(descriptor.history).providerId !== source.providerId) fail()
          const handle = descriptor.history === undefined ? undefined : record(descriptor.history).nativeHandle
          if (handle !== undefined && record(handle).kind === 'provider' && (record(handle).sessionId !== source.nativeSessionId || record(handle).providerId !== source.providerId)) fail()
          const normalized = normalizeSessionHistoryPage(source as { providerId: string; nativeSessionId: string }, page, expected.limit ?? 30)
          const { agentSessionId: _sid, ...body } = page
          if (!isDeepStrictEqual(normalized, body)) fail()
          if (page.sourceSizeBytes !== undefined) count(page.sourceSizeBytes)
        }
        array(p.unavailable, value => { const issue = record(value, ['source', 'code', 'message', 'recovery']); member(issue.source, ['captured', 'native', 'session', 'status', 'runtime']); string(issue.code); text(issue.message); text(issue.recovery) })
        string(p.nextCursor, true)
        if (p.runtimeDiagnostics !== null) {
          const d = record(p.runtimeDiagnostics, ['nodeVersion', 'platform', 'arch', 'supported', 'ctxmux'])
          for (const key of ['nodeVersion', 'platform', 'arch']) string(d[key]); bool(d.supported)
          const kernel = record(d.ctxmux, ['state', 'serving', 'bundled', 'ready', 'capabilities']), state = record(kernel.state, ['configuredDirectory', 'servingDirectory'])
          string(state.configuredDirectory); string(state.servingDirectory, true); bool(kernel.ready)
          const serving = record(kernel.serving, ['buildIdentity', 'protocolVersion', 'instanceId', 'sourceCommit']); string(serving.buildIdentity); string(serving.instanceId); count(serving.protocolVersion); if (serving.sourceCommit !== null) fail()
          const bundled = record(kernel.bundled, ['version', 'sourceCommit', 'artifactPlatform']); for (const key of ['version', 'sourceCommit', 'artifactPlatform']) string(bundled[key])
          const capabilities = record(kernel.capabilities, ['transport', 'orderedOutputBytes', 'boundedReplay', 'recoverableInput', 'resize', 'interrupt', 'completeStop'])
          if (capabilities.transport !== 'local-unix') fail(); for (const key of ['orderedOutputBytes', 'boundedReplay', 'recoverableInput', 'resize', 'interrupt', 'completeStop']) if (capabilities[key] !== true) fail()
        }
        break
      }
      case 'runtime.bootstrap': parseRpcHostedBootstrap(p); break
      case 'runtime.invoke': record(p, ['value']); if (!Object.hasOwn(p, 'value')) fail(); break
      case 'runtime.release-consumer': record(p, ['released']); bool(p.released); break
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
      case 'agent.history': return parseAgentSessionHistoryReadPage(value, input as AgentSessionHistoryReadInput)
      case 'agent.inspect': case 'whoami': {
        record(p, method === 'whoami' ? ['session', 'status', 'view', 'topic', 'messaging', 'unavailable'] : ['routeHostId', 'session', 'status', 'displayName', 'unavailable'])
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
        if (method === 'agent.inspect') { string(p.routeHostId); const name = record(p.displayName, ['override', 'nameRevision', 'availability']); if (name.override !== null) text(name.override); if (name.nameRevision !== null) count(name.nameRevision); member(name.availability, ['observed', 'unavailable']) }
        else { text(p.topic); const messaging = record(p.messaging, Object.keys(AGENTMUX_AGENT_MESSAGING_RULES))
          for (const [key, rule] of Object.entries(AGENTMUX_AGENT_MESSAGING_RULES)) if (messaging[key] !== rule) fail()
          const view = record(p.view); bool(view.attached)
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
      case 'agent.ls': record(p, ['sessions', 'errors']); array(p.sessions, item => { string(record(item).routeHostId); status(item, undefined, true) }); array(p.errors, item => { const error = record(item, ['agentSessionId', 'hostId', 'code', 'message']); string(error.agentSessionId, true); string(error.hostId); string(error.code); text(error.message) }); break
      case 'agent.role.ls': record(p, ['bindings']); array(p.bindings, item => role(item)); break
      case 'agent.role.register': case 'agent.role.resolve': { record(p, ['binding']); const binding = role(p.binding)
        if (binding.role !== input.role || input.workspacePath !== undefined && binding.workspacePath !== input.workspacePath ||
          method === 'agent.role.register' && credentials && binding.agentSessionId !== credentials.agentSessionId) fail(); break }
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
              (original.admission?.submissionId ?? original.terminalPromptSubmission?.submissionId ?? original.admission?.operationId) !== agentPromptInputId(key) ||
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
        record(p, ['queueId', 'receiptId', 'messageId', 'sequence', 'envelope', 'delivery', 'promptCondition', 'agentSessionId', 'sourceChannel', 'sourceDevice', 'admissionIntent', 'inputReceipt'])
        if (p.sourceChannel !== undefined) normalizeMessageChannel(p.sourceChannel)
        if (p.sourceDevice !== undefined) normalizeOperationDevice(p.sourceDevice)
        const envelope = message(p)
        if (p.inputReceipt !== undefined) {
          const receipt = inputReceipt(p.inputReceipt)
          if (receipt.key.kind !== 'message' || receipt.key.messageId !== envelope.messageId || receipt.originalControlOperationId !== envelope.operationId ||
              receipt.key.agentSessionId !== envelope.recipientSessionId || receipt.key.expectedRun.runId !== envelope.recipientRunId ||
              p.delivery && (p.delivery as { state?: string }).state === 'delivered' && receipt.status !== 'admitted') fail()
        }
        if (p.admissionIntent !== undefined) {
          const intent = validateAgentPromptAdmissionIntent(p.admissionIntent)
          if (intent.kind !== 'manual-actor' || input.execution !== 'immediate' || intent.expectedRun.runId !== envelope.recipientRunId) fail()
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
      case 'agent.discuss': record(p, ['threadId', 'delivery', 'targetAgentSessionId']); string(p.threadId); string(p.targetAgentSessionId); if (!isAgentDeliveryState(p.delivery)) fail(); break
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
        record(p, ['state', 'notebook', 'pages', 'trail', 'recordedOperation', 'storageOperation'])
        const state = parseNotebookState(p.state)
        const { storageOperation, ...knowledge } = p
        if (notebookFingerprint(knowledge) !== notebookFingerprint(inspectNotebook(state, input))) fail()
        if (storageOperation !== undefined && storageOperation !== null) { const original = parseNotesStorageOperation(storageOperation); if (input.operationId !== undefined && original.operationId !== input.operationId) fail() }
        break
      }

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
          const owner = record(storage.persistence, ['firstFailure', 'actorStopped', 'queuedAppendCommands', 'offeredByte', 'confirmedByte'])
          if (owner.firstFailure !== null) text(owner.firstFailure)
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
