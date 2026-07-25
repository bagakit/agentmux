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
})
