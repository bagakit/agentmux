import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import {
  fanOutGroups,
  fanOutKeepSplit,
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
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
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

  it('counts a starting or running lane as working, the same way the rest of the window does', () => {
    // 上面那条的 fixture 只用了 done/waiting/error/working——四个态里没有一个能区分
    // 「`sessionBoardColumn` 的 working 列」与「`state === 'working'`」，所以严格判据在那里恒绿。
    // #582 是同一个形状在状态栏上的实例：`running` 不是边角状态而是主稳态，严格判据会把它算进
    // `idle`，于是同一批 Agent 在不同投影里报出两组数。这条把差额本身做成 fixture。
    const groups = fanOutGroups({
      workspaces: [worktree('w-1'), worktree('w-2'), worktree('w-3'), worktree('w-4')],
      sessions: [
        agent('w-1', 'running'),
        agent('w-2', 'starting'),
        agent('w-3', 'working'),
        agent('w-4', 'done')
      ]
    })

    // 严格判据下这里是 working:1 / idle:2——running 与 starting 各错一次。
    expect(groupProgress(groups[0]!)).toEqual({
      total: 4, done: 1, needsYou: 0, error: 0, working: 3, idle: 0
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
    // The keep-the-winner teardown (see worktree-service) removes every lane but the chosen one. Before,
    // three lanes read as one bake-off; after, only the winner's worktree remains — and one lane is not a
    // comparison, so the group is gone rather than lingering as a husk pointing at torn-down lanes.
    const before = fanOutGroups({
      workspaces: [worktree('retry-1'), worktree('retry-2'), worktree('retry-3')],
      sessions: []
    })
    expect(before).toHaveLength(1)
    expect(before[0]!.lanes).toHaveLength(3)

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

  // 崩掉的 lane 与等你回复的 lane 必须分得开——上一条只喂 waiting/done，于是 laneState 里
  // `error → 'error'` 那半支在整个仓里没有任何断言（结构守卫的正则只钉了 needs-you 那半条）。
  // 实测过：把它改成 `return 'waiting'`，六个 fanout suite 共 63 条全绿。用户看到的是一条跑挂的
  // 分支画成琥珀 + `?` pip，与真正在等他回复的 lane 逐像素同色——点进去才发现是崩的。这正是
  // attention-vocabulary.ts 反复写明的红线：琥珀说「你被等着」，红说「这坏了」，折在一起就把
  // 颜色唯一的用处丢掉了。
  //
  // 判据落在**每条 lane 自己的 markup 片段**上，而不是整份 markup 含不含某个 class：整份含
  // `status--error` 的断言在两条 lane 里只要有一条是红的就满足，分不出红的是哪一条。
  it('把崩掉的 lane 与等你回复的 lane 画成两种颜色，逐 lane 各判一次', () => {
    const markup = renderToStaticMarkup(createElement(FanOutStrip, {
      workspaces: [worktree('bake-1'), worktree('bake-2'), worktree('bake-3')],
      sessions: [agent('bake-1', 'error'), agent('bake-2', 'waiting'), agent('bake-3', 'working')],
      onSelectSession: vi.fn()
    }))

    // 每条 lane 的 chip 是一个带 aria-label 的 button，标签里带分支名与它的 attention。
    const chipFor = (branch: string): string => {
      const start = markup.indexOf(`aria-label="${branch} · `)
      expect(start, `渲染里找不到 ${branch} 这条 lane：fixture 没进到被测分支`).toBeGreaterThan(-1)
      // 右界取本 chip 的收尾，否则切片一路吃到文档末尾，邻居的 class 会顶上来充当本条的证据。
      const end = markup.indexOf('</button>', start)
      expect(end, `${branch} 的 chip 没有收尾`).toBeGreaterThan(start)
      return markup.slice(start, end)
    }

    const failed = chipFor('bake-1')
    expect(failed, '崩掉的 lane 必须是红的').toContain('status status--error')
    expect(failed, '崩掉的 lane 不许同时是琥珀——那就是把「坏了」说成「等你」').not.toContain('status--waiting')

    const needsYou = chipFor('bake-2')
    expect(needsYou, '等你回复的 lane 必须是琥珀').toContain('status status--waiting')
    expect(needsYou, '等你回复的 lane 不许是红的').not.toContain('status--error')

    // 第三条钉住 working 仍是第三种颜色：否则「两种颜色」可以靠把 working 也折进来满足。
    const busy = chipFor('bake-3')
    expect(busy, '在跑的 lane 是第三种状态').toContain('status status--working')
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

  // Closing the bake-off. Without this the comparison surface can only be read, never resolved: the
  // teardown primitive exists and is tested, but a user has no way to say which lane won.
  it('offers a keep action per lane, naming the losers it would tear down', () => {
    const onKeep = vi.fn()
    const markup = renderToStaticMarkup(createElement(FanOutStrip, {
      workspaces: [worktree('z-1'), worktree('z-2'), worktree('z-3')],
      sessions: [agent('z-1', 'working'), agent('z-2', 'working'), agent('z-3', 'working')],
      onSelectSession: vi.fn(),
      onKeepLane: onKeep
    }))

    // One keep control per lane, and the label says what it does rather than just "keep".
    expect((markup.match(/fanout-lane__keep/gu) ?? []).length).toBe(3)
    expect(markup).toContain('Keep z-1 and remove the other 2')
  })

  it('hands the store exactly the winner and the other lanes of that group', () => {
    const groups = fanOutGroups({
      workspaces: [worktree('z-1'), worktree('z-2'), worktree('z-3')],
      sessions: [agent('z-1', 'working')]
    })
    const split = fanOutKeepSplit(groups[0]!, 'ws-z-2')!

    expect(split.keepWorkspaceId).toBe('ws-z-2')
    // The consequential half: the winner must never appear among the lanes about to be torn down.
    expect(split.removeWorkspaceIds).not.toContain('ws-z-2')
    expect([...split.removeWorkspaceIds].sort()).toEqual(['ws-z-1', 'ws-z-3'])
  })

  it('does not reach outside its own group when resolving a bake-off', () => {
    // Two independent fan-outs running at once. Resolving one must not tear down the other's lanes.
    const groups = fanOutGroups({
      workspaces: [worktree('a-1'), worktree('a-2'), worktree('b-1'), worktree('b-2')],
      sessions: []
    })
    const groupA = groups.find((group) => group.stem === 'a')!
    const split = fanOutKeepSplit(groupA, 'ws-a-1')!

    expect(split.removeWorkspaceIds).toEqual(['ws-a-2'])
    expect(split.removeWorkspaceIds.some((id) => id.startsWith('ws-b'))).toBe(false)
  })

  it('refuses to resolve with a lane that is not in the group', () => {
    const groups = fanOutGroups({ workspaces: [worktree('c-1'), worktree('c-2')], sessions: [] })
    // Keeping a lane that does not exist would otherwise mean "remove everything".
    expect(fanOutKeepSplit(groups[0]!, 'ws-not-here')).toBeNull()
  })
})
