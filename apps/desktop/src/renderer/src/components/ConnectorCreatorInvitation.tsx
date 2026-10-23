import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { useEffect, useState } from 'react'
import type { ConnectionProfileObservation, ConnectionRecord } from '@agentmux/core/connections'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../lib/api'

const LoadingIcon = semanticIconComponent('status.loading')

/** One visible form reads the selected application's creator; submitted members stay in the original room intent. */
export function useConnectorCreatorInvitation(connection: ConnectionRecord | undefined, active: boolean, hostingTarget?: ConnectionHostingTarget | null) {
  const key = active && connection && hostingTarget !== null ? JSON.stringify([connection.config.connectionId, connection.revision, connection.config.application, hostingTarget]) : ''
  const [read, setRead] = useState<{ key: string; observation: ConnectionProfileObservation | null } | null>(null)
  const [choice, setChoice] = useState<{ key: string; include: boolean } | null>(null)
  useEffect(() => {
    if (!key || !connection) return
    let current = true
    void api.connections.call('connection.profile.get', { connectionId: connection.config.connectionId, expectedConnectionRevision: connection.revision }, hostingTarget ?? undefined)
      .then(observation => { if (current) setRead({ key, observation }) })
      .catch(() => { if (current) setRead({ key, observation: null }) })
    return () => { current = false }
  }, [key])
  const observation = read?.key === key ? read.observation : null
  const creator = observation?.creator ?? null
  const included = choice?.key === key ? choice.include : true
  return { creator, included, member: included ? creator : null, pending: !!key && read?.key !== key,
    permissionRequired: observation?.reason === 'permission-required',
    setIncluded: (include: boolean) => setChoice({ key, include }) }
}

export function ConnectorCreatorInvitation({ invitation, onOpenSettings }: {
  invitation: ReturnType<typeof useConnectorCreatorInvitation>; onOpenSettings?: (() => void) | undefined
}) {
  const { creator, included, pending, permissionRequired } = invitation
  if (!pending && !creator) return <div className="agent-connector-fields" role="status">
    <p className="agent-connector-note">{permissionRequired ? 'This bot cannot read its creator yet. No creator invitation will be sent. Review its application permissions, or create the group and join with its code.' : 'This bot’s creator could not be identified. No creator invitation will be sent; you can create the group and join with its code.'}</p>
    {permissionRequired && onOpenSettings ? <button type="button" className="agent-connector-text-action" onClick={onOpenSettings}>Review bot permissions</button> : null}
  </div>
  return <div className="agent-connector-fields">
    <label className="agent-connector-check"><input type="checkbox" aria-label="Invite this bot’s creator" checked={included} onChange={event => invitation.setIncluded(event.target.checked)} /><span>Invite this bot’s creator</span></label>
    {pending ? <p className="agent-connector-note" role="status"><LoadingIcon size={14} animation="spin" /> Checking this bot’s creator… Clear the invitation to create now and join afterward.</p> : null}
    <p className="agent-connector-note">Adds the account that created this bot to the new group. Permission to use this Agent is approved separately.</p>
    {creator ? <details className="agent-connector-disclosure"><summary>Creator identity</summary><p className="agent-connector-note">{creator.idType} · {creator.userId}</p></details> : null}
  </div>
}
