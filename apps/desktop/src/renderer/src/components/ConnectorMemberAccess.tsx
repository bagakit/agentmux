import type { Dispatch, SetStateAction } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ConnectionActor, ConnectionGrant, RoomBinding } from '@agentmux/core/connections'
import type { ConnectorRoomIntent } from '../lib/connector-room-intent'
import { connectorMemberBaselineCurrent, connectorMemberKey, editConnectorMemberDraft, savedMemberCapabilities, type ConnectorMemberDrafts } from '../lib/connector-member-draft'
import type { useConnectorRoomFacts } from './ConnectorRoomSelection'

const AccessIcon = semanticIconComponent('status.permission')
type MemberIntent = Extract<ConnectorRoomIntent, { method: 'connection.grant' }>
export type ConnectorMemberRequest = { intent: MemberIntent; state: 'not-dispatched' | 'unconfirmed' | 'applied' | 'refused' }
type Props = {
  binding: RoomBinding
  facts: ReturnType<typeof useConnectorRoomFacts>
  grants: ConnectionGrant[] | null
  creator: { idType: string; userId: string } | null
  drafts: ConnectorMemberDrafts
  changeDrafts: Dispatch<SetStateAction<ConnectorMemberDrafts>>
  account: { idType: string; userId: string; change(idType: string, userId: string): void }
  requests: ConnectorMemberRequest[]
  flights: Map<string, 'checking' | 'saving'>
  save(actor: ConnectionActor, capabilities: ConnectionGrant['capabilities'], baseline: ConnectionGrant | null): void
  inspect(intent: MemberIntent): void
  resume(intent: MemberIntent): void
  review(actor: ConnectionActor, draftKey: string, refused?: MemberIntent): void
}

/** Native membership is an observation; only original Host grant receipts describe access. */
export function ConnectorMemberAccess(props: Props) {
  const { binding, grants, drafts, facts } = props
  const actor = (idType: string, userId: string): ConnectionActor => ({ application: binding.application, idType, userId })
  const sameApplication = (value: ConnectionActor) => value.application.domain === binding.application.domain && value.application.appId === binding.application.appId
  const rows = new Map<string, { actor: ConnectionActor; name: string; observed: boolean }>()
  function include(value: ConnectionActor, name = value.userId, observed = false) {
    if (!sameApplication(value)) return
    const key = JSON.stringify([value.idType, value.userId]), previous = rows.get(key)
    rows.set(key, { actor: value, name: previous?.observed ? previous.name : name, observed: observed || previous?.observed || false })
  }
  for (const member of facts.people?.members ?? []) include(actor(member.idType, member.userId), member.name ?? member.userId, true)
  for (const grant of grants ?? []) include(grant.actor)
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
    <div className="agent-connector-section-title"><h3><AccessIcon size={16} />Member access</h3><button className="agent-connector-text-action" disabled={facts.pending} onClick={() => void facts.refresh()}>Refresh members</button></div>
    <p className="agent-connector-note">Choose what each person can do. Changes apply only when you save that person.</p>
    {binding.state === 'paused' ? <p className="agent-connector-note" role="status">Sharing is paused. Saved access and your edits are kept. Resume sharing to save member changes.</p> : null}
    {grants === null ? <p className="agent-connector-note" role="status">Current access is not confirmed. Your edits are kept; review current access before saving.</p> : null}
    {facts.people?.observation.state !== 'ready' || facts.issue ? <p className="agent-connector-note">Group membership could not be fully checked. Saved access and exact accounts remain available.</p> : null}
    {!rows.size ? <p className="agent-connector-note">No members are confirmed in this reading. Refresh or enter an exact account below.</p> : null}
    <div className="connector-member-list">{[...rows.entries()].map(([identity, row]) => {
      const key = connectorMemberKey(binding, row.actor), draft = drafts[key]
      const grant = grants === null ? undefined : grants.find(value => value.actor.idType === row.actor.idType && value.actor.userId === row.actor.userId) ?? null
      const desired = draft?.capabilities ?? savedMemberCapabilities(grant)
      const requests = props.requests.filter(value => value.intent.input.actor.idType === row.actor.idType && value.intent.input.actor.userId === row.actor.userId)
      const pending = requests.find(value => value.state !== 'applied' && value.state !== 'refused')
      const refusals = requests.filter(value => value.state === 'refused' && (grant ? value.intent.input.grantId === grant.grantId && value.intent.input.expectedRevision === grant.revision : value.intent.input.expectedRevision === null))
      const refused = refusals[0]
      const reviewRequired = refusals.some(value => !draft?.reviewedOperations?.includes(value.intent.input.operationId))
      const busy = props.flights.has(key), baselineCurrent = !!draft && !reviewRequired && connectorMemberBaselineCurrent(draft, grant)
      const state = pending ? 'pending' : binding.state === 'paused' ? 'paused' : draft ? 'dirty' : grant === undefined ? 'unconfirmed' : 'saved'
      const change = (capability: ConnectionGrant['capabilities'][number], enabled: boolean) => props.changeDrafts(current => editConnectorMemberDraft(current, binding, row.actor, grant, enabled ? [...desired, capability] : desired.filter(value => value !== capability)))
      return <div className="connector-member-row" key={identity} data-member-row={identity} data-member-state={state}>
        <div className="connector-member-row__identity"><strong>{displayName(row)}</strong>{props.creator?.idType === row.actor.idType && props.creator.userId === row.actor.userId ? <small>Bot creator</small> : null}<span role="status">{busy ? props.flights.get(key) === 'saving' ? 'Saving changes' : 'Checking original result' : pending ? pending.state === 'not-dispatched' ? 'Original change not sent' : 'Original result unconfirmed' : binding.state === 'paused' ? 'Paused' : draft ? 'Unsaved changes' : grant === undefined ? 'Access unconfirmed' : grant?.state === 'active' ? 'Saved' : 'No access'}</span></div>
        <div className="connector-member-row__choices">
          <label><input type="checkbox" aria-label={`Send requests for ${row.name}`} checked={desired.includes('input')} onChange={event => change('input', event.target.checked)} />Send requests</label>
          <label><input type="checkbox" aria-label={`Answer questions for ${row.name}`} checked={desired.includes('answer')} onChange={event => change('answer', event.target.checked)} />Answer questions</label>
        </div>
        <details className="agent-connector-disclosure"><summary>Permission decisions{desired.includes('permission') ? ' · allowed' : ''}</summary><label className="agent-connector-check"><input type="checkbox" aria-label={`Allow permission decisions for ${row.name}`} checked={desired.includes('permission')} onChange={event => change('permission', event.target.checked)} />Allow permission decisions</label><p className="agent-connector-note">This group receives the original request and tool details for this person to decide. Requests and answers do not grant this control.</p></details>
        <details className="agent-connector-disclosure"><summary>Account details</summary><small>{row.actor.idType} · {row.actor.userId}{!row.observed ? ' · Not in the current member page' : ''}</small></details>
        {draft ? <p className="agent-connector-note">Last confirmed: {grant === undefined ? 'not checked' : grant?.state === 'active' ? grant.capabilities.map(value => value === 'input' ? 'Requests' : value === 'answer' ? 'Answers' : 'Permission decisions').join(', ') : 'No access'}</p> : null}
        {pending ? <p className="agent-connector-note">Original requested choices: {pending.intent.input.capabilities.join(', ') || 'No access'}. The current saved choices above are separate.</p> : null}
        {refused ? <p className="agent-connector-note">{reviewRequired ? 'An earlier change was refused. Review current access to correct your changes.' : 'The original refusal is kept. Your revised choices are not saved yet.'}</p> : null}
        <div className="connector-member-row__actions">
          {pending ? <button className="small-button" data-member-inspect disabled={busy} onClick={() => props.inspect(pending.intent)}>Check original result</button> : null}
          {pending?.state === 'not-dispatched' && binding.state === 'active' ? <button className="small-button" disabled={busy} onClick={() => props.resume(pending.intent)}>Continue original change</button> : null}
          {draft && !pending && binding.state === 'active' && baselineCurrent ? <button className="primary-button" data-member-save disabled={busy} onClick={() => props.save(row.actor, draft.capabilities, draft.baseline === 'unconfirmed' ? null : draft.baseline)}>Save changes</button> : null}
          {draft && !baselineCurrent || refused && reviewRequired ? <button className="small-button" data-member-review disabled={busy} onClick={() => props.review(row.actor, key, refused?.intent)}>Review current access</button> : null}
          {draft ? <button className="agent-connector-text-action" disabled={busy} onClick={() => discard(key)}>Discard changes</button> : null}
          {refused ? <button className="agent-connector-text-action" disabled={busy} onClick={() => props.inspect(refused.intent)}>View refused result</button> : null}
        </div>
        {requests.length ? <details className="agent-connector-disclosure"><summary>Original change receipts</summary>{requests.map(request => <div key={request.intent.input.operationId} className="agent-connector-fields"><code>{request.intent.input.operationId}</code><small>{request.state} · Group revision {request.intent.input.expectedBindingRevision}</small></div>)}</details> : null}
      </div>
    })}</div>
    {facts.people?.next ? <button className="agent-connector-text-action" disabled={facts.pending} onClick={() => void facts.refresh(facts.people!.next!)}>More members</button> : null}
    <details className="agent-connector-disclosure"><summary>Exact account details</summary><div className="agent-connector-fields"><label className="agent-connector-field">Member ID type<TextInput aria-label="Member access ID type" value={props.account.idType} onChange={event => props.account.change(event.target.value, props.account.userId)} /></label><label className="agent-connector-field">Member ID<TextInput aria-label="Member access ID" value={props.account.userId} onChange={event => props.account.change(props.account.idType, event.target.value)} /></label></div></details>
    {earlier.length ? <div className="connector-member-earlier"><h4>Earlier unsaved member changes</h4>{earlier.map(([key, draft]) => <div key={key} className="connector-member-row" data-member-earlier={key}><strong>{displayName(rows.get(JSON.stringify([draft.actor.idType, draft.actor.userId])) ?? { actor: draft.actor, name: draft.actor.userId })}</strong><p className="agent-connector-note">Saved settings changed. Original group revision {draft.bindingRevision}: {draft.capabilities.join(', ') || 'No access'}. Review current access before applying these choices.</p><details className="agent-connector-disclosure"><summary>Account details</summary><small>{draft.actor.idType} · {draft.actor.userId}</small></details><div className="connector-member-row__actions"><button className="small-button" disabled={props.flights.has(connectorMemberKey(binding, draft.actor))} onClick={() => props.review(draft.actor, key)}>Review current access</button><button className="agent-connector-text-action" onClick={() => discard(key)}>Discard changes</button></div></div>)}</div> : null}
  </section>
}
