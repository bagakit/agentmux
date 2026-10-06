import { groundingAcceptanceIssue } from '@agentmux/demand/goals'
import type { DemandContentReference } from '@agentmux/demand'
import { directoryIdentity, homeZoneId, originalTopicAddress } from '../../../shared/space-addresses'
import { SCRATCH_WORKSPACE_ID, scratchTopicIdentityPath, scratchTopicLogicalPath } from '../../../shared/scratch-topics'
import type { useAppStore } from '../store'
import type { MoteWorkfaceScope } from './mote-workface'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from './workbench-projection'
import { spatialCatalog } from './space-agent-control'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { confirmedMoteReference } from './mote-materials-actions'
import { workbenchSelectionCatalog } from './desktop-focus-navigation'
import { goalNextStep } from './goal-presentation'
import type { DemandRecord } from './global-demand-board'
import { goalDelegationRows } from './goal-delegation-presentation'

/** Read the original resource composition, including unplaced and unloaded Regions. */
export function moteGoalContext(state: ReturnType<typeof useAppStore.getState>, scope: MoteWorkfaceScope,
  reference?: WorkbenchProjectionSelection | null) {
  const workspace = state.config?.workspaces.find(item => item.id === scope.workspace.id)
  if (workspace?.hostId !== scope.workspace.hostId || workspace.path !== scope.workspace.path || scratchTopicLogicalPath(workspace, scope.topic) !== scope.rootPath)
    return { contentRef: null as DemandContentReference | null, sessionIds: [] as string[], selectedSessionId: undefined as string | undefined, issue: 'The original Mote resource is unconfirmed. Its work is retained.' }
  const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scope.workspace)
  // Membership is structural; an unavailable directory retains the original scope.
  const catalog = topics !== null && scope.workspace.id === SCRATCH_WORKSPACE_ID ? workbenchSelectionCatalog(state)
    : spatialCatalog({ ...state, sessions: [] }, topics ?? [scope.topic])
  const original = originalTopicAddress(scope.workspace, scope.topic, state.spaceZoneBindings)
  const spaceId = original?.spaceId ?? directoryIdentity(scope.workspace.hostId, scratchTopicIdentityPath(scope.workspace, scope.topic))
  const home = original ? catalog.zones.filter(zone => zone.zoneId === homeZoneId(original.spaceId)) : []
  const contentRef: DemandContentReference | null = home.length === 1 && home[0]!.kind === 'home' && !home[0]!.issue &&
    home[0]!.hostId === scope.workspace.hostId && home[0]!.workspaceId === scope.workspace.id &&
    catalog.spaces.filter(space => space.spaceId === spaceId && space.kind === 'mote' && space.hostId === scope.workspace.hostId).length === 1
    ? { hostId: scope.workspace.hostId, workspaceId: scope.workspace.id, zoneId: home[0]!.zoneId } : null
  const zoneIds = new Set(catalog.bindings.filter(binding => binding.spaceId === spaceId).map(binding => binding.zoneId))
  if (!zoneIds.size) return { contentRef, sessionIds: [] as string[], selectedSessionId: undefined as string | undefined,
    issue: 'The original Mote bindings are unconfirmed. Its work is retained.' }
  const tabIds = new Set(catalog.tabs.filter(tab => tab.zoneId !== null && zoneIds.has(tab.zoneId)).map(tab => tab.tabId))
  const sessionIds = [...new Set(catalog.regions.filter(region => tabIds.has(region.tabId) && region.kind === 'agent')
    .flatMap(region => region.agentSessionId ? [region.agentSessionId] : []))]
  const selected = reference === undefined ? confirmedMoteReference(state, scope, {}) : reference &&
    catalog.locations.some(location => location.spaceId === spaceId && sameWorkbenchProjectionSelection(location, reference)) ? reference : null
  const region = selected ? state.tabs[selected.tabId]?.regions[selected.regionId] : undefined
  const selectedSessionId = region?.kind === 'agent' && sessionIds.includes(region.sessionId) ? region.sessionId : undefined
  return { contentRef, sessionIds, selectedSessionId, issue: scope.issue }
}

export function goalsForMote(records: Readonly<Record<string, DemandRecord>>, sessionIds: readonly string[], contentRef?: DemandContentReference | null): DemandRecord[] {
  const members = new Set(sessionIds)
  return Object.values(records).filter(goal => goal.sessionIds.some(id => members.has(id)) || Boolean(contentRef && goal.contentRefs?.some(ref =>
      ref.hostId === contentRef.hostId && ref.workspaceId === contentRef.workspaceId && ref.zoneId === contentRef.zoneId)))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}

/** Human acknowledgement and original recorded work remain distinct facts. */
export function moteGoalSummary(goal: DemandRecord): { next: string; detail: string | null } {
  const latest = [...(goal.activities ?? []).map(item => ({ at: item.createdAt, text: item.message })),
    ...(goal.decisions ?? []).map(item => ({ at: item.createdAt, text: item.decision }))]
    .sort((left, right) => right.at - left.at)[0]
  return { next: goalNextStep(goal), detail: goal.grounding?.summary ?? latest?.text ?? null }
}

/** A bounded reading summary; original Goal status and acceptance remain authoritative. */
export function moteCurrentGoals(goals: readonly DemandRecord[]): DemandRecord[] {
  const pending = (goal: DemandRecord) => goalDelegationRows(goal).some(row => row.state !== 'accepted')
  const priority = (goal: DemandRecord) => goal.status === 'blocked' || goalDelegationRows(goal).some(row => row.state === 'report' || row.state === 'exited' || row.state === 'question') ? 0 : goal.status === 'in_review' ||
    goal.grounding && goal.grounding.acceptedAt === null || !goal.alignment || goal.alignment.confirmedAt === null ? 1 : 2
  return goals.filter(goal => goal.status !== 'cancelled' && (pending(goal) || goal.status !== 'done' || !goal.grounding ||
    goal.grounding.acceptedAt === null || groundingAcceptanceIssue(goal.alignment, goal.grounding, true) !== null))
    .sort((a, b) => priority(a) - priority(b) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}
