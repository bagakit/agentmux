import { AgentMuxError } from './errors.js'

/**
 * Agent 之间的消息账本。
 *
 * 今天 Agent 想让另一个 Agent 做事，只能靠人把内容复制过去，或往终端里注入文本——两者都没有
 * 作者身份、没有因果、没有回执，于是产品答不出一个基本问题：**这条消息到底怎么样了**。
 *
 * 这里只放事实与状态机，不含 IO：Message 一旦记下就不可变，Delivery 只能单向推进到合法终态。
 * 迟到事件、重复调用、错误的 Run 都失败关闭——那正是"诚实回答"的前提。
 */

/**
 * 投递状态。
 *
 * 证据等级决定了能推进到哪一档，这条边界不可退让：
 *   - ctxmux 接受输入、或 Provider 收下启动参数，**最多**证明 `delivered`；
 *   - Prompt 本身、以及模型对 Prompt 的服从，**都不能**证明 `accepted` 或 `replied`；
 *   - `accepted` / `replied` 需要 Hook、ACP、Provider 原生回执，或受管 Agent 显式调用 Core。
 *
 * 因此没有 reply 证据时，产品只能说 Delivered，绝不能写成"已回复"。
 */
export type AgentDeliveryState =
  | 'queued'
  | 'delivered'
  | 'accepted'
  | 'replied'
  | 'failed'
  // 等过了 deadline。与 cancelled 的区别在原因：一个是没等到，一个是不等了——
  // 混成 failed 就分不出该重试还是该放弃。
  | 'timed-out'
  | 'cancelled'

export type AgentDelivery = {
  readonly state: AgentDeliveryState
  /** 该状态发生的时刻，由调用方传入——这里不读时钟，以便离线单测。 */
  readonly at: number
}

/** 一条记下就不再改变的消息。 */
export type AgentMessage = {
  readonly messageId: string
  readonly authorAgentSessionId: string
  readonly body: string
  readonly createdAt: number
}

export type AgentThread = {
  readonly threadId: string
  readonly targetAgentSessionId: string
  readonly workspacePath: string
  /** 绑定一次操作，使同 id 的重试被识别为同一次，而不是又建一个 Thread。 */
  readonly operationId: string
  readonly messages: readonly AgentMessage[]
  readonly delivery: AgentDelivery
}

/** 每个状态允许推进到哪些状态。终态的集合为空——迟到事件不能复活一条已经结束的投递。 */
const NEXT: Readonly<Record<AgentDeliveryState, readonly AgentDeliveryState[]>> = {
  // 还没有结果的三档都可以被撤回；已投递之后才谈得上超时（没送到就谈不上等回音）。
  queued: ['delivered', 'failed', 'cancelled'],
  delivered: ['accepted', 'failed', 'timed-out', 'cancelled'],
  accepted: ['replied', 'failed', 'timed-out', 'cancelled'],
  // 四个终态：迟到的事件不能翻案。
  replied: [],
  failed: [],
  'timed-out': [],
  cancelled: []
}

export function advanceDelivery(
  current: AgentDelivery,
  next: AgentDeliveryState,
  at: number
): AgentDelivery {
  if (!NEXT[current.state].includes(next)) {
    throw new AgentMuxError(
      `Delivery cannot move from ${current.state} to ${next}.`,
      'AGENT_DELIVERY_STATE_INVALID'
    )
  }
  return Object.freeze({ state: next, at })
}

export function createThread(input: {
  threadId: string
  authorAgentSessionId: string
  targetAgentSessionId: string
  workspacePath: string
  body: string
  operationId: string
  createdAt: number
}): AgentThread {
  const message: AgentMessage = Object.freeze({
    messageId: `${input.threadId}:0`,
    authorAgentSessionId: input.authorAgentSessionId,
    body: input.body,
    createdAt: input.createdAt
  })
  return Object.freeze({
    threadId: input.threadId,
    targetAgentSessionId: input.targetAgentSessionId,
    workspacePath: input.workspacePath,
    operationId: input.operationId,
    messages: Object.freeze([message]),
    // 还没有任何送达证据。
    delivery: Object.freeze({ state: 'queued' as const, at: input.createdAt })
  })
}
