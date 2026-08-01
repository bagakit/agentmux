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
 * 一个 Provider 的方言声明：它把自己的原始事件名映射到 Core canonical 生命周期事件。
 *
 * **按 Provider 分块而不是一张全局表**，是为了让「新接一个 Provider」只动它自己的模块。全局表会让
 * 每个 Provider 分支都去改同一个文件的同一个对象字面量——那是并行开发里保证冲突的形状，也正是
 * Provider 模块拆分本来要消除的东西。
 */
export type AgentHookLifecycleDialect = Readonly<Record<string, AgentHookLifecycleEvent>>

/**
 * 厂商方言 → Core canonical 生命周期事件的**显式**映射。
 *
 * 显式是刻意的：不按前缀猜（`startsWith('Post')` 这类形状推理正是本表要取代的东西——它把
 * Antigravity 的 `PostInvocation` 误当成工具结果，同时对 Hermes 的 `post_tool_call`、Pi 的
 * `tool_execution_end` 完全失明）。一个方言名只在**该 Provider 自己的声明能佐证**时才进表；
 * 佐证不了的就不进表，让它保持可诊断，而不是替 Provider 猜语义。
 *
 * 也刻意**不做大小写/分隔符归一化**（把 `PreToolUse` 正则折成 `pre_tool_use` 那种）。折叠会顺带
 * 接受一堆从没被任何 Provider 观察到的拼法，于是表里每个键不再等于「某处有证据的事实」，
 * 而变成「碰巧能被折过来的字符串」——审计不了，也就守不住「能力未核实就不声明」这条北极星。
 *
 * 键**允许在 Provider 之间重复**：同一个原始名在不同 Provider 上是同一个结构性生命周期事件
 * （grok 与 cursor 都用 `stop` 收尾）。允许重复是安全的，因为这里只答「这是结构上的哪一步」，
 * 不答 `working`/`done`——语义状态一律由各 Provider 自己的 `rules` 给出。这个分工是必须的：
 * OpenCode 的 `SessionStart` 是 `done`（一次会话到此结束），Claude 的 `SessionStart` 是 `working`，
 * 同名同结构、语义相反。真出现同名却**结构**冲突的 Provider，再按其真实形状把查表下推到 Provider，
 * 别为了一个尚未存在的冲突提前把接口做复杂。
 */

/** Claude / Codex / Antigravity 一族的 PascalCase 方言（Claude 与 Codex 共用这份）。 */
export const PASCAL_CASE_HOOK_DIALECT: AgentHookLifecycleDialect = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt-submit',
  PermissionRequest: 'permission-request',
  // 一次工具调用的**事前**：只有入参，谈不上成败。
  PreToolUse: 'tool-use-start',
  // 一次工具调用的**事后**：结果与成败在此刻才存在。这两行就是 `startsWith('Post')` 的替代品。
  PostToolUse: 'tool-use-end',
  PostToolUseFailure: 'tool-use-end',
  // 子代理生命周期（按 id 记账的那套，见 hook-normalizer 的花名册）。
  SubagentStart: 'subagent-start',
  SubagentStop: 'subagent-stop',
  // 一个 turn 收尾——用量在此刻已落定，故这是「该不该读 transcript 抽 token」的唯一判据。
  Stop: 'turn-end',
  StopFailure: 'turn-end'
}

/**
 * 故意不进表的几个，以及为什么（它们属于上面那份 PascalCase 方言的「不映射」决定）：
 * - `PreCompact`（Claude）、`PreInvocation`/`PostInvocation`（Antigravity）：Core 今天没有任何判断
 *   需要它们，各自的 Provider `rules` 已给出正确的 `working`。`PostInvocation` 尤其不能进
 *   `tool-use-end`——它是一次调用的外层收尾，不是一次工具调用的结果。
 */

/** Hermes 的 snake_case 方言。`pre_llm_call` 刻意不映射，理由同上。 */
export const HERMES_HOOK_DIALECT: AgentHookLifecycleDialect = {
  on_session_start: 'session-start',
  pre_tool_call: 'tool-use-start',
  post_tool_call: 'tool-use-end',
  post_llm_call: 'turn-end',
  on_session_end: 'turn-end'
}

/**
 * Pi 的 snake_case 方言。
 *
 * `message_end` 刻意不映射：Pi 自己把它声明成 `working` 而非 `done`，映射成 turn 收尾会与 Provider
 * 的声明相矛盾——那正是「替 Provider 猜语义」。Pi 的收尾是 `agent_end`/`agent_settled`。
 */
export const PI_HOOK_DIALECT: AgentHookLifecycleDialect = {
  before_agent_start: 'session-start',
  agent_start: 'session-start',
  tool_call: 'tool-use-start',
  tool_execution_start: 'tool-use-start',
  tool_execution_end: 'tool-use-end',
  agent_end: 'turn-end',
  agent_settled: 'turn-end'
}

/**
 * Core 认识的全部方言，按 Provider 组合。
 *
 * 组合点在这里、声明在各 Provider 自己的常量里：加一个 Provider 是加一行 import + 一行 spread，
 * 不必去动任何已有 Provider 的映射。
 */
const HOOK_LIFECYCLE_DIALECTS: readonly AgentHookLifecycleDialect[] = [
  PASCAL_CASE_HOOK_DIALECT,
  HERMES_HOOK_DIALECT,
  PI_HOOK_DIALECT
]

/** 合并后的查表面。重复键必须映射到同一个 canonical 事件，否则是真冲突——见下方构造时的断言。 */
export const AGENT_HOOK_LIFECYCLE_DIALECT: AgentHookLifecycleDialect = (() => {
  const merged: Record<string, AgentHookLifecycleEvent> = {}
  for (const dialect of HOOK_LIFECYCLE_DIALECTS) {
    for (const [raw, canonical] of Object.entries(dialect)) {
      const existing = merged[raw]
      // 同名不同结构 = 一个原始名在两家 Provider 上是**结构上不同**的一步。合并表答不了这种问题，
      // 静默取其一会让其中一家的时间轴长期错位，所以在模块加载时就炸，而不是留一个安静的错答案。
      if (existing !== undefined && existing !== canonical) {
        throw new Error(
          `Hook lifecycle dialect conflict for "${raw}": ${existing} vs ${canonical}. ` +
          'A raw event name must mean the same structural step for every Provider.'
        )
      }
      merged[raw] = canonical
    }
  }
  return merged
})()

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
