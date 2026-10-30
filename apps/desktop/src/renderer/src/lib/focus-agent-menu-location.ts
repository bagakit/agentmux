import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { AgentMenuTarget } from './agent-menu-target'
import { agentMenuRunMatches, agentMenuSession } from './agent-menu-target'
import { executionFocusPresentation } from './focus-tab-projection'
import { scratchTopicsForConfig, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { spatialCatalog, type SpatialWorkbench } from './space-agent-control'
import type { WorkbenchProjectionSelection } from './workbench-projection'

export type FocusAgentSpatialState = SpatialWorkbench & { scratchTopicSnapshots: Record<string, ScratchTopicsSnapshot> }

/** A card does not borrow the current Focus selection or the first matching Tab. */
export function focusAgentMenuLocation(state: FocusAgentSpatialState, target: AgentMenuTarget,
  reference?: WorkbenchProjectionSelection) {
  const catalog = spatialCatalog(state, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots) ?? [])
  const presentation = executionFocusPresentation({ sessionId: target.id, history: [], ...(reference ? { reference } : {}) },
    state.tabs, catalog, () => {}, 'region', target.control?.agentSessionId ?? null)
  return { ...presentation, catalog, reference: presentation.projection?.selection[0] }
}

/** Every deferred callback rechecks its original Agent, Run and exact occurrence. */
export function requireFocusAgentMenuLocation(state: FocusAgentSpatialState, target: AgentMenuTarget,
  reference: WorkbenchProjectionSelection): { catalog: AgentMuxSpaceCatalog; reference: WorkbenchProjectionSelection } {
  if (!target.control || !agentMenuRunMatches(agentMenuSession(state.sessions, target), target.control)) {
    throw new Error('The original Agent identity or Run changed. Its work is kept; reopen this Agent menu before changing its location.')
  }
  const location = focusAgentMenuLocation(state, target, reference)
  if (!location.reference) throw new Error(location.issue ?? 'The original Agent location is no longer confirmed. Its work is kept.')
  const region = location.catalog.regions.find(item => item.regionId === reference.regionId && item.tabId === reference.tabId)
  if (region?.agentSessionId !== target.control.agentSessionId || region.runId !== target.control.run.runId) {
    throw new Error('The original Region no longer contains this Agent and Run. Its work is kept; choose its current exact location.')
  }
  return { catalog: location.catalog, reference }
}
