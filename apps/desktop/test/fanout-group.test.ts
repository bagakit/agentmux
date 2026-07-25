import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import {
  fanOutGroups,
  groupLaneNeedingYou,
  groupProgress
} from '../src/renderer/src/lib/fanout-group.js'
import { FanOutStrip } from '../src/renderer/src/components/FanOutStrip.js'

function worktree(branch: string, id = `ws-${branch}`): WorkspaceRecord {
  return {
    id,
    name: branch,
    hostId: 'local',
    path: `/repo/.worktrees/${branch}`,
    kind: 'worktree',
    repoPath: '/repo',
    branch
  }
}

function agent(branch: string, state: AgentDisplayState, observedAt = 1): SessionSnapshot {
  return {
    id: `session-${branch}`,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      hookEvents: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      acp: false,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: `/repo/.worktrees/${branch}`,
    label: `Agent ${branch}`,
    createdAt: 1,
    updatedAt: observedAt,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: `session-${branch}`, run: { runId: `run-${branch}` } }
  } as unknown as SessionSnapshot
}

describe('fan-out group projection', () => {
  it('recovers a bake-off from the branch names a fan-out plan produced', () => {
    // The plan names lanes <stem>-1, <stem>-2, … so the stem already identifies the set. Deriving it
    // avoids widening the strict workspace schema and maintaining a second registry for information the
    // branch names already carry.
    const groups = fanOutGroups({
      workspaces: [worktree('retry-1'), worktree('retry-2'), worktree('retry-3')],
      sessions: [agent('retry-1', 'working'), agent('retry-2', 'done'), agent('retry-3', 'waiting')]
    })

    expect(groups).toHaveLength(1)
    expect(groups[0]!.stem).toBe('retry')
    expect(groups[0]!.lanes.map((lane) => lane.branch)).toEqual(['retry-1', 'retry-2', 'retry-3'])
  })

  it('orders lanes by ordinal, not by however the workspaces happen to be listed', () => {
    const groups = fanOutGroups({
      workspaces: [worktree('retry-3'), worktree('retry-10'), worktree('retry-1')],
      sessions: []
    })

    // Numeric order, so 10 comes after 3 rather than sorting as a string.
    expect(groups[0]!.lanes.map((lane) => lane.branch)).toEqual(['retry-1', 'retry-3', 'retry-10'])
  })

  it('does not present a single branch as a one-lane bake-off', () => {
    // Otherwise every ordinary `foo-1` branch would show up as a comparison.
    expect(fanOutGroups({ workspaces: [worktree('retry-1')], sessions: [] })).toEqual([])
  })

  it('ignores branches that are not lane-shaped, and non-worktree workspaces', () => {
    const folder: WorkspaceRecord = {
      id: 'ws-main', name: 'repo', hostId: 'local', path: '/repo', kind: 'folder'
    }
    const groups = fanOutGroups({
      workspaces: [folder, worktree('main'), worktree('feature/login'), worktree('retry-1'), worktree('retry-2')],
      sessions: []
    })

    expect(groups.map((group) => group.stem)).toEqual(['retry'])
  })

  it('binds each lane to the Agent running in its worktree', () => {
    const groups = fanOutGroups({
      workspaces: [worktree('a-1'), worktree('a-2')],
      sessions: [agent('a-2', 'waiting')]
    })

    const [first, second] = groups[0]!.lanes
    // A lane whose Agent never launched still belongs to the set; dropping it would make the group look
    // smaller than it is.
    expect(first!.session).toBeNull()
    expect(first!.attention).toBeNull()
    expect(second!.session?.id).toBe('session-a-2')
    expect(second!.attention).toBe('needs-you')
  })

  it('points at the lane that most wants the user, longest wait first', () => {
    const groups = fanOutGroups({
      workspaces: [worktree('x-1'), worktree('x-2'), worktree('x-3')],
      sessions: [
        agent('x-1', 'error', 100),
        agent('x-2', 'waiting', 900),
        agent('x-3', 'blocked', 300)
      ]
    })

    // needs-you outranks error; inside that class the earliest observedAt wins, matching the attention
    // bar's "jump to the one waiting longest" so a group and the bar never disagree.
    expect(groupLaneNeedingYou(groups[0]!)?.branch).toBe('x-3')
  })

  it('treats a finished lane as a result to read, not an interruption', () => {
    const groups = fanOutGroups({
      workspaces: [worktree('y-1'), worktree('y-2')],
      sessions: [agent('y-1', 'done'), agent('y-2', 'done')]
    })

    expect(groupLaneNeedingYou(groups[0]!)).toBeNull()
  })

  it('summarises progress including lanes whose Agent never started', () => {
    const groups = fanOutGroups({
      workspaces: [worktree('z-1'), worktree('z-2'), worktree('z-3'), worktree('z-4'), worktree('z-5')],
      sessions: [
        agent('z-1', 'done'),
        agent('z-2', 'waiting'),
        agent('z-3', 'error'),
        agent('z-4', 'working')
      ]
    })

    // z-5 has no session: it is a worktree a lane left behind, and it counts.
    expect(groupProgress(groups[0]!)).toEqual({
      total: 5, done: 1, needsYou: 1, error: 1, working: 1, idle: 1
    })
  })

  it('keeps group order stable so the view does not reshuffle between renders', () => {
    const groups = fanOutGroups({
      workspaces: [worktree('zeta-1'), worktree('zeta-2'), worktree('alpha-1'), worktree('alpha-2')],
      sessions: []
    })

    expect(groups.map((group) => group.stem)).toEqual(['alpha', 'zeta'])
  })

  it('survives an un-hydrated store instead of throwing during startup', () => {
    expect(fanOutGroups({ workspaces: [], sessions: [] })).toEqual([])
    expect(fanOutGroups({
      workspaces: undefined as unknown as WorkspaceRecord[],
      sessions: undefined as unknown as SessionSnapshot[]
    })).toEqual([])
  })

  it('lets a group disappear once its lanes are torn down, leaving no empty shell', () => {
    // After keeping a winner and removing the rest, one lane remains — which is not a comparison, so the
    // group is gone rather than lingering as a husk.
    const after = fanOutGroups({ workspaces: [worktree('retry-2')], sessions: [] })
    expect(after).toEqual([])
  })

  // The projection being right is not the same as the strip using it. These assert the rendered
  // result — the shared status classes and the accessible names — rather than CSS declarations.
  it('renders one row per comparison, each lane carrying the shared status vocabulary', () => {
    const markup = renderToStaticMarkup(createElement(FanOutStrip, {
      workspaces: [worktree('retry-1'), worktree('retry-2')],
      sessions: [agent('retry-1', 'waiting'), agent('retry-2', 'done')],
      onSelectSession: vi.fn()
    }))

    expect(markup).toContain('data-stem="retry"')
    expect(markup).toContain('retry-1')
    expect(markup).toContain('retry-2')
    // Same classes StatusDot and the attention bar emit, so a lane dot means what a Tab dot means.
    expect(markup).toContain('status status--waiting')
    expect(markup).toContain('status__dot')
    // Progress reads as one honest line.
    expect(markup).toContain('2 lanes')
    expect(markup).toContain('1 done')
  })

  it('occupies no space when there is nothing to compare', () => {
    expect(renderToStaticMarkup(createElement(FanOutStrip, {
      workspaces: [worktree('main')],
      sessions: [],
      onSelectSession: vi.fn()
    }))).toBe('')
  })

  it('offers a jump to the lane waiting longest, naming it for a reader', () => {
    const markup = renderToStaticMarkup(createElement(FanOutStrip, {
      workspaces: [worktree('x-1'), worktree('x-2')],
      sessions: [agent('x-1', 'working'), agent('x-2', 'blocked', 5)],
      onSelectSession: vi.fn()
    }))

    expect(markup).toContain('Answer x-2')
    expect(markup).toContain('the lane waiting longest')
  })

  it('shows a lane whose Agent never launched, but not as something to open', () => {
    // It is part of the set — hiding it would make the group look smaller than it is — yet there is no
    // session to select, so it must not present itself as a button.
    const markup = renderToStaticMarkup(createElement(FanOutStrip, {
      workspaces: [worktree('y-1'), worktree('y-2')],
      sessions: [agent('y-1', 'working')],
      onSelectSession: vi.fn()
    }))

    expect(markup).toContain('fanout-lane--idle')
    expect(markup).toContain('y-2')
    // One button for the launched lane; the idle lane is a span.
    expect((markup.match(/<button/gu) ?? []).length).toBe(1)
  })
})
