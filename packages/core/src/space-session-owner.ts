import { AgentMuxError } from './errors.js'
import type { SpaceAuthorityOwner } from './space-authority-owner.js'
import { applySpaceChange, type SpaceSnapshot, type SpaceAuthoritySource } from './space-authority.js'
import { spaceSessionMemberKey, type SpaceSessionMember, type SpaceSessionOccurrence, type SpaceSessionsOpening, type SpaceSessionsObservation } from './space-sessions.js'
import type { AdoptedHostRoute } from './host-route.js'
import type { AgentMuxHostedClient } from './hosted-client-contract.js'
import type { AgentMuxClientEvent } from './types.js'
import { hostedAgentSessionSummary } from './hosted-session-summary.js'

export type SpaceSessionSource = { member: SpaceSessionMember; occurrences?: SpaceSessionOccurrence[]; adoptedRoute?: AdoptedHostRoute; issue?: { code: string; message: string } }
export type SpaceSessionReader = Pick<AgentMuxHostedClient<'summary'>, 'agentSessions' | 'runtimeOwnerIdentity' | 'sessionObservationScope' | 'dispose'>
type Group = { key: string; hostId: string; runtimeId: string; cut: SpaceSessionsOpening; sources: SpaceSessionSource[]; adoptedRoute?: AdoptedHostRoute;
  controller: AbortController; stop?: (() => void | Promise<void>) | undefined }
type Ports = {
  authority: SpaceAuthorityOwner
  /** Original source graph/admission lookup, once per related membership cut. */
  sources(snapshot: SpaceSnapshot): Promise<SpaceSessionSource[]>
  observe(group: { hostId: string; runtimeId: string; agentSessionIds: string[]; adoptedRoute?: AdoptedHostRoute },
    event: (authority: SpaceAuthoritySource, event: AgentMuxClientEvent) => void, signal: AbortSignal): Promise<SpaceSessionReader>
}
const presentation = (source: SpaceSessionSource) => ({ member: source.member, ...(source.occurrences ? { occurrences: source.occurrences } : {}) })
const issue = (error: unknown) => ({ code: error instanceof AgentMuxError ? error.code : 'SPACE_SESSION_SOURCE_UNAVAILABLE',
  message: error instanceof Error ? error.message : String(error) })

/** A related reader composition, never a Session/phase store. Original Space
 * membership and the original Session Core retain their separate authority. */
export async function observeSpaceSessions(ports: Ports, reference: SpaceSnapshot['reference'], emit: (value: SpaceSessionsObservation) => void | Promise<void>,
  failed: (error: unknown) => void, signal?: AbortSignal) {
  let current: SpaceSnapshot | undefined, closed = false
  const groups = new Map<string, Group>(), members = new Map<string, SpaceSessionSource>()
  // Business revisions may advance while admission IO is pending. A healthy
  // reader retains its last confirmed cut until that exact relation is resolved.
  const envelope = () => ({ reference, source: current!.source, revision: current!.revision })
  const send = async (value: SpaceSessionsObservation) => { if (!closed) await emit(value) }
  const stop = (group: Group) => {
    group.controller.abort()
    if (groups.get(group.key) === group) groups.delete(group.key)
    void Promise.resolve().then(() => group.stop?.()).catch(() => {})
  }
  const live = (group: Group) => !closed && groups.get(group.key) === group && !group.controller.signal.aborted
  const publishSnapshot = async (group: Group, reader: SpaceSessionReader) => {
    const owner = reader.runtimeOwnerIdentity()
    if (!owner || owner.runtimeId !== group.runtimeId) throw new AgentMuxError('The original Session authority is unconfirmed.', 'RUNTIME_OWNER_MISMATCH')
    const authority = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }, scope = reader.sessionObservationScope()
    if (!scope) throw new AgentMuxError('The original Core did not confirm an exact Session selection.', 'CONTROL_PROTOCOL_ERROR')
    const observed = new Map(reader.agentSessions().map(session => [session.agentSessionId, session]))
    const missing = new Set(scope.missing), unavailableById = new Map(scope.unavailable.map(item => [item.agentSessionId, item]))
    for (const source of group.sources) {
      if (!live(group)) return
      const id = source.member.agentSessionId, session = observed.get(id), failure = unavailableById.get(id)
      const state = session ? { status: 'observed' as const, authority, session }
        : missing.has(id) ? { status: 'missing' as const, authority }
        : { status: 'unavailable' as const, issue: failure ?? { code: 'SPACE_SESSION_SOURCE_UNAVAILABLE', message: 'The exact original Session read has no confirmed result.' } }
      await send({ ...group.cut, type: 'member', ...presentation(source), state })
    }
  }
  const connect = async (group: Group) => {
    try {
      const sourceById = new Map(group.sources.map(source => [source.member.agentSessionId, source]))
      let confirmedReader: SpaceSessionReader | undefined
      const reader = await ports.observe({ hostId: group.hostId, runtimeId: group.runtimeId,
        agentSessionIds: group.sources.map(source => source.member.agentSessionId), ...(group.adoptedRoute ? { adoptedRoute: group.adoptedRoute } : {}) },
      (authority, event) => {
        if (!live(group)) return
        if (authority.runtimeId !== group.runtimeId) { stop(group); void unavailable(group, new AgentMuxError('The original Session reader answered for another Runtime.', 'RUNTIME_OWNER_MISMATCH')); return }
        if (event.type === 'connection-state' && event.observationOrigin.boundary === 'consumer-core') {
          // This is B's reader connection, not a new Native/Run fact authored by D.
          if (event.state !== 'restored') void unavailable(group, new AgentMuxError(event.diagnostic?.message ?? 'The original Session metadata reader is disconnected.', event.diagnostic?.code ?? 'SPACE_SESSION_SOURCE_UNAVAILABLE')).catch(failed)
          else if (confirmedReader) void publishSnapshot(group, confirmedReader).catch(error => unavailable(group, error)).catch(failed)
          return
        }
        if (event.type === 'agent-session') {
          const source = sourceById.get(event.session.agentSessionId)
          if (source) void send({ ...group.cut, type: 'member', ...presentation(source),
            state: { status: 'observed', authority, session: hostedAgentSessionSummary(event.session) } }).catch(failed)
          return
        }
        void send({ ...group.cut, type: 'runtime', hostId: group.hostId, runtimeId: group.runtimeId, authority, event }).catch(failed)
      }, group.controller.signal)
      confirmedReader = reader
      group.stop = () => reader.dispose()
      if (!live(group)) { await reader.dispose(); return }
      await publishSnapshot(group, reader)
    } catch (error) { if (live(group)) { stop(group); await unavailable(group, error) } }
  }
  const unavailable = async (group: Group, error: unknown) => {
    for (const source of group.sources) {
      const current = members.get(spaceSessionMemberKey(source.member)), replacement = groups.get(group.key)
      if (!closed && (!replacement || replacement === group) && current && !current.issue && JSON.stringify(current.adoptedRoute) === JSON.stringify(source.adoptedRoute)) await send({
        ...group.cut, type: 'member', ...presentation(source), state: { status: 'unavailable', issue: issue(error) } })
    }
  }
  const changed = async (snapshot: SpaceSnapshot) => {
    if (closed || current && snapshot.revision < current.revision) return
    current = snapshot
    // Invalidate removed/rebound members synchronously, before the optional
    // original-admission IO. A late D event cannot acquire the new B revision.
    const active = new Set(snapshot.scope.regions.flatMap(region => region.kind === 'agent' && region.agentSessionId ? [spaceSessionMemberKey({
      hostId: region.execution?.hostId ?? null, runtimeId: region.execution?.runtimeId ?? (region.execution?.hostId === 'local' ? snapshot.source.runtimeId : null),
      agentSessionId: region.agentSessionId })] : []))
    for (const group of [...groups.values()]) if (group.sources.some(source => !active.has(spaceSessionMemberKey(source.member)))) stop(group)
    const cut = snapshot, sources = await ports.sources(snapshot)
    if (closed || current !== cut) return
    const next = new Map<string, SpaceSessionSource>()
    for (const source of sources) {
      const key = spaceSessionMemberKey(source.member), previous = next.get(key)
      let selected = previous ?? source
      if (previous?.issue && previous.issue.code !== 'SPACE_SESSION_ROUTE_AMBIGUOUS' && !source.issue) selected = source
      else if (previous && !previous.issue && !source.issue && JSON.stringify(previous.adoptedRoute) !== JSON.stringify(source.adoptedRoute)) selected = {
        member: source.member, issue: { code: 'SPACE_SESSION_ROUTE_AMBIGUOUS', message: 'This member has conflicting original route references. Keep both placements and inspect the original source.' } }
      const occurrences = previous?.occurrences ?? []
      occurrences.push(...source.occurrences ?? [])
      next.set(key, { ...selected, occurrences })
    }
    for (const source of next.values()) source.occurrences?.sort((a, b) => a.regionId.localeCompare(b.regionId))
    const planned = new Map<string, Omit<Group, 'controller' | 'cut'>>()
    for (const source of next.values()) {
      const { member } = source
      if (source.issue || member.hostId === null || member.runtimeId === null) continue
      const key = JSON.stringify([member.hostId, member.runtimeId, source.adoptedRoute ?? null]), group = planned.get(key)
      if (group) group.sources.push(source)
      else planned.set(key, { key, hostId: member.hostId, runtimeId: member.runtimeId, sources: [source], ...(source.adoptedRoute ? { adoptedRoute: source.adoptedRoute } : {}) })
    }
    for (const group of groups.values()) {
      const next = planned.get(group.key)
      const ids = (values: SpaceSessionSource[]) => values.map(value => value.member.agentSessionId).sort().join('\0')
      const references = (values: SpaceSessionSource[]) => JSON.stringify([...values].sort((a, b) => a.member.agentSessionId.localeCompare(b.member.agentSessionId)).map(source => source.occurrences))
      if (!next || ids(next.sources) !== ids(group.sources) || references(next.sources) !== references(group.sources)) stop(group)
      else group.cut = envelope()
    }
    const removed = [...members].filter(([key]) => !next.has(key)).map(([, value]) => value.member)
    members.clear(); for (const [key, source] of next) members.set(key, source)
    for (const member of removed) await send({ ...envelope(), type: 'removed', member })
    for (const source of next.values()) if (source.issue || source.member.hostId === null || source.member.runtimeId === null) await send({
      ...envelope(), type: 'member', ...presentation(source), state: { status: 'unknown', issue: source.issue ?? { code: 'SPACE_SESSION_IDENTITY_UNCONFIRMED', message: 'The original Session Host or Runtime is unconfirmed. Its membership and Run reference are retained.' } } })
    const opening: Group[] = []
    for (const plan of planned.values()) if (!groups.has(plan.key)) {
      const group: Group = { ...plan, cut: envelope(), controller: new AbortController() }; groups.set(plan.key, group); opening.push(group)
      for (const source of group.sources) await send({ ...group.cut, type: 'member', ...presentation(source), state: { status: 'pending' } })
    }
    await send({ ...envelope(), type: 'membership-complete' })
    for (const group of opening) void connect(group).catch(failed)
  }
  const watch = await ports.authority.watch({ reference }, async event => {
    if (closed) return
    if (event.type === 'error') { failed(new AgentMuxError(event.error.message, event.error.code)); return }
    try { await changed(applySpaceChange(current!, event.data)) } catch (error) { failed(error) }
  }, signal)
  const dispose = () => { if (closed) return; closed = true; signal?.removeEventListener('abort', dispose); watch.dispose(); for (const group of [...groups.values()]) stop(group); members.clear() }
  signal?.addEventListener('abort', dispose, { once: true })
  const snapshot = watch.initial.snapshot
  return { initial: { reference, source: snapshot.source, revision: snapshot.revision },
    start: async () => { if (signal?.aborted) { dispose(); return }; try { await changed(snapshot); if (!closed) watch.start() } catch (error) { failed(error) } }, dispose }
}
