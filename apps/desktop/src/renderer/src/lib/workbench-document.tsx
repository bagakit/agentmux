import { createContext, useContext, useLayoutEffect } from 'react'
import type { AppWindowTarget } from '@agentmux/core/control'
import type { WorkbenchWindowDocument } from '../../../shared/workbench-windows'

export type WorkbenchWindowChrome = {
  identity: WorkbenchWindowDocument
  target: AppWindowTarget
  returnLabel: string
  onReturn(): void
  nativeControls: boolean
}
export type WorkbenchDocument = { document: Document; window: WorkbenchWindowDocument | null; chrome?: WorkbenchWindowChrome | null }
export const WorkbenchDocumentContext = createContext<WorkbenchDocument | null>(null)
/** The document actually hosting this original workbench tree. */
export function useWorkbenchDocument(): Document {
  return useContext(WorkbenchDocumentContext)?.document ?? document
}
export function useWorkbenchWindowDocument(): WorkbenchWindowDocument | null {
  return useContext(WorkbenchDocumentContext)?.window ?? null
}

/** The independent window actually hosting this content, including its exact Return operation. */
export function useWorkbenchWindowChrome(): WorkbenchWindowChrome | null {
  return useContext(WorkbenchDocumentContext)?.chrome ?? null
}

/** The hosted content supplies the native title throughout its original window placement. */
export function useWorkbenchWindowTitle(title: string | null): void {
  const doc = useWorkbenchDocument(), chrome = useWorkbenchWindowChrome()
  useLayoutEffect(() => {
    if (chrome && doc !== document && title) doc.title = title + ' · AgentMux'
  }, [doc, chrome, title])
}
