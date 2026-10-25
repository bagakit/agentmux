import { ConnectorEntityIdentity, ConnectorIdentityField, ConnectorProfileUpdates } from './ConnectorEntityIdentity'
import { useEffect, useId, useState, type Dispatch, type SetStateAction } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { channelMetadataSubjectKey, type ConnectionActor, type ConnectionGrant, type ConnectionMemberAccess, type RoomBinding } from '@agentmux/core/connections'
import type { ConnectorRoomIntent } from '../lib/connector-room-intent'
import { connectorMemberBaselineCurrent, connectorMemberDirty, connectorMemberKey, editConnectorMemberDraft, savedMemberCapabilities, type ConnectorMemberDrafts } from '../lib/connector-member-draft'
import type { useConnectorRoomFacts } from './ConnectorRoomSelection'
import { ConnectorMemberChoices } from './ConnectorMemberChoices'

const AccessIcon = semanticIconComponent('status.permission')
const capabilitySummary = (values: ConnectionGrant['capabilities']) => values.map(value => value === 'input' ? 'Send requests' : value === 'answer' ? 'Answer questions' : 'Permission decisions').join(' · ') || 'No Agent access'
type MemberIntent = Extract<ConnectorRoomIntent, { method: 'connection.grant' | 'connection.binding.member.inherit' }>
export type ConnectorMemberRequest = { intent: MemberIntent; state: 'not-dispatched' | 'unconfirmed' | 'applied' | 'refused' }
type Props = {
  heading?: boolean
  binding: RoomBinding
  facts: ReturnType<typeof useConnectorRoomFacts>
  grants: ConnectionGrant[] | null
  access: ConnectionMemberAccess[] | null
  creator: { idType: string; userId: string } | null
  drafts: ConnectorMemberDrafts
  changeDrafts: Dispatch<SetStateAction<ConnectorMemberDrafts>>
  account: { idType: string; userId: string; change(idType: string, userId: string): void }
  requests: ConnectorMemberRequest[]
  flights: Map<string, 'checking' | 'saving'>
  save(actor: ConnectionActor, capabilities: ConnectionGrant['capabilities'], baseline: ConnectionGrant | null, source: 'room' | 'application'): void
  inspect(intent: MemberIntent): void
  resume(intent: MemberIntent): void
  review(actor: ConnectionActor, draftKey: string, refused?: MemberIntent): void
}

/** Native membership is an observation; the Host alone resolves inherited/effective access. */
export function ConnectorMemberAccess(props: Props) {
  const { binding, grants, access, drafts, facts } = props
  const editorId = useId()
  const [editing, setEditing] = useState<Set<string>>(() => new Set())
  const actor = (idType: string, userId: string): ConnectionActor => ({ application: binding.application, idType, userId })
  const sameApplication = (value: ConnectionActor) => value.application.domain === binding.application.domain && value.application.appId === binding.application.appId
  const observation = (value: ConnectionActor): ConnectionMemberAccess | undefined => access === null ? undefined : access.find(item => item.actor.idType === value.idType && item.actor.userId === value.userId) ?? { actor: value, local: { kind: 'none', previousDecision: false }, effective: null }
  const localGrant = (value: ConnectionActor, observed = observation(value)) => observed ? observed.local.kind === 'none' ? null : observed.local.grant : grants === null ? undefined : grants.find(item => item.actor.idType === value.idType && item.actor.userId === value.userId) ?? undefined
  useEffect(() => {
    if (!props.creator || access === null) return
    const value = actor(props.creator.idType, props.creator.userId), key = connectorMemberKey(binding, value), original = observation(value)
    if (!original || original.local.kind !== 'none' || original.local.previousDecision || original.effective || drafts[key] || props.requests.some(request => request.intent.input.actor.idType === value.idType && request.intent.input.actor.userId === value.userId)) return
    props.changeDrafts(previous => previous[key] ? previous : editConnectorMemberDraft(previous, binding, value, null, ['input', 'answer', 'permission'], 'room'))
  }, [binding, props.creator, access, drafts, props.requests])
  const rows = new Map<string, { actor: ConnectionActor; name: string; observed: boolean }>()
  function include(value: ConnectionActor, name = value.userId, observed = false) {
    if (!sameApplication(value)) return
    const key = JSON.stringify([value.idType, value.userId]), previous = rows.get(key)
    const profile = facts.profiles.get(channelMetadataSubjectKey({ kind: 'actor', actor: value }))?.observation?.profile
    rows.set(key, { actor: value, name: previous?.observed ? previous.name : profile?.name ?? name, observed: observed || previous?.observed || false })
  }
  for (const member of facts.people?.members ?? []) include(actor(member.idType, member.userId), member.name ?? member.userId, true)
  for (const grant of grants ?? []) include(grant.actor)
  for (const item of access ?? []) include(item.actor)
  for (const draft of Object.values(drafts)) if (draft.bindingId === binding.bindingId && draft.bindingRevision === binding.revision) include(draft.actor)
  for (const request of props.requests) include(request.intent.input.actor)
  if (props.creator) include(actor(props.creator.idType, props.creator.userId))
  if (props.account.idType && props.account.userId) include(actor(props.account.idType, props.account.userId))
  const earlier = Object.entries(drafts).filter(([, draft]) => draft.bindingId === binding.bindingId && draft.bindingRevision !== binding.revision && sameApplication(draft.actor))
  function displayName(row: { actor: ConnectionActor; name: string }) {
    const peers = [...rows.values()].filter(other => other.name === row.name && JSON.stringify(other.actor) !== JSON.stringify(row.actor))
    if (row.name !== row.actor.userId && !peers.length) return row.name
    let length = 4
    while (length < row.actor.userId.length && peers.some(other => other.actor.userId.slice(-length) === row.actor.userId.slice(-length))) length++
    return `${row.name === row.actor.userId ? 'Account' : row.name} · …${row.actor.userId.slice(-length)}`
  }
  function discard(key: string) { props.changeDrafts(current => { const next = { ...current }; delete next[key]; return next }) }

  return <section className="agent-connector-section connector-member-access" aria-label="Member access" data-connection-section="members" data-member-access tabIndex={-1}>
    <div className="agent-connector-section-title">{props.heading !== false ? <h3><AccessIcon size={16} />Member access</h3> : <span className="agent-connector-note">Saved access for this group</span>}<button className="agent-connector-text-action" disabled={facts.pending} onClick={() => void facts.refresh()}>Refresh members</button></div>
    <p className="agent-connector-note">Choose a person to edit. Save applies only to that person’s access.</p>
    {binding.state === 'paused' ? <p className="agent-connector-note" role="status">Sharing is paused. Saved access and your edits are kept. Resume sharing to save member changes.</p> : null}
    {access === null ? <p className="agent-connector-note" role="status">The access source is not confirmed. Last confirmed local choices and your edits are kept; review current access before changing the source.</p> : null}
    {facts.people?.observation.state !== 'ready' || facts.issue ? <p className="agent-connector-note">Group membership could not be fully checked. Saved access and exact accounts remain available.</p> : null}
    {!rows.size ? <p className="agent-connector-note">No members are confirmed in this reading. Refresh or enter an exact account below.</p> : null}
    <ConnectorProfileUpdates reads={facts.profiles} />
    <div className="connector-member-list">{[...rows.entries()].map(([identity, row], index) => {
      const profileRead = facts.profiles.get(channelMetadataSubjectKey({ kind: 'actor', actor: row.actor })), profile = profileRead?.observation?.profile
      const key = connectorMemberKey(binding, row.actor), draft = drafts[key], dirty = !!draft && connectorMemberDirty(draft)
      const observed = observation(row.actor), grant = localGrant(row.actor, observed)
      const originalSource = observed ? observed.local.kind === 'none' ? 'application' : 'room' : grant ? 'room' : ''
      const desiredSource = draft?.source ?? (draft ? 'room' : originalSource)
      const confirmed = observed ? observed.effective?.state === 'active' ? observed.effective.capabilities : [] : savedMemberCapabilities(grant)
      const desired = draft?.capabilities ?? (originalSource === 'room' ? savedMemberCapabilities(grant) : confirmed)
      const requests = props.requests.filter(value => value.intent.input.actor.idType === row.actor.idType && value.intent.input.actor.userId === row.actor.userId)
      const pending = requests.find(value => value.state !== 'applied' && value.state !== 'refused')
      const refusals = requests.filter(value => {
        if (value.state !== 'refused') return false
        const ref = value.intent.method === 'connection.grant' ? { grantId: value.intent.input.grantId, revision: value.intent.input.expectedRevision } : value.intent.input.expectedGrant
        return grant ? ref.grantId === grant.grantId && ref.revision === grant.revision : ref.revision === null
      })
      const refused = refusals[0], reviewRequired = refusals.some(value => !draft?.reviewedOperations?.includes(value.intent.input.operationId))
      const busy = props.flights.has(key), baselineCurrent = !!draft && !reviewRequired && connectorMemberBaselineCurrent(draft, grant)
      const needsReview = !!draft && !baselineCurrent
      const unresolved = dirty || needsReview || !!pending || reviewRequired || busy
      const expanded = editing.has(key) || unresolved
      const controlsId = `${editorId}-${index}`
      const accessSummary = observed || grant !== undefined ? capabilitySummary(confirmed) : 'Access unconfirmed'
      const state = pending ? 'pending' : binding.state === 'paused' ? 'paused' : dirty || needsReview ? 'dirty' : observed || grant ? 'saved' : 'unconfirmed'
      const change = (capability: ConnectionGrant['capabilities'][number], enabled: boolean) => props.changeDrafts(previous => editConnectorMemberDraft(previous, binding, row.actor, observed?.local.kind === 'review-required' && !previous[key] ? undefined : grant, enabled ? [...desired, capability] : desired.filter(value => value !== capability), 'room'))
      const changeSource = (source: 'room' | 'application') => props.changeDrafts(previous => editConnectorMemberDraft(previous, binding, row.actor, observed?.local.kind === 'review-required' && !previous[key] ? undefined : grant, source === 'room' ? confirmed : desired, source))
      return <div className="connector-member-row" key={identity} data-member-row={identity} data-member-state={state}>
        <div className="connector-member-row__summary"><ConnectorEntityIdentity identityKey={JSON.stringify([facts.identity, key])} kind="person" profileRead={profileRead} name={row.name !== row.actor.userId ? row.name : profile?.name} label={displayName(row)} avatarUrl={profile?.avatarUrl} missingName="Account"
            secondary={props.creator?.idType === row.actor.idType && props.creator.userId === row.actor.userId ? 'Bot creator' : undefined} status={<span role="status">{busy ? props.flights.get(key) === 'saving' ? 'Saving changes' : 'Checking original result' : pending ? pending.state === 'not-dispatched' ? 'Original change not sent' : 'Original result unconfirmed' : binding.state === 'paused' ? 'Paused' : needsReview ? dirty ? 'Unsaved · review current access' : 'Saved access changed' : dirty ? 'Unsaved changes' : observed ? observed.effective?.state === 'active' ? 'Saved' : 'No access' : grant === undefined ? 'Access unconfirmed' : grant?.state === 'active' ? 'Last confirmed local access' : 'No access'}</span>} /><small className="connector-member-row__saved">{accessSummary}{originalSource ? <span>{originalSource === 'room' ? 'This group' : 'Bot settings'}</span> : null}</small>
          {!expanded || !unresolved ? <button type="button" className="small-button connector-member-row__edit" data-member-edit aria-label={`${expanded ? 'Done editing' : 'Edit access for'} ${row.name}`} aria-expanded={expanded} aria-controls={controlsId} onClick={() => setEditing(current => { const next = new Set(current); if (expanded) next.delete(key); else next.add(key); return next })}>{expanded ? 'Done' : 'Edit'}</button> : null}
        </div>
        <details className="agent-connector-disclosure"><summary>Account details</summary><ConnectorIdentityField identityKey={key} label={row.actor.idType} value={row.actor.userId} /><ConnectorIdentityField identityKey={key} label="App ID" value={row.actor.application.appId} />{!row.observed ? <small>Not in the current member page</small> : null}</details>
        {expanded ? <div id={controlsId} className="connector-member-row__editor" data-member-editor>
        <label className="agent-connector-field">Access settings<select aria-label={`Access source for ${row.name}`} value={desiredSource} onChange={event => changeSource(event.target.value as 'room' | 'application')}><option value="" disabled>Source unconfirmed</option><option value="application">Use bot settings</option><option value="room">Only this group</option></select></label>
        {desiredSource === 'application' && originalSource === 'room' ? <p className="agent-connector-note">Bot settings will apply after Save. Current confirmed access: {capabilitySummary(confirmed)}.</p> : <><p className="agent-connector-note">{desiredSource === 'application' ? 'Inherited from this bot’s member settings.' : 'An explicit decision for this group.'}</p><ConnectorMemberChoices name={row.name} value={desired} change={change} scope="group" disabled={desiredSource !== 'room'} /></>}
        {dirty || needsReview ? <p className="agent-connector-note">Last confirmed access: {capabilitySummary(confirmed)}</p> : null}
        {observed?.local.kind === 'review-required' ? <p className="agent-connector-note">The original group decision needs a current review. Its saved choices do not grant access until you explicitly save or inherit.</p> : null}
        {pending ? <p className="agent-connector-note">Original request: {pending.intent.method === 'connection.grant' ? capabilitySummary(pending.intent.input.capabilities) : 'Use bot settings'}. The controls above remain your editable draft.</p> : null}
        {refused ? <p className="agent-connector-note">{reviewRequired ? 'An earlier change was refused. Review current access to correct your changes.' : 'The original refusal is kept. Your revised choices are not saved yet.'}</p> : null}
        <div className="connector-member-row__actions">
          {pending ? <button className="small-button" data-member-inspect disabled={busy} onClick={() => props.inspect(pending.intent)}>Check original result</button> : null}
          {pending?.state === 'not-dispatched' && binding.state === 'active' ? <button className="small-button" disabled={busy} onClick={() => props.resume(pending.intent)}>Continue original change</button> : null}
          {dirty && !pending && binding.state === 'active' && baselineCurrent ? <button className="primary-button" data-member-save disabled={busy} onClick={() => props.save(row.actor, draft!.capabilities, draft!.baseline === 'unconfirmed' ? null : draft!.baseline, desiredSource === 'application' ? 'application' : 'room')}>{desiredSource === 'application' ? 'Save bot inheritance' : 'Save for this group'}</button> : null}
          {needsReview || refused && reviewRequired ? <button className="small-button" data-member-review disabled={busy} onClick={() => props.review(row.actor, key, refused?.intent)}>Review current access</button> : null}
          {dirty || needsReview ? <button className="agent-connector-text-action" disabled={busy} onClick={() => props.changeDrafts(previous => ({ ...previous, [key]: { bindingId: binding.bindingId, bindingRevision: binding.revision, actor: row.actor, baseline: grant === undefined ? 'unconfirmed' : grant, source: originalSource === 'room' ? 'room' : 'application', capabilities: originalSource === 'room' ? savedMemberCapabilities(grant) : confirmed } }))}>Discard changes</button> : null}
          {refused ? <button className="agent-connector-text-action" disabled={busy} onClick={() => props.inspect(refused.intent)}>View refused result</button> : null}
        </div>
        {requests.length ? <details className="agent-connector-disclosure"><summary>Original change receipts</summary>{requests.map(request => <div key={request.intent.input.operationId} className="agent-connector-fields"><code>{request.intent.input.operationId}</code><small>{request.state} · Group revision {request.intent.input.expectedBindingRevision}</small></div>)}</details> : null}
        </div> : null}
      </div>
    })}</div>
    {facts.people?.next ? <button className="agent-connector-text-action" disabled={facts.pending} onClick={() => void facts.refresh(facts.people!.next!)}>More members</button> : null}
    <details className="agent-connector-disclosure"><summary>Exact account details</summary><div className="agent-connector-fields"><label className="agent-connector-field">Member ID type<TextInput aria-label="Member access ID type" value={props.account.idType} onChange={event => props.account.change(event.target.value, props.account.userId)} /></label><label className="agent-connector-field">Member ID<TextInput aria-label="Member access ID" value={props.account.userId} onChange={event => props.account.change(props.account.idType, event.target.value)} /></label></div></details>
    {earlier.length ? <div className="connector-member-earlier"><h4>Earlier unsaved member changes</h4>{earlier.map(([key, draft]) => <div key={key} className="connector-member-row" data-member-earlier={key}><strong>{displayName(rows.get(JSON.stringify([draft.actor.idType, draft.actor.userId])) ?? { actor: draft.actor, name: draft.actor.userId })}</strong><p className="agent-connector-note">Saved settings changed. Original group revision {draft.bindingRevision}: {draft.source === 'application' ? 'Use bot settings' : capabilitySummary(draft.capabilities)}. Review current access before applying these choices.</p><details className="agent-connector-disclosure"><summary>Account details</summary><ConnectorIdentityField identityKey={key} label={draft.actor.idType} value={draft.actor.userId} /></details><div className="connector-member-row__actions"><button className="small-button" disabled={props.flights.has(connectorMemberKey(binding, draft.actor))} onClick={() => props.review(draft.actor, key)}>Review current access</button><button className="agent-connector-text-action" onClick={() => discard(key)}>Discard changes</button></div></div>)}</div> : null}
  </section>
}
