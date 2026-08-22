import { AgentMuxError } from './errors.js'
import type { AgentExecutorId, AgentProviderId } from './types.js'
import type { WorkbenchLayoutPreset } from './workbench-layout-preset.js'

export const AGENTMUX_CONTROL_SCHEMA_VERSION = 5 as const

export const AGENTMUX_CONTROL_ERROR_CODES = [
  'INVALID_CONTROL_REQUEST',
  'CONTROL_PROTOCOL_ERROR',
  'CONTROL_TIMEOUT',
  'CONTROL_UNAVAILABLE',
  'CONTROL_OWNER_BUSY',
  'CONTROL_FAILED',
  'CONTROL_CANCELLED',
  'CONTROL_REQUEST_CONFLICT',
  'CONTROL_OWNER_LOST',
  'CALLER_NOT_OPEN',
  'TAB_NOT_OPEN',
  'REGION_NOT_OPEN',
  'AMBIGUOUS_TAB_TARGET',
  'AMBIGUOUS_REGION_TARGET',
  'MESSAGE_TARGET_NOT_UNIQUE',
  'MESSAGE_TARGET_NOT_AGENT',
  'AGENT_EXECUTOR_NOT_CONFIGURED',
  'UNKNOWN_AGENT_SESSION',
  'SESSION_CLOSING',
  'SESSION_NOT_RUNNING',
  'UNKNOWN_WORKSPACE',
  'REGION_WORKSPACE_MISMATCH',
  'REGION_TOPIC_MISMATCH',
  'LAUNCH_RESULT_MISMATCH',
  'LAUNCH_CLEANUP_FAILED',
  'LAYOUT_CAPACITY_EXCEEDED',
  'REGION_ALREADY_SOLE',
  'LAUNCHER_REGION_REQUIRED',
  'AGENT_NOT_FOUND',
  'INVALID_AGENT_PROMPT',
  'AGENT_SESSION_STILL_RUNNING',
  'AGENT_RESUME_UNAVAILABLE',
  'AGENT_RESUME_UNSUPPORTED',
  'STALE_AGENT_SESSION',
  'STALE_AGENT_SESSION_BINDING',
  'CTXMUX_DISCONNECTED',
  'CTXMUX_INPUT_CURSOR_MISSING',
  'SIGNAL_UNSUPPORTED',
  // 用户没打开 Agent 驱动页面的总开关。既有 39 个码没有一个说得出这件事：`CONTROL_UNAVAILABLE` 是
  // "这条路现在走不通"（没人拥有屏幕），会让 Agent 去重试；这里重试一万次也没用，要去改设置。
  // 把"要你去做一个决定"说成"暂时不可用"，就是把一次明确拒绝降级成了一次疑似故障。
  'BROWSER_AUTOMATION_DISABLED',
  // 这个宿主不提供进度订阅（`subscribeBrowserOperation` 没实现）。既有的码没有一个说得对：
  // `CONTROL_UNAVAILABLE` 是"现在走不通、回头再试"，而这件事重试到世界尽头也一样；
  // `INVALID_CONTROL_REQUEST` 更糟——请求完全合法，是这一端没有这个能力。
  // 与 `AGENT_RESUME_UNSUPPORTED` / `SIGNAL_UNSUPPORTED` 同族：能力协商的答案，不是故障。
  'BROWSER_SUBSCRIBE_UNSUPPORTED',
  // 人正在用这一页，Agent 的驱动请求被拒。这条必须与"出故障了"分得开——设计约束原话是
  // 「这条拒绝要带类型化的原因，让协议客户端能把『人在用这一页』与『出故障了』分开，而不是
  // 收到一句散文」。
  //
  // 为什么不复用既有的码：`CONTROL_UNAVAILABLE` 会让 Agent 去重试，而重试正是这条规则要禁的
  // （「Agent 不得靠重试静默夺回页面」）；`BROWSER_AUTOMATION_DISABLED` 说的是用户关了总开关，
  // 去改设置就能解，而这一条只能由人**明确交还控制**才解得开——两件事的恢复动作不一样，
  // 折成一个码就等于告诉调用方去做一件没用的事。
  'BROWSER_HUMAN_CONTROL_ACTIVE'
] as const
export type AgentMuxControlErrorCode = typeof AGENTMUX_CONTROL_ERROR_CODES[number]

export type AgentMuxControlCaller = { agentSessionId: string }
export type AgentMuxRegionBounds = { x: number; y: number; width: number; height: number }

/**
 * 「我右边是什么」的答案。
 *
 * 方向本来只存在于**创建**一侧（`AgentMuxOpenDestination` 的 `split` 带 direction），于是 Agent
 * 造得出一个右边、却问不出自己右边是什么。这里把方向补到**查看**一侧。
 *
 * 答案只会是既有的 Region 地址或 Tab 地址：不新增第四级寻址身份，Agent 拿到之后能直接喂回
 * `inspect.region` / `focus` / `send`。`none` 与报错是两回事——最右一格问 right 是合法问题的
 * 合法答案，不是失败。
 */
export type AgentMuxRegionNeighbor =
  | { kind: 'region'; regionId: string }
  | { kind: 'tab'; tabId: string }
  | { kind: 'none' }
/** 四个方向各自的邻居。up/down 永远不会答成 Tab——Tab 条是一维水平序列。 */
export type AgentMuxRegionNeighbors = Record<'left' | 'right' | 'up' | 'down', AgentMuxRegionNeighbor>
type AgentMuxRegionBase = { tabId: string; regionId: string; workspaceId: string }

export type AgentMuxAgentRegion = AgentMuxRegionBase & {
  kind: 'agent'
  agentSessionId: string
  providerId: AgentProviderId
  executorId: AgentExecutorId
}
export type AgentMuxTerminalRegion = AgentMuxRegionBase & { kind: 'terminal'; runId: string }
export type AgentMuxBrowserRegion = AgentMuxRegionBase & { kind: 'browser'; browserId: string }
export type AgentMuxFileRegion = AgentMuxRegionBase & { kind: 'file'; path: string }
export type AgentMuxLauncherRegion = AgentMuxRegionBase & { kind: 'launcher' }
export type AgentMuxRegion = AgentMuxAgentRegion | AgentMuxTerminalRegion | AgentMuxBrowserRegion | AgentMuxFileRegion | AgentMuxLauncherRegion

export type AgentMuxRegionTarget =
  | { kind: 'region'; regionId: string }
  | { kind: 'agent-session'; agentSessionId: string }

export type AgentMuxInspectedRegion = AgentMuxRegion & { bounds: AgentMuxRegionBounds; neighbors: AgentMuxRegionNeighbors }
export type AgentMuxInspectedTab = { tabId: string; workspaceId: string; regions: AgentMuxInspectedRegion[] }

export type AgentMuxControlExecutor = {
  executorId: AgentExecutorId
  label: string
  providerId: AgentProviderId
  availability: AgentMuxExecutorAvailability
}

/**
 * 发现某个 Executor 在一台目标 Host 上的可用性——**四态，唯一一处拼写。**
 *
 * 这四态是四件不同的事，任何两态折成一态都是缺陷：
 *   - `unknown`：还没查（或正在查）。不是「没有」，只是此刻没有结论。
 *   - `check-failed`：查了但没查成——环境不完整（PATH 被清空而命令是相对名，探测拿不到任何候选路径）。
 *     这正是那次实战误报的形态：环境退化被当成了「没装」。
 *   - `missing`：查成了，确实不在——候选路径都在场，没有一个可执行；或绝对路径指向的文件不存在。
 *   - `available`：查成了，可执行文件在场。
 *
 * 为什么是元组而不是纯 union：与 {@link AGENTMUX_CONTROL_ERROR_CODES} 同源——线上校验（control-host
 * parseExecutors）需要一个能**在运行时拿在手里**的成员集合来判合法性，纯 union 在运行时无迹可寻。
 * 成员判定 {@link isAgentMuxExecutorAvailability} 派生自这一个元组，不另写第二份手抄。元组本身不导出
 * （没有任何外部消费者需要这份运行时值——线上校验只需那个谓词），只导出派生的类型与谓词。
 */
const AGENTMUX_EXECUTOR_AVAILABILITIES = ['unknown', 'check-failed', 'missing', 'available'] as const
export type AgentMuxExecutorAvailability = typeof AGENTMUX_EXECUTOR_AVAILABILITIES[number]

/** 探测（真去查一次）只可能得出后三态之一——`unknown` 是「还没查」，探不出来。 */
export type AgentMuxExecutorProbeOutcome = Exclude<AgentMuxExecutorAvailability, 'unknown'>

/** 入站的这个值是不是一个合法可用性档位。成员集合派生自 {@link AGENTMUX_EXECUTOR_AVAILABILITIES}。 */
export function isAgentMuxExecutorAvailability(value: unknown): value is AgentMuxExecutorAvailability {
  return (AGENTMUX_EXECUTOR_AVAILABILITIES as readonly unknown[]).includes(value)
}

export type AgentMuxSelfAnchor = { kind: 'self' }
export type AgentMuxRegionAnchor = AgentMuxSelfAnchor | { kind: 'region'; regionId: string }
export type AgentMuxTabAnchor = AgentMuxSelfAnchor | { kind: 'tab'; tabId: string }
export type AgentMuxOpenDestination =
  | { kind: 'split'; region: AgentMuxRegionAnchor; direction: 'left' | 'right' | 'up' | 'down' }
  | { kind: 'new-tab'; after: AgentMuxTabAnchor }
  | { kind: 'launcher'; regionId: string }
export type AgentMuxOpenAgentContent =
  | { kind: 'new-agent'; executorId: AgentExecutorId; prompt?: string }
  | { kind: 'agent-session'; agentSessionId: string }
export type AgentMuxArrangeMode =
  | { kind: 'preset'; preset: WorkbenchLayoutPreset }
  | { kind: 'balance' }
  | { kind: 'active-first' }

type RequestBase = { schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION; requestId: string }
export type AgentMuxControlInspectTabRequest = RequestBase & {
  operation: 'inspect.tab'; target: AgentMuxTabAnchor; caller?: AgentMuxControlCaller
}
export type AgentMuxControlInspectRegionRequest = RequestBase & {
  operation: 'inspect.region'; target: AgentMuxRegionAnchor; caller?: AgentMuxControlCaller
}
export type AgentMuxControlOpenAgentRequest = RequestBase & {
  operation: 'open.agent'; content: AgentMuxOpenAgentContent; destination: AgentMuxOpenDestination; caller?: AgentMuxControlCaller
}
export type AgentMuxControlOpenTerminalRequest = RequestBase & {
  operation: 'open.terminal'; shellCommand?: string; destination: AgentMuxOpenDestination; caller?: AgentMuxControlCaller
}
export type AgentMuxControlOpenBrowserRequest = RequestBase & {
  operation: 'open.browser'; url: string; destination: AgentMuxOpenDestination; caller?: AgentMuxControlCaller
}
export type AgentMuxMessageTarget =
  | AgentMuxSelfAnchor
  | { kind: 'agent-session'; agentSessionId: string }
  | { kind: 'tab'; tabId: string }
  | { kind: 'region'; regionId: string }
export type AgentMuxControlSendRequest = RequestBase & {
  operation: 'send'; target: AgentMuxMessageTarget; text: string; caller?: AgentMuxControlCaller
}
export type AgentMuxControlFocusRequest = RequestBase & {
  operation: 'focus'; target: { kind: 'tab'; tabId: string } | { kind: 'region'; regionId: string }
}
export type AgentMuxControlArrangeRequest = RequestBase & {
  operation: 'arrange'; target: AgentMuxTabAnchor; mode: AgentMuxArrangeMode; caller?: AgentMuxControlCaller
}
/**
 * 把一个 Region 促升成它自己的一张 Tab（#487「单独变成一个 tab」）。
 *
 * 只带一个 Region 选择器，没有 destination——促升**永远**新建一张 Tab（不像 open.* 那样落在某个既有
 * 目标上），所以它不是「move 到任意目的地」，而是「这一格变成它自己的 Tab」。故命名 `promote.region`
 * 而非 `move.region`：与 `inspect.region` 同形（对 Region 的一个动作），且不承诺一个 reducer 并不具备的
 * destination 参数。`self` 复用既有的 caller 解析：Agent 把自己促升成一张新 Tab 是主用例。
 */
export type AgentMuxControlPromoteRegionRequest = RequestBase & {
  operation: 'promote.region'; target: AgentMuxRegionAnchor; caller?: AgentMuxControlCaller
}
export type AgentMuxControlListAgentsRequest = RequestBase & { operation: 'list.agents' }
export type AgentMuxSessionSelector = AgentMuxSelfAnchor | { kind: 'agent-session'; agentSessionId: string }
export type AgentMuxControlInterruptRequest = RequestBase & {
  operation: 'interrupt'; target: AgentMuxSessionSelector; caller?: AgentMuxControlCaller
}
export type AgentMuxControlResumeRequest = RequestBase & {
  operation: 'resume'; target: AgentMuxSessionSelector; text: string; caller?: AgentMuxControlCaller
}
export type AgentMuxControlStopRequest = RequestBase & {
  operation: 'stop'; target: AgentMuxSessionSelector; caller?: AgentMuxControlCaller
}
/**
 * 在一个已经开着的 Browser 上跑一段 Agent 写的程序。
 *
 * **本方案对外表面的全部，只有这一条。** 页面能力（snapshot / click / waitFor / js / cdp……）
 * 全在子进程注入的函数库里，那是内部 API——改名改签名不动这份契约。契约是版本化的，而
 * AGENTS.md:21 禁止 backward-compat migration：发出去就撤不回。所以宁可只发一条通用的
 * 「跑这段代码」，也不要发十九条动词。
 *
 * 没有 `destination`：它作用在一个已存在的 Browser 上（`browserId`），不是往某个空间落一个新东西。
 * 这也是它不叫 `open.*` 的原因。
 */
export type AgentMuxControlBrowserRunRequest = RequestBase & {
  operation: 'browser.run'
  browserId: string
  code: string
  /**
   * 这次操作的 identity，**由调用方给**。
   *
   * 为什么不由主进程铸：socket 是严格一问一答（一条请求 → 一条回执 → end），所以主进程铸出来的 id
   * 只能随**终局**回执露出——而那时操作已经结束，无可查询也无可取消。于是「在飞期间凭 id 查询/取消」
   * 在协议上不可达，`browser.stop` 与 `browser.operation` 只对已结束的操作有效，等于没有。
   *
   * 调用方给 id 是本仓既有的做法，不是新发明：core 的 `submitInputPlan` 收的 `submissionId` 就是
   * 调用方传进来的 `operationId`，同 id 重投是一条设计好的幂等恢复路径。这里沿用同一套语义。
   *
   * 可选，因为不关心 identity 的调用方（发一次就等结果）不该被逼着造一个 uuid。缺席时由承载操作的
   * 那一侧铸一个——铸造点仍只有一个（journal 的 `start`），不是两个：这里给的 id 只是**穿过**它。
   */
  operationId?: string
  caller?: AgentMuxControlCaller
}
/**
 * 读回这个 Browser 上已经发生过的操作。
 *
 * **为什么它值得占一个契约档位**（上面那段说了「宁可只发一条通用的跑代码」，这里要交代为什么是三条
 * 而不是一条）：它是 `browser.replay` 的**唯一入口**。回放要一个 `operationId`，而那个 id 是主进程
 * 生成的、只存在日志里——没有这条，Agent 手上永远没有一个合法的 id 可填，`browser.replay` 就是一个
 * 发出去却没人能调的操作。两条一起才构成一个闭环，单独发任何一条都不完整。
 *
 * 为什么不做成注入的页面函数（那样不动契约，代价更小）：页面函数跑在 `browser.run` 的子进程里，
 * 而那条路**要求自动化开关是开的**（ipc.ts 的 `agentAutomation` 闸）。「只是想看看刚才那次干了什么」
 * 不该被一个驱动页面的开关拦住——出了问题要复盘的时候，人的第一反应恰恰是先把自动化关掉。
 *
 * `browserId` 可省：不给就是这台机器上所有 Browser 的记录。省略比要求它更有用——Agent 重启后
 * 未必还记得自己上次开的是哪个 id，而「先列出来再挑」正是这条要服务的第一个场景。
 */
export type AgentMuxControlBrowserHistoryRequest = RequestBase & {
  operation: 'browser.history'; browserId?: string
}
/**
 * 把日志里记下来的步骤重放一遍。
 *
 * 为什么它不能被 `browser.run` 顶掉（那是本族里最该问的问题）：`browser.run` 收的是 Agent 现写的
 * 一段代码，而这条收的是**我们自己录下来的一份计划**。中间那层生成器（`buildReplayScript`）会给每一步
 * 加上页面身份校验与目标校验，还会把敏感步骤钉成闸门——那些保证是主进程给的，不能指望 Agent
 * 自己在它那段代码里复现一遍。让它走 `browser.run` 就等于把这些校验交给被回放的那一方自证。
 *
 * 三档 `mode` 不是配置层，是三件不同的事：`preview` 只取计划不碰页面（人要先看），`step` 只做第
 * n 步（出错之后接着走），`run` 整份跑完。合成一条布尔会丢掉「只看不做」这个最常用的档。
 */
export type AgentMuxControlBrowserReplayRequest = RequestBase & {
  operation: 'browser.replay'; browserId: string; operationId: string; mode?: 'preview' | 'step' | 'run'; step?: number; caller?: AgentMuxControlCaller
}
/**
 * 停下一个在飞的操作，**凭 operationId，与发起它的那条连接无关**。
 *
 * 取消的是 operation，不是请求。这条区别是这个操作存在的全部理由，也是不走 JSON-RPC 的决定性理由：
 * JSON-RPC / gRPC 的取消都是请求级的（「别做我刚让你做的那件事」），只有发起那一方、且只在自己那条
 * 连接还活着的时候才能撤。这里要的是 operation 级：另一条连接、另一个进程、CLI 断了之后重连，
 * 都能凭 id 停掉它。判据是「那次操作停下了吗」，不是「我这条请求被放弃了吗」。
 *
 * 对一个已经结束的操作取消是**幂等成功**并答出它的终局，不是失败：正常时序下取消总会撞上刚结束的
 * 操作（人点停的同一刻程序自己跑完了），把竞态写成失败等于让调用方无法区分「我停晚了」和「出错了」。
 *
 * 没有 `browserId`：id 本身就定位到那一个操作。要求调用方同时给出 browserId 只会引入「两个参数
 * 互相矛盾时听谁的」这条没必要的裂缝。
 */
export type AgentMuxControlBrowserStopRequest = RequestBase & {
  operation: 'browser.stop'; operationId: string; caller?: AgentMuxControlCaller
}
/**
 * 问一条操作现在怎么样了，凭 operationId。
 *
 * 与 `browser.history` 的分工不是「一条 vs 多条」那么简单：history 按 Browser 列（要先知道是哪个
 * Browser），这条按 operation 问（只知道 id 也够）。一条连接断了之后，另一条连接手上往往只有 id——
 * 它不知道、也不该需要知道那个操作跑在哪个 Browser 上。
 *
 * 答案覆盖四种状态，互不折叠：在跑、completed、stopped、以及重启后被判为 indeterminate。最后那一档
 * 是承重的——进程重启时活着的操作会被转成 indeterminate（不是 failed，也不是 completed），意思是
 * 「这件事做到哪儿我们不知道」，而调用方对它唯一正确的反应是**别盲目重试**。
 *
 * 查不到是一次成功的回答（`operation: null`），不是错误：id 可能来自另一台机器、或者早被日志轮转掉了。
 * 把「我们查不到」报成失败会让调用方以为 Browser 出了问题——那是 RED-LINES 第 2 类。
 */
export type AgentMuxControlBrowserOperationRequest = RequestBase & {
  operation: 'browser.operation'; operationId: string
}
/**
 * 订阅一条操作的进度事件流。
 *
 * **它与上面所有操作的区别不在语义而在 framing**：其余 14 条都是一问一答（一条请求 → 一条回执 →
 * 关闭），这一条是一问多答。所以它必须是 socket 上一条**明确的新长连接路径**，而不是就地放宽
 * `readMessage` 的尾随数据检查——放宽的话，全部 14 个操作的 framing 假设会一起松掉，而它们的
 * 正确性都建立在「读到第一个换行就是全部」这个前提上。
 *
 * 事件信封沿用 CLI 已有的那一份（`printStream` 的 `{ ..., event, result }`），不新造一套：
 * 同一个客户端读 `output --follow` 与读这条流应该用同一段解析代码。
 *
 * `afterSequence` 是游标：客户端断线重连时报出自己收到的最后一条序号，服务端从那之后接着发。
 * 缺席等于从当下开始。给了一个服务端已经不再持有的序号时，答案是**显式的 gap**，不是静默从最早
 * 一条开始发——后者会让客户端拿到一份「看起来连续但中间少了一段」的流，而它无从察觉。
 * 事件上限是承载方的既有上限（journal 的 512），本协议不复述那个数字，只要求缺口必须说出来。
 */
export type AgentMuxControlBrowserSubscribeRequest = RequestBase & {
  operation: 'browser.subscribe'; operationId: string; afterSequence?: number
}
export type AgentMuxControlRequest =
  | AgentMuxControlInspectTabRequest
  | AgentMuxControlInspectRegionRequest
  | AgentMuxControlOpenAgentRequest
  | AgentMuxControlOpenTerminalRequest
  | AgentMuxControlOpenBrowserRequest
  | AgentMuxControlSendRequest
  | AgentMuxControlFocusRequest
  | AgentMuxControlArrangeRequest
  | AgentMuxControlPromoteRegionRequest
  | AgentMuxControlListAgentsRequest
  | AgentMuxControlInterruptRequest
  | AgentMuxControlResumeRequest
  | AgentMuxControlStopRequest
  | AgentMuxControlBrowserRunRequest
  | AgentMuxControlBrowserHistoryRequest
  | AgentMuxControlBrowserReplayRequest
  | AgentMuxControlBrowserStopRequest
  | AgentMuxControlBrowserOperationRequest
  | AgentMuxControlBrowserSubscribeRequest

/**
 * 一段 Agent 程序的结局——**四分类，不是布尔成败**。
 *
 * 与 renderer 的 `service-window-notice.ts` 那个 `StepOutcome` 是同一条原则（AGENTS.md:32-52）的两次
 * 兑现，不是同一个类型：那个带的是服务窗的 UI 文案（label / degradedMode / restore），core 既看不见
 * 也不该看见。这里落的是原则本身——**「分不清」必须是一等状态，不许折进成功或失败**。
 *
 * 四类各自对应调用方的一个不同动作：
 *   - `completed`：程序跑完了，`result` 是它的返回值。
 *   - `script-failed`：程序自己抛了（含语法错）。要改的是**程序**。
 *   - `stopped`：我们主动截断的（跑太久 / 输出太多）。程序没问题，是它超出了预算——要改的是**规模**。
 *   - `indeterminate`：进程非正常终止（堆爆、被信号杀掉、没报结果就退了）。**做到哪一步不知道**——
 *     页面上可能已经点过一次了。不许当成失败重试，那正是「下单点两次」的来源。
 *
 * 为什么 `stopped` 不并进 `script-failed`：截断是我们的策略，不是程序的缺陷，合并会让 Agent 去改
 * 一段本来没错的代码。为什么 `indeterminate` 不并进 `stopped`：前者我们不知道进度，后者知道。
 */
export type AgentMuxControlBrowserRunOutcome =
  | { kind: 'completed' }
  | { kind: 'script-failed'; message: string }
  | { kind: 'stopped'; message: string }
  | { kind: 'indeterminate'; message: string }

/** Stable operation facts returned with a Browser run receipt. The detailed step
 * vocabulary is intentionally opaque to Core; Desktop owns Browser semantics. */
export type AgentMuxControlBrowserOperation = {
  id: string
  browserId: string
  operator: { id: string; name: string; providerId?: string }
  startedAt: number
  finishedAt?: number
  phase: string
  summary: string
  url: string
  steps: unknown[]
  replayOf?: string
  warning?: string
}

/** Core keeps replay assets opaque beyond their version and join identity. Desktop owns step semantics. */
export type AgentMuxControlBrowserReplayPlan = {
  schema: 'agentmux.browser-replay.v1'
  operationId: string
  url: string
  steps: unknown[]
}

export type AgentMuxControlResult =
  | { operation: 'inspect.tab'; tab: AgentMuxInspectedTab }
  | { operation: 'inspect.region'; region: AgentMuxInspectedRegion }
  | { operation: 'open.agent'; region: AgentMuxAgentRegion }
  | { operation: 'open.terminal'; region: AgentMuxTerminalRegion }
  | { operation: 'open.browser'; region: AgentMuxBrowserRegion }
  | { operation: 'send'; agentSessionId: string }
  | { operation: 'focus'; tabId: string; regionId?: string }
  | { operation: 'arrange'; tab: AgentMuxInspectedTab }
  // Where the promoted Region now lives: a brand-new Tab, same regionId (kept, not minted) and workspace.
  // The caller feeds this straight back into focus / inspect.region. A no-op (the Region was already its
  // own Tab, or the request was stale) is NOT reported here — it raises a typed CONTROL_FAILED instead.
  | { operation: 'promote.region'; tabId: string; regionId: string; workspaceId: string }
  | { operation: 'list.agents'; agents: AgentMuxControlExecutor[] }
  | { operation: 'interrupt'; agentSessionId: string }
  | { operation: 'resume'; agentSessionId: string; runId: string }
  | { operation: 'stop'; agentSessionId: string }
  // result 是程序的返回值（任意 JSON 值，也可能没有）；logs 是它 console 出来的每一行，**失败时照样有**
  // ——程序炸掉之前打的那几行，往往正是 Agent 需要的。outcome 说清这是四类结局里的哪一类。
  | {
      operation: 'browser.run'
      result: unknown
      logs: string[]
      outcome: AgentMuxControlBrowserRunOutcome
      // 不叫 `operation`：这个联合的判别键就是 `operation`（上面每一支的 `'browser.run'` 等字面量），
      // 同一个成员里再放一个同名字段会让 tsc 报 Duplicate identifier，且判别键被覆盖后整个联合的
      // 收窄全部失效。receipt 侧改名，wire 侧的字段名不动（那是协议，见 control-host 的读取点）。
      runOperation: AgentMuxControlBrowserOperation
    }
  | { operation: 'browser.history'; operations: AgentMuxControlBrowserOperation[] }
  | {
      operation: 'browser.replay'
      mode: 'run' | 'step'
      result: unknown
      logs: string[]
      outcome: AgentMuxControlBrowserRunOutcome
      runOperation: AgentMuxControlBrowserOperation
    }
  | {
      operation: 'browser.replay'
      mode: 'preview'
      plan: AgentMuxControlBrowserReplayPlan
    }
  /**
   * 取消的回执**带出那条操作的当下事实**，不是一句 `{ ok: true }`。
   *
   * 理由是幂等：取消一个已经结束的操作也算成功，那么「成功」本身就不告诉调用方发生了什么——它需要
   * 知道的是这次停的是个在跑的操作（现在 stopped），还是撞上了一个刚跑完的（仍是 completed）。
   * 两种都是成功，但对调用方的意义完全不同：后者意味着程序的结果是真的、该去读它。
   *
   * 字段叫 `runOperation` 而不是 `operation`：这个联合的判别键就是 `operation`，同名字段会让 tsc 报
   * Duplicate identifier 且判别键被覆盖后整个联合的收窄全部失效。`browser.run` 那一支已经因为同一个
   * 原因这么命名了（见上），这里沿用同一个名字而不是另起一个——两个名字表达同一件事就是下一次漂移。
   *
   * 可为 null：id 查不到时取消是成功的（没有什么要停），但没有事实可报。
   */
  | { operation: 'browser.stop'; runOperation: AgentMuxControlBrowserOperation | null }
  /** 问一条操作的当下事实。查不到答 null——那是一次成功的回答，不是错误。 */
  | { operation: 'browser.operation'; runOperation: AgentMuxControlBrowserOperation | null }
  /**
   * 订阅的**开场帧**——不是终局回执。事件跟在它后面从同一条 socket 流出来。
   *
   * `gap` 是这一支存在的主要理由。承载方只保留有限条事件（journal 是 512 条），所以「客户端要的那段
   * 已经不在了」是一个必然会发生的状态，不是异常。它必须在**第一帧就说出来**，而不是让客户端自己从
   * 序号跳变里去猜：
   *   - `null`：没有缺口，从 `afterSequence` 之后一条不落。
   *   - 有值：`droppedThrough` 之前的事件已经不可得了，流从它之后开始。收到它的客户端知道自己手上
   *     这份时间线是**不完整**的，可以改去读一次完整快照（`browser.operation`）来对齐。
   *
   * `runOperation` 可为 null：订阅一个查不到的 id 是成功的（没有什么可流），但没有事实可报。
   * 这与 `browser.stop` / `browser.operation` 的取舍是同一条——「我们查不到」不是 Browser 坏了。
   */
  | {
      operation: 'browser.subscribe'
      runOperation: AgentMuxControlBrowserOperation | null
      gap: { droppedThrough: number } | null
    }

type WithoutOperation<T> = T extends unknown ? Omit<T, 'operation'> : never
type SuccessByOperation<Operation extends AgentMuxControlResult['operation']> = {
  schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION
  requestId: string
  ok: true
  operation: Operation
  result: WithoutOperation<Extract<AgentMuxControlResult, { operation: Operation }>>
}
export type AgentMuxControlSuccessReceipt = {
  [Operation in AgentMuxControlResult['operation']]: SuccessByOperation<Operation>
}[AgentMuxControlResult['operation']]
export type AgentMuxMessageTargetCandidate = { agentSessionId: string; regionIds: string[] }
export type AgentMuxControlError =
  | { code: 'MESSAGE_TARGET_NOT_UNIQUE'; message: string; candidates: AgentMuxMessageTargetCandidate[] }
  | {
      code: Exclude<AgentMuxControlErrorCode, 'MESSAGE_TARGET_NOT_UNIQUE'>
      message: string
      candidates?: never
    }
export type AgentMuxControlErrorReceipt = {
  schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION
  requestId: string | null
  ok: false
  operation: AgentMuxControlRequest['operation'] | null
  error: AgentMuxControlError
}
export type AgentMuxControlReceipt = AgentMuxControlSuccessReceipt | AgentMuxControlErrorReceipt
/**
 * 一条流出去的进度事件。
 *
 * `sequence` 是本条流内单调递增的序号，客户端断线重连时把最后一个序号报回来（`afterSequence`）。
 * `event` 的内容对 core 不透明——步骤词汇归 Desktop（与 {@link AgentMuxControlBrowserOperation}
 * 的 `steps: unknown[]` 同一条取舍）。core 只负责序号、信封与缺口这三件它能负责的事。
 */
export type AgentMuxControlBrowserEvent = { sequence: number; event: unknown }

/**
 * 承载方向 core 交出的一条订阅。
 *
 * 形状是 push（`onEvent` + 一个退订函数）而不是 pull（异步迭代器）：承载方那边本来就是回调
 * （journal 的 `onEvent`），做成 pull 要在中间加一层缓冲队列，而那层队列就是第二处会丢事件的地方。
 *
 * `gap` 在**建立订阅时**一次性给出，不做成事件流里的一条：缺口是「你要的那段已经不在了」这个事实，
 * 它在第一帧之前就已经成立，放进流里等于让客户端先收几条再被告知前面缺了——那时它可能已经按
 * 一份不完整的时间线做了判断。
 */
export type AgentMuxControlBrowserSubscription = {
  runOperation: AgentMuxControlBrowserOperation | null
  gap: { droppedThrough: number } | null
  /** 退订。必须幂等：客户端断线与操作自己结束会同时到达。 */
  dispose(): void
}

export interface AgentMuxControlHost {
  execute(request: AgentMuxControlRequest): Promise<AgentMuxControlResult>
  /**
   * 建立一条进度订阅。**可选**——不实现它的宿主照旧服务其余 14 个操作，订阅请求得到一个类型化的
   * 「这个宿主不提供进度订阅」。这不是 fallback，是能力协商：一个没有 Browser 的宿主（比如只跑
   * Agent 会话的那种）本来就没有进度可流，逼它实现一个空壳反而让「有没有这个能力」不可判。
   */
  subscribeBrowserOperation?(
    request: AgentMuxControlBrowserSubscribeRequest,
    onEvent: (event: AgentMuxControlBrowserEvent) => void
  ): Promise<AgentMuxControlBrowserSubscription>
}

export function resolveAgentMuxRegion(regions: readonly AgentMuxRegion[], target: AgentMuxRegionTarget): AgentMuxRegion {
  if (new Set(regions.map(({ regionId }) => regionId)).size !== regions.length) throw new AgentMuxError('Open Region identity is ambiguous.', 'AMBIGUOUS_REGION_TARGET')
  const matches = regions.filter((region) => target.kind === 'region'
    ? region.regionId === target.regionId
    : region.kind === 'agent' && region.agentSessionId === target.agentSessionId)
  if (matches.length === 0) throw new AgentMuxError('Region target is not currently open.', 'REGION_NOT_OPEN')
  if (matches.length !== 1) throw new AgentMuxError('Region target is ambiguous.', 'AMBIGUOUS_REGION_TARGET')
  return structuredClone(matches[0]!)
}

/**
 * 一次 Control 请求的等待预算，以及「哪些操作算慢」。**唯一一处。**
 *
 * 请求走两条不同的路到达执行方，两条各自有一个等待方：
 *   - CLI → daemon 的 socket（control-host.ts 的 `socket.setTimeout`）
 *   - Renderer 拥有屏幕时，main 经 IPC 转给 Renderer（DesktopControlIpcBridge 的 `setTimeout`）
 * 两条都必须用同一个预算：同一条 `amux open.agent`，若一条等 60 秒另一条等 2 秒，用户看到的就是
 * 「同一个命令有时能开出来、有时报 CONTROL_TIMEOUT」，而差别只在当时是谁拥有屏幕。
 *
 * **为什么连 {@link isLongAgentMuxControlOperation} 也必须在这里而不是各写一遍：**
 * 此前两侧各手抄一份 `2_000` / `60_000`（control-host.ts 与 control-ipc-bridge.ts），而「哪些操作算慢」
 * 在 core 侧是个命名函数、在 bridge 侧被内联展开成同样的四项析取。于是**加一个慢操作**时——比如将来的
 * `open.file` 要等磁盘、或 `arrange` 要等一次布局落地——只改 core 那个函数的人会得到一个全绿的仓库，
 * 而 bridge 那条路静默给它 2 秒预算。取值手抄会漂移，判据手抄同样会，且后者更难看出来。
 *
 * 取值本身（2s / 60s）是否合理是另一个问题（长操作的 60 秒在负载下会杀掉健康的 resume）；这里只保证
 * 两条路问的是同一个数、用的是同一条判据。
 */
export const AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS = 2_000
export const AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS = 60_000

/**
 * 每个操作的等待预算档位——逐个写死，不许按前缀或形状推断。
 *
 * 为什么是一张穷尽表而不是一个谓词：谓词只能表达「符合这个形状的算慢」，而**新加的操作不符合任何形状
 * 时会静默落进快的那档**。此前的写法是 `startsWith('open.') || === 'send' || === 'resume' || === 'stop'`，
 * 于是 `interrupt` 加进联合类型时没有任何东西提醒过要给它定档——它只是不匹配，就拿到了 2 秒。
 * （`interrupt` 拿短预算其实是对的：它只是往 daemon 发一次信号，不像 `stop` 要等 attachRecoverableStop
 * 真的收尾。但那应该是有人**判过**的结果，不是漏判的结果。）
 *
 * 写成 `Record<Operation, ...>` 之后，联合里加一个成员而这里不加一行，tsc 直接报缺键：定档从
 * 「你得记得改」变成「不改就编译不过」。
 *
 * 分档判据：`long` 是要等本进程之外的东西——`open.*` 等一个进程起来并交出 Region，`send` 等 composer
 * 就绪并把 prompt 打进去，`resume` 等 Provider 重建会话，`stop` 等进程真的收尾。`short` 是只读、只动
 * 本地状态、或只发一次不等结果的信号，2 秒之内不返回就是真的出事了。
 */
const OPERATION_BUDGET: Record<AgentMuxControlRequest['operation'], 'long' | 'short'> = {
  'inspect.tab': 'short',
  'inspect.region': 'short',
  'open.agent': 'long',
  'open.terminal': 'long',
  'open.browser': 'long',
  send: 'long',
  focus: 'short',
  arrange: 'short',
  // 促升只动本地布局状态（摘一格、新建一张 Tab），不等本进程之外的任何东西——和 arrange 同档。
  'promote.region': 'short',
  'list.agents': 'short',
  interrupt: 'short',
  resume: 'long',
  stop: 'long',
  // Agent 写的调试程序会等页面加载、等网络空闲、循环点很多次——短预算（2 秒）会把**正常执行**掐死，
  // 而掐死的表现是 CONTROL_TIMEOUT，看起来像页面出了事。子进程自己还有一道更紧的超时兜底（脚本执行器
  // 的 timeoutMs），所以这里给长预算不等于没有上限。
  'browser.run': 'long',
  'browser.history': 'short',
  'browser.replay': 'long',
  // 取消只发一次 abort 就返回，不等被取消的那个操作真的收尾——等它等于把「停一个卡住的程序」变成
  // 「跟着那个程序一起卡住」，而卡住恰恰是最需要取消的场景。所以是短档。
  'browser.stop': 'short',
  // 读一条 journal 记录，只碰本地状态。
  'browser.operation': 'short',
  // 开场帧同样只读本地状态就能答出来（那条操作在不在、有没有缺口），所以是短档——**这个预算管的是
  // 开场帧，不是整条流**。流本身的存活由长连接路径自己管（socket 上没有"请求超时"可言：一个操作
  // 安静十分钟是正常的，不是超时）。若这里给长档，等于让一个只读本地状态的问答白等一分钟。
  'browser.subscribe': 'short'
}

/** 这个操作要不要走长预算。取值来自 {@link OPERATION_BUDGET}，那张表是唯一的分档出处。 */
export function isLongAgentMuxControlOperation(operation: AgentMuxControlRequest['operation']): boolean {
  return OPERATION_BUDGET[operation] === 'long'
}

/** 给定操作应当等待的毫秒数——两条路的唯一取值出口。 */
export function agentMuxControlTimeoutMs(operation: AgentMuxControlRequest['operation']): number {
  return isLongAgentMuxControlOperation(operation)
    ? AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS
    : AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS
}

/**
 * 入站的这个值是不是一个合法操作名——成员判定**派生**自 {@link OPERATION_BUDGET} 的键，不是第二份手抄。
 *
 * 为什么问那张表而不是另写一份十二个串的清单：那张表已经被 tsc 强制穷尽（缺键报 TS2741、多键报
 * TS2353），所以它的键集合恒等于联合本身。控制协议的入站校验（control-host）此前正是另写了一份同样
 * 的十二串元组，两份之间没有任何编译期联系——而这种手抄只强制 ⊆（列出的每个串都是合法操作），对 ⊇
 * 完全失明：往联合里加一个操作而忘了往那份手抄里加，daemon 会把**合法的新操作**当成
 * `INVALID_CONTROL_REQUEST` 拒掉，且 tsc 全程沉默。加操作正是常见方向。
 *
 * 做成收窄谓词而不是导出一份键数组让调用方 `includes` 完再 `as` 一次：那个 cast 是同一件事的**第二个
 * 声明点**，「校验用的清单」和「断言成的类型」会各自漂移（control-host 此前正是「裸元组 + cast」两处
 * 并存）。三个消费点都只做成员判定，没有一个需要遍历，所以不留那份数组——留下就是一个零生产调用方
 * 的公共 API，会被 control-export-reachability 判成死代码，那条判据是对的。
 */
export function isAgentMuxControlOperation(value: unknown): value is AgentMuxControlRequest['operation'] {
  return typeof value === 'string' && Object.hasOwn(OPERATION_BUDGET, value)
}
