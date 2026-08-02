import { describe, expect, it } from 'vitest'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import {
  addWorkbenchRegion,
  agentDisplayName,
  createWorkbenchTab,
  firstPromptFromTimeline,
  renameWorkbenchTab,
  tabDisplayName,
  type AgentNameFacts,
  type AgentWorkbenchSurface,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { regionIds, workbenchRegionBounds } from '../src/renderer/src/lib/workbench-view-layout.js'

/**
 * Tab 名的默认策略、手改后不被覆盖、以及"改名不动三级地址"。
 *
 * 这里守的是《显示名与身份》里 Tab 那半边：名字是 WorkbenchTab 上的一个字段，绝不进入 id/寻址 key；
 * 默认策略随 Region 数量切换；用户手改后自动策略永久停手。让自动派生越过手改、或让改名改动了寻址
 * 身份，都会让下面对应的断言变红。
 */

function agentSurface(regionId: string, sessionId: string): AgentWorkbenchSurface {
  return { regionId, kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId }
}

function tabWithAgents(...sessionIds: string[]): WorkbenchTab {
  let tab = createWorkbenchTab('tab', agentSurface('region-0', sessionIds[0]!))
  sessionIds.slice(1).forEach((sessionId, index) => {
    const regionId = `region-${index + 1}`
    tab = addWorkbenchRegion(tab, tab.layout.activeRegionId, 'right', agentSurface(regionId, sessionId))
  })
  return tab
}

// 一份最小的事实映射：每个 session 给一个 provider 与（可选）手改名/首条 prompt。
function factsFrom(
  entries: Record<string, { providerLabel: string; userName?: string; firstPrompt?: string; fallback?: string }>
): (sessionId: string) => AgentNameFacts | null {
  return (sessionId) => {
    const entry = entries[sessionId]
    if (!entry) return null
    return {
      providerLabel: entry.providerLabel,
      fallbackLabel: entry.fallback ?? `${entry.providerLabel} · repo`,
      ...(entry.userName === undefined ? {} : { userName: entry.userName }),
      ...(entry.firstPrompt === undefined ? {} : { firstPrompt: entry.firstPrompt })
    }
  }
}

describe('renameWorkbenchTab：改名不动三级地址', () => {
  it('手改名只写 name 字段，id / titleRegionId / regions 的 key 全部不变', () => {
    const tab = tabWithAgents('agent-1', 'agent-2')
    const before = {
      id: tab.id,
      titleRegionId: tab.titleRegionId,
      regionKeys: Object.keys(tab.regions).sort(),
      activeRegionId: tab.layout.activeRegionId
    }
    const renamed = renameWorkbenchTab(tab, '登录专项')
    expect(renamed.name).toBe('登录专项')
    expect(renamed.id).toBe(before.id)
    expect(renamed.titleRegionId).toBe(before.titleRegionId)
    expect(Object.keys(renamed.regions).sort()).toEqual(before.regionKeys)
    expect(renamed.layout.activeRegionId).toBe(before.activeRegionId)
    // 每个 region surface 的 sessionId（寻址身份）也一字不变。
    for (const key of before.regionKeys) {
      expect(renamed.regions[key]).toEqual(tab.regions[key])
    }
  })

  it('传空清除手改名，交还默认策略（不留空串把 Tab 钉死成手改态）', () => {
    const named = renameWorkbenchTab(tabWithAgents('agent-1'), '临时名')
    expect(named.name).toBe('临时名')
    const cleared = renameWorkbenchTab(named, '   ')
    expect(cleared.name).toBeUndefined()
  })
})

describe('tabDisplayName：默认策略随 Region 数量切换', () => {
  it('单 Agent 时对齐该 Agent 的名字', () => {
    const tab = tabWithAgents('agent-1')
    const name = tabDisplayName({
      tab,
      fallback: 'New Tab',
      agentFactsFor: factsFrom({ 'agent-1': { providerLabel: 'Codex', userName: '调查员' } })
    })
    expect(name).toBe('调查员')
  })

  it('多 Agent 时切成家族名，不冒充其中任一成员', () => {
    const tab = tabWithAgents('agent-1', 'agent-2')
    const facts = factsFrom({
      'agent-1': { providerLabel: 'Codex', userName: '调查员' },
      'agent-2': { providerLabel: 'Claude', userName: '审阅者' }
    })
    const name = tabDisplayName({ tab, fallback: 'New Tab', agentFactsFor: facts })
    expect(name).toBe('Claude · Codex')
    expect(name).not.toContain('调查员')
    expect(name).not.toContain('审阅者')
  })

  it('Tab 名不随哪个 Region 是 title region 而跳变', () => {
    const tab = tabWithAgents('agent-1', 'agent-2')
    const facts = factsFrom({
      'agent-1': { providerLabel: 'Codex' },
      'agent-2': { providerLabel: 'Claude' }
    })
    const asIs = tabDisplayName({ tab, fallback: 'New Tab', agentFactsFor: facts })
    // 把 title region 换成第二格：家族名遍历全体成员，与 titleRegionId 无关，故名字不变。
    const retitled: WorkbenchTab = { ...tab, titleRegionId: 'region-1' }
    const flipped = tabDisplayName({ tab: retitled, fallback: 'New Tab', agentFactsFor: facts })
    expect(flipped).toBe(asIs)
  })

  it('用户手改名后，两条自动策略对这张 Tab 永久停手——加成员也不改名', () => {
    const one = renameWorkbenchTab(tabWithAgents('agent-1'), '登录专项')
    const facts1 = factsFrom({ 'agent-1': { providerLabel: 'Codex', userName: '调查员' } })
    expect(tabDisplayName({ tab: one, fallback: 'New Tab', agentFactsFor: facts1 })).toBe('登录专项')

    // 再开一个 Region：默认策略本会切成家族名，但手改名把它们都挡住。
    const two = addWorkbenchRegion(one, one.layout.activeRegionId, 'right', agentSurface('region-1', 'agent-2'))
    const facts2 = factsFrom({
      'agent-1': { providerLabel: 'Codex', userName: '调查员' },
      'agent-2': { providerLabel: 'Claude', userName: '审阅者' }
    })
    expect(tabDisplayName({ tab: two, fallback: 'New Tab', agentFactsFor: facts2 })).toBe('登录专项')
  })

  it('没有 Agent 成员时落到表面兜底', () => {
    const fileTab = createWorkbenchTab('file-tab', {
      regionId: 'r', kind: 'file', workspaceId: 'workspace', path: '/repo/README.md'
    })
    expect(tabDisplayName({ tab: fileTab, fallback: 'README.md', agentFactsFor: () => null }))
      .toBe('README.md')
  })
})

describe('agentDisplayName：单个 Agent 名也经同一条链', () => {
  it('手改名压过首条 prompt 与 Provider·Workspace 兜底', () => {
    expect(agentDisplayName({
      userName: '我的调查员',
      firstPrompt: '查登录 bug',
      fallbackLabel: 'Codex · repo',
      providerLabel: 'Codex'
    })).toBe('我的调查员')
  })

  it('无手改时从首条 prompt 派生', () => {
    expect(agentDisplayName({
      firstPrompt: '查登录 bug',
      fallbackLabel: 'Codex · repo',
      providerLabel: 'Codex'
    })).toBe('查登录 bug')
  })
})

describe('firstPromptFromTimeline', () => {
  const snapshot = (items: AgentTimelineSnapshot['items']): AgentTimelineSnapshot => ({
    agentSessionId: 'agent-1', revision: items.length, items
  })
  const item = (kind: string, content: string): AgentTimelineSnapshot['items'][number] => ({
    id: `${kind}-${content}`, agentSessionId: 'agent-1', kind: kind as never,
    status: 'complete', source: 'native-hook', createdAt: 1, updatedAt: 1, title: content, content
  })

  it('取首条 user_message 的内容', () => {
    const timeline = snapshot([
      item('lifecycle', 'started'),
      item('user_message', '查登录 bug'),
      item('assistant_message', '好的')
    ])
    expect(firstPromptFromTimeline(timeline)).toBe('查登录 bug')
  })

  it('没有对话时返回 null——那不是错误', () => {
    expect(firstPromptFromTimeline(undefined)).toBeNull()
    expect(firstPromptFromTimeline(snapshot([item('lifecycle', 'started')]))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// #470「在某个方向打开任意多个并自动布局」。
//
// 引擎早就能在一个方向上排任意多格（splitWorkbenchRegion 无深度上限），真正的缺陷不在「能不能加」
// 而在**加完什么样**：每次 split 都用 ratio 0.5，而三个入口（GUI 分屏、控制协议 open.split、点链接
// openHttpLink）都把**同一个 origin 格**当锚点连开。于是在同一个锚点上开第 N 个，锚点被切成 0.5^N
// ——开到第 6 个时首格只剩 ~1.5% 宽，用户看到的是一条无法使用的窄缝，而不是「N 格都还看得见」。
//
// addWorkbenchRegion 是这三个入口共用的**唯一**追加漏斗，所以「追加即自动均分」落在它这里：
// 追加后每一格的尺寸只由它在树里的后代叶子数决定（balanceWorkbenchRegionLayout 干的），N 格就各占
// 1/N，而不是几何衰减的窄缝。纯 splitWorkbenchRegion 不动（它保留局部 0.5，嵌套分屏的几何测试靠它）。
// ---------------------------------------------------------------------------
describe('addWorkbenchRegion：在一个方向追加任意多格，自动均分', () => {
  const launcher = (regionId: string) =>
    ({ regionId, kind: 'launcher' as const, workspaceId: 'workspace' })

  it('在同一个 origin 上连开 6 个，每一格都是可用的 1/N 宽，不是 0.5^N 的窄缝', () => {
    let tab = createWorkbenchTab('tab', launcher('r0'))
    for (let i = 1; i <= 5; i++) {
      tab = addWorkbenchRegion(tab, 'r0', 'right', launcher(`r${i}`))
    }
    const bounds = workbenchRegionBounds(tab.layout.root)
    expect(bounds).toHaveLength(6)
    // 六格横排：每格 1/6。若没有均分，锚点 r0 会缩到 0.5^5 ≈ 0.031，这一条会红。
    for (const { bounds: b } of bounds) {
      expect(b.width, '有一格被挤成了窄缝——追加没有自动均分').toBeCloseTo(1 / 6)
    }
  })

  it('保留追加内容的顺序与身份：第 N 格就是最后追加的那个', () => {
    let tab = createWorkbenchTab('tab', launcher('r0'))
    for (let i = 1; i <= 3; i++) {
      tab = addWorkbenchRegion(tab, 'r0', 'right', launcher(`r${i}`))
    }
    // 均分只重算 ratio，不重排 id。这一格集合与活动格（追加的最后一个）必须原样保留。
    expect(new Set(regionIds(tab.layout.root))).toEqual(new Set(['r0', 'r1', 'r2', 'r3']))
    expect(tab.layout.activeRegionId).toBe('r3')
    expect(Object.keys(tab.regions).sort()).toEqual(['r0', 'r1', 'r2', 'r3'])
  })

  it('追加两格恰好各半（均分与旧的 0.5 在 N=2 时一致，不制造回归）', () => {
    const tab = addWorkbenchRegion(
      createWorkbenchTab('tab', launcher('r0')),
      'r0',
      'right',
      launcher('r1')
    )
    const [a, b] = workbenchRegionBounds(tab.layout.root)
    expect(a!.bounds.width).toBeCloseTo(0.5)
    expect(b!.bounds.width).toBeCloseTo(0.5)
  })

  it('挂不上时（重名 / 跨 workspace）原样返回，不悄悄改别的东西', () => {
    const base = createWorkbenchTab('tab', launcher('r0'))
    // 重名：新格 id 已在场。
    expect(addWorkbenchRegion(base, 'r0', 'right', launcher('r0'))).toBe(base)
    // 跨 workspace：surface 属于别的 workspace。
    expect(
      addWorkbenchRegion(base, 'r0', 'right', { regionId: 'r1', kind: 'launcher', workspaceId: 'other' })
    ).toBe(base)
  })
})
