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
})
