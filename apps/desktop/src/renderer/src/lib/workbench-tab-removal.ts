import type { WorkbenchTab } from './workbench-tabs'

export type RemovedTabPlacement = { displayWorkspaceId: string; groupId: string; tabOrder: readonly string[] }

// A transient committed fact, not close intent, a boolean receipt, or a history registry.
const listeners = new Set<(tab: WorkbenchTab, placement: RemovedTabPlacement) => void>()
export function subscribeWorkbenchTabRemoved(listener: (tab: WorkbenchTab, placement: RemovedTabPlacement) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function publishWorkbenchTabRemoved(tab: WorkbenchTab, placement: RemovedTabPlacement, reportError: (error: unknown) => void): void {
  for (const listener of listeners) {
    try { listener(tab, placement) }
    catch (error) { reportError(error) }
  }
}
