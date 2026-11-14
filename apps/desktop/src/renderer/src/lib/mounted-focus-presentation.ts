import { isAgentActivityStatusSource, semanticStatusStale } from '@agentmux/core/agent-status'
import type { FocusStateMarkKind } from '@agentmux/client-ui/focus-state-mark'
import type { MountedSpaceRegion } from './space-mount-view'
import type { MountedRegionSessionFact } from './space-mount-sessions'
import type { FocusFilters } from './focus-filters'
import { focusMatchesProject, focusMatchesTypes } from './focus-filters'
import type { SpaceSnapshot } from '@agentmux/core'
import type { SpaceMountRecord } from '../../../shared/space-mount'

/** Display facts from the original Provider only; no Run health or local Session lookup. */
export function mountedFocusActivity(fact: MountedRegionSessionFact | undefined, now: number) {
  const current = fact?.current?.state
  const status = current?.status === 'observed' && !fact?.stale ? current.session.semanticStatus : undefined
  const known = status && isAgentActivityStatusSource(status.source) && !semanticStatusStale(status, now)
  const state = known ? status.state : 'unknown'
  const bucket = state === 'waiting' || state === 'blocked' || state === 'error' ? 'attention' : state === 'working' ? 'working' : 'idle'
  const mark: FocusStateMarkKind = state === 'error' ? 'error' : bucket === 'attention' ? 'attention' : bucket === 'working' ? 'working' : state === 'done' ? 'idle' : 'unknown'
  const label = state === 'waiting' ? 'Needs reply' : state === 'blocked' ? 'Blocked' : state === 'error' ? 'Failed' : state === 'working' ? 'Working' : state === 'done' ? 'Idle' : 'Activity unknown'
  const issue = current?.status === 'unavailable' || current?.status === 'unknown' ? current.issue.message : undefined
  return { state, bucket, mark, label, status, issue }
}
export function mountedFocusProjectKey(target: SpaceMountRecord) {
  return JSON.stringify(['mounted-space', target.reference.runtimeId, target.reference.spaceId])
}
export function mountedFocusMatches(filters: FocusFilters, target: SpaceMountRecord, snapshot: SpaceSnapshot | undefined, activity?: ReturnType<typeof mountedFocusActivity>) {
  return focusMatchesProject(mountedFocusProjectKey(target), filters.projects) &&
    focusMatchesTypes(snapshot?.scope.space?.kind === 'folder' ? ['project'] : [], filters.types) &&
    (!filters.states.length || !!activity && filters.states.some(state => state === activity.bucket || state === 'unknown' && activity.state === 'unknown'))
}

export function mountedFocusTextMatches(member: MountedSpaceRegion, snapshot: SpaceSnapshot | undefined, query: string) {
  return !query || [snapshot?.scope.space?.name, member.tab.name, member.region.kind, member.region.agentSessionId, member.zone?.directoryPath,
    member.region.execution?.hostId, member.region.execution?.runtimeId, member.reference.runtimeId].some(value => value?.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
}
