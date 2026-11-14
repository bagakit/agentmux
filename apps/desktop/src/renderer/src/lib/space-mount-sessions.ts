import { spaceSessionMemberKey, type SpaceSessionMember, type SpaceSessionState, type SpaceSessionsObservation, type SpaceSessionsOpening } from '@agentmux/core/space-sessions'
import type { SpaceSnapshot } from '@agentmux/core'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import { mountedRegionKey } from './space-mount-view'

export type MountedSessionFact = { member: SpaceSessionMember; state: SpaceSessionState }
export type MountedSessionObservation = { opening?: SpaceSessionsOpening; members: Record<string, MountedSessionFact>; lastConfirmed: Record<string, MountedSessionFact>; reading: boolean; error?: string | undefined }
export type MountedSessionUpdate = { begin?: boolean; opening?: SpaceSessionsOpening; observation?: SpaceSessionsObservation; error?: string }
export type MountedRegionSessionFact = { current: MountedSessionFact | undefined; last: MountedSessionFact | undefined; stale: boolean }
const empty = (): MountedSessionObservation => ({ members: {}, lastConfirmed: {}, reading: false })
/** A display projection of original Core receipts, never an Agent lifecycle reducer. */
export function observeMountedSessions(target: SpaceMountRecord, previous: MountedSessionObservation | undefined, update: MountedSessionUpdate): MountedSessionObservation {
  const before = previous ?? empty()
  if (update.begin) return { ...before, members: {}, reading: true, error: undefined }
  if (update.error !== undefined) return { ...before, reading: false, error: update.error }
  const event = update.observation, opening = event ?? update.opening
  if (!opening || event?.type === 'runtime') return before // No PTY/output/history or unrelated Runtime payload is stored.
  if (opening.reference.runtimeId !== target.reference.runtimeId || opening.reference.spaceId !== target.reference.spaceId || opening.source.runtimeId !== target.reference.runtimeId) throw Error('Session metadata belongs to another original Space source. Existing members are kept.')
  if (before.opening?.source.ownerInstanceId === opening.source.ownerInstanceId && before.opening.revision > opening.revision) return before
  const next: MountedSessionObservation = { ...before, opening: { reference: opening.reference, source: opening.source, revision: opening.revision }, reading: false, error: undefined }
  if (event?.type === 'member') {
    if ((event.state.status === 'observed' || event.state.status === 'missing') && event.state.authority.runtimeId !== event.member.runtimeId) throw Error('Session metadata belongs to another original Session Runtime. Its reference is kept.')
    const key = spaceSessionMemberKey(event.member), fact = { member: event.member, state: event.state }
    next.members = { ...before.members, [key]: fact }
    if (event.state.status === 'observed') next.lastConfirmed = { ...before.lastConfirmed, [key]: fact }
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
  for (const region of snapshot.scope.regions) if (region.agentSessionId) {
    const host = region.execution?.hostId ?? null, runtime = region.execution?.runtimeId, id = region.agentSessionId
    result.set(mountedRegionKey(snapshot.reference, region.tabId, region.regionId), { current: current(host, runtime, id), last: last(host, runtime, id), stale: Boolean(observation.error || observation.reading) })
  }
  return result
}
