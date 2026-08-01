import type { AgentHookLifecycleEvent } from './types.js'

/**
 * 一个 turn 收尾之后到达的工具事件，不许再改语义状态。
 *
 * 事故形状（探针实测）：`Stop` 让 Agent 落到 `done`，紧随其后一条迟到的 `PostToolUse` 把它翻回
 * `working`，并把 `semanticStatus={state:'working'}` 写进存储。此后再没有任何事件会拨正它——衰减窗口
 * 是 15 分钟（见 agent-status-freshness.ts），而衰减只把 `working` 降到 `unknown`/`running`，降不回
 * `done`。用户盯着一个早已交付完成的 Agent 在列表里转圈整整一刻钟，且冷启动读回磁盘上那条 `working`
 * 会继续撒谎。
 *
 * **为什么判据不是比时间戳。** 直觉的修法是照 ACP 那侧（client.ts 的 `persistSemanticStatus`）按
 * `observedAt` 拒绝更旧的写入。那在这条路上是死代码：hook 的 `observedAt` 由 hook-normalizer 用
 * `Date.now()` 打在**我们摄入的那一刻**，不是 agent 进程发出事件的时刻。迟到的事件摄入得更晚，
 * `observedAt` 反而**更大**——单调守卫恒真放行。加了它不但没用，还会让下一个人以为这里已经守住了。
 *
 * 真正的判据来自结构而非时间：canonical 生命周期表（agent-hook-event.ts）已经把
 * `turn-end`（Stop/StopFailure）与 `tool-use-start`/`tool-use-end`（Pre/PostToolUse）分开了，而
 * **一个 turn 收尾之后直接冒出属于它的工具事件，是结构上不可能的合法序列**：Agent 要再动工必须先开新
 * 的一轮，那会先落一条 `user-prompt-submit`（用户交了输入）或 `turn-start`（Agent 开工）。所以
 * 「turn 已收尾且还没开新 turn」这个状态，就是判「这条工具事件是迟到的残响」的充分依据。
 *
 * **为什么重开需要两个事件而不是一个。** 这里原先只认 `user-prompt-submit`，并在注释里断言「要再动工
 * 必须先收到新的用户输入」。那句话对 claude/codex 一族成立，对 Hermes 与 Pi **不成立**：它们的 hook
 * 面上没有任何「用户提交了 prompt」事件（用户在 Provider 自己的 TUI 里打字，AgentMux 看不见），能看见
 * 的只有「这一轮开工了」。后果是闸门**永久 latch**：Hermes 第一条 `post_llm_call` 收尾之后，此后每条
 * `pre_tool_call`/`post_tool_call` 都被判 false，整个 run 余下的 working / 等你态全部被静默吞掉——
 * 不是延迟 15 分钟，是再也不会正确。所以判据是「有没有开新一轮」，而开新一轮有两种可观察形状。
 *
 * 这条闸门因此对方言表提了一个**结构要求**：能收尾的方言必须也能重开。差一半的方言不是「少一个映射」，
 * 而是这条判据在那家 Provider 上恒为拒绝。agent-hook-event.test.ts 里钉着这条不变量。
 *
 * 为什么可以用「已见过 turn-end」这种状态量：同一个 binding 的 hook 事件在 hook-server 里被串成一条
 * tail 顺序投递（enqueue 把每次 delivery 接在上一次之后），所以摄入侧不存在并发乱序——乱序只发生在
 * agent 进程发出的那一端，而那正是要挡的东西。
 */

/** 一个 Run 的 turn 收尾台账。`undefined` 语义是「这个 Run 还没见过任何 turn-end」。 */
export type HookTurnPhase = 'in-turn' | 'turn-ended'

/**
 * 能把收尾台账重新打开的生命周期事件。方言表的结构不变量按这份清单判（见 agent-hook-event.ts 的
 * `eventNamesCanReopenTurn`），所以它导出而不是内联进下面的判断——两处各写一份必然漂移，而漂移的形状恰好
 * 是「不变量说满足了，闸门其实没开」。
 *
 * 定义在这里而不是 agent-hook-event.ts：那个模块躺在 hook 子进程的关键路径上（每次工具调用都新起一次
 * 进程去拿方言表），本文件是纯判据、零依赖，让它反向 import 才不会把依赖图倒过来。
 */
export const TURN_REOPENING_EVENTS: readonly AgentHookLifecycleEvent[] = [
  // 用户交了输入（claude / codex / grok / gemini / cursor 一族看得见这个）。
  'user-prompt-submit',
  // Agent 开始跑这一轮（Hermes 只看得见这个）。
  'turn-start'
]

/**
 * 这条生命周期事件把 Run 推到哪个阶段；`undefined` 表示它不改变阶段（照旧沿用当前值）。
 *
 * 只有三类事件动阶段，其余（permission-request、subagent-*、session-start）一概不动——它们既不开启
 * 也不收尾一个 turn，让它们动阶段会把这条判据变成一张需要逐个 Provider 维护的表。
 *
 * `session-start` 尤其不算重开，且这不是省事：Hermes 的 `on_session_start` 第一方源码写明只在**全新
 * 会话**建立时触发（"not on continuation"），一个 run 里只有一次。拿它当重开会让「所有方言都满足重开
 * 要求」这句话变成好看的假话，而 Hermes 的闸门照旧 latch。
 */
export function hookTurnPhaseAfter(
  lifecycleEvent: AgentHookLifecycleEvent | undefined
): HookTurnPhase | undefined {
  if (lifecycleEvent === 'turn-end') return 'turn-ended'
  // 开新一轮——这是唯一能把台账重新打开的两种事件，也是「不误伤下一轮工作」的那一半。
  if (TURN_REOPENING_EVENTS.includes(lifecycleEvent as AgentHookLifecycleEvent)) return 'in-turn'
  return undefined
}

/**
 * 这条 hook 事件该不该更新语义状态。
 *
 * `false` 只在一种情形出现：Run 已收尾（`turn-ended`）、这条事件是一次工具调用的事前或事后，**且**这家
 * Provider 有办法重开一个 turn。其余一律 `true`——包括 `turn-ended` 之后的重开事件
 * （`user-prompt-submit`/`turn-start`，它们开启新 turn，必须照收）与任何认不出 canonical 生命周期的
 * 事件（`undefined`：语义状态一律由 Provider 的 rules 给出，归一化失败绝不该顺带静音一个健康的 Agent）。
 *
 * **为什么要问「这家能不能重开」。** 这道闸门是可逆的抑制：先压住迟到的残响，等下一轮开工再放开。对一个
 * 没有任何重开事件的方言（今天是 Pi，见 agent-hook-event.ts），它退化成**不可逆**——第一次收尾之后
 * 永久拒绝，整个 run 余下的 working/等你态全被吞掉。两害相权取其轻：宁可漏掉一次「收尾后压制残响」，
 * 也不能让一个健康的 Agent 从此再也点不亮。所以缺重开能力时按不抑制处理。
 *
 * 这不是给 Pi 开的后门，而是这条判据的前提本来就该显式：它整套推理建立在「收尾之后要动工必先重开」上，
 * 前提不成立时结论也不成立。前提可满足性因此必须是入参，不能靠调用方记得。
 *
 * 只挡语义状态，不挡整条事件：回执、时间轴条目、用量都仍要落——一次真实发生过的工具调用是事实，
 * 该出现在时间轴上；错的只是「所以它现在正在干活」这个推论。
 */
export function hookEventUpdatesSemanticStatus(
  phase: HookTurnPhase | undefined,
  lifecycleEvent: AgentHookLifecycleEvent | undefined,
  providerCanReopenTurn = true
): boolean {
  if (phase !== 'turn-ended') return true
  if (!providerCanReopenTurn) return true
  return lifecycleEvent !== 'tool-use-start' && lifecycleEvent !== 'tool-use-end'
}
