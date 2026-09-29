import type { WorkbenchTab } from './workbench-tabs'

// A transient committed fact, not close intent, a boolean receipt, or a history registry.
const listeners = new Set<(tab: WorkbenchTab) => void>()
export function subscribeWorkbenchTabRemoved(listener: (tab: WorkbenchTab) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function publishWorkbenchTabRemoved(tab: WorkbenchTab, reportError: (error: unknown) => void): void {
  for (const listener of listeners) {
    try { listener(tab) }
    catch (error) { reportError(error) }
  }
}
