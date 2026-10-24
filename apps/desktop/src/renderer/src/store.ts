import { restoredManualConnectionIntents, restoredManualConnectionSelections, manualConnectionScope, type ManualConnectionIntent } from "./lib/manual-connection-intent"
import { emptyApplicationAccess, restoredApplicationAccess, type ApplicationAccessContinuation } from './lib/application-member-intent'
import { restoreToolkitPresentations, updateToolkitPresentation, type ToolkitPresentations, type ToolkitPresentationPatch } from './lib/toolkit-presentation'
import { isSessionRecoveryReplyUnconfirmed } from '../../shared/session-recovery-result'
import { goalDiscussionTarget } from './lib/goal-discussion-recipient'
import { restoredGoalFiniteStartIntents, type GoalFiniteStartIntent } from './lib/goal-finite-start'
import { observeNotifications } from './lib/notification-observation'
import type { CollaborationMapTarget } from './lib/collaboration-map-navigation'
import { noteShareRange, noteShareSiblingRange } from '../../shared/note-share-range'
import { pendingNoteShares, promotedPendingNoteShares, clearPendingNoteShares, applyNoteDraftShareEcho, applyNoteDraftRestoreEcho, bindNoteDraftBlockIdentity, noteBlockFingerprint, noteNodeAtPath } from './lib/note-share-staging'
import { noteShareUndoRecoveryMessage, removedSavedNoteIncludes } from './lib/note-share-removal'
import { fileShareSourceOperation, parseFileHistoryResult, parseFileShareResult, parseFileShareUndoResult, type FileShareUndoParams, type FileShareUndoResult, type FileShareParams, type FileShareResult, type FileWriteParams } from '@agentmux/core/files'
import { retainFileDocument, hasFileDocumentConsumer, type NoteFileTarget } from './lib/file-document-consumers'
import { executorEnvironmentRevision } from '../../shared/executor-probe-context'
import { parseAgentContinuityControlInput, parseAgentContinuityControlResult, sameAgentContinuityControlInput } from '@agentmux/core/agent-session-recovery'
import { continuityControlKey, continuityControlRequests, readContinuityControlIntent, terminalContinuityControlRejection, type ContinuityControlIntents } from './lib/continuity-control-intent'
import { currentContinuitySupervision } from './lib/continuity-supervision'
import { conversationLandmarkIntentKey, type ConversationLandmarkIntents } from './lib/conversation-landmark-intent'
import { parseConversationLandmarkWrite, type ConversationLandmarkWrite } from '@agentmux/core/conversation'
import { restoredMoteBotRequests, type MoteBotRequest } from './lib/mote-bot-request'
import { botTaskSelectionKey, readBotTaskLocator, restoredBotTaskSelections, type BotTaskLocator, type BotTaskScope, type BotTaskSelections } from './lib/bot-task-selection'
import { goalRoleGuidance } from '@agentmux/core/goal-role-guidance'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { readNoteMarkdownHeader } from '@agentmux/core/note-format'
import type { NoteFileAttempt, NoteFileInput, NoteWrittenReceipt, NoteHistorySelection } from '../../shared/note-file-editing'
import { afterNoteComposition, hasNoteComposition, mergeLiveNote, setNoteComposition } from './lib/note-live-merge'
import { confirmNoteHistoryTarget, confirmDeletedNoteHistoryTarget, noteHistoryReadParams, noteResourceReadParams, type NoteHistoryRead, type NoteHistoryInspection, type NoteHistoryTarget } from './lib/note-history-target'
import { restoredConnectorRoomDrafts, restoredConnectorRoomIntents, type ConnectorRoomDraft, type ConnectorRoomIntent } from './lib/connector-room-intent'
import { restoredConnectorServiceIntents, type ConnectorServiceIntent } from './lib/connector-service-intent'
import { mailboxNotificationIntentKey, mailboxNotificationSubject, restoredMailboxNotificationIntents, type MailboxNotificationIntent, type MailboxNotificationIntents, type MailboxNotificationFeedbackBySubject, type MailboxNotificationHistoryBySubject } from './lib/mailbox-notification-intent'
import type { ConnectorServiceObservations } from './lib/connector-service-observation'
import { restoredMoteConnectionSaveIntents, type MoteConnectionSaveIntent } from './lib/mote-connection-save-intent'
import { restoredMoteChatIntents, type MoteChatIntent } from './lib/mote-chat-intent'
import { defaultNoteCanvasLayout, mergeNoteCanvasLayout, noteCanvasScopeKey, restoreNoteCanvasLayouts, type NoteCanvasLayout, type NoteCanvasScope } from './lib/note-canvas-state'
import { projectInputReceipt as retainInputReceipt } from '@agentmux/client-ui/input-receipt-projection'
import { restoredCapsuleQuestionEditors, type CapsuleQuestionEditor } from './lib/capsule-question-editors'
import { restoredQuestionReplies, type DesktopQuestionReplies, type DesktopQuestionReplyAttempt, type DesktopQuestionDrafts } from './lib/conversation-question-intent'
import { fileWorkbenchIdentity } from './lib/file-workbench-state'
import { mintObjectId } from '@agentmux/core/object-id'
import { readAgentPromptPreparationWait } from '@agentmux/core/prompt-preparation'
import { submitWithPreparationRetry, type PromptPreparationRetryProgress } from './lib/prompt-preparation-retry'
import { moteDefaultExecutor, moteDefaultConversation, recentMoteAgentsAfterVisit, restoredRecentMoteAgents, type MoteRecentAgent } from './lib/mote-quick-preferences'
import { showMoteConversation } from './lib/mote-conversation-mode'
import { goalPmoOperation, type GoalPmoIntent, type GoalPmoReceipt } from '../../shared/goal-pmo-origin'
import { executeGlobalGoalPatrol } from './lib/goal-global-patrol'
import { initializeGoalResponsibilityObservation, refreshKnownGoalResponsibilities } from './lib/goal-delegation-work'
import { goalCreationDraftKey, restoredGoalAgentCreationDrafts, restoredGoalAgentSelectionDrafts, type GoalAgentSelectionDraft, type GoalAgentCreationDraft } from './lib/goal-agent-selection'
import type { DemandContentReference } from '@agentmux/demand'
import { confirmedGoalContentReference, goalContentSource } from '../../shared/goal-content-references'
import { describeError } from '@agentmux/client-ui/error-presentation'
import { scratchTopicInvalidation } from './lib/scratch-topic-snapshots'
import type { AgentMuxPendingMessage } from '@agentmux/core/control'
import { deliveryFailure } from '@agentmux/core/delivery-attempt'
import { startDeliveryAttempt, type DeliveryAttemptSeed } from '@agentmux/client-ui/delivery-diagnostics'
import { recordMessageDeliveryFailure } from './lib/message-delivery-diagnostics'
import { recordHistory, navigateHistory, restoreComposerHistory, type HistoryState } from './lib/composer-history'
import { rendererPerformance, rendererSessionEventSource } from './lib/renderer-performance'
import { runServiceProjection } from './lib/run-service-projection'
import type { ConversationItemRef } from '@agentmux/core/conversation'
import type { ConversationRevealIntent, MailboxMessageNavigationResult } from './lib/mailbox-message-navigation'



import { readAgentPresentation, readMotePresentation, readSpatialAppearance, readSurveyPresentation } from './lib/mobile-presentation'
import { scratchTopicsForConfig } from './lib/scratch-topic-snapshots'
import { conversationReplySourceKey, type ConversationReplySource } from '@agentmux/core/prompt-reaction'

import type { AgentPromptExecution, AgentInputSubmissionReceipt, AgentPromptInputBinding } from '@agentmux/core'
import { changeNotebook, type NoteNotebookContext } from './lib/notebook-library'
import { DEFAULT_NOTEBOOK_ID } from '@agentmux/core/notebook-catalog'
import { validateProjectGroup } from './lib/cross-device-project-groups'
import type { AgentMuxProjectGroupFact, TopicCategory } from '@agentmux/core/control'
import { refreshTopicSpatial } from './lib/topic-knowledge-actions'
import { categoriesFromSpatial } from '../../shared/topic-categories'
import {DesktopSpatialPersistence,desktopSpatialGraph,desktopWorkbenchFromSpatial,desktopBindingsFromSpatial,sameSpatialValue} from './lib/desktop-spatial-state'
import { acknowledgedNameProjection, projectedNameRevision } from './lib/name-authority'
import type { AgentMuxDisplayLabel, AgentMuxNameTarget, AgentMuxDisplayLabelResult } from '@agentmux/core/spatial-graph'
import { displayLabel, nameTargetKey } from '@agentmux/core/spatial-graph'
import { createSurveyBrowser } from './lib/survey-browser-creation'
import { openSystemUrlInSurvey } from './lib/survey-system-url'
import { isToolkitRequest } from '@agentmux/core/control'
import { restoredSurveyExplorationNames } from './lib/survey-exploration-name'
import { useLauncherState } from './lib/launcher-state'
import { noteBlockSelectionKey, restoreNoteBlockSelections, type NoteBlockPresentation } from './lib/note-block-selection'
import { noteKnowledge, parseNoteFile } from './lib/note-knowledge'
import { warmLauncherId, warmTerminalForLauncher, type WarmTerminalCreation } from './lib/warm-terminal-preview'
import { NOTE_FILE_EXTENSION, newNoteDocument, readNoteDocument, serializeNoteDocument } from '../../shared/note-document'
import { noteCreationTitle, noteCreationTarget, noteCreationDisplayWorkspace, noteCreationResourceMatches, noteFilePlacement, type NoteCreationReceipt } from './lib/note-creation'
import type { NoteBlockTarget } from '../../shared/note-document'
import type { FileOpenPlacement, FileOpenResult, ConfirmedExistingFileSpace } from './lib/file-workbench-state'
import type { EditorRegionMode } from './lib/file-region-presentation'
import { effectiveFileRegionMode } from './lib/file-region-presentation'
import { prepareFileSurface } from './lib/file-surface-loading'
import { executionFocusPresentation } from './lib/focus-tab-projection'
import { workbenchProjectionMatches, sameWorkbenchProjectionSelection, type WorkbenchProjection } from './lib/workbench-projection'
import { projectWorkspaces, workspaceProjectId } from './lib/workspace-projects'
import { goalProjectContext, goalProjectContextText } from './lib/goal-project-context'
import { executeSpatialControl, spatialCatalog, createSpatialZone, zoneContext, type SpatialControlOptions } from './lib/space-agent-control'
import { executeWorkfaceAgentView } from './lib/workface-agent-view'
import { changeSurveyCollection, executeSurveyList, restoreSurveyOrganization, surveyCollectedZoneIds } from './lib/survey-list'
import { executeWorkspaceAgentOrder, restoreWorkspaceAgentOrder, workspaceAgentOrderMembers } from './lib/workspace-agent-order'
import { executeWorkfaceRegionSwap } from './lib/workface-region-swap'
import { executeWorkfaceFileOpen } from './lib/workface-file-open'
import { executeWorkfaceFileView } from './lib/workface-file-view'
import type { WorkbenchProjectionSelection } from './lib/workbench-projection'
import type { WorkbenchPresentation } from './lib/workbench-presentation'
import { mainRegionReference, desktopMainSurface, desktopSelection, desktopSpaceSelectionAfterClose, resolveDesktopSpaceSelection, resolveWorkbenchOccurrenceSelection, workbenchSelectionCatalog, projectWorkbenchSpaceSelection, workbenchObjectLayout, restoreWorkbenchSpaceSelection, DesktopFocusFailure } from './lib/desktop-focus-navigation'
import type { FocusAgentReveal, FocusAgentTarget } from './lib/focus-agent-navigation'
import { captureDesktopInput, readDesktopPresentation, readFocusAgentPresentation, awaitDesktopPresentation, desktopInputPreserved } from './lib/desktop-presentation'
import { notebookRelocations, refreshNotebookLibrary, recordNotebookChanges, restoreNotebookRecoveries, useNotebookLibrary, type NotebookRecovery } from './lib/notebook-library'
import type { AgentMuxDesktopSpaceSelection, AgentMuxDesktopFocusResult, AgentMuxSpatialSave, AgentMuxSpatialIssue } from '@agentmux/core/control'
import type { SpaceZoneBindings, SpatialRequestBinding } from '../../shared/space-addresses'
import { directoryIdentity, topicSpatialAddress } from '../../shared/space-addresses'
import type { DemandAlignmentProposal, DemandGroundingProposal } from '@agentmux/demand/goals'
import { observeAgentInputOccupation, readContinuousProgressInput } from './lib/continuous-progress-input'
import type { DesktopWorkbenchObservation } from '../../shared/client-observation'
import type { MoteContextOperations } from '../../shared/mote-context-observation'
import { observeMoteContextOperation } from './lib/mote-context-observation'
import { sessionPresentationById, agentSessionPresentationIndex } from './lib/session-presentation'
import { observeFocusHistoryIdentity } from './lib/focus-history-identity'
import { clampFocusTimelineHeight, FOCUS_TIMELINE_HEIGHT_DEFAULT } from './lib/focus-timeline-height'
import { clampFocusTimelineNameWidth, FOCUS_TIMELINE_NAME_WIDTH_DEFAULT } from './lib/focus-timeline-name-width'
import { DEFAULT_FOCUS_RULER, restoreFocusRuler, sameFocusRuler, type FocusRulerPreferences } from './lib/focus-timeline-ruler'
import { readTerminalViewObservation } from './lib/terminal-view-observation'
import type { GitDiffDescriptor, GitCommitSnapshot, GitHistoryResult, GitCommitDetailsResult } from '../../shared/git-contracts'
import { confirmedSteerDelivery, reconcileDeliveredSteers } from './lib/steer-queue-delivery'
import { browserOperatorForSession } from './lib/browser-operator-identity'
import { clampProjectRailWidth, PROJECT_RAIL_DEFAULT_WIDTH } from './lib/project-rail-width'
import { clampSurveySidebarWidth, SURVEY_SIDEBAR_DEFAULT_WIDTH } from './lib/survey-sidebar-width'
import { requireSpaceIconSelection, restoreSpaceIconOverrides, type SpaceIconChoice, type SpaceIconOverrides } from './lib/space-object-appearance'
import { create } from 'zustand'
import { createA2AMessageNotifier } from './lib/a2a-message-notifier'
import { createVisibleSessionIdsSelector } from './lib/session-visibility'

import { currentExecutorDetection, executorDetectionMatches, executorDetectionKey } from './lib/executor-detection'
export { executorDetectionKey } from './lib/executor-detection'
import { executorsForHost, hostExecutorInventoryMatches } from './lib/executors'
import { lifecycleFeedbackOwnerKey, type AgentLifecycleFailure, type AgentLifecycleFeedbackOwner } from './lib/agent-lifecycle-feedback'
import { compactNotificationIdentity, ownedNotificationIdentity, normalizeNotificationReadReceipts } from './lib/notification-read-identity'
import { notificationDeliveryNotice } from './lib/notification-delivery-notice'
import { persist } from 'zustand/middleware'
import { learningReviewKey, restoredLearningReviewDrafts, type AgentLearningReviewDraft } from './lib/agent-learning-review-draft'
import { restoredSurveyCollection, restoredSurveyZoneSelection, persistedSurveyZoneSelection, surveyCollectionAfterClose, surveySelectionAfterClose, surveySelectionAfterPromote, type SurveyZoneSelection, type PersistedSurveyZoneSelection } from './lib/survey-workface'
import { shallow } from 'zustand/shallow'
import { configValuesEqual } from '../../shared/config-edit'
import { inspectSpaceIconOverrides } from '../../shared/space-object-appearance'
import { sessionNameMetadataRecord, type SessionNameMetadata } from './lib/session-name-metadata'
import {
  AGENTMUX_CONTROL_ERROR_CODES,
  type AgentMuxArrangeMode,
  type AgentMuxControlErrorCode,
  type AgentMuxControlRequest,
  type AgentMuxControlResult,
  type AgentMuxExecutorAvailability,
  type AgentMuxSpaceAddress, type AgentMuxZoneFact, type AgentMuxSpaceBindingReport
} from '@agentmux/core/control'
import type { AgentMuxDemandDecision } from '@agentmux/core/control'
import type { AgentCapabilities, AgentCatalogEntry, AgentMuxInteractionResponse, AgentSessionHistoryDescriptor } from '@agentmux/core'
import { EMPTY_LAUNCHER_OPTIONS, updateLauncherOption, type LauncherOptionDrafts, type LauncherProviderOptions } from './lib/launcher-option-draft'
import { expandSemanticReferences } from '@agentmux/client-ui/composer-semantic-reference'
import { primaryMoteExecutorChoice } from './lib/primary-mote-executor'
import { requestPmoTeamsTopicFloatingOpen, readPmoTeamsTopicFloatingState, subscribePmoTeamsTopicFloatingState } from './lib/pmo-teams-topic-floating'
import { agentPromptExceedsBudget, MAX_AGENT_PROMPT_BYTES } from '@agentmux/core/agent-prompt-budget'
import { validateAgentPromptCondition, type AgentPromptCondition } from '@agentmux/core/prompt-condition'
import type {
  AgentLaunchResult,
  LaunchOptionSelection,
  AgentSessionControl,
  AgentSessionRecoveryCandidate,
  AgentTimelineSnapshot,
  AppConfig,
  BrowserEvent,
  CreateWorkspacePathInput,
  FileDocument,
  HostConfig,
  HostCheckResult,
  ExecutorDetection,
  ExecutorDetectionInput,
  RuntimeEvent,
  RuntimeSnapshot,
  RuntimeEndpointWarning,
  ScratchTopicSnapshot,
  SessionControl,
  SessionRecoveryResult,
  SessionSnapshot,
  TerminalLaunchInput,
  WorkspaceSelectionResult,
  RunFanOutInput,
  RunFanOutResult,
  KeepOneOfFanOutInput,
  KeepOneOfFanOutOutcome,
  RemoveWorktreeInput,
  RemoveWorktreeOutcome
} from '../../shared/contracts'
import type {
  GitFileDiff,
  CreatePullRequestResult
} from '../../shared/git-contracts'
import {
  isScratchTopicId,
  PMO_TEAMS_TOPIC_ID,
  MOTE_COORDINATION_ROLE,
  SCRATCH_WORKSPACE_ID,
  scratchTopicDirectoryName,
  scratchTopicIdentityPath,
  scratchTopicLogicalPath,
  scratchTopicIdFromWorkspacePath,
  workspaceOwnsSessionPath
} from '../../shared/scratch-topics'
import { CONNECTION_OBSERVATION_SOURCE_STEP, isScratchWorkspaceId } from '../../shared/contracts'
import { bookmarkFileNameFromTitle, bookmarkKindForPath, emitWebloc } from '../../shared/bookmark-file'
import { reconcileNotesStorageResources, reconcileNotesLauncherDrafts, reobserveNotesStorageResources } from './lib/notes-storage-reconciliation'
import type { NotesStorageSnapshot } from '@agentmux/core/notebook-store'
import { api } from './lib/api'
import { sessionLaunchFailure } from '../../shared/session-launch-result'
import { composeAgentPrompt } from '@agentmux/core/agent-outbound-message'
import type { BrowserOpinionDraft } from './lib/browser-opinion-draft'
import { frozenBrowserInput, matchesBrowserInputMessage, type BrowserCapturedInput } from './lib/browser-contextual-input'
import { errorIdentity, presentError } from '@agentmux/client-ui/error-presentation'
import type { ServiceNoticeKind } from './lib/service-window-notice'
import { steerEntryTargetsRun, steerQueueCanDrainNow } from './lib/agent-steer-queue-drain'
import { beginMoteStartupRecovery, cancelMoteSessionRecovery, deferScratchConversationRecovery, recoverMoteConversationAtStartup, recoverScratchConversationsAtStartup } from './lib/mote-session-recovery'
import { agentContinuityDetail } from './lib/continuity-presentation'
import { publishWorkbenchTabRemoved } from './lib/workbench-tab-removal'
import { reseatActiveWorkspaceId, adoptedConfig } from './lib/active-workspace-reseat'
import { gitBridge, ghBridge, type GitBridge } from './lib/git-bridge'
import type { BrowserAnnotation } from './lib/browser-annotations'
import { EMPTY_LAUNCHER_NAMES, type LauncherNameField, type LauncherNames } from './lib/launcher-name-draft'
import { resolveLauncherWorkspaceId } from './lib/launcher-workspace'
import { workbenchTabDisplayWorkspaceId } from './lib/workbench-resource-display'
import type { OpenDestination, OpenHttpLinkOrigin } from './lib/open-destination'
import { resolveSessionPlacement } from './lib/session-placement'
import { regionFocusClaimsCaret, type RegionFocusCause } from './lib/region-focus'
import { scratchTopicsForWorkspace, scratchTopicsScope, scratchTopicKind, type ScratchTopicsSnapshot } from './lib/scratch-topic-snapshots'
import { createNoteWithAvailableName } from './lib/note-names'
import { rendererResourceOwnerCounts } from './lib/resource-owner-counts'
import { terminalResourceOwnerCounts } from './lib/terminal-resource-owners'
import { retainedLaneReport, retentionReport } from './lib/worktree-removal-request'
import {
  arrangeWorkbenchControlTab,
  inspectWorkbenchControlRegion,
  inspectWorkbenchControlTab,
  planControlOpen,
  resolveWorkbenchControlRegion,
  resolveWorkbenchControlTab,
  rollbackControlOpen
} from './lib/control'
import {
  activateTab as activateLayoutTab,
  addTabOrThrow,
  addTabPlacement,
  createWorkspaceLayout,
  groupIds,
  findGroup,
  findGroupForTab,
  focusGroup,
  removeTab as removeLayoutTab,
  moveTab as moveLayoutTab,
  regionIds,
  setSplitRatio,
  moveTabToNewGroup as moveLayoutTabToNewGroup,
  setWorkbenchRegionSplitRatio,
  workbenchRegionBounds,
  type SplitDirection,
  type WorkspaceLayout,
  type WorkbenchRegionLayoutPreset
} from '@agentmux/layout'
import {
  describePersistedTabRepairs,
  hydratePersistedTab,
  projectPersistedWorkbench,
  persistedSessionSurfaceIds,
  restorePersistedWorkbench,
  type PersistedWorkbench
} from './lib/workbench-persistence'
import { createBrowserProjectionEventQueue, reduceBrowserEvent } from './lib/browser-state'
import { projectNativeBrowserOpening } from './lib/browser-child-projection'
import {
  bumpWorkspaceFileRevision,
  reduceDocumentAttached,
  reduceDocumentContent,
  reduceFileDocumentContent,
  reduceDocumentLoadFailed,
  reduceDocumentRead,
  reduceDocumentReloaded,
  reduceDocumentSaving,
  reduceDocumentWriteError,
  preserveNoteInputConflict,
  reduceDocumentWritten,
  reduceFileDelete,
  reduceFileOpened,
  reduceFileSurfaceOpened,
  fileOpenReferenceMatches,
  fileOpenSplitMatches,
  fileOpenLauncherMatches,
  reduceFileRename,
  findFileRenameProjectionCollision,
  findFileWorkbenchSurface,
  reconcileWorkbenchFileProjection,
  type FileDocumentIssue
} from './lib/file-workbench-state'
import { workspaceFilePreviewFormat } from '../../shared/workspace-file-preview'
import { noteDirectorySourceKey, type NoteDirectoryRead } from './lib/note-directory-sources'
import {
  advanceDocumentLifetime,
  disposeClosedFileOwners,
  disposeObserversForRemovedWorkspaces,
  documentLifetime,
  fileInvalidationSequences,
  fileOpenRequests,
  fileReadInFlightCounts,
  fileReadRequestIds,
  fileSaveTails,
  fileSurface,
  isScratchTopicDocument,
  regionDiffRequestIds,
  transferFileSaveTail,
  withWorkspaceFileMutation,
  workspaceFileMutationTails
} from './lib/file-document-bookkeeping'
import {
  ownsSessionLaunch,
  pendingAgentLaunchEventId,
  bufferPendingAgentEvent,
  discardPendingAgentLaunch,
  projectRuntimeEvent,
  runtimeDiagnosticNotice,
  runtimeEventSession,
  removeSessionProjection,
  reduceAgentMembershipSnapshot,
  runtimeSnapshotHostUnavailable,
  projectRuntimeEndpointSessions,
  reduceTerminalMembershipSnapshot,
  reduceAgentSessionLaunchAttached,
  reduceDetachedAgentLaunch,
  reduceSessionLaunchAttached,
  reduceSessionLaunchFailed,
  reduceTimelineSnapshot,
  type PendingAgentLaunch,
  type SessionViewMode
} from './lib/session-state'
import {
  TOOL_DOCK_DEFAULT_WIDTH,
  WORKSPACE_TOOL_IDS,
  clampToolDockWidth,
  type WorkspaceTool
} from './lib/surface-tool-dock'
import { restoreGitCommitDrafts, restoreWorkspaceGitView, type WorkspaceGitView } from './lib/workspace-git-view'
import { projectDemands, type DemandArrangement, type DemandPriority, type DemandRecord, type DemandStatus } from './lib/global-demand-board'
import type { Demand as FilesystemDemand } from '@agentmux/demand'
import { demandWriteDecision } from './lib/demand-write-policy'
import {
  activeWorkbenchSurface,
  addWorkbenchRegion,
  createWorkbenchTab,
  documentKey,
  gitDiffIdentity,
  findWorkbenchRegion,
  focusWorkbenchTabRegion,
  inheritedTopicIdForNewTab,
  initialWorkbenchRegionId,
  availableWorkbenchTabIdentity,
  tabGroupForTab,
  removeWorkbenchRegion,
  renameWorkbenchTab,
  replaceWorkbenchRegion,
  sessionTabId,
  swapWorkbenchTabRegions,
  tabStillOpen,
  titleWorkbenchSurface,
  topicIdForSession,
  updateWorkbenchRegion,
  workbenchSurfaces,
  workspaceForSession,
  type AgentWorkbenchSurface,
  type BrowserWorkbenchSurface,
  type LauncherWorkbenchSurface,
  type TerminalWorkbenchSurface,
  type WorkbenchSurface,
  type WorkbenchTab
} from './lib/workbench-tabs'
import { assertUnreachableSurface, isAgentOrLauncherSurface, isSessionSurface, surfaceCloseObligations } from './lib/workbench-surface-kinds'
import { resolveSpatialCommit } from './lib/control-spatial-commit'
import {
  applyWorkbenchViewCloseTopology,
  hasAttachedSessionOutsideClosingViews,
  planWorkbenchViewClose,
  reconcileWorkbenchViewClose,
  sameWorkbenchSurfaceOwner,
  workbenchViewCloseAllowsSession,
  workbenchViewCloseAllowsView,
  type WorkbenchViewClosePlan,
  type WorkbenchViewCloseReceipt,
  type WorkbenchViewCloseResource
} from './lib/workbench-view-close'
import { isPathWithinSubtree, remapPathWithinSubtree } from './lib/workspace-paths'
import {
  createEmptyFileExplorerViewState,
  revealFileExplorerPath,
  type FileExplorerViewState
} from './lib/file-explorer-selection'
import { moveSessionViewToWorkspace as reduceMoveSessionView } from './lib/move-session-view'
import { rehomeClosedWorkspaces } from './lib/worktree-closeout-state'
import { promoteRegionToTab as reducePromoteRegionToTab } from './lib/promote-region-to-tab'
import {
  evaluateCreatePrIntent,
  type CreatePrToken,
  type CreatePrIntentState
} from './lib/create-pr-intent'
import {
  evaluatePrEligibility,
  PR_BLOCKER_MESSAGES,
  type PrEligibilityInput
} from './lib/pr-eligibility'
import { decayStaleAgentStatuses as computeDecayedAgentStatuses } from './lib/agent-status-decay'
import {
  EMPTY_AGENT_FOCUS,
  executionFocusContextText,
  executionFocusSessionId,
  focusExecution,
  focusLaneForSession,
  focusPmo,
  restoreAgentFocus,
  sanitizeAgentFocus,
  type AgentFocusContext
} from './lib/agent-focus'
import {
  createDebouncedPersistentStorage,
  createWriteFencedStorage,
  registerUnloadFlush
} from './lib/persisted-ui-writer'
import type { StartupAgentAvailability, StartupProgress } from './lib/startup-progress'

type ViewMode = SessionViewMode

/**
 * A file Region's diff payload, as loaded from the existing `git.diff` bridge. `loading` gates the
 * spinner; `diff` is the structured single-file diff (HEAD vs worktree) once it lands; `error` is
 * git's own message when the load failed (not a git repo, path escaped the worktree, etc.). The
 * three are not mutually exclusive on purpose: a reload keeps the previous `diff` visible while
 * `loading` is true, and a failed reload keeps the last good `diff` beside the `error`.
 */
export type EditorRegionDiffState = {
  loading: boolean
  diff: GitFileDiff | null
  error: string | null
}
export type MainSurface = 'recall' | 'survey' | 'agents' | 'workbench' | 'board'
type OpenScratchTopicOptions = {
  /** A caller with its own persistent failure surface reports the same rejection there. */
  reportFailure?: boolean
  /** An explicit new discussion keeps the Mote identity and owns its first draft before preparation. */
  newTab?: boolean
  initialRequest?: { prompt: string; agentMuxNote?: string; executorId?: string }
  /** User navigation reveals the Topic workbench; background preparation must leave focus alone. */
  reveal?: boolean
  /** Present an existing object's accepted selection without waiting for its metadata refresh. */
  onRevealed?: () => void
  /** Cancels this caller's late navigation, without cancelling metadata or a Session. */
  signal?: AbortSignal
  /** When supplied, focus this exact bound Tab instead of selecting the first Tab for the Topic. */
  tabId?: string
  /** An exact original display occurrence, required when this Tab has several positions. */
  groupId?: string
}
export type AsyncCheckState = 'idle' | 'checking' | 'ready' | 'missing' | 'error'
export type ExecutorDetectionState = {
  state: AsyncCheckState
  input?: ExecutorDetectionInput
  result?: ExecutorDetection
  detail?: string
  observedAt?: number
}
export type HostCheckState = {
  state: Exclude<AsyncCheckState, 'missing'>
  input?: HostConfig
  result?: HostCheckResult
  detail?: string
  observedAt?: number
}
export type HostExecutorInventoryState = {
  state: Exclude<AsyncCheckState, 'missing'>
  input: HostConfig
  result?: import('../../shared/contracts').HostExecutorInventory
  detail?: string
  observedAt?: number
}

/** Original client object identity; labels and current focus never identify an event's target. */
export type NotificationEventObject = {
  kind: 'application' | 'host' | 'workspace' | 'document' | 'browser' | 'tab-group' | 'tab' | 'region' | 'zone'
  id: string
  hostId?: string
  workspaceId?: string
}

/** Attributes supplied by the original error producer, never a second Agent status record. */
export type ErrorNoticeContext = {
  kind: ServiceNoticeKind
  /** Explicit presentation from the diagnostic producer; the complete error remains authoritative. */
  summary?: string
  subject?: SessionControl
  /** Same key means the same original occurrence. New operations/recurrences supply a new key. */
  event?: { source: string; key: string; object?: NotificationEventObject }
  /** An exact absent-main diagnostic may settle from this Session's later confirmed binding. */
  cause?: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED'
  lifecycle?: AgentLifecycleFailure
  /** Only this producer may settle its original missing-facts notice, never a later error. */
  startupSessionSnapshot?: {
    sessionIds: readonly string[]
    remainingMessage: string | null
    failureMessage?: string
  }
  /** The original Provider read owns its retry and may settle only this warning. */
  startupProviderCatalog?: { warningMessage: string }
}

/** Window-local notifications: source-owned current failures and ordinary event history. */
export type NotificationEvent = {
  id: string
  message: string
  context: ErrorNoticeContext | null
  /** Client receipt times, not the underlying failure's occurrence time. */
  firstObservedAt?: number
  lastObservedAt?: number
  occurrences?: number
}

export function notificationSourceOwner(context: ErrorNoticeContext | null | undefined): string | undefined {
  const failure = context?.lifecycle
  if (failure) return lifecycleFeedbackOwnerKey(failure.step === 'launch' ? { regionId: failure.regionId } : { subject: failure.subject })
  const subject = context?.subject
  if (context?.cause) return JSON.stringify([context.cause, subject?.hostId,
    subject?.kind === 'agent' ? subject.agentSessionId : undefined, subject?.run.runId])
}

export function notificationEventIdentity(message: string, context: ErrorNoticeContext | null | undefined): string {
  const owner = notificationSourceOwner(context)
  if (owner) return ownedNotificationIdentity(owner, context?.kind ?? 'indeterminate', errorIdentity(message))
  const subject = context?.subject
  const event = context?.event
  if (event) return compactNotificationIdentity(JSON.stringify(['event', event.source, event.key,
    event.object?.kind, event.object?.id, event.object?.hostId, event.object?.workspaceId,
    subject?.hostId, subject?.kind, subject?.kind === 'agent' ? subject.agentSessionId : undefined,
    subject?.run.runId, context.kind]))
  return compactNotificationIdentity(JSON.stringify([context?.kind ?? 'indeterminate', context?.cause,
    subject?.hostId, subject?.kind, subject?.kind === 'agent' ? subject.agentSessionId : undefined,
    subject?.run.runId, context?.lifecycle, context?.startupSessionSnapshot?.sessionIds,
    context?.startupProviderCatalog ? 'provider-catalog' : undefined, errorIdentity(message)]))
}

type NotificationProjection = { current: NotificationEvent[]; history: NotificationEvent[]; owners: Map<string, NotificationEvent> }
const notificationProjections = new WeakMap<readonly NotificationEvent[], NotificationProjection>()
/** One derived index per immutable record collection; it owns no Runtime or recovery facts. */
export function projectNotifications(records: readonly NotificationEvent[]): NotificationProjection {
  let projection = notificationProjections.get(records)
  if (!projection) {
    projection = { current: [], history: [], owners: new Map() }
    for (const record of records) {
      const owner = notificationSourceOwner(record.context)
      if (owner) { projection.current.push(record); projection.owners.set(owner, record) }
      else projection.history.push(record)
    }
    notificationProjections.set(records, projection)
  }
  return projection
}

export function lifecycleNotification(records: readonly NotificationEvent[], owner: AgentLifecycleFeedbackOwner): NotificationEvent | undefined {
  return projectNotifications(records).owners.get(lifecycleFeedbackOwnerKey(owner))
}

/** An exact owner settlement releases only the reading facts for the same current record. */
function settleNotificationRecords(state: Pick<AppState, 'notificationEvents' | 'noticeReadReceipts'>,
  records: readonly NotificationEvent[]): Partial<Pick<AppState, 'notificationEvents' | 'noticeReadReceipts'>> {
  if (!records.length) return {}
  const requested = new Set(records), settled = new Set<NotificationEvent>(), retained: NotificationEvent[] = []
  for (const record of state.notificationEvents) {
    if (requested.has(record)) settled.add(record)
    else retained.push(record)
  }
  if (!settled.size) return {}
  const receipts = { ...state.noticeReadReceipts }
  function release(scope: string, id: string, fingerprint: string) {
    if (receipts[scope]?.[id] !== fingerprint) return
    const retained = { ...receipts[scope] }
    delete retained[id]
    if (Object.keys(retained).length) receipts[scope] = retained
    else delete receipts[scope]
  }
  for (const record of settled) {
    release('global:events', record.id, 'read')
    if (record.context?.lifecycle) release(`local:lifecycle:${notificationSourceOwner(record.context)}`, 'lifecycle',
      JSON.stringify([null, 'indeterminate', record.id]))
  }
  return { notificationEvents: retained, noticeReadReceipts: receipts }
}

function nativeIdentityNoticeResolved(sessions: readonly SessionSnapshot[], notice: ErrorNoticeContext | null | undefined): boolean {
  const subject = notice?.subject
  if (notice?.cause !== 'AGENT_NATIVE_IDENTITY_UNCONFIRMED' || subject?.kind !== 'agent') return false
  const matches = sessions.filter(session => session.kind === 'agent' &&
    session.hostId === subject.hostId && session.id === subject.agentSessionId &&
    session.control.run.runId === subject.run.runId)
  const current = matches.length === 1 ? matches[0] : undefined
  if (current?.kind !== 'agent' || current.nativeHandle?.kind !== 'provider' ||
    current.nativeHandle.providerId !== current.providerId || current.nativeHandlePersistence !== 'confirmed' ||
    current.nativeSourceObservation || current.observedNativeHandle) return false
  return true
}

function resolvedNativeIdentityNotices(state: Pick<AppState, 'sessions' | 'notificationEvents' | 'noticeReadReceipts'>, observed?: SessionControl):
  Partial<Pick<AppState, 'notificationEvents' | 'noticeReadReceipts'>> {
  const projection = projectNotifications(state.notificationEvents)
  const owner = observed?.kind === 'agent' ? notificationSourceOwner({ kind: 'indeterminate',
    cause: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', subject: observed }) : undefined
  const record = owner ? projection.owners.get(owner) : undefined
  const candidates = observed ? (record ? [record] : [])
    : projection.current.filter(item => item.context?.cause === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')
  return settleNotificationRecords(state, candidates.filter(item => nativeIdentityNoticeResolved(state.sessions, item.context)))
}

// Persistent user intent uses one operation ID across retries and restarts. Run binding prevents
// a semantic resume from silently consuming messages addressed to its predecessor.
export const MAX_AGENT_STEER_QUEUE_ENTRIES = 100
// Only asynchronous control lives here; queue contents and delivery reasons stay in Store.
const agentSteerDrains = new Map<string, { promise: Promise<void>; wake: boolean; explicitSteers: Set<string>; submitted: Set<string>; failures: Map<string, unknown>; waitingForInteraction: Set<string> }>()
type SteerDeliveryAttempt = { seed: DeliveryAttemptSeed; stage: string; diagnostic?: { logId: string; notice: string } }
// A click's diagnostic follows its one ordered consumer; it never grants input.
const preparationRetryCalls = new Map<string, AbortController>()
const manualSteerAttempts = new Map<string, SteerDeliveryAttempt>()


export type AgentSteerReaction = { code: string; replySource: ConversationReplySource }
export type AgentSteerOptions = {
  /** Admit to the existing queue without letting background drains dispatch before the explicit Send. */
  awaitingExplicitSend?: true
  browserRecipient?: AgentSessionControl
  browserInput?: BrowserCapturedInput
  goalDispatch?: import('../../shared/goal-dispatch').GoalDispatchReference
  goalPmo?: GoalPmoIntent
  execution?: AgentPromptExecution
  reaction?: AgentSteerReaction
  sourceChannel?: import('@agentmux/core').AgentMessageChannel
  goalContinuation?: { goalId: string; loopId: string; condition: AgentPromptCondition }
}

export type AgentSteerQueueEntry = {
  operationId: string
  /** The first accepted local intent time; absent means it was never recorded. */
  enqueuedAt?: number
  runId?: string
  /** null is a new, never-dispatched intent; absence is an unknown historical intent. */
  promptCondition?: AgentPromptCondition | null
  text: string
  /** Original Main receipt; display cannot certify Core provenance or rebind this intent. */
  browserInput?: BrowserCapturedInput
  browserRecipient?: AgentSessionControl
  /** Explicit producer context, frozen with the original user body. */
  agentMuxNote?: string
  /** Original reply reference, frozen in the existing durable intent, never inferred from text. */
  reaction?: AgentSteerReaction
  sourceChannel?: import('@agentmux/core').AgentMessageChannel
  goalContinuation?: { goalId: string; loopId: string; condition: AgentPromptCondition }
  goalPmo?: GoalPmoIntent
  goalDispatch?: import('../../shared/goal-dispatch').GoalDispatchReference
  status: 'queued' | 'restoring' | 'deferred' | 'failed'
  error?: string
  errorCode?: string
  logId?: string
  preparationWait?: PromptPreparationRetryProgress
  preparationInputNotApplied?: true
  /** Restart pauses execution authority independently of the original delivery failure. */
  awaitingExplicitSend?: true
  /** Retain this exact intent and its delivery facts outside active queue consumption. */
  archived?: true
  /** This original body was explicitly appended to its existing draft; only save may be retried. */
  movedToDraft?: true
  origin?: 'manual'
  /** Frozen when explicitly selected, before awaits. Queue-only default leaves it absent;
   * known-null retains that original selection across recovery/wait, but boot pauses it. */
  execution?: AgentPromptExecution
  /** Frozen only by a new direct composer producer, before its first Core intake. */
  directInputBinding?: Extract<AgentPromptInputBinding, { admissionIntent: unknown }>
  directInputControl?: Extract<SessionSnapshot, { kind: 'agent' }>['control']
  /** Core's original receipt is a projection; the client never dispatches accepted waiting. */
  inputReceipt?: AgentInputSubmissionReceipt
  inputStopReceipt?: import('@agentmux/core').AgentInputWaitStopReceipt
  inputStopIntent?: { ref: import('@agentmux/core').AgentInputWaitRef; cancelOperationId: string }
  /** First intake may already be durable even if the IPC response was lost. */
  inputIntakeStarted?: true
  /** New local composer draft only; this marker never authorizes Native input. */
  freshComposerIntent?: true
  /** Original recovery+input request, frozen before the first RPC; unknown replies never become PTY permission. */
  resumeInputIntent?: {
    control: Extract<SessionSnapshot, { kind: 'agent' }>['control']
    input: NonNullable<import('@agentmux/core/agent-session-recovery').AgentMuxAgentContinuityInput['input']>
  }
  /** Actual Core carrier receipt; launch carriage is separate from Native consumption or terminal ACK. */
  resumeInputReceipt?: NonNullable<NonNullable<import('@agentmux/core').AgentMuxAgentSession['continuity']>['launchInput']>
}

/** A missing or frozen condition is not evidence that this message was never submitted. */
export function agentSteerCanEdit(entry: AgentSteerQueueEntry, inFlightId?: string): boolean {
  return !entry.browserInput && !entry.archived && !entry.inputIntakeStarted && !entry.inputReceipt && entry.promptCondition === null && entry.operationId !== inFlightId
}

function manualComposerBinding(sessionId: string, origin?: 'manual', options?: AgentSteerOptions): AgentSteerQueueEntry['directInputBinding'] {
  const session = useAppStore.getState().sessions.find(item => item.id === sessionId)
  // This is the direct user's new producer contract, not a recovered queue tag
  // or an inference from authorHuman, current predecessor or the message body.
  const recipient = options?.browserRecipient ?? options?.browserInput?.control
  return origin === 'manual' && session?.kind === 'agent' && session.processState === 'running' &&
    (!recipient || recipient.hostId === session.control.hostId &&
      recipient.agentSessionId === session.control.agentSessionId && recipient.run.runId === session.control.run.runId) &&
    !options?.goalContinuation && !options?.goalPmo && !options?.goalDispatch &&
    (options?.execution === undefined || options.execution === 'immediate')
    ? { expectedRun: { ...(recipient ?? session.control).run }, admissionIntent: { kind: 'manual-actor' } } : undefined
}

/** Associate a Core receipt with its original client intent; never infer carriage from a current Run. */
function originalResumeInputReceipt(session: SessionSnapshot, entry: AgentSteerQueueEntry): AgentSteerQueueEntry['resumeInputReceipt'] {
  const original = entry.resumeInputIntent
  if (!original || session.kind !== 'agent' || session.hostId !== original.control.hostId ||
      session.control.agentSessionId !== original.control.agentSessionId) return
  const operation = session.continuityOperations?.[entry.operationId], receipt = operation?.launchInput
  if (!receipt || operation?.agentSessionId !== original.control.agentSessionId || operation.operationId !== entry.operationId ||
      receipt.input.inputContextCapture?.hostId !== original.input.inputContextCapture?.hostId ||
      receipt.input.inputContextCapture?.operationId !== original.input.inputContextCapture?.operationId ||
      !matchesBrowserInputMessage(entry.browserInput, receipt.message) || receipt.message.userContent !== (entry.text.trim() ? entry.text : undefined) ||
      receipt.input.submissionId !== entry.operationId || receipt.input.prompt !== entry.text ||
      receipt.input.agentMuxNote !== entry.agentMuxNote || receipt.input.authorHuman !== original.input.authorHuman ||
      receipt.input.sourceChannel !== original.input.sourceChannel || operation?.previousRun.runId !== original.control.run.runId) return
  if (receipt.state === 'not-applied') return receipt
  if (operation.newRun?.runId !== session.control.run.runId ||
      receipt.key?.kind !== 'prompt' || receipt.key.agentSessionId !== session.id || receipt.key.submissionId !== entry.operationId ||
      receipt.key.expectedRun.runId !== session.control.run.runId || !['launch-carried', 'terminal-confirmed'].includes(receipt.state) ||
      receipt.state === 'launch-carried' && (receipt.delivery !== 'launch' || receipt.receipt?.kind !== 'runtime-launch' ||
        receipt.receipt.operationId !== receipt.lifecycleOperationId || receipt.receipt.run.runId !== session.control.run.runId)) return
  return receipt
}

function projectResumeInputReceipts(state: AppState, sessionId: string): Partial<AppState> {
  const queue = state.agentSteerQueues[sessionId]
  if (!queue?.some(entry => entry.resumeInputIntent && !entry.resumeInputReceipt)) return {}
  const session = state.sessions.find(session => session.id === sessionId)
  if (!session) return {}
  let changed = false
  const projected = queue.map(entry => {
    if (entry.resumeInputReceipt) return entry
    const receipt = originalResumeInputReceipt(session, entry)
    if (!receipt) return entry
    changed = true
    if (receipt.state === 'not-applied' && session.kind === 'agent') return { ...entry,
      runId: session.control.run.runId, resumeInputReceipt: structuredClone(receipt), status: 'deferred' as const,
      promptCondition: { expectedRun: { ...session.control.run }, afterSubmissionId: session.promptSubmissionPredecessor ?? null },
      awaitingExplicitSend: true as const, errorCode: 'AGENT_PROMPT_CONDITION_CHANGED',
      error: 'Core confirmed this recovery input was not applied. The original message is kept. Move it to the draft before explicitly sending a new message.' }
    const { error: _error, errorCode: _code, awaitingExplicitSend: _paused, ...original } = entry
    return { ...original, runId: session.control.run.runId, resumeInputReceipt: structuredClone(receipt),
      inputIntakeStarted: true as const, archived: true as const, status: 'deferred' as const }
  })
  return changed ? { agentSteerQueues: { ...state.agentSteerQueues, [sessionId]: projected } } : {}
}

function projectInputReceipt(state: AppState, sessionId: string, receipt: AgentInputSubmissionReceipt): Partial<AppState> {
  const queue = state.agentSteerQueues[sessionId]
  if (!queue || receipt.key.kind !== 'prompt' || receipt.key.agentSessionId !== sessionId) return {}
  const key = receipt.key
  return { agentSteerQueues: { ...state.agentSteerQueues, [sessionId]: queue.map(entry => {
    if (entry.operationId !== key.submissionId || entry.directInputBinding?.expectedRun.runId !== key.expectedRun.runId ||
        entry.inputReceipt && entry.inputReceipt.ref.waitGeneration > receipt.ref.waitGeneration) return entry
    const projected = retainInputReceipt(entry.inputReceipt, receipt)
    if (projected === entry.inputReceipt) return entry
    const { preparationWait: _wait, awaitingExplicitSend: _paused, error: _error, errorCode: _code, ...original } = entry
    return { ...original, inputReceipt: receipt, status: 'deferred' as const,
      ...((receipt.status === 'admitted' || receipt.status === 'terminal-confirmed') ? { archived: true as const } : {}) }
  }) } }
}

/** Projection conflicts are observations, never a new writer or a replacement receipt. */
function consumeInputReceipt(sessionId: string, receipt: AgentInputSubmissionReceipt): void {
  let failure: unknown
  useAppStore.setState(state => {
    try { return projectInputReceipt(state, sessionId, receipt) }
    catch (error) { failure = error; return state }
  })
  if (failure) {
    const subject = useAppStore.getState().agentSteerQueues[sessionId]?.find(entry => entry.operationId ===
      (receipt.key.kind === 'prompt' ? receipt.key.submissionId : receipt.key.messageId))?.directInputControl
    useAppStore.getState().reportError(failure, { kind: 'indeterminate', ...(subject ? { subject } : {}) })
  }
}

function pendingSteerRecord(entry: AgentSteerQueueEntry, inFlightId?: string, phase?: 'preparing' | 'submitting', confirmed = false): AgentMuxPendingMessage {
  return { pendingId: entry.operationId, text: entry.text, runId: entry.runId ?? null,
    enqueuedAt: entry.enqueuedAt ?? null, status: entry.status,
    // A known admission may arrive before its observer IPC reply. Archiving
    // its confirmed input is not an in-flight Pending dispatch.
    phase: !entry.archived && entry.operationId === inFlightId ? phase ?? 'preparing' : null,
    editable: !confirmed && agentSteerCanEdit(entry, inFlightId),
    delivery: entry.resumeInputReceipt?.state === 'not-applied' ? 'not-submitted' : entry.resumeInputReceipt && ['launch-carried', 'terminal-confirmed'].includes(entry.resumeInputReceipt.state) ? 'confirmed' : entry.inputReceipt ? (entry.inputReceipt.status === 'admitted' || entry.inputReceipt.status === 'terminal-confirmed') ? 'confirmed' : entry.inputReceipt.status === 'waiting' || entry.inputReceipt.status === 'stopped' ? 'not-submitted' : 'unconfirmed'
      : entry.inputIntakeStarted ? 'unconfirmed' : confirmed ? 'confirmed' : entry.promptCondition === null || entry.preparationInputNotApplied ? 'not-submitted' : 'unconfirmed',
    ...(entry.inputReceipt ? { inputWait: { ref: entry.inputReceipt.ref, status: entry.inputReceipt.status, observation: entry.inputReceipt.observation,
      controlState: entry.inputReceipt.control.state, ...(entry.inputStopReceipt ? { stop: entry.inputStopReceipt } : {}) } } : {}),
    errorCode: entry.errorCode ?? null, error: entry.error ?? null, ...(entry.logId ? { logId: entry.logId } : {}), ...(entry.preparationWait ? { preparationWait: entry.preparationWait } : {}), archived: entry.archived === true }
}

/** One admission and its labels share the original execution choice, including unknown old input. */
export function agentSteerExecution(entry: AgentSteerQueueEntry,
  capabilities: Extract<SessionSnapshot, { kind: 'agent' }>['capabilities']): AgentPromptExecution {
  return entry.execution ?? (entry.promptCondition === null &&
    (capabilities.promptExecution?.immediate === 'terminal-submit' || capabilities.promptExecution?.immediate === 'interrupt-before-input') ? 'immediate' : 'default')
}






function reactionIntentKey(reaction?: AgentSteerReaction): string | undefined {
  return reaction ? JSON.stringify([reaction.code, conversationReplySourceKey(reaction.replySource)]) : undefined
}
export type AppState = {
  runtimeOwnershipWarnings: string[] | undefined
  runtimeEndpointWarnings: RuntimeEndpointWarning[] | undefined
  // undefined: snapshot unavailable; null: snapshot confirms no environment warning.
  environmentWarning: string | null | undefined
  /**
   * Absolute path of the local machine's home directory, learned from the `sessions:snapshot` payload
   * (the renderer has no `process`/`os`). Empty string means "not known yet" — copy-path abbreviation
   * (`~`) does not fire until it is set, rather than guessing a boundary. Ephemeral (never persisted):
   * it is re-supplied by the snapshot on every launch, so it must not live in `partialize`.
   */
  localHome: string
  /** Durable placement intent for healthy Agents whose requested Region vanished mid-launch.
   * Current notices derive from Session/layout facts; successful placement clears the marker.
   */
  displacedAgentSessionIds: string[]
  restoredWorkbench: PersistedWorkbench | null
  projectGroups: AgentMuxProjectGroupFact[]
  saveProjectGroup(group: AgentMuxProjectGroupFact): Promise<AgentMuxSpatialSave>
  dissolveProjectGroup(groupId: string): Promise<AgentMuxSpatialSave>
  spaceZoneBindings: SpaceZoneBindings
  spatialRequests: Record<string, SpatialRequestBinding>
  /** UI intent only; original Core/spatial creation still owns the reserved Session. */
  goalAgentSelectionDrafts: Record<string, GoalAgentSelectionDraft>
  goalFiniteStartIntents: Record<string, GoalFiniteStartIntent>
  goalAgentCreationDrafts: Record<string, GoalAgentCreationDraft>
  /** Exact logical focus retained when a background move removes the active leaf. */
  retainedSpatialFocus: (AgentMuxSpaceAddress & { topicId?: string }) | null
  workbenchSpaceSelection: AgentMuxDesktopSpaceSelection | null
  /** Default CLI navigation suppresses automatic caret until explicit human/keyboard navigation. */
  workbenchNavigationInputPolicy: 'preserve' | 'target' | null
  desktopNavigationNotice: AgentMuxSpatialIssue | null
  config: AppConfig | null
  providerCatalog: AgentCatalogEntry[]
  sessions: SessionSnapshot[]
  sessionNameMetadata: SessionNameMetadata
  sessionNameMetadataWarning: RuntimeSnapshot['sessionNameMetadataWarning'] | null
  /** Recovery candidates surfaced by Runtime reconciliation for launcher Resume. */
  recoveryCandidates: AgentSessionRecoveryCandidate[]
  // The create page can render this shell directly, but it stays outside the ordinary
  // Session projection until the user claims it.
  warmTerminals: Record<string, WarmTerminal[]>
  unclaimedTerminalSessionIds: string[]
  timelines: Record<string, import('./lib/session-state').RendererAgentTimelineSnapshot>
  pendingAgentLaunches: Record<string, PendingAgentLaunch>
  activeWorkspaceId: string | null
  /** 用户拖出来的 Topic 顺序。是一份偏好，不是真相来源——磁盘上没有的不会因它出现。 */
  scratchTopicOrder: string[]
  workspaceAgentOrder: Record<string, string[]>
  setWorkspaceAgentOrder(workspaceId: string, order: readonly string[]): Promise<import('@agentmux/core/control').AgentMuxWorkspaceAgentOrderReport>
  recentMoteAgents: Record<string, MoteRecentAgent>
  rememberMoteAgent(reference: WorkbenchProjectionSelection): void
  setScratchTopicOrder(order: readonly string[]): void
  documents: Record<string, FileDocument>
  retainedDocumentDrafts: Record<string, FileDocument[]>
  dirtyDocuments: Record<string, boolean>
  documentGenerations: Record<string, number>
  documentObservationGenerations: Record<string, number>
  documentIssues: Record<string, FileDocumentIssue | undefined>
  savingDocuments: Record<string, boolean>
  // One-shot reveal targets keyed by documentKey. Set when a file is opened with a :line location
  // (e.g. a terminal path link), consumed once by EditorPane on Monaco mount, then cleared. Never
  // persisted — a reveal is a navigation, not document state.
  documentRevealTargets: Record<string, { line: number; column?: number; noteBlock?: NoteBlockTarget } | undefined>
  noteBlockSelections: Record<string, NoteBlockTarget>
  noteCanvasLayouts: Record<string, NoteCanvasLayout>
  noteCanvasSaveIssues: Record<string, string>
  setNoteBlockSelection(presentation: NoteBlockPresentation, target: NoteBlockTarget): void
  lastActiveFileByWorkspace: Record<string, string | undefined>
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
  closingWorkbenchViews: Record<string, WorkbenchViewClosePlan>
  // 键盘请求关整张 Tab 的「意图」——键盘层够不着组件里的确认流（未保存/在跑 Agent 的对话框只活在
  // WorkspaceWorkbench），所以窗口监听只投一个意图，活动 Tab 组件读到它就跑自己既有的 requestTabsClose
  // （与鼠标点 X 同一条路），跑完清掉。同 documentRevealTargets 的 consume-and-clear 套路。
  closeTabRequest: { workspaceId: string; tabGroupId: string; tabId: string; nonce: number } | null
  // 键盘请求关某一格 Region 的「意图」——理由同 closeTabRequest：那格的未保存确认（dirty→确认对话框）
  // 只活在承载它的 WorkbenchRegionNode 里，与鼠标点这一格的 X 是同一个决定出口。键盘层够不着那份状态，
  // 于是窗口监听只投意图，命中的那一格读到就跑自己既有的确认流，跑完清掉。裸调 closeRegion 会静默弃掉
  // 未存改动——鼠标点 X 不会那样。
  closeRegionRequest: { workspaceId: string; tabId: string; regionId: string; nonce: number } | null
  // 「把打字光标（DOM caret）搬进这一格」的一次性意图，按 regionId 定位——同 closeRegionRequest 的
  // consume-and-clear 套路。存在的理由：键盘方向导航搬焦点时只改 activeRegionId（绿环），而看不见的
  // DOM 焦点仍停在上一格的 xterm/Monaco 上，敲的字全进了上一格。承载被点名那格的表面（TerminalView /
  // EditorPane）读到就把 .focus() 搬过来、再清掉。只在键盘那一路投递（见 regionFocusClaimsCaret）：
  // 指针点击那一路原生 mousedown 已经把焦点放对了，再夺一次会打断原生行为。不持久化（是一次导航，
  // 不是布局事实）。browser 那格没有消费者——原生 WebContentsView 的聚焦是另一条路；一条无人认领的
  // 意图停在这里是惰性的（下一次投递会覆盖它）。
  regionCaretFocus: { regionId: string; nonce: number; target?: 'terminal' } | null
  workspaceFileRevisions: Record<string, number>
  noteDirectorySources: Record<string, NoteDirectoryRead | undefined>
  refreshNoteDirectorySources(tabId: string, regionId: string): Promise<NoteDirectoryRead | undefined>
  scratchTopicSnapshots: Record<string, ScratchTopicsSnapshot>
  topicCategories: TopicCategory[]
  fileExplorerStates: Record<string, FileExplorerViewState | undefined>
  viewModes: Record<string, ViewMode>
  executorDetections: Record<string, ExecutorDetectionState>
  hostExecutorInventories: Record<string, HostExecutorInventoryState>
  hostChecks: Record<string, HostCheckState>
  browserAnnotationsByBrowserId: Record<string, BrowserAnnotation[]>
  connectorRoomIntents: Record<string, ConnectorRoomIntent>
  connectorRoomDrafts: Record<string, ConnectorRoomDraft>
  continuityControlIntents: ContinuityControlIntents
  conversationLandmarkIntents: ConversationLandmarkIntents
  connectorServiceIntents: Record<string, ConnectorServiceIntent>
  mailboxNotificationIntents: MailboxNotificationIntents
  mailboxNotificationFeedback: MailboxNotificationFeedbackBySubject
  mailboxNotificationHistory: MailboxNotificationHistoryBySubject
  /** Current policy is an endpoint-scoped observation, never a durable preference or receipt. */
  connectorServiceObservation: ConnectorServiceObservations
  moteBotRequests: Record<string, MoteBotRequest>
  botTaskSelections: BotTaskSelections
  manualConnectionSelections: Partial<Record<ManualConnectionIntent['channel'], ManualConnectionIntent['target']>>
  manualConnectionIntents: Record<string, ManualConnectionIntent>
  moteConnectionSaveIntents: Record<string, MoteConnectionSaveIntent>
  moteChatIntents: Record<string, MoteChatIntent>
  agentComposerDrafts: Record<string, string>
  agentLearningReviewDrafts: Record<string, AgentLearningReviewDraft>
  capsuleQuestionEditors: Record<string, CapsuleQuestionEditor>
  browserOpinionDrafts: Record<string, BrowserOpinionDraft>
  agentComposerHistory: Record<string, readonly string[]>
  agentComposerHistoryNavigation: Record<string, Omit<HistoryState, 'entries'> & { entries?: readonly string[] }>
  /** Launcher producer context shares the draft's durable Region owner; editing only changes body. */
  agentComposerNotes: Record<string, string>
  agentSteerInFlight: Record<string, string>
  /** Transient display facts from the existing queue drain; never persisted as delivery evidence. */
  agentSteerInFlightPhase: Record<string, 'preparing' | 'submitting'>
  questionReplyDrafts: DesktopQuestionDrafts
  questionReplies: DesktopQuestionReplies
  agentSteerQueues: Record<string, AgentSteerQueueEntry[]>
  /**
   * 启动对话框里填的两个可选名字，按 launcher 的 regionId 存——与 {@link agentComposerDrafts} 同一
   * 归属、同一生命周期。这里不是"手改名"那一档：手改名按 session id 存在 {@link agentNames}，而这两个
   * 名字在启动成功之前还没有 session 可挂。
   *
   * 为什么不能留在组件的 useState 里：启动的一瞬间本 region 就被换成 pending agent surface，
   * NewTabSurface 随即卸载；启动失败翻回 launcher（reduceSessionLaunchFailed 沿用同一 regionId）
   * 重挂的是一个 useState('') 的新实例，用户填的名字就没了——正是 prompt 当初被搬进 store 要修的
   * 那份用户报告（"报错退回初始页、之前输入没缓存"），名字这两格当时没跟上同一修法。
   */
  launcherNameDrafts: Record<string, LauncherNames>
  /** Unsent explicit launch choices, isolated by original Region and Provider. */
  launcherOptionDrafts: LauncherOptionDrafts
  /**
   * 用户手改的 Agent 显示名，按 Agent Session id 存。这是《显示名与身份》优先级链最高的那一档——
   * 名字只用于显示，绝不进入 id/寻址：这里的 key 是既有的 session id（寻址身份），value 只是一个
   * 展示字符串，改它不动任何地址。Tab 手改名不在这里——它是 WorkbenchTab.name，与 Tab 同生命周期。
   */
  agentNames: Record<string, string>
  nameLabels: Record<string, AgentMuxDisplayLabel>
  nameAuthorityRevision: number
  nameAcknowledgementRevision: number
  noticeReadReceipts: Record<string, Record<string, string>>
  /** Original Mote action facts; ephemeral, shared by the status surface and read-only inspection. */
  moteContextOperations: MoteContextOperations
  mainSurface: MainSurface
  focusAgentReveal: FocusAgentReveal | null
  revealFocusAgent(target: FocusAgentTarget, presentationSessionId?: string): void
  finishFocusAgentReveal(requestId: string): void
  clearFocusAgentReveal(): void
  focusView: 'list' | 'map'
  collaborationMapTarget: CollaborationMapTarget | null
  setFocusView(view: 'list' | 'map'): void
  openCollaborationMap(target?: CollaborationMapTarget): void
  locateSpaceInCollaborationMap(): void
  notebookRecoveries: NotebookRecovery[]
  recallNotebookId: string | null
  recallNoteId: string | null
  recallZoneSelection: SurveyZoneSelection | null
  setRecallZoneSelection(selection: SurveyZoneSelection | null): void
  recallSidebarCollapsed: boolean
  recallSidebarWidth: number
  setRecallSidebarCollapsed(collapsed: boolean): void
  setRecallSidebarWidth(width: number): void
  setRecallNotebook(notebookId: string | null, noteId?: string | null): void
  refreshNotesStorage(): Promise<void>
  surveyZoneSelection: SurveyZoneSelection | null
  /** Explicit Survey creation or saved display membership; Browser existence does not imply membership. */
  surveyCollectedZones: Record<string, true>
  surveyOrganization: import('@agentmux/core/control').AgentMuxSurveyOrganization
  setSurveyOrganization(organization: import('@agentmux/core/control').AgentMuxSurveyOrganization, expected: import('@agentmux/core/control').AgentMuxSurveyOrganization): Promise<import('@agentmux/core/control').AgentMuxSurveyListReport>
  surveyExplorationNames: Record<string, string>
  setSurveyExplorationName(zoneId: string, name: string, expectedNameRevision?: number): Promise<boolean>
  setSurveyZoneCollected(zoneId: string, collected: boolean): boolean
  surveyToolsOpen: boolean
  surveySidebarWidth: number
  surveySidebarCollapsed: boolean
  setSurveySidebarCollapsed(collapsed: boolean): void
  setSurveySidebarWidth(width: number): void
  setSurveyZoneSelection(selection: SurveyZoneSelection | null): void
  setSurveyToolsOpen(open: boolean): void
  createSurveyBrowser(input: Parameters<typeof createSurveyBrowser>[1]): ReturnType<typeof createSurveyBrowser>
  /** Durable global Board Demand records. Session links remain explicit and are derived only for the selected Demand. */
  demands: Record<string, DemandRecord>
  /** Editor-owned binding from a Demand to its dedicated PMO Teams Tab. */
  demandPmoTabIds: Record<string, string>
  /** Global navigation context. Execution and PMO focus are separate lanes and never overwrite one another. */
  agentFocus: AgentFocusContext
  focusTimelineNameWidth: number
  setFocusTimelineNameWidth(width: number): void
  focusTimelineHeight: number
  setFocusTimelineHeight(height: number): void
  focusTimelineRuler: FocusRulerPreferences
  setFocusTimelineRuler(preferences: FocusRulerPreferences): void
  focusExecutionSession(id: string | null, reference?: WorkbenchProjectionSelection, options?: { navigate: boolean }): boolean
  conversationRevealIntent: ConversationRevealIntent | null
  revealConversationItem(itemRef: ConversationItemRef, routeHostId?: string): Promise<MailboxMessageNavigationResult>
  selectMainRegion(reference: WorkbenchProjectionSelection, expected?: AgentMuxDesktopSpaceSelection | null): boolean
  focusPmoSession(id: string | null): void
  selectedDemandId: string | null
  demandArrangement: DemandArrangement
  setSelectedDemand(id: string | null): void
  setDemandArrangement(arrangement: DemandArrangement): void
  openDemandPmo(demandId: string, onReceipt?: (receipt: GoalPmoReceipt) => void): Promise<string>
  requestDemandPmoTask(demandId: string, mode: 'grill' | 'grounding', options?: { creationOperationId?: string | undefined; onReceipt?: ((receipt: GoalPmoReceipt) => void) | undefined }): Promise<string>
  refreshDemand(demandId: string): Promise<void>
  confirmDemandGoal(demandId: string, expectedRevision: number): Promise<void>
  acceptDemandResult(demandId: string, expectedAlignmentRevision: number, expectedSubmissionId: string, acceptGaps?: boolean, finish?: boolean): Promise<void>
  createDemand(input: {
    id?: string
    title: string
    description?: string
    projectId?: string | null
    projectName?: string | null
    assigneeSessionIds?: readonly string[]
    supervisorSessionId?: string | null
    tags?: readonly string[]
    plannedStartAt?: number | null
    targetAt?: number | null
    parentDemandId?: string | null
    phaseIndex?: number | null
    activityLog?: readonly string[]
    sessionIds?: readonly string[]
    contentRefs?: readonly DemandContentReference[]
    priority?: DemandPriority
    status?: DemandStatus
    source?: DemandRecord['source']
    decisionLog?: readonly AgentMuxDemandDecision[]
  }, controlRequestId?: string): Promise<string>
  updateDemand(id: string, patch: Partial<Pick<DemandRecord, 'title' | 'description' | 'status' | 'priority' | 'projectId' | 'projectName' | 'assigneeSessionIds' | 'supervisorSessionId' | 'tags' | 'plannedStartAt' | 'targetAt' | 'parentDemandId' | 'phaseIndex' | 'activityLog' | 'sessionIds' | 'decisionLog' | 'contentRefs'>> & { alignment?: DemandAlignmentProposal; grounding?: DemandGroundingProposal }, controlRequestId?: string, expectedUpdatedAt?: number): Promise<void>
  deleteDemand(id: string): void
  projectRailOpen: boolean
  /**
   * 折叠起来的 Project 分组，key 由 {@link projectGroupKey} 从 hostId + 父目录派生。
   *
   * 只存**折叠**的那些（默认展开）：分组是从磁盘路径派生的，用户新加一个项目就可能凭空多出一组，
   * 而它该是展开的。存"折叠集合"时新分组天然展开；存"展开集合"则要为每个新分组补一条记录，
   * 漏了就默认折叠——那是把一个派生结构当成了需要注册的实体。
   */
  collapsedProjectGroups: Record<string, true>
  /**
   * 内容槽里 Explorer 的折叠状态，按 workspace id 存。
   *
   * 与紧邻的 {@link collapsedProjectGroups} 是**相邻却相反**的存法，值得说清为什么：那份只存
   * 「折叠」一侧、缺席即默认，因为它只有**一个**全局默认（默认展开），存另一侧就得为每个新发现的
   * 分组补一条注册、漏一条就默认错。而 Explorer 有**两个** kind 默认——Scratch 默认折叠、Project
   * 默认展开——一个「折叠集合」编码不了它。所以这里存的是**用户的显式覆盖**：`true` 和 `false`
   * 都是值，**缺席**才表示「按这个 workspace 的 kind 默认走」（默认由消费侧的
   * `contentSlotPresentation` 解析，这里不 import、不算它——store 只记覆盖）。
   *
   * 它守住的仍是 collapsedProjectGroups 那条规则要保护的**同一个**性质：一个用户从没碰过的
   * workspace 无需任何注册，天然拿到正确状态（缺席 → kind 默认）。区别只是「正确状态」不再是
   * 单一的展开，而随 kind 而定。所以既不能像折叠集合那样把 `false` 读成缺席，也不能把缺席补成
   * `false`——那都会把「按 kind 默认」这一档抹掉。
   */
  explorerCollapsed: Record<string, boolean>
  /** 记下某个 workspace 的 Explorer 折叠覆盖（true/false 都是显式值；不清除、不折叠成缺席）。 */
  setExplorerCollapsed(workspaceId: string, collapsed: boolean): void
  /**
   * 被 pin 住的项，按 scope key 存 → 该 scope 内的 id 列表（保序，pin 的先后就是顺序）。
   *
   * Topic 与 Branch 是**同一个概念**的两次实例化——一个 scope 内的一组 id——所以是**一个** slice
   * 而不是两个。scope key 由调用方**派生**、绝不在调用点手写：
   *   - Topic scope：`SCRATCH_WORKSPACE_ID`（只有一个 Scratch workspace，Topic id 在其内唯一）。
   *   - Branch scope：`workspaceProjectId(workspace)`（= `[hostId, repoPath]`，因而正确地横跨一个
   *     repo 的多个 worktree）。
   * **一个分支名只在其 repo 内唯一**：两个项目都能有 `main`。若拿一个全局的分支名集合来存，单项目
   * 测试下看着没问题，真实使用里会跨项目串 pin——所以 scope 必须进 key，且必须派生。store 本身对
   * scope 不做解释，只按给来的 key 分桶。
   */
  pinnedItems: Record<string, string[]>
  /** User-authored Space identity, alongside pin/layout presentation; never Runtime configuration. */
  spaceObjectIcons: SpaceIconOverrides
  setSpaceObjectIcon(key: string, icon: SpaceIconChoice | null): Promise<void>
  /** 在一个 scope 内 pin/unpin 一个 id。保序；unpin 恰好移除一条；移空则删掉该 scope 键（同 toggleProjectGroup 删键，不留空数组）。 */
  togglePinnedItem(scope: string, id: string): void
  toolkitPresentation: ToolkitPresentations
  setToolkitPresentation(toolId: string, patch: ToolkitPresentationPatch): void
  toolsOpen: boolean
  workspaceTool: WorkspaceTool
  workspaceGitView: WorkspaceGitView
  gitCommitDrafts: Record<string, string>
  projectRailWidth: number
  toolDockWidth: number
  /**
   * 编辑器换行开关。**全局一个位**，不是按文件——它是一种查看偏好（像主题），不是文档的属性；
   * 用户打开一个长行文件想换行，通常下一个长行文件也想换行。持久化（进 partialize 白名单），
   * 与 toolsOpen 等表面偏好同一档：重开要还在。默认关（off），与 Monaco 默认一致，长行仍可横向滚。
   */
  editorWordWrap: boolean
  /** Shared viewing preferences; they never alter a document or the Explorer cache. */
  editorMinimap: boolean
  explorerShowHidden: boolean
  explorerShowIgnored: boolean
  /**
   * 每个文件 Region 当前是「编辑」还是「diff」显示模式，按 regionId 存。
   *
   * 关键决策：diff 不是新的 surface kind，而是既有 file Region 的一个**显示模式**。理由——一个 diff
   * 没有独立于其文件的身份（同一个 workspace+path），而新增 surface kind 要改 Core 里已发货的 Control
   * 协议（AgentMuxRegion 枚举了每一种 kind）外加渲染层约七处 union 落点，为零新增身份付跨包代价。
   * 所以 diff 是这张 file Region 的一个瞬态 UI 位；Session 的 viewModes 是用户查看偏好，另行持久化。
   *
   * 不持久化：diff 依赖 git HEAD，是一个瞬时视图；重开该回到编辑态而不是复活一个可能已过期的 diff。
   * 缺省即 'edit'。生命周期随 Region：Region 关掉时由 reconcile/close 出口一并清掉，不留孤儿。
   */
  editorRegionModes: Record<string, EditorRegionMode>
  /**
   * 每个文件 Region 已加载的 diff 负载（含加载中/失败态），按 regionId 存。由 `loadRegionDiff` 从既有
   * `window.agentmux.git.diff`（HEAD blob vs 工作区）取——不新开任何 git shell-out。与 editorRegionModes
   * 同生命周期、同不持久化。
   */
  editorRegionDiffs: Record<string, EditorRegionDiffState | undefined>
  loading: boolean
  startupProgress: StartupProgress
  startupAgentAvailability: StartupAgentAvailability | null
  error: string | null
  /** Last transient error remains available after dismissal/navigation for a deliberate reopen. */
  lastError: string | null
  errorNoticeContext: ErrorNoticeContext | null
  errorDismissed: boolean
  notificationEvents: NotificationEvent[]
  clearReadNotificationEvents(): void
  /** UI projection of the latest save request failure, never a persistence or Agent health owner. */
  workbenchSaveWarning: string | null
  workbenchSaveWarningOwner: 'local-storage' | 'workbench' | null
  nameSaveUnconfirmed: { operationId: string; target: AgentMuxNameTarget; message: string } | null
  nameEditFailure: { operationId: string; target: AgentMuxNameTarget; message: string } | null
  confirmNameSave(): Promise<void>
  reviewNameEdit(): Promise<void>
  reportWorkbenchSaveFailure(error: unknown, owner?: 'local-storage' | 'workbench'): void
  retryWorkbenchSave(): Promise<void>
  initialize(): Promise<() => void>
  selectWorkspace(id: string): Promise<void>
  activateWorkspaceSelection(result: WorkspaceSelectionResult, reveal?: boolean): void
  runFanOut(input: RunFanOutInput): Promise<RunFanOutResult>
  keepOneOfFanOut(input: KeepOneOfFanOutInput): Promise<KeepOneOfFanOutOutcome | null>
  /**
   * 撤掉一条 worktree 的登记。
   *
   * 为什么这条动作必须落在 store 而不是留在面板里：`removed` 带回来的 `config` 是**权威的新配置**，
   * 而 `activeWorkspaceId` 是指进它的一个引用。面板自己 await 完就把 config 丢掉时，store 仍持有那条
   * 已经不存在的记录——`App.tsx` 照它找活动 Workspace 会得到 undefined，界面渲染成空白，屏幕上没有
   * 任何一句话解释刚才发生了什么。批量收尾（`keepOneOfFanOut`）一直是走 store 的，单条却绕过了它，
   * 那道不对称就是这个缺陷本身。
   */
  removeWorktree(input: RemoveWorktreeInput): Promise<RemoveWorktreeOutcome>
  createPullRequest(input: {
    workspaceId: string
    title: string
    body: string
    draft?: boolean
    token: CreatePrToken
    current: CreatePrIntentState
    /** Optional: when present the ladder runs first so blockers surface as actionable copy. */
    eligibility?: PrEligibilityInput
  }): Promise<CreatePullRequestResult>
  focusTabGroup(workspaceId: string, tabGroupId: string): void
  activateTab(workspaceId: string, tabGroupId: string, tabId: string, intent?: 'local' | 'navigation'): void
  executeControl(
    request: AgentMuxControlRequest,
    signal?: AbortSignal,
    options?: SpatialControlOptions & { admittedControlRequestId?: string }
  ): Promise<AgentMuxControlResult>
  /** Whether the original display selection was committed. Refusal preserves the current context. */
  selectSession(id: string, tabGroupId?: string): boolean
  prepareWorkbenchLayout(workspaceId: string): WorkspaceLayout
  createWorkbenchZone(input: { workspaceId: string; spaceIds: readonly string[] }): Promise<{ zone: AgentMuxZoneFact; save: AgentMuxSpatialSave; issues: AgentMuxSpatialIssue[] }>
  setZoneSpaceRelation(zoneId: string, spaceId: string, linked: boolean): Promise<AgentMuxSpaceBindingReport>
  setTabDisplayPlacement(tabId: string, displayWorkspaceId: string, groupId: string, present: boolean): Promise<AgentMuxSpaceBindingReport>
  openLauncher(target: { workspaceId: string; displayWorkspaceId?: string; tabGroupId?: string; topicId?: string; zoneId?: string; reveal: boolean;
    /** Claim an empty Group's original input in its new real Region, without navigating another surface. */
    initialInputs?: { prompt: string; names: LauncherNames; optionsByProvider: LauncherProviderOptions; sourceLauncherId?: string }
  }): string | undefined
  closeTab(
    workspaceId: string,
    tabGroupId: string,
    tabId: string,
    options?: { keepAgentSessions?: boolean }
  ): Promise<boolean>
  moveTab(
    workspaceId: string,
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    targetIndex: number
  ): void
  moveTabToNewGroup(
    workspaceId: string,
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection
  ): void
  // `cause` 决定这次落焦除了搬绿环要不要把 DOM caret 也搬进去（键盘导航要，指针点击不要——原生 mousedown
  // 已把焦点放对）。判定是纯的（regionFocusClaimsCaret），这里只按它的结果投/不投 caret 意图。默认 'pointer'：
  // 调用方不显式说明时按最保守的一路走，不夺焦。
  focusRegion(workspaceId: string, tabId: string, regionId: string, cause?: RegionFocusCause, groupId?: string): void
  // 被点名那格的表面消费完 caret 意图后调它清除（只清自己那条 nonce，避免抹掉更晚一次导航投的新意图）。
  requestRegionCaretFocus(regionId: string): void
  clearRegionCaretFocus(nonce: number): void
  // Explicitly relocate one Session projection (the Region named by regionId) into another
  // workspace's View. This moves DISPLAY identity only — the Agent's cwd is Core's
  // session.workspacePath and is never touched. Navigation reuses focusRegion; a closing source
  // View is refused via reportError rather than half-moved.
  moveSessionViewToWorkspace(regionId: string, targetWorkspaceId: string): void
  splitRegion(
    workspaceId: string,
    tabId: string,
    regionId: string,
    direction: SplitDirection,
    initialRequest?: { prompt: string; agentMuxNote?: string }
  ): string | undefined
  /**
   * 重排一个 Tab 的格子。与控制协议的 `arrange` 是同一个引擎（arrangeWorkbenchControlTab），
   * 「要补几个格」由它自己从 preset 推导，这里不重算——见那个函数的注释。
   *
   * 形参是引擎自己那个三档 union（`AgentMuxArrangeMode`），不是裸的 preset。此前它只收 preset，
   * 于是引擎支持的另两档（`balance` 均分、`active-first` 把当前格挪到第一位）**GUI 根本表达不出来**，
   * 只有命令行能触达（#486）。那不是「菜单忘了加一项」——是这个签名把它们挡在了外面：想加菜单项
   * 得先改签名，而不改签名就只能在渲染层另找一条路去调引擎，那就是第二个调用点、第二份推导。
   * 收成引擎自己的 union 之后，加一档新的重排方式在这条路上不需要改任何签名。
   */
  arrangeTabRegions(workspaceId: string, tabId: string, mode: AgentMuxArrangeMode): void
  // 把一个 Tab 里两格的位置互换（#471）：右键某一格选「和另一格换位」。纯布局代数
  // （swapWorkbenchRegions），只换 id 在骨架上的位置，内容与所有 ratio 一字不动。
  swapRegions(workspaceId: string, tabId: string, regionIdA: string, regionIdB: string): void
  // 把一个 Tab 里某一格单独变成它自己的 Tab（#487，「单独变成一个 tab」）：右键某一格选「Move to New
  // Tab」。纯布局代数（promoteRegionToTab）——把这一格从源 Tab 的分屏树里摘出来，作为一张新 Tab 的
  // 唯一一格，落在源 Tab 紧邻其后的位置并激活。只剩一格的 Tab 促升无意义（它已经就是一张 Tab），是 no-op。
  promoteRegionToTab(workspaceId: string, tabId: string, regionId: string): void
  closeRegion(workspaceId: string, tabId: string, regionId: string): Promise<void>
  // 键盘关 Tab 的入口：只投意图，真正的关闭（含确认）由活动 Tab 组件消费。见 closeTabRequest 状态注释。
  requestCloseTab(workspaceId: string, tabGroupId: string, tabId: string): void
  clearCloseTabRequest(nonce: number): void
  // 键盘关某一格的入口：只投意图，含未保存确认的真正关闭由承载该格的组件消费。见 closeRegionRequest 注释。
  requestCloseRegion(workspaceId: string, tabId: string, regionId: string): void
  clearCloseRegionRequest(nonce: number): void
  updateRegionSplitRatio(workspaceId: string, tabId: string, nodePath: string, ratio: number): void
  updateSplitRatio(workspaceId: string, nodePath: string, ratio: number): void
  setViewMode(sessionId: string, mode: ViewMode, options?: { focus?: boolean }): void
  /** 翻转编辑器换行的全局位。 */
  toggleEditorWordWrap(): void
  toggleEditorMinimap(): void
  toggleExplorerShowHidden(): void
  toggleExplorerShowIgnored(): void
  /**
   * 把一个文件 Region 切到 diff 模式并（若还没有）加载它的 diff；再次调用（mode 'edit'）切回编辑。
   * diff 两侧走既有 git.diff 桥，不新开 shell-out。regionId 承载模式，workspaceId+path 定位文件。
   */
  setEditorRegionMode(regionId: string, workspaceId: string, path: string, mode: EditorRegionMode): Promise<void>
  /** 重新拉取一个已在 diff 模式的 Region 的 diff（用户点「刷新」，或改动落盘后想看最新差异）。 */
  reloadRegionDiff(regionId: string, workspaceId: string, path: string): Promise<void>
  /**
   * 从 Changes 面板点一个文件：打开它（走既有 openFile），并把它的 canonical Region 切到 diff 模式。
   * 是「minimal end-to-end」那条路——点变更 → 看该文件的 diff。regionId 由原 File owner 的持久事实决定，
   * 所以这里在 openFile 之后查回实际落点、再 setEditorRegionMode，
   * 而不是让调用方各自推导 regionId（推错就切错 Region 的模式）。
   */
  openFileDiff(path: string, workspaceId?: string): Promise<void>
  /** Explicit file navigation from an external control, through the original document owner. */
  openFileAndReveal(path: string, tabGroupId?: string, location?: { line: number; column?: number }, workspaceId?: string, navigationSignal?: AbortSignal): Promise<boolean>
  openBranchDiff(workspaceId: string, comparison: GitDiffDescriptor): void
  openGitWorkbench(workspaceId: string, snapshot: GitCommitSnapshot): { tabId: string; regionId: string }
  openGitHistory(workspaceId: string, scope: Pick<GitCommitSnapshot, 'hostId' | 'repoPath'>, reference?: string | null, locate?: GitCommitSnapshot): { tabId: string; regionId: string }
  selectGitHistoryReference(regionId: string, reference: string | null): void
  selectGitFile(regionId: string, file: { path: string; origPath: string | null } | null): void
  selectGitCommit(regionId: string, snapshot: GitCommitSnapshot): void
  loadBranchDiff(regionId: string): Promise<void>
  /** Release a budgeted Git Diff payload; its durable Region and fixed descriptor stay intact. */
  releaseBranchDiff(regionId: string): void
  setMainSurface(surface: MainSurface): void
  toggleProjectRail(): void
  toggleProjectGroup(key: string): void
  setWorkspaceTool(tool: WorkspaceTool): void
  setWorkspaceGitView(view: WorkspaceGitView): void
  setGitCommitDraft(scope: string, message: string): void
  toggleTools(): void
  setProjectRailWidth(width: number): void
  setToolDockWidth(width: number): void
  updateFileExplorerState(
    workspaceId: string,
    update: (current: FileExplorerViewState) => FileExplorerViewState
  ): void
  detectExecutors(hostId: string, options?: { onlyUnconfirmed?: boolean; onlyObserved?: boolean }): Promise<void>
  discoverHostExecutors(hostId: string): Promise<void>
  checkHost(host: HostConfig): Promise<void>
  /**
   * 打开一个文件面。
   *
   * `workspaceId` 缺省时按活动 Workspace 解析——绝大多数调用方是用户当场点的，那正是他想要的。
   * 但**异步**调用方（先建文件再打开、先读 diff 再切模式）必须显式传自己开头解析出来的那一个：
   * 不传就等于在同一条路上解析两次，中间用户切了侧栏就漂移，而症状不是报错而是静默开错文件。
   *
   * `openAsText` 强制按文本打开，跳过书签默认开进 Browser 那条分支——这就是「查看书签源码」（§2.6）：
   * 同一个 `openFile` 回到既有 Monaco 路径，不新造 surface kind。只有书签的「查看源码」按钮传 true。
   */
  openFile(
    path: string,
    tabGroupId?: string,
    location?: { line: number; column?: number; noteBlock?: NoteBlockTarget },
    workspaceId?: string,
    openAsText?: boolean,
    placement?: FileOpenPlacement,
    /** Cancels this caller's reveal only; the shared document read remains owned. */
    navigationSignal?: AbortSignal
  ): Promise<boolean>
  /**
   * 给一个已在板上、但还没有文档的文件面装上它的文档。
   *
   * 这条路只有一个来源：从持久化恢复出来的文件面。它只带 `{regionId,kind,workspaceId,path}`，
   * 没有任何内容，而 EditorPane 一旦 `documents[key]` 缺失就渲染「不可用」——于是 tab 在、
   * 点开报不可用，看起来像文件坏了。由 EditorPane 自己调用而不是启动时扫一遍，是为了覆盖
   * 非活动 Workspace 的文件面（启动扫描只能对着活动 Workspace 解析路径，那些 tab 会一直坏到
   * 下次重启）。注意隐藏 tab 是刻意保持挂载的，所以冷启动会读该 group 的每个文件面而不只是
   * 活动那个——代价是每个打开着的文件面一次 read，换来每个恢复出的 tab 首次点击就能用。
   * 与 `openFile` 分开是因为后者还负责「打开」——它会激活 Tab、可能搬动它、并写 reveal
   * target，而这里 Tab 已经在用户留下的位置上了。
   */
  attachPersistedFileDocument(workspaceId: string, path: string): Promise<void>
  clearDocumentRevealTarget(key: string): void
  openProjectFolder(): Promise<void>
  createScratchTopic(preset?: 'mote', initialRequest?: { prompt: string; agentMuxNote?: string; executorId?: string }, knowledge?: { categoryId?: string; title?: string }): Promise<ScratchTopicSnapshot>
  refreshScratchTopics(workspaceId: string, force?: boolean, topicId?: string): Promise<void>
  invalidateScratchTopicPaths(workspaceId: string, paths: readonly string[], structural?: boolean): Promise<void>
  setMoteArchived(workspaceId: string, topicId: string, archived: boolean, objectKey: string, expectedVersion: string): Promise<void>
  openScratchTopic(topicId: string, workspaceId?: string, options?: OpenScratchTopicOptions): Promise<boolean>
  renameScratchTopic(topicId: string, title: string, workspaceId?: string): Promise<ScratchTopicSnapshot>
  /**
   * 给一个 Agent 设用户手改名（传空清除，交还派生链）。只写 `agentNames[sessionId]`，不碰 session id、
   * run、寻址或 Core——名字是纯展示投影，永不进 Core Session 事实。
   */
  renameAgent(sessionId: string, name: string | null, expectedNameRevision?: number): Promise<boolean>
  /**
   * 给一张 Tab 设用户手改名（传空清除，交还默认策略）。只改 `WorkbenchTab.name` 一个字段，id 与三级
   * 地址原样不动。用户手改后，"单 Agent 对齐 / 多 Region 家族名"两条自动策略对这张 Tab 永久停手。
   */
  renameTab(tabId: string, name: string | null, expectedNameRevision?: number): Promise<boolean>
  /**
   * 在当前 Workspace 里建文件或目录，返回**它实际用的**那个 workspaceId。
   *
   * 返回值不是给日志的：调用方建完常要接着打开它，而 openFile 会自己再解析一次活动 Workspace。
   * 两次解析之间只要有一个 await（本地建文件也有 IPC，远端可达 15s），用户点一下侧栏就漂移，
   * 症状是**开错文件**而不是报错——名字撞上另一个项目里的同名文件时界面上一切正常。
   * 所以解析必须只发生一次，然后把结果交给下游，而不是让下游自己再问一遍。
   */
  createPath(input: CreateWorkspacePathInput, workspaceId?: string): Promise<string>
  createNote(tabGroupId?: string, launcher?: { tabId: string; regionId: string }, initialContent?: string, projection?: WorkbenchProjection, retryIntentId?: string, notebook?: NoteNotebookContext): Promise<NoteCreationReceipt>
  revealCreatedNote(launcherId: string, projection?: WorkbenchProjection): Promise<NoteCreationReceipt | undefined>
  retryCreatedNote(launcherId: string, projection?: WorkbenchProjection): Promise<NoteCreationReceipt | undefined>
  renamePath(path: string, nextPath: string, workspaceId?: string): Promise<void>
  deletePath(path: string, workspaceId?: string): Promise<void>
  updateDocument(tabId: string, content: string, regionId?: string): void
  updateNoteDocument(tabId: string, content: string, editorBeforeContent: string, regionId?: string): void
  observeNoteFile(target: NoteFileTarget, occurrence: string, load?: boolean): () => void
  loadNoteFile(target: NoteFileTarget): Promise<void>
  updateNoteFile(target: NoteFileTarget, content: string, editorBeforeContent: string): void
  saveNoteFile(target: NoteFileTarget): Promise<void>
  inspectNoteShare(workspaceId: string, path: string): Promise<void>
  continueNoteShare(workspaceId: string, path: string): Promise<void>
  inspectNoteShareUndo(workspaceId: string, path: string): Promise<void>
  continueNoteShareUndo(workspaceId: string, path: string): Promise<void>
  adoptNoteCurrentDocument(tabId: string, regionId: string): Promise<void>
  retryNoteInput(tabId: string, regionId: string): Promise<void>
  retainNoteEditorDraft(tabId: string, regionId: string, displayed: string, incoming: string, resource: { hostId: string; path: string }, action: 'retain' | 'keep-displayed'): void
  saveDocument(tabId: string, regionId?: string): Promise<void>
  overwriteDocument(tabId: string, regionId?: string): Promise<void>
  useRetainedDocumentDraft(tabId: string, regionId?: string, selected?: FileDocument): void
  reloadDocument(tabId: string, regionId?: string): Promise<void>
  refreshDocument(workspaceId: string, path: string): Promise<void>
  inspectNoteHistory(tabId: string, regionId: string, noteId: string): Promise<NoteHistoryInspection>
  applyNoteHistory(tabId: string, regionId: string, selection: NoteHistorySelection): Promise<void>
  launchBoardAgent(
    workspaceId: string,
    executorId: string,
    prompt: string,
    topicId?: string
  ): Promise<void>
  launchAgent(
    executorId: string,
    prompt: string,
    tabGroupId: string,
    launcher?: { tabId: string; regionId: string },
    launchOptions?: LaunchOptionSelection,
    /**
     * 启动对话框里填的名字。两个都留空是正常情况——此时不写任何名字，显示名交还派生链
     * （见 lib/display-name.ts 的优先级链）。名字在这里写而不由调用方写，是因为 sessionId
     * 与 tabId 都在本函数内部生成，从不出参。
     */
    names?: { agentName?: string | undefined; tabName?: string | undefined; nameSource?: 'derived' },
    agentMuxNote?: string,
    pmo?: { intent: GoalPmoIntent; onCreated: (result: AgentLaunchResult) => void }
  ): Promise<void>
  launchTerminal(
    tabGroupId: string,
    launcher?: { tabId: string; regionId: string },
    workspacePath?: string
  ): Promise<void>
  // Reuse an idle candidate for this exact target, or create an independent shell.
  prewarmTerminal(workspaceId: string, ownerLauncherId: string): void
  releaseWarmTerminal(workspaceId: string, ownerLauncherId: string): void
  retryWarmTerminal(workspaceId: string, ownerLauncherId: string, hostRestored?: boolean): Promise<SessionSnapshot | null>
  // Claims the exact warm shell or uses the ordinary Terminal launch path if none exists.
  promoteWarmTerminal(
    tabGroupId: string,
    launcher?: { tabId: string; regionId: string }
  ): Promise<void>
  createBrowser(
    tabGroupId: string,
    launcher?: { tabId: string; regionId: string },
    url?: string,
    bookmarkOrigin?: { path: string; binary: boolean },
    requestedWorkspaceId?: string,
    requestedDisplayWorkspaceId?: string,
    mode?: import('@agentmux/core').AgentMuxBrowserMode
  ): Promise<void>
  openHttpLink(origin: OpenHttpLinkOrigin, url: string, destination: OpenDestination, presentation?: Pick<WorkbenchPresentation, 'surface' | 'onSelectRegion'>): Promise<void>
  /**
   * 把一个页面存成 `.webloc` 书签，落在 workspace 根下。文件名由标题派生并做撞名退避
   * （`Name.webloc`、`Name 2.webloc`…），返回落地的相对路径。取消（about:blank）或全部候选都撞名
   * 时抛，由调用方（BrowserPane 的 run）报到错误面。
   */
  saveBrowserBookmark(workspaceId: string, url: string, title: string): Promise<string>
  applyBrowserEvent(event: BrowserEvent, expectedNavigationId?: string): void
  addBrowserAnnotation(annotation: BrowserAnnotation): void
  deleteBrowserAnnotation(browserId: string, annotationId: string): void
  clearBrowserAnnotations(browserId: string): void
  recordAgentComposerHistory(sessionId: string, text: string): void
  recallAgentComposerHistory(sessionId: string, direction: 'older' | 'newer', draft: string, entries?: readonly string[]): string | null
  setAgentComposerDraft(sessionId: string, text: string): void
  /**
   * 写启动对话框的一格名字。`field` 只有 'agentName' | 'tabName' 两种，两格共用一条 action：
   * 一格一个 setter 会让"启动成功要清掉这个 region 的名字草稿"变成两处要记得改的地方。
   */
  setLauncherExecutionWorkspace(launcher: { tabId: string; regionId: string }, workspaceId: string, executorId?: string): void
  setLauncherNameDraft(regionId: string, field: LauncherNameField, value: string): void
  setLauncherOptionDraft(regionId: string, providerId: string, optionId: string, choiceId: string | null): void
  appendAgentComposerDraft(sessionId: string, text: string): void
  saveBrowserOpinionDraft(browserId: string, draft: BrowserOpinionDraft, flush?: boolean): Promise<void>
  clearAgentComposerDraftIfUnchanged(sessionId: string, expectedText: string): void
  /** Queue a steer. `false` means it was refused (empty, not an Agent, or over the size budget) and the caller must keep the draft. */
  enqueueAgentSteer(sessionId: string, text: string, onRejected?: (error: unknown) => void, operationId?: string, origin?: 'manual', agentMuxNote?: string, options?: AgentSteerOptions): boolean
  moveQueuedAgentSteerToDraft(sessionId: string, operationId: string, expectedText: string, expectedRunId: string): Promise<void>
  archiveAgentSteer(sessionId: string, operationId: string, expectedText: string, archived: boolean): Promise<{ changed: boolean; entry: AgentSteerQueueEntry }>
  moveAgentSteer(sessionId: string, operationId: string, direction: 'up' | 'down'): void
  editQueuedAgentSteer(sessionId: string, operationId: string, expectedText: string, nextText: string): void
  sendQueuedAgentSteer(sessionId: string, operationId: string): Promise<'submitted' | 'unconfirmed'>
  /** An explicit GUI resend may establish new input only after Core settles the whole original as not applied. */
  resendRefusedAgentSteer(sessionId: string, operationId: string): Promise<'submitted' | 'unconfirmed'>
  cancelAgentSteerPreparation(sessionId: string, operationId: string): Promise<boolean>
  flushAgentSteerQueue(sessionId: string, explicitOperationId?: string): Promise<void>
  send(sessionId: string, text: string, onRejected?: (error: unknown) => void, origin?: 'manual', agentMuxNote?: string, options?: AgentSteerOptions): boolean
  inspectInteraction(sessionId: string, operationId: string): Promise<import('@agentmux/core').AgentMuxInteractionOperationReceipt | null>
  respondInteraction(sessionId: string, response: AgentMuxInteractionResponse, intent: import('@agentmux/core').AgentMuxInteractionOperationIntent): Promise<import('@agentmux/core').AgentMuxInteractionOperationReceipt>
  setPosture(sessionId: string, modeId: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  controlSessionContinuity(sessionId: string, intentOperationId: string, action: 'continue' | 'cancel', additionalAttempts?: number): Promise<import('@agentmux/core/agent-session-recovery').AgentMuxContinuityControlResult>
  reconcileSessionContinuityControl(hostId: string, sessionId: string, operationId: string): Promise<import('@agentmux/core/agent-session-recovery').AgentMuxContinuityControlResult>
  refreshSession(sessionId: string): Promise<SessionSnapshot | undefined>
  reopenRetiredSession(source: AgentSessionHistoryDescriptor, operationId?: string, observeOnly?: boolean): Promise<SessionSnapshot | undefined>
  resumeNativeSession(input: import('../../shared/contracts').AgentLaunchInput, source: import('@agentmux/core').AgentNativeSessionCandidate, capabilities: AgentCapabilities, reveal?: () => boolean, retry?: boolean): Promise<SessionSnapshot | undefined>
  recoverSession(sessionId: string, operationId?: string, options?: { preserveView?: boolean; stillCurrent?: () => boolean; trigger?: import('@agentmux/core/agent-session-recovery').AgentMuxContinuityTrigger; timingOverride?: 'startup' | 'on-open'; input?: NonNullable<import('@agentmux/core/agent-session-recovery').AgentMuxAgentContinuityInput['input']>; inputControl?: Extract<SessionSnapshot, { kind: 'agent' }>['control'] }): Promise<SessionSnapshot | undefined>
  restartSession(control: AgentSessionControl, operationId: string, observeOnly?: boolean): Promise<import('../../shared/contracts').SessionRestartResult>
  stopSession(sessionId: string): Promise<void>
  canonicalizeAgentLaunch(result: AgentLaunchResult): Promise<AgentLaunchResult | null>
  resyncTimeline(sessionId: string, options?: { observationOnly?: boolean }): Promise<void>
  applyEvent(event: RuntimeEvent): void
  /**
   * 把所有已陈旧的 `working` Agent 降为中性态（见 lib/agent-status-decay）。传 `now` 而非内部读
   * Date.now()，判定才可断言、测试才不 flake。什么都不该降时不写入，避免无谓的重渲染。
   */
  decayStaleAgentStatuses(now: number): void
  setConfig(config: AppConfig, preferredWorkspaceId?: string): void
  reportError(error: unknown, context?: ErrorNoticeContext): void
  dismissError(): void
  reopenError(): void










}

/**
 * Record the Session represented by a focused Workbench surface in the correct global lane.
 * Region focus is the common seam for pointer clicks, keyboard navigation and cross-surface
 * reveals, so Agent and Terminal Sessions share one execution MRU while PMO stays isolated.
 */
function focusSessionContext(
  state: Pick<AppState, 'agentFocus' | 'sessions' | 'config' | 'agentNames' | 'timelines' | 'scratchTopicSnapshots' | 'tabs' | 'layouts'>,
  sessionId: string | null,
  observedSession?: SessionSnapshot,
  reference?: WorkbenchProjectionSelection
): AgentFocusContext {
  if (sessionId === null) return focusExecution(state.agentFocus, null)
  const session = observedSession ?? state.sessions.find((candidate) => candidate.id === sessionId)
  if (!session) return state.agentFocus
  const lane = session ? focusLaneForSession(topicIdForSession(state.config, session, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)),
    scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspaceForSession(state.config, session, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)))) : 'execution'
  if (lane === null) return state.agentFocus
  return lane === 'pmo'
    ? focusPmo(state.agentFocus, sessionId)
    : focusExecution(state.agentFocus, sessionId, Date.now(), session
      ? observeFocusHistoryIdentity(session, state.config, state.agentNames[session.id], state.timelines[session.id], scratchTopicsForConfig(state.config, state.scratchTopicSnapshots))
      : undefined, reference && confirmedFocusReference(state, sessionId, reference) ? reference : undefined)
}

function confirmedFocusReference(state: Pick<AppState, 'tabs' | 'layouts'>, sessionId: string,
  reference: WorkbenchProjectionSelection): boolean {
  const layout = state.layouts[reference.displayWorkspaceId]
  const group = layout?.groups.find(item => item.id === reference.groupId)
  const surface = state.tabs[reference.tabId]?.regions[reference.regionId]
  return Boolean(layout && group && groupIds(layout.root).includes(group.id) && group.tabOrder.includes(reference.tabId) &&
    surface && isSessionSurface(surface) && surface.sessionId === sessionId)
}

// In-flight filesystem reads share the original snapshot owner. No identity registry is stored.
const scratchTopicReads = new Map<string, { scope: string; promise: Promise<void> }>()

// Only an active opening is shared. A replacement Launcher is a new intent, even
// at the same address; another Region never waits for this presentation flight.
const terminalOpeningCalls = new Map<string, {
  surface: WorkbenchSurface | undefined
  pendingSurface?: WorkbenchSurface | undefined
  promise: Promise<void>
}>()

function emptyRuntimeSnapshot(): RuntimeSnapshot {
  return {
    sessions: [],
    timelines: {},
    recoveryCandidates: []
  }
}

function startupWorkflowWarning(step: string, error: unknown, recovery: string): string {
  return `${step} did not complete: ${presentError(error)}. ${recovery}`
}

function controlFailure(
  code: AgentMuxControlErrorCode,
  detail: string,
  extra?: object
): Error & { code: AgentMuxControlErrorCode } {
  return Object.assign(new Error(detail), { code }, extra)
}

const CONTROL_ERROR_CODES: ReadonlySet<string> = new Set(AGENTMUX_CONTROL_ERROR_CODES)

function isControlErrorCode(value: unknown): value is AgentMuxControlErrorCode {
  return typeof value === 'string' && CONTROL_ERROR_CODES.has(value)
}

function controlCancellation(signal?: AbortSignal): Error & { code: AgentMuxControlErrorCode } {
  if (!(signal?.reason instanceof Error)) {
    return controlFailure('CONTROL_CANCELLED', 'Desktop Control request was cancelled.')
  }
  const source = signal.reason as Error & { code?: unknown }
  return Object.assign(source, { code: isControlErrorCode(source.code) ? source.code : 'CONTROL_CANCELLED' as const })
}

function normalizeHttpLinkUrl(rawUrl: string): string {
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Link URL protocol is not allowed: ${url.protocol}`)
  }
  return url.toString()
}

async function settleWorkbenchViewCloseResources<Resource extends WorkbenchViewCloseResource>(
  resources: readonly Resource[],
  close: (resource: Resource) => Promise<void>
): Promise<WorkbenchViewCloseReceipt[]> {
  const results = await Promise.allSettled(resources.map((resource) => {
    const pending = close(resource)
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `The ${resource.kind} close result is unknown after 5 seconds. Its View is retained; review it before retrying.${resource.kind === 'session' ? ' You can keep the Session and close only its display; the original Stop remains unconfirmed.' : ''}`
      )), 5_000)
      // Observe the original operation after our UI deadline; it has not been cancelled.
      // A late settlement cannot apply this completed View plan again.
      void pending.then(resolve, reject).finally(() => clearTimeout(timer))
    })
  }))
  return results.map((result, index) => result.status === 'fulfilled'
    ? { key: resources[index]!.key, status: 'fulfilled' }
    : { key: resources[index]!.key, status: 'rejected', reason: result.reason })
}

function workbenchViewCloseFailure(receipts: readonly WorkbenchViewCloseReceipt[]): Error {
  const reasons = receipts.flatMap((receipt) => receipt.status === 'rejected'
    ? [receipt.reason instanceof Error ? receipt.reason : new Error(String(receipt.reason))]
    : [])
  return reasons.length === 1
    ? reasons[0]!
    : new AggregateError(reasons, 'Multiple View resources could not be closed.')
}

function sessionOwnsControl(session: SessionSnapshot, control: SessionControl): boolean {
  return session.control.kind === control.kind &&
    session.control.hostId === control.hostId &&
    session.control.run.runId === control.run.runId
}

function demandRecordFromFilesystem(demand: FilesystemDemand, retained?: DemandRecord): DemandRecord {
  if (retained?.delegationReadCut && demand.updatedAt < retained.delegationReadCut.goalUpdatedAt) return retained
  return {
    id: demand.id,
    title: demand.title,
    description: demand.description,
    status: demand.status,
    priority: demand.priority,
    projectId: demand.projectId,
    projectName: demand.projectName,
    assigneeSessionIds: [...demand.assigneeSessionIds],
    supervisorSessionId: demand.supervisorSessionId,
    participations: [...demand.participations],
    ...(demand.creationOrigin === undefined ? {} : { creationOrigin: demand.creationOrigin }),
    tags: [...demand.tags],
    plannedStartAt: demand.plannedStartAt,
    targetAt: demand.targetAt,
    parentDemandId: demand.parentDemandId,
    phaseIndex: demand.phaseIndex,
    activityLog: demand.activities.map((activity) => `${activity.kind}: ${activity.message}`),
    delegations: [...(demand.delegations ?? [])],
    ...(retained?.delegationObservations ? { delegationObservations: retained.delegationObservations } : {}),
    ...(retained?.delegationObservationIssue ? { delegationObservationIssue: retained.delegationObservationIssue } : {}),
    ...(retained?.delegationReadCut ? { delegationReadCut: retained.delegationReadCut } : {}),
    ...(retained?.responsibility ? { responsibility: retained.responsibility } : {}),
    ...(demand.progressUpdates ? { progressUpdates: demand.progressUpdates } : {}),
    ...(demand.patrols ? { patrols: demand.patrols } : {}),
    ...(retained?.patrolObservations ? { patrolObservations: retained.patrolObservations } : {}),
    dispatches: [...(demand.dispatches ?? [])],
    activities: demand.activities,
    decisions: demand.decisions,
    ...(demand.alignment === undefined ? {} : { alignment: demand.alignment }),
    ...(demand.grounding === undefined ? {} : { grounding: demand.grounding }),
    sessionIds: [...demand.sessionIds],
    ...(demand.contentRefs === undefined ? {} : { contentRefs: [...demand.contentRefs] }),
    createdAt: demand.createdAt,
    updatedAt: demand.updatedAt,
    source: retained?.source ?? 'default-topic',
    decisionLog: [...(retained?.decisionLog ?? [])]
  }
}

function hasAttachedSessionView(tabs: Readonly<Record<string, WorkbenchTab>>, sessionId: string): boolean {
  return Object.values(tabs).some((tab) => workbenchSurfaces(tab).some((surface) => (
    isSessionSurface(surface) &&
    surface.phase === 'attached' &&
    surface.sessionId === sessionId
  )))
}

/** A same-Run status read cannot settle its Timeline failure; a verified new Run does not inherit it. */
function retainTimelineObservation(current: SessionSnapshot | undefined, incoming: SessionSnapshot): SessionSnapshot {
  return current?.kind === 'agent' && incoming.kind === 'agent' &&
    current.control.hostId === incoming.control.hostId && current.control.agentSessionId === incoming.control.agentSessionId &&
    current.control.run.runId === incoming.control.run.runId &&
    current.timelineObservation?.run.runId === incoming.control.run.runId && !incoming.timelineObservation
    ? { ...incoming, timelineObservation: current.timelineObservation } : incoming
}

function projectRecoveredSession(
  state: AppState,
  previousSessionId: string,
  session: SessionSnapshot
): Pick<AppState, 'sessions' | 'tabs' | 'agentFocus'> {
  session = retainTimelineObservation(state.sessions.find(item => item.id === previousSessionId), session)
  const tabs = session.id === previousSessionId ? state.tabs : { ...state.tabs }
  if (session.id !== previousSessionId) {
    for (const tab of Object.values(state.tabs)) {
      let nextTab = tab
      for (const surface of workbenchSurfaces(tab)) {
        if (
          isSessionSurface(surface) &&
          surface.sessionId === previousSessionId
        ) {
          nextTab = updateWorkbenchRegion(nextTab, surface.regionId, () => ({
            ...surface,
            sessionId: session.id
          }))
        }
      }
      if (nextTab !== tab) tabs[tab.id] = nextTab
    }
  }
  return {
    tabs,
    agentFocus: state.agentFocus.execution.sessionId === previousSessionId
      ? focusSessionContext(state, session.id, session)
      : state.agentFocus,
    sessions: [
      ...state.sessions.filter((item) => item.id !== previousSessionId && item.id !== session.id),
      session
    ]
  }
}

function continuityFailureDetail(
  result: Extract<SessionRecoveryResult, { kind: 'unavailable' | 'conflict' }>
): string {
  if (result.kind === 'conflict') {
    // 按 Core 给的**类别**分，不按 currentRun 在不在场猜。这两件事本来就不是同一个判据：
    // run 已被换掉才有 currentRun，而「另一个操作占着」也可能带着它。此前这里按 currentRun 猜，
    // 于是一条 session-run-changed 只要 currentRun 缺失就被说成「另一个操作占着」——
    // 又一处替 Core 猜类别的地方。
    switch (result.reason) {
      case 'session-run-changed':
        return result.currentRun
          ? `This Agent Session now belongs to Run ${result.currentRun.runId}; the stale Run was not resumed.`
          : 'This Agent Session already moved to a newer Run; the stale Run was not resumed.'
      case 'lifecycle-busy':
        return 'Another lifecycle operation owns this Agent Session; no new Run was started.'
    }
  }
  switch (result.reason) {
    case 'unknown-session':
      return 'Core has no current or retired binding for this Agent Session.'
    case 'native-handle-unavailable':
      return 'This Agent Session has no verified Provider handle for native resume.'
    case 'provider-resume-unsupported':
      return 'This Provider does not support native session resume.'
    case 'provider-unavailable':
      return 'The required Provider executable or resume capability is unavailable on this Host.'
  }
}

/**
 * 一次恢复失败投在 Session 状态上的**全部** continuity 字段，一处产出。
 *
 * 为什么必须共用而不是两个出口各写一遍：这些字段有两个写入点（启动时的候选投影
 * `recoveryCandidateSession`，和用户点「恢复」走的 `recoverSession`），而它们要写的是同一组字段。
 * 各写一遍的代价实测过——`continuityConflict` 曾只加在前一处，后一处照旧折叠，于是**用户主动点恢复
 * 的那条路**仍旧把 session-run-changed 说成「等一下」。两处该联动的写入分居两地必然 drift，
 * 所以收成一个函数：一处守住，两条路都守住。
 */
function continuityStatusFields(
  recovery: Extract<SessionRecoveryResult, { kind: 'unavailable' | 'conflict' }>
): Pick<
  SessionSnapshot['status'],
  'continuity' | 'continuityReason' | 'continuityConflict' | 'detail'
> {
  return {
    continuity: recovery.kind,
    // Core 给的原因原样带过来，不折进「失败了」这一个位。三类各要求用户做不同的事，只有 Core 知道是哪一类。
    ...(recovery.kind === 'unavailable' ? { continuityReason: recovery.reason } : {}),
    // conflict 自己还有两类，而它们要求的动作**相反**（重读 vs 等）。丢掉这一项，
    // 就等于对其中一半的用户说「等一个已经被换掉、永远不会回来的 Run」。
    ...(recovery.kind === 'conflict' ? { continuityConflict: recovery.reason } : {}),
    detail: continuityFailureDetail(recovery)
  }
}

/**
 * Keep a known durable candidate readable before restoration or after a Core recovery refusal.
 *
 * Exported for assertion: the reason Core gave is the whole payload of this projection, and a test
 * that seeds `continuityReason` into a fixture proves nothing about whether this function ever wrote
 * it. Asserting on the RETURNED snapshot is what makes dropping the field turn red.
 */
export function recoveryCandidateSession(
  candidate: AgentSessionRecoveryCandidate,
  recovery: Extract<SessionRecoveryResult, { kind: 'unavailable' | 'conflict' }> | { kind: 'pending'; detail: string }
): SessionSnapshot {
  return {
    id: candidate.agentSessionId,
    kind: 'agent',
    providerId: candidate.providerId,
    executorId: candidate.executorId,
    ...(candidate.nativeSessionId === undefined ? {} : { nativeSessionId: candidate.nativeSessionId }),
    capabilities: candidate.capabilities,
    agentSessionUpdatedAt: candidate.updatedAt,
    ...(candidate.semanticStatus ? { semanticStatus: structuredClone(candidate.semanticStatus) } : {}),
    ...(candidate.continuity ? { continuity: structuredClone(candidate.continuity) } : {}),
    ...(candidate.continuityOperations ? { continuityOperations: structuredClone(candidate.continuityOperations) } : {}),
    ...(candidate.terminalCapability
      ? { terminalCapability: structuredClone(candidate.terminalCapability) }
      : {}),
    hostId: candidate.hostId,
    workspacePath: candidate.workspacePath,
    label: candidate.label,
    createdAt: candidate.createdAt,
    updatedAt: Math.max(candidate.updatedAt, Date.now()),
    processState: 'interrupted',
    runUnobserved: true,
    status: {
      state: recovery.kind === 'pending' ? 'disconnected' : 'error',
      source: 'run-process',
      observedAt: Date.now(),
      // 两条路共用同一处产出，见 continuityStatusFields 的说明：这些字段各写一遍必然 drift。
      ...(recovery.kind === 'pending' ? { detail: recovery.detail } : continuityStatusFields(recovery))
    },
    latestOutputBytes: 0,
    control: {
      kind: 'agent',
      hostId: candidate.hostId,
      agentSessionId: candidate.agentSessionId,
      run: { ...candidate.run }
    }
  }
}

/**
 * store 的五态 {@link AsyncCheckState} → Control 线上的四态可用性——**唯一一处映射。**
 *
 * 两套词汇本就该只在这里相遇：store 那套（idle/checking/ready/missing/error）是 UI 检查生命周期，
 * Control 那套（unknown/check-failed/missing/available）是发现结论。逐个写死、不留 default：
 *   - `idle`（还没开始查）与 `checking`（正在查）→ `unknown`：都是「此刻没有结论」。
 *   - `ready` → `available`，`missing` → `missing`，`error`（catch 分支）→ `check-failed`。
 * 若在每个 list.agents 调用点各内联一次这个 switch，就是第二处会漂移的映射（本仓库被 per-call-site
 * 副本咬过多次）；收成一处、由 tsc 的穷尽性钉住（漏一个 AsyncCheckState 成员就编译不过）。
 */
export function executorAvailabilityFromCheckState(state: AsyncCheckState | undefined): AgentMuxExecutorAvailability {
  switch (state) {
    case 'ready': return 'available'
    case 'missing': return 'missing'
    case 'error': return 'check-failed'
    case 'checking':
    case 'idle':
    case undefined: return 'unknown'
  }
}

const detectionRequestIds = new Map<string, symbol>()
const pendingExecutorDetections = new Map<string, { input: ExecutorDetectionInput; promise: Promise<void> }>()
let startupAvailabilityEpoch = 0
const hostExecutorRequests = new Map<string, symbol>()
const pendingHostExecutorDiscoveries = new Map<string, { input: HostConfig; promise: Promise<void> }>()
const hostCheckRequestIds = new Map<string, number>()
const timelineResyncs = new Map<string, { requested: boolean; reconcileRequested: boolean; hostId: string | undefined; promise: Promise<void> }>()

/**
 * Shared loading/error presentation for worktree and fixed-commit diffs through the existing Git
 * bridge. Blob ownership and old/new direction stay in Main; this owns one transient request token
 * per Region. Close/reconcile invalidates it, and only the latest request may install a reply.
 */
async function loadRegionDiff(
  regionId: string,
  read: (bridge: GitBridge) => Promise<GitFileDiff>
): Promise<void> {
  const requestId = Symbol()
  regionDiffRequestIds.set(regionId, requestId)
  useAppStore.setState((state) => ({
    editorRegionDiffs: {
      ...state.editorRegionDiffs,
      // Keep the previous diff visible during a reload; only flip loading and clear the last error.
      [regionId]: { loading: true, diff: state.editorRegionDiffs[regionId]?.diff ?? null, error: null }
    }
  }))
  const current = (): boolean => regionDiffRequestIds.get(regionId) === requestId
  try {
    const lookup = gitBridge()
    if (!lookup.available) {
      if (!current()) return
      useAppStore.setState((state) => ({
        editorRegionDiffs: {
          ...state.editorRegionDiffs,
          [regionId]: { loading: false, diff: state.editorRegionDiffs[regionId]?.diff ?? null, error: lookup.reason }
        }
      }))
      return
    }
    try {
      const diff = await read(lookup.bridge)
      if (!current()) return
      useAppStore.setState((state) => ({
        editorRegionDiffs: { ...state.editorRegionDiffs, [regionId]: { loading: false, diff, error: null } }
      }))
    } catch (error) {
      if (!current()) return
      useAppStore.setState((state) => ({
        editorRegionDiffs: {
          ...state.editorRegionDiffs,
          // A failed reload keeps the last good diff beside the error rather than blanking the pane.
          [regionId]: { loading: false, diff: state.editorRegionDiffs[regionId]?.diff ?? null, error: presentError(error) }
        }
      }))
    }
  } finally {
    if (regionDiffRequestIds.get(regionId) === requestId) regionDiffRequestIds.delete(regionId)
  }
}

/**
 * Drop editor-region mode/diff state for Regions no longer on the board. The two maps are keyed by
 * regionId, and a file Region's id is deterministic (`region:file:ws:path`), so a closed-then-reopened
 * file would otherwise resurrect its stale `diff` mode and its old diff payload — the opposite of the
 * decision that diff is transient and reopening returns to edit. Called after every close/reconcile that
 * changes the live tab set; a no-op when nothing was pruned so it never forces a spurious render.
 */
function pruneEditorRegionState(tabs: Readonly<Record<string, WorkbenchTab>>): void {
  const live = new Set(
    Object.values(tabs).flatMap((tab) => workbenchSurfaces(tab).map((surface) => surface.regionId))
  )
  for (const regionId of regionDiffRequestIds.keys()) {
    if (!live.has(regionId)) regionDiffRequestIds.delete(regionId)
  }
  useAppStore.setState((state) => {
    const modes = Object.fromEntries(
      Object.entries(state.editorRegionModes).filter(([regionId]) => live.has(regionId))
    )
    const diffs = Object.fromEntries(
      Object.entries(state.editorRegionDiffs).filter(([regionId]) => live.has(regionId))
    )
    const modesChanged = Object.keys(modes).length !== Object.keys(state.editorRegionModes).length
    const diffsChanged = Object.keys(diffs).length !== Object.keys(state.editorRegionDiffs).length
    if (!modesChanged && !diffsChanged) return state
    return { editorRegionModes: modes, editorRegionDiffs: diffs }
  })
}

const noteInputTails = new Map<string, Promise<void>>()
/** Local Steps can arrive while a remote snapshot is still being mapped into this editor. */
async function drainNoteInput(workspaceId: string, path: string): Promise<void> {
  const key = documentKey(workspaceId, path), existing = noteInputTails.get(key)
  if (existing) return existing
  const expected = useAppStore.getState().documents[key]?.noteEditing?.input?.resource
  const lifetime = documentLifetime(key), resource = watchNoteResource(workspaceId, expected ? { hostId: expected.hostId, path: expected.workspacePath } : undefined)
  const operation = (async () => {
    await afterNoteComposition(key)
    while (documentLifetime(key) === lifetime && resource.current()) {
      const before = useAppStore.getState(), document = before.documents[key], input = document?.noteEditing?.input
      if (!document || !input || input.phase !== 'mapping') return
      let failed = { baseContent: input.baseContent, observedContent: input.observedContent, proposedContent: input.proposedContent }
      let merged = await mergeLiveNote(failed.baseContent, failed.observedContent, failed.proposedContent)
      for (const delta of input.queued ?? []) {
        if (merged.status !== 'merged' || useAppStore.getState().documents[key]?.noteEditing?.input !== input) break
        failed = { ...delta, observedContent: merged.content }
        merged = await mergeLiveNote(failed.baseContent, failed.observedContent, failed.proposedContent)
      }
      if (documentLifetime(key) !== lifetime || !resource.current()) return
      if (useAppStore.getState().documents[key]?.noteEditing?.input !== input) continue
      useAppStore.setState(state => {
        const current = state.documents[key]
        if (current?.noteEditing?.input !== input) return state
        const issues = { ...state.documentIssues }, content = merged.status === 'merged' ? merged.content : current.content
        if (merged.status === 'merged') {
          if (issues[key]?.kind === 'changed' && issues[key].noteMerge) delete issues[key]
        } else issues[key] = { kind: 'changed', observed: { path, content: failed.observedContent, revision: current.revision },
          noteMerge: { baseContent: failed.baseContent, proposedContent: failed.proposedContent,
            ...(failed.proposedContent !== current.content ? { earlierInput: true as const } : {}),
            ...(noteHistoryRevision(failed.observedContent) !== current.revision ? { observedIsDraft: true as const } : {}), reason: merged.status === 'unavailable' ? merged.message : 'This input overlaps a newer draft. Both versions and your original input are retained.' } }
        const drafts = [...state.retainedDocumentDrafts[key] ?? []]
        if (merged.status !== 'merged') for (const raw of [input.observedContent, input.proposedContent, ...input.queued?.map(delta => delta.proposedContent) ?? [], failed.observedContent]) {
          if (raw !== content && !drafts.some(draft => draft.content === raw)) drafts.push({ path, content: raw, revision: current.revision })
        }
        return { ...(merged.status !== 'merged' ? { retainedDocumentDrafts: { ...state.retainedDocumentDrafts, [key]: drafts } } : {}),
          documents: { ...state.documents, [key]: { ...current, content, noteEditing: { ...current.noteEditing,
          input: merged.status === 'merged' ? undefined : { ...input, phase: 'conflict' as const } } } },
          dirtyDocuments: { ...state.dirtyDocuments, [key]: content !== current.noteEditing.baseline?.content },
          documentGenerations: { ...state.documentGenerations, [key]: (state.documentGenerations[key] ?? 0) + 1 }, documentIssues: issues }
      })
    }
  })()
  noteInputTails.set(key, operation)
  try { await operation } finally { resource.release(); if (noteInputTails.get(key) === operation) noteInputTails.delete(key) }
}

function updateNoteInput(tabId: string, content: string, editorBeforeContent: string, regionId?: string): void {
  const state = useAppStore.getState(), surface = fileSurface(state.tabs[tabId], regionId)
  if (!surface) return
  updateNoteFileInput({ workspaceId: surface.workspaceId, path: surface.path }, content, editorBeforeContent)
}
function updateNoteFileInput(surface: { workspaceId: string; path: string }, content: string, editorBeforeContent: string): void {
  const state = useAppStore.getState(), key = documentKey(surface.workspaceId, surface.path), document = state.documents[key]
  if (!document || content === document.content) return
  const pending = document.noteEditing?.input, workspace = state.config?.workspaces.find(item => item.id === surface.workspaceId)
  if (!pending && editorBeforeContent === document.content) { useAppStore.setState(current => reduceFileDocumentContent(current, surface.workspaceId, surface.path, content)); return }
  if (!workspace) { useAppStore.setState(current => reduceFileDocumentContent(current, surface.workspaceId, surface.path, content)); return }
  let input: NoteFileInput
  if (!pending) {
    input = { baseContent: editorBeforeContent, observedContent: document.content, proposedContent: content, phase: 'mapping',
      resource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: surface.path } }
  } else {
    const queued = pending.queued ?? [], tail = queued.at(-1)
    if (tail) {
      const next = tail.proposedContent === editorBeforeContent
        ? [...queued.slice(0, -1), { ...tail, proposedContent: content }]
        : [...queued, { baseContent: editorBeforeContent, proposedContent: content }]
      input = { ...pending, phase: 'mapping', queued: next }
    } else if (pending.proposedContent === editorBeforeContent) {
      input = { ...pending, proposedContent: content, phase: 'mapping' }
    } else {
      input = { ...pending, phase: 'mapping', queued: [{ baseContent: editorBeforeContent, proposedContent: content }] }
    }
  }
  useAppStore.setState(current => {
    const next = reduceFileDocumentContent(current, surface.workspaceId, surface.path, content)
    return { ...next, documents: { ...next.documents, [key]: { ...next.documents[key]!, noteEditing: { ...next.documents[key]!.noteEditing, input } } } }
  })
  void drainNoteInput(surface.workspaceId, surface.path)
}

function readNoteHistoryTarget(tabId: string, regionId: string, noteId: string, allowDeleted: true): Promise<NoteHistoryInspection>
function readNoteHistoryTarget(tabId: string, regionId: string, noteId: string, allowDeleted?: false): Promise<NoteHistoryRead>
async function readNoteHistoryTarget(tabId: string, regionId: string, noteId: string, allowDeleted = false): Promise<NoteHistoryInspection> {
  const state = useAppStore.getState(), tab = state.tabs[tabId], surface = tab?.regions[regionId]
  if (surface?.kind !== 'file') throw Error('The original Note file occurrence is unavailable.')
  const key = documentKey(surface.workspaceId, surface.path), lifetime = documentLifetime(key)
  const params = noteHistoryReadParams(state, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots) ?? [], tabId, regionId)
  let changed = false
  const current = () => {
    try { const latest = useAppStore.getState(); return JSON.stringify(noteHistoryReadParams(latest, scratchTopicsForConfig(latest.config, latest.scratchTopicSnapshots) ?? [], tabId, regionId)) === JSON.stringify(params) }
    catch { return false }
  }
  const release = useAppStore.subscribe((next, previous) => {
    if (next.tabs[tabId] === previous.tabs[tabId] && next.config?.workspaces === previous.config?.workspaces &&
      next.spaceZoneBindings === previous.spaceZoneBindings && next.scratchTopicSnapshots === previous.scratchTopicSnapshots && next.topicCategories === previous.topicCategories) return
    if (!current()) changed = true
  })
  try {
    const observed = await api.files.readPublic(params)
    if (changed || documentLifetime(key) !== lifetime || !current()) throw Error('The original Note resource changed during its history read. The selection and draft are retained.')
    if (allowDeleted) {
      const deleted = confirmDeletedNoteHistoryTarget(params, noteId, observed, surface.path, state.documents[key])
      if (deleted) return deleted
    }
    return confirmNoteHistoryTarget(params, noteId, observed, surface.path)
  } finally { release() }
}

function noteAttemptResourceCurrent(workspaceId: string, path: string, attempt: NoteFileAttempt): boolean {
  const current = useAppStore.getState().config?.workspaces.find(workspace => workspace.id === workspaceId)
  return attempt.resource.workspaceId === workspaceId && attempt.resource.path === path && current?.hostId === attempt.resource.hostId && current.path === attempt.resource.workspacePath
}
/** Observe the exact original resource for one in-flight Note operation, including away-and-back changes. */
function watchNoteResource(workspaceId: string, original: { hostId: string; path: string } | undefined) {
  let changed = !original
  const current = () => {
    const resource = useAppStore.getState().config?.workspaces.find(workspace => workspace.id === workspaceId)
    return !changed && Boolean(original && resource?.hostId === original.hostId && resource.path === original.path)
  }
  const release = useAppStore.subscribe((state, previous) => {
    if (state.config?.workspaces === previous.config?.workspaces) return
    const resource = state.config?.workspaces.find(workspace => workspace.id === workspaceId)
    if (!original || resource?.hostId !== original.hostId || resource.path !== original.path) changed = true
  })
  return { current, release }
}
function noteWrittenMetadata(result: Extract<import('../../shared/contracts').WorkspaceFileWriteResult, { status: 'written' }>): NoteWrittenReceipt {
  const { content: _content, ...receipt } = result
  return receipt
}
/** Advance the original document only after mapping canonical bytes against the latest local draft. */
async function settleNoteWritten(workspaceId: string, path: string, lifetime: number, attempt: NoteFileAttempt,
  result: Extract<import('../../shared/contracts').WorkspaceFileWriteResult, { status: 'written' }>, resourceCurrent = () => true): Promise<void> {
  const key = documentKey(workspaceId, path), receipt = noteWrittenMetadata(result)
  await drainNoteInput(workspaceId, path)
  const original = () => documentLifetime(key) === lifetime && useAppStore.getState().documents[key]?.noteEditing?.attempt?.operationId === attempt.operationId
  const owns = () => original() && resourceCurrent() && noteAttemptResourceCurrent(workspaceId, path, attempt)
  if (!original()) return
  useAppStore.setState(state => ({ documents: { ...state.documents, [key]: { ...state.documents[key]!, noteEditing: {
    ...state.documents[key]!.noteEditing, receipt, attempt: { ...attempt, phase: 'written', written: receipt, ...(result.content !== undefined && noteHistoryRevision(result.content) === result.revision ? { canonical: result.content } : {}) } } } },
    savingDocuments: { ...state.savingDocuments, [key]: false } }))
  if (useAppStore.getState().documents[key]?.noteEditing?.input?.phase === 'conflict' || result.content === undefined) return
  const canonical = result.content
  const canonicalHeader = readNoteMarkdownHeader(canonical)
  if (noteHistoryRevision(canonical) !== result.revision || attempt.noteId !== null && (canonicalHeader.status !== 'valid' || canonicalHeader.noteId !== attempt.noteId)) return
  await afterNoteComposition(key)
  while (owns()) {
    const before = useAppStore.getState(), document = before.documents[key]!, generation = before.documentGenerations[key] ?? 0
    const merged = attempt.retainDraft ? { status: 'conflict' as const } : document.content === attempt.content ? { status: 'merged' as const, content: canonical }
      : await mergeLiveNote(attempt.content, canonical, document.content)
    if (!owns()) return
    if ((useAppStore.getState().documentGenerations[key] ?? 0) !== generation) continue
    let accepted = false
    useAppStore.setState(state => {
      if ((state.documentGenerations[key] ?? 0) !== generation || state.documents[key]?.noteEditing?.attempt?.operationId !== attempt.operationId) return state
      accepted = true
      const current = state.documents[key]!, issue = state.documentIssues[key], issues = { ...state.documentIssues }
      const observed = { path, content: canonical, revision: result.revision, ...(result.noteProvenance ? { noteProvenance: result.noteProvenance } : {}) }
      if (merged.status !== 'merged') issues[key] = { kind: 'changed', observed,
        noteMerge: { baseContent: attempt.content, proposedContent: current.content, reason: merged.status === 'unavailable' ? merged.message : 'The saved content overlaps this later draft or changes a block identity.' } }
      else if (issue?.kind !== 'changed' || issue.observed.revision === result.revision) delete issues[key]
      const content = merged.status === 'merged' ? merged.content : current.content
      const { noteProvenance: _oldProvenance, noteWriteAttribution: _oldAttribution, ...kept } = current
      return { documents: { ...state.documents, [key]: { ...kept, content, revision: result.revision,
        ...(result.noteProvenance ? { noteProvenance: result.noteProvenance } : {}), ...(result.noteAttribution ? { noteWriteAttribution: result.noteAttribution } : {}),
        noteEditing: { baseline: { content: canonical, revision: result.revision }, receipt, ...(current.noteEditing?.shares ? { shares: current.noteEditing.shares } : {}), ...(current.noteEditing?.share ? { share: current.noteEditing.share } : {}), ...(current.noteEditing?.shareUndo ? { shareUndo: current.noteEditing.shareUndo } : {}), ...(current.noteEditing?.shareUndoReceipt ? { shareUndoReceipt: current.noteEditing.shareUndoReceipt } : {}) } } },
        dirtyDocuments: { ...state.dirtyDocuments, [key]: content !== canonical },
        documentGenerations: { ...state.documentGenerations, [key]: generation + 1 }, documentIssues: issues,
        savingDocuments: { ...state.savingDocuments, [key]: false } }
    })
    if (accepted) return
  }
}

/** Watch/read and save receipts share this original document reconciliation boundary. */
async function reconcileNoteRead(workspaceId: string, path: string, lifetime: number, requestId: number,
  result: import('../../shared/contracts').WorkspaceFileReadResult, resourceCurrent = () => true): Promise<boolean> {
  if (!path.endsWith(NOTE_FILE_EXTENSION)) return false
  const key = documentKey(workspaceId, path)
  const owns = () => resourceCurrent() && documentLifetime(key) === lifetime && fileReadRequestIds.get(key) === requestId && Boolean(useAppStore.getState().documents[key])
  await afterNoteComposition(key)
  await drainNoteInput(workspaceId, path)
  if (!owns()) return true
  const pending = useAppStore.getState().documents[key]!.noteEditing?.attempt
  if (pending) {
    if (!noteAttemptResourceCurrent(workspaceId, path, pending)) return true
    if (pending.phase === 'written' && pending.written && pending.canonical !== undefined) {
      await settleNoteWritten(workspaceId, path, lifetime, pending, { ...pending.written, content: pending.canonical }, resourceCurrent)
      if (owns() && !useAppStore.getState().documents[key]?.noteEditing?.attempt && result.status === 'read' && result.document.revision !== pending.written.revision) return reconcileNoteRead(workspaceId, path, lifetime, requestId, result, resourceCurrent)
      return true
    }
    if (pending.phase === 'written' && pending.written && result.status === 'read' && result.document.path === path && result.document.revision === pending.written.revision) {
      await settleNoteWritten(workspaceId, path, lifetime, pending, { ...pending.written, content: result.document.content, ...(result.document.noteProvenance ? { noteProvenance: result.document.noteProvenance } : {}) }, resourceCurrent)
      return true
    }
    const eventId = pending.written?.noteHistory?.eventId ?? (pending.enhanced || pending.action ? pending.operationId : undefined)
    if (pending.target && eventId) {
      try {
        const response = await api.files.historyPublic({ ...pending.target, eventId, includeContent: true })
        if (!owns() || useAppStore.getState().documents[key]?.noteEditing?.attempt?.operationId !== pending.operationId) return true
        if (response.result.status === 'read') {
          const event = response.result.entries.find(entry => entry.eventId === eventId)
          if (event?.status === 'committed' && event.operation !== 'delete' && event.operation === (pending.action?.kind ?? 'edit') && typeof event.content === 'string' && typeof event.revision === 'string' && (!pending.written || pending.written.revision === event.revision)) {
            await settleNoteWritten(workspaceId, path, lifetime, pending, { status: 'written', revision: event.revision, content: event.content,
              noteHistory: { status: 'committed', eventId: event.eventId, batchId: event.batchId, replayed: true },
              ...(event.provenance ? { noteProvenance: { ...event.provenance, status: 'recorded' } } : {}) }, resourceCurrent)
            if (owns() && !useAppStore.getState().documents[key]?.noteEditing?.attempt && result.status === 'read' && result.document.revision !== event.revision) return reconcileNoteRead(workspaceId, path, lifetime, requestId, result, resourceCurrent)
            return true
          }
          if (event?.status === 'not-applied' && pending.phase !== 'written') {
            useAppStore.setState(state => ({ documents: { ...state.documents, [key]: { ...state.documents[key]!, noteEditing: { ...state.documents[key]!.noteEditing, attempt: undefined } } },
              documentIssues: { ...state.documentIssues, [key]: preserveNoteInputConflict(state.documents[key], state.documentIssues[key], { kind: 'write-error', code: 'NOTE_OPERATION_NOT_APPLIED', message: 'The original Note operation was confirmed not applied. Your draft is retained; inspect the current file before a new save.' }) } }))
            return true
          }
        }
      } catch { /* Keep the original operation and current readable document when its history is unavailable. */ }
    }
    // Sending requests can still be running. Current bytes never certify that original operation.
    if (result.status === 'error') useAppStore.setState(state => ({ documentIssues: { ...state.documentIssues, [key]: preserveNoteInputConflict(state.documents[key], state.documentIssues[key], { kind: 'write-unknown',
      code: result.code, message: result.message, checkMessage: result.message, attempted: { content: pending.content, expectedRevision: pending.expectedRevision, generation: pending.generation,
        resource: { hostId: pending.resource.hostId, path: pending.resource.workspacePath } } }) } }))
    return true
  }
  const unresolved = useAppStore.getState().documents[key]!.noteEditing?.input
  if (unresolved?.phase === 'conflict') {
    // A same-revision read cannot settle conflicting unsaved drafts. Keep a later actual
    // saved observation too, without replacing the original three-way comparison.
    if (result.status === 'read' && result.document.path === path && result.document.revision !== useAppStore.getState().documents[key]!.revision) useAppStore.setState(state => {
      const retained = state.retainedDocumentDrafts[key] ?? []
      if (retained.some(document => document.revision === result.document.revision && document.content === result.document.content)) return state
      return { retainedDocumentDrafts: { ...state.retainedDocumentDrafts, [key]: [...retained, result.document] } }
    })
    return true
  }
  if (result.status !== 'read' || result.document.path !== path) return false
  while (owns()) {
    const before = useAppStore.getState(), document = before.documents[key]!, generation = before.documentGenerations[key] ?? 0
    const baseline = document.noteEditing?.baseline
    if (!before.dirtyDocuments[key] || !baseline || baseline.revision !== document.revision || result.document.revision === document.revision) return false
    const merged = await mergeLiveNote(baseline.content, result.document.content, document.content)
    if (!owns()) return true
    if ((useAppStore.getState().documentGenerations[key] ?? 0) !== generation) continue
    let applied = false
    useAppStore.setState(state => {
      if ((state.documentGenerations[key] ?? 0) !== generation || state.documents[key] !== document) return state
      applied = true
      if (merged.status !== 'merged') return { documentIssues: { ...state.documentIssues, [key]: { kind: 'changed', observed: result.document,
        noteMerge: { baseContent: baseline.content, proposedContent: document.content, reason: merged.status === 'unavailable' ? merged.message : 'The current file overlaps this local draft or changes a block identity.' } } },
        documentObservationGenerations: { ...state.documentObservationGenerations, [key]: (state.documentObservationGenerations[key] ?? 0) + 1 } }
      const issues = { ...state.documentIssues }; delete issues[key]
      return { documents: { ...state.documents, [key]: { ...document, ...result.document, content: merged.content,
        noteEditing: { ...document.noteEditing, baseline: { content: result.document.content, revision: result.document.revision } } } },
        dirtyDocuments: { ...state.dirtyDocuments, [key]: merged.content !== result.document.content },
        documentGenerations: { ...state.documentGenerations, [key]: generation + 1 },
        documentObservationGenerations: { ...state.documentObservationGenerations, [key]: (state.documentObservationGenerations[key] ?? 0) + 1 }, documentIssues: issues }
    })
    if (applied) return true
  }
  return true
}

async function refreshFileDocument(
  workspaceId: string,
  path: string,
  expectedLifetime = documentLifetime(documentKey(workspaceId, path))
): Promise<void> {
  const key = documentKey(workspaceId, path)
  if (documentLifetime(key) !== expectedLifetime || !useAppStore.getState().documents[key]) return
  const requestId = (fileReadRequestIds.get(key) ?? 0) + 1
  fileReadRequestIds.set(key, requestId)
  const beforeReadIssue = useAppStore.getState().documentIssues[key]
  const checkedWrite = beforeReadIssue?.kind === 'write-unknown' ? beforeReadIssue : undefined
  const noteResource = path.endsWith(NOTE_FILE_EXTENSION) ? watchNoteResource(workspaceId, useAppStore.getState().config?.workspaces.find(workspace => workspace.id === workspaceId)) : null
  fileReadInFlightCounts.set(key, (fileReadInFlightCounts.get(key) ?? 0) + 1)
  // Observe only this pending check. A resource changing away and back cannot authorize its result.
  let resourceChanged = false
  const stopObservingResource = checkedWrite ? useAppStore.subscribe((state, previous) => {
    if (state.config?.workspaces === previous.config?.workspaces) return
    const resource = state.config?.workspaces.find(workspace => workspace.id === workspaceId)
    const original = checkedWrite.attempted.resource
    if (resource?.hostId !== original.hostId || resource.path !== original.path) resourceChanged = true
  }) : () => {}
  try {
    let result: import('../../shared/contracts').WorkspaceFileReadResult
    try {
      if (checkedWrite) {
        const resource = useAppStore.getState().config?.workspaces.find(workspace => workspace.id === workspaceId)
        const original = checkedWrite.attempted.resource
        if (resource?.hostId !== original.hostId || resource.path !== original.path) {
          useAppStore.setState(state => reduceDocumentRead(state, workspaceId, path, {
            status: 'error', code: 'WORKSPACE_FILE_RESOURCE_UNCONFIRMED', message: 'The original workspace resource is not confirmed. Restore it before checking this save.'
          }, checkedWrite))
          return
        }
      }
      result = await api.files.read(workspaceId, path)
      if (checkedWrite) {
        const resource = useAppStore.getState().config?.workspaces.find(workspace => workspace.id === workspaceId)
        const original = checkedWrite.attempted.resource
        if (resourceChanged || resource?.hostId !== original.hostId || resource.path !== original.path) result = {
          status: 'error', code: 'WORKSPACE_FILE_RESOURCE_UNCONFIRMED', message: 'The original workspace resource changed while checking this save. Its outcome remains unconfirmed.'
        }
      }
    } catch (error) {
      result = {
        status: 'error' as const,
        code: typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'WORKSPACE_FILE_READ_FAILED',
        message: presentError(error)
      }
    }
    if (documentLifetime(key) !== expectedLifetime || fileReadRequestIds.get(key) !== requestId) return
    if (noteResource && !noteResource.current()) return
    if (result.status === 'read' && result.document.path !== path) result = { status: 'error', code: 'WORKSPACE_FILE_READ_TARGET_CHANGED', message: 'The read returned another file path. The original document and draft are retained.' }
    if (await reconcileNoteRead(workspaceId, path, expectedLifetime, requestId, result, noteResource?.current)) return
    useAppStore.setState((state) => reduceDocumentRead(state, workspaceId, path, result, checkedWrite))
  } finally {
    stopObservingResource()
    noteResource?.release()
    const remaining = (fileReadInFlightCounts.get(key) ?? 1) - 1
    if (remaining === 0) fileReadInFlightCounts.delete(key)
    else fileReadInFlightCounts.set(key, remaining)
  }
}

/**
 * Attach content to an existing visible File on demand, without opening, moving or revealing it.
 * EditorPane admits visibility; this owner deduplicates reads and preserves original resource,
 * document lifetime and failure facts. Source, preview and Retry use the same FileDocument.
 */
async function loadPersistedFileDocument(workspaceId: string, path: string, resource?: { hostId: string; path: string }): Promise<void> {
  const key = documentKey(workspaceId, path)
  const state = useAppStore.getState()
  if (state.documents[key] || fileOpenRequests.has(key) || state.documentIssues[key]) return
  const original = resource ?? state.config?.workspaces.find(workspace => workspace.id === workspaceId)
  if (!original) {
    useAppStore.setState(state => reduceDocumentLoadFailed(state, workspaceId, path, {
      kind: 'read-error', code: 'WORKSPACE_FILE_RESOURCE_UNAVAILABLE', message: 'The original file Workspace is unavailable.'
    }))
    return
  }
  const originalResource = { hostId: original.hostId, path: original.path }
  let resourceRebound = false, observedConfig = state.config
  let releaseResource = () => {}
  const resourceCurrent = () => {
    const current = useAppStore.getState().config?.workspaces.find(workspace => workspace.id === workspaceId)
    return !resourceRebound && current?.hostId === originalResource.hostId && current.path === originalResource.path
  }
  if (!resourceCurrent()) return
  const openedLifetime = advanceDocumentLifetime(key)
  let observationRequested = false
  const ownsRequest = () => documentLifetime(key) === openedLifetime && fileOpenRequests.get(key) === request
  const admitted = () => ownsRequest() && resourceCurrent() && !useAppStore.getState().documents[key]
  const releaseObservation = async () => {
    // Close/new lifetime already owns disposal. Never dispatch an old unobserve to a new reader.
    if (!ownsRequest() || !observationRequested) return
    observationRequested = false
    await api.files.unobserve(workspaceId, path)
  }
  const request: Promise<boolean> = Promise.resolve().then(async () => {
    try {
      // Invalidation during this read must refresh the attached revision once it has an owner.
      const invalidationSequence = fileInvalidationSequences.get(key) ?? 0
      if (!admitted()) return false
      observationRequested = true
      await api.files.observe(workspaceId, path)
      if (!admitted()) { await releaseObservation(); return false }
      const result = await api.files.read(workspaceId, path)
      if (!admitted()) { await releaseObservation(); return false }
      if (result.status === 'binary') {
        await releaseObservation()
        if (!admitted()) return false
        useAppStore.setState(state => reduceDocumentLoadFailed(state, workspaceId, path, {
          kind: 'binary', revision: result.revision, byteLength: result.byteLength
        }))
        return true
      }
      if (result.status !== 'read') {
        await releaseObservation()
        if (!admitted()) return false
        // Preserve the existing honest issue and its Retry/Reveal routes; do not move the Files dock.
        useAppStore.setState(state => reduceDocumentLoadFailed(state, workspaceId, path,
          result.status === 'deleted'
            ? { kind: 'deleted' }
            : result.status === 'directory'
              ? { kind: 'read-error', code: 'WORKSPACE_FILE_IS_DIRECTORY', message: `Not a file: ${path}` }
              : { kind: 'read-error', code: result.code, message: result.message }))
        return false
      }
      useAppStore.setState(state => reduceDocumentAttached(state, workspaceId, path, result.document))
      // The attached document now owns observation; refresh takes the same in-flight slot.
      releaseResource()
      if (fileOpenRequests.get(key) === request) fileOpenRequests.delete(key)
      if ((fileInvalidationSequences.get(key) ?? 0) !== invalidationSequence) {
        await refreshFileDocument(workspaceId, path, openedLifetime)
      }
      return true
    } catch (error) {
      if (!admitted()) return false
      await releaseObservation().catch(() => undefined)
      if (!admitted()) return false
      useAppStore.setState(state => reduceDocumentLoadFailed(state, workspaceId, path, {
        kind: 'read-error', code: 'WORKSPACE_FILE_READ_FAILED',
        message: error instanceof Error ? error.message : String(error)
      }))
      useAppStore.getState().reportError(error)
      return false
    } finally {
      releaseResource()
      if (fileOpenRequests.get(key) === request) fileOpenRequests.delete(key)
    }
  })
  fileOpenRequests.set(key, request)
  releaseResource = useAppStore.subscribe(state => {
    if (state.config === observedConfig) return
    observedConfig = state.config
    if (resourceCurrent()) return
    resourceRebound = true
    // Dispatch disposal before releasing the slot. Main removes its old observation synchronously
    // and disposes that promise, so a subsequent current read can observe independently.
    void releaseObservation().catch(() => undefined)
    if (fileOpenRequests.get(key) === request) fileOpenRequests.delete(key)
    releaseResource()
  })
  await request
}


type NoteShareAttempt = { params: FileShareParams; writes: Map<string, { workspaceId: string; path: string; lifetime: number; attempt: NoteFileAttempt }>; references: string[] }
/** Known local drafts veto collection; this never claims that the managed file scope is complete. */
function preserveNoteDrafts(state: AppState, destinationKey: string): string[] {
  const ids = new Set<string>()
  for (const key of new Set([...Object.keys(state.documents), ...Object.keys(state.retainedDocumentDrafts)])) {
    const document = state.documents[key]
    const retained = state.retainedDocumentDrafts[key] ?? []
    if (key === destinationKey || !retained.length && !state.dirtyDocuments[key] && !hasNoteComposition(key) && !Object.keys(document?.noteEditing?.shares ?? {}).length && !document?.noteEditing?.input && !document?.noteEditing?.attempt && !document?.noteEditing?.share && !document?.noteEditing?.shareUndo) continue
    const bodies = (draft: FileDocument) => { const editing = draft.noteEditing; return [draft.content, editing?.attempt?.content, editing?.input?.proposedContent, ...(editing?.input?.queued?.map(value => value.proposedContent) ?? []), editing?.share?.params.destination.content, editing?.shareUndo?.params.destination.content] }
    for (const draft of [...(document ? [document] : []), ...retained]) for (const ticket of Object.values(draft.noteEditing?.shares ?? {})) ids.add(ticket.include.noteId)
    const raw = [...(document ? bodies(document) : []), ...retained.flatMap(bodies)]
    for (const content of raw) {
      if (content === undefined) continue
      const header = readNoteMarkdownHeader(content)
      if (header.status === 'valid') ids.add(header.noteId)
      const note = readNoteDocument(content)
      if (note.status !== 'valid') continue
      const visit = (node: import('@tiptap/core').JSONContent) => {
        const target = node.type === 'noteInclude' ? node.attrs?.noteId : node.type === 'blockReference' || node.type === 'noteLink' ? node.attrs?.target?.noteId : undefined
        if (typeof target === 'string') ids.add(target)
        node.content?.forEach(visit)
      }
      visit(note.note.content)
    }
  }
  return [...ids]
}
function unconfirmedNoteShareUndo(params: FileShareUndoParams, error: unknown): FileShareUndoResult {
  return { operationId: params.destination.operationId!, status: 'unknown', destination: null, collections: [], message: presentError(error) }
}
async function applyNoteShareCollections(key: string, result: FileShareUndoResult): Promise<void> {
  for (const collection of result.collections) {
    const source = collection.source
    if (source?.resource && source.result.status === 'written') {
      const resource = source.resource, state = useAppStore.getState(), workspace = state.config?.workspaces.find(value => value.id === resource.workspaceId)
      if (workspace?.hostId === resource.hostId && workspace.path === resource.workspacePath && state.documents[documentKey(resource.workspaceId, resource.path)]) {
        const header = source.result.content === undefined ? null : readNoteMarkdownHeader(source.result.content), eventId = source.result.noteHistory?.eventId
        if (header?.status === 'valid' && eventId && source.result.noteHistory?.status === 'committed') {
          try {
            const prefix = resource.logicalDirectory ?? (resource.zonePath === resource.workspacePath ? '' : resource.zonePath.slice(resource.workspacePath.length + 1))
            const params = { zoneId: resource.zoneId, path: prefix ? resource.path.slice(prefix.length + 1) : resource.path, expectedResource: resource, noteId: header.noteId, eventId, includeContent: true }
            const history = parseFileHistoryResult(await api.files.historyPublic(params), params).result
            const original = history.status === 'read' ? history.entries.find(value => value.eventId === eventId) : undefined
            if (original?.operation === 'undo' && original.status === 'committed' && typeof original.beforeContent === 'string' && original.content === source.result.content && original.revision === source.result.revision) applyNoteDraftRestoreEcho(documentKey(resource.workspaceId, resource.path), original.beforeContent, source.result.content!, collection.noteId)
          } catch { /* The exact saved file remains readable; generic snapshot recovery retains unmatched local input. */ }
        }
        await refreshFileDocument(resource.workspaceId, resource.path)
      }
    }
    if (collection.resource && collection.deletion?.result.status === 'deleted') {
      const resource = collection.resource, state = useAppStore.getState(), workspace = state.config?.workspaces.find(value => value.id === resource.workspaceId)
      if (workspace?.hostId === resource.hostId && workspace.path === resource.workspacePath && state.documents[documentKey(resource.workspaceId, resource.path)]) await refreshFileDocument(resource.workspaceId, resource.path)
    }
  }
  useAppStore.setState(state => {
    const document = state.documents[key]
    if (!document || document.noteEditing?.shareUndo?.params.destination.operationId !== result.operationId && document.noteEditing?.share?.params.destination.operationId !== result.operationId) return state
    const retained = result.collections.flatMap(value => value.retainedReason ? [{ noteId: value.noteId, ...value.retainedReason }] : [])
    const workspaces = new Set([
      ...(result.destination?.result.status === 'written' && result.destination.resource ? [result.destination.resource.workspaceId] : []),
      ...result.collections.flatMap(value => [
        ...(value.source?.result.status === 'written' && value.source.resource ? [value.source.resource.workspaceId] : []),
        ...(value.deletion?.result.status === 'deleted' && value.resource ? [value.resource.workspaceId] : [])
      ])
    ])
    let revisions = state.workspaceFileRevisions
    for (const workspaceId of workspaces) revisions = bumpWorkspaceFileRevision(revisions, workspaceId)
    return { workspaceFileRevisions: revisions, documents: { ...state.documents, [key]: { ...document, noteEditing: { ...document.noteEditing, shareUndoReceipt: { operationId: result.operationId, status: result.status, retained } } } } }
  })
}
async function applyNoteShareUndoResult(key: string, params: FileShareUndoParams, result: FileShareUndoResult): Promise<void> {
  const resource = params.destination.expectedResource, attempt = useAppStore.getState().documents[key]?.noteEditing?.attempt
  const notApplied = (result.status === 'conflict' || result.status === 'error') && result.destination?.result.noteHistory?.status === 'not-applied' && result.destination.result.noteHistory.eventId === params.destination.operationId && result.collections.every(value => value.source === null && value.deletion === null)
  if (attempt && attempt.operationId === params.destination.operationId && result.destination?.result.status === 'written') {
    if (result.destination.result.content !== undefined && result.destination.result.noteHistory?.status === 'committed') for (const collection of result.collections) {
      const restored = collection.source
      if (restored?.result.status === 'written' && restored.result.noteHistory?.eventId === params.destination.operationId && restored.resource?.hostId === resource.hostId && restored.resource.workspaceId === resource.workspaceId && restored.resource.workspacePath === resource.workspacePath && restored.resource.path === resource.path) applyNoteDraftRestoreEcho(key, attempt.content, result.destination.result.content, collection.noteId)
    }
    await settleNoteWritten(resource.workspaceId, resource.path, documentLifetime(key), attempt, result.destination.result, () => noteAttemptResourceCurrent(resource.workspaceId, resource.path, attempt))
    if (result.destination.result.content === undefined) await refreshFileDocument(resource.workspaceId, resource.path)
  }
  await applyNoteShareCollections(key, result)
  useAppStore.setState(state => {
    const document = state.documents[key]
    if (!document?.noteEditing || document.noteEditing.shareUndo?.params.destination.operationId !== params.destination.operationId) return state
    const issues = { ...state.documentIssues }, pending = document.noteEditing.attempt
    if (notApplied) {
      issues[key] = { kind: 'write-error', code: 'NOTE_OPERATION_NOT_APPLIED', message: 'This original reference removal was confirmed not applied. Your complete draft is kept; inspect the current file before saving again.' }
      return { documents: { ...state.documents, [key]: { ...document, noteEditing: { ...document.noteEditing, shareUndo: undefined, ...(pending?.operationId === params.destination.operationId ? { attempt: undefined } : {}) } } }, documentIssues: issues, savingDocuments: { ...state.savingDocuments, [key]: false } }
    }
    if (result.status === 'committed' || result.status === 'partial') {
      if (issues[key]?.kind === 'write-unknown' && issues[key].code === 'NOTE_SHARE_UNDO_UNCONFIRMED') delete issues[key]
      return { documents: { ...state.documents, [key]: { ...document, noteEditing: { ...document.noteEditing, shareUndo: undefined } } }, documentIssues: issues, savingDocuments: { ...state.savingDocuments, [key]: false } }
    }
    issues[key] = { kind: 'write-unknown', code: 'NOTE_SHARE_UNDO_UNCONFIRMED', message: result.message ?? noteShareUndoRecoveryMessage(document.noteEditing), attempted: { content: params.destination.content, expectedRevision: params.destination.expectedRevision, generation: state.documentGenerations[key] ?? 0, resource: { hostId: resource.hostId, path: resource.workspacePath } } }
    return { documents: { ...state.documents, [key]: { ...document, noteEditing: { ...document.noteEditing, ...(pending && pending.operationId === params.destination.operationId && pending.phase === 'sending' ? { attempt: { ...pending, phase: 'unknown' as const } } : {}) } } }, documentIssues: issues, savingDocuments: { ...state.savingDocuments, [key]: false } }
  })
  if (notApplied) {
    const workspace = useAppStore.getState().config?.workspaces.find(value => value.id === resource.workspaceId)
    if (workspace?.hostId === resource.hostId && workspace.path === resource.workspacePath) await refreshFileDocument(resource.workspaceId, resource.path)
  }
}
/** Called inside the existing exact-file save tail, with its already captured draft and public mapping. */
async function submitNoteShareUndo(key: string, attempt: NoteFileAttempt): Promise<boolean> {
  if (!attempt.enhanced || attempt.expectedRevision === null || !attempt.baseContent) return false
  const referenceIds = removedSavedNoteIncludes(attempt.baseContent, attempt.content), target = attempt.target
  if (!referenceIds.length || !target) return false
  const params: FileShareUndoParams = { destination: { zoneId: target.zoneId, ...(target.spaceId ? { spaceId: target.spaceId } : {}), path: target.path, expectedResource: target.expectedResource,
    content: attempt.content, baseContent: attempt.baseContent, expectedRevision: attempt.expectedRevision, operationId: attempt.operationId }, referenceIds, preserveNoteIds: preserveNoteDrafts(useAppStore.getState(), key) }
  useAppStore.setState(state => ({ documents: { ...state.documents, [key]: { ...state.documents[key]!, noteEditing: { ...state.documents[key]!.noteEditing, shareUndo: { params } } } } }))
  let result: FileShareUndoResult
  try { result = parseFileShareUndoResult(await api.files.shareUndoPublic(params), params) }
  catch (error) { result = unconfirmedNoteShareUndo(params, error) }
  await applyNoteShareUndoResult(key, params, result)
  return true
}

// One original unsaved operation, not a second body/relationship store. Its durable receipts live with the Files owner.
const noteShareAttempts = new Map<string, NoteShareAttempt>()
function unconfirmedNoteShare(params: FileShareParams, error: unknown): FileShareResult {
  return { operationId: params.operationId, status: 'unknown', promotions: params.promotions.map(item => ({ operationId: item.operationId, shared: null, source: null })), destination: null, message: presentError(error) }
}
function originalNoteShareAttempt(key: string): NoteShareAttempt | undefined {
  const state = useAppStore.getState(), document = state.documents[key], saved = document?.noteEditing?.share, params = saved?.params
  if (!params) { noteShareAttempts.delete(key); return undefined }
  const held = noteShareAttempts.get(key)
  if (held?.params === params && [...held.writes.values()].every(value => documentLifetime(documentKey(value.workspaceId, value.path)) === value.lifetime)) return held
  const writes = new Map<string, { workspaceId: string; path: string; lifetime: number; attempt: NoteFileAttempt }>()
  for (const write of [...params.promotions.map(item => item.source), params.destination]) {
    const resource = write.expectedResource, id = documentKey(resource.workspaceId, resource.path), attempt = state.documents[id]?.noteEditing?.attempt
    if (attempt) writes.set(id, { workspaceId: resource.workspaceId, path: resource.path, lifetime: documentLifetime(id), attempt })
  }
  const original = { params, writes, references: saved!.references }
  noteShareAttempts.set(key, original); return original
}
async function applyNoteShareResult(key: string, original: NoteShareAttempt, result: FileShareResult): Promise<void> {
  const writes = [...result.promotions.flatMap(item => [item.shared, item.source]), result.destination]
  for (const receipt of writes) {
    if (!receipt?.resource || receipt.result.status !== 'written') continue
    const resource = receipt.resource, currentKey = documentKey(resource.workspaceId, resource.path), held = original.writes.get(currentKey)
    if (held) {
      const promoted = original.params.promotions.filter(value => value.source.expectedResource.workspaceId === resource.workspaceId && value.source.expectedResource.path === resource.path)
      if (receipt.result.content && noteAttemptResourceCurrent(held.workspaceId, held.path, held.attempt)) applyNoteDraftShareEcho(currentKey, held.attempt.content, receipt.result.content, promoted.map(value => value.sourceBlockId))
      await settleNoteWritten(held.workspaceId, held.path, held.lifetime, held.attempt, receipt.result, () => noteAttemptResourceCurrent(held.workspaceId, held.path, held.attempt))
      if (receipt.result.content === undefined) await refreshFileDocument(held.workspaceId, held.path, held.lifetime)
    }
  }
  if (result.undo) await applyNoteShareCollections(key, result.undo)
  if (result.status === 'error' && result.code === 'NOTE_SHARE_RANGE_UNSUPPORTED' && !result.undo && writes.every(receipt => receipt === null) &&
      [...original.writes.values()].every(held => held.attempt.phase === 'sending' &&
        useAppStore.getState().documents[documentKey(held.workspaceId, held.path)]?.noteEditing?.attempt === held.attempt)) {
    // Only the same first-send attempts and the owner's prepublication rejection
    // release this send. A retained unknown or previously applied phase stays fenced.
    noteShareAttempts.delete(key)
    useAppStore.setState(state => {
      const documents = { ...state.documents }, saving = { ...state.savingDocuments }
      for (const [id, held] of original.writes) {
        const current = documents[id]
        if (current?.noteEditing?.attempt === held.attempt) documents[id] = { ...current, noteEditing: { ...current.noteEditing, attempt: undefined } }
        saving[id] = false
      }
      const destination = documents[key], message = result.message ?? 'This sharing range was not published. Your source, draft and original request are kept.'
      if (destination?.noteEditing?.share?.params.operationId === original.params.operationId) documents[key] = { ...destination, noteEditing: { ...destination.noteEditing, share: undefined,
        shareRejection: { params: original.params, code: result.code!, message } } }
      return { documents, savingDocuments: saving, documentIssues: { ...state.documentIssues, [key]: { kind: 'write-error', code: result.code!, message } } }
    })
    return
  }
  if (result.status === 'committed' || result.status === 'partial') {
    noteShareAttempts.delete(key); clearPendingNoteShares(key, original.references)
    useAppStore.setState(state => {
      const issues = { ...state.documentIssues }
      if (issues[key]?.kind === 'write-unknown' && issues[key].code === 'NOTE_SHARE_UNCONFIRMED') delete issues[key]
      const workspaceIds = new Set([...original.writes.values()].map(value => value.workspaceId))
      let revisions = state.workspaceFileRevisions
      for (const workspaceId of workspaceIds) revisions = bumpWorkspaceFileRevision(revisions, workspaceId)
      const document = state.documents[key], documents = document?.noteEditing?.share?.params.operationId === original.params.operationId ? { ...state.documents, [key]: { ...document, noteEditing: { ...document.noteEditing, share: undefined } } } : state.documents
      return { documents, documentIssues: issues, workspaceFileRevisions: revisions, savingDocuments: { ...state.savingDocuments, [key]: false } }
    })
    return
  }
  // A partial cross-file result must never be reported as an ordinary host save or silently replayed.
  useAppStore.setState(state => {
    const documents = { ...state.documents }
    for (const [id, held] of original.writes) {
      const document = documents[id], attempt = document?.noteEditing?.attempt
      if (attempt?.operationId === held.attempt.operationId && attempt.phase === 'sending') documents[id] = { ...document!, noteEditing: { ...document!.noteEditing, attempt: { ...attempt, phase: 'unknown' } } }
    }
    return { documents, savingDocuments: { ...state.savingDocuments, ...Object.fromEntries([...original.writes.keys()].map(id => [id, false])) }, documentIssues: { ...state.documentIssues,
    [key]: { kind: 'write-unknown', code: 'NOTE_SHARE_UNCONFIRMED', message: result.message ?? (result.undo?.status === 'partial' ? noteShareUndoRecoveryMessage(documents[key]?.noteEditing ?? {}) : 'Sharing is not fully confirmed. The original content and operation are kept. Check this same sharing operation before continuing.'),
      attempted: { content: original.params.destination.content, expectedRevision: original.params.destination.expectedRevision,
        generation: state.documentGenerations[key] ?? 0, resource: { hostId: original.params.destination.expectedResource.hostId, path: original.params.destination.expectedResource.workspacePath } } } } }
  })
}
async function enqueueNoteShareSave(tabId: string, regionId?: string, explicit?: NoteFileTarget, overwrite = false, ancestors: ReadonlySet<string> = new Set(), explicitRead?: import('@agentmux/core/files').FileReadParams): Promise<boolean> {
  const initial = useAppStore.getState(), surface = explicit ?? fileSurface(initial.tabs[tabId], regionId)
  if (!surface) return false
  const key = documentKey(surface.workspaceId, surface.path), retained = originalNoteShareAttempt(key)
  if (retained) { await useAppStore.getState().inspectNoteShare(surface.workspaceId, surface.path); return true }
  const settled = promotedPendingNoteShares(key)
  if (settled.length) clearPendingNoteShares(key, settled)
  const tickets = pendingNoteShares(key), note = initial.documents[key] ? readNoteDocument(initial.documents[key]!.content) : null
  if (note?.status !== 'valid') return false
  const surviving = new Set<string>()
  const collect = (node: import('@tiptap/core').JSONContent) => { if (node.type === 'noteInclude' && tickets.has(node.attrs?.referenceId)) surviving.add(node.attrs!.referenceId as string); node.content?.forEach(collect) }; collect(note.note.content)
  const selected = [...surviving].map(id => tickets.get(id)!)
  if (!selected.length) return false
  // Resolve retained uses inside the exact source chapter before reserving save tails.
  // Otherwise the outer shared file could persist an include whose file does not exist.
  try {
    for (const ticket of selected) {
      const path = new Set([...ancestors, ticket.operationId])
      const source = ticket.copy.source, sourceKey = documentKey(source.workspaceId, source.path)
      await useAppStore.getState().loadNoteFile(source)
      await drainNoteInput(source.workspaceId, source.path)
      const document = useAppStore.getState().documents[sourceKey], parsed = document ? readNoteDocument(document.content) : null
      const workspace = useAppStore.getState().config?.workspaces.find(value => value.id === source.workspaceId)
      if (parsed?.status !== 'valid' || parsed.note.noteId !== source.noteId || workspace?.hostId !== source.hostId || workspace.path !== source.workspacePath) throw Error('The original nested sharing source identity is unconfirmed. Its complete draft is kept; restore that exact source before saving.')
      const nodes = ticket.copy.block.blockId ? noteShareRange(parsed.note.content, ticket.copy.block.blockId)?.nodes
        : (() => { const parent = noteNodeAtPath(parsed.note.content, ticket.copy.block.path.slice(0, -1)), index = ticket.copy.block.path.at(-1), node = index === undefined ? undefined : parent?.content?.[index]; return parent && index !== undefined && node && noteBlockFingerprint(node) === ticket.copy.block.fingerprint ? noteShareSiblingRange(parent, index) : undefined })()
      const nested = pendingNoteShares(sourceKey), dependencies = new Set<string>()
      const visit = (node: import('@tiptap/core').JSONContent) => { if (node.type === 'noteInclude' && nested.has(node.attrs?.referenceId)) dependencies.add(String(node.attrs!.referenceId)); node.content?.forEach(visit) }
      nodes?.forEach(visit)
      if (!dependencies.size) continue
      if ([...dependencies].some(reference => path.has(nested.get(reference)!.operationId))) throw Error('This pending chapter contains its own shared use. Your draft is kept; move that use outside the chapter or undo it before saving.')
      await enqueueNoteShareSave('', undefined, source, false, path, ticket.copy.read)
      if ([...dependencies].some(reference => pendingNoteShares(sourceKey).has(reference))) throw Error('An inner shared source still needs confirmation. Your complete draft is kept; check that original sharing operation before saving this outer use.')
      // Inner receipts changed the original file and may have replaced its structure.
      return await enqueueNoteShareSave(tabId, regionId, explicit, overwrite, ancestors, explicitRead)
    }
  } catch (error) {
    useAppStore.getState().reportError(error)
    useAppStore.setState(state => reduceDocumentWriteError(state, surface.workspaceId, surface.path, 'NOTE_SHARE_DEPENDENCY_UNCONFIRMED', presentError(error)))
    return true
  }
  const keys = [...new Set([key, ...selected.map(ticket => documentKey(ticket.copy.source.workspaceId, ticket.copy.source.path))])]
  const waits = keys.map(id => fileSaveTails.get(id) ?? Promise.resolve())
  const operation = (async () => {
    await Promise.all(waits.map(wait => wait.catch(() => {})))
    await Promise.all(keys.map(async id => { const separator = id.indexOf('\0'); await drainNoteInput(id.slice(0, separator), id.slice(separator + 1)) }))
    const state = useAppStore.getState(), currentSurface = explicit ?? fileSurface(state.tabs[tabId], regionId)
    if (!currentSurface || documentKey(currentSurface.workspaceId, currentSurface.path) !== key) throw Error('The original destination changed. Its pending sharing draft is kept.')
    const document = state.documents[key], currentRead = document ? readNoteDocument(document.content) : null
    if (!document || currentRead?.status !== 'valid') throw Error('The original destination is unavailable. Its pending sharing draft is kept.')
    const references = new Set<string>(), visit = (node: import('@tiptap/core').JSONContent) => { if (node.type === 'noteInclude') references.add(String(node.attrs?.referenceId)); node.content?.forEach(visit) }; visit(currentRead.note.content)
    const active = selected.filter(ticket => references.has(ticket.include.referenceId))
    if (!active.length) return
    const selectedReferences = new Set(active.map(ticket => ticket.include.referenceId)), latestTickets = pendingNoteShares(key)
    if ([...references].some(id => latestTickets.has(id) && !selectedReferences.has(id))) throw Error('A later shared use arrived while this save was waiting. Your complete draft is kept; save again to share these uses together.')
    const topics = scratchTopicsForConfig(state.config, state.scratchTopicSnapshots) ?? []
    const destinationRead = explicitRead ?? (explicit ? noteResourceReadParams(state, topics, explicit) : noteHistoryReadParams(state, topics, tabId, regionId ?? fileSurface(state.tabs[tabId])!.regionId))
    if (!destinationRead) throw Error('The original Note mapping is unconfirmed. The pending sharing draft is kept.')
    const proposals = new Map<string, { content: string; generation: number }>()
    const prepare = async (read: import('@agentmux/core/files').FileReadParams, workspaceId: string, path: string, noteId: string): Promise<FileWriteParams> => {
      // Freeze the submitted draft before asynchronous observation. Later input belongs
      // to the existing dirty document and is reconciled after this original receipt.
      const document = state.documents[documentKey(workspaceId, path)]
      const observed = await api.files.readPublic(read)
      const workspace = state.config?.workspaces.find(value => value.id === workspaceId)
      if (!observed.resource || !workspace || observed.resource.workspaceId !== workspaceId || observed.resource.hostId !== workspace.hostId || observed.resource.workspacePath !== workspace.path || observed.resource.path !== path || observed.result.status !== 'read') throw Error('The original sharing file could not be confirmed at its exact Workspace resource. Its current draft is kept.')
      const original = document ?? observed.result.document
      proposals.set(documentKey(workspaceId, path), { content: original.content, generation: state.documentGenerations[documentKey(workspaceId, path)] ?? 0 })
      const header = readNoteMarkdownHeader(original.content)
      if (header.status !== 'valid' || header.noteId !== noteId) throw Error('The original sharing file identity changed. Its draft is kept.')
      const conflict = overwrite && documentKey(workspaceId, path) === key ? state.documentIssues[key] : undefined
      if (overwrite && documentKey(workspaceId, path) === key && conflict?.kind !== 'changed') throw Error('The current file conflict is not confirmed. Your pending uses and draft are kept; inspect this original file before overwriting it.')
      const overwritten = conflict?.kind === 'changed' ? conflict.observed : undefined
      if (overwritten && observed.result.document.revision !== overwritten.revision) throw Error('The observed file changed again before overwrite. Its pending uses and complete draft are kept; inspect the new current version.')
      const baseline = overwritten ?? (document?.noteEditing?.baseline?.revision === original.revision ? document.noteEditing.baseline : observed.result.document.revision === original.revision ? observed.result.document : undefined)
      if (!baseline || noteHistoryRevision(baseline.content) !== (overwritten?.revision ?? original.revision)) throw Error('The original sharing baseline is unconfirmed. Its draft and current file are kept.')
      return { ...read, expectedResource: observed.resource, content: original.content, expectedRevision: overwritten?.revision ?? original.revision, baseContent: baseline.content, operationId: mintObjectId() }
    }
    const destination = await prepare(destinationRead, surface.workspaceId, surface.path, currentRead.note.noteId)
    const params: FileShareParams = { operationId: mintObjectId(), destination, promotions: [] }
    const removed = removedSavedNoteIncludes(destination.baseContent!, destination.content)
    if (removed.length) { params.undoReferenceIds = removed; params.preserveNoteIds = preserveNoteDrafts(state, key) }
    const sourceWrites = new Map<string, FileWriteParams>()
    for (const ticket of active) {
      if (params.promotions.some(value => value.operationId === ticket.operationId)) continue
      if (!ticket.copy.read) throw Error('The original shared reference mapping is unavailable. Its draft is kept.')
      const source = ticket.copy.source, sourceKey = documentKey(source.workspaceId, source.path)
      let write = sourceWrites.get(sourceKey)
      if (!write) { write = await prepare(ticket.copy.read, source.workspaceId, source.path, source.noteId); sourceWrites.set(sourceKey, write) }
      const parsed = readNoteDocument(write.content)
      if (parsed.status !== 'valid') throw Error('The source Markdown cannot currently be shared. Its content is kept.')
      let block = ticket.copy.block.blockId ? undefined : noteNodeAtPath(parsed.note.content, ticket.copy.block.path)
      if (ticket.copy.block.blockId) {
        const find = (node: import('@tiptap/core').JSONContent) => { if (node.attrs?.blockId === ticket.copy.block.blockId) block = node; node.content?.forEach(find) }; find(parsed.note.content)
      }
      if (!block || !ticket.copy.block.blockId && noteBlockFingerprint(block) !== ticket.copy.block.fingerprint) throw Error('The copied source content changed before sharing. Your Note is kept; copy its current content again.')
      if (!block.attrs?.blockId) {
        block.attrs = { ...block.attrs, blockId: mintObjectId() }
        bindNoteDraftBlockIdentity(sourceKey, ticket.copy.block.path, ticket.copy.block.fingerprint, String(block.attrs.blockId))
      }
      write.content = serializeNoteDocument(parsed.note)
      const proposal = proposals.get(sourceKey)!
      useAppStore.setState(current => current.documents[sourceKey]?.content === proposal.content ? reduceFileDocumentContent(current, source.workspaceId, source.path, write!.content) : current)
      proposals.set(sourceKey, { content: write.content, generation: useAppStore.getState().documentGenerations[sourceKey] ?? 0 })
      const prefix = ticket.copy.read.path.slice(0, Math.max(0, ticket.copy.read.path.lastIndexOf('/') + 1)), leaf = ticket.include.path.slice(ticket.include.path.lastIndexOf('/') + 1)
      const sharedRead = { ...ticket.copy.read, path: prefix + leaf }, shared = await api.files.readPublic(sharedRead)
      if (!shared.resource || shared.resource.path !== ticket.include.path) throw Error('The shared file destination mapping is unconfirmed. The pending draft is kept.')
      params.promotions.push({ operationId: ticket.operationId, source: write, sourceNoteId: source.noteId, sourceBlockId: String(block.attrs!.blockId), referenceId: ticket.include.referenceId,
        shared: { ...sharedRead, expectedResource: shared.resource, noteId: ticket.include.noteId } })
    }
    if (sourceWrites.has(key)) destination.content = sourceWrites.get(key)!.content
    const attempt: NoteShareAttempt = { params, writes: new Map(), references: active.map(ticket => ticket.include.referenceId) }
    for (const [resourceKey, write] of [...sourceWrites, [key, destination] as const]) {
      const current = useAppStore.getState().documents[resourceKey], workspaceId = write.expectedResource.workspaceId, path = write.expectedResource.path
      if (!current) continue
      if (current.noteEditing?.attempt) throw Error('An original sharing file still has an unresolved save. Its draft and operation are kept; check it before sharing.')
      const header = readNoteMarkdownHeader(write.content), local: NoteFileAttempt = { operationId: resourceKey === key ? destination.operationId! : fileShareSourceOperation(params, write),
        noteId: header.status === 'valid' ? header.noteId : null, content: proposals.get(resourceKey)?.content ?? write.content, baseContent: write.baseContent!, enhanced: true, expectedRevision: write.expectedRevision,
        generation: proposals.get(resourceKey)?.generation ?? 0, resource: { hostId: write.expectedResource.hostId, workspaceId, workspacePath: write.expectedResource.workspacePath, path }, phase: 'sending' }
      attempt.writes.set(resourceKey, { workspaceId, path, lifetime: documentLifetime(resourceKey), attempt: local })
    }
    noteShareAttempts.set(key, attempt)
    useAppStore.setState(state => {
      const documents = { ...state.documents }, saving = { ...state.savingDocuments }
      for (const [id, held] of attempt.writes) { documents[id] = { ...documents[id]!, noteEditing: { ...documents[id]!.noteEditing, attempt: held.attempt } }; saving[id] = true }
      documents[key] = { ...documents[key]!, noteEditing: { ...documents[key]!.noteEditing, share: { params, references: attempt.references } } }
      return { documents, savingDocuments: saving }
    })
    let result: FileShareResult
    try { result = parseFileShareResult(await api.files.sharePublic(params), params) }
    catch (error) { result = unconfirmedNoteShare(params, error) }
    await applyNoteShareResult(key, attempt, result)
  })()
  const tail = operation.then(() => {}, () => {})
  keys.forEach(id => fileSaveTails.set(id, tail))
  try { await operation } catch (error) {
    useAppStore.getState().reportError(error)
    useAppStore.setState(state => reduceDocumentWriteError(state, surface.workspaceId, surface.path, 'NOTE_SHARE_PREPARATION_FAILED', presentError(error)))
  }
  finally { keys.forEach(id => { if (fileSaveTails.get(id) === tail) fileSaveTails.delete(id) }) }
  return true
}

async function enqueueFileSave(
  tabId: string,
  overwrite: boolean,
  regionId?: string,
  target?: NoteFileTarget
): Promise<void> {
  const initialTab = useAppStore.getState().tabs[tabId]
  const initialSurface = target ?? fileSurface(initialTab, regionId)
  if (!initialSurface) return
  const key = documentKey(initialSurface.workspaceId, initialSurface.path)
  if (useAppStore.getState().documents[key]?.noteEditing?.shareUndo) { await useAppStore.getState().inspectNoteShareUndo(initialSurface.workspaceId, initialSurface.path); return }
  if (pendingNoteShares(key).size || originalNoteShareAttempt(key)) {
    if (await enqueueNoteShareSave(tabId, regionId, target, overwrite)) return
  }
  const queuedLifetime = documentLifetime(key)
  const previous = fileSaveTails.get(key) ?? Promise.resolve()
  const mutation = workspaceFileMutationTails.get(initialSurface.workspaceId) ?? Promise.resolve()
  const operation = Promise.all([previous.catch(() => {}), mutation.catch(() => {})]).then(async () => {
    await drainNoteInput(initialSurface.workspaceId, initialSurface.path)
    const state = useAppStore.getState()
    const tab = state.tabs[tabId]
    const surface = target ?? fileSurface(tab, regionId)
    if (!surface) return
    const currentKey = documentKey(surface.workspaceId, surface.path)
    const configuredResource = state.config?.workspaces.find(workspace => workspace.id === surface.workspaceId)
    const targetHeader = readNoteMarkdownHeader(state.documents[currentKey]?.content ?? '')
    if (target && (configuredResource?.hostId !== target.hostId || configuredResource.path !== target.workspacePath || targetHeader.status !== 'valid' || targetHeader.noteId !== target.noteId)) {
      state.reportError(new Error('The original shared file resource or identity changed. Its draft is retained; check that original file before saving.')); return
    }
    // A stable Tab can outlive its file target. Never redirect a queued save to another resource or lifetime.
    if (currentKey !== key || documentLifetime(key) !== queuedLifetime) {
      state.reportError(Object.assign(new Error(
        `The queued save for ${initialSurface.path} was cancelled because its file target changed. No write was sent; save the current file to continue.`
      ), { code: 'WORKSPACE_FILE_SAVE_TARGET_CHANGED' }))
      return
    }
    const format = workspaceFilePreviewFormat(surface.path)
    if (format && !format.sourceEditable) return
    const document = state.documents[currentKey]
    const savedResource = state.config?.workspaces.find(workspace => workspace.id === surface.workspaceId)
    const issue = state.documentIssues[currentKey]
    if (document?.noteEditing?.input?.phase === 'conflict' && !overwrite) return
    if (document?.noteEditing?.attempt) { await refreshFileDocument(surface.workspaceId, surface.path, queuedLifetime); return }
    if (issue?.kind === 'write-unknown') return
    if (!document) return
    const hasOverwriteConflict = overwrite && (issue?.kind === 'changed' || issue?.kind === 'deleted')
    if (!state.dirtyDocuments[currentKey] && !hasOverwriteConflict) return
    if (!overwrite && (issue?.kind === 'changed' || issue?.kind === 'deleted' || issue?.kind === 'read-error')) return
    if (overwrite && issue?.kind !== 'changed' && issue?.kind !== 'deleted') return
    if (!savedResource) {
      useAppStore.setState(current => reduceDocumentWriteError(current, surface.workspaceId, surface.path,
        'WORKSPACE_FILE_RESOURCE_UNCONFIRMED', 'The original workspace is unavailable. Restore it before saving this draft.'))
      return
    }
    const resourceWatch = surface.path.endsWith(NOTE_FILE_EXTENSION) ? watchNoteResource(surface.workspaceId, savedResource) : null
    try {
    const generation = state.documentGenerations[currentKey] ?? 0
    const observationGeneration = state.documentObservationGenerations[currentKey] ?? 0
    const savedLifetime = documentLifetime(currentKey)
    let expectedRevision: string | null = document.revision
    if (overwrite) expectedRevision = issue?.kind === 'changed' ? issue.observed.revision : null
    const header = surface.path.endsWith(NOTE_FILE_EXTENSION) ? readNoteMarkdownHeader(document.content) : undefined
    let noteAttempt: NoteFileAttempt | undefined
    if (surface.path.endsWith(NOTE_FILE_EXTENSION)) {
      const baseline = overwrite && issue?.kind === 'changed' ? { content: issue.observed.content, revision: issue.observed.revision }
        : document.noteEditing?.baseline ?? (noteHistoryRevision(document.content) === document.revision ? { content: document.content, revision: document.revision } : undefined)
      const baseContent = baseline?.revision === expectedRevision && noteHistoryRevision(baseline.content) === expectedRevision ? baseline.content : undefined
      const enhanced = baseContent !== undefined && readNoteDocument(baseContent).status === 'valid' && readNoteDocument(document.content).status === 'valid'
      noteAttempt = { operationId: mintObjectId(), noteId: header?.status === 'valid' ? header.noteId : null, content: document.content, expectedRevision, generation,
        resource: { hostId: savedResource.hostId, workspaceId: savedResource.id, workspacePath: savedResource.path, path: surface.path }, phase: 'sending',
        ...(baseContent === undefined ? {} : { baseContent }), ...(enhanced ? { enhanced: true } : {}) }
      const originalRegion = target ? undefined : fileSurface(tab, regionId)?.regionId
      try {
        if (noteAttempt.noteId !== null && originalRegion) noteAttempt.target = (await readNoteHistoryTarget(tabId, originalRegion, noteAttempt.noteId)).target
        else if (noteAttempt.noteId !== null && target) {
          const read = noteResourceReadParams(state, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots) ?? [], target)
          noteAttempt.target = confirmNoteHistoryTarget(read, noteAttempt.noteId, await api.files.readPublic(read), surface.path).target
        }
      }
      catch { /* History discovery is independent; an unavailable observation cannot remove ordinary Files saving. */ }
      if (documentLifetime(currentKey) !== savedLifetime || !resourceWatch?.current() || !noteAttemptResourceCurrent(surface.workspaceId, surface.path, noteAttempt)) return
      const captured = noteAttempt
      useAppStore.setState(current => ({ documents: { ...current.documents, [currentKey]: { ...current.documents[currentKey]!,
        noteEditing: { ...current.documents[currentKey]!.noteEditing, attempt: captured } } } }))
    }
    useAppStore.setState((current) => reduceDocumentSaving(current, surface.workspaceId, surface.path, true))
    if (!overwrite && noteAttempt && await submitNoteShareUndo(currentKey, noteAttempt)) return
    const undoMappingUnavailable = !overwrite && noteAttempt?.enhanced && Boolean(noteAttempt.baseContent) && !noteAttempt.target && removedSavedNoteIncludes(noteAttempt.baseContent!, noteAttempt.content).length > 0
    let result
    try {
      result = await api.files.write(surface.workspaceId, {
        path: surface.path,
        content: document.content,
        expectedRevision,
        ...(noteAttempt?.enhanced ? { baseContent: noteAttempt.baseContent!, operationId: noteAttempt.operationId } : {})
      })
    } catch (error) {
      result = {
        status: 'unknown' as const,
        code: typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'WORKSPACE_FILE_WRITE_FAILED',
        message: presentError(error)
      }
    }
    if (documentLifetime(currentKey) !== savedLifetime || !useAppStore.getState().documents[currentKey]) return
    if (result.status === 'written') {
      if (noteAttempt) {
        const canonical = result.content !== undefined ? result.content
          : !result.contentUnavailable && noteHistoryRevision(document.content) === result.revision ? document.content : undefined
        await settleNoteWritten(surface.workspaceId, surface.path, savedLifetime, noteAttempt, { ...result, ...(canonical === undefined ? {} : { content: canonical }) }, resourceWatch?.current)
        if (undoMappingUnavailable) useAppStore.setState(current => current.documents[currentKey] ? { documents: { ...current.documents, [currentKey]: { ...current.documents[currentKey]!, noteEditing: { ...current.documents[currentKey]!.noteEditing,
          shareUndoReceipt: { operationId: noteAttempt.operationId, retained: [{ code: 'mapping-unconfirmed', message: 'The saved reference was removed. Shared-file cleanup was not checked: the original file mapping is unconfirmed.' }] } } } } } : current)
        void useAppStore.getState().invalidateScratchTopicPaths(surface.workspaceId, [surface.path])
        await refreshFileDocument(surface.workspaceId, surface.path, savedLifetime)
        return
      }
      const receiptState = useAppStore.getState()
      const needsReconciliation =
        (fileReadInFlightCounts.get(currentKey) ?? 0) > 0 ||
        (receiptState.documentObservationGenerations[currentKey] ?? 0) !== observationGeneration
      fileReadRequestIds.set(currentKey, (fileReadRequestIds.get(currentKey) ?? 0) + 1)
      useAppStore.setState((current) => {
        const next = reduceDocumentWritten(
          current,
          surface.workspaceId,
          surface.path,
          generation,
          result.revision,
          expectedRevision,
          observationGeneration,
          result.content,
          result.noteAttribution,
          result.noteProvenance
        )
        return 'kind' in surface && isScratchTopicDocument(surface)
          ? {
              ...next,
              workspaceFileRevisions: bumpWorkspaceFileRevision(
                current.workspaceFileRevisions,
                surface.workspaceId
              )
            }
          : next
      })
      void useAppStore.getState().invalidateScratchTopicPaths(surface.workspaceId, [surface.path])
      if (needsReconciliation) await refreshFileDocument(surface.workspaceId, surface.path, savedLifetime)
      return
    }
    if (result.status === 'unknown') {
      useAppStore.setState(current => ({ savingDocuments: { ...current.savingDocuments, [currentKey]: false },
        ...(noteAttempt ? { documents: { ...current.documents, [currentKey]: { ...current.documents[currentKey]!,
          noteEditing: { ...current.documents[currentKey]!.noteEditing, attempt: { ...noteAttempt, phase: 'unknown' as const } } } } } : {}),
        documentIssues: { ...current.documentIssues, [currentKey]: preserveNoteInputConflict(current.documents[currentKey], current.documentIssues[currentKey], { kind: 'write-unknown', code: result.code, message: result.message,
          attempted: { content: document.content, expectedRevision, generation,
            resource: { hostId: savedResource.hostId, path: savedResource.path } } }) } }))
      return
    }
    if (noteAttempt) useAppStore.setState(current => ({ documents: { ...current.documents, [currentKey]: { ...current.documents[currentKey]!,
      noteEditing: { ...current.documents[currentKey]!.noteEditing, attempt: undefined } } } }))
    if (result.status === 'error') {
      useAppStore.setState((current) => reduceDocumentWriteError(current, surface.workspaceId, surface.path, result.code, result.message))
      return
    }
    useAppStore.setState((current) => reduceDocumentSaving(current, surface.workspaceId, surface.path, false))
    await refreshFileDocument(surface.workspaceId, surface.path, savedLifetime)
    } finally { resourceWatch?.release() }
  })
  const tail = operation.then(() => {}, () => {})
  fileSaveTails.set(key, tail)
  try {
    await operation
  } finally {
    if (fileSaveTails.get(key) === tail) fileSaveTails.delete(key)
  }
}

/** Historical actions join the same file/save and Workspace mutation tails as ordinary editing. */
async function enqueueNoteHistoryAction(tabId: string, regionId: string, selection: NoteHistorySelection): Promise<void> {
  const selected = structuredClone(selection), initial = fileSurface(useAppStore.getState().tabs[tabId], regionId)
  if (!initial) throw Error('The original Note file occurrence is unavailable.')
  const key = documentKey(initial.workspaceId, initial.path), lifetime = documentLifetime(key)
  const previous = fileSaveTails.get(key) ?? Promise.resolve(), mutation = workspaceFileMutationTails.get(initial.workspaceId) ?? Promise.resolve()
  const operation = Promise.all([previous.catch(() => {}), mutation.catch(() => {})]).then(async () => {
    await drainNoteInput(initial.workspaceId, initial.path)
    const state = useAppStore.getState(), surface = fileSurface(state.tabs[tabId], regionId)
    if (!surface || documentKey(surface.workspaceId, surface.path) !== key || documentLifetime(key) !== lifetime) throw Error('The original history target changed. No action was sent.')
    if (state.documents[key]?.noteEditing?.attempt || state.documents[key]?.noteEditing?.share || state.documents[key]?.noteEditing?.shareUndo) throw Error('The original Note request still needs reconciliation. Its operation and draft are retained; check that same request first.')
    const observed = await readNoteHistoryTarget(tabId, regionId, selected.target.noteId)
    if (JSON.stringify(observed.target) !== JSON.stringify(selected.target) || documentLifetime(key) !== lifetime) throw Error('The original history resource changed. Read that same Note before choosing another action.')
    const current = useAppStore.getState(), document = current.documents[key]
    if (!document || current.documents[key]?.noteEditing?.attempt) throw Error('The original Note document is unavailable or has an unresolved request.')
    const resourceWatch = watchNoteResource(initial.workspaceId, { hostId: observed.target.expectedResource.hostId, path: observed.target.expectedResource.workspacePath })
    try {
    const generation = current.documentGenerations[key] ?? 0, operationId = mintObjectId()
    const params = { ...observed.target, operationId, expectedRevision: observed.document.revision }
    const action: NonNullable<NoteFileAttempt['action']> = 'eventId' in selected
      ? { kind: 'restore', params: { ...params, eventId: selected.eventId } }
      : { kind: 'undo', params: { ...params, batchId: selected.batchId, batchLastEventId: selected.batchLastEventId } }
    const baseline = document.noteEditing?.baseline
    const knownDraftBase = baseline?.revision === document.revision && noteHistoryRevision(baseline.content) === document.revision
    const attempt: NoteFileAttempt = { operationId, noteId: selected.target.noteId, generation,
      content: current.dirtyDocuments[key] && knownDraftBase ? baseline.content : document.content,
      baseContent: observed.document.content, expectedRevision: observed.document.revision, action, target: observed.target, phase: 'sending',
      ...(current.dirtyDocuments[key] && !knownDraftBase ? { retainDraft: true } : {}),
      resource: { hostId: observed.target.expectedResource.hostId, workspaceId: observed.target.expectedResource.workspaceId,
        workspacePath: observed.target.expectedResource.workspacePath, path: observed.target.expectedResource.path } }
    useAppStore.setState(value => ({ documents: { ...value.documents, [key]: { ...value.documents[key]!, noteEditing: { ...value.documents[key]!.noteEditing, attempt } } },
      ...(value.dirtyDocuments[key] ? { retainedDocumentDrafts: { ...value.retainedDocumentDrafts, [key]: [...value.retainedDocumentDrafts[key] ?? [], value.documents[key]!] } } : {}),
      savingDocuments: { ...value.savingDocuments, [key]: true } }))
    let response: import('@agentmux/core/files').FileRestoreResult | import('@agentmux/core/files').FileUndoResult
    try { response = action.kind === 'restore' ? await api.files.restorePublic(action.params) : await api.files.undoPublic(action.params) }
    catch (error) { response = { resource: null, result: { status: 'unknown', code: 'NOTE_HISTORY_ACTION_UNCONFIRMED', message: presentError(error) } } }
    if (documentLifetime(key) !== lifetime || !useAppStore.getState().documents[key]) return
    const result = response.result
    if (result.status === 'written') {
      await settleNoteWritten(initial.workspaceId, initial.path, lifetime, attempt, result, resourceWatch.current)
      void useAppStore.getState().invalidateScratchTopicPaths(initial.workspaceId, [initial.path])
      await refreshFileDocument(initial.workspaceId, initial.path, lifetime)
      return
    }
    useAppStore.setState(value => ({ documents: { ...value.documents, [key]: { ...value.documents[key]!, noteEditing: { ...value.documents[key]!.noteEditing,
      attempt: result.status === 'unknown' ? { ...attempt, phase: 'unknown' as const } : undefined } } }, savingDocuments: { ...value.savingDocuments, [key]: false },
      documentIssues: { ...value.documentIssues, [key]: preserveNoteInputConflict(value.documents[key], value.documentIssues[key], result.status === 'unknown'
        ? { kind: 'write-unknown', code: result.code, message: result.message, attempted: { content: attempt.content, expectedRevision: attempt.expectedRevision, generation,
          resource: { hostId: attempt.resource.hostId, path: attempt.resource.workspacePath } } }
        : { kind: 'write-error', code: result.status === 'error' ? result.code : 'NOTE_HISTORY_CONFLICT', message: result.status === 'error' ? result.message : 'The historical action conflicted with the current Note. Its original versions and local draft are retained.' }) } }))
    if (result.status === 'conflict') await refreshFileDocument(initial.workspaceId, initial.path, lifetime)
    throw Error(result.status === 'error' || result.status === 'unknown' ? result.message : 'The historical action conflicted. The current file and draft are retained.')
    } finally { resourceWatch.release() }
  })
  const tail = operation.then(() => {}, () => {}); fileSaveTails.set(key, tail)
  try { await operation } finally { if (fileSaveTails.get(key) === tail) fileSaveTails.delete(key) }
}

type BufferedSessionEvent = {
  event: RuntimeEvent
  pendingLaunchAgentSessionId: string | null
  sequence: number
  nativeIdentityNotice?: ErrorNoticeContext
}
type SessionMembershipEventBuffer = {
  events: BufferedSessionEvent[]
  // Replacement facts are bounded by the Hosts/Sessions actually observed, not output
  // volume or historical Run generations. Timeline mutations need their canonical reader.
  retainedFacts: Map<string, BufferedSessionEvent>
  timelineGaps: Set<string>
  endpointWarnings: Map<string, { hostId: string; warning: RuntimeEndpointWarning | null; restored: boolean; observationStep?: string }>
  overflowed: boolean
  sequence: number
}
type SessionMembershipResync = SessionMembershipEventBuffer & {
  generation: number
  historyReading: boolean
  historyObservation?: { sources: readonly AgentSessionHistoryDescriptor[]; warnings: RuntimeEndpointWarning[]; sequence: number }
  recoverSavedAgents: boolean
  restoredHostIds: Set<string>
  startupNotice: ErrorNoticeContext | null
  cancelDelay: (() => void) | null
}
const MAX_SESSION_MEMBERSHIP_EVENTS = 256
const MAX_STARTUP_OBSERVATION_ATTEMPTS = 4
let regionCaretFocusNonce = 0
let sessionMembershipResync: SessionMembershipResync | null = null
let runtimeSubscriptionCount = 0
let sessionObservationGeneration = 0
let startupHistoryReadSequence = 0

function sessionMembershipEventBuffer(): SessionMembershipEventBuffer {
  return { events: [], retainedFacts: new Map(), timelineGaps: new Set(), endpointWarnings: new Map(), overflowed: false, sequence: 0 }
}

function sessionEventAgentId(event: RuntimeEvent): string | null {
  const core = event.event
  if (core.type === 'agent-session') return core.session.agentSessionId
  if (core.type === 'interaction') return core.request.agentSessionId
  return 'agentSessionId' in core ? core.agentSessionId ?? null : null
}

function enqueueSessionMembershipEvent(
  entry: SessionMembershipEventBuffer,
  event: RuntimeEvent,
  pendingLaunchAgentSessionId: string | null = null
): void {
  if (event.endpointWarning !== undefined) entry.endpointWarnings.set(JSON.stringify([event.hostId,
    event.endpointWarning?.scope === 'observation' ? event.endpointWarning.step : null]), {
    hostId: event.hostId, warning: event.endpointWarning, restored: event.event.type === 'connection-state' && event.event.state === 'restored'
  })
  if (event.endpointObservation) {
    const observation = event.endpointObservation
    entry.endpointWarnings.set(JSON.stringify([event.hostId, observation.step]), {
      hostId: event.hostId, warning: observation.warning, observationStep: observation.step, restored: false
    })
    if (observation.resolvedSteps?.[0] === CONNECTION_OBSERVATION_SOURCE_STEP) entry.endpointWarnings.set(JSON.stringify([event.hostId, CONNECTION_OBSERVATION_SOURCE_STEP]), {
      hostId: event.hostId, warning: null, observationStep: CONNECTION_OBSERVATION_SOURCE_STEP, restored: false
    })
  }
  const diagnostic = event.event.type === 'agent-error' ? runtimeDiagnosticNotice(useAppStore.getState(), event) : null
  entry.events.push({ event, pendingLaunchAgentSessionId, sequence: ++entry.sequence,
    ...(diagnostic?.cause ? { nativeIdentityNotice: { kind: 'indeterminate' as const,
      cause: diagnostic.cause, ...(diagnostic.subject ? { subject: diagnostic.subject } : {}) } } : {}) })
  if (entry.events.length <= MAX_SESSION_MEMBERSHIP_EVENTS) return
  const dropped = entry.events.shift()!
  const core = dropped.event.event
  entry.overflowed = true
  if (core.type === 'agent-timeline') {
    entry.timelineGaps.add(core.agentSessionId)
  } else if (core.type !== 'terminal-output' && core.type !== 'terminal-snapshot' && core.type !== 'terminal-resized') {
    const identity = sessionEventAgentId(dropped.event) ?? ('run' in core ? core.run.runId : null)
    entry.retainedFacts.set(JSON.stringify([dropped.event.hostId, identity, core.type]), dropped)
  }
}

function resetSessionMembershipRead(entry: SessionMembershipEventBuffer): void {
  // The next canonical cut covers facts received before the read. A dropped timeline
  // mutation still needs explicit history compensation, even if its Agent went quiet.
  entry.events.length = 0
  entry.retainedFacts.clear()
  entry.endpointWarnings.clear()
  entry.overflowed = false
}

function drainSessionMembershipEvents(entry: SessionMembershipEventBuffer): BufferedSessionEvent[] {
  const events = [...entry.retainedFacts.values(), ...entry.events].sort((a, b) => a.sequence - b.sequence)
  entry.events.length = 0
  entry.retainedFacts.clear()
  return events
}

function cancelSessionMembershipResync(): void {
  sessionObservationGeneration++
  startupRecoveryReaders.clear()
  const entry = sessionMembershipResync
  sessionMembershipResync = null
  entry?.cancelDelay?.()
}

function delaySessionMembershipRead(entry: SessionMembershipResync, milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); entry.cancelDelay = null; resolve() }
    const timer = setTimeout(finish, milliseconds)
    entry.cancelDelay = finish
  })
}

function runtimeEndpointWarningsAfterObservation(
  warnings: RuntimeEndpointWarning[] | undefined, hostId: string, warning: RuntimeEndpointWarning | null | undefined,
  observationStep?: string, resolvedSteps?: NonNullable<RuntimeEvent['endpointObservation']>['resolvedSteps']
): RuntimeEndpointWarning[] | undefined {
  if (warning === undefined) return warnings
  const step = observationStep ?? (warning?.scope === 'observation' ? warning.step : undefined)
  const resolvedSource = resolvedSteps?.[0] === CONNECTION_OBSERVATION_SOURCE_STEP ? CONNECTION_OBSERVATION_SOURCE_STEP : undefined
  const retained = (warnings ?? []).filter(previous => previous.hostId !== hostId || (step !== undefined
    ? previous.scope !== 'observation' || previous.step !== step && previous.step !== resolvedSource : previous.scope === 'observation'))
  return warning === null ? retained : [...retained, warning]
}

function originalSavedSessionExecutions(tabs: PersistedWorkbench['tabs'], config: AppConfig | null): Map<string, { kind: SessionSnapshot['kind']; hostId: string } | null> {
  // These indexes live only for this observation. Read original Core occurrences
  // once, rather than rescan every saved Region for each Runtime fact.
  const regions = new Map((coreSpatialPersistence?.current?.graph.regions ?? []).map(region => [JSON.stringify([region.tabId, region.regionId]), region]))
  const hosts = new Set(config?.hosts.map(host => host.id))
  const references = new Map<string, { kind: SessionSnapshot['kind']; hostId: string } | null>()
  for (const tab of Object.values(tabs)) for (const surface of workbenchSurfaces(tab)) {
    if (surface.kind !== 'agent' && surface.kind !== 'terminal') continue
    const original = regions.get(JSON.stringify([tab.id, surface.regionId]))
    const matches = original?.kind === surface.kind && (surface.kind === 'agent'
      ? original.agentSessionId === surface.sessionId : original.runId === surface.sessionId)
    const hostId = matches ? original.execution?.hostId : undefined
    let execution = hostId && hosts.has(hostId) ? { kind: surface.kind, hostId } : null
    const prior = references.get(surface.sessionId)
    // Every saved occurrence must agree; a missing fact or another Host cannot
    // borrow the first occurrence's execution identity.
    if (references.has(surface.sessionId) && (!prior || !execution || prior.kind !== execution.kind || prior.hostId !== execution.hostId)) execution = null
    references.set(surface.sessionId, execution)
  }
  return references
}

function startupSnapshotForSavedReferences(snapshot: RuntimeSnapshot, tabs: PersistedWorkbench['tabs'], config: AppConfig | null): { snapshot: RuntimeSnapshot; rejectedSavedIds: Set<string> } {
  const references = originalSavedSessionExecutions(tabs, config)
  const rejectedSavedIds = new Set<string>()
  if (!references.size) return { snapshot, rejectedSavedIds }
  // Keep unrelated new Sessions. A same-ID fact can bind a saved Region only if
  // every original occurrence has this exact kind and Core execution Host.
  const accepts = (kind: SessionSnapshot['kind'], hostId: string, id: string) => {
    const execution = references.get(id)
    const keep = !references.has(id) || execution?.kind === kind && execution.hostId === hostId
    if (!keep) rejectedSavedIds.add(id)
    return keep
  }
  const sessions = snapshot.sessions.filter(session => accepts(session.kind, session.hostId, session.id))
  const recoveryCandidates = snapshot.recoveryCandidates.filter(candidate => accepts('agent', candidate.hostId, candidate.agentSessionId))
  // Timelines are keyed only by SID. If another Host supplied the same SID in
  // this cut, its timeline cannot be attributed to the original execution.
  return { snapshot: { ...snapshot,
    sessions: sessions.filter(session => !rejectedSavedIds.has(session.id)),
    recoveryCandidates: recoveryCandidates.filter(candidate => !rejectedSavedIds.has(candidate.agentSessionId)),
    timelines: Object.fromEntries(Object.entries(snapshot.timelines).filter(([id]) => !rejectedSavedIds.has(id))) }, rejectedSavedIds }
}

function startupSnapshotConfirmedSessionIds(snapshot: RuntimeSnapshot, tabs: PersistedWorkbench['tabs'], config: AppConfig | null): Set<string> {
  const references = originalSavedSessionExecutions(tabs, config), confirmed = new Set<string>()
  for (const session of snapshot.sessions) {
    const original = references.get(session.id)
    if (original?.kind === session.kind && original.hostId === session.hostId && !runtimeSnapshotHostUnavailable(snapshot, session.hostId)) confirmed.add(session.id)
  }
  for (const candidate of snapshot.recoveryCandidates) {
    const original = references.get(candidate.agentSessionId)
    // A trusted exact candidate confirms a durable Agent waiting for recovery,
    // never a live Run or permission to execute. Terminal identity is separate.
    if (original?.kind === 'agent' && original.hostId === candidate.hostId && !runtimeSnapshotHostUnavailable(snapshot, candidate.hostId)) confirmed.add(candidate.agentSessionId)
  }
  return confirmed
}

function startupSnapshotConfirmsSessions(snapshot: RuntimeSnapshot, sessionIds: readonly string[], tabs: PersistedWorkbench['tabs'], config: AppConfig | null): boolean {
  const confirmed = startupSnapshotConfirmedSessionIds(snapshot, tabs, config)
  return sessionIds.length > 0 && sessionIds.every(id => confirmed.has(id))
}

function retiredHistoryReferenceIds(sources: readonly AgentSessionHistoryDescriptor[], tabs: AppState['tabs'], config: AppConfig | null): Set<string> {
  const references = originalSavedSessionExecutions(tabs, config)
  return new Set(sources.flatMap(source => {
    const original = references.get(source.agentSessionId)
    return source.state === 'retired' && original?.kind === 'agent' && original.hostId === source.hostId ? [source.agentSessionId] : []
  }))
}

function runtimeEndpointWarningsAfterMetadataRead(warnings: RuntimeEndpointWarning[] | undefined, step: string, observed: RuntimeEndpointWarning[]): RuntimeEndpointWarning[] {
  return [...(warnings ?? []).filter(warning => warning.scope !== 'observation' || warning.step !== step), ...observed]
}

/** Optional history metadata settles only its original notice; it cannot hold live membership. */
async function readStartupHistorySources(entry: SessionMembershipResync): Promise<void> {
  const sequence = ++startupHistoryReadSequence
  entry.historyReading = true
  try {
    const observed = await api.sessions.historySources({ observation: true })
    if (entry.generation !== sessionObservationGeneration || sequence !== startupHistoryReadSequence) return
    entry.historyObservation = { ...observed, sequence }
    useAppStore.setState(state => {
      const warnings = { runtimeEndpointWarnings: runtimeEndpointWarningsAfterMetadataRead(
        state.runtimeEndpointWarnings, 'Reading retained History sources', observed.warnings) }
      const notice = entry.startupNotice, source = notice?.startupSessionSnapshot
      if (!source || state.errorNoticeContext !== notice) return warnings
      const references = persistedSessionSurfaceIds(projectPersistedWorkbench(state))
      const retired = retiredHistoryReferenceIds(observed.sources, state.tabs, state.config)
      const unresolved = source.sessionIds.filter(id => references.has(id) && !retired.has(id))
      if (unresolved.length === source.sessionIds.length) return warnings
      if (unresolved.length === 0) {
        const { startupSessionSnapshot: _settled, ...retained } = notice
        const updated = { ...retained, summary: startupNoticeSummary(source.remainingMessage) }
        entry.startupNotice = updated
        return { ...warnings, error: source.remainingMessage, lastError: source.remainingMessage,
          errorNoticeContext: source.remainingMessage ? updated : null }
      }
      const updated = { ...notice, summary: startupNoticeSummary(source.remainingMessage, unresolved.length),
        startupSessionSnapshot: { ...source, sessionIds: unresolved } }
      entry.startupNotice = updated
      const message = [source.remainingMessage, source.failureMessage, missingSavedRuntimeFactsNotice(unresolved.length)].filter(Boolean).join(' ')
      return { ...warnings, error: message, lastError: message, errorNoticeContext: updated }
    })
  } catch (error) {
    if (entry.generation === sessionObservationGeneration && sequence === startupHistoryReadSequence)
      useAppStore.getState().reportError(error, { kind: 'indeterminate', summary: 'Reading retained History sources failed. Original Sessions and recovery remain available.' })
  } finally { entry.historyReading = false }
}

// These are only outstanding Desktop readers. Core still owns recovery identity and serialization.
const startupRecoveryReaders = new Map<string, Promise<unknown>>()

function dispatchStartupRecovery(session: Extract<SessionSnapshot, { kind: 'agent' }>, mote: boolean): void {
  const key = JSON.stringify(session.control)
  if (startupRecoveryReaders.has(key)) return
  const generation = sessionObservationGeneration
  const current = () => generation === sessionObservationGeneration
  const job = mote ? recoverMoteConversationAtStartup(session) : useAppStore.getState().recoverSession(session.id, undefined, { stillCurrent: current, trigger: 'startup' })
  startupRecoveryReaders.set(key, job)
  void job.catch(error => { if (current()) useAppStore.getState().reportError(error, { kind: 'indeterminate', subject: session.control,
    summary: 'Restoring this original Session failed. Other Sessions remain available.' }) })
    .finally(() => { if (startupRecoveryReaders.get(key) === job) startupRecoveryReaders.delete(key) })
}

function settleStartupProviderCatalog(entry: SessionMembershipResync, catalog: AppState['providerCatalog'], warnings: RuntimeEndpointWarning[]): void {
  useAppStore.setState(state => {
    const notice = entry.startupNotice, producer = notice?.startupProviderCatalog
    const observed = { providerCatalog: catalog, runtimeEndpointWarnings: runtimeEndpointWarningsAfterMetadataRead(state.runtimeEndpointWarnings, 'Reading Provider catalog', warnings) }
    if (!notice || !producer || state.errorNoticeContext !== notice) return observed
    const original = notice.startupSessionSnapshot?.remainingMessage ?? state.error
    // This exact producer is recorded at initialization. Never use text matching
    // to claim a later reportError or to clear an unrelated warning.
    const remaining = original?.replace(producer.warningMessage, '').trim() || null
    const { startupProviderCatalog: _settled, ...retained } = notice
    const source = retained.startupSessionSnapshot
    const updated = { ...retained, summary: startupNoticeSummary(remaining, source?.sessionIds.length ?? 0),
      ...(source ? { startupSessionSnapshot: { ...source, remainingMessage: remaining } } : {}) }
    entry.startupNotice = updated
    const message = source ? [remaining, source.failureMessage, missingSavedRuntimeFactsNotice(source.sessionIds.length)].filter(Boolean).join(' ') : remaining
    return { ...observed, error: message, lastError: message, errorNoticeContext: message ? updated : null }
  })
}

/** Presentation of the original startup producer, never a second Runtime fact. */
function startupNoticeSummary(remainingMessage: string | null, unconfirmedReferences = 0): string {
  if (unconfirmedReferences) return `${unconfirmedReferences} saved Session reference(s) have unconfirmed Runtime state. Original Regions remain visible.${remainingMessage ? ' Other startup checks need review.' : ''} See Details for recovery.`
  return 'Startup checks need attention. Original work surfaces remain visible; see Details for failures and recovery actions.'
}

function missingSavedRuntimeFactsNotice(count: number): string {
  return `${count} saved Session reference(s) have no current Runtime facts. Their Regions remain visible; retry recovery when the Runtime can confirm them.`
}

function startSessionMembershipResync(
  event?: RuntimeEvent,
  options: { reportFailure?: boolean; recoverSavedAgents?: boolean; restoredHostId?: string } = {}
): void {
  const currentNotice = useAppStore.getState().errorNoticeContext
  const startupNotice = currentNotice?.startupSessionSnapshot || currentNotice?.startupProviderCatalog ? currentNotice : null
  if (sessionMembershipResync) {
    sessionMembershipResync.recoverSavedAgents ||= options.recoverSavedAgents === true
    if (options.restoredHostId) sessionMembershipResync.restoredHostIds.add(options.restoredHostId)
    // initialize can join the resync already started by a buffered membership event.
    if (startupNotice) sessionMembershipResync.startupNotice = startupNotice
    if (event) enqueueSessionMembershipEvent(sessionMembershipResync, event)
    return
  }
  const entry: SessionMembershipResync = {
    ...sessionMembershipEventBuffer(),
    generation: sessionObservationGeneration,
    historyReading: false,
    cancelDelay: null,
    recoverSavedAgents: options.recoverSavedAgents === true,
    restoredHostIds: new Set(options.restoredHostId ? [options.restoredHostId] : []),
    startupNotice
  }
  if (event) enqueueSessionMembershipEvent(entry, event)
  sessionMembershipResync = entry
  let retryDelay = 50
  let startupObservationAttempts = 0
  let providerAttempts = 0
  let historyAttempts = 0
  let restoredProviderRead = false
  const attemptedStartupRecovery = new Set<string>()
  void (async () => {
    try {
      while (sessionMembershipResync === entry) {
        const providerRestored = restoredProviderRead || entry.events.some(({ event }) => event.event.type === 'connection-state'
          && event.event.state === 'restored' && useAppStore.getState().runtimeEndpointWarnings?.some(warning =>
            warning.hostId === event.hostId && warning.scope === 'observation' && warning.step === 'Reading Provider catalog'))
        restoredProviderRead = false
        // Everything already queued happened before this snapshot and is covered by its
        // canonical baseline. Only events that arrive while the snapshot is in flight
        // need ordered replay afterward.
        resetSessionMembershipRead(entry)
        const providerPending = entry.startupNotice?.startupProviderCatalog
          && useAppStore.getState().errorNoticeContext === entry.startupNotice
        if (entry.startupNotice && useAppStore.getState().errorNoticeContext === entry.startupNotice
          && (entry.startupNotice.startupSessionSnapshot || providerPending)) startupObservationAttempts++
        let snapshotResult: PromiseSettledResult<RuntimeSnapshot>
        let providerRefreshed = false
        let providerObservation: { warnings: RuntimeEndpointWarning[] } | undefined
        const partialProviderPending = options.reportFailure === false && useAppStore.getState().runtimeEndpointWarnings?.some(warning =>
          warning.scope === 'observation' && warning.step === 'Reading Provider catalog')
        if (providerRestored || (providerPending || partialProviderPending) && providerAttempts < MAX_STARTUP_OBSERVATION_ATTEMPTS) {
          providerAttempts++
          const [runtime, catalog] = await Promise.allSettled([api.sessions.snapshot(), api.providers.list({ observation: true })])
          snapshotResult = runtime
          if (sessionMembershipResync !== entry) return
          if (catalog.status === 'fulfilled') {
            settleStartupProviderCatalog(entry, catalog.value.catalog, catalog.value.warnings)
            providerObservation = catalog.value
            providerRefreshed = true
          }
        } else {
          // Keep the established healthy membership path to one await. A Provider
          // retry adds concurrency only when that original observation failed.
          try { snapshotResult = { status: 'fulfilled', value: await api.sessions.snapshot() } }
          catch (reason) { snapshotResult = { status: 'rejected', reason } }
        }
        if (sessionMembershipResync !== entry) return
        if (snapshotResult.status === 'rejected') {
          const ownsStartupNotice = entry.startupNotice && useAppStore.getState().errorNoticeContext === entry.startupNotice
          const notice = entry.startupNotice, source = notice?.startupSessionSnapshot
          if (ownsStartupNotice && source && !source.failureMessage) {
            const failureMessage = `Reading saved Session facts failed: ${presentError(snapshotResult.reason)}`
            const updated = { ...notice, startupSessionSnapshot: { ...source, failureMessage } }
            entry.startupNotice = updated
            const message = [source.remainingMessage, failureMessage, missingSavedRuntimeFactsNotice(source.sessionIds.length)].filter(Boolean).join(' ')
            useAppStore.setState({ error: message, lastError: message, errorNoticeContext: updated })
          }
          if (ownsStartupNotice && startupObservationAttempts < MAX_STARTUP_OBSERVATION_ATTEMPTS) {
            await delaySessionMembershipRead(entry, retryDelay)
            retryDelay = Math.min(1000, retryDelay * 2)
            continue
          }
          if (!ownsStartupNotice) throw snapshotResult.reason
          return
        }
        const savedCut = startupSnapshotForSavedReferences(snapshotResult.value, useAppStore.getState().tabs, useAppStore.getState().config)
        let snapshot = savedCut.snapshot
        // An omitted diagnostic is not proof that its metadata producer succeeded.
        // Preserve the prior cut until that exact reader returns its new receipt.
        for (const warning of useAppStore.getState().runtimeEndpointWarnings ?? []) if (warning.scope === 'observation'
          && !snapshot.runtimeEndpointWarnings?.some(current => current.scope === 'observation' && current.hostId === warning.hostId && current.step === warning.step)) {
          snapshot = { ...snapshot, runtimeEndpointWarnings: [...snapshot.runtimeEndpointWarnings ?? [], warning] }
        }
        if (providerObservation) snapshot = { ...snapshot, runtimeEndpointWarnings: runtimeEndpointWarningsAfterMetadataRead(
          snapshot.runtimeEndpointWarnings, 'Reading Provider catalog', providerObservation.warnings) }
        if (entry.historyObservation?.sequence === startupHistoryReadSequence) snapshot = { ...snapshot,
          runtimeEndpointWarnings: runtimeEndpointWarningsAfterMetadataRead(snapshot.runtimeEndpointWarnings,
            'Reading retained History sources', entry.historyObservation.warnings) }
        const restoredHistory = useAppStore.getState().runtimeEndpointWarnings?.some(warning => warning.scope === 'observation'
          && warning.step === 'Reading retained History sources' && entry.restoredHostIds.has(warning.hostId))
        if (sessionMembershipResync !== entry) return
        // Recheck after the metadata await too. Loss requires another canonical cut,
        // but cannot discard the useful facts from this completed read.
        const readOverflowed = entry.overflowed
        // A cold-start observation may have contained no usable Session facts. The saved shell is
        // already visible now; admit its later canonical candidates through the same recovery
        // policy and action as ordinary startup, without another initialize or lifecycle owner.
        const savedSessionIds = entry.recoverSavedAgents
          ? persistedSessionSurfaceIds(projectPersistedWorkbench(useAppStore.getState()))
          : new Set<string>()
        const startupCandidates = entry.recoverSavedAgents ? [
          ...snapshot.recoveryCandidates,
          ...snapshot.sessions.flatMap((session) => session.kind === 'agent'
            ? [{ ...session, agentSessionId: session.id, run: session.control.run }]
            : [])
        ].filter((candidate) => savedSessionIds.has(candidate.agentSessionId)) : []
        const events = drainSessionMembershipEvents(entry)
        const restoredDuringRead = new Set(events.flatMap(({ event }) => event.event.type === 'connection-state' && event.event.state === 'restored' ? [event.hostId] : []))
        let membershipGap = readOverflowed
        const timelineGaps = new Set(entry.timelineGaps)
        entry.timelineGaps.clear()
        useAppStore.setState((state) => {
          let projected = reduceAgentMembershipSnapshot(state, snapshot)
          projected = reduceTerminalMembershipSnapshot(projected, snapshot)
          for (const candidate of startupCandidates) {
            if (projected.sessions.some((session) => session.id === candidate.agentSessionId)) continue
            projected = { ...projected, sessions: [...projected.sessions, recoveryCandidateSession(candidate, {
              kind: 'pending', detail: agentContinuityDetail(candidate.continuity)
            })] }
          }
          for (const pending of events) {
            if (
              pending.pendingLaunchAgentSessionId &&
              pendingAgentLaunchEventId(projected, pending.event) === pending.pendingLaunchAgentSessionId
            ) {
              continue
            }
            const reduced = projectRuntimeEvent(projected, pending.event)
            if (pending.event.event.type === 'run-removed') recordClosedWorkbenchEntities(projected.tabs, reduced.state.tabs)
            projected = reduced.state
            membershipGap ||= reduced.sessionMembershipGap === true
            // A reconnect during this read needs its own later canonical cut. A sparse restored
            // event cannot clear a snapshot's unavailable-owner notice or prove membership.
            membershipGap ||= pending.event.event.type === 'connection-state' && pending.event.event.state === 'restored'
            if (reduced.timelineGapSessionId) timelineGaps.add(reduced.timelineGapSessionId)
          }
          // Exact original live, pending and retired identities settle only this
          // observation producer. An unrelated Host cannot confirm the reference.
          const notice = entry.startupNotice
          const source = notice?.startupSessionSnapshot
          let resolvedStartupNotice: Partial<AppState> = {}
          if (source && state.errorNoticeContext === notice && !readOverflowed) {
            const currentReferences = persistedSessionSurfaceIds(projectPersistedWorkbench(projected))
            const retiredReferences = retiredHistoryReferenceIds(entry.historyObservation?.sources ?? [], projected.tabs, state.config)
            const confirmedReferences = startupSnapshotConfirmedSessionIds(snapshot, state.tabs, state.config)
            const unresolved = source.sessionIds.filter(id => currentReferences.has(id) && !retiredReferences.has(id) && !confirmedReferences.has(id))
            if (unresolved.length === 0) {
              const { startupSessionSnapshot: _settled, ...retained } = notice
              const updated = { ...retained, summary: startupNoticeSummary(source.remainingMessage) }
              entry.startupNotice = updated
              resolvedStartupNotice = {
                error: source.remainingMessage,
                lastError: source.remainingMessage,
                errorNoticeContext: source.remainingMessage ? updated : null
              }
            } else if (unresolved.length !== source.sessionIds.length) {
              const updated = { ...notice, summary: startupNoticeSummary(source.remainingMessage, unresolved.length), startupSessionSnapshot: { ...source, sessionIds: unresolved } }
              entry.startupNotice = updated
              const message = [source.remainingMessage, source.failureMessage, missingSavedRuntimeFactsNotice(unresolved.length)].filter(Boolean).join(' ')
              resolvedStartupNotice = { error: message, lastError: message, errorNoticeContext: updated }
            }
          }
          let reconciled = { ...state, ...projected }
          for (const session of snapshot.sessions) {
            if (!runtimeSnapshotHostUnavailable(snapshot, session.hostId)) reconciled = reconcileDeliveredSteers(reconciled, session.id)
          }
          let runtimeEndpointWarnings = events.reduce<RuntimeEndpointWarning[] | undefined>((warnings, pending) => {
            const next = pending.event.event.type === 'connection-state' && pending.event.event.state === 'restored' && pending.event.endpointWarning === null
              ? warnings : runtimeEndpointWarningsAfterObservation(warnings, pending.event.hostId, pending.event.endpointWarning)
            return pending.event.endpointObservation ? runtimeEndpointWarningsAfterObservation(next, pending.event.hostId,
              pending.event.endpointObservation.warning, pending.event.endpointObservation.step, pending.event.endpointObservation.resolvedSteps) : next
          }, snapshot.runtimeEndpointWarnings ?? [])
          for (const { hostId, warning, restored, observationStep } of entry.endpointWarnings.values()) {
            if (restored && warning === null) continue
            runtimeEndpointWarnings = runtimeEndpointWarningsAfterObservation(runtimeEndpointWarnings, hostId, warning, observationStep)
          }
          entry.endpointWarnings.clear()
          const next = { ...reconciled, localHome: snapshot.localHome ?? state.localHome, sessionNameMetadata: snapshot.sessionNameMetadataWarning ? state.sessionNameMetadata : sessionNameMetadataRecord(snapshot.sessionNameMetadata ?? [], state.sessionNameMetadata), sessionNameMetadataWarning: snapshot.sessionNameMetadataWarning ?? null, sessions: projectRuntimeEndpointSessions(reconciled.sessions, runtimeEndpointWarnings), ...resolvedStartupNotice, runtimeEndpointWarnings, runtimeOwnershipWarnings: snapshot.runtimeOwnershipWarnings ?? [], environmentWarning: snapshot.environmentWarning ?? null }
          return { ...next, ...resolvedNativeIdentityNotices({ ...state, ...next }) }
        })
        if (!entry.historyReading && historyAttempts < MAX_STARTUP_OBSERVATION_ATTEMPTS && (entry.startupNotice?.startupSessionSnapshot || restoredHistory)) {
          historyAttempts++
          void readStartupHistorySources(entry)
        }
        for (const pending of events) {
          if (pending.event.event.type === 'run-service') runServiceProjection.apply(pending.event)
          if (pending.nativeIdentityNotice && nativeIdentityNoticeResolved(useAppStore.getState().sessions, pending.nativeIdentityNotice)) continue
          const diagnostic = runtimeDiagnosticNotice(useAppStore.getState(), pending.event)
          if (diagnostic) useAppStore.getState().reportError(diagnostic.message, { kind: 'indeterminate', summary: diagnostic.summary,
            ...(diagnostic.subject ? { subject: diagnostic.subject } : {}), ...(diagnostic.cause ? { cause: diagnostic.cause } : {}) })
        }
        for (const candidate of startupCandidates) {
          if (restoredDuringRead.has(candidate.hostId)) continue
          const current = useAppStore.getState().sessions.find((session) => session.id === candidate.agentSessionId)
          if (!current || attemptedStartupRecovery.has(candidate.agentSessionId)) continue
          const recoveryState = useAppStore.getState()
          if (current.kind === 'agent' && deferScratchConversationRecovery(recoveryState.tabs, recoveryState.config, current.id)) {
            dispatchStartupRecovery(current, true)
            continue
          }
          if (runtimeSnapshotHostUnavailable(snapshot, candidate.hostId)) continue
          attemptedStartupRecovery.add(candidate.agentSessionId)
          if (current.kind === 'agent') dispatchStartupRecovery(current, false)
        }
        for (const sessionId of Object.keys(useAppStore.getState().agentSteerQueues)) {
          const current = useAppStore.getState(), session = current.sessions.find((item) => item.id === sessionId)
          if (session && restoredDuringRead.has(session.hostId)) continue
          if (!session || current.runtimeEndpointWarnings?.some(warning => warning.scope !== 'observation' && warning.hostId === session.hostId && warning.availability !== 'connected')) continue
          const pending = current.agentSteerQueues[sessionId]?.find((item) => !item.archived && !item.awaitingExplicitSend &&
            (item.runId === undefined || steerEntryTargetsRun(item, session.control.run.runId)))
          if (entry.restoredHostIds.has(session.hostId) && pending && pending.promptCondition !== null) {
            // A fresh timeline can settle a delivery receipt. Its absence cannot prove that an
            // already prepared mutation never ran. Keep that original operation for inspection.
            useAppStore.setState((state) => ({ agentSteerQueues: { ...state.agentSteerQueues,
              [sessionId]: state.agentSteerQueues[sessionId]!.map((item) => item.operationId === pending.operationId
                ? { ...item, status: 'deferred', error: item.error ?? 'The original message delivery is unconfirmed after reconnect. Inspect the outbox before retrying.' } : item) } }))
            continue
          }
          void current.flushAgentSteerQueue(sessionId)
        }
        for (const sessionId of timelineGaps) void useAppStore.getState().resyncTimeline(sessionId)
        restoredProviderRead = [...restoredDuringRead].some(hostId => useAppStore.getState().runtimeEndpointWarnings?.some(warning =>
          warning.hostId === hostId && warning.scope === 'observation' && warning.step === 'Reading Provider catalog'))
        // Recovery above can publish events while its public API call is pending. Drain those
        // queued facts before releasing this resync owner, just as events during snapshot reads.
        const retryProvider = entry.startupNotice?.startupProviderCatalog
          && useAppStore.getState().errorNoticeContext === entry.startupNotice
          && providerAttempts < MAX_STARTUP_OBSERVATION_ATTEMPTS
        const retryPartialProvider = options.reportFailure === false && providerAttempts < MAX_STARTUP_OBSERVATION_ATTEMPTS
          && useAppStore.getState().runtimeEndpointWarnings?.some(warning => warning.scope === 'observation' && warning.step === 'Reading Provider catalog')
        const retryStartupSnapshot = entry.startupNotice?.startupSessionSnapshot
          && useAppStore.getState().errorNoticeContext === entry.startupNotice
          && startupObservationAttempts < MAX_STARTUP_OBSERVATION_ATTEMPTS
        if (!membershipGap && entry.events.length === 0 && !entry.overflowed && !retryProvider && !retryPartialProvider && !retryStartupSnapshot && !providerRefreshed && !restoredProviderRead) return
        // One owner/one read, with a yield and capped backoff under sustained pressure.
        await delaySessionMembershipRead(entry, retryDelay)
        retryDelay = Math.min(1000, retryDelay * 2)
      }
    } catch (error) {
      // reportError retains an unfinished startup source and records this independent failure.
      useAppStore.getState().reportError(error, { kind: 'indeterminate',
        summary: 'Reading the original Session snapshot failed. The saved workface is retained; reconnect or refresh to retry.' })
    } finally {
      if (sessionMembershipResync === entry) sessionMembershipResync = null
    }
  })()
}

type WarmTerminal = {
  // Prevents a shell from being reused for the wrong host or working directory.
  key: string
  /** A visible preview owns this candidate; null makes an unused shell reusable. */
  ownerLauncherId: string | null
  /** A hidden pending preview keeps its original recovery owner until its receipt settles. */
  previewReleased?: true
  ready: Promise<SessionSnapshot | null>
  session: SessionSnapshot | null
  /** Retained until its original creation is confirmed; absent on an already known Run. */
  creation?: WarmTerminalCreation
  /** Explicit request ownership survives the temporary receipt claim. */
  explicitOpening?: true
  /** One explicit opening owns the retained slot until its original receipt settles. */
  claimToken?: object
}

export function warmTerminalKey(hostId: string, workspacePath: string): string {
  return `${hostId}\0${workspacePath}`
}

async function stopTerminalSession(session: SessionSnapshot): Promise<boolean> {
  try {
    await api.sessions.stop(session.control)
    return true
  } catch {
    return false
  }
}

function updateWarmTerminal(
  terminals: Record<string, WarmTerminal[]>, key: string,
  matches: (candidate: WarmTerminal) => boolean,
  update: (candidate: WarmTerminal) => WarmTerminal | null
): Record<string, WarmTerminal[]> {
  const candidates = terminals[key]
  if (!candidates?.some(matches)) return terminals
  const next = candidates.flatMap(candidate => {
    if (!matches(candidate)) return [candidate]
    const updated = update(candidate)
    return updated ? [updated] : []
  })
  if (next.length) return { ...terminals, [key]: next }
  const { [key]: _released, ...rest } = terminals
  return rest
}

async function stopWarmTerminal(held: WarmTerminal | null): Promise<string | null> {
  if (!held) return null
  const session = await held.ready.catch(() => null)
  if (!session) return null
  return await stopTerminalSession(session) ? session.id : null
}

function trackUnclaimedTerminalSession(ids: readonly string[], sessionId: string): string[] {
  return ids.includes(sessionId) ? [...ids] : [...ids, sessionId]
}

function forgetUnclaimedTerminalSession(ids: readonly string[], sessionId: string): string[] {
  return ids.filter((id) => id !== sessionId)
}

export function readRendererResourceOwnerCounts() {
  const resourceWindow = window as typeof window & {
    __agentmuxMonacoEditorCount?: () => number
    __agentmuxMonacoModelCount?: () => number
  }
  return rendererResourceOwnerCounts({
    documentCount: Object.keys(useAppStore.getState().documents).length,
    runtimeSubscriptionCount,
    terminalOwners: terminalResourceOwnerCounts(),
    ...(resourceWindow.__agentmuxMonacoEditorCount
      ? { monacoEditorCount: resourceWindow.__agentmuxMonacoEditorCount }
      : {}),
    ...(resourceWindow.__agentmuxMonacoModelCount
      ? { monacoModelCount: resourceWindow.__agentmuxMonacoModelCount }
      : {})
  })
}

if (typeof window !== 'undefined') {
  window.addEventListener('agentmux:resource-owner-counts', (event) => {
    const target = event as CustomEvent<Record<string, number | boolean | null>>
    Object.assign(target.detail, readRendererResourceOwnerCounts())
    target.detail.observed = true
  })
}

function newTabGroupId(): string {
  return mintObjectId()
}

function newRegionId(): string {
  return mintObjectId()
}

function newLauncherTab(workspaceId: string, topicId?: string): WorkbenchTab {
  const executorId = moteDefaultExecutor(useAppStore.getState(), workspaceId, topicId)
  const tabId = mintObjectId()
  const surface: LauncherWorkbenchSurface = {
    regionId: initialWorkbenchRegionId(tabId),
    kind: 'launcher',
    workspaceId,
    ...(executorId ? { executorId } : {})
  }
  const tab = createWorkbenchTab(tabId, surface)
  return topicId ? { ...tab, topicId } : tab
}

type PersistedAppState = {
  workbenchSpaceSelection: AgentMuxDesktopSpaceSelection | null
  projectGroups?: AgentMuxProjectGroupFact[]
  spaceZoneBindings?: SpaceZoneBindings
  spatialRequests: Record<string, SpatialRequestBinding>
  goalAgentSelectionDrafts?: Record<string, GoalAgentSelectionDraft>
  goalFiniteStartIntents?: Record<string, GoalFiniteStartIntent>
  goalAgentCreationDrafts?: Record<string, GoalAgentCreationDraft>
  /** Exact logical focus retained when a background move removes the active leaf. */
  retainedSpatialFocus: (AgentMuxSpaceAddress & { topicId?: string }) | null
  connectorRoomIntents?: Record<string, ConnectorRoomIntent>
  connectorRoomDrafts?: Record<string, ConnectorRoomDraft>
  continuityControlIntents?: ContinuityControlIntents
  conversationLandmarkIntents?: ConversationLandmarkIntents
  connectorServiceIntents?: Record<string, ConnectorServiceIntent>
  mailboxNotificationIntents?: MailboxNotificationIntents
  moteBotRequests?: Record<string, MoteBotRequest>
  botTaskSelections?: BotTaskSelections
  manualConnectionSelections?: Partial<Record<ManualConnectionIntent['channel'], ManualConnectionIntent['target']>>
  manualConnectionIntents?: Record<string, ManualConnectionIntent>
  moteConnectionSaveIntents?: Record<string, MoteConnectionSaveIntent>
  moteChatIntents?: Record<string, MoteChatIntent>
  agentComposerDrafts?: Record<string, string>
  agentLearningReviewDrafts?: Record<string, AgentLearningReviewDraft>
  capsuleQuestionEditors?: Record<string, CapsuleQuestionEditor>
  browserOpinionDrafts?: Record<string, BrowserOpinionDraft>
  agentComposerHistory?: Record<string, readonly string[]>
  launcherNameDrafts?: Record<string, LauncherNames>
  launcherOptionDrafts?: LauncherOptionDrafts
  agentComposerNotes?: Record<string, string>
  questionReplyDrafts?: DesktopQuestionDrafts
  questionReplies?: DesktopQuestionReplies
  agentSteerQueues?: Record<string, AgentSteerQueueEntry[]>
  documents?: Record<string, FileDocument>
  retainedDocumentDrafts?: Record<string, FileDocument[]>
  dirtyDocuments?: Record<string, boolean>
  restoredWorkbench?: PersistedWorkbench
  unclaimedTerminalSessionIds: string[]
  scratchTopicOrder?: string[]
  workspaceAgentOrder?: Record<string, string[]>
  recentMoteAgents?: Record<string, MoteRecentAgent>
  noticeReadReceipts?: Record<string, Record<string, string>>
  displacedAgentSessionIds?: string[]
  agentNames?: Record<string, string>
  viewModes?: Record<string, ViewMode>
  activeWorkspaceId?: string | null
  mainSurface?: MainSurface
  notebookRecoveries?: NotebookRecovery[]
  recallNotebookId?: string | null
  recallNoteId?: string | null
  recallZoneSelection?: PersistedSurveyZoneSelection | null
  recallSidebarCollapsed?: boolean
  recallSidebarWidth?: number
  /** Previous persisted notebook context is transferred once into Recall. */
  surveyNotebookId?: string | null
  surveyNoteId?: string | null
  surveyZoneSelection?: PersistedSurveyZoneSelection | null
  surveyCollectedZones?: Record<string, true>
  surveyOrganization?: import('@agentmux/core/control').AgentMuxSurveyOrganization
  surveyExplorationNames?: Record<string, string>
  noteBlockSelections?: Record<string, NoteBlockTarget>
  noteCanvasLayouts?: Record<string, NoteCanvasLayout>
  focusTimelineNameWidth?: number
  surveySidebarCollapsed?: boolean
  surveySidebarWidth?: number
  focusTimelineHeight?: number
  focusTimelineRuler?: FocusRulerPreferences
  agentFocus?: AgentFocusContext
  selectedDemandId?: string | null
  demandArrangement?: DemandArrangement
  demandPmoTabIds?: Record<string, string>
  projectRailOpen?: boolean
  collapsedProjectGroups?: Record<string, true>
  explorerCollapsed?: Record<string, boolean>
  pinnedItems?: Record<string, string[]>
  spaceObjectIcons?: unknown
  toolkitPresentation?: unknown
  toolsOpen?: boolean
  workspaceTool?: WorkspaceTool
  workspaceGitView?: WorkspaceGitView
  gitCommitDrafts?: Record<string, string>
  projectRailWidth?: number
  toolDockWidth?: number
  editorWordWrap?: boolean
  editorMinimap?: boolean
  explorerShowHidden?: boolean
  explorerShowIgnored?: boolean


}

export type RestoredUiState = Pick<
  AppState,
  | 'workspaceAgentOrder'
  | 'workbenchSpaceSelection'
  | 'activeWorkspaceId'
  | 'mainSurface'
  | 'notebookRecoveries'
  | 'recallNotebookId'
  | 'recallNoteId'
  | 'recallZoneSelection'
  | 'recallSidebarCollapsed'
  | 'recallSidebarWidth'
  | 'surveyZoneSelection'
  | 'surveyCollectedZones'
  | 'surveyOrganization'
  | 'surveyExplorationNames'
  | 'noteBlockSelections'
  | 'noteCanvasLayouts'
  | 'surveySidebarCollapsed'
  | 'surveySidebarWidth'
  | 'projectRailOpen'
  | 'collapsedProjectGroups'
  | 'explorerCollapsed'
  | 'pinnedItems'
  | 'spaceObjectIcons'
  | 'toolkitPresentation'
  | 'toolsOpen'
  | 'workspaceTool'
  | 'workspaceGitView'
  | 'gitCommitDrafts'
  | 'projectRailWidth'
  | 'toolDockWidth'
  | 'focusTimelineNameWidth'
  | 'focusTimelineHeight'
  | 'focusTimelineRuler'
  | 'editorWordWrap'
  | 'editorMinimap'
  | 'explorerShowHidden'
  | 'explorerShowIgnored'
>

/**
 * 折叠集合的读回。只收「key 是字符串、值恰好是 true」的条目。
 *
 * 一条坏记录不该让整份布局回退到默认：逐条筛比整体丢弃更贴近这个函数已有的立场（缺字段走默认、
 * 坏枚举走默认）。收成 `true` 而不是任意真值，是因为写入侧只写 true——读回时放宽会让"存折叠集合"
 * 这个约定在读写两侧不一致。
 */
function restoredCollapsedGroups(candidate: unknown): Record<string, true> {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return {}
  const restored: Record<string, true> = {}
  for (const [key, value] of Object.entries(candidate)) {
    if (key !== '' && value === true) restored[key] = true
  }
  return restored
}

/**
 * Explorer 折叠覆盖的读回。逐条筛（同 restoredCollapsedGroups 的立场，坏记录不拖垮整份），但这里
 * `false` 是**合法值**——它是「用户显式展开一个默认折叠的 Scratch」这一意图，与缺席（按 kind 默认）
 * 必须区分开。所以只丢掉「key 是空串 / 值不是 boolean」的垃圾，两个布尔值都收下。
 */
function restoredExplorerCollapsed(candidate: unknown): Record<string, boolean> {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return {}
  const restored: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(candidate)) {
    if (key !== '' && typeof value === 'boolean') restored[key] = value
  }
  return restored
}

/**
 * pin 列表的读回。key 是 scope，value 是保序的 id 列表。逐条筛：丢掉空 scope、非数组的值，并把
 * 数组里的非字符串、空串、重复项剔掉；剩下的一条都不剩时连键一起丢（写入侧移空即删键，读回同步）。
 */
function restoredPinnedItems(candidate: unknown): Record<string, string[]> {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return {}
  const restored: Record<string, string[]> = {}
  for (const [scope, value] of Object.entries(candidate)) {
    if (scope === '' || !Array.isArray(value)) continue
    const seen = new Set<string>()
    for (const id of value) {
      if (typeof id === 'string' && id !== '' && !seen.has(id)) seen.add(id)
    }
    if (seen.size > 0) restored[scope] = [...seen]
  }
  return restored
}

/**
 * Validate persisted presentation state at the configuration boundary. Persisted JSON is user data,
 * not a trusted in-memory AppState: a removed Workspace, an old enum value, or a corrupt dock width
 * must not make startup render an unusable surface. Missing fields intentionally resolve to the
 * current defaults, which keeps older records readable without a compatibility branch.
 */
export function restorePersistedUiState(
  config: AppConfig,
  persisted: Pick<
    PersistedAppState,
    | 'workspaceAgentOrder'
    | 'workbenchSpaceSelection'
    | 'activeWorkspaceId'
    | 'mainSurface'
    | 'notebookRecoveries'
    | 'recallNotebookId'
    | 'recallNoteId'
    | 'surveyNotebookId'
    | 'surveyNoteId'
    | 'recallZoneSelection'
    | 'recallSidebarCollapsed'
    | 'recallSidebarWidth'
    | 'surveyZoneSelection'
    | 'surveyCollectedZones'
  | 'surveyOrganization'
    | 'surveyExplorationNames'
    | 'noteBlockSelections'
  | 'noteCanvasLayouts'
    | 'surveySidebarCollapsed'
    | 'surveySidebarWidth'
    | 'projectRailOpen'
    | 'collapsedProjectGroups'
    | 'explorerCollapsed'
    | 'pinnedItems'
    | 'spaceObjectIcons'
    | 'toolkitPresentation'
    | 'toolsOpen'
    | 'workspaceTool'
    | 'workspaceGitView'
    | 'gitCommitDrafts'
    | 'projectRailWidth'
  | 'toolDockWidth'
  | 'focusTimelineNameWidth'
  | 'focusTimelineHeight'
  | 'focusTimelineRuler'
    | 'editorWordWrap'
    | 'editorMinimap'
    | 'explorerShowHidden'
    | 'explorerShowIgnored'
  >
): RestoredUiState {
  return {
    workspaceAgentOrder: restoreWorkspaceAgentOrder(persisted.workspaceAgentOrder),
    workbenchSpaceSelection: restoreWorkbenchSpaceSelection(persisted.workbenchSpaceSelection),
    focusTimelineNameWidth: clampFocusTimelineNameWidth(persisted.focusTimelineNameWidth),
    focusTimelineHeight: clampFocusTimelineHeight(persisted.focusTimelineHeight),
    focusTimelineRuler: restoreFocusRuler(persisted.focusTimelineRuler),
    activeWorkspaceId: reseatActiveWorkspaceId(config, persisted.activeWorkspaceId),
    mainSurface: persisted.mainSurface === 'survey' && persisted.surveyNotebookId ? 'recall' : restoredMainSurface(persisted.mainSurface),
    notebookRecoveries: restoreNotebookRecoveries(persisted.notebookRecoveries),
    recallNotebookId: typeof (persisted.recallNotebookId ?? persisted.surveyNotebookId) === 'string' ? (persisted.recallNotebookId ?? persisted.surveyNotebookId)! : null,
    recallNoteId: typeof (persisted.recallNoteId ?? persisted.surveyNoteId) === 'string' ? (persisted.recallNoteId ?? persisted.surveyNoteId)! : null,
    recallZoneSelection: restoredSurveyZoneSelection(persisted.recallZoneSelection ?? (persisted.surveyNotebookId ? persisted.surveyZoneSelection : null)),
    recallSidebarCollapsed: restoredBoolean(persisted.recallSidebarCollapsed, false),
    recallSidebarWidth: clampSurveySidebarWidth(persisted.recallSidebarWidth ?? SURVEY_SIDEBAR_DEFAULT_WIDTH),
    surveyZoneSelection: restoredSurveyZoneSelection(persisted.surveyNotebookId ? null : persisted.surveyZoneSelection),
    surveyCollectedZones: restoredSurveyCollection(persisted.surveyCollectedZones),
    surveyOrganization: restoreSurveyOrganization(persisted.surveyOrganization),
    surveyExplorationNames: restoredSurveyExplorationNames(persisted.surveyExplorationNames),
    noteBlockSelections: restoreNoteBlockSelections(persisted.noteBlockSelections),
    noteCanvasLayouts: restoreNoteCanvasLayouts(persisted.noteCanvasLayouts),
    surveySidebarCollapsed: restoredBoolean(persisted.surveySidebarCollapsed, false),
    surveySidebarWidth: clampSurveySidebarWidth(persisted.surveySidebarWidth ?? SURVEY_SIDEBAR_DEFAULT_WIDTH),
    projectRailOpen: restoredBoolean(persisted.projectRailOpen, true),
    collapsedProjectGroups: restoredCollapsedGroups(persisted.collapsedProjectGroups),
    explorerCollapsed: restoredExplorerCollapsed(persisted.explorerCollapsed),
    pinnedItems: restoredPinnedItems(persisted.pinnedItems),
    spaceObjectIcons: restoreSpaceIconOverrides(Object.hasOwn(config.appearance, 'spaceObjectIcons') ? config.appearance.spaceObjectIcons : retainedSpaceIconHandoff ?? persisted.spaceObjectIcons),
    toolkitPresentation: restoreToolkitPresentations(persisted.toolkitPresentation),
    toolsOpen: restoredBoolean(persisted.toolsOpen, true),
    workspaceTool: restoredWorkspaceTool(persisted.workspaceTool),
    workspaceGitView: restoreWorkspaceGitView(persisted.workspaceGitView),
    gitCommitDrafts: restoreGitCommitDrafts(persisted.gitCommitDrafts),
    projectRailWidth: clampProjectRailWidth(persisted.projectRailWidth ?? PROJECT_RAIL_DEFAULT_WIDTH),
    toolDockWidth: clampToolDockWidth(
      typeof persisted.toolDockWidth === 'number'
        ? persisted.toolDockWidth
        : TOOL_DOCK_DEFAULT_WIDTH
    ),
    editorWordWrap: restoredBoolean(persisted.editorWordWrap, false),
    editorMinimap: restoredBoolean(persisted.editorMinimap, false),
    explorerShowHidden: restoredBoolean(persisted.explorerShowHidden, true),
    explorerShowIgnored: restoredBoolean(persisted.explorerShowIgnored, true)
  }
}

// The durable-input whitelist lives here once. Runtime semantic changes retain these immutable
// references, so they can reuse the projection without visiting unrelated workbench / file content.
function selectPersistedInputs(state: AppState, coreSpatialReady: boolean) {
  return {
    workbenchSpaceSelection: state.workbenchSpaceSelection,
    projectGroups: coreSpatialReady ? undefined : state.projectGroups,
    spaceZoneBindings: coreSpatialReady ? undefined : state.spaceZoneBindings,
    spatialRequests: state.spatialRequests,
    goalAgentSelectionDrafts: state.goalAgentSelectionDrafts,
    goalFiniteStartIntents: state.goalFiniteStartIntents,
    goalAgentCreationDrafts: state.goalAgentCreationDrafts,
    retainedSpatialFocus: state.retainedSpatialFocus,
    connectorRoomIntents: state.connectorRoomIntents,
    connectorRoomDrafts: state.connectorRoomDrafts,
    continuityControlIntents: state.continuityControlIntents,
    conversationLandmarkIntents: state.conversationLandmarkIntents,
    connectorServiceIntents: state.connectorServiceIntents,
    mailboxNotificationIntents: state.mailboxNotificationIntents,
    moteBotRequests: state.moteBotRequests,
    botTaskSelections: state.botTaskSelections,
    manualConnectionIntents: state.manualConnectionIntents,
    manualConnectionSelections: state.manualConnectionSelections,
    moteConnectionSaveIntents: state.moteConnectionSaveIntents,
    moteChatIntents: state.moteChatIntents,
    agentComposerDrafts: state.agentComposerDrafts,
    agentLearningReviewDrafts: state.agentLearningReviewDrafts,
    capsuleQuestionEditors: state.capsuleQuestionEditors,
    browserOpinionDrafts: state.browserOpinionDrafts,
    agentComposerHistory: state.agentComposerHistory,
    launcherNameDrafts: state.launcherNameDrafts,
    launcherOptionDrafts: state.launcherOptionDrafts,
    agentComposerNotes: state.agentComposerNotes,
    // 排着的消息是用户亲手敲下的字，和草稿同一档事实——草稿重启后还在、排队的却没了，是把第 12 条
    // 反过来做。恢复后可投递性照旧在消费点按 runId 判（steerEntryTargetsRun）：对不上当前 run 的
    // 显示为不可投递、交给用户处置，内容不替用户丢掉。已消失的 session 留一条队列无害——它不投影
    // 到任何界面（没有对应 session），与上面 agentNames 同一个道理。
    agentSteerQueues: state.agentSteerQueues,
    questionReplies: state.questionReplies,
    questionReplyDrafts: state.questionReplyDrafts,
    documents: state.documents,
    retainedDocumentDrafts: state.retainedDocumentDrafts,
    noteBlockSelections: state.noteBlockSelections,
    noteCanvasLayouts: state.noteCanvasLayouts,
    dirtyDocuments: state.dirtyDocuments,
    tabs: coreSpatialReady ? undefined : state.tabs,
    layouts: coreSpatialReady ? undefined : state.layouts,
    unclaimedTerminalSessionIds: state.unclaimedTerminalSessionIds,
    // 拖出来的顺序是用户意图，重开应该还在。它只是偏好：恢复时对不上磁盘的条目会被 orderTopics 丢掉。
    scratchTopicOrder: state.scratchTopicOrder,
    workspaceAgentOrder: state.workspaceAgentOrder,
    recentMoteAgents: state.recentMoteAgents,
    // Agent 手改名是用户意图，重开要还在。key 是 session id；已消失的 session 留一条死名字无害——
    // 它不投影到任何界面（没有对应 session），随机对象 ID 再次碰撞的概率极低。
    agentNames: state.agentNames,
    // Only the original Session mode owner writes this map; read-only defaults remain derived.
    viewModes: state.viewModes,
    noticeReadReceipts: state.noticeReadReceipts,
    displacedAgentSessionIds: state.displacedAgentSessionIds,
    // These are Renderer presentation facts. They are deliberately persisted beside Workbench
    // topology, while PTY/Run/scrollback/Provider transcript state remains Core-owned.
    activeWorkspaceId: state.activeWorkspaceId,
    mainSurface: state.mainSurface,
    notebookRecoveries: state.notebookRecoveries,
    recallNotebookId: state.recallNotebookId, recallNoteId: state.recallNoteId,
    recallZoneSelection: state.recallZoneSelection, recallSidebarCollapsed: state.recallSidebarCollapsed, recallSidebarWidth: state.recallSidebarWidth,
    surveyZoneSelection: state.surveyZoneSelection,
    surveyCollectedZones: state.surveyCollectedZones,
    surveyOrganization: state.surveyOrganization,
    surveyExplorationNames: state.surveyExplorationNames,
    surveySidebarCollapsed: state.surveySidebarCollapsed,
    surveySidebarWidth: state.surveySidebarWidth,
    agentFocus: state.agentFocus,
    focusTimelineNameWidth: state.focusTimelineNameWidth,
    focusTimelineHeight: state.focusTimelineHeight,
    focusTimelineRuler: state.focusTimelineRuler,
    selectedDemandId: state.selectedDemandId,
    demandArrangement: state.demandArrangement,
    demandPmoTabIds: state.demandPmoTabIds,
    projectRailOpen: state.projectRailOpen,
    // 折叠了哪几组是用户意图，重开要还在。key 里带的是父目录路径——与同一份记录里已经逐字
    // 持久化的 file Region path 同一档事实，没有引入新的敏感面。
    collapsedProjectGroups: state.collapsedProjectGroups,
    // Explorer 折叠是用户意图，重开要还在。存的是显式覆盖（true/false 都进），缺席在读回侧另有含义。
    explorerCollapsed: state.explorerCollapsed,
    // pin 住的 Topic/Branch 是用户意图，重开要还在。key 是派生的 scope（Scratch id 或 [hostId,repoPath]），
    // 与已逐字持久化的 file Region path、collapsedProjectGroups 的目录 key 同一档事实，没有新增敏感面。
    pinnedItems: state.pinnedItems,
    ...(retainedSpaceIconHandoff === undefined ? {} : { spaceObjectIcons: retainedSpaceIconHandoff }),
    toolkitPresentation: state.toolkitPresentation,
    toolsOpen: state.toolsOpen,
    workspaceTool: state.workspaceTool,
    workspaceGitView: state.workspaceGitView,
    gitCommitDrafts: state.gitCommitDrafts,
    projectRailWidth: state.projectRailWidth,
    toolDockWidth: state.toolDockWidth,
    // 换行开关是一种查看偏好（像主题），重开要还在——与上面这些表面偏好同一档。
    editorWordWrap: state.editorWordWrap,
    editorMinimap: state.editorMinimap,
    explorerShowHidden: state.explorerShowHidden,
    explorerShowIgnored: state.explorerShowIgnored
  }
}

let previousPersistedInputs: ReturnType<typeof selectPersistedInputs> | null = null
let previousPersistedProjection: PersistedAppState | null = null

let previousCoreSpatialReady=false
function partializeAppState(state: AppState): PersistedAppState {
  const coreSpatialReady = Boolean(coreSpatialPersistence?.ready)
  const inputs = selectPersistedInputs(state, coreSpatialReady)
  if (previousPersistedInputs && previousPersistedProjection && previousCoreSpatialReady===coreSpatialReady && shallow(previousPersistedInputs, inputs)) {
    return previousPersistedProjection
  }
  const { tabs, layouts, projectGroups, spaceZoneBindings, documents, dirtyDocuments, ...presentation } = inputs
  const projection: PersistedAppState = {
    ...presentation,
    recallNotebookId: presentation.recallNotebookId, recallNoteId: presentation.recallNoteId,
    recallZoneSelection: persistedSurveyZoneSelection(presentation.recallZoneSelection),
    surveyZoneSelection: persistedSurveyZoneSelection(presentation.surveyZoneSelection),
    documents: Object.fromEntries(Object.entries(documents).filter(([key, document]) => dirtyDocuments[key] || document.noteConversion || document.noteEditing?.attempt || document.noteEditing?.input || document.noteEditing?.share || document.noteEditing?.shareUndo)),
    dirtyDocuments: Object.fromEntries(Object.entries(dirtyDocuments).filter(([, dirty]) => dirty)),
    ...(!coreSpatialReady ? { projectGroups: projectGroups!, spaceZoneBindings: spaceZoneBindings!,
      restoredWorkbench: projectPersistedWorkbench({ tabs: tabs!, layouts: layouts! }) } : {})
  }
  if (state.nameAuthorityRevision > 0) {
    // A name document revision confirms its exact targets, not an unrelated startup handoff.
    projection.agentNames = Object.fromEntries(Object.entries(projection.agentNames ?? {})
      .filter(([id]) => !Object.hasOwn(state.nameLabels, nameTargetKey({ kind: 'agent-session', id }))))
    projection.surveyExplorationNames = Object.fromEntries(Object.entries(projection.surveyExplorationNames ?? {})
      .filter(([id]) => !Object.hasOwn(state.nameLabels, nameTargetKey({ kind: 'zone', id }))))
    if (!Object.keys(projection.agentNames).length) delete projection.agentNames
    if (!Object.keys(projection.surveyExplorationNames).length) delete projection.surveyExplorationNames
  }
  previousCoreSpatialReady=coreSpatialReady
  previousPersistedInputs = inputs
  previousPersistedProjection = projection
  return projection
}

let coreSpatialPersistence:DesktopSpatialPersistence|null=null

/** Record the exact result of an admitted close/retirement before spatial capture.
 * Inventory absence and remote hydration never authorize entity removal here. */
function recordClosedWorkbenchEntities(before: Record<string, WorkbenchTab>, after: Record<string, WorkbenchTab>): void {
  if (before === after) return
  for (const tab of Object.values(before)) {
    const retained = after[tab.id]
    if (!retained) coreSpatialPersistence?.removeEntity(tab.id)
    else for (const regionId of Object.keys(tab.regions)) {
      if (!retained.regions[regionId]) coreSpatialPersistence?.removeEntity(regionId)
    }
  }
}
let disposeCoreSpatial:(()=>void)|null=null
export function currentDisplayNameRevision(kind: string, id: string): number {
  return projectedNameRevision(useAppStore.getState().nameLabels, kind, id)
}
function applyNameAcknowledgement(saved: import('@agentmux/core/spatial-graph').AgentMuxSpatialState): void {
  const current = useAppStore.getState(), names = acknowledgedNameProjection(saved, current.nameAuthorityRevision)
  // A watch read may project this revision before its write ACK. ACKs are a
  // separate, ephemeral fact; they cannot restore an older layout or label.
  const ack = saved.revision >= current.nameAcknowledgementRevision ? saved.nameCommit : undefined
  if (!names && !ack) return
  const nameSaveUnconfirmed = ack?.diskDurability === 'unconfirmed' && ack.applied
    ? { operationId: ack.operationId, target: ack.target, message: ack.issue ?? 'The name was applied; its disk confirmation is unknown.' }
    : ack?.diskDurability === 'confirmed' && ack.operationId === current.nameSaveUnconfirmed?.operationId ? null : current.nameSaveUnconfirmed
  let tabs = current.tabs
  if (names) {
    names.agentNames = { ...current.agentNames, ...names.agentNames }
    names.surveyExplorationNames = { ...current.surveyExplorationNames, ...names.surveyExplorationNames }
    for (const label of Object.values(names.nameLabels)) if (label.value === null) {
      if (label.target.kind === 'agent-session') delete names.agentNames[label.target.id]
      if (label.target.kind === 'zone') delete names.surveyExplorationNames[label.target.id]
    }
  }
  for (const label of Object.values(names?.nameLabels ?? {})) {
    if (label.target.kind !== 'tab' || !tabs[label.target.id]) continue
    const tab = tabs[label.target.id]!, renamed = renameWorkbenchTab(tab, label.value)
    if (renamed !== tab) tabs = { ...tabs, [tab.id]: renamed }
  }
  useAppStore.setState({ ...names, tabs, nameSaveUnconfirmed,
    ...(ack ? { nameAcknowledgementRevision: saved.revision } : {}) })
}
async function commitDisplayName(target: AgentMuxNameTarget, value: string | null,
  source: 'manual' | 'launch' | 'derived', expectedNameRevision = currentDisplayNameRevision(target.kind, target.id)):
  Promise<AgentMuxDisplayLabelResult> {
  // A new target needs registration; an existing name does not depend on unrelated layout writes.
  const operationId = mintObjectId()
  try {
    if (!coreSpatialPersistence) throw new Error('Name storage is unconfirmed. Original names and the running Agent are retained; restore storage and retry the edit.')
    const graph = coreSpatialPersistence.current?.graph
    const registered = currentDisplayNameRevision(target.kind, target.id) > 0 ||
      (target.kind === 'tab' && graph?.tabs.some(tab => tab.tabId === target.id)) ||
      (target.kind === 'zone' && graph?.zones.some(zone => zone.zoneId === target.id)) ||
      (target.kind === 'agent-session' && graph?.regions.some(region => region.agentSessionId === target.id))
    if (!registered) await coreSpatialPersistence.flush()
    const result = await api.spatial.renameLabel({ operationId, target,
      value: value?.trim() || null, source, expectedNameRevision })
    coreSpatialPersistence.acceptNames(result.state)
    applyNameAcknowledgement(result.state)
    if (!result.applied && source === 'manual') useAppStore.setState({ nameEditFailure: { operationId, target,
      message: [result.record.reason, result.issue].filter(Boolean).join(' ') || 'This name edit conflicted. Review the current name before making a new edit.' } })
    else if (result.applied && result.diskDurability !== 'confirmed') useAppStore.setState({ nameSaveUnconfirmed: { operationId: result.record.id,
      target: result.record.target, message: result.issue ?? 'The name was applied, but disk confirmation is unknown. Keep it and inspect its name record before making a new edit.' } })
    else if (result.applied && source === 'manual') {
      const failed = useAppStore.getState().nameEditFailure
      if (failed?.target.kind === target.kind && failed.target.id === target.id) useAppStore.setState({ nameEditFailure: null })
    }
    return result
  } catch (error) {
    if (source === 'manual') useAppStore.setState({ nameEditFailure: { operationId, target,
      message: `This edit has no confirmed result: ${presentError(error)}. Review the current name, then make a new edit; the running Agent remains available.` } })
    throw error
  }
}

const agentRegionExecutionIndex = new WeakMap<readonly import('@agentmux/core/spatial-graph').AgentMuxSpatialGraph['regions'][number][], Map<string, import('@agentmux/core/spatial-graph').AgentMuxSpatialGraph['regions'][number]>>()

export type AgentRegionReference = { tabId: string; regionId: string; agentSessionId: string }

/** The existing Core document owns execution identity; display placement never supplies a Host. */
export function agentRegionExecution(reference: AgentRegionReference) {
  const regions = coreSpatialPersistence?.current?.graph.regions
  if (!regions) return null
  let byRegion = agentRegionExecutionIndex.get(regions)
  if (!byRegion) {
    byRegion = new Map(regions.map(region => [JSON.stringify([region.tabId, region.regionId]), region]))
    agentRegionExecutionIndex.set(regions, byRegion)
  }
  const region = byRegion.get(JSON.stringify([reference.tabId, reference.regionId]))
  return region?.kind === 'agent' && region.agentSessionId === reference.agentSessionId ? region.execution ?? null : null
}

/** An explicit related reader refreshes the original owner, without applying or resaving the graph. */
export async function rereadAgentRegionExecution(reference: AgentRegionReference) {
  const owner = coreSpatialPersistence
  if (!owner) throw new Error('The original Core spatial owner is not available. Its Region is retained.')
  await owner.read()
  if (coreSpatialPersistence !== owner) throw new Error('The original Core spatial owner changed during observation. Its Region is retained; re-read the current owner.')
  return agentRegionExecution(reference)
}

/** Project only the exact observed Session through the existing launch reducer. */
export function adoptAgentRegionObservation(reference: AgentRegionReference & { hostId: string }, result: AgentLaunchResult) {
  useAppStore.setState(state => {
    const region = state.tabs[reference.tabId]?.regions[reference.regionId]
    const session = result.session
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, reference.tabId) ||
      region?.kind !== 'agent' || region.sessionId !== reference.agentSessionId ||
      session?.kind !== 'agent' || session.id !== reference.agentSessionId || session.control.hostId !== reference.hostId)
      throw new Error('The original Region or Session changed during observation. Its work is retained.')
    return reduceDetachedAgentLaunch(state, result).state
  })
}

function confirmedSurveyZones(state: AppState): (zoneId: string) => boolean {
  let confirmed: Set<string> | undefined
  return zoneId => {
    if (!confirmed) {
      const scratch = state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
      const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scratch) ?? []
      confirmed = new Set(spatialCatalog(state, topics).zones.filter(zone => zone.kind !== 'unknown').map(zone => zone.zoneId))
    }
    return confirmed.has(zoneId)
  }
}

const nonBrowserWorkbenchStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined
}

function workbenchStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  return typeof window === 'undefined' ? nonBrowserWorkbenchStorage : window.localStorage
}

// A failed hydration must not be followed by the initial `set(...)` overwriting the only durable
// copy of the user's layout with an empty default. Reads remain available while hydration runs;
// writes are opened only after startup has either loaded the record or explicitly finished with a
// visible warning. This is a narrow write fence, not a second persistence store.
//
// 闸本身住在 lib 里（`createWriteFencedStorage`）：留在这个模块里时它是一个 `let` 加一行 `if`，
// 于是「闸关着时写入真的被拦了吗」在测试里不可观测，只能靠扫源码文本判断那个名字还在——实测把
// 那行 `if` 删掉，五个持久化测试文件 62 条全绿。这里剩下的只有转发，没有可以被掏空的判断。
const persistentWorkbenchStorage = createDebouncedPersistentStorage<PersistedAppState>({
  getItem: (name) => workbenchStorage().getItem(name),
  setItem: (name, value) => {
    workbenchStorage().setItem(name, value)
    requestWorkbenchStorageCommit()
  },
  removeItem: (name) => {
    const storage = workbenchStorage()
    if (storage.getItem(name) === null) return
    storage.removeItem(name)
    requestWorkbenchStorageCommit()
  }
})

// The writer batches real presentation changes before this boundary. A visible localStorage value
// is not a cross-process durability receipt; ask its existing platform owner to commit that batch.
// Failure is advisory: retain the written state and retry on the next real storage mutation.
// Temporary custody of original local bytes until the original Main owner confirms handoff.
// It is not a second editable store; canonical presence, including {}, always wins.
let retainedSpaceIconHandoff: unknown = undefined
const spaceIconSaveRequests = new Map<string, object>()
async function readCurrentSpaceIconConfig(): Promise<AppConfig | null> {
  const beforeRead = useAppStore.getState().config
  const observed = await api.config.get().catch(() => null)
  const current = useAppStore.getState().config
  return current !== beforeRead && current !== null ? current : observed
}
function spaceIconRecordWarning(value: unknown): string | null {
  const { invalidKeys } = inspectSpaceIconOverrides(value)
  return invalidKeys.length ? `${invalidKeys.length} saved avatar record(s) could not be displayed. Original records are retained in configuration; other avatars and work remain available.` : null
}
async function handoffSpaceIcons(config: AppConfig): Promise<{ config: AppConfig; warning: string | null }> {
  if (Object.hasOwn(config.appearance, 'spaceObjectIcons')) {
    retainedSpaceIconHandoff = undefined
    return { config, warning: spaceIconRecordWarning(config.appearance.spaceObjectIcons) }
  }
  const original = retainedSpaceIconHandoff
  if (original === undefined) return { config, warning: null }
  if (!original || typeof original !== 'object' || Array.isArray(original)) return { config,
    warning: 'Saved local avatar records could not be read. Their original bytes are retained; other work remains available.' }
  const next = { ...config, appearance: { ...config.appearance, spaceObjectIcons: original as Record<string, unknown> } }
  try {
    let saved: AppConfig
    try { saved = await api.config.save(next, config) }
    catch (cause) {
      // A lost receipt is not a failed write. Read the same owner, without blindly replaying.
      const observed = await readCurrentSpaceIconConfig()
      if (!observed || !Object.hasOwn(observed.appearance, 'spaceObjectIcons')) throw cause
      saved = observed
    }
    retainedSpaceIconHandoff = undefined
    return { config: saved, warning: spaceIconRecordWarning(saved.appearance.spaceObjectIcons) }
  } catch (cause) { return { config, warning: 'Avatar preservation is unconfirmed. Original local choices are retained; reopen avatar settings after restoring configuration access. ' + presentError(cause) } }
}
let workbenchSaveRequest = 0
let workbenchSaveFailureRevision = 0
let spatialSaveRequest = 0
let localSaveRequest = 0
async function requestWorkbenchStorageFlush(includeSpatial = true): Promise<void> {
  ++workbenchSaveRequest
  const failureRevision = workbenchSaveFailureRevision
  const request = includeSpatial ? ++spatialSaveRequest : ++localSaveRequest
  const current = () => request === (includeSpatial ? spatialSaveRequest : localSaveRequest)
  try {
    if (includeSpatial) await coreSpatialPersistence?.flush()
    await api.ui.requestStorageFlush()
    if (current() && failureRevision === workbenchSaveFailureRevision &&
        (includeSpatial || useAppStore.getState().workbenchSaveWarningOwner === 'local-storage')) {
      useAppStore.setState({ workbenchSaveWarning: null, workbenchSaveWarningOwner: null })
    }
  } catch (error) {
    if (current()) useAppStore.getState().reportWorkbenchSaveFailure(error, includeSpatial ? 'workbench' : 'local-storage')
    throw error
  }
}
async function saveWorkbenchSelection(layoutApplied: boolean): Promise<AgentMuxSpatialSave> {
  let localStorageWritten = false, storageFlushRequested = false, reason: string | null = null
  try {
    if (!workbenchWriteFence.isOpen()) throw new Error('The saved Workbench is still being restored.')
    persistentWorkbenchStorage.flush()
    localStorageWritten = true
    await requestWorkbenchStorageFlush()
    storageFlushRequested = true
  } catch (error) { reason = presentError(error); useAppStore.getState().reportWorkbenchSaveFailure(error) }
  return { layoutApplied, localStorageWritten, storageFlushRequested, diskDurability: storageFlushRequested && coreSpatialPersistence?.ready ? 'confirmed' : 'unconfirmed', reason }
}

/** Explicit per-tool palette save; command configuration and Run identity are untouched. */
export async function saveToolkitPalette(toolId: string, theme: import('../../shared/contracts').TerminalThemeId | null,
  expected: import('../../shared/contracts').TerminalThemeId | null): Promise<void> {
  const current = useAppStore.getState().toolkitPresentation[toolId]?.theme ?? null
  if (current !== expected && current !== theme) throw new Error('This tool’s saved palette changed elsewhere. Restore the current choice before saving again.')
  useAppStore.setState(state => ({ toolkitPresentation: updateToolkitPresentation(state.toolkitPresentation, toolId, { theme }) }))
  try {
    if (!workbenchWriteFence.isOpen()) throw new Error('The saved Workbench is still being restored. Your palette choice is kept.')
    const before = workbenchSaveRequest
    persistentWorkbenchStorage.flush()
    // A local preference does not write Core topology. Await the exact platform
    // commit already requested by the original local writer; retry if no bytes changed.
    await (workbenchSaveRequest === before ? requestWorkbenchStorageFlush(false) : workbenchStorageCommit)
  } catch (cause) { useAppStore.getState().reportWorkbenchSaveFailure(cause, 'local-storage'); throw cause }
  if ((useAppStore.getState().toolkitPresentation[toolId]?.theme ?? null) !== theme) throw new Error('This tool’s palette changed while saving. Your newer choice is kept.')
}

/** Save only this review's user input. A durable request reference never authorizes dispatch. */
export async function retainAgentLearningReviewDraft(draft: AgentLearningReviewDraft, flush = false): Promise<void> {
  const key = learningReviewKey(draft.source), retained = restoredLearningReviewDrafts({ [key]: draft })[key]
  if (!retained) throw new Error('The original review draft reference is invalid. Its input is kept without dispatch.')
  useAppStore.setState(state => ({ agentLearningReviewDrafts: { ...state.agentLearningReviewDrafts, [key]: retained } }))
  if (flush) await flushMessageWorkbench(false)
}

/** Only local editable bytes and exact original operation handles use the existing Workbench writer. */
export function compareAndSwapCapsuleQuestionEditor(key: string, expected: CapsuleQuestionEditor | undefined, value: CapsuleQuestionEditor | undefined): boolean {
  let changed = false
  useAppStore.setState(state => {
    if (state.capsuleQuestionEditors[key] !== expected) return state
    changed = true
    const editors = { ...state.capsuleQuestionEditors }
    if (value) editors[key] = value
    else delete editors[key]
    return { capsuleQuestionEditors: editors }
  })
  return changed
}
export async function flushCapsuleQuestionEditors(): Promise<void> { await flushMessageWorkbench(false) }

/** Editing an answer draft never replaces its original submitted intent. */
export function retainConversationQuestionDraft(sessionId: string, key: string, answers: DesktopQuestionReplyAttempt['input']['answers']): void {
  const captured = structuredClone(answers)
  useAppStore.setState(state => ({ questionReplyDrafts: { ...state.questionReplyDrafts, [sessionId]: { ...state.questionReplyDrafts?.[sessionId], [key]: captured } } }))
  void flushMessageWorkbench(true)
}
/** The existing workbench writer retains one exact native-question intent before explicit input. */
export async function retainConversationQuestionReply(sessionId: string, key: string, attempt: DesktopQuestionReplyAttempt,
  expected: DesktopQuestionReplyAttempt | undefined): Promise<void> {
  let admitted = false
  useAppStore.setState(state => {
    if (state.questionReplies?.[sessionId]?.[key] !== expected) return state
    admitted = true
    return { questionReplies: { ...state.questionReplies, [sessionId]: { ...state.questionReplies?.[sessionId], [key]: attempt } } }
  })
  if (!admitted) throw new Error('The original question reply record changed; this callback cannot replace it.')
  await flushMessageWorkbench(false)
}
/** Admit only the chosen recipient's correlation to the existing intent owner before queue input. */
export async function retainRecoveryMessageIntent(binding: SpatialRequestBinding): Promise<AgentMuxSpatialSave | null> {
  if (binding.operation !== 'agent.message' || binding.createAgent || !binding.recoveryRecipient || !binding.recovery) throw new Error('An exact recovery message reference is required.')
  if (useAppStore.getState().spatialRequests[binding.requestId]) return null
  useAppStore.setState(state => ({ spatialRequests: { ...state.spatialRequests, [binding.requestId]: binding } }))
  return await saveWorkbenchSelection(false)
}
/** Advance the same Browser creation admission before handoff or first input. */
export async function retainBrowserAgentIntent(requestId: string, expected: NonNullable<SpatialRequestBinding['browserAgent']>,
  next: NonNullable<SpatialRequestBinding['browserAgent']>): Promise<void> {
  let changed = false
  useAppStore.setState(state => {
    const binding = state.spatialRequests[requestId]
    if (binding?.purpose !== 'browser-agent' || binding.browserAgent !== expected) return state
    changed = true
    return { spatialRequests: { ...state.spatialRequests, [requestId]: { ...binding, browserAgent: next } } }
  })
  if (!changed) throw new Error('The original Browser Agent intent changed. Inspect that same request; its Agent and page are kept.')
  const saved = await saveWorkbenchSelection(false)
  if (!saved.localStorageWritten) throw new Error('The Browser Agent intent could not be saved. No further handoff or input was dispatched.')
}
/** Retain one unresolved exact reading-point input in the existing workbench draft writer. */
export async function retainConversationLandmarkIntent(input: ConversationLandmarkWrite): Promise<AgentMuxSpatialSave> {
  const parsed = parseConversationLandmarkWrite(input), key = conversationLandmarkIntentKey(parsed)
  const previous = useAppStore.getState().conversationLandmarkIntents?.[key]
  if (previous && JSON.stringify(previous) !== JSON.stringify(parsed)) throw new Error('The original reading-point intent is unresolved. Inspect it without replacing its source or operation.')
  useAppStore.setState(state => ({ conversationLandmarkIntents: { ...state.conversationLandmarkIntents, [key]: parsed } }))
  return await saveWorkbenchSelection(false)
}
export async function clearConversationLandmarkIntent(input: ConversationLandmarkWrite): Promise<void> {
  const key = conversationLandmarkIntentKey(input)
  useAppStore.setState(state => {
    if (state.conversationLandmarkIntents?.[key]?.operationId !== input.operationId) return state
    const conversationLandmarkIntents = { ...state.conversationLandmarkIntents }; delete conversationLandmarkIntents[key]
    return { conversationLandmarkIntents }
  })
  await saveWorkbenchSelection(false)
}
/** Preserve the exact submitted connector operation before its original public effect. */
export async function retainConnectorRoomIntent(intent: ConnectorRoomIntent): Promise<AgentMuxSpatialSave> {
  const parsed = restoredConnectorRoomIntents({ [intent.input.operationId]: intent })[intent.input.operationId]
  if (!parsed) throw new Error('The exact original connector intent is required.')
  const previous = useAppStore.getState().connectorRoomIntents[intent.input.operationId]
  if (previous && JSON.stringify({ ...previous, phase: parsed.phase }) !== JSON.stringify(parsed)) throw new Error('Inspect the original connector operation without replacing its target or input.')
  useAppStore.setState(state => ({ connectorRoomIntents: { ...state.connectorRoomIntents, [parsed.input.operationId]: parsed } }))
  return await saveWorkbenchSelection(false)
}
export async function clearConnectorRoomIntent(operationId: string): Promise<void> {
  useAppStore.setState(state => { const connectorRoomIntents = { ...state.connectorRoomIntents }; delete connectorRoomIntents[operationId]; return { connectorRoomIntents } })
  await saveWorkbenchSelection(false)
}
/** Retain the exact service request through the original workbench writer before dispatch. */
export async function retainConnectorServiceIntent(intent: ConnectorServiceIntent): Promise<AgentMuxSpatialSave> {
  const parsed = restoredConnectorServiceIntents({ [intent.input.operationId]: intent })[intent.input.operationId]
  if (!parsed) throw new Error('The exact original Connector service input is required.')
  const previous = useAppStore.getState().connectorServiceIntents[intent.input.operationId]
  if (previous && JSON.stringify([previous.input, previous.hostingTarget]) !== JSON.stringify([parsed.input, parsed.hostingTarget])) throw new Error('The original Connector service input cannot be replaced. Inspect that request separately.')
  useAppStore.setState(state => ({ connectorServiceIntents: { ...state.connectorServiceIntents, [parsed.input.operationId]: parsed } }))
  return await saveWorkbenchSelection(false)
}
/** Keep the original notification identity before dispatch; Core alone owns the receipt. */
export async function retainMailboxNotificationIntent(intent: MailboxNotificationIntent): Promise<AgentMuxSpatialSave> {
  const subject = mailboxNotificationSubject(intent), key = mailboxNotificationIntentKey(intent)
  const parsed = restoredMailboxNotificationIntents({ [subject]: { [key]: intent } })[subject]?.[key]
  if (!parsed) throw new Error('The original notification target and operation are required.')
  const previous = useAppStore.getState().mailboxNotificationIntents[subject]?.[key]
  if (previous && JSON.stringify(previous) !== JSON.stringify(parsed)) throw new Error('Keep the original notification target and operation unchanged.')
  useAppStore.setState(state => ({ mailboxNotificationIntents: { ...state.mailboxNotificationIntents,
    [subject]: { ...state.mailboxNotificationIntents[subject], [key]: parsed } } }))
  return await saveWorkbenchSelection(false)
}
/** Save the exact client request before a Mote effect; receipts remain with the original public owner. */
export async function retainMoteBotRequest(request: MoteBotRequest): Promise<AgentMuxSpatialSave> {
  const parsed = restoredMoteBotRequests({ [request.input.operationId]: request })[request.input.operationId]
  if (!parsed) throw new Error('The original Mote bot request is required.')
  const previous = useAppStore.getState().moteBotRequests[parsed.input.operationId]
  if (previous && (previous.action !== parsed.action || JSON.stringify(previous.input) !== JSON.stringify(parsed.input) || JSON.stringify(previous.hostingTarget) !== JSON.stringify(parsed.hostingTarget)))
    throw new Error('The original Mote bot request cannot be replaced.')
  useAppStore.setState(state => ({ moteBotRequests: { ...state.moteBotRequests, [parsed.input.operationId]: parsed } }))
  return await saveWorkbenchSelection(false)
}
/** Retire only a prepared body correlated with the original Host admission; receipts remain on that owner. */
export async function retireMoteBotRequest(request: MoteBotRequest, operation: import('@agentmux/core/mote-connections').MoteConnectionOperation): Promise<AgentMuxSpatialSave | null> {
  if (request.inspectOnly) return null
  const { parseMoteConnectionResult } = await import('@agentmux/core/mote-connections')
  if (request.action === 'create') parseMoteConnectionResult('space.mote.connection.create', operation, request.input)
  else parseMoteConnectionResult('space.mote.connection.sync', operation, request.input)
  const previous = useAppStore.getState().moteBotRequests[request.input.operationId]
  if (!previous || previous.action !== request.action || JSON.stringify(previous.input) !== JSON.stringify(request.input) || JSON.stringify(previous.hostingTarget) !== JSON.stringify(request.hostingTarget)) return null
  useAppStore.setState(state => {
    const requests = { ...state.moteBotRequests }
    delete requests[request.input.operationId]
    return { moteBotRequests: requests }
  })
  return await saveWorkbenchSelection(false)
}
/** Remember only which original task to read; selection never dispatches its input. */
export function setBotTaskSelection(scope: BotTaskScope, selection: string | BotTaskLocator | null): Promise<AgentMuxSpatialSave> | undefined {
  const key = botTaskSelectionKey(scope), current = useAppStore.getState().botTaskSelections
  if (selection !== null && !restoredBotTaskSelections({ [key]: selection })[key]) throw new Error('The original bot task locator is invalid.')
  const previous = readBotTaskLocator(current[key]), next = readBotTaskLocator(selection)
  if (previous && next && previous.operationId === next.operationId && JSON.stringify(previous.hostingTarget) !== JSON.stringify(next.hostingTarget))
    throw new Error('Keep this task’s original bot hosting owner. An unconfirmed old owner cannot be replaced by the current Host.')
  if ((JSON.stringify(current[key]) === JSON.stringify(selection) || selection === null && !Object.hasOwn(current, key)) && (scope.kind !== 'management' || selection === null || current.management === key)) return
  const selections = { ...current }
  if (selection === null) delete selections[key]
  else selections[key] = structuredClone(selection)
  if (scope.kind === 'management' && selection !== null) selections.management = key
  useAppStore.setState({ botTaskSelections: selections })
  return saveWorkbenchSelection(false)
}
/** An explicit effect intent awaits this original writer, including a retry of an unchanged locator. */
export async function retainBotTaskSelection(scope: BotTaskScope, selection: string | BotTaskLocator): Promise<AgentMuxSpatialSave> {
  return await (setBotTaskSelection(scope, selection) ?? saveWorkbenchSelection(false))
}
/** UI owner selection only; each pending request keeps its own independent frozen target. */
export function selectManualConnectionOwner(channel: ManualConnectionIntent['channel'], target: ManualConnectionIntent['target']): void {
  useAppStore.setState(state => ({ manualConnectionSelections: { ...state.manualConnectionSelections, [channel]: target } }))
  void saveWorkbenchSelection(false)
}
/** Retain only this Settings request/draft; all results remain on the original Host. */
export async function retainManualConnectionIntent(intent: ManualConnectionIntent, confirmedOperationId?: string): Promise<AgentMuxSpatialSave> {
  const key = manualConnectionScope(intent.channel, intent.target)
  const parsed = restoredManualConnectionIntents({ [key]: intent })[key]
  if (!parsed) throw new Error("The original manual connection intent is invalid.")
  const original = useAppStore.getState().manualConnectionIntents[key]
  // Saved-view/configuration updates cannot replace independently retained member requests.
  if (original?.applicationAccess) parsed.applicationAccess = original.applicationAccess
  const previous = original?.pending
  if (previous && confirmedOperationId !== undefined && confirmedOperationId !== previous.operationId) throw new Error('The confirmed save belongs to another original request.')
  if (previous && confirmedOperationId === undefined) {
    if (!parsed.pending) parsed.pending = previous
    else {
      if (previous.operationId !== parsed.pending.operationId || JSON.stringify({ ...previous, connection: { ...previous.connection, credentialRef: undefined } }) !== JSON.stringify({ ...parsed.pending, connection: { ...parsed.pending.connection, credentialRef: undefined } }) || previous.connection.credentialRef && parsed.pending.connection.credentialRef && previous.connection.credentialRef !== parsed.pending.connection.credentialRef) throw new Error("The original connection save cannot be replaced.")
      if (previous.connection.credentialRef) parsed.pending.connection.credentialRef = previous.connection.credentialRef
    }
  }
  useAppStore.setState(state => ({ manualConnectionIntents: { ...state.manualConnectionIntents, [key]: parsed } }))
  return await saveWorkbenchSelection(false)
}
/** Same Settings continuation owner and writer; these drafts never become access facts. */
export async function retainManualApplicationAccess(intent: ManualConnectionIntent, update: (current: ApplicationAccessContinuation) => ApplicationAccessContinuation, flush = false): Promise<AgentMuxSpatialSave | undefined> {
  const key = manualConnectionScope(intent.channel, intent.target)
  const parsed = restoredManualConnectionIntents({ [key]: intent })[key]
  if (!parsed) throw new Error('The original application settings target is required.')
  useAppStore.setState(state => {
    const original = state.manualConnectionIntents[key] ?? parsed
    const applicationAccess = restoredApplicationAccess(update(original.applicationAccess ?? emptyApplicationAccess()))
    return { manualConnectionIntents: { ...state.manualConnectionIntents, [key]: { ...original, applicationAccess } } }
  })
  if (flush) return await saveWorkbenchSelection(false)
}
/** Retain the exact submitted file input; this is neither a preference nor an effect journal. */
export async function retainMoteConnectionSaveIntent(intent: MoteConnectionSaveIntent): Promise<AgentMuxSpatialSave> {
  const parsed = restoredMoteConnectionSaveIntents({ [intent.input.operationId]: intent })[intent.input.operationId]
  if (!parsed) throw new Error('The exact original Mote preference input is required.')
  const previous = useAppStore.getState().moteConnectionSaveIntents[intent.input.operationId]
  if (previous && JSON.stringify([previous.input, previous.hostingTarget]) !== JSON.stringify([parsed.input, parsed.hostingTarget])) throw new Error('The original Mote save input and hosting owner cannot be replaced.')
  useAppStore.setState(state => ({ moteConnectionSaveIntents: { ...state.moteConnectionSaveIntents, [parsed.input.operationId]: parsed } }))
  return await saveWorkbenchSelection(false)
}
export async function clearMoteConnectionSaveIntent(operationId: string): Promise<void> {
  useAppStore.setState(state => { const moteConnectionSaveIntents = { ...state.moteConnectionSaveIntents }; delete moteConnectionSaveIntents[operationId]; return { moteConnectionSaveIntents } })
  await saveWorkbenchSelection(false)
}
/** Retain the exact private-chat write before dispatch, without mirroring its owner result. */
export async function retainMoteChatIntent(intent: MoteChatIntent): Promise<AgentMuxSpatialSave> {
  const parsed = restoredMoteChatIntents({ [intent.input.operationId]: intent })[intent.input.operationId]
  if (!parsed) throw new Error('The exact original Mote chat input is required.')
  const previous = useAppStore.getState().moteChatIntents[parsed.input.operationId]
  if (previous && (previous.method !== parsed.method || JSON.stringify(previous.input) !== JSON.stringify(parsed.input) || JSON.stringify(previous.hostingTarget) !== JSON.stringify(parsed.hostingTarget)))
    throw new Error('The original Mote chat request cannot be replaced.')
  useAppStore.setState(state => ({ moteChatIntents: { ...state.moteChatIntents, [parsed.input.operationId]: parsed } }))
  return await saveWorkbenchSelection(false)
}
export async function clearMoteChatIntent(operationId: string): Promise<void> {
  useAppStore.setState(state => { const moteChatIntents = { ...state.moteChatIntents }; delete moteChatIntents[operationId]; return { moteChatIntents } })
  await saveWorkbenchSelection(false)
}
/** Retain the chosen Goal and original operation before dispatch; this never creates or sends. */
export async function retainGoalAgentSelectionDraft(draft: GoalAgentSelectionDraft): Promise<AgentMuxSpatialSave> {
  const key = goalCreationDraftKey(draft.goalId, draft.role)
  useAppStore.setState(state => ({ goalAgentSelectionDrafts: { ...state.goalAgentSelectionDrafts, [key]: draft } }))
  return await saveWorkbenchSelection(false)
}
export async function clearGoalAgentSelectionDraft(goalId: string, role: GoalAgentSelectionDraft['role']): Promise<void> {
  const key = goalCreationDraftKey(goalId, role)
  useAppStore.setState(state => { const goalAgentSelectionDrafts = { ...state.goalAgentSelectionDrafts }; delete goalAgentSelectionDrafts[key]; return { goalAgentSelectionDrafts } })
  await saveWorkbenchSelection(false)
}
export async function retainGoalFiniteStartIntent(intent: GoalFiniteStartIntent): Promise<AgentMuxSpatialSave> {
  const original = useAppStore.getState().goalFiniteStartIntents[intent.goalId]
  if (original && original.operationId !== intent.operationId) throw new Error('Inspect the original Goal Start before starting another task. The Agent remains available.')
  useAppStore.setState(state => ({ goalFiniteStartIntents: { ...state.goalFiniteStartIntents, [intent.goalId]: intent } }))
  return await saveWorkbenchSelection(false)
}
export async function clearGoalFiniteStartIntent(goalId: string, operationId: string): Promise<void> {
  useAppStore.setState(state => {
    if (state.goalFiniteStartIntents[goalId]?.operationId !== operationId) return state
    const goalFiniteStartIntents = { ...state.goalFiniteStartIntents }; delete goalFiniteStartIntents[goalId]
    return { goalFiniteStartIntents }
  })
  await saveWorkbenchSelection(false)
}

export async function retainGoalAgentCreationDraft(draft: GoalAgentCreationDraft): Promise<AgentMuxSpatialSave> {
  const key = goalCreationDraftKey(draft.goalId, draft.role), original = useAppStore.getState().goalAgentCreationDrafts[key]
  if (original && original.operationId !== draft.operationId) throw new Error('An original creation is retained. Inspect that operation before creating another Agent for this selection.')
  useAppStore.setState(state => ({ goalAgentCreationDrafts: { ...state.goalAgentCreationDrafts, [key]: draft } }))
  return await saveWorkbenchSelection(false)
}
export async function clearGoalAgentCreationDraft(goalId: string, role: 'assignees' | 'related', operationId: string): Promise<void> {
  const key = goalCreationDraftKey(goalId, role)
  useAppStore.setState(state => {
    if (state.goalAgentCreationDrafts[key]?.operationId !== operationId) return state
    const goalAgentCreationDrafts = { ...state.goalAgentCreationDrafts }; delete goalAgentCreationDrafts[key]
    return { goalAgentCreationDrafts }
  })
  await saveWorkbenchSelection(false)
}
function agentDisplayOverride(names: Record<string, string>, sessionId: string): string | null {
  return Object.hasOwn(names, sessionId) ? names[sessionId] ?? null : null
}
let workbenchStorageCommit: Promise<void> = Promise.resolve()
function requestWorkbenchStorageCommit(): void {
  workbenchStorageCommit = requestWorkbenchStorageFlush(false)
  void workbenchStorageCommit.catch(() => {})
}
/** A failed preference save leaves the current view usable and the original writer pending. */
async function flushWorkbenchPresentation(): Promise<void> {
  try {
    if (!workbenchWriteFence.isOpen()) throw new Error('Current workbench changes cannot be saved yet.')
    const requestBeforeFlush = workbenchSaveRequest
    persistentWorkbenchStorage.flush()
    // Writing a pending value already requests its platform commit once.
    if (workbenchSaveRequest === requestBeforeFlush) requestWorkbenchStorageCommit()
  } catch (error) { useAppStore.getState().reportWorkbenchSaveFailure(error) }
}
// Only a captured, already-bound explicit message treats presentation saving as advisory.
// Core admission remains the durable Input owner; automatic/recovery paths retain their fence.
async function flushMessageWorkbench(explicitlyBound: boolean): Promise<void> {
  if (explicitlyBound) {
    await flushWorkbenchPresentation()
    return
  }
  if (!workbenchWriteFence.isOpen()) throw new Error(
    'Saved workbench storage is unavailable. Your execution intent is kept without dispatch.')
  persistentWorkbenchStorage.flush()
  await api.ui.requestStorageFlush()
}
const workbenchWriteFence = createWriteFencedStorage(persistentWorkbenchStorage.storage)

/** 放行持久化写入。启动路径上的两个开启点都只走这一处。 */
function openPersistWrites(): void {
  workbenchWriteFence.openWrites()
  // Startup installed the restored state while writes were fenced. Admit that state now, rather than
  // retaining an earlier default write until the fence opens or relying on a later Runtime event.
  useAppStore.setState(useAppStore.getState())
}

// Renderer-side trailing flush on unload: force any debounced layout write to disk now so a quit or
// navigation mid-drag still keeps the last layout change. This complements the main process's
// `session.flushStorageData()` on window close — this lands the debounced value into localStorage,
// and main forces Chromium's async localStorage buffer to disk. A DOM-less environment gets a no-op.
if (typeof window !== 'undefined') {
  registerUnloadFlush(() => persistentWorkbenchStorage.flush())
}

let persistHydrationPromise: Promise<void> | null = null
let persistHydrationError: unknown | null = null

/**
 * Persist hydration is an input to startup recovery, not a background UI nicety. Zustand starts
 * hydration asynchronously, so reading `restoredWorkbench` before this barrier can make a cold
 * launch look like a brand-new window and permanently skip Agent recovery for that launch.
 *
 * Keep one in-flight promise so React StrictMode or another startup caller cannot trigger two
 * storage reads. The promise is cleared after settlement to allow an explicit later rehydrate
 * (for example after a storage repair) without keeping a stale promise forever.
 */
async function ensurePersistHydrated(): Promise<unknown | null> {
  if (useAppStore.persist.hasHydrated()) return null
  if (!persistHydrationPromise) {
    persistHydrationError = null
    persistHydrationPromise = Promise.resolve()
      .then(() => useAppStore.persist.rehydrate())
      .catch((error: unknown) => {
        // A broken storage layer is a Renderer workflow failure, not proof that a healthy Agent is
        // dead. Keep startup moving with the in-memory defaults and leave a durable, visible warning
        // on the completed shell below.
        persistHydrationError = error
      })
      .then(() => {
        if (!useAppStore.persist.hasHydrated() && !persistHydrationError) {
          persistHydrationError = new Error('Persisted Renderer state could not be hydrated.')
        }
      })
      .finally(() => { persistHydrationPromise = null })
  }
  await persistHydrationPromise
  return persistHydrationError
}

function restoredMainSurface(candidate: unknown): MainSurface {
  if (candidate === 'recall') return 'recall'
  if (candidate === 'survey') return 'survey'
  if (candidate === 'agents') return 'agents'
  return candidate === 'board' ? 'board' : 'workbench'
}

function restoredWorkspaceTool(candidate: unknown): WorkspaceTool {
  return typeof candidate === 'string' &&
    (WORKSPACE_TOOL_IDS as readonly string[]).includes(candidate)
    ? candidate as WorkspaceTool
    : 'files-branches'
}

function restoredBoolean(candidate: unknown, fallback: boolean): boolean {
  return typeof candidate === 'boolean' ? candidate : fallback
}



function admitAgentSteer(sessionId: string, text: string, onRejected?: (error: unknown) => void, operationId: string = mintObjectId(), origin?: 'manual', agentMuxNote?: string, options?: AgentSteerOptions, directInputBinding?: AgentSteerQueueEntry['directInputBinding']): string | false {
  if (!text.trim() && !agentMuxNote?.trim()) return false
  const session = useAppStore.getState().sessions.find((item) => item.id === sessionId)
  if (!session || session.kind !== 'agent') return false
  const browserRecipient = options?.browserRecipient ?? options?.browserInput?.control
  if (browserRecipient && (origin !== 'manual' || browserRecipient.hostId !== session.control.hostId ||
      browserRecipient.agentSessionId !== session.control.agentSessionId || browserRecipient.run.runId !== session.control.run.runId)) {
    (onRejected ?? useAppStore.getState().reportError)(new Error('The original Browser recipient changed. Your draft is kept; no current recipient was substituted.'))
    return false
  }
  let browserInput: BrowserCapturedInput | undefined
  if (options?.browserInput) {
    try {
      browserInput = frozenBrowserInput(options.browserInput, sessionId, operationId, text, agentMuxNote)
      if (origin !== 'manual' || browserInput.control.hostId !== session.control.hostId ||
          browserInput.control.agentSessionId !== session.control.agentSessionId || browserInput.control.run.runId !== session.control.run.runId) {
        throw new Error('The original recipient Run changed. Your draft and captured page are kept; choose a new recipient explicitly before sending another message.')
      }
    } catch (error) { (onRejected ?? useAppStore.getState().reportError)(error); return false }
  }
  const existing = useAppStore.getState().agentSteerQueues[sessionId]?.find(entry => entry.operationId === operationId)
  if (existing) {
    if (existing.text === text && existing.agentMuxNote === agentMuxNote && JSON.stringify(existing.browserInput) === JSON.stringify(browserInput) && JSON.stringify(existing.browserRecipient) === JSON.stringify(browserRecipient) && reactionIntentKey(existing.reaction) === reactionIntentKey(options?.reaction) && existing.sourceChannel === options?.sourceChannel && JSON.stringify(existing.goalContinuation) === JSON.stringify(options?.goalContinuation) && JSON.stringify(existing.goalPmo) === JSON.stringify(options?.goalPmo) && JSON.stringify(existing.goalDispatch) === JSON.stringify(options?.goalDispatch) && (options?.execution === undefined || existing.execution === options.execution)) return operationId
    ;(onRejected ?? useAppStore.getState().reportError)(new Error('This message identity already belongs to different content or an earlier execution choice. Your original message and draft are kept.'))
    return false
  }
  if ((useAppStore.getState().agentSteerQueues[sessionId]?.filter(entry => !entry.archived).length ?? 0) >= MAX_AGENT_STEER_QUEUE_ENTRIES) {
    (onRejected ?? useAppStore.getState().reportError)(new Error(`The active message queue is full (${MAX_AGENT_STEER_QUEUE_ENTRIES} messages). Archive queued messages before adding another. Your draft is kept.`))
    return false
  }
  // The shared Core formatter owns byte accounting; transport still keeps body and note separate.
  if (agentPromptExceedsBudget(composeAgentPrompt(text, agentMuxNote, browserInput?.capture.record.inputContext).text)) {
    (onRejected ?? useAppStore.getState().reportError)(new Error(
      `This message is too large to send (limit ${Math.floor(MAX_AGENT_PROMPT_BYTES / 1024)}KB). Shorten it, or put the content in a file and reference the path.`
    ))
    return false
  }
  const entry: AgentSteerQueueEntry = {
    operationId,
    promptCondition: options?.goalContinuation ? validateAgentPromptCondition(options.goalContinuation.condition) : null,
    ...(directInputBinding ? { directInputBinding, directInputControl: structuredClone(browserRecipient ?? session.control), runId: directInputBinding.expectedRun.runId } : {}),
    ...(options?.execution === undefined ? {} : { execution: options.execution }),
    ...(options?.goalContinuation ? { goalContinuation: structuredClone(options.goalContinuation) } : {}),
    ...(options?.goalPmo ? { goalPmo: structuredClone(options.goalPmo) } : {}),
    ...(options?.goalDispatch ? { goalDispatch: structuredClone(options.goalDispatch) } : {}),
    enqueuedAt: Date.now(),
    ...(session.processState === 'running' && (session.status.state !== 'disconnected' || options?.reaction !== undefined)
      ? { runId: session.control.run.runId } : {}),
    text,
    ...(browserInput ? { browserInput } : {}),
    ...(browserRecipient ? { browserRecipient: structuredClone(browserRecipient) } : {}),
    ...(agentMuxNote === undefined ? {} : { agentMuxNote }),
    ...(options?.reaction ? { reaction: structuredClone(options.reaction) } : {}),
    ...(options?.sourceChannel ? { sourceChannel: options.sourceChannel } : {}),
    status: 'queued',
    ...(options?.awaitingExplicitSend ? { awaitingExplicitSend: true as const } : {}),
    ...(origin === 'manual' ? { origin: 'manual' } : {}),
    ...(origin === 'manual' && !options?.goalContinuation && !options?.goalPmo && !options?.goalDispatch ? { freshComposerIntent: true as const } : {})
  }
  void api.continuousProgress.pauseForInput(session.control).catch(error => useAppStore.getState().reportError(error))
  useAppStore.setState((state) => ({ agentSteerQueues: { ...state.agentSteerQueues, [sessionId]: [...(state.agentSteerQueues[sessionId] ?? []), entry] } }))
  return entry.operationId
}

// File data requests are shared; display intent belongs to each explicit caller.
let fileOpenIntentVersion = 0
let fileOpenNavigationUnsubscribe: (() => void) | undefined

/** The existing Space and Survey selection facts captured by file display intents. */
function surveyPresentationAfterClose(state: AppState, tabs: AppState['tabs']) {
  const active = state.recallZoneSelection?.active
  const closedPage = state.recallNotebookId && state.recallNoteId && active && state.tabs[active.tabId]?.regions[active.regionId]?.kind === 'file' && !tabs[active.tabId]?.regions[active.regionId]
  let surveyCollectedZones = state.surveyCollectedZones
  if (coreSpatialPersistence?.ready && Object.keys(surveyCollectedZones).length && Object.keys(state.tabs).some(id => !tabs[id])) {
    const scratch = state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
    const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scratch) ?? []
    const catalog = spatialCatalog(state, topics)
    // Core members with unavailable host descriptors still exist. Only explicit prior deletions can exclude them.
    const retained = coreSpatialPersistence.current!.graph.tabs.filter(tab => !state.tabs[tab.tabId] && !coreSpatialPersistence!.removedEntities.has(tab.tabId))
    surveyCollectedZones = surveyCollectionAfterClose(state.tabs, tabs, surveyCollectedZones, { ...catalog, tabs: [...catalog.tabs, ...retained] })
  }
  return { recallNoteId: closedPage ? null : state.recallNoteId,
    recallZoneSelection: closedPage ? null : surveySelectionAfterClose(state.tabs, tabs, state.recallZoneSelection),
    surveyCollectedZones,
    surveyZoneSelection: state.surveyZoneSelection && state.surveyCollectedZones[state.surveyZoneSelection.zoneId] && !surveyCollectedZones[state.surveyZoneSelection.zoneId]
      ? null : surveySelectionAfterClose(state.tabs, tabs, state.surveyZoneSelection) }
}

export async function registerCreatedNote(receipt: NoteCreationReceipt): Promise<NoteCreationReceipt> {
  if (receipt.status !== 'written' || receipt.notebookRegistered) return receipt
  try {
    if (receipt.legacyConversion) {
      const catalog = await refreshNotebookLibrary(), page = catalog.pages[receipt.noteId]
      if (page && page.resource.hostId === receipt.target.hostId && page.resource.workspaceId === receipt.target.workspaceId && page.resource.workspacePath === receipt.target.workspacePath && page.resource.path === receipt.path) return { ...receipt, notebookRegistered: true, notebookIssue: undefined }
    }
    await changeNotebook({ kind: 'register', noteId: receipt.noteId, title: noteCreationTitle(receipt.draft),
      resource: { hostId: receipt.target.hostId, workspaceId: receipt.target.workspaceId, workspacePath: receipt.target.workspacePath, path: receipt.path },
      ...(receipt.target.zoneId ? { workface: { zoneId: receipt.target.zoneId, workspaceId: receipt.target.workspaceId } } : {}), ...receipt.notebook }, 'note-register:' + receipt.intentId)
    return { ...receipt, notebookRegistered: true, notebookIssue: undefined }
  } catch (error) { return { ...receipt, notebookIssue: 'Note saved. Notebook registration is unconfirmed; recover this same note. ' + presentError(error) } }
}

/** Consume the storage owner's exact resource receipt; never rename Tab/Region entities. */
export async function applyNotesStorageSnapshot(snapshot: NotesStorageSnapshot): Promise<void> {
  const before = useAppStore.getState()
  const next = reconcileNotesStorageResources(before, snapshot.resourceChanges, snapshot.directoryChanges)
  reconcileNotesLauncherDrafts(snapshot.resourceChanges, snapshot.directory)
  if (next !== before) {
    for (const change of snapshot.resourceChanges) {
      const fromKey = documentKey(change.from.workspaceId, change.from.path)
      const toKey = documentKey(change.to.workspaceId, change.to.path)
      if (fromKey !== toKey || change.from.workspacePath !== change.to.workspacePath) { advanceDocumentLifetime(fromKey); if (toKey !== fromKey) advanceDocumentLifetime(toKey) }
    }
    useAppStore.setState(next)
    await reobserveNotesStorageResources(next, snapshot.resourceChanges, useAppStore.getState)
  }
}

/** Snapshot the original Space occurrence for a camera intent; never reuse Focus's last target. */
function collaborationMapSpaceTarget(state: AppState): CollaborationMapTarget {
  const workspaceId = state.activeWorkspaceId ?? ''
  const choice = workspaceId ? workbenchObjectLayout(state, workspaceId).choice : null
  const region = choice?.tabId && choice.regionId ? state.tabs[choice.tabId]?.regions[choice.regionId] : undefined
  const execution = choice?.tabId && region?.kind === 'agent'
    ? agentRegionExecution({ tabId: choice.tabId, regionId: region.regionId, agentSessionId: region.sessionId }) : null
  if (region?.kind === 'agent' && execution) {
    const session = state.sessions.find(value => value.kind === 'agent' && value.id === region.sessionId && value.control.hostId === execution.hostId)
    return { kind: 'focus', subject: { hostId: execution.hostId, agentSessionId: region.sessionId }, name: state.agentNames[region.sessionId] ?? session?.label ?? region.sessionId }
  }
  return { kind: 'space', workspaceId, choice }
}

export function fileNavigationSelection(state: AppState): string {
  // Survey owns its selection; a split changes the underlying Space layout, not user navigation.
  if (state.mainSurface === 'recall') return JSON.stringify([state.mainSurface, state.recallNotebookId, state.recallNoteId, state.recallZoneSelection])
  if (state.mainSurface === 'survey') return JSON.stringify([state.mainSurface, state.activeWorkspaceId, state.surveyZoneSelection, state.workbenchSpaceSelection])
  const reference = mainRegionReference(state.workbenchSpaceSelection)
  if (reference) return JSON.stringify([state.mainSurface, state.focusView, state.activeWorkspaceId, state.workbenchSpaceSelection,
    state.agentFocus.execution.sessionId, state.agentFocus.execution.reference, state.surveyZoneSelection])
  const layout = state.activeWorkspaceId ? state.layouts[state.activeWorkspaceId] : undefined
  const tabId = layout ? findGroup(layout, layout.activeGroupId)?.activeTabId : undefined
  return JSON.stringify([state.mainSurface, state.focusView, state.activeWorkspaceId, layout?.activeGroupId, tabId,
    tabId ? state.tabs[tabId]?.layout.activeRegionId : undefined,
    state.agentFocus.execution.sessionId, state.agentFocus.execution.reference, state.agentFocus.pmo.sessionId, state.workbenchSpaceSelection, state.surveyZoneSelection])
}

function gitNavigationTarget(state: AppState) {
  if (state.mainSurface !== 'workbench') return null
  const reference = mainRegionReference(state.workbenchSpaceSelection)
  const layout = state.activeWorkspaceId ? state.layouts[state.activeWorkspaceId] : undefined
  const tabId = reference?.tabId ?? (layout ? findGroup(layout, layout.activeGroupId)?.activeTabId : undefined)
  const tab = tabId ? state.tabs[tabId] : undefined
  const surface = tab?.regions[reference?.regionId ?? tab.layout.activeRegionId]
  return surface?.kind === 'git' ? JSON.stringify([surface.regionId, surface.workspaceId, surface.scope.hostId, surface.scope.repoPath, surface.scope.workspacePath,
    surface.selection?.commitOid, surface.selection?.parentOid, surface.history ? [surface.history.reference, surface.history.focusOid] : null,
    surface.file ? [surface.file.path, surface.file.origPath] : null]) : null
}

async function openGoalPmo(demandId: string, prompt?: string, userRequest?: string, options?: { creationOperationId?: string | undefined; onReceipt?: ((receipt: GoalPmoReceipt) => void) | undefined }, promptGoal?: DemandRecord): Promise<string> {
  const get = useAppStore.getState
  const set = useAppStore.setState
  const state = get()
  const demand = state.demands[demandId]
  if (!demand) throw new Error(`Demand ${demandId} is unavailable`)
  const projectContext = goalProjectContextText(goalProjectContext(state.config, demand.projectId, state.activeWorkspaceId), demand.projectId)
  const workspace = state.config?.workspaces.find((item) => item.id === SCRATCH_WORKSPACE_ID)
  if (!workspace) throw new Error('Scratch workspace is unavailable')
  const body = userRequest ?? ''
  const discussionName = `${demand.title.trim() || 'New goal'} · PMO`
  const discussionNames = { agentName: discussionName, tabName: discussionName, nameSource: 'derived' as const }
  const intent: GoalPmoIntent = { goalId: demandId, ...(options?.creationOperationId === undefined ? {} : { creationOperationId: options.creationOperationId }) }
  let receiptSessionId: string | null = null
  const done = (tabId: string, agentSessionId: string | null = receiptSessionId): string => { options?.onReceipt?.({ tabId, agentSessionId }); return tabId }
  const launchedReceipt = (result: AgentLaunchResult): void => { receiptSessionId = result.created.agentSessionId; options?.onReceipt?.({ tabId: mappedTabId ?? pmoTabId!, agentSessionId: result.created.agentSessionId }) }
  let pmoTabId: string | undefined
  const executionContext = executionFocusContextText(
    state.agentFocus,
    state.sessions,
    (session) => state.agentNames[session.id] ?? session.label
  )
  const pmoNote = (fresh = false): string => [
      ...(!fresh ? [MOTE_COORDINATION_ROLE] : []),
      ...(fresh ? [goalRoleGuidance({ role: 'manager', goalId: demandId, source: { kind: 'goal-pmo-launch', ...(intent.creationOperationId ? { operationId: intent.creationOperationId } : {}) } })] : []),
      prompt?.trim(),
      projectContext,
      executionContext,
      ...(fresh ? [`This is a fresh dedicated PMO context for Demand ${demand.id}.`,
        ...(promptGoal === demand ? [] : [`Title: ${demand.title}`, `Description: ${demand.description || '(empty)'}`])] : [])
    ].filter(Boolean).join('\n\n')
  const focusPmoTabSession = (tabId: string): void => {
    const current = get()
    if (current.mainSurface !== state.mainSurface || current.selectedDemandId !== state.selectedDemandId ||
      current.activeWorkspaceId !== state.activeWorkspaceId || current.agentFocus.pmo !== state.agentFocus.pmo) return
    const tab = get().tabs[tabId]
    const surface = tab?.regions[tab.layout.activeRegionId]
    if (surface?.kind !== 'agent') return
    const session = get().sessions.find((candidate) => candidate.id === surface.sessionId)
    if (session && focusLaneForSession(topicIdForSession(get().config, session, scratchTopicsForConfig(get().config, get().scratchTopicSnapshots)),
      scratchTopicsForWorkspace(get().scratchTopicSnapshots, workspaceForSession(get().config, session, scratchTopicsForConfig(get().config, get().scratchTopicSnapshots)))) === 'pmo') {
      get().focusPmoSession(session.id)
    }
  }

  const discussionTarget = goalDiscussionTarget(state, demandId)
  const mappedTabId = discussionTarget.kind === 'new' ? undefined : discussionTarget.tabId
  const mappedTab = discussionTarget.kind === 'existing' ? discussionTarget.tab : undefined
  if (discussionTarget.kind === 'unconfirmed') throw new Error('The original Goal discussion placement is unconfirmed. Keep its Tab and Session; restore that workface before opening this discussion.')
  const layout = state.layouts[workspace.id]
  const originalSource = intent.creationOperationId === undefined ? undefined : demand.participations?.find(source => source.id === demand.creationOrigin?.requesterParticipationId && source.kind === 'discussion')
  let originalPmoSessionId: string | undefined
  if (originalSource) {
    const presentations = (agentSessionPresentationIndex(state.sessions).get(originalSource.agentSessionId) ?? []).filter(session =>
      session.control.agentSessionId === originalSource.agentSessionId && session.control.hostId === originalSource.hostId && session.hostId === originalSource.hostId)
    const originalPending = state.pendingAgentLaunches[originalSource.agentSessionId]?.request
    const pendingOriginalSource = presentations.length === 0 && originalPending?.hostId === originalSource.hostId &&
      originalPending.goalPmo?.goalId === demandId && originalPending.goalPmo.creationOperationId === intent.creationOperationId
    if (presentations.length !== 1 && !pendingOriginalSource) throw new Error('The original PMO Session presentation is unconfirmed or ambiguous on its recorded Host. The Goal, Tab and healthy Session are kept; refresh the original observation before retrying.')
    originalPmoSessionId = pendingOriginalSource ? originalSource.agentSessionId : presentations[0]!.id
  } else if (intent.creationOperationId !== undefined) {
    const originalRecipients = new Set([
      ...Object.entries(state.pendingAgentLaunches).filter(([, launch]) => launch.request?.goalPmo?.goalId === demandId && launch.request.goalPmo.creationOperationId === intent.creationOperationId).map(([id]) => id),
      ...Object.entries(state.agentSteerQueues).filter(([, queue]) => queue.some(entry => entry.goalPmo?.goalId === demandId && entry.goalPmo.creationOperationId === intent.creationOperationId)).map(([id]) => id)
    ])
    if (originalRecipients.size > 1) throw new Error('The original PMO request has ambiguous retained recipients. The Goal and original requests are kept; inspect the same operation before retrying.')
    originalPmoSessionId = [...originalRecipients][0]
  }
  const originalRegions = originalPmoSessionId && mappedTab ? Object.values(mappedTab.regions).filter(surface => surface.kind === 'agent' && surface.sessionId === originalPmoSessionId) : []
  if (originalPmoSessionId && originalRegions.length !== 1) throw new Error('The original PMO Region is unconfirmed or ambiguous. The Goal, original Tab and Session are kept; restore that exact workface before retrying.')
  const mappedRegion = originalPmoSessionId ? originalRegions[0] :
    discussionTarget.kind === 'existing' ? discussionTarget.region : undefined
  const mappedTabIsUsable = Boolean(
    mappedTab &&
    mappedTab.workspaceId === workspace.id &&
    mappedTab.topicId === PMO_TEAMS_TOPIC_ID &&
    layout &&
    tabGroupForTab(layout, mappedTab.id) !== null &&
    mappedRegion !== undefined && isAgentOrLauncherSurface(mappedRegion)
  )
  if (originalPmoSessionId && !mappedTabIsUsable) throw new Error('The original PMO workface placement is unconfirmed. The Goal and Session are kept; restore the same Tab before retrying.')
  if (mappedTabIsUsable && mappedTab) {
    const recipient = mappedRegion?.kind === 'agent' ? sessionPresentationById(state.sessions).get(mappedRegion.sessionId) : undefined
    const pending = mappedRegion?.kind === 'agent' ? state.pendingAgentLaunches[mappedRegion.sessionId]?.request : undefined
    let canonicalRecipientId = recipient?.kind === 'agent' && recipient.control?.kind === 'agent' ? recipient.control.agentSessionId : undefined
    if (!canonicalRecipientId && intent.creationOperationId !== undefined && pending?.hostId && pending.createOperationId && pending.goalPmo?.goalId === demandId && pending.goalPmo.creationOperationId === intent.creationOperationId) {
      canonicalRecipientId = await api.sessions.resolveCreationSessionId(pending.hostId, pending.createOperationId)
    }
    receiptSessionId = canonicalRecipientId ?? null
    // Opening an existing discussion is navigation only, including a retained launcher.
    if (!prompt?.trim()) { focusPmoTabSession(mappedTab.id); return done(mappedTab.id) }
    if (mappedRegion?.kind === 'agent' && prompt?.trim()) {
      // The live recipient already has its exact owner. Topic file preparation cannot gate input.
      const recipientId = mappedRegion.sessionId
      if (intent.creationOperationId === undefined) {
        if (get().send(recipientId, body, undefined, undefined, pmoNote(), { goalPmo: intent }) === false) throw new Error('The Mote task was not queued. The goal is kept; retry from its detail.')
        focusPmoTabSession(mappedTab.id)
        return done(mappedTab.id)
      }
      if (!canonicalRecipientId) throw new Error('The original PMO canonical Session is unconfirmed. The Goal and original Region are kept; refresh its exact control before retrying.')
      if (intent.creationOperationId !== undefined && demand.creationOrigin?.requesterParticipationId) return done(mappedTab.id)
      if (intent.creationOperationId !== undefined) {
        const hostId = recipient?.kind === 'agent' ? recipient.control.hostId : pending?.hostId
        if (!hostId) throw new Error('The original PMO Host is unconfirmed. Keep this Session and inspect the original operation without starting again.')
        const createOperationId = await goalPmoOperation(intent, 'create')
        const reserved = await api.sessions.resolveCreationSessionId(hostId, createOperationId)
        if (canonicalRecipientId === reserved) {
          await api.demands.reconcilePmoCreation(intent, hostId, canonicalRecipientId, createOperationId)
          await get().refreshDemand(demandId)
          if (get().pendingAgentLaunches[recipientId]) {
            const created = await api.sessions.creation(hostId, canonicalRecipientId)
            if (created.kind === 'retired-agent') throw new Error('The original PMO Session was closed. Its Goal, request and history are retained; explicitly recover that Session before attaching it.')
            const snapshot = await api.sessions.snapshot()
            const session = snapshot.sessions.find((item): item is Extract<SessionSnapshot, { kind: 'agent' }> => item.kind === 'agent' && item.control.agentSessionId === canonicalRecipientId && item.control.hostId === hostId && item.control.run.runId === created.run.runId)
            const timeline = snapshot.timelines[canonicalRecipientId]
            const result = await get().canonicalizeAgentLaunch({ created, projectionFailures: [], ...(session ? { session } : {}), ...(timeline ? { timeline } : {}) })
            if (!result) throw new Error('The original PMO display remains unconfirmed. Its confirmed Session is kept; inspect the same creation.')
            let gap: string | undefined
            set(current => {
              const owner = findWorkbenchRegion(current.tabs, mappedRegion.regionId)
              const attached = ownsSessionLaunch(owner?.surface, 'agent', recipientId)
                ? reduceAgentSessionLaunchAttached(current, mappedRegion.regionId, result)
                : reduceDetachedAgentLaunch(current, result)
              gap = attached.timelineGapSessionId
              return attached.state
            })
            if (gap) void get().resyncTimeline(gap)
          }
          return done(mappedTab.id)
        }
      }
      const operationId = intent.creationOperationId === undefined ? mintObjectId() : await goalPmoOperation(intent, 'discussion')
      const previous = get().agentSteerQueues[recipientId]?.find(entry => entry.operationId === operationId)
      if (previous && recipient?.kind === 'agent') {
        await api.demands.reconcilePmoInput(intent, recipient.control, operationId)
        await get().refreshDemand(demandId)
        set(current => ({ agentSteerQueues: { ...current.agentSteerQueues,
          [recipientId]: (current.agentSteerQueues[recipientId] ?? []).filter(entry => entry.operationId !== operationId) } }))
        return done(mappedTab.id)
      }
      if (admitAgentSteer(recipientId, body, undefined, operationId, undefined, pmoNote(), { goalPmo: intent }) === false) throw new Error('The Mote task was not queued. The goal is kept; retry from its detail.')
      void get().sendQueuedAgentSteer(recipientId, operationId).catch(error => get().reportError(error))
      focusPmoTabSession(mappedTab.id)
      return done(mappedTab.id)
    }
    if (mappedRegion?.kind === 'launcher') {
      const note = pmoNote(true)
      set(current => ({
        agentComposerDrafts: { ...current.agentComposerDrafts, [mappedTab.layout.activeRegionId]: body },
        agentComposerNotes: { ...current.agentComposerNotes, [mappedTab.layout.activeRegionId]: note }
      }))
      try { await get().openScratchTopic(PMO_TEAMS_TOPIC_ID, workspace.id, { reveal: false, tabId: mappedTab.id }) }
      catch (cause) {
        get().reportError(cause, { kind: 'indeterminate', summary: 'PMO Topic preparation is unconfirmed. The Goal, dedicated Tab and original request are kept; retry Start agent here.' })
        return done(mappedTab.id)
      }
      const liveLayout = get().layouts[workspace.id]
      const groupId = liveLayout ? tabGroupForTab(liveLayout, mappedTab.id) : null
      if (!groupId) throw new Error('Dedicated PMO Tab is no longer placed')
      const choice = primaryMoteExecutorChoice(get())
      const executorId = choice.executorId
      if (!executorId) {
        get().reportError(new Error(choice.issue ?? 'The primary Mote Agent configuration is unconfirmed. This Goal, dedicated Tab and request are kept; choose an Agent and Start agent here.'), { kind: 'indeterminate' })
        return done(mappedTab.id)
      }
      await get().launchAgent(executorId, body, groupId, {
        tabId: mappedTab.id,
        regionId: mappedTab.layout.activeRegionId
      }, undefined, discussionNames, note, { intent, onCreated: launchedReceipt })
    } else await get().openScratchTopic(PMO_TEAMS_TOPIC_ID, workspace.id, { reveal: false, tabId: mappedTab.id })
    focusPmoTabSession(mappedTab.id)
    return done(mappedTab.id)
  }

  const current = get()
  const currentLayout = current.layouts[workspace.id] ?? createWorkspaceLayout(newTabGroupId())
  const tab = newLauncherTab(workspace.id, PMO_TEAMS_TOPIC_ID)
  pmoTabId = tab.id
  const nextLayout = addTabPlacement(currentLayout, currentLayout.activeGroupId, tab.id)
  if (!nextLayout) throw new Error('The Scratch Tab Group is no longer available')
  const note = pmoNote(true)
  set((next) => ({
    tabs: { ...next.tabs, [tab.id]: tab },
    layouts: { ...next.layouts, [workspace.id]: nextLayout },
    demandPmoTabIds: { ...next.demandPmoTabIds, [demandId]: tab.id },
    agentComposerDrafts: { ...next.agentComposerDrafts, [tab.layout.activeRegionId]: body },
    agentComposerNotes: { ...next.agentComposerNotes, [tab.layout.activeRegionId]: note }
  }))
  // A generated title has its original owner and provenance even if preparation fails.
  // Naming is independent of starting the requested discussion and never gates it.
  void commitDisplayName({ kind: 'tab', id: tab.id }, discussionName, 'derived', 0)
    .catch(error => get().reportWorkbenchSaveFailure(error))
  let preparedTopic: ScratchTopicSnapshot
  try { preparedTopic = await api.scratch.ensureTopic(workspace.id, PMO_TEAMS_TOPIC_ID) }
  catch (cause) {
    get().reportError(cause, { kind: 'indeterminate', summary: 'PMO Topic preparation is unconfirmed. The Goal, dedicated Tab and original request are kept; retry Start agent here.' })
    return done(tab.id)
  }
  const liveWorkspace = get().config?.workspaces.find(item => item.id === workspace.id)
  // This request's new Launcher cannot erase its original unique primary target.
  // The prepared file and current Host configuration still decide explicit new-chat defaults.
  const choice = liveWorkspace?.hostId === workspace.hostId && liveWorkspace.path === workspace.path && preparedTopic.id === PMO_TEAMS_TOPIC_ID
    ? primaryMoteExecutorChoice({ ...state, config: get().config, executorDetections: get().executorDetections, hostExecutorInventories: get().hostExecutorInventories }, undefined, preparedTopic)
    : { executorId: undefined, issue: 'The original Mote directory or Host changed during preparation. The Goal and request are kept; inspect this target before starting.' }
  const executorId = choice.executorId
  if (!executorId) {
    get().reportError(new Error(choice.issue ?? 'The primary Mote Agent configuration is unconfirmed. This Goal, dedicated Tab and request are kept; choose an Agent and Start agent here.'), { kind: 'indeterminate' })
    return done(tab.id)
  }
  // The new Tab already has its own name operation; launching writes only the new Session name.
  await get().launchAgent(executorId, body, currentLayout.activeGroupId, {
    tabId: tab.id,
    regionId: tab.layout.activeRegionId
  }, undefined, { ...discussionNames, tabName: undefined }, note, { intent, onCreated: launchedReceipt })
  focusPmoTabSession(tab.id)
  return done(tab.id)
}

// Undelivered display projections retain the exact native creation event, never a URL replay.
const pendingNativeBrowsers = new Map<string, Extract<BrowserEvent, { type: 'native-opened' }>>()
function settleNativeBrowserProjectionNotice(state: AppState, browserId: string): Partial<AppState> {
  const key = `native-browser:${browserId}`
  const records = state.notificationEvents.filter(notice => notice.context?.event?.source === 'spatial' && notice.context.event.key === key)
  return { ...settleNotificationRecords(state, records),
    ...(state.errorNoticeContext?.event?.source === 'spatial' && state.errorNoticeContext.event.key === key
      ? { error: null, lastError: null, errorNoticeContext: null, errorDismissed: false } : {}) }
}

export const useAppStore = create<AppState>()(persist<AppState, [], [], PersistedAppState>((set, get) => ({
  restoredWorkbench: null,
  workbenchSpaceSelection: null,
  workbenchNavigationInputPolicy: null,
  desktopNavigationNotice: null,
  projectGroups: [],
  spaceZoneBindings: {},
  spatialRequests: {},
  goalAgentSelectionDrafts: {},
  goalFiniteStartIntents: {},
  goalAgentCreationDrafts: {},
  connectorRoomIntents: {},
  connectorRoomDrafts: {},
  continuityControlIntents: {},
  conversationLandmarkIntents: {},
  connectorServiceIntents: {},
  mailboxNotificationIntents: {},
  mailboxNotificationFeedback: {},
  mailboxNotificationHistory: {},
  connectorServiceObservation: {},
  moteBotRequests: {},
  botTaskSelections: {},
  manualConnectionIntents: {},
  manualConnectionSelections: {},
  moteConnectionSaveIntents: {},
  moteChatIntents: {},
  retainedSpatialFocus: null,
  config: null,
  providerCatalog: [],
  sessions: [],
  sessionNameMetadata: {},
  sessionNameMetadataWarning: null,
  recoveryCandidates: [],
  warmTerminals: {},
  unclaimedTerminalSessionIds: [],
  timelines: {},
  pendingAgentLaunches: {},
  activeWorkspaceId: null,
  scratchTopicOrder: [],
  workspaceAgentOrder: {},
  async setWorkspaceAgentOrder(workspaceId, order) {
    return await executeWorkspaceAgentOrder({ get, resolveExecution: agentRegionExecution,
      set: (id, value) => set(state => ({ workspaceAgentOrder: { ...state.workspaceAgentOrder, [id]: value } })),
      save: () => saveWorkbenchSelection(false)
    }, { schemaVersion: 5, requestId: mintObjectId(), operation: 'space.agent-order', displayWorkspaceId: workspaceId, order: workspaceAgentOrderMembers(order) })
  },
  recentMoteAgents: {},
  rememberMoteAgent(reference) {
    const current = get(), recentMoteAgents = recentMoteAgentsAfterVisit(current, reference)
    if (recentMoteAgents !== current.recentMoteAgents) set({ recentMoteAgents })
  },
  documents: {},
  retainedDocumentDrafts: {},
  dirtyDocuments: {},
  documentGenerations: {},
  documentObservationGenerations: {},
  documentIssues: {},
  savingDocuments: {},
  documentRevealTargets: {},
  noteBlockSelections: {},
  noteCanvasLayouts: {}, noteCanvasSaveIssues: {},
  setNoteBlockSelection(presentation, target) {
    const state = get(), reference = presentation.reference
    const region = state.tabs[reference.tabId]?.regions[reference.regionId]
    const layout = state.layouts[reference.displayWorkspaceId]
    if (!presentation.tabHostId || region?.kind !== 'file' || !layout ||
      !groupIds(layout.root).includes(reference.groupId) || !findGroup(layout, reference.groupId)?.tabOrder.includes(reference.tabId)) return
    const document = state.documents[documentKey(region.workspaceId, region.path)]
    const read = document ? parseNoteFile(document) : null
    if (!document || read?.status !== 'valid' || read.note.noteId !== target.noteId ||
      !noteKnowledge([{ location: { workspaceId: region.workspaceId, path: region.path }, document }]).sources[0]?.blocks.has(target.blockId)) return
    const key = noteBlockSelectionKey(presentation), held = state.noteBlockSelections[key]
    if (held?.noteId === target.noteId && held.blockId === target.blockId) return
    set({ noteBlockSelections: { ...state.noteBlockSelections, [key]: target } })
  },
  lastActiveFileByWorkspace: {},
  tabs: {},
  layouts: {},
  closingWorkbenchViews: {},
  closeTabRequest: null,
  closeRegionRequest: null,
  regionCaretFocus: null,
  workspaceFileRevisions: {},
  noteDirectorySources: {},
  scratchTopicSnapshots: {},
  topicCategories: [],
  fileExplorerStates: {},
  viewModes: {},
  editorWordWrap: false,
  editorMinimap: false,
  explorerShowHidden: true,
  explorerShowIgnored: true,
  editorRegionModes: {},
  editorRegionDiffs: {},
  executorDetections: {},
  hostExecutorInventories: {},
  hostChecks: {},
  browserAnnotationsByBrowserId: {},
  agentComposerDrafts: {},
  agentLearningReviewDrafts: {},
  capsuleQuestionEditors: {},
  browserOpinionDrafts: {},
  agentComposerHistory: {},
  agentComposerHistoryNavigation: {},
  agentComposerNotes: {},
  agentSteerQueues: {},
  questionReplies: {},
  questionReplyDrafts: {},
  agentSteerInFlight: {},
  agentSteerInFlightPhase: {},
  launcherNameDrafts: {},
  launcherOptionDrafts: {},
  noticeReadReceipts: {},
  moteContextOperations: {},
  agentNames: {},
  nameLabels: {},
  nameAuthorityRevision: 0,
  nameAcknowledgementRevision: 0,
  mainSurface: 'workbench',
  focusView: 'list',
  collaborationMapTarget: null,
  notebookRecoveries: [],
  recallNotebookId: null, recallNoteId: null,
  recallZoneSelection: null,
  setRecallZoneSelection(recallZoneSelection) { set({ recallZoneSelection }) },
  recallSidebarCollapsed: false, recallSidebarWidth: SURVEY_SIDEBAR_DEFAULT_WIDTH,
  setRecallSidebarCollapsed(recallSidebarCollapsed) { set({ recallSidebarCollapsed }) },
  setRecallSidebarWidth(width) { set({ recallSidebarWidth: clampSurveySidebarWidth(width) }); void saveWorkbenchSelection(false) },
  setRecallNotebook(notebookId, noteId = null) { set({ recallNotebookId: notebookId, recallNoteId: noteId }) },
  async refreshNotesStorage() {
    try { await applyNotesStorageSnapshot(await api.notesStorage.inspect()) }
    catch (error) { get().reportError(new Error('The original Note and draft are kept. File observation is unconfirmed; reopen this same Note to reconnect it. ' + presentError(error))) }
  },
  surveyZoneSelection: null,
  surveyCollectedZones: {},
  surveyOrganization: restoreSurveyOrganization(undefined),
  async setSurveyOrganization(organization, expected) {
    return await executeSurveyList({ get, set, hasZone: confirmedSurveyZones(get()), save: () => saveWorkbenchSelection(false) },
      { schemaVersion: 5, requestId: mintObjectId(), operation: 'space.survey-list', organization, expected })
  },
  surveyExplorationNames: {},
  async setSurveyExplorationName(zoneId, name, expectedNameRevision) {
    const state = get(), trimmed = name.trim()
    const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)) ?? []
    if (!spatialCatalog(state, topics).zones.some(zone => zone.zoneId === zoneId && zone.kind !== 'unknown')) return false
    try { const result = await commitDisplayName({ kind: 'zone', id: zoneId }, trimmed || null, 'manual', expectedNameRevision); return result.applied && result.diskDurability === 'confirmed' }
    catch { return false }
  },
  surveySidebarCollapsed: false,
  setSurveySidebarCollapsed(surveySidebarCollapsed) { set({ surveySidebarCollapsed }) },
  surveySidebarWidth: SURVEY_SIDEBAR_DEFAULT_WIDTH,
  setSurveySidebarWidth(width) {
    set({ surveySidebarWidth: clampSurveySidebarWidth(width) })
    // Commit only the finished presentation gesture through the existing save owner.
    void saveWorkbenchSelection(false)
  },
  surveyToolsOpen: false,
  setSurveyZoneSelection(selection) {
    const surveyZoneSelection = persistedSurveyZoneSelection(selection)
    // Re-emitting the current member preference is a refresh, not later navigation.
    if (sameSpatialValue(get().surveyZoneSelection, surveyZoneSelection)) return
    // Local Survey selection never navigates Work; explicit focus owns that handoff.
    set({ surveyZoneSelection })
    void saveWorkbenchSelection(false)
  },
  setSurveyZoneCollected(zoneId, collected) {
    const state = get()
    if ((state.surveyCollectedZones[zoneId] === true) === collected) return true
    const members = surveyCollectedZoneIds(state.surveyCollectedZones)
    const surveyCollectedZones = changeSurveyCollection(state.surveyCollectedZones,
      collected ? [...members, zoneId] : members.filter(id => id !== zoneId), confirmedSurveyZones(state))
    if (!surveyCollectedZones) return false
    set({ surveyCollectedZones })
    // Membership is a discrete user action, not a drag that can wait for a trailing write.
    void saveWorkbenchSelection(false)
    return true
  },
  setSurveyToolsOpen(surveyToolsOpen) { set({ surveyToolsOpen, workbenchNavigationInputPolicy: null, regionCaretFocus: null }) },
  createSurveyBrowser(input) { return createSurveyBrowser(get, input) },
  demands: {},
  demandPmoTabIds: {},
  agentFocus: EMPTY_AGENT_FOCUS,
  focusAgentReveal: null,
  conversationRevealIntent: null,
  focusTimelineNameWidth: FOCUS_TIMELINE_NAME_WIDTH_DEFAULT,
  setFocusTimelineNameWidth(width) {
    const next = clampFocusTimelineNameWidth(width)
    if (get().focusTimelineNameWidth !== next) set({ focusTimelineNameWidth: next })
  },
  focusTimelineHeight: FOCUS_TIMELINE_HEIGHT_DEFAULT,
  setFocusTimelineHeight(height) { set({ focusTimelineHeight: clampFocusTimelineHeight(height) }) },
  focusTimelineRuler: DEFAULT_FOCUS_RULER,
  setFocusTimelineRuler(preferences) {
    if (!sameFocusRuler(preferences, restoreFocusRuler(preferences)) || sameFocusRuler(get().focusTimelineRuler, preferences)) return
    set({ focusTimelineRuler: preferences })
  },
  selectedDemandId: null,
  demandArrangement: 'columns',
  projectRailOpen: true,
  collapsedProjectGroups: {},
  explorerCollapsed: {},
  pinnedItems: {},
  spaceObjectIcons: {},
  toolkitPresentation: {},
  toolsOpen: true,
  workspaceTool: 'files-branches',
  workspaceGitView: 'changes',
  gitCommitDrafts: {},
  projectRailWidth: PROJECT_RAIL_DEFAULT_WIDTH,
  toolDockWidth: TOOL_DOCK_DEFAULT_WIDTH,
  loading: true,
  startupProgress: { step: 'saved-workspace' },
  startupAgentAvailability: null,
  runtimeOwnershipWarnings: undefined,
  runtimeEndpointWarnings: undefined,
  environmentWarning: undefined,
  localHome: '',
  displacedAgentSessionIds: [],
  error: null,
  lastError: null,
  errorNoticeContext: null,
  errorDismissed: false,
  notificationEvents: [],
  clearReadNotificationEvents() {
    const read = get().noticeReadReceipts['global:events'] ?? {}
    set(state => ({ notificationEvents: state.notificationEvents.filter(event => notificationSourceOwner(event.context) || read[event.id] !== 'read'),
      ...(state.error !== null && projectNotifications(state.notificationEvents).history.some(event => event.id === notificationEventIdentity(state.error!, state.errorNoticeContext) && read[event.id] === 'read')
        ? { errorDismissed: true } : {}) }))
  },
  workbenchSaveWarning: null,
  workbenchSaveWarningOwner: null,
  nameSaveUnconfirmed: null,
  nameEditFailure: null,
  async confirmNameSave() {
    const pending = get().nameSaveUnconfirmed
    if (!pending) return
    try {
      const saved = await api.spatial.confirmNameCommit(pending.operationId)
      coreSpatialPersistence?.acceptNames(saved); applyNameAcknowledgement(saved)
    } catch (error) {
      if (get().nameSaveUnconfirmed === pending) set({ nameSaveUnconfirmed: { ...pending,
        message: `The current name is retained; disk confirmation is still unknown: ${presentError(error)}. Restore storage and confirm again; do not replay the old edit.` } })
    }
  },
  async reviewNameEdit() {
    const pending = get().nameEditFailure
    if (!pending) return
    try {
      const saved = await api.spatial.read()
      if (saved) { coreSpatialPersistence?.acceptNames(saved); applyNameAcknowledgement(saved) }
      if (get().nameEditFailure !== pending) return
      const label = saved ? displayLabel(saved.graph, pending.target) : null
      const actual = label ? label.value === null ? 'cleared' : JSON.stringify(label.value) : 'unknown'
      set({ nameEditFailure: { ...pending, message: `Current name: ${actual}. Reading does not confirm the earlier edit. Open this object's name editor to make a new edit against its current revision.` } })
    } catch (error) {
      if (get().nameEditFailure === pending) set({ nameEditFailure: { ...pending,
        message: `The current name could not be read: ${presentError(error)}. Restore storage access and review it again; the original work remains available.` } })
    }
  },
  reportWorkbenchSaveFailure(error, owner = 'workbench') {
    // A timed-out quit request must not later clear its warning without a new retry result.
    ++workbenchSaveRequest
    ++workbenchSaveFailureRevision
    if (owner === 'workbench') ++spatialSaveRequest
    else ++localSaveRequest
    // A local preference cannot replace an unresolved workbench/space failure.
    if (owner === 'local-storage' && get().workbenchSaveWarningOwner === 'workbench' && get().workbenchSaveWarning) return
    const warning = presentError(error)
    if (get().workbenchSaveWarning !== warning || get().workbenchSaveWarningOwner !== owner) set({ workbenchSaveWarning: warning, workbenchSaveWarningOwner: owner })
  },
  async retryWorkbenchSave() {
    try { await prepareRendererUpdate() }
    catch (error) { get().reportWorkbenchSaveFailure(error) }
  },
  async initialize() {
    if (!api.control || typeof api.control.onRequest !== 'function') {
      throw new Error('AgentMux Control API is unavailable')
    }
    const disposeMoteStartupRecovery = beginMoteStartupRecovery()
    const disposeRunServiceProjection = initializeRunServiceProjection()
    const disposeInputOccupation = initializeAgentInputOccupation()
    const disposeGoalResponsibilities = initializeGoalResponsibilityObservation()
    const pendingSessionEvents = sessionMembershipEventBuffer()
    const pendingBrowserEvents = createBrowserProjectionEventQueue()
    let booting = true
    let browserBooting = true
    let observing = true
    const a2aNotifications = createA2AMessageNotifier(async input => {
      const delivery = await api.ui.notifyAgentAttention(input)
      const notice = notificationDeliveryNotice(delivery)
      if (notice) get().reportError(notice.message, notice.context)
    })
    const visibleA2ARecipients = createVisibleSessionIdsSelector()
    const availabilityEpoch = ++startupAvailabilityEpoch
    let disposeStartupProgress = () => {}
    let pendingNotesStorage: NotesStorageSnapshot | null = null
    const disposeNotesStorage = api.notesStorage.onChange(snapshot => {
      pendingNotesStorage = snapshot
      if (!booting) void applyNotesStorageSnapshot(snapshot).catch(error => {
        if (observing) get().reportError(new Error('Notes directory view could not reconnect. Your original workface and drafts are kept; refresh the Notes directory in Settings. ' + presentError(error)))
      })
    })
    const disposeSessions = api.sessions.onEvent((event) => {
      if (event.event.type === 'agent-message-changed') {
        const state = get()
        void a2aNotifications.observe({ event, config: state.config, sessions: state.sessions, ready: !booting && observing,
          windowFocused: document.hasFocus(), visibleSessionIds: visibleA2ARecipients(state) }).catch(error => get().reportError(error))
      }
      if (booting) {
        enqueueSessionMembershipEvent(pendingSessionEvents, event)
        return
      }
      get().applyEvent(event)
    })
    const disposeBrowsers = api.browser.onEvent((event) => {
      if (browserBooting) {
        pendingBrowserEvents.push(event)
      }
      else get().applyBrowserEvent(event)
    })
    const disposeControl = api.control.onRequest((request, signal) => request.operation === 'worktree.closeout.prepare'
      ? (async () => {
          if (!coreSpatialPersistence?.ready) throw new Error('Original workface storage is unconfirmed. Keep the worktree and restore storage before closing it.')
          await coreSpatialPersistence.flush()
          return { operation: request.operation, requestId: request.requestId, diskDurability: 'confirmed' as const }
        })()
      : request.operation === 'browser.openFromSystem' ? openSystemUrlInSurvey({ get, navigation: () => fileNavigationSelection(get()), subscribe: listener => useAppStore.subscribe(listener) }, request, signal) : request.operation === 'continuous-progress.observeInput'
      ? readContinuousProgressInput(get(), request, signal)
      : request.operation === 'metrics.renderer'
        ? { operation: 'metrics.renderer', window: request.window, observedAt: Date.now(), ...api.readRendererMemory(), counts: readRendererResourceOwnerCounts(), performance: rendererPerformance.snapshot() }
        : get().executeControl(request, signal, { admittedControlRequestId: request.requestId }))
    const disposeSpatialLinkIssues = api.ui.onSpatialLinkIssue(message => get().reportError(new Error(message)))
    const disposeFileInvalidations = api.files.onInvalidated((event) => {
      const key = documentKey(event.workspaceId, event.path)
      fileInvalidationSequences.set(key, (fileInvalidationSequences.get(key) ?? 0) + 1)
      void get().refreshDocument(event.workspaceId, event.path)
      void get().invalidateScratchTopicPaths(event.workspaceId, [event.path])
    })
    runtimeSubscriptionCount += 4
    const disposeRuntimeSubscriptions = (): void => {
      observing = false
      disposeStartupProgress()
      disposeCoreSpatial?.();disposeCoreSpatial=null
      if (runtimeSubscriptionCount === 0) return
      runtimeSubscriptionCount -= 4
      cancelSessionMembershipResync()
      disposeMoteStartupRecovery()
      disposeRunServiceProjection()
      disposeInputOccupation()
      disposeGoalResponsibilities()
      disposeSessions()
      disposeBrowsers()
      disposeControl()
      disposeSpatialLinkIssues()
      disposeFileInvalidations()
      disposeNotesStorage()
      const candidates = Object.values(get().warmTerminals).flat()
      // Observation cleanup releases speculative candidates, never explicit openings.
      for (const warm of candidates) {
        if (warm.explicitOpening) continue
        void stopWarmTerminal(warm).then(sessionId => {
          if (!sessionId) return
          set(state => ({ unclaimedTerminalSessionIds: forgetUnclaimedTerminalSession(
            state.unclaimedTerminalSessionIds, sessionId) }))
        })
        set(state => ({ warmTerminals: updateWarmTerminal(state.warmTerminals, warm.key,
          candidate => candidate.ready === warm.ready && !candidate.explicitOpening, () => null) }))
      }
    }
    try {
      // Do not let the runtime snapshot race the Renderer persistence layer. The persisted Workbench
      // is the index that selects recovery candidates; observing it before hydration would turn a
      // restart into an empty first Workspace and make a healthy Agent appear unrecoverable. The
      // subscriptions above intentionally start first so events arriving during this storage read
      // stay in the existing boot buffer instead of being missed.
      const persistWarning = await ensurePersistHydrated()
      // Capture the original handoff before Core layout/name observations can
      // replace these caches. A name document may already own other targets;
      // absence there must not erase an alias before retainLabels receives it.
      const hydrated = get()
      const retainedDisplayNames = [
        ...Object.entries(hydrated.agentNames).map(([id, value]) => ({ target: { kind: 'agent-session', id }, value })),
        ...Object.entries(hydrated.surveyExplorationNames).map(([id, value]) => ({ target: { kind: 'zone', id }, value })),
        ...Object.values(hydrated.restoredWorkbench?.tabs ?? hydrated.tabs).flatMap(tab => tab.name ? [{ target: { kind: 'tab', id: tab.id }, value: tab.name }] : [])
      ]
      disposeCoreSpatial?.();disposeCoreSpatial=null
      if(api.spatial) {
        coreSpatialPersistence=new DesktopSpatialPersistence(api.spatial,error=>get().reportWorkbenchSaveFailure(error))
        try {
          const spatial=await coreSpatialPersistence.read()
          if(spatial) set({topicCategories:categoriesFromSpatial(spatial.graph),projectGroups:spatial.graph.projectGroups ?? [],restoredWorkbench:desktopWorkbenchFromSpatial(spatial.graph,id=>get().reportWorkbenchSaveFailure(new Error('Host resources are unavailable for saved Tab '+id+'. Its Core identity is retained. Restore the original Host connection.'))),spaceZoneBindings:desktopBindingsFromSpatial(spatial.graph,get().config)})
        } catch(error) {get().reportWorkbenchSaveFailure(error)}
      } else get().reportWorkbenchSaveFailure(new Error('Core spatial storage API is unavailable. Original work is retained; restore the Host connection to save positions.'))
      // Restored intent is readable evidence. Only an explicit Send can authorize its execution.
      set((state) => state.loading ? ({ agentSteerQueues: Object.fromEntries(Object.entries(state.agentSteerQueues)
        .map(([sessionId, entries]) => [sessionId, entries.map(({ preparationWait: _wait, ...entry }) => ({ ...entry,
          status: entry.status === 'restoring' ? 'restoring' as const : 'deferred' as const,
          awaitingExplicitSend: true as const
        }))])) }) : state)
      set({ startupProgress: { step: 'runtime' } })
      // Keep the write fence closed until the restored Workbench has been projected into the live
      // store below. Opening it immediately after hydration allows startup observers (and React's
      // first render) to serialize the pre-runtime empty shell over the durable Tab/Region record.
      // The fence is opened exactly once after the projection is installed.
      // Config is the boundary that tells us which Workspace a persisted Region belongs to, so a
      // config failure genuinely prevents a safe shell. Session membership and the Provider catalog
      // are narrower runtime observations: either can be temporarily unavailable while the saved
      // Workbench and an already-running Agent remain usable. Keep those failures scoped to a visible
      // startup notice instead of letting Promise.all turn them into a full-window connection error.
      const configBeforeRead = get().config
      const demandsBeforeRead = get().demands
      // Optional readers start independently; only durable projection/config owns publication.
      const providerRead = api.providers.list({ observation: true }).then(
        value => ({ status: 'fulfilled', value }) as const,
        reason => ({ status: 'rejected', reason }) as const)
      const demandRead = api.demands.list().then(
        value => ({ status: 'fulfilled', value }) as const,
        reason => ({ status: 'rejected', reason }) as const)
      const resourceBindingsBeforeRead = get().spaceZoneBindings
      const configRead = await api.config.get()
      const avatarHandoff = await handoffSpaceIcons(get().config !== configBeforeRead && get().config !== null ? get().config! : configRead)
      const persistedSessionIds = persistedSessionSurfaceIds(get().restoredWorkbench)
      const persistedState = get()
      // Main may publish while get or Session recovery is awaiting. An older read must not roll back
      // that committed fact; use the existing Store identity, with no second configuration cache.
      const config = persistedState.config !== configBeforeRead && persistedState.config !== null
        ? persistedState.config : avatarHandoff.config
      // The first Core read can precede configuration. Resolve old default descriptors now that
      // their original Workspace is known, without replacing later local binding edits.
      if (coreSpatialPersistence?.current && get().spaceZoneBindings === resourceBindingsBeforeRead) {
        set({ spaceZoneBindings: desktopBindingsFromSpatial(coreSpatialPersistence.current.graph, config) })
      }
      set({ startupProgress: { step: 'layout' } })
      const visibleSessions = persistedState.sessions
      const restoredUi = restorePersistedUiState(config, persistedState)
      const workbench = restorePersistedWorkbench({
        config,
        sessions: visibleSessions,
        persisted: persistedState.restoredWorkbench,
        preserveEntityIds:coreSpatialPersistence?.current ? new Set(coreSpatialPersistence.current.graph.tabs.map(tab=>tab.tabId)) : undefined,
        createTabGroupId: newTabGroupId,
        retiredSessionIds: new Set()
      })
      const observedSessionIds = new Set(visibleSessions.map(session => session.id))
      const unobservedSavedSessions = [...persistedSessionIds].filter(id => !observedSessionIds.has(id)
        && hasAttachedSessionView(workbench.tabs, id))
      const emptySessionSnapshotWarning = unobservedSavedSessions.length ? missingSavedRuntimeFactsNotice(unobservedSavedSessions.length) : null
      const restoredAgentFocus = sanitizeAgentFocus(
        restoreAgentFocus(persistedState.agentFocus),
        visibleSessions,
        (session) => {
          const topics = scratchTopicsForConfig(config, persistedState.scratchTopicSnapshots)
          const workspace = workspaceForSession(config, session, topics)
          // Hashed Mote paths need directory identity discovery, which runs after this restore.
          // An unobserved owner cannot reclassify and erase a durable coordination focus.
          return workspace ? focusLaneForSession(topicIdForSession(config, session, topics),
            scratchTopicsForWorkspace(persistedState.scratchTopicSnapshots, workspace)) : null
        },
        new Set([...persistedSessionIds].filter((id) => (
          hasAttachedSessionView(workbench.tabs, id)
        )))
      )
      // 抢救过的持久化 Tab 必须响亮：静默修好等于用户下次发现某一格不见了却无从查证。
      const repairNotice = describePersistedTabRepairs(workbench.repairs)
      const otherStartupError = [
        ...(persistWarning
          ? [`Saved workspace state could not be restored: ${presentError(persistWarning)}`]
          : []),
        ...(repairNotice ? [repairNotice] : []),
        ...(avatarHandoff.warning ? [avatarHandoff.warning] : [])
      ].join(' ')
      const startupError = [otherStartupError, emptySessionSnapshotWarning].filter(Boolean).join(' ')
      // Check the original visible workface's execution Host, rather than every saved remote.
      const restoredSelection = mainRegionReference(restoredUi.workbenchSpaceSelection)
      const selectedRegion = restoredSelection?.displayWorkspaceId === restoredUi.activeWorkspaceId ? restoredSelection : null
      const initialLayout = restoredUi.activeWorkspaceId ? workbench.layouts[restoredUi.activeWorkspaceId] : undefined
      const initialTabId = selectedRegion?.tabId ?? (initialLayout ? initialLayout.groups.find(group => group.id === initialLayout.activeGroupId)?.activeTabId : undefined)
      const initialTab = initialTabId ? workbench.tabs[initialTabId] : undefined
      const initialRegion = initialTab?.regions[selectedRegion?.regionId ?? initialTab.layout.activeRegionId]
      const initialWorkspaceId = initialRegion?.workspaceId ?? initialTab?.workspaceId ?? restoredUi.activeWorkspaceId
      const initialWorkspace = config.workspaces.find(workspace => workspace.id === initialWorkspaceId)
      const initialHost = config.hosts.find(host => host.id === initialWorkspace?.hostId)
      const availabilityTargets = Object.entries(config.executors).map(([id, executor]) => ({ id, providerId: executor.providerId, command: executor.command }))
      const startupAgents: StartupAgentAvailability | null = initialHost ? {
        hostId: initialHost.id, current: 0, total: initialHost.kind === 'local' ? Object.keys(config.executors).length : null,
        pending: true
      } : null
      set({
        restoredWorkbench: null,
        config,
        sessions: visibleSessions,
        startupAgentAvailability: startupAgents,
        pendingAgentLaunches: {},
        agentFocus: restoredAgentFocus,
        ...restoredUi,
        tabs: workbench.tabs,
        layouts: workbench.layouts,
        loading: false,
        error: startupError || null,
        lastError: startupError || null,
        errorNoticeContext: startupError ? {
          kind: 'indeterminate',
          summary: startupNoticeSummary(otherStartupError || null, unobservedSavedSessions.length),
          ...(emptySessionSnapshotWarning ? { startupSessionSnapshot: {
            sessionIds: unobservedSavedSessions,
            remainingMessage: otherStartupError || null,
          } } : {})
        } : null,
        errorDismissed: false
      })
      // Executable observations continue behind the usable workface. Publication and
      // persistence above depend only on their own durable/configuration boundary.
      if (initialHost) {
        const updateProgress = () => {
          if (!observing || availabilityEpoch !== startupAvailabilityEpoch) return
          const state = get(), check = state.startupAgentAvailability
          if (!check?.pending || check.hostId !== initialHost.id) return
          let current = 0, total: number | null = null
          if (initialHost.kind === 'local') {
            total = availabilityTargets.length
            current = availabilityTargets.filter(({ id, ...executor }) => {
              const detection = currentExecutorDetection(state.executorDetections[executorDetectionKey(initialHost.id, id)], id, executor, initialHost)
              return detection && ['ready', 'missing', 'error'].includes(detection.state)
            }).length
          } else {
            const inventory = state.hostExecutorInventories[initialHost.id]
            if (hostExecutorInventoryMatches(inventory, initialHost) && inventory.result) {
              total = inventory.result.executors.length
              current = inventory.state === 'checking' ? 0 : total
            }
          }
          if (current !== check.current || total !== check.total) set({ startupAgentAvailability: { ...check, current, total } })
        }
        disposeStartupProgress = useAppStore.subscribe((state, previous) => {
          if (state.executorDetections !== previous.executorDetections ||
              state.hostExecutorInventories[initialHost.id] !== previous.hostExecutorInventories[initialHost.id]) updateProgress()
        })
        void get().detectExecutors(initialHost.id).catch(error => {
          if (observing && availabilityEpoch === startupAvailabilityEpoch) get().reportError(error)
        }).finally(() => {
          disposeStartupProgress()
          if (!observing || availabilityEpoch !== startupAvailabilityEpoch) return
          updateProgress()
          const check = get().startupAgentAvailability
          if (check?.hostId === initialHost.id) set({ startupAgentAvailability: { ...check, pending: false } })
        })
      }
      // Publication releases the boot buffer before any optional reader can wait.
      booting = false
      void providerRead.then(result => {
        if (!observing) return
        if (result.status === 'fulfilled') set(state => ({ providerCatalog: result.value.catalog,
          runtimeEndpointWarnings: runtimeEndpointWarningsAfterMetadataRead(state.runtimeEndpointWarnings,
            'Reading Provider catalog', result.value.warnings) }))
        else {
          const warning = startupWorkflowWarning('Provider catalog lookup', result.reason,
            'Existing Sessions remain usable; the original Provider directory will be checked automatically when its owner is available.')
          set(state => {
            const retained = state.errorNoticeContext
            const message = [state.error, warning].filter(Boolean).join(' ')
            return { error: message, lastError: message, errorDismissed: false, errorNoticeContext: {
              ...retained, kind: retained?.kind ?? 'indeterminate', summary: retained?.summary ?? startupNoticeSummary(message),
              startupProviderCatalog: { warningMessage: warning },
              ...(retained?.startupSessionSnapshot ? { startupSessionSnapshot: { ...retained.startupSessionSnapshot,
                remainingMessage: [retained.startupSessionSnapshot.remainingMessage, warning].filter(Boolean).join(' ') } } : {})
            } }
          })
          startSessionMembershipResync(undefined, { reportFailure: false })
        }
      })
      void demandRead.then(result => {
        if (!observing) return
        if (result.status === 'rejected') get().reportError(new Error(startupWorkflowWarning('Demand filesystem snapshot', result.reason,
          'The saved Board Demand projection remains visible; retry the Demand store when the filesystem is available.')))
        else {
          set(state => ({ demands: { ...state.demands, ...Object.fromEntries(result.value
            .filter(demand => state.demands[demand.id] === demandsBeforeRead[demand.id])
            .map(demand => [demand.id, demandRecordFromFilesystem(demand, state.demands[demand.id])])) } }))
          refreshKnownGoalResponsibilities(result.value.map(goal => goal.id))
        }
      })
      const queuedNotesStorage = pendingNotesStorage; pendingNotesStorage = null
      void (queuedNotesStorage ? Promise.resolve(queuedNotesStorage) : api.notesStorage.inspect())
        .then(snapshot => {
          if (!observing) return
          const current = pendingNotesStorage ?? snapshot; pendingNotesStorage = null
          return applyNotesStorageSnapshot(current)
        })
        .catch(error => { if (observing) get().reportError(new Error('Notes directory view could not reconnect. Your original workface and drafts are kept; refresh the Notes directory in Settings. ' + presentError(error))) })
      for (const pending of drainSessionMembershipEvents(pendingSessionEvents)) get().applyEvent(pending.event)
      for (const sessionId of pendingSessionEvents.timelineGaps) void get().resyncTimeline(sessionId)
      for (const { hostId, warning, observationStep } of pendingSessionEvents.endpointWarnings.values()) {
        set(state => {
          const warnings = runtimeEndpointWarningsAfterObservation(state.runtimeEndpointWarnings, hostId, warning, observationStep)
          return { runtimeEndpointWarnings: warnings, sessions: projectRuntimeEndpointSessions(state.sessions, warnings) }
        })
      }
      // Catalog observations may finish after the initial Runtime cut. Read their
      // current diagnostics through the same reader after publishing the workface;
      // a successful catalog does not broaden recovery authorization.
      startSessionMembershipResync(undefined, { reportFailure: false, recoverSavedAgents: true })
      if (!persistWarning) openPersistWrites()
      // Keep observing and saving through the original Core spatial owner. A failed first
      // read retains the original preference projection until Core can confirm its document.
      if(coreSpatialPersistence) {
        const spatial=coreSpatialPersistence
        const capture=()=> !get().config && spatial.current
          ? {...spatial.current.graph,projectGroups:get().projectGroups}
          : desktopSpatialGraph(get(),Object.values(get().scratchTopicSnapshots).flatMap(snapshot=>snapshot.topics??[]),spatial.current?.graph??null,spatial.removedEntities)
        const apply=(saved:import('@agentmux/core/spatial-graph').AgentMuxSpatialState)=>{
          const current=get()
          // Organization facts do not require available Host resource configuration.
          if(!current.config) { set({projectGroups:saved.graph.projectGroups ?? []}); return }
          const unavailable=new Set<string>()
          const persisted=desktopWorkbenchFromSpatial(saved.graph,id=>unavailable.add(id))
          if(unavailable.size) current.reportWorkbenchSaveFailure(new Error('Host resources are unavailable for '+unavailable.size+' saved tab(s). Original identities and current content are retained. Restore their Host connection.'))
          const restored=restorePersistedWorkbench({config:current.config,sessions:current.sessions,persisted,createTabGroupId:newTabGroupId,retiredSessionIds:new Set(),preserveEntityIds:new Set(saved.graph.tabs.map(tab=>tab.tabId))})
          const old=projectPersistedWorkbench({tabs:current.tabs,layouts:current.layouts})
          const tabs={...Object.fromEntries([...unavailable].flatMap(id=>current.tabs[id]?[[id,current.tabs[id]]]:[])),...Object.fromEntries(Object.entries(restored.tabs).map(([id,tab])=>{
            const live=current.tabs[id]
            if(live && sameSpatialValue(old.tabs[id],persisted.tabs[id])) return [id,live]
            if(!live) return [id,tab]
            const regions=Object.fromEntries(Object.entries(tab.regions).map(([regionId,region])=>[regionId,
              live.regions[regionId] && sameSpatialValue(old.tabs[id]?.regions[regionId],persisted.tabs[id]?.regions[regionId]) ? live.regions[regionId] : region]))
            return [id,{...tab,regions}]
          }))}
          set({tabs,layouts:saved.graph.layouts,topicCategories:categoriesFromSpatial(saved.graph),projectGroups:saved.graph.projectGroups ?? [],spaceZoneBindings:desktopBindingsFromSpatial(saved.graph,current.config)})
          applyNameAcknowledgement(saved)
        }
        // Keep observation and local edit capture available even when the first storage read
        // or bootstrap fails. The existing save Retry re-reads Core before admitting a write.
        const offRemote=spatial.connect(apply, applyNameAcknowledgement)
        const offLocal=useAppStore.subscribe((state,previous)=>{
          if(state.loading || (state.topicCategories===previous.topicCategories && state.projectGroups===previous.projectGroups && state.tabs===previous.tabs && state.layouts===previous.layouts && state.spaceZoneBindings===previous.spaceZoneBindings && state.config===previous.config)) return
          spatial.stage(capture())
        })
        disposeCoreSpatial=()=>{offLocal();offRemote()}
        try {
          await spatial.bootstrap(capture())
          const closed = get().config?.workspaces.filter(workspace => workspace.closeout) ?? []
          if (closed.length) {
            for (const workspace of closed) spatial.closeWorkspace(workspace.id)
            spatial.stage(capture())
            await spatial.flush()
          }
          const acknowledged = await api.spatial.retainLabels(retainedDisplayNames)
          spatial.acceptNames(acknowledged)
          applyNameAcknowledgement(acknowledged)
          set({}) // Rewrite UI preferences after the Core ACK, removing the old entity snapshot.
        } catch(error) {get().reportWorkbenchSaveFailure(error)}
      }
      // Ordinary startup ensures the original primary identity once. Metadata failure is advisory;
      // it cannot hold up restored workfaces or reconcile a healthy Session into a replacement.
      if (config.workspaces.some(workspace => workspace.id === SCRATCH_WORKSPACE_ID)) {
        void Promise.resolve().then(() => api.scratch.ensureMote(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID))
          .catch(error => get().reportError(new Error('The primary Mote directory could not be confirmed. Existing work surfaces and Agent work remain available; open Mote to retry. ' + presentError(error))))
          .then(() => get().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true))
          .then(() => recoverScratchConversationsAtStartup())
          .catch(error => get().reportError(error))
      }
      // Restored dirty buffers keep their base revision and immediately resume observation.
      // Refresh marks disk conflicts through the existing reducer; it never overwrites a dirty draft.
      for (const key of Object.keys(get().documents)) {
        const separator = key.indexOf('\0')
        if (separator < 0) continue
        const workspaceId = key.slice(0, separator), path = key.slice(separator + 1)
        if (!config.workspaces.some((workspace) => workspace.id === workspaceId)) continue
        void api.files.observe(workspaceId, path).then(() => get().refreshDocument(workspaceId, path)).catch((error) => get().reportError(error))
      }
      for (const sessionId of Object.keys(get().agentSteerQueues)) void get().flushAgentSteerQueue(sessionId)
      for (const event of pendingBrowserEvents.drain()) get().applyBrowserEvent(event)
      browserBooting = false
      // Browser Regions are restored descriptions. Main acquires their original pages only
      // for a visible presentation or an admitted public page operation.
      // A rejected initial snapshot used the saved Workbench as a temporary projection. Retry one
      // canonical membership read after the shell is visible so stale Terminal Regions get a real
      // cleanup boundary even when Runtime emits no event for a PTY that disappeared with the app.
      // Agent recovery candidates remain protected by the same reducer used for event-driven resync.
      void api.ui.spatialLinksReady().catch(error => get().reportError(new Error('Spatial link startup is unconfirmed. Your workface is kept; retry its exact link. ' + presentError(error))))
      return () => {
        disposeRuntimeSubscriptions()
      }
    } catch (error) {
      booting = false
      disposeRuntimeSubscriptions()
      const persisted = get().restoredWorkbench
      // A failure after hydration (for example a malformed Runtime snapshot or a repair assertion)
      // must not turn the saved Workbench into the in-memory empty default. Keep the durable
      // topology visible while the service-window error explains which startup step failed.
      // Hydrate persisted browser Regions back to live surfaces here too — the raw persisted subset is
      // not a live WorkbenchSurface; the browsers stay as neutral shells (no create is safe on the
      // error path) until a later successful startup rebuilds them.
      const persistedTabs = persisted
        ? Object.fromEntries(Object.values(persisted.tabs).map((tab) => [tab.id, hydratePersistedTab(tab)]))
        : null
      set({
        ...(persisted && persistedTabs ? { tabs: persistedTabs, layouts: persisted.layouts } : {}),
        loading: false,
        error: presentError(error),
        lastError: presentError(error),
        errorNoticeContext: null,
        errorDismissed: false
      })
      // If hydration itself failed, keep the write fence closed: opening it here would let the
      // default empty state overwrite the only durable copy before the user can repair storage.
      // Other startup failures have a verified record and may accept intentional later edits.
      if (!persistHydrationError) openPersistWrites()
      return () => {}
    }
  },
  async saveProjectGroup(input) {
    const group = validateProjectGroup(input, get().projectGroups, get().config?.workspaces ?? [])
    set(state => ({ projectGroups: [...state.projectGroups.filter(value => value.groupId !== group.groupId), group] }))
    return saveWorkbenchSelection(true)
  },
  async dissolveProjectGroup(groupId) {
    if (!get().projectGroups.some(group => group.groupId === groupId)) return saveWorkbenchSelection(false)
    coreSpatialPersistence?.removeProjectGroup(groupId)
    set(state => ({ projectGroups: state.projectGroups.filter(group => group.groupId !== groupId) }))
    return saveWorkbenchSelection(true)
  },
  async selectWorkspace(id) {
    set({ workbenchSpaceSelection: null, workbenchNavigationInputPolicy: null, regionCaretFocus: null })
    if (get().retainedSpatialFocus !== null) set({ retainedSpatialFocus: null })
    set({ activeWorkspaceId: id, mainSurface: 'workbench', regionCaretFocus: null, error: null, errorDismissed: true })
    const state = get()
    if (!state.layouts[id]) {
      set((current) => ({
        layouts: { ...current.layouts, [id]: createWorkspaceLayout(newTabGroupId()) }
      }))
    }
  },
  activateWorkspaceSelection(result, reveal = true) {
    if (reveal && get().retainedSpatialFocus !== null) set({ retainedSpatialFocus: null })
    const workspace = result.workspace
    set((state) => {
      const existingLayout = state.layouts[workspace.id]
      return {
        ...adoptedConfig(state.activeWorkspaceId, result.config),
        ...(reveal ? { activeWorkspaceId: workspace.id, workbenchSpaceSelection: null, workbenchNavigationInputPolicy: null,
          mainSurface: 'workbench' as const, regionCaretFocus: null, error: null, errorDismissed: true } : {}),
        layouts: existingLayout
          ? state.layouts
          : { ...state.layouts, [workspace.id]: createWorkspaceLayout(newTabGroupId()) }
      }
    })
  },
  async runFanOut(input) {
    try {
      const result = await api.workspaces.runFanOut(input)
      if (result.kind === 'rejected') {
        get().reportError(new Error(result.reason))
        return result
      }
      if (result.kind === 'fanout') {
        // Config changed in main (each lane registered a worktree); pull the new truth rather than
        // reconstructing it here.
        //
        // 走 `adoptedConfig` 而不是裸 `set({ config })`，尽管扇出只**添加**记录、今天动不了活动位。
        // 「这次写入只加不减」是一条会过期的理由：下一个人在同一处加一句 filter 时不会回头读这行
        // 注释，而漏掉活动位的症状是一屏没有解释的空白欢迎页。统一走同一个出口，代价是一次无操作。
        const next = await api.config.get()
        // 同活动位：扇出今天只加不减，所以这句是无操作。但「只加不减」是会过期的理由——统一在
        // 这个出口撤掉被移除 workspace 的观察者，下一个人在此加 filter 时不会漏掉子进程（#559）。
        disposeObserversForRemovedWorkspaces(get().tabs, next)
        set((state) => adoptedConfig(state.activeWorkspaceId, next))
        // A partial failure is neither swallowed nor promoted to total failure: the lanes that did
        // launch stay launched, and the ones that did not are named through the existing error surface.
        const failed = result.lanes.filter((lane) => lane.status !== 'launched')
        // 一个建了 worktree 但没启动成功的 lane 有第二件事要说：**那个目录现在怎么样了**。此前这条真相
        // 走到 renderer 就断了——lane 上带着它，而没有任何消费者读，于是清理失败的 lane 与清理干净的
        // lane 在屏幕上完全一样。措辞与顺序共用 `retentionReport`，不在这里另写一套。
        //
        // 两句话拼进**同一次** reportError，而不是各报一次：错误面是一个槽（`reportError` 就是
        // `set({ error })`），第二次调用会把第一次擦掉。分两次报的后果是保留告知盖掉「哪几条没起来、
        // 为什么」——用户失去的正是他最需要的那半边。
        const retention = retentionReport(
          result.lanes.flatMap((lane) =>
            lane.status === 'launch-failed' && lane.cleanup
              ? [{ retention: lane.cleanup.retention, id: lane.branch, reason: lane.cleanup.reason }]
              : []
          )
        )
        if (failed.length > 0 || retention) {
          const launchFailures = failed.length > 0
            ? `${failed.length} of ${result.lanes.length} lanes did not start: ${failed
                .map((lane) => `${lane.branch} (${lane.error})`)
                .join('; ')}`
            : null
          get().reportError(new Error([launchFailures, retention].filter(Boolean).join(' — ')))
        }
      }
      return result
    } catch (error) {
      get().reportError(error)
      return { kind: 'rejected', reason: presentError(error) }
    }
  },
  async createPullRequest(input) {
    // The click's intent, captured before any await. Every later step checks it.
    const token = input.token
    try {
      const verdict = evaluateCreatePrIntent(token, input.current)
      if (verdict.kind === 'conflict') {
        // Aborting is the honest outcome: the payload no longer describes what the user asked for.
        // Switching to another worktree does NOT reach here — that returns proceed-detached.
        get().reportError(new Error(verdict.reason))
        return { kind: 'refused', reason: verdict.reason }
      }
      // The eligibility ladder runs first so the user gets the actionable reason ("push it first",
      // "run gh auth login") instead of whatever gh happens to say when it fails. It is a HINT, not
      // the authority: main re-checks the base against the remote and refuses on its own terms.
      if (input.eligibility) {
        const verdictLadder = evaluatePrEligibility(input.eligibility)
        if (!verdictLadder.eligible) {
          const reason = verdictLadder.blockers.map((key) => PR_BLOCKER_MESSAGES[key]).join(' ')
          get().reportError(new Error(reason))
          return { kind: 'refused', reason }
        }
      }
      // gh 桥从 ghBridge 取（与 git 同一层，但缺席理由是它自己那一句）。桥缺席是拒绝，绝不假装开了 PR。
      const lookup = ghBridge()
      if (!lookup.available) {
        get().reportError(new Error(lookup.reason))
        return { kind: 'refused', reason: lookup.reason }
      }
      // Main re-checks the base against the remote and is the final authority; an unavailable check
      // is a refusal there, not a pass.
      const result = await lookup.bridge.createPullRequest(input.workspaceId, {
        title: input.title,
        body: input.body,
        base: token.baseRef,
        ...(input.draft === undefined ? {} : { draft: input.draft })
      })
      // A refusal or failure is surfaced but NOT swallowed into a cleared composer: the caller keeps
      // the title and body so one bad network moment does not eat what the user wrote.
      if (result.kind !== 'created') {
        get().reportError(new Error(result.kind === 'refused' ? result.reason : result.message))
      }
      return result
    } catch (error) {
      get().reportError(error)
      return { kind: 'failed', message: presentError(error) }
    }
  },
  async keepOneOfFanOut(input) {
    try {
      await coreSpatialPersistence?.flush()
      const result = await api.workspaces.keepOneOfFanOut(input)
      // 输家的记录刚被撤掉，而活动位很可能正指着其中一个——用户就是在看那几条 lane 才按下 Keep 的。
      const next = await api.config.get()
      // 胜者写在候选第二位：活动位指着的还在（比如某条 lane 因为脏树被留下）就不动它，被删掉了才
      // 落到胜者身上。落到胜者而不是通用兜底，是因为「留下这一个」这句话本身就说明了该看哪儿。
      // 输家的记录连同它们的文件 Tab 一起被撤，那些 Tab 攥着的 Main 侧观察者也要在这里释放（#559）。
      disposeObserversForRemovedWorkspaces(get().tabs, next)
      get().setConfig(next, input.keepWorkspaceId)
      // A lane refused because it still holds uncommitted work is reported, never silently dropped —
      // losing a bake-off is not a reason to discard someone's work. 分档措辞在 `retentionReport`
      // 里，因为「哪一档说哪句话」是判断：这里曾经把三档折成一句硬编码的「because they still hold
      // changes」，对 git 失败与「已删但记录没撤下」两档都是假话。
      //
      // 折成一句而不是逐条 reportError：错误面是一个槽，逐条报的话三档同时出现时只剩最后一档，而
      // 被擦掉的第一档（脏树）恰好是唯一有真实下一步可做的那一档。
      const retention = retainedLaneReport(result.outcomes)
      if (retention) get().reportError(new Error(retention))
      return result
    } catch (error) {
      get().reportError(error)
      return null
    }
  },
  async removeWorktree(input) {
    await coreSpatialPersistence?.flush()
    const outcome = await api.workspaces.removeWorktree(input)
    // `removed` 带回来的 config 就是权威的那一份，不再另外 get() 一次：多一次往返就多一个能与这次
    // 移除结果不一致的窗口。`retained` 什么都没删，所以什么都不写——它是保护生效了，不是一次变更。
    if (outcome.status === 'removed' || outcome.status === 'closed') {
      // The removed worktree's file Tabs still hold Main-side observers; drop them at the same seam
      // that reseats the active Workspace (see disposeObserversForRemovedWorkspaces / #559).
      disposeObserversForRemovedWorkspaces(get().tabs, outcome.config)
      get().setConfig(outcome.config)
    }
    // 抛不抛由调用方决定：单条移除的 `retained` 要在对话框里重问，压成 null 会把 git 的理由吃掉。
    return outcome
  },
  focusTabGroup(workspaceId, tabGroupId) {
    const current = get(), layout = current.layouts[workspaceId]
    if (!layout || !findGroup(layout, tabGroupId) || !groupIds(layout.root).includes(tabGroupId)) return
    let choice = current.workbenchSpaceSelection
    try {
      const catalog = workbenchSelectionCatalog(current)
      const shown = choice ? projectWorkbenchSpaceSelection(layout, current.tabs, catalog, choice).layout : layout
      if (choice && (!shown || !groupIds(shown.root).includes(tabGroupId))) throw new Error('This Group is not confirmed in the selected object. Its original workface and input are kept.')
      const tabId = shown?.groups.find(group => group.id === tabGroupId)?.activeTabId
      if (tabId) choice = resolveWorkbenchOccurrenceSelection(current, catalog, { workspaceId, groupId: tabGroupId, tabId })
      else if (choice && !shown) throw new Error('The original Group position is unconfirmed. Its selected object and workface are kept.')
    } catch (error) { current.reportError(error, { kind: 'indeterminate' }); return }
    set((state) => ({
      regionCaretFocus: null, workbenchSpaceSelection: choice, workbenchNavigationInputPolicy: null,
      layouts: { ...state.layouts, [workspaceId]: focusGroup(layout, tabGroupId) }
    }))
  },
  activateTab(workspaceId, tabGroupId, tabId, intent = 'navigation') {
    const current = get(), layout = current.layouts[workspaceId]
    if (!layout) return
    let choice: AgentMuxDesktopSpaceSelection
    try { choice = resolveWorkbenchOccurrenceSelection(current, workbenchSelectionCatalog(current),
      { workspaceId, groupId: tabGroupId, tabId }, intent) }
    catch (error) { current.reportError(error, { kind: 'indeterminate' }); return }
    const tab = current.tabs[tabId]
    const surface = tab ? titleWorkbenchSurface(tab) : null
    const activeRegion = tab?.regions[tab.layout.activeRegionId]
    const focusedSessionId = activeRegion && isSessionSurface(activeRegion) ? activeRegion.sessionId : null
    const recentMoteAgents = activeRegion ? recentMoteAgentsAfterVisit(current, { displayWorkspaceId: workspaceId, groupId: tabGroupId, tabId, regionId: activeRegion.regionId }) : current.recentMoteAgents
    set((state) => ({
      regionCaretFocus: null, workbenchSpaceSelection: choice, workbenchNavigationInputPolicy: null,
      retainedSpatialFocus: null, activeWorkspaceId: workspaceId, mainSurface: 'workbench',
      recentMoteAgents,
      layouts: {
        ...state.layouts,
        [workspaceId]: activateLayoutTab(layout, tabGroupId, tabId)
      },
      ...(focusedSessionId && activeRegion ? { agentFocus: focusSessionContext(state, focusedSessionId, undefined,
        { displayWorkspaceId: workspaceId, groupId: tabGroupId, tabId, regionId: activeRegion.regionId }) } : {}),
      ...(surface?.kind === 'file'
        ? { lastActiveFileByWorkspace: { ...state.lastActiveFileByWorkspace, [workspaceId]: surface.path } }
        : {})
    }))
  },
  async executeControl(request, signal, options): Promise<AgentMuxControlResult> {
    if (request.operation === 'demand.patrol-all') return await executeGlobalGoalPatrol({
      get, subscribe: (listener): (() => void) => useAppStore.subscribe(listener), list: () => api.demands.list(),
      execute: (inner, spatialOptions) => get().executeControl(inner, signal, spatialOptions)
    }, request)
    if (request.operation === 'space.mote.preferences.read' || request.operation === 'space.mote.preferences.save') {
      return await (await import('./lib/mote-preferences-control')).executeMotePreferencesControl(request, signal)
    }
    if (isToolkitRequest(request)) {
      throw Object.assign(new Error('Toolkit requests belong to the Main execution owner.'), { code: 'CONTROL_FAILED' })
    }
    if (request.operation === 'browser.release') {
      throw Object.assign(new Error('Native Browser release belongs to the Main resource owner.'), { code: 'CONTROL_FAILED' })
    }
    if (request.operation === 'metrics.get' || request.operation === 'metrics.watch' || request.operation === 'metrics.app-memory.inspect' || request.operation === 'metrics.profile.capture' || request.operation === 'metrics.trace.capture' || request.operation === 'metrics.memory.inspect' || request.operation === 'metrics.animations.inspect' || request.operation === 'metrics.allocations.capture' || request.operation === 'metrics.scene.capture' || request.operation === 'metrics.scene.inspect' || request.operation === 'metrics.heap.capture' || request.operation === 'metrics.heap.inspect') {
      throw Object.assign(new Error('Metrics queries belong to the Main observation owner.'), { code: 'CONTROL_FAILED' })
    }
    if (request.operation === 'diagnostics.crash-log.get' || request.operation === 'diagnostics.crash-log.reveal') {
      throw Object.assign(new Error('Crash log diagnostics belong to the Main owner.'), { code: 'CONTROL_FAILED' })
    }
    if (request.operation === 'settings.get' || request.operation === 'settings.set' ||
        request.operation === 'settings.workspaces.add' ||
        request.operation === 'settings.executors.refresh' ||
        request.operation === 'settings.hosts.list' || request.operation === 'settings.hosts.update' || request.operation === 'settings.hosts.test' ||
        request.operation === 'settings.hosts.upgrade-check' || request.operation === 'settings.hosts.upgrade' || request.operation === 'settings.hosts.upgrade-inspect' ||
        request.operation === 'settings.browser.default.inspect' || request.operation === 'settings.browser.default.open-settings' ||
        request.operation === 'settings.browser.links.list' || request.operation === 'settings.browser.links.forget' ||
        request.operation === 'settings.resource.list' || request.operation === 'settings.resource.get' ||
        request.operation === 'settings.resource.add' || request.operation === 'settings.resource.update' ||
        request.operation === 'settings.resource.remove') {
      throw Object.assign(new Error('Settings requests belong to the Main configuration owner.'), { code: 'CONTROL_FAILED' })
    }
    if (request.operation === 'space.survey-list') return { operation: request.operation, ...await executeSurveyList({ get,
      set, hasZone: confirmedSurveyZones(get()), save: () => saveWorkbenchSelection(false) }, request) }
    if (request.operation === 'space.agent-order') return { operation: request.operation, ...await executeWorkspaceAgentOrder({ get, resolveExecution: agentRegionExecution,
      set: (id, value) => set(state => ({ workspaceAgentOrder: { ...state.workspaceAgentOrder, [id]: value } })),
      save: () => saveWorkbenchSelection(false)
    }, request) }
    if (request.operation === 'agent.view') return await executeWorkfaceAgentView({
      get, setViewMode: (...args) => get().setViewMode(...args), save: saveWorkbenchSelection
    }, request)
    if (request.operation === 'space.swap') return await executeWorkfaceRegionSwap({
      get, swapRegions: (...args) => get().swapRegions(...args),
      closing: tabId => !workbenchViewCloseAllowsView(get().closingWorkbenchViews, tabId), save: saveWorkbenchSelection
    }, request)
    if (request.operation === 'open.git') {
      const refuse = (message: string): never => { throw Object.assign(new Error(message), { code: 'INVALID_CONTROL_TARGET' }) }
      const original = get().config?.workspaces.find(workspace => workspace.id === request.workspaceId)
      if (!original || original.hostId !== request.expectedResource.hostId || original.path !== request.expectedResource.workspacePath) {
        refuse('The original Git workspace resource changed. Discover its current Host and path before opening it.')
      }
      const lookup = gitBridge()
      if (!lookup.available) throw Object.assign(new Error(lookup.reason), { code: 'CONTROL_FAILED' })
      const navigation = get()
      const originalNavigation = fileNavigationSelection(navigation)
      const originalGitTarget = gitNavigationTarget(navigation)
      let navigationChanged = false
      const stopObservingNavigation = useAppStore.subscribe(next => {
        if (navigationChanged) return
        if (next.workspaceTool !== navigation.workspaceTool || next.workspaceGitView !== navigation.workspaceGitView || next.toolsOpen !== navigation.toolsOpen) {
          navigationChanged = true
        } else if (next.mainSurface !== navigation.mainSurface || next.activeWorkspaceId !== navigation.activeWorkspaceId ||
          next.layouts !== navigation.layouts || next.tabs !== navigation.tabs || next.workbenchSpaceSelection !== navigation.workbenchSpaceSelection ||
          next.agentFocus !== navigation.agentFocus || next.surveyZoneSelection !== navigation.surveyZoneSelection ||
          next.recallNotebookId !== navigation.recallNotebookId || next.recallNoteId !== navigation.recallNoteId || next.recallZoneSelection !== navigation.recallZoneSelection) {
          navigationChanged = fileNavigationSelection(next) !== originalNavigation || gitNavigationTarget(next) !== originalGitTarget
        }
      })
      let details: GitHistoryResult | GitCommitDetailsResult
      try {
        details = request.oid === undefined
          ? await lookup.bridge.history(request.workspaceId, { limit: 1 })
          : await lookup.bridge.commitDetails(request.workspaceId, { oid: request.oid,
              ...(request.parentOid ? { parentOid: request.parentOid } : {}) })
      } finally { stopObservingNavigation() }
      if (signal?.aborted) throw Object.assign(new Error('The Git open request was cancelled; the original workface is retained.'), { code: 'CONTROL_CANCELLED' })
      const current = get().config?.workspaces.find(workspace => workspace.id === request.workspaceId)
      if (!current || current.hostId !== original!.hostId || current.path !== original!.path) refuse('The Git workspace resource changed while reading.')
      if (details.kind !== 'ready') return refuse('The original workspace is no longer a Git repository.')
      if (details.snapshot.hostId !== request.expectedResource.hostId) refuse('The Git owner returned a different Host.')
      const snapshot = request.oid === undefined
        ? { hostId: details.snapshot.hostId, repoPath: details.snapshot.repoPath }
        : details.snapshot as GitCommitSnapshot
      if (request.oid !== undefined && (!('commitOid' in snapshot) || snapshot.commitOid !== request.oid ||
          request.parentOid !== undefined && snapshot.parentOid !== request.parentOid)) refuse('The Git owner returned a different immutable commit target.')
      if (navigationChanged) throw Object.assign(new Error('Git was read, but later navigation replaced this presentation request. The current workface is retained; open the original Git target again when ready.'), { code: 'CONTROL_CANCELLED' })
      const presentation = request.oid === undefined ? get().openGitHistory(request.workspaceId, snapshot)
        : get().openGitWorkbench(request.workspaceId, snapshot as GitCommitSnapshot)
      await saveWorkbenchSelection(true)
      return { operation: 'open.git', workspaceId: request.workspaceId, read: { kind: 'ready', snapshot }, presentation }
    }
    if (request.operation === 'open.file') return await executeWorkfaceFileOpen({
      get,
      navigationSelection: () => fileNavigationSelection(get()),
      topics: async () => get().config?.workspaces.some(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
        ? await api.scratch.listTopics(SCRATCH_WORKSPACE_ID) : [],
      openFile: (...args) => get().openFile(...args),
      closing: tabId => !workbenchViewCloseAllowsView(get().closingWorkbenchViews, tabId), save: saveWorkbenchSelection
    }, request, options?.fileOpenIntent, options?.fileInputPolicy)
    if (request.operation === 'space.view') return await executeWorkfaceFileView({
      get, setEditorRegionMode: (...args) => get().setEditorRegionMode(...args),
      closing: tabId => !workbenchViewCloseAllowsView(get().closingWorkbenchViews, tabId), save: saveWorkbenchSelection
    }, request)
    if (request.operation === 'file.format') {
      const { formatFileRegion } = await import('./lib/file-formats/format-file-region')
      const result = await formatFileRegion(request.regionId, signal)
      return { operation: request.operation, regionId: request.regionId, status: result.status, message: result.message ?? null }
    }
    if (request.operation === 'file.build' || request.operation === 'file.build.inspect' || request.operation === 'file.build.cancel') {
      const builds = await import('./lib/file-formats/build-file-region')
      const result = request.operation === 'file.build'
        ? await builds.buildFileRegion(request.regionId, signal, request.requestId)
        : request.operation === 'file.build.inspect'
          ? await builds.inspectFileRegionBuild(request.regionId, request.buildId)
          : await builds.cancelFileRegionBuild(request.regionId, request.buildId)
      return request.operation === 'file.build' ? { operation: request.operation, ...result }
        : request.operation === 'file.build.inspect' ? { operation: request.operation, ...result } : { operation: request.operation, ...result }
    }
    if (request.operation === 'space.ls' || request.operation === 'space.inspect' || request.operation === 'agent.open' || request.operation === 'space.mv' || request.operation === 'space.bind' || request.operation === 'space.unbind') {
      return await executeSpatialControl({
        get,
        agentPresentation: () => readAgentPresentation(get()),
        motePresentation: (catalog, topics) => readMotePresentation(get(), catalog, topics),
        surveyPresentation: catalog => readSurveyPresentation(get(), catalog),
        appearance: (catalog, imageSpaceId, topics) => readSpatialAppearance(get(), catalog, imageSpaceId, topics,
          (target, choice) => api.scratch.readMoteAvatar(target.workspaceId, target.topicId, choice, target.objectKey),
          workspaceId => api.workspaces.appearance(workspaceId)),
        patch: patch => set(state => {
          const choice = state.workbenchSpaceSelection, held = state.retainedSpatialFocus
          if (!patch.tabs || !choice || !held || choice.workspaceId !== held.displayWorkspaceId ||
            choice.tabId !== held.tabId || choice.regionId !== held.regionId) return patch
          const sourceTab = patch.tabs[held.tabId], sourceLayout = (patch.layouts ?? state.layouts)[held.displayWorkspaceId]
          const sourceGroup = sourceLayout?.groups.find(group => group.id === choice.groupId)
          const sourceRemains = sourceTab?.workspaceId === held.workspaceId && sourceGroup?.tabOrder.includes(held.tabId)
          if (sourceRemains && sourceTab.regions[held.regionId]) return patch
          return { ...patch, workbenchSpaceSelection: { ...choice,
            tabId: sourceRemains ? choice.tabId : null, groupId: sourceRemains ? choice.groupId : null, regionId: null } }
        }),
        topics: async () => get().config?.workspaces.some(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
          ? await api.scratch.listTopics(SCRATCH_WORKSPACE_ID) : [],
        createResource: input => api.workspaces.createZoneResource(input),
        launch: input => {
          set(current => ({ pendingAgentLaunches: { ...current.pendingAgentLaunches,
            [input.agentSessionId]: { ...current.pendingAgentLaunches[input.agentSessionId],
              events: current.pendingAgentLaunches[input.agentSessionId]?.events ?? [],
              overflowed: current.pendingAgentLaunches[input.agentSessionId]?.overflowed ?? false,
              request: { executorId: input.executorId, hostId: input.hostId, workspacePath: input.workspacePath,
                ...(input.prompt === undefined ? {} : { prompt: input.prompt }) } }
          } }))
          return api.sessions.launchAgent(input)
        },
        creation: (hostId, sessionId) => api.sessions.creation(hostId, sessionId),
        attach: async (regionId, result) => {
          const canonical = await get().canonicalizeAgentLaunch(result) ?? result
          let gap: string | undefined
          set(current => {
            const owner = findWorkbenchRegion(current.tabs, regionId)
            const attached = ownsSessionLaunch(owner?.surface, 'agent', result.created.agentSessionId)
              ? reduceAgentSessionLaunchAttached(current, regionId, canonical)
              : reduceDetachedAgentLaunch(current, canonical)
            gap = attached.timelineGapSessionId
            const landing = resolveSpatialCommit(attached.state.tabs, regionId, { kind: 'agent', sessionId: result.created.agentSessionId })
            return { ...attached.state, ...(landing.kind === 'displaced' ? { displacedAgentSessionIds: [...new Set([...current.displacedAgentSessionIds, result.created.agentSessionId])] } : {}) }
          })
          if (gap) void get().resyncTimeline(gap)
        },
        save: saveWorkbenchSelection,
        recordRemovedTab: tabId => coreSpatialPersistence?.removeEntity(tabId),
        preserveMovedFocus: from => {
          const state = get(), tab = state.tabs[from.tabId], layout = state.layouts[from.displayWorkspaceId]
          const group = layout?.groups.find(group => group.id === from.groupId)
          if (state.activeWorkspaceId === from.displayWorkspaceId && layout?.activeGroupId === from.groupId &&
            group?.activeTabId === from.tabId && tab?.layout.activeRegionId === from.regionId) set({ regionCaretFocus: null,
              retainedSpatialFocus: { ...from, ...(tab.topicId ? { topicId: tab.topicId } : {}) } })
        },
        focus: address => {
          const tab = get().tabs[address.tabId], layout = get().layouts[address.displayWorkspaceId]
          const group = layout?.groups.find(group => group.id === address.groupId && group.tabOrder.includes(address.tabId))
          if (!tab || !group) return
          void get().selectWorkspace(address.displayWorkspaceId)
          get().activateTab(address.displayWorkspaceId, address.groupId, address.tabId)
          get().focusRegion(address.displayWorkspaceId, address.tabId, address.regionId, 'keyboard', address.groupId)
        },
        isFocused: address => {
          const state = get(), tab = state.tabs[address.tabId], layout = state.layouts[address.displayWorkspaceId]
          const group = layout?.groups.find(group => group.id === address.groupId)
          return Boolean(tab && state.mainSurface === 'workbench' && state.retainedSpatialFocus === null &&
            state.activeWorkspaceId === address.displayWorkspaceId && layout?.activeGroupId === address.groupId &&
            group?.activeTabId === address.tabId && tab.layout.activeRegionId === address.regionId)
        },
        notice: notice => get().reportError(new Error(`${notice.message} ${notice.recovery}`)),
        closing: tabId => !workbenchViewCloseAllowsView(get().closingWorkbenchViews, tabId)
      }, request, signal, options)
    }
    const input = () => {
      const state = get()
      return { sessions: state.sessions, tabs: state.tabs, layouts: state.layouts }
    }
    const requireActive = (): void => {
      if (signal?.aborted) throw controlCancellation(signal)
    }
    const resolveExecutorId = (requested: string): string => {
      const executors = get().config?.executors ?? {}
      if (executors[requested]) return requested
      const matches = Object.entries(executors)
        .filter(([, executor]) => executor.label.trim().toLocaleLowerCase() === requested.trim().toLocaleLowerCase())
        .map(([id]) => id)
      if (matches.length === 1) return matches[0]!
      if (matches.length > 1) throw controlFailure('INVALID_CONTROL_REQUEST', `Executor name is ambiguous: ${requested}`)
      return requested
    }
    const agentSession = (
      target: { kind: 'self' } | { kind: 'agent-session'; agentSessionId: string },
      caller?: { agentSessionId: string }
    ): Extract<SessionSnapshot, { kind: 'agent' }> => {
      const id = target.kind === 'self' ? caller?.agentSessionId : target.agentSessionId
      if (!id) throw controlFailure('INVALID_CONTROL_REQUEST', 'A self selector requires a managed caller.')
      const session = get().sessions.find((candidate) => candidate.id === id)
      if (!session || session.kind !== 'agent') {
        throw controlFailure('UNKNOWN_AGENT_SESSION', 'Agent Session is not available to the Desktop.')
      }
      if (!workbenchViewCloseAllowsSession(get().closingWorkbenchViews, id)) {
        throw controlFailure('SESSION_CLOSING', 'Agent Session is closing.')
      }
      return session
    }
    requireActive()
    if (request.operation === 'message.pending.ls' || request.operation === 'message.pending.edit' || request.operation === 'message.pending.send' || request.operation === 'message.pending.stop' ||
        request.operation === 'message.pending.archive' || request.operation === 'message.pending.restore') {
      const session = agentSession({ kind: 'agent-session', agentSessionId: request.agentSessionId })
      const records = (): AgentMuxPendingMessage[] => {
        const state = get()
        const current = reconcileDeliveredSteers(state, session.id)
        return (current.agentSteerQueues[session.id] ?? []).map(entry =>
          pendingSteerRecord(entry, state.agentSteerInFlight[session.id], state.agentSteerInFlightPhase[session.id],
            !entry.directInputBinding && Boolean(confirmedSteerDelivery(state.timelines[session.id], session.control, entry.operationId))))
      }
      if (request.operation === 'message.pending.ls') return { operation: request.operation, agentSessionId: session.id, messages: records() }
      const before = records().find(item => item.pendingId === request.pendingId)
      if (!before) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'This original pending message is no longer available. No new message was created.')
      if (request.operation === 'message.pending.stop') {
        const changed = await get().cancelAgentSteerPreparation(session.id, request.pendingId)
        const message = records().find(item => item.pendingId === request.pendingId)
        if (!message || message.preparationWait?.state !== 'stopped' && !message.inputWait?.stop) {
          throw controlFailure('CONTROL_REQUEST_CONFLICT', 'This original message has no active preparation backoff to stop. Its message and Run are kept.')
        }
        return { operation: request.operation, agentSessionId: session.id, message, changed }
      }
      if (request.operation === 'message.pending.edit') {
        get().editQueuedAgentSteer(session.id, request.pendingId, request.expectedText, request.text)
        const message = records().find(item => item.pendingId === request.pendingId)!
        return { operation: request.operation, agentSessionId: session.id, message, changed: before.text !== message.text }
      }
      if (request.operation === 'message.pending.archive' || request.operation === 'message.pending.restore') {
        const result = await get().archiveAgentSteer(session.id, request.pendingId, request.expectedText, request.operation === 'message.pending.archive')
        // Capture the successful mutation itself. A later delivery event can remove restored
        // Pending before a reader inspects it; that event cannot erase this business result.
        const facts = { agentSessionId: session.id, message: pendingSteerRecord(result.entry, undefined, undefined,
          !result.entry.directInputBinding && Boolean(confirmedSteerDelivery(get().timelines[session.id], session.control, result.entry.operationId))), changed: result.changed }
        if (request.operation === 'message.pending.archive') return { operation: request.operation, ...facts }
        return { operation: request.operation, ...facts }
      }
      const disposition = await get().sendQueuedAgentSteer(session.id, request.pendingId)
      const message = records().find(item => item.pendingId === request.pendingId) ?? null
      return { operation: request.operation, agentSessionId: session.id, pendingId: request.pendingId,
        disposition, message }
    }
    if (request.operation === 'agent.inspect') {
      return { operation: request.operation, agentSessionId: request.agentSessionId,
        override: agentDisplayOverride(get().agentNames, request.agentSessionId) }
    }
    if (request.operation === 'agent.rename') {
      throw controlFailure('CONTROL_UNAVAILABLE', 'Display name edits belong to the public spatial label owner; this Renderer is a projection.')
    }
    if (request.operation === 'space.rename') {
      throw controlFailure('CONTROL_UNAVAILABLE', 'Tab name edits belong to the public spatial label owner; keep this workface and use that owner.')
    }
    if (request.operation === 'inspect.notifications') {
      return { operation: request.operation, observation: observeNotifications(request) }
    }
    if (request.operation === 'inspect.mote-context') {
      return { operation: request.operation, observation: observeMoteContextOperation(get().moteContextOperations, request) }
    }
    if (request.operation === 'inspect.client') {
      // Observe the displayed generation; directory refresh belongs to its original owner.
      const state = get()
      const workspace = state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
      const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace) ?? []
      const selection = desktopSelection(state, spatialCatalog(state, topics))
      const presentation = readDesktopPresentation(selection, state.tabs)
      const sessions = sessionPresentationById(state.sessions)
      const observation: DesktopWorkbenchObservation = {
        loading: state.loading, startupProgress: state.startupProgress, startupAgentAvailability: state.startupAgentAvailability,
        activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface,
        focus: { executionSessionId: state.agentFocus.execution.sessionId, pmoSessionId: state.agentFocus.pmo.sessionId },
        survey: { collectedZoneIds: Object.keys(state.surveyCollectedZones).filter(id => state.surveyCollectedZones[id] === true),
          organization: state.surveyOrganization, selection: persistedSurveyZoneSelection(state.surveyZoneSelection) },
        desktop: { selection, ...presentation,
          focus: { executionSessionId: state.agentFocus.execution.sessionId, pmoSessionId: state.agentFocus.pmo.sessionId, agent: readFocusAgentPresentation(state.focusAgentReveal) } },
        layouts: state.layouts,
        tabs: Object.values(state.tabs).map(tab => ({
          id: tab.id, workspaceId: tab.workspaceId, titleRegionId: tab.titleRegionId,
          ...(tab.topicId === undefined ? {} : { topicId: tab.topicId }),
          ...(tab.name === undefined ? {} : { name: tab.name }), layout: tab.layout,
          regions: Object.values(tab.regions).map(surface => {
            const base = { regionId: surface.regionId, workspaceId: surface.workspaceId }
            switch (surface.kind) {
              case 'agent': case 'terminal': {
                const session = sessions.get(surface.sessionId)
                const matched = session?.kind === surface.kind ? session : null
                return { ...base, kind: surface.kind, sessionId: surface.sessionId, phase: surface.phase,
                  control: surface.phase === 'attached' ? matched?.control ?? null : null,
                  processState: matched?.processState ?? null }
              }
              case 'browser': return { ...base, kind: surface.kind, browserId: surface.browserId,
                url: surface.url, title: surface.title, profileId: surface.profileId, mode: surface.mode,
                ...(!surface.nativeOwnerReleased && !surface.nativeOwnerDeferred && !surface.nativeOwnerUnavailable && surface.navigationId
                  ? { navigationId: surface.navigationId } : { navigationId: null, nativeOwner: 'unconfirmed' as const }),
                error: surface.error, loading: surface.loading }
              case 'file': return { ...base, kind: surface.kind, path: surface.path }
              case 'git': return { ...base, kind: surface.kind, scope: surface.scope, selection: surface.selection }
              case 'git-diff': return { ...base, kind: surface.kind, comparison: surface.comparison }
              case 'launcher': return { ...base, kind: surface.kind }
              default: return assertUnreachableSurface(surface)
            }
          })
        }))
      }
      return { operation: request.operation, observation }
    }
    if (request.operation === 'inspect.tab') {
      const tab = resolveWorkbenchControlTab(input(), request.target, request.caller)
      return { operation: request.operation, tab: inspectWorkbenchControlTab(input(), tab) }
    }
    if (request.operation === 'inspect.region') {
      const region = resolveWorkbenchControlRegion(input(), request.target, request.caller)
      const inspected = inspectWorkbenchControlRegion(input(), region)
      const currentSession = () => {
        const state = get()
        const surface = state.tabs[region.tabId]?.regions[region.regionId]
        if ((region.kind !== 'agent' && region.kind !== 'terminal') ||
            surface?.kind !== region.kind || surface.phase !== 'attached') return undefined
        const session = state.sessions.find(item => item.id === surface.sessionId && item.kind === region.kind)
        if (!session || (region.kind === 'agent' && session.id !== region.agentSessionId) ||
            (region.kind === 'terminal' && session.control.run.runId !== region.runId)) return undefined
        return session
      }
      const session = currentSession()
      const terminalView = session && readTerminalViewObservation({
        regionId: region.regionId, sessionId: session.id, runId: session.control.run.runId
      })
      // The getter is synchronous, but a client callback may still re-enter the Store.
      const fresh = currentSession()
      return { operation: request.operation, region: {
        ...inspected,
        ...(terminalView && fresh?.id === session?.id && fresh?.control.run.runId === terminalView.runId
          ? { terminalView } : {})
      } }
    }
    if (request.operation === 'list.agents') {
      const state = get()
      // 一个 executor 可能配在多台 Host 上，而 list.agents 是一张扁平表：按「最可用」归并——
      // available > missing > check-failed > unknown。这是旧 `.some(=== 'ready')`（「有一台 ready 就算可用」）
      // 的诚实推广。逐台的四态区分仍完整活在 ExecutorDetection（按 (host,executor) 各带一态），
      // 这里只是给 CLI 的汇总视图。归并与线上的映射共用同一处 {@link executorAvailabilityFromCheckState}。
      const availabilityRank: Record<AgentMuxExecutorAvailability, number> = {
        available: 3, missing: 2, 'check-failed': 1, unknown: 0
      }
      return {
        operation: request.operation,
        agents: Object.entries(state.config?.executors ?? {}).map(([executorId, executor]) => ({
          executorId,
          label: executor.label,
          providerId: executor.providerId,
          availability: (state.config?.workspaces ?? [])
            .map((workspace) => executorAvailabilityFromCheckState(
              currentExecutorDetection(state.executorDetections[executorDetectionKey(workspace.hostId, executorId)], executorId, executor,
                state.config?.hosts.find(host => host.id === workspace.hostId))?.state
            ))
            .reduce<AgentMuxExecutorAvailability>(
              (best, current) => (availabilityRank[current] > availabilityRank[best] ? current : best),
              'unknown'
            )
        }))
      }
    }
    if (request.operation === 'list.projects' || request.operation === 'list.active-agents') {
      const state = get()
      const workspaces = state.config?.workspaces ?? []
      const projects = projectWorkspaces(workspaces.filter(workspace => !isScratchWorkspaceId(workspace.id)))
      const projectForSession = (session: SessionSnapshot) => {
        const workspace = workspaces.find(workspace => workspace.hostId === session.hostId && !isScratchWorkspaceId(workspace.id) && workspaceOwnsSessionPath(workspace, session))
        return workspace ? projects.find(project => project.id === workspaceProjectId(workspace)) : undefined
      }
      let observed = state.sessions
      if (request.operation === 'list.active-agents' && request.agentSessionId !== undefined) {
        const target = agentSession({ kind: 'agent-session', agentSessionId: request.agentSessionId })
        // A first send asks for this exact binding only, not a refresh of every live Session.
        observed = [await api.sessions.refresh(target.control)]
      }
      const activeAgents = observed.filter((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => session.kind === 'agent').map((session) => {
        const project = projectForSession(session)
        return {
          agentSessionId: session.id,
          ...(session.promptSubmissionPredecessor === undefined ? {} : { promptCondition: {
            expectedRun: { ...session.control.run }, afterSubmissionId: session.promptSubmissionPredecessor } }),
          projectId: project?.id ?? null,
          projectName: project?.name ?? null,
          workspacePath: session.workspacePath,
          providerId: session.providerId,
          executorId: session.executorId,
          processState: session.processState,
          status: session.processState === 'running' ? 'active' as const : session.processState === 'exited' ? 'idle' as const : 'unknown' as const,
          updatedAt: session.updatedAt
        }
      })
      if (request.operation === 'list.active-agents') return { operation: request.operation, agents: activeAgents }
      return {
        operation: request.operation,
        projects: projects.map(project => {
          const workspace = project.workspaces.find(workspace => workspace.id === project.preferredWorkspaceId)!
          return { projectId: project.id, name: project.name, hostId: project.hostId,
            path: project.repoPath, kind: workspace.kind, repoPath: workspace.repoPath ?? null, branch: workspace.branch ?? null,
            activeAgentSessionIds: activeAgents.filter(agent => agent.projectId === project.id && agent.status === 'active').map(agent => agent.agentSessionId) }
        })
      }
    }
    const controlProject = (id: string) => projectWorkspaces((get().config?.workspaces ?? []).filter(workspace => !isScratchWorkspaceId(workspace.id))).find(project => project.id === id)
    const demandRecord = (id: string): DemandRecord & { assigneeSessionIds: string[]; supervisorSessionId: string | null; participations: NonNullable<DemandRecord['participations']> } => {
      const demand = projectDemands(get().config, get().sessions, get().demands).find((candidate) => candidate.id === id)
      if (!demand) throw controlFailure('CONTROL_FAILED', `Demand is not available: ${id}`)
      const { sessions: _sessions, workspacePath: _workspacePath, ...record } = demand
      return { ...record, assigneeSessionIds: [...(record.assigneeSessionIds ?? [])], supervisorSessionId: record.supervisorSessionId ?? null, participations: record.participations ?? [] }
    }
    if (request.operation === 'demand.list' || request.operation === 'demand.show') {
      const facts = await api.demands.list()
      const retained = get().demands
      const records = Object.fromEntries(facts.map(demand => [demand.id, demandRecordFromFilesystem(demand, retained[demand.id])]))
      set(state => ({ demands: { ...state.demands, ...records } }))
      refreshKnownGoalResponsibilities(facts.map(goal => goal.id))
      const projected = projectDemands(get().config, get().sessions, records)
      if (request.operation === 'demand.list') {
        return { operation: request.operation, demands: projected.map(({ sessions: _sessions, workspacePath: _workspacePath, ...record }) => ({ ...record, assigneeSessionIds: [...(record.assigneeSessionIds ?? [])], supervisorSessionId: record.supervisorSessionId ?? null, participations: record.participations ?? [] })) }
      }
      const demand = projected.find((candidate) => candidate.id === request.demandId)
      if (!demand) return { operation: request.operation, demand: null, goalContinuations: await api.continuousProgress.goals(request.demandId) }
      const { sessions: _sessions, workspacePath: _workspacePath, ...record } = demand
      return { operation: request.operation, demand: { ...record, assigneeSessionIds: [...(record.assigneeSessionIds ?? [])], supervisorSessionId: record.supervisorSessionId ?? null, participations: record.participations ?? [] }, goalContinuations: await api.continuousProgress.goals(request.demandId) }
    }
    if (request.operation === 'demand.activity.append') {
      const saved = await api.demands.activity(request.demandId, { kind: request.kind, message: request.message, actorId: null, operationId: request.requestId }, request.requestId)
      const activity = saved.demand.activities.find(item => item.operationId === request.requestId)
      if (!activity) throw controlFailure('CONTROL_FAILED', 'The original activity commit is unconfirmed. Inspect this same operation; the Goal and Agent are retained.')
      set(state => ({ demands: { ...state.demands, [saved.demand.id]: demandRecordFromFilesystem(saved.demand, state.demands[saved.demand.id]) } }))
      return { operation: request.operation, demand: demandRecord(request.demandId), activity,
        receipt: { demandId: request.demandId, requestId: request.requestId, activityId: activity.id, diskDurability: 'confirmed', replayed: saved.replayed === true } }
    }
    if (request.operation === 'demand.activity.inspect') {
      const inspected = await api.demands.inspectActivity(request.demandId, request.requestId)
      return { operation: request.operation, demandId: inspected.demandId, requestId: inspected.operationId, activity: inspected.activity, diskDurability: inspected.diskDurability }
    }
    if (request.operation === 'demand.activity.read') {
      return { operation: request.operation, ...await api.demands.readActivities(request.demandId) }
    }
    if (request.operation === 'demand.discuss') {
      await get().refreshDemand(request.demandId)
      let receipt: GoalPmoReceipt | undefined
      const capture = (value: GoalPmoReceipt): void => { receipt = value }
      const tabId = request.mode === 'open' ? await get().openDemandPmo(request.demandId, capture) : await get().requestDemandPmoTask(request.demandId, request.mode, { onReceipt: capture })
      return { operation: request.operation, demand: demandRecord(request.demandId), receipt: { demandId: request.demandId, requestId: request.requestId, mode: request.mode, tabId, agentSessionId: receipt?.agentSessionId ?? null } }
    }
    if (request.operation === 'demand.confirm') {
      await get().confirmDemandGoal(request.demandId, request.expectedRevision)
      const demand = demandRecord(request.demandId)
      return { operation: request.operation, demand, receipt: { demandId: demand.id, confirmedRevision: demand.alignment!.revision, confirmedAt: demand.alignment!.confirmedAt! } }
    }
    if (request.operation === 'demand.accept') {
      await get().acceptDemandResult(request.demandId, request.expectedAlignmentRevision, request.expectedSubmissionId, request.acceptGaps, request.finish)
      const demand = demandRecord(request.demandId)
      return { operation: request.operation, demand, receipt: { demandId: demand.id, alignmentRevision: demand.grounding!.alignmentRevision, submissionId: demand.grounding!.submissionId, acceptedAt: demand.grounding!.acceptedAt!, acceptedWithGaps: demand.grounding!.checks.some(check => check.outcome === 'gap') } }
    }
    if (request.operation === 'demand.continuation-action') {
      const continuation = await api.continuousProgress.goalAction(request.demandId, request.loopId, request.action, request.expectedRevision, request.requestId, request.caller)
      return { operation: request.operation, demandId: request.demandId, continuation, diskDurability: 'confirmed' }
    }
    if (request.operation === 'demand.create') {
      const project = request.projectId ? controlProject(request.projectId) : undefined
      if (request.projectId && !project) throw controlFailure('UNKNOWN_WORKSPACE', `Project is not available: ${request.projectId}`)
      const policy = demandWriteDecision({
        mode: 'risk-confirm',
        risk: request.decision?.risk ?? 'unknown',
        projectKnown: request.projectId === undefined || Boolean(project),
        hasConfirmation: request.decision?.confirmation === 'user' || request.decision?.confirmation === 'automatic'
      })
      if (policy !== 'automatic') throw controlFailure('CONTROL_FAILED', policy === 'blocked' ? 'Demand routing is unresolved; choose a Project before writing.' : 'Demand write requires explicit confirmation.')
      const id = await get().createDemand({
        ...(request.demandId === undefined ? {} : { id: request.demandId }),
        title: request.title,
        ...(request.description === undefined ? {} : { description: request.description }),
        projectId: request.projectId ?? null,
        projectName: project?.name ?? null,
        ...(request.priority === undefined ? {} : { priority: request.priority }),
        ...(request.status === undefined ? {} : { status: request.status }),
        ...(request.sessionIds === undefined ? {} : { sessionIds: request.sessionIds }),
        ...(request.assigneeSessionIds === undefined ? {} : { assigneeSessionIds: request.assigneeSessionIds }),
        ...(request.supervisorSessionId === undefined ? {} : { supervisorSessionId: request.supervisorSessionId }),
        ...(request.contentRefs === undefined ? {} : { contentRefs: request.contentRefs }),
        ...(request.decision === undefined ? {} : { decisionLog: [request.decision] })
      }, request.requestId)
      const demand = demandRecord(id)
      return { operation: request.operation, demand, receipt: { demandId: id, createdAt: demand.createdAt } }
    }
    if (request.operation === 'demand.update') {
      const current = demandRecord(request.demandId)
      const projectId = request.patch.projectId === undefined ? current.projectId : request.patch.projectId
      const project = projectId ? controlProject(projectId) : undefined
      if (projectId && !project) throw controlFailure('UNKNOWN_WORKSPACE', `Project is not available: ${projectId}`)
      await get().updateDemand(request.demandId, { ...request.patch, ...(request.patch.projectId !== undefined ? { projectName: project?.name ?? null } : {}), ...(request.decision ? { decisionLog: [...(current.decisionLog ?? []), request.decision] } : {}) }, request.requestId, request.expectedUpdatedAt)
      const demand = demandRecord(request.demandId)
      return { operation: request.operation, demand, receipt: { demandId: demand.id, updatedAt: demand.updatedAt } }
    }
    const appendDemandActivity = async (demandId: string, message: string) => {
      const current = demandRecord(demandId)
      await get().updateDemand(demandId, { activityLog: [...(current.activityLog ?? []), message] })
    }
    const startDemand = async (demandId: string, sessionId?: string, continuation?: { intervalMs: number; alignmentRevision: number }, businessOperationId?: string, caller?: import('@agentmux/core').AgentMuxControlCaller, expectedUpdatedAt?: number) => {
      let savedContinuation: import('@agentmux/core').ContinuousProgressLoop | undefined
      const sourceForStart = (canonicalSessionId: string, hostId?: string) => {
        const matches = get().sessions.filter((candidate): candidate is Extract<SessionSnapshot, { kind: 'agent' }> => candidate.kind === 'agent' && candidate.control.agentSessionId === canonicalSessionId && (hostId === undefined || candidate.control.hostId === hostId))
        if (matches.length !== 1) throw controlFailure(matches.length > 1 ? 'CONTROL_REQUEST_CONFLICT' : 'UNKNOWN_AGENT_SESSION', `The exact responsible Agent Session has ${matches.length > 1 ? 'ambiguous' : 'unconfirmed'} presentation: ${canonicalSessionId}. Its saved identity and manual input are retained.`)
        const source = matches[0]!
        if (source.hostId !== source.control.hostId) throw controlFailure('STALE_AGENT_SESSION', 'The original Goal Session Host mapping is unconfirmed. Manual input is retained.')
        return source
      }
      if (continuation) {
        if (!sessionId || !businessOperationId) throw controlFailure('INVALID_CONTROL_REQUEST', 'Continuation needs an exact Session and stable business operation.')
        const originalStarts = (await api.continuousProgress.goals(demandId)).filter(loop => loop.creationOperationId === businessOperationId)
        if (originalStarts.length > 1) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'This original start has ambiguous durable loop facts. Your Agent and input are retained.')
        const originalStart = originalStarts[0]
        if (originalStart) {
          savedContinuation = await api.continuousProgress.prepareGoal({ goalId: demandId, agentSessionId: sessionId, hostId: originalStart.hostId, providerId: originalStart.providerId, workspacePath: originalStart.workspacePath, alignmentRevision: continuation.alignmentRevision, intervalMs: continuation.intervalMs, operationId: businessOperationId, prompt: originalStart.initialDelivery?.prompt ?? '' }, caller)
          if (savedContinuation.initialDelivery?.state === 'confirmed') {
            // Preserve the original Loop receipt first. Dispatch bookkeeping is an observation
            // of its original Core input; failure cannot revoke that confirmed delivery.
            try {
              const reference = { goalId: demandId, operationId: businessOperationId }
              let dispatch = await api.demands.inspectDispatch(reference)
              if (dispatch && dispatch.stage !== 'confirmed') {
                const receipt = await api.demands.reconcileDispatch(reference)
                dispatch = receipt.demand.id === demandId ? receipt.demand.dispatches?.find(entry => entry.operationId === businessOperationId) ?? null : null
              }
              if (dispatch?.stage === 'confirmed') {
                set(state => ({ agentSteerQueues: Object.fromEntries(Object.entries(state.agentSteerQueues).map(([id, queue]) => [id,
                  queue.filter(entry => entry.goalDispatch?.goalId !== demandId || entry.goalDispatch.operationId !== businessOperationId)])) }))
              }
            } catch (error) { get().reportError(error, { kind: 'indeterminate', summary: 'The original Loop input is confirmed. Its Goal dispatch record is unconfirmed; inspect the same operation without sending again.' }) }
            try { await get().refreshDemand(demandId) }
            catch (error) { get().reportError(error, { kind: 'indeterminate', summary: 'The original start is confirmed. Reading the current Goal is unconfirmed; its saved view and original receipt are retained. Refresh this same Goal to reconnect its latest state.' }) }
            return { sessionId: savedContinuation.agentSessionId, startedAt: savedContinuation.initialDelivery.startedAt, demand: demandRecord(demandId), continuation: savedContinuation }
          }
        }
      }
      if (!businessOperationId) throw controlFailure('INVALID_CONTROL_REQUEST', 'Goal Start needs its stable original operation.')
      const dispatchReference = { goalId: demandId, operationId: businessOperationId }
      let originalDispatch = await api.demands.inspectDispatch(dispatchReference)
      if (originalDispatch) {
        if (sessionId !== undefined && originalDispatch.agentSessionId !== sessionId || Boolean(continuation) !== (originalDispatch.execution === 'continue') ||
            continuation && continuation.alignmentRevision !== originalDispatch.alignmentRevision) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'The original Start target or confirmed scope changed. Inspect the same operation without resending.')
        if (originalDispatch.stage !== 'confirmed') {
          try { await api.demands.reconcileDispatch(dispatchReference); originalDispatch = await api.demands.inspectDispatch(dispatchReference) }
          catch (error) { if (!(error instanceof Error) || (error as Error & { code?: string }).code !== 'CONTROL_UNAVAILABLE') throw error }
        }
        if (originalDispatch?.stage === 'confirmed') {
          // A read of the original receipt needs neither a live Run nor present-day assignees.
          set(state => ({ agentSteerQueues: Object.fromEntries(Object.entries(state.agentSteerQueues).map(([id, queue]) => [id,
            queue.filter(entry => entry.goalDispatch?.goalId !== demandId || entry.goalDispatch.operationId !== businessOperationId)])) }))
          try { await get().refreshDemand(demandId) } catch (error) { get().reportError(error) }
          let originalLoop = originalDispatch.loopId ? (await api.continuousProgress.goals(demandId)).find(loop => loop.loopId === originalDispatch!.loopId) : undefined
          if (originalLoop && originalLoop.initialDelivery?.state !== 'confirmed') {
            try { originalLoop = await api.continuousProgress.initialGoalInput(originalLoop, originalLoop.loopId, businessOperationId, 'confirm') }
            catch (error) { get().reportError(error, { kind: 'indeterminate', summary: 'The original Core input is confirmed. Its Loop receipt is unconfirmed; inspect the same Loop without sending again.' }) }
          }
          return { sessionId: originalDispatch.agentSessionId, startedAt: originalLoop?.initialDelivery?.startedAt ?? originalDispatch.preparedAt, demand: demandRecord(demandId), ...(originalLoop ? { continuation: originalLoop } : {}) }
        }
      }
      const facts = await api.demands.list()
      const fresh = facts.find(goal => goal.id === demandId)
      if (!fresh) throw controlFailure('CONTROL_UNAVAILABLE', 'The original Goal is unavailable. Its Agent, input and saved continuation are retained.')
      set(state => ({ demands: { ...state.demands, [demandId]: demandRecordFromFilesystem(fresh, state.demands[demandId]) } }))
      refreshKnownGoalResponsibilities([demandId])
      const current = demandRecord(demandId)
      const assigneeSessionIds = current.assigneeSessionIds ?? []
      if (continuation) {
        if (!sessionId || !businessOperationId) throw controlFailure('INVALID_CONTROL_REQUEST', 'Continuation needs an exact Session and stable business operation.')
        if (!savedContinuation) {
          if (!assigneeSessionIds.includes(sessionId) || current.supervisorSessionId !== sessionId) throw controlFailure('INVALID_CONTROL_REQUEST', 'Choose and save this exact responsible Session as the Goal Supervisor before starting Continue.')
          const selected = sourceForStart(sessionId)
          if (selected.processState !== 'running') throw controlFailure('STALE_AGENT_SESSION', 'The original Goal Session running target is unconfirmed. Manual input is retained.')
          savedContinuation = await api.continuousProgress.prepareGoal({ goalId: demandId, agentSessionId: selected.control.agentSessionId, hostId: selected.control.hostId, providerId: selected.providerId, workspacePath: selected.workspacePath, alignmentRevision: continuation.alignmentRevision, intervalMs: continuation.intervalMs, operationId: businessOperationId, prompt: current.description.trim() || current.title }, caller)
        }
        const live = sourceForStart(sessionId, savedContinuation.hostId)
        if (live.control.agentSessionId !== savedContinuation.agentSessionId || live.providerId !== savedContinuation.providerId || live.workspacePath !== savedContinuation.workspacePath || live.control.run.runId !== savedContinuation.initialDelivery?.condition.expectedRun.runId) throw controlFailure('STALE_AGENT_SESSION', 'The original Session changed after its start was saved. Its loop and healthy Agent are retained.')
      }
      const attachedSessionId = originalDispatch?.agentSessionId ?? sessionId ?? (assigneeSessionIds.length === 1 ? assigneeSessionIds[0] : null)
      let session: Extract<SessionSnapshot, { kind: 'agent' }>
      try {
        if (!attachedSessionId || !originalDispatch && !savedContinuation && !assigneeSessionIds.includes(attachedSessionId)) throw controlFailure('INVALID_CONTROL_REQUEST', 'Choose an exact responsible Session before starting. With multiple assignees, select this start’s Agent explicitly; creating or saving an Agent does not start work.')
        session = sourceForStart(attachedSessionId, originalDispatch?.hostId ?? savedContinuation?.hostId)
      } catch (error) {
        // Only local rejection before this fresh finite preparation is known not applied.
        // Existing operations, Loop preparation and any owner/transport call keep unknown.
        if (!originalDispatch && !continuation && error instanceof Error) Object.assign(error, { controlFailure: { disposition: 'not_applied', confirmedInputBytes: null } })
        throw error
      }
      const original = savedContinuation?.initialDelivery
      const prompt = originalDispatch?.prompt ?? original?.prompt ?? (current.description.trim() || current.title)
      const prepared = await api.demands.prepareGoalStart(demandId, originalDispatch ? { operationId: originalDispatch.operationId, agentSessionId: originalDispatch.agentSessionId, hostId: originalDispatch.hostId, runId: originalDispatch.runId, execution: originalDispatch.execution, prompt: originalDispatch.prompt, ...(originalDispatch.loopId ? { loopId: originalDispatch.loopId, alignmentRevision: originalDispatch.alignmentRevision } : {}) } : {
        operationId: businessOperationId, agentSessionId: session.control.agentSessionId, hostId: session.control.hostId,
        runId: session.control.run.runId, execution: savedContinuation ? 'continue' : 'finite', prompt,
        ...(savedContinuation ? { loopId: savedContinuation.loopId, alignmentRevision: continuation!.alignmentRevision } : {})
      }, options?.admittedControlRequestId, expectedUpdatedAt ?? current.updatedAt)
      if ('conflict' in prepared) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'The Goal changed. Read its current content before starting this task. No input was submitted.', { controlFailure: { disposition: 'not_applied', confirmedInputBytes: null } })
      set(state => ({ demands: { ...state.demands, [demandId]: demandRecordFromFilesystem(prepared.demand, state.demands[demandId]) } }))
      refreshKnownGoalResponsibilities([demandId])
      const operationId = admitAgentSteer(session.id, prompt, undefined, businessOperationId, undefined, undefined,
        original && savedContinuation ? { goalDispatch: dispatchReference, goalContinuation: { goalId: demandId, loopId: savedContinuation.loopId, condition: original.condition } } : { goalDispatch: dispatchReference, execution: 'default' })
      if (!operationId) throw controlFailure('CONTROL_FAILED', 'The message could not be queued. Its content is kept.')
      await get().sendQueuedAgentSteer(session.id, operationId)
      const retained = get().agentSteerQueues[session.id]?.find(entry => entry.operationId === operationId)
      if (retained) throw controlFailure('CONTROL_FAILED', retained.error ?? 'The execution message is queued; delivery is not yet confirmed.')
      await get().updateDemand(demandId, { status: 'in_progress' })
      await appendDemandActivity(demandId, attachedSessionId ? `Execution started with Session ${attachedSessionId}.` : 'Execution start requested.')
      if (savedContinuation && attachedSessionId) savedContinuation = await api.continuousProgress.initialGoalInput(savedContinuation, savedContinuation.loopId, businessOperationId!, 'confirm')
      return { sessionId: attachedSessionId, startedAt: savedContinuation?.initialDelivery?.startedAt ?? prepared.demand.dispatches!.find(dispatch => dispatch.operationId === businessOperationId)!.preparedAt, demand: demandRecord(demandId), ...(savedContinuation ? { continuation: savedContinuation } : {}) }
    }
    if (request.operation === 'demand.assign') {
      const current = demandRecord(request.demandId)
      const projectId = request.projectId === undefined ? current.projectId : request.projectId
      const project = projectId ? controlProject(projectId) : undefined
      if (projectId && !project) throw controlFailure('UNKNOWN_WORKSPACE', `Project is not available: ${projectId}`)
      await get().updateDemand(request.demandId, { ...(request.projectId === undefined ? {} : { projectId, projectName: project?.name ?? null }), ...(request.assigneeSessionIds === undefined ? {} : { assigneeSessionIds: request.assigneeSessionIds }), ...(request.supervisorSessionId === undefined ? {} : { supervisorSessionId: request.supervisorSessionId }) }, request.requestId, request.expectedUpdatedAt ?? current.updatedAt)
      await appendDemandActivity(request.demandId, request.start ? 'Assigned and start requested.' : 'Assigned without starting execution.')
      if (request.start) {
        const started = await startDemand(request.demandId, request.sessionId, undefined, request.requestId)
        return { operation: request.operation, demand: started.demand, receipt: { demandId: request.demandId, assignedAt: Date.now(), startRequested: true } }
      }
      return { operation: request.operation, demand: demandRecord(request.demandId), receipt: { demandId: request.demandId, assignedAt: Date.now(), startRequested: false } }
    }
    if (request.operation === 'demand.start') {
      const started = await startDemand(request.demandId, request.sessionId, request.continuation, request.requestId, request.caller, request.expectedUpdatedAt)
      return { operation: request.operation, demand: started.demand, ...(started.continuation ? { continuation: started.continuation } : {}), receipt: { demandId: request.demandId, startedAt: started.startedAt, sessionId: started.sessionId } }
    }
    if (request.operation === 'demand.handoff') {
      const current = demandRecord(request.demandId)
      await get().updateDemand(request.demandId, { ...(request.assigneeSessionIds === undefined ? request.sessionId ? { assigneeSessionIds: [request.sessionId] } : {} : { assigneeSessionIds: request.assigneeSessionIds }), ...(request.supervisorSessionId === undefined ? {} : { supervisorSessionId: request.supervisorSessionId }) }, request.requestId, request.expectedUpdatedAt ?? current.updatedAt)
      await appendDemandActivity(request.demandId, `Handoff to ${(request.assigneeSessionIds ?? (request.sessionId ? [request.sessionId] : [])).join(', ') || 'unassigned'}.`)
      return { operation: request.operation, demand: demandRecord(request.demandId), receipt: { demandId: request.demandId, handedOffAt: Date.now(), sessionId: request.sessionId ?? null } }
    }
    if (request.operation === 'demand.delete') {
      const demand = demandRecord(request.demandId)
      await api.demands.delete(request.demandId)
      set((state) => {
        const { [request.demandId]: _removed, ...demands } = state.demands
        return { demands, ...(state.selectedDemandId === request.demandId ? { selectedDemandId: null } : {}) }
      })
      return { operation: request.operation, demand, receipt: { demandId: request.demandId, deletedAt: Date.now() } }
    }
    if (request.operation === 'demand.link-session') {
      const current = demandRecord(request.demandId)
      if (!get().sessions.some((session) => session.id === request.sessionId)) throw controlFailure('UNKNOWN_AGENT_SESSION', `Agent Session is not available: ${request.sessionId}`)
      const sessionIds = current.sessionIds.includes(request.sessionId) ? current.sessionIds : [...current.sessionIds, request.sessionId]
      await get().updateDemand(request.demandId, { sessionIds })
      return { operation: request.operation, demand: demandRecord(request.demandId), receipt: { demandId: request.demandId, sessionId: request.sessionId } }
    }
    if (request.operation === 'demand.link-project') {
      const project = controlProject(request.projectId)
      if (!project) throw controlFailure('UNKNOWN_WORKSPACE', `Project is not available: ${request.projectId}`)
      await get().updateDemand(request.demandId, { projectId: project.id, projectName: project.name })
      return { operation: request.operation, demand: demandRecord(request.demandId), receipt: { demandId: request.demandId, projectId: project.id } }
    }
    if (request.operation === 'demand.decision-log') {
      const demand = demandRecord(request.demandId)
      return { operation: request.operation, demandId: request.demandId, decisions: demand.decisionLog ?? [] }
    }
    if (request.operation === 'focus') {
      const originalNavigation = fileNavigationSelection(get())
      let navigationChanged = false
      const stopObservingNavigation = useAppStore.subscribe(state => {
        if (fileNavigationSelection(state) !== originalNavigation) navigationChanged = true
      })
      signal?.addEventListener('abort', stopObservingNavigation, { once: true })
      const issues: AgentMuxSpatialIssue[] = []
      let topics: ScratchTopicSnapshot[] = []
      try { if (request.target.kind === 'space' && get().config?.workspaces.some(workspace => workspace.id === SCRATCH_WORKSPACE_ID)) topics = await api.scratch.listTopics(SCRATCH_WORKSPACE_ID) }
      catch (error) { issues.push({ step: 'discovery', code: 'SPACE_DISCOVERY_UNCONFIRMED', message: presentError(error),
        recovery: 'Existing placement is kept. Inspect the client or retry discovery when its directory owner is available.' }) }
      finally { stopObservingNavigation(); signal?.removeEventListener('abort', stopObservingNavigation) }
      const catalog = spatialCatalog(get(), topics)
      const before = captureDesktopInput(get().tabs)
      const beforeSelection = desktopSelection(get(), catalog)
      let navigationState: AgentMuxDesktopFocusResult['navigation']['state'] = 'applied'
      try {
        requireActive()
        if (navigationChanged || fileNavigationSelection(get()) !== originalNavigation) throw new DesktopFocusFailure({ step: 'navigation', code: 'NAVIGATION_CHANGED',
          message: 'A newer navigation happened while the original target was being observed.', recovery: 'The later workface is kept. Inspect the client before explicitly retrying this target.' })
        if (request.target.kind === 'goal') {
          if (!Object.hasOwn(get().demands, request.target.goalId)) throw new DesktopFocusFailure({ step: 'target', code: 'GOAL_UNKNOWN',
            message: 'The exact Goal is not currently in the complete Demand projection.', recovery: 'List Goals and choose an existing Demand ID.' })
          // Viewing a Goal never selects its associated execution workface.
          get().setSelectedDemand(request.target.goalId)
          set({ mainSurface: 'board', regionCaretFocus: null, workbenchNavigationInputPolicy: request.inputPolicy })
        } else if (request.target.kind === 'focus-agent') {
          get().revealFocusAgent(request.target)
        } else if (request.target.kind === 'surface') {
          get().setMainSurface(desktopMainSurface[request.target.surface])
          if (request.target.surface === 'focus' && request.target.view !== undefined) get().setFocusView(request.target.view)
          set({ workbenchNavigationInputPolicy: request.inputPolicy })
        } else {
          const resolved = resolveDesktopSpaceSelection(get(), catalog, request.target)
          if (request.expectedAgentSessionId !== undefined) {
            const region = resolved.tabId && resolved.regionId ? get().tabs[resolved.tabId]?.regions[resolved.regionId] : null
            if (!region || region.kind !== 'agent' || region.sessionId !== request.expectedAgentSessionId) throw new DesktopFocusFailure({
              step: 'target', code: 'AGENT_LOCATION_CHANGED', message: 'The exact Region no longer contains the requested Agent Session.',
              recovery: 'The original workface and healthy Agents are kept. Inspect the original Session and choose its current exact Region.' })
          }
          // Establish the exact parent before local focus, while leaving the visible
          // surface/input policy in place until that focus has changed atomically.
          set({ workbenchSpaceSelection: resolved })
          if (resolved.tabId && resolved.regionId) get().focusRegion(resolved.workspaceId, resolved.tabId, resolved.regionId, 'pointer', resolved.groupId ?? undefined)
          set({ activeWorkspaceId: resolved.workspaceId, mainSurface: 'workbench', retainedSpatialFocus: null,
            workbenchSpaceSelection: resolved, regionCaretFocus: null, workbenchNavigationInputPolicy: request.inputPolicy })
        }
      } catch (error) {
        navigationState = 'rejected'
        const actual = error instanceof DesktopFocusFailure ? error.issue : (error as { issue?: AgentMuxSpatialIssue })?.issue
        issues.push(actual ?? { step: 'navigation', code: signal?.aborted ? 'CONTROL_CANCELLED' : 'NAVIGATION_UNCONFIRMED',
          message: presentError(error), recovery: 'The original workface is kept. Inspect the client before another navigation.' })
      }
      const expected = desktopSelection(get(), catalog)
      let caretIntentNonce: number | undefined
      const revealRequestId = request.target.kind === 'focus-agent' ? get().focusAgentReveal?.requestId : undefined
      if (navigationState !== 'rejected' && request.target.kind !== 'focus-agent' && JSON.stringify(expected) === JSON.stringify(beforeSelection)) navigationState = 'unchanged'
      if (navigationState !== 'rejected' && request.inputPolicy === 'target' && expected.space?.tabId && expected.space.regionId) {
        const observed = readDesktopPresentation(expected, get().tabs)
        if (observed.overlays.provenance === 'observed' && !observed.presentation.blockers.length) {
          get().focusRegion(expected.space.workspaceId, expected.space.tabId, expected.space.regionId, 'keyboard', expected.space.groupId ?? undefined)
          caretIntentNonce = get().regionCaretFocus?.nonce
          set({ workbenchSpaceSelection: expected.space, workbenchNavigationInputPolicy: request.inputPolicy })
        }
      }
      if (navigationState !== 'rejected') await awaitDesktopPresentation(() => {
        const actual = desktopSelection(get(), catalog)
        if (JSON.stringify(actual) !== JSON.stringify(expected)) return true
        const observed = readDesktopPresentation(actual, get().tabs)
        if (request.target.kind === 'focus-agent') return get().focusAgentReveal?.requestId !== revealRequestId ||
          observed.presentation.state === 'covered' || readFocusAgentPresentation(get().focusAgentReveal)?.state === 'visible' || !get().focusAgentReveal?.pending
        return observed.presentation.state === 'covered' ||
          ((observed.presentation.state === 'main-visible' || observed.presentation.state === 'floating' || observed.presentation.state === 'window') &&
            (request.inputPolicy === 'preserve' || captureDesktopInput(get().tabs).fact.regionId === expected.space?.regionId))
      }, signal)
      const save = navigationState === 'rejected' ? { layoutApplied: false, localStorageWritten: false, storageFlushRequested: false,
        diskDurability: 'unconfirmed' as const, reason: 'No selection was applied.' } : await saveWorkbenchSelection(true)
      const selection = desktopSelection(get(), catalog)
      if (navigationState !== 'rejected' && (signal?.aborted || JSON.stringify(selection) !== JSON.stringify(expected))) {
        navigationState = 'unconfirmed'
        issues.push({ step: 'navigation', code: 'NAVIGATION_CHANGED', message: 'Selection changed before this navigation was observed.',
          recovery: 'Inspect the current client. A later selection is kept and the old input intent is not repeated.' })
      }
      if (navigationState !== 'rejected' && request.expectedAgentSessionId !== undefined) {
        const selected = selection.space
        const region = selected?.tabId && selected.regionId ? get().tabs[selected.tabId]?.regions[selected.regionId] : null
        if (!region || region.kind !== 'agent' || region.sessionId !== request.expectedAgentSessionId) {
          navigationState = 'unconfirmed'
          issues.push({ step: 'presentation', code: 'AGENT_LOCATION_CHANGED', message: 'The Region content changed before the original Agent navigation was confirmed.',
            recovery: 'The later workface and healthy Agents are kept. Inspect the original Session before explicitly retrying its link.' })
        }
      }
      const observed = readDesktopPresentation(selection, get().tabs)
      const focusAgent = readFocusAgentPresentation(get().focusAgentReveal)
      if (navigationState !== 'rejected' && request.target.kind === 'focus-agent' && (get().focusAgentReveal?.requestId !== revealRequestId ||
        focusAgent?.hostId !== request.target.hostId || focusAgent.agentSessionId !== request.target.agentSessionId || focusAgent.state !== 'visible')) {
        navigationState = 'unconfirmed'
        issues.push({ step: 'presentation', code: 'FOCUS_AGENT_UNCONFIRMED', message: 'The exact original Agent card has not been visibly confirmed in Focus.',
          recovery: 'The original filters, work and Session are kept. Inspect Focus and its original Context source before another explicit reveal.' })
      }
      const after = captureDesktopInput(get().tabs)
      const inputOutcome = request.inputPolicy === 'preserve' ? desktopInputPreserved(before, after) ? 'preserved'
        : after.fact.provenance === 'observed' ? 'unavailable' : 'unconfirmed'
        : navigationState !== 'rejected' && navigationState !== 'unconfirmed' && after.fact.regionId === expected.space?.regionId &&
          after.fact.connected === true && after.fact.visible === true && after.fact.inert === false ? 'transferred'
          : after.fact.provenance === 'observed' ? 'unavailable' : 'unconfirmed'
      if (request.inputPolicy === 'target' && inputOutcome !== 'transferred' && caretIntentNonce !== undefined) {
        get().clearRegionCaretFocus(caretIntentNonce)
      }
      const partial = navigationState === 'rejected' || navigationState === 'unconfirmed' || (observed.presentation.state !== 'main-visible' && observed.presentation.state !== 'window' && observed.presentation.state !== 'floating') ||
        inputOutcome === 'unavailable' || inputOutcome === 'unconfirmed' || !save.localStorageWritten
      if (partial && navigationState !== 'rejected') {
        const notice = { step: 'presentation', code: 'DESKTOP_PRESENTATION_PARTIAL',
          message: `Main selection is kept. Presentation: ${observed.presentation.state}; input: ${inputOutcome}.`,
          recovery: 'Keep using the current input. Inspect the client, or explicitly select the visible target when ready.' }
        issues.push(notice)
        set({ desktopNavigationNotice: notice })
      } else if (!partial) {
        set({ desktopNavigationNotice: null })
      }
      return { operation: 'focus', navigation: { state: navigationState, requested: request.target, selection,
        ...(request.expectedAgentSessionId === undefined ? {} : { expectedAgentSessionId: request.expectedAgentSessionId }) },
        presentation: observed.presentation, input: { policy: request.inputPolicy, outcome: inputOutcome, before: before.fact, after: after.fact },
        floating: observed.floating, overlays: observed.overlays,
        focus: { executionSessionId: get().agentFocus.execution.sessionId, pmoSessionId: get().agentFocus.pmo.sessionId, agent: focusAgent }, partial, save, issues }
    }
    if (request.operation === 'arrange') {
      const state = get()
      const tab = resolveWorkbenchControlTab(input(), request.target, request.caller)
      // 「预设要补几个 Region」由 arrangeWorkbenchControlTab 自己从 preset 推导——这里只交铸 id 的
      // 手段。那段推导曾住在这里，而 GUI 菜单（arrangeTabRegions，本文件下方）是它的第二个调用方：
      // 留在这里就必须被抄一份，两份必漂移。
      const arranged = arrangeWorkbenchControlTab(tab, request.mode, newRegionId)
      set({ tabs: { ...state.tabs, [tab.id]: arranged } })
      return { operation: request.operation, tab: inspectWorkbenchControlTab(input(), arranged) }
    }
    if (request.operation === 'promote.region') {
      // 促升一格成它自己的一张 Tab（#487）。树代数全在纯 reducer reducePromoteRegionToTab 里，这里
      // 不重实现——只做三件 Control 面的事：把 self/显式选择器解析成一格（复用 resolveWorkbenchControlRegion，
      // 顺带证明它真的开着）、把 reducer 的 'unchanged' 翻成 typed 失败（绝不把「什么都没做」报成一次成功
      // 的移动）、把新 Tab 坐标交回调用方。促升只搬布局投影，不碰 Runtime lifecycle：这里没有任何
      // api.sessions.* 调用，Session/Run 身份原样跟着 regionId 走。
      const region = resolveWorkbenchControlRegion(input(), request.target, request.caller)
      const result = reducePromoteRegionToTab({
        tabs: get().tabs,
        layouts: get().layouts,
        workspaceId: region.workspaceId,
        tabId: region.tabId,
        regionId: region.regionId,
        mint: { tabId: mintObjectId() }
      })
      if (result.kind !== 'promoted') {
        // 'already-sole' 是调用方**能据以行动**的那种拒绝：这一格已经独占整张 Tab，没有可搬的东西。
        // 其余 'unchanged'（输入过期、目标不合格）是请求本身不成立。两者都拒绝、都不谎报一次没发生
        // 的移动，区别在于自主调用方可以据码分支，而不必去 match 文案。
        throw result.kind === 'already-sole'
          ? controlFailure('REGION_ALREADY_SOLE', 'Region is already the only Region of its Tab; it is already its own Tab.')
          : controlFailure('CONTROL_FAILED', 'Region cannot be promoted to a new Tab.')
      }
      set((current) => ({
        ...(current.mainSurface === 'survey' || current.mainSurface === 'recall' ? {} : { retainedSpatialFocus: null,
          activeWorkspaceId: result.target.workspaceId, mainSurface: 'workbench' as const }),
        surveyZoneSelection: surveySelectionAfterPromote(current.surveyZoneSelection, region, result.target),
        recallZoneSelection: surveySelectionAfterPromote(current.recallZoneSelection, region, result.target),
        tabs: result.tabs,
        layouts: result.layouts
      }))
      return {
        operation: request.operation,
        tabId: result.target.tabId,
        regionId: result.target.regionId,
        workspaceId: result.target.workspaceId
      }
    }
    if (request.operation === 'interrupt' || request.operation === 'resume' || request.operation === 'stop') {
      const session = agentSession(request.target, request.caller)
      requireActive()
      if (request.operation === 'interrupt') {
        await api.sessions.interrupt(session.control)
        return { operation: request.operation, agentSessionId: session.id }
      }
      if (request.operation === 'stop') {
        await api.sessions.stop(session.control)
        return { operation: request.operation, agentSessionId: session.id }
      }
      const resumed = await api.sessions.resume(session.control, request.text, request.requestId)
      if (resumed.kind !== 'agent' || resumed.id !== session.id) {
        throw controlFailure('LAUNCH_RESULT_MISMATCH', 'Explicit resume returned another Agent Session.')
      }
      set((current) => projectRecoveredSession(current, session.id, resumed))
      void get().flushAgentSteerQueue(session.id)
      if (signal?.aborted) throw controlCancellation(signal)
      return { operation: request.operation, agentSessionId: resumed.id, runId: resumed.control.run.runId }
    }

    // browser.run 必须在这里拦下，不能落进下面那段。
    //
    // 下面那整段是**开**东西的路：读 request.destination 找落点、铺一个 launcher，最后无条件落到开
    // 浏览器的尾巴上（那段没有自己的 if）。browser.run 不开任何东西——它作用在一个已经开着的
    // Browser 上，没有 destination。放它过去的话，它会一路走进那条尾巴被当成 open.browser 执行：
    // **多开一个空白浏览器，而 Agent 的程序一行都没跑**，回执里还带着一个它没请求过的 region。
    //
    // 这一处是 T-008 验收点名的「两处没有编译器保护」之一。今天不是了：browser.run 进联合之后，
    // 下面的 `request.destination` 与 `request.url` 各报一处 TS2339——漏掉这个分支编译不过。
    if (request.operation === 'browser.restore') {
      const target = await api.browser.restoreResource(request.browserId, options?.admittedControlRequestId)
      requireActive()
      return { operation: request.operation, target }
    }
    if (request.operation === 'browser.targets') {
      const facts = await api.browser.listTargets(request.workspaceId)
      requireActive()
      return { operation: request.operation, ...facts }
    }
    if (request.operation === 'browser.run') {
      // 授权闸不在这层，在 Main 的 browser:runScript handler 里：那是所有调用方的必经之路，
      // 而这里只是今天唯一的一个调用方。放在这层的话，每多一个入口就要记得再写一遍同样的检查。
      // 操作者身份从真实 Session 解析（browserOperatorForSession），不在这里拼名字：
      // 原先写的是 `name: \`Agent ${agentSessionId}\``，于是轨迹上显示一串 UUID、头像退化成
      // 通用图标——而"是哪个 Agent 在动我的浏览器"正是这条轨迹要回答的唯一问题。
      const report = await api.browser.runScript(request.browserId, request.code, request.caller
        ? browserOperatorForSession(request.caller.agentSessionId, get().sessions)
        : undefined, request.operationId, request.caller ? { agentSessionId: request.caller.agentSessionId } : undefined)
      requireActive()
      return {
        operation: request.operation,
        result: report.result,
        logs: report.logs,
        outcome: report.outcome,
        runOperation: report.runOperation
      }
    }
    if (request.operation === 'browser.task.assets' || request.operation === 'browser.task.reliability' || request.operation === 'browser.task.run' || request.operation === 'browser.task.batch' || request.operation === 'browser.task.batch-stop' || request.operation === 'browser.task.stop') {
      requireActive()
      const result = await api.browser.controlTask(request)
      requireActive()
      return result
    }
    if (request.operation === 'browser.history') {
      requireActive()
      const operations = await api.browser.listOperationHistory()
      return {
        operation: request.operation,
        operations: request.browserId ? operations.filter((operation) => operation.browserId === request.browserId) : operations
      }
    }
    // browser.stop / browser.operation 这两条在这一层是**纯转发**，不在 Renderer 维护第二份状态机。
    //
    // 事实 owner 仍是 Main：取消走的是 `activeRun.stop`（那个 AbortController 只有 Main 持有），
    // 查询读的是 Main 的 journal。Renderer 这一层没有「哪个操作在跑」的第二份账——它连 operationId
    // 到 Browser 的映射都不知道，正是这个不知道保证了它不可能悄悄长出一份。
    //
    // 两条都不 `requireActive()`：这是刻意的，与上面几条不同。`requireActive` 是「这张 Tab 还在吗」
    // 的闸，而**取消和查询恰恰要在工作面已经不在的时候仍然可用**——一条连接断了、Tab 被关了之后，
    // 另一条连接拿着 id 来问「它怎么样了」是这两条存在的全部理由。在这里要求 Tab 还活着，等于把
    // 「operation 的寿命长于任何一条连接」这条约束在最后一米取消掉。
    if (request.operation === 'browser.stop') {
      return {
        operation: request.operation,
        runOperation: await api.browser.stopOperationById(request.operationId)
      }
    }
    if (request.operation === 'browser.operation') {
      return {
        operation: request.operation,
        runOperation: await api.browser.getOperation(request.operationId)
      }
    }
    // browser.subscribe 不走这一层。
    //
    // 它是整个联合里唯一一条**不经过 Renderer** 的操作：进度的事实 owner 是 Main 的 journal，
    // 而 Main 的 control server 直接把它接到了那里（ipc.ts 的 `subscribeBrowserOperation`）。
    // 所以这条路径上永远收不到它——能收到就说明有人把订阅改道成了走 Renderer，那会让订阅多一个
    // 会断的环节，且 Tab 一关订阅就跟着没了，正好取消掉「operation 的寿命长于任何一条连接」。
    //
    // 抛而不是静默：这里不 return 的话，它会一路落进下面开东西的那条尾巴，被当成 open.browser
    // 执行——**多开一个空白浏览器，而调用方等的是一条事件流**。这正是 browser.run 那条注释里
    // 记下的同一个坑；tsc 也在这里报了两处 TS2339（destination / caller 不存在），说明这个分支
    // 不是可选的。
    if (request.operation === 'browser.subscribe') {
      throw controlFailure('CONTROL_FAILED', 'Browser progress subscriptions are served by the Main Control owner, not the workbench.')
    }
    if (request.operation === 'browser.replay') {
      const plan = await api.browser.replayPlan(request.operationId)
      if (!plan) throw controlFailure('CONTROL_FAILED', 'Browser replay operation was not found.')
      const mode = request.mode ?? 'run'
      if (mode === 'preview') {
        return {
          operation: request.operation,
          mode: 'preview',
          plan
        }
      }
      let runPlan = plan
      if (mode === 'step') {
        if (!request.step || request.step < 1 || request.step > plan.steps.length) {
          throw controlFailure('INVALID_CONTROL_REQUEST', 'Browser replay step is outside the operation plan.')
        }
        const step = plan.steps[request.step - 1]
        if (!step) throw controlFailure('INVALID_CONTROL_REQUEST', 'Browser replay step is missing.')
        if (step.blockedReason) {
          throw controlFailure('CONTROL_FAILED', `Browser replay step requires review: ${step.blockedReason}`)
        }
        runPlan = { ...plan, steps: [step] }
      }
      const report = await api.browser.runReplay(request.browserId, runPlan, request.caller
        ? browserOperatorForSession(request.caller.agentSessionId, get().sessions)
        : undefined, request.caller ? { agentSessionId: request.caller.agentSessionId } : undefined)
      requireActive()
      return {
        operation: request.operation,
        mode: mode === 'step' ? 'step' : 'run',
        result: report.result,
        logs: report.logs,
        outcome: report.outcome,
        runOperation: report.runOperation
      }
    }

    const state = get()
    const plan = planControlOpen(
      input(),
      request.destination,
      request.caller,
      mintObjectId(),
      newRegionId(),
      request.operation
    )
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, plan.tabId)) {
      throw controlFailure('CONTROL_OWNER_LOST', 'Control target Tab is closing.')
    }
    const workspace = state.config?.workspaces.find((candidate) => candidate.id === plan.workspaceId)
    if (!workspace) throw controlFailure('UNKNOWN_WORKSPACE', 'Control target Workspace is not configured.')
    const rollback = (surface: WorkbenchSurface): void => {
      set((current) => {
        const restored = rollbackControlOpen({ tabs: current.tabs, layouts: current.layouts }, plan, surface)
        return restored ? { tabs: restored.tabs, layouts: restored.layouts } : current
      })
    }

    if (request.operation === 'open.terminal') {
      if (signal?.aborted) throw controlCancellation(signal)
      const pendingId = `terminal-launch:${mintObjectId()}`
      const pending: TerminalWorkbenchSurface = {
        regionId: plan.regionId, kind: 'terminal', phase: 'launching', workspaceId: workspace.id, sessionId: pendingId
      }
      plan.tabs[plan.tabId] = replaceWorkbenchRegion(plan.tabs[plan.tabId]!, plan.regionId, pending)
      set({ ...(plan.kind === 'launcher' ? {} : { activeWorkspaceId: workspace.id }),
        mainSurface: 'workbench', tabs: plan.tabs, layouts: plan.layouts })
      let session: SessionSnapshot | null = null
      try {
        const result = await api.sessions.launchTerminal({
          hostId: workspace.hostId,
          workspacePath: workspace.path,
          createOperationId: request.requestId,
          ...(request.shellCommand === undefined ? {} : { shellCommand: request.shellCommand })
        })
        if (result.kind !== 'terminal' || result.hostId !== workspace.hostId || result.workspacePath !== workspace.path) {
          throw controlFailure('LAUNCH_RESULT_MISMATCH', 'Terminal launch result does not match its request.')
        }
        session = result
        const owner = findWorkbenchRegion(get().tabs, plan.regionId)
        if (!ownsSessionLaunch(owner?.surface, 'terminal', pendingId) ||
          owner && !workbenchViewCloseAllowsView(get().closingWorkbenchViews, owner.tab.id)) {
          throw controlFailure('CONTROL_OWNER_LOST', 'Control Region owner disappeared during Terminal launch.')
        }
        const committed = session
        set((current) => {
          const currentOwner = findWorkbenchRegion(current.tabs, plan.regionId)
          if (
            !currentOwner ||
            currentOwner.surface.kind !== 'terminal' ||
            !ownsSessionLaunch(currentOwner.surface, 'terminal', pendingId)
          ) return current
          const tabs = {
            ...current.tabs,
            [currentOwner.tab.id]: replaceWorkbenchRegion(currentOwner.tab, plan.regionId, { ...currentOwner.surface, sessionId: committed.id })
          }
          return reduceSessionLaunchAttached({ ...current, tabs }, plan.regionId, committed)
        })
        if (signal?.aborted) throw controlCancellation(signal)
        // 与 agent 那条路共用同一处落点解析。此前这里返回 `plan.tabId`——上面的两道 owner 闸都只认
        // surface 身份，没有一道比较过 Tab id，于是启动期间这一格被 promote 走时，回执交回的是旧 Tab。
        const landing = resolveSpatialCommit(get().tabs, plan.regionId, { kind: 'terminal', sessionId: committed.id })
        if (landing.kind !== 'landed') {
          throw controlFailure('CONTROL_OWNER_LOST', 'Terminal launched successfully but its Region owner moved during launch.')
        }
        return {
          operation: request.operation,
          region: {
            tabId: landing.tabId, regionId: plan.regionId, workspaceId: workspace.id, kind: 'terminal',
            runId: session.control.run.runId
          }
        }
      } catch (error) {
        // Ending a reader or rejecting its target cannot stop an admitted Run.
        // Keep its confirmed Session without reviving a closed or replaced view.
        const confirmed = session
        if (confirmed) set(current => current.sessions.some(item => item.id === confirmed.id)
          ? current : { sessions: [...current.sessions, confirmed] })
        // Missing replies are unknown; only the creation owner can confirm non-application.
        else if (sessionLaunchFailure(error).controlFailure.disposition === 'not_applied') rollback(pending)
        throw error
      }
    }

    const browserId = mintObjectId()
    // Control places a Browser; explicit focus is a separate request. The human UI open path
    // keeps its own selection intent, while this path retains the current work and input owner.
    set({ tabs: plan.tabs, layouts: plan.layouts })
    const cancel = (): void => rollback(plan.launcher)
    signal?.addEventListener('abort', cancel, { once: true })
    let createdBrowserId: string | null = null
    const cleanup = async (primary: Error): Promise<never> => {
      if (createdBrowserId) {
        try { await api.browser.close(createdBrowserId) }
        catch (cleanupError) {
          throw controlFailure('LAUNCH_CLEANUP_FAILED', `${primary.message} Cleanup failed: ${presentError(cleanupError)}`, {
            cause: new AggregateError([primary, cleanupError])
          })
        }
      }
      throw primary
    }
    try {
      const browser = request.capsuleId === undefined
        ? await api.browser.create(browserId, request.url, workspace.id, undefined, request.mode)
        : await api.browser.create(browserId, request.url, workspace.id, undefined, request.mode, undefined, request.capsuleId, request.requestId)
      createdBrowserId = browser.id
      if (browser.id !== browserId) await cleanup(controlFailure('LAUNCH_RESULT_MISMATCH', 'Browser owner returned another Browser identity.'))
      if (signal?.aborted) await cleanup(controlCancellation(signal))
      const surface: BrowserWorkbenchSurface = {
        ...browser, regionId: plan.regionId, kind: 'browser', workspaceId: workspace.id, browserId
      }
      let attached = false
      set((current) => {
        const owner = findWorkbenchRegion(current.tabs, plan.regionId)
        if (
          !owner ||
          owner.tab.id !== plan.tabId ||
          owner.surface !== plan.launcher ||
          !workbenchViewCloseAllowsView(current.closingWorkbenchViews, owner.tab.id)
        ) return current
        attached = true
        return { tabs: { ...current.tabs, [owner.tab.id]: updateWorkbenchRegion(owner.tab, plan.regionId, () => surface) } }
      })
      if (!attached) await cleanup(controlFailure('CONTROL_OWNER_LOST', 'Control Region owner disappeared during Browser creation.'))
      return {
        operation: request.operation,
        region: { tabId: plan.tabId, regionId: plan.regionId, workspaceId: workspace.id, kind: 'browser', browserId, mode: browser.mode }
      }
    } catch (error) {
      rollback(plan.launcher)
      throw error
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  },
  selectSession(id, preferredTabGroupId) {
    if (!workbenchViewCloseAllowsSession(get().closingWorkbenchViews, id)) return false
    const current = get(), catalog = workbenchSelectionCatalog(current)
    const existing = Object.values(current.tabs).flatMap((tab) => (
      workbenchSurfaces(tab).flatMap((surface) => (
        isSessionSurface(surface) && surface.sessionId === id
          ? [{ tab, surface }]
          : []
      ))
    ))
    if (existing.length) {
      // A projection's durable placement owns navigation. Its Session's cwd owns execution,
      // and can differ after a spatial move; rebuilding this Tab from cwd would move its other
      // Regions too and leave the same Tab in two Workspace layouts. Recovery may also retain
      // this projection before a fresh Session snapshot arrives.
      const owners = new Set(existing.map(item => JSON.stringify([item.tab.id, item.surface.regionId])))
      let references = [...new Map(catalog.locations.filter(location => owners.has(JSON.stringify([location.tabId, location.regionId])))
        .map(location => [JSON.stringify([location.displayWorkspaceId, location.groupId, location.tabId, location.regionId]), location])).values()]
      // An explicit Space Group is the caller's navigation intent. Held Focus only
      // disambiguates inside that scope; it cannot erase a different requested Group.
      if (preferredTabGroupId) references = references.filter(reference => reference.groupId === preferredTabGroupId)
      const held = current.agentFocus.execution.sessionId === id ? current.agentFocus.execution.reference : undefined
      if (held && references.some(reference => reference.displayWorkspaceId === held.displayWorkspaceId && reference.groupId === held.groupId &&
        reference.tabId === held.tabId && reference.regionId === held.regionId)) references = references.filter(reference =>
          reference.displayWorkspaceId === held.displayWorkspaceId && reference.groupId === held.groupId && reference.tabId === held.tabId && reference.regionId === held.regionId)
      if (references.length !== 1) {
        current.reportError(new Error('The Session has no unique confirmed display occurrence. Its original workface and input are kept; choose its exact Tab, Group and Region.'), { kind: 'indeterminate' })
        return false
      }
      const reference = references[0]!
      let choice: AgentMuxDesktopSpaceSelection
      try { choice = resolveWorkbenchOccurrenceSelection(current, catalog, { workspaceId: reference.displayWorkspaceId,
        groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId }, 'navigation') }
      catch (error) { current.reportError(error, { kind: 'indeterminate' }); return false }
      set((state) => ({
        activeWorkspaceId: reference.displayWorkspaceId, workbenchSpaceSelection: choice,
        retainedSpatialFocus: null, workbenchNavigationInputPolicy: null, regionCaretFocus: null,
        mainSurface: 'workbench',
        displacedAgentSessionIds: state.displacedAgentSessionIds.filter((sessionId) => sessionId !== id)
      }))
      get().focusRegion(reference.displayWorkspaceId, reference.tabId, reference.regionId, 'pointer', reference.groupId)
      return true
    }
    const session = get().sessions.find((candidate) => candidate.id === id)
    const workspace = session ? workspaceForSession(get().config, session, scratchTopicsForConfig(get().config, get().scratchTopicSnapshots)) : null
    if (!session || !workspace) return false
    const { tabId, regionId } = availableWorkbenchTabIdentity(current.tabs, incarnation => sessionTabId(id, incarnation))
    const layout = get().layouts[workspace.id] ?? createWorkspaceLayout(newTabGroupId())
    const existingTabGroupId = tabGroupForTab(layout, tabId)
    const targetTabGroupId = existingTabGroupId ?? preferredTabGroupId ?? layout.activeGroupId
    const surface: AgentWorkbenchSurface | TerminalWorkbenchSurface = {
      regionId,
      kind: session.kind,
      phase: 'attached',
      workspaceId: workspace.id,
      sessionId: id
    }
    const createdTab = createWorkbenchTab(tabId, surface)
    const sessionTopicId = scratchTopicIdFromWorkspacePath(workspace.path, session.workspacePath, scratchTopicsForConfig(get().config, get().scratchTopicSnapshots))
    const tab = sessionTopicId ? { ...createdTab, topicId: sessionTopicId } : createdTab
    // Tab 已在某个分组里就只需激活；新建时必须真的挂上。挂不上（`preferredTabGroupId` 指向一个
    // 已不存在的分组）原先静默回落成原 layout：Tab 记录进了 state.tabs 而不在任何 tabOrder 里。
    // 这里刻意不「退回 activeGroupId」——请求的分组不在场时换一个窗口安放，正是 #307 那个
    // 「浮层里开到背后主界面」的形态。selectSession 通过同步结果表达是否完成选择，抛出只会变成事件处理里的
    // 未捕获异常，所以走 reportError 把失败摆到界面上。
    const nextLayout = existingTabGroupId
      ? activateLayoutTab(layout, targetTabGroupId, tabId)
      : addTabPlacement(layout, targetTabGroupId, tabId)
    if (!nextLayout) {
      get().reportError(new Error('The Tab Group is no longer available'), { kind: 'indeterminate', subject: session.control,
        event: { source: 'spatial', key: mintObjectId(), object: { kind: 'tab-group', id: targetTabGroupId, workspaceId: workspace.id } } })
      return false
    }
    const next = { ...get(), tabs: { ...get().tabs, [tab.id]: tab }, layouts: { ...get().layouts, [workspace.id]: nextLayout } }
    let choice: AgentMuxDesktopSpaceSelection
    try { choice = resolveWorkbenchOccurrenceSelection(next, workbenchSelectionCatalog(next),
      { workspaceId: workspace.id, groupId: targetTabGroupId, tabId: tab.id, regionId }, 'navigation') }
    catch (error) { get().reportError(error, { kind: 'indeterminate' }); return false }
    set((state) => ({
      activeWorkspaceId: workspace.id,
      mainSurface: 'workbench',
      regionCaretFocus: null, workbenchSpaceSelection: choice, workbenchNavigationInputPolicy: null, retainedSpatialFocus: null,
      agentFocus: focusSessionContext(state, id),
      tabs: { ...state.tabs, [tab.id]: tab },
      layouts: { ...state.layouts, [workspace.id]: nextLayout },
      // Placement succeeded in this same commit; a later intentional close is not this old failure.
      displacedAgentSessionIds: state.displacedAgentSessionIds.filter((sessionId) => sessionId !== id)
    }))
    return true
  },
  prepareWorkbenchLayout(workspaceId) {
    const state = get(), layout = state.layouts[workspaceId]
    if (layout) return layout
    if (!state.config?.workspaces.some(workspace => workspace.id === workspaceId)) throw new Error('The exact file resource is unavailable. Its original workface is kept; reconnect it before preparing a display.')
    const created = createWorkspaceLayout(newTabGroupId())
    set(current => ({ layouts: { ...current.layouts, [workspaceId]: current.layouts[workspaceId] ?? created } }))
    return get().layouts[workspaceId]!
  },
  createWorkbenchZone(input) {
    return createSpatialZone({ get, patch: patch => set(patch),
      topics: async () => get().config?.workspaces.some(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
        ? await api.scratch.listTopics(SCRATCH_WORKSPACE_ID) : [],
      save: saveWorkbenchSelection,
      notice: notice => get().reportError(new Error(`${notice.message} ${notice.recovery}`)) }, input)
  },
  async setZoneSpaceRelation(zoneId, spaceId, linked) {
    const result = await get().executeControl({ schemaVersion: 5, requestId: `binding:${mintObjectId()}`,
      operation: linked ? 'space.bind' : 'space.unbind', binding: { kind: 'zone-space', zoneId, spaceId } })
    if (result.operation !== 'space.bind' && result.operation !== 'space.unbind') throw new Error('The binding owner returned a different operation.')
    return result
  },
  async setTabDisplayPlacement(tabId, displayWorkspaceId, groupId, present) {
    const result = await get().executeControl({ schemaVersion: 5, requestId: `binding:${mintObjectId()}`,
      operation: present ? 'space.bind' : 'space.unbind', binding: { kind: 'tab-group', tabId, displayWorkspaceId, groupId } })
    if (result.operation !== 'space.bind' && result.operation !== 'space.unbind') throw new Error('The binding owner returned a different operation.')
    return result
  },
  openLauncher({ workspaceId, displayWorkspaceId, tabGroupId, topicId: requestedTopicId, zoneId, reveal, initialInputs }) {
    const state = get()
    const displayId = displayWorkspaceId ?? workspaceId
    const layout = state.layouts[displayId]
    if (!layout) {
      get().reportError(new Error('The Workspace layout is still restoring'), { kind: 'indeterminate',
        event: { source: 'spatial', key: mintObjectId(), object: { kind: 'workspace', id: displayId } } })
      return
    }
    const targetTabGroupId = tabGroupId ?? layout.activeGroupId
    if (!groupIds(layout.root).includes(targetTabGroupId) || !findGroup(layout, targetTabGroupId)) {
      get().reportError(new Error('The exact display Tab Group is no longer available'), { kind: 'indeterminate',
        event: { source: 'spatial', key: mintObjectId(), object: { kind: 'tab-group', id: targetTabGroupId, workspaceId: displayId } } })
      return
    }
    let space: WorkbenchTab['space']
    let topicId: string | undefined
    if (zoneId) {
      const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID) ?? null) ?? []
      const catalog = spatialCatalog(state, topics)
      const zone = catalog.zones.find(zone => zone.zoneId === zoneId)
      if (!zone || zone.workspaceId !== workspaceId || zone.kind === 'unknown') {
        get().reportError(new Error('The exact Zone resource context is unavailable. Its original reference is retained.'), { kind: 'indeterminate',
          event: { source: 'spatial', key: mintObjectId(), object: { kind: 'zone', id: zoneId, workspaceId } } })
        return
      }
      try {
        const spaceId = zoneContext(state, topics, zone)
        space = { zoneId, spaceId }
        // Topic home is a resource context. A temporary Zone linked to that Topic still uses its
        // original Workspace root and never inherits the active Group's unrelated Topic.
        // Category is the display Space; Topic identity remains on its original Zone.
        // It must not be inferred from a Category's title or a suppressed content Space.
        const originalTopics = zone.kind === 'home' ? topics.filter(topic =>
          topicSpatialAddress(state.config, topic, state.spaceZoneBindings, state.topicCategories)?.zoneId === zoneId) : []
        topicId = originalTopics.length === 1 ? originalTopics[0]!.id
          : zone.kind === 'home' ? state.spaceZoneBindings[zoneId]?.topicId ?? catalog.spaces.find(item => item.spaceId === spaceId)?.topicId : undefined
      } catch (error) { get().reportError(error); return }
    } else {
      topicId = isScratchWorkspaceId(workspaceId)
        ? requestedTopicId ?? inheritedTopicIdForNewTab(workspaceId, layout, state.tabs, targetTabGroupId)
        : undefined
    }
    const created = newLauncherTab(workspaceId, topicId)
    const tab = space ? { ...created, space } : created
    // Placement failure is visible without leaving an orphan View or throwing from a UI handler.
    const nextLayout = addTabPlacement(layout, targetTabGroupId, tab.id)
    if (!nextLayout) {
      get().reportError(new Error('The Tab Group is no longer available'), { kind: 'indeterminate',
        event: { source: 'spatial', key: mintObjectId(), object: { kind: 'tab-group', id: targetTabGroupId, workspaceId: displayId } } })
      return
    }
    let selectedObject = state.workbenchSpaceSelection
    if (reveal) {
      const next = { ...state, tabs: { ...state.tabs, [tab.id]: tab }, layouts: { ...state.layouts, [displayId]: nextLayout } }
      try { selectedObject = resolveWorkbenchOccurrenceSelection(next, workbenchSelectionCatalog(next),
        { workspaceId: displayId, groupId: targetTabGroupId, tabId: tab.id }, 'navigation') }
      catch (error) { state.reportError(error, { kind: 'indeterminate' }); return }
    }
    if (initialInputs) useLauncherState.getState().copyUtilityDraft(
      initialInputs.sourceLauncherId ?? warmLauncherId({ tabGroupId: targetTabGroupId, regionId: undefined }),
      warmLauncherId({ tabGroupId: targetTabGroupId, regionId: tab.layout.activeRegionId }))
    set((state) => ({
      // Only a successful explicit main-surface navigation changes global selection.
      ...(reveal ? { activeWorkspaceId: displayId, mainSurface: 'workbench' as const, regionCaretFocus: null,
        workbenchSpaceSelection: selectedObject, workbenchNavigationInputPolicy: null, retainedSpatialFocus: null } : {}),
      tabs: { ...state.tabs, [tab.id]: tab },
      ...(initialInputs ? {
        agentComposerDrafts: { ...state.agentComposerDrafts, [tab.layout.activeRegionId]: initialInputs.prompt },
        launcherNameDrafts: { ...state.launcherNameDrafts, [tab.layout.activeRegionId]: initialInputs.names },
        launcherOptionDrafts: { ...state.launcherOptionDrafts, [tab.layout.activeRegionId]: initialInputs.optionsByProvider }
      } : {}),
      layouts: { ...state.layouts, [displayId]: reveal || initialInputs ? nextLayout : {
        ...nextLayout,
        activeGroupId: layout.activeGroupId,
        groups: nextLayout.groups.map(group => {
          const original = layout.groups.find(candidate => candidate.id === group.id)
          return original ? { ...group, activeTabId: original.activeTabId, recentTabIds: original.recentTabIds } : group
        })
      } }
    }))
    // Publish the durable Region owner before releasing only its unchanged Group inputs.
    // Utility drafts and Note receipts retain the original Group record.
    if (initialInputs) useLauncherState.getState().clearAgentInputsIfUnchanged(
      initialInputs.sourceLauncherId ?? warmLauncherId({ tabGroupId: targetTabGroupId, regionId: undefined }), initialInputs)
    return tab.id
  },
  closeTab(workspaceId, tabGroupId, tabId, options) {
    const state = get()
    const errorBeforeClose = state.error
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, tabId)) {
      return Promise.resolve(false)
    }
    const plan = planWorkbenchViewClose({
      tabs: state.tabs,
      layouts: state.layouts,
      sessions: state.sessions,
      workspaceId,
      tabGroupId,
      tabId,
      keepAgentSessions: options?.keepAgentSessions === true,
      closingViewIds: new Set(Object.keys(state.closingWorkbenchViews))
    })
    if (!plan) return Promise.resolve(true)
    // Publish only the exact View deletion committed here, independently of cleanup receipts.
    const commitClose = (tab: WorkbenchTab | null): void => {
      let removedTab: WorkbenchTab | undefined
      let removedTabOrder: readonly string[] = []
      let collectionChanged = false
      set((current) => {
        const topology = applyWorkbenchViewCloseTopology(current, plan, tab)
        const committed = { ...reconcileWorkbenchFileProjection(current, topology),
          ...surveyPresentationAfterClose(current, topology.tabs),
          workbenchSpaceSelection: desktopSpaceSelectionAfterClose(current.workbenchSpaceSelection, topology,
            { workspaceId, tabId, groupId: tabGroupId }) }
        removedTab = current.tabs[tabId] && !committed.tabs[tabId] ? current.tabs[tabId] : undefined
        removedTabOrder = current.layouts[workspaceId]?.groups.find(group => group.id === tabGroupId)?.tabOrder ?? []
        collectionChanged = committed.surveyCollectedZones !== current.surveyCollectedZones
        recordClosedWorkbenchEntities(current.tabs, committed.tabs)
        const removedTabId = removedTab?.id
        if (!removedTabId) return committed
        // Only this admitted, committed close releases a Goal's dedicated discussion binding.
        // A missing projection elsewhere remains unknown and never authorizes replacement.
        const discussionClosed = Object.values(current.demandPmoTabIds).includes(removedTabId)
        if (discussionClosed) collectionChanged = true
        return { ...committed,
          ...(discussionClosed ? { demandPmoTabIds: Object.fromEntries(Object.entries(current.demandPmoTabIds).filter(([, id]) => id !== removedTabId)) } : {}),
          recentMoteAgents: Object.fromEntries(Object.entries(current.recentMoteAgents).filter(([, agent]) => agent.tabId !== removedTabId)) }
      })
      if (removedTab && !get().tabs[removedTab.id]) publishWorkbenchTabRemoved(removedTab, { displayWorkspaceId: workspaceId, groupId: tabGroupId, tabOrder: removedTabOrder }, error => get().reportError(error))
      if (collectionChanged) void saveWorkbenchSelection(false)
    }
    if (!plan.closesView) {
      commitClose(null)
      pruneEditorRegionState(get().tabs)
      return Promise.resolve(true)
    }
    if (plan.resources.length === 0) {
      const reconciliation = reconcileWorkbenchViewClose({
        plan,
        currentTab: state.tabs[tabId],
        currentSessions: state.sessions,
        receipts: []
      })
      const previousTabs = state.tabs
      commitClose(reconciliation.tab)
      pruneEditorRegionState(get().tabs)
      return disposeClosedFileOwners(previousTabs, get().tabs).then(
        () => true,
        (error) => {
          get().reportError(error)
          return false
        }
      )
    }
    set((current) => ({
      closingWorkbenchViews: {
        ...current.closingWorkbenchViews,
        [tabId]: plan
      }
    }))
    return (async () => {
      try {
        const [browserReceipts, sessionReceipts] = await Promise.all([
          settleWorkbenchViewCloseResources(
            plan.resources.filter((resource) => resource.kind === 'browser'),
            async (resource) => await api.browser.close(resource.browserId)
          ),
          settleWorkbenchViewCloseResources(
            plan.resources.filter((resource) => resource.kind === 'session'),
            async (resource) => {
              const current = get()
              if (!current.sessions.some((session) => (
                session.id === resource.sessionId && sessionOwnsControl(session, resource.control)
              ))) return
              if (hasAttachedSessionOutsideClosingViews({
                tabs: current.tabs,
                plans: current.closingWorkbenchViews,
                sessionId: resource.sessionId
              })) {
                throw new Error(`Session gained another View while closing: ${resource.sessionId}`)
              }
              await api.sessions.stop(resource.control)
            }
          )
        ])
        const reconciliation = reconcileWorkbenchViewClose({
          plan,
          currentTab: get().tabs[tabId],
          currentSessions: get().sessions,
          receipts: [...browserReceipts, ...sessionReceipts]
        })
        const previousTabs = get().tabs
        commitClose(reconciliation.tab)
        await disposeClosedFileOwners(previousTabs, get().tabs)
        pruneEditorRegionState(get().tabs)
        if (reconciliation.failures.length > 0) {
          get().reportError(workbenchViewCloseFailure(reconciliation.failures))
        } else if (reconciliation.changedWhileClosing) {
          if (get().error === errorBeforeClose) {
            get().reportError(new Error('The View changed while it was closing. Review it and close it again.'))
          }
        }
        return reconciliation.failures.length === 0 && !reconciliation.changedWhileClosing
      } catch (error) {
        get().reportError(error)
        return false
      } finally {
        set((current) => {
          if (current.closingWorkbenchViews[tabId] !== plan) return current
          const closingWorkbenchViews = { ...current.closingWorkbenchViews }
          delete closingWorkbenchViews[tabId]
          return { closingWorkbenchViews }
        })
      }
    })()
  },
  moveTab(workspaceId, tabId, sourcePaneId, targetPaneId, visibleTargetIndex) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    const layout = current.layouts[workspaceId]
    if (!layout) return
    const projected = workbenchObjectLayout(current, workspaceId).layout
    const visibleGroup = projected?.groups.find(group => group.id === targetPaneId)
    const storedGroup = layout.groups.find(group => group.id === targetPaneId)
    if (!visibleGroup || !storedGroup) { current.reportError(new Error('The selected object Group is unconfirmed. Original Tabs are kept.'), { kind: 'indeterminate',
      event: { source: 'spatial', key: mintObjectId(), object: { kind: 'tab-group', id: targetPaneId, workspaceId } } }); return }
    const anchor = visibleGroup.tabOrder[visibleTargetIndex]
    const storedIndex = anchor ? storedGroup.tabOrder.indexOf(anchor) : storedGroup.tabOrder.length
    set((state) => ({
      layouts: {
        ...state.layouts,
        [workspaceId]: moveLayoutTab(layout, tabId, sourcePaneId, targetPaneId, storedIndex)
      }
    }))
  },
  moveTabToNewGroup(workspaceId, tabId, sourcePaneId, targetPaneId, direction) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    const layout = current.layouts[workspaceId]
    if (!layout) return
    set((state) => ({
      layouts: {
        ...state.layouts,
        [workspaceId]: moveLayoutTabToNewGroup(
          layout,
          tabId,
          sourcePaneId,
          targetPaneId,
          direction,
          newTabGroupId()
        )
      }
    }))
  },
  focusRegion(workspaceId, tabId, regionId, cause = 'pointer', exactGroupId) {
    const tab = get().tabs[tabId]
    const layout = get().layouts[workspaceId]
    const candidates = layout?.groups.filter(group => group.tabOrder.includes(tabId)) ?? []
    const tabGroupId = exactGroupId && candidates.some(group => group.id === exactGroupId) ? exactGroupId
      : !exactGroupId && candidates.some(group => group.id === layout?.activeGroupId) ? layout!.activeGroupId
      : !exactGroupId && candidates.length === 1 ? candidates[0]!.id : null
    if (!tab || !tabGroupId || !tab.regions[regionId]) return
    const surface = tab.regions[regionId]
    const focusedSessionId = isSessionSurface(surface) ? surface.sessionId : null
    const recentMoteAgents = recentMoteAgentsAfterVisit(get(), { displayWorkspaceId: workspaceId, groupId: tabGroupId, tabId, regionId })
    if (cause === 'floating-pointer') {
      // The borrowed View owns its local Region, native input and semantic lane. A click inside it
      // does not navigate the main workbench or authorize another Zone's launcher.
      set((state) => {
        const local = focusedSessionId ? focusSessionContext(state, focusedSessionId, undefined,
          { displayWorkspaceId: workspaceId, groupId: tabGroupId, tabId, regionId }) : state.agentFocus
        return { regionCaretFocus: null, recentMoteAgents, ...(local !== state.agentFocus ? { agentFocus: local } : {}) }
      })
      return
    }
    let choice: AgentMuxDesktopSpaceSelection
    try { choice = resolveWorkbenchOccurrenceSelection(get(), workbenchSelectionCatalog(get()),
      { workspaceId, groupId: tabGroupId, tabId, regionId }, cause === 'navigation' ? 'navigation' : 'local') }
    catch (error) { get().reportError(error, { kind: 'indeterminate' }); return }
    set((state) => ({
      workbenchSpaceSelection: choice, activeWorkspaceId: choice.workspaceId, workbenchNavigationInputPolicy: null, retainedSpatialFocus: null,
      recentMoteAgents,
      tabs: { ...state.tabs, [tabId]: focusWorkbenchTabRegion(tab, regionId) },
      layouts: {
        ...state.layouts,
        [workspaceId]: activateLayoutTab(layout!, tabGroupId, tabId)
      },
      // 键盘导航与外部显式打开目标才搬 DOM caret（regionFocusClaimsCaret）。判据是这次落焦的**因**，不是
      // 「谁成了焦点」——指针点击那一路原生 mousedown 已把焦点放对，再夺一次会打断选择/原生行为。同一个
      // regionId 驱动绿环、原生视图让位、与这条 caret 意图，三者读同一次判定（region-focus.ts 顶部的纪律）。
      // nonce 递增让「连按方向键停在同一格」也能各触发一次，且 selector 不因对象相等忽略它。
      ...(regionFocusClaimsCaret(cause)
        ? { regionCaretFocus: { regionId, nonce: ++regionCaretFocusNonce } }
        : { regionCaretFocus: null }),
      ...(focusedSessionId ? { agentFocus: focusSessionContext(state, focusedSessionId, undefined,
        { displayWorkspaceId: workspaceId, groupId: tabGroupId, tabId, regionId }) } : {})
    }))
  },
  requestRegionCaretFocus(regionId) {
    set({ regionCaretFocus: { regionId, nonce: ++regionCaretFocusNonce, target: 'terminal' } })
  },
  clearRegionCaretFocus(nonce) {
    // 只清掉自己消费的那一条：若清的瞬间已被更晚一次导航覆盖成新 nonce，别把新意图也抹掉。
    set((state) => (state.regionCaretFocus?.nonce === nonce ? { regionCaretFocus: null } : state))
  },
  moveSessionViewToWorkspace(regionId, targetWorkspaceId) {
    const state = get()
    const owner = findWorkbenchRegion(state.tabs, regionId)
    if (!owner) return
    const surface = owner.surface
    // Only a Session projection can be moved; a file/launcher/browser Region has no cwd to protect
    // and no Session identity to relocate. `isSessionSurface` is that membership test's one home, so a
    // sixth session-bearing kind is declared there rather than being silently excluded here.
    if (!isSessionSurface(surface)) return
    // A closing source View must not be half-moved out from under its own teardown. Surface the
    // refusal on the existing error banner rather than mutating the layout.
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, owner.tab.id)) {
      get().reportError(new Error('The View is closing'))
      return
    }
    const result = reduceMoveSessionView({
      tabs: state.tabs,
      layouts: state.layouts,
      regionId,
      sessionId: surface.sessionId,
      targetWorkspaceId,
      workspaceIds: (state.config?.workspaces ?? []).map((workspace) => workspace.id),
      mint: { tabId: mintObjectId(), tabGroupId: newTabGroupId(), regionId: newRegionId() }
    })
    if (result.kind !== 'moved') return
    // One atomic layout replacement, then navigate with the same focus path selectSession uses —
    // no second navigation route, no fabricated cwd.
    set({
      retainedSpatialFocus: null,
      activeWorkspaceId: result.target.workspaceId,
      mainSurface: 'workbench',
      tabs: result.tabs,
      layouts: result.layouts
    })
    get().focusRegion(result.target.workspaceId, result.target.tabId, result.target.regionId)
  },
  splitRegion(workspaceId, tabId, regionId, direction, initialRequest) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    const tab = current.tabs[tabId]
    if (!tab || tab.workspaceId !== workspaceId || !tab.regions[regionId]) return
    const addedRegionId = newRegionId()
    const launcher: LauncherWorkbenchSurface = {
      regionId: addedRegionId,
      kind: 'launcher',
      workspaceId
    }
    const nextTab = addWorkbenchRegion(tab, regionId, direction, launcher)
    if (nextTab === tab) return
    set((state) => ({ tabs: { ...state.tabs, [tabId]: nextTab }, ...(initialRequest ? {
      agentComposerDrafts: { ...state.agentComposerDrafts, [addedRegionId]: initialRequest.prompt },
      ...(initialRequest.agentMuxNote === undefined ? {} : { agentComposerNotes: { ...state.agentComposerNotes, [addedRegionId]: initialRequest.agentMuxNote } })
    } : {}) }))
    return addedRegionId
  },
  arrangeTabRegions(workspaceId, tabId, mode) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    const tab = current.tabs[tabId]
    if (!tab || tab.workspaceId !== workspaceId) return
    // 与控制协议的 `arrange` 分支共用同一个引擎，且**不重算**「要补几个格」——那次推导住在
    // arrangeWorkbenchControlTab 里，这里连数都数不着。两侧各算一遍必漂移，症状是同一个预设
    // 从菜单点没反应、从命令行却好用（见那个函数的注释）。三档重排（预设 / 均分 / 当前格优先）
    // 也是同一个理由走同一条路：本方法不认 mode 的档，原样转交。
    let arranged: WorkbenchTab
    try {
      arranged = arrangeWorkbenchControlTab(tab, mode, newRegionId)
    } catch (error) {
      // 引擎的拒绝是有话要说的（格数超了、id 撞了），不能咽掉——菜单里点了没反应就是最难查的那种。
      get().reportError(error)
      return
    }
    if (arranged === tab) return
    set((state) => ({ tabs: { ...state.tabs, [tabId]: arranged } }))
  },
  swapRegions(workspaceId, tabId, regionIdA, regionIdB) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    const tab = current.tabs[tabId]
    if (!tab || tab.workspaceId !== workspaceId) return
    // 换位的合法性（两个端点都在场、不与自己换）由 swapWorkbenchTabRegions → swapWorkbenchRegions
    // 自己守；挂不上时原样返回，这里据 `===` 判定不写回，避免无谓的重渲染。
    const nextTab = swapWorkbenchTabRegions(tab, regionIdA, regionIdB)
    if (nextTab === tab) return
    set((state) => ({ tabs: { ...state.tabs, [tabId]: nextTab } }))
  },
  promoteRegionToTab(workspaceId, tabId, regionId) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    // 合法性（Tab 归属、格在场、只剩一格是 no-op）全由 reducePromoteRegionToTab 自己守；促升不成立时
    // 交回 'unchanged'，这里据此不写回，避免无谓的重渲染。regionId 原样带去新 Tab（不新铸），故 browser
    // /editor/terminal 的按 regionId 索引的内容不用回收，不像 closeRegion 要 pruneEditorRegionState。
    const result = reducePromoteRegionToTab({
      tabs: current.tabs,
      layouts: current.layouts,
      workspaceId,
      tabId,
      regionId,
      mint: { tabId: mintObjectId() }
    })
    if (result.kind !== 'promoted') return
    // One atomic state replacement. The reducer's layout already made the new Tab the active Tab of its
    // group and focused that group, and the new Tab's sole Region is its active Region by construction —
    // so there is no second focus/navigation route to run (that would be a place for the two to drift).
    // What the reducer cannot know is the app-shell framing: bring the promoted Region's workspace and the
    // workbench surface forward so the new Tab is actually on screen — the user asked for this Region to
    // become its own Tab, so they want to see it. (mainSurface/activeWorkspaceId are normally already
    // these values, since the Region was right-clicked in the visible workbench, but setting them makes
    // "show the new Tab" true regardless of how the action was reached — e.g. a future command palette.)
    set((state) => ({
      ...(state.mainSurface === 'survey' || state.mainSurface === 'recall' ? {} : { retainedSpatialFocus: null,
        activeWorkspaceId: result.target.workspaceId, mainSurface: 'workbench' as const }),
      surveyZoneSelection: surveySelectionAfterPromote(state.surveyZoneSelection, { workspaceId, tabId, regionId }, result.target),
      recallZoneSelection: surveySelectionAfterPromote(state.recallZoneSelection, { workspaceId, tabId, regionId }, result.target),
      tabs: result.tabs,
      layouts: result.layouts
    }))
  },
  async closeRegion(workspaceId, tabId, regionId) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    const tab = current.tabs[tabId]
    const surface = tab?.regions[regionId]
    if (!tab || tab.workspaceId !== workspaceId || !surface) return
    if (!removeWorkbenchRegion(tab, regionId)) return
    // What this surface owns outside the tree is decided once, exhaustively (workbench-surface-kinds).
    // Asking `kind === 'browser'` / `kind === 'file'` here instead would let a sixth resource-bearing
    // kind answer "nothing to release" and leak with no compile error.
    const obligations = surfaceCloseObligations(surface)
    if (obligations.browserViewId !== null) {
      try {
        await api.browser.close(obligations.browserViewId)
      } catch (error) {
        get().reportError(error)
        return
      }
    }
    const previousTabs = get().tabs
    set((state) => {
      const liveTab = state.tabs[tabId]
      if (!liveTab || !sameWorkbenchSurfaceOwner(liveTab.regions[regionId], surface)) return state
      const nextTab = removeWorkbenchRegion(liveTab, regionId)
      if (!nextTab) return state
      coreSpatialPersistence?.removeEntity(regionId)
      const tabs = { ...state.tabs, [tabId]: nextTab }
      return { ...(obligations.releasesDocument
        ? reconcileWorkbenchFileProjection(state, { tabs, layouts: state.layouts })
        : { tabs }),
        ...surveyPresentationAfterClose(state, tabs),
        workbenchSpaceSelection: desktopSpaceSelectionAfterClose(state.workbenchSpaceSelection, { tabs, layouts: state.layouts },
          { workspaceId, tabId, regionId }) }
    })
    pruneEditorRegionState(get().tabs)
    if (obligations.releasesDocument) await disposeClosedFileOwners(previousTabs, get().tabs)
  },
  requestCloseTab(workspaceId, tabGroupId, tabId) {
    // 只投意图，不在这里关：真正的关闭要经组件的 requestTabsClose（未保存/在跑 Agent 的确认对话框只活在
    // 组件里）。nonce 让「连按两次 Cmd+W 关同一张 Tab」也能各触发一次——同一 tabId 重复投递不会因对象
    // 相等而被 selector 忽略。
    set((state) => ({
      closeTabRequest: { workspaceId, tabGroupId, tabId, nonce: (state.closeTabRequest?.nonce ?? 0) + 1 }
    }))
  },
  clearCloseTabRequest(nonce) {
    // 只清掉自己消费的那一条：若清的瞬间已被更晚一次按键覆盖成新 nonce，别把新意图也抹掉。
    set((state) => (state.closeTabRequest?.nonce === nonce ? { closeTabRequest: null } : state))
  },
  requestCloseRegion(workspaceId, tabId, regionId) {
    // 只投意图，不在这里关：真正的关闭（含未保存确认）在承载该格的组件里，与鼠标点这一格的 X 同一条路。
    // nonce 让「连按两次 Cmd+W 关同一格」也能各触发一次——同一 regionId 重复投递不会因对象相等被 selector 忽略。
    set((state) => ({
      closeRegionRequest: {
        workspaceId,
        tabId,
        regionId,
        nonce: (state.closeRegionRequest?.nonce ?? 0) + 1
      }
    }))
  },
  clearCloseRegionRequest(nonce) {
    // 只清掉自己消费的那一条：若清的瞬间已被更晚一次按键覆盖成新 nonce，别把新意图也抹掉。
    set((state) => (state.closeRegionRequest?.nonce === nonce ? { closeRegionRequest: null } : state))
  },
  updateRegionSplitRatio(workspaceId, tabId, nodePath, ratio) {
    const tab = get().tabs[tabId]
    if (!tab || tab.workspaceId !== workspaceId) return
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...tab,
          layout: setWorkbenchRegionSplitRatio(tab.layout, nodePath, ratio)
        }
      }
    }))
  },
  updateSplitRatio(workspaceId, nodePath, ratio) {
    const layout = get().layouts[workspaceId]
    if (!layout) return
    set((state) => ({
      layouts: {
        ...state.layouts,
        [workspaceId]: setSplitRatio(layout, nodePath, ratio)
      }
    }))
  },
  setViewMode(sessionId, mode, options) {
    set((state) => ({
      viewModes: { ...state.viewModes, [sessionId]: mode },
      ...(options?.focus === false ? {} : { agentFocus: focusSessionContext(state, sessionId) })
    }))
  },
  toggleEditorWordWrap() {
    set((state) => ({ editorWordWrap: !state.editorWordWrap }))
  },
  toggleEditorMinimap() {
    set((state) => ({ editorMinimap: !state.editorMinimap }))
  },
  toggleExplorerShowHidden() {
    set((state) => ({ explorerShowHidden: !state.explorerShowHidden }))
  },
  toggleExplorerShowIgnored() {
    set((state) => ({ explorerShowIgnored: !state.explorerShowIgnored }))
  },
  async setEditorRegionMode(regionId, workspaceId, path, mode) {
    set((state) => ({ editorRegionModes: { ...state.editorRegionModes, [regionId]: mode } }))
    // Only entering diff triggers a load, and only when this Region has no diff yet — switching back
    // and forth must not refetch. An explicit refresh goes through reloadRegionDiff.
    if (mode === 'diff' && !Object.hasOwn(get().editorRegionDiffs, regionId)) {
      await loadRegionDiff(regionId, (bridge) => bridge.diff(workspaceId, path))
    }
  },
  async reloadRegionDiff(regionId, workspaceId, path) {
    await loadRegionDiff(regionId, (bridge) => bridge.diff(workspaceId, path))
  },
  async openFileAndReveal(path, tabGroupId, location, requestedWorkspaceId, navigationSignal) {
    const navigation = get()
    const workspaceId = requestedWorkspaceId ?? navigation.activeWorkspaceId
    const resource = navigation.config?.workspaces.find(workspace => workspace.id === workspaceId)
    if (!workspaceId || !resource) return false
    if (!navigation.layouts[workspaceId]) set(state => ({ layouts: {
      ...state.layouts, [workspaceId]: createWorkspaceLayout(newTabGroupId())
    } }))
    const opening = navigationSignal
      ? get().openFile(path, tabGroupId, location, workspaceId, undefined, undefined, navigationSignal)
      : get().openFile(path, tabGroupId, location, workspaceId)
    const intentVersion = fileOpenIntentVersion
    const mayReveal = await opening
    const state = get(), currentResource = state.config?.workspaces.find(workspace => workspace.id === workspaceId)
    // Preparation may finish after a newer navigation or a Workspace resource rebind.
    if (!mayReveal || navigationSignal?.aborted || intentVersion !== fileOpenIntentVersion ||
      state.mainSurface !== navigation.mainSurface || state.activeWorkspaceId !== navigation.activeWorkspaceId ||
      state.agentFocus.execution.sessionId !== navigation.agentFocus.execution.sessionId ||
      state.agentFocus.pmo.sessionId !== navigation.agentFocus.pmo.sessionId ||
      currentResource?.hostId !== resource.hostId || currentResource.path !== resource.path) return false
    const original = findFileWorkbenchSurface(state, workspaceId, path), layout = state.layouts[workspaceId]
    const tab = original?.tab, surface = original?.surface
    const groupId = tab && tabGroupForTab(layout, tab.id)
    if (!tab || !surface || !groupId) return false
    get().focusRegion(workspaceId, tab.id, surface.regionId, 'navigation', groupId)
    const selected = get().workbenchSpaceSelection
    if (selected?.workspaceId !== workspaceId || selected.tabId !== tab.id || selected.regionId !== surface.regionId || selected.groupId !== groupId) return false
    set({ activeWorkspaceId: workspaceId, mainSurface: 'workbench' })
    const request = get().regionCaretFocus
    if (request && navigationSignal) navigationSignal.addEventListener('abort', () => get().clearRegionCaretFocus(request.nonce), { once: true })
    return true
  },
  async openFileDiff(path, requestedWorkspaceId) {
    const navigation = get()
    const workspaceId = requestedWorkspaceId ?? navigation.activeWorkspaceId
    if (!workspaceId) return
    // 同 createNote：把开头解析出来的那一个显式传下去。下面 regionId 是按这个 workspaceId 派生的，
    // 若 openFile 自己重读活动 Workspace，两者就会指向不同的 Workspace——文件在 A 打开、diff 模式
    // 却切到了 B 的 Region（或谁的都不是）。
    const opening = get().openFile(path, undefined, undefined, workspaceId)
    const intentVersion = fileOpenIntentVersion
    const mayReveal = await opening
    const state = get(), original = findFileWorkbenchSurface(state, workspaceId, path), layout = state.layouts[workspaceId]
    const tab = original?.tab, surface = original?.surface
    const tabId = tab?.id, regionId = surface?.regionId
    const groupId = tabId ? tabGroupForTab(layout, tabId) : undefined
    // A failed file read has no destination. Reveal the exact successful placement without
    // setMainSurface's Session navigation replacing it with the original Agent Tab.
    if (!tabId || !regionId || !tab || !layout || !groupId || surface?.kind !== 'file' || surface.path !== path) return
    // A later navigation owns the screen while the file producer is pending.
    if (
      mayReveal && intentVersion === fileOpenIntentVersion &&
      state.mainSurface === navigation.mainSurface &&
      state.activeWorkspaceId === navigation.activeWorkspaceId &&
      state.agentFocus.execution.sessionId === navigation.agentFocus.execution.sessionId &&
      state.agentFocus.pmo.sessionId === navigation.agentFocus.pmo.sessionId
    ) {
      get().focusRegion(workspaceId, tabId, regionId, 'navigation', groupId)
      set({ activeWorkspaceId: workspaceId, mainSurface: 'workbench' })
    }
    await get().setEditorRegionMode(regionId, workspaceId, path, 'diff')
  },
  openGitWorkbench(workspaceId, snapshot) {
    return openGitReading(workspaceId, { kind: 'commit', snapshot })
  },
  openGitHistory(workspaceId, scope, reference, locate) {
    const opened = openGitReading(workspaceId, { kind: 'history', scope, ...(reference !== undefined ? { reference } : {}), ...(locate ? { locate } : {}) })
    set({ workspaceTool: 'git', workspaceGitView: 'history', toolsOpen: true })
    return opened
  },
  selectGitHistoryReference(regionId, reference) {
    const found = findWorkbenchRegion(get().tabs, regionId)
    if (found?.surface.kind !== 'git' || !found.surface.history || found.surface.history.reference === reference) return
    const { tab, surface } = found
    set(current => ({ tabs: { ...current.tabs, [tab.id]: { ...tab, regions: { ...tab.regions,
      [regionId]: { ...surface, history: { ...surface.history!, reference } } } } } }))
  },
  selectGitFile(regionId, file) {
    const found = findWorkbenchRegion(get().tabs, regionId)
    if (found?.surface.kind !== 'git' || !found.surface.selection) return
    const { tab, surface } = found
    get().releaseBranchDiff(regionId)
    const { file: _previousFile, ...fixed } = surface
    set(current => ({ tabs: { ...current.tabs, [tab.id]: { ...tab, regions: { ...tab.regions,
      [regionId]: { ...fixed, ...(file ? { file } : {}) } } } } }))
  },
  selectGitCommit(regionId, snapshot) {
    const found = findWorkbenchRegion(get().tabs, regionId)
    if (found?.surface.kind !== 'git' || found.surface.scope.hostId !== snapshot.hostId ||
        found.surface.scope.repoPath !== snapshot.repoPath) return
    const { tab, surface } = found
    get().releaseBranchDiff(regionId)
    const { file: _previousFile, ...fixed } = surface
    set(current => ({ tabs: { ...current.tabs, [tab.id]: { ...tab, regions: { ...tab.regions,
      [regionId]: { ...fixed, selection: { commitOid: snapshot.commitOid, parentOid: snapshot.parentOid } } } } } }))
  },
  openBranchDiff(workspaceId, comparison) {
    const state = get()
    if (!state.config?.workspaces.some((workspace) => workspace.id === workspaceId)) return
    const id = gitDiffIdentity(workspaceId, comparison)
    const existing = Object.values(state.tabs).flatMap((tab) => workbenchSurfaces(tab).flatMap((surface) => (
      surface.kind === 'git-diff' && gitDiffIdentity(surface.workspaceId, surface.comparison) === id
        ? [{ tab, surface }] : []
    )))[0]
    const tabId = existing?.tab.id ?? mintObjectId()
    const layout = state.layouts[workspaceId] ?? createWorkspaceLayout(newTabGroupId())
    const groupId = tabGroupForTab(layout, tabId) ?? layout.activeGroupId
    const nextLayout = existing ? activateLayoutTab(layout, groupId, tabId) : addTabPlacement(layout, groupId, tabId)
    if (!nextLayout) { get().reportError(new Error('The Tab Group is no longer available'), { kind: 'indeterminate',
      event: { source: 'spatial', key: mintObjectId(), object: { kind: 'tab-group', id: groupId, workspaceId } } }); return }
    const tab = existing
      ? focusWorkbenchTabRegion(existing.tab, existing.surface.regionId)
      : createWorkbenchTab(tabId, { kind: 'git-diff', regionId: newRegionId(), workspaceId, comparison })
    set((current) => ({
      activeWorkspaceId: workspaceId, mainSurface: 'workbench',
      tabs: { ...current.tabs, [tabId]: tab }, layouts: { ...current.layouts, [workspaceId]: nextLayout }
    }))
    get().focusRegion(workspaceId, tabId, tab.layout.activeRegionId, 'navigation', groupId)
  },
  async loadBranchDiff(regionId) {
    const surface = findWorkbenchRegion(get().tabs, regionId)?.surface
    if (surface?.kind === 'git' && surface.selection && surface.file) {
      const comparison = { kind: 'commit' as const,
        snapshot: { hostId: surface.scope.hostId, repoPath: surface.scope.repoPath, ...surface.selection }, file: surface.file }
      await loadRegionDiff(regionId, bridge => bridge.commitDiff(surface.workspaceId, comparison))
    } else if (surface?.kind === 'git-diff') {
      await loadRegionDiff(regionId, bridge => 'kind' in surface.comparison
        ? bridge.commitDiff(surface.workspaceId, surface.comparison)
        : bridge.branchDiff(surface.workspaceId, surface.comparison))
    }
  },
  releaseBranchDiff(regionId) {
    const kind = findWorkbenchRegion(get().tabs, regionId)?.surface.kind
    if (kind !== 'git-diff' && kind !== 'git') return
    regionDiffRequestIds.delete(regionId)
    set(state => {
      if (!Object.hasOwn(state.editorRegionDiffs, regionId)) return state
      const diffs = { ...state.editorRegionDiffs }
      delete diffs[regionId]
      return { editorRegionDiffs: diffs }
    })
  },
  async renameAgent(sessionId, name, expectedNameRevision) {
    try { const result = await commitDisplayName({ kind: 'agent-session', id: sessionId }, name, 'manual', expectedNameRevision); return result.applied && result.diskDurability === 'confirmed' }
    catch { return false }
  },
  async renameTab(tabId, name, expectedNameRevision) {
    try { const result = await commitDisplayName({ kind: 'tab', id: tabId }, name, 'manual', expectedNameRevision); return result.applied && result.diskDurability === 'confirmed' }
    catch { return false }
  },
  setFocusView(view) {
    if (view === 'map' && !get().collaborationMapTarget) get().openCollaborationMap()
    else set({ focusView: view, regionCaretFocus: null, workbenchNavigationInputPolicy: null })
  },
  openCollaborationMap(target) {
    const state = get()
    set({ mainSurface: 'agents', focusView: 'map', collaborationMapTarget: target ?? state.collaborationMapTarget ?? collaborationMapSpaceTarget(state),
      regionCaretFocus: null, workbenchNavigationInputPolicy: null })
  },
  locateSpaceInCollaborationMap() { get().openCollaborationMap(collaborationMapSpaceTarget(get())) },
  setMainSurface(mainSurface) {
    const state = get()
    const choice = state.workbenchSpaceSelection ?? (mainSurface === 'workbench' && state.activeWorkspaceId
      ? workbenchObjectLayout(state, state.activeWorkspaceId).choice : null)
    set({ mainSurface, workbenchNavigationInputPolicy: null, regionCaretFocus: null,
      ...(choice && !state.workbenchSpaceSelection ? { workbenchSpaceSelection: choice } : {}) })
  },
  selectMainRegion(reference, expected) {
    const state = get()
    if (expected !== undefined && !sameSpatialValue(state.workbenchSpaceSelection, expected)) return false
    const { overlays } = readDesktopPresentation(desktopSelection(state, workbenchSelectionCatalog(state)), state.tabs)
    if (overlays.settings === true || overlays.quickSwitcher === true) return false
    const layout = state.layouts[reference.displayWorkspaceId], tab = state.tabs[reference.tabId]
    const group = layout?.groups.find(item => item.id === reference.groupId)
    if (!layout || !group || !groupIds(layout.root).includes(group.id) || !group.tabOrder.includes(reference.tabId) || !tab?.regions[reference.regionId]) return false
    let choice: AgentMuxDesktopSpaceSelection
    try { choice = resolveWorkbenchOccurrenceSelection(state, workbenchSelectionCatalog(state), {
      workspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId }, 'navigation') }
    catch (error) { state.reportError(error, { kind: 'indeterminate' }); return false }
    const surface = tab.regions[reference.regionId]!
    const agentFocus = isSessionSurface(surface) ? focusSessionContext(state, surface.sessionId, undefined, reference) : state.agentFocus
    if (!sameSpatialValue(choice, state.workbenchSpaceSelection) || state.activeWorkspaceId !== choice.workspaceId || agentFocus !== state.agentFocus) {
      set({ workbenchSpaceSelection: choice, activeWorkspaceId: choice.workspaceId, retainedSpatialFocus: null,
        workbenchNavigationInputPolicy: null, regionCaretFocus: null, agentFocus })
    }
    return true
  },
  focusExecutionSession(id, reference, options) {
    const state = get()
    if (id && reference && !confirmedFocusReference(state, id, reference)) return false
    const agentFocus = id !== null && !state.sessions.some(session => session.id === id)
      ? focusExecution(state.agentFocus, id) : focusSessionContext(state, id, undefined, reference)
    set({ agentFocus })
    if (!id || options?.navigate === false) return true
    const result = executionFocusPresentation(agentFocus.execution, state.tabs, workbenchSelectionCatalog(state), () => {})
    const target = result.projection?.selection[0]
    if (target && get().selectMainRegion(target, state.workbenchSpaceSelection)) {
      set(current => ({ agentFocus: { ...current.agentFocus, execution: { ...current.agentFocus.execution, reference: target } } }))
      return true
    }
    state.reportError(new Error(result.issue ?? 'The selected Agent occurrence is unconfirmed. Its workface is kept; choose an exact original location.'), { kind: 'indeterminate' })
    return false
  },
  revealFocusAgent(target, presentationSessionId) {
    set({ mainSurface: 'agents', focusView: 'list', regionCaretFocus: null, workbenchNavigationInputPolicy: 'preserve',
      focusAgentReveal: { ...target, requestId: mintObjectId(), pending: true,
        ...(presentationSessionId === undefined ? {} : { presentationSessionId }) } })
  },
  finishFocusAgentReveal(requestId) {
    const current = get().focusAgentReveal
    if (current?.requestId === requestId && current.pending) set({ focusAgentReveal: { ...current, pending: false } })
  },
  clearFocusAgentReveal() { set({ focusAgentReveal: null }) },
  revealConversationItem(itemRef, routeHostId = itemRef.hostId) {
    get().conversationRevealIntent?.complete({ kind: 'cancelled' })
    const state = get(), reference = state.agentFocus.execution.reference
    const session = sessionPresentationById(state.sessions).get(itemRef.agentSessionId)
    if (!reference || session?.kind !== 'agent' || session.control.hostId !== routeHostId ||
      !confirmedFocusReference(state, itemRef.agentSessionId, reference) ||
      !sameWorkbenchProjectionSelection(mainRegionReference(state.workbenchSpaceSelection), reference)) {
      return Promise.resolve({ kind: 'unavailable', itemRef: { ...itemRef, source: { ...itemRef.source } }, message: 'Original location is unconfirmed. Choose its confirmed existing location; the recorded content and workface are kept.' })
    }
    // This stores no record body, reader or lifecycle. Later focus cannot retarget it.
    const frozenRef = { ...itemRef, source: { ...itemRef.source } }, frozenLocation = { ...reference }
    return new Promise(resolve => {
      let finished = false
      let unsubscribe = () => {}
      const changedIntent = () => intent.complete({ kind: 'cancelled' })
      const intent: ConversationRevealIntent = {
        itemRef: frozenRef, routeHostId, reference: frozenLocation, claimed: false,
        isCurrent: () => {
          const current = get(), live = sessionPresentationById(current.sessions).get(frozenRef.agentSessionId)
          return !finished && current.conversationRevealIntent === intent && current.mainSurface === state.mainSurface &&
            live?.kind === 'agent' && live.control.hostId === routeHostId &&
            sameWorkbenchProjectionSelection(mainRegionReference(current.workbenchSpaceSelection), frozenLocation)
        },
        complete: result => {
          if (finished) return
          finished = true
          unsubscribe()
          for (const event of ['pointerdown', 'keydown', 'wheel', 'touchmove']) document.removeEventListener(event, changedIntent, true)
          if (get().conversationRevealIntent === intent) set({ conversationRevealIntent: null })
          resolve(result.kind === 'unavailable' ? { ...result, itemRef: frozenRef } : result)
        }
      }
      for (const event of ['pointerdown', 'keydown', 'wheel', 'touchmove']) document.addEventListener(event, changedIntent, true)
      set({ conversationRevealIntent: intent })
      unsubscribe = useAppStore.subscribe(() => { if (!intent.isCurrent()) intent.complete({ kind: 'cancelled' }) })
    })
  },
  focusPmoSession(id) {
    set((state) => {
      const session = id ? state.sessions.find((candidate) => candidate.id === id) : undefined
      if (id && !session) return state
      if (session) {
        const lane = focusLaneForSession(topicIdForSession(state.config, session, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)),
          scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspaceForSession(state.config, session, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots))))
        if (lane === null) return state
        if (lane === 'execution') return state
      }
      return { agentFocus: focusPmo(state.agentFocus, id) }
    })
  },
  setSelectedDemand(id) {
    set({ selectedDemandId: id })
  },
  setDemandArrangement(arrangement) {
    set({ demandArrangement: arrangement })
  },
  async openDemandPmo(demandId, onReceipt) {
    return openGoalPmo(demandId, undefined, undefined, onReceipt === undefined ? undefined : { onReceipt })
  },
  async requestDemandPmoTask(demandId, mode, options) {
    const demand = get().demands[demandId]
    if (!demand) throw new Error(`Goal ${demandId} is unavailable`)
    const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'"
    const proposal = mode === 'grill'
      ? { summary: 'Current goal in the user’s words', criteria: [{ id: 'criterion-1', text: 'Observable success condition' }], openQuestions: [] }
      : { alignmentRevision: demand.alignment?.revision ?? 1, summary: 'Observed results', checks: [{ criterionId: demand.alignment?.criteria[0]?.id ?? 'criterion-1', outcome: 'unknown', evidence: [], note: 'State what remains unverified.' }] }
    const prompt = [
      `You coordinate delivery and closeout for existing Goal ${demand.id}. Current request: ${mode === 'grill' ? 'Grill: align the goal' : 'Grounding: align the results'}.`,
      ...(!demand.alignment && !demand.description.trim() ? ['This is an existing undefined Goal draft. Its placeholder title is not the user’s intent. Ask what they want to achieve and update this same Goal ID; do not invent an outcome, success criteria or human approval.'] : []),
      'Preserve the user’s original intent. Do not create another Goal, invent requirements, or overwrite description with your summary.',
      'Inspect this same Goal for its current Supervisor, assignees and criteria. Keep its delivery and naming responsibilities from the coordination guide. This request asks for discussion or inspection; continue execution only within authorization the user actually gave.',
      mode === 'grill'
        ? 'Discuss only choices that change the goal. Propose a readable summary, stable success criterion IDs, and actual unresolved questions. The person confirms the goal in Goals.'
        : 'Inspect the actual work and report every current criterion with met/gap/unknown, locatable evidence references and concrete gaps. A reference is not proof by itself. The person accepts results in Goals; never claim their acceptance.',
      `Current durable Goal facts:\n${JSON.stringify({ id: demand.id, title: demand.title, description: demand.description, projectId: demand.projectId, sessionIds: demand.sessionIds, supervisorSessionId: demand.supervisorSessionId, assigneeSessionIds: demand.assigneeSessionIds, alignment: demand.alignment, grounding: demand.grounding }, null, 2)}`,
      'Read the current Goal before submitting. Use the public CLI below; replace the example with your actual proposal, not its placeholder content. Owner generates revision/submission IDs and acknowledgement timestamps.',
      `"$AGENTMUX_CLI" goal inspect --goal ${quote(demand.id)}`,
      `"$AGENTMUX_CLI" goal update --goal ${quote(demand.id)} --${mode === 'grill' ? 'alignment' : 'grounding'} ${quote(JSON.stringify(proposal))}`
    ].join('\n\n')
    return openGoalPmo(demandId, prompt, mode === 'grill' ? demand.alignment ? 'Discuss changes' : 'Clarify goal' : demand.grounding ? 'Ask agent to check again' : 'Ask agent to check work', options, demand)
  },
  async createDemand(input, controlRequestId) {
    const presentation = get()
    const catalog = workbenchSelectionCatalog(presentation)
    const sourceSessionIds = input.decisionLog?.flatMap(decision => decision.sourceSessionId ? [decision.sourceSessionId] : [])
    const inferred = goalContentSource(catalog, sourceSessionIds?.length ? sourceSessionIds : input.sessionIds ?? []).contentRef
    const contentRefs = input.contentRefs ?? (inferred ? [inferred] : undefined)
    if (contentRefs?.some(ref => !confirmedGoalContentReference(catalog, ref))) throw controlFailure('INVALID_CONTROL_REQUEST', 'The exact Goal content resource is unconfirmed. Existing work is retained.')
    let receipt = await api.demands.create({
      ...(input.id === undefined ? {} : { id: input.id }),
      title: input.title.trim(),
      description: input.description ?? '',
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      projectId: input.projectId ?? null,
      projectName: input.projectName ?? null,
      ...(input.assigneeSessionIds === undefined ? {} : { assigneeSessionIds: [...input.assigneeSessionIds] }),
      ...(input.supervisorSessionId === undefined ? {} : { supervisorSessionId: input.supervisorSessionId }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      ...(input.plannedStartAt === undefined ? {} : { plannedStartAt: input.plannedStartAt }),
      ...(input.targetAt === undefined ? {} : { targetAt: input.targetAt }),
      ...(input.parentDemandId === undefined ? {} : { parentDemandId: input.parentDemandId }),
      ...(input.phaseIndex === undefined ? {} : { phaseIndex: input.phaseIndex }),
      sessionIds: input.sessionIds ?? [],
      ...(contentRefs === undefined ? {} : { contentRefs: [...contentRefs] })
    }, controlRequestId)
    const id = receipt.demand.id
    const decisionLog: AgentMuxDemandDecision[] = []
    const publish = (): void => {
      const record = { ...demandRecordFromFilesystem(receipt.demand), source: input.source ?? 'default-topic', decisionLog: [...decisionLog] }
      set(state => ({ demands: { ...state.demands, [id]: record },
        ...(state.mainSurface === presentation.mainSurface && state.activeWorkspaceId === presentation.activeWorkspaceId &&
          (state.selectedDemandId === presentation.selectedDemandId || state.selectedDemandId === id) ? { selectedDemandId: id } : {}) }))
    }
    publish()
    try {
      for (const message of input.activityLog ?? []) {
        receipt = await api.demands.activity(id, { kind: 'board', message, actorId: null })
        publish()
      }
      for (const decision of input.decisionLog ?? []) {
        receipt = await api.demands.decision(id, { question: decision.input, decision: decision.selectedProjectId ?? '(unassigned)', rationale: decision.candidates.map(candidate => candidate.reason).join('; ') || 'Explicit routing decision', actorId: decision.sourceSessionId })
        decisionLog.push(decision)
        publish()
      }
    } catch (error) {
      throw new Error(`Goal ${id} was saved, but its activity or routing record was not saved. The goal is retained; review it before retrying. ${error instanceof Error ? error.message : String(error)}`)
    }
    return id
  },
  async updateDemand(id, patch, controlRequestId, expectedUpdatedAt) {
    const current = get().demands[id]
    if (!current) throw new Error(`Goal ${id} is unavailable`)
    if (patch.contentRefs?.some(ref => !confirmedGoalContentReference(workbenchSelectionCatalog(get()), ref))) throw controlFailure('INVALID_CONTROL_REQUEST', 'The exact Goal content resource is unconfirmed. Existing work is retained.')
    const decisionLog = [...(current.decisionLog ?? [])]
    let receipt = await api.demands.update(id, {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.priority === undefined ? {} : { priority: patch.priority }),
      ...(patch.projectId === undefined ? {} : { projectId: patch.projectId }),
      ...(patch.projectName === undefined ? {} : { projectName: patch.projectName }),
      ...(patch.assigneeSessionIds === undefined ? {} : { assigneeSessionIds: patch.assigneeSessionIds }),
      ...(Object.hasOwn(patch, 'supervisorSessionId') ? { supervisorSessionId: patch.supervisorSessionId ?? null } : {}),
      ...(patch.sessionIds === undefined ? {} : { sessionIds: patch.sessionIds }),
      ...(patch.tags === undefined ? {} : { tags: patch.tags }),
      ...(patch.plannedStartAt === undefined ? {} : { plannedStartAt: patch.plannedStartAt }),
      ...(patch.targetAt === undefined ? {} : { targetAt: patch.targetAt }),
      ...(patch.parentDemandId === undefined ? {} : { parentDemandId: patch.parentDemandId }),
      ...(patch.phaseIndex === undefined ? {} : { phaseIndex: patch.phaseIndex }),
      ...(patch.alignment === undefined ? {} : { alignment: patch.alignment }),
      ...(patch.grounding === undefined ? {} : { grounding: patch.grounding }),
      ...(patch.contentRefs === undefined ? {} : { contentRefs: patch.contentRefs })
    }, controlRequestId, expectedUpdatedAt ?? current.updatedAt)
    const publish = (): void => {
      const record = { ...demandRecordFromFilesystem(receipt.demand), source: current.source, decisionLog: [...decisionLog] }
      set(state => ({ demands: { ...state.demands, [id]: record } }))
      refreshKnownGoalResponsibilities([id])
    }
    publish()
    try {
      for (const message of patch.activityLog?.slice(current.activityLog?.length ?? 0) ?? []) {
        receipt = await api.demands.activity(id, { kind: 'board', message, actorId: null })
        publish()
      }
      for (const decision of patch.decisionLog?.slice(current.decisionLog?.length ?? 0) ?? []) {
        receipt = await api.demands.decision(id, { question: decision.input, decision: decision.selectedProjectId ?? '(unassigned)', rationale: decision.candidates.map(candidate => candidate.reason).join('; ') || 'Explicit routing decision', actorId: decision.sourceSessionId })
        decisionLog.push(decision)
        publish()
      }
    } catch (error) {
      throw new Error(`Goal changes were saved, but a Session link, activity or routing record was not saved. Saved changes are retained; review the goal before retrying. ${error instanceof Error ? error.message : String(error)}`)
    }
  },
  async confirmDemandGoal(id, expectedRevision) {
    const receipt = await api.demands.confirmAlignment(id, expectedRevision)
    set(state => ({ demands: { ...state.demands, [id]: demandRecordFromFilesystem(receipt.demand, state.demands[id]) } }))
    refreshKnownGoalResponsibilities([id])
  },
  async acceptDemandResult(id, expectedAlignmentRevision, expectedSubmissionId, acceptGaps, finish) {
    const receipt = await api.demands.acceptGrounding(id, expectedAlignmentRevision, expectedSubmissionId, acceptGaps, finish)
    set(state => ({ demands: { ...state.demands, [id]: demandRecordFromFilesystem(receipt.demand, state.demands[id]) } }))
    refreshKnownGoalResponsibilities([id])
  },
  async refreshDemand(id) {
    const facts = await api.demands.list()
    const demand = facts.find(demand => demand.id === id)
    if (!demand) throw Object.assign(new Error(get().demands[id] ? 'The Goal owner did not return this goal. Its saved view is kept; retry loading the current proposal.' : 'The complete Goal owner read confirms this ID is not saved. Save this same ID explicitly to continue.'), { code: 'GOAL_OWNER_NOT_FOUND' })
    set(state => ({ demands: { ...state.demands, [id]: demandRecordFromFilesystem(demand, state.demands[id]) } }))
    refreshKnownGoalResponsibilities([id])
  },
  deleteDemand(id) {
    void api.demands.delete(id).catch((error) => get().reportError(error))
    set((state) => {
      if (!state.demands[id]) return state
      const { [id]: _removed, ...demands } = state.demands
      return {
        demands,
        demandPmoTabIds: Object.fromEntries(Object.entries(state.demandPmoTabIds).filter(([demandId]) => demandId !== id)),
        ...(state.selectedDemandId === id ? { selectedDemandId: null } : {})
      }
    })
  },
  toggleProjectRail() {
    set((state) => ({ projectRailOpen: !state.projectRailOpen }))
  },
  toggleProjectGroup(key) {
    set((state) => {
      // 折叠集合里**删掉**而不是写 false：只存折叠的那些，展开就是不在集合里（见状态声明）。
      // 写 `{...state, [key]: false}` 会让这份记录随着用户开合越攒越多，且和"新分组默认展开"
      // 变成两条规则。
      const { [key]: collapsed, ...rest } = state.collapsedProjectGroups
      return { collapsedProjectGroups: collapsed ? rest : { ...rest, [key]: true } }
    })
  },
  setExplorerCollapsed(workspaceId, collapsed) {
    // 写显式覆盖（true/false 都存下）。绝不删键、绝不折成缺席——缺席在这个 slice 里另有含义
    // （「按 kind 默认走」），把 false 抹成缺席就等于把默认折叠的 Scratch 又弹回默认。
    set((state) => ({ explorerCollapsed: { ...state.explorerCollapsed, [workspaceId]: collapsed } }))
  },
  togglePinnedItem(scope, id) {
    set((state) => {
      const current = state.pinnedItems[scope] ?? []
      const next = current.includes(id)
        ? current.filter((entry) => entry !== id) // unpin：只去这一条，其余保序
        : [...current, id] // pin：追加到末尾，pin 的先后就是顺序
      // 移空就删键，别留下空数组（同 toggleProjectGroup 的删键立场）。
      if (next.length === 0) {
        const { [scope]: _removed, ...rest } = state.pinnedItems
        return { pinnedItems: rest }
      }
      return { pinnedItems: { ...state.pinnedItems, [scope]: next } }
    })
  },
  async setSpaceObjectIcon(key, icon) {
    requireSpaceIconSelection(key, icon)
    const before = get().config
    if (!before) throw new Error('Configuration is still loading. Your avatar draft is kept; retry when it is ready.')
    const request = {}; spaceIconSaveRequests.set(key, request)
    const selected = icon && typeof icon === 'object' ? { ...icon } : icon
    const records = { ...(before.appearance.spaceObjectIcons ?? {}) }
    if (selected === null) delete records[key]
    else Object.defineProperty(records, key, { value: selected, enumerable: true, configurable: true, writable: true })
    const next = { ...before, appearance: { ...before.appearance, spaceObjectIcons: records } }
    try {
      let saved: AppConfig
      try { saved = await api.config.save(next, before) }
      catch (cause) {
        const observed = await readCurrentSpaceIconConfig()
        if (observed) get().setConfig(observed)
        const actual = observed?.appearance.spaceObjectIcons
        if (!observed || !Object.hasOwn(observed.appearance, 'spaceObjectIcons') ||
            (selected === null ? Object.hasOwn(actual ?? {}, key) : !configValuesEqual(actual?.[key], selected))) throw cause
        saved = observed
      }
      if (spaceIconSaveRequests.get(key) !== request) return
      if (get().config !== before && !configValuesEqual(get().config, saved)) saved = await readCurrentSpaceIconConfig() ?? saved
      get().setConfig(saved)
      // An explicit same-image Save retries that original bounded asset read, without changing
      // durable identity or making unrelated Session events allocate a new projection.
      if (selected && typeof selected === 'object' && configValuesEqual(get().spaceObjectIcons[key], selected))
        set(state => ({ spaceObjectIcons: { ...state.spaceObjectIcons, [key]: { ...selected } } }))
    } finally { if (spaceIconSaveRequests.get(key) === request) spaceIconSaveRequests.delete(key) }
  },
  setWorkspaceTool(workspaceTool) {
    set({ workspaceTool, toolsOpen: true, mainSurface: 'workbench' })
  },
  setWorkspaceGitView(workspaceGitView) {
    set({ workspaceGitView })
  },
  setGitCommitDraft(scope, message) {
    set(state => {
      const gitCommitDrafts = { ...state.gitCommitDrafts }
      if (message) gitCommitDrafts[scope] = message
      else delete gitCommitDrafts[scope]
      return { gitCommitDrafts }
    })
  },
  toggleTools() {
    set((state) => ({ toolsOpen: !state.toolsOpen }))
  },
  setProjectRailWidth(projectRailWidth) {
    set({ projectRailWidth: clampProjectRailWidth(projectRailWidth) })
  },
  setToolkitPresentation(toolId, patch) {
    let changed = false
    set(state => {
      const toolkitPresentation = updateToolkitPresentation(state.toolkitPresentation, toolId, patch)
      changed = toolkitPresentation !== state.toolkitPresentation
      return changed ? { toolkitPresentation } : state
    })
    if (changed) void flushWorkbenchPresentation()
  },
  setToolDockWidth(toolDockWidth) {
    set({ toolDockWidth: clampToolDockWidth(toolDockWidth) })
  },
  updateFileExplorerState(workspaceId, update) {
    set((state) => ({
      fileExplorerStates: {
        ...state.fileExplorerStates,
        [workspaceId]: update(
          state.fileExplorerStates[workspaceId] ?? createEmptyFileExplorerViewState()
        )
      }
    }))
  },
  async discoverHostExecutors(hostId) {
    const host = get().config?.hosts.find(host => host.id === hostId)
    if (!host) return
    const prior = get().hostExecutorInventories[hostId]
    const pending = pendingHostExecutorDiscoveries.get(hostId)
    if (pending && configValuesEqual(pending.input, host)) { await pending.promise; return }
    const request = Symbol(), input = structuredClone(host)
    hostExecutorRequests.set(hostId, request)
    const retained = prior && configValuesEqual(prior.input, input) ? prior.result : undefined
    set(state => ({ hostExecutorInventories: { ...state.hostExecutorInventories, [hostId]: {
      input, state: 'checking', ...(retained ? { result: retained } : {}),
      ...(prior && configValuesEqual(prior.input, input) && prior.detail ? { detail: prior.detail } : {})
    } } }))
    const current = () => hostExecutorRequests.get(hostId) === request &&
      configValuesEqual(get().config?.hosts.find(item => item.id === hostId), input)
    const promise = (async () => {
      try {
        const result = await api.executors.discover(hostId)
        if (!current()) return
        if (result.routeHostId !== hostId) throw new Error('Executor inventory belongs to another Host. Refresh the exact execution target.')
        set(state => ({ hostExecutorInventories: { ...state.hostExecutorInventories, [hostId]: { input, state: 'ready', result, observedAt: Date.now() } } }))
      } catch (error) {
        if (!current()) return
        set(state => ({ hostExecutorInventories: { ...state.hostExecutorInventories, [hostId]: {
          input, state: 'error', ...(retained ? { result: retained } : {}), detail: presentError(error), observedAt: Date.now()
        } } }))
      }
    })()
    pendingHostExecutorDiscoveries.set(hostId, { input, promise })
    try { await promise }
    finally { if (pendingHostExecutorDiscoveries.get(hostId)?.promise === promise) pendingHostExecutorDiscoveries.delete(hostId) }
  },
  async detectExecutors(hostId, options) {
    const config = get().config, host = config?.hosts.find(host => host.id === hostId)
    if (!config || !host) return
    if (host.kind === 'ssh') {
      const inventory = get().hostExecutorInventories[hostId]
      if (options?.onlyUnconfirmed && hostExecutorInventoryMatches(inventory, host) && inventory.state === 'ready' &&
        inventory.result && inventory.result.executors.every(item => item.availability === 'available' || item.availability === 'missing')) return
      return await get().discoverHostExecutors(hostId)
    }
    const inFlight: Promise<void>[] = []
    const targets = Object.entries(config.executors).filter(([executorId, executor]) => {
      const observed = currentExecutorDetection(get().executorDetections[executorDetectionKey(hostId, executorId)], executorId, executor, host)
      if (options?.onlyObserved && !observed) return false
      if (options?.onlyUnconfirmed && (observed?.state === 'ready' || observed?.state === 'missing')) return false
      const pending = pendingExecutorDetections.get(executorDetectionKey(hostId, executorId))
      if (pending && executorDetectionMatches(pending.input, executorId, executor, host)) {
        inFlight.push(pending.promise)
        return false
      }
      return true
    }).map(([executorId, executor]) => {
      const key = executorDetectionKey(hostId, executorId), requestId = Symbol()
      detectionRequestIds.set(key, requestId)
      const input = structuredClone({ executorId, providerId: executor.providerId, command: executor.command, environmentRevision: executorEnvironmentRevision(executor.env), host })
      return { key, requestId, input }
    })
    if (targets.length === 0) { await Promise.all(inFlight); return }
    const matchesCurrent = (input: ExecutorDetectionInput) => executorDetectionMatches(input, input.executorId,
      get().config?.executors[input.executorId], get().config?.hosts.find(host => host.id === input.host.id))
    set((state) => ({
      executorDetections: {
        ...state.executorDetections,
        ...Object.fromEntries(targets.map(({ key, input }) => {
          const prior = currentExecutorDetection(state.executorDetections[key], input.executorId, config.executors[input.executorId], host)
          return [key, { ...(prior?.state === 'error' || prior?.state === 'checking' ? prior : {}), state: 'checking', input } satisfies ExecutorDetectionState]
        }))
      }
    }))
    const started = targets.map(({ key, requestId, input }) => {
      const promise = (async () => {
        try {
          const result = await api.executors.detect(input.executorId, hostId)
          if (detectionRequestIds.get(key) !== requestId || result.input.executorId !== input.executorId ||
            result.input.host.id !== hostId || !matchesCurrent(result.input)) return
          // 三态探测结局 → store 的检查状态：available→ready, missing→missing, check-failed→error。
          // check-failed（环境退化，我们没查成）落到 error 而不是 missing——这正是那次误报要防的：
          // 「没查成」绝不能显示成「没装」。AgentSettingsPane 的 'error' 文案已是 "Check failed"。
          const state: AsyncCheckState = result.availability === 'available'
            ? 'ready'
            : result.availability === 'missing'
              ? 'missing'
              : 'error'
          set((current) => ({
            executorDetections: {
              ...current.executorDetections,
              [key]: {
                state,
                input: result.input,
                result,
                ...(result.availability !== 'available' && result.cause ? { detail: `${result.cause.code}: ${result.cause.message}` } : {}),
                observedAt: Date.now()
              }
            }
          }))
        } catch (error) {
          if (detectionRequestIds.get(key) !== requestId || !matchesCurrent(input)) return
          set((state) => ({
            executorDetections: {
              ...state.executorDetections,
              [key]: {
                state: 'error',
                input,
                detail: presentError(error),
                observedAt: Date.now()
              }
            }
          }))
        }
      })()
      pendingExecutorDetections.set(key, { input, promise })
      const release = () => {
        if (pendingExecutorDetections.get(key)?.promise === promise) pendingExecutorDetections.delete(key)
      }
      void promise.then(release, release)
      return promise
    })
    await Promise.all([...inFlight, ...started])
  },
  async checkHost(host) {
    const input = structuredClone(host)
    const requestId = (hostCheckRequestIds.get(host.id) ?? 0) + 1
    hostCheckRequestIds.set(host.id, requestId)
    set((state) => ({
      hostChecks: { ...state.hostChecks, [host.id]: { state: 'checking', input } }
    }))
    try {
      const result = await api.hosts.check(input)
      if (hostCheckRequestIds.get(host.id) !== requestId) return
      set((state) => ({
        hostChecks: {
          ...state.hostChecks,
          [host.id]: {
            state: result.outcome === 'ready' ? 'ready' : 'error',
            input: result.input,
            result,
            detail: result.detail,
            observedAt: Date.now()
          }
        }
      }))
    } catch (error) {
      if (hostCheckRequestIds.get(host.id) !== requestId) return
      set((state) => ({
        hostChecks: {
          ...state.hostChecks,
          [host.id]: { state: 'error', input, detail: presentError(error), observedAt: Date.now() }
        }
      }))
    }
  },
  async openFile(path, tabGroupId, location, requestedWorkspaceId, openAsText, placement, navigationSignal) {
    // 显式 workspace 优先于活动 workspace。异步动作（建文件、切 diff）必须能把**自己开头那次**
    // 解析结果传进来：否则调用方解析一次、这里再解析一次，两次之间用户切了侧栏就漂移，
    // 而漂移的症状不是报错而是**开错文件**——名字撞上另一个项目里的同名文件时界面上一切正常。
    const navigation = get()
    const workspaceId = requestedWorkspaceId ?? navigation.activeWorkspaceId
    const displayId = placement?.displayWorkspaceId ?? workspaceId
    const background = placement?.focus === false
    const fileIdentity = workspaceId ? fileWorkbenchIdentity(navigation, workspaceId, path, placement) : null
    const canonicalTabId = fileIdentity?.tabId ?? null
    let exactRegionId = placement?.launcher?.regionId ?? placement?.reference?.regionId ?? fileIdentity?.regionId ?? null
    let destinationTabId = placement?.split?.tabId ?? placement?.launcher?.tabId ?? placement?.reference?.tabId ?? canonicalTabId
    const originalTab = destinationTabId ? navigation.tabs[destinationTabId] : undefined
    const splitAnchor = placement?.split ? originalTab?.regions[placement.split.regionId] : undefined
    let expectedSurface = placement?.split || placement?.launcher ? undefined : exactRegionId ? originalTab?.regions[exactRegionId] : undefined
    let bookmarkOpened = false
    let result: FileOpenResult = { placement: { status: 'unconfirmed', tabId: null, regionId: null },
      data: { kind: 'unconfirmed', reason: null }, navigation: background ? 'background' : 'unconfirmed' }
    const rememberPlacement = () => {
      if (placement?.split) {
        const target = workbenchSurfaces(get().tabs[placement.split.tabId]!).find(surface => surface.kind === 'file' && surface.workspaceId === workspaceId && surface.path === path)
        if (target) exactRegionId = target.regionId
      }
      if (!canonicalTabId || !exactRegionId) return
      const tab = get().tabs[destinationTabId!]
      const surface = tab?.regions[exactRegionId]
      if (!expectedSurface && surface?.kind === 'file' && surface.workspaceId === workspaceId && surface.path === path) expectedSurface = surface
    }
    let releaseResource = () => {}
    try {
    const layout = displayId ? navigation.layouts[displayId] : undefined
    if (!workspaceId || !layout || placement && (!tabGroupId || !groupIds(layout.root).includes(tabGroupId) || !layout.groups.some(group => group.id === tabGroupId))) return false
    const originalResource = navigation.config?.workspaces.find(workspace => workspace.id === workspaceId)
    let resourceRebound = false, observedConfig = navigation.config
    if (originalResource) releaseResource = useAppStore.subscribe(state => {
      if (state.config === observedConfig) return
      observedConfig = state.config
      const current = state.config?.workspaces.find(workspace => workspace.id === workspaceId)
      if (current?.hostId !== originalResource.hostId || current.path !== originalResource.path) {
        resourceRebound = true
        releaseResource()
      }
    })
    const resourceCurrent = () => {
      const workspace = get().config?.workspaces.find(item => item.id === workspaceId)
      const currentLayout = displayId ? get().layouts[displayId] : undefined
      const currentTab = canonicalTabId ? get().tabs[destinationTabId!] : undefined
      return !resourceRebound && (!originalResource || workspace?.hostId === originalResource.hostId && workspace.path === originalResource.path) &&
        (!placement || workspace?.hostId === placement.resource.hostId && workspace.path === placement.resource.path &&
        currentLayout && tabGroupId && groupIds(currentLayout.root).includes(tabGroupId) && currentLayout.groups.some(group => group.id === tabGroupId) &&
        fileOpenReferenceMatches(get(), workspaceId, path, tabGroupId, placement) &&
        fileOpenSplitMatches(get(), workspaceId, tabGroupId, placement, confirmedExistingSpace(get())) &&
        (!placement.split || currentTab?.regions[placement.split.regionId] === splitAnchor) &&
        (bookmarkOpened || fileOpenLauncherMatches(get(), workspaceId, path, tabGroupId, placement))) &&
        (!placement?.onResult || !expectedSurface || exactRegionId && currentTab?.regions[exactRegionId] === expectedSurface)
    }
    if (!resourceCurrent()) return false
    function confirmedExistingSpace(state: AppState): ConfirmedExistingFileSpace | undefined {
      if (!placement || placement.reference || placement.launcher || !canonicalTabId) return undefined
      const tab = state.tabs[placement.split?.tabId ?? canonicalTabId]
      if (!tab) return undefined
      const workspace = state.config?.workspaces.find(item => item.id === workspaceId)
      const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)
      const catalog = spatialCatalog(state, topics ?? [])
      const original = catalog.tabs.find(item => item.tabId === tab.id)
      const zone = catalog.zones.find(item => item.zoneId === original?.zoneId)
      const file = regionIds(tab.layout.root).some(id => {
        const region = tab.regions[id]
        return region?.kind === 'file' && region.workspaceId === workspaceId && region.path === path
      })
      if (tab.workspaceId !== workspaceId || !placement.split && !file || !workspace ||
        workspace.hostId !== placement.resource.hostId || workspace.path !== placement.resource.path ||
        zone?.workspaceId !== workspaceId || zone.hostId !== workspace.hostId) {
        throw new Error('The existing File resource or Zone context is unconfirmed; its original Tab and body are retained.')
      }
      const space = { zoneId: zone.zoneId, spaceId: zoneContext(state, topics ?? [], zone) }
      if (tab.space && (tab.space.zoneId !== space.zoneId || tab.space.spaceId !== space.spaceId)) {
        throw new Error('The stored File context contradicts its original Zone; its original Tab and body are retained.')
      }
      return { tabId: tab.id, space }
    }
    if (!background && !placement?.projection && get().retainedSpatialFocus !== null) set({ retainedSpatialFocus: null })
    const intentVersion = background ? fileOpenIntentVersion : ++fileOpenIntentVersion
    if (!background) fileOpenNavigationUnsubscribe?.()
    const selected = fileNavigationSelection(navigation)
    let cancelled = false
    const unsubscribe = background ? () => {} : useAppStore.subscribe(function observeFileNavigation(state) {
      if (fileNavigationSelection(state) !== selected) {
        cancelled = true
        releaseNavigation()
      }
    })
    if (!background) fileOpenNavigationUnsubscribe = unsubscribe
    const releaseNavigation = () => {
      unsubscribe()
      if (fileOpenNavigationUnsubscribe === unsubscribe) fileOpenNavigationUnsubscribe = undefined
    }
    const mayReveal = () => (background || !navigationSignal?.aborted && intentVersion === fileOpenIntentVersion && !cancelled) && resourceCurrent()
    const selectProjection = () => {
      if (background) return
      // This is an explicit original File action, not discovery or arbitrary selection.
      const document = get().documents[documentKey(workspaceId, path)]
      if (navigation.mainSurface === 'survey' && placement?.projection?.presentationId === 'survey-workbench' &&
        placement.projection.entity.kind === 'zone' && placement.projection.entity.zoneId === placement.space.zoneId &&
        path.endsWith(NOTE_FILE_EXTENSION) && document && parseNoteFile(document).status === 'valid') {
        get().setSurveyZoneCollected(placement.space.zoneId, true)
      }
      if (placement?.focus === true && placement.selection && resourceCurrent()) {
        const choice = { ...placement.selection, ...((placement.split || bookmarkOpened) && exactRegionId ? { tabId: destinationTabId!, regionId: exactRegionId } : {}) }
        if (!choice.tabId || !choice.regionId || !choice.groupId) return
        set({ workbenchSpaceSelection: choice })
        const inputPolicy = placement.inputPolicy ?? 'preserve'
        get().focusRegion(choice.workspaceId, choice.tabId, choice.regionId, inputPolicy === 'target' ? 'keyboard' : 'pointer', choice.groupId)
        set({ activeWorkspaceId: choice.workspaceId, mainSurface: 'workbench', workbenchSpaceSelection: choice,
          ...(inputPolicy === 'preserve' ? { regionCaretFocus: null } : {}), workbenchNavigationInputPolicy: inputPolicy })
        result.navigation = 'applied'
        return
      }
      if (placement?.reference && !placement.projection && !bookmarkOpened) {
        set({ activeWorkspaceId: displayId!, mainSurface: 'workbench' })
        return
      }
      if (!placement?.projection) {
        const current = get(), placed = displayId ? current.layouts[displayId] : undefined
        const group = placed && findGroup(placed, placed.activeGroupId)
        if (displayId && destinationTabId && exactRegionId && group?.tabOrder.includes(destinationTabId)) {
          const applied = current.selectMainRegion({ displayWorkspaceId: displayId, groupId: group.id,
            tabId: destinationTabId, regionId: exactRegionId }, navigation.workbenchSpaceSelection)
          result.navigation = applied ? 'applied' : 'unconfirmed'
        }
        return
      }
      if (placement.reference && !bookmarkOpened) { placement.projection.onSelect(placement.reference); return }
      const tabId = bookmarkOpened ? destinationTabId! : placement.split?.tabId ?? placement.launcher?.tabId ?? destinationTabId!, tab = get().tabs[tabId]
      if (!tab || !tabGroupId || !findGroup(get().layouts[displayId!]!, tabGroupId)?.tabOrder.includes(tabId)) throw new Error('The exact Note display occurrence could not be confirmed.')
      const reference = { displayWorkspaceId: displayId!, groupId: tabGroupId, tabId, regionId: placement.split && exactRegionId ? exactRegionId : tab.layout.activeRegionId }
      placement.projection.onSelect(reference)
      if (placement.projection.presentationId === 'focus-workbench') result.navigation = get().mainSurface === 'agents' &&
        sameWorkbenchProjectionSelection(mainRegionReference(get().workbenchSpaceSelection), reference) ? 'applied' : 'cancelled'
    }
    const key = documentKey(workspaceId, path)
    // 书签文件（`.webloc`/`.url`）默认开进 Browser，不进 Monaco——用户原话「应该是默认 browser」。
    // 与下面目录分支同一个「不进 Monaco」的形状，但判据是纯字符串（扩展名），所以在读之前就分叉：
    // 二进制 `.webloc` 走 `files.read` 的 `toString('utf8')` 会被破坏，取 URL 必须走 main 侧字节 +
    // `plutil`（`files.readBookmark`）。取不出 URL（二进制读不回、坏文件）就落穿，退回把它当文本
    // 打开——诚实失败，不静默丢。`openAsText` 是「查看源码」入口：显式绕过这条分支回到文本路径（§2.6）。
    const bookmarkKind = openAsText ? null : bookmarkKindForPath(path)
    if (bookmarkKind) {
      try {
        const bookmark = await api.files.readBookmark(workspaceId, path)
        if (bookmark?.url) {
          if (!mayReveal()) return false
          // A bookmark creates a Browser beside the exact source or in a new
          // Browser Tab. It never consumes the canonical (possibly dirty) File.
          set(current => {
            const currentLayout = current.layouts[displayId!]
            const groupId = tabGroupId ?? layout.activeGroupId
            if (!currentLayout || !findGroup(currentLayout, groupId)) throw new Error('The original bookmark display Group is unconfirmed; its source is kept.')
            if (placement?.split) {
              const tab = current.tabs[placement.split.tabId]
              if (!tab || !fileOpenSplitMatches(current, workspaceId, groupId, placement, confirmedExistingSpace(current))) throw new Error('The original bookmark Region is unconfirmed; its source is kept.')
              exactRegionId = newRegionId()
              const pending: LauncherWorkbenchSurface = { kind: 'launcher', workspaceId, regionId: exactRegionId }
              const opened = addWorkbenchRegion(tab, placement.split.regionId, placement.split.direction, pending)
              expectedSurface = pending
              return { tabs: { ...current.tabs, [tab.id]: { ...opened, layout: { ...opened.layout, activeRegionId: tab.layout.activeRegionId } } } }
            }
            if (placement?.launcher && current.tabs[placement.launcher.tabId]?.regions[placement.launcher.regionId]?.kind === 'launcher') {
              destinationTabId = placement.launcher.tabId; exactRegionId = placement.launcher.regionId
              expectedSurface = current.tabs[destinationTabId]!.regions[exactRegionId]
              return current
            }
            const topicId = placement?.selection?.topicId ?? inheritedTopicIdForNewTab(workspaceId, currentLayout, current.tabs, groupId)
            const created = newLauncherTab(workspaceId, topicId ?? undefined)
            const tab = { ...created, ...(placement ? { space: placement.space } : {}) }
            destinationTabId = tab.id; exactRegionId = tab.layout.activeRegionId; expectedSurface = tab.regions[exactRegionId]
            const placed = addTabPlacement(currentLayout, groupId, tab.id)
            if (!placed) throw new Error('The original bookmark display Group is unconfirmed; its source is kept.')
            return { tabs: { ...current.tabs, [tab.id]: tab }, layouts: { ...current.layouts, [displayId!]: { ...placed,
              activeGroupId: currentLayout.activeGroupId, groups: placed.groups.map(group => {
                const before = findGroup(currentLayout, group.id)
                return before ? { ...group, activeTabId: before.activeTabId, recentTabIds: before.recentTabIds } : group
              }) } } }
          })
          await get().createBrowser(tabGroupId ?? layout.activeGroupId,
            { tabId: destinationTabId!, regionId: exactRegionId! }, bookmark.url, { path, binary: bookmark.binary }, workspaceId)
          expectedSurface = get().tabs[destinationTabId!]?.regions[exactRegionId!]
          bookmarkOpened = expectedSurface?.kind === 'browser' && expectedSurface.workspaceId === workspaceId && expectedSurface.bookmarkOrigin?.path === path
          result.data = { kind: 'not-file', reason: bookmarkOpened ? null : 'The original bookmark Browser is unconfirmed.' }
          if (bookmarkOpened && mayReveal()) { releaseNavigation(); selectProjection() }
          return !background && bookmarkOpened && intentVersion === fileOpenIntentVersion
        }
      } catch (error) {
        releaseNavigation()
        result.data = { kind: 'failed', reason: presentError(error) }
        get().reportError(error)
        return false
      }
    }
    if (!background) prepareFileSurface(path, effectiveFileRegionMode(navigation.editorRegionModes, exactRegionId ?? '', path,
      navigation.documentIssues[documentKey(workspaceId, path)]?.kind === 'binary'))
    try {
      // Stash the reveal target before opening. EditorPane consumes it once on Monaco mount (new
      // document) or on the `line` prop it reads (already-open document), then clears it. Setting it
      // for both paths means re-clicking a `:line` link on an open file re-reveals that line.
      if (location) {
        set((state) => ({
          documentRevealTargets: { ...state.documentRevealTargets, [key]: location }
        }))
      }
      const existing = get().documents[key]
      if (existing) {
        if (!mayReveal()) return false
        releaseNavigation()
        const targetGroupId = tabGroupId ?? layout.activeGroupId
        const activeTabId = findGroup(layout, targetGroupId)?.activeTabId
        const topicId = activeTabId ? get().tabs[activeTabId]?.topicId : undefined
        set((state) => reduceFileOpened(state, workspaceId, path, existing, tabGroupId, placement ? placement.selection?.topicId ?? undefined : topicId, placement, confirmedExistingSpace(state)))
        rememberPlacement()
        result.data = { kind: 'text', reason: null }
        selectProjection()
        return !background && intentVersion === fileOpenIntentVersion
      }
      // Media has a File identity, but never a UTF-8 buffer. Only its visible pane reads bytes.
      const format = workspaceFilePreviewFormat(path)
      if (!placement?.fileOnly && format && !format.sourceEditable || get().documentIssues[key]?.kind === 'binary') {
        if (!mayReveal()) return false
        releaseNavigation()
        const activeTabId = findGroup(layout, tabGroupId ?? layout.activeGroupId)?.activeTabId
        const topicId = activeTabId ? navigation.tabs[activeTabId]?.topicId : undefined
        set((state) => reduceFileSurfaceOpened(state, workspaceId, path, tabGroupId, placement ? placement.selection?.topicId ?? undefined : topicId, placement, confirmedExistingSpace(state)))
        rememberPlacement()
        result.data = { kind: get().documentIssues[key]?.kind === 'binary' ? 'binary-preview' : 'media-preview', reason: null }
        selectProjection()
        return !background && intentVersion === fileOpenIntentVersion
      }
      while (!get().documents[key]) {
        let request = fileOpenRequests.get(key)
        const joinedRequest = Boolean(request)
        if (!request) {
          const openedLifetime = advanceDocumentLifetime(key)
          const ownsRead = () => documentLifetime(key) === openedLifetime && fileOpenRequests.get(key) === request
          const releaseObservation = async () => { if (ownsRead()) await api.files.unobserve(workspaceId, path) }
          request = Promise.resolve().then(async () => {
            try {
              if (!ownsRead() || !resourceCurrent()) return false
              const invalidationSequence = fileInvalidationSequences.get(key) ?? 0
              await api.files.observe(workspaceId, path)
              if (!ownsRead() || !resourceCurrent()) return false
              const result = await api.files.read(workspaceId, path)
              if (!ownsRead() || !resourceCurrent()) return false
              if (result.status === 'directory') {
                // The shared producer owns the verdict, not any caller's navigation.
                await releaseObservation()
                return 'directory' as const
              }
              if (result.status !== 'read' && result.status !== 'binary') {
                await releaseObservation()
                throw new Error(result.status === 'deleted'
                  ? `File was deleted: ${path}`
                  : result.message)
              }
              if (documentLifetime(key) !== openedLifetime) {
                await releaseObservation()
                return false
              }
              const currentLayout = get().layouts[displayId!]
              if (!currentLayout) {
                await releaseObservation()
                return false
              }
              const targetGroupId = tabGroupId ?? (findGroup(currentLayout, layout.activeGroupId)
                ? layout.activeGroupId : currentLayout.activeGroupId)
              const activeTabId = findGroup(layout, targetGroupId)?.activeTabId
              const topicId = activeTabId ? navigation.tabs[activeTabId]?.topicId : undefined
              // Shared reads own data/placement, never a caller's later navigation. Each caller
              // below decides whether it still owns the latest uncancelled display intent.
              set((state) => {
                if (placement?.reference) return result.status === 'read'
                  ? reduceDocumentAttached(state, workspaceId, path, result.document)
                  : reduceDocumentLoadFailed(state, workspaceId, path, { kind: 'binary', revision: result.revision, byteLength: result.byteLength })
                const opened = format && !format.sourceEditable
                  ? reduceFileSurfaceOpened(state, workspaceId, path, targetGroupId, placement ? placement.selection?.topicId ?? undefined : topicId, placement, confirmedExistingSpace(state))
                  : result.status === 'read'
                  ? reduceFileOpened(state, workspaceId, path, result.document, targetGroupId, placement ? placement.selection?.topicId ?? undefined : topicId, placement, confirmedExistingSpace(state))
                  : reduceDocumentLoadFailed(
                    reduceFileSurfaceOpened(state, workspaceId, path, targetGroupId, placement ? placement.selection?.topicId ?? undefined : topicId, placement, confirmedExistingSpace(state)),
                    workspaceId, path, { kind: 'binary', revision: result.revision, byteLength: result.byteLength }
                  )
                const placed = opened.layouts[displayId!]!
                return {
                  ...opened,
                  lastActiveFileByWorkspace: state.lastActiveFileByWorkspace,
                  layouts: { ...opened.layouts, [displayId!]: {
                    ...placed, activeGroupId: currentLayout.activeGroupId,
                    groups: placed.groups.map((group) => {
                      const selected = findGroup(currentLayout, group.id)
                      return selected ? { ...group, activeTabId: selected.activeTabId, recentTabIds: selected.recentTabIds } : group
                    })
                  } }
                }
              })
              rememberPlacement()
              if (result.status === 'binary' || format && !format.sourceEditable) await releaseObservation()
              if (fileOpenRequests.get(key) === request) fileOpenRequests.delete(key)
              if ((fileInvalidationSequences.get(key) ?? 0) !== invalidationSequence) {
                await refreshFileDocument(workspaceId, path, openedLifetime)
              }
              return true
            } catch (error) {
              if (!ownsRead() || !resourceCurrent()) return false
              result.data = { kind: 'failed', reason: presentError(error) }
              get().reportError(error)
              return false
            } finally {
              if (resourceRebound && documentLifetime(key) === openedLifetime) await releaseObservation()
              if (fileOpenRequests.get(key) === request) fileOpenRequests.delete(key)
            }
          })
          fileOpenRequests.set(key, request)
        }
        const opened = await request
        if (opened === 'directory') {
          result.data = { kind: 'not-file', reason: 'The requested path is a directory; no File was created.' }
          result.placement = { status: 'none', tabId: null, regionId: null }
          if (!placement?.fileOnly && mayReveal()) {
            releaseNavigation()
            get().updateFileExplorerState(workspaceId, (current) => revealFileExplorerPath(current, path))
            set({ activeWorkspaceId: workspaceId, workspaceTool: 'files-branches', toolsOpen: true, mainSurface: 'workbench' })
          }
          return false
        }
        if (!opened) return false
        const state = get(), currentLayout = state.layouts[displayId!]
        result.data = { kind: format && !format.sourceEditable ? 'media-preview' : state.documentIssues[key]?.kind === 'binary' ? 'binary-preview' : 'text', reason: null }
        if ((state.documents[key] || state.documentIssues[key]?.kind === 'binary' || format && !format.sourceEditable) && currentLayout) {
          if (!mayReveal()) return false
          releaseNavigation()
          const activeTabId = findGroup(layout, tabGroupId ?? layout.activeGroupId)?.activeTabId
          const topicId = activeTabId ? navigation.tabs[activeTabId]?.topicId : undefined
          set((current) => current.documents[key]
            ? reduceFileOpened(current, workspaceId, path, current.documents[key]!, tabGroupId, placement ? placement.selection?.topicId ?? undefined : topicId, placement, confirmedExistingSpace(current))
            : reduceFileSurfaceOpened(current, workspaceId, path, tabGroupId, placement ? placement.selection?.topicId ?? undefined : topicId, placement, confirmedExistingSpace(current)))
          rememberPlacement()
          selectProjection()
          return !background && intentVersion === fileOpenIntentVersion
        }
        if (!joinedRequest) return false
      }
      return false
    } catch (error) {
      result.data = { kind: 'failed', reason: presentError(error) }
      get().reportError(error)
      return false
    } finally {
      releaseNavigation()
      // 「跳到第 N 行」是一次性的，而它的存放位置**会被复用**：key 是 `ws\0path`，确定性的。
      // 上面那次写入排在所有失败出口之前（必须如此——已开着的文件重点一次链接也要重新跳），
      // 而这个方法有四个失败出口（目录分支、读失败、lifetime 作废、layout 没了），任何一个
      // 走掉都会把 target 留在盘上。症状不是报错：用户之后从文件树打开同一个文件、没要求
      // 任何行号，EditorPane 挂载时把这条陈旧 target 消费掉，光标自己跳到上次那条失败链接
      // 里的行。
      //
      // 判据只有一处，而不是在四个出口各清一次：**没有文档落地在这个 key 上，target 就不该
      // 留着**。逐出口补清理必然漂移，而且新增第五个出口时没人会想起来
      //（记忆 two-write-sites-need-one-projection / guard-count-exits-not-conditions）。
      //
      // 「有文档就不动」这一条同时罩住了并发：两次点同一个文件（`foo.ts:42` 然后 `foo.ts:99`，
      // 第二次 join 第一次的在途请求）时，只要有一次成功，`documents[key]` 就在场，两个
      // finally 谁都不撤——后写的那个 target 赢。此处刻意**不**比 target 的同一性：
      // 实测加上 `!== location` 这层判断对任何时序都改变不了结果（两次都失败时撤掉是对的；
      // 有一次成功时上面那句已经挡住了），它是多余条件，而多余条件会让下一个人以为有场景
      // 依赖它（记忆 surviving-mutation-may-be-dead-condition）。
      //
      // 撤的动作走 `clearDocumentRevealTarget`——EditorPane 消费完之后调的也是它。就地再写一份
      // delete 会让「怎么撤一个 target」有两处取值层，必然漂移。
      if (location && !get().documents[key]) get().clearDocumentRevealTarget(key)
    }
    } finally {
      releaseResource()
      if (placement?.onResult) {
        const tabId = destinationTabId
        const tab = tabId && Object.hasOwn(get().tabs, tabId) ? get().tabs[tabId] : undefined
        const surface = exactRegionId ? tab?.regions[exactRegionId] : undefined
        const member = displayId && tabId && get().layouts[displayId]?.groups.some(group => group.id === tabGroupId && group.tabOrder.includes(tabId))
        if (expectedSurface && surface === expectedSurface && surface.workspaceId === workspaceId && (surface.kind === 'file' && surface.path === path || bookmarkOpened && surface.kind === 'browser' && surface.bookmarkOrigin?.path === path) && member) {
          result.placement = { status: originalTab?.regions[exactRegionId!] ? 'reused' : 'created', tabId: tabId!, regionId: exactRegionId! }
        } else if (result.data.kind !== 'not-file') result.placement = { status: result.data.kind === 'failed' && !expectedSurface ? 'none' : 'unconfirmed', tabId: null, regionId: null }
        if (!background && result.navigation !== 'applied' && (result.data.kind === 'text' || result.data.kind === 'media-preview' || result.data.kind === 'binary-preview' || bookmarkOpened)) result.navigation = 'cancelled'
        placement.onResult(result)
      }
    }
  },
  async attachPersistedFileDocument(workspaceId, path) {
    await loadPersistedFileDocument(workspaceId, path)
  },
  clearDocumentRevealTarget(key) {
    set((state) => {
      if (!state.documentRevealTargets[key]) return state
      const next = { ...state.documentRevealTargets }
      delete next[key]
      return { documentRevealTargets: next }
    })
  },
  async openProjectFolder() {
    const workspace = await api.workspaces.chooseLocalFolder()
    if (!workspace) return
    // Resolve config after the dialog returns; unrelated concurrent registrations stay intact.
    set((current) => current.config && !current.config.workspaces.some((item) => item.id === workspace.id)
      ? { config: { ...current.config, workspaces: [...current.config.workspaces, workspace] } }
      : current)
    await get().selectWorkspace(workspace.id)
  },
  async invalidateScratchTopicPaths(workspaceId, paths, structural = false) {
    const state = get(), workspace = state.config?.workspaces.find(item => item.id === workspaceId)
    if (!workspace || !isScratchWorkspaceId(workspace.id)) return
    const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)
    const changed = new Set(paths.map(path => scratchTopicInvalidation(workspace, topics, path, structural)).filter((id): id is string => id !== null))
    if (changed.has('catalog')) return await get().refreshScratchTopics(workspaceId, true)
    for (const id of changed) await get().refreshScratchTopics(workspaceId, true, id)
  },
  refreshScratchTopics(workspaceId, force = false, topicId) {
    const state = get()
    const workspace = state.config?.workspaces.find(candidate => candidate.id === workspaceId)
    if (!workspace || !isScratchWorkspaceId(workspace.id)) return Promise.resolve()
    const scope = scratchTopicsScope(workspace)
    const revision = state.workspaceFileRevisions[workspaceId] ?? 0
    const previous = state.scratchTopicSnapshots[workspaceId]
    const targetId = previous?.scope === scope && previous.topics !== null ? topicId : undefined
    const pending = scratchTopicReads.get(workspaceId)
    if (pending?.scope === scope) return force
      ? pending.promise.then(() => get().refreshScratchTopics(workspaceId, true, topicId))
      : pending.promise
    if (!force && previous?.scope === scope && previous.topics !== null && !previous.reading) return Promise.resolve()
    set(current => ({ scratchTopicSnapshots: { ...current.scratchTopicSnapshots, [workspaceId]: {
      scope, revision, topics: previous?.scope === scope ? previous.topics : null,
      discoveryError: previous?.scope === scope ? previous.discoveryError ?? null : null, error: previous?.scope === scope ? previous.error : null, reading: true
    } } }))
    const stillCurrent = (): boolean => {
      const current = get()
      const currentWorkspace = current.config?.workspaces.find(candidate => candidate.id === workspaceId)
      return Boolean(currentWorkspace && scratchTopicsScope(currentWorkspace) === scope &&
        scratchTopicReads.get(workspaceId)?.promise === job)
    }
    const read = targetId ? api.scratch.readTopic(workspaceId, targetId).then(topic => topic ? [topic] : []) : api.scratch.listTopics(workspaceId)
    const job = read.then((topics: import('../../shared/scratch-topics').ScratchTopicList) => {
      if (!stillCurrent()) return
      const retained = get().scratchTopicSnapshots[workspaceId]?.topics
      let facts = topics.map(topic => {
        const previousTopic = retained?.find(candidate => candidate.id === topic.id)
        // A failed file read is no new identity fact. Keep the last complete object,
        // with the read failure alongside it rather than guessing away its SOUL.
        if (topic.readError && previousTopic) {
          const { soul, moteArchive, ...retainedIdentity } = previousTopic
          return { ...retainedIdentity, readError: topic.readError,
            ...(topic.kind ? { kind: topic.kind } : {}),
            ...(topic.kind !== 'topic' && (topic.soul ?? soul) ? { soul: topic.soul ?? soul! } : {}),
            ...(topic.kind !== 'topic' && (topic.moteArchive ?? moteArchive) ? { moteArchive: topic.moteArchive ?? moteArchive! } : {}) }
        }
        // Archive read failure is advisory; it neither erases SOUL nor revives an archived Mote.
        return topic.moteArchive?.state === 'unknown' && previousTopic?.moteArchive?.state !== 'unknown' && previousTopic?.moteArchive
          ? { ...topic, moteArchive: previousTopic.moteArchive } : topic
      })
      if (targetId) {
        const updated = facts.find(topic => topic.id === targetId)
        facts = (retained ?? []).flatMap(original => original.id !== targetId ? [original] : updated ? [updated] : [])
        if (updated && !facts.some(topic => topic.id === updated.id)) facts.push(updated)
      }
      // An unclaimed directory has no ID to attach a failure to. Its discovery gap
      // cannot erase previously confirmed objects; keep their original facts until
      // this same scope can be completely observed again.
      if (topics.issues?.length) for (const original of retained ?? []) {
        if (!facts.some(topic => topic.id === original.id)) facts.push(original)
      }
      // Direct create/open publishes an authoritative observation while this read is pending.
      // Retain those newer objects, including a newly opened member absent from the older scan.
      for (const original of retained ?? []) {
        if (original === previous?.topics?.find(item => item.id === original.id)) continue
        const index = facts.findIndex(item => item.id === original.id)
        if (index < 0) facts.push(original)
        else facts[index] = original
      }
      const discoveryError = targetId ? get().scratchTopicSnapshots[workspaceId]?.discoveryError ?? null
        : topics.issues?.join(' · ') || null
      const errors = [...discoveryError ? [discoveryError] : [], ...facts.flatMap(topic => topic.readError ? [`${topic.title}: ${topic.readError}`] :
        topic.moteArchive?.state === 'unknown' ? [`${topic.title}: Archive state unconfirmed · ${topic.moteArchive.issue}`] : [])]
      set(current => ({ scratchTopicSnapshots: { ...current.scratchTopicSnapshots, [workspaceId]: {
        scope, revision, topics: facts, discoveryError, error: errors.length ? errors.join(' · ') : null, reading: false
      } } }))
    }).catch(error => {
      if (!stillCurrent()) return
      set(current => {
        const held = current.scratchTopicSnapshots[workspaceId]
        const facts = held?.topics?.map(topic => topic.id === targetId ? { ...topic, readError: presentError(error) } : topic) ?? null
        const discoveryError = targetId ? held?.discoveryError ?? null : presentError(error)
        const errors = [...discoveryError ? [discoveryError] : [], ...facts?.flatMap(topic => topic.readError ? [`${topic.title}: ${topic.readError}`] :
          topic.moteArchive?.state === 'unknown' ? [`${topic.title}: Archive state unconfirmed · ${topic.moteArchive.issue}`] : []) ?? [],
          ...(targetId && !facts?.some(topic => topic.id === targetId) ? [presentError(error)] : [])]
        return { scratchTopicSnapshots: { ...current.scratchTopicSnapshots, [workspaceId]: {
          scope, revision, topics: facts, discoveryError, error: errors.join(' · ') || null, reading: false
        } } }
      })
    }).finally(() => {
      if (scratchTopicReads.get(workspaceId)?.promise === job) scratchTopicReads.delete(workspaceId)
    })
    scratchTopicReads.set(workspaceId, { scope, promise: job })
    return job
  },
  async setMoteArchived(workspaceId, topicId, archived, objectKey, expectedVersion) {
    const captured = get(), workspace = captured.config?.workspaces.find(item => item.id === workspaceId)
    const scope = workspace ? scratchTopicsScope(workspace) : null
    const snapshot = captured.scratchTopicSnapshots[workspaceId]
    const topic = snapshot?.scope === scope ? snapshot.topics?.find(item => item.id === topicId) : undefined
    const identityPath = workspace && topic ? scratchTopicIdentityPath(workspace, topic) : null
    if (!workspace || !topic?.moteArchive || topic.moteArchive.state === 'unknown' || topic.moteArchive.version !== expectedVersion ||
      identityPath === null || scratchTopicIdFromWorkspacePath(workspace.path, identityPath, snapshot?.topics) !== topicId ||
      // Historical snapshots identify only their configured home; sibling roots
      // require the identity field confirmed by Main.
      (!topic.identityDirectoryPath && identityPath !== scratchTopicIdentityPath(workspace, { directoryPath: scratchTopicDirectoryName(topicId) })) ||
      directoryIdentity(workspace.hostId, identityPath) !== objectKey) {
      const error = new Error('Mote archive state is not confirmed. Refresh its directory before retrying.')
      get().reportError(error); throw error
    }
    try {
      const fact = await api.scratch.setMoteArchived(workspaceId, topicId, archived,
        objectKey, expectedVersion)
      if (fact.state !== (archived ? 'archived' : 'active') || !fact.version)
        throw new Error('The Mote archive write is not confirmed. Refresh its directory to inspect the saved state.')
      set(current => {
        const resource = current.config?.workspaces.find(item => item.id === workspaceId)
        if (!resource || scratchTopicsScope(resource) !== scope) return current
        const revision = bumpWorkspaceFileRevision(current.workspaceFileRevisions, workspaceId)
        const latest = current.scratchTopicSnapshots[workspaceId]
        const latestFact = latest?.topics?.find(item => item.id === topicId)?.moteArchive
        const mayPublish = latestFact?.state !== 'unknown' && latestFact?.version === expectedVersion
        return { workspaceFileRevisions: revision,
          ...(latest?.scope === scope ? { scratchTopicSnapshots: { ...current.scratchTopicSnapshots, [workspaceId]: {
            ...latest, revision: revision[workspaceId]!, topics: latest.topics?.map(item => item.id === topicId && mayPublish ? { ...item, moteArchive: fact } : item) ?? null
          } } } : {}) }
      })
      if (get().config?.workspaces.some(item => item.id === workspaceId && scratchTopicsScope(item) === scope))
        await get().refreshScratchTopics(workspaceId, true, topicId)
    } catch (error) { get().reportError(error); throw error }
  },
  async createScratchTopic(preset, initialRequest, knowledge) {
    const state = get()
    const workspace = state.config?.workspaces.find((item) => item.id === SCRATCH_WORKSPACE_ID)
    if (!workspace) throw new Error('Topics workspace is unavailable')
    const layout = state.layouts[workspace.id] ?? createWorkspaceLayout(newTabGroupId())
    // A Topic owns its directory before any Tab or Session exists. The launcher is a projection,
    // not the identity from which the Topic is derived.
    const topicId = mintObjectId()
    const targetTab = { ...newLauncherTab(workspace.id, topicId),
      ...(initialRequest && preset === 'mote' ? { topicPreparation: 'mote' as const } : {}) }
    const regionId = targetTab.layout.activeRegionId
    const initialSurface = targetTab.regions[regionId]
    const placeLauncher = (reveal = true): void => {
      let placementFailed = false
      set((current) => {
        const currentLayout = current.layouts[workspace.id] ?? layout
        const nextTab = { ...targetTab, topicId }
        const alreadyOpen = Boolean(current.tabs[targetTab.id])
        // 已在场只需激活；新建必须真的挂上，挂不上就整笔放弃（见 addTabPlacement）。
        // 不在 set 回调里抛：抛在 reducer 中间会让「有没有写进去」变得难读，故先记标记后抛。
        const nextLayout = alreadyOpen
          ? activateLayoutTab(currentLayout, layout.activeGroupId, nextTab.id)
          : addTabPlacement(currentLayout, layout.activeGroupId, nextTab.id)
        if (!nextLayout) {
          placementFailed = true
          return current
        }
        return {
          ...(reveal ? { activeWorkspaceId: workspace.id, mainSurface: 'workbench' as const,
            workbenchSpaceSelection: { spaceId: nextTab.space?.spaceId ?? null, zoneId: nextTab.space?.zoneId ?? null, workspaceId: workspace.id, topicId,
              tabId: nextTab.id, groupId: layout.activeGroupId, regionId },
            retainedSpatialFocus: null, regionCaretFocus: null, workbenchNavigationInputPolicy: null } : {}),
          tabs: { ...current.tabs, [nextTab.id]: nextTab },
          layouts: { ...current.layouts, [workspace.id]: reveal ? nextLayout : { ...nextLayout,
            activeGroupId: currentLayout.activeGroupId, groups: nextLayout.groups.map(group => {
              const previous = currentLayout.groups.find(item => item.id === group.id)
              return previous ? { ...group, activeTabId: previous.activeTabId, recentTabIds: previous.recentTabIds } : group
            }) } },
          ...(initialRequest ? { agentComposerDrafts: { ...current.agentComposerDrafts, [regionId]: initialRequest.prompt },
            ...(initialRequest.agentMuxNote === undefined ? {} : { agentComposerNotes: { ...current.agentComposerNotes, [regionId]: initialRequest.agentMuxNote } }) } : {}),
          workspaceFileRevisions: bumpWorkspaceFileRevision(
            current.workspaceFileRevisions,
            workspace.id
          )
        }
      })
      if (placementFailed) throw new Error('The Tab Group is no longer available')
    }
    // A first request belongs to a real durable Region before metadata can fail or navigation unmounts Goals.
    if (initialRequest) placeLauncher()
    const bornSelection = fileNavigationSelection(get())
    let snapshot: ScratchTopicSnapshot
    let createdIdentity: { topicId: string; zoneId: string } | undefined
    try {
      if (preset === 'mote') snapshot = await api.scratch.ensureMote(workspace.id, topicId)
      else {
        const result = await api.topics.call('topic.create', { topicId, title: knowledge?.title ?? 'New Topic', ...(knowledge?.categoryId ? { categoryId: knowledge.categoryId } : {}) })
        createdIdentity = result.topic
        await refreshTopicSpatial()
        const created = await api.scratch.readTopic(workspace.id, topicId)
        if (!created) throw new Error('The created Topic content is still unconfirmed. Its workface is kept; read the original Topic before retrying.')
        snapshot = created
      }
    } catch (cause) {
      if (initialRequest && get().tabs[targetTab.id]?.regions[regionId] === initialSurface) get().reportError(cause, {
        kind: 'indeterminate', summary: 'Topic preparation is unconfirmed. Your request has not been sent; the same Topic, Region and draft are kept. Retry Start agent here.'
      })
      throw cause
    }
    const address = topicSpatialAddress(get().config, snapshot, get().spaceZoneBindings, get().topicCategories)
    // Main owns the directory identity. Confirm its creation receipt against the same
    // content read, rather than predicting a Zone from the logical Scratch root.
    if (snapshot.id !== topicId || snapshot.readError || !address || preset !== 'mote' &&
      (!createdIdentity || createdIdentity.topicId !== topicId || createdIdentity.zoneId !== address.zoneId)) throw new Error('The created Topic original identity is unconfirmed. Read the same Topic to inspect its saved state; any existing Tab, Region and draft are kept.')
    const mayReveal = fileNavigationSelection(get()) === bornSelection
    if (!initialRequest) placeLauncher(mayReveal)
    else set(current => {
      const tab = current.tabs[targetTab.id]
      if (tab?.topicId !== topicId || tab.regions[regionId] !== initialSurface || !tab.topicPreparation) return current
      const { topicPreparation: _prepared, ...preparedTab } = tab
      return { tabs: { ...current.tabs, [tab.id]: preparedTab }, workspaceFileRevisions: bumpWorkspaceFileRevision(current.workspaceFileRevisions, workspace.id) }
    })
    set(current => {
      const previous = current.scratchTopicSnapshots[workspace.id], scope = scratchTopicsScope(workspace)
      const topics = previous?.scope === scope ? previous.topics ?? [] : []
      const live = current.tabs[targetTab.id]
      if (!live || live.topicId !== topicId || live.regions[regionId] !== initialSurface) return current
      const groupId = tabGroupForTab(current.layouts[workspace.id], live.id)
      return { tabs: { ...current.tabs, [live.id]: { ...live, space: address } },
        scratchTopicSnapshots: { ...current.scratchTopicSnapshots, [workspace.id]: { scope, revision: previous?.revision ?? 0,
          reading: previous?.reading ?? false, discoveryError: previous?.discoveryError ?? null, error: previous?.error ?? null, topics: topics.some(topic => topic.id === snapshot.id)
            ? topics.map(topic => topic.id === snapshot.id ? snapshot : topic) : [...topics, snapshot] } },
        ...(mayReveal && groupId ? { workbenchSpaceSelection: { ...address, workspaceId: workspace.id, topicId,
          tabId: live.id, groupId, regionId: live.layout.activeRegionId } } : {}) }
    })
    // Ordinary Topics open one attached Terminal through the existing Region lifecycle.
    // Mote creation keeps its launcher so selecting a personality does not start a shell.
    const createdLayout = get().layouts[workspace.id]
    const createdGroup = tabGroupForTab(createdLayout, targetTab.id)
    if (initialRequest && get().tabs[targetTab.id]?.regions[regionId] === initialSurface) {
      if (initialRequest.executorId && createdGroup) await get().launchAgent(initialRequest.executorId, initialRequest.prompt, createdGroup, { tabId: targetTab.id, regionId }, undefined, undefined, initialRequest.agentMuxNote)
      else if (!initialRequest.executorId) get().reportError(new Error('No Agent Executor is configured. Add an Agent in Settings, then Start agent in this same Region. Your request is kept and has not been sent.'), { kind: 'indeterminate' })
    } else if (createdGroup && !initialRequest && preset !== 'mote' && scratchTopicKind(snapshot.id, [snapshot]) === 'topic') {
      await get().promoteWarmTerminal(createdGroup, { tabId: targetTab.id, regionId: targetTab.layout.activeRegionId })
    }
    return snapshot
  },
  setScratchTopicOrder(order) {
    set({ scratchTopicOrder: [...order] })
  },
  async openScratchTopic(topicId, requestedWorkspaceId, options) {
    const state = get()
    // A Topic is a Scratch identity, so navigation must not depend on whichever Project happens
    // to be active when the click arrives. Pinned Topic rows remain visible while another Project
    // is selected; using activeWorkspaceId here made those clicks reject before the right workbench
    // could be revealed, leaving the user looking at an unchanged or empty surface.
    const workspaceId = requestedWorkspaceId ?? (
      isScratchTopicId(topicId) ? SCRATCH_WORKSPACE_ID : state.activeWorkspaceId
    )
    const reveal = options?.reveal ?? true
    const backgroundTab = !reveal && options?.tabId ? state.tabs[options.tabId] : undefined
    const pendingOwners = Object.values(state.tabs).filter(tab => tab.workspaceId === workspaceId && tab.topicId === topicId && tab.topicPreparation && !tab.space)
    const pendingBorn = options?.tabId ? pendingOwners.find(tab => tab.id === options.tabId) : pendingOwners.length === 1 ? pendingOwners[0] : undefined
    const pendingRegion = pendingBorn?.regions[pendingBorn.layout.activeRegionId]
    const workspace = state.config?.workspaces.find((item) => item.id === workspaceId)
    if (!workspace || !isScratchWorkspaceId(workspace.id)) {
      throw new Error('Scratch workspace is unavailable')
    }
    const showConversation = (snapshot: ScratchTopicSnapshot) => {
      const rootPath = scratchTopicLogicalPath(workspace, snapshot)
      if (rootPath !== null && !snapshot.readError && scratchTopicKind(snapshot.id, [snapshot]) === 'mote')
        showMoteConversation({ workspace, topic: snapshot, rootPath })
    }
    const remember = (snapshot: ScratchTopicSnapshot) => set(current => {
      const scope = scratchTopicsScope(workspace), previous = current.scratchTopicSnapshots[workspace.id]
      const topics = previous?.scope === scope ? previous.topics ?? [] : []
      return { scratchTopicSnapshots: { ...current.scratchTopicSnapshots, [workspace.id]: {
        scope, revision: previous?.revision ?? 0, reading: previous?.reading ?? false, discoveryError: previous?.discoveryError ?? null, error: previous?.error ?? null,
        topics: topics.some(topic => topic.id === snapshot.id)
            ? topics.map(topic => topic.id === snapshot.id ? snapshot : topic) : [...topics, snapshot] } } }
    })
    const selectObject = (current: AppState, snapshot: ScratchTopicSnapshot, targetTabId?: string): AgentMuxDesktopSpaceSelection => {
      const address = topicSpatialAddress(current.config, snapshot, current.spaceZoneBindings, current.topicCategories)
      if (!address) throw new Error('The Topic Category relationship is unconfirmed. Its original content and workface are kept.')
      const catalog = workbenchSelectionCatalog(current)
      const parent = { ...address, workspaceId: workspace.id, topicId, tabId: null, groupId: null, regionId: null }
      if (!targetTabId) {
        const preferred = moteDefaultConversation(current, snapshot, workspace.id)
        if (preferred.conversation && !preferred.issue) return { ...resolveDesktopSpaceSelection(current, catalog, {
          ...address, ...preferred.conversation }), topicId }
      }
      const held = current.workbenchSpaceSelection
      const layout = current.layouts[workspace.id]
      const projected = projectWorkbenchSpaceSelection(layout, current.tabs, catalog,
        held?.spaceId === address.spaceId && held.zoneId === address.zoneId ? held : parent).layout
      const groups = projected?.groups.filter(group => group.tabOrder.length && groupIds(projected.root).includes(group.id)) ?? []
      const targetGroups = targetTabId ? groups.filter(group => group.tabOrder.includes(targetTabId)) : []
      const group = targetTabId ? options?.groupId ? targetGroups.find(group => group.id === options.groupId)
        : targetGroups.find(group => held?.zoneId === address.zoneId && held.tabId === targetTabId && group.id === held.groupId) ?? (targetGroups.length === 1 ? targetGroups[0] : undefined)
        : groups.find(group => group.id === projected?.activeGroupId) ?? (groups.length === 1 ? groups[0] : undefined)
      const tabId = targetTabId ?? group?.activeTabId
      if (!tabId && !catalog.tabs.some(tab => tab.zoneId === address.zoneId)) return parent
      // A Topic opens its Zone. Multiple layout Groups do not require choosing one
      // exact child occurrence before showing all of the Zone's original Tabs.
      if ((!group || !tabId) && !targetTabId) return parent
      if (!group || !tabId) throw new Error('This object has no unique confirmed Tab occurrence. Its original workface is kept; choose an exact Tab and Group.')
      return { ...resolveDesktopSpaceSelection(current, catalog, { ...address, tabId, groupId: group.id,
        displayWorkspaceId: workspace.id }), topicId }
    }
    if (options?.newTab) {
      const request = options.initialRequest
      const known = scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)?.find(topic => topic.id === topicId)
      const bornSpaceId = directoryIdentity(workspace.hostId, scratchTopicIdentityPath(workspace, { directoryPath: scratchTopicDirectoryName(topicId) }))
      const address = known ? topicSpatialAddress(state.config, known, state.spaceZoneBindings, state.topicCategories)
        : { spaceId: null, zoneId: null }
      if (!address) throw new Error('The Topic Category relationship is unconfirmed. Original workface is kept.')
      const tab = { ...newLauncherTab(workspace.id, topicId), ...(address.spaceId && address.zoneId ? { space: { spaceId: address.spaceId, zoneId: address.zoneId } } : {}), ...(request ? { topicPreparation: 'mote' as const } : {}) }
      const regionId = tab.layout.activeRegionId, initialSurface = tab.regions[regionId]
      let groupId: string | undefined
      set(current => {
        const layout = current.layouts[workspace.id] ?? createWorkspaceLayout(newTabGroupId())
        const placed = addTabPlacement(layout, layout.activeGroupId, tab.id)
        if (!placed) return current
        groupId = layout.activeGroupId
        return {
          tabs: { ...current.tabs, [tab.id]: tab },
          layouts: { ...current.layouts, [workspace.id]: reveal ? placed : {
            ...placed, activeGroupId: layout.activeGroupId,
            groups: placed.groups.map(group => {
              const previous = layout.groups.find(item => item.id === group.id)
              return previous ? { ...group, activeTabId: previous.activeTabId, recentTabIds: previous.recentTabIds } : group
            })
          } },
          ...(reveal ? { activeWorkspaceId: workspace.id, mainSurface: 'workbench' as const,
            workbenchSpaceSelection: { ...address, workspaceId: workspace.id, topicId, tabId: tab.id,
              groupId: layout.activeGroupId, regionId }, retainedSpatialFocus: null, regionCaretFocus: null,
            workbenchNavigationInputPolicy: null } : {}),
          ...(request ? { agentComposerDrafts: { ...current.agentComposerDrafts, [regionId]: request.prompt },
            ...(request.agentMuxNote === undefined ? {} : { agentComposerNotes: { ...current.agentComposerNotes, [regionId]: request.agentMuxNote } }) } : {}),
          workspaceFileRevisions: bumpWorkspaceFileRevision(current.workspaceFileRevisions, workspace.id)
        }
      })
      if (!groupId) throw new Error('The Scratch Tab Group is no longer available')
      const bornSelection = fileNavigationSelection(get())
      // Present the exact born owner once. A late preparation receipt never reopens a closed float.
      if (request && !options.signal?.aborted) requestPmoTeamsTopicFloatingOpen({ targetTopicId: topicId, targetTabId: tab.id })
      try {
        const snapshot = request ? await api.scratch.ensureMote(workspace.id, topicId) : await api.scratch.readTopic(workspace.id, topicId)
        if (!snapshot) throw new Error('Scratch Topic no longer exists')
        remember(snapshot)
        const address = topicSpatialAddress(get().config, snapshot, get().spaceZoneBindings, get().topicCategories)
        if (!address) throw new Error('The born Topic relationship is unconfirmed. Its Tab, Region and draft are retained.')
        if (snapshot.id !== topicId || snapshot.readError || tab.space && address.zoneId !== tab.space.zoneId) throw new Error('The confirmed Topic identity differs from its born owner. Its original Tab, Region and draft are retained.')
        set(current => current.tabs[tab.id]?.topicId === topicId && current.tabs[tab.id]?.regions[regionId] === initialSurface
          ? { tabs: { ...current.tabs, [tab.id]: { ...current.tabs[tab.id]!, space: address } } } : current)
        if (reveal && !options.signal?.aborted && fileNavigationSelection(get()) === bornSelection && get().tabs[tab.id]?.regions[regionId] === initialSurface) {
          const choice = selectObject(get(), snapshot, tab.id)
          set({ workbenchSpaceSelection: choice, retainedSpatialFocus: null, workbenchNavigationInputPolicy: null })
        }
      } catch (cause) {
        if (request && get().tabs[tab.id]?.regions[regionId] === initialSurface) get().reportError(cause, {
          kind: 'indeterminate', summary: 'Topic preparation is unconfirmed. Your request has not been sent; the same Mote, Tab, Region and draft are kept. Retry Start agent here.'
        })
        throw cause
      }
      if (get().tabs[tab.id]?.regions[regionId] !== initialSurface) return false
      set(current => {
        const currentTab = current.tabs[tab.id]
        if (!currentTab?.topicPreparation || currentTab.regions[regionId] !== initialSurface) return current
        const { topicPreparation: _prepared, ...prepared } = currentTab
        return { tabs: { ...current.tabs, [tab.id]: prepared }, workspaceFileRevisions: bumpWorkspaceFileRevision(current.workspaceFileRevisions, workspace.id) }
      })
      if (request?.executorId) await get().launchAgent(request.executorId, request.prompt, groupId, { tabId: tab.id, regionId }, undefined, undefined, request.agentMuxNote)
      else if (request) get().reportError(new Error('The primary Mote Agent configuration is unconfirmed. Your request has not been sent; choose an Agent and Start agent in this same Region.'), { kind: 'indeterminate' })
      return true
    }
    // Reveal the durable Scratch shell before reading Topic metadata. Filesystem reads are a
    // preparation step, not permission to hide the workbench: if the read is slow or fails, the
    // user must still see the Scratch work surface and its error/retry path instead of an empty
    // right side. Background preparation explicitly keeps the current surface untouched.
    const known = scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)?.find(topic => topic.id === topicId)
    let revealedExistingWorkface = false
    if (reveal && !options?.signal?.aborted) {
      if (known) {
        const choice = selectObject(get(), known, options?.tabId)
        revealedExistingWorkface = workbenchSelectionCatalog(get()).tabs.some(tab => tab.zoneId === choice.zoneId)
        // Select the original occurrence, layout and execution context together. Calling
        // activateTab after this choice would submit the same navigation a second time.
        set(current => {
          const layout = current.layouts[choice.workspaceId]
          const activeRegion = choice.tabId && choice.regionId ? current.tabs[choice.tabId]?.regions[choice.regionId] : undefined
          return { activeWorkspaceId: choice.workspaceId, mainSurface: 'workbench' as const, workbenchSpaceSelection: choice,
            retainedSpatialFocus: null, workbenchNavigationInputPolicy: null, regionCaretFocus: null,
            ...(layout && choice.tabId && choice.groupId ? { layouts: { ...current.layouts,
              [choice.workspaceId]: activateLayoutTab(layout, choice.groupId, choice.tabId) } } : {}),
            ...(activeRegion && isSessionSurface(activeRegion) ? { agentFocus: focusSessionContext(current, activeRegion.sessionId,
              undefined, { displayWorkspaceId: choice.workspaceId, groupId: choice.groupId!, tabId: choice.tabId!, regionId: choice.regionId! }) } : {}) }
        })
        showConversation(known)
        options?.onRevealed?.()
      }
      if (!known) set((current) => {
        // An unconfirmed discovery cannot replace a previously selected object.
        if (!known && current.workbenchSpaceSelection) return current
        const layout = current.layouts[workspace.id]
        const requestedTab = options?.tabId ? current.tabs[options.tabId] : undefined
        const groupId = layout && requestedTab?.workspaceId === workspace.id && requestedTab.topicId === topicId
          ? tabGroupForTab(layout, requestedTab.id) : null
        // A durable exact target is navigation truth already. Reveal it now;
        // a delayed metadata read must not repeat this choice over a later Tab click.
        return {
          activeWorkspaceId: workspace.id,
          mainSurface: 'workbench',
          layouts: layout
            ? requestedTab && groupId
              ? { ...current.layouts, [workspace.id]: activateLayoutTab(layout, groupId, requestedTab.id) }
              : current.layouts
            : { ...current.layouts, [workspace.id]: createWorkspaceLayout(newTabGroupId()) }
        }
      })
    }
    const selected = fileNavigationSelection(get())
    let laterIntent = false, released = false
    let unsubscribe = () => {}
    const events = ['pointerdown', 'keydown', 'input'] as const
    const inputOwner = typeof document === 'undefined' ? null : document
    const release = () => {
      if (released) return
      released = true; unsubscribe()
      if (reveal) for (const event of events) inputOwner?.removeEventListener(event, cancel, true)
      options?.signal?.removeEventListener('abort', cancel)
    }
    const cancel = () => { laterIntent = true; release() }
    if (reveal) {
      unsubscribe = useAppStore.subscribe(current => { if (fileNavigationSelection(current) !== selected) cancel() })
      for (const event of events) inputOwner?.addEventListener(event, cancel, true)
      options?.signal?.addEventListener('abort', cancel, { once: true })
      if (options?.signal?.aborted) cancel()
    }
    let snapshot: ScratchTopicSnapshot | null
    try { snapshot = await api.scratch.readTopic(workspace.id, topicId) }
    catch (error) {
      if (options?.reportFailure !== false) get().reportError(error, { kind: 'indeterminate', summary: 'Topic metadata is unavailable. Original workface, references and healthy Agents are retained; retry this Topic.' })
      throw error
    }
    finally { release() }
    if (!snapshot) throw new Error('Scratch Topic no longer exists')
    if (!reveal && options?.tabId) {
      const current = get(), live = current.tabs[options.tabId]
      const resource = current.config?.workspaces.find(item => item.id === workspace.id)
      if (!resource || scratchTopicsScope(resource) !== scratchTopicsScope(workspace))
        throw new Error('The original Scratch resource changed during preparation. Its workface and references are kept.')
      if (!backgroundTab || backgroundTab.workspaceId !== workspace.id || backgroundTab.topicId !== topicId ||
        live?.workspaceId !== workspace.id || live.topicId !== topicId ||
        backgroundTab.space && live.space?.zoneId !== backgroundTab.space.zoneId)
        throw new Error('The original discussion owner is no longer confirmed. Its content and references are kept.')
      if (snapshot.id !== topicId || snapshot.readError)
        throw new Error(snapshot.readError ?? 'The prepared Topic differs from its original owner. Its workface and references are kept.')
      const address = topicSpatialAddress(current.config, snapshot, current.spaceZoneBindings, current.topicCategories)
      if (!address || live.space && live.space.zoneId !== address.zoneId)
        throw new Error('The prepared Topic binding differs from its original owner. Its workface and references are kept.')
    }
    remember(snapshot)
    if (pendingBorn && snapshot.id === topicId && !snapshot.readError) {
      const address = topicSpatialAddress(get().config, snapshot, get().spaceZoneBindings, get().topicCategories)
      if (address) set(current => {
        const live = current.tabs[pendingBorn.id]
        if (!live?.topicPreparation || live.space || live.topicId !== topicId || live.regions[pendingBorn.layout.activeRegionId] !== pendingRegion) return current
        const { topicPreparation: _prepared, ...prepared } = live
        return { tabs: { ...current.tabs, [live.id]: { ...prepared, space: address } } }
      })
    }
    if (!reveal && options?.tabId) {
      const current = get(), live = current.tabs[options.tabId]
      const address = topicSpatialAddress(current.config, snapshot, current.spaceZoneBindings, current.topicCategories)
      const member = workbenchSelectionCatalog(current).tabs.find(tab => tab.tabId === options.tabId)
      if (!address || live?.workspaceId !== workspace.id || live.topicId !== topicId ||
        member?.workspaceId !== workspace.id || member.zoneId !== address.zoneId || pendingBorn && !live.space)
        throw new Error('The original discussion binding is unconfirmed. Its workface and references are kept.')
      // Preparation confirms the original owner. Display placement and navigation remain with
      // their caller, including Tabs presented only outside their resource Workspace.
      return true
    }
    const mayReveal = reveal && !options?.signal?.aborted && !laterIntent
    if (reveal && !mayReveal) return false
    // The click already opened its durable Zone, optionally with an exact Chat.
    // Metadata refresh is not another navigation or permission to create a Tab.
    if (revealedExistingWorkface) {
      const preferred = !options?.tabId ? moteDefaultConversation(get(), snapshot, workspace.id) : {}
      const fresh = preferred.issue ? undefined : preferred.conversation
      const prior = known?.quickMode?.status === 'saved' ? known.quickMode.defaults.conversation : undefined
      if (fresh && JSON.stringify(fresh) !== JSON.stringify(prior)) {
        const choice = selectObject(get(), snapshot)
        const selectedLayout = get().layouts[choice.workspaceId]
        set(current => ({ activeWorkspaceId: choice.workspaceId, workbenchSpaceSelection: choice,
          ...(selectedLayout && choice.tabId && choice.groupId ? { layouts: { ...current.layouts,
            [choice.workspaceId]: activateLayoutTab(selectedLayout, choice.groupId, choice.tabId) } } : {}) }))
        showConversation(snapshot)
        options?.onRevealed?.()
      }
      return true
    }
    let createdLauncher: WorkbenchTab | undefined
    let placementFailed = false
    set((current) => {
      const layout = current.layouts[workspace.id] ?? createWorkspaceLayout(newTabGroupId())
      const address = topicSpatialAddress(current.config, snapshot!, current.spaceZoneBindings, current.topicCategories)
      if (!address) { placementFailed = true; return current }
      const catalog = workbenchSelectionCatalog(current)
      const requestedTab = options?.tabId ? current.tabs[options.tabId] : undefined
      const objectChoice = options?.tabId ? null : selectObject(current, snapshot!)
      const boundTab = options?.tabId
        ? requestedTab && catalog.tabs.some(tab => tab.tabId === requestedTab.id && tab.zoneId === address.zoneId) && tabGroupForTab(layout, requestedTab.id) !== null
          ? requestedTab
          : undefined
        : objectChoice?.tabId ? current.tabs[objectChoice.tabId] : undefined
      if (options?.tabId && !boundTab) {
        placementFailed = true
        return current
      }
      if (boundTab || objectChoice && catalog.tabs.some(tab => tab.zoneId === address.zoneId)) {
        if (!mayReveal) return current
        const choice = objectChoice ?? selectObject(current, snapshot!, boundTab!.id)
        const selectedLayout = current.layouts[choice.workspaceId]
        return {
          activeWorkspaceId: choice.workspaceId, mainSurface: 'workbench' as const, workbenchSpaceSelection: choice,
          retainedSpatialFocus: null, workbenchNavigationInputPolicy: null, regionCaretFocus: null,
          ...(selectedLayout && choice.tabId && choice.groupId ? { layouts: { ...current.layouts,
            [choice.workspaceId]: activateLayoutTab(selectedLayout, choice.groupId, choice.tabId) } } : {})
        }
      }
      // Selecting an existing confirmed empty Topic/Zone does not create work.
      // Explicit createScratchTopic/newTab owns the first durable surface.
      if (objectChoice && !catalog.tabs.some(tab => tab.zoneId === address.zoneId)) return mayReveal
        ? { activeWorkspaceId: workspace.id, mainSurface: 'workbench' as const,
          workbenchSpaceSelection: { ...address, workspaceId: workspace.id, topicId, tabId: null, groupId: null, regionId: null },
          retainedSpatialFocus: null, workbenchNavigationInputPolicy: null, regionCaretFocus: null }
        : current
      const tab = { ...newLauncherTab(workspace.id), topicId, space: address }
      const nextLayout = addTabPlacement(layout, layout.activeGroupId, tab.id)
      if (!nextLayout) {
        placementFailed = true
        return current
      }
      createdLauncher = tab
      // Background preparation adds a retained owner without selecting it behind the float.
      // The floating chrome derives its bound-only layout from these same Tabs.
      const placedLayout = mayReveal ? nextLayout : {
        ...nextLayout, activeGroupId: layout.activeGroupId,
        groups: nextLayout.groups.map(group => {
          const original = layout.groups.find(candidate => candidate.id === group.id)
          return original ? { ...group, activeTabId: original.activeTabId, recentTabIds: original.recentTabIds } : group
        })
      }
      return {
        ...(mayReveal ? { activeWorkspaceId: workspace.id, mainSurface: 'workbench' as const } : {}),
        tabs: { ...current.tabs, [tab.id]: tab },
        layouts: { ...current.layouts, [workspace.id]: placedLayout },
        ...(mayReveal ? { workbenchSpaceSelection: { ...address, workspaceId: workspace.id, topicId,
          tabId: tab.id, groupId: layout.activeGroupId, regionId: tab.layout.activeRegionId },
          retainedSpatialFocus: null, workbenchNavigationInputPolicy: null, regionCaretFocus: null } : {})
      }
    })
    if (placementFailed) throw new Error('The Tab Group is no longer available')
    if (mayReveal) {
      showConversation(snapshot)
      options?.onRevealed?.()
    }
    // A filesystem Topic with no existing View is still expected to open a usable work
    // surface. Keep the launcher as the durable owner and replace its active Region through
    // the same lifecycle path used by the New Tab Terminal action. Background preparation (the
    // fixed PMO Teams Topic) deliberately stops at the launcher so it cannot steal the user's focus
    // or start a duplicate terminal.
    const liveLayout = get().layouts[workspace.id]
    if (createdLauncher && mayReveal && liveLayout && scratchTopicKind(snapshot.id, [snapshot]) === 'topic') {
      await get().promoteWarmTerminal(tabGroupForTab(liveLayout, createdLauncher.id)!, {
        tabId: createdLauncher.id,
        regionId: createdLauncher.layout.activeRegionId
      })
    }
    return true
  },
  async renameScratchTopic(topicId, title, requestedWorkspaceId) {
    const state = get()
    const workspace = state.config?.workspaces.find((item) => item.id === (requestedWorkspaceId ?? state.activeWorkspaceId))
    if (!workspace || !isScratchWorkspaceId(workspace.id)) {
      throw new Error('Select the Scratch workspace first')
    }
    try {
      const snapshot = await api.scratch.renameTitle(workspace.id, topicId, title)
      set((current) => ({
        workspaceFileRevisions: bumpWorkspaceFileRevision(
          current.workspaceFileRevisions,
          workspace.id
        )
      }))
      await get().refreshScratchTopics(workspace.id, true, topicId)
      return snapshot
    } catch (error) {
      get().reportError(error)
      throw error
    }
  },
  async createPath(input, requestedWorkspaceId) {
    const workspaceId = requestedWorkspaceId ?? get().activeWorkspaceId
    if (!workspaceId) throw new Error('Select a workspace first')
    try {
      await api.files.create(workspaceId, input)
    } catch (error) {
      get().reportError(error)
      throw error
    }
    // FileExplorer refreshes its own tree after this resolves, but it is not the only reader: the
    // Topics panel and the Board invalidate on this counter alone. Bumping here rather than relying
    // on "FileExplorer is the sole caller" — that reason expires the moment something else calls it.
    set((current) => ({
      workspaceFileRevisions: bumpWorkspaceFileRevision(current.workspaceFileRevisions, workspaceId)
    }))
    await get().invalidateScratchTopicPaths(workspaceId, [input.path], true)
    return workspaceId
  },
  async refreshNoteDirectorySources(tabId, regionId) {
    const captured = get(), surface = fileSurface(captured.tabs[tabId], regionId)
    if (!surface || !surface.path.endsWith(NOTE_FILE_EXTENSION)) return undefined
    const resource = captured.config?.workspaces.find(workspace => workspace.id === surface.workspaceId)
    if (!resource) return undefined
    const key = noteDirectorySourceKey(resource.id, surface.path), directory = surface.path.slice(0, Math.max(0, surface.path.lastIndexOf('/')))
    const previous = captured.noteDirectorySources[key]
    let read: NoteDirectoryRead = { workspaceId: resource.id, hostId: resource.hostId, workspacePath: resource.path, directory,
      fileRevision: captured.workspaceFileRevisions[resource.id] ?? 0, status: 'reading',
      paths: previous?.hostId === resource.hostId && previous.workspacePath === resource.path ? previous.paths : [] }
    const resourceCurrent = () => {
      const current = get().config?.workspaces.find(workspace => workspace.id === resource.id)
      return current?.hostId === resource.hostId && current.path === resource.path
    }
    const publish = () => set(state => ({ noteDirectorySources: { ...state.noteDirectorySources, [key]: read } }))
    publish()
    try {
      if (!resourceCurrent()) throw new Error('The original Note directory resource is unconfirmed; no replacement directory was read.')
      const entries = await api.files.readDirectory(resource.id, directory)
      if (!resourceCurrent()) throw new Error('The Note directory resource changed while reading. Its original paths and content are retained.')
      if (get().noteDirectorySources[key] !== read) return get().noteDirectorySources[key]
      read = { ...read, paths: [...new Set(entries.filter(entry => !entry.isDirectory && entry.path.endsWith(NOTE_FILE_EXTENSION)).map(entry => entry.path))] }; publish()
      // Existing File Regions alone grant a content read. Closed sources remain explicit unread facts.
      for (const path of read.paths) {
        if (!resourceCurrent()) throw new Error('The original Note directory resource changed; no further source was read.')
        if (!Object.values(get().tabs).some(tab => workbenchSurfaces(tab).some(candidate => candidate.kind === 'file' && candidate.workspaceId === resource.id && candidate.path === path))) continue
        await loadPersistedFileDocument(resource.id, path, resource)
        if (!resourceCurrent()) throw new Error('The Note source resource changed while reading. No replacement directory or content was attached.')
        if (get().noteDirectorySources[key] !== read) return get().noteDirectorySources[key]
      }
      read = { ...read, status: 'listed' }; publish(); return read
    } catch (error) {
      if (get().noteDirectorySources[key] !== read) return get().noteDirectorySources[key]
      read = { ...read, status: 'unknown', issue: presentError(error) }; publish(); return read
    }
  },
  async createNote(tabGroupId, launcher, initialContent, projection, retryIntentId, notebook) {
    const captured = get(), openingIntent = fileOpenIntentVersion, openingSelection = fileNavigationSelection(captured)
    let navigationChanged = false
    const stopWatching = useAppStore.subscribe(state => { if (fileNavigationSelection(state) !== openingSelection) navigationChanged = true })
    try {
    const tab = launcher ? captured.tabs[launcher.tabId] : undefined
    const launcherSurface = launcher ? tab?.regions[launcher.regionId] : undefined
    if (launcher && launcherSurface?.kind !== 'launcher') throw new Error('Launcher Region is no longer available')
    const workspaceId = resolveLauncherWorkspaceId({ launcherWorkspaceId: launcherSurface?.kind === 'launcher' ? launcherSurface.workspaceId : undefined, launcherTabWorkspaceId: tab?.workspaceId, activeWorkspaceId: captured.activeWorkspaceId })
    if (!workspaceId) throw new Error('Select a resource Workspace first')
    const groupId = tabGroupId ?? captured.layouts[workspaceId]?.activeGroupId
    if (!groupId) throw new Error('Select an exact Note display Group first')
    const launcherId = warmLauncherId({ tabGroupId: groupId, regionId: launcher?.regionId })
    const previous = useLauncherState.getState().drafts[launcherId]?.noteCreation
    const retrying = previous?.status === 'error' && previous.intentId === retryIntentId
    if (previous && !previous.revealed && !retrying) return previous
    if (retrying && (workspaceId !== previous.target.workspaceId || !noteCreationResourceMatches(captured.config, previous.target))) {
      const retained = { ...previous, issue: 'The original Note resource is unconfirmed. Restore that Workspace, Host and directory before retrying this same intent.' }
      useLauncherState.getState().setNoteCreation(launcherId, retained)
      return retained
    }
    const originalResource = captured.config?.workspaces.find(item => item.id === workspaceId)
    if (!originalResource) throw new Error('The Note resource Workspace is unavailable.')
    const notebookContext = notebook ?? { notebookId: projection?.presentationId === 'recall-workbench' && captured.mainSurface === 'recall' && captured.recallNotebookId
      ? captured.recallNotebookId : DEFAULT_NOTEBOOK_ID }
    const noteId = retrying ? previous.noteId : mintObjectId(), blockId = retrying ? previous.blockIds[0]! : mintObjectId(), draft = retrying ? previous.draft : initialContent ?? ''
    let receipt: NoteCreationReceipt = { intentId: retrying ? previous.intentId : mintObjectId(), createdAt: retrying ? previous.createdAt : Date.now(), noteId, blockIds: [blockId], draft, path: '', status: 'pending', revealed: false,
      ...(launcher ? { launcher } : {}),
      notebook: retrying && previous.notebook ? previous.notebook : notebookContext,
      target: { workspaceId, hostId: originalResource.hostId, workspacePath: originalResource.path, directoryPath: null, relativeDirectory: null, zoneId: tab?.space?.zoneId ?? null,
        sourceSpaceId: tab?.space?.spaceId ?? null, displayWorkspaceId: noteCreationDisplayWorkspace(captured, { workspaceId, groupId, ...(projection ? { displayWorkspaceId: projection.displayWorkspaceId } : {}), ...(launcher ? { launcher } : {}) }), groupId },
      ...(projection && launcher ? { presentation: { presentationId: projection.presentationId, entity: projection.entity,
        reference: { displayWorkspaceId: projection.displayWorkspaceId, groupId, tabId: launcher.tabId, regionId: launcher.regionId } } } : {}) }
    const publish = () => useLauncherState.getState().setNoteCreation(launcherId, receipt)
    publish()
    let topics: ScratchTopicSnapshot[] = []
    try { if (captured.config?.workspaces.some(item => item.id === SCRATCH_WORKSPACE_ID)) topics = await api.scratch.listTopics(SCRATCH_WORKSPACE_ID) } catch { /* The original birth context remains authoritative; missing discovery cannot choose another directory. */ }
    try {
      if ((captured.mainSurface === 'survey' || captured.mainSurface === 'recall') && !projection) throw new Error('The Note Survey presentation is unconfirmed. Its draft and original target are retained.')
      if (projection && (!receipt.presentation || !projection.selection.some(reference => sameWorkbenchProjectionSelection(reference, receipt.presentation!.reference)) ||
        !projection.catalog.locations.some(location => workbenchProjectionMatches(projection, location) && location.displayWorkspaceId === projection.displayWorkspaceId && location.groupId === groupId && location.tabId === launcher?.tabId && location.regionId === launcher.regionId))) throw new Error('The exact Note presentation reference is unconfirmed. Its original draft is retained.')
      receipt = { ...receipt, target: noteCreationTarget(captured, topics, { workspaceId, groupId, ...(projection ? { displayWorkspaceId: projection.displayWorkspaceId } : {}), ...(launcher ? { launcher } : {}) }) }
      if (retrying && previous.target.zoneId && (receipt.target.zoneId !== previous.target.zoneId || previous.target.directoryPath !== null && receipt.target.directoryPath !== previous.target.directoryPath)) throw new Error('The original Note Zone resource is unconfirmed. Its saved target and draft are retained.')
      const currentResource = get().config?.workspaces.find(item => item.id === workspaceId)
      if (!currentResource || currentResource.hostId !== originalResource.hostId || currentResource.path !== originalResource.path) throw new Error('The Note resource changed before creation. The original draft is retained.')
    } catch (error) { receipt = { ...receipt, ...(retrying ? { target: previous.target, path: previous.path } : {}), status: 'error', issue: presentError(error) }; publish(); return receipt }
    const target = receipt.target
    if (captured.mainSurface === 'survey' && projection?.presentationId === 'survey-workbench' &&
      projection.entity.kind === 'zone' && projection.entity.zoneId === target.zoneId && target.zoneId) {
      get().setSurveyZoneCollected(target.zoneId, true)
    }
    const content = serializeNoteDocument(newNoteDocument(draft, noteId, blockId, noteCreationTitle(draft)))
    publish()
    const named = await createNoteWithAvailableName(new Date(receipt.createdAt), async name => {
      if (!noteCreationResourceMatches(get().config, target)) return { status: 'error', code: 'NOTE_RESOURCE_CHANGED', message: 'The original Note resource is no longer confirmed. Its draft and target are retained; no further write was issued.' }
      const path = target.relativeDirectory ? `${target.relativeDirectory}/${name}` : name
      receipt = { ...receipt, path }; publish()
      return await api.files.write(workspaceId, { path, content, expectedRevision: null })
    })
    receipt = { ...receipt, status: named.result.status, write: named.result, ...(named.result.status === 'written' ? {} : { issue: named.result.message }) }; publish()
    if (named.result.status !== 'written') return receipt
    receipt = await registerCreatedNote(receipt); publish()
    set(current => ({ workspaceFileRevisions: bumpWorkspaceFileRevision(current.workspaceFileRevisions, workspaceId) }))
    // Creation belongs to the captured request; a later navigation never grants it a new reveal intent.
    if (navigationChanged || fileOpenIntentVersion !== openingIntent || fileNavigationSelection(get()) !== openingSelection) { receipt = { ...receipt, issue: 'The Note was created. Open the same file when ready; later navigation was preserved.' }; publish(); return receipt }
    if (!noteCreationResourceMatches(get().config, target)) { receipt = { ...receipt, issue: 'The Note was written to its captured resource, but the current resource is different. Restore that resource to check or open the same Note.' }; publish(); return receipt }
    const placement = noteFilePlacement(target, projection, receipt.launcher)
    if (!placement) { receipt = { ...receipt, issue: 'The exact Note display reference is unconfirmed. Its original file and draft are retained.' }; publish(); return receipt }
    try {
      receipt = { ...receipt, revealed: await get().openFile(receipt.path, target.groupId, undefined, target.workspaceId, undefined,
        placement) }
      if (!receipt.revealed) receipt = { ...receipt, issue: 'The Note was created but could not be displayed. Open this same file; do not create another.' }
    } catch (error) { receipt = { ...receipt, issue: presentError(error) } }
    publish(); return receipt
    } finally { stopWatching() }
  },
  async revealCreatedNote(launcherId, projection) {
    const retained = useLauncherState.getState().drafts[launcherId]?.noteCreation
    if (!retained || !retained.path || retained.status === 'error') return retained
    let receipt: NoteCreationReceipt = retained
    const publish = () => useLauncherState.getState().setNoteCreation(launcherId, receipt!)
    const target = receipt.target
    const selected = fileNavigationSelection(get()), openingIntent = fileOpenIntentVersion
    if (receipt.presentation && (!projection || projection.presentationId !== receipt.presentation.presentationId || JSON.stringify(projection.entity) !== JSON.stringify(receipt.presentation.entity) || projection.displayWorkspaceId !== target.displayWorkspaceId)) {
      receipt = { ...receipt, issue: 'Open the same Note from its original presentation. Its captured file and draft are retained.' }; publish(); return receipt
    }
    const resourceCurrent = () => noteCreationResourceMatches(get().config, target)
    if (!resourceCurrent()) { receipt = { ...receipt, issue: 'The original Note resource is unconfirmed. Restore its captured Host and directory before checking this same file; no new target was read or written.' }; publish(); return receipt }
    if (receipt.status === 'unknown' || receipt.status === 'pending') {
      receipt = { ...receipt, status: 'unknown' }; publish()
      try {
        const observed = await api.files.read(receipt.target.workspaceId, receipt.path)
        if (!resourceCurrent()) { receipt = { ...receipt, issue: 'The Note resource changed while checking. Its original target and draft are retained; the new directory was not opened.' }; publish(); return receipt }
        const parsed = observed.status === 'read' ? readNoteDocument(observed.document.content) : undefined
        if (observed.status !== 'read' || parsed?.status !== 'valid' || parsed.note.noteId !== receipt.noteId) {
          receipt = { ...receipt, issue: 'The same Note target could not be confirmed. Its identity and draft remain retained; no write was repeated.' }; publish(); return receipt
        }
        receipt = { ...receipt, status: 'written', write: { status: 'written', revision: observed.document.revision }, issue: undefined }; publish()
      } catch (error) { receipt = { ...receipt, issue: presentError(error) }; publish(); return receipt }
    }
    if (fileOpenIntentVersion !== openingIntent || fileNavigationSelection(get()) !== selected) {
      receipt = { ...receipt, issue: 'The same Note was checked. Later navigation was preserved; choose this file when ready.' }; publish(); return receipt
    }
    receipt = await registerCreatedNote(receipt); publish()
    const placement = noteFilePlacement(target, projection, receipt.launcher)
    if (!resourceCurrent() || !placement) { receipt = { ...receipt, issue: 'The exact Note resource or display reference is unconfirmed. Its original file and draft are retained.' }; publish(); return receipt }
    try {
      receipt = { ...receipt, revealed: await get().openFile(receipt.path, target.groupId, undefined, target.workspaceId, undefined,
        placement) }
      receipt = { ...receipt, issue: receipt.revealed ? undefined : 'The Note exists but its display target is unavailable. Its original file and draft are retained.' }
    } catch (error) { receipt = { ...receipt, issue: presentError(error) } }
    publish(); return receipt
  },
  async retryCreatedNote(launcherId, projection) {
    const receipt = useLauncherState.getState().drafts[launcherId]?.noteCreation
    if (receipt?.status !== 'error') return receipt
    return await get().createNote(receipt.target.groupId, receipt.launcher, receipt.draft, projection, receipt.intentId, receipt.notebook)
  },
  async renamePath(path, nextPath, requestedWorkspaceId) {
    const workspaceId = requestedWorkspaceId ?? get().activeWorkspaceId
    if (!workspaceId) throw new Error('Select a workspace first')
    return await withWorkspaceFileMutation(workspaceId, path, async () => {
      const stateBeforeMove = get()
      const collision = findFileRenameProjectionCollision(stateBeforeMove, workspaceId, path, nextPath)
      if (collision) {
        const error = Object.assign(
          new Error(`The destination is already open in the workbench: ${collision.path}`),
          { code: 'WORKSPACE_MOVE_RENDERER_DESTINATION_OWNED' }
        )
        get().reportError(error)
        throw error
      }
      const observedPaths = Object.keys(stateBeforeMove.documents).flatMap((key) => {
        const prefix = `${workspaceId}\0`
        if (!key.startsWith(prefix)) return []
        const documentPath = key.slice(prefix.length)
        return isPathWithinSubtree(documentPath, path) ? [documentPath] : []
      })
      let originalLibrary = useNotebookLibrary.getState().state
      try { originalLibrary = await refreshNotebookLibrary() }
      catch (error) { get().reportError(error, { kind: 'process-degraded' }) }
      const resource = stateBeforeMove.config?.workspaces.find(item => item.id === workspaceId)
      const relocations = originalLibrary && resource ? notebookRelocations(originalLibrary, resource, path, nextPath) : []
      let result
      try {
        result = await api.files.move({
          source: { workspaceId, path },
          destination: { workspaceId, path: nextPath }
        })
      } catch (error) {
        get().reportError(error)
        throw error
      }
      if (result.status === 'error') {
        const error = Object.assign(new Error(result.message), {
          code: result.code,
          finalLocation: result.finalLocation
        })
        get().reportError(error)
        throw error
      }
      await get().invalidateScratchTopicPaths(workspaceId, [path, nextPath], true)
      for (const observedPath of observedPaths) {
        advanceDocumentLifetime(documentKey(workspaceId, observedPath))
      }
      set((state) => ({
        ...reduceFileRename(state, workspaceId, path, nextPath),
        // Same reason as `createPath`: the Topics panel and the Board read this counter and nothing
        // else. Moving a Topic's `topic.md` out breaks the Topic's identity, and only the file tree
        // would notice. Folded into the projection's own `set` so it is one render, not two.
        workspaceFileRevisions: bumpWorkspaceFileRevision(state.workspaceFileRevisions, workspaceId)
      }))
      for (const observedPath of observedPaths) {
        const renamedPath = remapPathWithinSubtree(observedPath, path, nextPath)
        transferFileSaveTail(workspaceId, observedPath, renamedPath)
        try {
          await api.files.unobserve(workspaceId, observedPath)
        } catch (error) {
          get().reportError(error)
        }
        try {
          await api.files.observe(workspaceId, renamedPath)
        } catch (error) {
          get().reportError(error)
        }
        try {
          await get().refreshDocument(workspaceId, renamedPath)
        } catch (error) {
          get().reportError(error)
        }
      }
      // The original File owner has confirmed success. A catalog failure never undoes or
      // blocks this healthy file; exact metadata intents survive in the original UI receipt.
      if (relocations.length) {
        try { await recordNotebookChanges(relocations, 'note-file-move:' + mintObjectId()) }
        catch (error) { get().reportError(error, { kind: 'process-degraded' }) }
      }
    })
  },
  async deletePath(path, requestedWorkspaceId) {
    const workspaceId = requestedWorkspaceId ?? get().activeWorkspaceId
    if (!workspaceId) throw new Error('Select a workspace first')
    return await withWorkspaceFileMutation(workspaceId, path, async () => {
      const observedPaths = Object.keys(get().documents).flatMap((key) => {
        const prefix = `${workspaceId}\0`
        if (!key.startsWith(prefix)) return []
        const documentPath = key.slice(prefix.length)
        return isPathWithinSubtree(documentPath, path) ? [documentPath] : []
      })
      try {
        await api.files.delete(workspaceId, path)
        for (const observedPath of observedPaths) {
          advanceDocumentLifetime(documentKey(workspaceId, observedPath))
        }
        set((state) => ({
          ...reduceFileDelete(state, workspaceId, path),
          // Deleting a Topic's directory is the only way to delete a Topic (there is no
          // `scratch.deleteTopic`, and the delete affordance is deliberately ungated for Topic
          // directories where rename and move are not). Without this the tree row vanishes —
          // `confirmDelete` refreshes it directly — while the Topics panel and the Board keep
          // showing the deleted Topic until an unrelated write happens to bump.
          workspaceFileRevisions: bumpWorkspaceFileRevision(state.workspaceFileRevisions, workspaceId)
        }))
        await get().invalidateScratchTopicPaths(workspaceId, [path], true)
        await Promise.all(observedPaths.map(async (observedPath) => {
          await api.files.unobserve(workspaceId, observedPath)
        }))
      } catch (error) {
        get().reportError(error)
        throw error
      }
    })
  },
  async adoptNoteCurrentDocument(tabId, regionId) {
    const state = get(), surface = fileSurface(state.tabs[tabId], regionId)
    if (!surface) return
    const key = documentKey(surface.workspaceId, surface.path), lifetime = documentLifetime(key), original = state.documents[key]
    if (!original?.noteEditing?.attempt) return
    const noteId = original.noteEditing.attempt.noteId
    const resource = watchNoteResource(surface.workspaceId, { hostId: original.noteEditing.attempt.resource.hostId, path: original.noteEditing.attempt.resource.workspacePath })
    try {
      await afterNoteComposition(key)
      const observed = await api.files.read(surface.workspaceId, surface.path)
      await afterNoteComposition(key)
      if (!resource.current() || documentLifetime(key) !== lifetime) throw Error('The original Note resource changed. Its request and draft are retained.')
      const header = observed.status === 'read' ? readNoteMarkdownHeader(observed.document.content) : undefined
      if (observed.status !== 'read' || observed.document.path !== surface.path || noteId !== null && (header?.status !== 'valid' || header.noteId !== noteId) || noteHistoryRevision(observed.document.content) !== observed.document.revision) throw Error('The current original Note could not be confirmed. Its request and draft are retained.')
      set(current => {
        const document = current.documents[key]
        if (document?.noteEditing?.attempt?.operationId !== original.noteEditing!.attempt!.operationId) return current
        const next = reduceDocumentReloaded(current, surface.workspaceId, surface.path, observed.document)
        return { ...next, retainedDocumentDrafts: { ...next.retainedDocumentDrafts, [key]: [...current.retainedDocumentDrafts[key] ?? [], document] },
          savingDocuments: { ...current.savingDocuments, [key]: false } }
      })
    } finally { resource.release() }
  },
  retainNoteEditorDraft(tabId, regionId, displayed, incoming, expected, action) {
    set(state => {
      const surface = fileSurface(state.tabs[tabId], regionId)
      if (!surface) return state
      const key = documentKey(surface.workspaceId, surface.path), document = state.documents[key]
      const resource = state.config?.workspaces.find(item => item.id === surface.workspaceId)
      if (!document || document.content !== incoming || displayed === incoming || resource?.hostId !== expected.hostId || resource.path !== expected.path) return state
      const shown = readNoteMarkdownHeader(displayed), target = readNoteMarkdownHeader(incoming)
      if (shown.status !== 'valid' || target.status !== 'valid' || shown.noteId !== target.noteId) return state
      const drafts = state.retainedDocumentDrafts[key] ?? []
      const candidate: FileDocument = action === 'retain' ? { path: surface.path, content: displayed, revision: document.revision } : document
      const retained = drafts.some(draft => draft.content === candidate.content && draft.noteEditing?.attempt?.operationId === candidate.noteEditing?.attempt?.operationId && draft.noteEditing?.input === candidate.noteEditing?.input) ? drafts : [...drafts, candidate]
      const next = action === 'retain' ? state : reduceDocumentContent(state, tabId, displayed, regionId)
      return { ...next, ...(action === 'keep-displayed' && document.noteEditing?.input ? { documents: { ...next.documents, [key]: { ...next.documents[key]!, noteEditing: { ...next.documents[key]!.noteEditing, input: undefined } } } } : {}),
        retainedDocumentDrafts: { ...state.retainedDocumentDrafts, [key]: retained } }
    })
  },
  async retryNoteInput(tabId, regionId) {
    const surface = fileSurface(get().tabs[tabId], regionId)
    if (!surface) return
    const key = documentKey(surface.workspaceId, surface.path), input = get().documents[key]?.noteEditing?.input
    if (!input) return
    set(state => ({ documents: { ...state.documents, [key]: { ...state.documents[key]!, noteEditing: { ...state.documents[key]!.noteEditing, input: { ...input, phase: 'mapping' as const } } } } }))
    await drainNoteInput(surface.workspaceId, surface.path)
  },
  updateNoteDocument: updateNoteInput,
  observeNoteFile(target, occurrence, load = true) {
    const key = documentKey(target.workspaceId, target.path), release = retainFileDocument(key, occurrence)
    if (load) void get().loadNoteFile(target)
    return () => {
      release()
      const state = get()
      if (hasFileDocumentConsumer(key) || Object.values(state.tabs).some(tab => workbenchSurfaces(tab).some(surface => surface.kind === 'file' && documentKey(surface.workspaceId, surface.path) === key))) return
      // A retained dirty draft remains in the original document projection, but a
      // hidden draft does not need a live filesystem observer or its child process.
      void api.files.unobserve(target.workspaceId, target.path)
      if (state.dirtyDocuments[key] || state.documents[key]?.noteEditing?.share || state.documents[key]?.noteEditing?.shareUndo) return
      advanceDocumentLifetime(key)
      set(current => reconcileWorkbenchFileProjection(current, { tabs: current.tabs, layouts: current.layouts }))
    }
  },
  async loadNoteFile(target) {
    const key = documentKey(target.workspaceId, target.path)
    if (get().documents[key]) {
      const workspace = get().config?.workspaces.find(value => value.id === target.workspaceId), header = readNoteMarkdownHeader(get().documents[key]!.content)
      if (hasFileDocumentConsumer(key) && workspace?.hostId === target.hostId && workspace.path === target.workspacePath && header.status === 'valid' && header.noteId === target.noteId) await api.files.observe(target.workspaceId, target.path).catch(error => get().reportError(error))
      return
    }
    if (!get().documents[key]) {
      try {
        const confirmed = await api.notebooks.content(target.noteId)
        if (confirmed.status !== 'read' || confirmed.actualNoteId !== target.noteId || confirmed.resource.hostId !== target.hostId || confirmed.resource.workspaceId !== target.workspaceId || confirmed.resource.workspacePath !== target.workspacePath || confirmed.resource.path !== target.path) throw Error('The original Note file identity is not confirmed at this resource. Its reference is preserved; check its source.')
        if (hasFileDocumentConsumer(key)) await loadPersistedFileDocument(target.workspaceId, target.path, { hostId: target.hostId, path: target.workspacePath })
      } catch (error) { if (hasFileDocumentConsumer(key)) set(state => reduceDocumentLoadFailed(state, target.workspaceId, target.path, { kind: 'read-error', code: 'NOTE_SHARED_SOURCE_UNCONFIRMED', message: presentError(error) })) }
    }
  },
  updateNoteFile(target, content, before) {
    const current = get().config?.workspaces.find(workspace => workspace.id === target.workspaceId)
    const header = readNoteMarkdownHeader(get().documents[documentKey(target.workspaceId, target.path)]?.content ?? ''), proposed = readNoteMarkdownHeader(content)
    if (proposed.status !== 'valid' || proposed.noteId !== target.noteId || current?.hostId !== target.hostId || current.path !== target.workspacePath || header.status !== 'valid' || header.noteId !== target.noteId) { get().reportError(new Error('The original shared file changed. Your input is kept in this editor; check that same source.')); return }
    updateNoteFileInput(target, content, before)
  },
  async saveNoteFile(target) {
    await enqueueFileSave('', false, undefined, target)
    const key = documentKey(target.workspaceId, target.path), state = get()
    if (!hasFileDocumentConsumer(key) && !state.dirtyDocuments[key] && !state.documents[key]?.noteEditing?.share && !state.documents[key]?.noteEditing?.shareUndo && !Object.values(state.tabs).some(tab => workbenchSurfaces(tab).some(surface => surface.kind === 'file' && documentKey(surface.workspaceId, surface.path) === key))) {
      advanceDocumentLifetime(key)
      set(current => reconcileWorkbenchFileProjection(current, { tabs: current.tabs, layouts: current.layouts }))
    }
  },
  async inspectNoteShare(workspaceId, path) {
    const key = documentKey(workspaceId, path), attempt = originalNoteShareAttempt(key)
    if (attempt) {
      try {
        const inspected = await api.files.inspectSharePublic({ mode: 'request', request: attempt.params })
        if (inspected.mode === 'request') await applyNoteShareResult(key, attempt, parseFileShareResult(inspected.result, attempt.params))
      } catch (error) { await applyNoteShareResult(key, attempt, unconfirmedNoteShare(attempt.params, error)) }
    }
  },
  async continueNoteShare(workspaceId, path) {
    const key = documentKey(workspaceId, path), attempt = originalNoteShareAttempt(key)
    if (!attempt) return
    try {
      const inspected = await api.files.inspectSharePublic({ mode: 'request', request: attempt.params })
      if (inspected.mode !== 'request') return
      const result = parseFileShareResult(inspected.result, attempt.params)
      await applyNoteShareResult(key, attempt, result)
      if (result.status === 'committed' || result.status === 'partial') return
      // This explicit user action keeps the original operation and payload. The original owner
      // checks each durable phase before it can continue; an unknown write is never replayed here.
      await applyNoteShareResult(key, attempt, parseFileShareResult(await api.files.sharePublic(attempt.params), attempt.params))
    } catch (error) { await applyNoteShareResult(key, attempt, unconfirmedNoteShare(attempt.params, error)) }
  },
  async inspectNoteShareUndo(workspaceId, path) {
    const key = documentKey(workspaceId, path), original = get().documents[key]?.noteEditing?.shareUndo
    if (!original) return
    try {
      const inspected = await api.files.inspectSharePublic({ mode: 'undo', request: original.params })
      if (inspected.mode === 'undo') await applyNoteShareUndoResult(key, original.params, parseFileShareUndoResult(inspected.result, original.params))
    } catch (error) { await applyNoteShareUndoResult(key, original.params, unconfirmedNoteShareUndo(original.params, error)) }
  },
  async continueNoteShareUndo(workspaceId, path) {
    const key = documentKey(workspaceId, path), original = get().documents[key]?.noteEditing?.shareUndo
    if (!original) return
    try {
      const inspected = await api.files.inspectSharePublic({ mode: 'undo', request: original.params })
      if (inspected.mode !== 'undo') return
      const result = parseFileShareUndoResult(inspected.result, original.params)
      await applyNoteShareUndoResult(key, original.params, result)
      if (result.status === 'committed' || result.status === 'partial') return
      await applyNoteShareUndoResult(key, original.params, parseFileShareUndoResult(await api.files.shareUndoPublic(original.params), original.params))
    } catch (error) { await applyNoteShareUndoResult(key, original.params, unconfirmedNoteShareUndo(original.params, error)) }
  },
  updateDocument(tabId, content, regionId) {
    set(state => {
      const next = reduceDocumentContent(state, tabId, content, regionId), surface = fileSurface(state.tabs[tabId], regionId)
      if (!surface) return next
      const key = documentKey(surface.workspaceId, surface.path), previous = state.documents[key]
      if (!previous?.noteEditing?.input || previous.content === content) return next
      return { ...next, documents: { ...next.documents, [key]: { ...next.documents[key]!, noteEditing: { ...next.documents[key]!.noteEditing, input: undefined } } },
        retainedDocumentDrafts: { ...state.retainedDocumentDrafts, [key]: [...state.retainedDocumentDrafts[key] ?? [], previous] } }
    })
  },
  async saveDocument(tabId, regionId) {
    await enqueueFileSave(tabId, false, regionId)
  },
  async overwriteDocument(tabId, regionId) {
    await enqueueFileSave(tabId, true, regionId)
  },
  useRetainedDocumentDraft(tabId, regionId, requested) {
    // Read both buffers at the user's click, so a later edit is kept rather than overwritten.
    set(state => {
      const surface = fileSurface(state.tabs[tabId], regionId)
      if (!surface) return state
      const key = documentKey(surface.workspaceId, surface.path)
      const document = state.documents[key], drafts = state.retainedDocumentDrafts[key]
      if (!document || !drafts?.length) return state
      const index = requested ? drafts.indexOf(requested) : 0
      if (index < 0) return state
      const selected = drafts[index]!
      // The chosen body becomes current, while its original request remains a retained fact.
      const hasOriginalRequest = selected.noteEditing?.attempt || selected.noteEditing?.input || selected.noteEditing?.share || selected.noteEditing?.shareUndo
      const remaining = hasOriginalRequest ? drafts : drafts.filter((_draft, position) => position !== index)
      return { documents: { ...state.documents, [key]: { ...document, content: selected!.content,
        ...(document.noteEditing ? { noteEditing: { ...document.noteEditing, input: undefined } } : {}),
        ...(selected!.noteConversion ? { noteConversion: selected!.noteConversion } : {}) } },
        retainedDocumentDrafts: { ...state.retainedDocumentDrafts, [key]: [...remaining, document] },
        dirtyDocuments: { ...state.dirtyDocuments, [key]: true },
        documentGenerations: { ...state.documentGenerations, [key]: (state.documentGenerations[key] ?? 0) + 1 } }
    })
  },
  async reloadDocument(tabId, regionId) {
    const surface = fileSurface(get().tabs[tabId], regionId)
    if (!surface) return
    const key = documentKey(surface.workspaceId, surface.path)
    const issue = get().documentIssues[key]
    if (issue?.kind === 'changed' && get().documents[key]?.noteEditing?.input?.phase === 'conflict') {
      const lifetime = documentLifetime(key)
      await afterNoteComposition(key)
      if (documentLifetime(key) !== lifetime || get().documentIssues[key] !== issue) return
      set(state => {
        const document = state.documents[key]!, baseline = document.noteEditing?.baseline, issues = { ...state.documentIssues }
        delete issues[key]
        return { documents: { ...state.documents, [key]: { ...document, content: issue.observed.content,
          noteEditing: { ...document.noteEditing, input: undefined } } },
          dirtyDocuments: { ...state.dirtyDocuments, [key]: baseline?.content !== issue.observed.content },
          retainedDocumentDrafts: { ...state.retainedDocumentDrafts, [key]: [...state.retainedDocumentDrafts[key] ?? [], document] },
          documentGenerations: { ...state.documentGenerations, [key]: (state.documentGenerations[key] ?? 0) + 1 }, documentIssues: issues }
      })
      await refreshFileDocument(surface.workspaceId, surface.path, lifetime)
      return
    }
    if (issue?.kind === 'write-unknown' || get().documents[key]?.noteEditing?.attempt) {
      if (get().savingDocuments[key]) return
      const checkedLifetime = documentLifetime(key)
      set(state => reduceDocumentSaving(state, surface.workspaceId, surface.path, true))
      try { await refreshFileDocument(surface.workspaceId, surface.path) }
      finally { if (documentLifetime(key) === checkedLifetime && get().documents[key]) set(state => reduceDocumentSaving(state, surface.workspaceId, surface.path, false)) }
      return
    }
    if (!get().documents[key] && (issue?.kind === 'binary' || issue?.kind === 'read-error')) {
      // Re-read the same existing File owner; changing format must not require closing its Tab.
      advanceDocumentLifetime(key)
      set(state => {
        const issues = { ...state.documentIssues }
        delete issues[key]
        return { documentIssues: issues }
      })
      await loadPersistedFileDocument(surface.workspaceId, surface.path)
      return
    }
    if (issue?.kind === 'changed') {
      set(state => {
        const next = reduceDocumentReloaded(state, surface.workspaceId, surface.path, issue.observed)
        if (!issue.noteMerge?.observedIsDraft) return next
        const previous = state.documents[key]!, baseline = previous.noteEditing?.baseline
        return { ...next, documents: { ...next.documents, [key]: { ...next.documents[key]!,
          ...(baseline ? { noteEditing: { baseline, ...(previous.noteEditing?.receipt ? { receipt: previous.noteEditing.receipt } : {}) } } : {}) } },
          dirtyDocuments: { ...next.dirtyDocuments, [key]: true } }
      })
      return
    }
    if (issue?.kind === 'deleted') {
      advanceDocumentLifetime(key)
      set((state) => reduceFileDelete(state, surface.workspaceId, surface.path))
      await api.files.unobserve(surface.workspaceId, surface.path)
      return
    }
    await get().refreshDocument(surface.workspaceId, surface.path)
  },
  async refreshDocument(workspaceId, path) {
    await refreshFileDocument(workspaceId, path)
  },
  inspectNoteHistory: (tabId, regionId, noteId) => readNoteHistoryTarget(tabId, regionId, noteId, true),
  applyNoteHistory: enqueueNoteHistoryAction,
  async launchBoardAgent(workspaceId, executorId, prompt, topicId) {
    await get().selectWorkspace(workspaceId)
    set({ mainSurface: 'board' })
    // Topic 行的 Inbox 带 Topic 上下文起 Agent。绑定不在这里重造：`openScratchTopic` 已经是
    // 「找到或新建一个绑到该 Topic 的 View」的唯一路径，走它一遍，新 Agent 的 workspacePath 与
    // scratchTopicId 就与从 Topic 面板起的完全一致——Board 不是第二条 Topic 绑定路径。
    if (topicId) await get().openScratchTopic(topicId, undefined, { reveal: false })
    const layout = get().layouts[workspaceId]
    if (!layout) throw new Error('Workspace layout is unavailable')
    const group = findGroup(layout, layout.activeGroupId)
    const boundTab = topicId && group?.activeTabId ? get().tabs[group.activeTabId] : undefined
    if (topicId && boundTab?.topicId !== topicId) {
      throw new Error('Scratch Topic View is unavailable')
    }
    const launcher = boundTab &&
      boundTab.regions[boundTab.layout.activeRegionId]?.kind === 'launcher'
      ? { tabId: boundTab.id, regionId: boundTab.layout.activeRegionId }
      : undefined
    await get().launchAgent(executorId, prompt, layout.activeGroupId, launcher)
  },
  async launchAgent(executorId, prompt, tabGroupId, launcher, launchOptions, names, agentMuxNote, pmo) {
    const state = get()
    const launcherTab = launcher ? state.tabs[launcher.tabId] : undefined
    const launcherSurface = launcherTab && launcher
      ? launcherTab.regions[launcher.regionId]
      : undefined
    if (launcher && launcherSurface?.kind !== 'launcher') {
      throw new Error('Launcher Region is no longer available')
    }
    const workspaceId = resolveLauncherWorkspaceId({
      launcherWorkspaceId: launcherSurface?.kind === 'launcher' ? launcherSurface.workspaceId : undefined,
      launcherTabWorkspaceId: launcherTab?.workspaceId,
      activeWorkspaceId: state.activeWorkspaceId
    })
    const workspace = state.config?.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error('Select a workspace first')
    const displayWorkspaceId = launcherTab ? workbenchTabDisplayWorkspaceId(state.layouts, launcherTab.id, tabGroupId) : workspace.id
    const layout = displayWorkspaceId ? state.layouts[displayWorkspaceId] : undefined
    if (!layout || !groupIds(layout.root).includes(tabGroupId) || !findGroup(layout, tabGroupId) || launcherTab && !findGroup(layout, tabGroupId)!.tabOrder.includes(launcherTab.id)) throw new Error('The exact Agent display position is unavailable')
    const inheritedTopicId = launcherTab
      ? undefined
      : inheritedTopicIdForNewTab(workspace.id, layout, state.tabs, tabGroupId)
    const targetTab = launcherTab ?? newLauncherTab(workspace.id, inheritedTopicId)
    const tabId = targetTab.id
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, tabId)) throw new Error('The View is closing')
    // The target Topic is the View's explicit binding. An unbound View launches with no Topic;
    // we never fabricate one from the Tab identity (a Tab id is not a Topic).
    const scratchTopicId = isScratchWorkspaceId(workspace.id)
      ? targetTab.topicId
      : undefined
    if (scratchTopicId && !isScratchTopicId(scratchTopicId)) {
      throw new Error('Scratch Agent View has an invalid Topic identity')
    }
    const regionId = launcher?.regionId ?? targetTab.layout.activeRegionId
    // Capture the exact unsent inputs used by this request. Contextual launches can use the
    // same Region without consuming its other draft; late replies cannot clear newer edits.
    const originalPrompt = state.agentComposerDrafts[regionId]
    const submittedPrompt = originalPrompt !== undefined &&
      (originalPrompt === prompt || expandSemanticReferences(originalPrompt) === prompt) ? originalPrompt : undefined
    const requestedNames = { agentName: names?.agentName?.trim() || undefined, tabName: names?.tabName?.trim() || undefined }
    const requestedTabNameRevision = currentDisplayNameRevision('tab', tabId)
    const originalNames = state.launcherNameDrafts[regionId]
    const submittedNames = originalNames &&
      (originalNames.agentName.trim() || undefined) === requestedNames.agentName &&
      (originalNames.tabName.trim() || undefined) === requestedNames.tabName ? originalNames : undefined
    const executor = executorsForHost(state.config, workspace.hostId, state.executorDetections, state.hostExecutorInventories[workspace.hostId]).find(item => item.id === executorId)
    const providerId = executor?.providerId
    const originalOptions = providerId ? state.launcherOptionDrafts[regionId]?.[providerId] : undefined
    const submittedOptions = originalOptions && launchOptions && shallow(originalOptions, launchOptions) ? originalOptions : undefined
    const launchNote = agentMuxNote ?? state.agentComposerNotes[regionId]
    const createOperationId = pmo?.intent.creationOperationId === undefined ? mintObjectId() : await goalPmoOperation(pmo.intent, 'create')
    const sessionId = pmo?.intent.creationOperationId === undefined ? mintObjectId() : await api.sessions.resolveCreationSessionId(workspace.hostId, createOperationId)
    const live = get(), liveTargetTab = launcher ? live.tabs[tabId] : targetTab
    const liveLayout = live.layouts[displayWorkspaceId!]
    if (pmo && (!liveTargetTab || launcher && liveTargetTab.regions[regionId] !== launcherSurface ||
      !liveLayout || !findGroup(liveLayout, tabGroupId) || launcher && !findGroup(liveLayout, tabGroupId)!.tabOrder.includes(tabId) ||
      !workbenchViewCloseAllowsView(live.closingWorkbenchViews, tabId))) {
      throw new Error('The original PMO display position changed before creation. The Goal and original request are kept.')
    }
    const priorFailure = lifecycleNotification(state.notificationEvents, { regionId })
    const pendingSurface: AgentWorkbenchSurface = {
      regionId,
      kind: 'agent',
      phase: 'launching',
      workspaceId: workspace.id,
      sessionId
    }
    const replacedTab = replaceWorkbenchRegion(pmo ? liveTargetTab! : targetTab, regionId, pendingSurface)
    const pendingTab = scratchTopicId ? { ...replacedTab, topicId: scratchTopicId } : replacedTab
    // 没有 launcher 归属时这条 Tab 是新建的，必须真的挂进某个分组。挂不上就抛：原先用 addTab
    // 的静默回落，Tab 记录进了 state.tabs 而不在任何 tabOrder 里——永不显示、永不可关，且用户
    // 点了「启动」看不到任何反馈（实测抛出的是 null，多出一条孤儿记录）。
    const nextLayout = launcher ? pmo ? liveLayout! : layout : addTabOrThrow(pmo ? liveLayout! : layout, tabGroupId, tabId)
    set((current) => ({
      tabs: { ...current.tabs, [tabId]: pendingTab },
      layouts: {
        ...current.layouts,
        [displayWorkspaceId!]: nextLayout
      },
      pendingAgentLaunches: {
        ...current.pendingAgentLaunches,
        [sessionId]: { events: [], overflowed: false, request: { executorId, hostId: workspace.hostId, workspacePath: workspace.path, createOperationId, prompt,
          ...(launchNote === undefined ? {} : { agentMuxNote: launchNote }), ...(pmo ? { goalPmo: pmo.intent } : {}) } }
      }
    }))
    let dispatchStarted = false
    let creationObserved = false
    try {
      if (scratchTopicId && targetTab.topicPreparation === 'mote') {
        await api.scratch.ensureMote(workspace.id, scratchTopicId)
        if (!ownsSessionLaunch(findWorkbenchRegion(get().tabs, regionId)?.surface, 'agent', sessionId)) {
          set(current => discardPendingAgentLaunch(current, sessionId))
          return
        }
        set(current => {
          const tab = current.tabs[tabId]
          if (tab?.topicId !== scratchTopicId || !ownsSessionLaunch(tab.regions[regionId], 'agent', sessionId) || !tab.topicPreparation) return current
          const { topicPreparation: _prepared, ...preparedTab } = tab
          return { tabs: { ...current.tabs, [tab.id]: preparedTab }, workspaceFileRevisions: bumpWorkspaceFileRevision(current.workspaceFileRevisions, workspace.id) }
        })
      }
      dispatchStarted = true
      const launched = await api.sessions.launchAgent({
        executorId,
        ...(executor?.executorRevision ? { executorRevision: executor.executorRevision } : {}),
        hostId: workspace.hostId,
        workspacePath: workspace.path,
        ...(scratchTopicId ? { scratchTopicId } : {}),
        ...(launchOptions && Object.keys(launchOptions).length > 0 ? { launchOptions } : {}),
        prompt,
        ...(launchNote === undefined ? {} : { agentMuxNote: launchNote }),
        agentSessionId: sessionId,
        createOperationId
      }, pmo?.intent)
      creationObserved = true
      if (launched.created.agentSessionId !== sessionId) {
        let timelineGapSessionId: string | undefined
        set((current) => {
          const reduced = reduceDetachedAgentLaunch(current, launched)
          timelineGapSessionId = reduced.timelineGapSessionId
          return reduced.state
        })
        if (timelineGapSessionId) void get().resyncTimeline(timelineGapSessionId)
        throw Object.assign(new Error('Core returned a different Session. Its healthy Run is retained; inspect the creation operation before any retry.'), {
          code: 'AGENT_LAUNCH_IDENTITY_MISMATCH'
        })
      }
      pmo?.onCreated(launched)
      if (pmo) await get().refreshDemand(pmo.intent.goalId)
      const canonical = await get().canonicalizeAgentLaunch(launched)
      const result = canonical ?? launched
      const launchOwner = findWorkbenchRegion(get().tabs, regionId)
      if (!canonical || !ownsSessionLaunch(launchOwner?.surface, 'agent', sessionId) ||
        (launchOwner && !workbenchViewCloseAllowsView(get().closingWorkbenchViews, launchOwner.tab.id))) {
        // Display disappearance is observation loss. Explicit close plans retain their original owner.
        let timelineGapSessionId: string | undefined
        set((current) => {
          const reduced = reduceDetachedAgentLaunch(current, result)
          timelineGapSessionId = reduced.timelineGapSessionId
          return reduced.state
        })
        if (timelineGapSessionId) void get().resyncTimeline(timelineGapSessionId)
        throw Object.assign(new Error('The Agent was created, but its requested display is no longer observed. Its healthy Run is retained; inspect the creation operation.'), {
          code: 'CONTROL_OWNER_LOST'
        })
      }
      let timelineGapSessionId: string | undefined
      set((current) => {
        const reduced = reduceAgentSessionLaunchAttached(current, regionId, result)
        timelineGapSessionId = reduced.timelineGapSessionId
        return scratchTopicId
          ? {
              ...reduced.state,
              workspaceFileRevisions: bumpWorkspaceFileRevision(
                current.workspaceFileRevisions,
                workspace.id
              )
            }
          : reduced.state
      })
      if (scratchTopicId) void get().refreshScratchTopics(workspace.id, true, scratchTopicId)
      // 只有启动成功、region 从 launcher 变成 agent 之后，才清掉这条 launcher 草稿——此刻它已失去归属。
      // 失败路径（下方 catch → reduceSessionLaunchFailed）绝不清：region 会翻回 launcher 且沿用同一个
      // regionId，草稿留在原地供用户直接重试。这正是用户报告"报错退回初始页、之前输入没缓存"要修的行为。
      if (submittedPrompt !== undefined) get().clearAgentComposerDraftIfUnchanged(regionId, submittedPrompt)
      set(current => {
        if (current.agentComposerNotes[regionId] !== launchNote) return current
        const agentComposerNotes = { ...current.agentComposerNotes }
        delete agentComposerNotes[regionId]
        return { agentComposerNotes }
      })
      // 名字草稿与 prompt 草稿同一时机、同一理由清掉：这个 region 已经从 launcher 变成 agent，
      // 那两格输入失去归属，留着会串到下一个新标签页。失败路径不清（region 翻回 launcher 且沿用
      // 同一 regionId），用户填的名字原地留着供直接重试。
      set((current) => {
        const patch: Partial<AppState> = {}
        if (submittedNames && current.launcherNameDrafts[regionId] === submittedNames) {
          const { [regionId]: _consumed, ...rest } = current.launcherNameDrafts
          patch.launcherNameDrafts = rest
        }
        if (providerId && submittedOptions && current.launcherOptionDrafts[regionId]?.[providerId] === submittedOptions) {
          const { [providerId]: _consumed, ...remainingProviders } = current.launcherOptionDrafts[regionId]!
          const options = { ...current.launcherOptionDrafts }
          if (Object.keys(remainingProviders).length) options[regionId] = remainingProviders
          else delete options[regionId]
          patch.launcherOptionDrafts = options
        }
        return Object.keys(patch).length ? patch : current
      })
      // 名字与草稿同一时机落地：Agent 已经挂上，两个 id 才真正指向一个存在的东西。失败路径不写，
      // 否则会留下一个指向已消失 session 的孤儿名字。留空即不写，显示名交还派生链。
      if (requestedNames.agentName) await commitDisplayName({ kind: 'agent-session', id: sessionId }, requestedNames.agentName, names?.nameSource ?? 'launch', 0)
        .catch(error => get().reportWorkbenchSaveFailure(error))
      if (requestedNames.tabName) await commitDisplayName({ kind: 'tab', id: tabId }, requestedNames.tabName, names?.nameSource ?? 'launch', requestedTabNameRevision)
        .catch(error => get().reportWorkbenchSaveFailure(error))
      if (timelineGapSessionId) void get().resyncTimeline(timelineGapSessionId)
      if (priorFailure && get().notificationEvents.includes(priorFailure)) {
        set(current => settleNotificationRecords(current, [priorFailure]))
      }
    } catch (error) {
      const ownerFailure = error as { controlFailure?: import('@agentmux/core').AgentMuxControlFailure } | null
      if (dispatchStarted && (creationObserved || ownerFailure?.controlFailure?.disposition !== 'not_applied')) {
        // A rejected invoke can arrive after start. Only a structured owner not_applied fact
        // permits a new-launch surface; accepted creation survives later display failures.
        const retained = Object.assign(new Error(`${presentError(error)} Original creation ${createOperationId}, Session ${sessionId}. Inspect this identity without starting or sending again.`),
          { code: (error as { code?: string } | null)?.code ?? 'AGENT_CREATION_UNCONFIRMED',
            agentSessionId: sessionId, createOperationId,
            controlFailure: ownerFailure?.controlFailure?.disposition === 'unknown' ? ownerFailure.controlFailure
              : { disposition: 'unknown' as const, confirmedInputBytes: null } })
        get().reportError(retained, { kind: 'indeterminate', lifecycle: { step: 'launch', regionId, tabId } })
        throw retained
      }
      if (!ownsSessionLaunch(findWorkbenchRegion(get().tabs, regionId)?.surface, 'agent', sessionId)) {
        set((current) => discardPendingAgentLaunch(current, sessionId))
        return
      }
      set((current) => reduceSessionLaunchFailed(current, regionId, 'agent', sessionId,
        launcherSurface?.kind === 'launcher' ? launcherSurface : undefined))
      get().reportError(error, { kind: 'indeterminate', lifecycle: { step: 'launch', regionId, tabId } })
      throw error
    }
  },
  async launchTerminal(tabGroupId, launcher, workspacePath) {
    const state = get()
    const launcherTab = launcher ? state.tabs[launcher.tabId] : undefined
    const launcherSurface = launcherTab && launcher
      ? launcherTab.regions[launcher.regionId]
      : undefined
    if (launcher && launcherSurface?.kind !== 'launcher') {
      throw new Error('Launcher Region is no longer available')
    }
    const workspaceId = resolveLauncherWorkspaceId({
      launcherWorkspaceId: launcherSurface?.kind === 'launcher' ? launcherSurface.workspaceId : undefined,
      launcherTabWorkspaceId: launcherTab?.workspaceId,
      activeWorkspaceId: state.activeWorkspaceId
    })
    const workspace = state.config?.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error('Select a workspace first')
    const displayWorkspaceId = launcherTab ? workbenchTabDisplayWorkspaceId(state.layouts, launcherTab.id, tabGroupId) : workspace.id
    const layout = displayWorkspaceId ? state.layouts[displayWorkspaceId] : undefined
    if (!layout || !groupIds(layout.root).includes(tabGroupId) || !findGroup(layout, tabGroupId) || launcherTab && !findGroup(layout, tabGroupId)!.tabOrder.includes(launcherTab.id)) throw new Error('The exact Terminal display position is unavailable')
    const inheritedTopicId = launcherTab
      ? undefined
      : inheritedTopicIdForNewTab(workspace.id, layout, state.tabs, tabGroupId)
    const targetTab = launcherTab ?? newLauncherTab(workspace.id, inheritedTopicId)
    const tabId = targetTab.id
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, tabId)) throw new Error('The View is closing')
    const regionId = launcher?.regionId ?? targetTab.layout.activeRegionId
    const sessionId = mintObjectId()
    const request: TerminalLaunchInput = {
      hostId: workspace.hostId,
      workspacePath: workspacePath ?? workspace.path,
      createOperationId: mintObjectId()
    }
    const pendingSurface: TerminalWorkbenchSurface = {
      regionId,
      kind: 'terminal',
      phase: 'launching',
      workspaceId: workspace.id,
      sessionId
    }
    const pendingTab = replaceWorkbenchRegion(targetTab, regionId, pendingSurface)
    // 与 launchAgent 同一条判定：新建 Tab 必须真的挂进某个分组，挂不上就抛。
    const nextLayout = launcher ? layout : addTabOrThrow(layout, tabGroupId, tabId)
    set((current) => ({
      tabs: { ...current.tabs, [tabId]: pendingTab },
      layouts: {
        ...current.layouts,
        [displayWorkspaceId!]: nextLayout
      }
    }))
    let creationObserved = false
    try {
      const session = await api.sessions.launchTerminal(request)
      creationObserved = true
      const launchOwner = findWorkbenchRegion(get().tabs, regionId)
      if (
        !ownsSessionLaunch(launchOwner?.surface, 'terminal', sessionId) ||
        (launchOwner && !workbenchViewCloseAllowsView(get().closingWorkbenchViews, launchOwner.tab.id))
      ) {
        // A closed/replaced presentation cannot authorize Stop for this confirmed Run.
        // Keep it discoverable without reviving that Region or replacing newer facts.
        set((current) => current.sessions.some((item) => item.id === session.id)
          ? current
          : { sessions: [...current.sessions, session] })
        return
      }
      set((current) => {
        const owner = findWorkbenchRegion(current.tabs, regionId)
        if (
          !owner ||
          owner.surface.kind !== 'terminal' ||
          !ownsSessionLaunch(owner.surface, 'terminal', sessionId)
        ) return current
        return reduceSessionLaunchAttached({
          ...current,
          tabs: {
            ...current.tabs,
            [owner.tab.id]: replaceWorkbenchRegion(owner.tab, regionId, {
              ...owner.surface,
              sessionId: session.id
            })
          }
        }, regionId, session)
      })
    } catch (error) {
      if (!ownsSessionLaunch(findWorkbenchRegion(get().tabs, regionId)?.surface, 'terminal', sessionId)) return
      const ownerFailure = sessionLaunchFailure(error)
      if (creationObserved || ownerFailure.controlFailure.disposition !== 'not_applied') {
        const retained = Object.assign(new Error(`${presentError(error)} Original Terminal creation ${request.createOperationId}, Region ${regionId}. Keep this Region and confirm the original request without starting again.`),
          { code: ownerFailure.code,
            createOperationId: request.createOperationId,
            controlFailure: ownerFailure.controlFailure.disposition === 'unknown' ? ownerFailure.controlFailure
              : { disposition: 'unknown' as const, confirmedInputBytes: null } })
        get().reportError(retained, { kind: 'indeterminate', lifecycle: { step: 'launch', regionId, tabId } })
        throw retained
      }
      set((current) => reduceSessionLaunchFailed(current, regionId, 'terminal', sessionId,
        launcherSurface?.kind === 'launcher' ? launcherSurface : undefined))
      get().reportError(error, { kind: 'indeterminate', lifecycle: { step: 'launch', regionId, tabId } })
      throw error
    }
  },
  prewarmTerminal(workspaceId, ownerLauncherId) {
    const workspace = get().config?.workspaces.find(item => item.id === workspaceId)
    if (!workspace) return
    const key = warmTerminalKey(workspace.hostId, workspace.path)
    const existing = warmTerminalForLauncher(get().warmTerminals[key], ownerLauncherId)
    if (existing) {
      if (existing.ownerLauncherId !== ownerLauncherId || existing.previewReleased) set(state => ({
        warmTerminals: updateWarmTerminal(state.warmTerminals, key, candidate => candidate === existing,
          candidate => {
            const { previewReleased: _released, ...retained } = candidate
            return { ...retained, ownerLauncherId }
          })
      }))
      return
    }
    const request: TerminalLaunchInput = {
      hostId: workspace.hostId,
      workspacePath: workspace.path,
      createOperationId: mintObjectId()
    }
    const creation: WarmTerminalCreation = { request, inFlight: true }
    const ready = api.sessions.launchTerminal(request).catch(error => {
      creation.inFlight = false
      creation.issue = sessionLaunchFailure(error)
      set(state => ({ warmTerminals: updateWarmTerminal(state.warmTerminals, key,
        candidate => candidate.ready === ready, candidate => ({ ...candidate })) }))
      return null
    })
    void ready.then(session => {
      if (!session) return
      creation.inFlight = false
      delete creation.issue
      set(state => ({
        warmTerminals: updateWarmTerminal(state.warmTerminals, key,
          candidate => candidate.ready === ready, candidate => ({ ...candidate, session,
            ...(candidate.previewReleased && !candidate.explicitOpening ? { ownerLauncherId: null } : {}) })),
        unclaimedTerminalSessionIds: trackUnclaimedTerminalSession(state.unclaimedTerminalSessionIds, session.id)
      }))
    })
    set(state => ({ warmTerminals: { ...state.warmTerminals,
      [key]: [...state.warmTerminals[key] ?? [], { key, ownerLauncherId, ready, session: null, creation }] } }))
  },
  releaseWarmTerminal(workspaceId, ownerLauncherId) {
    const workspace = get().config?.workspaces.find(item => item.id === workspaceId)
    if (!workspace) return
    const key = warmTerminalKey(workspace.hostId, workspace.path)
    set(state => ({ warmTerminals: updateWarmTerminal(state.warmTerminals, key,
      candidate => candidate.ownerLauncherId === ownerLauncherId && !candidate.claimToken,
      candidate => candidate.session
        ? { ...candidate, ownerLauncherId: null }
        : { ...candidate, previewReleased: true }) }))
  },
  async retryWarmTerminal(workspaceId, ownerLauncherId, hostRestored = false) {
    const workspace = get().config?.workspaces.find(item => item.id === workspaceId)
    if (!workspace) return null
    const key = warmTerminalKey(workspace.hostId, workspace.path)
    const held = warmTerminalForLauncher(get().warmTerminals[key], ownerLauncherId)
    if (!held) return null
    const creation = held.creation
    if (held.session || !creation?.issue || creation.inFlight) return await held.ready
    if (hostRestored && creation.hostRecoveryAttempted) return null
    // Confirm the same original request after an unknown receipt; never replay with a new identity.
    const request = creation.request
    creation.inFlight = true
    creation.hostRecoveryAttempted ||= hostRestored
    const ready = api.sessions.launchTerminal(request).catch(error => {
      creation.inFlight = false
      creation.issue = sessionLaunchFailure(error)
      set(state => ({ warmTerminals: updateWarmTerminal(state.warmTerminals, key,
        candidate => candidate.ready === ready, candidate => ({ ...candidate })) }))
      return null
    })
    set(state => ({ warmTerminals: updateWarmTerminal(state.warmTerminals, key,
      candidate => candidate === held, candidate => ({ ...candidate, ownerLauncherId, ready })) }))
    const session = await ready
    if (session) {
      creation.inFlight = false
      delete creation.issue
      set(state => ({
        warmTerminals: updateWarmTerminal(state.warmTerminals, key,
          candidate => candidate.ready === ready, candidate => ({ ...candidate, session,
            ...(candidate.previewReleased && !candidate.explicitOpening ? { ownerLauncherId: null } : {}) })),
        unclaimedTerminalSessionIds: trackUnclaimedTerminalSession(state.unclaimedTerminalSessionIds, session.id)
      }))
    }
    return session
  },
  promoteWarmTerminal(tabGroupId, launcher) {
    const initial = get()
    const surface = launcher ? initial.tabs[launcher.tabId]?.regions[launcher.regionId] : undefined
    const openingKey = JSON.stringify([tabGroupId, launcher?.tabId, launcher?.regionId, launcher ? null : initial.activeWorkspaceId])
    const existing = terminalOpeningCalls.get(openingKey)
    if (existing && (!launcher || surface !== undefined && (surface === existing.surface || surface === existing.pendingSurface))) return existing.promise
    const flight: { surface: WorkbenchSurface | undefined; pendingSurface?: WorkbenchSurface | undefined; promise: Promise<void> } = {
      surface, promise: Promise.resolve()
    }
    const open = async () => {
      const state = get()
      const launcherTab = launcher ? state.tabs[launcher.tabId] : undefined
      const launcherSurface = launcherTab && launcher
        ? launcherTab.regions[launcher.regionId]
        : undefined
      if (launcher && launcherSurface?.kind !== 'launcher') {
        throw new Error('Launcher Region is no longer available')
      }
      if (launcherTab && !workbenchViewCloseAllowsView(state.closingWorkbenchViews, launcherTab.id)) {
        throw new Error('The View is closing')
      }
      const workspaceId = resolveLauncherWorkspaceId({
        launcherWorkspaceId: launcherSurface?.kind === 'launcher' ? launcherSurface.workspaceId : undefined,
        launcherTabWorkspaceId: launcherTab?.workspaceId,
        activeWorkspaceId: state.activeWorkspaceId
      })
      const workspace = state.config?.workspaces.find((item) => item.id === workspaceId)
      if (!workspace) throw new Error('Select a workspace first')
      const key = warmTerminalKey(workspace.hostId, workspace.path)
      const displayWorkspaceId = launcherTab ? workbenchTabDisplayWorkspaceId(state.layouts, launcherTab.id, tabGroupId) : workspace.id
      const layout = displayWorkspaceId ? state.layouts[displayWorkspaceId] : undefined
      if (!layout || !groupIds(layout.root).includes(tabGroupId) || !findGroup(layout, tabGroupId) || launcherTab && !findGroup(layout, tabGroupId)!.tabOrder.includes(launcherTab.id)) throw new Error('The exact Terminal display position is unavailable')
      const ownerLauncherId = warmLauncherId({ tabGroupId, regionId: launcher?.regionId })
      let held = warmTerminalForLauncher(state.warmTerminals[key], ownerLauncherId) ??
        state.warmTerminals[key]?.find(candidate => (candidate.ownerLauncherId === null || candidate.previewReleased) && !candidate.claimToken) ?? null
      if (!held || held.claimToken || held.creation?.issue && !held.explicitOpening) {
        // Speculative cache failure cannot block a new explicit opening. Check again
        // keeps the original unknown request; this action has its own creation identity.
        const opening = get().launchTerminal(tabGroupId, launcher)
        if (launcher) flight.pendingSurface = get().tabs[launcher.tabId]?.regions[launcher.regionId]
        await opening
        return
      }
      const claimToken = {}
      const candidateReady = held.ready
      held = { ...held, explicitOpening: true }
      set(current => ({ warmTerminals: updateWarmTerminal(current.warmTerminals, key,
        candidate => candidate.ready === candidateReady, candidate => ({ ...candidate, ownerLauncherId, explicitOpening: true, claimToken })) }))
      try {
        if (held.creation?.issue) {
          const confirmed = await get().retryWarmTerminal(workspace.id, ownerLauncherId)
          if (!confirmed) {
            const issue = get().warmTerminals[key]?.find(candidate => candidate.claimToken === claimToken)?.creation?.issue ?? held.creation.issue
            throw Object.assign(new Error(issue.message), issue)
          }
          const live = get().warmTerminals[key]?.find(candidate => candidate.claimToken === claimToken)
          if (!live || live.key !== key || live.session?.id !== confirmed.id || live.claimToken !== claimToken) return
          held = live
          // A late confirmation belongs to the original Launcher, never a replacement View.
          if (launcher && (get().tabs[launcher.tabId]?.regions[launcher.regionId] !== launcherSurface ||
            !workbenchViewCloseAllowsView(get().closingWorkbenchViews, launcher.tabId))) return
        }
        // Reserve the exact Launcher and retain the warm slot until its original receipt settles.
        // Another preview cannot erase that request, and only one opening may claim the same Run.
        const pendingSurface: TerminalWorkbenchSurface | undefined = launcherTab && launcher ? {
          regionId: launcher.regionId, kind: 'terminal', phase: 'launching', workspaceId: workspace.id,
          sessionId: held.session?.id ?? mintObjectId()
        } : undefined
        flight.pendingSurface = pendingSurface
        set((current) => ({ ...(pendingSurface && launcherTab ? {
          tabs: { ...current.tabs, [launcherTab.id]: replaceWorkbenchRegion(launcherTab, pendingSurface.regionId, pendingSurface) }
        } : {}) }))
        const session = await held.ready
        if (!session) {
          if (pendingSurface && launcherTab && launcherSurface) {
            let restored = false
            set((current) => {
              const live = current.tabs[launcherTab.id]
              if (!live || !ownsSessionLaunch(live.regions[pendingSurface.regionId], 'terminal', pendingSurface.sessionId)) return current
              restored = true
              return { tabs: { ...current.tabs, [live.id]: replaceWorkbenchRegion(live, pendingSurface.regionId, launcherSurface) } }
            })
            if (!restored) return
          }
          // The original request may have been accepted before its reply failed. Keep
          // this exact creation available for Check again, including its typed failure.
          const issue = held.creation?.issue ?? sessionLaunchFailure(new Error('The original shell creation is unconfirmed. Check this same request again.'))
          throw Object.assign(new Error(issue.message), issue)
        }
        if (!launcherTab && !get().layouts[workspace.id]) throw new Error('Workspace layout is unavailable')
        const inheritedTopicId = launcherTab
          ? undefined
          : inheritedTopicIdForNewTab(workspace.id, get().layouts[workspace.id], state.tabs, tabGroupId)
        const targetTab = launcherTab ?? newLauncherTab(workspace.id, inheritedTopicId)
        const tabId = targetTab.id
        const regionId = launcher?.regionId ?? targetTab.layout.activeRegionId
        const surface: TerminalWorkbenchSurface = {
          regionId,
          kind: 'terminal',
          phase: 'attached',
          workspaceId: workspace.id,
          sessionId: session.id
        }
        let bound = false
        let sessionOwnedByClose = false
        let placementFailed = false
        set((current) => {
          if (!workbenchViewCloseAllowsSession(current.closingWorkbenchViews, session.id)) {
            sessionOwnedByClose = true
            return current
          }
          if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return current
          let baseTab = targetTab
          if (launcher) {
            const live = current.tabs[tabId]
            if (!live || (pendingSurface
              ? !ownsSessionLaunch(live.regions[regionId], 'terminal', pendingSurface.sessionId)
              : live.regions[regionId]?.kind !== 'launcher')) return current
            baseTab = live
          }
          const nextTabs = { ...current.tabs, [tabId]: replaceWorkbenchRegion(baseTab, regionId, surface) }
          const nextSessions = [...current.sessions.filter((item) => item.id !== session.id), session]
          const nextUnclaimedIds = forgetUnclaimedTerminalSession(
            current.unclaimedTerminalSessionIds,
            session.id
          )
          if (launcher) {
            bound = true
            return {
              warmTerminals: updateWarmTerminal(current.warmTerminals, key,
                candidate => candidate.claimToken === claimToken, () => null),
              tabs: nextTabs,
              sessions: nextSessions,
              unclaimedTerminalSessionIds: nextUnclaimedIds
            }
          }
          const layout = current.layouts[workspace.id]
          if (!layout) return current
          // The cache still owns the original shell if its display position vanished.
          const nextLayout = addTabPlacement(layout, tabGroupId, tabId)
          if (!nextLayout) {
            placementFailed = true
            return current
          }
          bound = true
          return {
            warmTerminals: updateWarmTerminal(current.warmTerminals, key,
                candidate => candidate.claimToken === claimToken, () => null),
            tabs: nextTabs,
            layouts: { ...current.layouts, [workspace.id]: nextLayout },
            sessions: nextSessions,
            unclaimedTerminalSessionIds: nextUnclaimedIds
          }
        })
        if (!bound) {
          if (sessionOwnedByClose) return
          // Closing/replacing a presentation is not permission to stop this candidate.
          if (placementFailed) throw new Error('The Tab Group is no longer available')
          return
        }
        void get().refreshSession(session.id)
      } finally {
        set((current) => {
          return { warmTerminals: updateWarmTerminal(current.warmTerminals, key,
            candidate => candidate.claimToken === claimToken, candidate => {
              const { claimToken: _claim, ...retained } = candidate
              const liveSurface = launcher ? current.tabs[launcher.tabId]?.regions[launcher.regionId] : undefined
              const presentationGone = launcher
                ? liveSurface !== launcherSurface && liveSurface !== flight.pendingSurface
                : !displayWorkspaceId || !current.layouts[displayWorkspaceId] || !findGroup(current.layouts[displayWorkspaceId]!, tabGroupId)
              return presentationGone
                ? { ...retained, ownerLauncherId: null } : retained
            }) }
        })
      }
    }
    let resolveOpening!: () => void
    let rejectOpening!: (error: unknown) => void
    flight.promise = new Promise<void>((resolve, reject) => { resolveOpening = resolve; rejectOpening = reject })
    const release = () => {
      if (terminalOpeningCalls.get(openingKey) === flight) terminalOpeningCalls.delete(openingKey)
    }
    terminalOpeningCalls.set(openingKey, flight)
    void open().then(() => { release(); resolveOpening() }, error => { release(); rejectOpening(error) })
    return flight.promise
  },
  async createBrowser(tabGroupId, launcher, url = 'about:blank', bookmarkOrigin, requestedWorkspaceId, requestedDisplayWorkspaceId, mode) {
    const state = get()
    const launcherTab = launcher ? state.tabs[launcher.tabId] : undefined
    const launcherSurface = launcherTab && launcher
      ? launcherTab.regions[launcher.regionId]
      : undefined
    if (launcher && launcherSurface?.kind !== 'launcher') {
      throw new Error('Launcher Region is no longer available')
    }
    const workspaceId = requestedWorkspaceId ?? resolveLauncherWorkspaceId({
      launcherWorkspaceId: launcherSurface?.kind === 'launcher' ? launcherSurface.workspaceId : undefined,
      launcherTabWorkspaceId: launcherTab?.workspaceId,
      activeWorkspaceId: state.activeWorkspaceId
    })
    if (!workspaceId) throw new Error('Select a workspace first')
    const displayWorkspaceId = requestedDisplayWorkspaceId ?? (launcherTab ? workbenchTabDisplayWorkspaceId(state.layouts, launcherTab.id, tabGroupId) : workspaceId)
    const layout = displayWorkspaceId ? state.layouts[displayWorkspaceId] : undefined
    if (!layout || !groupIds(layout.root).includes(tabGroupId) || !findGroup(layout, tabGroupId) || launcherTab && !findGroup(layout, tabGroupId)!.tabOrder.includes(launcherTab.id)) throw new Error('The exact Browser display position is unavailable')
    const inheritedTopicId = launcherTab
      ? undefined
      : inheritedTopicIdForNewTab(workspaceId, layout, state.tabs, tabGroupId)
    const targetTab = launcherTab ?? newLauncherTab(workspaceId, inheritedTopicId)
    const tabId = targetTab.id
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, tabId)) throw new Error('The View is closing')
    const regionId = launcher?.regionId ?? targetTab.layout.activeRegionId
    const pendingLauncher = targetTab.regions[regionId]
    if (pendingLauncher?.kind !== 'launcher') throw new Error('Launcher Region is no longer available')
    if (!launcher) {
      // 挂不上就抛，绝不留孤儿 Tab（见 addTabPlacement 的说明）。这里排在 api.browser.create
      // 之前：落点不在场时连 BrowserView 都不该建，省掉一次紧接着的销毁。
      const nextLayout = addTabOrThrow(layout, tabGroupId, tabId)
      set((current) => ({
        tabs: { ...current.tabs, [tabId]: targetTab },
        layouts: { ...current.layouts, [displayWorkspaceId!]: nextLayout }
      }))
      get().selectMainRegion({ displayWorkspaceId: displayWorkspaceId!, groupId: tabGroupId, tabId, regionId }, state.workbenchSpaceSelection)
    }
    try {
      const browser = await api.browser.create(regionId, url, workspaceId, undefined, mode)
      const surface: BrowserWorkbenchSurface = {
        ...browser,
        regionId,
        kind: 'browser',
        workspaceId,
        browserId: regionId,
        // 从书签开的才带 origin（供「查看源码」）；普通新开不写这个键（exactOptionalPropertyTypes 下
        // 不能塞 undefined），故条件展开而不是 `bookmarkOrigin: bookmarkOrigin`。
        ...(bookmarkOrigin ? { bookmarkOrigin } : {})
      }
      let attached = false
      set((current) => {
        const currentOwner = findWorkbenchRegion(current.tabs, regionId)
        if (
          currentOwner?.tab.id !== tabId ||
          currentOwner.surface !== pendingLauncher ||
          !workbenchViewCloseAllowsView(current.closingWorkbenchViews, currentOwner.tab.id)
        ) return current
        attached = true
        return {
          tabs: {
            ...current.tabs,
            [currentOwner.tab.id]: { ...replaceWorkbenchRegion(currentOwner.tab, regionId, surface),
              // Resource attachment is not a later navigation intent.
              layout: currentOwner.tab.layout }
          }
        }
      })
      if (!attached) {
        const primary = new Error('Browser launch owner disappeared before it could attach.')
        try {
          await api.browser.close(browser.id)
        } catch (cleanupError) {
          throw new AggregateError(
            [primary, cleanupError],
            `${primary.message} Cleanup also failed: ${presentError(cleanupError)}`
          )
        }
        return
      }
    } catch (error) {
      get().reportError(error)
      throw error
    }
  },
  async saveBrowserBookmark(workspaceId, url, title) {
    // about:blank 不是一个能存的地方——存了它打开也是空页。当作「没什么可存」，不写文件也不报错。
    if (!url || url === 'about:blank') throw Object.assign(new Error('This page has no address to bookmark yet'), { status: 'error' })
    const content = emitWebloc(url)
    const base = bookmarkFileNameFromTitle(title)
    // 撞名退避：`Name.webloc`、`Name 2.webloc`……。判据是 `files.write` 带 `expectedRevision: null`——
    // 文件已存在时它返回 conflict（不覆盖），于是我们换下一个候选，而不是默默盖掉用户已有的书签。
    // ponytail: 上限 50 个候选；同一标题存到第 50 个还没空位是病态使用，那时如实抛错比无限试更诚实。
    let lastReason = ''
    for (let n = 1; n <= 50; n++) {
      const path = n === 1 ? `${base}.webloc` : `${base} ${n}.webloc`
      let result: import('../../shared/contracts').WorkspaceFileWriteResult
      try { result = await api.files.write(workspaceId, { path, content, expectedRevision: null }) }
      catch (cause) {
        throw Object.assign(new Error(presentError(cause), { cause }), { status: 'unknown', path },
          cause !== null && typeof cause === 'object' && 'code' in cause ? { code: cause.code } : {})
      }
      if (result.status === 'written') {
        // 让文件树/Topics/Board 看到新文件——与 createPath 用同一个失效计数器，不另起一套。
        set((current) => ({
          workspaceFileRevisions: bumpWorkspaceFileRevision(current.workspaceFileRevisions, workspaceId)
        }))
        return path
      }
      if (result.status === 'error' || result.status === 'unknown') throw Object.assign(new Error(result.message), { code: result.code, status: result.status, path })
      // conflict：这个名字被占了，试下一个。
      lastReason = `${path} already exists`
    }
    throw Object.assign(new Error(`Could not save the bookmark: ${lastReason}`), { status: 'error' })
  },
  async openHttpLink(origin, rawUrl, destination, presentation) {
    const opening = get(), expectedChoice = opening.workbenchSpaceSelection
    const local = presentation?.surface === 'mote' || presentation?.surface === 'survey'
    const mainFocus = opening.mainSurface === 'agents' && !local
    const focusLink = destination !== 'tab' && mainFocus && expectedChoice?.workspaceId === origin.workspaceId && expectedChoice.groupId === origin.tabGroupId && expectedChoice.tabId === origin.tabId && expectedChoice.regionId === origin.regionId
    const url = normalizeHttpLinkUrl(rawUrl)
    if (destination === 'system') {
      await api.ui.openExternal(url)
      return
    }
    if (mainFocus && destination !== 'tab' && !focusLink) throw new Error('The selected Focus Region changed. Choose its original work surface explicitly; the Agent is kept.')
    const targetPlacement = origin.sessionId
      ? resolveSessionPlacement({
          sessionId: origin.sessionId,
          sessions: get().sessions,
          tabs: get().tabs,
          layouts: get().layouts,
          origin
        })
      : null
    if (targetPlacement && targetPlacement.kind === 'unresolved') {
      throw new Error(targetPlacement.message)
    }
    const placementOrigin = targetPlacement ?? origin
    if (destination !== 'tab' && (!placementOrigin.tabId || !placementOrigin.regionId)) {
      throw new Error('Directional link destinations require a Tab and Region origin')
    }

    const sourceTab = placementOrigin.tabId ? opening.tabs[placementOrigin.tabId] : undefined
    if (placementOrigin.tabId && (!sourceTab || !placementOrigin.regionId || !sourceTab.regions[placementOrigin.regionId])) throw new Error('The original link Region is unconfirmed; its work surface is kept.')
    const resourceWorkspaceId = sourceTab?.workspaceId ?? placementOrigin.workspaceId
    const tabId = destination === 'tab' ? mintObjectId() : placementOrigin.tabId!
    const regionId = destination === 'tab' ? initialWorkbenchRegionId(tabId) : newRegionId()
    const pendingLauncher: LauncherWorkbenchSurface = {
      regionId,
      kind: 'launcher',
      workspaceId: resourceWorkspaceId
    }
    let planned = false
    let placementError: Error | null = null
    set((current) => {
      const layout = current.layouts[placementOrigin.workspaceId]
      if (!layout) {
        placementError = new Error('Workspace layout is unavailable')
        return current
      }
      const originGroup = placementOrigin.tabGroupId ? findGroup(layout, placementOrigin.tabGroupId) : undefined
      if (!originGroup || !groupIds(layout.root).includes(originGroup.id)) {
        placementError = new Error('Link origin Tab Group is no longer available')
        return current
      }
      if (destination === 'tab') {
        const topicId = inheritedTopicIdForNewTab(
          resourceWorkspaceId,
          layout,
          current.tabs,
          originGroup.id
        )
        const createdTab = createWorkbenchTab(tabId, pendingLauncher)
        const tab = topicId ? { ...createdTab, topicId } : createdTab
        // 落点判定收在 addTabPlacement 里（同一族缺陷的唯一判据）。原先这里写的是
        // `nextLayout === layout` 的身份比较——对这条路径恰好等价，但那个判据认不出
        // 「Tab 已在别处、activateTab 返回同一对象」，换到别的调用点就会把正常路径判成失败。
        const nextLayout = addTabPlacement(layout, originGroup.id, tabId)
        if (!nextLayout) {
          placementError = new Error('Link destination Tab could not be created')
          return current
        }
        planned = true
        return {
          activeWorkspaceId: placementOrigin.workspaceId, mainSurface: 'workbench',
          tabs: { ...current.tabs, [tabId]: tab },
          layouts: { ...current.layouts, [placementOrigin.workspaceId]: nextLayout }
        }
      }

      const originTab = current.tabs[placementOrigin.tabId!]
      if (
        !originTab ||
        !originTab.regions[placementOrigin.regionId!] ||
        !regionIds(originTab.layout.root).includes(placementOrigin.regionId!) ||
        !originGroup.tabOrder.includes(originTab.id)
      ) {
        placementError = new Error('Link origin Region is no longer available')
        return current
      }
      if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, originTab.id)) {
        placementError = new Error('The View is closing')
        return current
      }
      pendingLauncher.workspaceId = originTab.workspaceId
      const nextTab = addWorkbenchRegion(
        originTab,
        placementOrigin.regionId!,
        destination,
        pendingLauncher
      )
      if (nextTab === originTab) {
        placementError = new Error('Link destination Region could not be created')
        return current
      }
      planned = true
      return { tabs: { ...current.tabs, [originTab.id]: local ? { ...nextTab,
        layout: { ...nextTab.layout, activeRegionId: originTab.layout.activeRegionId } } : nextTab } }
    })
    if (!planned) throw placementError ?? new Error('Link destination could not be created')

    if (destination === 'tab') get().selectMainRegion({ displayWorkspaceId: placementOrigin.workspaceId, groupId: placementOrigin.tabGroupId!, tabId, regionId }, expectedChoice)
    const plannedNavigation = fileNavigationSelection(get())
    const plannedLocalRegion = get().tabs[tabId]?.layout.activeRegionId
    const localNavigation = () => {
      const floating = readPmoTeamsTopicFloatingState()
      return JSON.stringify([floating?.open, floating?.targetTopicId, floating?.targetTabId, floating?.reference])
    }
    const plannedLocal = localNavigation()
    let navigationChanged = false
    const unsubscribe = useAppStore.subscribe(current => {
      if (fileNavigationSelection(current) !== plannedNavigation) navigationChanged = true
    })
    const unsubscribeLocal = presentation?.surface === 'mote' ? subscribePmoTeamsTopicFloatingState(() => {
      if (localNavigation() !== plannedLocal) navigationChanged = true
    }) : () => {}
    try {
      await get().createBrowser(placementOrigin.tabGroupId!, { tabId, regionId }, url, undefined, pendingLauncher.workspaceId, placementOrigin.workspaceId)
      const current = get()
      if (destination !== 'tab' && !navigationChanged && fileNavigationSelection(current) === plannedNavigation && current.tabs[tabId]?.regions[regionId]?.kind === 'browser') {
        if (local) {
          if (presentation?.surface === 'mote' && current.tabs[tabId]?.layout.activeRegionId !== plannedLocalRegion) return
          if (presentation?.onSelectRegion) presentation.onSelectRegion(regionId)
          else current.reportError(new Error('The new Browser is kept in its original surface. Select its exact Region to continue.'), { kind: 'indeterminate' })
        } else current.selectMainRegion({ displayWorkspaceId: placementOrigin.workspaceId, groupId: placementOrigin.tabGroupId!, tabId, regionId }, expectedChoice)
      }
    } catch (error) {
      const reclaimPendingMark = (current: AppState, topology: Pick<AppState, 'tabs' | 'layouts'>) => {
        if (!sameWorkbenchProjectionSelection(mainRegionReference(current.workbenchSpaceSelection), {
          displayWorkspaceId: placementOrigin.workspaceId, groupId: placementOrigin.tabGroupId!, tabId, regionId })) return {}
        const choice = expectedChoice ? desktopSpaceSelectionAfterClose(expectedChoice, topology, {
          workspaceId: expectedChoice.workspaceId, tabId: expectedChoice.tabId ?? '',
          ...(expectedChoice.groupId ? { groupId: expectedChoice.groupId } : {}),
          ...(expectedChoice.regionId ? { regionId: expectedChoice.regionId } : {}) }) : null
        return { workbenchSpaceSelection: choice, activeWorkspaceId: choice?.workspaceId ?? current.activeWorkspaceId }
      }
      set((current) => {
        const liveTab = current.tabs[tabId]
        if (!liveTab || liveTab.regions[regionId] !== pendingLauncher) return current
        if (destination !== 'tab') {
          const nextTab = removeWorkbenchRegion(liveTab, regionId)
          return nextTab
            ? { tabs: { ...current.tabs, [tabId]: nextTab }, ...reclaimPendingMark(current, { tabs: { ...current.tabs, [tabId]: nextTab }, layouts: current.layouts }) }
            : current
        }
        const layout = current.layouts[placementOrigin.workspaceId]
        const currentTabGroupId = tabGroupForTab(layout, tabId)
        if (!layout || !currentTabGroupId) return current
        const tabs = { ...current.tabs }
        delete tabs[tabId]
        const topology = { tabs, layouts: { ...current.layouts,
          [placementOrigin.workspaceId]: removeLayoutTab(layout, currentTabGroupId, tabId) } }
        return { ...topology, ...reclaimPendingMark(current, topology) }
      })
      throw error
    } finally { unsubscribe(); unsubscribeLocal() }
  },
  applyBrowserEvent(event, expectedNavigationId) {
    if (event.type === 'native-opened') {
      const projection = projectNativeBrowserOpening(get(), event)
      if (projection.issue) {
        const firstObservation = !pendingNativeBrowsers.has(event.browser.id)
        pendingNativeBrowsers.set(event.browser.id, event)
        if (firstObservation) get().reportError(new Error(projection.issue), { kind: 'indeterminate',
          event: { source: 'spatial', key: `native-browser:${event.browser.id}` } })
        return
      }
      pendingNativeBrowsers.delete(event.browser.id)
      const current = get(), settled = settleNativeBrowserProjectionNotice(current, event.browser.id)
      if (projection.state !== current || Object.keys(settled).length) set({ ...projection.state, ...settled })
      if (projection.target) {
        const target = projection.target
        void import('./lib/workbench-windows').then(({ openWorkbenchWindow }) => {
          const surface = get().tabs[target.tabId]?.regions[target.regionId]
          if (surface?.kind === 'browser' && surface.browserId === event.browser.id) return openWorkbenchWindow({ kind: 'region', ...target })
        }).catch(error => get().reportError(error))
      }
      return
    }
    if (event.type === 'closed') pendingNativeBrowsers.delete(event.id)
    if (event.type === 'updated') {
      const pending = pendingNativeBrowsers.get(event.browser.id)
      if (pending) pendingNativeBrowsers.set(event.browser.id, { ...pending, browser: event.browser })
    }
    const retiredRegions = event.type === 'closed' ? Object.values(get().tabs).flatMap(tab =>
      workbenchSurfaces(tab).flatMap(surface => surface.kind === 'browser' && surface.browserId === event.id
        ? [{ tabId: tab.id, regionId: surface.regionId }] : [])) : []
    set((state) => {
      const topology = reduceBrowserEvent(state, event, expectedNavigationId)
      let choice = state.workbenchSpaceSelection
      if (event.type === 'closed' && topology !== state) {
        // Native close can be confirmed before the close request returns. Reconcile
        // against the final topology in this transaction, including every occurrence.
        for (const tab of Object.values(state.tabs)) {
          for (const surface of workbenchSurfaces(tab)) {
            if (surface.kind !== 'browser' || surface.browserId !== event.id ||
              topology.tabs[tab.id]?.regions[surface.regionId]) continue
            coreSpatialPersistence?.removeEntity(surface.regionId)
            if (!topology.tabs[tab.id]) coreSpatialPersistence?.removeEntity(tab.id)
            choice = desktopSpaceSelectionAfterClose(choice, topology, {
              workspaceId: tab.workspaceId, tabId: tab.id, regionId: surface.regionId
            })
          }
        }
      }
      return {
        ...topology,
        ...(event.type === 'closed' ? settleNativeBrowserProjectionNotice(state, event.id) : {}),
        workbenchSpaceSelection: choice,
        ...(event.type === 'closed'
          ? {
              browserAnnotationsByBrowserId: Object.fromEntries(
                Object.entries(state.browserAnnotationsByBrowserId)
                  .filter(([browserId]) => browserId !== event.id)
              )
            }
          : {})
      }
    })
    if (retiredRegions.length) void import('./lib/workbench-windows')
      .then(({ returnClosedWorkbenchWindows }) => returnClosedWorkbenchWindows(retiredRegions)).catch(error => get().reportError(error))
  },
  addBrowserAnnotation(annotation) {
    if (
      annotation.browserId !== annotation.selection.browserId ||
      annotation.navigationId !== annotation.selection.navigationId
    ) {
      throw new Error('Browser annotation identity does not match its selected element')
    }
    set((state) => {
      const current = state.browserAnnotationsByBrowserId[annotation.browserId] ?? []
      if (current.some(({ id }) => id === annotation.id)) return state
      return {
        browserAnnotationsByBrowserId: {
          ...state.browserAnnotationsByBrowserId,
          [annotation.browserId]: [...current, annotation]
        }
      }
    })
  },
  deleteBrowserAnnotation(browserId, annotationId) {
    set((state) => {
      const current = state.browserAnnotationsByBrowserId[browserId] ?? []
      const next = current.filter(({ id }) => id !== annotationId)
      if (next.length === current.length) return state
      const browserAnnotationsByBrowserId = { ...state.browserAnnotationsByBrowserId }
      if (next.length > 0) browserAnnotationsByBrowserId[browserId] = next
      else delete browserAnnotationsByBrowserId[browserId]
      return { browserAnnotationsByBrowserId }
    })
  },
  clearBrowserAnnotations(browserId) {
    set((state) => {
      if (!state.browserAnnotationsByBrowserId[browserId]) return state
      const browserAnnotationsByBrowserId = { ...state.browserAnnotationsByBrowserId }
      delete browserAnnotationsByBrowserId[browserId]
      return { browserAnnotationsByBrowserId }
    })
  },
  recordAgentComposerHistory(sessionId, text) {
    if (!text.trim()) return
    set(state => {
      const entries = state.agentComposerHistory[sessionId] ?? []
      const next = recordHistory({ entries, cursor: entries.length, stash: null }, text)
      return {
        agentComposerHistory: { ...state.agentComposerHistory, [sessionId]: next.entries },
        agentComposerHistoryNavigation: { ...state.agentComposerHistoryNavigation,
          [sessionId]: { cursor: next.cursor, stash: next.stash } }
      }
    })
  },
  recallAgentComposerHistory(sessionId, direction, draft, candidates) {
    const state = get(), navigation = state.agentComposerHistoryNavigation[sessionId]
    const browsing = navigation?.entries && navigation.cursor < navigation.entries.length
    const entries = browsing ? navigation.entries! : [...(candidates ?? state.agentComposerHistory[sessionId] ?? [])]
    const result = navigateHistory({ entries, cursor: browsing ? navigation.cursor : entries.length,
      stash: browsing ? navigation.stash : null }, direction, draft)
    if (!result) return null
    set({ agentComposerDrafts: state.agentComposerDrafts[sessionId] === result.value ? state.agentComposerDrafts
        : { ...state.agentComposerDrafts, [sessionId]: result.value },
      agentComposerHistoryNavigation: { ...state.agentComposerHistoryNavigation,
        [sessionId]: { cursor: result.state.cursor, stash: result.state.stash,
          ...(result.state.cursor < entries.length ? { entries } : {}) } } })
    return result.value
  },
  setAgentComposerDraft(sessionId, text) {
    const state = get(), session = sessionPresentationById(state.sessions).get(sessionId)
    if (!state.agentComposerDrafts[sessionId]?.trim() && text.trim() && session?.kind === 'agent') {
      void api.continuousProgress.pauseForInput(session.control).catch(error => get().reportError(error))
    }
    const { [sessionId]: _navigation, ...navigation } = state.agentComposerHistoryNavigation
    set({ agentComposerDrafts: { ...state.agentComposerDrafts, [sessionId]: text },
      agentComposerHistoryNavigation: navigation })
  },
  setLauncherExecutionWorkspace(launcher, workspaceId, executorId) {
    const state = get()
    const tab = state.tabs[launcher.tabId]
    const surface = tab?.regions[launcher.regionId]
    if (!tab || surface?.kind !== 'launcher') throw new Error('Only an unstarted Launcher can change its execution target')
    const workspace = state.config?.workspaces.find(item => item.id === workspaceId)
    if (!workspace || !state.config?.hosts.some(host => host.id === workspace.hostId)) {
      throw new Error('Select a registered project on a configured host')
    }
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, tab.id)) throw new Error('The View is closing')
    if (surface.workspaceId === workspaceId && (executorId === undefined || surface.executorId === executorId)) return
    // Only this resource changes. Display, other Regions and all unsent inputs retain their owners.
    set({ tabs: { ...state.tabs, [tab.id]: updateWorkbenchRegion(tab, launcher.regionId, current => ({ ...current, workspaceId, ...(executorId ? { executorId } : {}) })) } })
  },
  setLauncherNameDraft(regionId, field, value) {
    set((state) => {
      const current = state.launcherNameDrafts[regionId] ?? EMPTY_LAUNCHER_NAMES
      if (current[field] === value) return state
      return {
        launcherNameDrafts: { ...state.launcherNameDrafts, [regionId]: { ...current, [field]: value } }
      }
    })
  },
  setLauncherOptionDraft(regionId, providerId, optionId, choiceId) {
    set(state => {
      const current = state.launcherOptionDrafts[regionId] ?? EMPTY_LAUNCHER_OPTIONS
      const next = updateLauncherOption(current, providerId, optionId, choiceId)
      if (next === current) return state
      const drafts = { ...state.launcherOptionDrafts }
      if (Object.keys(next).length) drafts[regionId] = next
      else delete drafts[regionId]
      return { launcherOptionDrafts: drafts }
    })
  },
  async saveBrowserOpinionDraft(browserId, draft, flush = false) {
    set(state => ({ browserOpinionDrafts: { ...state.browserOpinionDrafts, [browserId]: structuredClone(draft) } }))
    // Reuse the original workbench writer. Saving observations never grants an input retry.
    if (flush) await flushMessageWorkbench(true)
  },
  appendAgentComposerDraft(sessionId, text) {
    if (!text.trim()) return
    const current = get().agentComposerDrafts[sessionId] ?? ''
    get().setAgentComposerDraft(sessionId, `${current}${current.trim() ? '\n\n' : ''}${text}`)
  },
  clearAgentComposerDraftIfUnchanged(sessionId, expectedText) {
    set((state) => {
      if ((state.agentComposerDrafts[sessionId] ?? '') !== expectedText) return state
      const agentComposerDrafts = { ...state.agentComposerDrafts }
      delete agentComposerDrafts[sessionId]
      return { agentComposerDrafts }
    })
  },
  enqueueAgentSteer(sessionId, text, onRejected, operationId, origin, agentMuxNote, options) {
    // An explicit immediate click selects this original Run before any local wait.
    // Queue-only Enter remains unbound until its own explicit Send selection.
    const binding = options?.execution === 'immediate' ? manualComposerBinding(sessionId, origin, options) : undefined
    return admitAgentSteer(sessionId, text, onRejected, operationId, origin, agentMuxNote, options, binding) !== false
  },
  async moveQueuedAgentSteerToDraft(sessionId, operationId, expectedText, expectedRunId) {
    let pause: Extract<SessionSnapshot, { kind: 'agent' }> | undefined
    set(state => {
      const queue = state.agentSteerQueues[sessionId], entry = queue?.find(item => item.operationId === operationId)
      const session = state.sessions.find(item => item.id === sessionId)
      if (!entry || entry.text !== expectedText || entry.errorCode !== 'AGENT_PROMPT_CONDITION_CHANGED') {
        throw controlFailure('CONTROL_REQUEST_CONFLICT', 'The original message changed or is unavailable. Read its current record before moving it to the draft.')
      }
      // A repeated activation only retries the save; never append the authored body twice.
      if (entry.movedToDraft && !entry.archived) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'This original body was already moved to its draft. Restoring its archive does not authorize appending it again.')
      if (entry.archived) {
        if (entry.movedToDraft) return state
        throw controlFailure('CONTROL_REQUEST_CONFLICT', 'This message was archived without moving its text. Read the original archive before composing another message.')
      }
      if (session?.kind !== 'agent' || session.control.agentSessionId !== sessionId || session.hostId !== session.control.hostId ||
          session.control.run.runId !== expectedRunId || entry.runId !== expectedRunId || entry.promptCondition?.expectedRun.runId !== expectedRunId) {
        throw controlFailure('STALE_AGENT_SESSION', 'The original Session or Run binding changed. Its message and current draft are kept.')
      }
      if (state.agentSteerInFlight[sessionId] === operationId) throw controlFailure('AGENT_PROMPT_SUBMISSION_BUSY', 'This original call is still active. Its message and draft are kept.')
      if ((entry.inputReceipt?.status === 'admitted' || entry.inputReceipt?.status === 'terminal-confirmed') || !entry.directInputBinding && confirmedSteerDelivery(state.timelines[sessionId], session.control, operationId)) {
        throw controlFailure('CONTROL_REQUEST_CONFLICT', 'Core confirmed this original input. Read its History before composing another message.')
      }
      const draft = state.agentComposerDrafts[sessionId] ?? ''
      if (!draft.trim() && entry.text.trim()) pause = session
      return {
        agentComposerDrafts: { ...state.agentComposerDrafts, [sessionId]: `${draft}${draft ? '\n\n' : ''}${entry.text}` },
        agentSteerQueues: { ...state.agentSteerQueues, [sessionId]: queue!.map(item => item === entry ? { ...item, archived: true as const, movedToDraft: true as const } : item) }
      }
    })
    agentSteerDrains.get(sessionId)?.explicitSteers.delete(operationId)
    if (pause) void api.continuousProgress.pauseForInput(pause.control).catch(error => get().reportError(error))
    try { await flushMessageWorkbench(false) }
    catch (error) { get().reportWorkbenchSaveFailure(error); throw error }
  },
  async archiveAgentSteer(sessionId, operationId, expectedText, archived) {
    const original = get().agentSteerQueues[sessionId]?.find(item => item.operationId === operationId)
    if (archived && original?.directInputBinding && original.inputIntakeStarted) {
      const control = original.directInputControl
      if (!control || control.agentSessionId !== sessionId || control.run.runId !== original.directInputBinding.expectedRun.runId) throw controlFailure(
        'STALE_AGENT_SESSION', 'The original Core waiting endpoint is unconfirmed; its input and archive intent are retained.')
      const receipt = await api.sessions.inspectInput(control, { kind: 'prompt', agentSessionId: sessionId,
        expectedRun: original.directInputBinding.expectedRun, submissionId: operationId })
      if (receipt) {
        consumeInputReceipt(sessionId, receipt)
        await get().cancelAgentSteerPreparation(sessionId, operationId)
      }
    }
    let changed = false
    let result!: AgentSteerQueueEntry
    set(state => {
      const queue = state.agentSteerQueues[sessionId]
      const entry = queue?.find(item => item.operationId === operationId)
      if (!entry) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'This original message is no longer available. No replacement was created.')
      if (entry.text !== expectedText) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'This original message changed. Read its current text before archiving or restoring it.')
      if (state.agentSteerInFlight[sessionId] === operationId) throw controlFailure('AGENT_PROMPT_SUBMISSION_BUSY', 'This original call is preparing or submitting. Archiving cannot recall Provider input; its original facts are kept.')
      if (!archived && ((entry.inputReceipt?.status === 'admitted' || entry.inputReceipt?.status === 'terminal-confirmed') || !entry.directInputBinding && confirmedSteerDelivery(state.timelines[sessionId], state.sessions.find((item): item is Extract<SessionSnapshot, { kind: 'agent' }> => item.kind === 'agent' && item.id === sessionId)?.control, operationId))) {
        throw controlFailure('CONTROL_REQUEST_CONFLICT', 'Core confirmed this original input. Its archived record is kept; read the confirmed History instead of restoring it to Pending.')
      }
      if (!archived && entry.archived && queue!.filter(item => !item.archived).length >= MAX_AGENT_STEER_QUEUE_ENTRIES) {
        throw controlFailure('CONTROL_REQUEST_CONFLICT', 'The active message queue is full. Archive another active message before restoring this original record; its archived facts are kept.')
      }
      result = entry
      if ((entry.archived === true) === archived) return state
      changed = true
      return { agentSteerQueues: { ...state.agentSteerQueues, [sessionId]: queue!.map(item => {
        if (item !== entry) return item
        if (archived) return (result = { ...item, archived: true as const })
        const { archived: _archive, ...original } = item
        return (result = { ...original, awaitingExplicitSend: true as const })
      }) } }
    })
    if (changed) agentSteerDrains.get(sessionId)?.explicitSteers.delete(operationId)
    // Archive/restore preserve the original tuple; neither grants input permission nor wakes a drain.
    // Flush the local debounce and await the existing platform flush request before returning.
    // That owner's void flushStorageData call is not a disk/fsync ACK; actual restart retention
    // needs its own evidence. A failed request retains the current record and reports its cause.
    try {
      await flushMessageWorkbench(false)
    } catch (error) { get().reportWorkbenchSaveFailure(error); throw error }
    return { changed, entry: result }
  },
  editQueuedAgentSteer(sessionId, operationId, expectedText, nextText) {
    if (!nextText.trim() || nextText.includes('\0')) {
      throw controlFailure('INVALID_AGENT_PROMPT', 'The edited message is empty or exceeds the input budget. Your original message is kept.')
    }
    set(state => {
      const queue = state.agentSteerQueues[sessionId]
      const entry = queue?.find(item => item.operationId === operationId)
      if (!entry) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'This pending message is no longer available. No replacement was created.')
      if (!agentSteerCanEdit(entry, state.agentSteerInFlight[sessionId])) {
        throw controlFailure('AGENT_PROMPT_INPUT_UNCONFIRMED', 'This message is preparing, submitted or its original delivery is unknown. Its original text and input are kept; you can still read and copy it.')
      }
      if (entry.text !== expectedText) {
        throw controlFailure('CONTROL_REQUEST_CONFLICT', 'This pending message changed while you were editing. The current message is kept.')
      }
      if (agentPromptExceedsBudget(composeAgentPrompt(nextText, entry.agentMuxNote).text)) {
        throw controlFailure('INVALID_AGENT_PROMPT', 'The edited message exceeds the input budget. Your original message is kept.')
      }
      if (entry.text === nextText) return state
      return { agentSteerQueues: { ...state.agentSteerQueues,
        [sessionId]: queue!.map(item => item.operationId === operationId ? { ...item, text: nextText } : item) } }
    })
    // Saving changes only the original intent. It never grants execution or wakes its consumer.
  },
  moveAgentSteer(sessionId, operationId, direction) {
    set((state) => {
      // The mailbox hides confirmed delivery too. Resolve adjacency from the same pending facts.
      const current = reconcileDeliveredSteers(state, sessionId)
      const queue = current.agentSteerQueues[sessionId]
      if (!queue) return current
      const active = queue.filter(entry => !entry.archived)
      const activeIndex = active.findIndex(entry => entry.operationId === operationId)
      const index = queue.findIndex(entry => entry.operationId === operationId)
      const neighborId = active[activeIndex + (direction === 'up' ? -1 : 1)]?.operationId
      const adjacent = queue.findIndex(entry => entry.operationId === neighborId)
      const entry = queue[index], neighbor = queue[adjacent]
      if (!entry || entry.archived || !neighbor) return current
      const sending = current.agentSteerInFlight[sessionId]
      if (entry.operationId === sending || neighbor.operationId === sending) return current
      const next = [...queue]
      next[index] = neighbor
      next[adjacent] = entry
      return { agentSteerQueues: { ...current.agentSteerQueues, [sessionId]: next } }
    })
    // Rearranging intent grants no execution permission and does not wake the consumer.
  },
  async resendRefusedAgentSteer(sessionId, operationId) {
    let entry = get().agentSteerQueues[sessionId]?.find(item => item.operationId === operationId)
    const session = get().sessions.find(item => item.id === sessionId)
    const fact = session?.kind === 'agent' ? session.promptInputNotApplied : undefined
    const whollyRefused = entry && !entry.archived && entry.promptCondition && session?.kind === 'agent' &&
      session.hostId === session.control.hostId && session.control.agentSessionId === sessionId &&
      entry.runId === session.control.run.runId && entry.promptCondition.expectedRun.runId === entry.runId &&
      fact?.submissionId === operationId && fact.run.runId === entry.runId
    if (!whollyRefused) return get().sendQueuedAgentSteer(sessionId, operationId)
    // Goal business input identities belong to their original owner. A queue resend
    // cannot bypass that contract by copying its metadata onto a new operation.
    if (entry.browserInput) throw controlFailure('AGENT_PROMPT_CONDITION_CHANGED',
      'The original captured message was not applied. Its text and scene are kept. Move its words to a new draft instead of attaching the old capture to a new input identity.')
    if (entry.goalContinuation || entry.goalPmo || entry.goalDispatch) {
      return get().sendQueuedAgentSteer(sessionId, operationId).catch(error => {
        error.message += '\n原 Goal 业务输入已保留。请在原 Goal 查看并明确建立新的业务输入，或另写一条普通消息。'
        throw error
      })
    }
    const newOperationId = mintObjectId()
    let changed = false
    set(state => {
      const current = state.agentSteerQueues[sessionId]
      if (current?.find(item => item.operationId === operationId) !== entry ||
        state.sessions.find(item => item.id === sessionId) !== session ||
        state.agentSteerInFlight[sessionId] === operationId) return state
      const { error: _error, errorCode: _code, logId: _log, preparationWait: _wait,
        preparationInputNotApplied: _safe, awaitingExplicitSend: _pause, ...original } = entry
      const next: AgentSteerQueueEntry = { ...original, operationId: newOperationId, enqueuedAt: Date.now(),
        promptCondition: null, status: 'queued', awaitingExplicitSend: true }
      changed = true
      return { agentSteerQueues: { ...state.agentSteerQueues, [sessionId]: current.flatMap(item =>
        item === entry ? [{ ...entry, archived: true as const }, next] : [item]) } }
    })
    if (!changed) return get().sendQueuedAgentSteer(sessionId, operationId)
    // The existing ordered owner freezes/persists the new condition before input.
    // Its failure belongs to the new operation; it must not rewrite the old refusal.
    return get().sendQueuedAgentSteer(sessionId, newOperationId)
  },
  async sendQueuedAgentSteer(sessionId, operationId) {
    let entry = get().agentSteerQueues[sessionId]?.find(item => item.operationId === operationId)
    const session = get().sessions.find(item => item.id === sessionId)
    if (entry?.freshComposerIntent && !entry.resumeInputIntent && !entry.directInputBinding && !entry.inputIntakeStarted && entry.promptCondition === null &&
        get().agentSteerInFlight[sessionId] !== operationId && !entry.goalContinuation && !entry.goalPmo && !entry.goalDispatch) {
      const binding = manualComposerBinding(sessionId, 'manual', { ...(entry.execution === undefined ? {} : { execution: entry.execution }), ...(entry.browserInput ? { browserInput: entry.browserInput } : {}), ...(entry.browserRecipient ? { browserRecipient: entry.browserRecipient } : {}) })
      if (binding && session?.kind === 'agent') {
        entry = { ...entry, directInputBinding: binding, directInputControl: structuredClone(entry.browserRecipient ?? entry.browserInput?.control ?? session.control), runId: binding.expectedRun.runId, execution: 'immediate' }
        const selected = entry
        set(current => ({ agentSteerQueues: { ...current.agentSteerQueues, [sessionId]: (current.agentSteerQueues[sessionId] ?? []).map(item =>
          item.operationId === operationId ? selected : item) } }))
      }
    }
    if (entry?.errorCode === 'AGENT_PROMPT_CONDITION_CHANGED') throw controlFailure('AGENT_PROMPT_CONDITION_CHANGED',
        'This original send condition changed. Inspect the conversation and move its authored text to the draft before explicitly sending a new message.',
        { controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    const attemptKey = JSON.stringify([sessionId, operationId])
    const admission = manualSteerAttempts.get(attemptKey)
    const retainedControl = entry?.directInputBinding ? entry.directInputControl : undefined
    const seed = admission?.stage === 'queue-admission' ? admission.seed : startDeliveryAttempt({ agentSessionId: retainedControl?.agentSessionId ?? (session?.kind === 'agent' ? session.control.agentSessionId : sessionId),
      operationId, hostId: retainedControl?.hostId ?? session?.hostId ?? null, condition: entry?.promptCondition,
      ...(entry?.execution ? { execution: entry.execution } : {}),
      ...(entry ? { prompt: composeAgentPrompt(entry.text, entry.agentMuxNote).text } : {}) })
    const attempt: SteerDeliveryAttempt = admission?.stage === 'queue-admission' ? admission : { seed, stage: 'queue-validation' }
    attempt.stage = 'queue-validation'
    try {
      if (!entry) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'The selected original message is no longer in the pending queue.')
      if (entry.archived) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'The selected original message is archived. Restore it before choosing Send.')

      if (get().agentSteerInFlight[sessionId] === operationId) throw controlFailure('AGENT_PROMPT_SUBMISSION_BUSY', 'This original message already has an active send attempt. Its original input is kept.')
      if (!entry.directInputBinding && session?.kind !== 'agent') throw controlFailure('UNKNOWN_AGENT_SESSION', 'The original Agent Session is unavailable. No replacement or input was created.')
      const currentRunId = session?.kind === 'agent' ? session.control.run.runId : undefined
      if (entry.browserRecipient && !entry.directInputBinding && !entry.resumeInputIntent && session?.kind === 'agent' &&
          (session.control.hostId !== entry.browserRecipient.hostId || session.control.run.runId !== entry.browserRecipient.run.runId)) {
        throw controlFailure('STALE_AGENT_SESSION', 'The original captured recipient changed. This message is kept for inspection; no new Run was selected.')
      }
      const changedRun = currentRunId !== undefined && entry.runId !== undefined && !steerEntryTargetsRun(entry, currentRunId)
      if (!entry.directInputBinding && changedRun && (entry.promptCondition !== null || entry.goalContinuation !== undefined)) {
        throw controlFailure('STALE_AGENT_SESSION', `The original delivery belongs to Run ${entry.runId}; the Session now points to Run ${currentRunId}. Inspect the original delivery before sending it to another Run.`, {
          detail: JSON.stringify({ queuedRunId: entry.runId, currentRunId,
            conditionState: entry.promptCondition === undefined ? 'unknown' : 'bound' })
        })
      }
      manualSteerAttempts.set(attemptKey, attempt)
      if (changedRun && entry.browserRecipient) throw controlFailure('STALE_AGENT_SESSION',
        'This opinion belongs to the original captured Run. Its message and capture are retained; inspect that delivery before composing a new opinion.')
      const rebindRun = changedRun && !entry.directInputBinding
      set(state => ({ agentSteerQueues: { ...state.agentSteerQueues,
        [sessionId]: state.agentSteerQueues[sessionId]!.map(item => {
          if (item.operationId !== operationId) return item
          const { awaitingExplicitSend: _pause, preparationWait: _wait, preparationInputNotApplied: _safe, ...pending } = item
          // A new explicit selection binds a never-dispatched intent, just like admission.
          // The ordered consumer still freezes fresh Core conditions before real input.
          return { ...pending, ...(rebindRun ? { runId: currentRunId } : {}),
            status: item.status === 'restoring' ? 'restoring' : 'queued' }
        }) } }))
      attempt.stage = 'ordered-queue'
      const pending = get().flushAgentSteerQueue(sessionId, operationId)
      const originalDrain = agentSteerDrains.get(sessionId)
      await pending
      const carrier = get().agentSteerQueues[sessionId]?.find(item => item.operationId === operationId)?.resumeInputReceipt
      if (carrier?.state === 'launch-carried' || carrier?.state === 'terminal-confirmed') return 'submitted'
      if (carrier?.state === 'not-applied') return 'unconfirmed'
      if (originalDrain?.submitted.has(operationId) || !entry.directInputBinding && confirmedSteerDelivery(get().timelines[sessionId], session?.kind === 'agent' ? session.control : undefined, operationId)) return 'submitted'
      if (originalDrain?.failures.has(operationId)) throw originalDrain.failures.get(operationId)
      // Core owns accepted waiting after its typed receipt. It is not a failed
      // submission, and another caller must not dispatch it through a second route.
      const receipt = get().agentSteerQueues[sessionId]?.find(item => item.operationId === operationId)?.inputReceipt
      if (receipt) return (receipt.status === 'admitted' || receipt.status === 'terminal-confirmed') ? 'submitted' : 'unconfirmed'
      if (originalDrain?.waitingForInteraction.has(operationId)) return 'unconfirmed'
      throw controlFailure('AGENT_PROMPT_INPUT_UNCONFIRMED', 'The original selection left the ordered consumer without a confirmed submission. No new operation was created; inspect the original queue and retry this message.')
    } catch (error) {
      const failure = describeError(error)
      const diagnostic = attempt.diagnostic ?? await recordMessageDeliveryFailure(attempt.seed, error, attempt.stage)
      const reason = `${failure.message}${failure.code ? ` [${failure.code}]` : ''}${failure.detail ? `\n${failure.detail}` : ''}`
      const message = `${reason}\nlogid: ${diagnostic.logId}\n${diagnostic.notice}`
      set(state => {
        const queue = state.agentSteerQueues[sessionId]
        if (!queue) return state
        return { agentSteerQueues: { ...state.agentSteerQueues, [sessionId]: queue.map(item =>
          !item.archived && item.operationId === operationId && item.text === entry?.text && item.agentMuxNote === entry?.agentMuxNote && item.sourceChannel === entry?.sourceChannel &&
            JSON.stringify(item.browserInput) === JSON.stringify(entry?.browserInput) && JSON.stringify(item.browserRecipient) === JSON.stringify(entry?.browserRecipient)
            ? { ...item, awaitingExplicitSend: true as const, error: reason, logId: diagnostic.logId,
                ...(failure.code ? { errorCode: failure.code } : {}), status: 'deferred' as const } : item) } }
      })
      // The failure is visible in the original record and action feedback. Explicit retry
      // remains available; this refusal never grants a background wake permission.
      const controlFailure = deliveryFailure(error).controlFailure
      throw Object.assign(new Error(message), { ...(failure.code ? { code: failure.code } : {}),
        ...(failure.detail ? { detail: failure.detail } : {}), ...(controlFailure ? { controlFailure } : {}),
        cause: error, logId: diagnostic.logId })
    } finally {
      if (manualSteerAttempts.get(attemptKey) === attempt) manualSteerAttempts.delete(attemptKey)
    }
  },
  async cancelAgentSteerPreparation(sessionId, operationId) {
    const entry = get().agentSteerQueues[sessionId]?.find(item => item.operationId === operationId)
    if (entry?.inputReceipt) {
      const control = entry.directInputControl
      if (!control || control.agentSessionId !== entry.inputReceipt.key.agentSessionId || control.run.runId !== entry.inputReceipt.key.expectedRun.runId) return false
      const ref = entry.inputReceipt.ref
      const previous = entry.inputStopIntent
      const intent = previous && previous.ref.waitGeneration === ref.waitGeneration && previous.ref.key.kind === ref.key.kind &&
        previous.ref.key.agentSessionId === ref.key.agentSessionId && previous.ref.key.expectedRun.runId === ref.key.expectedRun.runId
        ? previous : { ref: structuredClone(ref), cancelOperationId: mintObjectId() }
      set(current => ({ agentSteerQueues: { ...current.agentSteerQueues, [sessionId]: (current.agentSteerQueues[sessionId] ?? []).map(item =>
        item.operationId === operationId ? { ...item, inputStopIntent: intent } : item) } }))
      const stopped = await api.sessions.stopInputWaiting(control, intent.ref, intent.cancelOperationId)
      // The original stop ACK is already known. A later read failure must not
      // discard it or replace that original cancellation operation with a new identity.
      set(current => ({ agentSteerQueues: { ...current.agentSteerQueues, [sessionId]: (current.agentSteerQueues[sessionId] ?? []).map(item =>
        item.operationId === operationId ? { ...item, inputStopReceipt: stopped } : item) } }))
      try {
        const projection = await api.sessions.inspectInput(control, entry.inputReceipt.key)
        if (projection) consumeInputReceipt(sessionId, projection)
      } catch (error) { get().reportError(error) }
      return stopped.outcome === 'stopped-before-dispatch' || stopped.outcome === 'observation-stopped'
    }
    const active = preparationRetryCalls.get(JSON.stringify([sessionId, operationId]))
    if (!active || active.signal.aborted || entry?.preparationWait?.state !== 'waiting') return false
    active.abort()
    set(state => ({ agentSteerQueues: { ...state.agentSteerQueues, [sessionId]:
      (state.agentSteerQueues[sessionId] ?? []).map(item => item.operationId === operationId
        ? { ...item, preparationWait: { ...entry.preparationWait!, state: 'stopped', nextAttemptAt: null } } : item) } }))
    return true
  },
  flushAgentSteerQueue(sessionId, explicitOperationId) {
    set((state) => reconcileDeliveredSteers(state, sessionId))
    const current = get()
    const target = current.sessions.find(item => item.id === sessionId)
    const selected = current.agentSteerQueues[sessionId]?.find(entry => entry.operationId === explicitOperationId)
    // Controlled input keeps its original Core route even when its presentation is absent.
    const requested = explicitOperationId !== undefined && selected && !selected.archived &&
      (selected.directInputBinding || target?.kind === 'agent' && (selected.runId === undefined || steerEntryTargetsRun(selected, target.control.run.runId)))
      ? explicitOperationId : undefined
    if (requested !== undefined && selected?.promptCondition === null && selected.execution === undefined) {
      // Accept the exact user's selection synchronously. Async coordination is not its owner:
      // recovery, interaction and storage waits retain this choice in the one durable queue.
      const execution = selected.directInputBinding ? 'immediate' : target?.kind === 'agent' ? agentSteerExecution(selected, target.capabilities) : undefined
      if (execution !== undefined) set(state => ({ agentSteerQueues: { ...state.agentSteerQueues,
        [sessionId]: state.agentSteerQueues[sessionId]!.map(entry =>
          entry.operationId === requested && entry.promptCondition === null && entry.execution === undefined
            ? { ...entry, execution } : entry) } }))
    }
    const active = agentSteerDrains.get(sessionId)
    if (active) {
      if (requested !== undefined) active.explicitSteers.add(requested)
      active.wake = true
      return active.promise
    }
    const selectedIds = (get().agentSteerQueues[sessionId] ?? []).filter(entry =>
      (!entry.directInputBinding || entry.freshComposerIntent && !entry.inputIntakeStarted && !entry.inputReceipt) &&
      !entry.archived && !entry.awaitingExplicitSend && entry.promptCondition === null && entry.execution !== undefined)
      .map(entry => entry.operationId)
    const drain = { promise: Promise.resolve(), wake: false, explicitSteers: new Set<string>([...selectedIds, ...(requested ? [requested] : [])]), submitted: new Set<string>(), failures: new Map<string, unknown>(), waitingForInteraction: new Set<string>() }
    const retainWaitingSelections = (runId: string): void => {
      for (const item of get().agentSteerQueues[sessionId] ?? []) {
        if (!item.archived && !item.awaitingExplicitSend && item.runId === runId &&
          item.promptCondition === null && item.execution !== undefined) drain.waitingForInteraction.add(item.operationId)
      }
    }
    drain.promise = Promise.resolve().then(async () => {
      try {
        for (;;) {
          drain.wake = false
          // Every await can change the queue, Run, connection or interaction. Never retain a tail.
          const state = get()
          let session = state.sessions.find((item) => item.id === sessionId)
          const refuseSelections = (code: AgentMuxControlErrorCode, reason: string) => {
            for (const id of drain.explicitSteers) drain.failures.set(id, controlFailure(code, reason))
          }
          const sessionHostId = session?.hostId
          const endpointIssue = state.runtimeEndpointWarnings?.find(warning => warning.scope !== 'observation' && warning.hostId === sessionHostId && warning.availability !== 'connected')
          if (endpointIssue && drain.explicitSteers.size === 0) { refuseSelections('CONTROL_UNAVAILABLE', `Original Host ${sessionHostId} endpoint is ${endpointIssue.availability}: ${endpointIssue.message}`); return }
          const currentRunId = session?.kind === 'agent' ? session.control.run.runId : undefined
          const pendingEntries = state.agentSteerQueues[sessionId]?.filter(item =>
            (!item.directInputBinding || drain.explicitSteers.has(item.operationId) || item.freshComposerIntent && !item.inputIntakeStarted && !item.inputReceipt) &&
            !item.archived && !item.awaitingExplicitSend &&
            (item.directInputBinding && drain.explicitSteers.has(item.operationId) || currentRunId !== undefined && (item.runId === undefined || steerEntryTargetsRun(item, currentRunId))))
          // Explicit steer selects its exact intent, leaving queue-only work untouched. Multiple
          // explicit requests retain their author order in this one queue, including across awaits.
          const entry = pendingEntries?.find(item => drain.explicitSteers.has(item.operationId)) ??
            pendingEntries?.find(item => item.promptCondition === null && item.execution !== undefined) ?? pendingEntries?.[0]
          if (!entry) {
            if (session?.kind !== 'agent') refuseSelections('UNKNOWN_AGENT_SESSION', 'The original Agent Session disappeared before queue dispatch.')
            else refuseSelections('CONTROL_REQUEST_CONFLICT', 'The selected original message is archived, paused or belongs to a different Run before dispatch.')
            return
          }
          if (!entry.directInputBinding && session?.kind === 'agent' && entry.goalDispatch && confirmedSteerDelivery(state.timelines[sessionId], session.control, entry.operationId)) {
            try {
              await api.demands.reconcileDispatch(entry.goalDispatch)
              await get().refreshDemand(entry.goalDispatch.goalId)
              set(current => ({ agentSteerQueues: { ...current.agentSteerQueues, [sessionId]: (current.agentSteerQueues[sessionId] ?? []).filter(item => item.operationId !== entry.operationId) } }))
              drain.submitted.add(entry.operationId); continue
            } catch (error) {
              drain.failures.set(entry.operationId, error)
              set(current => ({ agentSteerQueues: { ...current.agentSteerQueues, [sessionId]: (current.agentSteerQueues[sessionId] ?? []).map(item => item.operationId === entry.operationId ? { ...item, status: 'deferred', awaitingExplicitSend: true, error: presentError(error) } : item) } }))
              throw error
            }
          }
          if (!entry.directInputBinding && session?.kind === 'agent' && entry.goalPmo?.creationOperationId !== undefined && confirmedSteerDelivery(state.timelines[sessionId], session.control, entry.operationId)) {
            try {
              await api.demands.reconcilePmoInput(entry.goalPmo, session.control, entry.operationId)
              await get().refreshDemand(entry.goalPmo.goalId)
              set(current => ({ agentSteerQueues: { ...current.agentSteerQueues,
                [sessionId]: (current.agentSteerQueues[sessionId] ?? []).filter(item => item.operationId !== entry.operationId) } }))
              drain.submitted.add(entry.operationId)
              continue
            } catch (error) {
              drain.failures.set(entry.operationId, error)
              set(current => ({ agentSteerQueues: { ...current.agentSteerQueues,
                [sessionId]: (current.agentSteerQueues[sessionId] ?? []).map(item => item.operationId === entry.operationId
                  ? { ...item, status: 'deferred', awaitingExplicitSend: true, error: presentError(error) } : item) } }))
              throw error
            }
          }
          if (!entry.directInputBinding && session?.kind === 'agent' && entry.runId === currentRunId && entry.promptCondition === null && entry.execution !== undefined && session.pendingInteraction) {
            retainWaitingSelections(session.control.run.runId)
            return
          }
          if (!entry.directInputBinding && session?.kind === 'agent' && !drain.explicitSteers.has(entry.operationId) && entry.runId !== undefined && (!steerQueueCanDrainNow(session) || session.status.state === 'disconnected')) {
            refuseSelections('CONTROL_UNAVAILABLE', session.pendingInteraction ? 'The original Agent is waiting for an interaction response. Answer it before retrying this message.' : `Original Run ${session.control.run.runId} is ${session.processState}; Agent status is ${session.status.state}${session.status.detail ? `: ${session.status.detail}` : ''}`)
            return
          }
          // The set joins active callers; only a known unsubmitted original selection can
          // outlive it. Unknown/historical or boot-paused inputs never gain auto-retry authority.
          const explicitAttempt = drain.explicitSteers.delete(entry.operationId) ||
            entry.promptCondition === null && entry.execution !== undefined
          if (!explicitAttempt && entry.promptCondition === null && session?.kind === 'agent' && session.status.state === 'working') return
          if (!explicitAttempt && entry.promptCondition !== null) {
            // A prepared durable intent may already have crossed admission. A late completion,
            // startup or reconnect wake is no proof that it was never delivered. Only a fresh
            // receipt reconciles it; an explicit user retry keeps its original Core identity.
            set((current) => ({ agentSteerQueues: { ...current.agentSteerQueues,
              [sessionId]: current.agentSteerQueues[sessionId]!.map(item => item.operationId === entry.operationId
                ? { ...item, status: 'deferred', error: item.error ?? 'The original message delivery is unconfirmed after reconnect. Inspect the outbox before retrying.' } : item) } }))
            return
          }
          // Capture before recovery: a newly restored binding grants no save bypass.
          const explicitlyBound = explicitAttempt && currentRunId !== undefined && entry.runId === currentRunId
          let preparedHere = false
          let dispatchStarted = false
          const attemptControl = entry.directInputBinding ? entry.directInputControl : session?.kind === 'agent' ? session.control : undefined
          const attemptHostId = attemptControl?.hostId ?? null
          const attemptSessionId = attemptControl?.agentSessionId ?? sessionId
          let attemptRunId = entry.runId
          let attemptCondition = entry.promptCondition
          let attemptExecution = entry.execution
          const deliveryAttempt = manualSteerAttempts.get(JSON.stringify([sessionId, entry.operationId])) ?? {
            seed: startDeliveryAttempt({ agentSessionId: attemptSessionId, operationId: entry.operationId, hostId: attemptHostId,
              condition: entry.promptCondition, ...(entry.execution ? { execution: entry.execution } : {}),
              prompt: composeAgentPrompt(entry.text, entry.agentMuxNote).text }), stage: 'queue-preparation'
          } as SteerDeliveryAttempt
          const matchesAttempt = (item: AgentSteerQueueEntry) =>
            !item.archived && item.operationId === entry.operationId && item.runId === attemptRunId &&
            item.text === entry.text && item.agentMuxNote === entry.agentMuxNote &&
            item.sourceChannel === entry.sourceChannel && JSON.stringify(item.browserInput) === JSON.stringify(entry.browserInput) && JSON.stringify(item.browserRecipient) === JSON.stringify(entry.browserRecipient) && reactionIntentKey(item.reaction) === reactionIntentKey(entry.reaction) && JSON.stringify(item.goalContinuation) === JSON.stringify(entry.goalContinuation) && JSON.stringify(item.goalPmo) === JSON.stringify(entry.goalPmo) && JSON.stringify(item.goalDispatch) === JSON.stringify(entry.goalDispatch) &&
            (!dispatchStarted || item.execution === attemptExecution) &&
            (item.promptCondition === null) === (attemptCondition === null) &&
            item.promptCondition?.expectedRun.runId === attemptCondition?.expectedRun.runId &&
            item.promptCondition?.afterSubmissionId === attemptCondition?.afterSubmissionId
          set((current) => ({
            agentSteerInFlight: { ...current.agentSteerInFlight, [sessionId]: entry.operationId },
            agentSteerInFlightPhase: { ...current.agentSteerInFlightPhase, [sessionId]: 'preparing' }
          }))
          try {
            // Persisted projection failures keep this original message; never strip its context and send plain text.
            if (entry.browserInput) frozenBrowserInput(entry.browserInput, attemptSessionId, entry.operationId, entry.text, entry.agentMuxNote)
            if (entry.directInputBinding) {
              const control = entry.directInputControl
              if (!control || control.agentSessionId !== sessionId || control.run.runId !== entry.directInputBinding.expectedRun.runId) throw controlFailure(
                'CONTROL_REQUEST_CONFLICT', 'The original manual input control is missing or conflicts with its bound Session and Run. The original key is retained; no current-route replacement was used.')
              // All producers share this consumer, including the asynchronous read
              // before first Core intake. Core serializes any subsequent accepted waiting.
              deliveryAttempt.stage = 'core-submit'
              set(current => ({ agentSteerQueues: { ...current.agentSteerQueues,
                [sessionId]: (current.agentSteerQueues[sessionId] ?? []).map(item => item.operationId === entry.operationId
                  ? { ...item, inputIntakeStarted: true as const } : item) } }))
              const observed = await api.sessions.inspectInput(control, { kind: 'prompt', agentSessionId: sessionId,
                expectedRun: entry.directInputBinding.expectedRun, submissionId: entry.operationId })
              dispatchStarted = true
              const receipt = observed
                ? observed.status === 'stopped' || observed.status === 'waiting' && (observed.observation === 'rejoin-needed' || observed.control.waiting?.wake === 'explicit-rejoin')
                  ? await api.sessions.rejoinInputWaiting(control, observed.ref) : observed
                : await api.sessions.submitPrompt(control, entry.text, entry.operationId, entry.directInputBinding,
                    { execution: 'immediate' }, entry.origin === 'manual', entry.agentMuxNote, entry.sourceChannel, undefined, undefined, undefined, entry.browserInput?.capture.reference)
              if (!receipt) throw controlFailure('AGENT_PROMPT_INPUT_UNCONFIRMED', 'The original manual input has no typed receipt. Its text and identity are retained.')
              consumeInputReceipt(sessionId, receipt)
              if (receipt.status === 'admitted' || receipt.status === 'terminal-confirmed') drain.submitted.add(entry.operationId)
              if (!get().agentSteerQueues[sessionId]?.some(item => drain.explicitSteers.has(item.operationId))) return
              continue
            }
            if (session?.kind !== 'agent') throw controlFailure('UNKNOWN_AGENT_SESSION', 'The original Agent Session disappeared before queue dispatch. No replacement or input was created.')
            if (entry.runId === undefined || entry.resumeInputIntent) {
              set((current) => ({ agentSteerQueues: { ...current.agentSteerQueues,
                [sessionId]: current.agentSteerQueues[sessionId]!.map(item => {
                  if (item.operationId !== entry.operationId) return item
                  return { ...item, status: 'restoring' }
                }) } }))
              deliveryAttempt.stage = 'session-recovery'
              const resumeInputIntent = entry.resumeInputIntent ?? (entry.freshComposerIntent && entry.promptCondition === null
                ? { control: structuredClone(entry.browserRecipient ?? entry.browserInput?.control ?? session.control), input: { submissionId: entry.operationId, prompt: entry.text,
                    ...(entry.browserInput ? { inputContextCapture: entry.browserInput.capture.reference } : {}),
                    ...(entry.agentMuxNote === undefined ? {} : { agentMuxNote: entry.agentMuxNote }),
                    ...(entry.origin === 'manual' ? { authorHuman: true } : {}), sourceChannel: entry.sourceChannel ?? 'message-tool' } } : undefined)
              if (resumeInputIntent) set(current => ({ agentSteerQueues: { ...current.agentSteerQueues,
                [sessionId]: current.agentSteerQueues[sessionId]!.map(item => item.operationId === entry.operationId
                  ? { ...item, resumeInputIntent, inputIntakeStarted: true as const } : item) } }))
              const recovered = await get().recoverSession(sessionId, entry.operationId, { trigger: 'input',
                ...(resumeInputIntent ? { input: resumeInputIntent.input, inputControl: resumeInputIntent.control } : {}) })
              if (!recovered || recovered.kind !== 'agent' || recovered.processState !== 'running') {
                throw new Error(get().sessions.find(item => item.id === sessionId)?.status.detail ??
                  'Session restoration did not produce a running Agent. Your message is kept.')
              }
              session = recovered
              attemptRunId = recovered.control.run.runId
              set((current) => {
                const entries = current.agentSteerQueues[sessionId]
                if (!entries?.some(item => item.operationId === entry.operationId)) return current
                return { agentSteerQueues: { ...current.agentSteerQueues,
                  [sessionId]: entries.map(item =>
                    item.operationId === entry.operationId && item.runId === undefined
                      ? { ...item, runId: recovered.control.run.runId } : item) } }
              })
              if (resumeInputIntent) {
                const receipt = originalResumeInputReceipt(recovered, { ...entry, resumeInputIntent })
                if (!receipt) throw new Error('The original recovery input delivery is unconfirmed. The message and its operation are kept; inspect this recovery before retrying.')
                if (receipt.state === 'not-applied') {
                  set(current => projectResumeInputReceipts(current, sessionId))
                  return
                }
                set(current => ({ agentSteerQueues: { ...current.agentSteerQueues,
                  [sessionId]: current.agentSteerQueues[sessionId]!.map(item => {
                    if (item.operationId !== entry.operationId) return item
                    const { error: _error, errorCode: _code, awaitingExplicitSend: _paused, ...original } = item
                    return { ...original, runId: recovered.control.run.runId, resumeInputReceipt: structuredClone(receipt),
                      inputIntakeStarted: true as const, archived: true as const, status: 'deferred' as const }
                  }) } }))
                drain.submitted.add(entry.operationId)
                continue
              }
            }
            let pending = get().agentSteerQueues[sessionId]?.find(item => item.operationId === entry.operationId)
            if (!pending) return
            if (pending.status === 'restoring') {
              deliveryAttempt.stage = 'queue-persistence'
              await flushMessageWorkbench(explicitlyBound)
              // The exact binding precedes dispatch. Electron's void flush request is not fsync.
              set((current) => {
                const entries = current.agentSteerQueues[sessionId]
                if (!entries?.some(item => item.operationId === entry.operationId)) return current
                return { agentSteerQueues: { ...current.agentSteerQueues,
                [sessionId]: entries.map(item => {
                  if (item.operationId !== entry.operationId) return item
                  return { ...item, status: 'queued' }
                }) } }
              })
            }
            pending = get().agentSteerQueues[sessionId]?.find(item => item.operationId === entry.operationId)
            session = get().sessions.find(item => item.id === sessionId)
            if (!pending || session?.kind !== 'agent') { if (explicitAttempt) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'The selected original message or Agent Session changed during preparation.'); return }
            if (!steerEntryTargetsRun(pending, session.control.run.runId)) throw new Error(
              'The bound Run changed before dispatch. The delivery result is unknown; this message will not be sent to another Run.')
            if (!explicitAttempt && (!steerQueueCanDrainNow(session) || session.status.state === 'disconnected')) return
            if (pending.promptCondition === undefined) throw new Error(
              'The original message delivery condition is unknown. This message is kept; compose a new message or use the terminal.')
            if (pending.promptCondition === null) {
              // Queue tails bind only as they reach dispatch. The public refresh reads Core's
              // admission identity; activity status and timeline receipts cannot replace it.
              deliveryAttempt.stage = 'condition-refresh'
              const fresh = await api.sessions.refresh(session.control)
              if (fresh.kind !== 'agent' || fresh.hostId !== attemptHostId || fresh.control.hostId !== attemptHostId ||
                fresh.control.agentSessionId !== attemptSessionId || fresh.control.run.runId !== pending.runId) throw new Error(
                'The original Session binding changed before message preparation. Your message is kept without dispatch.')
              if (pending.execution !== undefined && fresh.pendingInteraction) {
                if (drain.wake) continue
                retainWaitingSelections(fresh.control.run.runId)
                return
              }
              const condition = validateAgentPromptCondition({ expectedRun: fresh.control.run,
                afterSubmissionId: fresh.promptSubmissionPredecessor })
              if (!explicitAttempt && (!steerQueueCanDrainNow(fresh) || fresh.status.state === 'disconnected')) return
              if (!explicitAttempt && fresh.status.state === 'working') return
              const execution = explicitAttempt ? (pending.execution ?? 'default') : 'default'
              if (execution === 'immediate' && fresh.capabilities.promptExecution?.immediate !== 'terminal-submit' && fresh.capabilities.promptExecution?.immediate !== 'interrupt-before-input') {
                throw new Error('The original immediate-send capability is unconfirmed for this Run. Your original message and execution choice are kept; retry Send or use the terminal.')
              }
              set(current => ({ agentSteerQueues: { ...current.agentSteerQueues,
                [sessionId]: current.agentSteerQueues[sessionId]!.map(item =>
                  item.operationId === entry.operationId ? { ...item, promptCondition: condition,
                    ...(explicitAttempt ? { execution } : {}) } : item) } }))
              attemptCondition = condition
              preparedHere = true
            }
            deliveryAttempt.stage = 'queue-persistence'
            await flushMessageWorkbench(explicitlyBound)
            pending = get().agentSteerQueues[sessionId]?.find(item => item.operationId === entry.operationId)
            session = get().sessions.find(item => item.id === sessionId)
            if (!pending || session?.kind !== 'agent') { if (explicitAttempt) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'The selected original message or Agent Session changed during preparation.'); return }
            const condition = validateAgentPromptCondition(pending.promptCondition)
            if (session.hostId !== attemptHostId || session.control.hostId !== attemptHostId ||
              session.control.agentSessionId !== attemptSessionId || !matchesAttempt(pending) ||
              !steerEntryTargetsRun(pending, session.control.run.runId) || condition.expectedRun.runId !== session.control.run.runId) throw new Error(
              'The original message or Session binding changed before dispatch. Your message is kept without dispatch.')
            set((current) => ({ agentSteerInFlightPhase: {
              ...current.agentSteerInFlightPhase, [sessionId]: 'submitting'
            } }))
            // After this invocation, even a BUSY/error can belong to another client joining
            // this exact operation. Only Core receipts can settle it; never reconstruct input.
            attemptExecution = pending.execution
            deliveryAttempt.seed = Object.freeze({ ...deliveryAttempt.seed, expectedRunId: condition.expectedRun.runId,
              afterSubmissionId: condition.afterSubmissionId, conditionAvailable: true, execution: pending.execution ?? 'default' })
            deliveryAttempt.stage = 'core-submit'
            dispatchStarted = true
            const retryKey = JSON.stringify([sessionId, entry.operationId]), retryCall = new AbortController()
            preparationRetryCalls.set(retryKey, retryCall)
            const retryTarget = session, retryMessage = pending
            const currentRetryIntent = () => {
              const current = get(), target = current.sessions.find(item => item.id === sessionId)
              const original = current.agentSteerQueues[sessionId]?.find(item => item.operationId === entry.operationId)
              return target?.kind === 'agent' && target.processState === 'running' && !target.pendingInteraction &&
                target.hostId === attemptHostId && target.control.hostId === attemptHostId && target.control.agentSessionId === attemptSessionId &&
                target.control.run.runId === attemptRunId && Boolean(original && matchesAttempt(original)) &&
                !confirmedSteerDelivery(current.timelines[sessionId], target?.kind === 'agent' ? target.control : undefined, entry.operationId)
            }
            try {
              await submitWithPreparationRetry({ agentSessionId: attemptSessionId, runId: attemptRunId!, operationId: entry.operationId,
                explicit: explicitAttempt && pending.execution === 'immediate', signal: retryCall.signal, current: currentRetryIntent,
                refresh: async () => {
                  const fresh = await api.sessions.refresh(retryTarget.control)
                  return fresh.kind === 'agent' && fresh.processState === 'running' && !fresh.pendingInteraction &&
                    fresh.hostId === attemptHostId && fresh.control.hostId === attemptHostId && fresh.control.agentSessionId === attemptSessionId &&
                    fresh.control.run.runId === condition.expectedRun.runId && fresh.promptSubmissionPredecessor === condition.afterSubmissionId
                },
                progress: preparationWait => set(current => ({ agentSteerQueues: { ...current.agentSteerQueues,
                  [sessionId]: (current.agentSteerQueues[sessionId] ?? []).map(item => matchesAttempt(item) ? { ...item, preparationWait } : item) } })),
                submit: async preparationRetry => { const receipt = await api.sessions.submitPrompt(retryTarget.control, retryMessage.text, retryMessage.operationId, condition,
                  explicitAttempt ? { allowUncertainTurn: true,
                    ...(retryMessage.execution === 'immediate' ? { execution: 'immediate' as const } : {}), ...(preparationRetry ? { preparationRetry } : {}) }
                    : retryMessage.execution === 'immediate' ? { execution: 'immediate' } : undefined,
                  retryMessage.origin === 'manual', retryMessage.agentMuxNote, retryMessage.sourceChannel,
                  retryMessage.goalContinuation ? { goalId: retryMessage.goalContinuation.goalId, loopId: retryMessage.goalContinuation.loopId } : undefined, retryMessage.goalPmo, retryMessage.goalDispatch, retryMessage.browserInput?.capture.reference)
                  if (receipt) throw new Error('The original exact queue input returned a different controlled admission contract.') }
              })
            } finally { if (preparationRetryCalls.get(retryKey) === retryCall) preparationRetryCalls.delete(retryKey) }
            deliveryAttempt.stage = 'receipt-confirmation'
            if (pending.goalContinuation) await api.continuousProgress.initialGoalInput({ hostId: session.control.hostId, agentSessionId: session.control.agentSessionId, providerId: session.providerId, workspacePath: session.workspacePath }, pending.goalContinuation.loopId, pending.operationId, 'confirm')
            if (pending.goalPmo) await get().refreshDemand(pending.goalPmo.goalId)
            if (pending.goalDispatch) await get().refreshDemand(pending.goalDispatch.goalId)
            drain.submitted.add(entry.operationId)
            set((current) => {
              const target = current.sessions.find(item => item.id === sessionId)
              if (target?.kind !== 'agent' || target.hostId !== attemptHostId ||
                target.control.agentSessionId !== attemptSessionId) return current
              const next = (current.agentSteerQueues[sessionId] ?? []).filter(item => !matchesAttempt(item))
              const agentSteerQueues = { ...current.agentSteerQueues }
              if (next.length) agentSteerQueues[sessionId] = next
              else delete agentSteerQueues[sessionId]
              return { agentSteerQueues }
            })
            drain.explicitSteers.delete(entry.operationId)
            // A steer grants no background tail permission. Other explicit requests still run.
            if (!get().agentSteerQueues[sessionId]?.some(item =>
              drain.explicitSteers.has(item.operationId))) return
          } catch (error) {
            drain.failures.set(entry.operationId, error)
            const failure = describeError(error)
            deliveryAttempt.diagnostic = await recordMessageDeliveryFailure(deliveryAttempt.seed, error, deliveryAttempt.stage)
            const diagnostic = deliveryAttempt.diagnostic
            const reason = `${failure.message}${failure.code ? ` [${failure.code}]` : ''}${failure.detail ? `\n${failure.detail}` : ''}`
            // A newly prepared condition is local until the real input API is invoked.
            // Storage/read failures before that boundary cannot make delivery unknown.
            // Error names after invocation cannot prove that no other client admitted it.
            const unadmitted = preparedHere && !dispatchStarted
            // A delivery refusal is a retained local fact, not another global notification.
            set((current) => {
              const pending = current.agentSteerQueues[sessionId]
              const target = current.sessions.find(item => item.id === sessionId)
              if (!pending || !entry.directInputBinding && (target?.kind !== 'agent' || target.hostId !== attemptHostId ||
                target.control.agentSessionId !== attemptSessionId)) return current
              return {
                agentSteerQueues: {
                  ...current.agentSteerQueues,
                  [sessionId]: pending.map((item) => {
                    // An old completion cannot decorate a replacement Run, condition or body
                    // which happens to reuse the same local operation ID.
                    if (!matchesAttempt(item)) return item
                    const { errorCode: _oldCode, preparationWait: oldWait, preparationInputNotApplied: _safe, ...retained } = item
                    const wait = readAgentPromptPreparationWait(error), safeWait = wait?.retrySafe && wait.operationId === entry.operationId &&
                      wait.agentSessionId === attemptSessionId && wait.runId === attemptRunId && deliveryFailure(error).controlFailure?.disposition === 'not_applied' &&
                      deliveryFailure(error).controlFailure?.confirmedInputBytes === 0
                    return { ...retained, ...(safeWait ? { preparationInputNotApplied: true as const, ...(oldWait ? { preparationWait: oldWait } : {}) } : {}),
                      ...(unadmitted ? { promptCondition: null } : {}),
                      status: item.status === 'restoring' ? 'restoring' : 'deferred', awaitingExplicitSend: true as const, error: reason, logId: diagnostic.logId,
                      ...(failure.code ? { errorCode: failure.code } : {}) }
                  })
                }
              }
            })
            // A readiness/reconnect wake arriving during the attempt must not be lost.
            const stillPending = get().agentSteerQueues[sessionId]?.some((item) => item.operationId === entry.operationId)
            const fresh = get()
            const freshSession = fresh.sessions.find(item => item.id === sessionId)
            const explicitPending = fresh.agentSteerQueues[sessionId]?.some(item =>
              drain.explicitSteers.has(item.operationId) && !item.archived && !item.awaitingExplicitSend &&
              (item.directInputBinding || freshSession?.kind === 'agent' && (item.runId === undefined || steerEntryTargetsRun(item, freshSession.control.run.runId))))
            if (!explicitPending && (explicitAttempt || stillPending && !drain.wake)) return
          }
        }
      } finally {
        // Release this owner before notifying subscribers that its attempt has ended. A new
        // explicit send during that synchronous notification must get its own live drain.
        if (agentSteerDrains.get(sessionId) === drain) {
          agentSteerDrains.delete(sessionId)
          set((current) => {
            const agentSteerInFlight = { ...current.agentSteerInFlight }
            const agentSteerInFlightPhase = { ...current.agentSteerInFlightPhase }
            delete agentSteerInFlight[sessionId]
            delete agentSteerInFlightPhase[sessionId]
            return { agentSteerInFlight, agentSteerInFlightPhase }
          })
        }
      }
    })
    agentSteerDrains.set(sessionId, drain)
    return drain.promise
  },
  send(sessionId, text, onRejected, origin, agentMuxNote, options) {
    // Admission transfers ownership from draft to queue; transport completion is a separate fact.
    const operationId = mintObjectId(), session = get().sessions.find(item => item.id === sessionId)
    const seed = startDeliveryAttempt({ agentSessionId: session?.kind === 'agent' ? session.control.agentSessionId : sessionId,
      operationId, hostId: session?.hostId ?? null, prompt: composeAgentPrompt(text, agentMuxNote).text })
    const reject = (error: unknown) => {
      const failure = describeError(error)
      void recordMessageDeliveryFailure(seed, error, 'queue-admission').then(diagnostic => {
        const message = `${failure.message}${failure.code ? ` [${failure.code}]` : ''}${failure.detail ? `\n${failure.detail}` : ''}\nlogid: ${diagnostic.logId}\n${diagnostic.notice}`
        const show = onRejected ?? get().reportError
        show(Object.assign(new Error(message), { cause: error,
          ...(failure.code ? { code: failure.code } : {}), logId: diagnostic.logId }))
      })
    }
    if (admitAgentSteer(sessionId, text, reject, operationId, origin, agentMuxNote, options, manualComposerBinding(sessionId, origin, options)) === false) return false
    manualSteerAttempts.set(JSON.stringify([sessionId, operationId]), { seed, stage: 'queue-admission' })
    void get().sendQueuedAgentSteer(sessionId, operationId).catch(error => (onRejected ?? get().reportError)(error))
    return true
  },
  async inspectInteraction(sessionId, operationId) {
    const session = get().sessions.find(item => item.id === sessionId)
    if (!session || session.kind !== 'agent') throw new Error('The original Agent Session is unavailable.')
    return await api.sessions.inspectInteraction(session.control, operationId)
  },
  async respondInteraction(sessionId, response, intent) {
    const session = get().sessions.find((item) => item.id === sessionId)
    if (!session || session.kind !== 'agent') throw new Error('The original Agent Session is unavailable.')
    // Each mounted answer surface owns its local failure. A rejected answer is not a new
    // window-level Agent error, and a late result must not paint onto another request.
    let receipt: import('@agentmux/core').AgentMuxInteractionOperationReceipt
    try { receipt = await api.sessions.respondInteraction(session.control, response, intent) }
    catch (error) {
      const original = await api.sessions.inspectInteraction(session.control, intent.operationId).catch(() => null)
      if (!original || original.delivery === 'saved') throw error
      receipt = original
    }
    await get().flushAgentSteerQueue(sessionId)
    return receipt
  },
  async setPosture(sessionId, modeId) {
    // A fire-and-forget SET: Core resolves the Provider's declared keystroke and writes it in-band. We
    // never record a "current mode" — the live posture lives in the CLI's own TUI, which AgentMux cannot
    // read, so claiming to know it would be a lie. The picker sends the intent and the CLI owns the state.
    const session = get().sessions.find((item) => item.id === sessionId)
    if (!session || session.kind !== 'agent') return
    try {
      await api.sessions.setPosture(session.control, modeId)
    } catch (error) {
      get().reportError(error)
      throw error
    }
  },
  async interrupt(sessionId) {
    const session = get().sessions.find((item) => item.id === sessionId)
    if (session) await api.sessions.interrupt(session.control).catch((error) => get().reportError(error))
  },
  async controlSessionContinuity(sessionId, intentOperationId, action, additionalAttempts) {
    const session = get().sessions.find(item => item.id === sessionId)
    if (session?.kind !== 'agent' || !workbenchViewCloseAllowsSession(get().closingWorkbenchViews, sessionId) ||
      !hasAttachedSessionView(get().tabs, sessionId)) throw new Error('The original Agent workface is no longer open. No recovery control was sent.')
    const original = currentContinuitySupervision(session)
    if (original?.root.operationId !== intentOperationId || original.targetChanged && !original.waitingForInitialAttempt) throw new Error('The original recovery intent changed. Re-read its current facts before choosing a control.')
    const key = continuityControlKey(session.hostId, sessionId)
    const scope = continuityControlRequests(get().continuityControlIntents[key], session.hostId, sessionId)
    if (action === 'continue' && scope.some(item => !item.intent || !item.intent.rejection && item.intent.request.intentOperationId === intentOperationId && item.intent.request.action === 'continue')) {
      throw new Error('An original continuation control is unconfirmed. Check that same request before adding another budget. Independent cancellation remains available.')
    }
    const cancellation = action === 'cancel' ? scope.find(item => item.intent && !item.intent.rejection && item.intent.request.intentOperationId === intentOperationId && item.intent.request.action === 'cancel') : undefined
    if (cancellation) return await get().reconcileSessionContinuityControl(session.hostId, sessionId, cancellation.operationId)
    const request = parseAgentContinuityControlInput({ agentSessionId: sessionId, intentOperationId,
      expectedRun: { ...session.control.run }, operationId: mintObjectId(), action,
      ...(action === 'continue' ? { additionalAttempts } : {}) })
    set(state => ({ continuityControlIntents: { ...state.continuityControlIntents, [key]: { ...state.continuityControlIntents[key], [request.operationId]: { hostId: session.hostId, request } } } }))
    return await get().reconcileSessionContinuityControl(session.hostId, sessionId, request.operationId)
  },
  async reconcileSessionContinuityControl(hostId, sessionId, operationId) {
    const key = continuityControlKey(hostId, sessionId)
    const read = readContinuityControlIntent(get().continuityControlIntents[key]?.[operationId], hostId, sessionId, operationId)
    if (!read.intent) throw new Error(read.issue ?? 'No original recovery control is retained.')
    const original = read.intent, request = structuredClone(original.request)
    let ownerRejection: ReturnType<typeof terminalContinuityControlRejection>
    try {
      // Rehydration can replace the in-memory projection without scheduling a write.
      // Commit this exact original packet again before dispatch, preserving sibling authorizations.
      set(state => ({ continuityControlIntents: { ...state.continuityControlIntents,
        [key]: { ...state.continuityControlIntents[key], [operationId]: original } } }))
      await flushMessageWorkbench(false)
      let reply: Awaited<ReturnType<typeof api.sessions.controlContinuity>>
      try { reply = await api.sessions.controlContinuity(hostId, request) }
      catch (error) { ownerRejection = terminalContinuityControlRejection(error); throw error }
      if (reply.hostId !== hostId) throw new Error('Recovery control returned another Host route. The original request remains unconfirmed.')
      const result = parseAgentContinuityControlResult(reply.result, request)
      set(state => {
        const current = readContinuityControlIntent(state.continuityControlIntents[key]?.[operationId], hostId, sessionId, operationId).intent
        if (!current || !sameAgentContinuityControlInput(current.request, request)) return state
        const continuityControlIntents = { ...state.continuityControlIntents }, scope = { ...continuityControlIntents[key] }; delete scope[operationId]
        if (Object.keys(scope).length) continuityControlIntents[key] = scope; else delete continuityControlIntents[key]
        return { continuityControlIntents }
      })
      // The Core receipt settles the control independently of presentation. The original
      // canonical reader owns View/close/Run adoption and preserves healthy input on read failure.
      if (result.state === 'active') await get().refreshSession(sessionId).catch(() => {})
      return result
    } catch (error) {
      set(state => {
        const current = readContinuityControlIntent(state.continuityControlIntents[key]?.[operationId], hostId, sessionId, operationId).intent
        if (!current || !sameAgentContinuityControlInput(current.request, request)) return state
        return { continuityControlIntents: { ...state.continuityControlIntents, [key]: { ...state.continuityControlIntents[key], [operationId]: { ...current, issue: presentError(error), ...(ownerRejection ? { rejection: ownerRejection } : {}) } } } }
      })
      throw error
    }
  },
  async refreshSession(sessionId) {
    const before = get()
    if (!workbenchViewCloseAllowsSession(before.closingWorkbenchViews, sessionId)) return
    const current = before.sessions.find((item) => item.id === sessionId)
    const accepted = before.pendingAgentLaunches[sessionId]?.created
    const control: SessionControl | undefined = current?.control ?? (accepted ? {
      kind: 'agent', hostId: accepted.hostId, agentSessionId: accepted.agentSessionId, run: accepted.run
    } : undefined)
    if (!control) return
    const originalViews = Object.values(before.tabs).flatMap(tab => workbenchSurfaces(tab).flatMap(surface => (
      isSessionSurface(surface) && surface.phase === 'attached' && surface.sessionId === sessionId
        ? [{ tabId: tab.id, regionId: surface.regionId }] : []
    )))
    const retainedOriginalViews = new Set(originalViews)
    const hasOriginalBinding = (state: AppState, { tabId, regionId }: typeof originalViews[number]): boolean => {
      const view = state.tabs[tabId]?.regions[regionId]
      return !!view && isSessionSurface(view) && view.phase === 'attached' && view.sessionId === sessionId
    }
    const ownsOriginalView = (state: AppState): boolean => [...retainedOriginalViews].some(view => hasOriginalBinding(state, view))
    const sameOriginalOwner = (session: SessionSnapshot): boolean => session.id === sessionId &&
      session.hostId === control.hostId && session.control.hostId === control.hostId &&
      (control.kind === 'agent' ? session.kind === 'agent' && session.control.agentSessionId === control.agentSessionId
        : session.kind === 'terminal' && sessionOwnsControl(session, control))
    // An invalidated binding cannot rejoin this read after the same IDs are reopened.
    // Another continuously retained original view still owns the same Session metadata.
    const stopObservingView = useAppStore.subscribe((state, previous) => {
      for (const view of retainedOriginalViews) {
        if (!hasOriginalBinding(state, view) || !hasOriginalBinding(previous, view)) retainedOriginalViews.delete(view)
      }
      if (!workbenchViewCloseAllowsSession(state.closingWorkbenchViews, sessionId) ||
        !workbenchViewCloseAllowsSession(previous.closingWorkbenchViews, sessionId)) retainedOriginalViews.clear()
    })
    try {
      if (accepted) {
        const result: AgentLaunchResult = { created: accepted, projectionFailures: [] }
        try {
          const session = await api.sessions.refresh(control)
          if (session.kind !== 'agent' || !sameOriginalOwner(session) || session.control.run.runId !== accepted.run.runId) {
            throw new Error('Created Session re-read returned a different identity.')
          }
          result.session = session
        } catch (error) { result.projectionFailures.push({ step: 'session', message: presentError(error) }) }
        try {
          const timeline = await api.sessions.timeline(control as AgentSessionControl)
          if (timeline.agentSessionId !== sessionId) throw new Error('Created Timeline re-read returned a different identity.')
          result.timeline = timeline
        } catch (error) { result.projectionFailures.push({ step: 'timeline', message: presentError(error) }) }
        set((state) => {
          const live = state.sessions.find((item) => item.id === sessionId)
          if (!workbenchViewCloseAllowsSession(state.closingWorkbenchViews, sessionId) ||
            !ownsOriginalView(state) || (live && !sessionOwnsControl(live, control))) return state
          return reduceDetachedAgentLaunch(state, result).state
        })
        return result.session
      } else {
        try {
          const session = await api.sessions.refresh(control)
          if (!sameOriginalOwner(session)) throw new Error('Session recheck returned another original owner. The original Session and drafts are kept.')
          set((state) => {
            const live = state.sessions.find((item) => item.id === sessionId)
            if (!workbenchViewCloseAllowsSession(state.closingWorkbenchViews, sessionId) ||
              !live || !sessionOwnsControl(live, control) || !ownsOriginalView(state)) return state
            let refreshed = retainTimelineObservation(live, session)
            // A metadata read alone does not settle this original Run's refused identity check.
            if (live.kind === 'agent' && refreshed.kind === 'agent' && live.control.run.runId === refreshed.control.run.runId &&
              live.status.continuityReason === 'native-handle-unavailable' && !refreshed.status.continuity &&
              (!refreshed.nativeHandle || refreshed.nativeHandlePersistence === 'unconfirmed')) {
              refreshed = { ...refreshed, status: { ...refreshed.status, continuity: 'unavailable', continuityReason: 'native-handle-unavailable' } }
            }
            return { sessions: [...state.sessions.filter((item) => item.id !== session.id), refreshed] }
          })
          return session
        } catch (error) { get().reportError(error); throw error }
      }
    } finally { stopObservingView() }
  },
  async reopenRetiredSession(source, operationId = mintObjectId(), observeOnly = false) {
    if (source.state !== 'retired' || source.retiredAt === undefined) {
      throw new Error('This conversation has no confirmed closed Session identity. Read its current state before continuing.')
    }
    const reference = { hostId: source.hostId, agentSessionId: source.agentSessionId }
    const before = get()
    if (!workbenchViewCloseAllowsSession(before.closingWorkbenchViews, reference.agentSessionId) ||
      !hasAttachedSessionView(before.tabs, reference.agentSessionId)) {
      throw new Error('The original conversation Region is no longer open. No Session was started.')
    }
    const matches = (session: SessionSnapshot): boolean => session.kind === 'agent' &&
      session.id === reference.agentSessionId && session.hostId === reference.hostId && session.control.hostId === reference.hostId &&
      session.control.agentSessionId === reference.agentSessionId &&
      (!source.history || session.providerId === source.history.providerId &&
        session.executorId === source.history.executorId && session.workspacePath === source.history.workspacePath) &&
      (!source.history?.nativeHandle || session.nativeSessionId === source.history.nativeHandle.sessionId)
    let reopened: SessionSnapshot | undefined
    let actionError: unknown
    try {
      // Only an explicit Check again reconciles the original intent. Core may bind its
      // already-started Run; reconciliation never starts another native process.
      reopened = observeOnly
        ? await api.sessions.reconcileReopen(reference, source.retiredAt, operationId)
        : await api.sessions.reopen(reference, source.retiredAt, operationId)
      if (!matches(reopened)) {
        reopened = undefined
        throw new Error('The continued Session returned another conversation identity.')
      }
    } catch (error) { actionError = error }
    if (!reopened) {
      // A missing reply or display read never authorizes another native launch. Read the original
      // Core identity first, then use its actual Run for the existing projection reader.
      try {
        const canonical = await api.sessions.creation(reference.hostId, reference.agentSessionId)
        if (canonical.kind === 'retired-agent') throw new Error('The original Session is still closed. Keep its recovery request and check the same operation; no replacement was started.')
        if (canonical.agentSessionId !== reference.agentSessionId || canonical.hostId !== reference.hostId ||
          (source.history && (canonical.providerId !== source.history.providerId ||
            canonical.executorId !== source.history.executorId || canonical.workspacePath !== source.history.workspacePath)) ||
          (source.history?.nativeHandle && canonical.nativeHandle?.sessionId !== source.history.nativeHandle.sessionId)) {
          throw new Error('The current Core Session belongs to another conversation.')
        }
        reopened = await api.sessions.refresh({ kind: 'agent', hostId: reference.hostId,
          agentSessionId: canonical.agentSessionId, run: canonical.run })
        if (!matches(reopened)) throw new Error('The current Session display belongs to another conversation.')
      } catch (error) {
        throw actionError ?? error
      }
    }
    const session = reopened
    let attached = false
    set(state => {
      if (!workbenchViewCloseAllowsSession(state.closingWorkbenchViews, reference.agentSessionId) ||
        !hasAttachedSessionView(state.tabs, reference.agentSessionId)) return state
      attached = true
      return { ...projectRecoveredSession(state, reference.agentSessionId, session),
        viewModes: { ...state.viewModes, [reference.agentSessionId]: 'terminal' as const } }
    })
    // Closing the display while Core works does not authorize stopping the new healthy Run or
    // inventing a replacement Tab. Navigation and drafts remain owned by the original workbench.
    return attached ? session : undefined
  },
  async resumeNativeSession(input, source, capabilities, reveal = () => true, retry = false) {
    // Listing is read-only. Only this explicit action enters Core's original create/recovery owner.
    // The caller retains its exact creation identity across an unknown reply.
    let session: SessionSnapshot | undefined
    const assertSource: (observed: SessionSnapshot | undefined) => asserts observed is Extract<SessionSnapshot, { kind: 'agent' }> = observed => {
      const currentNative = observed?.kind === 'agent' ? observed.observedNativeHandle : undefined
      if (!observed || observed.kind !== 'agent' || observed.control.hostId !== input.hostId ||
        observed.id !== (source.managed?.agentSessionId ?? input.agentSessionId) ||
        observed.control.agentSessionId !== observed.id ||
        observed.workspacePath !== source.source.workspacePath || observed.providerId !== source.source.nativeHandle.providerId ||
        observed.nativeSessionId !== source.source.nativeHandle.sessionId ||
        (currentNative && (currentNative.kind !== 'provider' || currentNative.providerId !== source.source.nativeHandle.providerId || currentNative.sessionId !== source.source.nativeHandle.sessionId))) {
        throw new Error('Native resume returned another conversation identity. Keep the original source and inspect this resume operation.')
      }
    }
    if (source.managed?.state === 'retired' && source.managed.retiredAt !== undefined) {
      const reference = { hostId: input.hostId, agentSessionId: source.managed.agentSessionId }
      try { session = await api.sessions.reopen(reference, source.managed.retiredAt, input.createOperationId!) }
      catch (error) {
        // A missing reopen ACK can already own the healthy Run. This check observes the
        // original operation and never dispatches another start or prompt.
        session = await api.sessions.reconcileReopen(reference, source.managed.retiredAt, input.createOperationId!).catch(() => undefined)
        if (!session) {
          const canonical = await api.sessions.creation(reference.hostId, reference.agentSessionId).catch(() => undefined)
          if (canonical?.kind === 'agent' && canonical.agentSessionId === reference.agentSessionId && canonical.nativeHandle?.kind === 'provider' &&
            canonical.nativeHandle.sessionId === source.source.nativeHandle.sessionId) {
            const observed = await api.sessions.refresh({ kind: 'agent', ...reference, run: canonical.run }).catch(() => undefined)
            if (observed?.processState === 'running') session = observed
          }
        }
        if (!session) throw error
      }
    } else if (source.managed?.state === 'active') {
      const managed = source.managed
      session = await api.sessions.refresh({ kind: 'agent', hostId: input.hostId, agentSessionId: managed.agentSessionId, run: managed.run })
      assertSource(session)
      set(state => ({ sessions: [...state.sessions.filter(item => item.id !== session!.id), session!] }))
      const recovered = await get().recoverSession(managed.agentSessionId, input.createOperationId, { stillCurrent: reveal })
      if (recovered) assertSource(recovered)
      return recovered
    } else {
      let launched: AgentLaunchResult
      if (retry) {
        // Executor settings may have changed since the unknown launch. Inspect the saved
        // operation; resolving today's configuration cannot reproduce that original intent.
        const created = await api.sessions.creation(input.hostId, input.agentSessionId!)
        if (created.kind === 'retired-agent') throw new Error('The original resume target was closed. Its operation and history are retained; explicitly recover that Session to continue.')
        if (created.creation?.createOperationId !== input.createOperationId) {
          throw new Error('This saved Session belongs to another creation operation. Keep the original resume identity and inspect its receipt.')
        }
        const observed = await api.sessions.refresh({ kind: 'agent', hostId: input.hostId,
          agentSessionId: created.agentSessionId, run: created.run }).catch(() => undefined)
        launched = { created, ...(observed?.kind === 'agent' ? { session: observed } : {}),
          projectionFailures: observed ? [] : [{ step: 'session', message: 'The original resume is retained; its current Run observation is unavailable. Check this same Session again.' }] }
      } else launched = await api.sessions.launchAgent(input)
      const result = await get().canonicalizeAgentLaunch(launched) ?? launched
      // A missing display observation never revokes the created native conversation or its Run.
      const created = result.created
      const handle = created.nativeHandle
      if (created.agentSessionId !== input.agentSessionId || created.workspacePath !== source.source.workspacePath ||
        created.providerId !== source.source.nativeHandle.providerId || handle?.kind !== 'provider' ||
        handle.providerId !== source.source.nativeHandle.providerId || handle.sessionId !== source.source.nativeHandle.sessionId) {
        throw new Error(`Resume has Core Session ${created.agentSessionId} and Run ${created.run.runId}, but its original native conversation is unconfirmed. Keep this operation and check its identity; no replacement was started.`)
      }
      session = result.session ?? recoveryCandidateSession({
        agentSessionId: created.agentSessionId, hostId: input.hostId, workspacePath: created.workspacePath,
        providerId: created.providerId, executorId: created.executorId,
        capabilities,
        label: source.title ?? created.executorId, createdAt: created.createdAt, updatedAt: created.updatedAt,
        run: created.run, nativeSessionId: source.source.nativeHandle.sessionId,
        ...(created.nativeHandle ? { nativeHandle: created.nativeHandle } : {})
      }, { kind: 'pending', detail: result.projectionFailures.map(failure => failure.message).join(' ') || 'The native conversation was started; its display observation is unconfirmed. Check this Session again.' })
      if (result.timeline) set(state => ({ timelines: { ...state.timelines, [created.agentSessionId]: result.timeline! } }))
    }
    assertSource(session)
    set(state => ({ sessions: [...state.sessions.filter(item => item.id !== session!.id), session!] }))
    if (reveal()) get().selectSession(session.id)
    return session
  },
  async recoverSession(sessionId, operationId, options) {
    const before = get()
    if (options?.stillCurrent && !options.stillCurrent()) return
    if (options?.preserveView && !hasAttachedSessionView(before.tabs, sessionId)) return
    if (!workbenchViewCloseAllowsSession(before.closingWorkbenchViews, sessionId)) return
    let projected = before.sessions.find((item) => item.id === sessionId)
    if (!projected) {
      const candidate = before.recoveryCandidates.find(item => item.agentSessionId === sessionId)
      if (!candidate) return
      projected = recoveryCandidateSession(candidate, { kind: 'pending', detail: 'Checking this saved Session for attachment or native resume.' })
      const projection = projected
      set(state => ({ sessions: state.sessions.some(item => item.id === sessionId) ? state.sessions : [...state.sessions, projection] }))
    }
    const current = projected
    if (!current) return
    const recoveryControl = structuredClone(options?.inputControl ?? current.control)
    if (options?.inputControl && (current.kind !== 'agent' || recoveryControl.kind !== 'agent' ||
        recoveryControl.hostId !== current.control.hostId || recoveryControl.agentSessionId !== current.control.agentSessionId))
      throw new Error('Recovery input belongs to another Agent Session. The original message is kept.')
    // A candidate can exist only in Core's durable catalogue. Give it a view at its registered
    // original Host/directory before recovery; the commit below intentionally needs an attached
    // view owner. Existing durable Regions keep their layout/focus during background resync.
    if (!options?.preserveView && !hasAttachedSessionView(get().tabs, sessionId)) get().selectSession(sessionId)
    const priorFailure = current.kind === 'agent' ? lifecycleNotification(before.notificationEvents, { subject: current.control }) : undefined
    const recoveryOperationId = operationId ?? mintObjectId()
    const request = { trigger: options?.trigger ?? 'manual' as const, ...(options?.timingOverride ? { timingOverride: options.timingOverride } : {}),
      ...(options?.input ? { input: structuredClone(options.input) } : {}) }
    const recoverOriginal = () => api.sessions.recover(structuredClone(recoveryControl), current.workspacePath,
      recoveryOperationId, structuredClone(request))
    try {
      let recovery: SessionRecoveryResult
      try { recovery = await recoverOriginal() }
      catch (error) {
        if (current.kind !== 'agent' || !isSessionRecoveryReplyUnconfirmed(error)) throw error
        if (options?.stillCurrent && !options.stillCurrent()) return
        if (options?.preserveView && !hasAttachedSessionView(get().tabs, sessionId)) return
        if (!workbenchViewCloseAllowsSession(get().closingWorkbenchViews, sessionId)) return
        // Core re-enters this exact durable operation and validates its immutable
        // request. Only its owner can reconcile a lost result or continue pending work.
        recovery = await recoverOriginal()
      }
      if (options?.stillCurrent && !options.stillCurrent()) return
      if (current.kind === 'agent' && 'agentSessionId' in recovery &&
        (recovery.agentSessionId !== current.control.agentSessionId || recovery.previousRun.runId !== recoveryControl.run.runId))
        throw new Error('Recovery response belongs to another Agent Session or Run. The original conversation is kept.')
      if (recovery.kind === 'pending') {
        set(state => {
          const next = { sessions: state.sessions.map(session => session.id === sessionId && session.kind === 'agent' && sessionOwnsControl(session, current.control)
            ? { ...session, ...(recovery.continuity ? { continuity: recovery.continuity,
                continuityOperations: { ...session.continuityOperations, [recovery.continuity.operationId]: structuredClone(recovery.continuity) } } : {}),
                status: { ...session.status, detail: agentContinuityDetail(recovery.continuity) } } : session) }
          return { ...next, ...projectResumeInputReceipts({ ...state, ...next }, sessionId) }
        })
        return
      }
      if (recovery.kind === 'retired') {
        const live = get().sessions.find(session => session.id === sessionId)
        // A late receipt for the requested Run cannot retire a newer incarnation.
        if (!live || !sessionOwnsControl(live, current.control)) return
        if (options?.preserveView) {
          get().reportError(new Error('The original Session is retired. Its Mote conversation and history are kept; choose another default conversation in Profile.'), { kind: 'indeterminate', subject: current.control })
          return
        }
        set((state) => {
          const next = removeSessionProjection(state, sessionId)
          recordClosedWorkbenchEntities(state.tabs, next.tabs)
          return next
        })
        if (priorFailure && get().notificationEvents.includes(priorFailure)) {
          set(state => settleNotificationRecords(state, [priorFailure]))
        }
        return
      }
      if (
        recovery.kind === 'unavailable' ||
        recovery.kind === 'conflict'
      ) {
        if (options?.preserveView) {
          get().reportError(new Error(continuityFailureDetail(recovery)), { kind: 'indeterminate', subject: current.control })
          return
        }
        set((state) => ({
          sessions: state.sessions.map((session) => (
            session.id === sessionId && sessionOwnsControl(session, current.control)
              ? {
                  ...session,
                  status: {
                    ...session.status,
                    state: 'error' as const,
                    // 与 recoveryCandidateSession 同一处产出。这条路是**用户自己点「恢复」**走的，
                    // 各写一遍时它正是被漏掉的那一处。
                    ...continuityStatusFields(recovery)
                  }
                }
              : session
          ))
        }))
        return
      }
      if (current.kind === 'agent' && (recovery.session.kind !== 'agent' || recovery.session.control.hostId !== current.control.hostId || recovery.session.control.agentSessionId !== current.control.agentSessionId))
        throw new Error('Recovery response belongs to another Agent Session. The original conversation is kept.')
      const session = options?.preserveView ? { ...recovery.session, id: sessionId } : recovery.session
      const after = get()
      const live = after.sessions.find((item) => item.id === sessionId)
      const ownerStillCurrent = live !== undefined &&
        (sessionOwnsControl(live, current.control) || sessionOwnsControl(live, session.control)) &&
        hasAttachedSessionView(after.tabs, sessionId)
      if (
        workbenchViewCloseAllowsSession(after.closingWorkbenchViews, sessionId) &&
        ownerStillCurrent
      ) {
        set((state) => ({ ...projectRecoveredSession(state, sessionId, session), ...(options?.preserveView ? { agentFocus: state.agentFocus } : {}) }))
        if (priorFailure && get().notificationEvents.includes(priorFailure)) {
          set(state => settleNotificationRecords(state, [priorFailure]))
        }
        if ((recovery.kind === 'reattachable' || recovery.kind === 'resumed') && recovery.advisory &&
          get().sessions.some(item => item.id === sessionId && sessionOwnsControl(item, session.control)))
          get().reportError(new Error(recovery.advisory), { kind: 'indeterminate' })
        return session
      }
      // Agent continuity belongs to its durable Core Session. A closed view does not own or
      // authorize stopping a canonical Run, including one recovered before a lost IPC reply.
      if (session.kind === 'agent' || session.control.run.runId === current.control.run.runId) return
      try {
        await api.sessions.stop(session.control)
      } catch (cleanupError) {
        set((state) => projectRecoveredSession(state, sessionId, session))
        get().selectSession(session.id)
        const failure = new AggregateError(
          [new Error('Recovered Session owner disappeared before commit.'), cleanupError],
          'Recovered Session owner disappeared and cleanup failed.'
        )
        if (operationId) throw failure
        // The replacement has a new ID; the outer stale-owner guard cannot report its cleanup.
        get().reportError(failure)
      }
    } catch (error) {
      if (operationId && !options?.preserveView) throw error
      if (options?.stillCurrent && !options.stillCurrent()) return
      const live = get().sessions.find(item => item.id === sessionId)
      if (!live || !sessionOwnsControl(live, current.control)) return
      get().reportError(error, current.kind === 'agent' ? {
        kind: 'indeterminate', subject: current.control,
        lifecycle: { step: 'resume', subject: current.control, lastProcessState: current.processState }
      } : undefined)
    }
  },
  async restartSession(control, operationId, observeOnly = false) {
    const result = await api.sessions.restart(control, operationId, observeOnly)
    if (result.agentSessionId !== control.agentSessionId || result.operationId !== operationId ||
        result.previousRun.runId !== control.run.runId) throw new Error('Restart response belongs to another original Session, Run or operation.')
    const session = result.session
    if (session && (session.kind !== 'agent' || session.id !== control.agentSessionId ||
        session.control.hostId !== control.hostId || session.control.agentSessionId !== control.agentSessionId ||
        result.newRun && session.control.run.runId !== result.newRun.runId))
      throw new Error('Restart projection belongs to another Session or Run. The original operation is retained.')
    if (session?.kind === 'agent' && session.id === control.agentSessionId &&
        session.control.hostId === control.hostId && session.control.agentSessionId === control.agentSessionId) {
      set(state => {
        // Canonical receipts update their original Host-qualified presentations without re-keying workfaces.
        return { sessions: state.sessions.map(current => current.kind === 'agent' &&
          current.control.hostId === control.hostId && current.control.agentSessionId === control.agentSessionId &&
          (current.control.run.runId === control.run.runId || current.control.run.runId === session.control.run.runId)
          ? retainTimelineObservation(current, { ...session, id: current.id, hostId: current.hostId }) : current) }
      })
    }
    return result
  },
  async stopSession(sessionId) {
    const state = get()
    if (!workbenchViewCloseAllowsSession(state.closingWorkbenchViews, sessionId)) return
    const original = state.sessions.find(item => item.id === sessionId)
    const recovery = cancelMoteSessionRecovery(sessionId)
    if (recovery) await recovery
    const session = get().sessions.find(item => item.id === sessionId)
    if (!session || !original || !workbenchViewCloseAllowsSession(get().closingWorkbenchViews, sessionId)) return
    try {
      if (recovery && original.kind === 'agent' && session.kind === 'agent') {
        if (session.control.hostId !== original.control.hostId || session.control.agentSessionId !== original.control.agentSessionId) return
        const canonical = await api.sessions.refresh(session.control)
        if (canonical.kind !== 'agent' || canonical.control.hostId !== original.control.hostId || canonical.control.agentSessionId !== original.control.agentSessionId)
          throw new Error('Stop response belongs to another Agent Session. The original work is kept.')
        const live = get().sessions.find(item => item.id === sessionId)
        if (live?.kind !== 'agent' || live.control.hostId !== original.control.hostId || live.control.agentSessionId !== original.control.agentSessionId ||
          !workbenchViewCloseAllowsSession(get().closingWorkbenchViews, sessionId)) return
        await api.sessions.stop(canonical.control)
      } else await api.sessions.stop(session.control)
    } catch (error) { get().reportError(error) }
  },
  async canonicalizeAgentLaunch(result) {
    const id = result.created.agentSessionId
    if (result.session && (result.session.id !== id || result.session.control.run.runId !== result.created.run.runId)) {
      const { session: _invalid, ...rest } = result
      result = { ...rest, projectionFailures: [...result.projectionFailures,
        { step: 'session', message: 'Agent launch projected a different Session or Run.' }] }
    }
    if (result.timeline && result.timeline.agentSessionId !== id) {
      const { timeline: _invalid, ...rest } = result
      result = { ...rest, projectionFailures: [...result.projectionFailures,
        { step: 'timeline', message: 'Agent launch returned another Session Timeline.' }] }
    }
    while (get().pendingAgentLaunches[id]?.overflowed) {
      set((state) => {
        const pending = state.pendingAgentLaunches[id]
        if (!pending) return state
        return { pendingAgentLaunches: { ...state.pendingAgentLaunches,
          [id]: { ...pending, events: [], overflowed: false } } }
      })
      try {
        const snapshot = await api.sessions.snapshot()
        const pending = get().pendingAgentLaunches[id]
        if (!pending) return null
        if (pending.overflowed) continue
        const session = snapshot.sessions.find((candidate) => candidate.id === id)
        const timeline = snapshot.timelines[id]
        return { ...result,
          ...(session?.kind === 'agent' && session.control.run.runId === result.created.run.runId ? { session } : {}),
          ...(timeline?.agentSessionId === id ? { timeline } : {}),
          projectionFailures: [
            ...(session?.kind === 'agent' ? [] : [{ step: 'session' as const, message: 'Created Session display is not yet available.' }]),
            ...(timeline?.agentSessionId === id ? [] : [{ step: 'timeline' as const, message: 'Created Session Timeline is not yet available.' }])
          ] }
      } catch (error) {
        // A failed display read cannot revoke the already accepted Core creation.
        return { ...result, projectionFailures: [...result.projectionFailures,
          { step: 'session', message: `Launch display re-read failed: ${presentError(error)}` }] }
      }
    }
    return result
  },
  async resyncTimeline(sessionId, { observationOnly = false } = {}) {
    const existing = timelineResyncs.get(sessionId)
    if (existing) {
      const hostId = get().sessions.find(candidate => candidate.kind === 'agent' && candidate.id === sessionId)?.control.hostId
      if (!observationOnly || existing.hostId !== hostId) existing.requested = true
      existing.reconcileRequested ||= !observationOnly
      await existing.promise
      return
    }
    const entry = { requested: false, reconcileRequested: !observationOnly, hostId: undefined as string | undefined, promise: Promise.resolve() }
    timelineResyncs.set(sessionId, entry)
    entry.promise = (async () => {
      try {
        do {
          entry.requested = false
          const session = get().sessions.find((candidate) => (
            candidate.kind === 'agent' && candidate.id === sessionId
          ))
          if (!session || session.kind !== 'agent') return
          entry.hostId = session.control.hostId
          const reconcile = entry.reconcileRequested
          entry.reconcileRequested = false
          try {
            const snapshot = await api.sessions.timeline(session.control)
            if (snapshot.agentSessionId !== session.control.agentSessionId) throw new Error('Work history returned a different Session. The original work surface is retained.')
            // History belongs to the durable Session, so a new Run is allowed;
            // a different Host must never receive the old request's late page.
            const current = get().sessions.find(candidate => candidate.kind === 'agent' && candidate.id === sessionId)
            if (!current || current.control.hostId !== session.control.hostId) continue
            const pendingBefore = get().agentSteerQueues[sessionId]
            set((state) => {
              const next = { ...state, ...reduceTimelineSnapshot(state, snapshot, sessionId, session.control) }
              return reconcile ? reconcileDeliveredSteers(next, sessionId) : next
            })
            if (reconcile && get().agentSteerQueues[sessionId] !== pendingBefore && !agentSteerDrains.has(sessionId)) {
              void get().flushAgentSteerQueue(sessionId)
            }
          } catch (error) {
            get().reportError(error, observationOnly ? { kind: 'indeterminate', subject: session.control,
              summary: 'Work history could not be read. The original Session and work surface are kept; open Conversation records and Refresh source to retry.' } : undefined)
          }
        } while (entry.requested)
      } finally {
        timelineResyncs.delete(sessionId)
      }
    })()
    await entry.promise
  },
  applyEvent(event) {
    const observationStarted = rendererPerformance.start()
    const observationSource = rendererSessionEventSource(event.hostId, event.event)
    try {
    const core = event.event
    if (core.type === 'agent-input') {
      const sid = core.receipt.key.agentSessionId, pending = get().agentSteerQueues[sid]?.find(entry => entry.directInputControl?.hostId === event.hostId &&
        entry.directInputControl.agentSessionId === sid && entry.directInputControl.run.runId === core.receipt.key.expectedRun.runId &&
        core.receipt.key.kind === 'prompt' && entry.operationId === core.receipt.key.submissionId)
      if (pending) consumeInputReceipt(sid, core.receipt)
      return
    }
    const endpointObservation = event.endpointObservation
    if (endpointObservation) set(state => ({ runtimeEndpointWarnings: runtimeEndpointWarningsAfterObservation(
      state.runtimeEndpointWarnings, event.hostId, endpointObservation.warning, endpointObservation.step, endpointObservation.resolvedSteps) }))
    if (core.type === 'control-endpoint-state') {
      if (sessionMembershipResync) enqueueSessionMembershipEvent(sessionMembershipResync, event)
      return
    }
    if (event.endpointWarning !== undefined && !(core.type === 'connection-state' && core.state === 'restored' && event.endpointWarning === null)) set((state) => {
      const runtimeEndpointWarnings = runtimeEndpointWarningsAfterObservation(state.runtimeEndpointWarnings, event.hostId, event.endpointWarning)
      return { runtimeEndpointWarnings, sessions: projectRuntimeEndpointSessions(state.sessions, runtimeEndpointWarnings) }
    })
    if (core.type === 'connection-state' && core.state === 'restored') {
      // Reconcile already requested diagnostics on this exact Host. Reconnection
      // does not authorize discovery on every configured remote Host.
      const state = get(), host = state.config?.hosts.find(item => item.id === event.hostId)
      const observed = host?.kind === 'ssh' ? hostExecutorInventoryMatches(state.hostExecutorInventories[event.hostId], host)
        : host && Object.entries(state.config?.executors ?? {}).some(([id, executor]) =>
          currentExecutorDetection(state.executorDetections[executorDetectionKey(host.id, id)], id, executor, host))
      if (observed) void get().detectExecutors(event.hostId, { onlyUnconfirmed: true, onlyObserved: true })
      for (const candidates of Object.values(get().warmTerminals)) {
        for (const warm of candidates) {
          const request = warm.creation?.request
          if (!warm.creation?.issue || request?.hostId !== event.hostId || warm.ownerLauncherId === null) continue
          const workspace = get().config?.workspaces.find(item => item.hostId === request.hostId && item.path === request.workspacePath)
          if (workspace) void get().retryWarmTerminal(workspace.id, warm.ownerLauncherId, true)
        }
      }
      startSessionMembershipResync(event, { recoverSavedAgents: true, restoredHostId: event.hostId })
      return
    }
    // Only a projection produced by this exact observation is excluded from automatic delivery.
    // Independent Hook completion, automatic reconnect and explicit sends keep their existing intent.
    const projectedRun = core.type === 'agent-session' ? core.session.run
      : 'run' in core ? core.run : 'evidence' in core ? core.evidence.run : undefined
    const observationRefresh = core.observationOrigin?.kind === 'attachment-refresh' &&
      core.observationOrigin.run.runId === projectedRun?.runId
    // Diagnostics use the existing notice owner, even while membership is reconciling.
    // They never replace semantic state or its clock.
    const diagnostic = runtimeDiagnosticNotice(get(), event)
    if (diagnostic) get().reportError(diagnostic.message, { kind: 'indeterminate', summary: diagnostic.summary,
      ...(diagnostic.subject ? { subject: diagnostic.subject } : {}), ...(diagnostic.cause ? { cause: diagnostic.cause } : {}) })
    if (core.type === 'run-service') {
      if (!runServiceProjection.apply(event) && core.agentSessionId) {
        if (get().pendingAgentLaunches[core.agentSessionId]) {
          const agentSessionId = core.agentSessionId
          set(state => bufferPendingAgentEvent(state, event, agentSessionId))
        } else if (!sessionMembershipResync && !agentSessionPresentationIndex(get().sessions).has(core.agentSessionId)) {
          startSessionMembershipResync(event)
          return
        }
      }
      if (sessionMembershipResync) enqueueSessionMembershipEvent(sessionMembershipResync, event)
      return
    }
    if (sessionMembershipResync) {
      const pendingLaunchAgentSessionId = pendingAgentLaunchEventId(get(), event)
      if (pendingLaunchAgentSessionId) {
        set((state) => projectRuntimeEvent(state, event).state)
        enqueueSessionMembershipEvent(sessionMembershipResync, event, pendingLaunchAgentSessionId)
        return
      }
      enqueueSessionMembershipEvent(sessionMembershipResync, event)
      return
    }
    const eventSource = runtimeEventSession(get().sessions, event)
    const eventSourceId = eventSource?.id
    const previous = core.type === 'agent-session' || core.type === 'agent-status' ? eventSource : undefined
    const interactionCleared = core.type === 'agent-session' && !core.session.pendingInteraction &&
      previous?.kind === 'agent' && Boolean(previous.pendingInteraction)
    const pendingBefore = core.type === 'agent-timeline' && eventSourceId ? get().agentSteerQueues[eventSourceId] : undefined
    let timelineGapSessionId: string | undefined
    let sessionMembershipGap = false
    set((state) => {
      const reduced = projectRuntimeEvent(state, event)
      if (core.type === 'run-removed') recordClosedWorkbenchEntities(state.tabs, reduced.state.tabs)
      timelineGapSessionId = reduced.timelineGapSessionId
      sessionMembershipGap = reduced.sessionMembershipGap === true
      const projected = reduced.state.sessions === state.sessions ? reduced.state
        : { ...reduced.state, sessions: projectRuntimeEndpointSessions(reduced.state.sessions, state.runtimeEndpointWarnings) }
      const next = core.type === 'agent-timeline' && eventSourceId
        ? reconcileDeliveredSteers({ ...state, ...projected }, eventSourceId)
        : projected
      return core.type === 'agent-session' ? { ...next,
        ...projectResumeInputReceipts({ ...state, ...next }, core.session.agentSessionId),
        ...resolvedNativeIdentityNotices({ ...state, ...next }, {
          kind: 'agent', hostId: event.hostId, agentSessionId: core.session.agentSessionId, run: core.session.run
        }) } : next
    })
    if (core.type === 'agent-timeline' && eventSourceId && get().agentSteerQueues[eventSourceId] !== pendingBefore &&
      !observationRefresh && !agentSteerDrains.has(eventSourceId)) void get().flushAgentSteerQueue(eventSourceId)
    if (sessionMembershipGap) startSessionMembershipResync(event)
    if (timelineGapSessionId) void get().resyncTimeline(timelineGapSessionId)
    if (observationRefresh) return
    {
      // A consumed/degraded snapshot can be emitted by the attempt itself. It is not a new
      // delivery opportunity: waking on it would let a persistent refusal sustain its own loop.
      const completed = core.type === 'agent-session' ? core.session.semanticStatus
        : core.type === 'agent-status' ? { state: core.state, observedAt: core.evidence.observedAt } : undefined
      const projected = core.type === 'agent-session' || core.type === 'agent-status'
        ? get().sessions.find((session) => session.id === eventSourceId) : undefined
      const freshCompletion = completed?.state === 'done' &&
        projected?.status.state === 'done' && projected.status.observedAt === completed.observedAt &&
        (previous?.status.state !== 'done' || previous.status.observedAt !== completed.observedAt)
      const sessionId = core.type === 'agent-session' && (interactionCleared || freshCompletion)
        ? eventSourceId
        : core.type === 'agent-status' && freshCompletion ? eventSourceId : undefined
      if (sessionId && get().agentSteerQueues[sessionId]?.length) void get().flushAgentSteerQueue(sessionId)
    }
    } finally { rendererPerformance.sessionEvent(event.event.type, observationStarted, observationSource) }
  },
  decayStaleAgentStatuses(now) {
    set((state) => {
      const decayed = computeDecayedAgentStatuses(state.sessions, now)
      // computeDecayedAgentStatuses 无变化时返回原引用——原样返回，Zustand 不做无谓写入。
      return decayed === state.sessions ? state : { sessions: decayed }
    })
  },
  setConfig(config, preferredWorkspaceId) {
    if (Object.hasOwn(config.appearance, 'spaceObjectIcons')) retainedSpaceIconHandoff = undefined
    const iconProjection = restoreSpaceIconOverrides(config.appearance.spaceObjectIcons)
    const runtimeConfigChanged = JSON.stringify(get().config?.hosts) !== JSON.stringify(config.hosts) ||
      JSON.stringify(get().config?.executors) !== JSON.stringify(config.executors)
    if (runtimeConfigChanged) {
      for (const [key, check] of Object.entries(get().executorDetections)) {
        const input = check.input
        if (!input || !executorDetectionMatches(input, input.executorId, config.executors[input.executorId],
          config.hosts.find(host => host.id === input.host.id))) detectionRequestIds.delete(key)
      }
      hostCheckRequestIds.clear()
    }
    // 活动位跟着一起算。此前这里只清 host 键的两张缓存却不管 `activeWorkspaceId`，而那正是**唯一**
    // 会被「配置里少了一条 workspace」打坏的引用：删 host 会连带删掉它上面的全部 workspace（见
    // HostSettingsPane 的 filter），删项目会删掉一整组，而两处都经过这里。缺了这一行，每个删除现场
    // 都得自己记得挪活动位，而漏掉的那些就是空白欢迎页。
    //
    // 活动位不是唯一指进 config 的东西：被删 workspace 的文件 Tab 还在 `state.tabs` 里，每个都攥着
    // 一个 Main 侧观察者子进程。撤活动位让它们不可达却不释放那些子进程，于是它们一直活到 app 退出
    // （#559 的子进程泄漏）。在同一处把它们撤掉——与「谁负责在记录消失时收尾」是同一个决定。
    disposeObserversForRemovedWorkspaces(get().tabs, config)
    for (const workspace of config.workspaces) if (workspace.closeout) coreSpatialPersistence?.closeWorkspace(workspace.id)
    set((state) => ({
      ...adoptedConfig(state.activeWorkspaceId, config, preferredWorkspaceId),
      ...rehomeClosedWorkspaces(state, config),
      ...(Object.hasOwn(config.appearance, 'spaceObjectIcons') ? { spaceObjectIcons: configValuesEqual(state.spaceObjectIcons, iconProjection) ? state.spaceObjectIcons : iconProjection } : {}),
      ...(runtimeConfigChanged ? { executorDetections: Object.fromEntries(Object.entries(state.executorDetections).filter(([, check]) => {
        const input = check.input
        return input && executorDetectionMatches(input, input.executorId, config.executors[input.executorId], config.hosts.find(host => host.id === input.host.id))
      })), hostChecks: {} } : {})
    }))
  },
  reportError(error, context) {
    const message = presentError(error)
    // Without an original producer or exact subject, identical prose is not proof of one failure.
    // Mint once at intake and keep that receipt on both the latest error and its history record.
    if (!context?.event && !context?.subject && !context?.lifecycle && !context?.startupSessionSnapshot && !context?.startupProviderCatalog) {
      context = { kind: 'indeterminate', ...context, event: { source: 'operation', key: mintObjectId() } }
    }
    const observedAt = Date.now()
    const observedRecord = (id: string, prior?: NotificationEvent): NotificationEvent => {
      const firstObservedAt = prior?.id === id ? prior.firstObservedAt : observedAt
      return { id, message, context: context ?? null,
        ...(firstObservedAt === undefined ? {} : { firstObservedAt }), lastObservedAt: observedAt,
        occurrences: prior?.id === id ? (prior.occurrences ?? 1) + 1 : 1 }
    }
    const owner = notificationSourceOwner(context)
    if (owner) {
      const current = get(), prior = projectNotifications(current.notificationEvents).owners.get(owner)
      const record = observedRecord(notificationEventIdentity(message, context), prior)
      // The failed operation owns this current record. Unrelated errors cannot replace it,
      // and a later record cannot be settled by an older operation's successful receipt.
      set({ notificationEvents: [...(prior ? current.notificationEvents.filter(item => item !== prior) : current.notificationEvents), record] })
      return
    }
    // Acknowledging the cleared latest event suppresses only the same exact notification identity.
    // Current source-owned failures above are settled solely by their original operation/identity owner.
    const current = get(), id = notificationEventIdentity(message, context)
    if (current.errorDismissed && current.lastError !== null &&
      notificationEventIdentity(current.lastError, current.errorNoticeContext) === id) return
    // Startup retains its original producer reference; other failures have an independent record.
    const retainEvent = !context?.startupSessionSnapshot && !context?.startupProviderCatalog
    const existing = current.notificationEvents.find(item => item.id === id)
    // Clearing activity is an explicit reading decision for this exact producer occurrence.
    // Another channel observing it later must not recreate it after an unrelated latest error.
    if (context?.event && !existing && current.noticeReadReceipts['global:events']?.[id] === 'read') return
    const event = observedRecord(id, existing)
    const notificationEvents = !retainEvent ? current.notificationEvents
      : existing ? current.notificationEvents.map(item => item === existing ? event : item)
      : [...current.notificationEvents, event]
    // Ordinary failures have their own history now; they must not replace an unfinished startup source.
    const preserveStartupSource = retainEvent &&
      (current.errorNoticeContext?.startupSessionSnapshot || current.errorNoticeContext?.startupProviderCatalog)
    set({ ...(!preserveStartupSource
      ? { error: message, lastError: message, errorNoticeContext: context ?? null, errorDismissed: false } : {}), notificationEvents })
  },
  dismissError() {
    if (!get().error) return
    set({ errorDismissed: true })
  },
  reopenError() {
    const message = get().lastError
    if (!message) return
    set({ error: message, errorDismissed: false })
  },





}), {
  name: 'agentmux-workbench-v1',
  version: 1,
  storage: workbenchWriteFence.storage,
  /**
   * 版本前进时把上一版的记录原样带过来，一个字段都不重置。
   *
   * 没有这个函数时，zustand 遇到版本不等只会 `console.error` 然后把这份记录当成**不存在**：
   * 实测 zustand 5.0.14 的 hydrate 分支 `return [false, undefined]`，
   * `merge(undefined, get())` 把整份状态换成内存默认值，`hasHydrated()` 照旧变 true，
   * 而 `onRehydrateStorage` 的 error 参数是 `undefined`。三件坏事同时发生：
   *   - 用户的 Tab / 布局 / 侧栏宽度 / 换行开关 / 自己起的 Agent 名字全部消失；
   *   - 上面那道写闸（`workbenchWriteFence`）因为 hydration「成功」了而照旧打开；
   *   - 于是下一次写入覆盖掉唯一的副本。
   * 换句话说 bump 一下版本号就是一次静默数据销毁，而两个检测点（:4073 的 error 分支、
   * `ensurePersistHydrated` 里那条 `!hasHydrated()` 合成检查）都看不见它。
   *
   * 为什么可以整份带过来、不需要挑：判据是**这条记录的缺席是否含糊**（与主进程侧
   * `authoredConfigCarryOver` 同一条判据）。这里持久化的每一项都是「在场就是用户的选择，
   * 不在场就是没设过」，没有任何一项存在「配置写在这个字段出现之前」与「用户主动关掉了它」
   * 分不清的情况——那种含糊只发生在**按内置 id 建键**的集合上，主进程侧的内置 Executor 表是
   * 本仓唯一那个例子。所以这里没有该重置的半边。
   *
   * 这不是兼容层：它不认识任何具体的旧版本号，没有 `if (from === 1)` 分支，也不会随版本增长。
   * 形状变了由下游各自的逐条校验（`projectPersistedWorkbench`、`orderTopics`、
   * `restorePersistedUiState` 里那些 enum 与 Workspace 存在性校验）把认不出的条目丢掉——
   * 那些校验本来就在。这里只负责不要整份丢。
   *
   * 那次 cast 断言的**不是**「这份记录合法」——它不合法也照样交出去。断言的是「版本前进这条路
   * 对记录的信任程度与版本相等那条路**完全相同**」：版本相等时 zustand 直接把反序列化出来的
   * `state` 交给 merge，同样不校验任何字段。两条路都把校验留给真正的取值点
   * （`projectPersistedWorkbench`、`orderTopics`、`restorePersistedUiState`）。所以这个函数
   * 一旦开始挑字段或修形状，它就变成了兼容层；它的正确实现只能是恒等。
   */
  migrate: (persisted) => persisted as PersistedAppState,
  // Startup owns the hydration boundary explicitly. `initialize()` must not ask Core for recovery
  // candidates until the persisted Workbench and UI projection have been merged.
  skipHydration: true,
  onRehydrateStorage: () => (_state, error) => {
    if (error) persistHydrationError = error
  },
  merge: (persisted, current) => {
    const local = (persisted ?? {}) as Partial<PersistedAppState>
    if (!Object.hasOwn(current.config?.appearance ?? {}, 'spaceObjectIcons') && Object.hasOwn(local, 'spaceObjectIcons')) retainedSpaceIconHandoff = local.spaceObjectIcons
    const state = { ...current, ...persisted as Partial<AppState> }
    state.documents = Object.fromEntries(Object.entries(state.documents).map(([key, document]) => [key, document.noteEditing?.attempt?.phase === 'sending'
      ? { ...document, noteEditing: { ...document.noteEditing, attempt: { ...document.noteEditing.attempt, phase: 'unknown' as const } } } : document]))
    state.noticeReadReceipts = normalizeNotificationReadReceipts(state.noticeReadReceipts)
    // Old Chromium reads never overwrite acknowledged names or clear tombstones.
    if (current.nameAuthorityRevision > 0) {
      state.agentNames = current.agentNames
      state.surveyExplorationNames = current.surveyExplorationNames
      state.nameLabels = current.nameLabels
      state.nameAuthorityRevision = current.nameAuthorityRevision
    }
    state.spaceObjectIcons = restoreSpaceIconOverrides(Object.hasOwn(current.config?.appearance ?? {}, 'spaceObjectIcons')
      ? current.config!.appearance.spaceObjectIcons : retainedSpaceIconHandoff)
    state.botTaskSelections = restoredBotTaskSelections(state.botTaskSelections)
    return { ...state, agentLearningReviewDrafts: restoredLearningReviewDrafts(state.agentLearningReviewDrafts), manualConnectionIntents: restoredManualConnectionIntents(state.manualConnectionIntents), manualConnectionSelections: restoredManualConnectionSelections(state.manualConnectionSelections), workspaceAgentOrder: restoreWorkspaceAgentOrder(state.workspaceAgentOrder), moteBotRequests: restoredMoteBotRequests(state.moteBotRequests), connectorRoomIntents: restoredConnectorRoomIntents(state.connectorRoomIntents), connectorRoomDrafts: restoredConnectorRoomDrafts(state.connectorRoomDrafts), connectorServiceIntents: restoredConnectorServiceIntents(state.connectorServiceIntents), mailboxNotificationIntents: restoredMailboxNotificationIntents(state.mailboxNotificationIntents), mailboxNotificationFeedback: current.mailboxNotificationFeedback, mailboxNotificationHistory: current.mailboxNotificationHistory, moteConnectionSaveIntents: restoredMoteConnectionSaveIntents(state.moteConnectionSaveIntents), moteChatIntents: restoredMoteChatIntents(state.moteChatIntents), noteCanvasLayouts: restoreNoteCanvasLayouts(state.noteCanvasLayouts), recentMoteAgents: restoredRecentMoteAgents(state.recentMoteAgents), questionReplies: restoredQuestionReplies(state.questionReplies), capsuleQuestionEditors: restoredCapsuleQuestionEditors(state.capsuleQuestionEditors), goalAgentSelectionDrafts: restoredGoalAgentSelectionDrafts(state.goalAgentSelectionDrafts), goalAgentCreationDrafts: restoredGoalAgentCreationDrafts(state.goalAgentCreationDrafts), goalFiniteStartIntents: restoredGoalFiniteStartIntents(state.goalFiniteStartIntents), agentComposerHistory: restoreComposerHistory(state.agentComposerHistory),
      agentComposerHistoryNavigation: {}, surveyOrganization: restoreSurveyOrganization(state.surveyOrganization), surveyZoneSelection: restoredSurveyZoneSelection(state.surveyZoneSelection), recallZoneSelection: restoredSurveyZoneSelection(state.recallZoneSelection) }
  },
  partialize: partializeAppState
}))

let projectingNativeBrowsers = false
useAppStore.subscribe((state, previous) => {
  if (!pendingNativeBrowsers.size || projectingNativeBrowsers || state.tabs === previous.tabs && state.layouts === previous.layouts) return
  projectingNativeBrowsers = true
  try { for (const event of pendingNativeBrowsers.values()) useAppStore.getState().applyBrowserEvent(event) }
  finally { projectingNativeBrowsers = false }
})

/** The same membership lifecycle is used by initialize and isolated real-consumer fixtures. */
export function initializeRunServiceProjection(): () => void {
  runServiceProjection.reconcile(useAppStore.getState().sessions)
  const dispose = useAppStore.subscribe((state, previous) => {
    if (state.sessions === previous.sessions) return
    runServiceProjection.reconcile(state.sessions)
    // A launch receipt admits the exact Run before its existing pre-receipt events are read.
    for (const pending of Object.values(previous.pendingAgentLaunches)) {
      for (const event of pending.events) if (event.event.type === 'run-service') runServiceProjection.apply(event)
    }
  })
  return () => { dispose(); runServiceProjection.clear() }
}

/** Changes invalidate only the original unclaimed input observation, through Main's owner. */
export function initializeAgentInputOccupation(): () => void {
  return observeAgentInputOccupation(useAppStore, control => api.sessions.notifyInputOccupation(control), error => {
    useAppStore.getState().reportError(error, { kind: 'indeterminate',
      summary: 'User input observation could not reconnect. Your original Agent and draft remain available; retry the original operation.' })
  })
}

/** Flush admitted draft/layout changes, then await their existing Chromium owner's request. */
export async function prepareRendererUpdate(intent: 'reload' | 'quit' = 'reload'): Promise<void> {
  // No writes have been admitted during cold hydration. Quitting must preserve that durable record,
  // without qualifying an empty loading projection as an original workbench.
  if (intent === 'quit' && !workbenchWriteFence.isOpen()) return
  if (useAppStore.getState().loading) throw new Error('The interface is still loading; retry the update when ready.')
  if (Object.values(useAppStore.getState().savingDocuments).some(Boolean)) throw new Error('A file save is in progress; retry the update after it completes.')
  persistentWorkbenchStorage.flush()
  await requestWorkbenchStorageFlush()
}


/** Presentation belongs to Desktop. Fixed commits retain their own identity; repository browsing
 * has one reusable Region. Neither navigation changes the configured resource nor Agent cwd. */
function openGitReading(workspaceId: string, target:
  | { kind: 'commit'; snapshot: GitCommitSnapshot }
  | { kind: 'history'; scope: Pick<GitCommitSnapshot, 'hostId' | 'repoPath'>; reference?: string | null; locate?: GitCommitSnapshot }
): { tabId: string; regionId: string } {
  const state = useAppStore.getState()
  const scope = target.kind === 'commit' ? target.snapshot : target.scope
  const workspace = state.config?.workspaces.find(item => item.id === workspaceId)
  if (!workspace || workspace.hostId !== scope.hostId) throw new Error('The original Git workspace is unavailable.')
  const existing = Object.values(state.tabs).flatMap(tab => workbenchSurfaces(tab).flatMap(surface =>
    surface.kind === 'git' && surface.workspaceId === workspaceId && surface.scope.hostId === scope.hostId &&
    surface.scope.repoPath === scope.repoPath && surface.scope.workspacePath === workspace.path &&
    (target.kind === 'history' ? Boolean(surface.history) || !surface.selection
      : !surface.history && surface.selection?.commitOid === target.snapshot.commitOid && surface.selection.parentOid === target.snapshot.parentOid)
      ? [{ tab, surface }] : []))[0]
  const tabId = existing?.tab.id ?? mintObjectId(), regionId = existing?.surface.regionId ?? newRegionId()
  const layout = state.layouts[workspaceId] ?? createWorkspaceLayout(newTabGroupId())
  const groupId = tabGroupForTab(layout, tabId) ?? layout.activeGroupId
  const nextLayout = existing ? activateLayoutTab(layout, groupId, tabId) : addTabPlacement(layout, groupId, tabId)
  if (!nextLayout) throw new Error('The original Git Tab Group is unavailable.')
  const selected = target.kind === 'commit' ? target.snapshot : target.locate
  const selection = selected ? { commitOid: selected.commitOid, parentOid: selected.parentOid } : existing?.surface.selection ?? null
  const sameSelection = existing?.surface.selection?.commitOid === selection?.commitOid && existing?.surface.selection?.parentOid === selection?.parentOid
  if (existing && !sameSelection) state.releaseBranchDiff(regionId)
  const surface = { kind: 'git' as const, regionId, workspaceId,
    scope: { hostId: scope.hostId, repoPath: scope.repoPath, workspacePath: workspace.path }, selection,
    ...(target.kind === 'history' ? { history: {
      reference: target.reference === undefined ? existing?.surface.history?.reference ?? null : target.reference,
      ...(target.locate ? { focusOid: target.locate.commitOid } : {})
    } } : {}),
    ...(sameSelection && existing?.surface.file ? { file: existing.surface.file } : {}) }
  const tab = existing ? focusWorkbenchTabRegion({ ...existing.tab, regions: { ...existing.tab.regions, [regionId]: surface } }, regionId)
    : createWorkbenchTab(tabId, surface)
  useAppStore.setState(current => ({ activeWorkspaceId: workspaceId, mainSurface: 'workbench',
    tabs: { ...current.tabs, [tabId]: tab }, layouts: { ...current.layouts, [workspaceId]: nextLayout } }))
  state.focusRegion(workspaceId, tabId, regionId, 'navigation', groupId)
  return { tabId, regionId }
}

/** Flush only the original client presentation owner. Failure retains the current canvas and a retry. */
export async function saveNoteCanvasPresentation(scope: NoteCanvasScope, patch?: Partial<NoteCanvasLayout>): Promise<void> {
  const key = noteCanvasScopeKey(scope)
  let captured: NoteCanvasLayout | undefined
  try {
    if (patch) useAppStore.setState(state => ({ noteCanvasLayouts: { ...state.noteCanvasLayouts,
      [key]: mergeNoteCanvasLayout(state.noteCanvasLayouts[key] ?? defaultNoteCanvasLayout(scope), patch) } }))
    captured = useAppStore.getState().noteCanvasLayouts[key]
    await flushMessageWorkbench(false)
    if (useAppStore.getState().noteCanvasLayouts[key] !== captured) return
    useAppStore.setState(state => {
      const { [key]: _issue, ...kept } = state.noteCanvasSaveIssues
      return { noteCanvasSaveIssues: kept }
    })
  } catch (error) {
    if (captured && useAppStore.getState().noteCanvasLayouts[key] !== captured) return
    useAppStore.setState(state => ({ noteCanvasSaveIssues: { ...state.noteCanvasSaveIssues,
      [key]: 'Canvas layout could not be saved. Your current positions are kept. ' + presentError(error) } }))
  }
}
