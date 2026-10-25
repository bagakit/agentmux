import { parseAgentInputResourceRead } from './agent-input-resource.js'
import { isConnectionApiMethod, parseConnectionApiParams } from './connection-api-codec.js'
import { isBackgroundLocalAgentOpen } from './spatial-agent-open-contract.js'
import { parseGoalParticipationConfirm } from './goal-participation.js'
import { parseGoalChanges, type GoalChangePort } from './goal-changes.js'
import { isAgentProgressMethod, parseAgentProgressParams, parseAgentProgressResult, type AgentProgressOwner, type AgentProgressMethod } from './agent-progress.js'
import { parseAgentAutomationTarget, parseAgentAutomationInspection } from './agent-automation.js'
import { isConnectionApplicationAccessMethod, parseConnectionApplicationAccessParams } from './connection-application-access-codec.js'
import { isConnectionCredentialMethod } from './connection-credential-codec.js'
import { homedir } from 'node:os'
import { discoverAgentSkills } from './agent-skills.js'
import { isChannelMetadataMethod, parseChannelMetadataParams, parseChannelMetadataChange } from './channel-metadata-codec.js'
import { parseCapsuleInputRequest, parseCapsuleInputResult, type CapsuleInputPort } from './capsule-input.js'
import { isCapsuleRuntimeMethod, parseCapsuleRuntimeParams, parseCapsuleRuntimeResult, type CapsuleRuntimeMethod, type CapsuleRuntimePort } from './capsule-runtime.js'
import { isCapsuleMethod, parseCapsuleRpcParams, parseCapsuleRpcResult, type CapsuleCallContext, type CapsuleMethod, type CapsuleParamsMap, type CapsuleResultMap } from './capsule.js'
import { parseExternalConversationReference, parseExternalConversationReceipt } from './external-conversation.js'
import { isMoteChatMethod, parseMoteChatParams, parseMoteChatResult } from './mote-chat-codec.js'
import { isAgentLearningMethod, parseAgentLearningParams, parseAgentLearningResult,
  type AgentLearningPort, type AgentLearningMethod } from './agent-learning.js'
import type { MoteChatPort, MoteChatMethod, MoteChatParamsMap } from './mote-chat-contract.js'
import { isConnectionDeletionMethod, parseConnectionDeletionParams } from './connection-deletion-codec.js'
import { mintObjectId } from './object-id.js'
import { parseTerminalRecoveryInput, parseTerminalRecoveryResult } from './terminal-recovery.js'
import { isMobileAssetsMethod, parseMobileAssetsParams, parseMobileAssetsResult, parseMobileWebReportParams, parseMobileWebReportReceipt } from './mobile-web-codec.js'
import { readConnectionDiagnosis } from './connection-diagnosis.js'
import { parseFileImportParams, parseFileImportResult } from './public-rpc-file-import.js'
import { runAgentMessageBroadcast, normalizeBroadcastInput } from './agent-message-broadcast.js'
import { parseAgentInputContextCaptureReference, parseAgentInputContextCaptureRead, type AgentInputContextCaptureReader } from './agent-input-context-capture.js'
import { parseFileShareParams, parseFileShareResult, parseFileShareInspectParams, parseFileShareInspectResult, parseFileShareUndoParams, parseFileShareUndoResult } from './public-rpc-file-share.js'
import { assertAgentConnectionAccess, readAgentConnectionDelivery } from './connection-agent-access.js'
import { parseRendererAllocationsResult } from './renderer-allocations.js'
import { parseRendererSceneCaptureResult, parseRendererSceneInspection } from './renderer-performance-scene.js'
import { isApplicationAccessMethod, parseApplicationAccessParams, parseApplicationAccessResult, type ApplicationAccessPort, type ApplicationAccessMethod } from './application-access.js'
import { isDeepStrictEqual } from 'node:util'
import { isConnectionSetupMethod, parseConnectionSetupParams } from './connection-setup-codec.js'
import { parseAgentContinuityControlInput, parseAgentContinuityControlResult } from './agent-session-recovery/control-contract.js'
import { parseRuntimeV8ProfileInput, parseRuntimeV8ProfileResult, type HostV8ProfileInput } from './runtime-v8-profile.js'
import { parseRendererV8ProfileResult } from './renderer-v8-profile.js'
import { parseRendererMemoryResult } from './renderer-memory.js'
import { parseAppMemoryEvidence } from './app-memory-evidence.js'
import { parseRendererHeapSnapshotResult, parseRendererHeapSnapshotInspection } from './renderer-heap-snapshot.js'
import { parseRendererAnimationsResult } from './renderer-animations.js'
import { parseRendererTraceResult } from './renderer-trace.js'
import { ConversationLandmarkStore } from './conversation-landmark-store.js'
import { parseConversationLandmarkQuery, parseConversationLandmarkWrite } from './conversation-landmarks.js'
import { isConnectionServiceMethod, parseConnectionServiceParams } from './connection-service-codec.js'
import { isMoteConnectionMethod, parseMoteConnectionParams, parseMoteConnectionResult } from './mote-connection-codec.js'
import type { MoteConnectionPort, MoteConnectionMethod } from './mote-connection-contract.js'
import { parseMotePreferencesReadInput, parseMotePreferencesSaveParams, parseMotePreferencesReadResult, parseMotePreferencesSaveResult, type MoteConnectionPreferencesPort, type MoteConnectionPreferencesReadInput, type MoteConnectionPreferencesSaveParams } from './mote-preferences.js'
import { isConnectionProfileMethod, parseConnectionProfileParams } from './connection-profile-codec.js'
import { isConnectionEnrollmentMethod, parseConnectionEnrollmentParams } from './connection-enrollment-codec.js'
import { isConnectionDeliveryMethod, parseConnectionDeliveryParams } from './connection-delivery-codec.js'
import { isRoomBindingMethod, parseRoomBindingParams } from './room-binding-codec.js'
import { isRoomProvisioningMethod, parseRoomProvisioningParams } from './room-provisioning-codec.js'
import { isRoomDiscoveryMethod, parseRoomDiscoveryParams } from './room-discovery-codec.js'
import { forwardConversationInput, readRoutedConversation } from './conversation-reader.js'
import { parseConversationViewReleaseInput, parseConversationViewReleaseResult, parseConversationWatchInput, parseConversationRef, parseConversationCheckpointInput, parseConversationCheckpointPage, parseConversationChangesInput, parseConversationChangesPage, parseConversationTimelineReadInput, parseConversationReadPage } from './conversation-changes.js'
import { createAgentMuxSearchReader, type AgentMuxSearchReadContext } from './search-reader.js'
import { createAgentMuxSearchObservationOwner } from './search-observation.js'
import { parseAgentMuxSearchInput } from './search-codec.js'
import { isConnectionMethod, parseConnectionParams, parseConnectionResult } from './connections-codec.js'
import type { ConnectionMethod, ConnectionPort } from './connections-contract.js'
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
import { parseAgentDiscoveryFilters, readAgentDiscovery } from './agent-discovery.js'

import { parseNoteCorpusParams, parseNoteCorpusResult } from './note-corpus.js'
import { parseNotebookObservationParams, type NotebookObservationPort } from './notebook-observation.js'
import { parseNotebookResolveParams } from './note-links.js'
import { inspectNotebook } from './notebook-catalog.js'
import { NOTE_FILE_EXTENSION, readNoteMarkdownHeader } from './note-format.js'
import { AgentMuxNotebookStore } from './notebook-store.js'
import { normalizeMessageChannel } from './message-origin.js'

import { parseFileUploadIdentity, parseFileUploadParams, parseFileUploadResult, type AgentMuxRpcFileUploadsOwner, type FileMethod } from './public-rpc-files.js';
import { isTopicMethod, parseTopicParams, parseTopicResult, type AgentMuxRpcTopicsOwner, type TopicMethod } from './public-rpc-topics.js'
import { isFileMethod, parseFileHistoryParams, parseFileHistoryResult, parseFileCreateParams, parseFileCreateResult, parseFileWriteParams, parseFileWriteResult, parseFileRestoreParams, parseFileRestoreResult, parseFileUndoParams, parseFileUndoResult, parseFileReadParams, parseFileReadResult, parseFileListParams, parseFileListResult, type AgentMuxRpcFilesOwner, type FileWriteResult } from './public-rpc-files.js'
import { isGitMethod, parseGitParams, parseGitResult, type AgentMuxRpcGitOwner, type GitMethod } from './public-rpc-git.js'
import { isAppWindowMethod, parseAppWindowPage, parseAppWindowParams, type AgentMuxRpcWindowsOwner, type AppWindowActor, type AppWindowMethod } from './public-rpc-windows.js'
import { isScheduleMethod, parseScheduleRpcParams, validateScheduleRpcResult, type AgentMuxRpcSchedulesOwner, type ScheduleMethod } from './public-rpc-schedules.js'
import { isNativeDesktopMethod, parseNativeDesktopParams, parseNativeDesktopResult, type AgentMuxRpcNativeDesktopOwner, type NativeDesktopMethod } from './public-rpc-native-desktop.js'
import { AgentMuxSpatialStateStore, spatialCatalog, resolveSpatialRegion } from './spatial-state.js'
import { displayLabel, type AgentMuxNameContext } from './display-label.js'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { parseAgentNativeSessionConfirmation } from './agent-native-session-confirmation.js'
import type { AgentMuxClient } from './client.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxMessageTargetCandidates, agentMuxControlTimeoutMs,
  type AgentMuxControlHost, type AgentMuxControlRequest, type AgentMuxControlResult,
  type AgentMuxControlCaller, type AgentMuxDemand } from './control.js'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from './control-codec.js'
import { AgentMuxError } from './errors.js'
import { readAgentSessionHistory, validateSessionHistoryReadInput, isSessionHistoryQuery } from './session-history-reader.js'
import { parseSessionHistoryResourceParams, parseSessionHistoryResourceResult } from './session-history-resource.js'
import { classifySelfViewFailure } from './agent-self-context.js'
import { resolveAgentSessionId } from './agent-session-id.js'
import { readAgentRoleBindings, registerAgentRole, resolveAgentRole } from './agent-role-directory.js'
import { DurableAgentMuxMessageQueue, readRoutedInputMailbox, appendGlobalMessage, prepareGlobalMessagePrompt, recordGlobalMessageDelivery,
  recordGlobalMessageDeliveryIssue } from './agent-global-message-queue.js'
import { assertAgentMessageRouteIntent, type AgentMessageRoute } from './agent-message-route.js'
import { agentPromptCondition, validateAgentPromptCondition, validateAgentPromptInputKey, validateAgentPromptAdmissionIntent } from './agent-prompt-condition.js'
import { AGENT_INPUT_SUBMIT_FIELDS, parseAgentInputSubmit } from './agent-input-submit.js'
import { parseAgentInputChangesRead, parseAgentInputChangesPage } from './agent-input-changes.js'
import { parseAgentInputMailboxRead } from './agent-input-mailbox.js'
import { validateAgentInputControlId, validateAgentInputWaitRef, type AgentInputSubmissionReceipt, type AgentInputCallContext } from './agent-input-wait.js'
import { diagnoseAgentMux } from './doctor.js'
import { OrderedSessionOutputFollow, type FollowOutput } from './session-output-follow.js'
import { defaultAgentMuxControlSocketPath } from './runtime-paths.js'
import { AGENTMUX_HOSTED_RPC_METHODS, AGENTMUX_HOSTED_RPC_FIELDS, type AgentMuxHostedRuntimeMethod, type AgentMuxRuntimeFence } from './hosted-client-contract.js'
import type { AgentMuxHostedRuntimeService } from './hosted-runtime-service.js'
import type { AgentMuxRpcSubscriptionOptions, AgentMuxRpcSubscription } from './public-rpc-client.js'
import { AgentMuxRpcError, rpcEncode, rpcFailure, type JSONRPCID } from './public-rpc-frame.js'
import { isAgentMuxRpcDeviceMethod, parseAgentMuxRpcDeviceParams, parseAgentMuxRpcDeviceResult,
  type AgentMuxRpcDeviceAdministration } from './public-rpc-device.js'
import { normalizeOperationDevice } from './operation-device.js'
import { rpcControlRequest, rpcControlResult, assertControlResultTarget, rpcRecord, rpcString, rpcText, rpcCount } from './rpc-business-codec.js'
import { parseRpcNativeResult } from './rpc-native-codec.js'
import { parseNativeHistoryParams, parseNativeHistoryResult, parseNativeHistoryResourceParams, parseNativeHistoryResourceResult } from './public-rpc-native-history.js'
import { parseAgentRestartInput } from './agent-session-recovery/restart-contract.js'
import { observeHostRuntime } from './host-runtime-observation.js'
import { observeHostNetwork } from './host-network-observation.js'
import { isHostSettingsMethod, parseHostSettingsParams, parseHostSettingsResult, type HostSettingsMethod } from './public-rpc-host-settings.js'
import { AGENTMUX_RPC_CONTROL_METHODS, AGENTMUX_RPC_NATIVE_METHODS, type AgentMuxRpcMethod,
  type AgentMuxRpcParams, type AgentMuxRpcResult, type AgentMuxRpcCredentials,
  type AgentMuxRpcSnapshotParams, type AgentMuxRpcSnapshot, type AgentMuxRpcStreamMethod,
  type AgentMuxRpcStreamInitial, type AgentMuxRpcStreamEvent, type AgentMuxRpcUnavailable, type AgentMuxRpcPrincipal } from './public-rpc.js'

/** A structural slice of the original public SDK; hosted clients need no private fields. */
export type AgentMuxRpcCorePort = Pick<AgentMuxClient,
  'restartAgent' | 'inspectAgentRestart' | 'reopenAgent' | 'reconcileAgentReopen' | 'agentSessions' | 'readAgentMessageQueuePath' | 'readAgentSession' | 'readAgentSessions' | 'readAgentSessionHistory' | 'recordExternalConversationMessage' | 'readAgentConversation' | 'releaseConversationView' | 'observeConversation' | 'conversationCheckpoint' | 'readConversationChanges' | 'observeSessionHistory' | 'sessionHistorySources' | 'sessionHistoryPage' | 'sessionHistoryResource' | 'sessionTimeline' | 'authorizeRetainedAgentCaller' | 'agentMessageQueuePath' |
  'recoverTerminal' | 'ensureAgentContinuity' | 'controlAgentContinuity' | 'agentSession' | 'refreshAgentSession' | 'confirmAgentNativeSession' | 'resolveAgentSession' | 'statusAgent' |
  'inspectAgentInteractionOperation' | 'respondAgentInteraction' | 'observeAgentOutput' | 'replySessionQuestion' | 'submitAgentMessage' | 'notifyMessages' | 'inspectMessageNotification' | 'inspectAgentPromptSubmission' | 'startDiscussion' | 'checkDeliveries' |
  'submitAgentPrompt' | 'readAgentInputMailbox' | 'readAgentInputChanges' | 'inspectAgentInput' | 'readAgentInputResource' | 'stopAgentInputWaiting' | 'rejoinAgentInputWaiting' | 'listAgentSpawns' |
  'ackDeliveryBatch' | 'openDispatch' | 'showDispatch' | 'readMessage' | 'listMessages' | 'listMessageEvents' | 'inspectMessageBroadcast' | 'readDispatch' | 'listDispatches' | 'recordDispatchEvent' |
  'catalog' | 'connect' | 'inspectManagedHooks' | 'probeAgent' | 'probeExecutorAvailability' | 'listHostNativeAgentSessions' | 'readHostNativeAgentHistory' | 'readHostNativeAgentHistoryResource' |
  'readDeliveryAttempt' | 'readReadingDiagnostic' | 'findReadingDiagnostics' | 'readAgentStartupDiagnostic' | 'findAgentStartupDiagnostics' | 'observeRunStorage' | 'runtimeDiagnostics' | 'runtimeResourceSnapshot' | 'runtimeIdentity' | 'agentCreationAuthority' | 'listTrustedCreationSources' | 'trustCreationSource' | 'listHostExecutors' | 'configureHostExecutor'> & {
    runtimeOwnerIdentity?: import('./hosted-client-contract.js').AgentMuxHostedClient['runtimeOwnerIdentity']
    forwardRpc?: import('./hosted-client-contract.js').AgentMuxHostedForwardRpc
    handOff(...args: Parameters<AgentMuxClient['handOff']>):
      Awaited<ReturnType<AgentMuxClient['handOff']>> | Promise<Awaited<ReturnType<AgentMuxClient['handOff']>>>
  }
export type AgentMuxRpcCoreClient = { hostId: string; client: AgentMuxRpcCorePort }
type BorrowedHostedRuntime = Pick<AgentMuxHostedRuntimeService, 'call' | 'subscribe' | 'assertFence'> & Partial<Pick<AgentMuxHostedRuntimeService, 'client' | 'externalAuthor'>>
export type AgentMuxRpcServiceOptions = Omit<Partial<AgentMuxControlHost>, 'execute'> & {
  execute?(request: AgentMuxControlRequest, nameContext?: AgentMuxNameContext,
    originalContext?: AgentMuxRpcCallContext): Promise<AgentMuxControlResult>
  /** Borrow the original UI-free Capsule owner; no content or configuration is stored here. */
  capsules?: { call<M extends CapsuleMethod>(method: M, params: CapsuleParamsMap[M], context?: CapsuleCallContext,
    originalContext?: AgentMuxRpcCallContext): Promise<CapsuleResultMap[M]> }
  capsuleInput?: CapsuleInputPort
  capsuleRuntime?: CapsuleRuntimePort
  inputContextCaptures?: AgentInputContextCaptureReader
  applicationAccess?: ApplicationAccessPort
  windows?: AgentMuxRpcWindowsOwner
  moteChat?: MoteChatPort
  /** Host-owned learning workflow; Core neither stores nor interprets its knowledge. */
  agentLearning?: AgentLearningPort
  moteConnections?: MoteConnectionPort
  motePreferences?: MoteConnectionPreferencesPort
  connections?: ConnectionPort
  goalDelegations?: GoalDelegationsOwner
  moteContext?: import('./diagnostic-evidence.js').AgentMuxMoteContextEvidencePort
  clientIncidents?(context: AgentMuxRpcCallContext): import('./client-incident.js').AgentMuxClientIncidentPort | Promise<import('./client-incident.js').AgentMuxClientIncidentPort>
  mobileAssets?: import('./mobile-web.js').MobileAssetsPort
  mobileWebReports?: import('./mobile-web.js').MobileWebReportPort
  clientNotifications?: import('./client-notifications.js').AgentMuxClientNotificationsPort
  deliveryAttempts?: { hostId: string; store: DeliveryAttemptStore }
  /** Original semantic owner identity; never ctxmux identity or a route alias. */
  diagnosticCoreAuthority?(scope: AgentMuxRpcCoreClient): import('./diagnostic-evidence.js').AgentMuxDiagnosticAuthorityObservation | Promise<import('./diagnostic-evidence.js').AgentMuxDiagnosticAuthorityObservation>
  conversationLandmarks?: ConversationLandmarkStore
  notebookStore?: AgentMuxNotebookStore
  notebookObservation?: NotebookObservationPort
  files?: AgentMuxRpcFilesOwner
  git?: AgentMuxRpcGitOwner
  fileUploads?: AgentMuxRpcFileUploadsOwner
  moteAvatars?: AgentMuxRpcMoteAvatarsOwner
  topics?: AgentMuxRpcTopicsOwner

  appearance?: AgentMuxAppearanceObservationPort
  /** Original Host resource reads; editable application settings keep their existing owner. */
  settingsResources?(request: Extract<import('./control.js').AgentMuxControlSettingsResourceRequest,
    { operation: 'settings.resource.list' | 'settings.resource.get' }>): Promise<import('./control.js').AgentMuxControlSettingsResourceResult>
  goalParticipation?: import('./goal-participation.js').GoalParticipationOwner
  goalChanges?: GoalChangePort
  progress?: AgentProgressOwner
  schedules?: AgentMuxRpcSchedulesOwner
  automaticInput?: import('./agent-automation.js').AgentAutomationOwner
  /** Original portable Goal business owner; screen focus remains a client capability. */
  goalControl?(request: AgentMuxControlRequest, context?: AgentMuxNameContext,
    originalContext?: AgentMuxRpcCallContext): Promise<AgentMuxControlResult | undefined>
  nativeDesktop?: AgentMuxRpcNativeDesktopOwner
  spatialState?: AgentMuxSpatialStateStore
  /** Original Host policy over Core-owned spatial creation associations, without a screen. */
  spatialAgentControl?(request: AgentMuxControlRequest, context: AgentMuxRpcCallContext): Promise<AgentMuxControlResult | undefined>
  /** Read only original host metadata; topology and execution remain with their Core owners. */
  spatialPresentation?(input: { graph: import('./spatial-graph.js').AgentMuxSpatialGraph;
    catalog: import('./space-control.js').AgentMuxSpaceCatalog; target: import('./space-control.js').AgentMuxSpaceSelector; imageSpaceId?: string },
    context: AgentMuxRpcCallContext): Promise<Pick<import('./space-control.js').AgentMuxSpaceCatalog,
      'agentPresentation' | 'motePresentation' | 'appearance' | 'survey'>>
  /** Optional host aggregation of original named owners; Core interprets no host target kinds. */
  nameHistory?(query: import('./display-label.js').AgentMuxNameHistoryQuery): Promise<import('./display-label.js').AgentMuxNameHistoryPage>
  /** Borrow the original Host configuration owner; no configuration is stored by this service. */
  hostConfiguration?(hostId: string): import('./control.js').AgentMuxControlSettingsResourceFields | null
  endpoint?: import('./public-rpc.js').AgentMuxRpcEndpoint
  endpointPublication?(): import('./control-endpoint-state.js').AgentMuxControlEndpointState
  /** Borrow existing SDK clients. Their lifecycle remains with their host. */
  coreClients?(): readonly AgentMuxRpcCoreClient[] | Promise<readonly AgentMuxRpcCoreClient[]>
  /** Borrow the configured Host's original public transport, preserving its caller and Runtime fence. */
  callOriginalCore?<M extends AgentMuxRpcMethod>(hostId: string, method: M, params: AgentMuxRpcParams<M>,
    context: AgentMuxRpcCallContext): Promise<AgentMuxRpcResult<M>>
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
  hostedRuntime?(): BorrowedHostedRuntime | Promise<BorrowedHostedRuntime>
  /** Forward canonical GUI work before its original business orchestration begins. */
  forwardControl?<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>,
    context: AgentMuxRpcCallContext): Promise<AgentMuxRpcResult<M>>
  forwardSubscription?<M extends AgentMuxRpcStreamMethod>(method: M, params: import('./public-rpc.js').AgentMuxRpcStreamParams<M>,
    handlers: AgentMuxRpcSubscriptionOptions<M>, context: AgentMuxRpcCallContext): Promise<AgentMuxRpcSubscription>
}
export type AgentMuxRpcCallContext = { caller?: AgentMuxRpcCredentials; signal?: AbortSignal; principal?: AgentMuxRpcPrincipal;
  /** In-process transport capability. Never decoded from business arguments. */
  forwarding?: import('./rpc-forwarding.js').RpcForwardingSource;
  /** Exact receiving wire ID for response capacity; never supplied by business params. */
  responseId?: JSONRPCID;
  /** Only the actual Host/transport supplies this current author restriction. */
  assertCurrent?(): void | Promise<void>;
  runtimeFence?: AgentMuxRuntimeFence; afterResponse?: Array<() => void | Promise<void>>;
  /** Actual receiving hop, supplied only by the transport owner. */
  transport?: 'unix' | 'http' | 'relay' }
export type AgentMuxRpcServiceSubscription<M extends AgentMuxRpcStreamMethod = AgentMuxRpcStreamMethod> = {
  initial: AgentMuxRpcStreamInitial<M>; start?(): void | Promise<void>; dispose(): void | Promise<void>
}
type SearchCallContext = AgentMuxSearchReadContext & { rpc: AgentMuxRpcCallContext }
function boundedFileResult(parsed: FileWriteResult, responseId: JSONRPCID = null, allowContentUnavailable = false): FileWriteResult {
  if (parsed.result.status === 'conflict' && parsed.result.noteConflict !== undefined || allowContentUnavailable && parsed.result.status === 'written') {
    try { rpcEncode({ jsonrpc: '2.0', id: responseId, result: parsed }) }
    catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'CONTROL_PROTOCOL_ERROR') throw error
      if (parsed.result.status === 'written') {
        const { content: _content, noteProvenance: _provenance, noteAttribution: _attribution, noteTitleProjection: _title, ...receipt } = parsed.result
        return { resource: parsed.resource, result: { ...receipt,
          contentUnavailable: 'The original body was saved. Its canonical content and accompanying metadata cannot fit the original RPC frame budget. Keep this revision and operation ID; read the exact file or, when available, the selected original history event separately.' } }
      }
      if (parsed.result.status !== 'conflict') throw error
      const { noteConflict: _content, ...receipt } = parsed.result
      return { resource: parsed.resource, result: { ...receipt,
        noteConflictUnavailable: 'The conflict is confirmed, but its three bodies exceed the original RPC frame budget. Keep the original inputs and operation ID. Read the same original file and, when available, its selected history event for content.' } }
    }
  }
  return parsed
}
/** Preserve each original phase/revision when their combined canonical bodies exceed one wire frame. */
export function boundedFileShareResult(parsed: import('./public-rpc-file-share.js').FileShareResult, responseId: JSONRPCID = null, requestInspection = false): import('./public-rpc-file-share.js').FileShareResult {
  try { rpcEncode({ jsonrpc: '2.0', id: responseId, result: requestInspection ? { mode: 'request', result: parsed } : parsed }); return parsed }
  catch (error) { if (!(error instanceof AgentMuxError) || error.code !== 'CONTROL_PROTOCOL_ERROR') throw error }
  const compact = (write: FileWriteResult | null): FileWriteResult | null => {
    if (!write) return null
    if (write.result.status === 'written') {
      const { content: _body, noteProvenance: _provenance, noteAttribution: _attribution, noteTitleProjection: _title, ...receipt } = write.result
      return { resource: write.resource, result: { ...receipt, contentUnavailable: 'The original per-file save is confirmed. Combined shared-save bodies exceed this RPC frame; read this exact file or original history event for canonical bytes.' } }
    }
    if (write.result.status === 'conflict' && write.result.noteConflict) {
      const { noteConflict: _body, ...receipt } = write.result
      return { resource: write.resource, result: { ...receipt, noteConflictUnavailable: 'The original conflict is confirmed; read the same file and original history separately for its bodies.' } }
    }
    return write
  }
  const observe = (read: import('./public-rpc-files.js').FileReadResult): import('./public-rpc-files.js').FileReadResult => read.result.status === 'read' ? { resource: read.resource, result: { status: 'unknown' as const, code: 'NOTE_SHARE_CONTENT_SEPARATE', message: 'Read the same original File separately; combined shared-save observations exceed one RPC frame.' } } : read
  return { ...parsed, promotions: parsed.promotions.map(p => ({ ...p, shared: compact(p.shared), source: compact(p.source), ...(p.currentShared ? { currentShared: observe(p.currentShared) } : {}), ...(p.currentSource ? { currentSource: observe(p.currentSource) } : {}) })), destination: compact(parsed.destination), ...(parsed.undo ? { undo: boundedFileShareUndoResult(parsed.undo, responseId, false, true) } : {}), ...(parsed.currentDestination ? { currentDestination: observe(parsed.currentDestination) } : {}) }
}
export function boundedFileShareUndoResult(parsed: import('./public-rpc-file-share.js').FileShareUndoResult, responseId: JSONRPCID = null, inspection = false, force = false): import('./public-rpc-file-share.js').FileShareUndoResult {
  try { if (!force) { rpcEncode({ jsonrpc: '2.0', id: responseId, result: inspection ? { mode: 'undo', result: parsed } : parsed }); return parsed } }
  catch (error) { if (!(error instanceof AgentMuxError) || error.code !== 'CONTROL_PROTOCOL_ERROR') throw error }
  const compact = (write: FileWriteResult | null): FileWriteResult | null => {
    if (write?.result.status === 'written') { const { content: _body, noteProvenance: _provenance, noteAttribution: _attribution, noteTitleProjection: _title, ...receipt } = write.result; return { resource: write.resource, result: { ...receipt, contentUnavailable: 'The original undo phase was saved. Read the exact file or original history separately for its canonical body.' } } }
    if (write?.result.status === 'conflict' && write.result.noteConflict) { const { noteConflict: _bodies, ...receipt } = write.result; return { resource: write.resource, result: { ...receipt, noteConflictUnavailable: 'The original conflict is confirmed. Read this exact file and original history separately for its bodies.' } } }
    return write
  }
  return { ...parsed, destination: compact(parsed.destination), collections: parsed.collections.map(item => ({ ...item, source: compact(item.source) })) }
}
const NATIVE_FIELDS = {
  'system.metrics.host-profile.capture': ['hostId', 'fence', 'processId', 'durationMs'],
  'goal.delegation.prepare': ['goalId', 'intent', 'materials'], 'goal.delegation.bind': ['goalId', 'intent'], 'goal.delegate': ['goalId', 'intent', 'materials'],
  'goal.report': ['goalId', 'operationId', 'report'], 'goal.collect': ['goalId', 'operationId', 'collection'], 'goal.delegations': ['goalId'],
  'goal.progress': ['goalId', 'progress'],
  'goal.patrol': ['goalId', 'operationId'],
  'goal.patrol.continue': ['goalId', 'patrolOperationId', 'operationId', 'expectedRunId'],
  'goal.patrol.report': ['goalId', 'patrolOperationId', 'report'],
  'goal.participation.confirm': ['goalId','creationOperationId','hostId','agentSessionId','expectedRun','evidence','operationId'],
  'goal.watch': [],
  'settings.appearance.watch': [],
  'notebook.scan': ['workspaceId','path','maxFiles','maxDirectories','maxBytes','query','limit'],
  'notebook.ls': [], 'notebook.inspect': ['notebookId','noteId','operationId','content','maxBytes'], 'notebook.graph': ['notebookId','noteId','maxBytes'], 'notebook.resolve': ['mode','query','limit','text','select','maxBytes'], 'notebook.apply': ['expectedRevision','operationId','change'],
  'space.state': [], 'space.commit': ['expectedRevision','graph','allowEntityRemoval','removedProjectGroupIds'],
  'space.resolve': ['tabId','regionId','direction'],
  'name.history': ['target','afterId','limit'],
  'name.confirm': ['operationId'],
  whoami: [], 'agent.ls': ['agentSessionId', 'executorId', 'providerId', 'status', 'semantic', 'readiness', 'since', 'activitySince', 'cursor', 'limit'],
  'agent.inspect': ['target'],
  'terminal.recover': ['hostId', 'expectedRun', 'runtimeId', 'workspacePath', 'operationId', 'action'],
  'skill.ls': ['hostId', 'agentSessionId'],
  'agent.continuity.control': ['agentSessionId', 'intentOperationId', 'expectedRun', 'operationId', 'action', 'additionalAttempts'],
  'agent.restart': ['agentSessionId', 'expectedRun', 'operationId'],
  'agent.restart.inspect': ['agentSessionId', 'expectedRun', 'operationId'],
  'agent.refresh': ['agentSessionId'],
  'agent.native.confirm': ['agentSessionId', 'expectedRun', 'expectedNativeHandle', 'candidateNativeHandle', 'expectedObservationAt', 'operationId'],
  'agent.native.ls': ['hostId', 'executorId', 'workspacePath'],
  'agent.native.history': ['hostId', 'executorId', 'source', 'cursor', 'limit'],
  'agent.native.history.resource': ['hostId', 'executorId', 'nativeSource', 'source', 'turnId', 'recordId', 'partIndex', 'expectedReference', 'maxBytes', 'offsetBytes', 'representation'],
  'agent.context': ['hostId', 'agentSessionId', 'cursor', 'limit'],
  'agent.interaction.respond': ['agentSessionId', 'expectedRun', 'operationId', 'expectedRequest', 'response', 'externalAction'],
  'agent.interaction.inspect': ['agentSessionId', 'operationId'],
  'agent.question.reply': ['agentSessionId', 'source', 'turnId', 'recordId', 'answers', 'operationId', 'expectedRun', 'afterSubmissionId', 'allowUncertainTurn', 'sourceChannel', 'externalAction'],
  'agent.history.resource': ['hostId', 'agentSessionId', 'source', 'turnId', 'recordId', 'partIndex', 'expectedReference', 'maxBytes', 'offsetBytes', 'representation'],
  'agent.conversation.record': ['hostId', 'agentSessionId', 'ingressId', 'authoritySource'],
  'agent.conversation.checkpoint': ['hostId', 'agentSessionId', 'nativePosition'],
  'agent.conversation.changes': ['hostId', 'agentSessionId', 'checkpoint', 'limit', 'cursor', 'maxBytes', 'view'],
  'agent.conversation.release': ['hostId', 'agentSessionId', 'view'],
  'agent.conversation.watch': ['hostId', 'agentSessionId', 'view'],
  'agent.conversation.inspect': ['hostId', 'agentSessionId', 'limit', 'cursor', 'maxBytes', 'record', 'anchor', 'view', 'nativeSource', 'preserveCurrent'],
  'agent.conversation.landmark.ls': ['hostId', 'agentSessionId', 'operationId'],
  'agent.conversation.landmark.apply': ['hostId', 'agentSessionId', 'operationId', 'expectedRevision', 'change'],
  'agent.history': ['hostId', 'agentSessionId', 'source', 'limit', 'cursor', 'maxBytes', 'kind', 'query', 'scanLimit'],
  'agent.reopen': ['agentSessionId', 'expectedRetiredAt', 'operationId', 'args', 'env', 'commandOverride', 'launchOptions', 'cols', 'rows'], 'agent.reopen.check': ['agentSessionId', 'expectedRetiredAt', 'operationId'], 'agent.role.ls': ['workspacePath'],
  'agent.role.register': ['role', 'providerId'], 'agent.role.resolve': ['role', 'workspacePath'],
  'agent.input.changes': ['hostId', 'agentSessionId', 'limit', 'cursor', 'after'],
  'agent.input.ls': ['hostId', 'agentSessionId', 'limit', 'cursor', 'maxBytes'],
  'agent.input.submit': AGENT_INPUT_SUBMIT_FIELDS,
  'agent.progress.list': ['target'],
  'agent.progress.create': ['target','intervalMs','prompt','taskSource','operationId'],
  'agent.progress.action': ['target','loopId','action','expectedLoop','operationId'],
  'agent.progress.update': ['target','loopId','expectedLoop','intervalMs','prompt','operationId'],
  'agent.automation.pause': ['agentSessionId', 'expectedRun', 'ownerInstanceId', 'operationId'],
  'agent.automation.inspect': ['agentSessionId', 'expectedRun', 'ownerInstanceId', 'operationId'],
  'browser.input.inspect': ['hostId', 'operationId'],
  'agent.input.resource': ['key', 'index', 'revision', 'maxBytes', 'purpose'],
  'agent.input.inspect': ['key', 'kind', 'originalControlOperationId'],
  'agent.input.stop': ['ref', 'cancelOperationId'], 'agent.input.rejoin': ['ref'],
  'agent.send': ['target', 'text', 'messageId', 'threadId', 'correlationId', 'replyTo', 'operationId', 'execution', 'expectedRun', 'sourceChannel', 'admissionIntent'],
  'agent.broadcast': ['operationId', 'recipientSessionIds', 'text', 'sourceChannel'],
  'agent.broadcast.inspect': ['operationId', 'hostId'],
  'agent.discuss': ['executorId', 'providerId', 'text', 'operationId'],
  'agent.spawn.ls': ['hostId', 'participantSessionId', 'direction', 'creatorRuntimeId', 'cursor', 'limit'],
  'agent.handoff': ['toAgentSessionId', 'taskId'], 'agent.output': ['agentSessionId', 'afterByte', 'follow'],
  'system.diagnostics.inspect': ['target', 'includeRaw', 'includeRelated', 'budget'],
  'app.mobile.assets.inspect': ['hostId', 'operationId', 'client'],
  'app.mobile.assets.activate': ['hostId', 'operationId', 'candidatePath', 'candidateDigest', 'expectedActiveRevision'],
  'app.mobile.assets.loaded': ['documentId', 'buildId', 'namespaceDigest', 'occurrenceId', 'observedAt'],
  'app.mobile.report': ['documentId', 'buildId', 'namespaceDigest', 'occurrenceId', 'observedAt', 'observation', 'reporter'],
  'message.delivery.inspect': ['logId', 'hostId'], 'message.delivery.report': ['hostId', 'record'],
  'message.inbox.check': ['limit'], 'message.inbox.ack': ['generation', 'readerRun'],
  'message.notify': ['operationId', 'messageIds', 'hostId'],
  'message.notify.inspect': ['operationId', 'hostId'],
  'message.read': ['operationId', 'messageId', 'notificationId', 'hostId'],
  'message.ls': ['hostId', 'participantSessionId', 'direction', 'beforeSequence', 'limit'],
  'message.events': ['hostId', 'participantSessionId', 'afterSequence', 'latest', 'beforeSequence', 'throughSequence', 'incarnation', 'messageId', 'broadcastOperationId', 'limit'],
  'message.dispatch.open': ['sourceMessageId'], 'message.dispatch.inspect': ['sourceMessageId'],
  'message.dispatch.read': ['sourceMessageId', 'hostId'],
  'message.dispatch.ls': ['hostId', 'participantSessionId', 'afterSourceMessageId', 'limit'],
  'message.dispatch.report': ['sourceMessageId', 'replyMessageId', 'kind'],
  'app.search': ['mode', 'query', 'hostId', 'agentSessionId', 'source', 'limit', 'scanLimit', 'maxBytes', 'cursor'],
  'app.snapshot': ['projectId', 'workspaceId', 'topicId', 'agentSessionId', 'goalId', 'executorId', 'assigneeSessionId', 'supervisorSessionId', 'status', 'since', 'limit', 'include'],
  'goal.activity': ['goalId', 'projectId', 'agentSessionId', 'assigneeSessionId', 'supervisorSessionId', 'status', 'since', 'limit'],
  'system.storage': ['hostId', 'runId'], 'system.doctor': ['workspacePath'], 'system.endpoint': [],
  'system.subscription.cancel': ['subscriptionId']
} as const satisfies Record<Exclude<keyof typeof AGENTMUX_RPC_NATIVE_METHODS, CapsuleRuntimeMethod | CapsuleMethod | AgentLearningMethod | 'capsule.input' | import('./public-rpc-device.js').AgentMuxRpcDeviceMethod | AgentMuxHostedRuntimeMethod | ApplicationAccessMethod | MoteChatMethod | MoteConnectionMethod | MoteAvatarSeriesMethod | MoteAvatarWriteMethod | TopicMethod | ConnectionMethod | HostSettingsMethod | import('./public-rpc-files.js').FileMethod | GitMethod | AppWindowMethod | ScheduleMethod | NativeDesktopMethod>, readonly string[]>

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
  private readonly landmarks: ConversationLandmarkStore
  private readonly notebooks: AgentMuxNotebookStore
  private readonly spatial: AgentMuxSpatialStateStore
  private search: ReturnType<typeof createAgentMuxSearchReader<SearchCallContext>> | undefined
  private local: Promise<AgentMuxClient> | undefined
  constructor(private readonly ports: AgentMuxRpcServiceOptions = {}) { this.landmarks = ports.conversationLandmarks ?? new ConversationLandmarkStore(); this.spatial = ports.spatialState ?? new AgentMuxSpatialStateStore(); this.notebooks = ports.notebookStore ?? new AgentMuxNotebookStore() }

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
    if (method === 'runtime.owner.identity' || method === 'runtime.owner.shutdown' || method === 'runtime.network.inspect' || method === 'runtime.profile.capture') return { owner, params: p }
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
    this.search?.dispose(); this.search = undefined
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
  private async owner(id: string, exactOnly = false) {
    const clients = await this.clients()
    const known = clients.filter(({ client }) => {
      if (this.endpointUnverified(client)) return false
      // This synchronous exact cache lookup only narrows the route. Durable point
      // reads below retain authority; enumerating its whole cache would multiply batch cost.
      try { return client.agentSession(id).agentSessionId === id }
      catch { return false /* A cache observation cannot gate the original durable point read below. */ }
    })
    // Known exact targets do not wait for unrelated endpoint discovery. Authorization
    // and Session binding still come from this original owner's durable Store below.
    const scopes = known.length === 1 ? known : clients
    const exact = await Promise.allSettled(scopes.map(async scope => {
      if (this.endpointUnverified(scope.client)) throw new AgentMuxError('The exact Session owner is unverified.', 'RUNTIME_UNAVAILABLE')
      const session = await scope.client.readAgentSession(id)
      if (!session) return null
      if (session.agentSessionId !== id || session.hostId !== (scope.client.forwardRpc ? 'local' : scope.hostId)) throw new AgentMuxError(
        'Exact Session metadata belongs to another identity or semantic Host.', 'AGENT_SESSION_STORE_READ_UNCONFIRMED')
      return { ...scope, session, agentSessionId: id }
    }))
    const exactIssues = exact.flatMap((item, index) => item.status === 'rejected' ? [unavailable(new AgentMuxError(
      `Exact Session metadata on Host ${scopes[index]!.hostId} is unconfirmed: ${cause(item.reason).message}`,
      item.reason instanceof AgentMuxError && item.reason.code === 'RUNTIME_UNAVAILABLE' ? 'RUNTIME_UNAVAILABLE' : 'AGENT_SESSION_STORE_READ_UNCONFIRMED'))] : [])
    const exactOwners = exact.flatMap(item => item.status === 'fulfilled' && item.value ? [item.value] : [])
    if (exactOwners.length > 1) throw new AgentMuxError(`Agent Session ${JSON.stringify(id)} has multiple authoritative route Hosts. Select the original service endpoint explicitly.`, 'AMBIGUOUS_AGENT_SESSION')
    if (exactOwners.length === 1) return { ...exactOwners[0]!, unavailable: exactIssues }
    if (exactIssues.length) throw new AgentMuxError('Exact Session metadata is unconfirmed. Keep its original identity; no prefix owner was guessed.',
      exactIssues.some(issue => issue.code === 'RUNTIME_UNAVAILABLE') ? 'RUNTIME_UNAVAILABLE' : 'AGENT_SESSION_STORE_READ_UNCONFIRMED')
    if (exactOnly) throw new AgentMuxError('The exact caller Session is not present on the observed Hosts. No inventory was scanned.', 'UNKNOWN_AGENT_SESSION')
    // Only confirmed exact absence permits the original prefix inventory semantics.
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
  private async authenticated(context: AgentMuxRpcCallContext, exactOnly = false) {
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
        if (exactOnly || !(error instanceof AgentMuxError) || error.code !== 'UNKNOWN_AGENT_SESSION') throw error
      }
    }
    const owner = await this.owner(agentSessionId, exactOnly)
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
  private async execute(request: AgentMuxControlRequest, context?: AgentMuxNameContext, executionContext?: AgentMuxRpcCallContext): Promise<AgentMuxControlResult> {
    if (request.operation === 'resume' && !request.text.trim()) {
      const selected = await this.owner(request.target.kind === 'agent-session' ? request.target.agentSessionId : request.caller!.agentSessionId)
      executionContext?.signal?.throwIfAborted(); await executionContext?.assertCurrent?.()
      if (executionContext?.caller) await this.authenticated(executionContext)
      if (selected.client.forwardRpc) {
        const forwarded = await selected.client.forwardRpc('agent.resume', { target: { kind: 'agent-session', agentSessionId: selected.agentSessionId }, operationId: request.requestId, text: '' }, executionContext ?? {})
        return { operation: 'resume', ...forwarded }
      }
      const original = selected.session // owner() read the original durable inventory, including its exact Run.
      const prior = original.continuityOperations?.[request.requestId]
      if (prior?.action === 'restart' || prior?.launchInput) throw new AgentMuxError('The original operation belongs to another lifecycle or input request.', 'AGENT_CONTINUITY_OPERATION_CONFLICT')
      const restored = await selected.client.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: prior?.previousRun ?? original.run,
        operationId: request.requestId, trigger: 'manual' })
      if (restored.kind !== 'resumed' && restored.kind !== 'reattachable') throw new AgentMuxError(
        restored.continuity?.error ?? `The original Resume is ${restored.kind}. Inspect this Session and retry the same operation.`,
        restored.continuity?.errorCode ?? 'AGENT_CONTINUITY_PENDING', JSON.stringify(restored))
      return { operation: 'resume', agentSessionId: original.agentSessionId, runId: restored.session.run.runId }
    }
    if (!this.ports.execute && ['space.ls','space.inspect','space.bind','space.unbind'].includes(request.operation) &&
        !(this.ports.spatialAgentControl && request.operation === 'space.inspect' && 'requestId' in request.target)) {
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
    let result: AgentMuxControlResult | undefined = request.operation === 'settings.resource.list' || request.operation === 'settings.resource.get'
      ? await this.ports.settingsResources?.(request) : undefined
    if (!result && executionContext && (request.operation === 'agent.open' || request.operation === 'space.inspect')) result = await this.ports.spatialAgentControl?.(request, executionContext)
    if (!result && request.operation.startsWith('demand.')) result = await this.ports.goalControl?.(request, context, executionContext)
    if (!result) {
      if (!this.ports.execute) throw new AgentMuxError('The original business owner is unavailable. Original objects, input and healthy Agents remain available.', 'CONTROL_UNAVAILABLE')
      result = await this.ports.execute(request, context, executionContext)
    }
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
      requestId: mintObjectId(), operation, ...body })
  }
  async call<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>,
    context: AgentMuxRpcCallContext = {}): Promise<AgentMuxRpcResult<M>> {
    if (method === 'app.mobile.report') {
      const input = parseMobileWebReportParams(params)
      const caller = await this.authenticated(context)
      if (caller || context.principal?.kind !== 'device' || !context.principal.id || !context.assertCurrent) throw new AgentMuxError('Mobile reports require the original authenticated device.', 'CONTROL_PERMISSION_DENIED')
      context.signal?.throwIfAborted(); await context.assertCurrent(); await this.assertRuntimeFence(context)
      if (this.ports.callOriginalCore) return await this.ports.callOriginalCore('local', 'app.mobile.report', input, context) as AgentMuxRpcResult<M>
      const result = this.ports.mobileWebReports?.report(input, context.principal.id)
      if (!result) throw new AgentMuxError('The original Host diagnostic archive is unavailable. The phone and its business operations remain available.', 'CONTROL_UNAVAILABLE')
      if (result.producer.devicePrincipalId !== context.principal.id) throw new AgentMuxError('The mobile report receipt has another original producer.', 'CONTROL_PROTOCOL_ERROR')
      return parseMobileWebReportReceipt(result, input) as AgentMuxRpcResult<M>
    }
    if (isMobileAssetsMethod(method)) {
      const input = parseMobileAssetsParams(method, params)
      const caller = await this.authenticated(context)
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      if (method === 'app.mobile.assets.loaded') {
        if (caller || context.principal?.kind !== 'device' || !context.principal.id || !context.assertCurrent) throw new AgentMuxError('A loaded page report requires its original authenticated device.', 'CONTROL_PERMISSION_DENIED')
        if (!this.ports.mobileAssets) throw new AgentMuxError('This service does not own the original mobile assets.', 'CONTROL_UNAVAILABLE')
        const typed = input as import('./mobile-web.js').MobileAssetsLoadedParams
        const result = this.ports.mobileAssets.loaded(typed, context.principal.id)
        if (result.producer.devicePrincipalId !== context.principal.id) throw new AgentMuxError('Loaded observation has another device producer.', 'CONTROL_PROTOCOL_ERROR')
        return parseMobileAssetsResult(method, result, typed) as AgentMuxRpcResult<M>
      }
      const target = input as import('./mobile-web.js').MobileAssetsInspectParams | import('./mobile-web.js').MobileAssetsActivateParams
      if (caller && target.hostId !== caller.hostId) throw new AgentMuxError('Mobile asset operations stay on the authenticated Agent Host.', 'CONTROL_PERMISSION_DENIED')
      if (method === 'app.mobile.assets.activate') {
        const author = this.requireCaller(caller)
        const scope = { hostId: author.hostId, agentSessionId: author.agentSessionId, runId: author.session.run.runId, workspacePath: author.session.workspacePath }
        const current = async () => {
          context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
          const next = this.requireCaller(await this.authenticated(context))
          if (next.hostId !== scope.hostId || next.agentSessionId !== scope.agentSessionId || next.session.run.runId !== scope.runId || next.session.workspacePath !== scope.workspacePath) throw new AgentMuxError('The original activation author or execution Workspace changed.', 'AGENT_CAPABILITY_STALE_RUN')
        }
        await current()
        const typed = input as import('./mobile-web.js').MobileAssetsActivateParams
        if (this.ports.mobileAssets) return parseMobileAssetsResult(method, await this.ports.mobileAssets.activate(typed, { ...scope, assertCurrent: current }), typed) as AgentMuxRpcResult<M>
        // Main borrows exactly its configured original Host. A Host without this port
        // must never fall through forwardControl and return the request to Main.
        if (this.ports.callOriginalCore) return parseMobileAssetsResult(method, await this.ports.callOriginalCore(target.hostId, 'app.mobile.assets.activate', typed, context), typed) as AgentMuxRpcResult<M>
        throw new AgentMuxError('The original Host mobile asset owner is unavailable.', 'CONTROL_UNAVAILABLE')
      }
      if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind))) throw new AgentMuxError('Mobile asset observation requires an authenticated original actor.', 'CONTROL_PERMISSION_DENIED')
      const typed = input as import('./mobile-web.js').MobileAssetsInspectParams
      if (context.principal?.kind === 'device' && typed.client && typed.client.devicePrincipalId !== context.principal.id) throw new AgentMuxError('This device can inspect only its own page observation.', 'CONTROL_PERMISSION_DENIED')
      let result: import('./mobile-web.js').MobileAssetsInspection
      if (this.ports.mobileAssets) result = this.ports.mobileAssets.inspect(typed)
      else if (this.ports.callOriginalCore) result = await this.ports.callOriginalCore(target.hostId, 'app.mobile.assets.inspect', typed, context)
      else throw new AgentMuxError('The original Host mobile asset owner is unavailable.', 'CONTROL_UNAVAILABLE')
      if (context.principal?.kind === 'device') result = { ...result, clients: result.clients.filter(item => item.producer.devicePrincipalId === context.principal!.id) }
      return parseMobileAssetsResult(method, result, typed) as AgentMuxRpcResult<M>
    }
    if (isNativeDesktopMethod(method)) {
      const caller = await this.authenticated(context)
      if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id.trim()))
        throw new AgentMuxError('Native desktop operations require an authenticated original actor.', 'CONTROL_PERMISSION_DENIED')
      const nativeMethod: NativeDesktopMethod = method
      const input = parseNativeDesktopParams<NativeDesktopMethod>(nativeMethod, params)
      if (caller && caller.hostId !== input.hostId) throw new AgentMuxError('Native desktop operations require the authenticated Agent’s exact Host.', 'CONTROL_PERMISSION_DENIED')
      const ownerContext: AgentMuxRpcCallContext = { ...context, assertCurrent: async () => {
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        if (caller) await this.authenticated(context)
      } }
      await ownerContext.assertCurrent!()
      if (!this.ports.nativeDesktop && !this.ports.forwardControl)
        throw new AgentMuxError('This Host has no native desktop implementation. Existing Agents and page capture remain available.', 'CONTROL_UNAVAILABLE')
      const result = this.ports.nativeDesktop ? await this.ports.nativeDesktop.call<NativeDesktopMethod>(nativeMethod, input, ownerContext)
        : await this.ports.forwardControl!<NativeDesktopMethod>(nativeMethod, input, ownerContext)
      return parseNativeDesktopResult<NativeDesktopMethod>(nativeMethod, result, input) as AgentMuxRpcResult<M>
    }
    if (isAgentLearningMethod(method)) {
      const caller = await this.authenticated(context)
      if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id.trim()))
        throw new AgentMuxError('Learning requires its original authenticated actor. Existing Agents remain available.', 'CONTROL_PERMISSION_DENIED')
      const input = parseAgentLearningParams(method, params)
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      const ownerContext: AgentMuxRpcCallContext = { ...context, assertCurrent: async () => {
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        if (caller) await this.authenticated(context)
      } }
      if (!this.ports.agentLearning && !this.ports.forwardControl)
        throw new AgentMuxError('The original Host learning owner is unavailable. Keep the source and operation; existing Agents remain available.', 'CONTROL_UNAVAILABLE')
      const result = this.ports.agentLearning ? await this.ports.agentLearning.call(method, input, ownerContext)
        : await this.ports.forwardControl!<AgentLearningMethod>(method, input, ownerContext)
      return parseAgentLearningResult(method, result, input) as AgentMuxRpcResult<M>
    }
    if (isMoteChatMethod(method)) {
      const caller = await this.authenticated(context)
      if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind))) throw new AgentMuxError('Mote chat requires its original authenticated actor.', 'CONTROL_PERMISSION_DENIED')
      if (caller && method !== 'space.mote.chat.history' && method !== 'space.mote.chat.diagnose') throw new AgentMuxError('Managed Agents may read redacted diagnosis or their own chat history; chat settings and audience administration require the original person or device.', 'CONTROL_PERMISSION_DENIED')
      const input = parseMoteChatParams(method, params), owner = this.ports.moteChat
      if (method === 'space.mote.chat.diagnose') await this.assertRuntimeFence(context)
      if (!owner) {
        if (this.ports.forwardControl) {
          context.signal?.throwIfAborted(); await context.assertCurrent?.()
          return parseMoteChatResult(method as MoteChatMethod, await this.ports.forwardControl<MoteChatMethod>(method, input as MoteChatParamsMap[MoteChatMethod], context), input as MoteChatParamsMap[MoteChatMethod]) as unknown as AgentMuxRpcResult<M>
        }
        throw new AgentMuxError('The original Mote chat owner is unavailable. Existing conversations are retained.', 'CONTROL_UNAVAILABLE')
      }
      const actor = caller ? { kind: 'agent' as const, id: caller.agentSessionId } : { kind: context.principal!.kind as 'user' | 'device', id: context.principal!.id }
      const administration = { actor, ...(context.signal ? { signal: context.signal } : {}), assertCurrent: async () => { context.signal?.throwIfAborted(); await context.assertCurrent?.(); if (method === 'space.mote.chat.diagnose') await this.assertRuntimeFence(context); if (caller) await this.authenticated(context) } }
      await administration.assertCurrent()
      const result = method === 'space.mote.chat.configure' ? await owner.configure(parseMoteChatParams(method, params), administration)
        : method === 'space.mote.chat.inspect' ? await owner.inspect(parseMoteChatParams(method, params), administration)
        : method === 'space.mote.chat.history' ? await owner.history(parseMoteChatParams(method, params), administration)
        : method === 'space.mote.chat.audience' ? await owner.audience(parseMoteChatParams(method, params), administration)
        : method === 'space.mote.chat.diagnose' ? await owner.diagnose(parseMoteChatParams(method, params), administration)
        : await owner.allocate(parseMoteChatParams('space.mote.chat.allocate', params), administration)
      await administration.assertCurrent()
      return parseMoteChatResult(method as MoteChatMethod, result, input as MoteChatParamsMap[MoteChatMethod]) as unknown as AgentMuxRpcResult<M>
    }
    if (isMoteConnectionMethod(method)) {
      const caller = await this.authenticated(context)
      if (!caller && (!context.principal || !['user','device'].includes(context.principal.kind))) throw new AgentMuxError('Mote bot operations require an authenticated original actor.', 'CONTROL_PERMISSION_DENIED')
      const input = parseMoteConnectionParams(method, params), owner = this.ports.moteConnections
      await this.assertRuntimeFence(context)
      if (!owner) {
        if (this.ports.forwardControl) {
          context.signal?.throwIfAborted(); await context.assertCurrent?.()
          return parseMoteConnectionResult(method, await this.ports.forwardControl<MoteConnectionMethod>(method, input, context), input) as unknown as AgentMuxRpcResult<M>
        }
        throw new AgentMuxError('Mote bot operations are unavailable on this Host. Original files and Agents remain available.', 'CONTROL_UNAVAILABLE')
      }
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      const actor = caller ? { kind: 'agent' as const, id: caller.agentSessionId } : { kind: context.principal!.kind as 'user'|'device', id: context.principal!.id }
      const administration = { actor, ...(context.signal ? { signal: context.signal } : {}), assertCurrent: async () => { context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context); if (caller) await this.authenticated(context) } }
      if (caller) {
        const original = method === 'space.mote.connection.advance' || method === 'space.mote.connection.inspect' ? (await owner.inspect({ operationId: (input as { operationId: string }).operationId }, administration)).operation : undefined
        const target = 'source' in input ? input.source.target : 'target' in input ? input.target : original?.source.target
        if (target) {
          const graph = target.expectedResource.workspacePath === caller.session.workspacePath ? null : (await this.spatial.read())?.graph
          const zone = graph?.zones.find(zone => zone.zoneId === target.zoneId)
          const exactExecutionDirectory = zone?.hostId === caller.hostId && zone.directoryPath === caller.session.workspacePath &&
            zone.workspaceId === target.expectedResource.workspaceId && graph?.bindings.some(binding => binding.spaceId === target.spaceId && binding.zoneId === zone.zoneId)
          if (target.expectedResource.hostId !== caller.hostId || target.expectedResource.workspacePath !== caller.session.workspacePath && !exactExecutionDirectory) throw new AgentMuxError('Mote bot operations stay within the authenticated Agent Workspace or its exact durable Mote execution directory on the original Host.', 'CONTROL_PERMISSION_DENIED')
        }
        if (method === 'space.mote.connection.sync') {
          const sync = input as import('./mote-connection-contract.js').MoteConnectionSync
          if (!await this.ports.connections?.ownsEnrollmentConnection?.(sync.connection.connectionId, caller.agentSessionId)) throw new AgentMuxError('This bot was not enrolled by the original Agent.', 'CONTROL_PERMISSION_DENIED')
        }
      }
      const result = method === 'space.mote.connection.create' ? await owner.create(parseMoteConnectionParams(method, params), administration)
        : method === 'space.mote.connection.sync' ? await owner.sync(parseMoteConnectionParams(method, params), administration)
        : method === 'space.mote.connection.advance' ? await owner.advance(parseMoteConnectionParams(method, params), administration)
        : method === 'space.mote.connection.ls' ? await owner.list(parseMoteConnectionParams(method, params), administration) : await owner.inspect(parseMoteConnectionParams(method, params), administration)
      return parseMoteConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
    }
    if (isConnectionMethod(method)) {
      const caller = await this.authenticated(context)
      if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind))) throw new AgentMuxError('Connection administration requires an authenticated original actor.', 'CONTROL_PERMISSION_DENIED')
      const input = parseConnectionParams(method, params)
      await this.assertRuntimeFence(context)
      if (method === 'connection.owner.inspect') {
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        return parseConnectionResult(method, { ownership: this.ports.connections ? 'local' : this.ports.forwardControl ? 'forwarded' : 'unavailable' }, input) as unknown as AgentMuxRpcResult<M>
      }
      if (isConnectionCredentialMethod(method)) {
        if (caller || !context.runtimeFence) throw new AgentMuxError('Credential administration requires the original person/device and exact Runtime owner.', 'CONTROL_PERMISSION_DENIED')
        if (method === 'connection.credential.store' && context.transport !== 'unix' && context.transport !== 'relay') throw new AgentMuxError('Credential entry requires the original protected Unix, SSH-to-Unix or end-to-end relay transport.', 'CONTROL_PERMISSION_DENIED')
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        const credential = this.ports.connections?.credential
        if (!credential) throw new AgentMuxError('The original Host credential owner is unavailable. Original references and healthy Agents are retained.', 'CONTROL_UNAVAILABLE')
        const result = method === 'connection.credential.store'
          ? await credential.store(input as import('./connection-credential-contract.js').ConnectionCredentialStoreInput, context)
          : await credential.inspect(input as { operationId: string }, context)
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (!this.ports.connections) {
        if (this.ports.forwardControl) {
          context.signal?.throwIfAborted(); await context.assertCurrent?.()
          return parseConnectionResult(method, await this.ports.forwardControl<ConnectionMethod>(method, input, context), input) as unknown as AgentMuxRpcResult<M>
        }
        throw new AgentMuxError('The connection owner is not enabled on this Host. Existing Agent capabilities remain available.', 'CONTROL_UNAVAILABLE')
      }
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      const owner = this.ports.connections
      // Deliberate safe-read contract for authenticated managed callers. Keep their original context;
      // the projection cannot configure, grant, read private setup data or return conversation bodies.
      if (method === 'connection.diagnose') {
        const result = await readConnectionDiagnosis(owner, input as import('./connection-diagnosis-contract.js').ConnectionDiagnosisInput)
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        if (caller) await this.authenticated(context)
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      const administration = { actor: caller ? { kind: 'agent' as const, id: caller.agentSessionId } : { kind: context.principal!.kind as 'user' | 'device', id: context.principal!.id }, assertCurrent: async () => { context.signal?.throwIfAborted(); await context.assertCurrent?.(); if (caller) await this.authenticated(context) } }
      if (isConnectionApiMethod(method)) {
        const api = owner.api
        if (!api) throw new AgentMuxError('The original Host native API owner is unavailable. Existing Agent capabilities remain available.', 'CONTROL_UNAVAILABLE')
        const original = { ...administration, ...(caller ? { session: { hostId: caller.session.hostId, agentSessionId: caller.session.agentSessionId } } : {}),
          assertCurrent: async () => { await administration.assertCurrent(); await this.assertRuntimeFence(context) } }
        if (method === 'connection.api.identities' && caller && (input as { agentSessionId: string }).agentSessionId !== caller.session.agentSessionId) {
          throw new AgentMuxError('Native API identities require this authenticated original Session.', 'CONTROL_PERMISSION_DENIED')
        }
        await original.assertCurrent()
        const result = method === 'connection.api.identities' ? await api.identities(parseConnectionApiParams(method, input), original)
          : method === 'connection.api.request' ? await api.request(parseConnectionApiParams(method, input), original)
          : await api.inspect(parseConnectionApiParams(method, input), original)
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (caller && (method === 'connection.delivery.ls' || method === 'connection.delivery.inspect')) {
        const result = await readAgentConnectionDelivery(owner, method, parseConnectionDeliveryParams(method, input), { hostId: caller.hostId, agentSessionId: caller.agentSessionId })
        await administration.assertCurrent(); await this.assertRuntimeFence(context)
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (caller) await assertAgentConnectionAccess(owner, method, input, caller.agentSessionId)
      if (isConnectionDeletionMethod(method)) {
        if (caller) throw new AgentMuxError('Deleting saved identities requires the original person or device.', 'CONTROL_PERMISSION_DENIED')
        const result = method === 'connection.delete'
          ? owner.delete ? await owner.delete(parseConnectionDeletionParams(method, params), administration) : undefined
          : owner.inspectDeletion ? await owner.inspectDeletion(parseConnectionDeletionParams(method, params)) : undefined
        if (!result) throw new AgentMuxError('Local identity removal is unavailable on the original Host. The identity and its conversations are retained.', 'CONTROL_UNAVAILABLE')
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (isConnectionApplicationAccessMethod(method)) {
        if (caller) throw new AgentMuxError('Application access requires the original person or device.', 'CONTROL_PERMISSION_DENIED')
        const access = owner.applicationAccess
        if (!access) throw new AgentMuxError('Application access is unavailable on the original Host. Existing Agents remain available.', 'CONTROL_UNAVAILABLE')
        const original = { ...administration, assertCurrent: async () => { await administration.assertCurrent(); await this.assertRuntimeFence(context) } }
        const result = method === 'connection.application.access.get' ? await access.get(parseConnectionApplicationAccessParams(method, params))
          : method === 'connection.application.access.configure' ? await access.configure(parseConnectionApplicationAccessParams(method, params), original)
          : await access.inspect(parseConnectionApplicationAccessParams(method, params))
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (isConnectionServiceMethod(method)) {
        const service = owner.service
        if (!service) throw new AgentMuxError('Connector service policy is unavailable on this Host. Existing connection management and Agents remain available.', 'CONTROL_UNAVAILABLE')
        const result = method === 'connection.service.get' ? await service.get(parseConnectionServiceParams(method, params))
          : method === 'connection.service.configure' ? await service.configure(parseConnectionServiceParams(method, params))
          : await service.inspect(parseConnectionServiceParams(method, params))
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (isConnectionSetupMethod(method)) {
        const setup = owner.setup
        if (!setup) throw new AgentMuxError('Platform management confirmation is unavailable on this Host. Existing connections and Agents remain available.', 'CONTROL_UNAVAILABLE')
        const callContext = { ...administration, ...(context.signal ? { signal: context.signal } : {}) }
        const result = method === 'connection.setup.begin' ? await setup.begin(parseConnectionSetupParams(method, params), callContext)
          : method === 'connection.setup.advance' ? await setup.advance(parseConnectionSetupParams(method, params), callContext)
          : method === 'connection.setup.ls' ? await setup.list(parseConnectionSetupParams(method, params), administration)
          : await setup.inspect(parseConnectionSetupParams(method, params), callContext)
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (isChannelMetadataMethod(method)) {
        const metadata = owner.metadata
        if (!metadata) throw new AgentMuxError('Channel metadata management is unavailable on this Host. Existing input remains available.', 'CONTROL_UNAVAILABLE')
        if (method === 'connection.metadata.watch') return {} as AgentMuxRpcResult<M>
        const callContext = { ...administration, ...(context.signal ? { signal: context.signal } : {}) }
        const result = method === 'connection.metadata.get' ? await metadata.get(parseChannelMetadataParams(method, params), callContext)
          : method === 'connection.metadata.ls' ? await metadata.list(parseChannelMetadataParams(method, params), callContext)
          : method === 'connection.metadata.refresh' ? await metadata.refresh(parseChannelMetadataParams(method, params), callContext)
          : await metadata.clear(parseChannelMetadataParams(method, params), callContext)
        await administration.assertCurrent()
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (isConnectionProfileMethod(method)) {
        const profile = owner.profile
        if (!profile) throw new AgentMuxError('Profile operations are unavailable on this Host. Existing connections remain available.', 'CONTROL_UNAVAILABLE')
        const callContext = { ...administration, ...(context.signal ? { signal: context.signal } : {}) }
        const result = method === 'connection.profile.get' ? await profile.get(parseConnectionProfileParams(method, params), callContext)
          : method === 'connection.profile.ls' ? await profile.list(parseConnectionProfileParams(method, params), callContext)
          : await profile.inspect(parseConnectionProfileParams(method, params), callContext)
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (isConnectionEnrollmentMethod(method)) {
        const enrollment = owner.enrollment
        if (!enrollment) throw new AgentMuxError('Application enrollment is unavailable on this Host. Existing Agents and connections remain available.', 'CONTROL_UNAVAILABLE')
        const result = method === 'connection.enrollment.begin' ? await enrollment.begin(parseConnectionEnrollmentParams(method, params), { ...administration, ...(context.signal ? { signal: context.signal } : {}) })
          : method === 'connection.enrollment.advance' ? await enrollment.advance(parseConnectionEnrollmentParams(method, params), { ...administration, ...(context.signal ? { signal: context.signal } : {}) })
          : method === 'connection.enrollment.ls' ? await enrollment.list(parseConnectionEnrollmentParams(method, params), administration)
          : await enrollment.inspect(parseConnectionEnrollmentParams(method, params), { ...administration, ...(context.signal ? { signal: context.signal } : {}) })
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (isRoomDiscoveryMethod(method)) {
        const rooms = owner.rooms
        const handler = method === 'connection.room.ls' ? rooms?.list : method === 'connection.room.search' ? rooms?.search : method === 'connection.room.get' ? rooms?.get
          : method === 'connection.room.members' ? rooms?.members : method === 'connection.room.link.create' ? rooms?.createLink : rooms?.inspectLink
        if (!handler) throw new AgentMuxError('This room capability is unavailable on the original Host. Existing Agents and connections remain available.', 'CONTROL_UNAVAILABLE')
        const result = method === 'connection.room.ls' ? await rooms!.list!(parseRoomDiscoveryParams(method, params))
          : method === 'connection.room.search' ? await rooms!.search!(parseRoomDiscoveryParams(method, params))
          : method === 'connection.room.get' ? await rooms!.get!(parseRoomDiscoveryParams(method, params))
          : method === 'connection.room.members' ? await rooms!.members!(parseRoomDiscoveryParams(method, params))
          : method === 'connection.room.link.create' ? await rooms!.createLink!(parseRoomDiscoveryParams(method, params), { ...administration, ...(context.signal ? { signal: context.signal } : {}) })
          : await rooms!.inspectLink!(parseRoomDiscoveryParams(method, params))
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (isRoomProvisioningMethod(method)) {
        const rooms = owner.rooms
        if (method === 'connection.room.create' ? !rooms?.create : !rooms?.inspect) throw new AgentMuxError('Room creation is not enabled on this Host. Existing Agents and connections remain available.', 'CONTROL_UNAVAILABLE')
        const result = method === 'connection.room.create' ? await rooms!.create!(parseRoomProvisioningParams(method, params), { ...administration, ...(context.signal ? { signal: context.signal } : {}) })
          : await rooms!.inspect!(parseRoomProvisioningParams(method, params))
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (isConnectionDeliveryMethod(method)) {
        const delivery = owner.delivery
        if (!delivery) throw new AgentMuxError('Delivery inspection is not enabled on this Host. Existing Agents and connections remain available.', 'CONTROL_UNAVAILABLE')
        const result = method === 'connection.delivery.inspect' ? await delivery.inspect(parseConnectionDeliveryParams(method, params))
          : method === 'connection.delivery.ls' ? await delivery.list(parseConnectionDeliveryParams(method, params))
          : await delivery.retry(parseConnectionDeliveryParams(method, params), administration)
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (method === 'connection.ingress.inspect' || method === 'connection.ingress.ls' || method === 'connection.ingress.authority' || method === 'connection.ingress.record-authority') {
        if (!owner.ingress) throw new AgentMuxError('Ingress observation is unavailable on this Host. Existing Agents and inputs remain available.', 'CONTROL_UNAVAILABLE')
        const result = method === 'connection.ingress.record-authority' ? await owner.ingress.recordAuthority(parseConnectionParams(method, params))
          : method === 'connection.ingress.inspect' ? await owner.ingress.inspect(parseConnectionParams(method, params))
          : method === 'connection.ingress.authority' ? await owner.ingress.authority(parseConnectionParams(method, params))
          : await owner.ingress.list(parseConnectionParams(method, params))
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (isRoomBindingMethod(method)) {
        const bindings = owner.bindings
        if (!bindings) throw new AgentMuxError('Room bindings are not enabled on this Host. Existing Agents and connections remain available.', 'CONTROL_UNAVAILABLE')
        const result = method === 'connection.bind' ? await bindings.bind(parseRoomBindingParams(method, params), administration)
          : method === 'connection.binding.inspect' ? await bindings.inspect(parseRoomBindingParams(method, params))
          : method === 'connection.binding.ls' ? await bindings.list(parseRoomBindingParams(method, params))
          : method === 'connection.binding.pause' ? await bindings.pause(parseRoomBindingParams(method, params), administration)
          : method === 'connection.binding.resume' ? await bindings.resume(parseRoomBindingParams(method, params), administration)
          : method === 'connection.binding.detach' ? await bindings.detach(parseRoomBindingParams(method, params), administration)
          : method === 'connection.binding.relink' ? await bindings.relink(parseRoomBindingParams(method, params), administration)
          : method === 'connection.binding.member.inherit' ? await bindings.inherit(parseRoomBindingParams(method, params), { ...administration, assertCurrent: async () => { await administration.assertCurrent(); await this.assertRuntimeFence(context) } })
          : await bindings.grant(parseRoomBindingParams(method, params), administration)
        // Application-wide member identities are administration data, not managed discovery.
        if (caller && method === 'connection.binding.inspect') delete (result as import('./room-binding-contract.js').RoomBindingInspection).access
        if (caller && method === 'connection.binding.ls') {
          const page = result as import('./room-binding-contract.js').RoomBindingResultMap['connection.binding.ls']
          const owned = await Promise.all(page.bindings.map(async binding => binding.authorizedBy.kind === 'agent' && binding.authorizedBy.id === caller.agentSessionId &&
            await owner.ownsEnrollmentConnection?.(binding.connectionId, caller.agentSessionId) ? binding : null))
          page.bindings = owned.filter((binding): binding is NonNullable<typeof binding> => binding !== null)
        }
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      const result = method === 'connection.ls' ? await owner.list()
        : method === 'connection.inspect' ? await owner.inspect(parseConnectionParams('connection.inspect', params))
        : method === 'connection.configure' ? await owner.configure(parseConnectionParams('connection.configure', params))
        : await owner.test(parseConnectionParams('connection.test', params))
      if (caller && method === 'connection.ls') {
        const page = result as import('./connections-contract.js').ConnectionResultMap['connection.ls']
        const owned = await Promise.all(page.connections.map(async connection => await owner.ownsEnrollmentConnection?.(connection.config.connectionId, caller.agentSessionId) ? connection : null))
        page.connections = owned.filter((connection): connection is NonNullable<typeof connection> => connection !== null)
      }
      return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
    }
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
    if (isApplicationAccessMethod(method)) {
      const input = parseApplicationAccessParams(method,params)
      // This domain executes private configured application connectors. An Agent cannot self-approve.
      const writes = ['settings.applications.configure','settings.applications.delete','settings.applications.apply'].includes(method)
      if (writes && (context.caller !== undefined || context.principal?.kind !== 'user' || !context.principal.id)) throw new AgentMuxError('Application access changes require a transport-approved user without a managed Agent caller.', 'CONTROL_PERMISSION_DENIED')
      if (!context.caller && (!context.principal || !['user','device'].includes(context.principal.kind) || !context.principal.id)) throw new AgentMuxError('Application access observation requires an authenticated original transport.', 'CONTROL_PERMISSION_DENIED')
      await this.authenticated(context)
      context.signal?.throwIfAborted()
      if (!this.ports.applicationAccess) {
        if (this.ports.forwardControl) return parseApplicationAccessResult(method,await this.ports.forwardControl<ApplicationAccessMethod>(method,input,context),input) as AgentMuxRpcResult<M>
        throw new AgentMuxError('The original application access owner is unavailable. Existing applications and Agents are retained.', 'CONTROL_UNAVAILABLE')
      }
      return parseApplicationAccessResult(method,await this.ports.applicationAccess.call(method,input,context.signal),input) as AgentMuxRpcResult<M>
    }
    if (method === 'system.metrics.host-profile.capture') {
      const input = parseRuntimeV8ProfileInput(params, true) as HostV8ProfileInput
      if (!context.caller && (!context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id)) throw new AgentMuxError(
        'Host profiling requires an authenticated original transport.', 'CONTROL_PERMISSION_DENIED')
      if (!this.ports.coreClients && !this.local) throw new AgentMuxError(
        'No existing Host Runtime client is available to profile. No Runtime was started.', 'CONTROL_UNAVAILABLE')
      await this.authenticated(context, true)
      context.signal?.throwIfAborted()
      const targets = (await this.clients()).filter(entry => entry.hostId === input.hostId)
      if (!targets.length && this.ports.forwardControl) return parseRuntimeV8ProfileResult(
        await this.ports.forwardControl('system.metrics.host-profile.capture', input, context), input) as AgentMuxRpcResult<M>
      if (targets.length !== 1) throw new AgentMuxError('The exact route Host is unknown or ambiguous.', targets.length ? 'AMBIGUOUS_AGENT_SESSION' : 'UNKNOWN_HOST')
      const client = targets[0]!.client
      const { hostId: _hostId, ...capture } = input
      const originalContext = { ...(context.signal ? { signal: context.signal } : {}), runtimeFence: input.fence }
      // This authenticated aggregate borrows only a fixed diagnostic operation.
      // The original producer fences its process; no Native connect or Session bootstrap.
      let result: unknown
      if (client.forwardRpc) result = await client.forwardRpc('runtime.profile.capture', capture, originalContext)
      else {
        const owner = await this.ports.hostedRuntime?.()
        if (owner?.client !== client) throw new AgentMuxError('The original profile owner is unavailable. No other Runtime was sampled.', 'RUNTIME_OWNER_UNCONFIRMED')
        result = await owner.call('runtime.profile.capture', capture, originalContext)
      }
      // A later routing change does not erase an already acquired original capture.
      return parseRuntimeV8ProfileResult(result, input) as AgentMuxRpcResult<M>
    }
    if (isHostSettingsMethod(method)) {
      const input = parseHostSettingsParams(method, params)
      if ((method === 'settings.hosts.inspect' || method === 'settings.hosts.network') && !this.ports.coreClients && !this.local) throw new AgentMuxError(
        'No existing Host Runtime client is available to observe. This read did not start a Runtime.', 'CONTROL_UNAVAILABLE')
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
      if (method === 'settings.hosts.inspect' || method === 'settings.hosts.network') {
        const query = parseHostSettingsParams(method, params)
        const configuration = structuredClone(this.ports.hostConfiguration?.(input.hostId) ?? null)
        if (query.expected !== undefined && !isDeepStrictEqual(query.expected, configuration)) throw new AgentMuxError(
          'The original Host configuration changed or could not be confirmed. Reload this connection before observing it.', 'HOST_CONFIGURATION_CHANGED')
        const readOwner = async () => {
          if (client.runtimeOwnerIdentity) return client.runtimeOwnerIdentity()
          const owner = await this.ports.hostedRuntime?.()
          return owner?.client === client ? (await owner.call('runtime.owner.identity', {})).owner : null
        }
        if (method === 'settings.hosts.network' && configuration === null) throw new AgentMuxError('The saved Host configuration is unavailable. No network probe was sent.', 'HOST_CONFIGURATION_CHANGED')
        const result = method === 'settings.hosts.inspect'
          ? await observeHostRuntime(input.hostId, client, readOwner, context.signal, configuration)
          : await observeHostNetwork(input.hostId, configuration!, readOwner, async (fence, signal) => {
            // The aggregate authenticated its caller above. Only this fixed read
            // borrows the Host transport; source Agent credentials are not a target identity.
            const originalContext = { signal, runtimeFence: fence }
            if (client.forwardRpc) return await client.forwardRpc('runtime.network.inspect', { fence }, originalContext)
            const owner = await this.ports.hostedRuntime?.()
            if (owner?.client !== client) throw new AgentMuxError('The original network owner is unavailable. No other Runtime was queried.', 'RUNTIME_OWNER_UNCONFIRMED')
            return await owner.call('runtime.network.inspect', { fence }, originalContext)
          }, context.signal)
        const current = (await this.clients()).filter(entry => entry.hostId === input.hostId)
        if (current.length !== 1 || current[0]!.client !== client || !isDeepStrictEqual(configuration, this.ports.hostConfiguration?.(input.hostId) ?? null)) throw new AgentMuxError(
          'The original Host route changed during this observation. Read the current saved connection again.', 'HOST_CONFIGURATION_CHANGED')
        return parseHostSettingsResult(method, result, input) as AgentMuxRpcResult<M>
      }
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
    if (method === 'agent.restart' || method === 'agent.restart.inspect') {
      if (context.caller !== undefined || !context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id) {
        throw new AgentMuxError('Restarting a conversation requires a transport-approved user or device.', 'CONTROL_PERMISSION_DENIED')
      }
      const input = parseAgentRestartInput(params, true)
      const selected = await this.owner(input.agentSessionId)
      if (selected.agentSessionId !== input.agentSessionId) throw new AgentMuxError('Restart requires the complete original Session ID.', 'INVALID_AGENT_RESTART')
      context.signal?.throwIfAborted()
      await context.assertCurrent?.()
      if (selected.client.forwardRpc) return await selected.client.forwardRpc(method, input as AgentMuxRpcParams<typeof method>, context) as AgentMuxRpcResult<M>
      const result = method === 'agent.restart' ? { session: await selected.client.restartAgent(input) }
        : await selected.client.inspectAgentRestart(input)
      return parseRpcNativeResult(method, result, input) as AgentMuxRpcResult<M>
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
        method === 'message.pending.archive' || method === 'message.pending.restore' || method === 'agent.question.reply' || method === 'agent.interaction.respond') {
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
    if (isCapsuleRuntimeMethod(method)) {
      const input = parseCapsuleRuntimeParams(method, params)
      if (!caller && !(context.principal && ['user', 'device'].includes(context.principal.kind) && context.principal.id.trim()))
        throw new AgentMuxError('Capsule service management requires an authenticated Agent, user or device.', 'CONTROL_PERMISSION_DENIED')
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      if (!this.ports.capsuleRuntime) {
        if (this.ports.forwardControl) return await this.ports.forwardControl(method, input as AgentMuxRpcParams<M>, context) as AgentMuxRpcResult<M>
        throw new AgentMuxError('The execution Host service manager is unavailable. Its Run and content are retained.', 'CONTROL_UNAVAILABLE')
      }
      return parseCapsuleRuntimeResult(await this.ports.capsuleRuntime.call(method, input)) as AgentMuxRpcResult<M>
    }
    if (method === 'capsule.input') {
      if (caller || context.transport !== 'unix' || context.principal?.kind !== 'user')
        throw new AgentMuxError('Capsule input requires its original trusted App confirmation. Transport credentials do not certify a human action.', 'CONTROL_PERMISSION_DENIED')
      const input = parseCapsuleInputRequest(params)
      if (!this.ports.capsuleInput) throw new AgentMuxError('The original Capsule input authority is unavailable. Retain the original answer and operation.', 'CONTROL_UNAVAILABLE')
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      return parseCapsuleInputResult(await this.ports.capsuleInput.call(input), input) as AgentMuxRpcResult<M>
    }
    if (isCapsuleMethod(method)) {
      const capsuleMethod: CapsuleMethod = method
      const input = parseCapsuleRpcParams(capsuleMethod, params)
      const principal = context.principal && ['user', 'device'].includes(context.principal.kind) && context.principal.id.trim()
        ? context.principal as CapsuleCallContext['principal'] : undefined
      if (!caller && !principal) throw new AgentMuxError('Capsule operations require an authenticated Agent, user or device. Original pages and Agents remain available.', 'CONTROL_PERMISSION_DENIED')
      if (method === 'capsule.interaction.reply' && (caller || !principal)) throw new AgentMuxError('A page or managed Agent cannot certify a human answer. Submit the original answer through trusted App chrome; the request and Agent remain available.', 'CONTROL_PERMISSION_DENIED')
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      if (!this.ports.capsules && !this.ports.forwardControl) throw new AgentMuxError('The original Capsule owner is unavailable. Retain the original page and operation; existing Agents remain available.', 'CONTROL_UNAVAILABLE')
      const capsuleContext: CapsuleCallContext = {
        ...(caller ? { caller: { hostId: caller.hostId, agentSessionId: caller.agentSessionId } } : {}),
        ...(principal ? { principal } : {}), ...(context.signal ? { signal: context.signal } : {})
      }
      const result = this.ports.capsules ? await this.ports.capsules.call<CapsuleMethod>(capsuleMethod, input, capsuleContext, context)
        : await this.ports.forwardControl!<CapsuleMethod>(capsuleMethod, input, context)
      return parseCapsuleRpcResult<CapsuleMethod>(capsuleMethod, result, input) as AgentMuxRpcResult<M>
    }
    if (isGoalDelegationMethod(method)) {
      const input = parseGoalDelegationParams(method, params)
      if (!this.ports.goalDelegations) {
        if (this.ports.callOriginalCore) return await this.ports.callOriginalCore('local', method, input as AgentMuxRpcParams<M>, context)
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

    if (isAppWindowMethod(method)) {
      const input = parseAppWindowParams(method, params)
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      if (!this.ports.windows && !this.ports.forwardControl) throw new AgentMuxError('The original client window owner is unavailable. Original workfaces and Agents remain available.', 'CONTROL_UNAVAILABLE')
      const actor: AppWindowActor | null = caller ? { kind: 'agent', id: caller.agentSessionId }
        : context.principal && ['user', 'device'].includes(context.principal.kind) ? context.principal as AppWindowActor : null
      if (!actor) throw new AgentMuxError('Window presentation requires its authenticated original actor.', 'CONTROL_PERMISSION_DENIED')
      if (!this.ports.windows) return parseAppWindowPage(method, await this.ports.forwardControl!<AppWindowMethod>(method, input, context), input, actor) as AgentMuxRpcResult<M>
      const result = await this.ports.windows.call(method, input, { actor,
        ...(context.signal ? { signal: context.signal } : {}), ...(context.assertCurrent ? { assertCurrent: context.assertCurrent } : {}) })
      return parseAppWindowPage(method, result, input, actor) as AgentMuxRpcResult<M>
    }
    if (isGitMethod(method)) {
      const input = parseGitParams(method, params)
      context.signal?.throwIfAborted()
      if (!this.ports.git && !this.ports.forwardControl) throw new AgentMuxError('The original Desktop Git owner is unavailable. Original workspaces and Agents remain available.', 'CONTROL_UNAVAILABLE')
      const result = this.ports.git ? await this.ports.git.call<GitMethod>(method, input, context) : await this.ports.forwardControl!<GitMethod>(method, input, context)
      return parseGitResult(method, result, input) as AgentMuxRpcResult<M>
    }
    if (isFileMethod(method)) {
      // Admission belongs to this original Files call. Once admitted, its writer
      // owns the transaction even when the response reader ends.
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); context.signal?.throwIfAborted()
      if (method === 'file.upload' || method === 'file.upload.inspect') {
        const input = method === 'file.upload' ? parseFileUploadParams(params) : parseFileUploadIdentity(params)
        context.signal?.throwIfAborted()
        await this.inputCallContext(context).assertCurrent?.()
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
          context.signal?.throwIfAborted(); await this.inputCallContext(context).assertCurrent?.()
          const remote = await route.client.forwardRpc(method, remoteInput as never)
          const receipt = parseFileUploadResult(remote, remoteInput)
          return parseFileUploadResult({ ...receipt, hostId: input.hostId }, input) as AgentMuxRpcResult<M>
        }
        if (!this.ports.fileUploads && !this.ports.forwardControl) throw new AgentMuxError('The original Host file upload owner is unavailable. Original files and Agents are retained.', 'FILE_UPLOAD_HOST_UNAVAILABLE')
        context.signal?.throwIfAborted(); await this.inputCallContext(context).assertCurrent?.()
        const result = this.ports.fileUploads
          ? (method === 'file.upload' ? await this.ports.fileUploads.upload(input as import('./public-rpc-files.js').FileUploadParams)
            : await this.ports.fileUploads.inspect(input))
          : await this.ports.forwardControl!(method, input as never, context)
        return parseFileUploadResult(result, input) as AgentMuxRpcResult<M>
      }
      if (method === 'file.share.undo') {
        const input = parseFileShareUndoParams(params)
        context.signal?.throwIfAborted()
        if (!this.ports.files?.undoShare && !this.ports.forwardControl) throw new AgentMuxError('The original shared undo owner is unavailable. Ordinary Files remain available.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files?.undoShare ? await this.ports.files.undoShare(input, { actor: caller ? { kind: 'agent', id: caller.agentSessionId } : context.principal }) : await this.ports.forwardControl!('file.share.undo', input, context)
        return boundedFileShareUndoResult(parseFileShareUndoResult(result, input), context.responseId) as AgentMuxRpcResult<M>
      }
      if (method === 'file.share') {
        const input = parseFileShareParams(params)
        context.signal?.throwIfAborted()
        if (!this.ports.files?.share && !this.ports.forwardControl) throw new AgentMuxError('The original shared Markdown owner is unavailable. Original files and drafts remain available.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files?.share ? await this.ports.files.share(input, { actor: caller ? { kind: 'agent', id: caller.agentSessionId } : context.principal }) : await this.ports.forwardControl!('file.share', input, context)
        return boundedFileShareResult(parseFileShareResult(result, input), context.responseId) as AgentMuxRpcResult<M>
      }
      if (method === 'file.share.inspect') {
        const input = parseFileShareInspectParams(params)
        context.signal?.throwIfAborted()
        if (!this.ports.files?.inspectShare && !this.ports.forwardControl) throw new AgentMuxError('The original shared Markdown inspector is unavailable. Original files remain readable.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files?.inspectShare ? await this.ports.files.inspectShare(input, { actor: caller ? { kind: 'agent', id: caller.agentSessionId } : context.principal }) : await this.ports.forwardControl!('file.share.inspect', input, context)
        const parsed = parseFileShareInspectResult(result, input)
        return (parsed.mode === 'request' ? { mode: 'request', result: boundedFileShareResult(parsed.result, context.responseId, true) } : parsed.mode === 'undo' ? { mode: 'undo', result: boundedFileShareUndoResult(parsed.result, context.responseId, true) } : parsed) as AgentMuxRpcResult<M>
      }

      if (method === 'file.import') {
        const input = parseFileImportParams(params)
        context.signal?.throwIfAborted()
        if (!this.ports.files?.import && !this.ports.forwardControl) throw new AgentMuxError('The original Files import owner is unavailable. Original files and Agents remain available.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files?.import ? await this.ports.files.import(input) : await this.ports.forwardControl!('file.import', input, context)
        return parseFileImportResult(result, input) as AgentMuxRpcResult<M>
      }

      if (method === 'file.create') {
        const input = parseFileCreateParams(params)
        context.signal?.throwIfAborted()
        if (!this.ports.files && !this.ports.forwardControl) throw new AgentMuxError('The original Host file owner is unavailable. Original files and Agents are retained.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files ? await this.ports.files.create(input, { actor: caller ? { kind: 'agent', id: caller.agentSessionId } : context.principal }) : await this.ports.forwardControl!('file.create', input, context)
        return boundedFileResult(parseFileCreateResult(result, input), context.responseId, input.path.endsWith(NOTE_FILE_EXTENSION) && readNoteMarkdownHeader(input.content).status === 'valid') as AgentMuxRpcResult<M>
      }

      if (method === 'file.write') {
        const input = parseFileWriteParams(params)
        context.signal?.throwIfAborted()
        if (!this.ports.files && !this.ports.forwardControl) throw new AgentMuxError('The original Host file owner is unavailable. Original files and Agents are retained.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files ? await this.ports.files.write(input, { actor: caller ? { kind: 'agent', id: caller.agentSessionId } : context.principal }) : await this.ports.forwardControl!('file.write', input, context)
        return boundedFileResult(parseFileWriteResult(result, input), context.responseId, input.path.endsWith(NOTE_FILE_EXTENSION) && readNoteMarkdownHeader(input.content).status === 'valid') as AgentMuxRpcResult<M>
      }

      if (method === 'file.restore') {
        const input = parseFileRestoreParams(params)
        context.signal?.throwIfAborted()
        if (!this.ports.files?.restore && !this.ports.forwardControl) throw new AgentMuxError('The original Host restore owner is unavailable. Original files, history and Agents remain available.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files?.restore ? await this.ports.files.restore(input, { actor: caller ? { kind: 'agent', id: caller.agentSessionId } : context.principal }) : await this.ports.forwardControl!('file.restore', input, context)
        return boundedFileResult(parseFileRestoreResult(result, input), context.responseId, true) as AgentMuxRpcResult<M>
      }

      if (method === 'file.undo') {
        const input = parseFileUndoParams(params)
        context.signal?.throwIfAborted()
        if (!this.ports.files?.undo && !this.ports.forwardControl) throw new AgentMuxError('The original Host undo owner is unavailable. Original files, history and Agents remain available.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files?.undo ? await this.ports.files.undo(input, { actor: caller ? { kind: 'agent', id: caller.agentSessionId } : context.principal }) : await this.ports.forwardControl!('file.undo', input, context)
        return boundedFileResult(parseFileUndoResult(result, input), context.responseId, true) as AgentMuxRpcResult<M>
      }

      if (method === 'file.history') {
        const input = parseFileHistoryParams(params)
        context.signal?.throwIfAborted()
        if (!this.ports.files?.history && !this.ports.forwardControl) throw new AgentMuxError('The original Host Note history owner is unavailable. Original files, history and Agents are retained.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files?.history ? await this.ports.files.history(input) : await this.ports.forwardControl!('file.history', input, context)
        const parsed = parseFileHistoryResult(result, input)
        if (input.includeContent) {
          try { rpcEncode({ jsonrpc: '2.0', id: context.responseId ?? null, result: parsed }) }
          catch (error) {
            if (!(error instanceof AgentMuxError) || error.code !== 'CONTROL_PROTOCOL_ERROR') throw error
            return { resource: parsed.resource, result: { status: 'unknown', code: 'FILE_HISTORY_CONTENT_UNAVAILABLE',
              message: 'This historical body exceeds the original RPC frame budget. Its original event and metadata remain available; query the same event without content.' } } as AgentMuxRpcResult<M>
          }
        }
        return parsed as AgentMuxRpcResult<M>
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
    if (isAgentProgressMethod(method)) {
      const progressMethod: AgentProgressMethod = method
      const input = parseAgentProgressParams(progressMethod, params)
      if (!caller && (!context.principal || !['user','device'].includes(context.principal.kind))) throw new AgentMuxError('Continuous progress requires its original authenticated actor.', 'CONTROL_PERMISSION_DENIED')
      if (!this.ports.progress) {
        if (this.ports.callOriginalCore) return await this.ports.callOriginalCore<AgentProgressMethod>('local', progressMethod, input, context) as AgentMuxRpcResult<M>
        if (this.ports.forwardControl) return await this.ports.forwardControl<AgentProgressMethod>(progressMethod, input, context) as AgentMuxRpcResult<M>
        throw new AgentMuxError('The original continuous progress owner is unavailable. Original arrangements and Agents remain available.', 'CONTROL_UNAVAILABLE')
      }
      return parseAgentProgressResult<AgentProgressMethod>(progressMethod, await this.ports.progress.call<AgentProgressMethod>(progressMethod, input, context), input) as AgentMuxRpcResult<M>
    }
    if (isScheduleMethod(method)) {
      const scheduleMethod: ScheduleMethod = method
      const input = parseScheduleRpcParams(scheduleMethod, params)
      context.signal?.throwIfAborted()
      if (!this.ports.schedules && this.ports.callOriginalCore) return await this.ports.callOriginalCore<ScheduleMethod>('local', scheduleMethod, input, context) as AgentMuxRpcResult<M>
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
    if (method === 'agent.interaction.respond' || method === 'agent.interaction.inspect') {
      const input = rpcRecord(params, NATIVE_FIELDS[method as 'agent.interaction.respond' | 'agent.interaction.inspect'])
      const target = await this.owner(rpcString(input.agentSessionId, 'Interaction Session ID'))
      rpcString(input.operationId, 'Interaction operation ID')
      context.signal?.throwIfAborted()
      if (target.client.forwardRpc) return await target.client.forwardRpc(method, { ...input, agentSessionId: target.agentSessionId } as AgentMuxRpcParams<typeof method>, context) as AgentMuxRpcResult<M>
      if (method === 'agent.interaction.inspect') return { receipt: await target.client.inspectAgentInteractionOperation({
        agentSessionId: target.agentSessionId, operationId: input.operationId as string }) } as AgentMuxRpcResult<M>
      return await target.client.respondAgentInteraction({ ...input, agentSessionId: target.agentSessionId } as AgentMuxRpcParams<'agent.interaction.respond'>,
        this.inputCallContext(context)) as AgentMuxRpcResult<M>
    }
    if (method === 'agent.question.reply') {
      const input = rpcRecord(params, NATIVE_FIELDS['agent.question.reply']) as AgentMuxRpcParams<'agent.question.reply'>
      const target = await this.owner(rpcString(input.agentSessionId, 'Question Session ID'))
      context.signal?.throwIfAborted()
      if (target.client.forwardRpc) return await target.client.forwardRpc('agent.question.reply', { ...input, agentSessionId: target.agentSessionId }, context) as AgentMuxRpcResult<M>
      const sourceDevice = this.ports.operationSource?.(context)
      return await target.client.replySessionQuestion({ ...input, agentSessionId: target.agentSessionId, ...(input.externalAction ? {} : { authorHuman: true }), sourceChannel: normalizeMessageChannel(input.sourceChannel ?? 'api'),
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
    if (method === 'agent.conversation.record') {
      const p = rpcRecord(params, ['hostId', 'agentSessionId', 'ingressId', 'authoritySource']), hostId = rpcString(p.hostId, 'Conversation Host'), input = parseExternalConversationReference({ agentSessionId: p.agentSessionId, ingressId: p.ingressId, ...(p.authoritySource === undefined ? {} : { authoritySource: p.authoritySource }) })
      const owners = (await this.clients()).filter(entry => entry.hostId === hostId)
      if (owners.length !== 1) throw new AgentMuxError('The exact conversation Host is unavailable or ambiguous.', 'RUNTIME_UNAVAILABLE')
      const result = await owners[0]!.client.recordExternalConversationMessage(input)
      return parseExternalConversationReceipt(result, input) as AgentMuxRpcResult<M>
    }
    if (method === 'agent.conversation.release') {
      const input = parseConversationViewReleaseInput(params), forwarded = forwardConversationInput(input)
      const owners = (await this.clients()).filter(entry => entry.hostId === input.hostId)
      if (owners.length !== 1) throw new AgentMuxError('The exact conversation Host is unavailable or ambiguous.', 'RUNTIME_UNAVAILABLE')
      const result = await owners[0]!.client.releaseConversationView(forwarded.input)
      if (result.sourceHostId !== forwarded.sourceHostId) throw new AgentMuxError('The release returned another original conversation Host.', 'CONTROL_PROTOCOL_ERROR')
      return parseConversationViewReleaseResult({ ...result, hostId: input.hostId }, input) as AgentMuxRpcResult<M>
    }
    if (method === 'agent.conversation.checkpoint' || method === 'agent.conversation.changes' || method === 'agent.conversation.inspect') {
      const input = method === 'agent.conversation.changes' ? parseConversationChangesInput(params)
        : method === 'agent.conversation.inspect' ? parseConversationTimelineReadInput(params) : parseConversationCheckpointInput(params)
      const owners = (await this.clients()).filter(entry => entry.hostId === input.hostId)
      if (owners.length !== 1) throw new AgentMuxError('The exact conversation Host is unavailable or ambiguous.', 'RUNTIME_UNAVAILABLE')
      const client = owners[0]!.client, options = { ...(context.signal ? { signal: context.signal } : {}) }
      // The selected route is external context. Source refs and fragment bytes
      // stay in the original semantic Core namespace, including on a remote Host.
      if (method === 'agent.conversation.checkpoint') {
        const page = await client.conversationCheckpoint({ ...input, hostId: 'local' }, options)
        return parseConversationCheckpointPage({ ...page, hostId: input.hostId, checkpoint: { ...page.checkpoint, hostId: input.hostId } }, input) as AgentMuxRpcResult<M>
      }
      if (method === 'agent.conversation.inspect') {
        const request = input as import('./conversation-changes.js').ConversationTimelineReadInput, forwarded = forwardConversationInput(request)
        const page = await readRoutedConversation(request, (maxBytes, replay) => client.readAgentConversation({ ...forwarded.input, maxBytes, ...(replay ? { cursor: replay } : {}) }, options), forwarded.sourceHostId)
        return parseConversationReadPage(page, request) as AgentMuxRpcResult<M>
      }
      const request = input as import('./conversation-changes.js').ConversationChangesInput, forwarded = forwardConversationInput(request)
      const page = await readRoutedConversation(request, (maxBytes, replay) => client.readConversationChanges({ ...forwarded.input, maxBytes, ...(replay ? { cursor: replay } : {}) }, options), forwarded.sourceHostId)
      return parseConversationChangesPage(page, request) as AgentMuxRpcResult<M>
    }
    if (method === 'app.search') {
      const input = parseAgentMuxSearchInput(params)
      this.search ??= createAgentMuxSearchReader<SearchCallContext>(createAgentMuxSearchObservationOwner<SearchCallContext>({
        clients: () => this.clients(),
        ...(this.ports.capsules || this.ports.forwardControl ? { capsules: { hostId: 'local',
          read: (readContext: SearchCallContext) => this.call('capsule.ls', {}, readContext.rpc) } } : {}),
        catalog: async () => {
          const result = await this.execute(this.request('space.ls', { target: {} }))
          if (result.operation !== 'space.ls') throw new AgentMuxError('The original spatial catalog returned another operation.', 'CONTROL_PROTOCOL_ERROR')
          return result.catalog
        },
        projects: async () => {
          const result = await this.execute(this.request('list.projects'))
          if (result.operation !== 'list.projects') throw new AgentMuxError('The original Project owner returned another operation.', 'CONTROL_PROTOCOL_ERROR')
          return result.projects
        },
        snapshot: async () => this.ports.snapshot ? await this.ports.snapshot({ include: ['workspaces', 'topics', 'motes'] }) : {
          unavailable: ['workspaces', 'topics', 'motes'].map(source => ({ source, code: 'FILESYSTEM_SCOPE_UNAVAILABLE', message: 'The original client metadata owner is unavailable.', recovery: 'Connect the original config/filesystem observation port; known Sessions remain searchable.' }))
        },
        history: (input, readContext) => this.call('agent.history', input, readContext.rpc)
      }))
      const authority = createHash('sha256').update(JSON.stringify(context.caller
        ? ['agent', context.caller.agentSessionId, context.caller.capability]
        : ['principal', context.principal?.kind ?? 'public', context.principal?.id ?? '', context.transport ?? 'sdk'])).digest('hex')
      return await this.search.read(input, { authority, rpc: context, ...(context.signal ? { signal: context.signal } : {}) }) as AgentMuxRpcResult<M>
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
      if (isSessionHistoryQuery(input)) {
        const page = await client.readAgentSessionHistory({ ...input, hostId: 'local' }, context.signal ? { signal: context.signal } : {})
        return { ...page, hostId: input.hostId } as AgentMuxRpcResult<M>
      }
      return await readAgentSessionHistory(client, input, context.signal ? { signal: context.signal } : {}) as AgentMuxRpcResult<M>
    }
    if (caller?.client.forwardRpc && ['agent.role.ls', 'agent.role.register', 'agent.role.resolve',
      'agent.discuss', 'agent.broadcast', 'agent.handoff', 'message.inbox.check', 'message.inbox.ack',
      'message.dispatch.open', 'message.dispatch.inspect', 'message.dispatch.report'].includes(method)) {
      return await caller.client.forwardRpc(method, params, context)
    }
    let result: unknown
    if (this.ports.motePreferences && p.kind === 'connection' &&
        (method === 'space.mote.preferences.read' || method === 'space.mote.preferences.save')) {
      const actor = caller ? { kind: 'agent' as const, id: caller.agentSessionId }
        : context.principal && (context.principal.kind === 'user' || context.principal.kind === 'device')
          ? { kind: context.principal.kind, id: rpcString(context.principal.id, 'Original preference actor') } : undefined
      if (!actor) throw new AgentMuxError('Mote preferences require their original authenticated actor. Original files and Agents remain available.', 'CONTROL_PERMISSION_DENIED')
      const administration = { actor, ...(context.signal ? { signal: context.signal } : {}), assertCurrent: async () => {
        context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
        if (caller) await this.authenticated(context)
      } }
      await administration.assertCurrent()
      if (method === 'space.mote.preferences.read') {
        const input = parseMotePreferencesReadInput(params) as MoteConnectionPreferencesReadInput
        const result = await this.ports.motePreferences.read(input)
        await administration.assertCurrent()
        return parseMotePreferencesReadResult(result, input) as AgentMuxRpcResult<M>
      }
      const input = parseMotePreferencesSaveParams(params) as MoteConnectionPreferencesSaveParams
      const result = await this.ports.motePreferences.save(input, administration)
      await administration.assertCurrent()
      return parseMotePreferencesSaveResult(result, input) as AgentMuxRpcResult<M>
    }
    if (Object.hasOwn(AGENTMUX_RPC_CONTROL_METHODS, method)) {
      const internalCaller: AgentMuxControlCaller | undefined = caller
        ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined
      const originalControlOperation = AGENTMUX_RPC_CONTROL_METHODS[method as keyof typeof AGENTMUX_RPC_CONTROL_METHODS]
      const originalSpatialRequest = method === 'agent.open' || method === 'space.inspect' ? rpcControlRequest(method, params) : null
      const originalResumeRequest = method === 'agent.resume' ? rpcControlRequest(method, params, internalCaller) : null
      const independentResume = originalResumeRequest?.operation === 'resume' && !originalResumeRequest.text.trim()
      let independentSpatial = originalSpatialRequest && (isBackgroundLocalAgentOpen(originalSpatialRequest) ||
        originalSpatialRequest.operation === 'space.inspect' && 'requestId' in originalSpatialRequest.target)
      if (independentSpatial && originalSpatialRequest?.operation === 'agent.open') independentSpatial =
        isBackgroundLocalAgentOpen(originalSpatialRequest, (await this.spatial.readForLayout())?.graph)
      if (independentSpatial && this.ports.callOriginalCore) return await this.ports.callOriginalCore('local', method, params, context)
      if (originalControlOperation === 'settings.resource.list' || originalControlOperation === 'settings.resource.get') {
        const request = rpcControlRequest(method as keyof typeof AGENTMUX_RPC_CONTROL_METHODS, params)
        if (this.ports.callOriginalCore) return await this.ports.callOriginalCore('local', method, params, context)
        if (this.ports.settingsResources) return rpcControlResult(method, await this.execute(request, undefined, context)) as AgentMuxRpcResult<M>
      }
      if (method === 'toolkit.run' || method === 'toolkit.action' || method === 'toolkit.evaluate') {
        await this.assertToolkitExecutionAuthority(p.toolId, context)
      }
      if (this.ports.spatialState && (method === 'space.ls' || method === 'space.inspect')) {
        const target = rpcRecord(p.target)
        if (!Object.hasOwn(target, 'operationId') && !Object.hasOwn(target, 'requestId') &&
            target.regionId !== 'self' && target.tabId !== 'self') {
          const request = rpcControlRequest(method, params)
          // Desktop borrows the original Host for domain reads even while its screen is present.
          if (this.ports.callOriginalCore) return await this.ports.callOriginalCore('local', method, params, context)
          const state = await this.spatial.readForLayout()
          if (!state) throw new AgentMuxError('No durable spatial graph has been registered.', 'SPATIAL_STATE_ABSENT')
          const selector = request.operation === 'space.ls' || request.operation === 'space.inspect' ? request.target as import('./space-control.js').AgentMuxSpaceSelector : {}
          const catalog = spatialCatalog(state.graph, selector)
          if (p.presentation === true && this.ports.spatialPresentation) Object.assign(catalog,
            await this.ports.spatialPresentation({ graph: state.graph, catalog, target: selector,
              ...(method === 'space.inspect' && typeof target.spaceId === 'string' ? { imageSpaceId: target.spaceId } : {}) }, context))
          return rpcControlResult(method, { operation: method, catalog }) as AgentMuxRpcResult<M>
        }
      }
      if (this.ports.forwardControl && !independentResume && !(this.ports.spatialAgentControl && independentSpatial) && !(this.ports.goalControl && method.startsWith('goal.') && method !== 'goal.focus')) return await this.ports.forwardControl(method, params, context)
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
      const request = originalResumeRequest ?? rpcControlRequest(method as keyof typeof AGENTMUX_RPC_CONTROL_METHODS, body, internalCaller)
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
        : request.operation === 'metrics.allocations.capture' ? { operation: 'metrics.allocations.capture', capture: await this.captureAllocations({ target: request.target, durationMs: request.durationMs }, context.signal) }
        : request.operation === 'metrics.scene.capture' ? { operation: 'metrics.scene.capture', capture: await this.captureScene({ target: request.target }, context.signal) }
        : request.operation === 'metrics.scene.inspect' ? { operation: 'metrics.scene.inspect', inspection: await this.inspectScene(request.captureId === undefined ? {} : { captureId: request.captureId }, context.signal) }
        : request.operation === 'metrics.animations.inspect' ? { operation: 'metrics.animations.inspect', observation: await this.inspectAnimations({ target: request.target }, context.signal) }
        : request.operation === 'metrics.memory.inspect' ? { operation: 'metrics.memory.inspect', observation: await this.inspectMemory({ target: request.target }, context.signal) }
        : request.operation === 'metrics.heap.capture' ? { operation: 'metrics.heap.capture', capture: await this.captureHeapSnapshot({ target: request.target, captureId: request.captureId }, context.signal) }
        : request.operation === 'metrics.heap.inspect' ? { operation: 'metrics.heap.inspect', inspection: await this.inspectHeapSnapshot(request.captureId === undefined ? {} : { captureId: request.captureId }, context.signal) }
        : request.operation === 'metrics.trace.capture' ? { operation: 'metrics.trace.capture', capture: await this.captureTrace({ target: request.target, durationMs: request.durationMs }, context.signal) }
        : request.operation === 'metrics.profile.capture' ? { operation: 'metrics.profile.capture', capture: await this.captureProfile({ target: request.target, durationMs: request.durationMs }, context.signal) }
        : request.operation === 'metrics.get' ? { operation: 'metrics.get', observation: await this.metrics(context.signal) }
        : request.operation === 'metrics.app-memory.inspect' ? { operation: 'metrics.app-memory.inspect', evidence: await this.inspectAppMemory() }
        : await this.execute(request, nameContext, context)
      return rpcControlResult(method, result as AgentMuxControlResult) as AgentMuxRpcResult<M>
    }
    const fields = NATIVE_FIELDS[method as keyof typeof NATIVE_FIELDS]
    if (!fields) throw new AgentMuxError('Unknown RPC method.', 'RPC_METHOD_NOT_FOUND')
    rpcRecord(p, fields)
    const needsTitleOwner = !this.notebooks.hasTitleOwner() && (method === 'notebook.inspect' && typeof p.operationId === 'string' ||
      method === 'notebook.apply' && p.change !== null && typeof p.change === 'object' && !Array.isArray(p.change) && (p.change as Record<string, unknown>).kind === 'rename-page')
    let unavailableTitleObservation: string | undefined
    if (needsTitleOwner && this.ports.forwardControl) {
      // The headless Host borrows the same Desktop file/history owner; it never
      // creates a metadata-only title success or retries an unavailable local owner elsewhere.
      try { return parseRpcNativeResult(method, await this.ports.forwardControl(method, p as AgentMuxRpcParams<M>, context), p, context.caller) as AgentMuxRpcResult<M> }
      catch (error) {
        context.signal?.throwIfAborted()
        if (method !== 'notebook.inspect' || error instanceof AgentMuxError && error.code === 'CONTROL_PERMISSION_DENIED') throw error
        // File-title observation cannot remove an independently healthy catalog read.
        unavailableTitleObservation = error instanceof Error ? error.message : String(error)
      }
    }
    const needsNoteReader = method === 'notebook.scan' || method === 'notebook.graph' || method === 'notebook.resolve' || method === 'notebook.inspect' && p.content === true
    if (needsNoteReader && !this.ports.notebookObservation && this.ports.forwardControl) {
      // Core keeps its original durable catalog available independently of Desktop.
      // Saved bodies and relationships borrow the original Host file reader.
      return parseRpcNativeResult(method, await this.ports.forwardControl(method, p as AgentMuxRpcParams<M>, context), p, context.caller) as AgentMuxRpcResult<M>
    }
    switch (method) {
      case 'browser.input.inspect': {
        const reference = parseAgentInputContextCaptureReference(p)
        if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id.trim())) {
          throw new AgentMuxError('Reading an original input capture requires its authenticated user, device or recipient Agent.', 'CONTROL_PERMISSION_DENIED')
        }
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        if (!this.ports.inputContextCaptures) {
          if (this.ports.forwardControl) return parseAgentInputContextCaptureRead(await this.ports.forwardControl(method, reference as AgentMuxRpcParams<M>, context), reference) as AgentMuxRpcResult<M>
          throw new AgentMuxError('The original input capture owner is unavailable. Retain its reference; ordinary input remains available.', 'AGENT_INPUT_CONTEXT_CAPTURE_UNCONFIRMED')
        }
        const read = parseAgentInputContextCaptureRead(await this.ports.inputContextCaptures.read(reference, context.signal ? { signal: context.signal } : undefined), reference)
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        if (caller) {
          await this.authenticated(context)
          if (read.record && (read.record.binding.executionHostId !== caller.hostId || read.record.binding.agentSessionId !== caller.agentSessionId)) {
            throw new AgentMuxError('An Agent may read only its own original input capture on its exact execution Host.', 'CONTROL_PERMISSION_DENIED')
          }
        }
        result = read; break
      }
      case 'agent.conversation.landmark.ls': result = await this.landmarks.list(parseConversationLandmarkQuery(p)); break
      case 'agent.conversation.landmark.apply': {
        const actor = caller ? { kind: 'agent' as const, id: caller.agentSessionId } : context.principal
        if (!actor) throw new AgentMuxError('Reading-point writing requires an authenticated user, device or Agent. Original records and Runs remain available.', 'CONTROL_PERMISSION_DENIED')
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        result = await this.landmarks.apply(parseConversationLandmarkWrite(p), actor); break
      }
      case 'notebook.scan': {
        const input = parseNoteCorpusParams(p)
        if (!this.ports.notebookObservation?.scan) throw new AgentMuxError('The original Host corpus reader is unavailable. Catalog, editing and Agents remain available; reconnect this same Host to retry this read.', 'CONTROL_UNAVAILABLE')
        result = parseNoteCorpusResult(await this.ports.notebookObservation.scan(input, context.signal ? { signal: context.signal } : undefined), input); break
      }
      case 'notebook.ls': result = {state:await this.notebooks.read()}; break
      case 'notebook.inspect': {
        const input = parseNotebookObservationParams(p, true), state = await this.notebooks.read()
        const storage = this.notebooks.storage ? await this.notebooks.storage.inspect(input.operationId) : undefined
        result = { ...inspectNotebook(state, input), ...(storage ? { storageOperation: storage.operation, resourceChanges: storage.resourceChanges, conversionIssues: storage.conversionIssues } : {}),
          ...(input.operationId ? { titleOperation: unavailableTitleObservation === undefined ? await this.notebooks.inspectTitleOperation(input.operationId)
            : { operation: { status: 'unavailable', operationId: input.operationId, reason: unavailableTitleObservation }, file: null, projection: null } } : {}),
          ...(input.content ? { content: this.ports.notebookObservation
            ? await this.ports.notebookObservation.content(state, input.noteId!, { ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }), ...(context.signal ? { signal: context.signal } : {}) })
            : (() => { throw new AgentMuxError('The original Host Note reader is unavailable. Directory and Agent capabilities remain available; retry this observation when the Host reconnects.', 'CONTROL_UNAVAILABLE') })() } : {}) }; break
      }
      case 'notebook.graph': {
        const input = parseNotebookObservationParams(p)
        if (!this.ports.notebookObservation) throw new AgentMuxError('The original Host Note graph reader is unavailable. Directory and Agent capabilities remain available; retry this observation when the Host reconnects.', 'CONTROL_UNAVAILABLE')
        result = await this.ports.notebookObservation.graph(await this.notebooks.read(), input, context.signal ? { signal: context.signal } : undefined); break
      }
      case 'notebook.resolve': {
        const input = parseNotebookResolveParams(p)
        if (!this.ports.notebookObservation) throw new AgentMuxError('The original Host Note resolver is unavailable. Editing and Agents remain available; retry this observation after reconnecting.', 'CONTROL_UNAVAILABLE')
        result = await this.ports.notebookObservation.resolve(await this.notebooks.read(), input, context.signal ? { signal: context.signal } : undefined); break
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
        const { clientIncidents: incidentFactory, ...originalPorts } = this.ports
        const incidents = await incidentFactory?.(context)
        // Only this injected original archive's exact namespace terminates here.
        // All other client reads borrow the same Host domain from every screen.
        if (input.target?.domain === 'client.incident' && this.ports.callOriginalCore &&
          (!input.target.authority || input.target.authority.kind !== incidents?.authority?.kind || input.target.authority.id !== incidents?.authority?.id)) {
          result = await this.ports.callOriginalCore('local', 'system.diagnostics.inspect', input, context); break
        }
        const diagnosticPorts = { ...originalPorts, ...(incidents ? { clientIncidents: incidents } : {}) }
        // Discovery reads registered contracts only. An attached client cannot replace
        // an original local journal, authority or reader for an already-owned domain.
        const local = await inspectDiagnosticEvidence(this.diagnosticQuery, {}, diagnosticPorts, caller, context.signal)
        const ownsTarget = local.capabilities.some(capability => capability.domain === input.target?.domain &&
          (input.target?.domain !== 'agent.startup' || capability.target === ('recent' in input.target ? 'recent' : 'log-id')) &&
          (input.target?.domain !== 'client.incident' || capability.target === ('recent' in input.target ? 'recent' : 'log-id')) &&
          (input.target?.domain !== 'client.notifications' || capability.target === ('list' in input.target ? 'notification-list' : 'notification-id')))
        if ((!input.target || !ownsTarget) && this.ports.forwardControl) {
          try {
            const forwarded = parseDiagnosticEvidenceResult(await this.ports.forwardControl('system.diagnostics.inspect', structuredClone(input), context), input)
            if (input.target) { result = forwarded; break }
            const capabilities = new Map(local.capabilities.map(capability => [`${capability.domain}:${capability.target}`, capability]))
            for (const capability of forwarded.capabilities) {
              const key = `${capability.domain}:${capability.target}`
              if (!capabilities.has(key)) capabilities.set(key, capability)
            }
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
        result = input.target ? await inspectDiagnosticEvidence(this.diagnosticQuery, input, diagnosticPorts, caller, context.signal) : local
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
        parseAgentDiscoveryFilters(p)
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
      case 'skill.ls': {
        const hostId = rpcString(p.hostId, 'Original route Host'), agentSessionId = rpcString(p.agentSessionId, 'Complete original Session ID')
        const scopes = (await this.clients()).filter(scope => scope.hostId === hostId)
        if (scopes.length !== 1) throw new AgentMuxError('The original skill discovery Host is unconfirmed. Select its exact configured route.', 'UNKNOWN_HOST')
        const { client } = scopes[0]!
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        if (client.forwardRpc) {
          const page = parseRpcNativeResult('skill.ls', await client.forwardRpc('skill.ls', { hostId: 'local', agentSessionId }, context), { hostId: 'local', agentSessionId })
          result = { ...page, hostId }; break
        }
        const session = await client.readAgentSession(agentSessionId)
        if (!session || session.agentSessionId !== agentSessionId || session.hostId !== hostId) throw new AgentMuxError('The exact original Session is unavailable for skill discovery.', 'UNKNOWN_AGENT_SESSION')
        const catalog = client.catalog().find(entry => entry.id === session.providerId)
        if (!catalog) throw new AgentMuxError('The original Provider skill roots are unconfirmed. The Session and draft remain available.', 'UNKNOWN_PROVIDER')
        const skills = await discoverAgentSkills({ catalog, workspacePath: session.workspacePath, home: homedir() })
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        result = { hostId, sourceHostId: session.hostId, agentSessionId, providerId: session.providerId, workspacePath: session.workspacePath, skills }
        break
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
      case 'agent.continuity.control': {
        const input = parseAgentContinuityControlInput(p)
        // An exact endpoint/caller fixes its semantic owner even after retirement.
        // Aggregate routing uses retained exact identity, never prefix selection.
        const scopes = caller ? [caller] : await this.clients()
        let selected = scopes.length === 1 ? scopes[0] : undefined
        if (!selected) {
          const observations = await Promise.allSettled(scopes.map(async scope => ({ scope,
            sources: await scope.client.sessionHistorySources({ agentSessionId: input.agentSessionId }) })))
          if (observations.some(one => one.status === 'rejected')) throw new AgentMuxError(
            'The original recovery control route is unconfirmed. Keep its complete packet and operation ID.', 'RUNTIME_UNAVAILABLE')
          const owners = observations.flatMap(one => one.status === 'fulfilled' && one.value.sources.some(source =>
            source.agentSessionId === input.agentSessionId) ? [one.value.scope] : [])
          if (owners.length !== 1) throw new AgentMuxError('The exact original recovery control owner is unavailable or ambiguous.',
            owners.length ? 'AMBIGUOUS_AGENT_SESSION' : 'UNKNOWN_AGENT_SESSION')
          selected = owners[0]!
        }
        context.signal?.throwIfAborted()
        const result = selected.client.forwardRpc
          ? await selected.client.forwardRpc('agent.continuity.control', input, await this.inputForwardContext(context))
          : await selected.client.controlAgentContinuity(input, { ...this.inputCallContext(context),
            ...(caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {}) })
        const verified = parseAgentContinuityControlResult(result, input)
        if ((verified.state === 'active' ? verified.session.hostId : verified.retirement.hostId) !== 'local') throw new AgentMuxError(
          'The recovery control returned another original Host.', 'CONTROL_PROTOCOL_ERROR')
        return verified as AgentMuxRpcResult<M>
      }
      case 'terminal.recover': {
        if (caller || !context.principal || !['user', 'device'].includes(context.principal.kind))
          throw new AgentMuxError('Raw Terminal recovery requires its transport-approved user or device owner.', 'CONTROL_PERMISSION_DENIED')
        const hostId = rpcString(p.hostId, 'Execution Host'), { hostId: _host, ...raw } = p
        const input = parseTerminalRecoveryInput(raw)
        const selected = (await this.clients()).filter(scope => scope.hostId === hostId)
        if (selected.length !== 1) throw new AgentMuxError('The exact Terminal execution Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
        const scope = selected[0]!
        result = parseTerminalRecoveryResult(scope.client.forwardRpc
          ? await scope.client.forwardRpc('terminal.recover', { ...input, hostId: 'local' }, await this.inputForwardContext(context))
          : await scope.client.recoverTerminal(input), input)
        break
      }
      case 'agent.refresh': {
        const agentSessionId = rpcString(p.agentSessionId, 'Complete original Session ID')
        const selected = await this.owner(agentSessionId)
        if (selected.agentSessionId !== agentSessionId) throw new AgentMuxError(
          'Session refresh requires the complete original Session ID.', 'INVALID_CONTROL_REQUEST')
        const session = await selected.client.refreshAgentSession(agentSessionId)
        if (session.agentSessionId !== agentSessionId || session.hostId !== selected.session.hostId) throw new AgentMuxError(
          'Session refresh returned another original Session or Host.', 'CONTROL_PROTOCOL_ERROR')
        result = { session }; break
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
        result = { session: owner.session, status, view, unavailable: issues }; break
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
          targetAgentSessionId: discussion.session.agentSessionId, creation: discussion.session.creation! }; break
      }
      case 'agent.spawn.ls': {
        const hostId = rpcString(p.hostId, 'Original creation Host'), participant = rpcString(p.participantSessionId, 'Spawn participant Session')
        if (caller ? participant !== caller.agentSessionId : !context.principal || !['user', 'device'].includes(context.principal.kind)) {
          throw new AgentMuxError('Spawn reading requires its original participant or an authenticated user/device. Existing Sessions remain available.', 'CONTROL_PERMISSION_DENIED')
        }
        const scopes = (await this.clients()).filter(scope => scope.hostId === hostId)
        if (scopes.length !== 1) throw new AgentMuxError('The exact creation Host is unavailable or ambiguous; original receipts are retained.', 'CONTROL_UNAVAILABLE')
        const { hostId: _host, ...query } = p
        if (caller && caller.hostId !== hostId) {
          const { runtimeId } = await caller.client.agentCreationAuthority()
          if (p.direction !== 'created' || p.creatorRuntimeId !== undefined && p.creatorRuntimeId !== runtimeId) {
            throw new AgentMuxError('A remote spawn query must stay with its authenticated original creator.', 'CONTROL_PERMISSION_DENIED')
          }
          query.creatorRuntimeId = runtimeId
        } else if (caller && p.creatorRuntimeId !== undefined) {
          throw new AgentMuxError('The original local creator query cannot claim another Runtime source.', 'CONTROL_PERMISSION_DENIED')
        }
        result = { hostId, ...await scopes[0]!.client.listAgentSpawns(query as import('./agent-spawn-query.js').AgentMuxSpawnQuery) }; break
      }
      case 'agent.handoff': {
        const owner = this.requireCaller(caller)
        result = await owner.client.handOff({ capability: owner.capability, callerAgentSessionId: owner.agentSessionId,
          toAgentSessionId: (await this.owner(rpcString(p.toAgentSessionId, 'Recipient Session ID'))).agentSessionId,
          taskId: rpcString(p.taskId, 'Task ID') }); break
      }
      case 'message.notify': case 'message.notify.inspect': {
        if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind))) throw new AgentMuxError(
          'Notification operations require an authenticated Agent participant or trusted user/device.', 'CONTROL_PERMISSION_DENIED')
        const hostId = rpcString(p.hostId, 'Original message Host ID')
        if (caller && caller.hostId !== hostId) throw new AgentMuxError('Agent authority cannot notify another semantic Host journal.', 'CONTROL_PERMISSION_DENIED')
        const scopes = caller ? [caller] : (await this.clients()).filter(scope => scope.hostId === hostId)
        if (scopes.length !== 1) throw new AgentMuxError('The original message Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
        const owner = scopes[0]!
        const auth = caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {}
        if (method === 'message.notify.inspect') {
          result = { ...await (owner.client.forwardRpc
            ? owner.client.forwardRpc('message.notify.inspect', { operationId: rpcString(p.operationId, 'Notification operation ID'), hostId: 'local' }, context)
            : owner.client.inspectMessageNotification({ operationId: rpcString(p.operationId, 'Notification operation ID'), ...auth })), hostId }
          break
        }
        if (owner.client.forwardRpc) { result = { ...await owner.client.forwardRpc('message.notify', { ...p, hostId: 'local' } as AgentMuxRpcParams<'message.notify'>, await this.inputForwardContext(context)), hostId }; break }
        if (!Array.isArray(p.messageIds)) throw new AgentMuxError('Select original Inbox message IDs.', 'INVALID_A2A_NOTIFICATION')
        result = { ...await owner.client.notifyMessages({ operationId: rpcString(p.operationId, 'Notification operation ID'),
          messageIds: p.messageIds.map(id => rpcString(id, 'Original message ID')), ...auth }, this.inputCallContext(context)), hostId }
        break
      }
      case 'agent.broadcast.inspect': case 'message.read': case 'message.ls': case 'message.events': case 'message.dispatch.read': case 'message.dispatch.ls': {
        if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id.trim())) throw new AgentMuxError(
          'Message reading requires an authenticated Agent participant or a transport-approved user/device. Original communication and Runs are retained.', 'CONTROL_PERMISSION_DENIED')
        if (method === 'message.read' && (p.operationId !== undefined) === (p.messageId !== undefined)) throw new AgentMuxError(
          'Choose exactly one original message operationId or messageId.', 'INVALID_CONTROL_REQUEST')
        const messageSelector: import('./agent-message-query.js').AgentMuxMessageRead | undefined = method !== 'message.read' ? undefined : {
          ...(p.messageId === undefined ? { operationId: rpcString(p.operationId, 'Original message operation ID') }
            : { messageId: rpcString(p.messageId, 'Original message ID') }),
          ...(p.notificationId === undefined ? {} : { notificationId: rpcString(p.notificationId, 'Original notification ID') }) }
        const hostId = p.hostId === undefined ? caller?.hostId : rpcString(p.hostId, 'Original message Host ID')
        if (hostId === undefined) throw new AgentMuxError('A trusted reader must select the exact original message Host.', 'INVALID_CONTROL_REQUEST')
        if (caller && caller.hostId !== hostId) throw new AgentMuxError('Agent authority cannot read another semantic Host journal.', 'CONTROL_PERMISSION_DENIED')
        if (method === 'message.read' && hostId === 'local') {
          const route = await (await this.messageRouteJournal()).readMessageRoute(messageSelector!.operationId, messageSelector!.messageId)
          if (route) {
            const remote = await this.messageRouteOwner(route)
            if (caller && caller.client !== remote.client) throw new AgentMuxError('Agent authority cannot read another semantic Host journal.', 'CONTROL_PERMISSION_DENIED')
            result = { ...await remote.client.forwardRpc!('message.read', { ...messageSelector!, hostId: 'local' }, context), hostId }
            break
          }
        }
        const scopes = caller ? [caller] : (await this.clients()).filter(scope => scope.hostId === hostId)
        if (scopes.length !== 1) throw new AgentMuxError('The exact message Host owner is unavailable or ambiguous. Keep the original source reference.', 'CONTROL_UNAVAILABLE')
        const owner = scopes[0]!
        if (owner.client.forwardRpc) {
          result = { ...await owner.client.forwardRpc(method, { ...p, hostId: 'local' } as AgentMuxRpcParams<M>, context), hostId }; break
        }
        const auth = caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {}
        if (method === 'message.read') {
          result = { message: await owner.client.readMessage({ ...messageSelector!, ...auth }), hostId }
        } else if (method === 'agent.broadcast.inspect') {
          result = { broadcast: await owner.client.inspectMessageBroadcast({ operationId: rpcString(p.operationId, 'Original broadcast operation ID'), ...auth }), hostId }
        } else if (method === 'message.ls') {
          if (p.direction !== 'incoming' && p.direction !== 'outgoing') throw new AgentMuxError('Message direction must be incoming or outgoing.', 'INVALID_CONTROL_REQUEST')
          result = { ...await owner.client.listMessages({
            participantSessionId: rpcString(p.participantSessionId ?? caller?.agentSessionId, 'Participant Session ID'),
            direction: p.direction, ...(p.beforeSequence === undefined ? {} : { beforeSequence: rpcCount(p.beforeSequence, -1, Number.MAX_SAFE_INTEGER) }),
            limit: rpcCount(p.limit, 50, 100), ...auth }), hostId }
        }
        else if (method === 'message.events') {
          const { hostId: _hostId, ...query } = p
          result = { ...await owner.client.listMessageEvents({ ...query,
          participantSessionId: rpcString(p.participantSessionId ?? caller?.agentSessionId, 'Participant Session ID'),
          ...auth }), hostId }
        }
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
      case 'goal.participation.confirm': {
        const input = parseGoalParticipationConfirm(p)
        if (this.ports.goalParticipation) { result = await this.ports.goalParticipation.confirm(input, context); break }
        if (this.ports.callOriginalCore) return await this.ports.callOriginalCore('local', 'goal.participation.confirm', input, context) as AgentMuxRpcResult<M>
        throw new AgentMuxError('The original Goal participation owner is unavailable. Retain its Goal and input operation; no input was repeated.', 'CONTROL_UNAVAILABLE')
      }
      case 'agent.automation.pause': case 'agent.automation.inspect': {
        if (context.caller || !context.principal || !['user', 'device'].includes(context.principal.kind)) throw new AgentMuxError('Only the original person or device may pause automatic input. This action stops no Agent and grants no input permission.', 'CONTROL_PERMISSION_DENIED')
        const input = parseAgentAutomationTarget(p), scope = await this.owner(input.agentSessionId)
        if (scope.client.forwardRpc) return (method === 'agent.automation.pause'
          ? await scope.client.forwardRpc('agent.automation.pause', input, await this.inputForwardContext(context))
          : await scope.client.forwardRpc('agent.automation.inspect', input, await this.inputForwardContext(context))) as AgentMuxRpcResult<M>
        if (scope.hostId === 'local' && this.ports.callOriginalCore) return (method === 'agent.automation.pause'
          ? await this.ports.callOriginalCore(scope.hostId, 'agent.automation.pause', input, await this.inputForwardContext(context))
          : await this.ports.callOriginalCore(scope.hostId, 'agent.automation.inspect', input, await this.inputForwardContext(context))) as AgentMuxRpcResult<M>
        if (!this.ports.automaticInput) throw new AgentMuxError('The original automatic input owner is unavailable. Keep this pause operation and inspect it after reconnecting; manual Agent input remains available.', 'CONTROL_UNAVAILABLE')
        const value = method === 'agent.automation.pause' ? await this.ports.automaticInput.pause(input, context) : await this.ports.automaticInput.inspect(input, context)
        result = parseAgentAutomationInspection(value, input); break
      }
      case 'agent.input.submit': {
        if (context.caller !== undefined) throw new AgentMuxError('Managed Agents must use agent.send for cross-Session input; agent.input.submit cannot impersonate a local prompt author.', 'MANAGED_AGENT_PROMPT_FORBIDDEN')
        if (!context.principal || !['user', 'device'].includes(context.principal.kind)) throw new AgentMuxError('Prompt intake requires its transport-approved local user or device. No input was submitted.', 'CONTROL_PERMISSION_DENIED')
        const input = parseAgentInputSubmit(p), scope = await this.owner(input.agentSessionId)
        if (scope.agentSessionId !== input.agentSessionId) throw new AgentMuxError('Prompt intake requires the exact original Session ID.', 'INVALID_AGENT_PROMPT')
        if (scope.client.forwardRpc) return await scope.client.forwardRpc('agent.input.submit', input, await this.inputForwardContext(context)) as AgentMuxRpcResult<M>
        if (scope.hostId === 'local' && this.ports.callOriginalCore) return await this.ports.callOriginalCore(scope.hostId, 'agent.input.submit', input, await this.inputForwardContext(context)) as AgentMuxRpcResult<M>
        const device = this.ports.operationSource?.(context)
        const receipt = await scope.client.submitAgentPrompt({ ...input, sourceChannel: context.transport === 'unix' ? 'cli' : 'api',
          ...(device ? { sourceDevice: normalizeOperationDevice(device) } : {}) }, this.inputCallContext(context))
        const key = { kind: 'prompt' as const, agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, submissionId: input.operationId }
        const observed = await scope.client.inspectAgentInput({ key }) ?? receipt
        // One receipt owns its observed admission. Independent reads can straddle
        // dispatch and would produce an internally contradictory public packet.
        const record = observed ? observed.admission : await scope.client.inspectAgentPromptSubmission(key)
        result = { key, record, ...(observed ? { input: observed } : {}) }
        break
      }
      case 'agent.input.changes': {
        const hostId = rpcString(p.hostId, 'Original input Host ID')
        if (caller && caller.hostId !== hostId || !caller && (!context.principal || !['user', 'device'].includes(context.principal.kind))) throw new AgentMuxError(
          'Input changes requires its original Host and an authenticated recipient or user/device.', 'CONTROL_PERMISSION_DENIED')
        const scopes = (caller ? [caller] : await this.clients()).filter(scope => scope.hostId === hostId)
        if (scopes.length !== 1 || this.endpointUnverified(scopes[0]!.client)) throw new AgentMuxError('The original input Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
        const client = scopes[0]!.client, { hostId: _route, ...read } = p
        const input = parseAgentInputChangesRead(read)
        if (client.forwardRpc) {
          const forwarded = await client.forwardRpc('agent.input.changes', { ...input, hostId: 'local' }, context)
          if (forwarded.hostId !== 'local') throw new AgentMuxError('The original input changes Host response changed.', 'CONTROL_PROTOCOL_ERROR')
          const { hostId: _sourceRoute, ...page } = forwarded
          result = { ...parseAgentInputChangesPage(page, input), hostId }
        } else result = { ...await client.readAgentInputChanges(input, caller ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined), hostId }
        break
      }
      case 'agent.input.ls': {
        const hostId = rpcString(p.hostId, 'Original input Host ID')
        if (caller && caller.hostId !== hostId || !caller && (!context.principal || !['user', 'device'].includes(context.principal.kind))) {
          throw new AgentMuxError('Input mailbox reading requires its original Host and an authenticated recipient or user/device.', 'CONTROL_PERMISSION_DENIED')
        }
        const scopes = (caller ? [caller] : await this.clients()).filter(scope => scope.hostId === hostId)
        if (scopes.length !== 1 || this.endpointUnverified(scopes[0]!.client)) throw new AgentMuxError('The original input Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
        const client = scopes[0]!.client, { hostId: _route, ...read } = p
        const input = parseAgentInputMailboxRead(read)
        result = await readRoutedInputMailbox({ ...input, hostId }, async sourceInput => {
          if (!client.forwardRpc) return await client.readAgentInputMailbox(sourceInput, caller ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined)
          const forwarded = await client.forwardRpc('agent.input.ls', { ...sourceInput, hostId: 'local' }, context)
          if (forwarded.hostId !== 'local') throw new AgentMuxError('The original mailbox Host response changed.', 'CONTROL_PROTOCOL_ERROR')
          const { hostId: _sourceRoute, ...page } = forwarded
          return page
        })
        break
      }
      case 'agent.input.resource': {
        const input = parseAgentInputResourceRead(p), { client } = await this.originalInputOwner(input.key.agentSessionId, caller)
        if (caller && caller.client !== client) throw new AgentMuxError('Input resources cannot cross semantic owners.', 'CONTROL_PERMISSION_DENIED')
        if (client.forwardRpc) return await client.forwardRpc('agent.input.resource', input, context) as AgentMuxRpcResult<M>
        result = await client.readAgentInputResource(input, caller ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined)
        break
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
        const input = await client.inspectAgentInput({ key }, caller ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined)
        const original = input ? input.admission : await client.inspectAgentPromptSubmission(key)
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
        let inputContext = this.inputCallContext(context)
        if (method === 'agent.input.rejoin') {
          const owner = await this.ports.hostedRuntime?.()
          // Only the same semantic owner can restore its retained external attribution.
          // Wire data and another endpoint never supply an authorization callback.
          if (owner?.client === scope.client) {
            const externalAuthor = await owner.externalAuthor?.({ method: 'rejoinAgentInputWaiting', args: [{ ref, ...author }] })
            if (externalAuthor) inputContext = { ...inputContext, externalAuthor }
          }
        }
        result = method === 'agent.input.stop' ? await scope.client.stopAgentInputWaiting({ ref, cancelOperationId: validateAgentInputControlId(p.cancelOperationId), ...author })
          : await scope.client.rejoinAgentInputWaiting({ ref, ...author }, inputContext)
        break
      }
      case 'agent.send': result = await this.send(p, caller, context); break
      case 'agent.broadcast': result = await this.broadcast(p, caller, context); break
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
        if (this.ports.callOriginalCore) return await this.ports.callOriginalCore('local', method, params, context)
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
  private async captureHeapSnapshot(input: import('./renderer-heap-snapshot.js').RendererHeapSnapshotInput, signal?: AbortSignal) {
    if (!this.ports.metrics?.captureHeapSnapshot) throw new AgentMuxError('Native heap capture is unavailable on the original metrics owner.', 'METRICS_UNSUPPORTED')
    return parseRendererHeapSnapshotResult(await this.ports.metrics.captureHeapSnapshot(input, signal), input)
  }
  private async inspectHeapSnapshot(input: import('./renderer-heap-snapshot.js').RendererHeapSnapshotInspectInput, signal?: AbortSignal) {
    if (!this.ports.metrics?.inspectHeapSnapshot) throw new AgentMuxError('Native heap inspection is unavailable on the original metrics owner.', 'METRICS_UNSUPPORTED')
    return parseRendererHeapSnapshotInspection(await this.ports.metrics.inspectHeapSnapshot(input, signal), input)
  }
  private async captureAllocations(input: import('./renderer-allocations.js').RendererAllocationsInput, signal?: AbortSignal) {
    if (!this.ports.metrics?.captureAllocations) throw new AgentMuxError('Allocation sampling is unavailable on the original metrics owner.', 'METRICS_UNSUPPORTED')
    return parseRendererAllocationsResult(await this.ports.metrics.captureAllocations(input, signal), input)
  }
  private async captureScene(input: import('./renderer-performance-scene.js').RendererSceneCaptureInput, signal?: AbortSignal) {
    if (!this.ports.metrics?.captureScene) throw new AgentMuxError('Scene capture is unavailable on the original metrics owner.', 'METRICS_UNSUPPORTED')
    return parseRendererSceneCaptureResult(await this.ports.metrics.captureScene(input, signal), input)
  }
  private async inspectScene(input: import('./renderer-performance-scene.js').RendererSceneInspectInput, signal?: AbortSignal) {
    if (!this.ports.metrics?.inspectScene) throw new AgentMuxError('Scene inspection is unavailable on the original metrics owner.', 'METRICS_UNSUPPORTED')
    return parseRendererSceneInspection(await this.ports.metrics.inspectScene(input, signal), input)
  }
  private async inspectAnimations(input: import('./renderer-animations.js').RendererAnimationsInput, signal?: AbortSignal) {
    if (!this.ports.metrics?.inspectAnimations) throw new AgentMuxError('Renderer animation observations are unavailable on the original metrics owner.', 'METRICS_UNSUPPORTED')
    return parseRendererAnimationsResult(await this.ports.metrics.inspectAnimations(input, signal), input)
  }
  private async inspectMemory(input: import('./renderer-memory.js').RendererMemoryInput, signal?: AbortSignal) {
    if (!this.ports.metrics?.inspectMemory) throw new AgentMuxError('Renderer memory details are unavailable on the original metrics owner.', 'METRICS_UNSUPPORTED')
    return parseRendererMemoryResult(await this.ports.metrics.inspectMemory(input, signal), input)
  }
  private async captureProfile(input: import('./renderer-v8-profile.js').RendererV8ProfileInput, signal?: AbortSignal) {
    if (!this.ports.metrics?.captureProfile) throw new AgentMuxError('Renderer profiling is unavailable on the original metrics owner.', 'METRICS_UNSUPPORTED')
    return parseRendererV8ProfileResult(await this.ports.metrics.captureProfile(input, signal), input)
  }
  private async captureTrace(input: import('./renderer-trace.js').RendererTraceInput, signal?: AbortSignal) {
    if (!this.ports.metrics?.captureTrace) throw new AgentMuxError('Renderer tracing is unavailable on the original metrics owner.', 'METRICS_UNSUPPORTED')
    return parseRendererTraceResult(await this.ports.metrics.captureTrace(input, signal), input)
  }
  private async inspectAppMemory(): Promise<import('./app-memory-evidence.js').AppMemoryEvidence> {
    if (!this.ports.metrics?.inspectAppMemory) throw new AgentMuxError('App memory evidence owner is unavailable.', 'METRICS_UNSUPPORTED')
    return parseAppMemoryEvidence(await this.ports.metrics.inspectAppMemory())
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
    return readAgentDiscovery(await this.clients(), parseAgentDiscoveryFilters(filters))
  }
  private async goals(filters: Record<string, unknown>): Promise<AgentMuxDemand[]> {
    rpcRecord(filters, [...NATIVE_FIELDS['goal.activity'], 'all'])
    if (filters.all !== undefined && filters.all !== true) throw new AgentMuxError('Complete Goal discovery requires all=true.', 'INVALID_CONTROL_REQUEST')
    if (filters.all === true && filters.limit !== undefined) throw new AgentMuxError('Choose complete Goal discovery or an explicit limit, not both.', 'INVALID_CONTROL_REQUEST')
    validateFilters(filters)
    const result = await this.execute(this.request('demand.list'))
    if (result.operation !== 'demand.list') throw new AgentMuxError('Goal list is mismatched.', 'CONTROL_PROTOCOL_ERROR')
    const goals = result.demands.filter(goal => (!filters.goalId || goal.id === filters.goalId) &&
      (!filters.projectId || goal.projectId === filters.projectId) &&
      (!filters.agentSessionId || goal.sessionIds.includes(String(filters.agentSessionId))) &&
      (!filters.assigneeSessionId || goal.assigneeSessionIds.includes(String(filters.assigneeSessionId))) &&
      (!filters.supervisorSessionId || goal.supervisorSessionId === filters.supervisorSessionId) &&
      (!filters.status || goal.status === filters.status) &&
      (filters.since === undefined || goal.updatedAt >= rpcCount(filters.since, 0)))
    return filters.all === true ? goals : goals.slice(0, rpcCount(filters.limit, 100, 1000))
  }
  /** The existing ingress Core journal retains only routing facts, never another envelope/body. */
  private async messageRouteJournal() {
    const local = (await this.clients()).filter(scope => scope.hostId === 'local')
    if (local.length > 1) throw new AgentMuxError('The original message ingress journal is ambiguous. No input was rerouted.', 'CONTROL_UNAVAILABLE')
    return new DurableAgentMuxMessageQueue(local.length === 1 ? local[0]!.client.agentMessageQueuePath() : undefined)
  }
  private async messageRouteOwner(route: AgentMessageRoute) {
    const scopes = (await this.clients()).filter(scope => scope.hostId === route.hostId)
    if (scopes.length !== 1 || !scopes[0]!.client.forwardRpc || this.endpointUnverified(scopes[0]!.client) ||
        route.runtimeId !== null && scopes[0]!.client.runtimeOwnerIdentity?.()?.runtimeId !== route.runtimeId) throw new AgentMuxError(
      'The original message Host is unavailable or changed. Keep this message and operation; no replacement owner received input.', 'CONTROL_UNAVAILABLE')
    return scopes[0]!
  }
  private async forwardMessageRoute(route: AgentMessageRoute, p: Record<string, unknown>,
    caller: Awaited<ReturnType<AgentMuxRpcService['authenticated']>>, context: AgentMuxRpcCallContext) {
    const owner = await this.messageRouteOwner(route)
    if (caller && caller.client !== owner.client) throw new AgentMuxError('Managed credentials cannot cross semantic Runtime owners.', 'AGENT_CAPABILITY_INVALID')
    return await owner.client.forwardRpc!('agent.send', { ...p, operationId: route.operationId, messageId: route.messageId,
      expectedRun: route.expectedRun, target: { kind: 'agent-session', agentSessionId: route.agentSessionId } } as AgentMuxRpcParams<'agent.send'>,
    await this.inputForwardContext(context))
  }
  private async broadcast(p: Record<string, unknown>, caller: Awaited<ReturnType<AgentMuxRpcService['authenticated']>>, context: AgentMuxRpcCallContext) {
    const owner = this.requireCaller(caller), input = normalizeBroadcastInput(p as unknown as import('./agent-message-broadcast.js').AgentMuxMessageBroadcastInput)
    const sourceDevice = this.ports.operationSource?.(context)
    return runAgentMessageBroadcast(input, { queue: new DurableAgentMuxMessageQueue(owner.client.agentMessageQueuePath()),
      ...(sourceDevice === undefined ? {} : { sourceDevice: normalizeOperationDevice(sourceDevice) }),
      authorize: async () => {
        context.signal?.throwIfAborted()
        await context.assertCurrent?.()
        const current = await owner.client.authorizeRetainedAgentCaller(owner.capability, owner.agentSessionId)
        return { hostId: owner.hostId, agentSessionId: current.agentSessionId, runId: current.run.runId }
      },
      resolve: async agentSessionId => {
        const target = await owner.client.readAgentSession(agentSessionId)
        if (!target || target.agentSessionId !== agentSessionId) throw new AgentMuxError('Broadcast requires a complete retained Session ID at the original owner.', 'UNKNOWN_AGENT_SESSION')
        if (target.hostId !== owner.session.hostId) throw new AgentMuxError('Managed broadcast authority cannot cross semantic owners.', 'CONTROL_PERMISSION_DENIED')
        return { hostId: owner.hostId, agentSessionId: target.agentSessionId, runId: target.run.runId }
      },
      send: async (intent, target) => this.send({ target: { kind: 'agent-session', agentSessionId: target.agentSessionId },
        text: intent.body, operationId: target.operationId, messageId: target.messageId,
        expectedRun: { runId: target.runId }, sourceChannel: intent.sourceChannel }, owner, context)
    })
  }

  private async send(p: Record<string, unknown>, caller: Awaited<ReturnType<AgentMuxRpcService['authenticated']>>, context: AgentMuxRpcCallContext) {
    const target = rpcRecord(p.target)
    const sourceChannel = normalizeMessageChannel(p.sourceChannel ?? 'api')
    const observedDevice = this.ports.operationSource?.(context)
    const sourceDevice = observedDevice === undefined ? undefined : normalizeOperationDevice(observedDevice)
    const operationId = rpcString(p.operationId, 'Operation ID'), text = rpcText(p.text, 'Message text')
    const addressed = p.admissionIntent === undefined ? undefined : validateAgentPromptAdmissionIntent(p.admissionIntent)
    if (addressed && (addressed.kind !== 'native-conversation' && addressed.kind !== 'session-conversation' || p.execution !== 'immediate')) throw new AgentMuxError('Conversation input requires its original directed intent and immediate execution.', 'INVALID_CONTROL_REQUEST')
    const expectedRun = p.expectedRun === undefined ? addressed?.expectedRun : {
      runId: rpcString(rpcRecord(p.expectedRun, ['runId']).runId, 'Expected recipient Run ID') }
    if (addressed && expectedRun?.runId !== addressed.expectedRun.runId) throw new AgentMuxError('The explicit source input Run conflicts with its caller fence.', 'MESSAGE_RECIPIENT_MISMATCH')
    const messageId = p.messageId === undefined ? 'message-' + createHash('sha256').update(operationId).digest('hex') : rpcString(p.messageId, 'Message ID')
    if (p.execution !== undefined && p.execution !== 'default' && p.execution !== 'immediate') throw new AgentMuxError('Prompt execution is invalid.', 'INVALID_CONTROL_REQUEST')
    const execution = p.execution ?? 'default'
    const threadId = p.threadId === undefined ? messageId : rpcString(p.threadId, 'Thread ID')
    const correlationId = p.correlationId === undefined ? messageId : rpcString(p.correlationId, 'Correlation ID')
    const replyTo = p.replyTo === undefined ? null : rpcString(p.replyTo, 'Reply message ID')
    const intentDigest = createHash('sha256').update(JSON.stringify({ text, execution, sourceChannel, sourceDevice,
      sender: caller ? { hostId: caller.hostId, agentSessionId: caller.agentSessionId, runId: caller.session.run.runId } : null,
      principal: caller ? null : context.principal ?? null,
      threadId, correlationId, replyTo,
      admissionIntent: addressed ?? null })).digest('hex')
    const routes = await this.messageRouteJournal()
    const routed = await routes.readMessageRoute(operationId, messageId)
    if (routed) {
      assertAgentMessageRouteIntent(routed, { messageId, intentDigest, target: target as AgentMuxRpcParams<'agent.send'>['target'] })
      if (expectedRun && expectedRun.runId !== routed.expectedRun.runId) throw new AgentMuxError('Expected Run conflicts with this original message route.', 'MESSAGE_RECIPIENT_MISMATCH')
      return await this.forwardMessageRoute(routed, p, caller, context)
    }
    // The retained operation belongs to the original local semantic endpoint.
    // It is checked before reading today's Tab/Region occupant, never by an
    // all-Host lookup. Remote ingress bindings above survive a lost first ACK.
    const local = (await this.clients()).filter(scope => scope.hostId === 'local')
    const journal = local.length === 1 && (!caller || caller.client === local[0]!.client)
      ? new DurableAgentMuxMessageQueue(local[0]!.client.agentMessageQueuePath()) : null
    const original = journal ? await journal.readByOperationId(operationId) ??
      (p.messageId === undefined ? null : await journal.readByMessageId(messageId)) : null
    if (expectedRun && original) {
      const originalRunId = original.envelope.recipientRunId ?? original.promptCondition?.expectedRun.runId ??
        (original.admissionIntent && original.admissionIntent.kind !== 'exact-condition' ? original.admissionIntent.expectedRun.runId : undefined)
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
    if (recipientOwner.client.forwardRpc || recipientOwner.hostId === 'local' && this.ports.callOriginalCore) {
      if (caller && caller.client !== recipientOwner.client) throw new AgentMuxError('Managed credentials cannot cross semantic Runtime owners.', 'AGENT_CAPABILITY_INVALID')
      // A local Hosted owner shares this journal. Its original first append is
      // already before input effects; a second ingress binding would loop when
      // that same Core receives it. Reuse that envelope on a lost-ACK retry.
      if (recipientOwner.hostId === 'local') {
        if (!original && expectedRun && expectedRun.runId !== recipientOwner.session.run.runId) throw new AgentMuxError('Expected Run does not match the original recipient.', 'MESSAGE_RECIPIENT_MISMATCH')
        const input: AgentMuxRpcParams<'agent.send'> = {
          ...p, text, operationId: original?.envelope.operationId ?? operationId, messageId: original?.envelope.messageId ?? messageId,
          ...(original ? original.envelope.recipientRunId ? { expectedRun: { runId: original.envelope.recipientRunId } } : {}
            : { expectedRun: { ...recipientOwner.session.run } }),
          target: { kind: 'agent-session', agentSessionId: recipientId }
        }
        const originalContext = await this.inputForwardContext(context)
        return this.ports.callOriginalCore
          ? await this.ports.callOriginalCore(recipientOwner.hostId, 'agent.send', input, originalContext)
          : await recipientOwner.client.forwardRpc!('agent.send', input, originalContext)
      }
      if (expectedRun && expectedRun.runId !== recipientOwner.session.run.runId) throw new AgentMuxError('Expected Run does not match the original recipient.', 'MESSAGE_RECIPIENT_MISMATCH')
      const route = await routes.claimMessageRoute({ operationId, messageId, hostId: recipientOwner.hostId,
        runtimeId: recipientOwner.client.runtimeOwnerIdentity?.()?.runtimeId ?? null,
        agentSessionId: recipientId, expectedRun: { ...recipientOwner.session.run },
        target: target as AgentMuxRpcParams<'agent.send'>['target'], intentDigest })
      if (expectedRun && expectedRun.runId !== route.expectedRun.runId) throw new AgentMuxError('Expected Run conflicts with the first concurrent message route.', 'MESSAGE_RECIPIENT_MISMATCH')
      return await this.forwardMessageRoute(route, p, caller, context)
    }
    const durable = await recipientOwner.client.readAgentSession(recipientId)
    if (!durable) throw new AgentMuxError('Recipient Session is no longer retained.', 'UNKNOWN_AGENT_SESSION')
    if (expectedRun && !original && durable.run.runId !== expectedRun.runId) throw new AgentMuxError(
      'Expected Run does not match the current retained recipient Run. No new message was saved or submitted.', 'MESSAGE_RECIPIENT_MISMATCH')
    const terminalManual = p.execution === 'immediate'
    const referenceIntake = Boolean(caller && (original ? original.deliveryMode === 'reference' : !terminalManual))
    if (referenceIntake && terminalManual) throw new AgentMuxError(
      'The original Inbox intake cannot be changed into direct input. Use message.notify for its retained references.',
      'AGENT_PROMPT_OPERATION_CONFLICT', undefined, { disposition: 'not_applied', confirmedInputBytes: 0 })
    const directIntent = addressed ?? { kind: 'manual-actor' as const, expectedRun: { ...durable.run } }
    if (original?.admissionIntent && addressed && !isDeepStrictEqual(original.admissionIntent, addressed)) throw new AgentMuxError('The original native target cannot be changed by a retry.', 'AGENT_PROMPT_OPERATION_CONFLICT')
    // A new direct producer saves its exact durable target before requiring a
    // Runtime connection. Catalog selects a contract, never Native readiness.
    const recipient = terminalManual || referenceIntake ? durable : await recipientOwner.client.refreshAgentSession(recipientId, durable.run)
    const queuePath = (caller?.client ?? recipientOwner.client).agentMessageQueuePath()
    if (original && queuePath !== local[0]!.client.agentMessageQueuePath()) throw new AgentMuxError('The original journal route changed; no input will follow another owner.', 'CONTROL_UNAVAILABLE')
    const envelope = { operationId, createdAt: Date.now(),
      sender: caller ? { kind: 'agent-session' as const, agentSessionId: caller.agentSessionId }
        : { kind: 'human' as const, principal: 'local-cli' as const },
      recipient: { kind: 'agent-session' as const, agentSessionId: recipientId },
      threadId, correlationId, replyTo, workspaceId: null,
      senderSessionId: caller?.agentSessionId ?? null, senderRunId: original ? original.envelope.senderRunId : caller?.session.run.runId ?? null,
      recipientSessionId: recipientId, recipientRunId: original ? original.envelope.recipientRunId : recipient.run.runId, body: text }
    // Both participant bindings came from their current Core owners. Public
    // inputs cannot supply sender or Run facts; rechecking a cached registry here
    // would reject a valid capability rotation or a recipient on another Host.
    // This direct producer has no caller after-condition. Only a new explicit
    // immediate current-terminal message gets manual actor intent before its first save.
    // The journal returns an existing record unchanged, including missing tags.
    if (referenceIntake) {
      await recipientOwner.client.submitAgentMessage({ agentSessionId: recipientId,
        envelope: { ...envelope, messageId, schema: 'agentmux.a2a.v1' }, execution: 'default', sourceChannel,
        ...(sourceDevice ? { sourceDevice } : {}), caller: { agentSessionId: caller!.agentSessionId, capability: caller!.capability } }, this.inputCallContext(context))
      const { input: _internal, ...saved } = await appendGlobalMessage({ ...envelope, messageId, execution: 'default', sourceChannel,
        ...(sourceDevice ? { sourceDevice } : {}) }, queuePath)
      return saved
    }
    const historical = terminalManual ? await recipientOwner.client.inspectAgentPromptSubmission({ kind: 'message', agentSessionId: recipientId,
      expectedRun: recipient.run, messageId }) : null
    if (terminalManual && !original && !historical) {
      // New manual intake is a Core capability, independent of presentation. The
      // same SDK owner serializes firstsave with Session input admission; a
      // Renderer roundtrip must not append a second producer before that owner.
      const inputReceipt = await recipientOwner.client.submitAgentMessage({ agentSessionId: recipientId,
        envelope: { ...envelope, messageId, schema: 'agentmux.a2a.v1' }, admissionIntent: directIntent, execution: 'immediate',
        sourceChannel, ...(sourceDevice ? { sourceDevice } : {}), ...(caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {}) }, this.inputCallContext(context))
      const { input: _internal, ...saved } = await appendGlobalMessage({ ...envelope, messageId, execution, sourceChannel,
        ...(sourceDevice ? { sourceDevice } : {}) }, queuePath, { admissionIntent: directIntent })
      const currentReceipt = inputReceipt ? await recipientOwner.client.inspectAgentInput({ key: inputReceipt.key },
        caller ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined) : undefined
      return { ...saved, ...(currentReceipt ? { inputReceipt: currentReceipt } : {}) }
    }
    const queued = await appendGlobalMessage({ ...envelope, messageId, execution, sourceChannel, ...(sourceDevice ? { sourceDevice } : {}) }, queuePath,
      { ...(terminalManual ? { admissionIntent: directIntent,
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
      if (originalIntent && originalIntent.kind === 'exact-condition') throw new AgentMuxError('The original direct message intent is unconfirmed.', 'AGENT_PROMPT_INPUT_UNCONFIRMED')
      const admission = originalIntent ? { admissionIntent: originalIntent } : { condition: promptCondition! }
      const inputReceipt = await recipientOwner.client.submitAgentMessage({
        agentSessionId: recipientId, envelope: queued.envelope, ...admission,
        execution, ...(queued.sourceChannel ? { sourceChannel: queued.sourceChannel } : {}), ...(queued.sourceDevice ? { sourceDevice: queued.sourceDevice } : {}),
        ...(caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {}) } as Parameters<AgentMuxClient['submitAgentMessage']>[0], this.inputCallContext(context))
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
        if (sessions.nextCursor !== null || sessions.retired.length > 0) observation.unavailable.push({
          source: 'sessions', code: 'AGENT_DISCOVERY_PARTIAL',
          message: 'This snapshot contains bounded current observations. Additional candidates or retired identities are available through agent.ls.',
          recovery: 'Read agent.ls with the same filters and follow nextCursor until null; retain retired and unavailableSessions separately.' })
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
    if (this.ports.forwardSubscription && (forwardOutput || method === 'browser.follow' || method === 'toolkit.watch' || method === 'system.metrics.watch' || method === 'settings.appearance.watch' && !this.ports.appearance || method === 'goal.watch' && !this.ports.goalChanges)) {
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
      if (method === 'connection.metadata.watch') {
        parseChannelMetadataParams(method, params)
        if (caller || !context.principal || !context.principal.id || !['user', 'device'].includes(context.principal.kind)) throw new AgentMuxError('Host metadata observation requires its original authenticated person or device.', 'CONTROL_PERMISSION_DENIED')
        const metadata = this.ports.connections?.metadata
        if (!metadata) throw new AgentMuxError('The original Channel metadata owner is unavailable. Saved profiles and healthy Agents are retained.', 'CONTROL_UNAVAILABLE')
        const assertCurrent = async () => { controller.signal.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context); controller.signal.throwIfAborted() }
        await assertCurrent()
        const failed = (error?: unknown) => { void emit(error ? { type: 'error', error: readerError(error) } : { type: 'end', data: {} }); void dispose().catch(() => {}) }
        const sub = await metadata.watch(change => {
          void assertCurrent().then(() => emit({ type: 'change', data: parseChannelMetadataChange(change) })).catch(failed)
        }, failed, { actor: { kind: context.principal.kind as 'user' | 'device', id: context.principal.id }, signal: controller.signal, assertCurrent })
        initial = {}; cleanup = () => sub.dispose()
      } else if (method === 'agent.conversation.watch') {
        const input = parseConversationWatchInput(params), forwarded = forwardConversationInput(input), owners = (await this.clients()).filter(entry => entry.hostId === input.hostId)
        if (owners.length !== 1) throw new AgentMuxError('The exact conversation Host is unavailable or ambiguous.', 'RUNTIME_UNAVAILABLE')
        // Hosted Clients delegate this same reader to the original semantic Host.
        const observer = await owners[0]!.client.observeConversation(forwarded.input, observation => {
          void Promise.resolve().then(() => emit({ type: 'snapshot', data: { ...observation, hostId: input.hostId } })).catch(dispose).catch(() => {})
        }, { signal: controller.signal })
        const ended = () => { void Promise.resolve().then(() => emit({ type: 'end', data: { reason: 'source-observation-released' } })).finally(dispose).catch(() => {}) }
        observer.closed?.addEventListener('abort', ended, { once: true })
        if (forwarded.sourceHostId && observer.sourceHostId !== forwarded.sourceHostId) { observer.dispose(); throw new AgentMuxError('The observation returned another original conversation Host.', 'CONTROL_PROTOCOL_ERROR') }
        initial = { hostId: input.hostId, agentSessionId: input.agentSessionId, sourceHostId: observer.sourceHostId, scope: observer.scope, coverage: observer.coverage }
        cleanup = () => { observer.closed?.removeEventListener('abort', ended); observer.dispose() }
        if (observer.closed?.aborted) ended()
      } else if (method === 'agent.output') {
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
      } else if (method === 'goal.watch') {
        rpcRecord(params, [])
        if (!this.ports.goalChanges) throw new AgentMuxError('The original Goal change owner is unavailable. Keep the last confirmed Goal and reconnect this reader.', 'CONTROL_UNAVAILABLE')
        const sub = await this.ports.goalChanges.subscribe(change => emit({ type: 'change', data: parseGoalChanges(change) }), error => emit(error ? { type: 'error', error: readerError(error) } : { type: 'end', data: {} }), controller.signal)
        cleanup = () => sub.dispose(); initial = parseGoalChanges(sub.initial)
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
