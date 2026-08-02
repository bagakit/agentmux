import { describe, expect, it } from 'vitest'
import { WORKBENCH_LAYOUT_PRESETS } from '@agentmux/core/workbench-layout-preset'
import { MIN_SPLIT_RATIO } from '../src/renderer/src/lib/split-tree'
import {
  applyWorkbenchRegionLayoutPreset,
  balanceWorkbenchRegionLayout,
  closeWorkbenchRegion,
  createWorkbenchViewLayout,
  placeActiveWorkbenchRegionFirst,
  regionIds,
  splitWorkbenchRegion,
  swapWorkbenchRegions,
  workbenchRegionBounds,
  workbenchRegionPresetSize,
  type WorkbenchRegionLayoutNode
} from '../src/renderer/src/lib/workbench-view-layout'

/** 树里每个 split 存着的 ratio，按前序。判「存进模型的值」而不是「画出来的宽度」。 */
function storedRatios(root: WorkbenchRegionLayoutNode): number[] {
  return root.type === 'leaf'
    ? []
    : [root.ratio, ...storedRatios(root.first), ...storedRatios(root.second)]
}

describe('Workbench Tab View layout', () => {
  it.each([
    ['left', 'horizontal', ['added', 'root']],
    ['right', 'horizontal', ['root', 'added']],
    ['up', 'vertical', ['added', 'root']],
    ['down', 'vertical', ['root', 'added']]
  ] as const)('splits one Tab Region %s without creating a Tab identity', (direction, axis, order) => {
    const layout = splitWorkbenchRegion(createWorkbenchViewLayout('root'), 'root', direction, 'added')

    expect(layout.root).toMatchObject({ type: 'split', direction: axis })
    expect(regionIds(layout.root)).toEqual(order)
    expect(layout.activeRegionId).toBe('added')
  })

  it('collapses only the requested Region and keeps the Tab View alive', () => {
    const split = splitWorkbenchRegion(createWorkbenchViewLayout('root'), 'root', 'right', 'added')

    expect(closeWorkbenchRegion(split, 'added')).toEqual(createWorkbenchViewLayout('root'))
    expect(closeWorkbenchRegion(createWorkbenchViewLayout('root'), 'root')).toEqual(
      createWorkbenchViewLayout('root')
    )
  })

  it('projects nested splits into normalized View bounds', () => {
    const leftRight = splitWorkbenchRegion(
      createWorkbenchViewLayout('left'),
      'left',
      'right',
      'right-top'
    )
    const threeRegions = splitWorkbenchRegion(leftRight, 'right-top', 'down', 'right-bottom')

    expect(workbenchRegionBounds(threeRegions.root)).toEqual([
      { regionId: 'left', bounds: { x: 0, y: 0, width: 0.5, height: 1 } },
      { regionId: 'right-top', bounds: { x: 0.5, y: 0, width: 0.5, height: 0.5 } },
      { regionId: 'right-bottom', bounds: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } }
    ])
  })

  it.each([
    ['columns-3', 3, [
      { x: 0, y: 0, width: 1 / 3, height: 1 },
      { x: 1 / 3, y: 0, width: 1 / 3, height: 1 },
      { x: 2 / 3, y: 0, width: 1 / 3, height: 1 }
    ]],
    ['grid-4', 4, [
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0.5, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
    ]],
    ['grid-6', 6, undefined],
    ['grid-9', 9, undefined]
  ] as const)('applies the fixed %s reading-order slots', (preset, size, expectedBounds) => {
    const added = Array.from({ length: size - 1 }, (_, index) => `added-${index + 1}`)
    const layout = applyWorkbenchRegionLayoutPreset(
      createWorkbenchViewLayout('root'),
      preset,
      added
    )
    const bounds = workbenchRegionBounds(layout.root)

    expect(bounds.map(({ regionId }) => regionId)).toEqual(['root', ...added])
    if (expectedBounds) {
      bounds.forEach(({ bounds }, index) => {
        const expected = expectedBounds[index]!
        expect(bounds.x).toBeCloseTo(expected.x)
        expect(bounds.y).toBeCloseTo(expected.y)
        expect(bounds.width).toBeCloseTo(expected.width)
        expect(bounds.height).toBeCloseTo(expected.height)
      })
    }
    else {
      expect(bounds).toHaveLength(size)
      expect(bounds.every(({ bounds }) => Math.abs(bounds.width * bounds.height - 1 / size) < 1e-12)).toBe(true)
    }
    expect(layout.activeRegionId).toBe('root')
  })

  it('rejects a preset that would discard Regions', () => {
    let layout = createWorkbenchViewLayout('one')
    for (const id of ['two', 'three', 'four']) {
      layout = splitWorkbenchRegion(layout, layout.activeRegionId, 'right', id)
    }
    expect(applyWorkbenchRegionLayoutPreset(layout, 'columns-3', [])).toBe(layout)
  })

  it('balances every split by its descendant leaf count', () => {
    const nested = splitWorkbenchRegion(
      splitWorkbenchRegion(createWorkbenchViewLayout('one'), 'one', 'right', 'two'),
      'two',
      'down',
      'three'
    )
    const balanced = balanceWorkbenchRegionLayout(nested)

    const bounds = workbenchRegionBounds(balanced.root)
    expect(bounds.map(({ regionId }) => regionId)).toEqual(['one', 'two', 'three'])
    expect(bounds[0]!.bounds.width).toBeCloseTo(1 / 3)
    expect(bounds[1]!.bounds.width).toBeCloseTo(2 / 3)
    expect(bounds[2]!.bounds.width).toBeCloseTo(2 / 3)
    expect(bounds[1]!.bounds.height).toBeCloseTo(0.5)
    expect(bounds[2]!.bounds.height).toBeCloseTo(0.5)
  })

  /**
   * #521：均分算出来的比例不得越过 `clampSplitRatio` 的界。
   *
   * 为什么上面那条 N=3 的用例守不住：`addWorkbenchRegion` 每次追加都挂在同一锚点上，N 格长成一条梳子，
   * 最外层 split 的两侧是 N-1 : 1。N=3 时配比 2/3 ≈ 0.667 稳稳在 [0.15, 0.85] 里，N=7 才第一次越界
   *（6/7 ≈ 0.857）。**判别器只在 N≥7 时在场**，所以下面每个规模都自带一条前提断言：若哪天骨架换成
   * 平衡二叉、这些规模再也算不出越界的原始比例，前提断言会红，明说「这条用例已不再守着任何东西」，
   * 而不是让它退化成恒真（本仓 property-unobservable-in-default-env 那一族）。
   */
  describe('#521 均分的比例不得越过 clampSplitRatio 的界', () => {
    const UPPER = 1 - MIN_SPLIT_RATIO

    /** 用真入口造 N 格：与 addWorkbenchRegion 一样连着同一个锚点开，长出那条梳子。 */
    function comb(size: number) {
      let layout = createWorkbenchViewLayout('r0')
      for (let index = 1; index < size; index += 1) {
        layout = splitWorkbenchRegion(layout, 'r0', 'right', `r${index}`)
      }
      return layout
    }

    it.each([7, 8, 9, 12])('N=%i：每个 split 的比例都落在界内', (size) => {
      const raw = comb(size)

      // 前提自检：这个规模的梳子在夹取之前**真的**算出越界的比例。没有这条，把 balanceNode 改回不夹
      // 也不会让本条发红——因为判别器可能压根不在场。
      // 梳子的形状：最外层两侧是 N-1 : 1，往里逐层递减，第 d 层配比 (N-1-d)/(N-d)。
      const unclamped = Array.from(
        { length: size - 1 },
        (_, depth) => (size - 1 - depth) / (size - depth)
      )
      expect(
        unclamped.some((ratio) => ratio > UPPER),
        `N=${size} 的梳子在夹取前算不出越界比例——本条已不再守着任何东西`
      ).toBe(true)

      const balanced = balanceWorkbenchRegionLayout(raw)
      for (const ratio of storedRatios(balanced.root)) {
        expect(ratio).toBeGreaterThanOrEqual(MIN_SPLIT_RATIO)
        expect(ratio).toBeLessThanOrEqual(UPPER)
      }
    })

    it('N=3 仍然是真正的叶子数配比，不被夹取改写', () => {
      // 夹取只能收界外的值。这条钉住它没有顺手把界内的正常配比也压平——若把 balanceNode 写成
      // 「一律 0.5」，上面那族界内断言全会通过，只有这条会红。N=3 的梳子最外层是 2 : 1。
      const balanced = balanceWorkbenchRegionLayout(comb(3))
      expect(storedRatios(balanced.root)[0]).toBeCloseTo(2 / 3)
    })
  })

  /**
   * #522：每档预设的几何都要有人断言，加一档新预设不得静默落到某个默认桶。
   *
   * 遍历 SSOT 元组而不是手抄档名清单：加一档就自动多一份覆盖。这同时是 `rowLayout`/`gridLayout`
   * 刻意不夹比例的那个前提的守卫——它们的 1/N 里 N 是每行列数或行数，理应天然在界内。
   *
   * 格数取自 `workbenchRegionPresetSize` 而不是再手抄一张表：那张表的取值已经由上面
   * 「applies the fixed %s reading-order slots」那族写死的字面量钉着，这里再抄一份只会多一处漂移面
   *（本仓 vitest-green-hides-type-drift-across-files）。本族问的是**几何**，不是格数。
   */
  describe('#522 每档预设的几何都被断言，且比例天然在界内', () => {
    it.each(WORKBENCH_LAYOUT_PRESETS)('%s：比例在界内、每格面积等于 1/N', (preset) => {
      const size = workbenchRegionPresetSize(preset)
      const added = Array.from({ length: size - 1 }, (_, index) => `added-${index + 1}`)
      const layout = applyWorkbenchRegionLayoutPreset(createWorkbenchViewLayout('root'), preset, added)

      const bounds = workbenchRegionBounds(layout.root)
      expect(bounds, `${preset} 没有产出 ${size} 格`).toHaveLength(size)
      for (const ratio of storedRatios(layout.root)) {
        expect(ratio).toBeGreaterThanOrEqual(MIN_SPLIT_RATIO)
        expect(ratio).toBeLessThanOrEqual(1 - MIN_SPLIT_RATIO)
      }
      for (const { bounds: box } of bounds) {
        expect(box.width * box.height).toBeCloseTo(1 / size)
      }
    })

    /**
     * 关键判据：每档预设铺**几列**。上面那族只问格数与面积，对列数完全失明——`grid-6` 若被排成
     * 2 列（3 行 × 2 列）而不是 3 列，格数还是 6、每格面积还是 1/6，上面全绿。
     *
     * 判据取每档「第一行有几格」，也就是最上面那一横排的格数：按 y 坐标取最小的那一批。这直接对应
     * `presetColumns` 的返回值，且是用户真正看见的东西。
     *
     * 注意 `columns-3` 与 grid 族**不**分开判：它的格数恰好等于列数，`gridLayout` 只排出一行，
     * 与专门的一行实现逐字段相等（这也是产品侧删掉那条分支的理由）。所以它在这里只是「3 列」的
     * 一个普通取值，不是另一种几何。
     */
    it.each([
      ['columns-3', 3],
      ['grid-4', 2],
      ['grid-6', 3],
      ['grid-9', 3]
    ] as const)('%s 铺 %i 列', (preset, columns) => {
      const size = workbenchRegionPresetSize(preset)
      const bounds = workbenchRegionBounds(
        applyWorkbenchRegionLayoutPreset(
          createWorkbenchViewLayout('root'),
          preset,
          Array.from({ length: size - 1 }, (_, index) => `added-${index + 1}`)
        ).root
      )
      const topY = Math.min(...bounds.map(({ bounds: box }) => box.y))
      const firstRow = bounds.filter(({ bounds: box }) => Math.abs(box.y - topY) < 1e-12)
      expect(firstRow, `${preset} 的第一行不是 ${columns} 格`).toHaveLength(columns)
      // 行数随之确定：格数 / 列数。这一条让「把某档的列数改小一半」既在列上红也在行上红。
      expect(new Set(bounds.map(({ bounds: box }) => box.y.toFixed(6))).size).toBe(size / columns)
    })
  })

  it('moves only the active Region identity to the first reading-order slot', () => {
    const layout = splitWorkbenchRegion(
      splitWorkbenchRegion(createWorkbenchViewLayout('one'), 'one', 'right', 'two'),
      'two',
      'down',
      'three'
    )

    const arranged = placeActiveWorkbenchRegionFirst(layout)
    expect(regionIds(arranged.root)).toEqual(['three', 'one', 'two'])
    expect(arranged.activeRegionId).toBe('three')
    expect(workbenchRegionBounds(arranged.root).map(({ bounds }) => bounds)).toEqual(
      workbenchRegionBounds(layout.root).map(({ bounds }) => bounds)
    )
  })

  // #471 swap: 交换两格在树里的位置（内容跟着 id 走），骨架与所有 ratio 一字不动。
  describe('swapWorkbenchRegions：两格在既有布局里互换位置', () => {
    const threeRegions = () =>
      splitWorkbenchRegion(
        splitWorkbenchRegion(createWorkbenchViewLayout('one'), 'one', 'right', 'two'),
        'two',
        'down',
        'three'
      )

    it('只对调两个 id 占的位置，骨架与每个 ratio 完全不变', () => {
      const layout = threeRegions()
      // one 在左半整列、two 在右上、three 在右下（见上一条几何断言）。换 one 与 three：
      // 内容互换位置，但每一格的**边界**必须与「原来占那个位置的格」一模一样——换的是 id 不是尺寸。
      const swapped = swapWorkbenchRegions(layout, 'one', 'three')
      expect(regionIds(swapped.root)).toEqual(['three', 'two', 'one'])
      const before = new Map(workbenchRegionBounds(layout.root).map(({ regionId, bounds }) => [regionId, bounds]))
      const after = workbenchRegionBounds(swapped.root)
      // three 现在占 one 原来的位置，one 现在占 three 原来的位置，two 原地不动。
      expect(after.find(({ regionId }) => regionId === 'three')!.bounds).toEqual(before.get('one'))
      expect(after.find(({ regionId }) => regionId === 'one')!.bounds).toEqual(before.get('three'))
      expect(after.find(({ regionId }) => regionId === 'two')!.bounds).toEqual(before.get('two'))
    })

    it('两个方向的参数顺序等价——swap(a,b) 与 swap(b,a) 结果相同', () => {
      const layout = threeRegions()
      expect(swapWorkbenchRegions(layout, 'one', 'three')).toEqual(
        swapWorkbenchRegions(layout, 'three', 'one')
      )
    })

    it('活动格跟着它的内容走：换的是活动格时 activeRegionId 不变', () => {
      // 活动在 three。把 three 换到别处，聚焦的仍然是 three 那份内容（现在在新位置）。
      const layout = { ...threeRegions(), activeRegionId: 'three' }
      const swapped = swapWorkbenchRegions(layout, 'three', 'one')
      expect(swapped.activeRegionId).toBe('three')
    })

    it('同一个 id 与自己换是 no-op（原样返回，避免无谓的重渲染）', () => {
      const layout = threeRegions()
      expect(swapWorkbenchRegions(layout, 'two', 'two')).toBe(layout)
    })

    it('任一 id 不在布局里就原样返回——不凭空造格、不把别的格换没', () => {
      const layout = threeRegions()
      expect(swapWorkbenchRegions(layout, 'one', 'ghost')).toBe(layout)
      expect(swapWorkbenchRegions(layout, 'ghost', 'one')).toBe(layout)
      expect(swapWorkbenchRegions(layout, 'ghostA', 'ghostB')).toBe(layout)
      // 不在场的 id 绝不能被写进树：换完后 region 集合必须与换前逐一相等。
      expect(new Set(regionIds(swapWorkbenchRegions(layout, 'one', 'ghost').root))).toEqual(
        new Set(regionIds(layout.root))
      )
    })
  })
})
