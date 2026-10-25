import { ConnectorEntityIdentity, ConnectorIdentityField, ConnectorProfileUpdates } from './ConnectorEntityIdentity'
import { mintObjectId } from '@agentmux/core/object-id'
import { useEffect, useRef, useState } from 'react'
import type { MoteChatConfiguration, MoteChatPerson } from '@agentmux/core/mote-chat'
import { channelMetadataSubjectKey } from '@agentmux/core/connections'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { TextInput } from '@agentmux/client-ui/input'
import { api } from '../lib/api'
import { submitMoteChatIntent } from '../lib/mote-chat-request'
import { useAppStore } from '../store'
import { sameMotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { MoteChatHistory } from './MoteChatHistory'
import { useConnectorEntityProfiles, type ConnectorEntityProfileRead } from '../lib/use-connector-room-name'

const actorKey = (person: MoteChatPerson) => JSON.stringify(person.actor)

export function MoteChatPeople({ configuration, hostingTarget, active, refreshRevision, onSaved }: { configuration: MoteChatConfiguration; hostingTarget: ConnectionHostingTarget; active: boolean; refreshRevision: number; onSaved(): void }) {
  const [people, setPeople] = useState<MoteChatPerson[]>([]), [next, setNext] = useState<string | null>(null)
  const [reading, setReading] = useState(false), [issue, setIssue] = useState('')
  const lifetime = useRef(0)
  const profiles = useConnectorEntityProfiles(configuration.values.connection, people.map(person => ({ kind: 'actor', actor: person.actor })), hostingTarget, active)
  async function read(cursor?: string) {
    const epoch = ++lifetime.current
    setReading(true)
    try {
      const page = await api.moteChat.call('space.mote.chat.audience', { target: configuration.target, ...(cursor ? { cursor } : {}), limit: 20 }, hostingTarget)
      if (lifetime.current !== epoch) return
      setPeople(current => cursor ? [...current, ...page.people.filter(person => !current.some(old => actorKey(old) === actorKey(person)))]
        : [...page.people, ...current.filter(person => !page.people.some(updated => actorKey(updated) === actorKey(person)))])
      setNext(page.next); setIssue('')
    } catch (error) { if (lifetime.current === epoch) setIssue(presentError(error)) }
    finally { if (lifetime.current === epoch) setReading(false) }
  }
  useEffect(() => { if (active) void read(); return () => { lifetime.current++ } }, [active, configuration.revision, refreshRevision])
  return <div className="mote-chat-people" aria-label="Private chat people" aria-busy={reading}>
    <p className="mote-details__hint">The confirmed bot creator has unlimited access. Other people have their own message allowance; changing a total keeps messages already used.</p>
    <ConnectorProfileUpdates reads={profiles} />
    {people.map(person => <MoteChatPersonRow key={JSON.stringify([hostingTarget, configuration.target, configuration.values.connection, actorKey(person)])} person={person} profileRead={profiles.get(channelMetadataSubjectKey({ kind: 'actor', actor: person.actor }))} configuration={configuration} hostingTarget={hostingTarget} active={active} onSaved={updated => {
      lifetime.current++; setReading(false); setPeople(current => current.map(old => actorKey(old) === actorKey(updated) ? updated : old)); onSaved()
    }} />)}
    {reading ? <p role="status" className="mote-details__hint">Reading people…</p> : !people.length && !issue ? <p className="mote-details__hint">People appear here when they first message this bot.</p> : null}
    {issue ? <p role="status" className="mote-details__issue">{issue}</p> : null}
    <div className="mote-chat-actions"><button type="button" className="small-button" disabled={reading} onClick={() => void read()}>Refresh people</button>{next ? <button type="button" className="small-button" disabled={reading} onClick={() => void read(next)}>More people</button> : null}</div>
  </div>
}

function MoteChatPersonRow({ person, profileRead, configuration, hostingTarget, active, onSaved }: { person: MoteChatPerson; profileRead?: ConnectorEntityProfileRead | undefined; configuration: MoteChatConfiguration; hostingTarget: ConnectionHostingTarget; active: boolean; onSaved(person: MoteChatPerson): void }) {
  const profile = profileRead?.observation?.profile
  const [editing, setEditing] = useState(false), [total, setTotal] = useState(String(person.total ?? 0)), [busy, setBusy] = useState(false), [issue, setIssue] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const pending = useAppStore(state => Object.values(state.moteChatIntents).some(intent => intent.method === 'space.mote.chat.allocate'
    && sameMotePreferencesTarget(intent.input.target, configuration.target) && JSON.stringify(intent.input.actor) === actorKey(person)))
  async function save() {
    const count = Number(total)
    if (!Number.isSafeInteger(count) || count < 0 || !total.trim()) { setIssue('Enter a total of zero or more messages.'); return }
    if (busy || pending) return
    setBusy(true); setIssue('')
    try {
      const result = await submitMoteChatIntent({ method: 'space.mote.chat.allocate', phase: 'not-dispatched', hostingTarget, input: {
        operationId: mintObjectId(), target: configuration.target, expectedConfigurationRevision: configuration.revision,
        actor: person.actor, expectedPersonRevision: person.revision, total: count } })
      if (result.action !== 'allocate') throw Error('The original allowance receipt is not confirmed.')
      onSaved(result.person); setEditing(false)
    } catch (error) { setIssue('The allowance was not confirmed. Your entered total is kept. ' + presentError(error)) }
    finally { setBusy(false) }
  }
  return <article className="mote-chat-person" data-mote-chat-person={person.actor.userId}>
    <ConnectorEntityIdentity identityKey={actorKey(person)} kind="person" profileRead={profileRead} name={profile?.name ?? person.name} avatarUrl={profile?.avatarUrl} missingName={person.creator ? 'Bot creator' : 'Chat participant'} />
    <details className="agent-connector-disclosure"><summary>Account details</summary><ConnectorIdentityField identityKey={actorKey(person)} label={person.actor.idType} value={person.actor.userId} /><ConnectorIdentityField identityKey={actorKey(person)} label="App ID" value={person.actor.application.appId} /></details>
    <dl><div><dt>Used</dt><dd>{person.used}</dd></div><div><dt>Total</dt><dd>{person.creator ? 'Unlimited' : person.total}</dd></div><div><dt>Remaining</dt><dd>{person.creator ? 'Unlimited' : person.remaining}</dd></div></dl>
    {!person.creator ? editing ? <form className="mote-chat-person__allocation" onSubmit={event => { event.preventDefault(); void save() }}>
      <label><span>Total message allowance</span><TextInput type="number" min="0" step="1" aria-label={`Total allowance for ${person.name ?? person.actor.userId}`} value={total} disabled={busy} onChange={event => setTotal(event.target.value)} /></label>
      <div className="mote-chat-actions"><button type="submit" className="small-button" disabled={busy || pending}>{busy ? 'Saving…' : 'Save allowance'}</button><button type="button" className="small-button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div>
    </form> : <button type="button" className="small-button" onClick={() => { setTotal(String(person.total)); setEditing(true) }}>Edit allowance</button> : <span className="mote-details__hint">Creator · unlimited</span>}
    {issue ? <p role="status" className="mote-details__issue">{issue}</p> : null}
    {pending ? <p role="status" className="mote-details__hint">Check this person’s original allowance request below before another save.</p> : null}
    <details className="mote-chat-person__history" onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>Conversations</summary><MoteChatHistory target={configuration.target} actor={person.actor} hostingTarget={hostingTarget} active={active && historyOpen} /></details>
  </article>
}
