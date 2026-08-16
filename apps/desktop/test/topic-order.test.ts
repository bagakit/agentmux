import { describe, expect, it } from 'vitest'
import { orderTopics, partitionPinned, reorderTopics } from '../src/renderer/src/lib/topic-order.js'

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

describe('置顶项提到前面（partitionPinned）', () => {
  it('未置顶那一段的相对次序原样保留——这是最重要的性质', () => {
    // 输入刻意用非字母序 c,a,b，这样"分区"与"排序"两种实现会给出不同结果：分区保留 c,a,b，
    // 而任何 .sort() 会重排成 a,b,c。置顶 x（提到最前），其余必须仍是 c,a,b 而不是 a,b,c。
    expect(partitionPinned(['c', 'a', 'b', 'x'], ['x'])).toEqual(['x', 'c', 'a', 'b'])
    // 无置顶时同样只是原样返回，绝不字母序化。
    expect(partitionPinned(['c', 'a', 'b'], [])).toEqual(['c', 'a', 'b'])
  })

  it('置顶段按 pinned 的次序，而不是它在输入里的次序', () => {
    // pinned 说先 t-4 再 t-1，尽管在 arrived 里 t-1 更靠前。
    expect(partitionPinned(arrived, ['t-4', 't-1'])).toEqual(['t-4', 't-1', 't-2', 't-3'])
  })

  it('pin 里有、输入里没有的 id 被丢掉，绝不凭空复活', () => {
    // t-9 已从磁盘消失（arrived 里没有），它的 pin 不该让它出现。
    expect(partitionPinned(arrived, ['t-9', 't-2'])).toEqual(['t-2', 't-1', 't-3', 't-4'])
  })

  it('空 pinned 时原样返回输入顺序', () => {
    expect(partitionPinned(arrived, [])).toEqual(arrived)
  })

  it('是纯函数：不改动传入的数组', () => {
    const source = [...arrived]
    const pinned = ['t-3']
    partitionPinned(source, pinned)
    expect(source).toEqual(arrived)
    expect(pinned).toEqual(['t-3'])
  })

  it('与 orderTopics 组合：置顶不吞掉用户的拖拽序', () => {
    // 用户把 t-4 拖到最前，再置顶 t-2。置顶段是 [t-2]，未置顶段必须保留拖拽序 t-4,t-1,t-3。
    const dragged = orderTopics(arrived, ['t-4'])
    expect(dragged).toEqual(['t-4', 't-1', 't-2', 't-3'])
    expect(partitionPinned(dragged, ['t-2'])).toEqual(['t-2', 't-4', 't-1', 't-3'])
  })
})
