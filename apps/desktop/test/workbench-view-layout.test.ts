import { describe, expect, it } from 'vitest'
import {
  closeWorkbenchRegion,
  createWorkbenchViewLayout,
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
})
