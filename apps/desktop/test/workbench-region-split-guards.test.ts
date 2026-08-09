import { describe, expect, it } from 'vitest'
import {
  applyWorkbenchRegionLayoutPreset,
  closeWorkbenchRegion,
  createWorkbenchViewLayout,
  regionIds,
  setWorkbenchRegionSplitRatio,
  splitWorkbenchRegion,
  workbenchRegionBounds,
  type WorkbenchRegionLayoutNode,
  type WorkbenchViewLayout
} from '@agentmux/layout'

// 三格布局：one 在左半整列、two 右上、three 右下。root = [ one | (two / three) ]。
function threeRegions(): WorkbenchViewLayout {
  return splitWorkbenchRegion(
    splitWorkbenchRegion(createWorkbenchViewLayout('one'), 'one', 'right', 'two'),
    'two',
    'down',
    'three'
  )
}

describe('setWorkbenchRegionSplitRatio（#494 gap：此前零测试）', () => {
  it('把根 split 的 ratio 改到指定值', () => {
    const layout = splitWorkbenchRegion(createWorkbenchViewLayout('root'), 'root', 'right', 'added')
    const next = setWorkbenchRegionSplitRatio(layout, '', 0.7)
    expect(next.root.type === 'split' && next.root.ratio).toBe(0.7)
  })

  it('按 nodePath 深入到内层 split，只改那一个比例', () => {
    const next = setWorkbenchRegionSplitRatio(threeRegions(), 'second', 0.75)
    // 根（one 与右子树的分割）不动，仍是均分树 balanceNode 之外的原始 0.5。
    expect(next.root.type === 'split' && next.root.ratio).toBe(0.5)
    expect(
      next.root.type === 'split' && next.root.second.type === 'split' && next.root.second.ratio
    ).toBe(0.75)
  })

  it('比例被夹在 [0.15, 0.85]——模型存不下比视图 minSize 更极端的比例', () => {
    // 这是与 tab-group 树合并后的统一边界（此前 region 树是 0.1/0.9，落在视图弹不回的缝里）。
    const layout = splitWorkbenchRegion(createWorkbenchViewLayout('root'), 'root', 'right', 'added')
    expect(setWorkbenchRegionSplitRatio(layout, '', 0.02).root.type === 'split' &&
      (setWorkbenchRegionSplitRatio(layout, '', 0.02).root as Extract<WorkbenchRegionLayoutNode, { type: 'split' }>).ratio).toBe(0.15)
    const wide = setWorkbenchRegionSplitRatio(layout, '', 0.98).root
    expect(wide.type === 'split' && wide.ratio).toBe(0.85)
  })
})

describe('closeWorkbenchRegion（#494 gap：非活动分支从未被走过）', () => {
  it('关闭一个非活动格时，activeRegionId 原样不动', () => {
    // root = [ (a / b) | c ]，活动在 c。关掉 a（非活动，且它的兄弟 b ≠ 活动格 c）：焦点必须留在 c。
    // 这个「兄弟≠活动格」的构造是刻意的：若 else 分支被改成「无论关的是不是活动格都重算焦点」，
    // 关 a 会把焦点误移到它的兄弟 b，本条随即变红；而若兄弟恰好等于活动格，这种误改就检不出来。
    const layout: WorkbenchViewLayout = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'split', direction: 'vertical', first: { type: 'leaf', regionId: 'a' }, second: { type: 'leaf', regionId: 'b' }, ratio: 0.5 },
        second: { type: 'leaf', regionId: 'c' },
        ratio: 0.5
      },
      activeRegionId: 'c'
    }
    const closed = closeWorkbenchRegion(layout, 'a')
    expect(closed.activeRegionId).toBe('c')
    expect(regionIds(closed.root).sort()).toEqual(['b', 'c'])
  })

  it('关闭活动格后焦点落到一个仍在场的格（兄弟与读序末尾在此重合，判别交给下一条）', () => {
    // root = [ one | (two / three) ]，活动在 two。关掉 two：它的兄弟是 three。注意此树里 three 恰好
    // 也是读序末尾，故本条区分不开「兄弟」与「at(-1)」——那是下一条的活。这里只钉住活动格被关后
    // 焦点确实转移到了一个存活的格（回归 remainingRegionIds.at(-1)! 的旧行为在此仍绿）。
    const layout: WorkbenchViewLayout = { ...threeRegions(), activeRegionId: 'two' }
    const closed = closeWorkbenchRegion(layout, 'two')
    expect(closed.activeRegionId).toBe('three')
  })

  it('兄弟 ≠ 读序末尾时，焦点取兄弟——这一条把「兄弟」与「at(-1)」区分开', () => {
    // 构造 root = [ (a / b) | c ]：读序是 [a, b, c]，末尾是 c。活动在 a，关掉 a：a 的兄弟是 b。
    // 若实现取兄弟 → b；若退回旧的 remainingRegionIds.at(-1) → c。两者相异，本条钉死是 b。
    const layout: WorkbenchViewLayout = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'split', direction: 'vertical', first: { type: 'leaf', regionId: 'a' }, second: { type: 'leaf', regionId: 'b' }, ratio: 0.5 },
        second: { type: 'leaf', regionId: 'c' },
        ratio: 0.5
      },
      activeRegionId: 'a'
    }
    const closed = closeWorkbenchRegion(layout, 'a')
    expect(closed.activeRegionId).toBe('b')
    expect(regionIds(closed.root).sort()).toEqual(['b', 'c'])
  })
})

describe('applyWorkbenchRegionLayoutPreset grid-6（#494 gap：2×3 形状此前无断言）', () => {
  const gridSix = (): WorkbenchViewLayout =>
    applyWorkbenchRegionLayoutPreset(
      createWorkbenchViewLayout('root'),
      'grid-6',
      ['r1', 'r2', 'r3', 'r4', 'r5']
    )

  it('grid-6 = 2 行 × 3 列：读序前三格在第一行(y=0)、后三格在第二行(y=0.5)，每格宽 1/3 高 1/2', () => {
    // 只数「6 格、每格面积≈1/6」区分不了 2×3 / 3×2 / 1×6。用几何边界钉死：列数=3（每格宽 1/3）、
    // 行数=2（每格高 1/2）。这把 gridLayout(ids, 3) 里的列参数 3 改成 2（→宽 1/2）、6（→宽 1/6）、
    // 1（→宽 1）都排除。实现用 gridLayout(ids, columns=3) 逐行填 3 列，菜单称它 "2 × 3 Grid"。
    const bounds = workbenchRegionBounds(gridSix().root)
    expect(bounds.map((b) => b.regionId)).toEqual(['root', 'r1', 'r2', 'r3', 'r4', 'r5'])
    const rows = [
      [bounds[0]!, bounds[1]!, bounds[2]!],
      [bounds[3]!, bounds[4]!, bounds[5]!]
    ]
    rows.forEach((cells, rowIndex) => {
      const y = rowIndex / 2
      cells.forEach((cell, colIndex) => {
        expect(cell.bounds.width).toBeCloseTo(1 / 3)
        expect(cell.bounds.height).toBeCloseTo(1 / 2)
        expect(cell.bounds.x).toBeCloseTo(colIndex / 3)
        expect(cell.bounds.y).toBeCloseTo(y)
      })
    })
  })
})
