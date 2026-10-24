import { useContext, useEffect } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AppConfig, HostConfig, SessionSnapshot } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { useAppStore } from '../../store'
import { resolveAgentName } from '@agentmux/client-ui/display-name'
import { sessionStatusLabel } from '../../lib/session-presentation'
import { executorsForHost, hostExecutorInventoryMatches } from '../../lib/executors'
import { executorDetectionLabel } from '../../lib/executor-detection'
import { usePathDisplay } from '../../hooks/usePathDisplay'
import { ResolvedAgentAvatar } from '../AgentAvatar'
import { agentProviderLabel } from '../AgentProviderIcon'
import { SettingsNavigation } from '../SettingsNavigation'

const NO_DETECTIONS = {}

const TerminalIcon = semanticIconComponent('object.terminal')
const OpenIcon = semanticIconComponent('action.open-external')
const RefreshIcon = semanticIconComponent('action.refresh')

/** Existing Session references are not a second activity registry or a running-process count. */
export function HostSessionSummary({ sessions, active, onOpen }: {
  sessions: readonly SessionSnapshot[]
  active: boolean
  onOpen: (id: string) => void
}) {
  return <section className="remote-work" aria-label="Sessions on this environment">
    <header><strong>Sessions</strong><small>{sessions.length} retained references</small></header>
    {sessions.length ? <div className="remote-work__rows">{sessions.map(session => <HostSessionRow key={session.id} session={session} active={active} onOpen={onOpen} />)}</div>
      : <p className="remote-work__empty">No Session references in this client. Open a project to start working on this environment.</p>}
  </section>
}
function HostSessionRow({ session, active, onOpen }: { session: SessionSnapshot; active: boolean; onOpen: (id: string) => void }) {
  const userName = useAppStore(state => active ? state.agentNames[session.id] : undefined)
  const path = usePathDisplay()
  const name = resolveAgentName({ userName, fallback: session.label }).name
  return <button type="button" className="remote-work__row" data-host-session={session.id} onClick={() => onOpen(session.id)}>
    {session.kind === 'agent' ? <ResolvedAgentAvatar label={name} providerId={session.providerId} executorId={session.executorId} state={session.status.state} size={24} /> : <TerminalIcon size={20} />}
    <span><strong>{name}</strong><small title={session.workspacePath}>{path(session.workspacePath, session.hostId)}</small></span>
    <span className="remote-work__state" title={session.status.detail}>{sessionStatusLabel(session)}</span><OpenIcon size={13} />
  </button>
}

/** Exact saved Host inventory, using the same discovery and presentation as the launch/config consumers. */
export function HostExecutorsSummary({ config, host, active }: { config: AppConfig; host: HostConfig; active: boolean }) {
  const inventory = useAppStore(state => active ? state.hostExecutorInventories[host.id] : undefined)
  const detections = useAppStore(state => active ? state.executorDetections : NO_DETECTIONS)
  const refresh = useAppStore(state => state.detectExecutors)
  const navigation = useContext(SettingsNavigation)
  const saved = configValuesEqual(host, config.hosts.find(item => item.id === host.id))
  const current = hostExecutorInventoryMatches(inventory, host)
  const choices = saved ? executorsForHost(config, host.id, detections, inventory) : []
  const checking = host.kind === 'ssh' ? current && inventory.state === 'checking' : choices.some(choice => choice.detection?.state === 'checking')
  useEffect(() => {
    if (active && saved && !current) void refresh(host.id)
  }, [active, saved, current, host.id, refresh])
  return <section className="remote-work" aria-label="Executors on this environment">
    <header><strong>Agent configurations</strong><button type="button" className="small-button" disabled={!saved || checking}
      onClick={() => void refresh(host.id)}><RefreshIcon size={13} />Refresh</button></header>
    <p className="settings-group-note">{host.kind === 'local' ? 'Saved local launch configurations. Availability is checked separately.' : 'Configurations registered on this saved environment. Discovery does not install software.'}</p>
    {!saved ? <p role="status">Save this connection before reading its Agent configurations.</p> : null}
    {current && inventory.state === 'error' ? <p role="status" className="remote-work__notice">{inventory.detail ?? 'The current inventory could not be confirmed.'} Existing Sessions remain available.</p> : null}
    {choices.length ? <div className="remote-work__rows">{choices.map(choice => <div className="remote-work__row" key={choice.id}>
      <ResolvedAgentAvatar label={choice.label} providerId={choice.providerId} executorId={choice.id} size={24} />
      <span><strong>{choice.label}</strong><small>{agentProviderLabel(choice.providerId)}</small><code>{choice.command}</code></span>
      <span className="remote-work__state">{executorDetectionLabel(choice.detection)}</span>
    </div>)}</div> : saved ? <p className="remote-work__empty" role="status">{checking ? 'Reading configurations…' : 'No configurations have been confirmed for this environment.'}</p> : null}
    {navigation ? <button type="button" className="small-button" onClick={() => navigation.open('agents')}>Manage Agent configurations<OpenIcon size={13} /></button> : null}
  </section>
}
