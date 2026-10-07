import * as Dialog from '@radix-ui/react-dialog'
import { useContext, useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
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

type Fact = RoomProvisioningOperation | RoomBindingOperation | null
export type AgentConnectorTarget = { target: RoomBindingTarget; session: AgentNativeSourceReference; name: string }
/** A bounded form over original public owners. It retains submitted correlations, never another receipt store. */
export function AgentConnectorDialog({ original, mode, onClose, returnFocus }: {
  original: AgentConnectorTarget; mode: 'create' | 'existing' | 'details'; onClose(): void; returnFocus(): HTMLElement | null
}) {
  const { target, session } = original, identity = JSON.stringify(target)
  const mote = useContext(MoteWorkfaceContext), settings = useContext(SettingsNavigation)
  const [connections, setConnections] = useState<ConnectionRecord[]>([]), [bindings, setBindings] = useState<RoomBinding[]>([])
  const [connectionId, setConnectionId] = useState(''), [name, setName] = useState(original.name + ' · AgentMux')
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
  const audience = mode === 'create' ? created ?? '' : group
  useEffect(() => { setGroup(binding?.externalConversationId ?? ''); setConfirmed(false) }, [connectionId, binding?.bindingId])
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
    try { await action() } catch (error) { setIssue('Original operation retained. ' + presentError(error)) }
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
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal container={resolveOverlayContainer()}><Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content ref={content} className="confirmation-dialog dialog-surface agent-connector-dialog" aria-busy={busy}
        onCloseAutoFocus={event => { event.preventDefault(); const node = returnFocus(), active = document.activeElement; if (node?.isConnected && (active === document.body || !active?.isConnected || content.current?.contains(active))) node.focus({ preventScroll: true }) }}
        onEscapeKeyDown={event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault() }}>
        <Dialog.Title className="confirmation-dialog__title">{mode === 'create' ? 'Create group chat' : mode === 'existing' ? 'Bind existing group chat' : 'Shared group details'}</Dialog.Title>
        <Dialog.Description className="confirmation-dialog__description">{original.name} · Host {target.executionHostId}. Local input and your draft stay here.</Dialog.Description>
        <div className="agent-connector-dialog__body">
          <label className="agent-connector-field">Application<select aria-label="Group application" value={connectionId} disabled={busy} onChange={event => { setConnectionId(event.target.value); setConfirmed(false) }}><option value="">Choose an enabled application…</option>{connections.map(item => <option key={item.config.connectionId} value={item.config.connectionId} disabled={!item.config.enabled}>{item.config.label}{item.config.enabled ? '' : ' · Disabled'}</option>)}</select></label>
          {connection ? <p className="agent-connector-note">{connection.config.application.domain} · {connection.config.application.appId}</p> : null}
          {settings ? <button className="small-button" onClick={() => { settings.open('chat-connections'); onClose() }}>Chat application settings</button> : null}
          {mode === 'create' && !binding ? <fieldset disabled={busy || !!roomIntent} className="agent-connector-fields"><legend>Dedicated group</legend>
            <label className="agent-connector-field">Group name<TextInput aria-label="Group name" value={frozenRoom?.name ?? name} onChange={event => setName(event.target.value)} /></label>
            <label className="agent-connector-field">Member ID type<TextInput aria-label="Member ID type" value={frozenRoom?.members[0]?.idType ?? memberType} onChange={event => setMemberType(event.target.value)} placeholder="Exact ID type" /></label>
            <label className="agent-connector-field">Invite members<textarea aria-label="Invite member IDs" rows={3} value={frozenRoom ? frozenRoom.members.map(member => member.userId).join('\n') : members} onChange={event => setMembers(event.target.value)} placeholder="One exact member ID per line; optional" /></label>
            <p className="agent-connector-note">Invitations do not grant Agent input or answer permissions. An empty list creates the application’s group only.</p>
            {!roomIntent ? <button className="primary-button" disabled={!connection || !name.trim() || !!members && !memberType.trim()} onClick={createRoom}>Create dedicated group</button> : null}
          </fieldset> : null}
          {binding ? <section className="agent-connector-fields"><h3>Current group</h3><p>{binding.externalConversationId} · {binding.state === 'active' ? 'Sharing authorized' : 'Sharing paused'}</p><p className="agent-connector-note">The same Session shares this Binding across its Regions. Delivery receipts remain separate.</p><button className="small-button" disabled={busy || binding.state === 'paused'} onClick={pause}>Pause sharing</button><p className="agent-connector-note">Pause stops future admission; existing unknown operations remain inspect-only.</p></section> : null}
          {relevant.map(intent => { const fact = facts[intent.input.operationId], isRoom = fact && 'creation' in fact
            return <section className="agent-connector-receipt" key={intent.input.operationId} aria-label="Original group operation">
              <strong>{intent.method === 'connection.room.create' ? 'Group creation' : 'Binding / actor operation'}</strong><code>{intent.input.operationId}</code>
              {isRoom ? <><span>Creation: {fact.creation.state}{fact.creation.state === 'created' ? ' · ' + fact.creation.externalConversationId : fact.creation.state === 'not-applied' ? ' · ' + fact.creation.reason : ''}</span><span>Members: {fact.membership.state}</span>{fact.membership.state === 'settled' ? fact.membership.results.map((item, index) => <span key={index}>{item.member.idType} · {item.member.userId}: {item.state}</span>) : null}</> : <span>{fact && 'state' in fact ? fact.state + (fact.state === 'refused' ? ' · ' + fact.code : '') : 'Result unknown; original operation retained.'}</span>}
              <button className="small-button" disabled={busy} onClick={() => void work(async () => { await inspect(intent); await refresh() })}>Inspect original operation</button>
              {isRoom && (fact.creation.state === 'pending' || fact.creation.state === 'created' && fact.membership.state === 'pending') || fact && 'state' in fact && fact.state === 'preparing' || intent.phase === 'not-dispatched' ? <button className="small-button" disabled={busy} onClick={() => void work(() => execute(intent, true))}>Continue original operation</button> : null}
              {isRoom && fact.creation.state === 'not-applied' || fact && 'state' in fact && fact.state === 'refused' ? <button className="small-button" disabled={busy} onClick={() => void work(async () => { await clearConnectorRoomIntent(intent.input.operationId); await refresh() })}>Dismiss refused intent</button> : null}
            </section>
          })}
          {mode !== 'create' || created ? <section className="agent-connector-fields"><h3>{binding ? 'Reconnect explicitly' : 'Confirm sharing'}</h3>
            <label className="agent-connector-field">Existing group ID<TextInput aria-label="Existing group ID" value={audience} disabled={busy || mode === 'create'} onChange={event => setGroup(event.target.value)} /></label>
            <label className="agent-connector-field">Group input<select aria-label="Group input scope" value={scope} disabled={busy} onChange={event => setScope(event.target.value as typeof scope)}><option value="mentions-and-replies">Mentions and replies only</option><option value="all-messages">All group messages</option></select></label>
            <p className="agent-connector-note">Existing private context can influence future replies. Excluding old history does not isolate the model’s context.</p>
            {mote ? <button className="small-button" onClick={newContext}>Start a separate Mote discussion instead</button> : <p className="agent-connector-note">For isolated context, start a new Agent from the original Mote discussion entry before connecting it.</p>}
            <label className="agent-connector-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />Share this existing Agent’s future outward replies and questions with this group.</label>
            {session.nativeHandle?.kind !== 'provider' ? <p role="status" className="agent-connector-note">The original native source is not confirmed. Sharing is unavailable; local input remains usable.</p> : null}
            <button className="primary-button" disabled={busy || !connection?.config.enabled || !confirmed || !audience.trim() || session.nativeHandle?.kind !== 'provider'} onClick={bind}>{binding ? 'Confirm reconnect' : 'Confirm binding'}</button>
          </section> : null}
          {binding ? <ConnectorDeliveryDetails key={binding.bindingId + binding.revision} binding={binding} /> : null}
          {binding ? <section className="agent-connector-fields"><h3>Actor permission</h3><p className="agent-connector-note">Membership grants nothing. Approve an exact actor separately for this Binding revision. Remote permission approval is not included.</p>
            {actors?.bindingId === binding.bindingId && actors.revision === binding.revision ? actors.grants.length ? actors.grants.map(grant => <p className="agent-connector-note" key={grant.grantId}>{grant.actor.idType} · {grant.actor.userId}: {grant.state} · {grant.capabilities.join(', ')}</p>) : <p className="agent-connector-note">No actor is approved for this Binding revision.</p> : <p className="agent-connector-note">Current actor permissions are not confirmed.</p>}
            <label className="agent-connector-field">Actor ID type<TextInput aria-label="Actor ID type" value={actorType} onChange={event => setActorType(event.target.value)} /></label>
            <label className="agent-connector-field">Actor ID<TextInput aria-label="Actor ID" value={actorId} onChange={event => setActorId(event.target.value)} /></label>
            <label className="agent-connector-check"><input type="checkbox" checked={actorInput} onChange={event => setActorInput(event.target.checked)} />Send input</label><label className="agent-connector-check"><input type="checkbox" checked={actorAnswer} onChange={event => setActorAnswer(event.target.checked)} />Answer questions</label>
            <button className="small-button" disabled={busy || !actorType || !actorId || !actorInput && !actorAnswer} onClick={grant}>Approve this actor</button>
          </section> : null}
          {issue ? <p role="status" className="surface-inline-error">{issue}</p> : null}
        </div><footer><button className="small-button" onClick={onClose}>Close</button><button className="small-button" disabled={busy} onClick={() => void work(refresh)}>Refresh original facts</button></footer>
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
  return <details className="agent-connector-fields" aria-busy={pending} onToggle={event => { if (event.currentTarget.open) void inspect() }}><summary>Recent delivery receipts</summary>
    {read?.observation ? <p className="agent-connector-note">Worker: {read.observation.state}{read.observation.reason ? ' · ' + read.observation.reason : ''}</p> : null}
    {read?.deliveries.map(delivery => <div className="agent-connector-receipt" key={delivery.operationId}><span>Queue: {delivery.state} · Platform receipt: {delivery.receipt?.state ?? 'Not recorded'}</span><code>{delivery.operationId}</code><button className="small-button" disabled={pending} onClick={() => void inspectOriginal(delivery.operationId)}>Inspect original delivery</button></div>)}
    {read && !read.deliveries.length ? <p className="agent-connector-note">No delivery in this bounded scope. This does not prove platform availability.</p> : null}
    {read?.next ? <button className="small-button" disabled={pending} onClick={() => void inspect(read.next!)}>Earlier receipts</button> : null}
    {detail ? <p className="agent-connector-note" role="status">{detail.delivery ? 'Original queue: ' + detail.delivery.state + ' · Platform receipt: ' + (detail.delivery.receipt?.state ?? 'Not recorded') + ' · ' + detail.delivery.operationId : 'Original receipt unavailable; no retry was sent.'}</p> : null}
    {issue ? <p role="status" className="agent-connector-note">Delivery observation unconfirmed · {issue}</p> : null}
    <button className="small-button" disabled={pending} onClick={() => void inspect()}>Latest delivery receipts</button>
  </details>
}
