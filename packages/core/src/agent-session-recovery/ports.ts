import type { RecoveryPromptInput } from './input.js'
import { type AgentTerminalFrontend } from '../agent-terminal-frontend.js'
import { type AgentExecutableProbeContext } from '../executable-probe.js'
import { AgentProviderRegistry, type AgentProvider } from '../agent-provider.js'
import { type AgentCapabilityBinding } from '../agent-capability.js'
import { type AgentInputSubmissionReceipt, type AgentInputCallContext } from '../agent-input-wait.js'
import { AgentMuxClientEventPublisher } from '../client-event-publisher.js'
import { type AgentPromptInputKey } from '../agent-prompt-condition.js'
import { AgentScreenEvidenceStore } from '../screen-evidence.js'
import { CtxmuxRunAdapter, type CtxmuxAdapterRun, type CtxmuxAdapterStopOperation } from '../ctxmux-run-adapter.js'
import { type AgentMuxAgentSessionStore } from '../agent-session-store.js'
import { AgentMuxAgentSessionRegistry } from '../agent-session-registry.js'
import { AgentHookServer, type AgentHookBinding } from '../hook-server.js'
import type { AgentCapabilitySnapshot, AgentExecutorConfig, AgentExecutorId, AgentProviderId, AgentMuxAgentSession, AgentPromptMessageContent, AgentMuxRun, AgentMuxRunRef, AgentMuxStoredAgentSession, AgentSessionHistoryPageOptions } from '../types.js'
import type { AgentMuxHostExecutorOwner } from '../executor-owner.js'

/** Explicit original Core resources; no client or recovery-decision callback crosses this port. */
export type AgentSessionRecoveryPorts = {
  sessions: {
    readonly store: Pick<AgentMuxAgentSessionStore, "readMetadata" | "readContinuityControlReceipt" | "recordRestartAdmission" | "readLifecycleReservation" | "loadResumeCorrelation" | "readRetiredAgentSession">;
    readonly registry: Pick<AgentMuxAgentSessionRegistry, "get" | "resolveMetadata" | "refresh" | "claimRestart" | "reserveRestart" | "load" | "claimReopen" | "commitLifecycle" | "reserveReopen" | "reserveExisting" | "prepareReopen" | "prepareResume" | "recordRestartStartNotApplied" | "update" | "rememberStartedResume" | "releaseLifecycle">;
    resolveRawAgentSession(agentSessionId: string): Promise<AgentMuxStoredAgentSession>;
    currentStoredAgentSession(agentSessionId: string): Promise<AgentMuxStoredAgentSession>;
    updateExactAgentSession(
    agentSessionId: string,
    expectedRun: AgentMuxRunRef,
    update: (current: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession,
    futureIntentId?: string,
    author?: Readonly<AgentCapabilityBinding>
  ): Promise<AgentMuxStoredAgentSession>;
    requireAgentSession(agentSessionId: string): AgentMuxStoredAgentSession;
    retainUnconfirmedLifecycle(error: unknown, expected: AgentMuxStoredAgentSession): AgentMuxStoredAgentSession;
  };
  runtime: {
    readonly kernel: Pick<CtxmuxRunAdapter, "inspectCreation" | "list" | "prepareStop" | "status" | "launchIdentity" | "start" | "observeLifecycle">;
    assertAgentRun(session: AgentMuxAgentSession, run: CtxmuxAdapterRun, durableSessions?: readonly AgentMuxAgentSession[]): void;
    requireCurrentAgentRun(session: AgentMuxAgentSession, durableSessions?: readonly AgentMuxAgentSession[]): Promise<CtxmuxAdapterRun>;
    retireUncommittedRun(runId: string): Promise<void>;
    recordRunTransition(previous: AgentMuxRunRef | null, run: CtxmuxAdapterRun): void;
    requestStop(operation: CtxmuxAdapterStopOperation): Promise<void>;
  };
  providers: {
    readonly providers: Pick<AgentProviderRegistry, "get">;
    probeAgent(providerId: AgentProviderId, commandOverride?: string, context?: AgentExecutableProbeContext): Promise<AgentCapabilitySnapshot>;
    providerLaunch(session: AgentMuxAgentSession, run: CtxmuxAdapterRun): { command: string; args: readonly string[] };
  };
  executors: {
    readonly hostExecutorOwner: AgentMuxHostExecutorOwner | undefined;
    readonly sessionExecutorConfiguration: ((executorId: string) => Promise<AgentExecutorConfig>) | undefined;
    sessionExecutorOptions<T extends Pick<AgentSessionHistoryPageOptions, 'commandOverride' | 'args' | 'env'>>(
    session: Pick<AgentMuxStoredAgentSession, 'executorId' | 'providerId' | 'creation'>, input: T, historyAgentSessionId?: string
  ): Promise<T>;
  };
  hooks: {
    readonly hookServer: Pick<AgentHookServer, "createBinding">;
    hasActiveBinding(runId: string): boolean;
    activeBinding(runId: string): AgentHookBinding | undefined;
    pendingBinding(operationId: string): AgentHookBinding | undefined;
    retainBinding(operationId: string, binding: AgentHookBinding): void;
    activateBinding(runId: string, binding: AgentHookBinding, operationId?: string): void;
    closeRunBinding(runId: string, binding?: AgentHookBinding): Promise<void>;
    releaseUnusedBinding(binding: AgentHookBinding, operationId: string, retainPending: boolean): Promise<void>;
    forgetPendingBinding(operationId: string): void;
    ensureManagedHooks(
    provider: AgentProvider,
    workspacePath: string,
    agentSessionId: string,
    env: Readonly<Record<string, string>>,
    endpoint?: { url: string; token: string }
  ): Promise<void>;
    requireHookIngressOwner(): Promise<void>;
    settleHookRestore(session: Pick<AgentMuxAgentSession, 'agentSessionId' | 'run'>): void;
    observeHookRestoreFailure(session: AgentMuxStoredAgentSession, phase: 'listen' | 'binding', error: unknown): void;
    agentEnvironment(
    environment: Readonly<Record<string, string>>,
    agentSessionId: string,
    providerId: AgentProviderId,
    executorId: AgentExecutorId,
    binding: AgentHookBinding,
    lifecycleOperationId: string,
    capability: string
  ): Record<string, string>;
  };
  input: {
    continueInitialInput(session: AgentMuxStoredAgentSession, run: CtxmuxAdapterRun,
    assertCurrent?: () => Promise<void>): Promise<AgentMuxStoredAgentSession>;
    inspectAgentPromptSubmission(key: AgentPromptInputKey): Promise<import('../types.js').AgentPromptSubmissionRecord | null>;
    submitAgentPrompt(input: RecoveryPromptInput, context?: AgentInputCallContext): Promise<void | AgentInputSubmissionReceipt>;
    deliverPostLaunchPrompt(
    provider: AgentProvider,
    session: AgentMuxAgentSession,
    run: CtxmuxAdapterRun,
    lifecycleOperationId: string,
    text: string,
    message: AgentPromptMessageContent,
    originalSubmissionId?: string,
    requiredNativeSource?: { providerId: string; nativeSessionId: string },
    assertCurrent?: () => Promise<void>
  ): Promise<boolean>;
    recordAcceptedInput(key: AgentPromptInputKey, at: number): Promise<void>;
    recordPromptMessageAfterSideEffect(
    session: AgentMuxAgentSession,
    operationId: string,
    title: string,
    message: AgentPromptMessageContent,
    status?: 'complete' | 'failed',
    inputRef?: AgentPromptInputKey
  ): Promise<void>;
    readCapturedPromptProducer(agentSessionId: string, expectedRun: AgentMuxRunRef, operationId: string): Promise<AgentPromptMessageContent | undefined>;
    resolveMessageAuthor(
    capability: string, callerAgentSessionId: string,
    caller?: AgentMuxStoredAgentSession
  ): string;
  };
  terminal: {
    ensureTerminalFrontendObservation(session: AgentMuxStoredAgentSession | AgentMuxAgentSession): Promise<boolean>;
    readFrontendObservation(agentSessionId: string): AgentTerminalFrontend | undefined;
    ensureTerminalHandshakeOrDegrade(
    requestedSession: AgentMuxStoredAgentSession,
    knownRun?: CtxmuxAdapterRun
  ): Promise<AgentMuxStoredAgentSession>;
    readonly screenEvidence: Pick<AgentScreenEvidenceStore, "discard">;
    queueNativeIdentityCapture(session: AgentMuxStoredAgentSession,
    options?: Pick<AgentSessionHistoryPageOptions, 'commandOverride' | 'args' | 'env'>): void;
  };
  events: {
    readonly publisher: Pick<AgentMuxClientEventPublisher, "publish" | "publishRunState" | "onStatusEvent">;
    publishSession(session: AgentMuxStoredAgentSession): void;
    publishCurrentRunState(session: AgentMuxStoredAgentSession): Promise<void>;
    projectSession(session: AgentMuxStoredAgentSession): AgentMuxAgentSession;
    projectRun(run: CtxmuxAdapterRun, agentSession?: AgentMuxAgentSession): AgentMuxRun;
    publishExecutableCheckFailure(label: string, agentSessionId: string, operationId: string,
    executable: string, capability: AgentCapabilitySnapshot, run: CtxmuxAdapterRun): void;
  };
  observations: {
    registerProviderRead(controller: AbortController): () => void
  };
  connection: {
    readonly connectionEpoch: number;
    requireConnected(): void;
    assertConnectionEpoch(epoch: number): void;
  };
}
