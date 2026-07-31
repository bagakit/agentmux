import type { LaunchOption, LaunchOptionSelection } from './agent-launch-option.js'

export type BuiltInAgentProviderId =
  | 'codex'
  | 'claude'
  | 'traex'
  | 'hermes'
  | 'pi'
  | 'grok'
  | 'gemini'
  | 'antigravity'
  | 'cursor'
export type AgentProviderId = BuiltInAgentProviderId | (string & {})

/**
 * The single risk vocabulary the three sealed control surfaces share — launch options, live permission
 * options, and posture modes all rank one choice's danger with these exact three values, and every
 * renderer surfaces them the same way: a restrained dot, never a stroke or fill. One identity in one
 * place — a launch choice, a permission row, and a posture mode that read as equally dangerous carry the
 * same token, so the ranking cannot drift between the three. The tuple is the SSOT: {@link RiskTier}
 * derives from it and a runtime validator (agent-session-store) reuses it to fail-close on foreign data,
 * so the type and the on-disk whitelist cannot fall out of step.
 */
export const RISK_TIERS = ['safe', 'caution', 'danger'] as const
export type RiskTier = (typeof RISK_TIERS)[number]

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
    version: string
    protocolVersion: number
    sourceCommit: string
    artifactPlatform: string
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
  | 'acp'
  | 'user'

export type AgentMuxRunState = 'running' | 'exited' | 'interrupted'

export type AgentMuxRunRef = {
  runId: string
}

export type AgentMuxRun = AgentMuxRunRef & {
  kind: 'terminal' | 'agent'
  providerId: AgentProviderId | null
  executorId: AgentExecutorId | null
  agentSessionId: string | null
  workspacePath: string
  pid: number | null
  state: AgentMuxRunState
  cols: number
  rows: number
  observedAt: number
  latestOutputBytes: number
  acceptedInputBytes: number
  exitCode?: number
  exitSignal?: string
  interruptionReason?: string
}

export type AgentMuxRunDataEvent = AgentMuxRunRef & {
  type: 'data'
  startByte: number
  endByte: number
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

export type AgentMuxRunAttachment = {
  run: AgentMuxRun
  replay: AgentMuxRunDataEvent[]
  gap: AgentMuxRunReplayGap | null
}

export type AgentMuxRunInputOperation = {
  ownerInstanceId: string
  operationId: string
  expectedByte: number
  data: string
}

export type AgentMuxRunInputAck = AgentMuxRunRef & {
  appliedByteRange: {
    startByte: number
    endByte: number
  }
  acceptedThroughByte: number
}

export type AgentMuxRunOutputAck = AgentMuxRunRef & {
  acknowledgedThroughByte: number
}

export type AgentMuxRunAppliedSize = AgentMuxRunRef & {
  cols: number
  rows: number
}

export type AgentMuxEvidence = {
  source: AgentMuxEvidenceSource
  observedAt: number
  run?: AgentMuxRunRef
  outputByteRange?: {
    startByte: number
    endByte: number
  }
  hookReceiptId?: string
  acpAdapterId?: string
  acpSessionId?: string
}

export type AgentPromptDelivery = 'positional-argv' | 'hermes-query' | 'flag-prompt-interactive'

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

export type AgentPromptInputPlan =
  | { kind: 'single-phase'; data: string }
  | {
      kind: 'render-then-submit'
      /** Exact transport bytes written before submit. */
      payload: string
      /** Logical text the Provider TUI renders after consuming transport control bytes. */
      renderedText: string
      submit: string
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
  hookEvents: boolean
  timeline: 'unavailable' | 'complete-events' | 'streaming'
  permission: 'none' | 'observe' | 'respond'
  providerResume: boolean
  acp: boolean
  replyCorrelation: 'none' | 'native-turn-id' | 'acp-turn-id'
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

/**
 * 一个 turn 的**真实**原生 token 用量。分子（token 数）全部由 Provider 报出、可验证；这里刻意
 * **不含任何速率**——`tokens/s` 的分母（turn 墙钟时长）含用户思考、审批等待、工具执行、网络往返，
 * 是我们自己拼的、不可验证的数，真实分子除以编出来的分母仍是编出来的数（设计 SSOT《状态栏》节）。
 * 所以只上报累计量，UI 明说这是「最近一个 turn」的用量。
 */
export type AgentTurnUsage = {
  /** 本 turn 生成的 output token 数——状态栏首要显示的量，它最接近"这一步产出了多少"。 */
  outputTokens: number
  /** 本 turn 的 input token 数（含被 Provider 计入的上下文）。 */
  inputTokens: number
  /** 本 turn 的合计 token（Provider 报的口径，可能与 in+out 不等，比如含 reasoning/cache）。 */
  totalTokens: number
  /** 采到这条用量的收尾事件观测时刻（epoch ms）——UI 用它说明"哪一段时间"的用量。 */
  observedAt: number
}

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
}

export type AgentCapabilitySnapshot = {
  providerId: AgentProviderId
  executable: string
  installed: boolean
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

export type AgentHookReceipt = {
  id: string
  providerId: AgentProviderId
  agentSessionId: string
  run: AgentMuxRunRef
  eventName: string
  observedAt: number
  outputCursorBytes?: number
}

export type AgentTerminalPromptReadinessState = {
  source: 'initial-composer' | 'native-stop'
  id: string
  run: AgentMuxRunRef
  outputCursorBytes: number
  readyThroughByte?: number
  consumedBySubmissionId?: string
}

export type AgentMuxAgentSession = {
  kind: 'agent'
  agentSessionId: string
  providerId: AgentProviderId
  executorId: AgentExecutorId
  hostId: string
  workspacePath: string
  run: AgentMuxRunRef
  retiredRuns: AgentMuxRunRef[]
  outputCursorBytes: number
  createdAt: number
  updatedAt: number
  /**
   * The chosen launch-option ids that fixed this Agent's security posture at spawn (sandbox, approval,
   * permission-mode — see agent-launch-option.ts). Persisted so a stop/resume re-resolves the SAME argv
   * the create used: the posture is fail-closed, so it must survive the Run boundary rather than silently
   * reverting to the Provider's more permissive default. Absent when the create narrowed nothing.
   */
  launchOptions?: LaunchOptionSelection
  terminalHandshake?: AgentTerminalHandshakeState
  terminalCapability?: AgentTerminalCapabilityState
  terminalPromptReadiness?: AgentTerminalPromptReadinessState
  terminalPromptSubmission?: AgentTerminalPromptSubmissionState
  terminalPromptDelivery?: AgentTerminalPromptDeliveryState
  semanticStatus?: AgentStatus
  pendingInteraction?: AgentMuxPendingInteraction
  nativeHandle?: AgentNativeSessionHandle
  hookReceipt?: AgentHookReceipt
  /**
   * 最近一个 turn 的真实原生 token 用量，随收尾事件的 hook 回执到达并被覆盖式更新（只保留最新一
   * turn，不累加历史——状态栏回答的是"刚跑完这一 turn 花了多少"）。仅 usage 能力声明为
   * `native-transcript` 的 Provider 会写入；缺席读作"还没有一 turn 的用量"或"此 Provider 不报用量"，
   * 两者在 UI 上都不显示 0。
   */
  turnUsage?: AgentTurnUsage
}

export type AgentTerminalHandshakeState = {
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
 * authoritative cursor, while the optional handshake receipt remains absent. The record is cleared
 * when a later handshake is acknowledged or when the Run is replaced.
 */
export type AgentTerminalCapabilityState = {
  state: 'unknown'
  mode: 'degraded'
  reason: 'handshake-timeout'
  run: AgentMuxRunRef
  observedAt: number
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
  reason: 'screen-evidence-gap' | 'prompt-render-timeout'
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
}

export type AgentTerminalPromptSubmissionState = {
  run: AgentMuxRunRef
  submissionId: string
  promptDigest: string
  readinessSource: AgentTerminalPromptReadinessState['source']
  readinessId: string
  readinessOutputCursorBytes: number
  readyThroughByte: number
  outputCursorBytes: number
  payload: AgentTerminalInputPhaseState
  submit: AgentTerminalInputPhaseState
}

/** This is the complete persistent semantic/control record. It deliberately has no
 * PTY, process, replay, terminal snapshot, or terminal output bytes. */
export type AgentMuxStoredAgentSession = AgentMuxAgentSession & {
  hookBindingId: string
  hookToken: string
  /** Agent 说话凭证的 sha256。raw 只在受管进程的 env 里，Core 侧只留 hash。 */
  capabilityHash?: string
}

export type AgentMuxPermissionOption = {
  id: string
  label: string
  kind: 'allow-once' | 'allow-always' | 'reject-once' | 'reject-always'
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

export type AgentMuxPermissionRequest = {
  kind: 'permission'
  id: string
  agentSessionId: string
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
  questions: AgentMuxQuestion[]
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

export type AgentMuxClientEvent =
  | {
      type: 'terminal-output'
      agentSessionId?: string
      run: AgentMuxRunRef
      data: string
      evidence: AgentMuxEvidence
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
      evidence: AgentMuxEvidence
    }
  | {
      type: 'agent-status'
      agentSessionId: string
      state: AgentSemanticState
      detail?: string
      evidence: AgentMuxEvidence
    }
  | {
      type: 'agent-timeline'
      agentSessionId: string
      revision: number
      mutation: AgentTimelineMutation
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
    }

export type AgentStatus = {
  state: AgentDisplayState
  source: AgentMuxEvidenceSource
  observedAt: number
  detail?: string
  exitCode?: number
}

export type AgentTimelineItemKind =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'permission'
  | 'lifecycle'

export type AgentTimelineItemStatus = 'streaming' | 'complete' | 'failed'

export type AgentTimelineItem = {
  id: string
  agentSessionId: string
  kind: AgentTimelineItemKind
  status: AgentTimelineItemStatus
  source: AgentMuxEvidenceSource
  createdAt: number
  updatedAt: number
  title: string
  content?: string
  toolName?: string
  toolInput?: string
  /**
   * 这一步跑出来的东西。缺席就是缺席——没观察到结果时不写空串，那会把「还没结果」伪装成
   * 「结果是空的」。体量由采集侧封顶并在文本里明说截断，时间轴不吞整份 stdout。
   */
  toolOutput?: string
  eventName?: string
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
      // `runId:tool:<id>`，正常情况更新在途的 Pre 行；可 Pre 的两次 fetch 都失败、或被 200 上限逐出
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

export type AgentTimelineSnapshot = {
  agentSessionId: string
  revision: number
  items: AgentTimelineItem[]
}

export type AgentTimelineCommit = {
  agentSessionId: string
  revision: number
  changed: boolean
  mutation: AgentTimelineMutation
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

export type NativeHookEnvelope = {
  receiptId: string
  agentSessionId: string
  runId: string
  providerId: AgentProviderId
  eventName?: string
  payload?: Record<string, unknown>
}

export type NormalizedHookEvent = {
  agentSessionId: string
  run: AgentMuxRunRef
  providerId: AgentProviderId
  eventName: string
  semanticState: AgentSemanticState
  status: AgentStatus
  timeline: AgentTimelineMutation[]
  interaction?: AgentMuxInteractionRequest
  nativeHandle?: AgentNativeSessionHandle
  /**
   * 从收尾事件 payload 里抽出的本 turn 真实 token 用量，仅当 Provider 声明了 usage 能力、hook 命令
   * 进程读到 transcript 尾部时存在。normalizer 只做投影，不读文件——读文件是 hook 进程的事。
   */
  turnUsage?: AgentTurnUsage
}
