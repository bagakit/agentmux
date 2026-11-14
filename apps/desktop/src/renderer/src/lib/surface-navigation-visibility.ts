import { isScratchWorkspaceId } from '../../../shared/contracts'
import { activeTopicIdFromLayout, layoutForActiveTopic } from './scratch-topic-layout'
import type { WorkspaceLayout } from '@agentmux/layout'
import type { WorkbenchTab } from './workbench-tabs'

type Tabs = Readonly<Record<string, WorkbenchTab>>

/** Shared visibility for resource and attention consumers. A covered Tab can belong to the active context. */
export function surfaceNavigationVisibility(
  tab: WorkbenchTab,
  layout: WorkspaceLayout,
  tabs: Tabs,
  input: { activeWorkspaceId: string | null; workbenchVisible: boolean; projectedVisibleTabIds?: ReadonlySet<string> | undefined; projectedVisibleRegionIds?: ReadonlySet<string> | undefined },
  regionId?: string
): { navigationContextActive: boolean; tabVisible: boolean } {
  if (regionId && input.projectedVisibleRegionIds?.has(regionId)) return { navigationContextActive: true, tabVisible: true }
  // Focus/floating destinations show the original Tab outside its base navigation context.
  // Both resource owners consume this same fact; a visible projection cannot be reclaimed.
  if (input.projectedVisibleTabIds?.has(tab.id)) return { navigationContextActive: true, tabVisible: true }
  if (!input.workbenchVisible || input.activeWorkspaceId !== tab.workspaceId) {
    return { navigationContextActive: false, tabVisible: false }
  }

  const activeTopicId = isScratchWorkspaceId(tab.workspaceId)
    ? activeTopicIdFromLayout(layout, tabs)
    : null
  // Unbound tabs stay in the current Scratch context. Other Topics stay warm on navigation.
  const navigationContextActive = activeTopicId === null || tab.topicId === undefined || tab.topicId === activeTopicId
  const projected = activeTopicId
    ? layoutForActiveTopic(layout, tabs, activeTopicId)
    : layout
  const group = projected.groups.find((candidate) => candidate.tabOrder.includes(tab.id))
  return {
    navigationContextActive,
    tabVisible: group?.activeTabId === tab.id
  }
}
