/**
 * 掉线后的有界重连计划——纯函数，因为「界」本身就是要被断言的东西：把它埋进一个 setTimeout 循环里，
 * 「到底重试几次、退没退避、什么时候放弃」就没人够得着，而这条正是本任务要求能被守卫咬住的判据
 * （「把它改成无限重试 → 必须红」）。
 *
 * 不加配置层（原则：选一个写死的合理策略）。指数退避、封顶、有限次数：
 * - 第 n 次尝试（从 0 起）等 `min(BASE * 2^n, MAX)` 毫秒。
 * - 尝试满 {@link RECONNECT_MAX_ATTEMPTS} 次仍失败即放弃（give-up）——不无限重试打爆 daemon。
 *
 * 放弃不是静默的：调用方在 give-up 时必须发一条响亮的失败（见 client 的 reconnect 循环），把用户
 * 留在「连不上、请手动处理」而不是「无声地永远在转圈」。
 */

const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 30_000
/** 写死的重试上限。改成 Infinity/极大值 = 无界重试，守卫据此变红。 */
export const RECONNECT_MAX_ATTEMPTS = 6

export type ReconnectStep =
  | { kind: 'retry'; attempt: number; delayMs: number }
  | { kind: 'give-up'; attempts: number }

/**
 * 给「已经失败过 `priorAttempts` 次」算下一步。`priorAttempts` 从 0 起（0 = 还没试过，排第一次）。
 *
 * 到达上限即 give-up，绝不再排 retry——这就是「界」。delay 单调不减直到封顶。
 */
export function nextReconnectStep(priorAttempts: number): ReconnectStep {
  if (priorAttempts >= RECONNECT_MAX_ATTEMPTS) {
    return { kind: 'give-up', attempts: priorAttempts }
  }
  const delayMs = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** priorAttempts,
    RECONNECT_MAX_DELAY_MS
  )
  return { kind: 'retry', attempt: priorAttempts, delayMs }
}

export type BoundedReconnectResult =
  | { kind: 'reconnected'; attempts: number }
  | { kind: 'exhausted'; attempts: number }

/**
 * 有界重连循环：按 {@link nextReconnectStep} 排点，等待、尝试，成功即返回，到上限即放弃。
 *
 * 把循环从 client 里拎出来做成注入式，是为了让「界」端到端可被断言而不依赖真 daemon 与真时序：
 * - `attempt` 抛错 = 这一次没连上；返回（或 resolve）= 连上了。
 * - `sleep` 由调用方提供（测试注入即时版），本函数不碰真定时器。
 *
 * 关键不变量（守卫咬这两条）：
 * 1. `attempt` 一直失败时，尝试次数恰好 {@link RECONNECT_MAX_ATTEMPTS} 次后返回 `exhausted`——
 *    绝不无限重试。把 give-up 分支删掉/改成永远 retry，这里就会无限循环，测试超时即红。
 * 2. `attempt` 第 k 次成功时立即返回 `reconnected`，不再多试。
 */
export async function runBoundedReconnect(deps: {
  attempt: () => Promise<void>
  sleep: (ms: number) => Promise<void>
}): Promise<BoundedReconnectResult> {
  let priorAttempts = 0
  while (true) {
    const step = nextReconnectStep(priorAttempts)
    if (step.kind === 'give-up') return { kind: 'exhausted', attempts: step.attempts }
    await deps.sleep(step.delayMs)
    try {
      await deps.attempt()
      return { kind: 'reconnected', attempts: step.attempt + 1 }
    } catch {
      priorAttempts += 1
    }
  }
}
