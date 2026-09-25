import type { AgentFocusHistoryEntry, AgentFocusHistoryIdentity } from './agent-focus'
import type { FocusContext } from './focus-context'
import type { FocusProjectLane } from './focus-project-lanes'
import type { FocusTimeSegment } from './focus-time-window'

export type FocusTimelineTrack = {
  key: string
  sessionId: string
  identity: AgentFocusHistoryIdentity | undefined
  current: FocusContext | undefined
  segments: FocusTimeSegment[]
  inputProjectObserved?: boolean
}
export type FocusTimelineProject = {
  key: string
  name: string
  workspaceId: string | undefined
  tracks: FocusTimelineTrack[]
}
const UNKNOWN_PROJECT = 'unknown-project'
function projectKey(identity: AgentFocusHistoryIdentity | undefined): string {
  return identity?.project ? JSON.stringify([identity.hostId, identity.project.id]) : UNKNOWN_PROJECT
}
function trackKey(sessionId: string, identity: AgentFocusHistoryIdentity | undefined): string {
  return JSON.stringify([projectKey(identity), sessionId])
}
export type FocusInputTrack = Pick<FocusTimelineTrack, 'sessionId' | 'key' | 'identity'>

function referenceKey(reference: { hostId: string; agentSessionId: string }): string {
  return JSON.stringify([reference.hostId, reference.agentSessionId])
}
/** One derived view of retained facts, shared by the source chooser and timeline. */
export function observeFocusInputTracks(entries: readonly AgentFocusHistoryEntry[]): ReadonlyMap<string, FocusInputTrack> {
  const facts = new Map<string, { sessionId: string; observed: AgentFocusHistoryEntry; conflict: boolean }>()
  for (const entry of entries) {
    if (!entry.identity?.project) continue
    const key = referenceKey({ hostId: entry.identity.hostId, agentSessionId: entry.sessionId })
    const fact = facts.get(key)
    if (!fact) { facts.set(key, { sessionId: entry.sessionId, observed: entry, conflict: false }); continue }
    if (fact.observed.identity!.project!.id !== entry.identity.project.id) fact.conflict = true
    if (entry.focusedAt > fact.observed.focusedAt) fact.observed = entry
  }
  return new Map([...facts].map(([key, fact]) => {
    const identity = fact.conflict ? undefined : fact.observed.identity
    return [key, { sessionId: fact.sessionId, identity, key: trackKey(fact.sessionId, identity) }]
  }))
}
/** Context observations organize input; they never prove a message's past project. */
export function resolveFocusInputTrack(observations: ReadonlyMap<string, FocusInputTrack>, reference: { hostId: string; agentSessionId: string }): FocusInputTrack {
  const observed = observations.get(referenceKey(reference))
  return observed ?? { sessionId: reference.agentSessionId, identity: undefined, key: trackKey(reference.agentSessionId, undefined) }
}

/** Historical segments use their own observation. Current ownership only describes current facts. */
export function groupFocusTimeline(contexts: readonly FocusContext[], lanes: readonly FocusProjectLane[], segments: ReadonlyMap<string, readonly FocusTimeSegment[]>, readonlyInputTrack?: FocusInputTrack): FocusTimelineProject[] {
  const groups = new Map<string, FocusTimelineProject>()
  const tracks = new Map<string, FocusTimelineTrack>()
  const byContext = new Map(lanes.flatMap(lane => lane.contextIds.map(id => [id, lane] as const)))
  const ensure = (sessionId: string, identity: AgentFocusHistoryIdentity | undefined) => {
    const groupKey = projectKey(identity), key = trackKey(sessionId, identity)
    let track = tracks.get(key)
    if (!track) {
      const group = groups.get(groupKey) ?? { key: groupKey, name: identity?.project?.name ?? 'Project not recorded', workspaceId: identity?.project?.id, tracks: [] }
      track = { key, sessionId, identity, current: undefined, segments: [] }
      tracks.set(key, track); group.tracks.push(track); groups.set(groupKey, group)
    }
    return track
  }
  for (const [id, visits] of segments) for (const visit of visits) {
    const track = ensure(id, visit.identity)
    track.segments.push(visit)
    if (!track.identity || track.segments.length > 1) track.identity = visit.identity
  }
  for (const context of contexts) {
    const lane = byContext.get(context.id)
    const identity: AgentFocusHistoryIdentity = {
      name: context.name, kind: context.kind, providerId: context.providerId, hostId: context.hostId, workspacePath: context.workspacePath,
      ...(lane?.projectWorkspaceId ? { project: { id: lane.projectId, name: lane.labels[0]! } } : {}),
      ...(context.workspace?.branch ? { branch: context.workspace.branch } : {}),
      ...(context.topicId ? { topicId: context.topicId } : {})
    }
    const track = ensure(context.id, identity)
    track.current = context
    // This identity is used only for current-only rows; it cannot fill an old observation.
    if (!track.segments.length) track.identity = identity
  }
  // Only actually read, timed input occupies a row. Its Context observations
  // organize the row; message-time ownership remains explicitly unknown.
  if (readonlyInputTrack) {
    const track = ensure(readonlyInputTrack.sessionId, readonlyInputTrack.identity)
    track.inputProjectObserved = !!readonlyInputTrack.identity?.project
  }
  return [...groups.values()]
}
