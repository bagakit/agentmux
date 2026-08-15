import type { AgentMuxRunState } from '@agentmux/core'

/**
 * 「这条排队的 steer 还会不会被送出去」——一个问题，一处判定。
 *
 * 为什么必须收成一个模块：这件事此前分两处各判一次——store 的 flush 闸门写
 * `processState !== 'running'` 就早退，composer 的角标写 `processState === 'running'` 才说
 * 「queued for delivery」。两处说的是同一件事，却是两份手抄；`AgentMuxRunState` 加第四个成员
 * 时，只改一处的那一半会静默漂移（本仓已记过 [read-key-and-write-key-must-be-one-decision]）。
 *
 * 但「会不会送出去」不是一个问题，是**两个**，它们在 pendingInteraction 上分岔：
 *
 *   - {@link steerQueueCanEverDrain}：这一份队列**将来还有没有机会**排空。答案只由 run 的存活
 *     决定。run 退了或被打断，flush 每次都在闸门上早退，而且**没有任何东西会再叫醒它**——这才是
 *     「永远送不出去」。角标的两档文案问的是这个。
 *   - {@link steerQueueCanDrainNow}：**此刻**能不能排。pendingInteraction 也会让 flush 早退，
 *     但 `respondInteraction` 在用户答完那一帧立刻再 flush 一次，所以那些条目是真的还在路上。
 *     把它并进上面那一问，角标就会对一条马上就送的消息说「never delivered」。
 *
 * 两问共用同一个 run 存活判据，差别只在 pendingInteraction 这一项——这正是它们必须放在一起、
 * 由下面那张穷举表统一供货的原因。
 */

/**
 * run 的存活 → 这份队列还有没有排空的机会。
 *
 * 写成 `Record<AgentMuxRunState, boolean>` 的穷举表而不是 `=== 'running'`：union 加一个成员时
 * 这张表少一格会让 tsc 变红，逼人回答「新状态下队列还能不能排」，而不是安静落进 `=== 'running'`
 * 的否定侧被当成「永远送不出去」。同一手法见 service-window-notice.ts 的
 * AGENT_VIABILITY_BY_PROCESS_STATE——那次的由来正是同一段映射在四处手抄。
 *
 * `interrupted` 与 `exited` 同为 false 不是「都算死了」：见 {@link steerEntryTargetsRun}，
 * 被打断的 run 恰恰是最可能被 Resume 的，而 Resume 起来的是**另一个 run**。此处的 false 说的是
 * 「这些条目不会再送进它们排队时对着的那个 run」，这句话对两者都成立。
 */
const QUEUE_DRAINABLE_BY_RUN_STATE: Record<AgentMuxRunState, boolean> = {
  running: true,
  exited: false,
  interrupted: false
}

/** 这份队列将来还有没有机会排空。只看 run 存活，不看此刻的闸门。 */
export function steerQueueCanEverDrain(processState: AgentMuxRunState): boolean {
  return QUEUE_DRAINABLE_BY_RUN_STATE[processState]
}

/**
 * 此刻能不能排。比 {@link steerQueueCanEverDrain} 多一个 pendingInteraction 闸门——那一档是
 * 「暂时挡住」，不是「永远送不出去」，所以它只出现在这一问里。
 */
export function steerQueueCanDrainNow(
  session: { processState: AgentMuxRunState; pendingInteraction?: unknown }
): boolean {
  return steerQueueCanEverDrain(session.processState) && !session.pendingInteraction
}

/**
 * 这条条目是不是对着**当前这个 run** 排的队。
 *
 * 这是本模块存在的真正理由，也是角标那两档文案能不能成立的前提。队列按 agentSessionId 存，而
 * agentSessionId 在 Resume 前后**不变**、runId 变（api.ts:812 的 recover 原地换 run.runId）。
 * 于是：run 被打断 → 角标如实说「送不出去了」 → 用户点 Resume → 同一个 agentSessionId 回到
 * running → applyEvent 那圈 flush 扫到这份没人清过的队列 → 把用户以为已经作废的话，投进一个
 * 全新的 run。
 *
 * 那正是 AgentComposer 明确拒绝提供「重发」按钮的理由（「不知道下一个 run 是不是同一个 Agent，
 * 静默重放一条过期的 steer 比什么都不说更糟」）——组件拒绝做的事，store 一直在自动做。
 *
 * 修法是给条目绑上它排队时对着的 runId，让「过期」成为一个可判定的事实，而不是靠某处记得清空。
 * 不在 Resume 时主动清队列：那是第二个记得清的地方，漏一条路就回到今天这个缺陷；判据留在
 * 消费点，任何一条通往 flush 的路都自动受它管。
 */
export function steerEntryTargetsRun(entry: { runId: string }, runId: string): boolean {
  return entry.runId === runId
}
