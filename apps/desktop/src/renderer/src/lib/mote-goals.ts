import { directoryIdentity } from '../../../shared/space-addresses'
import { scratchTopicIdentityPath, scratchTopicLogicalPath } from '../../../shared/scratch-topics'
import type { useAppStore } from '../store'
import type { MoteWorkfaceScope } from './mote-workface'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from './workbench-projection'
import { spatialCatalog } from './space-agent-control'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { confirmedMoteReference } from './mote-materials-actions'
import { goalNextStep } from './goal-presentation'
import type { DemandRecord } from './global-demand-board'

/** Read the original resource composition, including unplaced and unloaded Regions. */
export function moteGoalContext(state: ReturnType<typeof useAppStore.getState>, scope: MoteWorkfaceScope,
  reference?: WorkbenchProjectionSelection | null) {
  const workspace = state.config?.workspaces.find(item => item.id === scope.workspace.id)
  if (workspace?.hostId !== scope.workspace.hostId || workspace.path !== scope.workspace.path || scratchTopicLogicalPath(workspace, scope.topic) !== scope.rootPath)
    return { sessionIds: [] as string[], selectedSessionId: undefined as string | undefined, issue: 'The original Mote resource is unconfirmed. Its work is retained.' }
  const catalog = spatialCatalog(state, scratchTopicsForWorkspace(state.scratchTopicSnapshots, scope.workspace) ?? [scope.topic])
  const spaceId = directoryIdentity(scope.workspace.hostId, scratchTopicIdentityPath(scope.workspace, scope.topic))
  const zoneIds = new Set(catalog.bindings.filter(binding => binding.spaceId === spaceId).map(binding => binding.zoneId))
  if (!zoneIds.size) return { sessionIds: [] as string[], selectedSessionId: undefined as string | undefined,
    issue: 'The original Mote bindings are unconfirmed. Its work is retained.' }
  const tabIds = new Set(catalog.tabs.filter(tab => tab.zoneId !== null && zoneIds.has(tab.zoneId)).map(tab => tab.tabId))
  const sessionIds = [...new Set(catalog.regions.filter(region => tabIds.has(region.tabId) && region.kind === 'agent')
    .flatMap(region => region.agentSessionId ? [region.agentSessionId] : []))]
  const selected = reference === undefined ? confirmedMoteReference(state, scope, {}) : reference &&
    catalog.locations.some(location => location.spaceId === spaceId && sameWorkbenchProjectionSelection(location, reference)) ? reference : null
  const region = selected ? state.tabs[selected.tabId]?.regions[selected.regionId] : undefined
  const selectedSessionId = region?.kind === 'agent' && sessionIds.includes(region.sessionId) ? region.sessionId : undefined
  return { sessionIds, selectedSessionId, issue: scope.issue }
}

export function goalsForMote(records: Readonly<Record<string, DemandRecord>>, sessionIds: readonly string[]): DemandRecord[] {
  const members = new Set(sessionIds)
  return Object.values(records).filter(goal => goal.sessionIds.some(id => members.has(id)))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}

/** Human acknowledgement and original recorded work remain distinct facts. */
export function moteGoalSummary(goal: DemandRecord): { next: string; detail: string | null } {
  const latest = [...(goal.activities ?? []).map(item => ({ at: item.createdAt, text: item.message })),
    ...(goal.decisions ?? []).map(item => ({ at: item.createdAt, text: item.decision }))]
    .sort((left, right) => right.at - left.at)[0]
  return { next: goalNextStep(goal), detail: goal.grounding?.summary ?? latest?.text ?? null }
}
