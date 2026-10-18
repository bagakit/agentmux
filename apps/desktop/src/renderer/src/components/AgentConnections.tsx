import { useContext, useEffect, useRef, useState } from 'react'
import type { RoomBinding } from '@agentmux/core/connections'
import type { SessionSnapshot } from '../../../shared/contracts'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { hasConnectorRoomIntent, invalidateConnectorTarget } from '../lib/connector-room-intent'
import { useSessionConnections } from '../lib/use-session-connections'
import { AgentConnectorDialog, type AgentConnectorTarget } from './AgentConnectorDialog'
import { SettingsNavigation } from './SettingsNavigation'
import { useAgentConnectorMenu } from '../lib/use-agent-connector-menu'
import { ConnectorHeaderLinks } from './ConnectorHeaderLinks'

/** Connection management belongs to the original Agent header, independently of its input surface. */
export function AgentConnections({ session, regionId, visible }: { session: Extract<SessionSnapshot, { kind: 'agent' }>; regionId?: string | undefined; visible: boolean }) {
  const connector = useAgentConnectorMenu(regionId ?? '', regionId ? session.id : null)
  const settings = useContext(SettingsNavigation)
  const target = { executionHostId: session.control.hostId, agentSessionId: session.control.agentSessionId }
  const hasRetainedSetup = useAppStore(state => hasConnectorRoomIntent(state.connectorRoomIntents, target))
  const syncEnabled = useAppStore(state => state.connectorServiceObservation?.source === api.connections.call ? state.connectorServiceObservation.state?.enabled ?? null : null)
  const current = useSessionConnections(target, visible)
  const [dialog, setDialog] = useState<AgentConnectorTarget | null>(null), returned = useRef<HTMLElement | null>(null)
  const setupWasOpen = useRef(false)
  const [issue, setIssue] = useState('')
  useEffect(() => {
    if (setupWasOpen.current && !connector.dialogOpen) invalidateConnectorTarget(target)
    setupWasOpen.current = connector.dialogOpen
  }, [connector.dialogOpen])
  function openBinding(binding: RoomBinding, trigger: HTMLElement) {
    const anchor = regionId ?? binding.regionAnchor?.regionId
    if (!anchor) { setIssue('Open this conversation to manage its connection. You can review the bot in Lark settings.'); return }
    setIssue('')
    const store = useAppStore.getState(), executorId = session.executorId ?? undefined
    const appearance = executorId ? store.config?.executors[executorId]?.avatar ?? store.config?.appearance.agentAvatars?.[executorId] : undefined
    returned.current = trigger; setDialog({ name: store.agentNames[session.id] ?? session.label, session, connectionId: binding.connectionId,
      identity: { providerId: session.providerId, executorId, ...(appearance ? { appearance: structuredClone(appearance) } : {}) },
      target: { ...target, regionAnchor: { regionId: anchor } } })
  }
  return <><ConnectorHeaderLinks bindings={current?.bindings ?? []} issue={current?.issue ?? ''} checking={visible && (!current || current.loading)}
    retainedSetup={!current?.bindings.length && hasRetainedSetup} syncEnabled={syncEnabled} nameVersion={current?.version ?? 0} visible={visible}
    onOpen={openBinding} onConnect={trigger => connector.openConnect(trigger)}
    onMenuOpen={open => { if (open) invalidateConnectorTarget(target); connector.onOpen(open) }}
    {...(settings ? { onSettings: () => settings.openLark({ sessionId: session.id, hostId: target.executionHostId, agentSessionId: target.agentSessionId }) } : {})} />
    {issue ? <span className="agent-connections__error" role="status">{issue}</span> : null}
    {connector.issue ? <span className="agent-connections__error" role="status">{connector.issue}</span> : null}
    {connector.dialog}
    {dialog ? <AgentConnectorDialog original={dialog} mode="details" initialSection="joining"
      onClose={() => { setDialog(null); invalidateConnectorTarget(target) }} returnFocus={() => returned.current} /> : null}
  </>
}
