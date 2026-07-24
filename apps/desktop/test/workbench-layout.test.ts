import { describe, expect, it } from 'vitest'
import {
  addTab,
  createWorkspaceLayout,
  findGroup,
  groupIds,
  moveTab,
  removeTab,
  setSplitRatio,
  splitTab
} from '../src/renderer/src/lib/workbench-layout'

describe('Orca-style workspace tab-group layout', () => {
  it('adds and activates tabs in one group', () => {
    const layout = addTab(createWorkspaceLayout('group-1', ['agent:one']), 'group-1', 'file:a.ts')
    expect(findGroup(layout, 'group-1')).toMatchObject({
      tabOrder: ['agent:one', 'file:a.ts'],
      activeTabId: 'file:a.ts'
    })
    expect(layout.activeGroupId).toBe('group-1')
  })

  it.each(['left', 'right', 'up', 'down'] as const)(
    'moves a tab into a new %s split group',
    (direction) => {
      const layout = splitTab(
        createWorkspaceLayout('group-1', ['agent:one', 'file:a.ts']),
        'file:a.ts',
        'group-1',
        'group-1',
        direction,
        'group-2'
      )
      expect(layout.root).toMatchObject({
        type: 'split',
        direction: direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical'
      })
      expect(findGroup(layout, 'group-1')?.tabOrder).toEqual(['agent:one'])
      expect(findGroup(layout, 'group-2')?.tabOrder).toEqual(['file:a.ts'])
      expect(layout.activeGroupId).toBe('group-2')
    }
  )

  it('rejects the same last-tab split no-op', () => {
    const initial = createWorkspaceLayout('group-1', ['agent:one'])
    expect(splitTab(initial, 'agent:one', 'group-1', 'group-1', 'right', 'group-2')).toBe(
      initial
    )
  })

  it('moves a tab and collapses its empty source group', () => {
    const split = splitTab(
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
    const split = splitTab(
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

  it('clamps a root split ratio using Orca node paths', () => {
    const split = splitTab(
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
