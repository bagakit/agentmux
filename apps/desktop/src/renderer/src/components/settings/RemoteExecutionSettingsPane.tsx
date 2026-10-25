import { useContext, useMemo, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveAgentName } from '@agentmux/client-ui/display-name'
import { isScratchWorkspaceId, type SessionSnapshot } from '../../../../shared/contracts'
import { useAppStore } from '../../store'
import { sessionStatusLabel } from '../../lib/session-presentation'
import { AgentToolExecutionNotice } from '../AgentToolExecutionNotice'
import { ResolvedAgentAvatar } from '../AgentAvatar'
import { SettingsNavigation } from '../SettingsNavigation'
import { SettingsResourceLibrary } from './SettingsResourceLibrary'
import type { SettingsPaneProps } from './settings-catalog'
import executionIllustration from '../../assets/settings/remote-execution.png'
import '../../styles/remote-execution-settings.css'

const AgentIcon = semanticIconComponent('object.agent')
const ToolsIcon = semanticIconComponent('object.terminal')
const OpenIcon = semanticIconComponent('action.open-external')
const ArrowIcon = semanticIconComponent('navigation.disclosure')
const NO_SESSIONS: SessionSnapshot[] = []
const NO_NAMES: Record<string, string> = {}
type BoundAgent = Extract<SessionSnapshot, { kind: 'agent' }> & { toolExecution: NonNullable<Extract<SessionSnapshot, { kind: 'agent' }>['toolExecution']> }

/** A view of retained Core bindings. Creating and continuing work stay with the original workbench. */
export function RemoteExecutionSettingsPane({ config, active, onClose, onNavigate }: SettingsPaneProps) {
  const sessions = useAppStore(state => active ? state.sessions : NO_SESSIONS)
  const names = useAppStore(state => active ? state.agentNames : NO_NAMES)
  const activeWorkspaceId = useAppStore(state => state.activeWorkspaceId)
  const navigation = useContext(SettingsNavigation)
  const projects = config.workspaces.filter(workspace => !isScratchWorkspaceId(workspace.id))
  const [projectId, setProjectId] = useState(() => projects.find(workspace => workspace.id === activeWorkspaceId)?.id ?? '')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const bindings = useMemo(() => sessions.filter((session): session is BoundAgent => session.kind === 'agent' && Boolean(session.toolExecution)), [sessions])
  function hostName(id: string) {
    const host = config.hosts.find(item => item.id === id)
    if (!host) return id
    return config.hosts.some(item => item.id !== id && item.label === host.label) ? `${host.label} (${id})` : host.label
  }
  const agentName = (session: BoundAgent) => resolveAgentName({ userName: names[session.id], fallback: session.label }).name
  const selected = bindings.find(session => session.id === selectedId)
  const rows = bindings.filter(session => `${agentName(session)} ${session.id} ${session.toolExecution.bindingId} ${hostName(session.control.hostId)} ${session.control.hostId} ${hostName(session.toolExecution.resourceHostId)} ${session.toolExecution.resourceHostId} ${session.toolExecution.workspacePath}`.toLowerCase().includes(query.trim().toLowerCase()))
  function openHost(id: string) {
    if (navigation) navigation.openHost(id)
    else onNavigate('hosts')
  }
  function prepare() {
    setActionError(null)
    const state = useAppStore.getState()
    const project = state.config?.workspaces.find(workspace => workspace.id === projectId && !isScratchWorkspaceId(workspace.id))
    if (!project) { setActionError('Choose a registered project for its files and tools.'); return }
    const tabId = state.openLauncher({ workspaceId: project.id, reveal: true })
    if (!tabId) { setActionError('The project workface could not be opened. Its existing work is retained; check the workspace notice and try again.'); return }
    const tab = useAppStore.getState().tabs[tabId]!
    try {
      useAppStore.getState().setLauncherAgentWorkspace({ tabId, regionId: tab.layout.activeRegionId }, project.id)
      onClose()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }
  function openOriginal(session: BoundAgent) {
    setActionError(null)
    if (useAppStore.getState().selectSession(session.id)) onClose()
    else setActionError('The original workface could not be selected. Its Session is retained; check its exact Tab and Region in the workspace notice.')
  }
  return <div className="settings-pane-stack remote-execution-settings">
    <section className="remote-execution-intro" aria-label="How remote execution works">
      <div className="remote-execution-intro__copy">
        <span className="remote-execution-eyebrow">YOUR WORK, ACROSS MACHINES</span>
        <h3>Keep the project.<br /> Choose where your Agent runs.</h3>
        <p>Let one machine run the Agent while another keeps your files and executes its tools. Either machine can take either role.</p>
      </div>
      <figure className="remote-execution-diagram">
        <img src={executionIllustration} alt="An Agent works at a conversation console on one machine, linked to a separate project workstation with files and a command terminal." width="1536" height="1024" />
        <figcaption><span><strong>Agent runtime</strong><small>Conversation · Model</small></span><span><strong>Project &amp; tools</strong><small>Files · Commands</small></span></figcaption>
        <p>Role illustration · Choose machines in the Launcher.</p>
      </figure>
    </section>

    <section className="settings-group remote-execution-prepare" data-settings-field="prepare">
      <header><span>Start with your project</span><button type="button" className="small-button" onClick={() => onNavigate('hosts')}>Manage Hosts<OpenIcon size={13} /></button></header>
      <p className="settings-group-note">Choose where files and tools belong. Next, select the Agent runtime and configuration in the Launcher, then start when ready.</p>
      {projects.length ? <div className="remote-execution-prepare__controls">
        <label><span>Project &amp; tools</span><select aria-label="Project for remote execution" value={projectId} onChange={event => { setProjectId(event.target.value); setActionError(null) }}>
          <option value="">Choose a project…</option>
          {projectId && !projects.some(project => project.id === projectId) ? <option value={projectId}>Previously selected project · unavailable</option> : null}
          {projects.map(project => <option value={project.id} key={project.id}>{project.name} · {hostName(project.hostId)} · {project.path}</option>)}
        </select></label>
        <button type="button" className="primary-button" data-remote-prepare onClick={prepare}>Prepare Agent<ArrowIcon size={14} /></button>
      </div> : <p className="settings-group-note">Register a project in Hosts to choose its files and tools. Existing Agents remain available below.</p>}
      <p className="remote-execution-caption">No Agent starts here. Provider support is checked for your selected runtime.</p>
    </section>

    {actionError ? <p className="remote-execution-feedback" role="status">{actionError}</p> : null}
    <section className="settings-group remote-execution-bindings" data-settings-field="bindings">
      <header><span>Your execution bindings</span><small>{bindings.length} retained in this client</small></header>
      <p className="settings-group-note">Open the original work or inspect its two environments. This list reflects this client’s retained Sessions.</p>
      <div className="remote-execution-bindings__body">
        <SettingsResourceLibrary label="Execution bindings" query={query} onQuery={setQuery} selectedId={selectedId} focusRequest={null}
          onSelect={id => { setSelectedId(id); setActionError(null) }} items={rows.map(session => ({ id: session.id, name: agentName(session),
            detail: `Agent: ${hostName(session.control.hostId)}\nTools: ${hostName(session.toolExecution.resourceHostId)}`,
            mark: <ResolvedAgentAvatar label={agentName(session)} providerId={session.providerId} executorId={session.executorId} state={session.status.state} size={26} /> }))} />
        {selected ? <div className="remote-execution-detail" data-remote-binding={selected.toolExecution.bindingId}>
          <header><div><h3>{agentName(selected)}</h3><span>Agent · {sessionStatusLabel(selected)}</span></div>
            <button type="button" className="small-button" data-remote-open onClick={() => openOriginal(selected)}>Open original work<OpenIcon size={13} /></button></header>
          <dl className="remote-execution-endpoints">
            <div><dt><AgentIcon size={16} />Agent runtime</dt><dd><button type="button" onClick={() => openHost(selected.control.hostId)}>{hostName(selected.control.hostId)}<OpenIcon size={12} /></button><code>{selected.control.hostId}</code><span>{selected.workspacePath}</span></dd></div>
            <div><dt><ToolsIcon size={16} />Project &amp; tools</dt><dd><button type="button" onClick={() => openHost(selected.toolExecution.resourceHostId)}>{hostName(selected.toolExecution.resourceHostId)}<OpenIcon size={12} /></button><code>{selected.toolExecution.resourceHostId}</code><span>{selected.toolExecution.workspacePath}</span></dd></div>
          </dl>
          <AgentToolExecutionNotice key={selected.toolExecution.bindingId} session={selected} visible={active} presentation="inline" />
          <details className="remote-execution-identities"><summary>Original identities</summary><dl><dt>Session</dt><dd>{selected.control.agentSessionId}</dd><dt>Binding</dt><dd>{selected.toolExecution.bindingId}</dd></dl></details>
        </div> : <div className="remote-execution-empty"><AgentIcon size={28} aria-hidden="true" /><h3>{selectedId ? 'Binding not observed' : bindings.length ? 'Choose a binding' : 'Your next Agent can work across machines'}</h3><p>{selectedId ? 'This client no longer exposes that reference. No Session has been stopped or replaced.' : bindings.length ? 'See where it runs, where its tools work, and what the original service reports.' : 'Prepare an Agent above. Its execution binding will appear here when this client receives the original Session.'}</p></div>}
      </div>
    </section>
  </div>
}
