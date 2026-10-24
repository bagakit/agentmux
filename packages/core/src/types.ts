import type { LaunchOption, LaunchOptionSelection } from './agent-launch-option.js'
import type { AgentMuxRunExitReason } from './agent-run-exit.js'
import type { AgentMuxCreationOrigin } from './agent-creation-admission.js'
export {
  BUILT_IN_AGENT_PROVIDER_IDS,
  type AgentProviderId,
  type BuiltInAgentProviderId
} from './agent-provider-id.js'
import type { AgentProviderId, BuiltInAgentProviderId } from './agent-provider-id.js'

// The risk vocabulary SSOT lives in its own node-free leaf so the renderer can import the tuple as a
// runtime value through `@agentmux/core/risk-tier` without dragging Core's process/filesystem runtime
// into the render process. Imported here for this module's own type-side use AND re-exported (not
// redeclared) so the barrel and existing consumers keep resolving `RISK_TIERS` / `RiskTier` from
// `./types.js` unchanged.
import { RISK_TIERS, type RiskTier } from './risk-tier.js'
export { RISK_TIERS, type RiskTier }

/** Observation callbacks finish synchronously; async work belongs to a Consumer-owned bounded queue. */
export type AgentMuxClientEventListener<Result = void> = (event: AgentMuxClientEvent) =>
  Result & (Result extends PromiseLike<unknown> ? never : unknown)

export type AgentMuxClientEventListenerOptions = {
  /** true selects future A2A changes/current cut; undefined lazily observes after listMessages; false excludes all A2A observation. */
  observeMessages?: boolean
  /** Called when this Consumer is detached. Fix the callback and explicitly register it again. */
  onError?(error: { code: string; message: string }): void
}

export type AgentExecutorId = string

/** A user-facing launch configuration backed by one Provider implementation. */
export type AgentExecutorConfig = {
  label: string
  providerId: AgentProviderId
  command: string
  args: string[]
  env: Record<string, string>
  injectAgentMuxGuide: boolean
}

export type ExecutionHostKind = 'local' | 'ssh'

export type AgentMuxRuntimeIdentity = {
  /** Launch provenance, independent of compatibility and stable across App restarts. */
  ownership?: 'owned' | 'unverified'
  hostId: string
  buildIdentity: string
  protocolVersion: number
  processId: number | null
  instanceId: string
}

export type AgentMuxRuntimeDiagnostics = {
  nodeVersion: string
  platform: string
  arch: string
  supported: boolean
  ctxmux: {
    state: {
      /** The directory a future cold activation would select. */
      configuredDirectory: string
      /** Proven current listener binding; null when launch provenance is unverified. */
      servingDirectory: string | null
    }
    /** The connected listener's public identity, never the package's identity. */
    serving: Pick<AgentMuxRuntimeIdentity, 'buildIdentity' | 'protocolVersion' | 'instanceId'> & {
      /** The public Runtime contract does not supply source provenance. */
      sourceCommit: null
    }
    /** Artifact provenance validated before connecting; it may differ from the listener. */
    bundled: {
      version: string
      sourceCommit: string
      artifactPlatform: string
    }
    ready: boolean
    capabilities: {
      transport: 'local-unix'
      orderedOutputBytes: true
      boundedReplay: true
      recoverableInput: true
      resize: true
      interrupt: true
      completeStop: true
    }
  }
}

/** Public, best-effort inventory of the Runtime's retained Runs, including historical Runs. */
export type AgentMuxRuntimeResourceSnapshot = {
  observedAt: number
  runCount: number
  runningRuns: number
  terminatedRuns: number
  /** Terminal and without a live attachment; this does not prove removal eligibility. */
  terminatedUnattachedRuns: number
  attachments: number
  /** Currently retained output payload in memory, not lifetime output or durable disk bytes. */
  retainedOutputBytes: number
}

export type AgentSemanticState =
  | 'unknown'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'done'
  | 'error'

export type AgentDisplayState =
  | 'starting'
  | 'running'
  | 'disconnected'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'done'
  | 'exited'
  | 'error'

/**
 * The final AgentMux runtime never infers semantic activity from terminal bytes.
 * Each public event names the owner that actually observed the fact.
 */
export type AgentMuxEvidenceSource =
  | 'terminal-output'
  | 'run-process'
  | 'native-hook'
  | 'native-transcript'
  | 'acp'
  | 'user'
  | 'agentmux'

export type AgentMuxRunState = 'running' | 'exited' | 'interrupted'

export type AgentMuxRunRef = {
  runId: string
}

/** Native service failure facts describe a lane; they never imply child exit. */
export type AgentMuxNativeServiceFailure =
  | 'owner_stopped' | 'owner_unwound' | 'read_failed' | 'write_failed' | 'historical' | 'control_closed'
  | { ownerIoFailed: { stage: 'poll' | 'wake_drain'; osError: number | null } }

/** Coherent owner facts at one Run-local revision, independent of process lifecycle/readiness. */
export type AgentMuxNativeService = {
  revision: number
  owner: { type: 'starting' | 'serving' | 'draining' } | { type: 'stopped'; reason: AgentMuxNativeServiceFailure }
  output: { type: 'pending' | 'serving' | 'backpressured' | 'closed' } | { type: 'unavailable'; reason: AgentMuxNativeServiceFailure }
  input: {
    phase: { type: 'open' | 'closed' } | { type: 'unavailable'; reason: AgentMuxNativeServiceFailure }
    unsettledCommands: number
    unsettledRequestBytes: number
    writeBlocked: boolean
    completedInputBytes: number | null
    currentSize: { cols: number; rows: number } | null
    activeConfirmedBytes: number
  }
  terminalFault: { stage: 'process' | 'resize' | 'export' | 'recovery'; throughByte: number } | null
}

export type AgentMuxRun = AgentMuxRunRef & {
  kind: 'terminal' | 'agent'
  providerId: AgentProviderId | null
  executorId: AgentExecutorId | null
  agentSessionId: string | null
  workspacePath: string
  pid: number | null
  state: AgentMuxRunState
  /** Owner-confirmed live PTY size, or `null` when no owner can confirm one. */
  cols: number | null
  rows: number | null
  observedAt: number
  latestOutputBytes: number
  acceptedInputBytes: number | null
  /** null only for a non-native Run; a running child alone does not prove service availability. */
  nativeService: AgentMuxNativeService | null
  exitCode?: number
  exitSignal?: string
  /**
   * 一次 `exited` 退出「为什么会这样」的诚实分类，与 `process-state` 事件上的同名字段同源、同值：
   * 两者都由 Client 在退出那一刻合成后记在台账里，投影时取出来。之所以要落在 run 上而不只在事件上：
   * 事件是一次性的，而 reload 后 renderer 只能拿到 snapshot——只挂在事件上的话，退出原因就成了
   * 「你在场才看得见」的东西，重开窗口就退化成裸 signal 号。
   */
  exitReason?: AgentMuxRunExitReason
  interruptionReason?: string
}

export type AgentMuxRunDataEvent = AgentMuxRunRef & {
  type: 'data'
  startByte: number
  endByte: number
  /** Original Run bytes; byteLength equals endByte - startByte, including partial UTF-8 sequences. */
  dataBytes: Uint8Array
  /** Streaming semantic text observation; may be empty and is not a byte-addressable payload. */
  data: string
}

export type AgentMuxRunExitEvent = AgentMuxRunRef & {
  type: 'exit'
  pid: number | null
  exitCode: number
  exitSignal?: string
  observedAt: number
}

export type AgentMuxRunReplayGap = {
  requestedAfterByte: number
  firstAvailableByte: number
}

/**
 * Original output and terminal restoration are explicit attachment representations.
 * Raw replay has no historical geometry: current Run size is metadata, never a resize fence.
 */
export type AgentMuxRunAttachmentView = 'raw' | 'terminal'

export type AgentMuxTerminalResize = {
  throughByte: number
  resizeRevision: number
  size: { cols: number; rows: number }
}

export type AgentMuxTerminalCheckpoint = {
  runId: string
  throughByte: number
  resizeRevision: number
  size: { cols: number; rows: number }
  restoreSize: { cols: number; rows: number }
  restoreScrollbackRows: number | null
  resizeAfterRestoreBytes: number
}

export type AgentMuxTerminalContinuation =
  | { type: 'not-requested' }
  | {
      type: 'basic-vt'
      checkpoint: AgentMuxTerminalCheckpoint
      /** Synthetic restoration bytes: never output, input or a raw byte acknowledgement. */
      restoreBytes: Uint8Array
      resizes: AgentMuxTerminalResize[]
    }
  | {
      type: 'unknown' | 'unavailable'
      reason: 'origin_unknown' | 'source_gap' | 'tail_evicted' | 'checkpoint_too_large' | 'invalid_checkpoint'
    }

export type AgentMuxRunAttachment = {
  run: AgentMuxRun
  replay: AgentMuxRunDataEvent[]
  gap: AgentMuxRunReplayGap | null
  terminal: AgentMuxTerminalContinuation
  resizeRevision: number
}

/**
 * Run 输入的字节载荷。string 由 ctxmux 侧按 **UTF-8** 编码上线；Uint8Array 则原样透传、逐字节
 * 不动。两条终端事件源要的正是这个区别：键盘/SGR 鼠标上报是合法文本走 string；而只开了旧式鼠标
 * 协议（?1000/?1002/?1003 而没开 ?1006）时，坐标字节可能 ≥128、是 latin1 语义，一旦经 UTF-8
 * 编码 0x80 会被拆成 0xC2 0x80、坐标就毁了——这种必须以 Uint8Array 上线。
 */
export type AgentMuxRunInputData = string | Uint8Array

/** Native terminal input, addressed to the Run the caller actually observed. */
export type AgentMuxAgentWriteInput = {
  agentSessionId: string
  expectedRun: AgentMuxRunRef
  data: AgentMuxRunInputData
  /** Protocol replies are not user attempts to answer a pending request. */
  source: 'user' | 'terminal-protocol'
  /** Optional read-only correlation; never a native operation or input requirement. */
  observation?: import('./performance-diagnostics.js').InputObservationReference
}

/** A terminal paste edits the current Run's draft without submitting a prompt. */
export type AgentMuxAgentPasteInput = {
  agentSessionId: string
  expectedRun: AgentMuxRunRef
  /** Clipboard text, preserving whitespace and line endings. */
  text: string
  /** Actual encoding emitted by this terminal client's paste operation. */
  terminalData: string
  /** Optional read-only correlation; malformed metadata is ignored. */
  observation?: import('./performance-diagnostics.js').InputObservationReference
}

export type AgentMuxRunInputOperation = {
  ownerInstanceId: string
  operationId: string
  expectedByte: number
  data: AgentMuxRunInputData
}

export type AgentMuxRunInputAck = AgentMuxRunRef & {
  appliedByteRange: {
    startByte: number
    endByte: number
  } | null
  acceptedThroughByte: number | null
}

export type AgentMuxRunAppliedSize = AgentMuxRunRef & {
  cols: number
  rows: number
}

/** Fixed owner-observed causes; a Gap is an observation loss, not child or Input failure. */
export type AgentMuxOutputGapCauses = {
  liveEventPressure: boolean
  subscriberLag: boolean
  sourceDiscontinuity: boolean
  terminalCatchup: boolean
  geometryLag: boolean
  clientViewPressure: boolean
  unknown: boolean
}

/** SDK handoff facts for one Attachment; no Renderer acknowledgement or permanent source loss is inferred. */
export type AgentMuxAttachmentGapObservation = {
  attachmentId: string
  runtime: { runtimeId: string; daemonInstanceId: string } | null
  runId: string
  origins: { daemon: boolean; client: boolean }
  firstObservedAtUnixMs: number
  lastObservedAtUnixMs: number
  deliveredAtUnixMs: number | null
  receivedOutputHeadByte: number | null
  deliveredThroughByte: number | null
  requestedAfterByte: number
  recoveryAfterByte: number
  missingOutputBytes: number | null
  queue: {
    payloadBudgetBytes: number
    envelopeBudgetBytes: number
    retainedPayloadBytes: number
    retainedEnvelopeBytes: number
    payloadHighWaterBytes: number
    envelopeHighWaterBytes: number
  }
  localPressure: {
    payloadLimitHit: boolean
    envelopeLimitHit: boolean
    attemptedPayloadBytes: number
    attemptedEnvelopeBytes: number
    droppedOutputBytes: number | null
    countersSaturated: boolean
  } | null
}

export type AgentMuxEvidence = {
  source: AgentMuxEvidenceSource
  observedAt: number
  run?: AgentMuxRunRef
  /** Facts from this output observation, never an Input or Renderer parsing acknowledgement. */
  outputGap?:
    | {
        kind: 'live-stream'
        latestOutputBytes: number
        /** This Core client's publication boundary; null when it owns no live Attachment. */
        publishedThroughByte: number | null
        representation: AgentMuxRunAttachmentView | null
        causes: AgentMuxOutputGapCauses
        observation: AgentMuxAttachmentGapObservation
      }
    | {
        kind: 'replay'
        latestOutputBytes: number
        requestedAfterByte: number
        firstAvailableByte: number
      }
  outputByteRange?: {
    startByte: number
    endByte: number
  }
  hookReceiptId?: string
  acpAdapterId?: string
  acpSessionId?: string
}

/**
 * Core 对 Hook 生命周期的 **canonical 词汇表**——所有 Provider 方言归一化后的落点。
 *
 * 为什么需要它：Provider 的事件名分属至少两种命名法（Claude/Codex 的 `PostToolUse`，Hermes 的
 * `post_tool_call`，Pi 的 `tool_execution_end`），而 Core 有几处判断真的需要知道「这条事件是什么」。
 * 此前那些判断靠事件名的**形状**来猜（`eventName.startsWith('Post')`），于是只对 PascalCase 的
 * Provider 成立：Hermes 与 Pi 虽然都声明了 `timeline: 'complete-events'`，它们的工具结果与失败态
 * 却永远读不出来——一条失败的命令和一条成功的命令在时间轴上长得一模一样。这份词汇表把「事件是什么」
 * 变成显式映射（见 agent-hook-event.ts 的映射表），Core 只对 canonical 值做判断。
 *
 * 刻意保持小：只收录 Core **真的会据以分支**的事件。Provider 的其他事件不进这份词汇表，它们的语义
 * 状态照旧完全由 Provider 自己声明的 `rules` 给出——归一化不是给每个厂商事件都发一张 Core 身份证，
 * 而是让 Core 需要的那几个判断在所有 Provider 上一致成立。
 */
export type AgentHookLifecycleEvent =
  | 'session-start'
  | 'user-prompt-submit'
  | 'permission-request'
  /** 一次工具调用的事前：只有入参，此刻谈不上成败。 */
  | 'tool-use-start'
  /** 一次工具调用的事后：结果与成败在此刻才存在。 */
  | 'tool-use-end'
  | 'subagent-start'
  | 'subagent-stop'
  /**
   * 一个 turn 开工。与 `user-prompt-submit` 分开是必须的：那一条说的是「用户交了输入」，这一条说的是
   * 「Agent 开始干这一轮」。有的 Provider 只报后者——Hermes 的 hook 面上根本没有「用户提交了 prompt」
   * 这种事件（用户在它自己的 TUI 里打字，AgentMux 看不见），能看见的只有它开始跑这一轮。把它记成
   * `user-prompt-submit` 会在 canonical 表里留一句假话；而两条都缺的后果见 hook-turn-phase.ts。
   */
  | 'turn-start'
  /** 一个 turn 收尾：本 turn 的 token 用量已在 transcript 落定。 */
  | 'turn-end'

/**
 * 首个 Prompt 怎么随启动送达。前三项都是「送得到」，`post-launch-only` 是**送不到**：
 * 这个 CLI 的交互 UI 根本没有「带着一条 prompt 启动并继续活着」的入口，于是首个 prompt 只能
 * 在进程起来之后按普通 turn 提交（`submitAgentPrompt`）。
 *
 * 它必须是一个显式取值而不是「声明成 argv 然后在 buildArgs 里悄悄丢掉」——后者会让用户的原话
 * 只落进 timeline、永不进程内，而界面看起来一切正常。声明成这一项后，`buildLaunch` 会在收到
 * 非空启动 prompt 时**当场拒绝**（见 agent-provider.ts），把「送不到」变成一次响亮的失败。
 *
 * **给后来声明 `post-launch-only` 的人：这个取值有一处必须一起接的耦合。** 那两个出口拒绝的是
 * 「非空的启动 prompt」，而生命周期路径交给它们的**不是**用户原话，是
 * `composeAgentLaunchPrompt` 的 text 产物——运行时引导默认注入，所以那份文本即使用户一个字都没写也
 * 恒非空（实测 528 字符）。于是「声明这一项」本身并不够：调用方必须先经
 * `splitLaunchPromptByDelivery`（agent-provider.ts）把它分成随启动送的与补送的两半，再把补送那半
 * 真的送出去。少了分流 = 这个 Provider 根本起不来；分了流却不补送 = 丢失只是从 argv 挪到了调用点。
 */
export type AgentPromptDelivery =
  | 'positional-argv'
  | 'hermes-query'
  | 'flag-prompt-interactive'
  | 'post-launch-only'

export type AgentReadySignal = {
  kind: 'foreground-process'
  expectedProcess: string
}

export type AgentTerminalHandshake = {
  query: string
  response: string
}

export type AgentTerminalPromptRenderMatcher = {
  frameStart: string
  activeComposer: string
  frameEnd: string
}

/** A single authorized submission's execution semantics, frozen with its bytes. */
export type AgentPromptExecution = 'default' | 'immediate'

/** Provider-neutral complete visible cells; content after the cursor remains present. */
export type AgentTerminalScreenSnapshot = {
  cols: number
  rows: number
  cursor: { row: number; column: number }
  lines: { text: string; wrapped: boolean; cells: { chars: string; dim: boolean }[] }[]
}

export type AgentPromptExecutionContext = 'idle' | 'interruptible' | 'unavailable'

/** Read-only Provider proof from this native Session, independent of PTY bytes. */
export type AgentPromptExecutionEvidence = {
  sourceId: string
  id: string
  nativeTurnId?: string
  state: 'idle' | 'working' | 'ended'
  endReason?: 'interrupted' | 'completed' | 'failed'
  observedAt?: number
  failure?: AgentFailure
  nativeOrdinal?: number
}

/** A Provider's exact native turn record; never inferred from terminal output. */
export type AgentProviderSessionStatus = {
  recordId: string
  /** Reading a retained snapshot does not prove fresh activity. */
  initialSnapshot?: true
  sequence?: number
  nativeTurnId: string
  state: 'working' | 'done' | 'error' | 'unknown'
  /** Exact native end; unknown state alone never closes a turn or its child scope. */
  endReason?: NonNullable<AgentPromptExecutionEvidence['endReason']>
  nativeObservedAt?: number
  failure?: AgentFailure
}

/** Opaque Provider fact captured before native resume, bound by Core to its new Run. */
export type AgentNativePromptPredecessor = {
  run: AgentMuxRunRef
  previousRun: AgentMuxRunRef
  sourceId: string
  evidenceId: string
}

export type AgentPromptInputPlan =
  | { kind: 'single-phase'; data: string }
  | {
      kind: 'render-then-submit'
      /** Exact transport bytes written before submit. */
      payload: string
      /** Logical text the Provider TUI renders after consuming transport control bytes. */
      renderedText: string
      submit: string
      /** Provider-owned control, applied before any payload, never after submit. */
      prepare?: { interrupt: string; endEvent: string; refresh?: string }
    }

export type AgentHookStrategy =
  | { kind: 'none' }
  // `explicit-managed`: AgentMux writes and owns the provider's hook config (codex/claude/antigravity).
  // `unmanaged`: the provider emits native hooks AgentMux understands, but its config lives on a surface
  // AgentMux does not install into yet (pi's TypeScript extension) — so hooks only fire if the user
  // wires them by hand. Distinct from `none`, which means the provider has no hooks.
  | { kind: 'native'; installation: 'explicit-managed' | 'unmanaged' }

export type AgentResumeStrategy =
  | { kind: 'none' }
  | { kind: 'provider-native'; locator: 'session-id' | 'transcript-path' }

export type AgentAcpStrategy =
  | { kind: 'none' }
  | { kind: 'adapter' }

export type AgentCapabilities = {
  terminal: true
  timeline: 'unavailable' | 'complete-events' | 'streaming'
  permission: 'none' | 'observe' | 'respond'
  providerResume: boolean
  /** Explicit native turn-interruption recognition. Missing evidence remains unknown when supported. */
  nativeInterruption?: true
  /** Native copies preserve their Provider context and receive a new conversation identity. */
  providerFork?: { current: true }
  replyCorrelation: 'none' | 'native-turn-id' | 'acp-turn-id'
  /** Exact async answers use the original managed native actor when declared. */
  asyncQuestionReply?: 'native-input'
  /** Manual current-terminal submit reports bytes; it does not promise Native steering. */
  promptExecution?: { immediate: 'terminal-submit' | 'interrupt-before-input' }
  /** Explicit selected-source input; only supported original managed Runs have its private transport. */
  nativeConversationInput?: { managedRuns: true }
  /**
   * 这个 Provider 是否报**真实**的原生 token 用量，以及它从哪条通道到达。
   *
   * 只声明证据支持的口径（设计 SSOT《状态栏》节）：`kind: 'native-transcript'` 表示 Provider 把每
   * turn 的 token 数写进它自己拥有格式的 transcript，AgentMux 的 hook 命令进程在既有收尾事件上读一次
   * 尾部、随既有回执带回——不新增轮询、不新增通道。**缺席（`undefined`）是一等公民的事实**，读作
   * "此 Provider 不报 token 用量"，UI 据此显示这句话而不是 0 或估算值。绝不为缺席补一个默认口径：
   * 一个编出来的 0 比没有这个数字更糟。
   */
  usage?: AgentUsageCapability
}

/**
 * usage 能力的声明形状。目前只有一种真实通道：Provider 原生 transcript。
 *
 * 刻意做成一个带 `kind` 的对象而不是布尔：将来若出现「原生事件流直接带 usage」的 Provider，它是
 * `kind` 的另一个成员，而不是把布尔改语义。`transcriptFormat` 让读取侧（hook 命令进程）按 Provider
 * 的 transcript 格式取数——这份格式知识关在 hook 进程里，Core 只见到已抽好的数。
 */
export type AgentUsageCapability = {
  kind: 'native-transcript'
  transcriptFormat: 'claude-jsonl' | 'codex-rollout'
}

/** Latest native usage sample delivered by the existing Hook. It is not a whole-turn total. */
export type AgentTurnUsage = {
  /** Native response coverage. Older saved samples without scope remain unknown. */
  scope?: 'response'
  /** Native Session accounting from the same observation; never response or context usage. */
  cumulative?: { scope: 'native-session'; inputTokens: number; outputTokens: number; totalTokens: number }
  /** Native context observation accompanying this sample; never lifetime billing totals. */
  context?: { usedTokens: number; capacityTokens: number }
  /** Native response output tokens. */
  outputTokens: number
  /** Native response input tokens. */
  inputTokens: number
  /** Existing sample total; its accounting is independent of history turn metrics. */
  totalTokens: number
  /** 采到这条用量的收尾事件观测时刻（epoch ms）——UI 用它说明"哪一段时间"的用量。 */
  observedAt: number
}

/**
 * 一个 Provider 的**完整公共合同**——Core 之外的任何一侧（Desktop 渲染层、CLI）认识一个 Provider
 * 所需的全部事实，且**只**从这里认识它。
 *
 * 七条能力轴，每条都由下面一个具名字段承载，缺一不可：
 * 1. **capability**：`capabilities`——这个 Provider 能做什么，逐项声明，未核实即不声明。
 * 2. **evidence**：`readySignal` 说「凭什么算就绪」；运行期每条事实再由 `AgentMuxEvidence.source`
 *    指名观察者（`native-hook`/`terminal-output`/`run-process`/`acp`/`user`）。AgentMux 绝不从终端
 *    字节推断语义活动，所以「谁观察到的」和「观察到什么」一样是合同的一部分。
 * 3. **Hook**：`hookStrategy`——有没有原生 hook，以及它的配置由谁安装（managed / unmanaged / 无）。
 * 4. **permission**：`capabilities.permission` 声明观察或应答的档位，`postureControl` 承载可寻址的
 *    在途安全姿态。二者都是 DESCRIBE 半边：键位（`input`）永不过 IPC，留在 Core 侧解析。
 * 5. **resume**：`resumeStrategy`——原生续跑的有无与**定位器种类**（session-id / transcript-path）。
 * 6. **prompt delivery**：`promptDelivery`——首个 Prompt 如何随启动送达（argv 位置参数 / 专用旗标 /
 *    子命令），或者**送不到**（`post-launch-only`：这个 CLI 没有「带 prompt 启动且不退出」的入口）；
 *    turn 内的送达形状另由 `AgentPromptInputPlan` 表达。
 * 7. **reply-correlation**：`capabilities.replyCorrelation`——能不能把一次回复关联回它的 turn，
 *    以及凭什么关联（原生 turn id / ACP turn id / 不能）。
 *
 * 这份合同是**纯可序列化数据**：没有函数、没有类实例。argv、键位、hook 规则这些 Provider 特有的
 * 知识全部留在 Core 侧（见 agent-launch-option.ts、agent-interaction.ts、hook-normalizer.ts），
 * 只有声明本身跨边界。因此**新增一个 Provider 是在 packages/core 里新增一个模块**——它填这七条轴，
 * Desktop 照这份声明渲染，ctxmux 继续只拥有 Run/PTY/ordered bytes/Replay/Gap/Attachment 与进程事实，
 * 两侧都不需要为它长出一条分支。
 */
export type AgentCatalogEntry = {
  id: AgentProviderId
  label: string
  executable: string
  expectedProcess: string
  promptDelivery: AgentPromptDelivery
  readySignal: AgentReadySignal
  hookStrategy: AgentHookStrategy
  resumeStrategy: AgentResumeStrategy
  acpStrategy: AgentAcpStrategy
  capabilities: AgentCapabilities
  /**
   * The DESCRIBE half of the sealed launch-option contract: pure serializable controls the renderer can
   * draw with no knowledge of the provider. Empty for a provider that declares no option, so the UI
   * renders nothing — absence hides the control rather than disabling it. The argv each choice
   * contributes never crosses IPC; it stays core-side (see agent-launch-option.ts).
   */
  launchOptions: LaunchOption[]
  /**
   * The DESCRIBE half of the sealed posture contract: a live, mid-session security-posture control the
   * composer draws, or absent. Present only for a Provider whose posture is ADDRESSABLE in-band — each mode
   * SET by a distinct keystroke over the existing PTY-input transport. Absent (the common case) for a
   * Provider that has no in-band posture affordance, or only a blind cycle it cannot address to a specific
   * mode, so the composer renders nothing. The keystroke each mode contributes never crosses IPC; it stays
   * core-side (see agent-interaction.ts).
   */
  postureControl?: AgentPostureControl
  /** Native command suggestions and skill roots, owned by the Provider; selection never submits. */
  composer?: {
    skillRoots: string[]
    commands: Array<{ text: string; description: string }>
  }
}

/** The original Host's filesystem observation; failure is not proof that execution is unavailable. */
export type AgentExecutableObservation = { executable: string } & (
  | { availability: 'available' }
  | { availability: 'missing'; cause?: { code: string; message: string } }
  | { availability: 'check-failed'; cause: { code: string; message: string } }
)

export type AgentCapabilitySnapshot = {
  providerId: AgentProviderId
  executable: string
  installed: boolean
  /** Contributed by the Provider's executable probe, independently of its supported capabilities. */
  executableObservation?: AgentExecutableObservation
  capabilities: AgentCapabilities
}

export type AgentNativeSessionHandle =
  | {
      kind: 'provider'
      providerId: AgentProviderId
      sessionId: string
      transcriptPath?: string
    }
  | {
      kind: 'acp'
      adapterId: string
      sessionId: string
    }

export type AgentHookSubject = {
  kind: 'main' | 'child' | 'foreign' | 'unknown'
  basis: 'provider-protocol' | 'process-native-record'
  nativeSessionId?: string
  reason: string
}

export type AgentNativeBinding = {
  source: 'native-hook' | 'process-witness' | 'semantic-resume-target' | 'user-confirmed' | 'user-selected'
  run: AgentMuxRunRef
  observedAt: number
}

/** A bounded current-source observation on the original Session; absence is a quiet confirmed binding. */
export type AgentNativeSourceObservation = {
  state: 'changed' | 'unknown' | 'ambiguous'
  run: AgentMuxRunRef
  observedAt: number
  reason: string
  /** Verified main members of this Run, not a claim about the frontend's selection. */
  candidates?: readonly Extract<AgentNativeSessionHandle, { kind: 'provider' }>[]
}

export type AgentMuxNativeSessionConfirmationInput = {
  agentSessionId: string
  expectedRun: AgentMuxRunRef
  expectedNativeHandle: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
  candidateNativeHandle: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
  expectedObservationAt: number
  operationId: string
}

/** The last explicit transition receipt preserves the old locator and unsettled interaction, not input authority. */
export type AgentNativeSessionConfirmationReceipt = {
  operationId: string
  run: AgentMuxRunRef
  previousNativeHandle: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
  nativeHandle: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
  observedAt: number
  candidateObservedAt: number
  /** Older receipts retain their original facts without inventing an observation basis. */
  basis?: 'current-main' | 'run-main-candidate'
  previousInteraction?: AgentMuxPendingInteraction
  /** Original prompt operation remains reconcilable, but cannot replay into this source. */
  previousPromptSubmissionId?: string
}

export type AgentMuxNativeSessionConfirmation = {
  session: AgentMuxAgentSession
  confirmation: AgentNativeSessionConfirmationReceipt
  persisted: true
  /** False reconciles an older confirmed operation without changing today's binding. */
  current: boolean
}

export type AgentHookReceipt = {
  subject?: AgentHookSubject
  decision?: { activityApplied: boolean; lifecycleApplied: boolean; reason: string }
  id: string
  providerId: AgentProviderId
  agentSessionId: string
  run: AgentMuxRunRef
  eventName: string
  /** Provider-proven native turn identity; never inferred from terminal text. */
  nativeTurnId?: string
  /** Provider-proven open main-tool facts retained by this one durable Hook owner. */
  toolInvocation?: AgentHookToolInvocation
  /** Provider-normalized lifecycle; unknown stays absent and the raw eventName is retained. */
  /** Null explicitly withholds lifecycle; undefined retains native-name semantics. */
  lifecycleEvent?: AgentHookLifecycleEvent | null
  observedAt: number
  outputCursorBytes?: number
}

export type AgentHookToolInvocation = {
  nativeSessionId: string
  nativeToolCallId: string
  nativeTurnId?: string
  nativeTranscriptPath?: string
  toolName: string
  toolInput: string
  /** Consecutive different tool starts in the same native turn cannot identify an ID-less request. */
  ambiguous?: true
}

/**
 * Why an Agent's prompt-readiness was established. `initial-composer` — the boundary the terminal
 * handshake drew when the composer first became writable; `native-stop` — a native Stop event proving
 * the Agent yielded the prompt. This is the SSOT for the vocabulary: {@link AgentTerminalPromptReadinessState.source}
 * uses it, {@link AgentTerminalPromptSubmissionState.readinessEvidence} derives from that, and the on-disk
 * validator in agent-session-store projects its runtime whitelist off a total `Record<this, true>` table
 * so adding a member here forces the table to gain a key (a compile error) rather than silently
 * fail-closing every legitimate session that carries the new member.
 */
export type AgentTerminalPromptReadinessSource = 'initial-composer' | 'native-stop'

export type AgentTerminalPromptReadinessState = {
  id: string
  run: AgentMuxRunRef
  readyThroughByte?: number
  consumedBySubmissionId?: string
} & (
  | { source: 'initial-composer'; outputCursorBytes: number }
  | {
      source: 'native-stop'
      /** Time of the native end itself; absent evidence remains unknown. */
      observedAt?: number
      /** A failed output snapshot cannot erase the native end. */
      outputCursorBytes?: number
    }
)

/** Provider-owned content purpose, never audience or sending authority. Missing means unconfirmed. */
export type AgentSessionHistoryContentEligibility = 'public' | 'private' | 'unconfirmed'
export type AgentSessionHistoryContentPart = (
  | { kind: 'text'; text: string;
      /** Provider-owned reading span in the original text, using UTF-16 indices. Copy keeps text complete. */
      readingRange?: { start: number; end: number } }
  | { kind: 'resource'; resourceType: 'image' | 'audio' | 'file' | 'other' | 'text'; reference: string; label?: string;
      /** Exact serialized semantic part, retained at the original source and read in bounded fragments. */
      content?: { encoding: 'json-utf8'; kind: 'text' | 'reasoning' | 'tool-call' | 'tool-result' | 'resource'; byteLength: number; sha256: string } }
  | { kind: 'reasoning'; text: string; signature?: string; redacted?: boolean }
  | { kind: 'tool-call'; name: string; input: string; callId?: string }
  | { kind: 'tool-result'; output: string; name?: string; callId?: string; failed?: boolean }
) & {
  contentEligibility?: AgentSessionHistoryContentEligibility
  /** Original tool/reasoning purpose when projection has a text or resource shape. Not sharing authority. */
  contentRole?: 'tool' | 'reasoning'
}

export type AgentSessionHistorySource = { providerId: AgentProviderId; nativeSessionId: string }

/** A Provider-recorded assistant phase, not reasoning or task-completion authority. */
export type AgentSessionHistoryMessagePhase = 'progress' | 'final'

/** Native collaboration references are read-only locators, never AgentMux Session or Run IDs. */
export type AgentSessionHistoryCollaboration =
  | {
      kind: 'message'
      /** The native conversation scopes these actor names; they are not AgentMux Session IDs. */
      source: AgentSessionHistorySource
      sender?: string
      recipient?: string
    }
  | {
      kind: 'operation'
      operation?: 'spawn' | 'send-input' | 'send-message' | 'followup' | 'wait' | 'resume' | 'interrupt' | 'close' | 'list'
      status?: 'running' | 'completed' | 'failed' | 'interrupted'
      sender?: AgentSessionHistorySource
      receivers: AgentSessionHistorySource[]
      prompt?: string
      /** Last recorded target states; independent of this operation and current Runtime state. */
      agentStates: {
        source: AgentSessionHistorySource
        state?: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'stopped' | 'not-found'
        message?: string
      }[]
    }
  | {
      kind: 'agent-activity'
      event: 'started' | 'interacted' | 'interrupted' | 'completed'
      agent: AgentSessionHistorySource
      /** Native logical path, not an execution directory or filesystem authority. */
      path?: string
    }

/** Durable reading and provenance only; no authority to control a current Run or send input. */
export type AgentSessionHistoryMetadata = Pick<AgentMuxStoredAgentSession,
  'providerId' | 'executorId' | 'workspacePath' | 'nativeHandle' | 'observedNativeHandle' | 'createdAt' | 'creation' | 'forkedFrom'> & {
  previousNativeHandle?: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
}

export type AgentSessionHistoryDescriptor = {
  agentSessionId: string
  hostId: string
  state: 'active' | 'retired'
  retiredAt?: number
  /** Original durable intent; absent operationId means its correlation is unavailable, not no attempt. */
  pendingReopen?: { operationId?: string }
  /** Absence means no retained locator, not an invitation to infer one. */
  history?: AgentSessionHistoryMetadata
}

/** Exact original source observation; omission reads the full retained catalog. */
export type AgentSessionHistorySourcesOptions = { agentSessionId?: string; signal?: AbortSignal }

/** Structured native asynchronous questions; absence of an answer is not pending authority. */
export type AgentSessionHistoryQuestion = {
  /** Provider-owned opaque identity; clients must never construct or parse it. */
  id: string
  prompt: string
  options: Array<{ id: string; label: string }>
  acceptsText: boolean
}

export type AgentSessionHistoryQuestionRequest = {
  delivery: 'async'
  questions: AgentSessionHistoryQuestion[]
}

/** A native user record's exact reply reference; its original contentParts remain untouched. */
export type AgentSessionHistoryQuestionAnswer = {
  questionId: string
  answer: string
  /** Question text carried by this native reply, not current pending or authenticated question authority. */
  prompt?: string
}

/** Provider-reported token counts; missing counts stay absent and are never estimated or summed. */
export type AgentSessionHistoryTokenUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  reasoningOutputTokens?: number
}

/** Read-only facts on the original native record, never Runtime or input authority. */
export type AgentSessionHistoryMetrics = {
  /** turn requires the original item's exact turnId; response is scoped to the original record. */
  scope: 'turn' | 'response'
  /** Native wall-clock elapsed milliseconds, not inference time or a locally started timer. */
  durationMs?: number
  usage?: AgentSessionHistoryTokenUsage
  /** Only an explicit native outcome, independent of the Session/Run's current state. */
  status?: 'completed' | 'failed' | 'interrupted'
}

export type AgentSessionHistoryItem = {
  id: string
  /** Read-only typed source relationships, interpreted at the original Provider boundary. */
  conversation?: import('./conversation-stream.js').ConversationRecordProvenance
  conversationDiagnostic?: { code: string; message: string; original?: unknown }
  turnId?: string
  /** System messages describe read-only native history; they grant no input, identity or permission authority. */
  kind: 'user-message' | 'assistant-message' | 'system-message' | 'activity'
  messagePhase?: AgentSessionHistoryMessagePhase
  questionRequest?: AgentSessionHistoryQuestionRequest
  questionAnswers?: AgentSessionHistoryQuestionAnswer[]
  /** A local native question/answer reading projection diagnostic; original speech and adjacent history stay readable. */
  questionDiagnostic?: { code: string; message: string }
  metrics?: AgentSessionHistoryMetrics
  /** Optional metrics unavailable; original content, identity and reading remain available. */
  metricsDiagnostic?: { code: string; message: string }
  /** Original contentParts remain complete and copyable alongside this optional summary. */
  collaboration?: AgentSessionHistoryCollaboration
  title?: string
  contentParts: AgentSessionHistoryContentPart[]
  startedAt?: number
  completedAt?: number
}

/** Native conversation pages are separate from captured AgentMux Timeline and Run byte Replay. */
export type AgentSessionHistoryPage = {
  agentSessionId: string
  /** Original Core namespace, supplied by the actual read owner, never a Provider/client alias. */
  sourceHostId?: string
  source: AgentSessionHistorySource
  /** Each page is chronological; the first page contains the newest items. */
  items: AgentSessionHistoryItem[]
  nextCursor: string | null
  /** Provider-issued changes boundary of this exact frozen history snapshot.
   * Absent means a history-to-changes join is not established. Never decode or order it. */
  changesCursor?: string
  /** Provider-issued original page opening position at the same frozen physical cut.
   * Reuse with the original limit; absence does not establish repeatability of a null-cursor head. */
  replayCursor?: string
  /** Physical native transcript snapshot bytes, including Provider metadata; not message, turn or token counts.
   * An unfinished append may be excluded. Absent means the Provider does not establish this extent. */
  sourceSizeBytes?: number
}

export type AgentSessionHistoryPageOptions = {
  cursor?: string
  limit?: number
  /** Explicitly confirm this healthy Run's current native source; never combines with an earlier cursor. */
  refreshNativeSource?: boolean
  /** Require this read's current Run/Provider witness; an unchanged retained source cannot qualify it. */
  requireCurrentSource?: true
  /** Cancel this bounded read, independently of the healthy Run or other readers. */
  signal?: AbortSignal
  /** Read the original records retained by the latest explicit source confirmation. Never controls the Run. */
  nativeSource?: 'previous'
  /** The host supplies its configured Executor invocation, as for create/resume. */
  commandOverride?: string
  args?: readonly string[]
  env?: Readonly<Record<string, string | undefined>>
}

/** A short-lived, read-only witness for a missing native locator, never Run control. */
export type AgentProviderNativeSessionDiscoveryContext = {
  processId: number
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  workspacePath: string
  signal: AbortSignal
}

export type AgentProviderNativeSessionWitness = {
  /** Provider-confirmed descendants of the same process-native main Session. */
  childSessionIds?: readonly string[]
  handle: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
  /** Recheck the observed native record before accepting a late result. */
  assertCurrent(): Promise<void>
  /** Exact Run membership only; does not claim the frontend is displaying this conversation. */
  assertPresent?(): Promise<void>
  candidates?: never
}

export type AgentProviderNativeSessionCandidateWitness = Pick<AgentProviderNativeSessionWitness, 'handle' | 'childSessionIds'> & {
  /** Recheck this original member and file object, independently of the other main members. */
  assertPresent(): Promise<void>
}

export type AgentProviderNativeSessionDiscovery = AgentProviderNativeSessionWitness | {
  candidates: readonly AgentProviderNativeSessionCandidateWitness[]
  handle?: never
  childSessionIds?: never
  assertCurrent?: never
  assertPresent?: never
}

export type AgentNativeResumeSource = {
  nativeHandle: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
  workspacePath: string
  /** Provider-issued file lifetime identity. Appends do not change it; replacement does. */
  revision: string
}

export type AgentNativeSessionCandidate = {
  source: AgentNativeResumeSource
  title?: string
  createdAt?: number
  updatedAt: number
  /** Original Core ownership, never inferred from cwd, title or Runtime Run alone. */
  managed?: { agentSessionId: string; executorId: string; run: AgentMuxRunRef; state: 'active' | 'retired'; retiredAt?: number }
}

export type AgentNativeSessionCatalog = {
  providerId: AgentProviderId
  capabilities: AgentCapabilities
  availability: 'available' | 'unsupported'
  sessions: AgentNativeSessionCandidate[]
  issues: Array<{ code: string; message: string }>
}

export type AgentProviderNativeSessionListContext = {
  workspacePath?: string
  env: Readonly<Record<string, string | undefined>>
  signal: AbortSignal
}

export type AgentProviderNativeResumeContext = AgentProviderNativeSessionListContext & {
  source: AgentNativeResumeSource
}

export type AgentProviderSessionHistoryContext = {
  /** Core identity of the original reader, when invoked through a Core Session. */
  agentSessionId?: string
  /** Existing private Session credential for domain-separated content signatures; never a public locator. */
  contentSigningSecret?: string
  source: AgentSessionHistorySource
  /** Exact locator captured from this Session's durable native handle; never guessed from a home directory. */
  transcriptPath?: string
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  workspacePath: string
  cursor?: string
  limit: number
  signal: AbortSignal
}

/** Exact recorded content; expectedReference compares the original part and never authorizes a caller path. */
export type AgentSessionHistoryResourceRequest = {
  source: AgentSessionHistorySource
  turnId?: string
  recordId: string
  partIndex: number
  expectedReference: string
  /** May only reduce the fixed 16 MiB binary budget; text fragments use at most 128 KiB. */
  maxBytes?: number
  /** Explicit image or self-contained file bytes for this same original part, including a signed wrapper. Omit for its recorded representation. */
  representation?: 'image' | 'file'
  /** An image node in this exact original text revision. The reference remains a compare constraint, never a caller path grant. */
  markdownImage?: { index: number; textSha256: string }
  /** Byte position in the exact serialized text part. Explicit binary representations do not accept an offset. */
  offsetBytes?: number
}
export type AgentSessionHistoryResourceReadOptions = AgentSessionHistoryResourceRequest & Pick<AgentSessionHistoryPageOptions,
  'signal' | 'commandOverride' | 'args' | 'env'>
export type AgentSessionHistoryResourceReadResult = {
  agentSessionId: string
  source: AgentSessionHistorySource
  turnId?: string
  recordId: string
  partIndex: number
  reference: string
  label?: string
  result: { status: 'read'; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; dataBase64: string; byteLength: number; width: number; height: number }
    /** Recorded media type and label are metadata, not a verified file format or sharing permission. */
    | { status: 'file'; mimeType: string; dataBase64: string; byteLength: number; label?: string }
    | { status: 'fragment'; encoding: 'json-utf8'; dataBase64: string; byteLength: number;
        offsetBytes: number; totalBytes: number; sha256: string; nextOffsetBytes: number | null;
        /** Original Provider renewed this exact read-only extent. Send as the next expectedReference, retaining source/record/part and content metadata. */
        continuationReference?: string }
    | { status: 'unavailable'; code: string; message: string }
}

/** Provider-owned stable lookup through its original native reader, never a moving newest page. */
export type AgentProviderSessionHistoryRecordContext = Omit<AgentProviderSessionHistoryContext, 'cursor' | 'limit'> & {
  turnId?: string
  recordId: string
}

export type AgentSessionQuestionReplyReceipt = {
  agentSessionId: string
  source: AgentSessionHistorySource
  recordId: string
  questionIds: string[]
  operationId: string
  /** Normal input delivery completed; only an observed native user record proves an answer. */
  outcome: 'submitted'
}

export type AgentProviderSessionHistoryPage = Omit<AgentSessionHistoryPage, 'agentSessionId'>

/** Read an exact Provider-issued persisted conversation without adopting a Core Session or Run. */
export type AgentNativeHistoryReadOptions = { source: AgentNativeResumeSource } & Pick<AgentSessionHistoryPageOptions,
  'cursor' | 'limit' | 'signal' | 'commandOverride' | 'args' | 'env'>

export type AgentNativeHistoryResourceReadOptions = AgentSessionHistoryResourceReadOptions & {
  nativeSource: AgentNativeResumeSource
}
export type AgentProviderSessionHistoryResourceReadResult = Omit<AgentSessionHistoryResourceReadResult, 'agentSessionId'>

/** A relevant native source changed; this is not a user message or an accepted input receipt. */
export type AgentProviderSessionHistoryObservation =
  | { kind: 'invalidated'; source: AgentSessionHistorySource }
  | { kind: 'unavailable'; source?: AgentSessionHistorySource; code: string; message: string }

export type AgentSessionHistoryObservation = AgentProviderSessionHistoryObservation & { agentSessionId: string }

export type AgentSessionHistoryObservationOptions = Pick<AgentSessionHistoryPageOptions,
  'commandOverride' | 'args' | 'env' | 'nativeSource'> & { signal?: AbortSignal }

export type AgentSessionHistoryObservationHandle = {
  source: AgentSessionHistorySource
  /** Resource termination only; absence is unknown and never implies a lost Session or Run. */
  closed?: AbortSignal
  dispose(): void
}

/** Providers own their native locator and observation protocol. No Run authority is required. */
export type AgentProviderSessionHistoryObservationContext = Omit<AgentProviderSessionHistoryContext,
  'cursor' | 'limit'> & { onChange(observation: AgentProviderSessionHistoryObservation): void }

/** Authenticated operation origin supplied by the Host, independent of message authorship. */
export type AgentOperationDevice = { hostId: string; deviceId: string; name: string }

/** Supplied by the actual input owner; a native user role does not establish this fact. */
export const AGENT_MESSAGE_CHANNELS = ['terminal', 'message-tool', 'cli', 'api', 'agent-message', 'reaction', 'question-reply'] as const
export type AgentMessageChannel = (typeof AGENT_MESSAGE_CHANNELS)[number]

export type AgentSessionUserMessageSource =
  | { kind: 'native'; providerId: AgentProviderId; nativeSessionId: string; recordId: string }
  | { kind: 'captured'; submissionId: string; channel?: AgentMessageChannel; device?: AgentOperationDevice }

export type AgentSessionUserMessageAuthor =
  | import('./external-author.js').AgentExternalMessageAuthor
  | import('./external-conversation.js').AgentExternalConversationAuthor
  | { kind: 'human' }
  | { kind: 'agent'; agentSessionId: string }
  | { kind: 'unknown' }

export type AgentSessionUserMessage = {
  inputSubmission?: import('./agent-input-conversation.js').AgentInputSubmissionObservation
  inputContext?: import('./browser-input-context.js').BrowserInputContext
  inputContextSource?: import('./browser-input-context.js').BrowserInputContextSource
  inputContextCaptureProof?: import('./agent-input-context-capture.js').AgentInputContextCaptureProof
  id: string
  rawId: string
  agentSessionId: string
  turnId?: string
  source: AgentSessionUserMessageSource
  /** Exact original record/version reading fact; absence is unknown and conveys no author, adoption or input authority. */
  sourceRecord?: import('./conversation-changes.js').ConversationWindowBoundary
  /** Original captured user input identity; never inferred from the body or submission label. */
  inputRef?: import('./agent-prompt-condition.js').AgentPromptInputKey
  /** Minimal original reading relationships, independent of the projected body and its ID. */
  conversation?: Pick<import('./conversation-stream.js').ConversationRecordProvenance, 'sameEvent' | 'nativeInput' | 'adoptedInput'>
  author: AgentSessionUserMessageAuthor
  /** Original user-content boundary only; absence is unknown. Not sharing authority, safety or identity. */
  publicContent?: 'confirmed' | 'unknown'
  content: string
  contentParts: AgentSessionHistoryContentPart[]
  /** Existing Provider reply facts; the original contentParts remain complete for Copy. */
  questionAnswers?: AgentSessionHistoryQuestionAnswer[]
  /** Read-only projection details; original contentParts stay readable and copyable. */
  questionDiagnostic?: { code: string; message: string }
  recordedAt?: number
  deliveryStatus?: 'complete' | 'unverified' | 'failed'
}

/** Provider machine plan; this is a native admission, never a PTY byte receipt. */
export type AgentNativePromptInputPlan = Readonly<{
  kind: 'native-rpc'
  protocolId: string
  sourceId: string
  actorId: string
  threadId: string
  /** Original Core-issued correlation frozen in the durable claim; not idempotency or adoption. */
  clientCorrelation?: string
} & (
  /** Manual input authorizes the actor's atomic idle start or busy append. */
  { operation: 'start-or-steer'; expectedTurnId?: never } |
  /** The original native input owner queues this frozen input and dispatches only while idle. */
  { operation: 'queue-idle'; expectedTurnId?: never } |
  /** Original exact-turn plans remain readable and joinable; never converted. */
  { operation?: 'steer'; expectedTurnId: string }
)>

/** Original creation facts survive explicit retirement without becoming an active Session. */
export type AgentMuxAgentCreationInspection = AgentMuxAgentSession |
  ({ kind: 'retired-agent' } & import('./agent-session-store.js').AgentMuxRetiredAgentSession)

export type AgentMuxAgentSession = {
  /** Read-only admissions retained through explicit retirement and reopen. */
  continuityControlReceipts?: Record<string, import('./agent-session-recovery/control-contract.js').AgentMuxContinuityControlReceipt>
  /** Core-owned current decision and exact original operation receipts. */
  continuity?: import('./agent-session-recovery/continuity-contract.js').AgentMuxContinuityOperation
  continuityOperations?: Record<string, import('./agent-session-recovery/continuity-contract.js').AgentMuxContinuityOperation>
  kind: 'agent'
  agentSessionId: string
  providerId: AgentProviderId
  executorId: AgentExecutorId
  hostId: string
  workspacePath: string
  run: AgentMuxRunRef
  retiredRuns: AgentMuxRunRef[]
  createdAt: number
  updatedAt: number
  /** Same creation's correlation and protocol delivery fact; never task acceptance or execution. */
  creation?: AgentMuxAgentCreationFact
  /** Exact user retirement from which this Run explicitly continued; not a guessed reason. */
  reopenedFrom?: { run: AgentMuxRunRef; source: 'user'; observedAt: number }
  /** Exact ancestry of a native copy; it does not confer current source or input authority. */
  forkedFrom?: import('./agent-fork.js').AgentMuxAgentForkSource
  /**
   * The chosen launch-option ids that fixed this Agent's security posture at spawn (sandbox, approval,
   * permission-mode — see agent-launch-option.ts). Persisted so a stop/resume re-resolves the SAME argv
   * the create used: the posture is fail-closed, so it must survive the Run boundary rather than silently
   * reverting to the Provider's more permissive default. Absent when the create narrowed nothing.
   */
  launchOptions?: LaunchOptionSelection
  /** Live Provider observation; never persisted as durable health. */
  terminalFrontend?: import('./agent-terminal-frontend.js').AgentTerminalFrontend
  terminalHandshake?: AgentTerminalHandshakeState
  terminalCapability?: AgentTerminalCapabilityState
  terminalPromptReadiness?: AgentTerminalPromptReadinessState
  /** Stored admission facts; control observations omit bodies. Use the exact future-intent read APIs. Civil calendars remain Host facts. */
  futurePromptIntents?: Record<string, AgentFuturePromptIntent>
  /** Latest claimed prompt range; successful completion is consumed by the same admission. */
  promptCompletionAdmission?: {
    /** Exact producer identity captured only by the original new input admission. */
    inputKey?: import('./agent-prompt-condition.js').AgentPromptInputKey
    /** Original journal gate acknowledged before this input claim. */
    inputDispatch?: import('./agent-input-wait.js').AgentInputDispatchLink
    /** Logical identity when captured at admission; operationId always binds the Run and bytes. */
    submissionId?: string
    completionId?: string
    futureIntent?: AgentFuturePromptOccurrence
    operationId: string
    /** Original native output boundary retained for passive future-message idle confirmation. */
    outputCursorBytes?: number
    /** Frozen before dispatch; missing input facts are unknown, never reconstructed. */
    intent?: {
      run: AgentMuxRunRef
      ownerInstanceId: string
      prompt: string
      plan: AgentPromptInputPlan | AgentNativePromptInputPlan
      execution?: AgentPromptExecution
      admissionIntent?: import('./agent-prompt-condition.js').AgentPromptAdmissionIntent
      /** Producer facts frozen with the first wire; tags in user text never establish these. */
      message?: AgentPromptMessageContent
    }
    /** Authorized non-submitting native redraw, independent of prompt delivery. */
    frameRefresh?: AgentTerminalInputPhaseState & { outputCursorBytes: number; resizeRevision: number; nativeSourceId: string }
    acknowledged?: boolean
    notApplied?: boolean
    uncertainTurn?: boolean
  } & (
    { transport?: 'pty'; startByte: number; endByte: number; native?: never } |
    { transport: 'native'; startByte?: never; endByte?: never;
      native: { plan: AgentNativePromptInputPlan; outcome: 'claimed' | 'admitted' | 'not-applied' | 'unknown'; turnId?: string; queuedSubmissionId?: string; errorCode?: number } }
  )
  terminalPromptSubmission?: AgentTerminalPromptSubmissionState
  terminalPromptDelivery?: AgentTerminalPromptDeliveryState
  terminalOutputChannel?: AgentTerminalOutputChannelState
  semanticStatus?: AgentStatus
  /** Live, ordered native main-turn activity. Not a task result or durable recovery proof. */
  currentActivity?: AgentCurrentActivity
  pendingInteraction?: AgentMuxPendingInteraction
  nativeHandle?: AgentNativeSessionHandle
  /** Live Core save acknowledgement for this locator; readable post-replacement bytes are unconfirmed. Never stored. */
  nativeHandlePersistence?: 'confirmed' | 'unconfirmed'
  nativeBinding?: AgentNativeBinding
  /** A confirmed process source that cannot silently replace a retained resume target. */
  observedNativeHandle?: AgentNativeSessionHandle
  nativeSourceObservation?: AgentNativeSourceObservation
  /** Current Core-owned Hook restore failure, scoped to this exact Run; never a durable or semantic status. */
  hookIngressObservation?: AgentHookIngressObservation
  nativeConfirmation?: AgentNativeSessionConfirmationReceipt
  /** Original confirmed operation facts; the Provider still has only one current conversation. */
  nativeConfirmationHistory?: AgentNativeSessionConfirmationReceipt[]
  nativePromptPredecessor?: AgentNativePromptPredecessor
  hookReceipt?: AgentHookReceipt
  /**
   * 最近一次原生响应的用量样本，随收尾事件的 Hook 回执覆盖式更新，不累加历史、不冒充整轮。
   * 仅 usage 能力声明为 `native-transcript` 的 Provider 会写入；旧样本缺 scope 时范围未知，
   * 缺席用量表示尚未取得或 Provider 未报告，不显示虚构的 0。
   */
  turnUsage?: AgentTurnUsage
}

/** Original Session-owner record; legacy missing identity/source remains missing. */
export type AgentPromptSubmissionRecord = {
  /** Original Runtime launch carrier; never a PTY or Provider acceptance ACK. */
  launch?: import('./agent-session-recovery/continuity-contract.js').AgentMuxContinuityLaunchInput
  agentSessionId: string
  run: AgentMuxRunRef
  admission?: NonNullable<AgentMuxAgentSession['promptCompletionAdmission']>
  terminalPromptSubmission?: AgentTerminalPromptSubmissionState
}

/** Original requested position, never a placement ACK or a role/permission grant. */
export type AgentMuxAgentCreationSpatialIntent = { tabId: string; regionId: string; executionWorkspaceId: string }

export type AgentMuxAgentCreationFact = {
  createOperationId: string
  /** Frozen only when supplied by this creation; old Sessions remain without a position claim. */
  spatialIntent?: AgentMuxAgentCreationSpatialIntent
  /** Safe reference to the original input owner; private launch text is never projected here. */
  initialInputKey?: Extract<import('./agent-prompt-condition.js').AgentPromptInputKey, { kind: 'prompt' }>
  /** Original authenticated creation source, distinct from initial-message author and fork ancestry. */
  createdBy?: import('./agent-spawn.js').AgentMuxSpawnCreator
  /** First actual Run of this creation; later resume never replaces this provenance. */
  createdRun?: AgentMuxRunRef
  /** Reference to the original initial message, absent when no body was requested. */
  initialMessageId?: string
  /** Original source admission and target trust; it does not prove an initial message exists. */
  initialMessageOrigin?: AgentMuxCreationOrigin
  executorRevision?: string
  /** Complete authenticated creation intent hash; no raw launch secrets are persisted. */
  intentDigest?: string
  /** The actual Run is kept while its Session commit cannot be confirmed. */
  persistence?: 'unconfirmed'
  failure?: { step: 'session-commit' | 'hook-bind' | 'handshake'; code: string; message: string }
  initialPrompt: 'not-requested' | 'confirmed' | 'unconfirmed' | 'unknown'
  /** Delivery of this creation's AgentMux reminder, separately from a user prompt. */
  agentMuxContext?: 'confirmed' | 'unconfirmed' | 'unknown'
}

/** Original message segments and verified authors captured before Input dispatch. */
export type AgentPromptMessageContent = {
  /** Original Core notification input identity; the encoded text does not establish this fact. */
  a2aNotificationId?: string
  inputContext?: import('./browser-input-context.js').BrowserInputContext
  inputContextSource?: import('./browser-input-context.js').BrowserInputContextSource
  inputContextCaptureProof?: import('./agent-input-context-capture.js').AgentInputContextCaptureProof
  /** Original question identity frozen with this input; independent of encoded native text. */
  questionReply?: { source: AgentSessionHistorySource; turnId: string; recordId: string; questionIds: string[]; externalAction?: import('./external-author.js').AgentExternalInteractionAuthor }
  userContent?: string
  systemContext?: string
  authorAgentSessionId?: string
  authorHuman?: true
  authorExternal?: import('./external-author.js').AgentExternalMessageAuthor
  sourceDevice?: AgentOperationDevice
  sourceChannel?: AgentMessageChannel
}

export type AgentFuturePromptOccurrence = { intentId: string; occurrenceAt: number }
export type AgentFuturePromptIntent = {
  operationId: string
  prompt: string
  message: AgentPromptMessageContent
  active: boolean
  lastOccurrenceAt?: number
  lastOperationId?: string
}

export type AgentTerminalHandshakeState = {
  /** New frontend on the same Run has its own reply and fresh output boundary. */
  frontendId?: string
  outputAfterByte?: number
  run: AgentMuxRunRef
  operationId: string
  inputByteRange: {
    startByte: number
    endByte: number
  }
  acknowledged: boolean
}

/**
 * The durable fact that the Provider terminal capability could not be verified for this exact Run.
 *
 * `unknown` is intentional: a missing capability receipt is not evidence that the Agent itself is
 * broken. `mode: 'degraded'` tells clients that Core continues to accept input using CtxMux's
 * authoritative cursor, while the optional handshake receipt remains absent or unacknowledged. The record is cleared
 * when a later handshake is acknowledged or when the Run is replaced.
 */
export type AgentTerminalCapabilityState = {
  state: 'unknown'
  mode: 'degraded'
  reason: 'handshake-timeout' | 'handshake-unconfirmed'
  diagnostic?: { code: string; message: string }
  run: AgentMuxRunRef
  observedAt: number
}

/**
 * 服务窗事实（原则 11 第 2 类）：重连成功、进程仍在跑，但这一屏到该 Run 的**实时输出通道**没能重建
 * （`republishLiveRunState` 的 `resumed === 'dead'` 分支——见 client.ts）。输入照常送达 Agent，可它的
 * 输出永远到不了这块屏，用户对着一块永不回显的屏幕打字。放行是对的（能力还在，第 2 类），但放行必须
 * 配告知，否则诚实只做了一半。
 *
 * 为什么单开一条状态位、不复用 `terminalCapability`/`terminalPromptDelivery`：三条各有各的生命周期，
 * 且可**同时**成立。这条的清除路径是「实时通道重新接上」——一次成功的 reattach（`resumeLiveAttachment`
 * 返回 `live`/`truncated`）就地撤下它，Run 被替换时随 Run 级状态一起清除。`state: 'severed'` 说的正是
 * 「通道断了、进程没断」这件事本身。
 */
export type AgentTerminalOutputChannelState = {
  state: 'severed'
  mode: 'degraded'
  reason: 'reattach-failed'
  run: AgentMuxRunRef
  observedAt: number
}

/**
 * 屏幕验证没走通的原因。元组是 SSOT，理由同 {@link RISK_TIERS}：存储层要按这份清单校验磁盘
 * 数据，手抄一份只强制 ⊆ 而对 ⊇ 失明，加一个原因却忘了往那份手抄里加，会让带新原因的合法记录被
 * fail-closed 丢掉且无编译错。
 */
export const PROMPT_DELIVERY_DEGRADED_REASONS = [
  'screen-evidence-gap', 'prompt-render-timeout', 'screen-evidence-replaced', 'turn-end-unconfirmed', 'input-unconfirmed', 'immediate-context-unconfirmed'
] as const
export type PromptDeliveryDegradedReason = (typeof PROMPT_DELIVERY_DEGRADED_REASONS)[number]

/** 同 {@link isPermissionOptionKind}：清单与断言收成一处，别让调用方写 `!== 'a' && !== 'b'` 的手抄链。 */
export function isPromptDeliveryDegradedReason(value: unknown): value is PromptDeliveryDegradedReason {
  return PROMPT_DELIVERY_DEGRADED_REASONS.includes(value as PromptDeliveryDegradedReason)
}

/**
 * 服务窗事实（原则 11 第 2 类）：一次 prompt 交付的 payload 受据已确认、Run 仍存活，但屏幕
 * 验证没走通——replay 被截断（`screen-evidence-gap`）或渲染确认超时（`prompt-render-timeout`）。
 * Core 照常发出提交键；这条记录告诉 client 哪一步没走通、现在按什么状态在跑。恢复路径：
 * 下一次完整验证成功的 prompt 交付会清除它；Run 被替换时随 Run 级状态一起清除。
 */
export type AgentTerminalPromptDeliveryState = {
  state: 'unverified'
  mode: 'degraded'
  reason: PromptDeliveryDegradedReason
  submissionId: string
  run: AgentMuxRunRef
  observedAt: number
}

export type AgentTerminalInputPhaseState = {
  operationId: string
  inputByteRange: {
    startByte: number
    endByte: number
  }
  acknowledged: boolean
  /** Original Native owner rejected this immutable phase after its range was occupied. */
  notApplied?: true
}

export type AgentTerminalPromptSubmissionState = {
  run: AgentMuxRunRef
  submissionId: string
  promptDigest: string
  /** Optional observation, never an admission permit for a healthy Run. */
  readinessEvidence?: {
    source: AgentTerminalPromptReadinessState['source']
    id: string
    outputCursorBytes: number
    readyThroughByte: number
  }
  outputCursorBytes: number
  /** Immutable preparation receipt; absent on ordinary input. */
  prepare?: {
    context: 'idle' | 'interruptible'
    nativeTurnId?: string
    previousReceiptId?: string
    nativeSourceId?: string
    /** Native end receipt for that turn, followed by an empty-composer frame. */
    barrierReceiptId?: string
    readyThroughByte?: number
    interrupt?: AgentTerminalInputPhaseState
  }
  payload: AgentTerminalInputPhaseState
  submit: AgentTerminalInputPhaseState
}

/** A live auxiliary observation failure; absent means no retained Hook restoration failure. */
export type AgentHookIngressObservation = {
  run: AgentMuxRunRef
  phase: 'listen' | 'binding'
  code: string
  message: string
  observedAt: number
}

/** This is the complete persistent semantic/control record. It deliberately has no
 * PTY, process, replay, terminal snapshot, terminal output bytes or ephemeral Hook observation. */
export type AgentMuxStoredAgentSession = Omit<AgentMuxAgentSession, 'hookIngressObservation' | 'nativeHandlePersistence' | 'currentActivity' | 'terminalFrontend'> & {
  /** Original creation input frozen before Start; only its key is public. */
  initialInput?: import('./agent-session-recovery/continuity-contract.js').AgentMuxContinuityLaunchInput
  /** Retained original-Run recovery evidence; never a live activity or input-authorization projection. */
  recoveryActivity?: AgentRecoveryActivity
  /** Private native service credential, frozen with this original lifecycle launch. Never a public capability ACK. */
  nativeActor?: AgentPrivateNativeActor
  /** Private original invocation provenance; retained opaque and checked only at its exact root. Never public. */
  continuityExecutors?: unknown

  /** Original response operation index. Retained after the live request settles; never broadcast. */
  interactionOperations?: Record<string, AgentMuxInteractionOperationReceipt>

  /** Exact ends for the original native-status source; private, independent of the current display state. */
  nativeTurnEnds?: {
    run: AgentMuxRunRef
    providerId: AgentProviderId
    nativeHandle: AgentNativeSessionHandle
    turns: Record<string, { recordId: string; observedAt: number; nativeObservedAt?: number }>
  }

  hookBindingId: string
  hookToken: string
  /** Agent 说话凭证的 sha256。raw 只在受管进程的 env 里，Core 侧只留 hash。 */
  capabilityHash?: string
  /** Bounded accepted-observation commit state; never a second history ledger. */
  activityCommit?: AgentActivityCommit
}

export type AgentPrivateNativeActor = Readonly<{ protocolId: string; actorId: string; lifecycleOperationId: string; token: string;
  /** Frozen launch capability; native input alone does not imply a frontend control channel. */
  frontendControl?: true;
  /** Frozen ability to reconcile this original native initialization without replaying input. */
  initializationControl?: true;
  /** Original Provider invocation, distinct from Runtime's bootstrap plan. No bootstrap JSON decoding. */
  launch: { command: string; args: string[] } }>

/**
 * 一个权限选项的四种答复方向。元组是 SSOT，{@link AgentMuxPermissionOption} 的 `kind` 从它派生，
 * 存储层的运行期白名单复用它（见 agent-session-store 的 permission 分支）——与 {@link RISK_TIERS}
 * 同一套做法，理由也同一个：手抄一份数组只强制 ⊆（列出的每个串都是成员），对 ⊇ 完全失明。往这个
 * 联合加一个方向而忘了往那份手抄里加，会让**每一条带新方向的合法磁盘记录**被
 * `INVALID_AGENT_SESSION_STORE` 拒掉——fail-closed 的数据丢失，且没有任何编译错，而"加成员"正是
 * 常见方向。从元组派生之后，加成员这件事在两侧同时生效，无处可漂。
 */
export const PERMISSION_OPTION_KINDS = [
  'allow-once', 'allow-always', 'reject-once', 'reject-always'
] as const
export type PermissionOptionKind = (typeof PERMISSION_OPTION_KINDS)[number]

/**
 * 磁盘上读到的这个值是不是一个合法的答复方向。做成收窄谓词而不是让调用方 `includes` 完再 `as` 一次：
 * 那个 cast 是同一件事的第二个声明点，校验用的清单和断言成的类型会各自漂移（存储层此前正是
 * 「裸数组 + cast」两处并存）。
 */
export function isPermissionOptionKind(value: unknown): value is PermissionOptionKind {
  return PERMISSION_OPTION_KINDS.includes(value as PermissionOptionKind)
}

export type AgentMuxPermissionOption = {
  id: string
  label: string
  kind: PermissionOptionKind
  /** DESCRIBE-half only: prose the renderer draws beneath the label. The keystroke that answers this
   * option never rides here — it stays core-side on the Provider's declaration. */
  description?: string
  /** Risk state a renderer surfaces as a restrained dot; not decoration, not a stroke. */
  tier?: RiskTier
}

/**
 * DESCRIBE half of a Provider's live posture control — pure serializable data the composer draws with no
 * provider knowledge. A `mode` is one posture the Provider can be SET to in-band; the keystroke that sets
 * it never rides here (it stays core-side on the declaration, see agent-interaction.ts). `tier` marks a
 * mode a renderer surfaces as a restrained risk dot; not decoration, not a stroke.
 */
export type AgentPostureMode = {
  id: string
  label: string
  description?: string
  tier?: RiskTier
}

/**
 * The composer-facing posture control, or absent. Present only for a Provider whose live posture is
 * ADDRESSABLE: two or more modes, each SET by a distinct in-band keystroke (a slash command, not a launch
 * flag). A Provider that has only a blind cycle it cannot read declares nothing, so the composer draws no
 * control — absence hides it rather than offering a switch that cannot honor a specific target mode.
 */
export type AgentPostureControl = {
  id: string
  label: string
  modes: AgentPostureMode[]
}

/** Receipt for the original synchronous Hook callback; never a byte ACK or Native adoption. */
export type AgentMuxHookPermissionResponse = {
  value: Extract<AgentMuxInteractionResponse, { kind: 'permission' }>
  operationId: string
  responseDigest: string
  delivery: 'saved' | 'unknown' | 'connection-written'
}

export type AgentMuxPermissionRequest = {
  kind: 'permission'
  id: string
  agentSessionId: string
  /** Actual Provider-native invocation identity; absent when the Hook does not report it. */
  nativeToolCallId?: string
  /** Original callback identity. Its persisted presence is not current dispatch authority. */
  permissionHook?: {
    receiptId: string
    nativeSessionId?: string
    nativeTurnId?: string
    closed?: 'abstained' | 'decision-returned'
    /** Exact original Provider turn end, not adoption of our Hook decision. */
    nativeTurnEnded?: { recordId: string; observedAt: number }
    response?: AgentMuxHookPermissionResponse
  }
  responseUnavailableReason?: string
  title: string
  options: AgentMuxPermissionOption[]
  toolName?: string
  toolInput?: string
  evidence: AgentMuxEvidence
}

export type AgentMuxPermissionDecision =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' }

export type AgentMuxQuestionOption = {
  id: string
  label: string
  description?: string
}

export type AgentMuxQuestion = {
  id: string
  prompt: string
  title?: string
  options: AgentMuxQuestionOption[]
}

export type AgentMuxQuestionRequest = {
  kind: 'question'
  id: string
  agentSessionId: string
  /** Provider-native identity of this question tool invocation, when actually reported. */
  nativeToolCallId?: string
  questions: AgentMuxQuestion[]
  /** The question is observed, but this Provider cannot plan a typed response to its shape. */
  responseUnavailableReason?: string
  evidence: AgentMuxEvidence
}

export type AgentMuxInteractionRequest = AgentMuxPermissionRequest | AgentMuxQuestionRequest

export type AgentMuxQuestionAnswer = {
  questionId: string
  optionId: string
}

export type AgentMuxInteractionResponse =
  | {
      kind: 'permission'
      requestId: string
      decision: AgentMuxPermissionDecision
    }
  | {
      kind: 'question'
      requestId: string
      outcome: 'answered'
      answers: AgentMuxQuestionAnswer[]
    }
  | {
      kind: 'question'
      requestId: string
      outcome: 'cancelled'
    }

/** Caller-owned identity and the exact typed request shown when the intent was composed. */
export type AgentMuxInteractionOperationIntent = {
  externalAction?: import('./external-author.js').AgentExternalInteractionAuthor
  operationId: string
  expectedRequest: AgentMuxInteractionRequest
}

/** Original semantic response facts; transport acceptance never claims Native adoption. */
export type AgentMuxInteractionOperationReceipt = AgentMuxInteractionOperationIntent & {
  agentSessionId: string
  run: AgentMuxRunRef
  nativeHandle?: AgentNativeSessionHandle
  response: AgentMuxInteractionResponse
  delivery: 'saved' | 'unknown' | 'bytes-accepted' | 'hook-written' | 'acp-acknowledged'
  inputByteRange?: { startByte: number; endByte: number }
  nativeAdoption: 'unknown'
  nativeCompleted?: AgentMuxEvidence
}

export type AgentMuxInteractionInputPlan = {
  data: string
}

/** The bytes that SET one posture mode, resolved core-side from the picked mode's declared keystroke.
 * Same shape as an interaction plan — both are keystrokes written over the PTY-input transport — but kept
 * a distinct type so the posture seam reads on its own. Never crosses IPC as bytes: the renderer sends a
 * mode id, Core resolves this. */
export type AgentPostureInputPlan = {
  data: string
}

export type AgentMuxInteractionResponseState = {
  /** Semantic response retained so a recoverable ctxmux Input can be replayed after a crash. */
  value: AgentMuxInteractionResponse
  responseDigest: string
  operationId: string
  inputByteRange: {
    startByte: number
    endByte: number
  }
  acknowledged: boolean
}

export type AgentMuxPendingInteraction = {
  request: AgentMuxInteractionRequest
  response?: AgentMuxInteractionResponseState
  /** Other observed native requests do not prove that this current request ended. */
  additionalRequests?: AgentMuxInteractionRequest[]
  /** Exact Provider completion observed while a typed receipt is still outstanding; not its ACK. */
  nativeCompleted?: AgentMuxEvidence
  /** Native bytes do not identify an answer. Keep the old typed response unavailable until re-observed. */
  nativeInput?: {
    operationId: string
    delivery: 'unknown' | 'accepted'
    observedAt: number
  }
}

export type AgentMuxAcpEvent =
  | {
      type: 'status'
      state: AgentSemanticState
      detail?: string
    }
  | {
      type: 'activity'
      operation: 'append'
      activityId: string
      kind: AgentTimelineItemKind
      status: AgentTimelineItemStatus
      title: string
      content?: string
      toolName?: string
      toolInput?: string
    }
  | {
      type: 'activity'
      operation: 'update'
      activityId: string
      status?: AgentTimelineItemStatus
      title?: string
      content?: string
      toolName?: string
      toolInput?: string
    }
  | {
      type: 'native-session'
      sessionId: string
    }
  | {
      type: 'permission'
      requestId: string
      title: string
      options: AgentMuxPermissionOption[]
      toolName?: string
      toolInput?: string
    }

/** The exact observation operation that produced a projection; never new Input intent. */
export type AgentMuxObservationOrigin =
  | { kind: 'attachment-refresh'; operationId: string; run: AgentMuxRunRef }
  /** The observer's exact connection boundary, not a Run lifecycle or business receipt. */
  | { kind: 'runtime-connection'; boundary: 'core-ctxmux' | 'consumer-core' }

export type AgentMuxClientEvent = (
  /** Original journal change; live=false is initial/recovered catch-up, never a fresh user alert. */
  | { type: 'agent-message-changed'; messageId: string; sequence: number; messageSequence: number; live: boolean;
      recordKind: 'message' | 'delivery' | 'delivery-issue' | 'dispatch-open' | 'dispatch-event' | 'a2a-notification' | 'a2a-notification-result';
      senderSessionId: string; recipientSessionId: string }
  /** Derived journal observation for human reading; never Input or Agent consumption authority. */
  | { type: 'agent-message-observation'; state: 'available' | 'unavailable'; code?: string; message?: string }
  | {
      /** Durable communication changed. Consumers re-read the exact source; this is no Task verdict. */
      type: 'dispatch-changed'
      sourceMessageId: string
      ownerAgentSessionId: string
      workerAgentSessionId: string
      threadId: string
      event?: import('./agent-handoff.js').DispatchEvent
      evidence: AgentMuxEvidence
    }
  | { type: 'agent-input'; receipt: import('./agent-input-wait.js').AgentInputSubmissionReceipt }
  /** Invalidates an original mailbox read; it never creates a client-owned queued input. */
  | { type: 'agent-input-recorded'; agentSessionId: string }
  | (import('./control-endpoint-state.js').AgentMuxControlEndpointState & {
      type: 'control-endpoint-state'
      evidence: AgentMuxEvidence
    })
  | ({
      /** This consumer's exact Run observation; never a child lifecycle or endpoint verdict. */
      type: 'attachment-state'
      agentSessionId?: string
      run: AgentMuxRunRef
      /** Last confirmed output cursor. Recovery never retries Input or a Prompt. */
      afterByte: number
      evidence: AgentMuxEvidence
    } & ({ state: 'unavailable'; diagnostic: { code: string; message: string } } |
      { state: 'restored'; diagnostic?: never }))
  | {
      type: 'run-service'
      agentSessionId?: string
      run: AgentMuxRunRef
      nativeService: AgentMuxNativeService
      evidence: AgentMuxEvidence
    }
  | ({
      /** Fresh authoritative representation, ordered before subsequent live events on this Run. */
      type: 'terminal-snapshot'
      agentSessionId?: string
      /** Original output already published before this snapshot; replay before it is projection only. */
      afterByte: number
    } & AgentMuxRunAttachment)
  | {
      /** Ordered with terminal-output on the Run attachment; never a resize request. */
      type: 'terminal-resized'
      agentSessionId?: string
      run: AgentMuxRunRef
      cols: number
      rows: number
      throughByte: number
      resizeRevision: number
    }
  | {
      type: 'terminal-output'
      agentSessionId?: string
      run: AgentMuxRunRef
      /** Original bytes for ordered terminal parsing; length matches evidence.outputByteRange. */
      dataBytes: Uint8Array
      /** Streaming semantic text observation; never re-encode this to reconstruct Run bytes. */
      data: string
      evidence: AgentMuxEvidence & { outputByteRange: { startByte: number; endByte: number } }
    }
  | {
      type: 'process-state'
      agentSessionId?: string
      run: AgentMuxRunRef
      state: AgentMuxRunState
      pid: number | null
      exitCode?: number
      exitSignal?: string
      interruptionReason?: string
      /**
       * 一次 `exited` 退出「为什么会这样」的诚实分类，由停止意图（我们记的）与退出结果（内核报的）合成。
       * 只在 `state: 'exited'` 时在场：`user-stopped` 是我们关的，`crashed` 是带故障信号/非零码地自己死的，
       * `unknown` 是裸 0 又无停止意图——读不出结论就如实说未知，绝不冒充「干净完成」。
       */
      exitReason?: AgentMuxRunExitReason
      evidence: AgentMuxEvidence
    }
  | {
      type: 'agent-status'
      agentSessionId: string
      state: AgentSemanticState
      detail?: string
      failure?: AgentFailure
      evidence: AgentMuxEvidence
    }
  | {
      type: 'agent-timeline'
      agentSessionId: string
      revision: number
      mutation: AgentTimelineMutation
      sourceHostId: string
      stream: AgentCapturedTimelineStream
      position: AgentTimelineCommit['position']
      evidence: AgentMuxEvidence
    }
  | {
      type: 'interaction'
      request: AgentMuxInteractionRequest
    }
  | {
      type: 'agent-session'
      session: AgentMuxAgentSession
    }
  | {
      type: 'run-removed'
      agentSessionId?: string
      run: AgentMuxRunRef
      evidence: AgentMuxEvidence
    }
  | {
      type: 'agent-error'
      agentSessionId?: string
      code: string
      message: string
      evidence: AgentMuxEvidence
      failure?: import('./delivery-attempt.js').DeliveryFailure
    }
  | {
      /**
       * 原 observationOrigin 指名 Core↔ctxmux 或 consumer↔semantic Core 的连接观察。
       * 不针对某个 Run，也不确认进程终局。两个边界独立恢复；`restored` 只说明这个边界
       * 可用，Session 状态仍由准确 Run 的权威事实恢复。
       *
       * - `lost`：实时通道断了（socket 错误，或 daemon 关流却没交代 run 下场）。开始有界重连。
       * - `restored`：实时连接已重新订阅。携带 diagnostic 时恢复观察尚未确认或失败，保留原能力及服务窗；不携带 diagnostic 时本轮观察已完成。
       * - `retrying`：高频重试已停止；每 30 秒可取消地重试一次，显式 connect 可立即重试。
       * - `unrecoverable`：权限或目标等明确错误需要用户处理；不用于重试次数耗尽。
       */
      type: 'connection-state'
      state: 'lost' | 'restored' | 'retrying' | 'unrecoverable'
      observationOrigin: Extract<AgentMuxObservationOrigin, { kind: 'runtime-connection' }>
      /** Endpoint observation failure, not an Agent/Run error. Settles with this connection. */
      diagnostic?: { code: string; message: string }
      evidence: AgentMuxEvidence
    }

) & { observationOrigin?: AgentMuxObservationOrigin }

export type AgentFailure = {
  code: string
  message: string
  nativeCode?: string
  httpStatusCode?: number
  recovery: string
  nativeTurnId: string
}

export type AgentStatus = {
  /** Core-owned order of current activity changes within this Run, not a native activity clock. */
  currentActivityRevision?: number
  /** Current idle evidence was consumed; the historical completion remains intact. */
  idleEvidenceConsumed?: true
  /** Proven child activity clock, independent of the main turn/completion clock. */
  aggregateActivityAt?: number
  state: AgentDisplayState
  source: AgentMuxEvidenceSource
  observedAt: number
  /** Proven entry time for this semantic state; absence is unknown, never inferred from observations. */
  stateEnteredAt?: number
  detail?: string
  nativeTurnId?: string
  failure?: AgentFailure
  exitCode?: number
}

export type AgentTimelineItemKind =
  | 'system_message'
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'permission'
  | 'lifecycle'

export type AgentTimelineItemStatus = 'streaming' | 'complete' | 'failed' | 'recorded'

/** Accepted semantic observations and actual Run/connection boundaries, never inferred from text. */
export type AgentActivityState = {
  run: AgentMuxRunRef
  previousObservationId?: string
} & (
  | { state: AgentDisplayState; stateEnteredAt?: number }
  | { boundary: 'exited' | 'interrupted' | 'lost' | 'restored' | 'history-gap' }
)

/** Private, constant-size metadata retained by the existing Session owner for failed history I/O. */
export type AgentActivityObservation = {
  id: string
  source: AgentMuxEvidenceSource
  createdAt: number
  activityState: AgentActivityState
}
export type AgentActivityCommit = {
  latest: AgentActivityObservation
  latestCommitted: boolean
  pending?: AgentActivityObservation
}

export type AgentActivityHistoryProjection = {
  segments: Array<AgentWorkHistoryProjection['segments'][number] & {
    state: 'working' | 'idle' | 'awaiting-input' | 'unknown'
    observationId: string
    detail?: string
  }>
  coverage: AgentWorkHistoryProjection['coverage']
}

export type AgentWorkHistoryProjection = {
  segments: Array<{
    run: AgentMuxRunRef
    startAt: number
    endAt: number | null
    end: 'state-change' | 'run-ended' | 'observation-gap' | 'unknown' | 'current'
    startKnown: boolean
  }>
  coverage: { recorded: boolean; truncated: boolean; gaps: boolean }
}

export type AgentTimelineItem = {
  inputContext?: import('./browser-input-context.js').BrowserInputContext
  inputContextSource?: import('./browser-input-context.js').BrowserInputContextSource
  inputContextCaptureProof?: import('./agent-input-context-capture.js').AgentInputContextCaptureProof
  id: string
  /** Original Core notification identity, distinct from the referenced A2A messages. */
  a2aNotificationId?: string
  /** Original typed provenance, never reconstructed from display text or opaque item IDs. */
  conversation?: import('./conversation-stream.js').ConversationRecordProvenance
  conversationDiagnostic?: { code: string; message: string; original?: unknown }
  agentSessionId: string
  kind: AgentTimelineItemKind
  status: AgentTimelineItemStatus
  source: AgentMuxEvidenceSource
  createdAt: number
  updatedAt: number
  title: string
  /** Input supplied by another Agent, attributed by the trusted host (not a credential). */
  authorAgentSessionId?: string
  /** Explicit manual origin attributed by trusted host. */
  authorHuman?: boolean
  authorExternal?: import('./external-author.js').AgentExternalMessageAuthor | import('./external-conversation.js').AgentExternalConversationAuthor
  sourceDevice?: AgentOperationDevice
  sourceChannel?: AgentMessageChannel
  content?: string
  /** Original purpose of content only; never author identity or sharing authority. */
  contentEligibility?: AgentSessionHistoryContentEligibility
  /** Set by the original userContent writer, never inferred from legacy content or author. Not sharing authority. */
  publicContent?: 'confirmed'
  /** Original saved or submitted Input identity; attribution or opaque IDs never reconstruct it. */
  inputRef?: import('./agent-prompt-condition.js').AgentPromptInputKey
  /** Immutable membership in the original saved-input journal. */
  inputOrigin?: import('./agent-input-conversation.js').AgentInputJournalCut
  /** Read-only original ingress observation; never input authority or an Agent receipt. */
  externalInput?: import('./external-conversation.js').AgentExternalConversationInputObservation
  /** Safe projection of the original Input receipt, not Agent completion. */
  inputSubmission?: import('./agent-input-conversation.js').AgentInputSubmissionObservation
  toolName?: string
  toolInput?: string
  /**
   * 这一步跑出来的东西。缺席就是缺席——没观察到结果时不写空串，那会把「还没结果」伪装成
   * 「结果是空的」。体量由采集侧封顶并在文本里明说截断，时间轴不吞整份 stdout。
   */
  toolOutput?: string
  eventName?: string
  activityState?: AgentActivityState
}

export type AgentTimelineMutation =
  | {
      type: 'append'
      agentSessionId: string
      item: AgentTimelineItem
    }
  | {
      // create-or-replace：携带**完整 item**。目标已存在则合并（保留原 createdAt），不存在则追加。
      // 用于「一次调用两端投递、但事前那条可能压根没落库」的场景：hook 的 PostToolUse 命中同一
      // 已核主体下同一次调用的关联 item，正常情况更新在途的 Pre 行；可 Pre 的两次 fetch 都失败、或被 200 上限逐出
      // 时那条从未存在——`update` 会抛 UNKNOWN_AGENT_TIMELINE_ITEM 把整条 hook 事件打成 503、跳过
      // publish、结果与完成态永久丢失。upsert 目标缺失就补落一条自洽的终态行，绝不因丢了 Pre 而把
      // 整个事件打死。与 `append` 的区别是它不因 id 撞车报 ID_CONFLICT，而是就地替换。
      type: 'upsert'
      agentSessionId: string
      item: AgentTimelineItem
    }
  | {
      type: 'update'
      agentSessionId: string
      itemId: string
      updatedAt: number
      status?: AgentTimelineItemStatus
      title?: string
      content?: string
      toolName?: string
      toolInput?: string
      toolOutput?: string
      eventName?: string
    }

/** Original captured stream position; neither a message count nor a delivery receipt. */
export type AgentCapturedTimelineStream = {
  /** Accepted original Input journal frontier, distinct from captured sequence. */
  inputJournal?: import('./agent-input-conversation.js').AgentInputJournalCut
  epoch: string
  sequence: number
  revision: number
  origin: 'beginning' | 'retained-prefix' | 'unknown'
  gaps: Array<{ code: string; message: string }>
}
export type AgentCapturedTimelineRecord = {
  item: AgentTimelineItem
  firstSequence: number
  sequence: number
  revision: string
}
export type AgentCapturedTimelineRead = {
  epoch?: string
  throughSequence?: number
  beforeFirstSequence?: number
  afterSequence?: number
  recordId?: string
  recordRevision?: string
  limit?: number
}
export type AgentCapturedTimelinePage = {
  agentSessionId: string
  stream: AgentCapturedTimelineStream
  records: AgentCapturedTimelineRecord[]
  nextBeforeFirstSequence: number | null
  more: boolean
}

export type AgentTimelineSnapshot = {
  agentSessionId: string
  /** Original Core namespace; a Store-only snapshot may not establish it. */
  sourceHostId?: string
  revision: number
  items: AgentTimelineItem[]
  stream?: AgentCapturedTimelineStream & { positions: Array<{ id: string; firstSequence: number; sequence: number; revision: string }> }
}

export type AgentTimelineCommit = {
  agentSessionId: string
  revision: number
  changed: boolean
  mutation: AgentTimelineMutation
  stream: AgentCapturedTimelineStream
  position: NonNullable<AgentTimelineSnapshot['stream']>['positions'][number]
}

export type AgentLaunchPlan = {
  command: string
  args: string[]
  env: Record<string, string>
}

export type AgentProviderLaunchContext = {
  workspacePath: string
  prompt: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  commandOverride?: string
}

export type AgentProviderResumeContext = {
  workspacePath: string
  nativeHandle: AgentNativeSessionHandle
  /** Omitted for continuity recovery that must not invent a user message. */
  prompt?: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  commandOverride?: string
}

/** Current-conversation native fork uses the same launch inputs as resume, with a new identity. */
export type AgentProviderForkContext = AgentProviderResumeContext

export type NativeHookEnvelope = {
  /** Set by authenticated ingress only for the original synchronous HTTP callback. */
  permissionCallback?: true
  receiptId: string
  agentSessionId: string
  runId: string
  providerId: AgentProviderId
  /**
   * 投递方明说的事件名（来自 hook 命令的 `--event` 旗标或环境变量）。缺席时 Core 从 `payload` 里按
   * `HOOK_EVENT_NAME_PAYLOAD_KEYS`（`hook_event_name` / `hookEventName` / `eventName`）依次读取。
   */
  eventName?: string
  /**
   * Provider 的原始 hook 负载，**逐字保留、不由 Core 改写**。
   *
   * 这是 Provider 与 Core 的分工线：Core 归一化的是**事件名**（它需要据以分支），而负载里的 handle
   * ——`session_id`/`sessionId`、`transcript_path`/`transcriptPath`、Antigravity 的 `conversationId`
   * ——一律留在这里由**声明它们的 Provider 自己解释**（见 `AgentNativeHookSpecification.nativeHandle`
   * 的 `sessionIdKeys`/`transcriptPathKeys`）。Core 不认识、也不该认识「哪个键装着会话 id」：那是
   * Provider 的私有知识，一个新 Provider 声明自己的键名即可接入，不必修改 Core。Core 只对读出来的值
   * 做与 Provider 无关的**安全归一化**（控制字符、长度、前导 `-`、相对路径——见 agent-native-locator.ts），
   * 因为那些约束来自「这个值会成为 argv token 或文件路径」，而不是来自某个 Provider。
   */
  payload?: Record<string, unknown>
}

/** Provider-owned ordered activity facts; an observation gap never ends a task. */
export type AgentNativeActivityEvent = {
  state: 'active' | 'idle' | 'unknown'
  /** Exact native turn outcome only; an idle turn does not by itself prove interruption or task completion. */
  interruption?: 'interrupted' | 'not-interrupted'
  nativeSessionId: string
  nativeTurnId?: string
  sourceId: string
  sequence: number
}

/** Persisted native activity for recovery of this exact Run, independent of live observer availability. */
export type AgentRecoveryActivity = AgentNativeActivityEvent & {
  run: AgentMuxRunRef
  hookReceiptId: string
  observedAt: number
  /** Original typed-prompt admission observed with this fact; a later claim cannot inherit its old end. */
  promptSubmissionId?: string
}

export type AgentCurrentActivity = AgentNativeActivityEvent & {
  source: 'native-hook'
  run: AgentMuxRunRef
  hookReceiptId: string
  observedAt: number
} & ({ state: 'active' | 'idle'; nativeTurnId: string } | { state: 'unknown'; nativeTurnId?: string })

/** A Provider observation failure is diagnostic only; it does not alter Agent authority. */
export type AgentHookObservationFailure = {
  code: string
  message: string
  /** Original ordered observer identity, when the Provider can still report it. */
  source?: Pick<AgentNativeActivityEvent, 'sourceId' | 'sequence'>
}

/** Optional Provider protocol evidence; neither form grants input or task-completion authority. */
export type AgentHookContinuityObservation =
  | { kind: 'context-restored'; nativeSessionId: string }
  | { kind: 'explicit-user-cancelled'; scope: 'recovery-intent'; nativeSessionId: string; nativeOperationId: string }

export type NormalizedHookEvent = {
  agentSessionId: string
  run: AgentMuxRunRef
  providerId: AgentProviderId
  /**
   * Provider 报出的**原始**事件名，逐字保留。
   *
   * 刻意不换成 canonical 值：诊断一条「Core 没认出来的事件」时，唯一有用的就是 Provider 到底叫它
   * 什么。归一化的结果放在 `lifecycleEvent`，两者并存——原始名负责可诊断，canonical 值负责可判断。
   */
  eventName: string
  /** Direct main-subject contribution; false still permits proven roster-derived parent end. */
  mainSubject: boolean
  currentActivity?: AgentNativeActivityEvent
  observationFailure?: AgentHookObservationFailure
  continuity?: AgentHookContinuityObservation
  continuityObservationFailure?: AgentHookObservationFailure
  nativeTurnId?: string
  toolInvocation?: AgentHookToolInvocation
  subject?: AgentHookSubject
  childActivity?: boolean
  /**
   * 这条事件归一化后的 Core canonical 生命周期事件，**认不出时缺席**。
   *
   * 缺席是一等公民的事实，读作「Core 对这条事件没有 canonical 语义」：此时 `semanticState` 仍由
   * Provider 自己的 `rules` 给出（多半是 `unknown`），绝不因为归一化失败就伪造 `working`/`done`。
   * 缺席时 `eventName` 里的原始名就是诊断线索。
   * null 明确不声明生命周期，持久化后也不从原始名字补回。
   */
  lifecycleEvent?: AgentHookLifecycleEvent | null
  semanticState: AgentSemanticState
  status: AgentStatus
  timeline: AgentTimelineMutation[]
  interaction?: AgentMuxInteractionRequest
  interactionCompletion?: {
    kind: 'question' | 'permission'
    agentSessionId: string
    nativeToolCallId: string
    evidence: AgentMuxEvidence
  }
  nativeHandle?: AgentNativeSessionHandle
  /**
   * 从收尾事件 payload 里抽出的本 turn 真实 token 用量，仅当 Provider 声明了 usage 能力、hook 命令
   * 进程读到 transcript 尾部时存在。normalizer 只做投影，不读文件——读文件是 hook 进程的事。
   */
  turnUsage?: AgentTurnUsage
}

/** Immutable public facts required by the existing Local Runtime compatibility predicate. */
export type AgentMuxRuntimeCompatibilityInput = {
  protocolGeneration: number
  runtimeIdPersistence: string
  buildId: string
  platform: string
  arch: string
  capabilities: Readonly<Record<string, number>>
}
