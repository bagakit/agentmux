import { useContext } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { SettingsNavigation } from './SettingsNavigation'
import type { RoomBinding } from '@agentmux/core/connections'
import type { ConnectionHostingTarget, SessionSnapshot } from '../../../shared/contracts'
import { selectConnectorServiceObservation, type ConnectorServiceObservation } from '../lib/connector-service-observation'
import { useAppStore } from '../store'
import { useSessionConnections } from '../lib/use-session-connections'
import { useConnectorRoomName } from '../lib/use-connector-room-name'
import type { ChannelEntry } from './settings/settings-catalog'

const ConnectionIcon = semanticIconComponent('object.connection')

/** Read-only context composed by the Session workface, never a message destination control. */
export function ConversationSharingNotice({ session, visible }: { session: Extract<SessionSnapshot, { kind: 'agent' }>; visible: boolean }) {
  const current = useSessionConnections({ executionHostId: session.control.hostId, agentSessionId: session.control.agentSessionId }, visible)
  const channels = useContext(SettingsNavigation)?.channelEntries ?? []
  const observations = useAppStore(state => state.connectorServiceObservation)
  const service = selectConnectorServiceObservation(observations, current?.hostingTarget ?? null)
  if (!current?.bindings.length) return null
  return <aside className="conversation-sharing-notice" aria-label="External sharing scope" aria-busy={current.loading || undefined}>
    {current.bindings.map(binding => {
      const channel = channels.find(entry => entry.domains.includes(binding.application.domain))
      const policy = channel ? selectConnectorServiceObservation(observations, current.hostingTarget, channel.adapterId) : null
      const policies: [ConnectorServiceObservation | null, string][] = [[service, 'Automatic sync'], [policy, channel?.title ?? 'Platform sync']]
      const off = policies.find(([observation]) => observation?.state?.enabled === false)
      const failed = policies.find(([observation]) => observation?.issue)
      const status = binding.state === 'paused' ? current.issue ? 'Sharing was paused · check unavailable' : 'Sharing paused' :
        current.issue ? 'Group check unavailable' : off ? syncStatus(...off) : failed ? syncStatus(...failed) :
          policies.some(([observation]) => !observation?.state) ? 'Checking sync…' : ''
      return <SharingAudience key={binding.bindingId} binding={binding} channel={channel} hostingTarget={current.hostingTarget}
        refresh={current.version} visible={visible} status={status} />
    })}
  </aside>
}

function syncStatus(observation: ConnectorServiceObservation | null, label: string): string {
  if (observation?.issue) return observation.state?.enabled === false ? `${label} was off · check unavailable` : `${label} check unavailable`
  if (!observation?.state) return 'Checking sync…'
  return observation.state.enabled ? '' : `${label} off`
}

function SharingAudience({ binding, channel, refresh, status, visible, hostingTarget }: {
  hostingTarget: ConnectionHostingTarget | null; binding: RoomBinding; channel?: ChannelEntry; refresh: number; status: string; visible: boolean
}) {
  const name = useConnectorRoomName(binding, refresh, visible, hostingTarget)
  const Icon = channel?.icon ?? ConnectionIcon
  const fullConversation = binding.scope.publication === 'future-shared-conversation'
  const scope = fullConversation ? 'Conversation' : 'Agent replies'
  const explanation = fullConversation ? 'New conversation messages are shared with this group.' : 'Only Agent replies and questions are shared with this group.'
  const details = [name.label, explanation, status, name.issue, binding.externalConversationId, binding.application.domain, binding.application.appId].filter(Boolean).join(' · ')
  return <span className="conversation-sharing-notice__audience" role="group" aria-label={details} title={details}>
    <Icon size={12} aria-hidden="true" />
    <span className="conversation-sharing-notice__content">
      <span className="conversation-sharing-notice__destination"><span>{scope} → </span><strong>{name.label}</strong></span>
      {status ? <span className="conversation-sharing-notice__status" role="status">{status}</span> : null}
    </span>
  </span>
}
