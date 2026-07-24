import { describe, expect, it } from 'vitest'
import { tabIdsForCloseScope } from '../src/renderer/src/lib/workbench-tab-actions'

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
})
