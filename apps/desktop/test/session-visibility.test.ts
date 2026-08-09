import { describe, expect, it } from 'vitest'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/contracts.js'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { createWorkspaceLayout, type WorkspaceLayout } from '@agentmux/layout'
import {
  sessionVisibility,
  visibleSessionIds,
  visibleSessionIdsForState
} from '../src/renderer/src/lib/session-visibility.js'

// A tab holding one or more Regions, each projecting a session, in a given workspace.
function tab(id: string, sessionIds: string[], workspaceId = 'w'): WorkbenchTab {
  const regions = Object.fromEntries(
    sessionIds.map((sessionId, index) => [
      `region-${id}-${index}`,
      { regionId: `region-${id}-${index}`, kind: 'agent', phase: 'attached', workspaceId, sessionId }
    ])
  )
  return {
    id,
    workspaceId,
    topicId: undefined,
    titleRegionId: `region-${id}-0`,
    layout: { activeRegionId: `region-${id}-0` },
    regions
  } as unknown as WorkbenchTab
}

const ACTIVE = { activeWorkspaceId: 'w', workbenchVisible: true }

describe('session visibility', () => {
  it('counts every Region of the on-screen tab, because a split shows both at once', () => {
    const only = tab('tab-1', ['a', 'b'])
    const visible = visibleSessionIds({
      tabs: { 'tab-1': only },
      layouts: { w: createWorkspaceLayout('group', ['tab-1']) },
      ...ACTIVE
    })

    expect([...visible].sort()).toEqual(['a', 'b'])
  })

  it('does not count a projected Session sitting in a background tab', () => {
    // The distinction the whole module exists for: projected is not the same as on screen. Both tabs
    // live in the same group; only its active tab is on screen.
    const front = tab('tab-1', ['front'])
    const behind = tab('tab-2', ['behind'])
    const layout = createWorkspaceLayout('group', ['tab-1', 'tab-2']) // active tab is the first
    const visible = visibleSessionIds({
      tabs: { 'tab-1': front, 'tab-2': behind },
      layouts: { w: layout },
      ...ACTIVE
    })

    expect([...visible]).toEqual(['front'])
  })

  it('counts the active tab of every group, since split panes are all on screen', () => {
    const left = tab('tab-1', ['left'])
    const right = tab('tab-2', ['right'])
    const hidden = tab('tab-3', ['hidden'])
    // Two groups (a split); each shows its own active tab. tab-3 is a background tab in the left group.
    const layout: WorkspaceLayout = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'left' },
        second: { type: 'leaf', groupId: 'right' },
        ratio: 0.5
      },
      groups: [
        { id: 'left', tabOrder: ['tab-1', 'tab-3'], activeTabId: 'tab-1', recentTabIds: ['tab-1'] },
        { id: 'right', tabOrder: ['tab-2'], activeTabId: 'tab-2', recentTabIds: ['tab-2'] }
      ],
      activeGroupId: 'left'
    } as unknown as WorkspaceLayout
    const visible = visibleSessionIds({
      tabs: { 'tab-1': left, 'tab-2': right, 'tab-3': hidden },
      layouts: { w: layout },
      ...ACTIVE
    })

    expect([...visible].sort()).toEqual(['left', 'right'])
  })

  it('counts nothing in a background workspace, only the active one', () => {
    // `layouts` accumulates a layout per visited workspace. A tab whose workspace is not the active one
    // is off screen even though the store still projects it.
    const here = tab('tab-here', ['here'], 'w')
    const there = tab('tab-there', ['there'], 'other')
    const visible = visibleSessionIds({
      tabs: { 'tab-here': here, 'tab-there': there },
      layouts: {
        w: createWorkspaceLayout('group-w', ['tab-here']),
        other: createWorkspaceLayout('group-other', ['tab-there'])
      },
      ...ACTIVE
    })

    expect([...visible]).toEqual(['here'])
  })

  it('counts nothing when the workbench is not visible (a route covers the main area)', () => {
    const here = tab('tab-here', ['here'])
    const visible = visibleSessionIds({
      tabs: { 'tab-here': here },
      layouts: { w: createWorkspaceLayout('group', ['tab-here']) },
      activeWorkspaceId: 'w',
      workbenchVisible: false
    })

    expect(visible.size).toBe(0)
  })

  it('survives an un-hydrated store instead of throwing during startup', () => {
    expect(visibleSessionIds({ tabs: undefined, layouts: undefined, ...ACTIVE }).size).toBe(0)
    // A tab whose workspace has no layout yet is skipped rather than crashing.
    expect(visibleSessionIds({ tabs: { 'tab-1': tab('tab-1', ['a']) }, layouts: {}, ...ACTIVE }).size).toBe(0)
  })
})

describe('visibleSessionIdsForState', () => {
  it('is empty on the Board, where no Session Region is mounted', () => {
    // The Board replaces the workbench entirely (App.tsx), so treating tabs as on screen there would
    // suppress notifications for work nobody could see.
    const here = tab('tab-here', ['here'])
    const state = {
      mainSurface: 'board',
      activeWorkspaceId: 'w',
      tabs: { 'tab-here': here },
      layouts: { w: createWorkspaceLayout('group', ['tab-here']) }
    }
    expect(visibleSessionIdsForState(state).size).toBe(0)
    // Same tabs, but on the workbench: now the active tab's Session is on screen.
    expect([...visibleSessionIdsForState({ ...state, mainSurface: 'workbench' })]).toEqual(['here'])
  })

  it('an Agent behind another Scratch Topic is off screen; the one in the active Topic is on screen', () => {
    // The defect in miniature at the state level: two Topics share one Scratch layout, split into two
    // groups whose STORED active tabs belong to different Topics. The focused group decides the current
    // Topic, and only that Topic's Agent is on screen. A raw read of `layouts[ws].groups` would have
    // counted BOTH stored-active tabs as on screen and suppressed the hidden one's completion.
    const shown = { ...tab('shown', ['shown'], SCRATCH_WORKSPACE_ID), topicId: 'view:a' }
    const hidden = { ...tab('hidden', ['hidden'], SCRATCH_WORKSPACE_ID), topicId: 'view:b' }
    const layout: WorkspaceLayout = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'left' },
        second: { type: 'leaf', groupId: 'right' },
        ratio: 0.5
      },
      groups: [
        { id: 'left', tabOrder: ['shown'], activeTabId: 'shown', recentTabIds: ['shown'] },
        { id: 'right', tabOrder: ['hidden'], activeTabId: 'hidden', recentTabIds: ['hidden'] }
      ],
      activeGroupId: 'left'
    } as unknown as WorkspaceLayout
    const state = {
      mainSurface: 'workbench',
      activeWorkspaceId: SCRATCH_WORKSPACE_ID,
      tabs: { shown, hidden },
      layouts: { [SCRATCH_WORKSPACE_ID]: layout }
    }

    const onScreen = visibleSessionIdsForState(state)
    expect([...onScreen]).toEqual(['shown'])
    expect(onScreen.has('hidden'), '隐藏 Topic 的 Agent 被判成在屏——投影没生效').toBe(false)
  })
})

describe('sessionVisibility', () => {
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
