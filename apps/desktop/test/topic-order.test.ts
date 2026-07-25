import { describe, expect, it } from 'vitest'
import { orderTopics, reorderTopics } from '../src/renderer/src/lib/topic-order.js'

// Topic 今天的顺序来自目录名的字典序（scratch-topics.ts:165），因为 topicId 由时间戳派生，
// 那约等于创建序——稳定，但用户改不了。拖拽要引入的是一份"用户意图"，而它必须和
// "文件系统随时可能多出一个新 Topic"这件事共存。

const arrived = ['t-1', 't-2', 't-3', 't-4']

describe('用户拖出来的顺序生效', () => {
  it('按用户顺序排列', () => {
    expect(orderTopics(arrived, ['t-3', 't-1'])).toEqual(['t-3', 't-1', 't-2', 't-4'])
  })

  it('没有用户顺序时保持原样——不做无谓的重排', () => {
    expect(orderTopics(arrived, [])).toEqual(arrived)
  })

  it('是纯函数：不改动传入的数组', () => {
    const source = [...arrived]
    const order = ['t-3']
    orderTopics(source, order)
    expect(source).toEqual(arrived)
    expect(order).toEqual(['t-3'])
  })
})

describe('和文件系统的变化共存', () => {
  it('未被排过的 Topic 仍按既有规则落在后面，不跳到不可预期的位置', () => {
    // t-2/t-4 从没被拖过，它们保持彼此的相对次序。
    expect(orderTopics(arrived, ['t-4'])).toEqual(['t-4', 't-1', 't-2', 't-3'])
  })

  it('新建的 Topic 不会因为不在用户顺序里就消失', () => {
    const withNew = [...arrived, 't-5']
    expect(orderTopics(withNew, ['t-2'])).toContain('t-5')
    expect(orderTopics(withNew, ['t-2'])).toHaveLength(5)
  })

  it('用户顺序里已被删除的 Topic 不会凭空出现', () => {
    // 排过 t-9，但它已从磁盘消失——顺序是意图，不是真相来源。
    expect(orderTopics(arrived, ['t-9', 't-2'])).toEqual(['t-2', 't-1', 't-3', 't-4'])
  })
})

describe('一次拖拽产生的新顺序', () => {
  it('把一个 Topic 拖到另一个之前', () => {
    expect(reorderTopics(arrived, 't-4', 't-2')).toEqual(['t-1', 't-4', 't-2', 't-3'])
  })

  it('往后拖时落在目标之后', () => {
    expect(reorderTopics(arrived, 't-1', 't-3')).toEqual(['t-2', 't-3', 't-1', 't-4'])
  })

  it('拖到自己身上不改变任何东西', () => {
    expect(reorderTopics(arrived, 't-2', 't-2')).toEqual(arrived)
  })

  it('拖一个不存在的 Topic 不改变任何东西', () => {
    expect(reorderTopics(arrived, 'ghost', 't-2')).toEqual(arrived)
  })
})
