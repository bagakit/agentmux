import { useAppStore } from '../store'
import type { WorkbenchProjectionSelection } from './workbench-projection'

/** Focus and the workbench enter the same exact-position confirmation flow. */
export function requestWorkbenchReferenceClose(reference: WorkbenchProjectionSelection): void {
  const state = useAppStore.getState(), tab = state.tabs[reference.tabId]
  const group = state.layouts[reference.displayWorkspaceId]?.groups.find(group => group.id === reference.groupId && group.tabOrder.includes(reference.tabId))
  if (!tab?.regions[reference.regionId] || !group) {
    state.reportError(Error('This workface position changed. Its Agent and inputs are retained; choose its current position before closing.'))
    return
  }
  if (Object.keys(tab.regions).length > 1) state.requestCloseRegion(reference.displayWorkspaceId, reference.tabId, reference.regionId, reference.groupId)
  else state.requestCloseTab(reference.displayWorkspaceId, reference.groupId, reference.tabId)
}
