import { spaceSessionMemberKey, type SpaceSessionMember, type SpaceSessionState, type SpaceSessionsObservation, type SpaceSessionsOpening, type SpaceSessionOccurrence } from '@agentmux/core/space-sessions'
import type { SpaceSnapshot } from '@agentmux/core'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import { mountedRegionKey } from './space-mount-view'

export type MountedSessionFact = { member: SpaceSessionMember; state: SpaceSessionState; cut?: SpaceSessionsOpening; occurrences?: SpaceSessionOccurrence[] }
export type MountedSessionObservation = { opening?: SpaceSessionsOpening; members: Record<string, MountedSessionFact>; lastConfirmed: Record<string, MountedSessionFact>; reading: boolean; error?: string | undefined }
export type MountedSessionUpdate = { begin?: boolean; opening?: SpaceSessionsOpening; observation?: SpaceSessionsObservation; error?: string }
export type MountedRegionSessionFact = { current: MountedSessionFact | undefined; last: MountedSessionFact | undefined; stale: boolean; occurrence?: SpaceSessionOccurrence }
/** Last confirmed metadata remains a descriptor, never current Native readiness. */
export function confirmedMountedSessionState(current?: MountedSessionFact, last?: MountedSessionFact, stale = false): Extract<SpaceSessionState, { status: 'observed' }> | undefined {
  const state = current?.state
  return state?.status === 'observed' && !stale ? state : last?.state.status === 'observed' ? last.state : undefined
}
const empty = (): MountedSessionObservation => ({ members: {}, lastConfirmed: {}, reading: false })
/** A display projection of original Core receipts, never an Agent lifecycle reducer. */
export function observeMountedSessions(target: SpaceMountRecord, previous: MountedSessionObservation | undefined, update: MountedSessionUpdate): MountedSessionObservation {
  const before = previous ?? empty()
  if (update.begin) return { ...before, members: {}, reading: true }
  if (update.error !== undefined) return { ...before, reading: false, error: update.error }
  const event = update.observation, opening = event ?? update.opening
  if (!opening || event?.type === 'runtime') return before // No PTY/output/history or unrelated Runtime payload is stored.
  if (opening.reference.runtimeId !== target.reference.runtimeId || opening.reference.spaceId !== target.reference.spaceId || opening.source.runtimeId !== target.reference.runtimeId) throw Error('Session metadata belongs to another original Space source. Existing members are kept.')
  if (before.opening?.source.ownerInstanceId === opening.source.ownerInstanceId && before.opening.revision > opening.revision) return before
  const next: MountedSessionObservation = { ...before, opening: { reference: opening.reference, source: opening.source, revision: opening.revision }, reading: false, error: undefined }
  if (event?.type === 'member') {
    if ((event.state.status === 'observed' || event.state.status === 'missing') && event.state.authority.runtimeId !== event.member.runtimeId) throw Error('Session metadata belongs to another original Session Runtime. Its reference is kept.')
    const key = spaceSessionMemberKey(event.member), fact: MountedSessionFact = { member: event.member, state: event.state, cut: { reference: event.reference, source: event.source, revision: event.revision }, ...(event.occurrences ? { occurrences: event.occurrences } : {}) }
    next.members = { ...before.members, [key]: fact }
    if (event.state.status === 'observed') next.lastConfirmed = { ...before.lastConfirmed, [key]: fact }
  } else if (event?.type === 'membership-complete') {
    // B has finished this exact roster/occurrence cut. The retained D state is
    // unchanged; a source label/order edit does not require another D event.
    const completedCut = { reference: opening.reference, source: opening.source, revision: opening.revision }
    next.members = Object.fromEntries(Object.entries(before.members).map(([key, fact]) => {
      const cut = fact.cut
      return [key, cut && cut.reference.runtimeId === opening.reference.runtimeId && cut.reference.spaceId === opening.reference.spaceId &&
        cut.source.runtimeId === opening.source.runtimeId && cut.source.ownerInstanceId === opening.source.ownerInstanceId && cut.revision < opening.revision
        ? { ...fact, cut: completedCut } : fact]
    }))
  } else if (event?.type === 'removed') {
    const key = spaceSessionMemberKey(event.member)
    next.members = { ...before.members }; delete next.members[key]
    next.lastConfirmed = { ...before.lastConfirmed }; delete next.lastConfirmed[key]
  }
  return next
}
type SourceRegion = SpaceSnapshot['scope']['regions'][number]
// Derived indexes follow the lifetime of their original immutable inputs.
const sourceRegions = new WeakMap<SpaceSnapshot, ReadonlyMap<string, SourceRegion>>()
const unpinnedMembers = new WeakMap<MountedSessionObservation['members'], ReadonlyMap<string, MountedSessionFact | null>>()
const memberOccurrences = new WeakMap<SpaceSessionOccurrence[], ReadonlyMap<string, SpaceSessionOccurrence | null>>()

function readMember(values: MountedSessionObservation['members'], hostId: string | null, runtimeId: string | undefined, agentSessionId: string) {
  if (runtimeId !== undefined) return values[spaceSessionMemberKey({ hostId, runtimeId, agentSessionId })]
  let index = unpinnedMembers.get(values)
  if (!index) {
    const next = new Map<string, MountedSessionFact | null>()
    for (const fact of Object.values(values)) {
      const key = JSON.stringify([fact.member.hostId, fact.member.agentSessionId])
      next.set(key, next.has(key) ? null : fact)
    }
    unpinnedMembers.set(values, index = next)
  }
  // Only an unambiguous original member can qualify an unpinned Region.
  return index.get(JSON.stringify([hostId, agentSessionId])) ?? undefined
}

function readOccurrence(snapshot: SpaceSnapshot, fact: MountedSessionFact, region: SourceRegion) {
  const cut = fact.cut, occurrences = fact.occurrences
  // A later topology cut can retain the last member fact without confirming its route.
  if (!occurrences || !cut || cut.revision !== snapshot.revision || cut.reference.runtimeId !== snapshot.reference.runtimeId ||
      cut.reference.spaceId !== snapshot.reference.spaceId || cut.source.runtimeId !== snapshot.source.runtimeId ||
      cut.source.ownerInstanceId !== snapshot.source.ownerInstanceId) return undefined
  let index = memberOccurrences.get(occurrences)
  if (!index) {
    const next = new Map<string, SpaceSessionOccurrence | null>()
    for (const occurrence of occurrences) {
      const key = JSON.stringify([occurrence.regionId, occurrence.creationOperationId ?? null])
      next.set(key, next.has(key) ? null : occurrence)
    }
    memberOccurrences.set(occurrences, index = next)
  }
  return index.get(JSON.stringify([region.regionId, region.creationOperationId ?? null])) ?? undefined
}

function regionFact(snapshot: SpaceSnapshot, observation: MountedSessionObservation, region: SourceRegion): MountedRegionSessionFact | undefined {
  const id = region.agentSessionId
  if (!id) return undefined
  const host = region.execution?.hostId ?? null, runtime = region.execution?.runtimeId
  const current = readMember(observation.members, host, runtime, id)
  const last = readMember(observation.lastConfirmed, host, runtime, id)
  const stale = Boolean(observation.error || observation.reading)
  const occurrence = !stale && current && readOccurrence(snapshot, current, region)
  return { current, last, stale, ...(occurrence ? { occurrence } : {}) }
}

/** One Region needs an exact position and only its own current and retained member. */
export function mountedSessionFact(snapshot: SpaceSnapshot | undefined, observation: MountedSessionObservation | undefined, key: string) {
  if (!snapshot || !observation) return undefined
  let regions = sourceRegions.get(snapshot)
  if (!regions) {
    regions = new Map(snapshot.scope.regions.map(region => [mountedRegionKey(snapshot.reference, region.tabId, region.regionId), region]))
    sourceRegions.set(snapshot, regions)
  }
  const region = regions.get(key)
  return region && regionFact(snapshot, observation, region)
}

/** Enumerate the same query for consumers that present the whole business scope. */
export function mountedSessionFacts(snapshot: SpaceSnapshot | undefined, observation: MountedSessionObservation | undefined): Map<string, MountedRegionSessionFact> {
  const result = new Map<string, MountedRegionSessionFact>()
  if (snapshot && observation) for (const region of snapshot.scope.regions) {
    const fact = regionFact(snapshot, observation, region)
    if (fact) result.set(mountedRegionKey(snapshot.reference, region.tabId, region.regionId), fact)
  }
  return result
}
