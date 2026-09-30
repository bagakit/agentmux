import type { AgentMuxSpaceControlRequest, AgentMuxSpaceControlResult, AgentMuxSpatialSave } from '@agentmux/core/control'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { awaitDesktopPresentation, captureDesktopInput, desktopInputPreserved } from './desktop-presentation'
import { effectiveSessionViewMode, storedSessionViewMode } from './session-presentation'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import type { SessionViewMode } from './session-state'
import { spatialCatalog, type SpatialWorkbench } from './space-agent-control'

export type WorkfaceAgentViewPorts = {
  get(): SpatialWorkbench & Parameters<typeof effectiveSessionViewMode>[0]
  setViewMode(sessionId: string, mode: SessionViewMode, options: { focus: false }): void
  save(layoutApplied: boolean): Promise<AgentMuxSpatialSave>
}

/** Presentation preference belongs to the original Session owner, even while Runtime facts are absent. */
export async function executeWorkfaceAgentView(ports: WorkfaceAgentViewPorts,
  request: Extract<AgentMuxSpaceControlRequest, { operation: 'agent.view' }>
): Promise<Extract<AgentMuxSpaceControlResult, { operation: 'agent.view' }>> {
  const state = ports.get(), id = request.agentSessionId
  const topicsWorkspace = state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  const catalog = spatialCatalog(state, scratchTopicsForWorkspace(state.scratchTopicSnapshots, topicsWorkspace) ?? [])
  const regions = catalog.regions.filter(region => region.kind === 'agent' && region.agentSessionId === id)
  const ids = new Set(regions.map(region => region.regionId))
  const locations = catalog.locations.filter(location => ids.has(location.regionId))
  const sessions = state.sessions.filter(session => session.id === id)
  const known = sessions.length === 1 && sessions[0]!.kind === 'agent'
  const confirmed = known || sessions.length === 0 && regions.length > 0
  const before = storedSessionViewMode(state.viewModes, id)
  const base = { operation: 'agent.view' as const, scope: 'agent-session' as const, agentSessionId: id,
    sessionFacts: known ? 'known' as const : 'unconfirmed' as const, regions, locations }
  if (!confirmed) return { ...base, storedOverride: before, effectiveMode: null, changed: false, outcome: 'unknown', save: null,
    issues: [{ step: 'target', code: 'UNKNOWN_AGENT_SESSION',
      message: 'The exact Agent Session or its original Agent Region reference is not currently confirmed.',
      recovery: 'Inspect the original Session or Region; missing facts do not establish retirement.' }] }
  if (request.mode === undefined) return { ...base, storedOverride: before, effectiveMode: effectiveSessionViewMode(state, id),
    changed: false, outcome: 'read', save: null, issues: [] }
  const input = captureDesktopInput(state.tabs)
  ports.setViewMode(id, request.mode, { focus: false })
  // Capture applied facts before awaiting persistence; a later user edit must never be restored over.
  const applied = ports.get(), storedOverride = storedSessionViewMode(applied.viewModes, id)
  const effectiveMode = effectiveSessionViewMode(applied, id), changed = storedOverride !== before
  const save = await ports.save(false)
  const issues = save.reason ? [{ step: 'save', code: 'SPACE_SAVE_UNCONFIRMED', message: save.reason,
    recovery: 'The applied preference is retained; inspect current facts before issuing another change.' }] : []
  if (desktopInputPreserved(input, input)) await awaitDesktopPresentation(() => true)
  if (desktopInputPreserved(input, input) && !desktopInputPreserved(input, captureDesktopInput(ports.get().tabs))) issues.push({ step: 'input',
    code: 'INPUT_PRESERVATION_UNCONFIRMED', message: 'The previous input is no longer confirmed eligible in its original presentation.',
    recovery: 'The applied preference is retained; choose the current input explicitly.' })
  return { ...base, storedOverride, effectiveMode, changed, outcome: issues.length ? 'partial' : changed ? 'changed' : 'unchanged', save, issues }
}
