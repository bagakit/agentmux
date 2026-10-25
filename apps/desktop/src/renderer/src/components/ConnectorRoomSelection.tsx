import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { channelMetadataSubjectKey, type ChannelMetadataSubject, type ConnectionActor, type ConnectionRecord, type RoomGetResult, type RoomListResult, type RoomMembersResult, type RoomSummary } from '@agentmux/core/connections'
import { api } from '../lib/api'
import { SelectionField } from './SelectionField'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ConnectorEntityIdentity, ConnectorIdentityField, ConnectorProfileUpdates } from './ConnectorEntityIdentity'
import { useConnectorEntityProfiles } from '../lib/use-connector-room-name'

const LoadingIcon = semanticIconComponent('status.loading')
const RefreshIcon = semanticIconComponent('action.refresh')

type Connection = Pick<ConnectionRecord, 'revision' | 'config'>
const scopeOf = (connection: Connection) => ({ connectionId: connection.config.connectionId, expectedConnectionRevision: connection.revision })
export const roomName = (room: RoomSummary) => room.name ?? room.externalConversationId

/** A modal's bounded page, never a directory cache or an authority check. */
export function ConnectorRoomSelection({ connection, value, onChange, disabled, hostingTarget }: {
  connection: Connection; value: string; onChange(value: string): void; disabled: boolean; hostingTarget?: ConnectionHostingTarget | null
}) {
  const [query, setQuery] = useState(''), [page, setPage] = useState<RoomListResult | null>(null)
  const [selected, setSelected] = useState<RoomSummary | null>(null), [issue, setIssue] = useState(''), [pending, setPending] = useState(false)
  const flight = useRef(false), live = useRef(true), pageQuery = useRef('')
  async function read(next?: string) {
    if (hostingTarget === null || flight.current) return
    flight.current = true; setPending(true)
    const exactQuery = next ? pageQuery.current : query
    try {
      const input = { ...scopeOf(connection), limit: 20, ...(next ? { cursor: next } : {}) }
      const result = exactQuery ? await api.connections.call('connection.room.search', { ...input, query: exactQuery }, hostingTarget) : await api.connections.call('connection.room.ls', input, hostingTarget)
      if (live.current) { setPage(result); setIssue(''); pageQuery.current = exactQuery }
    } catch (error) { if (live.current) setIssue(presentError(error)) }
    finally { flight.current = false; if (live.current) setPending(false) }
  }
  useEffect(() => { live.current = true; void read(); return () => { live.current = false } }, [])
  const options = page?.rooms ?? [], chosen = selected?.externalConversationId === value ? selected : null
  const rooms = value && !options.some(room => room.externalConversationId === value)
    ? [chosen ?? { externalConversationId: value, name: null, state: 'unknown' as const }, ...options] : options
  return <div className="agent-connector-room-choice" aria-busy={pending}>
    <SelectionField searchable={false} label="Existing group" value={value} disabled={disabled}
      options={[{ value: '', label: pending ? 'Finding groups…' : 'Choose a group…' }, ...rooms.map(room => ({ value: room.externalConversationId, label: roomName(room), disabled: room.state === 'dissolved', description: room.name ? room.externalConversationId : 'Group name unavailable' }))]}
      onValueChange={id => { setSelected(rooms.find(room => room.externalConversationId === id) ?? null); onChange(id) }} />
    <div className="agent-connector-search">
      <TextInput aria-label="Search groups" placeholder="Search groups" maxLength={64} value={query} disabled={disabled} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !isImeOwnedKeyboardEvent(event)) { event.preventDefault(); void read() } }} />
      <button className="small-button" disabled={disabled || pending} onClick={() => void read()}>Search</button>
    </div>
    {page?.observation.state === 'ready' && !page.rooms.length ? <p className="agent-connector-note">No groups found for this application.</p> : null}
    {page && page.observation.state !== 'ready' ? <p role="status" className="agent-connector-note">Groups could not be read. You can check again or use an exact group ID.</p> : null}
    {issue ? <p role="status" className="surface-inline-error">{issue}</p> : null}
    {page?.next ? <button className="agent-connector-text-action" disabled={disabled || pending} onClick={() => void read(page.next!)}>More groups</button> : null}
    <details className="agent-connector-disclosure"><summary>Use an exact group ID</summary>
      <label className="agent-connector-field">Group ID<TextInput aria-label="Existing group ID" value={value} disabled={disabled} onChange={event => onChange(event.target.value)} /></label>
    </details>
  </div>
}

/** Exact visible room only. Changing the application, revision or room releases this read window. */
export function useConnectorRoomFacts(connection: Connection | undefined, externalConversationId: string, hostingTarget?: ConnectionHostingTarget | null, visibleActors: readonly ConnectionActor[] = [], peopleVisible = true) {
  const identity = JSON.stringify([connection?.config.connectionId, connection?.revision, externalConversationId, hostingTarget])
  const [read, setRead] = useState<{ identity: string; room: RoomGetResult | null; people: RoomMembersResult | null; issue: string } | null>(null)
  const current = useRef(identity), flight = useRef<object | null>(null), [pending, setPending] = useState(false)
  const occurrence = useRef({})
  const peopleActive = useRef({ visible: peopleVisible, occurrence: {} })
  const profileLifetime = useRef<AbortController | null>(null)
  if (peopleActive.current.visible !== peopleVisible) peopleActive.current = { visible: peopleVisible, occurrence: {} }
  useEffect(() => () => { profileLifetime.current?.abort() }, [identity, peopleVisible])
  current.current = identity
  async function refresh(cursor?: string, refreshProfiles = true) {
    if (!connection || !externalConversationId || hostingTarget === null || flight.current) return
    const original = identity, originalOccurrence = occurrence.current, input = { ...scopeOf(connection), externalConversationId }
    const request = {}; flight.current = request; setPending(true)
    const profileAbort = new AbortController(), peopleOccurrence = peopleActive.current.occurrence
    if (refreshProfiles) profileLifetime.current = profileAbort
    const update = (value: Partial<NonNullable<typeof read>>) => { if (current.current === original && occurrence.current === originalOccurrence) setRead(previous => ({ identity: original, room: null, people: null, issue: '', ...(previous?.identity === original ? previous : {}), ...value })) }
    const active = () => !profileAbort.signal.aborted && current.current === original && occurrence.current === originalOccurrence && peopleActive.current.visible && peopleActive.current.occurrence === peopleOccurrence
    const waitForProfiles = async (work: Promise<unknown>) => {
      let cancelled: (() => void) | undefined
      try { await Promise.race([work, new Promise<void>(resolve => { cancelled = () => resolve(); profileAbort.signal.addEventListener('abort', cancelled, { once: true }); if (profileAbort.signal.aborted) resolve() })]) }
      finally { if (cancelled) profileAbort.signal.removeEventListener('abort', cancelled) }
    }
    const represented = (people: RoomMembersResult | null | undefined) => {
      const subjects = new Map<string, ChannelMetadataSubject>()
      for (const actor of [...visibleActors, ...(people?.members ?? []).map(member => ({ application: connection.config.application, idType: member.idType, userId: member.userId }))]) {
        if (actor.application.domain !== connection.config.application.domain || actor.application.appId !== connection.config.application.appId) continue
        const subject: ChannelMetadataSubject = { kind: 'actor', actor }
        subjects.set(channelMetadataSubjectKey(subject), subject)
      }
      return subjects
    }
    try {
      if (profileAbort.signal.aborted || current.current !== original || occurrence.current !== originalOccurrence) return
      let people: RoomMembersResult | undefined
      const reads = cursor ? [] : [api.connections.call('connection.room.get', input, hostingTarget).then(room => update({ room }))]
      reads.push(api.connections.call('connection.room.members', { ...input, limit: 20, ...(cursor ? { cursor } : {}) }, hostingTarget).then(result => { people = result; update({ people: result }) }))
      const results = await Promise.allSettled(reads)
      const failed = results.find(result => result.status === 'rejected')
      update({ issue: failed?.status === 'rejected' ? presentError(failed.reason) : '' })
      if (refreshProfiles && peopleVisible && active()) {
        const subjects = represented(people)
        const remaining = subjects.values()
        // The panel's complete represented set, with bounded concurrency and no off-panel queue.
        let profileFailed = false
        await waitForProfiles(Promise.all(Array.from({ length: Math.min(4, subjects.size) }, async () => {
          while (active()) {
            const next = remaining.next()
            if (next.done) return
            try {
              await api.connections.call('connection.metadata.refresh', { ...scopeOf(connection), subject: next.value }, hostingTarget)
            } catch { profileFailed = true }
          }
        })))
        if (profileFailed && active()) update({ issue: 'Some profile updates could not complete. Earlier profiles and member access are kept.' })
      }
    } finally { if (profileLifetime.current === profileAbort) profileLifetime.current = null; if (flight.current === request) flight.current = null; if (current.current === original && occurrence.current === originalOccurrence) setPending(false) }
  }
  useEffect(() => { current.current = identity; occurrence.current = {}; void refresh(undefined, false); return () => { current.current = ''; occurrence.current = {}; flight.current = null } }, [identity])
  const facts = read?.identity === identity ? read : { room: null, people: null, issue: '' }
  const subjects: ChannelMetadataSubject[] = connection && externalConversationId ? [
    { kind: 'conversation', externalConversationId },
    ...visibleActors.filter(actor => actor.application.domain === connection.config.application.domain && actor.application.appId === connection.config.application.appId).map(actor => ({ kind: 'actor' as const, actor })),
    ...(facts.people?.members ?? []).map(member => ({ kind: 'actor' as const, actor: { application: connection.config.application, idType: member.idType, userId: member.userId } }))
  ] : []
  const profiles = useConnectorEntityProfiles(connection?.config ?? null, subjects, hostingTarget)
  return { ...facts, identity, profiles, pending, refresh }
}

/** Current native metadata stays separate from the name frozen in a creation request. */
export function ConnectorRoomOverview({ facts, groupId, requestedName }: {
  facts: ReturnType<typeof useConnectorRoomFacts>; groupId: string; requestedName?: string | undefined
}) {
  const room = facts.room?.room, observation = facts.room?.observation
  const profileRead = facts.profiles.get(channelMetadataSubjectKey({ kind: 'conversation', externalConversationId: groupId })), profile = profileRead?.observation?.profile
  return <div className="agent-connector-room-overview" aria-busy={facts.pending}>
    <ConnectorEntityIdentity identityKey={facts.identity} kind="group" profileRead={profileRead} name={profile?.name ?? room?.name} avatarUrl={profile?.avatarUrl} missingName="Group name not confirmed" actions={<button type="button" className="agent-connector-text-action agent-connector-room-refresh" aria-label="Refresh group details" title="Refresh group details" disabled={facts.pending} onClick={() => void facts.refresh()}>
      {facts.pending ? <LoadingIcon size={13} animation="spin" /> : <RefreshIcon size={14} />}
    </button>} />
    <ConnectorProfileUpdates reads={facts.profiles} />
    {facts.pending ? <p className="agent-connector-note" role="status">Reading group details…</p> : null}
    {observation && observation.state !== 'ready' ? <p className="agent-connector-note" role="status">
      {observation.reason === 'permission-denied' ? 'This bot cannot read the group details. Review its application permissions.' : observation.reason === 'room-unavailable' ? 'The platform could not find an accessible group for this bot.' : 'Current group details could not be confirmed. Check this original group again.'}
    </p> : null}
    {!room?.name && requestedName ? <p className="agent-connector-note">Requested name · {requestedName}</p> : null}
    {room ? <div className="agent-connector-room-metadata">
      <span>{room.state === 'active' ? 'Active group' : room.state === 'dissolved' ? 'Group dissolved' : 'Group state not confirmed'}</span>
      {room.mode !== 'unknown' ? <span>{room.mode === 'topic' ? 'Topic group' : room.mode === 'direct' ? 'Direct conversation' : 'Group conversation'}</span> : null}
      <span>{room.membershipApproval === 'required' ? 'Approval required to join' : room.membershipApproval === 'not-required' ? 'No approval required to join' : 'Join approval policy not confirmed'}</span>
    </div> : null}
    {facts.issue ? <p className="agent-connector-note" role="status">The group and member refresh could not complete. Earlier observed details are kept. {facts.issue}</p> : null}
    <details className="agent-connector-disclosure"><summary>Group identity</summary><ConnectorIdentityField identityKey={facts.identity} label="Group ID" value={groupId} /></details>
  </div>
}

export function ConnectorRoomPeople({ facts, onSelect, prominent = false }: { facts: ReturnType<typeof useConnectorRoomFacts>; onSelect?: ((idType: string, userId: string) => void) | undefined; prominent?: boolean }) {
  const people = facts.people
  const body = <div className="agent-connector-fields">
    <p className="agent-connector-note">{onSelect ? 'Choose a member to set their access to this Agent.' : 'Your own membership is not verified here. Joining the group and permission to use this Agent are separate.'}</p>
    {facts.pending ? <p className="agent-connector-note" role="status"><LoadingIcon size={14} animation="spin" /> Reading this group…</p> : null}
    {people?.observation.state === 'ready' ? people.members.length ? people.members.map(member => {
      const subject: ChannelMetadataSubject | undefined = people.application ? { kind: 'actor', actor: { application: people.application, idType: member.idType, userId: member.userId } } : undefined
      const profileRead = subject ? facts.profiles.get(channelMetadataSubjectKey(subject)) : undefined, profile = profileRead?.observation?.profile
      const identityKey = JSON.stringify([facts.identity, member.idType, member.userId])
      return <div className="agent-connector-person" key={JSON.stringify([member.idType, member.userId])}>
      <div><ConnectorEntityIdentity identityKey={identityKey} kind="person" profileRead={profileRead} name={profile?.name ?? member.name} avatarUrl={profile?.avatarUrl} missingName="Group member" compact /><ConnectorIdentityField identityKey={identityKey} label={member.idType} value={member.userId} compact /></div>
      {onSelect ? <button className="small-button" onClick={() => onSelect(member.idType, member.userId)}>Choose</button> : null}
    </div>}) : <p className="agent-connector-note">No people were returned by the application.</p> : <p role="status" className="agent-connector-note">Group members are not confirmed.</p>}
    {facts.issue ? <p role="status" className="surface-inline-error">{facts.issue}</p> : null}
    {people?.next ? <button className="agent-connector-text-action" disabled={facts.pending} onClick={() => void facts.refresh(people.next!)}>More people</button> : null}
    <button className="agent-connector-text-action" disabled={facts.pending} onClick={() => void facts.refresh()}>Check group and members</button>
  </div>
  return prominent ? <section className="agent-connector-fields" aria-label="People in this group" aria-busy={facts.pending}><h3>People in this group</h3>{body}</section>
    : <details className="agent-connector-disclosure" aria-busy={facts.pending}><summary>People in this group</summary>{body}</details>
}
