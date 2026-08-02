import { describe, expect, it } from 'vitest'
import { regionIds } from '../src/renderer/src/lib/workbench-view-layout'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  removeWorkbenchRegion,
  type WorkbenchSurface,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs'
import { promoteRegionToTab } from '../src/renderer/src/lib/promote-region-to-tab'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout'

// #494 gap：分屏树里的 regionId 集合，必须与 tab.regions 这张表的 key 集合逐一相等。此前这条只由
// addWorkbenchRegion / removeWorkbenchRegion 「两处一起改」的约定维持，没有任何守卫——树里多一格
// （画不出、回收不掉的孤儿）或 regions 表里多一格（永远画不到的死记录）都是零报错的未定义行为。
// 这个谓词把「两侧集合相等」变成可断言的性质，套在每个真实操作之后。
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

function launcher(regionId: string): WorkbenchSurface {
  return { regionId, kind: 'launcher', workspaceId: 'workspace' }
}

describe('tab 布局树 ↔ tab.regions 集合不变量（#494 gap）', () => {
  it('创建、追加、关闭全程两侧集合始终相等', () => {
    let tab = createWorkbenchTab('view', launcher('r0'))
    expectInvariant(tab)

    for (const id of ['r1', 'r2', 'r3']) {
      tab = addWorkbenchRegion(tab, tab.layout.activeRegionId, 'right', launcher(id))
      expectInvariant(tab)
    }
    expect(regionSetsAgree(tab).tree).toEqual(['r0', 'r1', 'r2', 'r3'])

    // 关掉中间一格：树与表都必须少掉恰好那一个 id，不多不少。
    const afterClose = removeWorkbenchRegion(tab, 'r2')!
    expectInvariant(afterClose)
    expect(regionSetsAgree(afterClose).tree).toEqual(['r0', 'r1', 'r3'])
  })

  it('关闭活动格后，剩下的树与表仍然逐一相等，且 activeRegionId 指向仍在场的格', () => {
    let tab = createWorkbenchTab('view', launcher('r0'))
    tab = addWorkbenchRegion(tab, 'r0', 'right', launcher('r1'))
    // 追加后活动格是 r1（splitWorkbenchRegion 把新格设为活动）。关掉它。
    const closed = removeWorkbenchRegion(tab, 'r1')!
    expectInvariant(closed)
    expect(regionSetsAgree(closed).map).toContain(closed.layout.activeRegionId)
  })

  // #487 promote：把一格单独变成新 Tab。这条把创建/追加/关闭那套「两侧集合相等」的纪律延伸到促升——
  // 促升同时改两张 Tab（源 Tab 少一格、新 Tab 恰一格），两侧都必须逐一相等，且跨两张 Tab 总格数守恒
  // （既不丢也不重复）。
  it('促升一格后，源 Tab 与新 Tab 两侧集合各自相等，且总格数守恒', () => {
    let tab = createWorkbenchTab('source', launcher('r0'))
    tab = addWorkbenchRegion(tab, 'r0', 'right', launcher('r1'))
    tab = addWorkbenchRegion(tab, 'r0', 'right', launcher('r2'))
    expectInvariant(tab)
    const before = regionIds(tab.layout.root).length
    expect(before).toBe(3)

    const result = promoteRegionToTab({
      tabs: { source: tab },
      layouts: { workspace: createWorkspaceLayout('group-one', ['source']) },
      workspaceId: 'workspace',
      tabId: 'source',
      regionId: 'r1',
      mint: { tabId: 'new-tab' }
    })
    expect(result.kind).toBe('promoted')
    if (result.kind !== 'promoted') throw new Error('unreachable')

    const nextSource = result.tabs.source!
    const newTab = result.tabs['new-tab']!
    // 两侧各自逐一相等（不变量#1，在源 Tab 与新 Tab 上分别成立）。
    expectInvariant(nextSource)
    expectInvariant(newTab)
    // 总格数守恒：促升前 3 格 = 源剩下的 + 新 Tab 的。
    const after = Object.keys(nextSource.regions).length + Object.keys(newTab.regions).length
    expect(after).toBe(before)
    // 具体去向：源剩 r0/r2，新 Tab 恰 r1。
    expect(regionSetsAgree(nextSource).map).toEqual(['r0', 'r2'])
    expect(regionSetsAgree(newTab).map).toEqual(['r1'])
  })
})
