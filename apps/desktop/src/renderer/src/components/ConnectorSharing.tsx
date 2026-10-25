import type { ReactNode } from 'react'
import type { ConnectionRecord, RoomBinding } from '@agentmux/core/connections'
import type { ConnectorEntityProfileRead } from '../lib/use-connector-room-name'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ConnectorEntityIdentity } from './ConnectorEntityIdentity'
import '../styles/connector-sharing.css'

const LinkIcon = semanticIconComponent('object.link')
const MentionIcon = semanticIconComponent('object.user')
const ConversationIcon = semanticIconComponent('object.conversation')
const CheckIcon = semanticIconComponent('action.confirm')

/** A view of saved bindings, never a claim about live delivery or a second connection owner. */
export function ConnectorSharingMap({ name, avatar, bindings, connections, current, loaded }: {
  name: string; avatar: ReactNode; bindings: readonly RoomBinding[]; connections: readonly ConnectionRecord[]; loaded: boolean
  current: { connectionId: string; groupId: string; name?: string | undefined; profile?: ConnectorEntityProfileRead | undefined }
}) {
  const proposed = current.groupId && !bindings.some(item => item.connectionId === current.connectionId && item.externalConversationId === current.groupId)
  const destinations: Array<{ id: string; connectionId: string; groupId: string; binding?: RoomBinding }> = bindings.map(item => ({ id: item.bindingId, connectionId: item.connectionId, groupId: item.externalConversationId, binding: item }))
  if (proposed) destinations.push({ id: 'proposed', connectionId: current.connectionId, groupId: current.groupId })
  return <section className="connector-sharing-map" aria-label="Connected audiences">
    <div className="connector-sharing-map__caption"><span>{proposed ? 'Connect this conversation' : 'One conversation, connected'}</span><small>{proposed ? 'Sharing preview' : 'Saved sharing'}</small></div>
    <div className="connector-sharing-map__graph" aria-label="Groups sharing this conversation">
      <div className="connector-sharing-map__source">
        <span className="connector-sharing-map__avatar">{avatar}</span>
        <strong>{name}</strong><span>AgentMux App</span>
      </div>
      <div className="connector-sharing-map__destinations">
        {destinations.map(item => {
          const isCurrent = item.connectionId === current.connectionId && item.groupId === current.groupId
          const profile = isCurrent ? current.profile : undefined
          const bot = connections.find(value => value.config.connectionId === item.connectionId)
          return <div className="connector-sharing-map__destination" key={item.id} data-sharing-audience={item.id} data-paused={item.binding?.state === 'paused' || undefined} data-proposed={!item.binding || undefined}>
            <div className="connector-sharing-map__bridge"><LinkIcon size={12} aria-hidden="true" /><span>via {bot?.config.label ?? 'Saved bot'}</span></div>
            <ConnectorEntityIdentity identityKey={JSON.stringify([item.connectionId, item.groupId])} kind="group" compact
              name={isCurrent ? current.name : undefined} missingName="Connected group" profileRead={profile} avatarUrl={profile?.observation?.profile?.avatarUrl}
              secondary={!isCurrent || !current.name ? <span title={item.groupId}>{item.groupId}</span> : undefined} />
            <div className="connector-sharing-map__scope">
              {item.binding ? <><span>{item.binding.state === 'paused' ? 'Paused' : isCurrent ? 'This group' : 'Linked'}</span><span>{item.binding.scope.publication === 'future-shared-conversation' ? 'Complete conversation' : 'Agent replies only'}</span></> : <span>{loaded ? 'Not connected yet' : 'Sharing not confirmed'}</span>}
            </div>
          </div>
        })}
      </div>
    </div>
    {bindings.some(item => item.connectionId === current.connectionId && item.externalConversationId === current.groupId && item.scope.publication === 'future-shared-conversation') ? <p className="connector-sharing-map__includes" aria-label="Complete conversation includes">New messages <span>·</span> Agent replies <span>·</span> Questions &amp; resources</p> : null}
    {bindings.length > 1 ? <p className="agent-connector-note">These groups share the Agent’s context. Replies may use messages from another group.</p> : null}
    {!loaded ? <p className="agent-connector-note" role="status">The complete group list is not confirmed. Earlier observations are kept.</p> : null}
  </section>
}

const modes = [
  { value: 'mentions-and-replies', title: 'Only @mentions', detail: 'Mentions and replies to the Agent', icon: MentionIcon },
  { value: 'all-messages', title: 'Every message', detail: 'All messages from authorized members', icon: ConversationIcon }
] as const

/** Native radios keep keyboard selection local to the original dialog's unsaved draft. */
export function ConnectorReplyMode({ id, value, disabled, changed, onChange }: {
  id: string; value: RoomBinding['scope']['input']; disabled: boolean; changed: boolean; onChange(value: RoomBinding['scope']['input']): void
}) {
  return <fieldset className="connector-reply-mode" disabled={disabled} aria-label="Group input scope" data-value={value}>
    <legend>When should the Agent reply?{changed ? <small>Unsaved</small> : null}</legend>
    <div className="connector-reply-mode__choices">{modes.map(({ value: mode, title, detail, icon: Icon }) => <label key={mode} className="connector-reply-mode__choice">
      <input type="radio" name={id} value={mode} checked={value === mode} onChange={() => onChange(mode)} />
      <span className="connector-reply-mode__surface"><Icon size={19} aria-hidden="true" /><span><strong>{title}</strong><small>{detail}</small></span><CheckIcon className="connector-reply-mode__check" size={14} aria-hidden="true" /></span>
    </label>)}</div>
    <p className="agent-connector-note">Member access determines who can send requests.</p>
  </fieldset>
}
