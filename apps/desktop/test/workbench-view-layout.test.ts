import { describe, expect, it } from 'vitest'
import {
  applyWorkbenchRegionLayoutPreset,
  balanceWorkbenchRegionLayout,
  closeWorkbenchRegion,
  createWorkbenchViewLayout,
  placeActiveWorkbenchRegionFirst,
  regionIds,
  splitWorkbenchRegion,
  swapWorkbenchRegions,
  workbenchRegionBounds
} from '../src/renderer/src/lib/workbench-view-layout'

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
