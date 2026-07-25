import { AgentMuxError } from './errors.js'

/**
 * 一个问出去、还在等答案的问题。
 *
 * 它比一次投递多一件事：**答案本身**。因此有两条对称的规则——
 *   - 相同回答**幂等**：网络重试、Client 重连都会重放同一个答案，把它判成冲突只会
 *     逼调用方去猜自己是不是第一个；
 *   - 不同回答**冲突**：先到先得地悄悄覆盖，问的人就永远不知道对方改过口。
 *
 * 三个状态：`pending`（在等）、`answered`（有答案了）、`closed`（不会有答案了，
 * 因为超时或被取消）。后两个都是终态——迟到的答案不能翻案。
 */
export type AgentAskState = 'pending' | 'answered' | 'closed'

export type AgentAsk = {
  readonly askId: string
  /** 发问的那条消息。超时后按原 Message ID 恢复，不另起一个问题。 */
  readonly messageId: string
  readonly state: AgentAskState
  readonly answer: string | null
  readonly at: number
}

export function openAsk(input: { askId: string; messageId: string; at: number }): AgentAsk {
  return Object.freeze({
    askId: input.askId,
    messageId: input.messageId,
    state: 'pending' as const,
    answer: null,
    at: input.at
  })
}

export function answerAsk(ask: AgentAsk, answer: string, at: number): AgentAsk {
  if (ask.state === 'answered') {
    // 同一个答案：这是重放，返回原样——连时刻也保留第一次的，那才是答案真正到达的时候。
    if (ask.answer === answer) return ask
    throw new AgentMuxError(
      'This question already has a different answer.',
      'AGENT_ASK_ANSWER_CONFLICT'
    )
  }
  if (ask.state !== 'pending') {
    throw new AgentMuxError('This question is no longer open.', 'AGENT_ASK_STATE_INVALID')
  }
  return Object.freeze({ ...ask, state: 'answered' as const, answer, at })
}

function close(ask: AgentAsk, at: number): AgentAsk {
  // 关两次表达的是同一个意图，幂等而不是错误。
  if (ask.state === 'closed') return ask
  if (ask.state !== 'pending') {
    throw new AgentMuxError(
      'This question already has an answer.',
      'AGENT_ASK_STATE_INVALID'
    )
  }
  return Object.freeze({ ...ask, state: 'closed' as const, at })
}

/** 等过了 deadline。 */
export function timeOutAsk(ask: AgentAsk, at: number): AgentAsk {
  return close(ask, at)
}

/** 不等了。 */
export function cancelAsk(ask: AgentAsk, at: number): AgentAsk {
  return close(ask, at)
}
