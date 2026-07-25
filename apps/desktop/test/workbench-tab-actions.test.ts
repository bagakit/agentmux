import { describe, expect, it } from 'vitest'
import {
  WORKBENCH_TAB_SPLIT_ACTIONS,
  tabIdsForCloseScope
} from '../src/renderer/src/lib/workbench-tab-actions'

describe('workbench tab context actions', () => {
  const tabs = ['one', 'two', 'three', 'four']

  it('selects close targets without including the context tab', () => {
    expect(tabIdsForCloseScope(tabs, 'three', 'others')).toEqual(['one', 'two', 'four'])
    expect(tabIdsForCloseScope(tabs, 'three', 'left')).toEqual(['one', 'two'])
    expect(tabIdsForCloseScope(tabs, 'three', 'right')).toEqual(['four'])
  })

  it('fails closed when the context tab is no longer in the pane', () => {
    expect(tabIdsForCloseScope(tabs, 'missing', 'others')).toEqual([])
    expect(tabIdsForCloseScope(tabs, 'missing', 'left')).toEqual([])
    expect(tabIdsForCloseScope(tabs, 'missing', 'right')).toEqual([])
  })

  it('keeps every direct split direction visible in one shared menu vocabulary', () => {
    expect(WORKBENCH_TAB_SPLIT_ACTIONS).toEqual([
      { direction: 'left', label: 'Split Left' },
      { direction: 'right', label: 'Split Right' },
      { direction: 'up', label: 'Split Up' },
      { direction: 'down', label: 'Split Down' }
    ])
  })
})
