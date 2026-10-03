import type { AgentMuxRunStorageObservation } from './run-storage-observation.js'
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AgentMuxAcpBridge,
  type AgentMuxAcpBinding
} from './acp-adapter.js'
import { normalizeNativeSessionId, normalizeNativeTranscriptPath } from './agent-native-locator.js'
import { captureAgentNativeSessionIdentity } from './agent-native-session-capture.js'
import { normalizeAgentInteractionResponse } from './agent-interaction.js'
import { agentInteractionResponseUnavailableReason, agentInteractionResponseSettled } from './agent-interaction-state.js'
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
  type AgentProviderPromptExecutionContext,
  type AgentProviderPreparedInteractionResponse
} from './agent-provider.js'
import { createDefaultAgentMuxPluginRegistry, type AgentMuxPlugin } from './agent-plugin.js'
import { releaseSubagentRoster, nativeHookToolCallId, projectNativeHookToolInvocation } from './hook-normalizer.js'
import { eventNamesCanReopenTurn } from './agent-hook-event.js'
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
import { composeAgentLaunchPrompt, composeAgentPrompt } from './agent-outbound-message.js'
import { hashAgentCapability, issueAgentCapability, resolveCapabilityAuthor } from './agent-capability.js'
import { planDiscussion } from './agent-discussion.js'
import {
  DurableAgentMuxMessageQueue,
  validateAgentMuxMessageEnvelope,
  type AgentMuxDeliveryBatch,
  type AgentMuxDeliveryAcknowledgement,
  type AgentMuxMessageEnvelope
} from './agent-global-message-queue.js'
import { renderAgentMuxMessageEnvelope } from './agent-message-render.js'
import { answerAsk, cancelAsk, type AgentAsk } from './agent-ask.js'
import {
  AGENT_TERMINAL_CAPABILITY_PERSIST_FAILED,
  AGENT_TERMINAL_HANDSHAKE_FAILED,
  AGENT_TERMINAL_HANDSHAKE_TIMEOUT,
  classifyTerminalHandshakeFailure,
  degradedInputCursor,
  terminalHandshakeExitError
} from './agent-terminal-handshake-outcome.js'
import {
  handOff,
  type Dispatch,
  type DispatchEventKind,
  type HandoffResult
} from './agent-handoff.js'
import { advanceDelivery, type AgentThread } from './agent-message.js'
import type { AgentMuxExecutorProbeResult } from './control.js'
import { AgentMuxClientEventPublisher } from './client-event-publisher.js'
import { agentPromptExceedsBudget, MAX_AGENT_PROMPT_BYTES } from './agent-prompt-budget.js'
import { agentPromptCondition, validateAgentPromptCondition, type AgentPromptCondition } from './agent-prompt-condition.js'
import { agentTurnEndEvidence, cloneSession, sameRun } from './agent-session-identity.js'
import { invalidateAgentIdleEvidence, transitionAgentSemanticStatus } from './agent-semantic-state.js'
import { observeAgent, currentAgentSemanticStatus, type AgentObservation } from './agent-status-freshness.js'
import { runDisplayState } from './agent-run-status.js'
import { AgentScreenEvidenceStore } from './screen-evidence.js'
import { AgentPromptSubmissionCoordinator, promptPreparationFailure, type AgentPromptTransportQualification, type AgentPromptProtocolInputBoundary } from './prompt-submission.js'
import {
  CTXMUX_COMMIT,
  CTXMUX_VERSION,
  CtxmuxRunAdapter,
  type CtxmuxAdapterAttachment,
  type CtxmuxAdapterDataEvent,
  type CtxmuxAdapterEvent,
  type CtxmuxAdapterRun,
  type CtxmuxAdapterStopOperation
} from './ctxmux-run-adapter.js'
import { supportedCtxmuxArtifactPlatform } from './runtime-paths.js'
import { AgentMuxError } from './errors.js'
import { removeHostColorSignals } from './terminal-environment-policy.js'
import { deriveAgentSessionId, mintAgentSessionId } from './agent-session-id.js'
import {
  AgentMuxFileAgentSessionStore,
  AgentMuxSessionDurabilityError,
  loadAgentSessions,
  agentLifecycleOperationIdentity,
  loadSessionHistorySources,
  type AgentMuxAgentSessionStore,
  type AgentMuxLifecycleReservation
} from './agent-session-store.js'
import {
  AgentMuxAgentSessionRegistry,
  type AgentMuxAgentSessionLookup
} from './agent-session-registry.js'
import {
  decideAgentSessionContinuity,
  type AgentMuxAgentContinuityInput,
  type AgentMuxAgentContinuityResult
} from './agent-session-continuity.js'
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
import type {
  AgentActivityObservation,
  AgentActivityState,
  AgentCapabilitySnapshot,
  AgentCatalogEntry,
  AgentExecutorId,
  AgentProviderId,
  AgentMuxAgentPasteInput,
  AgentMuxAgentWriteInput,
  AgentMuxAgentSession,
  AgentPromptMessageContent,
  AgentMuxClientEvent,
  AgentMuxObservationOrigin,
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxRun,
  AgentMuxRunAppliedSize,
  AgentMuxRunAttachment,
  AgentMuxRunAttachmentView,
  AgentMuxRunDataEvent,
  AgentMuxRunInputAck,
  AgentMuxRunInputData,
  AgentMuxRunInputOperation,
  AgentMuxRunRef,
  AgentMuxStoredAgentSession,
  AgentMuxRuntimeDiagnostics,
  AgentMuxRuntimeIdentity,
  AgentMuxRuntimeResourceSnapshot,
  AgentNativeSessionHandle,
  AgentSessionHistoryMetadata,
  AgentSessionHistoryPage,
  AgentSessionHistoryPageOptions,
  AgentSessionQuestionReplyReceipt,
  AgentSessionHistoryQuestionAnswer,
  AgentSessionHistorySource,
  AgentSessionHistoryDescriptor,
  AgentSessionHistoryObservation,
  AgentSessionHistoryObservationOptions,
  AgentSessionHistoryObservationHandle,
  AgentTerminalScreenSnapshot,
  AgentTerminalCapabilityState,
  AgentTerminalOutputChannelState,
  AgentTimelineItem,
  AgentTimelineMutation,
  AgentTimelineSnapshot,
  AgentTerminalHandshake,
  AgentStatus,
  NativeHookEnvelope
} from './types.js'
import { normalizeSessionHistoryPage, SESSION_HISTORY_TIMEOUT_MS } from './session-history.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const TERMINAL_HANDSHAKE_TIMEOUT_MS = 10_000
function sameNativeHandle(a: AgentNativeSessionHandle | undefined, b: AgentNativeSessionHandle | undefined): boolean {
  return a === b || a?.kind === 'provider' && b?.kind === 'provider' && a.providerId === b.providerId &&
    a.sessionId === b.sessionId && a.transcriptPath === b.transcriptPath
}

type NativeHistoryBinding = {
  session: AgentSessionHistoryMetadata
  provider: AgentProvider
  handle: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
  readonly transient: boolean
  matches(current: AgentSessionHistoryMetadata, hostId: string, run?: AgentMuxRunRef): boolean
  assertCurrent(): Promise<void>
}
type NativeHistoryObservationResource = { controller: AbortController; binding: NativeHistoryBinding | null }

const PROVIDER_READ_MAX_CONCURRENT = 4
const AGENTMUX_CLI_PATH = resolveCoreBinPath('agentmux')

export type AgentMuxAgentCreateInput = {
  agentSessionId?: string
  createOperationId?: string
  providerId: AgentProviderId
  executorId: AgentExecutorId
  workspacePath: string
  injectAgentMuxGuide: boolean
  prompt?: string
  /** Authenticated author of this creation's original prompt; Core owns its durable message. */
  initialMessage?: { callerAgentSessionId: string; capability: string; threadId?: string }
  /**
   * AgentMux 自己要对 Agent 说的额外上下文（如 Scratch Topic 说明），署名进出站信封而非混进用户段。
   * 与 `prompt`（用户/发起者的原话，逐字节透传）分层：调用方分开传，信封组装由 Core 的出口负责。
   */
  agentMuxNote?: string
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

export type AgentMuxTerminalCreateInput = {
  createOperationId?: string
  workspacePath: string
  command?: string
  args?: readonly string[]
  cols?: number
  rows?: number
  env?: Readonly<Record<string, string>>
}

export type AgentMuxAgentResumeInput = {
  agentSessionId: string
  operationId: string
  /** Explicit host-generated context, separate from original user text. */
  agentMuxNote?: string
  prompt: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  commandOverride?: string
  cols?: number
  rows?: number
}

export type AgentMuxAgentReopenInput = Omit<AgentMuxAgentResumeInput, 'prompt' | 'agentMuxNote'> & {
  expectedRetiredAt: number
  launchOptions?: LaunchOptionSelection
}

type AgentMuxAgentResumeOperationInput = Omit<AgentMuxAgentResumeInput, 'prompt'> & {
  prompt?: string
}

export type AgentMuxAgentPromptInput = AgentPromptCondition & {
  /** Explicit choice for this message only: the previous turn may still be running. */
  allowUncertainTurn?: boolean
  execution?: import('./types.js').AgentPromptExecution
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

/** Explicit manual answer to an exact Provider-owned asynchronous question record. */
export type AgentMuxSessionQuestionReplyInput = Omit<AgentMuxAgentPromptInput,
  'prompt' | 'agentMuxNote' | 'execution' | 'expectedCompletionId' | 'expectedInputByte' | 'expectedFutureIntent'> & {
  source: AgentSessionHistorySource
  turnId: string
  recordId: string
  answers: AgentSessionHistoryQuestionAnswer[]
  /** Configured native invocation, just as for the existing public history reader. */
  commandOverride?: string
  args?: readonly string[]
  env?: Readonly<Record<string, string | undefined>>
}

export type AgentMuxAgentMessageInput = {
  agentSessionId: string
  envelope: AgentMuxMessageEnvelope
  sourceDevice?: import('./types.js').AgentOperationDevice
  sourceChannel?: import('./types.js').AgentMessageChannel
  execution?: import('./types.js').AgentPromptExecution
  condition: AgentPromptCondition
  caller?: { agentSessionId: string; capability: string }
}

export type AgentMuxAgentInteractionInput = {
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

export type AgentMuxClientOptions = {
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

function runRef(runId: string): AgentMuxRunRef {
  return { runId }
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

function safeId(value: string, name: string): string {
  if (!SAFE_ID.test(value)) {
    throw new AgentMuxError(`${name} must contain only letters, numbers, underscore, or dash.`, 'INVALID_SESSION_ID')
  }
  return value
}

function hookBindingIdentity(operationId: string): string {
  return createHash('sha256').update(operationId).digest('base64url')
}

function terminalHandshakeOperationIdentity(
  providerId: AgentProviderId,
  runId: string,
  handshake: AgentTerminalHandshake
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'agentmux-terminal-handshake-v1',
      providerId,
      runId,
      handshake.query,
      handshake.response
    ]))
    .digest('base64url')
}

function terminalInitialPromptReadinessIdentity(
  session: AgentMuxAgentSession,
  handshakeOperationId: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'agentmux-terminal-prompt-readiness-v1',
      'initial-composer',
      session.providerId,
      session.run.runId,
      handshakeOperationId
    ]))
    .digest('base64url')
}

function agentInteractionOperationIdentity(
  session: AgentMuxAgentSession,
  requestId: string,
  responseDigest: string,
  data: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'agentmux-agent-interaction-v1',
      session.agentSessionId,
      session.run.runId,
      requestId,
      responseDigest,
      data
    ]))
    .digest('base64url')
}

function digestInteractionResponse(response: AgentMuxInteractionResponse): string {
  return createHash('sha256').update(JSON.stringify(response)).digest('base64url')
}

function assertAgentPromptSize(prompt: string): void {
  if (agentPromptExceedsBudget(prompt)) {
    throw new AgentMuxError(
      `Agent prompt exceeds the ${MAX_AGENT_PROMPT_BYTES}-byte limit.`,
      'INVALID_AGENT_PROMPT'
    )
  }
}

export function terminalEnvironment(
  environment: Readonly<Record<string, string>>,
  agentSessionStorePath?: string
): Record<string, string> {
  const inheritedPath = environment.PATH ?? process.env.PATH ?? ''
  const resolved: Record<string, string> = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'AgentMux',
    // Bound to the SHA-verified vendored runtime version, not a hand-copied literal — see
    // CTXMUX_VERSION in ctxmux-run-adapter.ts. Bumping the vendored artifact must not leave this
    // TERM_PROGRAM_VERSION frozen at a stale string.
    TERM_PROGRAM_VERSION: CTXMUX_VERSION,
    FORCE_HYPERLINK: '1',
    ...environment,
    PATH: [dirname(AGENTMUX_CLI_PATH), inheritedPath].filter(Boolean).join(delimiter),
    AGENTMUX_ENV: '1',
    AGENTMUX_CLI: AGENTMUX_CLI_PATH,
    AGENTMUX_STATE_DIRECTORY: defaultAgentMuxStateDirectory(),
    // Tell every process AgentMux spawns where the Agent Session store lives, so the CLI an Agent runs
    // resolves sessions out of the SAME file this Client writes rather than another default scope.
    // The path's authority is whoever constructed the store (the desktop points it at userData).
    ...(agentSessionStorePath ? {
      AGENTMUX_AGENT_SESSION_STORE: agentSessionStorePath
    } : {}),
    AGENTMUX_MESSAGE_QUEUE_PATH: defaultAgentMuxMessageQueuePath(
      agentSessionStorePath ?? null, environment.AGENTMUX_MESSAGE_QUEUE_PATH ?? process.env.AGENTMUX_MESSAGE_QUEUE_PATH
    )
  }
  // `environment` is the last merge before the PTY boundary. A desktop process can carry
  // NO_COLOR/CLICOLOR=0 from the shell that launched it, and passing those values through here makes
  // Provider behavior diverge: Claude follows them and turns its TUI monochrome while Codex may keep
  // emitting ANSI. The Runtime baseline removes the same signals for daemon startup; repeat that
  // invariant at the final Agent/Terminal launch boundary so a stale daemon or executor snapshot cannot
  // reintroduce them.
  removeHostColorSignals(resolved)
  return resolved
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

/** X_OK also accepts searchable directories. Check the file kind first; later valid candidates win over earlier failures. */
async function classifyExecutable(executable: string): Promise<AgentMuxExecutorProbeResult> {
  const candidates = isAbsolute(executable) || executable.includes('/')
    ? [executable]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, executable))
  if (candidates.length === 0) return { executable, availability: 'check-failed', cause: {
    code: 'EXECUTABLE_SEARCH_UNAVAILABLE',
    message: `No candidate path was searchable for "${executable}". Check PATH and the shell environment this app was launched from.`
  } }
  let unknown: { code: string; message: string } | undefined
  let notFile: { code: string; message: string } | undefined
  for (const candidate of candidates) {
    try {
      const metadata = await stat(candidate)
      if (!metadata.isFile()) {
        notFile ??= { code: 'EXECUTABLE_NOT_FILE', message: `${candidate} is ${metadata.isDirectory() ? 'a directory' : 'not a regular file'}; expected a regular executable file.` }
        continue
      }
      await access(candidate, fsConstants.X_OK)
      return { executable, availability: 'available' }
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code : 'EXECUTABLE_CHECK_FAILED'
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        unknown ??= { code, message: error instanceof Error ? error.message : String(error) }
      }
    }
  }
  if (unknown) return { executable, availability: 'check-failed', cause: unknown }
  return { executable, availability: 'missing', ...(notFile ? { cause: notFile } : {}) }
}

async function hasExecutable(executable: string): Promise<boolean> {
  return (await classifyExecutable(executable)).availability === 'available'
}

/**
 * 启动闸拒绝时**为什么**拒绝——把三态里被 boolean 压掉的那一档还原成一句诚实的话。
 *
 * 闸门本身不变（非 available 一律不放行，见 {@link hasExecutable}），变的只是理由。`installed: false`
 * 同时表达「查成了、确实不在」和「PATH 空到根本没候选可查」，而这两者对用户是完全不同的下一步：前者
 * 去装，后者去修环境。压平的后果实测过——PATH 退化的用户被告知「工具没装在这台机器上」，于是去追一个
 * 根本不存在的安装问题。
 *
 * 为什么理由落在 **message** 而不只是 error code：Electron 的 `ipcRenderer.invoke` 会丢掉 `.code` 和
 * `.detail`，只把 `.message` 送到渲染端（见 error-presentation.ts 的第 3 条）。所以在这条路上，message
 * 就是用户能看到的全部；只加一个 code 改不到任何人眼前。
 *
 * 收成一处投影而不是在两个闸门各写一句：createAgent 与 resume 的那两处此前是逐字相同的两份，这正是
 * 「只改一处、另一处静默保留旧行为」的经典形状。
 */
async function executorUnavailableError(
  label: string,
  executable: string
): Promise<AgentMuxError> {
  const result = await classifyExecutable(executable)
  if (result.availability === 'check-failed') {
    return new AgentMuxError(
      `Could not verify the ${label} executable on this host: ${result.cause.code}: ${result.cause.message}`,
      'AGENT_NOT_FOUND',
      'executor-check-failed'
    )
  }
  if (result.availability === 'available') {
    return new AgentMuxError(`${label} executable availability changed while preparing the launch. Retry the launch.`, 'AGENT_NOT_FOUND', 'executor-check-failed')
  }
  return new AgentMuxError(result.cause
    ? `The configured ${label} executable is not available: ${result.cause.message}`
    : `${label} is not installed on this host.`, 'AGENT_NOT_FOUND', 'executor-missing')
}

type AgentInteractionInputQualification = Readonly<{
  prepared: AgentProviderPreparedInteractionResponse
  processId: number | null
  nativeHandleIdentity: string
  deadline: number
}>

type AgentInputObservation = {
  run: AgentMuxRunRef
  controller: AbortController
  protocolInput?: AgentPromptProtocolInputBoundary
}

export class AgentMuxClient {
  readonly providers: AgentProviderRegistry
  private readonly kernel: CtxmuxRunAdapter
  private readonly controlSocketPath: string
  private readonly registry: AgentMuxAgentSessionRegistry
  private readonly store: AgentMuxAgentSessionStore
  private readonly messageQueue: DurableAgentMuxMessageQueue
  private readonly publisher = new AgentMuxClientEventPublisher()
  private readonly acp: AgentMuxAcpBridge
  private readonly hookServer: AgentHookServer
  private readonly hookInstaller: AgentManagedHookInstaller
  private unsubscribeKernel: (() => void) | null = null
  private unsubscribeKernelErrors: (() => void) | null = null
  private unsubscribeConnectionLost: (() => void) | null = null
  private reconnecting = false
  private connecting: Promise<void> | null = null
  private connectionEpoch = 0
  private connected = false
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
  private readonly pendingReopenBindings = new Map<string, AgentHookBinding>()
  private readonly executingReopens = new Set<string>()
  private readonly reopenSettlements = new Map<string, Promise<void>>()
  private reopensDisposed = false
  private readonly agentInputCursors = new Map<string, number>()
  private readonly agentInputTails = new Map<string, {
    tail: Promise<void>
    renderObservations: Set<AgentInputObservation>
  }>()
  private readonly agentContinuityTails = new Map<string, Promise<void>>()
  private readonly providerReads = new Set<AbortController>()
  /** Consumer-owned read-only resources; never occupy Provider page slots or Run lifecycle locks. */
  private readonly historyObservationControllers = new Map<string, Set<NativeHistoryObservationResource>>()
  private providerReadsDisposed = false
  private readonly nativeIdentityCaptures = new Map<string, { controller: AbortController; run: AgentMuxRunRef }>()
  private readonly nativeIdentityPending: Array<() => void> = []
  private nativeIdentityActive = 0
  // 「用户为这个 runId 发起过停止」这条**意图**事实的台账。与内核报的退出**结果**分居两处：控制面在
  // stop 路径写入意图，acceptKernelEvent 在退出事件里读它、合成 exitReason。一个 runId 只会退出一次，
  // 分类后即删，不留驻。裸集合足矣——意图是布尔（在场即「我们关的」），不需要携带别的。
  private readonly stopRequestedRuns = new Set<string>()
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
  private readonly hookNativeWitnesses = new Map<string, { candidate: string; handle?: AgentNativeSessionHandle; childSessionIds?: readonly string[]; reason?: string }>()
  private readonly hookTurnPhases = new Map<string, HookTurnPhase>()
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
    this.controlSocketPath = options.controlSocketPath ?? defaultAgentMuxControlSocketPath()
    if (!isAbsolute(this.controlSocketPath) || /[\0\r\n]/u.test(this.controlSocketPath)) {
      throw new AgentMuxError('Public owner socket must be an absolute local path.', 'INVALID_CONTROL_REQUEST')
    }
    this.providers = options.providers
      ? new AgentProviderRegistry(options.providers)
      : createDefaultAgentMuxPluginRegistry(options.plugins).providers
    this.store = options.store ?? new AgentMuxFileAgentSessionStore()
    // An implicit Session store is Runtime-local, not the durable message queue authority.
    const adoptedFileStore = this.store instanceof AgentMuxFileAgentSessionStore &&
      (options.store !== undefined || Boolean(process.env.AGENTMUX_AGENT_SESSION_STORE?.trim()))
      ? this.store.path : null
    this.messageQueue = new DurableAgentMuxMessageQueue(defaultAgentMuxMessageQueuePath(adoptedFileStore))
    this.registry = new AgentMuxAgentSessionRegistry(this.store, (session, error) => {
      if (error) this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
        code: error.code,
        message: 'The original Session is readable, but its durable save is unconfirmed. The Agent and input are kept. Refresh this Session to retry the durable save.',
        evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } })
      else this.publisher.publish({ type: 'agent-session', session: cloneSession(session) })
    })
    this.kernel = new CtxmuxRunAdapter()
    this.hookServer = new AgentHookServer(
      async (event, signal) => await this.acceptHookEvent(event, signal)
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
          if (mutation) await this.persistAndPublishTimeline(mutation, observed)
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
          this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
        },
        onInteractionSettled: async (request) => {
          const session = this.requireAgentSession(request.agentSessionId)
          const next = await this.clearPendingInteraction(session, request.id)
          this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
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
      assertAgentRun: (session, run) => { this.assertAgentRun(session, run) },
      updateExactAgentSession: (agentSessionId, expectedRun, update) =>
        this.updateExactAgentSession(agentSessionId, expectedRun, update)
    })
  }

  async connect(): Promise<void> {
    if (this.connected && this.kernel.isConnected()) return
    this.connected = false
    if (this.connecting) return await this.connecting
    const epoch = this.connectionEpoch
    const attempt = this.open(epoch)
    this.connecting = attempt
    try {
      await attempt
    } finally {
      if (this.connecting === attempt) this.connecting = null
    }
  }

  private async open(epoch: number): Promise<void> {
    try {
      await this.kernel.connect()
      this.assertConnectionEpoch(epoch)
      await this.recoverStaleLifecycles()
      await this.registry.load('local')
      const runs = await this.withRunSnapshot(null, () => this.kernel.list(), (snapshot, wasRemoved) => {
        const current = snapshot.filter(run => !wasRemoved(run.runId))
        this.backfillEndedRuns(current)
        for (const run of current) this.runPids.set(run.runId, run.pid)
        return current
      })
      // 这次 list() 是「App 没在跑的时候谁退出了」的唯一到达路径——冷启动时事件流压根还没订阅（下面几行
      // 才装）。不补台账的话，那些 run 迟到的 hook 会被收下，Agent 永久转圈（见 backfillEndedRuns）。
      this.synchronizeAgentRuns(runs)
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
      // 掉线检测的接线：kernel 探到实时连接断了（wire 传输失败，或 daemon 关流却没交代 run 下场），
      // 就在这里驱动整套「置 disconnected → 有界重连 → 恢复真相」。这不是某个 run 的语义错误，故与
      // onError 分居两处。
      this.unsubscribeConnectionLost = this.kernel.onConnectionLost(() => this.handleConnectionLost(epoch))
      await this.tryRestoreHookIngress(runs)
      // Probe every running Session together. A serial `await` here makes N healthy Agents
      // wait behind N ten-second capability windows, which is especially visible when the
      // user opens several sessions at once. Each promise still owns one exact Run; only the
      // scoped vanished-Run classification is consumed here. Unknown errors remain fatal, but
      // we wait for all probes to settle first so a slow sibling cannot be abandoned halfway
      // through its cleanup and leave a shared attachment behind.
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
          // Preserve the existing fail-closed behavior for Store invariant failures and
          // unclassified transport errors. Promise.all waits for sibling probes rather than
          // serializing their ten-second timers.
          handshakeErrors.push(error)
        }
      }))
      if (handshakeErrors.length > 0) throw handshakeErrors[0]
      await this.recoverPendingInteractionResponses(runs)
      this.assertConnectionEpoch(epoch)
      this.connected = true
      // 缓刑期的起点。写在这里而不是只写在 `restored` 那侧，是因为首次 connect 也是「连接变健康」——
      // 少了这一句，`connectionHealthySince` 会停在 0，于是第一次掉线时 `now - 0` 必然超过缓刑期、
      // 账被无条件清零，跨成功的界永远攒不起来（即：这道界会变成死代码）。
      this.connectionHealthySince = Date.now()
      for (const session of this.registry.list()) {
        if (runs.some(run => run.runId === session.run.runId && run.state.type === 'running')) {
          this.queueNativeIdentityCapture(session)
        }
      }
    } catch (error) {
      this.kernel.resetConnection()
      await this.hookServer.stop()
      throw error
    }
  }

  /**
   * 掉线的落点：kernel 报实时连接断了时被调用。做三件事，缺一不可（原则 11：断线绝不静默）：
   *
   * 1. `connected = false`——`requireConnected` 从此如实拦下控制操作，不再把请求投进一个死掉的 kernel。
   * 2. 发 `connection-state: lost`——渲染端据此把本 Host 所有 Agent 置 `disconnected`，让那一整套故障 UX
   *    真正有触发源（这是本任务的核心价值：用户必须看得见）。
   * 3. 起一次有界重连。
   *
   * `epoch` 守卫：调用方主动 `disconnect()` 会 `connectionEpoch += 1`，让这条迟到的掉线通知失效——
   * 我们不给一个已被主动关掉、或已被更新一轮连接取代的连接排重连。
   * `reconnecting` 守卫：重连风暴里（重连过程中又断一次）不重复起第二条重连循环。
   *
   * ## 抖动预算的检查点就在这里，而不在重连循环里面
   *
   * 半死 daemon（接受连接、握手过、随即又关流）会让每一轮重连都「成功」，于是 `runBoundedReconnect`
   * 那道单轮的界每次都被重置——单轮有界不等于整体有界。挡它的账在 {@link judgeReconnectFlap}。
   *
   * 判决必须在**发 lost 之前**取得。把它放进 `reconnectLoop` 里就晚了：那样每一次抖动仍然会先发一条
   * `lost` 把整屏 Agent 置灰、再白等一整轮（退避 31.5s + daemon ready + 握手）才拿到终局，用户看到的
   * 抖动一次都没少。放弃时直接发 `unrecoverable`，跳过 `lost` 与整轮重连：这个状态本身就蕴含「连接
   * 断了」，渲染端对它的处置是保持失联并等用户手动介入（见 session-state 的 connection-state 分支）。
   */
  private handleConnectionLost(epoch: number): void {
    if (epoch !== this.connectionEpoch) return
    if (this.reconnecting) return
    const now = Date.now()
    // 连续健康满缓刑期 → 清账。判据是「健康了多久」而非「刚刚 restored」：restored 恰恰是抖动那一刻
    // 发生的事，拿它清账等于永远清得掉，这道界就成了死代码。
    if (shouldClearFlapLedger(this.connectionHealthySince, now)) this.reconnectFlaps = 0
    const verdict = judgeReconnectFlap({ flapCount: this.reconnectFlaps })
    this.reconnectFlaps = verdict.flapCount
    this.connected = false
    for (const runId of this.runPids.keys()) {
      const session = this.registry.findByRun(runRef(runId))
      if (session && !this.endedRuns.has(runId)) void this.persistActivityBoundary(session, 'lost', now)
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
      // 响亮终局，且**立刻**给出——不再发 lost、不再起重连。用户拿到的是「连不上，请手动处理」，
      // 而不是第 N 次「重连中…」。恢复入口已经在场（SessionPane 的 Resume / Check again）。
      this.publisher.publish({
        type: 'connection-state',
        state: 'unrecoverable',
        evidence: { source: 'run-process', observedAt: now }
      })
      return
    }
    this.reconnecting = true
    this.publisher.publish({
      type: 'connection-state',
      state: 'lost',
      evidence: { source: 'run-process', observedAt: now }
    })
    void this.reconnectLoop(epoch)
  }

  /**
   * 有界重连循环。界由纯函数 {@link runBoundedReconnect}/`nextReconnectStep` 给出（指数退避、封顶、
   * 有限次数），本方法只把「尝试一次连接」与「等待」接给它，并处理两种终局：
   *
   * - 连上了：重新订阅（open 内部已 re-subscribe kernel 事件），并**把各 run 的当前状态重新发出去**
   *   —— 重连不等于状态就对了，掉线期间 run 可能已退出/变化，必须按 daemon 的 list() 真相校正
   *   （见 republishLiveRunState）。再发 `connection-state: restored`。
   * - 用尽仍失败：发 `connection-state: unrecoverable`——响亮终局，不静默地永远转圈。
   */
  private async reconnectLoop(epoch: number): Promise<void> {
    const result = await runBoundedReconnect({
      attempt: async () => {
        if (epoch !== this.connectionEpoch) {
          throw new AgentMuxError('Reconnect superseded by a newer connection.', 'CTXMUX_DISCONNECTED')
        }
        await this.open(epoch)
      },
      sleep: (ms) => this.reconnectSleep(ms)
    })
    if (epoch !== this.connectionEpoch) {
      this.reconnecting = false
      return
    }
    this.reconnecting = false
    if (result.kind === 'reconnected') {
      await this.republishLiveRunState()
      // 这里刻意**不**重置 `connectionHealthySince`：唯一的写入点是 `open()` 成功那一句，重连成功
      // 走的正是同一条 `open()`，所以那边已经写过了。分两处各写一次的形状必然漂移（其中一条会漏掉
      // 某条路径），而缓刑期起点算错的后果是这道界静默失效，全绿。要改就改那一处。
      const restoredAt = Date.now()
      for (const runId of this.runPids.keys()) {
        const session = this.registry.findByRun(runRef(runId))
        if (session && !this.endedRuns.has(runId)) await this.persistActivityBoundary(session, 'restored', restoredAt)
      }
      this.publisher.publish({
        type: 'connection-state',
        state: 'restored',
        evidence: { source: 'run-process', observedAt: restoredAt }
      })
    } else {
      this.publisher.publish({
        type: 'connection-state',
        state: 'unrecoverable',
        evidence: { source: 'run-process', observedAt: Date.now() }
      })
    }
  }

  // 重连退避的等待。抽成一个可被测试覆盖的方法，让重连的「界」端到端可断言而不必等真实的秒级退避。
  protected reconnectSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
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
  private async republishLiveRunState(): Promise<void> {
    await this.withRunSnapshot(null, () => this.kernel.list(), async (runs, wasRemoved) => {
      this.backfillEndedRuns(runs.filter(run => !wasRemoved(run.runId)))
      for (const run of runs) {
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
    }
    this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
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
    this.publisher.publish({ type: 'agent-session', session: cloneSession(next),
      ...(observationOrigin ? { observationOrigin } : {}) })
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
      if (agentSession) this.invalidateEndedRunReadiness(agentSession, runRef(run.runId))
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
      this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
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
    this.cancelProviderReads()
    this.cancelNativeIdentityCaptures()
    this.connectionEpoch += 1
    this.connected = false
    this.connecting = null
    this.reconnecting = false
    this.unsubscribeKernel?.()
    this.unsubscribeKernel = null
    this.unsubscribeKernelErrors?.()
    this.unsubscribeKernelErrors = null
    this.unsubscribeConnectionLost?.()
    this.unsubscribeConnectionLost = null
    this.kernel.disconnect()
    this.runPids.clear()
    this.hookNativeWitnesses.clear()
    this.stopRequestedRuns.clear()
    this.endedRuns.clear()
    this.hookTurnPhases.clear()
    this.agentInputCursors.clear()
    for (const lane of this.agentInputTails.values()) {
      for (const observation of lane.renderObservations) observation.controller.abort()
    }
    this.agentInputTails.clear()
    this.promptSubmission.cancelAllReadiness()
    this.screenEvidence.discardAll()
  }

  async dispose(): Promise<void> {
    this.reopensDisposed = true
    this.providerReadsDisposed = true
    this.cancelProviderReads()
    for (const resources of this.historyObservationControllers.values()) {
      for (const resource of resources) resource.controller.abort(new AgentMuxError(
        'History observer client was disposed.', 'AGENT_SESSION_HISTORY_CANCELLED'))
    }
    await Promise.allSettled([...this.reopenSettlements.values()])
    await this.hookServer.stop()
    this.disconnect()
    await this.registry.releaseReopenOwner()
    await Promise.allSettled([...this.hookBindings.values()].map(async (binding) => await binding.close()))
    this.hookBindings.clear()
    this.pendingReopenBindings.clear()
    await this.acp.dispose()
    this.publisher.dispose()
  }

  /**
   * Registers a synchronous observation callback. Copy work into a
   * Consumer-owned bounded queue before returning if asynchronous handling is
   * required. Promise-returning callbacks are detached on their first event.
   */
  onEvent(listener: (event: AgentMuxClientEvent) => void): () => void {
    return this.publisher.onEvent(listener)
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
    return this.registry.list().map(cloneSession)
  }

  /** Current durable identities, without replacing the active registry or probing Runs. */
  async readAgentSessions(): Promise<AgentMuxAgentSession[]> {
    return (await loadAgentSessions(this.store)).map(cloneSession)
  }

  /** Durable capability validation for ingress; a long-lived client cannot cache authorization. */
  async authorizeRetainedAgentCaller(capability: string, callerAgentSessionId: string): Promise<AgentMuxAgentSession> {
    const current = await this.currentStoredAgentSession(callerAgentSessionId)
    this.resolveMessageAuthor(capability, callerAgentSessionId, current)
    return cloneSession(current)
  }

  /** The durable message owner shared by SDK delivery and public service ingress. */
  agentMessageQueuePath(): string {
    return this.messageQueue.path
  }

  agentSession(agentSessionId: string): AgentMuxAgentSession {
    return cloneSession(this.registry.get(agentSessionId))
  }

  /** Read one exact durable Session binding without starting, attaching or stopping its Run. */
  async refreshAgentSession(agentSessionId: string, expectedRun: AgentMuxRunRef): Promise<AgentMuxAgentSession> {
    this.requireConnected()
    const session = await this.registry.refresh(agentSessionId, expectedRun)
    this.hookNativeWitnesses.delete(session.run.runId)
    this.queueNativeIdentityCapture(session)
    return cloneSession(session)
  }

  private retainUnconfirmedLifecycle(error: unknown, expected: AgentMuxStoredAgentSession): AgentMuxStoredAgentSession {
    if (!(error instanceof AgentMuxSessionDurabilityError) || !error.replacementApplied) throw error
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
    if (session.hostId !== 'local' || (!unconfirmed && (session.nativeHandle || !provider.discoverNativeSession ||
      provider.catalog.resumeStrategy.kind !== 'provider-native')) || !this.connected || !this.kernel.isConnected()) return
    const previous = this.nativeIdentityCaptures.get(session.agentSessionId)
    if (previous && sameRun(previous.run, session.run)) return
    previous?.controller.abort()
    const controller = new AbortController(), epoch = this.connectionEpoch
    const capture = { controller, run: { ...session.run } }
    this.nativeIdentityCaptures.set(session.agentSessionId, capture)
    const execute = async (): Promise<void> => {
      const timer = setTimeout(() => controller.abort(new Error('Native identity capture timed out.')), 10_000)
      let failure: unknown
      try {
        for (const delayMs of [0, 200, 1_000]) {
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
                if (confirmed.nativeHandle || !provider.discoverNativeSession) return confirmed
              }
              return await captureAgentNativeSessionIdentity({ session, provider, registry: this.registry,
                kernel: this.kernel, signal: controller.signal, assertConnection,
                command: resolveAgentExecutable(options.commandOverride, provider.executable),
                args: options.args ?? [], env: options.env ?? {} })
            })()
            const next = await new Promise<AgentMuxStoredAgentSession>((resolve, reject) => {
              const abort = () => reject(controller.signal.reason)
              controller.signal.addEventListener('abort', abort, { once: true })
              attempt.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort))
              if (controller.signal.aborted) abort()
            })
            this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
            return
          } catch (error) {
            failure = error
            if (controller.signal.aborted) throw error
          }
        }
      } catch (error) { failure = error }
      finally { clearTimeout(timer) }
      if (epoch !== this.connectionEpoch || !this.connected || !this.kernel.isConnected()) return
      let current: AgentMuxStoredAgentSession
      try { current = this.registry.get(session.agentSessionId) } catch { return }
      if (!sameRun(current.run, session.run)) return
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : ''
      const persistence = ['EIO', 'ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS',
        'AGENT_SESSION_STORE_LIMIT', 'AGENT_SESSION_STORE_BUSY', 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED'].includes(code)
      this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
        code: persistence ? 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED' : 'AGENT_NATIVE_IDENTITY_UNCONFIRMED',
        message: `${persistence ? 'Saving the native recovery identity is unconfirmed.' : 'The native recovery identity could not be confirmed.'} ` +
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

  async sessionTimeline(agentSessionId: string): Promise<AgentTimelineSnapshot> {
    await this.historyDescriptor(agentSessionId)
    return await this.store.loadTimeline(agentSessionId)
  }

  /** Discover bounded retained sources without connecting to or controlling Runtime. */
  async sessionHistorySources(): Promise<AgentSessionHistoryDescriptor[]> {
    return await loadSessionHistorySources(this.store)
  }

  private async historyDescriptor(agentSessionId: string): Promise<AgentSessionHistoryDescriptor> {
    const descriptor = (await this.sessionHistorySources()).find(entry => entry.agentSessionId === agentSessionId)
    if (!descriptor) throw new AgentMuxError(`Unknown Agent Session: ${agentSessionId}`, 'UNKNOWN_AGENT_SESSION')
    return descriptor
  }

  /** Resolve current-source intent once; ordinary durable history remains independent of Runtime. */
  private async nativeHistoryBinding(
    agentSessionId: string,
    options: AgentSessionHistoryPageOptions,
    signal: AbortSignal,
    purpose: 'read' | 'observe'
  ): Promise<NativeHistoryBinding> {
    // A failed save is not permission to make observation and Page read different sources.
    // The witness belongs to the existing Consumer resource, never a Session source cache.
    if (purpose === 'read' && !options.refreshNativeSource) {
      const resources = [...(this.historyObservationControllers.get(agentSessionId) ?? [])]
        .filter(resource => !resource.controller.signal.aborted && resource.binding?.transient)
      if (resources.length) {
        const first = resources[0]!
        const binding = first.binding!
        if (resources.some(resource => !sameNativeHandle(resource.binding!.handle, binding.handle))) {
          throw new AgentMuxError('Current history observations disagree. The existing window is retained; refresh its source.',
            'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
        }
        const assertCurrent = async (): Promise<void> => {
          signal.throwIfAborted()
          if (first.controller.signal.aborted || first.binding !== binding) {
            throw new AgentMuxError('The temporary history observation was released. Refresh its source.',
              'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
          }
          await binding.assertCurrent()
          signal.throwIfAborted()
        }
        await assertCurrent()
        return { ...binding, assertCurrent }
      }
    }
    const descriptor = await this.historyDescriptor(agentSessionId)
    if (options.cursor === undefined && this.registry.has(agentSessionId)) this.hookNativeWitnesses.delete(this.registry.get(agentSessionId).run.runId)
    const session = descriptor.history
    if (!session) throw new AgentMuxError('No native history locator was retained for this Session.', 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
    const provider = this.providers.get(session.providerId)
    if (purpose === 'read' ? !provider.readSessionHistoryPage : !provider.observeSessionHistory) {
      throw new AgentMuxError('This Provider does not support this native history operation. Explicit reading remains available when supported.',
        purpose === 'read' ? 'AGENT_SESSION_HISTORY_UNSUPPORTED' : 'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED')
    }
    const retained = session.nativeHandle
    if (retained !== undefined && (retained.kind !== 'provider' || retained.providerId !== session.providerId)) {
      throw new AgentMuxError('The retained locator does not belong to this Provider history.',
        'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
    }
    let handle = retained
    let transient = false
    let original: AgentMuxStoredAgentSession | undefined
    let sharedOwner: AgentMuxStoredAgentSession | undefined
    let assertWitness: (() => Promise<void>) | undefined
    let strictWitness: (() => Promise<void>) | undefined
    const retainedAvailable = retained?.kind === 'provider' && retained.providerId === session.providerId
    const wantsCurrent = handle === undefined || purpose === 'observe' || options.refreshNativeSource === true
    const canDiscover = descriptor.state === 'active' && descriptor.hostId === 'local' && this.connected &&
      this.kernel.isConnected() && provider.discoverNativeSession !== undefined
    if (options.requireCurrentSource && !canDiscover) throw new AgentMuxError('This read cannot confirm the current native source. The retained history and healthy Agent input remain available.', 'AGENT_CURRENT_NATIVE_SOURCE_UNCONFIRMED')
    if (wantsCurrent && !canDiscover && handle === undefined) {
      throw new AgentMuxError('The native identity is not yet confirmed. Refresh can retry; the original Run is kept.',
        'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
    }
    if (wantsCurrent && canDiscover) {
      const epoch = this.connectionEpoch
      original = (await loadAgentSessions(this.store)).find(value => value.agentSessionId === agentSessionId)
      if (!original || original.hostId !== descriptor.hostId || original.providerId !== session.providerId ||
        original.workspacePath !== session.workspacePath || !sameNativeHandle(original.nativeHandle, retained)) {
        throw new AgentMuxError('The native Session binding changed before discovery.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
      }
      const expected = original
      const checkStored = async (): Promise<AgentMuxStoredAgentSession> => {
        signal.throwIfAborted()
        const records = await loadAgentSessions(this.store)
        const current = records.find(value => value.agentSessionId === agentSessionId)
        if (sharedOwner) {
          const owner = records.find(value => value.agentSessionId === sharedOwner!.agentSessionId)
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
      const diagnose = (message: string, identityUnconfirmed = false): void => this.publisher.publish({ type: 'agent-error', agentSessionId,
        code: 'AGENT_NATIVE_SOURCE_UNCONFIRMED',
        message: identityUnconfirmed
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
        const discovered = await provider.discoverNativeSession!({ processId: firstRun.pid,
          command: resolveAgentExecutable(options.commandOverride, provider.executable),
          args: options.args ?? [], env: options.env ?? {}, workspacePath: session.workspacePath, signal })
        signal.throwIfAborted()
        if (!discovered || discovered.handle.kind !== 'provider' || discovered.handle.providerId !== session.providerId ||
          normalizeNativeSessionId(discovered.handle.sessionId) !== discovered.handle.sessionId ||
          (discovered.handle.transcriptPath !== undefined &&
            normalizeNativeTranscriptPath(discovered.handle.transcriptPath) !== discovered.handle.transcriptPath)) {
          throw new AgentMuxError('No unique main native Session was confirmed. The original Run is kept.',
            'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
        }
        handle = { ...discovered.handle,
          ...(retained?.kind === 'provider' && retained.providerId === discovered.handle.providerId &&
            retained.sessionId === discovered.handle.sessionId && discovered.handle.transcriptPath === undefined &&
            retained.transcriptPath !== undefined ? { transcriptPath: retained.transcriptPath } : {}) }
        const protectsDifferentTarget = (value: AgentMuxStoredAgentSession): boolean =>
          (value.reopenedFrom !== undefined || value.nativeBinding?.source === 'semantic-resume-target') &&
          value.nativeHandle !== undefined && (value.nativeHandle.kind !== handle!.kind ||
            value.nativeHandle.sessionId !== handle!.sessionId ||
            (value.nativeHandle.kind === 'provider' && handle!.kind === 'provider' &&
              (value.nativeHandle.providerId !== handle!.providerId ||
                (value.nativeHandle.transcriptPath !== undefined && handle!.transcriptPath !== undefined &&
                  value.nativeHandle.transcriptPath !== handle!.transcriptPath))))
        assertWitness = async () => { await checkRun(); await discovered.assertCurrent(); await checkRun() }
        await assertWitness()
        if (options.requireCurrentSource) strictWitness = assertWitness
        const current = await checkRun()
        if (!sameNativeHandle(current.nativeHandle, handle) || current.observedNativeHandle !== undefined) {
          await this.registry.refresh(agentSessionId, expected.run)
          await assertWitness()
          let indexedOwner: AgentMuxStoredAgentSession | undefined
          try {
            indexedOwner = this.registry.resolve({ kind: 'provider-native', providerId: handle.providerId, sessionId: handle.sessionId })
          } catch (error) {
            if (!(error instanceof AgentMuxError) || error.code !== 'UNKNOWN_AGENT_SESSION_BINDING') throw error
          }
          const durableOwner = (await loadAgentSessions(this.store)).find(value => value.hostId === expected.hostId &&
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
            this.publisher.publish({ type: 'agent-session', session: cloneSession(observed) })
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
              const observedAt = Date.now()
              if (protectsDifferentTarget(value)) return { ...value, observedNativeHandle: handle!,
                updatedAt: Math.max(value.updatedAt, observedAt) }
              const next = { ...value, nativeHandle: handle!,
                nativeBinding: { source: value.reopenedFrom !== undefined || value.nativeBinding?.source === 'semantic-resume-target'
                  ? 'semantic-resume-target' as const : 'process-witness' as const,
                  run: { ...value.run }, observedAt }, updatedAt: Math.max(value.updatedAt, observedAt) }
              delete next.observedNativeHandle
              return next
            }, signal)
            this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
            if (protectsDifferentTarget(next)) throw new AgentMuxError(
              'The confirmed current source differs from the explicit semantic resume target. The target and retained records were kept; this refresh did not change the conversation.',
              'AGENT_NATIVE_IDENTITY_UNCONFIRMED')
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
        diagnose(error instanceof Error ? error.message : 'Provider source observation failed.', code === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')
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
      if (sameNativeHandle(current.nativeHandle, acceptedHandle)) {
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
      } else if (sameMetadata && sameNativeHandle(current.history!.nativeHandle, acceptedHandle)) {
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
    return { session, provider, handle: acceptedHandle, get transient() { return transient }, matches, assertCurrent }
  }

  /** Read existing Provider conversation history without controlling the Session's Run. */
  async sessionHistoryPage(
    agentSessionId: string,
    options: AgentSessionHistoryPageOptions = {}
  ): Promise<AgentSessionHistoryPage> {
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
      const binding = await read(this.nativeHistoryBinding(agentSessionId, options, controller.signal, 'read'))
      const { session, provider, handle } = binding
      if (!provider.readSessionHistoryPage) {
        throw new AgentMuxError('This Provider does not expose native conversation history.', 'AGENT_SESSION_HISTORY_UNSUPPORTED')
      }
      const source = { providerId: session.providerId, nativeSessionId: handle.sessionId }
      const page = await read(provider.readSessionHistoryPage({
        source, limit, signal: controller.signal,
        command: resolveAgentExecutable(options.commandOverride, provider.executable),
        args: options.args ?? [], env: options.env ?? {}, workspacePath: session.workspacePath,
        ...(handle.transcriptPath === undefined ? {} : { transcriptPath: handle.transcriptPath }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor })
      }))
      controller.signal.throwIfAborted()
      await read(binding.assertCurrent())
      return { agentSessionId, ...normalizeSessionHistoryPage(source, page, limit) }
    } finally {
      options.signal?.removeEventListener('abort', cancelled)
      lifetime.close()
    }
  }

  /** Observe an exact durable native source only while a Consumer needs it. No Runtime connection. */
  async observeSessionHistory(
    agentSessionId: string,
    listener: (observation: AgentSessionHistoryObservation) => void,
    options: AgentSessionHistoryObservationOptions = {}
  ): Promise<AgentSessionHistoryObservationHandle> {
    if (this.providerReadsDisposed) throw new AgentMuxError('History observer client was disposed.', 'AGENT_SESSION_HISTORY_CANCELLED')
    options.signal?.throwIfAborted()
    const controller = new AbortController()
    const resources = this.historyObservationControllers.get(agentSessionId) ?? new Set<NativeHistoryObservationResource>()
    this.historyObservationControllers.set(agentSessionId, resources)
    const resource: NativeHistoryObservationResource = { controller, binding: null }
    resources.add(resource)
    let observer: AgentSessionHistoryObservationHandle | undefined
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
      observer?.dispose()
      unsubscribe()
      options.signal?.removeEventListener('abort', cancel)
      resource.binding = null
      resources.delete(resource)
      if (!resources.size) this.historyObservationControllers.delete(agentSessionId)
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
      if (!provider.observeSessionHistory) {
        throw new AgentMuxError('This Provider does not support automatic native history observation. Explicit Refresh remains available.', 'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED')
      }
      const source = { providerId: session.providerId, nativeSessionId: handle.sessionId }
      unsubscribe = this.onEvent((event) => {
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
              notify({ kind: 'unavailable', agentSessionId, source,
                code: error instanceof AgentMuxError ? error.code : 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE',
                message: error instanceof Error ? error.message : 'The current native source could not be confirmed. Existing records and input are kept.' })
              controller.abort(error)
            }
          } finally { checkingChange = false }
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
    return cloneSession(this.registry.resolve(lookup))
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

  async runtimeDiagnostics(): Promise<AgentMuxRuntimeDiagnostics> {
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
  async runtimeResourceSnapshot(): Promise<AgentMuxRuntimeResourceSnapshot> {
    this.requireConnected()
    return await this.kernel.resourceSnapshot()
  }

  /** Read bounded storage facts for the original Run through its public Native owner. */
  async observeRunStorage(run: AgentMuxRunRef): Promise<AgentMuxRunStorageObservation> {
    this.requireConnected()
    const runtime = this.runtimeIdentity(), originalRun = { ...run }
    const observation = await this.kernel.observeStorage(originalRun.runId)
    return { ...observation, run: originalRun, runtime, observedAt: Date.now() }
  }

  async probeAgent(providerId: AgentProviderId, commandOverride?: string): Promise<AgentCapabilitySnapshot> {
    this.requireConnected()
    return await this.providers.get(providerId).probeCapabilities(
      { hasExecutable },
      commandOverride
    )
  }

  /**
   * 三态探测：这个 Executor 在本 Host 上是 available / missing / check-failed（环境退化）。
   *
   * 复用 Provider 自己的命令解析（commandOverride 优先，否则 catalog executable——那段逻辑住在
   * agent-provider 的 probeCapabilities 里，是唯一出处），只把它解析出的那条命令交给 classifyExecutable
   * 三态归类：`probeAgent` 里的 boolean `installed` 会把「查不成」折进「没装」，而发现列表必须区分二者
   * （那正是那次误报要防的）。启动路径仍走 `probeAgent().installed`（=== 'available'），行为不变。
   */
  async probeExecutorAvailability(providerId: AgentProviderId, commandOverride?: string): Promise<AgentMuxExecutorProbeResult> {
    this.requireConnected()
    // 借 probeCapabilities 的命令解析：它把解析后的命令传给 hasExecutable，我们截下那条命令再三态归类，
    // 不在这里重抄一份 commandOverride/catalog 的取舍（重抄一份就是第二处会漂移的命令解析）。
    let resolvedCommand: string | null = null
    await this.providers.get(providerId).probeCapabilities(
      { async hasExecutable(command) { resolvedCommand = command; return false } },
      commandOverride
    )
    if (resolvedCommand === null) throw new AgentMuxError('Executor availability probe did not resolve a command.', 'AGENT_NOT_FOUND')
    return await classifyExecutable(resolvedCommand)
  }

  private async withRunSnapshot<T, R>(target: string | null, read: () => Promise<T>,
    consume: (snapshot: T, wasRemoved: (runId: string) => boolean) => R | Promise<R>): Promise<R> {
    const removed = new Set<string>()
    const readers = this.pendingRunSnapshots.get(target) ?? new Set<Set<string>>()
    readers.add(removed)
    this.pendingRunSnapshots.set(target, readers)
    try {
      return await consume(await read(), runId => removed.has(runId))
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
    const runs = await this.listRuns()
    return {
      hostId: 'local',
      subjects: projectAgentMuxRuntimeSubjects('local', runs, this.registry.list().map(cloneSession))
    }
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
      agentSession ? [cloneSession(agentSession)] : [],
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
    const sessions = (await this.readAgentSessions()).filter(candidate => candidate.hostId === 'local')
    const session = sessions.find(candidate => candidate.agentSessionId === agentSessionId)
    if (!session) throw new AgentMuxError('Agent Session is unknown.', 'UNKNOWN_AGENT_SESSION')
    const run = await this.requireCurrentAgentRun(session, sessions)
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
      timelineCapability: capabilities.timeline,
      awaitingRequest: session.pendingInteraction !== undefined,
      terminalCapabilityUnverified: session.terminalCapability !== undefined
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

  async createTerminal(input: AgentMuxTerminalCreateInput): Promise<AgentMuxRun> {
    this.requireConnected()
    const run = await this.kernel.start({
      operationKey: input.createOperationId ?? randomUUID(),
      program: input.command ?? process.env.SHELL ?? '/bin/sh',
      args: input.args ?? [],
      cwd: input.workspacePath,
      env: terminalEnvironment({ ...input.env, AGENTMUX_MESSAGE_QUEUE_PATH: this.messageQueue.path }, this.agentSessionStorePath()),
      ...(input.cols === undefined ? {} : { cols: input.cols }),
      ...(input.rows === undefined ? {} : { rows: input.rows })
    })
    this.runPids.set(run.runId, run.pid)
    const projected = this.projectRun(run)
    this.publisher.publishRunState(projected)
    return projected
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
    view: AgentMuxRunAttachmentView = 'raw', operationId: string = randomUUID()): Promise<AgentMuxRunAttachment> {
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
    operation: AgentMuxRunInputOperation
  ): Promise<AgentMuxRunInputAck> {
    this.requireConnected()
    const accepted = await this.kernel.input(ref.runId, operation)
    const acceptedThroughByte = accepted.run.acceptedInputBytes
    if (acceptedThroughByte === null) {
      throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
    }
    return {
      runId: ref.runId,
      appliedByteRange: accepted.appliedByteRange,
      acceptedThroughByte
    }
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
    this.requireConnected()
    // Reserve the operation before recording intent. A failed preparation must
    // not leave a stale "user stopped" marker that misclassifies a later exit.
    const operation = await this.kernel.prepareStop(ref.runId)
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
    return cloneSession(caller)
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
  }

  /** Explicit consumption is durable and recipient-scoped, independent of input or human reading. */
  async checkDeliveries(input: {
    capability: string
    callerAgentSessionId: string
    limit: number
  }): Promise<AgentMuxDeliveryBatch> {
    this.requireConnected()
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
    this.requireConnected()
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
    const session = (await loadAgentSessions(this.store)).find((candidate) =>
      candidate.agentSessionId === agentSessionId && candidate.hostId === 'local')
    if (!session) throw new AgentMuxError('Agent Session is unknown.', 'UNKNOWN_AGENT_SESSION')
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
    return await this.messageQueue.openDispatch({ callerAgentSessionId: author, sourceMessageId: input.sourceMessageId },
      async (messages) => { await this.assertDispatchAdmission(input.capability, author, caller.run, messages) })
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
    return await this.messageQueue.recordDispatchEvent({ callerAgentSessionId: author,
      sourceMessageId: input.sourceMessageId, replyMessageId: input.replyMessageId, kind: input.kind },
    async (messages) => { await this.assertDispatchAdmission(input.capability, author, caller.run, messages) })
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

  private async assertDispatchAdmission(
    capability: string, author: string, expectedRun: AgentMuxRunRef,
    messages: readonly AgentMuxMessageEnvelope[]
  ): Promise<void> {
    // Admission runs inside the existing journal lock. The SessionStore is a separate authority,
    // not an atomic transaction with this journal; no Provider probe or Session write is added.
    const sessions = await loadAgentSessions(this.store)
    const current = sessions.find((session) => session.hostId === 'local' && session.agentSessionId === author)
    if (!current) throw new AgentMuxError('Dispatch caller Session is unknown.', 'UNKNOWN_AGENT_SESSION')
    this.resolveMessageAuthor(capability, author, current)
    if (!sameRun(current.run, expectedRun)) {
      throw new AgentMuxError('The Dispatch caller Run changed before admission.', 'AGENT_CAPABILITY_STALE_RUN')
    }
    for (const message of messages) {
      for (const [agentSessionId, runId] of [
        [message.senderSessionId, message.senderRunId], [message.recipientSessionId, message.recipientRunId]
      ]) {
        const participant = sessions.find((session) => session.hostId === 'local' && session.agentSessionId === agentSessionId)
        if (!participant || (participant.run.runId !== runId && !participant.retiredRuns.some((run) => run.runId === runId))) {
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
    this.requireConnected()
    if ('authorAgentSessionId' in input) throw new AgentMuxError('Agent authors must use an authenticated initial message.', 'MESSAGE_ENVELOPE_REQUIRED')
    if (input.prompt !== undefined) assertAgentPromptSize(input.prompt)
    const createOperationId = input.createOperationId ?? randomUUID()
    const agentSessionId = safeId(input.agentSessionId ?? (input.initialMessage
      ? await deriveAgentSessionId(createOperationId)
      : mintAgentSessionId()), 'Agent Session id')
    const executorId = safeId(input.executorId, 'Agent Executor id')
    let initialEnvelope: AgentMuxMessageEnvelope | undefined
    if (input.initialMessage) {
      if (!input.prompt?.trim()) throw new AgentMuxError('An initial Agent message needs a body.', 'INVALID_AGENT_PROMPT')
      const author = await this.currentStoredAgentSession(input.initialMessage.callerAgentSessionId)
      this.resolveMessageAuthor(input.initialMessage.capability, input.initialMessage.callerAgentSessionId, author)
      const messageId = input.initialMessage.threadId ? `${input.initialMessage.threadId}:0`
        : `initial-${createHash('sha256').update(createOperationId).digest('base64url').slice(0, 22)}`
      const queued = await this.messageQueue.append({
        messageId, operationId: createOperationId, createdAt: Date.now(),
        sender: { kind: 'agent-session', agentSessionId: author.agentSessionId },
        recipient: { kind: 'agent-session', agentSessionId },
        senderSessionId: author.agentSessionId, senderRunId: author.run.runId,
        recipientSessionId: agentSessionId, recipientRunId: null,
        threadId: input.initialMessage.threadId ?? messageId, correlationId: messageId,
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
        return { session: cloneSession(existing), promptConfirmed, creation: existing.creation }
      }
    }
    const originalPrompt = initialEnvelope ? renderAgentMuxMessageEnvelope(initialEnvelope) : input.prompt
    const lifecycleOperationId = agentLifecycleOperationIdentity(
      'create',
      agentSessionId,
      createOperationId
    )
    const reservation = await this.registry.reserveNew(agentSessionId, lifecycleOperationId)
    let hookBinding: AgentHookBinding | null = null
    let persisted: AgentMuxStoredAgentSession | null = null
    let abandonedRun: AgentMuxRunRef | null = null
    try {
      const provider = this.providers.get(input.providerId)
      // 这个 Run 的说话凭证。raw 只进受管进程的环境，Core 侧只留 hash。
      const invocationCapability = issueAgentCapability()
      const capability = await this.probeAgent(input.providerId, input.commandOverride)
      if (!capability.installed) {
        throw await executorUnavailableError(provider.label, capability.executable)
      }
      // `post-launch-only` 的 Provider 在启动期收不到任何 prompt（它的交互 UI 没有那个入口，
      // 见对应 Provider 模块的出处），所以**不给它组装启动 prompt**——交了只会被 buildLaunch
      // 拒绝，而运行时引导默认开、`composeAgentLaunchPrompt` 因此几乎总是非空，那等于这个
      // Provider 根本起不来。分流由 splitLaunchPromptByDelivery 唯一决定，两条生命周期路径共用；
      // 它同时交出 deferred 的那一半，下面必须真的送出去（见 deliverPostLaunchPrompt）。
      const composed = composeAgentLaunchPrompt(originalPrompt, input.injectAgentMuxGuide, input.agentMuxNote)
      assertAgentPromptSize(composed.text)
      const { atLaunch: launchPrompt, deferred: deferredPrompt } = splitLaunchPromptByDelivery(
        provider.catalog, composed.text
      )
      // Sealed launch options resolve to their argv core-side (fails closed on an un-declared choice) and
      // join the caller's args ahead of the prompt, exactly as buildArgs orders every other flag.
      const launchOptionArgv = provider.resolveLaunchArgv(input.launchOptions ?? {})
      const plan = provider.buildLaunch({
        workspacePath: input.workspacePath,
        prompt: launchPrompt,
        args: [...(input.args ?? []), ...launchOptionArgv],
        env: input.env ?? {},
        ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride })
      })
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
      const run = await this.kernel.start({
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
      })
      const launchOptions = normalizeLaunchOptionSelection(input.launchOptions)
      const now = Date.now()
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
        // 只存 hash：raw 凭证已随 env 进了受管进程，Core 这边不再留明文。
        capabilityHash: hashAgentCapability(invocationCapability),
        createdAt: now,
        updatedAt: now,
        creation: { createOperationId, initialPrompt: input.prompt?.trim() ? 'unknown' : 'not-requested' },
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
      try {
        try {
          persisted = await this.registry.commitLifecycle(reservation, session)
        } catch (error) {
          // The replacement is readable but lacks a durable acknowledgement. Keep its healthy Run.
          persisted = this.retainUnconfirmedLifecycle(error, session)
          readySession = persisted
        }
        await hookBinding.bindRun(run.runId)
        // 超时不回滚。下面的 catch 会关 hook 绑定、退休 run、删 session——那是在用我们一次
        // 慢探测杀掉一个刚启动好的健康 Agent。只有 run 真的退出了才该走那条路。
        readySession = await this.ensureTerminalHandshakeOrDegrade(readySession, run)
      } catch (error) {
        const rollbackErrors: unknown[] = [error]
        try {
          await hookBinding.close()
          await this.retireUncommittedRun(run.runId)
          abandonedRun = runRef(run.runId)
        }
        catch (cleanupError) { rollbackErrors.push(cleanupError) }
        if (persisted) {
          try {
            await this.registry.delete(agentSessionId, session.run)
            await this.registry.retireRuns([session.run])
            abandonedRun = null
          } catch (cleanupError) {
            rollbackErrors.push(cleanupError)
          }
        }
        if (rollbackErrors.length > 1) {
          throw new AggregateError(rollbackErrors, 'Agent Session persistence and Run rollback failed.')
        }
        throw error
      }
      this.hookBindings.set(run.runId, hookBinding)
      this.runPids.set(run.runId, run.pid)
      this.queueNativeIdentityCapture(readySession, input)
      this.publisher.publish({ type: 'agent-session', session: cloneSession(readySession) })
      this.publisher.publishRunState(this.projectRun(run, readySession), agentSessionId)
      // A deferred input receipt must precede the history's delivery status. A healthy Run remains
      // available when input confirmation fails; the retained history must not claim it was sent.
      const promptConfirmed = await this.deliverPostLaunchPrompt(
        provider, readySession, run, lifecycleOperationId, deferredPrompt, {
          ...(composed.systemContext ? { systemContext: composed.systemContext } : {}),
          ...(originalPrompt?.trim() ? { userContent: originalPrompt } : {}),
          ...(initialEnvelope?.senderSessionId ? { authorAgentSessionId: initialEnvelope.senderSessionId } : {})
        }
      )
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
            ...(initialEnvelope?.senderSessionId ? { authorAgentSessionId: initialEnvelope.senderSessionId } : {}) }
        )
      }
      const creation: NonNullable<AgentMuxAgentSession['creation']> = {
        createOperationId,
        initialPrompt: input.prompt?.trim() ? (promptConfirmed ? 'confirmed' : 'unconfirmed') : 'not-requested'
      }
      // Input has already happened. A save observation failure cannot revoke a healthy Run or
      // authorize sending again. Return the actual receipt; a later read keeps the durable unknown.
      try {
        readySession = await this.updateExactAgentSession(agentSessionId, session.run,
          current => ({ ...current, creation, updatedAt: Date.now() }))
        this.publisher.publish({ type: 'agent-session', session: cloneSession(readySession) })
      } catch {
        try { this.publisher.publish({ type: 'agent-error', agentSessionId,
          code: 'AGENT_CREATION_RECEIPT_UNCONFIRMED',
          message: 'Agent started, but saving its initial delivery receipt is unconfirmed. Read its response before submitting again.',
          evidence: { source: 'user', observedAt: Date.now(), run: session.run } }) } catch { /* Run remains usable. */ }
      }
      if (initialEnvelope) await this.recordInitialMessageDelivery(readySession, initialEnvelope, promptConfirmed)
      return { session: cloneSession(readySession), promptConfirmed, creation }
    } finally {
      if (hookBinding && ![...this.hookBindings.values()].includes(hookBinding)) await hookBinding.close()
      await this.registry.releaseLifecycle(reservation, abandonedRun ? [abandonedRun] : [])
    }
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
      session: cloneSession(session),
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
    const session = this.requireAgentSession(agentSessionId)
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
          publisher.publishRunEvent(event, cloneSession(session))
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
      return { session: cloneSession(session), attachment: { ...observation,
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
    const session = this.requireAgentSession(agentSessionId)
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

  // Per-Agent-Session serialization of continuity attempts. NOT what bounds new Runs to one — the
  // store's `reserveLifecycle` is an atomic check-and-set, so a concurrent loser fails its
  // reservation before ever reaching `kernel.start` even with this tail removed (measured).
  // What the tail buys is the loser's CLASSIFICATION: serialized behind the winner, its expectedRun
  // fence sees the Run already replaced and reports `session-run-changed` with `currentRun` pointing
  // at the real new Run. Run them concurrently and the loser's fence passes on the stale Run, then
  // trips the reservation and surfaces a bare `lifecycle-busy` carrying an outdated `currentRun` —
  // a worse answer to "why did my recovery not happen". Guarded by the concurrency tests in
  // agent-session-continuity.test.ts; deleting this makes them red on the reason, not on the count.
  async ensureAgentContinuity(
    input: AgentMuxAgentContinuityInput
  ): Promise<AgentMuxAgentContinuityResult> {
    this.requireConnected()
    safeId(input.agentSessionId, 'Agent Session id')
    safeId(input.operationId, 'Agent continuity operation id')
    const previous = this.agentContinuityTails.get(input.agentSessionId) ?? Promise.resolve()
    let result!: AgentMuxAgentContinuityResult
    const operation = previous.catch(() => {}).then(async () => {
      result = await this.performAgentContinuity(input)
    })
    const tail = operation.then(() => {}, () => {})
    this.agentContinuityTails.set(input.agentSessionId, tail)
    try {
      await operation
      return result
    } finally {
      if (this.agentContinuityTails.get(input.agentSessionId) === tail) {
        this.agentContinuityTails.delete(input.agentSessionId)
      }
    }
  }

  async resumeAgent(input: AgentMuxAgentResumeInput): Promise<AgentMuxAgentSession> {
    if (!input.prompt.trim() && !input.agentMuxNote?.trim()) throw new AgentMuxError('Agent resume prompt cannot be empty.', 'INVALID_AGENT_PROMPT')
    return await this.resumeAgentRun(input)
  }

  /** Explicitly continue an exact retired native conversation; reading history never calls this. */
  async reopenAgent(input: AgentMuxAgentReopenInput): Promise<AgentMuxAgentSession> {
    if (this.reopensDisposed) throw new AgentMuxError('This continue owner has been disposed. Use the current Core client.', 'AGENT_REOPEN_OWNER_DISPOSED', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
    const fields = ['agentSessionId', 'expectedRetiredAt', 'operationId', 'args', 'env', 'commandOverride', 'launchOptions', 'cols', 'rows']
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !fields.includes(key)) ||
      !Number.isSafeInteger(input.expectedRetiredAt) || input.expectedRetiredAt < 0 ||
      typeof input.agentSessionId !== 'string' || !input.agentSessionId || input.agentSessionId === 'self' ||
      (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string'))) ||
      (input.env !== undefined && (!input.env || typeof input.env !== 'object' || Array.isArray(input.env) || Object.values(input.env).some(value => typeof value !== 'string'))) ||
      (input.commandOverride !== undefined && (typeof input.commandOverride !== 'string' || !input.commandOverride))) {
      throw new AgentMuxError('Explicit continue requires the exact retired Session and valid current launch configuration.', 'INVALID_AGENT_REOPEN', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
    }
    const operation = agentLifecycleOperationIdentity('reopen', input.agentSessionId, safeId(input.operationId, 'Agent reopen operation id'))
    if (this.executingReopens.has(operation)) throw this.reopenUnconfirmed('The original continue operation is still executing.')
    this.executingReopens.add(operation)
    let settle!: () => void
    this.reopenSettlements.set(operation, new Promise<void>(resolve => { settle = resolve }))
    try { return await this.resumeAgentRun(input, undefined, undefined, input) }
    catch (error) {
      if (error instanceof AgentMuxError && !error.controlFailure &&
        ['STALE_AGENT_SESSION', 'CTXMUX_DISCONNECTED', 'INVALID_AGENT_SESSION_ID'].includes(error.code)) {
        throw new AgentMuxError(error.message, error.code, error.detail, { disposition: 'not_applied', confirmedInputBytes: null })
      }
      throw error
    } finally { this.executingReopens.delete(operation); this.reopenSettlements.delete(operation); settle() }
  }

  /** Complete an explicitly requested original operation; never launches, inputs or stops a Run. */
  async reconcileAgentReopen(input: Pick<AgentMuxAgentReopenInput, 'agentSessionId' | 'expectedRetiredAt' | 'operationId'>): Promise<AgentMuxAgentSession> {
    if (this.reopensDisposed) throw this.reopenUnconfirmed('This continue owner has been disposed. Confirm the original operation through the current Core client.')
    this.requireConnected()
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['agentSessionId', 'expectedRetiredAt', 'operationId'].includes(key)) ||
      typeof input.agentSessionId !== 'string' || !input.agentSessionId || !Number.isSafeInteger(input.expectedRetiredAt) || input.expectedRetiredAt < 0) {
      throw new AgentMuxError('Original continue confirmation requires its exact identity.', 'INVALID_AGENT_REOPEN', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
    }
    const operationId = agentLifecycleOperationIdentity('reopen', input.agentSessionId, safeId(input.operationId, 'Agent reopen operation id'))
    if (this.executingReopens.has(operationId)) throw this.reopenUnconfirmed('The original continue operation is still executing.')
    this.executingReopens.add(operationId)
    let settle!: () => void
    this.reopenSettlements.set(operationId, new Promise<void>(resolve => { settle = resolve }))
    try {
      const canonical = (await loadAgentSessions(this.store)).find(session => session.agentSessionId === input.agentSessionId)
      if (canonical) {
        const run = await this.kernel.status(canonical.run.runId)
        if (canonical.reopenedFrom?.observedAt !== input.expectedRetiredAt || run.lifecycleOperationId !== operationId) {
          throw this.reopenUnconfirmed('The Session has a different current lifecycle operation. Read its actual state.')
        }
        await this.registry.load('local')
        await this.restoreReopenObservation(canonical, run, operationId)
        return cloneSession(this.registry.get(canonical.agentSessionId))
      }
      const reservation = await this.registry.claimReopen(input.agentSessionId, operationId, input.expectedRetiredAt)
      if (!reservation) throw this.reopenUnconfirmed('The original continue result has not been confirmed.')
      return cloneSession(await this.completePreparedReopen(reservation, await this.kernel.list()))
    } catch (error) {
      if (error instanceof AgentMuxError && error.controlFailure) throw error
      throw this.reopenUnconfirmed(error instanceof Error ? error.message : String(error))
    } finally { this.executingReopens.delete(operationId); this.reopenSettlements.delete(operationId); settle() }
  }

  private reopenUnconfirmed(message: string): AgentMuxError {
    return new AgentMuxError(message, 'AGENT_REOPEN_UNCONFIRMED', undefined, { disposition: 'unknown', confirmedInputBytes: null })
  }

  private async completePreparedReopen(
    reservation: Extract<AgentMuxLifecycleReservation, { kind: 'reopen' }>, runs: readonly CtxmuxAdapterRun[]
  ): Promise<AgentMuxStoredAgentSession> {
    const prepared = reservation.preparedSession
    const candidates = runs.filter(run => run.lifecycleOperationId === reservation.operationId)
    if (!prepared || candidates.length !== 1 || candidates[0]!.workspacePath !== prepared.workspacePath ||
      candidates[0]!.runId === reservation.expectedRetirement.run.runId) {
      throw this.reopenUnconfirmed('The original continue has no single confirmed matching Run. Keep its history and check again.')
    }
    const run = candidates[0]!, retirement = reservation.expectedRetirement
    const nativeBindingObservedAt = Date.now()
    const next: AgentMuxStoredAgentSession = { ...structuredClone(prepared), run: runRef(run.runId), retiredRuns: [retirement.run],
      reopenedFrom: { run: retirement.run, source: retirement.source, observedAt: retirement.observedAt }, updatedAt: Math.max(prepared.updatedAt + 1, nativeBindingObservedAt),
      ...(prepared.nativeHandle ? { nativeBinding: { source: 'semantic-resume-target' as const, run: runRef(run.runId), observedAt: nativeBindingObservedAt } } : {}) }
    // A lost start ACK cannot reconstruct a pre-start Provider observation.
    delete next.nativePromptPredecessor
    try { await this.registry.commitLifecycle(reservation, next) }
    catch (error) {
      const canonical = (await loadAgentSessions(this.store)).find(session => session.agentSessionId === prepared.agentSessionId)
      if (!canonical || canonical.run.runId !== run.runId || JSON.stringify(canonical.reopenedFrom) !== JSON.stringify(next.reopenedFrom)) throw error
      await this.registry.load('local')
    }
    await this.restoreReopenObservation(this.registry.get(next.agentSessionId), run, reservation.operationId)
    return this.registry.get(next.agentSessionId)
  }

  private async restoreReopenObservation(session: AgentMuxStoredAgentSession, run: CtxmuxAdapterRun, operationId: string): Promise<void> {
    try {
      if (!this.hookBindings.has(run.runId)) {
        await this.requireHookIngressOwner()
        const binding = this.pendingReopenBindings.get(operationId) ?? this.hookServer.createBinding(
          session.agentSessionId, session.providerId, session.hookBindingId, session.hookToken)
        this.pendingReopenBindings.set(operationId, binding)
        await binding.bindRun(run.runId)
        this.hookBindings.set(run.runId, binding)
        this.pendingReopenBindings.delete(operationId)
      }
    } catch (error) {
      this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
        code: 'AGENT_REOPEN_OBSERVATION_UNCONFIRMED',
        message: `The original conversation has Run ${run.runId}; its Hook observation is unconfirmed. Keep this Run and check again. ${error instanceof Error ? error.message : String(error)}`,
        evidence: { source: 'agentmux', observedAt: Date.now() } })
    }
    this.runPids.set(run.runId, run.pid)
    this.publisher.publish({ type: 'agent-session', session: cloneSession(this.registry.get(session.agentSessionId)) })
    this.publisher.publishRunState(this.projectRun(run, this.registry.get(session.agentSessionId)), session.agentSessionId)
  }

  private async resumeAgentRun(
    input: AgentMuxAgentResumeOperationInput,
    expectedRun?: AgentMuxRunRef,
    knownCapability?: AgentCapabilitySnapshot,
    reopening?: AgentMuxAgentReopenInput
  ): Promise<AgentMuxAgentSession> {
    this.requireConnected()
    const previous = reopening ? undefined : this.requireAgentSession(input.agentSessionId)
    if (expectedRun && previous && !sameRun(previous.run, expectedRun)) {
      throw new AgentMuxError('Agent Session changed before native resume.', 'STALE_AGENT_SESSION')
    }
    const composed = composeAgentPrompt(input.prompt, input.agentMuxNote)
    assertAgentPromptSize(composed.text)
    const prompt = composed.text || undefined
    const message: AgentPromptMessageContent = {
      ...(composed.systemContext ? { systemContext: composed.systemContext } : {}),
      ...(input.prompt?.trim() ? { userContent: input.prompt } : {})
    }
    const lifecycleOperationId = agentLifecycleOperationIdentity(
      reopening ? 'reopen' : 'resume', input.agentSessionId,
      safeId(input.operationId, 'Agent resume operation id')
    )
    let reservation = reopening
      ? await this.registry.reserveReopen(input.agentSessionId, reopening.expectedRetiredAt, lifecycleOperationId, input.operationId)
      : await this.registry.reserveExisting('resume', previous!.agentSessionId, previous!.run, lifecycleOperationId)
    let hookBinding: AgentHookBinding | null = null
    let persisted: AgentMuxStoredAgentSession | null = null
    let abandonedRun: AgentMuxRunRef | null = null
    let operationError: unknown = null
    let preserveUnconfirmedRun = false
    let launchAttempted = false
    let hookBound = false
    try {
      const retirement = reservation.kind === 'reopen' ? reservation.expectedRetirement : undefined
      if (retirement && (!retirement.history || retirement.hostId !== 'local')) {
        throw new AgentMuxError('The original retired native identity is unavailable on this Host.', 'AGENT_RESUME_UNAVAILABLE')
      }
      const current = previous ?? {
        ...retirement!.history!, kind: 'agent' as const, agentSessionId: retirement!.agentSessionId,
        hostId: retirement!.hostId, run: retirement!.run, retiredRuns: [],
        updatedAt: retirement!.observedAt,
        ...(retirement!.activityCommit === undefined ? {} : { activityCommit: structuredClone(retirement!.activityCommit) }),
        ...(reopening?.launchOptions === undefined ? {} : { launchOptions: reopening.launchOptions })
      }
      if (!current.nativeHandle || current.nativeHandle.kind !== 'provider') {
        throw new AgentMuxError('Provider-native resume requires a verified provider session handle.', 'AGENT_RESUME_UNAVAILABLE')
      }
      if ('observedNativeHandle' in current && current.observedNativeHandle && current.observedNativeHandle.sessionId !== current.nativeHandle.sessionId) {
        throw new AgentMuxError('The retained native resume target differs from this Run’s confirmed native source. Confirm the original target; no new Run was started.', 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')
      }
      let oldRun: CtxmuxAdapterRun | null = null
      try {
        oldRun = await this.kernel.status(current.run.runId)
        if (retirement) {
          if (oldRun.runId !== retirement.run.runId || oldRun.workspacePath !== current.workspacePath) {
            throw new AgentMuxError('The retired Run no longer matches its original native Session.', 'AGENT_SESSION_RUN_MISMATCH')
          }
        } else this.assertAgentRun(current, oldRun)
      } catch (error) {
        if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_run_not_found') throw error
      }
      if (oldRun?.state.type === 'running') {
        throw new AgentMuxError('Cannot resume while the original Run is still running.', 'AGENT_SESSION_STILL_RUNNING')
      }
      const provider = this.providers.get(current.providerId)
      if (reopening && provider.catalog.resumeStrategy.kind !== 'provider-native') {
        throw new AgentMuxError('This Provider does not support continuing its retired native conversation.', 'AGENT_RESUME_UNAVAILABLE')
      }
      // resume 换了 Run，就换一枚凭证——旧 Run 的那枚随之作废，不能再以此 Agent 名义说话。
      const invocationCapability = issueAgentCapability()
      const capability = knownCapability ?? await this.probeAgent(current.providerId, input.commandOverride)
      if (!capability.installed) {
        throw await executorUnavailableError(provider.label, capability.executable)
      }
      // Re-resolve the posture the create fixed and append it to the resume args exactly as createAgent
      // does, so the sandbox/approval/permission-mode flags survive the stop/resume boundary rather than
      // reverting to the Provider's more permissive default. buildResumeArgs orders these per provider
      // (codex places them after the positional prompt, claude before) and the positional prompt is a
      // distinct token, so intermixing the option flags stays CLI-valid.
      const resumeLaunchOptionArgv = provider.resolveLaunchArgv(current.launchOptions ?? {})
      // 与 launch 同一条判据、同一个函数：`post-launch-only` 的 Provider 续跑时也收不到启动期
      // prompt，于是不把它交给 buildResumeLaunch（交了只会被拒），改在下面进程起来之后键入。
      const { atLaunch: launchTimePrompt, deferred: deferredResumePrompt } =
        splitLaunchPromptByDelivery(provider.catalog, prompt ?? '')
      const plan = provider.buildResumeLaunch({
        workspacePath: current.workspacePath,
        nativeHandle: current.nativeHandle,
        ...(launchTimePrompt ? { prompt: launchTimePrompt } : {}),
        args: [...(input.args ?? []), ...resumeLaunchOptionArgv],
        env: input.env ?? {},
        ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride })
      })
      await this.requireHookIngressOwner()
      await this.hookBindings.get(current.run.runId)?.close()
      this.hookBindings.delete(current.run.runId)
      hookBinding = this.hookServer.createBinding(
        current.agentSessionId,
        current.providerId,
        hookBindingIdentity(lifecycleOperationId)
      )
      // resume 换新 Run 就换新凭证（见下面 `hookToken` 那行），所以把**投递代码写进文件**的
      // Provider 必须在这里重装：opencode 的插件里 URL 与 token 是写盘时内联的字面量，磁盘上
      // 那份仍拿着刚被 delete 掉的旧 token，而 ingress 对认不出的 token 一律 403
      // （hook-server.ts 的 `if (!binding) respond(403)`）。少了这一次重装，resume 之后
      // OpenCode 的每条状态事件都被静默拒收：Agent 永远不 done、完成通知永不触发，且没有
      // 任何报错——插件"装着"，只是每条都 403。
      //
      // 对写命令的那九家是幂等 no-op（内容不含 token，`ensure` 见 hash 相同便不碰盘），
      // 对 pi 也是（它运行时从自己进程的环境变量取值，token 一个字节都不落盘）。
      await this.ensureManagedHooks(
        provider,
        current.workspacePath,
        current.agentSessionId,
        input.env ?? {},
        hookBinding.endpoint
      )
      if (reservation.kind === 'reopen') {
        const preparedSession: AgentMuxStoredAgentSession = { ...current, kind: 'agent', run: current.run, retiredRuns: [],
          hookBindingId: hookBinding.bindingId, hookToken: hookBinding.endpoint.token,
          capabilityHash: hashAgentCapability(invocationCapability), updatedAt: Date.now(), nativeHandle: structuredClone(current.nativeHandle) }
        delete preparedSession.nativePromptPredecessor
        reservation = await this.registry.prepareReopen(reservation, preparedSession)
        this.pendingReopenBindings.set(lifecycleOperationId, hookBinding)
      }
      if (reopening && this.reopensDisposed) throw new AgentMuxError('Continue owner was disposed before dispatch.', 'AGENT_REOPEN_OWNER_DISPOSED', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
      // The Provider's old turn belongs to the Run that just ended, even when its
      // transcript has no native completion/abort. Freeze it before the new writer
      // starts; an unknown observation never prevents healthy native restoration.
      const nativePromptEvidence = provider.readPromptExecutionEvidence
        ? await provider.readPromptExecutionEvidence({ args: oldRun?.args ?? [], workspacePath: current.workspacePath,
          nativeHandle: current.nativeHandle }).catch(error => {
          this.publisher.publish({ type: 'agent-error', agentSessionId: current.agentSessionId,
            code: 'AGENT_NATIVE_SOURCE_UNCONFIRMED',
            message: `The previous native turn could not be observed. Native restoration and ordinary input remain available; immediate input needs current source confirmation. ${error instanceof Error ? error.message : String(error)}`,
            evidence: { source: 'agentmux', run: { ...current.run }, observedAt: Date.now() } })
          return null
        }) : null
      launchAttempted = true
      const run = await this.kernel.start({
        operationKey: lifecycleOperationId,
        program: plan.command,
        args: plan.args,
        cwd: current.workspacePath,
        env: this.agentEnvironment(
          plan.env,
          current.agentSessionId,
          current.providerId,
          current.executorId,
          hookBinding,
          lifecycleOperationId,
          invocationCapability
        ),
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows })
      }).catch(error => {
        if (reopening && !(error instanceof AgentMuxError && error.controlFailure?.disposition === 'not_applied')) {
          // A lost start ACK may already own a Run. Keep the one reservation until authoritative reconciliation.
          preserveUnconfirmedRun = true
          throw new AgentMuxError(`Continue start is unconfirmed. Read the original Session; no operation was resent. ${error instanceof Error ? error.message : String(error)}`,
            'AGENT_REOPEN_UNCONFIRMED', undefined, { disposition: 'unknown', confirmedInputBytes: null })
        }
        throw error
      })
      const nativeBindingObservedAt = Date.now()
      const next: AgentMuxStoredAgentSession = {
        ...current,
        kind: 'agent',
        ...(retirement ? { reopenedFrom: { run: { ...retirement.run }, source: retirement.source, observedAt: retirement.observedAt } } : {}),
        run: runRef(run.runId),
        retiredRuns: [...current.retiredRuns, current.run].slice(-16),
        hookBindingId: hookBinding.bindingId,
        hookToken: hookBinding.endpoint.token,
        // 新 Run 换新凭证：旧 Run 的那枚从此认不出来，无法再以此 Agent 名义说话。
        capabilityHash: hashAgentCapability(invocationCapability),
        updatedAt: Math.max(current.updatedAt + 1, nativeBindingObservedAt),
        nativeHandle: structuredClone(current.nativeHandle),
        nativeBinding: { source: 'semantic-resume-target', run: runRef(run.runId), observedAt: nativeBindingObservedAt }
      }
      delete next.observedNativeHandle
      delete next.nativePromptPredecessor
      if (nativePromptEvidence) next.nativePromptPredecessor = {
        run: runRef(run.runId), previousRun: { ...current.run },
        sourceId: nativePromptEvidence.sourceId, evidenceId: nativePromptEvidence.id
      }
      delete next.hookReceipt
      delete next.terminalHandshake
      delete next.terminalCapability
      delete next.terminalPromptReadiness
      delete next.promptCompletionAdmission
      delete next.terminalPromptSubmission
      delete next.terminalPromptDelivery
      delete next.terminalOutputChannel
      delete next.semanticStatus
      delete next.pendingInteraction
      if (
        !prompt &&
        (input.args?.length ?? 0) === 0 &&
        provider.terminalHandshake &&
        provider.terminalPromptRender
      ) {
        const handshakeOperationId = terminalHandshakeOperationIdentity(
          next.providerId,
          next.run.runId,
          provider.terminalHandshake
        )
        next.terminalPromptReadiness = {
          source: 'initial-composer',
          id: terminalInitialPromptReadinessIdentity(next, handshakeOperationId),
          run: { ...next.run },
          outputCursorBytes: 0
        }
      }
      let readySession = next
      try {
        try { persisted = await this.registry.commitLifecycle(reservation, next) }
        catch (error) { persisted = this.retainUnconfirmedLifecycle(error, next); readySession = persisted }
        await hookBinding.bindRun(run.runId)
        hookBound = true
        // 同 launch：超时降级，只有 run 退出才回滚。
        readySession = await this.ensureTerminalHandshakeOrDegrade(
          retirement ? this.registry.get(current.agentSessionId) : readySession, run)
      } catch (error) {
        if (reopening) {
          const recoveredCommit = !persisted
          if (!persisted) {
            try {
              const canonical = (await loadAgentSessions(this.store)).find(session => session.agentSessionId === current.agentSessionId)
              if (canonical?.run.runId === run.runId && canonical.reopenedFrom && canonical.reopenedFrom.observedAt === retirement!.observedAt &&
                canonical.reopenedFrom.run.runId === retirement!.run.runId) {
                await this.registry.load('local')
                persisted = this.registry.get(current.agentSessionId)
              }
            } catch (readError) {
              // Unknown commit acknowledgement cannot authorize stopping a possibly committed healthy Run.
              preserveUnconfirmedRun = true
              this.pendingReopenBindings.set(lifecycleOperationId, hookBinding)
              throw new AggregateError([error, readError], 'Continue result is unconfirmed. Read the same Session; no operation was resent.')
            }
          }
          if (persisted) {
            if (hookBound) this.hookBindings.set(run.runId, hookBinding)
            else this.pendingReopenBindings.set(lifecycleOperationId, hookBinding)
            readySession = this.registry.get(current.agentSessionId)
            let observationError: unknown = error
            if (recoveredCommit) {
              try {
                await hookBinding.bindRun(run.runId)
                hookBound = true
                this.hookBindings.set(run.runId, hookBinding)
                this.pendingReopenBindings.delete(lifecycleOperationId)
                readySession = await this.ensureTerminalHandshakeOrDegrade(readySession, run)
                observationError = null
              } catch (readError) { observationError = readError }
            }
            if (observationError !== null) this.publisher.publish({ type: 'agent-error', agentSessionId: current.agentSessionId,
              code: 'AGENT_REOPEN_OBSERVATION_UNCONFIRMED',
              message: `The original conversation continued on Run ${run.runId}, but its Hook or terminal observation is unconfirmed. Keep this Run and refresh its observation. ${observationError instanceof Error ? observationError.message : String(observationError)}`,
              evidence: { source: 'agentmux', observedAt: Date.now() } })
          } else {
            const failures: unknown[] = [error]
            try { await hookBinding.close(); await this.retireUncommittedRun(run.runId); abandonedRun = runRef(run.runId) }
            catch (cleanupError) { preserveUnconfirmedRun = true; failures.push(cleanupError) }
            if (failures.length > 1) throw new AggregateError(failures, 'Continue preparation and cleanup are unconfirmed. Retained history is kept.')
            throw error
          }
        } else {
        const rollbackErrors: unknown[] = [error]
        try {
          await hookBinding.close()
          await this.retireUncommittedRun(run.runId)
          abandonedRun = runRef(run.runId)
        }
        catch (cleanupError) { rollbackErrors.push(cleanupError) }
        if (persisted && previous) {
          try {
            const restored = await this.registry.update(current.agentSessionId, next.run, failed => {
              const restored: AgentMuxStoredAgentSession = {
              ...previous,
              retiredRuns: [...previous.retiredRuns, next.run].slice(-16),
              // Renderer Run fences require a strictly newer canonical transition, even within
              // one clock tick or after a concurrent update of the failed binding.
              updatedAt: Math.max(Date.now(), failed.updatedAt + 1, next.updatedAt + 1)
              }
              delete restored.nativePromptPredecessor
              return restored
            })
            this.publisher.publish({ type: 'agent-session', session: cloneSession(restored) })
            if (oldRun) this.publisher.publishRunState(this.projectRun(oldRun, restored), restored.agentSessionId)
            abandonedRun = null
          } catch (cleanupError) {
            rollbackErrors.push(cleanupError)
          }
        }
        if (rollbackErrors.length > 1) {
          throw new AggregateError(rollbackErrors, 'Resume persistence and Run rollback failed.')
        }
        throw error
        }
      }
      if (hookBound) this.hookBindings.set(run.runId, hookBinding)
      this.runPids.delete(current.run.runId)
      this.runPids.set(run.runId, run.pid)
      this.queueNativeIdentityCapture(readySession, input)
      this.publisher.publish({ type: 'agent-session', session: cloneSession(readySession) })
      this.publisher.publishRunState(this.projectRun(run, readySession), readySession.agentSessionId)
      // A deferred input receipt must precede the history's delivery status. A healthy Run remains
      // available when input confirmation fails; the retained history must not claim it was sent.
      const promptConfirmed = await this.deliverPostLaunchPrompt(
        provider, readySession, run, lifecycleOperationId, deferredResumePrompt, message
      )
      await this.recordPromptMessageAfterSideEffect(readySession, lifecycleOperationId, 'Resume prompt', message,
        promptConfirmed ? 'complete' : 'failed')
      return cloneSession(readySession)
    } catch (error) {
      operationError = error
      if (reopening && !preserveUnconfirmedRun && !persisted && (!launchAttempted || abandonedRun)) {
        throw new AgentMuxError(error instanceof Error ? error.message : String(error),
          error instanceof AgentMuxError ? error.code : 'AGENT_REOPEN_NOT_APPLIED',
          error instanceof AgentMuxError ? error.detail : undefined,
          { disposition: 'not_applied', confirmedInputBytes: null })
      }
      throw error
    } finally {
      const cleanupErrors: unknown[] = []
      if (hookBinding && !preserveUnconfirmedRun && ![...this.hookBindings.values()].includes(hookBinding) &&
        !(persisted && this.pendingReopenBindings.get(lifecycleOperationId) === hookBinding)) {
        try {
          await hookBinding.close()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        if (!preserveUnconfirmedRun) {
          if (!persisted || hookBound) this.pendingReopenBindings.delete(lifecycleOperationId)
          await this.registry.releaseLifecycle(reservation, abandonedRun ? [abandonedRun] : [])
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          operationError === null ? cleanupErrors : [operationError, ...cleanupErrors],
          'Resume lifecycle cleanup failed.'
        )
      }
    }
  }

  private async performAgentContinuity(
    input: AgentMuxAgentContinuityInput
  ): Promise<AgentMuxAgentContinuityResult> {
    let current: AgentMuxStoredAgentSession | null = null
    try {
      current = this.registry.get(input.agentSessionId)
    } catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'UNKNOWN_AGENT_SESSION') throw error
    }

    if (current && !sameRun(current.run, input.expectedRun)) {
      return {
        kind: 'conflict',
        agentSessionId: input.agentSessionId,
        previousRun: { ...input.expectedRun },
        currentRun: { ...current.run },
        reason: 'session-run-changed',
        evidence: { kind: 'agent-session-store' }
      }
    }

    let run: AgentMuxRun | null = null
    if (current) {
      try {
        const observed = await this.kernel.status(current.run.runId)
        this.assertAgentRun(current, observed)
        run = this.projectRun(observed, current)
      } catch (error) {
        if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_run_not_found') throw error
      }
    }

    const catalog = current ? this.providers.get(current.providerId).catalog : null
    // A Session can be absent here after an explicit stop while its retirement record still proves
    // that this exact identity was intentionally retired.  Preserve that record's Host when feeding
    // the continuity decision; hard-coding `local` makes a remote retirement look like an unrelated
    // unknown Session and loses the only honest terminal classification.
    const retirement = this.registry.retiredAgentSession(
      input.agentSessionId,
      input.expectedRun
    )
    const handle = current?.nativeHandle
    const canProbe = run?.state !== 'running' && catalog?.resumeStrategy.kind === 'provider-native' &&
      handle?.kind === 'provider' &&
      handle.providerId === current?.providerId &&
      (catalog.resumeStrategy.locator !== 'transcript-path' || Boolean(handle.transcriptPath))
    const capability = canProbe
      ? await this.probeAgent(current!.providerId, input.commandOverride)
      : null
    const decision = decideAgentSessionContinuity({
      agentSessionId: input.agentSessionId,
      hostId: current?.hostId ?? retirement?.hostId ?? 'local',
      expectedRun: input.expectedRun,
      observedAt: Date.now(),
      session: current ? cloneSession(current) : null,
      retirement: retirement ? structuredClone(retirement) : null,
      run,
      catalog,
      capability
    })
    if (decision.kind === 'reattachable' && current && input.env !== undefined) {
      await this.ensureManagedHooks(
        this.providers.get(current.providerId),
        current.workspacePath,
        current.agentSessionId,
        input.env,
        this.hookBindings.get(current.run.runId)?.endpoint
      )
    }
    if (decision.kind !== 'resume') return decision

    try {
      await this.requireHookIngressOwner()
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'HOOK_INGRESS_BUSY') {
        return {
          kind: 'conflict',
          agentSessionId: input.agentSessionId,
          previousRun: { ...input.expectedRun },
          reason: 'lifecycle-busy',
          evidence: { kind: 'hook-ingress-owner' }
        }
      }
      throw error
    }

    try {
      const session = await this.resumeAgentRun({
        agentSessionId: input.agentSessionId,
        operationId: input.operationId,
        ...(input.args === undefined ? {} : { args: input.args }),
        ...(input.env === undefined ? {} : { env: input.env }),
        ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride }),
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows })
      }, input.expectedRun, capability ?? undefined)
      return {
        kind: 'resumed',
        session,
        previousRun: { ...input.expectedRun },
        run: { ...session.run },
        evidence: {
          kind: 'provider-native',
          providerId: decision.nativeHandle.providerId,
          nativeSessionId: decision.nativeHandle.sessionId,
          previousRun: decision.evidence
        }
      }
    } catch (error) {
      if (
        error instanceof AgentMuxError &&
        (
          error.code === 'AGENT_SESSION_BUSY' ||
          error.code === 'STALE_AGENT_SESSION' ||
          error.code === 'UNKNOWN_AGENT_SESSION'
        )
      ) {
        if (error.code !== 'AGENT_SESSION_BUSY') await this.registry.load('local')
        const retired = this.registry.retiredAgentSession(
          input.agentSessionId,
          input.expectedRun
        )
        if (retired) {
          return {
            kind: 'retired',
            agentSessionId: input.agentSessionId,
            previousRun: { ...input.expectedRun },
            evidence: { kind: 'user-retired', observedAt: retired.observedAt }
          }
        }
        let latest: AgentMuxStoredAgentSession | null = null
        try {
          latest = this.registry.get(input.agentSessionId)
        } catch {}
        return {
          kind: 'conflict',
          agentSessionId: input.agentSessionId,
          previousRun: { ...input.expectedRun },
          ...(latest ? { currentRun: { ...latest.run } } : {}),
          reason: 'lifecycle-busy',
          evidence: { kind: 'agent-session-store' }
        }
      }
      throw error
    }
  }

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

  async writeAgent(input: AgentMuxAgentWriteInput): Promise<AgentMuxRunInputAck> {
    this.requireConnected()
    const session = this.requireAgentSession(input.agentSessionId)
    if (!sameRun(session.run, input.expectedRun)) {
      throw new AgentMuxError('Agent Session changed before native input.', 'STALE_AGENT_SESSION')
    }
    if (input.source !== 'user' && input.source !== 'terminal-protocol') {
      throw new AgentMuxError('Native input must declare its user or terminal-protocol source.', 'INVALID_AGENT_INPUT_SOURCE')
    }
    return await this.writeAgentInput(session, input.data, input.source)
  }

  async pasteAgent(input: AgentMuxAgentPasteInput): Promise<AgentMuxRunInputAck> {
    this.requireConnected()
    const session = this.requireAgentSession(input.agentSessionId)
    if (!sameRun(session.run, input.expectedRun)) {
      throw new AgentMuxError('Agent Session changed before paste.', 'STALE_AGENT_SESSION')
    }
    const plan = this.providers.get(session.providerId).planPromptInput(input.text)
    return await this.writeAgentInput(session, plan.kind === 'render-then-submit'
      ? plan.payload
      : input.terminalData, 'user')
  }

  async submitAgentPrompt(input: AgentMuxAgentPromptInput): Promise<void> {
    if ('authorAgentSessionId' in input) throw new AgentMuxError('Agent authors must use submitAgentMessage.', 'MESSAGE_ENVELOPE_REQUIRED')
    await this.submitPromptInternal(input)
  }

  /** Save an exact future message through the same durable Session owner as Input. */
  async saveAgentFuturePromptIntent(input: { agentSessionId: string; intentId: string; operationId: string; prompt: string; agentMuxNote?: string; active: boolean;
    caller?: { agentSessionId: string; capability: string }; sourceDevice?: import('./types.js').AgentOperationDevice }): Promise<void> {
    this.requireConnected()
    if ('authorHuman' in input || 'authorAgentSessionId' in input) throw new AgentMuxError('Future-message authors come from the original authenticated owner.', 'MESSAGE_SENDER_MISMATCH')
    const intentId = safeId(input.intentId, 'Future message intent id')
    const operationId = safeId(input.operationId, 'Future message operation id')
    if (typeof input.active !== 'boolean' || !input.prompt.trim()) throw new AgentMuxError('A future message needs exact content and an explicit active state.', 'INVALID_AGENT_PROMPT')
    const composed = composeAgentPrompt(input.prompt, input.agentMuxNote)
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
      if (!previous && Object.keys(intents).length >= 256) throw new AgentMuxError('This Session has reached its retained future-message limit. Existing messages and manual input remain available.', 'AGENT_FUTURE_INTENT_LIMIT')
      intents[intentId] = { ...previous, operationId, prompt: composed.text, active: input.active,
        message: previous?.message ?? { userContent: input.prompt, ...(composed.systemContext ? { systemContext: composed.systemContext } : {}),
          ...(authorAgentSessionId ? { authorAgentSessionId } : {}), ...(input.sourceDevice ? { sourceDevice: structuredClone(input.sourceDevice) } : {}) } }
      return { ...current, futurePromptIntents: intents, updatedAt: Date.now() }
      })
    })
  }

  /** Uses ordinary input admission, never a pending Hook or an A2A message envelope. */
  async replySessionQuestion(input: AgentMuxSessionQuestionReplyInput): Promise<AgentSessionQuestionReplyReceipt> {
    this.requireConnected()
    const condition = validateAgentPromptCondition(input)
    const session = this.requireAgentSession(input.agentSessionId)
    if (!sameRun(session.run, condition.expectedRun)) throw new AgentMuxError(
      'Agent Session changed before its question was answered.', 'STALE_AGENT_SESSION')
    if (!input.source || input.source.providerId !== session.providerId ||
      typeof input.source.nativeSessionId !== 'string' || !input.source.nativeSessionId ||
      typeof input.turnId !== 'string' || !input.turnId || typeof input.recordId !== 'string' || !input.recordId ||
      !Array.isArray(input.answers) || !input.answers.length || input.answers.some(answer =>
        !answer || typeof answer.questionId !== 'string' || !answer.questionId || typeof answer.answer !== 'string' || !answer.answer.trim())) {
      throw new AgentMuxError('A question reply requires an exact source, record and answers.', 'INVALID_AGENT_QUESTION_REPLY')
    }
    // Copy the original caller intent before any native read can suspend this method.
    input = { ...input, ...condition, source: { ...input.source },
      answers: input.answers.map(answer => ({ questionId: answer.questionId, answer: answer.answer })),
      ...(input.sourceDevice ? { sourceDevice: { ...input.sourceDevice } } : {}),
      ...(input.args ? { args: [...input.args] } : {}), ...(input.env ? { env: { ...input.env } } : {}) }
    const lifetime = this.providerReadLifetime('history')
    const { controller, read } = lifetime
    const cancel = (): void => controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', cancel, { once: true })
    try {
      input.signal?.throwIfAborted()
      const binding = await read(this.nativeHistoryBinding(input.agentSessionId, input, controller.signal, 'read'))
      const { provider, handle } = binding
      const source = { providerId: session.providerId, nativeSessionId: handle.sessionId }
      if (source.providerId !== input.source.providerId || source.nativeSessionId !== input.source.nativeSessionId) {
        throw new AgentMuxError('The question belongs to another native source.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
      }
      if (!provider.prepareSessionQuestionReply) throw new AgentMuxError(
        'This Provider does not expose native question replies; ordinary input remains available.', 'AGENT_QUESTION_REPLY_UNSUPPORTED')
      const prompt = await read(provider.prepareSessionQuestionReply({ source,
        turnId: input.turnId, recordId: input.recordId, answers: input.answers,
        command: resolveAgentExecutable(input.commandOverride, provider.executable),
        args: input.args ?? [], env: input.env ?? {}, workspacePath: session.workspacePath,
        ...(handle.transcriptPath === undefined ? {} : { transcriptPath: handle.transcriptPath }), signal: controller.signal }))
      if (typeof prompt !== 'string' || !prompt.trim()) throw new AgentMuxError(
        'The Provider returned an invalid question reply.', 'INVALID_AGENT_PROVIDER')
      await read(binding.assertCurrent())
      // Recheck source after joining the original input serializer, not before waiting in its queue.
      await this.submitPromptInternal({ ...condition, agentSessionId: input.agentSessionId,
        operationId: input.operationId, prompt,
        ...(input.authorHuman === undefined ? {} : { authorHuman: input.authorHuman }),
        ...(input.sourceDevice === undefined ? {} : { sourceDevice: input.sourceDevice }),
        ...(input.sourceChannel === undefined ? {} : { sourceChannel: input.sourceChannel }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.allowUncertainTurn === undefined ? {} : { allowUncertainTurn: input.allowUncertainTurn }) },
        undefined, current => {
          const native = current.nativeHandle
          if (current.providerId !== source.providerId || native?.kind !== 'provider' || native.providerId !== source.providerId || native.sessionId !== source.nativeSessionId) {
            throw new AgentMuxError('The question source changed before Input admission. Ordinary input remains available.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
          }
        }, true)
      return { agentSessionId: input.agentSessionId, source, recordId: input.recordId,
        questionIds: input.answers.map(answer => answer.questionId), operationId: input.operationId, outcome: 'submitted' }
    } finally {
      input.signal?.removeEventListener('abort', cancel)
      lifetime.close()
    }
  }

  private async submitPromptInternal(input: AgentMuxAgentPromptInput, authorAgentSessionId?: string, assertSession?: (session: AgentMuxAgentSession) => void, questionReply = false): Promise<void> {
    this.requireConnected()
    if (input.execution !== undefined && input.execution !== 'default' && input.execution !== 'immediate') {
      throw new AgentMuxError('Prompt execution intent is invalid.', 'INVALID_AGENT_PROMPT')
    }
    if (input.execution === 'immediate' && (input.expectedCompletionId !== undefined || input.expectedFutureIntent !== undefined)) {
      throw new AgentMuxError('Automatic admission cannot authorize native interruption.', 'INVALID_AGENT_PROMPT')
    }
    const content = input.prompt
    if (input.expectedFutureIntent !== undefined && (input.expectedCompletionId !== undefined || input.authorHuman === true || input.allowUncertainTurn ||
        !input.expectedFutureIntent.intentId || !Number.isSafeInteger(input.expectedFutureIntent.occurrenceAt) || input.expectedFutureIntent.occurrenceAt < 0 || input.expectedInputByte === undefined)) {
      throw new AgentMuxError('A saved future message requires its exact occurrence and input fence.', 'INVALID_AGENT_PROMPT')
    }
    if (input.expectedInputByte !== undefined && ((input.expectedCompletionId === undefined && input.expectedFutureIntent === undefined) ||
        !Number.isSafeInteger(input.expectedInputByte) || input.expectedInputByte < 0)) {
      throw new AgentMuxError('Automatic prompt admission requires its completion and finite input fence together.', 'INVALID_AGENT_PROMPT')
    }
    if (!content.trim() && !input.agentMuxNote?.trim()) throw new AgentMuxError('Agent prompt cannot be empty.', 'INVALID_AGENT_PROMPT')
    // Producer facts come from explicit input, never by parsing the user's string.
    const composed = composeAgentPrompt(content, input.agentMuxNote)
    const outbound = composed.text
    assertAgentPromptSize(outbound)
    const message: AgentPromptMessageContent = {
      ...(content.trim() ? { userContent: content } : {}),
      ...(composed.systemContext ? { systemContext: composed.systemContext } : {}),
      ...(authorAgentSessionId ? { authorAgentSessionId } : input.authorHuman === true ? { authorHuman: true } : {}),
      ...(input.sourceDevice ? { sourceDevice: normalizeOperationDevice(input.sourceDevice) } : {}),
      sourceChannel: normalizeMessageChannel(input.sourceChannel ?? 'api')
    }
    const operationId = safeId(input.operationId, 'Agent prompt operation id')
    // 握手绝不做发 prompt 的前置门。这里不是生命周期路径——run 早就活着，用户此刻正在提交。
    // 而 `[?u` 是 codex 一次性的启动输出，对一个几分钟前启动的 run 早已不可达，于是一旦拦在
    // 这里，**那个 run 之后的每一条 prompt 都被永久挡住**。栅栏起点由 daemon 的权威
    // acceptedInputBytes 兜底（submitInputPlan 本来就这么取），不依赖握手是否完成。
    const session = this.requireAgentSession(input.agentSessionId)
    const condition = validateAgentPromptCondition(input)
    if (!sameRun(session.run, condition.expectedRun)) {
      throw new AgentMuxError('Agent Session changed before prompt submission.', 'STALE_AGENT_SESSION')
    }
    const provider = this.providers.get(session.providerId)
    const ordinaryPlan = provider.planPromptInput(outbound, input.execution === undefined ? undefined : { execution: input.execution })
    const renderObservation = new AbortController()
    const protocolInput: AgentPromptProtocolInputBoundary = { invalid: false }
    let preparationStarted = false
    let transportQualification: AgentPromptTransportQualification | undefined
    try {
      transportQualification = input.execution === 'immediate'
        ? await this.observeAgentInputPreparation(session, 40_000, async signal => {
        const run = await this.requireCurrentAgentRun(session)
        return await this.promptSubmission.qualifyInputTransport(session, run, operationId, outbound, signal,
          () => { preparationStarted = true }, protocolInput)
      }, input.signal, protocolInput) : undefined
    } catch (error) {
      if (preparationStarted) throw promptPreparationFailure(error)
      throw error
    }
    const delivered = await this.serializeAgentInput(session, async (current, run) => {
      let plan = ordinaryPlan
      if (questionReply) {
        let terminalScreen: AgentTerminalScreenSnapshot | undefined
        await this.screenEvidence.wait(current, run.latestOutputBytes, false, screen => {
          terminalScreen = screen.snapshot(); return true
        }, { timeoutMs: SESSION_HISTORY_TIMEOUT_MS, timeoutMessage: 'Question input surface is unconfirmed; ordinary terminal input remains available.',
          terminalMessage: 'The original question Run ended.', requireCompleteFrame: true,
          ...(input.signal ? { signal: input.signal } : {}) })
        plan = provider.planPromptInput(outbound, { intent: 'question-reply', ...(terminalScreen ? { terminalScreen } : {}) })
      }
      const savedMessage = input.expectedFutureIntent ? current.futurePromptIntents?.[input.expectedFutureIntent.intentId]?.message : undefined
      // Timer transport is not the producer. Inherit only the original saved
      // authenticated source; retain this request's exact content for admission.
      const admittedMessage = input.expectedFutureIntent ? {
        ...(message.userContent ? { userContent: message.userContent } : {}), ...(message.systemContext ? { systemContext: message.systemContext } : {}),
        ...(savedMessage?.authorAgentSessionId ? { authorAgentSessionId: savedMessage.authorAgentSessionId } : {}),
        ...(savedMessage?.sourceDevice ? { sourceDevice: savedMessage.sourceDevice } : {})
      } : message
      return await this.promptSubmission.submitInputPlan(current, run, operationId, outbound, plan, condition,
        input.expectedCompletionId, input.signal, input.allowUncertainTurn, renderObservation.signal, input.expectedInputByte, admittedMessage, input.execution, input.expectedFutureIntent, assertSession, transportQualification)
    }, renderObservation)
    if (delivered === undefined) throw new AgentMuxError('Original message source facts are unconfirmed; the Agent and original Input are kept.', 'AGENT_PROMPT_INPUT_UNCONFIRMED')
    await this.recordPromptMessageAfterSideEffect(session, operationId, 'Prompt', delivered)
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

  /** The one public A2A input owner: authenticated identity, durable intent, then source plus body. */
  async submitAgentMessage(input: AgentMuxAgentMessageInput): Promise<void> {
    input = { ...input, ...(input.caller ? { caller: { ...input.caller } } : {}) }
    this.requireConnected()
    const envelope = validateAgentMuxMessageEnvelope(input.envelope)
    const condition = validateAgentPromptCondition(input.condition)
    const sourceChannel = normalizeMessageChannel(input.sourceChannel ?? 'agent-message')
    const sourceDevice = input.sourceDevice === undefined ? undefined : normalizeOperationDevice(input.sourceDevice)
    if (envelope.recipient.kind !== 'agent-session' || envelope.recipient.agentSessionId !== input.agentSessionId ||
      envelope.recipientSessionId !== input.agentSessionId ||
      envelope.recipientRunId !== null && envelope.recipientRunId !== condition.expectedRun.runId) {
      throw new AgentMuxError('Message recipient does not match its exact prompt intent.', 'MESSAGE_RECIPIENT_MISMATCH')
    }
    let authorAgentSessionId: string | undefined
    if (envelope.sender.kind === 'agent-session') {
      if (!input.caller?.capability) throw new AgentMuxError('Managed message capability is required.', 'AGENT_CAPABILITY_INVALID')
      await this.authorizeAgentMessage({ capability: input.caller.capability, callerAgentSessionId: input.caller.agentSessionId,
        senderAgentSessionId: envelope.sender.agentSessionId, senderSessionId: envelope.senderSessionId,
        senderRunId: envelope.senderRunId, recipientSessionId: envelope.recipientSessionId, recipientRunId: envelope.recipientRunId })
      authorAgentSessionId = envelope.senderSessionId!
    } else if (input.caller || envelope.senderSessionId !== null || envelope.senderRunId !== null) {
      throw new AgentMuxError('Local ingress cannot claim an Agent author.', 'MESSAGE_SENDER_MISMATCH')
    }
    const queued = await this.messageQueue.append({ ...envelope,
      sourceChannel, ...(sourceDevice ? { sourceDevice } : {}),
      ...(input.execution === undefined ? {} : { execution: input.execution }) })
    if (['delivered', 'accepted', 'replied'].includes(queued.delivery.state)) return
    if (queued.delivery.state !== 'queued') throw new AgentMuxError('This message has a final delivery outcome.', 'AGENT_DELIVERY_STATE_INVALID')
    const originalCondition = await this.messageQueue.preparePrompt(envelope.messageId, async () => condition)
    await this.submitPromptInternal({ ...originalCondition, agentSessionId: input.agentSessionId,
      operationId: envelope.messageId, prompt: renderAgentMuxMessageEnvelope(envelope), allowUncertainTurn: true,
      ...(queued.sourceChannel ? { sourceChannel: queued.sourceChannel } : {}), ...(queued.sourceDevice ? { sourceDevice: queued.sourceDevice } : {}), ...(input.execution === undefined ? {} : { execution: input.execution }) }, authorAgentSessionId)
    await this.messageQueue.recordDelivery(envelope.messageId, 'delivered')
  }

  async respondAgentInteraction(input: AgentMuxAgentInteractionInput): Promise<void> {
    this.requireConnected()
    const requestedSession = this.requireAgentSession(input.agentSessionId)
    if (!sameRun(requestedSession.run, input.expectedRun)) {
      throw new AgentMuxError(
        'Agent Session changed before its interaction was answered.',
        'STALE_AGENT_SESSION'
      )
    }
    const canonical = await this.registry.refresh(requestedSession.agentSessionId, requestedSession.run)
    const pending = canonical.pendingInteraction
    if (!pending || pending.request.id !== input.response.requestId) {
      throw new AgentMuxError('Agent interaction is not pending.', 'UNKNOWN_AGENT_INTERACTION')
    }
    const response = normalizeAgentInteractionResponse(pending.request, input.response)
    if (pending.request.evidence.source === 'acp') {
      if (response.kind !== 'permission') {
        throw new AgentMuxError('ACP question responses are unsupported.', 'AGENT_INTERACTION_UNSUPPORTED')
      }
      await this.acp.respondPermission(input.agentSessionId, pending.request.id, response.decision)
      return
    }
    const provider = this.providers.get(requestedSession.providerId)
    const plan = provider.planInteractionResponse(pending.request, response)
    if (!plan.data) {
      throw new AgentMuxError('Provider interaction response bytes cannot be empty.', 'INVALID_AGENT_PROVIDER')
    }
    const responseDigest = digestInteractionResponse(response)
    const operationId = agentInteractionOperationIdentity(
      requestedSession,
      pending.request.id,
      responseDigest,
      plan.data
    )
    this.cancelPromptRenderObservation(requestedSession)
    const deadline = Date.now() + 10_000
    const renderObservation = new AbortController()
    const prepared = await this.observeAgentInputPreparation(canonical, 10_000, async signal => {
      const run = await this.requireCurrentAgentRun(canonical)
      if (pending.response?.acknowledged || pending.response &&
          (run.acceptedInputBytes === null || run.acceptedInputBytes >= pending.response.inputByteRange.endByte)) return undefined
      const { response: _originalResponse, ...unanswered } = pending
      const unavailable = agentInteractionResponseUnavailableReason(unanswered)
      if (unavailable) throw new AgentMuxError(unavailable, 'AGENT_INTERACTION_UNCONFIRMED')
      if (run.acceptedInputBytes === null) throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
      if (!provider.prepareInteractionResponse || !pending.request.nativeToolCallId) {
        throw new AgentMuxError('The native interaction input target is unconfirmed. The terminal remains available.', 'AGENT_INTERACTION_UNCONFIRMED')
      }
      const result = await provider.prepareInteractionResponse({
        ...this.providerNativeContext(canonical, run), agentSessionId: canonical.agentSessionId,
        run: canonical.run, inputByte: run.acceptedInputBytes, signal,
        observeTarget: async inspect => {
          let geometryRevision = -1, evidenceGeneration = -1
          const outputThroughByte = await this.screenEvidence.wait(canonical, run.latestOutputBytes, false, screen => {
            if (!inspect(screen.snapshot())) return false
            geometryRevision = screen.geometryRevision
            evidenceGeneration = this.screenEvidence.generation(canonical.agentSessionId)
            return true
          }, { timeoutMs: 10_000, requireCompleteFrame: true, signal,
            timeoutMessage: 'The native interaction input target is unconfirmed.', terminalMessage: 'Agent Run ended before its interaction target was confirmed.' })
          return { run: canonical.run, outputThroughByte, geometryRevision, evidenceGeneration }
        }
      }, pending.request, response)
      if (!result || result.plan.data !== plan.data || result.target.agentSessionId !== canonical.agentSessionId ||
          !sameRun(result.target.run, canonical.run) || result.target.requestId !== pending.request.id ||
          result.target.nativeToolCallId !== pending.request.nativeToolCallId || !result.target.nativeSourceId ||
          result.target.inputByte !== run.acceptedInputBytes || !sameRun(result.target.frame.run, canonical.run)) {
        throw new AgentMuxError('Provider did not confirm the exact native interaction input target.', 'AGENT_INTERACTION_UNCONFIRMED')
      }
      return { prepared: result, processId: run.pid,
        nativeHandleIdentity: JSON.stringify(canonical.nativeHandle ?? null), deadline }
    })
    await this.serializeAgentInput(requestedSession, async (session, run) => {
      await this.submitNativeInteractionResponse(
        session,
        run,
        pending.request,
        response,
        responseDigest,
        operationId,
        plan.data,
        prepared,
        renderObservation.signal
      )
    }, renderObservation)
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
    await this.writeAgentInput(session, plan.data, 'user')
  }

  async resizeAgent(
    agentSessionId: string,
    expectedRun: AgentMuxRunRef,
    cols: number,
    rows: number
  ): Promise<AgentMuxRunAppliedSize> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    if (!sameRun(session.run, expectedRun)) {
      throw new AgentMuxError(
        'Agent Session changed before its Run was resized.',
        'STALE_AGENT_SESSION'
      )
    }
    const applied = await this.resizeTerminal(expectedRun, cols, rows)
    // 屏幕几何变了，长命屏幕证据随之失效；下一次观察按新尺寸重建。
    this.screenEvidence.discard(agentSessionId)
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

  async signalAgent(agentSessionId: string, signal: string): Promise<void> {
    this.requireConnected()
    await this.signalTerminal(this.requireAgentSession(agentSessionId).run, signal)
  }

  async stopAgent(agentSessionId: string, expectedRun: AgentMuxRunRef): Promise<void> {
    this.requireConnected()
    const session = this.requireAgentSession(agentSessionId)
    if (!sameRun(session.run, expectedRun)) {
      throw new AgentMuxError(
        'Agent Session changed before its Run was stopped.',
        'STALE_AGENT_SESSION'
      )
    }
    // 停止意图落台账。用户主动停止走的干净路径是 run-removed（下方），但进程可能在我们的 stop 生效前就
    // 自退——那条 exit 事件会先到 acceptKernelEvent；先记意图，才能让它诚实归为 user-stopped 而非 crashed。
    const lifecycleOperationId = agentLifecycleOperationIdentity(
      'stop',
      agentSessionId,
      randomUUID()
    )
    const stopOperation: CtxmuxAdapterStopOperation = await this.kernel.prepareStop(
      expectedRun.runId,
      lifecycleOperationId
    )
    const reservation = await this.registry.reserveExisting(
      'stop',
      agentSessionId,
      expectedRun,
      lifecycleOperationId,
      stopOperation
    )
    // Record intent only after both prepare and reservation succeeded. This
    // keeps exit classification honest when setup itself fails.
    this.stopRequestedRuns.add(expectedRun.runId)
    let preserveReservation = false
    try {
      let run: CtxmuxAdapterRun | null = null
      try {
        run = await this.requireCurrentAgentRun(session)
      } catch (error) {
        if (!(error instanceof AgentMuxError) || error.code !== 'STALE_AGENT_SESSION_BINDING') {
          throw error
        }
      }
      if (run?.state.type === 'running') {
        try {
          await this.kernel.stop(stopOperation)
        } catch (error) {
          // Stop is idempotent at the Session boundary: a Run that vanished
          // between status and stop has already completed its process exit.
          if (error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found') {
            preserveReservation = true
          } else {
            // Any non-vanished error leaves submission state uncertain. Keep
            // the reservation for startup recovery instead of releasing it
            // and losing an accepted/in-flight stop.
            preserveReservation = true
            throw error
          }
        }
        preserveReservation = true
      }
      else if (run) await this.releaseRunAttachment(session.run)
      await this.hookBindings.get(session.run.runId)?.close()
      this.hookBindings.delete(session.run.runId)
      const cleanup = await Promise.allSettled([
        this.acp.unbind(agentSessionId),
        this.registry.commitLifecycle(reservation, null)
      ])
      preserveReservation ||= cleanup[1]?.status === 'rejected'
      if (cleanup[1]?.status === 'fulfilled') {
        this.runPids.delete(session.run.runId)
        this.agentInputCursors.delete(agentSessionId)
        this.agentInputTails.delete(agentSessionId)
        this.publisher.publish({
          type: 'run-removed',
          agentSessionId,
          run: { ...session.run },
          evidence: { source: 'user', observedAt: Date.now(), run: { ...session.run } }
        })
      }
      const errors = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, 'Agent stopped but Agent Session cleanup failed.')
    } finally {
      if (!preserveReservation) await this.registry.releaseLifecycle(reservation)
    }
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
    const runs = await this.kernel.list()
    for (const reservation of reservations) {
      if (reservation.kind === 'reopen') {
        try { await this.completePreparedReopen(reservation, runs) }
        catch (error) { this.publisher.publish({ type: 'agent-error', agentSessionId: reservation.agentSessionId,
          code: 'AGENT_REOPEN_UNCONFIRMED', message: error instanceof Error ? error.message : String(error),
          evidence: { source: 'agentmux', observedAt: Date.now() } }) }
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
      const candidates = runs.filter(
        (run) => run.lifecycleOperationId === reservation.operationId
      )
      for (const run of candidates) await this.retireUncommittedRun(run.runId)
      retiredRuns = candidates.map((run) => runRef(run.runId))
      await this.registry.releaseLifecycle(reservation, retiredRuns)
    }
  }

  private async recoverPendingInteractionResponses(
    runs: readonly CtxmuxAdapterRun[]
  ): Promise<void> {
    for (const session of this.registry.list()) {
      const pending = session.pendingInteraction
      if (!pending) continue
      if (pending.request.evidence.source === 'acp') {
        if (!this.acp.hasPendingPermission(session.agentSessionId, pending.request.id)) {
          const settled = await this.clearPendingInteraction(session, pending.request.id)
          this.publisher.publish({ type: 'agent-session', session: cloneSession(settled) })
        }
        continue
      }
      if (pending.response?.acknowledged) {
        if (agentInteractionResponseSettled(pending)) {
          const settled = await this.clearPendingInteraction(session, pending.request.id)
          this.publisher.publish({ type: 'agent-session', session: cloneSession(settled) })
        }
        continue
      }
      // Native takeover does not identify the earlier typed response. Keep that
      // original tuple unknown; an explicit same-response caller may join its receipt.
      if (pending.nativeInput) continue
      // A completed target or competing request must never receive new bytes.
      if (pending.nativeCompleted || pending.additionalRequests?.length) {
        const response = pending.response
        const run = runs.find(candidate => candidate.runId === session.run.runId)
        if (!response || !run || run.acceptedInputBytes === null || run.acceptedInputBytes < response.inputByteRange.endByte) continue
      }
      const response = pending.response
      const run = runs.find((candidate) => candidate.runId === session.run.runId)
      if (!response || pending.request.evidence.source !== 'native-hook') continue
      if (!run) {
        throw new AgentMuxError(
          'A persisted Agent interaction response points to a missing CtxMux Run.',
          'AGENT_INTERACTION_STATE_INVALID'
        )
      }
      const acceptedInputBytes = run.acceptedInputBytes
      if (run.state.type === 'running' && (acceptedInputBytes === null || acceptedInputBytes < response.inputByteRange.endByte)) {
        // A reconnect has no current input-target qualification. Retain the original
        // tuple and healthy connection; only an explicit exact response can requalify it.
        this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
          code: 'AGENT_INTERACTION_UNCONFIRMED',
          message: 'The original typed response receipt is unconfirmed. Reconcile its exact response; automatic input is paused. The terminal remains available.',
          evidence: { source: 'agentmux', observedAt: Date.now(), run: { ...session.run } } })
        continue
      }
      if (
        acceptedInputBytes === null ||
        acceptedInputBytes < response.inputByteRange.startByte ||
        (
          acceptedInputBytes > response.inputByteRange.startByte &&
          acceptedInputBytes < response.inputByteRange.endByte
        )
      ) {
        throw new AgentMuxError(
          'CtxMux Input cursor cannot reconcile the persisted Agent interaction response.',
          'AGENT_INTERACTION_STATE_INVALID'
        )
      }
      const normalized = normalizeAgentInteractionResponse(pending.request, response.value)
      const plan = this.providers.get(session.providerId).planInteractionResponse(
        pending.request,
        normalized
      )
      const recover = async (current: AgentMuxAgentSession, currentRun: CtxmuxAdapterRun) => {
        await this.submitNativeInteractionResponse(
          current,
          currentRun,
          pending.request,
          normalized,
          digestInteractionResponse(normalized),
          agentInteractionOperationIdentity(
            current,
            pending.request.id,
            digestInteractionResponse(normalized),
            plan.data
          ),
          plan.data
        )
      }
      if (run.state.type === 'running') {
        await this.serializeAgentInput(session, recover)
        continue
      }
      try {
        await recover(session, run)
      } catch (error) {
        if (
          error instanceof AgentMuxError &&
          error.detail === 'not_applied' &&
          acceptedInputBytes === response.inputByteRange.startByte
        ) {
          const settled = await this.clearPendingInteraction(session, pending.request.id)
          this.publisher.publish({ type: 'agent-session', session: cloneSession(settled) })
          continue
        }
        if (error instanceof AgentMuxError && error.detail === 'unknown') {
          // The ended Run cannot receive new bytes. An unavailable original receipt
          // belongs to this tuple, not to the shared connection or a healthy sibling.
          this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
            code: 'AGENT_INTERACTION_UNCONFIRMED',
            message: `The ended Run's original typed response receipt is unconfirmed: ${error.message} Other terminals remain available.`,
            evidence: { source: 'agentmux', observedAt: Date.now(), run: { ...session.run } } })
          continue
        }
        throw error
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

  private async restoreHookBindings(runs: readonly CtxmuxAdapterRun[]): Promise<void> {
    const runsById = new Map(runs.map((run) => [run.runId, run]))
    for (const session of this.registry.list()) {
      if (!runsById.has(session.run.runId) || this.hookBindings.has(session.run.runId)) continue
      const binding = this.hookServer.createBinding(
        session.agentSessionId,
        session.providerId,
        session.hookBindingId,
        session.hookToken
      )
      try {
        await binding.bindRun(session.run.runId)
        this.hookBindings.set(session.run.runId, binding)
      } catch (error) {
        await binding.close()
        throw error
      }
    }
  }

  private async tryRestoreHookIngress(runs: readonly CtxmuxAdapterRun[]): Promise<void> {
    if (this.registry.list().length === 0) return
    try {
      await this.hookServer.start()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return
      throw error
    }
    await this.restoreHookBindings(runs)
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
        throw new AgentMuxError('Agent Session points to a Run that is no longer available.', 'STALE_AGENT_SESSION_BINDING')
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
   * 握手的降级包装：超时不再中止任何东西，其余照旧抛。
   *
   * 四个调用点里有三个（connect 循环、launch、resume）过去把任何握手错误都当成致命：connect
   * 会 `kernel.disconnect()` 拆掉整条连接，launch/resume 会回滚——**用一次慢探测杀掉一个刚
   * 启动好的、健康的 Agent**。这里只吃掉超时那一类：Agent 还在跑，我们没等到 `[?u` 而已。
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
        reason: 'handshake-timeout',
        run: { ...requestedSession.run },
        observedAt
      }
      let next: AgentMuxStoredAgentSession
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
      this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
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
      this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
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
    const operationId = terminalHandshakeOperationIdentity(
      session.providerId,
      session.run.runId,
      handshake
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
      if (event.type !== 'terminal-output' && event.type !== 'process-state') return
      if (event.run.runId !== session.run.runId) return
      if (event.type === 'terminal-output') {
        observe(event.data)
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
    try {
      const attachment = await this.kernel.attach(session.run.runId, 0)
      attached = true
      for (const event of attachment.replay) observe(event.data)
      this.assertAgentRun(session, attachment.run)
      if (!queryObserved && attachment.run.state.type !== 'running') {
        rejectQuery(terminalHandshakeExitError(attachment.run, startupOutput))
      }
      if (!queryObserved) await query

      const boundaryRun = await this.kernel.status(session.run.runId)
      this.assertAgentRun(session, boundaryRun)
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
        const initialReadiness = current.terminalPromptReadiness?.source === 'initial-composer'
          ? current.terminalPromptReadiness
          : undefined
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
    } catch (error) {
      if (error instanceof AgentMuxError && (
        error.code === AGENT_TERMINAL_HANDSHAKE_FAILED ||
        error.code === AGENT_TERMINAL_HANDSHAKE_TIMEOUT
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
    status: 'complete' | 'failed' = 'complete'
  ): Promise<void> {
    const now = Date.now()
    if (message.systemContext) await this.recordMessageAfterSideEffect(session, `system-context:${operationId}`,
      'AgentMux context', message.systemContext, now, 'agentmux', { status })
    if (message.userContent) await this.recordMessageAfterSideEffect(session, `prompt:${operationId}`,
      title, message.userContent, now, 'user', { status,
        ...(message.authorAgentSessionId ? { authorAgentSessionId: message.authorAgentSessionId } : {}),
        ...(message.authorHuman ? { authorHuman: true } : {}),
        ...(message.sourceDevice ? { sourceDevice: message.sourceDevice } : {}),
        ...(message.sourceChannel ? { sourceChannel: message.sourceChannel } : {}) })
  }

  private async recordMessageAfterSideEffect(
    session: AgentMuxAgentSession,
    itemId: string,
    title: string,
    content: string,
    observedAt: number,
    source: 'user' | 'agentmux',
    delivery: { sourceDevice?: import('./types.js').AgentOperationDevice; sourceChannel?: import('./types.js').AgentMessageChannel; authorAgentSessionId?: string; authorHuman?: boolean; status?: 'complete' | 'failed' } = {}
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
        ...(delivery.sourceDevice ? { sourceDevice: delivery.sourceDevice } : {}),
        ...(delivery.sourceChannel ? { sourceChannel: delivery.sourceChannel } : {}),
        ...(source === 'user' && delivery.authorAgentSessionId
          ? { authorAgentSessionId: delivery.authorAgentSessionId }
          : source === 'user' && delivery.authorAgentSessionId === undefined && delivery.authorHuman === true
            ? { authorHuman: true }
            : {})
      }
    }
    const evidence = { source, observedAt, run: { ...session.run } }
    try {
      await this.persistAndPublishTimeline(mutation, evidence)
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
  private async deliverPostLaunchPrompt(
    provider: AgentProvider,
    session: AgentMuxAgentSession,
    run: CtxmuxAdapterRun,
    lifecycleOperationId: string,
    text: string,
    message: AgentPromptMessageContent
  ): Promise<boolean> {
    if (!text.trim()) return true
    try {
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
          `launch-prompt:${lifecycleOperationId}`,
          text,
          provider.planPromptInput(text),
          agentPromptCondition(session),
          undefined,
          undefined,
          false,
          renderObservation.signal,
          undefined,
          message
        )
      }, renderObservation)
      return true
    } catch (error) {
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
    update: (current: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession
  ): Promise<AgentMuxStoredAgentSession> {
    try {
      return await this.registry.update(agentSessionId, expectedRun, update)
    } catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'STALE_AGENT_SESSION') throw error
      const hostId = this.requireAgentSession(agentSessionId).hostId
      await this.registry.load(hostId)
      const canonical = this.requireAgentSession(agentSessionId)
      if (!sameRun(canonical.run, expectedRun)) {
        throw new AgentMuxError('Agent Session changed while semantic state was persisted.', 'STALE_AGENT_SESSION')
      }
      return await this.registry.update(agentSessionId, expectedRun, update)
    }
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
            id: JSON.stringify(['activity-state', status.source, expectedRun.runId, randomUUID()]),
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
    this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
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
      const next = { ...current, updatedAt: Date.now() }
      const [request, ...additionalRequests] = current.pendingInteraction.additionalRequests ?? []
      if (request) next.pendingInteraction = { request, ...(additionalRequests.length ? { additionalRequests } : {}) }
      else delete next.pendingInteraction
      return next
    })
  }

  private async submitNativeInteractionResponse(
    session: AgentMuxAgentSession,
    run: CtxmuxAdapterRun,
    request: AgentMuxInteractionRequest,
    response: AgentMuxInteractionResponse,
    responseDigest: string,
    operationId: string,
    data: string,
    qualification?: AgentInteractionInputQualification,
    renderSignal?: AbortSignal
  ): Promise<void> {
    if (
      request.agentSessionId !== session.agentSessionId ||
      request.evidence.source !== 'native-hook' ||
      request.evidence.run?.runId !== session.run.runId
    ) {
      throw new AgentMuxError(
        'Native Agent interaction does not match the exact Session and Run.',
        'INVALID_AGENT_INTERACTION'
      )
    }
    const bytes = Buffer.byteLength(data)
    const prepared = qualification?.prepared
    const assertTargetFrame = (currentRun: CtxmuxAdapterRun, currentSession = session): void => {
      if (qualification && (renderSignal?.aborted || Date.now() >= qualification.deadline ||
          currentRun.pid !== qualification.processId ||
          JSON.stringify(currentSession.nativeHandle ?? null) !== qualification.nativeHandleIdentity)) {
        throw new AgentMuxError('The original native interaction identity or input qualification changed.', 'AGENT_INTERACTION_UNCONFIRMED')
      }
      const frame = prepared && this.screenEvidence.currentCompleteFrame(session)
      if (!prepared || !frame || frame.outputThroughByte !== currentRun.latestOutputBytes ||
          frame.outputThroughByte < prepared.target.frame.outputThroughByte ||
          frame.geometryRevision !== prepared.target.frame.geometryRevision ||
          frame.evidenceGeneration !== prepared.target.frame.evidenceGeneration ||
          currentRun.acceptedInputBytes !== prepared.target.inputByte ||
          !prepared.inspectCurrentTarget(frame.snapshot)) {
        throw new AgentMuxError('The native interaction target changed before input. The original request is kept.', 'AGENT_INTERACTION_UNCONFIRMED')
      }
    }
    const prior = session.pendingInteraction?.response
    const canApply = run.state.type === 'running' && !prior?.acknowledged && (!prior || run.acceptedInputBytes !== null && run.acceptedInputBytes < prior.inputByteRange.endByte)
    const observeFinalTarget = async (current: AgentMuxAgentSession, verify: boolean): Promise<CtxmuxAdapterRun> => {
      if (!qualification || !prepared || Date.now() >= qualification.deadline) {
        throw new AgentMuxError('The original native interaction target is unconfirmed.', 'AGENT_INTERACTION_UNCONFIRMED')
      }
      return await this.observeAgentInputPreparation(current, qualification.deadline - Date.now(), async signal => {
        if (verify && !await prepared.verifyCurrentTarget({ ...this.providerNativeContext(current, run),
            nativeSourceId: prepared.target.nativeSourceId, signal })) {
          throw new AgentMuxError('The native invocation or source changed before its answer.', 'AGENT_INTERACTION_UNCONFIRMED')
        }
        const fresh = await this.requireCurrentAgentRun(current)
        signal.throwIfAborted()
        return fresh
      }, renderSignal)
    }
    if (canApply) {
      run = await observeFinalTarget(session, true)
      assertTargetFrame(run)
    }
    const assertResponse = (
      state: NonNullable<NonNullable<AgentMuxAgentSession['pendingInteraction']>['response']>
    ): void => {
      if (
        state.responseDigest !== responseDigest ||
        state.operationId !== operationId ||
        state.inputByteRange.endByte - state.inputByteRange.startByte !== bytes ||
        JSON.stringify(state.value) !== JSON.stringify(response)
      ) {
        throw new AgentMuxError(
          'Agent interaction was answered with conflicting content.',
          'AGENT_INTERACTION_RESPONSE_CONFLICT'
        )
      }
    }
    let current = await this.updateExactAgentSession(
      session.agentSessionId,
      session.run,
      (stored) => {
        const pending = stored.pendingInteraction
        if (!pending || pending.request.id !== request.id) {
          throw new AgentMuxError('Agent interaction is not pending.', 'UNKNOWN_AGENT_INTERACTION')
        }
        if (canApply) assertTargetFrame(run, stored)
        if (JSON.stringify(pending.request) !== JSON.stringify(request)) {
          throw new AgentMuxError('The native request changed during input preparation.', 'AGENT_INTERACTION_UNCONFIRMED')
        }
        if (pending.response) {
          assertResponse(pending.response)
          return stored
        }
        const unavailableReason = agentInteractionResponseUnavailableReason(pending)
        if (unavailableReason) throw new AgentMuxError(unavailableReason, 'AGENT_INTERACTION_UNCONFIRMED')
        const expectedByte = run.acceptedInputBytes
        if (expectedByte === null) {
          throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
        }
        return {
          ...invalidateAgentIdleEvidence(stored),
          pendingInteraction: {
            request: pending.request,
            response: {
              value: structuredClone(response),
              responseDigest,
              operationId,
              inputByteRange: {
                startByte: expectedByte,
                endByte: expectedByte + bytes
              },
              acknowledged: false
            }
          },
          updatedAt: Date.now()
        }
      }
    )
    let state = current.pendingInteraction?.response
    if (!state) {
      throw new AgentMuxError(
        'Agent interaction response claim was not persisted.',
        'AGENT_INTERACTION_STATE_INVALID'
      )
    }
    assertResponse(state)
    let acceptedInputBytes = run.acceptedInputBytes
    if (!state.acknowledged) {
      if (canApply) {
        run = await observeFinalTarget(current, true)
        assertTargetFrame(run, current)
      }
      const accepted = await this.kernel.input(session.run.runId, {
        ownerInstanceId: this.kernel.identity().daemonInstanceId,
        operationId: state.operationId,
        expectedByte: state.inputByteRange.startByte,
        data
      })
      if (
        accepted.appliedByteRange.startByte !== state.inputByteRange.startByte ||
        accepted.appliedByteRange.endByte !== state.inputByteRange.endByte ||
        accepted.run.acceptedInputBytes === null ||
        accepted.run.acceptedInputBytes < state.inputByteRange.endByte
      ) {
        throw new AgentMuxError(
          'CtxMux interaction receipt does not match the persisted Input claim.',
          'AGENT_INTERACTION_RECEIPT_MISMATCH'
        )
      }
      acceptedInputBytes = accepted.run.acceptedInputBytes
      current = await this.updateExactAgentSession(
        session.agentSessionId,
        session.run,
        (stored) => {
          // A subsequent native request can arrive while this accepted Input awaits its ACK.
          // Record the cursor, but never settle or overwrite that newer request.
          if (stored.pendingInteraction?.request.id !== request.id) return stored
          const responseState = stored.pendingInteraction.response
          if (!responseState) {
            throw new AgentMuxError(
              'Agent interaction response claim disappeared.',
              'AGENT_INTERACTION_STATE_INVALID'
            )
          }
          assertResponse(responseState)
          if (responseState.acknowledged) return stored
          return {
            ...stored,
            pendingInteraction: {
              ...stored.pendingInteraction,
              response: { ...responseState, acknowledged: true }
            },
            updatedAt: Date.now()
          }
        }
      )
      if (current.pendingInteraction?.request.id !== request.id) {
        this.agentInputCursors.set(session.agentSessionId, acceptedInputBytes)
        this.publisher.publish({ type: 'agent-session', session: cloneSession(current) })
        return
      }
      state = current.pendingInteraction?.response
    }
    if (
      !state?.acknowledged ||
      acceptedInputBytes === null ||
      acceptedInputBytes < state.inputByteRange.endByte
    ) {
      throw new AgentMuxError(
        'CtxMux Input cursor precedes the persisted interaction receipt.',
        'AGENT_INTERACTION_STATE_INVALID'
      )
    }
    this.agentInputCursors.set(session.agentSessionId, acceptedInputBytes)
    const settled = current.pendingInteraction && agentInteractionResponseSettled(current.pendingInteraction)
      ? await this.clearPendingInteraction(current, request.id) : current
    this.publisher.publish({ type: 'agent-session', session: cloneSession(settled) })
  }

  private async writeAgentInput(
    requestedSession: AgentMuxAgentSession,
    data: AgentMuxRunInputData,
    source: AgentMuxAgentWriteInput['source']
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
        const cursor = run.acceptedInputBytes
        return {
          runId: session.run.runId,
          appliedByteRange: cursor === null ? null : { startByte: cursor, endByte: cursor },
          acceptedThroughByte: cursor
        }
      })
    }
    // Protocol replies are not human intent. Capture only observers present when this write
    // entered; a late ACK cannot grant authority to a later preparation or another Run.
    const protocolObservers = source === 'terminal-protocol'
      ? [...(this.agentInputTails.get(requestedSession.agentSessionId)?.renderObservations ?? [])]
          .filter(observation => sameRun(observation.run, requestedSession.run) && observation.protocolInput)
      : []
    this.cancelPromptRenderObservation(requestedSession, source === 'terminal-protocol')
    return await this.serializeAgentInput(requestedSession, async (session, run) => {
      // The native terminal remains usable while a typed request is pending. These bytes
      // are not a semantic answer and must not settle or approve that request.
      // This lane already read the current Run. Another public Client may have
      // accepted input since our last ACK; that local cursor cannot start new bytes.
      const expectedByte = run.acceptedInputBytes
      if (expectedByte === null) {
        throw new AgentMuxError('CtxMux omitted its accepted Input byte cursor.', 'CTXMUX_INPUT_CURSOR_MISSING')
      }
      const idleObservationAt = source === 'user' && session.semanticStatus?.state === 'done' ? session.semanticStatus.observedAt : undefined
      const idleEntryTime = session.semanticStatus?.state === 'done'
        ? session.semanticStatus.stateEnteredAt : undefined
      const operationId = randomUUID()
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
          this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
        } catch (error) {
          this.publisher.publish({ type: 'agent-error', code: 'AGENT_NATIVE_INPUT_PERSIST_FAILED',
            message: `Native input state could not be saved for Agent ${session.agentSessionId} (Run ${session.run.runId}). The terminal remains available; whether the saved request is still pending cannot be confirmed across restart. ${error instanceof Error ? error.message : String(error)}`,
            evidence: { source: 'user', observedAt: Date.now(), run: { ...session.run } } })
        }
      }
      await observeNativeInput('unknown')
      let result: Awaited<ReturnType<typeof this.kernel.input>>
      try {
        result = await this.kernel.input(session.run.runId, {
          ownerInstanceId: this.kernel.identity().daemonInstanceId, operationId, expectedByte, data
        })
      } catch (error) {
        for (const observation of protocolObservers) observation.protocolInput!.invalid = true
        if (error instanceof AgentMuxError && error.detail === 'not_applied') await observeNativeInput('not_applied')
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
      const idleStatus = this.registry.findByRun(session.run)?.semanticStatus
      if (idleObservationAt !== undefined && idleStatus?.state === 'done' &&
          !(idleStatus.idleEvidenceConsumed && idleStatus.aggregateActivityAt === undefined) &&
          idleStatus.observedAt === idleObservationAt && idleStatus.stateEnteredAt === idleEntryTime) {
        try {
          const next = await this.updateExactAgentSession(session.agentSessionId, session.run, (current) => {
            const invalidated = invalidateAgentIdleEvidence(current, idleEntryTime)
            return invalidated === current ? current : {
              ...invalidated, updatedAt: Math.max(current.updatedAt, Date.now())
            }
          })
          this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
        } catch (error) {
          // Ctxmux already accepted the bytes. A failed state write must not turn this ACK into
          // an input failure, clear the real cursor, or cause the caller to send those bytes again.
          // No second idle ledger: explain that the old durable clock cannot be trusted across restart.
          this.publisher.publish({
            type: 'agent-error',
            // A scoped agent-error paints a healthy Agent as failed. This is a Store advisory.
            code: 'AGENT_STATE_ENTRY_PERSIST_FAILED',
            message: `Input was accepted for Agent ${session.agentSessionId} (Run ${session.run.runId}), but its idle evidence could not be invalidated durably. The saved idle time is unconfirmed; later native state evidence can re-establish it. ${error instanceof Error ? error.message : String(error)}`,
            evidence: { source: 'user', observedAt: Date.now(), run: { ...session.run } }
          })
        }
      }
      return {
        runId: session.run.runId,
        appliedByteRange: result.appliedByteRange,
        acceptedThroughByte: result.run.acceptedInputBytes
      }
    })
  }

  private cancelPromptRenderObservation(session: AgentMuxAgentSession, preserveProtocolPreparation = false): void {
    const lane = this.agentInputTails.get(session.agentSessionId)
    for (const observation of lane?.renderObservations ?? []) {
      // Only fresh read-only qualification can account for this reply's ACK. Serialized
      // render observers must release the byte lane so the terminal can answer its query.
      if (sameRun(observation.run, session.run) &&
          !(preserveProtocolPreparation && observation.protocolInput)) observation.controller.abort()
    }
  }

  private providerNativeContext(session: AgentMuxAgentSession, run: CtxmuxAdapterRun): AgentProviderPromptExecutionContext {
    return { args: run.args, workspacePath: session.workspacePath,
      ...(session.hostId === 'local' && run.pid !== null ? { processId: run.pid } : {}),
      ...(session.nativeHandle ? { nativeHandle: session.nativeHandle } : {}),
      ...(session.nativePromptPredecessor?.run.runId === session.run.runId &&
        session.retiredRuns.at(-1)?.runId === session.nativePromptPredecessor.previousRun.runId
        ? { nativePromptPredecessor: session.nativePromptPredecessor } : {}) }
  }

  /** Read-only qualification shares cancellation with input observers, but never occupies the byte lane. */
  private async observeAgentInputPreparation<T>(session: AgentMuxAgentSession, timeoutMs: number,
    read: (signal: AbortSignal) => Promise<T>, requestedSignal?: AbortSignal,
    protocolInput?: AgentPromptProtocolInputBoundary): Promise<T> {
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
    try { return await Promise.race([read(controller.signal), cancelled]) }
    finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', abort)
      requestedSignal?.removeEventListener('abort', cancelRequested)
      lane.renderObservations.delete(observation)
      if (this.agentInputTails.get(session.agentSessionId) === lane && lane.renderObservations.size === 0) {
        const tail = lane.tail
        void tail.finally(() => {
          if (this.agentInputTails.get(session.agentSessionId) === lane && lane.tail === tail && lane.renderObservations.size === 0) this.agentInputTails.delete(session.agentSessionId)
        })
      }
    }
  }

  private async serializeAgentInput<T>(
    requestedSession: AgentMuxAgentSession,
    operation: (session: AgentMuxAgentSession, run: CtxmuxAdapterRun) => Promise<T>,
    renderObservation?: AbortController
  ): Promise<T> {
    const agentSessionId = requestedSession.agentSessionId
    const lane = this.agentInputTails.get(agentSessionId) ?? {
      tail: Promise.resolve(),
      renderObservations: new Set<AgentInputObservation>()
    }
    const observation = renderObservation ? {
      run: { ...requestedSession.run }, controller: renderObservation
    } : undefined
    // Register before queueing: raw input can arrive while this prompt awaits its predecessor.
    if (observation) lane.renderObservations.add(observation)
    const previous = lane.tail
    let result!: T
    const queued = previous.catch(() => {}).then(async () => {
      const session = this.requireAgentSession(agentSessionId)
      if (!sameRun(session.run, requestedSession.run)) {
        throw new AgentMuxError('Agent Session changed before Input was accepted.', 'STALE_AGENT_SESSION')
      }
      const run = await this.requireCurrentAgentRun(session)
      if (run.state.type !== 'running') {
        throw new AgentMuxError(
          'Agent Run exited before Input could be accepted.',
          'STALE_AGENT_SESSION'
        )
      }
      result = await operation(session, run)
    })
    const tail = queued.then(() => {}, () => {})
    lane.tail = tail
    this.agentInputTails.set(agentSessionId, lane)
    try {
      await queued
      return result
    } catch (error) {
      this.agentInputCursors.delete(agentSessionId)
      throw error
    } finally {
      if (observation) lane.renderObservations.delete(observation)
      if (this.agentInputTails.get(agentSessionId) === lane && lane.tail === tail && lane.renderObservations.size === 0) {
        this.agentInputTails.delete(agentSessionId)
      }
    }
  }

  private requireAgentSession(agentSessionId: string): AgentMuxStoredAgentSession {
    return this.registry.get(agentSessionId)
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
  private async hookNativeWitness(session: AgentMuxStoredAgentSession, envelope: NativeHookEnvelope, signal: AbortSignal): Promise<{ handle?: AgentNativeSessionHandle; childSessionIds?: readonly string[]; reason?: string }> {
    const provider = this.providers.get(session.providerId)
    if (!provider.hook.processNativeIdentity) return {}
    const payload = envelope.payload ?? {}
    const nested = payload.extra && typeof payload.extra === 'object' ? payload.extra as Record<string, unknown> : {}
    const incoming = (provider.hook.nativeHandle?.sessionIdKeys ?? []).map(key => normalizeNativeSessionId(payload[key] ?? nested[key])).find(Boolean)
    const candidate = JSON.stringify(incoming ?? null)
    const childCandidate = (provider.hook.subagentTracking?.idKeys ?? []).map(key => normalizeNativeSessionId(payload[key] ?? nested[key])).find(Boolean)
    const previous = this.hookNativeWitnesses.get(session.run.runId)
    if (previous && (previous.candidate === candidate || previous.handle?.sessionId === incoming) &&
      (!childCandidate || previous.reason === 'native-witness-unavailable' || previous.childSessionIds?.includes(childCandidate) || previous.reason === `native-child-unconfirmed:${childCandidate}`)) return previous
    let result: { candidate: string; handle?: AgentNativeSessionHandle; childSessionIds?: readonly string[]; reason?: string } = { candidate }
    try {
      const before = await this.observeHookRun(session.run.runId, signal)
      this.assertAgentRun(session, before)
      if (before.state.type !== 'running' || !before.pid || !provider.discoverNativeSession) throw new Error('Native process witness unavailable.')
      const witness = await provider.discoverNativeSession({ processId: before.pid, command: before.program ?? provider.executable, args: before.args,
        env: {}, workspacePath: session.workspacePath, signal })
      if (!witness || witness.handle.kind !== 'provider' || witness.handle.providerId !== session.providerId) throw new Error('No unique main native record.')
      await witness.assertCurrent()
      const after = await this.observeHookRun(session.run.runId, signal)
      this.assertAgentRun(session, after)
      if (after.state.type !== 'running' || after.pid !== before.pid) throw new Error('Native process changed during observation.')
      result = { candidate, handle: { ...witness.handle },
        ...(witness.childSessionIds !== undefined ? { childSessionIds: witness.childSessionIds } : {}),
        ...(childCandidate && !witness.childSessionIds?.includes(childCandidate) ? { reason: `native-child-unconfirmed:${childCandidate}` } : {}) }
    } catch (error) {
      signal.throwIfAborted()
      result.reason = 'native-witness-unavailable'
      this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId,
        code: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', message: 'Native Hook identity could not be confirmed from this Run. The Run and input remain available; Refresh the native Session observation to retry.',
        evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } })
    }
    this.hookNativeWitnesses.set(session.run.runId, result)
    return result
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
    const protectedTarget = session.reopenedFrom !== undefined || session.nativeBinding?.source === 'semantic-resume-target'
    const witnessTargetMismatch = witness.handle && session.nativeHandle && witness.handle.sessionId !== session.nativeHandle.sessionId
    const context: AgentProviderHookNormalizationContext = Object.freeze({
      ...(session.nativeHandle ? { nativeHandle: Object.freeze({ ...session.nativeHandle }) } : {}),
      ...(session.hookReceipt && sameRun(session.hookReceipt.run, session.run)
        ? { previousHookReceipt: Object.freeze({ ...session.hookReceipt,
          ...(session.hookReceipt.toolInvocation ? { toolInvocation: Object.freeze({ ...session.hookReceipt.toolInvocation }) } : {}) }) } : {}),
      ...(protectedTarget ? { protectedNativeTarget: true } : {}),
      ...(witness.childSessionIds ? { processNativeChildSessionIds: witness.childSessionIds } : {}),
      ...(witness.handle && !(protectedTarget && witnessTargetMismatch) ? { processNativeHandle: Object.freeze({ ...witness.handle }) } : {}),
      ...(protectedTarget && witnessTargetMismatch ? { nativeIdentityReason: 'resume-target-mismatch' } : witness.reason ? { nativeIdentityReason: witness.reason } : {})
    })
    const normalized = provider.normalizeHook(envelope, context)
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
    const canPromoteLocator = !witnessTargetMismatch || (!protectedTarget && session.nativeBinding?.source === 'native-hook' && sameRun(session.nativeBinding.run, session.run))
    const precedingInteractionReceiptId = normalized.interaction?.nativeToolCallId &&
      !nativeHookToolCallId(envelope.payload ?? {}) ? context.previousHookReceipt?.id : undefined
    const activityId = JSON.stringify(['activity-state', 'native-hook', session.run.runId, envelope.receiptId])
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
    // Unknown outcome ends a known main turn; an ordinary unknown observation stays neutral.
    // Use this same decision for the durable status and published semantic status below.
    const updatesSemanticStatus = hookEventUpdatesSemanticStatus(
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
      decision: { activityApplied: updatesSemanticStatus || normalized.childActivity === true,
        lifecycleApplied: normalized.lifecycleEvent !== undefined && normalized.lifecycleEvent !== null && (updatesSemanticStatus || normalized.lifecycleEvent === 'turn-end'),
        reason: updatesSemanticStatus ? normalized.mainSubject ? 'main-semantic-applied' : 'pending-parent-completion-applied' : normalized.childActivity ? 'proven-child-activity' :
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
    const persistReceipt = (
      current: AgentMuxStoredAgentSession
    ): AgentMuxStoredAgentSession => {
      signal.throwIfAborted()
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
      if (provider.hook.toolInvocation) {
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
      const next: AgentMuxStoredAgentSession = {
        ...currentBase,
        updatedAt: Math.max(current.updatedAt, normalized.status.observedAt),
        hookReceipt: persistedReceipt,
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
        ...(normalized.childActivity ? { semanticStatus: { ...(current.semanticStatus ?? { state: 'running' as const, source: 'native-hook' as const, observedAt: 0 }),
          aggregateActivityAt: normalized.status.observedAt,
          currentActivityRevision: (current.semanticStatus?.currentActivityRevision ?? 0) + 1 } } : {}),
        ...(witness.handle && witnessTargetMismatch && !(canPromoteLocator && normalized.nativeHandle) ? { observedNativeHandle: witness.handle } : {}),
        ...(normalized.nativeHandle && canPromoteLocator ? {
          nativeHandle: witness.handle ?? { ...normalized.nativeHandle,
            ...(normalized.nativeHandle.kind === 'provider' && current.nativeHandle?.kind === 'provider' &&
              normalized.nativeHandle.sessionId === current.nativeHandle.sessionId && normalized.nativeHandle.transcriptPath === undefined &&
              current.nativeHandle.transcriptPath ? { transcriptPath: current.nativeHandle.transcriptPath } : {}) },
          nativeBinding: { source: protectedTarget ? 'semantic-resume-target' as const : witness.handle ? 'process-witness' as const : 'native-hook' as const, run: { ...current.run }, observedAt: normalized.status.observedAt }
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
      const pending = current.pendingInteraction
      if (completion && completedRequestId && pending?.request.kind === completion.kind &&
        pending.request.id === completedRequestId && pending.request.agentSessionId === current.agentSessionId &&
        pending.request.evidence.source === 'native-hook' && pending.request.evidence.run?.runId === current.run.runId &&
        pending.request.nativeToolCallId === completion.nativeToolCallId) {
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
        const interaction = precedingInteractionReceiptId && (current.hookReceipt?.id !== precedingInteractionReceiptId ||
          JSON.stringify(current.nativeHandle ?? null) !== JSON.stringify(context.nativeHandle ?? null))
          ? unboundInteraction : normalized.interaction
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
    const persistedReceipt = next.hookReceipt
    if (!persistedReceipt) {
      throw new AgentMuxError('Native Hook receipt was not persisted.', 'HOOK_RECEIPT_INVALID')
    }
    if (witness.handle && next.nativeHandle && witness.handle.sessionId !== next.nativeHandle.sessionId) this.publisher.publish({
      type: 'agent-error', agentSessionId: next.agentSessionId,
      code: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', message: 'The current process native identity differs from the retained conversation target. The target was preserved; confirm the original native Session before continuing it. The current Run and input remain available.',
      evidence: { source: 'agentmux', run: { ...next.run }, observedAt: persistedReceipt.observedAt }
    })
    else if (normalized.subject?.reason === 'resume-target-mismatch' || normalized.subject?.reason === 'native-session-mismatch') this.publisher.publish({
      type: 'agent-error', agentSessionId: next.agentSessionId, code: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED',
      message: 'This Native Hook did not confirm the stored conversation identity. Its main activity and permission were not applied; the stored target, current Run and input remain available.',
      evidence: { source: 'agentmux', run: { ...next.run }, observedAt: persistedReceipt.observedAt }
    })
    const evidence = {
      source: 'native-hook' as const,
      observedAt: normalized.status.observedAt,
      run: { ...next.run },
      hookReceiptId: persistedReceipt.id
    }
    if (next.activityCommit?.latest.id === activityId) await this.flushAgentActivity(next)
    for (const mutation of normalized.timeline) {
      try { await this.persistAndPublishTimeline(mutation, evidence, signal) }
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
    if (updatesSemanticStatus) this.publisher.publishHook(next, normalized, persistedReceipt)
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
    this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
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
    this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })
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
          { source: observation.source, observedAt: observation.createdAt, run: { ...observation.activityState.run } })
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
            id: JSON.stringify(['activity-state', boundary === 'history-gap' ? 'agentmux' : 'run-process', session.run.runId, randomUUID()]),
            source: boundary === 'history-gap' ? 'agentmux' : 'run-process', createdAt: observedAt, activityState: { run: { ...session.run }, boundary }
          }) }
      })
      await this.flushAgentActivity(next)
    } catch (error) { this.publishActivityFailure(session, error, observedAt) }
  }

  private async persistAndPublishTimeline(
    mutation: AgentTimelineMutation,
    evidence: Parameters<AgentMuxClientEventPublisher['publishTimeline']>[1],
    signal?: AbortSignal
  ): Promise<void> {
    const commit = await this.store.applyTimelineMutation(mutation, signal)
    if (commit.changed) this.publisher.publishTimeline(commit, evidence)
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
    const agentSession = this.registry.findByRun(runRef(event.runId))
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
    if (agentSession) {
      this.invalidateEndedRunReadiness(agentSession, runRef(event.runId))
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
