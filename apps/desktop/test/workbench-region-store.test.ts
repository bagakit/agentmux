import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  createWorkbenchTab,
  initialWorkbenchRegionId
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
