import { describe, expect, it } from 'vitest'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import {
  sessionVisibility,
  visibleSessionIds
} from '../src/renderer/src/lib/session-visibility.js'

// A tab holding one or more Regions, each projecting a session.
function tab(id: string, sessionIds: string[]): WorkbenchTab {
  const regions = Object.fromEntries(
    sessionIds.map((sessionId, index) => [
      `region-${index}`,
      { regionId: `region-${index}`, kind: 'agent', phase: 'attached', workspaceId: 'w', sessionId }
    ])
  )
  return {
    id,
    workspaceId: 'w',
    titleRegionId: 'region-0',
    layout: { activeRegionId: 'region-0' },
    regions
  } as unknown as WorkbenchTab
}

describe('session visibility', () => {
  it('counts every Region of an active tab, because a split shows both at once', () => {
    const visible = visibleSessionIds({
      tabs: { 'tab-1': tab('tab-1', ['a', 'b']) },
      tabGroups: [{ activeTabId: 'tab-1' }]
    })

    expect([...visible].sort()).toEqual(['a', 'b'])
  })

  it('does not count a projected Session sitting in a background tab', () => {
    // The distinction the whole module exists for: projected is not the same as on screen. Treating
    // every projected Session as visible would mean never notifying about anything.
    const visible = visibleSessionIds({
      tabs: { 'tab-1': tab('tab-1', ['front']), 'tab-2': tab('tab-2', ['behind']) },
      tabGroups: [{ activeTabId: 'tab-1' }]
    })

    expect([...visible]).toEqual(['front'])
  })

  it('counts the active tab of every tab group, since split panes are all on screen', () => {
    const visible = visibleSessionIds({
      tabs: {
        'tab-1': tab('tab-1', ['left']),
        'tab-2': tab('tab-2', ['right']),
        'tab-3': tab('tab-3', ['hidden'])
      },
      tabGroups: [{ activeTabId: 'tab-1' }, { activeTabId: 'tab-2' }]
    })

    expect([...visible].sort()).toEqual(['left', 'right'])
  })

  it('survives an un-hydrated store instead of throwing during startup', () => {
    expect(visibleSessionIds({ tabs: undefined, tabGroups: undefined }).size).toBe(0)
    expect(visibleSessionIds({ tabs: {}, tabGroups: [{ activeTabId: null }] }).size).toBe(0)
    // A group naming a tab that no longer exists is skipped rather than crashing.
    expect(visibleSessionIds({ tabs: {}, tabGroups: [{ activeTabId: 'missing' }] }).size).toBe(0)
  })

  it('keeps window focus and on-screen-ness separate', () => {
    // A focused window must still notify about a Session in a background tab: the user is looking at
    // something else in the same window, so the completion would otherwise go unseen.
    const visibility = sessionVisibility({
      windowFocused: true,
      visibleSessionIds: new Set(['front'])
    })

    expect(visibility('front')).toEqual({ windowFocused: true, sessionVisible: true })
    expect(visibility('behind')).toEqual({ windowFocused: true, sessionVisible: false })

    const away = sessionVisibility({ windowFocused: false, visibleSessionIds: new Set(['front']) })
    // Blurred window: even the on-screen Session is not being watched.
    expect(away('front')).toEqual({ windowFocused: false, sessionVisible: true })
  })
})
