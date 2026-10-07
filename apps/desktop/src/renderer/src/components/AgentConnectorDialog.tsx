import * as Dialog from '@radix-ui/react-dialog'
import { useContext, useEffect, useId, useRef, useState } from 'react'
import { TextInput, Textarea } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { SelectionField } from './SelectionField'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import type { ConnectionGrant, ConnectionRecord, ConnectionDeliveryResultMap, RoomBinding, RoomBindingOperation, RoomBindingTarget, RoomProvisioningOperation } from '@agentmux/core/connections'
import type { AgentNativeSourceReference } from './AgentNativeSourceControls'
import { api } from '../lib/api'
import { clearConnectorRoomIntent, retainConnectorRoomIntent, useAppStore } from '../store'
import { invalidateConnectorTarget, sameConnectorTarget, type ConnectorRoomIntent } from '../lib/connector-room-intent'
import { MoteWorkfaceContext } from '../lib/mote-workface'
import { SettingsNavigation } from './SettingsNavigation'
import { resolveOverlayContainer } from './WindowOverlayHost'

const CloseIcon = semanticIconComponent('action.close')
const AgentIcon = semanticIconComponent('object.agent')

type Fact = RoomProvisioningOperation | RoomBindingOperation | null
export type AgentConnectorTarget = { target: RoomBindingTarget; session: AgentNativeSourceReference; name: string; connectionId?: string }
/** A bounded form over original public owners. It retains submitted correlations, never another receipt store. */
export function AgentConnectorDialog({ original, mode, onClose, returnFocus }: {
  original: AgentConnectorTarget; mode: 'create' | 'existing' | 'details'; onClose(): void; returnFocus(): HTMLElement | null
}) {
  const { target, session } = original, identity = JSON.stringify(target), fieldId = useId()
  const [changingGroup, setChangingGroup] = useState(false)
  const mote = useContext(MoteWorkfaceContext), settings = useContext(SettingsNavigation)
  const [connections, setConnections] = useState<ConnectionRecord[]>([]), [bindings, setBindings] = useState<RoomBinding[]>([])
  const [connectionId, setConnectionId] = useState(original.connectionId ?? ''), [name, setName] = useState(original.name + ' · AgentMux')
  const [group, setGroup] = useState(''), [members, setMembers] = useState(''), [memberType, setMemberType] = useState('')
  const [scope, setScope] = useState<'mentions-and-replies' | 'all-messages'>('mentions-and-replies'), [confirmed, setConfirmed] = useState(false)
  const [actorId, setActorId] = useState(''), [actorType, setActorType] = useState(''), [actorInput, setActorInput] = useState(false), [actorAnswer, setActorAnswer] = useState(false)
  const [facts, setFacts] = useState<Record<string, Fact>>({}), [issue, setIssue] = useState(''), [busy, setBusy] = useState(false)
  const [actors, setActors] = useState<{ bindingId: string; revision: number; grants: ConnectionGrant[] } | null>(null)
  const intents = useAppStore(state => state.connectorRoomIntents)
  const flight = useRef(false), epoch = useRef({}), content = useRef<HTMLDivElement>(null)
  const connection = connections.find(item => item.config.connectionId === connectionId)
  const relevant = Object.values(intents).filter(intent => { const input = intent.input; return sameConnectorTarget(intent.target, target) && ('connectionId' in input ? input.connectionId === connectionId : bindings.some(binding => binding.bindingId === input.bindingId && binding.connectionId === connectionId)) })
  const roomIntent = relevant.find(intent => intent.method === 'connection.room.create')
  const room = roomIntent ? facts[roomIntent.input.operationId] : null
  const created = room && 'creation' in room && room.creation.state === 'created' ? room.creation.externalConversationId : null
  const binding = bindings.find(item => item.connectionId === connectionId)
  const audience = mode === 'create' && !binding ? created ?? '' : group
  const approvedMembers = binding && actors?.bindingId === binding.bindingId && actors.revision === binding.revision
    ? new Set(actors.grants.filter(grant => grant.state === 'active').map(grant => JSON.stringify([grant.actor.application.domain, grant.actor.application.appId, grant.actor.idType, grant.actor.userId]))).size : null
  useEffect(() => { setGroup(binding?.externalConversationId ?? ''); setConfirmed(false); setChangingGroup(false) }, [connectionId, binding?.bindingId])
  const frozenRoom = roomIntent?.method === 'connection.room.create' ? roomIntent.input : null
  async function inspect(intent: ConnectorRoomIntent) {
    const value = intent.method === 'connection.room.create'
      ? (await api.connections.call('connection.room.inspect', { operationId: intent.input.operationId })).operation
      : (await api.connections.call('connection.binding.inspect', { operationId: intent.input.operationId })).operation
    setFacts(previous => ({ ...previous, [intent.input.operationId]: value }))
    if (value && 'state' in value && value.state === 'applied') { await clearConnectorRoomIntent(intent.input.operationId); invalidateConnectorTarget(target) }
    return value
  }
  async function refresh() {
    const token = epoch.current
    const [apps, audience] = await Promise.all([api.connections.call('connection.ls', {}), api.connections.call('connection.binding.ls', { executionHostId: target.executionHostId, agentSessionId: target.agentSessionId })])
    if (epoch.current !== token) return
    setConnections(apps.connections); setBindings(audience.bindings)
    const enabled = apps.connections.filter(item => item.config.enabled)
    setConnectionId(current => current || (enabled.length === 1 ? enabled[0]!.config.connectionId : ''))
    const selected = connectionId || (enabled.length === 1 ? enabled[0]!.config.connectionId : '')
    const originalBinding = audience.bindings.find(item => item.connectionId === selected)
    if (originalBinding) {
      const inspected = await api.connections.call('connection.binding.inspect', { bindingId: originalBinding.bindingId, revision: originalBinding.revision })
      if (epoch.current === token) setActors({ bindingId: originalBinding.bindingId, revision: originalBinding.revision, grants: inspected.grants })
    }
    for (const intent of Object.values(useAppStore.getState().connectorRoomIntents)) if (sameConnectorTarget(intent.target, target)) await inspect(intent)
  }
  useEffect(() => { const token = {}; epoch.current = token; void refresh().catch(error => { if (epoch.current === token) setIssue(presentError(error)) }); return () => { epoch.current = {} } }, [identity])
  async function work(action: () => Promise<void>) {
    if (flight.current) return
    flight.current = true; setBusy(true); setIssue('')
    try { await action() } catch (error) { setIssue('Setup is not confirmed. Check the status of this setup. ' + presentError(error)) }
    finally { flight.current = false; setBusy(false) }
  }
  async function execute(intent: ConnectorRoomIntent, explicitPending = false) {
    const retained = useAppStore.getState().connectorRoomIntents[intent.input.operationId]
    if (retained?.phase === 'may-have-dispatched' && !explicitPending) { await inspect(retained); return }
    const saved = await retainConnectorRoomIntent({ ...intent, phase: 'not-dispatched' })
    if (!saved.localStorageWritten) throw new Error('The original intent could not be saved. No request was sent; save this same intent before continuing.')
    const dispatch = await retainConnectorRoomIntent({ ...intent, phase: 'may-have-dispatched' })
    if (!dispatch.localStorageWritten) {
      // This producer has not called the transport; only this positively known no-dispatch can reset its phase.
      await retainConnectorRoomIntent({ ...intent, phase: 'not-dispatched' })
      throw new Error('Saving the original dispatch intent failed. No request was sent.')
    }
    const value = await api.connections.call(intent.method, intent.input)
    setFacts(previous => ({ ...previous, [intent.input.operationId]: value }))
    if ('state' in value && value.state === 'applied') { invalidateConnectorTarget(target); await clearConnectorRoomIntent(intent.input.operationId) }
    await refresh()
  }
  function createRoom() {
    if (!connection || roomIntent || binding || !name.trim() || members && !memberType.trim()) return
    void work(() => execute({ method: 'connection.room.create', target: { ...target, regionAnchor: { ...target.regionAnchor } }, phase: 'not-dispatched', input: {
      ...target, operationId: crypto.randomUUID(), connectionId, expectedConnectionRevision: connection.revision, name,
      members: members.split('\n').filter(value => value !== '').map(userId => ({ idType: memberType, userId }))
    } }))
  }
  function bind() {
    const native = session.nativeHandle
    if (!connection || !confirmed || native?.kind !== 'provider' || !audience.trim()) return
    const previous = relevant.find(intent => intent.method === 'connection.bind' || intent.method === 'connection.binding.relink')
    if (previous) { void work(async () => { await inspect(previous) }); return }
    const input = { ...target, operationId: crypto.randomUUID(), bindingId: binding?.bindingId ?? crypto.randomUUID(), connectionId,
      expectedConnectionRevision: connection.revision, externalConversationId: audience,
      scope: { input: scope, publication: 'future-native-user-facing' as const }, expectedSource: { providerId: native.providerId, nativeSessionId: native.sessionId } }
    void work(() => execute(binding ? { method: 'connection.binding.relink', input: { ...input, expectedRevision: binding.revision }, target, phase: 'not-dispatched' } : { method: 'connection.bind', input, target, phase: 'not-dispatched' }))
  }
  function pause() { const previous = relevant.find(intent => intent.method === 'connection.binding.pause'); if (previous) { void work(async () => { await inspect(previous) }); return } if (binding) void work(() => execute({ method: 'connection.binding.pause', target, phase: 'not-dispatched', input: { operationId: crypto.randomUUID(), bindingId: binding.bindingId, expectedRevision: binding.revision } })) }
  function grant() { const previous = relevant.find(intent => intent.method === 'connection.grant'); if (previous) { void work(async () => { await inspect(previous) }); return } if (binding && actorId && actorType && (actorInput || actorAnswer)) void work(() => execute({ method: 'connection.grant', target, phase: 'not-dispatched', input: {
    operationId: crypto.randomUUID(), bindingId: binding.bindingId, expectedBindingRevision: binding.revision, grantId: crypto.randomUUID(), expectedRevision: null,
    actor: { application: binding.application, idType: actorType, userId: actorId }, capabilities: [...(actorInput ? ['input' as const] : []), ...(actorAnswer ? ['answer' as const] : [])], state: 'active'
  } })) }
  function newContext() {
    if (!mote) return
    const id = useAppStore.getState().openLauncher({ workspaceId: mote.workspace.id, topicId: mote.topic.id, reveal: false })
    const group = id ? useAppStore.getState().layouts[mote.workspace.id]?.groups.find(item => item.tabOrder.includes(id)) : undefined
    if (id && group) { mote.selectTab(id, group.id); onClose() }
    else setIssue('The original Mote discussion entry is unavailable. Your Agent and draft are kept.')
  }
  const bindingPending = relevant.some(intent => intent.method === 'connection.bind' || intent.method === 'connection.binding.relink')
  const sharing = <section className="agent-connector-fields"><h3>{binding ? 'Change connected group' : 'Share with this group'}</h3>
    {mode !== 'create' || binding ? <label className="agent-connector-field">Group ID<TextInput aria-label="Existing group ID" value={audience} disabled={busy} onChange={event => setGroup(event.target.value)} /></label> : null}
    <div className="agent-connector-field"><label htmlFor={fieldId + '-scope'}>Accept requests</label><SelectionField id={fieldId + '-scope'} label="Group input scope" value={scope} disabled={busy} onValueChange={value => { if (value === 'mentions-and-replies' || value === 'all-messages') setScope(value) }} options={[{ value: 'mentions-and-replies', label: 'Mentions and replies only' }, { value: 'all-messages', label: 'Every group message' }]} /></div>
    <p className="agent-connector-note">This Agent may use its existing private context in replies. A separate discussion keeps contexts apart.</p>
    {mote ? <button className="agent-connector-text-action" onClick={newContext}>Start a separate discussion</button> : <p className="agent-connector-note">For separate context, start a new Agent in Mote before connecting it.</p>}
    <label className="agent-connector-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />Share new replies and questions with this group.</label>
    {session.nativeHandle?.kind !== 'provider' ? <p role="status" className="agent-connector-note">The Agent’s conversation source is not confirmed yet. You can keep working locally.</p> : null}
  </section>
  const application = <div className="agent-connector-application">
    <div className="agent-connector-field"><label htmlFor={fieldId + '-application'}>Application</label><SelectionField id={fieldId + '-application'} label="Group application" value={connectionId} disabled={busy}
      onValueChange={value => { setConnectionId(value); setConfirmed(false) }} options={[{ value: '', label: 'Choose an application…' }, ...connections.map(item => ({ value: item.config.connectionId, label: item.config.label, disabled: !item.config.enabled, description: item.config.application.domain + ' · ' + item.config.application.appId }))]} /></div>
    {settings ? <button className="agent-connector-text-action" onClick={() => { settings.open('chat-connections'); onClose() }}>Application settings</button> : null}
  </div>
  const canCreate = mode === 'create' && !binding && !roomIntent
  const canConnect = !bindingPending && (binding ? changingGroup : mode !== 'create' || !!created)

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal container={resolveOverlayContainer()}><Dialog.Overlay className="dialog-scrim" />
      <Dialog.Content ref={content} className="dialog-surface agent-connector-dialog" aria-busy={busy}
        onOpenAutoFocus={event => { event.preventDefault(); (content.current?.querySelector<HTMLElement>('[aria-label="Group name"]') ?? content.current?.querySelector<HTMLElement>('[aria-label="Existing group ID"]') ?? content.current?.querySelector<HTMLElement>('[aria-label="Close group setup"]'))?.focus({ preventScroll: true }) }}
        onCloseAutoFocus={event => { event.preventDefault(); const node = returnFocus(), active = document.activeElement; if (node?.isConnected && (active === document.body || !active?.isConnected || content.current?.contains(active))) node.focus({ preventScroll: true }) }}
        onEscapeKeyDown={event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault() }}>
        <header className="agent-connector-dialog__header"><div><Dialog.Title>{binding ? 'Shared group details' : mode === 'create' ? 'Create group chat' : 'Bind existing group chat'}</Dialog.Title>
          <Dialog.Description className="agent-connector-identity"><AgentIcon size={13} aria-hidden="true" /><span>{original.name}</span></Dialog.Description></div>
          <button type="button" className="icon-button" aria-label="Close group setup" onClick={onClose}><CloseIcon size={15} /></button></header>
        <div className="agent-connector-dialog__body">
          {binding ? <><section className="agent-connector-fields"><h3>Connected group</h3><p className="agent-connector-group">{binding.externalConversationId}</p><p className="agent-connector-note">{binding.state === 'active' ? 'Sharing on' : 'Sharing paused'}</p><p className="agent-connector-note" aria-label="Group member access">{approvedMembers === null ? 'Member access not confirmed' : approvedMembers === 0 ? 'No members approved' : approvedMembers + (approvedMembers === 1 ? ' member approved' : ' members approved')}</p><button className="small-button" disabled={busy || binding.state === 'paused'} onClick={pause}>Pause sharing</button></section><ConnectorDeliveryDetails key={binding.bindingId + binding.revision} binding={binding} /></> : application}
          {mode === 'create' && !binding ? <fieldset disabled={busy || !!roomIntent} className="agent-connector-fields" aria-label="New dedicated group">
            <label className="agent-connector-field">Group name<TextInput aria-label="Group name" value={frozenRoom?.name ?? name} onChange={event => setName(event.target.value)} /></label>
            <details className="agent-connector-disclosure"><summary>Invite people (optional)</summary><div className="agent-connector-fields">
              <label className="agent-connector-field">Member ID type<TextInput aria-label="Member ID type" value={frozenRoom?.members[0]?.idType ?? memberType} onChange={event => setMemberType(event.target.value)} placeholder="Exact ID type" /></label>
              <label className="agent-connector-field">Member IDs<Textarea aria-label="Invite member IDs" rows={3} value={frozenRoom ? frozenRoom.members.map(member => member.userId).join('\n') : members} onChange={event => setMembers(event.target.value)} placeholder="One exact ID per line" /></label>
              <p className="agent-connector-note">Invitations and access to this Agent are separate. You can manage member access after connecting the group.</p>
            </div></details>
          </fieldset> : null}
          {relevant.map(intent => { const fact = facts[intent.input.operationId], isRoom = fact && 'creation' in fact
            const receipt = <>
              {isRoom ? <><strong>{fact.creation.state === 'created' ? 'Group created' : fact.creation.state === 'not-applied' ? 'Group not created' : fact.creation.state === 'pending' ? 'Group setup pending' : 'Creation not confirmed'}</strong><span>{fact.membership.state === 'not-requested' ? 'No invitations requested.' : fact.membership.state === 'settled' ? fact.membership.results.filter(item => item.state === 'joined').length + ' of ' + fact.membership.results.length + ' invitations confirmed.' : fact.membership.state === 'not-applied' ? 'Invitations were not sent.' : fact.membership.state === 'pending' ? 'Invitations not started.' : 'Invitations not confirmed.'}</span></> : <strong>{fact && 'state' in fact && fact.state === 'refused' ? 'Setup could not finish' : 'Setup not confirmed'}</strong>}
              <button className="small-button" disabled={busy} onClick={() => void work(async () => { await inspect(intent); await refresh() })}>Check status</button>
              {isRoom && (fact.creation.state === 'pending' || fact.creation.state === 'created' && fact.membership.state === 'pending') || fact && 'state' in fact && fact.state === 'preparing' || intent.phase === 'not-dispatched' ? <button className="small-button" disabled={busy} onClick={() => void work(() => execute(intent, true))}>Continue setup</button> : null}
              {isRoom && fact.creation.state === 'not-applied' || fact && 'state' in fact && fact.state === 'refused' ? <button className="small-button" disabled={busy} onClick={() => void work(async () => { await clearConnectorRoomIntent(intent.input.operationId); await refresh() })}>Dismiss unsuccessful setup</button> : null}
              <details className="agent-connector-disclosure"><summary>Setup receipt details</summary><div className="agent-connector-fields">
                <span>Operation</span><code>{intent.input.operationId}</code><span>Host · {target.executionHostId}</span>
                {isRoom ? <><span>Creation: {fact.creation.state}{fact.creation.state === 'created' ? ' · ' + fact.creation.externalConversationId : fact.creation.state === 'not-applied' ? ' · ' + fact.creation.reason : ''}</span><span>Members: {fact.membership.state}</span>{fact.membership.state === 'settled' ? fact.membership.results.map((item, index) => <span key={index}>{item.member.idType} · {item.member.userId}: {item.state}</span>) : null}</> : <span>{fact && 'state' in fact ? fact.state + (fact.state === 'refused' ? ' · ' + fact.code : '') : 'Result unknown.'}</span>}
              </div></details>
            </>
            return binding && isRoom && fact.creation.state === 'created' ? <details className="agent-connector-disclosure" key={intent.input.operationId}><summary>Group setup receipt</summary><div className="agent-connector-receipt">{receipt}</div></details> : <section className="agent-connector-receipt" key={intent.input.operationId} aria-label="Group setup status">{receipt}</section>
          })}
          {!binding && !bindingPending && (mode !== 'create' || created) ? sharing : null}
          {binding ? <>
            <details className="agent-connector-disclosure" open={changingGroup} onToggle={event => setChangingGroup(event.currentTarget.open)}><summary>Change connected group</summary><div className="agent-connector-fields">{bindingPending ? <p className="agent-connector-note">Check the pending connection setup before changing groups.</p> : sharing}</div></details>
            <details className="agent-connector-disclosure"><summary>Manage member access</summary><div className="agent-connector-fields">
              <p className="agent-connector-note">Allow an exact person to send requests or answer questions in this group. Invitations alone do not grant access.</p>
              {actors?.bindingId === binding.bindingId && actors.revision === binding.revision ? actors.grants.length ? actors.grants.map(grant => <p className="agent-connector-note" key={grant.grantId}>{grant.actor.idType} · {grant.actor.userId}: {grant.state} · {grant.capabilities.join(', ')}</p>) : <p className="agent-connector-note">No member access has been approved for this connection.</p> : <p className="agent-connector-note">Member access is not confirmed.</p>}
              <label className="agent-connector-field">Member ID type<TextInput aria-label="Member access ID type" value={actorType} onChange={event => setActorType(event.target.value)} /></label>
              <label className="agent-connector-field">Member ID<TextInput aria-label="Member access ID" value={actorId} onChange={event => setActorId(event.target.value)} /></label>
              <label className="agent-connector-check"><input type="checkbox" checked={actorInput} onChange={event => setActorInput(event.target.checked)} />Send requests</label><label className="agent-connector-check"><input type="checkbox" checked={actorAnswer} onChange={event => setActorAnswer(event.target.checked)} />Answer questions</label>
              <button className="small-button" disabled={busy || !actorType || !actorId || !actorInput && !actorAnswer} onClick={grant}>Approve this member</button>
            </div></details>
          </> : null}
          <details className="agent-connector-disclosure"><summary>Connection details</summary><div className="agent-connector-fields">
            {binding ? application : null}
            {connection ? <span>{connection.config.application.domain} · {connection.config.application.appId} · Revision {connection.revision}</span> : null}
            <span>Host · {target.executionHostId}</span>{binding ? <span>Binding · {binding.bindingId} · Revision {binding.revision}</span> : null}
          </div></details>
          {issue ? <p role="status" className="surface-inline-error">{issue}</p> : null}
        </div><footer className="agent-connector-dialog__footer">
          {issue || relevant.length ? <button className="agent-connector-text-action" disabled={busy} onClick={() => void work(refresh)}>Refresh</button> : null}
          <button className="small-button" onClick={onClose}>{!binding && !relevant.length ? 'Cancel' : 'Close'}</button>
          {canCreate ? <button className="primary-button" disabled={busy || !connection || !name.trim() || !!members && !memberType.trim()} onClick={createRoom}>{busy ? 'Creating…' : 'Create group'}</button> : canConnect ? <button className="primary-button" disabled={busy || !connection?.config.enabled || !confirmed || !audience.trim() || session.nativeHandle?.kind !== 'provider'} onClick={bind}>{binding ? 'Change group' : 'Connect group'}</button> : null}
        </footer>
      </Dialog.Content></Dialog.Portal>
  </Dialog.Root>
}

/** Bounded safe receipt observation opens only on demand; it never retries delivery. */
function ConnectorDeliveryDetails({ binding }: { binding: RoomBinding }) {
  const [read, setRead] = useState<ConnectionDeliveryResultMap['connection.delivery.ls'] | null>(null), [issue, setIssue] = useState('')
  const [detail, setDetail] = useState<ConnectionDeliveryResultMap['connection.delivery.inspect'] | null>(null), [pending, setPending] = useState(false)
  const flight = useRef(false), identity = JSON.stringify([binding.bindingId, binding.revision]), current = useRef(identity)
  current.current = identity
  async function inspect(after?: string) {
    if (flight.current) return
    const original = identity; flight.current = true; setPending(true)
    try {
      const result = await api.connections.call('connection.delivery.ls', { connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision, limit: 5, ...(after ? { after } : {}) })
      if (current.current === original) { setRead(result); setIssue('') }
    } catch (error) { if (current.current === original) setIssue(presentError(error)) }
    finally { flight.current = false; setPending(false) }
  }
  async function inspectOriginal(operationId: string) {
    if (flight.current) return
    const original = identity; flight.current = true; setPending(true)
    try { const result = await api.connections.call('connection.delivery.inspect', { operationId }); if (current.current === original) { setDetail(result); setIssue('') } }
    catch (error) { if (current.current === original) setIssue(presentError(error)) }
    finally { flight.current = false; setPending(false) }
  }
  useEffect(() => { setRead(null); setDetail(null); setIssue('') }, [identity])
  const latest = read?.deliveries[0], receipt = latest?.receipt
  return <section className="agent-connector-fields" aria-busy={pending}><h3>Delivery</h3>
    <p className="agent-connector-note">{receipt?.state === 'confirmed' ? 'Latest delivery confirmed' : receipt?.state === 'not-applied' ? 'Latest delivery was not sent' : receipt?.state === 'unknown' || issue ? 'Delivery not confirmed' : read ? 'No delivery receipt recorded for this connection' : 'Status not checked'}</p>
    <button className="small-button" disabled={pending} onClick={() => void inspect()}>Check delivery</button>
    <details className="agent-connector-disclosure" onToggle={event => { if (event.currentTarget.open) void inspect() }}><summary>Delivery receipt details</summary><div className="agent-connector-fields">
      {read?.observation ? <p className="agent-connector-note">Worker: {read.observation.state}{read.observation.reason ? ' · ' + read.observation.reason : ''}</p> : null}
      {read?.deliveries.map(delivery => <div className="agent-connector-receipt" key={delivery.operationId}><span>Queue: {delivery.state} · Platform receipt: {delivery.receipt?.state ?? 'Not recorded'}</span><code>{delivery.operationId}</code><button className="small-button" disabled={pending} onClick={() => void inspectOriginal(delivery.operationId)}>Check receipt</button></div>)}
      {read && !read.deliveries.length ? <p className="agent-connector-note">No delivery in this bounded scope. This does not prove platform availability.</p> : null}
      {read?.next ? <button className="small-button" disabled={pending} onClick={() => void inspect(read.next!)}>Earlier receipts</button> : null}
      {detail ? <p className="agent-connector-note" role="status">{detail.delivery ? 'Original queue: ' + detail.delivery.state + ' · Platform receipt: ' + (detail.delivery.receipt?.state ?? 'Not recorded') + ' · ' + detail.delivery.operationId : 'Original receipt unavailable; no retry was sent.'}</p> : null}
      {issue ? <p role="status" className="agent-connector-note">Delivery observation unconfirmed · {issue}</p> : null}
      <button className="small-button" disabled={pending} onClick={() => void inspect()}>Latest receipts</button>
    </div></details>
  </section>
}
