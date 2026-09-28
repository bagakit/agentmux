import { createContext, useContext } from 'react'

/** Spatial visibility alone does not authorize launcher activation or a focus move. */
export const WorkbenchPresentationContext = createContext<{ active: boolean; retainedRegionId: string | null }>({ active: true, retainedRegionId: null })
export function useWorkbenchPresentationActive(): boolean { return useContext(WorkbenchPresentationContext).active }
/** The existing View owner supplies only the retained hint applicable to this presentation. */
export function useWorkbenchRetainedRegionId(): string | null { return useContext(WorkbenchPresentationContext).retainedRegionId }
export type WorkbenchViewTarget = { hostId: string; active: boolean }
