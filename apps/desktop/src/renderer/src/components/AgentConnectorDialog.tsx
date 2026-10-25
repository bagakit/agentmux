import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { mintObjectId } from '@agentmux/core/object-id'
import { useWorkbenchDocument } from '../lib/workbench-document'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { useContext, useEffect, useId, useRef, useState, type ComponentProps } from 'react'
import { TextInput, Textarea } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { SelectionField } from './SelectionField'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { parseConnectionParams, type ConnectionActor, type ConnectionGrant, type ConnectionMemberAccess, type ConnectionRecord, type RoomBinding, type RoomBindingInspection, type RoomBindingOperation, type RoomBindingTarget, type RoomLinkOperation, type RoomProvisioningOperation } from '@agentmux/core/connections'
import type { AgentNativeSourceReference } from './AgentNativeSourceControls'
import { api } from '../lib/api'
import { clearConnectorRoomIntent, retainConnectorRoomIntent, useAppStore } from '../store'
import { connectorRoomDraftKey, invalidateConnectorTarget, sameConnectorTarget, type ConnectorRoomIntent } from '../lib/connector-room-intent'
import { MoteWorkfaceContext } from '../lib/mote-workface'
import { SettingsNavigation } from './SettingsNavigation'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { ResolvedAgentAvatar } from './AgentAvatar'
import { ConnectorRoomOverview, ConnectorRoomPeople, ConnectorRoomSelection, useConnectorRoomFacts } from './ConnectorRoomSelection'
import { ConnectorRoomJoinLink, ConnectorRoomJoinReceipt } from './ConnectorRoomJoinLink'
import { ConnectorCreatorInvitation, useConnectorCreatorInvitation } from './ConnectorCreatorInvitation'
import { ConnectorGroupDetails, type ConnectorGroupSection } from './ConnectorGroupDetails'
import { ConnectorDeliveryDetails } from './ConnectorDeliveryDetails'
import { ConnectorBindingNotices } from './ConnectorBindingNotices'
import { ConnectorServiceControl } from './settings/ConnectorServiceControl'
import { parseMotePreferencesReadResult, type MoteConnectionRef } from '@agentmux/core/mote-preferences'
import { connectionIdentityObservation, connectionNeedsInitialSetup, moteConnectionChoice, type AgentMoteConnectionSource } from '../lib/mote-connection-default'
import { useMoteIdentityReadings } from './settings/MoteIdentityCards'
import { linkedMoteUses } from './settings/ConnectionIdentityFacts'
import { ConnectorMemberAccess } from './ConnectorMemberAccess'
import { acknowledgeConnectorMemberDraft, connectorMemberKey, reviewConnectorMemberDraft, type ConnectorMemberDrafts } from '../lib/connector-member-draft'

const CloseIcon = semanticIconComponent('action.close')
const LoadingIcon = semanticIconComponent('status.loading')
const AgentIcon = semanticIconComponent('object.agent')
const GroupIcon = semanticIconComponent('object.team')
const CheckIcon = semanticIconComponent('action.confirm')
const SharingIcon = semanticIconComponent('conversation.mixed')

const availableForNewGroup = (record: ConnectionRecord) => record.config.enabled && !connectionNeedsInitialSetup(record)
const recordedRepliesOnly = (intent: ConnectorRoomIntent) => (intent.method === 'connection.bind' || intent.method === 'connection.binding.relink') && intent.input.scope.publication !== 'future-shared-conversation'
function shortIdentity(value: string, others: readonly string[] = []) {
  const compact = (id: string) => id.length > 18 ? id.slice(0, 6) + '…' + id.slice(-8) : id
  const label = compact(value)
  return others.some(other => other !== value && compact(other) === label) ? value : label
}

type Fact = RoomProvisioningOperation | RoomBindingOperation | RoomLinkOperation | null
export type AgentConnectorTarget = { channel?: string; hostingTarget?: ConnectionHostingTarget | null; target: RoomBindingTarget; session: AgentNativeSourceReference; name: string; connectionId?: string; bindingId?: string; mote?: AgentMoteConnectionSource
  identity?: Pick<ComponentProps<typeof ResolvedAgentAvatar>, 'providerId' | 'appearance' | 'executorId'> }
type AgentConnectorDialogProps = {
  original: AgentConnectorTarget; mode: 'create' | 'existing' | 'details'; initialSection?: 'joining' | 'members' | 'sharing' | 'sync' | 'activity' | undefined; resumeBinding?: Pick<RoomBinding, 'bindingId' | 'revision'> | undefined; onClose(): void; returnFocus(): HTMLElement | null
}
const sameHosting = (a: ConnectionHostingTarget | undefined, b: ConnectionHostingTarget) => a?.hostId === b.hostId && a.runtimeId === b.runtimeId
/** Discover only a new entry. Retained operations always name their original hosting owner. */
export function AgentConnectorDialog(props: AgentConnectorDialogProps) {
  const settings = useContext(SettingsNavigation)
  const channel = settings?.channelEntries.find(entry => entry.adapterId === props.original.channel)
  const { original, onClose, returnFocus } = props, identity = JSON.stringify([original.target, original.hostingTarget, original.connectionId, original.bindingId, original.channel])
  const [opened, setOpened] = useState<{ identity: string; original: AgentConnectorTarget } | null>(null)
  const selected = opened?.identity === identity ? opened.original : original
  const selectedKey = JSON.stringify([selected.target, selected.hostingTarget, selected.connectionId, selected.bindingId, selected.channel])
  const [read, setRead] = useState<{ key: string; owner?: ConnectionHostingTarget; issue?: string } | null>(null), [retry, setRetry] = useState(0)
  useEffect(() => {
    if (selected.hostingTarget !== undefined) return
    let live = true
    void api.connections.hostingTarget().then(owner => { if (live) setRead({ key: selectedKey, owner }) })
      .catch(error => { if (live) setRead({ key: selectedKey, issue: presentError(error) }) })
    return () => { live = false }
  }, [selectedKey, retry])
  const owner = selected.hostingTarget ?? (selected.hostingTarget === undefined && read?.key === selectedKey ? read.owner : undefined)
  if (owner) return <AgentConnectorForm key={JSON.stringify([selected.target, owner, selected.connectionId, selected.bindingId, selected.channel])} {...props} resumeBinding={opened?.identity === identity ? undefined : props.resumeBinding} original={{ ...selected, hostingTarget: owner }} onOpenOriginal={intent => {
    if (!intent.hostingTarget) return
    const { connectionId: _connection, bindingId: _binding, channel: _channel, ...source } = original
    setOpened({ identity, original: { ...source, target: structuredClone(intent.target), hostingTarget: intent.hostingTarget,
      ...('connectionId' in intent.input ? { connectionId: intent.input.connectionId } : {}),
      ...('bindingId' in intent.input ? { bindingId: intent.input.bindingId } : {}) } })
  }} onOpenDraft={() => {
    const { channel: _channel, connectionId: _connection, bindingId: _binding, ...source } = selected
    setOpened({ identity, original: source })
  }} />
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="dialog-scrim" />
    <Dialog.Content className="dialog-surface agent-connector-dialog" onCloseAutoFocus={event => { event.preventDefault(); returnFocus()?.focus({ preventScroll: true }) }}>
      <header className="agent-connector-dialog__header"><div><Dialog.Title>{channel ? `${channel.title} connections` : 'Connect a group'}</Dialog.Title><Dialog.Description>{original.name}</Dialog.Description></div><button className="icon-button" aria-label="Close group setup" onClick={onClose}><CloseIcon size={15} /></button></header>
      <div className="agent-connector-dialog__body"><p role="status" className="agent-connector-note">{selected.hostingTarget === null ? 'The original bot hosting owner is unconfirmed. Original requests are kept; no request was sent to another Host.' : read?.key === selectedKey && read.issue ? 'Bot hosting could not be confirmed. ' + read.issue : 'Confirming bot hosting…'}</p></div>
      <footer className="agent-connector-dialog__footer">{selected.hostingTarget === undefined && read?.key === selectedKey && read.issue ? <button className="small-button" onClick={() => { setRead(null); setRetry(value => value + 1) }}>Check bot hosting</button> : null}<button className="small-button" onClick={onClose}>Close</button>{channel && settings ? <button className="agent-connector-text-action" onClick={() => { settings.open(channel.section); onClose() }}>Channel settings</button> : null}</footer>
    </Dialog.Content></DocumentOverlayPortal></Dialog.Root>
}
/** A bounded form over original public owners. It retains submitted correlations, never another receipt store. */
function AgentConnectorForm({ original, mode: initialMode, initialSection, resumeBinding, onClose, returnFocus, onOpenOriginal, onOpenDraft }: Omit<AgentConnectorDialogProps, 'original'> & {
  original: AgentConnectorTarget & { hostingTarget: ConnectionHostingTarget }; onOpenOriginal(intent: ConnectorRoomIntent): void; onOpenDraft(): void
}) {
  const ownerDocument = useWorkbenchDocument()
  const { target, session, hostingTarget } = original, identity = JSON.stringify([target, hostingTarget]), fieldId = useId()
  const draftKey = connectorRoomDraftKey(target, hostingTarget, original.channel)
  const earlierDraft = useAppStore(state => original.channel ? state.connectorRoomDrafts[connectorRoomDraftKey(target, hostingTarget)] : undefined)
  const unqualifiedDraft = useAppStore(state => state.connectorRoomDrafts[connectorRoomDraftKey(target)])
  const [savedDraft] = useState(() => useAppStore.getState().connectorRoomDrafts[draftKey])
  const [mode, setMode] = useState(initialMode === 'details' ? initialMode : savedDraft?.mode ?? initialMode)
  const [section, setSection] = useState<ConnectorGroupSection>('overview')
  const sectionToFocus = useRef<string | null>(null)
  const [changingGroup, setChangingGroup] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false), [selectedBindingId, setSelectedBindingId] = useState(original.bindingId ?? savedDraft?.bindingId ?? '')
  const mote = useContext(MoteWorkfaceContext), settings = useContext(SettingsNavigation)
  const [connections, setConnections] = useState<ConnectionRecord[]>([]), [bindings, setBindings] = useState<RoomBinding[]>([])
  const [loaded, setLoaded] = useState(false)
  const entryConsumed = useRef(false)
  const [moteDefault, setMoteDefault] = useState<{ status: 'loading' | 'ready' | 'unconfirmed'; ref: MoteConnectionRef | null; issue: string | null }>(() =>
    original.mote && 'target' in original.mote ? { status: 'loading', ref: null, issue: null }
      : { status: original.mote ? 'unconfirmed' : 'ready', ref: null, issue: original.mote && 'issue' in original.mote ? original.mote.issue : null })
  const initialized = useRef(!!original.connectionId || !original.bindingId && !!savedDraft?.connectionId), explicitlySelected = useRef(false)
  const [connectionId, setConnectionId] = useState(original.connectionId ?? (original.bindingId ? '' : savedDraft?.connectionId) ?? ''), [name, setName] = useState(savedDraft?.name ?? original.name + ' · AgentMux')
  const [group, setGroup] = useState(savedDraft?.group ?? ''), [members, setMembers] = useState(savedDraft?.members ?? ''), [memberType, setMemberType] = useState(savedDraft?.memberType ?? '')
  const [scope, setScope] = useState<'mentions-and-replies' | 'all-messages'>(savedDraft?.scope ?? (initialMode === 'create' ? 'all-messages' : 'mentions-and-replies')), [confirmed, setConfirmed] = useState(false)
  const [actorId, setActorId] = useState(savedDraft?.actorId ?? ''), [actorType, setActorType] = useState(savedDraft?.actorType ?? '')
  const [memberDrafts, setMemberDrafts] = useState<ConnectorMemberDrafts>(savedDraft?.memberDrafts ?? {})
  const [facts, setFacts] = useState<Record<string, Fact>>({}), [issue, setIssue] = useState(''), [busy, setBusy] = useState(false)
  const [actors, setActors] = useState<{ bindingId: string; revision: number; grants: ConnectionGrant[]; access: ConnectionMemberAccess[] | null } | null>(null)
  const memberReadOrder = useRef(0)
  const [memberFlights, setMemberFlights] = useState<Map<string, 'checking' | 'saving'>>(() => new Map())
  const memberFlight = useRef(new Map<string, 'checking' | 'saving'>())
  const intents = useAppStore(state => state.connectorRoomIntents)
  const flight = useRef(false), epoch = useRef({}), content = useRef<HTMLDivElement>(null), initialFocus = useRef(true)
  const connection = connections.find(item => item.config.connectionId === connectionId)
  const channel = settings?.channelEntries.find(entry => entry.adapterId === original.channel)
  const inChannel = (record: ConnectionRecord) => !original.channel || record.config.adapterId === original.channel
  const defaultRef = moteDefault.ref && (!original.channel || channel?.domains.includes(moteDefault.ref.application.domain)) ? moteDefault.ref : null
  const defaultChoice = defaultRef ? moteConnectionChoice(defaultRef, connections) : null
  const creationUnsupported = connection?.capabilities?.roomCreation === false
  const identityReadings = useMoteIdentityReadings(true, 0, hostingTarget)
  const relevant = Object.values(intents).filter(intent => { const input = intent.input; return sameConnectorTarget(intent.target, target) && sameHosting(intent.hostingTarget, hostingTarget) && ('connectionId' in input ? input.connectionId === connectionId : bindings.some(binding => binding.bindingId === input.bindingId && binding.connectionId === connectionId)) })
  const otherOriginals = Object.values(intents).filter(intent => {
    if (!sameConnectorTarget(intent.target, target)) return false
    if (!sameHosting(intent.hostingTarget, hostingTarget)) return true
    const input = intent.input
    if (!original.channel) return false
    const id = 'connectionId' in input ? input.connectionId : bindings.find(binding => binding.bindingId === input.bindingId)?.connectionId
    return !connections.some(record => record.config.connectionId === id && inChannel(record))
  })
  const roomIntent = relevant.find(intent => intent.method === 'connection.room.create')
  const room = roomIntent ? facts[roomIntent.input.operationId] : null
  const created = room && 'creation' in room && room.creation.state === 'created' ? room.creation.externalConversationId : null
  const binding = bindings.find(item => item.connectionId === connectionId && item.state !== 'detached' && (!selectedBindingId || item.bindingId === selectedBindingId))
  const recentApplied = Object.values(facts).reverse().find((fact): fact is Extract<RoomBindingOperation, { state: 'applied' }> => !!fact && 'state' in fact && fact.state === 'applied' && 'action' in fact && fact.action !== 'grant')
  const detached = !binding && recentApplied?.binding.state === 'detached' && recentApplied.binding.connectionId === connectionId ? recentApplied.binding : null
  const memberKey = (actor: ConnectionActor) => binding ? connectorMemberKey(binding, actor) : ''
  const activeAudience = useRef(''); activeAudience.current = JSON.stringify([binding?.bindingId, binding?.revision])
  const currentGrants = actors && binding && actors.bindingId === binding.bindingId && actors.revision === binding.revision
    ? actors.grants.filter(grant => grant.actor.application.domain === binding.application.domain && grant.actor.application.appId === binding.application.appId) : []
  const creatingGroup = (mode === 'create' || !!roomIntent) && !binding && !detached
  const bindingIntent = relevant.find(intent => (intent.method === 'connection.bind' || intent.method === 'connection.binding.relink') && !recordedRepliesOnly(intent))
  const bindingPending = !!bindingIntent
  const showingCurrentBinding = !!binding && !changingGroup && !bindingPending
  const links = relevant.filter((intent): intent is Extract<ConnectorRoomIntent, { method: 'connection.room.link.create' }> => intent.method === 'connection.room.link.create')
  // Explicit submitted replacement references choose the head; presentation order is not authority.
  const replacedLinks = new Set(links.filter(next => links.some(previous => previous.input.operationId === next.replacesOperationId && previous.input.externalConversationId === next.input.externalConversationId)).map(next => next.replacesOperationId))
  const linkHeads = links.filter(intent => !replacedLinks.has(intent.input.operationId))
  const originalLink = linkHeads.length === 1 ? linkHeads[0] : undefined
  const restoredGroup = !group && originalLink?.method === 'connection.room.link.create' ? originalLink.input.externalConversationId : group
  const audience = bindingIntent && 'externalConversationId' in bindingIntent.input ? bindingIntent.input.externalConversationId : creatingGroup ? created ?? '' : binding && !changingGroup ? binding.externalConversationId : detached?.externalConversationId ?? restoredGroup
  const audienceLinks = links.filter(intent => intent.input.externalConversationId === audience)
  const audienceHeads = linkHeads.filter(intent => intent.input.externalConversationId === audience)
  const linkIntent = audienceHeads.length === 1 ? audienceHeads[0] : undefined
  const linkFact = linkIntent ? facts[linkIntent.input.operationId] : null
  const linkOperation = linkFact && 'input' in linkFact && 'externalConversationId' in linkFact.input ? linkFact as RoomLinkOperation : null
  useEffect(() => {
    if (!initialFocus.current || !connection || mode !== 'existing') return
    initialFocus.current = false
    const close = content.current?.querySelector('[aria-label="Close group setup"]')
    if (ownerDocument.activeElement === close) content.current?.querySelector<HTMLElement>('[aria-label="Existing group"]')?.focus({ preventScroll: true })
  }, [connection, mode])
  const approvedMembers = binding && actors?.bindingId === binding.bindingId && actors.revision === binding.revision && actors.access !== null
    ? actors.access.filter(item => item.effective?.state === 'active' && item.effective.capabilities.includes('input')).length : null
  const currentMemberIntents = relevant.filter((intent): intent is Extract<ConnectorRoomIntent, { method: 'connection.grant' | 'connection.binding.member.inherit' }> => currentGrantIntent(intent))
  const unconfirmedMembers = currentMemberIntents.some(intent => memberReceiptState(intent) === 'unconfirmed')
  function memberReceiptState(intent: Extract<ConnectorRoomIntent, { method: 'connection.grant' | 'connection.binding.member.inherit' }>) {
    const fact = facts[intent.input.operationId]
    if (fact && 'state' in fact && (fact.state === 'applied' || fact.state === 'refused')) return fact.state
    return !fact && intent.phase === 'not-dispatched' ? 'not-dispatched' : 'unconfirmed'
  }
  const restoredAudience = useRef('')
  useEffect(() => {
    if (!loaded) return
    const audienceKey = JSON.stringify([connectionId, binding?.bindingId ?? null, binding?.revision ?? null])
    if (restoredAudience.current === audienceKey) return
    const restore = !restoredAudience.current && savedDraft?.connectionId === connectionId && savedDraft.bindingId === (binding?.bindingId ?? null) && savedDraft.bindingRevision === (binding?.revision ?? null)
    restoredAudience.current = audienceKey
    // Matching drafts seeded this form before the read. A slow read must not overwrite later typing.
    if (restore) return
    setGroup(binding?.externalConversationId ?? '')
    setScope(binding?.scope.input ?? (mode === 'create' ? 'all-messages' : 'mentions-and-replies'))
    setConfirmed(false); setChangingGroup(false); setDisconnecting(false)
    setActorId(''); setActorType('')
  }, [loaded, connectionId, binding?.bindingId, binding?.revision])
  useEffect(() => {
    if (!loaded) return
    const draft = { connectionId, bindingId: binding?.bindingId ?? null, bindingRevision: binding?.revision ?? null, mode, name, group, members, memberType, scope, actorId, actorType, memberDrafts }
    useAppStore.setState(state => ({ connectorRoomDrafts: { ...state.connectorRoomDrafts, [draftKey]: draft } }))
  }, [loaded, connectionId, binding?.bindingId, binding?.revision, mode, name, group, members, memberType, scope, actorId, actorType, memberDrafts, draftKey])
  const frozenRoom = roomIntent?.method === 'connection.room.create' ? roomIntent.input : null
  const creatorInvitation = useConnectorCreatorInvitation(connection, !!connection, hostingTarget)
  const awaitingCreator = creatorInvitation.pending && creatorInvitation.included
  const visibleActors: ConnectionActor[] = showingCurrentBinding && binding ? [
    ...currentGrants.map(grant => grant.actor),
    ...(actors?.bindingId === binding.bindingId && actors.revision === binding.revision ? actors.access ?? [] : []).map(item => item.actor),
    ...Object.values(memberDrafts).filter(draft => draft.bindingId === binding.bindingId && draft.bindingRevision === binding.revision).map(draft => draft.actor),
    ...currentMemberIntents.map(intent => intent.input.actor),
    ...(creatorInvitation.creator ? [{ application: binding.application, ...creatorInvitation.creator }] : []),
    ...(actorType && actorId ? [{ application: binding.application, idType: actorType, userId: actorId }] : [])
  ] : []
  const roomFacts = useConnectorRoomFacts(connection, audience, hostingTarget, visibleActors, showingCurrentBinding ? section === 'members' : !!audience && !binding && !detached)
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
    memberReadOrder.current++
    setActors(previous => {
      const grants = previous?.bindingId === source.bindingId && previous.revision === source.revision ? previous.grants : [], old = grants.find(value => value.grantId === grant.grantId)
      return old && old.revision > grant.revision ? previous : { bindingId: source.bindingId, revision: source.revision, grants: [...grants.filter(value => value.grantId !== grant.grantId), grant], access: null }
    })
  }
  async function memberWork(key: string, action: () => Promise<void>, activity: 'checking' | 'saving' = 'checking') {
    if (memberFlight.current.has(key)) return
    const token = epoch.current, audience = activeAudience.current
    memberFlight.current.set(key, activity); setMemberFlights(new Map(memberFlight.current)); setIssue('')
    try { await action() } catch (error) { if (epoch.current === token && activeAudience.current === audience) setIssue('Member access is not confirmed. Check its original status. ' + presentError(error)) }
    finally { memberFlight.current.delete(key); if (epoch.current === token) setMemberFlights(new Map(memberFlight.current)) }
  }
  async function inspect(intent: ConnectorRoomIntent) {
    if (!sameHosting(intent.hostingTarget, hostingTarget)) throw new Error('The original bot hosting owner is unconfirmed in this view. Keep the original request and open its hosting owner.')
    const token = epoch.current
    let value: Fact
    if (intent.method === 'connection.room.create') value = (await api.connections.call('connection.room.inspect', { operationId: intent.input.operationId }, intent.hostingTarget)).operation
    else if (intent.method === 'connection.room.link.create') value = (await api.connections.call('connection.room.link.inspect', { operationId: intent.input.operationId }, intent.hostingTarget)).operation
    else {
      const read = await api.connections.call('connection.binding.inspect', { operationId: intent.input.operationId }, intent.hostingTarget)
      if (epoch.current !== token) return read.operation
      value = read.operation
      if (value?.state === 'applied') {
        observeBinding(value.binding.bindingId, read.current)
        memberReadOrder.current++
        const source = value.binding
        if (intent.method === 'connection.grant') setMemberDrafts(current => acknowledgeConnectorMemberDraft(current, source, intent.input.actor, intent.input.capabilities))
        if (intent.method === 'connection.binding.member.inherit') setMemberDrafts(current => acknowledgeConnectorMemberDraft(current, source, intent.input.actor, null, 'application'))
        if (currentGrantIntent(intent)) void readMemberGrants(source).catch(error => { if (epoch.current === token) setIssue(presentError(error)) })
      }
    }
    if (epoch.current !== token) return value
    setFacts(previous => ({ ...previous, [intent.input.operationId]: value }))
    if (value && 'state' in value && value.state === 'applied') { await clearConnectorRoomIntent(intent.input.operationId); invalidateConnectorTarget(target) }
    return value
  }
  async function refresh() {
    const token = epoch.current
    const [apps, audience] = await Promise.allSettled([api.connections.call('connection.ls', {}, hostingTarget), api.connections.call('connection.binding.ls', { executionHostId: target.executionHostId, agentSessionId: target.agentSessionId }, hostingTarget)])
    if (epoch.current !== token) return
    if (apps.status === 'fulfilled') setConnections(apps.value.connections)
    if (audience.status === 'fulfilled') setBindings(audience.value.bindings)
    // A failed binding read must not hide otherwise readable saved bots. Automatic
    // initialization still waits for the original bindings; manual choice stays available.
    setLoaded(apps.status === 'fulfilled' && audience.status === 'fulfilled')
    if (apps.status === 'rejected' || audience.status === 'rejected') throw new Error([apps, audience].flatMap(result => result.status === 'rejected' ? [presentError(result.reason)] : []).join(' '))
    for (const intent of Object.values(useAppStore.getState().connectorRoomIntents)) if (epoch.current === token && sameConnectorTarget(intent.target, target) && sameHosting(intent.hostingTarget, hostingTarget)) await inspect(intent)
  }
  useEffect(() => { const token = {}; epoch.current = token; void refresh().catch(error => { if (epoch.current === token) setIssue(presentError(error)) }); return () => { epoch.current = {} } }, [identity])
  useEffect(() => {
    const source = original.mote
    if (!source || !('target' in source) || original.connectionId || mode === 'details') return
    const token = epoch.current, input = { kind: 'connection' as const, target: source.target }
    void api.motePreferences.read(input, hostingTarget).then(value => {
      if (epoch.current !== token) return
      const saved = parseMotePreferencesReadResult(value, input)
      setMoteDefault({ status: saved.status, ref: saved.values?.connection ?? null, issue: saved.issue })
    }).catch(error => { if (epoch.current === token) setMoteDefault({ status: 'unconfirmed', ref: null, issue: presentError(error) }) })
  }, [identity])
  useEffect(() => {
    if (initialized.current || !loaded) return
    if (original.bindingId) {
      const originalBinding = bindings.find(binding => binding.bindingId === original.bindingId)
      if (!originalBinding) return
      initialized.current = true; setConnectionId(originalBinding.connectionId); return
    }
    const retained = Object.values(intents).filter(intent => sameConnectorTarget(intent.target, target) && sameHosting(intent.hostingTarget, hostingTarget))
    const channelConnections = connections.filter(inChannel)
    const originalIds = new Set([...bindings.map(item => item.connectionId), ...retained.flatMap(intent => 'connectionId' in intent.input ? [intent.input.connectionId] : [])].filter(id => channelConnections.some(item => item.config.connectionId === id)))
    if (originalIds.size > 1) return
    let selected = originalIds.size === 1 ? [...originalIds][0] : undefined
    if (!selected) {
      if (moteDefault.status !== 'ready') return
      if (defaultRef) {
        const choice = defaultChoice!
        if (choice.issue || connectionNeedsInitialSetup(choice.record!) || !inChannel(choice.record!)) return
        selected = choice.record!.config.connectionId
      } else {
        const enabled = connections.filter(inChannel).filter(availableForNewGroup)
        selected = enabled.length === 1 ? enabled[0]!.config.connectionId : undefined
      }
    }
    initialized.current = true
    if (selected) setConnectionId(selected)
  }, [loaded, connections, bindings, moteDefault, intents])
  async function readMemberGrants(source: RoomBinding, accepts = () => true): Promise<RoomBindingInspection | null> {
    const token = epoch.current, order = ++memberReadOrder.current
    const inspected = await api.connections.call('connection.binding.inspect', { bindingId: source.bindingId }, hostingTarget)
    if (!accepts() || epoch.current !== token || order !== memberReadOrder.current || activeAudience.current !== JSON.stringify([source.bindingId, source.revision])) return null
    observeBinding(source.bindingId, inspected.current)
    if (!inspected.binding || inspected.binding.bindingId !== source.bindingId || inspected.binding.revision !== source.revision || inspected.current?.revision !== source.revision || !sameConnectorTarget(inspected.binding, source) || inspected.binding.application.domain !== source.application.domain || inspected.binding.application.appId !== source.application.appId) return null
    // This is a complete current projection. Old immutable grant history must not recreate an inherited head.
    setActors({ bindingId: source.bindingId, revision: source.revision, grants: inspected.grants, access: inspected.access ?? null })
    return inspected
  }
  useEffect(() => {
    if (!binding) return
    const token = epoch.current
    let active = true
    void readMemberGrants(binding, () => active).catch(error => { if (active && epoch.current === token) setIssue(presentError(error)) })
    return () => { active = false }
  }, [binding?.bindingId, binding?.revision])
  async function work(action: () => Promise<void>) {
    if (flight.current) return
    flight.current = true; setBusy(true); setIssue('')
    const token = epoch.current
    try { await action() } catch (error) { if (epoch.current === token) setIssue('Setup is not confirmed. Check the status of this setup. ' + presentError(error)) }
    finally { flight.current = false; if (epoch.current === token) setBusy(false) }
  }
  async function execute(input: ConnectorRoomIntent, explicitPending = false) {
    const token = epoch.current
    const intent = structuredClone(input)
    const retained = useAppStore.getState().connectorRoomIntents[intent.input.operationId]
    if (retained && (!sameHosting(retained.hostingTarget, hostingTarget) || !sameHosting(intent.hostingTarget, hostingTarget))) throw new Error('Keep the original request on its original bot hosting owner.')
    if (!retained) intent.hostingTarget = structuredClone(hostingTarget)
    if (recordedRepliesOnly(intent)) { await inspect(intent); return }
    if (retained?.phase === 'may-have-dispatched' && !explicitPending) { await inspect(retained); return }
    const saved = await retainConnectorRoomIntent({ ...intent, phase: 'not-dispatched' })
    if (!saved.localStorageWritten) throw new Error('The original intent could not be saved. No request was sent; save this same intent before continuing.')
    const dispatch = await retainConnectorRoomIntent({ ...intent, phase: 'may-have-dispatched' })
    if (!dispatch.localStorageWritten) {
      // This producer has not called the transport; only this positively known no-dispatch can reset its phase.
      await retainConnectorRoomIntent({ ...intent, phase: 'not-dispatched' })
      throw new Error('Saving the original dispatch intent failed. No request was sent.')
    }
    const value = await api.connections.call(intent.method, parseConnectionParams(intent.method, intent.input), intent.hostingTarget)
    if (epoch.current !== token) return
    setFacts(previous => ({ ...previous, [intent.input.operationId]: value }))
    if ('state' in value && value.state === 'applied') {
      if (value.grant) acceptGrant(value.grant, value.binding); else if (intent.method !== 'connection.binding.member.inherit') setSelectedBindingId(value.binding.bindingId)
      if (intent.method === 'connection.grant') setMemberDrafts(current => acknowledgeConnectorMemberDraft(current, value.binding, intent.input.actor, intent.input.capabilities))
      if (intent.method === 'connection.binding.member.inherit') {
        memberReadOrder.current++
        setMemberDrafts(current => acknowledgeConnectorMemberDraft(current, value.binding, intent.input.actor, null, 'application'))
        setActors(previous => previous && previous.bindingId === value.binding.bindingId ? { ...previous, access: null } : previous)
      }
      observeBinding(value.binding.bindingId, value.binding); invalidateConnectorTarget(target); await clearConnectorRoomIntent(intent.input.operationId)
      if (currentGrantIntent(intent)) void readMemberGrants(value.binding).catch(error => { if (epoch.current === token) setIssue(presentError(error)) })
    }
    // An exact grant receipt already updates its member. Other original queries cannot hold that write open.
    if (intent.method !== 'connection.grant' && intent.method !== 'connection.binding.member.inherit') await refresh()
    if (epoch.current === token && 'creation' in value && value.creation.state === 'not-applied' && ['connection-unavailable', 'connection-revised'].includes(value.creation.reason))
      setIssue('The bot configuration changed before this request. No group was created. Review the current bot settings and keep this original receipt.')
  }
  function createRoom() {
    if (!connection || creationUnsupported || !availableForNewGroup(connection) || roomIntent || binding || awaitingCreator || !name.trim() || members && !memberType.trim()) return
    void work(() => execute({ method: 'connection.room.create', target: structuredClone(target), phase: 'not-dispatched', input: {
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
  function bind(completeOriginal = false) {
    const native = session.nativeHandle
    if (!connection || !confirmed && !completeOriginal || native?.kind !== 'provider' || !audience.trim()) return
    if (completeOriginal && (!binding || binding.scope.publication !== 'future-native-user-facing' || changingGroup || audience !== binding.externalConversationId)) return
    const previous = relevant.find(intent => (intent.method === 'connection.bind' || intent.method === 'connection.binding.relink') && !recordedRepliesOnly(intent))
    if (previous) { void work(async () => { await inspect(previous) }); return }
    const input = { ...target, operationId: mintObjectId(), bindingId: binding?.bindingId ?? mintObjectId(), connectionId,
      expectedConnectionRevision: connection.revision, externalConversationId: audience,
      scope: { input: completeOriginal ? binding!.scope.input : scope, publication: 'future-shared-conversation' as const },
      ...(binding && audience === binding.externalConversationId && binding.inputTarget ? { inputTarget: binding.inputTarget } : {}),
      expectedSource: { providerId: native.providerId, nativeSessionId: native.sessionId } }
    void work(() => execute(binding ? { method: 'connection.binding.relink', input: { ...input, expectedRevision: binding.revision }, target, phase: 'not-dispatched' } : { method: 'connection.bind', input, target, phase: 'not-dispatched' }))
  }
  function lifecycle(method: 'connection.binding.pause' | 'connection.binding.resume' | 'connection.binding.detach', originalBinding = binding) {
    if (!originalBinding) return
    const previous = relevant.find(intent => intent.method === method && intent.input.bindingId === originalBinding.bindingId)
    if (previous) {
      void work(async () => { if (previous.phase === 'not-dispatched') await execute(previous, true); else await inspect(previous) })
      return
    }
    void work(() => execute({ method, target, phase: 'not-dispatched', input: { operationId: mintObjectId(), bindingId: originalBinding.bindingId, expectedRevision: originalBinding.revision } }))
  }
  function currentGrantIntent(intent: ConnectorRoomIntent): boolean {
    return (intent.method === 'connection.grant' || intent.method === 'connection.binding.member.inherit') && !!binding && intent.input.bindingId === binding.bindingId &&
      intent.input.expectedBindingRevision === binding.revision && intent.input.actor.application.domain === binding.application.domain && intent.input.actor.application.appId === binding.application.appId
  }
  function grant(actor: ConnectionActor, capabilities: ConnectionGrant['capabilities'], baseline: ConnectionGrant | null, source: 'room' | 'application') {
    if (!binding || binding.state !== 'active') return
    const previous = currentMemberIntents.find(intent => intent.input.actor.idType === actor.idType && intent.input.actor.userId === actor.userId && !['applied', 'refused'].includes(memberReceiptState(intent)))
    const key = memberKey(actor)
    if (previous) { void memberWork(key, async () => { await inspect(previous) }); return }
    if (source === 'application') {
      if (!baseline) return
      void memberWork(key, () => execute({ method: 'connection.binding.member.inherit', target, phase: 'not-dispatched', input: { operationId: mintObjectId(), bindingId: binding.bindingId, expectedBindingRevision: binding.revision, actor, expectedGrant: { grantId: baseline.grantId, revision: baseline.revision } } }), 'saving')
      return
    }
    void memberWork(key, () => execute({ method: 'connection.grant', target, phase: 'not-dispatched', input: {
      operationId: mintObjectId(), bindingId: binding.bindingId, expectedBindingRevision: binding.revision,
      grantId: baseline?.grantId ?? mintObjectId(), expectedRevision: baseline?.revision ?? null, actor,
      capabilities, state: capabilities.length ? 'active' : 'revoked'
    } }), 'saving')
  }
  function reviewMember(actor: ConnectionActor, draftKey: string, refused?: Extract<ConnectorRoomIntent, { method: 'connection.grant' | 'connection.binding.member.inherit' }>) {
    if (!binding) return
    const source = binding
    void memberWork(memberKey(actor), async () => {
      const inspected = await readMemberGrants(source)
      if (!inspected) return
      const local = inspected.access?.find(value => JSON.stringify(value.actor) === JSON.stringify(actor))?.local
      const baseline = local ? local.kind === 'none' ? null : local.grant : inspected.grants.find(grant => JSON.stringify(grant.actor) === JSON.stringify(actor))
      if (baseline === undefined && inspected.access === undefined) throw new Error('The original local decision is not confirmed. Your draft and original request are kept.')
      const reviewed = currentMemberIntents.filter(intent => intent.input.actor.idType === actor.idType && intent.input.actor.userId === actor.userId && memberReceiptState(intent) === 'refused').map(intent => intent.input.operationId)
      setMemberDrafts(current => reviewConnectorMemberDraft(current, source, actor, baseline ?? null, draftKey, reviewed, refused?.method === 'connection.grant' ? refused.input.capabilities : refused ? [] : undefined, refused?.method === 'connection.binding.member.inherit' ? 'application' : 'room'))
    })
  }
  function newContext() {
    if (!mote) return
    const id = useAppStore.getState().openLauncher({ workspaceId: mote.workspace.id, topicId: mote.topic.id, reveal: false })
    const group = id ? useAppStore.getState().layouts[mote.workspace.id]?.groups.find(item => item.tabOrder.includes(id)) : undefined
    if (id && group) { mote.selectTab(id, group.id); onClose() }
    else setIssue('The original Mote discussion entry is unavailable. Your Agent and draft are kept.')
  }
  function showSection(destination: 'members' | 'sharing' | 'joining' | 'sync' | 'activity') {
    sectionToFocus.current = destination
    setSection(destination === 'sync' || destination === 'activity' ? 'overview' : destination)
    // Also schedules a render when the destination is already selected.
    setSectionRequest(value => value + 1)
  }
  const [sectionRequest, setSectionRequest] = useState(0)
  useEffect(() => {
    const destination = sectionToFocus.current
    if (!destination) return
    sectionToFocus.current = null
    const node = content.current?.querySelector<HTMLElement>(`[data-connection-section="${destination}"]`)
    for (let parent = node?.parentElement; parent && parent !== content.current; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.setAttribute('open', '')
    }
    node?.scrollIntoView({ block: 'nearest' }); node?.focus({ preventScroll: true })
  }, [section, sectionRequest])
  const sameFilters = !!binding && audience === binding.externalConversationId && scope === binding.scope.input
  const connectedAudiences = bindings.filter(item => item.state !== 'detached')
  const audienceReview = <div aria-label="Groups sharing this conversation" className="agent-connector-fields">
    <p className="agent-connector-note">One conversation across App and every connected group. Members’ messages and public replies are shared across these audiences. Use a separate Agent for separate context.</p>
    {!loaded ? <p className="agent-connector-note">The complete group list is not confirmed. Earlier observations and original requests are kept.</p> : null}
    <div className="agent-connector-audiences"><span><strong>AgentMux App</strong><small>This Agent’s conversation</small></span>{connectedAudiences.map(item => <span key={item.bindingId} data-sharing-audience={item.bindingId} title={item.externalConversationId}>
      <strong>{item.externalConversationId === audience && item.connectionId === connectionId ? roomFacts.room?.room?.name ?? 'Current group' : connections.find(app => app.config.connectionId === item.connectionId)?.config.label ?? 'Connected group'}</strong>
      <small>{shortIdentity(item.externalConversationId)} · {item.state === 'paused' ? 'Paused' : item.scope.publication === 'future-native-user-facing' ? 'User messages not connected' : 'Complete conversation'}</small></span>)}
      {audience && !connectedAudiences.some(item => item.connectionId === connectionId && item.externalConversationId === audience) ? <span data-sharing-audience="proposed" title={audience}><strong>{roomFacts.room?.room?.name ?? 'Proposed group'}</strong><small>{connection?.config.label ?? connectionId} · {shortIdentity(audience)}</small></span> : null}</div>
  </div>
  const sharing = <section className="agent-connector-fields agent-connector-section" aria-label="Sharing options" data-connection-section="sharing" tabIndex={-1}>{!showingCurrentBinding ? <h3><SharingIcon size={16} />{binding ? 'Sharing options' : 'Share with this group'}</h3> : null}
    <p className="agent-connector-note">New App user messages, group messages, public Agent replies, questions and resources belong to the same conversation. Earlier private history stays local.</p>
    {binding?.scope.publication !== 'future-native-user-facing' || changingGroup ? <details className="agent-connector-disclosure" open={!binding || changingGroup}><summary>Connected audiences · App and {connectedAudiences.length} {connectedAudiences.length === 1 ? 'group' : 'groups'}</summary>{audienceReview}</details> : null}
    <div className="agent-connector-field"><label htmlFor={fieldId + '-scope'}>Group → conversation</label><p className="agent-connector-note">Only members with Send requests can trigger the Agent.</p><SelectionField id={fieldId + '-scope'} label="Group input scope" value={scope} disabled={busy} onValueChange={value => { if (value === 'mentions-and-replies' || value === 'all-messages') { setScope(value); setConfirmed(false) } }} options={[{ value: 'mentions-and-replies', label: 'Respond to @mentions and replies' }, { value: 'all-messages', label: 'Respond to every authorized message' }]} /></div>
    <details className="agent-connector-disclosure"><summary>Context and sharing boundaries</summary><div className="agent-connector-fields">
      <p className="agent-connector-note">New group messages are recorded once. Terminal input without verified original user text stays local. Delivery details show missing sources or attachments.</p>
      {binding && approvedMembers ? <p className="agent-connector-note">Changing message filters keeps saved member access. A different group, bot identity or Agent requires a fresh review.</p> : null}
      <p className="agent-connector-note">This Agent may use its existing private context in replies. A separate discussion keeps contexts apart.</p>
      {mote ? <button className="agent-connector-text-action" onClick={newContext}>Start a separate discussion</button> : <p className="agent-connector-note">For separate context, start a new Agent in Mote before connecting it.</p>}
    </div></details>
    {!binding || changingGroup || !sameFilters ? <p className="agent-connector-note">This Agent may use its existing private context in replies to the group.</p> : null}
    {!binding || changingGroup || !sameFilters ? <label className="agent-connector-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />Share the complete new conversation with this group.</label> : null}
    {session.nativeHandle?.kind !== 'provider' ? <p role="status" className="agent-connector-note">The Agent’s conversation source is not confirmed yet. You can keep working locally.</p> : null}
  </section>
  const applicationPeers = (record: ConnectionRecord) => connections.filter(item => item.config.application.domain === record.config.application.domain && item.config.application.appId === record.config.application.appId)
  const applicationLabel = (record: ConnectionRecord) => {
    const { application, connectionId } = record.config, peers = applicationPeers(record)
    const uses = linkedMoteUses(record, identityReadings)
    return (uses.length ? uses.join(', ') + ' · ' : '') + (settings?.channelPresentation(application, record.config.adapterId)?.title ?? application.domain) + ' · ' + shortIdentity(application.appId, connections.map(item => item.config.application.appId)) +
      (peers.length > 1 ? ' · Connection ' + shortIdentity(connectionId, peers.map(item => item.config.connectionId)) : '')
  }
  const applicationChoice = <SelectionField id={fieldId + '-application'} label="Group application" value={connectionId} disabled={busy}
    triggerLabel={connection ? 'Change' : 'Choose'} className="agent-connector-source__change" menuClassName="agent-connector-application-menu"
    onValueChange={value => { initialized.current = true; explicitlySelected.current = true; setSelectedBindingId(''); setConnectionId(value); setGroup(''); setConfirmed(false) }} options={[{ value: '', label: 'Choose an application…' }, ...connections.filter(inChannel).filter(availableForNewGroup).map(item => ({ value: item.config.connectionId, label: item.config.label, description: applicationLabel(item) }))]} />
  const identityObservation = connection ? connectionIdentityObservation(connection) : null
  const setupPending = connections.filter(inChannel).filter(connectionNeedsInitialSetup)
  const currentSetupPending = connection && connectionNeedsInitialSetup(connection) ? connection
    : defaultChoice?.record && connectionNeedsInitialSetup(defaultChoice.record) ? defaultChoice.record : null
  const otherSetupPending = setupPending.filter(item => item.config.connectionId !== currentSetupPending?.config.connectionId)
  const setupRecovery = (item: ConnectionRecord) => <p className="agent-connector-note" key={item.config.connectionId} data-incomplete-application>{item.config.label} · {connectionIdentityObservation(item).label}. {settings ? <button type="button" className="agent-connector-text-action" onClick={() => { settings.openChannel({ sessionId: session.id, hostId: target.executionHostId, hostingTarget, agentSessionId: target.agentSessionId, connection: item.config }); onClose() }}>Continue setup</button> : 'Continue its original setup in application settings.'}</p>
  const application = <div className="agent-connector-application">
    <div className="agent-connector-source"><AgentIcon size={16} aria-hidden="true" /><div className="agent-connector-source__identity"><strong>{connection?.config.label ?? (connectionId ? 'Saved application' : 'Choose an application')}</strong>{connection ? <small title={connection.config.application.domain + ' · ' + connection.config.application.appId + ' · ' + connection.config.connectionId}>{applicationLabel(connection)}</small> : null}</div>{applicationChoice}</div>
    {connection && !connection.config.enabled ? <div className="agent-connector-service" role="status"><strong>This bot is disabled</strong><p className="agent-connector-note">Its original groups and requests are kept. Enable this bot in settings or choose another bot for a new group.</p>{settings ? <button type="button" className="agent-connector-text-action" onClick={() => { settings.openChannel({ sessionId: session.id, hostId: target.executionHostId, hostingTarget, agentSessionId: target.agentSessionId, connection: connection.config }); onClose() }}>Open bot settings</button> : null}</div> : null}
    {identityObservation ? <details className="agent-connector-disclosure" data-connection-observation><summary>{identityObservation.label}</summary><p className="agent-connector-note">{identityObservation.detail}</p></details> : null}
    {currentSetupPending ? setupRecovery(currentSetupPending) : null}
    {otherSetupPending.length ? <details className="agent-connector-disclosure"><summary>{otherSetupPending.length} {otherSetupPending.length === 1 ? 'bot needs' : 'bots need'} setup</summary>{otherSetupPending.map(setupRecovery)}</details> : null}
  </div>
  const canCreate = creatingGroup && !roomIntent
  const canConnect = !bindingPending && !detached && !!audience && (!binding || changingGroup || !sameFilters)
  const previousActivity = !!original.connectionId || bindings.length > 0 || Object.values(intents).some(intent => sameConnectorTarget(intent.target, target))
  const defaultNote = !explicitlySelected.current && !previousActivity && mode !== 'details'
    ? moteDefault.status === 'loading' ? 'Checking this Mote’s default bot. You can choose a bot now.'
      : moteDefault.issue ?? (defaultChoice?.issue ? `Saved default ${defaultRef!.application.appId}: ${defaultChoice.issue}`
        : defaultChoice?.record && connectionNeedsInitialSetup(defaultChoice.record) ? 'This Mote’s saved bot needs its original setup continued. Its preference is kept.'
        : defaultRef && original.mote && 'name' in original.mote ? `Default bot for ${original.mote.name}` : null)
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
  const joining = section === 'joining' && showingCurrentBinding
  const disabledBinding = !!binding && connection?.config.enabled === false
  const taskTitle = detached ? 'This group is disconnected' : joining ? 'Join with your chat account' : disabledBinding ? 'This bot is disabled' : bindingPending ? 'Check the original connection result' : !connection ? 'Choose a bot to connect' : roomIntent && !created && !binding ? 'Check this group’s creation' : changingGroup ? 'Review this group change' : !groupSelected ? creatingGroup ? 'Give your group a name' : 'Choose the group for this Agent'
    : !binding ? created ? 'Group created. Connect it to this Agent.' : 'Your group is selected. Review sharing next.'
    : binding.state === 'paused' ? 'Sharing is paused' : approvedMembers === 0 ? 'Choose who can use this Agent'
    : unconfirmedMembers || approvedMembers === null ? 'Check member access' : 'Your group connection is saved'
  const taskDetail = detached ? 'The conversation remains with this Agent. Its original disconnection and notification results are kept below.' : joining ? 'Use the official group link or scan its code. Joining the group and permission to use this Agent are separate.' : disabledBinding ? 'Your group and sharing settings are kept. Open bot settings to enable this bot; saved member access remains available to review.' : bindingPending ? 'Check the original connection request below. Earlier confirmed sharing is kept.' : roomIntent && !created && !binding ? 'Your original creation request is kept. Check its status below to continue.' : changingGroup ? 'Your current group stays connected until you confirm this change.' : !groupSelected ? 'Use a group your bot has joined, or create a dedicated group.'
    : !binding ? created ? 'The group exists separately from this Agent. Review and confirm sharing below to save their connection.' : 'Review the selected group and confirm what this Agent may share with it.'
    : binding.state === 'paused' ? 'New message recording, requests and replies are paused. Resume sync to continue from now, keeping the same group and member access.'
    : approvedMembers === 0 ? 'Sharing settings are saved locally. Approve a member before they can send requests from the group.'
    : 'The saved link, automatic sync and member access are separate. Activity shows actual message receipts.'

  const memberAccess = showingCurrentBinding && binding ? <ConnectorMemberAccess heading={false} binding={binding} facts={roomFacts}
    grants={actors?.bindingId === binding.bindingId && actors.revision === binding.revision ? currentGrants : null}
    access={actors?.bindingId === binding.bindingId && actors.revision === binding.revision ? actors.access : null}
    creator={creatorInvitation.creator} drafts={memberDrafts} changeDrafts={setMemberDrafts}
    account={{ idType: actorType, userId: actorId, change: (idType, userId) => { setActorType(idType); setActorId(userId) } }}
    requests={currentMemberIntents.map(intent => ({ intent, state: memberReceiptState(intent) }))} flights={memberFlights}
    save={grant} inspect={intent => { void memberWork(memberKey(intent.input.actor), async () => { await inspect(intent) }) }}
    resume={intent => { if (currentGrantIntent(intent) && memberReceiptState(intent) === 'not-dispatched') void memberWork(memberKey(intent.input.actor), () => execute(intent, true), 'saving') }} review={reviewMember} /> : null

  const joiningAccess = detached ? null : audience && audienceLinks.length && !linkIntent ? <p role="status" className="agent-connector-note">Several original joining requests are kept. Check their receipts below before generating another.</p> : audience && !linkIntent && connection?.capabilities?.roomLink === false ? <p role="status" className="agent-connector-note">Joining links are unavailable for this application. The group connection and member access are kept.</p> : audience ? <ConnectorRoomJoinLink key={JSON.stringify([connectionId, audience])} submitted={!!linkIntent} operation={linkOperation} pending={busy} prominent heading={!showingCurrentBinding}
            canContinue={linkIntent?.phase === 'not-dispatched' && !linkOperation}
            onCreate={() => createJoinLink()} onRegenerate={() => { if (linkIntent) createJoinLink(linkIntent.input.operationId) }} onInspect={() => { if (linkIntent) void work(async () => { await inspect(linkIntent) }) }}
            onContinue={() => { if (linkIntent?.phase === 'not-dispatched' && !linkOperation) void work(() => execute(linkIntent, true)) }} /> : null

  useEffect(() => {
    if (!showingCurrentBinding || !binding || !loaded || entryConsumed.current) return
    entryConsumed.current = true
    if (initialSection) showSection(initialSection)
    // Only an explicit header action carries this snapshot. Ordinary open/refresh never resumes.
    if (resumeBinding && resumeBinding.bindingId === binding.bindingId && binding.state === 'paused')
      lifecycle('connection.binding.resume', { ...binding, revision: resumeBinding.revision })
  }, [showingCurrentBinding, binding, loaded, initialSection, resumeBinding])

  const connectionDetails = <div className="agent-connector-fields">
            {showingCurrentBinding ? application : null}
            {settings ? <button className="agent-connector-text-action" onClick={() => { connection ? settings.openChannel({ sessionId: session.id, hostId: target.executionHostId, hostingTarget, agentSessionId: target.agentSessionId, connection: connection.config }) : settings.open('overview'); onClose() }}>Application settings</button> : null}
            {connection ? <span>{connection.config.application.domain} · {connection.config.application.appId} · Revision {connection.revision}</span> : null}
            <span>Bot hosting · {hostingTarget.hostId}</span><span>Runtime · {hostingTarget.runtimeId}</span><span>Agent execution · {target.executionHostId}</span><span>Session · {target.agentSessionId}</span>{audience ? <span>{bindingPending ? 'Requested group' : 'Group'} · {audience}</span> : null}{binding ? <>{bindingPending ? <span>Last observed group · {binding.externalConversationId}</span> : null}<span>{bindingPending ? 'Last observed Binding' : 'Binding'} · {binding.bindingId} · Revision {binding.revision}</span></> : null}
          </div>
  const changeGroup = binding ? <details className="agent-connector-disclosure" open={changingGroup} onToggle={event => setChangingGroup(event.currentTarget.open)}><summary>Change connected group</summary><p className="agent-connector-note">{bindingPending ? 'Check the pending connection setup before changing groups.' : 'Choose another group above. Your current group stays connected until you confirm this change.'}</p></details> : null
  const openChannelSettings = settings && connection ? () => { settings.openChannel({ sessionId: session.id, hostId: target.executionHostId, hostingTarget, agentSessionId: target.agentSessionId, connection: connection.config }); onClose() } : undefined
  const technicalDetails = <>{connectionDetails}<div className="agent-connector-host-sync" data-connection-section="sync" tabIndex={-1}><ConnectorServiceControl active={section === 'overview'} hostingTarget={hostingTarget} /></div>{changeGroup}</>
  const sharingStatus = binding ? <section className="agent-connector-status" aria-label="Group connection status"><div className="agent-connector-saved"><SharingIcon size={14} /><span>Configured: {binding.state === 'paused' ? 'Sync paused' : binding.scope.publication === 'future-shared-conversation' ? 'Two-way sync enabled' : 'Agent replies only'}</span></div>{binding.scope.publication === 'future-native-user-facing' ? <div role="status" className="agent-connector-fields" data-partial-sharing><strong>App and group are not fully synced</strong><p className="agent-connector-note">{binding.state === 'paused' ? 'Sync is paused. No new messages are being shared. The saved configuration shares only Agent replies. Resume two-way sync' : 'This group currently receives only Agent replies. Enable two-way sync'} so new messages in the App and this group stay in the same conversation. Earlier private history stays local; saved member access and original requests are kept.</p>{audienceReview}<p className="agent-connector-note">This Agent may use its existing private context in replies to these audiences.</p><button type="button" className="primary-button" disabled={busy || bindingPending || !connection?.config.enabled || session.nativeHandle?.kind !== 'provider'} onClick={() => bind(true)}>{binding.state === 'paused' ? 'Resume two-way sync' : 'Enable two-way sync'}</button></div> : null}<div className="agent-connector-link-actions">{binding.state !== 'paused' || binding.scope.publication === 'future-shared-conversation' ? <button className="small-button" disabled={busy} onClick={() => lifecycle(binding.state === 'paused' ? 'connection.binding.resume' : 'connection.binding.pause')}>{binding.state === 'paused' ? 'Resume sync' : 'Pause sync'}</button> : null}<button className="agent-connector-text-action" disabled={busy} onClick={() => setDisconnecting(true)}>Disconnect group</button></div>
            {disconnecting ? <div className="agent-connector-disconnect" role="group" aria-label="Confirm group disconnection"><strong>Disconnect this group?</strong><p className="agent-connector-note">New messages will stop in both directions. This Agent keeps running and its conversation stays here. An end card is sent to this group; a card failure does not prevent disconnection.</p><div className="agent-connector-link-actions"><button className="small-button" disabled={busy} onClick={() => setDisconnecting(false)}>Keep connected</button><button className="small-button" disabled={busy} onClick={() => lifecycle('connection.binding.detach')}>Confirm disconnect</button></div></div> : null}
          </section> : null
  const groupOverview = binding ? <ConnectorDeliveryDetails active={section === 'overview'} details={technicalDetails} binding={binding} hostingTarget={hostingTarget} onMembers={() => showSection('members')} actions={{ sync: () => showSection('sync'), sharing: () => showSection('sharing'), ...(openChannelSettings ? { 'channel-settings': openChannelSettings } : {}) }} /> : null
  const groupDetails = showingCurrentBinding && binding ? <ConnectorGroupDetails section={section} onSection={setSection}
    identity={<ConnectorRoomOverview facts={roomFacts} groupId={audience} requestedName={created === audience ? frozenRoom?.name : undefined} />}
    bot={<>Bot · <strong>{connection?.config.label ?? 'Saved bot'}</strong> · {channel?.title ?? connection?.config.application.domain ?? 'Platform unconfirmed'}</>}
    overview={groupOverview}
    members={memberAccess} sharing={<>{sharingStatus}{sharing}</>} joining={<div className="agent-connector-section" data-connection-section="joining" tabIndex={-1}>{joiningAccess}</div>}
    /> : null

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="dialog-scrim" />
      <Dialog.Content ref={content} className="dialog-surface agent-connector-dialog" aria-busy={busy}
        onOpenAutoFocus={event => { event.preventDefault(); (content.current?.querySelector<HTMLElement>('[aria-label="Group name"]') ?? content.current?.querySelector<HTMLElement>('[aria-label="Existing group"]') ?? content.current?.querySelector<HTMLElement>('[aria-label="Close group setup"]'))?.focus({ preventScroll: true }) }}
        onCloseAutoFocus={event => { event.preventDefault(); const node = returnFocus(), active = ownerDocument.activeElement; if (node?.isConnected && (active === ownerDocument.body || !active?.isConnected || content.current?.contains(active))) node.focus({ preventScroll: true }) }}
        onEscapeKeyDown={event => { if (event.target instanceof ownerDocument.defaultView!.Element && event.target.closest('[role="menu"]')) event.preventDefault() }}>
        <header className="agent-connector-dialog__header"><div><Dialog.Title>{channel ? channel.title + ' · ' : ''}{joining ? 'Join this group' : binding || detached ? 'Group connection' : 'Connect a group'}</Dialog.Title>
          <Dialog.Description className="agent-connector-identity">{original.identity ? <ResolvedAgentAvatar {...original.identity} label={original.name} size={22} /> : <AgentIcon size={20} aria-hidden="true" />}<span>{original.name}</span></Dialog.Description></div>
          <button type="button" className="icon-button" aria-label="Close group setup" onClick={onClose}><CloseIcon size={15} /></button></header>
        <div className="agent-connector-dialog__body">
          {unqualifiedDraft || earlierDraft || otherOriginals.length ? <details className="agent-connector-disclosure"><summary>Earlier setup references</summary><div className="agent-connector-fields">
            {earlierDraft ? <p className="agent-connector-note">An earlier draft is kept in its original scope. <button type="button" className="agent-connector-text-action" onClick={onOpenDraft}>Continue earlier draft</button></p> : null}
            {unqualifiedDraft ? <p className="agent-connector-note">An earlier draft has no confirmed bot hosting owner. It is kept separately from this new form.</p> : null}
            {otherOriginals.map(intent => <div className="agent-connector-receipt" key={intent.input.operationId}><strong>{intent.hostingTarget ? 'Earlier group setup' : 'Original bot hosting owner unconfirmed'}</strong><code>{intent.input.operationId}</code><p className="agent-connector-note">The original request is kept. It has not been resent from this view.</p>{intent.hostingTarget ? <button className="small-button" onClick={() => onOpenOriginal(intent)}>Open original setup</button> : null}</div>)}
          </div></details> : null}
          {!binding && !detached ? <ol className="agent-connector-progress" aria-label="Group connection progress">
            {steps.map((step, index) => <li key={step.label} data-complete={step.done || undefined} aria-current={currentStep === index ? 'step' : undefined}>
              <span className="agent-connector-progress__number" aria-hidden="true">{step.done ? <CheckIcon size={13} /> : index + 1}</span>
              <span><strong>{step.label}</strong><small>{step.detail}</small></span>
            </li>)}
          </ol> : null}
          {!showingCurrentBinding ? <div className="agent-connector-task-heading"><h3>{taskTitle}</h3><p className="agent-connector-note">{taskDetail}</p></div> : null}
          {!showingCurrentBinding ? application : groupDetails}

          {!binding && !detached && !roomIntent && !bindingPending ? <div className="agent-connector-modes" role="group" aria-label="Group choice">
            <button type="button" aria-label="Existing group" aria-pressed={mode !== 'create'} disabled={busy} onClick={() => { setMode('existing'); setScope('mentions-and-replies'); setConfirmed(false) }}>Existing group<span>Connect a group your bot has joined</span></button>
            <button type="button" aria-label="New group" aria-pressed={mode === 'create'} disabled={busy || creationUnsupported} onClick={() => { setMode('create'); setScope('all-messages'); setConfirmed(false) }}>New group<span>{creationUnsupported ? 'Existing groups only' : 'Create a dedicated space'}</span></button>
          </div> : null}
          {creationUnsupported && !roomIntent && !binding ? <p role="status" className="agent-connector-note">Group creation is unavailable for this application. Choose an existing group; your saved draft is kept.</p> : connection && connection.capabilities === undefined && creatingGroup && !roomIntent ? <p role="status" className="agent-connector-note">Group creation support is not confirmed. This request will be checked for the selected application; platform permissions are checked separately.</p> : null}
          {!showingCurrentBinding ? <section className="agent-connector-group-selection" data-bound={showingCurrentBinding || undefined} aria-label="Agent and group conversation">
            <span className="agent-connector-group-selection__label"><GroupIcon size={14} aria-hidden="true" />{creatingGroup && !created ? 'Group name' : bindingPending ? 'Requested group' : 'Group conversation'}</span>
            {creatingGroup && !created ? <TextInput aria-label="Group name" title={frozenRoom?.name ?? name} value={frozenRoom?.name ?? name} disabled={busy || !!roomIntent} onChange={event => setName(event.target.value)} />
              : (created && !binding || bindingPending || showingCurrentBinding || detached) ? <ConnectorRoomOverview facts={roomFacts} groupId={audience} requestedName={created === audience ? frozenRoom?.name : undefined} />
              : connection ? <ConnectorRoomSelection key={JSON.stringify([connectionId, connection.revision, hostingTarget])} hostingTarget={hostingTarget} connection={connection} value={audience} disabled={busy || bindingPending} onChange={value => { setGroup(value); setConfirmed(false) }} /> : <p className="agent-connector-note">Choose an application above to find its groups.</p>}
            {audience && !created && !bindingPending && !showingCurrentBinding && !detached ? <ConnectorRoomOverview facts={roomFacts} groupId={audience} /> : null}
          </section> : null}
          {defaultNote ? <p className="agent-connector-note" role="status" data-mote-bot-source>{defaultNote}</p> : null}
          {busy ? <p className="agent-connector-note" role="status" aria-busy="true" data-connector-request-pending><LoadingIcon size={13} animation="spin" /> Working on this group request…</p> : null}
          {detached ? <section className="agent-connector-status" aria-label="Disconnected group"><div><strong>Group disconnected</strong><span>This Agent and its conversation remain available. New group messages are no longer shared.</span></div></section> : null}
          {recentApplied ? <ConnectorBindingNotices operation={recentApplied} /> : null}

          {!showingCurrentBinding ? <div className="agent-connector-host-sync" data-connection-section="sync" tabIndex={-1}><ConnectorServiceControl active hostingTarget={hostingTarget} /></div> : null}

          {bindingPending || binding && changingGroup ? <p className="agent-connector-note" role="status">{bindingPending ? 'The group change is not confirmed. Check its original status.' : 'Your current group stays connected until you confirm this change.'}</p> : null}
          {creatingGroup && !created && (!creationUnsupported || !!roomIntent) ? <fieldset disabled={busy || !!roomIntent} className="agent-connector-fields" aria-label="New dedicated group">
            {!roomIntent ? <ConnectorCreatorInvitation invitation={creatorInvitation} onOpenSettings={settings && connection ? () => { settings.openChannel({ sessionId: session.id, hostId: target.executionHostId, hostingTarget, agentSessionId: target.agentSessionId, connection: connection.config }); onClose() } : undefined} /> : null}
            <details className="agent-connector-disclosure"><summary>Invite people (optional)</summary><div className="agent-connector-fields">
              {frozenRoom ? frozenRoom.members.length ? frozenRoom.members.map(member => <p className="agent-connector-note" key={JSON.stringify([member.idType, member.userId])}>{member.idType} · {member.userId}</p>) : <p className="agent-connector-note">No invitations requested.</p> : <>
                <label className="agent-connector-field">Member ID type<TextInput aria-label="Member ID type" value={memberType} onChange={event => setMemberType(event.target.value)} placeholder="Exact ID type" /></label>
                <label className="agent-connector-field">Member IDs<Textarea aria-label="Invite member IDs" rows={3} value={members} onChange={event => setMembers(event.target.value)} placeholder="One exact ID per line" /></label>
              </>}
              <p className="agent-connector-note">Invitations and access to this Agent are separate. You can manage member access after connecting the group.</p>
            </div></details>
          </fieldset> : null}
          {relevant.map(intent => { const fact = facts[intent.input.operationId], isRoom = fact && 'creation' in fact
            if (currentGrantIntent(intent) && showingCurrentBinding) return null
            if (intent.method === 'connection.room.link.create') {
              if (intent === linkIntent) return null
              const previous = fact && 'state' in fact && 'input' in fact && 'externalConversationId' in fact.input ? fact as RoomLinkOperation : null
              return <details className="agent-connector-disclosure" key={intent.input.operationId}><summary>Previous join link receipt</summary><div className="agent-connector-fields"><ConnectorRoomJoinReceipt operation={previous} />{!previous ? <><span>Group · {intent.input.externalConversationId}</span><code>{intent.input.operationId}</code></> : null}<button className="small-button" disabled={busy} onClick={() => void work(async () => { await inspect(intent) })}>Check link status</button></div></details>
            }
            const memberIntent = intent.method === 'connection.grant' || intent.method === 'connection.binding.member.inherit' ? intent : null
            const receipt = <>
              {recordedRepliesOnly(intent) ? <p className="agent-connector-note">Original replies-only request · {intent.phase === 'not-dispatched' ? 'Not sent. It will not be dispatched.' : 'Original result retained; check its status.'} Complete conversation sharing uses a separate explicit confirmation on the current group.</p> : null}
              {isRoom ? <><strong>{fact.creation.state === 'created' ? 'Group created' : fact.creation.state === 'not-applied' ? 'Group not created' : fact.creation.state === 'pending' ? 'Group setup pending' : 'Creation not confirmed'}</strong><span>{fact.membership.state === 'not-requested' ? 'No invitations requested.' : fact.membership.state === 'settled' ? fact.membership.results.filter(item => item.state === 'joined').length + ' of ' + fact.membership.results.length + ' invitations confirmed.' : fact.membership.state === 'not-applied' ? 'Invitations were not sent.' : fact.membership.state === 'pending' ? 'Invitations not started.' : 'Invitations not confirmed.'}</span></> : <strong>{fact && 'state' in fact && fact.state === 'refused' ? memberIntent ? 'Member access could not be saved' : 'Setup could not finish' : memberIntent ? memberReceiptState(memberIntent) === 'not-dispatched' ? 'Member access not sent' : memberReceiptState(memberIntent) === 'applied' ? 'Member access saved' : 'Member access not confirmed' : 'Setup not confirmed'}</strong>}
              {memberIntent ? <><span>Member · {currentGrantIntent(memberIntent) ? roomFacts.people?.members.find(member => member.idType === memberIntent.input.actor.idType && member.userId === memberIntent.input.actor.userId)?.name ?? memberIntent.input.actor.userId : memberIntent.input.actor.userId}</span><span>{currentGrantIntent(memberIntent) ? 'This group connection' : 'Original group connection'} · revision {memberIntent.input.expectedBindingRevision}</span></> : null}
              <button className="small-button" disabled={busy} onClick={() => void work(async () => { await inspect(intent); await refresh() })}>Check status</button>
              {!memberIntent && !recordedRepliesOnly(intent) && (isRoom && (fact.creation.state === 'pending' || fact.creation.state === 'created' && fact.membership.state === 'pending') || fact && 'state' in fact && fact.state === 'preparing' || intent.phase === 'not-dispatched') ? <button className="small-button" disabled={busy} onClick={() => void work(() => execute(intent, true))}>Continue setup</button> : null}
              {!memberIntent && (isRoom && fact.creation.state === 'not-applied' || fact && 'state' in fact && fact.state === 'refused') ? <button className="small-button" disabled={busy} onClick={() => void work(async () => { await clearConnectorRoomIntent(intent.input.operationId); await refresh() })}>Dismiss unsuccessful setup</button> : null}
              <details className="agent-connector-disclosure"><summary>Setup receipt details</summary><div className="agent-connector-fields">
                <span>Operation</span><code>{intent.input.operationId}</code><span>Host · {target.executionHostId}</span>
                {isRoom ? <><span>Creation: {fact.creation.state}{fact.creation.state === 'created' ? ' · ' + fact.creation.externalConversationId : fact.creation.state === 'not-applied' ? ' · ' + fact.creation.reason : ''}</span><span>Members: {fact.membership.state}</span>{fact.membership.state === 'settled' ? fact.membership.results.map((item, index) => <span key={index}>{item.member.idType} · {item.member.userId}: {item.state}</span>) : null}</> : <span>{fact && 'state' in fact ? fact.state + (fact.state === 'refused' && 'code' in fact ? ' · ' + fact.code : '') : 'Result unknown.'}</span>}
              </div></details>
            </>
            return memberIntent || isRoom && fact.creation.state === 'created' && (binding || fact.membership.state === 'not-requested' || fact.membership.state === 'settled') ? <details className="agent-connector-disclosure" key={intent.input.operationId}><summary>{memberIntent ? 'Earlier member access receipt' : 'Group setup receipt'}</summary><div className="agent-connector-receipt">{receipt}</div></details> : <section className="agent-connector-receipt" key={intent.input.operationId} aria-label="Group setup status">{receipt}</section>
          })}
          {!showingCurrentBinding && (audience && !bindingPending && !detached ? <div className="agent-connector-section-grid">
            {memberAccess}
            <div className="agent-connector-section-stack">{sharing}{joiningAccess ? <div className="agent-connector-section" data-connection-section="joining" tabIndex={-1}>{joiningAccess}</div> : null}</div>
          </div> : joiningAccess ? <div className="agent-connector-section" data-connection-section="joining" tabIndex={-1}>{joiningAccess}</div> : memberAccess)}
          {!showingCurrentBinding ? changeGroup : null}

          {audience && !binding && !detached ? <section className="agent-connector-section" aria-label="Group members"><ConnectorRoomPeople facts={roomFacts} prominent /></section> : null}
          {!showingCurrentBinding ? <details className="agent-connector-disclosure"><summary>Connection details</summary>{connectionDetails}</details> : null}
          {issue ? <p role="status" className="surface-inline-error">{issue}</p> : null}
        </div><footer className="agent-connector-dialog__footer">
          {issue || relevant.length ? <button className="agent-connector-text-action" disabled={busy} onClick={() => void work(refresh)}>Refresh</button> : null}
          <button className="small-button" onClick={onClose}>{!binding && !detached && !relevant.length ? 'Cancel' : 'Close'}</button>
          {canCreate ? <button className="primary-button" disabled={busy || creationUnsupported || !connection || !availableForNewGroup(connection) || awaitingCreator || !name.trim() || !!members && !memberType.trim()} onClick={createRoom}>{busy ? 'Creating…' : 'Create group'}</button> : canConnect ? <button className="primary-button" disabled={busy || !connection?.config.enabled || !confirmed || !audience.trim() || session.nativeHandle?.kind !== 'provider'} onClick={() => bind()}>{binding ? audience === binding.externalConversationId ? sameFilters ? 'Reconnect group' : 'Save sharing' : 'Change group' : 'Connect group'}</button> : null}
        </footer>
      </Dialog.Content></DocumentOverlayPortal>
  </Dialog.Root>
}
