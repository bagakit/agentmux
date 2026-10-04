import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { DemandContentReference } from '@agentmux/demand'

type GoalSource = { id: string; updatedAt: number; sessionIds: readonly string[]; contentRefs?: readonly DemandContentReference[] }
const key = (ref: DemandContentReference) => JSON.stringify([ref.hostId, ref.workspaceId, ref.zoneId])

/** The Host catalog confirms resources; display bindings and execution cwd do not. */
export function confirmedGoalContentReference(catalog: AgentMuxSpaceCatalog, ref: DemandContentReference): boolean {
  const zones = catalog.zones.filter(zone => zone.zoneId === ref.zoneId)
  return zones.length === 1 && zones[0]!.kind !== 'unknown' && !zones[0]!.issue &&
    zones[0]!.hostId === ref.hostId && zones[0]!.workspaceId === ref.workspaceId && Boolean(zones[0]!.directoryPath)
}

/** Only a unique original resource can supply an inferred content source. */
export function goalContentSource(catalog: AgentMuxSpaceCatalog, sessionIds: readonly string[]): { contentRef: DemandContentReference | null; reason: string | null } {
  const ids = new Set(sessionIds), seen = new Set<string>(), refs = new Map<string, DemandContentReference>()
  for (const region of catalog.regions) {
    if (region.kind !== 'agent' || !region.agentSessionId || !ids.has(region.agentSessionId)) continue
    const tabs = catalog.tabs.filter(tab => tab.tabId === region.tabId && tab.regionIds.includes(region.regionId))
    if (tabs.length !== 1 || !tabs[0]!.zoneId) return { contentRef: null, reason: 'Original discussion resource is unconfirmed.' }
    const zones = catalog.zones.filter(zone => zone.zoneId === tabs[0]!.zoneId)
    if (zones.length !== 1 || !zones[0]!.hostId) return { contentRef: null, reason: 'Original discussion resource is unconfirmed.' }
    const ref = { hostId: zones[0]!.hostId!, workspaceId: zones[0]!.workspaceId, zoneId: zones[0]!.zoneId }
    if (!confirmedGoalContentReference(catalog, ref)) return { contentRef: null, reason: 'Original discussion resource is unconfirmed.' }
    refs.set(key(ref), ref); seen.add(region.agentSessionId)
  }
  if (seen.size && seen.size !== ids.size) return { contentRef: null, reason: 'Some original linked discussion resources are unconfirmed.' }
  return refs.size === 1 ? { contentRef: [...refs.values()][0]!, reason: null }
    : { contentRef: null, reason: refs.size ? 'Original linked discussions have multiple content resources; choose the source explicitly.' : 'No original discussion resource remains to prove the source.' }
}

/** A preview over current public owner facts; it never writes or fabricates lost relations. */
export function previewGoalContentReferences(catalog: AgentMuxSpaceCatalog, goals: readonly GoalSource[]) {
  return goals.map(goal => {
    const source = goalContentSource(catalog, goal.sessionIds)
    const present = new Set(goal.contentRefs?.map(key))
    return { goalId: goal.id, expectedUpdatedAt: goal.updatedAt, sessionIds: [...goal.sessionIds],
      contentRefs: source.contentRef && !present.has(key(source.contentRef)) ? [source.contentRef] : [],
      state: source.contentRef ? present.has(key(source.contentRef)) ? 'already-recorded' : 'confirmed' : goal.contentRefs?.length ? 'retained' : 'unresolved',
      reason: source.reason, basis: 'original-linked-session-resource-membership' }
  })
}
