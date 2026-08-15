import { describe, expect, it } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import type { WorkspaceLayout } from '@agentmux/layout'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { nextAttentionSessionId } from '../src/renderer/src/lib/agent-attention.js'
import {
  dispatchNextAttention,
  focusedSessionId,
  windowShortcutHandlers,
  type WorkbenchShortcutStore
} from '../src/renderer/src/lib/workbench-shortcuts.js'

// 「跳到下一个要你处理的 Agent」这条键的三段：队列（谁进、按什么序）、游标（你正看着谁）、接线
// （键 → selectSession）。三段各自都能独立坏掉且互相掩盖，所以分开断言。
//
// 为什么不复用 workbench-shortcuts.test.ts 的 spyStore：那份 fixture 里一个 Agent 都没有（它测的是
// Tab/Region 结构命令），要在它上面测这条键就得把每个用例的 sessions 和 Agent 面重造一遍——那等于在
// 那个文件里再写一份本文件。

function agent(
  id: string,
  state: AgentDisplayState,
  observedAt: number
): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'streaming',
      permission: 'respond',
      providerResume: true,
      replyCorrelation: 'native-turn-id'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: id,
    createdAt: 1,
    updatedAt: observedAt,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  } as unknown as SessionSnapshot
}

function terminal(id: string, state: AgentDisplayState): SessionSnapshot {
  return {
    id,
    kind: 'terminal',
    providerId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: id,
    createdAt: 1,
    updatedAt: 1,
    status: { state, source: 'run-process', observedAt: 1 },
    processState: 'running',
    latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: `run-${id}` } }
  } as unknown as SessionSnapshot
}

describe('nextAttentionSessionId：要你处理的那条队', () => {
  it('一个都没有时返回 null——在跑的、跑完的都不进队', () => {
    // working / done / disconnected 各代表 `categoryFor` 的一种「不进任何注意力档」：在跑、完成、掉线。
    // 三个都在场却仍是 null，才证明这条队筛的是「要你处理」而不是「有 Agent」。
    expect(nextAttentionSessionId(
      [agent('busy', 'working', 1), agent('finished', 'done', 2), agent('gone', 'disconnected', 3)],
      null
    )).toBeNull()
  })

  it('Terminal Session 不进队——它没有「在等你回话」这回事', () => {
    // 两个 Terminal 都**显式带上急迫档**（waiting / error），于是这条用例问的是纯粹的
    // 「kind 是不是 Agent」：`isUrgentAttention` 那道筛子放它们过，唯一拦下它们的是 `isAgent`。
    //
    // 此前这里写的是 `terminal('t1')`、`terminal('t2')`——不传 state，于是 `status.state` 是
    // undefined，两个 Terminal 本来就不急迫，`isAgent` 删掉照样全绿（实测）。fixture 的签名要求
    // 这个参数，但 desktop 的 tsc `include` 只有 `src/**`，看不见 test/，所以漏参数没人报。
    // 这正是本仓记过的那个形状：判据构造成两个世界给同一个答案，断言于是恒真。
    expect(nextAttentionSessionId(
      [terminal('t1', 'waiting'), terminal('t2', 'error')],
      null
    )).toBeNull()
  })

  it('急迫档在前：error 等得再久也排在 needs-you 之后', () => {
    // 这一条专打「只按 observedAt 排、不看档位」的写法：error 的 observedAt(1) 比 needs-you(9) 早得多，
    // 所以少了档位那一段，队首会是 boom。
    const sessions = [agent('boom', 'error', 1), agent('asking', 'waiting', 9)]
    expect(nextAttentionSessionId(sessions, null)).toBe('asking')
    expect(nextAttentionSessionId(sessions, 'asking')).toBe('boom')
  })

  it('同档内等得最久的先来——与状态栏那两个按钮同一条约定', () => {
    // blocked 与 waiting 同属 needs-you（`isNeedsYouState`），所以这三个是同一档，只由 observedAt 分先后。
    // 投影顺序刻意与期望顺序相反，于是「不排序、按投影顺序走」的写法在这里必红。
    const sessions = [
      agent('late', 'waiting', 30),
      agent('middle', 'blocked', 20),
      agent('early', 'waiting', 10)
    ]
    expect(nextAttentionSessionId(sessions, null)).toBe('early')
    expect(nextAttentionSessionId(sessions, 'early')).toBe('middle')
    expect(nextAttentionSessionId(sessions, 'middle')).toBe('late')
  })

  it('走到队尾回绕到队首——这个键是把队列过一遍，不是走到头就停', () => {
    const sessions = [agent('a', 'waiting', 10), agent('b', 'waiting', 20)]
    expect(nextAttentionSessionId(sessions, 'b')).toBe('a')
  })

  it('游标不在队里（正看着一个在跑的 Agent）→ 队首，而不是什么都不做', () => {
    // 最常见的现场：你刚回完话，那个 Agent 转成 working，你再按这个键想去下一个。
    // 「找不到游标就返回 null」的写法在这里给 null，用户会以为键没绑上。
    const sessions = [agent('busy', 'working', 1), agent('asking', 'waiting', 10)]
    expect(nextAttentionSessionId(sessions, 'busy')).toBe('asking')
  })

  it('队里只有一个、且正是游标 → 返回它自己，不是 null', () => {
    // 无声 no-op 与「键没绑上」在用户眼里一模一样；返回自己至少把那一格重新聚焦一次。
    expect(nextAttentionSessionId([agent('only', 'waiting', 10)], 'only')).toBe('only')
  })

  it('同档同时刻按 id 定序，两次投影顺序给同一个答案', () => {
    // 不定序的话，队列顺序取决于投影顺序，同一次按键在两次渲染之间可能走向不同的下一个。
    const forward = [agent('alpha', 'waiting', 10), agent('beta', 'waiting', 10)]
    const reversed = [agent('beta', 'waiting', 10), agent('alpha', 'waiting', 10)]
    expect(nextAttentionSessionId(forward, null)).toBe('alpha')
    expect(nextAttentionSessionId(reversed, null)).toBe('alpha')
  })
})

// ---------------------------------------------------------------------------
// 游标：你正看着哪个 Session。分屏是这一段唯一能被观察到的地方——单格 fixture 上「读焦点格」与
// 「读标题格」给同一个答案，两个世界不可分辨。
// ---------------------------------------------------------------------------

const LAYOUT: WorkspaceLayout = {
  root: { type: 'leaf', groupId: 'g' },
  groups: [{ id: 'g', tabOrder: ['t-split'], activeTabId: 't-split', recentTabIds: ['t-split'] }],
  activeGroupId: 'g'
}

/** 一张左右分屏的 Tab：左格是 left-agent，右格是 right-agent，焦点由参数指定。标题格恒是左格。 */
function splitTab(activeRegionId: 'rL' | 'rR'): WorkbenchTab {
  return {
    id: 't-split',
    workspaceId: 'ws',
    titleRegionId: 'rL',
    layout: {
      root: {
        type: 'split',
        direction: 'row',
        sizes: [0.5, 0.5],
        children: [
          { type: 'leaf', regionId: 'rL' },
          { type: 'leaf', regionId: 'rR' }
        ]
      },
      activeRegionId
    },
    regions: {
      rL: { regionId: 'rL', kind: 'agent', phase: 'attached', workspaceId: 'ws', sessionId: 'left-agent' },
      rR: { regionId: 'rR', kind: 'agent', phase: 'attached', workspaceId: 'ws', sessionId: 'right-agent' }
    }
  } as unknown as WorkbenchTab
}

function store(overrides: Partial<WorkbenchShortcutStore> = {}): WorkbenchShortcutStore & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    mainSurface: 'workbench',
    activeWorkspaceId: 'ws',
    layouts: { ws: LAYOUT },
    tabs: { 't-split': splitTab('rL') },
    sessions: [],
    selectSession: (id) => calls.push(`selectSession:${id}`),
    activateTab: () => {},
    openLauncher: () => {},
    closeRegion: () => {},
    requestCloseTab: () => {},
    requestCloseRegion: () => {},
    splitRegion: () => {},
    focusRegion: () => {},
    swapRegions: () => {},
    ...overrides
  }
}

describe('focusedSessionId：游标是焦点那一格', () => {
  it('分屏时取焦点格的 Session，不是标题格的', () => {
    // 标题格恒是 rL。读标题格的写法在右格聚焦时给 left-agent，于是在右格上按键会从左边那个往后数。
    expect(focusedSessionId(store({ tabs: { 't-split': splitTab('rR') } }))).toBe('right-agent')
    expect(focusedSessionId(store({ tabs: { 't-split': splitTab('rL') } }))).toBe('left-agent')
  })

  it('Board 面上没有游标——一格 Session Region 都没挂载', () => {
    expect(focusedSessionId(store({ mainSurface: 'board' }))).toBeNull()
  })

  it('焦点格不是 Session（launcher / 文件）时没有游标', () => {
    const launcherTab = {
      id: 't-split',
      workspaceId: 'ws',
      titleRegionId: 'rL',
      layout: { root: { type: 'leaf', regionId: 'rL' }, activeRegionId: 'rL' },
      regions: { rL: { regionId: 'rL', kind: 'launcher', workspaceId: 'ws' } }
    } as unknown as WorkbenchTab
    expect(focusedSessionId(store({ tabs: { 't-split': launcherTab } }))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 接线：键 → 队列 → selectSession。只测上面两段不够——把 dispatchNextAttention 里那行 selectSession
// 删掉，上面全绿，而这个键按下去什么也不会发生。
// ---------------------------------------------------------------------------
describe('attention.next 接线', () => {
  it('按下去真的调 selectSession，落点是队首', () => {
    const spy = store({ sessions: [agent('busy', 'working', 1), agent('asking', 'waiting', 10)] })
    const handlers = windowShortcutHandlers(spy, { toggleQuickSwitch: () => {}, toggleShortcutsHelp: () => {} })
    expect(handlers['attention.next']!()).toBe(true)
    expect(spy.calls).toEqual(['selectSession:asking'])
  })

  it('游标真的从焦点格来：右格聚焦时跳的是右格之后的那个', () => {
    // left-agent 与 right-agent 同档、observedAt 递增，所以队列是 [left, right, third]。
    // 焦点在右格 → 下一个是 third；若游标退化成标题格（left），这里会是 right-agent。
    const spy = store({
      tabs: { 't-split': splitTab('rR') },
      sessions: [
        agent('left-agent', 'waiting', 10),
        agent('right-agent', 'waiting', 20),
        agent('third', 'waiting', 30)
      ]
    })
    expect(dispatchNextAttention(spy)).toBe(true)
    expect(spy.calls).toEqual(['selectSession:third'])
  })

  it('没人在等你时不吃这个键，也不跳转', () => {
    const spy = store({ sessions: [agent('busy', 'working', 1)] })
    expect(dispatchNextAttention(spy)).toBe(false)
    expect(spy.calls).toEqual([])
  })

  it('Board 面上照样能用——这是全局导航，不是 Workbench 结构命令', () => {
    // 其余 workbench 命令在 `mainSurface !== 'workbench'` 时一律不动；这一条刻意不加那个前置条件，
    // 因为在 Board 上按它的意思正是「带我去那个卡住的 Agent」，selectSession 自己会把主面切回去。
    const spy = store({ mainSurface: 'board', sessions: [agent('asking', 'waiting', 10)] })
    expect(dispatchNextAttention(spy)).toBe(true)
    expect(spy.calls).toEqual(['selectSession:asking'])
  })
})
