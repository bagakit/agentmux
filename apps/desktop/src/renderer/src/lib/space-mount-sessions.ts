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
/** Filter metadata through the business scope. Neither missing metadata nor its
 * roster deletion removes a business Region. Separate stream revisions may differ. */
export function mountedSessionFacts(snapshot: SpaceSnapshot | undefined, observation: MountedSessionObservation | undefined): Map<string, MountedRegionSessionFact> {
  const result = new Map<string, MountedRegionSessionFact>()
  if (!snapshot || !observation) return result
  const index = (values: Record<string, MountedSessionFact>) => {
    const exact = new Map<string, MountedSessionFact>(), aliases = new Map<string, MountedSessionFact[]>()
    for (const fact of Object.values(values)) { exact.set(spaceSessionMemberKey(fact.member), fact); const key = JSON.stringify([fact.member.hostId, fact.member.agentSessionId]), list = aliases.get(key) ?? []; list.push(fact); aliases.set(key, list) }
    return (hostId: string | null, runtimeId: string | undefined, agentSessionId: string) => {
      if (runtimeId !== undefined) return exact.get(spaceSessionMemberKey({ hostId, runtimeId, agentSessionId }))
      const matches = aliases.get(JSON.stringify([hostId, agentSessionId]))
      return matches?.length === 1 ? matches[0] : undefined // Only the Core owner qualifies an unpinned legacy member.
    }
  }
  const current = index(observation.members), last = index(observation.lastConfirmed)
  // Each original member's occurrences are indexed once. A later Space snapshot
  // must not relabel an older relation while its healthy Session reader continues.
  const occurrences = new Map<MountedSessionFact, Map<string, SpaceSessionOccurrence | null>>()
  for (const fact of Object.values(observation.members)) {
    const cut = fact.cut
    if (observation.error || observation.reading || !cut || cut.revision !== snapshot.revision ||
        cut.reference.runtimeId !== snapshot.reference.runtimeId || cut.reference.spaceId !== snapshot.reference.spaceId ||
        cut.source.runtimeId !== snapshot.source.runtimeId || cut.source.ownerInstanceId !== snapshot.source.ownerInstanceId) continue
    const exact = new Map<string, SpaceSessionOccurrence | null>()
    for (const occurrence of fact.occurrences ?? []) {
      const key = JSON.stringify([occurrence.regionId, occurrence.creationOperationId ?? null])
      exact.set(key, exact.has(key) ? null : occurrence)
    }
    occurrences.set(fact, exact)
  }
  for (const region of snapshot.scope.regions) if (region.agentSessionId) {
    const host = region.execution?.hostId ?? null, runtime = region.execution?.runtimeId, id = region.agentSessionId
    const fact = current(host, runtime, id), occurrence = fact && occurrences.get(fact)?.get(JSON.stringify([region.regionId, region.creationOperationId ?? null]))
    result.set(mountedRegionKey(snapshot.reference, region.tabId, region.regionId), { current: fact, last: last(host, runtime, id), stale: Boolean(observation.error || observation.reading),
      ...(occurrence ? { occurrence } : {}) })
  }
  return result
}
