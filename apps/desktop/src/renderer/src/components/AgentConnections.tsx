import { useEffect, useRef, useState } from 'react'
import type { RoomBinding } from '@agentmux/core/connections'
import type { SessionSnapshot } from '../../../shared/contracts'
import { selectConnectorServiceObservation } from '../lib/connector-service-observation'
import { useAppStore } from '../store'
import { hasConnectorRoomIntent, invalidateConnectorTarget } from '../lib/connector-room-intent'
import { useSessionConnections } from '../lib/use-session-connections'
import { AgentConnectorDialog, type AgentConnectorTarget } from './AgentConnectorDialog'
import { useAgentConnectorMenu } from '../lib/use-agent-connector-menu'
import { ConnectorHeaderLinks } from './ConnectorHeaderLinks'

/** Connection management belongs to the original Agent header, independently of its input surface. */
export function AgentConnections({ session, regionId, visible }: { session: Extract<SessionSnapshot, { kind: 'agent' }>; regionId?: string | undefined; visible: boolean }) {
  const connector = useAgentConnectorMenu(regionId ?? '', regionId ? session.id : null)
  const target = { executionHostId: session.control.hostId, agentSessionId: session.control.agentSessionId }
  const hasRetainedSetup = useAppStore(state => hasConnectorRoomIntent(state.connectorRoomIntents, target))
  const current = useSessionConnections(target, visible)
  const syncEnabled = useAppStore(state => selectConnectorServiceObservation(state.connectorServiceObservation, current?.hostingTarget ?? null)?.state?.enabled ?? null)
  const [dialog, setDialog] = useState<AgentConnectorTarget | null>(null), returned = useRef<HTMLElement | null>(null)
  const setupWasOpen = useRef(false)
  const [issue, setIssue] = useState('')
  useEffect(() => {
    if (setupWasOpen.current && !connector.dialogOpen) invalidateConnectorTarget(target)
    setupWasOpen.current = connector.dialogOpen
  }, [connector.dialogOpen])
  function openBinding(binding: RoomBinding, trigger: HTMLElement) {
    if (!current?.hostingTarget) { setIssue('The original bot hosting owner is unconfirmed. Refresh this connection before managing it.'); return }
    const anchor = regionId ?? binding.regionAnchor?.regionId
    if (!anchor) { setIssue('Open this conversation to manage its connection. You can review the bot in its channel settings.'); return }
    setIssue('')
    const store = useAppStore.getState(), executorId = session.executorId ?? undefined
    const appearance = executorId ? store.config?.executors[executorId]?.avatar ?? store.config?.appearance.agentAvatars?.[executorId] : undefined
    returned.current = trigger; setDialog({ name: store.agentNames[session.id] ?? session.label, session, hostingTarget: current.hostingTarget, connectionId: binding.connectionId, bindingId: binding.bindingId,
      identity: { providerId: session.providerId, executorId, ...(appearance ? { appearance: structuredClone(appearance) } : {}) },
      target: { ...target, regionAnchor: { regionId: anchor } } })
  }
  return <><ConnectorHeaderLinks bindings={current?.bindings ?? []} issue={current?.issue ?? ''} checking={visible && (!current || current.loading)}
    hostingTarget={current?.hostingTarget ?? null} retainedSetup={!current?.bindings.length && hasRetainedSetup} syncEnabled={syncEnabled} nameVersion={current?.version ?? 0} visible={visible}
    onOpen={openBinding} onConnect={trigger => connector.openConnect(trigger)}
    onMenuOpen={open => { if (open) invalidateConnectorTarget(target); connector.onOpen(open) }}
    onSettings={trigger => connector.openConnect(trigger, 'details')} />
    {issue ? <span className="agent-connections__error" role="status">{issue}</span> : null}
    {connector.issue ? <span className="agent-connections__error" role="status">{connector.issue}</span> : null}
    {connector.dialog}
    {dialog ? <AgentConnectorDialog original={dialog} mode="details"
      onClose={() => { setDialog(null); invalidateConnectorTarget(target) }} returnFocus={() => returned.current} /> : null}
  </>
}
