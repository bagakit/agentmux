import { describe, expect, it } from 'vitest'
import {
  handOff,
  openDispatch,
  recordDispatchEvent,
  type Dispatch
} from '../src/agent-handoff.js'

// Handoff 与 Dispatch 的区别只有一个，但它决定了谁在等：
//   - Handoff 是"交出去"——交完原 Owner 就不再等了，责任跟着工作一起走；
//   - Dispatch 是"派出去"——派完原 Owner 仍然担着责任，要接问题、接升级、接收工。
// 把两者混成一件事，就会出现"我以为你在管，你以为我交出去了"的悬空工作。

describe('Handoff：交出去就不再等', () => {
  const result = handOff({ fromAgentSessionId: 'a', toAgentSessionId: 'b', taskId: 't-1', at: 10 })

  it('所有权转移到接手方', () => {
    expect(result.ownerAgentSessionId).toBe('b')
  })

  it('原 Owner 不再等待——这正是它与 Dispatch 的分界', () => {
    expect(result.originAwaits).toBe(false)
  })
})

describe('Dispatch：派出去仍然担着', () => {
  const dispatch = openDispatch({
    dispatchId: 'd-1',
    ownerAgentSessionId: 'a',
    workerAgentSessionId: 'b',
    taskId: 't-1',
    attempt: 1,
    at: 10
  })

  it('所有权留在派发方', () => {
    expect(dispatch.ownerAgentSessionId).toBe('a')
    expect(dispatch.originAwaits).toBe(true)
  })

  it('显式绑定 Task 与 attempt——同一个 Task 重试一次是另一回事', () => {
    expect(dispatch.taskId).toBe('t-1')
    expect(dispatch.attempt).toBe(1)
  })

  it('四类事件都有稳定的 correlation id，能追回到这次派发', () => {
    let current: Dispatch = dispatch
    for (const kind of ['question', 'escalation', 'worker_done', 'cleanup'] as const) {
      current = recordDispatchEvent(current, kind, 20)
      const last = current.events.at(-1)!
      expect(last.kind).toBe(kind)
      // correlation id 由 dispatch + attempt + kind 派生，重放同一事件不会产生第二条。
      expect(last.correlationId).toContain('d-1')
      expect(last.correlationId).toContain('1')
    }
    expect(current.events).toHaveLength(4)
  })

  it('同一事件重放是幂等的，不会记两次', () => {
    const once = recordDispatchEvent(dispatch, 'question', 20)
    const twice = recordDispatchEvent(once, 'question', 30)
    expect(twice.events).toHaveLength(1)
    // 时刻保留第一次的：那才是问题真正提出的时候。
    expect(twice.events[0]!.at).toBe(20)
  })

  it('收工之后 Owner 才不再等', () => {
    const done = recordDispatchEvent(dispatch, 'worker_done', 30)
    expect(done.originAwaits).toBe(false)
    // 但所有权从未转移——是 Owner 在等一个结果，不是把活交出去了。
    expect(done.ownerAgentSessionId).toBe('a')
  })

  it('提问与升级不解除等待——那正是 Owner 该处理的事', () => {
    for (const kind of ['question', 'escalation'] as const) {
      expect(recordDispatchEvent(dispatch, kind, 30).originAwaits).toBe(true)
    }
  })
})

describe('纯函数', () => {
  it('不改动传入对象', () => {
    const d = openDispatch({
      dispatchId: 'd-2', ownerAgentSessionId: 'a', workerAgentSessionId: 'b',
      taskId: 't', attempt: 1, at: 1
    })
    const snapshot = JSON.stringify(d)
    recordDispatchEvent(d, 'question', 2)
    expect(JSON.stringify(d)).toBe(snapshot)
  })
})
