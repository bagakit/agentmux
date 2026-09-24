import { createContext, useContext } from 'react'

/** Spatial visibility alone does not authorize launcher activation or a focus move. */
export const WorkbenchPresentationContext = createContext(true)
export function useWorkbenchPresentationActive(): boolean { return useContext(WorkbenchPresentationContext) }
export type WorkbenchViewTarget = { hostId: string; active: boolean }
