import { describe, expect, it, vi } from 'vitest'
import type { AgentDisplayState, AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/contracts.js'
import { createAttentionNotifier } from '../src/renderer/src/lib/attention-notifier.js'
import { visibleSessionIdsForState } from '../src/renderer/src/lib/session-visibility.js'
import { activeTopicIdFromLayout } from '../src/renderer/src/lib/scratch-topic-layout.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import type { WorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'

// The DEFECT this file closes: "is this Session on screen right now" was answered by two independently
// written predicate families that had diverged. The recyclers went through `surfaceNavigationVisibility`
// (Topic-aware), while the attention path read `layouts[ws].groups` RAW (Topic-blind). On a Scratch
// workspace the stored `activeTabId` is never Topic-rewritten (`layoutForActiveTopic` is a read-only
// projection), so a group whose STORED active Tab is an Agent living in a hidden Topic read as "on
// screen" to the notifier — and that Agent's completion was silently swallowed. In an app whose job is
// supervising many Agents, a lost completion is exactly the failure the feature exists to prevent.
//
// These tests exercise the SEAM the hook actually runs — `visibleSessionIdsForState(state)` piped into
// `createAttentionNotifier().reconcile()`, exactly as `useAgentAttentionNotifications.ts` composes them.
// A test of the on-screen function alone would not close the defect (the known `row-attention.test.ts`
// trap: a comment claims it guards the wiring while it only re-tests the pure function). The structural
// guard in `attention-visibility-authority.test.ts`, plus this composed seam, together pin the wiring.
//
// This is deliberately NOT a `renderToStaticMarkup` render: that runs no `useEffect`, and zustand under
// SSR renders its INITIAL state, so a `setState` would be invisible to the markup and the notifier
// (which lives in an effect) would never run. The hook body's composition is reproduced here against the
// real notifier and the real authority instead.

function agent(id: string, state: AgentDisplayState): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: `Agent ${id}`,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  } as unknown as SessionSnapshot
}

// A Scratch agent Tab bound to a Topic. Session id == tab id so the assertions read plainly.
function topicAgentTab(id: string, topicId: string): WorkbenchTab {
  return {
    ...createWorkbenchTab(id, {
      regionId: `region:${id}`,
      kind: 'agent',
      phase: 'attached',
      workspaceId: SCRATCH_WORKSPACE_ID,
      sessionId: id
    }),
    topicId
  }
}

const shownTab = topicAgentTab('shown', 'view:topic-a')
const hiddenTab = topicAgentTab('hidden', 'view:topic-b')
const TABS = { [shownTab.id]: shownTab, [hiddenTab.id]: hiddenTab }

// Two Topics on the ONE Scratch workspace, laid out as a two-group split. Each group's STORED active Tab
// belongs to a different Topic — this is the shape that makes the raw-vs-projected divergence
// observable: a single-group fixture cannot show it, because there the group's one active Tab is the
// same under both readings (see surface-navigation-visibility.test.ts:125 for the same reasoning).
//
// `focusedGroupId` decides the current Topic: `activeTopicIdFromLayout` reads the FOCUSED group's active
// Tab. So focusing `left` puts Topic A on screen (Agent `hidden` is behind another Topic); focusing
// `right` puts Topic B on screen (Agent `hidden` is what the user is looking at). Same tabs, same
// groups — only which group is focused changes, i.e. literally "the same Agent, hidden Topic vs visible
// Topic".
function scratchLayout(focusedGroupId: 'left' | 'right'): WorkspaceLayout {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'left' },
      second: { type: 'leaf', groupId: 'right' },
      ratio: 0.5
    },
    groups: [
      { id: 'left', tabOrder: [shownTab.id], activeTabId: shownTab.id, recentTabIds: [shownTab.id] },
      { id: 'right', tabOrder: [hiddenTab.id], activeTabId: hiddenTab.id, recentTabIds: [hiddenTab.id] }
    ],
    activeGroupId: focusedGroupId
  } as unknown as WorkspaceLayout
}

function scratchState(focusedGroupId: 'left' | 'right') {
  return {
    mainSurface: 'workbench',
    activeWorkspaceId: SCRATCH_WORKSPACE_ID,
    tabs: TABS,
    layouts: { [SCRATCH_WORKSPACE_ID]: scratchLayout(focusedGroupId) }
  }
}

function ports() {
  return {
    notify: vi.fn(async () => ({ status: 'shown' as const, presentation: 'as-requested' as const })),
    onUnsupported: vi.fn(),
    onDowngraded: vi.fn()
  }
}

describe('an Agent finishing behind another Scratch Topic', () => {
  it('notifies: the hidden-Topic Agent is off screen, so its completion is announced', async () => {
    // The user is looking at Topic A (left group focused). The Agent living in Topic B is behind it, off
    // screen. When it reaches `done`, the notification MUST fire — this is the completion that was lost.
    const state = scratchState('left')

    // Pre-condition self-check: the current Topic must really be A, and the authority must place the
    // hidden-Topic Agent OFF screen while the shown one is ON. If both were visible (or both hidden) the
    // direction below could not tell the fix from the bug and would pass for the wrong reason.
    expect(
      activeTopicIdFromLayout(state.layouts[SCRATCH_WORKSPACE_ID]!, TABS),
      '当前 Topic 没解析成 A，这批输入观察不到隐藏 Topic 的场景'
    ).toBe('view:topic-a')
    const onScreen = visibleSessionIdsForState(state)
    expect(onScreen.has('hidden'), '隐藏 Topic 的 Agent 被判成在屏——投影没生效，这条测不出缺陷').toBe(false)
    expect(onScreen.has('shown'), '当前 Topic 的 Agent 该在屏，fixture 立错了').toBe(true)

    const io = ports()
    const notifier = createAttentionNotifier(io)
    // Seed while still working, so the transition to done is a real transition, not first-sight.
    notifier.seed([agent('hidden', 'working'), agent('shown', 'working')])

    // The window has focus and the user is watching Topic A. The hidden-Topic Agent finishes.
    await notifier.reconcile({
      sessions: [agent('hidden', 'done'), agent('shown', 'working')],
      windowFocused: true,
      visibleSessionIds: visibleSessionIdsForState(state),
      mode: 'standard',
      timelines: {} as Record<string, AgentTimelineSnapshot>
    })

    expect(
      io.notify,
      '隐藏 Topic 的 Agent 完成了却没有通知——这正是被吞掉的那条完成'
    ).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'hidden', title: 'Agent finished' }))
  })

  it('stays quiet: the SAME Agent, now the visible Topic, is on screen — a notification would be noise', async () => {
    // Opposite direction (guarding one side is a documented false-green here): focus the right group, so
    // Topic B is on screen. Now the Agent in Topic B is what the user is looking at, so its completion
    // must NOT notify.
    const state = scratchState('right')

    expect(
      activeTopicIdFromLayout(state.layouts[SCRATCH_WORKSPACE_ID]!, TABS),
      '当前 Topic 没解析成 B，这条方向立错了'
    ).toBe('view:topic-b')
    const onScreen = visibleSessionIdsForState(state)
    expect(onScreen.has('hidden'), '当前 Topic 的 Agent 被判成隐藏——投影把在屏的也切走了').toBe(true)

    const io = ports()
    const notifier = createAttentionNotifier(io)
    notifier.seed([agent('hidden', 'working'), agent('shown', 'working')])

    await notifier.reconcile({
      sessions: [agent('hidden', 'done'), agent('shown', 'working')],
      windowFocused: true,
      visibleSessionIds: visibleSessionIdsForState(state),
      mode: 'standard',
      timelines: {} as Record<string, AgentTimelineSnapshot>
    })

    expect(
      io.notify,
      '用户正看着的 Agent 完成时还通知了——这是噪声，正是可见性判定要挡掉的'
    ).not.toHaveBeenCalled()
  })
})
