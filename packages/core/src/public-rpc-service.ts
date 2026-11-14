import { parseGoalInputEpochInput, parseGoalInputEpoch } from './goal-input-epoch.js'
import { parseCreationInspectParams, parseCreationResolveParams } from './agent-creation-resolution.js'
import { parseCreationInspection, parseCreationInspectionResult } from './agent-creation-inspection.js'
import { isStorageRecoveryMethod, parseStorageRecoveryParams, parseStorageRecoveryResult, type StorageRecoveryMethod, type StorageRecoveryPort, type StorageRecoveryExportsPort, type StorageRecoveryParamsMap } from './storage-recovery-rpc.js'
import { isCaptureSequenceMethod, parseCaptureSequenceParams, parseCaptureSequenceResult, type CaptureSequencePort, type CaptureSequenceMethod } from './capture-sequence.js'
import { FOCUS_METHODS, parseFocusParams, parseFocusResult, type FocusMethod } from './focus-control.js'
import { spatialDestination } from './spatial-destination.js'
import { parseAgentTakeoverProvenance, parseAgentTakeoverQuery, parseAgentTakeoverPage, takeoverDestinationOrganization, qualifyTakeoverOrganization, agentTakeoverNature, type AgentTakeoverPreparation, type AgentTakeoverRecord, type AgentTakeoverPage } from './agent-takeover.js'
import { SPACE_LINK_METHODS, formatSpaceLink, parseSpaceLinkParams, parseSpaceLinkResult, type SpaceLinkMethod } from './space-link.js'
import { isAgentPromotionMethod, parseAgentPromotionParams, parseAgentPromotionResult, type AgentPromotionPort, type AgentPromotionMethod } from './agent-promotion.js'
import { isMeshNetworkMethod, parseMeshNetworkParams, parseMeshNetworkResult, meshConfigurationNotApplied, type MeshNetworkPort, type MeshNetworkMethod } from './mesh-network.js'
import { isNameControlMethod, parseNameControlParams, parseNameControlResult, type NameControlParams } from './name-control.js'
import { parseAgentMuxRelayInspection, type AgentMuxRelayInspection } from './public-rpc-relay-gateway.js'
import { inspectOwnedName, changeOwnedName, sourceMemberName } from './name-control-owner.js'
import { AGENT_OPEN_LAUNCH_FIELDS, parseAgentOpenLaunchFields, parseAgentOpenDescribe, parseAgentOpenDescription } from './agent-open-contract.js'
import { parseTerminalCreationRetire, parseTerminalCreationInspect, parseTerminalCreationInspection } from './terminal-creation.js'
import { avatarActorIdentity, isObjectAvatarMethod, parseObjectAvatarParams, parseObjectAvatarResult, parseAvatarActor, type AvatarExecutionContext, type ObjectAvatarMethod, type ObjectAvatarPort } from './object-avatar.js'
import { SPACE_CLOSE_METHODS, parseSpaceCloseParams, parseSpaceCloseResult, type SpaceCloseMethod, type SpaceCloseActor } from './space-close.js'
import { parseFileMutationWatchParams, parseFileMutationWatchOpening, parseFileMutationEffect } from './public-rpc-file-mutations.js'
import { assertTailcatConfigurationWriter, parseTailcatConfigurationParams, parseTailcatConfigurationResult, type TailcatConfigurationMethod, type TailcatConfigurationPort } from './public-rpc-tailcat-configuration.js'
import { parseTerminalControl, parseTerminalControlResult, parseTerminalControlInspect, parseTerminalControlInspection } from './terminal-control.js'
import { parseFileStatParams, parseFileStatResult, parseFileMkdirParams, parseFileMkdirResult, parseFileMutationInspectParams, parseFileMutationInspectResult, parseFileMoveParams, parseFileMoveResult, parseFileDeleteParams, parseFileDeleteResult, parseFileDeleteSnapshotsParams, parseFileDeleteSnapshotsResult } from './public-rpc-file-path.js'
import { parseGoalActivityHistoryParams, pageGoalActivity } from './goal-activity-history.js'
import { parseNotesStorageParams, parseNotesStorageInspection, notesStorageOperationInspection, type NotesStorageMethod, type NotesStoragePort } from './public-rpc-notes-storage.js'
import { parseProviderCatalogQuery, parseProviderCatalogObservation, type ProviderCatalogMethod } from './public-rpc-provider-catalog.js'
import { parseSpaceMemberParams } from './space-member-codec.js'
import { SPACE_MEMBER_NATIVE_MAIL_CALLS } from './space-member.js'
import { parseMessageParticipantSelection } from './agent-message-query.js'
import { spaceMemberRuntime } from './space-member-runtime.js'
import { HOST_ROUTE_METHODS, parseHostRouteParams } from './host-route.js'
import { assertHostRouteDispatch, delegatedHostRouteActor, delegatedHostRouteMemberName, hostRouteActorScope, type HostRouteGateway, type VerifiedHostRouteDelegation } from './host-route-gateway.js'
import { parseFolderSpaceRegisterInput, parseFolderDirectoryInspectInput, folderResourceIdentity, type FolderSpaceResource } from './space-folder.js'
import { observeSpaceSessions } from './space-session-owner.js'
import { readSpaceSessionSources } from './space-session-sources.js'
import { createSpaceSessionObserver } from './space-session-client.js'
import { createHostedTransferQueue } from './hosted-runtime-service.js'
import { hostedTransfer } from './hosted-value.js'
import { spaceStreamOpening, spaceTransfer } from './space-authority-stream.js'
import { SpaceAuthorityOwner } from './space-authority-owner.js'
import { isSpaceAuthorityMethod, parseSpaceAuthorityParams, type SpaceApply, type SpaceWatch } from './space-authority.js'
import { locatePublishedNodes, parseNodeLocateParams, type NodeLocatorMethod } from './node-locator.js'
import { isNodePublishingMethod, parseNodePublishingParams, parseNodePublishingResult, type NodePublishingMethod, type NodePublishingPort } from './node-publishing.js'
import { sessionSemanticResumeSourceRuns } from './agent-session-resume-sources.js'
import { parseAgentSessionRecordInput, deletedAgentSessionRecord, parseAgentSessionRecordInspection, parseAgentSessionRecordReceipt, type AgentSessionRecordDeleteInput } from './agent-session-record.js'
import { parseAgentSessionUsageInput, parseAgentSessionUsagePage } from './agent-session-usage.js'
import { parseSignedMessage, parseMessageReadAuthority, parseFederatedThread, parseSignedDispatchEvent } from './agent-message-federation.js'
import { parseMessageApplication } from './agent-message-envelope.js'
import { parseConversationSnapshotInput, parseConversationSnapshotResult, type ConversationSnapshotInput, type ConversationSnapshotReleaseInput } from './conversation-snapshot.js'
import { isImageMethod, parseImageParams, parseImageResult, type AgentMuxRpcImageOwner, type ImageMethod, type ImageActor, type ImageCallContext } from './public-rpc-image.js'
import { agentPromptSubmissionOutcome } from './agent-input-wait.js'
import { moteMainHandoverInputId, moteMainBindingDefaults, spatialAgentOpenRecord, isSpatialAgentAssociation, spatialAgentAssociationRecord } from './spatial-agent-open-contract.js'
import { agentTakeoverPrompt } from './agent-takeover-context.js'
import { agentDerivedActionPrompt, isAgentBuiltInDerivedActionId, parseAgentDerivedActionFields } from './agent-derived-actions.js'
import { reconcileMoteMainSetup } from './mote/main-setup.js'
import { isMoteDialogueMethod, parseMoteDialogueParams, parseMoteDialogueResult, sameMoteMainEntrySource, unconfirmedMoteMainEntryOperation, type MoteDialoguePort, type MoteDialogueMethod } from './mote/dialogue.js'
import { moteInputObservationId } from './mote/input.js'
import { parseCreationContinueParams, parseCreationContinueReceipt, parseCreationContinueResult } from './agent-creation-continue.js'
import { parseAgentExecutionReference } from './errors.js'
import { AGENT_EXECUTION_CREATE_FIELDS, parseAgentExecutionCreate, parseAgentExecutionBinding, parseAgentExecutionBindingObservation } from './public-rpc-agent-execution.js'
import { parseAgentInputResourceRead } from './agent-input-resource.js'
import { isConnectionApiMethod, parseConnectionApiParams } from './connection-api-codec.js'
import { isHeadlessSpatialAgentOpen } from './spatial-agent-open-contract.js'
import { parseGoalParticipationConfirm } from './goal-participation.js'
import { parseGoalChanges, type GoalChangePort } from './goal-changes.js'
import { isAgentProgressMethod, parseAgentProgressParams, parseAgentProgressResult, type AgentProgressOwner, type AgentProgressMethod } from './agent-progress.js'
import { parseAgentAutomationTarget, parseAgentAutomationInspection } from './agent-automation.js'
import { isConnectionApplicationAccessMethod, parseConnectionApplicationAccessParams } from './connection-application-access-codec.js'
import { isConnectionCredentialMethod } from './connection-credential-codec.js'
import { isBrowserProfileProxySignInWrite } from './browser-profile-control.js'
import { isConnectionReceiverMethod, parseConnectionReceiverParams } from './connection-receiver-codec.js'
import { homedir } from 'node:os'
import { discoverAgentSkills } from './agent-skills.js'
import { isChannelMetadataMethod, parseChannelMetadataParams, parseChannelMetadataChange } from './channel-metadata-codec.js'
import { parseCapsuleInputRequest, parseCapsuleInputResult, type CapsuleInputPort } from './capsule-input.js'
import { isCapsuleRuntimeMethod, parseCapsuleRuntimeParams, parseCapsuleRuntimeResult, type CapsuleRuntimeMethod, type CapsuleRuntimePort } from './capsule-runtime.js'
import { isCapsuleMethod, parseCapsuleRpcParams, parseCapsuleRpcResult, type CapsuleCallContext, type CapsuleMethod, type CapsuleParamsMap, type CapsuleResultMap } from './capsule.js'
import { parseExternalConversationReference, parseExternalConversationReceipt } from './external-conversation.js'
import { isMoteChatMethod, parseMoteChatParams, parseMoteChatResult } from './mote/chat-codec.js'
import { isAgentLearningMethod, parseAgentLearningParams, parseAgentLearningResult,
  type AgentLearningPort, type AgentLearningMethod } from './agent-learning.js'
import type { MoteChatPort, MoteChatMethod, MoteChatParamsMap } from './mote/chat-contract.js'
import { isConnectionDeletionMethod, parseConnectionDeletionParams } from './connection-deletion-codec.js'
import { mintObjectId } from './object-id.js'
import { parseTerminalRecoveryInput, parseTerminalRecoveryResult } from './terminal-recovery.js'
import { isMobileAssetsMethod, parseMobileAssetsParams, parseMobileAssetsResult, parseMobileWebReportParams, parseMobileWebReportReceipt } from './mobile-web-codec.js'
import { readConnectionDiagnosis } from './connection-diagnosis.js'
import { parseFileImportParams, parseFileImportResult } from './public-rpc-file-import.js'
import { runAgentMessageBroadcast, normalizeBroadcastInput } from './agent-message-broadcast.js'
import { parseAgentInputContextCaptureReference, parseAgentInputContextCaptureRead, type AgentInputContextCaptureReader } from './agent-input-context-capture.js'
import { resolveAgentInputContextCapture } from './agent-input-context-capture-resolve.js'
import { parseFileShareParams, parseFileShareResult, parseFileShareInspectParams, parseFileShareInspectResult, parseFileShareUndoParams, parseFileShareUndoResult } from './public-rpc-file-share.js'
import { assertAgentConnectionAccess, readAgentConnectionDelivery, readAgentConnectionIngress, agentConnectionIngressAuthorization } from './connection-agent-access.js'
import { parseRendererAllocationsResult } from './renderer-allocations.js'
import { parseRendererSceneCaptureResult, parseRendererSceneInspection } from './renderer-performance-scene.js'
import { isApplicationAccessMethod, parseApplicationAccessParams, parseApplicationAccessResult, type ApplicationAccessPort, type ApplicationAccessMethod } from './application-access.js'
import { isDeepStrictEqual } from 'node:util'
import { isConnectionSetupMethod, parseConnectionSetupParams } from './connection-setup-codec.js'
import { parseAgentContinuityControlInput, parseAgentContinuityControlResult } from './agent-session-recovery/control-contract.js'
import { parseRuntimeV8ProfileInput, parseRuntimeV8ProfileResult, type HostV8ProfileInput } from './runtime-v8-profile.js'
import { parseRendererV8ProfileResult } from './renderer-v8-profile.js'
import { parseRendererCacheResult } from './renderer-cache.js'
import { parseRendererMemoryResult } from './renderer-memory.js'
import { parseRendererWorkerMemoryResult } from './renderer-worker-memory.js'
import { parseAppMemoryEvidence } from './app-memory-evidence.js'
import { parseRendererHeapSnapshotResult, parseRendererHeapSnapshotInspection } from './renderer-heap-snapshot.js'
import { parseRendererAnimationsResult } from './renderer-animations.js'
import { parseRendererTraceResult } from './renderer-trace.js'
import { ConversationLandmarkStore } from './conversation-landmark-store.js'
import { parseConversationLandmarkQuery, parseConversationLandmarkWrite } from './conversation-landmarks.js'
import { isConnectionServiceMethod, parseConnectionServiceParams } from './connection-service-codec.js'
import { isMoteConnectionMethod, parseMoteConnectionParams, parseMoteConnectionResult } from './mote/connection-codec.js'
import type { MoteConnectionPort, MoteConnectionMethod } from './mote/connection-contract.js'
import { parseMotePreferencesReadInput, parseMotePreferencesSaveParams, parseMotePreferencesReadResult, parseMotePreferencesSaveResult, type MoteQuickPreferencesPort, type MoteConnectionPreferencesPort, type MoteConnectionPreferencesReadInput, type MoteConnectionPreferencesSaveParams } from './mote/preferences.js'
import { isConnectionProfileMethod, parseConnectionProfileParams } from './connection-profile-codec.js'
import { isConnectionEnrollmentMethod, parseConnectionEnrollmentParams } from './connection-enrollment-codec.js'
import { isConnectionDeliveryMethod, parseConnectionDeliveryParams } from './connection-delivery-codec.js'
import { isRoomBindingMethod, parseRoomBindingParams } from './room-binding-codec.js'
import { isRoomProvisioningMethod, parseRoomProvisioningParams } from './room-provisioning-codec.js'
import { isRoomDiscoveryMethod, parseRoomDiscoveryParams } from './room-discovery-codec.js'
import { forwardConversationInput, readRoutedConversation } from './conversation-reader.js'
import { parseConversationViewReleaseInput, parseConversationViewReleaseResult, parseConversationWatchInput, parseConversationRef, parseConversationCheckpointInput, parseConversationCheckpointPage, parseConversationChangesInput, parseConversationChangesPageForWindow, parseConversationTimelineReadInput, parseConversationReadPageForWindow } from './conversation-changes.js'
import { createAgentMuxSearchReader, type AgentMuxSearchReadContext } from './search-reader.js'
import { createAgentMuxSearchObservationOwner } from './search-observation.js'
import { parseAgentMuxSearchInput } from './search-codec.js'
import { isConnectionMethod, parseConnectionParams, parseConnectionResult } from './connections-codec.js'
import type { ConnectionMethod, ConnectionPort } from './connections-contract.js'
import { isGoalDelegationMethod, parseGoalDelegationParams, parseGoalDelegationRpcResult, type GoalDelegationsOwner } from './goal-delegation.js'
import { isMoteAvatarWriteMethod, parseMoteAvatarWriteParams, parseMoteAvatarWriteResult, type AgentMuxRpcMoteAvatarsOwner, type MoteAvatarWriteMethod } from './mote/avatar-write.js'
import { parseAppearanceObservation, type AgentMuxAppearanceObservationPort } from './public-rpc-settings-observation.js'
import { isMoteAvatarSeriesMethod, parseMoteAvatarSeriesParams, parseMoteAvatarSeriesResult, type MoteAvatarSeriesMethod } from './mote/avatar-series.js'
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
import { isAppCaptureMethod, parseAppCaptureParams, parseAppCaptureResult, type AppCapturePort, type AppCaptureMethod } from './app-capture.js'
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
import { optionalInputEpoch, agentPromptCondition, agentPromptNotApplied, validateAgentPromptCondition, validateAgentPromptInputKey, validateAgentPromptAdmissionIntent } from './agent-prompt-condition.js'
import { AGENT_INPUT_SUBMIT_FIELDS, agentInputGuidance, parseAgentInputSubmit } from './agent-input-submit.js'
import { parseAgentInputChangesRead, parseAgentInputChangesPage } from './agent-input-changes.js'
import { parseAgentInputMailboxRead } from './agent-input-mailbox.js'
import { agentInputDeliveryKey, validateAgentInputControlId, validateAgentInputWaitRef, type AgentInputSubmissionReceipt, type AgentInputCallContext } from './agent-input-wait.js'
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
import { rpcControlRequest, rpcControlResult, parseRpcControlResult, assertControlResultTarget, rpcRecord, rpcString, rpcText, rpcCount } from './rpc-business-codec.js'
import { parseRpcNativeResult } from './rpc-native-codec.js'
import { parseNativeHistoryParams, parseNativeHistoryResult, parseNativeHistoryResourceParams, parseNativeHistoryResourceResult } from './public-rpc-native-history.js'
import { parseAgentRestartInput } from './agent-session-recovery/restart-contract.js'
import { parseAgentStopIdentity } from './agent-stop-receipt.js'
import { observeHostRuntime, parseTailcatListenerObservation } from './host-runtime-observation.js'
import { observeHostAgentResources } from './host-agent-resources.js'
import { observeRead } from './observation-read.js'
import { observeHostNetwork } from './host-network-observation.js'
import { isHostSettingsMethod, parseHostSettingsParams, parseHostSettingsResult, type HostSettingsMethod } from './public-rpc-host-settings.js'
import { AGENTMUX_TAILCAT_DEFAULT_KEYS, isTailcatKeyMethod, parseTailcatKeyParams, parseTailcatKeyResult } from './public-rpc-tailcat-key.js'
import { isHostMaintenanceMethod, parseHostMaintenanceParams, parseHostMaintenanceResult, type HostMaintenanceActor, type HostMaintenanceParamsMap } from './public-rpc-host-maintenance.js'
import { AGENTMUX_RPC_CONTROL_METHODS, AGENTMUX_RPC_NATIVE_METHODS, type AgentMuxRpcMethod,
  type AgentMuxRpcParams, type AgentMuxRpcResult, type AgentMuxRpcCredentials,
  type AgentMuxRpcSnapshotParams, type AgentMuxRpcSnapshot, type AgentMuxRpcStreamMethod,
  type AgentMuxRpcStreamInitial, type AgentMuxRpcStreamEvent, type AgentMuxRpcUnavailable, type AgentMuxRpcPrincipal } from './public-rpc.js'

/** A structural slice of the original public SDK; hosted clients need no private fields. */
import { parsePostureSet, parsePostureInspect, parsePostureSetResult, parsePostureInspection } from './agent-posture.js'
import { parseTerminalTarget, parseTerminalOutputParams, parseTerminalInspection, parseTerminalListParams, parseTerminalListResult } from './terminal-observation.js'

export type AgentMuxRpcCorePort = import('./agent-execution-coordinator.js').AgentExecutionHostPort & Pick<AgentMuxClient,
  'restartAgent' | 'inspectAgentRestart' | 'inspectAgentStop' | 'reopenAgent' | 'reconcileAgentReopen' | 'agentSessions' | 'readAgentMessageQueuePath' | 'readAgentInputEpoch' | 'readAgentSession' | 'readAgentSessions' | 'readAgentSessionHistory' | 'readAgentSessionUsage' | 'inspectAgentSessionRecord' | 'deleteAgentSessionRecord' | 'recordExternalConversationMessage' | 'readAgentConversation' | 'listConversationSnapshots' | 'releaseConversationSnapshot' | 'releaseConversationView' | 'observeConversation' | 'conversationCheckpoint' | 'readConversationChanges' | 'observeSessionHistory' | 'sessionHistorySources' | 'sessionHistoryPage' | 'sessionHistoryResource' | 'sessionTimeline' | 'authorizeRetainedAgentCaller' | 'agentMessageQueuePath' |
  'resolveAgentCreationSessionId' | 'inspectAgentCreation' | 'resolveAgentCreation' | 'continueAgentCreation' | 'recoverTerminal' | 'ensureAgentContinuity' | 'controlAgentContinuity' | 'agentSession' | 'refreshAgentSession' | 'confirmAgentNativeSession' | 'resolveAgentSession' | 'statusAgent' |
  'inspectAgentExecutionOperation' | 'inspectAgentInteractionOperation' | 'respondAgentInteraction' | 'observeAgentOutput' | 'replySessionQuestion' | 'submitAgentMessage' | 'notifyMessages' | 'inspectMessageNotification' | 'inspectAgentPromptSubmission' | 'readAgentInputActivity' | 'startDiscussion' | 'checkDeliveries' |
  'submitAgentPrompt' | 'readAgentInputMailbox' | 'readAgentInputChanges' | 'inspectAgentInput' | 'inspectMoteInput' | 'readAgentInputResource' | 'stopAgentInputWaiting' | 'rejoinAgentInputWaiting' | 'listAgentSpawns' |
  'ackDeliveryBatch' | 'openDispatch' | 'showDispatch' | 'readMessage' | 'listMessages' | 'listMessageEvents' | 'inspectMessageBroadcast' | 'readDispatch' | 'listDispatches' | 'recordDispatchEvent' |
  'catalog' | 'connect' | 'inspectManagedHooks' | 'probeAgent' | 'probeExecutorAvailability' | 'listHostNativeAgentSessions' | 'readHostNativeAgentHistory' | 'readHostNativeAgentHistoryResource' |
  'readDeliveryAttempt' | 'readReadingDiagnostic' | 'findReadingDiagnostics' | 'readAgentStartupDiagnostic' | 'findAgentStartupDiagnostics' | 'observeRunStorage' | 'runtimeDiagnostics' | 'runtimeResourceSnapshot' | 'runtimeIdentity' | 'agentCreationAuthority' | 'listTrustedCreationSources' | 'trustCreationSource' | 'agentMessageAuthority' | 'listTrustedMessageSources' | 'trustMessageSource' | 'prepareFederatedMessage' | 'intakeFederatedMessage' | 'prepareFederatedRead' | 'exportFederatedThread' | 'readFederatedOutbox' | 'recordFederatedDispatchEvent' | 'intakeFederatedDispatchEvent' | 'recordFederatedInboxReceipt' | 'listHostExecutors' | 'configureHostExecutor' | 'removeHostExecutor' | 'hostEnvironment'> & {
    stopAgent?: AgentMuxClient['stopAgent']
    controlTerminal?: AgentMuxClient['controlTerminal']
    inspectTerminalControl?: AgentMuxClient['inspectTerminalControl']
    retireTerminalCreation?: AgentMuxClient['retireTerminalCreation']
    inspectTerminalCreation?: AgentMuxClient['inspectTerminalCreation']
    inspectAgentPosture?: AgentMuxClient['inspectAgentPosture']
    setAgentPosture?: AgentMuxClient['setAgentPosture']
    listTerminals?: AgentMuxClient['listTerminals']
    inspectTerminal?: AgentMuxClient['inspectTerminal']
    observeTerminalOutput?: AgentMuxClient['observeTerminalOutput']
    runtimeOwnerIdentity?: import('./hosted-client-contract.js').AgentMuxHostedClient['runtimeOwnerIdentity']
    readRuntimeOwnerIdentity?: import('./hosted-client-contract.js').AgentMuxHostedClient['readRuntimeOwnerIdentity']
    remoteTransportObservation?: import('./hosted-client-contract.js').AgentMuxHostedClient['remoteTransportObservation']
    agentSessionResourceSnapshot?: AgentMuxClient['agentSessionResourceSnapshot']
    runningSavedAgentResourceSnapshot?: AgentMuxClient['runningSavedAgentResourceSnapshot']
    forwardRpc?: import('./hosted-client-contract.js').AgentMuxHostedForwardRpc
    subscribeRpc?: import('./hosted-client-contract.js').AgentMuxHostedSubscribeRpc
    handOff(...args: Parameters<AgentMuxClient['handOff']>):
      Awaited<ReturnType<AgentMuxClient['handOff']>> | Promise<Awaited<ReturnType<AgentMuxClient['handOff']>>>
  }
export type AgentMuxRpcCoreClient = { hostId: string; client: AgentMuxRpcCorePort }
type BorrowedHostedRuntime = Pick<AgentMuxHostedRuntimeService, 'call' | 'subscribe' | 'assertFence'> & Partial<Pick<AgentMuxHostedRuntimeService, 'client' | 'externalAuthor'>>
export type AgentMuxRpcServiceOptions = Omit<Partial<AgentMuxControlHost>, 'execute'> & {
  hostRoutes?: HostRouteGateway;
  /** Exact capabilities composed by a specialized host; absence preserves the normal complete service. */
  exposedMethods?: ReadonlySet<AgentMuxRpcMethod>
  execute?(request: AgentMuxControlRequest, nameContext?: AgentMuxNameContext,
    originalContext?: AgentMuxRpcCallContext): Promise<AgentMuxControlResult>
  /** Borrow the original UI-free Capsule owner; no content or configuration is stored here. */
  capsules?: { call<M extends CapsuleMethod>(method: M, params: CapsuleParamsMap[M], context?: CapsuleCallContext,
    originalContext?: AgentMuxRpcCallContext): Promise<CapsuleResultMap[M]> }
  executionBindings?: Pick<import('./agent-execution-coordinator.js').AgentExecutionCoordinator, 'create' | 'rejoin' | 'continueOriginal'> & {
    inspect(bindingId: string, view?: 'association', context?: AgentMuxRpcCallContext): import('./agent-execution-coordinator.js').AgentExecutionInspection | null | Promise<import('./agent-execution-coordinator.js').AgentExecutionInspection | null>
    sourceDiagnostics?: import('./agent-execution-coordinator.js').AgentExecutionBindingService['sourceDiagnostics']
    admit?: import('./agent-execution-coordinator.js').AgentExecutionBindingService['admit']
    watch?: import('./agent-execution-coordinator.js').AgentExecutionBindingService['watch']
  }
  capsuleInput?: CapsuleInputPort
  capsuleRuntime?: CapsuleRuntimePort
  inputContextCaptures?: AgentInputContextCaptureReader
  applicationAccess?: ApplicationAccessPort
  windows?: AgentMuxRpcWindowsOwner
  sequences?: CaptureSequencePort
  captures?: AppCapturePort
  moteDialogue?: MoteDialoguePort
  moteChat?: MoteChatPort
  /** Host-owned learning workflow; Core neither stores nor interprets its knowledge. */
  agentLearning?: AgentLearningPort
  moteConnections?: MoteConnectionPort
  moteQuickPreferences?: MoteQuickPreferencesPort
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
  storageRecovery?: StorageRecoveryPort
  storageRecoveryExports?: StorageRecoveryExportsPort
  notesStorage?: NotesStoragePort
  notebookStore?: AgentMuxNotebookStore
  notebookObservation?: NotebookObservationPort
  files?: AgentMuxRpcFilesOwner
  git?: AgentMuxRpcGitOwner
  fileUploads?: AgentMuxRpcFileUploadsOwner
  objectAvatars?: ObjectAvatarPort
  moteAvatars?: AgentMuxRpcMoteAvatarsOwner
  agentPromotions?: AgentPromotionPort
  topics?: AgentMuxRpcTopicsOwner

  appearance?: AgentMuxAppearanceObservationPort
  /** Original Host resource reads; editable application settings keep their existing owner. */
  settingsResources?(request: Extract<import('./control.js').AgentMuxControlSettingsResourceRequest,
    { operation: 'settings.resource.list' | 'settings.resource.get' }>): Promise<import('./control.js').AgentMuxControlSettingsResourceResult>
  goalInputEpoch?(input: import('./goal-input-epoch.js').GoalInputEpochInput, context: AgentMuxRpcCallContext): Promise<import('./goal-input-epoch.js').GoalInputEpoch>
  goalParticipation?: import('./goal-participation.js').GoalParticipationOwner
  goalChanges?: GoalChangePort
  progress?: AgentProgressOwner
  schedules?: AgentMuxRpcSchedulesOwner
  automaticInput?: import('./agent-automation.js').AgentAutomationOwner
  /** Original portable Goal business owner; screen focus remains a client capability. */
  goalControl?(request: AgentMuxControlRequest, context?: AgentMuxNameContext,
    originalContext?: AgentMuxRpcCallContext): Promise<AgentMuxControlResult | undefined>
  nativeDesktop?: AgentMuxRpcNativeDesktopOwner
  images?: AgentMuxRpcImageOwner
  spatialState?: AgentMuxSpatialStateStore
  /** Original configuration reader; callers cannot supply another path or Host here. */
  spatialFolderResource?(workspaceId: string): Promise<FolderSpaceResource>
  spatialFolderDirectory?: {
    inspect(input: import('./space-folder.js').FolderDirectoryInspectInput, source: import('./space-authority.js').SpaceAuthoritySource, context: AgentMuxRpcCallContext): Promise<import('./space-folder.js').FolderDirectoryInspection>
    register(input: import('./space-folder.js').FolderDirectoryRegistration, source: import('./space-authority.js').SpaceAuthoritySource, context: AgentMuxRpcCallContext): Promise<import('./space-folder.js').FolderSpaceReceipt>
  }
  /** Original Host policy over Core-owned spatial creation associations, without a screen. */
  spatialAgentControl?: ((request: AgentMuxControlRequest, context: AgentMuxRpcCallContext) => Promise<AgentMuxControlResult | undefined>) & {
    describe?(): import('./agent-open-contract.js').AgentOpenContracts
    describeExecution?(input: import('./agent-open-contract.js').AgentOpenExecutionSelector, context: AgentMuxRpcCallContext): Promise<import('./agent-open-contract.js').AgentOpenExecutionDescription>
  }
  /** Read only original host metadata; topology and execution remain with their Core owners. */
  spatialPresentation?(input: { graph: import('./spatial-graph.js').AgentMuxSpatialGraph;
    catalog: import('./space-control.js').AgentMuxSpaceCatalog; target: import('./space-control.js').AgentMuxSpaceSelector;
    presentation?: import('./space-control.js').AgentMuxSpacePresentationSelection; imageSpaceId?: string },
    context: AgentMuxRpcCallContext): Promise<Pick<import('./space-control.js').AgentMuxSpaceCatalog,
      'agentPresentation' | 'motePresentation' | 'appearance' | 'survey'>>
  /** Optional host aggregation of original named owners; Core interprets no host target kinds. */
  nameHistory?(query: import('./display-label.js').AgentMuxNameHistoryQuery): Promise<import('./display-label.js').AgentMuxNameHistoryPage>
  /** Borrow the original Host configuration owner; no configuration is stored by this service. */
  hostConfiguration?(hostId: string): import('./control.js').AgentMuxControlSettingsResourceFields | null
  /** Read the selected Host's original listener owner. Missing observation remains unknown. */
  hostTailcat?(hostId: string, signal?: AbortSignal): import('./host-runtime-observation.js').TailcatListenerObservation | undefined | Promise<import('./host-runtime-observation.js').TailcatListenerObservation | undefined>
  /** Original configuration owner's exact maintenance requests; this grants no standing Agent authority. */
  spaceClose?: import('./space-close.js').SpaceClosePort
  hostMaintenance?: import('./public-rpc-host-maintenance.js').HostMaintenanceAdministration
  /** The answering App’s original ConfigOwner; Host listener adoption stays with the Host. */
  tailcatConfiguration?: TailcatConfigurationPort
  /** This Host's own saved-key owner: create only a missing key through the official CLI, never overwrite. */
  hostTailcatKey?(input: { role: import('./public-rpc-tailcat-key.js').TailcatKeyRole; key: string }, signal?: AbortSignal): Promise<import('./public-rpc-tailcat-key.js').TailcatKeyPreparation>
  endpoint?: import('./public-rpc.js').AgentMuxRpcEndpoint
  endpointPublication?(): import('./control-endpoint-state.js').AgentMuxControlEndpointState
  /** Passive facts from this original Core's optional Relay gateway transport owner. */
  relayInspection?(): AgentMuxRelayInspection
  /** Borrow existing SDK clients. Their lifecycle remains with their host. */
  meshNetwork?: MeshNetworkPort
  nodePublishing?: NodePublishingPort
  /** Complete configured locator scope, including routes without a prepared client. Never starts a client. */
  nodeLocatorHosts?(): readonly string[] | Promise<readonly string[]>
  /** Omitted selector reads the existing cache; a qualified owner may join exact Host initialization. The selector grants no authority. */
  coreClients?(hostId?: string, read?: { signal?: AbortSignal | undefined }): readonly AgentMuxRpcCoreClient[] | Promise<readonly AgentMuxRpcCoreClient[]>
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
export type AgentMuxRpcCallContext = {
  /** Original Core-qualified Takeover preparation; never accepted in RPC parameters. */
  agentTakeover?: { requestId: string; requestDigest: string; preparation: AgentTakeoverPreparation; prompt: string };
  routeDelegation?: VerifiedHostRouteDelegation; caller?: AgentMuxRpcCredentials; signal?: AbortSignal; principal?: AgentMuxRpcPrincipal;
  /** Optional pre-admission read-opening lifetime. Never substitutes for the business operation signal. */
  openingSignal?: AbortSignal;
  /** In-process transport capability. Never decoded from business arguments. */
  forwarding?: import('./rpc-forwarding.js').RpcForwardingSource;
  /** Exact receiving wire ID for response capacity; never supplied by business params. */
  responseId?: JSONRPCID;
  /** Only the actual Host/transport supplies this current author restriction. */
  assertCurrent?(): void | Promise<void>;
  /** Gateway-supplied in-process custody for this exact durable input; never wire data. */
  retainAcceptedInputAuthority?: import('./agent-input-wait.js').AgentInputCallContext['retainAcceptedInputAuthority'];
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
  'space.member.name.inspect': ['target', 'object', 'operationId'], 'space.member.name.change': ['target', 'object', 'change'],
  'agent.name.inspect': ['runtimeId', 'agentSessionId', 'createOperationId', 'operationId'], 'agent.name.change': ['runtimeId', 'agentSessionId', 'createOperationId', 'change'],
  'space.close.ls': ['limit', 'cursor'],
  'space.close.prepare': ['operationId', 'target', 'keepAgentSessions'], 'space.close.apply': ['operationId', 'expectedPlanDigest', 'decisions'], 'space.close.inspect': ['operationId'],
  'capture.sequence.open': ['hostId', 'operationId', 'mode'], 'capture.sequence.inspect': ['hostId', 'operationId'], 'capture.sequence.stop': ['hostId', 'operationId'], 'capture.sequence.read': ['hostId', 'operationId', 'offsetBytes', 'maxBytes'],
  'app.capture': ['target'], 'app.record.start': ['operationId', 'target', 'durationMs', 'fps'],
  'app.record.inspect': ['operationId'], 'app.record.stop': ['operationId'], 'app.record.read': ['operationId'],
  'system.metrics.host-profile.capture': ['hostId', 'fence', 'processId', 'durationMs'],
  'goal.delegation.prepare': ['goalId', 'intent', 'materials'], 'goal.delegation.bind': ['goalId', 'intent'], 'goal.delegate': ['goalId', 'intent', 'materials'],
  'goal.report': ['goalId', 'operationId', 'sourceMessageId', 'report'], 'goal.collect': ['goalId', 'operationId', 'collection'], 'goal.delegations': ['goalId'],
  'goal.progress': ['goalId', 'progress'],
  'goal.patrol': ['goalId', 'operationId'],
  'goal.patrol.continue': ['goalId', 'patrolOperationId', 'operationId', 'expectedRunId'],
  'goal.patrol.report': ['goalId', 'patrolOperationId', 'report'],
  'goal.plan': ['goalId'], 'goal.plan.revise': ['goalId', 'revision'], 'goal.plan.review': ['goalId', 'review'],
  'goal.participation.confirm': ['goalId','creationOperationId','hostId','agentSessionId','expectedRun','evidence','operationId'],
  'goal.watch': [],
  'settings.appearance.watch': [],
  'notebook.scan': ['workspaceId','path','maxFiles','maxDirectories','maxBytes','query','limit'],
  'notebook.ls': [], 'notebook.inspect': ['notebookId','noteId','operationId','content','maxBytes'], 'notebook.graph': ['notebookId','noteId','maxBytes'], 'notebook.resolve': ['mode','query','limit','text','select','maxBytes'], 'notebook.apply': ['expectedRevision','operationId','change'],
  'space.folder.register': ['runtimeId','workspaceId','expectedResource','directory'],
  'space.folder.inspect': ['runtimeId','path','expectedResource'],
  'goal.input.epoch': ['agentReference','access'],
  'agent.open.describe': ['expectedRuntimeId','execution','executionOnly'],
  'space.member.call': ['target','call'], 'space.member.watch': ['target','call'],
  'space.sessions.watch': ['reference'],
  'space.link.ensure': ['target','operationId'], 'space.link.resolve': ['address'],
  'space.snapshot': ['reference'], 'space.apply': ['reference','expectedRevision','changes'], 'space.watch': ['reference','after'],
  'space.state': [], 'space.commit': ['expectedRevision','graph','allowEntityRemoval','removedProjectGroupIds'],
  'space.resolve': ['tabId','regionId','direction'],
  'name.history': ['target','afterId','limit'],
  'name.confirm': ['operationId'],
  whoami: [], 'agent.ls': ['agentSessionId', 'executorId', 'providerId', 'status', 'semantic', 'readiness', 'since', 'activitySince', 'cursor', 'limit'],
  'agent.inspect': ['target'],
  'agent.creation.inspect': ['hostId', 'createOperationId', 'agentSessionId'],
  'agent.creation.resolve': ['hostId', 'createOperationId', 'agentSessionId', 'operationId'],
  'agent.creation.continue': ['hostId', 'createOperationId', 'agentSessionId'],
  'agent.execution.inspect': ['hostId', 'bindingId', 'streamGeneration', 'nativeRequestId'],
  'agent.execution.admit': AGENT_EXECUTION_CREATE_FIELDS,
  'agent.execution.create': AGENT_EXECUTION_CREATE_FIELDS,
  'agent.execution.continue': ['bindingId', 'agentSessionId', 'createOperationId'],
  'agent.execution.binding': ['bindingId','view'],
  'agent.execution.watch': ['bindingId'],
  'agent.execution.rejoin': ['bindingId'],
  'terminal.input': ['target', 'operationId', 'ownerInstanceId', 'expectedByte', 'dataBase64'], 'terminal.interrupt': ['target', 'operationId', 'ownerInstanceId'], 'terminal.stop': ['target', 'operationId', 'ownerInstanceId'], 'terminal.operation.inspect': ['hostId', 'run', 'operationId', 'runtimeId'],
  'agent.posture.set': ['target', 'operationId', 'controlId', 'modeId', 'expectedControlDigest'], 'agent.posture.inspect': ['hostId', 'agentSessionId', 'expectedRun', 'operationId'],
  'terminal.creation.retire': ['hostId', 'operationId', 'runtimeId'],
  'terminal.creation.inspect': ['hostId', 'operationId', 'runtimeId'],
  'terminal.ls': ['hostId', 'cursor', 'limit'], 'terminal.inspect': ['target'], 'terminal.output': ['target', 'afterByte', 'follow'],
  'terminal.recover': ['hostId', 'expectedRun', 'runtimeId', 'workspacePath', 'operationId', 'action'],
  'skill.ls': ['hostId', 'agentSessionId'],
  'agent.continuity.control': ['agentSessionId', 'intentOperationId', 'expectedRun', 'operationId', 'action', 'additionalAttempts'],
  'agent.restart': ['agentSessionId', 'expectedRun', 'operationId'],
  'agent.restart.inspect': ['agentSessionId', 'expectedRun', 'operationId'],
  'agent.stop.inspect': ['agentSessionId', 'expectedRun', 'operationId'],
  'agent.refresh': ['agentSessionId'],
  'agent.native.confirm': ['agentSessionId', 'expectedRun', 'expectedNativeHandle', 'candidateNativeHandle', 'expectedObservationAt', 'operationId'],
  'agent.native.ls': ['hostId', 'executorId', 'workspacePath'],
  'agent.native.history': ['hostId', 'executorId', 'source', 'cursor', 'limit'],
  'agent.native.history.resource': ['hostId', 'executorId', 'nativeSource', 'source', 'turnId', 'recordId', 'partIndex', 'expectedReference', 'maxBytes', 'offsetBytes', 'representation'],
  'agent.context': ['hostId', 'agentSessionId', 'cursor', 'limit'],
  'agent.interaction.respond': ['agentSessionId', 'expectedRun', 'operationId', 'expectedRequest', 'response', 'externalAction', 'moteSource'],
  'agent.interaction.inspect': ['agentSessionId', 'operationId'],
  'agent.question.reply': ['agentSessionId', 'source', 'turnId', 'recordId', 'answers', 'operationId', 'expectedRun', 'afterSubmissionId', 'inputEpoch', 'allowUncertainTurn', 'sourceChannel', 'externalAction', 'moteSource'],
  'agent.history.resource': ['hostId', 'agentSessionId', 'source', 'turnId', 'recordId', 'partIndex', 'expectedReference', 'maxBytes', 'offsetBytes', 'representation'],
  'agent.conversation.record': ['hostId', 'agentSessionId', 'ingressId', 'authoritySource'],
  'agent.conversation.snapshot.ls': ['hostId', 'agentSessionId', 'source', 'after', 'limit'],
  'agent.conversation.snapshot.release': ['hostId', 'agentSessionId', 'source', 'reference'],
  'agent.conversation.checkpoint': ['hostId', 'agentSessionId', 'nativePosition', 'nativeSnapshot', 'nativeSource'],
  'agent.conversation.changes': ['hostId', 'agentSessionId', 'checkpoint', 'through', 'recover', 'limit', 'cursor', 'maxBytes', 'view'],
  'agent.conversation.release': ['hostId', 'agentSessionId', 'view'],
  'agent.conversation.watch': ['hostId', 'agentSessionId', 'view'],
  'agent.conversation.inspect': ['hostId', 'agentSessionId', 'limit', 'cursor', 'maxBytes', 'record', 'anchor', 'view', 'nativeSource', 'preserveCurrent'],
  'agent.conversation.landmark.ls': ['hostId', 'agentSessionId', 'operationId'],
  'agent.conversation.landmark.apply': ['hostId', 'agentSessionId', 'operationId', 'expectedRevision', 'change'],
  'agent.history.usage': ['hostId', 'agentSessionId', 'cursor', 'limit'],
  'agent.history.record.inspect': ['hostId', 'agentSessionId', 'operationId'],
  'agent.history.record.delete': ['hostId', 'agentSessionId', 'operationId', 'expectedRetiredAt', 'expectedRetirementRevision', 'continue'],
  'agent.history': ['hostId', 'agentSessionId', 'source', 'limit', 'cursor', 'maxBytes', 'kind', 'query', 'scanLimit'],
  'agent.reopen': ['agentSessionId', 'expectedRetiredAt', 'operationId', 'args', 'env', 'commandOverride', 'launchOptions', 'cols', 'rows'], 'agent.reopen.check': ['agentSessionId', 'expectedRetiredAt', 'operationId'], 'agent.role.ls': ['workspacePath'],
  'agent.role.register': ['role', 'providerId'], 'agent.role.resolve': ['role', 'workspacePath'],
  'agent.input.changes': ['hostId', 'agentSessionId', 'limit', 'cursor', 'after'],
  'agent.input.epoch': ['hostId'],
  'agent.input.ls': ['hostId', 'agentSessionId', 'limit', 'cursor', 'maxBytes'],
  'agent.input.submit': AGENT_INPUT_SUBMIT_FIELDS,
  'agent.progress.list': ['target','operationId'],
  'agent.progress.create': ['inputEpoch','target','intervalMs','prompt','taskSource','operationId'],
  'agent.progress.action': ['target','loopId','action','expectedLoop','operationId'],
  'agent.progress.update': ['target','loopId','expectedLoop','intervalMs','prompt','operationId'],
  'agent.automation.pause': ['agentSessionId', 'expectedRun', 'ownerInstanceId', 'operationId'],
  'agent.automation.inspect': ['agentSessionId', 'expectedRun', 'ownerInstanceId', 'operationId'],
  'browser.input.inspect': ['hostId', 'operationId'],
  'agent.input.resource': ['key', 'index', 'revision', 'maxBytes', 'purpose'],
  'agent.input.inspect': ['key', 'kind', 'originalControlOperationId', 'activity'],
  'agent.input.observation': ['agentSessionId','observationId'],
  'agent.input.stop': ['ref', 'cancelOperationId'], 'agent.input.rejoin': ['ref'],
  'agent.send': ['recipientInputEpoch', 'target', 'text', 'messageId', 'threadId', 'correlationId', 'replyTo', 'operationId', 'execution', 'expectedRun', 'sourceChannel', 'admissionIntent', 'application'],
  'agent.broadcast': ['recipientInputEpochs','operationId', 'recipientSessionIds', 'text', 'sourceChannel'],
  'agent.broadcast.inspect': ['operationId', 'hostId'],
  'agent.discuss': ['executorId', 'providerId', 'text', 'operationId'],
  'agent.takeover.ls': ['expectedRuntimeId', 'direction', 'subject', 'cursor', 'limit'],
  'agent.spawn.ls': ['hostId', 'participantSessionId', 'direction', 'creatorRuntimeId', 'cursor', 'limit'],
  'agent.handoff': ['toAgentSessionId', 'taskId'], 'agent.output': ['agentSessionId', 'afterByte', 'follow'],
  'system.diagnostics.inspect': ['target', 'includeRaw', 'includeRelated', 'budget'],
  'app.mobile.assets.inspect': ['hostId', 'operationId', 'client'],
  'app.mobile.assets.activate': ['hostId', 'operationId', 'candidatePath', 'candidateDigest', 'expectedActiveRevision'],
  'app.mobile.assets.loaded': ['documentId', 'buildId', 'namespaceDigest', 'occurrenceId', 'observedAt'],
  'app.mobile.report': ['documentId', 'buildId', 'namespaceDigest', 'occurrenceId', 'observedAt', 'observation', 'reporter'],
  'message.delivery.inspect': ['logId', 'hostId'], 'message.delivery.report': ['hostId', 'record'],
  'message.inbox.check': ['limit'], 'message.inbox.ack': ['generation', 'readerRun'],
  'message.notify': ['operationId', 'messageIds', 'hostId','inputEpoch'],
  'message.notify.inspect': ['operationId', 'hostId'],
  'message.read': ['operationId', 'messageId', 'notificationId', 'field', 'cursor', 'maxBytes', 'hostId', 'participantSessionId', 'participantRuntimeId'],
  'message.ls': ['hostId', 'participantSessionId', 'participantRuntimeId', 'direction', 'beforeSequence', 'limit'],
  'message.events': ['hostId', 'participantSessionId', 'afterSequence', 'latest', 'beforeSequence', 'throughSequence', 'incarnation', 'messageId', 'broadcastOperationId', 'limit'],
  'message.federation.dispatch-intake': ['event'],
  'message.federation.intake': ['packet'],
  'message.federation.export': ['authority'],
  'message.dispatch.sync': ['sourceMessageId', 'hostId'],
  'message.dispatch.open': ['sourceMessageId'], 'message.dispatch.inspect': ['sourceMessageId'],
  'message.dispatch.read': ['sourceMessageId', 'hostId', 'participantSessionId', 'participantRuntimeId'],
  'message.dispatch.ls': ['hostId', 'participantSessionId', 'participantRuntimeId', 'afterSourceMessageId', 'limit'],
  'message.dispatch.report': ['sourceMessageId', 'replyMessageId', 'kind'],
  'app.search': ['mode', 'query', 'hostId', 'agentSessionId', 'source', 'limit', 'scanLimit', 'maxBytes', 'cursor'],
  'app.snapshot': ['projectId', 'workspaceId', 'topicId', 'agentSessionId', 'goalId', 'executorId', 'assigneeSessionId', 'supervisorSessionId', 'status', 'since', 'limit', 'include'],
  'goal.activity.history': ['goalId', 'limit', 'cursor'],
  'goal.activity': ['goalId', 'projectId', 'agentSessionId', 'assigneeSessionId', 'supervisorSessionId', 'status', 'since', 'limit'],
  'system.storage': ['hostId', 'runId'], 'system.doctor': ['workspacePath'], 'system.endpoint': [], 'system.relay.inspect': [],
  'system.subscription.cancel': ['subscriptionId']
} as const satisfies Record<Exclude<keyof typeof AGENTMUX_RPC_NATIVE_METHODS, StorageRecoveryMethod | FocusMethod | MoteDialogueMethod | CapsuleRuntimeMethod | CapsuleMethod | AgentLearningMethod | 'capsule.input' | import('./public-rpc-device.js').AgentMuxRpcDeviceMethod | AgentMuxHostedRuntimeMethod | ApplicationAccessMethod | MoteChatMethod | MoteConnectionMethod | MoteAvatarSeriesMethod | MoteAvatarWriteMethod | AgentPromotionMethod | TopicMethod | ConnectionMethod | ObjectAvatarMethod | TailcatConfigurationMethod | NotesStorageMethod | ProviderCatalogMethod | HostSettingsMethod | MeshNetworkMethod | NodePublishingMethod | NodeLocatorMethod | import('./public-rpc-tailcat-key.js').TailcatKeyMethod | import('./public-rpc-host-maintenance.js').HostMaintenanceMethod | import('./public-rpc-files.js').FileMethod | GitMethod | AppWindowMethod | ScheduleMethod | ImageMethod | NativeDesktopMethod | keyof typeof HOST_ROUTE_METHODS>, readonly string[]>

/** Home follows an exact execution route; its display name does not identify that route. */
function homeHostRoute(configuration: import('./control.js').AgentMuxControlSettingsResourceFields | null) {
  if (configuration === null) return null
  const { label: _label, ...route } = configuration
  return route
}

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
function assertExecutionBindingAuthority(context: AgentMuxRpcCallContext): void {
  if (context.caller !== undefined || !context.principal || !['user', 'device'].includes(context.principal.kind) ||
      typeof context.principal.id !== 'string' || !context.principal.id.trim() || context.principal.id.includes('\0'))
    throw new AgentMuxError('Execution binding operations require a transport-approved user or device.', 'CONTROL_PERMISSION_DENIED')
}
export class AgentMuxRpcService {
  private readonly diagnosticQuery = new DiagnosticEvidenceQuery()
  private readonly landmarks: ConversationLandmarkStore
  private readonly notebooks: AgentMuxNotebookStore
  private readonly spatial: AgentMuxSpatialStateStore
  private readonly spaceAuthority: SpaceAuthorityOwner
  private search: ReturnType<typeof createAgentMuxSearchReader<SearchCallContext>> | undefined
  private local: Promise<AgentMuxClient> | undefined
  constructor(private readonly ports: AgentMuxRpcServiceOptions = {}) { this.landmarks = ports.conversationLandmarks ?? new ConversationLandmarkStore(); this.spatial = ports.spatialState ?? new AgentMuxSpatialStateStore(); this.notebooks = ports.notebookStore ?? new AgentMuxNotebookStore(); this.spaceAuthority = new SpaceAuthorityOwner(this.spatial, async () => {
    const owner = await this.ports.hostedRuntime?.()
    if (!owner) throw new AgentMuxError('The original Space semantic authority is unavailable. Retain its reference and last confirmed contents.', 'CONTROL_UNAVAILABLE')
    return (await owner.call('runtime.owner.identity', {})).owner
  }) }

  private async hosted(method: AgentMuxRpcMethod, params: unknown, context: AgentMuxRpcCallContext) {
    // Native SDK writes are authorized as a user/device by the transport. An
    // Agent capability remains confined to agent.* and cannot mint source:user.
    if (context.caller !== undefined || !context.principal ||
      !['user', 'device'].includes(context.principal.kind)) {
      throw new AgentMuxError('The runtime domain requires a transport-approved user or device, without a managed Agent caller.', 'AGENT_CAPABILITY_INVALID')
    }
    const actor = delegatedHostRouteActor(context) ?? context.principal
    const principalId = rpcString(actor.id, 'Transport principal')
    const p = rpcRecord(params, AGENTMUX_HOSTED_RPC_FIELDS[method as AgentMuxHostedRuntimeMethod])
    if (!this.ports.hostedRuntime) throw new AgentMuxError('The borrowed Runtime Host business owner is unavailable. Existing Runs are retained.', 'CONTROL_UNAVAILABLE')
    const owner = await this.ports.hostedRuntime()
    // Hosted call/subscribe dispatch precedes the ordinary service fence gate.
    // A business/consumer fence does not replace this explicit wire target.
    if (context.runtimeFence) owner.assertFence(context.runtimeFence)
    if (method === 'runtime.owner.identity' || method === 'runtime.owner.shutdown' || method === 'runtime.network.inspect' || method === 'runtime.profile.capture') return { owner, params: p }
    const consumer = rpcString(p.consumerId, 'Host consumer ID')
    const consumerId = createHash('sha256').update((hostRouteActorScope(context) ?? actor.kind + '\0' + principalId) + '\0' + consumer).digest('hex')
    return { owner, params: { ...p, consumerId } }
  }

  /**
   * `derived-action` content is a public shorthand. Expand it here, once, into the ordinary
   * new-agent or fork-agent content the spatial owner already admits: the same Core prompt the
   * Desktop menu sends, from the exact source Session and the saved definition.
   */
  private async prepareTakeover(params: AgentMuxRpcParams<'agent.open'>, context: AgentMuxRpcCallContext): Promise<void> {
    const request = rpcControlRequest('agent.open', params)
    if (request.operation !== 'agent.open' || request.content.kind !== 'takeover-agent') return
    const caller = await this.authenticated(context)
    if (caller || !context.principal || !['user', 'device'].includes(context.principal.kind)) throw new AgentMuxError('Takeover requires the original person or device; existing Agents remain available.', 'CONTROL_PERMISSION_DENIED')
    const state = await this.spatial.read()
    if (!state) throw new AgentMuxError('The original Takeover spatial owner is unavailable. Original work remains available.', 'SPATIAL_STATE_ABSENT')
    const { spatialAgentOpenDigest } = await import('./spatial-agent-open.js')
    const previous = spatialAgentOpenRecord(state.graph, request.requestId), requestDigest = spatialAgentOpenDigest(request)
    if (previous) {
      if (!previous.takeover || previous.takeoverRequestDigest !== requestDigest) throw new AgentMuxError('This operation belongs to another original Takeover intent.', 'SPACE_REQUEST_CONFLICT')
      return
    }
    const origin = request.content.source, matches = (await this.clients(origin.hostId)).filter(value => value.hostId === origin.hostId)
    if (matches.length !== 1 || this.endpointUnverified(matches[0]!.client)) throw new AgentMuxError('The exact Takeover source Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
    const client = matches[0]!.client, identity = await client.agentCreationAuthority()
    if (origin.expectedRuntimeId !== undefined && origin.expectedRuntimeId !== identity.runtimeId) throw new AgentMuxError('The selected Takeover source route answers for another original Runtime. Keep the original source and request.', 'RUNTIME_OWNER_MISMATCH')
    const session = origin.agentSessionId ? await client.readAgentSession(origin.agentSessionId) : null
    const history = session || !origin.agentSessionId ? null : (await client.sessionHistorySources({ agentSessionId: origin.agentSessionId })).find(value => value.agentSessionId === origin.agentSessionId)
    const metadata = session ?? history?.history ?? (origin.nativeSource ? { workspacePath: origin.nativeSource.workspacePath, executorId: origin.executorId } : null)
    if (origin.agentSessionId && !session && !history?.history && history?.state !== 'deleted') throw new AgentMuxError('The selected original Agent is not retained on that exact source owner.', 'AGENT_TAKEOVER_SOURCE_CHANGED')
    if (!metadata || origin.expectedRun && (!session || session.run.runId !== origin.expectedRun.runId)) throw new AgentMuxError('The original Takeover source or Run is unconfirmed or changed.', 'AGENT_TAKEOVER_SOURCE_CHANGED')
    const owner = await this.hosted('runtime.owner.identity', {}, context), current = (await owner.owner.call('runtime.owner.identity', {}, context)).owner
    let organization: import('./agent-takeover.js').AgentTakeoverOrganization | null = null, organizationIssue: string | undefined
    if (origin.organization) try {
      if (origin.organization.runtimeId === current.runtimeId) organization = qualifyTakeoverOrganization(state.graph, origin.organization, { runtimeId: identity.runtimeId, agentSessionId: origin.agentSessionId ?? null })
      else {
        // The original selected route is the only available remote organization authority.
        if (origin.organization.runtimeId !== identity.runtimeId || !client.subscribeRpc) throw new AgentMuxError('The exact original organization Core has no available qualified read route.', 'CONTROL_UNAVAILABLE')
        const { readSpaceSnapshot } = await import('./space-authority-stream.js')
        const forwarded = await this.inputForwardContext(context)
        const snapshot = await readSpaceSnapshot({ subscribe: (method, params, handlers) => client.subscribeRpc!(method, params, { ...handlers, ...(forwarded.forwarding ? { forwarding: forwarded.forwarding } : {}) }) }, origin.organization, context.signal ? { signal: context.signal } : {})
        organization = qualifyTakeoverOrganization({ spaces: snapshot.scope.space ? [snapshot.scope.space] : [], ...snapshot.scope }, origin.organization, { runtimeId: identity.runtimeId, agentSessionId: origin.agentSessionId ?? null })
      }
      if (!organization) organizationIssue = 'The original selected Space has no confirmed Project or Club identity.'
    } catch (cause) {
      if (cause instanceof AgentMuxError && cause.code === 'AGENT_TAKEOVER_SOURCE_CHANGED') throw cause
      organizationIssue = 'The original organization could not be observed; its identity remains unknown: ' + (cause instanceof Error ? cause.message : String(cause)).slice(0, 2048)
    }
    // Resolve exactly as the final original allocator, including zone-only and empty-Region targets.
    const located = spatialDestination(spatialCatalog(state.graph), request.destination, { tabId: mintObjectId(), regionId: mintObjectId() }, state.graph.layouts)
    const destination = takeoverDestinationOrganization(state.graph, located.address, current.runtimeId)
    let contextPage: unknown, diagnostic = 'Read the original complete context through its exact owner.'
    const sameCore = (request.content.agentTarget?.runtimeId ?? current.runtimeId) === identity.runtimeId
    if (!sameCore || !origin.agentSessionId) try { contextPage = origin.agentSessionId
      ? await this.call('agent.context', { hostId: origin.hostId, agentSessionId: origin.agentSessionId }, context)
      : await this.call('agent.native.history', { hostId: origin.hostId, executorId: origin.executorId!, source: origin.nativeSource!, limit: 100 }, context) }
    catch (cause) { diagnostic = 'Original context observation is unavailable: ' + String(cause) }
    const prompt = [agentTakeoverPrompt({ hostId: origin.hostId, agentSessionId: origin.agentSessionId, nativeSource: origin.nativeSource, cwd: metadata.workspacePath, executorId: metadata.executorId, label: origin.agentSessionId ?? origin.nativeSource!.nativeHandle.sessionId, diagnostic }, undefined, sameCore ? 'local' : null),
      ...(!sameCore && contextPage ? ['Original-owner bounded context page; continue its nextCursor only at that original owner or through a verified route. This is not complete history.', JSON.stringify(contextPage)] : [])].join('\n\n')
    context.agentTakeover = { requestId: request.requestId, requestDigest, prompt, preparation: { source: { hostId: origin.hostId, runtimeId: identity.runtimeId, agentSessionId: origin.agentSessionId ?? null, ...(origin.nativeSource ? { nativeSource: origin.nativeSource } : {}), ...(origin.executorId ? { executorId: origin.executorId } : {}), run: session?.run ?? null, organization, ...(organizationIssue ? { organizationIssue } : {}) },
      destination: { owner: { runtimeId: current.runtimeId }, organization: destination }, nature: agentTakeoverNature(organization, destination) } }
  }

  private async expandDerivedAction(params: AgentMuxRpcParams<'agent.open'>, context: AgentMuxRpcCallContext): Promise<AgentMuxRpcParams<'agent.open'>> {
    const content = (params as { content?: { kind?: unknown } }).content
    if (!content || content.kind !== 'derived-action') return params
    const request = rpcControlRequest('agent.open', params)
    if (request.operation !== 'agent.open' || request.content.kind !== 'derived-action') return params
    const { actionId, source, executorId } = request.content
    if (isAgentBuiltInDerivedActionId(actionId)) throw new AgentMuxError(`“${actionId}” is an official action with its own command: Take over uses agent open --executor with agent context, Fork uses agent open --fork-from, and Pass on experience uses agent learning prepare.`, 'INVALID_CONTROL_REQUEST')
    const caller = await this.authenticated(context)
    // A managed Agent may derive work only from its own Session; a person or device names any exact Session.
    if (caller && caller.agentSessionId !== source.agentSessionId) throw new AgentMuxError('A managed Agent can start a derived action only from its own Session.', 'CONTROL_PERMISSION_DENIED')
    // The same original settings owner that answers `settings derived-actions inspect`.
    const found = this.ports.callOriginalCore
      ? await this.ports.callOriginalCore('local', 'settings.derived-actions.inspect', { id: actionId }, context) as { item?: { value?: unknown } }
      : (await this.execute(rpcControlRequest('settings.derived-actions.inspect', { id: actionId }), undefined, context) as { item?: { value?: unknown } })
    if (!found?.item) throw new AgentMuxError('The saved derived action is unavailable on this endpoint. Nothing was started.', 'CONTROL_UNAVAILABLE')
    const action = parseAgentDerivedActionFields(found.item.value)
    const owner = await this.owner(source.agentSessionId, true)
    const session = owner.session
    const { content: _shorthand, ...rest } = params as Record<string, unknown>
    if (action.base === 'fork') {
      if (executorId !== undefined) throw new AgentMuxError('A fork continues the source Provider; remove --executor.', 'INVALID_CONTROL_REQUEST')
      const native = session.nativeHandle
      if (native?.kind !== 'provider') throw new AgentMuxError('The source native conversation is not confirmed; it cannot be forked. Inspect the Session first.', 'AGENT_FORK_UNSUPPORTED')
      return { ...rest, content: { kind: 'fork-agent', source: { agentSessionId: session.agentSessionId, expectedRun: { runId: session.run.runId }, expectedNativeHandle: native }, ...parseAgentOpenLaunchFields(request.content), prompt: action.instruction } } as AgentMuxRpcParams<'agent.open'>
    }
    const chosen = executorId ?? action.executorId
    if (!chosen) throw new AgentMuxError('Choose the Agent with --executor; this action has no default Agent.', 'INVALID_CONTROL_REQUEST')
    const prompt = agentDerivedActionPrompt(action, { hostId: owner.hostId, agentSessionId: session.agentSessionId, cwd: session.workspacePath,
      executorId: session.executorId, label: session.agentSessionId, diagnostic: 'Started from the public derived action command; read the complete context for the current state.' })
    return { ...rest, content: { kind: 'new-agent', executorId: chosen, ...parseAgentOpenLaunchFields(request.content), prompt } } as AgentMuxRpcParams<'agent.open'>
  }
  private async spaceMemberRuntime(input: import('./space-member.js').SpaceMemberParams[keyof import('./space-member.js').SpaceMemberParams], context: AgentMuxRpcCallContext) {
    const source = await this.hosted('runtime.owner.identity', { expectedRuntimeId: input.target.reference.runtimeId }, context)
    await source.owner.call('runtime.owner.identity', source.params, context)
    return await spaceMemberRuntime({ store: this.spatial, clients: hostId => this.clients(hostId, { signal: context.openingSignal ?? context.signal }),
      ...(this.ports.hostRoutes ? { gateway: this.ports.hostRoutes } : {}), local: {
        call: async (method, params, original) => {
          if (method === 'skill.ls' || isAgentProgressMethod(method) || method === 'file.upload' || method === 'file.upload.inspect' || (SPACE_MEMBER_NATIVE_MAIL_CALLS as readonly string[]).includes(method)) return await this.callOwnedBusiness(method, params as AgentMuxRpcParams<typeof method>, original)
          const endpoint = await this.hosted(method as AgentMuxRpcMethod, params, original); return await endpoint.owner.call(method, endpoint.params, original)
        },
        subscribe: async (method, params, emit, original) => { const endpoint = await this.hosted(method as AgentMuxRpcMethod, params, original); return await endpoint.owner.subscribe(method, endpoint.params, emit, original) }
      } }, input, context)
  }

  private async assertRuntimeFence(context: AgentMuxRpcCallContext): Promise<void> {
    if (!context.runtimeFence) return
    if (this.ports.hostedRuntime) {
      ;(await this.ports.hostedRuntime()).assertFence(context.runtimeFence)
      return
    }
    // A client host borrows the original Core; it never owns a second semantic
    // Runtime. Preserve the request's caller and fence on that original channel.
    if (this.ports.callOriginalCore) {
      const { source } = await this.ports.callOriginalCore('local', 'agent.open.describe',
        { expectedRuntimeId: context.runtimeFence.runtimeId }, context)
      if (source.runtimeId !== context.runtimeFence.runtimeId || source.ownerInstanceId !== context.runtimeFence.ownerInstanceId) throw new AgentMuxError(
        'The original semantic Runtime changed. No operation was rerouted.', 'RUNTIME_OWNER_MISMATCH')
      return
    }
    throw new AgentMuxError('The original semantic Runtime owner is unavailable. No operation was rerouted.', 'CONTROL_UNAVAILABLE')
  }

  private folderDirectoryContext(source: import('./space-authority.js').SpaceAuthoritySource, context: AgentMuxRpcCallContext): AgentMuxRpcCallContext {
    const runtimeFence = { runtimeId: source.runtimeId, ownerInstanceId: source.ownerInstanceId }
    return { ...context, runtimeFence, assertCurrent: async () => {
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence({ ...context,runtimeFence })
    } }
  }
  private async clients(hostId?: string, read?: { signal?: AbortSignal | undefined }): Promise<readonly AgentMuxRpcCoreClient[]> {
    if (this.ports.coreClients) return read === undefined ? await this.ports.coreClients(hostId) : await this.ports.coreClients(hostId, read)
    this.local ??= import('./runtime-client.js').then(({ connectLocalAgentMux }) => connectLocalAgentMux())
    return [{ hostId: 'local', client: await this.local }]
  }
  async dispose(): Promise<void> {
    this.spaceAuthority.dispose()
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
  private async owner(id: string, exactOnly = false, hostId?: string) {
    const clients = (await this.clients()).filter(scope => hostId === undefined || scope.hostId === hostId)
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
  private avatarExecutionContext(context: AgentMuxRpcCallContext, caller: Awaited<ReturnType<AgentMuxRpcService['authenticated']>>): AvatarExecutionContext {
    const runtimeId = caller?.client.runtimeOwnerIdentity?.()?.runtimeId
    const actor = parseAvatarActor(caller ? { kind: 'agent', id: caller.agentSessionId, hostId: caller.hostId,
      ...(runtimeId ? { runtimeId } : {}), ...(caller.session.run ? { runId: caller.session.run.runId } : {}) }
      : context.principal, 'CONTROL_PERMISSION_DENIED')
    return { actor, ...(context.signal ? { signal: context.signal } : {}), assertCurrent: async () => {
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      if (caller) await this.authenticated(context)
    } }
  }

  private async authenticated(context: AgentMuxRpcCallContext, exactOnly = false) {
    if (!context.caller) return undefined
    const caller = rpcRecord(context.caller, ['agentSessionId', 'capability'])
    const agentSessionId = rpcString(caller.agentSessionId, 'Caller Session ID')
    const capability = rpcString(caller.capability, 'Caller capability')
    const scopes = await this.clients()
    // An ingress Core owns its local invocation identity even if a configured
    // remote Runtime independently uses the same Session id. Never try that
    // local capability at another owner to disambiguate display/routing ids.
    const local = scopes.filter(scope => scope.hostId === 'local' && !this.endpointUnverified(scope.client))
    if (local.length === 1 && await local[0]!.client.readAgentSession(agentSessionId)) {
      const session = await local[0]!.client.authorizeRetainedAgentCaller(capability, agentSessionId)
      return { ...local[0]!, agentSessionId, capability, session, unavailable: [] }
    }
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
    return { ...(context.signal ? { requestSignal: context.signal } : {}), ...(assertCurrent ? { assertCurrent } : {}),
      ...(context.retainAcceptedInputAuthority ? { retainAcceptedInputAuthority: context.retainAcceptedInputAuthority } : {}) }
  }
  private async inputForwardContext(context: AgentMuxRpcCallContext): Promise<AgentMuxRpcCallContext> {
    await this.inputCallContext(context).assertCurrent?.()
    const { assertCurrent: _localRestriction, retainAcceptedInputAuthority: _localIntake, ...forwarded } = context
    return forwarded
  }
  private async localAgentName(method: 'agent.name.inspect' | 'agent.name.change', input: NameControlParams['agent.name.inspect'] | NameControlParams['agent.name.change'],
    context: AgentMuxRpcCallContext, nameContext: (target: import('./display-label.js').AgentMuxNameTarget) => AgentMuxNameContext) {
    const locals = (await this.clients()).filter(item => item.hostId === 'local')
    if (locals.length !== 1) throw new AgentMuxError('The exact local label owner is unavailable or ambiguous.', 'NAME_OWNER_UNAVAILABLE')
    const target = { kind: 'agent-session', id: input.agentSessionId }
    const current = async () => {
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      if (context.caller && context.caller.agentSessionId !== input.agentSessionId) throw new AgentMuxError('A managed name call stays with its original authenticated Session.', 'CONTROL_PERMISSION_DENIED')
      // Saved labels belong to this Runtime/SID even when its Session is not observed.
      // Only an explicit name mutation needs the original creation witness.
      if ('change' in input) {
        const session = await locals[0]!.client.readAgentSession(input.agentSessionId)
        if (!session || session.agentSessionId !== input.agentSessionId || session.hostId !== 'local' || session.creation?.createOperationId !== input.createOperationId) throw new AgentMuxError(
          'The original local Session creation is unconfirmed. Keep its exact name operation; no same-SID identity was substituted.', 'NAME_TARGET_UNCONFIRMED')
      }
    }
    await current()
    return method === 'agent.name.change' && 'change' in input
      ? await changeOwnedName(this.spatial, input.runtimeId, target, input.change, nameContext(target), current)
      : await inspectOwnedName(this.spatial, input.runtimeId, target, 'operationId' in input ? input.operationId : undefined)
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
      if (prior?.action === 'restart' || prior?.launchInput || prior?.messageInput) throw new AgentMuxError('The original operation belongs to another lifecycle or input request.', 'AGENT_CONTINUITY_OPERATION_CONFLICT')
      const restored = await selected.client.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: prior?.previousRun ?? original.run,
        operationId: request.requestId, trigger: 'manual' })
      if (restored.kind === 'unavailable' && restored.reason === 'native-conversation-absent') throw new AgentMuxError(
        'Core holds no native conversation for this ended Session to continue. The original Session and its history are kept; start a new conversation instead.',
        'AGENT_RESUME_UNAVAILABLE', JSON.stringify(restored))
      if (restored.kind !== 'resumed' && restored.kind !== 'reattachable') throw new AgentMuxError(
        restored.continuity?.error ?? `The original Resume is ${restored.kind}. Inspect this Session and retry the same operation.`,
        restored.continuity?.errorCode ?? 'AGENT_CONTINUITY_PENDING', JSON.stringify(restored))
      return { operation: 'resume', agentSessionId: original.agentSessionId, runId: restored.session.run.runId,
        ...(restored.continuity?.resolution ? { resolution: structuredClone(restored.continuity.resolution) } : {}) }
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
          save:{layoutApplied:true,clientStateWritten:false,storageFlushRequested:false,diskDurability:'confirmed',reason:null},issues:[]}
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
  private assertExposed(method: AgentMuxRpcMethod): void {
    if (this.ports.exposedMethods && !this.ports.exposedMethods.has(method)) throw new AgentMuxError('This endpoint has no composed owner for this capability. Its other original capabilities remain available.', 'HOST_CAPABILITY_UNAVAILABLE')
  }
  async call<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>,
    context: AgentMuxRpcCallContext = {}): Promise<AgentMuxRpcResult<M>> {
    this.assertExposed(method)
    await assertHostRouteDispatch(context, method, params, false)
    return await this.callOwnedBusiness(method, params, context)
  }
  /** One business owner. A verified original member already owns its dispatch;
   * local calls retain that actor and exact route restriction without dispatching
   * a second, different method through the outer envelope. */
  private async callOwnedBusiness<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>,
    context: AgentMuxRpcCallContext): Promise<AgentMuxRpcResult<M>> {
    this.assertExposed(method)
    // These finite directory reads borrow the exact opening lifetime. Cancelling
    // this reader does not cancel an admitted write or the shared connection.
    if ((method === 'space.ls' || method === 'space.inspect') && context.openingSignal) context = { ...context, signal: context.openingSignal }
    if (isStorageRecoveryMethod(method)) {
      if (context.transport !== 'unix' || context.principal?.kind !== 'user' || !context.principal.id || context.caller !== undefined || context.routeDelegation !== undefined)
        throw new AgentMuxError('Storage recovery requires the original local Unix user without an Agent caller or delegated route.', 'CONTROL_PERMISSION_DENIED')
      const input = parseStorageRecoveryParams(method, params)
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      context.signal?.throwIfAborted()
      if (method === 'storage.source.capture' || method === 'storage.source.release' || method === 'storage.source.inspect' || method === 'storage.source.prepare' || method === 'storage.source.restore') {
        const exports = this.ports.storageRecoveryExports
        if (!exports) throw new AgentMuxError('The original local storage source owner is unavailable. No replacement source was selected.', 'CONTROL_UNAVAILABLE')
        const captureId = (input as { captureId: string }).captureId
        const result = method === 'storage.source.inspect' ? await exports.inspect()
          : method === 'storage.source.capture' ? await exports.capture(captureId)
          : method === 'storage.source.prepare' ? await exports.prepare(captureId, (input as StorageRecoveryParamsMap['storage.source.prepare']).members)
          : method === 'storage.source.restore' ? { outcome: await exports.restore((input as StorageRecoveryParamsMap['storage.source.restore']).member) }
          : await exports.release(captureId)
        return parseStorageRecoveryResult(method, result, input) as AgentMuxRpcResult<M>
      }
      const owner = this.ports.storageRecovery
      if (!owner) throw new AgentMuxError('The original storage recovery owner is unavailable. Existing Sessions and recovery sources remain retained.', 'CONTROL_UNAVAILABLE')
      const result = method === 'storage.backup.create' ? { generation: await owner.capture() }
        : method === 'storage.backup.import' ? { generation: await owner.importSessionBackup(input as { sourcePath: string; sha256: string }) }
        : method === 'storage.backup.list' ? { generations: await owner.list() }
        : method === 'storage.backup.inspect' ? { generation: await owner.inspect((input as { generationId: string }).generationId) }
        : method === 'storage.restore.preflight' ? { operation: await owner.restorePreflight(input as import('./storage-restore.js').RestorePreflight) }
        : method === 'storage.restore.apply' ? { operation: await owner.restoreApply((input as { operationId: string }).operationId) }
        : method === 'storage.restore.inspect' ? { operation: await owner.restoreInspect((input as { operationId: string }).operationId) }
        : { status: owner.status() }
      return parseStorageRecoveryResult(method, result, input) as AgentMuxRpcResult<M>
    }
    if (Object.hasOwn(FOCUS_METHODS, method)) {
      const selected = method as FocusMethod, input = parseFocusParams(selected, params)
      await this.authenticated(context)
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      if (this.ports.forwardControl) return parseFocusResult(selected,
        await this.ports.forwardControl(selected, input, context), input) as AgentMuxRpcResult<M>
      const result = await this.execute(this.request(selected, { input }), undefined, context)
      if (result.operation !== selected || !('page' in result)) throw new AgentMuxError('The original Focus owner returned another observation.', 'CONTROL_PROTOCOL_ERROR')
      return parseFocusResult(selected, result.page, input) as AgentMuxRpcResult<M>
    }
    if (Object.hasOwn(HOST_ROUTE_METHODS, method)) {
      const routes = this.ports.hostRoutes
      if (!routes) throw new AgentMuxError('This Core has no composed route owner; original capabilities remain available.', 'CONTROL_UNAVAILABLE')
      const input = parseHostRouteParams(method as keyof typeof HOST_ROUTE_METHODS, params)
      if (method === 'route.identity') return await routes.identity() as AgentMuxRpcResult<M>
      if (method === 'route.edges') return await routes.edges(context) as AgentMuxRpcResult<M>
      if (method === 'route.choices') return await routes.choices(context) as AgentMuxRpcResult<M>
      if (method === 'route.executors') return await routes.executors(parseHostRouteParams('route.executors', params), context) as AgentMuxRpcResult<M>
      if (method === 'route.edge.inspect') return await routes.inspectEdge(input as import('./host-route.js').HostRouteParams['route.edge.inspect'], context) as AgentMuxRpcResult<M>
      if (method === 'route.inspect' || method === 'route.configure') {
        if (context.caller || context.routeDelegation || !context.principal) throw new AgentMuxError('Route policy requires its actual original user/device.', 'CONTROL_PERMISSION_DENIED')
        await context.assertCurrent?.()
        return (method === 'route.inspect' ? await routes.inspect() : await routes.configure(input as import('./host-route.js').HostRouteParams['route.configure'], context)) as AgentMuxRpcResult<M>
      }
      if (method === 'route.watch' || method === 'route.receive-watch') throw new AgentMuxError('Use the original route subscription transport.', 'INVALID_CONTROL_REQUEST')
      return await routes.call(input as import('./host-route.js').HostRouteParams['route.call'] | import('./host-route.js').HostRouteParams['route.receive'], context, method === 'route.receive') as AgentMuxRpcResult<M>
    }
    if (isNameControlMethod(method)) {
      const input = parseNameControlParams(method, params), caller = await this.authenticated(context, true)
      if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind))) throw new AgentMuxError('Name operations require the original authenticated actor.', 'CONTROL_PERMISSION_DENIED')
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      if (this.ports.callOriginalCore) {
        if (method === 'agent.name.inspect') return await this.ports.callOriginalCore('local', 'agent.name.inspect', parseNameControlParams('agent.name.inspect', params), context) as AgentMuxRpcResult<M>
        if (method === 'agent.name.change') return await this.ports.callOriginalCore('local', 'agent.name.change', parseNameControlParams('agent.name.change', params), context) as AgentMuxRpcResult<M>
        if (method === 'space.member.name.inspect') return await this.ports.callOriginalCore('local', 'space.member.name.inspect', parseNameControlParams('space.member.name.inspect', params), context) as AgentMuxRpcResult<M>
        return await this.ports.callOriginalCore('local', 'space.member.name.change', parseNameControlParams('space.member.name.change', params), context) as AgentMuxRpcResult<M>
      }
      const endpoint = await this.ports.hostedRuntime?.()
      if (!endpoint) throw new AgentMuxError('The original label Runtime is unconfirmed. Current work and name input remain available.', 'NAME_OWNER_UNAVAILABLE')
      const expectedRuntimeId = 'target' in input ? input.target.reference.runtimeId : input.runtimeId
      const { owner } = await endpoint.call('runtime.owner.identity', { expectedRuntimeId }, context)
      if (owner.runtimeId !== expectedRuntimeId) throw new AgentMuxError('The name belongs to another original Runtime.', 'RUNTIME_OWNER_MISMATCH')
      const delegated = delegatedHostRouteActor(context), nameParent = delegatedHostRouteMemberName(context), actor = caller ? { kind: 'agent' as const, id: caller.agentSessionId, verified: true }
        : { kind: (delegated ?? context.principal!).kind, id: (delegated ?? context.principal!).id, verified: true }
      const nameContext = (target: import('./display-label.js').AgentMuxNameTarget): AgentMuxNameContext => ({ actor,
        source: 'change' in input && input.change.kind === 'rename' ? input.change.source : 'explicit-confirm', entryPoint: method,
        transport: context.transport ?? null, location: { targetKind: target.kind, targetId: target.id, runtimeId: expectedRuntimeId,
          actorSourceRuntimeId: delegated?.source.runtimeId ?? expectedRuntimeId,
          ...(nameParent ? { sourceRuntimeId: nameParent.runtimeId, spaceId: nameParent.spaceId, regionId: nameParent.regionId, admissionKind: nameParent.expectedAdmission.kind, admissionOperationId: nameParent.expectedAdmission.operationId } : {}),
          ...('target' in input ? { sourceRuntimeId: input.target.reference.runtimeId, spaceId: input.target.reference.spaceId, regionId: input.target.regionId,
            admissionKind: input.target.expectedAdmission.kind, admissionOperationId: input.target.expectedAdmission.operationId }
            : 'change' in input ? { createOperationId: input.createOperationId } : {}) } })
      const result = 'target' in input ? await sourceMemberName({ store: this.spatial, ...(this.ports.hostRoutes ? { gateway: this.ports.hostRoutes } : {}), clients: () => this.clients(),
        local: (leaf, request, original) => this.localAgentName(leaf, request, original, nameContext), nameContext },
        method as 'space.member.name.inspect' | 'space.member.name.change', input, context)
        : await this.localAgentName(method as 'agent.name.inspect' | 'agent.name.change', input, context, nameContext)
      return parseNameControlResult(method, result, input) as AgentMuxRpcResult<M>
    }
    if (method === 'goal.input.epoch') {
      const input = parseGoalInputEpochInput(params)
      await this.authenticated(context)
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      if (this.ports.callOriginalCore) return parseGoalInputEpoch(await this.ports.callOriginalCore('local', 'goal.input.epoch', input, context), input) as AgentMuxRpcResult<M>
      if (!this.ports.goalInputEpoch) throw new AgentMuxError('The original Goal input qualification owner is unavailable. Keep this new request unsubmitted.', 'CONTROL_UNAVAILABLE')
      return parseGoalInputEpoch(await this.ports.goalInputEpoch(input, context), input) as AgentMuxRpcResult<M>
    }
    if (method === 'agent.open.describe') {
      const input = parseAgentOpenDescribe(params)
      await this.authenticated(context)
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      if (this.ports.callOriginalCore) return await this.ports.callOriginalCore('local', 'agent.open.describe', input, context) as AgentMuxRpcResult<M>
      const endpoint = await this.ports.hostedRuntime?.()
      if (!endpoint) throw new AgentMuxError('The original Source launch owner is unconfirmed. Existing requests and healthy Agents remain available.', 'AGENT_OPEN_CONTRACT_UNCONFIRMED')
      const { owner } = await endpoint.call('runtime.owner.identity', { expectedRuntimeId: input.expectedRuntimeId }, context)
      let contracts: import('./agent-open-contract.js').AgentOpenContracts = { ordinaryLaunch: null, externalAssociation: null, takeover: null }
      let sourceIssue: { code: string; message: string } | undefined
      if (!input.executionOnly) try { contracts = this.ports.spatialAgentControl?.describe?.() ?? contracts }
      catch (error) { sourceIssue = { code: error instanceof AgentMuxError ? error.code : 'AGENT_OPEN_CONTRACT_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } }
      const execution = input.execution ? await this.ports.spatialAgentControl?.describeExecution?.(input.execution, context) : undefined
      return parseAgentOpenDescription({ source: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }, contracts, ...(execution ? { execution } : {}), ...(sourceIssue ? { sourceIssue } : {}) }, input) as AgentMuxRpcResult<M>
    }
    if (method === 'space.folder.inspect') {
      const input = parseFolderDirectoryInspectInput(params), caller = await this.authenticated(context)
      if (caller || context.caller || context.routeDelegation || !context.principal || !['user','device'].includes(context.principal.kind)) throw new AgentMuxError('A new Source directory requires its original transport-approved owner or device. Published reads do not grant resource registration.', 'CONTROL_PERMISSION_DENIED')
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      if (this.ports.callOriginalCore) return await this.ports.callOriginalCore('local', 'space.folder.inspect', input, context) as AgentMuxRpcResult<M>
      const endpoint = await this.ports.hostedRuntime?.(), directory = this.ports.spatialFolderDirectory
      if (!endpoint || !directory) throw new AgentMuxError('The original Source directory owner is unavailable. Existing resources and Agents remain available.', 'SPACE_RESOURCE_UNAVAILABLE')
      const { owner } = await endpoint.call('runtime.owner.identity', { expectedRuntimeId: input.runtimeId })
      if (owner.runtimeId !== input.runtimeId) throw new AgentMuxError('This directory belongs to another original Source Runtime.', 'RUNTIME_OWNER_MISMATCH')
      return await directory.inspect(input, { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }, this.folderDirectoryContext(owner,context)) as AgentMuxRpcResult<M>
    }
    if (Object.hasOwn(SPACE_CLOSE_METHODS, method)) {
      const selected = method as SpaceCloseMethod, input = parseSpaceCloseParams(selected, params)
      const caller = await this.authenticated(context)
      if (selected === 'space.close.apply' && context.caller !== undefined) throw new AgentMuxError(
        'Closing workface resources or discarding drafts requires the original transport-approved person/device. The plan and healthy work are retained.', 'CONTROL_PERMISSION_DENIED')
      if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind))) throw new AgentMuxError('Read the original workface plan with an authenticated actor.', 'CONTROL_PERMISSION_DENIED')
      const actor: SpaceCloseActor = caller ? { kind: 'agent', id: caller.agentSessionId, hostId: caller.hostId }
        : { kind: context.principal!.kind as 'user' | 'device', id: rpcString(context.principal!.id, 'Original transport principal') }
      const assertCurrent = async () => {
        context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
        if (context.caller) await this.authenticated(context)
      }
      await assertCurrent()
      if (!this.ports.spaceClose) {
        if (this.ports.forwardControl) return parseSpaceCloseResult(selected, await this.ports.forwardControl<SpaceCloseMethod>(selected, input, context), input) as AgentMuxRpcResult<M>
        throw new AgentMuxError('The original Desktop workface close owner is unavailable. Original views, drafts and Runs are retained.', 'CONTROL_UNAVAILABLE')
      }
      return parseSpaceCloseResult(selected, await this.ports.spaceClose.call(selected, input, { actor, originalContext: context, assertCurrent, ...(context.signal ? { signal: context.signal } : {}) }), input) as AgentMuxRpcResult<M>
    }
    if (method === 'space.folder.register') {
      const input = parseFolderSpaceRegisterInput(params), caller = await this.authenticated(context)
      if ('directory' in input && (caller || context.caller || context.routeDelegation || !context.principal || !['user','device'].includes(context.principal.kind))) throw new AgentMuxError('A new Source directory requires its original transport-approved owner or device. Published reads do not grant resource registration.', 'CONTROL_PERMISSION_DENIED')
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      if (this.ports.callOriginalCore) return await this.ports.callOriginalCore('local', 'space.folder.register', input, context) as AgentMuxRpcResult<M>
      const endpoint = await this.ports.hostedRuntime?.()
      if (!endpoint || !('directory' in input) && !this.ports.spatialFolderResource) throw new AgentMuxError('This original Host cannot read its registered Folder resource. Its existing Spaces and Agents remain available.', 'SPACE_RESOURCE_UNAVAILABLE')
      const { owner } = await endpoint.call('runtime.owner.identity', { expectedRuntimeId: input.runtimeId })
      if (owner.runtimeId !== input.runtimeId) throw new AgentMuxError('The selected Folder belongs to another Runtime. No local Space was substituted.', 'RUNTIME_OWNER_MISMATCH')
      if ('directory' in input) {
        if (!this.ports.spatialFolderDirectory) throw new AgentMuxError('The original Source directory owner is unavailable. Existing resources and Agents remain available.', 'SPACE_RESOURCE_UNAVAILABLE')
        return await this.ports.spatialFolderDirectory.register(input, { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }, this.folderDirectoryContext(owner,context)) as AgentMuxRpcResult<M>
      }
      const resource = await this.ports.spatialFolderResource!(input.workspaceId), actual = folderResourceIdentity(resource)
      if (resource.id !== input.workspaceId || actual.hostId !== input.expectedResource.hostId || actual.workspacePath !== input.expectedResource.workspacePath || actual.projectRootPath !== input.expectedResource.projectRootPath) {
        throw new AgentMuxError('The original registered Workspace resource changed. Keep the selected intent and inspect its original Folder; no new directory was substituted.', 'SPACE_RESOURCE_CHANGED')
      }
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      const registered = await this.spatial.registerFolder(resource)
      return { reference: { runtimeId: owner.runtimeId, spaceId: registered.spaceId }, source: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId },
        zoneId: registered.zoneId, workspaceId: resource.id, resource: actual, revision: registered.state.revision, diskDurability: 'confirmed', created: registered.created } as AgentMuxRpcResult<M>
    }
    if (method === 'space.member.call') {
      const input = parseSpaceMemberParams('space.member.call', params)
      await this.assertRuntimeFence(context)
      const original = await this.spaceMemberRuntime(input, context)
      return await original.port.call(input.call.method, input.call.params, original.context) as AgentMuxRpcResult<M>
    }
    if (method === 'space.member.watch') throw new AgentMuxError('Use the original member subscription transport.', 'INVALID_CONTROL_REQUEST')
    if (method === 'space.sessions.watch') throw new AgentMuxError('Observe the original Space Session scope through its subscription API.', 'INVALID_CONTROL_REQUEST')
    if (Object.hasOwn(SPACE_LINK_METHODS, method)) {
      const name = method as SpaceLinkMethod, input = parseSpaceLinkParams(name,params)
      await this.authenticated(context)
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      if (this.ports.callOriginalCore) return parseSpaceLinkResult(name, await this.ports.callOriginalCore('local', name, input, context), input) as AgentMuxRpcResult<M>
      const hosted = await this.ports.hostedRuntime?.()
      if (!hosted) throw new AgentMuxError('The original Space link authority is unavailable. Retain the exact reference.', 'CONTROL_UNAVAILABLE')
      const owner = (await hosted.call('runtime.owner.identity', {})).owner
      const expectedRuntime = name === 'space.link.ensure' ? (input as import('./space-link.js').SpaceLinkParams['space.link.ensure']).target.runtimeId : (input as import('./space-link.js').SpaceLinkParams['space.link.resolve']).address.runtimeId
      if (owner.runtimeId !== expectedRuntime) throw new AgentMuxError('This link belongs to another original spatial Runtime. No local target was substituted.', 'RUNTIME_OWNER_MISMATCH')
      const source = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
      if (name === 'space.link.ensure') {
        const request = input as import('./space-link.js').SpaceLinkParams['space.link.ensure']
        const address = await this.spatial.ensureSpaceLink(request.target,request.operationId,async()=>{context.signal?.throwIfAborted();await context.assertCurrent?.();await this.assertRuntimeFence(context)})
        return parseSpaceLinkResult('space.link.ensure',{...request,address,url:formatSpaceLink(address),source,diskDurability:'confirmed'},request) as AgentMuxRpcResult<M>
      }
      const request = input as import('./space-link.js').SpaceLinkParams['space.link.resolve'], target = await this.spatial.resolveSpaceLink(request.address)
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      return parseSpaceLinkResult('space.link.resolve',{address:request.address,target,source},request) as AgentMuxRpcResult<M>
    }
    if (isSpaceAuthorityMethod(method)) {
      const input = parseSpaceAuthorityParams(method, params)
      await this.authenticated(context)
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      if (this.ports.callOriginalCore && method === 'space.apply') return await this.ports.callOriginalCore('local', 'space.apply', input as SpaceApply, context) as AgentMuxRpcResult<M>
      if (method !== 'space.apply') throw new AgentMuxError('Use the original Space subscription transport.', 'INVALID_CONTROL_REQUEST')
      const result = await this.spaceAuthority.apply(input as SpaceApply, context)
      return result as AgentMuxRpcResult<M>
    }
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
    if (isImageMethod(method)) {
      const caller = await this.authenticated(context)
      const input = parseImageParams(method, params)
      const actor: ImageActor | null = caller ? { kind: 'agent', id: caller.agentSessionId }
        : context.principal && ['user', 'device'].includes(context.principal.kind) ? context.principal as ImageActor : null
      if (!actor || !actor.id.trim()) throw new AgentMuxError('Image operations require an authenticated original actor.', 'CONTROL_PERMISSION_DENIED')
      if (caller && caller.hostId !== input.hostId) throw new AgentMuxError('Image operations require the authenticated Agent’s exact Host.', 'CONTROL_PERMISSION_DENIED')
      const ownerContext: ImageCallContext = { actor, ...(context.signal ? { signal: context.signal } : {}), assertCurrent: async () => {
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        if (caller) await this.authenticated(context)
      } }
      await ownerContext.assertCurrent!()
      if (!this.ports.images && !this.ports.forwardControl) throw new AgentMuxError('The original Host image presentation owner is unavailable. Existing images, Agents and page capture remain available.', 'CONTROL_UNAVAILABLE')
      const result = this.ports.images ? await this.ports.images.call(method, input, ownerContext)
        : await this.ports.forwardControl!<ImageMethod>(method, input, context)
      return parseImageResult(method, result, input, actor) as AgentMuxRpcResult<M>
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
    if (isMoteDialogueMethod(method)) {
      const caller = await this.authenticated(context)
      if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind)))
        throw new AgentMuxError('Mote dialogue sources require their original authenticated actor.', 'CONTROL_PERMISSION_DENIED')
      const input = parseMoteDialogueParams(method, params)
      if (method === 'space.mote.dialogue.heartbeat.report' && !caller) throw new AgentMuxError('A heartbeat work report requires its original authenticated Agent; a person or device cannot author its statement.', 'MANAGED_AGENT_CONTEXT_REQUIRED')
      if (method === 'space.mote.dialogue.setup.inspect' || method === 'space.mote.dialogue.setup.advance') {
        if (caller || context.caller !== undefined || !context.principal || !['user','device'].includes(context.principal.kind)) throw new AgentMuxError('Main setup requires its original authenticated person or device; an Agent cannot assign the standing Main.', 'CONTROL_PERMISSION_DENIED')
        rpcString(context.principal.id,'Original Main setup actor')
        const request = parseMoteDialogueParams(method,params)
        return parseMoteDialogueResult(method,await this.moteMainSetup(method,request,context),request) as AgentMuxRpcResult<M>
      }
      if (!this.ports.moteDialogue) {
        if (!this.ports.forwardControl) throw new AgentMuxError('The original Mote dialogue owner is unavailable. Keep its source references and existing work.', 'CONTROL_UNAVAILABLE')
        const result = await this.ports.forwardControl<MoteDialogueMethod>(method, input, context)
        return parseMoteDialogueResult(method, result, input) as AgentMuxRpcResult<M>
      }
      if (method === 'space.mote.dialogue.recovery.ensure' || method === 'space.mote.dialogue.recovery.inspect') {
        if (caller) throw new AgentMuxError('Opening a Mote main dialogue requires its original person or device; an Agent observation cannot grant this intent.', 'CONTROL_PERMISSION_DENIED')
        const value = await this.moteMainRecovery(method, parseMoteDialogueParams(method, params), context)
        return parseMoteDialogueResult(method, value, input) as AgentMuxRpcResult<M>
      }
      if (method === 'space.mote.dialogue.input.submit' || method === 'space.mote.dialogue.input.inspect') {
        if (caller) throw new AgentMuxError('Managed Agents must use agent.send; logical main prompt intake cannot impersonate a person.', 'MANAGED_AGENT_PROMPT_FORBIDDEN')
        const value = method === 'space.mote.dialogue.input.submit'
          ? await this.moteMainInput(method, parseMoteDialogueParams(method,params),context)
          : await this.moteMainInput(method, parseMoteDialogueParams(method,params),context)
        return parseMoteDialogueResult(method,value,input) as AgentMuxRpcResult<M>
      }
      const originalCallerRun = caller ? { ...caller.session.run } : null
      const original = { ...(caller ? { caller: { hostId: caller.hostId, agentSessionId: caller.agentSessionId, run: originalCallerRun! } } : {}),
        readInput: async (hostId: string, key: import('./agent-prompt-condition.js').AgentPromptInputKey) => {
          if (!caller || hostId !== caller.hostId || key.agentSessionId !== caller.agentSessionId) throw new AgentMuxError('The original heartbeat input reader cannot cross its authenticated participant.', 'CONTROL_PERMISSION_DENIED')
          return (await this.call('agent.input.inspect', { key }, context)).record
        },
        readFile: (request: import('./public-rpc-files.js').FileReadParams) => this.call('file.read', request, context),
        readNoteHistory: (request: import('./public-rpc-files.js').FileHistoryParams) => this.call('file.history', request, context),
        readDispatch: async (hostId: string, sourceMessageId: string) => this.call('message.dispatch.read', { hostId, sourceMessageId }, context),
        ...(context.signal ? { signal: context.signal } : {}), assertCurrent: async () => {
          context.signal?.throwIfAborted(); await context.assertCurrent?.(); if (caller) {
            const current = await this.authenticated(context)
            if (method === 'space.mote.dialogue.heartbeat.report' && (!current || current.hostId !== caller.hostId || current.session.run.runId !== originalCallerRun?.runId)) throw new AgentMuxError('The original reporting Agent Run changed. Keep the statement and its selected input.', 'CONTROL_PERMISSION_DENIED')
          }
        } }
      if (method === 'space.mote.dialogue.heartbeat.report') {
        if (!this.ports.moteDialogue.heartbeatReport) throw new AgentMuxError('The original heartbeat report owner is unavailable. Keep its operation and statement.', 'CONTROL_UNAVAILABLE')
        return parseMoteDialogueResult(method, await this.ports.moteDialogue.heartbeatReport(parseMoteDialogueParams(method, params), original), input) as AgentMuxRpcResult<M>
      }
      const result = method === 'space.mote.dialogue.supervision.read'
        ? await this.ports.moteDialogue.supervision(parseMoteDialogueParams(method, params), original)
        : method === 'space.mote.dialogue.read'
        ? await this.ports.moteDialogue.read(parseMoteDialogueParams(method, params), original)
        : await this.ports.moteDialogue.link(parseMoteDialogueParams(method, params), original)
      return parseMoteDialogueResult(method, result, input) as AgentMuxRpcResult<M>
    }
    if (isMoteChatMethod(method)) {
      const caller = await this.authenticated(context)
      if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind))) throw new AgentMuxError('Mote chat requires its original authenticated actor.', 'CONTROL_PERMISSION_DENIED')
      if (caller && !(['space.mote.chat.history', 'space.mote.chat.diagnose', 'space.mote.chat.events', 'space.mote.chat.review', 'space.mote.chat.reply', 'space.mote.chat.inspect'] as string[]).includes(method)) throw new AgentMuxError('Managed Agents may read redacted diagnosis, their own chat history, or their own Mote\'s events; chat settings and audience administration require the original person or device.', 'CONTROL_PERMISSION_DENIED')
      const input = parseMoteChatParams(method, params), owner = this.ports.moteChat
      await this.assertRuntimeFence(context)
      if (!owner) {
        if (this.ports.forwardControl) {
          context.signal?.throwIfAborted(); await context.assertCurrent?.()
          return parseMoteChatResult(method as MoteChatMethod, await this.ports.forwardControl<MoteChatMethod>(method, input as MoteChatParamsMap[MoteChatMethod], context), input as MoteChatParamsMap[MoteChatMethod]) as unknown as AgentMuxRpcResult<M>
        }
        throw new AgentMuxError('The original Mote chat owner is unavailable. Existing conversations are retained.', 'CONTROL_UNAVAILABLE')
      }
      const actor = caller ? { kind: 'agent' as const, id: caller.agentSessionId } : { kind: context.principal!.kind as 'user' | 'device', id: context.principal!.id }
      const administration = { actor, ...(caller ? { agentHostId: caller.hostId, agentSourceRuns: sessionSemanticResumeSourceRuns(caller.session) } : {}), ...(context.signal ? { signal: context.signal } : {}), assertCurrent: async () => { context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context); if (caller) await this.authenticated(context) } }
      await administration.assertCurrent()
      const result = method === 'space.mote.chat.reply' ? await owner.reply(parseMoteChatParams(method, params), administration)
        : method === 'space.mote.chat.configure' ? await owner.configure(parseMoteChatParams(method, params), administration)
        : method === 'space.mote.chat.inspect' ? await owner.inspect(parseMoteChatParams(method, params), administration)
        : method === 'space.mote.chat.history' ? await owner.history(parseMoteChatParams(method, params), administration)
        : method === 'space.mote.chat.audience' ? await owner.audience(parseMoteChatParams(method, params), administration)
        : method === 'space.mote.chat.diagnose' ? await owner.diagnose(parseMoteChatParams(method, params), administration)
        : method === 'space.mote.chat.events' ? await owner.events(parseMoteChatParams(method, params), administration)
        : method === 'space.mote.chat.review' ? await owner.review(parseMoteChatParams(method, params), administration)
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
          const sync = input as import('./mote/connection-contract.js').MoteConnectionSync
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
      if (isConnectionReceiverMethod(method)) {
        if (caller || !context.runtimeFence) throw new AgentMuxError('Receiver recovery administration requires the original person/device and exact Runtime owner.', 'CONTROL_PERMISSION_DENIED')
        if (!owner.receiver) throw new AgentMuxError('The original receiver management owner is unavailable. Retain the operation and original connection.', 'CONTROL_UNAVAILABLE')
        const administration = { actor: { kind: context.principal!.kind as 'user' | 'device', id: context.principal!.id },
          assertCurrent: async () => { context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context) } }
        await administration.assertCurrent()
        const result = method === 'connection.receiver.recover'
          ? await owner.receiver.recover(parseConnectionReceiverParams(method, input), administration)
          : await owner.receiver.inspect(parseConnectionReceiverParams(method, input), administration)
        await administration.assertCurrent()
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
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
      if (caller && method === 'connection.ingress.inspect') {
        const current = async () => { await administration.assertCurrent(); await this.assertRuntimeFence(context) }
        const result = await readAgentConnectionIngress(owner, parseConnectionParams(method, input),
          { hostId: caller.hostId, agentSessionId: caller.agentSessionId }, current)
        await current()
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (caller && method === 'connection.ingress.rejoin') {
        if (!owner.ingress?.rejoin) throw new AgentMuxError('Original ingress recovery is unavailable on this Host.', 'CONTROL_UNAVAILABLE')
        const current = async () => { await administration.assertCurrent(); await this.assertRuntimeFence(context) }
        const authorize = agentConnectionIngressAuthorization(owner, { hostId: caller.hostId, agentSessionId: caller.agentSessionId }, current)
        const result = await owner.ingress.rejoin(parseConnectionParams(method, input), { ...administration, authorize, assertCurrent: current })
        await current()
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (caller && method === 'connection.delivery.source.recover') {
        const request = parseConnectionDeliveryParams(method, input)
        if (request.review) throw new AgentMuxError('Reviewing a new sharing range requires the original authenticated user or device.', 'CONTROL_PERMISSION_DENIED')
        if (!owner.bindings || !owner.delivery?.recoverSource) throw new AgentMuxError('Original source recovery is unavailable on this Host.', 'CONTROL_UNAVAILABLE')
        const binding = (await owner.bindings.inspect({ bindingId: request.bindingId, revision: request.bindingRevision })).binding
        if (!binding || binding.bindingId !== request.bindingId || binding.revision !== request.bindingRevision || binding.connectionId !== request.connectionId ||
          binding.executionHostId !== caller.hostId || binding.agentSessionId !== caller.agentSessionId) throw new AgentMuxError(
          'Source recovery requires this authenticated Host and Session on its exact original Binding.', 'CONTROL_PERMISSION_DENIED')
        const current = async () => { await administration.assertCurrent(); await this.assertRuntimeFence(context) }
        await current()
        const result = await owner.delivery.recoverSource(request, { ...administration, assertCurrent: current })
        await current()
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (caller && method === 'connection.delivery.retry') {
        const request = parseConnectionDeliveryParams(method, input)
        const selector = { operationId: request.operationId }
        const original = parseConnectionResult('connection.delivery.inspect', await readAgentConnectionDelivery(owner, 'connection.delivery.inspect', selector, { hostId: caller.hostId, agentSessionId: caller.agentSessionId }), selector)
        if (!original.delivery) throw new AgentMuxError('The original publication operation is unknown.', 'UNKNOWN_PUBLICATION_OPERATION')
        const result = await owner.delivery!.retry(request, { ...administration,
          assertCurrent: async () => { await administration.assertCurrent(); await this.assertRuntimeFence(context) } })
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
          : method === 'connection.delivery.source.recover' ? delivery.recoverSource
            ? await delivery.recoverSource(parseConnectionDeliveryParams(method, params), { ...administration,
              assertCurrent: async () => { await administration.assertCurrent(); await this.assertRuntimeFence(context) } })
            : (() => { throw new AgentMuxError('Original source recovery is unavailable on this Host.', 'CONTROL_UNAVAILABLE') })()
          : await delivery.retry(parseConnectionDeliveryParams(method, params), { ...administration,
            assertCurrent: async () => { await administration.assertCurrent(); await this.assertRuntimeFence(context) } })
        return parseConnectionResult(method, result, input) as unknown as AgentMuxRpcResult<M>
      }
      if (method === 'connection.ingress.inspect' || method === 'connection.ingress.ls' || method === 'connection.ingress.authority' || method === 'connection.ingress.record-authority' || method === 'connection.ingress.rejoin') {
        if (!owner.ingress) throw new AgentMuxError('Ingress observation is unavailable on this Host. Existing Agents and inputs remain available.', 'CONTROL_UNAVAILABLE')
        const result = method === 'connection.ingress.rejoin' ? owner.ingress.rejoin
          ? await owner.ingress.rejoin(parseConnectionParams(method, params), { ...administration, assertCurrent: async () => { await administration.assertCurrent(); await this.assertRuntimeFence(context) } })
          : (() => { throw new AgentMuxError('Original ingress recovery is unavailable on this Host.', 'CONTROL_UNAVAILABLE') })()
          : method === 'connection.ingress.record-authority' ? await owner.ingress.recordAuthority(parseConnectionParams(method, params))
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
        // Refused operations have no binding subject for managed discovery authorization.
        // Keep their original receipts readable without exposing other current relationships.
        if (caller && method === 'connection.binding.inspect') {
          const inspection = result as import('./room-binding-contract.js').RoomBindingInspection
          delete inspection.access
          delete inspection.mappingConflict
        }
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
      const caller = method === 'device.link' ? await this.authenticated(context, true) : undefined
      const linkReader = method === 'device.link' && caller?.hostId === 'local'
      if (method === 'device.hello' ? !device : !local && !linkReader) throw new AgentMuxError('This device operation requires its authorized transport principal.', 'CONTROL_PERMISSION_DENIED')
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
        ...(inputContext.retainAcceptedInputAuthority ? { retainAcceptedInputAuthority: inputContext.retainAcceptedInputAuthority } : {}),
        ...(this.ports.operationSource?.(context) ? { sourceDevice: this.ports.operationSource!(context) } : {}),
        ...(this.ports.recordDeviceOperation ? { recordDeviceOperation: this.ports.recordDeviceOperation } : {}),
        ...(context.afterResponse ? { afterResponse: context.afterResponse } : {})
      }) as AgentMuxRpcResult<M>
    }
    await this.assertRuntimeFence(context)
    if (method === 'agent.creation.inspect' || method === 'agent.creation.resolve') {
      const resolving = method === 'agent.creation.resolve'
      if (resolving && (context.caller !== undefined || !context.principal || !['user', 'device'].includes(context.principal.kind))) throw new AgentMuxError(
        'Resolving a creation requires a transport-approved user/device, without a managed Agent caller.', 'CONTROL_PERMISSION_DENIED')
      const request = resolving ? parseCreationResolveParams(params) : parseCreationInspectParams(params), { hostId, ...input } = request
      const scopes = (await this.ports.coreClients?.() ?? []).filter(scope => scope.hostId === hostId)
      if (scopes.length !== 1 || this.endpointUnverified(scopes[0]!.client)) throw new AgentMuxError('The original creation Host is unavailable or ambiguous. Its identity is retained.', 'CONTROL_UNAVAILABLE')
      context.signal?.throwIfAborted(); await this.inputCallContext(context).assertCurrent?.(); context.signal?.throwIfAborted()
      const scope = scopes[0]!, original = { ...input, hostId: 'local' }
      const inspection = scope.client.forwardRpc
        ? parseCreationInspectionResult(resolving
          ? await scope.client.forwardRpc('agent.creation.resolve', original as import('./agent-creation-resolution.js').AgentMuxCreationResolveParams, await this.inputForwardContext(context))
          : await scope.client.forwardRpc('agent.creation.inspect', original, await this.inputForwardContext(context)), original).inspection
        : resolving ? parseCreationInspection(await scope.client.resolveAgentCreation(input as import('./agent-creation-resolution.js').AgentMuxCreationResolveInput, { ...(context.signal ? { requestSignal: context.signal } : {}), ...(context.assertCurrent ? { assertCurrent: context.assertCurrent } : {}) }), input)
          : parseCreationInspection(await scope.client.inspectAgentCreation(input), input)
      return { hostId, inspection } as AgentMuxRpcResult<M>
    }
    if (method === 'agent.creation.continue') {
      if (context.caller !== undefined || !context.principal || !['user', 'device'].includes(context.principal.kind)) throw new AgentMuxError(
        'Continuing a creation wait requires a transport-approved user or device, without a managed Agent caller.', 'CONTROL_PERMISSION_DENIED')
      rpcString(context.principal.id, 'Transport principal')
      const request = parseCreationContinueParams(params), { hostId, ...input } = request
      // This action borrows an existing exact owner; it never opens a replacement local Runtime.
      const scopes = (await this.ports.coreClients?.() ?? []).filter(scope => scope.hostId === hostId)
      if (scopes.length !== 1 || this.endpointUnverified(scopes[0]!.client)) throw new AgentMuxError(
        'The original creation Host is unavailable or ambiguous. No creation was reconstructed.', 'CONTROL_UNAVAILABLE')
      context.signal?.throwIfAborted(); await this.inputCallContext(context).assertCurrent?.()
      context.signal?.throwIfAborted()
      const scope = scopes[0]!
      const receipt = scope.client.forwardRpc
        ? parseCreationContinueResult(await scope.client.forwardRpc('agent.creation.continue', { ...input, hostId: 'local' }, await this.inputForwardContext(context)), { ...input, hostId: 'local' })
        : parseCreationContinueReceipt(await scope.client.continueAgentCreation(input), input)
      return { ...receipt, hostId } as AgentMuxRpcResult<M>
    }
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
    if (isHostMaintenanceMethod(method)) {
      const maintenanceMethod: import('./public-rpc-host-maintenance.js').HostMaintenanceMethod = method
      const input = parseHostMaintenanceParams(maintenanceMethod, params)
      const caller = await this.authenticated(context)
      if (method === 'settings.hosts.maintenance-review' && caller &&
          (context.principal?.kind !== 'user' || caller.hostId !== 'local' || context.routeDelegation)) throw new AgentMuxError(
        'Agent maintenance requires its original user operator transport and local authenticated identity.', 'CONTROL_PERMISSION_DENIED')
      if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind))) throw new AgentMuxError(
        'Maintenance requests require their original authenticated actor.', 'CONTROL_PERMISSION_DENIED')
      const sourceRuntimeId = caller?.client.runtimeOwnerIdentity?.()?.runtimeId
      const actor: HostMaintenanceActor = caller ? { kind: 'agent', id: caller.agentSessionId, hostId: caller.hostId, ...(sourceRuntimeId ? { runtimeId: sourceRuntimeId } : {}), ...(caller.session.run ? { runId: caller.session.run.runId } : {}) }
        : { kind: context.principal!.kind as 'user' | 'device', id: rpcString(context.principal!.id, 'Original transport principal') }
      const assertCurrent = async () => {
        context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
        if (context.caller) await this.authenticated(context)
      }
      await assertCurrent()
      if (!this.ports.hostMaintenance) {
        // The original client may own configuration/review in another process.
        // Authenticate and fence at this Core before using its explicit bridge;
        // the destination still authenticates the original actor itself.
        if (this.ports.forwardControl) return parseHostMaintenanceResult(
          maintenanceMethod, await this.ports.forwardControl(maintenanceMethod, input, context), input) as AgentMuxRpcResult<M>
        throw new AgentMuxError('The original Host configuration service has no maintenance review owner. Existing checks, operations and healthy Runs remain available.', 'CONTROL_UNAVAILABLE')
      }
      const record = method === 'settings.hosts.maintenance-request'
        ? await this.ports.hostMaintenance.request(input as HostMaintenanceParamsMap['settings.hosts.maintenance-request'], actor, assertCurrent)
        : method === 'settings.hosts.maintenance-review'
          ? await this.ports.hostMaintenance.review(input as HostMaintenanceParamsMap['settings.hosts.maintenance-review'], actor, assertCurrent)
          : await this.ports.hostMaintenance.inspect(input.operationId, actor)
      return parseHostMaintenanceResult(maintenanceMethod, { record }, input) as AgentMuxRpcResult<M>
    }
    if (method === 'settings.hosts.tailcat.inspect' || method === 'settings.hosts.tailcat.configure') {
      const input = parseTailcatConfigurationParams(method, params)
      if (method === 'settings.hosts.tailcat.configure') assertTailcatConfigurationWriter(context)
      if (!this.ports.tailcatConfiguration && !this.ports.forwardControl) throw new AgentMuxError('The answering App has no original Tailcat configuration owner. Existing Host/Agent capabilities remain available.', 'CONTROL_UNAVAILABLE')
      await this.authenticated(context)
      context.signal?.throwIfAborted()
      const result = this.ports.tailcatConfiguration
        ? await this.ports.tailcatConfiguration.call(method, input, context)
        : await this.ports.forwardControl!<TailcatConfigurationMethod>(method, input, context)
      return parseTailcatConfigurationResult(method, result, input) as AgentMuxRpcResult<M>
    }
    if (isTailcatKeyMethod(method)) {
      const input = parseTailcatKeyParams(params)
      if (context.caller !== undefined || context.principal?.kind !== 'user') {
        throw new AgentMuxError('Preparing a Tailcat key requires a transport-approved user without a managed Agent caller.', 'CONTROL_PERMISSION_DENIED')
      }
      await this.authenticated(context)
      if (!this.ports.hostTailcatKey) throw new AgentMuxError('This Host cannot prepare Tailcat keys. No key was created or changed.', 'CONTROL_UNAVAILABLE')
      context.signal?.throwIfAborted()
      await context.assertCurrent?.()
      context.signal?.throwIfAborted()
      const result = await this.ports.hostTailcatKey({ role: input.role, key: input.key ?? AGENTMUX_TAILCAT_DEFAULT_KEYS[input.role] }, context.signal)
      return parseTailcatKeyResult(result, input) as AgentMuxRpcResult<M>
    }
    if (method === 'node.locate') {
      const input = parseNodeLocateParams(params)
      if (!this.ports.nodeLocatorHosts && !this.ports.coreClients && !this.local) throw new AgentMuxError('This endpoint has no original configured Node scope to observe. Existing Node and Agent capabilities remain available.', 'NODE_LOCATION_SCOPE_UNAVAILABLE')
      if (context.caller && !this.ports.coreClients && !this.local) throw new AgentMuxError('The original caller owner is unavailable for this location request. Keep the original credentials; existing Agents remain available.', 'CONTROL_UNAVAILABLE')
      await this.authenticated(context)
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      const hostIds = await Promise.resolve().then(() => this.ports.nodeLocatorHosts ? this.ports.nodeLocatorHosts() : this.clients().then(scopes => scopes.map(scope => scope.hostId))).catch(() => { throw new AgentMuxError('The original configured Node scope is unavailable. Restore its Host settings and locate again; existing Agents remain available.', 'NODE_LOCATION_SCOPE_UNAVAILABLE') })
      // One fixed published read per admitted scope. The original transport
      // authenticates that target; A's caller is never presented as B's identity.
      return await locatePublishedNodes(input, hostIds,
        hostId => this.call('node.inspect', { hostId }, { ...(context.signal ? { signal: context.signal } : {}) }), context.signal) as AgentMuxRpcResult<M>
    }
    if (isMeshNetworkMethod(method)) {
      const meshMethod = method
      let input: import('./mesh-network.js').MeshNetworkParams[typeof meshMethod]
      try { input = parseMeshNetworkParams(meshMethod, params) } catch (error) { if (meshMethod === 'settings.mesh.configure') throw meshConfigurationNotApplied(error); throw error }
      const current = async () => {
        const caller = await this.authenticated(context, true)
        if (meshMethod.startsWith('settings.mesh.')) {
          if (caller && caller.hostId !== 'local' || context.principal?.kind !== 'user' || !context.principal.id.trim() || context.routeDelegation) throw new AgentMuxError('Mesh settings require the original user operator transport and verified local caller.', 'CONTROL_PERMISSION_DENIED')
        } else if (context.routeDelegation || !context.principal || !['user', 'device'].includes(context.principal.kind)) throw new AgentMuxError('Mesh observations require the original authenticated user or device.', 'CONTROL_PERMISSION_DENIED')
        context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      }
      try {
        await current()
        if (!this.ports.callOriginalCore && !this.ports.meshNetwork) throw new AgentMuxError('This original Core has no composed Mesh owner. Existing services remain available.', 'MESH_OWNER_UNAVAILABLE')
      } catch (error) { if (meshMethod === 'settings.mesh.configure') throw meshConfigurationNotApplied(error); throw error }
      // Desktop borrows this original Core; its presentation server has no durable
      // network owner. Keep the original actor/fence and do not reclassify a lost
      // remote write acknowledgement as a local, pre-dispatch refusal.
      if (this.ports.callOriginalCore) return parseMeshNetworkResult(meshMethod,
        await this.ports.callOriginalCore<MeshNetworkMethod>('local', meshMethod, input, context), input) as AgentMuxRpcResult<M>
      return parseMeshNetworkResult(meshMethod, await this.ports.meshNetwork!.call(meshMethod, input, current), input) as AgentMuxRpcResult<M>
    }
    if (isNodePublishingMethod(method)) {
      const nodeMethod: NodePublishingMethod = method
      const input = parseNodePublishingParams(nodeMethod, params)
      const caller = await this.authenticated(context)
      const ownerMethod = nodeMethod.startsWith('settings.node.')
      const operatorPolicy = nodeMethod === 'settings.node.inspect' || nodeMethod === 'settings.node.configure'
      if (ownerMethod && (caller && (!operatorPolicy || caller.hostId !== 'local') || context.principal?.kind !== 'user' || !context.principal.id.trim() || context.routeDelegation)) {
        throw new AgentMuxError('Node owner settings require the original user operator transport and authenticated local caller.', 'CONTROL_PERMISSION_DENIED')
      }
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      if (operatorPolicy) {
        const policyMethod = nodeMethod as 'settings.node.inspect' | 'settings.node.configure'
        const policyInput = input as import('./node-publishing.js').NodePublishingParams[typeof policyMethod]
        const { target, ...original } = policyInput
        if (!target || target.hostId === 'local') {
          if (target && this.ports.nodePublishing) await this.ports.nodePublishing.call('node.inspect', { hostId: 'local', expectedRuntimeId: target.expectedRuntimeId }, context.signal)
          if (this.ports.nodePublishing) return parseNodePublishingResult(policyMethod, await this.ports.nodePublishing.call(policyMethod, original, context.signal), policyInput) as AgentMuxRpcResult<M>
        } else {
          const readConfiguration = () => {
            const saved = this.ports.hostConfiguration?.(target.hostId)
            if (!saved) return null
            const { label: _label, ...route } = saved
            return structuredClone(route)
          }
          const configuration = readConfiguration()
          const routes = (await this.clients()).filter(route => route.hostId === target.hostId)
          if (!configuration || routes.length !== 1) throw new AgentMuxError('Select one original saved operator Host for this Node policy operation.', 'UNKNOWN_HOST')
          const client = routes[0]!.client
          const assertCurrent = async () => {
            context.signal?.throwIfAborted(); await context.assertCurrent?.()
            if (caller) await this.authenticated(context)
            const current = (await this.clients()).filter(route => route.hostId === target.hostId)
            if (current.length !== 1 || current[0]!.client !== client || !isDeepStrictEqual(configuration, readConfiguration())) throw new AgentMuxError('The original Node policy route changed. Keep the target and read it again.', 'RUNTIME_OWNER_MISMATCH')
          }
          // Only this policy operation borrows the saved carrier. Its receiving
          // Core independently authenticates that operator; A's capability is not B's.
          const call = <T extends 'runtime.owner.identity' | 'settings.node.inspect' | 'settings.node.configure'>(method: T, value: AgentMuxRpcParams<T>, readContext: AgentMuxRpcCallContext): Promise<AgentMuxRpcResult<T>> => {
            if (this.ports.callOriginalCore) return this.ports.callOriginalCore(target.hostId, method, value, readContext)
            if (client.forwardRpc) return client.forwardRpc(method, value, readContext)
            throw new AgentMuxError('The original Node operator transport is unavailable.', 'CONTROL_UNAVAILABLE')
          }
          const readContext = context.signal ? { signal: context.signal } : {}
          const { owner } = await call('runtime.owner.identity', { expectedRuntimeId: target.expectedRuntimeId }, readContext)
          await assertCurrent()
          if (owner.runtimeId !== target.expectedRuntimeId) throw new AgentMuxError('The original Node Runtime changed before policy inspection.', 'RUNTIME_OWNER_MISMATCH')
          const result = await call(policyMethod, original, { ...readContext, runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
          await assertCurrent()
          if (result.node.runtimeId !== owner.runtimeId || result.node.ownerInstanceId !== owner.ownerInstanceId) throw new AgentMuxError('The original Node owner instance changed during policy inspection. Read this target again.', 'RUNTIME_OWNER_MISMATCH')
          return parseNodePublishingResult(policyMethod, result, policyInput) as AgentMuxRpcResult<M>
        }
      }
      const hostId = ownerMethod ? 'local' : (input as import('./node-publishing.js').NodeRoute).hostId
      let result: unknown
      if (hostId === 'local' && this.ports.nodePublishing) result = await this.ports.nodePublishing.call(nodeMethod, input, context.signal)
      else if (this.ports.callOriginalCore) {
        result = await this.ports.callOriginalCore(hostId, nodeMethod, (ownerMethod ? input : { ...input, hostId: 'local' }) as import('./node-publishing.js').NodePublishingParams[NodePublishingMethod], ownerMethod ? context : { ...(context.signal ? { signal: context.signal } : {}) })
      } else {
        const routes = (await this.clients()).filter(route => route.hostId === hostId)
        if (routes.length !== 1 || !routes[0]!.client.forwardRpc) throw new AgentMuxError('The exact original Node route is unavailable or ambiguous. Existing Agents and owner access remain available.', 'UNKNOWN_HOST')
        const client = routes[0]!.client
        if (ownerMethod) result = await client.forwardRpc!(nodeMethod, input, context)
        else {
          // Only this finite publication read borrows the authenticated carrier.
          // The target applies its committed policy for every caller. This cannot
          // be used to launder managed credentials into an arbitrary owner RPC.
          result = await client.forwardRpc!(nodeMethod, { ...input, hostId: 'local' }, { ...(context.signal ? { signal: context.signal } : {}) })
        }
      }
      return parseNodePublishingResult(nodeMethod, result, input) as AgentMuxRpcResult<M>
    }
    if (method === 'notebook.storage.inspect' || method === 'notebook.storage.change') {
      const input = parseNotesStorageParams(method, params)
      await this.authenticated(context)
      context.signal?.throwIfAborted()
      const result = this.ports.notesStorage
        ? await this.ports.notesStorage.call(method, input)
        : this.ports.forwardControl ? await this.ports.forwardControl<NotesStorageMethod>(method, input, context)
        : (() => { throw new AgentMuxError('The original Notes storage owner is unavailable. Keep the original operation and Notes directory; this call did not move or convert files.', 'CONTROL_UNAVAILABLE') })()
      return parseNotesStorageInspection(result, input.operationId) as AgentMuxRpcResult<M>
    }
    if (method === 'agent.provider.ls') {
      const query = parseProviderCatalogQuery(params)
      // A declaration read never creates the service's lazy SDK/Native connection, including caller admission.
      if (!this.ports.coreClients && !this.local) throw new AgentMuxError('The original Provider source is unavailable. No Runtime was started.', 'CONTROL_UNAVAILABLE')
      await this.authenticated(context)
      const targets = (await this.clients()).filter(entry => entry.hostId === query.hostId)
      context.signal?.throwIfAborted()
      if (!targets.length && this.ports.forwardControl) {
        return parseProviderCatalogObservation(await this.ports.forwardControl<ProviderCatalogMethod>(method, query, context), query) as AgentMuxRpcResult<M>
      }
      if (targets.length !== 1) throw new AgentMuxError('The exact Provider source Host is unknown or ambiguous.', targets.length ? 'AMBIGUOUS_AGENT_SESSION' : 'UNKNOWN_HOST')
      const client = targets[0]!.client
      let result: import('./public-rpc-provider-catalog.js').ProviderCatalogObservation
      if (this.ports.callOriginalCore || client.forwardRpc) {
        // Only this fixed public read borrows the target transport; the source
        // Agent capability cannot authenticate as an Agent of another Host.
        const originalQuery = { ...query, hostId: 'local' }, originalContext = context.signal ? { signal: context.signal } : {}
        const original = this.ports.callOriginalCore
          ? await this.ports.callOriginalCore(query.hostId, 'agent.provider.ls', originalQuery, originalContext)
          : await client.forwardRpc!('agent.provider.ls', originalQuery, originalContext)
        result = { ...parseProviderCatalogObservation(original, { ...query, hostId: 'local' }), routeHostId: query.hostId }
      } else {
        const catalog = client.catalog().filter(entry => query.providerId === undefined || entry.id === query.providerId)
        let runtimeId: string | null = null
        try {
          const owner = client.runtimeOwnerIdentity?.() ?? (this.ports.hostedRuntime ? (await (await this.ports.hostedRuntime()).call('runtime.owner.identity', {})).owner : null)
          runtimeId = owner?.availability === 'connected' ? owner.runtimeId : null
        } catch { context.signal?.throwIfAborted() /* Owner observation is optional for pure declarations. */ }
        result = { routeHostId: query.hostId, runtimeId, observedAt: Date.now(), catalog }
      }
      const current = (await this.clients()).filter(entry => entry.hostId === query.hostId)
      if (current.length !== 1 || current[0]!.client !== client) throw new AgentMuxError('The Provider source Host changed during this read. Refresh the exact Host.', 'HOST_CONFIGURATION_CHANGED')
      context.signal?.throwIfAborted()
      return parseProviderCatalogObservation(result, query) as AgentMuxRpcResult<M>
    }
    if (isHostSettingsMethod(method)) {
      const input = parseHostSettingsParams(method, params)
      if ((method === 'settings.hosts.inspect' || method === 'settings.hosts.network' || method === 'settings.hosts.home' || method === 'settings.hosts.agent-resources') && !this.ports.coreClients && !this.local) throw new AgentMuxError(
        'No existing Host Runtime client is available to observe. This read did not start a Runtime.', 'CONTROL_UNAVAILABLE')
      if ((method === 'settings.hosts.trust-source' || method === 'settings.hosts.trust-message-source') &&
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
      if (method === 'settings.hosts.inspect' || method === 'settings.hosts.network' || method === 'settings.hosts.home' || method === 'settings.hosts.agent-resources') {
        const query = parseHostSettingsParams(method, params)
        const configuration = structuredClone(this.ports.hostConfiguration?.(input.hostId) ?? null)
        if (query.expected !== undefined && !(method === 'settings.hosts.home'
          ? isDeepStrictEqual(homeHostRoute(query.expected), homeHostRoute(configuration))
          : isDeepStrictEqual(query.expected, configuration))) throw new AgentMuxError(
          'The original Host configuration changed or could not be confirmed. Reload this connection before observing it.', 'HOST_CONFIGURATION_CHANGED')
        if (method === 'settings.hosts.home') {
          const homeInput = input as import('./public-rpc-host-settings.js').HostSettingsParameterMap['settings.hosts.home']
          const environment = await observeRead(Promise.resolve().then(() => homeInput.agentSessionId === undefined
            ? client.hostEnvironment()
            : client.hostEnvironment({ agentSessionId: homeInput.agentSessionId })), context.signal)
          const result = { routeHostId: input.hostId, ...environment }
          const current = (await this.clients()).filter(entry => entry.hostId === input.hostId)
          if (current.length !== 1 || current[0]!.client !== client || !isDeepStrictEqual(homeHostRoute(configuration), homeHostRoute(this.ports.hostConfiguration?.(input.hostId) ?? null))) throw new AgentMuxError(
            'The original Host route changed during its home read. Read the current saved Host again.', 'HOST_CONFIGURATION_CHANGED')
          return parseHostSettingsResult(method, result, input) as AgentMuxRpcResult<M>
        }
        const readOwner = async () => {
          if (client.runtimeOwnerIdentity) return client.runtimeOwnerIdentity()
          const owner = await this.ports.hostedRuntime?.()
          return owner?.client === client ? (await owner.call('runtime.owner.identity', {})).owner : null
        }
        if (method === 'settings.hosts.network' && configuration === null) throw new AgentMuxError('The saved Host configuration is unavailable. No network probe was sent.', 'HOST_CONFIGURATION_CHANGED')
        const result = method === 'settings.hosts.agent-resources'
          ? await observeHostAgentResources(parseHostSettingsParams('settings.hosts.agent-resources', params), client, readOwner, context.signal)
          : method === 'settings.hosts.inspect'
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
        if (method === 'settings.hosts.inspect' && this.ports.hostTailcat) {
          try {
            const tailcat = await observeRead(Promise.resolve().then(() => this.ports.hostTailcat!(input.hostId, context.signal)), context.signal)
            if (tailcat !== undefined) (result as import('./host-runtime-observation.js').HostRuntimeObservation).tailcat = parseTailcatListenerObservation(tailcat)
          } catch {
            context.signal?.throwIfAborted()
            ;(result as import('./host-runtime-observation.js').HostRuntimeObservation).tailcat = {
              state: 'unknown', detail: 'The Tailcat listener observation is unavailable. Original Host facts and Agents are retained; refresh this observation.'
            }
          }
          ;(result as import('./host-runtime-observation.js').HostRuntimeObservation).completedAt = Date.now()
        }
        const current = (await this.clients()).filter(entry => entry.hostId === input.hostId)
        if (current.length !== 1 || current[0]!.client !== client || !isDeepStrictEqual(configuration, this.ports.hostConfiguration?.(input.hostId) ?? null)) throw new AgentMuxError(
          'The original Host route changed during this observation. Read the current saved connection again.', 'HOST_CONFIGURATION_CHANGED')
        return parseHostSettingsResult(method, result, input) as AgentMuxRpcResult<M>
      }
      if (method !== 'settings.executors.discover' && method !== 'settings.executors.register' && method !== 'settings.executors.unregister') await client.connect()
      if (method === 'settings.executors.discover') {
        const query = parseHostSettingsParams('settings.executors.discover', params)
        const result = { routeHostId: query.hostId, ...await client.listHostExecutors({ refresh: query.refresh ?? true,
          ...(query.executorId === undefined ? {} : { executorId: query.executorId }) }) }
        return parseHostSettingsResult(method, result, input) as AgentMuxRpcResult<M>
      }
      if (method === 'settings.executors.unregister') {
        const query = parseHostSettingsParams('settings.executors.unregister', params)
        const result = { routeHostId: query.hostId, ...await client.removeHostExecutor({ executorId: query.executorId, expectedRegistrationRevision: query.expectedRegistrationRevision }) }
        return parseHostSettingsResult(method, result, input) as AgentMuxRpcResult<M>
      }
      if (method === 'settings.executors.register') {
        const query = parseHostSettingsParams('settings.executors.register', params)
        const result = { routeHostId: query.hostId, ...await client.configureHostExecutor({ executorId: query.executorId, ...query.input }) }
        return parseHostSettingsResult(method, result, input) as AgentMuxRpcResult<M>
      }
      if (method === 'settings.hosts.message-trusted-sources' || method === 'settings.hosts.trust-message-source') {
        const authority = await client.agentMessageAuthority()
        const result = method === 'settings.hosts.message-trusted-sources' ? { routeHostId: input.hostId, authority, sources: await client.listTrustedMessageSources() }
          : { routeHostId: input.hostId, authority, source: await client.trustMessageSource((input as import('./public-rpc-host-settings.js').HostSettingsParameterMap['settings.hosts.trust-message-source']).input,
            client.runtimeOwnerIdentity ? undefined : { kind: 'user', id: rpcString(context.principal!.id, 'Transport principal') }) }
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
    if (method === 'agent.open') {
      if ((params as AgentMuxRpcParams<'agent.open'>).content.kind === 'takeover-agent' && this.ports.callOriginalCore) return await this.ports.callOriginalCore('local', method, params, context)
      await this.prepareTakeover(params as AgentMuxRpcParams<'agent.open'>, context)
      params = await this.expandDerivedAction(params as AgentMuxRpcParams<'agent.open'>, context) as typeof params
      const request = rpcControlRequest('agent.open', params)
      if (isSpatialAgentAssociation(request)) {
        context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      }
      if (request.operation === 'agent.open' && request.moteMain) {
        // This correlation reserves a person's initial Main setup; ordinary Agent creation stays independent.
        if (context.caller !== undefined || !context.principal || !['user', 'device'].includes(context.principal.kind) ||
            typeof context.principal.id !== 'string' || !context.principal.id.trim() || context.principal.id.includes('\0')) {
          throw new AgentMuxError('Main creation setup requires a transport-approved user or device without a managed Agent caller. Read the original creation with space inspect.', 'CONTROL_PERMISSION_DENIED')
        }
        context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
        const intent=request.moteMain
        if(intent.rollover) {
          const existing=(await this.spatial.read())?.graph
          if(!existing||!spatialAgentOpenRecord(existing,request.requestId)) {
            const main=await this.ports.moteDialogue?.mainInput?.readCurrentMoteMain(intent.target,context.signal)
            const key=intent.rollover.queryInputKey
            if(!key||key.kind!=='prompt'||key.agentSessionId!==intent.rollover.reference.sessionId||key.submissionId!==intent.rollover.queryOperationId)throw new AgentMuxError('The original rollover Query key is unconfirmed. Keep this request and inspect its original input.','MOTE_MAIN_CHANGED')
            const journal=await this.messageRouteJournal()
            const sources=(await this.clients()).filter(scope=>scope.hostId===intent.rollover!.reference.hostId),source=sources.length===1?sources[0]:undefined
            if(!source||this.endpointUnverified(source.client))throw new AgentMuxError('The original rollover Query owner is unavailable. Keep its original key.','CONTROL_UNAVAILABLE')
            const original=await this.inspectMainInputAt(source,key,context)
            const routed=main?.identity?await journal.readMoteMainInputRoute(main.identity,key.submissionId):null
            if(routed||original.input||original.record)throw new AgentMuxError('This Query already belongs to its original input producer. No new Main was created.','MOTE_MAIN_INPUT_PREEXISTING')
            const decision=main&&await this.evaluateMoteRollover(main,key,journal,context)
            const frozen=(value:import('./mote/main-period.js').MoteMainRolloverDecision)=>{const {evaluatedAt:_now,...original}=value;return original}
            if(decision?.status!=='due'||!decision.decision||request.requestId!==intent.rollover.creationOperationId||intent.deferredInput?.operationId!==intent.rollover.queryOperationId||!isDeepStrictEqual(frozen(decision.decision),frozen(intent.rollover)))throw new AgentMuxError('The original rollover policy, role or activity changed. Keep this Query and inspect its original source.','MOTE_MAIN_CHANGED')
          }
        }
      }
      if (request.operation === 'agent.open' && request.content.kind === 'new-agent' && request.content.toolWorkspaceId !== undefined) {
        // Check before forwarding to a presentation owner: this mode carries the same resource authority as execution.create.
        if (context.caller !== undefined || !context.principal || !['user', 'device'].includes(context.principal.kind) ||
            typeof context.principal.id !== 'string' || !context.principal.id.trim() || context.principal.id.includes('\0')) {
          throw new AgentMuxError('Opening an Agent with a tool Workspace requires a transport-approved user or device without a managed Agent caller.', 'CONTROL_PERMISSION_DENIED')
        }
        context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      }
    }
    if (method === 'agent.execution.admit' || method === 'agent.execution.create' || method === 'agent.execution.continue' || method === 'agent.execution.binding' || method === 'agent.execution.rejoin' || method === 'agent.execution.watch') {
      assertExecutionBindingAuthority(context)
      const input = method === 'agent.execution.admit' || method === 'agent.execution.create' ? parseAgentExecutionCreate(params) : method === 'agent.execution.continue' ? parseAgentExecutionReference(params) : parseAgentExecutionBinding(params, { associationView: method === 'agent.execution.binding' })
      const owner = this.ports.executionBindings
      if (!owner) throw new AgentMuxError('The original execution binding owner is unavailable. No helper or Agent was replaced.', 'CONTROL_UNAVAILABLE')
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      if (method === 'agent.execution.admit' && !owner.admit) throw new AgentMuxError('The original Core cannot acknowledge a complete frozen execution intent. No Source placement or start was made.', 'CONTROL_UNAVAILABLE')
      const result = method === 'agent.execution.admit' ? await owner.admit!(input as import('./agent-execution-coordinator.js').AgentExecutionOpenInput, context)
        : method === 'agent.execution.create' ? await owner.create(input as import('./agent-execution-coordinator.js').AgentExecutionOpenInput, context)
        : method === 'agent.execution.continue' ? await owner.continueOriginal(input as import('./agent-execution-contract.js').AgentExecutionReference, context)
        : method === 'agent.execution.rejoin' ? await owner.rejoin(input.bindingId, context) : await owner.inspect(input.bindingId, 'view' in input && input.view === 'association' ? 'association' : undefined, context)
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      return parseRpcNativeResult(method, method === 'agent.execution.watch' ? { bindingId: input.bindingId, inspection: result } : result, input) as AgentMuxRpcResult<M>
    }
    if (method === 'agent.execution.inspect') {
      if (context.caller !== undefined || !context.principal || !['user', 'device'].includes(context.principal.kind) ||
          typeof context.principal.id !== 'string' || !context.principal.id.trim() || context.principal.id.includes('\0')) {
        throw new AgentMuxError('Tool operation inspection requires a transport-approved user or device.', 'CONTROL_PERMISSION_DENIED')
      }
      const input = rpcRecord(params, NATIVE_FIELDS['agent.execution.inspect'])
      const hostId = rpcString(input.hostId, 'Original execution Host')
      const key = { bindingId: rpcString(input.bindingId, 'Original execution binding'),
        streamGeneration: rpcString(input.streamGeneration, 'Original stream generation'), nativeRequestId: input.nativeRequestId }
      if (!(typeof key.nativeRequestId === 'string' || typeof key.nativeRequestId === 'number' && Number.isSafeInteger(key.nativeRequestId))) {
        throw new AgentMuxError('Native request identity must be its original JSON string or safe integer.', 'INVALID_CONTROL_REQUEST')
      }
      const exactKey = { ...key, nativeRequestId: key.nativeRequestId as string | number }
      const scopes = (await this.clients(hostId)).filter(scope => scope.hostId === hostId)
      if (scopes.length !== 1) throw new AgentMuxError('Tool operation inspection requires one exact configured Host route.', 'UNKNOWN_HOST')
      const { client } = scopes[0]!
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      const result = client.forwardRpc
        ? await client.forwardRpc('agent.execution.inspect', { hostId: 'local', ...exactKey }, context)
        : await client.inspectAgentExecutionOperation(exactKey)
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      return parseRpcNativeResult(method, result, { hostId, ...exactKey }) as AgentMuxRpcResult<M>
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
    if (method === 'agent.stop.inspect') {
      if (context.caller !== undefined || !context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id) {
        throw new AgentMuxError('Inspecting a Stop requires a transport-approved user or device.', 'CONTROL_PERMISSION_DENIED')
      }
      const input = parseAgentStopIdentity(params)
      // A Stop's Session is either still active or already retired; both are this owner's history sources.
      // An exact point read per Host: the owner probe never reads unrelated Sessions or retirement history.
      const owners = (await Promise.all((await this.clients()).map(async entry => ({ ...entry,
        sources: await entry.client.sessionHistorySources({ agentSessionId: input.agentSessionId, ...(context.signal ? { signal: context.signal } : {}) }) }))))
        .filter(entry => entry.sources.some(source => source.agentSessionId === input.agentSessionId && source.hostId === (entry.client.forwardRpc ? 'local' : entry.hostId)))
      if (owners.length !== 1) throw new AgentMuxError('The exact Session does not have one confirmed Host owner.', owners.length ? 'AMBIGUOUS_AGENT_SESSION' : 'UNKNOWN_AGENT_SESSION')
      const client = owners[0]!.client
      context.signal?.throwIfAborted()
      if (client.forwardRpc) return await client.forwardRpc(method, input as AgentMuxRpcParams<typeof method>, context) as AgentMuxRpcResult<M>
      return parseRpcNativeResult(method, await client.inspectAgentStop(input), input) as AgentMuxRpcResult<M>
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
        sources: await entry.client.sessionHistorySources({ agentSessionId, ...(context.signal ? { signal: context.signal } : {}) }) })))
      const matches = owners.filter(entry => entry.sources.some(source => source.agentSessionId === agentSessionId &&
        source.hostId === (entry.client.forwardRpc ? 'local' : entry.hostId) && (source.state === 'retired' || method === 'agent.reopen.check')))
      if (matches.length !== 1) throw new AgentMuxError('The exact retired Session does not have one confirmed Host owner.', matches.length ? 'AMBIGUOUS_AGENT_SESSION' : 'STALE_AGENT_SESSION')
      if (matches[0]!.sources.some(source => source.agentSessionId === agentSessionId && source.hostId === (matches[0]!.client.forwardRpc ? 'local' : matches[0]!.hostId) && source.state === 'deleted')) deletedAgentSessionRecord(agentSessionId)
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
      let runtimeId = caller?.client.runtimeOwnerIdentity?.()?.runtimeId
      if (caller && !runtimeId) {
        // Original local identity is available without a new message handshake. Legacy
        // clients may lack that proof; reads remain available and mutations judge it.
        try { runtimeId = (await caller.client.agentCreationAuthority()).runtimeId } catch { /* unknown */ }
      }
      return parseGoalDelegationRpcResult(method, await this.ports.goalDelegations.call(method, input, context,
        { actor: actor as { kind: 'agent' | 'user' | 'device'; id: string },
          ...(caller ? { hostId: caller.hostId, runId: caller.session.run.runId, ...(runtimeId ? { runtimeId } : {}) } : {}) }), input) as AgentMuxRpcResult<M>
    }

    if (isCaptureSequenceMethod(method)) {
      const input = parseCaptureSequenceParams(method, params)
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      const actor = caller ? { kind: 'agent' as const, id: caller.agentSessionId }
        : context.principal && (context.principal.kind === 'user' || context.principal.kind === 'device') ? context.principal : null
      if (!actor) throw new AgentMuxError('Capture needs its authenticated original actor.', 'CONTROL_PERMISSION_DENIED')
      if (!this.ports.sequences) {
        if (!this.ports.forwardControl) throw new AgentMuxError('The Desktop sequence owner is unavailable. Other capture remains available.', 'CONTROL_UNAVAILABLE')
        return parseCaptureSequenceResult(await this.ports.forwardControl<CaptureSequenceMethod>(method, input, context), input) as AgentMuxRpcResult<M>
      }
      return parseCaptureSequenceResult(await this.ports.sequences.call(method, input, { actor, ...(context.signal ? { signal: context.signal } : {}), ...(context.assertCurrent ? { assertCurrent: context.assertCurrent } : {}) }), input) as AgentMuxRpcResult<M>
    }
    if (isAppCaptureMethod(method)) {
      const input = parseAppCaptureParams(method, params)
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      const actor: AppWindowActor | null = caller ? { kind: 'agent', id: caller.agentSessionId }
        : context.principal && ['user', 'device'].includes(context.principal.kind) ? context.principal as AppWindowActor : null
      if (!actor) throw new AgentMuxError('Capture needs its authenticated original actor.', 'CONTROL_PERMISSION_DENIED')
      if (!this.ports.captures) {
        if (!this.ports.forwardControl) throw new AgentMuxError('The Desktop capture owner is unavailable. Original work remains available.', 'CONTROL_UNAVAILABLE')
        return parseAppCaptureResult(method, await this.ports.forwardControl<AppCaptureMethod>(method, input, context), input, actor) as AgentMuxRpcResult<M>
      }
      const result = await this.ports.captures.call(method, input, { actor, ...(context.signal ? { signal: context.signal } : {}),
        ...(context.assertCurrent ? { assertCurrent: context.assertCurrent } : {}) })
      return parseAppCaptureResult(method, result, input, actor) as AgentMuxRpcResult<M>
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

      if (method === 'file.stat') {
        const input = parseFileStatParams(params)
        if (!this.ports.files?.stat && !this.ports.forwardControl) throw new AgentMuxError('The original Host Files path owner is unavailable. Existing files and Agents remain available.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files?.stat ? await this.ports.files.stat(input) : await this.ports.forwardControl!('file.stat', input, context)
        return parseFileStatResult(result, input) as AgentMuxRpcResult<M>
      }
      if (method === 'file.delete.snapshots') {
        const input = parseFileDeleteSnapshotsParams(params)
        const provenance = { actor: caller ? { kind: 'agent' as const, id: caller.agentSessionId } : context.principal,
          ...(caller ? { callerHostId: caller.hostId } : {}) }
        if (!this.ports.files?.deleteSnapshots && !this.ports.forwardControl) throw new AgentMuxError('The original deletion snapshot owner is unavailable. Keep the original request and cursor.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files?.deleteSnapshots ? await this.ports.files.deleteSnapshots(input, provenance) : await this.ports.forwardControl!('file.delete.snapshots', input, context)
        return parseFileDeleteSnapshotsResult(result, input) as AgentMuxRpcResult<M>
      }
      if (method === 'file.delete') {
        const input = parseFileDeleteParams(params)
        const provenance = { actor: caller ? { kind: 'agent' as const, id: caller.agentSessionId } : context.principal,
          ...(caller ? { callerHostId: caller.hostId } : {}), ...(context.transport ? { transport: context.transport } : {}) }
        if (!this.ports.files?.delete && !this.ports.forwardControl) throw new AgentMuxError('The original Host delete owner is unavailable. Keep the original request; no deletion was issued.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files?.delete ? await this.ports.files.delete(input, provenance) : await this.ports.forwardControl!('file.delete', input, context)
        return parseFileDeleteResult(result, input) as AgentMuxRpcResult<M>
      }
      if (method === 'file.move') {
        const input = parseFileMoveParams(params)
        const provenance = { actor: caller ? { kind: 'agent' as const, id: caller.agentSessionId } : context.principal,
          ...(caller ? { callerHostId: caller.hostId } : {}), ...(context.transport ? { transport: context.transport } : {}) }
        if (!this.ports.files?.move && !this.ports.forwardControl) throw new AgentMuxError('The original Host move owner is unavailable. Keep the original request; no move was issued.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files?.move ? await this.ports.files.move(input, provenance) : await this.ports.forwardControl!('file.move', input, context)
        return parseFileMoveResult(result, input) as AgentMuxRpcResult<M>
      }

      if (method === 'file.mkdir' || method === 'file.mutation.inspect') {
        const provenance = { actor: caller ? { kind: 'agent' as const, id: caller.agentSessionId } : context.principal,
          ...(caller ? { callerHostId: caller.hostId } : {}) }
        if (method === 'file.mkdir') {
          const input = parseFileMkdirParams(params)
          if (!this.ports.files?.mkdir && !this.ports.forwardControl) throw new AgentMuxError('The original Host directory owner is unavailable. Existing files and Agents remain available.', 'CONTROL_UNAVAILABLE')
          const result = this.ports.files?.mkdir ? await this.ports.files.mkdir(input, provenance) : await this.ports.forwardControl!('file.mkdir', input, context)
          return parseFileMkdirResult(result, input) as AgentMuxRpcResult<M>
        }
        const input = parseFileMutationInspectParams(params)
        if (!this.ports.files?.inspectMutation && !this.ports.forwardControl) throw new AgentMuxError('The original Host mutation inspector is unavailable. Keep the original operation and request.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files?.inspectMutation ? await this.ports.files.inspectMutation(input, provenance) : await this.ports.forwardControl!('file.mutation.inspect', input, context)
        return parseFileMutationInspectResult(result, input) as AgentMuxRpcResult<M>
      }

      if (method === 'file.create') {
        const input = parseFileCreateParams(params)
        context.signal?.throwIfAborted()
        if (!this.ports.files && !this.ports.forwardControl) throw new AgentMuxError('The original Host file owner is unavailable. Original files and Agents are retained.', 'CONTROL_UNAVAILABLE')
        const result = this.ports.files ? await this.ports.files.create(input, { actor: caller ? { kind: 'agent', id: caller.agentSessionId } : context.principal, ...(caller ? { callerHostId: caller.hostId } : {}) }) : await this.ports.forwardControl!('file.create', input, context)
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
    if (isObjectAvatarMethod(method)) {
      const avatarMethod: ObjectAvatarMethod = method
      const input = parseObjectAvatarParams(avatarMethod, params)
      if (!this.ports.objectAvatars && !this.ports.forwardControl) throw new AgentMuxError('The original object avatar owner is unavailable. Saved choices and existing work are retained.', 'CONTROL_UNAVAILABLE')
      const execution = this.avatarExecutionContext(context, caller)
      const result = this.ports.objectAvatars ? await this.ports.objectAvatars.call<ObjectAvatarMethod>(avatarMethod, input, execution)
        : await this.ports.forwardControl!<ObjectAvatarMethod>(avatarMethod, input, context)
      const readerIdentity = avatarActorIdentity(execution.actor)
      const projected = avatarMethod === 'space.object.avatar.read' ? { ...result, readerIdentity }
        : { ...result, current: { ...(result as import('./object-avatar.js').SpaceObjectAvatarResult).current, readerIdentity } }
      return parseObjectAvatarResult<ObjectAvatarMethod>(avatarMethod, projected, input) as AgentMuxRpcResult<M>
    }
    if (isMoteAvatarWriteMethod(method)) {
      const input = parseMoteAvatarWriteParams(method, params)
      if (!this.ports.moteAvatars && !this.ports.forwardControl) throw new AgentMuxError('The original Host avatar owner is unavailable. The saved appearance is retained.', 'CONTROL_UNAVAILABLE')
      const execution = method === 'space.mote.avatar.read' && !caller && !context.principal
        ? undefined : this.avatarExecutionContext(context, caller)
      const result = this.ports.moteAvatars ? await this.ports.moteAvatars.call<MoteAvatarWriteMethod>(method, input, execution)
        : await this.ports.forwardControl!<MoteAvatarWriteMethod>(method, input, context)
      // This public reader identity comes from the authenticated call, never the receipt
      // or an internal historical read. It cannot attribute an old actorless publication.
      const readerIdentity = execution ? avatarActorIdentity(execution.actor) : undefined
      const { readerIdentity: _untrustedReader, ...historical } = result as import('./mote/avatar-write.js').MoteAvatarRead
      const projected = method === 'space.mote.avatar.read' ? { ...historical, ...(readerIdentity ? { readerIdentity } : {}) }
        : { ...result, current: { ...(result as import('./mote/avatar-write.js').MoteAvatarSaveResult).current, readerIdentity } }
      return parseMoteAvatarWriteResult(method, projected, input) as AgentMuxRpcResult<M>
    }
    if (isMoteAvatarSeriesMethod(method)) {
      const input = parseMoteAvatarSeriesParams(method, params)
      if (!this.ports.moteAvatars && !this.ports.forwardControl) throw new AgentMuxError('The original Host avatar source owner is unavailable. Saved avatars and work remain available.', 'CONTROL_UNAVAILABLE')
      context.signal?.throwIfAborted()
      const result = this.ports.moteAvatars ? await this.ports.moteAvatars.call<MoteAvatarSeriesMethod>(method, input)
        : await this.ports.forwardControl!<MoteAvatarSeriesMethod>(method, input, context)
      return parseMoteAvatarSeriesResult(method, result, input) as AgentMuxRpcResult<M>
    }
    if (isAgentPromotionMethod(method)) {
      const input = parseAgentPromotionParams(method, params)
      const principal = context.principal
      if (method === 'agent.promote.apply' && (caller || context.caller !== undefined || context.routeDelegation ||
        !principal || !['user', 'device'].includes(principal.kind) || !principal.id.trim()))
        throw new AgentMuxError('Promotion establishes a lasting Mote role and requires its original person or device. The Agent and original work remain available.', 'CONTROL_PERMISSION_DENIED')
      if (method === 'agent.promote.inspect' && (caller ? caller.agentSessionId !== input.target.agentSessionId || caller.hostId !== input.target.hostId
        : !principal || !['user', 'device'].includes(principal.kind) || !principal.id.trim()))
        throw new AgentMuxError('Read a promotion only as its original person/device or the exact authenticated Agent.', 'CONTROL_PERMISSION_DENIED')
      context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
      if (!this.ports.agentPromotions && !this.ports.forwardControl) throw new AgentMuxError('The original Agent promotion owner is unavailable. Keep the original operation and healthy Agent.', 'CONTROL_UNAVAILABLE')
      const result = this.ports.agentPromotions ? await this.ports.agentPromotions.call(method, input, context)
        : await this.ports.forwardControl!<AgentPromotionMethod>(method, input, context)
      return parseAgentPromotionResult(method, result, input) as AgentMuxRpcResult<M>
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
    if (method === 'agent.conversation.snapshot.ls' || method === 'agent.conversation.snapshot.release') {
      const input = parseConversationSnapshotInput(params, method.endsWith('.release'))
      if (method.endsWith('.release') && (context.caller !== undefined || !context.principal || !['user', 'device'].includes(context.principal.kind))) throw new AgentMuxError('Releasing durable source evidence requires the original authenticated user or device. Read-only inspection, the original cuts and healthy Agent remain available.', 'CONTROL_PERMISSION_DENIED')
      const owners = (await this.clients()).filter(entry => entry.hostId === input.hostId)
      if (owners.length !== 1) throw new AgentMuxError('The exact original snapshot Host is unavailable.', 'RUNTIME_UNAVAILABLE')
      const client = owners[0]!.client
      const result = method.endsWith('.release') ? await client.releaseConversationSnapshot({ ...input, hostId: 'local' } as ConversationSnapshotReleaseInput)
        : await client.listConversationSnapshots({ ...input, hostId: 'local' } as ConversationSnapshotInput)
      return parseConversationSnapshotResult({ ...result, hostId: input.hostId }, input) as AgentMuxRpcResult<M>
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
        return parseConversationReadPageForWindow(page, request) as AgentMuxRpcResult<M>
      }
      const request = input as import('./conversation-changes.js').ConversationChangesInput, forwarded = forwardConversationInput(request)
      const page = await readRoutedConversation(request, (maxBytes, replay) => client.readConversationChanges({ ...forwarded.input, maxBytes, ...(replay ? { cursor: replay } : {}) }, options), forwarded.sourceHostId)
      return parseConversationChangesPageForWindow(page, request) as AgentMuxRpcResult<M>
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
    if (method === 'agent.history.record.inspect' || method === 'agent.history.record.delete') {
      const deleting = method === 'agent.history.record.delete'
      if (deleting && (context.caller !== undefined || !context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id.trim())) throw new AgentMuxError(
        'Deleting AgentMux records requires the original transport-approved person or device.', 'CONTROL_PERMISSION_DENIED')
      const input = parseAgentSessionRecordInput(params, deleting)
      const owners = (await this.clients()).filter(entry => entry.hostId === input.hostId)
      if (owners.length !== 1) throw new AgentMuxError('The exact record Host is unavailable or ambiguous. No alternate owner was selected.', 'RUNTIME_UNAVAILABLE')
      const client = owners[0]!.client, local = { ...input, hostId: 'local' }
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      if (deleting) {
        const request = local as AgentSessionRecordDeleteInput
        const raw = client.forwardRpc ? await client.forwardRpc('agent.history.record.delete', request, context)
          : await client.deleteAgentSessionRecord(request, context.signal ? { signal: context.signal } : {})
        return { ...parseAgentSessionRecordReceipt(raw, request), hostId: input.hostId } as AgentMuxRpcResult<M>
      }
      const { caller: _caller, ...readContext } = context
      const raw = client.forwardRpc ? await client.forwardRpc('agent.history.record.inspect', local, readContext)
        : await client.inspectAgentSessionRecord(local, context.signal ? { signal: context.signal } : {})
      const page = parseAgentSessionRecordInspection(raw, local)
      return { ...page, hostId: input.hostId, ...(page.state === 'deleted' ? { receipt: { ...page.receipt, hostId: input.hostId } } : {}) } as AgentMuxRpcResult<M>
    }
    if (method === 'agent.history.usage') {
      const input = parseAgentSessionUsageInput(params)
      const owners = (await this.clients()).filter(entry => entry.hostId === input.hostId)
      if (owners.length !== 1) throw new AgentMuxError('The exact usage Host owner is unavailable or ambiguous.', 'RUNTIME_UNAVAILABLE')
      const client = owners[0]!.client
      const local = { ...input, hostId: 'local' }
      context.signal?.throwIfAborted()
      const { caller: _localCaller, ...readContext } = context
      const raw = client.forwardRpc ? await client.forwardRpc('agent.history.usage', local, readContext)
        : await client.readAgentSessionUsage(local, context.signal ? { signal: context.signal } : {})
      const page = parseAgentSessionUsagePage(raw, local)
      return { ...page, hostId: input.hostId } as AgentMuxRpcResult<M>
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
    if (method === 'space.mote.preferences.save' && p.kind === 'quick' && p.action !== undefined &&
        (caller || context.caller !== undefined || !context.principal || !['user', 'device'].includes(context.principal.kind) ||
          typeof context.principal.id !== 'string' || !context.principal.id.trim())) {
      throw new AgentMuxError('Adopting Mote guidance requires its original authenticated person or device. The original arrangement and input remain available.', 'CONTROL_PERMISSION_DENIED')
    }
    const preferences = p.kind === 'quick' ? this.ports.moteQuickPreferences : this.ports.motePreferences
    if (preferences && (p.kind === 'quick' || p.kind === 'connection') &&
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
        const input = parseMotePreferencesReadInput(params)
        const result = input.kind === 'quick' ? await this.ports.moteQuickPreferences!.read(input) : await this.ports.motePreferences!.read(input)
        await administration.assertCurrent()
        return parseMotePreferencesReadResult(result, input) as AgentMuxRpcResult<M>
      }
      const input = parseMotePreferencesSaveParams(params)
      const result = input.kind === 'quick' ? await this.ports.moteQuickPreferences!.save(input, administration) : await this.ports.motePreferences!.save(input, administration)
      await administration.assertCurrent()
      const parsed = parseMotePreferencesSaveResult(result,input)
      if (input.kind === 'quick' && parsed.kind === 'quick' && !input.action) {
        // Only this original writer result enters the admission; no public receipt-submission API.
        try { await this.spatial.recordMoteMainBindingResult(input,parsed) }
        catch (error) { return { ...parsed, message:[parsed.message,'The original preference result is retained; Main admission retention is unconfirmed: ' + String(error)].filter(Boolean).join('\n') } as AgentMuxRpcResult<M> }
      }
      return parsed as AgentMuxRpcResult<M>
    }
    if (Object.hasOwn(AGENTMUX_RPC_CONTROL_METHODS, method)) {
      if (isBrowserProfileProxySignInWrite(method) && (context.caller !== undefined || !context.principal ||
          !['user', 'device'].includes(context.principal.kind) || typeof context.principal.id !== 'string' || !context.principal.id.trim())) {
        throw new AgentMuxError('Proxy sign-in changes require a person or device. The Profile, its route and Browsers remain available; ask the person to change the sign-in.',
          'BROWSER_PROFILE_PROXY_AUTH_REQUIRES_PERSON')
      }
      // Deleting a Profile clears its sign-ins and site data. Only a transport-approved person or device
      // may do it; Main builds the approval from that trusted caller, never from business params.
      if (method === 'browser.profile.delete' && (context.caller !== undefined || !context.principal ||
          !['user', 'device'].includes(context.principal.kind) || typeof context.principal.id !== 'string' || !context.principal.id.trim())) {
        throw new AgentMuxError('Deleting a Browser Profile requires a person or device, not a managed Agent. The Profile, its Browsers and the Agent remain available; ask the person to delete it.',
          'BROWSER_PROFILE_DELETE_REQUIRES_PERSON')
      }
      if ((method === 'settings.hosts.install' || method === 'settings.hosts.upgrade' || method === 'settings.hosts.upgrade-reconnect') &&
          (caller && (context.principal?.kind !== 'user' || caller.hostId !== 'local') || context.routeDelegation || !context.principal || !['user', 'device'].includes(context.principal.kind) ||
            typeof context.principal.id !== 'string' || !context.principal.id.trim() || context.principal.id.includes('\0'))) {
        throw new AgentMuxError('Core maintenance requires its original operator transport and authenticated local Agent, user or device.', 'CONTROL_PERMISSION_DENIED')
      }
      const internalCaller: AgentMuxControlCaller | undefined = caller
        ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined
      const originalControlOperation = AGENTMUX_RPC_CONTROL_METHODS[method as keyof typeof AGENTMUX_RPC_CONTROL_METHODS]
      const originalSpatialRequest = method === 'agent.open' || method === 'space.inspect' ? rpcControlRequest(method, params) : null
      const originalResumeRequest = method === 'agent.resume' ? rpcControlRequest(method, params, internalCaller) : null
      const independentResume = originalResumeRequest?.operation === 'resume' && !originalResumeRequest.text.trim()
      let independentSpatial = originalSpatialRequest && (originalSpatialRequest.operation === 'agent.open' && originalSpatialRequest.content.kind === 'takeover-agent' || isHeadlessSpatialAgentOpen(originalSpatialRequest) || isSpatialAgentAssociation(originalSpatialRequest) ||
        originalSpatialRequest.operation === 'space.inspect' && 'requestId' in originalSpatialRequest.target)
      if (independentSpatial && method === 'space.inspect') {
        const originalContext = context
        context = { ...originalContext, assertCurrent: async () => {
          originalContext.signal?.throwIfAborted(); await originalContext.assertCurrent?.(); await this.assertRuntimeFence(originalContext)
          if (caller) await this.authenticated(originalContext)
        } }
      }
      const originalSpatialState = independentSpatial && originalSpatialRequest?.operation === 'agent.open' ? await this.spatial.readForLayout() : null
      if (independentSpatial && originalSpatialRequest?.operation === 'agent.open') independentSpatial =
        originalSpatialRequest.content.kind === 'takeover-agent' || isHeadlessSpatialAgentOpen(originalSpatialRequest, originalSpatialState?.graph) || isSpatialAgentAssociation(originalSpatialRequest)
      const retainedSpatialLaunch = originalSpatialRequest?.operation === 'agent.open' && originalSpatialState &&
        spatialAgentOpenRecord(originalSpatialState.graph, originalSpatialRequest.requestId)
      if (originalSpatialRequest && isSpatialAgentAssociation(originalSpatialRequest) && !this.ports.callOriginalCore &&
          !(originalSpatialState && spatialAgentAssociationRecord(originalSpatialState.graph, originalSpatialRequest.requestId)) &&
          this.ports.spatialAgentControl?.describe?.().externalAssociation !== 1) throw new AgentMuxError(
        'The selected Source owner has not confirmed external Coordinator association. Keep this original L and A reference; no creation or association was forwarded.', 'AGENT_OPEN_CONTRACT_UNCONFIRMED')
      if (originalSpatialRequest?.operation === 'agent.open' && originalSpatialRequest.content.kind === 'new-agent' &&
          AGENT_OPEN_LAUNCH_FIELDS.some(field => Object.hasOwn(originalSpatialRequest.content, field)) &&
          (!independentSpatial || !this.ports.callOriginalCore && !retainedSpatialLaunch && this.ports.spatialAgentControl?.describe?.().ordinaryLaunch?.revision !== 1)) throw new AgentMuxError(
        'This new launch contribution needs an existing Source-owned Zone and a background destination handled by its confirmed Source owner. The legacy focused creator cannot preserve these fields. Keep the complete original request; no creation was forwarded.', 'AGENT_OPEN_CONTRACT_UNCONFIRMED')
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
          if (this.ports.callOriginalCore) {
            const original = await this.ports.callOriginalCore('local', method, params, context)
            // The Host retains its domain catalog. Only an unfiltered, explicitly
            // requested Survey observation comes from the original client owner.
            if (method !== 'space.ls' || p.presentation !== true && p.presentation !== 'status' || Object.values(target).some(Boolean) || !this.ports.spatialPresentation) return original
            const result = original as AgentMuxRpcResult<'space.ls'>
            try {
              const state = await this.spatial.readForLayout()
              if (!state) throw new AgentMuxError('The original client spatial observation is unavailable. Host resources remain available.', 'CONTROL_UNAVAILABLE')
              context.signal?.throwIfAborted()
              const observed = await this.ports.spatialPresentation({ graph: state.graph, catalog: result.catalog, target: {}, presentation: p.presentation as true | 'status' }, context)
              context.signal?.throwIfAborted()
              const candidate = { ...result.catalog, ...(observed.survey === undefined ? {} : { survey: observed.survey }) }
              // An invalid weak client observation must not poison the healthy
              // Host result when the actual public client consumes this DTO.
              parseRpcControlResult('space.ls', { catalog: candidate }, params)
              return { ...result, catalog: candidate } as AgentMuxRpcResult<M>
            } catch (error) {
              context.signal?.throwIfAborted()
              return { ...result, presentation: { region: null, tab: null,
                unavailable: [...(result.presentation?.unavailable ?? []), unavailable(error)] } } as AgentMuxRpcResult<M>
            }
          }
          const state = await this.spatial.readForLayout()
          if (!state) throw new AgentMuxError('No durable spatial graph has been registered.', 'SPATIAL_STATE_ABSENT')
          const selector = request.operation === 'space.ls' || request.operation === 'space.inspect' ? request.target as import('./space-control.js').AgentMuxSpaceSelector : {}
          context.signal?.throwIfAborted()
          const catalog = spatialCatalog(state.graph, selector)
          if ((p.presentation === true || p.presentation === 'status') && this.ports.spatialPresentation) Object.assign(catalog,
            await this.ports.spatialPresentation({ graph: state.graph, catalog, target: selector, presentation: p.presentation,
              ...(method === 'space.inspect' && typeof target.spaceId === 'string' ? { imageSpaceId: target.spaceId } : {}) }, context))
          context.signal?.throwIfAborted()
          return rpcControlResult(method, { operation: method, catalog }) as AgentMuxRpcResult<M>
        }
      }
      if (method === 'agent.stop' && p.expectedRun !== undefined) {
        const request = rpcControlRequest('agent.stop', params, internalCaller)
        if (request.operation !== 'stop' || request.target.kind !== 'agent-run' || !request.expectedRun) throw new AgentMuxError('The original Stop Run is unconfirmed.', 'INVALID_CONTROL_REQUEST')
        const selected = await this.owner(request.target.agentSessionId, true)
        context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
        if (context.caller) await this.authenticated(context)
        const exact = { target: { kind: 'agent-run' as const, agentSessionId: selected.agentSessionId }, expectedRun: request.expectedRun, operationId: request.requestId }
        if (this.ports.callOriginalCore) return await this.ports.callOriginalCore(selected.hostId, 'agent.stop', exact, await this.inputForwardContext(context)) as AgentMuxRpcResult<M>
        if (selected.client.forwardRpc) return await selected.client.forwardRpc('agent.stop', exact, await this.inputForwardContext(context)) as AgentMuxRpcResult<M>
        if (!selected.client.stopAgent) throw new AgentMuxError('The original exact-Run Stop owner is unavailable. Original work is retained.', 'CONTROL_UNAVAILABLE')
        const receipt = await selected.client.stopAgent(selected.agentSessionId, request.expectedRun, { operationId: request.requestId })
        return rpcControlResult('agent.stop', { operation: 'stop', agentSessionId: selected.agentSessionId, receipt }) as AgentMuxRpcResult<M>
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
          save: { layoutApplied: false, clientStateWritten: false, storageFlushRequested: false, diskDurability: changed.diskDurability,
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
            previous.demand.assigneeSessionIds.forEach(ref => { if (typeof ref === 'string') retained.add(ref) })
          }
          for (const assignee of assignees) if (typeof assignee === 'string' && !retained.has(assignee) && (await this.owner(assignee)).agentSessionId !== assignee)
            throw new AgentMuxError('New Goal assignment requires the complete exact Session ID.', 'INVALID_CONTROL_REQUEST')
        }
      }
      const requestedMoteAddress = request.operation === 'focus' && request.target.kind === 'mote' && request.target.address ? structuredClone(request.target) : undefined
      let resolvedMoteLink: import('./space-link.js').SpaceLinkRecord | undefined
      let operationContext = context
      if (requestedMoteAddress && request.operation === 'focus') {
        const input = {address:requestedMoteAddress.address!}
        const resolved = parseSpaceLinkResult('space.link.resolve', await this.call('space.link.resolve',input,context), input)
        if (!resolved.target) throw new AgentMuxError('The original public Mote address is not registered at its authority. Keep the link; no target was guessed.', 'SPACE_LINK_UNAVAILABLE')
        resolvedMoteLink={address:input.address,target:resolved.target}
        operationContext = this.folderDirectoryContext(resolved.source, context)
        request.target = {kind:'mote',spaceId:resolved.target.spaceId,...(resolved.target.eventId === undefined ? {} : {eventId:resolved.target.eventId})}
      }
      if (requestedMoteAddress) await operationContext.assertCurrent?.()
      result = request.operation.startsWith('toolkit.') ? await this.toolkit(request, context.signal, nameContext)
        : request.operation === 'metrics.allocations.capture' ? { operation: 'metrics.allocations.capture', capture: await this.captureAllocations({ target: request.target, durationMs: request.durationMs }, context.signal) }
        : request.operation === 'metrics.scene.capture' ? { operation: 'metrics.scene.capture', capture: await this.captureScene({ target: request.target }, context.signal) }
        : request.operation === 'metrics.scene.inspect' ? { operation: 'metrics.scene.inspect', inspection: await this.inspectScene(request.captureId === undefined ? {} : { captureId: request.captureId }, context.signal) }
        : request.operation === 'metrics.animations.inspect' ? { operation: 'metrics.animations.inspect', observation: await this.inspectAnimations({ target: request.target }, context.signal) }
        : request.operation === 'metrics.cache.inspect' ? { operation: 'metrics.cache.inspect', observation: await this.rendererCache({ target: request.target }, 'inspect', context.signal) }
        : request.operation === 'metrics.cache.reclaim' ? { operation: 'metrics.cache.reclaim', observation: await this.rendererCache({ target: request.target }, 'reclaim', context.signal) }
        : request.operation === 'metrics.memory.workers.inspect' ? { operation: 'metrics.memory.workers.inspect', observation: await this.inspectWorkers({ target: request.target }, context.signal) }
        : request.operation === 'metrics.memory.inspect' ? { operation: 'metrics.memory.inspect', observation: await this.inspectMemory({ target: request.target }, context.signal) }
        : request.operation === 'metrics.heap.capture' ? { operation: 'metrics.heap.capture', capture: await this.captureHeapSnapshot({ target: request.target, captureId: request.captureId }, context.signal) }
        : request.operation === 'metrics.heap.inspect' ? { operation: 'metrics.heap.inspect', inspection: await this.inspectHeapSnapshot(request.captureId === undefined ? {} : { captureId: request.captureId }, context.signal) }
        : request.operation === 'metrics.trace.capture' ? { operation: 'metrics.trace.capture', capture: await this.captureTrace({ target: request.target, durationMs: request.durationMs }, context.signal) }
        : request.operation === 'metrics.profile.capture' ? { operation: 'metrics.profile.capture', capture: await this.captureProfile({ target: request.target, durationMs: request.durationMs }, context.signal) }
        : request.operation === 'metrics.get' ? { operation: 'metrics.get', observation: await this.metrics(context.signal) }
        : request.operation === 'metrics.app-memory.inspect' ? { operation: 'metrics.app-memory.inspect', evidence: await this.inspectAppMemory() }
        : await this.execute(request, nameContext, operationContext)
      if (requestedMoteAddress && resolvedMoteLink) { const focus=result as AgentMuxControlResult; if(focus.operation !== 'focus' || focus.navigation.requested.kind !== 'mote' || focus.navigation.requested.address || focus.navigation.requested.spaceId !== resolvedMoteLink.target.spaceId || focus.navigation.requested.eventId !== resolvedMoteLink.target.eventId) throw new AgentMuxError('Mote navigation returned another original target.','CONTROL_PROTOCOL_ERROR'); result={...focus,navigation:{...focus.navigation,requested:requestedMoteAddress,moteLink:resolvedMoteLink}} }
      if (independentSpatial && method === 'space.inspect') { context.signal?.throwIfAborted(); await context.assertCurrent?.() }
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
        result = { ...inspectNotebook(state, input), ...(storage ? { storageOperation: storage.operation ? notesStorageOperationInspection(storage.operation) : null, resourceChanges: storage.resourceChanges, conversionIssues: storage.conversionIssues } : {}),
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
        endpoint: this.ports.endpoint ?? { transport: 'unix', path: defaultAgentMuxControlSocketPath() }, publication: this.ports.endpointPublication?.() ?? null, ...(this.ports.exposedMethods ? { methods: [...this.ports.exposedMethods] } : {}) }; break
      case 'system.relay.inspect': result = parseAgentMuxRelayInspection(this.ports.relayInspection?.() ?? { gateway: { state: 'unavailable', issue: {
        code: 'RELAY_GATEWAY_OBSERVATION_UNAVAILABLE', message: 'The original Relay gateway observation owner is unavailable. Existing Core services and Sessions are retained.' } } }); break
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
        const scopes = (await this.clients(input.hostId)).filter(scope => scope.hostId === input.hostId)
        if (scopes.length !== 1) throw new AgentMuxError(`Context route Host ${JSON.stringify(input.hostId)} is ${scopes.length ? 'ambiguous' : 'not configured'} in this service. Use settings hosts ls or agent ls on the same endpoint; local means the receiving Core service.`, scopes.length ? 'AMBIGUOUS_AGENT_SESSION' : 'UNKNOWN_HOST')
        const scope = scopes[0]!
        if (scope.client.forwardRpc) {
          // Configured Host names are routes on this client. The remote Core owns
          // its local namespace; never pass a Desktop route as native identity.
          const forwarded = forwardAgentContextParams(input)
          // Authentication stays at ingress; only this exact read borrows the
          // original configured carrier, as agent.history does. Never export
          // a source Agent capability as another Runtime's local identity.
          const { caller: _localCaller, ...readContext } = context
          const page = await scope.client.forwardRpc('agent.context', forwarded.params, readContext)
          result = forwardAgentContextPage(page, input, forwarded.sourceHostId)
          break
        }
        const descriptor = (await scope.client.sessionHistorySources({ agentSessionId: input.agentSessionId, ...(context.signal ? { signal: context.signal } : {}) })).find(source => source.agentSessionId === input.agentSessionId && source.hostId === input.hostId)
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
      case 'agent.posture.inspect': {
        const input = parsePostureInspect(p), scopes = (await this.clients()).filter(scope => scope.hostId === input.hostId)
        if (scopes.length !== 1) throw new AgentMuxError('The original posture Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
        const scope = scopes[0]!, original = { ...input, hostId: 'local' }
        if (scope.client.forwardRpc || this.ports.callOriginalCore) {
          const forwarded = this.ports.callOriginalCore ? await this.ports.callOriginalCore(input.hostId, 'agent.posture.inspect', original, await this.inputForwardContext(context))
            : await scope.client.forwardRpc!('agent.posture.inspect', original, await this.inputForwardContext(context))
          const value = parsePostureInspection(forwarded, original)
          result = value.kind === 'declaration' ? { ...value, target: { ...value.target, hostId: input.hostId } }
            : { ...value, operation: value.operation ? { ...value.operation, target: { ...value.operation.target, hostId: input.hostId } } : null }
        } else {
          if (!scope.client.inspectAgentPosture) throw new AgentMuxError('The original posture owner is unavailable.', 'CONTROL_UNAVAILABLE')
          const value = await scope.client.inspectAgentPosture(original)
          result = value.kind === 'declaration' ? { ...value, target: { ...value.target, hostId: input.hostId } }
            : { ...value, operation: value.operation ? { ...value.operation, target: { ...value.operation.target, hostId: input.hostId } } : null }
        }
        result = parsePostureInspection(result, input); break
      }
      case 'agent.posture.set': {
        if (caller || !context.principal || !['user', 'device'].includes(context.principal.kind))
          throw new AgentMuxError('Posture setting requires the original transport-approved person/device; an Agent cannot grant itself modes.', 'CONTROL_PERMISSION_DENIED')
        const input = parsePostureSet(p), scopes = (await this.clients()).filter(scope => scope.hostId === input.target.hostId)
        if (scopes.length !== 1) throw new AgentMuxError('The original posture Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
        const scope = scopes[0]!, original = { ...input, target: { ...input.target, hostId: 'local' } }
        if (scope.client.forwardRpc || this.ports.callOriginalCore) {
          const forwarded = this.ports.callOriginalCore ? await this.ports.callOriginalCore(input.target.hostId, 'agent.posture.set', original, await this.inputForwardContext(context))
            : await scope.client.forwardRpc!('agent.posture.set', original, await this.inputForwardContext(context))
          const value = parsePostureSetResult(forwarded, original)
          result = { ...value, target: { ...value.target, hostId: input.target.hostId } }
        } else {
          if (!scope.client.setAgentPosture) throw new AgentMuxError('The original posture intent owner is unavailable.', 'CONTROL_UNAVAILABLE')
          const restriction = this.inputCallContext(context)
          const value = await scope.client.setAgentPosture(original, { actor: context.principal,
            ...(restriction.requestSignal ? { requestSignal: restriction.requestSignal } : {}), ...(restriction.assertCurrent ? { assertCurrent: restriction.assertCurrent } : {}) })
          result = { ...value, target: { ...value.target, hostId: input.target.hostId } }
        }
        result = parsePostureSetResult(result, input); break
      }
      case 'terminal.input': case 'terminal.interrupt': case 'terminal.stop': case 'terminal.operation.inspect': {
        if (caller || !context.principal || !['user', 'device'].includes(context.principal.kind))
          throw new AgentMuxError('Raw Terminal control and original receipts require the original person/device, without a managed Agent caller.', 'CONTROL_PERMISSION_DENIED')
        const inspection = method === 'terminal.operation.inspect'
        const input = inspection ? parseTerminalControlInspect(p) : parseTerminalControl(p, method === 'terminal.input' ? 'terminal-input' : method === 'terminal.interrupt' ? 'terminal-interrupt' : 'terminal-stop')
        const hostId = 'target' in input ? input.target.hostId : input.hostId
        const scopes = (await this.clients()).filter(scope => scope.hostId === hostId)
        if (scopes.length !== 1) throw new AgentMuxError('The exact original Terminal execution Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
        const scope = scopes[0]!
        if (inspection) {
          const query = input as import('./terminal-control.js').TerminalControlInspect, original = { ...query, hostId: 'local' }
          const value = scope.client.forwardRpc || this.ports.callOriginalCore
            ? parseTerminalControlInspection(this.ports.callOriginalCore ? await this.ports.callOriginalCore(hostId, 'terminal.operation.inspect', original, await this.inputForwardContext(context))
              : await scope.client.forwardRpc!('terminal.operation.inspect', original, await this.inputForwardContext(context)), original)
            : scope.client.inspectTerminalControl ? await scope.client.inspectTerminalControl(original)
              : (() => { throw new AgentMuxError('The original Terminal receipt owner is unavailable.', 'CONTROL_UNAVAILABLE') })()
          result = parseTerminalControlInspection({ ...value, hostId, operation: value.operation ? { ...value.operation, target: { ...value.operation.target, hostId } } : null }, query)
        } else {
          const request = input as import('./terminal-control.js').TerminalControlRequest, original = { ...request, target: { ...request.target, hostId: 'local' } }
          let value: import('./terminal-control.js').TerminalControlReceipt
          if (scope.client.forwardRpc || this.ports.callOriginalCore) {
            const { action: _action, ...wire } = original
            const nativeMethod = method as 'terminal.input' | 'terminal.interrupt' | 'terminal.stop'
            value = parseTerminalControlResult(this.ports.callOriginalCore ? await this.ports.callOriginalCore(hostId, nativeMethod, wire, await this.inputForwardContext(context))
              : await scope.client.forwardRpc!(nativeMethod, wire, await this.inputForwardContext(context)), original)
          } else {
            if (!scope.client.controlTerminal) throw new AgentMuxError('The original Terminal control owner is unavailable.', 'CONTROL_UNAVAILABLE')
            const restriction = this.inputCallContext(context)
            value = await scope.client.controlTerminal(original, { actor: context.principal,
              ...(restriction.requestSignal ? { requestSignal: restriction.requestSignal } : {}), ...(restriction.assertCurrent ? { assertCurrent: restriction.assertCurrent } : {}) })
          }
          result = parseTerminalControlResult({ ...value, target: { ...value.target, hostId } }, request)
        }
        break
      }
      case 'terminal.creation.retire':
      case 'terminal.creation.inspect': {
        if (caller || !context.principal || !['user', 'device'].includes(context.principal.kind))
          throw new AgentMuxError('Original raw Terminal creation reads require the transport-approved person or device, without a managed Agent caller.', 'CONTROL_PERMISSION_DENIED')
        const retiring=method==='terminal.creation.retire'
        const input = retiring?parseTerminalCreationRetire(p):parseTerminalCreationInspect(p), scopes = (await this.clients()).filter(scope => scope.hostId === input.hostId)
        if (scopes.length !== 1) throw new AgentMuxError('The exact original Terminal creation Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
        const scope = scopes[0]!, original = { ...input, hostId: 'local' }
        const observed = scope.client.forwardRpc
          ? parseTerminalCreationInspection(await scope.client.forwardRpc(retiring?'terminal.creation.retire':'terminal.creation.inspect', original, await this.inputForwardContext(context)), original)
          : retiring && scope.client.retireTerminalCreation ? parseTerminalCreationInspection(await scope.client.retireTerminalCreation(parseTerminalCreationRetire(original)),original)
          : !retiring && scope.client.inspectTerminalCreation ? parseTerminalCreationInspection(await scope.client.inspectTerminalCreation(original), original)
            : (() => { throw new AgentMuxError('The original Terminal creation owner is unavailable.', 'CONTROL_UNAVAILABLE') })()
        result = parseTerminalCreationInspection({ ...observed, hostId: input.hostId }, input)
        break
      }
      case 'terminal.ls': {
        if (caller || !context.principal || !['user', 'device'].includes(context.principal.kind))
          throw new AgentMuxError('Raw Terminal discovery requires the original transport-approved person or device.', 'CONTROL_PERMISSION_DENIED')
        const input = parseTerminalListParams(p), scopes = (await this.clients()).filter(scope => scope.hostId === input.hostId)
        if (scopes.length !== 1) throw new AgentMuxError('The exact Terminal execution Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
        const scope = scopes[0]!
        if (scope.client.forwardRpc) {
          const original = { ...input, hostId: 'local' }
          const value = parseTerminalListResult(await scope.client.forwardRpc('terminal.ls', original, await this.inputForwardContext(context)), original)
          result = { ...value, hostId: input.hostId, items: value.items.map(item => ({ ...item, target: { ...item.target, hostId: input.hostId } })) }
        } else {
          if (!scope.client.listTerminals) throw new AgentMuxError('The original Terminal discovery owner is unavailable.', 'CONTROL_UNAVAILABLE')
          const page = await scope.client.listTerminals({ ...(input.cursor ? { cursor: input.cursor } : {}), limit: input.limit ?? 100 })
          result = parseTerminalListResult({ hostId: input.hostId, runtime: page.runtime, coverage: 'live-page',
            items: page.items.map(item => ({ ...item, target: { hostId: input.hostId, runtimeId: page.runtime.runtimeId, run: { runId: item.run.runId } } })),
            nextCursor: page.nextCursor === null ? null : { runtimeId: page.runtime.runtimeId, ownerInstanceId: page.runtime.instanceId, afterRunId: page.nextCursor } }, input)
        }
        break
      }
      case 'terminal.inspect': {
        rpcRecord(p, ['target'])
        if (caller || !context.principal || !['user', 'device'].includes(context.principal.kind))
          throw new AgentMuxError('Raw Terminal reads require the original transport-approved person or device.', 'CONTROL_PERMISSION_DENIED')
        const target = parseTerminalTarget(p.target)
        const scopes = (await this.clients()).filter(scope => scope.hostId === target.hostId)
        if (scopes.length !== 1) throw new AgentMuxError('The exact Terminal execution Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
        const scope = scopes[0]!, original = { ...target, hostId: 'local' }
        if (scope.client.forwardRpc) {
          const value = parseTerminalInspection(await scope.client.forwardRpc('terminal.inspect', { target: original }, await this.inputForwardContext(context)), original)
          result = { ...value, target }
        } else {
          if (!scope.client.inspectTerminal) throw new AgentMuxError('The original Terminal observation owner is unavailable.', 'CONTROL_UNAVAILABLE')
          result = parseTerminalInspection({ ...await scope.client.inspectTerminal(target), target }, target)
        }
        break
      }
      case 'terminal.output': throw new AgentMuxError('Terminal output is a bounded byte subscription.', 'INVALID_CONTROL_REQUEST')
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
        const knownRun = lookup.kind === 'run' ? clients.filter(({ client }) => {
          if (this.endpointUnverified(client)) return false
          try { return client.agentSessions().some(session => session.run.runId === rpcRecord(lookup.run, ['runId']).runId) }
          catch (error) {
            // This cache only narrows a route. An unconfirmed directory cannot
            // take away the original exact query below.
            if (error instanceof AgentMuxError && error.code === 'HOSTED_SESSION_OBSERVATION_UNCONFIRMED') return false
            throw error
          }
        }) : []
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
      case 'agent.takeover.ls': {
        if (this.ports.callOriginalCore) { result = await this.ports.callOriginalCore('local', method, params, context); break }
        const input = parseAgentTakeoverQuery(p)
        if (caller || !context.principal || !['user', 'device'].includes(context.principal.kind)) throw new AgentMuxError('Original Takeover relation reading requires the person or device.', 'CONTROL_PERMISSION_DENIED')
        const local = await this.hosted('runtime.owner.identity', { expectedRuntimeId: input.expectedRuntimeId }, context), owner = (await local.owner.call('runtime.owner.identity', {}, context)).owner
        if (owner.runtimeId !== input.expectedRuntimeId) throw new AgentMuxError('This is another original Takeover admission Core.', 'RUNTIME_OWNER_MISMATCH')
        const scope = JSON.stringify([input.expectedRuntimeId, input.direction, input.subject.runtimeId, input.subject.agentSessionId])
        let after = ''
        if (input.cursor) {
          let cursor
          try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) } catch { throw new AgentMuxError('The original Takeover query cursor is invalid.', 'INVALID_CONTROL_REQUEST') }
          if (!cursor || Object.keys(cursor).sort().join(',') !== 'after,scope' || cursor.scope !== scope || typeof cursor.after !== 'string') throw new AgentMuxError('The Takeover cursor belongs to another original subject.', 'INVALID_CONTROL_REQUEST')
          after = cursor.after
        }
        const selected = await this.spatial.readTakeoverAdmissions({ direction: input.direction, subject: input.subject, after, limit: input.limit ?? 50 })
        if (!selected) throw new AgentMuxError('The original Takeover admission metadata is unavailable.', 'SPATIAL_STATE_ABSENT')
        const records: AgentTakeoverRecord[] = []
        for (const original of selected.records) {
          const takeover = parseAgentTakeoverProvenance(original.takeover)
          const record: AgentTakeoverRecord = { requestId: original.requestId, takeover, agent: { hostId: original.execution.hostId, runtimeId: original.execution.runtimeId ?? null, agentSessionId: original.agentSessionId, run: null }, phase: 'unconfirmed', issue: takeover.source.organizationIssue ?? null }
          try {
            const matches = (await this.clients(original.execution.hostId)).filter(value => value.hostId === original.execution.hostId)
            if (matches.length !== 1 || this.endpointUnverified(matches[0]!.client)) throw new AgentMuxError('The exact created Takeover Session owner is unavailable.', 'CONTROL_UNAVAILABLE')
            const client = matches[0]!.client, actual = await client.agentCreationAuthority()
            if (actual.runtimeId !== original.execution.runtimeId) throw new AgentMuxError('The created Takeover Runtime changed.', 'RUNTIME_OWNER_MISMATCH')
            const active = await client.readAgentSession(original.agentSessionId)
            const retired = active ? null : (await client.sessionHistorySources({ agentSessionId: original.agentSessionId })).find(value => value.agentSessionId === original.agentSessionId)
            const metadata = active ?? retired?.history
            if (!metadata) { record.phase = 'prepared'; record.issue = [record.issue, 'The original spatial admission is retained; its created Session has not been confirmed.'].filter(Boolean).join('\n') }
            else {
              if (metadata.creation?.createOperationId !== original.requestId || metadata.workspacePath !== original.execution.workspacePath ||
                original.executionBinding && (metadata.toolExecution?.bindingId !== original.executionBinding.bindingId || metadata.toolExecution.resourceRuntimeId !== input.expectedRuntimeId)) throw new AgentMuxError('The created Session does not match this original Takeover admission.', 'AGENT_TAKEOVER_ADMISSION_UNCONFIRMED')
              record.phase = active ? 'active' : retired?.state === 'retired' ? 'retired' : 'unconfirmed'
              record.agent.run = active?.run ?? null
              if (metadata.creation.initialPrompt === 'unknown' || metadata.creation.initialPrompt === 'unconfirmed' || metadata.creation.persistence === 'unconfirmed') record.issue = [record.issue, 'The original creation or first input acknowledgement is unconfirmed. Inspect its exact operation without replaying.'].filter(Boolean).join('\n')
            }
          } catch (cause) { record.issue = [record.issue, cause instanceof Error ? cause.message : String(cause)].filter(Boolean).join('\n') }
          records.push(record)
        }
        const page: AgentTakeoverPage = { owner: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }, direction: input.direction, subject: input.subject, records,
          nextCursor: selected.hasMore && records.length ? Buffer.from(JSON.stringify({ scope, after: records.at(-1)!.requestId })).toString('base64url') : null, coverage: { scope: 'selected-owner', history: 'recorded-takeovers' } }
        result = parseAgentTakeoverPage(page, input); break
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
          messageIds: p.messageIds.map(id => rpcString(id, 'Original message ID')), ...optionalInputEpoch(p.inputEpoch), ...auth }, this.inputCallContext(context)), hostId }
        break
      }
      case 'agent.broadcast.inspect': case 'message.read': case 'message.ls': case 'message.events': case 'message.dispatch.read': case 'message.dispatch.ls': {
        if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind) || !context.principal.id.trim())) throw new AgentMuxError(
          'Message reading requires an authenticated Agent participant or a transport-approved user/device. Original communication and Runs are retained.', 'CONTROL_PERMISSION_DENIED')
        if (method === 'message.read' && (p.operationId !== undefined) === (p.messageId !== undefined)) throw new AgentMuxError(
          'Choose exactly one original message operationId or messageId.', 'INVALID_CONTROL_REQUEST')
        const participant = p.participantRuntimeId !== undefined || (method === 'message.read' || method === 'message.dispatch.read') && p.participantSessionId !== undefined
          ? parseMessageParticipantSelection({ participantSessionId: p.participantSessionId ?? caller?.agentSessionId, participantRuntimeId: p.participantRuntimeId }) : undefined
        const messageSelector: import('./agent-message-query.js').AgentMuxMessageReadRequest | undefined = method !== 'message.read' ? undefined : {
          ...participant,
          ...(p.messageId === undefined ? { operationId: rpcString(p.operationId, 'Original message operation ID') }
            : { messageId: rpcString(p.messageId, 'Original message ID') }),
          ...(p.notificationId === undefined ? {} : { notificationId: rpcString(p.notificationId, 'Original notification ID') }),
          ...(p.field === undefined ? {} : { field: p.field as import('./agent-message-query.js').AgentMuxMessageField }),
          ...(p.cursor === undefined ? {} : { cursor: rpcString(p.cursor, 'Original field cursor') }),
          ...(p.maxBytes === undefined ? {} : { maxBytes: rpcCount(p.maxBytes, -1) }) }
        const hostId = p.hostId === undefined ? caller?.hostId : rpcString(p.hostId, 'Original message Host ID')
        if (hostId === undefined) throw new AgentMuxError('A trusted reader must select the exact original message Host.', 'INVALID_CONTROL_REQUEST')
        if (caller && caller.hostId !== hostId) throw new AgentMuxError('Agent authority cannot read another semantic Host journal.', 'CONTROL_PERMISSION_DENIED')
        if (method === 'message.read' && hostId === 'local' && !participant) {
          const route = await (await this.messageRouteJournal()).readMessageRoute(messageSelector!.operationId, messageSelector!.messageId)
          const localOwners = route && !caller ? (await this.clients()).filter(scope => scope.hostId === 'local') : []
          const sourceOwner = caller?.client ?? (localOwners.length === 1 ? localOwners[0]!.client : undefined)
          const localOriginal = route && sourceOwner ? await sourceOwner.readMessage({ ...messageSelector!, field: undefined,
            ...(caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {}) }) : null
          if (route && !localOriginal?.provenance) {
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
          result = messageSelector!.field === undefined
            ? { message: await owner.client.readMessage({ ...messageSelector!, field: undefined, ...auth }), hostId }
            : { message: null, field: await owner.client.readMessage({ ...messageSelector!, field: messageSelector!.field, ...auth }), hostId }
        } else if (method === 'agent.broadcast.inspect') {
          result = { broadcast: await owner.client.inspectMessageBroadcast({ operationId: rpcString(p.operationId, 'Original broadcast operation ID'), ...auth }), hostId }
        } else if (method === 'message.ls') {
          if (p.direction !== 'incoming' && p.direction !== 'outgoing') throw new AgentMuxError('Message direction must be incoming or outgoing.', 'INVALID_CONTROL_REQUEST')
          result = { ...await owner.client.listMessages({
            participantSessionId: rpcString(p.participantSessionId ?? caller?.agentSessionId, 'Participant Session ID'),
            ...(participant ? { participantRuntimeId: participant.participantRuntimeId } : {}),
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
          sourceMessageId: rpcString(p.sourceMessageId, 'Source message ID'), ...participant, ...auth }), hostId }
        else result = { ...await owner.client.listDispatches({
          participantSessionId: p.participantSessionId === undefined ? this.requireCaller(caller).agentSessionId : rpcString(p.participantSessionId, 'Participant Session ID'),
          ...(participant ? { participantRuntimeId: participant.participantRuntimeId } : {}),
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
          if (method === 'message.dispatch.open') result = await owner.client.openDispatch(input)
          else if (method === 'message.dispatch.inspect') result = await owner.client.showDispatch(input)
          else {
            const report = { ...input, replyMessageId: rpcString(p.replyMessageId, 'Reply message ID'), kind: p.kind as Parameters<AgentMuxClient['recordDispatchEvent']>[0]['kind'] }
            const source = await owner.client.readMessage({ messageId: input.sourceMessageId, caller: { agentSessionId: owner.agentSessionId, capability: owner.capability } })
            result = source?.provenance ? await owner.client.recordFederatedDispatchEvent(report) : await owner.client.recordDispatchEvent(report)
          }
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
        result = await this.submitInputAt(scope,input,context)
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
      case 'agent.input.epoch': {
        const hostId = rpcString(p.hostId, 'Original input Host ID')
        if (caller && caller.hostId !== hostId || !caller && (!context.principal || !['user','device'].includes(context.principal.kind))) throw new AgentMuxError('Input namespace reading requires its original Host and an authenticated caller.', 'CONTROL_PERMISSION_DENIED')
        const scopes=(caller ? [caller] : await this.clients()).filter(scope=>scope.hostId===hostId)
        if(scopes.length!==1 || this.endpointUnverified(scopes[0]!.client)) throw new AgentMuxError('The original input namespace Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
        const client=scopes[0]!.client
        if(client.forwardRpc) {
          const read=await client.forwardRpc('agent.input.epoch',{hostId:'local'},context)
          if(read.hostId!=='local') throw new AgentMuxError('The original input namespace Host response changed.', 'CONTROL_PROTOCOL_ERROR')
          result={hostId,inputEpoch:read.inputEpoch}
        } else result={hostId,inputEpoch:await client.readAgentInputEpoch() ?? null}
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
      case 'agent.input.observation': {
        const agentSessionId = rpcString(p.agentSessionId,'Original member Session'), observationId = rpcString(p.observationId,'Original input observation')
        const scope = await this.originalInputOwner(agentSessionId,caller)
        if (scope.client.forwardRpc) return await scope.client.forwardRpc('agent.input.observation',{agentSessionId,observationId},context) as AgentMuxRpcResult<M>
        result = {inspection:await scope.client.inspectMoteInput({agentSessionId,observationId,
          ...(caller ? {caller:{agentSessionId:caller.agentSessionId,capability:caller.capability}} : {})})}
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
        rpcRecord(p, ['key', 'activity'])
        if (p.activity !== undefined && p.activity !== true) throw new AgentMuxError('Activity inspection must be explicitly enabled.', 'INVALID_CONTROL_REQUEST')
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
        if (client.forwardRpc) return await client.forwardRpc('agent.input.inspect', { key, ...(p.activity === true ? { activity: true } : {}) }, context) as AgentMuxRpcResult<M>
        const observed = await client.inspectAgentInput({ key }, caller ? { agentSessionId: caller.agentSessionId, capability: caller.capability } : undefined)
        // A physical predecessor remains independently readable after its logical
        // input advances. Do not pair that immutable claim with today's receipt.
        const input = key.attemptId && observed && !isDeepStrictEqual(agentInputDeliveryKey(observed.control), key) ? null : observed
        const original = input ? input.admission : await client.inspectAgentPromptSubmission(key)
        if (!input && caller && caller.agentSessionId !== key.agentSessionId && original?.admission?.intent?.message?.authorAgentSessionId !== caller.agentSessionId) throw new AgentMuxError('Only an original input participant can inspect its claim.', 'CONTROL_PERMISSION_DENIED')
        // A supplementary pointer must not revoke the original authorized input read.
        const observation=await client.inspectMoteInput({agentSessionId:key.agentSessionId,observationId:moteInputObservationId({kind:'prompt',key}),...(caller ? {caller:{agentSessionId:caller.agentSessionId,capability:caller.capability}} : {})}).catch(()=>null)
        result = { ...(p.activity === true ? { activity: await client.readAgentInputActivity(key) } : {}), sourceNow:Date.now(), record: original, ...(input ? { input } : {}), ...(observation ? {moteObservationId:observation.observation.id} : {}) }; break
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
      case 'message.federation.dispatch-intake': {
        const event = parseSignedDispatchEvent(p.event), local = (await this.clients()).filter(scope => scope.hostId === 'local')
        if (local.length !== 1) throw new AgentMuxError('The exact receiving Dispatch Core is unavailable. Original facts are retained.', 'CONTROL_UNAVAILABLE')
        result = await local[0]!.client.intakeFederatedDispatchEvent(event); break
      }
      case 'message.federation.intake': {
        const packet = parseSignedMessage(p.packet), local = (await this.clients()).filter(scope => scope.hostId === 'local')
        if (local.length !== 1) throw new AgentMuxError('The exact receiving Core is unavailable. Keep the signed message.', 'CONTROL_UNAVAILABLE')
        result = await local[0]!.client.intakeFederatedMessage(packet); break
      }
      case 'message.federation.export': {
        const authority = parseMessageReadAuthority(p.authority), local = (await this.clients()).filter(scope => scope.hostId === 'local')
        if (local.length !== 1) throw new AgentMuxError('The original signed thread owner is unavailable.', 'CONTROL_UNAVAILABLE')
        result = await local[0]!.client.exportFederatedThread(authority); break
      }
      case 'message.dispatch.sync': {
        if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind))) throw new AgentMuxError('Thread synchronization requires its original Agent participant or trusted Host reader.', 'CONTROL_PERMISSION_DENIED')
        const local = (await this.clients()).filter(scope => scope.hostId === 'local')
        const owner = caller ?? (local.length === 1 ? local[0]! : undefined)
        if (!owner) throw new AgentMuxError('The original source Core is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
        const auth = caller ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : {}
        const sourceMessageId = rpcString(p.sourceMessageId, 'Original source message'), hostId = rpcString(p.hostId, 'Original remote Host')
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        const authority = await owner.client.prepareFederatedRead({ ...auth, sourceMessageId })
        const routes = (await this.clients()).filter(scope => scope.hostId === hostId)
        if (routes.length !== 1 || !routes[0]!.client.forwardRpc || this.endpointUnverified(routes[0]!.client) || routes[0]!.client.runtimeOwnerIdentity?.()?.runtimeId !== authority.targetRuntimeId) throw new AgentMuxError('The original remote thread Runtime is unavailable or changed. No alternate owner was read.', 'CONTROL_UNAVAILABLE')
        const exported = parseFederatedThread(await routes[0]!.client.forwardRpc('message.federation.export', { authority }, { ...(context.signal ? { signal: context.signal } : {}) }))
        if (exported.source.envelope.messageId !== sourceMessageId || exported.source.provenance.intentDigest !== authority.sourceIntentDigest || !exported.sourceReceipt) throw new AgentMuxError('The remote export does not confirm this exact original recipient inbox source.', 'MESSAGE_RECIPIENT_MISMATCH')
        // The target's successful exact-source read comes first. It never uploads
        // an absent original dispatch or blindly repeats an unknown native input.
        await owner.client.recordFederatedInboxReceipt(exported.sourceReceipt)
        for (const receipt of exported.inboxReceipts ?? []) await owner.client.recordFederatedInboxReceipt(receipt)
        const outbox = await owner.client.readFederatedOutbox({ sourceMessageId, ...auth })
        const remoteMessages = new Map(exported.replies.map(message => [message.envelope.messageId, message]))
        for (const packet of outbox.messages) {
          const original = remoteMessages.get(packet.envelope.messageId)
          if (original) {
            if (!isDeepStrictEqual(original, packet)) throw new AgentMuxError('The original remote reply has different frozen signed facts.', 'MESSAGE_ID_CONFLICT')
          } else {
            const receipt = await routes[0]!.client.forwardRpc('message.federation.intake', { packet }, { ...(context.signal ? { signal: context.signal } : {}) })
            if (!receipt.recipientInbox) throw new AgentMuxError('The target inbox receipt is unconfirmed. Keep the original reply and inspect it through the same thread.', 'CONTROL_UNAVAILABLE')
            await owner.client.recordFederatedInboxReceipt(receipt.recipientInbox)
          }
        }
        const remoteEvents = new Map((exported.dispatchEvents ?? []).map(event => [event.replyMessageId, event]))
        for (const event of outbox.dispatchEvents) {
          const original = remoteEvents.get(event.replyMessageId)
          if (original) {
            if (!isDeepStrictEqual(original, event)) throw new AgentMuxError('The original remote Dispatch event has different signed facts.', 'DISPATCH_EVENT_CONFLICT')
          } else await routes[0]!.client.forwardRpc('message.federation.dispatch-intake', { event }, { ...(context.signal ? { signal: context.signal } : {}) })
        }
        for (const reply of exported.replies) if (reply.provenance.target.runtimeId === authority.source.runtimeId) await owner.client.intakeFederatedMessage(reply)
        for (const event of exported.dispatchEvents ?? []) if (event.provenance.target.runtimeId === authority.source.runtimeId) await owner.client.intakeFederatedDispatchEvent(event)
        result = { ...await owner.client.readDispatch({ sourceMessageId, ...auth }), remoteSource: exported.sourceReceipt, hostId: 'local' }; break
      }
      case 'agent.send': result = await this.send(p, caller, context); break
      case 'agent.broadcast': result = await this.broadcast(p, caller, context); break
      case 'agent.output': throw new AgentMuxError('Agent output is a bounded byte subscription.', 'INVALID_CONTROL_REQUEST')
      case 'goal.activity.history': {
        const input = parseGoalActivityHistoryParams(p)
        if (this.ports.forwardControl) {
          try { return await this.ports.forwardControl('goal.activity.history', input, context) as AgentMuxRpcResult<M> }
          catch (error) { if (!(error instanceof AgentMuxError) || error instanceof AgentMuxRpcError || error.code !== 'CONTROL_UNAVAILABLE') throw error }
        }
        const read = await this.execute(this.request('demand.activity.read', { demandId: input.goalId }))
        if (read.operation !== 'demand.activity.read' || read.demandId !== input.goalId || read.diskDurability !== 'confirmed')
          throw new AgentMuxError('The original Goal activity read is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
        result = pageGoalActivity(read.activities, input); break
      }
      case 'goal.activity': {
        validateFilters(p)
        const limit = rpcCount(p.limit, 100, 1000), since = p.since as number | undefined
        if (limit < 1) throw new AgentMuxError('Goal activity limit must be from 1 to 1000.', 'INVALID_CONTROL_REQUEST')
        if (this.ports.forwardControl) {
          try { return await this.ports.forwardControl(method, params, context) }
          catch (error) { if (!(error instanceof AgentMuxError) || error instanceof AgentMuxRpcError || error.code !== 'CONTROL_UNAVAILABLE') throw error }
        }
        const { limit: _limit, since: _since, ...goalFilters } = p
        const goals = await this.goals({ ...goalFilters, all: true })
        // Goal selection and durable activity confirmation are separate observations.
        // Confirm the exact selected IDs once at the original Store, without repeated whole-Store reads.
        const selected = goals.map(goal => goal.id)
        const read = selected.length ? await this.execute(this.request('demand.activity.collection', { demandIds: selected })) : null
        if (read && (read.operation !== 'demand.activity.collection' || read.diskDurability !== 'confirmed' ||
          read.groups.length !== selected.length || read.groups.some((group, index) => group.demandId !== selected[index])))
          throw new AgentMuxError('The original Goal activity collection returned another selected scope.', 'CONTROL_PROTOCOL_ERROR')
        const records = read && read.operation === 'demand.activity.collection'
          ? read.groups.map(group => group.activities.map(activity => ({ goalId: group.demandId, ...activity }))) : []
        const matching = records.flat().filter(activity => since === undefined || activity.createdAt >= since)
        const activity = matching.slice(-limit)
        result = { activity, diskDurability: 'confirmed', coverage: { scope: 'matching-goals', observation: 'selected-goals-then-confirmed-activity', order: 'goal-order-then-append',
          matchedGoalCount: goals.length, totalActivityCount: matching.length, returnedActivityCount: activity.length,
          limit, truncated: matching.length > activity.length } }; break
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
  private async rendererCache(input: import('./renderer-cache.js').RendererCacheInput, action: import('./renderer-cache.js').RendererCacheAction, signal?: AbortSignal) {
    const owner = this.ports.metrics, call = action === 'inspect' ? owner?.inspectCache : owner?.reclaimCache
    if (!call) throw new AgentMuxError('Renderer platform cache operation is unavailable on the original metrics owner.', 'METRICS_UNSUPPORTED')
    return parseRendererCacheResult(await call.call(owner, input, signal), input, action)
  }
  private async inspectWorkers(input: import('./renderer-worker-memory.js').RendererWorkerMemoryInput, signal?: AbortSignal) {
    if (!this.ports.metrics?.inspectWorkers) throw new AgentMuxError('Related Worker memory observations are unavailable on the original metrics owner.', 'METRICS_UNSUPPORTED')
    return parseRendererWorkerMemoryResult(await this.ports.metrics.inspectWorkers(input, signal), input)
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
  private async submitInputAt(scope: AgentMuxRpcCoreClient, input: import('./agent-input-submit.js').AgentInputSubmit, context: AgentMuxRpcCallContext): Promise<import('./agent-input-submit.js').AgentInputSubmitResult> {
    if (scope.client.forwardRpc) return await scope.client.forwardRpc('agent.input.submit',input,await this.inputForwardContext(context))
    if (scope.hostId === 'local' && this.ports.callOriginalCore) return await this.ports.callOriginalCore(scope.hostId,'agent.input.submit',input,await this.inputForwardContext(context))
    const device = this.ports.operationSource?.(context)
    const {moteGuidance,focusTask,capturedContext,...prompt} = input
    const receipt = await scope.client.submitAgentPrompt({ ...prompt,
      ...(capturedContext ? {inputContextCapture:capturedContext.reference, ...(capturedContext.agentMuxNote === undefined ? {} : {agentMuxNote:capturedContext.agentMuxNote}),authorHuman:true} : {}),
      ...((moteGuidance || focusTask) ? {agentMuxNote:agentInputGuidance(input),...(moteGuidance ? {authorHuman:true} : {})} : {}), sourceChannel: input.sourceChannel ?? (context.transport === 'unix' ? 'cli' : 'api'),
      ...(device ? {sourceDevice:normalizeOperationDevice(device)} : {}) },{...this.inputCallContext(context), ...(this.ports.inputContextCaptures ? {captureReader:this.ports.inputContextCaptures} : {})})
    const key = {kind:'prompt' as const,agentSessionId:input.agentSessionId,expectedRun:input.expectedRun,submissionId:input.operationId}
    const observed = await scope.client.inspectAgentInput({key}) ?? (receipt && 'key' in receipt ? receipt : undefined)
    const record = observed ? observed.admission : await scope.client.inspectAgentPromptSubmission(key)
    return {key,record,...(observed ? {input:observed} : {}),...(receipt?.moteObservationId ? {moteObservationId:receipt.moteObservationId} : {})}
  }

  private async moteMainSetup(method: 'space.mote.dialogue.setup.inspect' | 'space.mote.dialogue.setup.advance', input: import('./mote/dialogue.js').MoteMainSetupRequest, context: AgentMuxRpcCallContext): Promise<import('./mote/dialogue.js').MoteMainSetupResult> {
    const assertCurrent = async () => { context.signal?.throwIfAborted(); await this.assertRuntimeFence(context); await this.inputCallContext(context).assertCurrent?.() }
    await assertCurrent()
    if (input.creation.hostId !== 'local') {
      const routes = (await this.ports.coreClients?.() ?? []).filter(scope => scope.hostId === input.creation.hostId)
      if (routes.length !== 1 || this.endpointUnverified(routes[0]!.client) || !routes[0]!.client.forwardRpc) throw new AgentMuxError('The exact original Main admission Host is unavailable or ambiguous. Keep its operation and existing Agent.', 'CONTROL_UNAVAILABLE')
      const original = { ...input, creation:{...input.creation,hostId:'local'} }
      const result = parseMoteDialogueResult(method,await routes[0]!.client.forwardRpc!(method,original,await this.inputForwardContext(context)),original)
      return {...result,ownerHostId:input.creation.hostId}
    }
    const resourceCall = async <M extends 'space.mote.preferences.read' | 'space.mote.preferences.save' | 'space.mote.dialogue.read' | 'space.mote.dialogue.link'>(leaf:M, request:AgentMuxRpcParams<M>):Promise<AgentMuxRpcResult<M>> => {
      await assertCurrent()
      const hostId = input.target.expectedResource.hostId
      if (hostId === 'local') return await this.call(leaf,request,context)
      const routes = (await this.ports.coreClients?.() ?? []).filter(scope => scope.hostId === hostId)
      if (routes.length !== 1 || this.endpointUnverified(routes[0]!.client) || !routes[0]!.client.forwardRpc) throw new AgentMuxError('The exact original MOTE resource Host is unavailable or ambiguous. No other Host was selected.', 'CONTROL_UNAVAILABLE')
      // Frozen resource and Session Host fields are opaque facts, never route aliases to rewrite.
      return await routes[0]!.client.forwardRpc!(leaf,request,await this.inputForwardContext(context))
    }
    const result = await reconcileMoteMainSetup(input,method === 'space.mote.dialogue.setup.advance',{
      spatial:this.spatial, assertCurrent,
      creation:async (hostId,sessionId) => {
        const routes = (await this.ports.coreClients?.() ?? []).filter(scope => scope.hostId === hostId)
        if (routes.length !== 1 || this.endpointUnverified(routes[0]!.client)) throw new AgentMuxError('The exact original Agent execution Host is unavailable or ambiguous. Its Session and request remain retained.', 'CONTROL_UNAVAILABLE')
        await assertCurrent(); return await routes[0]!.client.inspectAgentCreation(sessionId)
      },
      read:async request => parseMotePreferencesReadResult(await resourceCall('space.mote.preferences.read',request),request) as import('./mote/preferences.js').MoteQuickPreferencesReadResult,
      save:async request => parseMotePreferencesSaveResult(await resourceCall('space.mote.preferences.save',request),request) as import('./mote/preferences.js').MoteQuickPreferencesSaveResult,
      sources:async request => parseMoteDialogueResult('space.mote.dialogue.read',await resourceCall('space.mote.dialogue.read',request),request),
      link:async request => parseMoteDialogueResult('space.mote.dialogue.link',await resourceCall('space.mote.dialogue.link',request),request)
    })
    const record=result.record,intent=record?.moteMain
    if(record&&intent&&result.creation==='confirmed'&&result.binding==='confirmed') {
      try {
        const sources=await resourceCall('space.mote.dialogue.read',{target:intent.target,operationId:intent.bindOperationId})
        const missing = !sources.links.some(link=>link.kind==='main'&&link.roleRevision===moteMainBindingDefaults(record).conversationRevision)
        if (missing && method==='space.mote.dialogue.setup.advance') {
          await resourceCall('space.mote.dialogue.link',{target:intent.target,operationId:intent.bindOperationId,expectedRoleRevision:moteMainBindingDefaults(record).conversationRevision!,source:{kind:'main'}})
        }
      }catch(error){result.issue=[result.issue,'The original saved role source remains unconfirmed: '+String(error)].filter(Boolean).join('\n')}
    }
    if(!record||!intent||!intent.deferredInput&&!intent.handover) return result
    const advance=method==='space.mote.dialogue.setup.advance'
    const stage=async (field:'deferredInputKey'|'handoverInputKey',body:import('./spatial-agent-open-contract.js').MoteMainDeferredInput) => {
      const prior=await this.moteMainInput('space.mote.dialogue.input.inspect',{target:intent.target,operationId:body.operationId},context)
      if(prior.route||!advance||result.binding!=='confirmed') return prior
      const owners=(await this.clients()).filter(scope=>scope.hostId===record.execution.hostId)
      if(owners.length!==1||this.endpointUnverified(owners[0]!.client)) throw new AgentMuxError('The original created Main input Host is unavailable. Keep the frozen Query.','CONTROL_UNAVAILABLE')
      const created=await owners[0]!.client.inspectAgentCreation(record.agentSessionId)
      if(created.kind!=='agent'||created.creation?.createOperationId!==record.requestId)throw new AgentMuxError('The original created Main is unconfirmed. Its Query is retained.','CONTROL_UNAVAILABLE')
      const key=await this.spatial.claimMoteMainInput(record.requestId,field,{kind:'prompt',agentSessionId:record.agentSessionId,expectedRun:created.run,submissionId:body.operationId})
      return await this.moteMainInput('space.mote.dialogue.input.submit',{target:intent.target,expectedRoleRevision:moteMainBindingDefaults(record).conversationRevision!,input:{...body,...optionalInputEpoch(record.execution.inputEpoch),agentSessionId:key.agentSessionId,expectedRun:key.expectedRun,admissionIntent:{kind:'session-conversation'},execution:'immediate'}},context)
    }
    const retainIssue = (cause: unknown) => { result.issue=[result.issue,cause instanceof Error?cause.message:String(cause)].filter(Boolean).join('\n') }
    if(intent.handover&&intent.baseline.defaults.conversation) {
      try {
        const operationId=moteMainHandoverInputId(record.requestId)
        const retained=await this.moteMainInput('space.mote.dialogue.input.inspect',{target:intent.target,operationId},context)
        if(retained.route||!advance||result.binding!=='confirmed') result.handoverInput=retained
        else {
          const old=intent.baseline.defaults.conversation,scopes=await this.clients()
          const oldOwners=scopes.filter(scope=>scope.hostId===old.hostId),newOwners=scopes.filter(scope=>scope.hostId===record.execution.hostId)
          const oldOwner=oldOwners.length===1?oldOwners[0]:undefined,newOwner=newOwners.length===1?newOwners[0]:undefined
          let page:import('./agent-context.js').AgentContextPage|null=null
          let sourceIssue:string|null=null
          try {
            if(!oldOwner||this.endpointUnverified(oldOwner.client))throw new AgentMuxError('The original context Host is unavailable or ambiguous.','CONTROL_UNAVAILABLE')
            const request={hostId:old.hostId,agentSessionId:old.sessionId}
            page=parseRpcNativeResult('agent.context',await this.call('agent.context',request,context),request) as unknown as import('./agent-context.js').AgentContextPage
          } catch(error) {
            sourceIssue='The original handover context read is unconfirmed: '+String(error)
            retainIssue(sourceIssue)
          }
          const oldRuntime=oldOwner?.client.runtimeOwnerIdentity?.(),newRuntime=newOwner?.client.runtimeOwnerIdentity?.()
          const sameCore=!!oldOwner&&!!newOwner&&!this.endpointUnverified(oldOwner.client)&&!this.endpointUnverified(newOwner.client)&&(
            oldOwner.client===newOwner.client||oldRuntime?.availability==='connected'&&newRuntime?.availability==='connected'&&
            !!oldRuntime.runtimeId&&!!oldRuntime.ownerInstanceId&&oldRuntime.runtimeId===newRuntime.runtimeId&&oldRuntime.ownerInstanceId===newRuntime.ownerInstanceId)
          const original=page?.session
          const prompt=[agentTakeoverPrompt({hostId:old.hostId,agentSessionId:old.sessionId,cwd:original?.workspacePath,executorId:original?.executorId,label:old.sessionId,
            diagnostic:sourceIssue??'Original owner context page retained with its exact availability and continuation.'},undefined,sameCore?'local':null),
            ...(page?['Original admission-owner agent.context response: this is one bounded historical page, not complete history. Preserve its source Host, unavailable sources and nextCursor. A cursor must be continued at its original owner or a verified route; its route alias is not a grant in this new Agent’s namespace.',
              '<amux-original-context-page>',JSON.stringify(page),'</amux-original-context-page>']:[])].join('\n\n')
          result.handoverInput=await stage('handoverInputKey',{operationId,prompt})
        }
        if(!['admitted','terminal-confirmed'].includes(agentPromptSubmissionOutcome(result.handoverInput.record)))result.issue=[result.issue,'The original handover input is unconfirmed; inspect its exact key. The separate Query retains its own Core input qualification.'].filter(Boolean).join('\n')
      } catch(cause) { retainIssue(cause) }
    }
    if(intent.deferredInput) {
      try {
        result.deferredInput=await stage('deferredInputKey',intent.deferredInput)
        const outcome=result.deferredInput.input?.status==='not-applied'?'not-applied':agentPromptSubmissionOutcome(result.deferredInput.record)
        if(advance&&(outcome==='admitted'||outcome==='terminal-confirmed'||outcome==='not-applied'))await this.spatial.observeMoteMainInput(record.requestId,outcome)
      } catch(cause) { retainIssue(cause) }
    }
    result.record=spatialAgentOpenRecord((await this.spatial.read())!.graph,record.requestId)
    return result

  }

  /** Explicit entry admits the exact current role into the original Session continuity owner, without an input journal. */
  private async moteMainRecovery(method: 'space.mote.dialogue.recovery.ensure' | 'space.mote.dialogue.recovery.inspect', input: import('./mote/dialogue.js').MoteDialogueRecoveryRequest, context: AgentMuxRpcCallContext): Promise<import('./mote/dialogue.js').MoteDialogueRecoveryInspection> {
    const call = this.inputCallContext(context)
    await call.assertCurrent?.(); context.signal?.throwIfAborted()
    const owners = (await this.clients()).filter(scope => scope.hostId === input.reference.hostId)
    const scope = owners.length === 1 ? owners[0] : undefined
    if (!scope || this.endpointUnverified(scope.client)) throw new AgentMuxError('The original main execution Host is unavailable or ambiguous. Its history, draft and operation remain available.', 'CONTROL_UNAVAILABLE')
    const source = { target: input.target, expectedRoleRevision: input.expectedRoleRevision, reference: input.reference }
    const original = await scope.client.readAgentSession(input.reference.sessionId)
    const prior = original?.continuityOperations?.[input.operationId]
    if (prior && (prior.previousRun.runId !== input.expectedRun.runId || prior.moteMainEntry && !isDeepStrictEqual(prior.moteMainEntry, source)))
      throw new AgentMuxError('This recovery belongs to another original main role or Run. Inspect its unchanged original operation.', 'AGENT_CONTINUITY_OPERATION_CONFLICT')
    const unresolved = original?.continuity
    const pending = unresolved && unresolved.previousRun.runId === input.expectedRun.runId && unconfirmedMoteMainEntryOperation(unresolved) ? unresolved : null
    if (!prior && pending && !sameMoteMainEntrySource(pending.moteMainEntry, source))
      throw new AgentMuxError('This original Session and Run have an unresolved operation from another Mote or producer. Keep that original operation and this Mote reference; no new Start was admitted.', 'AGENT_CONTINUITY_OPERATION_CONFLICT')
    if (method === 'space.mote.dialogue.recovery.inspect') return { operation: prior ?? pending }
    if (prior) {
      if (!prior.moteMainEntry) throw new AgentMuxError('This operation already belongs to its original recovery producer. Inspect that operation without adding a main-role admission.', 'AGENT_CONTINUITY_OPERATION_CONFLICT')
      return { operation: prior }
    }
    const owner = this.ports.moteDialogue?.mainInput
    if (!owner) throw new AgentMuxError('The original Mote role owner is unavailable. Keep its original reference and draft.', 'CONTROL_UNAVAILABLE')
    const main = await owner.readCurrentMoteMain(input.target, context.signal)
    if (main.status !== 'ready' || !main.identity || !main.current || main.roleRevision !== input.expectedRoleRevision || !isDeepStrictEqual(main.current, input.reference))
      throw new AgentMuxError('The current main role is unbound, changed or unconfirmed. Keep its original history; no replacement Agent was started.', 'MOTE_MAIN_CHANGED')
    if (!original || original.run.runId !== input.expectedRun.runId) throw new AgentMuxError('The original main Session or Run changed. Read its original current reference before another explicit entry.', 'AGENT_SESSION_RUN_CHANGED')
    if (pending) return { operation: pending }
    const observed = await scope.client.statusAgent(input.reference.sessionId)
    if (observed.session.run.runId !== input.expectedRun.runId) throw new AgentMuxError('The original main Run changed during entry. Keep its history and read its current receipt.', 'AGENT_SESSION_RUN_CHANGED')
    // A healthy Run stays available even when optional maintenance is paused. Only a new Start is fenced.
    if (observed.run.state !== 'running') {
      const prefs = this.ports.moteQuickPreferences && await this.ports.moteQuickPreferences.read({ kind:'quick', target:input.target, includeChoices:false })
      // Only an explicit pause, disable, stop or cancellation fences this person's own open. An unconfirmed
      // maintenance reading is often the Host's own failed recovery attempt on this same Session; that
      // observation gap does not take away the explicit entry, which reports its own Core result.
      if (!prefs || prefs.status !== 'ready') throw new AgentMuxError('The original main settings are unconfirmed. Its history and manual recovery remain available.', 'CONTROL_UNAVAILABLE')
      if (prefs.defaults?.presence?.enabled === false || prefs.maintenance?.status === 'paused' || prefs.maintenance?.status === 'disabled' ||
          // An unconfirmed reading still carries its last known schedule; an explicit pause or stop there wins.
          prefs.maintenance?.schedule?.status === 'paused' || prefs.maintenance?.schedule?.status === 'stopped' ||
          observed.run.exitReason === 'user-stopped' || observed.session.continuity?.supervision?.cancellation || observed.session.continuity?.supervision?.phase === 'cancelled')
        throw new AgentMuxError('The original main was explicitly paused, stopped or cancelled. Its history remains readable; use its original explicit recovery or maintenance control.', 'MOTE_MAIN_RECOVERY_PAUSED')
    }
    await owner.assertCurrent(main, context.signal); await call.assertCurrent?.(); context.signal?.throwIfAborted()
    const intent: import('./agent-session-recovery/continuity-contract.js').AgentMuxAgentContinuityInput = { agentSessionId:input.reference.sessionId, expectedRun:input.expectedRun,
      operationId:input.operationId, trigger:'manual', moteMainEntry:source,
      policy:{ continuationEnabled:false, reminderMode:'off', retryMaxAttempts:0, recheckMaxAttempts:0 } }
    // Hosted SDK accepts the one typed intent; its original semantic Host
    // supplies its own trusted context, never a serialized callback argument.
    const result = scope.client.runtimeOwnerIdentity ? await scope.client.ensureAgentContinuity(intent)
      : await scope.client.ensureAgentContinuity(intent, call)
    const retained = (await scope.client.readAgentSession(input.reference.sessionId))?.continuityOperations?.[input.operationId] ?? result.continuity
    return { operation:retained ?? null }
  }

  /** Logical intake adds only an immutable route to the original journal. Original Core remains the sole input owner. */
  private async moteMainInput(method: 'space.mote.dialogue.input.submit' | 'space.mote.dialogue.input.inspect', input: import('./mote/dialogue.js').MoteDialogueInputSubmit | import('./mote/dialogue.js').MoteDialogueInputRead, context: AgentMuxRpcCallContext): Promise<import('./mote/dialogue.js').MoteDialogueInputInspection> {
    const owner=this.ports.moteDialogue?.mainInput
    return method==='space.mote.dialogue.input.submit'&&owner?.withRole?await owner.withRole(input.target,()=>this.moteMainInputInRole(method,input,context)):await this.moteMainInputInRole(method,input,context)
  }
  private async moteMainInputInRole(method: 'space.mote.dialogue.input.submit' | 'space.mote.dialogue.input.inspect', input: import('./mote/dialogue.js').MoteDialogueInputSubmit | import('./mote/dialogue.js').MoteDialogueInputRead, context: AgentMuxRpcCallContext): Promise<import('./mote/dialogue.js').MoteDialogueInputInspection> {
    const mainOwner = this.ports.moteDialogue?.mainInput
    if (!mainOwner) throw new AgentMuxError('The original Mote main input owner is unavailable. Keep the draft and original operation; no input was sent.', 'CONTROL_UNAVAILABLE')
    await this.inputCallContext(context).assertCurrent?.(); context.signal?.throwIfAborted()
    // This original Host read is the admission linearization point, not a client snapshot.
    const main = await mainOwner.readCurrentMoteMain(input.target,context.signal)
    if (!main.identity) throw new AgentMuxError('The original Mote identity is unconfirmed. Keep its original draft and input key.', 'MOTE_MAIN_CHANGED')
    const parsed = 'input' in input ? parseAgentInputSubmit(input.input) : null
    const recovery = 'input' in input ? input.recovery : undefined
    const journal = await this.messageRouteJournal(), submit = parsed ? {...parsed,...(parsed.capturedContext ? {} : {moteGuidance:true as const})} : null
    const operationId = submit?.operationId ?? (input as import('./mote/dialogue.js').MoteDialogueInputRead).operationId
    let route = await journal.readMoteMainInputRoute(main.identity,operationId)
    let firstIntake = false
    let rollover: import('./mote/main-period.js').MoteMainRolloverReading | undefined
    if (submit) {
      const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => [k,canonical(v)])) : value
      const {preparationRetry:_preparationRetry,...stableIntent} = submit
      const digest = createHash('sha256').update(JSON.stringify(canonical({input:stableIntent,...(recovery ? {recovery:{operationId:recovery.operationId}} : {})}))).digest('hex')
      const key = {kind:'prompt' as const,agentSessionId:submit.agentSessionId,expectedRun:submit.expectedRun,submissionId:submit.operationId}
      const expectedRoleRevision = (input as import('./mote/dialogue.js').MoteDialogueInputSubmit).expectedRoleRevision
      if (route) {
        if (route.intentDigest !== digest || route.roleRevision !== expectedRoleRevision || !isDeepStrictEqual(route.key,key)) throw new AgentMuxError('This logical main input already names another original role, target or content. Keep its original input key.', 'AGENT_PROMPT_OPERATION_CONFLICT')
      } else {
        if (main.status !== 'ready' || !main.current || !main.roleRevision || main.roleRevision !== expectedRoleRevision || main.current.sessionId !== submit.agentSessionId)
          throw new AgentMuxError('The main Agent changed before accepting this logical input. The original draft was retained; no later Agent received it.', 'MOTE_MAIN_CHANGED')
        const owners = (await this.clients()).filter(scope => scope.hostId === main.current!.hostId)
        if (owners.length !== 1 || this.endpointUnverified(owners[0]!.client)) throw new AgentMuxError('The exact current main Host is unavailable or ambiguous. Keep the original draft.', 'CONTROL_UNAVAILABLE')
        const prior = await this.inspectMainInputAt(owners[0]!, key, context)
        const priorRecovery = recovery && (await owners[0]!.client.readAgentSession(key.agentSessionId))?.continuityOperations?.[recovery.operationId]
        if (prior.input || prior.record || priorRecovery) {
          const concurrent = await journal.readMoteMainInputRoute(main.identity,operationId)
          if (!concurrent) throw new AgentMuxError('This input already belongs to its original producer. Inspect that original key; no main role or new platform guidance was added.', 'MOTE_MAIN_INPUT_PREEXISTING')
          if (concurrent.intentDigest !== digest || concurrent.roleRevision !== expectedRoleRevision || !isDeepStrictEqual(concurrent.key,key)) throw new AgentMuxError('This logical main input already names another original role, target or content. Keep its original input key.', 'AGENT_PROMPT_OPERATION_CONFLICT')
          route = concurrent
        } else {
          // Only a new logical Query can change its Main. A pre-existing input
          // producer or retained route keeps its original Session and operation.
          rollover=await this.evaluateMoteRollover(main,key,journal,context)
          if(rollover.status==='due')return {route:null,record:null,input:null,disposition:'rollover-required',rollover}
          // Validate an existing Host capture before freezing a new role route. This read grants no input authority.
          if (submit.capturedContext) await resolveAgentInputContextCapture({reference:submit.capturedContext.reference,
            agentSessionId:submit.agentSessionId,expectedRun:submit.expectedRun,operationId:submit.operationId,prompt:submit.prompt,
            ...(submit.capturedContext.agentMuxNote === undefined ? {} : {agentMuxNote:submit.capturedContext.agentMuxNote})},
            async () => undefined,this.ports.inputContextCaptures,context.signal)
          await mainOwner.assertCurrent(main,context.signal)
          const claimed = await journal.claimMoteMainInputRoute({identity:main.identity,operationId,roleRevision:main.roleRevision,reference:main.current,key,
            runtimeId:owners[0]!.client.runtimeOwnerIdentity?.()?.runtimeId ?? null,intentDigest:digest,admittedAt:Date.now(),...(rollover?{rollover}:{}),
            ...(recovery ? {recoveryOperationId:recovery.operationId} : {})})
          route = claimed.route; firstIntake = claimed.created
        }
      }
    }
    if (!route) return {route:null,record:null,input:null}
    const owners = (await this.clients()).filter(scope => scope.hostId === route!.reference.hostId)
    const scope = owners.length === 1 ? owners[0] : undefined
    if (!scope || this.endpointUnverified(scope.client) || route.runtimeId !== null && scope.client.runtimeOwnerIdentity?.()?.runtimeId !== route.runtimeId)
      throw new AgentMuxError('The original logical input Host is unavailable or changed. Its role and input key remain frozen; no replacement Agent received input.', 'CONTROL_UNAVAILABLE')
    if (route.recoveryOperationId) {
      if (submit && (firstIntake || recovery?.reconcile === true)) {
        const device = this.ports.operationSource?.(context)
        await scope.client.ensureAgentContinuity({agentSessionId:route.key.agentSessionId,expectedRun:route.key.expectedRun,operationId:route.recoveryOperationId,trigger:'input',
          input:{submissionId:route.operationId,prompt:submit.prompt,authorHuman:true,sourceChannel:submit.sourceChannel ?? (context.transport === 'unix' ? 'cli' : 'api'),
            ...(device ? {sourceDevice:normalizeOperationDevice(device)} : {}),
            ...(submit.capturedContext ? {inputContextCapture:submit.capturedContext.reference,
              ...(submit.capturedContext.agentMuxNote === undefined ? {} : {agentMuxNote:submit.capturedContext.agentMuxNote})} : {agentMuxNote:agentInputGuidance(submit)}),
            ...(submit.inputContext ? {inputContext:submit.inputContext} : {})}},
          {...this.inputCallContext(context),...(this.ports.inputContextCaptures ? {captureReader:this.ports.inputContextCaptures} : {})})
      }
      const retained = (await scope.client.readAgentSession(route.key.agentSessionId))?.continuityOperations?.[route.recoveryOperationId] ?? null
      const key = retained?.launchInput?.key
      const original = key ? await this.inspectMainInputAt(scope,key,context) : {record:null,input:null}
      return {...(route.rollover?{rollover:route.rollover}:{}),route,record:original.record,input:original.input ?? null,recovery:retained}
    }
    const observed = await this.inspectMainInputAt(scope,route.key,context)
    // Accepted, waiting and unknown original inputs are reads, never another submit or a later role.
    const notApplied = observed.input?.status === 'not-applied' || observed.record && agentPromptNotApplied({run:observed.record.run,
      ...(observed.record.admission ? {promptCompletionAdmission:observed.record.admission} : {}),
      ...(observed.record.terminalPromptSubmission ? {terminalPromptSubmission:observed.record.terminalPromptSubmission} : {})})
    const explicitPreparationRetry = submit?.preparationRetry && notApplied
    if (!submit || !firstIntake && !explicitPreparationRetry || (observed.input || observed.record) && !explicitPreparationRetry) return {...(route.rollover?{rollover:route.rollover}:{}),route,record:observed.record,input:observed.input ?? null}
    const result = await this.submitInputAt(scope,submit,context)
    return {...(route.rollover?{rollover:route.rollover}:{}),route,record:result.record,input:result.input ?? null,...(rollover?{rollover}:{})}
  }

  private async evaluateMoteRollover(main: import('./mote/dialogue.js').MoteMainSnapshot, queryInputKey:Extract<import('./agent-prompt-condition.js').AgentPromptInputKey,{kind:'prompt'}>, journal:DurableAgentMuxMessageQueue, context:AgentMuxRpcCallContext):Promise<import('./mote/main-period.js').MoteMainRolloverReading> {
    const operationId=queryInputKey.submissionId
    let rollover:import('./mote/main-period.js').MoteMainRolloverReading={status:'unconfirmed',decision:null,issue:'The original Main dialogue activity is unconfirmed. Existing input remains available.'}
    if(main.status!=='ready'||!main.identity||!main.current||!main.roleRevision)return rollover
    try {
        let preference:import('./mote/preferences.js').MoteQuickPreferencesReadResult|undefined
        try { preference=this.ports.moteQuickPreferences&&await this.ports.moteQuickPreferences.read({kind:'quick',target:main.target,includeChoices:false}) }
        catch { throw new AgentMuxError('The saved Main Executor choice could not be read. Keep this Query and inspect the original Mote settings; no input was sent.','MOTE_MAIN_EXECUTOR_UNCONFIRMED') }
        if(!preference?.defaults||!preference.source?.resource||!['read','deleted'].includes(preference.source.result.status))throw new AgentMuxError('The saved Main Executor choice is unconfirmed. Keep this Query and inspect the original Mote settings; no input was sent.','MOTE_MAIN_EXECUTOR_UNCONFIRMED')
        // Original MOTE facts survive unrelated choice/catalog observations.
        // Only their owner supplies defaults; Core never reparses display text or YAML.
        const policy=preference.defaults.conversationRollover
        const executorId=preference.defaults.executorId
        let originalMain:{scope:AgentMuxRpcCoreClient;session:NonNullable<Awaited<ReturnType<AgentMuxRpcCoreClient['client']['readAgentSession']>>>}|undefined
        if(executorId) {
          const scopes=(await this.clients()).filter(scope=>scope.hostId===main.current!.hostId),scope=scopes.length===1?scopes[0]:undefined
          if(!scope||this.endpointUnverified(scope.client))throw new AgentMuxError('The original Main Executor owner is unconfirmed. Keep this Query and inspect that original Host; no input was sent.', 'MOTE_MAIN_EXECUTOR_UNCONFIRMED')
          let session:Awaited<ReturnType<typeof scope.client.readAgentSession>>
          try { session=await scope.client.readAgentSession(main.current.sessionId) }
          catch { throw new AgentMuxError('The original Main Executor could not be read. Keep this Query and inspect the original Session; no input was sent.', 'MOTE_MAIN_EXECUTOR_UNCONFIRMED') }
          if(!session||session.agentSessionId!==main.current.sessionId||!session.executorId)throw new AgentMuxError('The original Main Executor is unconfirmed. Keep this Query and inspect the original Session; no input was sent.', 'MOTE_MAIN_EXECUTOR_UNCONFIRMED')
          if(queryInputKey.agentSessionId!==session.agentSessionId||queryInputKey.expectedRun.runId!==session.run.runId)throw new AgentMuxError('The original Main Run changed before this new Query. Keep its original key and inspect that Session.','MOTE_MAIN_CHANGED')
          originalMain={scope,session}
          if(session.executorId!==executorId) {
            const choice={kind:'executor-change' as const,previousExecutorId:session.executorId,executorId}
            const policyRevision=createHash('sha256').update(JSON.stringify([main.identity,choice])).digest('hex')
            const creationOperationId='mote-rollover:'+createHash('sha256').update(JSON.stringify([main.identity,main.roleRevision,policyRevision,operationId])).digest('hex')
            await this.ports.moteDialogue?.mainInput?.assertCurrent(main,context.signal)
            return {status:'due',decision:{target:main.target,expectedRoleRevision:main.roleRevision,reference:main.current,
              queryInputKey,policyRevision,policy:choice,evaluatedAt:Date.now(),queryOperationId:operationId,creationOperationId},issue:null}
          }
        }
        if(policy?.kind==='idle') {
          rollover={status:'unconfirmed',decision:null,issue:'The original Main dialogue idle source is unconfirmed. Its existing input remains available.'}
          const original=originalMain?.session,continuity=original?.continuity
          // A stored failure is not a live death detector. Only this exact ended
          // Run's still-current Core receipt may qualify a separately new Query.
          if(originalMain&&original&&continuity?.kind==='unavailable'&&continuity.reason==='native-handle-unavailable'&&
            continuity.agentSessionId===original.agentSessionId&&continuity.previousRun.runId===queryInputKey.expectedRun.runId&&
            !continuity.newRun&&continuity.evidence.kind==='run-ended'&&
            isDeepStrictEqual(original.continuityOperations?.[continuity.operationId],continuity)&&
            (!continuity.moteMainEntry||continuity.moteMainEntry.expectedRoleRevision===main.roleRevision&&sameMoteMainEntrySource(continuity.moteMainEntry,{target:main.target,expectedRoleRevision:main.roleRevision,reference:main.current}))) {
            const observed=await originalMain.scope.client.statusAgent(original.agentSessionId),current=observed.session
            if(observed.run.runId===queryInputKey.expectedRun.runId&&['exited','interrupted'].includes(observed.run.state)&&
              current.agentSessionId===original.agentSessionId&&current.run.runId===queryInputKey.expectedRun.runId&&
              !current.nativeHandle&&!current.observedNativeHandle&&!current.nativeSourceObservation&&
              isDeepStrictEqual(current.continuity,continuity)&&isDeepStrictEqual(current.continuityOperations?.[continuity.operationId],continuity)&&
              !Object.values(current.continuityOperations??{}).some(operation=>operation.previousRun.runId===queryInputKey.expectedRun.runId&&unconfirmedMoteMainEntryOperation(operation))) {
              const source={operationId:continuity.operationId,previousRun:continuity.previousRun,reason:'native-handle-unavailable' as const,evidence:continuity.evidence}
              const choice={kind:'continuity-unavailable' as const,idleMs:policy.idleMs}
              const policyRevision=createHash('sha256').update(JSON.stringify([main.identity,choice,source])).digest('hex')
              const creationOperationId='mote-rollover:'+createHash('sha256').update(JSON.stringify([main.identity,main.roleRevision,policyRevision,operationId])).digest('hex')
              await this.ports.moteDialogue?.mainInput?.assertCurrent(main,context.signal)
              return {status:'due',decision:{target:main.target,expectedRoleRevision:main.roleRevision,reference:main.current,
                queryInputKey,policyRevision,policy:choice,continuity:source,evaluatedAt:Date.now(),queryOperationId:operationId,creationOperationId},issue:null}
            }
          }
          const latest=await journal.latestMoteMainInputRoute(main.identity,main.roleRevision)
          if(latest) {
            const scopes=(await this.clients()).filter(scope=>scope.hostId===latest.reference.hostId),scope=scopes.length===1?scopes[0]:undefined
            if(scope&&!this.endpointUnverified(scope.client)&&isDeepStrictEqual(latest.reference,main.current)&&
              (latest.runtimeId===null||scope.client.runtimeOwnerIdentity?.()?.runtimeId===latest.runtimeId)) {
              let inputKey=latest.key
              if(latest.recoveryOperationId) {
                const source=await scope.client.readAgentSession(latest.key.agentSessionId)
                const recovery=source?.continuityOperations?.[latest.recoveryOperationId],launch=recovery?.launchInput,recoveredKey=launch?.key
                // The route keeps its pre-recovery Run. Only its original continuity
                // receipt can bind that same human Query to the resumed Run.
                if(!recovery||recovery.operationId!==latest.recoveryOperationId||recovery.agentSessionId!==latest.key.agentSessionId||
                  recovery.trigger!=='input'||recovery.kind!=='resumed'||recovery.previousRun.runId!==latest.key.expectedRun.runId||
                  !recoveredKey||recoveredKey.agentSessionId!==latest.key.agentSessionId||recoveredKey.submissionId!==latest.operationId||
                  launch?.input.submissionId!==latest.operationId||launch.input.authorHuman!==true||
                  !['launch-carried','terminal-confirmed','native-admitted'].includes(launch.state)||
                  recoveredKey.expectedRun.runId!==recovery.newRun?.runId||recovery.newRun.runId!==source?.run.runId)return rollover
                inputKey=recoveredKey
              }
              const observed=await this.inspectMainInputAt(scope,inputKey,context,true),idle=observed.record?.semanticIdle
              const session=await scope.client.readAgentSession(inputKey.agentSessionId)
              const sourceNow=observed.sourceNow
              if(idle&&session&&inputKey.expectedRun.runId===session.run.runId&&idle.run.runId===session.run.runId&&
                idle.promptSubmissionId===latest.operationId&&session.nativeHandle?.kind==='provider'&&idle.nativeSessionId===session.nativeHandle.sessionId&&
                !session.pendingInteraction&&observed.activity?.state==='idle'&&
                typeof sourceNow==='number'&&sourceNow>=idle.observedAt) {
                const elapsed=sourceNow-idle.observedAt
                if(elapsed>=policy.idleMs) {
                  const policyRevision=createHash('sha256').update(JSON.stringify([main.identity,policy])).digest('hex')
                  const creationOperationId='mote-rollover:'+createHash('sha256').update(JSON.stringify([main.identity,main.roleRevision,policyRevision,operationId])).digest('hex')
                  await this.ports.moteDialogue?.mainInput?.assertCurrent(main,context.signal)
                  const decision={target:main.target,expectedRoleRevision:main.roleRevision,reference:main.current,queryInputKey,policyRevision,policy,
                    activity:{inputKey,run:idle.run,sourceId:idle.sourceId,sequence:idle.sequence,idleSince:idle.observedAt},evaluatedAt:sourceNow,queryOperationId:operationId,creationOperationId}
                  return {status:'due',decision,issue:null}
                }
                rollover={status:'not-due',decision:null,issue:null}
              }
            }
          } else if(!latest) rollover={status:'not-due',decision:null,issue:null}
        } else rollover={status:'keep-current',decision:null,issue:null}
    } catch(error){if(error instanceof AgentMuxError&&['MOTE_MAIN_EXECUTOR_UNCONFIRMED','MOTE_MAIN_CHANGED'].includes(error.code))throw error;return {status:'unconfirmed',decision:null,issue:'Inspecting the original rollover source failed: '+String(error)}}
    return rollover
  }

  private async inspectMainInputAt(scope: AgentMuxRpcCoreClient, key: Extract<import('./agent-prompt-condition.js').AgentPromptInputKey,{kind:'prompt'}>, context: AgentMuxRpcCallContext, activity = false) {
    if (scope.client.forwardRpc) return await scope.client.forwardRpc('agent.input.inspect',{key,...(activity ? {activity:true} : {})},context)
    if (scope.hostId === 'local' && this.ports.callOriginalCore) return await this.ports.callOriginalCore('local','agent.input.inspect',{key,...(activity ? {activity:true} : {})},context)
    const input = await scope.client.inspectAgentInput({key})
    return {...(activity ? {activity:await scope.client.readAgentInputActivity(key)} : {}),sourceNow:scope.hostId==='local'?Date.now():undefined,input,record:input ? input.admission : await scope.client.inspectAgentPromptSubmission(key)}
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
    if (caller && caller.client !== owner.client) {
      const { packet } = await caller.client.prepareFederatedMessage({ caller: { agentSessionId: caller.agentSessionId, capability: caller.capability },
        ...(route.targetKeyFingerprint === undefined ? {} : { targetKeyFingerprint: route.targetKeyFingerprint }),
        ...(route.recipientInputEpoch===undefined?{}:{recipientInputEpoch:route.recipientInputEpoch}),
        target: { runtimeId: route.runtimeId!, agentSessionId: route.agentSessionId, runId: route.expectedRun.runId }, text: rpcText(p.text, 'Message text'), operationId: route.operationId, messageId: route.messageId,
        ...(p.application === undefined ? {} : { application: parseMessageApplication(p.application) }),
        ...(p.threadId === undefined ? {} : { threadId: rpcString(p.threadId, 'Thread ID') }), ...(p.correlationId === undefined ? {} : { correlationId: rpcString(p.correlationId, 'Correlation ID') }),
        ...(p.replyTo === undefined ? {} : { replyTo: rpcString(p.replyTo, 'Reply source') }), sourceChannel: normalizeMessageChannel(p.sourceChannel ?? 'api') })
      const receipt = await owner.client.forwardRpc!('message.federation.intake', { packet }, { ...(context.signal ? { signal: context.signal } : {}) })
      if (receipt.recipientInbox) await caller.client.recordFederatedInboxReceipt(receipt.recipientInbox)
      return receipt
    }
    return await owner.client.forwardRpc!('agent.send', { ...p, operationId: route.operationId, messageId: route.messageId,
      recipientInputEpoch:route.recipientInputEpoch, expectedRun: route.expectedRun, target: { kind: 'agent-session', agentSessionId: route.agentSessionId } } as AgentMuxRpcParams<'agent.send'>,
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
        recipientInputEpoch:target.recipientInputEpoch, expectedRun: { runId: target.runId }, sourceChannel: intent.sourceChannel }, owner, context)
    })
  }

  private async send(p: Record<string, unknown>, caller: Awaited<ReturnType<AgentMuxRpcService['authenticated']>>, context: AgentMuxRpcCallContext) {
    const target = rpcRecord(p.target)
    if (target.kind === 'reply') {
      rpcRecord(target, ['kind', 'sourceMessageId'])
      const owner = this.requireCaller(caller), operationId = rpcString(p.operationId, 'Operation ID')
      const messageId = p.messageId === undefined ? 'message-' + createHash('sha256').update(operationId).digest('hex') : rpcString(p.messageId, 'Message ID')
      if (p.execution !== undefined && p.execution !== 'default' || p.admissionIntent !== undefined) throw new AgentMuxError('A signed remote reply retains its original Inbox execution.', 'INVALID_CONTROL_REQUEST')
      const prepared = await owner.client.prepareFederatedMessage({ caller: { agentSessionId: owner.agentSessionId, capability: owner.capability },
        ...(p.expectedRun === undefined ? {} : { expectedRun: { runId: rpcString(rpcRecord(p.expectedRun, ['runId']).runId, 'Expected recipient Run') } }),
        ...(p.recipientInputEpoch===undefined?{}:{recipientInputEpoch:optionalInputEpoch(p.recipientInputEpoch).inputEpoch}),
        replySourceMessageId: rpcString(target.sourceMessageId, 'Original reply source'), text: rpcText(p.text, 'Message text'), operationId, messageId,
        ...(p.application === undefined ? {} : { application: parseMessageApplication(p.application) }),
        ...(p.threadId === undefined ? {} : { threadId: rpcString(p.threadId, 'Thread ID') }),
        ...(p.correlationId === undefined ? {} : { correlationId: rpcString(p.correlationId, 'Correlation ID') }),
        ...(p.replyTo === undefined ? {} : { replyTo: rpcString(p.replyTo, 'Reply source') }), sourceChannel: normalizeMessageChannel(p.sourceChannel ?? 'api') })
      return prepared.receipt
    }
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
      threadId, correlationId, replyTo, ...(p.recipientInputEpoch===undefined?{}:{recipientInputEpoch:p.recipientInputEpoch}),
      admissionIntent: addressed ?? null, application: p.application === undefined ? null : parseMessageApplication(p.application) })).digest('hex')
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
      rpcRecord(target, ['kind', 'agentSessionId', 'hostId'])
      recipientId = (await this.owner(rpcString(target.agentSessionId, 'Recipient Session ID'), false, target.hostId === undefined ? undefined : rpcString(target.hostId, 'Recipient Host'))).agentSessionId
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
    const recipientOwner = await this.owner(recipientId, false, target.kind === 'agent-session' && target.hostId !== undefined ? rpcString(target.hostId, 'Recipient Host') : undefined)
    if (recipientOwner.client.forwardRpc || recipientOwner.hostId === 'local' && this.ports.callOriginalCore) {
      if (caller && caller.client !== recipientOwner.client && (p.execution === 'immediate' || addressed)) throw new AgentMuxError('Remote managed messages use their original peer Inbox intake.', 'INVALID_CONTROL_REQUEST')
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
      const messageAuthority = caller && caller.client !== recipientOwner.client ? await recipientOwner.client.agentMessageAuthority() : undefined
      const route = await routes.claimMessageRoute({ operationId, messageId, hostId: recipientOwner.hostId,
        ...(messageAuthority ? { targetKeyFingerprint: messageAuthority.fingerprint } : {}),
        runtimeId: recipientOwner.client.runtimeOwnerIdentity?.()?.runtimeId ?? null,
        ...(p.recipientInputEpoch===undefined?{}:{recipientInputEpoch:optionalInputEpoch(p.recipientInputEpoch).inputEpoch}),
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
    const directIntent = addressed ?? { kind: 'manual-actor' as const, expectedRun: { ...durable.run },...optionalInputEpoch(p.recipientInputEpoch) }
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
      recipientSessionId: recipientId, recipientRunId: original ? original.envelope.recipientRunId : recipient.run.runId,
      ...(p.recipientInputEpoch===undefined?{}:{recipientInputEpoch:optionalInputEpoch(p.recipientInputEpoch).inputEpoch}), body: text, ...(p.application === undefined ? {} : { application: parseMessageApplication(p.application) }) }
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
      // The recipient's owner names its automatic notification path on the same status a read returns.
      const current = await recipientOwner.client.readMessage({ messageId: saved.messageId,
        caller: { agentSessionId: caller!.agentSessionId, capability: caller!.capability } })
      return current?.notification ? { ...saved, notification: current.notification } : saved
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
    // Config directories come from their registered owner, including a confirmed empty list.
    let extra: Partial<AgentMuxRpcSnapshot> = {}, snapshotIssue: ReturnType<typeof unavailable> | undefined
    if (this.ports.snapshot) try { extra = await this.ports.snapshot(filters) }
    catch (error) { snapshotIssue = unavailable(error) }
    await Promise.all(sources.map(async ([source, operation]) => {
      if (!wanted(source) && !(source === 'spaces' && ['zones', 'workspaces'].some(wanted)) &&
        !(source === 'goals' && ['decisions', 'activity'].some(wanted))) return
      if ((source === 'projects' || source === 'executors') && Object.hasOwn(extra, source)) return
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
      for (const [key, value] of Object.entries(extra)) if (key === 'unavailable') observation.unavailable.push(...value as AgentMuxRpcSnapshot['unavailable'])
        else if (Object.hasOwn(observation, key) && wanted(key)) (observation as unknown as Record<string, unknown>)[key] = value
      if (snapshotIssue) observation.unavailable.push({ source: 'filesystem', ...snapshotIssue })
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
    this.assertExposed(method)
    if (method === 'file.mutation.watch') params = structuredClone(parseFileMutationWatchParams(params)) as unknown as Record<string, unknown>
    await assertHostRouteDispatch(context, method, params, true)
    if (method === 'agent.execution.watch') assertExecutionBindingAuthority(context)
    if (method === 'route.watch' || method === 'route.receive-watch') {
      if (!this.ports.hostRoutes) throw new AgentMuxError('The original route reader owner is unavailable.', 'CONTROL_UNAVAILABLE')
      return await this.ports.hostRoutes.watch(method === 'route.watch' ? parseHostRouteParams('route.watch', params) : parseHostRouteParams('route.receive-watch', params), event => onEvent((event && typeof event === 'object' && ['error', 'end'].includes(String((event as { type?: unknown }).type)) ? event : { type: 'route-event', event }) as AgentMuxRpcStreamEvent<M>), context, method === 'route.receive-watch') as AgentMuxRpcServiceSubscription<M>
    }
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
    if (method === 'file.mutation.watch' && !this.ports.files?.watchMutations && this.ports.forwardSubscription) {
      const input = parseFileMutationWatchParams(params)
      let initial: import('./public-rpc-file-mutations.js').FileMutationWatchOpening | undefined
      let started = false, closed = false, busy = false, earlyFailure: Error | undefined
      let subscription: { dispose(): Promise<void> } | undefined
      const send = (event: AgentMuxRpcStreamEvent<'file.mutation.watch'>) => onEvent(event as AgentMuxRpcStreamEvent<M>)
      const fail = (cause: unknown) => {
        if (closed) return
        const failure = cause instanceof Error ? cause : new Error(String(cause))
        closed = true
        if (!started) earlyFailure = failure
        else { try { void Promise.resolve(send({ type: 'error', error: readerError(failure) })).catch(() => {}) } catch { /* This reader is detached below. */ } }
        void subscription?.dispose().catch(() => {})
      }
      subscription = await this.ports.forwardSubscription('file.mutation.watch', input, {
        onInitial: value => { initial = parseFileMutationWatchOpening(value, input) },
        onEvent: raw => {
          if (closed || !started) return // Delivery begins after this owner's opening response.
          if (busy) { fail(new AgentMuxError('The forwarded Files observer overflowed. Keep original requests and inspect their operations.', 'FILE_MUTATION_OBSERVATION_GAP')); return }
          busy = true
          const event = structuredClone(raw)
          void Promise.resolve().then(async () => {
            context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
            if (closed) return
            if (event.type === 'effect') parseFileMutationEffect(event.data, initial!.resource)
            await send(event)
          }).catch(fail).finally(() => { busy = false })
        },
        onEnd: error => fail(error ?? new AgentMuxError('The original forwarded Files observer ended. Reconnect without replaying mutations.', 'FILE_MUTATION_OBSERVATION_ENDED')),
        ...(context.signal ? { signal: context.signal } : {}), ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {})
      }, context)
      try {
        if (!initial) throw new AgentMuxError('Forwarded Files observation returned without its original opening.', 'CONTROL_PROTOCOL_ERROR')
        if (earlyFailure) throw earlyFailure
        context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
        if (earlyFailure) throw earlyFailure
      } catch (cause) { closed = true; await subscription.dispose(); throw cause }
      return { initial: initial as AgentMuxRpcStreamInitial<M>, start: async () => {
        started = true
        // A source can close while the outer opening is being written. Report
        // that one gap after opening, rather than silently retaining an idle reader.
        if (earlyFailure) { await send({ type: 'error', error: readerError(earlyFailure) }); return }
        try { context.signal?.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context) }
        catch (cause) { fail(cause) }
      }, dispose: async () => { closed = true; await subscription!.dispose() } }
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
      if (method === 'agent.execution.watch') {
        const input = parseAgentExecutionBinding(params)
        const owner = this.ports.executionBindings
        if (!owner?.watch) throw new AgentMuxError('The original execution binding observation is unavailable. Its intent and Runs are retained.', 'CONTROL_UNAVAILABLE')
        const sub = await owner.watch(input.bindingId, async inspection => {
          controller.signal.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
          await emit({ type: 'snapshot', data: parseAgentExecutionBindingObservation({ bindingId: input.bindingId, inspection }, input.bindingId) })
        }, { ...context, signal: controller.signal, onError: error => {
          void Promise.resolve(emit({ type: 'error', error: readerError(error) })).catch(() => {}).finally(() => dispose())
        } })
        cleanup = () => sub.dispose()
        controller.signal.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
        initial = parseAgentExecutionBindingObservation(sub.initial, input.bindingId)
        start = async () => { controller.signal.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context); sub.start() }
      } else if (method === 'space.member.watch') {
        const input = parseSpaceMemberParams('space.member.watch', params)
        const original = await this.spaceMemberRuntime(input, { ...context, signal: controller.signal })
        const membership = await this.spaceAuthority.watch({ reference: input.target.reference }, async event => {
          try { if (event.type === 'error') throw new AgentMuxError(event.error.message, event.error.code); await original.assertCurrent() }
          catch (error) { if (!closed) { await emit({ type: 'error', error: readerError(error) }); await dispose() } }
        }, controller.signal)
        let reader: Awaited<ReturnType<typeof original.port.subscribe>> | undefined
        cleanup = async () => { membership.dispose(); await reader?.dispose() }
        await original.assertCurrent()
        reader = await original.port.subscribe(input.call.method, input.call.params, event => emit(event), original.context)
        initial = reader.initial
        start = async () => { membership.start(); await original.assertCurrent(); await reader!.start?.() }
      } else if (method === 'space.sessions.watch') {
        const input = parseSpaceAuthorityParams('space.snapshot', params)
        // Reuse the Runtime domain's original user/device boundary; an Agent
        // caller cannot obtain another identity by entering through a Space.
        const original = await this.hosted('runtime.owner.identity', {}, context)
        let queue: ReturnType<typeof createHostedTransferQueue>
        const reader = await observeSpaceSessions({ authority: this.spaceAuthority,
          sources: snapshot => readSpaceSessionSources(this.spatial, snapshot),
          observe: createSpaceSessionObserver({ local: original.owner, clients: async (hostId, signal) => await this.ports.coreClients?.(hostId, { signal }) ?? [],
            context: { ...context, signal: controller.signal }, reference: input.reference, ...(this.ports.hostRoutes ? { gateway: this.ports.hostRoutes } : {}) }) },
        input.reference, value => queue.write(hostedTransfer({ kind: 'event', event: value }, mintObjectId())), error => queue.fail(error), controller.signal)
        let admitted: string | undefined
        queue = createHostedTransferQueue(async event => {
          if (event.type === 'snapshot' && event.data.transferId !== admitted) {
            controller.signal.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context); admitted = event.data.transferId
          }
          await emit(event)
        }, reader.initial, () => { void dispose().catch(() => {}) })
        initial = { ...reader.initial, transferId: queue.initialId }
        cleanup = () => { queue.close(); reader.dispose() }
        start = async () => { await queue.start(); if (!closed) await reader.start() }
      } else if (method === 'space.snapshot' || method === 'space.watch') {
        const input = parseSpaceAuthorityParams(method, params)
        const sendValue = async (value: import('./space-authority.js').SpaceSnapshot | import('./space-authority.js').SpaceChange) => {
          // One admitted observation has one author/fence check. Each physical
          // frame still observes cancellation without another forwarding round trip.
          controller.signal.throwIfAborted(); await context.assertCurrent?.(); await this.assertRuntimeFence(context)
          for (const chunk of spaceTransfer(value)) {
            controller.signal.throwIfAborted()
            if (!closed) await emit({ type: 'snapshot', data: chunk })
          }
        }
        if (method === 'space.snapshot') {
          const snapshot = await this.spaceAuthority.snapshot(input.reference, controller.signal)
          initial = spaceStreamOpening(snapshot)
          start = async () => { try { await sendValue(snapshot); if (!closed) await emit({type:'end',data:{}}) } catch (error) { if (!closed) await emit({type:'error',error:readerError(error)}) } finally { await dispose() } }
        } else {
          const sub = await this.spaceAuthority.watch(input, async event => {
            if (event.type === 'change') await sendValue(event.data)
            else if (!closed) { await emit(event); await dispose() }
          }, controller.signal)
          initial = spaceStreamOpening(sub.initial.snapshot, sub.initial.gap)
          start = async () => { try { await sendValue(sub.initial.snapshot); if (!closed) sub.start() } catch(error) { await emit({type:'error',error:readerError(error)}); await dispose() } }
          cleanup = sub.dispose
        }
      } else if (method === 'connection.metadata.watch') {
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
      } else if (method === 'terminal.output') {
        const input = parseTerminalOutputParams(params), target = input.target
        if (caller || !context.principal || !['user', 'device'].includes(context.principal.kind))
          throw new AgentMuxError('Raw Terminal reads require the original transport-approved person or device.', 'CONTROL_PERMISSION_DENIED')
        await context.assertCurrent?.()
        const scopes = (await this.clients()).filter(scope => scope.hostId === target.hostId)
        if (scopes.length !== 1) throw new AgentMuxError('The exact Terminal execution Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
        const scope = scopes[0]!, cursor = input.afterByte ?? 0, runId = target.run.runId
        if (scope.client.forwardRpc) {
          if (!scope.client.subscribeRpc) throw new AgentMuxError('The original Terminal output transport is unavailable.', 'CONTROL_UNAVAILABLE')
          const original = { ...input, target: { ...target, hostId: 'local' } }
          const forwarded = await this.inputForwardContext(context)
          const reader = await scope.client.subscribeRpc('terminal.output', original, {
            signal: controller.signal, ...(forwarded.forwarding ? { forwarding: forwarded.forwarding } : {}),
            onInitial: value => { initial = { ...parseTerminalInspection(value, original.target, original), target } },
            onEvent: event => { void emit(event) }, onEnd: error => { if (error) { void emit({ type: 'error', error: readerError(error) }); void dispose() } }
          })
          cleanup = () => reader.dispose()
          if (!initial) throw new AgentMuxError('Original Terminal reader omitted its opening.', 'CONTROL_PROTOCOL_ERROR')
        } else {
          if (!scope.client.observeTerminalOutput) throw new AgentMuxError('The original Terminal output owner is unavailable.', 'CONTROL_UNAVAILABLE')
          const ordered = new OrderedSessionOutputFollow(runId, cursor,
            async event => { for (let offset = 0; offset < event.dataBytes.length && !closed; offset += 128 * 1024) {
              const dataBytes = event.dataBytes.subarray(offset, offset + 128 * 1024), startByte = event.startByte + offset
              await emit({ type: 'output', data: bytes({ ...event, dataBytes, startByte, endByte: startByte + dataBytes.length }) })
            } }, event => { void emit({ type: 'end', data: { runId, ...event, reason: 'owner-ended' } }); void dispose() },
            error => { void Promise.resolve(emit({ type: 'error', error: readerError(error) })).finally(dispose).catch(() => {}) })
          const attached = await scope.client.observeTerminalOutput(target, cursor, event => {
            if (closed || input.follow !== true) return
            if (event.runId !== runId) { void emit({ type: 'error', error: { code: 'CONTROL_PROTOCOL_ERROR', message: 'Terminal reader received another Run.' } }); void dispose(); return }
            if (event.type === 'data') ordered.accept({ type: 'terminal-output', run: target.run, data: event.data, dataBytes: event.dataBytes,
              evidence: { source: 'terminal-output', observedAt: Date.now(), run: target.run, outputByteRange: { startByte: event.startByte, endByte: event.endByte } } })
            else if (event.type === 'exit') ordered.accept({ type: 'process-state', run: target.run, state: event.state.type, pid: null,
              ...(event.state.type === 'exited' ? { exitCode: event.state.code, ...(event.state.signal ? { exitSignal: event.state.signal } : {}) } : {}),
              evidence: { source: 'run-process', observedAt: event.observedAt, run: target.run } })
            else if (event.type === 'error' || event.type === 'gap') {
              void emit({ type: 'error', error: event.type === 'error' ? readerError(event.error) : {
                code: 'OUTPUT_GAP', message: 'This Terminal reader missed output. Keep its original cursor and reconnect.', details: { runId, latestOutputBytes: event.latestOutputBytes, causes: event.causes, observation: event.observation } } })
              void dispose()
            }
          })
          cleanup = () => attached.close()
          initial = parseTerminalInspection({ target, runtime: attached.runtime, run: attached.run, firstAvailableByte: attached.firstAvailableByte, gap: attached.gap }, target, input)
          start = async () => {
            await ordered.finishReplayAsync(attached.replay)
            if (!closed && (input.follow !== true || attached.run.state !== 'running')) {
              await emit({ type: 'end', data: { runId, state: attached.run.state, reason: input.follow === true ? 'owner-ended' : 'replay-complete' } })
              await dispose()
            }
          }
        }
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
      } else if (method === 'file.mutation.watch') {
        const input = parseFileMutationWatchParams(params)
        if (!this.ports.files?.watchMutations) throw new AgentMuxError('The original Host Files live observer is unavailable. Keep the original workface and requests.', 'CONTROL_UNAVAILABLE')
        const sub = await this.ports.files.watchMutations(input, event => emit({ type: 'effect', data: parseFileMutationEffect(event) }),
          error => { const terminal = emit(error ? { type: 'error', error: readerError(error) } : { type: 'end', data: {} }); void dispose(); return terminal }, controller.signal,
          { actor: caller ? { kind: 'agent', id: caller.agentSessionId } : context.principal,
            ...(caller ? { callerHostId: caller.hostId } : {}), assertCurrent: async () => { await context.assertCurrent?.(); await this.assertRuntimeFence(context) } })
        cleanup = () => sub.dispose(); initial = parseFileMutationWatchOpening(sub.initial, input); start = () => sub.start()
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
