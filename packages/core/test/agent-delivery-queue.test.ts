import { describe, expect, it } from 'vitest'
import {
  ackDeliveryBatch,
  checkDeliveries,
  type DeliveryQueue
} from '../src/agent-delivery-queue.js'

// 消费一批投递的规则，全在这两个动作之间：
// check 给出最旧的一批；在显式 ack 之前，同一个 consumer 再 check 必须拿到**同一批**——
// 否则一次崩溃就会丢消息。ack 只推进这个 consumer 的游标，不改变消息本身的状态。

function queue(ids: string[]): DeliveryQueue {
  return { pending: ids, consumers: {} }
}

describe('check 给出最旧的一批', () => {
  it('按到达顺序给出，不超过批次上限', () => {
    const batch = checkDeliveries(queue(['d1', 'd2', 'd3']), 'c1', 2)
    expect(batch.deliveryIds).toEqual(['d1', 'd2'])
  })

  it('队列为空时给出空批次，而不是报错', () => {
    expect(checkDeliveries(queue([]), 'c1', 10).deliveryIds).toEqual([])
  })
})

describe('Ack 之前重复 check 必须重放同一批', () => {
  it('同一个 consumer 再 check 拿到完全相同的一批', () => {
    const q = queue(['d1', 'd2', 'd3'])
    const first = checkDeliveries(q, 'c1', 2)
    const again = checkDeliveries(first.queue, 'c1', 2)
    // 崩溃重连后必须还能拿到那一批，否则消息就丢了。
    expect(again.deliveryIds).toEqual(first.deliveryIds)
    expect(again.generation).toBe(first.generation)
  })

  it('批次大小变了也重放原批，不因为参数不同就换一批', () => {
    const q = queue(['d1', 'd2', 'd3'])
    const first = checkDeliveries(q, 'c1', 2)
    expect(checkDeliveries(first.queue, 'c1', 99).deliveryIds).toEqual(first.deliveryIds)
  })

  it('不同 consumer 各拿各的，互不影响', () => {
    const q = queue(['d1', 'd2'])
    const a = checkDeliveries(q, 'c1', 1)
    const b = checkDeliveries(a.queue, 'c2', 1)
    expect(b.deliveryIds).toEqual(['d1'])
  })
})

describe('Ack 之后不再重复', () => {
  it('ack 掉的那一批不再出现', () => {
    const q = queue(['d1', 'd2', 'd3'])
    const first = checkDeliveries(q, 'c1', 2)
    const acked = ackDeliveryBatch(first.queue, 'c1', first.generation)
    expect(checkDeliveries(acked, 'c1', 2).deliveryIds).toEqual(['d3'])
  })

  it('ack 只推进这个 consumer，别人照旧', () => {
    const q = queue(['d1', 'd2'])
    const a = checkDeliveries(q, 'c1', 2)
    const acked = ackDeliveryBatch(a.queue, 'c1', a.generation)
    // c2 从没消费过，它仍然从头看到全部。
    expect(checkDeliveries(acked, 'c2', 2).deliveryIds).toEqual(['d1', 'd2'])
  })
})

describe('generation fence：旧的确认不作数', () => {
  it('拿过期的 generation 去 ack 会失败关闭', () => {
    const q = queue(['d1', 'd2', 'd3'])
    const first = checkDeliveries(q, 'c1', 2)
    const acked = ackDeliveryBatch(first.queue, 'c1', first.generation)
    // 一个慢 consumer 带着旧 generation 回来——它确认的是一批已经翻篇的东西。
    expect(() => ackDeliveryBatch(acked, 'c1', first.generation))
      .toThrowError(expect.objectContaining({ code: 'AGENT_DELIVERY_GENERATION_STALE' }))
  })

  it('从没 check 过就 ack 会失败关闭', () => {
    expect(() => ackDeliveryBatch(queue(['d1']), 'c1', 1))
      .toThrowError(expect.objectContaining({ code: 'AGENT_DELIVERY_GENERATION_STALE' }))
  })
})

describe('纯函数', () => {
  it('check 与 ack 都不改动传入的队列', () => {
    const q = queue(['d1', 'd2'])
    const snapshot = JSON.stringify(q)
    const first = checkDeliveries(q, 'c1', 1)
    ackDeliveryBatch(first.queue, 'c1', first.generation)
    expect(JSON.stringify(q)).toBe(snapshot)
  })
})
