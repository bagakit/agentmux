import { createContext, useContext } from 'react'

/** Spatial visibility alone does not authorize launcher activation or a focus move. */
export type BrowserControlConfirmation = (regionId: string, unconfirmed: boolean) => void
export type WorkbenchPresentation = { active: boolean; retainedRegionId: string | null; tabHostId?: string | undefined; survey?: boolean | undefined; controlsOpen?: boolean | undefined; onBrowserControlConfirmation?: BrowserControlConfirmation | undefined; onSelectRegion?: ((regionId: string) => void) | undefined }
export const WorkbenchPresentationContext = createContext<WorkbenchPresentation>({ active: true, retainedRegionId: null })
export function useWorkbenchPresentationActive(): boolean { return useContext(WorkbenchPresentationContext).active }
/** The existing View owner supplies only the retained hint applicable to this presentation. */
export function useWorkbenchRetainedRegionId(): string | null { return useContext(WorkbenchPresentationContext).retainedRegionId }
export function useWorkbenchBrowserPresentation() { return useContext(WorkbenchPresentationContext) }
export type WorkbenchViewTarget = { hostId: string; active: boolean; visible?: boolean; surface?: 'survey'; controlsOpen?: boolean; retainedRegionId?: string; onSelectRegion?: (regionId: string) => void }
