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
function currentIdentity(context: FocusContext, lane: FocusProjectLane | undefined): AgentFocusHistoryIdentity {
  return {
    name: context.name, kind: context.kind, providerId: context.providerId, hostId: context.hostId, workspacePath: context.workspacePath,
    ...(lane?.projectWorkspaceId ? { project: { id: lane.projectId, name: lane.labels[0]! } } : {}),
    ...(context.workspace?.branch ? { branch: context.workspace.branch } : {}),
    ...(context.topicId ? { topicId: context.topicId } : {})
  }
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
export function groupFocusTimeline(contexts: readonly FocusContext[], lanes: readonly FocusProjectLane[], segments: ReadonlyMap<string, readonly FocusTimeSegment[]>, readonlyInputTracks: readonly FocusInputTrack[] = []): FocusTimelineProject[] {
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
    const identity = currentIdentity(context, lane)
    const track = ensure(context.id, identity)
    track.current = context
    // This identity is used only for current-only rows; it cannot fill an old observation.
    if (!track.segments.length) track.identity = identity
  }
  // Only actually read, timed input occupies a row. Its Context observations
  // organize the row; message-time ownership remains explicitly unknown.
  for (const readonlyInputTrack of readonlyInputTracks) {
    const track = ensure(readonlyInputTrack.sessionId, readonlyInputTrack.identity)
    track.inputProjectObserved = !!readonlyInputTrack.identity?.project
  }
  return [...groups.values()]
}

export type FocusTimelineOrderCandidate = {
  key: string; name: string; activityAt: number | null
  tracks: Array<{ key: string; name: string }>
}
/** A page's presentation ranks, never another Session, message or activity record. */
export type FocusTimelineOrder = {
  projects: ReadonlyMap<string, number>
  tracks: ReadonlyMap<string, number>
}
const nameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const compareKey = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const compareName = (a: { key: string; name: string }, b: { key: string; name: string }) => nameOrder.compare(a.name, b.name) || compareKey(a.key, b.key)

/** Collect rank candidates from retained/current facts, independent of the viewport.
 * Focus timestamps select a recorded name only; they never supply task activity. */
export function focusTimelineOrderCandidates(contexts: readonly FocusContext[], lanes: readonly FocusProjectLane[], entries: readonly AgentFocusHistoryEntry[], inputTracks: readonly FocusInputTrack[] = []): FocusTimelineOrderCandidate[] {
  const groups = new Map<string, { key: string; name: string; namedAt: number; activityAt: number | null; tracks: Map<string, { key: string; name: string; namedAt: number }> }>()
  const remember = (sessionId: string, identity: AgentFocusHistoryIdentity | undefined, namedAt: number, activityAt: number | null = null) => {
    const key = projectKey(identity)
    const group = groups.get(key) ?? { key, name: identity?.project?.name ?? 'Project not recorded', namedAt, activityAt: null, tracks: new Map() }
    if (namedAt >= group.namedAt) { group.name = identity?.project?.name ?? 'Project not recorded'; group.namedAt = namedAt }
    if (activityAt !== null && Number.isFinite(activityAt) && activityAt > 0) group.activityAt = Math.max(group.activityAt ?? 0, activityAt)
    const id = trackKey(sessionId, identity), track = group.tracks.get(id)
    if (!track || namedAt >= track.namedAt) group.tracks.set(id, { key: id, name: identity?.name ?? sessionId, namedAt })
    groups.set(key, group)
  }
  for (const entry of entries) remember(entry.sessionId, entry.identity, entry.focusedAt)
  const byContext = new Map(lanes.flatMap(lane => lane.contextIds.map(id => [id, lane] as const)))
  for (const context of contexts) remember(context.id, currentIdentity(context, byContext.get(context.id)), Infinity, context.lastActivityAt)
  for (const inputTrack of inputTracks) remember(inputTrack.sessionId, inputTrack.identity, -Infinity)
  return [...groups.values()].map(group => ({ key: group.key, name: group.name, activityAt: group.activityAt,
    tracks: [...group.tracks.values()].map(({ key, name }) => ({ key, name })) }))
}
export function createFocusTimelineOrder(candidates: readonly FocusTimelineOrderCandidate[]): FocusTimelineOrder {
  const projects = [...candidates].sort((a, b) => (b.activityAt ?? -Infinity) - (a.activityAt ?? -Infinity) || compareName(a, b))
  const tracks = projects.flatMap(project => [...project.tracks].sort(compareName))
  return { projects: new Map(projects.map((project, index) => [project.key, index])), tracks: new Map(tracks.map((track, index) => [track.key, index])) }
}
/** Keep surviving ranks; append newly observed keys and discard only truly absent facts. */
export function extendFocusTimelineOrder(order: FocusTimelineOrder, candidates: readonly FocusTimelineOrderCandidate[]): FocusTimelineOrder {
  const fresh = createFocusTimelineOrder(candidates)
  const extend = (before: ReadonlyMap<string, number>, available: ReadonlyMap<string, number>) => {
    const next = new Map([...before].filter(([key]) => available.has(key)))
    let ordinal = Math.max(-1, ...next.values()) + 1
    for (const key of available.keys()) if (!next.has(key)) next.set(key, ordinal++)
    return next.size === before.size && [...next].every(([key, rank]) => before.get(key) === rank) ? before : next
  }
  const projects = extend(order.projects, fresh.projects), tracks = extend(order.tracks, fresh.tracks)
  return projects === order.projects && tracks === order.tracks ? order : { projects, tracks }
}
export function orderFocusTimelineProjects(projects: readonly FocusTimelineProject[], order: FocusTimelineOrder): FocusTimelineProject[] {
  const compareRank = (ranks: ReadonlyMap<string, number>, a: { key: string }, b: { key: string }) => (ranks.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(b.key) ?? Number.MAX_SAFE_INTEGER) || compareKey(a.key, b.key)
  return [...projects].sort((a, b) => compareRank(order.projects, a, b)).map(project => ({ ...project,
    tracks: [...project.tracks].sort((a, b) => compareRank(order.tracks, a, b)) }))
}
