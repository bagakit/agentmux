import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  createWorkbenchTab,
  initialWorkbenchRegionId,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { regionIds } from '../src/renderer/src/lib/workbench-view-layout.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialState, true)
})

describe('Tab Region store actions', () => {
  it('splits and closes content inside one Tab without creating a Tab or Tab Group', async () => {
    const tabId = 'view-one'
    const rootRegionId = initialWorkbenchRegionId(tabId)
    const tab = createWorkbenchTab(tabId, {
      regionId: rootRegionId,
      kind: 'launcher',
      workspaceId: 'workspace'
    })
    useAppStore.setState({
      tabs: { [tabId]: tab },
      layouts: { workspace: createWorkspaceLayout('group-one', [tabId]) }
    })

    useAppStore.getState().splitRegion('workspace', tabId, rootRegionId, 'right')

    const split = useAppStore.getState()
    const splitTab = split.tabs[tabId]!
    const addedRegionId = regionIds(splitTab.layout.root).find((id) => id !== rootRegionId)!
    expect(split.layouts.workspace?.groups).toHaveLength(1)
    expect(split.layouts.workspace?.groups[0]?.tabOrder).toEqual([tabId])
    expect(Object.keys(split.tabs)).toEqual([tabId])
    expect(splitTab.layout.root).toMatchObject({ type: 'split', direction: 'horizontal' })
    expect(splitTab.regions[addedRegionId]).toMatchObject({ kind: 'launcher' })

    await useAppStore.getState().closeRegion('workspace', tabId, addedRegionId)

    const closed = useAppStore.getState().tabs[tabId]!
    expect(closed.layout.root).toEqual({ type: 'leaf', regionId: rootRegionId })
    expect(Object.keys(closed.regions)).toEqual([rootRegionId])
  })

  it('moves the whole Tab to a new group without changing its Region tree', () => {
    const tabId = 'view-one'
    const rootRegionId = initialWorkbenchRegionId(tabId)
    const tab = createWorkbenchTab(tabId, {
      regionId: rootRegionId,
      kind: 'launcher',
      workspaceId: 'workspace'
    })
    const neighbor = createWorkbenchTab('view-two', {
      regionId: initialWorkbenchRegionId('view-two'),
      kind: 'launcher',
      workspaceId: 'workspace'
    })
    useAppStore.setState({
      tabs: { [tabId]: tab, [neighbor.id]: neighbor },
      layouts: { workspace: createWorkspaceLayout('group-one', [tabId, neighbor.id]) }
    })
    useAppStore.getState().splitRegion('workspace', tabId, rootRegionId, 'down')
    const before = structuredClone(useAppStore.getState().tabs[tabId]!.layout)

    useAppStore.getState().moveTabToNewGroup(
      'workspace',
      tabId,
      'group-one',
      'group-one',
      'right'
    )

    const state = useAppStore.getState()
    expect(state.layouts.workspace?.groups).toHaveLength(2)
    expect(state.tabs[tabId]?.layout).toEqual(before)
  })

  it('requestCloseTab 只投意图不真关，clearCloseTabRequest 只清自己那一条', () => {
    // 键盘关 Tab 的落点是「投意图 → 组件消费」。这里守 store 侧的两半：意图带齐落点、每投一次 nonce 递增
    // （连按能各触发一次），以及清除只认自己的 nonce——被更晚一次按键覆盖后不该把新意图也抹掉。
    useAppStore.getState().requestCloseTab('workspace', 'group-one', 'view-one')
    const first = useAppStore.getState().closeTabRequest
    expect(first).toMatchObject({ workspaceId: 'workspace', tabGroupId: 'group-one', tabId: 'view-one' })

    useAppStore.getState().requestCloseTab('workspace', 'group-one', 'view-one')
    const second = useAppStore.getState().closeTabRequest
    expect(second?.nonce).toBe((first?.nonce ?? 0) + 1)

    // 用过时的 nonce 清：被更晚的意图覆盖了，不该清掉。
    useAppStore.getState().clearCloseTabRequest(first!.nonce)
    expect(useAppStore.getState().closeTabRequest).toBe(second)

    // 用当前 nonce 清：意图归零。
    useAppStore.getState().clearCloseTabRequest(second!.nonce)
    expect(useAppStore.getState().closeTabRequest).toBeNull()
  })

  it('requestCloseRegion 只投意图不真关，clearCloseRegionRequest 只清自己那一条', () => {
    // 键盘关某一格的落点也是「投意图 → 承载该格的组件消费」——那格的未保存确认（dirty→对话框）只活在组件里，
    // 与鼠标点这一格的 X 同一条路。这里守 store 侧的两半：意图带齐落点、每投一次 nonce 递增（连按能各触发
    // 一次），以及清除只认自己的 nonce——被更晚一次按键覆盖后不该把新意图也抹掉。
    useAppStore.getState().requestCloseRegion('workspace', 'view-one', 'region-a')
    const first = useAppStore.getState().closeRegionRequest
    expect(first).toMatchObject({ workspaceId: 'workspace', tabId: 'view-one', regionId: 'region-a' })

    useAppStore.getState().requestCloseRegion('workspace', 'view-one', 'region-a')
    const second = useAppStore.getState().closeRegionRequest
    expect(second?.nonce).toBe((first?.nonce ?? 0) + 1)

    // 用过时的 nonce 清：被更晚的意图覆盖了，不该清掉。
    useAppStore.getState().clearCloseRegionRequest(first!.nonce)
    expect(useAppStore.getState().closeRegionRequest).toBe(second)

    // 用当前 nonce 清：意图归零。
    useAppStore.getState().clearCloseRegionRequest(second!.nonce)
    expect(useAppStore.getState().closeRegionRequest).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 布局预设的 GUI 入口。
//
// 预设引擎（columns-3 / grid-4 / grid-6 / grid-9）此前只有控制协议一个调用方，GUI 完全触达不到。
// 接第二个调用方时的风险不在「摆得对不对」，而在「补几个格」这次推导会不会被抄第二份：抄错的
// 那侧算出的数量与引擎的 required - present 校验不符，用户点了预设只会收到内部错误串，而另一侧
// 照旧工作——症状是同一个预设从菜单点没反应、从命令行却好用。
//
// 所以下面两族分开：行为层判「真的摆成了那个形状」，接线层判「算 additions 只有一处」。
// 各自的变异只该红各自那层（见记忆 mutation-must-change-one-thing）。
// ---------------------------------------------------------------------------
describe('arrangeTabRegions', () => {
  function singleRegionFixture(): { tabId: string; rootRegionId: string } {
    const tabId = 'view-arrange'
    const rootRegionId = initialWorkbenchRegionId(tabId)
    useAppStore.setState({
      tabs: {
        [tabId]: createWorkbenchTab(tabId, {
          regionId: rootRegionId,
          kind: 'launcher',
          workspaceId: 'workspace'
        })
      },
      layouts: { workspace: createWorkspaceLayout('group-one', [tabId]) }
    })
    return { tabId, rootRegionId }
  }

  it('对单格 Tab 施加 grid-4：补出 3 个 launcher 格，且 layout 真的是 2×2', () => {
    const { tabId, rootRegionId } = singleRegionFixture()

    useAppStore.getState().arrangeTabRegions('workspace', tabId, 'grid-4')

    const tab = useAppStore.getState().tabs[tabId]!
    // 「没抛」不是判据：静默 no-op 也不抛。判 regions 表与 layout 树两侧都真的动了。
    const ids = regionIds(tab.layout.root)
    expect(ids, 'layout 树里不是 4 格——预设没真的施加').toHaveLength(4)
    expect(ids, '原来那一格被丢了').toContain(rootRegionId)
    expect(Object.keys(tab.regions), 'regions 表与 layout 树格数不一致').toHaveLength(4)
    for (const regionId of ids) {
      expect(tab.regions[regionId], `${regionId} 在树上却没有对应的 surface`).toMatchObject({
        kind: 'launcher',
        workspaceId: 'workspace'
      })
    }

    // 2×2 的形状：外层竖分，两侧各自横分。摆成一行四列（lineLayout）也满足「4 格」，
    // 只有判到树的结构才认得出。
    expect(tab.layout.root).toMatchObject({
      type: 'split',
      direction: 'vertical',
      first: { type: 'split', direction: 'horizontal' },
      second: { type: 'split', direction: 'horizontal' }
    })
  })

  it('columns-3 摆成一行三列，不是 2×2——不同预设不能塌成同一个形状', () => {
    const { tabId } = singleRegionFixture()

    useAppStore.getState().arrangeTabRegions('workspace', tabId, 'columns-3')

    const tab = useAppStore.getState().tabs[tabId]!
    expect(regionIds(tab.layout.root)).toHaveLength(3)
    // 一行三列：整棵树只有横分，没有任何竖分。把 preset 参数忽略掉、恒用 grid 的实现会在这里红。
    expect(tab.layout.root).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      second: { type: 'split', direction: 'horizontal' }
    })
  })

  it('补出来的格 id 互不相同，也不撞已在场的', () => {
    // applyWorkbenchRegionLayoutPreset 撞名时原样返回旧 layout（它自己那道 Set 检查），
    // 于是 regions 多了几格而树没变——多出来的格永远画不出也回收不掉。引擎为此在自己那侧加了
    // 一道响亮的 CONTROL_FAILED；这一条从外面钉住结果：树上就是 9 个互不相同的 id。
    const { tabId } = singleRegionFixture()

    useAppStore.getState().arrangeTabRegions('workspace', tabId, 'grid-9')

    const tab = useAppStore.getState().tabs[tabId]!
    const ids = regionIds(tab.layout.root)
    expect(new Set(ids).size, '树上出现了重复的 region id').toBe(9)
    expect(new Set(Object.keys(tab.regions)).size).toBe(9)
  })

  it('格数已超预设时不动布局，并且响亮报错——不是静默什么也不发生', () => {
    // 引擎抛 LAYOUT_CAPACITY_EXCEEDED（丢格子就是丢用户正在看的东西）。菜单侧本来就不列
    // 这种项，但键盘/命令面板/控制协议都可能送进来，store 这一层咽掉错误就成了「点了没反应」。
    const { tabId, rootRegionId } = singleRegionFixture()
    useAppStore.getState().splitRegion('workspace', tabId, rootRegionId, 'right')
    const before = useAppStore.getState().tabs[tabId]!
    expect(regionIds(before.layout.root), '前提自检：fixture 没能分出两格').toHaveLength(2)

    const reportError = vi.fn()
    useAppStore.setState({ reportError })

    useAppStore.getState().arrangeTabRegions('workspace', tabId, 'columns-3')
    expect(useAppStore.getState().tabs[tabId], 'columns-3 装得下两格，这一条的前提本身就错了')
      .not.toBe(before)

    // 真正装不下的那一档：凑到 4 格再去撞 columns-3（容量 3）。
    const three = useAppStore.getState().tabs[tabId]!
    const anyRegionId = regionIds(three.layout.root)[0]!
    useAppStore.getState().splitRegion('workspace', tabId, anyRegionId, 'down')
    const four = useAppStore.getState().tabs[tabId]!
    expect(regionIds(four.layout.root), '前提自检：没能凑到 4 格').toHaveLength(4)

    reportError.mockClear()
    useAppStore.getState().arrangeTabRegions('workspace', tabId, 'columns-3')

    expect(useAppStore.getState().tabs[tabId], '装不下却改了布局——有格子被丢了').toBe(four)
    expect(reportError, '装不下时静默什么也不做：用户点了没反应且无从查').toHaveBeenCalledTimes(1)
  })

  it('workspace 不匹配时什么都不做——不能跨项目改别人的 Tab', () => {
    const { tabId } = singleRegionFixture()
    const before = useAppStore.getState().tabs[tabId]!

    useAppStore.getState().arrangeTabRegions('other-workspace', tabId, 'grid-4')

    expect(useAppStore.getState().tabs[tabId]).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// #471 换位的 GUI 入口。
//
// 布局代数（swapWorkbenchRegions）在 workbench-view-layout.test.ts 里钉着；这里钉的是 store 动作
// 真的把它接上了：换对了两格、内容跟着 id 走、挂不上时（不匹配 / 与自己换 / 端点不在场）稳定不动。
// ---------------------------------------------------------------------------
describe('swapRegions', () => {
  function twoRegionFixture(): { tabId: string; rootRegionId: string; addedRegionId: string } {
    const tabId = 'view-swap'
    const rootRegionId = initialWorkbenchRegionId(tabId)
    useAppStore.setState({
      tabs: {
        [tabId]: createWorkbenchTab(tabId, {
          regionId: rootRegionId,
          kind: 'launcher',
          workspaceId: 'workspace'
        })
      },
      layouts: { workspace: createWorkspaceLayout('group-one', [tabId]) }
    })
    useAppStore.getState().splitRegion('workspace', tabId, rootRegionId, 'right')
    const tab = useAppStore.getState().tabs[tabId]!
    const addedRegionId = regionIds(tab.layout.root).find((id) => id !== rootRegionId)!
    return { tabId, rootRegionId, addedRegionId }
  }

  it('把两格在既有布局里对调：顺序翻转，内容（regions 表）一字不动', () => {
    const { tabId, rootRegionId, addedRegionId } = twoRegionFixture()
    const before = useAppStore.getState().tabs[tabId]!
    expect(regionIds(before.layout.root)).toEqual([rootRegionId, addedRegionId])

    useAppStore.getState().swapRegions('workspace', tabId, rootRegionId, addedRegionId)

    const after = useAppStore.getState().tabs[tabId]!
    // 位置互换：读序反了过来。
    expect(regionIds(after.layout.root)).toEqual([addedRegionId, rootRegionId])
    // 内容没动：两格的 surface 都还在，键集合与换前逐一相等。
    expect(new Set(Object.keys(after.regions))).toEqual(new Set([rootRegionId, addedRegionId]))
    expect(after.regions[rootRegionId]).toBe(before.regions[rootRegionId])
    expect(after.regions[addedRegionId]).toBe(before.regions[addedRegionId])
  })

  it('与自己换、或端点不在场时稳定不动（同一对象，避免无谓重渲染）', () => {
    const { tabId, rootRegionId } = twoRegionFixture()
    const before = useAppStore.getState().tabs[tabId]!
    useAppStore.getState().swapRegions('workspace', tabId, rootRegionId, rootRegionId)
    expect(useAppStore.getState().tabs[tabId], '与自己换却改了布局').toBe(before)
    useAppStore.getState().swapRegions('workspace', tabId, rootRegionId, 'ghost')
    expect(useAppStore.getState().tabs[tabId], '端点不在场却改了布局').toBe(before)
  })

  it('workspace 不匹配时什么都不做——不能跨项目换别人 Tab 的格', () => {
    const { tabId, rootRegionId, addedRegionId } = twoRegionFixture()
    const before = useAppStore.getState().tabs[tabId]!
    useAppStore.getState().swapRegions('other-workspace', tabId, rootRegionId, addedRegionId)
    expect(useAppStore.getState().tabs[tabId]).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// #487「单独变成一个 tab」的 GUI/Store 入口。
//
// 布局代数（promoteRegionToTab）在 promote-region-to-tab.test.ts 里钉着；这里钉的是 store 动作真的把它
// 接上了：促升出一张新 Tab、落在源 Tab 紧邻其后并激活、两侧不变量成立、只剩一格是 no-op、跨项目/关闭中
// 的 View 都拒。fixture 刻意让源 Tab 不是 tabOrder 的最后一张，逼「活动=最后一张」「追加到队尾」两种错
// 实现都红。
// ---------------------------------------------------------------------------
describe('promoteRegionToTab', () => {
  // 三张 Tab：leading, source, trailing；source 被分成两格。source 不在队尾，故新 Tab 若落到队尾会红。
  function threeTabFixture(): {
    groupId: string
    sourceTabId: string
    leadingTabId: string
    trailingTabId: string
    rootRegionId: string
    addedRegionId: string
  } {
    const sourceTabId = 'view-source'
    const leadingTabId = 'view-leading'
    const trailingTabId = 'view-trailing'
    const rootRegionId = initialWorkbenchRegionId(sourceTabId)
    const make = (id: string): WorkbenchTab =>
      createWorkbenchTab(id, { regionId: initialWorkbenchRegionId(id), kind: 'launcher', workspaceId: 'workspace' })
    useAppStore.setState({
      tabs: {
        [leadingTabId]: make(leadingTabId),
        [sourceTabId]: createWorkbenchTab(sourceTabId, {
          regionId: rootRegionId,
          kind: 'launcher',
          workspaceId: 'workspace'
        }),
        [trailingTabId]: make(trailingTabId)
      },
      layouts: { workspace: createWorkspaceLayout('group-one', [leadingTabId, sourceTabId, trailingTabId]) },
      // 壳的取景刻意从"错的地方"起步：看着 board、且活动项目是别人。这样"促升后新 Tab 真的在屏上"
      // 才是可观测的性质——若照 store 的默认值（mainSurface 本来就是 'workbench'）起步，那条断言
      // 无论 store 写不写都恒真，是典型的假绿。
      mainSurface: 'board',
      activeWorkspaceId: 'some-other-workspace'
    })
    useAppStore.getState().splitRegion('workspace', sourceTabId, rootRegionId, 'right')
    const source = useAppStore.getState().tabs[sourceTabId]!
    const addedRegionId = regionIds(source.layout.root).find((id) => id !== rootRegionId)!
    return { groupId: 'group-one', sourceTabId, leadingTabId, trailingTabId, rootRegionId, addedRegionId }
  }

  function regionSets(tab: WorkbenchTab): { tree: string[]; map: string[] } {
    return { tree: [...regionIds(tab.layout.root)].sort(), map: Object.keys(tab.regions).sort() }
  }

  it('把一格促升成紧邻源 Tab 的新 Tab 并激活；两侧树↔regions 集合各自相等', () => {
    const { sourceTabId, leadingTabId, trailingTabId, rootRegionId, addedRegionId } = threeTabFixture()
    const beforeKeys = new Set(Object.keys(useAppStore.getState().tabs))
    const sourceSurfaceBefore = useAppStore.getState().tabs[sourceTabId]!.regions[addedRegionId]!
    // 判别器在场自检：下面两条取景断言只有在"起点 ≠ 期望值"时才判得动。这两句让 fixture 一旦
    // 被改回默认值就当场红，而不是让那两条断言悄悄退化成恒真。
    expect(useAppStore.getState().mainSurface, 'fixture 没有从 board 起步，取景断言会恒真').toBe('board')
    expect(
      useAppStore.getState().activeWorkspaceId,
      'fixture 没有从别的项目起步，切项目断言会恒真'
    ).not.toBe('workspace')

    useAppStore.getState().promoteRegionToTab('workspace', sourceTabId, addedRegionId)

    const state = useAppStore.getState()
    // 凭空多出的那一张就是新 Tab。
    const newTabId = Object.keys(state.tabs).find((id) => !beforeKeys.has(id))!
    expect(newTabId, '没有造出新 Tab').toBeTruthy()

    const source = state.tabs[sourceTabId]!
    const newTab = state.tabs[newTabId]!

    // 源 Tab 剩一格（rootRegion），新 Tab 恰一格（被促升那格），且内容整份搬走。
    expect(Object.keys(source.regions)).toEqual([rootRegionId])
    expect(Object.keys(newTab.regions)).toEqual([addedRegionId])
    expect(newTab.regions[addedRegionId], '内容不是原来那个 surface 对象').toBe(sourceSurfaceBefore)

    // 不变量#1：两侧树↔表逐一相等。
    expect(regionSets(source).tree, '源 Tab 树↔表不一致').toEqual(regionSets(source).map)
    expect(regionSets(newTab).tree, '新 Tab 树↔表不一致').toEqual(regionSets(newTab).map)

    // 落位：leading, source, new, trailing——紧邻源 Tab，且不是队尾。
    const group = state.layouts.workspace!.groups[0]!
    expect(group.tabOrder).toEqual([leadingTabId, sourceTabId, newTabId, trailingTabId])
    expect(group.tabOrder.indexOf(newTabId)).toBe(group.tabOrder.indexOf(sourceTabId) + 1)
    expect(group.tabOrder.at(-1), '新 Tab 落到了队尾（应紧邻源 Tab）').not.toBe(newTabId)
    // 活动的是新 Tab（不是 source、不是 trailing），且分组被聚焦。
    expect(group.activeTabId).toBe(newTabId)
    expect(state.layouts.workspace!.activeGroupId).toBe('group-one')

    // 新 Tab 那一格就是它自己的活动格——没有"促升出来却没有活动格"的中间态。
    expect(newTab.layout.activeRegionId, '新 Tab 没有活动格').toBe(addedRegionId)

    // 壳的取景：新 Tab 必须真的在屏上。reducer 管不到这两个字段（它只认 tabs/layouts），
    // fixture 刻意从"看着别的项目、且不在 workbench 上"起步，故这两条只有 store 真写了才绿。
    expect(state.mainSurface, '促升后没把 workbench 端到前面（新 Tab 在屏后）').toBe('workbench')
    expect(state.activeWorkspaceId, '促升后没切到新 Tab 所属的项目').toBe('workspace')
  })

  it('连续促升两格铸出两张不同的新 Tab——mint 不能是定值', () => {
    const { sourceTabId, rootRegionId, addedRegionId } = threeTabFixture()
    // 先把源 Tab 分成三格，才有两格可促升（促升到只剩一格就 no-op 了）。
    useAppStore.getState().splitRegion('workspace', sourceTabId, rootRegionId, 'down')
    const beforeKeys = new Set(Object.keys(useAppStore.getState().tabs))
    const thirdRegionId = regionIds(useAppStore.getState().tabs[sourceTabId]!.layout.root).find(
      (id) => id !== rootRegionId && id !== addedRegionId
    )!

    useAppStore.getState().promoteRegionToTab('workspace', sourceTabId, addedRegionId)
    useAppStore.getState().promoteRegionToTab('workspace', sourceTabId, thirdRegionId)

    const state = useAppStore.getState()
    const minted = Object.keys(state.tabs).filter((id) => !beforeKeys.has(id))
    // 两张各自独立的新 Tab：mint 若是定值，第二次会覆盖第一次，这里只剩 1 个。
    expect(minted, '两次促升没有铸出两张不同的 Tab（mint 是定值？）').toHaveLength(2)
    expect(new Set(minted).size).toBe(2)
    // 且两张各自拿到自己那一格——不是一张 Tab 被改写两次。
    expect(minted.map((id) => Object.keys(state.tabs[id]!.regions)).flat().sort()).toEqual(
      [addedRegionId, thirdRegionId].sort()
    )
    // 源 Tab 回到只剩一格，且两侧不变量仍成立。
    expect(Object.keys(state.tabs[sourceTabId]!.regions)).toEqual([rootRegionId])
    for (const id of [sourceTabId, ...minted]) {
      expect(regionSets(state.tabs[id]!).tree, `${id} 树↔表不一致`).toEqual(regionSets(state.tabs[id]!).map)
    }
  })

  it('促升把该 workspace 与 workbench 带到前台——用户点了「单独成 Tab」就该立刻看到它', () => {
    // fixture 刻意让 activeWorkspaceId / mainSurface 处于「错」的状态，逼促升去纠正它们：
    // 若动作只写 tabs/layouts 而不带前台框架，新 Tab 就造好了却不在屏上，这一条会红。
    const { sourceTabId, addedRegionId } = threeTabFixture()
    useAppStore.setState({ activeWorkspaceId: 'somewhere-else', mainSurface: 'board' })

    useAppStore.getState().promoteRegionToTab('workspace', sourceTabId, addedRegionId)

    const state = useAppStore.getState()
    expect(state.activeWorkspaceId, '促升没把该 workspace 带到前台').toBe('workspace')
    expect(state.mainSurface, '促升没切到 workbench 面').toBe('workbench')
    // 新 Tab 自身的活动格就是被促升那格（createWorkbenchViewLayout 造它时即设定）。
    const newTabId = Object.keys(state.tabs).find((id) => ![sourceTabId, 'view-leading', 'view-trailing'].includes(id))!
    expect(state.tabs[newTabId]!.layout.activeRegionId, '新 Tab 的活动格不是被促升的那格').toBe(addedRegionId)
  })

  it('促升只剩一格的 Tab 是 no-op——它已经就是一张 Tab', () => {
    const tabId = 'view-solo'
    const rootRegionId = initialWorkbenchRegionId(tabId)
    useAppStore.setState({
      tabs: { [tabId]: createWorkbenchTab(tabId, { regionId: rootRegionId, kind: 'launcher', workspaceId: 'workspace' }) },
      layouts: { workspace: createWorkspaceLayout('group-one', [tabId]) }
    })
    const beforeTabs = useAppStore.getState().tabs
    const beforeCount = Object.keys(beforeTabs).length

    useAppStore.getState().promoteRegionToTab('workspace', tabId, rootRegionId)

    const state = useAppStore.getState()
    // 没有凭空多出一张 Tab，且那张 Tab 对象原样未动。
    expect(Object.keys(state.tabs)).toHaveLength(beforeCount)
    expect(state.tabs[tabId]).toBe(beforeTabs[tabId])
  })

  it('workspace 不匹配时什么都不做——不能跨项目促升别人 Tab 的格', () => {
    const { sourceTabId, addedRegionId } = threeTabFixture()
    const beforeTabs = useAppStore.getState().tabs
    const beforeKeys = new Set(Object.keys(beforeTabs))

    useAppStore.getState().promoteRegionToTab('other-workspace', sourceTabId, addedRegionId)

    const state = useAppStore.getState()
    expect(state.tabs[sourceTabId], '跨项目却改了源 Tab').toBe(beforeTabs[sourceTabId])
    expect(Object.keys(state.tabs).some((id) => !beforeKeys.has(id)), '跨项目却造了新 Tab').toBe(false)
  })

  it('View 正在关闭时拒绝促升——不能把一格从正在拆除的 View 里半途搬走', () => {
    const { sourceTabId, addedRegionId } = threeTabFixture()
    const beforeTabs = useAppStore.getState().tabs
    const beforeKeys = new Set(Object.keys(beforeTabs))
    // 给源 Tab 挂一个关闭计划：workbenchViewCloseAllowsView 据此返回 false。
    useAppStore.setState({
      closingWorkbenchViews: {
        [sourceTabId]: {
          workspaceId: 'workspace',
          tabGroupId: 'group-one',
          tabId: sourceTabId,
          closesView: true,
          surfaces: [],
          resources: [],
          reservedSessionIds: []
        }
      }
    })

    useAppStore.getState().promoteRegionToTab('workspace', sourceTabId, addedRegionId)

    const state = useAppStore.getState()
    expect(state.tabs[sourceTabId], '关闭中的 View 却被促升改动了源 Tab').toBe(beforeTabs[sourceTabId])
    expect(Object.keys(state.tabs).some((id) => !beforeKeys.has(id)), '关闭中的 View 却造了新 Tab').toBe(false)
  })
})
