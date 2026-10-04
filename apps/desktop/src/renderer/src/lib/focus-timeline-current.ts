import type { AgentMuxDesktopSpaceSelection, AgentMuxSpaceCatalog } from '@agentmux/core'
import type { WorkspaceLayout } from '@agentmux/layout'
import type { WorkbenchTab } from './workbench-tabs'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { projectWorkbenchSpaceSelection } from './desktop-focus-navigation'

/** Read the original exact main choice; execution MRU and local Tab activity are not substitutes. */
export function focusTimelineCurrentReference(choice: AgentMuxDesktopSpaceSelection | null,
  layout: WorkspaceLayout | undefined, tabs: Readonly<Record<string, WorkbenchTab>>,
  catalog: AgentMuxSpaceCatalog | null): WorkbenchProjectionSelection | null {
  if (!choice?.tabId || !choice.groupId || !choice.regionId || !catalog) return null
  if (!catalog.locations.some(location => location.spaceId === choice.spaceId && location.zoneId === choice.zoneId &&
    location.displayWorkspaceId === choice.workspaceId && location.groupId === choice.groupId &&
    location.tabId === choice.tabId && location.regionId === choice.regionId)) return null
  const original = projectWorkbenchSpaceSelection(layout, tabs, catalog, choice)
  if (!original.confirmed || !tabs[choice.tabId]?.regions[choice.regionId]) return null
  return { displayWorkspaceId: choice.workspaceId, groupId: choice.groupId,
    tabId: choice.tabId, regionId: choice.regionId }
}
