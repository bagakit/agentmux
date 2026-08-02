import { describe, expect, it } from 'vitest'
import {
  addTab,
  createWorkspaceLayout,
  findGroup,
  groupIds,
  moveTab,
  removeTab,
  setSplitRatio,
  moveTabToNewGroup
} from '../src/renderer/src/lib/workbench-layout'

describe('workspace tab-group layout', () => {
  it('adds and activates tabs in one group', () => {
    const layout = addTab(createWorkspaceLayout('group-1', ['agent:one']), 'group-1', 'file:a.ts')
    expect(findGroup(layout, 'group-1')).toMatchObject({
      tabOrder: ['agent:one', 'file:a.ts'],
      activeTabId: 'file:a.ts'
    })
    expect(layout.activeGroupId).toBe('group-1')
  })

  it.each([
    { direction: 'left', splitAxis: 'horizontal', newGroupSide: 'first' },
    { direction: 'right', splitAxis: 'horizontal', newGroupSide: 'second' },
    { direction: 'up', splitAxis: 'vertical', newGroupSide: 'first' },
    { direction: 'down', splitAxis: 'vertical', newGroupSide: 'second' }
  ] as const)(
    'moves a tab into a new $direction split group, landing it $splitAxis on the $newGroupSide side',
    ({ direction, splitAxis, newGroupSide }) => {
      const layout = moveTabToNewGroup(
        createWorkspaceLayout('group-1', ['agent:one', 'file:a.ts']),
        'file:a.ts',
        'group-1',
        'group-1',
        direction,
        'group-2'
      )
      // 方向的两半含义（哪根轴、哪一侧）都用写死的期望表逐档钉住，不从 direction 现算。
      //
      // 轴那一半此前写成 `direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical'`。
      // 那**不是**恒真的断言——它是测试侧的独立重抄，生产判定取反时它照旧报红（实测：把
      // `orientationOf` 的两个返回值对调，这条 4 红）。改成写死的期望表是因为独立重抄贵在别处：
      // 它把「正确答案是什么」这个判断藏进一个跟着入参走的表达式里，读的人得自己在脑内跑一遍才知道
      // `up` 该是哪根轴；而这四档的正确答案本来就只有四个字面量。真正会恒真的形状是期望值**由被测的
      // 那一份实现算出**（比如在这里调 `orientationOf(direction)`）——本仓
      // expected-value-must-not-derive-from-mutation-target 说的是那一种。
      //
      // 侧那一半此前完全没有断言。它比轴更需要钉：轴判错会立刻看出来（该左右分的变成上下分），而
      // 侧判反只是新格出现在反侧，看起来完全像一次正常分屏（本仓刚修过逐字同形的一颗：链接目的地
      // 那一行四个箭头同时反了）。
      expect(layout.root).toMatchObject({ type: 'split', direction: splitAxis })
      const root = layout.root
      if (root.type !== 'split') throw new Error('expected a split root')
      const newSide = newGroupSide === 'first' ? root.first : root.second
      const targetSide = newGroupSide === 'first' ? root.second : root.first
      expect(newSide).toMatchObject({ type: 'leaf', groupId: 'group-2' })
      expect(targetSide).toMatchObject({ type: 'leaf', groupId: 'group-1' })
      expect(findGroup(layout, 'group-1')?.tabOrder).toEqual(['agent:one'])
      expect(findGroup(layout, 'group-2')?.tabOrder).toEqual(['file:a.ts'])
      expect(layout.activeGroupId).toBe('group-2')
    }
  )

  it('rejects the same last-tab split no-op', () => {
    const initial = createWorkspaceLayout('group-1', ['agent:one'])
    expect(moveTabToNewGroup(initial, 'agent:one', 'group-1', 'group-1', 'right', 'group-2')).toBe(
      initial
    )
  })

  /**
   * 把一格里唯一的那张 tab，丢到**它已经所在的那一侧**，应当整体不动（`isSplitDropNoOp` 的第三条）。
   *
   * 语义要说清：`direction` 是「丢到 target 的哪一侧」。group-1 在左、group-2 在右时，把 group-2 那张
   * 唯一的 tab「丢到 group-1 的右边」——它本来就在 group-1 右边，所以什么都不该发生。
   *
   * 这道闸的判据同样是方向的两半（哪根轴、哪一侧），而它整条零覆盖：把侧判反后全套测试仍全绿（实测）。
   * 症状是"已经在右边了还往右拖"被当成真移动，拆出一个新组、把布局搅一遍，而用户什么也没想改。
   *
   * 注意不能拿 source === target 来测这条：那会先被第一条闸（同组且只剩一张）短路掉，根本走不到侧判。
   *
   * 四个方向各钉一次，并逐档给出**反侧**对照：只有"同侧才不动、反侧必须真移动"这一对同时成立，才说明
   * 闸判的是侧，而不是"凡是单 tab 拖动都不动"这种更粗的东西。
   */
  it.each([
    { drop: 'right', axis: 'right', already: 'group-2', other: 'group-1' },
    { drop: 'left', axis: 'right', already: 'group-1', other: 'group-2' },
    { drop: 'down', axis: 'down', already: 'group-2', other: 'group-1' },
    { drop: 'up', axis: 'down', already: 'group-1', other: 'group-2' }
  ] as const)(
    'treats dropping a lone tab $drop of the other group as a no-op when it already sits there',
    ({ drop, axis, already, other }) => {
      // 先按同一根轴分好两格：横轴用 right（group-1 在左、group-2 在右），纵轴用 down（1 上、2 下）。
      const split = moveTabToNewGroup(
        createWorkspaceLayout('group-1', ['agent:one', 'file:a.ts']),
        'file:a.ts',
        'group-1',
        'group-1',
        axis,
        'group-2'
      )
      // 前提自检：两格各只剩一张 tab，才轮得到 sourceTabCount === 1 这条闸。
      expect(findGroup(split, 'group-1')?.tabOrder).toHaveLength(1)
      expect(findGroup(split, 'group-2')?.tabOrder).toHaveLength(1)

      // 已经在 `drop` 那一侧的那一格：拖过去等于没动，整个 layout 引用不变。
      const alreadyTab = findGroup(split, already)!.tabOrder[0]!
      expect(moveTabToNewGroup(split, alreadyTab, already, other, drop, 'group-3')).toBe(split)

      // 反侧那一格：同一个方向、同样只剩一张，这次必须真的移动（否则闸太宽，把合法拖动也吞掉）。
      const otherTab = findGroup(split, other)!.tabOrder[0]!
      const moved = moveTabToNewGroup(split, otherTab, other, already, drop, 'group-3')
      expect(moved).not.toBe(split)
      expect(groupIds(moved.root)).toContain('group-3')
    }
  )

  it('moves a tab and collapses its empty source group', () => {
    const split = moveTabToNewGroup(
      createWorkspaceLayout('group-1', ['agent:one', 'file:a.ts']),
      'file:a.ts',
      'group-1',
      'group-1',
      'right',
      'group-2'
    )
    const moved = moveTab(split, 'file:a.ts', 'group-2', 'group-1', 1)
    expect(groupIds(moved.root)).toEqual(['group-1'])
    expect(findGroup(moved, 'group-1')?.tabOrder).toEqual(['agent:one', 'file:a.ts'])
  })

  it('collapses a secondary group when its final tab closes', () => {
    const split = moveTabToNewGroup(
      createWorkspaceLayout('group-1', ['agent:one', 'file:a.ts']),
      'file:a.ts',
      'group-1',
      'group-1',
      'down',
      'group-2'
    )
    const closed = removeTab(split, 'group-2', 'file:a.ts')
    expect(closed.root).toEqual({ type: 'leaf', groupId: 'group-1' })
  })

  it('clamps a root split ratio using node paths', () => {
    const split = moveTabToNewGroup(
      createWorkspaceLayout('group-1', ['agent:one', 'file:a.ts']),
      'file:a.ts',
      'group-1',
      'group-1',
      'right',
      'group-2'
    )
    expect(setSplitRatio(split, '', 0.02).root).toMatchObject({ ratio: 0.15 })
    expect(setSplitRatio(split, '', 0.98).root).toMatchObject({ ratio: 0.85 })
  })
})
