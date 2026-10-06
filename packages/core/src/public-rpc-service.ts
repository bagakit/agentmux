import { isGoalDelegationMethod, parseGoalDelegationParams, parseGoalDelegationResult, type GoalDelegationsOwner } from './goal-delegation.js'
import { isMoteAvatarWriteMethod, parseMoteAvatarWriteParams, parseMoteAvatarWriteResult, type AgentMuxRpcMoteAvatarsOwner, type MoteAvatarWriteMethod } from './mote-avatar-write.js'
import { parseAppearanceObservation, type AgentMuxAppearanceObservationPort } from './public-rpc-settings-observation.js'
import { isMoteAvatarSeriesMethod, parseMoteAvatarSeriesParams, parseMoteAvatarSeriesResult, type MoteAvatarSeriesMethod } from './mote-avatar-series.js'
import { DiagnosticEvidenceQuery } from '@agentmux/diagnostic-evidence'
import { parseDiagnosticEvidenceParams, parseDiagnosticEvidenceResult } from './diagnostic-evidence-codec.js'
import { inspectDiagnosticEvidence } from './diagnostic-evidence-service.js'
import { DeliveryAttemptStore } from './delivery-attempt-store.js'
import { parseDeliveryAttempt, validateDeliveryLogId, type DeliveryAttemptLookup } from './delivery-attempt.js'
import { parseAgentContextParams, readAgentContext, forwardAgentContextParams, forwardAgentContextPage } from './agent-context.js'

import { parseNotebookObservationParams, type NotebookObservationPort } from './notebook-observation.js'
import { inspectNotebook } from './notebook-catalog.js'
import { AgentMuxNotebookStore } from './notebook-store.js'
import { normalizeMessageChannel } from './message-origin.js'

import { parseFileUploadIdentity, parseFileUploadParams, parseFileUploadResult, type AgentMuxRpcFileUploadsOwner, type FileMethod } from './public-rpc-files.js';
import { isTopicMethod, parseTopicParams, parseTopicResult, type AgentMuxRpcTopicsOwner, type TopicMethod } from './public-rpc-topics.js'
import { isFileMethod, parseFileCreateParams, parseFileCreateResult, parseFileWriteParams, parseFileWriteResult, parseFileReadParams, parseFileReadResult, parseFileListParams, parseFileListResult, type AgentMuxRpcFilesOwner } from './public-rpc-files.js'
import { isGitMethod, parseGitParams, parseGitResult, type AgentMuxRpcGitOwner, type GitMethod } from './public-rpc-git.js'
import { isScheduleMethod, parseScheduleRpcParams, validateScheduleRpcResult, type AgentMuxRpcSchedulesOwner, type ScheduleMethod } from './public-rpc-schedules.js'
import { AgentMuxSpatialStateStore, spatialCatalog, resolveSpatialRegion } from './spatial-state.js'
import { displayLabel, type AgentMuxNameContext } from './display-label.js'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { parseAgentNativeSessionConfirmation } from './agent-native-session-confirmation.js'
import type { AgentMuxClient } from './client.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxMessageTargetCandidates, agentMuxControlTimeoutMs,
  type AgentMuxControlHost, type AgentMuxControlRequest, type AgentMuxControlResult,
  type AgentMuxControlCaller, type AgentMuxDemand } from './control.js'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from './control-codec.js'
import { AgentMuxError } from './errors.js'
import { readAgentSessionHistory, validateSessionHistoryReadInput, isUserMessageHistoryRead } from './session-history-reader.js'
import { parseSessionHistoryResourceParams, parseSessionHistoryResourceResult } from './session-history-resource.js'
import { AGENTMUX_AGENT_MESSAGING_RULES } from './agent-messaging-guidance.js'
import { classifySelfViewFailure, SELF_CONTEXT_TOPIC_HINT } from './agent-self-context.js'
import { resolveAgentSessionId } from './agent-session-id.js'
import { readAgentRoleBindings, registerAgentRole, resolveAgentRole } from './agent-role-directory.js'
import { DurableAgentMuxMessageQueue, appendGlobalMessage, prepareGlobalMessagePrompt, recordGlobalMessageDelivery,
  recordGlobalMessageDeliveryIssue } from './agent-global-message-queue.js'
import { agentPromptCondition, validateAgentPromptCondition, validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { validateAgentInputControlId, validateAgentInputWaitRef, type AgentInputSubmissionReceipt, type AgentInputCallContext } from './agent-input-wait.js'
import { diagnoseAgentMux } from './doctor.js'
import { agentSessionMatches } from './rpc-agent-filter.js'
import { OrderedSessionOutputFollow, type FollowOutput } from './session-output-follow.js'
import { defaultAgentMuxControlSocketPath } from './runtime-paths.js'
import { AGENTMUX_HOSTED_RPC_METHODS, AGENTMUX_HOSTED_RPC_FIELDS, type AgentMuxHostedRuntimeMethod, type AgentMuxRuntimeFence } from './hosted-client-contract.js'
import type { AgentMuxHostedRuntimeService } from './hosted-runtime-service.js'
import type { AgentMuxRpcSubscriptionOptions, AgentMuxRpcSubscription } from './public-rpc-client.js'
import { AgentMuxRpcError, rpcFailure } from './public-rpc-frame.js'
import { isAgentMuxRpcDeviceMethod, parseAgentMuxRpcDeviceParams, parseAgentMuxRpcDeviceResult,
  type AgentMuxRpcDeviceAdministration } from './public-rpc-device.js'
import { normalizeOperationDevice } from './operation-device.js'
import { rpcControlRequest, rpcControlResult, assertControlResultTarget, rpcRecord, rpcString, rpcText, rpcCount } from './rpc-business-codec.js'
import { parseRpcNativeResult } from './rpc-native-codec.js'
import { parseNativeHistoryParams, parseNativeHistoryResult, parseNativeHistoryResourceParams, parseNativeHistoryResourceResult } from './public-rpc-native-history.js'
import { isHostSettingsMethod, parseHostSettingsParams, parseHostSettingsResult, type HostSettingsMethod } from './public-rpc-host-settings.js'
import { AGENTMUX_RPC_CONTROL_METHODS, AGENTMUX_RPC_NATIVE_METHODS, type AgentMuxRpcMethod,
  type AgentMuxRpcParams, type AgentMuxRpcResult, type AgentMuxRpcCredentials,
  type AgentMuxRpcSnapshotParams, type AgentMuxRpcSnapshot, type AgentMuxRpcStreamMethod,
  type AgentMuxRpcStreamInitial, type AgentMuxRpcStreamEvent, type AgentMuxRpcUnavailable, type AgentMuxRpcPrincipal } from './public-rpc.js'

/** A structural slice of the original public SDK; hosted clients need no private fields. */
export type AgentMuxRpcCorePort = Pick<AgentMuxClient,
  'reopenAgent' | 'reconcileAgentReopen' | 'agentSessions' | 'readAgentSessions' | 'readAgentSessionHistory' | 'sessionHistorySources' | 'sessionHistoryPage' | 'sessionHistoryResource' | 'sessionTimeline' | 'authorizeRetainedAgentCaller' | 'agentMessageQueuePath' |
  'agentSession' | 'refreshAgentSession' | 'confirmAgentNativeSession' | 'resolveAgentSession' | 'statusAgent' |
  'observeAgentOutput' | 'replySessionQuestion' | 'submitAgentMessage' | 'inspectAgentPromptSubmission' | 'startDiscussion' | 'checkDeliveries' |
  'inspectAgentInput' | 'stopAgentInputWaiting' | 'rejoinAgentInputWaiting' |
  'ackDeliveryBatch' | 'openDispatch' | 'showDispatch' | 'readMessage' | 'readDispatch' | 'listDispatches' | 'recordDispatchEvent' |
  'catalog' | 'connect' | 'inspectManagedHooks' | 'probeAgent' | 'probeExecutorAvailability' | 'listHostNativeAgentSessions' | 'readHostNativeAgentHistory' | 'readHostNativeAgentHistoryResource' |
  'readDeliveryAttempt' | 'observeRunStorage' | 'runtimeDiagnostics' | 'runtimeIdentity' | 'agentCreationAuthority' | 'listTrustedCreationSources' | 'trustCreationSource' | 'listHostExecutors' | 'configureHostExecutor'> & {
    runtimeOwnerIdentity?: import('./hosted-client-contract.js').AgentMuxHostedClient['runtimeOwnerIdentity']
    forwardRpc?: import('./hosted-client-contract.js').AgentMuxHostedForwardRpc
    handOff(...args: Parameters<AgentMuxClient['handOff']>):
      Awaited<ReturnType<AgentMuxClient['handOff']>> | Promise<Awaited<ReturnType<AgentMuxClient['handOff']>>>
  }
export type AgentMuxRpcCoreClient = { hostId: string; client: AgentMuxRpcCorePort }
export type AgentMuxRpcServiceOptions = Partial<AgentMuxControlHost> & {
  goalDelegations?: GoalDelegationsOwner
  moteContext?: import('./diagnostic-evidence.js').AgentMuxMoteContextEvidencePort
  deliveryAttempts?: { hostId: string; store: DeliveryAttemptStore }
  /** Original semantic owner identity; never ctxmux identity or a route alias. */
  diagnosticCoreAuthority?(scope: AgentMuxRpcCoreClient): import('./diagnostic-evidence.js').AgentMuxDiagnosticAuthorityObservation | Promise<import('./diagnostic-evidence.js').AgentMuxDiagnosticAuthorityObservation>
  notebookStore?: AgentMuxNotebookStore
  notebookObservation?: NotebookObservationPort
  files?: AgentMuxRpcFilesOwner
  git?: AgentMuxRpcGitOwner
  fileUploads?: AgentMuxRpcFileUploadsOwner
  moteAvatars?: AgentMuxRpcMoteAvatarsOwner
  topics?: AgentMuxRpcTopicsOwner

  appearance?: AgentMuxAppearanceObservationPort
  schedules?: AgentMuxRpcSchedulesOwner
  spatialState?: AgentMuxSpatialStateStore
  /** Optional host aggregation of original named owners; Core interprets no host target kinds. */
  nameHistory?(query: import('./display-label.js').AgentMuxNameHistoryQuery): Promise<import('./display-label.js').AgentMuxNameHistoryPage>
  endpoint?: import('./public-rpc.js').AgentMuxRpcEndpoint
  endpointPublication?(): import('./control-endpoint-state.js').AgentMuxControlEndpointState
  /** Borrow existing SDK clients. Their lifecycle remains with their host. */
  coreClients?(): readonly AgentMuxRpcCoreClient[] | Promise<readonly AgentMuxRpcCoreClient[]>
  /** Client-owned real filesystem/config observations, not a second registry. */
  snapshot?(params: AgentMuxRpcSnapshotParams): Promise<Partial<AgentMuxRpcSnapshot>>
  /** Native catalog uses the selected Host's original Executor configuration. */
  nativeAgentSessions?(params: AgentMuxRpcParams<'agent.native.ls'>): Promise<AgentMuxRpcResult<'agent.native.ls'>>
  /** Read the selected Executor's exact persisted source; cancellation ends only this reader. */
  nativeAgentHistory?(params: AgentMuxRpcParams<'agent.native.history'>,
    readContext?: Pick<AgentMuxRpcCallContext, 'signal'>): Promise<AgentMuxRpcResult<'agent.native.history'>>
  nativeAgentHistoryResource?(params: AgentMuxRpcParams<'agent.native.history.resource'>,
    readContext?: Pick<AgentMuxRpcCallContext, 'signal'>): Promise<AgentMuxRpcResult<'agent.native.history.resource'>>
  /** Original Host Authority and native confirmation owner; never constructed here. */
  deviceAdministration?: AgentMuxRpcDeviceAdministration
  /** Original Desktop consumes its in-memory, trusted IPC user intent. */
  /** Original Host supplies transport-authenticated operation attribution. */
  operationSource?(context: AgentMuxRpcCallContext): import('./types.js').AgentOperationDevice | undefined
  recordDeviceOperation?(source: import('./types.js').AgentOperationDevice, method: string, args: unknown[], result: 'confirmed' | 'failed' | 'unknown', operationId: string): Promise<void>
  /** Borrow the Host's original SDK business owner; never connect a second Runtime. */
  hostedRuntime?(): Pick<AgentMuxHostedRuntimeService, 'call' | 'subscribe' | 'assertFence'> |
    Promise<Pick<AgentMuxHostedRuntimeService, 'call' | 'subscribe' | 'assertFence'>>
  /** Forward canonical GUI work before its original business orchestration begins. */
  forwardControl?<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>,
    context: AgentMuxRpcCallContext): Promise<AgentMuxRpcResult<M>>
  forwardSubscription?<M extends AgentMuxRpcStreamMethod>(method: M, params: import('./public-rpc.js').AgentMuxRpcStreamParams<M>,
    handlers: AgentMuxRpcSubscriptionOptions<M>, context: AgentMuxRpcCallContext): Promise<AgentMuxRpcSubscription>
}
export type AgentMuxRpcCallContext = { caller?: AgentMuxRpcCredentials; signal?: AbortSignal; principal?: AgentMuxRpcPrincipal;
  /** Only the actual Host/transport supplies this current author restriction. */
  assertCurrent?(): void | Promise<void>;
  runtimeFence?: AgentMuxRuntimeFence; afterResponse?: Array<() => void | Promise<void>>;
  /** Actual receiving hop, supplied only by the transport owner. */
  transport?: 'unix' | 'http' | 'relay' }
export type AgentMuxRpcServiceSubscription<M extends AgentMuxRpcStreamMethod = AgentMuxRpcStreamMethod> = {
  initial: AgentMuxRpcStreamInitial<M>; start?(): void | Promise<void>; dispose(): void | Promise<void>
}
const NATIVE_FIELDS = {
  'goal.delegation.prepare': ['goalId', 'intent', 'materials'], 'goal.delegation.bind': ['goalId', 'intent'], 'goal.delegate': ['goalId', 'intent', 'materials'],
  'goal.report': ['goalId', 'operationId', 'report'], 'goal.collect': ['goalId', 'operationId', 'collection'], 'goal.delegations': ['goalId'],
  'settings.appearance.watch': [],
  'notebook.ls': [], 'notebook.inspect': ['notebookId','noteId','operationId','content','maxBytes'], 'notebook.graph': ['notebookId','noteId','maxBytes'], 'notebook.apply': ['expectedRevision','operationId','change'],
  'space.state': [], 'space.commit': ['expectedRevision','graph','allowEntityRemoval','removedProjectGroupIds'],
  'space.resolve': ['tabId','regionId','direction'],
  'name.history': ['target','afterId','limit'],
  'name.confirm': ['operationId'],
  whoami: [], 'agent.ls': ['agentSessionId', 'executorId', 'status', 'since', 'limit'],
  'agent.inspect': ['target'],
  'agent.native.confirm': ['agentSessionId', 'expectedRun', 'expectedNativeHandle', 'candidateNativeHandle', 'expectedObservationAt', 'operationId'],
  'agent.native.ls': ['hostId', 'executorId', 'workspacePath'],
  'agent.native.history': ['hostId', 'executorId', 'source', 'cursor', 'limit'],
  'agent.native.history.resource': ['hostId', 'executorId', 'nativeSource', 'source', 'turnId', 'recordId', 'partIndex', 'expectedReference', 'maxBytes', 'offsetBytes'],
  'agent.context': ['hostId', 'agentSessionId', 'cursor', 'limit'],
  'agent.question.reply': ['agentSessionId', 'source', 'turnId', 'recordId', 'answers', 'operationId', 'expectedRun', 'afterSubmissionId', 'allowUncertainTurn', 'sourceChannel'],
  'agent.history.resource': ['hostId', 'agentSessionId', 'source', 'turnId', 'recordId', 'partIndex', 'expectedReference', 'maxBytes', 'offsetBytes'],
  'agent.history': ['hostId', 'agentSessionId', 'source', 'limit', 'cursor', 'maxBytes', 'kind', 'query', 'scanLimit'],
  'agent.reopen': ['agentSessionId', 'expectedRetiredAt', 'operationId', 'args', 'env', 'commandOverride', 'launchOptions', 'cols', 'rows'], 'agent.reopen.check': ['agentSessionId', 'expectedRetiredAt', 'operationId'], 'agent.role.ls': ['workspacePath'],
  'agent.role.register': ['role', 'providerId'], 'agent.role.resolve': ['role', 'workspacePath'],
  'agent.input.inspect': ['key', 'kind', 'originalControlOperationId'],
  'agent.input.stop': ['ref', 'cancelOperationId'], 'agent.input.rejoin': ['ref'],
  'agent.send': ['target', 'text', 'messageId', 'threadId', 'correlationId', 'replyTo', 'operationId', 'execution', 'expectedRun', 'sourceChannel'],
  'agent.discuss': ['executorId', 'providerId', 'text', 'operationId'],
  'agent.handoff': ['toAgentSessionId', 'taskId'], 'agent.output': ['agentSessionId', 'afterByte', 'follow'],
  'system.diagnostics.inspect': ['target', 'includeRaw', 'includeRelated', 'budget'],
  'message.delivery.inspect': ['logId', 'hostId'], 'message.delivery.report': ['hostId', 'record'],
  'message.inbox.check': ['limit'], 'message.inbox.ack': ['generation', 'readerRun'],
  'message.read': ['operationId', 'hostId'],
  'message.dispatch.open': ['sourceMessageId'], 'message.dispatch.inspect': ['sourceMessageId'],
  'message.dispatch.read': ['sourceMessageId', 'hostId'],
  'message.dispatch.ls': ['hostId', 'participantSessionId', 'afterSourceMessageId', 'limit'],
  'message.dispatch.report': ['sourceMessageId', 'replyMessageId', 'kind'],
  'app.snapshot': ['projectId', 'workspaceId', 'topicId', 'agentSessionId', 'goalId', 'executorId', 'assigneeSessionId', 'supervisorSessionId', 'status', 'since', 'limit', 'include'],
  'goal.activity': ['goalId', 'projectId', 'agentSessionId', 'assigneeSessionId', 'supervisorSessionId', 'status', 'since', 'limit'],
  'system.storage': ['hostId', 'runId'], 'system.doctor': ['workspacePath'], 'system.endpoint': [],
  'system.subscription.cancel': ['subscriptionId']
} as const satisfies Record<Exclude<keyof typeof AGENTMUX_RPC_NATIVE_METHODS, import('./public-rpc-device.js').AgentMuxRpcDeviceMethod | AgentMuxHostedRuntimeMethod | MoteAvatarSeriesMethod | MoteAvatarWriteMethod | TopicMethod | HostSettingsMethod | import('./public-rpc-files.js').FileMethod | GitMethod | ScheduleMethod>, readonly string[]>

function cause(error: unknown, fallback = 'CONTROL_FAILED') {
  return { code: error instanceof AgentMuxError ? error.code : fallback,
    message: error instanceof Error ? error.message : String(error) }
}
function readerError(error: unknown): Extract<AgentMuxRpcStreamEvent<AgentMuxRpcStreamMethod>, { type: 'error' }>['error'] {
  const failure = rpcFailure(null, error).error!
  return { ...rpcRecord(failure.data), message: failure.message } as Extract<AgentMuxRpcStreamEvent<AgentMuxRpcStreamMethod>, { type: 'error' }>['error']
}
function unavailable(error: unknown): AgentMuxRpcUnavailable {
  return { ...cause(error), recovery: 'Read this exact object again after its original owner is available.' }
}
function bytes({ dataBytes, ...range }: FollowOutput) {
  return { ...range, dataBase64: Buffer.from(dataBytes).toString('base64') }
}
function validateFilters(p: Record<string, unknown>): void {
  for (const field of ['projectId', 'workspaceId', 'topicId', 'agentSessionId', 'goalId', 'executorId', 'assigneeSessionId', 'supervisorSessionId', 'status']) {
    if (p[field] !== undefined) rpcString(p[field], field)
  }
  if (p.since !== undefined) rpcCount(p.since, 0)
  if (p.limit !== undefined) rpcCount(p.limit, 100, 1000)
}

/** All business orchestration lives here; transports carry messages, clients parse argv. */
export class AgentMuxRpcService {
  private readonly diagnosticQuery = new DiagnosticEvidenceQuery()
  private readonly notebooks: AgentMuxNotebookStore
  private readonly spatial: AgentMuxSpatialStateStore
  private local: Promise<AgentMuxClient> | undefined
  constructor(private readonly ports: AgentMuxRpcServiceOptions = {}) { this.spatial = ports.spatialState ?? new AgentMuxSpatialStateStore(); this.notebooks = ports.notebookStore ?? new AgentMuxNotebookStore() }

  private async hosted(method: AgentMuxRpcMethod, params: unknown, context: AgentMuxRpcCallContext) {
    // Native SDK writes are authorized as a user/device by the transport. An
    // Agent capability remains confined to agent.* and cannot mint source:user.
    if (context.caller !== undefined || !context.principal ||
      !['user', 'device'].includes(context.principal.kind)) {
      throw new AgentMuxError('The runtime domain requires a transport-approved user or device, without a managed Agent caller.', 'AGENT_CAPABILITY_INVALID')
    }
    const principalId = rpcString(context.principal.id, 'Transport principal')
    const p = rpcRecord(params, AGENTMUX_HOSTED_RPC_FIELDS[method as AgentMuxHostedRuntimeMethod])
    if (!this.ports.hostedRuntime) throw new AgentMuxError('The borrowed Runtime Host business owner is unavailable. Existing Runs are retained.', 'CONTROL_UNAVAILABLE')
    const owner = await this.ports.hostedRuntime()
    if (method === 'runtime.owner.identity' || method === 'runtime.owner.shutdown') return { owner, params: p }
    const consumer = rpcString(p.consumerId, 'Host consumer ID')
    const consumerId = createHash('sha256').update(context.principal.kind + '\0' + principalId + '\0' + consumer).digest('hex')
    return { owner, params: { ...p, consumerId } }
  }

  private async assertRuntimeFence(context: AgentMuxRpcCallContext): Promise<void> {
    if (!context.runtimeFence) return
    if (!this.ports.hostedRuntime) throw new AgentMuxError('The original semantic Runtime owner is unavailable. No operation was rerouted.', 'CONTROL_UNAVAILABLE')
    ;(await this.ports.hostedRuntime()).assertFence(context.runtimeFence)
  }

  private async clients(): Promise<readonly AgentMuxRpcCoreClient[]> {
    if (this.ports.coreClients) return await this.ports.coreClients()
    this.local ??= import('./runtime-client.js').then(({ connectLocalAgentMux }) => connectLocalAgentMux())
    return [{ hostId: 'local', client: await this.local }]
  }
  async dispose(): Promise<void> {
    // A borrowed SDK client belongs to RuntimeController. Only close this service's
    // own SDK connection; closing a reader/connection does not stop an Agent Run.
    const local = this.local; this.local = undefined
    if (local) { try { await (await local).dispose() } catch { /* The owner reports Runtime availability separately. */ } }
  }
  private endpointUnverified(client: AgentMuxRpcCorePort): boolean {
    return typeof client.runtimeOwnerIdentity === 'function' && client.runtimeOwnerIdentity()?.availability !== 'connected'
  }
  private async ownedSessions({ hostId, client }: AgentMuxRpcCoreClient) {
    if (this.endpointUnverified(client)) throw new AgentMuxError('This endpoint inventory is unverified; its last-seen Session references were retained.', 'RUNTIME_UNAVAILABLE')
    // A remote Store keeps its local Host facts. The configured Host ID is only our route.
    return (await client.readAgentSessions()).filter(session => session.hostId === (client.forwardRpc ? 'local' : hostId))
  }
  private async owner(id: string) {
    const clients = await this.clients()
    const known = clients.filter(({ client }) => !this.endpointUnverified(client) &&
      client.agentSessions().some(session => session.agentSessionId === id))
    // Known exact targets do not wait for unrelated endpoint discovery. Authorization
    // and Session binding still come from this original owner's durable Store below.
    const scopes = known.length === 1 ? known : clients
    const observed = await Promise.allSettled(scopes.map(async scope => {
      const sessions = await this.ownedSessions(scope)
      // Retained identities participate in prefix ambiguity, never in live inventory.
      // An exact active target needs no history discovery or unrelated owner handshake.
      const identities = sessions.some(session => session.agentSessionId === id) ? []
        : (await scope.client.sessionHistorySources()).filter(session =>
          session.hostId === (scope.client.forwardRpc ? 'local' : scope.hostId)).map(session => session.agentSessionId)
      return { entries: sessions.map(session => ({ ...scope, session, agentSessionId: session.agentSessionId })), identities }
    }))
    const entries = observed.flatMap(item => item.status === 'fulfilled' ? item.value.entries : [])
    const retainedIdentities = observed.flatMap(item => item.status === 'fulfilled' ? item.value.identities : [])
    const issues = observed.flatMap((item, index) => item.status === 'rejected'
      ? [unavailable(new AgentMuxError(`Session facts on Host ${scopes[index]!.hostId} are unconfirmed: ${cause(item.reason).message}`,
        this.endpointUnverified(scopes[index]!.client) ? 'RUNTIME_UNAVAILABLE' : 'AGENT_SESSION_STORE_READ_UNCONFIRMED'))] : [])
    if (issues.length && !entries.some(entry => entry.agentSessionId === id)) {
      throw new AgentMuxError('Session prefix or absence cannot be confirmed while an owner is unavailable. Existing Runs are kept.',
        issues.some(issue => issue.code === 'RUNTIME_UNAVAILABLE') ? 'RUNTIME_UNAVAILABLE' : 'AGENT_SESSION_STORE_READ_UNCONFIRMED')
    }
    const agentSessionId = resolveAgentSessionId(id, [...entries.map(entry => entry.agentSessionId), ...retainedIdentities])
    const owners = entries.filter(entry => entry.agentSessionId === agentSessionId)
    if (owners.length === 0) throw new AgentMuxError(`Unknown Agent Session: ${id}`, 'UNKNOWN_AGENT_SESSION')
    if (owners.length !== 1) throw new AgentMuxError(`Agent Session ${JSON.stringify(agentSessionId)} has multiple authoritative route Hosts: ${owners.map(owner => JSON.stringify(owner.hostId)).join(', ')}. Select the original service endpoint explicitly; no owner was chosen.`, 'AMBIGUOUS_AGENT_SESSION')
    return { ...owners[0]!, unavailable: issues }
  }
  private async originalInputOwner(agentSessionId: string, caller?: AgentMuxRpcCoreClient): Promise<AgentMuxRpcCoreClient> {
    // An exact semantic endpoint (or authenticated participant scope) already
    // fixes the owner. The original input journal proves the key/ref; an active
    // Session catalogue cannot add authority or be required to recover it.
    const scopes = caller ? [caller] : await this.clients()
    if (scopes.length === 1) {
      const scope = scopes[0]!
      if (this.endpointUnverified(scope.client)) throw new AgentMuxError(
        'The original semantic endpoint is unconfirmed. No input was rerouted.', 'RUNTIME_UNAVAILABLE')
      return { hostId: scope.hostId, client: scope.client }
    }
    // Aggregate endpoints still require an authoritative route. Never choose a
    // first Host or search unrelated input journals to guess an original owner.
    const scope = await this.owner(agentSessionId)
    if (scope.agentSessionId !== agentSessionId) throw new AgentMuxError(
      'Input control requires the exact original Session.', 'INVALID_AGENT_INPUT_CONTROL')
    return scope
  }
  private async authenticated(context: AgentMuxRpcCallContext) {
    if (!context.caller) return undefined
    const caller = rpcRecord(context.caller, ['agentSessionId', 'capability'])
    const agentSessionId = rpcString(caller.agentSessionId, 'Caller Session ID')
    const capability = rpcString(caller.capability, 'Caller capability')
    const scopes = await this.clients()
    if (scopes.length === 1 && !this.endpointUnverified(scopes[0]!.client)) {
      const scope = scopes[0]!
      try {
        // One confirmed semantic endpoint already fixes the route. Authenticate
        // the exact durable identity; no unrelated inventory is an ingress gate.
        const session = await scope.client.authorizeRetainedAgentCaller(capability, agentSessionId)
        if (session.agentSessionId !== agentSessionId || session.hostId !== (scope.client.forwardRpc ? 'local' : scope.hostId)) throw new AgentMuxError(
          'Caller identity does not belong to this exact semantic Host.', 'AGENT_CAPABILITY_INVALID')
        return { ...scope, agentSessionId, capability, session, unavailable: [] }
      } catch (error) {
        // A prefix/undiscovered identity keeps the existing discovery semantics.
        // Invalid authority and unreadable durable facts never fall back to a cache.
        if (!(error instanceof AgentMuxError) || error.code !== 'UNKNOWN_AGENT_SESSION') throw error
      }
    }
    const owner = await this.owner(agentSessionId)
    // The claim must be exact. A capability cannot authenticate an ambiguous/prefix identity.
    if (owner.agentSessionId !== agentSessionId) throw new AgentMuxError('Caller Session ID must be exact.', 'AGENT_CAPABILITY_INVALID')
    const session = await owner.client.authorizeRetainedAgentCaller(capability, agentSessionId)
    return { ...owner, capability, session }
  }
  private requireCaller<T>(caller: T | undefined): T {
    if (!caller) throw new AgentMuxError('This method requires an authenticated managed Agent.', 'MANAGED_AGENT_CONTEXT_REQUIRED')
    return caller
  }
  private inputCallContext(context: AgentMuxRpcCallContext): AgentInputCallContext {
    const assertCurrent = context.assertCurrent ?? (context.principal?.kind === 'device' ? () => {
      throw new AgentMuxError('The original Host device authorization is unconfirmed; the saved input remains waiting.', 'CONTROL_UNAVAILABLE')
    } : undefined)
    return { ...(context.signal ? { requestSignal: context.signal } : {}), ...(assertCurrent ? { assertCurrent } : {}) }
  }
  private async inputForwardContext(context: AgentMuxRpcCallContext): Promise<AgentMuxRpcCallContext> {
    await this.inputCallContext(context).assertCurrent?.()
    const { assertCurrent: _localRestriction, ...forwarded } = context
    return forwarded
  }
  private async execute(request: AgentMuxControlRequest, context?: AgentMuxNameContext): Promise<AgentMuxControlResult> {
    if (!this.ports.execute && ['space.ls','space.inspect','space.bind','space.unbind'].includes(request.operation)) {
      const state = await this.spatial.readForLayout()
      if (!state) throw new AgentMuxError('No durable spatial graph has been registered.', 'SPATIAL_STATE_ABSENT')
      if (request.operation === 'space.ls' || request.operation === 'space.inspect') {
        if ('requestId' in request.target) throw new AgentMuxError('No mutation journal is attached to this headless owner.', 'CONTROL_UNAVAILABLE')
        return {operation:request.operation,catalog:spatialCatalog(state.graph,request.target)}
      }
      if (request.operation === 'space.bind' || request.operation === 'space.unbind') {
        const next = await this.spatial.bind(request.binding,request.operation === 'space.unbind')
        return {operation:request.operation,requestId:request.requestId,binding:request.binding,catalog:spatialCatalog(next.graph),
          outcome:JSON.stringify(state.graph) === JSON.stringify(next.graph) ? 'unchanged' : request.operation === 'space.bind' ? 'linked' : 'unlinked',
          save:{layoutApplied:true,localStorageWritten:false,storageFlushRequested:false,diskDurability:'confirmed',reason:null},issues:[]}
      }
    }
    if (!this.ports.execute) throw new AgentMuxError('The original Desktop business owner is unavailable.', 'CONTROL_UNAVAILABLE')
    const result = await this.ports.execute(request, context)
    if (result.operation !== request.operation) throw new AgentMuxError('Business owner returned another operation.', 'CONTROL_PROTOCOL_ERROR')
    const { operation, ...body } = result
    const parsed = parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: request.requestId, operation, ok: true, result: body })
    if (!parsed.ok) throw new AgentMuxError('Business owner returned an invalid result.', 'CONTROL_PROTOCOL_ERROR')
    const validated = { operation, ...parsed.result } as AgentMuxControlResult
    assertControlResultTarget(request, validated)
    return validated
  }
  private request(operation: AgentMuxControlRequest['operation'], body: Record<string, unknown> = {}) {
    return parseAgentMuxControlRequest({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: randomUUID(), operation, ...body })
  }
  async call<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>,
    context: AgentMuxRpcCallContext = {}): Promise<AgentMuxRpcResult<M>> {
    if (isAgentMuxRpcDeviceMethod(method)) {
      const local = context.caller === undefined && context.transport === 'unix' && context.principal?.kind === 'user'
      const device = context.caller === undefined && context.transport === 'relay' && context.principal?.kind === 'device'
      if (method === 'device.hello' ? !device : !local) throw new AgentMuxError('This device operation requires its authorized transport principal.', 'CONTROL_PERMISSION_DENIED')
      const input = parseAgentMuxRpcDeviceParams(method, params)
      if (!this.ports.deviceAdministration) throw new AgentMuxError('The original Host device administration owner is unavailable.', 'CONTROL_UNAVAILABLE')
      context.signal?.throwIfAborted()
      return parseAgentMuxRpcDeviceResult(method, await this.ports.deviceAdministration.call(method, input, context), input) as AgentMuxRpcResult<M>
    }
    if (Object.hasOwn(AGENTMUX_HOSTED_RPC_METHODS, method)) {
      const hosted = await this.hosted(method, params, context)
      const inputContext = this.inputCallContext(context)
      return await hosted.owner.call(method, hosted.params, {
        ...(context.principal ? { principal: context.principal } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
        ...(inputContext.assertCurrent ? { assertCurrent: inputContext.assertCurrent } : {}),
        ...(this.ports.operationSource?.(context) ? { sourceDevice: this.ports.operationSource!(context) } : {}),
        ...(this.ports.recordDeviceOperation ? { recordDeviceOperation: this.ports.recordDeviceOperation } : {}),
        ...(context.afterResponse ? { afterResponse: context.afterResponse } : {})
      }) as AgentMuxRpcResult<M>
    }
    await this.assertRuntimeFence(context)
    if (isHostSettingsMethod(method)) {
      const input = parseHostSettingsParams(method, params)
      if (method === 'settings.hosts.trust-source' &&
          (context.caller !== undefined || context.principal?.kind !== 'user')) {
        throw new AgentMuxError('Creation-source trust requires a transport-approved user without a managed Agent caller.', 'CONTROL_PERMISSION_DENIED')
      }
      await this.authenticated(context)
      const targets = (await this.clients()).filter(entry => entry.hostId === input.hostId)
      context.signal?.throwIfAborted()
      if (!targets.length && this.ports.forwardControl) {
        const result = await this.ports.forwardControl<HostSettingsMethod>(method, input, context)
        return parseHostSettingsResult(method, result, input) as AgentMuxRpcResult<M>
      }
      if (targets.length !== 1) throw new AgentMuxError('The exact route Host is unknown or ambiguous.', targets.length ? 'AMBIGUOUS_AGENT_SESSION' : 'UNKNOWN_HOST')
      const client = targets[0]!.client
      if (method !== 'settings.executors.discover' && method !== 'settings.executors.register') await client.connect()
      if (method === 'settings.executors.discover') {
        const query = parseHostSettingsParams('settings.executors.discover', params)
        const result = { routeHostId: query.hostId, ...await client.listHostExecutors({ refresh: query.refresh ?? true }) }
        return parseHostSettingsResult(method, result, input) as AgentMuxRpcResult<M>
      }
      if (method === 'settings.executors.register') {
        const query = parseHostSettingsParams('settings.executors.register', params)
        const result = { routeHostId: query.hostId, ...await client.configureHostExecutor({ executorId: query.executorId, ...query.input }) }
        return parseHostSettingsResult(method, result, input) as AgentMuxRpcResult<M>
      }
      const authority = await client.agentCreationAuthority()
      const result = method === 'settings.hosts.trusted-sources'
        ? { routeHostId: input.hostId, authority, sources: await client.listTrustedCreationSources() }
        : { routeHostId: input.hostId, authority, source: client.runtimeOwnerIdentity
          // A Hosted call carries input only. The target transport supplies its own principal.
          ? await client.trustCreationSource((input as import('./public-rpc-host-settings.js').HostSettingsParameterMap['settings.hosts.trust-source']).input)
          : await client.trustCreationSource((input as import('./public-rpc-host-settings.js').HostSettingsParameterMap['settings.hosts.trust-source']).input,
              { kind: 'user', id: rpcString(context.principal!.id, 'Transport principal') }) }
      return parseHostSettingsResult(method, result, input) as AgentMuxRpcResult<M>
    }
    if (method === 'agent.native.confirm') {
      if (context.caller !== undefined || !context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id) {
        throw new AgentMuxError('Native conversation confirmation requires a transport-approved user or device.', 'CONTROL_PERMISSION_DENIED')
      }
      const input = parseAgentNativeSessionConfirmation(params), scope = await this.owner(input.agentSessionId)
      if (scope.agentSessionId !== input.agentSessionId) throw new AgentMuxError('Native confirmation requires the exact Session ID.', 'INVALID_AGENT_NATIVE_CONFIRMATION')
      context.signal?.throwIfAborted()
      if (scope.client.forwardRpc) return await scope.client.forwardRpc('agent.native.confirm', input, context) as AgentMuxRpcResult<M>
      return await scope.client.confirmAgentNativeSession(input) as AgentMuxRpcResult<M>
    }
    if (method === 'agent.reopen' || method === 'agent.reopen.check') {
      if (context.caller !== undefined || !context.principal ||
        !['user', 'device'].includes(context.principal.kind) || !context.principal.id) {
        throw new AgentMuxError('Continuing a retired conversation requires a transport-approved user or device.', 'CONTROL_PERMISSION_DENIED')
      }
      const input = rpcRecord(params, method === 'agent.reopen' ? NATIVE_FIELDS['agent.reopen'] : NATIVE_FIELDS['agent.reopen.check']), agentSessionId = rpcString(input.agentSessionId, 'Exact retired Session ID')
      if (agentSessionId === 'self') throw new AgentMuxError('Continue requires the exact retired Session ID.', 'INVALID_CONTROL_REQUEST')
      const clients = await this.clients()
      const owners = await Promise.all(clients.map(async entry => ({ ...entry,
        sources: await entry.client.sessionHistorySources() })))
      const matches = owners.filter(entry => entry.sources.some(source => source.agentSessionId === agentSessionId &&
        source.hostId === (entry.client.forwardRpc ? 'local' : entry.hostId) && (source.state === 'retired' || method === 'agent.reopen.check')))
      if (matches.length !== 1) throw new AgentMuxError('The exact retired Session does not have one confirmed Host owner.', matches.length ? 'AMBIGUOUS_AGENT_SESSION' : 'STALE_AGENT_SESSION')
      const client = matches[0]!.client
      context.signal?.throwIfAborted()
      await client.connect()
      return { session: method === 'agent.reopen'
        ? await client.reopenAgent(input as unknown as Parameters<AgentMuxClient['reopenAgent']>[0])
        : await client.reconcileAgentReopen(input as unknown as Parameters<AgentMuxClient['reconcileAgentReopen']>[0]) } as AgentMuxRpcResult<M>
    }
    if (method === 'message.delivery.report' && (context.caller !== undefined || !context.principal ||
      !['user', 'device'].includes(context.principal.kind) || !context.principal.id.trim())) {
      throw new AgentMuxError('A client diagnostic report needs its transport-authenticated user or device.', 'CONTROL_PERMISSION_DENIED')
    }
    if (method === 'message.pending.edit' || method === 'message.pending.send' || method === 'message.pending.stop' ||
        method === 'message.pending.archive' || method === 'message.pending.restore' || method === 'agent.question.reply') {
      if (context.caller !== undefined || !context.principal ||
          !['user', 'device'].includes(context.principal.kind) || typeof context.principal.id !== 'string' ||
          !context.principal.id.trim() || context.principal.id.includes('\0')) {
        throw new AgentMuxError('Editing or submitting a human pending draft requires a transport-approved user or device. A managed Agent can use agent.send with its authenticated message envelope; the original draft and Agent remain available.', 'AGENT_CAPABILITY_INVALID')
      }
    }
    if (method === 'goal.confirm' || method === 'goal.accept') {
      if (context.caller !== undefined || !context.principal || !['user', 'device'].includes(context.principal.kind) || typeof context.principal.id !== 'string' || !context.principal.id.trim() || context.principal.id.includes('\0')) {
        throw new AgentMuxError('Goal confirmation and result acceptance require a transport-approved person or device.', 'CONTROL_PERMISSION_DENIED')
      }
    }
    const caller = await this.authenticated(context)
    if (isGoalDelegationMethod(method)) {
      const input = parseGoalDelegationParams(method, params)
      if (!this.ports.goalDelegations) {
        if (this.ports.forwardControl) return await this.ports.forwardControl(method, input as AgentMuxRpcParams<M>, context) as AgentMuxRpcResult<M>
        throw new AgentMuxError('The original Goal delegation owner is unavailable. Original work and message identities remain available.', 'CONTROL_UNAVAILABLE')
      }
      const actor = caller ? { kind: 'agent' as const, id: caller.agentSessionId }
        : context.principal && ['user', 'device'].includes(context.principal.kind) ? context.principal : null
      if (!actor) throw new AgentMuxError('Goal delegation requires its authenticated Agent, person or device.', 'CONTROL_PERMISSION_DENIED')
      return parseGoalDelegationResult(await this.ports.goalDelegations.call(method, input, context,
        { actor: actor as { kind: 'agent' | 'user' | 'device'; id: string },
          ...(caller ? { hostId: caller.hostId, runId: caller.session.run.runId } : {}) }), input) as AgentMuxRpcResult<M>
    }

    if (isGitMethod(method)) {
      const input = parseGitParams(method, params)
      context.signal?.throwIfAborted()
      if (!this.ports.git && !this.ports.forwardControl) throw new AgentMuxError('The original Desktop Git owner is unavailable. Original workspaces and Agents remain available.', 'CONTROL_UNAVAILABLE')
      const result = this.ports.git ? await this.ports.git.call<GitMethod>(method, input, context) : await this.ports.forwardControl!<GitMethod>(method, input, context)
      return parseGitResult(method, result, input) as AgentMuxRpcResult<M>
    }
    if (isFileMethod(method)) {
      if (method === 'file.upload' || method === 'file.upload.inspect') {
        const input = method === 'file.upload' ? parseFileUploadParams(params) : parseFileUploadIdentity(params)
        context.signal?.throwIfAborted()
        if (method === 'file.upload') {
          const original = await this.owner(input.agentSessionId)
          if (original.agentSessionId !== input.agentSessionId || original.hostId !== input.hostId || original.session.run.runId !== input.expectedRun.runId) {
            throw new AgentMuxError('The upload target changed. Original files, draft and Agent remain available.', 'FILE_UPLOAD_TARGET_MISMATCH')
          }
        }
        if (input.hostId !== 'local') {
          const routes = (await this.clients()).filter(route => route.hostId === input.hostId)
          const route = routes.length === 1 ? routes[0] : undefined
          if (!route?.client.forwardRpc) throw new AgentMuxError('The original Host has no file upload owner. Its Agent and the local file are retained.', 'FILE_UPLOAD_HOST_UNAVAILABLE')
          const remoteInput = { ...input, hostId: 'local' }
          const remote = await route.client.forwardRpc(method, remoteInput as never)
          const receipt = parseFileUploadResult(remote, remoteInput)
          return parseFileUploadResult({ ...receipt, hostId: input.hostId }, input) as AgentMuxRpcResult<M>
        }
        if (!this.ports.fileUploads) throw new AgentMuxError('The original Host file upload owner is unavailable. Original files and Agents are retained.', 'FILE_UPLOAD_HOST_UNAVAILABLE')
        const result = method === 'file.upload' ? await this.ports.fileUploads.upload(input as import('./public-rpc-files.js').FileUploadParams)
          : await this.ports.fileUploads.inspect(input)
        return parseFileUploadResult(result, input) as AgentMuxRpcResult<M>
      }
      if (method === 'file.create') {
        const input = parseFileCreateParams(params)
        context.signal?.throwIfAborted()
        if (!this.ports.files && !this.ports.forwardControl) throw new AgentMuxError('The original Host file owner is unavailable. Original files and Agents are retained.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files ? await this.ports.files.create(input, { actor: caller ? { kind: 'agent', id: caller.agentSessionId } : context.principal }) : await this.ports.forwardControl!('file.create', input, context)
        return parseFileCreateResult(result, input) as AgentMuxRpcResult<M>
      }

      if (method === 'file.write') {
        const input = parseFileWriteParams(params)
        context.signal?.throwIfAborted()
        if (!this.ports.files && !this.ports.forwardControl) throw new AgentMuxError('The original Host file owner is unavailable. Original files and Agents are retained.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files ? await this.ports.files.write(input, { actor: caller ? { kind: 'agent', id: caller.agentSessionId } : context.principal }) : await this.ports.forwardControl!('file.write', input, context)
        return parseFileWriteResult(result, input) as AgentMuxRpcResult<M>
      }

      if (method === 'file.list') {
        const input = parseFileListParams(params)
        context.signal?.throwIfAborted()
        if (!this.ports.files && !this.ports.forwardControl) throw new AgentMuxError('The original Host file owner is unavailable. Original files and Agents are retained.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files ? await this.ports.files.list(input) : await this.ports.forwardControl!('file.list', input, context)
        return parseFileListResult(result, input) as AgentMuxRpcResult<M>
      }
      const input = parseFileReadParams(params)
      context.signal?.throwIfAborted()
      if (!this.ports.files && !this.ports.forwardControl) throw new AgentMuxError('The original Host file owner is unavailable. Original files and Agents are retained.', 'CONTROL_UNAVAILABLE')
      const result = this.ports.files ? await this.ports.files.read(input) : await this.ports.forwardControl!('file.read', input, context)
      return parseFileReadResult(result, input) as AgentMuxRpcResult<M>
    }
    if (isScheduleMethod(method)) {
      const scheduleMethod: ScheduleMethod = method
      const input = parseScheduleRpcParams(scheduleMethod, params)
      context.signal?.throwIfAborted()
      if (!this.ports.schedules && !this.ports.forwardControl) throw new AgentMuxError('The original Host arrangement owner is unavailable. Saved arrangements and Agents are retained.', 'CONTROL_UNAVAILABLE')
      const result = this.ports.schedules ? await this.ports.schedules.call<ScheduleMethod>(scheduleMethod, input, context) : await this.ports.forwardControl!<ScheduleMethod>(scheduleMethod, input, context)
      return validateScheduleRpcResult<ScheduleMethod>(scheduleMethod, result, input) as AgentMuxRpcResult<M>
    }
    if (isMoteAvatarWriteMethod(method)) {
      const input = parseMoteAvatarWriteParams(method, params)
      if (!this.ports.moteAvatars && !this.ports.forwardControl) throw new AgentMuxError('The original Host avatar owner is unavailable. The saved appearance is retained.', 'CONTROL_UNAVAILABLE')
      const result = this.ports.moteAvatars ? await this.ports.moteAvatars.call<MoteAvatarWriteMethod>(method, input)
        : await this.ports.forwardControl!<MoteAvatarWriteMethod>(method, input, context)
      return parseMoteAvatarWriteResult(method, result, input) as AgentMuxRpcResult<M>
    }
    if (isMoteAvatarSeriesMethod(method)) {
      const input = parseMoteAvatarSeriesParams(method, params)
      if (!this.ports.moteAvatars && !this.ports.forwardControl) throw new AgentMuxError('The original Host avatar source owner is unavailable. Saved avatars and work remain available.', 'CONTROL_UNAVAILABLE')
      context.signal?.throwIfAborted()
      const result = this.ports.moteAvatars ? await this.ports.moteAvatars.call<MoteAvatarSeriesMethod>(method, input)
        : await this.ports.forwardControl!<MoteAvatarSeriesMethod>(method, input, context)
      return parseMoteAvatarSeriesResult(method, result, input) as AgentMuxRpcResult<M>
    }
    if (isTopicMethod(method)) {
      const input = parseTopicParams(method, params)
      if (!this.ports.topics && !this.ports.forwardControl) throw new AgentMuxError('The original Host Topic content owner is unavailable. Existing content and Agents remain available.', 'CONTROL_UNAVAILABLE')
      context.signal?.throwIfAborted()
      const result = this.ports.topics ? await this.ports.topics.call(method, input, context)
        : await this.ports.forwardControl!<TopicMethod>(method, input, context)
      return parseTopicResult(method, result, input) as AgentMuxRpcResult<M>
    }
    const p = rpcRecord(params)
    if (method === 'agent.question.reply') {
      const input = rpcRecord(params, NATIVE_FIELDS['agent.question.reply']) as AgentMuxRpcParams<'agent.question.reply'>
      const target = await this.owner(rpcString(input.agentSessionId, 'Question Session ID'))
      context.signal?.throwIfAborted()
      if (target.client.forwardRpc) return await target.client.forwardRpc('agent.question.reply', { ...input, agentSessionId: target.agentSessionId }, context) as AgentMuxRpcResult<M>
      await target.client.connect()
      const sourceDevice = this.ports.operationSource?.(context)
      return await target.client.replySessionQuestion({ ...input, agentSessionId: target.agentSessionId, authorHuman: true, sourceChannel: normalizeMessageChannel(input.sourceChannel ?? 'api'),
        ...(sourceDevice ? { sourceDevice } : {}),
        ...(context.signal ? { signal: context.signal } : {}) }) as AgentMuxRpcResult<M>
    }
    if (method === 'agent.history.resource') {
      const input = parseSessionHistoryResourceParams(params)
      const owners = (await this.clients()).filter(entry => entry.hostId === input.hostId)
      if (owners.length !== 1) throw new AgentMuxError('The exact resource Host owner is unavailable or ambiguous.', 'RUNTIME_UNAVAILABLE')
      const client = owners[0]!.client
      context.signal?.throwIfAborted()
      let result: AgentMuxRpcResult<'agent.history.resource'>
      if (client.forwardRpc) {
        const { caller: _localCaller, ...readContext } = context
        const forwarded = { ...input, hostId: 'local' }
        const remote = parseSessionHistoryResourceResult(await client.forwardRpc('agent.history.resource', forwarded, readContext), forwarded)
        result = { ...remote, hostId: input.hostId }
      } else {
        const { hostId, agentSessionId, ...request } = input
        const descriptor = (await client.sessionHistorySources()).find(entry => entry.hostId === hostId && entry.agentSessionId === agentSessionId)
        if (!descriptor) throw new AgentMuxError('No exact retained Session exists at the requested Host.', 'UNKNOWN_AGENT_SESSION')
        result = { hostId, ...await client.sessionHistoryResource(agentSessionId, { ...request,
          ...(context.signal ? { signal: context.signal } : {}) }) }
      }
      return parseSessionHistoryResourceResult(result, input) as AgentMuxRpcResult<M>
    }
    if (method === 'agent.history') {
      const input = rpcRecord(params, NATIVE_FIELDS['agent.history']) as AgentMuxRpcParams<'agent.history'>
      validateSessionHistoryReadInput(input)
      const owners = (await this.clients()).filter(entry => entry.hostId === input.hostId)
      if (owners.length !== 1) throw new AgentMuxError('The exact history Host owner is unavailable or ambiguous.', 'RUNTIME_UNAVAILABLE')
      const client = owners[0]!.client
      context.signal?.throwIfAborted()
      if (client.forwardRpc) {
        // Page at the original semantic Host; do not transport a complete SDK timeline first.
        // The caller was authenticated here. Borrow the same original Host transport authority
        // used by inspect; a managed capability must not cross semantic Runtime owners.
        const { caller: _localCaller, ...readContext } = context
        const page = await client.forwardRpc('agent.history', { ...input, hostId: 'local' }, readContext)
        return { ...page, hostId: input.hostId } as AgentMuxRpcResult<M>
      }
      if (isUserMessageHistoryRead(input)) {
        const page = await client.readAgentSessionHistory({ ...input, hostId: 'local' }, context.signal ? { signal: context.signal } : {})
        return { ...page, hostId: input.hostId } as AgentMuxRpcResult<M>
      }
      return await readAgentSessionHistory(client, input, context.signal ? { signal: context.signal } : {}) as AgentMuxRpcResult<M>
    }
    if (caller?.client.forwardRpc && ['agent.role.ls', 'agent.role.register', 'agent.role.resolve',
      'agent.discuss', 'agent.handoff', 'message.inbox.check', 'message.inbox.ack',
      'message.dispatch.open', 'message.dispatch.inspect', 'message.dispatch.report'].includes(method)) {
      return await caller.client.forwardRpc(method, params, context)
    }
    let result: unknown
    if (Object.hasOwn(AGENTMUX_RPC_CONTROL_METHODS, method)) {
      if (method === 'toolkit.run' || method === 'toolkit.action' || method === 'toolkit.evaluate') {
        await this.assertToolkitExecutionAuthority(p.toolId, context)
      }
      if (this.ports.forwardControl) return await this.ports.forwardControl(method, params, context)
      let body = p
      if (method === 'space.inspect') {
        const target = rpcRecord(p.target)
        if (!Object.hasOwn(target, 'operationId') && (target.regionId || target.tabId)) {
          const field = target.regionId ? 'region' : 'tab', id = target[`${field}Id`]
          const presentation: import('./public-rpc.js').AgentMuxRpcSpacePresentation = { region: null, tab: null, unavailable: [] }
          try {
            if (id === 'self') this.requireCaller(caller)
            const observed = await this.execute(this.request(`inspect.${field}`, {
              target: id === 'self' ? { kind: 'self' } : { kind: field, [`${field}Id`]: id },
              ...(caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {})
            }))
            if (observed.operation === 'inspect.region') presentation.region = observed.region
            if (observed.operation === 'inspect.tab') presentation.tab = observed.tab
            if (id === 'self') body = { ...p, target: { ...target, [`${field}Id`]: (presentation[field] as { regionId?: string; tabId: string })[`${field}Id`] } }
          } catch (error) {
            if (id === 'self') throw error
            presentation.unavailable.push(unavailable(error))
          }
          const request = rpcControlRequest('space.inspect', body)
          return { ...rpcControlResult(method, await this.execute(request)), presentation } as AgentMuxRpcResult<M>
        }
      }
      if (method === 'goal.ls') {
        const goals = await this.goals(p)
        return rpcControlResult(method, { operation: 'demand.list', demands: goals }) as AgentMuxRpcResult<M>
      }
      if (method === 'goal.create' || method === 'goal.update') {
        const { risk, confirmation, wikiVersion, ...input } = p
        if (method === 'goal.create' || input.decision !== undefined) {
          const decision = input.decision === undefined ? {} : rpcRecord(input.decision,
            ['input', 'candidates', 'selectedProjectId', 'risk', 'confirmation', 'wikiVersion'])
          input.decision = { input: input.title ?? (input.patch as Record<string, unknown> | undefined)?.title ?? 'Goal update',
            candidates: [], selectedProjectId: input.projectId ?? null,
            risk: risk ?? 'unknown', confirmation: confirmation ?? 'pending', wikiVersion: wikiVersion ?? null,
            ...decision, recordedAt: Date.now(), sourceSessionId: caller?.agentSessionId ?? null }
        }
        body = input
      }
      if ((method === 'toolkit.run' || method === 'toolkit.stop') && body.toolId !== 'performance' && body.input === undefined) {
        const baselineParams = rpcRecord(body, ['toolId', 'input', 'operationId'])
        const baseline = rpcControlRequest('toolkit.inspect', { toolId: baselineParams.toolId,
          ...(baselineParams.operationId === undefined ? {} : { operationId: baselineParams.operationId }) })
        const current = await this.toolkit(baseline, context.signal)
        if (current.operation !== 'toolkit.get' ||
          (current.snapshot.kind !== 'script' && current.snapshot.kind !== 'package-unavailable') || current.snapshot.toolId !== baselineParams.toolId) {
          throw new AgentMuxError('Toolkit baseline belongs to another tool.', 'CONTROL_PROTOCOL_ERROR')
        }
        if (method === 'toolkit.run' && current.snapshot.kind === 'package-unavailable') {
          throw new AgentMuxError(current.snapshot.reason, 'TOOLKIT_PACKAGE_UNAVAILABLE')
        }
        // Source observation cannot take away the exact retained stop identity.
        const snapshot = current.snapshot.kind === 'package-unavailable' ? current.snapshot.retained : current.snapshot
        body = { ...body, operationId: baseline.requestId, input: method === 'toolkit.run' && current.snapshot.kind === 'script'
          ? { invocationId: baseline.requestId, expectedRevision: current.snapshot.definition.revision,
            expectedLatestExecutionId: snapshot?.admission?.executionId ?? snapshot?.latestConfirmed?.executionId ?? null }
          : { executionId: snapshot?.admission?.executionId ?? null } }
      }
      const internalCaller: AgentMuxControlCaller | undefined = caller
        ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined
      const request = rpcControlRequest(method as keyof typeof AGENTMUX_RPC_CONTROL_METHODS, body, internalCaller)
      const nameContext: AgentMuxNameContext = {
        actor: caller ? { kind: 'agent', id: caller.agentSessionId, verified: true }
          : context.principal ? { kind: context.transport === 'unix' && context.principal.kind === 'user' ? 'device' : context.principal.kind,
            id: context.principal.id, verified: true }
          : { kind: 'unknown', id: null, verified: false },
        source: 'explicit-edit', entryPoint: method, transport: context.transport ?? null,
        location: caller ? { workspacePath: caller.session.workspacePath, hostId: caller.hostId,
          callerSessionId: caller.agentSessionId, callerRunId: caller.session.run.runId, callerCwd: caller.session.workspacePath } : {}
      }
      if (request.operation === 'demand.activity.append' && !nameContext.actor.verified) {
        throw new AgentMuxError('Activity append requires an authenticated original Agent, person or device.', 'CONTROL_PERMISSION_DENIED')
      }
      if (request.operation === 'agent.rename' || request.operation === 'space.rename') {
        nameContext.source = request.nameSource === 'derived' ? 'derived' : 'explicit-edit'
        const agentOwner = request.operation === 'agent.rename' ? await this.owner(request.agentSessionId) : null
        const target = request.operation === 'agent.rename' ? { kind: 'agent-session', id: request.agentSessionId } : { kind: 'tab', id: request.tabId }
        const state = await this.spatial.readForLayout()
        const regions = state?.graph.regions.filter(region => target.kind === 'agent-session' && region.agentSessionId === target.id) ?? []
        const region = regions.length === 1 ? regions[0] : null
        const tab = state?.graph.tabs.find(tab => tab.tabId === (target.kind === 'tab' ? target.id : region?.tabId))
        Object.assign(nameContext.location, { targetKind: target.kind, targetId: target.id,
          workspaceId: tab?.workspaceId ?? null, tabId: tab?.tabId ?? null, regionId: region?.regionId ?? null,
          targetRunId: agentOwner?.session.run.runId ?? region?.runId ?? null,
          targetHostId: agentOwner?.hostId ?? region?.execution?.hostId ?? null,
          targetCwd: agentOwner?.session.workspacePath ?? region?.execution?.cwd ?? null })
        const changed = await this.spatial.mutateDisplayLabel({ target, operationId: request.requestId,
          value: request.name?.trim() || null, expectedNameRevision: request.expectedNameRevision, source: request.nameSource ?? 'manual' }, nameContext)
        const report = { override: changed.label?.value ?? null, changed: changed.changed,
          nameRevision: changed.label?.nameRevision ?? 0, record: changed.record,
          outcome: !changed.applied || changed.diskDurability !== 'confirmed' ? 'partial' as const : changed.changed ? 'renamed' as const : 'unchanged' as const,
          save: { layoutApplied: false, localStorageWritten: false, storageFlushRequested: false, diskDurability: changed.diskDurability,
            reason: changed.issue ?? changed.record.reason } }
        return rpcControlResult(method, request.operation === 'agent.rename'
          ? { operation: request.operation, agentSessionId: request.agentSessionId, ...report }
          : { operation: request.operation, tabId: request.tabId, ...report }) as AgentMuxRpcResult<M>
      }
      if ((request.operation === 'interrupt' || request.operation === 'resume' || request.operation === 'stop') && request.target.kind === 'agent-session') {
        request.target = { kind: 'agent-session', agentSessionId: (await this.owner(request.target.agentSessionId)).agentSessionId }
      }
      if (request.operation === 'demand.start' && request.sessionId !== undefined) {
        const exact = (await this.owner(request.sessionId)).agentSessionId
        if (request.continuation && exact !== request.sessionId) throw new AgentMuxError('Goal continuation requires the complete original Session ID.', 'INVALID_CONTROL_REQUEST')
        request.sessionId = exact
      }
      if (request.operation === 'demand.create' || request.operation === 'demand.update' || request.operation === 'demand.assign' || request.operation === 'demand.handoff') {
        const assignees = request.operation === 'demand.update' ? request.patch.assigneeSessionIds
          : request.assigneeSessionIds ?? (request.operation === 'demand.handoff' && request.sessionId ? [request.sessionId] : undefined)
        if (assignees !== undefined && assignees.length) {
          const retained = new Set<string>()
          if (request.operation !== 'demand.create') {
            const previous = await this.execute(rpcControlRequest('goal.inspect', { goalId: request.demandId }))
            if (previous.operation !== 'demand.show' || !previous.demand) throw new AgentMuxError('Original Goal read is unconfirmed; inspect it before changing assignment.', 'CONTROL_PROTOCOL_ERROR')
            previous.demand.assigneeSessionIds.forEach(id => retained.add(id))
          }
          for (const assignee of assignees) if (!retained.has(assignee) && (await this.owner(assignee)).agentSessionId !== assignee)
            throw new AgentMuxError('New Goal assignment requires the complete exact Session ID.', 'INVALID_CONTROL_REQUEST')
        }
      }
      result = request.operation.startsWith('toolkit.') ? await this.toolkit(request, context.signal, nameContext)
        : request.operation === 'metrics.get' ? { operation: 'metrics.get', observation: await this.metrics(context.signal) }
        : await this.execute(request, nameContext)
      return rpcControlResult(method, result as AgentMuxControlResult) as AgentMuxRpcResult<M>
    }
    const fields = NATIVE_FIELDS[method as keyof typeof NATIVE_FIELDS]
    if (!fields) throw new AgentMuxError('Unknown RPC method.', 'RPC_METHOD_NOT_FOUND')
    rpcRecord(p, fields)
    switch (method) {
      case 'notebook.ls': result = {state:await this.notebooks.read()}; break
      case 'notebook.inspect': {
        const input = parseNotebookObservationParams(p, true), state = await this.notebooks.read()
        result = { ...inspectNotebook(state, input), ...(this.notebooks.storage ? { storageOperation: (await this.notebooks.storage.inspect(input.operationId)).operation } : {}),
          ...(input.content ? { content: this.ports.notebookObservation
            ? await this.ports.notebookObservation.content(state, input.noteId!, { ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }), ...(context.signal ? { signal: context.signal } : {}) })
            : (() => { throw new AgentMuxError('The original Host Note reader is unavailable. Directory and Agent capabilities remain available; retry this observation when the Host reconnects.', 'CONTROL_UNAVAILABLE') })() } : {}) }; break
      }
      case 'notebook.graph': {
        const input = parseNotebookObservationParams(p)
        if (!this.ports.notebookObservation) throw new AgentMuxError('The original Host Note graph reader is unavailable. Directory and Agent capabilities remain available; retry this observation when the Host reconnects.', 'CONTROL_UNAVAILABLE')
        result = await this.ports.notebookObservation.graph(await this.notebooks.read(), input, context.signal ? { signal: context.signal } : undefined); break
      }
      case 'notebook.apply': {
        const actor:import('./notebook-catalog.js').NotebookActor|undefined=caller?{kind:'agent',id:caller.agentSessionId}:context.principal?{kind:context.principal.kind,id:context.principal.id}:undefined
        if(!actor)throw new AgentMuxError('Notebook writing requires the authenticated original user, device or Agent. Knowledge and Runs are retained.', 'CONTROL_PERMISSION_DENIED')
        result={state:await this.notebooks.apply(p as unknown as import('./notebook-catalog.js').NotebookWrite,actor)};break
      }
      case 'space.state': result = {state:await this.spatial.readForLayout()}; break
      case 'name.confirm': result = { state: await this.spatial.confirmNameCommit(rpcString(p.operationId, 'Exact name operation ID')) }; break
      case 'name.history': {
        const target = p.target === undefined ? undefined : rpcRecord(p.target, ['kind', 'id'])
        const query = {
          ...(target ? { target: { kind: rpcString(target.kind, 'Name target kind'), id: rpcString(target.id, 'Name target ID') } } : {}),
          ...(p.afterId === undefined ? {} : { afterId: rpcString(p.afterId, 'Name cursor') }), limit: rpcCount(p.limit, 50, 1000) }
        result = { ...(this.ports.nameHistory ? await this.ports.nameHistory(query)
          : { ...await this.spatial.queryNameChanges(query), coverage: 'spatial' }), diskAcknowledgement: 'not-observed' }; break
      }
      case 'space.commit': {
        if (p.allowEntityRemoval !== undefined && typeof p.allowEntityRemoval !== 'boolean') throw new AgentMuxError('Explicit entity removal must be boolean.', 'INVALID_CONTROL_REQUEST')
        result = {state:await this.spatial.commit({expectedRevision:rpcCount(p.expectedRevision,-1,Number.MAX_SAFE_INTEGER),graph:p.graph as import('./spatial-state.js').AgentMuxSpatialGraph,
          ...(p.allowEntityRemoval === undefined ? {} : {allowEntityRemoval:p.allowEntityRemoval as boolean}),
          ...(p.removedProjectGroupIds === undefined ? {} : {removedProjectGroupIds:p.removedProjectGroupIds as string[]})})}; break
      }
      case 'space.resolve': {
        const tabId = rpcString(p.tabId,'Tab ID'), regionId = rpcString(p.regionId,'Region ID')
        if (!['left','right','up','down'].includes(String(p.direction))) throw new AgentMuxError('A spatial direction is required.', 'INVALID_CONTROL_REQUEST')
        const state = await this.spatial.readForLayout()
        if (!state) throw new AgentMuxError('No durable spatial graph has been registered.', 'SPATIAL_STATE_ABSENT')
        result = resolveSpatialRegion(state.graph,{tabId,regionId,direction:p.direction as import('./spatial-layout.js').SplitDirection}); break
      }
      case 'system.endpoint': result = { protocol: 'jsonrpc-2.0', framing: 'json-lines', connection: 'responded',
        endpoint: this.ports.endpoint ?? { transport: 'unix', path: defaultAgentMuxControlSocketPath() }, publication: this.ports.endpointPublication?.() ?? null }; break
      case 'system.storage': {
        const hostId = rpcString(p.hostId, 'Host ID'), runId = rpcString(p.runId, 'Run ID')
        const owner = (await this.clients()).find(entry => entry.hostId === hostId)
        if (!owner) throw new AgentMuxError('The selected Host is unavailable for storage observation.', 'CONTROL_UNAVAILABLE')
        const observation = await owner.client.observeRunStorage({ runId })
        result = { ...observation, runtime: { ...observation.runtime, hostId } }; break
      }
      case 'system.diagnostics.inspect': {
        const input = parseDiagnosticEvidenceParams(p)
        // Discovery reads registered contracts only. An attached client cannot replace
        // an original local journal, authority or reader for an already-owned domain.
        const local = await inspectDiagnosticEvidence(this.diagnosticQuery, {}, this.ports, caller, context.signal)
        if ((!input.target || !local.capabilities.some(capability => capability.domain === input.target?.domain)) && this.ports.forwardControl) {
          try {
            const forwarded = parseDiagnosticEvidenceResult(await this.ports.forwardControl('system.diagnostics.inspect', structuredClone(input), context), input)
            if (input.target) { result = forwarded; break }
            const capabilities = new Map(local.capabilities.map(capability => [capability.domain, capability]))
            for (const capability of forwarded.capabilities) if (!capabilities.has(capability.domain)) capabilities.set(capability.domain, capability)
            const discovery = { ...local, capabilities: [...capabilities.values()], issues: [...local.issues, ...forwarded.issues],
              completeness: local.completeness === 'complete' && forwarded.completeness === 'complete' ? 'complete' as const : 'partial' as const,
              budget: { ...local.budget } }
            for (let i = 0; i < 4; i++) discovery.budget.usedBytes = Buffer.byteLength(JSON.stringify(discovery))
            result = parseDiagnosticEvidenceResult(discovery, input); break
          } catch (error) {
            // A transport absence permits local observations. A remote refusal,
            // cancellation or corrupt response does not authorize another read.
            if (!(error instanceof AgentMuxError) || error instanceof AgentMuxRpcError || error.code !== 'CONTROL_UNAVAILABLE') throw error
          }
        }
        result = input.target ? await inspectDiagnosticEvidence(this.diagnosticQuery, input, this.ports, caller, context.signal) : local
        break
      }
      case 'agent.native.ls': {
        const hostId = rpcString(p.hostId, 'Native Session Host'), executorId = rpcString(p.executorId, 'Native Session Executor')
        if (p.workspacePath !== undefined && (typeof p.workspacePath !== 'string' || !isAbsolute(p.workspacePath) || p.workspacePath.includes('\0'))) {
          throw new AgentMuxError('Native Session filtering requires an exact absolute Workspace directory.', 'INVALID_CONTROL_REQUEST')
        }
        const input = { hostId, executorId, ...(p.workspacePath === undefined ? {} : { workspacePath: p.workspacePath as string }) }
        context.signal?.throwIfAborted()
        if (this.ports.nativeAgentSessions) result = await this.ports.nativeAgentSessions(input)
        else {
          const targets = (await this.clients()).filter(entry => entry.hostId === hostId)
          if (targets.length !== 1) throw new AgentMuxError('The exact native Session Host is unavailable or ambiguous.', 'UNKNOWN_HOST')
          const client = targets[0]!.client
          result = { hostId, executorId, ...await client.listHostNativeAgentSessions({ executorId,
            ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }) }) }
        }
        result = parseRpcNativeResult('agent.native.ls', result, input)
        break
      }
      case 'agent.native.history': {
        const input = parseNativeHistoryParams(p)
        context.signal?.throwIfAborted()
        if (this.ports.nativeAgentHistory) result = await this.ports.nativeAgentHistory(input,
          context.signal ? { signal: context.signal } : {})
        else {
          const targets = (await this.clients()).filter(entry => entry.hostId === input.hostId)
          if (targets.length !== 1) throw new AgentMuxError('The exact native history Host is unavailable or ambiguous.', 'UNKNOWN_HOST')
          const { hostId, ...request } = input
          result = { hostId, executorId: input.executorId, nativeSource: input.source,
            ...await targets[0]!.client.readHostNativeAgentHistory({ ...request,
              ...(context.signal ? { signal: context.signal } : {}) }) }
        }
        context.signal?.throwIfAborted()
        result = parseNativeHistoryResult(result, input)
        break
      }
      case 'agent.native.history.resource': {
        const input = parseNativeHistoryResourceParams(p)
        context.signal?.throwIfAborted()
        if (this.ports.nativeAgentHistoryResource) result = await this.ports.nativeAgentHistoryResource(input,
          context.signal ? { signal: context.signal } : {})
        else {
          const targets = (await this.clients()).filter(entry => entry.hostId === input.hostId)
          if (targets.length !== 1) throw new AgentMuxError('The exact native resource Host is unavailable or ambiguous.', 'UNKNOWN_HOST')
          const { hostId, ...request } = input
          result = { hostId, executorId: input.executorId, nativeSource: input.nativeSource,
            ...await targets[0]!.client.readHostNativeAgentHistoryResource({ ...request,
              ...(context.signal ? { signal: context.signal } : {}) }) }
        }
        context.signal?.throwIfAborted()
        result = parseNativeHistoryResourceResult(result, input)
        break
      }
      case 'message.delivery.inspect': {
        const logId = validateDeliveryLogId(p.logId)
        const hostId = p.hostId === undefined ? undefined : rpcString(p.hostId, 'Original diagnostic Host')
        const observations: DeliveryAttemptLookup[] = []
        const journal = this.ports.deliveryAttempts
        if (caller && hostId !== undefined && hostId !== caller.hostId) throw new AgentMuxError(
          'The authenticated Agent belongs to a different diagnostic Host.', 'CONTROL_PERMISSION_DENIED')
        if (journal && (caller === undefined || caller.hostId === journal.hostId) &&
            (hostId === undefined || hostId === journal.hostId)) observations.push(await journal.store.read(logId))
        let scopes: AgentMuxRpcCoreClient[] = []
        try { scopes = (await this.clients()).filter(entry => (hostId === undefined || entry.hostId === hostId) &&
          (caller === undefined || entry.client === caller.client)) }
        catch (error) { observations.push({ logId, availability: 'unavailable', record: null, persistence: null,
          issue: `Core diagnostic owners are unavailable: ${error instanceof Error ? error.message : String(error)}` }) }
        for (const scope of scopes) {
          try { observations.push(await scope.client.readDeliveryAttempt(logId)) }
          catch (error) { observations.push({ logId, availability: 'unavailable', record: null, persistence: null,
            issue: `Original Host ${scope.hostId}: ${error instanceof Error ? error.message : String(error)}` }) }
        }
        const found = observations.filter(value => value.availability === 'found')
        if (found.length > 1 && found.some(value => JSON.stringify(value.record) !== JSON.stringify(found[0]!.record))) {
          throw new AgentMuxError('This diagnostic ID has more than one original record owner.', 'DELIVERY_LOG_CONFLICT')
        }
        result = found[0] ?? observations.find(value => value.availability === 'unavailable') ??
          (observations.length ? { logId, availability: 'not-found', record: null, persistence: null, issue: null }
            : { logId, availability: 'unavailable', record: null, persistence: null, issue: 'The original diagnostic Host is unavailable.' })
        break
      }
      case 'message.delivery.report': {
        const hostId = rpcString(p.hostId, 'Original diagnostic Host'), journal = this.ports.deliveryAttempts
        if (!journal || journal.hostId !== hostId) throw new AgentMuxError('The selected diagnostic Host is unavailable. Retain the original local report.', 'DELIVERY_LOG_UNAVAILABLE')
        const record = parseDeliveryAttempt(p.record)
        if (record.source !== 'client' || record.observation !== undefined || record.reporter !== undefined) {
          throw new AgentMuxError('Client reports cannot author Core Input or authenticated identity.', 'CONTROL_PERMISSION_DENIED')
        }
        result = await journal.store.record({ ...record, reporter: { ...context.principal!, routeHostId: journal.hostId, receivedAt: Date.now() } })
        break
      }
      case 'system.doctor': {
        const client = caller?.client ?? (await this.clients())[0]?.client
        if (!client) throw new AgentMuxError('No Core client owner is available.', 'CONTROL_UNAVAILABLE')
        const workspacePath = p.workspacePath === undefined ? caller?.session.workspacePath : rpcString(p.workspacePath, 'Workspace path')
        result = await diagnoseAgentMux({ client, ...(workspacePath === undefined ? {} : { workspacePath }) }); break
      }
      case 'agent.ls': {
        validateFilters(p)
        let aggregationIssue: ReturnType<typeof cause> | undefined
        if (this.ports.forwardControl) {
          try { return await this.ports.forwardControl(method, params, context) }
          catch (error) {
            if (!(error instanceof AgentMuxError) || error instanceof AgentMuxRpcError || error.code !== 'CONTROL_UNAVAILABLE') throw error
            aggregationIssue = { ...cause(error), message: `Client Session aggregation is unavailable; only local observations follow. ${error.message}` }
          }
        }
        const list = await this.sessions(p)
        if (aggregationIssue) list.errors.push({ hostId: 'local', agentSessionId: null, ...aggregationIssue })
        result = list; break
      }
      case 'agent.context': {
        const input = parseAgentContextParams(p)
        const scopes = (await this.clients()).filter(scope => scope.hostId === input.hostId)
        if (scopes.length !== 1) throw new AgentMuxError(`Context route Host ${JSON.stringify(input.hostId)} is ${scopes.length ? 'ambiguous' : 'not configured'} in this service. Use settings hosts ls or agent ls on the same endpoint; local means the receiving Core service.`, scopes.length ? 'AMBIGUOUS_AGENT_SESSION' : 'UNKNOWN_HOST')
        const scope = scopes[0]!
        if (scope.client.forwardRpc) {
          // Configured Host names are routes on this client. The remote Core owns
          // its local namespace; never pass a Desktop route as native identity.
          const forwarded = forwardAgentContextParams(input)
          const page = await scope.client.forwardRpc('agent.context', forwarded.params, context)
          result = forwardAgentContextPage(page, input, forwarded.sourceHostId)
          break
        }
        const descriptor = (await scope.client.sessionHistorySources()).find(source => source.agentSessionId === input.agentSessionId && source.hostId === input.hostId)
        if (!descriptor) throw new AgentMuxError(`Session ${JSON.stringify(input.agentSessionId)} is not retained on route Host ${JSON.stringify(input.hostId)}. Rediscover it with agent ls on the same endpoint.`, 'UNKNOWN_AGENT_SESSION')
        context.signal?.throwIfAborted()
        result = await readAgentContext(scope.client, input, descriptor)
        break
      }
      case 'agent.inspect': {
        const target = rpcRecord(p.target)
        const allowed = target.kind === 'self' ? ['kind'] : target.kind === 'agent-session' ? ['kind', 'agentSessionId'] : target.kind === 'run' ? ['kind', 'run']
          : target.kind === 'provider-native' ? ['kind', 'providerId', 'sessionId'] : target.kind === 'acp-native' ? ['kind', 'adapterId', 'sessionId'] : []
        rpcRecord(target, allowed)
        if (!allowed.length) throw new AgentMuxError('Agent inspection target is invalid.', 'INVALID_CONTROL_REQUEST')
        if (target.kind === 'self') this.requireCaller(caller)
        const clients = await this.clients()
        const sessions: Array<{ routeHostId: string; client: AgentMuxRpcCorePort; session: ReturnType<AgentMuxClient['agentSession']> }> = []
        const lookupIssues: AgentMuxRpcUnavailable[] = []
        let selected: Awaited<ReturnType<AgentMuxRpcService['owner']>> | null = target.kind === 'self' ? caller! : null
        if (target.kind === 'agent-session') {
          const id = rpcString(target.agentSessionId, 'Session ID')
          try { selected = await this.owner(id) }
          catch (error) {
            if (!(error instanceof AgentMuxError) || error.code !== 'UNKNOWN_AGENT_SESSION' || !this.ports.forwardControl) throw error
            return await this.ports.forwardControl(method, params, context)
          }
        }
        const lookup = selected ? { kind: 'agent-session' as const, agentSessionId: selected.agentSessionId } : target
        if (lookup.kind === 'run') rpcString(rpcRecord(lookup.run, ['runId']).runId, 'Run ID')
        else if (lookup.kind === 'provider-native') { rpcString(lookup.providerId, 'Provider ID'); rpcString(lookup.sessionId, 'Native Session ID') }
        else if (lookup.kind === 'acp-native') { rpcString(lookup.adapterId, 'Adapter ID'); rpcString(lookup.sessionId, 'Native Session ID') }
        const knownRun = lookup.kind === 'run' ? clients.filter(({ client }) => !this.endpointUnverified(client) &&
          client.agentSessions().some(session => session.run.runId === rpcRecord(lookup.run, ['runId']).runId)) : []
        const lookupScopes = knownRun.length === 1 ? knownRun : clients
        if (selected) sessions.push({ routeHostId: selected.hostId, client: selected.client, session: selected.session })
        else for (const scope of lookupScopes) {
          // Native bindings may be written by another owner after this client connected.
          // The durable Session facts, not a cached registry, admit this exact lookup.
          try {
            for (const session of await this.ownedSessions(scope)) {
              const handle = session.nativeHandle
              const matches = lookup.kind === 'run' ? session.run.runId === rpcString(rpcRecord(lookup.run, ['runId']).runId, 'Run ID')
                : lookup.kind === 'provider-native' ? handle?.kind === 'provider' &&
                  handle.providerId === rpcString(lookup.providerId, 'Provider ID') && handle.sessionId === rpcString(lookup.sessionId, 'Native Session ID')
                : lookup.kind === 'acp-native' ? handle?.kind === 'acp' &&
                  handle.adapterId === rpcString(lookup.adapterId, 'Adapter ID') && handle.sessionId === rpcString(lookup.sessionId, 'Native Session ID') : false
              if (matches) sessions.push({ routeHostId: scope.hostId, client: scope.client, session })
            }
          } catch (error) { lookupIssues.push(unavailable(error)) }
        }
        if (!sessions.length && lookupIssues.length) {
          throw new AgentMuxError('Native Session absence cannot be confirmed while an original owner is unavailable. Existing Runs are retained.',
            lookupIssues.some(issue => issue.code === 'RUNTIME_UNAVAILABLE') ? 'RUNTIME_UNAVAILABLE' : 'AGENT_SESSION_STORE_READ_UNCONFIRMED')
        }
        if (sessions.length !== 1) throw new AgentMuxError('Session lookup is unknown or ambiguous.', sessions.length ? 'AMBIGUOUS_AGENT_SESSION' : 'UNKNOWN_AGENT_SESSION')
        const { routeHostId, client, session } = sessions[0]!
        const issues: AgentMuxRpcUnavailable[] = [...(selected?.unavailable ?? []), ...lookupIssues]
        let status: Awaited<ReturnType<AgentMuxClient['statusAgent']>> | null = null
        try {
          status = await client.statusAgent(session.agentSessionId)
          if (status.session.run.runId !== session.run.runId) throw new AgentMuxError('Session changed during inspection.', 'STALE_AGENT_SESSION')
        } catch (error) { status = null; issues.push(unavailable(error)) }
        let displayName: import('./public-rpc.js').AgentMuxRpcAgentInspection['displayName'] = { override: null, source: null, nameRevision: null, availability: 'unavailable' }
        try {
          const state = await this.spatial.readForLayout()
          if (!state) throw new AgentMuxError('The name owner is unavailable; original names are retained.', 'SPATIAL_STATE_ABSENT')
          const label = displayLabel(state.graph, { kind: 'agent-session', id: session.agentSessionId })
          displayName = { override: label?.value ?? null, source: label?.source ?? null, nameRevision: label?.nameRevision ?? 0, availability: 'observed' }
        } catch (error) { issues.push(unavailable(error)) }
        result = { routeHostId, session, status, displayName, unavailable: issues }; break
      }
      case 'whoami': {
        if (this.ports.forwardControl) {
          try { return await this.ports.forwardControl(method, params, context) }
          catch (error) { if (!(error instanceof AgentMuxError) || error instanceof AgentMuxRpcError || error.code !== 'CONTROL_UNAVAILABLE') throw error }
        }
        const owner = this.requireCaller(caller), issues: AgentMuxRpcUnavailable[] = []
        let status: Awaited<ReturnType<AgentMuxClient['statusAgent']>> | null = null
        try {
          status = await owner.client.statusAgent(owner.agentSessionId)
          if (status.session.run.runId !== owner.session.run.runId) throw new AgentMuxError('Session changed during inspection.', 'STALE_AGENT_SESSION')
        } catch (error) { status = null; issues.push(unavailable(error)) }
        let view: unknown
        if (!this.ports.execute && !this.ports.forwardControl) view = { attached: false, reason: 'no-desktop-view' }
        else try { const observed = await this.execute(this.request('inspect.region', {
          target: { kind: 'self' }, caller: { agentSessionId: owner.agentSessionId, capability: owner.capability } }))
          view = observed.operation === 'inspect.region' ? { attached: true, region: observed.region } : null
        } catch (error) { view = classifySelfViewFailure(error); issues.push(unavailable(error)) }
        result = { session: owner.session, status, view, topic: SELF_CONTEXT_TOPIC_HINT,
          messaging: AGENTMUX_AGENT_MESSAGING_RULES, unavailable: issues }; break
      }
      case 'agent.role.ls': case 'agent.role.resolve': case 'agent.role.register': {
        const scope = caller?.session.workspacePath ?? rpcString(p.workspacePath, 'Explicit role Workspace path')
        if (p.workspacePath !== undefined && caller && p.workspacePath !== scope) {
          throw new AgentMuxError('Role scope does not match the authenticated execution directory.', 'AGENT_CAPABILITY_INVALID')
        }
        if (method === 'agent.role.ls') result = { bindings: await readAgentRoleBindings(scope) }
        else if (method === 'agent.role.register') {
          const owner = this.requireCaller(caller)
          if (p.providerId !== undefined && p.providerId !== owner.session.providerId) {
            throw new AgentMuxError('Role Provider does not match the authoritative Session.', 'INVALID_CONTROL_REQUEST')
          }
          result = { binding: await registerAgentRole({ role: rpcString(p.role, 'Role'),
            agentSessionId: owner.agentSessionId, workspacePath: scope, providerId: owner.session.providerId }) }
        } else {
          const binding = await resolveAgentRole({ workspacePath: scope, role: rpcString(p.role, 'Role'),
            sessionExists: async id => { try { await this.owner(id); return true } catch (error) {
              if (error instanceof AgentMuxError && error.code === 'UNKNOWN_AGENT_SESSION') return false
              throw error
            } } })
          if (!binding) throw new AgentMuxError('Role is unresolved or stale.', 'MAINTAINER_TARGET_UNRESOLVED')
          result = { binding }
        } break
      }
      case 'agent.discuss': {
        const owner = this.requireCaller(caller)
        const discussion = await owner.client.startDiscussion({ capability: owner.capability,
          callerAgentSessionId: owner.agentSessionId, executorId: rpcString(p.executorId, 'Executor ID'),
          providerId: p.providerId === undefined ? rpcString(p.executorId, 'Executor ID') : rpcString(p.providerId, 'Provider ID'),
          workspacePath: owner.session.workspacePath, body: rpcText(p.text, 'Discussion text'),
          operationId: rpcString(p.operationId, 'Operation ID') })
        result = { threadId: discussion.thread.threadId, delivery: discussion.thread.delivery.state,
          targetAgentSessionId: discussion.session.agentSessionId }; break
      }
      case 'agent.handoff': {
        const owner = this.requireCaller(caller)
        result = await owner.client.handOff({ capability: owner.capability, callerAgentSessionId: owner.agentSessionId,
          toAgentSessionId: (await this.owner(rpcString(p.toAgentSessionId, 'Recipient Session ID'))).agentSessionId,
          taskId: rpcString(p.taskId, 'Task ID') }); break
      }
      case 'message.read': case 'message.dispatch.read': case 'message.dispatch.ls': {
        if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id.trim())) throw new AgentMuxError(
          'Message reading requires an authenticated Agent participant or a transport-approved user/device. Original communication and Runs are retained.', 'CONTROL_PERMISSION_DENIED')
        const hostId = p.hostId === undefined ? caller?.hostId : rpcString(p.hostId, 'Original message Host ID')
        if (hostId === undefined) throw new AgentMuxError('A trusted reader must select the exact original message Host.', 'INVALID_CONTROL_REQUEST')
        if (caller && caller.hostId !== hostId) throw new AgentMuxError('Agent authority cannot read another semantic Host journal.', 'CONTROL_PERMISSION_DENIED')
        const scopes = caller ? [caller] : (await this.clients()).filter(scope => scope.hostId === hostId)
        if (scopes.length !== 1) throw new AgentMuxError('The exact message Host owner is unavailable or ambiguous. Keep the original source reference.', 'CONTROL_UNAVAILABLE')
        const owner = scopes[0]!
        if (owner.client.forwardRpc) {
          result = { ...await owner.client.forwardRpc(method, { ...p, hostId: 'local' } as AgentMuxRpcParams<M>, context), hostId }; break
        }
        const auth = caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {}
        if (method === 'message.read') result = { message: await owner.client.readMessage({
          operationId: rpcString(p.operationId, 'Original message operation ID'), ...auth }), hostId }
        else if (method === 'message.dispatch.read') result = { ...await owner.client.readDispatch({
          sourceMessageId: rpcString(p.sourceMessageId, 'Source message ID'), ...auth }), hostId }
        else result = { ...await owner.client.listDispatches({
          participantSessionId: p.participantSessionId === undefined ? this.requireCaller(caller).agentSessionId : rpcString(p.participantSessionId, 'Participant Session ID'),
          ...(p.afterSourceMessageId === undefined ? {} : { afterSourceMessageId: rpcString(p.afterSourceMessageId, 'Original page source message ID') }),
          limit: rpcCount(p.limit, 50, 100), ...auth }), hostId }
        break
      }
      case 'message.inbox.check': case 'message.inbox.ack':
      case 'message.dispatch.open': case 'message.dispatch.inspect': case 'message.dispatch.report': {
        const owner = this.requireCaller(caller)
        const auth = { capability: owner.capability, callerAgentSessionId: owner.agentSessionId }
        if (method === 'message.inbox.check') result = await owner.client.checkDeliveries({ ...auth, limit: rpcCount(p.limit, 100, 1000) })
        else if (method === 'message.inbox.ack') result = await owner.client.ackDeliveryBatch({ ...auth,
          generation: rpcCount(p.generation, -1), readerRun: { runId: rpcString(rpcRecord(p.readerRun, ['runId']).runId, 'Reader Run ID') } })
        else {
          const input = { ...auth, sourceMessageId: rpcString(p.sourceMessageId, 'Source message ID') }
          result = method === 'message.dispatch.open' ? await owner.client.openDispatch(input)
            : method === 'message.dispatch.inspect' ? await owner.client.showDispatch(input)
            : await owner.client.recordDispatchEvent({ ...input, replyMessageId: rpcString(p.replyMessageId, 'Reply message ID'),
              kind: p.kind as Parameters<AgentMuxClient['recordDispatchEvent']>[0]['kind'] })
        } break
      }
      case 'agent.input.inspect': {
        if (p.kind === 'message-control') {
          rpcRecord(p, ['kind', 'originalControlOperationId'])
          const operationId = validateAgentInputControlId(p.originalControlOperationId)
          const local = (await this.clients()).filter(scope => scope.hostId === 'local' && !scope.client.forwardRpc)
          if (local.length !== 1) throw new AgentMuxError('The original semantic endpoint journal is unknown or ambiguous. No route was re-resolved.', 'CONTROL_UNAVAILABLE')
          const client = local[0]!.client
          if (caller && caller.client !== client) throw new AgentMuxError('Original control inspection cannot cross semantic owners.', 'CONTROL_PERMISSION_DENIED')
          const input = await client.inspectAgentInput({ kind: 'message-control', originalControlOperationId: operationId },
            caller ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined)
          result = { record: input?.admission ?? null, input }; break
        }
        rpcRecord(p, ['key'])
        const key = validateAgentPromptInputKey(p.key)
        const { client } = await (async () => {
          try { return await this.originalInputOwner(key.agentSessionId, caller) }
          catch (error) {
            if (!(error instanceof AgentMuxError) || error.code !== 'UNKNOWN_AGENT_SESSION') throw error
            // Preserve the original aggregate read route for a retired Session.
            // Its unique durable history descriptor locates the owner; reading
            // an input journal never supplies ownership or dispatch authority.
            const retained = (await Promise.all((await this.clients()).map(async scope => ({ ...scope,
              retained: (await scope.client.sessionHistorySources()).some(source => source.agentSessionId === key.agentSessionId) }))))
              .filter(scope => scope.retained)
            if (retained.length !== 1) throw new AgentMuxError('The original input owner is unknown or ambiguous.',
              retained.length ? 'AMBIGUOUS_AGENT_SESSION' : 'UNKNOWN_AGENT_SESSION')
            return retained[0]!
          }
        })()
        if (caller && caller.client !== client) throw new AgentMuxError('Input inspection cannot cross semantic owners.', 'CONTROL_PERMISSION_DENIED')
        if (client.forwardRpc) return await client.forwardRpc('agent.input.inspect', { key }, context) as AgentMuxRpcResult<M>
        const original = await client.inspectAgentPromptSubmission(key)
        const input = await client.inspectAgentInput({ key }, caller ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined)
        if (!input && caller && caller.agentSessionId !== key.agentSessionId && original?.admission?.intent?.message?.authorAgentSessionId !== caller.agentSessionId) throw new AgentMuxError('Only an original input participant can inspect its claim.', 'CONTROL_PERMISSION_DENIED')
        result = { record: original, ...(input ? { input } : {}) }; break
      }
      case 'agent.input.stop': case 'agent.input.rejoin': {
        const ref = validateAgentInputWaitRef(p.ref)
        const scope = method === 'agent.input.stop' ? await this.originalInputOwner(ref.key.agentSessionId, caller)
          : await this.owner(ref.key.agentSessionId)
        if ('agentSessionId' in scope && scope.agentSessionId !== ref.key.agentSessionId) throw new AgentMuxError('Input control requires the exact original Session.', 'INVALID_AGENT_INPUT_CONTROL')
        if (caller && caller.client !== scope.client) throw new AgentMuxError('Input control cannot cross semantic owners.', 'CONTROL_PERMISSION_DENIED')
        if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind))) throw new AgentMuxError(
          'Stopping or rejoining input requires a transport-approved user/device or its authenticated Agent author.', 'CONTROL_PERMISSION_DENIED')
        if (scope.client.forwardRpc) return await scope.client.forwardRpc(method, p as AgentMuxRpcParams<typeof method>,
          await this.inputForwardContext(context)) as AgentMuxRpcResult<M>
        const author = caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {}
        result = method === 'agent.input.stop' ? await scope.client.stopAgentInputWaiting({ ref, cancelOperationId: validateAgentInputControlId(p.cancelOperationId), ...author })
          : await scope.client.rejoinAgentInputWaiting({ ref, ...author }, this.inputCallContext(context))
        break
      }
      case 'agent.send': result = await this.send(p, caller, context); break
      case 'agent.output': throw new AgentMuxError('Agent output is a bounded byte subscription.', 'INVALID_CONTROL_REQUEST')
      case 'goal.activity': {
        if (this.ports.forwardControl) {
          try { return await this.ports.forwardControl(method, params, context) }
          catch (error) { if (!(error instanceof AgentMuxError) || error instanceof AgentMuxRpcError || error.code !== 'CONTROL_UNAVAILABLE') throw error }
        }
        const goals = await this.goals(p)
        const limit = rpcCount(p.limit, 100, 1000)
        const records = await Promise.all(goals.map(async goal => {
          const read = await this.execute(this.request('demand.activity.read', { demandId: goal.id }))
          if (read.operation !== 'demand.activity.read' || read.demandId !== goal.id || read.diskDurability !== 'confirmed') throw new AgentMuxError('The original Goal activity observation is unconfirmed. Inspect the original operation; the Goal and Agent are retained.', 'CONTROL_PROTOCOL_ERROR')
          return read.activities.map(activity => ({ goalId: goal.id, ...activity }))
        }))
        result = { activity: records.flat()
          .filter(activity => p.since === undefined || activity.createdAt >= Number(p.since)).slice(-limit), diskDurability: 'confirmed' }; break
      }
      case 'app.snapshot': {
        if (this.ports.forwardControl) {
          try { return await this.ports.forwardControl(method, params, context) }
          catch (error) { if (!(error instanceof AgentMuxError) || error instanceof AgentMuxRpcError || error.code !== 'CONTROL_UNAVAILABLE') throw error }
        }
        result = await this.snapshot(p); break
      }
      case 'system.subscription.cancel': throw new AgentMuxError('A subscription belongs to its transport connection.', 'INVALID_CONTROL_REQUEST')
      default: throw new AgentMuxError('RPC method is not implemented.', 'RPC_METHOD_NOT_FOUND')
    }
    return result as AgentMuxRpcResult<M>
  }

  private async assertToolkitExecutionAuthority(toolId: unknown, context: AgentMuxRpcCallContext): Promise<void> {
    if (context.caller === undefined && context.transport === 'unix' && context.principal?.kind === 'user') return
    const listed = this.ports.forwardControl
      ? await this.ports.forwardControl('toolkit.ls', {}, context)
      : await this.toolkit(rpcControlRequest('toolkit.ls', {}), context.signal)
    if ('tools' in listed && listed.tools.some(tool => tool.toolId === toolId && tool.kind === 'script' && tool.readonly)) {
      throw new AgentMuxError('Official script tools require an explicit local-user invocation. Existing Agents and results remain available.', 'CONTROL_PERMISSION_DENIED')
    }
  }
  private async toolkit(request: AgentMuxControlRequest, signal?: AbortSignal, context?: AgentMuxNameContext) {
    if (!this.ports.toolkit) throw new AgentMuxError('Toolkit owner is unavailable.', 'TOOLKIT_UNSUPPORTED')
    const { isToolkitRequest, parseToolkitResult, assertToolkitResultTarget } = await import('./toolkit.js')
    if (!isToolkitRequest(request)) throw new AgentMuxError('Toolkit request is invalid.', 'INVALID_CONTROL_REQUEST')
    const raw = rpcRecord(await this.ports.toolkit.execute(request, signal ?? new AbortController().signal, context), undefined, 'CONTROL_PROTOCOL_ERROR')
    const { operation, ...body } = raw
    if (operation !== request.operation) throw new AgentMuxError('Toolkit operation mismatch.', 'CONTROL_PROTOCOL_ERROR')
    const result = parseToolkitResult(request.operation, body)
    assertToolkitResultTarget(request, result); return result
  }
  private async metrics(signal?: AbortSignal): Promise<import('./metrics.js').MetricsObservation> {
    const metrics = this.ports.metrics
    if (!metrics) throw new AgentMuxError('Metrics owner is unavailable.', 'METRICS_UNSUPPORTED')
    const controller = new AbortController()
    let resolve!: (value: import('./metrics.js').MetricsObservation) => void, reject!: (error: unknown) => void
    const first = new Promise<import('./metrics.js').MetricsObservation>((yes, no) => { resolve = yes; reject = no })
    void first.catch(() => {})
    const cancelled = new Promise<never>((_resolve, cancel) => controller.signal.addEventListener('abort',
      () => cancel(controller.signal.reason), { once: true }))
    void cancelled.catch(() => {})
    const abort = () => controller.abort(new AgentMuxError('Metrics reader was cancelled.', 'CONTROL_CANCELLED'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const deadline = setTimeout(() => controller.abort(new AgentMuxError('Metrics owner did not answer within its observation budget.',
      'CONTROL_TIMEOUT')), agentMuxControlTimeoutMs('metrics.get'))
    let subscription: import('./metrics.js').MetricsSubscription | undefined
    let released: import('./metrics.js').MetricsSubscription | undefined
    const release = (value: import('./metrics.js').MetricsSubscription) => {
      if (released === value) return
      released = value; value.dispose()
    }
    const opening = Promise.resolve().then(() => metrics.subscribe(resolve,
      error => reject(error ?? new AgentMuxError('Metrics ended before a snapshot.', 'CONTROL_UNAVAILABLE')), controller.signal))
    // The owner may finish establishing after this read ends. Release that exact late lease.
    void opening.then(value => { if (controller.signal.aborted) release(value) }, () => {})
    try {
      subscription = await Promise.race([opening, cancelled])
      return await Promise.race([first, cancelled])
    } finally {
      clearTimeout(deadline); signal?.removeEventListener('abort', abort); controller.abort()
      if (subscription) release(subscription)
    }
  }
  private async sessions(filters: Record<string, unknown>) {
    rpcRecord(filters, NATIVE_FIELDS['agent.ls'])
    validateFilters(filters)
    const clients = await this.clients()
    const scopes = await Promise.allSettled(clients.map(async scope => await Promise.all((await this.ownedSessions(scope)).map(async session => {
      try {
        const observed = await scope.client.statusAgent(session.agentSessionId)
        if (observed.session.run.runId !== session.run.runId) throw new AgentMuxError('Session changed during inspection.', 'STALE_AGENT_SESSION')
        return { session: { ...observed, routeHostId: scope.hostId } }
      }
      catch (error) { return { error: { agentSessionId: session.agentSessionId as string | null, hostId: scope.hostId, ...cause(error, 'LIST_SESSION_FAILED') } } }
    }))))
    const results = scopes.flatMap((scope, index) => scope.status === 'fulfilled' ? scope.value
      : [{ error: { agentSessionId: null, hostId: clients[index]!.hostId, ...cause(scope.reason, 'AGENT_SESSION_STORE_READ_UNCONFIRMED') } }])
    const sessions = results.flatMap(item => item.session ? [item.session] : []).filter(item =>
      agentSessionMatches(item, { sessionId: filters.agentSessionId as string | undefined, status: filters.status as string | undefined,
        since: filters.since === undefined ? undefined : rpcCount(filters.since, 0) }) &&
      (!filters.executorId || item.session.executorId === filters.executorId) &&
      true)
      .slice(0, rpcCount(filters.limit, 100, 1000))
    return { sessions, errors: results.flatMap(item => item.error ? [item.error] : []) }
  }
  private async goals(filters: Record<string, unknown>): Promise<AgentMuxDemand[]> {
    rpcRecord(filters, NATIVE_FIELDS['goal.activity'])
    validateFilters(filters)
    const result = await this.execute(this.request('demand.list'))
    if (result.operation !== 'demand.list') throw new AgentMuxError('Goal list is mismatched.', 'CONTROL_PROTOCOL_ERROR')
    return result.demands.filter(goal => (!filters.goalId || goal.id === filters.goalId) &&
      (!filters.projectId || goal.projectId === filters.projectId) &&
      (!filters.agentSessionId || goal.sessionIds.includes(String(filters.agentSessionId))) &&
      (!filters.assigneeSessionId || goal.assigneeSessionIds.includes(String(filters.assigneeSessionId))) &&
      (!filters.supervisorSessionId || goal.supervisorSessionId === filters.supervisorSessionId) &&
      (!filters.status || goal.status === filters.status) &&
      (filters.since === undefined || goal.updatedAt >= rpcCount(filters.since, 0)))
      .slice(0, rpcCount(filters.limit, 100, 1000))
  }
  private async send(p: Record<string, unknown>, caller: Awaited<ReturnType<AgentMuxRpcService['authenticated']>>, context: AgentMuxRpcCallContext) {
    const target = rpcRecord(p.target)
    const sourceChannel = normalizeMessageChannel(p.sourceChannel ?? 'api')
    const observedDevice = this.ports.operationSource?.(context)
    const sourceDevice = observedDevice === undefined ? undefined : normalizeOperationDevice(observedDevice)
    const operationId = rpcString(p.operationId, 'Operation ID'), text = rpcText(p.text, 'Message text')
    const expectedRun = p.expectedRun === undefined ? undefined : {
      runId: rpcString(rpcRecord(p.expectedRun, ['runId']).runId, 'Expected recipient Run ID') }
    const messageId = p.messageId === undefined ? 'message-' + createHash('sha256').update(operationId).digest('hex') : rpcString(p.messageId, 'Message ID')
    if (p.execution !== undefined && p.execution !== 'default' && p.execution !== 'immediate') throw new AgentMuxError('Prompt execution is invalid.', 'INVALID_CONTROL_REQUEST')
    const execution = p.execution ?? 'default'
    // The retained operation belongs to the original local semantic endpoint.
    // It is checked before reading today's Tab/Region occupant, never by an
    // all-Host lookup. Remote first-ACK route persistence remains a separate gap.
    const local = (await this.clients()).filter(scope => scope.hostId === 'local' && !scope.client.forwardRpc)
    const journal = local.length === 1 && (!caller || caller.client === local[0]!.client)
      ? new DurableAgentMuxMessageQueue(local[0]!.client.agentMessageQueuePath()) : null
    const original = journal ? await journal.readByOperationId(operationId) ??
      (p.messageId === undefined ? null : await journal.readByMessageId(messageId)) : null
    if (expectedRun && original) {
      const originalRunId = original.envelope.recipientRunId ?? original.promptCondition?.expectedRun.runId ??
        (original.admissionIntent?.kind === 'manual-actor' ? original.admissionIntent.expectedRun.runId : undefined)
      if (!originalRunId) throw new AgentMuxError('The original recipient Run is unconfirmed. Keep this operation, message and body; inspect the original intake before retrying.', 'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
      if (originalRunId !== expectedRun.runId) throw new AgentMuxError('Expected Run does not match this original message. Its identity and body are retained.', 'MESSAGE_RECIPIENT_MISMATCH')
    }
    let recipientId: string
    if (original) {
      if (!['self', 'agent-session', 'region', 'tab'].includes(String(target.kind)) || !original.envelope.recipientSessionId) throw new AgentMuxError('The original message target is unconfirmed.', 'MESSAGE_RECIPIENT_MISMATCH')
      rpcRecord(target, target.kind === 'self' ? ['kind'] : ['kind', target.kind === 'agent-session' ? 'agentSessionId' : target.kind === 'region' ? 'regionId' : 'tabId'])
      if (target.kind === 'agent-session' && (await this.owner(rpcString(target.agentSessionId, 'Recipient Session ID'))).agentSessionId !== original.envelope.recipientSessionId ||
          target.kind === 'self' && this.requireCaller(caller).agentSessionId !== original.envelope.recipientSessionId) throw new AgentMuxError('This operation already names another original recipient.', 'MESSAGE_RECIPIENT_MISMATCH')
      recipientId = original.envelope.recipientSessionId
    } else if (target.kind === 'self') { rpcRecord(target, ['kind']); recipientId = this.requireCaller(caller).agentSessionId }
    else if (target.kind === 'agent-session') {
      rpcRecord(target, ['kind', 'agentSessionId'])
      recipientId = (await this.owner(rpcString(target.agentSessionId, 'Recipient Session ID'))).agentSessionId
    } else if (target.kind === 'region' || target.kind === 'tab') {
      rpcRecord(target, ['kind', target.kind === 'region' ? 'regionId' : 'tabId'])
      const regions = await (async () => {
        if (this.ports.execute) {
          const inspected = await this.execute(this.request(target.kind === 'region' ? 'inspect.region' : 'inspect.tab', { target }))
          return inspected.operation === 'inspect.region' ? [inspected.region]
            : inspected.operation === 'inspect.tab' ? inspected.tab.regions : []
        }
        const inspected = await this.ports.forwardControl?.('space.inspect', {
          target: target.kind === 'region' ? { regionId: rpcString(target.regionId, 'Region ID') } : { tabId: rpcString(target.tabId, 'Tab ID') }
        }, context)
        const presentation = inspected?.presentation
        if (!presentation) throw new AgentMuxError('The original presentation owner is unavailable. No message was submitted.', 'CONTROL_UNAVAILABLE')
        return target.kind === 'region' ? presentation.region ? [presentation.region] : [] : presentation.tab?.regions ?? []
      })()
      const candidates = agentMuxMessageTargetCandidates(regions)
      if (candidates.length !== 1) throw Object.assign(new AgentMuxError('Target has no unique Agent Session.',
        candidates.length ? 'MESSAGE_TARGET_NOT_UNIQUE' : 'MESSAGE_TARGET_NOT_AGENT'), { candidates })
      recipientId = candidates[0]!.agentSessionId
    } else throw new AgentMuxError('Message target is invalid.', 'INVALID_CONTROL_REQUEST')
    const recipientOwner = await this.owner(recipientId)
    if (recipientOwner.client.forwardRpc) {
      if (caller && caller.client !== recipientOwner.client) throw new AgentMuxError('Managed credentials cannot cross semantic Runtime owners.', 'AGENT_CAPABILITY_INVALID')
      // Resolve presentation exactly once. The original remote owner alone queues
      // the envelope and admits input against its current Session and Run.
      return await recipientOwner.client.forwardRpc('agent.send', { ...p,
        operationId, text, target: { kind: 'agent-session', agentSessionId: recipientId } }, await this.inputForwardContext(context))
    }
    const durable = (await recipientOwner.client.readAgentSessions()).find(session => session.agentSessionId === recipientId)
    if (!durable) throw new AgentMuxError('Recipient Session is no longer retained.', 'UNKNOWN_AGENT_SESSION')
    if (expectedRun && !original && durable.run.runId !== expectedRun.runId) throw new AgentMuxError(
      'Expected Run does not match the current retained recipient Run. No new message was saved or submitted.', 'MESSAGE_RECIPIENT_MISMATCH')
    const terminalManual = p.execution === 'immediate'
    // A new direct producer saves its exact durable target before requiring a
    // Runtime connection. Catalog selects a contract, never Native readiness.
    const recipient = terminalManual ? durable : await recipientOwner.client.refreshAgentSession(recipientId, durable.run)
    const queuePath = (caller?.client ?? recipientOwner.client).agentMessageQueuePath()
    if (original && queuePath !== local[0]!.client.agentMessageQueuePath()) throw new AgentMuxError('The original journal route changed; no input will follow another owner.', 'CONTROL_UNAVAILABLE')
    const envelope = { operationId, createdAt: Date.now(),
      sender: caller ? { kind: 'agent-session' as const, agentSessionId: caller.agentSessionId }
        : { kind: 'human' as const, principal: 'local-cli' as const },
      recipient: { kind: 'agent-session' as const, agentSessionId: recipientId },
      threadId: p.threadId === undefined ? messageId : rpcString(p.threadId, 'Thread ID'),
      correlationId: p.correlationId === undefined ? messageId : rpcString(p.correlationId, 'Correlation ID'),
      replyTo: p.replyTo === undefined ? null : rpcString(p.replyTo, 'Reply message ID'), workspaceId: null,
      senderSessionId: caller?.agentSessionId ?? null, senderRunId: original ? original.envelope.senderRunId : caller?.session.run.runId ?? null,
      recipientSessionId: recipientId, recipientRunId: original ? original.envelope.recipientRunId : recipient.run.runId, body: text }
    // Both participant bindings came from their current Core owners. Public
    // inputs cannot supply sender or Run facts; rechecking a cached registry here
    // would reject a valid capability rotation or a recipient on another Host.
    // This direct producer has no caller after-condition. Only a new explicit
    // immediate current-terminal message gets manual actor intent before its first save.
    // The journal returns an existing record unchanged, including missing tags.
    const historical = terminalManual ? await recipientOwner.client.inspectAgentPromptSubmission({ kind: 'message', agentSessionId: recipientId,
      expectedRun: recipient.run, messageId }) : null
    if (terminalManual && !original && !historical) {
      // New manual intake is a Core capability, independent of presentation. The
      // same SDK owner serializes firstsave with Session input admission; a
      // Renderer roundtrip must not append a second producer before that owner.
      const inputReceipt = await recipientOwner.client.submitAgentMessage({ agentSessionId: recipientId,
        envelope: { ...envelope, messageId, schema: 'agentmux.a2a.v1' }, admissionIntent: { kind: 'manual-actor', expectedRun: { ...recipient.run } }, execution: 'immediate',
        sourceChannel, ...(sourceDevice ? { sourceDevice } : {}), ...(caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {}) }, this.inputCallContext(context))
      const { input: _internal, ...saved } = await appendGlobalMessage({ ...envelope, messageId, execution, sourceChannel,
        ...(sourceDevice ? { sourceDevice } : {}) }, queuePath, { admissionIntent: { kind: 'manual-actor', expectedRun: { ...recipient.run } } })
      const currentReceipt = inputReceipt ? await recipientOwner.client.inspectAgentInput({ key: inputReceipt.key },
        caller ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined) : undefined
      return { ...saved, ...(currentReceipt ? { inputReceipt: currentReceipt } : {}) }
    }
    const queued = await appendGlobalMessage({ ...envelope, messageId, execution, sourceChannel, ...(sourceDevice ? { sourceDevice } : {}) }, queuePath,
      { ...(terminalManual ? { admissionIntent: { kind: 'manual-actor', expectedRun: { ...recipient.run } } as const,
        } : {}) })
    const { input: _internalInput, ...publicQueued } = queued
    if (original && queued.input) return { ...publicQueued, inputReceipt: (await recipientOwner.client.inspectAgentInput({ key: queued.input.intent.key },
      caller ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined))! }
    if (queued.delivery.state === 'delivered') return { ...publicQueued,
      ...(queued.input ? { inputReceipt: (await recipientOwner.client.inspectAgentInput({ key: queued.input.intent.key }))! } : {}) }
    try {
      const originalIntent = queued.admissionIntent
      const promptCondition = originalIntent === undefined ? await prepareGlobalMessagePrompt(queued.messageId, async recorded => {
        if (recorded.recipientRunId !== recipient.run.runId || recorded.recipientSessionId !== recipientId) {
          throw new AgentMuxError('Queued recipient Run changed.', 'MESSAGE_RECIPIENT_MISMATCH')
        }
        if (!this.ports.execute) return agentPromptCondition(await recipientOwner.client.refreshAgentSession(recipientId, recipient.run))
        const active = await this.execute(this.request('list.active-agents', { agentSessionId: recipientId }))
        if (active.operation !== 'list.active-agents') throw new AgentMuxError('Prompt facts are unavailable.', 'CONTROL_PROTOCOL_ERROR')
        return validateAgentPromptCondition(active.agents.find(agent => agent.agentSessionId === recipientId)?.promptCondition)
      }, queuePath) : undefined
      if (originalIntent && originalIntent.kind !== 'manual-actor') throw new AgentMuxError('The original direct message intent is unconfirmed.', 'AGENT_PROMPT_INPUT_UNCONFIRMED')
      const admission = originalIntent ? { admissionIntent: originalIntent } : { condition: promptCondition! }
      let inputReceipt: AgentInputSubmissionReceipt | void
      if (!this.ports.execute) inputReceipt = await recipientOwner.client.submitAgentMessage({
        agentSessionId: recipientId, envelope: queued.envelope, ...admission,
        execution, ...(queued.sourceChannel ? { sourceChannel: queued.sourceChannel } : {}), ...(queued.sourceDevice ? { sourceDevice: queued.sourceDevice } : {}),
        ...(caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {}) } as Parameters<AgentMuxClient['submitAgentMessage']>[0], this.inputCallContext(context))
      else {
        const sent = await this.execute(this.request('send', { requestId: operationId,
        target: { kind: 'agent-session', agentSessionId: queued.envelope.recipientSessionId! }, text,
        ...(originalIntent ? { admissionIntent: originalIntent } : { promptCondition }),
        execution, ...(queued.sourceChannel ? { sourceChannel: queued.sourceChannel } : {}),
        message: queued.envelope, ...(caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {}) }))
        inputReceipt = sent.operation === 'send' ? sent.inputReceipt : undefined
      }
      if (inputReceipt && inputReceipt.status !== 'admitted' && inputReceipt.status !== 'terminal-confirmed') return { ...publicQueued, agentSessionId: recipientId, inputReceipt }
      const { input: _control, ...delivered } = await recordGlobalMessageDelivery(queued.messageId, 'delivered', Date.now(), undefined, queuePath)
      return { ...delivered, agentSessionId: recipientId, ...(inputReceipt ? { inputReceipt } : {}) }
    } catch (error) {
      await recordGlobalMessageDeliveryIssue(queued.messageId, 'Delivery is unconfirmed: ' + cause(error).message, Date.now(), queuePath).catch(() => {})
      throw error
    }
  }

  private async snapshot(p: Record<string, unknown>): Promise<AgentMuxRpcSnapshot> {
    validateFilters(p)
    const filters = p as AgentMuxRpcSnapshotParams
    const observation: AgentMuxRpcSnapshot = { projects: [], workspaces: [], topics: [], motes: [],
      spaces: [], zones: [], executors: [], agents: [], sessions: [], goals: [], decisions: [], activity: [], unavailable: [] }
    const sources = [
      ['projects', 'list.projects'], ['executors', 'list.agents'], ['agents', 'list.active-agents'], ['goals', 'demand.list'], ['spaces', 'space.ls']
    ] as const
    const include = p.include === undefined ? null : p.include
    if (include !== null && (!Array.isArray(include) || include.some(key => typeof key !== 'string' || !Object.hasOwn(observation, key) || key === 'unavailable'))) {
      throw new AgentMuxError('Snapshot inclusion is invalid.', 'INVALID_CONTROL_REQUEST')
    }
    const wanted = (name: string) => include === null || (include as string[]).includes(name)
    await Promise.all(sources.map(async ([source, operation]) => {
      if (!wanted(source) && !(source === 'spaces' && ['zones', 'workspaces'].some(wanted)) &&
        !(source === 'goals' && ['decisions', 'activity'].some(wanted))) return
      try {
        const result = await this.execute(this.request(operation, operation === 'space.ls' ? { target: {} } : {}))
        if (result.operation === 'list.projects') observation.projects = result.projects.filter(project => !p.projectId || project.projectId === p.projectId)
        if (result.operation === 'list.agents') observation.executors = result.agents.filter(agent => !p.executorId || agent.executorId === p.executorId)
        if (result.operation === 'list.active-agents') observation.agents = result.agents.filter(agent =>
          (!p.agentSessionId || agent.agentSessionId === p.agentSessionId) && (!p.projectId || agent.projectId === p.projectId) &&
          (!p.executorId || agent.executorId === p.executorId) && (!p.status || agent.status === p.status))
        if (result.operation === 'demand.list') {
          const goals = result.demands.filter(goal => (!p.goalId || goal.id === p.goalId) && (!p.projectId || goal.projectId === p.projectId) &&
            (!p.agentSessionId || goal.sessionIds.includes(String(p.agentSessionId))) && (!p.assigneeSessionId || goal.assigneeSessionIds.includes(String(p.assigneeSessionId))) && (!p.supervisorSessionId || goal.supervisorSessionId === p.supervisorSessionId) &&
            (!p.status || goal.status === p.status) && (p.since === undefined || goal.updatedAt >= rpcCount(p.since, 0)))
          observation.goals = rpcControlResult('goal.ls', { operation: 'demand.list', demands: goals }).goals as AgentMuxRpcSnapshot['goals']
          observation.activity = goals.flatMap(goal => (goal.activities ?? []).map(activity => ({ goalId: goal.id, ...activity })))
          for (const goal of wanted('decisions') ? goals : []) {
            try { const decisions = await this.execute(this.request('demand.decision-log', { demandId: goal.id }))
              if (decisions.operation === 'demand.decision-log') observation.decisions.push({ goalId: goal.id, decisions: decisions.decisions })
            } catch (error) { observation.unavailable.push({ source: 'decisions', ...unavailable(error) }) }
          }
        }
        if (result.operation === 'space.ls') {
          observation.spaces = result.catalog.spaces.filter(space => (!p.projectId || space.projectId === p.projectId) && (!p.topicId || space.topicId === p.topicId))
          const ids = new Set((observation.spaces as typeof result.catalog.spaces).map(space => space.spaceId))
          const zones = result.catalog.zones.filter(zone => (!p.workspaceId || zone.workspaceId === p.workspaceId) &&
            (!p.topicId && !p.projectId || result.catalog.bindings.some(binding => binding.zoneId === zone.zoneId && ids.has(binding.spaceId))))
          observation.zones = zones
          // Zone bindings are not a Workspace metadata source. Keep that fact
          // unavailable unless the original config/filesystem port supplies it.
        }
      } catch (error) { observation.unavailable.push({ source, ...unavailable(error) }) }
    }))
    if (wanted('sessions')) {
      try { const sessions = await this.sessions({ agentSessionId: p.agentSessionId, executorId: p.executorId,
        status: p.status, since: p.since, limit: p.limit })
        observation.sessions = sessions.sessions
        observation.unavailable.push(...sessions.errors.map(error => ({ source: 'sessions', ...unavailable(new AgentMuxError(`Host ${JSON.stringify(error.hostId)}${error.agentSessionId === null ? '' : ` Session ${JSON.stringify(error.agentSessionId)}`}: ${error.message}`, error.code)) })))
      } catch (error) { observation.unavailable.push({ source: 'sessions', ...unavailable(error) }) }
    }
    if (this.ports.snapshot) {
      try { const extra = await this.ports.snapshot(filters)
        for (const [key, value] of Object.entries(extra)) if (key === 'unavailable') observation.unavailable.push(...value as AgentMuxRpcSnapshot['unavailable'])
          else if (Object.hasOwn(observation, key) && wanted(key)) (observation as unknown as Record<string, unknown>)[key] = value
      } catch (error) { observation.unavailable.push({ source: 'filesystem', ...unavailable(error) }) }
    } else for (const source of ['topics', 'motes', 'workspaces']) if (wanted(source)) observation.unavailable.push({ source,
      code: 'FILESYSTEM_SCOPE_UNAVAILABLE', message: 'The original filesystem/config discovery owner is unavailable.',
      recovery: 'Connect the client-owned filesystem/config observation port.' })
    const limit = rpcCount(p.limit, 100, 1000)
    for (const key of Object.keys(observation)) if (key !== 'unavailable') {
      (observation as unknown as Record<string, unknown>)[key] = wanted(key)
        ? (observation as unknown as Record<string, unknown[]>)[key]!.slice(0, limit) : []
    }
    return observation
  }

  async subscribe<M extends AgentMuxRpcStreamMethod>(method: M, params: Record<string, unknown>,
    onEvent: (event: AgentMuxRpcStreamEvent<M>) => void | Promise<void>, context: AgentMuxRpcCallContext = {}): Promise<AgentMuxRpcServiceSubscription<M>> {
    if (Object.hasOwn(AGENTMUX_HOSTED_RPC_METHODS, method)) {
      const hosted = await this.hosted(method, params, context)
      return await hosted.owner.subscribe(method, hosted.params, onEvent as (event: import('./hosted-client-contract.js').AgentMuxHostedStreamEvent) => void | Promise<void>,
        { ...(context.signal ? { signal: context.signal } : {}) }) as AgentMuxRpcServiceSubscription<M>
    }
    await this.assertRuntimeFence(context)
    const caller = await this.authenticated(context)
    const toolkitRequest = method === 'toolkit.watch' ? rpcControlRequest(method, params) : null
    if (toolkitRequest?.operation === 'toolkit.watch' && toolkitRequest.evaluateOnDisplay === true) {
      // Opting into execution keeps the original official-script boundary before any forwarding.
      await this.assertToolkitExecutionAuthority(toolkitRequest.toolId, context)
    }
    let outputOwner: Awaited<ReturnType<AgentMuxRpcService['owner']>> | undefined, forwardOutput = false
    if (method === 'agent.output') {
      rpcRecord(params, NATIVE_FIELDS['agent.output'])
      if (params.follow !== undefined && typeof params.follow !== 'boolean') throw new AgentMuxError('Output follow must be boolean.', 'INVALID_CONTROL_REQUEST')
      const id = rpcString(params.agentSessionId, 'Session ID')
      rpcCount(params.afterByte, 0)
      try { outputOwner = id === 'self' ? this.requireCaller(caller) : await this.owner(id) }
      catch (error) {
        if (id === 'self' || !(error instanceof AgentMuxError) || error.code !== 'UNKNOWN_AGENT_SESSION' || !this.ports.forwardSubscription) throw error
        forwardOutput = true
      }
    }
    if (this.ports.forwardSubscription && (forwardOutput || method === 'browser.follow' || method === 'toolkit.watch' || method === 'system.metrics.watch' || method === 'settings.appearance.watch')) {
      let initial: AgentMuxRpcStreamInitial<M> | undefined
      const subscription = await this.ports.forwardSubscription(method, params as import('./public-rpc.js').AgentMuxRpcStreamParams<M>, {
        onInitial: value => { initial = value }, onEvent: event => { void onEvent(event) },
        onEnd: error => { void onEvent(error ? { type: 'error', error: readerError(error) } : { type: 'end', data: {} }) },
        ...(context.signal ? { signal: context.signal } : {})
      }, context)
      if (initial === undefined) { await subscription.dispose(); throw new AgentMuxError('Forwarded observation returned without its opening response.', 'CONTROL_PROTOCOL_ERROR') }
      return { initial, dispose: () => subscription.dispose() }
    }
    const controller = new AbortController()
    const aborted = () => { controller.abort(); void dispose().catch(() => {}) }
    context.signal?.addEventListener('abort', aborted, { once: true })

    let closed = false, cleaned = false, cleanup: (() => void | Promise<void>) | undefined
    const dispose = async () => { closed = true; controller.abort();
      context.signal?.removeEventListener('abort', aborted); if (cleanup && !cleaned) { cleaned = true; await cleanup() } }
    if (context.signal?.aborted) await dispose()
    const emit = (event: unknown) => { if (!closed) return onEvent(event as AgentMuxRpcStreamEvent<M>) }
    try {
      let initial: unknown, start: (() => void | Promise<void>) | undefined
      if (method === 'agent.output') {
        const owner = outputOwner!
        const cursor = rpcCount(params.afterByte, 0)
        const current = await owner.client.refreshAgentSession(owner.agentSessionId, owner.session.run), runId = current.run.runId
        const ordered = new OrderedSessionOutputFollow(runId, cursor,
          async event => { for (let offset = 0; offset < event.dataBytes.length && !closed; offset += 128 * 1024) {
            const dataBytes = event.dataBytes.subarray(offset, offset + 128 * 1024), startByte = event.startByte + offset
            await emit({ type: 'output', data: bytes({ ...event, dataBytes, startByte, endByte: startByte + dataBytes.length }) })
          } }, event => { void emit({ type: 'end', data: { runId, ...event } }) },
          error => { void Promise.resolve(emit({ type: 'error', error: readerError(error) })).finally(dispose).catch(() => {}) })
        let attached: Awaited<ReturnType<AgentMuxClient['observeAgentOutput']>> | undefined
        cleanup = async () => { if (attached) await attached.close() }
        attached = await owner.client.observeAgentOutput(owner.agentSessionId, cursor, event => {
          if (event.type === 'agent-error') { void emit({ type: 'error', error: { code: event.code, message: event.message, evidence: event.evidence } }); return }
          if (params.follow === true) ordered.accept(event)
        })
        if (attached.session.run.runId !== runId || attached.attachment.run.runId !== runId) {
          throw new AgentMuxError('Session changed before output observation completed. Its Run is kept.', 'STALE_AGENT_SESSION')
        }
        initial = { session: attached.session, run: attached.attachment.run, gap: attached.attachment.gap,
          terminal: attached.attachment.terminal, resizeRevision: attached.attachment.resizeRevision }
        start = async () => {
          try { await ordered.finishReplayAsync(attached!.attachment.replay) }
          catch (error) { await emit({ type: 'error', error: readerError(error) }); await dispose(); return }
          if (params.follow !== true || attached!.attachment.run.state !== 'running') await emit({ type: 'end',
            data: { runId, state: attached!.attachment.run.state, reason: params.follow === true ? 'owner-ended' : 'replay-complete' } })
        }
      } else if (method === 'browser.follow') {
        const request = rpcControlRequest(method, params, caller ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined)
        if (request.operation !== 'browser.subscribe' || !this.ports.subscribeBrowserOperation) throw new AgentMuxError('Browser subscriptions are unavailable.', 'BROWSER_SUBSCRIBE_UNSUPPORTED')
        const sub = await this.ports.subscribeBrowserOperation(request, event => emit({ type: 'progress', data: event }))
        initial = { runOperation: sub.runOperation, gap: sub.gap }; cleanup = () => sub.dispose()
      } else if (method === 'settings.appearance.watch') {
        rpcRecord(params, [])
        if (!this.ports.appearance) throw new AgentMuxError('Appearance observations are unavailable. Keep the last confirmed theme and reconnect this reader.', 'CONTROL_UNAVAILABLE')
        let previous: Pick<import('./public-rpc-settings-observation.js').AgentMuxAppearanceObservation, 'sourceId' | 'revision'> | undefined
        const sub = await this.ports.appearance.subscribe(value => {
          const observation = parseAppearanceObservation(value, previous)
          previous = { sourceId: observation.sourceId, revision: observation.revision }
          return emit({ type: 'snapshot', data: observation })
        }, error => emit(error ? { type: 'error', error: readerError(error) } : { type: 'end', data: {} }), controller.signal)
        cleanup = () => sub.dispose()
        const observation = parseAppearanceObservation(sub.initial)
        previous = { sourceId: observation.sourceId, revision: observation.revision }
        initial = { observation }; start = () => sub.start()
      } else if (method === 'toolkit.watch') {
        const request = toolkitRequest!
        if (request.operation !== 'toolkit.watch' || !this.ports.toolkit) throw new AgentMuxError('Toolkit subscriptions are unavailable.', 'TOOLKIT_UNSUPPORTED')
        const sub = await this.ports.toolkit.subscribe(request.toolId, data => emit({ type: 'snapshot', data }),
          error => emit(error ? { type: 'error', error: readerError(error) } : { type: 'end', data: {} }), controller.signal,
          { ...(request.captureFailure ? { captureFailure: true as const } : {}),
            ...(request.includeFailureEvidence ? { includeFailureEvidence: true as const } : {}),
            ...(request.evaluateOnDisplay === undefined ? {} : { evaluateOnDisplay: request.evaluateOnDisplay }) })
        initial = { toolId: request.toolId }; cleanup = () => sub.dispose()
      } else {
        rpcRecord(params, [])
        if (!this.ports.metrics) throw new AgentMuxError('Metrics subscriptions are unavailable.', 'METRICS_UNSUPPORTED')
        let resolve!: (value: import('./metrics.js').MetricsObservation) => void, reject!: (error: unknown) => void
        const first = new Promise<import('./metrics.js').MetricsObservation>((yes, no) => { resolve = yes; reject = no })
        void first.catch(() => {})
        controller.signal.addEventListener('abort', () => reject(new AgentMuxError('Metrics reader was cancelled.', 'CONTROL_CANCELLED')), { once: true })
        if (controller.signal.aborted) reject(new AgentMuxError('Metrics reader was cancelled.', 'CONTROL_CANCELLED'))
        let observed = false
        const sub = await this.ports.metrics.subscribe(data => { if (!observed) { observed = true; resolve(data) }
          else emit({ type: 'snapshot', data }) }, error => { if (!observed) reject(error ?? new AgentMuxError('Metrics ended without a snapshot.', 'CONTROL_UNAVAILABLE'))
          else emit(error ? { type: 'error', error: readerError(error) } : { type: 'end', data: {} }) }, controller.signal)
        cleanup = () => sub.dispose(); initial = { observation: await first }
      }
      if (controller.signal.aborted) { await dispose(); throw new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED') }
      return { initial: initial as AgentMuxRpcStreamInitial<M>, ...(start ? { start } : {}), dispose }
    } catch (error) { await dispose(); throw error }
  }
}
