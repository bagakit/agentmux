/**
 * 退出原因分类：把「我们记录到的停止意图」与「内核观察到的退出结果」这两个**独立事实**合成一个诚实的
 * 分类。刻意做成纯函数、与真起进程解耦，可直接用构造的观测做行为测试。
 *
 * 为什么意图与结果必须分开记录（T-012 验收）：
 * - 「用户按了停止」是一条**意图**事实——由控制面在发起 stop 时记下（见 client 的 stopRequestedRuns）。
 * - 「进程以 code/signal 结束」是一条**结果**事实——由 ctxmux 的退出事件带来。
 *   把两者压成一个枚举会丢信息：一个被用户停掉、却恰好以 signal 死的 run，它的 signal 仍要作为结果保留，
 *   而「为什么结束」由意图回答。所以本函数只**派生**原因，调用方仍把原始 exitCode/exitSignal 并排带下去。
 */

/**
 * 一次 run 退出「为什么会这样」的诚实分类。刻意没有 `completed`：
 * 裸 exitCode 0 在没有停止意图佐证时**不足以**断言「干净完成」——它可能只是默认值、也可能是被杀后恰好报 0。
 * 读不出结论就如实归为 {@link unknown}，猜一个好听的比承认不知道更糟。
 */
export type AgentMuxRunExitReason =
  /** 控制面为这个 run 记录过停止意图——是我们关的。意图一旦在场就压过 code/signal：用户停掉的 run 即便
   *  以非零码或 signal 收场，「为什么」仍是「用户停止」，那个码只是停止的副作用（结果）。 */
  | 'user-stopped'
  /** 没有停止意图，且结果自带故障信号：带 signal，或非零 exitCode。它自己死的。 */
  | 'crashed'
  /** 没有停止意图，结果又是裸 0（或缺失）——无从判断是干净完成还是被无声杀掉。如实说未知。 */
  | 'unknown'

/**
 * 分类所需的两个事实。`stopRequested` 是意图（我们记的），`exitCode`/`exitSignal` 是结果（内核报的）。
 */
export type AgentMuxRunExitObservation = {
  /** 控制面是否为这个 run 记录过停止意图（用户发起过 stop）。 */
  stopRequested: boolean
  /** 内核观察到的退出码；缺失表示这条退出事件没带码。 */
  exitCode?: number
  /** 内核观察到的终止信号名；在场即视为故障信号（除非已有停止意图）。 */
  exitSignal?: string
}

/**
 * 把停止意图与观察到的退出结果合成一个诚实的原因。
 *
 * 顺序即优先级：意图在场 → user-stopped（结果的码/信号只作副作用保留，不改「为什么」）；否则有故障信号
 * （signal 或非零码）→ crashed；否则（裸 0 或无码，且无意图）→ unknown，绝不冒充「干净完成」。
 */
export function classifyRunExit(observation: AgentMuxRunExitObservation): AgentMuxRunExitReason {
  if (observation.stopRequested) return 'user-stopped'
  if (observation.exitSignal !== undefined) return 'crashed'
  if (observation.exitCode !== undefined && observation.exitCode !== 0) return 'crashed'
  return 'unknown'
}
