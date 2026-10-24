import { createContext, useContext } from 'react'
import { groupIds, type WorkspaceLayout } from '@agentmux/layout'
import type { WorkbenchTab } from './workbench-tabs'
import { sameWorkbenchProjectionSelection, workbenchRegionProjectionSlotId, type WorkbenchProjection, type WorkbenchProjectionSelection } from './workbench-projection'
import { desktopElementVisible } from './desktop-presentation'
import type { BrowserStartPageConfig } from '../../../shared/browser-start-page'

/** Spatial visibility alone does not authorize launcher activation or a focus move. */
export type BrowserControlConfirmation = (regionId: string, unconfirmed: boolean) => void
export type WorkbenchPresentation = { active: boolean; retainedRegionId: string | null; tabHostId?: string | undefined; surface?: WorkbenchViewTarget['surface']; survey?: boolean | undefined; controlsOpen?: boolean | undefined; onBrowserControlConfirmation?: BrowserControlConfirmation | undefined; onSelectRegion?: ((regionId: string) => void) | undefined; projection?: WorkbenchProjection | undefined; reference?: WorkbenchProjectionSelection | undefined }
export const WorkbenchPresentationContext = createContext<WorkbenchPresentation>({ active: true, retainedRegionId: null })
export function useWorkbenchPresentationActive(): boolean { return useContext(WorkbenchPresentationContext).active }
/** The existing View owner supplies only the retained hint applicable to this presentation. */
export function useWorkbenchRetainedRegionId(): string | null { return useContext(WorkbenchPresentationContext).retainedRegionId }
export function useWorkbenchBrowserPresentation() { return useContext(WorkbenchPresentationContext) }
export type WorkbenchViewTargets = Readonly<Record<string, readonly WorkbenchViewTarget[]>>
export type WorkbenchViewTarget = { hostId: string; active: boolean; visible?: boolean; surface?: 'recall' | 'survey' | 'focus' | 'space' | 'mote'; browserStartPage?: BrowserStartPageConfig; controlsOpen?: boolean; retainedRegionId?: string; headerPortalTargetId?: string; onSelectRegion?: (regionId: string) => void; projection?: WorkbenchProjection; reference?: WorkbenchProjectionSelection }

/** Resolve the original Browser occurrence inside an independently presented workface. */
export function workbenchBrowserWindowTarget(targets: readonly WorkbenchViewTarget[], owner: WorkbenchPresentation, regionId: string): WorkbenchViewTarget | undefined {
  if (!owner.reference) return
  // Tab slots retain their selected sibling as a caret hint. Their Browser
  // occurrence substitutes its own Region; Region projections remain exact below.
  const reference = { ...owner.reference, regionId }
  const matches = targets.filter(target => target.reference && sameWorkbenchProjectionSelection({ ...target.reference, regionId }, reference) &&
    (target.surface ?? 'space') === (owner.surface ?? 'space') && target.projection?.presentationId === owner.projection?.presentationId &&
    (target.projection?.entity.kind !== 'region' || target.projection.entity.regionId === regionId && target.reference.regionId === regionId))
  return matches.length === 1 ? matches[0] : undefined
}

/** A Tab's committed occurrence outlives its selected sibling, including closure. */
function committedTabMarkerMatches(tab: WorkbenchTab, prefix: 'primary' | 'view', reference: WorkbenchProjectionSelection, marker: string | undefined): boolean {
  if (!marker?.startsWith(`${prefix}:`)) return false
  try {
    const address: unknown = JSON.parse(marker.slice(prefix.length + 1))
    // The existing machine marker keeps its full Region address. Only Tab
    // placement ignores that historical caret; input and Region readers do not.
    return Array.isArray(address) && address.length === 4 && address.every(part => typeof part === 'string' && part.length > 0) &&
      address[0] === reference.displayWorkspaceId && address[1] === reference.groupId && address[2] === tab.id && address[2] === reference.tabId
  } catch { return false }
}

/** A mode change retains this exact live Tab placement; it does not claim input. */
export function committedPrimaryWorkbenchTarget(tab: WorkbenchTab, targets: readonly WorkbenchViewTarget[]): WorkbenchViewTarget | undefined {
  const matches = targets.filter(target => {
    const reference = target.reference
    if (!target.active || target.visible !== true || reference?.tabId !== tab.id ||
      !Object.hasOwn(tab.regions, reference.regionId) || target.projection?.entity.kind === 'region') return false
    const slot = document.getElementById(target.hostId)
    const primary = slot && [...slot.children].filter(child => child instanceof HTMLElement && child.dataset.workbenchPrimaryTabId === tab.id)
    return primary?.length === 1 && primary[0] instanceof HTMLElement && primary[0].isConnected &&
      committedTabMarkerMatches(tab, 'primary', reference, primary[0].dataset.workbenchPrimaryReference)
  })
  return matches.length === 1 ? matches[0] : undefined
}

/** Only the actual primary editable input can retain its committed, exact host. */
export function focusedPrimaryWorkbenchTarget(tab: WorkbenchTab, targets: readonly WorkbenchViewTarget[]): WorkbenchViewTarget | undefined {
  const input = document.activeElement
  if (!(input instanceof HTMLElement) || !(input.isContentEditable || input.matches('input, textarea'))) return
  const host = input.closest<HTMLElement>('[data-workbench-primary-tab-id]')
  const regionId = input.closest<HTMLElement>('[data-workbench-region-id]')?.dataset.workbenchRegionId
  if (host?.dataset.workbenchPrimaryTabId !== tab.id || !regionId || !Object.hasOwn(tab.regions, regionId)) return
  if (!desktopElementVisible(input) || !desktopElementVisible(host)) return
  return targets.find(target => target.visible === true && target.reference?.tabId === tab.id &&
    Object.hasOwn(tab.regions, target.reference.regionId) && target.hostId === host.parentElement?.id &&
    host.dataset.workbenchPrimaryReference === workbenchRegionProjectionSlotId('primary', target.reference))
}

/** Keep an editing secondary in place without moving the original primary into its slot. */
export function focusedSecondaryWorkbenchTarget(tab: WorkbenchTab, targets: readonly WorkbenchViewTarget[], homeId: string,
  homeReference: WorkbenchProjectionSelection | null | undefined, requestedInputRegionId?: string): WorkbenchViewTarget | undefined {
  const input = document.activeElement
  if (!(input instanceof HTMLElement) || !(input.isContentEditable || input.matches('input:not(:disabled):not([readonly]), textarea:not(:disabled):not([readonly])'))) return
  const regionId = input.closest<HTMLElement>('[data-workbench-region-id]')?.dataset.workbenchRegionId
  if (!regionId || !Object.hasOwn(tab.regions, regionId) || requestedInputRegionId === regionId) return
  const host = input.closest<HTMLElement>('[data-workbench-view-reference]')
  if (!host || host.dataset.workbenchPrimaryTabId || !desktopElementVisible(input) || !desktopElementVisible(host)) return
  const matches = targets.filter(target => target.visible === true && target.reference?.tabId === tab.id &&
    Object.hasOwn(tab.regions, target.reference.regionId) && target.hostId === host.parentElement?.id &&
    (target.projection?.entity.kind === 'region'
      ? host.dataset.workbenchViewReference === workbenchRegionProjectionSlotId('view', target.reference)
      : committedTabMarkerMatches(tab, 'view', target.reference, host.dataset.workbenchViewReference)))
  return matches.length === 1 ? committedSecondaryWorkbenchTarget(tab, matches[0], homeId, homeReference) : undefined
}

/** A committed secondary keeps its slot when human navigation moves input elsewhere. */
export function committedSecondaryWorkbenchTarget(tab: WorkbenchTab, target: WorkbenchViewTarget | undefined, homeId: string,
  homeReference: WorkbenchProjectionSelection | null | undefined): WorkbenchViewTarget | undefined {
  const reference = target?.reference
  if (target?.visible !== true || reference?.tabId !== tab.id || !Object.hasOwn(tab.regions, reference.regionId) ||
    homeReference?.tabId !== tab.id || !Object.hasOwn(tab.regions, homeReference.regionId)) return
  const home = document.getElementById(homeId)
  const primary = home && [...home.children].filter(child => child instanceof HTMLElement && child.dataset.workbenchPrimaryTabId === tab.id)
  if (primary?.length !== 1 || !(primary[0] instanceof HTMLElement) || !primary[0].isConnected ||
    !committedTabMarkerMatches(tab, 'primary', homeReference, primary[0].dataset.workbenchPrimaryReference)) return
  const slot = document.getElementById(target.hostId)
  const secondary = slot && [...slot.children].filter(child => child instanceof HTMLElement && !child.dataset.workbenchPrimaryTabId &&
    (target.projection?.entity.kind === 'region'
      ? child.dataset.workbenchViewReference === workbenchRegionProjectionSlotId('view', reference)
      : committedTabMarkerMatches(tab, 'view', reference, child.dataset.workbenchViewReference)))
  // Positioning can briefly hide a confirmed host. Retaining this exact tree
  // does not claim native input; focused input readers still check visibility.
  return secondary?.length === 1 && secondary[0] instanceof HTMLElement && secondary[0].isConnected ? target : undefined
}

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

/** A stage address is always the full occurrence, never the resource Workspace. */
export function workbenchBrowserStageHostId(target: WorkbenchViewTarget, regionId: string): string {
  const reference = target.reference!
  return `${target.hostId}:browser:${JSON.stringify([reference.displayWorkspaceId, reference.groupId, reference.tabId, regionId])}`
}
/** Agent reading stages use the same exact display occurrence as Browser stages. */
export function workbenchSessionStageHostId(target: WorkbenchViewTarget, regionId: string): string {
  const reference = target.reference!
  return `${target.hostId}:session:${JSON.stringify([reference.displayWorkspaceId, reference.groupId, reference.tabId, regionId])}`
}
export const WorkbenchBrowserTargetsContext = createContext<readonly WorkbenchViewTarget[]>([])
