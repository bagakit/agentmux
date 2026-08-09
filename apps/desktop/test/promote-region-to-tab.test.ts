import { describe, expect, it } from 'vitest'
import { promoteRegionToTab } from '../src/renderer/src/lib/promote-region-to-tab'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  type WorkbenchSurface,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs'
import { regionIds, createWorkspaceLayout, findGroup } from '@agentmux/layout'

// #487「以及单独变成一个 tab」的纯布局代数。promoteRegionToTab 把一格从源 Tab 的分屏树里摘出，
// 作为一张新 Tab 的唯一一格，落在源 Tab 紧邻其后的位置并激活。这里钉两条 tracker #487 只有散文、
// 无守卫的不变量（另见 workbench-region-invariant.test.ts 的 promote 一条）：
//   1. 源 Tab 与新 Tab 两侧，layout 树的 regionId 集合都必须等于 tab.regions 的 key 集合。
//   2. 任何 Tab 都不能变成 0 格：只剩一格时促升是 no-op（它已经就是一张 Tab），N>1 促升后源 Tab
//      剩 N-1 格且 activeRegionId 指向仍在场的格。
// 另外钉住：促升后活动的是**新** Tab，新 Tab 落在源 Tab 紧邻其后（不是队尾），regionId 原样保留
// （不新铸），topicId 从源 Tab 继承。

function launcher(regionId: string): WorkbenchSurface {
  return { regionId, kind: 'launcher', workspaceId: 'workspace' }
}

// 带独立身份的表面，用来验「新 Tab 拿到的是同一个 surface 对象、内容整份搬走而非重建」。
function agent(regionId: string, sessionId: string): WorkbenchSurface {
  return { regionId, kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId }
}

// 文件表面：它的宿主 Tab 由 fileTabId(path) 派生的 canonical id 寻址，故不能被促升进 view:… Tab
// （见 promote-region-to-tab.ts 的豁免注释与 file-workbench-state.ts 那条不成文不变量）。
function file(regionId: string, path: string): WorkbenchSurface {
  return { regionId, kind: 'file', workspaceId: 'workspace', path }
}

// 两侧集合相等这条不变量的可断言形式（与 workbench-region-invariant.test.ts 同一套判据）。
function regionSetsAgree(tab: WorkbenchTab): { tree: string[]; map: string[] } {
  return {
    tree: [...regionIds(tab.layout.root)].sort(),
    map: Object.keys(tab.regions).sort()
  }
}

function expectInvariant(tab: WorkbenchTab): void {
  const { tree, map } = regionSetsAgree(tab)
  expect(tree, 'layout 树里的 regionId 集合必须等于 tab.regions 的 key 集合').toEqual(map)
}

describe('promoteRegionToTab（#487「单独变成一个 tab」）', () => {
  it('不变量#2：促升只剩一格的 Tab 是 no-op——它已经就是一张 Tab', () => {
    // 单格 Tab，且布局合法（layout 里有它）。走的是 removeWorkbenchRegion→null 那条 no-op，
    // 不是缺 layout 的守卫。
    const sourceTab = createWorkbenchTab('source', launcher('only'))
    const tabs = { source: sourceTab }
    const layouts = { workspace: createWorkspaceLayout('group-one', ['source']) }

    const result = promoteRegionToTab({
      tabs,
      layouts,
      workspaceId: 'workspace',
      tabId: 'source',
      regionId: 'only',
      mint: { tabId: 'new-tab' }
    })

    // discriminated union 的 kind 干净地区分「提前返回不变」与「跑完产出一个相等的值」。
    expect(result.kind).toBe('unchanged')
    // 输入没被动过：没有凭空多出一张 Tab。
    expect(Object.keys(tabs)).toEqual(['source'])
    expect(Object.keys(tabs)).not.toContain('new-tab')
    expect(tabs.source).toBe(sourceTab)
  })

  it('促升多格 Tab 中的一格：源剩 N-1、新 Tab 恰一格，两侧集合各自相等（不变量#1）', () => {
    // 读序 [r-left, r-mid, r-right]，且 r-mid 恰为活动格——促升活动格，逼出源 Tab 的活动格重指派。
    const midSurface = agent('r-mid', 'sess-1')
    let sourceTab = createWorkbenchTab('source', launcher('r-left'))
    sourceTab = addWorkbenchRegion(sourceTab, 'r-left', 'right', launcher('r-right'))
    sourceTab = addWorkbenchRegion(sourceTab, 'r-left', 'right', midSurface)
    // 前提自检：三格、读序居中的是 r-mid、且它是活动格。
    expect(regionIds(sourceTab.layout.root)).toEqual(['r-left', 'r-mid', 'r-right'])
    expect(sourceTab.layout.activeRegionId).toBe('r-mid')

    const result = promoteRegionToTab({
      tabs: { source: sourceTab },
      layouts: { workspace: createWorkspaceLayout('group-one', ['source']) },
      workspaceId: 'workspace',
      tabId: 'source',
      regionId: 'r-mid',
      mint: { tabId: 'new-tab' }
    })

    expect(result.kind).toBe('promoted')
    if (result.kind !== 'promoted') throw new Error('unreachable')

    const nextSource = result.tabs.source!
    const newTab = result.tabs['new-tab']!

    // 源 Tab：剩 2 格，树与表逐一相等，且不再含被促升的那格。
    expect(Object.keys(nextSource.regions)).toHaveLength(2)
    expectInvariant(nextSource)
    expect(regionSetsAgree(nextSource).map).toEqual(['r-left', 'r-right'])
    expect(nextSource.regions['r-mid']).toBeUndefined()

    // 新 Tab：恰 1 格，树与表逐一相等，含且仅含被促升的那格。
    expect(Object.keys(newTab.regions)).toHaveLength(1)
    expectInvariant(newTab)
    expect(regionSetsAgree(newTab).map).toEqual(['r-mid'])

    // regionId 原样保留（不新铸）：target 与新 Tab 的 key 都是原来那个 id。
    expect(result.target.regionId).toBe('r-mid')
    expect(result.target.tabId).toBe('new-tab')
    expect(result.target.workspaceId).toBe('workspace')

    // 新 Tab 自己的 id 字段必须等于它在 tabs 表里的 key（用 mint 的那个 id 起的），不是源 Tab 的 id。
    // 否则 tabs['new-tab'].id === 'source'：一张 key 与自身 id 不符的 Tab，任何按 tab.id 再寻址的代码
    // 都会指错——createWorkbenchTab 若拿错第一个参数（用 input.tabId 而非 input.mint.tabId）正是这形状。
    expect(newTab.id, "新 Tab 的 id 字段与它在 tabs 表里的 key 不一致").toBe('new-tab')

    // 内容整份搬走：新 Tab 那格的 surface 就是原来那个对象本身，不是重建的等值物。
    expect(newTab.regions['r-mid']).toBe(midSurface)

    // 不变量#2：源 Tab 的活动格仍指向一个在场的格（促升活动格后被重指派到兄弟）。
    expect(Object.keys(nextSource.regions)).toContain(nextSource.layout.activeRegionId)
    expect(nextSource.layout.activeRegionId).not.toBe('r-mid')
  })

  it('促升后活动的是新 Tab，且新 Tab 紧邻源 Tab（不是队尾）', () => {
    // 关键的假绿闸：源 Tab 在 tabOrder 里**不是最后一个**。这样「活动=最后一张」和「追加到队尾」
    // 两种错误实现都会红。tabOrder = [A, source, C]。
    let sourceTab = createWorkbenchTab('source', launcher('s0'))
    sourceTab = addWorkbenchRegion(sourceTab, 's0', 'right', launcher('s1'))

    const result = promoteRegionToTab({
      tabs: { source: sourceTab },
      layouts: { workspace: createWorkspaceLayout('group-one', ['A', 'source', 'C']) },
      workspaceId: 'workspace',
      tabId: 'source',
      regionId: 's1',
      mint: { tabId: 'new-tab' }
    })

    expect(result.kind).toBe('promoted')
    if (result.kind !== 'promoted') throw new Error('unreachable')

    const group = findGroup(result.layouts.workspace!, 'group-one')!
    // 落在源 Tab 紧邻其后：[A, source, new-tab, C]。
    expect(group.tabOrder).toEqual(['A', 'source', 'new-tab', 'C'])
    // 活动的是新 Tab（不是 source、不是 C）。
    expect(group.activeTabId).toBe('new-tab')
    // 相邻性与「非队尾」各自成条：indexOf 关系挡「追加到队尾」，at(-1) 挡「落在末尾」。
    expect(group.tabOrder.indexOf('new-tab')).toBe(group.tabOrder.indexOf('source') + 1)
    expect(group.tabOrder.at(-1)).not.toBe('new-tab')
  })

  it('新 Tab 继承源 Tab 的 topicId', () => {
    let sourceTab = createWorkbenchTab('source', launcher('t0'))
    sourceTab = addWorkbenchRegion(sourceTab, 't0', 'right', launcher('t1'))
    sourceTab = { ...sourceTab, topicId: 'topic-x' }

    const result = promoteRegionToTab({
      tabs: { source: sourceTab },
      layouts: { workspace: createWorkspaceLayout('group-one', ['source']) },
      workspaceId: 'workspace',
      tabId: 'source',
      regionId: 't1',
      mint: { tabId: 'new-tab' }
    })

    expect(result.kind).toBe('promoted')
    if (result.kind !== 'promoted') throw new Error('unreachable')
    expect(result.tabs['new-tab']!.topicId).toBe('topic-x')
  })

  it('源 Tab 无 topicId 时，新 Tab 也不该凭空造一个', () => {
    let sourceTab = createWorkbenchTab('source', launcher('u0'))
    sourceTab = addWorkbenchRegion(sourceTab, 'u0', 'right', launcher('u1'))
    // 前提自检：源 Tab 确实没有 topicId。
    expect(sourceTab.topicId).toBeUndefined()

    const result = promoteRegionToTab({
      tabs: { source: sourceTab },
      layouts: { workspace: createWorkspaceLayout('group-one', ['source']) },
      workspaceId: 'workspace',
      tabId: 'source',
      regionId: 'u1',
      mint: { tabId: 'new-tab' }
    })

    expect(result.kind).toBe('promoted')
    if (result.kind !== 'promoted') throw new Error('unreachable')
    const newTab = result.tabs['new-tab']!
    expect(newTab.topicId).toBeUndefined()
    // 不只是 undefined 值，而是键根本不该在场——不给一个 topic: undefined 的假绑定。
    expect('topicId' in newTab).toBe(false)
  })

  it('未知 tabId：no-op，输入不动、不多出新 Tab', () => {
    const sourceTab = createWorkbenchTab('source', launcher('r0'))
    const tabs = { source: sourceTab }

    const result = promoteRegionToTab({
      tabs,
      layouts: { workspace: createWorkspaceLayout('group-one', ['source']) },
      workspaceId: 'workspace',
      tabId: 'nonexistent',
      regionId: 'r0',
      mint: { tabId: 'new-tab' }
    })

    expect(result.kind).toBe('unchanged')
    expect(Object.keys(tabs)).toEqual(['source'])
    expect(Object.keys(tabs)).not.toContain('new-tab')
  })

  it('workspaceId 不匹配：no-op——不能跨项目促升别人的格', () => {
    let sourceTab = createWorkbenchTab('source', launcher('r0'))
    sourceTab = addWorkbenchRegion(sourceTab, 'r0', 'right', launcher('r1'))

    // 关键：other-workspace **有**一个含 source 的 layout。这样唯一能挡住促升的就是归属守卫本身
    // （sourceTab.workspaceId 'workspace' ≠ 入参 'other-workspace'）——若把守卫的 workspace 那半删掉，
    // 后续 layout 守卫会放行、insertTabAfter 在 group-other 里找得到 source → promoted，这一条转红。
    // 若 fixture 里 other-workspace 没有 layout，红点会假落在 layout 守卫上，归属守卫就没人钉。
    const result = promoteRegionToTab({
      tabs: { source: sourceTab },
      layouts: {
        workspace: createWorkspaceLayout('group-one', ['source']),
        'other-workspace': createWorkspaceLayout('group-other', ['source'])
      },
      workspaceId: 'other-workspace',
      tabId: 'source',
      regionId: 'r0',
      mint: { tabId: 'new-tab' }
    })

    expect(result.kind, '入参 workspace 与 tab 归属不符，却仍促升了——跨项目改了别人的 Tab').toBe('unchanged')
  })

  it('未知 regionId：no-op——那格根本不在这张 Tab 上', () => {
    let sourceTab = createWorkbenchTab('source', launcher('r0'))
    sourceTab = addWorkbenchRegion(sourceTab, 'r0', 'right', launcher('r1'))

    const result = promoteRegionToTab({
      tabs: { source: sourceTab },
      layouts: { workspace: createWorkspaceLayout('group-one', ['source']) },
      workspaceId: 'workspace',
      tabId: 'source',
      regionId: 'ghost',
      mint: { tabId: 'new-tab' }
    })

    expect(result.kind).toBe('unchanged')
  })

  it('该 workspace 没有 layout：no-op——新 Tab 没有可落脚的分组', () => {
    // 源 Tab 合法且多格（越过归属与在场两道守卫），红点专门落在 layout 守卫上。
    let sourceTab = createWorkbenchTab('source', launcher('r0'))
    sourceTab = addWorkbenchRegion(sourceTab, 'r0', 'right', launcher('r1'))

    const result = promoteRegionToTab({
      tabs: { source: sourceTab },
      layouts: {},
      workspaceId: 'workspace',
      tabId: 'source',
      regionId: 'r1',
      mint: { tabId: 'new-tab' }
    })

    expect(result.kind).toBe('unchanged')
  })

  it('源 Tab 在 tabs 里却不属于任何 layout 分组：no-op——否则新 Tab 会成永不显示、永不可关的孤儿', () => {
    // insertTabAfter 找不到锚点所在分组时原样返回旧 layout（同一引用）。若照旧判 promoted，新 Tab 会
    // 进 tabs 而不落进任何 group.tabOrder——正是 addTabPlacement JSDoc 描述的孤儿。fixture：源 Tab 多格、
    // 有该 workspace 的 layout（越过前面所有守卫），但那个 layout 的分组里只有别的 Tab，没有 source。
    let sourceTab = createWorkbenchTab('source', launcher('r0'))
    sourceTab = addWorkbenchRegion(sourceTab, 'r0', 'right', launcher('r1'))

    const result = promoteRegionToTab({
      tabs: { source: sourceTab },
      layouts: { workspace: createWorkspaceLayout('group-one', ['some-other-tab']) },
      workspaceId: 'workspace',
      tabId: 'source',
      regionId: 'r1',
      mint: { tabId: 'new-tab' }
    })

    expect(result.kind, '源 Tab 不在任何分组里，促升却仍造出新 Tab（会成孤儿）').toBe('unchanged')
    if (result.kind === 'promoted') expect(result.tabs['new-tab']).toBeUndefined()
  })

  it('文件格豁免：促升一个 file 格是 no-op，且非文件格仍能促升——豁免只挡 file 这一种', () => {
    // 文件面的宿主 Tab 由 fileTabId(path) 这个 canonical id 寻址；把 file 面搬进 view:… Tab 会让
    // reduceDocumentAttached / reduceDocumentLoadFailed 按 canonical id 找不到它（重开文件会造重复、
    // 重载/失败会漏掉这一格）。所以 file 格不可促升——这正是 move-session-view 只搬 agent/terminal 的同一条理由。
    // 用「同一张 Tab 里，file 格拒、相邻的非 file 格准」逼出判据：只挡 file，不误伤别的 kind。
    let sourceTab = createWorkbenchTab('source', file('f0', 'a.txt'))
    sourceTab = addWorkbenchRegion(sourceTab, 'f0', 'right', launcher('r1'))
    const layouts = { workspace: createWorkspaceLayout('group-one', ['source']) }

    // 促升 file 格：no-op。
    const fileResult = promoteRegionToTab({
      tabs: { source: sourceTab },
      layouts,
      workspaceId: 'workspace',
      tabId: 'source',
      regionId: 'f0',
      mint: { tabId: 'new-tab' }
    })
    expect(fileResult.kind, 'file 格被促升进了 view:… Tab——破坏文件宿主 Tab 的 canonical-id 不变量').toBe('unchanged')

    // 同一 fixture 里促升相邻的 launcher 格：照旧成功。若豁免写成「非 file 才 no-op」之类的取反，这一条会红。
    const launcherResult = promoteRegionToTab({
      tabs: { source: sourceTab },
      layouts,
      workspaceId: 'workspace',
      tabId: 'source',
      regionId: 'r1',
      mint: { tabId: 'new-tab' }
    })
    expect(launcherResult.kind, '豁免误伤了非 file 格').toBe('promoted')
  })
})
