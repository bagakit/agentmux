import type { AgentHookLifecycleEvent } from './types.js'

/**
 * Hook 事件名的**规范化层**：一个零依赖的叶子模块，只做两件事——把「事件名藏在哪个字段」和
 * 「厂商方言叫什么」收敛成 Core 的同一份口径。
 *
 * 为什么单独成一个模块：这份表有两个消费者，它们跑在**不同的进程里**。normalizer 跑在 Core 进程，
 * `agent-hook-command` 跑在每次 hook 事件都新起一次的子进程（`bin/agentmux-hook.js`）里，后者的启动
 * 时间落在 Agent 每次工具调用的关键路径上。让子进程去 import normalizer（那里有跨事件的花名册 Map、
 * node:path 依赖）只为拿一张表，是让最热的路径为它用不到的机制付钱。所以表放在这里：无 runtime 依赖、
 * 两边都能便宜地拿到，且**只有一份**。
 *
 * 这层不碰语义状态。`working`/`done` 一律由 Provider 自己声明的 `rules` 决定（见 hook-normalizer.ts），
 * 规范化只回答 Core 真正需要判断的那几个问题——「这条事件是工具结果吗」「这条事件是 turn 收尾吗」。
 * 映射不到的事件保持映射不到：它的原始名照旧带进诊断，语义仍由 rules 给出，绝不因为「没认出来」就
 * 补一个 working/done。
 */

/**
 * 事件名可能藏身的 payload 字段名，顺序即优先级。
 *
 * 三个拼法都真实存在：Claude/Codex 的 stdin 负载给 `hook_event_name`，同族 CLI 的 camelCase 变体给
 * `hookEventName`，另一些给裸 `eventName`。**此前三个读取点各认其中两个**——normalizer 认
 * `hook_event_name`/`hookEventName`，hook 子进程认 `hook_event_name`/`eventName`，
 * 于是同一条事件在同一次投递里，一边认得出、另一边读成 null。这份清单就是那三处的唯一出处。
 */
export const HOOK_EVENT_NAME_PAYLOAD_KEYS = ['hook_event_name', 'hookEventName', 'eventName'] as const

/**
 * 厂商方言 → Core canonical 生命周期事件的**显式**映射表。
 *
 * 显式是刻意的：不按前缀猜（`startsWith('Post')` 这类形状推理正是本表要取代的东西——它把
 * Antigravity 的 `PostInvocation` 误当成工具结果，同时对 Hermes 的 `post_tool_call`、Pi 的
 * `tool_execution_end` 完全失明）。一个方言名只在**该 Provider 自己的声明能佐证**时才进表；
 * 佐证不了的就不进表，让它保持可诊断，而不是替 Provider 猜语义。
 *
 * 故意不进表的几个，以及为什么：
 * - `PreCompact`（Claude）、`pre_llm_call`（Hermes）、`PreInvocation`/`PostInvocation`（Antigravity）:
 *   Core 今天没有任何判断需要它们，各自的 Provider `rules` 已给出正确的 `working`。
 * - `message_end`（Pi）: Pi 自己把它声明成 `working` 而非 `done`，映射成 turn 收尾会与 Provider
 *   的声明相矛盾——那正是「替 Provider 猜语义」。Pi 的收尾是 `agent_end`/`agent_settled`。
 */
export const AGENT_HOOK_LIFECYCLE_DIALECT: Readonly<Record<string, AgentHookLifecycleEvent>> = {
  // 会话开始。
  SessionStart: 'session-start',
  on_session_start: 'session-start',
  before_agent_start: 'session-start',
  agent_start: 'session-start',

  // 用户提交 Prompt。
  UserPromptSubmit: 'user-prompt-submit',

  // Provider 主动请求授权。
  PermissionRequest: 'permission-request',

  // 一次工具调用的**事前**：只有入参，谈不上成败。
  PreToolUse: 'tool-use-start',
  pre_tool_call: 'tool-use-start',
  tool_call: 'tool-use-start',
  tool_execution_start: 'tool-use-start',

  // 一次工具调用的**事后**：结果与成败在此刻才存在。这一行就是 `startsWith('Post')` 的替代品，
  // 也是 Hermes / Pi 第一次能在时间轴上区分「失败的命令」与「成功的命令」的地方。
  PostToolUse: 'tool-use-end',
  PostToolUseFailure: 'tool-use-end',
  post_tool_call: 'tool-use-end',
  tool_execution_end: 'tool-use-end',

  // 子代理生命周期（按 id 记账的那套，见 hook-normalizer 的花名册）。
  SubagentStart: 'subagent-start',
  SubagentStop: 'subagent-stop',

  // 一个 turn 收尾——用量在此刻已落定，故这是「该不该读 transcript 抽 token」的唯一判据。
  // 每一条都由对应 Provider 自己的 rules 声明成 `done` 佐证。
  Stop: 'turn-end',
  StopFailure: 'turn-end',
  post_llm_call: 'turn-end',
  on_session_end: 'turn-end',
  agent_end: 'turn-end',
  agent_settled: 'turn-end'
}

function boundedEventName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * 从信封与负载里读出这条 hook 事件的**原始**名字。
 *
 * 信封上的显式 `eventName` 优先（它来自 hook 命令的 `--event` 旗标或环境变量，是投递方明说的），
 * 其次按 `HOOK_EVENT_NAME_PAYLOAD_KEYS` 依次读负载。读不出就是 `undefined`——由调用方决定缺席怎么办，
 * 这里不替它编一个名字。
 */
export function resolveHookEventName(
  envelopeEventName: unknown,
  payload: Record<string, unknown> = {}
): string | undefined {
  const explicit = boundedEventName(envelopeEventName)
  if (explicit) return explicit
  for (const key of HOOK_EVENT_NAME_PAYLOAD_KEYS) {
    const value = boundedEventName(payload[key])
    if (value) return value
  }
  return undefined
}

/**
 * 把一个厂商方言事件名归一化到 Core canonical 生命周期事件。
 *
 * 认不出就返回 `undefined`——这是一等公民的答案，读作「Core 对这条事件没有 canonical 语义」，
 * 而不是「这条事件不重要」或「就当它是 working」。调用方必须能在缺席下正确工作。
 */
export function canonicalHookLifecycleEvent(
  rawEventName: string | undefined
): AgentHookLifecycleEvent | undefined {
  if (!rawEventName) return undefined
  return AGENT_HOOK_LIFECYCLE_DIALECT[rawEventName]
}

/**
 * 反查：所有归一化到某个 canonical 事件的**原始**方言名。
 *
 * 给那些只能按原始名做集合判定的既有消费者用（`USAGE_FINALIZATION_EVENTS` 就是这么派生出来的），
 * 好让它们不必各自再抄一份厂商事件名——表在这里，派生在别处，仍然只有一份真相。
 */
export function rawEventNamesForLifecycle(
  lifecycleEvent: AgentHookLifecycleEvent
): readonly string[] {
  return Object.entries(AGENT_HOOK_LIFECYCLE_DIALECT)
    .filter(([, canonical]) => canonical === lifecycleEvent)
    .map(([raw]) => raw)
}
