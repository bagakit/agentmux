import { describe, expect, it } from 'vitest'
import {
  applyWorkbenchRegionLayoutPreset,
  balanceWorkbenchRegionLayout,
  closeWorkbenchRegion,
  createWorkbenchViewLayout,
  placeActiveWorkbenchRegionFirst,
  regionIds,
  splitWorkbenchRegion,
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
})
