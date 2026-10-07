import { useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import type { ConnectionRecord, RoomGetResult, RoomListResult, RoomMembersResult, RoomSummary } from '@agentmux/core/connections'
import { api } from '../lib/api'
import { SelectionField } from './SelectionField'

type Connection = Pick<ConnectionRecord, 'revision' | 'config'>
const scopeOf = (connection: Connection) => ({ connectionId: connection.config.connectionId, expectedConnectionRevision: connection.revision })
export const roomName = (room: RoomSummary) => room.name ?? room.externalConversationId

/** A modal's bounded page, never a directory cache or an authority check. */
export function ConnectorRoomSelection({ connection, value, onChange, disabled }: {
  connection: Connection; value: string; onChange(value: string): void; disabled: boolean
}) {
  const [query, setQuery] = useState(''), [page, setPage] = useState<RoomListResult | null>(null)
  const [selected, setSelected] = useState<RoomSummary | null>(null), [issue, setIssue] = useState(''), [pending, setPending] = useState(false)
  const flight = useRef(false), live = useRef(true), pageQuery = useRef('')
  async function read(next?: string) {
    if (flight.current) return
    flight.current = true; setPending(true)
    const exactQuery = next ? pageQuery.current : query
    try {
      const input = { ...scopeOf(connection), limit: 20, ...(next ? { cursor: next } : {}) }
      const result = exactQuery ? await api.connections.call('connection.room.search', { ...input, query: exactQuery }) : await api.connections.call('connection.room.ls', input)
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
export function useConnectorRoomFacts(connection: Connection | undefined, externalConversationId: string) {
  const identity = JSON.stringify([connection?.config.connectionId, connection?.revision, externalConversationId])
  const [read, setRead] = useState<{ identity: string; room: RoomGetResult | null; people: RoomMembersResult | null; issue: string } | null>(null)
  const current = useRef(identity), flight = useRef<object | null>(null), [pending, setPending] = useState(false)
  const occurrence = useRef({})
  current.current = identity
  async function refresh(cursor?: string) {
    if (!connection || !externalConversationId || flight.current) return
    const original = identity, originalOccurrence = occurrence.current, input = { ...scopeOf(connection), externalConversationId }
    const request = {}; flight.current = request; setPending(true)
    const update = (value: Partial<NonNullable<typeof read>>) => { if (current.current === original && occurrence.current === originalOccurrence) setRead(previous => ({ identity: original, room: null, people: null, issue: '', ...(previous?.identity === original ? previous : {}), ...value })) }
    try {
      const reads = cursor ? [] : [api.connections.call('connection.room.get', input).then(room => update({ room }))]
      reads.push(api.connections.call('connection.room.members', { ...input, limit: 20, ...(cursor ? { cursor } : {}) }).then(people => update({ people })))
      const results = await Promise.allSettled(reads)
      const failed = results.find(result => result.status === 'rejected')
      update({ issue: failed?.status === 'rejected' ? presentError(failed.reason) : '' })
    } finally { if (flight.current === request) flight.current = null; if (current.current === original && occurrence.current === originalOccurrence) setPending(false) }
  }
  useEffect(() => { current.current = identity; occurrence.current = {}; void refresh(); return () => { current.current = ''; occurrence.current = {}; flight.current = null } }, [identity])
  return { ...(read?.identity === identity ? read : { room: null, people: null, issue: '' }), pending, refresh }
}

export function ConnectorRoomPeople({ facts, onSelect }: { facts: ReturnType<typeof useConnectorRoomFacts>; onSelect?: ((idType: string, userId: string) => void) | undefined }) {
  const people = facts.people
  return <details className="agent-connector-disclosure"><summary>People in this group</summary><div className="agent-connector-fields">
    <p className="agent-connector-note">Your own membership is not verified here. Joining the group and permission to use this Agent are separate.</p>
    {people?.observation.state === 'ready' ? people.members.length ? people.members.map(member => <div className="agent-connector-person" key={JSON.stringify([member.idType, member.userId])}>
      <span><strong>{member.name ?? member.userId}</strong><small>{member.idType} · {member.userId}</small></span>
      {onSelect ? <button className="small-button" onClick={() => onSelect(member.idType, member.userId)}>Choose</button> : null}
    </div>) : <p className="agent-connector-note">No people were returned by the application.</p> : <p role="status" className="agent-connector-note">Group members are not confirmed.</p>}
    {facts.issue ? <p role="status" className="surface-inline-error">{facts.issue}</p> : null}
    {people?.next ? <button className="agent-connector-text-action" disabled={facts.pending} onClick={() => void facts.refresh(people.next!)}>More people</button> : null}
    <button className="agent-connector-text-action" disabled={facts.pending} onClick={() => void facts.refresh()}>Check group and members</button>
  </div></details>
}
