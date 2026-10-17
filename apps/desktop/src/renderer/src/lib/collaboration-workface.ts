import type { FocusContext } from './focus-context'
import { workbenchSelectionCatalog, type NavigationState } from './desktop-focus-navigation'
import type { WorkbenchProjectionSelection } from './workbench-projection'

/** A display occurrence must retain the original semantic execution owner. SID alone cannot select a Host. */
export function collaborationWorkfaces(state: NavigationState, context: FocusContext,
  executionFor: (reference: { tabId: string; regionId: string; agentSessionId: string }) => { hostId: string } | null): WorkbenchProjectionSelection[] {
  if (!context.control) return []
  const originals = new Map<string, WorkbenchProjectionSelection>()
  for (const location of workbenchSelectionCatalog(state).locations) {
    const surface = state.tabs[location.tabId]?.regions[location.regionId]
    if (surface?.kind !== 'agent' || surface.sessionId !== context.control.agentSessionId) continue
    const execution = executionFor({ tabId: location.tabId, regionId: location.regionId, agentSessionId: surface.sessionId })
    if (execution?.hostId !== context.control.hostId) continue
    const reference = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
    originals.set(JSON.stringify(reference), reference)
  }
  return [...originals.values()]
}
