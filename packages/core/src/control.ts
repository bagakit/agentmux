import { AgentMuxError } from './errors.js'
import type { AgentExecutorId, AgentProviderId } from './types.js'

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
  available: boolean
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
  | { kind: 'preset'; preset: 'columns-3' | 'grid-4' | 'grid-6' | 'grid-9' }
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
