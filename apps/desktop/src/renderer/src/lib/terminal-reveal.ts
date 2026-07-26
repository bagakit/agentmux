import type { AgentMuxRunState } from '@agentmux/core'
import type { StepOutcome } from './service-window-notice'

/**
 * 揭示不得被我们自己的步骤无限期挡住（AGENTS.md 原则 11）。
 *
 * 隐藏终端画布的正当理由只有一个：把 replay 的历史重绘帧一次性写完，别让用户看见"终端自己在
 * resize"。那是一个**有终点**的理由。而恢复态此前只有两个出口——全链成功、attach 抛错——所以
 * "链上某处永不 settle"这一类落在了两者之间：ctxmux 活着、Run 活着、PTY 活着，界面却永久转圈。
 *
 * 这一层因此只回答两个判断：**该不该把画布交还用户**，以及**交还时要说什么**。两者都不在
 * useEffect 里做——本仓跑不了 effect，写在那儿的取舍没有断言够得着。第二个判断复用服务窗既有的
 * 分类器（`service-window-notice.ts`），不新建第二条失败通路。
 */

/**
 * 揭示的兜底时限。
 *
 * 这个值不是"replay 应该多快"的估计——正常路径由 replay 自己的完成来揭示，根本走不到这里。
 * 它回答的是另一个问题：**一次卡住要让用户盯着看多久才算过分**。取 6 秒：短到用户还没开始怀疑
 * 是不是自己电脑坏了，长到一次真实的大 scrollback 重放不会被误判成卡住。
 */
export const TERMINAL_REVEAL_DEADLINE_MS = 6_000

/**
 * 到点了没有。
 *
 * `revealed` 为真时一律不主张任何事：正常揭示已经发生，这个兜底不是第二个揭示者——否则一次正常
 * 但偏慢的恢复会在事后补一条"没走通"的告示，那是在给一件成功的事贴失败标签。
 */
export function terminalRevealDecision(input: {
  revealed: boolean
  startedAtMs: number
  nowMs: number
  deadlineMs: number
}): { reveal: boolean; overdue: boolean } {
  if (input.revealed) return { reveal: false, overdue: false }
  const overdue = input.nowMs - input.startedAtMs >= input.deadlineMs
  return { reveal: overdue, overdue }
}

/**
 * 强制揭示时把这一步映成服务窗认得的结局。
 *
 * 判据是**这个 Run 还能干活吗**，不是"我们的揭示步骤过了吗"：进程在跑就是第 2 类（放行 + 提醒，
 * 终端此刻确实可用），退了才是第 1 类（交给既有恢复横幅），既非在跑也非退出就如实说分不清。
 * 没到点则返回"走通了"——一次正常完成的恢复不该留下任何降级痕迹。
 */
export function terminalRevealServiceOutcome(input: {
  overdue: boolean
  processState: AgentMuxRunState
}): StepOutcome {
  if (!input.overdue) return { completed: true }
  const step = {
    label: 'Restoring this terminal',
    degradedMode: 'The terminal is usable now; its scrollback may be incomplete',
    restore: 'Reopen or resume this session to replay it again'
  }
  if (input.processState === 'running') return { completed: false, step, agentViability: 'alive' }
  if (input.processState === 'exited') return { completed: false, step, agentViability: 'dead' }
  return { completed: false, step, agentViability: 'unknown' }
}
