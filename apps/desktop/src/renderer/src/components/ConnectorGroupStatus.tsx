import { useEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ChannelProfileAvatar } from '@agentmux/client-ui/components/ChannelProfileAvatar'
import { channelMetadataSubjectKey, connectionDiagnosisActorKey, groupTarget, type ConnectionRecord, type ConnectionMemberAccess, type GroupDiagnosis, type RoomBinding } from '@agentmux/core/connections'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { api } from '../lib/api'
import { connectorConnectionPresentation } from '../lib/connector-connection-presentation'
import { useConnectorRoomFacts } from './ConnectorRoomSelection'
import { useConnectorEntityProfiles } from '../lib/use-connector-room-name'
import { ConnectorConnectionOverview } from './ConnectorConnectionOverview'
import type { ConnectorGroupAction } from '../lib/connector-group-status'
import '../styles/connector-group-status.css'

const PersonIcon = semanticIconComponent('object.user'), RefreshIcon = semanticIconComponent('action.refresh')
const actorKey = (actor: ConnectionMemberAccess['actor']) => JSON.stringify([actor.application.domain, actor.application.appId, actor.idType, actor.userId])
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
      const sameConnection = c?.config.connectionId === binding.connectionId && c.config.application.domain === binding.application.domain && c.config.application.appId === binding.application.appId
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
  return <section className="connector-group-status" aria-label="Group status" data-group-status={binding.bindingId}>
    <div className="connector-group-status__traffic">
      <div><small>Received</small><strong>{incoming?.issue ? 'Not checked' : received ? trafficTime(received.receivedAt) : incoming?.value ? 'No recent record' : 'Not checked'}</strong><small>{received ? received.state === 'refused' ? 'Not submitted to Agent' : 'Saved here' : 'This binding’s recorded window'}</small></div>
      <div><small>Sent</small><strong>{outgoing?.issue ? 'Not checked' : sent ? sent.receipt === 'confirmed' ? trafficTime(sent.receiptObservedAt) : sent.state === 'pending' ? 'Pending' : sent.state === 'unknown' || sent.state === 'dispatching' ? 'Unconfirmed' : sent.state === 'not-applied' ? 'Not sent' : 'No new send' : outgoing?.value ? 'No recent record' : 'Not checked'}</strong><small>{sent?.receipt === 'confirmed' ? 'Confirmation recorded at' : 'Original message result'}</small></div>
    </div>
    {model.hint ? <small className="connector-group-status__hint">{model.hint}</small> : null}
    <ConnectorConnectionOverview compact binding={binding} connection={connection} report={report} hostingTarget={hostingTarget} onCheck={onCheck} onNavigate={onNavigate} render={({ action, feedback }) => needsAction ? <div className="connector-group-status__recovery">{action}{feedback}</div> : null} />
    <div className="connector-group-status__people-title"><strong>Members</strong><small>Messages · Agent access</small></div>
    {members.map(member => {
      const actor = { application: facts.people!.application!, idType: member.idType, userId: member.userId }
      const profile = profiles.get(channelMetadataSubjectKey({ kind: 'actor', actor }))?.observation?.profile
      const access = permissions?.get(actorKey(actor)), effective = access?.effective
      const labels = effective?.state === 'active' ? effective.capabilities.map(capability => capabilities[capability]) : []
      const count = incoming?.value ? incoming.value.actors.find(row => row.actorKey === connectionDiagnosisActorKey(target, actor))?.messages ?? 0 : null
      const label = permissions ? labels.length ? labels.join(', ') : 'No access' : 'Not checked'
      return <div className="connector-group-status__person" key={actorKey(actor)}>
        <ChannelProfileAvatar url={profile?.avatarUrl} size={22}><PersonIcon size={14} /></ChannelProfileAvatar><span title={member.name ?? actor.userId}>{profile?.name ?? member.name ?? 'Group member'}</span>
        <strong title="Messages in this binding’s recorded window">{count ?? '—'}</strong><small title={effective?.state === 'active' ? effective.capabilities.map(capability => capability === 'permission' ? 'Approve Agent permission requests' : capabilities[capability]).join(', ') : label}>{label}</small>
      </div>
    })}
    {!members.length ? <small>{facts.people?.observation.state === 'ready' ? 'No members in this page' : 'Members not checked'}</small> : null}
    <div className="connector-group-status__scope"><small>{incoming?.value ? `Current binding · ${incoming.value.included} recent messages recorded here` : 'Current binding · activity not checked'}{visible ? ` · checked ${clock(visible.checkedAt)}` : ''}{facts.people?.next || (facts.people?.members.length ?? 0) > members.length ? ' · more members' : ''}</small><button type="button" className="agent-connector-text-action" aria-label="Refresh group status" disabled={checking} onClick={() => { setRequest(value => value + 1); void facts.refresh(undefined, false) }}><RefreshIcon size={12} /></button></div>
    {visible?.issue || facts.issue ? <small role="status">Some details could not be checked. The original group and controls are kept.</small> : null}
  </section>
}
