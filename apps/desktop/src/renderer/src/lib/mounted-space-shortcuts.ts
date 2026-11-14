import { focusWorkbenchRegion, regionInDirection, workbenchRegionBounds } from '@agentmux/layout'
import type { SpaceMountView } from '../../../shared/space-mount'
import { mountedSpaceInput, projectMountedSpaceView, type MountedSpaceObservation } from './space-mount-view'
import { tabIdForOrdinal, tabIdForStep, type WorkbenchShortcutCommand } from './workbench-shortcuts'

/** Presentation commands stay in the selected source view. No local control fallback. */
export function dispatchMountedSpaceCommand(command: WorkbenchShortcutCommand, store: {
  selectedSpaceMount?: unknown; mountedSpaceInputs?: unknown; mountedSpaceObservations?: Record<string, MountedSpaceObservation>
  editSpaceMountView?(key: string, view: SpaceMountView): void
}): boolean {
  if (typeof store.selectedSpaceMount !== 'string') return false
  const key = store.selectedSpaceMount
  let input: ReturnType<typeof mountedSpaceInput>
  try { input = mountedSpaceInput(store.mountedSpaceInputs, key) } catch { return false }
  if (!input || !store.editSpaceMountView) return false
  const observation = store.mountedSpaceObservations?.[key], snapshot = observation?.snapshot?.scope.space === null ? observation.lastPresentSnapshot : observation?.snapshot
  const view = snapshot ? projectMountedSpaceView(input.view, snapshot) : input.view
  if (!view) return false
  const group = view.composition.groups.find(group => group.id === view.composition.activeGroupId)
  if (!group) return false
  const tabId = command.kind === 'select-tab' ? tabIdForOrdinal(group.tabOrder, command.ordinal)
    : command.kind === 'step-tab' ? tabIdForStep(group.tabOrder, group.activeTabId, command.delta) : group.activeTabId
  const layout = tabId && view.tabLayouts[tabId]
  if (!tabId || !layout) return false
  const regionId = command.kind === 'focus-region' ? regionInDirection(workbenchRegionBounds(layout.root), layout.activeRegionId, command.direction) : layout.activeRegionId
  if (!regionId || !['select-tab', 'step-tab', 'focus-region'].includes(command.kind)) return false
  store.editSpaceMountView(key, { ...view, composition: { ...view.composition, groups: view.composition.groups.map(item => item.id === group.id ? { ...item, activeTabId: tabId } : item) },
    tabLayouts: { ...view.tabLayouts, [tabId]: focusWorkbenchRegion(layout, regionId) }, selection: { groupId: group.id, tabId, regionId } })
  return true
}
