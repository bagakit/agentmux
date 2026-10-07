import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { RoomBinding } from '@agentmux/core/connections'
import type { SessionSnapshot } from '../../../shared/contracts'
import { api } from '../lib/api'
import { observeConnectorTarget } from '../lib/connector-room-intent'
import { AgentConnectorDialog, type AgentConnectorTarget } from './AgentConnectorDialog'

/** Reads only this original Session's audiences. No input, history, lifecycle or global watcher. */
export function ConnectorSharing({ session, regionId, visible }: { session: Extract<SessionSnapshot, { kind: 'agent' }>; regionId?: string | undefined; visible: boolean }) {
  const target = { executionHostId: session.control.hostId, agentSessionId: session.control.agentSessionId }
  const identity = JSON.stringify(target)
  const [read, setRead] = useState<{ identity: string; bindings: RoomBinding[]; issue: string } | null>(null)
  const [dialog, setDialog] = useState<AgentConnectorTarget | null>(null), returned = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!visible) return
    let live = true, generation = 0
    const refresh = () => { const request = ++generation; void api.connections.call('connection.binding.ls', target).then(value => {
      if (live && request === generation) setRead({ identity, bindings: value.bindings, issue: '' })
    }).catch(error => { if (live && request === generation) setRead(previous => ({ identity, bindings: previous?.identity === identity ? previous.bindings : [], issue: presentError(error) })) }) }
    refresh(); const close = observeConnectorTarget(target, refresh)
    return () => { live = false; generation++; close() }
  }, [identity, visible])
  const current = read?.identity === identity ? read : null
  if (!current?.bindings.length && !current?.issue) return null
  return <div className="connector-sharing" aria-label="Group sharing before sending">
    {current?.bindings.map(binding => <button type="button" className="connector-sharing__group" key={binding.bindingId} title={binding.application.domain + ' · ' + binding.application.appId}
      aria-label={`${current.issue ? 'Last known group' : binding.state === 'active' ? 'Shared group' : 'Sharing paused'} ${binding.externalConversationId}; ${binding.application.domain}; ${binding.application.appId}`}
      onClick={event => { returned.current = event.currentTarget; setDialog({ name: session.label, session, connectionId: binding.connectionId, target: { ...target, regionAnchor: { regionId: regionId ?? binding.regionAnchor.regionId } } }) }}>
      {current.issue ? 'Last known group' : binding.state === 'active' ? 'Shared group' : 'Sharing paused'} · {binding.externalConversationId}
    </button>)}
    {current?.issue ? <span role="status">Sharing status unconfirmed · {current.issue}</span> : null}
    {dialog ? <AgentConnectorDialog original={dialog} mode="details" onClose={() => setDialog(null)} returnFocus={() => returned.current} /> : null}
  </div>
}

