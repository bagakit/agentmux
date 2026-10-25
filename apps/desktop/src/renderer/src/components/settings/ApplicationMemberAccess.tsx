import { useEffect, useMemo, useRef, useState } from 'react'
import { channelMetadataSubjectKey, parseConnectionParams, type ChannelMetadataEntry, type ConnectionActor, type ConnectionApplicationAccess, type ConnectionApplicationAccessOperation, type ConnectionApplicationGrant, type ConnectionGrant, type ConnectionRecord } from '@agentmux/core/connections'
import { mintObjectId } from '@agentmux/core/object-id'
import { TextInput } from '@agentmux/client-ui/input'
import { ConnectorEntityIdentity, ConnectorIdentityField } from '../ConnectorEntityIdentity'
import { useConnectorEntityProfiles } from '../../lib/use-connector-room-name'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionHostingTarget } from '../../../../shared/contracts'
import { connectionSettingsPort } from '../../lib/connection-settings-port'
import { applicationMemberDirty, applicationMemberKey, editApplicationMemberDraft, emptyApplicationAccess, type ApplicationAccessContinuation, type ApplicationMemberRequest } from '../../lib/application-member-intent'
import { manualConnectionScope, type ManualConnectionIntent } from '../../lib/manual-connection-intent'
import { sameMemberCapabilities, savedMemberCapabilities } from '../../lib/connector-member-draft'
import { retainManualApplicationAccess, useAppStore } from '../../store'
import { useConnectorCreatorInvitation } from '../ConnectorCreatorInvitation'
import { ConnectorMemberChoices } from '../ConnectorMemberChoices'

type Props = {
  record: ConnectionRecord; hostingTarget: ConnectionHostingTarget | null; intent: ManualConnectionIntent; active: boolean
}
export function ApplicationMemberAccess(props: Props) {
  const [open, setOpen] = useState(false)
  return <details className="agent-connector-disclosure" data-application-access-settings open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>All groups · Member access</summary>{open ? <ApplicationMemberAccessEditor {...props} /> : null}</details>
}

/** Application rules are not a directory or a copy of group grants. */
function ApplicationMemberAccessEditor({ record, hostingTarget, intent, active }: Props) {
  const scope = JSON.stringify([hostingTarget, record.config.connectionId, record.revision, record.config.adapterId, record.config.application])
  const manualKey = manualConnectionScope(intent.channel, hostingTarget), empty = useMemo(emptyApplicationAccess, [])
  const retained = useAppStore(state => state.manualConnectionIntents[manualKey]?.applicationAccess) ?? empty
  const source = useMemo(() => connectionSettingsPort(hostingTarget), [JSON.stringify(hostingTarget)])
  const [reading, setReading] = useState<{ scope: string; value: ConnectionApplicationAccess | null; issue: string }>({ scope: '', value: null, issue: '' })
  const [profiles, setProfiles] = useState<ChannelMetadataEntry[]>([]), [next, setNext] = useState<string | null>(null), [profileIssue, setProfileIssue] = useState('')
  const [results, setResults] = useState<Record<string, ConnectionApplicationAccessOperation | null>>({})
  const [flights, setFlights] = useState(new Map<string, 'checking' | 'saving'>()), inFlight = useRef(new Map<string, 'checking' | 'saving'>())
  const [account, setAccount] = useState({ idType: '', userId: '' }), [issue, setIssue] = useState('')
  const context = useRef({ scope, active }), order = useRef(0); context.current = { scope, active }
  const current = () => context.current.scope === scope && context.current.active
  const creatorReading = useConnectorCreatorInvitation(record, active, hostingTarget)
  const application = record.config.application, adapterId = record.config.adapterId
  const sameApplication = (actor: ConnectionActor) => actor.application.domain === application.domain && actor.application.appId === application.appId
  const belongs = (value: { adapterId: string; actor: ConnectionActor }) => value.adapterId === adapterId && sameApplication(value.actor)
  const requests = Object.values(retained.requests).filter(value => belongs({ adapterId: value.adapterId, actor: value.input.actor }))
  const value = reading.scope === scope ? reading.value : null
  const readIssue = reading.scope === scope ? reading.issue : ''
  function update(change: (previous: ApplicationAccessContinuation) => ApplicationAccessContinuation, flush = false) { return retainManualApplicationAccess(intent, change, flush) }
  function localFeedback(error: unknown) { if (current()) setIssue('App saved view could not be retained. Original Host results are kept. ' + presentError(error)) }
  function edit(actor: ConnectionActor, grant: ConnectionApplicationGrant | null | undefined, capabilities: ConnectionGrant['capabilities']) {
    const key = applicationMemberKey(adapterId, actor)
    void update(previous => ({ ...previous, drafts: { ...previous.drafts, [key]: editApplicationMemberDraft(previous.drafts[key], adapterId, actor, grant, capabilities)! } })).catch(localFeedback)
  }
  async function read() {
    const request = ++order.current
    try {
      const result = await source.call('connection.application.access.get', { connectionId: record.config.connectionId })
      if (!current() || request !== order.current) return null
      if (result.connectionId !== record.config.connectionId || result.connectionRevision !== record.revision || result.adapterId !== adapterId || result.application.domain !== application.domain || result.application.appId !== application.appId) throw new Error('This access reading does not describe the original bot configuration.')
      setReading({ scope, value: result, issue: '' }); return result
    } catch (error) {
      if (current() && request === order.current) setReading(previous => ({ scope, value: previous.scope === scope ? previous.value : null, issue: presentError(error) }))
      return null
    }
  }
  async function people(cursor?: string) {
    try {
      const result = await source.call('connection.metadata.ls', { connectionId: record.config.connectionId, kind: 'actor', limit: 25, ...(cursor ? { cursor } : {}) })
      if (!current()) return
      if (result.application.domain !== application.domain || result.application.appId !== application.appId) throw new Error('These saved profiles belong to another bot.')
      setProfiles(previous => cursor ? [...previous, ...result.entries] : result.entries); setNext(result.next); setProfileIssue('')
    } catch (error) { if (current()) setProfileIssue(presentError(error)) }
  }
  async function accept(request: ApplicationMemberRequest, result: ConnectionApplicationAccessOperation | null) {
    if (result && result.operationId !== request.input.operationId) throw new Error('This receipt belongs to another original member change.')
    if (result?.state === 'applied') {
      const grant = result.grant, input = request.input
      if (!belongs({ adapterId: request.adapterId, actor: input.actor }) || grant.adapterId !== request.adapterId || JSON.stringify(grant.actor) !== JSON.stringify(input.actor) || grant.grantId !== input.grantId || grant.revision !== (input.expectedRevision ?? 0) + 1 || grant.state !== input.state || !sameMemberCapabilities(grant.capabilities, input.capabilities)) throw new Error('This receipt does not confirm the original member choices.')
    }
    if (!current()) return
    setResults(previous => ({ ...previous, [request.input.operationId]: result }))
    if (result?.state === 'applied') {
      order.current++
      setReading(previous => previous.scope === scope && previous.value ? { ...previous, value: { ...previous.value, grants: [...previous.value.grants.filter(grant => JSON.stringify(grant.actor) !== JSON.stringify(result.grant.actor)), result.grant] } } : previous)
      const saved = await update(previous => {
        const requests = { ...previous.requests }, drafts = { ...previous.drafts }, key = applicationMemberKey(request.adapterId, request.input.actor)
        const original = requests[request.input.operationId]
        if (!original || JSON.stringify(original.input) !== JSON.stringify(request.input)) return previous
        delete requests[request.input.operationId]
        if (drafts[key]?.decision === 'rule' && sameMemberCapabilities(drafts[key]!.capabilities, request.input.capabilities)) drafts[key] = { ...drafts[key]!, baseline: result.grant }
        return { drafts, requests }
      }, true)
      if (!saved?.localStorageWritten && current()) setIssue('The Host saved this access, but App saved view could not be retained. Check the same original result after reopening.')
      if (current()) await read()
    }
  }
  async function work(original: ApplicationMemberRequest, dispatch = false) {
    const key = applicationMemberKey(original.adapterId, original.input.actor)
    if (inFlight.current.has(key)) return
    inFlight.current.set(key, dispatch ? 'saving' : 'checking'); setFlights(new Map(inFlight.current)); setIssue('')
    try {
      const request = { ...original, input: parseConnectionParams('connection.application.access.configure', original.input) }
      if (dispatch && request.phase === 'not-dispatched') {
        const saved = await update(previous => {
          const original = previous.requests[request.input.operationId]
          if (original && JSON.stringify(original) !== JSON.stringify(request)) throw new Error('The original member request changed. Inspect it without replacing its input.')
          return { ...previous, requests: { ...previous.requests, [request.input.operationId]: request } }
        }, true)
        if (!saved?.localStorageWritten) throw new Error('This exact request could not be retained. It has not been sent.')
        if (!current()) return
        const frozen = { ...request, phase: 'may-have-dispatched' as const }
        const ready = await update(previous => ({ ...previous, requests: { ...previous.requests, [request.input.operationId]: frozen } }), true)
        if (!ready?.localStorageWritten) throw new Error('Dispatch preparation could not be retained. Keep this original request and check its result.')
        if (!current()) return
        await accept(frozen, await source.call('connection.application.access.configure', frozen.input))
      } else await accept(request, (await source.call('connection.application.access.inspect', { operationId: request.input.operationId })).operation)
    } catch (error) { if (current()) setIssue(presentError(error)) }
    finally { inFlight.current.delete(key); if (current()) setFlights(new Map(inFlight.current)) }
  }
  useEffect(() => {
    context.current = { scope, active }
    setReading({ scope, value: null, issue: '' }); setProfiles([]); setNext(null); setResults({}); setAccount({ idType: '', userId: '' }); setIssue('')
    if (active && hostingTarget) { void read(); void people(); for (const request of requests) void work(request) }
    return () => { order.current++; context.current = { scope, active: false } }
  }, [scope, active])
  useEffect(() => {
    const creator = creatorReading.creator
    if (!active || !creator || !value || readIssue) return
    const actor: ConnectionActor = { application, ...creator }, key = applicationMemberKey(adapterId, actor)
    if (value.grants.some(grant => JSON.stringify(grant.actor) === JSON.stringify(actor)) || retained.drafts[key] || requests.some(request => JSON.stringify(request.input.actor) === JSON.stringify(actor)) || Object.values(results).some(result => result?.state === 'applied' && JSON.stringify(result.grant.actor) === JSON.stringify(actor))) return
    edit(actor, null, ['input', 'answer', 'permission'])
  }, [scope, active, creatorReading.creator, value, readIssue, retained, results])
  async function review(actor: ConnectionActor, refused?: ApplicationMemberRequest) {
    const latest = await read()
    if (!latest || !current()) return
    const key = applicationMemberKey(adapterId, actor), baseline = latest.grants.find(grant => JSON.stringify(grant.actor) === JSON.stringify(actor)) ?? null
    const reviewedOperations = requests.filter(request => JSON.stringify(request.input.actor) === JSON.stringify(actor) && results[request.input.operationId]?.state === 'refused').map(request => request.input.operationId)
    await update(previous => {
      const draft = previous.drafts[key]
      if (!draft && !refused) return previous
      return { ...previous, drafts: { ...previous.drafts, [key]: { adapterId, actor, baseline, decision: draft?.decision === 'absent' && baseline ? 'rule' : draft?.decision ?? 'rule', capabilities: draft?.capabilities ?? refused!.input.capabilities, reviewedOperations } } }
    })
  }
  const rows = new Map<string, { actor: ConnectionActor; name: string; named: boolean; avatar?: string }>()
  function include(actor: ConnectionActor, name?: string, avatar?: string) {
    if (!sameApplication(actor)) return
    const key = applicationMemberKey(adapterId, actor), previous = rows.get(key)
    const image = previous?.avatar ?? avatar
    rows.set(key, { actor, name: previous?.named ? previous.name : name ?? previous?.name ?? 'Account · …' + actor.userId.slice(-4), named: previous?.named || !!name, ...(image ? { avatar: image } : {}) })
  }
  for (const entry of profiles) if (entry.subject.kind === 'actor') include(entry.subject.actor, entry.observation.profile?.name, entry.observation.profile?.avatarUrl)
  for (const grant of value?.grants ?? []) include(grant.actor)
  for (const result of Object.values(results)) if (result?.state === 'applied') include(result.grant.actor)
  for (const draft of Object.values(retained.drafts)) if (belongs(draft)) include(draft.actor)
  for (const request of requests) include(request.input.actor)
  if (creatorReading.creator) include({ application, ...creatorReading.creator })
  if (account.idType && account.userId) include({ application, ...account })
  const visibleProfiles = useConnectorEntityProfiles(record.config, [...rows.values()].map(row => ({ kind: 'actor', actor: row.actor })), hostingTarget, active)
  for (const [key, row] of rows) {
    const observation = visibleProfiles.get(channelMetadataSubjectKey({ kind: 'actor', actor: row.actor }))?.observation
    if (observation) {
      const profile = observation.profile
      rows.set(key, { actor: row.actor, name: profile?.name ?? 'Account · …' + row.actor.userId.slice(-4), named: !!profile?.name, ...(profile?.avatarUrl ? { avatar: profile.avatarUrl } : {}) })
    }
  }
  return <section className="agent-connector-section connector-member-access" aria-label="All groups member access" data-application-member-access>
    <div className="agent-connector-section-title"><h3>All groups · Member access</h3><button type="button" className="agent-connector-text-action" onClick={() => void read()}>Refresh access</button></div>
    <p className="agent-connector-note">Rules for this bot’s current and future groups. A group’s own member settings take precedence. Saved people are profile observations, not a group member list.</p>
    {!hostingTarget ? <p role="status">The original bot hosting owner is not confirmed. No access change can be sent from this view.</p> : null}
    {readIssue ? <p role="status" className="agent-connector-note">Member access could not be confirmed. Saved observations and your edits are kept. {readIssue}</p> : !value ? <p role="status" className="agent-connector-note">Reading this bot’s member rules…</p> : null}
    <div className="connector-member-list">{[...rows.entries()].map(([key, row]) => {
      const observed = value ? value.grants.find(grant => JSON.stringify(grant.actor) === JSON.stringify(row.actor)) ?? null : undefined
      const receipt = Object.values(results).filter((result): result is Extract<ConnectionApplicationAccessOperation, { state: 'applied' }> => result?.state === 'applied' && JSON.stringify(result.grant.actor) === JSON.stringify(row.actor)).map(result => result.grant).sort((a, b) => b.revision - a.revision)[0]
      const grant = receipt && (!observed || receipt.grantId === observed.grantId && receipt.revision > observed.revision) ? receipt : observed
      const draft = retained.drafts[key], desired = draft?.capabilities ?? savedMemberCapabilities(grant), dirty = !!draft && applicationMemberDirty(draft)
      const own = requests.filter(request => applicationMemberKey(request.adapterId, request.input.actor) === key)
      const pending = own.find(request => !['applied', 'refused'].includes(results[request.input.operationId]?.state ?? ''))
      const refused = own.filter(request => results[request.input.operationId]?.state === 'refused' && (grant ? request.input.grantId === grant.grantId && request.input.expectedRevision === grant.revision : request.input.expectedRevision === null))
      const reviewRequired = refused.some(request => !draft?.reviewedOperations?.includes(request.input.operationId))
      const baselineCurrent = !!draft && draft.baseline !== 'unconfirmed' && grant !== undefined && (draft.baseline === null ? grant === null : draft.baseline.grantId === grant?.grantId && draft.baseline.revision === grant.revision)
      const needsReview = !!draft && !baselineCurrent
      const activity = flights.get(key), creator = creatorReading.creator?.idType === row.actor.idType && creatorReading.creator.userId === row.actor.userId
      const change = (capability: ConnectionGrant['capabilities'][number], enabled: boolean) => edit(row.actor, grant, enabled ? [...desired, capability] : desired.filter(value => value !== capability))
      return <div className="connector-member-row" key={key} data-application-member-row={JSON.stringify([row.actor.idType, row.actor.userId])} data-member-state={pending ? 'pending' : dirty || needsReview ? 'dirty' : value ? 'saved' : 'unconfirmed'}>
        <ConnectorEntityIdentity identityKey={key} kind="person" name={row.named ? row.name : undefined} label={row.name} missingName="Account" avatarUrl={row.avatar}
          secondary={creator ? 'Bot creator' : row.actor.idType} status={<span role="status">{activity ? activity === 'saving' ? 'Saving changes' : 'Checking original result' : pending ? pending.phase === 'not-dispatched' ? 'Original change not sent' : 'Original result unconfirmed' : dirty ? needsReview ? 'Unsaved · review current access' : 'Unsaved · all groups' : grant === undefined ? 'Access unconfirmed' : needsReview ? 'Saved access changed' : grant?.state === 'active' ? 'Saved · all groups' : 'No access'}</span>} />
        <ConnectorMemberChoices name={row.name} value={desired} change={change} scope="application" />
        <details className="agent-connector-disclosure"><summary>Account details</summary><ConnectorIdentityField identityKey={key} label={row.actor.idType} value={row.actor.userId} /><ConnectorIdentityField identityKey={key} label="App ID" value={row.actor.application.appId} /></details>
        {dirty || needsReview ? <p className="agent-connector-note">Last confirmed access: {grant === undefined ? 'not checked' : grant?.state === 'active' ? grant.capabilities.join(', ') : 'No access'}</p> : null}
        {pending ? <p className="agent-connector-note">Original requested access: {pending.input.capabilities.join(', ') || 'No access'}. These controls remain your editable draft.</p> : null}
        <div className="connector-member-row__actions">
          {pending ? <button className="small-button" disabled={!!activity} data-application-member-inspect onClick={() => void work(pending)}>Check original result</button> : null}
          {pending?.phase === 'not-dispatched' && !results[pending.input.operationId] ? <button className="small-button" disabled={!!activity} onClick={() => void work(pending, true)}>Continue original change</button> : null}
          {dirty && draft?.decision === 'rule' && baselineCurrent && !reviewRequired && !pending ? <button className="primary-button" disabled={!!activity || !hostingTarget} data-application-member-save onClick={() => void work({ adapterId, phase: 'not-dispatched', input: { operationId: mintObjectId(), connectionId: record.config.connectionId, expectedConnectionRevision: record.revision, grantId: grant?.grantId ?? mintObjectId(), expectedRevision: grant?.revision ?? null, actor: row.actor, capabilities: draft.capabilities, state: draft.capabilities.length ? 'active' : 'revoked' } }, true)}>Save for all groups</button> : null}
          {needsReview || reviewRequired || refused.length && !draft ? <button className="small-button" disabled={!!activity} data-application-member-review onClick={() => void review(row.actor, refused[0]).catch(error => { if (current()) setIssue(presentError(error)) })}>Review current access</button> : null}
          {dirty || needsReview ? <button className="agent-connector-text-action" disabled={!!activity} onClick={() => void update(previous => ({ ...previous, drafts: { ...previous.drafts, [key]: { ...previous.drafts[key]!, baseline: grant === undefined ? 'unconfirmed' : grant, decision: grant ? 'rule' : 'absent', capabilities: savedMemberCapabilities(grant) } } })).catch(localFeedback)}>Discard changes</button> : null}
          {refused.map(request => <button key={request.input.operationId} className="agent-connector-text-action" disabled={!!activity} onClick={() => void work(request)}>View refused result</button>)}
        </div>
        {own.length ? <details className="agent-connector-disclosure"><summary>Original change receipts</summary>{own.map(request => <p key={request.input.operationId} className="agent-connector-note"><code>{request.input.operationId}</code> · {results[request.input.operationId]?.state ?? 'unconfirmed'}</p>)}</details> : null}
      </div>
    })}</div>
    {next ? <button className="small-button" onClick={() => void people(next)}>More saved people</button> : null}
    {profileIssue ? <p className="agent-connector-note">Saved people could not be fully read. Exact accounts and access rules remain available.</p> : null}
    <details className="agent-connector-disclosure"><summary>Exact account details</summary><label className="agent-connector-field">ID type<TextInput aria-label="Application member ID type" value={account.idType} onChange={event => setAccount(previous => ({ ...previous, idType: event.target.value }))} /></label><label className="agent-connector-field">Member ID<TextInput aria-label="Application member ID" value={account.userId} onChange={event => setAccount(previous => ({ ...previous, userId: event.target.value }))} /></label></details>
    {issue ? <p role="status" className="surface-inline-error">{issue}</p> : null}
  </section>
}
