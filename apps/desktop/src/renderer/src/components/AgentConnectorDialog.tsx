import { useWorkbenchDocument } from '../lib/workbench-document'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { useContext, useEffect, useId, useRef, useState, type ComponentProps } from 'react'
import { TextInput, Textarea } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { SelectionField } from './SelectionField'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import type { ConnectionGrant, ConnectionRecord, RoomBinding, RoomBindingOperation, RoomBindingScope, RoomBindingTarget, RoomLinkOperation, RoomProvisioningOperation } from '@agentmux/core/connections'
import type { AgentNativeSourceReference } from './AgentNativeSourceControls'
import { api } from '../lib/api'
import { clearConnectorRoomIntent, retainConnectorRoomIntent, useAppStore } from '../store'
import { invalidateConnectorTarget, sameConnectorTarget, type ConnectorRoomIntent } from '../lib/connector-room-intent'
import { MoteWorkfaceContext } from '../lib/mote-workface'
import { SettingsNavigation } from './SettingsNavigation'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { ResolvedAgentAvatar } from './AgentAvatar'
import { ConnectorRoomPeople, ConnectorRoomSelection, roomName, useConnectorRoomFacts } from './ConnectorRoomSelection'
import { ConnectorRoomJoinLink, ConnectorRoomJoinReceipt } from './ConnectorRoomJoinLink'
import { ConnectorDeliveryDetails } from './ConnectorDeliveryDetails'
import { parseMotePreferencesReadResult, type MoteConnectionRef } from '@agentmux/core/mote-preferences'
import { moteConnectionChoice, type AgentMoteConnectionSource } from '../lib/mote-connection-default'

const CloseIcon = semanticIconComponent('action.close')
const AgentIcon = semanticIconComponent('object.agent')
const GroupIcon = semanticIconComponent('object.conversation')
const ConnectIcon = semanticIconComponent('navigation.forward')

type Fact = RoomProvisioningOperation | RoomBindingOperation | RoomLinkOperation | null
export type AgentConnectorTarget = { target: RoomBindingTarget; session: AgentNativeSourceReference; name: string; connectionId?: string; mote?: AgentMoteConnectionSource
  identity?: Pick<ComponentProps<typeof ResolvedAgentAvatar>, 'providerId' | 'appearance' | 'executorId'> }
/** A bounded form over original public owners. It retains submitted correlations, never another receipt store. */
export function AgentConnectorDialog({ original, mode, onClose, returnFocus }: {
  original: AgentConnectorTarget; mode: 'create' | 'existing' | 'details'; onClose(): void; returnFocus(): HTMLElement | null
}) {
  const ownerDocument = useWorkbenchDocument()
  const { target, session } = original, identity = JSON.stringify(target), fieldId = useId()
  const [changingGroup, setChangingGroup] = useState(false), [accessOpen, setAccessOpen] = useState(false)
  const mote = useContext(MoteWorkfaceContext), settings = useContext(SettingsNavigation)
  const [connections, setConnections] = useState<ConnectionRecord[]>([]), [bindings, setBindings] = useState<RoomBinding[]>([])
  const [loaded, setLoaded] = useState(false)
  const [moteDefault, setMoteDefault] = useState<{ status: 'loading' | 'ready' | 'unconfirmed'; ref: MoteConnectionRef | null; issue: string | null }>(() =>
    original.mote && 'target' in original.mote ? { status: 'loading', ref: null, issue: null }
      : { status: original.mote ? 'unconfirmed' : 'ready', ref: null, issue: original.mote && 'issue' in original.mote ? original.mote.issue : null })
  const initialized = useRef(!!original.connectionId), explicitlySelected = useRef(false)
  const [connectionId, setConnectionId] = useState(original.connectionId ?? ''), [name, setName] = useState(original.name + ' · AgentMux')
  const [group, setGroup] = useState(''), [members, setMembers] = useState(''), [memberType, setMemberType] = useState('')
  const [scope, setScope] = useState<'mentions-and-replies' | 'all-messages'>('mentions-and-replies'), [confirmed, setConfirmed] = useState(false)
  const [publication, setPublication] = useState<RoomBindingScope['publication']>('future-native-user-facing')
  const [actorId, setActorId] = useState(''), [actorType, setActorType] = useState(''), [actorInput, setActorInput] = useState(false), [actorAnswer, setActorAnswer] = useState(false), [actorPermission, setActorPermission] = useState(false)
  const [facts, setFacts] = useState<Record<string, Fact>>({}), [issue, setIssue] = useState(''), [busy, setBusy] = useState(false)
  const [actors, setActors] = useState<{ bindingId: string; revision: number; grants: ConnectionGrant[] } | null>(null)
  const [memberFlights, setMemberFlights] = useState<Set<string>>(() => new Set())
  const memberFlight = useRef(new Set<string>()), selectedMember = useRef('')
  const intents = useAppStore(state => state.connectorRoomIntents)
  const flight = useRef(false), epoch = useRef({}), content = useRef<HTMLDivElement>(null), initialFocus = useRef(true)
  const connection = connections.find(item => item.config.connectionId === connectionId)
  const relevant = Object.values(intents).filter(intent => { const input = intent.input; return sameConnectorTarget(intent.target, target) && ('connectionId' in input ? input.connectionId === connectionId : bindings.some(binding => binding.bindingId === input.bindingId && binding.connectionId === connectionId)) })
  const roomIntent = relevant.find(intent => intent.method === 'connection.room.create')
  const room = roomIntent ? facts[roomIntent.input.operationId] : null
  const created = room && 'creation' in room && room.creation.state === 'created' ? room.creation.externalConversationId : null
  const binding = bindings.find(item => item.connectionId === connectionId)
  const memberKey = (idType: string, userId: string) => JSON.stringify([binding?.bindingId, binding?.revision, idType, userId])
  selectedMember.current = memberKey(actorType, actorId)
  const activeAudience = useRef(''); activeAudience.current = JSON.stringify([binding?.bindingId, binding?.revision])
  const currentGrants = actors && binding && actors.bindingId === binding.bindingId && actors.revision === binding.revision
    ? actors.grants.filter(grant => grant.actor.application.domain === binding.application.domain && grant.actor.application.appId === binding.application.appId) : []
  const actorGrant = currentGrants.find(grant => grant.actor.idType === actorType && grant.actor.userId === actorId)
  const creatingGroup = mode === 'create' && !binding
  const bindingIntent = relevant.find(intent => intent.method === 'connection.bind' || intent.method === 'connection.binding.relink')
  const bindingPending = !!bindingIntent
  const showingCurrentBinding = !!binding && !changingGroup && !bindingPending
  const links = relevant.filter((intent): intent is Extract<ConnectorRoomIntent, { method: 'connection.room.link.create' }> => intent.method === 'connection.room.link.create')
  // Explicit submitted replacement references choose the head; presentation order is not authority.
  const replacedLinks = new Set(links.filter(next => links.some(previous => previous.input.operationId === next.replacesOperationId && previous.input.externalConversationId === next.input.externalConversationId)).map(next => next.replacesOperationId))
  const linkHeads = links.filter(intent => !replacedLinks.has(intent.input.operationId))
  const originalLink = linkHeads.length === 1 ? linkHeads[0] : undefined
  const restoredGroup = !group && originalLink?.method === 'connection.room.link.create' ? originalLink.input.externalConversationId : group
  const audience = bindingIntent && 'externalConversationId' in bindingIntent.input ? bindingIntent.input.externalConversationId : mode === 'create' && !binding ? created ?? '' : binding && !changingGroup ? binding.externalConversationId : restoredGroup
  const audienceLinks = links.filter(intent => intent.input.externalConversationId === audience)
  const audienceHeads = linkHeads.filter(intent => intent.input.externalConversationId === audience)
  const linkIntent = audienceHeads.length === 1 ? audienceHeads[0] : undefined
  const linkFact = linkIntent ? facts[linkIntent.input.operationId] : null
  const linkOperation = linkFact && 'input' in linkFact && 'externalConversationId' in linkFact.input ? linkFact as RoomLinkOperation : null
  const roomFacts = useConnectorRoomFacts(connection, audience)
  const knownRoom = roomFacts.room?.room
  useEffect(() => {
    if (!initialFocus.current || !connection || mode !== 'existing') return
    initialFocus.current = false
    const close = content.current?.querySelector('[aria-label="Close group setup"]')
    if (ownerDocument.activeElement === close) content.current?.querySelector<HTMLElement>('[aria-label="Existing group"]')?.focus({ preventScroll: true })
  }, [connection, mode])
  const approvedMembers = binding && actors?.bindingId === binding.bindingId && actors.revision === binding.revision
    ? new Set(actors.grants.filter(grant => grant.state === 'active').map(grant => JSON.stringify([grant.actor.application.domain, grant.actor.application.appId, grant.actor.idType, grant.actor.userId]))).size : null
  const currentMemberIntents = relevant.filter((intent): intent is Extract<ConnectorRoomIntent, { method: 'connection.grant' }> => intent.method === 'connection.grant' && currentGrantIntent(intent))
  const unconfirmedMembers = currentMemberIntents.some(intent => memberReceiptState(intent) === 'unconfirmed')
  const selectedMemberIntent = currentMemberIntents.find(intent => intent.input.actor.idType === actorType && intent.input.actor.userId === actorId)
  function memberReceiptState(intent: Extract<ConnectorRoomIntent, { method: 'connection.grant' }>) {
    const fact = facts[intent.input.operationId]
    if (fact && 'state' in fact && (fact.state === 'applied' || fact.state === 'refused')) return fact.state
    return !fact && intent.phase === 'not-dispatched' ? 'not-dispatched' : 'unconfirmed'
  }
  useEffect(() => { setGroup(binding?.externalConversationId ?? ''); setScope(binding?.scope.input ?? 'mentions-and-replies'); setPublication(binding?.scope.publication ?? 'future-native-user-facing'); setConfirmed(false); setChangingGroup(false); setActorId(''); setActorType(''); setActorInput(false); setActorAnswer(false); setActorPermission(false); setAccessOpen(false) }, [connectionId, binding?.bindingId, binding?.revision])
  const frozenRoom = roomIntent?.method === 'connection.room.create' ? roomIntent.input : null
  function observeBinding(bindingId: string, current: RoomBinding | null) {
    setBindings(previous => {
      const known = previous.find(item => item.bindingId === bindingId)
      if (current && known && known.revision > current.revision) return previous
      const others = previous.filter(item => item.bindingId !== bindingId)
      return current && sameConnectorTarget(current, target) ? [...others, current] : others
    })
  }
  function acceptGrant(grant: ConnectionGrant, source: RoomBinding) {
    if (activeAudience.current !== JSON.stringify([source.bindingId, source.revision])) return
    setActors(previous => {
      const grants = previous?.bindingId === source.bindingId && previous.revision === source.revision ? previous.grants : [], old = grants.find(value => value.grantId === grant.grantId)
      return old && old.revision > grant.revision ? previous : { bindingId: source.bindingId, revision: source.revision, grants: [...grants.filter(value => value.grantId !== grant.grantId), grant] }
    })
  }
  function selectActor(idType: string, userId: string) {
    const grant = currentGrants.find(value => value.actor.idType === idType && value.actor.userId === userId && value.state === 'active')
    setActorType(idType); setActorId(userId); setActorInput(grant?.capabilities.includes('input') ?? false); setActorAnswer(grant?.capabilities.includes('answer') ?? false); setActorPermission(grant?.capabilities.includes('permission') ?? false); setAccessOpen(true)
  }
  async function memberWork(key: string, action: () => Promise<void>) {
    if (memberFlight.current.has(key)) return
    const token = epoch.current
    memberFlight.current.add(key); setMemberFlights(new Set(memberFlight.current)); setIssue('')
    try { await action() } catch (error) { if (epoch.current === token && selectedMember.current === key) setIssue('Member access is not confirmed. Check its original status. ' + presentError(error)) }
    finally { memberFlight.current.delete(key); setMemberFlights(new Set(memberFlight.current)) }
  }
  async function inspect(intent: ConnectorRoomIntent) {
    let value: Fact
    if (intent.method === 'connection.room.create') value = (await api.connections.call('connection.room.inspect', { operationId: intent.input.operationId })).operation
    else if (intent.method === 'connection.room.link.create') value = (await api.connections.call('connection.room.link.inspect', { operationId: intent.input.operationId })).operation
    else {
      const read = await api.connections.call('connection.binding.inspect', { operationId: intent.input.operationId })
      value = read.operation
      if (value?.state === 'applied') { observeBinding(value.binding.bindingId, read.current); for (const grant of read.grants) acceptGrant(grant, value.binding) }
    }
    setFacts(previous => ({ ...previous, [intent.input.operationId]: value }))
    if (value && 'state' in value && value.state === 'applied') { await clearConnectorRoomIntent(intent.input.operationId); invalidateConnectorTarget(target) }
    return value
  }
  async function refresh() {
    const token = epoch.current
    const [apps, audience] = await Promise.allSettled([api.connections.call('connection.ls', {}), api.connections.call('connection.binding.ls', { executionHostId: target.executionHostId, agentSessionId: target.agentSessionId })])
    if (epoch.current !== token) return
    if (apps.status === 'fulfilled') setConnections(apps.value.connections)
    if (audience.status === 'fulfilled') setBindings(audience.value.bindings)
    // A failed binding read must not hide otherwise readable saved bots. Automatic
    // initialization still waits for the original bindings; manual choice stays available.
    setLoaded(apps.status === 'fulfilled' && audience.status === 'fulfilled')
    if (apps.status === 'rejected' || audience.status === 'rejected') throw new Error([apps, audience].flatMap(result => result.status === 'rejected' ? [presentError(result.reason)] : []).join(' '))
    for (const intent of Object.values(useAppStore.getState().connectorRoomIntents)) if (sameConnectorTarget(intent.target, target)) await inspect(intent)
  }
  useEffect(() => { const token = {}; epoch.current = token; void refresh().catch(error => { if (epoch.current === token) setIssue(presentError(error)) }); return () => { epoch.current = {} } }, [identity])
  useEffect(() => {
    const source = original.mote
    if (!source || !('target' in source) || original.connectionId || mode === 'details') return
    const token = epoch.current, input = { kind: 'connection' as const, target: source.target }
    void api.motePreferences.read(input).then(value => {
      if (epoch.current !== token) return
      const saved = parseMotePreferencesReadResult(value, input)
      setMoteDefault({ status: saved.status, ref: saved.values?.connection ?? null, issue: saved.issue })
    }).catch(error => { if (epoch.current === token) setMoteDefault({ status: 'unconfirmed', ref: null, issue: presentError(error) }) })
  }, [identity])
  useEffect(() => {
    if (initialized.current || !loaded) return
    const retained = Object.values(intents).filter(intent => sameConnectorTarget(intent.target, target))
    const originalIds = new Set([...bindings.map(item => item.connectionId), ...retained.flatMap(intent => 'connectionId' in intent.input ? [intent.input.connectionId] : [])])
    if (originalIds.size > 1) return
    let selected = originalIds.size === 1 ? [...originalIds][0] : undefined
    if (!selected) {
      if (moteDefault.status !== 'ready') return
      if (moteDefault.ref) {
        const choice = moteConnectionChoice(moteDefault.ref, connections)
        if (choice.issue) return
        selected = choice.record!.config.connectionId
      } else {
        const enabled = connections.filter(item => item.config.enabled)
        selected = enabled.length === 1 ? enabled[0]!.config.connectionId : undefined
      }
    }
    initialized.current = true
    if (selected) setConnectionId(selected)
  }, [loaded, connections, bindings, moteDefault, intents])
  useEffect(() => {
    if (!binding) return
    const token = epoch.current
    let active = true
    void api.connections.call('connection.binding.inspect', { bindingId: binding.bindingId, revision: binding.revision }).then(inspected => {
      if (active && epoch.current === token) setActors(previous => {
        const grants = inspected.grants.slice()
        if (previous?.bindingId === binding.bindingId && previous.revision === binding.revision) for (const grant of previous.grants) {
          const index = grants.findIndex(value => value.grantId === grant.grantId)
          if (index < 0) grants.push(grant)
          else if (grants[index]!.revision < grant.revision) grants[index] = grant
        }
        return { bindingId: binding.bindingId, revision: binding.revision, grants }
      })
    }).catch(error => { if (active && epoch.current === token) setIssue(presentError(error)) })
    return () => { active = false }
  }, [binding?.bindingId, binding?.revision])
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
    if ('state' in value && value.state === 'applied') { if (value.grant) acceptGrant(value.grant, value.binding); observeBinding(value.binding.bindingId, value.binding); invalidateConnectorTarget(target); await clearConnectorRoomIntent(intent.input.operationId) }
    // An exact grant receipt already updates its member. Other original queries cannot hold that write open.
    if (intent.method !== 'connection.grant') await refresh()
  }
  function createRoom() {
    if (!connection || roomIntent || binding || !name.trim() || members && !memberType.trim()) return
    void work(() => execute({ method: 'connection.room.create', target: { ...target, regionAnchor: { ...target.regionAnchor } }, phase: 'not-dispatched', input: {
      ...target, operationId: crypto.randomUUID(), connectionId, expectedConnectionRevision: connection.revision, name,
      members: members.split('\n').filter(value => value !== '').map(userId => ({ idType: memberType, userId }))
    } }))
  }
  function createJoinLink(replacesOperationId?: string) {
    if (!connection || !audience) return
    if (replacesOperationId ? linkIntent?.input.operationId !== replacesOperationId || !linkOperation || linkOperation.state !== 'confirmed' && linkOperation.state !== 'refused' : audienceLinks.length > 0) return
    void work(() => execute({ method: 'connection.room.link.create', target, phase: 'not-dispatched', ...(replacesOperationId ? { replacesOperationId } : {}), input: { operationId: crypto.randomUUID(), connectionId,
      expectedConnectionRevision: connection.revision, externalConversationId: audience } }))
  }
  function bind() {
    const native = session.nativeHandle
    if (!connection || !confirmed || native?.kind !== 'provider' || !audience.trim()) return
    const previous = relevant.find(intent => intent.method === 'connection.bind' || intent.method === 'connection.binding.relink')
    if (previous) { void work(async () => { await inspect(previous) }); return }
    const input = { ...target, operationId: crypto.randomUUID(), bindingId: binding?.bindingId ?? crypto.randomUUID(), connectionId,
      expectedConnectionRevision: connection.revision, externalConversationId: audience,
      scope: { input: scope, publication }, expectedSource: { providerId: native.providerId, nativeSessionId: native.sessionId } }
    void work(() => execute(binding ? { method: 'connection.binding.relink', input: { ...input, expectedRevision: binding.revision }, target, phase: 'not-dispatched' } : { method: 'connection.bind', input, target, phase: 'not-dispatched' }))
  }
  function pause() { const previous = relevant.find(intent => intent.method === 'connection.binding.pause'); if (previous) { void work(async () => { await inspect(previous) }); return } if (binding) void work(() => execute({ method: 'connection.binding.pause', target, phase: 'not-dispatched', input: { operationId: crypto.randomUUID(), bindingId: binding.bindingId, expectedRevision: binding.revision } })) }
  function currentGrantIntent(intent: ConnectorRoomIntent): boolean {
    return intent.method === 'connection.grant' && !!binding && intent.input.bindingId === binding.bindingId &&
      intent.input.expectedBindingRevision === binding.revision && intent.input.actor.application.domain === binding.application.domain && intent.input.actor.application.appId === binding.application.appId
  }
  function grant() {
    if (!binding || !actorId || !actorType) return
    const previous = selectedMemberIntent
    const key = memberKey(actorType, actorId)
    if (previous) { void memberWork(key, async () => { await inspect(previous) }); return }
    if (!actorInput && !actorAnswer && !actorPermission) return
    void memberWork(key, () => execute({ method: 'connection.grant', target, phase: 'not-dispatched', input: {
      operationId: crypto.randomUUID(), bindingId: binding.bindingId, expectedBindingRevision: binding.revision,
      grantId: actorGrant?.grantId ?? crypto.randomUUID(), expectedRevision: actorGrant?.revision ?? null,
      actor: { application: binding.application, idType: actorType, userId: actorId },
      capabilities: [...(actorInput ? ['input' as const] : []), ...(actorAnswer ? ['answer' as const] : []), ...(actorPermission ? ['permission' as const] : [])], state: 'active'
    } }))
  }
  function revokePermission(grant: ConnectionGrant) {
    if (!binding) return
    if (grant.actor.idType === actorType && grant.actor.userId === actorId) setActorPermission(false)
    const key = memberKey(grant.actor.idType, grant.actor.userId), capabilities = grant.capabilities.filter(value => value !== 'permission')
    const previous = relevant.find(intent => intent.method === 'connection.grant' && currentGrantIntent(intent) && intent.input.grantId === grant.grantId && intent.input.actor.idType === grant.actor.idType && intent.input.actor.userId === grant.actor.userId)
    if (previous) { void memberWork(key, async () => { await inspect(previous) }); return }
    void memberWork(key, () => execute({ method: 'connection.grant', target, phase: 'not-dispatched', input: {
      operationId: crypto.randomUUID(), bindingId: binding.bindingId, expectedBindingRevision: binding.revision, grantId: grant.grantId, expectedRevision: grant.revision,
      actor: grant.actor, capabilities, state: capabilities.length ? 'active' : 'revoked'
    } }))
  }
  function newContext() {
    if (!mote) return
    const id = useAppStore.getState().openLauncher({ workspaceId: mote.workspace.id, topicId: mote.topic.id, reveal: false })
    const group = id ? useAppStore.getState().layouts[mote.workspace.id]?.groups.find(item => item.tabOrder.includes(id)) : undefined
    if (id && group) { mote.selectTab(id, group.id); onClose() }
    else setIssue('The original Mote discussion entry is unavailable. Your Agent and draft are kept.')
  }
  const sameSharing = !!binding && audience === binding.externalConversationId && scope === binding.scope.input && publication === binding.scope.publication
  const sharing = <section className="agent-connector-fields"><h3>{binding ? 'Sharing options' : 'Share with this group'}</h3>
    <div className="agent-connector-field"><label htmlFor={fieldId + '-publication'}>Share to the group</label><SelectionField id={fieldId + '-publication'} label="Group sharing content" value={publication} disabled={busy} onValueChange={value => { if (value === 'future-native-user-facing' || value === 'future-shared-conversation') { setPublication(value); setConfirmed(false) } }} options={[{ value: 'future-native-user-facing', label: 'Agent replies and questions' }, { value: 'future-shared-conversation', label: 'New shared conversation' }]} /></div>
    {publication === 'future-shared-conversation' ? <p className="agent-connector-note">Allow new human messages, including Terminal input, Agent replies, questions, answers and resources to be shared. Some sources or attachments may not sync yet; delivery details show missing content. Earlier history is not published.</p> : null}
    <div className="agent-connector-field"><label htmlFor={fieldId + '-scope'}>Accept requests</label><SelectionField id={fieldId + '-scope'} label="Group input scope" value={scope} disabled={busy} onValueChange={value => { if (value === 'mentions-and-replies' || value === 'all-messages') setScope(value) }} options={[{ value: 'mentions-and-replies', label: 'Mentions and replies only' }, { value: 'all-messages', label: 'Every group message' }]} /></div>
    {binding && sameSharing && binding.state === 'active' ? <p className="agent-connector-note">Reconnect to start sharing from now.</p> : null}
    {binding && approvedMembers ? <p className="agent-connector-note">Changing this connection requires approving members again.</p> : null}
    <p className="agent-connector-note">This Agent may use its existing private context in replies. A separate discussion keeps contexts apart.</p>
    {mote ? <button className="agent-connector-text-action" onClick={newContext}>Start a separate discussion</button> : <p className="agent-connector-note">For separate context, start a new Agent in Mote before connecting it.</p>}
    <label className="agent-connector-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{publication === 'future-shared-conversation' ? 'Share new conversation content with this group.' : 'Share new replies and questions with this group.'}</label>
    {session.nativeHandle?.kind !== 'provider' ? <p role="status" className="agent-connector-note">The Agent’s conversation source is not confirmed yet. You can keep working locally.</p> : null}
  </section>
  const applicationChoice = <SelectionField id={fieldId + '-application'} label="Group application" value={connectionId} disabled={busy}
    triggerLabel={connection ? 'Change' : 'Choose'} className="agent-connector-source__change"
    onValueChange={value => { initialized.current = true; explicitlySelected.current = true; setConnectionId(value); setGroup(''); setConfirmed(false) }} options={[{ value: '', label: 'Choose an application…' }, ...connections.map(item => ({ value: item.config.connectionId, label: item.config.label, disabled: !item.config.enabled, description: item.config.application.domain + ' · ' + item.config.application.appId }))]} />
  const application = <div className="agent-connector-source">
    <span className="agent-connector-source__label">Using</span><strong title={connection?.config.label ?? connectionId}>{connection?.config.label ?? (connectionId ? 'Saved application' : 'Choose an application')}</strong>{applicationChoice}
  </div>
  const canCreate = mode === 'create' && !binding && !roomIntent
  const canConnect = !bindingPending && (binding ? changingGroup : mode !== 'create' || !!created)
  const previousActivity = !!original.connectionId || bindings.length > 0 || Object.values(intents).some(intent => sameConnectorTarget(intent.target, target))
  const defaultChoice = moteDefault.ref ? moteConnectionChoice(moteDefault.ref, connections) : null
  const defaultNote = !explicitlySelected.current && !previousActivity && mode !== 'details'
    ? moteDefault.status === 'loading' ? 'Checking this Mote’s default bot. You can choose a bot now.'
      : moteDefault.issue ?? (defaultChoice?.issue ? `Saved default ${moteDefault.ref!.application.appId}: ${defaultChoice.issue}`
        : moteDefault.ref && original.mote && 'name' in original.mote ? `Default bot for ${original.mote.name}` : null)
    : null

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="dialog-scrim" />
      <Dialog.Content ref={content} className="dialog-surface agent-connector-dialog" aria-busy={busy}
        onOpenAutoFocus={event => { event.preventDefault(); (content.current?.querySelector<HTMLElement>('[aria-label="Group name"]') ?? content.current?.querySelector<HTMLElement>('[aria-label="Existing group"]') ?? content.current?.querySelector<HTMLElement>('[aria-label="Close group setup"]'))?.focus({ preventScroll: true }) }}
        onCloseAutoFocus={event => { event.preventDefault(); const node = returnFocus(), active = ownerDocument.activeElement; if (node?.isConnected && (active === ownerDocument.body || !active?.isConnected || content.current?.contains(active))) node.focus({ preventScroll: true }) }}
        onEscapeKeyDown={event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault() }}>
        <header className="agent-connector-dialog__header"><div><Dialog.Title>{binding ? 'Shared group details' : mode === 'create' ? 'Create group chat' : 'Bind existing group chat'}</Dialog.Title>
          <Dialog.Description className="agent-connector-description">Connect {original.name} to an exact group conversation.</Dialog.Description></div>
          <button type="button" className="icon-button" aria-label="Close group setup" onClick={onClose}><CloseIcon size={15} /></button></header>
        <div className="agent-connector-dialog__body">
          <section className="agent-connector-pairing" aria-label="Agent and group conversation">
            <div className="agent-connector-pairing__agent">
              {original.identity ? <ResolvedAgentAvatar {...original.identity} label={original.name} size={32} /> : <AgentIcon size={28} aria-hidden="true" />}
              <strong>{original.name}</strong><span>Agent</span>
            </div>
            <ConnectIcon className="agent-connector-pairing__link" size={18} aria-hidden="true" />
            <div className="agent-connector-pairing__group"><span><GroupIcon size={14} aria-hidden="true" />{creatingGroup ? 'Group name' : bindingPending ? 'Requested group' : 'Group conversation'}</span>
              {creatingGroup ? <TextInput aria-label="Group name" title={frozenRoom?.name ?? name} value={frozenRoom?.name ?? name} disabled={busy || !!roomIntent} onChange={event => setName(event.target.value)} />
                : (bindingPending || showingCurrentBinding) ? <strong className="agent-connector-group">{knownRoom ? roomName(knownRoom) : audience}</strong>
                : connection ? <ConnectorRoomSelection key={JSON.stringify([connectionId, connection.revision])} connection={connection} value={audience} disabled={busy || bindingPending} onChange={value => { setGroup(value); setConfirmed(false) }} /> : <span>Choose an application below.</span>}
            </div>
          </section>
          {application}
          {defaultNote ? <p className="agent-connector-note" role="status" data-mote-bot-source>{defaultNote}</p> : null}
          {showingCurrentBinding && binding ? <><section className="agent-connector-status" aria-label="Group connection status"><div><strong>{binding.state === 'active' ? 'Sharing on' : 'Sharing paused'}</strong><span>New {binding.scope.publication === 'future-shared-conversation' ? 'conversation content' : 'replies and questions'}</span></div><button className="agent-connector-text-action" disabled={busy || binding.state === 'paused'} onClick={pause}>Pause sharing</button><p className="agent-connector-note" aria-label="Group member access">{approvedMembers === null ? 'Member access not confirmed' : unconfirmedMembers ? 'Member access not confirmed. Last confirmed: ' + (approvedMembers === 0 ? 'no members approved' : approvedMembers + (approvedMembers === 1 ? ' member approved' : ' members approved')) : approvedMembers === 0 ? 'No members approved to use this Agent' : approvedMembers + (approvedMembers === 1 ? ' member approved to use this Agent' : ' members approved to use this Agent')}</p></section><ConnectorDeliveryDetails key={JSON.stringify([binding.bindingId, binding.revision])} binding={binding} /></> : null}
          {bindingPending || binding && changingGroup ? <p className="agent-connector-note" role="status">{bindingPending ? 'The group change is not confirmed. Check its original status.' : 'Your current group stays connected until you confirm this change.'}</p> : null}
          {audience ? <ConnectorRoomPeople facts={roomFacts} onSelect={showingCurrentBinding ? selectActor : undefined} /> : null}
          {audience && audienceLinks.length && !linkIntent ? <p role="status" className="agent-connector-note">Several original joining requests are kept. Check their receipts below before generating another.</p> : audience ? <ConnectorRoomJoinLink key={JSON.stringify([connectionId, audience])} submitted={!!linkIntent} operation={linkOperation} pending={busy} prominent={mode === 'create' && !!created && !binding}
            canContinue={linkIntent?.phase === 'not-dispatched' && !linkOperation}
            onCreate={() => createJoinLink()} onRegenerate={() => { if (linkIntent) createJoinLink(linkIntent.input.operationId) }} onInspect={() => { if (linkIntent) void work(async () => { await inspect(linkIntent) }) }}
            onContinue={() => { if (linkIntent?.phase === 'not-dispatched' && !linkOperation) void work(() => execute(linkIntent, true)) }} /> : null}
          {mode === 'create' && !binding ? <fieldset disabled={busy || !!roomIntent} className="agent-connector-fields" aria-label="New dedicated group">
            <details className="agent-connector-disclosure"><summary>Invite people (optional)</summary><div className="agent-connector-fields">
              <label className="agent-connector-field">Member ID type<TextInput aria-label="Member ID type" value={frozenRoom?.members[0]?.idType ?? memberType} onChange={event => setMemberType(event.target.value)} placeholder="Exact ID type" /></label>
              <label className="agent-connector-field">Member IDs<Textarea aria-label="Invite member IDs" rows={3} value={frozenRoom ? frozenRoom.members.map(member => member.userId).join('\n') : members} onChange={event => setMembers(event.target.value)} placeholder="One exact ID per line" /></label>
              <p className="agent-connector-note">Invitations and access to this Agent are separate. You can manage member access after connecting the group.</p>
            </div></details>
          </fieldset> : null}
          {relevant.map(intent => { const fact = facts[intent.input.operationId], isRoom = fact && 'creation' in fact
            if (intent.method === 'connection.room.link.create') {
              if (intent === linkIntent) return null
              const previous = fact && 'state' in fact && 'input' in fact && 'externalConversationId' in fact.input ? fact as RoomLinkOperation : null
              return <details className="agent-connector-disclosure" key={intent.input.operationId}><summary>Previous join link receipt</summary><div className="agent-connector-fields"><ConnectorRoomJoinReceipt operation={previous} />{!previous ? <><span>Group · {intent.input.externalConversationId}</span><code>{intent.input.operationId}</code></> : null}<button className="small-button" disabled={busy} onClick={() => void work(async () => { await inspect(intent) })}>Check link status</button></div></details>
            }
            const memberIntent = intent.method === 'connection.grant' ? intent : null
            const receipt = <>
              {isRoom ? <><strong>{fact.creation.state === 'created' ? 'Group created' : fact.creation.state === 'not-applied' ? 'Group not created' : fact.creation.state === 'pending' ? 'Group setup pending' : 'Creation not confirmed'}</strong><span>{fact.membership.state === 'not-requested' ? 'No invitations requested.' : fact.membership.state === 'settled' ? fact.membership.results.filter(item => item.state === 'joined').length + ' of ' + fact.membership.results.length + ' invitations confirmed.' : fact.membership.state === 'not-applied' ? 'Invitations were not sent.' : fact.membership.state === 'pending' ? 'Invitations not started.' : 'Invitations not confirmed.'}</span></> : <strong>{fact && 'state' in fact && fact.state === 'refused' ? memberIntent ? 'Member access could not be saved' : 'Setup could not finish' : memberIntent ? memberReceiptState(memberIntent) === 'not-dispatched' ? 'Member access not sent' : memberReceiptState(memberIntent) === 'applied' ? 'Member access saved' : 'Member access not confirmed' : 'Setup not confirmed'}</strong>}
              {memberIntent ? <><span>Member · {currentGrantIntent(memberIntent) ? roomFacts.people?.members.find(member => member.idType === memberIntent.input.actor.idType && member.userId === memberIntent.input.actor.userId)?.name ?? memberIntent.input.actor.userId : memberIntent.input.actor.userId}</span><span>{currentGrantIntent(memberIntent) ? 'This group connection' : 'Original group connection'} · revision {memberIntent.input.expectedBindingRevision}</span></> : null}
              <button className="small-button" disabled={busy} onClick={() => void work(async () => { await inspect(intent); await refresh() })}>Check status</button>
              {isRoom && (fact.creation.state === 'pending' || fact.creation.state === 'created' && fact.membership.state === 'pending') || fact && 'state' in fact && fact.state === 'preparing' || intent.phase === 'not-dispatched' ? <button className="small-button" disabled={busy} onClick={() => void work(() => execute(intent, true))}>Continue setup</button> : null}
              {isRoom && fact.creation.state === 'not-applied' || fact && 'state' in fact && fact.state === 'refused' ? <button className="small-button" disabled={busy} onClick={() => void work(async () => { await clearConnectorRoomIntent(intent.input.operationId); await refresh() })}>Dismiss unsuccessful setup</button> : null}
              <details className="agent-connector-disclosure"><summary>Setup receipt details</summary><div className="agent-connector-fields">
                <span>Operation</span><code>{intent.input.operationId}</code><span>Host · {target.executionHostId}</span>
                {isRoom ? <><span>Creation: {fact.creation.state}{fact.creation.state === 'created' ? ' · ' + fact.creation.externalConversationId : fact.creation.state === 'not-applied' ? ' · ' + fact.creation.reason : ''}</span><span>Members: {fact.membership.state}</span>{fact.membership.state === 'settled' ? fact.membership.results.map((item, index) => <span key={index}>{item.member.idType} · {item.member.userId}: {item.state}</span>) : null}</> : <span>{fact && 'state' in fact ? fact.state + (fact.state === 'refused' && 'code' in fact ? ' · ' + fact.code : '') : 'Result unknown.'}</span>}
              </div></details>
            </>
            return binding && isRoom && fact.creation.state === 'created' ? <details className="agent-connector-disclosure" key={intent.input.operationId}><summary>Group setup receipt</summary><div className="agent-connector-receipt">{receipt}</div></details> : <section className="agent-connector-receipt" key={intent.input.operationId} aria-label={memberIntent ? 'Member access status' : 'Group setup status'}>{receipt}</section>
          })}
          {!binding && !bindingPending && (mode !== 'create' || created) ? sharing : null}
          {binding ? <>
            <details className="agent-connector-disclosure" open={changingGroup} onToggle={event => setChangingGroup(event.currentTarget.open)}><summary>Change connected group</summary><div className="agent-connector-fields">{bindingPending ? <p className="agent-connector-note">Check the pending connection setup before changing groups.</p> : sharing}</div></details>
            {showingCurrentBinding ? <details className="agent-connector-disclosure" open={accessOpen} onToggle={event => setAccessOpen(event.currentTarget.open)}><summary>Manage member access</summary><div className="agent-connector-fields">
              <p className="agent-connector-note">Allow an exact person to send requests or answer questions in this group. Invitations alone do not grant access.</p>
              {actors?.bindingId === binding.bindingId && actors.revision === binding.revision ? actors.grants.length ? actors.grants.map(grant => <div className="agent-connector-access-member" key={grant.grantId}><p className="agent-connector-note"><strong>{roomFacts.people?.members.find(member => member.idType === grant.actor.idType && member.userId === grant.actor.userId)?.name ?? grant.actor.userId}</strong> · {currentMemberIntents.some(intent => intent.input.actor.idType === grant.actor.idType && intent.input.actor.userId === grant.actor.userId && memberReceiptState(intent) === 'unconfirmed') ? 'Last confirmed: ' : ''}{grant.state === 'revoked' ? 'Access revoked' : grant.capabilities.map(value => value === 'permission' ? 'Permission decisions' : value === 'answer' ? 'Answers' : 'Requests').join(', ')}</p>{grant.state === 'active' && grant.capabilities.includes('permission') ? <button className="agent-connector-text-action" disabled={memberFlights.has(memberKey(grant.actor.idType, grant.actor.userId))} onClick={() => revokePermission(grant)}>{currentMemberIntents.some(intent => intent.input.actor.idType === grant.actor.idType && intent.input.actor.userId === grant.actor.userId) ? 'Check original member access' : 'Revoke permission decisions'}</button> : null}</div>) : <p className="agent-connector-note">{unconfirmedMembers ? 'Last confirmed: no member access has been approved for this connection.' : 'No member access has been approved for this connection.'}</p> : <p className="agent-connector-note">Member access is not confirmed.</p>}
              <p className="agent-connector-note">Choose a person from this group above, or enter an exact account below.</p>
              {actorId ? <p className="agent-connector-note">Selected member · <strong>{roomFacts.people?.members.find(member => member.idType === actorType && member.userId === actorId)?.name ?? actorId}</strong></p> : null}
              <details className="agent-connector-disclosure"><summary>Exact account details</summary><div className="agent-connector-fields">
                <label className="agent-connector-field">Member ID type<TextInput aria-label="Member access ID type" value={actorType} onChange={event => selectActor(event.target.value, actorId)} /></label>
                <label className="agent-connector-field">Member ID<TextInput aria-label="Member access ID" value={actorId} onChange={event => selectActor(actorType, event.target.value)} /></label>
              </div></details>
              <label className="agent-connector-check"><input type="checkbox" checked={actorInput} onChange={event => setActorInput(event.target.checked)} />Send requests</label><label className="agent-connector-check"><input type="checkbox" checked={actorAnswer} onChange={event => setActorAnswer(event.target.checked)} />Answer questions</label>
              <label className="agent-connector-check"><input type="checkbox" checked={actorPermission} onChange={event => setActorPermission(event.target.checked)} />Allow permission decisions</label>
              <p className="agent-connector-note">Off by default. Enabling this shares the original permission request and tool details with this group so this member can decide. Chat access and question answers do not grant permission control.</p>
              <button className="small-button" disabled={memberFlights.has(selectedMember.current) || !actorType || !actorId || !selectedMemberIntent && !actorInput && !actorAnswer && !actorPermission} onClick={grant}>{memberFlights.has(selectedMember.current) ? 'Member access in progress…' : selectedMemberIntent ? 'Check original member access' : actorGrant ? 'Save member access' : 'Approve this member'}</button>
            </div></details> : null}
          </> : null}
          <details className="agent-connector-disclosure"><summary>Connection details</summary><div className="agent-connector-fields">
            {settings ? <button className="agent-connector-text-action" onClick={() => { settings.openConnector({ sessionId: session.id, hostId: target.executionHostId, agentSessionId: target.agentSessionId, ...(connection ? { connectionId: connection.config.connectionId } : {}) }); onClose() }}>Application settings</button> : null}
            {connection ? <span>{connection.config.application.domain} · {connection.config.application.appId} · Revision {connection.revision}</span> : null}
            <span>Host · {target.executionHostId}</span>{audience ? <span>{bindingPending ? 'Requested group' : 'Group'} · {audience}</span> : null}{binding ? <>{bindingPending ? <span>Last observed group · {binding.externalConversationId}</span> : null}<span>{bindingPending ? 'Last observed Binding' : 'Binding'} · {binding.bindingId} · Revision {binding.revision}</span></> : null}
          </div></details>
          {issue ? <p role="status" className="surface-inline-error">{issue}</p> : null}
        </div><footer className="agent-connector-dialog__footer">
          {issue || relevant.length ? <button className="agent-connector-text-action" disabled={busy} onClick={() => void work(refresh)}>Refresh</button> : null}
          <button className="small-button" onClick={onClose}>{!binding && !relevant.length ? 'Cancel' : 'Close'}</button>
          {canCreate ? <button className="primary-button" disabled={busy || !connection || !name.trim() || !!members && !memberType.trim()} onClick={createRoom}>{busy ? 'Creating…' : 'Create group'}</button> : canConnect ? <button className="primary-button" disabled={busy || !connection?.config.enabled || !confirmed || !audience.trim() || session.nativeHandle?.kind !== 'provider'} onClick={bind}>{binding ? audience === binding.externalConversationId ? binding.state === 'paused' && sameSharing ? 'Resume sharing' : sameSharing ? 'Reconnect group' : 'Save sharing' : 'Change group' : 'Connect group'}</button> : null}
        </footer>
      </Dialog.Content></DocumentOverlayPortal>
  </Dialog.Root>
}
