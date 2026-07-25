import { describe, expect, it } from 'vitest'
import {
  advanceDelivery,
  createThread,
  type AgentDeliveryState
} from '../src/agent-message.js'

// 消息账本的两条硬约束：Message 不可变，Delivery 状态只能单向推进到合法终态。
// 迟到事件、重复调用、错误的 Run 都必须失败关闭——那正是"这条消息到底怎么样了"
// 能被诚实回答的前提。

describe('Thread 与首条 Message', () => {
  const thread = createThread({
    threadId: 'th-1',
    authorAgentSessionId: 'agent-a',
    targetAgentSessionId: 'agent-b',
    workspacePath: '/repo',
    body: 'please review the parser',
    operationId: 'op-1',
    createdAt: 1000
  })

  it('把 author 记成不可变事实', () => {
    expect(thread.messages[0]!.authorAgentSessionId).toBe('agent-a')
    expect(Object.isFrozen(thread.messages[0])).toBe(true)
  })

  it('首条 Message 起始于 queued——还没有任何送达证据', () => {
    expect(thread.delivery.state).toBe('queued')
  })

  it('绑定 operation id，使重试可被识别为同一次操作', () => {
    expect(thread.operationId).toBe('op-1')
  })

  it('整个 Thread 是冻结的，不能被就地改写', () => {
    expect(Object.isFrozen(thread)).toBe(true)
  })
})

describe('Delivery 只能单向推进', () => {
  const legal: Array<[AgentDeliveryState, AgentDeliveryState]> = [
    ['queued', 'delivered'],
    ['queued', 'failed'],
    ['delivered', 'accepted'],
    ['accepted', 'replied']
  ]

  it.each(legal)('%s 可以推进到 %s', (from, to) => {
    expect(advanceDelivery({ state: from, at: 1 }, to, 2).state).toBe(to)
  })

  it('终态不再变化——迟到事件不能复活一条已经结束的投递', () => {
    for (const terminal of ['failed', 'replied'] as const) {
      // 断言 typed code 而非文案：code 才是调用方能依赖的契约。
      expect(() => advanceDelivery({ state: terminal, at: 1 }, 'delivered', 2))
        .toThrowError(expect.objectContaining({ code: 'AGENT_DELIVERY_STATE_INVALID' }))
    }
  })

  it('不能倒退', () => {
    expect(() => advanceDelivery({ state: 'accepted', at: 1 }, 'delivered', 2)).toThrow()
    expect(() => advanceDelivery({ state: 'delivered', at: 1 }, 'queued', 2)).toThrow()
  })

  it('不能跳级：送达之前谈不上被接受', () => {
    // Prompt 交给了 Provider 最多证明 delivered；accepted 需要 Hook/ACP/显式 API 的证据。
    expect(() => advanceDelivery({ state: 'queued', at: 1 }, 'accepted', 2)).toThrow()
    expect(() => advanceDelivery({ state: 'queued', at: 1 }, 'replied', 2)).toThrow()
  })

  it('推进后保留发生时刻，且不改动传入对象', () => {
    const before = { state: 'queued' as const, at: 1 }
    const after = advanceDelivery(before, 'delivered', 42)
    expect(after.at).toBe(42)
    expect(before).toEqual({ state: 'queued', at: 1 })
  })
})

// P1 补齐两个终态。timed-out 与 cancelled 都是"这条消息不会有结果了"，但原因不同：
// 一个是等过了 deadline，一个是被显式撤回——混成一个 failed 就分不出该重试还是该放弃。
describe('P1：timed-out 与 cancelled', () => {
  it('等待中的投递可以超时', () => {
    expect(advanceDelivery({ state: 'delivered', at: 1 }, 'timed-out', 2).state).toBe('timed-out')
  })

  it('尚未有结果的投递可以被撤回', () => {
    for (const from of ['queued', 'delivered', 'accepted'] as const) {
      expect(advanceDelivery({ state: from, at: 1 }, 'cancelled', 2).state).toBe('cancelled')
    }
  })

  it('两者都是终态——超时之后迟到的回复不能翻案', () => {
    for (const terminal of ['timed-out', 'cancelled'] as const) {
      expect(() => advanceDelivery({ state: terminal, at: 1 }, 'replied', 2))
        .toThrowError(expect.objectContaining({ code: 'AGENT_DELIVERY_STATE_INVALID' }))
    }
  })

  it('已经回复过的不能再被撤回或超时', () => {
    expect(() => advanceDelivery({ state: 'replied', at: 1 }, 'cancelled', 2)).toThrow()
    expect(() => advanceDelivery({ state: 'replied', at: 1 }, 'timed-out', 2)).toThrow()
  })
})
