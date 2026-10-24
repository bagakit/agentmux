import { useContext, useEffect, useRef, useState } from 'react'
import type { RoomBinding } from '@agentmux/core/connections'
import type { SessionSnapshot } from '../../../shared/contracts'
import { selectConnectorServiceObservation } from '../lib/connector-service-observation'
import { useAppStore } from '../store'
import { hasConnectorRoomIntent, invalidateConnectorTarget } from '../lib/connector-room-intent'
import { useSessionConnections } from '../lib/use-session-connections'
import { AgentConnectorDialog, type AgentConnectorTarget } from './AgentConnectorDialog'
import { useAgentConnectorMenu } from '../lib/use-agent-connector-menu'
import type { ConnectorGroupAction } from '../lib/connector-group-status'
import { SettingsNavigation } from './SettingsNavigation'
import { ConnectorHeaderLinks } from './ConnectorHeaderLinks'

/** Connection management belongs to the original Agent header, independently of its input surface. */
export function AgentConnections({ session, regionId, visible }: { session: Extract<SessionSnapshot, { kind: 'agent' }>; regionId?: string | undefined; visible: boolean }) {
  const navigation = useContext(SettingsNavigation)
  const connector = useAgentConnectorMenu(regionId ?? '', regionId ? session.id : null)
  const target = { executionHostId: session.control.hostId, agentSessionId: session.control.agentSessionId }
  const hasRetainedSetup = useAppStore(state => hasConnectorRoomIntent(state.connectorRoomIntents, target))
  const current = useSessionConnections(target, visible)
  const syncEnabled = useAppStore(state => selectConnectorServiceObservation(state.connectorServiceObservation, current?.hostingTarget ?? null)?.state?.enabled ?? null)
  const [dialog, setDialog] = useState<AgentConnectorTarget | null>(null), returned = useRef<HTMLElement | null>(null)
  const setupWasOpen = useRef(false)
  const [issue, setIssue] = useState('')
  const [entry, setEntry] = useState<{ section?: 'members' | 'sharing' | 'sync' | 'activity'; resume?: Pick<RoomBinding, 'bindingId' | 'revision'> }>({})
  useEffect(() => {
    if (setupWasOpen.current && !connector.dialogOpen) invalidateConnectorTarget(target)
    setupWasOpen.current = connector.dialogOpen
  }, [connector.dialogOpen])
  function openBinding(binding: RoomBinding, trigger: HTMLElement, channel?: string, action?: ConnectorGroupAction) {
    if (action === 'channel-settings' && channel && navigation) {
      navigation.openChannel({ sessionId: session.id, hostId: target.executionHostId, agentSessionId: target.agentSessionId, hostingTarget: current?.hostingTarget ?? null,
        connection: { connectionId: binding.connectionId, adapterId: channel, application: binding.application } })
      return
    }
    const anchor = regionId ?? binding.regionAnchor?.regionId
    if (!anchor) { setIssue('Open this conversation to manage its connection. You can review the bot in its channel settings.'); return }
    setIssue('')
    setEntry(action === 'resume' ? { resume: { bindingId: binding.bindingId, revision: binding.revision } } : action === 'members' || action === 'sharing' || action === 'sync' || action === 'activity' ? { section: action } : {})
    const store = useAppStore.getState(), executorId = session.executorId ?? undefined
    const appearance = executorId ? store.config?.executors[executorId]?.avatar ?? store.config?.appearance.agentAvatars?.[executorId] : undefined
    returned.current = trigger; setDialog({ ...(channel ? { channel } : {}), name: store.agentNames[session.id] ?? session.label, session, hostingTarget: current?.hostingTarget ?? null, connectionId: binding.connectionId, bindingId: binding.bindingId,
      identity: { providerId: session.providerId, executorId, ...(appearance ? { appearance: structuredClone(appearance) } : {}) },
      target: { ...target, regionAnchor: { regionId: anchor } } })
  }
  return <><ConnectorHeaderLinks bindings={current?.bindings ?? []} issue={[current?.issue, issue, connector.issue].filter(Boolean).join(' ')} checking={visible && (!current || current.loading)}
    hostingTarget={current?.hostingTarget ?? null} retainedSetup={!current?.bindings.length && hasRetainedSetup} syncEnabled={syncEnabled} nameVersion={current?.version ?? 0} visible={visible}
    onOpen={openBinding} onConnect={(trigger, channel) => connector.openConnect(trigger, 'existing', channel)}
    onMenuOpen={open => { if (open) invalidateConnectorTarget(target); connector.onOpen(open) }}
    onSettings={(trigger, channel) => connector.openConnect(trigger, 'details', channel)} />
    {connector.dialog}
    {dialog ? <AgentConnectorDialog original={dialog} mode="details" initialSection={entry.section} resumeBinding={entry.resume}
      onClose={() => { setDialog(null); invalidateConnectorTarget(target) }} returnFocus={() => returned.current} /> : null}
  </>
}
