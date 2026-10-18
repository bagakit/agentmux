import { mintObjectId } from '@agentmux/core/object-id'
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
import { ConnectorRoomOverview, ConnectorRoomPeople, ConnectorRoomSelection, useConnectorRoomFacts } from './ConnectorRoomSelection'
import { ConnectorRoomJoinLink, ConnectorRoomJoinReceipt } from './ConnectorRoomJoinLink'
import { ConnectorCreatorInvitation, useConnectorCreatorInvitation } from './ConnectorCreatorInvitation'
import { ConnectorDeliveryDetails } from './ConnectorDeliveryDetails'
import { ConnectorServiceControl } from './settings/ConnectorServiceControl'
import { parseMotePreferencesReadResult, type MoteConnectionRef } from '@agentmux/core/mote-preferences'
import { connectionIdentityObservation, connectionNeedsInitialSetup, moteConnectionChoice, type AgentMoteConnectionSource } from '../lib/mote-connection-default'

const CloseIcon = semanticIconComponent('action.close')
const LoadingIcon = semanticIconComponent('status.loading')
const AgentIcon = semanticIconComponent('object.agent')
const GroupIcon = semanticIconComponent('object.conversation')
const CheckIcon = semanticIconComponent('action.confirm')

const availableForNewGroup = (record: ConnectionRecord) => record.config.enabled && !connectionNeedsInitialSetup(record)
function shortIdentity(value: string, others: readonly string[] = []) {
  const compact = (id: string) => id.length > 18 ? id.slice(0, 6) + '…' + id.slice(-8) : id
  const label = compact(value)
  return others.some(other => other !== value && compact(other) === label) ? value : label
}

type Fact = RoomProvisioningOperation | RoomBindingOperation | RoomLinkOperation | null
export type AgentConnectorTarget = { target: RoomBindingTarget; session: AgentNativeSourceReference; name: string; connectionId?: string; mote?: AgentMoteConnectionSource
  identity?: Pick<ComponentProps<typeof ResolvedAgentAvatar>, 'providerId' | 'appearance' | 'executorId'> }
/** A bounded form over original public owners. It retains submitted correlations, never another receipt store. */
export function AgentConnectorDialog({ original, mode: initialMode, initialSection, onClose, returnFocus }: {
  original: AgentConnectorTarget; mode: 'create' | 'existing' | 'details'; initialSection?: 'joining'; onClose(): void; returnFocus(): HTMLElement | null
}) {
  const ownerDocument = useWorkbenchDocument()
  const [mode, setMode] = useState(initialMode)
  const { target, session } = original, identity = JSON.stringify(target), fieldId = useId()
  const [changingGroup, setChangingGroup] = useState(false)
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
  const creatingGroup = (mode === 'create' || !!roomIntent) && !binding
  const bindingIntent = relevant.find(intent => intent.method === 'connection.bind' || intent.method === 'connection.binding.relink')
  const bindingPending = !!bindingIntent
  const showingCurrentBinding = !!binding && !changingGroup && !bindingPending
  const links = relevant.filter((intent): intent is Extract<ConnectorRoomIntent, { method: 'connection.room.link.create' }> => intent.method === 'connection.room.link.create')
  // Explicit submitted replacement references choose the head; presentation order is not authority.
  const replacedLinks = new Set(links.filter(next => links.some(previous => previous.input.operationId === next.replacesOperationId && previous.input.externalConversationId === next.input.externalConversationId)).map(next => next.replacesOperationId))
  const linkHeads = links.filter(intent => !replacedLinks.has(intent.input.operationId))
  const originalLink = linkHeads.length === 1 ? linkHeads[0] : undefined
  const restoredGroup = !group && originalLink?.method === 'connection.room.link.create' ? originalLink.input.externalConversationId : group
  const audience = bindingIntent && 'externalConversationId' in bindingIntent.input ? bindingIntent.input.externalConversationId : creatingGroup ? created ?? '' : binding && !changingGroup ? binding.externalConversationId : restoredGroup
  const audienceLinks = links.filter(intent => intent.input.externalConversationId === audience)
  const audienceHeads = linkHeads.filter(intent => intent.input.externalConversationId === audience)
  const linkIntent = audienceHeads.length === 1 ? audienceHeads[0] : undefined
  const linkFact = linkIntent ? facts[linkIntent.input.operationId] : null
  const linkOperation = linkFact && 'input' in linkFact && 'externalConversationId' in linkFact.input ? linkFact as RoomLinkOperation : null
  const roomFacts = useConnectorRoomFacts(connection, audience)
  useEffect(() => {
    if (!initialFocus.current || !connection || mode !== 'existing') return
    initialFocus.current = false
    const close = content.current?.querySelector('[aria-label="Close group setup"]')
    if (ownerDocument.activeElement === close) content.current?.querySelector<HTMLElement>('[aria-label="Existing group"]')?.focus({ preventScroll: true })
  }, [connection, mode])
  const approvedMembers = binding && actors?.bindingId === binding.bindingId && actors.revision === binding.revision
    ? new Set(currentGrants.filter(grant => grant.state === 'active').map(grant => JSON.stringify([grant.actor.application.domain, grant.actor.application.appId, grant.actor.idType, grant.actor.userId]))).size : null
  const currentMemberIntents = relevant.filter((intent): intent is Extract<ConnectorRoomIntent, { method: 'connection.grant' }> => intent.method === 'connection.grant' && currentGrantIntent(intent))
  const unconfirmedMembers = currentMemberIntents.some(intent => memberReceiptState(intent) === 'unconfirmed')
  const selectedMemberIntent = currentMemberIntents.find(intent => intent.input.actor.idType === actorType && intent.input.actor.userId === actorId)
  function memberReceiptState(intent: Extract<ConnectorRoomIntent, { method: 'connection.grant' }>) {
    const fact = facts[intent.input.operationId]
    if (fact && 'state' in fact && (fact.state === 'applied' || fact.state === 'refused')) return fact.state
    return !fact && intent.phase === 'not-dispatched' ? 'not-dispatched' : 'unconfirmed'
  }
  useEffect(() => { setGroup(binding?.externalConversationId ?? ''); setScope(binding?.scope.input ?? 'mentions-and-replies'); setPublication(binding?.scope.publication ?? 'future-native-user-facing'); setConfirmed(false); setChangingGroup(false); setActorId(''); setActorType(''); setActorInput(false); setActorAnswer(false); setActorPermission(false) }, [connectionId, binding?.bindingId, binding?.revision])
  const frozenRoom = roomIntent?.method === 'connection.room.create' ? roomIntent.input : null
  const creatorInvitation = useConnectorCreatorInvitation(connection, creatingGroup && !roomIntent && !!connection && availableForNewGroup(connection))
  const awaitingCreator = creatorInvitation.pending && creatorInvitation.included
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
    setActorType(idType); setActorId(userId); setActorInput(grant?.capabilities.includes('input') ?? false); setActorAnswer(grant?.capabilities.includes('answer') ?? false); setActorPermission(grant?.capabilities.includes('permission') ?? false)
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
        if (choice.issue || connectionNeedsInitialSetup(choice.record!)) return
        selected = choice.record!.config.connectionId
      } else {
        const enabled = connections.filter(availableForNewGroup)
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
    if ('creation' in value && value.creation.state === 'not-applied' && ['connection-unavailable', 'connection-revised'].includes(value.creation.reason))
      setIssue('The bot configuration changed before this request. No group was created. Review the current bot settings and keep this original receipt.')
  }
  function createRoom() {
    if (!connection || !availableForNewGroup(connection) || roomIntent || binding || awaitingCreator || !name.trim() || members && !memberType.trim()) return
    void work(() => execute({ method: 'connection.room.create', target: { ...target, regionAnchor: { ...target.regionAnchor } }, phase: 'not-dispatched', input: {
      ...target, operationId: mintObjectId(), connectionId, expectedConnectionRevision: connection.revision, name,
      members: [...new Map([...(creatorInvitation.member ? [creatorInvitation.member] : []), ...members.split('\n').filter(value => value !== '').map(userId => ({ idType: memberType, userId }))].map(member => [JSON.stringify([member.idType, member.userId]), member])).values()]
    } }))
  }
  function createJoinLink(replacesOperationId?: string) {
    if (!connection || !audience) return
    if (replacesOperationId ? linkIntent?.input.operationId !== replacesOperationId || !linkOperation || linkOperation.state !== 'confirmed' && linkOperation.state !== 'refused' : audienceLinks.length > 0) return
    void work(() => execute({ method: 'connection.room.link.create', target, phase: 'not-dispatched', ...(replacesOperationId ? { replacesOperationId } : {}), input: { operationId: mintObjectId(), connectionId,
      expectedConnectionRevision: connection.revision, externalConversationId: audience } }))
  }
  function bind() {
    const native = session.nativeHandle
    if (!connection || !confirmed || native?.kind !== 'provider' || !audience.trim()) return
    const previous = relevant.find(intent => intent.method === 'connection.bind' || intent.method === 'connection.binding.relink')
    if (previous) { void work(async () => { await inspect(previous) }); return }
    const input = { ...target, operationId: mintObjectId(), bindingId: binding?.bindingId ?? mintObjectId(), connectionId,
      expectedConnectionRevision: connection.revision, externalConversationId: audience,
      scope: { input: scope, publication }, expectedSource: { providerId: native.providerId, nativeSessionId: native.sessionId } }
    void work(() => execute(binding ? { method: 'connection.binding.relink', input: { ...input, expectedRevision: binding.revision }, target, phase: 'not-dispatched' } : { method: 'connection.bind', input, target, phase: 'not-dispatched' }))
  }
  function pause() { const previous = relevant.find(intent => intent.method === 'connection.binding.pause'); if (previous) { void work(async () => { await inspect(previous) }); return } if (binding) void work(() => execute({ method: 'connection.binding.pause', target, phase: 'not-dispatched', input: { operationId: mintObjectId(), bindingId: binding.bindingId, expectedRevision: binding.revision } })) }
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
      operationId: mintObjectId(), bindingId: binding.bindingId, expectedBindingRevision: binding.revision,
      grantId: actorGrant?.grantId ?? mintObjectId(), expectedRevision: actorGrant?.revision ?? null,
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
      operationId: mintObjectId(), bindingId: binding.bindingId, expectedBindingRevision: binding.revision, grantId: grant.grantId, expectedRevision: grant.revision,
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
  const sharing = <section className="agent-connector-fields agent-connector-section" aria-label="Sharing options"><h3>{binding ? 'Sharing options' : 'Share with this group'}</h3>
    <div className="agent-connector-field"><label htmlFor={fieldId + '-publication'}>Share to the group</label><SelectionField id={fieldId + '-publication'} label="Group sharing content" value={publication} disabled={busy} onValueChange={value => { if (value === 'future-native-user-facing' || value === 'future-shared-conversation') { setPublication(value); setConfirmed(false) } }} options={[{ value: 'future-native-user-facing', label: 'Agent replies and questions' }, { value: 'future-shared-conversation', label: 'New shared conversation' }]} /></div>
    {publication === 'future-shared-conversation' ? <p className="agent-connector-note">Allow new human messages, including Terminal input, Agent replies, questions, answers and resources to be shared. Some sources or attachments may not sync yet; delivery details show missing content. Earlier history is not published.</p> : null}
    <div className="agent-connector-field"><label htmlFor={fieldId + '-scope'}>Accept requests</label><SelectionField id={fieldId + '-scope'} label="Group input scope" value={scope} disabled={busy} onValueChange={value => { if (value === 'mentions-and-replies' || value === 'all-messages') { setScope(value); setConfirmed(false) } }} options={[{ value: 'mentions-and-replies', label: 'Mentions and replies only' }, { value: 'all-messages', label: 'Every group message' }]} /></div>
    {binding && sameSharing && binding.state === 'active' ? <p className="agent-connector-note">These sharing settings are saved. Changes apply only after confirmation.</p> : null}
    {binding && approvedMembers ? <p className="agent-connector-note">Changing this connection requires approving members again.</p> : null}
    <p className="agent-connector-note">This Agent may use its existing private context in replies. A separate discussion keeps contexts apart.</p>
    {mote ? <button className="agent-connector-text-action" onClick={newContext}>Start a separate discussion</button> : <p className="agent-connector-note">For separate context, start a new Agent in Mote before connecting it.</p>}
    {!binding || changingGroup || !sameSharing || binding.state === 'paused' ? <label className="agent-connector-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{publication === 'future-shared-conversation' ? 'Share new conversation content with this group.' : 'Share new replies and questions with this group.'}</label> : null}
    {session.nativeHandle?.kind !== 'provider' ? <p role="status" className="agent-connector-note">The Agent’s conversation source is not confirmed yet. You can keep working locally.</p> : null}
  </section>
  const applicationPeers = (record: ConnectionRecord) => connections.filter(item => item.config.application.domain === record.config.application.domain && item.config.application.appId === record.config.application.appId)
  const applicationLabel = (record: ConnectionRecord) => {
    const { application, connectionId } = record.config, peers = applicationPeers(record)
    return application.domain + ' · ' + shortIdentity(application.appId, connections.map(item => item.config.application.appId)) +
      (peers.length > 1 ? ' · Connection ' + shortIdentity(connectionId, peers.map(item => item.config.connectionId)) : '')
  }
  const applicationChoice = <SelectionField id={fieldId + '-application'} label="Group application" value={connectionId} disabled={busy}
    triggerLabel={connection ? 'Change' : 'Choose'} className="agent-connector-source__change" menuClassName="agent-connector-application-menu"
    onValueChange={value => { initialized.current = true; explicitlySelected.current = true; setConnectionId(value); setGroup(''); setConfirmed(false) }} options={[{ value: '', label: 'Choose an application…' }, ...connections.filter(availableForNewGroup).map(item => ({ value: item.config.connectionId, label: item.config.label, description: applicationLabel(item) }))]} />
  const identityObservation = connection ? connectionIdentityObservation(connection) : null
  const defaultChoice = moteDefault.ref ? moteConnectionChoice(moteDefault.ref, connections) : null
  const setupPending = connections.filter(connectionNeedsInitialSetup)
  const currentSetupPending = connection && connectionNeedsInitialSetup(connection) ? connection
    : defaultChoice?.record && connectionNeedsInitialSetup(defaultChoice.record) ? defaultChoice.record : null
  const otherSetupPending = setupPending.filter(item => item.config.connectionId !== currentSetupPending?.config.connectionId)
  const setupRecovery = (item: ConnectionRecord) => <p className="agent-connector-note" key={item.config.connectionId} data-incomplete-application>{item.config.label} · {connectionIdentityObservation(item).label}. {settings ? <button type="button" className="agent-connector-text-action" onClick={() => { settings.openLark({ sessionId: session.id, hostId: target.executionHostId, agentSessionId: target.agentSessionId, connectionId: item.config.connectionId }); onClose() }}>Continue setup</button> : 'Continue its original setup in application settings.'}</p>
  const application = <div className="agent-connector-application">
    <div className="agent-connector-source"><span className="agent-connector-source__label">Using</span><div className="agent-connector-source__identity"><strong>{connection?.config.label ?? (connectionId ? 'Saved application' : 'Choose an application')}</strong>{connection ? <small title={connection.config.application.domain + ' · ' + connection.config.application.appId + ' · ' + connection.config.connectionId}>{applicationLabel(connection)}</small> : null}</div>{applicationChoice}</div>
    {connection && !connection.config.enabled ? <div className="agent-connector-service" role="status"><strong>This bot is disabled</strong><p className="agent-connector-note">Its original groups and requests are kept. Enable this bot in settings or choose another bot for a new group.</p>{settings ? <button type="button" className="agent-connector-text-action" onClick={() => { settings.openLark({ sessionId: session.id, hostId: target.executionHostId, agentSessionId: target.agentSessionId, connectionId: connection.config.connectionId }); onClose() }}>Open bot settings</button> : null}</div> : null}
    {identityObservation ? <details className="agent-connector-disclosure" data-connection-observation><summary>{identityObservation.label}</summary><p className="agent-connector-note">{identityObservation.detail}</p></details> : null}
    {currentSetupPending ? setupRecovery(currentSetupPending) : null}
    {otherSetupPending.length ? <details className="agent-connector-disclosure"><summary>{otherSetupPending.length} {otherSetupPending.length === 1 ? 'bot needs' : 'bots need'} setup</summary>{otherSetupPending.map(setupRecovery)}</details> : null}
  </div>
  const canCreate = creatingGroup && !roomIntent
  const canConnect = !bindingPending && !!audience && (!binding || changingGroup || !sameSharing || binding.state === 'paused')
  const previousActivity = !!original.connectionId || bindings.length > 0 || Object.values(intents).some(intent => sameConnectorTarget(intent.target, target))
  const defaultNote = !explicitlySelected.current && !previousActivity && mode !== 'details'
    ? moteDefault.status === 'loading' ? 'Checking this Mote’s default bot. You can choose a bot now.'
      : moteDefault.issue ?? (defaultChoice?.issue ? `Saved default ${moteDefault.ref!.application.appId}: ${defaultChoice.issue}`
        : defaultChoice?.record && connectionNeedsInitialSetup(defaultChoice.record) ? 'This Mote’s saved bot needs its original setup continued. Its preference is kept.'
        : moteDefault.ref && original.mote && 'name' in original.mote ? `Default bot for ${original.mote.name}` : null)
    : null

  const groupSelected = !!audience
  const sharingSaved = showingCurrentBinding && binding?.state === 'active'
  const accessConfirmed = showingCurrentBinding && approvedMembers !== null && approvedMembers > 0 && !unconfirmedMembers
  const currentStep = !groupSelected ? 0 : !sharingSaved ? 1 : !accessConfirmed ? 2 : null
  const steps = [
    { label: 'Group', detail: groupSelected ? created && !binding ? 'Created' : 'Selected' : roomIntent ? 'Check result' : 'Choose or create', done: groupSelected },
    { label: 'Sharing', detail: bindingPending ? 'Check result' : sharingSaved ? 'Saved locally' : binding?.state === 'paused' ? 'Paused' : 'Review scope', done: !!sharingSaved },
    { label: 'Member access', detail: !showingCurrentBinding ? binding ? 'Review after sharing' : 'Not set' : unconfirmedMembers ? 'Check result' : approvedMembers === null ? binding ? 'Checking' : 'Not set' : approvedMembers === 0 ? 'Approve members' : `${approvedMembers} approved`, done: accessConfirmed }
  ]
  const joining = initialSection === 'joining' && showingCurrentBinding
  const disabledBinding = !!binding && connection?.config.enabled === false
  const taskTitle = joining ? 'Join with your chat account' : disabledBinding ? 'This bot is disabled' : bindingPending ? 'Check the original connection result' : !connection ? 'Choose a bot to connect' : roomIntent && !created && !binding ? 'Check this group’s creation' : changingGroup ? 'Review this group change' : !groupSelected ? creatingGroup ? 'Give your group a name' : 'Choose the group for this Agent'
    : !binding ? created ? 'Group created. Connect it to this Agent.' : 'Your group is selected. Review sharing next.'
    : binding.state === 'paused' ? 'Sharing is paused' : approvedMembers === 0 ? 'Choose who can use this Agent'
    : unconfirmedMembers || approvedMembers === null ? 'Check member access' : 'Your group connection is saved'
  const taskDetail = joining ? 'Use the official group link or scan its code. Joining the group and permission to use this Agent are separate.' : disabledBinding ? 'Your group and sharing settings are kept. Open bot settings to enable this bot; saved member access remains available to review.' : bindingPending ? 'Check the original connection request below. Earlier confirmed sharing is kept.' : roomIntent && !created && !binding ? 'Your original creation request is kept. Check its status below to continue.' : changingGroup ? 'Your current group stays connected until you confirm this change.' : !groupSelected ? 'Use a group your bot has joined, or create a dedicated group.'
    : !binding ? created ? 'The group exists separately from this Agent. Review and confirm sharing below to save their connection.' : 'Review the selected group and confirm what this Agent may share with it.'
    : binding.state === 'paused' ? 'The original group and member access are kept. Review sharing to resume.'
    : approvedMembers === 0 ? 'Sharing settings are saved locally. Approve a member before they can send requests from the group.'
    : 'The saved link, automatic sync and member access are separate. Activity shows actual message receipts.'

  const joiningAccess = audience && audienceLinks.length && !linkIntent ? <p role="status" className="agent-connector-note">Several original joining requests are kept. Check their receipts below before generating another.</p> : audience ? <ConnectorRoomJoinLink key={JSON.stringify([connectionId, audience])} submitted={!!linkIntent} operation={linkOperation} pending={busy} prominent
            canContinue={linkIntent?.phase === 'not-dispatched' && !linkOperation}
            onCreate={() => createJoinLink()} onRegenerate={() => { if (linkIntent) createJoinLink(linkIntent.input.operationId) }} onInspect={() => { if (linkIntent) void work(async () => { await inspect(linkIntent) }) }}
            onContinue={() => { if (linkIntent?.phase === 'not-dispatched' && !linkOperation) void work(() => execute(linkIntent, true)) }} /> : null

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="dialog-scrim" />
      <Dialog.Content ref={content} className="dialog-surface agent-connector-dialog" aria-busy={busy}
        onOpenAutoFocus={event => { event.preventDefault(); (content.current?.querySelector<HTMLElement>('[aria-label="Group name"]') ?? content.current?.querySelector<HTMLElement>('[aria-label="Existing group"]') ?? content.current?.querySelector<HTMLElement>('[aria-label="Close group setup"]'))?.focus({ preventScroll: true }) }}
        onCloseAutoFocus={event => { event.preventDefault(); const node = returnFocus(), active = ownerDocument.activeElement; if (node?.isConnected && (active === ownerDocument.body || !active?.isConnected || content.current?.contains(active))) node.focus({ preventScroll: true }) }}
        onEscapeKeyDown={event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault() }}>
        <header className="agent-connector-dialog__header"><div><Dialog.Title>{joining ? 'Join this group' : binding ? 'Group connection' : 'Connect a group'}</Dialog.Title>
          <Dialog.Description className="agent-connector-identity">{original.identity ? <ResolvedAgentAvatar {...original.identity} label={original.name} size={22} /> : <AgentIcon size={20} aria-hidden="true" />}<span>{original.name}</span></Dialog.Description></div>
          <button type="button" className="icon-button" aria-label="Close group setup" onClick={onClose}><CloseIcon size={15} /></button></header>
        <div className="agent-connector-dialog__body">
          <ol className="agent-connector-progress" aria-label="Group connection progress">
            {steps.map((step, index) => <li key={step.label} data-complete={step.done || undefined} aria-current={currentStep === index ? 'step' : undefined}>
              <span className="agent-connector-progress__number" aria-hidden="true">{step.done ? <CheckIcon size={13} /> : index + 1}</span>
              <span><strong>{step.label}</strong><small>{step.detail}</small></span>
            </li>)}
          </ol>
          <div className="agent-connector-task-heading"><h3>{taskTitle}</h3><p className="agent-connector-note">{taskDetail}</p></div>
          {application}
          {!binding && !roomIntent && !bindingPending ? <div className="agent-connector-modes" role="group" aria-label="Group choice">
            <button type="button" aria-label="Existing group" aria-pressed={mode !== 'create'} disabled={busy} onClick={() => { setMode('existing'); setConfirmed(false) }}>Existing group<span>Connect a group your bot has joined</span></button>
            <button type="button" aria-label="New group" aria-pressed={mode === 'create'} disabled={busy} onClick={() => { setMode('create'); setConfirmed(false) }}>New group<span>Create a dedicated space</span></button>
          </div> : null}
          <section className="agent-connector-group-selection" aria-label="Agent and group conversation">
            <span className="agent-connector-group-selection__label"><GroupIcon size={14} aria-hidden="true" />{creatingGroup && !created ? 'Group name' : bindingPending ? 'Requested group' : 'Group conversation'}</span>
            {creatingGroup && !created ? <TextInput aria-label="Group name" title={frozenRoom?.name ?? name} value={frozenRoom?.name ?? name} disabled={busy || !!roomIntent} onChange={event => setName(event.target.value)} />
              : (created && !binding || bindingPending || showingCurrentBinding) ? <ConnectorRoomOverview facts={roomFacts} groupId={audience} requestedName={created === audience ? frozenRoom?.name : undefined} />
              : connection ? <ConnectorRoomSelection key={JSON.stringify([connectionId, connection.revision])} connection={connection} value={audience} disabled={busy || bindingPending} onChange={value => { setGroup(value); setConfirmed(false) }} /> : <p className="agent-connector-note">Choose an application above to find its groups.</p>}
            {audience && !created && !bindingPending && !showingCurrentBinding ? <ConnectorRoomOverview facts={roomFacts} groupId={audience} /> : null}
          </section>
          <ConnectorServiceControl active />
          {defaultNote ? <p className="agent-connector-note" role="status" data-mote-bot-source>{defaultNote}</p> : null}
          {busy ? <p className="agent-connector-note" role="status" aria-busy="true" data-connector-request-pending><LoadingIcon size={13} animation="spin" /> Working on this group request…</p> : null}
          {showingCurrentBinding && binding ? <><section className="agent-connector-status" aria-label="Group connection status"><div><strong>Group saved</strong><span>{binding.state === 'active' ? 'Sharing saved locally' : 'Sharing paused'} · New {binding.scope.publication === 'future-shared-conversation' ? 'conversation content' : 'replies and questions'}</span></div><button className="agent-connector-text-action" disabled={busy || binding.state === 'paused'} onClick={pause}>Pause sharing</button><p className="agent-connector-note" aria-label="Group member access">{approvedMembers === null ? 'Member access not confirmed' : unconfirmedMembers ? 'Member access not confirmed. Last confirmed: ' + (approvedMembers === 0 ? 'no members approved' : approvedMembers + (approvedMembers === 1 ? ' member approved' : ' members approved')) : approvedMembers === 0 ? 'No members approved to use this Agent' : approvedMembers + (approvedMembers === 1 ? ' member approved to use this Agent' : ' members approved to use this Agent')}</p></section></> : null}

          {bindingPending || binding && changingGroup ? <p className="agent-connector-note" role="status">{bindingPending ? 'The group change is not confirmed. Check its original status.' : 'Your current group stays connected until you confirm this change.'}</p> : null}
          {creatingGroup && !created ? <fieldset disabled={busy || !!roomIntent} className="agent-connector-fields" aria-label="New dedicated group">
            {!roomIntent ? <ConnectorCreatorInvitation invitation={creatorInvitation} onOpenSettings={settings && connection ? () => { settings.openLark({ sessionId: session.id, hostId: target.executionHostId, agentSessionId: target.agentSessionId, connectionId: connection.config.connectionId }); onClose() } : undefined} /> : null}
            <details className="agent-connector-disclosure"><summary>Invite people (optional)</summary><div className="agent-connector-fields">
              {frozenRoom ? frozenRoom.members.length ? frozenRoom.members.map(member => <p className="agent-connector-note" key={JSON.stringify([member.idType, member.userId])}>{member.idType} · {member.userId}</p>) : <p className="agent-connector-note">No invitations requested.</p> : <>
                <label className="agent-connector-field">Member ID type<TextInput aria-label="Member ID type" value={memberType} onChange={event => setMemberType(event.target.value)} placeholder="Exact ID type" /></label>
                <label className="agent-connector-field">Member IDs<Textarea aria-label="Invite member IDs" rows={3} value={members} onChange={event => setMembers(event.target.value)} placeholder="One exact ID per line" /></label>
              </>}
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
            return isRoom && fact.creation.state === 'created' && (binding || fact.membership.state === 'not-requested' || fact.membership.state === 'settled') ? <details className="agent-connector-disclosure" key={intent.input.operationId}><summary>Group setup receipt</summary><div className="agent-connector-receipt">{receipt}</div></details> : <section className="agent-connector-receipt" key={intent.input.operationId} aria-label={memberIntent ? 'Member access status' : 'Group setup status'}>{receipt}</section>
          })}
          {audience && !bindingPending ? <div className="agent-connector-section-grid">
            {sharing}
            {joiningAccess ? <div className="agent-connector-section">{joiningAccess}</div> : null}
          </div> : joiningAccess ? <div className="agent-connector-section">{joiningAccess}</div> : null}
          {binding ? <details className="agent-connector-disclosure" open={changingGroup} onToggle={event => setChangingGroup(event.currentTarget.open)}><summary>Change connected group</summary><p className="agent-connector-note">{bindingPending ? 'Check the pending connection setup before changing groups.' : 'Choose another group above. Your current group stays connected until you confirm this change.'}</p></details> : null}
            {showingCurrentBinding ? <section className="agent-connector-fields agent-connector-section" aria-label="Member access"><h3>Member access</h3><div className="agent-connector-fields">
              <ConnectorRoomPeople facts={roomFacts} prominent onSelect={selectActor} />
              {actors?.bindingId === binding.bindingId && actors.revision === binding.revision ? actors.grants.length ? actors.grants.map(grant => <div className="agent-connector-access-member" key={grant.grantId}><p className="agent-connector-note"><strong>{roomFacts.people?.members.find(member => member.idType === grant.actor.idType && member.userId === grant.actor.userId)?.name ?? grant.actor.userId}</strong> · {currentMemberIntents.some(intent => intent.input.actor.idType === grant.actor.idType && intent.input.actor.userId === grant.actor.userId && memberReceiptState(intent) === 'unconfirmed') ? 'Last confirmed: ' : ''}{grant.state === 'revoked' ? 'Access revoked' : grant.capabilities.map(value => value === 'permission' ? 'Permission decisions' : value === 'answer' ? 'Answers' : 'Requests').join(', ')}</p>{grant.state === 'active' && grant.capabilities.includes('permission') ? <button className="agent-connector-text-action" disabled={memberFlights.has(memberKey(grant.actor.idType, grant.actor.userId))} onClick={() => revokePermission(grant)}>{currentMemberIntents.some(intent => intent.input.actor.idType === grant.actor.idType && intent.input.actor.userId === grant.actor.userId) ? 'Check original member access' : 'Revoke permission decisions'}</button> : null}</div>) : null : <p className="agent-connector-note">Member access is not confirmed.</p>}
              <p className="agent-connector-note">To send messages to this Agent, select your account above, enable Send requests and save member access. Other actions have separate permissions.</p>
              {actorId ? <p className="agent-connector-note">Selected member · <strong>{roomFacts.people?.members.find(member => member.idType === actorType && member.userId === actorId)?.name ?? actorId}</strong></p> : null}
              <details className="agent-connector-disclosure"><summary>Exact account details</summary><div className="agent-connector-fields">
                <label className="agent-connector-field">Member ID type<TextInput aria-label="Member access ID type" value={actorType} onChange={event => selectActor(event.target.value, actorId)} /></label>
                <label className="agent-connector-field">Member ID<TextInput aria-label="Member access ID" value={actorId} onChange={event => selectActor(actorType, event.target.value)} /></label>
              </div></details>
              {actorId ? <>
              <label className="agent-connector-check"><input type="checkbox" checked={actorInput} onChange={event => setActorInput(event.target.checked)} />Send requests</label><label className="agent-connector-check"><input type="checkbox" checked={actorAnswer} onChange={event => setActorAnswer(event.target.checked)} />Answer questions</label>
              <label className="agent-connector-check"><input type="checkbox" checked={actorPermission} onChange={event => setActorPermission(event.target.checked)} />Allow permission decisions</label>
              <p className="agent-connector-note">Off by default. Enabling this shares the original permission request and tool details with this group so this member can decide. Chat access and question answers do not grant permission control.</p>
              <button className="primary-button" disabled={memberFlights.has(selectedMember.current) || !actorType || !actorId || !selectedMemberIntent && !actorInput && !actorAnswer && !actorPermission} onClick={grant}>{memberFlights.has(selectedMember.current) ? 'Member access in progress…' : selectedMemberIntent ? 'Check original member access' : actorGrant ? 'Save member access' : 'Approve this member'}</button>
              </> : null}
            </div></section> : null}

          {audience && !binding ? <section className="agent-connector-section" aria-label="Group members"><ConnectorRoomPeople facts={roomFacts} prominent /></section> : null}
          {showingCurrentBinding && binding ? <ConnectorDeliveryDetails key={JSON.stringify([binding.bindingId, binding.revision])} binding={binding} /> : null}
          <details className="agent-connector-disclosure"><summary>Connection details</summary><div className="agent-connector-fields">
            {settings ? <button className="agent-connector-text-action" onClick={() => { settings.openLark({ sessionId: session.id, hostId: target.executionHostId, agentSessionId: target.agentSessionId, ...(connection ? { connectionId: connection.config.connectionId } : {}) }); onClose() }}>Application settings</button> : null}
            {connection ? <span>{connection.config.application.domain} · {connection.config.application.appId} · Revision {connection.revision}</span> : null}
            <span>Host · {target.executionHostId}</span><span>Session · {target.agentSessionId}</span>{audience ? <span>{bindingPending ? 'Requested group' : 'Group'} · {audience}</span> : null}{binding ? <>{bindingPending ? <span>Last observed group · {binding.externalConversationId}</span> : null}<span>{bindingPending ? 'Last observed Binding' : 'Binding'} · {binding.bindingId} · Revision {binding.revision}</span></> : null}
          </div></details>
          {issue ? <p role="status" className="surface-inline-error">{issue}</p> : null}
        </div><footer className="agent-connector-dialog__footer">
          {issue || relevant.length ? <button className="agent-connector-text-action" disabled={busy} onClick={() => void work(refresh)}>Refresh</button> : null}
          <button className="small-button" onClick={onClose}>{!binding && !relevant.length ? 'Cancel' : 'Close'}</button>
          {canCreate ? <button className="primary-button" disabled={busy || !connection || !availableForNewGroup(connection) || awaitingCreator || !name.trim() || !!members && !memberType.trim()} onClick={createRoom}>{busy ? 'Creating…' : 'Create group'}</button> : canConnect ? <button className="primary-button" disabled={busy || !connection?.config.enabled || !confirmed || !audience.trim() || session.nativeHandle?.kind !== 'provider'} onClick={bind}>{binding ? audience === binding.externalConversationId ? binding.state === 'paused' && sameSharing ? 'Resume sharing' : sameSharing ? 'Reconnect group' : 'Save sharing' : 'Change group' : 'Connect group'}</button> : null}
        </footer>
      </Dialog.Content></DocumentOverlayPortal>
  </Dialog.Root>
}
