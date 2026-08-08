import type { LaunchOption, LaunchOptionSelection } from './agent-launch-option.js'
import type { AgentMuxRunExitReason } from './agent-run-exit.js'
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

/**
 * Run 输入的字节载荷。string 由 ctxmux 侧按 **UTF-8** 编码上线；Uint8Array 则原样透传、逐字节
 * 不动。两条终端事件源要的正是这个区别：键盘/SGR 鼠标上报是合法文本走 string；而只开了旧式鼠标
 * 协议（?1000/?1002/?1003 而没开 ?1006）时，坐标字节可能 ≥128、是 latin1 语义，一旦经 UTF-8
 * 编码 0x80 会被拆成 0xC2 0x80、坐标就毁了——这种必须以 Uint8Array 上线。
 */
export type AgentMuxRunInputData = string | Uint8Array

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
 * `composeAgentLaunchPrompt` 的产物——运行时引导默认注入，所以那份文本即使用户一个字都没写也
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
  timeline: 'unavailable' | 'complete-events' | 'streaming'
  permission: 'none' | 'observe' | 'respond'
  providerResume: boolean
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

/**
 * Why an Agent's prompt-readiness was established. `initial-composer` — the boundary the terminal
 * handshake drew when the composer first became writable; `native-stop` — a native Stop event proving
 * the Agent yielded the prompt. This is the SSOT for the vocabulary: {@link AgentTerminalPromptReadinessState.source}
 * uses it, {@link AgentTerminalPromptSubmissionState.readinessSource} derives from that, and the on-disk
 * validator in agent-session-store projects its runtime whitelist off a total `Record<this, true>` table
 * so adding a member here forces the table to gain a key (a compile error) rather than silently
 * fail-closing every legitimate session that carries the new member.
 */
export type AgentTerminalPromptReadinessSource = 'initial-composer' | 'native-stop'

export type AgentTerminalPromptReadinessState = {
  source: AgentTerminalPromptReadinessSource
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
 * 屏幕验证没走通的两种原因。元组是 SSOT，理由同 {@link RISK_TIERS}：存储层要按这份清单校验磁盘
 * 数据，手抄一份只强制 ⊆ 而对 ⊇ 失明，加一个原因却忘了往那份手抄里加，会让带新原因的合法记录被
 * fail-closed 丢掉且无编译错。
 */
export const PROMPT_DELIVERY_DEGRADED_REASONS = [
  'screen-evidence-gap', 'prompt-render-timeout'
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
  | {
      /**
       * 我们与本 Host 的 daemon 之间那条**唯一实时连接**的状态变化。不针对某个 run/session：单 daemon
       * 语义下连接是共享的，断了就是这台 Host 上所有 Agent 一起失联。渲染端据此把该 Host 的每个 Agent
       * Session 置为 `disconnected`（`lost`）、或让它们回到进程真相（`restored`）。
       *
       * - `lost`：实时通道断了（socket 错误，或 daemon 关流却没交代 run 下场）。开始有界重连。
       * - `restored`：重连成功、已重新订阅并补发各 run 的当前状态。
       * - `unrecoverable`：有界重试用尽仍连不上。**响亮的终局**，不是静默——用户需要手动介入。
       */
      type: 'connection-state'
      state: 'lost' | 'restored' | 'unrecoverable'
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
  /**
   * 这条事件归一化后的 Core canonical 生命周期事件，**认不出时缺席**。
   *
   * 缺席是一等公民的事实，读作「Core 对这条事件没有 canonical 语义」：此时 `semanticState` 仍由
   * Provider 自己的 `rules` 给出（多半是 `unknown`），绝不因为归一化失败就伪造 `working`/`done`。
   * 缺席时 `eventName` 里的原始名就是诊断线索。
   */
  lifecycleEvent?: AgentHookLifecycleEvent
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
