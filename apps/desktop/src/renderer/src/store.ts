import { restoredQuestionReplies, type DesktopQuestionReplies, type DesktopQuestionReplyAttempt, type DesktopQuestionDrafts } from './lib/conversation-question-intent'
import { fileWorkbenchIdentity } from './lib/file-workbench-state'
import { mintObjectId } from '@agentmux/core/object-id'
import { readAgentPromptPreparationWait } from '@agentmux/core/prompt-preparation'
import { submitWithPreparationRetry, type PromptPreparationRetryProgress } from './lib/prompt-preparation-retry'
import { moteDefaultExecutor, moteDefaultConversation } from './lib/mote-quick-preferences'
import { showMoteConversation } from './lib/mote-conversation-mode'
import { goalPmoOperation, type GoalPmoIntent, type GoalPmoReceipt } from '../../shared/goal-pmo-origin'
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
import { rendererPerformance } from './lib/renderer-performance'



import { readAgentPresentation, readMotePresentation, readSpatialAppearance, readSurveyPresentation } from './lib/mobile-presentation'
import { scratchTopicsForConfig } from './lib/scratch-topic-snapshots'
import { conversationReplySourceKey, type ConversationReplySource } from '@agentmux/core/prompt-reaction'

import type { AgentPromptExecution } from '@agentmux/core'
import { changeNotebook, type NoteNotebookContext } from './lib/notebook-library'
import { DEFAULT_NOTEBOOK_ID } from '@agentmux/core/notebook-catalog'
import { validateProjectGroup } from './lib/cross-device-project-groups'
import type { AgentMuxProjectGroupFact, TopicCategory } from '@agentmux/core/control'
import { refreshTopicSpatial } from './lib/topic-knowledge-actions'
import { categoriesFromSpatial } from '../../shared/topic-categories'
import {DesktopSpatialPersistence,desktopSpatialGraph,desktopWorkbenchFromSpatial,desktopBindingsFromSpatial,sameSpatialValue} from './lib/desktop-spatial-state'
import { acknowledgedNameProjection, projectedNameRevision } from './lib/name-authority'
import type { AgentMuxDisplayLabel, AgentMuxNameTarget, AgentMuxDisplayLabelResult } from '@agentmux/core/spatial-graph'
import { displayLabel } from '@agentmux/core/spatial-graph'
import { createSurveyBrowser } from './lib/survey-browser-creation'
import { isToolkitRequest } from '@agentmux/core/control'
import { restoredSurveyExplorationNames } from './lib/survey-exploration-name'
import { useLauncherState } from './lib/launcher-state'
import { noteBlockSelectionKey, restoreNoteBlockSelections, type NoteBlockPresentation } from './lib/note-block-selection'
import { noteKnowledge, parseNoteFile } from './lib/note-knowledge'
import { warmLauncherId, type WarmTerminalCreation } from './lib/warm-terminal-preview'
import { NOTE_FILE_EXTENSION, newNoteDocument, readNoteDocument } from '../../shared/note-document'
import { noteCreationTarget, noteCreationDisplayWorkspace, noteCreationResourceMatches, noteFilePlacement, type NoteCreationReceipt } from './lib/note-creation'
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
import { executeWorkfaceRegionSwap } from './lib/workface-region-swap'
import { executeWorkfaceFileOpen } from './lib/workface-file-open'
import { executeWorkfaceFileView } from './lib/workface-file-view'
import type { WorkbenchProjectionSelection } from './lib/workbench-projection'
import type { WorkbenchPresentation } from './lib/workbench-presentation'
import { mainRegionReference, desktopMainSurface, desktopSelection, desktopSpaceSelectionAfterClose, resolveDesktopSpaceSelection, resolveWorkbenchOccurrenceSelection, workbenchSelectionCatalog, projectWorkbenchSpaceSelection, workbenchObjectLayout, restoreWorkbenchSpaceSelection, DesktopFocusFailure } from './lib/desktop-focus-navigation'
import { captureDesktopInput, readDesktopPresentation, awaitDesktopPresentation, desktopInputPreserved } from './lib/desktop-presentation'
import { notebookRelocations, refreshNotebookLibrary, recordNotebookChanges, restoreNotebookRecoveries, useNotebookLibrary, type NotebookRecovery } from './lib/notebook-library'
import type { AgentMuxDesktopSpaceSelection, AgentMuxDesktopFocusResult, AgentMuxSpatialSave, AgentMuxSpatialIssue } from '@agentmux/core/control'
import type { SpaceZoneBindings, SpatialRequestBinding } from '../../shared/space-addresses'
import { directoryIdentity, homeZoneId, topicSpatialAddress } from '../../shared/space-addresses'
import type { DemandAlignmentProposal, DemandGroundingProposal } from '@agentmux/demand/goals'
import { readContinuousProgressInput } from './lib/continuous-progress-input'
import type { DesktopWorkbenchObservation } from '../../shared/client-observation'
import { sessionPresentationById, agentSessionPresentationIndex } from './lib/session-presentation'
import { observeFocusHistoryIdentity } from './lib/focus-history-identity'
import { clampFocusTimelineHeight, FOCUS_TIMELINE_HEIGHT_DEFAULT } from './lib/focus-timeline-height'
import { clampFocusTimelineNameWidth, FOCUS_TIMELINE_NAME_WIDTH_DEFAULT } from './lib/focus-timeline-name-width'
import { DEFAULT_FOCUS_RULER, restoreFocusRuler, sameFocusRuler, type FocusRulerPreferences } from './lib/focus-timeline-ruler'
import { readTerminalViewObservation } from './lib/terminal-view-observation'
import type { GitDiffDescriptor, GitCommitSnapshot } from '../../shared/git-contracts'
import { confirmedSteerDelivery, reconcileDeliveredSteers } from './lib/steer-queue-delivery'
import { browserOperatorForSession } from './lib/browser-operator-identity'
import { clampProjectRailWidth, PROJECT_RAIL_DEFAULT_WIDTH } from './lib/project-rail-width'
import { clampSurveySidebarWidth, SURVEY_SIDEBAR_DEFAULT_WIDTH } from './lib/survey-sidebar-width'
import { requireSpaceIconSelection, restoreSpaceIconOverrides, type SpaceIconChoice, type SpaceIconOverrides } from './lib/space-object-appearance'
import { create } from 'zustand'

import { currentExecutorDetection, executorDetectionMatches, executorDetectionKey } from './lib/executor-detection'
export { executorDetectionKey } from './lib/executor-detection'
import { executorsForHost } from './lib/executors'
import { lifecycleFailureBelongsTo, type AgentLifecycleFailure } from './lib/agent-lifecycle-feedback'
import { persist } from 'zustand/middleware'
import { restoredSurveyCollection, restoredSurveyZoneSelection, persistedSurveyZoneSelection, surveySelectionAfterClose, surveySelectionAfterPromote, type SurveyZoneSelection, type PersistedSurveyZoneSelection } from './lib/survey-workface'
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
import type { AgentCatalogEntry, AgentMuxInteractionResponse, AgentSessionHistoryDescriptor } from '@agentmux/core'
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
import { isScratchWorkspaceId } from '../../shared/contracts'
import { bookmarkFileNameFromTitle, bookmarkKindForPath, emitWebloc } from '../../shared/bookmark-file'
import { reconcileNotesStorageResources, reconcileNotesLauncherDrafts, reobserveNotesStorageResources } from './lib/notes-storage-reconciliation'
import type { NotesStorageSnapshot } from '@agentmux/core/notebook-store'
import { api } from './lib/api'
import { sessionLaunchFailure } from '../../shared/session-launch-result'
import { composeAgentPrompt } from '@agentmux/core/agent-outbound-message'
import { errorIdentity, presentError } from '@agentmux/client-ui/error-presentation'
import type { ServiceNoticeKind } from './lib/service-window-notice'
import { steerEntryTargetsRun, steerQueueCanDrainNow } from './lib/agent-steer-queue-drain'
import { beginMoteStartupRecovery, cancelMoteSessionRecovery, deferScratchConversationRecovery, recoverMoteConversationAtStartup, recoverScratchConversationsAtStartup } from './lib/mote-session-recovery'
import { agentStartupRecoveryDecision, agentStartupRecoveryDetail } from './lib/idle-agent-restore-policy'
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
  messageTargetCandidates,
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
import { reduceBrowserEvent } from './lib/browser-state'
import {
  bumpWorkspaceFileRevision,
  reduceDocumentAttached,
  reduceDocumentContent,
  reduceDocumentLoadFailed,
  reduceDocumentRead,
  reduceDocumentReloaded,
  reduceDocumentSaving,
  reduceDocumentWriteError,
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
import type { StartupProgress } from './lib/startup-progress'

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
  /** An explicit new discussion keeps the Mote identity and owns its first draft before preparation. */
  newTab?: boolean
  initialRequest?: { prompt: string; agentMuxNote?: string; executorId?: string }
  /** User navigation reveals the Topic workbench; background preparation must leave focus alone. */
  reveal?: boolean
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

/** Attributes of the one current/last transient notice, never a second Agent status record. */
export type ErrorNoticeContext = {
  kind: ServiceNoticeKind
  /** Explicit presentation from the diagnostic producer; the complete error remains authoritative. */
  summary?: string
  subject?: SessionControl
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
export type AgentSteerOptions = { goalDispatch?: import('../../shared/goal-dispatch').GoalDispatchReference; goalPmo?: GoalPmoIntent; execution?: AgentPromptExecution; reaction?: AgentSteerReaction; sourceChannel?: import('@agentmux/core').AgentMessageChannel; goalContinuation?: { goalId: string; loopId: string; condition: AgentPromptCondition } }

export type AgentSteerQueueEntry = {
  operationId: string
  /** The first accepted local intent time; absent means it was never recorded. */
  enqueuedAt?: number
  runId?: string
  /** null is a new, never-dispatched intent; absence is an unknown historical intent. */
  promptCondition?: AgentPromptCondition | null
  text: string
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
  origin?: 'manual'
  /** Frozen when explicitly selected, before awaits. Queue-only default leaves it absent;
   * known-null retains that original selection across recovery/wait, but boot pauses it. */
  execution?: AgentPromptExecution
}

/** A missing or frozen condition is not evidence that this message was never submitted. */
export function agentSteerCanEdit(entry: AgentSteerQueueEntry, inFlightId?: string): boolean {
  return !entry.archived && entry.promptCondition === null && entry.operationId !== inFlightId
}

function pendingSteerRecord(entry: AgentSteerQueueEntry, inFlightId?: string, phase?: 'preparing' | 'submitting', confirmed = false): AgentMuxPendingMessage {
  return { pendingId: entry.operationId, text: entry.text, runId: entry.runId ?? null,
    enqueuedAt: entry.enqueuedAt ?? null, status: entry.status,
    phase: entry.operationId === inFlightId ? phase ?? 'preparing' : null,
    editable: !confirmed && agentSteerCanEdit(entry, inFlightId),
    delivery: confirmed ? 'confirmed' : entry.promptCondition === null || entry.preparationInputNotApplied ? 'not-submitted' : 'unconfirmed',
    errorCode: entry.errorCode ?? null, error: entry.error ?? null, ...(entry.logId ? { logId: entry.logId } : {}), ...(entry.preparationWait ? { preparationWait: entry.preparationWait } : {}), archived: entry.archived === true }
}

/** One admission and its labels share the original execution choice, including unknown old input. */
export function agentSteerExecution(entry: AgentSteerQueueEntry,
  capabilities: Extract<SessionSnapshot, { kind: 'agent' }>['capabilities']): AgentPromptExecution {
  return entry.execution ?? (entry.promptCondition === null &&
    (capabilities.promptExecution?.immediate === 'interrupt-before-input' || capabilities.promptExecution?.immediate === 'native-steer') ? 'immediate' : 'default')
}






function reactionIntentKey(reaction?: AgentSteerReaction): string | undefined {
  return reaction ? JSON.stringify([reaction.code, conversationReplySourceKey(reaction.replySource)]) : undefined
}
type AppState = {
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
  warmTerminal: WarmTerminal | null
  unclaimedTerminalSessionIds: string[]
  timelines: Record<string, import('./lib/session-state').RendererAgentTimelineSnapshot>
  pendingAgentLaunches: Record<string, PendingAgentLaunch>
  activeWorkspaceId: string | null
  /** 用户拖出来的 Topic 顺序。是一份偏好，不是真相来源——磁盘上没有的不会因它出现。 */
  scratchTopicOrder: string[]
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
  regionCaretFocus: { regionId: string; nonce: number } | null
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
  agentComposerDrafts: Record<string, string>
  agentComposerHistory: Record<string, readonly string[]>
  agentComposerHistoryNavigation: Record<string, Omit<HistoryState, 'entries'>>
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
  mainSurface: MainSurface
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
  acceptDemandResult(demandId: string, expectedAlignmentRevision: number, expectedSubmissionId: string, acceptGaps?: boolean): Promise<void>
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
  toolsOpen: boolean
  /** Transient leases held by Renderer overlays that must sit above window-level native surfaces. */
  nativeSurfaceOverlayCount: number
  /**
   * 观察到的、portal 到 React 根之外的浮层数（Radix 的 Dialog/菜单/下拉/Popover 全在此列）。
   *
   * 与上面那把手工租约**分开存**，因为它们的生命周期不同：这个由一个 MutationObserver 全量观察
   * 后整体写入（绝对值），那个由个别浮层自己 acquire/release（增量）。混成一个数的话，观察器
   * 的每次整体写入都会把手工租约抹掉。两者在 `nativeSurfacesVisible` 那一处合并，只合并一次。
   *
   * 为什么要观察而不是让每个浮层上报：全仓 21 个文件用 Radix 的 Root，逐个接线会漂——新加一个
   * 对话框的人不会知道有这条规矩，而没有任何断言会红（它只在恰好开在浏览器上方时才消失）。
   * 判据落在 Radix 自己的 DOM 协议上，新加的第 22 个自动覆盖。
   */
  portalOverlayCount: number
  workspaceTool: WorkspaceTool
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
  error: string | null
  /** Last transient error remains available after dismissal/navigation for a deliberate reopen. */
  lastError: string | null
  errorNoticeContext: ErrorNoticeContext | null
  errorDismissed: boolean
  /** UI projection of the latest save request failure, never a persistence or Agent health owner. */
  workbenchSaveWarning: string | null
  nameSaveUnconfirmed: { operationId: string; target: AgentMuxNameTarget; message: string } | null
  nameEditFailure: { operationId: string; target: AgentMuxNameTarget; message: string } | null
  confirmNameSave(): Promise<void>
  reviewNameEdit(): Promise<void>
  reportWorkbenchSaveFailure(error: unknown): void
  retryWorkbenchSave(): Promise<void>
  initialize(): Promise<() => void>
  selectWorkspace(id: string): Promise<void>
  activateWorkspaceSelection(result: WorkspaceSelectionResult): void
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
  selectSession(id: string, tabGroupId?: string): void
  prepareWorkbenchLayout(workspaceId: string): WorkspaceLayout
  createWorkbenchZone(input: { workspaceId: string; spaceIds: readonly string[] }): Promise<{ zone: AgentMuxZoneFact; save: AgentMuxSpatialSave; issues: AgentMuxSpatialIssue[] }>
  setZoneSpaceRelation(zoneId: string, spaceId: string, linked: boolean): Promise<AgentMuxSpaceBindingReport>
  setTabDisplayPlacement(tabId: string, displayWorkspaceId: string, groupId: string, present: boolean): Promise<AgentMuxSpaceBindingReport>
  openLauncher(target: { workspaceId: string; displayWorkspaceId?: string; tabGroupId?: string; topicId?: string; zoneId?: string; reveal: boolean;
    /** Claim an empty Group's original input in its new real Region, without navigating another surface. */
    initialInputs?: { prompt: string; names: LauncherNames; optionsByProvider: LauncherProviderOptions }
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
    direction: SplitDirection
  ): void
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
  showGitCommitDetails(regionId: string): void
  selectGitFile(regionId: string, file: { path: string; origPath: string | null } | null): void
  selectGitCommit(regionId: string, snapshot: GitCommitSnapshot): void
  loadBranchDiff(regionId: string): Promise<void>
  /** Release a budgeted Git Diff payload; its durable Region and fixed descriptor stay intact. */
  releaseBranchDiff(regionId: string): void
  setMainSurface(surface: MainSurface): void
  toggleProjectRail(): void
  toggleProjectGroup(key: string): void
  setPortalOverlayCount(count: number): void
  acquireNativeSurfaceOverlay(): void
  releaseNativeSurfaceOverlay(): void
  setWorkspaceTool(tool: WorkspaceTool): void
  toggleTools(): void
  setProjectRailWidth(width: number): void
  setToolDockWidth(width: number): void
  updateFileExplorerState(
    workspaceId: string,
    update: (current: FileExplorerViewState) => FileExplorerViewState
  ): void
  detectExecutors(hostId: string): Promise<void>
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
  saveDocument(tabId: string, regionId?: string): Promise<void>
  overwriteDocument(tabId: string, regionId?: string): Promise<void>
  useRetainedDocumentDraft(tabId: string, regionId?: string): void
  reloadDocument(tabId: string, regionId?: string): Promise<void>
  refreshDocument(workspaceId: string, path: string): Promise<void>
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
    names?: { agentName?: string | undefined; tabName?: string | undefined },
    agentMuxNote?: string,
    pmo?: { intent: GoalPmoIntent; onCreated: (result: AgentLaunchResult) => void }
  ): Promise<void>
  launchTerminal(
    tabGroupId: string,
    launcher?: { tabId: string; regionId: string },
    workspacePath?: string
  ): Promise<void>
  // Idempotent for one host + cwd. Failures stay local to the create page.
  //
  // `ownerLauncherId` 是**哪个 launcher 挂载点在请求**。槽只有一个而 launcher 每个挂载点一个（分屏、
  // 每个 group 的空占位），归属必须由槽记着、不能由各个 launcher 各自推断，否则它们会同时挂
  // TerminalView 到同一个 PTY 上并对着它轮流 resize。同 key 再请求会把归属**转移**过来（不重开 PTY）。
  prewarmTerminal(workspaceId: string, ownerLauncherId: string): void
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
    requestedDisplayWorkspaceId?: string
  ): Promise<void>
  openHttpLink(origin: OpenHttpLinkOrigin, url: string, destination: OpenDestination, presentation?: Pick<WorkbenchPresentation, 'surface' | 'onSelectRegion'>): Promise<void>
  /**
   * 把一个页面存成 `.webloc` 书签，落在 workspace 根下。文件名由标题派生并做撞名退避
   * （`Name.webloc`、`Name 2.webloc`…），返回落地的相对路径。取消（about:blank）或全部候选都撞名
   * 时抛，由调用方（BrowserPane 的 run）报到错误面。
   */
  saveBrowserBookmark(workspaceId: string, url: string, title: string): Promise<string>
  applyBrowserEvent(event: BrowserEvent): void
  addBrowserAnnotation(annotation: BrowserAnnotation): void
  deleteBrowserAnnotation(browserId: string, annotationId: string): void
  clearBrowserAnnotations(browserId: string): void
  recordAgentComposerHistory(sessionId: string, text: string): void
  recallAgentComposerHistory(sessionId: string, direction: 'older' | 'newer', draft: string): string | null
  setAgentComposerDraft(sessionId: string, text: string): void
  /**
   * 写启动对话框的一格名字。`field` 只有 'agentName' | 'tabName' 两种，两格共用一条 action：
   * 一格一个 setter 会让"启动成功要清掉这个 region 的名字草稿"变成两处要记得改的地方。
   */
  setLauncherExecutionWorkspace(launcher: { tabId: string; regionId: string }, workspaceId: string, executorId?: string): void
  setLauncherNameDraft(regionId: string, field: LauncherNameField, value: string): void
  setLauncherOptionDraft(regionId: string, providerId: string, optionId: string, choiceId: string | null): void
  appendAgentComposerDraft(sessionId: string, text: string): void
  clearAgentComposerDraftIfUnchanged(sessionId: string, expectedText: string): void
  /** Queue a steer. `false` means it was refused (empty, not an Agent, or over the size budget) and the caller must keep the draft. */
  enqueueAgentSteer(sessionId: string, text: string, onRejected?: (error: unknown) => void, operationId?: string, origin?: 'manual', agentMuxNote?: string, options?: AgentSteerOptions): boolean
  archiveAgentSteer(sessionId: string, operationId: string, expectedText: string, archived: boolean): Promise<{ changed: boolean; entry: AgentSteerQueueEntry }>
  moveAgentSteer(sessionId: string, operationId: string, direction: 'up' | 'down'): void
  editQueuedAgentSteer(sessionId: string, operationId: string, expectedText: string, nextText: string): void
  sendQueuedAgentSteer(sessionId: string, operationId: string): Promise<'submitted' | 'unconfirmed'>
  cancelAgentSteerPreparation(sessionId: string, operationId: string): boolean
  flushAgentSteerQueue(sessionId: string, explicitOperationId?: string): Promise<void>
  send(sessionId: string, text: string, onRejected?: (error: unknown) => void, origin?: 'manual', agentMuxNote?: string, options?: AgentSteerOptions): boolean
  respondInteraction(sessionId: string, response: AgentMuxInteractionResponse): Promise<void>
  setPosture(sessionId: string, modeId: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  refreshSession(sessionId: string): Promise<SessionSnapshot | undefined>
  reopenRetiredSession(source: AgentSessionHistoryDescriptor, operationId?: string, observeOnly?: boolean): Promise<SessionSnapshot | undefined>
  recoverSession(sessionId: string, operationId?: string, options?: { preserveView?: boolean; stillCurrent?: () => boolean }): Promise<SessionSnapshot | undefined>
  stopSession(sessionId: string): Promise<void>
  canonicalizeAgentLaunch(result: AgentLaunchResult): Promise<AgentLaunchResult | null>
  resyncTimeline(sessionId: string, options?: { observationOnly?: boolean }): Promise<void>
  applyEvent(event: RuntimeEvent): void
  /**
   * 把所有已陈旧的 `working` Agent 降为中性态（见 lib/agent-status-decay）。传 `now` 而非内部读
   * Date.now()，判定才可断言、测试才不 flake。什么都不该降时不写入，避免无谓的重渲染。
   */
  decayStaleAgentStatuses(now: number): void
  setConfig(config: AppConfig): void
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
const hostExecutorRequests = new Map<string, symbol>()
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
    useAppStore.setState((state) => reduceDocumentRead(state, workspaceId, path, result, checkedWrite))
  } finally {
    stopObservingResource()
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

async function enqueueFileSave(
  tabId: string,
  overwrite: boolean,
  regionId?: string
): Promise<void> {
  const initialTab = useAppStore.getState().tabs[tabId]
  const initialSurface = fileSurface(initialTab, regionId)
  if (!initialSurface) return
  const key = documentKey(initialSurface.workspaceId, initialSurface.path)
  const queuedLifetime = documentLifetime(key)
  const previous = fileSaveTails.get(key) ?? Promise.resolve()
  const mutation = workspaceFileMutationTails.get(initialSurface.workspaceId) ?? Promise.resolve()
  const operation = Promise.all([previous.catch(() => {}), mutation.catch(() => {})]).then(async () => {
    const state = useAppStore.getState()
    const tab = state.tabs[tabId]
    const surface = fileSurface(tab, regionId)
    if (!surface) return
    const currentKey = documentKey(surface.workspaceId, surface.path)
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
    const generation = state.documentGenerations[currentKey] ?? 0
    const observationGeneration = state.documentObservationGenerations[currentKey] ?? 0
    const savedLifetime = documentLifetime(currentKey)
    let expectedRevision: string | null = document.revision
    if (overwrite) expectedRevision = issue?.kind === 'changed' ? issue.observed.revision : null
    useAppStore.setState((current) => reduceDocumentSaving(current, surface.workspaceId, surface.path, true))
    let result
    try {
      result = await api.files.write(surface.workspaceId, {
        path: surface.path,
        content: document.content,
        expectedRevision
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
          observationGeneration
        )
        return isScratchTopicDocument(surface)
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
        documentIssues: { ...current.documentIssues, [currentKey]: { kind: 'write-unknown', code: result.code, message: result.message,
          attempted: { content: document.content, expectedRevision, generation,
            resource: { hostId: savedResource.hostId, path: savedResource.path } } } } }))
      return
    }
    if (result.status === 'error') {
      useAppStore.setState((current) => reduceDocumentWriteError(current, surface.workspaceId, surface.path, result.code, result.message))
      return
    }
    useAppStore.setState((current) => reduceDocumentSaving(current, surface.workspaceId, surface.path, false))
    await refreshFileDocument(surface.workspaceId, surface.path, savedLifetime)
  })
  const tail = operation.then(() => {}, () => {})
  fileSaveTails.set(key, tail)
  try {
    await operation
  } finally {
    if (fileSaveTails.get(key) === tail) fileSaveTails.delete(key)
  }
}

type BufferedSessionEvent = {
  event: RuntimeEvent
  pendingLaunchAgentSessionId: string | null
  sequence: number
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
  if (event.endpointObservation) entry.endpointWarnings.set(JSON.stringify([event.hostId, event.endpointObservation.step]), {
    hostId: event.hostId, warning: event.endpointObservation.warning, observationStep: event.endpointObservation.step, restored: false
  })
  entry.events.push({ event, pendingLaunchAgentSessionId, sequence: ++entry.sequence })
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
  observationStep?: string
): RuntimeEndpointWarning[] | undefined {
  if (warning === undefined) return warnings
  const step = observationStep ?? (warning?.scope === 'observation' ? warning.step : undefined)
  const retained = (warnings ?? []).filter(previous => previous.hostId !== hostId || (step !== undefined
    ? previous.scope !== 'observation' || previous.step !== step : previous.scope === 'observation'))
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
        let historySources: readonly AgentSessionHistoryDescriptor[] = []
        const restoredHistory = useAppStore.getState().runtimeEndpointWarnings?.some(warning => warning.scope === 'observation'
          && warning.step === 'Reading retained History sources' && entry.restoredHostIds.has(warning.hostId))
        if (entry.startupNotice?.startupSessionSnapshot || restoredHistory && historyAttempts < MAX_STARTUP_OBSERVATION_ATTEMPTS) {
          historyAttempts++
          try {
            const observed = await api.sessions.historySources({ observation: true })
            historySources = observed.sources
            snapshot = { ...snapshot, runtimeEndpointWarnings: runtimeEndpointWarningsAfterMetadataRead(
              snapshot.runtimeEndpointWarnings, 'Reading retained History sources', observed.warnings) }
          }
          catch { /* A failed metadata read cannot settle the original unknown-facts notice. */ }
        }
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
          const protectedAgentSessionIds = new Set([...savedCut.rejectedSavedIds, ...events.flatMap((pending) => (
            pending.pendingLaunchAgentSessionId ? [pending.pendingLaunchAgentSessionId]
              : sessionEventAgentId(pending.event) ? [sessionEventAgentId(pending.event)!] : []
          ))])
          let projected = reduceAgentMembershipSnapshot(state, snapshot, protectedAgentSessionIds)
          projected = reduceTerminalMembershipSnapshot(projected, snapshot, savedCut.rejectedSavedIds)
          for (const candidate of startupCandidates) {
            if (projected.sessions.some((session) => session.id === candidate.agentSessionId)) continue
            const decision = agentStartupRecoveryDecision({
              runState: 'missing',
              ...(candidate.semanticStatus ? { semanticStatus: candidate.semanticStatus } : {}),
              canonical: !runtimeSnapshotHostUnavailable(snapshot, candidate.hostId),
              now: Date.now()
            })
            projected = { ...projected, sessions: [...projected.sessions, recoveryCandidateSession(candidate, {
              kind: 'pending', detail: agentStartupRecoveryDetail(decision)
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
            const retiredReferences = retiredHistoryReferenceIds(historySources, projected.tabs, state.config)
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
              pending.event.endpointObservation.warning, pending.event.endpointObservation.step) : next
          }, snapshot.runtimeEndpointWarnings ?? [])
          for (const { hostId, warning, restored, observationStep } of entry.endpointWarnings.values()) {
            if (restored && warning === null) continue
            runtimeEndpointWarnings = runtimeEndpointWarningsAfterObservation(runtimeEndpointWarnings, hostId, warning, observationStep)
          }
          entry.endpointWarnings.clear()
          return { ...reconciled, sessionNameMetadata: snapshot.sessionNameMetadataWarning ? state.sessionNameMetadata : sessionNameMetadataRecord(snapshot.sessionNameMetadata ?? [], state.sessionNameMetadata), sessionNameMetadataWarning: snapshot.sessionNameMetadataWarning ?? null, sessions: projectRuntimeEndpointSessions(reconciled.sessions, runtimeEndpointWarnings), ...resolvedStartupNotice, runtimeEndpointWarnings, runtimeOwnershipWarnings: snapshot.runtimeOwnershipWarnings ?? [], environmentWarning: snapshot.environmentWarning ?? null }
        })
        for (const pending of events) {
          const diagnostic = runtimeDiagnosticNotice(useAppStore.getState(), pending.event)
          if (diagnostic) useAppStore.getState().reportError(diagnostic.message, { kind: 'indeterminate', summary: diagnostic.summary,
            ...(diagnostic.subject ? { subject: diagnostic.subject } : {}) })
        }
        for (const candidate of startupCandidates) {
          if (restoredDuringRead.has(candidate.hostId)) continue
          const current = useAppStore.getState().sessions.find((session) => session.id === candidate.agentSessionId)
          if (!current || attemptedStartupRecovery.has(candidate.agentSessionId)) continue
          const recoveryState = useAppStore.getState()
          if (current.kind === 'agent' && deferScratchConversationRecovery(recoveryState.tabs, recoveryState.config, current.id)) {
            await recoverMoteConversationAtStartup(current)
            if (sessionMembershipResync !== entry) return
            continue
          }
          const decision = agentStartupRecoveryDecision({
            runState: current.processState,
            ...(candidate.semanticStatus ? { semanticStatus: candidate.semanticStatus } : {}),
            canonical: !runtimeSnapshotHostUnavailable(snapshot, candidate.hostId),
            now: Date.now()
          })
          if (decision.kind !== 'resume') continue
          attemptedStartupRecovery.add(candidate.agentSessionId)
          await useAppStore.getState().recoverSession(candidate.agentSessionId)
          if (sessionMembershipResync !== entry) return
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
        const retryRestoredHistory = historyAttempts < MAX_STARTUP_OBSERVATION_ATTEMPTS && useAppStore.getState().runtimeEndpointWarnings?.some(warning => warning.scope === 'observation'
          && warning.step === 'Reading retained History sources' && entry.restoredHostIds.has(warning.hostId))
        if (!membershipGap && entry.events.length === 0 && !entry.overflowed && !retryProvider && !retryPartialProvider && !retryStartupSnapshot && !retryRestoredHistory && !providerRefreshed && !restoredProviderRead) return
        // One owner/one read, with a yield and capped backoff under sustained pressure.
        await delaySessionMembershipRead(entry, retryDelay)
        retryDelay = Math.min(1000, retryDelay * 2)
      }
    } catch (error) {
      // A best-effort retry launched after an initial startup outage must not replace the richer
      // service-window warning that already explains the failed step. Event-driven resyncs still
      // surface their failure through the ordinary Store error channel.
      if (options.reportFailure !== false) useAppStore.getState().reportError(error)
    } finally {
      if (sessionMembershipResync === entry) sessionMembershipResync = null
    }
  })()
}

type WarmTerminal = {
  // Prevents a shell from being reused for the wrong host or working directory.
  key: string
  /**
   * 哪个 launcher 挂载点拥有这个槽——只有它渲染 live preview。
   *
   * 槽是**全局单个**（一台机器上不该为没人认领的 shell 攒 N 个 PTY），而 launcher 是**每个挂载点
   * 一个**：分屏能在同一个 Tab 里开出好几个，空分组占位又能在每个 group 里各有一个，它们的 warmKey
   * 完全一样（同 host 同 cwd）。没有 owner 这个字段时，每个 launcher 都认为
   * `warmTerminal.key === warmKey` 成立，于是**都**挂一个 TerminalView 到同一个 run 上。attach 那侧
   * 不会抛（同一个 identity 走 readRunReplay），所以没有任何报错——但两个 view 各有自己的 FitAddon
   * 与 ResizeObserver，尺寸不同就对着同一个 PTY 轮流 resize，网格来回跳、两边的 xterm 都在错误的
   * 行列上重排。
   *
   * 所以「谁拥有」必须是槽自己的一部分，而不是各个 launcher 各自推断。取值来自组件侧的
   * `warmLauncherId({ tabGroupId, regionId })`（见 `lib/warm-terminal-preview.ts`）：每个挂载点都有、
   * 同胞之间互不相同、且跨重渲染稳定。**不可直接用 regionId**——空分组占位没有 region，而那恰是新建
   * workspace 的第一眼，可缺席的字段当不了归属键；那个函数缺 region 时退到所属 group 并各自加前缀。
   */
  ownerLauncherId: string
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
  goalAgentCreationDrafts?: Record<string, GoalAgentCreationDraft>
  /** Exact logical focus retained when a background move removes the active leaf. */
  retainedSpatialFocus: (AgentMuxSpaceAddress & { topicId?: string }) | null
  agentComposerDrafts?: Record<string, string>
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
  surveyExplorationNames?: Record<string, string>
  noteBlockSelections?: Record<string, NoteBlockTarget>
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
  toolsOpen?: boolean
  workspaceTool?: WorkspaceTool
  projectRailWidth?: number
  toolDockWidth?: number
  editorWordWrap?: boolean
  editorMinimap?: boolean
  explorerShowHidden?: boolean
  explorerShowIgnored?: boolean


}

export type RestoredUiState = Pick<
  AppState,
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
  | 'surveyExplorationNames'
  | 'noteBlockSelections'
  | 'surveySidebarCollapsed'
  | 'surveySidebarWidth'
  | 'projectRailOpen'
  | 'collapsedProjectGroups'
  | 'explorerCollapsed'
  | 'pinnedItems'
  | 'spaceObjectIcons'
  | 'toolsOpen'
  | 'workspaceTool'
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
    | 'surveyExplorationNames'
    | 'noteBlockSelections'
    | 'surveySidebarCollapsed'
    | 'surveySidebarWidth'
    | 'projectRailOpen'
    | 'collapsedProjectGroups'
    | 'explorerCollapsed'
    | 'pinnedItems'
    | 'spaceObjectIcons'
    | 'toolsOpen'
    | 'workspaceTool'
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
    surveyExplorationNames: restoredSurveyExplorationNames(persisted.surveyExplorationNames),
    noteBlockSelections: restoreNoteBlockSelections(persisted.noteBlockSelections),
    surveySidebarCollapsed: restoredBoolean(persisted.surveySidebarCollapsed, false),
    surveySidebarWidth: clampSurveySidebarWidth(persisted.surveySidebarWidth ?? SURVEY_SIDEBAR_DEFAULT_WIDTH),
    projectRailOpen: restoredBoolean(persisted.projectRailOpen, true),
    collapsedProjectGroups: restoredCollapsedGroups(persisted.collapsedProjectGroups),
    explorerCollapsed: restoredExplorerCollapsed(persisted.explorerCollapsed),
    pinnedItems: restoredPinnedItems(persisted.pinnedItems),
    spaceObjectIcons: restoreSpaceIconOverrides(Object.hasOwn(config.appearance, 'spaceObjectIcons') ? config.appearance.spaceObjectIcons : retainedSpaceIconHandoff ?? persisted.spaceObjectIcons),
    toolsOpen: restoredBoolean(persisted.toolsOpen, true),
    workspaceTool: restoredWorkspaceTool(persisted.workspaceTool),
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
function selectPersistedInputs(state: AppState) {
  return {
    workbenchSpaceSelection: state.workbenchSpaceSelection,
    projectGroups: state.projectGroups,
    spaceZoneBindings: state.spaceZoneBindings,
    spatialRequests: state.spatialRequests,
    goalAgentSelectionDrafts: state.goalAgentSelectionDrafts,
    goalAgentCreationDrafts: state.goalAgentCreationDrafts,
    retainedSpatialFocus: state.retainedSpatialFocus,
    agentComposerDrafts: state.agentComposerDrafts,
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
    dirtyDocuments: state.dirtyDocuments,
    tabs: state.tabs,
    layouts: state.layouts,
    unclaimedTerminalSessionIds: state.unclaimedTerminalSessionIds,
    // 拖出来的顺序是用户意图，重开应该还在。它只是偏好：恢复时对不上磁盘的条目会被 orderTopics 丢掉。
    scratchTopicOrder: state.scratchTopicOrder,
    // Agent 手改名是用户意图，重开要还在。key 是 session id；已消失的 session 留一条死名字无害——
    // 它不投影到任何界面（没有对应 session），下次同 id 复现的概率是 uuid 级零。
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
    toolsOpen: state.toolsOpen,
    workspaceTool: state.workspaceTool,
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
  const inputs = selectPersistedInputs(state)
  if (previousPersistedInputs && previousPersistedProjection && previousCoreSpatialReady===Boolean(coreSpatialPersistence?.ready) && shallow(previousPersistedInputs, inputs)) {
    return previousPersistedProjection
  }
  const { tabs, layouts, documents, dirtyDocuments, ...presentation } = inputs
  const projection: PersistedAppState = {
    ...presentation,
    recallNotebookId: presentation.recallNotebookId, recallNoteId: presentation.recallNoteId,
    recallZoneSelection: persistedSurveyZoneSelection(presentation.recallZoneSelection),
    surveyZoneSelection: persistedSurveyZoneSelection(presentation.surveyZoneSelection),
    documents: Object.fromEntries(Object.entries(documents).filter(([key]) => dirtyDocuments[key])),
    dirtyDocuments: Object.fromEntries(Object.entries(dirtyDocuments).filter(([, dirty]) => dirty)),
    restoredWorkbench: projectPersistedWorkbench({ tabs, layouts })
  }
  if(coreSpatialPersistence?.ready) { delete projection.restoredWorkbench;delete projection.spaceZoneBindings;delete projection.projectGroups }
  if (state.nameAuthorityRevision > 0) { delete projection.agentNames; delete projection.surveyExplorationNames }
  previousCoreSpatialReady=Boolean(coreSpatialPersistence?.ready)
  previousPersistedInputs = inputs
  previousPersistedProjection = projection
  return projection
}

let coreSpatialPersistence:DesktopSpatialPersistence|null=null
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
  for (const label of Object.values(names?.nameLabels ?? {})) {
    if (label.target.kind !== 'tab' || !tabs[label.target.id]) continue
    const tab = tabs[label.target.id]!, renamed = renameWorkbenchTab(tab, label.value)
    if (renamed !== tab) tabs = { ...tabs, [tab.id]: renamed }
  }
  useAppStore.setState({ ...names, tabs, nameSaveUnconfirmed,
    ...(ack ? { nameAcknowledgementRevision: saved.revision } : {}) })
}
async function commitDisplayName(target: AgentMuxNameTarget, value: string | null,
  source: 'manual' | 'launch', expectedNameRevision = currentDisplayNameRevision(target.kind, target.id)):
  Promise<AgentMuxDisplayLabelResult> {
  // A new target needs registration; an existing name does not depend on unrelated layout writes.
  const operationId = crypto.randomUUID()
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
async function requestWorkbenchStorageFlush(): Promise<void> {
  const request = ++workbenchSaveRequest
  try {
    await coreSpatialPersistence?.flush()
    await api.ui.requestStorageFlush()
    if (request === workbenchSaveRequest && useAppStore.getState().workbenchSaveWarning !== null) {
      useAppStore.setState({ workbenchSaveWarning: null })
    }
  } catch (error) {
    if (request === workbenchSaveRequest) useAppStore.getState().reportWorkbenchSaveFailure(error)
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
  await flushMessageWorkbench(true)
}
/** Admit only the chosen recipient's correlation to the existing intent owner before queue input. */
export async function retainRecoveryMessageIntent(binding: SpatialRequestBinding): Promise<AgentMuxSpatialSave | null> {
  if (binding.operation !== 'agent.message' || binding.createAgent || !binding.recoveryRecipient || !binding.recovery) throw new Error('An exact recovery message reference is required.')
  if (useAppStore.getState().spatialRequests[binding.requestId]) return null
  useAppStore.setState(state => ({ spatialRequests: { ...state.spatialRequests, [binding.requestId]: binding } }))
  return await saveWorkbenchSelection(false)
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
function requestWorkbenchStorageCommit(): void {
  void requestWorkbenchStorageFlush().catch(() => {})
}
// Only a captured, already-bound explicit message treats presentation saving as advisory.
// Core admission remains the durable Input owner; automatic/recovery paths retain their fence.
async function flushMessageWorkbench(explicitlyBound: boolean): Promise<void> {
  if (explicitlyBound) {
    try {
      if (!workbenchWriteFence.isOpen()) throw new Error('Current workbench changes cannot be saved yet.')
      persistentWorkbenchStorage.flush()
      // Do not await a host save response before sending to a healthy Run.
      requestWorkbenchStorageCommit()
    } catch (error) { useAppStore.getState().reportWorkbenchSaveFailure(error) }
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



function admitAgentSteer(sessionId: string, text: string, onRejected?: (error: unknown) => void, operationId: string = crypto.randomUUID(), origin?: 'manual', agentMuxNote?: string, options?: AgentSteerOptions): string | false {
  if (!text.trim() && !agentMuxNote?.trim()) return false
  const session = useAppStore.getState().sessions.find((item) => item.id === sessionId)
  if (!session || session.kind !== 'agent') return false
  const existing = useAppStore.getState().agentSteerQueues[sessionId]?.find(entry => entry.operationId === operationId)
  if (existing) {
    if (existing.text === text && existing.agentMuxNote === agentMuxNote && reactionIntentKey(existing.reaction) === reactionIntentKey(options?.reaction) && existing.sourceChannel === options?.sourceChannel && JSON.stringify(existing.goalContinuation) === JSON.stringify(options?.goalContinuation) && JSON.stringify(existing.goalPmo) === JSON.stringify(options?.goalPmo) && JSON.stringify(existing.goalDispatch) === JSON.stringify(options?.goalDispatch) && (options?.execution === undefined || existing.execution === options.execution)) return operationId
    ;(onRejected ?? useAppStore.getState().reportError)(new Error('This message identity already belongs to different content or an earlier execution choice. Your original message and draft are kept.'))
    return false
  }
  if ((useAppStore.getState().agentSteerQueues[sessionId]?.filter(entry => !entry.archived).length ?? 0) >= MAX_AGENT_STEER_QUEUE_ENTRIES) {
    (onRejected ?? useAppStore.getState().reportError)(new Error(`The active message queue is full (${MAX_AGENT_STEER_QUEUE_ENTRIES} messages). Archive queued messages before adding another. Your draft is kept.`))
    return false
  }
  // The shared Core formatter owns byte accounting; transport still keeps body and note separate.
  if (agentPromptExceedsBudget(composeAgentPrompt(text, agentMuxNote).text)) {
    (onRejected ?? useAppStore.getState().reportError)(new Error(
      `This message is too large to send (limit ${Math.floor(MAX_AGENT_PROMPT_BYTES / 1024)}KB). Shorten it, or put the content in a file and reference the path.`
    ))
    return false
  }
  const entry: AgentSteerQueueEntry = {
    operationId,
    promptCondition: options?.goalContinuation ? validateAgentPromptCondition(options.goalContinuation.condition) : null,
    ...(options?.execution === undefined ? {} : { execution: options.execution }),
    ...(options?.goalContinuation ? { goalContinuation: structuredClone(options.goalContinuation) } : {}),
    ...(options?.goalPmo ? { goalPmo: structuredClone(options.goalPmo) } : {}),
    ...(options?.goalDispatch ? { goalDispatch: structuredClone(options.goalDispatch) } : {}),
    enqueuedAt: Date.now(),
    ...(session.processState === 'running' && (session.status.state !== 'disconnected' || options?.reaction !== undefined)
      ? { runId: session.control.run.runId } : {}),
    text,
    ...(agentMuxNote === undefined ? {} : { agentMuxNote }),
    ...(options?.reaction ? { reaction: structuredClone(options.reaction) } : {}),
    ...(options?.sourceChannel ? { sourceChannel: options.sourceChannel } : {}),
    status: 'queued',
    ...(origin === 'manual' ? { origin: 'manual' } : {})
  }
  void api.continuousProgress.pauseForInput(session.control).catch(error => useAppStore.getState().reportError(error))
  useAppStore.setState((state) => ({ agentSteerQueues: { ...state.agentSteerQueues, [sessionId]: [...(state.agentSteerQueues[sessionId] ?? []), entry] } }))
  return entry.operationId
}

// File data requests are shared; display intent belongs to each explicit caller.
let fileOpenIntentVersion = 0
let fileOpenNavigationUnsubscribe: (() => void) | undefined

/** The existing Space and Survey selection facts captured by file display intents. */
function surveyPresentationAfterClose(state: Pick<AppState, 'tabs' | 'surveyZoneSelection' | 'recallZoneSelection' | 'recallNotebookId' | 'recallNoteId'>, tabs: AppState['tabs']) {
  const active = state.recallZoneSelection?.active
  const closedPage = state.recallNotebookId && state.recallNoteId && active && state.tabs[active.tabId]?.regions[active.regionId]?.kind === 'file' && !tabs[active.tabId]?.regions[active.regionId]
  return { recallNoteId: closedPage ? null : state.recallNoteId,
    recallZoneSelection: closedPage ? null : surveySelectionAfterClose(state.tabs, tabs, state.recallZoneSelection),
    surveyZoneSelection: surveySelectionAfterClose(state.tabs, tabs, state.surveyZoneSelection) }
}

export async function registerCreatedNote(receipt: NoteCreationReceipt): Promise<NoteCreationReceipt> {
  if (receipt.status !== 'written' || receipt.notebookRegistered) return receipt
  try {
    await changeNotebook({ kind: 'register', noteId: receipt.noteId, title: receipt.draft.trim().split('\n')[0]?.slice(0, 100) || 'Untitled note',
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
    try { await reobserveNotesStorageResources(next, snapshot.resourceChanges, useAppStore.getState) }
    catch (error) { useAppStore.getState().reportError(new Error('The original Note moved and your draft is kept. File observation is unconfirmed; reopen this same Note to reconnect it. ' + presentError(error))) }
  }
}

export function fileNavigationSelection(state: AppState): string {
  // Survey owns its selection; a split changes the underlying Space layout, not user navigation.
  if (state.mainSurface === 'recall') return JSON.stringify([state.mainSurface, state.recallNotebookId, state.recallNoteId, state.recallZoneSelection])
  if (state.mainSurface === 'survey') return JSON.stringify([state.mainSurface, state.activeWorkspaceId, state.surveyZoneSelection, state.workbenchSpaceSelection])
  const reference = mainRegionReference(state.workbenchSpaceSelection)
  if (reference) return JSON.stringify([state.mainSurface, state.activeWorkspaceId, state.workbenchSpaceSelection,
    state.agentFocus.execution.sessionId, state.agentFocus.execution.reference, state.surveyZoneSelection])
  const layout = state.activeWorkspaceId ? state.layouts[state.activeWorkspaceId] : undefined
  const tabId = layout ? findGroup(layout, layout.activeGroupId)?.activeTabId : undefined
  return JSON.stringify([state.mainSurface, state.activeWorkspaceId, layout?.activeGroupId, tabId,
    tabId ? state.tabs[tabId]?.layout.activeRegionId : undefined,
    state.agentFocus.execution.sessionId, state.agentFocus.execution.reference, state.agentFocus.pmo.sessionId, state.workbenchSpaceSelection, state.surveyZoneSelection])
}

async function openGoalPmo(demandId: string, prompt?: string, userRequest?: string, options?: { creationOperationId?: string | undefined; onReceipt?: ((receipt: GoalPmoReceipt) => void) | undefined }): Promise<string> {
  const get = useAppStore.getState
  const set = useAppStore.setState
  const state = get()
  const demand = state.demands[demandId]
  if (!demand) throw new Error(`Demand ${demandId} is unavailable`)
  const projectContext = goalProjectContextText(goalProjectContext(state.config, demand.projectId, state.activeWorkspaceId), demand.projectId)
  const workspace = state.config?.workspaces.find((item) => item.id === SCRATCH_WORKSPACE_ID)
  if (!workspace) throw new Error('Scratch workspace is unavailable')
  const body = userRequest ?? ''
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
      MOTE_COORDINATION_ROLE,
      prompt?.trim(),
      projectContext,
      executionContext,
      ...(fresh ? [`This is a fresh dedicated PMO context for Demand ${demand.id}.`, `Title: ${demand.title}`, `Description: ${demand.description || '(empty)'}`] : [])
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

  const mappedTabId = state.demandPmoTabIds[demandId]
  const mappedTab = mappedTabId ? state.tabs[mappedTabId] : undefined
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
    mappedTab?.layout.activeRegionId ? mappedTab.regions[mappedTab.layout.activeRegionId] : undefined
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
      const operationId = intent.creationOperationId === undefined ? crypto.randomUUID() : await goalPmoOperation(intent, 'discussion')
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
      }, undefined, { tabName: `PMO · ${demand.title}` }, note, { intent, onCreated: launchedReceipt })
    } else await get().openScratchTopic(PMO_TEAMS_TOPIC_ID, workspace.id, { reveal: false, tabId: mappedTab.id })
    focusPmoTabSession(mappedTab.id)
    return done(mappedTab.id)
  }

  const current = get()
  const currentLayout = current.layouts[workspace.id] ?? createWorkspaceLayout(newTabGroupId())
  const tab = { ...newLauncherTab(workspace.id, PMO_TEAMS_TOPIC_ID), name: `PMO · ${demand.title}` }
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
  await get().launchAgent(executorId, body, currentLayout.activeGroupId, {
    tabId: tab.id,
    regionId: tab.layout.activeRegionId
  }, undefined, { tabName: `PMO · ${demand.title}` }, note, { intent, onCreated: launchedReceipt })
  focusPmoTabSession(tab.id)
  return done(tab.id)
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
  goalAgentCreationDrafts: {},
  retainedSpatialFocus: null,
  config: null,
  providerCatalog: [],
  sessions: [],
  sessionNameMetadata: {},
  sessionNameMetadataWarning: null,
  recoveryCandidates: [],
  warmTerminal: null,
  unclaimedTerminalSessionIds: [],
  timelines: {},
  pendingAgentLaunches: {},
  activeWorkspaceId: null,
  scratchTopicOrder: [],
  documents: {},
  retainedDocumentDrafts: {},
  dirtyDocuments: {},
  documentGenerations: {},
  documentObservationGenerations: {},
  documentIssues: {},
  savingDocuments: {},
  documentRevealTargets: {},
  noteBlockSelections: {},
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
  agentNames: {},
  nameLabels: {},
  nameAuthorityRevision: 0,
  nameAcknowledgementRevision: 0,
  mainSurface: 'workbench',
  notebookRecoveries: [],
  recallNotebookId: null, recallNoteId: null,
  recallZoneSelection: null,
  setRecallZoneSelection(recallZoneSelection) { set({ recallZoneSelection }) },
  recallSidebarCollapsed: false, recallSidebarWidth: SURVEY_SIDEBAR_DEFAULT_WIDTH,
  setRecallSidebarCollapsed(recallSidebarCollapsed) { set({ recallSidebarCollapsed }) },
  setRecallSidebarWidth(width) { set({ recallSidebarWidth: clampSurveySidebarWidth(width) }); void saveWorkbenchSelection(false) },
  setRecallNotebook(notebookId, noteId = null) { set({ recallNotebookId: notebookId, recallNoteId: noteId }) },
  async refreshNotesStorage() { await applyNotesStorageSnapshot(await api.notesStorage.inspect()) },
  surveyZoneSelection: null,
  surveyCollectedZones: {},
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
    if (collected) {
      const scratch = state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
      const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scratch) ?? []
      const zone = spatialCatalog(state, topics).zones.find(zone => zone.zoneId === zoneId)
      if (!zone || zone.kind === 'unknown') return false
      set({ surveyCollectedZones: { ...state.surveyCollectedZones, [zoneId]: true } })
    } else {
      const { [zoneId]: _removed, ...surveyCollectedZones } = state.surveyCollectedZones
      set({ surveyCollectedZones })
    }
    // Membership is a discrete user action, not a drag that can wait for a trailing write.
    void saveWorkbenchSelection(false)
    return true
  },
  setSurveyToolsOpen(surveyToolsOpen) { set({ surveyToolsOpen, workbenchNavigationInputPolicy: null, regionCaretFocus: null }) },
  createSurveyBrowser(input) { return createSurveyBrowser(get, input) },
  demands: {},
  demandPmoTabIds: {},
  agentFocus: EMPTY_AGENT_FOCUS,
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
  toolsOpen: true,
  nativeSurfaceOverlayCount: 0,
  portalOverlayCount: 0,
  workspaceTool: 'files-branches',
  projectRailWidth: PROJECT_RAIL_DEFAULT_WIDTH,
  toolDockWidth: TOOL_DOCK_DEFAULT_WIDTH,
  loading: true,
  startupProgress: { step: 'saved-workspace' },
  runtimeOwnershipWarnings: undefined,
  runtimeEndpointWarnings: undefined,
  environmentWarning: undefined,
  localHome: '',
  displacedAgentSessionIds: [],
  error: null,
  lastError: null,
  errorNoticeContext: null,
  errorDismissed: false,
  workbenchSaveWarning: null,
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
  reportWorkbenchSaveFailure(error) {
    // A timed-out quit request must not later clear its warning without a new retry result.
    ++workbenchSaveRequest
    const warning = presentError(error)
    if (get().workbenchSaveWarning !== warning) set({ workbenchSaveWarning: warning })
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
    const pendingSessionEvents = sessionMembershipEventBuffer()
    const pendingBrowserEvents: BrowserEvent[] = []
    let booting = true
    let pendingNotesStorage: NotesStorageSnapshot | null = null
    const disposeNotesStorage = api.notesStorage.onChange(snapshot => {
      if (booting) pendingNotesStorage = snapshot
      else void applyNotesStorageSnapshot(snapshot).catch(error => get().reportError(new Error('Notes directory view could not reconnect. Your original workface and drafts are kept; refresh the Notes directory in Settings. ' + presentError(error))))
    })
    const disposeSessions = api.sessions.onEvent((event) => {
      if (booting) {
        enqueueSessionMembershipEvent(pendingSessionEvents, event)
        return
      }
      get().applyEvent(event)
    })
    const disposeBrowsers = api.browser.onEvent((event) => {
      if (booting) {
        pendingBrowserEvents.push(event)
        if (pendingBrowserEvents.length > 256) pendingBrowserEvents.shift()
      }
      else get().applyBrowserEvent(event)
    })
    const disposeControl = api.control.onRequest((request, signal) => request.operation === 'continuous-progress.observeInput'
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
      disposeCoreSpatial?.();disposeCoreSpatial=null
      if (runtimeSubscriptionCount === 0) return
      runtimeSubscriptionCount -= 4
      cancelSessionMembershipResync()
      disposeMoteStartupRecovery()
      disposeSessions()
      disposeBrowsers()
      disposeControl()
      disposeSpatialLinkIssues()
      disposeFileInvalidations()
      disposeNotesStorage()
      const warm = get().warmTerminal
      // Observation cleanup may release unused prewarming, never an explicit opening.
      if (!warm?.explicitOpening) {
        void stopWarmTerminal(warm).then((sessionId) => {
          if (!sessionId) return
          set((state) => ({
            unclaimedTerminalSessionIds: forgetUnclaimedTerminalSession(
              state.unclaimedTerminalSessionIds,
              sessionId
            )
          }))
        })
        set({ warmTerminal: null })
      }
    }
    try {
      // Do not let the runtime snapshot race the Renderer persistence layer. The persisted Workbench
      // is the index that selects recovery candidates; observing it before hydration would turn a
      // restart into an empty first Workspace and make a healthy Agent appear unrecoverable. The
      // subscriptions above intentionally start first so events arriving during this storage read
      // stay in the existing boot buffer instead of being missed.
      const persistWarning = await ensurePersistHydrated()
      disposeCoreSpatial?.();disposeCoreSpatial=null
      if(api.spatial) {
        coreSpatialPersistence=new DesktopSpatialPersistence(api.spatial,error=>get().reportWorkbenchSaveFailure(error))
        try {
          const spatial=await coreSpatialPersistence.read()
          if(spatial) set({topicCategories:categoriesFromSpatial(spatial.graph),projectGroups:spatial.graph.projectGroups ?? [],restoredWorkbench:desktopWorkbenchFromSpatial(spatial.graph,id=>get().reportWorkbenchSaveFailure(new Error('Host resources are unavailable for saved Tab '+id+'. Its Core identity is retained. Restore the original Host connection.'))),spaceZoneBindings:desktopBindingsFromSpatial(spatial.graph)})
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
      const [configResult, initialSnapshotResult, providerCatalogResult, demandResult] = await Promise.allSettled([
        api.config.get(),
        api.sessions.snapshot(),
        api.providers.list({ observation: true }),
        api.demands.list()
      ])
      if (configResult.status === 'rejected') throw configResult.reason
      const avatarHandoff = await handoffSpaceIcons(get().config !== configBeforeRead && get().config !== null ? get().config! : configResult.value)
      configResult.value = avatarHandoff.config
      if (initialSnapshotResult.status === 'fulfilled') set({
        environmentWarning: initialSnapshotResult.value.environmentWarning ?? null,
        runtimeOwnershipWarnings: initialSnapshotResult.value.runtimeOwnershipWarnings ?? [],
        runtimeEndpointWarnings: initialSnapshotResult.value.runtimeEndpointWarnings ?? []
      })
      if (providerCatalogResult.status === 'fulfilled') set(state => ({ runtimeEndpointWarnings: runtimeEndpointWarningsAfterMetadataRead(
        state.runtimeEndpointWarnings, 'Reading Provider catalog', providerCatalogResult.value.warnings) }))
      // 本机 home 从快照里学（渲染层没有 process/os）。拿不到就保留旧值——不缩写好过按空串猜边界。
      if (initialSnapshotResult.status === 'fulfilled' && initialSnapshotResult.value.localHome !== undefined) {
        set({ localHome: initialSnapshotResult.value.localHome })
      }
      const startupWarnings: string[] = avatarHandoff.warning ? [avatarHandoff.warning] : []
      let emptySessionSnapshotWarning: string | null = null
      let missingRuntimeReferenceIds: string[] | null = null
      let snapshotFailureMessage: string | undefined
      let providerCatalogWarning: string | undefined
      let snapshot = initialSnapshotResult.status === 'fulfilled'
        ? startupSnapshotForSavedReferences(initialSnapshotResult.value, get().restoredWorkbench?.tabs ?? {}, configResult.value).snapshot
        : emptyRuntimeSnapshot()
      if (providerCatalogResult.status === 'fulfilled') snapshot = { ...snapshot, runtimeEndpointWarnings: runtimeEndpointWarningsAfterMetadataRead(
        snapshot.runtimeEndpointWarnings, 'Reading Provider catalog', providerCatalogResult.value.warnings) }
      let snapshotVerified = initialSnapshotResult.status === 'fulfilled'
      if (initialSnapshotResult.status === 'rejected') {
        snapshotFailureMessage = startupWorkflowWarning(
          'Runtime Session snapshot',
          initialSnapshotResult.reason,
          'The saved Workbench remains visible; Session status will reconcile when the Runtime is available.'
        )
        emptySessionSnapshotWarning = snapshotFailureMessage
      }
      const providerCatalog = providerCatalogResult.status === 'fulfilled'
        ? providerCatalogResult.value.catalog
        : []
      if (providerCatalogResult.status === 'rejected') {
        providerCatalogWarning = startupWorkflowWarning(
          'Provider catalog lookup',
          providerCatalogResult.reason,
          'Existing Sessions remain usable; the original Provider directory will be checked automatically when its owner is available.'
        )
        startupWarnings.push(providerCatalogWarning)
      }
      if (demandResult.status === 'rejected') {
        startupWarnings.push(startupWorkflowWarning(
          'Demand filesystem snapshot',
          demandResult.reason,
          'The saved Board Demand projection remains visible; retry the Demand store when the filesystem is available.'
        ))
      } else if (demandResult.value.length > 0) {
        set({ demands: Object.fromEntries(demandResult.value.map((demand) => [demand.id, demandRecordFromFilesystem(demand)])) })
      }
      const readCanonicalSnapshot = async (step: string): Promise<RuntimeSnapshot | null> => {
        try {
          const next = await api.sessions.snapshot()
          snapshotVerified = true
          return startupSnapshotForSavedReferences(next, get().restoredWorkbench?.tabs ?? {}, get().config ?? configResult.value).snapshot
        } catch (error) {
          snapshotVerified = false
          startupWarnings.push(startupWorkflowWarning(
            step,
            error,
            'The saved Workbench remains visible; the Runtime will reconcile it on a later canonical snapshot.'
          ))
          return null
        }
      }
      const persistedSessionIds = persistedSessionSurfaceIds(get().restoredWorkbench)
      // An empty Runtime snapshot cannot distinguish "there are no Sessions" from a freshly
      // connected/incorrectly rooted store. If the persisted Workbench still names Session Regions
      // (Agent OR Terminal), keep those Regions as pending projections until Core returns a candidate
      // or an explicit retirement. Treating this one response as authoritative is what made a restart
      // erase the user's layout when the GUI and Runtime addressed different userData roots — and a
      // pure-Terminal View was hit worst, because the ctxmux daemon outlives the app, so its runs
      // reappear a beat later, but this guard would already have judged the empty snapshot final.
      if (
        snapshotVerified &&
        persistedSessionIds.size > 0 &&
        snapshot.sessions.length === 0 &&
        snapshot.recoveryCandidates.length === 0
      ) {
        snapshotVerified = false
        emptySessionSnapshotWarning = 'Runtime Session snapshot returned no Session facts. The saved Session Regions remain visible until a canonical snapshot confirms their identity.'
      }
      const recoveryFailures: SessionSnapshot[] = []
      const retiredAgentIds = new Set<string>()
      let recovered = false
      // Both retained ended Runs and absent Runs keep durable Session identity. Only fresh native
      // idle evidence authorizes cold-start resume; healthy Runs are left to ordinary attachment.
      const projectedAgents = snapshot.sessions.filter((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => session.kind === 'agent')
      const startupSessionsById = new Map(snapshot.sessions.map((session) => [session.id, session]))
      const recoveryCandidates: AgentSessionRecoveryCandidate[] = (snapshotVerified ? [
        ...snapshot.recoveryCandidates,
        ...projectedAgents.map((session) => ({ ...session, agentSessionId: session.id, run: session.control.run }))
      ] : []).filter((candidate) => persistedSessionIds.has(candidate.agentSessionId))
      for (const [index, candidate] of recoveryCandidates.entries()) {
        set({ startupProgress: { step: 'sessions', current: index + 1, total: recoveryCandidates.length } })
        const projected = startupSessionsById.get(candidate.agentSessionId)
        const decision = agentStartupRecoveryDecision({
          runState: projected?.processState ?? 'missing',
          ...(candidate.semanticStatus ? { semanticStatus: candidate.semanticStatus } : {}),
          canonical: snapshotVerified && !runtimeSnapshotHostUnavailable(snapshot, candidate.hostId),
          now: Date.now()
        })
        if (deferScratchConversationRecovery(get().restoredWorkbench?.tabs ?? {},
          get().config !== configBeforeRead && get().config !== null ? get().config : configResult.value, candidate.agentSessionId, [...get().sessions, ...snapshot.sessions])) {
          if (!projected) recoveryFailures.push(recoveryCandidateSession(candidate, { kind: 'pending', detail: 'Original Mote settings are being confirmed after its workface restores.' }))
          continue
        }
        if (decision.kind !== 'resume') {
          if (!projected) recoveryFailures.push(recoveryCandidateSession(candidate, { kind: 'pending', detail: agentStartupRecoveryDetail(decision) }))
          continue
        }
        try {
          const recovery = await api.sessions.recover({
            kind: 'agent',
            hostId: candidate.hostId,
            agentSessionId: candidate.agentSessionId,
            run: { ...candidate.run }
          }, candidate.workspacePath)
          if (recovery.kind === 'reattachable' || recovery.kind === 'resumed') {
            recovered = true
            if (recovery.advisory && recovery.session.id === candidate.agentSessionId && recovery.session.control.hostId === candidate.hostId)
              startupWarnings.push(recovery.advisory)
          } else if (recovery.kind === 'unavailable' || recovery.kind === 'conflict') {
            recoveryFailures.push(projected ? {
              ...projected,
              status: { ...projected.status, state: 'error', ...continuityStatusFields(recovery) }
            } : recoveryCandidateSession(candidate, recovery))
          } else if (recovery.kind === 'retired') {
            retiredAgentIds.add(candidate.agentSessionId)
            // Retired means an actor deliberately ended this Agent, so the Region must NOT be retained
            // — the same judgement the manual path makes (`recoverSession` removes the projection on
            // `retired`), and the reason the empty-snapshot guard above names "an explicit retirement"
            // as legitimate grounds to stop retaining. What was missing is the *telling*: unavailable
            // and conflict both leave a visible error skeleton, while a retirement removed the Region
            // in total silence, so a Region the user left behind was simply gone with `error` null.
            // Say it instead. Deleting this arm turns the startup notice assertion red, not a tab
            // count — the tab is correctly absent either way.
            startupWarnings.push(
              `The Agent in a saved Region was retired and could not be restored (${candidate.label}). Its Region was closed; start a new Agent to continue there.`
            )
          }
        } catch (error) {
          // A rejected recovery call is a failed workflow step, not proof that the Agent is dead. Do
          // not invent a continuity reason; retain its persisted Region through the unverified
          // projection path and leave the exact cause in the service-window notice.
          snapshotVerified = false
          if (!projected) recoveryFailures.push(recoveryCandidateSession(candidate, {
            kind: 'pending', detail: 'Automatic recovery did not complete. Existing history and your draft are kept; retry Resume.'
          }))
          startupWarnings.push(startupWorkflowWarning(
            'Automatic Agent recovery',
            error,
            'The original Region remains visible; retry recovery after the Runtime is reachable.'
          ))
        }
      }
      if (recovered) {
        const refreshedSnapshot = await readCanonicalSnapshot('Runtime Session snapshot after recovery')
        if (refreshedSnapshot) snapshot = refreshedSnapshot
      }
      // A previous process's unclaimed View marker is not a current Stop intent.
      // Keep observed Runs discoverable; only an exact, current cancellation owns cleanup.
      // One compensating read keeps the existing quiet-overflow behavior. Sustained
      // Runtime traffic cannot hold the original durable workface behind another read.
      if (pendingSessionEvents.overflowed) {
        resetSessionMembershipRead(pendingSessionEvents)
        const refreshedSnapshot = await readCanonicalSnapshot('Runtime Session snapshot during startup reconciliation')
        if (refreshedSnapshot) snapshot = refreshedSnapshot
      }
      // A canonical read already adopted during startup can finish this producer before publication.
      // An incomplete read keeps the original scope for the existing membership resync below.
      const persistedState = get()
      // Main may publish while get or Session recovery is awaiting. An older read must not roll back
      // that committed fact; use the existing Store identity, with no second configuration cache.
      const config = persistedState.config !== configBeforeRead && persistedState.config !== null
        ? persistedState.config : configResult.value
      if (emptySessionSnapshotWarning && snapshotVerified && !pendingSessionEvents.overflowed && startupSnapshotConfirmsSessions(
        snapshot, [...persistedSessionIds], persistedState.restoredWorkbench?.tabs ?? {}, config
      )) {
        emptySessionSnapshotWarning = null
      }
      set({ startupProgress: { step: 'layout' } })
      const visibleSessions = [...new Map([
        ...snapshot.sessions,
        ...recoveryFailures.filter((pending) => !snapshot.sessions.some((current) => (
          current.id === pending.id && (current.processState === 'running' || !sessionOwnsControl(current, pending.control))
        )))
      ].filter((session) => !retiredAgentIds.has(session.id)).map((session) => [session.id, session])).values()]
      const restoredUi = restorePersistedUiState(config, persistedState)
      const workbench = restorePersistedWorkbench({
        config,
        sessions: visibleSessions,
        persisted: persistedState.restoredWorkbench,
        preserveEntityIds:coreSpatialPersistence?.current ? new Set(coreSpatialPersistence.current.graph.tabs.map(tab=>tab.tabId)) : undefined,
        createTabGroupId: newTabGroupId,
        retiredSessionIds: retiredAgentIds
      })
      const observedSessionIds = new Set(visibleSessions.map(session => session.id))
      let unobservedSavedSessions = [...persistedSessionIds].filter(id => !retiredAgentIds.has(id) && !observedSessionIds.has(id)
        && hasAttachedSessionView(workbench.tabs, id))
      if (snapshotVerified && !emptySessionSnapshotWarning && unobservedSavedSessions.length > 0) {
        try {
          const observed = await api.sessions.historySources({ observation: true })
          snapshot = { ...snapshot, runtimeEndpointWarnings: runtimeEndpointWarningsAfterMetadataRead(
            snapshot.runtimeEndpointWarnings, 'Reading retained History sources', observed.warnings) }
          const retiredReferences = retiredHistoryReferenceIds(observed.sources, workbench.tabs, config)
          unobservedSavedSessions = unobservedSavedSessions.filter(id => !retiredReferences.has(id))
        } catch (error) {
          startupWarnings.push(startupWorkflowWarning('Saved conversation metadata', error,
            'The original Regions remain visible. Their current Session state is unconfirmed; retry the metadata read.'))
        }
        if (unobservedSavedSessions.length > 0) {
          missingRuntimeReferenceIds = unobservedSavedSessions
          emptySessionSnapshotWarning = missingSavedRuntimeFactsNotice(unobservedSavedSessions.length)
        }
      }
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
          !retiredAgentIds.has(id) && hasAttachedSessionView(workbench.tabs, id)
        )))
      )
      // 抢救过的持久化 Tab 必须响亮：静默修好等于用户下次发现某一格不见了却无从查证。
      const repairNotice = describePersistedTabRepairs(workbench.repairs)
      const otherStartupError = [
        ...(persistWarning
          ? [`Saved workspace state could not be restored: ${presentError(persistWarning)}`]
          : []),
        ...(repairNotice ? [repairNotice] : []),
        ...startupWarnings
      ].join(' ')
      const startupError = [otherStartupError, emptySessionSnapshotWarning].filter(Boolean).join(' ')
      set({
        restoredWorkbench: null,
        config,
        providerCatalog,
        sessions: projectRuntimeEndpointSessions(visibleSessions, snapshot.runtimeEndpointWarnings),
        sessionNameMetadata: snapshot.sessionNameMetadataWarning ? get().sessionNameMetadata : sessionNameMetadataRecord(snapshot.sessionNameMetadata ?? [], get().sessionNameMetadata),
        sessionNameMetadataWarning: snapshot.sessionNameMetadataWarning ?? null,
        recoveryCandidates: snapshot.recoveryCandidates,
        timelines: snapshot.timelines,
        runtimeOwnershipWarnings: snapshotVerified ? snapshot.runtimeOwnershipWarnings ?? [] : get().runtimeOwnershipWarnings,
        runtimeEndpointWarnings: snapshotVerified ? snapshot.runtimeEndpointWarnings ?? [] : get().runtimeEndpointWarnings,
        environmentWarning: snapshotVerified ? snapshot.environmentWarning ?? null : get().environmentWarning,
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
          summary: startupNoticeSummary(otherStartupError || null, emptySessionSnapshotWarning ? (missingRuntimeReferenceIds ?? [...persistedSessionIds]).length : 0),
          ...(providerCatalogWarning ? { startupProviderCatalog: { warningMessage: providerCatalogWarning } } : {}),
          ...(emptySessionSnapshotWarning ? { startupSessionSnapshot: {
            sessionIds: missingRuntimeReferenceIds ?? [...persistedSessionIds],
            remainingMessage: otherStartupError || null,
            ...(snapshotFailureMessage ? { failureMessage: snapshotFailureMessage } : {})
          } } : {})
        } : null,
        errorDismissed: false
      })
      // Resource/draft rebinding publishes synchronously; reconnecting a file watch must
      // neither hold healthy Session publication nor trap a later directory receipt in boot.
      try {
        const observed = pendingNotesStorage ?? await api.notesStorage.inspect()
        const latest = pendingNotesStorage ?? observed
        pendingNotesStorage = null
        void applyNotesStorageSnapshot(latest).catch(error => get().reportError(new Error('Notes directory view could not reconnect. Your original workface and drafts are kept; refresh the Notes directory in Settings. ' + presentError(error))))
      }
      catch (error) { get().reportError(new Error('Notes directory view could not reconnect. Your original workface and drafts are kept; refresh the Notes directory in Settings. ' + presentError(error))) }
      // Publication releases the boot buffer before optional spatial/browser work awaits.
      // Latest replacement facts survive a noisy neighbor; truncated timelines use Core.
      booting = false
      if (pendingNotesStorage) {
        const latest = pendingNotesStorage; pendingNotesStorage = null
        void applyNotesStorageSnapshot(latest).catch(error => get().reportError(new Error('Notes directory view could not reconnect. Your original workface and drafts are kept; refresh the Notes directory in Settings. ' + presentError(error))))
      }
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
      startSessionMembershipResync(undefined, { reportFailure: false, recoverSavedAgents: !snapshotVerified || Boolean(emptySessionSnapshotWarning) })
      // The Runtime and its Agents remain usable; only the optional persisted presentation projection
      // was unavailable. Open the fence after the fallback state is installed so that this warning
      // itself cannot serialize the empty fallback over the user's last good record.
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
          set({tabs,layouts:saved.graph.layouts,topicCategories:categoriesFromSpatial(saved.graph),projectGroups:saved.graph.projectGroups ?? [],spaceZoneBindings:desktopBindingsFromSpatial(saved.graph)})
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
          const legacy = get()
          const retained = [
            ...Object.entries(legacy.agentNames).map(([id,value]) => ({ target: { kind: 'agent-session', id }, value })),
            ...Object.entries(legacy.surveyExplorationNames).map(([id,value]) => ({ target: { kind: 'zone', id }, value })),
            ...Object.values(legacy.tabs).flatMap(tab => tab.name ? [{ target: { kind: 'tab', id: tab.id }, value: tab.name }] : [])
          ]
          const acknowledged = await api.spatial.retainLabels(retained)
          spatial.acceptNames(acknowledged)
          applyNameAcknowledgement(acknowledged)
          set({}) // Rewrite UI preferences after the Core ACK, removing the old entity snapshot.
        } catch(error) {get().reportWorkbenchSaveFailure(error)}
      }
      if (!persistWarning) openPersistWrites()
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
      for (const event of pendingBrowserEvents) get().applyBrowserEvent(event)
      // Cold-start browser rehydration. `restoreTab` is a pure presentation projection that emits a
      // neutral browser shell (url/title from disk, transient fields defaulted); the WebContentsView
      // that makes it live must be created here, where side effects legitimately live — the same seam
      // the Agent recovery loop above uses. `api.browser.restore` cannot help on a cold start (it
      // throws "Unknown released browser" — Main has no released entry after a process exit), so this
      // goes through `create`, then `applyBrowserEvent` overwrites the defaulted transient fields with
      // the real snapshot (navigationId etc.). This reverses the old "browser 面整面剥离" decision: the
      // old comment's worry — that persisting a browser structure without a rebuild lifecycle ships a
      // dead panel — was correct; what changed is that the lifecycle now exists (this loop).
      //
      // ponytail: serial `for...of` + `await`, one create at a time. Ceiling: N saved browsers ⇒ N
      // sequential loadURLs, not N concurrent. Upgrade path if a user routinely keeps 10+ browser tabs
      // and startup visibly drags: give BrowserPane a "create on first became-visible" seam so hidden
      // tabs defer their create. Not built now — no measured need (YAGNI).
      const browserRebuildFailures: string[] = []
      const browserSurfaces = Object.values(get().tabs).flatMap(workbenchSurfaces)
        .filter((surface) => surface.kind === 'browser')
      let browserIndex = 0
      for (const tab of Object.values(get().tabs)) {
        for (const surface of workbenchSurfaces(tab)) {
          if (surface.kind !== 'browser') continue
          browserIndex += 1
          set({ startupProgress: { step: 'browsers', current: browserIndex, total: browserSurfaces.length } })
          try {
            const browser = await api.browser.create(surface.browserId, surface.url, surface.workspaceId, surface.profileId || undefined)
            get().applyBrowserEvent({ type: 'updated', browser })
          } catch (error) {
            // Failure to acquire a native owner is not a user close. Keep the current durable Region
            // and give its existing Retry a visible failure; never resurrect one closed while awaiting.
            set((state) => {
              const currentTab = state.tabs[tab.id]
              if (!currentTab) return state
              const currentSurface = currentTab.regions[surface.regionId]
              if (currentSurface?.kind !== 'browser' || currentSurface.browserId !== surface.browserId) return state
              return { tabs: { ...state.tabs, [tab.id]: { ...currentTab, regions: {
                ...currentTab.regions,
                [surface.regionId]: {
                  ...currentSurface,
                  loading: false,
                  error: `Browser recovery failed: ${presentError(error)}. Retry to reopen this page.`
                }
              } } } }
            })
            browserRebuildFailures.push(`${surface.title || surface.url} (${presentError(error)})`)
          }
        }
      }
      if (browserRebuildFailures.length > 0) {
        get().reportError(new Error(
          `Some saved browser panes could not be reopened. Their Regions were retained; use Retry on the page: ${browserRebuildFailures.join('; ')}.`
        ))
      }
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
  activateWorkspaceSelection(result) {
    if (get().retainedSpatialFocus !== null) set({ retainedSpatialFocus: null })
    const workspace = result.workspace
    set((state) => {
      const existingLayout = state.layouts[workspace.id]
      return {
        config: result.config,
        activeWorkspaceId: workspace.id,
        mainSurface: 'workbench',
        regionCaretFocus: null,
        error: null,
        errorDismissed: true,
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
      const result = await api.workspaces.keepOneOfFanOut(input)
      // 输家的记录刚被撤掉，而活动位很可能正指着其中一个——用户就是在看那几条 lane 才按下 Keep 的。
      const next = await api.config.get()
      // 胜者写在候选第二位：活动位指着的还在（比如某条 lane 因为脏树被留下）就不动它，被删掉了才
      // 落到胜者身上。落到胜者而不是通用兜底，是因为「留下这一个」这句话本身就说明了该看哪儿。
      // 输家的记录连同它们的文件 Tab 一起被撤，那些 Tab 攥着的 Main 侧观察者也要在这里释放（#559）。
      disposeObserversForRemovedWorkspaces(get().tabs, next)
      set((state) => adoptedConfig(state.activeWorkspaceId, next, input.keepWorkspaceId))
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
    const outcome = await api.workspaces.removeWorktree(input)
    // `removed` 带回来的 config 就是权威的那一份，不再另外 get() 一次：多一次往返就多一个能与这次
    // 移除结果不一致的窗口。`retained` 什么都没删，所以什么都不写——它是保护生效了，不是一次变更。
    if (outcome.status === 'removed') {
      // The removed worktree's file Tabs still hold Main-side observers; drop them at the same seam
      // that reseats the active Workspace (see disposeObserversForRemovedWorkspaces / #559).
      disposeObserversForRemovedWorkspaces(get().tabs, outcome.config)
      set((state) => adoptedConfig(state.activeWorkspaceId, outcome.config))
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
    set((state) => ({
      regionCaretFocus: null, workbenchSpaceSelection: choice, workbenchNavigationInputPolicy: null,
      retainedSpatialFocus: null, activeWorkspaceId: workspaceId, mainSurface: 'workbench',
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
  async executeControl(request, signal, options) {
    if (isToolkitRequest(request)) {
      throw Object.assign(new Error('Toolkit requests belong to the Main execution owner.'), { code: 'CONTROL_FAILED' })
    }
    if (request.operation === 'metrics.get' || request.operation === 'metrics.watch') {
      throw Object.assign(new Error('Metrics queries belong to the Main observation owner.'), { code: 'CONTROL_FAILED' })
    }
    if (request.operation === 'diagnostics.crash-log.get' || request.operation === 'diagnostics.crash-log.reveal') {
      throw Object.assign(new Error('Crash log diagnostics belong to the Main owner.'), { code: 'CONTROL_FAILED' })
    }
    if (request.operation === 'settings.get' || request.operation === 'settings.set' ||
        request.operation === 'settings.workspaces.add' ||
        request.operation === 'settings.executors.refresh' ||
        request.operation === 'settings.hosts.list' || request.operation === 'settings.hosts.test' ||
        request.operation === 'settings.hosts.upgrade-check' || request.operation === 'settings.hosts.upgrade' || request.operation === 'settings.hosts.upgrade-inspect' ||
        request.operation === 'settings.browser.links.list' || request.operation === 'settings.browser.links.forget' ||
        request.operation === 'settings.resource.list' || request.operation === 'settings.resource.get' ||
        request.operation === 'settings.resource.add' || request.operation === 'settings.resource.update' ||
        request.operation === 'settings.resource.remove') {
      throw Object.assign(new Error('Settings requests belong to the Main configuration owner.'), { code: 'CONTROL_FAILED' })
    }
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
      const details = request.oid === undefined
        ? await lookup.bridge.history(request.workspaceId, { limit: 1 })
        : await lookup.bridge.commitDetails(request.workspaceId, { oid: request.oid,
            ...(request.parentOid ? { parentOid: request.parentOid } : {}) })
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
      const presentation = request.oid === undefined ? get().openGitHistory(request.workspaceId, snapshot)
        : get().openGitWorkbench(request.workspaceId, snapshot as GitCommitSnapshot)
      await saveWorkbenchSelection(true)
      return { operation: 'open.git', workspaceId: request.workspaceId, read: { kind: 'ready', snapshot }, presentation }
    }
    if (request.operation === 'open.file') return await executeWorkfaceFileOpen({
      get,
      topics: async () => get().config?.workspaces.some(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
        ? await api.scratch.listTopics(SCRATCH_WORKSPACE_ID) : [],
      openFile: (...args) => get().openFile(...args),
      closing: tabId => !workbenchViewCloseAllowsView(get().closingWorkbenchViews, tabId), save: saveWorkbenchSelection
    }, request)
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
          (target, choice) => api.scratch.readMoteAvatar(target.workspaceId, target.topicId, choice, target.objectKey)),
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
            Boolean(confirmedSteerDelivery(state.timelines[session.id], session.control, entry.operationId))))
      }
      if (request.operation === 'message.pending.ls') return { operation: request.operation, agentSessionId: session.id, messages: records() }
      const before = records().find(item => item.pendingId === request.pendingId)
      if (!before) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'This original pending message is no longer available. No new message was created.')
      if (request.operation === 'message.pending.stop') {
        const changed = get().cancelAgentSteerPreparation(session.id, request.pendingId)
        const message = records().find(item => item.pendingId === request.pendingId)
        if (!message || message.preparationWait?.state !== 'stopped') {
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
          Boolean(confirmedSteerDelivery(get().timelines[session.id], session.control, result.entry.operationId))), changed: result.changed }
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
    if (request.operation === 'inspect.client') {
      const discoveryWorkspace = get().config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
      let topics: ScratchTopicSnapshot[] = []
      try { if (discoveryWorkspace) topics = await api.scratch.listTopics(SCRATCH_WORKSPACE_ID) } catch { /* Missing discovery stays unknown; durable placement is retained. */ }
      // Directory I/O can outlive a user's navigation. Observe one current Store snapshot
      // together with the actual DOM; never mix pre-await selection with a new caret.
      const state = get()
      const currentWorkspace = state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
      if (discoveryWorkspace && (currentWorkspace?.hostId !== discoveryWorkspace.hostId || currentWorkspace?.path !== discoveryWorkspace.path)) topics = []
      const selection = desktopSelection(state, spatialCatalog(state, topics))
      const presentation = readDesktopPresentation(selection, state.tabs)
      const sessions = sessionPresentationById(state.sessions)
      const observation: DesktopWorkbenchObservation = {
        loading: state.loading, startupProgress: state.startupProgress,
        activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface,
        focus: { executionSessionId: state.agentFocus.execution.sessionId, pmoSessionId: state.agentFocus.pmo.sessionId },
        desktop: { selection, ...presentation,
          focus: { executionSessionId: state.agentFocus.execution.sessionId, pmoSessionId: state.agentFocus.pmo.sessionId } },
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
                url: surface.url, title: surface.title, profileId: surface.profileId, navigationId: surface.navigationId,
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
      await get().acceptDemandResult(request.demandId, request.expectedAlignmentRevision, request.expectedSubmissionId, request.acceptGaps)
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
    const startDemand = async (demandId: string, sessionId?: string, continuation?: { intervalMs: number; alignmentRevision: number }, businessOperationId?: string, caller?: import('@agentmux/core').AgentMuxControlCaller) => {
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
              const dispatch = await api.demands.inspectDispatch(reference)
              if (dispatch && dispatch.stage !== 'confirmed') await api.demands.reconcileDispatch(reference)
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
      if (!attachedSessionId || !originalDispatch && !savedContinuation && !assigneeSessionIds.includes(attachedSessionId)) throw controlFailure('INVALID_CONTROL_REQUEST', 'Choose an exact responsible Session before starting. With multiple assignees, select this start’s Agent explicitly; creating or saving an Agent does not start work.')
      const session = sourceForStart(attachedSessionId, originalDispatch?.hostId ?? savedContinuation?.hostId)
      const original = savedContinuation?.initialDelivery
      const prompt = originalDispatch?.prompt ?? original?.prompt ?? (current.description.trim() || current.title)
      const prepared = await api.demands.prepareGoalStart(demandId, originalDispatch ? { operationId: originalDispatch.operationId, agentSessionId: originalDispatch.agentSessionId, hostId: originalDispatch.hostId, runId: originalDispatch.runId, execution: originalDispatch.execution, prompt: originalDispatch.prompt, ...(originalDispatch.loopId ? { loopId: originalDispatch.loopId, alignmentRevision: originalDispatch.alignmentRevision } : {}) } : {
        operationId: businessOperationId, agentSessionId: session.control.agentSessionId, hostId: session.control.hostId,
        runId: session.control.run.runId, execution: savedContinuation ? 'continue' : 'finite', prompt,
        ...(savedContinuation ? { loopId: savedContinuation.loopId, alignmentRevision: continuation!.alignmentRevision } : {})
      }, options?.admittedControlRequestId)
      set(state => ({ demands: { ...state.demands, [demandId]: demandRecordFromFilesystem(prepared.demand, state.demands[demandId]) } }))
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
      const started = await startDemand(request.demandId, request.sessionId, request.continuation, request.requestId, request.caller)
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
      try { if (get().config?.workspaces.some(workspace => workspace.id === SCRATCH_WORKSPACE_ID)) topics = await api.scratch.listTopics(SCRATCH_WORKSPACE_ID) }
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
          // Explicit Goal selection keeps its identity; only a unique confirmed association navigates Work.
          get().setSelectedDemand(request.target.goalId)
          set({ mainSurface: 'board', regionCaretFocus: null, workbenchNavigationInputPolicy: request.inputPolicy })
        } else if (request.target.kind === 'surface') {
          get().setMainSurface(desktopMainSurface[request.target.surface])
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
      if (navigationState !== 'rejected' && JSON.stringify(expected) === JSON.stringify(beforeSelection)) navigationState = 'unchanged'
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
        return observed.presentation.state === 'covered' ||
          ((observed.presentation.state === 'main-visible' || observed.presentation.state === 'floating') &&
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
      const after = captureDesktopInput(get().tabs)
      const inputOutcome = request.inputPolicy === 'preserve' ? desktopInputPreserved(before, after) ? 'preserved'
        : after.fact.provenance === 'observed' ? 'unavailable' : 'unconfirmed'
        : navigationState !== 'rejected' && navigationState !== 'unconfirmed' && after.fact.regionId === expected.space?.regionId &&
          after.fact.connected === true && after.fact.visible === true && after.fact.inert === false ? 'transferred'
          : after.fact.provenance === 'observed' ? 'unavailable' : 'unconfirmed'
      if (request.inputPolicy === 'target' && inputOutcome !== 'transferred' && caretIntentNonce !== undefined) {
        get().clearRegionCaretFocus(caretIntentNonce)
      }
      const partial = navigationState === 'rejected' || navigationState === 'unconfirmed' || observed.presentation.state !== 'main-visible' ||
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
        focus: { executionSessionId: get().agentFocus.execution.sessionId, pmoSessionId: get().agentFocus.pmo.sessionId }, partial, save, issues }
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
    if (request.operation === 'send') {
      let session: Extract<SessionSnapshot, { kind: 'agent' }>
      if (request.target.kind === 'self' || request.target.kind === 'agent-session') {
        session = agentSession(request.target, request.caller)
      } else if (request.target.kind === 'region') {
        const region = resolveWorkbenchControlRegion(input(), request.target)
        if (region.kind !== 'agent') throw controlFailure('MESSAGE_TARGET_NOT_AGENT', 'Target Region is not an Agent.')
        session = agentSession({ kind: 'agent-session', agentSessionId: region.agentSessionId })
      } else {
        const tab = resolveWorkbenchControlTab(input(), { kind: 'tab', tabId: request.target.tabId })
        const candidates = messageTargetCandidates(input(), tab.id)
        if (candidates.length !== 1) {
          throw controlFailure('MESSAGE_TARGET_NOT_UNIQUE', 'Target Tab does not contain exactly one Agent Session.', { candidates })
        }
        session = agentSession({ kind: 'agent-session', agentSessionId: candidates[0]!.agentSessionId })
      }
      requireActive()
      if (!request.message) throw controlFailure('MESSAGE_ENVELOPE_INVALID', 'Control send requires a message envelope.')
      if (request.message.body !== request.text) throw controlFailure('MESSAGE_ENVELOPE_INVALID', 'Message body does not match Control text.')
      if (request.message.recipient.kind !== 'agent-session' || request.message.recipient.agentSessionId !== session.id ||
        request.message.recipientSessionId !== session.id ||
        request.message.recipientRunId !== null && request.message.recipientRunId !== session.control.run.runId) {
        throw controlFailure('MESSAGE_RECIPIENT_MISMATCH', 'Message recipient is not the resolved Agent Session/Run.')
      }
      const condition = validateAgentPromptCondition(request.promptCondition)
      if (condition.expectedRun.runId !== session.control.run.runId) throw controlFailure(
        'STALE_AGENT_SESSION', 'Message intent targets another Run.')
      await api.sessions.submitMessage(session.control, { envelope: request.message, condition,
        ...(request.sourceChannel === undefined ? {} : { sourceChannel: request.sourceChannel }),
        ...(request.execution === undefined ? {} : { execution: request.execution }),
        ...(request.caller ? { caller: { agentSessionId: request.caller.agentSessionId, capability: request.caller.capability ?? '' } } : {}) })
      return { operation: request.operation, agentSessionId: session.id }
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
        : undefined, request.operationId)
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
        ? { id: request.caller.agentSessionId, name: `Agent ${request.caller.agentSessionId}` }
        : undefined)
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
      const pendingId = `terminal-launch:${crypto.randomUUID()}`
      const pending: TerminalWorkbenchSurface = {
        regionId: plan.regionId, kind: 'terminal', phase: 'launching', workspaceId: workspace.id, sessionId: pendingId
      }
      plan.tabs[plan.tabId] = replaceWorkbenchRegion(plan.tabs[plan.tabId]!, plan.regionId, pending)
      set({ ...(plan.kind === 'launcher' ? {} : { activeWorkspaceId: workspace.id }),
        mainSurface: 'workbench', tabs: plan.tabs, layouts: plan.layouts })
      const cancel = (): void => rollback(pending)
      signal?.addEventListener('abort', cancel, { once: true })
      let session: SessionSnapshot | null = null
      const cleanup = async (primary: Error): Promise<never> => {
        if (session) {
          try { await api.sessions.stop(session.control) }
          catch (cleanupError) {
            set((current) => ({ sessions: [...current.sessions.filter((item) => item.id !== session!.id), session!] }))
            throw controlFailure('LAUNCH_CLEANUP_FAILED', `${primary.message} Cleanup failed: ${presentError(cleanupError)}`, {
              cause: new AggregateError([primary, cleanupError])
            })
          }
        }
        throw primary
      }
      try {
        session = await api.sessions.launchTerminal({
          hostId: workspace.hostId,
          workspacePath: workspace.path,
          createOperationId: request.requestId,
          ...(request.shellCommand === undefined ? {} : { shellCommand: request.shellCommand })
        })
        if (session.kind !== 'terminal' || session.hostId !== workspace.hostId || session.workspacePath !== workspace.path) {
          await cleanup(controlFailure('LAUNCH_RESULT_MISMATCH', 'Terminal launch result does not match its request.'))
        }
        if (signal?.aborted) await cleanup(controlCancellation(signal))
        const owner = findWorkbenchRegion(get().tabs, plan.regionId)
        if (!ownsSessionLaunch(owner?.surface, 'terminal', pendingId)) {
          await cleanup(controlFailure('CONTROL_OWNER_LOST', 'Control Region owner disappeared during Terminal launch.'))
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
        rollback(pending)
        throw error
      } finally {
        signal?.removeEventListener('abort', cancel)
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
      const browser = await api.browser.create(browserId, request.url, workspace.id)
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
        region: { tabId: plan.tabId, regionId: plan.regionId, workspaceId: workspace.id, kind: 'browser', browserId }
      }
    } catch (error) {
      rollback(plan.launcher)
      throw error
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  },
  selectSession(id, preferredTabGroupId) {
    if (!workbenchViewCloseAllowsSession(get().closingWorkbenchViews, id)) return
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
        return
      }
      const reference = references[0]!
      let choice: AgentMuxDesktopSpaceSelection
      try { choice = resolveWorkbenchOccurrenceSelection(current, catalog, { workspaceId: reference.displayWorkspaceId,
        groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId }, 'navigation') }
      catch (error) { current.reportError(error, { kind: 'indeterminate' }); return }
      set((state) => ({
        activeWorkspaceId: reference.displayWorkspaceId, workbenchSpaceSelection: choice,
        retainedSpatialFocus: null, workbenchNavigationInputPolicy: null, regionCaretFocus: null,
        mainSurface: 'workbench',
        displacedAgentSessionIds: state.displacedAgentSessionIds.filter((sessionId) => sessionId !== id)
      }))
      get().focusRegion(reference.displayWorkspaceId, reference.tabId, reference.regionId, 'pointer', reference.groupId)
      return
    }
    const session = get().sessions.find((candidate) => candidate.id === id)
    const workspace = session ? workspaceForSession(get().config, session, scratchTopicsForConfig(get().config, get().scratchTopicSnapshots)) : null
    if (!session || !workspace) return
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
    // 「浮层里开到背后主界面」的形态。selectSession 是同步 void 动作，抛出只会变成事件处理里的
    // 未捕获异常，所以走 reportError 把失败摆到界面上。
    const nextLayout = existingTabGroupId
      ? activateLayoutTab(layout, targetTabGroupId, tabId)
      : addTabPlacement(layout, targetTabGroupId, tabId)
    if (!nextLayout) {
      get().reportError(new Error('The Tab Group is no longer available'))
      return
    }
    const next = { ...get(), tabs: { ...get().tabs, [tab.id]: tab }, layouts: { ...get().layouts, [workspace.id]: nextLayout } }
    let choice: AgentMuxDesktopSpaceSelection
    try { choice = resolveWorkbenchOccurrenceSelection(next, workbenchSelectionCatalog(next),
      { workspaceId: workspace.id, groupId: targetTabGroupId, tabId: tab.id, regionId }, 'navigation') }
    catch (error) { get().reportError(error, { kind: 'indeterminate' }); return }
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
    const result = await get().executeControl({ schemaVersion: 5, requestId: `binding:${crypto.randomUUID()}`,
      operation: linked ? 'space.bind' : 'space.unbind', binding: { kind: 'zone-space', zoneId, spaceId } })
    if (result.operation !== 'space.bind' && result.operation !== 'space.unbind') throw new Error('The binding owner returned a different operation.')
    return result
  },
  async setTabDisplayPlacement(tabId, displayWorkspaceId, groupId, present) {
    const result = await get().executeControl({ schemaVersion: 5, requestId: `binding:${crypto.randomUUID()}`,
      operation: present ? 'space.bind' : 'space.unbind', binding: { kind: 'tab-group', tabId, displayWorkspaceId, groupId } })
    if (result.operation !== 'space.bind' && result.operation !== 'space.unbind') throw new Error('The binding owner returned a different operation.')
    return result
  },
  openLauncher({ workspaceId, displayWorkspaceId, tabGroupId, topicId: requestedTopicId, zoneId, reveal, initialInputs }) {
    const state = get()
    const displayId = displayWorkspaceId ?? workspaceId
    const layout = state.layouts[displayId]
    if (!layout) {
      get().reportError(new Error('The Workspace layout is still restoring'))
      return
    }
    const targetTabGroupId = tabGroupId ?? layout.activeGroupId
    if (!groupIds(layout.root).includes(targetTabGroupId) || !findGroup(layout, targetTabGroupId)) {
      get().reportError(new Error('The exact display Tab Group is no longer available'))
      return
    }
    let space: WorkbenchTab['space']
    let topicId: string | undefined
    if (zoneId) {
      const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID) ?? null) ?? []
      const catalog = spatialCatalog(state, topics)
      const zone = catalog.zones.find(zone => zone.zoneId === zoneId)
      if (!zone || zone.workspaceId !== workspaceId || zone.kind === 'unknown') {
        get().reportError(new Error('The exact Zone resource context is unavailable. Its original reference is retained.'))
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
      get().reportError(new Error('The Tab Group is no longer available'))
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
      warmLauncherId({ tabGroupId: targetTabGroupId, regionId: undefined }),
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
      warmLauncherId({ tabGroupId: targetTabGroupId, regionId: undefined }), initialInputs)
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
      set((current) => {
        const topology = applyWorkbenchViewCloseTopology(current, plan, tab)
        const committed = { ...reconcileWorkbenchFileProjection(current, topology),
          ...surveyPresentationAfterClose(current, topology.tabs),
          workbenchSpaceSelection: desktopSpaceSelectionAfterClose(current.workbenchSpaceSelection, topology,
            { workspaceId, tabId, groupId: tabGroupId }) }
        removedTab = current.tabs[tabId] && !committed.tabs[tabId] ? current.tabs[tabId] : undefined
        if(removedTab) coreSpatialPersistence?.removeEntity(removedTab.id)
        return committed
      })
      if (removedTab && !get().tabs[removedTab.id]) publishWorkbenchTabRemoved(removedTab, error => get().reportError(error))
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
    if (!visibleGroup || !storedGroup) { current.reportError(new Error('The selected object Group is unconfirmed. Original Tabs are kept.'), { kind: 'indeterminate' }); return }
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
    if (cause === 'floating-pointer') {
      // The borrowed View owns its local Region, native input and semantic lane. A click inside it
      // does not navigate the main workbench or authorize another Zone's launcher.
      set((state) => {
        const local = focusedSessionId ? focusSessionContext(state, focusedSessionId, undefined,
          { displayWorkspaceId: workspaceId, groupId: tabGroupId, tabId, regionId }) : state.agentFocus
        return { regionCaretFocus: null, ...(local !== state.agentFocus ? { agentFocus: local } : {}) }
      })
      return
    }
    let choice: AgentMuxDesktopSpaceSelection
    try { choice = resolveWorkbenchOccurrenceSelection(get(), workbenchSelectionCatalog(get()),
      { workspaceId, groupId: tabGroupId, tabId, regionId }, cause === 'navigation' ? 'navigation' : 'local') }
    catch (error) { get().reportError(error, { kind: 'indeterminate' }); return }
    set((state) => ({
      workbenchSpaceSelection: choice, activeWorkspaceId: choice.workspaceId, workbenchNavigationInputPolicy: null, retainedSpatialFocus: null,
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
  splitRegion(workspaceId, tabId, regionId, direction) {
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
    set((state) => ({ tabs: { ...state.tabs, [tabId]: nextTab } }))
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
    return openGitReading(workspaceId, { kind: 'history', scope, ...(reference !== undefined ? { reference } : {}), ...(locate ? { locate } : {}) })
  },
  selectGitHistoryReference(regionId, reference) {
    const found = findWorkbenchRegion(get().tabs, regionId)
    if (found?.surface.kind !== 'git' || !found.surface.history || found.surface.history.reference === reference) return
    const { tab, surface } = found
    set(current => ({ tabs: { ...current.tabs, [tab.id]: { ...tab, regions: { ...tab.regions,
      [regionId]: { ...surface, history: { ...surface.history!, reference } } } } } }))
  },
  showGitCommitDetails(regionId) {
    const found = findWorkbenchRegion(get().tabs, regionId)
    if (found?.surface.kind !== 'git' || !found.surface.history) return
    const { tab, surface } = found, { history: _history, ...details } = surface
    set(current => ({ tabs: { ...current.tabs, [tab.id]: { ...tab, regions: { ...tab.regions, [regionId]: details } } } }))
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
    if (!nextLayout) { get().reportError(new Error('The Tab Group is no longer available')); return }
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
  setMainSurface(mainSurface) {
    const state = get()
    const choice = state.workbenchSpaceSelection ?? (mainSurface !== 'survey' && mainSurface !== 'recall' && state.activeWorkspaceId
      ? workbenchObjectLayout(state, state.activeWorkspaceId).choice : null)
    const surface = choice?.tabId && choice.regionId ? state.tabs[choice.tabId]?.regions[choice.regionId] : undefined
    const confirmed = choice && projectWorkbenchSpaceSelection(state.layouts[choice.workspaceId], state.tabs, workbenchSelectionCatalog(state), choice).confirmed
    const linked = confirmed && surface && isSessionSurface(surface)
      ? Object.values(state.demands).filter(demand => demand.sessionIds.includes(surface.sessionId)) : []
    set({ mainSurface, workbenchNavigationInputPolicy: null, regionCaretFocus: null,
      ...(choice && !state.workbenchSpaceSelection ? { workbenchSpaceSelection: choice } : {}),
      ...(mainSurface === 'board' && linked.length === 1 ? { selectedDemandId: linked[0]!.id } : {}) })
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
    const state = get(), demand = id ? state.demands[id] : undefined
    if (demand) {
      try {
        const catalog = workbenchSelectionCatalog(state)
        const candidates = [...new Map(catalog.locations.filter(location => {
          const surface = state.tabs[location.tabId]?.regions[location.regionId]
          return surface && isSessionSurface(surface) && demand.sessionIds.includes(surface.sessionId)
        }).map(location => [JSON.stringify([location.spaceId, location.zoneId, location.displayWorkspaceId,
          location.groupId, location.tabId, location.regionId]), location])).values()]
        if (candidates.length === 1) {
          const exact = candidates[0]!
          get().selectMainRegion(exact, state.workbenchSpaceSelection)
        }
      } catch (error) { state.reportError(error, { kind: 'indeterminate' }) }
    }
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
      `You are Mote for existing Goal ${demand.id}. This is a new user request for ${mode === 'grill' ? 'Grill: align the goal' : 'Grounding: align the results'}.`,
      ...(!demand.alignment && !demand.description.trim() ? ['This is an existing undefined Goal draft. Its placeholder title is not the user’s intent. Ask what they want to achieve and update this same Goal ID; do not invent an outcome, success criteria or human approval.'] : []),
      'Preserve the user’s original intent. Do not create another Goal, invent requirements, or overwrite description with your summary.',
      mode === 'grill'
        ? 'Discuss only choices that change the goal. Propose a readable summary, stable success criterion IDs, and actual unresolved questions. The person confirms the goal in Goals.'
        : 'Inspect the actual work and report every current criterion with met/gap/unknown, locatable evidence references and concrete gaps. A reference is not proof by itself. The person accepts results in Goals; never claim their acceptance.',
      `Current durable Goal facts:\n${JSON.stringify({ id: demand.id, title: demand.title, description: demand.description, projectId: demand.projectId, sessionIds: demand.sessionIds, alignment: demand.alignment, grounding: demand.grounding }, null, 2)}`,
      'Read the current Goal before submitting. Use the public CLI below; replace the example with your actual proposal, not its placeholder content. Owner generates revision/submission IDs and acknowledgement timestamps.',
      `"$AGENTMUX_CLI" goal inspect --goal ${quote(demand.id)}`,
      `"$AGENTMUX_CLI" goal update --goal ${quote(demand.id)} --${mode === 'grill' ? 'alignment' : 'grounding'} ${quote(JSON.stringify(proposal))}`
    ].join('\n\n')
    return openGoalPmo(demandId, prompt, mode === 'grill' ? demand.alignment ? 'Discuss changes' : 'Clarify goal' : demand.grounding ? 'Ask agent to check again' : 'Ask agent to check work', options)
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
  },
  async acceptDemandResult(id, expectedAlignmentRevision, expectedSubmissionId, acceptGaps) {
    const receipt = await api.demands.acceptGrounding(id, expectedAlignmentRevision, expectedSubmissionId, acceptGaps)
    set(state => ({ demands: { ...state.demands, [id]: demandRecordFromFilesystem(receipt.demand, state.demands[id]) } }))
  },
  async refreshDemand(id) {
    const facts = await api.demands.list()
    const demand = facts.find(demand => demand.id === id)
    if (!demand) throw Object.assign(new Error(get().demands[id] ? 'The Goal owner did not return this goal. Its saved view is kept; retry loading the current proposal.' : 'The complete Goal owner read confirms this ID is not saved. Save this same ID explicitly to continue.'), { code: 'GOAL_OWNER_NOT_FOUND' })
    set(state => ({ demands: { ...state.demands, [id]: demandRecordFromFilesystem(demand, state.demands[id]) } }))
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
  setPortalOverlayCount(portalOverlayCount) {
    set({ portalOverlayCount })
  },
  acquireNativeSurfaceOverlay() {
    set((state) => ({ nativeSurfaceOverlayCount: state.nativeSurfaceOverlayCount + 1 }))
  },
  releaseNativeSurfaceOverlay() {
    set((state) => ({ nativeSurfaceOverlayCount: Math.max(0, state.nativeSurfaceOverlayCount - 1) }))
  },
  setWorkspaceTool(workspaceTool) {
    set({ workspaceTool, toolsOpen: true, mainSurface: 'workbench' })
  },
  toggleTools() {
    set((state) => ({ toolsOpen: !state.toolsOpen }))
  },
  setProjectRailWidth(projectRailWidth) {
    set({ projectRailWidth: clampProjectRailWidth(projectRailWidth) })
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
    if (prior?.state === 'checking' && configValuesEqual(prior.input, host)) return
    const request = Symbol(), input = structuredClone(host)
    hostExecutorRequests.set(hostId, request)
    const retained = prior && configValuesEqual(prior.input, input) ? prior.result : undefined
    set(state => ({ hostExecutorInventories: { ...state.hostExecutorInventories, [hostId]: {
      input, state: 'checking', ...(retained ? { result: retained } : {})
    } } }))
    const current = () => hostExecutorRequests.get(hostId) === request &&
      configValuesEqual(get().config?.hosts.find(item => item.id === hostId), input)
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
  },
  async detectExecutors(hostId) {
    const config = get().config, host = config?.hosts.find(host => host.id === hostId)
    if (!config || !host) return
    if (host.kind === 'ssh') return await get().discoverHostExecutors(hostId)
    const targets = Object.entries(config.executors).filter(([executorId, executor]) =>
      currentExecutorDetection(get().executorDetections[executorDetectionKey(hostId, executorId)], executorId, executor, host)?.state !== 'checking'
    ).map(([executorId, executor]) => {
      const key = executorDetectionKey(hostId, executorId), requestId = Symbol()
      detectionRequestIds.set(key, requestId)
      const input = structuredClone({ executorId, providerId: executor.providerId, command: executor.command, host })
      return { key, requestId, input }
    })
    if (targets.length === 0) return
    const matchesCurrent = (input: ExecutorDetectionInput) => executorDetectionMatches(input, input.executorId,
      get().config?.executors[input.executorId], get().config?.hosts.find(host => host.id === input.host.id))
    set((state) => ({
      executorDetections: {
        ...state.executorDetections,
        ...Object.fromEntries(targets.map(({ key, input }) => [key, { state: 'checking', input } satisfies ExecutorDetectionState]))
      }
    }))
    await Promise.all(
      targets.map(async ({ key, requestId, input }) => {
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
      })
    )
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
        get().focusRegion(choice.workspaceId, choice.tabId, choice.regionId, 'pointer', choice.groupId)
        set({ activeWorkspaceId: choice.workspaceId, mainSurface: 'workbench', workbenchSpaceSelection: choice,
          regionCaretFocus: null, workbenchNavigationInputPolicy: 'preserve' })
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
    const bornSpaceId = directoryIdentity(workspace.hostId, scratchTopicIdentityPath(workspace, { directoryPath: scratchTopicDirectoryName(topicId) }))
    const targetTab = { ...newLauncherTab(workspace.id, topicId), ...(preset === 'mote' ? {} : { space: { spaceId: bornSpaceId, zoneId: homeZoneId(bornSpaceId) } }),
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
    try {
      if (preset === 'mote') snapshot = await api.scratch.ensureMote(workspace.id, topicId)
      else {
        await api.topics.call('topic.create', { topicId, title: knowledge?.title ?? 'New Topic', ...(knowledge?.categoryId ? { categoryId: knowledge.categoryId } : {}) })
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
    if (snapshot.id !== topicId || snapshot.readError || !address || preset !== 'mote' && address.zoneId !== targetTab.space?.zoneId) throw new Error('The created Topic original identity is unconfirmed. Its Tab, Region and draft are kept.')
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
    catch (error) { get().reportError(error, { kind: 'indeterminate', summary: 'Topic metadata is unavailable. Original workface, references and healthy Agents are retained; retry this Topic.' }); throw error }
    finally { release() }
    if (!snapshot) throw new Error('Scratch Topic no longer exists')
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
    if (mayReveal) showConversation(snapshot)
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
    let receipt: NoteCreationReceipt = { intentId: retrying ? previous.intentId : crypto.randomUUID(), createdAt: retrying ? previous.createdAt : Date.now(), noteId, blockIds: [blockId], draft, path: '', status: 'pending', revealed: false,
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
    const content = JSON.stringify(newNoteDocument(draft, noteId, blockId), null, 2)
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
        try { await recordNotebookChanges(relocations, 'note-file-move:' + crypto.randomUUID()) }
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
  updateDocument(tabId, content, regionId) {
    set((state) => reduceDocumentContent(state, tabId, content, regionId))
  },
  async saveDocument(tabId, regionId) {
    await enqueueFileSave(tabId, false, regionId)
  },
  async overwriteDocument(tabId, regionId) {
    await enqueueFileSave(tabId, true, regionId)
  },
  useRetainedDocumentDraft(tabId, regionId) {
    // Read both buffers at the user's click, so a later edit is kept rather than overwritten.
    set(state => {
      const surface = fileSurface(state.tabs[tabId], regionId)
      if (!surface) return state
      const key = documentKey(surface.workspaceId, surface.path)
      const document = state.documents[key], drafts = state.retainedDocumentDrafts[key]
      if (!document || !drafts?.length) return state
      const [selected, ...remaining] = drafts
      return { documents: { ...state.documents, [key]: { ...document, content: selected!.content } },
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
    if (issue?.kind === 'write-unknown') {
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
      set((state) => reduceDocumentReloaded(state, surface.workspaceId, surface.path, issue.observed))
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
    const createOperationId = pmo?.intent.creationOperationId === undefined ? crypto.randomUUID() : await goalPmoOperation(pmo.intent, 'create')
    const sessionId = pmo?.intent.creationOperationId === undefined ? mintObjectId() : await api.sessions.resolveCreationSessionId(workspace.hostId, createOperationId)
    const live = get(), liveTargetTab = launcher ? live.tabs[tabId] : targetTab
    const liveLayout = live.layouts[displayWorkspaceId!]
    if (pmo && (!liveTargetTab || launcher && liveTargetTab.regions[regionId] !== launcherSurface ||
      !liveLayout || !findGroup(liveLayout, tabGroupId) || launcher && !findGroup(liveLayout, tabGroupId)!.tabOrder.includes(tabId) ||
      !workbenchViewCloseAllowsView(live.closingWorkbenchViews, tabId))) {
      throw new Error('The original PMO display position changed before creation. The Goal and original request are kept.')
    }
    const priorFailure = lifecycleFailureBelongsTo(state.errorNoticeContext?.lifecycle, { regionId })
      ? state.errorNoticeContext : null
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
      if (requestedNames.agentName) await commitDisplayName({ kind: 'agent-session', id: sessionId }, requestedNames.agentName, 'launch', 0)
        .catch(error => get().reportWorkbenchSaveFailure(error))
      if (requestedNames.tabName) await commitDisplayName({ kind: 'tab', id: tabId }, requestedNames.tabName, 'launch', requestedTabNameRevision)
        .catch(error => get().reportWorkbenchSaveFailure(error))
      if (timelineGapSessionId) void get().resyncTimeline(timelineGapSessionId)
      if (priorFailure && get().errorNoticeContext === priorFailure) {
        set({ error: null, lastError: null, errorNoticeContext: null, errorDismissed: false })
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
    const sessionId = crypto.randomUUID()
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
    try {
      const session = await api.sessions.launchTerminal({
        hostId: workspace.hostId,
        workspacePath: workspacePath ?? workspace.path,
        createOperationId: crypto.randomUUID()
      })
      const launchOwner = findWorkbenchRegion(get().tabs, regionId)
      if (
        !ownsSessionLaunch(launchOwner?.surface, 'terminal', sessionId) ||
        (launchOwner && !workbenchViewCloseAllowsView(get().closingWorkbenchViews, launchOwner.tab.id))
      ) {
        await api.sessions.stop(session.control).catch((cleanupError) => {
          if (get().sessions.some((item) => item.id === session.id)) get().reportError(cleanupError)
        })
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
      set((current) => reduceSessionLaunchFailed(current, regionId, 'terminal', sessionId,
        launcherSurface?.kind === 'launcher' ? launcherSurface : undefined))
      get().reportError(error)
      throw error
    }
  },
  prewarmTerminal(workspaceId, ownerLauncherId) {
    const workspace = get().config?.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) return
    const key = warmTerminalKey(workspace.hostId, workspace.path)
    const existing = get().warmTerminal
    if (existing?.key === key) {
      // 同 host 同 cwd 的 shell 可以复用，不必再起一个——但**归属要转过来**。分屏里两个 launcher
      // 的 key 完全一样，若这里直接 return，槽的 owner 就永远停在第一个挂载的那个 launcher 上，而
      // 后挂载的那个（用户刚点出来、正在看的那个）只能显示冷卡片。转移归属让「最后一个请求预热的
      // launcher 拥有预览」，同时仍然只有一个 PTY、仍然只有一个 view 挂在上面。
      if (existing.ownerLauncherId !== ownerLauncherId) {
        set((state) => (
          state.warmTerminal === existing
            ? { warmTerminal: { ...existing, ownerLauncherId } }
            : {}
        ))
      }
      return
    }
    // Changing the visible project is not permission to stop another healthy shell.
    if (existing) return
    const request: TerminalLaunchInput = {
      hostId: workspace.hostId,
      workspacePath: workspace.path,
      createOperationId: crypto.randomUUID()
    }
    const creation: WarmTerminalCreation = { request, inFlight: true }
    const ready = api.sessions.launchTerminal(request).catch((error) => {
      creation.inFlight = false
      creation.issue = sessionLaunchFailure(error)
      if (get().warmTerminal?.ready === ready) set((state) => ({
        warmTerminal: state.warmTerminal ? { ...state.warmTerminal } : null
      }))
      return null
    })
    void ready.then((session) => {
      if (!session) return
      creation.inFlight = false
      delete creation.issue
      set((state) => ({
        warmTerminal: state.warmTerminal?.ready === ready
          ? { ...state.warmTerminal, session }
          : state.warmTerminal,
        unclaimedTerminalSessionIds: trackUnclaimedTerminalSession(state.unclaimedTerminalSessionIds, session.id)
      }))
    })
    set({ warmTerminal: { key, ownerLauncherId, ready, session: null, creation } })
  },
  async retryWarmTerminal(workspaceId, ownerLauncherId, hostRestored = false) {
    const workspace = get().config?.workspaces.find((item) => item.id === workspaceId)
    const held = get().warmTerminal
    if (!workspace || !held || held.key !== warmTerminalKey(workspace.hostId, workspace.path)) return null
    const creation = held.creation
    if (held.session || !creation?.issue || creation.inFlight) return await held.ready
    if (hostRestored && creation.hostRecoveryAttempted) return null
    // This operation may already have created a Run. Confirm its original exact request;
    // replacing the UUID or reconstructing its parameters would be another creation.
    const request = creation.request
    creation.inFlight = true
    creation.hostRecoveryAttempted ||= hostRestored
    const ready = api.sessions.launchTerminal(request).catch((error) => {
      creation.inFlight = false
      creation.issue = sessionLaunchFailure(error)
      if (get().warmTerminal?.ready === ready) set((state) => ({
        warmTerminal: state.warmTerminal ? { ...state.warmTerminal } : null
      }))
      return null
    })
    set({ warmTerminal: { ...held, ownerLauncherId, ready } })
    const session = await ready
    if (session) {
      creation.inFlight = false
      delete creation.issue
      set((state) => ({
        warmTerminal: state.warmTerminal?.ready === ready ? { ...state.warmTerminal, session } : state.warmTerminal,
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
      if (state.warmTerminal?.key !== key || state.warmTerminal.claimToken) {
        // Cache contention changes only whether this opening reuses a candidate.
        const opening = get().launchTerminal(tabGroupId, launcher)
        if (launcher) flight.pendingSurface = get().tabs[launcher.tabId]?.regions[launcher.regionId]
        await opening
        return
      }
      let held = state.warmTerminal
      const claimToken = {}
      held = { ...held, explicitOpening: true }
      set({ warmTerminal: { ...held, claimToken } })
      try {
        if (held.creation?.issue) {
          const ownerLauncherId = warmLauncherId({ tabGroupId, regionId: launcher?.regionId })
          const confirmed = await get().retryWarmTerminal(workspace.id, ownerLauncherId)
          if (!confirmed) {
            const issue = get().warmTerminal?.creation?.issue ?? held.creation.issue
            throw Object.assign(new Error(issue.message), issue)
          }
          const live = get().warmTerminal
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
          sessionId: held.session?.id ?? crypto.randomUUID()
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
              warmTerminal: current.warmTerminal?.claimToken === claimToken ? null : current.warmTerminal,
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
            warmTerminal: current.warmTerminal?.claimToken === claimToken ? null : current.warmTerminal,
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
          if (current.warmTerminal?.claimToken !== claimToken) return current
          const { claimToken: _claim, ...retained } = current.warmTerminal
          return { warmTerminal: retained }
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
  async createBrowser(tabGroupId, launcher, url = 'about:blank', bookmarkOrigin, requestedWorkspaceId, requestedDisplayWorkspaceId) {
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
      const browser = await api.browser.create(regionId, url, workspaceId)
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
    if (!url || url === 'about:blank') throw new Error('This page has no address to bookmark yet')
    const content = emitWebloc(url)
    const base = bookmarkFileNameFromTitle(title)
    // 撞名退避：`Name.webloc`、`Name 2.webloc`……。判据是 `files.write` 带 `expectedRevision: null`——
    // 文件已存在时它返回 conflict（不覆盖），于是我们换下一个候选，而不是默默盖掉用户已有的书签。
    // ponytail: 上限 50 个候选；同一标题存到第 50 个还没空位是病态使用，那时如实抛错比无限试更诚实。
    let lastReason = ''
    for (let n = 1; n <= 50; n++) {
      const path = n === 1 ? `${base}.webloc` : `${base} ${n}.webloc`
      const result = await api.files.write(workspaceId, { path, content, expectedRevision: null })
      if (result.status === 'written') {
        // 让文件树/Topics/Board 看到新文件——与 createPath 用同一个失效计数器，不另起一套。
        set((current) => ({
          workspaceFileRevisions: bumpWorkspaceFileRevision(current.workspaceFileRevisions, workspaceId)
        }))
        return path
      }
      if (result.status === 'error' || result.status === 'unknown') throw Object.assign(new Error(result.message), { code: result.code })
      // conflict：这个名字被占了，试下一个。
      lastReason = `${path} already exists`
    }
    throw new Error(`Could not save the bookmark: ${lastReason}`)
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
  applyBrowserEvent(event) {
    set((state) => ({
      ...reduceBrowserEvent(state, event),
      ...(event.type === 'closed'
        ? {
            browserAnnotationsByBrowserId: Object.fromEntries(
              Object.entries(state.browserAnnotationsByBrowserId)
                .filter(([browserId]) => browserId !== event.id)
            )
          }
        : {})
    }))
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
  recallAgentComposerHistory(sessionId, direction, draft) {
    const state = get(), entries = state.agentComposerHistory[sessionId] ?? []
    const navigation = state.agentComposerHistoryNavigation[sessionId] ?? { cursor: entries.length, stash: null }
    const result = navigateHistory({ entries, ...navigation }, direction, draft)
    if (!result) return null
    set({ agentComposerHistoryNavigation: { ...state.agentComposerHistoryNavigation,
      [sessionId]: { cursor: result.state.cursor, stash: result.state.stash } } })
    return result.value
  },
  setAgentComposerDraft(sessionId, text) {
    const state = get(), session = sessionPresentationById(state.sessions).get(sessionId)
    if (!state.agentComposerDrafts[sessionId]?.trim() && text.trim() && session?.kind === 'agent') {
      void api.continuousProgress.pauseForInput(session.control).catch(error => get().reportError(error))
    }
    set((state) => ({
      agentComposerDrafts: { ...state.agentComposerDrafts, [sessionId]: text }
    }))
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
    return admitAgentSteer(sessionId, text, onRejected, operationId, origin, agentMuxNote, options) !== false
  },
  async archiveAgentSteer(sessionId, operationId, expectedText, archived) {
    let changed = false
    let result!: AgentSteerQueueEntry
    set(state => {
      const queue = state.agentSteerQueues[sessionId]
      const entry = queue?.find(item => item.operationId === operationId)
      if (!entry) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'This original message is no longer available. No replacement was created.')
      if (entry.text !== expectedText) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'This original message changed. Read its current text before archiving or restoring it.')
      if (state.agentSteerInFlight[sessionId] === operationId) throw controlFailure('AGENT_PROMPT_SUBMISSION_BUSY', 'This original call is preparing or submitting. Archiving cannot recall Provider input; its original facts are kept.')
      if (!archived && confirmedSteerDelivery(state.timelines[sessionId], state.sessions.find((item): item is Extract<SessionSnapshot, { kind: 'agent' }> => item.kind === 'agent' && item.id === sessionId)?.control, operationId)) {
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
  async sendQueuedAgentSteer(sessionId, operationId) {
    const entry = get().agentSteerQueues[sessionId]?.find(item => item.operationId === operationId)
    const session = get().sessions.find(item => item.id === sessionId)
    const attemptKey = JSON.stringify([sessionId, operationId])
    const admission = manualSteerAttempts.get(attemptKey)
    const seed = admission?.stage === 'queue-admission' ? admission.seed : startDeliveryAttempt({ agentSessionId: session?.kind === 'agent' ? session.control.agentSessionId : sessionId,
      operationId, hostId: session?.hostId ?? null, condition: entry?.promptCondition,
      ...(entry?.execution ? { execution: entry.execution } : {}),
      ...(entry ? { prompt: composeAgentPrompt(entry.text, entry.agentMuxNote).text } : {}) })
    const attempt: SteerDeliveryAttempt = admission?.stage === 'queue-admission' ? admission : { seed, stage: 'queue-validation' }
    attempt.stage = 'queue-validation'
    try {
      if (!entry) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'The selected original message is no longer in the pending queue.')
      if (entry.archived) throw controlFailure('CONTROL_REQUEST_CONFLICT', 'The selected original message is archived. Restore it before choosing Send.')
      if (get().agentSteerInFlight[sessionId] === operationId) throw controlFailure('AGENT_PROMPT_SUBMISSION_BUSY', 'This original message already has an active send attempt. Its original input is kept.')
      if (session?.kind !== 'agent') throw controlFailure('UNKNOWN_AGENT_SESSION', 'The original Agent Session is unavailable. No replacement or input was created.')
      const changedRun = entry.runId !== undefined && !steerEntryTargetsRun(entry, session.control.run.runId)
      if (changedRun && (entry.promptCondition !== null || entry.goalContinuation !== undefined)) {
        throw controlFailure('STALE_AGENT_SESSION', `The original delivery belongs to Run ${entry.runId}; the Session now points to Run ${session.control.run.runId}. Inspect the original delivery before sending it to another Run.`, {
          detail: JSON.stringify({ queuedRunId: entry.runId, currentRunId: session.control.run.runId,
            conditionState: entry.promptCondition === undefined ? 'unknown' : 'bound' })
        })
      }
      manualSteerAttempts.set(attemptKey, attempt)
      set(state => ({ agentSteerQueues: { ...state.agentSteerQueues,
        [sessionId]: state.agentSteerQueues[sessionId]!.map(item => {
          if (item.operationId !== operationId) return item
          const { awaitingExplicitSend: _pause, preparationWait: _wait, preparationInputNotApplied: _safe, ...pending } = item
          // A new explicit selection binds a never-dispatched intent, just like admission.
          // The ordered consumer still freezes fresh Core conditions before real input.
          return { ...pending, ...(changedRun ? { runId: session.control.run.runId } : {}),
            status: item.status === 'restoring' ? 'restoring' : 'queued' }
        }) } }))
      attempt.stage = 'ordered-queue'
      const pending = get().flushAgentSteerQueue(sessionId, operationId)
      const originalDrain = agentSteerDrains.get(sessionId)
      await pending
      if (originalDrain?.submitted.has(operationId) || confirmedSteerDelivery(get().timelines[sessionId], session?.kind === 'agent' ? session.control : undefined, operationId)) return 'submitted'
      if (originalDrain?.failures.has(operationId)) throw originalDrain.failures.get(operationId)
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
          item.operationId === operationId && item.text === entry?.text && item.agentMuxNote === entry?.agentMuxNote && item.sourceChannel === entry?.sourceChannel
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
  cancelAgentSteerPreparation(sessionId, operationId) {
    const entry = get().agentSteerQueues[sessionId]?.find(item => item.operationId === operationId)
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
    const requested = explicitOperationId !== undefined && selected && !selected.archived && target?.kind === 'agent' &&
      (selected.runId === undefined || steerEntryTargetsRun(selected, target.control.run.runId))
      ? explicitOperationId : undefined
    if (requested !== undefined && target?.kind === 'agent' && selected?.promptCondition === null && selected.execution === undefined) {
      // Accept the exact user's selection synchronously. Async coordination is not its owner:
      // recovery, interaction and storage waits retain this choice in the one durable queue.
      const execution = agentSteerExecution(selected, target.capabilities)
      set(state => ({ agentSteerQueues: { ...state.agentSteerQueues,
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
          if (session?.kind !== 'agent') { refuseSelections('UNKNOWN_AGENT_SESSION', 'The original Agent Session disappeared before queue dispatch.'); return }
          const sessionHostId = session.hostId
          const endpointIssue = state.runtimeEndpointWarnings?.find(warning => warning.scope !== 'observation' && warning.hostId === sessionHostId && warning.availability !== 'connected')
          if (endpointIssue && drain.explicitSteers.size === 0) { refuseSelections('CONTROL_UNAVAILABLE', `Original Host ${sessionHostId} endpoint is ${endpointIssue.availability}: ${endpointIssue.message}`); return }
          const currentRunId = session.control.run.runId
          const pendingEntries = state.agentSteerQueues[sessionId]?.filter(item =>
            !item.archived && !item.awaitingExplicitSend &&
            (item.runId === undefined || steerEntryTargetsRun(item, currentRunId)))
          // Explicit steer selects its exact intent, leaving queue-only work untouched. Multiple
          // explicit requests retain their author order in this one queue, including across awaits.
          const entry = pendingEntries?.find(item => drain.explicitSteers.has(item.operationId)) ??
            pendingEntries?.find(item => item.promptCondition === null && item.execution !== undefined) ?? pendingEntries?.[0]
          if (!entry) { refuseSelections('CONTROL_REQUEST_CONFLICT', 'The selected original message is archived, paused or belongs to a different Run before dispatch.'); return }
          if (entry.goalDispatch && confirmedSteerDelivery(state.timelines[sessionId], session.control, entry.operationId)) {
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
          if (entry.goalPmo?.creationOperationId !== undefined && confirmedSteerDelivery(state.timelines[sessionId], session.control, entry.operationId)) {
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
          if (entry.runId === currentRunId && entry.promptCondition === null && entry.execution !== undefined && session.pendingInteraction) {
            retainWaitingSelections(currentRunId)
            return
          }
          if (!drain.explicitSteers.has(entry.operationId) && entry.runId !== undefined && (!steerQueueCanDrainNow(session) || session.status.state === 'disconnected')) {
            refuseSelections('CONTROL_UNAVAILABLE', session.pendingInteraction ? 'The original Agent is waiting for an interaction response. Answer it before retrying this message.' : `Original Run ${session.control.run.runId} is ${session.processState}; Agent status is ${session.status.state}${session.status.detail ? `: ${session.status.detail}` : ''}`)
            return
          }
          // The set joins active callers; only a known unsubmitted original selection can
          // outlive it. Unknown/historical or boot-paused inputs never gain auto-retry authority.
          const explicitAttempt = drain.explicitSteers.delete(entry.operationId) ||
            entry.promptCondition === null && entry.execution !== undefined
          if (!explicitAttempt && entry.promptCondition === null && session.status.state === 'working') return
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
          const explicitlyBound = explicitAttempt && entry.runId === currentRunId
          let preparedHere = false
          let dispatchStarted = false
          const attemptHostId = session.hostId
          const attemptSessionId = session.control.agentSessionId
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
            item.sourceChannel === entry.sourceChannel && reactionIntentKey(item.reaction) === reactionIntentKey(entry.reaction) && JSON.stringify(item.goalContinuation) === JSON.stringify(entry.goalContinuation) && JSON.stringify(item.goalPmo) === JSON.stringify(entry.goalPmo) && JSON.stringify(item.goalDispatch) === JSON.stringify(entry.goalDispatch) &&
            (!dispatchStarted || item.execution === attemptExecution) &&
            (item.promptCondition === null) === (attemptCondition === null) &&
            item.promptCondition?.expectedRun.runId === attemptCondition?.expectedRun.runId &&
            item.promptCondition?.afterSubmissionId === attemptCondition?.afterSubmissionId
          set((current) => ({
            agentSteerInFlight: { ...current.agentSteerInFlight, [sessionId]: entry.operationId },
            agentSteerInFlightPhase: { ...current.agentSteerInFlightPhase, [sessionId]: 'preparing' }
          }))
          try {
            if (entry.runId === undefined) {
              set((current) => ({ agentSteerQueues: { ...current.agentSteerQueues,
                [sessionId]: current.agentSteerQueues[sessionId]!.map(item => {
                  if (item.operationId !== entry.operationId) return item
                  return { ...item, status: 'restoring' }
                }) } }))
              deliveryAttempt.stage = 'session-recovery'
              const recovered = await get().recoverSession(sessionId, entry.operationId)
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
              if (execution === 'immediate' && fresh.capabilities.promptExecution?.immediate !== 'interrupt-before-input' && fresh.capabilities.promptExecution?.immediate !== 'native-steer') {
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
                submit: preparationRetry => api.sessions.submitPrompt(retryTarget.control, retryMessage.text, retryMessage.operationId, condition,
                  explicitAttempt ? { allowUncertainTurn: true,
                    ...(retryMessage.execution === 'immediate' ? { execution: 'immediate' as const } : {}), ...(preparationRetry ? { preparationRetry } : {}) }
                    : retryMessage.execution === 'immediate' ? { execution: 'immediate' } : undefined,
                  retryMessage.origin === 'manual', retryMessage.agentMuxNote, retryMessage.sourceChannel,
                  retryMessage.goalContinuation ? { goalId: retryMessage.goalContinuation.goalId, loopId: retryMessage.goalContinuation.loopId } : undefined, retryMessage.goalPmo, retryMessage.goalDispatch)
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
              if (!pending || target?.kind !== 'agent' || target.hostId !== attemptHostId ||
                target.control.agentSessionId !== attemptSessionId) return current
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
            const explicitPending = freshSession?.kind === 'agent' && fresh.agentSteerQueues[sessionId]?.some(item =>
              drain.explicitSteers.has(item.operationId) && !item.archived && !item.awaitingExplicitSend &&
              (item.runId === undefined || steerEntryTargetsRun(item, freshSession.control.run.runId)))
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
    const operationId = crypto.randomUUID(), session = get().sessions.find(item => item.id === sessionId)
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
    if (admitAgentSteer(sessionId, text, reject, operationId, origin, agentMuxNote, options) === false) return false
    manualSteerAttempts.set(JSON.stringify([sessionId, operationId]), { seed, stage: 'queue-admission' })
    void get().sendQueuedAgentSteer(sessionId, operationId).catch(error => (onRejected ?? get().reportError)(error))
    return true
  },
  async respondInteraction(sessionId, response) {
    const session = get().sessions.find((item) => item.id === sessionId)
    if (!session || session.kind !== 'agent') return
    // Each mounted answer surface owns its local failure. A rejected answer is not a new
    // window-level Agent error, and a late result must not paint onto another request.
    await api.sessions.respondInteraction(session.control, response)
    await get().flushAgentSteerQueue(sessionId)
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
  async refreshSession(sessionId) {
    const before = get()
    if (!workbenchViewCloseAllowsSession(before.closingWorkbenchViews, sessionId)) return
    const current = before.sessions.find((item) => item.id === sessionId)
    const accepted = before.pendingAgentLaunches[sessionId]?.created
    const control: SessionControl | undefined = current?.control ?? (accepted ? {
      kind: 'agent', hostId: accepted.hostId, agentSessionId: accepted.agentSessionId, run: accepted.run
    } : undefined)
    if (!control) return
    if (accepted) {
      const result: AgentLaunchResult = { created: accepted, projectionFailures: [] }
      try {
        const session = await api.sessions.refresh(control)
        if (session.kind !== 'agent' || session.id !== sessionId || session.control.run.runId !== accepted.run.runId) {
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
          !hasAttachedSessionView(state.tabs, sessionId) || (live && !sessionOwnsControl(live, control))) return state
        return reduceDetachedAgentLaunch(state, result).state
      })
      return result.session
    } else {
      try {
        const session = await api.sessions.refresh(control)
        set((state) => {
          const live = state.sessions.find((item) => item.id === sessionId)
          if (!workbenchViewCloseAllowsSession(state.closingWorkbenchViews, sessionId) ||
            !live || !sessionOwnsControl(live, control) || !hasAttachedSessionView(state.tabs, sessionId)) return state
          const refreshed = retainTimelineObservation(live, session)
          return { sessions: [...state.sessions.filter((item) => item.id !== session.id), refreshed] }
        })
        return session
      } catch (error) { get().reportError(error); throw error }
    }
  },
  async reopenRetiredSession(source, operationId = crypto.randomUUID(), observeOnly = false) {
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
    // A candidate can exist only in Core's durable catalogue. Give it a view at its registered
    // original Host/directory before recovery; the commit below intentionally needs an attached
    // view owner. Existing durable Regions keep their layout/focus during background resync.
    if (!options?.preserveView && !hasAttachedSessionView(get().tabs, sessionId)) get().selectSession(sessionId)
    const priorFailure = current.kind === 'agent' && lifecycleFailureBelongsTo(before.errorNoticeContext?.lifecycle, { subject: current.control })
      ? before.errorNoticeContext : null
    try {
      let recovery: SessionRecoveryResult
      try {
        recovery = await api.sessions.recover(current.control, current.workspacePath, operationId)
      } catch (error) {
        // A lost continuity reply is not permission to launch again. First read canonical facts.
        if (!operationId || current.kind !== 'agent') throw error
        const canonical = await api.sessions.refresh(current.control).catch(() => undefined)
        if (!canonical || canonical.kind !== 'agent' || canonical.control.hostId !== current.control.hostId || canonical.control.agentSessionId !== current.control.agentSessionId || canonical.processState !== 'running') throw error
        recovery = { kind: 'reattachable', session: canonical }
      }
      if (options?.stillCurrent && !options.stillCurrent()) return
      if (current.kind === 'agent' && 'agentSessionId' in recovery &&
        (recovery.agentSessionId !== current.control.agentSessionId || recovery.previousRun.runId !== current.control.run.runId))
        throw new Error('Recovery response belongs to another Agent Session or Run. The original conversation is kept.')
      if (recovery.kind === 'retired') {
        if (options?.preserveView) {
          get().reportError(new Error('The original Session is retired. Its Mote conversation and history are kept; choose another default conversation in Profile.'), { kind: 'indeterminate', subject: current.control })
          return
        }
        set((state) => removeSessionProjection(state, sessionId))
        if (priorFailure && get().errorNoticeContext === priorFailure) {
          set({ error: null, lastError: null, errorNoticeContext: null, errorDismissed: false })
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
        if (priorFailure && get().errorNoticeContext === priorFailure) {
          set({ error: null, lastError: null, errorNoticeContext: null, errorDismissed: false })
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
    try {
    const core = event.event
    const endpointObservation = event.endpointObservation
    if (endpointObservation) set(state => ({ runtimeEndpointWarnings: runtimeEndpointWarningsAfterObservation(
      state.runtimeEndpointWarnings, event.hostId, endpointObservation.warning, endpointObservation.step) }))
    if (core.type === 'control-endpoint-state') {
      if (sessionMembershipResync) enqueueSessionMembershipEvent(sessionMembershipResync, event)
      return
    }
    if (event.endpointWarning !== undefined && !(core.type === 'connection-state' && core.state === 'restored' && event.endpointWarning === null)) set((state) => {
      const runtimeEndpointWarnings = runtimeEndpointWarningsAfterObservation(state.runtimeEndpointWarnings, event.hostId, event.endpointWarning)
      return { runtimeEndpointWarnings, sessions: projectRuntimeEndpointSessions(state.sessions, runtimeEndpointWarnings) }
    })
    if (core.type === 'connection-state' && core.state === 'restored') {
      const warm = get().warmTerminal
      const request = warm?.creation?.request
      if (warm?.creation?.issue && request?.hostId === event.hostId) {
        const workspace = get().config?.workspaces.find(item => item.hostId === request.hostId && item.path === request.workspacePath)
        if (workspace) void get().retryWarmTerminal(workspace.id, warm.ownerLauncherId, true)
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
      ...(diagnostic.subject ? { subject: diagnostic.subject } : {}) })
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
      timelineGapSessionId = reduced.timelineGapSessionId
      sessionMembershipGap = reduced.sessionMembershipGap === true
      const projected = reduced.state.sessions === state.sessions ? reduced.state
        : { ...reduced.state, sessions: projectRuntimeEndpointSessions(reduced.state.sessions, state.runtimeEndpointWarnings) }
      return core.type === 'agent-timeline' && eventSourceId
        ? reconcileDeliveredSteers({ ...state, ...projected }, eventSourceId)
        : projected
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
    } finally { rendererPerformance.sessionEvent(event.event.type, observationStarted) }
  },
  decayStaleAgentStatuses(now) {
    set((state) => {
      const decayed = computeDecayedAgentStatuses(state.sessions, now)
      // computeDecayedAgentStatuses 无变化时返回原引用——原样返回，Zustand 不做无谓写入。
      return decayed === state.sessions ? state : { sessions: decayed }
    })
  },
  setConfig(config) {
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
    set((state) => ({
      ...adoptedConfig(state.activeWorkspaceId, config),
      ...(Object.hasOwn(config.appearance, 'spaceObjectIcons') ? { spaceObjectIcons: configValuesEqual(state.spaceObjectIcons, iconProjection) ? state.spaceObjectIcons : iconProjection } : {}),
      ...(runtimeConfigChanged ? { executorDetections: Object.fromEntries(Object.entries(state.executorDetections).filter(([, check]) => {
        const input = check.input
        return input && executorDetectionMatches(input, input.executorId, config.executors[input.executorId], config.hosts.find(host => host.id === input.host.id))
      })), hostChecks: {} } : {})
    }))
  },
  reportError(error, context) {
    const message = presentError(error)
    // Replayed runtime events and polling can report the same transient failure repeatedly. Once the
    // user dismissed that failure, do not resurrect it until a different one arrives or they explicitly
    // reopen it.
    //
    // The key is the failure's IDENTITY, not the presented string. Whole-string equality looked right and
    // was wrong: the prompt-readiness refusal appends `Diagnostic: … latestOutputBytes=<cursor>`, and that
    // cursor grows with every byte the Agent prints. So a still-generating Agent produced a *new* string
    // each time, `===` never matched, and the dismissed banner came back on every retry (field report
    // prior observation). The user dismissed the cause; the code was comparing the presentation.
    //
    // Both sides go through `errorIdentity` on every comparison — the newest message and the one we
    // remembered. Storing a precomputed key beside `lastError` would be the same defect one level up: two
    // places deciding identity, drifting the first time a write site forgets one of them.
    const current = get()
    const previousSubject = current.errorNoticeContext?.subject
    const subject = context?.subject
    if (current.errorDismissed && current.lastError !== null
      && (current.errorNoticeContext?.kind ?? 'indeterminate') === (context?.kind ?? 'indeterminate')
      && current.errorNoticeContext?.startupSessionSnapshot === context?.startupSessionSnapshot
      && previousSubject?.hostId === subject?.hostId
      && previousSubject?.kind === subject?.kind
      && (previousSubject?.kind === 'agent' ? previousSubject.agentSessionId : undefined)
        === (subject?.kind === 'agent' ? subject.agentSessionId : undefined)
      && previousSubject?.run.runId === subject?.run.runId
      && current.errorNoticeContext?.lifecycle?.step === context?.lifecycle?.step
      && (current.errorNoticeContext?.lifecycle?.step !== 'launch' ||
        context?.lifecycle?.step === 'launch' && current.errorNoticeContext.lifecycle.regionId === context.lifecycle.regionId)
      && errorIdentity(current.lastError) === errorIdentity(message)) return
    set({ error: message, lastError: message, errorNoticeContext: context ?? null, errorDismissed: false })
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
    // Old Chromium reads never overwrite acknowledged names or clear tombstones.
    if (current.nameAuthorityRevision > 0) {
      state.agentNames = current.agentNames
      state.surveyExplorationNames = current.surveyExplorationNames
      state.nameLabels = current.nameLabels
      state.nameAuthorityRevision = current.nameAuthorityRevision
    }
    state.spaceObjectIcons = restoreSpaceIconOverrides(Object.hasOwn(current.config?.appearance ?? {}, 'spaceObjectIcons')
      ? current.config!.appearance.spaceObjectIcons : retainedSpaceIconHandoff)
    return { ...state, questionReplies: restoredQuestionReplies(state.questionReplies), goalAgentSelectionDrafts: restoredGoalAgentSelectionDrafts(state.goalAgentSelectionDrafts), goalAgentCreationDrafts: restoredGoalAgentCreationDrafts(state.goalAgentCreationDrafts), agentComposerHistory: restoreComposerHistory(state.agentComposerHistory),
      agentComposerHistoryNavigation: {}, surveyZoneSelection: restoredSurveyZoneSelection(state.surveyZoneSelection), recallZoneSelection: restoredSurveyZoneSelection(state.recallZoneSelection) }
  },
  partialize: partializeAppState
}))

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
