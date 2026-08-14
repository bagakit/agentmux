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
  'SIGNAL_UNSUPPORTED'
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

type SuccessByOperation<Operation extends AgentMuxControlResult['operation']> = {
  schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION
  requestId: string
  ok: true
  operation: Operation
  result: Omit<Extract<AgentMuxControlResult, { operation: Operation }>, 'operation'>
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
export interface AgentMuxControlHost { execute(request: AgentMuxControlRequest): Promise<AgentMuxControlResult> }

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
  stop: 'long'
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
