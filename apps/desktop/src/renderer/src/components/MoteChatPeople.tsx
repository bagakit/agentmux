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
import { checkpointLauncherState, useLauncherState } from '../lib/launcher-state'
import { moteChatDraftKey, restoredMoteChatDraft, type MoteChatDraft } from '../lib/mote-chat-draft'
import { sameMotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { MoteChatHistory } from './MoteChatHistory'
import { useConnectorEntityProfiles, type ConnectorEntityProfileRead } from '../lib/use-connector-room-name'

const actorKey = (person: MoteChatPerson) => JSON.stringify(person.actor)
type AllowanceDraft = Extract<MoteChatDraft, { kind: 'allowance' }>

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
    <p className="mote-details__hint">{configuration.creator ? 'The confirmed native creator uses Main and has unlimited access.' : 'Native creator not confirmed. People use separate guest conversations.'} Each guest has their own message allowance; changing a total keeps messages already used.</p>
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
  const original = { kind: 'allowance' as const, target: configuration.target, hostingTarget, connection: configuration.values.connection, actor: person.actor }, draftKey = moteChatDraftKey(original)
  const storedDraft = useLauncherState(state => state.drafts[draftKey]?.moteChat)
  const saved = restoredMoteChatDraft(storedDraft, draftKey), retainedDraft = saved?.kind === 'allowance' ? saved : undefined
  const ownVersion = useRef(retainedDraft?.version), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [editing, setEditing] = useState(Boolean(retainedDraft)), [total, setTotal] = useState(retainedDraft?.total ?? String(person.total ?? 0)), [busy, setBusy] = useState(false), [issue, setIssue] = useState(retainedDraft?.issue ?? '')
  const [historyOpen, setHistoryOpen] = useState(false)
  const pending = useAppStore(state => Object.values(state.moteChatIntents).some(intent => intent.method === 'space.mote.chat.allocate'
    && intent.hostingTarget?.hostId === hostingTarget.hostId && intent.hostingTarget.runtimeId === hostingTarget.runtimeId
    && sameMotePreferencesTarget(intent.input.target, configuration.target) && JSON.stringify(intent.input.actor) === actorKey(person)))
  function retainTotal(value: string, message = '', version = mintObjectId()) { const draft: AllowanceDraft = { ...original, total: value, issue: message, version }; useLauncherState.getState().setMoteChatDraft(draftKey, draft); return draft }
  function editTotal(value: string) { ownVersion.current = retainTotal(value).version; setTotal(value); setIssue('') }
  async function save() {
    const count = Number(total)
    if (!Number.isSafeInteger(count) || count < 0 || !total.trim()) { setIssue('Enter a total of zero or more messages.'); return }
    if (busy || pending) return
    const operationId = mintObjectId(), originalDraft = retainTotal(total, '', operationId); ownVersion.current = originalDraft.version
    setBusy(true); setIssue('')
    try {
      await checkpointLauncherState()
      const result = await submitMoteChatIntent({ method: 'space.mote.chat.allocate', phase: 'not-dispatched', hostingTarget, input: {
        operationId, target: configuration.target, expectedConfigurationRevision: configuration.revision,
        actor: person.actor, expectedPersonRevision: person.revision, total: count } })
      if (result.action !== 'allocate') throw Error('The original allowance receipt is not confirmed.')
      const cleared = useLauncherState.getState().setMoteChatDraft(draftKey, undefined, originalDraft.version)
      if (mounted.current) { if (cleared) setEditing(false); onSaved(result.person) }
    } catch (error) { const message = (useAppStore.getState().moteChatIntents[operationId] ? 'The allowance was not confirmed. Your entered total is kept. ' : 'The allowance was not saved. Your entered total is kept. ') + presentError(error), current = restoredMoteChatDraft(useLauncherState.getState().drafts[draftKey]?.moteChat, draftKey); if (current?.kind === 'allowance' && current.version === originalDraft.version) retainTotal(current.total, message, current.version); if (mounted.current) setIssue(message) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <article className="mote-chat-person" data-mote-chat-person={person.actor.userId}>
    <ConnectorEntityIdentity identityKey={actorKey(person)} kind="person" profileRead={profileRead} profileIssueSummary="Profile update unconfirmed" name={profile?.name ?? person.name} avatarUrl={profile?.avatarUrl} missingName={person.creator ? 'Bot creator' : 'Chat participant'} />
    <details className="agent-connector-disclosure"><summary>Account details</summary><ConnectorIdentityField identityKey={actorKey(person)} label={person.actor.idType} value={person.actor.userId} /><ConnectorIdentityField identityKey={actorKey(person)} label="App ID" value={person.actor.application.appId} />
      {profileRead?.issue ? <p className="mote-details__hint">{profileRead.issue}</p> : null}
    </details>
    <dl><div><dt>Used</dt><dd>{person.used}</dd></div><div><dt>Total</dt><dd>{person.creator ? 'Unlimited' : person.total}</dd></div><div><dt>Remaining</dt><dd>{person.creator ? 'Unlimited' : person.remaining}</dd></div></dl>
    {!person.creator ? editing ? <form className="mote-chat-person__allocation" onSubmit={event => { event.preventDefault(); void save() }}>
      <label><span>Total message allowance</span><TextInput type="number" min="0" step="1" aria-label={`Total allowance for ${person.name ?? person.actor.userId}`} value={total} disabled={busy} onChange={event => editTotal(event.target.value)} /></label>
      <div className="mote-chat-actions"><button type="submit" className="small-button" disabled={busy || pending}>{busy ? 'Saving…' : 'Save allowance'}</button><button type="button" className="small-button" disabled={busy} onClick={() => { if (useLauncherState.getState().setMoteChatDraft(draftKey, undefined, ownVersion.current)) setEditing(false) }}>Cancel</button></div>
    </form> : <button type="button" className="small-button" onClick={() => { editTotal(String(person.total)); setEditing(true) }}>Edit allowance</button> : <span className="mote-details__hint">Creator · unlimited</span>}
    {issue || retainedDraft?.issue ? <p role="status" className="mote-details__issue">{issue || retainedDraft?.issue}</p> : null}
    {pending ? <p role="status" className="mote-details__hint">Check this person’s original allowance request below before another save.</p> : null}
    <details className="mote-chat-person__history" onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>Conversations</summary><MoteChatHistory target={configuration.target} actor={person.actor} hostingTarget={hostingTarget} active={active && historyOpen} /></details>
  </article>
}
