import type { AgentMuxSpaceControlRequest, AgentMuxSpaceControlResult, AgentMuxSpatialSave } from '@agentmux/core/control'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { awaitDesktopPresentation, captureDesktopInput, desktopInputPreserved } from './desktop-presentation'
import { agentSessionPresentationIndex, effectiveSessionViewMode, storedSessionViewMode } from './session-presentation'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import type { SessionViewMode } from './session-state'
import { spatialCatalog, type SpatialWorkbench } from './space-agent-control'
import { desktopAgentPresentationFromSpatial } from './desktop-agent-presentation'

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
  const sessions = (agentSessionPresentationIndex(state.sessions).get(id) ?? []).filter(session => session.control.agentSessionId === id)
  const known = sessions.length === 1 && sessions[0]!.kind === 'agent'
  const original = known ? sessions[0] : undefined
  const regions = catalog.regions.filter(region => region.kind === 'agent' && region.agentSessionId === id &&
    (!original || !region.execution || region.execution.hostId === original.control.hostId))
  const ids = new Set(regions.map(region => JSON.stringify([region.tabId, region.regionId])))
  const locations = catalog.locations.filter(location => ids.has(JSON.stringify([location.tabId, location.regionId])))
  const retained = new Map<string, string>()
  const originalRegions = new Map(state.originalSpatialGraph?.regions.map(region => [JSON.stringify([region.tabId, region.regionId]), region]))
  let retainedUnknown = false
  if (sessions.length === 0) for (const region of catalog.regions) {
    const surface = state.tabs[region.tabId]?.regions[region.regionId]
    const fact = originalRegions.get(JSON.stringify([region.tabId, region.regionId]))
    if (region.agentSessionId !== id && fact?.agentSessionId !== id) continue
    const presentation = state.originalSpatialGraph && fact ? desktopAgentPresentationFromSpatial(state.originalSpatialGraph, fact) : null
    const hostId = fact?.execution?.hostId ?? presentation?.hostId ?? region.execution?.hostId
    const matches = surface?.kind === 'agent' && (state.originalSpatialGraph === undefined
      ? surface.sessionId === id : fact?.kind === 'agent' && fact.agentSessionId === id && hostId &&
        (surface.sessionId === id || presentation?.sessionId === surface.sessionId))
    if (matches && surface?.kind === 'agent') retained.set(JSON.stringify([hostId ?? null, surface.sessionId]), surface.sessionId)
    else retainedUnknown = true
  }
  const retainedId = !retainedUnknown && retained.size === 1 ? retained.values().next().value : undefined
  const presentationId = original?.id ?? retainedId ?? id
  const confirmed = known || sessions.length === 0 && retainedId !== undefined
  const before = storedSessionViewMode(state.viewModes, presentationId)
  const base = { operation: 'agent.view' as const, scope: 'agent-session' as const, agentSessionId: id,
    sessionFacts: known ? 'known' as const : 'unconfirmed' as const, regions, locations }
  if (!confirmed) return { ...base, storedOverride: before, effectiveMode: null, changed: false, outcome: 'unknown', save: null,
    issues: [{ step: 'target', code: 'UNKNOWN_AGENT_SESSION',
      message: 'The exact Agent Session or its original Agent Region reference is not currently confirmed.',
      recovery: 'Inspect the original Session or Region; missing facts do not establish retirement.' }] }
  if (request.mode === undefined) return { ...base, storedOverride: before, effectiveMode: effectiveSessionViewMode(state, presentationId),
    changed: false, outcome: 'read', save: null, issues: [] }
  const input = captureDesktopInput(state.tabs)
  ports.setViewMode(presentationId, request.mode, { focus: false })
  // Capture applied facts before awaiting persistence; a later user edit must never be restored over.
  const applied = ports.get(), storedOverride = storedSessionViewMode(applied.viewModes, presentationId)
  const effectiveMode = effectiveSessionViewMode(applied, presentationId), changed = storedOverride !== before
  const save = await ports.save(false)
  const issues = save.reason ? [{ step: 'save', code: 'SPACE_SAVE_UNCONFIRMED', message: save.reason,
    recovery: 'The applied preference is retained; inspect current facts before issuing another change.' }] : []
  if (desktopInputPreserved(input, input)) await awaitDesktopPresentation(() => true)
  if (desktopInputPreserved(input, input) && !desktopInputPreserved(input, captureDesktopInput(ports.get().tabs))) issues.push({ step: 'input',
    code: 'INPUT_PRESERVATION_UNCONFIRMED', message: 'The previous input is no longer confirmed eligible in its original presentation.',
    recovery: 'The applied preference is retained; choose the current input explicitly.' })
  return { ...base, storedOverride, effectiveMode, changed, outcome: issues.length ? 'partial' : changed ? 'changed' : 'unchanged', save, issues }
}
