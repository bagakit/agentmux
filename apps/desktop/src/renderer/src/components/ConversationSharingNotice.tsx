import { useContext } from 'react'
import { SettingsNavigation } from './SettingsNavigation'
import type { RoomBinding } from '@agentmux/core/connections'
import type { SessionSnapshot } from '../../../shared/contracts'
import { selectConnectorServiceObservation } from '../lib/connector-service-observation'
import { useAppStore } from '../store'
import { useSessionConnections } from '../lib/use-session-connections'
import { useConnectorRoomName } from '../lib/use-connector-room-name'

/** Read-only context composed by the Session workface, never a message destination control. */
export function ConversationSharingNotice({ session, visible }: { session: Extract<SessionSnapshot, { kind: 'agent' }>; visible: boolean }) {
  const current = useSessionConnections({ executionHostId: session.control.hostId, agentSessionId: session.control.agentSessionId }, visible)
  const channels = useContext(SettingsNavigation)?.channelEntries ?? []
  const observations = useAppStore(state => state.connectorServiceObservation)
  const service = selectConnectorServiceObservation(observations, current?.hostingTarget ?? null)
  if (!current?.bindings.length) return null
  const sync = !service?.state || service.issue ? 'Automatic sync unconfirmed' : service.state.enabled ? '' : 'Automatic sync off'
  const platformStatus = (binding: RoomBinding) => {
    const channel = channels.find(entry => entry.domains.includes(binding.application.domain))
    const policy = channel ? selectConnectorServiceObservation(observations, current.hostingTarget, channel.adapterId) : null
    return !policy?.state || policy.issue ? 'Platform sync unconfirmed' : policy.state.enabled ? '' : `${channel!.title} is turned off`
  }
  return <aside className="conversation-sharing-notice" aria-label="External sharing scope" aria-busy={current?.loading || undefined}>
    <span className="conversation-sharing-notice__label">Sharing scope</span>
    {current?.bindings.map(binding => <SharingAudience key={binding.bindingId} binding={binding} hostingTarget={current.hostingTarget} refresh={current.version} visible={visible}
      status={current.issue ? 'Audience unconfirmed' : binding.state === 'paused' ? 'Sharing paused' : [sync, platformStatus(binding)].filter(Boolean).join(' · ')} />)}
    {current?.issue ? <span role="status">Sharing status unconfirmed. Check Connections in the Agent header.</span> : null}
  </aside>
}

function SharingAudience({ binding, refresh, status, visible, hostingTarget }: { hostingTarget: import('../../../shared/contracts').ConnectionHostingTarget | null; binding: RoomBinding; refresh: number; status: string; visible: boolean }) {
  const name = useConnectorRoomName(binding, refresh, visible, hostingTarget)
  const scope = binding.scope.publication === 'future-shared-conversation' ? 'New conversation content' : 'Agent replies and questions'
  return <span className="conversation-sharing-notice__audience" title={`${binding.externalConversationId} · ${binding.application.domain} · ${binding.application.appId}`}>
    <span>{scope} → <strong>{name.label}</strong></span>
    {status || name.issue ? <span className="conversation-sharing-notice__status">{[status, name.issue].filter(Boolean).join(' · ')}</span> : null}
  </span>
}
