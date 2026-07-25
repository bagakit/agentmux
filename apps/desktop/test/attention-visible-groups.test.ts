import { describe, expect, it } from 'vitest'
import { visibleTabGroupsForState } from '../src/renderer/src/lib/visible-tab-groups.js'

// Guards the one input that decides whether a person gets interrupted.
//
// This seam had no test, and that is exactly where the bug lived: the hook collected tab groups from
// EVERY workspace's layout, while the window mounts one workspace at a time. A background workspace's
// active tab therefore read as "on screen", and the completion notification it should have raised was
// silently suppressed — the precise outcome the feature exists to prevent.
//
// Getting this wrong is silent in both directions, which is why it is pinned here rather than left to a
// reading of the hook: too broad suppresses real completions, too narrow interrupts someone mid-read.

function state(overrides: Partial<Parameters<typeof visibleTabGroupsForState>[0]> = {}) {
  return {
    mainSurface: 'workbench',
    activeWorkspaceId: 'ws-a',
    layouts: {
      'ws-a': { groups: [{ activeTabId: 'tab-a1' }, { activeTabId: 'tab-a2' }] },
      'ws-b': { groups: [{ activeTabId: 'tab-b1' }] }
    },
    ...overrides
  }
}

describe('visible tab groups', () => {
  it('takes only the rendered workspace, never every workspace ever visited', () => {
    // `layouts` accumulates a layout per visited workspace. Collecting them all is the bug: workspace B's
    // active tab would count as visible while the user is looking at workspace A.
    expect(visibleTabGroupsForState(state())).toEqual([
      { activeTabId: 'tab-a1' },
      { activeTabId: 'tab-a2' }
    ])
  })

  it('reports nothing on the Board, where no Session Region is mounted', () => {
    // The Board replaces the workbench entirely (App.tsx), so no Agent is on screen — treating the
    // active tabs as visible there suppressed notifications for work nobody could see.
    expect(visibleTabGroupsForState(state({ mainSurface: 'board' }))).toEqual([])
  })

  it('reports nothing when no workspace is selected', () => {
    expect(visibleTabGroupsForState(state({ activeWorkspaceId: null }))).toEqual([])
  })

  it('survives an un-hydrated store rather than throwing during startup', () => {
    expect(visibleTabGroupsForState({ mainSurface: 'workbench', activeWorkspaceId: 'ws-a' })).toEqual([])
    expect(visibleTabGroupsForState(state({ layouts: {} }))).toEqual([])
    // A layout with no groups yet is empty, not a crash.
    expect(visibleTabGroupsForState(state({ layouts: { 'ws-a': {} } }))).toEqual([])
  })

  it('does not leak a background workspace even when the active one has no groups', () => {
    // The failure mode this locks: falling back to "any layout" when the active layout is empty would
    // reintroduce the suppression bug through a different door.
    expect(visibleTabGroupsForState(state({
      layouts: { 'ws-a': { groups: [] }, 'ws-b': { groups: [{ activeTabId: 'tab-b1' }] } }
    }))).toEqual([])
  })
})
