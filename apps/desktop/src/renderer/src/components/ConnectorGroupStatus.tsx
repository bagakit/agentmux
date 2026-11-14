import { isValidElement, useEffect, useRef, useState, type ReactNode } from 'react'
import * as DropdownMenu from './DropdownMenu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ChannelProfileAvatar } from '@agentmux/client-ui/components/ChannelProfileAvatar'
import { sameConnectionApplication, channelMetadataSubjectKey, connectionDiagnosisActorKey, groupTarget, type ConnectionRecord, type ConnectionMemberAccess, type GroupDiagnosis, type RoomBinding } from '@agentmux/core/connections'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { api } from '../lib/api'
import { connectorConnectionPresentation } from '../lib/connector-connection-presentation'
import { useConnectorRoomFacts } from './ConnectorRoomSelection'
import { useConnectorEntityProfiles } from '../lib/use-connector-room-name'
import { ConnectorConnectionOverview } from './ConnectorConnectionOverview'
import type { ConnectorGroupAction } from '../lib/connector-group-status'
import '../styles/connector-group-status.css'

const RefreshIcon = semanticIconComponent('action.refresh')
/** A display initial from the shown name; it identifies nobody. */
const initial = (name: string) => Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '·'
/** The card lives inside the group menu, which owns Tab and arrow keys; each action joins its
 * roving focus, so Enter runs it, and stays open on selection like a button in a panel. */
const menuItem = (control: ReactNode) => isValidElement(control)
  ? <DropdownMenu.Item asChild disabled={(control.props as { disabled?: boolean }).disabled === true} onSelect={event => event.preventDefault()}>{control}</DropdownMenu.Item> : control
const actorKey = (actor: ConnectionMemberAccess['actor']) => JSON.stringify([actor.application.domain, actor.application.appId, actor.idType, actor.userId, actor.application.issuer ?? null])
const clock = (value: number | null | undefined) => value === null || value === undefined ? 'Time not recorded' : new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const trafficTime = (value: number | null | undefined) => value === null || value === undefined ? 'Time not recorded' : <time dateTime={new Date(value).toISOString()} title={new Date(value).toLocaleString()}>{clock(value)}</time>
const capabilities = { input: 'Chat', answer: 'Answer', permission: 'Approve' } as const

/** A selected popup's disposable read window; health and actions remain with their original owners. */
export function ConnectorGroupStatus({ binding, hostingTarget, report, onCheck, onNavigate }: {
  binding: RoomBinding; hostingTarget?: ConnectionHostingTarget | null | undefined; report: GroupDiagnosis | null
  onCheck(): void; onNavigate(section: ConnectorGroupAction): void
}) {
  const target = groupTarget(binding), identity = JSON.stringify([target, hostingTarget]), source = api.connections.call
  const [request, setRequest] = useState(0), [read, setRead] = useState<{ identity: string; connection?: ConnectionRecord; access?: ConnectionMemberAccess[]; activity?: GroupDiagnosis['activity']; checkedAt: number; issue: boolean } | null>(null)
  const [checking, setChecking] = useState(false), current = useRef(identity); current.current = identity
  useEffect(() => {
    if (hostingTarget === null) return
    let live = true; setChecking(true)
    const accepts = () => live && current.current === identity && api.connections.call === source
    const scope = { executionHostId: target.executionHostId, agentSessionId: target.agentSessionId, bindingId: target.bindingId, bindingRevision: target.bindingRevision, activity: true as const }
    void Promise.allSettled([
      source('connection.inspect', { connectionId: binding.connectionId }, hostingTarget),
      source('connection.binding.inspect', { bindingId: binding.bindingId }, hostingTarget),
      source('connection.diagnose', scope, hostingTarget)
    ]).then(results => {
      if (!accepts()) return
      const [connection, access, diagnosis] = results
      const c = connection.status === 'fulfilled' ? connection.value.connection : null
      const b = access.status === 'fulfilled' ? access.value.binding : null
      const sameConnection = c?.config.connectionId === binding.connectionId && sameConnectionApplication(c.config.application, binding.application)
      const sameBinding = b && JSON.stringify(groupTarget(b)) === JSON.stringify(target)
      const group = diagnosis.status === 'fulfilled' ? diagnosis.value.groups.value?.items.find(group => JSON.stringify(group.target) === JSON.stringify(target)) : null
      setRead({ identity, checkedAt: Date.now(), ...(sameConnection ? { connection: c } : {}), ...(sameBinding && access.status === 'fulfilled' && access.value.access ? { access: access.value.access } : {}), ...(group?.activity ? { activity: group.activity } : {}), issue: !sameConnection || !sameBinding || !group?.activity })
    }).finally(() => { if (accepts()) setChecking(false) })
    return () => { live = false }
  }, [identity, request, source])
  const visible = read?.identity === identity ? read : null, connection = visible?.connection
  const facts = useConnectorRoomFacts(connection, binding.externalConversationId, hostingTarget, [], false)
  const model = connectorConnectionPresentation(report), incoming = visible?.activity?.incoming, outgoing = visible?.activity?.outgoing
  const received = incoming?.value?.latest, sent = outgoing?.value?.latest
  const permissions = visible?.access ? new Map(visible.access.map(access => [actorKey(access.actor), access])) : null
  const members = facts.people?.observation.state === 'ready' && facts.people.application ? facts.people.members.slice(0, 5) : []
  const profiles = useConnectorEntityProfiles(connection?.config ?? null, members.map(member => ({ kind: 'actor' as const, actor: { application: facts.people!.application!, idType: member.idType, userId: member.userId } })), hostingTarget)
  const needsAction = model.state !== 'online' || model.primary !== 'check'
  const receivedValue = incoming?.issue || !incoming?.value ? null : received ? trafficTime(received.receivedAt) : 'No recent record'
  const sentValue = outgoing?.issue || !outgoing?.value ? null : sent ? sent.receipt === 'confirmed' ? trafficTime(sent.receiptObservedAt) : sent.state === 'pending' ? 'Pending' :
    sent.state === 'unknown' || sent.state === 'dispatching' ? 'Delivery unconfirmed' : sent.state === 'not-applied' ? 'Not sent' : 'No new send' : 'No recent record'
  const peopleReady = facts.people?.observation.state === 'ready', moreMembers = !!facts.people?.next || (facts.people?.members.length ?? 0) > members.length
  const unchecked = !!(visible?.issue || facts.issue)
  return <section className="connector-group-status" aria-label="Group status" data-group-status={binding.bindingId}>
    <div className="connector-group-status__traffic">
      <div data-observed={receivedValue !== null}><small>Received</small><strong>{receivedValue ?? 'Not checked'}</strong>
        <small>{received ? received.state === 'refused' ? 'Not submitted to Agent' : 'Saved in AgentMux' : receivedValue ? 'In this group’s recent window' : 'Recent messages unread'}</small></div>
      <div data-observed={sentValue !== null}><small>Sent</small><strong>{sentValue ?? 'Not checked'}</strong>
        <small>{sent?.receipt === 'confirmed' ? 'Delivery confirmed' : sentValue ? sent ? 'Latest reply to this group' : 'In this group’s recent window' : 'Recent replies unread'}</small></div>
      {model.hint ? <small className="connector-group-status__hint">{model.hint}</small> : null}
    </div>
    <ConnectorConnectionOverview compact binding={binding} connection={connection} report={report} hostingTarget={hostingTarget} onCheck={onCheck} onNavigate={onNavigate} render={({ action, feedback }) => needsAction ? <div className="connector-group-status__recovery">{menuItem(action)}{feedback}</div> : null} />
    <div className="connector-group-status__people" role="table" aria-label="Members">
      <div className="connector-group-status__people-title" role="row"><strong role="columnheader">Members</strong><small role="columnheader">Messages</small><small role="columnheader">Agent access</small></div>
      {members.map(member => {
        const actor = { application: facts.people!.application!, idType: member.idType, userId: member.userId }
        const profile = profiles.get(channelMetadataSubjectKey({ kind: 'actor', actor }))?.observation?.profile
        const access = permissions?.get(actorKey(actor)), effective = access?.effective
        const labels = effective?.state === 'active' ? effective.capabilities.map(capability => capabilities[capability]) : []
        const count = incoming?.value ? incoming.value.actors.find(row => row.actorKey === connectionDiagnosisActorKey(target, actor))?.messages ?? 0 : null
        const label = permissions ? labels.length ? labels.join(', ') : 'No access' : '—'
        const name = profile?.name ?? member.name ?? 'Group member'
        return <div className="connector-group-status__person" role="row" key={actorKey(actor)} data-observed={permissions ? true : undefined}>
          <span role="cell" className="connector-group-status__who"><ChannelProfileAvatar url={profile?.avatarUrl} size={22}><span className="connector-group-status__initial" aria-hidden="true">{initial(name)}</span></ChannelProfileAvatar><span title={member.name ?? actor.userId}>{name}</span></span>
          <strong role="cell" title="Messages in this group’s recent window">{count ?? '—'}</strong>
          <small role="cell" title={effective?.state === 'active' ? effective.capabilities.map(capability => capability === 'permission' ? 'Approve Agent permission requests' : capabilities[capability]).join(', ') : permissions ? label : 'Agent access not checked'}>{label}</small>
        </div>
      })}
    </div>
    {!members.length ? <small className="connector-group-status__note">{peopleReady ? 'No members in this page' : 'Members not checked'}</small> : null}
    <div className="connector-group-status__scope">
      <small>{unchecked ? 'Some details could not be checked' : incoming?.value ? `${incoming.value.included} recent messages${moreMembers ? ' · more members' : ''}` : 'Activity not checked'}{visible ? <span className="connector-group-status__checked"> · checked {clock(visible.checkedAt)}</span> : null}</small>
      {menuItem(<button type="button" className="agent-connector-text-action" aria-label="Refresh group status" disabled={checking} onClick={() => { setRequest(value => value + 1); void facts.refresh(undefined, false) }}><RefreshIcon size={12} /></button>)}
    </div>
  </section>
}
