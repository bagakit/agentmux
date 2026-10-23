import type { RoomBinding } from '@agentmux/core/connections'
import type { SessionSnapshot } from '../../../shared/contracts'
import { selectConnectorServiceObservation } from '../lib/connector-service-observation'
import { useAppStore } from '../store'
import { useSessionConnections } from '../lib/use-session-connections'
import { useConnectorRoomName } from '../lib/use-connector-room-name'

/** Read-only context composed by the Session workface, never a message destination control. */
export function ConversationSharingNotice({ session, visible }: { session: Extract<SessionSnapshot, { kind: 'agent' }>; visible: boolean }) {
  const current = useSessionConnections({ executionHostId: session.control.hostId, agentSessionId: session.control.agentSessionId }, visible)
  const service = useAppStore(state => selectConnectorServiceObservation(state.connectorServiceObservation))
  if (!current?.bindings.length) return null
  const sync = !service?.state || service.issue ? 'Automatic sync unconfirmed' : service.state.enabled ? '' : 'Automatic sync off'
  return <aside className="conversation-sharing-notice" aria-label="External sharing scope" aria-busy={current?.loading || undefined}>
    <span className="conversation-sharing-notice__label">Sharing scope</span>
    {current?.bindings.map(binding => <SharingAudience key={binding.bindingId} binding={binding} refresh={current.version} visible={visible}
      status={current.issue ? 'Audience unconfirmed' : binding.state === 'paused' ? 'Sharing paused' : sync} />)}
    {current?.issue ? <span role="status">Sharing status unconfirmed. Check Connections in the Agent header.</span> : null}
  </aside>
}

function SharingAudience({ binding, refresh, status, visible }: { binding: RoomBinding; refresh: number; status: string; visible: boolean }) {
  const name = useConnectorRoomName(binding, refresh, visible)
  const scope = binding.scope.publication === 'future-shared-conversation' ? 'New conversation content' : 'Agent replies and questions'
  return <span className="conversation-sharing-notice__audience" title={`${binding.externalConversationId} · ${binding.application.domain} · ${binding.application.appId}`}>
    <span>{scope} → <strong>{name.label}</strong></span>
    {status || name.issue ? <span className="conversation-sharing-notice__status">{[status, name.issue].filter(Boolean).join(' · ')}</span> : null}
  </span>
}
