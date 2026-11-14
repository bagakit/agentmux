import type { AgentFocusHistoryEntry, AgentFocusHistoryIdentity } from './agent-focus'
import type { FocusContext } from './focus-context'
import { focusLanesByContext, type FocusProjectLane } from './focus-project-lanes'
import { focusContextIdentityKey } from './focus-context-identity'
import type { FocusTimeSegment } from './focus-time-window'
import { shallow } from 'zustand/shallow'

export type FocusTimelineTrack = {
  key: string
  sessionId: string
  identity: FocusTimelineIdentity | undefined
  current: FocusContext | undefined
  segments: FocusTimeSegment[]
  inputProjectObserved?: boolean
  inputReference?: { hostId: string; agentSessionId: string } | undefined
}
/** Current display grouping only. Saved history retains its original Agent Host contract. */
export type FocusTimelineIdentity = Omit<AgentFocusHistoryIdentity, 'project'> & {
  project?: NonNullable<AgentFocusHistoryIdentity['project']> & { hostId?: string }
}
export type FocusTimelineProject = {
  key: string
  name: string
  workspaceId: string | undefined
  tracks: FocusTimelineTrack[]
}
const UNKNOWN_PROJECT = 'unknown-project'
function projectKey(identity: FocusTimelineIdentity | undefined, hostId?: string): string {
  return identity?.project ? JSON.stringify([identity.project.hostId ?? identity.hostId, identity.project.id]) : JSON.stringify([identity?.hostId ?? hostId ?? null, UNKNOWN_PROJECT])
}
export function focusTimelineTrackKey(sessionId: string, identity: FocusTimelineIdentity | undefined, hostId?: string): string {
  return JSON.stringify([projectKey(identity, hostId), identity?.hostId ?? hostId ?? null, sessionId])
}
const trackKey = focusTimelineTrackKey
function currentIdentity(context: FocusContext, lanes: readonly FocusProjectLane[] | undefined): FocusTimelineIdentity {
  const first = lanes?.[0]
  const project = first?.projectWorkspaceId && lanes!.every(lane => !lane.locationUnconfirmed && lane.hostId === first.hostId && lane.projectId === first.projectId)
    ? { id: first.projectId, name: first.labels[0]!, hostId: first.hostId } : undefined
  return {
    name: context.name, kind: context.kind, providerId: context.providerId, hostId: context.hostId, workspacePath: context.workspacePath,
    ...(project ? { project } : {}),
    ...(context.workspace?.branch ? { branch: context.workspace.branch } : {}),
    ...(context.topicId ? { topicId: context.topicId } : {})
  }
}
export type FocusInputTrack = Pick<FocusTimelineTrack, 'sessionId' | 'key' | 'identity'> & { reference?: { hostId: string; agentSessionId: string } }

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
    return [key, { sessionId: fact.sessionId, identity, key: trackKey(fact.sessionId, identity, fact.observed.identity!.hostId) }]
  }))
}
/** Context observations organize input; they never prove a message's past project. */
export function resolveFocusInputTrack(observations: ReadonlyMap<string, FocusInputTrack>, reference: { hostId: string; agentSessionId: string }): FocusInputTrack {
  const observed = observations.get(referenceKey(reference))
  return observed ?? { sessionId: reference.agentSessionId, identity: undefined, key: trackKey(reference.agentSessionId, undefined, reference.hostId) }
}

function sameIdentity(left: FocusTimelineIdentity | undefined, right: FocusTimelineIdentity | undefined): boolean {
  if (left === right) return true
  if (!left || !right) return false
  const { project: leftProject, source: leftSource, ...leftFacts } = left
  const { project: rightProject, source: rightSource, ...rightFacts } = right
  return shallow(leftFacts, rightFacts) && shallow(leftProject, rightProject) && shallow(leftSource, rightSource)
}
function sameTrack(left: FocusTimelineTrack, right: FocusTimelineTrack): boolean {
  const { identity: leftIdentity, segments: leftSegments, ...leftFacts } = left
  const { identity: rightIdentity, segments: rightSegments, ...rightFacts } = right
  // Current Context and inputReference retain original identity; only the
  // derived identity values and slices can be rebuilt from unchanged facts.
  return shallow(leftFacts, rightFacts) && shallow(leftSegments, rightSegments) && sameIdentity(leftIdentity, rightIdentity)
}

/** Historical segments use their own observation. Current ownership only describes current facts.
 * The current projection may share unchanged tracks; it never retains removed facts. */
export function groupFocusTimeline(contexts: readonly FocusContext[], lanes: readonly FocusProjectLane[], segments: ReadonlyMap<string, readonly FocusTimeSegment[]>, readonlyInputTracks: readonly FocusInputTrack[] = [], previous: readonly FocusTimelineProject[] = []): FocusTimelineProject[] {
  const groups = new Map<string, FocusTimelineProject>()
  const tracks = new Map<string, FocusTimelineTrack>()
  const byContext = focusLanesByContext(lanes)
  const ensure = (sessionId: string, identity: FocusTimelineIdentity | undefined, hostId?: string) => {
    const groupKey = projectKey(identity, hostId), key = trackKey(sessionId, identity, hostId)
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
    const identity = currentIdentity(context, byContext.get(focusContextIdentityKey(context.hostId, context.id)))
    const track = ensure(context.id, identity)
    track.current = context
    // This identity is used only for current-only rows; it cannot fill an old observation.
    if (!track.segments.length) track.identity = identity
  }
  // Only actually read, timed input occupies a row. Its Context observations
  // organize the row; message-time ownership remains explicitly unknown.
  for (const readonlyInputTrack of readonlyInputTracks) {
    const track = ensure(readonlyInputTrack.sessionId, readonlyInputTrack.identity, readonlyInputTrack.reference?.hostId)
    track.inputProjectObserved = !!readonlyInputTrack.identity?.project
    track.inputReference = readonlyInputTrack.reference
  }
  const previousTracks = new Map(previous.flatMap(project => project.tracks.map(track => [track.key, track] as const)))
  for (const project of groups.values()) project.tracks = project.tracks.map(track => {
    const retained = previousTracks.get(track.key)
    return retained && sameTrack(retained, track) ? retained : track
  })
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
  const remember = (sessionId: string, identity: FocusTimelineIdentity | undefined, namedAt: number, activityAt: number | null = null, hostId?: string) => {
    const key = projectKey(identity, hostId)
    const group = groups.get(key) ?? { key, name: identity?.project?.name ?? 'Project not recorded', namedAt, activityAt: null, tracks: new Map() }
    if (namedAt >= group.namedAt) { group.name = identity?.project?.name ?? 'Project not recorded'; group.namedAt = namedAt }
    if (activityAt !== null && Number.isFinite(activityAt) && activityAt > 0) group.activityAt = Math.max(group.activityAt ?? 0, activityAt)
    const id = trackKey(sessionId, identity, hostId), track = group.tracks.get(id)
    if (!track || namedAt >= track.namedAt) group.tracks.set(id, { key: id, name: identity?.name ?? sessionId, namedAt })
    groups.set(key, group)
  }
  for (const entry of entries) remember(entry.sessionId, entry.identity, entry.focusedAt)
  const byContext = focusLanesByContext(lanes)
  for (const context of contexts) remember(context.id, currentIdentity(context, byContext.get(focusContextIdentityKey(context.hostId, context.id))), Infinity, context.lastActivityAt)
  for (const inputTrack of inputTracks) remember(inputTrack.sessionId, inputTrack.identity, -Infinity, null, inputTrack.reference?.hostId)
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
