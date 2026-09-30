import { createContext, useContext } from 'react'
import { groupIds, type WorkspaceLayout } from '@agentmux/layout'
import type { WorkbenchTab } from './workbench-tabs'
import type { WorkbenchProjection, WorkbenchProjectionSelection } from './workbench-projection'

/** Spatial visibility alone does not authorize launcher activation or a focus move. */
export type BrowserControlConfirmation = (regionId: string, unconfirmed: boolean) => void
export type WorkbenchPresentation = { active: boolean; retainedRegionId: string | null; tabHostId?: string | undefined; survey?: boolean | undefined; controlsOpen?: boolean | undefined; onBrowserControlConfirmation?: BrowserControlConfirmation | undefined; onSelectRegion?: ((regionId: string) => void) | undefined; projection?: WorkbenchProjection | undefined; reference?: WorkbenchProjectionSelection | undefined }
export const WorkbenchPresentationContext = createContext<WorkbenchPresentation>({ active: true, retainedRegionId: null })
export function useWorkbenchPresentationActive(): boolean { return useContext(WorkbenchPresentationContext).active }
/** The existing View owner supplies only the retained hint applicable to this presentation. */
export function useWorkbenchRetainedRegionId(): string | null { return useContext(WorkbenchPresentationContext).retainedRegionId }
export function useWorkbenchBrowserPresentation() { return useContext(WorkbenchPresentationContext) }
export type WorkbenchViewTarget = { hostId: string; active: boolean; visible?: boolean; surface?: 'survey' | 'focus' | 'space'; controlsOpen?: boolean; retainedRegionId?: string; headerPortalTargetId?: string; onSelectRegion?: (regionId: string) => void; projection?: WorkbenchProjection; reference?: WorkbenchProjectionSelection }

/** A shared entity in multiple Groups has no uniquely proven ordinary home occurrence. */
export function workbenchHomePresentationReferences(layout: WorkspaceLayout | undefined, displayWorkspaceId: string, tabs: Readonly<Record<string, WorkbenchTab>>): ReadonlyMap<string, WorkbenchProjectionSelection | null> {
  const references = new Map<string, WorkbenchProjectionSelection | null>()
  if (!layout) return references
  const visibleGroups = new Set(groupIds(layout.root))
  for (const group of layout.groups) if (visibleGroups.has(group.id)) for (const tabId of new Set(group.tabOrder)) {
    const regionId = tabs[tabId]?.layout.activeRegionId
    if (!regionId || !tabs[tabId]?.regions[regionId]) continue
    references.set(tabId, references.has(tabId) ? null : { displayWorkspaceId, groupId: group.id, tabId, regionId })
  }
  return references
}
