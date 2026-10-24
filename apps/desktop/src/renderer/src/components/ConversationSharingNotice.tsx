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
import { useWorkbenchNameTooltip } from './WorkbenchNameTooltip'

const ConnectionIcon = semanticIconComponent('object.connection')
const StatusIcons = {
  paused: semanticIconComponent('status.paused'),
  off: semanticIconComponent('action.pause'),
  checking: semanticIconComponent('status.loading'),
  unavailable: semanticIconComponent('status.unknown')
}
type SharingStatus = { kind: keyof typeof StatusIcons; label: string } | null

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
      const status: SharingStatus = binding.state === 'paused' ? { kind: 'paused', label: current.issue ? 'Sharing was paused · check unavailable' : 'Sharing paused' } :
        current.issue ? { kind: 'unavailable', label: 'Group check unavailable' } : off ? syncStatus(...off) : failed ? syncStatus(...failed) :
          policies.some(([observation]) => !observation?.state) ? { kind: 'checking', label: 'Checking sync…' } : null
      return <SharingAudience key={binding.bindingId} binding={binding} channel={channel} hostingTarget={current.hostingTarget}
        refresh={current.version} visible={visible} status={status} />
    })}
  </aside>
}

function syncStatus(observation: ConnectorServiceObservation | null, label: string): SharingStatus {
  if (observation?.issue) return { kind: 'unavailable', label: observation.state?.enabled === false ? `${label} was off · check unavailable` : `${label} check unavailable` }
  if (!observation?.state) return { kind: 'checking', label: 'Checking sync…' }
  return observation.state.enabled ? null : { kind: 'off', label: `${label} off` }
}

function SharingAudience({ binding, channel, refresh, status, visible, hostingTarget }: {
  hostingTarget: ConnectionHostingTarget | null; binding: RoomBinding; channel?: ChannelEntry; refresh: number; status: SharingStatus; visible: boolean
}) {
  const name = useConnectorRoomName(binding, refresh, visible, hostingTarget)
  const Icon = channel?.icon ?? ConnectionIcon
  const fullConversation = binding.scope.publication === 'future-shared-conversation'
  const scope = fullConversation ? 'Conversation' : 'Agent replies'
  const explanation = fullConversation ? 'New conversation messages are shared with this group.' : 'Only Agent replies and questions are shared with this group.'
  const detail = [explanation, status?.label, name.issue, 'Manage connections in the Agent header.', binding.externalConversationId, binding.application.domain, binding.application.appId].filter(Boolean).join(' · ')
  const details = name.label + ' · ' + detail
  const tooltip = useWorkbenchNameTooltip(name.label, detail, !visible, { placement: 'top-start' })
  const StatusIcon = status ? StatusIcons[status.kind] : null
  return <><span className="conversation-sharing-notice__audience" role="group" tabIndex={0} aria-label={details} title={tooltip.content ? undefined : details} {...tooltip.props}>
    <Icon size={12} aria-hidden="true" />
    <span className="conversation-sharing-notice__destination"><span>{scope} → </span><strong>{name.label}</strong></span>
    {status && StatusIcon ? <span className="conversation-sharing-notice__status" role="status" data-sharing-status={status.kind} title={status.label}>
      <StatusIcon size={12} aria-hidden="true" /><span className="conversation-sharing-notice__sr-only">{status.label}</span>
    </span> : null}
  </span>{tooltip.content}</>
}
