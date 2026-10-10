import { createContext, useContext } from 'react'
import type { WorkbenchWindowDocument } from '../../../shared/workbench-windows'

export type WorkbenchDocument = { document: Document; window: WorkbenchWindowDocument | null }
export const WorkbenchDocumentContext = createContext<WorkbenchDocument | null>(null)
/** The document actually hosting this original workbench tree. */
export function useWorkbenchDocument(): Document {
  return useContext(WorkbenchDocumentContext)?.document ?? document
}
export function useWorkbenchWindowDocument(): WorkbenchWindowDocument | null {
  return useContext(WorkbenchDocumentContext)?.window ?? null
}
