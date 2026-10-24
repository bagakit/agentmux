import { decodePreparedTerminal, parsePreparedTerminal, parsePreparedTerminalStop, type AgentMuxPreparedTerminal, type AgentMuxPreparedTerminalStop } from './terminal-preparation.js'
import type { AgentMuxCreationRuntime, AgentMuxTerminalCreationRetirement, AgentMuxTerminalCreationRetirementObservation } from './terminal-creation-retirement.js'
import { AgentSessionRecoveryService } from './agent-session-recovery/service.js'
import { retryAgentCreationResources } from './agent-creation-resource-retry.js'
import type { AgentMuxAgentResumeInput, AgentMuxAgentReopenInput } from './agent-session-recovery/resume-contract.js'
import { assertAgentPromptSize, runRef, safeId, hookBindingIdentity, terminalHandshakeOperationIdentity, terminalInitialPromptReadinessIdentity, terminalEnvironment } from './agent-runtime-helpers.js'
import { parseExternalConversationReference, parseExternalConversationAuthority, externalConversationAuthor, externalConversationRecordId, type AgentExternalConversationAuthorityPort, type AgentExternalConversationReceipt, type AgentExternalConversationReference } from './external-conversation.js'
import { mintObjectId } from './object-id.js'
import type { ReadingDiagnosticRecord, ReadingDiagnosticReason } from './reading-diagnostic.js'
import { CoreReadingDiagnosticSource } from './reading-diagnostic-source.js'
import { CoreStartupDiagnosticJournal } from './startup-diagnostic-journal.js'
import { parseStartupDiagnosticTarget, type AgentStartupDiagnosticOwner, type AgentStartupDiagnosticExactTarget, type AgentStartupDiagnosticRecentTarget } from './startup-diagnostic.js'
import { unavailableDiagnosticEvidence } from '@agentmux/diagnostic-evidence'
import type { ReadingDiagnosticExactTarget, ReadingDiagnosticFindParams, ReadingDiagnosticFindResult } from './reading-diagnostic-query.js'
import { runAgentMessageBroadcast, type AgentMuxMessageBroadcastInput, type AgentMuxMessageBroadcastReceipt } from './agent-message-broadcast.js'
import { AgentMuxMessageNotifications } from './agent-message-notifications.js'
import type { AgentMuxMessageNotification } from './agent-message-notification.js'
import { isMessageNotificationInput } from './agent-message-notification.js'
import { parseTerminalFrontendObservation, type AgentTerminalFrontend } from './agent-terminal-frontend.js'
import { type AgentMuxAgentRestartIdentity, type AgentMuxAgentRestartInput, type AgentMuxAgentRestartInspection } from './agent-session-recovery/restart-contract.js'
import { confirmNativeInputAdoption, confirmNativeInputAdoptions } from './native-input-adoption.js'
import { parseAgentInputMailboxRead, type AgentInputMailboxRead, type AgentInputMailboxPage, type AgentInputMailboxItem } from './agent-input-mailbox.js'
import { classifyExecutable, executorUnavailableError, type AgentExecutableProbeContext } from './executable-probe.js'
import { unconfirmedExecutableObservation } from './executable-observation.js'
import { parseAgentExternalMessageAuthor, parseAgentExternalInteractionAuthor } from './external-author.js'
import { parseNativeConversationCheckpoint, parseNativeConversationChangesPage, type NativeConversationCheckpoint, type NativeConversationChangesPage } from './session-history-changes.js'
import type { AgentSessionHistoryItem } from './types.js'
import type { AgentConversationReadPage, ConversationRef } from './conversation.js'
import { readAgentConversation as readUnifiedConversation, conversationCheckpoint as cutUnifiedConversation, readConversationChanges as readUnifiedChanges,
  conversationReadNativeSource, ConversationReaderState, type ConversationReaderPort } from './conversation-reader.js'
import { parseConversationRef, parseConversationCheckpointInput, parseConversationWatchInput, parseConversationViewReleaseInput, parseConversationWatchOpening, parseConversationObservation, parseConversationFrontier, parseConversationCheckpoint,
  type ConversationTimelineReadInput, type ConversationReadOptions, type ConversationCheckpointInput, type ConversationCheckpointPage, type ConversationChangesInput,
  type ConversationChangesPage, type ConversationObservation, type ConversationObservationHandle, type ConversationWatchInput, type ConversationViewReleaseInput, type ConversationViewReleaseResult } from './conversation-changes.js'
import { SessionHistoryObservationPool } from './session-history-observation-pool.js'
import { createInputPerformanceRecorder, hostedCarrierPerformance, readInputObservation, readInputObservationField, type InputObservationReference, type ClientPerformanceDiagnostics, type InputPerformanceHandle } from './performance-diagnostics.js'
import { DeliveryAttemptStore } from './delivery-attempt-store.js'
import { deliveryFailure, newDeliveryLogId, type DeliveryAttempt, type DeliveryAttemptLookup, type DeliveryInputPhase } from './delivery-attempt.js'
import type { AgentMuxRunStorageObservation } from './run-storage-observation.js'

import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import {
  AgentMuxAcpBridge,
  type AgentMuxAcpBinding
} from './acp-adapter.js'
import { normalizeNativeSessionId, normalizeNativeTranscriptPath, matchesProviderNativeSessionTarget } from './agent-native-locator.js'
import { captureAgentNativeSessionIdentity } from './agent-native-session-capture.js'
import { normalizeAgentInteractionResponse } from './agent-interaction.js'
import { hasSelectedNativeTarget, nativeTargetSourceUnconfirmed, resolveNativeSessionWitness } from './agent-native-source.js'
import { parseAgentNativeSessionConfirmation } from './agent-native-session-confirmation.js'
import { parseAgentNativeResumeSource } from './agent-native-sessions.js'
import { nativeCatalogIssue } from './providers/native-session-catalog-files.js'
import { agentForkIdentityReminder, assertAgentForkSource, parseAgentForkSource, type AgentMuxAgentForkSource } from './agent-fork.js'
import { agentInteractionActiveRequest, agentInteractionResponseUnavailableReason, agentInteractionResponseSettled, agentInteractionRequestTarget } from './agent-interaction-state.js'
import {
  normalizeLaunchOptionSelection,
  type LaunchOptionSelection
} from './agent-launch-option.js'
import {
  AgentProviderRegistry,
  resolveAgentExecutable,
  splitLaunchPromptByDelivery,
  type AgentProvider,
  type AgentManagedHookPlanContext,
  type AgentProviderHookNormalizationContext,
  type AgentProviderPromptExecutionContext
} from './agent-provider.js'
import { createDefaultAgentMuxPluginRegistry, type AgentMuxPlugin } from './agent-plugin.js'
import { normalizeNativeHook, releaseSubagentRoster, agentHasActiveSubagents, agentSubagentActivityUnconfirmed, observeSubagentMainEnd, nativeHookToolCallId, projectNativeHookToolInvocation } from './hook-normalizer.js'
import { eventNamesCanReopenTurn, resolveHookEventName } from './agent-hook-event.js'
import { classifyRunExit, type AgentMuxRunExitReason } from './agent-run-exit.js'
import {
  hookEventUpdatesSemanticStatus,
  hookTurnPhaseAfter,
  type HookTurnPhase
} from './hook-turn-phase.js'
import { runBoundedReconnect } from './ctxmux-reconnect.js'
import { judgeReconnectFlap, shouldClearFlapLedger } from './ctxmux-reconnect-budget.js'
import { normalizeMessageChannel } from './message-origin.js'
import { normalizeOperationDevice } from './operation-device.js'
import { composeAgentLaunchPrompt, composeAgentPrompt, type AgentMuxOptionalContext } from './agent-outbound-message.js'
import { parseBrowserInputContext, parseBrowserInputContextSource } from './browser-input-context.js'
import { parseAgentInputContextCaptureReference, type AgentInputContextCaptureProof } from './agent-input-context-capture.js'
import { resolveAgentInputContextCapture } from './agent-input-context-capture-resolve.js'
import { hashAgentCapability, issueAgentCapability, resolveCapabilityAuthor, type AgentCapabilityBinding } from './agent-capability.js'
import { planDiscussion } from './agent-discussion.js'
import { agentSpawnContext, type AgentMuxSpawnCreator } from './agent-spawn.js'
import { parseAgentSpawnQuery, type AgentMuxSpawnQuery, type AgentMuxSpawnPage } from './agent-spawn-query.js'
import {
  DurableAgentMuxMessageQueue,
  validateAgentMuxMessageEnvelope,
  type AgentMuxDeliveryBatch,
  type AgentMuxDeliveryAcknowledgement,
  type DurableAgentMuxMessage,
  type AgentMuxMessageEnvelope
} from './agent-global-message-queue.js'
import { renderAgentMuxMessageEnvelope } from './agent-message-render.js'
import { agentInputSubmissionStatus, agentInputJournalKey, validateAgentInputWaitRef,
  type AgentInputJournalIntent, type AgentInputJournalEntry, type AgentInputSelector, type AgentInputSubmissionReceipt,
  type AgentInputWaitRef, type AgentInputWaitStopReceipt, type AgentInputSavedEnvironment, type AgentInputCallContext, type AgentRawInputCallContext } from './agent-input-wait.js'
import { answerAsk, cancelAsk, type AgentAsk } from './agent-ask.js'
import {
  AGENT_TERMINAL_CAPABILITY_PERSIST_FAILED,
  AGENT_TERMINAL_HANDSHAKE_FAILED,
  AGENT_TERMINAL_HANDSHAKE_TIMEOUT,
  AGENT_TERMINAL_HANDSHAKE_UNCONFIRMED,
  classifyTerminalHandshakeFailure,
  degradedInputCursor,
  terminalHandshakeExitError
} from './agent-terminal-handshake-outcome.js'
import {
  handOff,
  type Dispatch,
  type DispatchEventKind,
  type DispatchObservation,
  type DispatchIdentityDiagnostic,
  type DispatchPage,
  type HandoffResult
} from './agent-handoff.js'
import { advanceDelivery, type AgentThread } from './agent-message.js'
import type { AgentMuxExecutorProbeResult } from './control.js'
import { AgentMuxClientEventPublisher } from './client-event-publisher.js'
import { observeMessageJournal } from './agent-message-observer.js'
import { agentPromptCondition, agentPromptInputId, agentPromptNotApplied, validateAgentPromptAdmissionIntent, validateAgentPromptCondition, validateAgentPromptInputKey,
  type AgentPromptAdmissionIntent, type AgentPromptInputKey, type AgentPromptCondition } from './agent-prompt-condition.js'
import { agentTurnCompletionIdentity, agentTurnEndEvidence, agentNativeTurnEnd, nativeTurnEndScopeMatches, cloneSession, sameNativeHandle, sameRun } from './agent-session-identity.js'
import { transitionAgentSemanticStatus } from './agent-semantic-state.js'
import { observeAgent, currentAgentSemanticStatus, type AgentObservation } from './agent-status-freshness.js'
import { runDisplayState } from './agent-run-status.js'
import { AgentScreenEvidenceStore } from './screen-evidence.js'
import {
  AgentPromptSubmissionCoordinator,
  observePromptInput,
  promptPreparationFailure,
  beginPromptPreparationPhase,
  completePromptPreparationPhase,
  promptPreparationObservationDetail,
  type AgentPromptTransportQualification,
  type AgentPromptProtocolInputBoundary
} from './prompt-submission.js'
import { CTXMUX_COMMIT, CTXMUX_VERSION, CtxmuxRunAdapter, type CtxmuxAdapterAttachment, type CtxmuxAdapterEvent, type CtxmuxAdapterRun, type CtxmuxAdapterStopOperation, type CtxmuxEndpointObservation } from './ctxmux-run-adapter.js'
import { supportedCtxmuxArtifactPlatform } from './runtime-paths.js'
import { AgentMuxError } from './errors.js'
import { agentCreationNotAppliedError, finishAgentCreationCleanup } from './agent-creation-failure.js'
import { parseSessionHistoryResourceOptions, SESSION_HISTORY_IMAGE_MAX_BYTES } from './session-history-resource.js'
import { readRecordedFile, readRecordedImage, readRecordedMarkdownImage } from './session-history-resource-read.js'
import { isNativeContentReference, nativeContentNeedsRevalidation, readNativeContentResource, revalidateNativeContentReference } from './native-history-content.js'
import { readAgentSessionHistory, type AgentSessionHistoryReadInput, type AgentSessionHistoryReadPage } from './session-history-reader.js'
import { deriveAgentSessionId, mintAgentSessionId } from './agent-session-id.js'
import {
  normalizeAgentInteractionRequest,
  AgentMuxFileAgentSessionStore,
  AgentMuxSessionDurabilityError,
  loadAgentSessionMetadata,
  agentLifecycleOperationIdentity,
  loadSessionHistorySources,
  type AgentMuxAgentSessionStore,
  type AgentMuxLifecycleReservation,
  type AgentMuxPreparedCreation
} from './agent-session-store.js'
import {
  AgentMuxAgentSessionRegistry,
  type AgentMuxAgentSessionLookup
} from './agent-session-registry.js'
import { type AgentMuxAgentContinuityInput, type AgentMuxAgentContinuityResult } from './agent-session-recovery/continuity-contract.js'
import { type AgentMuxContinuityControlInput, type AgentMuxContinuityControlResult } from './agent-session-recovery/control-contract.js'
import type { AgentMuxContinuityLaunchInput } from './agent-session-recovery/continuity-contract.js'
import { AgentHookServer, type AgentHookBinding } from './hook-server.js'
import { AgentManagedHookInstaller, type AgentManagedHookInspection, type AgentManagedHookPlan } from './managed-hook-installer.js'
import { defaultAgentMuxControlSocketPath, defaultAgentMuxMessageQueuePath, defaultAgentMuxStateDirectory, defaultCtxmuxStateDirectory, resolveCoreBinPath } from './runtime-paths.js'
import {
  projectAgentMuxRuntimeSubjects,
  type AgentMuxRuntimeProjection,
  type AgentMuxRuntimeSubject,
  type AgentMuxRuntimeSubjectTarget
} from './runtime.js'
import { agentTimelineMutationFromAcpEvent } from './session-timeline.js'
import { acceptsAgentActivityState, advanceAgentActivityCommit, agentActivityTimelineItem } from './agent-activity-state.js'
import type { AgentActivityObservation, AgentSemanticState, AgentActivityState, AgentCapabilitySnapshot, AgentCatalogEntry, AgentExecutorId, AgentProviderId, AgentMuxAgentPasteInput, AgentMuxAgentWriteInput, AgentMuxAgentSession, AgentMuxAgentCreationInspection, AgentNativeActivityEvent, AgentCurrentActivity, AgentMuxNativeSessionConfirmationInput, AgentMuxNativeSessionConfirmation, AgentPromptMessageContent, AgentMuxClientEvent, AgentMuxClientEventListener, AgentMuxClientEventListenerOptions, AgentMuxObservationOrigin, AgentMuxInteractionRequest, AgentMuxInteractionResponse, AgentMuxInteractionOperationReceipt, AgentMuxInteractionOperationIntent, AgentMuxRun, AgentMuxRunAppliedSize, AgentMuxRunAttachment, AgentMuxRunAttachmentView, AgentMuxRunDataEvent, AgentMuxRunInputAck, AgentMuxRunInputData, AgentMuxRunInputOperation, AgentMuxRunRef, AgentMuxStoredAgentSession, AgentMuxRuntimeDiagnostics, AgentMuxRuntimeIdentity, AgentMuxRuntimeResourceSnapshot, AgentNativeSessionHandle, AgentNativeResumeSource, AgentNativeSessionCatalog, AgentNativeSessionCandidate, AgentNativeHistoryReadOptions, AgentProviderSessionHistoryPage, AgentNativeHistoryResourceReadOptions, AgentProviderSessionHistoryResourceReadResult, AgentSessionHistoryMetadata, AgentSessionHistoryPage, AgentSessionHistoryPageOptions, AgentSessionHistoryResourceReadOptions, AgentSessionHistoryResourceReadResult, AgentSessionQuestionReplyReceipt, AgentSessionHistoryQuestionAnswer, AgentSessionHistorySource, AgentSessionHistoryDescriptor, AgentSessionHistoryObservation, AgentSessionHistoryObservationOptions, AgentSessionHistoryObservationHandle, AgentTerminalCapabilityState, AgentTerminalOutputChannelState, AgentTimelineItem, AgentTimelineMutation, AgentTimelineSnapshot, AgentStatus, NativeHookEnvelope } from './types.js'
import { normalizeSessionHistoryPage, SESSION_HISTORY_TIMEOUT_MS } from './session-history.js'
import { AgentMuxCreationAuthority, agentCreationIntentDigest } from './agent-creation-authority.js'
import type { AgentMuxCreationAdmission, AgentMuxCreationOrigin } from './agent-creation-admission.js'
import type { AgentMuxHostExecutorOwner } from './executor-owner.js'
import type { AgentMuxHostExecutorConfigureInput } from './executor-contract.js'

/** Zero means no authoritative observation has been recorded. */
const unobservedTimestamp = 0


const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const TERMINAL_HANDSHAKE_TIMEOUT_MS = 10_000
// A local event annotation, never serialized or retained as another Session fact owner.
const localSessionObservation = Symbol('local-session-observation')
type LocalSessionObservation = 'terminalOutputChannel' | 'terminalCapability'
function permissionNativeTurnEnd(session: AgentMuxStoredAgentSession, request: Extract<AgentMuxInteractionRequest, { kind: 'permission' }>) {
  const hook = request.permissionHook
  return request.agentSessionId === session.agentSessionId && request.evidence.run?.runId === session.run.runId &&
    session.nativeHandle?.kind === 'provider' && hook?.nativeSessionId === session.nativeHandle.sessionId
    ? agentNativeTurnEnd(session, hook.nativeTurnId) : undefined
}

type NativeHistoryBinding = {
  sourceHostId: string
  session: AgentSessionHistoryMetadata
  provider: AgentProvider
  executorOptions: Pick<AgentSessionHistoryPageOptions, 'commandOverride' | 'args' | 'env'>
  handle: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
  readonly transient: boolean
  matches(current: AgentSessionHistoryMetadata, hostId: string, run?: AgentMuxRunRef): boolean
  assertCurrent(): Promise<void>
}
type NativeHistoryObservationResource = { controller: AbortController; binding: NativeHistoryBinding | null }

const PROVIDER_READ_MAX_CONCURRENT = 4
const AGENTMUX_CLI_PATH = resolveCoreBinPath('amux')

export type AgentMuxAgentCreateInput = {
  agentSessionId?: string
  createOperationId?: string
  /** Native context copy into this new Session; the source retains its original Run. */
  forkSource?: AgentMuxAgentForkSource
  /** Continue an exact persisted Provider conversation that has no existing Core owner. */
  nativeResumeSource?: AgentNativeResumeSource
  providerId: AgentProviderId
  executorId: AgentExecutorId
  workspacePath: string
  injectAgentMuxGuide: boolean
  prompt?: string
  /** Authenticated author of this creation's original prompt; Core owns its durable message. */
  initialMessage?: { callerAgentSessionId: string; capability: string; threadId?: string }
  /** Authenticated creation caller, independent of whether an initial message is requested. */
  creationCaller?: { agentSessionId: string; capability: string }
  /**
   * AgentMux 自己要对 Agent 说的额外上下文（如 Scratch Topic 说明），署名进出站信封而非混进用户段。
   * 与 `prompt`（用户/发起者的原话，逐字节透传）分层：调用方分开传，信封组装由 Core 的出口负责。
   */
  agentMuxNote?: string
  /** Explicit non-human platform task; kept in generated context rather than the original request body. */
  agentMuxTask?: string
  /** Whole optional platform sources, selected against the final launch wire budget. */
  optionalContext?: readonly AgentMuxOptionalContext[]
  args?: readonly string[]
  /**
   * Chosen ids for the sealed launch options this Provider declares (see agent-launch-option.ts). The
   * argv each choice contributes is resolved core-side and appended at spawn; an option or choice the
   * Provider does not declare fails closed rather than launching an un-offered posture.
   */
  launchOptions?: LaunchOptionSelection
  env?: Readonly<Record<string, string>>
  commandOverride?: string
  cols?: number
  rows?: number
}

/** Target-owned configuration, with a frozen revision; no source machine argv or environment. */
export type AgentMuxHostAgentCreateInput = Pick<AgentMuxAgentCreateInput,
  'agentSessionId' | 'createOperationId' | 'executorId' | 'workspacePath' | 'prompt' | 'agentMuxNote' | 'agentMuxTask' | 'optionalContext' |
  'launchOptions' | 'cols' | 'rows' | 'nativeResumeSource'> & {
  executorRevision: string
  /** Existing signed creation intent admission; an initial body is optional. */
  initialMessageAdmission?: AgentMuxCreationAdmission
  threadId?: string
}

export function hostAgentCreationIntent(input: AgentMuxHostAgentCreateInput): string {
  const { initialMessageAdmission: _proof, ...intent } = input
  return agentCreationIntentDigest(intent)
}

function creationIntentDigest(input: AgentMuxAgentCreateInput, agentSessionId: string, executorId: string, createOperationId: string,
  author?: AgentMuxStoredAgentSession, creator?: AgentMuxStoredAgentSession): string {
  const { initialMessage, creationCaller, ...intent } = input
  return agentCreationIntentDigest({ ...intent, agentSessionId, executorId, createOperationId,
    ...(creationCaller && (!author || creator!.agentSessionId !== author.agentSessionId || creator!.run.runId !== author.run.runId)
      ? { creationCaller: { agentSessionId: creator!.agentSessionId, run: creator!.run } } : {}),
    ...(initialMessage ? { initialMessage: { callerAgentSessionId: author!.agentSessionId, run: author!.run, threadId: initialMessage.threadId } } : {}) })
}

function creationPromptConfirmed(creation: NonNullable<AgentMuxAgentSession['creation']>,
  contextRequested = creation.agentMuxContext !== undefined): boolean {
  return (!contextRequested || creation.agentMuxContext === 'confirmed') &&
    (creation.initialPrompt === 'not-requested' || creation.initialPrompt === 'confirmed')
}

/** Bind only the original Start receipt; this is never native input acceptance. */
function bindInitialInput(input: AgentMuxContinuityLaunchInput | undefined, agentSessionId: string,
  run: AgentMuxRunRef): AgentMuxContinuityLaunchInput | undefined {
  if (!input) return
  return { ...structuredClone(input), key: { kind: 'prompt', agentSessionId, expectedRun: { ...run }, submissionId: input.input.submissionId },
    ...(input.delivery === 'launch' ? { state: 'launch-carried' as const,
      receipt: { kind: 'runtime-launch' as const, operationId: input.lifecycleOperationId, run: { ...run }, observedAt: Date.now() } } : {}) }
}

export type AgentMuxTerminalCreateInput = {
  createOperationId?: string
  workspacePath: string
  command?: string
  args?: readonly string[]
  cols?: number
  rows?: number
  env?: Readonly<Record<string, string>>
}

type AgentMuxAgentPromptContent = {
  /** Resolves only through a trusted non-wire Host reader; mutually exclusive with inputContext. */
  inputContextCapture?: import('./agent-input-context-capture.js').AgentInputContextCaptureReference
  inputContext?: import('./browser-input-context.js').BrowserInputContext
  /** Explicit choice for this message only: the previous turn may still be running. */
  allowUncertainTurn?: boolean
  execution?: import('./types.js').AgentPromptExecution
  /** A finite explicit preparation retry retains the original source/input fence. */
  preparationRetry?: import('./prompt-preparation.js').AgentPromptPreparationRetryFence
  /** Conditional automation: abandon if this Run/turn completion no longer applies. */
  expectedCompletionId?: string
  /** Exact saved future-message intent; never authorizes interruption or uncertain turns. */
  expectedFutureIntent?: import('./types.js').AgentFuturePromptOccurrence
  /** New automatic admission only: final Native cursor must equal this observed input fence. */
  expectedInputByte?: number
  /** Cancellation before admission; an already claimed input transaction finishes or reconciles. */
  signal?: AbortSignal
  agentSessionId: string
  operationId: string
  /** Explicit manual origin attributed by trusted host. */
  authorHuman?: boolean
  sourceDevice?: import('./types.js').AgentOperationDevice
  sourceChannel?: import('./types.js').AgentMessageChannel
  /** Explicit host-generated context; a tag inside prompt cannot supply this fact. */
  agentMuxNote?: string
  prompt: string
}

export type AgentMuxAgentPromptInput = AgentMuxAgentPromptContent & (
  (AgentPromptCondition & { admissionIntent?: never }) |
  { expectedRun: AgentMuxRunRef; afterSubmissionId?: never;
    admissionIntent: import('./agent-prompt-condition.js').AgentDirectedPromptTarget; execution: 'immediate'; expectedCompletionId?: never;
    expectedFutureIntent?: never; expectedInputByte?: never; preparationRetry?: never }
)

/** Explicit manual answer to an exact Provider-owned asynchronous question record. */
export type AgentMuxSessionQuestionReplyInput = AgentPromptCondition & Omit<AgentMuxAgentPromptContent,
  'prompt' | 'agentMuxNote' | 'inputContext' | 'inputContextCapture' | 'execution' | 'expectedCompletionId' | 'expectedInputByte' | 'expectedFutureIntent'> & {
  source: AgentSessionHistorySource
  turnId: string
  recordId: string
  answers: AgentSessionHistoryQuestionAnswer[]
  /** Original authenticated channel action; the executing Host must restore its authority. */
  externalAction?: import('./external-author.js').AgentExternalInteractionAuthor
  /** Configured native invocation, just as for the existing public history reader. */
  commandOverride?: string
  args?: readonly string[]
  env?: Readonly<Record<string, string | undefined>>
}

export type AgentMuxAgentMessageSubmission = {
  envelope: AgentMuxMessageEnvelope
  sourceDevice?: import('./types.js').AgentOperationDevice
  sourceChannel?: import('./types.js').AgentMessageChannel
  execution?: import('./types.js').AgentPromptExecution
  caller?: { agentSessionId: string; capability: string }
} & ({ condition?: never; admissionIntent?: never; execution?: 'default' } |
  { condition: AgentPromptCondition; admissionIntent?: never } |
  { condition?: never; admissionIntent: Exclude<AgentPromptAdmissionIntent, { kind: 'exact-condition' }>; execution: 'immediate' })

export type AgentMuxAgentMessageInput = AgentMuxAgentMessageSubmission & { agentSessionId: string }

export type AgentMuxAgentInteractionInput = AgentMuxInteractionOperationIntent & {
  agentSessionId: string
  expectedRun: AgentMuxRunRef
  response: AgentMuxInteractionResponse
}

export type AgentMuxAgentPostureInput = {
  agentSessionId: string
  expectedRun: AgentMuxRunRef
  modeId: string
}

export type AgentMuxAgentRespawnInput = Omit<
  AgentMuxAgentCreateInput,
  'providerId' | 'executorId' | 'workspacePath' | 'agentSessionId'
> & {
  previousAgentSessionId: string
  agentSessionId?: string
}

export type AgentMuxAgentAttachment = {
  session: AgentMuxAgentSession
  attachment: AgentMuxRunAttachment
}

/** Byte syntax only: neither the entry kind nor a mouse encoding authenticates a human action. */
function rawInputBytePattern(data: AgentMuxRunInputData, byteLength: number): 'mouse-sgr' | 'mouse-legacy' | 'other' {
  if (byteLength > 48) return 'other'
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  if (bytes.length === 6 && bytes[0] === 27 && bytes[1] === 91 && bytes[2] === 77 &&
      bytes.subarray(3).every(byte => byte >= 32) &&
      (typeof data !== 'string' || data.length === byteLength)) return 'mouse-legacy'
  if (bytes.every(byte => byte < 128)) {
    const match = /^\x1b\[<\d{1,10};\d{1,10};\d{1,10}[Mm]$/u.exec(Buffer.from(bytes).toString('ascii'))
    if (match?.[0].length === byteLength) return 'mouse-sgr'
  }
  return 'other'
}

function rawInputCancellationDetail(session: AgentMuxAgentSession, data: AgentMuxRunInputData,
  operationId: string, inputKind: 'write' | 'paste' | 'posture') {
  const byteLength = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength
  return Object.freeze({ agentSessionId: session.agentSessionId, runId: session.run.runId, operationId, inputKind,
    encoding: typeof data === 'string' ? 'utf8' as const : 'binary' as const,
    byteLength, bytePattern: rawInputBytePattern(data, byteLength), phase: 'before-input-lane' as const,
    expectedByte: null, acknowledgementAtCancellation: 'not-attempted' as const,
    confirmedInputBytesAtCancellation: 0, eventualOutcome: 'unknown' as const })
}

export type AgentMuxClientOptions = {
  /** Original semantic owner identity, supplied by the Host; never inferred from a path or Run. */
  diagnosticOwner?: AgentStartupDiagnosticOwner
  externalConversationAuthority?: AgentExternalConversationAuthorityPort
  hostExecutorOwner?: AgentMuxHostExecutorOwner
  creationAuthority?: AgentMuxCreationAuthority
  /** Exact local public owner endpoint inherited by managed CLI callers. */
  controlSocketPath?: string
  providers?: readonly AgentProvider[]
  /** Optional plugin contributions. When providers are omitted, built-ins and these plugins share one registry. */
  plugins?: readonly AgentMuxPlugin[]
  store?: AgentMuxAgentSessionStore
  /**
   * Installs the provider's managed Hook config before its first launch. Defaults to a `hooks`
   * subdirectory of the ctxmux state directory so backups live beside the rest of the runtime state.
   * Tests inject one over an isolated state directory to keep hook writes out of the real `$HOME`.
   */
  hookInstaller?: AgentManagedHookInstaller
}

export type AgentMuxAgentRuntimeStatus = {
  session: AgentMuxAgentSession
  run: AgentMuxRun
  capabilities: AgentCapabilitySnapshot['capabilities']
  /**
   * 三条不折叠的观察轴（进程活性 / 语义活性 / 就绪性），从 Session 现在的三条事实经 {@link observeAgent}
   * 收敛而来——**唯一**的观察合同投影。CLI（list.sessions / whoami）与渲染层读的是同一个函数的结果，
   * 谁也不再各拼一份塌成 busy 的逻辑。
   */
  observation: AgentObservation
  /** Read projection of the original pending tuple, never a durable status or a global input gate. */
  interactionResponseUnavailableReason?: string
}

/**
 * Normalize the one transport error which has a precise meaning inside the terminal handshake.
 *
 * CtxMux may report a vanished Run from any of the handshake's three I/O phases (attach/replay,
 * the post-replay status boundary, or the capability Input write). Keeping this mapping at the
 * handshake boundary gives the public connect loop one stable, Session-scoped classification while
 * lifecycle callers can still fail closed on the resulting `AGENT_TERMINAL_HANDSHAKE_FAILED`.
 */
function mapVanishedTerminalHandshakeRun(error: unknown): unknown {
  if (error instanceof AgentMuxError && error.code === 'STALE_AGENT_SESSION_BINDING' &&
      error.cause instanceof AgentMuxError && error.cause.code === 'CTXMUX_run_not_found') error = error.cause
  if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_run_not_found') return error
  const mapped = new AgentMuxError(
    'Agent Run disappeared before its terminal capability query was observed.',
    AGENT_TERMINAL_HANDSHAKE_FAILED,
    error.detail
  )
  // Keep the transport error available to diagnostics without leaking its transport-specific code
  // into the public handshake contract.
  mapped.cause = error
  return mapped
}

function interactionReceiptPatch(session: AgentMuxStoredAgentSession, operationId: string,
  patch: Partial<AgentMuxInteractionOperationReceipt>): AgentMuxStoredAgentSession {
  const original = session.interactionOperations?.[operationId]
  if (!original) return session
  return { ...session, interactionOperations: { ...session.interactionOperations,
    [operationId]: { ...original, ...patch } } }
}

function digestInteractionResponse(response: AgentMuxInteractionResponse): string {
  return createHash('sha256').update(JSON.stringify(response)).digest('base64url')
}

/**
 * 把内核观察到的一条 run 投影成对外的 `AgentMuxRun`。纯函数：退出原因由调用方给。
 *
 * 唯一的调用方是 `AgentMuxClient.projectRun`，它从 `endedRuns` 台账取那个原因。之所以拆成「纯函数 +
 * 一处取值」而不是让 11 个调用点各带一个 `exitReason` 实参：那样每处都要手抄一次「从台账取值」，漏抄
 * 一处，那条路上的退出原因就静默退化成缺席，而 tsc 对可选字段缺席一言不发——正是本条缺陷的形状。
 */
function projectRunWith(
  exitReason: AgentMuxRunExitReason | undefined,
  run: CtxmuxAdapterRun,
  agentSession?: AgentMuxAgentSession
): AgentMuxRun {
  const observedAt = Date.now()
  return {
    runId: run.runId,
    kind: agentSession ? 'agent' : 'terminal',
    providerId: agentSession?.providerId ?? null,
    executorId: agentSession?.executorId ?? null,
    agentSessionId: agentSession?.agentSessionId ?? null,
    workspacePath: run.workspacePath ?? agentSession?.workspacePath ?? '',
    pid: run.pid,
    state: run.state.type,
    cols: run.cols,
    rows: run.rows,
    observedAt,
    latestOutputBytes: run.latestOutputBytes,
    acceptedInputBytes: run.acceptedInputBytes,
    nativeService: run.nativeService,
    ...(run.state.type === 'exited'
      ? {
          exitCode: run.state.code,
          ...(run.state.signal === null ? {} : { exitSignal: run.state.signal }),
          // 退出原因只在 exited 时在场：分类本身只对 exited 有定义（interrupted 不参与）。
          ...(exitReason === undefined ? {} : { exitReason })
        }
      : run.state.type === 'interrupted'
        ? { interruptionReason: run.state.reason }
        : {})
  }
}


type AgentInputObservation = {
  run: AgentMuxRunRef
  controller: AbortController
  protocolInput?: AgentPromptProtocolInputBoundary
}

// Classify the whole transport payload without decoding binary mouse coordinates or
// allocating per report. This grants no input authority: the original preclaim still
// requires the exact Runtime ACK and a fresh target verification.
function wholeMouseReports(data: AgentMuxRunInputData): boolean {
  const string = typeof data === 'string'
  const byte = (index: number): number => string ? data.charCodeAt(index) : data[index]!
  let offset = 0
  while (offset < data.length) {
    if (byte(offset++) !== 27 || byte(offset++) !== 91) return false
    const format = byte(offset++)
    if (format === 77) {
      if (offset + 3 > data.length) return false
      const button = byte(offset++), col = byte(offset++), row = byte(offset++)
      // The legacy encoder uses binary bytes; non-ASCII JS strings would be
      // UTF-8 encoded into different bytes on the wire. Zero coordinates are invalid.
      if (button < 32 || col < 33 || row < 33 || button > 255 || col > 255 || row > 255 ||
          string && (button > 127 || col > 127 || row > 127)) return false
    } else if (format === 60) {
      for (let field = 0; field < 3; field++) {
        let value = 0, digits = 0
        while (offset < data.length && byte(offset) >= 48 && byte(offset) <= 57) {
          value = value * 10 + byte(offset++) - 48
          if (!Number.isSafeInteger(value)) return false
          digits++
        }
        if (!digits || (field === 0 ? value > 255 : value < 1)) return false
        if (field < 2 && byte(offset++) !== 59) return false
      }
      const action = byte(offset++)
      if (action !== 77 && action !== 109) return false
    } else return false
  }
  return offset === data.length && offset > 0
}

type TerminalFrontendWatch = {
  key: string; controller: AbortController; attempt?: AbortController; observer?: { dispose(): void }; pending: Promise<boolean>; frontend?: AgentTerminalFrontend
  retry?: ReturnType<typeof setTimeout>; failures: number; ready: Set<() => void>
}

type RawInputCall = { signal: AbortSignal; check(): void; author?: () => void | Promise<void> }

export class AgentMuxClient {
  private readonly hostExecutorOwner: AgentMuxHostExecutorOwner | undefined
  private readonly creationAuthority: AgentMuxCreationAuthority | undefined

  private requireCreationAuthority(): AgentMuxCreationAuthority {
    if (!this.creationAuthority) throw new AgentMuxError('This Core has no semantic creation authority.', 'CONTROL_UNAVAILABLE')
    return this.creationAuthority
  }

  async agentCreationAuthority() { return await this.requireCreationAuthority().identity() }

  async attestAgentCreation(input: { caller: { agentSessionId: string; capability: string }; target: { runtimeId: string; intentDigest: string } }) {
    const source = await this.currentStoredAgentSession(input.caller.agentSessionId)
    this.resolveMessageAuthor(input.caller.capability, input.caller.agentSessionId, source)
    return await this.requireCreationAuthority().attest({ agentSessionId: source.agentSessionId, runId: source.run.runId }, input.target)
  }

  async listTrustedCreationSources() { return await this.requireCreationAuthority().listTrusted() }

  async trustCreationSource(input: import('./agent-creation-admission.js').AgentMuxCreationTrustInput, principal?: { kind: 'user'; id: string }) {
    if (principal?.kind !== 'user' || !principal.id) throw new AgentMuxError('Source trust requires an authenticated user configuration action.', 'CONTROL_PERMISSION_DENIED')
    return await this.requireCreationAuthority().trust(input, principal)
  }

  async listHostExecutors(input?: { refresh?: boolean }) {
    if (!this.hostExecutorOwner) throw new AgentMuxError('Target Host Executor registry is unavailable.', 'CONTROL_UNAVAILABLE')
    return await this.hostExecutorOwner.list(input)
  }

  /** The original target Executor owns its Provider and environment; no secrets leave this owner. */
  async listHostNativeAgentSessions(input: { executorId: string; workspacePath?: string }): Promise<AgentNativeSessionCatalog> {
    if (!this.hostExecutorOwner) throw new AgentMuxError('Target Host Executor registry is unavailable.', 'CONTROL_UNAVAILABLE')
    const { config } = await this.hostExecutorOwner.resolve(input.executorId)
    return await this.listNativeAgentSessions({ providerId: config.providerId, env: config.env,
      ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }) })
  }

  /** The executing Host supplies private Executor configuration; no Session or Runtime connection is required. */
  async readHostNativeAgentHistory(input: Pick<AgentNativeHistoryReadOptions, 'source' | 'cursor' | 'limit' | 'signal'> &
    { executorId: string }): Promise<AgentProviderSessionHistoryPage> {
    if (!this.hostExecutorOwner) throw new AgentMuxError('Target Host Executor registry is unavailable.', 'CONTROL_UNAVAILABLE')
    const { config } = await this.hostExecutorOwner.resolve(input.executorId)
    const source = parseAgentNativeResumeSource(input.source)
    if (config.providerId !== source.nativeHandle.providerId) throw new AgentMuxError(
      'The selected native conversation belongs to another Executor Provider.', 'INVALID_AGENT_NATIVE_RESUME_SOURCE')
    return await this.readNativeAgentHistory({ ...input, source, commandOverride: config.command, args: config.args, env: config.env })
  }

  async readHostNativeAgentHistoryResource(input: Omit<AgentNativeHistoryResourceReadOptions, 'commandOverride' | 'args' | 'env'> &
    { executorId: string }): Promise<AgentProviderSessionHistoryResourceReadResult> {
    if (!this.hostExecutorOwner) throw new AgentMuxError('Target Host Executor registry is unavailable.', 'CONTROL_UNAVAILABLE')
    const { config } = await this.hostExecutorOwner.resolve(input.executorId)
    const nativeSource = parseAgentNativeResumeSource(input.nativeSource)
    if (config.providerId !== nativeSource.nativeHandle.providerId) throw new AgentMuxError(
      'The recorded resource belongs to another Executor Provider.', 'INVALID_AGENT_NATIVE_RESUME_SOURCE')
    const { executorId: _executorId, ...request } = input
    return await this.readNativeAgentHistoryResource({ ...request, nativeSource, commandOverride: config.command, args: config.args, env: config.env })
  }

  async configureHostExecutor(input: AgentMuxHostExecutorConfigureInput) {
    if (!this.hostExecutorOwner) throw new AgentMuxError('Target Host Executor registry is unavailable.', 'CONTROL_UNAVAILABLE')
    return await this.hostExecutorOwner.configure(input)
  }

  async createHostAgentWithDelivery(input: AgentMuxHostAgentCreateInput) {
    if (!this.hostExecutorOwner) throw new AgentMuxError('Target Host Executor registry is unavailable.', 'CONTROL_UNAVAILABLE')
    const allowed = ['agentSessionId', 'createOperationId', 'executorId', 'executorRevision', 'workspacePath', 'prompt',
      'agentMuxNote', 'agentMuxTask', 'optionalContext', 'launchOptions', 'cols', 'rows', 'initialMessageAdmission', 'threadId', 'nativeResumeSource']
    if (!input || Object.keys(input).some(key => !allowed.includes(key)) || !input.agentSessionId || !input.createOperationId || !input.executorRevision ||
      input.agentMuxTask !== undefined && typeof input.agentMuxTask !== 'string') {
      throw new AgentMuxError('Target creation requires exact Session, operation and Executor revision, without command overrides.', 'INVALID_CONTROL_REQUEST')
    }
    const intentDigest = hostAgentCreationIntent(input)
    const authority = this.requireCreationAuthority()
    const { runtimeId } = await authority.identity()
    const origin = input.initialMessageAdmission ? await authority.verify(input.initialMessageAdmission, { runtimeId, intentDigest }) : undefined
    // Resolve an existing intent before reading a possibly changed Executor configuration. Never
    // restart or re-input an operation whose original delivery is unknown.
    const existing = await this.readCreationSession(input.agentSessionId, input.createOperationId)
    if (existing?.kind === 'retired-agent') throw new AgentMuxError(
      'The original creation belongs to a retired Agent. Inspect that operation; only an explicit reopen or a new creation intent can continue work.',
      'AGENT_CREATION_RETIRED', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
    if (existing) {
      if (existing.creation?.createOperationId !== input.createOperationId || existing.creation.intentDigest !== intentDigest ||
        JSON.stringify(existing.creation.initialMessageOrigin) !== JSON.stringify(origin)) {
        throw new AgentMuxError('This operation belongs to another creation intent.', 'AGENT_CREATION_OPERATION_CONFLICT')
      }
      return { session: existing, creation: existing.creation, promptConfirmed: creationPromptConfirmed(existing.creation) }
    }
    const pending = await this.registry.claimCreate(input.agentSessionId, agentLifecycleOperationIdentity('create', input.agentSessionId, input.createOperationId), intentDigest)
    if (pending) {
      const session = await this.completePreparedCreate(pending, await this.kernel.inspectCreation(pending.operationId))
      return { session: this.projectSession(session), creation: session.creation!, promptConfirmed: creationPromptConfirmed(session.creation!) }
    }
    const { config, descriptor } = await this.hostExecutorOwner.resolve(input.executorId)
    if (descriptor.configRevision !== input.executorRevision) throw new AgentMuxError('Target Executor configuration changed. Refresh its inventory before a new operation.', 'EXECUTOR_REVISION_CONFLICT')
    return await this.createAgentWithDeliveryAuthorized({
      agentSessionId: input.agentSessionId, createOperationId: input.createOperationId,
      providerId: config.providerId, executorId: input.executorId, workspacePath: input.workspacePath,
      injectAgentMuxGuide: config.injectAgentMuxGuide, args: config.args, env: config.env, commandOverride: config.command,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.agentMuxNote === undefined ? {} : { agentMuxNote: input.agentMuxNote }),
      ...(input.agentMuxTask === undefined ? {} : { agentMuxTask: input.agentMuxTask }),
      ...(input.optionalContext === undefined ? {} : { optionalContext: input.optionalContext }),
      ...(input.nativeResumeSource === undefined ? {} : { nativeResumeSource: input.nativeResumeSource }),
      ...(input.launchOptions === undefined ? {} : { launchOptions: input.launchOptions }),
      ...(input.cols === undefined ? {} : { cols: input.cols }), ...(input.rows === undefined ? {} : { rows: input.rows })
    }, { intentDigest, executorRevision: input.executorRevision, ...(origin ? { origin } : {}), ...(input.threadId ? { threadId: input.threadId } : {}) })
  }
  readonly providers: AgentProviderRegistry
  private readonly recovery: AgentSessionRecoveryService
  private readonly kernel: CtxmuxRunAdapter
  private readonly controlSocketPath: string
  private readonly registry: AgentMuxAgentSessionRegistry
  private readonly deliveryAttempts: DeliveryAttemptStore
  private readonly store: AgentMuxAgentSessionStore
  /** Single-flight execution only; durable creation facts remain in the original Store. */
  private readonly activeCreations = new Map<string, {
    input: AgentMuxAgentCreateInput
    admitted: Parameters<AgentMuxClient['createAgentWithDeliveryAttempt']>[1]
    controller: AbortController
    pending: ReturnType<AgentMuxClient['createAgentWithDelivery']>
  }>()
  /** Only concurrent Provider reads are shared; every caller projects its own Core ownership. */
  private readonly nativeSessionCatalogReads = new WeakMap<AgentProvider, Map<string, Promise<Omit<AgentNativeSessionCatalog, 'capabilities'>>>>()
  private readonly messageQueue: DurableAgentMuxMessageQueue
  /** Only the original live caller context; credentials are never journaled. */
  private readonly inputWaitingContexts = new Map<string, {
    ref: AgentInputWaitRef; input: AgentMuxAgentPromptInput; producer: 'prompt' | 'message';
    authorAgentSessionId?: string; authority?: import('./prompt-submission.js').AgentPromptInputAuthority;
    controller: AbortController; runtimeWake: boolean; requested: boolean; active: boolean; sequence: number
  }>()
  private readonly inputWaitingRecipients = new Map<string, { pending: Promise<void>; again: boolean }>()
  private readonly inputConversationTails = new Map<string, Promise<import('./agent-input-conversation.js').AgentInputJournalCut>>()
  private readonly inputConversationRecovered = new Set<string>()
  private readonly inputConversationWrites = new Map<string, Promise<void>>()
  private inputWaitingDisposed = false
  private readonly inputWaitingUnsubscribe: () => void
  private readonly externalConversationAuthority: AgentExternalConversationAuthorityPort | undefined
  private readonly publisher = new AgentMuxClientEventPublisher()
  private messageReadUsed = false
  private messageEventReaders = 0
  private messageLegacyEventReaders = 0
  private readonly messageNotifications: AgentMuxMessageNotifications
  private readonly messageNotificationsUnsubscribe: () => void
  private messageObservationDisposed = false
  private messageObservation: ReturnType<typeof observeMessageJournal> | undefined
  private readonly acp: AgentMuxAcpBridge
  private readonly hookServer: AgentHookServer
  private readonly hookInstaller: AgentManagedHookInstaller
  private unsubscribeKernel: (() => void) | null = null
  private unsubscribeKernelErrors: (() => void) | null = null
  private unsubscribeConnectionLost: (() => void) | null = null
  private unsubscribeConnectionAvailable: (() => void) | null = null
  private reconnecting = false
  private reconnectGeneration = 0
  private reconnectController: AbortController | null = null
  private reconnectEndpoint: (CtxmuxEndpointObservation & { only: boolean }) | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private runtimeConnecting: Promise<void> | null = null
  private connecting: Promise<void> | null = null
  private connectRequest: Promise<void> | null = null
  private connectionEpoch = 0
  /** Only pre-dispatch preparation observations end with this Core connection. */
  private inputPreparationLifetime = new AbortController()
  private connected = false
  private connectionNeedsObservation = false
  /**
   * 跨成功幸存的抖动账（见 ctxmux-reconnect-budget.ts）。刻意**不复用** `connectionEpoch`：
   * 那个只在调用方主动 `disconnect()` 时自增，半死 daemon 的反复抖动一次都不会碰它。
   * 也刻意不上 wire：它是本进程对这条连接健康度的观察，不是任何 Session 的持久事实。
   */
  private reconnectFlaps = 0
  /** 连接最近一次变健康的时刻（首次 connect 成功或 restored）。缓刑期满即清 {@link reconnectFlaps}。 */
  private connectionHealthySince = 0
  private readonly runPids = new Map<string, number | null>()
  // Only pending snapshot readers retain removals. No durable terminal registry or completed-Run set.
  private readonly pendingRunSnapshots = new Map<string | null, Set<Set<string>>>()
  private readonly hookBindings = new Map<string, AgentHookBinding>()
  private readonly hookRestorations = new Map<string, Promise<void>>()
  private readonly hookIngressObservations = new Map<string, NonNullable<AgentMuxAgentSession['hookIngressObservation']> & {
    nativeTarget?: AgentNativeSessionHandle
  }>()
  /** One live observation per Session; never restored from a durable idle snapshot. */
  private readonly nativeCurrentActivities = new Map<string, {
    event: AgentNativeActivityEvent; runId: string; admissionId: string | undefined
    fact?: AgentCurrentActivity; invalidated?: boolean; conflicted?: boolean
  }>()
  private readonly pendingLifecycleBindings = new Map<string, AgentHookBinding>()
  private reopensDisposed = false
  private readonly agentInputCursors = new Map<string, number>()
  private readonly agentInputTails = new Map<string, {
    tail: Promise<void>
    renderObservations: Set<AgentInputObservation>
  }>()
  private readonly providerReads = new Set<AbortController>()
  private readonly conversationReadState = new ConversationReaderState()
  private readingDiagnosticSource: CoreReadingDiagnosticSource | undefined
  private readonly startupDiagnostics: CoreStartupDiagnosticJournal
  private originalReadingDiagnosticSource(): CoreReadingDiagnosticSource | undefined {
    try { return this.readingDiagnosticSource ??= new CoreReadingDiagnosticSource() } catch { return undefined }
  }
  /** Consumer-owned read-only resources; never occupy Provider page slots or Run lifecycle locks. */
  private readonly historyObservationControllers = new Map<string, Set<NativeHistoryObservationResource>>()
  private readonly historyObservationPool = new SessionHistoryObservationPool()
  private providerReadsDisposed = false
  private readonly nativeIdentityCaptures = new Map<string, { controller: AbortController; run: AgentMuxRunRef }>()
  private readonly nativeIdentityPending: Array<() => void> = []
  private nativeIdentityActive = 0
  // 「用户为这个 runId 发起过停止」这条**意图**事实的台账。与内核报的退出**结果**分居两处：控制面在
  // stop 路径写入意图，acceptKernelEvent 在退出事件里读它、合成 exitReason。一个 runId 只会退出一次，
  // 分类后即删，不留驻。裸集合足矣——意图是布尔（在场即「我们关的」），不需要携带别的。
  private readonly stopRequestedRuns = new Set<string>()
  private readonly agentStopFlights = new Map<string, {
    readers: number
    retired: boolean
    admission: Promise<{ session: AgentMuxAgentSession; reservation: AgentMuxLifecycleReservation; stopOperation: CtxmuxAdapterStopOperation }>
    retirement?: Promise<void>
  }>()
  // 「这个 runId 的进程已经终结」这条**观察结果**的台账，与上面那条**意图**台账分居两处、语义不同：
  // 意图是我们想不想关，这条是内核报没报它已经没了。「这个 run 再不会有 hook 事件」的权威终点有**两条**
  // 到达路径，故写入点也是两处，各对应一条路径：
  // - 实时事件流：acceptKernelEvent 收到 exited 或 interrupted。它见过停止意图，知道得最多。
  // - daemon 的 list() 快照：backfillEndedRuns。事件流在掉线期间根本不存在（且整份台账随断连清空），
  //   离线期发生的终结只有这一条路能知道。它只补空缺、绝不覆盖实时那处的答案——理由见该方法的注释。
  //
  // 值是那一刻分类出的退出原因（非 exited 的终结不参与分类，记 undefined）。之所以要**存**它而不是
  // 事后重算：分类要读停止意图，而意图在同一处被 delete 掉了（一个 runId 只退出一次，读完即弃），
  // 事后无从重建；而 daemon 的 list() 只报 code/signal，永远不知道那次退出是不是我们主动关的。
  // 于是 live 事件路径与 snapshot 重投影路径共用这一份记录，两条路对「退出为什么」给出同一个答案。
  //
  // 为什么不复用 runPids 判活：那是 pid 缓存，有十三个写入点（list/attach/replay/resume/…），把生命
  // 周期语义压到它身上，任何一处缓存维护的改动都会静默改变「算不算已终结」。也不逐条 hook 去问
  // kernel.status：PreToolUse/PostToolUse 是高频路径，每条加一次 daemon 往返换不到任何新事实。
  //
  // 一个 runId 只终结一次且此后永不复活，所以这里不逐条删——删了就等于把「已终结」这个事实忘掉，
  // 迟到的 hook 又能复活它。整份随断连清空（连接重建后会重新 list 出真相），与 stopRequestedRuns 同处。
  private readonly endedRuns = new Map<string, AgentMuxRunExitReason | undefined>()

  // 每个 run 的 turn 收尾台账：turn 已收尾之后到达的工具事件不许再改语义状态（判据与理由见
  // hook-turn-phase.ts，那里记着「为什么不是比 observedAt」）。
  //
  // 与 endedRuns 分开而不是并进去：那份记的是**进程**已死（此后一条 hook 都不收），这份记的是**当轮**
  // 已收尾（事件照收、时间轴照落，只是不再据此推断「它正在干活」）。两个概念压到一份台账上，任何一侧
  // 的语义改动都会静默改掉另一侧。
  //
  // 与 endedRuns 同处清空（断连后重新 list 出真相）。也不逐条删：一个 runId 的收尾状态只由
  // user-prompt-submit 重新打开，删掉等于把「已收尾」忘掉，迟到的工具事件又能把它点亮。
  private readonly hookNativeWitnesses = new Map<string, { candidate: string; handle?: AgentNativeSessionHandle; childSessionIds?: readonly string[]; candidates?: readonly Extract<AgentNativeSessionHandle, { kind: 'provider' }>[]; reason?: string }>()
  private readonly hookTurnPhases = new Map<string, HookTurnPhase>()
  private readonly nativeStatusSettlements = new Set<Promise<void>>()
  private readonly nativeStatusWatches = new Map<string, {
    key: string; controller: AbortController; observer?: { dispose(): void }; pending: Promise<void>
    recordId?: string; sequence?: number
  }>()
  private readonly terminalFrontendWatches = new Map<string, TerminalFrontendWatch>()
  private readonly screenEvidence: AgentScreenEvidenceStore
  private readonly promptSubmission: AgentPromptSubmissionCoordinator

  /**
   * 投影一条 run，退出原因**只从这一处**取。
   *
   * 十一个调用点都走这里，而「从 `endedRuns` 台账取值」这句话只写一遍。反过来做——让每个调用点自带
   * 一个 `exitReason` 实参——就等于把同一次取值手抄十一遍：漏抄一处，那条路上的退出原因静默退化成
   * 缺席，而 `exitReason` 是可选字段，tsc 对缺席一言不发（本仓已知形状：多处手抄的常量只有 tsc 守，
   * 而这里连 tsc 都守不住）。
   *
   * `has` 与取值分开判：台账里 `undefined` 是**有记录但当时不可分类**（interrupted 那种终结），与
   * 「压根没这条记录」不是一回事。都投影成字段缺席，但前者是已知的答案，后者是还没退出——把两者
   * 混成一次 `get() ?? fallback` 就再也分不开。
   */
  private projectRun(run: CtxmuxAdapterRun, agentSession?: AgentMuxAgentSession): AgentMuxRun {
    return projectRunWith(this.endedRuns.get(run.runId), run, agentSession)
  }

  constructor(options: AgentMuxClientOptions = {}) {
    this.externalConversationAuthority = options.externalConversationAuthority
    this.hostExecutorOwner = options.hostExecutorOwner
    this.creationAuthority = options.creationAuthority
    this.controlSocketPath = options.controlSocketPath ?? defaultAgentMuxControlSocketPath()
    if (!isAbsolute(this.controlSocketPath) || /[\0\r\n]/u.test(this.controlSocketPath)) {
      throw new AgentMuxError('Public owner socket must be an absolute local path.', 'INVALID_CONTROL_REQUEST')
    }
    this.providers = options.providers
      ? new AgentProviderRegistry(options.providers)
      : createDefaultAgentMuxPluginRegistry(options.plugins).providers
    this.store = options.store ?? new AgentMuxFileAgentSessionStore()
    const diagnosticInstance = mintObjectId()
    const diagnosticOwner = options.diagnosticOwner ?? { authority: { kind: 'core-startup-observer', id: diagnosticInstance, lifetime: 'instance' as const }, ownerInstanceId: diagnosticInstance }
    this.startupDiagnostics = new CoreStartupDiagnosticJournal(diagnosticOwner,
      diagnosticOwner.authority.lifetime === 'durable' && this.store instanceof AgentMuxFileAgentSessionStore
        ? join(dirname(this.store.path), 'startup-diagnostics') : undefined)
    this.deliveryAttempts = new DeliveryAttemptStore(join(this.store instanceof AgentMuxFileAgentSessionStore
      ? dirname(this.store.path) : defaultAgentMuxStateDirectory(), 'delivery-attempts'))
    // An implicit Session store is Runtime-local, not the durable message queue authority.
    const adoptedFileStore = this.store instanceof AgentMuxFileAgentSessionStore &&
      (options.store !== undefined || Boolean(process.env.AGENTMUX_AGENT_SESSION_STORE?.trim()))
      ? this.store.path : null
    this.messageQueue = new DurableAgentMuxMessageQueue(defaultAgentMuxMessageQueuePath(adoptedFileStore))
    // Own the listener before any first save; initial admission also schedules a
    // check, so restoration cannot be lost between saving and subscription.
    this.inputWaitingUnsubscribe = this.publisher.onStatusEvent(event => {
      if (event.type !== 'connection-state' || event.state !== 'restored' || this.inputWaitingDisposed) return
      const recipients = new Set([...this.inputWaitingContexts.values()].filter(value => value.runtimeWake)
        .map(value => value.ref.key.agentSessionId))
      for (const value of this.inputWaitingContexts.values()) if (value.runtimeWake) value.requested = true
      for (const recipient of recipients) void this.scheduleInputWaiting(recipient)
    })
    this.registry = new AgentMuxAgentSessionRegistry(this.store, (session, error) => {
      if (error) this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
        code: error.code,
        message: 'The original Session is readable, but its durable save is unconfirmed. The Agent and input are kept. Refresh this Session to retry the durable save.',
        evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } })
      else this.publishSession(session)
    })
    this.kernel = new CtxmuxRunAdapter()
    this.hookServer = new AgentHookServer(
      async (event, signal) => {
        await this.acceptHookEvent(event, signal)
        if (event.permissionCallback) {
          const session = this.registry.findByRun(runRef(event.runId)), pending = session?.pendingInteraction
          return { permissionCallbackAccepted: session?.agentSessionId === event.agentSessionId &&
            [pending?.request, ...(pending?.additionalRequests ?? [])].some(request =>
              request?.kind === 'permission' && request.permissionHook?.receiptId === event.receiptId) }
        }
      },
      undefined,
      failure => {
        const session = this.registry.findByRun(runRef(failure.runId ?? ''))
        if (!session || session.agentSessionId !== failure.agentSessionId) return
        this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
          code: failure.code,
          message: `Native Hook ${failure.receiptId} failed during ${failure.stage}; ${failure.accepted === false ? 'owner work did not start' : 'durable delivery is unconfirmed'}. The original Session, Run and terminal capability are kept. ${failure.code === 'HOOK_BODY_TOO_LARGE' || failure.code === 'INVALID_HOOK_ENVELOPE' ? 'Refresh native Session observation to read its original source.' : 'Retry the same observation receipt after backoff; refresh native Session observation if its sender has exited.'}${failure.message === undefined ? '' : ` Cause: ${failure.message}`}`,
          evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } })
      },
      (providerId, eventName) => this.providers.get(providerId).hook.permissionDecision?.eventName === eventName && eventName !== undefined,
      (agentSessionId, runId, receiptId, decided) => {
        void this.closePermissionHook(agentSessionId, runId, receiptId, decided).catch(() => {
          const session = this.registry.findByRun(runRef(runId))
          if (session) this.publishSession(session)
        })
      }
    )
    this.hookInstaller = options.hookInstaller
      ?? new AgentManagedHookInstaller(join(defaultCtxmuxStateDirectory(), 'hooks'))
    this.acp = new AgentMuxAcpBridge(
      {
        onEvent: async (agentSessionId, event, evidence) => {
          const session = this.registry.get(agentSessionId)
          // 与 acceptHookEvent 同一条判据、同一份台账：进程已终结的 run 不许再写语义状态、也不许再发状态
          // 事件。ACP 是喂状态的**第二条**入口，两条路对「进程已死还能不能被点亮」必须判得一样——只修
          // 一条会留下同形的第二个缺陷。今天没有 Provider 声明 acpStrategy: adapter，所以这条路上还看不
          // 到那个 bug；接上第一个 ACP Provider 的那天它就会原样复现，届时这里已经站着人了。
          if (this.endedRuns.has(session.run.runId)) return
          const observed = {
            ...evidence,
            run: { ...session.run }
          }
          const mutation = agentTimelineMutationFromAcpEvent(agentSessionId, event, observed)
          if (mutation) await this.persistAndPublishTimeline(mutation, observed, session.hostId)
          if (event.type === 'status' && event.state !== 'unknown') {
            await this.persistSemanticStatus(agentSessionId, session.run, {
              state: event.state,
              source: 'acp',
              observedAt: observed.observedAt,
              ...(event.detail === undefined ? {} : { detail: event.detail })
            })
          }
          this.publisher.publishAcp(agentSessionId, event, observed)
        },
        onNativeHandle: async (agentSessionId, handle) => {
          await this.updateNativeHandle(agentSessionId, handle)
        },
        onInteraction: async (request) => {
          const session = this.requireAgentSession(request.agentSessionId)
          const observedRequest = {
            ...request,
            evidence: { ...request.evidence, run: { ...session.run } }
          }
          const next = await this.persistPendingInteraction(observedRequest)
          this.publisher.publishInteraction(observedRequest)
          this.publishSession(next)
        },
        onInteractionSettled: async (request) => {
          const session = this.requireAgentSession(request.agentSessionId)
          const next = await this.clearPendingInteraction(session, request.id)
          this.publishSession(next)
        }
      }
    )
    this.screenEvidence = new AgentScreenEvidenceStore({
      kernel: this.kernel,
      providers: this.providers
    })
    this.promptSubmission = new AgentPromptSubmissionCoordinator({
      store: this.store,
      kernel: this.kernel,
      providers: this.providers,
      registry: this.registry,
      publisher: this.publisher,
      agentInputCursors: this.agentInputCursors,
      screenEvidence: this.screenEvidence,
      requireAgentSession: (agentSessionId) => this.requireAgentSession(agentSessionId),
      providerArgs: (session, run) => this.providerLaunch(session, run).args,
      assertUncontrolledInput: async key => {
        if (await this.messageQueue.inspectInput({ key })) throw new AgentMuxError(
          'The original controlled input requires its original journal gate and intent.', 'AGENT_PROMPT_OPERATION_CONFLICT')
      },
      withUncontrolledInputClaim: (key, claim, notificationId) => this.messageQueue.withUncontrolledInputClaim(key, claim, async () => Boolean(await this.inspectAgentPromptSubmission(key)), notificationId),
      onInputAccepted: (key, at) => this.recordAcceptedInput(key, at),
      assertAgentRun: (session, run) => { this.assertAgentRun(session, run) },
      updateExactAgentSession: (agentSessionId, expectedRun, update, futureIntentId, author) =>
        this.updateExactAgentSession(agentSessionId, expectedRun, update, futureIntentId, author)
    })
    const owner = this
    this.recovery = new AgentSessionRecoveryService({
      sessions: { store: this.store, registry: this.registry, resolveRawAgentSession: (...args) => this.resolveRawAgentSession(...args), currentStoredAgentSession: (...args) => this.currentStoredAgentSession(...args), updateExactAgentSession: (...args) => this.updateExactAgentSession(...args), requireAgentSession: (...args) => this.requireAgentSession(...args), retainUnconfirmedLifecycle: (...args) => this.retainUnconfirmedLifecycle(...args) },
      runtime: {
        kernel: this.kernel,
        assertAgentRun: (...args) => this.assertAgentRun(...args),
        requireCurrentAgentRun: (...args) => this.requireCurrentAgentRun(...args),
        retireUncommittedRun: (...args) => this.retireUncommittedRun(...args),
        recordRunTransition: (previous, run) => {
          if (previous) this.runPids.delete(previous.runId)
          this.runPids.set(run.runId, run.pid)
        },
        requestStop: async operation => {
          this.stopRequestedRuns.add(operation.runId)
          await this.kernel.stop(operation)
        }
      },
      providers: { providers: this.providers, probeAgent: (...args) => this.probeAgent(...args), providerLaunch: (...args) => this.providerLaunch(...args) },
      executors: { hostExecutorOwner: this.hostExecutorOwner, sessionExecutorOptions: (...args) => this.sessionExecutorOptions(...args) },
      hooks: {
        hookServer: this.hookServer,
        hasActiveBinding: runId => this.hookBindings.has(runId),
        activeBinding: runId => this.hookBindings.get(runId),
        pendingBinding: operationId => this.pendingLifecycleBindings.get(operationId),
        retainBinding: (operationId, binding) => { this.pendingLifecycleBindings.set(operationId, binding) },
        activateBinding: (runId, binding, operationId) => {
          this.hookBindings.set(runId, binding)
          if (operationId !== undefined) this.pendingLifecycleBindings.delete(operationId)
        },
        closeRunBinding: async (runId, binding = this.hookBindings.get(runId)) => {
          await binding?.close()
          if (this.hookBindings.get(runId) === binding) this.hookBindings.delete(runId)
        },
        releaseUnusedBinding: async (binding, operationId, retainPending) => {
          if (![...this.hookBindings.values()].includes(binding) &&
            !(retainPending && this.pendingLifecycleBindings.get(operationId) === binding)) await binding.close()
        },
        forgetPendingBinding: operationId => { this.pendingLifecycleBindings.delete(operationId) },
        ensureManagedHooks: (...args) => this.ensureManagedHooks(...args),
        requireHookIngressOwner: (...args) => this.requireHookIngressOwner(...args),
        settleHookRestore: (...args) => this.settleHookRestore(...args),
        observeHookRestoreFailure: (...args) => this.observeHookRestoreFailure(...args),
        agentEnvironment: (...args) => this.agentEnvironment(...args)
      },
      input: { continueInitialInput: (...args) => this.continueInitialInput(...args), inspectAgentPromptSubmission: (...args) => this.inspectAgentPromptSubmission(...args), submitAgentPrompt: (...args) => this.submitAgentPrompt(...args), deliverPostLaunchPrompt: (...args) => this.deliverPostLaunchPrompt(...args), recordAcceptedInput: (...args) => this.recordAcceptedInput(...args), recordPromptMessageAfterSideEffect: (...args) => this.recordPromptMessageAfterSideEffect(...args), readCapturedPromptProducer: (...args) => this.readCapturedPromptProducer(...args), resolveMessageAuthor: (...args) => this.resolveMessageAuthor(...args) },
      terminal: {
        ensureTerminalFrontendObservation: (...args) => this.ensureTerminalFrontendObservation(...args),
        readFrontendObservation: agentSessionId => this.terminalFrontendWatches.get(agentSessionId)?.frontend,
        ensureTerminalHandshakeOrDegrade: (...args) => this.ensureTerminalHandshakeOrDegrade(...args),
        screenEvidence: this.screenEvidence,
        queueNativeIdentityCapture: (...args) => this.queueNativeIdentityCapture(...args)
      },
      events: { publisher: this.publisher, publishSession: (...args) => this.publishSession(...args), publishCurrentRunState: (...args) => this.publishCurrentRunState(...args), projectSession: (...args) => this.projectSession(...args), projectRun: (...args) => this.projectRun(...args), publishExecutableCheckFailure: (...args) => this.publishExecutableCheckFailure(...args) },
      observations: { registerProviderRead: controller => {
        this.providerReads.add(controller)
        return () => { this.providerReads.delete(controller) }
      } },
      connection: { get connectionEpoch() { return owner.connectionEpoch }, requireConnected: (...args) => this.requireConnected(...args), assertConnectionEpoch: (...args) => this.assertConnectionEpoch(...args) }
    })
    this.messageNotifications = new AgentMuxMessageNotifications({ queue: this.messageQueue,
      connected: () => this.connected && this.kernel.isConnected(),
      read: async id => {
        if (!this.registry.has(id)) return null
        const current = await this.registry.refresh(id, this.registry.get(id).run)
        const run = await this.requireCurrentAgentRun(current)
        const session = this.projectSession(current)
        const provider = this.providers.get(session.providerId)
        const observation = { session, inputByte: run.acceptedInputBytes }
        if (!provider.prepareNativeInput) return { ...observation, unavailable: new AgentMuxError(
          'This Provider has not contributed the queue adapter required for automatic idle-only Inbox notifications.',
          'AGENT_NATIVE_INPUT_UNAVAILABLE') }
        if (agentTurnCompletionIdentity(session)) return observation
        if (session.semanticStatus?.state === 'working' || session.currentActivity?.state === 'active') {
          return observation
        }
        try {
          const evidence = await provider.readPromptExecutionEvidence?.(this.providerNativeContext(session, run))
          if (evidence?.state === 'idle') return { ...observation, nativeIdle: evidence }
          if (!evidence) return { ...observation, unavailable: new AgentMuxError('The Provider initial idle opportunity is unconfirmed. Inspect the original Session or read its retained Inbox.', 'AGENT_TURN_END_UNCONFIRMED') }
          return observation
        } catch (error) { return { ...observation, unavailable: error } }
      },
      submit: notice => this.submitMessageNotification(notice),
      inputAbsent: async key => !await this.inspectAgentPromptSubmission(key),
      unavailable: (agentSessionId, error, run) => this.publisher.publish({ type: 'agent-error',
        ...(agentSessionId ? { agentSessionId } : {}), code: 'A2A_NOTIFICATION_UNCONFIRMED',
        message: `Inbox notification is unconfirmed. Original messages and healthy manual input are retained; read the original MID or explicitly notify it. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', observedAt: Date.now(), ...(run ? { run } : {}) } })
    })
    this.messageNotificationsUnsubscribe = this.publisher.onStatusEvent(event => {
      if (event.type === 'agent-session') this.messageNotifications.changed(event.session.agentSessionId)
      else if (event.type === 'connection-state' && event.state === 'restored') void this.messageNotifications.restore()
    })
  }

  async connect(): Promise<void> {
    if (this.connectRequest) return await this.connectRequest
    const request = this.connectRequested()
    this.connectRequest = request
    try { await request }
    finally { if (this.connectRequest === request) this.connectRequest = null }
  }

  private async connectRequested(): Promise<void> {
    const recovering = this.reconnectController !== null
    const endpoint = this.reconnectEndpoint
    const observationNeeded = this.connectionNeedsObservation || !this.connected || !this.kernel.isConnected()
    this.cancelReconnect()
    const epoch = this.connectionEpoch
    const generation = this.reconnectGeneration
    try {
      if (endpoint) {
        await this.kernel.connect({ refreshEndpointForRun: endpoint.runId })
        this.assertConnectionEpoch(epoch)
        if (endpoint.only) return
      }
      await this.connectOnce(epoch)
      this.assertConnectionEpoch(epoch)
      if (recovering) await this.finishReconnect(epoch, generation)
      else if (observationNeeded && !this.connectionNeedsObservation) this.publisher.publish({ type: 'connection-state', state: 'restored',
        observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' },
        evidence: { source: 'run-process', observedAt: Date.now() } })
    } catch (error) {
      if (recovering && epoch === this.connectionEpoch && generation === this.reconnectGeneration) this.scheduleSlowReconnect(epoch, !endpoint?.only, endpoint)
      throw error
    }
  }

  private async connectOnce(epoch: number): Promise<void> {
    if (this.connecting) return await this.connecting
    if (this.connected && this.kernel.isConnected() && !this.connectionNeedsObservation) return
    if (!this.kernel.isConnected()) this.connected = false
    const attempt = this.open(epoch)
    this.connecting = attempt
    try { await attempt }
    finally { if (this.connecting === attempt) this.connecting = null }
  }

  /** Confirm the original Runtime transport without waiting for Session or semantic observation. */
  async connectRuntime(): Promise<void> {
    if (this.connected && this.kernel.isConnected()) return
    if (this.runtimeConnecting) return await this.runtimeConnecting
    const epoch = this.connectionEpoch
    const request = this.openRuntime(epoch)
    this.runtimeConnecting = request
    try { await request }
    finally { if (this.runtimeConnecting === request) this.runtimeConnecting = null }
  }

  private async openRuntime(epoch: number): Promise<void> {
    try {
      this.unsubscribeConnectionAvailable?.()
      this.unsubscribeConnectionAvailable = this.kernel.onConnectionAvailable(() => {
        // Readiness may settle while an earlier caller's observation is still unwinding.
        // Join that exact attempt, then observe the same Runtime from the current epoch.
        const previous = this.connectRequest ?? this.runtimeConnecting ?? Promise.resolve()
        void previous.catch(() => {}).then(async () => {
          if (epoch !== this.connectionEpoch || this.connected && this.kernel.isConnected() && !this.connectionNeedsObservation) return
          const recovery = this.reconnectController, generation = this.reconnectGeneration
          try {
            // Dependency completion is observation, not an explicit Retry intent.
            // Join the original attempt without cancelling its fast/slow recovery lane.
            await this.connectOnce(epoch)
            if (recovery && this.reconnectController === recovery) await this.finishReconnect(epoch, generation)
            else if (!recovery && epoch === this.connectionEpoch && !this.connectionNeedsObservation) this.publisher.publish({ type: 'connection-state', state: 'restored',
              observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' }, evidence: { source: 'run-process', observedAt: Date.now() } })
          } catch { /* The original attempt/lane retains its scoped failure and next observation. */ }
        })
      })
      if (!this.reconnectController && !this.kernel.isConnected()) this.publisher.publish({ type: 'connection-state', state: 'retrying',
        observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' },
        diagnostic: { code: 'CTXMUX_CONNECTION_OBSERVATION_PENDING', message: 'The original Native connection is not yet confirmed. Durable identities remain readable; Native operations keep their original authority checks.' },
        evidence: { source: 'run-process', observedAt: Date.now() } })
      await this.kernel.connect()
      this.assertConnectionEpoch(epoch)
      this.unsubscribeKernel?.()
      this.unsubscribeKernelErrors?.()
      this.unsubscribeConnectionLost?.()
      this.unsubscribeKernel = this.kernel.onEvent((event) => this.acceptKernelEvent(event))
      this.unsubscribeKernelErrors = this.kernel.onError((error, runId) => {
        const agentSession = runId ? this.registry.findByRun(runRef(runId)) : undefined
        this.publisher.publish({
          type: 'agent-error',
          ...(agentSession ? { agentSessionId: agentSession.agentSessionId } : {}),
          code: error.code,
          message: error.message,
          evidence: {
            source: 'run-process',
            observedAt: Date.now(),
            ...(runId ? { run: runRef(runId) } : {})
          }
        })
      })
      this.unsubscribeConnectionLost = this.kernel.onConnectionLost(() => this.handleConnectionLost(epoch))
      this.assertConnectionEpoch(epoch)
      if (!this.kernel.isConnected()) throw new AgentMuxError('Runtime connection changed during admission.', 'CTXMUX_DISCONNECTED')
      this.connected = true
      this.connectionNeedsObservation = true
      // Availability comes from the transport. Completion of recovery is still observed separately.
      this.publisher.publish({ type: 'connection-state', state: 'restored',
      observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' },
        diagnostic: { code: 'CTXMUX_CONNECTION_OBSERVATION_PENDING',
          message: 'The original Runtime connection is available. Session recovery observation remains unconfirmed; original terminal input and output remain available. Retry Session observation on this endpoint.' },
        evidence: { source: 'run-process', observedAt: Date.now() } })
    } catch (error) {
      if (epoch === this.connectionEpoch && !this.kernel.isConnected()) this.connected = false
      throw error
    }
  }

  private async open(epoch: number): Promise<void> {
    let phase = 'Runtime connection'
    let auxiliaryObservationIncomplete = false
    const observing = (step: string): void => {
      phase = step
      this.publisher.publish({ type: 'connection-state', state: 'restored',
        observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' },
        diagnostic: { code: 'CTXMUX_CONNECTION_OBSERVATION_PENDING',
          message: `${step} is not yet confirmed. The original Native transport and exact-Run capabilities remain available; durable metadata is readable.` },
        evidence: { source: 'run-process', observedAt: Date.now() } })
    }
    try {
      await this.connectRuntime()
      this.assertConnectionEpoch(epoch)
      observing('lifecycle recovery')
      await this.recoverStaleLifecycles()
      this.assertConnectionEpoch(epoch)
      observing('Session store observation')
      await this.registry.load('local', () => this.assertConnectionEpoch(epoch))
      this.assertConnectionEpoch(epoch)
      observing('Run observation')
      const runs = await this.withRunSnapshot(null, () => this.kernel.list(), (snapshot, wasRemoved) => {
        this.assertConnectionEpoch(epoch)
        const current = snapshot.filter(run => !wasRemoved(run.runId))
        this.backfillEndedRuns(current)
        for (const run of current) this.runPids.set(run.runId, run.pid)
        return current
      })
      // list() 补齐 App 不在运行期间的终局；刚装好的事件订阅只提供此后的新变化。
      this.assertConnectionEpoch(epoch)
      this.synchronizeAgentRuns(runs)
      observing('Hook restoration')
      await this.tryRestoreHookIngress(runs)
      this.assertConnectionEpoch(epoch)
      auxiliaryObservationIncomplete = this.registry.list().some(session => this.currentHookIngressObservation(session) !== undefined)
      // Each optional probe retains its exact Session. Shared transport, epoch and
      // Store/identity invariants still fail this observation; auxiliary errors do not.
      observing('terminal capability observation')
      const handshakeErrors: unknown[] = []
      await Promise.all(this.registry.list().map(async (session) => {
        const run = runs.find((candidate) => candidate.runId === session.run.runId)
        if (run?.state.type !== 'running') return
        try {
          await this.ensureTerminalHandshakeOrDegrade(session, run)
        } catch (error) {
          if (
            error instanceof AgentMuxError &&
            error.code === AGENT_TERMINAL_HANDSHAKE_FAILED
          ) {
            this.assertConnectionEpoch(epoch)
            // A Run that vanished during this Session's handshake is a real failure for this exact
            // Agent, but it is not a failure of the shared CtxMux connection. Keep the other Sessions
            // attachable and make the scoped failure visible to the renderer.
            this.publisher.publish({
              type: 'agent-error',
              agentSessionId: session.agentSessionId,
              code: error.code,
              message: error.message,
              evidence: {
                source: 'run-process',
                observedAt: Date.now(),
                run: { ...session.run }
              }
            })
            return
          }
          this.assertConnectionEpoch(epoch)
          if (!this.kernel.isConnected() || error instanceof AgentMuxError &&
            ['INVALID_AGENT_SESSION_STORE', 'AGENT_SESSION_IDENTITY_CONFLICT'].includes(error.code)) {
            handshakeErrors.push(error)
            return
          }
          auxiliaryObservationIncomplete = true
          this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
            code: error instanceof AgentMuxError ? error.code : 'AGENT_TERMINAL_OBSERVATION_UNCONFIRMED',
            message: `Terminal capability observation is unconfirmed. ${error instanceof Error ? error.message : String(error)}. The original Run and exact-Run capabilities remain available; inspect this Session to retry observation.`,
            evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } })
        }
      }))
      this.assertConnectionEpoch(epoch)
      if (handshakeErrors.length > 0) throw handshakeErrors[0]
      observing('pending interaction recovery')
      await this.recoverPendingInteractionResponses(runs)
      this.assertConnectionEpoch(epoch)
      this.connected = true
      // Native status is semantic evidence, independent of terminal Attachment/PTY traffic.
      // Each contribution owns one exact retained source and reads only its changed bytes.
      observing('native status observation')
      await Promise.all(this.registry.list().filter(session => runs.some(run =>
        run.runId === session.run.runId && run.state.type === 'running')).map(async session => {
        if (!await this.ensureNativeStatusObservation(session)) auxiliaryObservationIncomplete = true
      }))
      // 缓刑期的起点。写在这里而不是只写在 `restored` 那侧，是因为首次 connect 也是「连接变健康」——
      // 少了这一句，`connectionHealthySince` 会停在 0，于是第一次掉线时 `now - 0` 必然超过缓刑期、
      // 账被无条件清零，跨成功的界永远攒不起来（即：这道界会变成死代码）。
      this.assertConnectionEpoch(epoch)
      if (!this.kernel.isConnected()) throw new AgentMuxError('Connection changed during recovery observation.', 'CTXMUX_DISCONNECTED')
      this.connectionNeedsObservation = auxiliaryObservationIncomplete
      this.connectionHealthySince = Date.now()
      void this.messageNotifications.restore()
      this.recovery.restore(this.registry.list())
      for (const session of this.registry.list()) {
        if (runs.some(run => run.runId === session.run.runId && run.state.type === 'running')) {
          this.queueNativeIdentityCapture(session)
        }
      }
      if (auxiliaryObservationIncomplete) {
        this.publisher.publish({ type: 'connection-state', state: 'restored',
          observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' },
          diagnostic: { code: 'CTXMUX_CONNECTION_OBSERVATION_UNCONFIRMED',
            message: 'The Runtime is available. Some exact Session observations remain unconfirmed; original Run capabilities remain available. Inspect the affected Session or retry observation on this endpoint.' },
          evidence: { source: 'agentmux', observedAt: Date.now() } })
        if (!this.reconnectController) this.scheduleSlowReconnect(epoch, false)
      }
    } catch (error) {
      if (epoch !== this.connectionEpoch) throw error
      if (this.kernel.isConnected()) {
        this.connected = true
        this.connectionNeedsObservation = true
        this.publisher.publish({ type: 'agent-error', code: 'CTXMUX_CONNECTION_OBSERVATION_FAILED',
          message: `${phase} failed: ${error instanceof Error ? error.message : String(error)}. The confirmed Runtime connection and original capabilities were retained; observation will retry.`,
          evidence: { source: 'agentmux', observedAt: Date.now() } })
        this.publisher.publish({ type: 'connection-state', state: 'restored',
          observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' },
          diagnostic: { code: 'CTXMUX_CONNECTION_OBSERVATION_FAILED',
            message: `${phase} failed: ${error instanceof Error ? error.message : String(error)}. Original terminal capabilities remain available; retry Session observation on this endpoint.` },
          evidence: { source: 'agentmux', observedAt: Date.now() } })
        if (!this.reconnectController) this.scheduleSlowReconnect(epoch, false)
      } else {
        this.connected = false
        this.kernel.resetConnection()
        if (!this.reconnectController) {
          this.publisher.publish({ type: 'connection-state', state: 'retrying',
            observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' },
            diagnostic: { code: error instanceof AgentMuxError ? error.code : 'CTXMUX_CONNECTION_UNCONFIRMED',
              message: `${phase} is unconfirmed: ${error instanceof Error ? error.message : String(error)}. The original semantic owner and durable identities remain available; the same Native observation will continue.` },
            evidence: { source: 'run-process', observedAt: Date.now() } })
          this.scheduleSlowReconnect(epoch, false)
        }
      }
      throw error
    }
  }

  /** A lost observation invalidates screen evidence, while original Runs and Sessions remain owned by the Runtime. */
  private handleConnectionLost(epoch: number): void {
    if (epoch !== this.connectionEpoch) return
    if (this.reconnecting && !this.connected) return
    this.cancelReconnect()
    epoch = ++this.connectionEpoch
    this.cancelInputPreparationObservations()
    this.runtimeConnecting = null
    this.connecting = null
    this.connectRequest = null
    this.connectionNeedsObservation = false
    const now = Date.now()
    // 连续健康满缓刑期 → 清账。判据是「健康了多久」而非「刚刚 restored」：restored 恰恰是抖动那一刻
    // 发生的事，拿它清账等于永远清得掉，这道界就成了死代码。
    if (shouldClearFlapLedger(this.connectionHealthySince, now)) this.reconnectFlaps = 0
    const verdict = judgeReconnectFlap({ flapCount: this.reconnectFlaps })
    this.reconnectFlaps = verdict.flapCount
    this.connected = false
    for (const runId of this.runPids.keys()) {
      const session = this.registry.findByRun(runRef(runId))
      if (session && !this.endedRuns.has(runId)) void this.persistActivityBoundary(session, 'lost', now).catch(error => {
        this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
          code: 'CTXMUX_RECONNECT_ACCOUNTING_FAILED', message: `Connection loss accounting failed: ${error instanceof Error ? error.message : String(error)}. Original Session and Runtime recovery remain available.`,
          evidence: { source: 'agentmux', observedAt: now, run: { runId } } })
      })
    }
    this.cancelProviderReads()
    this.cancelNativeIdentityCaptures()
    // 线断了 ⇒ 一切**长命的屏幕观察**当场失效。这不是卫生，是可观测的行为改变，也是 #628 的关键一环：
    //
    // 掉线时，`observeOutput` 的排空循环把错误交给 adapter 那个**全局** errorListener，而不是交给某次观察
    // 自己的 listener。于是屏幕证据永远不会 `fail()`，挂在它上面那次 `wait()` 也就永不 settle。同时
    // `AgentScreenEvidenceStore.ensure()` 复用旧 entry 的条件是 `runId 相同 && !evidence.failed`——一具
    // **没被标记 failed 的死证据**恰好满足它。所以重连时握手路径那次重挂（open() → ensureTerminalHandshake
    // → observeReadiness）会重新挂到同一具尸体上，照旧永等；readiness 卡在 pending，此后每条 prompt 被
    // AGENT_PROMPT_NOT_READY 拒掉，且没有任何出路。
    //
    // 在这里显式作废，两件事同时发生：挂着的 wait 立刻以 AGENT_PROMPT_READINESS_CANCELLED 结束（dispose()
    // → notify() → inspect() 走 `this.disposed` 那条出口），而下一次 ensure() 因为 entry 已从表里删掉必须
    // 重建。设计 SSOT 写的就是这条：docs/design/agentmux-desktop-interaction.md「失效（resize、重连、gap）
    // 时重建」——重连与 resize、gap 同类。
    //
    // 放在 give-up 判决**之前**（即两条出口共用）：连接判死时同样要作废，否则用户手动 Resume 时依然会
    // 撞上那具尸体。
    //
    // 这两行各买一件事，谁都不是另一个的简写（都由变异实测分开钉住，见 test/client-connection-lost.test.ts
    // 的 #628 那一组）：
    //   `discardAll()`  —— 结束挂着的 wait（dispose → notify → inspect 走 disposed 出口）并强制下一次
    //                      ensure() 重建。删掉它：那条观察永远挂着，且重挂会复用尸体。
    //   `cancelAllReadiness()` —— 清 `readinessCancels`。删掉它：`observeReadiness` 的 .catch 撞
    //                      CANCELLED 会提前 return 而不删表项，于是那条闭包连着它的 AbortController
    //                      永久留着（每次掉线泄一条）。
    this.promptSubmission.cancelAllReadiness()
    this.screenEvidence.discardAll()
    if (verdict.kind === 'give-up') {
      this.scheduleSlowReconnect(epoch)
      return
    }
    this.reconnectController = new AbortController()
    this.reconnecting = true
    this.publisher.publish({
      type: 'connection-state',
      state: 'lost',
      observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' },
      evidence: { source: 'run-process', observedAt: now }
    })
    void this.reconnectLoop(epoch)
  }

  private async reconnectLoop(epoch: number): Promise<void> {
    const controller = this.reconnectController!
    const generation = this.reconnectGeneration
    const endpointOnly = this.reconnectEndpoint?.only === true
    const result = await runBoundedReconnect({
      signal: controller.signal,
      attempt: () => this.reconnectAttempt(epoch, controller.signal, endpointOnly),
      sleep: (ms) => this.reconnectSleep(ms, controller.signal)
    })
    if (controller.signal.aborted || epoch !== this.connectionEpoch) return
    if (result.kind === 'reconnected') {
      if (endpointOnly) this.finishEndpointReconnect(epoch, generation)
      else await this.finishReconnect(epoch, generation)
    } else if (result.kind === 'exhausted') this.scheduleSlowReconnect(epoch, !endpointOnly)
  }

  private async reconnectAttempt(epoch: number, signal: AbortSignal, endpointOnly: boolean): Promise<void> {
    const endpoint = this.reconnectEndpoint
    if (endpoint) {
      await this.kernel.reobserveConnection(endpoint.runId, signal)
      if (!endpointOnly && this.reconnectEndpoint === endpoint) this.reconnectEndpoint = undefined
    }
    if (!endpointOnly) await this.connectOnce(epoch)
  }

  private observeRuntimeEndpoint(epoch: number, observation: CtxmuxEndpointObservation): void {
    if (epoch !== this.connectionEpoch) return
    this.reconnectEndpoint = { ...observation, only: this.reconnectController ? this.reconnectEndpoint?.only ?? false : true }
    if (this.reconnectController) return
    this.reconnectController = new AbortController()
    this.reconnecting = true
    void this.reconnectLoop(epoch)
  }

  private finishEndpointReconnect(epoch: number, generation: number): void {
    if (epoch !== this.connectionEpoch || generation !== this.reconnectGeneration) return
    this.cancelReconnect()
  }

  private async finishReconnect(epoch: number, generation: number): Promise<void> {
    const current = (): boolean => epoch === this.connectionEpoch && generation === this.reconnectGeneration
    if (!current()) return
    try {
      const endpoint = this.reconnectEndpoint
      if (endpoint) {
        await this.kernel.reobserveConnection(endpoint.runId, this.reconnectController?.signal)
        if (!current()) return
        if (this.reconnectEndpoint === endpoint) this.reconnectEndpoint = undefined
      }
      await this.republishLiveRunState(current)
    } catch (error) {
      if (!current()) return
      this.publisher.publish({ type: 'agent-error', code: 'CTXMUX_RECONNECT_OBSERVATION_FAILED',
        message: `The Runtime connection returned, but Run observation failed: ${error instanceof Error ? error.message : String(error)}. Existing capabilities and identities were retained; observation will retry.`,
        evidence: { source: 'agentmux', observedAt: Date.now() } })
      this.scheduleSlowReconnect(epoch, false)
      return
    }
    if (!current()) return
    if (!this.connected || !this.kernel.isConnected()) { this.scheduleSlowReconnect(epoch); return }
    const restoredAt = Date.now()
    for (const runId of this.runPids.keys()) {
      const session = this.registry.findByRun(runRef(runId))
      if (session && !this.endedRuns.has(runId)) {
        try { await this.persistActivityBoundary(session, 'restored', restoredAt) }
        catch (error) {
          if (!current()) return
          this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
            code: 'CTXMUX_RECONNECT_ACCOUNTING_FAILED', message: `The Runtime connection returned, but recovery accounting failed: ${error instanceof Error ? error.message : String(error)}. The original Session and input remain available.`,
            evidence: { source: 'agentmux', observedAt: restoredAt, run: { runId } } })
        }
        if (!current()) return
      }
    }
    if (!current() || !this.connected || !this.kernel.isConnected()) return
    if (this.connectionNeedsObservation) { this.scheduleSlowReconnect(epoch, false); return }
    this.cancelReconnect()
    this.publisher.publish({ type: 'connection-state', state: 'restored',
      observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' },
      evidence: { source: 'run-process', observedAt: restoredAt } })
  }

  /** One transport attempt per interval after the fast window, without repeating whole fast windows or UI notices. */
  private scheduleSlowReconnect(epoch: number, notify = true, endpoint = this.reconnectEndpoint): void {
    this.cancelReconnect()
    if (epoch !== this.connectionEpoch) return
    const controller = new AbortController()
    this.reconnectController = controller
    this.reconnectEndpoint = endpoint
    this.reconnecting = true
    if (notify) this.publisher.publish({ type: 'connection-state', state: 'retrying',
      observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' },
      evidence: { source: 'run-process', observedAt: Date.now() } })
    const generation = this.reconnectGeneration
    const schedule = (): void => {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (controller.signal.aborted || epoch !== this.connectionEpoch) return
        const endpointOnly = endpoint?.only === true
        const attempt = this.reconnectAttempt(epoch, controller.signal, endpointOnly)
        void attempt.then(async () => {
          if (!controller.signal.aborted && epoch === this.connectionEpoch) {
            if (endpointOnly) this.finishEndpointReconnect(epoch, generation)
            else await this.finishReconnect(epoch, generation)
          }
        }, () => {
          if (!controller.signal.aborted && epoch === this.connectionEpoch) schedule()
        })
      }, 30_000)
      this.reconnectTimer.unref?.()
    }
    schedule()
  }

  private cancelReconnect(): void {
    this.reconnectGeneration += 1
    this.reconnectController?.abort()
    this.reconnectController = null
    this.reconnectEndpoint = undefined
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.reconnecting = false
  }

  protected reconnectSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      signal?.addEventListener('abort', done, { once: true })
      if (signal?.aborted) done()
    })
  }

  /**
   * 重连成功后，按 daemon 的权威 list() 把每个 run 的当前状态重新发出去。
   *
   * 为什么必须做：渲染端在掉线时把 Agent 置成了 `disconnected`。重连本身不改那个状态——它只证明我们
   * 又能跟 daemon 说话了。真相要从 daemon 重新取：掉线期间某个 run 可能已经退出，那它此刻该收到一条
   * `exited`（经 acceptKernelEvent 合成 exitReason），而不是继续挂在 `disconnected`；还活着的 run 则
   * 收到一条 `running` 的 process-state，把 `disconnected` 洗回真相。少了这一步，重连后一屏 Agent 会
   * 永远停在「已断开」——重连等于没连。
   */
  private async republishLiveRunState(isCurrent: () => boolean = () => true): Promise<void> {
    await this.withRunSnapshot(null, () => this.kernel.list(), async (runs, wasRemoved) => {
      if (!isCurrent()) return
      this.backfillEndedRuns(runs.filter(run => !wasRemoved(run.runId)))
      for (const run of runs) {
        if (!isCurrent()) return
        if (wasRemoved(run.runId)) continue
        this.runPids.set(run.runId, run.pid)
        const agentSession = this.registry.findByRun(runRef(run.runId))
        // 掉线时 markConnectionLost 拆掉了每个 run 的字节泵（attachment.close + attachments.clear）；open()
        // 只重挂了 kernel 事件订阅，没重建泵。少了这一步，重连后一屏 Agent 拿到的是「进程活着、状态又被
        // republish 成 running、恢复横幅消失，可屏幕永远沉默」的终端——本任务的核心缺陷。这里为每个仍在跑、
        // 且有 Agent Session 的 run 重建 attachment，从这个进程已发布的精确 Run 边界续上。
        if (run.state.type === 'running' && agentSession && !this.kernel.hasAttachment(run.runId)) {
          // 重建失败时**不再** republish 成 running。上面那条 agent-error 刚把这个 Session 标成 error，
          // 紧跟一条 running 会把它洗回去：两条事件的 observedAt 都来自同一次 Date.now()，而渲染端
          // reducer 的新鲜度判据是 `>=`（同刻也算新），`run-process` 又不在它的豁免来源里（只豁免
          // native-hook / acp）。于是用户看到的是恢复横幅消失、状态正常、输入框可写，而屏幕永远沉默——
          // 正是这段代码要修的那个缺陷，在它自己的失败分支上原样复活。进程确实还活着，但这一屏的
          // 「running」说的是「你能看到它的输出」，那一点此刻不成立，报 error 才是诚实的。
          const resumed = await this.resumeLiveAttachment(agentSession.agentSessionId)
          if (!isCurrent()) return
          if (resumed === 'dead') {
            // 放行是对的（进程还活着，输入照常送达 Agent——第 2 类），但放行必须配告知：上面那条 agent-error
            // 会被后续会话快照的 `>=` 洗白，且它只在 Activity 视图里短暂存在。落一条**可持久**的降级事实，
            // 说清「输出通道没了、进程没死」，渲染端据此长出一条「输出可能没在显示，把这块 pane 在
            // Activity/Terminal 之间切一下即可重新附着」的服务窗——它挺过视图切换与快照刷新，直到一次
            // 成功的 reattach 就地撤下它（见 attachAgentRun）。
            //
            // 那句文案刻意不点名 Resume：这条降级只在进程还在跑时产生，而 Resume 对 running 的 Run 判出
            // `reattachable` 直接返回投影，不碰 attach（实跑验证过 attach 调用数为 0）。详见
            // clearOutputChannel 的注释与 service-window-notice.ts。
            await this.publishOutputChannelSevered(agentSession)
            continue
          }
          // 截断这一档不能靠跳过 republish：流是活的，这个 run 确实该是 running。于是反过来排——先
          // republish，再披露。同一条 `>=` 规则，谁最后发谁赢：披露走在后面就洗不掉了。早先它排在
          // republish 前面，于是「daemon 把你的历史输出丢了」这句话从未到过屏幕上，用户只看到输出里
          // 一段无法解释的断裂。与失败分支是同一个缺陷的两种形态，这里是另一种解法。
          if (typeof resumed === 'object') {
            this.publisher.publishRunState(this.projectRun(run, agentSession), agentSession.agentSessionId)
            this.publisher.publish({
              type: 'agent-error',
              agentSessionId: agentSession.agentSessionId,
              code: 'OUTPUT_GAP',
              message: 'This Attachment could not replay all output from its requested cursor.',
              evidence: {
                source: 'terminal-output',
                observedAt: Date.now(),
                run: runRef(run.runId),
                outputGap: { kind: 'replay', latestOutputBytes: resumed.latestOutputBytes, ...resumed.gap }
              }
            })
            continue
          }
        }
        this.publisher.publishRunState(
          this.projectRun(run, agentSession),
          agentSession?.agentSessionId
        )
      }
    })
  }
  /**
   * 重连后为一个 Agent Run 重建实时字节泵，并把掉线期间的输出补齐。走的是 {@link reattachAgent} 的
   * 同一个共享核心 {@link attachAgentRun}（身份校验、回滚、pid/输入游标记账），从 Session 自己的
   * 进程内 Attachment 已发布的字节位置续上。
   *
   * 三件不能少的事：
   * - **保留表示意图**：terminal 表示发布真实 fresh snapshot，消费者从 checkpoint source grid 导入
   *   seed 与 ordered tail，再接 live。raw 表示补发原字节，但不提供断连期间的历史 geometry；当前尺寸
   *   不能伪装成发生在 latestOutputBytes 的 resize。snapshot 与 live 由同一个 Attachment owner 排序。
   * - **失败隔离且可见**：一个 run 重建失败绝不连累后面的 run（否则一个坏 run 静默拖死其余全部），但也
   *   不静默吞掉——发一条 agent-error，让「全失败」不与「全成功」同形。
   * - **截断可见**：daemon 已把游标处的字节逐出（first_available_byte > cursor）时如实报 gap。
   *
   * 返回这个 run 实时流的三种归宿，而不是一个 boolean。两种「不是干净接上」需要调用方做**相反**的事，
   * boolean 折不住：
   * - `'live'`：接上了，没有截断。照常 republish 成 running。
   * - `'dead'`：没接上。**跳过** republish——那条 running 会把刚发的 agent-error 洗回去（同刻时间戳 +
   *   `>=` 新鲜度判据），用户就看不见失败了。
   * - `{ type: 'truncated', gap, latestOutputBytes }`：接上了，但本次 Replay 请求有缺口。携带快照事实，
   *   既要 republish（流确实活着）**又**要披露，所以由调用方按
   *   「先 running 后 error」的顺序发——披露走在后面才洗不掉。gap 事件因此由调用方发出，不在这里发。
   */
  private async resumeLiveAttachment(agentSessionId: string): Promise<'live' | 'dead' | {
    type: 'truncated'
    gap: NonNullable<CtxmuxAdapterAttachment['gap']>
    latestOutputBytes: number
  }> {
    let attached: CtxmuxAdapterAttachment
    try {
      const runId = this.requireAgentSession(agentSessionId).run.runId
      const view = this.kernel.continuationView(runId)
      const afterByte = this.kernel.continuationByte(runId)
      ;({ attached } = await this.attachAgentRun(agentSessionId, afterByte, (snapshot, current) => {
        if (view === 'terminal') {
          this.publisher.publish({
            ...snapshot,
            type: 'terminal-snapshot',
            agentSessionId: current.agentSessionId,
            afterByte,
            run: this.projectRun(snapshot.run, current)
          })
        } else {
          for (const event of snapshot.replay) this.publisher.publishRunEvent(event, current)
        }
      }, view))
    } catch (error) {
      this.publisher.publish({
        type: 'agent-error',
        agentSessionId,
        code: error instanceof AgentMuxError ? error.code : 'RECONNECT_REATTACH_FAILED',
        message: `Live output could not be resumed for this Agent after reconnect. ${
          error instanceof Error ? error.message : String(error)
        }`,
        evidence: { source: 'run-process', observedAt: Date.now() }
      })
      return 'dead'
    }
    // 把本次快照的 Gap 事实带给调用方，在它 republish 之后披露。
    return attached.gap
      ? { type: 'truncated', gap: attached.gap, latestOutputBytes: attached.run.latestOutputBytes }
      : 'live'
  }

  /**
   * 落一条可持久的「输出通道断了、进程没死」降级事实，并把它投影给渲染端（原则 11 第 2 类）。
   *
   * 与 `publishDeliveryDegrade` 同一手法：Store 是观测面、不是输入通道——事实写不进去绝不许反过来
   * 挡住一个 CtxMux 刚证明还在跑的 Run（那就把第 2 类降级又变回了阻断）。持久化失败时退回一条只对
   * 本次调用有效的内存标记，照常投影。
   */
  private async publishOutputChannelSevered(session: AgentMuxStoredAgentSession): Promise<void> {
    const degraded: AgentTerminalOutputChannelState = {
      state: 'severed',
      mode: 'degraded',
      reason: 'reattach-failed',
      run: { ...session.run },
      observedAt: Date.now()
    }
    let next: AgentMuxStoredAgentSession
    let local: LocalSessionObservation | undefined
    try {
      next = await this.updateExactAgentSession(
        session.agentSessionId,
        session.run,
        (current) => ({
          ...current,
          terminalOutputChannel: structuredClone(degraded),
          updatedAt: Math.max(current.updatedAt, degraded.observedAt)
        })
      )
    } catch (persistError) {
      const canonical = this.requireAgentSession(session.agentSessionId)
      if (!sameRun(canonical.run, session.run)) throw persistError
      next = {
        ...structuredClone(canonical),
        terminalOutputChannel: structuredClone(degraded),
        updatedAt: Math.max(canonical.updatedAt, degraded.observedAt)
      }
      local = 'terminalOutputChannel'
    }
    this.publishSession(next, undefined, local)
  }

  /**
   * 撤下「输出通道断了」的降级事实——恢复路径。一次成功的 reattach 就地清除，让服务窗消失。
   * 缺席即无事，幂等。
   *
   * 谁会走到这里：自动重连（`resumeLiveAttachment`）、以及渲染端**重新建立 attachment** 时
   * （runtime-controller 在没有既有 owner 时调 `reattachAgent`，即一次视图重挂）。
   *
   * 谁**不会**：用户点 Resume。这条降级只在进程还在跑时产生，而 Resume 走 `ensureAgentContinuity`，
   * 对 running 的 Run 判出 `reattachable` 就直接返回投影，不碰 attach；观察刷新沿公开
   * refreshRunAttachment 重建原 live owner，真实 attach 成功后才撤销输出通道事实。
   */
  private async clearOutputChannel(session: AgentMuxStoredAgentSession, observationOrigin?: AgentMuxObservationOrigin): Promise<void> {
    if (!session.terminalOutputChannel) return
    const next = await this.updateExactAgentSession(
      session.agentSessionId,
      session.run,
      (current) => {
        if (!current.terminalOutputChannel) return current
        const cleared = { ...current }
        delete cleared.terminalOutputChannel
        return { ...cleared, updatedAt: Math.max(cleared.updatedAt, Date.now()) }
      }
    )
    this.publishSession(next, observationOrigin)
  }

  /**
   * 把 daemon 快照里已经终结的 run 补进终结台账。
   *
   * 为什么必须有这一处：实时事件流不是「run 终结了」的唯一到达路径，而是**在场时**的那一条。两个窗口里
   * 它压根不存在——掉线期间（事件流断了）、以及 App 没在跑的时候（冷启动）。在这两个窗口里退出的 run，
   * 台账里没有它，于是 acceptHookEvent 那道「已终结不收 hook」的闸门放行它迟到的 hook，Agent 被点亮成
   * `working` 且**永久转圈**：exited 之后再不会有 process-state 来拨正它，而 working 的时钟衰减只降到
   * running，降不到 exited。两个窗口都实测复现过（一次掉线重连、一次冷启动 open）。
   *
   * 只补空缺、**绝不覆盖**已有记录：wire 断（handleConnectionLost）不清台账，所以重连后这份 list() 会
   * 把掉线**之前**就已实时收到过退出事件的 run 再报一遍。那些 run 的原因是带着停止意图算出来的，是更好
   * 的答案；覆盖它等于把 `user-stopped` 降级成 `unknown`。反向的次序不会发生：`open()` 先 list()、后订阅
   * 事件，被 list() 报成已退出的 run 此后不会再产出退出事件。
   *
   * 记下的原因不许假装知道：daemon 只报 code/signal，永远不知道那次退出是不是我们主动关的。所以走与实时
   * 路径**同一个** classifyRunExit、喂同一份停止意图台账（意图一次性，读完即删）——冷启动时那份意图天然
   * 是空的，于是裸 0 如实归为 `unknown` 而不是冒充「干净完成」。非 exited 的终结记 `undefined`，与实时
   * 路径一致：台账里的 `undefined` 表示「有记录但当时不可分类」。
   */
  private backfillEndedRuns(runs: readonly CtxmuxAdapterRun[]): void {
    for (const run of runs) {
      if (run.state.type === 'running') continue
      if (this.endedRuns.has(run.runId)) continue
      const stopRequested = this.stopRequestedRuns.delete(run.runId)
      this.endedRuns.set(
        run.runId,
        run.state.type === 'exited'
          ? classifyRunExit({
              stopRequested,
              exitCode: run.state.code,
              ...(run.state.signal === null ? {} : { exitSignal: run.state.signal })
            })
          : undefined
      )
      const agentSession = this.registry.findByRun(runRef(run.runId))
      this.releaseEndedRunHook(runRef(run.runId), agentSession)
      if (agentSession) { this.invalidateEndedRunReadiness(agentSession, runRef(run.runId)); this.recovery.wake(agentSession.agentSessionId) }
    }
  }

  /**
   * A terminal process-state event outranks a screen observer that is still pending. Leaving that
   * epoch in the Session store makes the next prompt report "Run is still running" even though the
   * only truthful action is resume/restart. Cancellation is synchronous; store cleanup is async and
   * publishes the canonical Session projection when it lands.
   */
  private invalidateEndedRunReadiness(
    session: AgentMuxStoredAgentSession,
    endedRun: AgentMuxRunRef
  ): void {
    this.promptSubmission.cancelReadiness(session.agentSessionId)
    void this.registry.update(
      session.agentSessionId,
      endedRun,
      (current) => {
        if (!sameRun(current.run, endedRun)) return current
        if (!current.terminalPromptReadiness && !current.terminalPromptSubmission && !current.terminalPromptDelivery) {
          return current
        }
        const next = { ...current }
        delete next.terminalPromptReadiness
        delete next.terminalPromptSubmission
        delete next.terminalPromptDelivery
        return { ...next, updatedAt: Math.max(next.updatedAt, Date.now()) }
      }
    ).then((next) => {
      this.publishSession(next)
    }).catch((error: unknown) => {
      // The Session may have been retired/resumed between the process event and this cleanup. That
      // is already the desired outcome; do not turn the successful terminal event into another error.
      if (error instanceof AgentMuxError && (
        error.code === 'STALE_AGENT_SESSION' ||
        error.code === 'UNKNOWN_AGENT_SESSION'
      )) return
      this.publisher.publish({
        type: 'agent-error',
        agentSessionId: session.agentSessionId,
        code: error instanceof AgentMuxError ? error.code : 'AGENT_PROMPT_READINESS_FAILED',
        message: error instanceof Error ? error.message : String(error),
        evidence: { source: 'run-process', observedAt: Date.now(), run: { ...endedRun } }
      })
    })
  }

  disconnect(): void {
    for (const creation of this.activeCreations.values()) creation.controller.abort()
    this.cancelReconnect()
    this.cancelProviderReads()
    this.cancelNativeIdentityCaptures()
    this.connectionEpoch += 1
    this.cancelInputPreparationObservations()
    this.connectionNeedsObservation = false
    this.connected = false
    this.runtimeConnecting = null
    this.connecting = null
    this.connectRequest = null
    this.reconnecting = false
    this.unsubscribeKernel?.()
    this.unsubscribeKernel = null
    this.unsubscribeKernelErrors?.()
    this.unsubscribeKernelErrors = null
    this.unsubscribeConnectionLost?.()
    this.unsubscribeConnectionLost = null
    this.unsubscribeConnectionAvailable?.()
    this.unsubscribeConnectionAvailable = null
    this.kernel.disconnect()
    this.runPids.clear()
    this.hookNativeWitnesses.clear()
    this.stopRequestedRuns.clear()
    this.endedRuns.clear()
    this.hookTurnPhases.clear()
    const nativeStatusWatches = [...this.nativeStatusWatches.values()]
    for (const watch of nativeStatusWatches) { watch.controller.abort(); watch.observer?.dispose() }
    this.nativeStatusWatches.clear()
    for (const watch of this.terminalFrontendWatches.values()) watch.controller.abort()
    this.terminalFrontendWatches.clear()
    this.agentInputCursors.clear()
    for (const lane of this.agentInputTails.values()) {
      for (const observation of lane.renderObservations) {
        const cancellation = new AgentMuxError(
          'Input observation cancelled because its Core client disconnected.', 'AGENT_INPUT_OBSERVATION_CANCELLED',
          JSON.stringify({ source: 'client-disconnect' }))
        if (observation.protocolInput) observation.protocolInput.cancelled ??= cancellation
        observation.controller.abort(cancellation)
      }
    }
    // Keep the original tail until its actual operation settles. A reconnect
    // cannot let a new raw/typed writer overtake an Input whose ACK is pending.
    this.promptSubmission.cancelAllReadiness()
    this.screenEvidence.discardAll()
  }

  async dispose(): Promise<void> {
    for (const creation of this.activeCreations.values()) creation.controller.abort()
    // Diagnostic IO keeps its own writer lock until settlement. It must not delay
    // healthy business ownership transfer or acquiring the new Core lease.
    void this.startupDiagnostics.dispose()
    this.messageNotificationsUnsubscribe()
    await this.messageNotifications.dispose()
    this.messageObservationDisposed = true; this.messageObservation?.dispose(); this.messageObservation = undefined
    await this.recovery.dispose()
    this.inputWaitingDisposed = true
    this.inputWaitingUnsubscribe()
    for (const value of this.inputWaitingContexts.values()) value.controller.abort()
    this.inputWaitingContexts.clear()
    // Release pre-gate observers, then let an already authorized operation
    // settle through its original bounded Native owner before disposing it.
    await Promise.allSettled([...this.inputWaitingRecipients.values()].map(value => value.pending))
    this.cancelReconnect()
    this.reopensDisposed = true
    for (const watch of this.terminalFrontendWatches.values()) watch.controller.abort()
    this.terminalFrontendWatches.clear()
    this.providerReadsDisposed = true
    this.conversationReadState.dispose()
    this.cancelProviderReads()
    this.historyObservationPool.dispose()
    for (const resources of this.historyObservationControllers.values()) {
      for (const resource of resources) resource.controller.abort(new AgentMuxError(
        'History observer client was disposed.', 'AGENT_SESSION_HISTORY_CANCELLED'))
    }

    await Promise.allSettled(this.hookRestorations.values())
    await this.hookServer.stop()
    this.disconnect()
    await Promise.all(this.nativeStatusSettlements)
    await this.registry.releaseReopenOwner()
    await Promise.allSettled([...this.hookBindings.values()].map(async (binding) => await binding.close()))
    this.hookBindings.clear()
    this.hookIngressObservations.clear()
    this.nativeCurrentActivities.clear()
    this.pendingLifecycleBindings.clear()
    await this.acp.dispose()
    this.publisher.dispose()
  }

  /**
   * Registers a synchronous observation callback. Copy work into a
   * Consumer-owned bounded queue before returning if asynchronous handling is
   * required. Promise-returning callbacks are detached with a diagnostic; fix and explicitly
   * subscribe again. Other Consumers and Run capabilities remain available.
   */
  onEvent<Result>(listener: AgentMuxClientEventListener<Result>, options?: AgentMuxClientEventListenerOptions): () => void {
    // Each selected registration takes its own current journal cut. A late reader
    // cannot mistake an older shared observer's catch-up for a newly arrived message.
    let active = true, through: number | undefined, stop = () => {}, opening: Promise<void> | undefined, retryCut = false
    const selected = options?.observeMessages === true
    const legacy = options?.observeMessages === undefined
    let observation: ReturnType<typeof observeMessageJournal> | undefined
    const establishCut = () => {
      if (!active || !selected || through !== undefined || !observation) return
      if (opening) { retryCut = true; return }
      retryCut = false
      const current = observation
      opening = this.messageQueue.messageChanges().then(async cut => {
        if (!active || this.messageObservation !== current) return
        through = cut.cut.throughSequence
        await current.refresh()
      }).catch(error => {
        if (active) this.publisher.publishTo(receive, { type: 'agent-message-observation', state: 'unavailable',
          code: 'AGENT_MESSAGE_OBSERVATION_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) })
      }).finally(() => {
        opening = undefined
        if (retryCut) { retryCut = false; establishCut() }
      })
    }
    const receive = (event: AgentMuxClientEvent) => {
      if (options?.observeMessages === false && (event.type === 'agent-message-changed' || event.type === 'agent-message-observation')) return
      if (selected && (event.type === 'agent-message-changed' || event.type === 'agent-message-observation')) {
        // Recovery establishes THIS reader's new current cut, never borrows an
        // older reader's cursor and never replays the interval that was unknown.
        if (through === undefined && (event.type === 'agent-message-changed' || event.state === 'available')) establishCut()
        if (event.type === 'agent-message-changed' ? through === undefined || event.sequence <= through
          : event.state === 'available' && through === undefined) return
      }
      return listener(event)
    }
    const release = this.publisher.onEvent(receive, { ...options, onError: error => { stop(); if (options?.onError) options.onError(error); else console.error(error) } })
    if (selected) this.messageEventReaders++
    if (legacy) this.messageLegacyEventReaders++
    observation = this.observeMessageReads()
    establishCut()
    stop = () => {
      if (!active) return
      active = false
      release()
      if (selected) this.messageEventReaders--
      if (legacy) this.messageLegacyEventReaders--
      if (!this.messageEventReaders && !(this.messageReadUsed && this.messageLegacyEventReaders)) {
        this.messageObservation?.dispose(); this.messageObservation = undefined
      }
    }
    return stop
  }

  private observeMessageReads() {
    if (this.messageObservationDisposed || !(this.messageReadUsed && this.messageLegacyEventReaders || this.messageEventReaders) || !this.publisher.hasEventListeners) return
    this.messageObservation ??= observeMessageJournal(this.messageQueue, event => {
      this.publisher.publish(event)
      if (!this.publisher.hasEventListeners) { this.messageObservation?.dispose(); this.messageObservation = undefined }
    })
    return this.messageObservation
  }

  /** A scoped, fresh observation; intentionally available before Runtime connection or repair. */
  async inspectManagedHooks(providerId: AgentProviderId, options: {
    workspacePath?: string
    env?: Readonly<Record<string, string | undefined>>
    command?: string
    args?: readonly string[]
    endpoint?: { url: string; token: string }
  } = {}): Promise<AgentManagedHookInspection & { workspacePath: string | null }> {
    const workspacePath = options.workspacePath ?? null
    const skipped = (code: string, action: string | null): AgentManagedHookInspection & { workspacePath: string | null } => ({
      providerId, workspacePath, checkedAt: Date.now(), status: 'skipped', code, action, targets: []
    })
    try {
      const provider = this.providers.get(providerId)
      const strategy = provider.catalog.hookStrategy
      if (strategy.kind !== 'native' || strategy.installation !== 'explicit-managed') {
        return skipped(strategy.kind === 'none' ? 'HOOKS_UNSUPPORTED' : 'HOOKS_NOT_MANAGED',
          strategy.kind === 'none' ? null : 'This Provider owns its Hook setup; inspect it through the Provider.')
      }
      if (workspacePath === null) return skipped('HOOK_WORKSPACE_REQUIRED', 'Provide the exact workspace for this inspection.')
      const planEnv = options.env === undefined ? undefined : Object.fromEntries(
        Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      )
      const plan = this.managedHookPlan(provider, { workspacePath, ...(planEnv ? { env: planEnv } : {}), ...(options.endpoint ? { endpoint: options.endpoint } : {}) })
      if (!plan) return skipped('HOOK_PLAN_CONTEXT_UNAVAILABLE', 'Provide the existing native binding context or a managed Hook plan; inspection does not create a binding.')
      const disk = await this.hookInstaller.inspect(plan)
      if (disk.status !== 'installed' || !provider.inspectHookActivation) return { ...disk, workspacePath }
      if (this.providerReadsDisposed) return { ...disk, workspacePath, status: 'error', code: 'AGENT_HOOK_READ_CANCELLED',
        action: 'The inspection client was disposed. Inspect with an active client.' }
      if (this.providerReads.size >= PROVIDER_READ_MAX_CONCURRENT) return { ...disk, workspacePath, status: 'error', code: 'AGENT_HOOK_READ_BUSY',
        action: 'Native reading is busy. Retry after a current read finishes.' }
      const lifetime = this.providerReadLifetime('hooks')
      const { controller } = lifetime
      let activation
      try {
        activation = await lifetime.read(provider.inspectHookActivation({
          plan, workspacePath, command: resolveAgentExecutable(options.command, provider.executable), args: options.args ?? [],
          env: options.env ?? {}, signal: controller.signal
        }))
        controller.signal.throwIfAborted()
      } catch {
        return { ...disk, workspacePath, checkedAt: Date.now(), status: 'error',
          code: controller.signal.aborted ? controller.signal.reason?.code === 'AGENT_HOOK_READ_TIMEOUT'
            ? 'AGENT_HOOK_READ_TIMEOUT' : 'AGENT_HOOK_READ_CANCELLED' : 'HOOK_ACTIVATION_CHECK_FAILED',
          action: 'The scoped native Hook check did not complete. Check the Provider configuration and native reader, then inspect again.' }
      } finally {
        lifetime.close()
      }
      return { ...disk, workspacePath, checkedAt: Date.now(), status: activation.active ? 'installed' : 'partial',
        code: activation.code, action: activation.action }
    } catch (error) {
      return { providerId, workspacePath, checkedAt: Date.now(), status: 'error',
        code: error instanceof AgentMuxError ? error.code : 'MANAGED_HOOK_CHECK_FAILED',
        action: 'The scoped Hook inspection did not complete. Check the Provider configuration and native reader, then inspect again.' +
          (error instanceof AgentMuxError ? ` ${error.message}` : ''), targets: [] }
    }
  }

  catalog(): AgentCatalogEntry[] {
    return this.providers.catalog()
  }

  agentSessions(): AgentMuxAgentSession[] {
    return this.registry.list().map(session => this.projectSession(session))
  }

  /** @internal Read-only opening port on this Client's existing metadata owner. Not a wire method. */
  readonly metadata = {
    pendingIds: (): readonly string[] => this.registry.pendingMetadataIds(),
    resolveRaw: async (agentSessionId: string): Promise<AgentMuxAgentSession> => this.projectSession(await this.resolveRawAgentSession(agentSessionId)),
    read: async (agentSessionId: string, consume: (session: AgentMuxAgentSession | null) => void, signal?: AbortSignal): Promise<void> => {
      await this.registry.readMetadata(agentSessionId, session => {
        const started = !session && this.registry.has(agentSessionId) ? this.registry.get(agentSessionId) : null
        const retained = session ?? (started?.creation?.persistence === 'unconfirmed' ? started : null)
        consume(retained ? this.projectSession(retained) : null)
      }, signal)
    },
    retainObservation: (current: AgentMuxAgentSession | null, queued: readonly AgentMuxClientEvent[]): AgentMuxClientEvent | null => {
      const latest = queued.at(-1) as (Extract<AgentMuxClientEvent, { type: 'agent-session' }> & { [localSessionObservation]?: LocalSessionObservation }) | undefined
      const field = latest?.[localSessionObservation]
      // A later canonical publication (including an accurate clear), retirement, or new Run
      // covers the old local warning. Only the last exact transient observation survives.
      if (!field || !current || latest?.type !== 'agent-session' || !sameRun(current.run, latest.session.run)) return null
      return { ...latest, session: { ...current, [field]: structuredClone(latest.session[field]) } }
    }
  }

  /** Exact durable identity, without inventory, adoption or a Run probe. */
  async readAgentSession(agentSessionId: string): Promise<AgentMuxAgentSession | null> {
    safeId(agentSessionId, 'Agent Session id')
    let canonical!: AgentMuxStoredAgentSession | null
    await this.registry.readMetadata(agentSessionId, session => { canonical = session })
    if (canonical) {
      if (canonical.agentSessionId !== agentSessionId) throw new AgentMuxError(
        'The original Session metadata belongs to another identity. Existing Runs are retained.', 'AGENT_SESSION_STORE_READ_UNCONFIRMED')
      return this.projectSession(await this.registry.readStartedResume(canonical))
    }
    const started = this.registry.has(agentSessionId) ? this.registry.get(agentSessionId) : undefined
    return started?.creation?.persistence === 'unconfirmed' ? this.projectSession(started) : null
  }

  /** Current durable identities, without replacing the active registry or probing Runs. */
  async readAgentSessions(): Promise<AgentMuxAgentSession[]> {
    const durable = await Promise.all((await loadAgentSessionMetadata(this.store)).map(session => this.registry.readStartedResume(session)))
    // A prepared creation can have an actual started Run before its commit is acknowledged.
    // Expose that real projection as explicitly unconfirmed; durable identities always take precedence.
    return [...durable, ...this.registry.list().filter(session => session.creation?.persistence === 'unconfirmed' &&
      !durable.some(current => current.agentSessionId === session.agentSessionId))].map(session => this.projectSession(session))
  }

  /** Exact durable facts precede the registry, including an original creation's later retirement. */
  private async readCreationSession(agentSessionId: string, createOperationId?: string): Promise<AgentMuxAgentCreationInspection | undefined> {
    if (createOperationId !== undefined) {
      const originalId = await this.store.loadCreationSessionId(createOperationId)
      if (originalId && originalId !== agentSessionId) throw new AgentMuxError(
        'This creation operation belongs to another original Session. Inspect its existing identity without repeating creation.',
        'AGENT_CREATION_OPERATION_CONFLICT', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
    }
    const durable = await this.store.readMetadata(agentSessionId)
    const retired = await this.store.readRetiredAgentSession(agentSessionId)
    if (retired) {
      if (!retired.history?.creation) throw new AgentMuxError(
        'The retired Agent has no confirmed original creation record. Its retirement and retained history are preserved.', 'AGENT_CREATION_UNKNOWN')
      if (createOperationId !== undefined && retired.history.creation.createOperationId !== createOperationId) throw new AgentMuxError(
        'This retired Session belongs to another original creation operation. Keep both identities and inspect the original operation.',
        'AGENT_CREATION_OPERATION_CONFLICT', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
      return { kind: 'retired-agent', ...retired }
    }
    if (durable) return this.projectSession(durable)
    const started = this.registry.has(agentSessionId) ? this.registry.get(agentSessionId) : undefined
    return started?.creation?.persistence === 'unconfirmed' ? this.projectSession(started) : undefined
  }

  /** Retained body by exact identity; absence is explicit, never inferred from a control projection. */
  async readAgentFuturePromptIntent(agentSessionId: string, intentId: string): Promise<import('./types.js').AgentFuturePromptIntent | null> {
    safeId(intentId, 'Future message intent id')
    const session = this.requireAgentSession(agentSessionId)
    return await this.store.readFuturePromptIntent(session.agentSessionId, intentId)
  }

  /** A bounded read window over all original future identities, including inactive history. */
  async listAgentFuturePromptIntents(agentSessionId: string, options: { afterIntentId?: string; limit?: number } = {}): Promise<import('./agent-session-store.js').AgentMuxFuturePromptPage> {
    const session = this.requireAgentSession(agentSessionId)
    return await this.store.listFuturePromptIntents(session.agentSessionId, options)
  }

  /** Resolve durable creation bindings before choosing an identity for a new operation. No process or input is started. */
  async resolveAgentCreationSessionId(createOperationId: string): Promise<string> {
    if (typeof createOperationId !== 'string' || !createOperationId.trim() || /[\0\r\n]/u.test(createOperationId)) {
      throw new AgentMuxError('Creation operation id is invalid.', 'INVALID_CONTROL_REQUEST')
    }
    const [storedId, queued] = await Promise.all([
      this.store.loadCreationSessionId(createOperationId), this.messageQueue.readByOperationId(createOperationId)
    ])
    const queuedId = queued?.envelope.recipientSessionId
    if (queued && (queued.envelope.recipient.kind !== 'agent-session' || queued.envelope.recipient.agentSessionId !== queuedId)) {
      throw new AgentMuxError('This operation already names another message target. Keep its original identity.', 'AGENT_CREATION_OPERATION_CONFLICT')
    }
    if (storedId && queuedId && storedId !== queuedId) {
      throw new AgentMuxError('The creation and message owners disagree on this operation. Keep both original identities and inspect the operation.', 'AGENT_CREATION_OPERATION_CONFLICT')
    }
    return storedId ?? queuedId ?? await deriveAgentSessionId(createOperationId)
  }

  /** Reconcile only the original prepared operation with authoritative Runs, never start or input. */
  async inspectAgentCreation(agentSessionId: string): Promise<AgentMuxAgentCreationInspection> {
    const existing = await this.readCreationSession(agentSessionId)
    if (existing?.kind === 'retired-agent') return existing
    if (existing && existing.creation?.persistence !== 'unconfirmed') return existing
    const correlation = await this.store.loadCreationCorrelation(agentSessionId)
    if (!correlation?.preparedCreation?.creation?.intentDigest) {
      if (existing) return existing
      throw new AgentMuxError('The original creation has no confirmed Session or prepared start. Inspect the same operation without replaying.', 'AGENT_CREATION_UNKNOWN')
    }
    await this.connectRuntime()
    const pending = await this.registry.claimCreate(agentSessionId, correlation.operationId, correlation.preparedCreation.creation.intentDigest)
    if (!pending) throw new AgentMuxError('The original creation changed while inspecting. Read the same operation again without replaying.', 'AGENT_CREATION_UNCONFIRMED')
    return this.projectSession(await this.completePreparedCreate(pending, await this.kernel.inspectCreation(pending.operationId)))
  }

  /** Original creation metadata only; never connects, adopts, resumes or starts a Run. */
  async listAgentSpawns(input: AgentMuxSpawnQuery): Promise<AgentMuxSpawnPage> {
    return await this.store.listSpawns(parseAgentSpawnQuery(input))
  }

  /** Durable capability validation for ingress; a long-lived client cannot cache authorization. */
  async authorizeRetainedAgentCaller(capability: string, callerAgentSessionId: string): Promise<AgentMuxAgentSession> {
    const current = await this.currentStoredAgentSession(callerAgentSessionId)
    this.resolveMessageAuthor(capability, callerAgentSessionId, current)
    return this.projectSession(current)
  }

  /** The durable message owner shared by SDK delivery and public service ingress. */
  agentMessageQueuePath(): string {
    return this.messageQueue.path
  }

  agentSession(agentSessionId: string): AgentMuxAgentSession {
    return this.projectSession(this.registry.get(agentSessionId))
  }

  /** Read one canonical Session; a supplied Run remains an exact fence. Passive identity observation may follow. */
  async refreshAgentSession(agentSessionId: string, expectedRun?: AgentMuxRunRef): Promise<AgentMuxAgentSession> {
    this.requireConnected()
    await this.resolveRawAgentSession(agentSessionId)
    const session = await this.registry.refresh(agentSessionId, expectedRun)
    this.hookNativeWitnesses.delete(session.run.runId)
    this.queueNativeIdentityCapture(session)
    const hookObservation = this.currentHookIngressObservation(session)
    if (hookObservation) {
      try {
        const run = await this.kernel.status(session.run.runId)
        this.assertAgentRun(session, run)
        if (run.state.type === 'running') await this.restoreHookBinding(session)
        else this.backfillEndedRuns([run])
      } catch (error) { this.observeHookRestoreFailure(session, 'binding', error) }
    }
    this.recovery.observe(session, true)
    return this.projectSession(session)
  }

  private retainUnconfirmedLifecycle(error: unknown, expected: AgentMuxStoredAgentSession): AgentMuxStoredAgentSession {
    if (!(error instanceof AgentMuxSessionDurabilityError)) throw error
    const readable = this.registry.get(expected.agentSessionId)
    if (!sameRun(readable.run, expected.run) || readable.providerId !== expected.providerId ||
      readable.hostId !== expected.hostId || readable.workspacePath !== expected.workspacePath) throw error
    return readable
  }

  private cancelNativeIdentityCaptures(): void {
    for (const capture of this.nativeIdentityCaptures.values()) capture.controller.abort()
    this.nativeIdentityCaptures.clear()
    this.nativeIdentityPending.length = 0
  }

  /** Passive, bounded capture never delays create, connection readiness or Agent input. */
  private queueNativeIdentityCapture(session: AgentMuxStoredAgentSession,
    options: Pick<AgentSessionHistoryPageOptions, 'commandOverride' | 'args' | 'env'> = {}): void {
    const provider = this.providers.get(session.providerId)
    const unconfirmed = this.registry.isDurabilityUnconfirmed(session.agentSessionId)
    const enrichConfirmedIdentity = session.nativeActor?.initializationControl === true && (!session.nativeHandle || session.nativeHandle.kind === 'provider')
    if (session.hostId !== 'local' || (!unconfirmed && (session.nativeHandle && (!enrichConfirmedIdentity || session.nativeHandle.kind !== 'provider' || session.nativeHandle.transcriptPath !== undefined) || !provider.discoverNativeSession ||
      provider.catalog.resumeStrategy.kind !== 'provider-native')) || !this.connected || !this.kernel.isConnected()) return
    const previous = this.nativeIdentityCaptures.get(session.agentSessionId)
    if (previous && sameRun(previous.run, session.run)) return
    previous?.controller.abort()
    const controller = new AbortController(), epoch = this.connectionEpoch
    const capture = { controller, run: { ...session.run } }
    this.nativeIdentityCaptures.set(session.agentSessionId, capture)
    const execute = async (): Promise<void> => {
      const timer = setTimeout(() => controller.abort(new Error('Native identity capture timed out.')), 10_000)
      let failure: unknown, delayMs = 0
      try {
        while (!controller.signal.aborted) {
          if (delayMs) await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(delay); reject(controller.signal.reason) }
            const delay = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve() }, delayMs)
            controller.signal.addEventListener('abort', abort, { once: true })
            if (controller.signal.aborted) abort()
          })
          try {
            const assertConnection = (): void => {
              controller.signal.throwIfAborted()
              if (epoch !== this.connectionEpoch || !this.connected || !this.kernel.isConnected()) {
                throw new AgentMuxError('Native identity observation changed. Refresh the original Session.', 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')
              }
            }
            const attempt = (async () => {
              assertConnection()
              if (this.registry.isDurabilityUnconfirmed(session.agentSessionId)) {
                const confirmed = await this.registry.confirmDurability(session.agentSessionId, session.run)
                assertConnection()
                if (confirmed.nativeHandle && (!enrichConfirmedIdentity || confirmed.nativeHandle.kind !== 'provider' || confirmed.nativeHandle.transcriptPath !== undefined) || !provider.discoverNativeSession) return confirmed
              }
              return await captureAgentNativeSessionIdentity({ session, provider, registry: this.registry,
                kernel: this.kernel, signal: controller.signal, assertConnection,
                command: resolveAgentExecutable(options.commandOverride, provider.executable),
                args: options.args ?? [], env: options.env ?? {},
                ...(enrichConfirmedIdentity ? { enrichConfirmedIdentity: true } : {}) })
            })()
            const next = await new Promise<AgentMuxStoredAgentSession>((resolve, reject) => {
              const abort = () => reject(controller.signal.reason)
              controller.signal.addEventListener('abort', abort, { once: true })
              attempt.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort))
              if (controller.signal.aborted) abort()
            })
            this.publishSession(next)
            return
          } catch (error) {
            if (!controller.signal.aborted || failure === undefined) failure = error
            if (controller.signal.aborted) throw error
            try { if (!sameRun(this.registry.get(session.agentSessionId).run, session.run)) return }
            catch { return }
            // A healthy CLI can publish its main record after the first few observations.
            // Keep the original cancellable period; this passive wait never owns the input lane.
            delayMs = delayMs === 0 ? 200 : Math.min(2_000, delayMs * 5)
          }
        }
      } catch (error) { failure ??= error }
      finally { clearTimeout(timer) }
      if (epoch !== this.connectionEpoch || !this.connected || !this.kernel.isConnected()) return
      let current: AgentMuxStoredAgentSession
      try { current = this.registry.get(session.agentSessionId) } catch { return }
      if (!sameRun(current.run, session.run)) return
      // Another capture or main Hook can durably confirm this Run while discovery is pending.
      // A retained locator with a source conflict or an unacknowledged save is not that fact.
      if (current.nativeHandle && !current.nativeSourceObservation && !current.observedNativeHandle &&
        (!enrichConfirmedIdentity || current.nativeHandle.kind === 'provider' && current.nativeHandle.transcriptPath !== undefined &&
          (!session.nativeHandle || matchesProviderNativeSessionTarget(session.nativeHandle, current.nativeHandle))) &&
        !this.registry.isDurabilityUnconfirmed(session.agentSessionId)) {
        this.publishSession(current)
        return
      }
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : ''
      const persistence = this.registry.isDurabilityUnconfirmed(session.agentSessionId) || ['EIO', 'ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS',
        'AGENT_SESSION_STORE_LIMIT', 'AGENT_SESSION_STORE_BUSY', 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED'].includes(code)
      const confirmedIdentity = enrichConfirmedIdentity && current.nativeHandle?.kind === 'provider' ? current.nativeHandle : undefined
      this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
        code: persistence ? 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED' : 'AGENT_NATIVE_IDENTITY_UNCONFIRMED',
        message: confirmedIdentity ? `The native conversation ${confirmedIdentity.sessionId} is confirmed. ` +
          `${persistence ? 'Saving its record locator is unconfirmed.' : 'Its record locator/source could not be confirmed.'} ` +
          `The original Run and input are kept. Refresh this Session to retry native activity observation. ${failure instanceof Error ? failure.message : ''}` :
          `${persistence ? 'Saving the native recovery identity is unconfirmed.' : 'The native recovery identity could not be confirmed.'} ` +
          `The original Agent and input are kept. Refresh this Session to retry; recovery after Run loss is not yet confirmed. ${failure instanceof Error ? failure.message : ''}`,
        evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } })
    }
    const start = (): void => {
      if (controller.signal.aborted) { this.nativeIdentityPending.shift()?.(); return }
      this.nativeIdentityActive++
      void execute().finally(() => {
        this.nativeIdentityActive--
        if (this.nativeIdentityCaptures.get(session.agentSessionId) === capture) this.nativeIdentityCaptures.delete(session.agentSessionId)
        this.nativeIdentityPending.shift()?.()
      })
    }
    if (this.nativeIdentityActive < 4) start()
    else this.nativeIdentityPending.push(start)
  }

  /** User confirmation changes this Run's conversation binding, never the Run or spatial identity. */
  async confirmAgentNativeSession(value: AgentMuxNativeSessionConfirmationInput): Promise<AgentMuxNativeSessionConfirmation> {
    const input = parseAgentNativeSessionConfirmation(value)
    const requested = await this.registry.refresh(input.agentSessionId, input.expectedRun)
    // A durable retry is a read, independent of a presently unavailable Runtime witness.
    const reconcile = (current: AgentMuxStoredAgentSession): AgentMuxNativeSessionConfirmation | undefined => {
      const previous = [current.nativeConfirmation, ...(current.nativeConfirmationHistory ?? [])].find(receipt => receipt?.operationId === input.operationId)
      if (!previous) return undefined
      if (!sameRun(previous.run, input.expectedRun) || !sameNativeHandle(previous.previousNativeHandle, input.expectedNativeHandle) ||
        !sameNativeHandle(previous.nativeHandle, input.candidateNativeHandle) || previous.candidateObservedAt !== input.expectedObservationAt) {
        throw new AgentMuxError('This confirmation operation belongs to another native transition.', 'AGENT_NATIVE_CONFIRMATION_CONFLICT')
      }
      return { session: this.projectSession(current), confirmation: structuredClone(previous), persisted: true,
        current: current.nativeConfirmation?.operationId === previous.operationId && sameRun(current.run, previous.run) && sameNativeHandle(current.nativeHandle, previous.nativeHandle) }
    }
    const reconciled = reconcile(requested)
    if (reconciled) {
      if (this.registry.isDurabilityUnconfirmed(input.agentSessionId)) await this.registry.confirmDurability(input.agentSessionId, input.expectedRun)
      return reconciled
    }
    this.requireConnected()
    return await this.serializeAgentInput(requested, async (session, run) => {
      const current = await this.registry.refresh(input.agentSessionId, input.expectedRun)
      const reconciled = reconcile(current)
      if (reconciled) {
        if (this.registry.isDurabilityUnconfirmed(input.agentSessionId)) await this.registry.confirmDurability(input.agentSessionId, input.expectedRun)
        return reconciled
      }
      const selected = current.nativeSourceObservation?.state === 'ambiguous'
      const targetChanged = !sameNativeHandle(input.expectedNativeHandle, input.candidateNativeHandle)
      const exact = (stored: AgentMuxStoredAgentSession): void => {
        if (stored.hostId !== session.hostId || !sameRun(stored.run, input.expectedRun) ||
          !sameNativeHandle(stored.nativeHandle, input.expectedNativeHandle) ||
          stored.nativeConfirmation?.operationId !== current.nativeConfirmation?.operationId ||
          stored.nativeSourceObservation?.observedAt !== input.expectedObservationAt ||
          (selected ? stored.nativeSourceObservation.state !== 'ambiguous' ||
            !stored.nativeSourceObservation.candidates?.some(candidate => sameNativeHandle(candidate, input.candidateNativeHandle))
            : stored.nativeSourceObservation.state !== 'changed' || !targetChanged ||
              !sameNativeHandle(stored.observedNativeHandle, input.candidateNativeHandle))) {
          throw new AgentMuxError('The native candidate changed. Inspect this Session again; its Run and raw input remain available.', 'AGENT_NATIVE_CONFIRMATION_STALE')
        }
      }
      exact(current)
      const provider = this.providers.get(current.providerId), epoch = this.connectionEpoch
      if (!provider.discoverNativeSession || !run.pid || run.state.type !== 'running') {
        throw new AgentMuxError('This Run has no reliable current conversation witness. Retry observation; raw input remains available.', 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')
      }
      const discovery = await provider.discoverNativeSession({ processId: run.pid, command: this.providerLaunch(current, run).command,
        args: this.providerLaunch(current, run).args, env: {}, workspacePath: current.workspacePath, signal: new AbortController().signal })
      const witness = resolveNativeSessionWitness(discovery, selected ? input.candidateNativeHandle : undefined)
      if (!witness || !sameNativeHandle(witness.handle, input.candidateNativeHandle)) {
        throw new AgentMuxError('The displayed native candidate is no longer supported by the original Run witness.', 'AGENT_NATIVE_CONFIRMATION_STALE')
      }
      await witness.assertValid()
      const after = await this.requireCurrentAgentRun(current)
      if (after.pid !== run.pid || after.state.type !== 'running' || epoch !== this.connectionEpoch) {
        throw new AgentMuxError('The original Run observation changed during confirmation.', 'AGENT_NATIVE_CONFIRMATION_STALE')
      }
      await witness.assertValid()
      let next: AgentMuxStoredAgentSession
      try {
        next = await this.registry.update(input.agentSessionId, input.expectedRun, stored => {
          exact(stored)
          const observedAt = Math.max(Date.now(), stored.updatedAt + 1)
          const result: AgentMuxStoredAgentSession = { ...stored, nativeHandle: { ...input.candidateNativeHandle },
            nativeBinding: { source: selected ? 'user-selected' : 'user-confirmed', run: { ...stored.run }, observedAt }, updatedAt: observedAt,
            ...(stored.nativeConfirmation ? { nativeConfirmationHistory: [...(stored.nativeConfirmationHistory ?? []), structuredClone(stored.nativeConfirmation)] } : {}),
            nativeConfirmation: { operationId: input.operationId, run: { ...stored.run }, previousNativeHandle: { ...input.expectedNativeHandle },
              nativeHandle: { ...input.candidateNativeHandle }, observedAt,
              candidateObservedAt: input.expectedObservationAt, basis: selected ? 'run-main-candidate' : 'current-main',
              ...(targetChanged && stored.promptCompletionAdmission?.submissionId ? { previousPromptSubmissionId: stored.promptCompletionAdmission.submissionId } : {}),
              ...(targetChanged && stored.pendingInteraction ? { previousInteraction: structuredClone(stored.pendingInteraction) } : {}) } }
          // Preserve original input operations/receipts and ancestry; remove only old-source authority.
          if (targetChanged) {
            delete result.pendingInteraction
            delete result.terminalPromptReadiness
            delete result.nativePromptPredecessor
            delete result.hookReceipt
            delete result.turnUsage
            delete result.semanticStatus
            delete result.recoveryActivity
          }
          delete result.observedNativeHandle
          if (!selected) delete result.nativeSourceObservation
          return result
        })
      } catch (error) {
        // A readable replacement is still unconfirmed until the Store acknowledges its durability.
        const saved = await this.registry.refresh(input.agentSessionId, input.expectedRun)
        if (saved.nativeConfirmation?.operationId !== input.operationId || !sameNativeHandle(saved.nativeHandle, input.candidateNativeHandle) ||
          !sameNativeHandle(saved.nativeConfirmation.previousNativeHandle, input.expectedNativeHandle)) throw error
        next = this.registry.isDurabilityUnconfirmed(input.agentSessionId)
          ? await this.registry.confirmDurability(input.agentSessionId, input.expectedRun) : saved
      }
      if (targetChanged) {
        this.cancelPromptRenderObservation(current, 'interaction-response')
        this.promptSubmission.cancelReadiness(input.agentSessionId)
        this.screenEvidence.discard(input.agentSessionId)
        this.hookNativeWitnesses.delete(current.run.runId)
        this.hookTurnPhases.delete(current.run.runId)
        this.nativeCurrentActivities.delete(input.agentSessionId)
        if (this.hookIngressObservations.get(input.agentSessionId)?.code === 'AGENT_NATIVE_ACTIVITY_UNAVAILABLE') {
          this.hookIngressObservations.delete(input.agentSessionId)
        }
        releaseSubagentRoster(current.run.runId)
      }
      this.publishSession(next)
      await this.ensureNativeStatusObservation(next)
      return { session: this.projectSession(next), confirmation: structuredClone(next.nativeConfirmation!), persisted: true, current: true }
    }, { kind: 'semantic', bytes: null })
  }

  async sessionTimeline(agentSessionId: string): Promise<AgentTimelineSnapshot> {
    const descriptor = await this.historyDescriptor(agentSessionId)
    return { ...await this.store.loadTimeline(agentSessionId), sourceHostId: descriptor.hostId }
  }

  /** Query the original semantic Host's retained history; no Runtime connection or input authority. */
  async readAgentSessionHistory(input: AgentSessionHistoryReadInput, options: { signal?: AbortSignal } = {}): Promise<AgentSessionHistoryReadPage> {
    // The receiver is already the selected semantic Host. Its route-local namespace
    // is distinct from the execution Host retained in its own durable descriptor.
    const descriptor = input.hostId === 'local' ? await this.historyDescriptor(input.agentSessionId) : undefined
    const page = await readAgentSessionHistory(this, descriptor ? { ...input, hostId: descriptor.hostId } : input,
      { ...options, resolveSource: id => this.historyDescriptor(id), readCapturedHistory: (id, query) => this.store.readCapturedHistory(id, query) })
    return descriptor ? { ...page, hostId: input.hostId } : page
  }

  /** Read this owner's retained startup facts without probing or connecting Runtime. */
  async readAgentStartupDiagnostic(input: { target: AgentStartupDiagnosticExactTarget; includeRaw?: boolean }) {
    if (!input || Object.keys(input).some(key => !['target', 'includeRaw'].includes(key)) || input.includeRaw !== undefined && typeof input.includeRaw !== 'boolean')
      throw new AgentMuxError('Startup diagnostic reading accepts one exact target and explicit material choice.', 'INVALID_CONTROL_REQUEST')
    const target = parseStartupDiagnosticTarget(input.target)
    if (!('logId' in target)) throw new AgentMuxError('An exact startup record is required.', 'INVALID_CONTROL_REQUEST')
    return this.startupDiagnostics.read(target, input.includeRaw === true)
  }
  async findAgentStartupDiagnostics(input: AgentStartupDiagnosticRecentTarget) {
    const target = parseStartupDiagnosticTarget(input)
    if (!('recent' in target)) throw new AgentMuxError('A bounded startup discovery query is required.', 'INVALID_CONTROL_REQUEST')
    return this.startupDiagnostics.read(target)
  }
  async readReadingDiagnostic(target: ReadingDiagnosticExactTarget) {
    const source = this.originalReadingDiagnosticSource()
    return source ? source.read(target) : unavailableDiagnosticEvidence<ReadingDiagnosticExactTarget, ReadingDiagnosticRecord>(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
  }
  async findReadingDiagnostics(query: ReadingDiagnosticFindParams): Promise<ReadingDiagnosticFindResult> {
    const source = this.originalReadingDiagnosticSource()
    return source ? source.find(query) : { query, availability: 'unavailable', authority: null, records: [], nextCursor: null,
      coverage: { retainedRecords: null, evictedRecords: null, rejectedRecords: null, examinedRecords: 0, complete: false }, issue: 'source-unavailable' }
  }
  private async observeConversationRead<T extends { sourceHostId: string; window?: { id: string; revision: number; itemCount: number } }>(
    input: ConversationRef, operation: 'latest' | 'changes' | undefined, read: () => Promise<T>): Promise<T> {
    const diagnostic = this.originalReadingDiagnosticSource()?.begin(input)
    diagnostic?.recorder.record({ phase: 'source-read-started', ...(operation ? { operation } : {}) }); diagnostic?.recorder.flush('progress')
    try {
      const page = await read()
      diagnostic?.recorder.record({ phase: 'source-read-completed', ...(operation ? { operation } : {}), sourceHostId: page.sourceHostId,
        ...(page.window ? { windowId: page.window.id, windowRevision: page.window.revision, itemCount: page.window.itemCount } : {}) })
      diagnostic?.recorder.record({ phase: 'consumer-ended' }); diagnostic?.recorder.flush('progress')
      return page
    } catch (error) {
      diagnostic?.recorder.record({ phase: 'source-read-failed', ...(operation ? { operation } : {}), reason: readingDiagnosticFailureReason(error) })
      diagnostic?.recorder.record({ phase: 'consumer-ended' }); diagnostic?.recorder.flush('failure')
      throw error
    } finally { diagnostic?.end() }
  }

  /** One source-qualified timeline over the original native and captured owners. */
  async readAgentConversation(input: ConversationTimelineReadInput, options: ConversationReadOptions = {}): Promise<AgentConversationReadPage> {
    return this.observeConversationRead(input, input.cursor || input.record || input.anchor || input.view ? undefined : 'latest', async () => {
      const owner = await this.conversationReader(input, options)
      if (input.anchor) { parseConversationCheckpoint(input.anchor.frontier, input); parseConversationFrontier(input.anchor.frontier.frontier, owner.reference) }
      const anchor = input.anchor ? { ...input.anchor, frontier: { ...input.anchor.frontier, ...owner.reference } } : undefined
      const page = await readUnifiedConversation({ ...input, ...owner.reference, ...(anchor ? { anchor } : {}) }, owner.port)
      return { ...page, hostId: input.hostId }
    })
  }

  async conversationCheckpoint(input: ConversationCheckpointInput, options: ConversationReadOptions = {}): Promise<ConversationCheckpointPage> {
    input = parseConversationCheckpointInput(input)
    const owner = await this.conversationReader(input, options)
    const page = await cutUnifiedConversation(owner.reference, owner.port, input.nativePosition)
    return { ...page, hostId: input.hostId, checkpoint: { ...page.checkpoint, hostId: input.hostId } }
  }

  async readConversationChanges(input: ConversationChangesInput, options: ConversationReadOptions = {}): Promise<ConversationChangesPage> {
    return this.observeConversationRead(input, 'changes', async () => {
      const owner = await this.conversationReader(input, options)
      parseConversationCheckpoint(input.checkpoint, input)
      parseConversationFrontier(input.checkpoint.frontier, owner.reference)
      const page = await readUnifiedChanges({ ...input, ...owner.reference, checkpoint: { ...input.checkpoint, ...owner.reference } }, owner.port)
      return { ...page, hostId: input.hostId, checkpoint: { ...page.checkpoint, hostId: input.hostId } }
    })
  }

  /** Release only this temporary read view; original records, cuts and Runs are unchanged. */
  async releaseConversationView(input: ConversationViewReleaseInput): Promise<ConversationViewReleaseResult> {
    input = parseConversationViewReleaseInput(input)
    const descriptor = await this.historyDescriptor(input.agentSessionId)
    if (input.hostId !== 'local' && input.hostId !== descriptor.hostId) throw new AgentMuxError('The exact original conversation Host is unavailable.', 'UNKNOWN_AGENT_SESSION')
    return { hostId: input.hostId, agentSessionId: input.agentSessionId, sourceHostId: descriptor.hostId,
      ...this.conversationReadState.release(input.view, { hostId: descriptor.hostId, agentSessionId: input.agentSessionId }) }
  }

  private async conversationReader(input: ConversationTimelineReadInput | ConversationChangesInput, options: ConversationReadOptions): Promise<{ reference: ConversationRef; port: ConversationReaderPort }> {
    parseConversationRef({ hostId: input.hostId, agentSessionId: input.agentSessionId })
    options.signal?.throwIfAborted()
    let descriptor = await this.historyDescriptor(input.agentSessionId)
    if (input.hostId !== 'local' && input.hostId !== descriptor.hostId) throw new AgentMuxError('The exact original conversation Host is unavailable.', 'UNKNOWN_AGENT_SESSION')
    // Source references stay in this original Core namespace. A client route is
    // external addressing context and never rewrites a source, cut or unit.
    const reference = parseConversationRef({ hostId: descriptor.hostId, agentSessionId: input.agentSessionId })
    const selected = conversationReadNativeSource(input, reference)
    const active = this.activeNativeHistoryBinding(input.agentSessionId, selected)
    if (active && descriptor.history) descriptor = { ...descriptor, history: { ...descriptor.history, nativeHandle: active.handle } }
    const history = descriptor.history
    const matches = (handle: AgentNativeSessionHandle | undefined) => handle?.kind === 'provider' && handle.providerId === selected?.providerId && handle.sessionId === selected.nativeSessionId
    const previous = selected && !matches(history?.nativeHandle) && matches(history?.previousNativeHandle)
    const acceptedViewOnly = input.view && !input.cursor && !('checkpoint' in input) && !input.anchor && !('record' in input && input.record) && !input.nativeSource
    if (selected && !matches(history?.nativeHandle) && !previous && !acceptedViewOnly) throw new AgentMuxError('The exact original native source is not retained by this Session. Its displayed records and Run are unchanged.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    const sourceOptions = previous ? { nativeSource: 'previous' as const } : {}
    if (previous && history) descriptor = { ...descriptor, history: { ...history, nativeHandle: history.previousNativeHandle! } }
    const source = selected ?? (descriptor.history?.nativeHandle?.kind === 'provider'
      ? { providerId: descriptor.history.nativeHandle.providerId, nativeSessionId: descriptor.history.nativeHandle.sessionId } : undefined)
    return { reference, port: { state: this.conversationReadState, descriptor, nativeRecordAvailable: source ? typeof this.providers.list().find(provider => provider.id === source.providerId)?.readSessionHistoryRecord === 'function' : false, readHostId: input.hostId, ...(options.signal ? { signal: options.signal } : {}),
      captured: async query => {
        let inputJournal: import('./agent-input-conversation.js').AgentInputJournalCut | undefined
        let failure: { code: string; message: string } | undefined
        try { inputJournal = await this.syncInputConversation(input.agentSessionId, options.signal) }
        catch (error) {
          options.signal?.throwIfAborted()
          failure = { code: 'AGENT_INPUT_CONVERSATION_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) }
          // A capture failure cannot move the original input birth past a later
          // sharing cut. Preserve the independently readable journal frontier.
          try { inputJournal = await this.messageQueue.readConversationInputCut(input.agentSessionId) } catch { /* The precise input source gap remains visible. */ }
        }
        const page = await this.store.readCapturedHistory(input.agentSessionId, query)
        return { ...page, stream: { ...page.stream, ...(inputJournal ? { inputJournal } : {}), gaps: [...page.stream.gaps, ...(failure ? [failure] : [])] } }
      },
      nativePage: (cursor, limit) => this.readSessionHistoryPage(input.agentSessionId, { ...sourceOptions, limit, ...(cursor === undefined ? {} : { cursor }), ...(options.signal ? { signal: options.signal } : {}) }, source),
      nativeCheckpoint: async position => (await this.nativeHistoryChangesPage(input.agentSessionId, { ...sourceOptions,
        ...(position === 'beginning' ? { head: true as const } : { tail: true as const }), ...(options.signal ? { signal: options.signal } : {}) }, source)).checkpoint,
      nativeChanges: (checkpoint, limit) => this.nativeHistoryChangesPage(input.agentSessionId, { ...sourceOptions, checkpoint, limit, ...(options.signal ? { signal: options.signal } : {}) }, source),
      nativeRecord: (source, id) => this.readConversationNativeRecord(input.agentSessionId, source, id, options.signal) } }
  }

  /** Exact-record lookup reuses the original Provider binding, resource signer and read lifetime. */
  private async readConversationNativeRecord(agentSessionId: string, source: AgentSessionHistorySource, recordId: string, signal?: AbortSignal,
    invocation: Pick<AgentMuxSessionQuestionReplyInput, 'commandOverride' | 'args' | 'env'> & { turnId?: string } = {}): Promise<AgentSessionHistoryItem> {
    if (this.providerReadsDisposed) throw new AgentMuxError('Conversation reader was disposed.', 'AGENT_SESSION_HISTORY_CANCELLED')
    if (this.providerReads.size >= PROVIDER_READ_MAX_CONCURRENT) throw new AgentMuxError('Conversation reading is busy; retry this exact original record.', 'AGENT_SESSION_HISTORY_BUSY')
    const lifetime = this.providerReadLifetime('history'), { controller, read } = lifetime
    const cancel = () => controller.abort(signal?.reason); signal?.addEventListener('abort', cancel, { once: true })
    try {
      signal?.throwIfAborted()
      const descriptor = await read(this.historyDescriptor(agentSessionId))
      const previous = descriptor.history?.previousNativeHandle
      const sourceOptions = previous?.kind === 'provider' && previous.providerId === source.providerId && previous.sessionId === source.nativeSessionId ? { nativeSource: 'previous' as const } : {}
      const binding = await read(this.nativeHistoryBinding(agentSessionId, { ...invocation, ...sourceOptions }, controller.signal, 'read', source))
      const { session, provider, handle, executorOptions: options } = binding
      if (source.providerId !== session.providerId || source.nativeSessionId !== handle.sessionId) throw new AgentMuxError('The exact native record belongs to another original source.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
      if (!provider.readSessionHistoryRecord) throw new AgentMuxError('This Provider cannot locate the exact recorded version. The original source remains readable.', 'AGENT_SESSION_HISTORY_RECORD_UNSUPPORTED')
      const contentSigningSecret = (await read(this.store.readMetadata(agentSessionId)))?.hookToken
      const originalSource = { providerId: source.providerId, nativeSessionId: source.nativeSessionId }
      const item = await read(provider.readSessionHistoryRecord({ agentSessionId, source: originalSource, recordId, ...(invocation.turnId === undefined ? {} : { turnId: invocation.turnId }), signal: controller.signal,
        command: resolveAgentExecutable(options.commandOverride, provider.executable), args: options.args ?? [], env: options.env ?? {}, workspacePath: session.workspacePath,
        ...(contentSigningSecret === undefined ? {} : { contentSigningSecret }), ...(handle.transcriptPath === undefined ? {} : { transcriptPath: handle.transcriptPath }) }))
      await read(binding.assertCurrent())
      const record = normalizeSessionHistoryPage(source, { source, items: [item], nextCursor: null }, 1).items[0]!
      if (record.id !== recordId || invocation.turnId !== undefined && record.turnId !== invocation.turnId) throw new AgentMuxError('The original lookup returned another native record.', 'CONTROL_PROTOCOL_ERROR')
      const adopted = await read(confirmNativeInputAdoption(record, { hostId: binding.sourceHostId, agentSessionId }, originalSource,
        key => this.inspectAgentPromptSubmission(key), controller.signal))
      await this.observeNotificationAdoptions([adopted])
      return adopted
    } finally { signal?.removeEventListener('abort', cancel); lifetime.close() }
  }

  /** A qualified original native record can settle a lost notification ACK without replaying input or consuming Inbox. */
  private async observeNotificationAdoptions(items: readonly AgentSessionHistoryItem[]): Promise<void> {
    for (const item of items) {
      const adoption = item.conversation?.adoptedInput
      if (adoption?.purpose !== 'a2a-notification' || adoption.key.kind !== 'prompt') continue
      try {
        const notice = await this.messageQueue.readNotification(adoption.key.submissionId)
        if (notice && isDeepStrictEqual(notice.key, adoption.key) && (notice.state === 'pending' || notice.state === 'unconfirmed')) await this.messageQueue.recordNotificationResult(notice.notificationId, 'submitted')
      } catch (error) {
        this.publisher.publish({ type: 'agent-error', agentSessionId: adoption.key.agentSessionId, code: 'A2A_NOTIFICATION_OBSERVATION_UNCONFIRMED',
          message: `The native record remains readable; the original notification observation could not be retained. ${error instanceof Error ? error.message : String(error)}`,
          evidence: { source: 'agentmux', run: adoption.key.expectedRun, observedAt: Date.now() } })
      }
    }
  }

  /** Notifications only wake authoritative reads. Each native/captured source keeps its original scope. */
  async observeConversation(input: ConversationWatchInput, listener: (value: ConversationObservation) => void, options: ConversationReadOptions = {}): Promise<ConversationObservationHandle> {
    input = parseConversationWatchInput(input)
    let diagnostic = this.originalReadingDiagnosticSource()?.begin(input)
    diagnostic?.recorder.record({ phase: 'source-watch-opening' }); diagnostic?.recorder.flush('progress')
    const cancelledOpening = () => {
      diagnostic?.recorder.record({ phase: 'source-watch-unavailable', reason: 'cancelled' }); diagnostic?.recorder.flush('failure')
      diagnostic?.recorder.record({ phase: 'source-watch-closed', reason: 'cancelled' }); diagnostic?.recorder.record({ phase: 'consumer-ended', reason: 'cancelled' })
      diagnostic?.recorder.flush('release'); diagnostic?.end(); diagnostic = undefined
    }
    options.signal?.addEventListener('abort', cancelledOpening, { once: true })
    if (options.signal?.aborted) cancelledOpening()
    let owner: Awaited<ReturnType<AgentMuxClient['conversationReader']>>
    try { owner = await this.conversationReader(input, options) }
    catch (error) {
      diagnostic?.recorder.record({ phase: 'source-watch-unavailable', reason: readingDiagnosticFailureReason(error) }); diagnostic?.recorder.flush('failure')
      diagnostic?.recorder.record({ phase: 'source-watch-closed', reason: 'disposed' }); diagnostic?.recorder.record({ phase: 'consumer-ended', reason: 'disposed' })
      diagnostic?.recorder.flush('release'); diagnostic?.end()
      throw error
    } finally { options.signal?.removeEventListener('abort', cancelledOpening) }
    const ref = owner.reference
    const controller = new AbortController(), resources = this.historyObservationControllers.get(input.agentSessionId) ?? new Set<NativeHistoryObservationResource>()
    const resource: NativeHistoryObservationResource = { controller, binding: null }
    resources.add(resource); this.historyObservationControllers.set(input.agentSessionId, resources)
    let native: AgentSessionHistoryObservationHandle | undefined, opening: import('./conversation-changes.js').ConversationWatchOpening | undefined
    let pendingCaptured = false, pendingNative: AgentSessionHistoryObservation | undefined
    let nativeFailure: { error: unknown } | undefined, unsubscribe = () => {}, nativeEnded = () => {}, releaseView = () => {}, disposed = false
    let onNative = (value: AgentSessionHistoryObservation): void => { pendingNative = value }
    const emit = (value: ConversationObservation): void => {
      if (!opening || controller.signal.aborted) return
      diagnostic?.recorder.record({ phase: value.kind === 'invalidated' ? 'source-invalidated' : 'source-watch-unavailable', sourceHostId: ref.hostId,
        sourceKind: value.source.kind, ...(value.source.kind === 'native' ? { nativeSource: { providerId: value.source.providerId, nativeSessionId: value.source.nativeSessionId } } : {}),
        ...(value.kind === 'unavailable' ? { reason: readingDiagnosticFailureReason({ code: value.code }) } : {}) })
      diagnostic?.recorder.flush(value.kind === 'unavailable' ? 'failure' : 'progress')
      try { listener(parseConversationObservation({ ...value, hostId: input.hostId }, opening)) } catch { /* Read callbacks cannot gate the original Agent. */ }
    }
    const captured = () => {
      if (!opening) { pendingCaptured = true; return }
      const source = opening.scope.sources.find(s => s.kind === 'captured')
      if (source) emit({ ...ref, sourceHostId: ref.hostId, source, kind: 'invalidated' })
    }
    const dispose = () => {
      if (disposed) return
      disposed = true; unsubscribe(); native?.closed?.removeEventListener('abort', nativeEnded); native?.dispose(); releaseView()
      diagnostic?.recorder.record({ phase: 'source-watch-closed', reason: 'disposed', sourceHostId: ref.hostId })
      diagnostic?.recorder.record({ phase: 'consumer-ended', reason: 'disposed' })
      diagnostic?.recorder.flush('release'); diagnostic?.end()
      options.signal?.removeEventListener('abort', dispose); resources.delete(resource)
      if (!resources.size) this.historyObservationControllers.delete(input.agentSessionId)
      if (!controller.signal.aborted) controller.abort(new AgentMuxError('This conversation reader was released.', 'AGENT_SESSION_HISTORY_CANCELLED'))
    }
    controller.signal.addEventListener('abort', dispose, { once: true }); options.signal?.addEventListener('abort', dispose, { once: true })
    unsubscribe = this.publisher.onConversationSourceEvent(input.agentSessionId, captured)
    try {
      options.signal?.throwIfAborted()
      // A fresh observation establishes current-source intent before freezing its
      // cut. Its existing native resource owns any unsaved discovery witness.
      // A view-qualified observation instead keeps the accepted original scope.
      if (!input.view) {
        try { native = await this.observeSessionHistory(input.agentSessionId, value => onNative(value), { signal: controller.signal }) }
        catch (error) { controller.signal.throwIfAborted(); nativeFailure = { error } }
        owner = await this.conversationReader(input, { signal: controller.signal })
      }
      const cut = await cutUnifiedConversation(ref, owner.port)
      const observed = input.view ? this.conversationReadState.observe(input.view, ref, cut.scope) : undefined
      if (observed) releaseView = observed.dispose
      const scope = observed?.scope ?? cut.scope
      opening = parseConversationWatchOpening({ hostId: input.hostId, agentSessionId: input.agentSessionId, sourceHostId: ref.hostId, scope,
        coverage: cut.coverage.filter(value => scope.sources.some(source => isDeepStrictEqual(source, value.source))) }, input)
      const source = opening.scope.sources.find(s => s.kind === 'native')
      if (source?.kind === 'native') {
        const checkpointCoverage = opening.coverage
        const unavailable = (code: string, message: string) => {
          // The opening includes failures that happened before it was returned.
          // Keep other sources and their checkpoint coverage intact.
          opening = { ...opening!, coverage: checkpointCoverage.map(value => isDeepStrictEqual(value.source, source)
            ? { ...value, current: code.includes('UNSUPPORTED') ? 'unsupported' : 'unavailable', gaps: [...value.gaps, { code, message }] } : value) }
          emit({ ...ref, sourceHostId: ref.hostId, source, kind: 'unavailable', code, message })
        }
        try {
          onNative = (observation: AgentSessionHistoryObservation) => {
            if (observation.source && (observation.source.providerId !== source.providerId || observation.source.nativeSessionId !== source.nativeSessionId)) return
            if (observation.kind === 'unavailable') unavailable(observation.code, observation.message)
            else emit({ ...ref, sourceHostId: ref.hostId, source, kind: observation.kind })
          }
          if (nativeFailure) throw nativeFailure.error
          if (!native) native = await this.observeSessionHistory(input.agentSessionId, onNative, { signal: controller.signal, ...(owner.port.descriptor.history?.nativeHandle?.kind === 'provider' &&
            source.nativeSessionId === owner.port.descriptor.history.previousNativeHandle?.sessionId ? { nativeSource: 'previous' as const } : {}) })
          if (native.source.providerId !== source.providerId || native.source.nativeSessionId !== source.nativeSessionId) {
            native.dispose(); native = undefined
            throw new AgentMuxError('The native observation resolved another source. Its accepted scope and records are retained; explicitly refresh to inspect the current source.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
          }
          nativeEnded = () => unavailable('AGENT_SESSION_HISTORY_SOURCE_CHANGED', 'The original native observation ended; its scope is retained and captured changes remain readable.')
          native.closed?.addEventListener('abort', nativeEnded, { once: true })
          if (native.closed?.aborted) nativeEnded()
          if (pendingNative) onNative(pendingNative)
        } catch (error) {
          controller.signal.throwIfAborted()
          unavailable(error instanceof AgentMuxError ? error.code : 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE', error instanceof Error ? error.message : 'Native observation is unavailable; explicit reading remains available.')
        }
      }
      if (pendingCaptured) captured()
      controller.signal.throwIfAborted()
      diagnostic?.recorder.record({ phase: 'source-watch-opened', sourceHostId: ref.hostId }); diagnostic?.recorder.flush('progress')
      return { ...opening, hostId: input.hostId, closed: controller.signal, dispose }
    } catch (error) { dispose(); throw error }
  }

  /** Discover bounded retained sources without connecting to or controlling Runtime. */
  async sessionHistorySources(options: import('./types.js').AgentSessionHistorySourcesOptions = {}): Promise<AgentSessionHistoryDescriptor[]> {
    return await loadSessionHistorySources(this.store, options)
  }

  /** Discover native persisted conversations without requiring a Run, installing hooks or starting input. */
  async listNativeAgentSessions(input: { providerId: AgentProviderId; workspacePath?: string; env?: Readonly<Record<string, string>> }): Promise<AgentNativeSessionCatalog> {
    const provider = this.providers.get(input.providerId), capabilities = structuredClone(provider.catalog.capabilities)
    if (!provider.listNativeSessions) return { providerId: provider.id, capabilities, availability: 'unsupported', sessions: [], issues: [] }
    const env = { ...input.env }, workspacePath = input.workspacePath
    const entries = (value: Readonly<Record<string, string | undefined>>) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    // Inherited values qualify the original source, but remain Provider fallbacks rather than explicit overrides.
    const key = JSON.stringify([workspacePath ?? null, entries(env), entries(process.env)])
    let reads = this.nativeSessionCatalogReads.get(provider)
    if (!reads) { reads = new Map(); this.nativeSessionCatalogReads.set(provider, reads) }
    let pending = reads.get(key)
    if (!pending) {
      pending = (async () => await provider.listNativeSessions!({ ...(workspacePath === undefined ? {} : { workspacePath }),
        env, signal: new AbortController().signal }))().finally(() => {
        if (reads.get(key) === pending) reads.delete(key)
      })
      reads.set(key, pending)
    }
    const catalog = structuredClone(await pending)
    try {
      const managed = await this.managedNativeIndex()
      for (const entry of catalog.sessions) {
        const matches = managed.get(JSON.stringify([entry.source.nativeHandle.providerId, entry.source.nativeHandle.sessionId])) ?? []
        if (matches.length === 1) entry.managed = matches[0]!
        else if (matches.length > 1) catalog.issues.push({ code: 'AGENT_NATIVE_SESSION_AMBIGUOUS',
          message: `Native conversation ${entry.source.nativeHandle.sessionId} belongs to several Core Sessions: ${matches.map(match => match.agentSessionId).join(', ')}. Inspect their original identities before continuing.` })
      }
    } catch (error) { catalog.issues.push(nativeCatalogIssue(error)) }
    return { ...catalog, capabilities }
  }

  /** Preview original native history before Resume, without reserving, importing or starting an Agent. */
  async readNativeAgentHistory(input: AgentNativeHistoryReadOptions): Promise<AgentProviderSessionHistoryPage> {
    const native = parseAgentNativeResumeSource(input.source), limit = input.limit ?? 30
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 16_384)) ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))) {
      throw new AgentMuxError('Native history needs a limit from 1 to 100 and an opaque cursor.', 'INVALID_AGENT_SESSION_HISTORY_OPTIONS')
    }
    input.signal?.throwIfAborted()
    const provider = this.providers.get(native.nativeHandle.providerId)
    if (!provider.assertNativeResumeSource || !provider.readSessionHistoryPage) throw new AgentMuxError(
      'This Provider does not expose exact persisted conversation history.', 'AGENT_SESSION_HISTORY_UNSUPPORTED')
    const lifetime = this.providerReadLifetime('history'), { controller, read } = lifetime
    const cancel = (): void => controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', cancel, { once: true })
    try {
      const env = input.env ?? {}, source = { providerId: provider.id, nativeSessionId: native.nativeHandle.sessionId }
      const assertSource = () => provider.assertNativeResumeSource!({ source: native, workspacePath: native.workspacePath,
        env, signal: controller.signal })
      await read(assertSource())
      const page = await read(provider.readSessionHistoryPage({ source, limit, signal: controller.signal,
        command: resolveAgentExecutable(input.commandOverride, provider.executable), args: input.args ?? [], env,
        workspacePath: native.workspacePath,
        ...(native.nativeHandle.transcriptPath === undefined ? {} : { transcriptPath: native.nativeHandle.transcriptPath }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }) }))
      controller.signal.throwIfAborted()
      await read(assertSource())
      return normalizeSessionHistoryPage(source, page, limit)
    } finally {
      input.signal?.removeEventListener('abort', cancel)
      lifetime.close()
    }
  }

  /** Read only a Provider-recorded exact resource before adoption; no caller reference grants a file path. */
  async readNativeAgentHistoryResource(input: AgentNativeHistoryResourceReadOptions): Promise<AgentProviderSessionHistoryResourceReadResult> {
    const native = parseAgentNativeResumeSource(input.nativeSource)
    const { nativeSource: _nativeSource, ...resource } = input
    const request = parseSessionHistoryResourceOptions(resource)
    const source = { providerId: native.nativeHandle.providerId, nativeSessionId: native.nativeHandle.sessionId }
    if (request.source.providerId !== source.providerId || request.source.nativeSessionId !== source.nativeSessionId) throw new AgentMuxError(
      'This resource belongs to another native conversation.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    request.signal?.throwIfAborted()
    const provider = this.providers.get(source.providerId)
    if (!provider.assertNativeResumeSource || !provider.readSessionHistoryPage) throw new AgentMuxError(
      'This Provider does not expose exact persisted conversation history.', 'AGENT_SESSION_HISTORY_UNSUPPORTED')
    const lifetime = this.providerReadLifetime('history'), { controller, read } = lifetime
    const cancel = (): void => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', cancel, { once: true })
    try {
      const env = request.env ?? {}, context = { source, signal: controller.signal,
        command: resolveAgentExecutable(request.commandOverride, provider.executable), args: request.args ?? [], env,
        workspacePath: native.workspacePath,
        ...(native.nativeHandle.transcriptPath === undefined ? {} : { transcriptPath: native.nativeHandle.transcriptPath }) }
      const assertSource = () => provider.assertNativeResumeSource!({ source: native, workspacePath: native.workspacePath,
        env, signal: controller.signal })
      await read(assertSource())
      const identity = { source, recordId: request.recordId, partIndex: request.partIndex,
        ...(request.turnId === undefined ? {} : { turnId: request.turnId }), reference: request.expectedReference }
      const locateRecord = async () => {
        if (provider.readSessionHistoryRecord) {
          const item = await read(provider.readSessionHistoryRecord({ ...context, recordId: request.recordId,
            ...(request.turnId === undefined ? {} : { turnId: request.turnId }) }))
          return normalizeSessionHistoryPage(source, { source, items: [item], nextCursor: null }, 1).items[0]!
        }
        let cursor: string | undefined
        for (;;) {
          const page = normalizeSessionHistoryPage(source, await read(provider.readSessionHistoryPage!({ ...context, limit: 100,
            ...(cursor === undefined ? {} : { cursor }) })), 100)
          const item = page.items.find(item => item.id === request.recordId && item.turnId === request.turnId)
          if (item) return item
          if (!page.nextCursor) throw new AgentMuxError('The exact native record is unavailable.', 'UNKNOWN_AGENT_SESSION_HISTORY_RECORD')
          if (page.nextCursor === cursor) throw new AgentMuxError('The Provider did not advance the exact-record read.', 'INVALID_AGENT_SESSION_HISTORY_PAGE')
          cursor = page.nextCursor
        }
      }
      if (isNativeContentReference(request.expectedReference)) {
        let authorizedReference = request.expectedReference
        let originalKind: AgentSessionHistoryItem['kind'] | undefined
        if (request.markdownImage || nativeContentNeedsRevalidation(request.expectedReference)) {
          const item = await locateRecord(), part = item.contentParts[request.partIndex]
          if (item.id !== request.recordId || item.turnId !== request.turnId || part?.kind !== 'resource' || part.resourceType !== 'text') {
            throw new AgentMuxError('The exact native content part changed.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
          }
          revalidateNativeContentReference(request.expectedReference, part.reference)
          authorizedReference = part.reference
          originalKind = item.kind
        }
        const result = await read(readNativeContentResource(context, { ...request, expectedReference: authorizedReference }, originalKind))
        await read(assertSource())
        return { ...identity, result: result.status === 'fragment' && authorizedReference !== request.expectedReference
          ? { ...result, continuationReference: authorizedReference } : result }
      }
      if (request.offsetBytes !== undefined) throw new AgentMuxError('Binary resources do not accept a text-content offset.', 'INVALID_AGENT_SESSION_HISTORY_RESOURCE')
      const item = await locateRecord(), part = item.contentParts[request.partIndex]
      if (item.id !== request.recordId || request.turnId !== undefined && item.turnId !== request.turnId)
        throw new AgentMuxError('The native lookup returned another record.', 'UNKNOWN_AGENT_SESSION_HISTORY_RECORD')
      if (request.markdownImage) {
        await read(assertSource())
        const result = await read(readRecordedMarkdownImage(part, request, request.maxBytes ?? SESSION_HISTORY_IMAGE_MAX_BYTES, controller.signal, item.kind))
        await read(assertSource())
        return { ...identity, result }
      }
      if (part?.kind !== 'resource' || part.resourceType !== (request.representation === 'file' ? 'file' : 'image') || part.reference !== request.expectedReference) {
        throw new AgentMuxError('The exact recorded resource changed or has another type.', 'AGENT_SESSION_HISTORY_RESOURCE_MISMATCH')
      }
      await read(assertSource())
      const result = await read(request.representation === 'file'
        ? readRecordedFile(part.reference, request.maxBytes ?? SESSION_HISTORY_IMAGE_MAX_BYTES, controller.signal, part.label)
        : readRecordedImage(part.reference, request.maxBytes ?? SESSION_HISTORY_IMAGE_MAX_BYTES, controller.signal))
      await read(assertSource())
      return { ...identity, ...(part.label === undefined ? {} : { label: part.label }), result }
    } finally {
      request.signal?.removeEventListener('abort', cancel)
      lifetime.close()
    }
  }

  private async managedNativeSessions(source: AgentNativeResumeSource): Promise<Array<NonNullable<AgentNativeSessionCandidate['managed']>>> {
    return (await this.managedNativeIndex()).get(JSON.stringify([source.nativeHandle.providerId, source.nativeHandle.sessionId])) ?? []
  }

  private async managedNativeIndex(): Promise<Map<string, Array<NonNullable<AgentNativeSessionCandidate['managed']>>>> {
    const [active, retired] = await Promise.all([loadAgentSessionMetadata(this.store), this.store.loadRetiredAgentSessions()])
    const index = new Map<string, Array<NonNullable<AgentNativeSessionCandidate['managed']>>>()
    const append = (handle: AgentNativeSessionHandle | undefined, managed: NonNullable<AgentNativeSessionCandidate['managed']>): void => {
      if (handle?.kind !== 'provider') return
      const key = JSON.stringify([handle.providerId, handle.sessionId]), bindings = index.get(key) ?? []
      bindings.push(managed); index.set(key, bindings)
    }
    for (const session of active) if (session.hostId === 'local') {
      const binding = { agentSessionId: session.agentSessionId, executorId: session.executorId, run: { ...session.run }, state: 'active' as const }
      append(session.nativeHandle, binding)
      // A witnessed source change still belongs to this original active Run.
      // Unconfirmed semantic rebinding never authorizes cloning that conversation.
      if (session.nativeSourceObservation?.state === 'changed' && !sameNativeHandle(session.nativeHandle, session.observedNativeHandle)) {
        append(session.observedNativeHandle, binding)
      }
      for (const candidate of session.nativeSourceObservation?.candidates ?? []) {
        if (!sameNativeHandle(candidate, session.nativeHandle)) append(candidate, binding)
      }
    }
    for (const session of retired) if (session.hostId === 'local' && session.history) append(session.history.nativeHandle, { agentSessionId: session.agentSessionId,
      executorId: session.history.executorId, run: { ...session.run }, state: 'retired', retiredAt: session.observedAt })
    return index
  }

  private async historyDescriptor(agentSessionId: string): Promise<AgentSessionHistoryDescriptor> {
    const descriptor = await this.store.readHistorySource(agentSessionId)
    if (!descriptor) throw new AgentMuxError(`Unknown Agent Session: ${agentSessionId}`, 'UNKNOWN_AGENT_SESSION')
    return descriptor
  }

  /** Resolve private launch/read configuration on its executing Host, never through a client projection. */
  private async sessionExecutorOptions<T extends Pick<AgentSessionHistoryPageOptions, 'commandOverride' | 'args' | 'env'>>(
    session: Pick<AgentMuxStoredAgentSession, 'executorId' | 'providerId' | 'creation'>, input: T, historyAgentSessionId?: string
  ): Promise<T> {
    const explicit = input.commandOverride !== undefined || input.args !== undefined || input.env !== undefined
    const targetOwned = session.creation?.executorRevision !== undefined
    // Native reading retains its Provider source independently of an unrelated
    // Executor registry. Host-owned creation authority survives retirement in
    // history metadata and still resolves its original private configuration.
    if (!targetOwned && (explicit || historyAgentSessionId !== undefined)) return input
    if (!this.hostExecutorOwner) {
      if (targetOwned) throw new AgentMuxError('The target Executor owner is unavailable. The original Session and Run are retained; restore its Host configuration.', 'CONTROL_UNAVAILABLE')
      return input
    }
    const { config } = await this.hostExecutorOwner.resolve(session.executorId)
    if (config.providerId !== session.providerId) throw new AgentMuxError('The target Executor Provider differs from the retained Session. Its original native identity and Run are retained.', 'EXECUTOR_PROVIDER_CONFLICT')
    return { ...input, commandOverride: config.command, args: config.args, env: config.env }
  }

  private activeNativeHistoryBinding(agentSessionId: string, source?: AgentSessionHistorySource): NativeHistoryBinding | undefined {
    // A failed save is not permission to make observation and Page read different sources.
    // The witness belongs to the existing Consumer resource, never a Session source cache.
    const resources = [...(this.historyObservationControllers.get(agentSessionId) ?? [])]
      .filter(resource => !resource.controller.signal.aborted && resource.binding?.transient &&
        (!source || resource.binding.handle.providerId === source.providerId && resource.binding.handle.sessionId === source.nativeSessionId))
    if (!resources.length) return
    const first = resources[0]!, binding = first.binding!
    if (resources.some(resource => !sameNativeHandle(resource.binding!.handle, binding.handle))) {
      throw new AgentMuxError('Current history observations disagree. The existing window is retained; refresh its source.',
        'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    }
    const assertCurrent = async (): Promise<void> => {
      if (first.controller.signal.aborted || first.binding !== binding) {
        throw new AgentMuxError('The temporary history observation was released. Refresh its source.',
          'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
      }
      await binding.assertCurrent()
    }
    return { ...binding, assertCurrent }
  }

  /** Resolve current-source intent once; ordinary durable history remains independent of Runtime. */
  private async nativeHistoryBinding(
    agentSessionId: string,
    options: AgentSessionHistoryPageOptions,
    signal: AbortSignal,
    purpose: 'read' | 'observe',
    source?: AgentSessionHistorySource
  ): Promise<NativeHistoryBinding> {
    if (purpose === 'read' && !options.refreshNativeSource && !options.nativeSource) {
      const active = this.activeNativeHistoryBinding(agentSessionId, source)
      if (active) {
        const executorOptions = await this.sessionExecutorOptions(active.session, options, agentSessionId)
        signal.throwIfAborted(); await active.assertCurrent(); signal.throwIfAborted()
        return { ...active, executorOptions }
      }
    }
    const descriptor = await this.historyDescriptor(agentSessionId)
    if (options.cursor === undefined && this.registry.has(agentSessionId)) this.hookNativeWitnesses.delete(this.registry.get(agentSessionId).run.runId)
    const session = descriptor.history
    if (!session) throw new AgentMuxError('No native history locator was retained for this Session.', 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
    const executorOptions = await this.sessionExecutorOptions(session, options, agentSessionId)
    const provider = this.providers.get(session.providerId)
    if (purpose === 'read' ? !provider.readSessionHistoryPage : !provider.observeSessionHistory) {
      throw new AgentMuxError('This Provider does not support this native history operation. Explicit reading remains available when supported.',
        purpose === 'read' ? 'AGENT_SESSION_HISTORY_UNSUPPORTED' : 'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED')
    }
    const retained = options.nativeSource === 'previous' ? session.previousNativeHandle : session.nativeHandle
    if (options.nativeSource === 'previous' && !retained) throw new AgentMuxError('This Session has no previous confirmed native source.', 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
    if (retained !== undefined && (retained.kind !== 'provider' || retained.providerId !== session.providerId)) {
      throw new AgentMuxError('The retained locator does not belong to this Provider history.',
        'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
    }
    if (source && (retained?.providerId !== source.providerId || retained.sessionId !== source.nativeSessionId)) {
      throw new AgentMuxError('The exact original native source is no longer retained. Its accepted records and Run are unchanged.',
        'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    }
    let handle = retained
    let transient = false
    let original: AgentMuxStoredAgentSession | undefined
    let sharedOwner: AgentMuxStoredAgentSession | undefined
    let assertWitness: (() => Promise<void>) | undefined
    let strictWitness: (() => Promise<void>) | undefined
    const retainedAvailable = retained?.kind === 'provider' && retained.providerId === session.providerId
    const wantsCurrent = !source && !options.nativeSource && (handle === undefined || purpose === 'observe' || options.refreshNativeSource === true)
    const canDiscover = descriptor.state === 'active' && descriptor.hostId === 'local' && this.connected &&
      this.kernel.isConnected() && provider.discoverNativeSession !== undefined
    if (options.requireCurrentSource && !canDiscover) throw new AgentMuxError('This read cannot confirm the current native source. The retained history and healthy Agent input remain available.', 'AGENT_CURRENT_NATIVE_SOURCE_UNCONFIRMED')
    if (wantsCurrent && !canDiscover && handle === undefined) {
      throw new AgentMuxError('The native identity is not yet confirmed. Refresh can retry; the original Run is kept.',
        'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
    }
    if (wantsCurrent && canDiscover) {
      const epoch = this.connectionEpoch
      original = (await this.store.readMetadata(agentSessionId)) ?? undefined
      if (!original || original.hostId !== descriptor.hostId || original.providerId !== session.providerId ||
        original.workspacePath !== session.workspacePath || !sameNativeHandle(original.nativeHandle, retained)) {
        throw new AgentMuxError('The native Session binding changed before discovery.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
      }
      const expected = original
      const checkStored = async (): Promise<AgentMuxStoredAgentSession> => {
        signal.throwIfAborted()
        const current = await this.store.readMetadata(agentSessionId)
        if (sharedOwner) {
          const owner = await this.store.readMetadata(sharedOwner.agentSessionId)
          if (!owner || owner.hostId !== sharedOwner.hostId || owner.providerId !== sharedOwner.providerId ||
            owner.workspacePath !== sharedOwner.workspacePath || owner.createdAt !== sharedOwner.createdAt ||
            !sameRun(owner.run, sharedOwner.run) || !sameNativeHandle(owner.nativeHandle, sharedOwner.nativeHandle)) {
            throw new AgentMuxError('The shared native history owner changed. Refresh its current source; existing records and input are kept.',
              'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
          }
        }
        if (!current || current.hostId !== expected.hostId || !sameRun(current.run, expected.run) ||
          current.providerId !== expected.providerId || current.workspacePath !== expected.workspacePath ||
          (!sameNativeHandle(current.nativeHandle, retained) && !sameNativeHandle(current.nativeHandle, handle))) {
          throw new AgentMuxError('The original Session or native identity changed during discovery.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
        }
        return current
      }
      const diagnose = (message: string, identityUnconfirmed = false, persistenceFailure?: string): void => this.publisher.publish({ type: 'agent-error', agentSessionId,
        code: persistenceFailure === undefined ? 'AGENT_NATIVE_SOURCE_UNCONFIRMED' : 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED',
        message: persistenceFailure !== undefined
          ? `Saving the unconfirmed native-source observation failed: ${persistenceFailure}. The retained records and Agent input remain available; Refresh retries confirmation and saving. ${message}`
          : identityUnconfirmed
          ? `${message} Agent input remains available; Refresh retries confirmation.`
          : `The current native source could not be confirmed. The retained records and Agent input remain available; Refresh retries confirmation. ${message}`,
        evidence: { source: 'agentmux', run: { ...expected.run }, observedAt: Date.now() } })
      try {
        const firstRun = await this.kernel.status(expected.run.runId)
        if (firstRun.runId !== expected.run.runId || firstRun.workspacePath !== expected.workspacePath ||
          firstRun.state.type !== 'running' || !Number.isSafeInteger(firstRun.pid) || !firstRun.pid || firstRun.pid <= 0) {
          throw new AgentMuxError('The original running process could not be confirmed for native discovery.',
            'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
        }
        const checkRun = async (): Promise<AgentMuxStoredAgentSession> => {
          signal.throwIfAborted()
          if (!this.connected || !this.kernel.isConnected() || this.connectionEpoch !== epoch) {
            throw new AgentMuxError('The Runtime observation changed during native discovery.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
          }
          const current = await checkStored()
          const run = await this.kernel.status(expected.run.runId)
          signal.throwIfAborted()
          if (run.runId !== expected.run.runId || run.workspacePath !== expected.workspacePath ||
            run.state.type !== 'running' || run.pid !== firstRun.pid || this.connectionEpoch !== epoch || !this.kernel.isConnected()) {
            throw new AgentMuxError('The original Run process changed during native discovery.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
          }
          return current
        }
        const discovery = await provider.discoverNativeSession!({ processId: firstRun.pid,
          command: resolveAgentExecutable(executorOptions.commandOverride, provider.executable),
          args: executorOptions.args ?? [], env: executorOptions.env ?? {}, workspacePath: session.workspacePath, signal })
        signal.throwIfAborted()
        const selected = hasSelectedNativeTarget(expected) && !options.requireCurrentSource
        const discovered = resolveNativeSessionWitness(discovery, selected ? expected.nativeHandle : undefined)
        const members = discovery?.candidates ?? (selected && discovery?.handle && discovery.assertPresent ? [discovery] : undefined)
        if (members) {
          await checkRun()
          const candidates = members.map(member => ({ ...member.handle }))
          const observed = await this.registry.update(agentSessionId, expected.run, value => {
            if (!sameNativeHandle(value.nativeHandle, retained)) throw new AgentMuxError('The original target changed during discovery.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
            if (value.nativeSourceObservation?.state === 'ambiguous' && isDeepStrictEqual(value.nativeSourceObservation.candidates, candidates)) return value
            const observedAt = Math.max(Date.now(), value.updatedAt + 1), next = { ...value, updatedAt: observedAt,
              nativeSourceObservation: { state: 'ambiguous' as const, run: { ...value.run }, observedAt,
                reason: 'frontend-selection-unconfirmed', candidates } }
            delete next.observedNativeHandle
            return next
          }, signal)
          this.publishSession(observed)
        }
        if (!discovered || discovered.handle.kind !== 'provider' || discovered.handle.providerId !== session.providerId ||
          normalizeNativeSessionId(discovered.handle.sessionId) !== discovered.handle.sessionId ||
          (discovered.handle.transcriptPath !== undefined &&
            normalizeNativeTranscriptPath(discovered.handle.transcriptPath) !== discovered.handle.transcriptPath)) {
          throw new AgentMuxError('No current main native Session was confirmed. Select a verified Run candidate; the original Run is kept.',
            members ? 'AGENT_NATIVE_IDENTITY_UNCONFIRMED' : 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
        }
        handle = { ...discovered.handle,
          ...(retained?.kind === 'provider' && retained.providerId === discovered.handle.providerId &&
            retained.sessionId === discovered.handle.sessionId && discovered.handle.transcriptPath === undefined &&
            retained.transcriptPath !== undefined ? { transcriptPath: retained.transcriptPath } : {}) }
        const protectsDifferentTarget = (value: AgentMuxStoredAgentSession): boolean =>
          // A reading-only retained locator may acquire its first current-main binding.
          // Any existing conversation authority requires explicit confirmation instead.
          (value.nativeBinding !== undefined || value.reopenedFrom !== undefined || value.pendingInteraction !== undefined ||
            value.terminalPromptReadiness !== undefined || value.promptCompletionAdmission !== undefined ||
            value.terminalPromptSubmission !== undefined || value.nativePromptPredecessor !== undefined || value.hookReceipt !== undefined ||
            value.semanticStatus !== undefined || value.turnUsage !== undefined) &&
          value.nativeHandle !== undefined && (value.nativeHandle.kind !== handle!.kind ||
            value.nativeHandle.sessionId !== handle!.sessionId ||
            (value.nativeHandle.kind === 'provider' && handle!.kind === 'provider' &&
              (value.nativeHandle.providerId !== handle!.providerId ||
                (value.nativeHandle.transcriptPath !== undefined && handle!.transcriptPath !== undefined &&
                  value.nativeHandle.transcriptPath !== handle!.transcriptPath))))
        assertWitness = async () => { await checkRun(); await discovered.assertValid(); await checkRun() }
        await assertWitness()
        if (options.requireCurrentSource) strictWitness = assertWitness
        const current = await checkRun()
        if (!sameNativeHandle(current.nativeHandle, handle) || current.observedNativeHandle !== undefined || current.nativeSourceObservation !== undefined) {
          await this.registry.refresh(agentSessionId, expected.run)
          await assertWitness()
          let indexedOwner: AgentMuxStoredAgentSession | undefined
          try {
            indexedOwner = this.registry.resolve({ kind: 'provider-native', providerId: handle.providerId, sessionId: handle.sessionId })
          } catch (error) {
            if (!(error instanceof AgentMuxError) || error.code !== 'UNKNOWN_AGENT_SESSION_BINDING') throw error
          }
          const durableOwner = (await loadAgentSessionMetadata(this.store)).find(value => value.hostId === expected.hostId &&
            value.nativeHandle?.kind === 'provider' && value.nativeHandle.providerId === handle!.providerId &&
            value.nativeHandle.sessionId === handle!.sessionId)
          if (indexedOwner?.agentSessionId !== durableOwner?.agentSessionId) {
            throw new AgentMuxError('Native source ownership changed during confirmation. Refresh its exact source.',
              'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
          }
          if (durableOwner && durableOwner.agentSessionId !== agentSessionId && protectsDifferentTarget(current)) {
            const observed = await this.registry.update(agentSessionId, expected.run, value => {
              if (!protectsDifferentTarget(value) || !sameNativeHandle(value.nativeHandle, retained)) {
                throw new AgentMuxError('The original resume target changed during confirmation.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
              }
              return { ...value, observedNativeHandle: handle!, updatedAt: Math.max(value.updatedAt, Date.now()) }
            }, signal)
            this.publishSession(observed)
            throw new AgentMuxError(
              'The confirmed current source differs from the explicit semantic resume target. The target and retained records were kept; this refresh did not change the conversation.',
              'AGENT_NATIVE_IDENTITY_UNCONFIRMED')
          }
          if (durableOwner && durableOwner.agentSessionId !== agentSessionId) {
            // This Run proves a readable source, not permission to take another Session's identity.
            sharedOwner = durableOwner
            transient = true
            await assertWitness()
            this.publisher.publish({ type: 'agent-error', agentSessionId,
              code: 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED',
              message: 'The confirmed current conversation is already bound to another Agent Session. Both identities are kept; its records remain readable while this observation is active. Agent input remains available.',
              evidence: { source: 'agentmux', run: { ...expected.run }, observedAt: Date.now() } })
          } else try {
            const next = await this.registry.update(agentSessionId, expected.run, value => {
              if (value.hostId !== expected.hostId || value.providerId !== expected.providerId ||
                value.workspacePath !== expected.workspacePath ||
                (!sameNativeHandle(value.nativeHandle, retained) && !sameNativeHandle(value.nativeHandle, handle))) {
                throw new AgentMuxError('Native discovery cannot replace a concurrent confirmed identity.',
                  'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
              }
              const observedAt = Math.max(Date.now(), value.updatedAt + 1)
              if (protectsDifferentTarget(value)) return { ...value, observedNativeHandle: handle!,
                nativeSourceObservation: { state: 'changed', run: { ...value.run }, observedAt, reason: 'current-main-differs' },
                updatedAt: observedAt }
              const next = { ...value, nativeHandle: handle!,
                nativeBinding: { source: value.nativeBinding?.source ?? (value.reopenedFrom !== undefined
                  ? 'semantic-resume-target' as const : 'process-witness' as const),
                  run: { ...value.run }, observedAt }, updatedAt: Math.max(value.updatedAt, observedAt) }
              delete next.observedNativeHandle
              if (!selected) delete next.nativeSourceObservation
              return next
            }, signal)
            this.publishSession(next)
            if (protectsDifferentTarget(next)) throw new AgentMuxError(
              'The confirmed current source differs from the explicit semantic resume target. The target and retained records were kept; this refresh did not change the conversation.',
              'AGENT_NATIVE_IDENTITY_UNCONFIRMED')
            await this.ensureNativeStatusObservation(next)
          } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
            // A durable commit can report an error after writing; confirm it without reintroducing Runtime.
            const saved = await checkStored()
            if (protectsDifferentTarget(saved)) throw new AgentMuxError(
              'The confirmed current source differs from the explicit semantic resume target. The target and retained records were kept; this refresh did not change the conversation.',
              'AGENT_NATIVE_IDENTITY_UNCONFIRMED')
            if (sameNativeHandle(saved.nativeHandle, handle)) {
              // The same source was durably confirmed by this or another operation.
            } else if (['EIO', 'ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EMFILE', 'ENFILE',
              'AGENT_SESSION_STORE_LIMIT', 'AGENT_SESSION_STORE_BUSY'].includes(code)) {
              await assertWitness()
              transient = true
              this.publisher.publish({ type: 'agent-error', agentSessionId,
                code: 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED',
                message: 'Saving the current native locator failed. Reading its confirmed records continues while this read or observation is active; Refresh retries saving. Agent input remains available.',
                evidence: { source: 'agentmux', run: { ...expected.run }, observedAt: Date.now() } })
            } else throw error
          }
        }
        if (!transient) assertWitness = undefined
        else await assertWitness()
      } catch (error) {
        signal.throwIfAborted()
        if (options.requireCurrentSource) { diagnose(error instanceof Error ? error.message : 'Current native source confirmation failed.'); throw error }
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        // Only a failed observation can fall back to an unchanged retained source. Identity conflicts cannot.
        if (!retainedAvailable || code === 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' || code === 'STALE_AGENT_SESSION' || transient) throw error
        await checkStored()
        handle = retained
        assertWitness = undefined
        let persistenceFailure: string | undefined
        if (code !== 'AGENT_NATIVE_IDENTITY_UNCONFIRMED') {
          try {
            const next = await this.registry.update(agentSessionId, expected.run, value => {
              if (!sameNativeHandle(value.nativeHandle, retained)) throw new AgentMuxError('The original failed source observation is stale.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
              const observedAt = Math.max(Date.now(), value.updatedAt + 1), result = { ...value, updatedAt: observedAt,
                nativeSourceObservation: { state: code === 'AGENT_NATIVE_IDENTITY_AMBIGUOUS' ? 'ambiguous' as const : 'unknown' as const,
                  run: { ...value.run }, observedAt, reason: 'current-main-unconfirmed' } }
              delete result.observedNativeHandle
              return result
            }, signal)
            this.publishSession(next)
          } catch (saveError) {
            const saveCode = saveError && typeof saveError === 'object' && 'code' in saveError ? String(saveError.code) : ''
            if (saveCode === 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' || saveCode === 'STALE_AGENT_SESSION') throw saveError
            await checkStored()
            persistenceFailure = saveError instanceof Error ? saveError.message : 'The observation could not be saved'
          }
        }
        diagnose(error instanceof Error ? error.message : 'Provider source observation failed.', code === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', persistenceFailure)
      }
      this.hookNativeWitnesses.delete(expected.run.runId)
    }
    if (handle?.kind !== 'provider' || handle.providerId !== session.providerId) {
      throw new AgentMuxError('The exact native Session identity is not available.', 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
    }
    const acceptedHandle = handle
    const matches = (current: AgentSessionHistoryMetadata, hostId: string, run?: AgentMuxRunRef): boolean => {
      if (hostId !== descriptor.hostId || current.providerId !== session.providerId || current.workspacePath !== session.workspacePath) return false
      if (sharedOwner) return transient && original !== undefined && run !== undefined &&
        sameRun(run, original.run) && sameNativeHandle(current.nativeHandle, retained)
      if (sameNativeHandle(options.nativeSource === 'previous' ? current.previousNativeHandle : current.nativeHandle, acceptedHandle)) {
        // A real durable publication ends the temporary fence, including an A→B→A transition.
        transient = false
        assertWitness = undefined
        return true
      }
      return transient && original !== undefined && run !== undefined &&
        sameRun(run, original.run) && sameNativeHandle(current.nativeHandle, retained)
    }
    const assertCurrent = async (): Promise<void> => {
      signal.throwIfAborted()
      if (strictWitness) await strictWitness()
      const current = await this.historyDescriptor(agentSessionId)
      const sameMetadata = current.history && current.hostId === descriptor.hostId &&
        current.history.providerId === session.providerId && current.history.workspacePath === session.workspacePath
      if (sharedOwner) {
        if (!original || current.state !== 'active' || !sameMetadata ||
          !sameNativeHandle(current.history!.nativeHandle, retained)) {
          throw new AgentMuxError('The borrowed native history binding changed. Refresh its exact source.',
            'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
        }
        await assertWitness!()
      } else if (sameMetadata && sameNativeHandle(options.nativeSource === 'previous' ? current.history!.previousNativeHandle : current.history!.nativeHandle, acceptedHandle)) {
        transient = false
        assertWitness = undefined
      } else if (transient && original && current.state === 'active' && sameMetadata &&
        sameNativeHandle(current.history!.nativeHandle, retained)) {
        await assertWitness!()
      } else {
        throw new AgentMuxError('Native history identity changed while reading; reopen its newest page.',
          'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
      }
      signal.throwIfAborted()
      if (strictWitness) await strictWitness()
    }
    await assertCurrent()
    return { sourceHostId: descriptor.hostId, session, provider, executorOptions, handle: acceptedHandle, get transient() { return transient }, matches, assertCurrent }
  }

  /** Read existing Provider conversation history without controlling the Session's Run. */
  async sessionHistoryPage(
    agentSessionId: string,
    options: AgentSessionHistoryPageOptions = {}
  ): Promise<AgentSessionHistoryPage> {
    return this.readSessionHistoryPage(agentSessionId, options)
  }

  private async readSessionHistoryPage(agentSessionId: string, options: AgentSessionHistoryPageOptions,
    originalSource?: AgentSessionHistorySource): Promise<AgentSessionHistoryPage> {
    if (this.providerReadsDisposed) {
      throw new AgentMuxError('History reading client was disposed.', 'AGENT_SESSION_HISTORY_CANCELLED')
    }
    const limit = options.limit ?? 30
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (options.cursor !== undefined && (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 16_384)) ||
      (options.refreshNativeSource !== undefined && typeof options.refreshNativeSource !== 'boolean') ||
      (options.requireCurrentSource !== undefined && options.requireCurrentSource !== true) ||
      (options.requireCurrentSource === true && options.refreshNativeSource !== true) ||
      (options.signal !== undefined && !(options.signal instanceof AbortSignal)) ||
      (options.nativeSource !== undefined && options.nativeSource !== 'previous') ||
      (options.nativeSource !== undefined && options.refreshNativeSource === true) ||
      (options.refreshNativeSource === true && options.cursor !== undefined)) {
      throw new AgentMuxError('History page requires a finite limit from 1 to 100 and an opaque cursor.', 'INVALID_AGENT_SESSION_HISTORY_OPTIONS')
    }
    if (this.providerReads.size >= PROVIDER_READ_MAX_CONCURRENT) {
      throw new AgentMuxError('History reading is busy; retry after the current page finishes.', 'AGENT_SESSION_HISTORY_BUSY')
    }
    options.signal?.throwIfAborted()
    const lifetime = this.providerReadLifetime('history')
    const { controller, read } = lifetime
    const cancelled = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', cancelled, { once: true })
    try {
      const binding = await read(this.nativeHistoryBinding(agentSessionId, options, controller.signal, 'read', originalSource))
      const { session, provider, handle } = binding
      options = { ...options, ...binding.executorOptions }
      if (!provider.readSessionHistoryPage) {
        throw new AgentMuxError('This Provider does not expose native conversation history.', 'AGENT_SESSION_HISTORY_UNSUPPORTED')
      }
      const source = { providerId: session.providerId, nativeSessionId: handle.sessionId }
      const contentSigningSecret = (await read(this.store.readMetadata(agentSessionId)))?.hookToken
      const page = await read(provider.readSessionHistoryPage({
        agentSessionId, ...(contentSigningSecret === undefined ? {} : { contentSigningSecret }), source, limit, signal: controller.signal,
        command: resolveAgentExecutable(options.commandOverride, provider.executable),
        args: options.args ?? [], env: options.env ?? {}, workspacePath: session.workspacePath,
        ...(handle.transcriptPath === undefined ? {} : { transcriptPath: handle.transcriptPath }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor })
      }))
      controller.signal.throwIfAborted()
      await read(binding.assertCurrent())
      const normalized = normalizeSessionHistoryPage(source, page, limit)
      const items = await read(confirmNativeInputAdoptions(normalized.items, { hostId: binding.sourceHostId, agentSessionId }, source, key => this.inspectAgentPromptSubmission(key), controller.signal))
      await this.observeNotificationAdoptions(items)
      return { agentSessionId, sourceHostId: binding.sourceHostId, ...normalizeSessionHistoryPage(source, { ...normalized, items }, limit) }
    } finally {
      options.signal?.removeEventListener('abort', cancelled)
      lifetime.close()
    }
  }

  /** A durable original Provider cut: current tail by default, or an explicit cut-only beginning. */
  async sessionHistoryCheckpoint(agentSessionId: string, options: Pick<AgentSessionHistoryPageOptions, 'signal' | 'commandOverride' | 'args' | 'env' | 'nativeSource'> & { position?: 'beginning' } = {}): Promise<NativeConversationCheckpoint> {
    if (options.position !== undefined && options.position !== 'beginning') throw new AgentMuxError('Native checkpoint position must be beginning when supplied.', 'INVALID_CONTROL_REQUEST')
    const page = await this.nativeHistoryChangesPage(agentSessionId, { ...options, ...(options.position === 'beginning' ? { head: true as const } : { tail: true as const }) })
    return page.checkpoint
  }

  /** Resume after a persisted source cut; notifications only wake this authoritative read. */
  async readSessionHistoryChanges(agentSessionId: string, options: Pick<AgentSessionHistoryPageOptions, 'signal' | 'commandOverride' | 'args' | 'env' | 'limit' | 'nativeSource'> & { checkpoint: NativeConversationCheckpoint }): Promise<NativeConversationChangesPage> {
    const checkpoint = parseNativeConversationCheckpoint(options.checkpoint)
    if (checkpoint.agentSessionId !== agentSessionId) throw new AgentMuxError('The checkpoint belongs to another original Session.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    return this.nativeHistoryChangesPage(agentSessionId, { ...options, checkpoint })
  }

  private async nativeHistoryChangesPage(agentSessionId: string, options: Pick<AgentSessionHistoryPageOptions, 'signal' | 'commandOverride' | 'args' | 'env' | 'limit' | 'nativeSource'> & { checkpoint?: NativeConversationCheckpoint; tail?: true; head?: true },
    originalSource?: AgentSessionHistorySource): Promise<NativeConversationChangesPage> {
    if (this.providerReadsDisposed) throw new AgentMuxError('Conversation reader was disposed.', 'AGENT_SESSION_HISTORY_CANCELLED')
    const limit = options.limit ?? 30
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AgentMuxError('Changes require a finite limit from 1 to 100.', 'INVALID_AGENT_SESSION_HISTORY_OPTIONS')
    if (this.providerReads.size >= PROVIDER_READ_MAX_CONCURRENT) throw new AgentMuxError('Conversation reading is busy; retry this original checkpoint.', 'AGENT_SESSION_HISTORY_BUSY')
    options.signal?.throwIfAborted()
    const lifetime = this.providerReadLifetime('history'), { controller, read } = lifetime
    const cancel = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      const binding = await read(this.nativeHistoryBinding(agentSessionId, options, controller.signal, 'read', originalSource))
      const { provider, session, handle } = binding, source = { providerId: session.providerId, nativeSessionId: handle.sessionId }
      if (!provider.readConversationChanges) throw new AgentMuxError('This Provider cannot resume durable changes. Existing history and Agent input remain available.', 'AGENT_CONVERSATION_CHANGES_UNSUPPORTED')
      if (options.checkpoint && (options.checkpoint.source.providerId !== source.providerId || options.checkpoint.source.nativeSessionId !== source.nativeSessionId))
        throw new AgentMuxError('The original native conversation source changed. Keep its checkpoint and inspect the new sharing boundary.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
      const executor = binding.executorOptions, contentSigningSecret = (await read(this.store.readMetadata(agentSessionId)))?.hookToken
      const page = await read(provider.readConversationChanges({ agentSessionId, source, limit, signal: controller.signal,
        command: resolveAgentExecutable(executor.commandOverride, provider.executable), args: executor.args ?? [], env: executor.env ?? {}, workspacePath: session.workspacePath,
        ...(contentSigningSecret === undefined ? {} : { contentSigningSecret }), ...(handle.transcriptPath === undefined ? {} : { transcriptPath: handle.transcriptPath }),
        ...(options.checkpoint ? { after: options.checkpoint.cursor } : {}), ...(options.tail ? { tail: true as const } : {}), ...(options.head ? { head: true as const } : {}) }))
      await read(binding.assertCurrent())
      const checkpoint = { agentSessionId, source, cursor: page.cursor }, ref = { hostId: 'local', agentSessionId }
      const normalized = parseNativeConversationChangesPage({ ...ref, source: page.source, items: page.items, checkpoint, more: page.more }, { ...ref, checkpoint: options.checkpoint ?? checkpoint, limit })
      const items = await read(confirmNativeInputAdoptions(normalized.items, { hostId: binding.sourceHostId, agentSessionId }, source, key => this.inspectAgentPromptSubmission(key), controller.signal))
      await this.observeNotificationAdoptions(items)
      return { ...normalized, items: normalizeSessionHistoryPage(source, { source, items, nextCursor: null }, limit).items }
    } finally { options.signal?.removeEventListener('abort', cancel); lifetime.close() }
  }

  /** Read exact recorded content in its original native source; caller fields never authorize a path. */
  async sessionHistoryResource(agentSessionId: string, input: AgentSessionHistoryResourceReadOptions): Promise<AgentSessionHistoryResourceReadResult> {
    const checked = parseSessionHistoryResourceOptions(input)
    input = { ...checked, source: { ...checked.source },
      ...(checked.args ? { args: [...checked.args] } : {}), ...(checked.env ? { env: { ...checked.env } } : {}) }
    if (this.providerReadsDisposed) throw new AgentMuxError('History reading client was disposed.', 'AGENT_SESSION_HISTORY_CANCELLED')
    if (this.providerReads.size >= PROVIDER_READ_MAX_CONCURRENT) throw new AgentMuxError('History reading is busy; retry this resource.', 'AGENT_SESSION_HISTORY_BUSY')
    input.signal?.throwIfAborted()
    const lifetime = this.providerReadLifetime('history'), { controller, read } = lifetime
    const cancel = (): void => controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', cancel, { once: true })
    try {
      const retained = await read(this.historyDescriptor(agentSessionId))
      const previous = retained.history?.previousNativeHandle
      const matchesPrevious = previous?.providerId === input.source.providerId && previous.sessionId === input.source.nativeSessionId &&
        retained.history?.nativeHandle?.sessionId !== input.source.nativeSessionId
      const binding = await read(this.nativeHistoryBinding(agentSessionId, { ...input, ...(matchesPrevious ? { nativeSource: 'previous' as const } : {}) }, controller.signal, 'read'))
      const { session, provider, handle } = binding
      input = { ...input, ...binding.executorOptions }
      const source = { providerId: session.providerId, nativeSessionId: handle.sessionId }
      if (source.providerId !== input.source.providerId || source.nativeSessionId !== input.source.nativeSessionId)
        throw new AgentMuxError('The resource belongs to another native source.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
      const identity = { agentSessionId, source, ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        recordId: input.recordId, partIndex: input.partIndex }
      if (isNativeContentReference(input.expectedReference)) {
        const contentSigningSecret = (await read(this.store.readMetadata(agentSessionId)))?.hookToken
        const context = { agentSessionId, ...(contentSigningSecret === undefined ? {} : { contentSigningSecret }), source, signal: controller.signal,
          command: resolveAgentExecutable(input.commandOverride, provider.executable), args: input.args ?? [], env: input.env ?? {},
          workspacePath: session.workspacePath, ...(handle.transcriptPath === undefined ? {} : { transcriptPath: handle.transcriptPath }) }
        let authorizedReference = input.expectedReference
        let originalKind: AgentSessionHistoryItem['kind'] | undefined
        if (input.markdownImage || nativeContentNeedsRevalidation(input.expectedReference, contentSigningSecret)) {
          // The Provider reissues a retired credential's exact extent. Markdown file IO also
          // needs its original speaker and purpose even when the signed text remains valid.
          let cursor: string | undefined
          for (;;) {
            const page = provider.readSessionHistoryRecord
              ? { items: [await read(provider.readSessionHistoryRecord({ ...context, recordId: input.recordId, ...(input.turnId === undefined ? {} : { turnId: input.turnId }) }))], nextCursor: null }
              : await read(provider.readSessionHistoryPage!({ ...context, limit: 100, ...(cursor === undefined ? {} : { cursor }) }))
            const item = page.items.find(value => value.id === input.recordId && value.turnId === input.turnId)
            if (item) {
              const part = item.contentParts[input.partIndex]
              if (part?.kind !== 'resource' || part.resourceType !== 'text') throw new AgentMuxError('The original native content is no longer the same resource.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
              revalidateNativeContentReference(input.expectedReference, part.reference, contentSigningSecret)
              authorizedReference = part.reference; originalKind = item.kind; break
            }
            if (!page.nextCursor) throw new AgentMuxError('The original native record is no longer present.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
            if (page.nextCursor === cursor) throw new AgentMuxError('The native Provider did not advance the exact-record search.', 'INVALID_AGENT_SESSION_HISTORY_PAGE')
            cursor = page.nextCursor
          }
        }
        const result = await read(readNativeContentResource(context, { ...input, expectedReference: authorizedReference }, originalKind))
        await read(binding.assertCurrent())
        return { ...identity, reference: input.expectedReference, result: result.status === 'fragment' && authorizedReference !== input.expectedReference
          ? { ...result, continuationReference: authorizedReference } : result }
      }
      if (input.offsetBytes !== undefined) throw new AgentMuxError('Binary resources do not accept a text-content offset.', 'INVALID_AGENT_SESSION_HISTORY_RESOURCE')
      if (!provider.readSessionHistoryRecord) return { ...identity, reference: input.expectedReference,
        result: { status: 'unavailable', code: 'AGENT_SESSION_HISTORY_RECORD_UNSUPPORTED',
          message: 'This Provider cannot locate an exact native record. The original resource reference remains available.' } }
      const located = await read(provider.readSessionHistoryRecord({ source, recordId: input.recordId,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }), signal: controller.signal,
        command: resolveAgentExecutable(input.commandOverride, provider.executable), args: input.args ?? [], env: input.env ?? {},
        workspacePath: session.workspacePath, ...(handle.transcriptPath === undefined ? {} : { transcriptPath: handle.transcriptPath }) }))
      const record = normalizeSessionHistoryPage(source, { source, items: [located], nextCursor: null }, 1).items[0]!
      if (record.id !== input.recordId || input.turnId !== undefined && record.turnId !== input.turnId)
        throw new AgentMuxError('The native lookup returned another record.', 'UNKNOWN_AGENT_SESSION_HISTORY_RECORD')
      const part = record.contentParts[input.partIndex]
      if (input.markdownImage) {
        await read(binding.assertCurrent())
        const result = await read(readRecordedMarkdownImage(part, input, input.maxBytes ?? SESSION_HISTORY_IMAGE_MAX_BYTES, controller.signal, record.kind))
        await read(binding.assertCurrent())
        return { ...identity, reference: input.expectedReference, result }
      }
      if (!part || part.kind !== 'resource' || part.resourceType !== (input.representation === 'file' ? 'file' : 'image') || part.reference !== input.expectedReference)
        throw new AgentMuxError('The exact resource part changed or has another type.', 'AGENT_SESSION_HISTORY_RESOURCE_MISMATCH')
      await read(binding.assertCurrent())
      const result = await read(input.representation === 'file'
        ? readRecordedFile(part.reference, input.maxBytes ?? SESSION_HISTORY_IMAGE_MAX_BYTES, controller.signal, part.label)
        : readRecordedImage(part.reference, input.maxBytes ?? SESSION_HISTORY_IMAGE_MAX_BYTES, controller.signal))
      await read(binding.assertCurrent())
      return { ...identity, reference: part.reference, ...(part.label === undefined ? {} : { label: part.label }), result }
    } finally { input.signal?.removeEventListener('abort', cancel); lifetime.close() }
  }

  /** Observe an exact durable native source only while a Consumer needs it. No Runtime connection. */
  async observeSessionHistory(
    agentSessionId: string,
    listener: (observation: AgentSessionHistoryObservation) => void,
    options: AgentSessionHistoryObservationOptions = {}
  ): Promise<AgentSessionHistoryObservationHandle> {
    if (this.providerReadsDisposed) throw new AgentMuxError('History observer client was disposed.', 'AGENT_SESSION_HISTORY_CANCELLED')
    options.signal?.throwIfAborted()
    const invocation = {
      ...(options.nativeSource ? { nativeSource: options.nativeSource } : {}),
      ...(options.commandOverride === undefined ? {} : { commandOverride: options.commandOverride }),
      ...(options.args === undefined ? {} : { args: [...options.args] }),
      ...(options.env === undefined ? {} : { env: { ...options.env } })
    }
    // Missing overrides and explicit empty overrides have different Executor-owner semantics.
    const key = JSON.stringify([agentSessionId, invocation.nativeSource ?? null, invocation.commandOverride ?? null, invocation.args ?? null,
      invocation.env === undefined ? null : Object.entries(invocation.env).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)])
    return await this.historyObservationPool.observe(key, listener, options.signal, (signal, notify, released) =>
      this.acquireSessionHistoryObservation(agentSessionId, notify, { ...invocation, signal }, released))
  }

  private async acquireSessionHistoryObservation(
    agentSessionId: string,
    listener: (observation: AgentSessionHistoryObservation) => void,
    options: AgentSessionHistoryObservationOptions,
    onRelease: (reason: unknown) => void
  ): Promise<AgentSessionHistoryObservationHandle> {
    options.signal?.throwIfAborted()
    const controller = new AbortController()
    const resources = this.historyObservationControllers.get(agentSessionId) ?? new Set<NativeHistoryObservationResource>()
    this.historyObservationControllers.set(agentSessionId, resources)
    const resource: NativeHistoryObservationResource = { controller, binding: null }
    resources.add(resource)
    let observer: AgentSessionHistoryObservationHandle | undefined
    const sourceClosed = (): void => controller.abort(observer?.closed?.reason ?? new AgentMuxError(
      'The native history observation resource was released.', 'AGENT_SESSION_HISTORY_CANCELLED'))
    let unsubscribe = (): void => {}
    const cancel = (): void => controller.abort(options.signal?.reason ??
      new AgentMuxError('History observation was cancelled.', 'AGENT_SESSION_HISTORY_CANCELLED'))
    options.signal?.addEventListener('abort', cancel, { once: true })
    let rejectCancelled!: (reason: unknown) => void
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject })
    const timer = setTimeout(() => controller.abort(new AgentMuxError(
      'Native source observation could not be established. Refresh remains available.',
      'AGENT_SESSION_HISTORY_OBSERVATION_TIMEOUT'
    )), SESSION_HISTORY_TIMEOUT_MS)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      clearTimeout(timer)
      observer?.closed?.removeEventListener('abort', sourceClosed)
      observer?.dispose()
      unsubscribe()
      options.signal?.removeEventListener('abort', cancel)
      resource.binding = null
      resources.delete(resource)
      if (!resources.size) this.historyObservationControllers.delete(agentSessionId)
      onRelease(controller.signal.reason)
    }
    controller.signal.addEventListener('abort', () => {
      release()
      rejectCancelled(controller.signal.reason)
    }, { once: true })
    const notify = (observation: AgentSessionHistoryObservation): void => {
      if (controller.signal.aborted) return
      try { listener(observation) } catch {
        // As for onEvent, Consumer callbacks cannot become part of healthy
        // Run transport or lifecycle control. Their reporting belongs to them.
      }
    }
    try {
      const binding = await Promise.race([this.nativeHistoryBinding(agentSessionId, options, controller.signal, 'observe'), cancelled])
      const { session, provider, handle, matches } = binding
      options = { ...options, ...binding.executorOptions }
      if (!provider.observeSessionHistory) {
        throw new AgentMuxError('This Provider does not support automatic native history observation. Explicit Refresh remains available.', 'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED')
      }
      const source = { providerId: session.providerId, nativeSessionId: handle.sessionId }
      unsubscribe = this.publisher.onStatusEvent((event) => {
        // Only a true locator binding change can invalidate this watch. Ordinary
        // updatedAt/status/PTY events must never cause a rebind or a page read.
        if (event.type !== 'agent-session' || event.session.agentSessionId !== agentSessionId ||
          matches(event.session, event.session.hostId, event.session.run)) return
        notify({ kind: 'unavailable', agentSessionId, source, code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED',
          message: 'The native history binding changed. The previous window is retained; explicitly refresh its source.' })
        controller.abort(new AgentMuxError('Native history binding changed.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'))
      })
      let pendingChange: AgentSessionHistoryObservation | null = null
      let checkingChange = false
      const flushChange = (): void => {
        if (checkingChange || !pendingChange || resource.binding !== binding || controller.signal.aborted) return
        checkingChange = true
        void (async () => {
          try {
            while (pendingChange && !controller.signal.aborted && resource.binding === binding) {
              const observation = pendingChange
              pendingChange = null
              await binding.assertCurrent()
              if (!controller.signal.aborted && resource.binding === binding) notify({ ...observation, agentSessionId })
            }
          } catch (error) {
            if (!controller.signal.aborted && resource.binding === binding) {
              const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                ? error.code : 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE'
              notify({ kind: 'unavailable', agentSessionId, source, code,
                message: error instanceof Error ? error.message : 'The current native source could not be confirmed. Existing records and input are kept.' })
              // A failed source check does not retire the exact native watch. Only an
              // actual identity change or cancellation ends it; a new event can revalidate.
              if (code === 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' || code === 'AGENT_SESSION_HISTORY_CANCELLED') controller.abort(error)
            }
          } finally { checkingChange = false; flushChange() }
        })()
      }
      const acquiring = provider.observeSessionHistory({
        source, signal: controller.signal,
        command: resolveAgentExecutable(options.commandOverride, provider.executable),
        args: options.args ?? [], env: options.env ?? {}, workspacePath: session.workspacePath,
        ...(handle.transcriptPath === undefined ? {} : { transcriptPath: handle.transcriptPath }),
        onChange: (observation) => {
          if (observation.source && (observation.source.providerId !== source.providerId ||
            observation.source.nativeSessionId !== source.nativeSessionId)) {
            notify({ kind: 'unavailable', agentSessionId, source, code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED',
              message: 'Provider observed a different native history source. The existing window is retained.' })
            controller.abort(new AgentMuxError('Provider observed another native source.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'))
            return
          }
          if (observation.kind === 'invalidated' && binding.transient) {
            pendingChange = { ...observation, agentSessionId } // One invalidation covers every version seen while confirmation is pending.
            flushChange()
            return
          }
          notify({ ...observation, agentSessionId })
          // A bounded read failure is observation uncertainty, not a lost
          // source. Providers may recover on the next exact native event.
          if (observation.kind === 'unavailable' && observation.code === 'AGENT_SESSION_HISTORY_SOURCE_CHANGED') {
            controller.abort(new AgentMuxError(observation.message, observation.code))
          }
        }
      }).then((handle) => {
        observer = handle
        if (controller.signal.aborted) handle.dispose()
        else if (handle.closed) {
          handle.closed.addEventListener('abort', sourceClosed, { once: true })
          if (handle.closed.aborted) sourceClosed()
        }
        return handle
      })
      const acquired = await Promise.race([acquiring, cancelled])
      controller.signal.throwIfAborted()
      if (acquired.source.providerId !== source.providerId || acquired.source.nativeSessionId !== source.nativeSessionId) {
        throw new AgentMuxError('Provider observed a different native history source.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
      }
      await Promise.race([binding.assertCurrent(), cancelled])
      resource.binding = binding
      flushChange()
      clearTimeout(timer)
      return { source, dispose: () => controller.abort(new AgentMuxError(
        'The history observation Consumer released its handle.', 'AGENT_SESSION_HISTORY_CANCELLED'
      )) }
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error)
      release()
      throw error
    }
  }

  private providerReadLifetime(purpose: 'history' | 'hooks') {
    const prefix = purpose === 'history' ? 'AGENT_SESSION_HISTORY' : 'AGENT_HOOK_READ'
    if (this.providerReadsDisposed) throw new AgentMuxError('Provider reading client was disposed.', `${prefix}_CANCELLED`)
    if (this.providerReads.size >= PROVIDER_READ_MAX_CONCURRENT) {
      throw new AgentMuxError('Provider reading is busy; retry after a current read finishes.', `${prefix}_BUSY`)
    }
    const controller = new AbortController()
    this.providerReads.add(controller)
    const timer = setTimeout(() => controller.abort(new AgentMuxError(
      'Native Provider reading timed out.', `${prefix}_TIMEOUT`
    )), SESSION_HISTORY_TIMEOUT_MS)
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abort, { once: true })
    })
    let currentRead: Promise<unknown> | undefined
    return {
      controller,
      read: <T>(operation: Promise<T>): Promise<T> => {
        currentRead = operation
        return Promise.race([operation, cancelled])
      },
      close: (): void => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', abort)
        const release = (): void => { this.providerReads.delete(controller) }
        if (currentRead) void currentRead.then(release, release)
        else release()
      }
    }
  }

  private cancelProviderReads(): void {
    for (const controller of this.providerReads) {
      controller.abort(new AgentMuxError('History reading was cancelled when the client disconnected.', 'AGENT_SESSION_HISTORY_CANCELLED'))
    }
  }

  resolveAgentSession(lookup: AgentMuxAgentSessionLookup): AgentMuxAgentSession {
    return this.projectSession(this.registry.resolve(lookup))
  }

  runtimeIdentity(): AgentMuxRuntimeIdentity {
    const identity = this.kernel.identity()
    return {
      hostId: 'local',
      ...(this.kernel.runtimeOwnership ? { ownership: this.kernel.runtimeOwnership } : {}),
      buildIdentity: identity.buildIdentity,
      protocolVersion: identity.protocolVersion,
      processId: null,
      instanceId: identity.daemonInstanceId
    }
  }

  private readonly inputPerformance = createInputPerformanceRecorder()

  /** Local costs only; does not connect, probe or change any Run. */
  async clientPerformanceDiagnostics(options?: { signal?: AbortSignal }): Promise<ClientPerformanceDiagnostics> {
    options?.signal?.throwIfAborted()
    return { processId: process.pid, observedAt: Date.now(), input: this.inputPerformance.snapshot(), carrier: hostedCarrierPerformance.snapshot() }
  }

  async runtimeDiagnostics(options?: { signal?: AbortSignal }): Promise<AgentMuxRuntimeDiagnostics> {
    options?.signal?.throwIfAborted()
    this.requireConnected()
    const identity = this.kernel.identity()
    return {
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      supported: supportedCtxmuxArtifactPlatform() !== null,
      ctxmux: {
        state: {
          configuredDirectory: this.kernel.stateDirectory,
          servingDirectory: this.kernel.runtimeOwnership === 'owned' ? this.kernel.stateDirectory : null
        },
        serving: {
          buildIdentity: identity.buildIdentity,
          protocolVersion: identity.protocolVersion,
          instanceId: identity.daemonInstanceId,
          sourceCommit: null
        },
        bundled: {
          version: CTXMUX_VERSION,
          sourceCommit: CTXMUX_COMMIT,
          artifactPlatform: supportedCtxmuxArtifactPlatform() ?? `${process.platform}-${process.arch}`
        },
        ready: true,
        capabilities: {
          transport: 'local-unix',
          orderedOutputBytes: true,
          boundedReplay: true,
          recoverableInput: true,
          resize: true,
          interrupt: true,
          completeStop: true
        }
      }
    }
  }

  /** Retained Run/output/attachment facts from ctxmux's public paged inventory, without lifecycle changes. */
  async runtimeResourceSnapshot(options?: { signal?: AbortSignal }): Promise<AgentMuxRuntimeResourceSnapshot> {
    options?.signal?.throwIfAborted()
    this.requireConnected()
    return await this.kernel.resourceSnapshot(options)
  }

  /** Read bounded storage facts for the original Run through its public Native owner. */
  async observeRunStorage(run: AgentMuxRunRef): Promise<AgentMuxRunStorageObservation> {
    this.requireConnected()
    const runtime = this.runtimeIdentity(), originalRun = { ...run }
    const observation = await this.kernel.observeStorage(originalRun.runId)
    return { ...observation, run: originalRun, runtime, observedAt: Date.now() }
  }

  async probeAgent(providerId: AgentProviderId, commandOverride?: string, context: AgentExecutableProbeContext = {}): Promise<AgentCapabilitySnapshot> {
    const observations: AgentMuxExecutorProbeResult[] = []
    const observe = async (executable: string) => {
      const observation = await classifyExecutable(executable, context)
      observations.push(structuredClone(observation))
      return observation
    }
    const capability = await this.providers.get(providerId).probeCapabilities(
      { hasExecutable: async executable => (await observe(executable)).availability === 'available', observeExecutable: observe },
      commandOverride
    )
    const observation = capability.executableObservation
    if (!observation) return capability
    const original = [...observations].reverse().find(value => value.executable === observation.executable)
    // Pair machine facts only. Provider wording cannot grant or revoke execution;
    // expose the Host's original cause instead of the Provider's presentation.
    const { executableObservation: _contributed, ...originalCapability } = capability
    return { ...originalCapability, ...(original?.availability === observation.availability ? { executableObservation: original } : {}) }
  }

  /**
   * 三态探测：这个 Executor 在本 Host 上是 available / missing / check-failed（环境退化）。
   *
   * 复用 Provider 自己的命令解析（commandOverride 优先，否则 catalog executable——那段逻辑住在
   * agent-provider 的 probeCapabilities 里，是唯一出处），只把它解析出的那条命令交给 classifyExecutable
   * 三态归类：`probeAgent` 里的 boolean `installed` 会把「查不成」折进「没装」，而发现列表必须区分二者
   * （那正是那次误报要防的）。启动仅把准确缺失作为文件前置拒绝；检查失败由原 Native 执行裁定。
   */
  async probeExecutorAvailability(providerId: AgentProviderId, commandOverride?: string, context: AgentExecutableProbeContext = {}): Promise<AgentMuxExecutorProbeResult> {
    // 借 probeCapabilities 的命令解析：它把解析后的命令传给 hasExecutable，我们截下那条命令再三态归类，
    // 不在这里重抄一份 commandOverride/catalog 的取舍（重抄一份就是第二处会漂移的命令解析）。
    let resolvedCommand: string | null = null
    await this.providers.get(providerId).probeCapabilities(
      { async hasExecutable(command) { resolvedCommand = command; return false } },
      commandOverride
    )
    if (resolvedCommand === null) throw new AgentMuxError('Executor availability probe did not resolve a command.', 'AGENT_NOT_FOUND')
    return await classifyExecutable(resolvedCommand, context)
  }

  private async withRunSnapshot<T, R>(target: string | null, read: (wasRemoved: (runId: string) => boolean) => Promise<T>,
    consume: (snapshot: T, wasRemoved: (runId: string) => boolean) => R | Promise<R>): Promise<R> {
    const removed = new Set<string>()
    const readers = this.pendingRunSnapshots.get(target) ?? new Set<Set<string>>()
    readers.add(removed)
    this.pendingRunSnapshots.set(target, readers)
    try {
      return await consume(await read(runId => removed.has(runId)), runId => removed.has(runId))
    } finally {
      readers.delete(removed)
      if (!readers.size) this.pendingRunSnapshots.delete(target)
    }
  }

  async listRuns(): Promise<AgentMuxRun[]> {
    this.requireConnected()
    return await this.withRunSnapshot(null, () => this.kernel.list(), (runs, wasRemoved) => runs.flatMap((run) => {
      const ref = runRef(run.runId)
      if (wasRemoved(run.runId) || this.registry.isRetiredRun(ref)) return []
      this.runPids.set(run.runId, run.pid)
      return [this.projectRun(run, this.registry.findByRun(ref))]
    }))
  }

  async runtimeProjection(): Promise<AgentMuxRuntimeProjection> {
    this.requireConnected()
    // A cold semantic owner may still be recovering lifecycle/handshake observations.
    // Read original durable bindings without replacing its active registry or adopting Runs.
    return await this.withRunSnapshot(null, wasRemoved => this.registry.withMetadataSnapshot('local', () => this.kernel.list(),
      (runs, currentSessions, retiredRuns, retiredSessions) => {
        // As in readAgentSessions(), only an actual unconfirmed creation may
        // supplement a missing durable binding; canonical identities take precedence.
        const started = this.registry.list().filter(session => session.hostId === 'local' && session.creation?.persistence === 'unconfirmed' &&
          !currentSessions.some(current => current.agentSessionId === session.agentSessionId))
        const sessions = [...currentSessions, ...started].map(session => this.projectSession(session))
        const byRun = new Map(sessions.map(session => [session.run.runId, session]))
        const retired = new Set([...retiredRuns, ...retiredSessions.map(session => session.run),
          ...sessions.flatMap(session => session.retiredRuns)].map(run => run.runId))
        const current = runs.flatMap(run => {
          if (wasRemoved(run.runId) || retired.has(run.runId) || this.registry.isRetiredRun(runRef(run.runId))) return []
          this.runPids.set(run.runId, run.pid)
          return [this.projectRun(run, byRun.get(run.runId))]
        })
        return { hostId: 'local', subjects: projectAgentMuxRuntimeSubjects('local', current, sessions) }
      }), projection => projection)
  }

  /**
   * Project one Runtime Subject from an exact target.
   *
   * A caller that already owns an Attachment should pass the Run returned by that Attachment. The
   * Run is then projected without another status round trip. Callers that only have a stable target
   * identity pay for one status request for that Run; neither path enumerates the retained Run set.
   */
  async runtimeSubject(
    target: AgentMuxRuntimeSubjectTarget,
    knownRun?: AgentMuxRun
  ): Promise<AgentMuxRuntimeSubject> {
    this.requireConnected()
    let agentSession: AgentMuxStoredAgentSession | undefined
    let runId: string
    if (target.kind === 'agent-session') {
      agentSession = this.requireAgentSession(target.agentSessionId)
      runId = agentSession.run.runId
    } else {
      runId = target.runId
    }
    const run = knownRun ?? this.projectRun(
      await this.kernel.status(runId),
      agentSession
    )
    const subjectId = target.kind === 'agent-session'
      ? `agent:local:${target.agentSessionId}`
      : `terminal:local:${target.runId}`
    const [subject] = projectAgentMuxRuntimeSubjects(
      'local',
      [run],
      agentSession ? [this.projectSession(agentSession)] : [],
      [{
        subjectId,
        target: target.kind === 'agent-session'
          ? { kind: 'agent-session', agentSessionId: target.agentSessionId }
          : { kind: 'terminal-run', run: { runId: target.runId } }
      }]
    )
    if (!subject) throw new AgentMuxError(`Runtime subject is not available: ${subjectId}`, 'UNKNOWN_RUNTIME_SUBJECT_TARGET')
    return subject
  }

  async statusAgent(agentSessionId: string): Promise<AgentMuxAgentRuntimeStatus> {
    this.requireConnected()
    await this.resolveRawAgentSession(agentSessionId)
    const durable = await this.currentStoredAgentSession(agentSessionId)
    // The SessionStore enforces durable Run uniqueness; this exact refresh also
    // checks the original registry bindings before observing that one Run.
    let session: AgentMuxAgentSession = this.projectSession(await this.registry.refresh(agentSessionId, durable.run))
    const run = await this.requireCurrentAgentRun(session)
    if (run.state.type === 'running') {
      // Exact physical facts are already confirmed. The existing native observer owns
      // its cancellation, transcript receipts and scoped unavailable diagnostic.
      await this.ensureTerminalFrontendObservation(session)
      void this.ensureNativeStatusObservation(session).catch(error => this.publishNativeStatusFailure(session, error))
      session = this.projectSession(this.requireAgentSession(agentSessionId))
    }
    const projectedRun = this.projectRun(run, session)
    const capabilities = { ...this.providers.get(session.providerId).catalog.capabilities }
    // 三条轴的观察合同：语义活性优先取 Session 自己声明的 semanticStatus（它带 native-hook/acp 来源，
    // 以及那条声明的观察时刻）；缺席时如实退回进程投影这条中性事实（source `run-process`），绝不伪造一条
    // 活动声明。就绪性读 pendingInteraction（卡在待答请求上）与终端能力降级（握手未确认）。
    const status = (projectedRun.state === 'running' ? currentAgentSemanticStatus(session.semanticStatus) : undefined) ?? {
      state: runDisplayState(projectedRun),
      source: 'run-process' as const,
      observedAt: projectedRun.observedAt
    }
    const observation = observeAgent({
      process: projectedRun.state,
      status,
      retainedStatus: session.semanticStatus,
      currentActivity: session.currentActivity,
      timelineCapability: capabilities.timeline,
      awaitingRequest: agentInteractionActiveRequest(session.pendingInteraction) !== undefined,
      terminalCapabilityUnverified: session.terminalCapability !== undefined || session.terminalFrontend !== undefined && session.terminalFrontend.state !== 'attached'
    }, Date.now())
    const interactionResponseUnavailableReason = session.pendingInteraction && agentInteractionResponseUnavailableReason(session.pendingInteraction)
    return {
      session: structuredClone(session),
      run: projectedRun,
      capabilities,
      observation,
      ...(interactionResponseUnavailableReason ? { interactionResponseUnavailableReason } : {})
    }
  }

  /** Capture this Host's complete launch request without starting or observing a Run. */
  prepareTerminal(input: AgentMuxTerminalCreateInput): AgentMuxPreparedTerminal {
    const createOperationId = input.createOperationId ?? mintObjectId()
    return parsePreparedTerminal({
      createOperationId,
      workspacePath: input.workspacePath,
      launch: JSON.stringify({ createOperationId, request: this.kernel.prepareStart({
        program: input.command ?? process.env.SHELL ?? '/bin/sh',
        args: input.args ?? [], cwd: input.workspacePath,
        env: terminalEnvironment({ ...input.env, AGENTMUX_MESSAGE_QUEUE_PATH: this.messageQueue.path,
          AGENTMUX_LIFECYCLE_OPERATION_ID: createOperationId }, this.agentSessionStorePath()),
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows })
      }) })
    })
  }

  async createTerminal(input: AgentMuxTerminalCreateInput): Promise<AgentMuxRun> {
    this.requireConnected()
    return await this.createPreparedTerminal(this.prepareTerminal(input))
  }

  async createPreparedTerminal(input: AgentMuxPreparedTerminal): Promise<AgentMuxRun> {
    const { prepared, request } = decodePreparedTerminal(input)
    this.requireConnected()
    const run = await this.kernel.startPrepared(request, prepared.createOperationId)
    this.runPids.set(run.runId, run.pid)
    const projected = this.projectRun(run)
    this.publisher.publishRunState(projected)
    return projected
  }

  /** Without an exact ref, null means unconfirmed. With a ref, null confirms that original Run is absent. Never submits Start. */
  async inspectPreparedTerminal(input: AgentMuxPreparedTerminal, ref?: AgentMuxRunRef): Promise<AgentMuxRun | null> {
    const { prepared, request } = decodePreparedTerminal(input)
    this.requireConnected()
    const run = await this.kernel.inspectPreparedStart(request, prepared.createOperationId, ref?.runId)
    if (!run) return null
    if (this.registry.findByRun(runRef(run.runId))) throw new AgentMuxError(
      'The original terminal creation belongs to an Agent Session.', 'RUN_KIND_MISMATCH')
    return this.projectRun(run)
  }

  terminalCreationRuntimeIdentity(): AgentMuxCreationRuntime { this.requireConnected(); return this.kernel.creationRuntimeIdentity() }

  async retirePreparedTerminalCreation(input: AgentMuxPreparedTerminal, runtime: AgentMuxCreationRuntime): Promise<AgentMuxTerminalCreationRetirement> {
    const { prepared, request } = decodePreparedTerminal(input)
    this.requireConnected()
    const result = await this.kernel.retirePreparedStart(request, prepared.createOperationId, runtime)
    if (result.outcome === 'retired') return result
    if (this.registry.findByRun(runRef(result.run.runId))) throw new AgentMuxError(
      'The original terminal creation belongs to an Agent Session. Its Run was preserved.', 'RUN_KIND_MISMATCH')
    return { ...result, run: this.projectRun(result.run) }
  }

  async observePreparedTerminalCreationRetirement(input: AgentMuxPreparedTerminal, runtime: AgentMuxCreationRuntime): Promise<AgentMuxTerminalCreationRetirementObservation> {
    const { prepared } = decodePreparedTerminal(input)
    this.requireConnected()
    return await this.kernel.observePreparedStartRetirement(prepared.createOperationId, runtime)
  }

  async attachTerminal(runId: string, afterByte = 0, view: AgentMuxRunAttachmentView = 'raw'): Promise<AgentMuxRunAttachment> {
    return await this.attachTerminalRun(runId, afterByte, view)
  }

  private async attachTerminalRun(runId: string, afterByte: number, view: AgentMuxRunAttachmentView,
    observationOrigin?: AgentMuxObservationOrigin): Promise<AgentMuxRunAttachment> {
    this.requireConnected()
    return await this.withRunSnapshot(runId, () => this.kernel.attach(runId, afterByte, observationOrigin ? snapshot => {
      if (snapshot.run.runId !== runId || this.registry.findByRun(runRef(runId))) {
        throw new AgentMuxError('Terminal refresh returned another Run or Session.', 'STALE_AGENT_SESSION_BINDING')
      }
    } : undefined, view, Boolean(observationOrigin)), async (attached, wasRemoved) => {
      if (wasRemoved(runId)) {
        await this.kernel.detach(runId)
        throw new AgentMuxError('Terminal Run was removed while its Attachment was being read.', 'CTXMUX_run_not_found')
      }
      if (this.registry.findByRun(runRef(runId))) {
        await this.kernel.detach(runId)
        throw new AgentMuxError('Requested Run belongs to an Agent Session.', 'RUN_KIND_MISMATCH')
      }
      this.runPids.set(runId, attached.run.pid)
      const run = this.projectRun(attached.run)
      this.publisher.publishRunState(run, undefined, observationOrigin)
      return { ...attached, run }
    })
  }

  /** Replace this client's live observation of an exact Run, keeping its process and Input untouched. */
  async refreshRunAttachment(ref: AgentMuxRunRef, afterByte = 0,
    view: AgentMuxRunAttachmentView = 'raw', operationId: string = mintObjectId()): Promise<AgentMuxRunAttachment> {
    this.requireConnected()
    safeId(operationId, 'Attachment refresh operation id')
    if (this.registry.isRetiredRun(ref)) throw new AgentMuxError('Retired Agent Run cannot be refreshed.', 'STALE_AGENT_SESSION_BINDING')
    const observationOrigin: AgentMuxObservationOrigin = { kind: 'attachment-refresh', operationId, run: { ...ref } }
    const agent = this.registry.findByRun(ref)
    if (!agent) return await this.attachTerminalRun(ref.runId, afterByte, view, observationOrigin)
    const { session, attached } = await this.attachAgentRun(agent.agentSessionId, afterByte, undefined, view, observationOrigin)
    const run = this.projectRun(attached.run, session)
    this.publisher.publishRunState(run, session.agentSessionId, observationOrigin)
    return { ...attached, run }
  }

  async readRunReplay(ref: AgentMuxRunRef, afterByte = 0, view: AgentMuxRunAttachmentView = 'raw'): Promise<AgentMuxRunAttachment> {
    this.requireConnected()
    if (this.registry.isRetiredRun(ref)) {
      throw new AgentMuxError('Retired Agent Run replay is unavailable.', 'STALE_AGENT_SESSION_BINDING')
    }
    return await this.withRunSnapshot(ref.runId, () => this.kernel.replay(ref.runId, afterByte, view), (replay, wasRemoved) => {
      if (wasRemoved(ref.runId)) {
        throw new AgentMuxError('Run was removed while its replay was being read.', 'CTXMUX_run_not_found')
      }
      if (this.registry.isRetiredRun(ref)) {
        throw new AgentMuxError('Agent Run retired while its replay was being read.', 'STALE_AGENT_SESSION_BINDING')
      }
      this.runPids.set(ref.runId, replay.run.pid)
      return {
        ...replay,
        run: this.projectRun(replay.run, this.registry.findByRun(ref)),
      }
    })
  }

  /** Reclaim only an ended, unpinned terminal record; never force process or Attachment teardown. */
  async removeTerminal(ref: AgentMuxRunRef): Promise<void> {
    this.requireConnected()
    if (this.registry.findByRun(ref) || this.registry.isRetiredRun(ref)) {
      throw new AgentMuxError('Agent Session Run cannot be removed through the terminal API.', 'RUN_KIND_MISMATCH')
    }
    await this.kernel.remove(ref.runId)
    // A successful owner receipt invalidates only reads already in flight for this exact Run.
    for (const readers of [this.pendingRunSnapshots.get(null), this.pendingRunSnapshots.get(ref.runId)]) {
      for (const removed of readers ?? []) removed.add(ref.runId)
    }
    this.runPids.delete(ref.runId)
    this.endedRuns.delete(ref.runId)
    this.stopRequestedRuns.delete(ref.runId)
  }

  async releaseRunAttachment(ref: AgentMuxRunRef): Promise<void> {
    this.requireConnected()
    await this.kernel.detach(ref.runId)
  }

  async writeTerminal(
    ref: AgentMuxRunRef,
    operation: AgentMuxRunInputOperation,
    observation?: InputObservationReference,
    context?: AgentRawInputCallContext
  ): Promise<AgentMuxRunInputAck> {
    this.requireConnected()
    const call = this.rawInputCall(context)
    const diagnostic = this.inputPerformance.begin({ sessionId: null, runId: ref.runId, kind: 'terminal',
      bytes: typeof operation.data === 'string' ? Buffer.byteLength(operation.data) : operation.data.byteLength,
      parent: readInputObservation(observation), stage: 'operation' })
    try { const identity = this.runtimeIdentity(); diagnostic.executionOwner(operation.ownerInstanceId, identity.hostId) } catch { /* Read-only identity cannot gate input. */ }
    try {
      await this.assertRawInputCurrent(call)
      // This is the dispatch boundary. Cancellation afterward only ends the
      // caller's observation; the original native operation must settle once.
      call.check()
      const accepted = await diagnostic.measure('operation', () => diagnostic.measure('native-input', () => this.kernel.input(ref.runId, operation)))
      const acceptedThroughByte = accepted.run.acceptedInputBytes
      if (acceptedThroughByte === null) {
        throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
      }
      diagnostic.settle(true)
      return { runId: ref.runId, appliedByteRange: accepted.appliedByteRange, acceptedThroughByte }
    } catch (error) { diagnostic.settle(false); throw error }
  }

  async resizeTerminal(ref: AgentMuxRunRef, cols: number, rows: number): Promise<AgentMuxRunAppliedSize> {
    this.requireConnected()
    const applied = await this.kernel.resize(ref.runId, cols, rows)
    return { runId: ref.runId, cols: applied.cols, rows: applied.rows }
  }

  async signalTerminal(ref: AgentMuxRunRef, signal: string): Promise<void> {
    this.requireConnected()
    if (signal !== 'SIGINT') {
      throw new AgentMuxError('CtxMux exposes only portable Interrupt.', 'SIGNAL_UNSUPPORTED')
    }
    await this.kernel.interrupt(ref.runId)
  }

  async stopTerminal(ref: AgentMuxRunRef): Promise<void> {
    await this.stopPreparedTerminal(await this.prepareTerminalStop(ref))
  }

  async prepareTerminalStop(ref: AgentMuxRunRef): Promise<AgentMuxPreparedTerminalStop> {
    this.requireConnected()
    const operation = await this.kernel.prepareStop(ref.runId)
    return parsePreparedTerminalStop({ run: { ...ref }, ownerInstanceId: operation.daemonInstance, operationId: operation.operationKey })
  }

  async stopPreparedTerminal(value: AgentMuxPreparedTerminalStop): Promise<void> {
    this.requireConnected()
    const prepared = parsePreparedTerminalStop(value), ref = prepared.run
    // Reserve the operation before recording intent. A failed preparation must
    // not leave a stale "user stopped" marker that misclassifies a later exit.
    const operation = { runId: ref.runId, daemonInstance: prepared.ownerInstanceId, operationKey: prepared.operationId }
    this.stopRequestedRuns.add(ref.runId)
    try {
      await this.kernel.stop(operation)
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found') {
        // The Run is already terminal; continue with the same receipt path.
      } else {
        // No lifecycle reservation exists for this low-level API. Do not let
        // a failed submission poison classification of a later exit.
        this.stopRequestedRuns.delete(ref.runId)
        throw error
      }
    }
    this.runPids.delete(ref.runId)
    this.publisher.publish({
      type: 'run-removed',
      run: { ...ref },
      evidence: { source: 'user', observedAt: Date.now(), run: { ...ref } }
    })
  }

  /**
   * 一次 Discussion：受管 Agent A 创建专属 Agent B 并投递首条消息。
   *
   * author 由 Core 从 A 交回的凭证解析——调用方声称的身份不作数。首条消息作为 B 的启动
   * Prompt 投递，但那只是**账本首条消息的 transport**：Provider 收下启动参数最多证明
   * `delivered`，证明不了 B 接受或回复了它。
   *
   * 创建走的是 `createAgent` 那条已验证的 reservation → commit 原子路径，不复制一份；
   * 相同 operationId 因此天然落到同一个 Thread，重试不会再建一个 Session、
   * 也不会重复注入 Prompt。
   */
  /**
   * 解析调用方的 author，失败即关闭。
   *
   * 每个通信动作都先过这里：author 由 Core 从凭证解析，调用方声称的身份不作数。
   * 抽成一处，是为了让"新增一个动作"不必重新想一遍怎么验身份——漏验一次就是一个冒充口子。
   */
  private resolveMessageAuthor(
    capability: string, callerAgentSessionId: string,
    caller = this.registry.get(callerAgentSessionId)
  ): string {
    return resolveCapabilityAuthor(capability, {
      agentSessionId: caller.agentSessionId,
      workspacePath: caller.workspacePath,
      runId: caller.run.runId,
      capabilityHash: caller.capabilityHash ?? ''
    }, caller.run.runId)
  }

  /** Validate the caller capability and return the authoritative live Session/Run facts. */
  async authorizeAgentCaller(capability: string, callerAgentSessionId: string): Promise<AgentMuxAgentSession> {
    const caller = await this.currentStoredAgentSession(callerAgentSessionId)
    this.resolveMessageAuthor(capability, callerAgentSessionId, caller)
    return this.projectSession(caller)
  }

  /** Bind every persisted A2A identity fact to the authoritative live Session/Run before append. */
  async authorizeAgentMessage(input: {
    capability: string
    callerAgentSessionId: string
    senderAgentSessionId: string | null
    senderSessionId: string | null
    senderRunId: string | null
    recipientSessionId: string | null
    recipientRunId: string | null
  }): Promise<void> {
    await this.messageAuthorBinding(input)
  }

  private async messageAuthorBinding(input: Parameters<AgentMuxClient['authorizeAgentMessage']>[0]): Promise<Readonly<AgentCapabilityBinding>> {
    const sender = await this.currentStoredAgentSession(input.callerAgentSessionId)
    this.resolveMessageAuthor(input.capability, input.callerAgentSessionId, sender)
    if (input.senderAgentSessionId !== sender.agentSessionId || input.senderSessionId === null || input.senderRunId === null || input.senderSessionId !== sender.agentSessionId || input.senderRunId !== sender.run.runId) {
      throw new AgentMuxError('A2A sender facts do not match the authorized Agent Session/Run.', 'MESSAGE_SENDER_MISMATCH')
    }
    if (input.recipientSessionId === null || input.recipientRunId === null) {
      throw new AgentMuxError('A2A recipient Session/Run facts are required.', 'MESSAGE_RECIPIENT_MISMATCH')
    }
    const recipient = await this.currentStoredAgentSession(input.recipientSessionId)
    if (input.recipientRunId !== recipient.run.runId) {
      throw new AgentMuxError('A2A recipient facts do not match the resolved Agent Session/Run.', 'MESSAGE_RECIPIENT_MISMATCH')
    }
    return Object.freeze({ agentSessionId: sender.agentSessionId, workspacePath: sender.workspacePath,
      runId: sender.run.runId, capabilityHash: sender.capabilityHash ?? '' })
  }

  /** The same exact author fence is used for first dispatch and waiting-input rejoin. */
  private async messageInputAuthority(input: Parameters<AgentMuxClient['authorizeAgentMessage']>[0]): Promise<import('./prompt-submission.js').AgentPromptInputAuthority> {
    const binding = await this.messageAuthorBinding(input)
    return { binding, assertCurrent: async () => {
      await this.messageAuthorBinding(input)
      const sender = await this.currentStoredAgentSession(binding.agentSessionId)
      await this.registry.refresh(sender.agentSessionId, sender.run)
      const run = await this.requireCurrentAgentRun(sender)
      if (run.state.type !== 'running') throw new AgentMuxError('The original message author Run is not running.', 'AGENT_CAPABILITY_STALE_RUN')
    } }
  }

  /** Explicit consumption is durable and recipient-scoped, independent of input or human reading. */
  async checkDeliveries(input: {
    capability: string
    callerAgentSessionId: string
    limit: number
  }): Promise<AgentMuxDeliveryBatch> {
    const reader = await this.currentStoredAgentSession(input.callerAgentSessionId)
    const consumerId = this.resolveMessageAuthor(input.capability, input.callerAgentSessionId, reader)
    return await this.messageQueue.check({ consumerId, readerRun: reader.run, limit: input.limit },
      async () => { await this.assertCurrentMessageReader(input.capability, consumerId, reader.run) })
  }

  /** Ack advances only this exact reader's pinned batch; it does not mean accepted or replied. */
  async ackDeliveryBatch(input: {
    capability: string
    callerAgentSessionId: string
    readerRun: AgentMuxRunRef
    generation: number
  }): Promise<AgentMuxDeliveryAcknowledgement> {
    const reader = await this.currentStoredAgentSession(input.callerAgentSessionId)
    const consumerId = this.resolveMessageAuthor(input.capability, input.callerAgentSessionId, reader)
    if (!sameRun(reader.run, input.readerRun)) {
      throw new AgentMuxError('The delivery reader Run changed.', 'MESSAGE_ACK_GENERATION_STALE')
    }
    return await this.messageQueue.ack({ consumerId, readerRun: input.readerRun, generation: input.generation },
      async () => { await this.assertCurrentMessageReader(input.capability, consumerId, input.readerRun) })
  }

  private async currentStoredAgentSession(agentSessionId: string): Promise<AgentMuxStoredAgentSession> {
    // Do not mutate/reload the active registry or trust a connect-time capability cache. Session
    // persistence is read at the admission boundary; no Session write/Provider probe.
    const session = await this.store.readMetadata(agentSessionId)
    if (!session || session.hostId !== 'local') throw new AgentMuxError('Agent Session is unknown.', 'UNKNOWN_AGENT_SESSION')
    return session
  }

  private async assertCurrentMessageReader(capability: string, consumerId: string, expectedRun: AgentMuxRunRef): Promise<void> {
    const current = await this.currentStoredAgentSession(consumerId)
    this.resolveMessageAuthor(capability, consumerId, current)
    if (!sameRun(current.run, expectedRun)) {
      throw new AgentMuxError('The delivery reader Run changed before mutation.', 'MESSAGE_ACK_GENERATION_STALE')
    }
  }

  /** 回答一个问题。相同回答幂等，不同回答冲突。 */
  answerAsk(input: {
    capability: string
    callerAgentSessionId: string
    ask: AgentAsk
    answer: string
  }): AgentAsk {
    this.resolveMessageAuthor(input.capability, input.callerAgentSessionId)
    return answerAsk(input.ask, input.answer, Date.now())
  }

  /** 不等了。与超时同为 closed，但原因不同。 */
  cancelAsk(input: { capability: string; callerAgentSessionId: string; ask: AgentAsk }): AgentAsk {
    this.resolveMessageAuthor(input.capability, input.callerAgentSessionId)
    return cancelAsk(input.ask, Date.now())
  }

  /** Declare a communication handoff; external Task ownership is not changed by Core. */
  handOff(input: {
    capability: string
    callerAgentSessionId: string
    toAgentSessionId: string
    taskId: string
  }): HandoffResult {
    const from = this.resolveMessageAuthor(input.capability, input.callerAgentSessionId)
    return handOff({
      fromAgentSessionId: from,
      toAgentSessionId: input.toAgentSessionId,
      taskId: input.taskId,
      at: Date.now()
    })
  }

  /** Open supervision for an already recorded message; no input or external Task mutation. */
  async openDispatch(input: {
    capability: string
    callerAgentSessionId: string
    sourceMessageId: string
  }): Promise<Dispatch> {
    this.requireConnected()
    const caller = await this.currentStoredAgentSession(input.callerAgentSessionId)
    const author = this.resolveMessageAuthor(input.capability, input.callerAgentSessionId, caller)
    const dispatch = await this.messageQueue.openDispatch({ callerAgentSessionId: author, sourceMessageId: input.sourceMessageId },
      async (messages) => { await this.assertDispatchAdmission(input.capability, author, caller.run, messages) })
    this.publisher.publish({ type: 'dispatch-changed', sourceMessageId: dispatch.sourceMessageId,
      ownerAgentSessionId: dispatch.ownerAgentSessionId, workerAgentSessionId: dispatch.workerAgentSessionId,
      threadId: dispatch.threadId, evidence: { source: 'agentmux', observedAt: Date.now(), run: caller.run } })
    return dispatch
  }

  /** Each actual reply is one durable event; only an authorized worker_done settles waiting. */
  async recordDispatchEvent(input: {
    capability: string
    callerAgentSessionId: string
    sourceMessageId: string
    replyMessageId: string
    kind: DispatchEventKind
  }): Promise<Dispatch> {
    this.requireConnected()
    const caller = await this.currentStoredAgentSession(input.callerAgentSessionId)
    const author = this.resolveMessageAuthor(input.capability, input.callerAgentSessionId, caller)
    const dispatch = await this.messageQueue.recordDispatchEvent({ callerAgentSessionId: author,
      sourceMessageId: input.sourceMessageId, replyMessageId: input.replyMessageId, kind: input.kind },
    async (messages) => { await this.assertDispatchAdmission(input.capability, author, caller.run, messages) })
    this.publisher.publish({ type: 'dispatch-changed', sourceMessageId: dispatch.sourceMessageId,
      ownerAgentSessionId: dispatch.ownerAgentSessionId, workerAgentSessionId: dispatch.workerAgentSessionId,
      threadId: dispatch.threadId, event: dispatch.events.find(event => event.replyMessageId === input.replyMessageId)!,
      evidence: { source: 'agentmux', observedAt: Date.now(), run: caller.run } })
    return dispatch
  }

  async showDispatch(input: {
    capability: string
    callerAgentSessionId: string
    sourceMessageId: string
  }): Promise<Dispatch> {
    this.requireConnected()
    const caller = await this.currentStoredAgentSession(input.callerAgentSessionId)
    const author = this.resolveMessageAuthor(input.capability, input.callerAgentSessionId, caller)
    return await this.messageQueue.showDispatch({ callerAgentSessionId: author, sourceMessageId: input.sourceMessageId },
      async (messages) => { await this.assertDispatchAdmission(input.capability, author, caller.run, messages) })
  }

  /** Read original intake before any input claim or dispatch exists; no Runtime readiness is required. */
  async readMessage(input: import('./agent-message-query.js').AgentMuxMessageRead & { caller?: { agentSessionId: string; capability: string } }): Promise<DurableAgentMuxMessage | null> {
    if ((input.operationId !== undefined) === (input.messageId !== undefined)) throw new AgentMuxError(
      'Choose exactly one original message operationId or messageId.', 'INVALID_CONTROL_REQUEST')
    const reauthorize = async (message: DurableAgentMuxMessage | null) => {
      if (!input.caller) return
      const caller = input.caller
      await this.authorizeRetainedAgentCaller(caller.capability, caller.agentSessionId)
      if (message && caller.agentSessionId !== message.envelope.senderSessionId &&
        caller.agentSessionId !== message.envelope.recipientSessionId) throw new AgentMuxError(
        'Only an original message participant can read it with Agent authority.', 'MESSAGE_PARTICIPANT_MISMATCH')
    }
    return input.messageId === undefined
      ? this.messageQueue.readByOperationId(input.operationId!, reauthorize, input.notificationId)
      : this.messageQueue.readByMessageId(input.messageId, reauthorize, input.notificationId)
  }

  /** Original A2A metadata only; no connection, Run probe, input or acknowledgement. */
  async listMessages(input: import('./agent-message-query.js').AgentMuxMessageQuery & { caller?: { agentSessionId: string; capability: string } }): Promise<import('./agent-message-query.js').AgentMuxMessagePage> {
    const caller = input.caller
    if (caller && caller.agentSessionId !== input.participantSessionId) throw new AgentMuxError(
      'An Agent can only browse its own original messages.', 'MESSAGE_PARTICIPANT_MISMATCH')
    this.messageReadUsed = true
    void this.observeMessageReads()?.refresh()
    return this.messageQueue.listMessages(input, async () => {
      if (caller) await this.authorizeRetainedAgentCaller(caller.capability, caller.agentSessionId)
    })
  }

  /** Batch coordination freezes once; every target consumes the existing single-message Inbox owner. */
  async broadcastMessages(input: AgentMuxMessageBroadcastInput & { capability: string; callerAgentSessionId: string;
    sourceDevice?: import('./types.js').AgentOperationDevice }, context?: AgentInputCallContext): Promise<AgentMuxMessageBroadcastReceipt> {
    return runAgentMessageBroadcast(input, { queue: this.messageQueue,
      ...(input.sourceDevice === undefined ? {} : { sourceDevice: normalizeOperationDevice(input.sourceDevice) }),
      authorize: async () => {
        context?.requestSignal?.throwIfAborted()
        await context?.assertCurrent?.()
        const author = await this.authorizeRetainedAgentCaller(input.capability, input.callerAgentSessionId)
        return { hostId: author.hostId, agentSessionId: author.agentSessionId, runId: author.run.runId }
      },
      resolve: async agentSessionId => {
        const target = await this.currentStoredAgentSession(agentSessionId)
        return { hostId: target.hostId, agentSessionId: target.agentSessionId, runId: target.run.runId }
      },
      send: async (intent, target) => this.submitAgentMessage({ agentSessionId: target.agentSessionId,
        envelope: { schema: 'agentmux.a2a.v1', messageId: target.messageId, operationId: target.operationId, createdAt: intent.createdAt,
          sender: { kind: 'agent-session', agentSessionId: intent.author.agentSessionId }, recipient: { kind: 'agent-session', agentSessionId: target.agentSessionId },
          senderSessionId: intent.author.agentSessionId, senderRunId: intent.author.runId, recipientSessionId: target.agentSessionId, recipientRunId: target.runId,
          threadId: target.messageId, correlationId: target.messageId, replyTo: null, workspaceId: null, body: intent.body },
        execution: 'default', sourceChannel: intent.sourceChannel, ...(intent.sourceDevice ? { sourceDevice: intent.sourceDevice } : {}),
        caller: { agentSessionId: input.callerAgentSessionId, capability: input.capability } }, context)
    })
  }

  /** Read the original author's frozen batch and current original-message receipts, never resend. */
  async inspectMessageBroadcast(input: { operationId: string; caller?: { agentSessionId: string; capability: string } }): Promise<AgentMuxMessageBroadcastReceipt | null> {
    return this.messageQueue.inspectBroadcast(input.operationId, async authorSessionId => {
      if (!input.caller) return
      await this.authorizeRetainedAgentCaller(input.caller.capability, input.caller.agentSessionId)
      if (authorSessionId !== undefined && authorSessionId !== input.caller.agentSessionId) throw new AgentMuxError(
        'An Agent can only inspect its own original broadcast.', 'MESSAGE_PARTICIPANT_MISMATCH')
    })
  }

  /** Original journal events from either side; no Runtime connection or consumer mutation. */
  async listMessageEvents(input: import('./agent-message-events.js').AgentMuxMessageEventsQuery & { caller?: { agentSessionId: string; capability: string } }): Promise<import('./agent-message-events.js').AgentMuxMessageEventsPage> {
    const { caller, ...query } = input
    if (caller && caller.agentSessionId !== input.participantSessionId) throw new AgentMuxError(
      'An Agent can only browse its own original events.', 'MESSAGE_PARTICIPANT_MISMATCH')
    this.messageReadUsed = true
    void this.observeMessageReads()?.refresh()
    return this.messageQueue.listMessageEvents(query, async () => {
      if (caller) await this.authorizeRetainedAgentCaller(caller.capability, caller.agentSessionId)
    })
  }

  /** SDK callers are trusted Host readers; managed authority is checked again under the journal lock. */
  async readDispatch(input: { sourceMessageId: string; caller?: { agentSessionId: string; capability: string } }): Promise<DispatchObservation> {
    const caller = input.caller
    return this.messageQueue.readDispatch({ sourceMessageId: input.sourceMessageId,
      ...(caller ? { callerAgentSessionId: caller.agentSessionId } : {}) }, async messages => {
      if (caller) await this.authorizeRetainedAgentCaller(caller.capability, caller.agentSessionId)
      return this.dispatchIdentityDiagnostics(messages)
    })
  }

  async listDispatches(input: { participantSessionId: string; afterSourceMessageId?: string; limit?: number;
    caller?: { agentSessionId: string; capability: string } }): Promise<DispatchPage> {
    const caller = input.caller
    if (caller && caller.agentSessionId !== input.participantSessionId) throw new AgentMuxError(
      'An Agent can only list its own Dispatch participation.', 'DISPATCH_PARTICIPANT_MISMATCH')
    return this.messageQueue.listDispatches(input, async () => {
      if (caller) await this.authorizeRetainedAgentCaller(caller.capability, caller.agentSessionId)
    })
  }

  private async dispatchIdentityDiagnostics(messages: readonly AgentMuxMessageEnvelope[]): Promise<readonly DispatchIdentityDiagnostic[]> {
    const participants = new Map<string, Set<string>>()
    for (const message of messages) for (const [id, runId] of [
      [message.senderSessionId, message.senderRunId], [message.recipientSessionId, message.recipientRunId]
    ]) {
      if (id && runId) { const runs = participants.get(id) ?? new Set<string>(); runs.add(runId); participants.set(id, runs) }
    }
    const observations = await Promise.all([...participants].map(async ([agentSessionId, runs]) => {
      try {
        const session = await this.store.readMetadata(agentSessionId)
        return [...runs].flatMap(runId => session?.hostId === 'local' && (session.run.runId === runId || session.retiredRuns.some(run => run.runId === runId))
          ? [] : [{ agentSessionId, runId, code: 'DISPATCH_IDENTITY_UNAVAILABLE' as const,
            message: 'This recorded participant Run is not confirmed by the current retained Session history. Keep the original communication and inspect its identity.' }])
      } catch (error) {
        return [...runs].map(runId => ({ agentSessionId, runId, code: 'AGENT_SESSION_STORE_READ_UNCONFIRMED' as const,
          message: `Current participant identity could not be read: ${error instanceof Error ? error.message : String(error)}. Recorded communication remains available.` }))
      }
    }))
    return observations.flat()
  }

  private async assertDispatchAdmission(
    capability: string, author: string, expectedRun: AgentMuxRunRef,
    messages: readonly AgentMuxMessageEnvelope[]
  ): Promise<void> {
    // Admission runs inside the existing journal lock. The SessionStore is a separate authority,
    // not an atomic transaction with this journal; no Provider probe or Session write is added.
    const participantIds = new Set([author, ...messages.flatMap(message => [message.senderSessionId, message.recipientSessionId])])
    const sessions = new Map(await Promise.all([...participantIds].map(async id =>
      [id, id === null ? null : await this.store.readMetadata(id)] as const)))
    const current = sessions.get(author)
    if (!current || current.hostId !== 'local') throw new AgentMuxError('Dispatch caller Session is unknown.', 'UNKNOWN_AGENT_SESSION')
    this.resolveMessageAuthor(capability, author, current)
    if (!sameRun(current.run, expectedRun)) {
      throw new AgentMuxError('The Dispatch caller Run changed before admission.', 'AGENT_CAPABILITY_STALE_RUN')
    }
    for (const message of messages) {
      for (const [agentSessionId, runId] of [
        [message.senderSessionId, message.senderRunId], [message.recipientSessionId, message.recipientRunId]
      ]) {
        const participant = sessions.get(agentSessionId ?? null)
        if (!participant || participant.hostId !== 'local' || (participant.run.runId !== runId && !participant.retiredRuns.some((run) => run.runId === runId))) {
          throw new AgentMuxError('A Dispatch message Run is outside the retained Session identity history.', 'DISPATCH_IDENTITY_UNAVAILABLE')
        }
      }
    }
  }

  async startDiscussion(input: {
    capability: string
    /**
     * 调用方自称的 Agent Session。它只是**上下文提示**：Core 会用凭证核对它，
     * 对不上就拒绝——所以改这个字段冒充别人是行不通的。
     */
    callerAgentSessionId: string
    executorId: AgentExecutorId
    providerId: AgentProviderId
    workspacePath: string
    body: string
    operationId: string
  }): Promise<{ thread: AgentThread; session: AgentMuxAgentSession }> {
    this.requireConnected()
    const author = await this.currentStoredAgentSession(input.callerAgentSessionId)
    const plan = planDiscussion({
      capability: input.capability,
      binding: {
        agentSessionId: author.agentSessionId,
        workspacePath: author.workspacePath,
        runId: author.run.runId,
        capabilityHash: author.capabilityHash ?? ''
      },
      currentRunId: author.run.runId,
      targetWorkspacePath: input.workspacePath,
      body: input.body,
      operationId: input.operationId,
      now: Date.now()
    })
    const { session, promptConfirmed } = await this.createAgentWithDelivery({
      executorId: input.executorId,
      providerId: input.providerId,
      workspacePath: input.workspacePath,
      prompt: plan.launchPrompt,
      initialMessage: { callerAgentSessionId: author.agentSessionId, capability: input.capability, threadId: plan.threadId },
      injectAgentMuxGuide: true,
      // 同一个 operation id：重试落到同一次创建，不会重复 Spawn 或重复注入 Prompt。
      createOperationId: input.operationId
    })
    return {
      thread: {
        ...plan.thread,
        targetAgentSessionId: session.agentSessionId,
        // ctxmux 收下了启动输入——这最多证明送达。
        delivery: promptConfirmed ? advanceDelivery(plan.thread.delivery, 'delivered', Date.now()) : plan.thread.delivery
      },
      session
    }
  }

  async createAgent(input: AgentMuxAgentCreateInput): Promise<AgentMuxAgentSession> {
    return (await this.createAgentWithDelivery(input)).session
  }

  async createAgentWithDelivery(input: AgentMuxAgentCreateInput): Promise<{
    session: AgentMuxAgentSession; promptConfirmed: boolean;
    creation: NonNullable<AgentMuxAgentSession['creation']>
  }> {
    if ('initialMessageAdmission' in input || 'verifiedAuthor' in input || 'initialMessageOrigin' in input || 'createdBy' in input) {
      throw new AgentMuxError('Cross-Host initial messages require the target-owned creation contract.', 'MESSAGE_ENVELOPE_REQUIRED')
    }
    return await this.createAgentWithDeliveryAuthorized(input)
  }

  private async createAgentWithDeliveryAuthorized(input: AgentMuxAgentCreateInput,
    admitted?: Parameters<AgentMuxClient['createAgentWithDeliveryAttempt']>[1]): ReturnType<AgentMuxClient['createAgentWithDelivery']> {
    this.requireConnected()
    const frozen = structuredClone(input)
    frozen.createOperationId ??= mintObjectId()
    frozen.agentSessionId ??= await this.resolveAgentCreationSessionId(frozen.createOperationId)
    const authority = structuredClone(admitted)
    const key = frozen.agentSessionId
    const active = this.activeCreations.get(key)
    if (active) {
      if (!isDeepStrictEqual(active.input, frozen) || !isDeepStrictEqual(active.admitted, authority)) throw new AgentMuxError(
        'This active creation belongs to another original request. Keep its identity and inspect the original operation.', 'AGENT_FORK_OPERATION_CONFLICT')
      return await active.pending
    }
    const controller = new AbortController()
    const operationId = agentLifecycleOperationIdentity('create', key, frozen.createOperationId)
    let waiting = false
    const pending = retryAgentCreationResources({ operationId, signal: controller.signal,
      attempt: () => this.createAgentWithDeliveryAttempt(frozen, authority, controller.signal),
      waiting: (error, retryAfterMs) => { waiting = true; this.publisher.publish({ type: 'agent-error', agentSessionId: key,
        code: 'AGENT_CREATION_WAITING_FOR_STORAGE',
        message: `Storage is unavailable; this Agent has not started. Retrying the original request in ${retryAfterMs / 1_000}s. ${error.message}`,
        evidence: { source: 'agentmux', observedAt: Date.now() } }) } })
    this.activeCreations.set(key, { input: frozen, admitted: authority, controller, pending })
    try { return await pending }
    catch (error) {
      if (waiting) this.publisher.publish({ type: 'agent-error', agentSessionId: key,
        code: 'AGENT_CREATION_RESOURCE_RETRY_STOPPED',
        message: `Automatic creation retry ended. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', observedAt: Date.now() } })
      throw error
    }
    finally { if (this.activeCreations.get(key)?.pending === pending) this.activeCreations.delete(key) }
  }

  private async createAgentWithDeliveryAttempt(input: AgentMuxAgentCreateInput,
    admitted?: { intentDigest: string; origin?: AgentMuxCreationOrigin; threadId?: string; executorRevision?: string }, signal?: AbortSignal): Promise<{
    session: AgentMuxAgentSession; promptConfirmed: boolean; creation: NonNullable<AgentMuxAgentSession['creation']>
  }> {
    this.requireConnected()
    const forkSource = input.forkSource === undefined ? undefined : parseAgentForkSource(input.forkSource)
    const nativeResumeSource = input.nativeResumeSource === undefined ? undefined : parseAgentNativeResumeSource(input.nativeResumeSource)
    if (nativeResumeSource && (forkSource || nativeResumeSource.nativeHandle.providerId !== input.providerId || nativeResumeSource.workspacePath !== input.workspacePath)) {
      throw new AgentMuxError('Native resume must keep its exact Provider and execution directory, without a fork source.', 'INVALID_AGENT_NATIVE_RESUME_SOURCE')
    }
    if ('authorAgentSessionId' in input) throw new AgentMuxError('Agent authors must use an authenticated initial message.', 'MESSAGE_ENVELOPE_REQUIRED')
    if (input.prompt !== undefined) assertAgentPromptSize(input.prompt)
    if (input.agentMuxTask !== undefined && typeof input.agentMuxTask !== 'string') throw new AgentMuxError('A platform task must be explicit text from its producer.', 'INVALID_AGENT_PROMPT')
    const createOperationId = input.createOperationId ?? mintObjectId()
    const agentSessionId = safeId(input.agentSessionId ?? await this.resolveAgentCreationSessionId(createOperationId), 'Agent Session id')
    const executorId = safeId(input.executorId, 'Agent Executor id')
    let initialAuthor: AgentMuxStoredAgentSession | undefined
    if (input.initialMessage) {
      if (!input.prompt?.trim()) throw new AgentMuxError('An initial Agent message needs a body.', 'INVALID_AGENT_PROMPT')
      initialAuthor = await this.currentStoredAgentSession(input.initialMessage.callerAgentSessionId)
      this.resolveMessageAuthor(input.initialMessage.capability, input.initialMessage.callerAgentSessionId, initialAuthor)
    }
    let creator = initialAuthor
    if (input.creationCaller) {
      creator = await this.currentStoredAgentSession(input.creationCaller.agentSessionId)
      this.resolveMessageAuthor(input.creationCaller.capability, input.creationCaller.agentSessionId, creator)
    }
    const createdBy: AgentMuxSpawnCreator | undefined = creator
      ? { agentSessionId: creator.agentSessionId, run: { ...creator.run }, owner: { kind: 'local' } }
      : admitted?.origin ? { agentSessionId: admitted.origin.source.agentSessionId,
        run: { runId: admitted.origin.source.runId }, owner: { kind: 'runtime', runtimeId: admitted.origin.source.runtimeId } } : undefined
    const intentDigest = admitted?.intentDigest ?? creationIntentDigest(input, agentSessionId, executorId, createOperationId, initialAuthor, creator)
    const contextRequested = !(nativeResumeSource && !input.prompt?.trim() && !input.agentMuxTask?.trim()) &&
      Boolean(createdBy || forkSource || input.injectAgentMuxGuide || input.agentMuxNote?.trim() || input.agentMuxTask?.trim() || input.optionalContext?.length)
    const lifecycleOperationId = agentLifecycleOperationIdentity('create', agentSessionId, createOperationId)
    // A replay reads the original created identity and receipt before checking a now-changed parent.
    const existing = await this.readCreationSession(agentSessionId, createOperationId)
    if (existing?.kind === 'retired-agent') throw new AgentMuxError(
      'The original creation belongs to a retired Agent. Inspect that operation; only an explicit reopen or a new creation intent can continue work.',
      'AGENT_CREATION_RETIRED', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
    if (existing && existing.creation?.persistence !== 'unconfirmed') {
      if (existing.creation?.createOperationId !== createOperationId || existing.providerId !== input.providerId ||
        existing.executorId !== executorId || existing.workspacePath !== input.workspacePath ||
        JSON.stringify(existing.forkedFrom) !== JSON.stringify(forkSource) || existing.creation.intentDigest !== intentDigest) {
        throw new AgentMuxError('This creation operation is bound to another source or created Session.', 'AGENT_FORK_OPERATION_CONFLICT')
      }
      return { session: structuredClone(existing), promptConfirmed: creationPromptConfirmed(existing.creation, contextRequested), creation: existing.creation }
    }
    const pending = await this.registry.claimCreate(agentSessionId, lifecycleOperationId, intentDigest)
    if (pending) {
      const session = await this.completePreparedCreate(pending, await this.kernel.inspectCreation(pending.operationId))
      return { session: this.projectSession(session), creation: session.creation!, promptConfirmed: creationPromptConfirmed(session.creation!, contextRequested) }
    }
    if (forkSource) {
      // A new fork needs only its exact source adopted. Original receipts and prepared
      // operations above remain readable even after that source later changes.
      await this.resolveRawAgentSession(forkSource.agentSessionId)
      assertAgentForkSource(forkSource, await this.currentStoredAgentSession(forkSource.agentSessionId), input)
    }
    if (nativeResumeSource) {
      const managed = await this.managedNativeSessions(nativeResumeSource)
      if (managed.length) throw new AgentMuxError('This native conversation already has Core ownership. Continue its original Session; no Run was started.',
        managed.length > 1 ? 'AGENT_NATIVE_SESSION_AMBIGUOUS' : 'AGENT_NATIVE_SESSION_ALREADY_MANAGED', JSON.stringify({ managed }))
    }
    let initialEnvelope: AgentMuxMessageEnvelope | undefined
    if (input.initialMessage || admitted?.origin && input.prompt?.trim()) {
      if (!input.prompt?.trim()) throw new AgentMuxError('An initial Agent message needs a body.', 'INVALID_AGENT_PROMPT')
      const author = initialAuthor ? { agentSessionId: initialAuthor.agentSessionId, runId: initialAuthor.run.runId } : admitted!.origin!.source
      const threadId = input.initialMessage?.threadId ?? admitted?.threadId
      const messageId = threadId ? `${threadId}:0`
        : `initial-${createHash('sha256').update(createOperationId).digest('base64url').slice(0, 22)}`
      const queued = await this.messageQueue.append({
        messageId, operationId: createOperationId, createdAt: Date.now(),
        sender: { kind: 'agent-session', agentSessionId: author.agentSessionId },
        recipient: { kind: 'agent-session', agentSessionId },
        senderSessionId: author.agentSessionId, senderRunId: author.runId,
        recipientSessionId: agentSessionId, recipientRunId: null,
        threadId: threadId ?? messageId, correlationId: messageId,
        replyTo: null, workspaceId: null, body: input.prompt
      })
      initialEnvelope = queued.envelope
      // A creation retry reads the original receipt. It never resubmits an uncertain launch prompt.
      const existing = this.registry.list().find(session => session.agentSessionId === agentSessionId)
      if (existing) {
        if (existing.creation?.createOperationId !== createOperationId || existing.providerId !== input.providerId ||
          existing.executorId !== executorId || existing.workspacePath !== input.workspacePath) {
          throw new AgentMuxError('Initial message creation names another Session intent.', 'MESSAGE_ID_CONFLICT')
        }
        const promptConfirmed = existing.creation.initialPrompt === 'confirmed'
        await this.recordInitialMessageDelivery(existing, initialEnvelope, promptConfirmed, false)
        return { session: this.projectSession(existing), promptConfirmed, creation: existing.creation }
      }
    }
    const originalPrompt = initialEnvelope ? renderAgentMuxMessageEnvelope(initialEnvelope) : input.prompt
    let reservation = await this.registry.reserveNew(agentSessionId, lifecycleOperationId)
    let hookBinding: AgentHookBinding | null = null
    let persisted: AgentMuxStoredAgentSession | null = null
    let preservePreparedCreation = false
    let startAttempted = false
    let creationError: unknown
    try {
      const provider = this.providers.get(input.providerId)
      if (nativeResumeSource && !provider.assertNativeResumeSource) {
        throw new AgentMuxError(`${provider.label} does not support exact persisted conversation discovery.`, 'AGENT_NATIVE_SESSION_DISCOVERY_UNSUPPORTED')
      }
      const assertNativeSource = nativeResumeSource ? async () => await provider.assertNativeResumeSource!({ source: nativeResumeSource,
        workspacePath: input.workspacePath, env: input.env ?? {}, signal: new AbortController().signal }) : undefined
      await assertNativeSource?.()
      // 这个 Run 的说话凭证。raw 只进受管进程的环境，Core 侧只留 hash。
      const invocationCapability = issueAgentCapability()
      // `post-launch-only` 的 Provider 在启动期收不到任何 prompt（它的交互 UI 没有那个入口，
      // 见对应 Provider 模块的出处），所以**不给它组装启动 prompt**——交了只会被 buildLaunch
      // 拒绝，而运行时引导默认开、`composeAgentLaunchPrompt` 因此几乎总是非空，那等于这个
      // Provider 根本起不来。分流由 splitLaunchPromptByDelivery 唯一决定，两条生命周期路径共用；
      // 它同时交出 deferred 的那一半，下面必须真的送出去（见 deliverPostLaunchPrompt）。
      const composed = nativeResumeSource && !originalPrompt?.trim() && !input.agentMuxTask?.trim() ? { text: '', systemContext: undefined } : composeAgentLaunchPrompt(originalPrompt, forkSource ? true : input.injectAgentMuxGuide,
        [forkSource ? agentForkIdentityReminder(agentSessionId, forkSource) : undefined,
          createdBy ? agentSpawnContext(createdBy) : undefined, input.agentMuxNote].filter(Boolean).join('\n\n') || undefined, input.optionalContext, input.agentMuxTask)
      assertAgentPromptSize(composed.text)
      const { atLaunch: launchPrompt, deferred: deferredPrompt } = splitLaunchPromptByDelivery(
        provider.catalog, composed.text
      )
      // Sealed launch options resolve to their argv core-side (fails closed on an un-declared choice) and
      // join the caller's args ahead of the prompt, exactly as buildArgs orders every other flag.
      const launchOptionArgv = provider.resolveLaunchArgv(input.launchOptions ?? {})
      if (forkSource && (!provider.catalog.capabilities.providerFork?.current || !provider.buildForkLaunch)) {
        throw new AgentMuxError(`${provider.label} does not support native current-conversation fork.`, 'AGENT_FORK_UNSUPPORTED')
      }
      let assertForkCurrent: (() => Promise<void>) | undefined
      if (forkSource) {
        const source = await this.currentStoredAgentSession(forkSource.agentSessionId)
        assertAgentForkSource(forkSource, source, input)
        const sourceRun = await this.requireCurrentAgentRun(source)
        if (sourceRun.state.type === 'running') {
          const witness = sourceRun.pid && provider.discoverNativeSession
            ? await provider.discoverNativeSession({ processId: sourceRun.pid, command: this.providerLaunch(source, sourceRun).command,
              args: this.providerLaunch(source, sourceRun).args, env: {}, workspacePath: source.workspacePath, signal: new AbortController().signal }) : null
          if (!witness?.handle || !sameNativeHandle(witness.handle, forkSource.expectedNativeHandle)) {
            throw new AgentMuxError('The fork source has no confirmed current native witness. Refresh or confirm it; its raw input is retained.', 'AGENT_FORK_SOURCE_CHANGED')
          }
          assertForkCurrent = async () => { await witness.assertCurrent() }
          await assertForkCurrent()
        }
      }
      const launchContext = {
        workspacePath: input.workspacePath,
        prompt: launchPrompt,
        args: [...(input.args ?? []), ...launchOptionArgv],
        env: input.env ?? {},
        ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride })
      }
      let plan = forkSource ? provider.buildForkLaunch!({ ...launchContext, nativeHandle: forkSource.expectedNativeHandle })
        : nativeResumeSource ? provider.buildResumeLaunch({ ...launchContext, nativeHandle: nativeResumeSource.nativeHandle })
        : provider.buildLaunch(launchContext)
      const executableContext = { workspacePath: input.workspacePath, env: terminalEnvironment(plan.env) }
      const capability = await this.probeAgent(input.providerId, plan.command, executableContext)
      if (!capability.installed && !(capability.providerId === provider.id && unconfirmedExecutableObservation(capability, plan.command))) {
        throw executorUnavailableError(provider.label, capability)
      }
      const originalExecutable = plan.command
      const managedLaunch = await provider.prepareManagedLaunch?.(plan, lifecycleOperationId, { kind: forkSource ? 'fork' : nativeResumeSource ? 'resume' : 'create', prompt: launchPrompt })
      if (managedLaunch) plan = managedLaunch.plan
      const initialInput: AgentMuxContinuityLaunchInput | undefined = composed.text.trim() ? {
        input: { submissionId: `launch-prompt:${lifecycleOperationId}`, prompt: originalPrompt ?? '' },
        prompt: composed.text, digest: createHash('sha256').update(composed.text).digest('base64url'),
        message: { ...(composed.systemContext ? { systemContext: composed.systemContext } : {}),
          ...(originalPrompt?.trim() ? { userContent: originalPrompt } : {}),
          ...(initialEnvelope?.senderSessionId ? { authorAgentSessionId: initialEnvelope.senderSessionId } : {}) },
        delivery: managedLaunch?.promptDelivery === 'post-launch' || deferredPrompt.trim() ? 'post-launch' : 'launch',
        lifecycleOperationId, launchPlan: { program: plan.command, argsDigest: createHash('sha256').update(JSON.stringify(plan.args)).digest('base64url') }, state: 'prepared'
      } : undefined
      // Binding 必须先于 Hook 安装：一个把 hook 投递代码**写进文件**的 Provider（opencode 的 JS
      // 插件）跑在自己进程里，拿不到 AgentMux 注入 PTY 的 `AGENTMUX_HOOK_URL`/`TOKEN`，所以 endpoint
      // 必须在安装那一刻就内联进被写出去的内容。写命令的那九家不受影响——它们的命令在运行时才从
      // 自己进程的环境变量读。createBinding 不依赖 hook 安装结果，故这个顺序是安全的。
      await this.requireHookIngressOwner()
      hookBinding = this.hookServer.createBinding(
        agentSessionId,
        input.providerId,
        hookBindingIdentity(lifecycleOperationId)
      )
      await this.ensureManagedHooks(
        provider,
        input.workspacePath,
        agentSessionId,
        input.env ?? {},
        hookBinding.endpoint
      )
      const launchOptions = normalizeLaunchOptionSelection(input.launchOptions)
      let preparedCreation: AgentMuxPreparedCreation | undefined
      if (reservation.kind === 'create') {
        const preparedAt = Date.now()
        preparedCreation = { kind: 'agent', agentSessionId, providerId: input.providerId, executorId, hostId: 'local',
          workspacePath: input.workspacePath, hookBindingId: hookBinding.bindingId, hookToken: hookBinding.endpoint.token,
          ...(managedLaunch?.nativeActor ? { nativeActor: managedLaunch.nativeActor } : {}),
          ...(initialInput ? { initialInput } : {}),
          capabilityHash: hashAgentCapability(invocationCapability), createdAt: preparedAt, updatedAt: preparedAt,
          creation: { createOperationId, intentDigest, ...(createdBy ? { createdBy } : {}),
            ...(initialEnvelope ? { initialMessageId: initialEnvelope.messageId } : {}),
            initialPrompt: input.prompt?.trim() ? 'unknown' : 'not-requested', ...(contextRequested ? { agentMuxContext: 'unknown' as const } : {}), ...(admitted?.origin ? { initialMessageOrigin: admitted.origin } : {}), ...(admitted?.executorRevision ? { executorRevision: admitted.executorRevision } : {}) },
          ...(forkSource ? { forkedFrom: structuredClone(forkSource) } : {}),
          ...(nativeResumeSource ? { nativeHandle: structuredClone(nativeResumeSource.nativeHandle) } : {}), ...(launchOptions ? { launchOptions } : {}) }
        reservation = await this.registry.prepareCreate(reservation, preparedCreation!)
        this.pendingLifecycleBindings.set(lifecycleOperationId, hookBinding)
      }
      if (forkSource) {
        assertAgentForkSource(forkSource, await this.currentStoredAgentSession(forkSource.agentSessionId), input)
        await assertForkCurrent?.()
      }
      await assertNativeSource?.()
      const startInput = {
        operationKey: lifecycleOperationId,
        program: plan.command,
        args: plan.args,
        cwd: input.workspacePath,
        env: this.agentEnvironment(
          plan.env,
          agentSessionId,
          input.providerId,
          executorId,
          hookBinding,
          lifecycleOperationId,
          invocationCapability
        ),
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows })
      }
      signal?.throwIfAborted()
      preservePreparedCreation = true
      startAttempted = true
      const run = await this.kernel.start(startInput).catch(error => {
        if (!(error instanceof AgentMuxError && error.creationFailure?.operationId === lifecycleOperationId &&
          error.creationFailure.disposition === 'not_applied')) {
          const failure = new AgentMuxError(`Agent start is unconfirmed. Inspect the original operation; no start or input was resent. ${error instanceof Error ? error.message : String(error)}`,
            'AGENT_CREATION_UNCONFIRMED', undefined, undefined, undefined,
            { operationId: lifecycleOperationId, disposition: 'unknown' },
            error instanceof AgentMuxError ? error.storageFailure : undefined)
          Object.defineProperty(failure, 'cause', { value: error })
          throw failure
        }
        preservePreparedCreation = false
        throw agentCreationNotAppliedError(error, lifecycleOperationId)
      })
      this.publishExecutableCheckFailure(provider.label, agentSessionId, lifecycleOperationId, originalExecutable, capability, run)
      const now = Date.now()
      const boundInitialInput = bindInitialInput(initialInput, agentSessionId, runRef(run.runId))
      const session: AgentMuxStoredAgentSession = {
        kind: 'agent',
        agentSessionId,
        providerId: input.providerId,
        executorId,
        hostId: 'local',
        workspacePath: input.workspacePath,
        run: runRef(run.runId),
        retiredRuns: [],
        hookBindingId: hookBinding.bindingId,
        hookToken: hookBinding.endpoint.token,
        ...(managedLaunch?.nativeActor ? { nativeActor: managedLaunch.nativeActor } : {}),
        ...(boundInitialInput ? { initialInput: boundInitialInput } : {}),
        // 只存 hash：raw 凭证已随 env 进了受管进程，Core 这边不再留明文。
        capabilityHash: hashAgentCapability(invocationCapability),
        createdAt: preparedCreation?.createdAt ?? now,
        updatedAt: preparedCreation?.updatedAt ?? now,
        creation: { createOperationId, ...(boundInitialInput?.key ? { initialInputKey: boundInitialInput.key } : {}), initialPrompt: input.prompt?.trim() ? 'unknown' : 'not-requested',
          intentDigest, ...(createdBy ? { createdBy, createdRun: runRef(run.runId) } : {}),
          ...(initialEnvelope ? { initialMessageId: initialEnvelope.messageId } : {}), ...(contextRequested ? { agentMuxContext: 'unknown' as const } : {}),
          ...(admitted?.origin ? { initialMessageOrigin: admitted.origin } : {}), ...(admitted?.executorRevision ? { executorRevision: admitted.executorRevision } : {}) },
        ...(forkSource ? { forkedFrom: structuredClone(forkSource) } : {}),
        ...(nativeResumeSource ? { nativeHandle: structuredClone(nativeResumeSource.nativeHandle) } : {}),
        ...(launchOptions ? { launchOptions } : {})
      }
      if (
        !launchPrompt.trim() &&
        (input.args?.length ?? 0) === 0 &&
        provider.terminalHandshake &&
        provider.terminalPromptRender
      ) {
        const handshakeOperationId = terminalHandshakeOperationIdentity(
          session.providerId,
          session.run.runId,
          provider.terminalHandshake
        )
        session.terminalPromptReadiness = {
          source: 'initial-composer',
          id: terminalInitialPromptReadinessIdentity(session, handshakeOperationId),
          run: { ...session.run },
          outputCursorBytes: 0
        }
      }
      let readySession = session
      let creationStep: NonNullable<NonNullable<AgentMuxAgentSession['creation']>['failure']>['step'] = 'session-commit'
      try {
        try {
          persisted = await this.registry.commitLifecycle(reservation, session)
        } catch (error) {
          // The replacement is readable but lacks a durable acknowledgement. Keep its healthy Run.
          persisted = this.retainUnconfirmedLifecycle(error, session)
          readySession = persisted
        }
        preservePreparedCreation = false
        creationStep = 'hook-bind'
        await hookBinding.bindRun(run.runId)
        this.pendingLifecycleBindings.delete(lifecycleOperationId)
        creationStep = 'handshake'
        // Hook and terminal observation cannot undo an acknowledged Session commit.
        readySession = await this.ensureTerminalHandshakeOrDegrade(readySession, run)
      } catch (error) {
        if (error instanceof AgentMuxError && error.code === AGENT_TERMINAL_HANDSHAKE_FAILED) {
          readySession = await this.retainCreationFailure(persisted ?? session, creationStep, error, !persisted)
          preservePreparedCreation = !persisted
          this.hookBindings.set(run.runId, hookBinding); this.runPids.set(run.runId, run.pid)
          this.pendingLifecycleBindings.delete(lifecycleOperationId)
          await this.publishCurrentRunState(readySession)
          throw error
        }
        if (!persisted) {
          try {
            const canonical = (await this.store.readMetadata(agentSessionId))
            if (canonical?.run.runId === run.runId && canonical.creation?.intentDigest === intentDigest && canonical.hookBindingId === session.hookBindingId) {
              persisted = this.registry.rememberStartedCreation(canonical); preservePreparedCreation = false
            }
          } catch { /* Retain the durable no-Run seed and real Run while commit outcome is unknown. */ }
        }
        if (persisted && creationStep === 'session-commit') {
          try {
            creationStep = 'hook-bind'; await hookBinding.bindRun(run.runId)
            this.pendingLifecycleBindings.delete(lifecycleOperationId)
            creationStep = 'handshake'; readySession = await this.ensureTerminalHandshakeOrDegrade(persisted, run)
          } catch (observationError) {
            if (observationError instanceof AgentMuxError && observationError.code === AGENT_TERMINAL_HANDSHAKE_FAILED) {
              readySession = await this.retainCreationFailure(persisted, creationStep, observationError, false)
              await this.publishCurrentRunState(readySession)
              throw observationError
            }
            readySession = await this.retainCreationFailure(persisted, creationStep, observationError, false)
            this.hookBindings.set(run.runId, hookBinding); this.runPids.set(run.runId, run.pid)
            this.pendingLifecycleBindings.delete(lifecycleOperationId)
            this.queueNativeIdentityCapture(readySession, input)
            await this.publishCurrentRunState(readySession)
            return { session: this.projectSession(readySession), promptConfirmed: false, creation: readySession.creation! }
          }
        } else {
          preservePreparedCreation = !persisted
          readySession = await this.retainCreationFailure(persisted ?? session, creationStep, error, !persisted)
          this.hookBindings.set(run.runId, hookBinding); this.runPids.set(run.runId, run.pid)
          this.pendingLifecycleBindings.delete(lifecycleOperationId)
          this.queueNativeIdentityCapture(readySession, input)
          await this.publishCurrentRunState(readySession)
          return { session: this.projectSession(readySession), promptConfirmed: false, creation: readySession.creation! }
        }
      }
      this.hookBindings.set(run.runId, hookBinding)
      this.runPids.set(run.runId, run.pid)
      this.queueNativeIdentityCapture(readySession, input)
      this.publishSession(readySession)
      this.publisher.publishRunState(this.projectRun(run, readySession), agentSessionId)
      // A deferred input receipt must precede the history's delivery status. A healthy Run remains
      // available when input confirmation fails; the retained history must not claim it was sent.
      let observedInputConfirmed = false
      try { readySession = await this.continueInitialInput(readySession, run, () => this.assertCreationInputCurrent(session, run)) }
      catch (error) {
        // A Session projection write can fail after the original input owner acknowledged it.
        // Read that exact receipt; neither the failed projection nor this read authorizes Input.
        const original = readySession.initialInput
        if (original?.key) {
          try {
            const receipt = await this.inspectAgentPromptSubmission(original.key)
            observedInputConfirmed = isDeepStrictEqual(receipt?.admission?.inputKey, original.key) &&
              this.postLaunchPromptConfirmed(receipt, original.prompt, original.message)
          } catch { /* The original input remains unconfirmed when its owner is unavailable. */ }
        }
        this.publisher.publish({ type: 'agent-error', agentSessionId, code: 'AGENT_CREATION_RECEIPT_UNCONFIRMED',
          message: `${observedInputConfirmed ? 'The original initial input was confirmed; saving its Session projection is unconfirmed.' : 'The original initial input is retained; its delivery receipt is unconfirmed.'} ${error instanceof Error ? error.message : String(error)}`,
          evidence: { source: 'agentmux', observedAt: Date.now(), run: session.run } })
      }
      const inputConfirmed = observedInputConfirmed || ['launch-carried', 'terminal-confirmed', 'native-admitted'].includes(readySession.initialInput?.state ?? '')
      // Empty deferred text says nothing about context delivery. Native takeover
      // has no separate platform-context carrier; retain its no-input restoration.
      const promptConfirmed = inputConfirmed || !composed.text.trim() && !contextRequested && !input.prompt?.trim()
      if (composed.systemContext) {
        await this.recordMessageAfterSideEffect(
          readySession,
          `system-context:${lifecycleOperationId}`,
          'AgentMux context',
          composed.systemContext,
          now,
          'agentmux',
          { status: promptConfirmed ? 'complete' : 'failed' }
        )
      }
      if (input.prompt?.trim()) {
        await this.recordMessageAfterSideEffect(
          readySession,
          `prompt:${lifecycleOperationId}`,
          'Initial prompt',
          originalPrompt!,
          now,
          'user',
          { status: promptConfirmed ? 'complete' : 'failed',
            ...(!initialEnvelope ? { publicContent: 'confirmed' as const } : {}),
            ...(initialEnvelope?.senderSessionId ? { authorAgentSessionId: initialEnvelope.senderSessionId } : {}) }
        )
      }
      const creation: NonNullable<AgentMuxAgentSession['creation']> = {
        createOperationId,
        ...(boundInitialInput?.key ? { initialInputKey: boundInitialInput.key } : {}),
        intentDigest,
        ...(createdBy ? { createdBy, createdRun: runRef(run.runId) } : {}),
        ...(initialEnvelope ? { initialMessageId: initialEnvelope.messageId } : {}),
        ...(admitted?.origin ? { initialMessageOrigin: admitted.origin } : {}), ...(admitted?.executorRevision ? { executorRevision: admitted.executorRevision } : {}),
        initialPrompt: input.prompt?.trim() ? (promptConfirmed ? 'confirmed' : 'unconfirmed') : 'not-requested',
        ...(contextRequested || composed.systemContext ? { agentMuxContext: composed.systemContext && inputConfirmed ? 'confirmed' as const : 'unconfirmed' as const } : {})
      }
      // Input has already happened. A save observation failure cannot revoke a healthy Run or
      // authorize sending again. Return the actual receipt; a later read keeps the durable unknown.
      try {
        readySession = await this.updateExactAgentSession(agentSessionId, session.run,
          current => ({ ...current, creation, updatedAt: Date.now() }))
        this.publishSession(readySession)
      } catch {
        try { this.publisher.publish({ type: 'agent-error', agentSessionId,
          code: 'AGENT_CREATION_RECEIPT_UNCONFIRMED',
          message: 'Agent started, but saving its initial delivery receipt is unconfirmed. Read its response before submitting again.',
          evidence: { source: 'user', observedAt: Date.now(), run: session.run } }) } catch { /* Run remains usable. */ }
      }
      if (initialEnvelope) await this.recordInitialMessageDelivery(readySession, initialEnvelope, promptConfirmed)
      return { session: this.projectSession(readySession), promptConfirmed, creation }
    } catch (error) {
      // Successful reservation is this new creation's exclusive no-Start boundary.
      // Existing, claimed and replayed creations never enter this catch.
      creationError = !startAttempted ? agentCreationNotAppliedError(error, lifecycleOperationId) : error
      throw creationError
    } finally {
      const cleanup: Array<() => Promise<void>> = []
      if (hookBinding && !preservePreparedCreation && ![...this.hookBindings.values()].includes(hookBinding)) {
        const unusedBinding = hookBinding
        cleanup.push(async () => { await unusedBinding.close() })
      }
      if (!preservePreparedCreation) {
        this.pendingLifecycleBindings.delete(lifecycleOperationId)
        // A readable started Session has either committed (which atomically
        // releases creation) or still needs its original uncertain preparation.
        // Neither case authorizes cleanup to release a later Stop reservation.
        if (!persisted) {
          cleanup.push(async () => { await this.registry.releaseLifecycle(reservation) })
        }
      }
      if (cleanup.length) await finishAgentCreationCleanup(creationError, cleanup)
    }
  }

  private async publishCurrentRunState(session: AgentMuxStoredAgentSession): Promise<void> {
    try {
      const run = await this.kernel.status(session.run.runId)
      this.publisher.publishRunState(this.projectRun(run, session), session.agentSessionId)
    } catch (error) {
      this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
        code: 'AGENT_RUN_OBSERVATION_UNCONFIRMED',
        message: `Current Run state is unknown. Refresh the original Session. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', run: session.run, observedAt: Date.now() } })
    }
  }

  private async retainCreationFailure(session: AgentMuxStoredAgentSession,
    step: NonNullable<NonNullable<AgentMuxAgentSession['creation']>['failure']>['step'], error: unknown,
    unconfirmedPersistence: boolean): Promise<AgentMuxStoredAgentSession> {
    const failure = { step, code: error instanceof AgentMuxError ? error.code : 'AGENT_CREATION_FLOW_UNCONFIRMED',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 4096) || 'Creation observation is unconfirmed.' }
    let next: AgentMuxStoredAgentSession = { ...session, updatedAt: Math.max(Date.now(), session.updatedAt + 1),
      creation: { ...session.creation!, ...(unconfirmedPersistence ? { persistence: 'unconfirmed' as const } : {}), failure } }
    if (unconfirmedPersistence) next = this.registry.rememberStartedCreation(next)
    else {
      try { next = await this.updateExactAgentSession(session.agentSessionId, session.run, current => ({ ...current,
        creation: { ...current.creation!, failure }, updatedAt: Math.max(current.updatedAt + 1, next.updatedAt) })) }
      catch { /* The actual Run and the returned observation remain available despite this save failure. */ }
    }
    this.publishSession(next)
    if (step === 'hook-bind') this.observeHookRestoreFailure(next, 'binding', error)
    const exited = error instanceof AgentMuxError && error.code === AGENT_TERMINAL_HANDSHAKE_FAILED
    this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
      code: exited ? AGENT_TERMINAL_HANDSHAKE_FAILED : 'AGENT_CREATION_UNCONFIRMED',
      message: exited ? failure.message : `Agent started on Run ${session.run.runId}; ${step} is unconfirmed. Keep this Run and inspect the same creation operation. ${failure.message}`,
      evidence: { source: 'agentmux', observedAt: Date.now(), run: session.run } })
    return next
  }

  /** Reconcile only a real matching started Run; never repeats start, reminder or user input. */
  private async completePreparedCreate(reservation: Extract<AgentMuxLifecycleReservation, { kind: 'create' }>,
    run: CtxmuxAdapterRun | null): Promise<AgentMuxStoredAgentSession> {
    const seed = reservation.preparedCreation
    if (!seed || !run || run.lifecycleOperationId !== reservation.operationId || run.workspacePath !== seed.workspacePath) throw new AgentMuxError(
      'The original creation has no single confirmed matching Run. Its prepared identity is retained; inspect the same operation without resending.',
      'AGENT_CREATION_UNCONFIRMED', undefined, { disposition: 'unknown', confirmedInputBytes: null })
    const initialInput = bindInitialInput(seed.initialInput, seed.agentSessionId, runRef(run.runId))
    const session: AgentMuxStoredAgentSession = { ...structuredClone(seed), run: runRef(run.runId), retiredRuns: [],
      ...(initialInput ? { initialInput } : {}), creation: { ...seed.creation!, ...(initialInput?.key ? { initialInputKey: initialInput.key } : {}),
        ...(seed.creation?.createdBy ? { createdRun: runRef(run.runId) } : {}) } }
    let committed: AgentMuxStoredAgentSession | null = null
    try { committed = await this.registry.commitLifecycle(reservation, session) }
    catch (error) {
      try {
        const saved = (await this.store.readMetadata(seed.agentSessionId))
        if (saved?.run.runId === run.runId && saved.creation?.intentDigest === seed.creation?.intentDigest &&
          saved.hookBindingId === seed.hookBindingId && saved.hookToken === seed.hookToken) committed = this.registry.rememberStartedCreation(saved)
      } catch { /* An unknown commit preserves the original prepared identity and actual Run. */ }
      if (!committed) {
        const retained = await this.retainCreationFailure(session, 'session-commit', error, true)
        this.runPids.set(run.runId, run.pid)
        return retained
      }
    }
    let ready = committed!
    try {
      await this.requireHookIngressOwner()
      const binding = this.pendingLifecycleBindings.get(reservation.operationId) ?? this.hookBindings.get(run.runId) ??
        this.hookServer.createBinding(seed.agentSessionId, seed.providerId, seed.hookBindingId, seed.hookToken)
      this.pendingLifecycleBindings.set(reservation.operationId, binding)
      this.hookBindings.set(run.runId, binding)
      await binding.bindRun(run.runId)
      this.pendingLifecycleBindings.delete(reservation.operationId)
    } catch (error) { ready = await this.retainCreationFailure(ready, 'hook-bind', error, false) }
    this.runPids.set(run.runId, run.pid)
    this.publishSession(ready)
    this.publisher.publishRunState(this.projectRun(run, ready), ready.agentSessionId)
    return ready
  }

  private publishExecutableCheckFailure(label: string, agentSessionId: string, operationId: string,
    executable: string, capability: AgentCapabilitySnapshot, run: CtxmuxAdapterRun): void {
    const observation = unconfirmedExecutableObservation(capability, executable)
    if (!observation) return
    // An unscoped diagnostic reaches System without assigning an error semantic state to this Run.
    this.publisher.publish({ type: 'agent-error', code: 'AGENT_EXECUTABLE_CHECK_UNCONFIRMED',
      message: `Executable preflight for ${label} (Agent ${agentSessionId}, operation ${operationId}) could not be confirmed: ` +
        `${observation.cause.code}: ${observation.cause.message}. Native start returned Run ${run.runId} in ${run.state.type} state; ` +
        'CLI readiness and task completion are separate facts. Original Session controls remain available. ' +
        'Recheck this Executor’s availability in its configuration or through the public executor refresh command. Keep this Session and do not resend unconfirmed input.',
      evidence: { source: 'agentmux', run: runRef(run.runId), observedAt: Date.now() } })
  }

  /**
   * Ensure the provider's managed Hook config is installed before its process starts. This is the
   * F3 launch-time trigger: idempotent (an already-current config is a no-op) and install-and-leave —
   * the config is never uninstalled on stop, because a provider like antigravity shares one global
   * `~/.gemini` file across every concurrent agent and ripping it out would break a running sibling.
   *
   * Best-effort: a native provider whose hook config cannot be written still launches or reattaches.
   * An unscoped diagnostic reaches the existing window notice without marking a healthy Agent failed.
   * Providers whose hooks are not explicit-managed never reach the installer.
   *
   * The launch `env` is threaded into plan resolution because a provider's config dir can be env-derived
   * (hermes reads `$HERMES_HOME`): the installer must target the same dir the launched process will read.
   *
   * `endpoint` comes from the launch or restored Binding. It is what a Provider
   * that writes its **delivery code** into a file needs (opencode's JS plugin runs inside OpenCode's own
   * process and never sees the PTY env), so such a Provider must inline the URL and token at install time.
   * Without a Binding, a Provider that needs it must decline to produce a plan rather than write one
   * carrying a dead token. A connection alone never supplies the Executor's configuration environment.
   */
  private managedHookPlan(provider: AgentProvider, context: AgentManagedHookPlanContext): AgentManagedHookPlan | null {
    let plan: AgentManagedHookPlan | null
    try {
      plan = provider.planManagedHooks?.(context) ?? null
    } catch (cause) {
      if (cause instanceof AgentMuxError) throw cause
      throw new AgentMuxError(cause instanceof Error ? cause.message : String(cause), 'HOOK_PLAN_FAILED')
    }
    if (plan && plan.providerId !== provider.id) {
      throw new AgentMuxError(`Managed Hook plan for ${provider.id} belongs to ${plan.providerId}.`, 'HOOK_PLAN_PROVIDER_MISMATCH')
    }
    return plan
  }

  private async ensureManagedHooks(
    provider: AgentProvider,
    workspacePath: string,
    agentSessionId: string,
    env: Readonly<Record<string, string>>,
    endpoint?: { url: string; token: string }
  ): Promise<void> {
    const hookStrategy = provider.catalog.hookStrategy
    if (hookStrategy.kind !== 'native' || hookStrategy.installation !== 'explicit-managed') return
    try {
      const plan = this.managedHookPlan(provider, { workspacePath, env, ...(endpoint ? { endpoint } : {}) })
      if (!plan) throw new AgentMuxError('The exact managed Hook planning context is unavailable.', 'HOOK_PLAN_CONTEXT_UNAVAILABLE')
      await this.hookInstaller.ensure(plan)
    } catch (error) {
      this.publisher.publish({
        type: 'agent-error',
        code: error instanceof AgentMuxError ? error.code : 'HOOK_INSTALL_FAILED',
        message: `Managed Hook configuration for ${provider.label} (Agent ${agentSessionId}) could not be repaired. ` +
          `The Agent continues; status Hook delivery is unconfirmed. Check its configuration permissions and retry recovery. ${
          error instanceof Error ? error.message : String(error)
        }`,
        evidence: { source: 'user', observedAt: Date.now() }
      })
    }
  }

  async reattachAgent(agentSessionId: string, afterByte?: number, view: AgentMuxRunAttachmentView = 'raw'): Promise<AgentMuxAgentAttachment> {
    const { session, attached } = await this.attachAgentRun(agentSessionId, afterByte, undefined, view)
    this.publisher.publishRunState(this.projectRun(attached.run, session), agentSessionId)
    return {
      session: this.projectSession(session),
      attachment: {
        ...attached,
        run: this.projectRun(attached.run, session),
      }
    }
  }

  /** Observe one Agent's raw bytes without replacing the client host's visible Attachment. */
  async observeAgentOutput(agentSessionId: string, afterByte: number,
    listener: (event: AgentMuxClientEvent) => void): Promise<AgentMuxAgentAttachment & { close(): Promise<void> }> {
    this.requireConnected()
    const session = await this.resolveRawAgentSession(agentSessionId)
    const publisher = new AgentMuxClientEventPublisher()
    publisher.onEvent(listener)
    const off = this.publisher.onStatusEvent(event => {
      // This observation receives faults and Gaps from its own Attachment below.
      // A shared workflow, input or another reader's diagnostic cannot establish
      // failure of this healthy raw-output lane merely by naming the same Run.
      if (event.type === 'connection-state' && event.state !== 'restored') publisher.publish({
        type: 'agent-error', agentSessionId, code: 'CONTROL_UNAVAILABLE',
        message: 'This output reader lost its Runtime connection. Reconnect using the original byte cursor.',
        evidence: { source: 'run-process', observedAt: Date.now(), run: session.run }
      })
    })
    let closed = false
    let observation: Awaited<ReturnType<CtxmuxRunAdapter['observeOutput']>> | undefined
    let publishedThroughByte: number | null = null
    const close = async () => { if (closed) return; closed = true; off(); publisher.dispose(); await observation?.close() }
    try {
      observation = await this.kernel.observeOutput(session.run.runId, afterByte, event => {
        if (closed) return
        if (event.type === 'data') {
          publishedThroughByte = event.endByte
          publisher.publishRunEvent(event, this.projectSession(session))
        }
        else if (event.type === 'exit') publisher.publish({
          type: 'process-state', agentSessionId, run: session.run, state: event.state.type,
          pid: observation?.run.pid ?? null,
          ...(event.state.type === 'exited' ? { exitCode: event.state.code,
            ...(event.state.signal === null ? {} : { exitSignal: event.state.signal }) } : {}),
          evidence: { source: 'run-process', observedAt: event.observedAt, run: session.run }
        })
        else if (event.type === 'error' || event.type === 'gap') publisher.publish({
          type: 'agent-error', agentSessionId, code: event.type === 'error' ? event.error.code : 'OUTPUT_GAP',
          message: event.type === 'error' ? event.error.message : 'This reader missed a continuous output range. Reconnect from its original cursor.',
          evidence: { source: 'terminal-output', observedAt: Date.now(), run: session.run,
            ...(event.type === 'gap' ? { outputGap: { kind: 'live-stream', latestOutputBytes: event.latestOutputBytes,
              publishedThroughByte, representation: 'raw', causes: event.causes, observation: event.observation } } : {}) }
        })
      })
      publishedThroughByte ??= observation.replay.at(-1)?.endByte ?? null
      if (this.requireAgentSession(agentSessionId).run.runId !== session.run.runId) throw new AgentMuxError(
        'Agent Session changed while the output reader was being established.', 'STALE_AGENT_SESSION_BINDING')
      this.assertAgentRun(session, observation.run)
      return { session: this.projectSession(session), attachment: { ...observation,
        run: this.projectRun(observation.run, session) }, close }
    } catch (error) { await close(); throw error }
  }

  /**
   * 重建一个 Agent Run 的实时 attachment——**唯一**的 attach 实现，`reattachAgent`（用户显式 attach）与
   * `republishLiveRunState`（重连后自动重建字节泵）都走这里。它承的那几件事一处都不能少，也一处都不能
   * 在别处再抄一遍：身份校验（`assertAgentRun` + 陈旧绑定闸）、失败回滚（rollback detach）、pid 与输入
   * 游标记账。第二份平行实现必然与这份漂移，所以两条路共用这一处。
   *
   * 只做重建与记账，**不**发 process-state、也**不**把 replay 交出去：两个调用方对这两件事的处置不同
   * （reattachAgent 把 replay 回给调用者、由渲染端应用；republish 没有调用者，得把 replay 当事件补发），
   * 所以留给调用方。新消费者默认从保留输出起点读取；同进程重连显式传入 Attachment 已发布的边界。
   * 该位置不是 Renderer 已绘制的确认，也不是完整的 VT checkpoint。
   */
  private async attachAgentRun(
    agentSessionId: string,
    afterByte = 0,
    beforeLive?: (snapshot: CtxmuxAdapterAttachment, session: AgentMuxStoredAgentSession) => void,
    view: AgentMuxRunAttachmentView = 'raw',
    observationOrigin?: AgentMuxObservationOrigin
  ): Promise<{ session: AgentMuxStoredAgentSession; attached: CtxmuxAdapterAttachment }> {
    this.requireConnected()
    const session = await this.resolveRawAgentSession(agentSessionId)
    const validate = (snapshot: CtxmuxAdapterAttachment): void => {
      const current = this.requireAgentSession(agentSessionId)
      if (current.run.runId !== session.run.runId) {
        throw new AgentMuxError('Agent Session changed while its Run was being attached.', 'STALE_AGENT_SESSION_BINDING')
      }
      this.assertAgentRun(session, snapshot.run)
    }
    const attached = await this.kernel.attach(session.run.runId, afterByte,
      beforeLive || observationOrigin ? (snapshot) => { validate(snapshot); beforeLive?.(snapshot, session) } : undefined,
      view, Boolean(observationOrigin))
    try {
      validate(attached)
    } catch (error) {
      try {
        await this.kernel.detach(attached.run.runId)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Agent reattach rollback failed.')
      }
      throw error
    }
    this.runPids.set(attached.run.runId, attached.run.pid)
    if (attached.run.acceptedInputBytes !== null) {
      this.agentInputCursors.set(agentSessionId, attached.run.acceptedInputBytes)
    }
    // 恢复路径：实时通道又通了，撤下「输出通道断了」的降级事实。放在这处共享核心而非两个调用方各自
    // 抄一遍——它对两条路（自动重连 / 用户 Resume）的处置相同，不像 process-state/replay 那样分叉。
    // 缺席即 no-op（clearOutputChannel 早退），所以对没进过降级的正常 attach 零成本。
    await this.clearOutputChannel(session, observationOrigin)
    return { session: this.requireAgentSession(agentSessionId), attached }
  }

  async ensureAgentContinuity(
    input: AgentMuxAgentContinuityInput, context?: Pick<AgentInputCallContext, 'inputContextSource' | 'captureReader' | 'requestSignal'>
  ): Promise<AgentMuxAgentContinuityResult> { return await this.recovery.ensureAgentContinuity(input, context) }

  /** Change the original durable intent; never stop its Run or replay its pending input. */
  async controlAgentContinuity(value: AgentMuxContinuityControlInput,
    context?: Pick<AgentInputCallContext, 'requestSignal' | 'assertCurrent'> & { caller?: { agentSessionId: string; capability: string } }
  ): Promise<AgentMuxContinuityControlResult> { return await this.recovery.controlAgentContinuity(value, context) }

  /** Stop only the explicitly named generation, then restore its exact native conversation without input. */
  async restartAgent(value: AgentMuxAgentRestartInput): Promise<AgentMuxAgentSession> { return await this.recovery.restartAgent(value) }

  /** Read the original restart progress. Never starts, stops or submits input. */
  async inspectAgentRestart(value: AgentMuxAgentRestartIdentity): Promise<AgentMuxAgentRestartInspection> { return await this.recovery.inspectAgentRestart(value) }

  async resumeAgent(input: AgentMuxAgentResumeInput): Promise<AgentMuxAgentSession> { return await this.recovery.resumeAgent(input) }

  /** Explicitly continue an exact retired native conversation; reading history never calls this. */
  async reopenAgent(input: AgentMuxAgentReopenInput): Promise<AgentMuxAgentSession> { return await this.recovery.reopenAgent(input) }

  /** Complete an explicitly requested original operation; never launches, inputs or stops a Run. */
  async reconcileAgentReopen(input: Pick<AgentMuxAgentReopenInput, 'agentSessionId' | 'expectedRetiredAt' | 'operationId'>): Promise<AgentMuxAgentSession> { return await this.recovery.reconcileAgentReopen(input) }

  async respawnAgent(input: AgentMuxAgentRespawnInput): Promise<AgentMuxAgentSession> {
    const previous = this.requireAgentSession(input.previousAgentSessionId)
    const agentSessionId = input.agentSessionId ?? mintAgentSessionId()
    if (agentSessionId === previous.agentSessionId) {
      throw new AgentMuxError('Respawn must create a new Agent Session identity.', 'AGENT_SESSION_ID_REUSE')
    }
    const { previousAgentSessionId: _previousAgentSessionId, ...launch } = input
    return await this.createAgent({
      ...launch,
      agentSessionId,
      providerId: previous.providerId,
      executorId: previous.executorId,
      workspacePath: previous.workspacePath
    })
  }

  async writeAgent(input: AgentMuxAgentWriteInput, context?: AgentRawInputCallContext): Promise<AgentMuxRunInputAck> {
    this.requireConnected()
    const call = this.rawInputCall(context)
    const session = await observePromptInput(call.signal, () => this.resolveRawAgentSession(input.agentSessionId))
    call.check()
    if (!sameRun(session.run, input.expectedRun)) {
      throw new AgentMuxError('Agent Session changed before native input.', 'STALE_AGENT_SESSION')
    }
    if (input.source !== 'user' && input.source !== 'terminal-protocol') {
      throw new AgentMuxError('Native input must declare its user or terminal-protocol source.', 'INVALID_AGENT_INPUT_SOURCE')
    }
    return await this.writeAgentInput(session, input.data, input.source, 'write', readInputObservationField(input), call)
  }

  async pasteAgent(input: AgentMuxAgentPasteInput, context?: AgentRawInputCallContext): Promise<AgentMuxRunInputAck> {
    this.requireConnected()
    const call = this.rawInputCall(context)
    const session = await observePromptInput(call.signal, () => this.resolveRawAgentSession(input.agentSessionId))
    call.check()
    if (!sameRun(session.run, input.expectedRun)) {
      throw new AgentMuxError('Agent Session changed before paste.', 'STALE_AGENT_SESSION')
    }
    const plan = this.providers.get(session.providerId).planPromptInput(input.text)
    return await this.writeAgentInput(session, plan.kind === 'render-then-submit'
      ? plan.payload
      : input.terminalData, 'user', 'paste', readInputObservationField(input), call)
  }

  async submitAgentPrompt(input: AgentMuxAgentPromptInput, context?: AgentInputCallContext): Promise<void | AgentInputSubmissionReceipt> {
    context?.requestSignal?.throwIfAborted()
    let authority = this.inputCallAuthority(undefined, context)
    if ('inputContextSource' in input || 'inputContextCaptureProof' in input || 'promptWire' in input) throw new AgentMuxError('Input producer facts come from the original Host, not prompt arguments.', 'INVALID_AGENT_PROMPT')
    if (input.inputContext !== undefined && input.inputContextCapture !== undefined) throw new AgentMuxError('A captured input carries its original reference, not a second page declaration.', 'INVALID_INPUT_CONTEXT_CAPTURE')
    input = { ...input, ...(input.inputContextCapture === undefined ? {} : { inputContextCapture: parseAgentInputContextCaptureReference(input.inputContextCapture) }), ...(input.inputContext === undefined ? {} : { inputContext: parseBrowserInputContext(input.inputContext) }), expectedRun: { ...input.expectedRun },
      ...(input.admissionIntent ? { admissionIntent: { ...input.admissionIntent } } : {}) } as AgentMuxAgentPromptInput
    if ('authorAgentSessionId' in input) throw new AgentMuxError('Agent authors must use submitAgentMessage.', 'MESSAGE_ENVELOPE_REQUIRED')
    const launched = await this.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: input.agentSessionId,
      expectedRun: input.expectedRun, submissionId: input.operationId })
    if (launched?.launch) throw new AgentMuxError('This original input was carried by its native resume launch. Inspect its original launch receipt; it will not replay through the terminal.', 'AGENT_PROMPT_LAUNCH_CARRIED')
    if (input.inputContextCapture !== undefined) {
      const captured = await resolveAgentInputContextCapture({ reference: input.inputContextCapture, agentSessionId: input.agentSessionId,
        expectedRun: input.expectedRun, operationId: input.operationId, prompt: input.prompt, ...(input.agentMuxNote === undefined ? {} : { agentMuxNote: input.agentMuxNote }) },
        () => this.readCapturedPromptProducer(input.agentSessionId, input.expectedRun, input.operationId), context?.captureReader, context?.requestSignal)
      const { inputContextCapture: _reference, ...original } = input
      input = { ...original, inputContext: captured.inputContext } as AgentMuxAgentPromptInput
      authority = { ...authority, inputContextSource: 'host-capture', inputContextCaptureProof: captured.inputContextCaptureProof,
        assertCurrent: authority?.assertCurrent ?? (async () => {}) }
    }
    if (input.admissionIntent !== undefined) {
      this.validateControlledPrompt(input)
      const key = { kind: 'prompt' as const, agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, submissionId: input.operationId }
      const session = await this.currentStoredAgentSession(input.agentSessionId)
      if (!sameRun(session.run, input.expectedRun)) throw new AgentMuxError('The original input Run changed before saving.', 'STALE_AGENT_SESSION')
      const saved = await this.messageQueue.inspectInput({ key })
      // A legacy claim has no new gate. Preserve its original read/join contract;
      // absence of a journal row cannot prove that it was never dispatched.
      if (saved || !await this.inspectAgentPromptSubmission(key)) {
        const intent: AgentInputJournalIntent = { key, admissionIntent: validateAgentPromptAdmissionIntent({ ...input.admissionIntent, expectedRun: input.expectedRun }) as AgentInputJournalIntent['admissionIntent'], execution: 'immediate',
          environment: this.inputSavedEnvironment(session), source: { kind: 'prompt', prompt: input.prompt,
            ...(input.inputContext === undefined ? {} : { inputContext: input.inputContext,
              inputContextSource: authority?.inputContextSource ?? 'caller-declared',
              ...(authority?.inputContextCaptureProof ? { inputContextCaptureProof: authority.inputContextCaptureProof } : {}),
              promptWire: saved?.intent.source.kind === 'prompt' && saved.intent.source.promptWire !== undefined
                ? saved.intent.source.promptWire : composeAgentPrompt(input.prompt, input.agentMuxNote, input.inputContext).text }),
            ...(input.agentMuxNote === undefined ? {} : { agentMuxNote: input.agentMuxNote }),
            ...(input.authorHuman === undefined ? {} : { authorHuman: input.authorHuman }),
            sourceChannel: normalizeMessageChannel(input.sourceChannel ?? 'api'),
            ...(input.sourceDevice === undefined ? {} : { sourceDevice: normalizeOperationDevice(input.sourceDevice) }) } }
        const original = await this.messageQueue.savePromptInput(intent, async () => !await this.inspectAgentPromptSubmission(key))
        if (original) return await this.acceptInputWaiting(original.control.ref, input, 'prompt', undefined, authority, context?.requestSignal)
      }
    }
    const exactKey = { kind: 'prompt' as const, agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, submissionId: input.operationId }
    if (await this.messageQueue.inspectInput({ key: exactKey })) throw new AgentMuxError(
      'The original controlled input has another admission intent. An exact caller condition cannot replace it.', 'AGENT_PROMPT_OPERATION_CONFLICT')
    await this.submitPromptInternal(input, undefined, undefined, () => {
      if ('authorAgentSessionId' in input) throw new AgentMuxError('Agent authors must use submitAgentMessage.', 'MESSAGE_ENVELOPE_REQUIRED')
    }, authority, 'prompt', context?.nativeIdleOnly ? { nativeIdleOnly: true } : undefined)
  }

  private async readCapturedPromptProducer(agentSessionId: string, expectedRun: AgentMuxRunRef, operationId: string): Promise<AgentPromptMessageContent | undefined> {
    const key = { kind: 'prompt' as const, agentSessionId, expectedRun, submissionId: operationId }
    const claim = await this.inspectAgentPromptSubmission(key)
    if (claim) return claim.admission?.intent?.message ?? claim.launch?.message ?? {}
    const waiting = await this.messageQueue.inspectInput({ key })
    if (!waiting) return undefined
    const source = waiting.intent.source
    return source.kind === 'prompt' ? { ...(source.inputContext ? { inputContext: source.inputContext } : {}),
      ...(source.inputContextSource ? { inputContextSource: source.inputContextSource } : {}),
      ...(source.inputContextCaptureProof ? { inputContextCaptureProof: source.inputContextCaptureProof } : {}) } : {}
  }

  /** Read the original Session owner's exact claim; this never prepares or dispatches input. */
  async inspectAgentPromptSubmission(key: AgentPromptInputKey): Promise<import('./types.js').AgentPromptSubmissionRecord | null> {
    key = validateAgentPromptInputKey(key)
    const original = await this.store.readPromptAdmission(key.agentSessionId, key.expectedRun, agentPromptInputId(key))
    if (original?.admission?.inputKey && !isDeepStrictEqual(original.admission.inputKey, key)) throw new AgentMuxError('The input key names another original producer.', 'AGENT_PROMPT_OPERATION_CONFLICT')
    return original
  }

  private validateControlledPrompt(input: AgentMuxAgentPromptInput): void {
    if (input.admissionIntent === undefined ||
        Object.hasOwn(input, 'afterSubmissionId') || input.execution !== 'immediate' || input.expectedCompletionId !== undefined ||
        input.expectedFutureIntent !== undefined || input.expectedInputByte !== undefined || input.preparationRetry !== undefined) throw new AgentMuxError(
      'Controlled waiting cannot change an exact, automatic or request input intent.', 'INVALID_AGENT_PROMPT')
    validateAgentPromptAdmissionIntent({ ...input.admissionIntent, expectedRun: input.expectedRun })
    safeId(input.operationId, 'Agent prompt operation id')
    if (typeof input.prompt !== 'string' || !input.prompt.trim() && !input.agentMuxNote?.trim()) throw new AgentMuxError('Agent prompt cannot be empty.', 'INVALID_AGENT_PROMPT')
    assertAgentPromptSize(composeAgentPrompt(input.prompt, input.agentMuxNote, input.inputContext).text)
  }

  private inputSavedEnvironment(session: Pick<AgentMuxAgentSession, 'providerId' | 'executorId' | 'nativeHandle' | 'nativeBinding'>): AgentInputSavedEnvironment {
    return { providerId: session.providerId, executorId: session.executorId,
      ...(session.nativeHandle ? { nativeHandle: structuredClone(session.nativeHandle) } : {}),
      ...(session.nativeBinding ? { nativeBinding: { source: session.nativeBinding.source, run: { ...session.nativeBinding.run } } } : {}) }
  }

  /** Read original journal membership; this never creates waiting, prepares or dispatches input. */
  async readAgentInputMailbox(value: AgentInputMailboxRead, caller?: { agentSessionId: string; capability: string }): Promise<AgentInputMailboxPage> {
    const input = parseAgentInputMailboxRead(value)
    if (caller) {
      await this.authorizeRetainedAgentCaller(caller.capability, caller.agentSessionId)
      if (caller.agentSessionId !== input.agentSessionId) throw new AgentMuxError('Input mailbox reading belongs to its exact recipient.', 'CONTROL_PERMISSION_DENIED')
    }
    const page = await this.messageQueue.readInputMailbox(input)
    if (!page.cut.throughSequence && !await this.store.readHistorySource(input.agentSessionId)) throw new AgentMuxError('The exact input recipient is unknown. No Session was created or input changed.', 'UNKNOWN_AGENT_SESSION')
    const result: AgentInputMailboxPage = { agentSessionId: input.agentSessionId, queueId: this.messageQueue.queueId,
      cut: page.cut, budgetBytes: input.maxBytes ?? 64 * 1024, items: [], nextCursor: null,
      coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } }
    const entries: import('./json-read-fragments.js').JsonReadEntry<AgentInputMailboxItem>[] = []
    const fits = (entry: typeof entries[number], nextCursor: string | null) =>
      Buffer.byteLength(JSON.stringify({ ...result, items: [...entries, entry], nextCursor })) <= result.budgetBytes - 1024
    let index = 0, offset = page.offset
    for (const original of page.items) {
      const { sequence, recordedAt } = original
      let item: AgentInputMailboxItem
      if (original.kind === 'submission') {
        let record: import('./types.js').AgentPromptSubmissionRecord | null = null, failure: ReturnType<typeof deliveryFailure> | undefined
        try { record = await this.inspectAgentPromptSubmission(original.key); if (!record) throw new AgentMuxError('The original accepted admission is unavailable.', 'AGENT_INPUT_READ_UNCONFIRMED') }
        catch (error) { failure = deliveryFailure(error) }
        item = { kind: 'submission', sequence, recordedAt, key: original.key, record, ...(failure ? { failure } : {}) }
      } else {
        let receipt: AgentInputSubmissionReceipt | null = null, failure: ReturnType<typeof deliveryFailure> | undefined
        try { receipt = await this.inspectAgentInput({ key: original.intent.key }); if (!receipt) throw new AgentMuxError('The original input receipt is unavailable.', 'AGENT_INPUT_READ_UNCONFIRMED') }
        catch (error) { failure = deliveryFailure(error) }
        const { environment: _environment, ...intent } = original.intent
        item = { kind: 'controlled', sequence, recordedAt, intent, ...(original.message ? { message: original.message,
          ...(original.sourceChannel ? { sourceChannel: original.sourceChannel } : {}), ...(original.sourceDevice ? { sourceDevice: original.sourceDevice } : {}) } : {}),
          receipt, ...(failure ? { failure } : {}) }
      }
      const bytes = Buffer.from(JSON.stringify(item)), digest = createHash('sha256').update(bytes).digest('hex')
      if (offset && (index !== 0 || page.digest !== digest || offset >= bytes.length)) throw new AgentMuxError('The original input observation changed during fragmentation. Retain its claim and retry this read.', 'AGENT_INPUT_READ_CHANGED')
      const next = page.continuation(index + 1)
      if (!offset && fits({ kind: 'item', item }, next)) { entries.push({ kind: 'item', item }); index++; continue }
      const key = item.kind === 'controlled' ? item.intent.key : item.key
      const fragment = (length: number) => ({ kind: 'fragment' as const, itemId: agentInputJournalKey(key), encoding: 'json-utf8-base64' as const,
        sha256: digest, offsetBytes: offset, totalBytes: bytes.length, dataBase64: bytes.subarray(offset, offset + length).toString('base64') })
      let low = 0, high = bytes.length - offset
      while (low < high) {
        const middle = Math.ceil((low + high) / 2), complete = offset + middle === bytes.length
        if (fits(fragment(middle), complete ? next : page.continuation(index, offset + middle, digest))) low = middle
        else high = middle - 1
      }
      if (low) {
        entries.push(fragment(low)); offset += low
        if (offset === bytes.length) { index++; offset = 0 }
      }
      break
    }
    result.items = entries; result.nextCursor = page.continuation(index, offset, offset ? page.digest ?? (entries.at(-1)?.kind === 'fragment' ? (entries.at(-1) as Extract<typeof entries[number], { kind: 'fragment' }>).sha256 : undefined) : undefined)
    if (page.items.length && !entries.length || Buffer.byteLength(JSON.stringify(result)) > result.budgetBytes - 1024) throw new AgentMuxError('The mailbox continuation cannot fit this read budget. Increase maxBytes; the original input is retained.', 'AGENT_INPUT_READ_BUDGET')
    return result
  }

  /** Journal visibility cannot revoke an already accepted input or turn its side effect into failure. */
  private async recordAcceptedInput(key: AgentPromptInputKey, at: number): Promise<void> {
    try {
      await this.messageQueue.recordInputSubmission(key, at)
      this.publisher.publish({ type: 'agent-input-recorded', agentSessionId: key.agentSessionId })
    } catch (error) {
      this.publisher.publish({ type: 'agent-error', agentSessionId: key.agentSessionId, code: 'AGENT_INPUT_RECORDING_UNCONFIRMED', evidence: { source: 'agentmux', observedAt: Date.now(), run: { ...key.expectedRun } },
        message: `The original input claim is retained; mailbox recording is unconfirmed: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  /** Same original journal/key selector. Inspect never constructs a new waiting generation. */
  async inspectAgentInput(selector: AgentInputSelector, caller?: { agentSessionId: string; capability: string }): Promise<AgentInputSubmissionReceipt | null> {
    const saved = await this.messageQueue.inspectInput(selector)
    if (!saved) return null
    if (caller) {
      if (caller.agentSessionId === saved.intent.key.agentSessionId) await this.authorizeAgentCaller(caller.capability, caller.agentSessionId)
      else await this.assertInputWaitingAuthor(saved.intent, caller)
    }
    const admission = await this.inspectAgentPromptSubmission(saved.intent.key)
    const status = agentInputSubmissionStatus(saved.control, admission)
    const receipt: AgentInputSubmissionReceipt = { key: saved.intent.key, ref: saved.control.ref, control: saved.control,
      persistence: 'confirmed', status, admission, observation: saved.control.state !== 'enabled' || admission ? 'closed'
        : this.inputWaitingContexts.has(agentInputJournalKey(saved.intent.key)) ? 'owned' : 'rejoin-needed',
      ...(saved.intent.source.kind === 'message' ? { originalControlOperationId: saved.intent.source.originalControlOperationId } : {}) }
    return receipt
  }

  /** Materialize the original journal into the existing captured source, never another input owner. */
  private async syncInputConversation(agentSessionId: string, signal?: AbortSignal): Promise<import('./agent-input-conversation.js').AgentInputJournalCut> {
    const previous = this.inputConversationTails.get(agentSessionId)
    const work = (previous?.catch(() => {}) ?? Promise.resolve()).then(async () => {
      signal?.throwIfAborted()
      let position = await this.store.readInputConversationProjection(agentSessionId)
      if (!this.inputConversationRecovered.has(agentSessionId)) {
        for (;;) {
          for (const pending of position.pending) {
            signal?.throwIfAborted()
            const saved = await this.messageQueue.inspectInput({ key: pending.key })
            const original = (await this.store.readCapturedHistory(agentSessionId, { recordId: pending.recordId })).records[0]?.item
            if (!saved || !original?.inputOrigin) throw new AgentMuxError('An original pending input projection is unavailable.', 'AGENT_INPUT_READ_UNCONFIRMED')
            await this.writeInputConversation(saved, original.createdAt, original.inputOrigin)
          }
          if (!position.next) break
          position = await this.store.readInputConversationProjection(agentSessionId, position.next)
        }
        this.inputConversationRecovered.add(agentSessionId)
      }
      let cut = position.cut ?? undefined
      for (;;) {
        signal?.throwIfAborted()
        const page = await this.messageQueue.readConversationInputPage(agentSessionId, cut)
        for (const saved of page.items) {
          signal?.throwIfAborted()
          await this.writeInputConversation(saved, saved.recordedAt, { ...page.cut, sequence: saved.sequence })
        }
        if (page.cut.sequence > 0 && (!cut || !isDeepStrictEqual(cut, page.cut))) await this.store.recordInputConversationProjection(agentSessionId, page.cut)
        cut = page.cut
        if (!page.more) return cut
      }
    })
    this.inputConversationTails.set(agentSessionId, work)
    try { return await work }
    finally { if (this.inputConversationTails.get(agentSessionId) === work) this.inputConversationTails.delete(agentSessionId) }
  }

  private async writeInputConversation(saved: AgentInputJournalEntry, recordedAt: number, inputOrigin: import('./agent-input-conversation.js').AgentInputJournalCut): Promise<void> {
    await this.serializeInputConversationWrite(agentInputJournalKey(saved.intent.key), () => this.writeInputConversationRecord(saved, recordedAt, inputOrigin))
  }

  private async serializeInputConversationWrite<T>(id: string, execute: () => Promise<T>): Promise<T> {
    const previous = this.inputConversationWrites.get(id)
    const work = (previous?.catch(() => {}) ?? Promise.resolve()).then(execute)
    this.inputConversationWrites.set(id, work.then(() => {}, () => {}))
    const tail = this.inputConversationWrites.get(id)
    try { return await work }
    finally { if (this.inputConversationWrites.get(id) === tail) this.inputConversationWrites.delete(id) }
  }

  private async writeInputConversationRecord(saved: AgentInputJournalEntry, recordedAt: number, inputOrigin: import('./agent-input-conversation.js').AgentInputJournalCut): Promise<void> {
    const source = saved.intent.source, key = saved.intent.key
    let body: string, author: Pick<AgentTimelineItem, 'authorHuman' | 'authorExternal' | 'sourceChannel' | 'sourceDevice'>, recordId: string
    if (source.kind === 'prompt' && source.authorHuman === true && key.kind === 'prompt') {
      body = source.prompt; recordId = `prompt:${key.submissionId}`
      author = { authorHuman: true, ...(source.sourceChannel ? { sourceChannel: source.sourceChannel } : {}), ...(source.sourceDevice ? { sourceDevice: source.sourceDevice } : {}) }
    } else if (source.kind === 'message' && key.kind === 'message') {
      const message = await this.messageQueue.readByOperationId(source.originalControlOperationId)
      if (!message) throw new AgentMuxError('The original input message is unavailable.', 'AGENT_INPUT_READ_UNCONFIRMED')
      if (message.envelope.sender.kind !== 'external') return
      if (message.envelope.messageId !== key.messageId || message.envelope.recipientSessionId !== key.agentSessionId || message.envelope.recipientRunId !== key.expectedRun.runId)
        throw new AgentMuxError('The original external input journal does not match its message.', 'EXTERNAL_RECORD_CONFLICT')
      body = message.envelope.body; recordId = externalConversationRecordId(message.envelope.sender)
      author = { authorExternal: externalConversationAuthor(message.envelope.sender), ...(message.sourceChannel ? { sourceChannel: message.sourceChannel } : {}) }
    } else return
    const write = async () => {
      const receipt = await this.inspectAgentInput({ key })
      if (!receipt) throw new AgentMuxError('The original saved input observation is unavailable.', 'AGENT_INPUT_READ_UNCONFIRMED')
      const original = (await this.store.readCapturedHistory(key.agentSessionId, { recordId })).records[0]?.item
      if (original && (original.content !== body ||
        (author.authorExternal ? !original.authorExternal || !isDeepStrictEqual(externalConversationAuthor(original.authorExternal), author.authorExternal) : original.authorHuman !== true) ||
        (original.inputRef ? !isDeepStrictEqual(original.inputRef, key) : !author.authorExternal) ||
        original.inputOrigin && !isDeepStrictEqual(original.inputOrigin, inputOrigin))) throw new AgentMuxError(
        'The saved input conflicts with its original public conversation record.', 'AGENT_TIMELINE_ID_CONFLICT')
      const session = await this.historyDescriptor(key.agentSessionId), at = Math.max(Date.now(), original?.updatedAt ?? recordedAt)
      const item: AgentTimelineItem = { ...original, id: recordId, agentSessionId: key.agentSessionId, kind: 'user_message', source: 'user', status: 'recorded',
        createdAt: original?.createdAt ?? recordedAt, updatedAt: at, title: original?.title ?? (author.authorExternal ? 'External message' : 'User input'), content: body,
        publicContent: 'confirmed', ...author, inputRef: key, inputOrigin,
        inputSubmission: { status: receipt.status, observation: receipt.observation },
        ...(source.kind === 'prompt' && source.inputContext ? { inputContext: source.inputContext, inputContextSource: source.inputContextSource,
          ...(source.inputContextCaptureProof ? { inputContextCaptureProof: source.inputContextCaptureProof } : {}) } : {}) }
      if (original) {
        const { createdAt: _originalCreatedAt, updatedAt: _originalUpdatedAt, ...originalFacts } = original
        const { createdAt: _createdAt, updatedAt: _updatedAt, ...nextFacts } = item
        if (isDeepStrictEqual(originalFacts, nextFacts)) return
      }
      await this.persistAndPublishTimeline({ type: 'upsert', agentSessionId: key.agentSessionId, item },
        { source: 'user', observedAt: at, run: key.expectedRun }, session.hostId)
    }
    if (author.authorExternal) await this.serializeInputConversationWrite(JSON.stringify(['external-record', key.agentSessionId]), write)
    else await write()
  }

  private async publishInputReceipt(receipt: AgentInputSubmissionReceipt): Promise<void> {
    this.publisher.publish({ type: 'agent-input', receipt })
    try {
      const saved = await this.messageQueue.inspectInput({ key: receipt.key })
      if (saved && (saved.intent.source.kind === 'message' || saved.intent.source.authorHuman === true)) {
        // Current intake never waits for old membership projection. The reader
        // alone advances the recovery cursor after every preceding row is read.
        const cut = await this.messageQueue.readConversationInputCut(receipt.key.agentSessionId)
        await this.writeInputConversation(saved, saved.recordedAt, { ...cut, sequence: saved.sequence })
      }
    } catch (error) { this.publishInputConversationFailure(receipt.key, error) }
  }

  private publishInputConversationFailure(key: AgentPromptInputKey, error: unknown): void {
    const invalidate = () => this.inputConversationRecovered.delete(key.agentSessionId)
    invalidate()
    const recovering = this.inputConversationTails.get(key.agentSessionId)
    if (recovering) void recovering.then(invalidate, invalidate)
    this.publisher.publish({ type: 'agent-error', agentSessionId: key.agentSessionId, code: 'AGENT_INPUT_CONVERSATION_UNCONFIRMED',
      message: error instanceof Error ? error.message : String(error), failure: deliveryFailure(error),
      evidence: { source: 'agentmux', observedAt: Date.now(), run: key.expectedRun } })
  }

  private async assertInputWaitingAuthor(intent: AgentInputJournalIntent, caller?: { agentSessionId: string; capability: string }): Promise<void> {
    if (intent.source.kind === 'prompt') {
      if (caller) throw new AgentMuxError('An Agent cannot take ownership of a local prompt producer.', 'MESSAGE_SENDER_MISMATCH')
      return
    }
    const original = await this.messageQueue.readByOperationId(intent.source.originalControlOperationId)
    if (!original || original.envelope.messageId !== intent.source.messageId) throw new AgentMuxError('Original input author is unconfirmed.', 'AGENT_INPUT_NOT_FOUND')
    const sender = original.envelope.sender
    if (sender.kind === 'human') {
      if (caller) throw new AgentMuxError('An Agent cannot acquire the local original input author.', 'MESSAGE_SENDER_MISMATCH')
      return
    }
    if (sender.kind === 'external') {
      if (caller) throw new AgentMuxError('An Agent cannot acquire an external input author.', 'MESSAGE_SENDER_MISMATCH')
      return
    }
    if (!caller) throw new AgentMuxError('The original Agent author needs its current capability.', 'AGENT_CAPABILITY_INVALID')
    const authorized = await this.authorizeAgentCaller(caller.capability, caller.agentSessionId)
    if (authorized.agentSessionId !== sender.agentSessionId || original.envelope.senderSessionId !== authorized.agentSessionId) {
      throw new AgentMuxError('Input control belongs to its original Agent author.', 'MESSAGE_SENDER_MISMATCH')
    }
    // Reading/stopping the immutable original input does not address today's
    // recipient Run. Rejoining still verifies the original envelope/Run before
    // creating an observer, and dispatch retains its fresh author CAS.
  }

  async stopAgentInputWaiting(input: { ref: AgentInputWaitRef; cancelOperationId: string; caller?: { agentSessionId: string; capability: string } }): Promise<AgentInputWaitStopReceipt> {
    const ref = validateAgentInputWaitRef(input.ref), saved = await this.messageQueue.inspectInput({ key: ref.key })
    if (!saved) throw new AgentMuxError('The original input has no controlled waiting contract.', 'AGENT_INPUT_NOT_FOUND')
    // A trusted local SDK/Host may stop observation without impersonating its
    // Agent author. Managed callers still prove the original author capability.
    if (input.caller) await this.assertInputWaitingAuthor(saved.intent, input.caller)
    const admission = await this.inspectAgentPromptSubmission(ref.key)
    const status = agentInputSubmissionStatus(saved.control, admission)
    const settled = status === 'admitted' || status === 'terminal-confirmed' || status === 'not-applied'
    const receipt = await this.messageQueue.stopInputWaiting(ref, input.cancelOperationId, Boolean(settled), admission !== null)
    const waiting = this.inputWaitingContexts.get(agentInputJournalKey(ref.key))
    if (waiting && isDeepStrictEqual(waiting.ref, ref) && receipt.outcome !== 'stale-generation') {
      waiting.controller.abort()
      this.inputWaitingContexts.delete(agentInputJournalKey(ref.key))
    }
    const projection = await this.inspectAgentInput({ key: ref.key })
    if (projection) await this.publishInputReceipt(projection)
    return receipt
  }

  async rejoinAgentInputWaiting(input: { ref: AgentInputWaitRef; caller?: { agentSessionId: string; capability: string } }, context?: AgentInputCallContext): Promise<AgentInputSubmissionReceipt> {
    context?.requestSignal?.throwIfAborted()
    const ref = validateAgentInputWaitRef(input.ref), saved = await this.messageQueue.inspectInput({ key: ref.key })
    if (!saved) throw new AgentMuxError('The original input has no controlled waiting contract.', 'AGENT_INPUT_NOT_FOUND')
    await this.assertInputWaitingAuthor(saved.intent, input.caller)
    const prior = await this.inspectAgentPromptSubmission(ref.key)
    if (prior || saved.control.state === 'dispatch-authorized') return (await this.inspectAgentInput({ key: ref.key }))!
    const prompt = await this.inputWaitingPrompt(saved.intent, input.caller, context)
    const active = this.inputWaitingContexts.get(agentInputJournalKey(ref.key))
    if (active?.active && isDeepStrictEqual(active.ref, ref)) return (await this.inspectAgentInput({ key: ref.key }))!
    const next = await this.messageQueue.reenableInputWaiting(ref)
    const previous = this.inputWaitingContexts.get(agentInputJournalKey(ref.key))
    if (previous) { previous.controller.abort(); this.inputWaitingContexts.delete(agentInputJournalKey(ref.key)) }
    return await this.acceptInputWaiting(next, prompt.input, saved.intent.key.kind,
      prompt.authorAgentSessionId, this.inputCallAuthority(prompt.authority, context), context?.requestSignal)
  }

  private async inputWaitingPrompt(intent: AgentInputJournalIntent, caller?: { agentSessionId: string; capability: string }, context?: AgentInputCallContext): Promise<{
    input: AgentMuxAgentPromptInput; authorAgentSessionId?: string; authority?: import('./prompt-submission.js').AgentPromptInputAuthority
  }> {
    const source = intent.source
    if (source.kind === 'prompt') {
      const { kind: _producer, promptWire: _wire, inputContextSource, inputContextCaptureProof, ...content } = source
      return { input: { ...content, agentSessionId: intent.key.agentSessionId, expectedRun: intent.key.expectedRun,
        operationId: agentPromptInputId(intent.key), admissionIntent: (() => { const { expectedRun: _run, ...target } = intent.admissionIntent; return target })(), execution: 'immediate' },
        ...(inputContextSource ? { authority: { inputContextSource, ...(inputContextCaptureProof ? { inputContextCaptureProof } : {}), assertCurrent: async () => {} } } : {}) }
    }
    const original = await this.messageQueue.readByOperationId(source.originalControlOperationId)
    if (!original) throw new AgentMuxError('Original message input is unknown.', 'AGENT_INPUT_NOT_FOUND')
    const envelope = original.envelope
    let authority: import('./prompt-submission.js').AgentPromptInputAuthority | undefined
    if (envelope.sender.kind === 'agent-session') {
      if (!caller) throw new AgentMuxError('The original Agent author needs its current capability.', 'AGENT_CAPABILITY_INVALID')
      const author = { capability: caller.capability, callerAgentSessionId: caller.agentSessionId, senderAgentSessionId: envelope.sender.agentSessionId,
        senderSessionId: envelope.senderSessionId, senderRunId: envelope.senderRunId, recipientSessionId: envelope.recipientSessionId, recipientRunId: envelope.recipientRunId }
      authority = await this.messageInputAuthority(author)
    }
    if (envelope.sender.kind === 'external') authority = await this.externalMessageAuthority(envelope, context, intent.admissionIntent)
    return { input: { agentSessionId: intent.key.agentSessionId, expectedRun: intent.key.expectedRun, operationId: agentPromptInputId(intent.key),
      prompt: envelope.channelQuote ? source.promptWire! : renderAgentMuxMessageEnvelope(envelope), admissionIntent: (() => { const { expectedRun: _run, ...target } = intent.admissionIntent; return target })(), execution: 'immediate',
      ...(original.sourceChannel ? { sourceChannel: original.sourceChannel } : {}), ...(original.sourceDevice ? { sourceDevice: original.sourceDevice } : {}) },
      ...(envelope.sender.kind === 'agent-session' ? { authorAgentSessionId: envelope.sender.agentSessionId } : {}), ...(authority ? { authority } : {}) }
  }

  /** Only an executing Host's current author owner can admit external input. Persisted attribution is not a grant. */
  private async externalMessageAuthority(envelope: AgentMuxMessageEnvelope, context?: AgentInputCallContext, admissionIntent?: AgentPromptAdmissionIntent): Promise<import('./prompt-submission.js').AgentPromptInputAuthority> {
    const host = context?.externalAuthor, sender = envelope.sender
    if (sender.kind !== 'external' || !envelope.recipientSessionId || !envelope.recipientRunId || !host || typeof host.assertCurrent !== 'function' || !isDeepStrictEqual(parseAgentExternalMessageAuthor(host.identity), sender)) throw new AgentMuxError('External input requires its exact current Host author owner.', 'EXTERNAL_AUTHOR_REQUIRED')
    const identity = structuredClone(sender), check = host.assertCurrent.bind(host)
    const intent = { agentSessionId: envelope.recipientSessionId!, expectedRun: { runId: envelope.recipientRunId! }, operationId: envelope.operationId, messageId: envelope.messageId, body: envelope.body, ...(envelope.channelQuote === undefined ? {} : { channelQuote: structuredClone(envelope.channelQuote) }), ...(admissionIntent === undefined ? {} : { admissionIntent: structuredClone(admissionIntent) }) }
    const assertCurrent = async () => { await check(structuredClone(intent)) }
    await assertCurrent()
    return { externalAuthor: identity, assertCurrent }
  }

  private inputCallAuthority(authority?: import('./prompt-submission.js').AgentPromptInputAuthority,
    context?: AgentInputCallContext): import('./prompt-submission.js').AgentPromptInputAuthority | undefined {
    const assertCurrent = context?.assertCurrent
    const inputContextSource = authority?.inputContextSource ?? (context?.inputContextSource === undefined ? undefined : parseBrowserInputContextSource(context.inputContextSource))
    if (!assertCurrent && inputContextSource === undefined) return authority
    return { ...authority, assertCurrent: async () => {
      await authority?.assertCurrent()
      await assertCurrent?.()
    }, ...(inputContextSource === undefined ? {} : { inputContextSource }) }
  }

  private async acceptInputWaiting(ref: AgentInputWaitRef, input: AgentMuxAgentPromptInput, producer: 'prompt' | 'message',
    authorAgentSessionId?: string, authority?: import('./prompt-submission.js').AgentPromptInputAuthority,
    requestSignal?: AbortSignal): Promise<AgentInputSubmissionReceipt> {
    let releaseRequest = () => {}
    try {
      const saved = await this.messageQueue.inspectInput({ key: ref.key })
      if (!saved) throw new AgentMuxError('Original input persistence is unconfirmed.', 'AGENT_INPUT_NOT_FOUND')
      if (saved.control.state === 'enabled' && !await this.inspectAgentPromptSubmission(ref.key) && !this.inputWaitingDisposed) {
        const id = agentInputJournalKey(ref.key)
        if (!this.inputWaitingContexts.has(id)) {
          const controller = new AbortController(), context = { ref: saved.control.ref, input, producer,
            controller, runtimeWake: true, requested: true, active: false, sequence: saved.sequence,
            ...(authorAgentSessionId ? { authorAgentSessionId } : {}), ...(authority ? { authority } : {}) }
          this.inputWaitingContexts.set(id, context)
          controller.signal.addEventListener('abort', () => {
            if (this.inputWaitingContexts.get(id) === context) this.inputWaitingContexts.delete(id)
          }, { once: true })
          if (input.signal?.aborted) controller.abort(input.signal.reason)
          else input.signal?.addEventListener('abort', () => controller.abort(input.signal!.reason), { once: true, signal: controller.signal })
          const cancelRequest = () => controller.abort(requestSignal!.reason)
          if (requestSignal?.aborted) cancelRequest()
          else if (requestSignal) {
            requestSignal.addEventListener('abort', cancelRequest, { once: true })
            releaseRequest = () => requestSignal.removeEventListener('abort', cancelRequest)
          }
        }
        // The durable firstsave ACK does not wait for Native qualification or a
        // prior input's network reply. The original Core owner continues observing.
        void this.scheduleInputWaiting(ref.key.agentSessionId)
      }
      const receipt = (await this.inspectAgentInput({ key: ref.key }))!
      await this.publishInputReceipt(receipt)
      return receipt
    } finally {
      // The original Core owns any accepted waiting context after this receipt.
      // Releasing a normal unary reply reader cannot cancel that owner.
      releaseRequest()
    }
  }

  private scheduleInputWaiting(recipient: string): Promise<void> {
    const running = this.inputWaitingRecipients.get(recipient)
    if (running) { running.again = true; return running.pending }
    const state = { again: false, pending: Promise.resolve() }
    state.pending = Promise.resolve().then(async () => {
      do {
        state.again = false
        const relevant = [...this.inputWaitingContexts.values()].filter(value => value.ref.key.agentSessionId === recipient && value.requested)
          .sort((a, b) => a.sequence - b.sequence)
        for (const context of relevant) {
          context.requested = false
          if (!context.controller.signal.aborted) {
            context.active = true
            try { await this.advanceInputWaiting(context) } finally { context.active = false }
          }
        }
      } while (state.again && !this.inputWaitingDisposed)
    }).catch(error => {
      this.publisher.publish({ type: 'agent-error', agentSessionId: recipient, code: 'AGENT_INPUT_WAIT_OBSERVATION_UNCONFIRMED',
        message: error instanceof Error ? error.message : String(error), failure: deliveryFailure(error), evidence: { source: 'agentmux', observedAt: Date.now() } })
    }).finally(() => { if (this.inputWaitingRecipients.get(recipient) === state) this.inputWaitingRecipients.delete(recipient) })
    this.inputWaitingRecipients.set(recipient, state)
    return state.pending
  }

  private async advanceInputWaiting(context: {
    ref: AgentInputWaitRef; input: AgentMuxAgentPromptInput; producer: 'prompt' | 'message'; authorAgentSessionId?: string;
    authority?: import('./prompt-submission.js').AgentPromptInputAuthority; controller: AbortController; runtimeWake: boolean; requested: boolean
  }): Promise<void> {
    const key = context.ref.key, saved = await this.messageQueue.inspectInput({ key })
    if (!saved || !isDeepStrictEqual(saved.control.ref, context.ref) || saved.control.state !== 'enabled' ||
        await this.inspectAgentPromptSubmission(key)) return
    const waiting = async (reason: import('./agent-input-wait.js').AgentInputWaitReason) => {
      context.runtimeWake = reason.wake === 'runtime-restored'
      if (!context.runtimeWake) context.requested = false
      const recorded = await this.messageQueue.recordInputWaiting(context.ref, reason)
      const failure = reason.phase === 'native-environment' ? reason.observation?.failure : reason.failure
      if (!recorded && failure) this.publisher.publish({ type: 'agent-error', agentSessionId: key.agentSessionId,
        code: 'AGENT_INPUT_WAIT_OBSERVATION_UNCONFIRMED', message: failure.message, failure,
        evidence: { source: 'agentmux', observedAt: Date.now(), run: key.expectedRun } })
      // No event can advance this observation. Keep the durable waiting ref,
      // and release its credentials until an explicitly authorized rejoin.
      if (!context.runtimeWake) release()
    }
    const release = () => {
      if (this.inputWaitingContexts.get(agentInputJournalKey(key)) === context) this.inputWaitingContexts.delete(agentInputJournalKey(key))
      context.controller.abort()
    }
    if (!this.connected || !this.kernel.isConnected()) {
      await waiting({ phase: 'runtime', reason: 'runtime-unavailable', wake: 'runtime-restored' })
    } else {
      let targetChanged = false
      let dispatchDeclined = false
      let authorizationFailed = false
      let dispatchAuthorized = false
      const authority = context.authority && { ...context.authority, assertCurrent: async () => {
        try {
          // This is a restrict-only read, not a grant or a side effect. Once the
          // original waiting generation stops, abandon its observer even when
          // a foreign authority reader does not settle. Its late result cannot
          // revive the old gate or authorize the next input.
          if (dispatchAuthorized) await context.authority!.assertCurrent()
          else await observePromptInput(context.controller.signal, () => context.authority!.assertCurrent())
        } catch (error) { authorizationFailed = true; throw error }
      } }
      let preparationPhase: 'current-run' | 'input-coordination' = 'current-run'
      try {
        const assertTarget = (value: AgentMuxAgentSession) => {
          const expected = saved.intent.environment, observed = this.inputSavedEnvironment(value)
          // The accepted target is this original current terminal, not a
          // separately discovered Native connection or its observation epoch.
          targetChanged = !sameRun(value.run, key.expectedRun) || expected.providerId !== observed.providerId || expected.executorId !== observed.executorId
          if (targetChanged) throw new AgentMuxError('The original Session, Run or executor changed before input.', 'AGENT_PROMPT_SOURCE_CHANGED')
        }
        assertTarget(await this.currentStoredAgentSession(key.agentSessionId))
        const current = await this.registry.refresh(key.agentSessionId, key.expectedRun)
        assertTarget(current)
        try { await authority?.assertCurrent() } catch (error) {
          if (context.controller.signal.aborted) throw error
          await waiting({ phase: 'authorization', reason: 'author-authorization-needed', wake: 'explicit-rejoin', failure: deliveryFailure(error) })
          const receipt = await this.inspectAgentInput({ key })
          if (receipt) await this.publishInputReceipt(receipt)
          return
        }
        preparationPhase = 'input-coordination'
        await this.submitPromptInternal({ ...context.input, signal: context.controller.signal }, context.authorAgentSessionId, assertTarget, undefined, authority, context.producer,
          { authorizeDispatch: async () => {
            const link = await this.messageQueue.authorizeInputDispatch(context.ref, context.controller.signal)
            dispatchDeclined = link === null
            dispatchAuthorized = link !== null
            return link
          } })
        if (key.kind === 'message') await this.messageQueue.recordDelivery(key.messageId, 'delivered')
        release()
      } catch (error) {
        const admission = await this.inspectAgentPromptSubmission(key), controlled = await this.messageQueue.inspectInput({ key })
        if (admission || controlled?.control.state !== 'enabled') {
          release()
          // The original stop/gate/Native outcome remains unchanged. An
          // additional preparation/cleanup failure is still observable; only
          // this exact caller's expected abort reason is already accounted for.
          if (!dispatchDeclined && (!context.controller.signal.aborted || error !== context.controller.signal.reason)) this.publisher.publish({
            type: 'agent-error', agentSessionId: key.agentSessionId, code: 'AGENT_INPUT_WAIT_OBSERVATION_UNCONFIRMED',
            message: error instanceof Error ? error.message : String(error), failure: deliveryFailure(error),
            evidence: { source: 'agentmux', observedAt: Date.now(), run: key.expectedRun } })
        }
        else await waiting(context.controller.signal.aborted
          ? { phase: 'observer', reason: 'observer-stopped', wake: 'explicit-rejoin', failure: deliveryFailure(error), observation: { phase: preparationPhase } }
          : authorizationFailed
          ? { phase: 'authorization', reason: 'author-authorization-needed', wake: 'explicit-rejoin', failure: deliveryFailure(error) }
          : !this.connected || !this.kernel.isConnected()
          ? { phase: 'runtime', reason: 'runtime-unavailable', wake: 'runtime-restored', failure: deliveryFailure(error) }
          : error instanceof AgentMuxError ? { phase: 'input-environment', reason: targetChanged ? 'original-target-changed' : 'original-input-unconfirmed', wake: 'explicit-rejoin',
            failure: deliveryFailure(error), observation: { phase: preparationPhase } }
          : { phase: 'service', reason: 'observation-failed', wake: 'explicit-rejoin', failure: deliveryFailure(error), observation: { phase: preparationPhase } })
      }
    }
    const receipt = await this.inspectAgentInput({ key })
    if (receipt) await this.publishInputReceipt(receipt)
  }

  /** Read the original failed invocation, including while its Agent or Runtime is unavailable. */
  async readDeliveryAttempt(logId: string): Promise<DeliveryAttemptLookup> {
    return await this.deliveryAttempts.read(logId)
  }

  /** Save an exact future message through the same durable Session owner as Input. */
  async saveAgentFuturePromptIntent(input: { agentSessionId: string; intentId: string; operationId: string; prompt: string; agentMuxNote?: string; active: boolean;
    caller?: { agentSessionId: string; capability: string }; sourceDevice?: import('./types.js').AgentOperationDevice }): Promise<void> {
    this.requireConnected()
    if ('authorHuman' in input || 'authorAgentSessionId' in input) throw new AgentMuxError('Future-message authors come from the original authenticated owner.', 'MESSAGE_SENDER_MISMATCH')
    const intentId = safeId(input.intentId, 'Future message intent id')
    const operationId = safeId(input.operationId, 'Future message operation id')
    if (typeof input.active !== 'boolean' || typeof input.prompt !== 'string' ||
      input.agentMuxNote !== undefined && typeof input.agentMuxNote !== 'string') throw new AgentMuxError('A future message needs exact content and an explicit active state.', 'INVALID_AGENT_PROMPT')
    const composed = composeAgentPrompt(input.prompt, input.agentMuxNote)
    if (!composed.text.trim()) throw new AgentMuxError('A future message needs nonempty original content or AgentMux context.', 'INVALID_AGENT_PROMPT')
    assertAgentPromptSize(composed.text)
    const session = this.requireAgentSession(input.agentSessionId)
    await this.store.withPromptSubmission(session.agentSessionId, async () => {
      let authorAgentSessionId: string | undefined
      if (input.caller) {
        const sender = await this.authorizeAgentCaller(input.caller.capability, input.caller.agentSessionId)
        await this.authorizeAgentMessage({ capability: input.caller.capability, callerAgentSessionId: sender.agentSessionId,
          senderAgentSessionId: sender.agentSessionId, senderSessionId: sender.agentSessionId, senderRunId: sender.run.runId,
          recipientSessionId: session.agentSessionId, recipientRunId: session.run.runId })
        authorAgentSessionId = sender.agentSessionId
      }
      await this.updateExactAgentSession(session.agentSessionId, session.run, current => {
      const intents = { ...current.futurePromptIntents }, previous = intents[intentId]
      if (previous && (previous.operationId !== operationId || previous.prompt !== composed.text)) throw new AgentMuxError('Future intent identity was reused with different content.', 'AGENT_PROMPT_OPERATION_CONFLICT')
      intents[intentId] = { ...previous, operationId, prompt: composed.text, active: input.active,
        message: previous?.message ?? { ...(input.prompt.trim() ? { userContent: input.prompt } : {}), ...(composed.systemContext ? { systemContext: composed.systemContext } : {}),
          ...(authorAgentSessionId ? { authorAgentSessionId } : {}), ...(input.sourceDevice ? { sourceDevice: structuredClone(input.sourceDevice) } : {}) } }
      return { ...current, futurePromptIntents: intents, updatedAt: Date.now() }
      }, intentId)
    })
  }

  /** Route an exact historical question reply without guessing the live terminal's active editor. */
  async replySessionQuestion(input: AgentMuxSessionQuestionReplyInput, context?: AgentInputCallContext): Promise<AgentSessionQuestionReplyReceipt> {
    const condition = validateAgentPromptCondition(input)
    input = { ...input, ...condition, source: { ...input.source },
      answers: Array.isArray(input.answers) ? input.answers.map(answer => ({ ...answer })) : input.answers }
    let authority: import('./prompt-submission.js').AgentPromptInputAuthority | undefined
    if (input.externalAction !== undefined) {
      const identity = parseAgentExternalInteractionAuthor(input.externalAction), owner = context?.externalQuestion
      if (!owner || input.authorHuman !== undefined || !isDeepStrictEqual(identity, owner.identity)) throw new AgentMuxError(
        'The original external question authority is unavailable. Retain its action; local answers remain available.', 'EXTERNAL_INTERACTION_AUTHORITY_UNCONFIRMED')
      input = { ...input, externalAction: identity }
      const frozen = structuredClone(input)
      authority = { assertCurrent: async () => { await context?.assertCurrent?.(); await owner.assertCurrent(structuredClone(frozen)) } }
      await authority.assertCurrent()
    }
    safeId(input.operationId, 'Question reply operation id')
    input.signal?.throwIfAborted()
    const session = await this.registry.resolveMetadata(input.agentSessionId, 'local', () => input.signal?.throwIfAborted())
    if (!sameRun(session.run, condition.expectedRun)) throw new AgentMuxError(
      'Agent Session changed before its question was answered.', 'STALE_AGENT_SESSION')
    if (!input.source || input.source.providerId !== session.providerId ||
      typeof input.source.nativeSessionId !== 'string' || !input.source.nativeSessionId ||
      typeof input.turnId !== 'string' || !input.turnId || typeof input.recordId !== 'string' || !input.recordId ||
      !Array.isArray(input.answers) || !input.answers.length || input.answers.some(answer =>
        !answer || typeof answer.questionId !== 'string' || !answer.questionId || typeof answer.answer !== 'string' || !answer.answer.trim())) {
      throw new AgentMuxError('A question reply requires an exact source, record and answers.', 'INVALID_AGENT_QUESTION_REPLY')
    }
    if (session.nativeHandle?.kind === 'provider' && session.nativeHandle.sessionId !== input.source.nativeSessionId) {
      throw new AgentMuxError('The question belongs to another native source.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    }
    const provider = this.providers.get(session.providerId)
    if (provider.catalog.capabilities.asyncQuestionReply !== 'native-input' || !provider.planQuestionReply) throw new AgentMuxError(
      'This Provider does not expose direct asynchronous question replies. The original question, answer and terminal remain available.',
      'AGENT_QUESTION_REPLY_UNSUPPORTED')
    const record = await this.readConversationNativeRecord(session.agentSessionId, input.source, input.recordId, input.signal, input)
    const prompt = provider.planQuestionReply(record, input.answers)
    const assertSource = (current: AgentMuxAgentSession): void => {
      const handle = current.nativeHandle
      if (handle?.kind !== 'provider' || handle.providerId !== input.source.providerId || handle.sessionId !== input.source.nativeSessionId) throw new AgentMuxError(
        'The question belongs to another original native source. No reply was sent; the original work remains available.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    }
    assertSource(session)
    await this.submitPromptInternal({ ...condition, agentSessionId: session.agentSessionId, operationId: input.operationId,
      prompt, execution: 'default', ...(input.authorHuman === undefined ? {} : { authorHuman: input.authorHuman }),
      ...(input.sourceDevice ? { sourceDevice: input.sourceDevice } : {}), sourceChannel: input.sourceChannel ?? 'question-reply',
      ...(input.signal ? { signal: input.signal } : {}) }, undefined, assertSource, undefined, authority, 'prompt', undefined, { source: input.source, turnId: input.turnId, recordId: input.recordId, questionIds: input.answers.map(answer => answer.questionId), ...(input.externalAction ? { externalAction: input.externalAction } : {}) })
    return { agentSessionId: session.agentSessionId, source: { ...input.source }, recordId: input.recordId,
      questionIds: input.answers.map(answer => answer.questionId), operationId: input.operationId, outcome: 'submitted' }
  }

  private async submitPromptInternal(input: AgentMuxAgentPromptInput, authorAgentSessionId?: string,
    assertSession?: (session: AgentMuxAgentSession) => void, assertInput?: () => void,
    authority?: import('./prompt-submission.js').AgentPromptInputAuthority, producer: 'prompt' | 'message' = 'prompt',
    inputControl?: Pick<import('./prompt-submission.js').AgentPromptInputControl, 'authorizeDispatch' | 'nativeIdleOnly'>,
    questionReply?: AgentPromptMessageContent['questionReply'], platformNotification?: AgentMuxMessageNotification): Promise<void> {
    const startedAt = Date.now()
    const id = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value) ? value : null
    let sourceDevice: import('./types.js').AgentOperationDevice | undefined
    try { if (input?.sourceDevice !== undefined) sourceDevice = normalizeOperationDevice(input.sourceDevice) } catch { /* Invalid provenance remains unavailable in this diagnostic. */ }
    const captured = {
      agentSessionId: id(input?.agentSessionId), operationId: id(input?.operationId), expectedRunId: id(input?.expectedRun?.runId),
      afterSubmissionId: id(input?.afterSubmissionId), conditionAvailable: id(input?.expectedRun?.runId) !== null &&
        (input?.afterSubmissionId === null || id(input?.afterSubmissionId) !== null),
      promptDigest: typeof input?.prompt === 'string' ? createHash('sha256').update(input.prompt).digest('hex') : null,
      execution: input?.execution === undefined ? 'default' as const : input.execution === 'default' || input.execution === 'immediate' ? input.execution : null,
      ...(sourceDevice ? { sourceDevice } : {})
    }
    let stage = 'validation'
    try {
      assertInput?.()
      await this.performPromptSubmission(input, authorAgentSessionId, assertSession, value => { stage = value }, authority, producer, inputControl, questionReply, platformNotification)
    } catch (error) {
      // All observations below come from this invocation's failure boundary. Missing
      // projections stay missing; they do not authorize replay of the logical message.
      const { operationId, agentSessionId } = captured
      let session: AgentMuxAgentSession | undefined
      try { if (agentSessionId) session = this.registry.get(agentSessionId) } catch { /* Exact projection unavailable. */ }
      const phase = (value: import('./types.js').AgentTerminalInputPhaseState | undefined): DeliveryInputPhase | null =>
        value ? { operationId: value.operationId, startByte: value.inputByteRange.startByte,
          endByte: value.inputByteRange.endByte, acknowledged: value.acknowledged, notApplied: value.notApplied === true } : null
      const admission = session?.promptCompletionAdmission, submission = session?.terminalPromptSubmission
      const matching = operationId !== null && submission?.submissionId === operationId ? submission : undefined
      const record: DeliveryAttempt = {
        ...captured, logId: newDeliveryLogId(), source: 'core', hostId: session?.hostId ?? null,
        startedAt, failedAt: Date.now(), stage, error: deliveryFailure(error),
        ...(session ? { observation: { source: 'core-session-projection' as const, observedAt: Date.now(), runId: session.run.runId,
          submissionId: admission?.submissionId ?? null,
          admissionAcknowledged: admission?.submissionId === operationId ? admission.acknowledged ?? null : null,
          payload: phase(matching?.payload), submit: phase(matching?.submit) } } : {})
      }
      let issue: string | null = null
      try { issue = (await this.deliveryAttempts.record(record)).issue }
      catch (diagnosticError) { issue = `Delivery diagnostic could not be retained: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}` }
      const original = error && typeof error === 'object' ? error as { code?: unknown; detail?: unknown } : null
      const failure = deliveryFailure(error)
      const message = error instanceof Error ? error.message : String(error)
      const reported = new AgentMuxError(issue ? `${message} ${issue}` : message,
        typeof original?.code === 'string' ? original.code : (error instanceof Error ? error.name : 'AGENT_PROMPT_FAILED'),
        typeof original?.detail === 'string' ? original.detail : undefined, failure.controlFailure, record.logId)
      Object.defineProperty(reported, 'cause', { value: error, configurable: true })
      throw reported
    }
  }

  private async performPromptSubmission(input: AgentMuxAgentPromptInput, authorAgentSessionId?: string,
    assertSession?: (session: AgentMuxAgentSession) => void, stage: (value: string) => void = () => {},
    authority?: import('./prompt-submission.js').AgentPromptInputAuthority, producer: 'prompt' | 'message' = 'prompt',
    inputControl?: Pick<import('./prompt-submission.js').AgentPromptInputControl, 'authorizeDispatch' | 'nativeIdleOnly'>,
    questionReply?: AgentPromptMessageContent['questionReply'], platformNotification?: AgentMuxMessageNotification): Promise<void> {
    stage('connection')
    this.requireConnected()
    stage('validation')
    if (input.execution !== undefined && input.execution !== 'default' && input.execution !== 'immediate') {
      throw new AgentMuxError('Prompt execution intent is invalid.', 'INVALID_AGENT_PROMPT')
    }
    if (input.admissionIntent !== undefined && (Object.hasOwn(input, 'afterSubmissionId') ||
        input.execution !== 'immediate' || input.expectedCompletionId !== undefined || input.expectedFutureIntent !== undefined ||
        input.expectedInputByte !== undefined || input.preparationRetry !== undefined)) {
      throw new AgentMuxError('Manual actor input cannot replace an exact condition or automatic/request intent.', 'INVALID_AGENT_PROMPT')
    }
    if (input.execution === 'immediate' && (input.expectedCompletionId !== undefined || input.expectedFutureIntent !== undefined)) {
      throw new AgentMuxError('Automatic admission cannot authorize immediate manual input.', 'INVALID_AGENT_PROMPT')
    }
    if (input.preparationRetry && (typeof input.preparationRetry !== 'object' || Array.isArray(input.preparationRetry) ||
        Object.keys(input.preparationRetry).some(key => key !== 'inputByte' && key !== 'nativeSourceId') ||
        input.execution !== 'immediate' || !Number.isSafeInteger(input.preparationRetry.inputByte) ||
        input.preparationRetry.inputByte < 0 || typeof input.preparationRetry.nativeSourceId !== 'string' || !input.preparationRetry.nativeSourceId || input.preparationRetry.nativeSourceId.length > 4096)) {
      throw new AgentMuxError('Preparation retry requires the original finite input and native-source fence.', 'INVALID_AGENT_PROMPT')
    }
    const content = input.prompt
    if (input.expectedFutureIntent !== undefined && (input.expectedCompletionId !== undefined || input.authorHuman === true || input.allowUncertainTurn ||
        !input.expectedFutureIntent.intentId || !Number.isSafeInteger(input.expectedFutureIntent.occurrenceAt) || input.expectedFutureIntent.occurrenceAt < 0 || input.expectedInputByte === undefined)) {
      throw new AgentMuxError('A saved future message requires its exact occurrence and input fence.', 'INVALID_AGENT_PROMPT')
    }
    if (input.expectedInputByte !== undefined && ((input.expectedCompletionId === undefined && input.expectedFutureIntent === undefined &&
        !(platformNotification?.mode === 'idle' && platformNotification.idle?.nativeEvidence)) ||
        !Number.isSafeInteger(input.expectedInputByte) || input.expectedInputByte < 0)) {
      throw new AgentMuxError('Automatic prompt admission requires its completion and finite input fence together.', 'INVALID_AGENT_PROMPT')
    }
    if (!content.trim() && !input.agentMuxNote?.trim()) throw new AgentMuxError('Agent prompt cannot be empty.', 'INVALID_AGENT_PROMPT')
    // Producer facts come from explicit input, never by parsing the user's string.
    const inputContext = input.inputContext === undefined ? undefined : parseBrowserInputContext(input.inputContext)
    if (platformNotification && (platformNotification.key.submissionId !== input.operationId || platformNotification.key.agentSessionId !== input.agentSessionId ||
        !isDeepStrictEqual(platformNotification.key.expectedRun, input.expectedRun) || input.authorHuman !== undefined || authorAgentSessionId !== undefined ||
        input.agentMuxNote !== undefined || inputContext !== undefined || !isDeepStrictEqual(await this.messageQueue.readNotification(input.operationId), platformNotification))) throw new AgentMuxError(
      'The original platform notification input is not confirmed.', 'INVALID_A2A_NOTIFICATION')
    const composed = platformNotification ? { text: platformNotification.wire, systemContext: platformNotification.wire } : composeAgentPrompt(content, input.agentMuxNote, inputContext)
    // A message's authored envelope was already checked against the immutable
    // journal. Resume its original Input recipe; a newer formatter or reminder
    // cannot change bytes or producer facts after a possibly applied claim.
    const frozen = producer === 'message' || input.agentMuxNote || inputContext || platformNotification ? (await this.inspectAgentPromptSubmission({
      agentSessionId: input.agentSessionId, expectedRun: input.expectedRun,
      ...(producer === 'message' ? { kind: 'message', messageId: input.operationId } : { kind: 'prompt', submissionId: input.operationId })
    }))?.admission?.intent : undefined
    const waiting = producer === 'prompt' && input.admissionIntent !== undefined ? await this.messageQueue.inspectInput({ key: {
      kind: 'prompt', agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, submissionId: input.operationId } }) : undefined
    const waitingSource = waiting?.intent.source.kind === 'prompt' ? waiting.intent.source : undefined
    const captureProof = waitingSource?.inputContextCaptureProof ?? authority?.inputContextCaptureProof
    const authored: AgentPromptMessageContent = platformNotification ? { systemContext: platformNotification.wire, a2aNotificationId: platformNotification.notificationId } : {
      ...(inputContext ? { inputContext, inputContextSource: waitingSource?.inputContextSource ?? authority?.inputContextSource ?? 'caller-declared',
        ...(captureProof ? { inputContextCaptureProof: captureProof } : {}) } : {}),
      ...(questionReply ? { questionReply: structuredClone(questionReply) } : {}),
      ...(content.trim() ? { userContent: content } : {}),
      ...(composed.systemContext ? { systemContext: composed.systemContext } : {}),
      ...(authorAgentSessionId ? { authorAgentSessionId } : authority?.externalAuthor ? { authorExternal: structuredClone(authority.externalAuthor) } : input.authorHuman === true ? { authorHuman: true } : {}),
      ...(input.sourceDevice ? { sourceDevice: normalizeOperationDevice(input.sourceDevice) } : {}),
      sourceChannel: normalizeMessageChannel(input.sourceChannel ?? 'api')
    }
    // Ordinary prompt retries must still submit the same explicit body, note
    // and provenance. A text envelope never supplies those producer facts.
    const retainWire = frozen && (producer === 'message' || isDeepStrictEqual(frozen.message, authored))
    const outbound = retainWire ? frozen.prompt : waitingSource?.promptWire ?? composed.text
    const message = producer === 'message' && frozen?.message ? frozen.message : authored
    assertAgentPromptSize(outbound)
    const operationId = safeId(input.operationId, 'Agent prompt operation id')
    // 握手绝不做发 prompt 的前置门。这里不是生命周期路径——run 早就活着，用户此刻正在提交。
    // 而 `[?u` 是 codex 一次性的启动输出，对一个几分钟前启动的 run 早已不可达，于是一旦拦在
    // 这里，**那个 run 之后的每一条 prompt 都被永久挡住**。栅栏起点由 daemon 的权威
    // acceptedInputBytes 兜底（submitInputPlan 本来就这么取），不依赖握手是否完成。
    const session = this.requireAgentSession(input.agentSessionId)
    const admissionIntent: AgentPromptAdmissionIntent = input.admissionIntent === undefined
      ? { kind: 'exact-condition', condition: validateAgentPromptCondition(input) }
      : validateAgentPromptAdmissionIntent({ ...input.admissionIntent, expectedRun: input.expectedRun })
    const expectedRun = admissionIntent.kind === 'exact-condition' ? admissionIntent.condition.expectedRun : admissionIntent.expectedRun
    if (!sameRun(session.run, expectedRun)) {
      throw new AgentMuxError('Agent Session changed before prompt submission.', 'STALE_AGENT_SESSION')
    }
    const inputKey: AgentPromptInputKey = producer === 'prompt'
      ? { kind: producer, agentSessionId: session.agentSessionId, expectedRun, submissionId: operationId }
      : { kind: producer, agentSessionId: session.agentSessionId, expectedRun, messageId: operationId }
    const provider = this.providers.get(session.providerId)
    const condition = admissionIntent.kind === 'exact-condition' ? admissionIntent.condition : admissionIntent
    const assertCurrentSubmission = (current: AgentMuxAgentSession): void => {
      assertSession?.(current)
      const nativeIdle = platformNotification?.mode === 'idle' && platformNotification.idle?.nativeEvidence !== undefined
      if (input.expectedCompletionId === undefined && input.expectedFutureIntent === undefined && !nativeIdle) return
      const position = this.nativeCurrentActivities.get(current.agentSessionId)
      if (position?.runId !== current.run.runId) return
      const activity = this.projectCurrentActivity(current)
      if (nativeIdle ? activity?.state === 'active' : !activity || activity.state !== 'idle' || activity.nativeTurnId !== current.semanticStatus?.nativeTurnId) {
        throw new AgentMuxError('Current native activity does not confirm the original automatic input boundary. The saved message and manual input remain available.',
          input.expectedCompletionId === undefined ? 'AGENT_TURN_END_UNCONFIRMED' : 'AGENT_COMPLETION_CHANGED')
      }
    }
    const ordinaryPlan = provider.planPromptInput(outbound,
      admissionIntent.kind === 'manual-actor' || input.execution === undefined ? undefined : { execution: input.execution })
    const protocolInput: AgentPromptProtocolInputBoundary = { invalid: false }
    let releasePreparationObservation: ((next?: AbortController) => void) | undefined
    let preparationStarted = false
    let transportQualification: AgentPromptTransportQualification | undefined
    try {
      stage('transport-preparation')
      const strategy = provider.catalog.capabilities.promptExecution?.immediate
      const preparationMs = 40_000
      const deadline = Date.now() + preparationMs
      transportQualification = admissionIntent.kind === 'exact-condition' && input.execution === 'immediate' && strategy === 'interrupt-before-input'
        ? await this.observeAgentInputPreparation(session, preparationMs, async signal => {
        const run = await this.requireCurrentAgentRun(session)
        return await this.promptSubmission.qualifyInputTransport(session, run, operationId, outbound, signal,
          () => { preparationStarted = true }, protocolInput, deadline, input.preparationRetry)
      }, input.signal, protocolInput, release => { releasePreparationObservation = release }) : undefined
    } catch (error) {
      releasePreparationObservation?.()
      if (preparationStarted) throw promptPreparationFailure(error)
      throw error
    }
    try {
      if (transportQualification) protocolInput.preclaim = {
        interruption: new Error('Read-only input preparation yielded for its terminal protocol ACK.'), claimStarted: false,
        observation: { phase: 'input-lane', phaseEnteredAt: Date.now(), lastCompletedPhase: null,
          lastPhaseCompletedAt: null, deadline: transportQualification.deadline, pane: null }
      }
      let delivered: AgentPromptMessageContent | undefined
      for (;;) {
        const renderObservation = new AbortController()
        try {
          stage('input-coordination')
          delivered = await this.serializeAgentInput(session, async (current, run) => {
            const savedMessage = input.expectedFutureIntent ? (await this.store.readFuturePromptIntent(current.agentSessionId, input.expectedFutureIntent.intentId))?.message : undefined
            // Timer transport is not the producer. Inherit only the original saved
            // authenticated source; retain this request's exact content for admission.
            const admittedMessage = input.expectedFutureIntent ? {
              ...(message.userContent ? { userContent: message.userContent } : {}), ...(message.systemContext ? { systemContext: message.systemContext } : {}),
              ...(savedMessage?.authorAgentSessionId ? { authorAgentSessionId: savedMessage.authorAgentSessionId } : {}),
              ...(savedMessage?.sourceDevice ? { sourceDevice: savedMessage.sourceDevice } : {})
            } : message
            return await this.promptSubmission.submitInputPlan(current, run, operationId, outbound, ordinaryPlan, condition,
              input.expectedCompletionId, input.signal, input.allowUncertainTurn, renderObservation.signal, input.expectedInputByte, admittedMessage, input.execution, input.expectedFutureIntent, assertCurrentSubmission, transportQualification,
              inputKey,
              { ...(authority ? { authority } : {}), ...inputControl,
                ...(questionReply ? { requiredNativeSource: questionReply.source } : {}),
                ...(platformNotification?.mode === 'idle' ? { idleOnly: platformNotification.idle! } : {}) })
          }, { kind: 'semantic', bytes: null }, { renderObservation, protocolInput: transportQualification ? protocolInput : undefined,
            onQueued: releasePreparationObservation, retainPreclaimYield: release => { releasePreparationObservation = release },
            preclaimDeadline: transportQualification?.deadline })
          break
        } catch (error) {
          const preclaim = protocolInput.preclaim
          if (!transportQualification || !preclaim || preclaim.claimStarted || error !== preclaim.interruption ||
              renderObservation.signal.reason !== preclaim.interruption) throw error
          if (input.signal?.aborted || Date.now() >= transportQualification.deadline) throw promptPreparationFailure(input.signal?.reason ?? error)
          try {
            const current = await this.observeAgentInputPreparation(session,
              Math.max(1, transportQualification.deadline - Date.now()), async signal => {
                const current = await this.registry.refresh(session.agentSessionId, session.run)
                signal.throwIfAborted()
                return current
              }, input.signal, protocolInput, release => {
                releasePreparationObservation?.()
                releasePreparationObservation = release
              })
            if (!sameRun(current.run, session.run) || current.promptCompletionAdmission?.submissionId === operationId ||
                current.terminalPromptSubmission?.submissionId === operationId ||
                'afterSubmissionId' in condition && (current.promptCompletionAdmission === undefined ? null : current.promptCompletionAdmission.submissionId) !== condition.afterSubmissionId) {
              throw new AgentMuxError('The original request changed while its protocol ACK was pending.', 'AGENT_PROMPT_INPUT_UNCONFIRMED')
            }
          } catch (error) {
            if (error === preclaim.interruption) continue
            throw promptPreparationFailure(error)
          }
          // Queue behind that protocol operation, retaining this invocation's original
          // ACK boundary and deadline. No qualification or message is recreated.
        }
      }
      if (delivered === undefined) throw new AgentMuxError('Original message source facts are unconfirmed; the Agent and original Input are kept.', 'AGENT_PROMPT_INPUT_UNCONFIRMED')
      stage('receipt')
      await this.recordPromptMessageAfterSideEffect(session, operationId, 'Prompt', delivered, 'complete', inputKey)
    } finally { releasePreparationObservation?.() }
  }

  /** Persist the original creation transport, without turning missing receipts into another Input. */
  private async recordInitialMessageDelivery(session: AgentMuxAgentSession, envelope: AgentMuxMessageEnvelope, confirmed: boolean, originalCreation = true): Promise<void> {
    try {
      await this.messageQueue.preparePrompt(envelope.messageId, async () => {
        if (!originalCreation) throw new AgentMuxError('The original initial message Run binding is unconfirmed; recovery cannot substitute the current Run.', 'AGENT_MESSAGE_INITIAL_RUN_UNCONFIRMED')
        return agentPromptCondition(session)
      })
      if (confirmed) await this.messageQueue.recordDelivery(envelope.messageId, 'delivered')
      else await this.messageQueue.recordDeliveryIssue(envelope.messageId,
        'Initial message delivery is unconfirmed. Read the original Agent response; this creation will not resend it.')
    } catch (error) {
      this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
        code: 'AGENT_MESSAGE_RECEIPT_UNCONFIRMED',
        message: `Agent continues, but saving the initial message delivery receipt is unconfirmed. Inspect the original message and Agent response before recovery. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'user', observedAt: Date.now(), run: session.run } })
    }
  }

  /** Authenticate original participants without loading opaque bodies or depending on historical Runs. */
  private async messageNotificationAuthority(originals: Awaited<ReturnType<DurableAgentMuxMessageQueue['readNotificationMessages']>>,
    caller?: { agentSessionId: string; capability: string }): Promise<import('./prompt-submission.js').AgentPromptInputAuthority | undefined> {
    if (!caller) return undefined
    const sender = await this.currentStoredAgentSession(caller.agentSessionId)
    this.resolveMessageAuthor(caller.capability, caller.agentSessionId, sender)
    if (originals.some(original => !original || original.senderSessionId !== caller.agentSessionId && original.recipientSessionId !== caller.agentSessionId)) throw new AgentMuxError(
      'Only an original participant of every selected message can notify or inspect these references.', 'MESSAGE_PARTICIPANT_MISMATCH')
    const binding = Object.freeze({ agentSessionId: sender.agentSessionId, workspacePath: sender.workspacePath,
      runId: sender.run.runId, capabilityHash: sender.capabilityHash ?? '' })
    return { binding, assertCurrent: () => this.assertCurrentMessageReader(caller.capability, caller.agentSessionId, sender.run) }
  }

  /** An explicit participant or trusted Host action, with its own original input identity. */
  async notifyMessages(input: { operationId: string; messageIds: readonly string[]; caller?: { agentSessionId: string; capability: string } }, context?: AgentInputCallContext): Promise<{
    notification: AgentMuxMessageNotification; input: import('./types.js').AgentPromptSubmissionRecord | null
  }> {
    context?.requestSignal?.throwIfAborted(); await context?.assertCurrent?.()
    if (!Array.isArray(input.messageIds) || !input.messageIds.length || input.messageIds.length > 100 || new Set(input.messageIds).size !== input.messageIds.length) throw new AgentMuxError(
      'Select one to one hundred distinct original Inbox message IDs.', 'INVALID_A2A_NOTIFICATION')
    const originals = await this.messageQueue.readNotificationMessages(input.messageIds)
    const authority = await this.messageNotificationAuthority(originals, input.caller)
    const first = originals[0]
    if (!first?.recipientSessionId || originals.some(original => !original || original.deliveryMode !== 'reference' ||
        original.recipientSessionId !== first.recipientSessionId)) throw new AgentMuxError(
      'The selected Inbox messages must belong to the same durable recipient Session.', 'MESSAGE_RECIPIENT_MISMATCH')
    const retained = await this.messageQueue.readNotification(input.operationId)
    let notification: AgentMuxMessageNotification | null = retained
    if (retained && (retained.mode !== 'steer' || !isDeepStrictEqual(retained.messageIds, input.messageIds) ||
        retained.key.agentSessionId !== first.recipientSessionId)) throw new AgentMuxError(
      'The original notification action already names another target or reference set.', 'A2A_NOTIFICATION_CONFLICT')
    if (!notification) {
      const session = await this.currentStoredAgentSession(first.recipientSessionId)
      notification = await this.messageQueue.prepareNotification({ notificationId: safeId(input.operationId, 'Notification operation ID'),
        agentSessionId: session.agentSessionId, condition: agentPromptCondition(session), messageIds: input.messageIds,
        originalInputAbsent: async () => !await this.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: session.agentSessionId,
          expectedRun: session.run, submissionId: input.operationId }) })
    }
    if (!notification) throw new AgentMuxError('No original Inbox references were selected.', 'MESSAGE_NOT_FOUND')
    await this.submitMessageNotification(notification, context, authority)
    return { notification: (await this.messageQueue.readNotification(notification.notificationId))!, input: await this.inspectAgentPromptSubmission(notification.key) }
  }

  /** Read only this original notification and its producer-qualified input, without preparing or dispatching. */
  async inspectMessageNotification(input: { operationId: string; caller?: { agentSessionId: string; capability: string } }): Promise<{
    notification: AgentMuxMessageNotification | null; input: import('./types.js').AgentPromptSubmissionRecord | null
  }> {
    const notification = await this.messageQueue.readNotification(safeId(input.operationId, 'Notification operation ID'))
    await this.messageNotificationAuthority(notification ? await this.messageQueue.readNotificationMessages(notification.messageIds) : [], input.caller)
    if (!notification) return { notification: null, input: null }
    const record = await this.inspectAgentPromptSubmission(notification.key)
    if (record && !isMessageNotificationInput(notification, record)) throw new AgentMuxError(
      'Another original input owns this notification identity. Its outcome cannot sign the Inbox notification.', 'AGENT_PROMPT_OPERATION_CONFLICT')
    if (!record || notification.state === 'submitted') return { notification, input: record }
    const submitted = record.admission?.acknowledged === true || record.terminalPromptSubmission?.submit.acknowledged === true
    const notApplied = agentPromptNotApplied({ run: record.run,
      ...(record.admission ? { promptCompletionAdmission: record.admission } : {}),
      ...(record.terminalPromptSubmission ? { terminalPromptSubmission: record.terminalPromptSubmission } : {}) }) !== undefined
    if (!submitted && !notApplied) return { notification, input: record }
    const { reason: _reason, resultRecordedAt, ...original } = notification
    const state = submitted ? 'submitted' : 'not-applied'
    return { notification: { ...original, state,
      ...(notification.state === state && resultRecordedAt !== undefined ? { resultRecordedAt } : {}),
      ...(submitted ? {} : { reason: 'The original input owner confirmed this whole notification input was not applied.' }) }, input: record }
  }

  private async submitMessageNotification(notice: AgentMuxMessageNotification, context?: AgentInputCallContext,
    authority?: import('./prompt-submission.js').AgentPromptInputAuthority): Promise<void> {
    if (notice.state === 'submitted' || notice.state === 'not-applied') return
    const inspect = () => this.inspectAgentPromptSubmission(notice.key)
    const submitted = (record: import('./types.js').AgentPromptSubmissionRecord | null) => isMessageNotificationInput(notice, record) &&
      (record.admission?.acknowledged === true || record.terminalPromptSubmission?.submit.acknowledged === true)
    const original = await inspect()
    if (original && !isMessageNotificationInput(notice, original)) throw new AgentMuxError(
      'Another original input owns this notification identity. Its outcome cannot sign the Inbox notification.', 'AGENT_PROMPT_OPERATION_CONFLICT')
    if (submitted(original)) { await this.messageQueue.recordNotificationResult(notice.notificationId, 'submitted'); return }
    const notApplied = (record: import('./types.js').AgentPromptSubmissionRecord | null) => isMessageNotificationInput(notice, record) &&
      agentPromptNotApplied({ run: record.run, ...(record.admission ? { promptCompletionAdmission: record.admission } : {}),
        ...(record.terminalPromptSubmission ? { terminalPromptSubmission: record.terminalPromptSubmission } : {}) }) !== undefined
    if (notApplied(original)) { await this.messageQueue.recordNotificationResult(notice.notificationId, 'not-applied', 'The original input owner confirmed this whole notification input was not applied.'); return }
    // Unknown claims are observation-only, including after reopening this Client.
    if (notice.state === 'unconfirmed' || original) {
      if (notice.state !== 'unconfirmed') await this.messageQueue.recordNotificationResult(notice.notificationId, 'unconfirmed', 'The original notification input has an unresolved admission. Keep its input key; do not send a replacement.')
      return
    }
    try {
      const base = { agentSessionId: notice.key.agentSessionId, operationId: notice.notificationId,
        prompt: notice.wire, ...(context?.requestSignal ? { signal: context.requestSignal } : {}) }
      const input: AgentMuxAgentPromptInput = notice.mode === 'idle'
        ? { ...base, ...notice.condition, execution: 'default', ...(notice.idle!.completionId === undefined ? {} : { expectedCompletionId: notice.idle!.completionId }), expectedInputByte: notice.idle!.inputByte }
        : { ...base, expectedRun: notice.key.expectedRun, admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' }
      await this.submitPromptInternal(input, undefined, undefined, undefined, this.inputCallAuthority(authority, context), 'prompt', undefined, undefined, notice)
      const receipt = await inspect()
      if (submitted(receipt)) await this.messageQueue.recordNotificationResult(notice.notificationId, 'submitted')
      else await this.messageQueue.recordNotificationResult(notice.notificationId, 'unconfirmed', 'The original input owner has not confirmed notification admission.')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const receipt = await inspect()
      if (submitted(receipt)) { await this.messageQueue.recordNotificationResult(notice.notificationId, 'submitted'); return }
      const retired = await this.messageQueue.retireNotificationBeforeInput(notice.notificationId, async () => {
        const record = await inspect()
        return record === null || notApplied(record)
      }, reason)
      if (!retired) await this.messageQueue.recordNotificationResult(notice.notificationId, 'unconfirmed', reason)
      this.publisher.publish({ type: 'agent-error', agentSessionId: notice.key.agentSessionId, code: 'A2A_NOTIFICATION_UNCONFIRMED',
        message: `The original Inbox is retained. Notification ${notice.notificationId}: ${reason}`,
        evidence: { source: 'agentmux', run: notice.key.expectedRun, observedAt: Date.now() } })
    }
  }

  async submitAgentMessage(input: AgentMuxAgentMessageInput, context?: AgentInputCallContext): Promise<void | AgentInputSubmissionReceipt> {
    context?.requestSignal?.throwIfAborted()
    input = { ...input, ...(input.caller ? { caller: { ...input.caller } } : {}) }
    const envelope = validateAgentMuxMessageEnvelope(input.envelope)
    const retained = await this.messageQueue.readByMessageId(envelope.messageId) ?? await this.messageQueue.readByOperationId(envelope.operationId)
    if (envelope.sender.kind === 'agent-session' && (retained ? retained.deliveryMode === 'reference' : input.execution !== 'immediate')) {
      if (input.execution === 'immediate' || input.admissionIntent !== undefined) throw new AgentMuxError(
        'The original Inbox intake cannot be changed into direct input. Use message.notify for its retained references.', 'AGENT_PROMPT_OPERATION_CONFLICT', undefined,
        { disposition: 'not_applied', confirmedInputBytes: 0 })
      if (!input.caller?.capability || envelope.recipientSessionId !== input.agentSessionId || envelope.recipient.kind !== 'agent-session' ||
          envelope.recipient.agentSessionId !== input.agentSessionId) throw new AgentMuxError('The original managed message author or recipient is invalid.', 'MESSAGE_SENDER_MISMATCH')
      const reauthorize = async () => {
        context?.requestSignal?.throwIfAborted()
        await context?.assertCurrent?.()
        await this.messageAuthorBinding({ capability: input.caller!.capability, callerAgentSessionId: input.caller!.agentSessionId,
          senderAgentSessionId: envelope.sender.kind === 'agent-session' ? envelope.sender.agentSessionId : null,
          senderSessionId: envelope.senderSessionId, senderRunId: envelope.senderRunId,
          recipientSessionId: envelope.recipientSessionId, recipientRunId: envelope.recipientRunId })
      }
      await reauthorize()
      await this.messageQueue.append({ ...envelope, execution: 'default', sourceChannel: normalizeMessageChannel(input.sourceChannel ?? 'agent-message'),
        ...(input.sourceDevice ? { sourceDevice: normalizeOperationDevice(input.sourceDevice) } : {}) }, { deliveryMode: 'reference', reauthorize })
      this.messageNotifications.saved(input.agentSessionId)
      return
    }
    const admissionIntent: AgentPromptAdmissionIntent = input.admissionIntent === undefined
      ? { kind: 'exact-condition', condition: validateAgentPromptCondition(input.condition) }
      : validateAgentPromptAdmissionIntent(input.admissionIntent)
    if (admissionIntent.kind !== 'exact-condition' && (Object.hasOwn(input, 'condition') || input.execution !== 'immediate')) throw new AgentMuxError('Manual message input cannot replace a caller condition.', 'INVALID_AGENT_PROMPT')
    const expectedRun = admissionIntent.kind === 'exact-condition' ? admissionIntent.condition.expectedRun : admissionIntent.expectedRun
    if (admissionIntent.kind === 'exact-condition') this.requireConnected()
    const sourceChannel = normalizeMessageChannel(input.sourceChannel ?? 'agent-message')
    const sourceDevice = input.sourceDevice === undefined ? undefined : normalizeOperationDevice(input.sourceDevice)
    if (envelope.recipient.kind !== 'agent-session' || envelope.recipient.agentSessionId !== input.agentSessionId ||
      envelope.recipientSessionId !== input.agentSessionId ||
      envelope.recipientRunId !== null && envelope.recipientRunId !== expectedRun.runId) {
      throw new AgentMuxError('Message recipient does not match its exact prompt intent.', 'MESSAGE_RECIPIENT_MISMATCH')
    }
    let authorAgentSessionId: string | undefined
    let authority: import('./prompt-submission.js').AgentPromptInputAuthority | undefined
    if (envelope.sender.kind === 'agent-session') {
      if (!input.caller?.capability) throw new AgentMuxError('Managed message capability is required.', 'AGENT_CAPABILITY_INVALID')
      const authorInput = { capability: input.caller.capability, callerAgentSessionId: input.caller.agentSessionId,
        senderAgentSessionId: envelope.sender.agentSessionId, senderSessionId: envelope.senderSessionId,
        senderRunId: envelope.senderRunId, recipientSessionId: envelope.recipientSessionId, recipientRunId: envelope.recipientRunId }
      authority = await this.messageInputAuthority(authorInput)
      authorAgentSessionId = envelope.senderSessionId!
    } else if (input.caller || envelope.senderSessionId !== null || envelope.senderRunId !== null) {
      throw new AgentMuxError('Local ingress cannot claim an Agent author.', 'MESSAGE_SENDER_MISMATCH')
    }
    if (envelope.sender.kind === 'external') authority = await this.externalMessageAuthority(envelope, context, admissionIntent)
    authority = this.inputCallAuthority(authority, context)
    const recipient = await this.currentStoredAgentSession(input.agentSessionId)
    if (!sameRun(recipient.run, expectedRun)) throw new AgentMuxError('The original message Run changed before saving.', 'STALE_AGENT_SESSION')
    const key = { kind: 'message' as const, agentSessionId: input.agentSessionId, expectedRun, messageId: envelope.messageId }
    const originalAdmission = admissionIntent.kind !== 'exact-condition' ? await this.inspectAgentPromptSubmission(key) : undefined
    const queued = await this.messageQueue.append({ ...envelope,
      sourceChannel, ...(sourceDevice ? { sourceDevice } : {}),
      ...(admissionIntent.kind !== 'exact-condition' ? { admissionIntent } : {}),
      ...(input.execution === undefined ? {} : { execution: input.execution }) },
      admissionIntent.kind !== 'exact-condition' && !originalAdmission ? { inputEnvironment: this.inputSavedEnvironment(recipient),
        originalClaimAbsent: async () => !await this.inspectAgentPromptSubmission(key) } : undefined)
    if (admissionIntent.kind === 'exact-condition' && queued.promptCondition &&
        !isDeepStrictEqual(queued.promptCondition, admissionIntent.condition)) throw new AgentMuxError(
      'The caller condition conflicts with the original saved message condition.', 'AGENT_PROMPT_OPERATION_CONFLICT')
    if (queued.input) {
      if (admissionIntent.kind === 'exact-condition') throw new AgentMuxError('The caller condition cannot replace the original controlled manual input.', 'AGENT_PROMPT_OPERATION_CONFLICT')
      const original = await this.inputWaitingPrompt(queued.input.intent, input.caller, context)
      return await this.acceptInputWaiting(queued.input.control.ref, original.input, 'message', original.authorAgentSessionId,
        this.inputCallAuthority(original.authority, context), context?.requestSignal)
    }
    if (['delivered', 'accepted', 'replied'].includes(queued.delivery.state)) return
    if (queued.delivery.state !== 'queued') throw new AgentMuxError('This message has a final delivery outcome.', 'AGENT_DELIVERY_STATE_INVALID')
    const originalIntent: AgentPromptAdmissionIntent = queued.admissionIntent ?? {
      kind: 'exact-condition', condition: await this.messageQueue.preparePrompt(envelope.messageId, async () => {
        if (admissionIntent.kind !== 'exact-condition') throw new AgentMuxError('The original message intent is unconfirmed.', 'AGENT_PROMPT_OPERATION_CONFLICT')
        return admissionIntent.condition
      }) }
    this.requireConnected()
    const promptInput = { agentSessionId: input.agentSessionId,
      operationId: envelope.messageId, prompt: renderAgentMuxMessageEnvelope(envelope), allowUncertainTurn: true,
      ...(queued.sourceChannel ? { sourceChannel: queued.sourceChannel } : {}), ...(queued.sourceDevice ? { sourceDevice: queued.sourceDevice } : {}) }
    const submission: AgentMuxAgentPromptInput = originalIntent.kind !== 'exact-condition'
      ? { ...promptInput, expectedRun: originalIntent.expectedRun, admissionIntent: (() => { const { expectedRun: _run, ...target } = originalIntent; return target })(), execution: 'immediate' }
      : { ...promptInput, ...originalIntent.condition, execution: input.execution ?? 'default' }
    await this.submitPromptInternal(submission, authorAgentSessionId,
      undefined, undefined, authority, 'message')
    await this.messageQueue.recordDelivery(envelope.messageId, 'delivered')
  }

  /** Read the exact original response without dispatching or requiring its Run to remain current. */
  async inspectAgentInteractionOperation(input: { agentSessionId: string; operationId: string }): Promise<AgentMuxInteractionOperationReceipt | null> {
    let session: AgentMuxStoredAgentSession | null = null
    await this.registry.readMetadata(input.agentSessionId, value => { session = value })
    if (!session) throw new AgentMuxError('The original Agent Session is unavailable.', 'UNKNOWN_AGENT_SESSION')
    const current = session as AgentMuxStoredAgentSession
    const receipt = current.interactionOperations?.[input.operationId]
    if (!receipt) return null
    const pending = current.pendingInteraction
    const original = pending && [pending.request, ...(pending.additionalRequests ?? [])].find(request =>
      isDeepStrictEqual(agentInteractionRequestTarget(request), agentInteractionRequestTarget(receipt.expectedRequest)))
    const hook = original?.kind === 'permission' ? original.permissionHook?.response : undefined
    const response = pending?.response?.operationId === input.operationId ? pending.response : undefined
    return structuredClone({ ...receipt,
      ...(hook?.delivery === 'connection-written' ? { delivery: 'hook-written' as const } : {}),
      ...(response ? { inputByteRange: response.inputByteRange,
        delivery: response.acknowledged ? 'bytes-accepted' as const : 'unknown' as const } : {}),
      ...(original && pending?.nativeCompleted ? { nativeCompleted: pending.nativeCompleted } : {}) })
  }

  async respondAgentInteraction(input: AgentMuxAgentInteractionInput, context?: AgentInputCallContext): Promise<AgentMuxInteractionOperationReceipt> {
    if (typeof input.operationId !== 'string' || !input.operationId || Buffer.byteLength(input.operationId) > 512 || /[\0\r\n]/u.test(input.operationId)) {
      throw new AgentMuxError('A stable interaction operation ID is required.', 'INVALID_AGENT_INTERACTION_RESPONSE')
    }
    input = { ...input, expectedRequest: normalizeAgentInteractionRequest(input.expectedRequest) }
    if (input.externalAction !== undefined) {
      const identity = parseAgentExternalInteractionAuthor(input.externalAction), originalContext = context
      if (!originalContext?.externalAction ||
          !isDeepStrictEqual(identity, originalContext.externalAction.identity)) {
        throw new AgentMuxError('The original external interaction authority is unavailable. Inspect the retained action; local responses remain available.', 'EXTERNAL_INTERACTION_AUTHORITY_UNCONFIRMED')
      }
      input = { ...input, externalAction: identity }
      const frozen = structuredClone(input)
      context = { ...originalContext, assertCurrent: async () => {
        await originalContext.assertCurrent?.()
        await originalContext.externalAction!.assertCurrent(structuredClone(frozen))
      } }
      await context.assertCurrent!()
    }

    const expected = agentInteractionRequestTarget(input.expectedRequest)
    const response = normalizeAgentInteractionResponse(expected, input.response)
    if (!isDeepStrictEqual(response, input.response)) throw new AgentMuxError('The interaction response contains unknown fields.', 'INVALID_AGENT_INTERACTION_RESPONSE')
    const original = await this.inspectAgentInteractionOperation(input)
    if (original) {
      if (!sameRun(original.run, input.expectedRun) || !isDeepStrictEqual(agentInteractionRequestTarget(original.expectedRequest), expected) ||
          !isDeepStrictEqual(original.response, response) || !isDeepStrictEqual(original.externalAction, input.externalAction)) throw new AgentMuxError('The original response operation has different content.', 'AGENT_INTERACTION_RESPONSE_CONFLICT')
      // Only an explicit same-intent caller may join the original recoverable input operation.
      // Inspection and reconnection never turn unknown into a new input attempt.
      if (!['saved', 'unknown'].includes(original.delivery) || original.nativeCompleted || expected.evidence.source === 'acp' && original.delivery === 'unknown') return original
    }
    const requested = await this.registry.resolveMetadata(input.agentSessionId, 'local', () => context?.requestSignal?.throwIfAborted())
    await this.updateExactAgentSession(input.agentSessionId, input.expectedRun, current => {
      const request = [current.pendingInteraction?.request, ...(current.pendingInteraction?.additionalRequests ?? [])].find(candidate => candidate?.id === response.requestId)
      if (!request || request.agentSessionId !== input.agentSessionId || !isDeepStrictEqual(agentInteractionRequestTarget(request), expected) ||
          !sameNativeHandle(current.nativeHandle, requested.nativeHandle)) throw new AgentMuxError('The exact original interaction request changed.', 'UNKNOWN_AGENT_INTERACTION')
      const competing = Object.values(current.interactionOperations ?? {}).find(receipt => sameRun(receipt.run, input.expectedRun) &&
        isDeepStrictEqual(agentInteractionRequestTarget(receipt.expectedRequest), expected) && receipt.operationId !== input.operationId)
      if (competing) throw new AgentMuxError('The original request already has another response operation.', 'AGENT_INTERACTION_RESPONSE_CONFLICT')
      const prior = current.interactionOperations?.[input.operationId]
      if (prior) {
        if (!isDeepStrictEqual(prior.response, response) || !isDeepStrictEqual(agentInteractionRequestTarget(prior.expectedRequest), expected)) throw new AgentMuxError('The original response operation has different content.', 'AGENT_INTERACTION_RESPONSE_CONFLICT')
        return current
      }
      return { ...current, interactionOperations: { ...current.interactionOperations, [input.operationId]: {
        operationId: input.operationId, agentSessionId: input.agentSessionId, run: input.expectedRun,
        expectedRequest: structuredClone(expected), response: structuredClone(response),
        ...(input.externalAction ? { externalAction: structuredClone(input.externalAction) } : {}),
        ...(current.nativeHandle ? { nativeHandle: current.nativeHandle } : {}), delivery: 'saved', nativeAdoption: 'unknown' } }, updatedAt: Date.now() }
    })
    await this.dispatchAgentInteraction(input, context)
    return (await this.inspectAgentInteractionOperation(input))!
  }

  private async dispatchAgentInteraction(input: AgentMuxAgentInteractionInput, context?: AgentInputCallContext): Promise<void> {
    const requestedSession = await this.registry.resolveMetadata(input.agentSessionId, 'local', () => context?.requestSignal?.throwIfAborted())
    if (!sameRun(requestedSession.run, input.expectedRun)) {
      throw new AgentMuxError(
        'Agent Session changed before its interaction was answered.',
        'STALE_AGENT_SESSION'
      )
    }
    const canonical = await this.registry.refresh(requestedSession.agentSessionId, requestedSession.run)
    const pending = canonical.pendingInteraction
    const hookRequest = [pending?.request, ...(pending?.additionalRequests ?? [])].find(request =>
      request?.id === input.response.requestId && request.kind === 'permission' && request.permissionHook)
    if (hookRequest?.kind === 'permission' && hookRequest.permissionHook) {
      await this.respondPermissionHook(canonical, hookRequest, input.response, input.operationId, context)
      return
    }
    if (pending && pending.request.evidence.source !== 'acp' && !pending.response) {
      throw new AgentMuxError(agentInteractionResponseUnavailableReason(pending) ??
        'This request has no addressable reply channel. Answer it in the original terminal.', 'AGENT_INTERACTION_UNCONFIRMED')
    }
    await this.connect()
    const assertOriginalResponseTarget = () => {
      const current = this.requireAgentSession(requestedSession.agentSessionId)
      if (!sameRun(current.run, requestedSession.run) || !sameNativeHandle(current.nativeHandle, canonical.nativeHandle) ||
          !isDeepStrictEqual(current.pendingInteraction?.request, pending?.request)) {
        throw new AgentMuxError('The original interaction target changed before dispatch.', 'STALE_AGENT_SESSION')
      }
    }
    assertOriginalResponseTarget()
    if (!pending || pending.request.id !== input.response.requestId) {
      throw new AgentMuxError('Agent interaction is not pending.', 'UNKNOWN_AGENT_INTERACTION')
    }
    const response = normalizeAgentInteractionResponse(pending.request, input.response)
    if (pending.request.evidence.source === 'acp') {
      if (response.kind !== 'permission') {
        throw new AgentMuxError('ACP question responses are unsupported.', 'AGENT_INTERACTION_UNSUPPORTED')
      }
      await context?.assertCurrent?.()
      assertOriginalResponseTarget()
      await this.updateExactAgentSession(input.agentSessionId, input.expectedRun, current => interactionReceiptPatch(current, input.operationId, { delivery: 'unknown' }))
      await this.acp.respondPermission(input.agentSessionId, pending.request.id, response.decision)
      await this.updateExactAgentSession(input.agentSessionId, input.expectedRun, current => interactionReceiptPatch(current, input.operationId, { delivery: 'acp-acknowledged' }))
      return
    }
    if (!pending.response) {
      throw new AgentMuxError(agentInteractionResponseUnavailableReason(pending) ??
        'This request has no addressable reply channel. Answer it in the original terminal.', 'AGENT_INTERACTION_UNCONFIRMED')
    }
    const data = this.providers.get(requestedSession.providerId).planInteractionResponse(pending.request, response).data
    await this.serializeAgentInput(requestedSession, async (session, run) => {
      await this.submitNativeInteractionResponse(session, run, pending.request, response,
        digestInteractionResponse(response), input.operationId, data)
    }, { kind: 'semantic', bytes: null })
  }

  private async closePermissionHook(agentSessionId: string, runId: string, receiptId: string, decided: boolean): Promise<void> {
    const session = this.registry.findByRun(runRef(runId))
    if (!session || session.agentSessionId !== agentSessionId || !session.pendingInteraction) return
    await this.updatePermissionHookRequest(session, receiptId, request => ({ ...request,
      permissionHook: { ...request.permissionHook!, closed: decided ? 'decision-returned' : 'abstained' } }))
  }

  private async updatePermissionHookRequest(session: AgentMuxAgentSession, receiptId: string,
    change: (request: Extract<AgentMuxInteractionRequest, { kind: 'permission' }>, session: AgentMuxStoredAgentSession) => AgentMuxInteractionRequest): Promise<AgentMuxStoredAgentSession> {
    const next = await this.updateExactAgentSession(session.agentSessionId, session.run, current => {
      const pending = current.pendingInteraction
      if (!pending) throw new AgentMuxError('The original permission request is no longer retained.', 'UNKNOWN_AGENT_INTERACTION')
      let found = false
      const update = (request: AgentMuxInteractionRequest) => {
        if (request.kind !== 'permission' || request.permissionHook?.receiptId !== receiptId) return request
        found = true
        return change(request, current)
      }
      const request = update(pending.request)
      const additionalRequests = pending.additionalRequests?.map(update)
      if (!found) throw new AgentMuxError('The original permission callback does not match this request.', 'UNKNOWN_AGENT_INTERACTION')
      const next = { ...current, pendingInteraction: { ...pending, request, ...(additionalRequests ? { additionalRequests } : {}) }, updatedAt: Date.now() }
      const hookResponse = [request, ...(additionalRequests ?? [])].find(candidate => candidate.kind === 'permission' && candidate.permissionHook?.receiptId === receiptId)
      const response = hookResponse?.kind === 'permission' ? hookResponse.permissionHook?.response : undefined
      return response ? interactionReceiptPatch(next, response.operationId, { delivery: response.delivery === 'connection-written' ? 'hook-written' : response.delivery }) : next
    })
    this.publishSession(next)
    return next
  }

  private async respondPermissionHook(session: AgentMuxStoredAgentSession,
    request: Extract<AgentMuxInteractionRequest, { kind: 'permission' }>,
    input: AgentMuxInteractionResponse, operationId: string, context?: AgentInputCallContext): Promise<void> {
    context?.requestSignal?.throwIfAborted()
    const value = normalizeAgentInteractionResponse(request, input)
    if (value.kind !== 'permission' || !request.permissionHook) throw new AgentMuxError('Permission Hook response kind changed.', 'INVALID_AGENT_INTERACTION_RESPONSE')
    const receiptId = request.permissionHook.receiptId
    const responseDigest = digestInteractionResponse(value)
    const contribution = this.providers.get(session.providerId).hook.permissionDecision
    const output = value.decision.outcome === 'cancelled' ? null : contribution?.outputs[value.decision.optionId]
    if (output === undefined) throw new AgentMuxError('The Provider does not declare this Hook decision.', 'AGENT_INTERACTION_UNSUPPORTED')
    const original = request.permissionHook.response
    if (original && (original.operationId !== operationId || original.responseDigest !== responseDigest)) {
      throw new AgentMuxError('This original permission callback already has a different response.', 'AGENT_INTERACTION_RESPONSE_CONFLICT')
    }
    if (original?.delivery === 'connection-written') return
    if (original?.delivery === 'unknown') throw new AgentMuxError('The original Hook response is unknown; it will not be replayed.', 'AGENT_INTERACTION_UNCONFIRMED')
    // A frozen/attempted terminal response remains on its original transport.
    if (session.pendingInteraction?.request.id === request.id && (session.pendingInteraction.response || session.pendingInteraction.nativeInput)) {
      throw new AgentMuxError('This request already has terminal input to reconcile; it cannot be answered through a Hook.', 'AGENT_INTERACTION_UNCONFIRMED')
    }
    let claimed = false, dispatchStarted = false
    try {
      await this.registry.refresh(session.agentSessionId, session.run)
      await context?.assertCurrent?.()
      await this.updatePermissionHookRequest(session, receiptId, (current, saved) => {
        if (current.permissionHook?.closed || current.permissionHook?.nativeTurnEnded || permissionNativeTurnEnd(saved, current) || !this.hookServer.hasPermissionCallback(session.agentSessionId, session.run.runId, receiptId)) {
          throw new AgentMuxError('The original permission Hook callback is closed. Use the original terminal.', 'AGENT_INTERACTION_UNCONFIRMED')
        }
        const previous = current.permissionHook?.response
        if (previous && (previous.operationId !== operationId || previous.responseDigest !== responseDigest || previous.delivery !== 'saved')) {
          throw new AgentMuxError('The original permission decision has already been dispatched.', 'AGENT_INTERACTION_UNCONFIRMED')
        }
        return { ...current, permissionHook: { ...current.permissionHook!, response: { value, operationId, responseDigest, delivery: 'saved' } } }
      })
      // Only this existing saved-to-unknown CAS claims the original decision dispatch.
      // A concurrent save or claim loser never owns the original callback's None exit.
      await this.updatePermissionHookRequest(session, receiptId, (current, saved) => {
        if (current.permissionHook?.closed || current.permissionHook?.nativeTurnEnded || permissionNativeTurnEnd(saved, current) || current.permissionHook?.response?.operationId !== operationId ||
            current.permissionHook.response.delivery !== 'saved' ||
            !this.hookServer.hasPermissionCallback(session.agentSessionId, session.run.runId, receiptId)) {
          throw new AgentMuxError('The original permission callback changed before dispatch.', 'AGENT_INTERACTION_UNCONFIRMED')
        }
        return { ...current, permissionHook: { ...current.permissionHook, response: { ...current.permissionHook.response, delivery: 'unknown' } } }
      })
      claimed = true
      await context?.assertCurrent?.()
      context?.requestSignal?.throwIfAborted()
      // Authority may await another Core owner. Read its exact durable target after that wait,
      // then reach the original callback resolution without another unchecked await.
      const current = await this.registry.refresh(session.agentSessionId, session.run), pending = current.pendingInteraction
      context?.requestSignal?.throwIfAborted()
      const target = [pending?.request, ...(pending?.additionalRequests ?? [])].find(candidate => candidate?.id === request.id)
      if (!sameRun(current.run, session.run) || target?.kind !== 'permission' || !target.permissionHook || target.permissionHook.nativeTurnEnded || permissionNativeTurnEnd(current, target) ||
          current.nativeHandle?.kind === 'provider' && target.permissionHook.nativeSessionId !== undefined && target.permissionHook.nativeSessionId !== current.nativeHandle.sessionId) {
        throw new AgentMuxError('The original permission target changed before dispatch.', 'AGENT_INTERACTION_UNCONFIRMED')
      }
      dispatchStarted = true
      await this.hookServer.respondPermission(session.agentSessionId, session.run.runId, receiptId, output === null ? null : structuredClone(output))
      await this.updatePermissionHookRequest(session, receiptId, current => ({ ...current,
        permissionHook: { ...current.permissionHook!, response: { ...current.permissionHook!.response!, delivery: 'connection-written' } } }))
    } catch (error) {
      if (claimed && !dispatchStarted) {
        // This caller won the dispatch claim and no original response call occurred. Release the exact callback without a decision;
        // revocation must not leave Native waiting behind a response we know was never sent.
        this.hookServer.abstainPermission(session.agentSessionId, session.run.runId, receiptId)
        try {
          await this.updatePermissionHookRequest(session, receiptId, current => {
              const response = current.permissionHook?.response
              return response?.operationId === operationId && response.delivery === 'unknown'
                ? { ...current, permissionHook: { ...current.permissionHook!, closed: 'abstained', response: { ...response, delivery: 'saved' } } }
                : current
          })
        } catch { /* The original rejection and durable choice remain; never retry this callback. */ }
      }
      throw error
    }
  }

  /**
   * Set an Agent's live security posture in-band. The renderer sends a mode id; the Provider resolves that
   * mode's declared keystroke core-side (its bytes never cross IPC), and it is written over the SAME
   * PTY-input transport a prompt uses. It is not a launch flag: it drives the Provider's own in-band
   * control, so it takes effect on the running process rather than silently no-oping. Fails closed on a
   * Provider that declares no posture control or a mode it does not declare.
   */
  async setAgentPosture(input: AgentMuxAgentPostureInput): Promise<void> {
    this.requireConnected()
    const session = this.requireAgentSession(input.agentSessionId)
    if (!sameRun(session.run, input.expectedRun)) {
      throw new AgentMuxError(
        'Agent Session changed before its posture was set.',
        'STALE_AGENT_SESSION'
      )
    }
    const plan = this.providers.get(session.providerId).planPostureSet(input.modeId)
    if (!plan.data) {
      throw new AgentMuxError('Provider posture keystroke cannot be empty.', 'INVALID_AGENT_PROVIDER')
    }
    await this.writeAgentInput(session, plan.data, 'user', 'posture')
  }

  async resizeAgent(
    agentSessionId: string,
    expectedRun: AgentMuxRunRef,
    cols: number,
    rows: number
  ): Promise<AgentMuxRunAppliedSize> {
    this.requireConnected()
    const session = await this.resolveRawAgentSession(agentSessionId)
    if (!sameRun(session.run, expectedRun)) {
      throw new AgentMuxError(
        'Agent Session changed before its Run was resized.',
        'STALE_AGENT_SESSION'
      )
    }
    const applied = await this.resizeTerminal(expectedRun, cols, rows)
    // 屏幕几何变了，长命屏幕证据随之失效；下一次观察按新尺寸重建。
    this.screenEvidence.discard(agentSessionId, { source: 'resize', runId: expectedRun.runId })
    // 但**作废不等于恢复**（#660，与 #628 同族、触发点不同）：`discard()` 里的 `evidence.dispose()`
    // 同步 `notify()`，挂在这具证据上的 `wait()` 的 `inspect()` 看到 `disposed` 走 `abort()`，于是在途的
    // readiness 观察以 AGENT_PROMPT_READINESS_CANCELLED 结束——而 `observeReadiness` 的 `.catch` 对这个码
    // 是**静默早退**：不发 agent-error、不重挂、连自己那条 `readinessCancels` 表项都不删。
    //
    // 没有别的推进者能救它：`observeReadiness` 的其余调用点只有握手重跑（open / 重连）与 Stop hook。
    // 于是 resize 落在 readiness 窗口里 ⇒ `readyThroughByte` 永远停在 pending ⇒ 此后每条 prompt 被
    // AGENT_PROMPT_NOT_READY 拒掉，且没有出路。而 desktop 恰恰在 Agent 面板布局时就 resize
    // （runtime-controller 的 resizeSessionAttachment → resizeAgent），所以这个窗口是常态而非边角。
    // #628 补的那道 timeout 救不了它：CANCELLED 走的是上面那条静默出口，不是超时出口。
    //
    // 五个位置/条件约束，各自都由变异实测钉住（test/client-agent-resize-readiness.test.ts）：一次只改
    // 一件事，每个变异都只打红对应的那一条测试。
    //   1. 排在 `discard()` **之后**。挪到前面时旧 entry 还在表里且 `failed === false`，`ensure()` 会复用
    //      它（观察数不涨），随后 `discard()` 又把它打死——等于没重挂。
    //   2. 按**这一个** Session 重挂，不用 `cancelAllReadiness()`：那是全 Session 的，resize 一个 Agent
    //      不该动别人的观察。旧那条闭包由 `observeReadiness` 自己第一行的
    //      `readinessCancels.get(id)?.()` 收掉（身份相等才删），所以不会泄漏。
    //   3. 只在**仍然 pending** 时重挂。已就绪时重挂是白付一次从 byte 0 的全量重放：`markReady` 会走
    //      `readyThroughByte !== undefined` 那条早退，什么也不做。
    //   4. 只给**发起这次 resize 的那个 Run** 重挂。`sameRun` 这一项不是纵深防御而是可达分支：resize 是
    //      await 的，resume 会在同一个 agentSessionId 上换 Run，而新 Run 的 readiness 由它自己的握手路径
    //      负责挂——这里再挂一条，同一个 epoch 上两条观察会互相取消。
    //
    // 跨过上面那次 await 之后要重读 Session：Run 可能已经换掉、Session 可能已经退场。这里刻意用
    // `has()` 而不是 `requireAgentSession()`——resize 本身已经成功了，恢复动作的前提不成立时应当安静跳过，
    // 而不是把一次成功的 resize 变成 UNKNOWN_AGENT_SESSION。
    if (this.registry.has(agentSessionId)) {
      const current = this.registry.get(agentSessionId)
      const readiness = current.terminalPromptReadiness
      if (
        sameRun(current.run, expectedRun) &&
        readiness &&
        readiness.readyThroughByte === undefined
      ) {
        this.promptSubmission.observeReadiness(current, readiness)
      }
    }
    return applied
  }

  async signalAgent(agentSessionId: string, expectedRun: AgentMuxRunRef, signal: string): Promise<void> {
    this.requireConnected()
    const session = await this.resolveRawAgentSession(agentSessionId)
    if (!sameRun(session.run, expectedRun)) {
      throw new AgentMuxError('Agent Session changed before its Run was interrupted.', 'STALE_AGENT_SESSION')
    }
    await this.signalTerminal(expectedRun, signal)
  }

  async stopAgent(agentSessionId: string, expectedRun: AgentMuxRunRef): Promise<void> {
    this.requireConnected()
    const flightKey = JSON.stringify([agentSessionId, expectedRun.runId])
    let flight = this.agentStopFlights.get(flightKey)
    if (!flight) {
      flight = { readers: 0, retired: false, admission: this.prepareAgentStop(agentSessionId, expectedRun) }
      this.agentStopFlights.set(flightKey, flight)
    }
    flight.readers++
    try {
      const { session, reservation, stopOperation } = await flight.admission
      if (flight.retirement) return await flight.retirement
      // Each explicit retry can reconcile the original operation independently.
      // A stalled Runtime receipt reader must not block the next Stop reader.
      let run: CtxmuxAdapterRun | null = null
      try {
        run = await this.requireCurrentAgentRun(session)
      } catch (error) {
        if (flight.retirement) return await flight.retirement
        if (!(error instanceof AgentMuxError) || error.code !== 'STALE_AGENT_SESSION_BINDING') throw error
      }
      if (flight.retirement) return await flight.retirement
      if (run?.state.type === 'running') {
        try { await this.kernel.stop(stopOperation) }
        catch (error) {
          if (flight.retirement) return await flight.retirement
          if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_run_not_found') throw error
        }
      } else if (run) await this.releaseRunAttachment(session.run)
      // A late original reader joins the same retirement, even after the Session
      // leaves the registry. A failed cleanup permits explicit retry of that tail.
      if (!flight.retirement) {
        const retirement = this.retireStoppedAgent(session, reservation, () => { flight.retired = true })
        flight.retirement = retirement
        void retirement.catch(() => { if (!flight.retired && flight.retirement === retirement) delete flight.retirement })
      }
      await flight.retirement
    } finally {
      flight.readers--
      if (!flight.readers && this.agentStopFlights.get(flightKey) === flight) this.agentStopFlights.delete(flightKey)
    }
  }

  private async prepareAgentStop(agentSessionId: string, expectedRun: AgentMuxRunRef) {
    const session = await this.resolveRawAgentSession(agentSessionId)
    if (!sameRun(session.run, expectedRun)) {
      throw new AgentMuxError('Agent Session changed before its Run was stopped.', 'STALE_AGENT_SESSION')
    }
    const retained = (await this.registry.claimStaleLifecycles(Date.now(), { agentSessionId, expectedRun }))[0]
    const operationId = retained?.operationId ?? agentLifecycleOperationIdentity('stop', agentSessionId, mintObjectId())
    const stopOperation = retained?.kind === 'stop' ? retained.stopOperation : await this.kernel.prepareStop(expectedRun.runId, operationId)
    const reservation = retained ?? await this.registry.reserveExisting('stop', agentSessionId, expectedRun, operationId, stopOperation)
    // Intent is recorded only after admission succeeds. Keep this prepared
    // identity through observation/receipt/cleanup failures until retirement;
    // no individual reader can release another reader's accepted operation.
    this.stopRequestedRuns.add(expectedRun.runId)
    return { session, reservation, stopOperation }
  }

  private async retireStoppedAgent(session: AgentMuxAgentSession, reservation: AgentMuxLifecycleReservation, onRetired: () => void): Promise<void> {
    const agentSessionId = session.agentSessionId
    await this.hookBindings.get(session.run.runId)?.close()
    // A lost Store commit ACK can leave this old reader unconfirmed while the
    // original identity has already been explicitly reopened with another Run.
    if (this.registry.has(agentSessionId) && !sameRun(this.registry.get(agentSessionId).run, session.run)) {
      throw new AgentMuxError('Agent Session changed before its original Stop cleanup.', 'STALE_AGENT_SESSION')
    }
    this.hookBindings.delete(session.run.runId)
    this.settleHookRestore(session)
    const cleanup = await Promise.allSettled([
      this.acp.unbind(agentSessionId),
      this.registry.commitLifecycle(reservation, null).then(onRetired)
    ])
    if (cleanup[1]?.status === 'fulfilled') {
      this.recovery.wake(agentSessionId)
      this.runPids.delete(session.run.runId)
      if (!this.registry.has(agentSessionId) || sameRun(this.registry.get(agentSessionId).run, session.run)) {
        this.agentInputCursors.delete(agentSessionId)
        this.agentInputTails.delete(agentSessionId)
      }
      this.publisher.publish({
        type: 'run-removed', agentSessionId, run: { ...session.run },
        evidence: { source: 'user', observedAt: Date.now(), run: { ...session.run } }
      })
    }
    const errors = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Agent stopped but Agent Session cleanup failed.')
  }

  async bindAcp(agentSessionId: string, binding: AgentMuxAcpBinding): Promise<void> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    if (this.providers.get(session.providerId).catalog.acpStrategy.kind !== 'adapter') {
      throw new AgentMuxError('Provider does not declare an ACP adapter.', 'ACP_UNSUPPORTED')
    }
    await this.acp.bind(agentSessionId, binding)
  }

  private async recoverStaleLifecycles(): Promise<void> {
    const reservations = await this.registry.claimStaleLifecycles()
    if (reservations.length === 0) return
    let unpreparedRuns: readonly CtxmuxAdapterRun[] | undefined
    for (const reservation of reservations) {
      if (reservation.kind === 'create' && reservation.preparedCreation) {
        try { await this.completePreparedCreate(reservation, await this.kernel.inspectCreation(reservation.operationId)) }
        catch (error) { this.publisher.publish({ type: 'agent-error', agentSessionId: reservation.agentSessionId,
          code: 'AGENT_CREATION_UNCONFIRMED', message: error instanceof Error ? error.message : String(error),
          evidence: { source: 'agentmux', observedAt: Date.now() } }) }
        // A prepared fork owns an actual-or-unknown start, never an orphan authorized for killing.
        continue
      }
      if (reservation.kind === 'reopen') {
        try { await this.recovery.completePreparedReopen(reservation, await this.kernel.inspectCreation(reservation.operationId)) }
        catch (error) { this.publisher.publish({ type: 'agent-error', agentSessionId: reservation.agentSessionId,
          code: 'AGENT_REOPEN_UNCONFIRMED', message: error instanceof Error ? error.message : String(error),
          evidence: { source: 'agentmux', observedAt: Date.now() } }) }
        continue
      }
      if (reservation.kind === 'resume' && reservation.restart && !reservation.preparedSession) continue
      if (reservation.kind === 'resume' && reservation.preparedSession) {
        try { await this.recovery.completePreparedResume(reservation, await this.kernel.inspectCreation(reservation.operationId)) }
        catch (error) { this.publisher.publish({ type: 'agent-error', agentSessionId: reservation.agentSessionId,
          code: 'AGENT_CONTINUITY_UNCONFIRMED', message: String(error), evidence: { source: 'agentmux', observedAt: Date.now() } }) }
        continue
      }
      if (reservation.kind === 'stop') {
        let run: CtxmuxAdapterRun | null = null
        try {
          run = await this.kernel.status(reservation.expectedRun.runId)
        } catch (error) {
          if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_run_not_found') throw error
        }
        if (run?.state.type === 'running') await this.kernel.stop(reservation.stopOperation)
        await this.registry.commitLifecycle(reservation, null)
        continue
      }
      let retiredRuns: AgentMuxRunRef[] = []
      unpreparedRuns ??= await this.kernel.list()
      const candidates = unpreparedRuns.filter(
        (run) => run.lifecycleOperationId === reservation.operationId
      )
      for (const run of candidates) await this.retireUncommittedRun(run.runId)
      retiredRuns = candidates.map((run) => runRef(run.runId))
      await this.registry.releaseLifecycle(reservation, retiredRuns)
    }
  }

  private async recoverPendingInteractionResponses(runs: readonly CtxmuxAdapterRun[]): Promise<void> {
    for (const session of this.registry.list()) {
      const pending = session.pendingInteraction
      if (!pending || session.nativeSourceObservation) continue
      if (pending.request.evidence.source === 'acp') {
        if (!this.acp.hasPendingPermission(session.agentSessionId, pending.request.id)) {
          const settled = await this.clearPendingInteraction(session, pending.request.id)
          this.publishSession(settled)
        }
        continue
      }
      if (pending.response?.acknowledged) {
        if (agentInteractionResponseSettled(pending)) this.publishSession(await this.clearPendingInteraction(session, pending.request.id))
        continue
      }
      const response = pending.response
      if (!response || pending.request.evidence.source !== 'native-hook' || pending.nativeInput) continue
      const run = runs.find(candidate => candidate.runId === session.run.runId)
      if (!run || run.acceptedInputBytes === null || run.acceptedInputBytes < response.inputByteRange.endByte) {
        this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
          code: 'AGENT_INTERACTION_UNCONFIRMED',
          message: 'The original typed response receipt is unconfirmed. It will not be replayed; continue in the original terminal.',
          evidence: { source: 'agentmux', observedAt: Date.now(), run: { ...session.run } } })
        continue
      }
      const normalized = normalizeAgentInteractionResponse(pending.request, response.value)
      const data = this.providers.get(session.providerId).planInteractionResponse(pending.request, normalized).data
      const reconcile = (current: AgentMuxAgentSession, currentRun: CtxmuxAdapterRun) => this.submitNativeInteractionResponse(
        current, currentRun, pending.request, normalized, digestInteractionResponse(normalized), response.operationId, data)
      try {
        if (run.state.type === 'running') await this.serializeAgentInput(session, reconcile, { kind: 'semantic', bytes: null })
        else await reconcile(session, run)
      } catch (error) {
        // A missing or refused original operation is not proof that another input was our answer.
        this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
          code: 'AGENT_INTERACTION_UNCONFIRMED', message: `The original typed response receipt is unconfirmed: ${error instanceof Error ? error.message : String(error)} The original terminal remains available.`,
          evidence: { source: 'agentmux', observedAt: Date.now(), run: { ...session.run } } })
      }
    }
  }

  private async retireUncommittedRun(runId: string): Promise<void> {
    let run: CtxmuxAdapterRun
    try {
      run = await this.kernel.status(runId)
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found') return
      throw error
    }
    if (run.state.type === 'running') await this.stopRunningRun(runId)
  }

  private async stopRunningRun(runId: string): Promise<void> {
    // 恢复期主动停掉的 uncommitted run 也是「我们关的」——记下意图，让其退出事件同样归为 user-stopped。
    this.stopRequestedRuns.add(runId)
    await this.kernel.stop(await this.kernel.prepareStop(runId))
  }

  private synchronizeAgentRuns(runs: readonly CtxmuxAdapterRun[]): void {
    const runsById = new Map(runs.map((run) => [run.runId, run]))
    for (const session of this.registry.list()) {
      const run = runsById.get(session.run.runId)
      if (run) this.assertAgentRun(session, run)
    }
  }

  private projectCurrentActivity(session: Pick<AgentMuxAgentSession, 'agentSessionId' | 'run' | 'nativeHandle' |
    'promptCompletionAdmission' | 'nativeSourceObservation' | 'nativeBinding'>): AgentCurrentActivity | undefined {
    const activity = this.nativeCurrentActivities.get(session.agentSessionId)
    const childrenUnconfirmed = agentSubagentActivityUnconfirmed(session.run.runId, activity?.event.sourceId)
    if (activity?.fact && activity.runId === session.run.runId &&
        session.nativeHandle?.kind === 'provider' && activity.fact.nativeSessionId === session.nativeHandle.sessionId &&
        !this.endedRuns.has(session.run.runId) &&
        (activity.fact.state !== 'idle' || activity.invalidated || childrenUnconfirmed || !agentHasActiveSubagents(session.run.runId))) {
      const fact = structuredClone(activity.fact)
      if (activity.invalidated || childrenUnconfirmed || activity.admissionId !== session.promptCompletionAdmission?.submissionId ||
          nativeTargetSourceUnconfirmed(session)) {
        delete fact.interruption
        return { ...fact, state: 'unknown' }
      }
      return fact
    }
    return undefined
  }

  /** Public projections overlay live Core observations without writing them to the Session store. */
  private projectSession(session: AgentMuxStoredAgentSession): AgentMuxAgentSession {
    const projected = cloneSession(session)
    const currentActivity = this.projectCurrentActivity(session)
    if (currentActivity) projected.currentActivity = currentActivity
    if (session.nativeHandle) projected.nativeHandlePersistence = this.registry.isDurabilityUnconfirmed(session.agentSessionId)
      ? 'unconfirmed' : 'confirmed'
    const frontend = this.terminalFrontendWatches.get(session.agentSessionId)?.frontend
    if (frontend && sameRun(frontend.run, session.run)) projected.terminalFrontend = structuredClone(frontend)
    const pending = projected.pendingInteraction
    if (pending) {
      const requests = [pending.request, ...(pending.additionalRequests ?? [])]
      for (const request of requests) if (request.kind === 'permission' && request.permissionHook &&
          !request.permissionHook.closed && !this.hookServer.hasPermissionCallback(session.agentSessionId, session.run.runId, request.permissionHook.receiptId)) {
        request.responseUnavailableReason = 'The original permission Hook callback is no longer open. Use the original terminal; the decision will not be replayed.'
      }
    }
    const observation = this.currentHookIngressObservation(session)
    if (observation) projected.hookIngressObservation = structuredClone(observation)
    return projected
  }

  private currentHookIngressObservation(session: AgentMuxStoredAgentSession): AgentMuxAgentSession['hookIngressObservation'] {
    const observation = this.hookIngressObservations.get(session.agentSessionId)
    if (!observation || !sameRun(observation.run, session.run) ||
        observation.nativeTarget && !sameNativeHandle(observation.nativeTarget, session.nativeHandle)) return undefined
    const { nativeTarget: _target, ...fact } = observation
    return fact
  }

  /** A delayed caller may report its own receipt, but cannot publish its old binding as current. */
  private publishSession(session: AgentMuxStoredAgentSession, observationOrigin?: AgentMuxObservationOrigin, local?: LocalSessionObservation): void {
    let current: AgentMuxStoredAgentSession
    try { current = this.registry.get(session.agentSessionId) }
    catch (error) { if (error instanceof AgentMuxError && error.code === 'UNKNOWN_AGENT_SESSION') return; throw error }
    const frontendWatch = this.terminalFrontendWatches.get(current.agentSessionId)
    if (frontendWatch && frontendWatch.key !== JSON.stringify([current.run.runId, current.nativeActor])) {
      frontendWatch.controller.abort(); this.terminalFrontendWatches.delete(current.agentSessionId)
    }
    this.recovery.observe(current)
    const projected = this.projectSession(current)
    if (local) {
      if (!sameRun(current.run, session.run)) return
      projected[local] = structuredClone(session[local]) as never
    }
    this.publisher.publish({ type: 'agent-session', session: projected,
      ...(local ? { [localSessionObservation]: local } : {}), ...(observationOrigin ? { observationOrigin } : {}) })
  }

  private observeHookRestoreFailure(session: AgentMuxStoredAgentSession, phase: 'listen' | 'binding', error: unknown): void {
    const current = this.registry.findByRun(session.run)
    if (!current || current.agentSessionId !== session.agentSessionId || this.endedRuns.has(session.run.runId)) return
    const code = error instanceof AgentMuxError ? error.code : (error as NodeJS.ErrnoException)?.code ?? 'HOOK_INGRESS_RESTORE_FAILED'
    this.hookIngressObservations.set(session.agentSessionId, { run: { ...session.run }, phase, code,
      message: `Native Hook observation could not restore its ${phase === 'listen' ? 'local listener' : 'original Run binding'}. ${error instanceof Error ? error.message : String(error)}`,
      observedAt: Date.now() })
    this.publishSession(current)
  }

  private settleHookRestore(session: Pick<AgentMuxAgentSession, 'agentSessionId' | 'run'>): void {
    const observation = this.hookIngressObservations.get(session.agentSessionId)
    if (!observation || !sameRun(observation.run, session.run) || observation.code === 'AGENT_NATIVE_ACTIVITY_UNAVAILABLE') return
    this.hookIngressObservations.delete(session.agentSessionId)
    const current = this.registry.findByRun(session.run)
    if (current?.agentSessionId === session.agentSessionId) this.publishSession(current)
  }

  /** Both native exit events and reconnected terminal facts release the same exact Hook owner. */
  private releaseEndedRunHook(run: AgentMuxRunRef, session?: AgentMuxStoredAgentSession): void {
    const binding = this.hookBindings.get(run.runId)
    this.hookBindings.delete(run.runId)
    if (binding) void binding.close().catch(error => this.publisher.publish({ type: 'agent-error',
      ...(session ? { agentSessionId: session.agentSessionId } : {}), code: 'HOOK_BINDING_RELEASE_UNCONFIRMED',
      message: `The original Run ended, but draining its Hook binding is unconfirmed. ${error instanceof Error ? error.message : String(error)}`,
      evidence: { source: 'agentmux', run: { ...run }, observedAt: Date.now() } }))
    if (session) this.hookIngressObservations.delete(session.agentSessionId)
  }

  /** One in-flight binding restoration per exact Run; no independent reconnect or input owner. */
  private restoreHookBinding(session: AgentMuxStoredAgentSession): Promise<void> {
    if (this.reopensDisposed) return Promise.resolve()
    const pending = this.hookRestorations.get(session.run.runId)
    if (pending) return pending
    const restoring = (async () => {
      try { await this.hookServer.start() }
      catch (error) { this.observeHookRestoreFailure(session, 'listen', error); return }
      const retained = this.hookBindings.get(session.run.runId)
      if (retained) {
        try {
          const observation = this.currentHookIngressObservation(session)
          if (observation?.phase === 'binding') {
            await retained.bindRun(session.run.runId)
          }
          this.settleHookRestore(session)
        } catch (error) { this.observeHookRestoreFailure(session, 'binding', error) }
        return
      }
      let binding: AgentHookBinding | undefined
      try {
        binding = this.hookServer.createBinding(session.agentSessionId, session.providerId, session.hookBindingId, session.hookToken)
        await binding.bindRun(session.run.runId)
        const current = this.registry.findByRun(session.run)
        if (!current || current.agentSessionId !== session.agentSessionId || this.endedRuns.has(session.run.runId)) {
          await binding.close()
          return
        }
        this.hookBindings.set(session.run.runId, binding)
        this.settleHookRestore(session)
      } catch (error) {
        this.observeHookRestoreFailure(session, 'binding', error)
        try { await binding?.close() }
        catch (releaseError) { this.observeHookRestoreFailure(session, 'binding', releaseError) }
      }
    })().finally(() => { if (this.hookRestorations.get(session.run.runId) === restoring) this.hookRestorations.delete(session.run.runId) })
    this.hookRestorations.set(session.run.runId, restoring)
    return restoring
  }

  private async tryRestoreHookIngress(runs: readonly CtxmuxAdapterRun[]): Promise<void> {
    const live = new Set(runs.filter(run => run.state.type === 'running').map(run => run.runId))
    for (const [id, observation] of this.hookIngressObservations) {
      if (this.registry.findByRun(observation.run)?.agentSessionId !== id) this.hookIngressObservations.delete(id)
    }
    await Promise.all(this.registry.list().filter(session => live.has(session.run.runId)).map(session => this.restoreHookBinding(session)))
  }

  private async requireHookIngressOwner(): Promise<void> {
    if (this.hookServer.isRunning()) return
    try {
      await this.hookServer.start()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new AgentMuxError(
          'Another AgentMux client owns the Hook ingress required for this lifecycle operation.',
          'HOOK_INGRESS_BUSY'
        )
      }
      throw error
    }
  }

  private assertAgentRun(session: AgentMuxAgentSession, run: CtxmuxAdapterRun, durableSessions?: readonly AgentMuxAgentSession[]): void {
    const matching = durableSessions?.filter(candidate => sameRun(candidate.run, runRef(run.runId)))
    const resolved = matching ? matching.length === 1 ? matching[0] : undefined
      : this.registry.resolve({ kind: 'run', run: runRef(run.runId) })
    if (
      !sameRun(session.run, runRef(run.runId)) ||
      resolved?.agentSessionId !== session.agentSessionId ||
      run.workspacePath !== session.workspacePath
    ) {
      throw new AgentMuxError('Run no longer matches the Agent Session.', 'AGENT_SESSION_RUN_MISMATCH')
    }
  }

  private async requireCurrentAgentRun(session: AgentMuxAgentSession, durableSessions?: readonly AgentMuxAgentSession[]): Promise<CtxmuxAdapterRun> {
    let run: CtxmuxAdapterRun
    try {
      run = await this.kernel.status(session.run.runId)
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found') {
        const missing = new AgentMuxError('Agent Session points to a Run that is no longer available.', 'STALE_AGENT_SESSION_BINDING', error.detail)
        missing.cause = error
        throw missing
      }
      throw error
    }
    this.assertAgentRun(session, run, durableSessions)
    return run
  }

  private agentSessionStorePath(): string | undefined {
    // Only a file-backed store has a durable path worth telling spawned processes about. A memory store
    // (checkHost probes, tests) has none, and the CLI reaching it would be meaningless — leave the
    // variable unset so nothing is misdirected.
    return this.store instanceof AgentMuxFileAgentSessionStore ? this.store.path : undefined
  }

  private agentEnvironment(
    environment: Readonly<Record<string, string>>,
    agentSessionId: string,
    providerId: AgentProviderId,
    executorId: AgentExecutorId,
    binding: AgentHookBinding,
    lifecycleOperationId: string,
    capability: string
  ): Record<string, string> {
    const provider = this.providers.get(providerId)
    // usage 与 eventNameSource 均从 catalog/hook 声明注入轻量元数据，不让子进程导入注册表。
    // launch/resume 贡献当前声明，并在 flag/generated-code/source absent 时清除继承的旧 payload 声明。
    const usage = provider.catalog.capabilities.usage
    const source = provider.hook.eventNameSource
    const resolved: Record<string, string> = {
      ...terminalEnvironment({ ...environment, AGENTMUX_MESSAGE_QUEUE_PATH: this.messageQueue.path }, this.agentSessionStorePath()),
      AGENTMUX_RPC_ENDPOINT: `unix:${this.controlSocketPath}`,
      AGENTMUX_HOOK_URL: binding.endpoint.url,
      AGENTMUX_HOOK_TOKEN: binding.endpoint.token,
      AGENTMUX_AGENT_SESSION_ID: agentSessionId,
      AGENTMUX_PROVIDER_ID: providerId,
      AGENTMUX_EXECUTOR_ID: executorId,
      AGENTMUX_LIFECYCLE_OPERATION_ID: lifecycleOperationId,
      // 这枚凭证是这个 Agent 说话时的身份证明。Core 只留它的 hash；公开的
      // AGENTMUX_AGENT_SESSION_ID 只是上下文提示，改一下就能冒充，故不能用于认证。
      AGENTMUX_AGENT_CAPABILITY: capability,
      ...(usage ? { AGENTMUX_USAGE_TRANSCRIPT_FORMAT: usage.transcriptFormat } : {}),
      ...(source?.kind === 'payload' ? { AGENTMUX_HOOK_PAYLOAD_KEY: source.payloadKey } : {})
    }
    if (source?.kind !== 'payload') {
      delete resolved.AGENTMUX_HOOK_PAYLOAD_KEY
    }
    if (source?.kind === 'flag') {
      resolved.AGENTMUX_HOOK_EVENT_NAME_SOURCE = 'flag'
    } else {
      delete resolved.AGENTMUX_HOOK_EVENT_NAME_SOURCE
    }
    return resolved
  }

  /**
   * A capability timeout or changed retained input boundary does not revoke a healthy Run.
   *
   * 四个调用点里有三个（connect 循环、launch、resume）过去把任何握手错误都当成致命：connect
   * 会 `kernel.disconnect()` 拆掉整条连接，launch/resume 会回滚——**用一次慢探测杀掉一个刚
   * 启动好的、健康的 Agent**。超时与旧握手输入边界变化只保留能力未知；其余错误拒绝这次观察。
   *
   * 降级时做两件事，一件都不能少：
   * 1. 从 daemon 播种输入游标（与无握手 provider 同一条兜底），否则首条 prompt 的栅栏起点是错的。
   * 2. 发一条 agent-session 事件把降级说出去。**绝不静默**——静默降级本身就是原则 11 的违例，
   *    用户必须看得见自己在降级状态里。
   *
   * 绝不做的一件事：伪造受据。没送出 `[?0u` 就不写 `acknowledged: true`，`terminalHandshake`
   * 保持未设（状态＝未知，而不是编一个）。伪造会撞上 `acceptedInputBytes >= endByte` 的断言，
   * 并污染崩溃恢复的幂等性。
   */
  private async ensureTerminalHandshakeOrDegrade(
    requestedSession: AgentMuxStoredAgentSession,
    knownRun?: CtxmuxAdapterRun
  ): Promise<AgentMuxStoredAgentSession> {
    try {
      return await this.ensureTerminalHandshake(requestedSession, knownRun)
    } catch (error) {
      // Any exact-Run disappearance during attach, boundary status, or capability Input is a real
      // failure for this Session but not a reason to guess that an unrelated Session is unhealthy.
      // Normalize it before classification so `open()` can contain the blast radius per Session.
      error = mapVanishedTerminalHandshakeRun(error)
      const outcome = classifyTerminalHandshakeFailure(error)
      if (outcome.kind === 'abort') throw error
      // A timeout is only degradable while the exact Run is still alive. The Run returned by
      // `list()`/`start()` is a useful hint, but it may already be stale by the time the timer fires;
      // ask CtxMux for the authoritative state before allowing the lifecycle to continue.
      const run = await this.requireRunningTerminalHandshakeRun(requestedSession)
      const cursor = degradedInputCursor(run.acceptedInputBytes)
      if (cursor === undefined) {
        // Without the daemon cursor we cannot fence the next input write. This is a broken CtxMux
        // contract, not a Provider capability timeout, so fail closed instead of guessing zero.
        throw new AgentMuxError(
          'CtxMux omitted its accepted Input byte cursor while terminal capability was degraded.',
          'CTXMUX_INPUT_CURSOR_MISSING'
        )
      }
      this.agentInputCursors.set(requestedSession.agentSessionId, cursor)
      const observedAt = Date.now()
      const degraded: AgentTerminalCapabilityState = {
        state: 'unknown',
        mode: 'degraded',
        reason: outcome.reason === 'capability-query-timeout' ? 'handshake-timeout' : 'handshake-unconfirmed',
        ...(outcome.reason === 'handshake-unconfirmed' ? { diagnostic: {
          code: error instanceof AgentMuxError ? error.code : AGENT_TERMINAL_HANDSHAKE_UNCONFIRMED,
          message: error instanceof Error ? error.message : String(error)
        } } : {}),
        run: { ...requestedSession.run },
        observedAt
      }
      let next: AgentMuxStoredAgentSession
      let local: LocalSessionObservation | undefined
      try {
        next = await this.persistTerminalCapabilityState(requestedSession, degraded)
      } catch (error) {
        // The Store is an observability/continuity surface, not the Agent's input transport. A
        // transient lock, disk, or permission failure must not make create/resume roll back a Run
        // that CtxMux just proved is still running. Keep the marker for this call only, and report
        // that it cannot survive a restart. Identity/data conflicts remain fatal below: returning a
        // marker for a different Session would be worse than blocking honestly.
        if (
          error instanceof AgentMuxError &&
          ['STALE_AGENT_SESSION', 'UNKNOWN_AGENT_SESSION', 'STALE_AGENT_SESSION_BINDING',
            'AGENT_SESSION_BUSY', 'INVALID_AGENT_SESSION_STORE'].includes(error.code)
        ) {
          throw error
        }
        const canonical = this.requireAgentSession(requestedSession.agentSessionId)
        if (!sameRun(canonical.run, requestedSession.run)) {
          throw new AgentMuxError(
            'Agent Session changed while terminal capability degradation was being persisted.',
            'STALE_AGENT_SESSION'
          )
        }
        // A concurrent acknowledgement is stronger evidence than this timeout. Preserve it if the
        // Store did manage to apply that other write; only attach an ephemeral marker to an otherwise
        // unacknowledged canonical Session.
        next = canonical.terminalHandshake?.acknowledged
          ? canonical
          : {
              ...structuredClone(canonical),
              terminalCapability: structuredClone(degraded),
              updatedAt: Math.max(canonical.updatedAt, degraded.observedAt)
            }
        if (!canonical.terminalHandshake?.acknowledged) {
          local = 'terminalCapability'
          this.publisher.publish({
            type: 'agent-error',
            // Deliberately omit agentSessionId. The renderer's agent-error reducer treats a scoped
            // error as a semantic Agent failure; this is only a Store diagnostic and the Agent remains
            // healthy. The adjacent agent-session projection carries the actionable marker.
            code: AGENT_TERMINAL_CAPABILITY_PERSIST_FAILED,
            message: `Terminal capability degradation could not be persisted; continuing with an in-memory warning. ${
              error instanceof Error ? error.message : String(error)
            }`,
            evidence: {
              source: 'user',
              observedAt,
              run: { ...requestedSession.run }
            }
          })
        }
      }
      // The session event is the Core-owned projection seam consumed by Desktop. Do not surface this
      // as an ordinary agent-error: the Agent is still healthy and must not be painted as failed.
      this.publishSession(next, undefined, local)
      return next
    }
  }

  /**
   * Resolve the Run state after a degradable timeout. A stale `knownRun` must never turn an exited
   * Agent into a supposedly live degraded Session.
   */
  private async requireRunningTerminalHandshakeRun(
    session: AgentMuxStoredAgentSession
  ): Promise<CtxmuxAdapterRun> {
    let run: CtxmuxAdapterRun
    try {
      run = await this.kernel.status(session.run.runId)
    } catch (error) {
      // A timeout raced with Run removal. Keep this branch in the same fatal bucket as an observed
      // exited state; callers must not leak a transport-specific `run_not_found` through the
      // handshake contract or accidentally treat a missing Run as a healthy degraded Agent.
      if (error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found') {
        throw mapVanishedTerminalHandshakeRun(error)
      }
      throw error
    }
    this.assertAgentRun(session, run)
    if (run.state.type !== 'running') {
      throw new AgentMuxError(
        'Agent Run exited before its terminal capability query was observed.',
        AGENT_TERMINAL_HANDSHAKE_FAILED
      )
    }
    return run
  }

  private async persistTerminalCapabilityState(
    requestedSession: AgentMuxStoredAgentSession,
    degraded: AgentTerminalCapabilityState
  ): Promise<AgentMuxStoredAgentSession> {
    return await this.updateExactAgentSession(
      requestedSession.agentSessionId,
      requestedSession.run,
      (current) => {
        // A concurrent handshake may have acknowledged while the timeout was being classified. Its
        // receipt is stronger evidence; clear the stale degraded marker and preserve the receipt.
        if (current.terminalHandshake?.acknowledged) {
          if (!current.terminalCapability) return current
          const next = { ...current }
          delete next.terminalCapability
          return { ...next, updatedAt: Math.max(next.updatedAt, degraded.observedAt) }
        }
        if (
          current.terminalCapability &&
          current.terminalCapability.observedAt >= degraded.observedAt
        ) return current
        return {
          ...current,
          terminalCapability: structuredClone(degraded),
          updatedAt: Math.max(current.updatedAt, degraded.observedAt)
        }
      }
    )
  }

  private async clearTerminalCapability(
    requestedSession: AgentMuxStoredAgentSession
  ): Promise<AgentMuxStoredAgentSession> {
    if (!requestedSession.terminalCapability) return requestedSession
    const next = await this.updateExactAgentSession(
      requestedSession.agentSessionId,
      requestedSession.run,
      (current) => {
        if (!current.terminalCapability) return current
        const cleared = { ...current }
        delete cleared.terminalCapability
        return { ...cleared, updatedAt: Math.max(cleared.updatedAt, Date.now()) }
      }
    )
    if (next !== requestedSession) {
      this.publishSession(next)
    }
    return next
  }

  private async ensureTerminalHandshake(
    requestedSession: AgentMuxStoredAgentSession,
    knownRun?: CtxmuxAdapterRun
  ): Promise<AgentMuxStoredAgentSession> {
    const provider = this.providers.get(requestedSession.providerId)
    const handshake = provider.terminalHandshake
    if (!handshake) {
      if (knownRun?.acceptedInputBytes !== null && knownRun?.acceptedInputBytes !== undefined) {
        this.agentInputCursors.set(requestedSession.agentSessionId, knownRun.acceptedInputBytes)
      }
      return await this.clearTerminalCapability(
        this.requireAgentSession(requestedSession.agentSessionId)
      )
    }

    const session = this.requireAgentSession(requestedSession.agentSessionId)
    if (!sameRun(session.run, requestedSession.run)) {
      throw new AgentMuxError(
        'Agent Session changed before terminal handshake completed.',
        'STALE_AGENT_SESSION'
      )
    }
    // A prior timeout is durable evidence that this exact Run's capability is unknown. Do not arm a
    // second ten-second observer on every reconnect/prompt; the Run remains usable and its input
    // fencing is owned by CtxMux. A later Run gets a fresh field (resume clears it below).
    if (
      session.terminalCapability &&
      !session.terminalHandshake?.acknowledged
    ) {
      const cursor = degradedInputCursor(knownRun?.acceptedInputBytes)
      if (cursor !== undefined) this.agentInputCursors.set(session.agentSessionId, cursor)
      return session
    }
    const frontendReconnect = session.continuity?.frontendReconnect
    if (session.nativeActor?.frontendControl && !session.terminalHandshake) await this.observeInitialTerminalFrontend(session)
    const observedFrontend = this.terminalFrontendWatches.get(session.agentSessionId)?.frontend
    const frontendId = frontendReconnect?.frontendId ?? session.terminalHandshake?.frontendId ??
      (!session.terminalHandshake && observedFrontend && sameRun(observedFrontend.run, session.run) && observedFrontend.state !== 'unknown' ? observedFrontend.frontendId : undefined)
    const outputAfterByte = frontendReconnect?.frontendId ? frontendReconnect.outputAfterByte : session.terminalHandshake?.outputAfterByte ?? 0
    const operationId = terminalHandshakeOperationIdentity(
      session.providerId,
      session.run.runId,
      handshake,
      frontendId
    )
    const initialReadinessId = terminalInitialPromptReadinessIdentity(session, operationId)
    const responseBytes = Buffer.byteLength(handshake.response)
    const assertState = (value: NonNullable<AgentMuxAgentSession['terminalHandshake']>): void => {
      if (
        value.run.runId !== session.run.runId ||
        value.operationId !== operationId ||
        value.inputByteRange.endByte - value.inputByteRange.startByte !== responseBytes
      ) {
        throw new AgentMuxError(
          'Persisted terminal handshake does not match the Provider and exact Run.',
          'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
        )
      }
    }
    const observeReadiness = (current: AgentMuxStoredAgentSession): void => {
      if (!provider.terminalPromptRender) return
      const readiness = current.terminalPromptReadiness
      if (!readiness) return
      if (
        readiness.source === 'initial-composer' &&
        readiness.id !== initialReadinessId
      ) {
        throw new AgentMuxError(
          'Initial terminal prompt readiness does not match the Provider and exact Run.',
          'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
        )
      }
      // A native end can be consumed without a physical composer observation.
      if (readiness.readyThroughByte === undefined) {
        this.promptSubmission.observeReadiness(current, readiness)
      }
    }
    if (session.terminalHandshake) {
      assertState(session.terminalHandshake)
      if (session.terminalHandshake.acknowledged) {
        if (
          knownRun?.acceptedInputBytes !== null &&
          knownRun?.acceptedInputBytes !== undefined &&
          knownRun.acceptedInputBytes < session.terminalHandshake.inputByteRange.endByte
        ) {
          throw new AgentMuxError(
            'CtxMux Input cursor precedes the persisted terminal handshake receipt.',
            'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
          )
        }
        if (knownRun?.acceptedInputBytes !== null && knownRun?.acceptedInputBytes !== undefined) {
          this.agentInputCursors.set(session.agentSessionId, knownRun.acceptedInputBytes)
        }
        const readySession = session.terminalCapability
          ? await this.clearTerminalCapability(session)
          : session
        observeReadiness(readySession)
        return readySession
      }
      // A retained unacknowledged reply is not a new write. Later input cannot
      // acknowledge it, and changing its boundary would replay it after that input.
      const currentRun = await this.requireRunningTerminalHandshakeRun(session)
      if (currentRun.acceptedInputBytes !== session.terminalHandshake.inputByteRange.startByte) {
        throw new AgentMuxError(
          `The original terminal capability reply remains unconfirmed at input byte ${session.terminalHandshake.inputByteRange.startByte}; the exact Run is now at ${currentRun.acceptedInputBytes ?? 'unknown'}. Its original operation and receipt are retained without replay.`,
          AGENT_TERMINAL_HANDSHAKE_UNCONFIRMED
        )
      }
    }

    let startupOutput = ''
    let tail = ''
    let queryObserved = false
    let resolveQuery!: () => void
    let rejectQuery!: (error: Error) => void
    const query = new Promise<void>((resolve, reject) => {
      resolveQuery = resolve
      rejectQuery = reject
    })
    const observe = (data: string): void => {
      startupOutput = `${startupOutput}${data}`.slice(-8192)
      if (queryObserved) return
      const candidate = `${tail}${data}`
      if (candidate.includes(handshake.query)) {
        queryObserved = true
        resolveQuery()
        return
      }
      tail = candidate.slice(-Math.max(0, handshake.query.length - 1))
    }
    const unsubscribe = this.publisher.onEvent((event) => {
      if (frontendId) return // This generation uses its own scoped ordered observer below.
      if (event.type !== 'terminal-output' && event.type !== 'process-state') return
      if (event.run.runId !== session.run.runId) return
      if (event.type === 'terminal-output') {
        const range = event.evidence.outputByteRange
        if (range.endByte > outputAfterByte) observe(new TextDecoder().decode(event.dataBytes.subarray(Math.max(0, outputAfterByte - range.startByte))))
      } else if (event.state !== 'running') {
        rejectQuery(new AgentMuxError(
          'Agent Run exited before its terminal capability query was observed.',
          AGENT_TERMINAL_HANDSHAKE_FAILED
        ))
      }
    })
    const timer = setTimeout(() => {
      rejectQuery(new AgentMuxError(
        'Timed out waiting for the Provider terminal capability query.',
        AGENT_TERMINAL_HANDSHAKE_TIMEOUT
      ))
    }, TERMINAL_HANDSHAKE_TIMEOUT_MS)
    let attached = false
    let frontendObservation: Awaited<ReturnType<CtxmuxRunAdapter['observeOutput']>> | undefined
    try {
      // A live terminal already owns the client Attachment. Observe this bounded
      // handshake independently; never replace or detach that user's output lane.
      const attachment = frontendId
        ? frontendObservation = await this.kernel.observeOutput(session.run.runId, outputAfterByte, event => {
          if (event.type === 'data') observe(event.data)
          else if (event.type === 'exit') rejectQuery(new AgentMuxError('The original Run ended during frontend handshake.', AGENT_TERMINAL_HANDSHAKE_FAILED))
          else if (event.type === 'error') rejectQuery(event.error)
          else if (event.type === 'gap') rejectQuery(new AgentMuxError('The new frontend query observation has an output Gap. The original Run and input are retained.', AGENT_TERMINAL_HANDSHAKE_UNCONFIRMED))
        })
        : await this.kernel.attach(session.run.runId, outputAfterByte)
      attached = !frontendId
      for (const event of attachment.replay) observe(event.data)
      this.assertAgentRun(session, attachment.run)
      if (!queryObserved && attachment.run.state.type !== 'running') {
        rejectQuery(terminalHandshakeExitError(attachment.run, startupOutput))
      }
      if (!queryObserved) await query

      // Query observation must stay outside the input lane: native protocol
      // replies are themselves input. Only claim/write/receipt serialize here.
      return await this.serializeAgentInput(session, async (_current, boundaryRun) => {
        const startByte = boundaryRun.acceptedInputBytes
        if (startByte === null) {
          throw new AgentMuxError(
            'CtxMux omitted its accepted Input byte cursor.',
            'CTXMUX_INPUT_CURSOR_MISSING'
          )
        }

        const claimHandshake = (current: AgentMuxStoredAgentSession): AgentMuxStoredAgentSession => {
          if (current.terminalHandshake) {
            assertState(current.terminalHandshake)
            return current
          }
          let initialReadiness = current.terminalPromptReadiness?.source === 'initial-composer'
            ? current.terminalPromptReadiness
            : undefined
          // The original unopened composer was prepared before its generation existed.
          // Bind only that unconsumed intent alongside this new exact query claim;
          // an existing ACK or any consumed readiness is never rewritten.
          if (frontendId && initialReadiness && initialReadiness.readyThroughByte === undefined &&
              initialReadiness.consumedBySubmissionId === undefined && initialReadiness.id === terminalInitialPromptReadinessIdentity(current,
                terminalHandshakeOperationIdentity(current.providerId, current.run.runId, handshake))) {
            initialReadiness = { ...initialReadiness, id: initialReadinessId }
          }
          if (
            initialReadiness &&
            (
              initialReadiness.id !== initialReadinessId ||
              initialReadiness.readyThroughByte !== undefined ||
              initialReadiness.consumedBySubmissionId !== undefined
            )
          ) {
            throw new AgentMuxError(
              'Initial terminal prompt readiness is invalid before handshake acknowledgement.',
              'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
            )
          }
          const next: AgentMuxStoredAgentSession = {
            ...current,
            terminalHandshake: {
              run: { ...current.run },
              operationId,
              ...(frontendId ? { frontendId, outputAfterByte } : {}),
              inputByteRange: {
                startByte,
                endByte: startByte + responseBytes
              },
              acknowledged: false
            },
            ...(initialReadiness
              ? {
                  terminalPromptReadiness: {
                    ...initialReadiness,
                    outputCursorBytes: boundaryRun.latestOutputBytes
                  }
                }
              : {}),
            updatedAt: Date.now()
          }
          delete next.terminalCapability
          return next
        }
        let claimed: AgentMuxStoredAgentSession
        try {
          claimed = await this.registry.update(
            session.agentSessionId,
            session.run,
            claimHandshake
          )
        } catch (error) {
          if (!(error instanceof AgentMuxError) || error.code !== 'STALE_AGENT_SESSION') throw error
          await this.registry.load(session.hostId)
          const canonical = this.requireAgentSession(session.agentSessionId)
          if (!sameRun(canonical.run, session.run)) {
            throw new AgentMuxError(
              'Agent Session changed while adopting its terminal handshake.',
              'STALE_AGENT_SESSION'
            )
          }
          claimed = canonical.terminalHandshake
            ? canonical
            : await this.registry.update(
                session.agentSessionId,
                session.run,
                claimHandshake
              )
        }
        const state = claimed.terminalHandshake
        if (!state) {
          throw new AgentMuxError(
            'Terminal handshake claim was not persisted.',
            'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
          )
        }
        assertState(state)
        if (state.acknowledged) {
          const currentRun = await this.kernel.status(session.run.runId)
          this.assertAgentRun(session, currentRun)
          const acceptedInputBytes = currentRun.acceptedInputBytes
          if (acceptedInputBytes === null || acceptedInputBytes < state.inputByteRange.endByte) {
            throw new AgentMuxError(
              'CtxMux Input cursor precedes the persisted terminal handshake receipt.',
              'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
            )
          }
          this.agentInputCursors.set(session.agentSessionId, acceptedInputBytes)
          observeReadiness(claimed)
          return claimed
        }

        const accepted = await this.kernel.input(session.run.runId, {
          ownerInstanceId: this.kernel.identity().daemonInstanceId,
          operationId: state.operationId,
          expectedByte: state.inputByteRange.startByte,
          data: handshake.response
        })
        if (
          accepted.appliedByteRange.startByte !== state.inputByteRange.startByte ||
          accepted.appliedByteRange.endByte !== state.inputByteRange.endByte ||
          accepted.run.acceptedInputBytes === null ||
          accepted.run.acceptedInputBytes < state.inputByteRange.endByte
        ) {
          throw new AgentMuxError(
            'CtxMux terminal handshake receipt does not match the persisted Input claim.',
            'AGENT_TERMINAL_HANDSHAKE_RECEIPT_MISMATCH'
          )
        }
        const acknowledgeHandshake = (
          current: AgentMuxStoredAgentSession
        ): AgentMuxStoredAgentSession => {
          if (!current.terminalHandshake) {
            throw new AgentMuxError(
              'Terminal handshake claim disappeared before acknowledgement.',
              'AGENT_TERMINAL_HANDSHAKE_STATE_INVALID'
            )
          }
          assertState(current.terminalHandshake)
          if (current.terminalHandshake.acknowledged) return current
          const next: AgentMuxStoredAgentSession = {
            ...current,
            terminalHandshake: {
              ...current.terminalHandshake,
              acknowledged: true
            },
            updatedAt: Date.now()
          }
          delete next.terminalCapability
          return next
        }
        let ready: AgentMuxStoredAgentSession
        try {
          ready = await this.registry.update(
            session.agentSessionId,
            session.run,
            acknowledgeHandshake
          )
        } catch (error) {
          if (!(error instanceof AgentMuxError) || error.code !== 'STALE_AGENT_SESSION') throw error
          await this.registry.load(session.hostId)
          const canonical = this.requireAgentSession(session.agentSessionId)
          if (!sameRun(canonical.run, session.run)) {
            throw new AgentMuxError(
              'Agent Session changed while adopting its terminal handshake acknowledgement.',
              'STALE_AGENT_SESSION'
            )
          }
          ready = canonical.terminalHandshake?.acknowledged
            ? canonical
            : await this.registry.update(
                session.agentSessionId,
                session.run,
                acknowledgeHandshake
              )
        }
        this.agentInputCursors.set(session.agentSessionId, accepted.run.acceptedInputBytes)
        observeReadiness(ready)
        return ready
      }, { kind: 'protocol', bytes: responseBytes })
    } catch (error) {
      if (error instanceof AgentMuxError && (
        error.code === AGENT_TERMINAL_HANDSHAKE_FAILED ||
        error.code === AGENT_TERMINAL_HANDSHAKE_TIMEOUT ||
        error.code === 'STALE_AGENT_SESSION'
      )) {
        // Reuse this handshake's Attachment; never attach another live consumer for diagnostics.
        // A failed state read cannot replace the original failure with a guessed exit fact.
        let exitedRun: CtxmuxAdapterRun | undefined
        try {
          const observed = await this.kernel.status(session.run.runId)
          this.assertAgentRun(session, observed)
          if (observed.state.type !== 'running') exitedRun = observed
        } catch {}
        if (exitedRun) throw terminalHandshakeExitError(exitedRun, startupOutput)
      }
      throw error
    } finally {
      clearTimeout(timer)
      unsubscribe()
      await frontendObservation?.close().catch(() => {})
      if (attached) {
        try {
          await this.kernel.detach(session.run.runId)
        } catch {}
      }
    }
  }

  private async recordPromptMessageAfterSideEffect(
    session: AgentMuxAgentSession,
    operationId: string,
    title: string,
    message: AgentPromptMessageContent,
    status: 'complete' | 'failed' = 'complete',
    inputRef?: AgentPromptInputKey
  ): Promise<void> {
    const now = Date.now()
    if (message.systemContext) await this.recordMessageAfterSideEffect(session, `system-context:${operationId}`,
      'AgentMux context', message.systemContext, now, 'agentmux', { status, ...(message.a2aNotificationId ? { a2aNotificationId: message.a2aNotificationId, ...(inputRef ? { inputRef } : {}) } : {}) })
    if (message.userContent && message.authorExternal && inputRef?.kind === 'message') {
      const evidence = { source: 'user' as const, observedAt: now, run: session.run }
      try {
        const saved = await this.messageQueue.inspectInput({ key: inputRef })
        if (saved?.intent.source.kind === 'message') {
          const receipt = await this.inspectAgentInput({ key: inputRef })
          if (receipt) await this.publishInputReceipt(receipt)
          return
        }
        const submitted = await this.messageQueue.readByMessageId(inputRef.messageId)
        if (!submitted || submitted.envelope.sender.kind !== 'external' || !isDeepStrictEqual(submitted.envelope.sender, message.authorExternal)) throw new AgentMuxError('Submitted input does not match its original external author.', 'EXTERNAL_RECORD_CONFLICT')
        const recordId = externalConversationRecordId(message.authorExternal), original = (await this.store.readCapturedHistory(session.agentSessionId, { recordId })).records[0]
        if (original && (original.item.content !== submitted.envelope.body || !original.item.authorExternal || !isDeepStrictEqual(externalConversationAuthor(original.item.authorExternal), externalConversationAuthor(message.authorExternal)))) throw new AgentMuxError('Submitted input does not match the original recorded group message.', 'EXTERNAL_RECORD_CONFLICT')
        const item: AgentTimelineItem = original?.item ?? { id: recordId, agentSessionId: session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', createdAt: now, updatedAt: now, title: 'External message', content: submitted.envelope.body, publicContent: 'confirmed', authorExternal: message.authorExternal, ...(message.sourceChannel ? { sourceChannel: message.sourceChannel } : {}) }
        await this.persistAndPublishTimeline({ type: 'upsert', agentSessionId: session.agentSessionId, item: { ...item, inputRef, updatedAt: now } }, { source: 'user', observedAt: now, run: session.run }, session.hostId)
      } catch (error) {
        this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
          code: error instanceof AgentMuxError ? error.code : 'AGENT_TIMELINE_PERSIST_FAILED',
          message: error instanceof Error ? error.message : String(error), evidence })
      }
      return
    }
    if (message.userContent && message.authorHuman && inputRef?.kind === 'prompt') {
      try {
        const saved = await this.messageQueue.inspectInput({ key: inputRef })
        if (saved?.intent.source.kind === 'prompt' && saved.intent.source.authorHuman === true) {
          const receipt = await this.inspectAgentInput({ key: inputRef })
          if (receipt) await this.publishInputReceipt(receipt)
          return
        }
      } catch (error) { this.publishInputConversationFailure(inputRef, error); return }
    }
    if (message.userContent) await this.recordMessageAfterSideEffect(session, `prompt:${operationId}`,
      title, message.userContent, now, 'user', { status, publicContent: 'confirmed', ...(inputRef ? { inputRef } : {}),
        ...(message.inputContext ? { inputContext: message.inputContext, inputContextSource: message.inputContextSource, ...(message.inputContextCaptureProof ? { inputContextCaptureProof: message.inputContextCaptureProof } : {}) } : {}),
        ...(message.authorAgentSessionId ? { authorAgentSessionId: message.authorAgentSessionId } : {}),
        ...(message.authorHuman ? { authorHuman: true } : {}),
        ...(message.authorExternal ? { authorExternal: message.authorExternal } : {}),
        ...(message.sourceDevice ? { sourceDevice: message.sourceDevice } : {}),
        ...(message.sourceChannel ? { sourceChannel: message.sourceChannel } : {}) })
  }

  /** Append authenticated platform observation to the original history; never dispatch or wake a Run. */
  async recordExternalConversationMessage(value: AgentExternalConversationReference): Promise<AgentExternalConversationReceipt> {
    const input = parseExternalConversationReference(value)
    return await this.serializeInputConversationWrite(JSON.stringify(['external-record', input.agentSessionId]), () => this.recordExternalConversationMessageNow(input))
  }

  private async recordExternalConversationMessageNow(value: AgentExternalConversationReference): Promise<AgentExternalConversationReceipt> {
    const owner = this.externalConversationAuthority
    const input = parseExternalConversationReference(value)
    if (!owner) throw new AgentMuxError('The original external conversation owner is unavailable. Retain the original message; local input remains available.', 'EXTERNAL_RECORD_AUTHORITY_UNAVAILABLE')
    const observed = parseExternalConversationAuthority(await owner.resolveConversationMessage(input)), message = observed.message
    if (!message || message.agentSessionId !== input.agentSessionId || message.ingressId !== input.ingressId || !isDeepStrictEqual(message.authoritySource, input.authoritySource)) throw new AgentMuxError('The original external conversation target is unconfirmed.', 'EXTERNAL_RECORD_TARGET_UNCONFIRMED')
    const session = await this.currentStoredAgentSession(input.agentSessionId)
    if (message.hostId !== session.hostId) throw new AgentMuxError('The original message belongs to another Host.', 'EXTERNAL_RECORD_TARGET_UNCONFIRMED')
    const recordId = externalConversationRecordId(message.author), page = await this.store.readCapturedHistory(input.agentSessionId, { recordId }), existing = page.records[0]
    const receipt = (revision: string): AgentExternalConversationReceipt => ({ ...input, record: { hostId: session.hostId, agentSessionId: input.agentSessionId, source: { kind: 'captured', recordId } }, revision })
    if (existing) {
      if (existing.item.content !== message.body || !existing.item.authorExternal || !isDeepStrictEqual(externalConversationAuthor(existing.item.authorExternal), message.author)) throw new AgentMuxError('The original external message conflicts with retained content.', 'EXTERNAL_RECORD_CONFLICT')
      if (!message.inputMetadata || isDeepStrictEqual(existing.item.externalInput, message.inputMetadata)) return receipt(existing.revision)
      const now = Math.max(Date.now(), existing.item.updatedAt), commit = await this.store.applyTimelineMutation({ type: 'upsert', agentSessionId: input.agentSessionId,
        item: { ...existing.item, externalInput: message.inputMetadata, updatedAt: now } })
      if (commit.changed) this.publisher.publishTimeline(commit, { source: 'user', observedAt: now, run: session.run }, session.hostId)
      return receipt(commit.position.revision)
    }
    const current = parseExternalConversationAuthority(await owner.resolveConversationMessage(input))
    if (current.authority !== 'current' || !isDeepStrictEqual({ ...current.message, inputMetadata: undefined }, { ...message, inputMetadata: undefined })) throw new AgentMuxError('This original group relationship cannot admit a new conversation record. Its source and local Agent remain available.', current.code ?? 'EXTERNAL_RECORD_AUTHORITY_UNAVAILABLE')
    const now = Date.now(), mutation: AgentTimelineMutation = { type: 'append', agentSessionId: input.agentSessionId, item: {
      id: recordId, agentSessionId: input.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', createdAt: now, updatedAt: now,
      title: 'Group message', content: message.body, publicContent: 'confirmed', authorExternal: message.author, sourceChannel: 'agent-message',
      ...(current.message?.inputMetadata ? { externalInput: current.message.inputMetadata } : {})
    } }
    const commit = await this.store.applyTimelineMutation(mutation)
    if (commit.changed) this.publisher.publishTimeline(commit, { source: 'user', observedAt: now, run: session.run }, session.hostId)
    return receipt(commit.position.revision)
  }

  /** Transport owner records an operation on its exact Session without duplicating Runtime state. */
  async recordDeviceOperation(agentSessionId: string, operationId: string, method: string,
    sourceDevice: import('./types.js').AgentOperationDevice, result: 'confirmed' | 'failed' | 'unknown'): Promise<void> {
    const session = this.requireAgentSession(agentSessionId)
    await this.recordMessageAfterSideEffect(session, `device-operation:${operationId}`, '设备操作',
      `${method} · ${result === 'confirmed' ? '已提交' : result === 'failed' ? '失败' : '结果未确认'}`,
      Date.now(), 'agentmux', { sourceDevice, ...(result === 'failed' ? { status: 'failed' as const } : {}) })
  }

  private async recordMessageAfterSideEffect(
    session: AgentMuxAgentSession,
    itemId: string,
    title: string,
    content: string,
    observedAt: number,
    source: 'user' | 'agentmux',
    delivery: { a2aNotificationId?: string; sourceDevice?: import('./types.js').AgentOperationDevice; sourceChannel?: import('./types.js').AgentMessageChannel; authorAgentSessionId?: string; authorHuman?: boolean; authorExternal?: import('./external-author.js').AgentExternalMessageAuthor; status?: 'complete' | 'failed'; publicContent?: 'confirmed'; inputRef?: AgentPromptInputKey;
      inputContext?: import('./browser-input-context.js').BrowserInputContext; inputContextSource?: import('./browser-input-context.js').BrowserInputContextSource; inputContextCaptureProof?: AgentInputContextCaptureProof } = {}
  ): Promise<void> {
    const mutation: AgentTimelineMutation = {
      type: 'append',
      agentSessionId: session.agentSessionId,
      item: {
        id: itemId,
        agentSessionId: session.agentSessionId,
        kind: source === 'agentmux' ? 'system_message' : 'user_message',
        status: delivery.status ?? 'complete',
        source,
        createdAt: observedAt,
        updatedAt: observedAt,
        title,
        content,
        ...(source === 'agentmux' && delivery.a2aNotificationId ? { a2aNotificationId: delivery.a2aNotificationId } : {}),
        ...(source === 'user' && delivery.inputContext ? { inputContext: delivery.inputContext, ...(delivery.inputContextSource ? { inputContextSource: delivery.inputContextSource } : {}), ...(delivery.inputContextCaptureProof ? { inputContextCaptureProof: delivery.inputContextCaptureProof } : {}) } : {}),
        ...(source === 'user' && delivery.publicContent ? { publicContent: delivery.publicContent } : {}),
        ...((source === 'user' || delivery.a2aNotificationId !== undefined) && delivery.inputRef ? { inputRef: delivery.inputRef } : {}),
        ...(delivery.sourceDevice ? { sourceDevice: delivery.sourceDevice } : {}),
        ...(delivery.sourceChannel ? { sourceChannel: delivery.sourceChannel } : {}),
        ...(source === 'user' && delivery.authorExternal ? { authorExternal: delivery.authorExternal } : {}),
        ...(source === 'user' && delivery.authorAgentSessionId
          ? { authorAgentSessionId: delivery.authorAgentSessionId }
          : source === 'user' && delivery.authorAgentSessionId === undefined && delivery.authorHuman === true
            ? { authorHuman: true }
            : {})
      }
    }
    const evidence = { source, observedAt, run: { ...session.run } }
    try {
      await this.persistAndPublishTimeline(mutation, evidence, session.hostId)
    } catch (error) {
      this.publisher.publish({
        type: 'agent-error',
        agentSessionId: session.agentSessionId,
        code: error instanceof AgentMuxError ? error.code : 'AGENT_TIMELINE_PERSIST_FAILED',
        message: error instanceof Error ? error.message : String(error),
        evidence
      })
    }
  }

  /**
   * `post-launch-only` 的 Provider：启动期送不到的那份文本，在进程起来之后按一条普通 turn 键入。
   *
   * 为什么必须存在：这类 CLI 的交互 UI 没有「带着一条 prompt 启动并继续活着」的入口（出处见对应
   * Provider 模块），于是 `buildLaunch`/`buildResumeLaunch` 会当场拒绝任何启动期 prompt。若只到
   * 「不交给 buildLaunch」就收手，用户的原话就只落进时间轴、永不进入进程——正是 `promptDelivery`
   * 这条轴要消灭的那类静默丢失，只是换了个地方发生。所以两条生命周期路径都必须走到这里。
   *
   * 失败要说出来而不是吞掉：进程已经起来了，抛出去会让调用方以为整次启动失败（并触发它的回滚），
   * 但沉默会让界面看起来一切正常而投递结果未知。于是发 `agent-error`——Run 保留，用户被
   * 告知确认未完成，先检查 Agent 回复再决定是否重投。返回值让调用方按真实结果记录历史。
   */
  private postLaunchPromptConfirmed(record: import('./types.js').AgentPromptSubmissionRecord | null,
    text: string, message: AgentPromptMessageContent): boolean {
    const claim = record?.admission
    return Boolean(claim?.acknowledged && (claim.transport !== 'native' || claim.native.outcome === 'admitted') && claim.intent?.prompt === text &&
      isDeepStrictEqual(claim.intent.message, message))
  }

  /** Creation authority is local to this original input; it never gates ordinary Agent input. */
  private async assertCreationInputCurrent(original: AgentMuxStoredAgentSession, run: CtxmuxAdapterRun): Promise<void> {
    const refused = () => new AgentMuxError('The original creation input owner changed or its Run was stopped. No initial input was dispatched.',
      'AGENT_INITIAL_INPUT_SUPERSEDED', undefined, { disposition: 'not_applied', confirmedInputBytes: 0 })
    const current = await this.store.readMetadata(original.agentSessionId), input = original.initialInput
    if (!current || !input?.key || !sameRun(current.run, original.run) || current.run.runId !== run.runId ||
        current.hostId !== original.hostId || current.providerId !== original.providerId || current.executorId !== original.executorId ||
        current.workspacePath !== original.workspacePath || current.capabilityHash !== original.capabilityHash ||
        original.nativeActor && !isDeepStrictEqual(current.nativeActor, original.nativeActor) ||
        !isDeepStrictEqual(current.initialInput?.key, input.key) || current.initialInput?.digest !== input.digest ||
        !isDeepStrictEqual(current.initialInput?.message, input.message)) throw refused()
    const lifecycle = await this.store.readLifecycleReservation(current.agentSessionId)
    if (lifecycle?.kind === 'stop' && sameRun(lifecycle.expectedRun, current.run)) throw refused()
    const live = await this.kernel.status(run.runId)
    this.assertAgentRun(current, live)
    if (live.state.type !== 'running' || live.pid !== run.pid) throw refused()
  }

  /** Continue only the original input owner. Native recovery decisions stay in the recovery service. */
  private async continueInitialInput(session: AgentMuxStoredAgentSession, run: CtxmuxAdapterRun,
    assertCurrent?: () => Promise<void>): Promise<AgentMuxStoredAgentSession> {
    let current = await this.registry.refresh(session.agentSessionId, session.run)
    const input = current.initialInput
    if (!input?.key || !sameRun(current.run, session.run) ||
        input.key.expectedRun.runId !== run.runId || current.run.runId !== run.runId) return current
    if (input.delivery === 'launch') {
      if (input.state !== 'launch-carried' || input.receipt?.run.runId !== run.runId || input.receipt.operationId !== input.lifecycleOperationId) return current
      return await this.updateExactAgentSession(current.agentSessionId, current.run, saved => ({ ...saved,
        creation: { ...saved.creation!, initialPrompt: saved.creation!.initialPrompt === 'not-requested' ? 'not-requested' : 'confirmed',
          ...(input.message.systemContext ? { agentMuxContext: 'confirmed' as const } : {}) }, updatedAt: Math.max(Date.now(), saved.updatedAt + 1) }))
    }
    let record = await this.inspectAgentPromptSubmission(input.key)
    if (!record && input.state === 'prepared' && run.state.type === 'running') {
      let nativeSource: { providerId: string; nativeSessionId: string } | undefined
      if (current.nativeActor?.initializationControl) {
        // Opening this existing read-only observer does not create a claim. Failure,
        // unknown or a confirmed native object still awaiting persistence stays prepared.
        await this.ensureTerminalFrontendObservation(current)
        current = await this.registry.refresh(current.agentSessionId, current.run)
        const frontend = this.terminalFrontendWatches.get(current.agentSessionId)?.frontend
        const initialization = frontend?.initialization, handle = current.nativeHandle
        if (!frontend || !sameRun(frontend.run, current.run) || initialization?.phase !== 'ready' ||
            initialization.lifecycleOperationId !== input.lifecycleOperationId || initialization.native.state !== 'confirmed' ||
            handle?.kind !== 'provider' || handle.providerId !== current.providerId || handle.sessionId !== initialization.native.sessionId) return current
        nativeSource = { providerId: handle.providerId, nativeSessionId: handle.sessionId }
      }
      await this.deliverPostLaunchPrompt(this.providers.get(current.providerId), current, run, input.lifecycleOperationId,
        input.prompt, input.message, input.key.submissionId, nativeSource, assertCurrent)
      record = await this.inspectAgentPromptSubmission(input.key)
    }
    // Absence of a receipt is absence of knowledge, never a possibly-applied claim.
    if (!record) return current
    const matches = isDeepStrictEqual(record.admission?.inputKey, input.key) &&
      record.admission?.intent?.prompt === input.prompt && isDeepStrictEqual(record.admission.intent.message, input.message)
    const accepted = matches && this.postLaunchPromptConfirmed(record, input.prompt, input.message)
    const notApplied = matches && agentPromptNotApplied({ run: record.run, ...(record.admission ? { promptCompletionAdmission: record.admission } : {}),
      ...(record.terminalPromptSubmission ? { terminalPromptSubmission: record.terminalPromptSubmission } : {}) }) !== undefined
    const state = accepted ? record.admission?.transport === 'native' ? 'native-admitted' : 'terminal-confirmed' : notApplied ? 'not-applied' : 'unknown'
    const next = await this.updateExactAgentSession(current.agentSessionId, current.run, saved => {
      if (!isDeepStrictEqual(saved.initialInput?.key, input.key) || saved.initialInput?.digest !== input.digest) throw new AgentMuxError(
        'The original creation input changed before its receipt was saved.', 'AGENT_PROMPT_OPERATION_CONFLICT')
      const creation = saved.creation && { ...saved.creation,
        initialPrompt: saved.creation.initialPrompt === 'not-requested' ? 'not-requested' as const : accepted ? 'confirmed' as const : 'unconfirmed' as const,
        ...(input.message.systemContext ? { agentMuxContext: accepted ? 'confirmed' as const : 'unconfirmed' as const } : {}) }
      if (saved.initialInput.state === state && isDeepStrictEqual(saved.creation, creation)) return saved
      return { ...saved, initialInput: { ...saved.initialInput, state }, ...(creation ? { creation } : {}), updatedAt: Math.max(Date.now(), saved.updatedAt + 1) }
    })
    this.publishSession(next)
    return next
  }

  private async deliverPostLaunchPrompt(
    provider: AgentProvider,
    session: AgentMuxAgentSession,
    run: CtxmuxAdapterRun,
    lifecycleOperationId: string,
    text: string,
    message: AgentPromptMessageContent,
    originalSubmissionId?: string,
    nativeSource?: { providerId: string; nativeSessionId: string },
    assertCurrent?: () => Promise<void>
  ): Promise<boolean> {
    if (!text.trim()) return true
    const originalKey = originalSubmissionId ? { kind: 'prompt' as const, agentSessionId: session.agentSessionId, expectedRun: session.run, submissionId: originalSubmissionId } : undefined
    try {
      if (originalKey) {
        const record = await this.inspectAgentPromptSubmission(originalKey)
        if (record) return this.postLaunchPromptConfirmed(record, text, message)
      }
      // 走 serializeAgentInput，与 submitAgentPrompt 同一条队列——**不是**直接 submitInputPlan。
      // 理由是可复现的竞争：session 在这之前已经 publish 过 `agent-session`，渲染端此刻 composer
      // 就绪，用户可以在这次 await 返回前自己提交一条。两条 submitInputPlan 并发时 single-phase
      // 分支会读到同一个 expectedByte（prompt-submission.ts 的游标），daemon 的字节栅栏保证不错位，
      // 于是不是数据损坏，而是：谁先到无保证（这条本该是第一条 turn），且落后的那条拿到
      // receipt-mismatch——用户手动那条会把错误抛给调用方。排进同一条 input tail 就没有这个窗口。
      //
      // 注意 operation 收到的 session/run 是队列**当下**重取的，不是外面这两个快照：那正是
      // serializeAgentInput 的用处（它顺带验 run 没被换掉、进程还在跑）。所以这里用 current/live。
      const renderObservation = new AbortController()
      await this.serializeAgentInput(session, async (current, live) => {
        await this.promptSubmission.submitInputPlan(
          current,
          live,
          originalSubmissionId ?? `launch-prompt:${lifecycleOperationId}`,
          text,
          provider.planPromptInput(text),
          originalKey ? { expectedRun: session.run, afterSubmissionId: null } : agentPromptCondition(session),
          undefined,
          undefined,
          false,
          renderObservation.signal,
          undefined,
          message,
          undefined, undefined, undefined, undefined, originalKey,
          originalKey || nativeSource || assertCurrent ? { ...(originalKey ? { onlyIfUnclaimed: true } : {}),
            ...(nativeSource ? { requiredNativeSource: nativeSource } : {}), ...(assertCurrent ? { authority: { assertCurrent } } : {}) } : undefined
        )
      }, { kind: 'semantic', bytes: null }, { renderObservation })
      return originalKey ? this.postLaunchPromptConfirmed(await this.inspectAgentPromptSubmission(originalKey), text, message) : true
    } catch (error) {
      if (originalKey) {
        try { if (this.postLaunchPromptConfirmed(await this.inspectAgentPromptSubmission(originalKey), text, message)) return true }
        catch { /* Keep the original unknown input and its observable failure below. */ }
      }
      // publish 本身若抛，异常会穿出这个方法，而调用点在 create/resume 的 try 内、且在内层 rollback
      // catch 之后——于是 Run 活着、hookBinding 已注册，调用方却收到「启动失败」。这个方法的合同是
      // **绝不抛**（进程已经起来了），所以兜到底。
      try {
        this.publisher.publish({
          type: 'agent-error',
          agentSessionId: session.agentSessionId,
          code: error instanceof AgentMuxError ? error.code : 'AGENT_LAUNCH_PROMPT_UNDELIVERED',
          message: `${provider.label} started, but delivery of its initial prompt was not confirmed. Check its response before submitting again.`,
          evidence: { source: 'user', observedAt: Date.now(), run: { ...session.run } }
        })
      } catch {
        // 连告知都发不出去时也不能把已经起来的 Run 拖成一次失败的启动。
      }
      return false
    }
  }

  private async updateExactAgentSession(
    agentSessionId: string,
    expectedRun: AgentMuxRunRef,
    update: (current: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession,
    futureIntentId?: string,
    author?: Readonly<AgentCapabilityBinding>
  ): Promise<AgentMuxStoredAgentSession> {
    try {
      return await this.registry.update(agentSessionId, expectedRun, update, undefined, futureIntentId, author)
    } catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'STALE_AGENT_SESSION') throw error
      const canonical = await this.registry.refresh(agentSessionId, expectedRun)
      if (!sameRun(canonical.run, expectedRun)) {
        throw new AgentMuxError('Agent Session changed while semantic state was persisted.', 'STALE_AGENT_SESSION')
      }
      return await this.registry.update(agentSessionId, expectedRun, update, undefined, futureIntentId, author)
    }
  }

  private publishNativeStatusFailure(session: AgentMuxStoredAgentSession | AgentMuxAgentSession, error: unknown): void {
    if (this.reopensDisposed || this.registry.findByRun(session.run)?.agentSessionId !== session.agentSessionId) return
    this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
      code: error instanceof AgentMuxError ? error.code : 'AGENT_NATIVE_STATUS_UNAVAILABLE',
      message: `${error instanceof Error ? error.message : 'Native status observation is unavailable.'} The retained Session, Run and input remain available. Inspect the Session to retry observation.`,
      evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } })
  }

  private async ensureTerminalFrontendObservation(session: AgentMuxStoredAgentSession | AgentMuxAgentSession): Promise<boolean> {
    if (this.reopensDisposed) return false
    const current = this.registry.findByRun(session.run), provider = this.providers.get(session.providerId)
    if (!current?.nativeActor?.frontendControl || !provider.observeTerminalFrontend) return true
    const key = JSON.stringify([session.run.runId, current.nativeActor])
    const existing = this.terminalFrontendWatches.get(session.agentSessionId)
    if (existing?.key === key && !existing.controller.signal.aborted) return await existing.pending
    existing?.controller.abort()
    const watch: TerminalFrontendWatch = {
      key, controller: new AbortController(), pending: Promise.resolve(false), failures: 0,
      ready: new Set()
    }
    this.terminalFrontendWatches.set(session.agentSessionId, watch)
    const live = (): boolean => {
      const latest = this.registry.findByRun(session.run)
      return !watch.controller.signal.aborted && this.terminalFrontendWatches.get(session.agentSessionId) === watch &&
        latest?.agentSessionId === session.agentSessionId && JSON.stringify([latest.run.runId, latest.nativeActor]) === key
    }
    watch.controller.signal.addEventListener('abort', () => {
      if (watch.retry) clearTimeout(watch.retry)
      watch.attempt?.abort(); watch.observer?.dispose()
    }, { once: true })
    const retry = (): void => {
      if (!live() || watch.retry) return
      const delay = Math.min(5000, 250 * 2 ** Math.min(watch.failures++, 5))
      watch.retry = setTimeout(() => {
        delete watch.retry
        if (!live()) { watch.controller.abort(); return }
        watch.pending = attempt()
      }, delay)
      watch.retry.unref?.()
    }
    const attempt = async (): Promise<boolean> => {
      watch.attempt?.abort(); watch.observer?.dispose(); delete watch.observer
      const controller = new AbortController(); watch.attempt = controller
      const active = (): boolean => live() && watch.attempt === controller && !controller.signal.aborted
      const unavailable = (message: string): void => {
        if (!active()) return
        watch.frontend = { run: { ...session.run }, frontendId: watch.frontend?.frontendId ?? current.nativeActor!.actorId,
          state: 'unknown', backendState: 'unknown', source: 'managed-process', observedAt: Date.now(), message }
        controller.abort(); watch.observer?.dispose(); delete watch.observer
        this.publishSession(current); this.recovery.wake(session.agentSessionId)
        retry()
      }
      const openingTimer = setTimeout(() => unavailable('The original frontend reader did not finish opening. The Session, Run and input remain available.'),
        TERMINAL_HANDSHAKE_TIMEOUT_MS)
      try {
        const run = await observePromptInput(controller.signal, () => this.requireCurrentAgentRun(current))
        if (!active()) return false
        if (run.state.type !== 'running' || !run.pid) { watch.controller.abort(); return false }
        // Dispose a late subscription too: cancellation never waits for a Provider reader.
        const opening = provider.observeTerminalFrontend!({ processId: run.pid, nativeActor: current.nativeActor!, workspacePath: current.workspacePath,
          signal: controller.signal, onUnavailable: unavailable, onFrontend: value => {
            if (!active()) return
            const observation = parseTerminalFrontendObservation(value)
            if (watch.frontend && watch.frontend.state !== 'unknown' && observation.observedAt < watch.frontend.observedAt) return
            watch.frontend = { ...observation, run: { ...session.run } }
            // Record only this accepted original observation, never status projection
            // or a new probe. Journal failure cannot change the live business state.
            this.startupDiagnostics.observe(this.registry.get(session.agentSessionId), observation)
            if (observation.state !== 'unknown') { watch.failures = 0; for (const ready of watch.ready) ready() }
            if (observation.state === 'detached') this.promptSubmission.cancelReadiness(session.agentSessionId)
            this.publishSession(current)
            // Every new exact fact can reawaken a paused original observation.
            this.recovery.observe(this.registry.get(session.agentSessionId), true)
            this.recovery.wake(session.agentSessionId)
          } })
        void opening.then(observer => { if (!active()) observer.dispose() }, () => {})
        const observer = await observePromptInput(controller.signal, () => opening)
        if (!active()) { observer.dispose(); return false }
        watch.observer = observer
        return true
      } catch (error) { unavailable(error instanceof Error ? error.message : String(error)); return false }
      finally { clearTimeout(openingTimer) }
    }
    watch.pending = attempt()
    return await watch.pending
  }

  private async observeInitialTerminalFrontend(session: AgentMuxStoredAgentSession): Promise<void> {
    // The one bounded handshake observation includes establishing the Provider reader.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new AgentMuxError(
      'The original frontend generation is still unconfirmed. Its Run and ordinary input remain available.',
      AGENT_TERMINAL_HANDSHAKE_TIMEOUT)), TERMINAL_HANDSHAKE_TIMEOUT_MS)
    let watch: TerminalFrontendWatch | undefined, ready!: () => void
    const abort = (): void => controller.abort(watch?.controller.signal.reason)
    try {
      await observePromptInput(controller.signal, () => this.ensureTerminalFrontendObservation(session))
      watch = this.terminalFrontendWatches.get(session.agentSessionId)
      if (!watch || watch.frontend?.state && watch.frontend.state !== 'unknown') return
      watch.controller.signal.addEventListener('abort', abort, { once: true })
      if (watch.controller.signal.aborted) abort()
      await observePromptInput(controller.signal, () => new Promise<void>(resolve => { ready = resolve; watch!.ready.add(ready) }))
    } finally {
      clearTimeout(timer)
      if (watch) { watch.controller.signal.removeEventListener('abort', abort); watch.ready.delete(ready) }
    }
  }

  private async ensureNativeStatusObservation(session: AgentMuxStoredAgentSession | AgentMuxAgentSession): Promise<boolean> {
    await this.ensureTerminalFrontendObservation(session)
    if (this.reopensDisposed) return false
    const provider = this.providers.get(session.providerId)
    if (!provider.observeSessionStatus || !session.nativeHandle) return true
    const key = JSON.stringify([session.run.runId, session.nativeHandle])
    const existing = this.nativeStatusWatches.get(session.agentSessionId)
    if (existing?.key === key) { await existing.pending; return Boolean(existing.observer) && !existing.controller.signal.aborted }
    existing?.controller.abort(); existing?.observer?.dispose()
    const watch: {
      key: string; controller: AbortController; observer?: { dispose(): void }; pending: Promise<void>
      recordId?: string; sequence?: number
    } = {
      key, controller: new AbortController(), pending: Promise.resolve()
    }
    this.nativeStatusWatches.set(session.agentSessionId, watch)
    let unavailableObservation = false
    const unavailable = (code: string, message: string): void => {
      if (watch.controller.signal.aborted || this.nativeStatusWatches.get(session.agentSessionId) !== watch) return
      unavailableObservation = true
      this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId, code,
        message: `${message} The retained Session, Run and input remain available. Inspect the Session to retry observation.`,
        evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } })
      if (code !== 'AGENT_NATIVE_STATUS_GAP') {
        this.nativeStatusWatches.delete(session.agentSessionId)
        watch.controller.abort(); watch.observer?.dispose()
      }
    }
    try {
      watch.observer = await provider.observeSessionStatus({ args: [], workspacePath: session.workspacePath,
        nativeHandle: structuredClone(session.nativeHandle),
        ...(session.nativePromptPredecessor ? { nativePromptPredecessor: structuredClone(session.nativePromptPredecessor) } : {}),
        signal: watch.controller.signal, onUnavailable: unavailable,
        onStatus: observation => {
          watch.pending = watch.pending.then(async () => {
            if (watch.controller.signal.aborted || this.nativeStatusWatches.get(session.agentSessionId) !== watch ||
              observation.recordId === watch.recordId || (watch.sequence !== undefined && observation.sequence !== undefined && observation.sequence <= watch.sequence)) return
            const current = this.requireAgentSession(session.agentSessionId)
            if (!sameRun(current.run, session.run) || current.providerId !== session.providerId || !sameNativeHandle(current.nativeHandle, session.nativeHandle) || this.endedRuns.has(current.run.runId)) return
            const ended = observation.state === 'done' || observation.state === 'error' ||
              observation.state === 'unknown' && observation.endReason === 'interrupted'
            const hook = current.hookReceipt
            if (!ended && this.hookTurnPhases.get(session.run.runId) === 'in-turn' && hook?.nativeTurnId && hook.nativeTurnId !== observation.nativeTurnId &&
              (observation.nativeObservedAt === undefined || observation.nativeObservedAt <= hook.observedAt)) return
            if (observation.state === 'unknown' && !ended) {
              watch.recordId = observation.recordId
              if (observation.sequence !== undefined) watch.sequence = observation.sequence
              this.publisher.publish({ type: 'agent-error', agentSessionId: current.agentSessionId,
                code: 'AGENT_NATIVE_STATUS_UNCONFIRMED',
                message: 'The native turn status is unknown. Retained work, child scopes, Session and input remain available.',
                evidence: { source: 'agentmux', run: { ...current.run }, observedAt: Date.now() } })
              return
            }
            let publishedState: AgentSemanticState = observation.state
            let displayAccepted = false
            const next = await this.updateExactAgentSession(current.agentSessionId, current.run, saved => {
              displayAccepted = false
              if (watch.controller.signal.aborted || saved.providerId !== session.providerId || !sameNativeHandle(saved.nativeHandle, session.nativeHandle)) return saved
              if (ended) {
                const previous = nativeTurnEndScopeMatches(saved) ? saved.nativeTurnEnds!.turns : {}
                const end = Object.hasOwn(previous, observation.nativeTurnId) ? previous[observation.nativeTurnId]! : {
                  recordId: observation.recordId, observedAt: Date.now(),
                  ...(observation.nativeObservedAt === undefined ? {} : { nativeObservedAt: observation.nativeObservedAt }) }
                saved = { ...saved, nativeTurnEnds: { run: { ...saved.run }, providerId: saved.providerId,
                  nativeHandle: structuredClone(saved.nativeHandle!), turns: { ...previous, [observation.nativeTurnId]: end } } }
                const pending = saved.pendingInteraction
                const finishPermission = (request: AgentMuxInteractionRequest): AgentMuxInteractionRequest => {
                  const end = request.kind === 'permission' ? permissionNativeTurnEnd(saved, request) : undefined
                  return end && request.kind === 'permission' && request.permissionHook
                    ? { ...request, permissionHook: { ...request.permissionHook, nativeTurnEnded: { recordId: end.recordId, observedAt: end.observedAt } } }
                    : request
                }
                if (pending) saved = { ...saved, pendingInteraction: { ...pending, request: finishPermission(pending.request),
                  ...(pending.additionalRequests ? { additionalRequests: pending.additionalRequests.map(finishPermission) } : {}) } }
              }
              // A retained transcript can settle its original request without proving current activity.
              if (nativeTargetSourceUnconfirmed(saved)) return saved
              // Suppress a prior turn's current display, without discarding its exact historical end.
              const savedHook = saved.hookReceipt
              if (this.hookTurnPhases.get(session.run.runId) === 'in-turn' && savedHook?.nativeTurnId && savedHook.nativeTurnId !== observation.nativeTurnId &&
                (observation.nativeObservedAt === undefined || observation.nativeObservedAt <= savedHook.observedAt)) return saved
              const sameState = saved.semanticStatus?.nativeTurnId === observation.nativeTurnId &&
                saved.semanticStatus.state === observation.state &&
                JSON.stringify(saved.semanticStatus.failure) === JSON.stringify(observation.failure)
              if (sameState && (observation.state !== 'working' || observation.nativeObservedAt === undefined ||
                observation.nativeObservedAt <= saved.semanticStatus!.observedAt)) return saved
              if (observation.state === 'working' && saved.semanticStatus?.source === 'native-hook' &&
                (observation.nativeObservedAt === undefined || observation.nativeObservedAt <= saved.semanticStatus.observedAt)) return saved
              // Reading retained records never renews the native activity clock, including idle ends.
              if (observation.initialSnapshot && observation.state === 'working' && (observation.nativeObservedAt === undefined ||
                observation.nativeObservedAt <= (saved.semanticStatus?.observedAt ?? 0))) return saved
              publishedState = ended ? observeSubagentMainEnd(saved.run.runId, observation.state) : observation.state
              const status = transitionAgentSemanticStatus(saved.semanticStatus, {
                state: publishedState === 'unknown' ? 'running' : publishedState,
                source: 'native-transcript', observedAt: observation.initialSnapshot || observation.state === 'working' ? observation.nativeObservedAt ?? 0 :
                  Math.max(Date.now(), (saved.semanticStatus?.observedAt ?? 0) + 1),
                nativeTurnId: observation.nativeTurnId,
                ...(observation.failure ? { failure: structuredClone(observation.failure),
                  detail: `[${observation.failure.code}] ${observation.failure.message}` } : {})
              })
              if (observation.state === 'working' && observation.nativeObservedAt === undefined) delete status.stateEnteredAt
              displayAccepted = true
              return { ...saved, semanticStatus: status, updatedAt: Math.max(saved.updatedAt, status.observedAt),
                ...(acceptsAgentActivityState(saved.activityCommit, saved.run, status) ? {
                  activityCommit: advanceAgentActivityCommit(saved.activityCommit, {
                    id: JSON.stringify(['activity-state', 'native-transcript', saved.run.runId, observation.recordId]),
                    source: 'native-transcript', createdAt: status.observedAt,
                    activityState: { run: { ...saved.run }, state: status.state,
                      ...(status.stateEnteredAt === undefined ? {} : { stateEnteredAt: status.stateEnteredAt }) }
                  })
                } : {}) }
            })
            if (watch.controller.signal.aborted) return
            watch.recordId = observation.recordId
            if (observation.sequence !== undefined) watch.sequence = observation.sequence
            if (!displayAccepted) { this.publishSession(next); return }
            if (next.activityCommit && !next.activityCommit.latestCommitted) await this.flushAgentActivity(next)
            if (watch.controller.signal.aborted || this.nativeStatusWatches.get(session.agentSessionId) !== watch) return
            if (observation.state === 'working' || ended)
              this.hookTurnPhases.set(session.run.runId, ended ? 'turn-ended' : 'in-turn')
            const status = next.semanticStatus!
            if (status.failure) {
              await this.persistAndPublishTimeline({ type: 'upsert', agentSessionId: next.agentSessionId, item: {
                id: JSON.stringify(['native-failure', next.run.runId, observation.recordId]),
                agentSessionId: next.agentSessionId, kind: 'lifecycle', status: 'failed', source: 'native-transcript',
                createdAt: status.observedAt, updatedAt: status.observedAt, title: `[${status.failure.code}] ${status.failure.message}`,
                content: JSON.stringify(status.failure)
              } }, { source: 'native-transcript', run: { ...next.run }, observedAt: status.observedAt }, next.hostId)
            }
            if (watch.controller.signal.aborted || this.nativeStatusWatches.get(session.agentSessionId) !== watch) return
            this.publishSession(next)
            this.publisher.publish({ type: 'agent-status', agentSessionId: next.agentSessionId,
              state: publishedState, ...(status.detail ? { detail: status.detail } : {}),
              ...(status.failure ? { failure: structuredClone(status.failure) } : {}),
              evidence: { source: 'native-transcript', run: { ...next.run }, observedAt: status.observedAt } })
          }).catch(error => unavailable(error instanceof AgentMuxError ? error.code : 'AGENT_NATIVE_STATUS_PERSIST_FAILED',
            error instanceof Error ? error.message : 'The native status could not be saved.'))
          const pending = watch.pending
          this.nativeStatusSettlements.add(pending)
          void pending.then(() => this.nativeStatusSettlements.delete(pending))
        }
      })
      if (watch.controller.signal.aborted || this.nativeStatusWatches.get(session.agentSessionId) !== watch) {
        watch.observer.dispose()
        return false
      }
      await watch.pending
    } catch (error) {
      unavailable(error instanceof AgentMuxError ? error.code : 'AGENT_NATIVE_STATUS_UNAVAILABLE', error instanceof Error ? error.message : 'Native status observation is unavailable.')
    }
    return !unavailableObservation
  }

  private async persistSemanticStatus(
    agentSessionId: string,
    expectedRun: AgentMuxRunRef,
    status: AgentStatus
  ): Promise<AgentMuxStoredAgentSession> {
    const next = await this.updateExactAgentSession(agentSessionId, expectedRun, (current) => {
      if (
        current.semanticStatus &&
        current.semanticStatus.observedAt > status.observedAt
      ) return current
      const semanticStatus = transitionAgentSemanticStatus(current.semanticStatus, status)
      return {
        ...current,
        semanticStatus,
        ...(acceptsAgentActivityState(current.activityCommit, expectedRun, semanticStatus) ? {
          activityCommit: advanceAgentActivityCommit(current.activityCommit, {
            id: JSON.stringify(['activity-state', status.source, expectedRun.runId, mintObjectId()]),
            source: status.source, createdAt: status.observedAt,
            activityState: { run: { ...expectedRun }, state: semanticStatus.state,
              ...(semanticStatus.stateEnteredAt === undefined ? {} : { stateEnteredAt: semanticStatus.stateEnteredAt }) }
          })
        } : {}),
        updatedAt: Math.max(current.updatedAt, status.observedAt)
      }
    })
    if (next.activityCommit?.latest.createdAt === status.observedAt && !next.activityCommit.latestCommitted) {
      await this.flushAgentActivity(next)
    }
    this.publishSession(next)
    return next
  }

  private async persistPendingInteraction(
    request: AgentMuxInteractionRequest
  ): Promise<AgentMuxStoredAgentSession> {
    const expectedRun = request.evidence.run
    if (!expectedRun) {
      throw new AgentMuxError('Agent interaction omitted its exact Run.', 'INVALID_AGENT_INTERACTION')
    }
    return await this.updateExactAgentSession(request.agentSessionId, expectedRun, (current) => {
      const existing = current.pendingInteraction
      if (existing) {
        if (existing.request.id !== request.id) {
          throw new AgentMuxError('Another Agent interaction is already pending.', 'AGENT_INTERACTION_BUSY')
        }
        return current
      }
      return {
        ...current,
        pendingInteraction: { request: structuredClone(request) },
        updatedAt: Math.max(current.updatedAt, request.evidence.observedAt)
      }
    })
  }

  private async clearPendingInteraction(
    session: AgentMuxAgentSession,
    requestId: string
  ): Promise<AgentMuxStoredAgentSession> {
    return await this.updateExactAgentSession(session.agentSessionId, session.run, (current) => {
      if (!current.pendingInteraction) return current
      if (current.pendingInteraction.request.id !== requestId) {
        throw new AgentMuxError('Agent interaction changed before settlement.', 'UNKNOWN_AGENT_INTERACTION')
      }
      const completion = current.pendingInteraction.nativeCompleted
      let next = { ...current, updatedAt: Date.now() }
      if (completion) for (const receipt of Object.values(current.interactionOperations ?? {})) {
        if (sameRun(receipt.run, current.run) && isDeepStrictEqual(agentInteractionRequestTarget(receipt.expectedRequest), agentInteractionRequestTarget(current.pendingInteraction.request))) {
          next = interactionReceiptPatch(next, receipt.operationId, { nativeCompleted: completion })
        }
      }
      const [request, ...additionalRequests] = current.pendingInteraction.additionalRequests ?? []
      if (request) next.pendingInteraction = { request, ...(additionalRequests.length ? { additionalRequests } : {}) }
      else delete next.pendingInteraction
      return next
    })
  }

  /** Reconcile only an already crossed original Input range; never create or replay an answer. */
  private async submitNativeInteractionResponse(
    session: AgentMuxAgentSession, run: CtxmuxAdapterRun, request: AgentMuxInteractionRequest,
    response: AgentMuxInteractionResponse, responseDigest: string, operationId: string, data: string
  ): Promise<void> {
    if (request.agentSessionId !== session.agentSessionId || request.evidence.source !== 'native-hook' ||
        request.evidence.run?.runId !== session.run.runId || run.runId !== session.run.runId) {
      throw new AgentMuxError('Native interaction receipt does not match the original Session and Run.', 'INVALID_AGENT_INTERACTION')
    }
    const bytes = Buffer.byteLength(data)
    const assertResponse = (state: NonNullable<AgentMuxAgentSession['pendingInteraction']>['response']): void => {
      if (!state || !bytes || state.responseDigest !== responseDigest || state.operationId !== operationId ||
          state.inputByteRange.endByte - state.inputByteRange.startByte !== bytes || !isDeepStrictEqual(state.value, response)) {
        throw new AgentMuxError('The original interaction response claim is missing or has different content.', 'AGENT_INTERACTION_RESPONSE_CONFLICT')
      }
    }
    let current = await this.updateExactAgentSession(session.agentSessionId, session.run, stored => {
      if (!stored.pendingInteraction || !isDeepStrictEqual(agentInteractionRequestTarget(stored.pendingInteraction.request), agentInteractionRequestTarget(request))) {
        throw new AgentMuxError('The original interaction request changed before receipt reconciliation.', 'UNKNOWN_AGENT_INTERACTION')
      }
      assertResponse(stored.pendingInteraction.response)
      return stored
    })
    const state = current.pendingInteraction!.response!
    // The shared cursor only makes this old operation safe to query; it never confirms this answer.
    if (run.acceptedInputBytes === null || run.acceptedInputBytes < state.inputByteRange.endByte) {
      throw new AgentMuxError('The original typed response receipt is unconfirmed. It will not be replayed; continue in the original terminal.', 'AGENT_INTERACTION_UNCONFIRMED')
    }
    let acceptedInputBytes = run.acceptedInputBytes
    if (!state.acknowledged) {
      const accepted = await this.kernel.input(session.run.runId, {
        ownerInstanceId: this.kernel.identity().daemonInstanceId, operationId: state.operationId,
        expectedByte: state.inputByteRange.startByte, data
      })
      if (accepted.run.runId !== session.run.runId || accepted.appliedByteRange.startByte !== state.inputByteRange.startByte ||
          accepted.appliedByteRange.endByte !== state.inputByteRange.endByte || accepted.run.acceptedInputBytes === null ||
          accepted.run.acceptedInputBytes < state.inputByteRange.endByte) {
        throw new AgentMuxError('CtxMux interaction receipt does not match the original Input claim.', 'AGENT_INTERACTION_RECEIPT_MISMATCH')
      }
      acceptedInputBytes = accepted.run.acceptedInputBytes
      current = await this.updateExactAgentSession(session.agentSessionId, session.run, stored => {
        stored = interactionReceiptPatch(stored, operationId, { delivery: 'bytes-accepted', inputByteRange: state.inputByteRange })
        if (stored.pendingInteraction?.request.id !== request.id) return stored
        assertResponse(stored.pendingInteraction.response)
        return { ...stored, pendingInteraction: { ...stored.pendingInteraction,
          response: { ...stored.pendingInteraction.response!, acknowledged: true } }, updatedAt: Date.now() }
      })
    }
    this.agentInputCursors.set(session.agentSessionId, acceptedInputBytes)
    const settled = current.pendingInteraction?.request.id === request.id && agentInteractionResponseSettled(current.pendingInteraction)
      ? await this.clearPendingInteraction(current, request.id) : current
    this.publishSession(settled)
  }

  private cancelInputPreparationObservations(): void {
    this.inputPreparationLifetime.abort(new AgentMuxError(
      'The original Core input connection changed before dispatch; its Run remains available.', 'CTXMUX_DISCONNECTED'))
    this.inputPreparationLifetime = new AbortController()
  }

  private rawInputCall(context?: AgentRawInputCallContext): RawInputCall {
    const epoch = this.connectionEpoch
    const signal = context?.requestSignal ? AbortSignal.any([this.inputPreparationLifetime.signal, context.requestSignal]) : this.inputPreparationLifetime.signal
    return { signal, ...(context?.assertCurrent ? { author: context.assertCurrent.bind(context) } : {}), check: () => {
      signal.throwIfAborted()
      this.assertConnectionEpoch(epoch)
      this.requireConnected()
    } }
  }

  private async assertRawInputCurrent(call: RawInputCall): Promise<void> {
    call.check()
    if (call.author) await observePromptInput(call.signal, async () => { await call.author!() })
    call.check()
  }

  private async writeAgentInput(
    requestedSession: AgentMuxAgentSession,
    data: AgentMuxRunInputData,
    source: AgentMuxAgentWriteInput['source'],
    inputKind: 'write' | 'paste' | 'posture',
    observation?: InputObservationReference | null,
    call: RawInputCall = this.rawInputCall()
  ): Promise<AgentMuxRunInputAck> {
    // Capture before waiting on the input lane: a later request cannot inherit this operation.
    const requestId = source === 'user' && !requestedSession.pendingInteraction?.nativeInput &&
      requestedSession.pendingInteraction?.request.evidence.source === 'native-hook'
      ? requestedSession.pendingInteraction.request.id : undefined
    // 空载荷在这里就地收掉，不下到 ctxmux。daemon 的 RecoverableInput 校验会拒绝空载荷
    // （`recoverable native Input must not be empty`），而「按了键但没有字节要发」是**正常**的终端
    // 事件：IME 组字途中的 onData('')、旧式鼠标上报越界时的零长字节。把它当失败上报，等于用户在
    // TUI 里正常打字就吃到一个 unexpected error——Agent 好得很，是我们的传输层把一个无操作
    // 当成了故障（AGENTS.md 原则 11 的第 2 类，只是这一类连提醒都不需要：它不是降级，是无事发生）。
    //
    // 收在 Core 而不只是在某个 client：Core 是可独立发布的包，每个 client 都会撞上同一条校验。
    //
    // 走 serializeAgentInput 而不是在它外面直接返回：会话/Run 身份的校验（换了 Run、Run 已退出）
    // 只有一个事实源，空载荷不该自己再问一遍「run 还活着吗」——那会是第二份判定，且绕过串行闸。
    // 里面什么都不做：没有字节被接受，游标不推进，也不占一次 operationId。
    if (data.length === 0) {
      return await this.serializeAgentInput(requestedSession, async (session, run) => {
        await this.assertRawInputCurrent(call)
        const cursor = run.acceptedInputBytes
        return {
          runId: session.run.runId,
          appliedByteRange: cursor === null ? null : { startByte: cursor, endByte: cursor },
          acceptedThroughByte: cursor
        }
      }, {
        kind: source === 'terminal-protocol' ? 'protocol' : inputKind === 'paste' ? 'paste' : 'user', bytes: 0, parent: observation ?? null
      }, { rawInput: call })
    }
    // Capture only observers present when this write entered. Whole mouse controls may
    // change the target, so their ACK permits re-verification, never reuse of the old pane.
    // A late ACK cannot grant authority to a later preparation or another Run.
    const mousePreparation = source === 'user' && inputKind === 'write' && wholeMouseReports(data)
    const protocolObservers = source === 'terminal-protocol' || mousePreparation
      ? [...(this.agentInputTails.get(requestedSession.agentSessionId)?.renderObservations ?? [])]
          .filter(observation => sameRun(observation.run, requestedSession.run) && observation.protocolInput &&
            (!mousePreparation || !observation.protocolInput.preclaim?.claimStarted))
      : []
    // This is the same operation later passed to ctxmux, before any input-lane or ACK fact exists.
    const operationId = mintObjectId()
    const preempt = () => {
      call.check()
      this.cancelPromptRenderObservation(requestedSession, source,
        rawInputCancellationDetail(requestedSession, data, operationId, inputKind), mousePreparation)
    }
    // Reserve byte order immediately, while the original author read may still
    // be pending. Only its current success may yield the earlier render reader.
    const preparation = call.author ? this.assertRawInputCurrent(call).then(preempt) : (preempt(), undefined)
    if (preparation) void preparation.catch(() => {}) // The queued owner below consumes its original failure.
    return await this.serializeAgentInput(requestedSession, async (session, run, diagnostic) => {
      // The native terminal remains usable while a typed request is pending. These bytes
      // are not a semantic answer and must not settle or approve that request.
      // This lane already read the current Run. Another public Client may have
      // accepted input since our last ACK; that local cursor cannot start new bytes.
      if (source === 'user') {
        try { await this.recovery.userInput(session.agentSessionId, session.run.runId) }
        catch (error) { this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
          code: 'CONTINUITY_INPUT_UNCONFIRMED', message: `Automatic recovery input priority persistence is unconfirmed. Your terminal input remains available. ${error instanceof Error ? error.message : String(error)}`,
          evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } }) }
      }
      const expectedByte = run.acceptedInputBytes
      if (expectedByte === null) {
        throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
      }
      // Save uncertainty before the side effect; a crash must not re-enable an old typed approval.
      const observeNativeInput = async (delivery: 'unknown' | 'accepted' | 'not_applied'): Promise<void> => {
        if (!requestId) return
        try {
          const next = await this.updateExactAgentSession(session.agentSessionId, session.run, (current) => {
            const pending = current.pendingInteraction
            if (pending?.request.id !== requestId) return current
            const native = pending.nativeInput
            if (native && native.operationId !== operationId) return current
            if (delivery === 'not_applied') {
              if (!native) return current
              const { nativeInput: _removed, ...rest } = pending
              return { ...current, pendingInteraction: rest, updatedAt: Date.now() }
            }
            if (native?.delivery === delivery) return current
            return { ...current, pendingInteraction: {
              ...pending, nativeInput: { operationId, delivery, observedAt: native?.observedAt ?? Date.now() }
            }, updatedAt: Date.now() }
          })
          this.publishSession(next)
        } catch (error) {
          this.publisher.publish({ type: 'agent-error', code: 'AGENT_NATIVE_INPUT_PERSIST_FAILED',
            message: `Native input state could not be saved for Agent ${session.agentSessionId} (Run ${session.run.runId}). The terminal remains available; whether the saved request is still pending cannot be confirmed across restart. ${error instanceof Error ? error.message : String(error)}`,
            evidence: { source: 'user', observedAt: Date.now(), run: { ...session.run } } })
        }
      }
      await observeNativeInput('unknown')
      let result: Awaited<ReturnType<typeof this.kernel.input>>
      let dispatched = false
      try {
        await this.assertRawInputCurrent(call)
        if (!sameRun(this.requireAgentSession(session.agentSessionId).run, session.run)) throw new AgentMuxError(
          'Agent Session changed before native Input dispatch.', 'STALE_AGENT_SESSION')
        const ownerInstanceId = this.kernel.identity().daemonInstanceId
        diagnostic.executionOwner(ownerInstanceId)
        call.check()
        result = await diagnostic.measure('native-input', () => {
          dispatched = true
          return this.kernel.input(session.run.runId, { ownerInstanceId, operationId, expectedByte, data })
        })
      } catch (error) {
        for (const observation of protocolObservers) observation.protocolInput!.invalid = true
        if (!dispatched || error instanceof AgentMuxError && error.detail === 'not_applied') await observeNativeInput('not_applied')
        throw error
      }
      await observeNativeInput('accepted')
      for (const observation of protocolObservers) {
        const protocol = observation.protocolInput!
        const range = result.appliedByteRange
        const previous = protocol.acknowledged
        const endByte = expectedByte + Buffer.byteLength(data)
        if (result.run.runId !== session.run.runId || result.run.pid !== run.pid ||
            range.startByte !== expectedByte || range.endByte !== endByte || result.run.acceptedInputBytes !== endByte ||
            previous && (previous.endByte !== range.startByte || previous.processId !== run.pid)) {
          protocol.invalid = true
        } else {
          protocol.acknowledged = { startByte: previous?.startByte ?? range.startByte,
            endByte: range.endByte, processId: run.pid }
        }
      }
      if (result.run.acceptedInputBytes === null) {
        throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
      }
      this.agentInputCursors.set(session.agentSessionId, result.run.acceptedInputBytes)
      if (source === 'terminal-protocol' && result.run.runId === session.run.runId && result.run.pid === run.pid &&
          result.appliedByteRange.startByte === expectedByte && result.appliedByteRange.endByte === expectedByte + Buffer.byteLength(data) &&
          result.run.acceptedInputBytes === result.appliedByteRange.endByte) {
        try { await this.recovery.protocolAccepted(session.agentSessionId, session.run.runId, operationId, result.appliedByteRange) }
        catch (error) { this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
          code: 'CONTINUITY_INPUT_UNCONFIRMED', message: `Terminal protocol input succeeded, but recovery input boundary persistence is unconfirmed. Ordinary input remains available. ${error instanceof Error ? error.message : String(error)}`,
          evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } }) }
      }
      // Raw bytes may edit a draft or control the terminal. Their ACK cannot revoke
      // a native task state. Semantic submission owns completion consumption;
      // Provider events own task transitions, independently of this input receipt.
      return {
        runId: session.run.runId,
        appliedByteRange: result.appliedByteRange,
        acceptedThroughByte: result.run.acceptedInputBytes
      }
    }, {
      kind: source === 'terminal-protocol' ? 'protocol' : inputKind === 'paste' ? 'paste' : mousePreparation ? 'mouse' : 'user', bytes: Buffer.byteLength(data), parent: observation ?? null
    }, { rawInput: call, rawPreparation: preparation })
  }

  private cancelPromptRenderObservation(session: AgentMuxAgentSession,
    source: AgentMuxAgentWriteInput['source'] | 'interaction-response',
    competingInput?: ReturnType<typeof rawInputCancellationDetail>, mousePreparation = false): void {
    const cancellation = new AgentMuxError(
      source === 'interaction-response' ? 'Input observation cancelled for a semantic interaction response.'
        : source === 'terminal-protocol' ? 'Input observation yielded for a terminal protocol response.'
          : 'Input observation cancelled for terminal user-source input.',
      'AGENT_INPUT_OBSERVATION_CANCELLED', JSON.stringify({ source: source === 'user' ? 'terminal-user' : source,
        ...(competingInput ? { competingInput } : {}) }))
    const lane = this.agentInputTails.get(session.agentSessionId)
    for (const observation of lane?.renderObservations ?? []) {
      if (!sameRun(observation.run, session.run)) continue
      const preserveProtocolPreparation = source === 'terminal-protocol' ||
        mousePreparation && observation.protocolInput && !observation.protocolInput.preclaim?.claimStarted
      if (!preserveProtocolPreparation && observation.protocolInput) {
        observation.protocolInput.cancelled ??= cancellation
      }
      if (preserveProtocolPreparation && observation.protocolInput) {
        const preclaim = observation.protocolInput.preclaim
        if (!preclaim) continue // Initial qualification is outside the byte lane.
        if (!preclaim.claimStarted) {
          observation.controller.abort(preclaim.interruption)
          continue
        }
      }
      // Claimed render waits must release the lane for native query replies.
      observation.controller.abort(cancellation)
    }
  }

  private providerLaunch(session: AgentMuxAgentSession, run: CtxmuxAdapterRun): { command: string; args: readonly string[] } {
    // A retired Session still has an authoritative Run invocation. Only an exact
    // active binding may replace the managed wrapper with its original launch.
    const current = this.registry.findByRun(session.run)
    const actor = current?.agentSessionId === session.agentSessionId && sameRun(current.run, { runId: run.runId }) ? current.nativeActor : undefined
    return actor && actor.lifecycleOperationId === run.lifecycleOperationId ? actor.launch
      : { command: run.program ?? this.providers.get(session.providerId).executable, args: run.args }
  }

  private providerNativeContext(session: AgentMuxAgentSession, run: CtxmuxAdapterRun): AgentProviderPromptExecutionContext {
    return { args: this.providerLaunch(session, run).args, workspacePath: session.workspacePath,
      ...(session.hostId === 'local' && run.pid !== null ? { processId: run.pid } : {}),
      ...(session.nativeHandle ? { nativeHandle: session.nativeHandle } : {}),
      ...(session.nativePromptPredecessor?.run.runId === session.run.runId &&
        session.retiredRuns.at(-1)?.runId === session.nativePromptPredecessor.previousRun.runId
        ? { nativePromptPredecessor: session.nativePromptPredecessor } : {}) }
  }

  /** Read-only qualification shares cancellation with input observers, but never occupies the byte lane. */
  private async observeAgentInputPreparation<T>(session: AgentMuxAgentSession, timeoutMs: number,
    read: (signal: AbortSignal) => Promise<T>, requestedSignal?: AbortSignal,
    protocolInput?: AgentPromptProtocolInputBoundary,
    retainUntilQueued?: (release: (next?: AbortController) => void) => void): Promise<T> {
    const lane = this.agentInputTails.get(session.agentSessionId) ?? {
      tail: Promise.resolve(), renderObservations: new Set<AgentInputObservation>() }
    const controller = new AbortController()
    const cancelRequested = () => controller.abort(requestedSignal?.reason)
    if (requestedSignal?.aborted) cancelRequested()
    else requestedSignal?.addEventListener('abort', cancelRequested, { once: true })
    const observation = { run: session.run, controller, ...(protocolInput ? { protocolInput } : {}) }
    lane.renderObservations.add(observation)
    this.agentInputTails.set(session.agentSessionId, lane)
    const timeout = setTimeout(() => controller.abort(new AgentMuxError('Native input preparation timed out; the terminal remains available.', 'AGENT_INPUT_PREPARATION_UNCONFIRMED')), timeoutMs)
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(controller.signal.reason ?? new AgentMuxError('Native input preparation was cancelled.', 'AGENT_INPUT_PREPARATION_UNCONFIRMED'))
      controller.signal.addEventListener('abort', abort, { once: true })
      if (controller.signal.aborted) abort()
    })
    const release = (next?: AbortController) => {
      if (next && controller.signal.aborted) next.abort(controller.signal.reason)
      lane.renderObservations.delete(observation)
      if (this.agentInputTails.get(session.agentSessionId) === lane && lane.renderObservations.size === 0) {
        const tail = lane.tail
        void tail.finally(() => {
          if (this.agentInputTails.get(session.agentSessionId) === lane && lane.tail === tail && lane.renderObservations.size === 0) this.agentInputTails.delete(session.agentSessionId)
        })
      }
    }
    let retained = false
    try {
      const value = await Promise.race([read(controller.signal), cancelled])
      if (retainUntilQueued) { retainUntilQueued(release); retained = true }
      return value
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', abort)
      requestedSignal?.removeEventListener('abort', cancelRequested)
      if (!retained) release()
    }
  }

  private async serializeAgentInput<T>(
    requestedSession: AgentMuxAgentSession,
    operation: (session: AgentMuxAgentSession, run: CtxmuxAdapterRun, diagnostic: InputPerformanceHandle) => Promise<T>,
    diagnosticInput: ({ kind: 'semantic'; bytes: null } | { kind: 'user' | 'mouse' | 'protocol' | 'paste'; bytes: number }) & { parent?: InputObservationReference | null },
    options: {
      renderObservation?: AbortController | undefined; protocolInput?: AgentPromptProtocolInputBoundary | undefined
      onQueued?: ((next?: AbortController) => void) | undefined
      retainPreclaimYield?: ((release: (next?: AbortController) => void) => void) | undefined
      preclaimDeadline?: number | undefined
      rawInput?: RawInputCall; rawPreparation?: Promise<void> | undefined
    } = {}
  ): Promise<T> {
    const { renderObservation, protocolInput, onQueued, retainPreclaimYield, preclaimDeadline, rawInput, rawPreparation } = options
    const agentSessionId = requestedSession.agentSessionId
    const lifetime = this.inputPreparationLifetime.signal
    // A preclaim cancellation owns its read-only preparation. Ordinary raw
    // preemption only yields optional rendering and must retain typed dispatch.
    const preparationSignal = protocolInput?.preclaim && !protocolInput.preclaim.claimStarted && renderObservation
      ? AbortSignal.any([lifetime, renderObservation.signal]) : lifetime
    const lane = this.agentInputTails.get(agentSessionId) ?? {
      tail: Promise.resolve(),
      renderObservations: new Set<AgentInputObservation>()
    }
    const observation = renderObservation ? {
      run: { ...requestedSession.run }, controller: renderObservation,
      ...(protocolInput ? { protocolInput } : {})
    } : undefined
    // Register before queueing: raw input can arrive while this prompt awaits its predecessor.
    if (observation) lane.renderObservations.add(observation)
    // Transfer the original ACK observation synchronously, without an unobserved gap.
    onQueued?.(renderObservation)
    const diagnostic = this.inputPerformance.begin({ sessionId: agentSessionId, runId: requestedSession.run.runId,
      kind: diagnosticInput.kind, bytes: diagnosticInput.bytes, parent: diagnosticInput.parent ?? null })
    try { const identity = this.runtimeIdentity(); diagnostic.executionOwner(identity.instanceId, identity.hostId) } catch { /* Observation cannot gate input. */ }
    const previous = lane.tail
    beginPromptPreparationPhase(protocolInput, 'input-lane')
    let result!: T
    const queued = previous.catch(() => {}).then(async () => {
      diagnostic.dequeue()
      if (rawPreparation) await rawPreparation
      lifetime.throwIfAborted()
      rawInput?.check()
      const session = this.requireAgentSession(agentSessionId)
      if (!sameRun(session.run, requestedSession.run)) {
        throw new AgentMuxError('Agent Session changed before Input was accepted.', 'STALE_AGENT_SESSION')
      }
      // Preserve the original cancellation across a protocol yield, before a
      // later transport read can replace it with an unrelated connection error.
      if (protocolInput?.cancelled && protocolInput.preclaim && !protocolInput.preclaim.claimStarted &&
          renderObservation?.signal.aborted) throw promptPreparationFailure(protocolInput.cancelled)
      completePromptPreparationPhase(protocolInput)
      beginPromptPreparationPhase(protocolInput, 'current-run')
      const run = await diagnostic.measure('current-run', () => rawInput
        ? observePromptInput(rawInput.signal, () => this.requireCurrentAgentRun(session))
        : observePromptInput(preparationSignal, () => this.requireCurrentAgentRun(session)))
      preparationSignal.throwIfAborted()
      rawInput?.check()
      completePromptPreparationPhase(protocolInput)
      if (run.state.type !== 'running') {
        throw new AgentMuxError(
          'Agent Run exited before Input could be accepted.',
          'STALE_AGENT_SESSION'
        )
      }
      diagnostic.stage('operation')
      result = await diagnostic.measure('operation', () => operation(session, run, diagnostic))
    }).then(() => { diagnostic.settle(true) }, error => { diagnostic.settle(false); throw error })
    const tail = queued.then(() => {}, () => {})
    lane.tail = tail
    this.agentInputTails.set(agentSessionId, lane)
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const preclaimExpiry = preclaimDeadline === undefined ? undefined : new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        const preclaim = protocolInput?.preclaim
        // Once claim starts, only its durable input receipt can describe the outcome.
        if (!preclaim || preclaim.claimStarted) return
        const pane = preclaim.observation?.pane
        if (protocolInput?.invalid || pane?.evidenceGeneration !== this.screenEvidence.generation(agentSessionId)) delete preclaim.wait
        if (preclaim.wait) {
          try {
            const current = this.requireAgentSession(agentSessionId)
            if (current.run.runId !== preclaim.wait.runId || !this.screenEvidence.currentCompleteFrame(current)) delete preclaim.wait
          }
          catch { delete preclaim.wait }
        }
        const error = new AgentMuxError('Original input preparation timed out; the terminal remains available.', 'AGENT_INPUT_PREPARATION_UNCONFIRMED', promptPreparationObservationDetail(protocolInput))
        protocolInput!.cancelled ??= error
        renderObservation?.abort(protocolInput!.cancelled)
        reject(promptPreparationFailure(protocolInput!.cancelled))
      }, Math.max(1, preclaimDeadline - Date.now()))
    })
    try {
      await (preclaimExpiry ? Promise.race([queued, preclaimExpiry]) : queued)
      return result
    } catch (error) {
      this.agentInputCursors.delete(agentSessionId)
      throw error
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer)
      const preclaim = protocolInput?.preclaim
      const retained = observation && retainPreclaimYield && preclaim && !preclaim.claimStarted &&
        renderObservation?.signal.reason === preclaim.interruption
      if (retained) {
        retainPreclaimYield(next => {
          if (next && protocolInput?.cancelled) next.abort(protocolInput.cancelled)
          lane.renderObservations.delete(observation)
          if (this.agentInputTails.get(agentSessionId) === lane && lane.renderObservations.size === 0) {
            const currentTail = lane.tail
            void currentTail.finally(() => {
              if (this.agentInputTails.get(agentSessionId) === lane && lane.tail === currentTail && lane.renderObservations.size === 0) this.agentInputTails.delete(agentSessionId)
            })
          }
        })
      } else if (observation) lane.renderObservations.delete(observation)
      // An observation deadline can return before the queued operation settles.
      // Only the actual tail may release its ordering ownership.
      void tail.then(() => {
        if (this.agentInputTails.get(agentSessionId) === lane && lane.tail === tail && lane.renderObservations.size === 0) {
          this.agentInputTails.delete(agentSessionId)
        }
      })
    }
  }

  private requireAgentSession(agentSessionId: string): AgentMuxStoredAgentSession {
    return this.registry.get(agentSessionId)
  }

  private async resolveRawAgentSession(agentSessionId: string): Promise<AgentMuxStoredAgentSession> {
    const epoch = this.connectionEpoch
    return await this.registry.resolveMetadata(agentSessionId, 'local', () => {
      this.assertConnectionEpoch(epoch)
      this.requireConnected()
    })
  }

  /** A cancelled Hook must finish draining even if its read-only Runtime query never replies. */
  private async observeHookRun(runId: string, signal: AbortSignal): Promise<CtxmuxAdapterRun> {
    signal.throwIfAborted()
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      // Only the observation is abandoned. No input, lifecycle command, or shared connection is cancelled.
      return await Promise.race([this.kernel.status(runId), cancelled])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  /** Only this Run's first or mismatching native subject requires a bounded process observation. */
  private async hookNativeWitness(session: AgentMuxStoredAgentSession, envelope: NativeHookEnvelope, signal: AbortSignal): Promise<{ handle?: AgentNativeSessionHandle; childSessionIds?: readonly string[]; candidates?: readonly Extract<AgentNativeSessionHandle, { kind: 'provider' }>[]; reason?: string }> {
    const provider = this.providers.get(session.providerId)
    const payload = envelope.payload ?? {}
    const eventName = resolveHookEventName(envelope.eventName, payload, provider.hook.eventNameSource) ?? 'unknown'
    const transition = provider.hook.nativeSessionTransition?.(eventName, payload) === true
    if (!provider.hook.processNativeIdentity && !transition) return {}
    if (transition) this.hookNativeWitnesses.delete(session.run.runId)
    const nested = payload.extra && typeof payload.extra === 'object' ? payload.extra as Record<string, unknown> : {}
    const incoming = (provider.hook.nativeHandle?.sessionIdKeys ?? []).map(key => normalizeNativeSessionId(payload[key] ?? nested[key])).find(Boolean)
    const candidate = JSON.stringify(incoming ?? null)
    const childCandidate = (provider.hook.subagentTracking?.idKeys ?? []).map(key => normalizeNativeSessionId(payload[key] ?? nested[key])).find(Boolean)
    const previous = this.hookNativeWitnesses.get(session.run.runId)
    if (previous && !hasSelectedNativeTarget(session) && (previous.candidate === candidate || previous.handle?.sessionId === incoming) &&
      (!childCandidate || previous.reason === 'native-witness-unavailable' || previous.childSessionIds?.includes(childCandidate) || previous.reason === `native-child-unconfirmed:${childCandidate}`)) return previous
    let result: { candidate: string; handle?: AgentNativeSessionHandle; childSessionIds?: readonly string[]; candidates?: readonly Extract<AgentNativeSessionHandle, { kind: 'provider' }>[]; reason?: string } = { candidate }
    try {
      const before = await this.observeHookRun(session.run.runId, signal)
      this.assertAgentRun(session, before)
      if (before.state.type !== 'running' || !before.pid || !provider.discoverNativeSession) throw new Error('Native process witness unavailable.')
      const discovery = await provider.discoverNativeSession({ processId: before.pid, command: this.providerLaunch(session, before).command, args: this.providerLaunch(session, before).args,
        env: {}, workspacePath: session.workspacePath, signal })
      const selected = hasSelectedNativeTarget(session)
      const members = discovery?.candidates ?? (selected && discovery?.handle && discovery.assertPresent ? [discovery] : undefined)
      if (members) {
        result.candidates = members.map(member => ({ ...member.handle }))
      }
      const witness = resolveNativeSessionWitness(discovery, selected ? session.nativeHandle : undefined)
      if (witness) await witness.assertValid()
      const after = await this.observeHookRun(session.run.runId, signal)
      this.assertAgentRun(session, after)
      if (after.state.type !== 'running' || after.pid !== before.pid) throw new Error('Native process changed during observation.')
      if (!witness || witness.handle.providerId !== session.providerId) {
        result.reason = members ? 'native-main-ambiguous' : 'native-witness-unavailable'
      } else result = { ...result, handle: { ...witness.handle },
        ...(witness.childSessionIds !== undefined ? { childSessionIds: witness.childSessionIds } : {}),
        ...(childCandidate && !witness.childSessionIds?.includes(childCandidate) ? { reason: `native-child-unconfirmed:${childCandidate}` } : {}) }
    } catch (error) {
      signal.throwIfAborted()
      delete result.candidates
      result.reason = error instanceof AgentMuxError && error.code === 'AGENT_NATIVE_IDENTITY_AMBIGUOUS'
        ? 'native-main-ambiguous' : 'native-witness-unavailable'
    }
    // Unavailable observation is not reusable source authority. The next relevant
    // Hook rechecks this same Run; it never authenticates an earlier lost event.
    if (result.candidates || result.reason === 'native-witness-unavailable' || result.reason === 'native-main-ambiguous') {
      this.hookNativeWitnesses.delete(session.run.runId)
    } else this.hookNativeWitnesses.set(session.run.runId, result)
    return result
  }

  private acceptsNativeCurrentActivity(session: AgentMuxStoredAgentSession, event: AgentNativeActivityEvent): boolean {
    if (!event.sourceId?.trim() || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
        !['active', 'idle', 'unknown'].includes(event.state) ||
        session.nativeHandle?.kind !== 'provider' || event.nativeSessionId !== session.nativeHandle.sessionId ||
        (event.state !== 'unknown' && !event.nativeTurnId?.trim())) return false
    const retained = session.recoveryActivity?.run.runId === session.run.runId && session.nativeHandle?.kind === 'provider' &&
      session.recoveryActivity.nativeSessionId === session.nativeHandle.sessionId ? session.recoveryActivity : undefined
    const live = this.nativeCurrentActivities.get(session.agentSessionId)
    if (live?.runId === session.run.runId && live.event.nativeSessionId === session.nativeHandle.sessionId &&
        retained && live.event.sourceId !== retained.sourceId) return false
    const previous = live?.runId === session.run.runId && live.event.nativeSessionId === session.nativeHandle.sessionId &&
      (!retained || live.conflicted || live.event.sequence >= retained.sequence) ? live : (retained ? {
      runId: retained.run.runId, event: retained, admissionId: retained.promptSubmissionId,
      conflicted: false, invalidated: retained.state === 'unknown'
    } : undefined)
    if (previous?.runId === session.run.runId) {
      if (previous.conflicted) return false
      if (event.sourceId !== previous.event.sourceId || event.sequence <= previous.event.sequence) return false
      if (event.state === 'idle' && (previous.event.state !== 'active' || previous.invalidated ||
          previous.admissionId !== session.promptCompletionAdmission?.submissionId ||
          event.nativeTurnId !== previous.event.nativeTurnId)) return false
    } else if (event.state === 'idle') return false
    return true
  }

  /** A newer durable observation can retire a local fact, but cannot fabricate a live one. */
  private discardSupersededNativeActivity(session: AgentMuxStoredAgentSession): void {
    const live = this.nativeCurrentActivities.get(session.agentSessionId), retained = session.recoveryActivity
    if (live && (live.runId !== session.run.runId || live.event.nativeSessionId !== session.nativeHandle?.sessionId ||
        !live.conflicted && retained?.sourceId === live.event.sourceId && retained.sequence > live.event.sequence)) {
      this.nativeCurrentActivities.delete(session.agentSessionId)
    }
  }

  /** Invalidate only a recovery inference. Live PTY, input and the original native identity remain usable. */
  private async invalidateRecoveryActivity(session: AgentMuxStoredAgentSession, receiptId: string, observedAt: number,
    source?: Pick<AgentNativeActivityEvent, 'sourceId' | 'sequence'>): Promise<AgentMuxStoredAgentSession> {
    if (!session.recoveryActivity) return session
    return await this.updateExactAgentSession(session.agentSessionId, session.run, current => {
      if (!current.recoveryActivity || !sameNativeHandle(current.nativeHandle, session.nativeHandle) ||
          source && (current.recoveryActivity.sourceId !== source.sourceId || source.sequence <= current.recoveryActivity.sequence)) return current
      const { interruption: _oldEnd, ...original } = current.recoveryActivity
      return { ...current, updatedAt: Math.max(current.updatedAt, observedAt),
        recoveryActivity: { ...original, state: 'unknown', ...(source ? { sequence: source.sequence } : {}), hookReceiptId: receiptId, observedAt } }
    })
  }

  private async acceptHookEvent(envelope: NativeHookEnvelope, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    // 进程已经终结的 run 不再收它的 hook。这一条挡的是**两个**写入点：下面既发 agent-status 事件、又把
    // semanticStatus 落盘。只挡其一都不够——留在磁盘上的 working 会在下次冷启动被读回来继续撒谎。
    //
    // 为什么退出之后还会有 hook：hook 是 Agent 自己的进程在 exec 一条命令，它与内核的退出事件是两条
    // 独立的到达路径，谁先到不定；而自然退出不解绑 registry（解绑只发生在 stop/retire），所以下面那条
    // 会话绑定检查照旧命中。一条被收下的迟到 hook 会让 Agent 永久转圈：exited 之后再不会有 process-state
    // 来拨正它，而 working 的时钟衰减只降到 running，降不到 exited。
    //
    // 这不会误伤「打断当轮」：那条路径根本不产生 process-state、run 仍是 running，此时的 hook 是正常
    // 刷新，照收。
    if (this.endedRuns.has(envelope.runId)) return
    const session = this.registry.findByRun(runRef(envelope.runId))
    if (
      !session ||
      session.agentSessionId !== envelope.agentSessionId ||
      session.providerId !== envelope.providerId
    ) return
    const provider = this.providers.get(envelope.providerId)
    const witness = await this.hookNativeWitness(session, envelope, signal)
    if (this.endedRuns.has(envelope.runId)) return
    // Source change is an observation, never permission to apply the new conversation's semantics to the old binding.
    const protectedTarget = session.nativeHandle !== undefined
    // Partial process witnesses may omit a retained locator; an explicit contradiction cannot replace it.
    const witnessTargetMismatch = witness.handle && session.nativeHandle &&
      !matchesProviderNativeSessionTarget(session.nativeHandle, witness.handle) && !matchesProviderNativeSessionTarget(witness.handle, session.nativeHandle)
    if (witness.candidates || witnessTargetMismatch || witness.reason === 'native-witness-unavailable' || witness.reason === 'native-main-ambiguous') {
      const state = witnessTargetMismatch ? 'changed' as const : witness.candidates || witness.reason === 'native-main-ambiguous' ? 'ambiguous' as const : 'unknown' as const
      let next: AgentMuxStoredAgentSession
      try {
        next = await this.registry.update(session.agentSessionId, session.run, current => {
          if (!sameNativeHandle(current.nativeHandle, session.nativeHandle)) throw new AgentMuxError('Native binding changed while observing its Hook.', 'AGENT_NATIVE_CONFIRMATION_STALE')
          if (current.nativeSourceObservation?.state === state && sameNativeHandle(current.observedNativeHandle, witnessTargetMismatch ? witness.handle : undefined) &&
            isDeepStrictEqual(current.nativeSourceObservation.candidates, witness.candidates)) return current
          const observedAt = Math.max(Date.now(), current.updatedAt + 1), next = { ...current,
            nativeSourceObservation: { state, run: { ...current.run }, observedAt, reason: witnessTargetMismatch ? 'current-main-differs' : witness.reason ?? 'frontend-selection-unconfirmed',
              ...(witness.candidates ? { candidates: witness.candidates } : {}) }, updatedAt: observedAt }
          if (witnessTargetMismatch) next.observedNativeHandle = { ...witness.handle! }
          else delete next.observedNativeHandle
          return next
        }, signal)
      } catch (error) {
        signal.throwIfAborted()
        const stale = error instanceof AgentMuxError && (error.code === 'AGENT_NATIVE_CONFIRMATION_STALE' || error.code === 'STALE_AGENT_SESSION')
        this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
          code: stale ? error.code : 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED', message: stale ? error.message : 'The native source observation could not be saved. The Session, current Run and raw input remain available; Refresh retries observation.',
          evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } })
        throw error
      }
      // Persisted source facts precede their diagnostic so clients can present the exact owner.
      if (nativeTargetSourceUnconfirmed(next)) await this.invalidateRecoveryActivity(next, envelope.receiptId, next.nativeSourceObservation!.observedAt)
      this.publishSession(next)
      if (witness.reason === 'native-witness-unavailable' || witness.reason === 'native-main-ambiguous') this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
        code: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', message: 'Native Hook identity could not be confirmed from this Run. The Run and input remain available; Refresh the native Session observation to retry.',
        evidence: { source: 'agentmux', run: { ...session.run }, observedAt: next.nativeSourceObservation!.observedAt } })
      // A conflicting locator still has an authenticated Hook envelope; retain its neutral receipt.
      if (!witness.handle || witnessTargetMismatch && witness.handle.sessionId !== session.nativeHandle?.sessionId) return
    }
    const context: AgentProviderHookNormalizationContext = Object.freeze({
      ...(session.nativeHandle ? { nativeHandle: Object.freeze({ ...session.nativeHandle }) } : {}),
      ...(session.hookReceipt && sameRun(session.hookReceipt.run, session.run)
        ? { previousHookReceipt: Object.freeze({ ...session.hookReceipt,
          ...(session.hookReceipt.toolInvocation ? { toolInvocation: Object.freeze({ ...session.hookReceipt.toolInvocation }) } : {}) }) } : {}),
      ...(protectedTarget ? { protectedNativeTarget: true } : {}),
      ...(witness.childSessionIds ? { processNativeChildSessionIds: witness.childSessionIds } : {}),
      ...(witness.handle && !(protectedTarget && witnessTargetMismatch) ? { processNativeHandle: Object.freeze({ ...witness.handle }) } : {}),
      ...(hasSelectedNativeTarget(session) ? { nativeTargetMembershipOnly: true as const } : {}),
      ...(protectedTarget && witnessTargetMismatch ? { nativeTargetMismatch: true as const, nativeIdentityReason: 'resume-target-mismatch' } : witness.reason ? { nativeIdentityReason: witness.reason } : {})
    })
    const childrenWereActive = agentHasActiveSubagents(session.run.runId)
    const normalized = witnessTargetMismatch ? normalizeNativeHook(provider.hook, envelope, context) : provider.normalizeHook(envelope, context)
    if (normalized.mainSubject && provider.hook.nativeSessionTransition?.(normalized.eventName, envelope.payload ?? {})) {
      const previous = this.nativeCurrentActivities.get(session.agentSessionId)
      if (previous?.runId === session.run.runId) previous.invalidated = true
      await this.invalidateRecoveryActivity(session, envelope.receiptId, Date.now())
    }
    if (normalized.observationFailure) {
      const source = normalized.observationFailure.source
      const observed = this.nativeCurrentActivities.get(session.agentSessionId)
      const live = observed?.event.nativeSessionId === session.nativeHandle?.sessionId ? observed : undefined
      const previous = live?.runId === session.run.runId ? live.event :
        session.recoveryActivity?.run.runId === session.run.runId ? session.recoveryActivity : undefined
      const sameSource = source && previous && previous.nativeSessionId === session.nativeHandle?.sessionId && source.sourceId === previous.sourceId
      const affectsTarget = sameSource ? source.sequence > previous.sequence : normalized.mainSubject
      const saved = affectsTarget
        ? await this.invalidateRecoveryActivity(session, envelope.receiptId, normalized.status.observedAt, sameSource ? source : undefined) : session
      const applied = affectsTarget && sameNativeHandle(saved.nativeHandle, session.nativeHandle) &&
        (!saved.recoveryActivity || saved.recoveryActivity.hookReceiptId === envelope.receiptId)
      if (applied) {
        if (live?.runId === session.run.runId) live.invalidated = true
      } else this.discardSupersededNativeActivity(saved)
      const observation = { run: { ...session.run }, phase: 'binding' as const,
        code: normalized.observationFailure.code, message: normalized.observationFailure.message,
        ...(session.nativeHandle ? { nativeTarget: session.nativeHandle } : {}), observedAt: normalized.status.observedAt }
      if (applied) {
        this.hookIngressObservations.set(session.agentSessionId, observation)
      }
      this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
        code: observation.code, message: observation.message,
        evidence: { source: 'agentmux', run: { ...session.run }, observedAt: observation.observedAt } })
      this.publishSession(session)
      return
    }
    const childrenChanged = childrenWereActive !== agentHasActiveSubagents(session.run.runId)
    if (protectedTarget && normalized.nativeHandle && session.nativeHandle && (
      normalized.nativeHandle.kind !== session.nativeHandle.kind ||
      normalized.nativeHandle.sessionId !== session.nativeHandle.sessionId ||
      (normalized.nativeHandle.kind === 'provider' && session.nativeHandle.kind === 'provider' && (
        normalized.nativeHandle.providerId !== session.nativeHandle.providerId ||
        (normalized.nativeHandle.transcriptPath !== undefined && session.nativeHandle.transcriptPath !== undefined &&
          normalized.nativeHandle.transcriptPath !== session.nativeHandle.transcriptPath)))
    )) {
      const message = 'Continued native identity is unconfirmed. The original stored conversation and current Run are retained.'
      this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId, code: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', message,
        evidence: { source: 'agentmux', run: { ...session.run }, observedAt: normalized.status.observedAt } })
      throw new AgentMuxError(message, 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')
    }
    const canPromoteLocator = !witnessTargetMismatch
    const precedingInteractionReceiptId = normalized.interaction?.nativeToolCallId &&
      !nativeHookToolCallId(envelope.payload ?? {}) ? context.previousHookReceipt?.id : undefined
    const activityId = JSON.stringify(['activity-state', 'native-hook', session.run.runId, envelope.receiptId])
    const nativeActivity = normalized.currentActivity
    const observedActivity = this.nativeCurrentActivities.get(session.agentSessionId)
    const previousActivity = observedActivity?.event.nativeSessionId === session.nativeHandle?.sessionId ? observedActivity : undefined
    if ((nativeActivity || normalized.childActivity) && (agentSubagentActivityUnconfirmed(session.run.runId, previousActivity?.runId === session.run.runId ? previousActivity.event.sourceId : undefined) || nativeActivity && (
        previousActivity?.runId === session.run.runId && nativeActivity.sourceId !== previousActivity.event.sourceId ||
        session.recoveryActivity?.run.runId === session.run.runId && nativeActivity.sourceId !== session.recoveryActivity.sourceId))) {
      if (previousActivity?.runId === session.run.runId) {
        previousActivity.invalidated = true
        previousActivity.conflicted = true
      }
      this.hookIngressObservations.set(session.agentSessionId, { run: { ...session.run }, phase: 'binding',
        ...(session.nativeHandle ? { nativeTarget: session.nativeHandle } : {}),
        code: 'AGENT_NATIVE_ACTIVITY_UNAVAILABLE', observedAt: normalized.status.observedAt,
        message: 'Native activity identity or source continuity is unconfirmed for this Run. The original Session, Run and input remain available; a subsequent original-identity Run can establish a fresh source.' })
      await this.invalidateRecoveryActivity(session, envelope.receiptId, normalized.status.observedAt)
      this.publishSession(session)
      return
    }
    // Ordered source positions are independent of wall clocks and task completion.
    // A late native start must not update semanticStatus before this same fence.
    if (nativeActivity && !this.acceptsNativeCurrentActivity(
      session.nativeHandle || !normalized.nativeHandle ? session : { ...session, nativeHandle: normalized.nativeHandle }, nativeActivity)) return
    const knownActivity = session.activityCommit?.latest.id === activityId || session.activityCommit?.pending?.id === activityId
    if (knownActivity) {
      await this.flushAgentActivity(session)
      return
    }
    // 读与推进的先后**在今天不承重**，别照着「先读后推」写注释骗下一个人：实测调换这两句，7 条断言全绿。
    // 原因是结构性的——会推进阶段的事件（turn-end / 重开事件）与会被闸门拦的事件
    // （tool-use-start / tool-use-end）是两个不相交的集合，所以「拿推进前的值还是推进后的值」对任何一条
    // 事件都算出同一个答案。hook-turn-phase.test.ts 里钉着这条不相交性；哪天有事件同时进两族，那条会先红，
    // 而**那时**这里的顺序才开始承重。仍写成先读后推，是因为它读起来就是判据本身要说的话。
    const turnPhase = this.hookTurnPhases.get(envelope.runId) ??
      (agentTurnEndEvidence(session) ? 'turn-ended' : undefined)
    const nextTurnPhase = hookTurnPhaseAfter(normalized.lifecycleEvent)
    // 闸门的前提是「收尾之后要再动工必先开新一轮」。这家 Provider 若声明不出任何重开事件，前提不成立，
    // 抑制就会从可逆退化成永久——所以把前提可满足性算出来喂进去，而不是让闸门默认它成立。
    // A Provider contributing native turn outcomes owns completion, including after tool Hooks.
    // An ordinary Stop proves a yield; it cannot prove success or overwrite that outcome.
    const nativeEnd = provider.observeSessionStatus !== undefined
    const updatesSemanticStatus = !(nativeEnd && normalized.mainSubject && normalized.lifecycleEvent === 'turn-end') && hookEventUpdatesSemanticStatus(
      turnPhase,
      normalized.lifecycleEvent,
      provider.hook.rules.some((rule) => eventNamesCanReopenTurn(rule.events, rule.lifecycleEvent))
    ) && (normalized.semanticState !== 'unknown' || normalized.lifecycleEvent === 'turn-end')
    if (updatesSemanticStatus && acceptsAgentActivityState(session.activityCommit, session.run, normalized.status)) {
      // This bounded lookup is only for a candidate transition, never each tool/output observation.
      try {
        const history = await this.store.loadTimeline(session.agentSessionId)
        if (history.items.some(item => item.id === activityId && item.activityState)) {
          await this.flushAgentActivity(session)
          return
        }
      } catch (error) {
        this.publishActivityFailure(session, error, normalized.status.observedAt)
        // Cannot distinguish a late receipt from a new transition while its history is unreadable.
        // Keep the confirmed latest state; reject only this unconfirmed attribution.
        const latest = session.activityCommit?.latest.activityState
        if (session.activityCommit?.latestCommitted || (latest && 'boundary' in latest && latest.boundary === 'history-gap')) {
          await this.persistActivityBoundary(session, 'history-gap', normalized.status.observedAt)
          return
        }
      }
    }
    if (nextTurnPhase) this.hookTurnPhases.set(envelope.runId, nextTurnPhase)
    // 「这一 turn 结束了」与「取不到输出光标快照」是两件事，不许共用一个失败出口。
    //
    // 这次 status() 图的只是 `latestOutputBytes`——一个给 composer 就绪判定用的光标快照。可它在**断线
    // 期间**直接抛 CTXMUX_DISCONNECTED（adapter 置 client=null 后 requireClient 恒抛），而这一句原先
    // 裸在这里：错误一路穿出 onEvent、被 hook-server 应答成 503，发事件的 hook 子进程重试一次仍是
    // 503，只写一行 stderr 就正常退出——**这条 Stop 永久丢失**。
    //
    // 窗口不窄，因为重连**只拆内核**：hookServer.stop() 全仓只在 open() 失败与 dispose() 两处调用，
    // 所以掉线期间 HTTP 口一直开着、一直收 POST、一直 503，窗口是每轮退避的整个时长（可达 31.5s），
    // 远大于 hook 客户端 2s 的超时。后果是最坏的那一种且已实测：done 从未落盘（抛出发生在任何持久化
    // 之前），会话停在 working，衰减只把 working 降到 running 降不到 done，完成通知**永不触发**。
    //
    // done 本就不依赖它：done 来自 Provider 的 normalizeHook 规则（claude 的 Stop→done），与内核状态
    // 无关。所以快照降级为 best-effort——只吞断线这一种，别的错误照旧响亮失败（那是真 bug，不是 wire
    // 抖动）。光标确实丢了，我们不假装它没丢：缺席保持缺席，绝不编一个 0 冒充「输出到此为止」——那会
    // 让 screenEvidence 从头扫，把上一轮的提示符误认成这一轮的，于是在 Agent 其实没就绪时放行 prompt。
    // The native end remains authoritative even when this optional output snapshot is absent.
    const stopRun = normalized.lifecycleEvent === 'turn-end'
      ? await this.observeHookRun(session.run.runId, signal).catch((error: unknown) => {
          if (error instanceof AgentMuxError && error.code === 'CTXMUX_DISCONNECTED') return null
          throw error
        })
      : null
    const receipt = {
      id: envelope.receiptId,
      providerId: session.providerId,
      agentSessionId: session.agentSessionId,
      run: { ...session.run },
      eventName: normalized.eventName,
      ...(normalized.nativeTurnId ? { nativeTurnId: normalized.nativeTurnId } : {}),
      ...(normalized.toolInvocation ? { toolInvocation: normalized.toolInvocation } : {}),
      ...(normalized.lifecycleEvent !== undefined ? { lifecycleEvent: normalized.lifecycleEvent } : {}),
      observedAt: normalized.status.observedAt,
      ...(normalized.subject ? { subject: normalized.subject } : {}),
      decision: { activityApplied: updatesSemanticStatus || normalized.childActivity === true || nativeActivity !== undefined,
        lifecycleApplied: normalized.lifecycleEvent !== undefined && normalized.lifecycleEvent !== null && (updatesSemanticStatus || normalized.lifecycleEvent === 'turn-end'),
        reason: nativeActivity ? 'main-current-activity-applied' : updatesSemanticStatus ? normalized.mainSubject ? 'main-semantic-applied' : 'pending-parent-completion-applied' : normalized.childActivity ? 'proven-child-activity' :
          normalized.subject?.kind === 'main' ? normalized.semanticState !== 'unknown' ? 'main-turn-already-ended' : 'no-semantic-rule' :
          normalized.subject?.kind === 'child' ? 'child-observation-only' : normalized.subject?.reason ?? 'no-semantic-rule' },
      ...(stopRun ? { outputCursorBytes: stopRun.latestOutputBytes } : {})
    }
    const completion = normalized.interactionCompletion
    if (completion && (
      typeof completion.nativeToolCallId !== 'string' || !completion.nativeToolCallId.trim() ||
      (completion.kind !== 'question' && completion.kind !== 'permission') || completion.agentSessionId !== session.agentSessionId ||
      completion.evidence.source !== 'native-hook' ||
      completion.evidence.run?.runId !== session.run.runId ||
      completion.evidence.hookReceiptId !== receipt.id
    )) throw new AgentMuxError('Provider interaction completion does not match its native Hook receipt.', 'INVALID_AGENT_INTERACTION')
    const completedRequestId = completion && session.pendingInteraction?.request.kind === completion.kind &&
      session.pendingInteraction.request.nativeToolCallId === completion.nativeToolCallId
      ? session.pendingInteraction.request.id : undefined
    const keepsCurrentReceipt = normalized.subject?.kind !== 'foreign' && normalized.subject?.kind !== 'unknown'
    const persistReceipt = (
      current: AgentMuxStoredAgentSession
    ): AgentMuxStoredAgentSession => {
      signal.throwIfAborted()
      if (!sameNativeHandle(current.nativeHandle, session.nativeHandle)) throw new AgentMuxError('Native binding changed before Hook publication.', 'AGENT_NATIVE_CONFIRMATION_STALE')
      if (nativeActivity && !this.acceptsNativeCurrentActivity(current, nativeActivity)) return current
      const nativeReadiness = current.terminalPromptReadiness?.source === 'native-stop'
        ? current.terminalPromptReadiness : undefined
      const existingReadiness = nativeReadiness && (
        nativeReadiness.id === receipt.id ||
        (nativeReadiness.observedAt !== undefined && receipt.observedAt <= nativeReadiness.observedAt)
      ) ? nativeReadiness
        : undefined
      let persistedReceipt = normalized.lifecycleEvent === 'turn-end' &&
        existingReadiness?.id === receipt.id && existingReadiness.outputCursorBytes !== undefined
        ? { ...receipt, outputCursorBytes: existingReadiness.outputCursorBytes }
        : receipt
      if (!witnessTargetMismatch && provider.hook.toolInvocation) {
        // Another Core may have observed a second open call since normalization.
        // Recompute only the pure Provider contribution from the actual CAS state;
        // replaying normalizeHook would repeat roster and lifecycle effects.
        const toolInvocation = projectNativeHookToolInvocation(provider.hook, normalized.eventName, envelope.payload ?? {}, {
          ...(current.nativeHandle ? { nativeHandle: Object.freeze({ ...current.nativeHandle }) } : {}),
          ...(current.hookReceipt && sameRun(current.hookReceipt.run, current.run)
            ? { previousHookReceipt: Object.freeze({ ...current.hookReceipt,
              ...(current.hookReceipt.toolInvocation ? { toolInvocation: Object.freeze({ ...current.hookReceipt.toolInvocation }) } : {}) }) } : {})
        }, normalized.mainSubject)
        const { toolInvocation: _staleToolInvocation, ...currentReceipt } = persistedReceipt
        persistedReceipt = { ...currentReceipt, ...(toolInvocation ? { toolInvocation } : {}) }
      }
      const { turnUsage: _staleTurnUsage, ...currentBase } = current
      if (nextTurnPhase === 'in-turn' && nativeReadiness) {
        delete currentBase.terminalPromptReadiness
      }
      if (witness.handle && canPromoteLocator && normalized.nativeHandle) delete currentBase.observedNativeHandle
      if (witness.handle && !witness.candidates && !witnessTargetMismatch && normalized.mainSubject) delete currentBase.nativeSourceObservation
      const promotedHandle = witness.handle ?? normalized.nativeHandle
      const next: AgentMuxStoredAgentSession = {
        ...currentBase,
        updatedAt: Math.max(current.updatedAt, normalized.status.observedAt),
        ...(keepsCurrentReceipt ? { hookReceipt: persistedReceipt } : {}),
        ...(!updatesSemanticStatus
          ? {}
          : (() => {
              const semanticStatus = transitionAgentSemanticStatus(current.semanticStatus, normalized.status)
              return { semanticStatus,
                ...(acceptsAgentActivityState(current.activityCommit, current.run, semanticStatus) ? {
                  activityCommit: advanceAgentActivityCommit(current.activityCommit, {
                    id: activityId, source: 'native-hook', createdAt: normalized.status.observedAt,
                    activityState: { run: { ...current.run }, state: semanticStatus.state,
                      ...(semanticStatus.stateEnteredAt === undefined ? {} : { stateEnteredAt: semanticStatus.stateEnteredAt }) }
                  })
                } : {}) }
            })()),
        ...(normalized.lifecycleEvent === 'turn-end'
          ? {
              terminalPromptReadiness: existingReadiness ?? {
                source: 'native-stop' as const,
                id: receipt.id,
                run: { ...current.run },
                observedAt: receipt.observedAt,
                ...(stopRun ? { outputCursorBytes: stopRun.latestOutputBytes } : {})
              }
            }
          : {}),
        ...(normalized.childActivity ? { semanticStatus: { ...(current.semanticStatus ?? { state: 'running' as const, source: 'native-hook' as const, observedAt: unobservedTimestamp }),
          aggregateActivityAt: normalized.status.observedAt,
          currentActivityRevision: (current.semanticStatus?.currentActivityRevision ?? 0) + 1 } } : {}),
        ...(witness.handle && witnessTargetMismatch && !(canPromoteLocator && normalized.nativeHandle) ? { observedNativeHandle: witness.handle } : {}),
        ...(normalized.nativeHandle && canPromoteLocator ? {
          nativeHandle: { ...promotedHandle!,
            ...(promotedHandle?.kind === 'provider' && current.nativeHandle?.kind === 'provider' &&
              matchesProviderNativeSessionTarget(promotedHandle, current.nativeHandle) && promotedHandle.transcriptPath === undefined &&
              current.nativeHandle.transcriptPath ? { transcriptPath: current.nativeHandle.transcriptPath } : {}) },
          nativeBinding: { source: current.nativeBinding?.source ?? (witness.handle ? 'process-witness' as const : 'native-hook' as const), run: { ...current.run }, observedAt: normalized.status.observedAt }
        } : {}),
        // turnUsage 三分支权威解析。清空这一半与上面把 turnUsage 从 ...currentBase 里 destructure 掉
        // 的那半成对（同 fix #1 陷阱）：turnUsage 已从基础展开剔出，此处「不写入」等于「清掉」，而非「保留」。
        // 1) 本条回执带 usage → 用新的（fresh number wins）。
        // 2) 无 usage 且原生主主体贡献真实主轮 turn-end → 清掉；子主体与 provisional Stop 不清主用量：
        //    已知子任务收口可贡献聚合成功，但其用量缺席不能替代主轮读取失败，须保留真实 parent 样本。
        //    收尾本该带用量，它没带说明这一 turn 的用量读取失败（读 transcript 失败/竞态截断/记录落在
        //    256KiB 窗口外），把上一 turn 的数字继续挂在「Last turn」标签下是撒谎，清掉让 UI 落回等待记号「—」。
        // 3) 无 usage 且是 mid-turn 事件 → 保留上一 turn 的值：迟到的不带 usage 事件不该抹掉刚采到的那一 turn。
        ...(normalized.turnUsage
          ? { turnUsage: normalized.turnUsage }
          : normalized.lifecycleEvent === 'turn-end' && normalized.mainSubject
            ? {}
            : current.turnUsage
              ? { turnUsage: current.turnUsage }
              : {})
      }
      if (nativeActivity && this.acceptsNativeCurrentActivity(next, nativeActivity)) {
        next.recoveryActivity = { ...structuredClone(nativeActivity), run: { ...current.run }, hookReceiptId: receipt.id,
          observedAt: receipt.observedAt, ...(current.promptCompletionAdmission?.submissionId ? { promptSubmissionId: current.promptCompletionAdmission.submissionId } : {}) }
      } else if (!nativeActivity && updatesSemanticStatus && !normalized.childActivity && normalized.mainSubject && next.recoveryActivity) {
        // In-turn tools refresh the original main activity. A new prompt or an old idle end
        // cannot inherit that turn's interruption; neither fact grants live input eligibility.
        const ongoing = next.recoveryActivity.state === 'active' && normalized.semanticState === 'working' &&
          normalized.lifecycleEvent !== 'user-prompt-submit' && normalized.lifecycleEvent !== 'turn-start'
        const { interruption: _previousEnd, ...original } = next.recoveryActivity
        next.recoveryActivity = { ...original, state: ongoing ? 'active' : 'unknown', hookReceiptId: receipt.id, observedAt: receipt.observedAt }
      }
      if (next.recoveryActivity && next.nativeHandle?.kind === 'provider' && next.recoveryActivity.nativeSessionId !== next.nativeHandle.sessionId) delete next.recoveryActivity
      const continuity = normalized.continuity, nativeTarget = next.nativeHandle
      if (!witnessTargetMismatch && continuity && normalized.mainSubject && normalized.subject?.kind === 'main' &&
        normalized.agentSessionId === current.agentSessionId && normalized.providerId === current.providerId && sameRun(normalized.run, current.run) &&
        current.hookToken === session.hookToken && current.hookBindingId === session.hookBindingId &&
        current.nativeHandle?.kind === 'provider' && nativeTarget?.kind === 'provider' && continuity.nativeSessionId === current.nativeHandle.sessionId &&
        matchesProviderNativeSessionTarget(current.nativeHandle, nativeTarget)) {
        for (const root of Object.values(current.continuityOperations ?? {})) {
          const supervision = root.supervision, attempt = supervision && current.continuityOperations?.[supervision.activeAttemptOperationId]
          if (!supervision || root.agentSessionId !== current.agentSessionId || supervision.phase === 'cancelled' ||
            !attempt?.newRun || !sameRun(attempt.newRun, current.run) ||
            !matchesProviderNativeSessionTarget(root.nativeTarget, nativeTarget) ||
            !matchesProviderNativeSessionTarget(root.nativeTarget, attempt.nativeTarget) || !matchesProviderNativeSessionTarget(attempt.nativeTarget, nativeTarget)) continue
          if (continuity.kind === 'context-restored') {
            if (supervision.cancellation || supervision.phase === 'settled' || supervision.contextEvidence && sameRun(supervision.contextEvidence.run, current.run)) continue
            const updated = { ...root, supervision: { ...supervision, contextEvidence: { source: 'native-hook' as const,
              run: { ...current.run }, nativeTarget: structuredClone(nativeTarget), hookReceiptId: receipt.id, observedAt: receipt.observedAt } } }
            next.continuityOperations = { ...next.continuityOperations, [root.operationId]: updated }
            if (next.continuity?.operationId === root.operationId) next.continuity = updated
          } else if (continuity.kind === 'explicit-user-cancelled') {
            if (supervision.phase === 'settled' && supervision.reason !== 'context-observed') continue
            const updated = { ...root, supervision: { ...supervision, phase: 'cancelled' as const, reason: 'explicit-native-cancellation',
              observedAt: receipt.observedAt, cancellation: { source: 'native-hook' as const, run: { ...current.run },
                nativeTarget: structuredClone(nativeTarget), operationId: continuity.nativeOperationId, hookReceiptId: receipt.id, observedAt: receipt.observedAt } } }
            delete updated.supervision.nextAttemptAt
            next.continuityOperations = { ...next.continuityOperations, [root.operationId]: updated }
            if (next.continuity?.operationId === root.operationId) next.continuity = updated
          }
        }
      }
      if ((nativeActivity || childrenChanged) && next.semanticStatus) {
        next.semanticStatus = { ...next.semanticStatus,
          currentActivityRevision: (next.semanticStatus.currentActivityRevision ?? 0) + 1 }
      }
      const pending = current.pendingInteraction
      if (completion && completedRequestId && pending?.request.kind === completion.kind &&
        pending.request.id === completedRequestId && pending.request.agentSessionId === current.agentSessionId &&
        pending.request.evidence.source === 'native-hook' && pending.request.evidence.run?.runId === current.run.runId &&
        pending.request.nativeToolCallId === completion.nativeToolCallId) {
        for (const operation of Object.values(current.interactionOperations ?? {})) {
          if (sameRun(operation.run, current.run) && isDeepStrictEqual(agentInteractionRequestTarget(operation.expectedRequest), agentInteractionRequestTarget(pending.request))) {
            next.interactionOperations = interactionReceiptPatch(next, operation.operationId, { nativeCompleted: structuredClone(completion.evidence) }).interactionOperations!
          }
        }
        const completed = { ...pending, nativeCompleted: structuredClone(completion.evidence) }
        if (pending.response && !agentInteractionResponseSettled(completed)) next.pendingInteraction = completed
        else {
          const [request, ...additionalRequests] = pending.additionalRequests ?? []
          if (request) next.pendingInteraction = { request, ...(additionalRequests.length ? { additionalRequests } : {}) }
          else delete next.pendingInteraction
        }
      }
      if (completion && next.pendingInteraction?.additionalRequests?.length) {
        const additionalRequests = next.pendingInteraction.additionalRequests.filter(request =>
          !(request.kind === completion.kind && request.nativeToolCallId === completion.nativeToolCallId))
        const { additionalRequests: _previous, ...active } = next.pendingInteraction
        next.pendingInteraction = { ...active, ...(additionalRequests.length ? { additionalRequests } : {}) }
      }
      if (normalized.interaction) {
        const { nativeToolCallId: _unconfirmedCall, ...unboundInteraction } = normalized.interaction
        let interaction: AgentMuxInteractionRequest = precedingInteractionReceiptId && (current.hookReceipt?.id !== precedingInteractionReceiptId ||
          JSON.stringify(current.nativeHandle ?? null) !== JSON.stringify(context.nativeHandle ?? null))
          ? unboundInteraction : normalized.interaction
        if (interaction.kind === 'permission' && envelope.permissionCallback && provider.hook.permissionDecision?.eventName === normalized.eventName) {
          const { nativeToolCallId: _notReportedByCallback, ...originalCallback } = interaction
          interaction = { ...originalCallback, permissionHook: { receiptId: receipt.id,
            ...(current.nativeHandle?.kind === 'provider' ? { nativeSessionId: current.nativeHandle.sessionId } : {}),
            ...(normalized.nativeTurnId ? { nativeTurnId: normalized.nativeTurnId } : {}),
            ...(!this.hookServer.hasPermissionCallback(current.agentSessionId, current.run.runId, receipt.id) ? { closed: 'abstained' as const } : {}) } }
          if (interaction.kind === 'permission') {
            const end = permissionNativeTurnEnd(current, interaction)
            if (end && interaction.permissionHook) interaction = { ...interaction,
              permissionHook: { ...interaction.permissionHook, nativeTurnEnded: { recordId: end.recordId, observedAt: end.observedAt } } }
          }
        }
        if (
          interaction.agentSessionId !== current.agentSessionId ||
          interaction.evidence.source !== 'native-hook' ||
          interaction.evidence.run?.runId !== current.run.runId ||
          interaction.evidence.hookReceiptId !== receipt.id
        ) {
          throw new AgentMuxError(
            'Provider interaction does not match its native Hook receipt.',
            'INVALID_AGENT_INTERACTION'
          )
        }
        const previous = next.pendingInteraction
        if (!previous) next.pendingInteraction = { request: structuredClone(interaction) }
        else if (previous.request.id !== interaction.id && !previous.additionalRequests?.some(request => request.id === interaction.id)) {
          // Preserve both observations instead of guessing which UI is active or refusing the Hook.
          const additionalRequests = [...(previous.additionalRequests ?? []), structuredClone(interaction)]
          if (previous.nativeCompleted && (!previous.response || agentInteractionResponseSettled(previous))) {
            const [request, ...remaining] = additionalRequests
            next.pendingInteraction = { request: request!, ...(remaining.length ? { additionalRequests: remaining } : {}) }
          } else next.pendingInteraction = { ...previous, additionalRequests }
        }
      }
      return next
    }
    let next: AgentMuxStoredAgentSession
    try {
      next = await this.registry.update(
        session.agentSessionId,
        session.run,
        persistReceipt,
        signal
      )
    } catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'STALE_AGENT_SESSION') throw error
      await this.registry.load(session.hostId)
      signal.throwIfAborted()
      const canonical = this.requireAgentSession(session.agentSessionId)
      if (!sameRun(canonical.run, session.run)) {
        throw new AgentMuxError(
          'Agent Session changed while adopting its native Hook receipt.',
          'STALE_AGENT_SESSION'
        )
      }
      next = canonical.hookReceipt?.id === receipt.id
        ? canonical
        : await this.registry.update(
            session.agentSessionId,
            session.run,
            persistReceipt,
            signal
          )
    }
    signal.throwIfAborted()
    if (nativeActivity && next.recoveryActivity?.hookReceiptId !== receipt.id) {
      this.discardSupersededNativeActivity(next)
      return
    }
    if (nativeActivity) {
      // CAS may have admitted a new prompt while this receipt was being saved.
      // Such a claim consumes idle and cannot be crossed by an old turn end.
      if (next.recoveryActivity?.hookReceiptId === receipt.id && next.recoveryActivity.sourceId === nativeActivity.sourceId &&
          next.recoveryActivity.sequence === nativeActivity.sequence || this.acceptsNativeCurrentActivity(next, nativeActivity)) {
        this.nativeCurrentActivities.set(next.agentSessionId, { event: structuredClone(nativeActivity), runId: next.run.runId,
          admissionId: next.promptCompletionAdmission?.submissionId,
          ...(nativeActivity.state !== 'unknown' && nativeActivity.nativeTurnId ? { fact: {
            ...nativeActivity, state: nativeActivity.state, nativeTurnId: nativeActivity.nativeTurnId,
            source: 'native-hook', run: { ...next.run }, hookReceiptId: receipt.id, observedAt: receipt.observedAt
          } } : { invalidated: true, fact: { ...nativeActivity, state: 'unknown' as const,
            source: 'native-hook', run: { ...next.run }, hookReceiptId: receipt.id, observedAt: receipt.observedAt } }) })
        if (nativeActivity.state === 'unknown') {
          const observation = { run: { ...next.run }, phase: 'binding' as const,
            ...(next.nativeHandle ? { nativeTarget: next.nativeHandle } : {}),
            code: 'AGENT_NATIVE_ACTIVITY_UNAVAILABLE', observedAt: receipt.observedAt,
            message: 'The native activity source changed or lost delivery continuity. Current idle is unconfirmed; the original Session, Run, task results and input remain available. A new confirmed native turn can restore observation.' }
          this.hookIngressObservations.set(next.agentSessionId, observation)
          this.publisher.publish({ type: 'agent-error', agentSessionId: next.agentSessionId,
            code: observation.code, message: observation.message,
            evidence: { source: 'agentmux', run: { ...next.run }, observedAt: receipt.observedAt } })
        } else if (this.hookIngressObservations.get(next.agentSessionId)?.code === 'AGENT_NATIVE_ACTIVITY_UNAVAILABLE') {
          this.hookIngressObservations.delete(next.agentSessionId)
        }
      }
    } else if (updatesSemanticStatus || normalized.childActivity) {
      const previous = this.nativeCurrentActivities.get(next.agentSessionId)
      if (previous?.runId === next.run.runId && previous.fact) {
        if (normalized.lifecycleEvent === 'turn-end' || normalized.semanticState === 'error' || normalized.semanticState === 'blocked') {
          delete previous.fact
        } else if (!normalized.childActivity && (previous.fact.state === 'idle' || previous.invalidated)) {
          // A new classic activity is independently authoritative; do not resurrect old main work.
          delete previous.fact
        }
      }
    }
    const acceptedReceipt = keepsCurrentReceipt ? next.hookReceipt : receipt
    if (!acceptedReceipt || acceptedReceipt.id !== receipt.id) {
      throw new AgentMuxError('Native Hook receipt was not persisted.', 'HOOK_RECEIPT_INVALID')
    }
    if (normalized.continuityObservationFailure) this.publisher.publish({ type: 'agent-error', agentSessionId: next.agentSessionId,
      ...normalized.continuityObservationFailure, evidence: { source: 'native-hook', run: { ...next.run }, hookReceiptId: acceptedReceipt.id, observedAt: acceptedReceipt.observedAt } })
    if (normalized.continuity && Object.values(next.continuityOperations ?? {}).some(root =>
      root.supervision?.contextEvidence?.hookReceiptId === acceptedReceipt.id || root.supervision?.cancellation?.hookReceiptId === acceptedReceipt.id)) {
      // A fresh verified source may reobserve an exhausted read-only observer, never add retry budget.
      this.recovery.observe(next, true)
    }
    if (witnessTargetMismatch) this.publisher.publish({
      type: 'agent-error', agentSessionId: next.agentSessionId,
      code: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', message: 'The current process native source differs from the retained conversation target. The target was preserved; confirm the original native Session before continuing it. The current Run and input remain available.',
      evidence: { source: 'agentmux', run: { ...next.run }, observedAt: acceptedReceipt.observedAt }
    })
    else if (normalized.subject?.reason === 'resume-target-mismatch' || normalized.subject?.reason === 'native-session-mismatch') this.publisher.publish({
      type: 'agent-error', agentSessionId: next.agentSessionId, code: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED',
      message: 'This Native Hook did not confirm the stored conversation identity. Its main activity and permission were not applied; the stored target, current Run and input remain available.',
      evidence: { source: 'agentmux', run: { ...next.run }, observedAt: acceptedReceipt.observedAt }
    })
    const evidence = {
      source: 'native-hook' as const,
      observedAt: normalized.status.observedAt,
      run: { ...next.run },
      hookReceiptId: acceptedReceipt.id
    }
    if (next.activityCommit?.latest.id === activityId) await this.flushAgentActivity(next)
    for (const mutation of normalized.timeline) {
      try { await this.persistAndPublishTimeline(mutation, evidence, next.hostId, signal) }
      catch (error) {
        if (signal.aborted || (error instanceof AgentMuxError &&
          error.code !== 'INVALID_AGENT_TIMELINE_STORE' && error.code !== 'AGENT_TIMELINE_TOO_LARGE')) throw error
        this.publishActivityFailure(next, error, evidence.observedAt)
      }
    }
    // 语义状态的**两个**写入点必须判得一样（同 endedRuns 那道闸的教训）：只挡落盘、不挡发事件，UI 上
    // 那个 Agent 照旧被点亮成 working，而磁盘是对的；只挡发事件、不挡落盘，本次 UI 是对的而下次冷启动
    // 读回磁盘上那条 working 继续撒谎。回执、时间轴、用量都已在上面照常落——挡的只是「所以它正在干活」
    // 这个推论。
    if (updatesSemanticStatus) this.publisher.publishHook(next, normalized, acceptedReceipt)
    if (normalized.interaction) {
      const request = next.pendingInteraction?.request.id === normalized.interaction.id
        ? next.pendingInteraction.request
        : next.pendingInteraction?.additionalRequests?.find(request => request.id === normalized.interaction!.id)
      if (!request) {
        throw new AgentMuxError(
          'Native Agent interaction was not persisted.',
          'AGENT_INTERACTION_STATE_INVALID'
        )
      }
      this.publisher.publishInteraction(request)
    }
    this.publishSession(next)

    if (nextTurnPhase === 'in-turn' && session.terminalPromptReadiness?.source === 'native-stop') {
      this.promptSubmission.cancelReadiness(session.agentSessionId)
    }
    // Physical readiness observation is optional; its owner checks cursor and consumption.
    if (
      normalized.lifecycleEvent === 'turn-end' &&
      next.terminalPromptReadiness &&
      next.terminalPromptReadiness.readyThroughByte === undefined
    ) {
      this.promptSubmission.observeReadiness(next, next.terminalPromptReadiness)
    }
    // This receipt's required durable work and prompt handling have completed. Native
    // status observation continues under its own owner; it cannot change this ACK.
    void this.ensureNativeStatusObservation(next).catch(error => this.publishNativeStatusFailure(next, error))
  }

  private async updateNativeHandle(
    agentSessionId: string,
    handle: AgentNativeSessionHandle
  ): Promise<void> {
    const session = this.requireAgentSession(agentSessionId)
    const next = await this.registry.update(
      agentSessionId,
      session.run,
      (current) => ({ ...current, nativeHandle: handle, updatedAt: Date.now() })
    )
    this.publishSession(next)

    await this.ensureNativeStatusObservation(next)
  }

  private publishActivityFailure(session: AgentMuxStoredAgentSession, error: unknown, observedAt: number): void {
    this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
      code: 'AGENT_WORK_HISTORY_PERSIST_FAILED',
      message: `Work history is incomplete; accepted Agent state remains available. Retry on the next state transition: ${error instanceof Error ? error.message : String(error)}`,
      evidence: { source: 'agentmux', run: { ...session.run }, observedAt } })
  }

  /** Best-effort projection; the durable accepted identity/time already belongs to the Session. */
  private async flushAgentActivity(session: AgentMuxStoredAgentSession): Promise<void> {
    const commit = session.activityCommit
    if (!commit) return
    const observations: AgentActivityObservation[] = [
      ...(commit.pending ? [commit.pending] : []), ...(!commit.latestCommitted ? [commit.latest] : [])
    ]
    for (const observation of observations) {
      try {
        await this.persistAndPublishTimeline({ type: 'append', agentSessionId: session.agentSessionId,
          item: agentActivityTimelineItem(session.agentSessionId, observation) },
          { source: observation.source, observedAt: observation.createdAt, run: { ...observation.activityState.run } }, session.hostId)
        const active = this.registry.findByRun(session.run)
        if (active?.agentSessionId !== session.agentSessionId) continue
        await this.updateExactAgentSession(session.agentSessionId, session.run, current => {
          if (!current.activityCommit) return current
          const next = { ...current.activityCommit }
          if (next.pending?.id === observation.id) delete next.pending
          if (next.latest.id === observation.id) next.latestCommitted = true
          return { ...current, activityCommit: next }
        })
      } catch (error) {
        this.publishActivityFailure(session, error, observation.createdAt)
        return
      }
    }
  }

  private async persistActivityBoundary(
    session: AgentMuxStoredAgentSession,
    boundary: Extract<AgentActivityState, { boundary: string }>['boundary'], observedAt: number
  ): Promise<void> {
    try {
      const next = await this.updateExactAgentSession(session.agentSessionId, session.run, current => {
        const latest = current.activityCommit?.latest.activityState
        if (latest?.run.runId === session.run.runId && 'boundary' in latest && latest.boundary === boundary) return current
        return { ...current, updatedAt: Math.max(current.updatedAt, observedAt),
          activityCommit: advanceAgentActivityCommit(current.activityCommit, {
            id: JSON.stringify(['activity-state', boundary === 'history-gap' ? 'agentmux' : 'run-process', session.run.runId, mintObjectId()]),
            source: boundary === 'history-gap' ? 'agentmux' : 'run-process', createdAt: observedAt, activityState: { run: { ...session.run }, boundary }
          }) }
      })
      await this.flushAgentActivity(next)
    } catch (error) { this.publishActivityFailure(session, error, observedAt) }
  }

  private async persistAndPublishTimeline(
    mutation: AgentTimelineMutation,
    evidence: Parameters<AgentMuxClientEventPublisher['publishTimeline']>[1],
    sourceHostId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const commit = await this.store.applyTimelineMutation(mutation, signal)
    if (commit.changed) this.publisher.publishTimeline(commit, evidence, sourceHostId)
  }

  private requireConnected(): void {
    if (!this.connected || !this.kernel.isConnected()) {
      throw new AgentMuxError('AgentMux client is not connected.', 'CTXMUX_DISCONNECTED')
    }
  }

  private assertConnectionEpoch(epoch: number): void {
    if (epoch !== this.connectionEpoch) {
      throw new AgentMuxError('AgentMux client connection was cancelled.', 'CTXMUX_DISCONNECTED')
    }
  }

  private acceptKernelEvent(event: CtxmuxAdapterEvent): void {
    if (event.type === 'endpoint-unconfirmed') {
      this.observeRuntimeEndpoint(this.connectionEpoch, event)
      return
    }
    const agentSession = this.registry.findByRun(runRef(event.runId))
    if (event.type === 'attachment-state') {
      const observation = { type: 'attachment-state' as const, run: runRef(event.runId),
        afterByte: event.afterByte, ...(agentSession ? { agentSessionId: agentSession.agentSessionId } : {}),
        evidence: { source: 'run-process' as const, observedAt: Date.now(), run: runRef(event.runId) } }
      this.publisher.publish(event.state === 'unavailable' ? { ...observation, state: 'unavailable', diagnostic: {
        code: event.error.code,
        message: `${event.error.message} Live output observation stopped; current Run termination is unconfirmed. Refresh this output observation; the original Run and input operation are retained.`
      } } : { ...observation, state: 'restored' })
      return
    }
    if (event.type === 'service') {
      this.publisher.publishRunService(runRef(event.runId), event.nativeService, event.observedAt, agentSession?.agentSessionId)
      return
    }
    if (event.type === 'data') {
      const projected: AgentMuxRunDataEvent = {
        type: 'data',
        runId: event.runId,
        startByte: event.startByte,
        endByte: event.endByte,
        dataBytes: event.dataBytes,
        data: event.data
      }
      this.publisher.publishRunEvent(projected, agentSession)
      return
    }
    if (event.type === 'gap') {
      const ownsAttachment = this.kernel.hasAttachment(event.runId)
      this.publisher.publish({
        type: 'agent-error',
        ...(agentSession ? { agentSessionId: agentSession.agentSessionId } : {}),
        code: 'OUTPUT_GAP',
        message: 'This Attachment did not receive a continuous output stream.',
        evidence: {
          source: 'terminal-output',
          observedAt: Date.now(),
          run: runRef(event.runId),
          outputGap: {
            kind: 'live-stream',
            latestOutputBytes: event.latestOutputBytes,
            publishedThroughByte: ownsAttachment ? this.kernel.continuationByte(event.runId) : null,
            representation: ownsAttachment ? this.kernel.continuationView(event.runId) : null,
            causes: event.causes,
            observation: event.observation
          }
        }
      })
      return
    }
    if (event.type === 'resized') {
      this.publisher.publish({
        type: 'terminal-resized',
        ...(agentSession ? { agentSessionId: agentSession.agentSessionId } : {}),
        run: runRef(event.runId),
        cols: event.cols,
        rows: event.rows,
        throughByte: event.throughByte,
        resizeRevision: event.resizeRevision
      })
      return
    }
    // run 进程终结是「这个 run 再不会有 hook 事件」的权威终点。子代理若被信号/OOM 杀死、或其
    // SubagentStop 投递失败，normalizer 的花名册里那条 id 永不删除、Map 条目随进程泄漏。在此清掉，
    // 给「子代理事件丢失」一个终结路径——否则那个 runId 的记账会长驻内存。
    releaseSubagentRoster(event.runId)
    if (agentSession) this.nativeCurrentActivities.delete(agentSession.agentSessionId)
    // 退出时把停止意图（我们记的）与观察到的 code/signal（内核报的）合成诚实的 exitReason。意图是一次性的：
    // 一个 runId 只退出一次，读完即删，绝不留驻。非 exited 的终结（interrupted）不参与本分类。
    const stopRequested = this.stopRequestedRuns.delete(event.runId)
    const exitReason = event.state.type === 'exited'
      ? classifyRunExit({
          stopRequested,
          exitCode: event.state.code,
          ...(event.state.signal === null ? {} : { exitSignal: event.state.signal })
        })
      : undefined
    // 这个 run 的进程终结了 —— 连同刚分类出的原因一起记下来。这一条记录承两件事：此后它的 hook 一律
    // 拒收（见 acceptHookEvent），以及 snapshot 重投影时还能说出「它为什么没了」。必须记在分类**之后**：
    // 意图已经在上一行被读走并删掉，事后再没有第二次机会算出这个答案。
    this.endedRuns.set(event.runId, exitReason)
    this.releaseEndedRunHook(runRef(event.runId), agentSession)
    if (agentSession) {
      const frontendWatch = this.terminalFrontendWatches.get(agentSession.agentSessionId)
      if (frontendWatch && JSON.parse(frontendWatch.key)[0] === event.runId) { frontendWatch.controller.abort(); this.terminalFrontendWatches.delete(agentSession.agentSessionId) }
      const watch = this.nativeStatusWatches.get(agentSession.agentSessionId)
      if (watch && JSON.parse(watch.key)[0] === event.runId) {
        this.nativeStatusWatches.delete(agentSession.agentSessionId)
        watch.controller.abort(); watch.observer?.dispose()
      }
      this.invalidateEndedRunReadiness(agentSession, runRef(event.runId))
      this.recovery.wake(agentSession.agentSessionId)
      if (event.state.type !== 'running') void this.persistActivityBoundary(agentSession, event.state.type, event.observedAt)
    }
    this.publisher.publish({
      type: 'process-state',
      ...(agentSession ? { agentSessionId: agentSession.agentSessionId } : {}),
      run: runRef(event.runId),
      state: event.state.type,
      pid: this.runPids.get(event.runId) ?? null,
      ...(event.state.type === 'exited'
        ? {
            exitCode: event.state.code,
            ...(event.state.signal === null ? {} : { exitSignal: event.state.signal }),
            ...(exitReason ? { exitReason } : {})
          }
        : event.state.type === 'interrupted'
          ? { interruptionReason: event.state.reason }
          : {}),
      evidence: {
        source: 'run-process',
        observedAt: event.observedAt,
        run: runRef(event.runId)
      }
    })
  }

}

/** Stable original codes only; arbitrary error text never enters diagnostic metadata. */
function readingDiagnosticFailureReason(error: unknown): ReadingDiagnosticReason {
  let code: unknown
  try { const own = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined; code = own && 'value' in own ? own.value : undefined } catch { return 'unknown' }
  switch (code) {
    case 'AGENT_SESSION_HISTORY_CANCELLED': case 'CONTROL_CANCELLED': return 'cancelled'
    case 'AGENT_SESSION_HISTORY_SOURCE_CHANGED': return 'source-changed'
    case 'AGENT_SESSION_HISTORY_OBSERVATION_TIMEOUT': case 'AGENT_SESSION_HISTORY_TIMEOUT': return 'deadline'
    case 'AGENT_SESSION_HISTORY_BUDGET': case 'AGENT_CONVERSATION_WINDOW_FULL': return 'budget'
    case 'CONTROL_PROTOCOL_ERROR': return 'protocol'
    case 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE': case 'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED': return 'source-unavailable'
    default: return 'unknown'
  }
}

export { terminalEnvironment } from './agent-runtime-helpers.js'
