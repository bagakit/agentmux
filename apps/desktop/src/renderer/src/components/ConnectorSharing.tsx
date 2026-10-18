import { useContext, useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { RoomBinding } from '@agentmux/core/connections'
import type { SessionSnapshot } from '../../../shared/contracts'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { observeConnectorTarget } from '../lib/connector-room-intent'
import { AgentConnectorDialog, type AgentConnectorTarget } from './AgentConnectorDialog'
import { ServiceNoticeDisclosure } from './ServiceNoticeDisclosure'
import { SettingsNavigation } from './SettingsNavigation'
import { useAgentConnectorMenu } from '../lib/use-agent-connector-menu'
import { ConnectorHeaderLinks } from './ConnectorHeaderLinks'

/** Reads only this original Session's audiences. No input, history, lifecycle or global watcher. */
export function ConnectorSharing({ session, tabId, regionId, visible, presentation = 'composer' }: { session: Extract<SessionSnapshot, { kind: 'agent' }>; tabId?: string | undefined; regionId?: string | undefined; visible: boolean; presentation?: 'composer' | 'header' }) {
  const connector = useAgentConnectorMenu(regionId ?? '', regionId ? session.id : null, tabId)
  const settings = useContext(SettingsNavigation)
  const target = { executionHostId: session.control.hostId, agentSessionId: session.control.agentSessionId }
  const identity = JSON.stringify(target)
  const [read, setRead] = useState<{ identity: string; bindings: RoomBinding[]; issue: string; loading: boolean } | null>(null)
  const refreshRead = useRef<(() => void) | null>(null)
  const [dialog, setDialog] = useState<AgentConnectorTarget | null>(null), returned = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!visible) return
    let live = true, generation = 0
    const refresh = () => { const request = ++generation
      setRead(previous => previous?.identity === identity ? { ...previous, loading: true } : { identity, bindings: [], issue: '', loading: true })
      void api.connections.call('connection.binding.ls', target).then(value => {
        if (live && request === generation) setRead({ identity, bindings: value.bindings, issue: '', loading: false })
      }).catch(error => { if (live && request === generation) setRead(previous => ({ identity,
        bindings: previous?.identity === identity ? previous.bindings : [], issue: presentError(error), loading: false })) }) }
    refreshRead.current = refresh
    refresh(); const close = observeConnectorTarget(target, refresh)
    return () => { live = false; generation++; if (refreshRead.current === refresh) refreshRead.current = null; close() }
  }, [identity, visible])
  const current = read?.identity === identity ? read : null
  const notice = current?.issue ? { kind: 'indeterminate' as const, notice: {
    step: 'Sharing status could not be read', mode: 'The current audience is unconfirmed. Last known groups are kept.',
    restore: 'Refresh reads the sharing status for this Session; it does not change sharing.' } } : null
  function openBinding(binding: RoomBinding, trigger: HTMLElement) {
    const store = useAppStore.getState(), executorId = session.executorId ?? undefined
    const appearance = executorId ? store.config?.executors[executorId]?.avatar ?? store.config?.appearance.agentAvatars?.[executorId] : undefined
    returned.current = trigger; setDialog({ name: store.agentNames[session.id] ?? session.label, session, connectionId: binding.connectionId,
      identity: { providerId: session.providerId, executorId, ...(appearance ? { appearance: structuredClone(appearance) } : {}) },
      target: { ...target, regionAnchor: { regionId: regionId ?? binding.regionAnchor.regionId } } })
  }
  const details = dialog ? <AgentConnectorDialog original={dialog} mode="details" {...(presentation === 'header' ? { initialSection: 'joining' as const } : {})} onClose={() => { setDialog(null); if (presentation === 'header') refreshRead.current?.() }} returnFocus={() => returned.current} /> : null
  if (presentation === 'header') return <><ConnectorHeaderLinks bindings={current?.bindings ?? []} unconfirmed={!!current?.issue} onOpen={openBinding} />{details}</>
  const canConnect = current && !current.loading && !current.bindings.length && !current.issue && (regionId || settings)
  if (!current?.bindings.length && !current?.issue && !canConnect && !connector.dialogOpen && !dialog) return null
  return <div className="connector-sharing" aria-label="Group sharing before sending">
    {canConnect ? <button type="button" className="connector-sharing__group connector-sharing__connect" onClick={event => {
      if (regionId) connector.openConnect(event.currentTarget)
      else settings?.openLark({ sessionId: session.id, hostId: target.executionHostId, agentSessionId: target.agentSessionId })
    }}>Connect group…</button> : null}
    {connector.issue ? <p className="connector-sharing__error" role="status">{connector.issue}</p> : null}
    {current?.bindings.map(binding => <ConnectorSharingAudience key={binding.bindingId} binding={binding} unconfirmed={!!current.issue} onSelect={trigger => openBinding(binding, trigger)} />)}
    <ServiceNoticeDisclosure scope={`connector-sharing:${identity}`} notices={notice ? [{ id: 'binding-read', cause: 'binding-read', notice }] : []}
      title="Sharing status unconfirmed" persistentTitle visible={visible} className="connector-sharing__notice"
      actions={<button type="button" className="small-button" aria-label="Refresh sharing status"
        disabled={current?.loading || !visible} aria-busy={current?.loading || undefined}
        onMouseDown={event => event.preventDefault()} onClick={() => refreshRead.current?.()}>
        {current?.loading ? 'Refreshing…' : 'Refresh sharing status'}</button>}>
      <p className="connector-sharing__error">The current audience is unconfirmed. Last known groups remain visible. Refresh checks this Session’s sharing status without changing sharing.</p>
      <p className="connector-sharing__error">{current?.issue}</p>
    </ServiceNoticeDisclosure>
    {connector.dialog}
    {details}
  </div>
}

/** A visible audience has one bounded name read, never another Binding or directory store. */
function ConnectorSharingAudience({ binding, unconfirmed, onSelect }: { binding: RoomBinding; unconfirmed: boolean; onSelect(trigger: HTMLElement): void }) {
  const identity = JSON.stringify([binding.connectionId, binding.application, binding.externalConversationId])
  const [name, setName] = useState<{ identity: string; value: string } | null>(null)
  const [issue, setIssue] = useState('')
  useEffect(() => {
    let live = true
    void (async () => {
      const { connection } = await api.connections.call('connection.inspect', { connectionId: binding.connectionId })
      if (!live) return
      if (!connection || connection.config.application.domain !== binding.application.domain || connection.config.application.appId !== binding.application.appId) { setIssue('Group name unavailable'); return }
      const result = await api.connections.call('connection.room.get', { connectionId: binding.connectionId, expectedConnectionRevision: connection.revision, externalConversationId: binding.externalConversationId })
      if (live) {
        const observed = result.observation.state === 'ready' && result.room?.externalConversationId === binding.externalConversationId
        if (observed && result.room?.name) setName({ identity, value: result.room.name })
        setIssue(result.observation.state !== 'ready' ? 'Group name unconfirmed' : result.room?.name && observed ? '' : 'Group name unavailable')
      }
    })().catch(() => { if (live) setIssue('Group name unconfirmed') })
    return () => { live = false }
  }, [identity, binding.revision])
  const label = name?.identity === identity ? name.value : binding.externalConversationId
  const status = unconfirmed ? 'Last known group' : binding.state === 'active' ? 'Shared group' : 'Sharing paused'
  return <button type="button" className="connector-sharing__group" title={binding.externalConversationId + ' · ' + binding.application.domain + ' · ' + binding.application.appId}
    aria-label={`${status} ${label}; ${binding.externalConversationId}; ${binding.application.domain}; ${binding.application.appId}`} onClick={event => onSelect(event.currentTarget)}>
    {status} · {label}{issue ? <span className="connector-sharing__metadata" role="status"> · {issue}</span> : null}
  </button>
}

