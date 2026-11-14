import type { AgentMuxSpatialStateStore } from './spatial-state.js'
import { spatialAgentOpenRecord } from './spatial-agent-open-contract.js'
import type { SpaceSnapshot } from './space-authority.js'
import type { SpaceSessionSource } from './space-session-owner.js'

/** Only exact related admission IDs are read. The source's opaque resources,
 * prompts, executor environment and resource grant never enter the public DTO. */
export async function readSpaceSessionSources(store: AgentMuxSpatialStateStore, snapshot: SpaceSnapshot): Promise<SpaceSessionSource[]> {
  const regions = snapshot.scope.regions.filter(region => region.kind === 'agent' && region.agentSessionId)
  const tabs = new Map(snapshot.scope.tabs.map(tab => [tab.tabId, tab])), zones = new Map(snapshot.scope.zones.map(zone => [zone.zoneId, zone]))
  const bound = new Set(snapshot.scope.bindings.filter(binding => binding.spaceId === snapshot.reference.spaceId).map(binding => binding.zoneId))
  let state: Awaited<ReturnType<AgentMuxSpatialStateStore['readForLayout']>> | undefined, unavailable = false
  if (regions.some(region => region.execution?.hostId !== 'local' && region.execution?.runtimeId && region.creationOperationId)) {
    try { state = await store.readForLayout(); unavailable = state === null } catch { unavailable = true }
  }
  return regions.map(region => {
    const hostId = region.execution?.hostId ?? null, runtimeId = region.execution?.runtimeId ?? (hostId === 'local' ? snapshot.source.runtimeId : null)
    const member = { hostId, runtimeId, agentSessionId: region.agentSessionId! }
    const unknown = (code: string, message: string): SpaceSessionSource => ({ member, issue: { code, message } })
    if (hostId === null || runtimeId === null) return unknown('SPACE_SESSION_IDENTITY_UNCONFIRMED', 'The original member has no confirmed execution Host or Runtime. Its membership and Run reference are retained.')
    if (hostId === 'local' && runtimeId === snapshot.source.runtimeId) return { member }
    if (!region.creationOperationId) return unknown('SPACE_SESSION_REFERENCE_UNCONFIRMED', 'The original foreign member has no confirmed source admission reference. Current Host configuration was not substituted.')
    if (unavailable || !state) return unknown('SPACE_SESSION_REFERENCE_UNAVAILABLE', 'The original source admission is temporarily unreadable. Keep this member and reread its original Space.')
    try {
      const original = spatialAgentOpenRecord(state.graph, region.creationOperationId), tab = tabs.get(region.tabId), zone = tab?.zoneId ? zones.get(tab.zoneId) : undefined
      if (!original || original.agentSessionId !== region.agentSessionId || original.address.tabId !== region.tabId || original.address.regionId !== region.regionId ||
          original.execution.hostId !== hostId || original.execution.runtimeId !== runtimeId || original.execution.workspacePath !== region.execution?.cwd ||
          !zone || !bound.has(zone.zoneId) || original.address.zoneId !== zone.zoneId || original.placement?.runtimeId !== snapshot.source.runtimeId ||
          original.placement.hostId !== zone.hostId || original.placement.workspaceId !== zone.workspaceId || original.placement.workspacePath !== zone.directoryPath) {
        return unknown('SPACE_SESSION_REFERENCE_UNCONFIRMED', 'The member and original admission no longer identify the same source placement and execution target. Keep the original member and inspect that operation.')
      }
      return { member, ...(original.execution.adoptedRoute ? { adoptedRoute: original.execution.adoptedRoute } : {}) }
    } catch {
      return unknown('SPACE_SESSION_REFERENCE_UNAVAILABLE', 'The original admission could not be confirmed. Existing membership, Sessions and their original controls are retained.')
    }
  })
}
