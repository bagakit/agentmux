import type { ChildProcess } from 'node:child_process'
/** Public Client operation contracts; runtime behavior and state remain in the Client owner. */
import type { AgentMuxAgentForkSource } from './agent-fork.js'
import type { AgentNativeResumeSource, AgentProviderId, AgentExecutorId, AgentMuxRunRef, AgentSessionHistorySource, AgentSessionHistoryQuestionAnswer, AgentMuxInteractionOperationIntent, AgentMuxInteractionResponse, AgentMuxAgentSession, AgentMuxRunAttachment, AgentExecutorConfig, AgentMuxRun, AgentCapabilitySnapshot } from './types.js'
import type { AgentMuxOptionalContext } from './agent-outbound-message.js'
import type { LaunchOptionSelection } from './agent-launch-option.js'
import type { AgentMuxCreationAdmission } from './agent-creation-admission.js'
import type { AgentInputImageReference, AgentInputResourceOwner } from './agent-input-resource.js'
import type { AgentPromptCondition, AgentPromptAdmissionIntent } from './agent-prompt-condition.js'
import type { AgentMuxMessageEnvelope } from './agent-global-message-queue.js'
import type { AgentInputMoteResolver } from './mote-input.js'
import type { AgentStartupDiagnosticOwner } from './startup-diagnostic.js'
import type { AgentExternalConversationAuthorityPort } from './external-conversation.js'
import type { AgentMuxHostExecutorOwner } from './executor-owner.js'
import type { AgentMuxCreationAuthority } from './agent-creation-authority.js'
import type { AgentProvider } from './agent-provider.js'
import type { AgentMuxPlugin } from './agent-plugin.js'
import type { AgentMuxAgentSessionStore } from './agent-session-store.js'
import type { AgentManagedHookInstaller } from './managed-hook-installer.js'
import type { AgentObservation, observeAgent } from './agent-status-freshness.js'
export type AgentMuxAgentCreateInput = {
  toolExecution?: import('./agent-tool-execution.js').AgentToolExecutionBinding
  agentSessionId?: string
  createOperationId?: string
  /** Original requested position only; it grants no placement, role or caller authority. */
  spatialIntent?: import('./types.js').AgentMuxAgentCreationSpatialIntent
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
  /** Source-owned business context; caller note stays independent until Core's final composer. */
  sourceAgentMuxNote?: string
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
  'toolExecution' | 'agentSessionId' | 'createOperationId' | 'executorId' | 'workspacePath' | 'prompt' | 'agentMuxNote' | 'sourceAgentMuxNote' | 'agentMuxTask' | 'optionalContext' |
  'launchOptions' | 'cols' | 'rows' | 'nativeResumeSource' | 'spatialIntent'> & {
  executorRevision: string
  /** Existing signed creation intent admission; an initial body is optional. */
  initialMessageAdmission?: AgentMuxCreationAdmission
  threadId?: string
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
  authorProfile?: import('./author-profile.js').AgentPreparedAuthorProfile
  inputImages?: readonly AgentInputImageReference[]
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
  /** Original selected Mote workface; the Host verifies its primary and membership. */
  moteSource?: import('./mote-input.js').AgentInputMoteSource
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
  /** The external chat's original conversation kind; it only selects the reply note of a new input, never authorship, permission or input eligibility. */
  conversationKind?: import('./ingress-contract.js').ConnectionIngressMessage['conversationKind']
  /** Original Host-selected reply capability; frozen guidance never routes or authorizes an effect. */
  moteReply?: import('./mote/chat-contract.js').MoteChatReplyReference
} & ({ condition?: never; admissionIntent?: never; execution?: 'default'; scope?: never } |
  { condition: AgentPromptCondition; admissionIntent?: never; scope?: never } |
  { condition?: never; admissionIntent: Exclude<AgentPromptAdmissionIntent, { kind: 'exact-condition' }>; execution: 'immediate';
    /** Ensure the original first waiting generation; never adopt a later generation's control scope. */
    scope?: 'ensure-custody' })

export type AgentMuxAgentMessageInput = AgentMuxAgentMessageSubmission & { agentSessionId: string }

export type AgentMuxAgentInteractionInput = AgentMuxInteractionOperationIntent & {
  /** Trusted Host attribution, not an unmanaged RPC argument. */
  authorHuman?: true
  moteSource?: import('./mote-input.js').AgentInputMoteSource
  agentSessionId: string
  expectedRun: AgentMuxRunRef
  response: AgentMuxInteractionResponse
}

export type AgentMuxAgentPostureInput = import('./agent-posture.js').PostureSet

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
  /** Same-turn original semantic-lease borrow; finite Files producers only, never long-lived Runs. */
  spawnFiniteFileProducer?: (spawn: (ownerLeaseFd: number) => ChildProcess) => ChildProcess

  /** Original assembly-owned Capsule seed projection; explicit Files cold path only. */
  retainedServiceExecutionDirectories?: () => Promise<readonly { workspacePath: string; runtimeId: string | null }[]>

  moteInputResolver?: AgentInputMoteResolver
  inputResources?: AgentInputResourceOwner
  /** Complete Host exports before freezing a new execution; original reads and healthy Runs stay available. */
  prepareExecutionEnvironment?: () => Promise<void>
  /** Original semantic owner identity, supplied by the Host; never inferred from a path or Run. */
  diagnosticOwner?: AgentStartupDiagnosticOwner
  externalConversationAuthority?: AgentExternalConversationAuthorityPort
  hostExecutorOwner?: AgentMuxHostExecutorOwner
  /** Read original local Session configuration on its semantic Host; never overrides target-owned or explicit SDK execution. */
  sessionExecutorConfiguration?(executorId: string): Promise<AgentExecutorConfig>
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
  /**
   * Directories this Host itself creates and owns (Mote and Topic homes). A Provider that asks for
   * folder trust is pre-trusted only for an exact home, never descendants. The target lets
   * the Host inspect only this launch's identity; an unavailable source must reject, not return [].
   */
  ownedWorkspaceRoots?: (workspacePath: string) => Promise<readonly string[]>
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
