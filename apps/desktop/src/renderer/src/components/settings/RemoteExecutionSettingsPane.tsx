import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveAgentName } from '@agentmux/client-ui/display-name'
import { isScratchWorkspaceId, type SessionSnapshot } from '../../../../shared/contracts'
import { fileNavigationSelection, useAppStore } from '../../store'
import { configValuesEqual } from '../../../../shared/config-edit'
import { AgentDeviceSelect } from '../AgentDeviceSelect'
import { sessionStatusLabel } from '../../lib/session-presentation'
import { AgentToolExecutionNotice } from '../AgentToolExecutionNotice'
import { ResolvedAgentAvatar } from '../AgentAvatar'
import { SettingsNavigation } from '../SettingsNavigation'
import { SettingsResourceLibrary } from './SettingsResourceLibrary'
import { RemoteExecutionGuide } from './RemoteExecutionGuide'
import type { SettingsPaneProps } from './settings-catalog'
import '../../styles/remote-execution-settings.css'

const AgentIcon = semanticIconComponent('object.agent')
const ToolsIcon = semanticIconComponent('object.terminal')
const OpenIcon = semanticIconComponent('action.open-external')
const BackIcon = semanticIconComponent('navigation.back')
const ArrowIcon = semanticIconComponent('navigation.disclosure')
const NO_SESSIONS: SessionSnapshot[] = []
const NO_NAMES: Record<string, string> = {}
type BoundAgent = Extract<SessionSnapshot, { kind: 'agent' }> & { toolExecution: NonNullable<Extract<SessionSnapshot, { kind: 'agent' }>['toolExecution']> }

/** A view of retained Core bindings. Creating and continuing work stay with the original workbench. */
export function RemoteExecutionSettingsPane({ config, active, onClose, onNavigate, navigationRequest }: SettingsPaneProps) {
  const sessions = useAppStore(state => active ? state.sessions : NO_SESSIONS)
  const names = useAppStore(state => active ? state.agentNames : NO_NAMES)
  const activeWorkspaceId = useAppStore(state => state.activeWorkspaceId)
  const navigation = useContext(SettingsNavigation)
  const projects = config.workspaces.filter(workspace => !isScratchWorkspaceId(workspace.id))
  const localProjects = projects.filter(project => config.hosts.find(host => host.id === project.hostId)?.kind === 'local')
  const [projectId, setProjectId] = useState(() => localProjects.find(workspace => workspace.id === activeWorkspaceId)?.id ?? '')
  const [agentHostId, setAgentHostId] = useState(''), [startupId, setStartupId] = useState('')
  const [preparing, setPreparing] = useState(false)
  const preparation = useRef<AbortController | null>(null)
  function invalidatePreparation() { preparation.current?.abort(); preparation.current = null; setPreparing(false); setActionError(null) }
  useEffect(() => { if (!active) invalidatePreparation(); return () => { preparation.current?.abort(); preparation.current = null } }, [active])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'library' | 'detail'>('library')
  useLayoutEffect(() => {
    if (active && navigationRequest?.field === 'guide') setView('library')
  }, [active, navigationRequest])
  const [narrow, setNarrow] = useState(false)
  const [returnFocus, setReturnFocus] = useState<{ id: string | null } | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => { const width = element.getBoundingClientRect().width; if (width > 0) setNarrow(width <= 720) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!active || !narrow || view !== 'detail') return
    detailHeading.current?.focus({ preventScroll: true })
    detailHeading.current?.closest('.remote-execution-bindings')?.scrollIntoView?.({ block: 'start' })
  }, [active, narrow, view, selectedId])
  const [query, setQuery] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const bindings = useMemo(() => sessions.filter((session): session is BoundAgent => session.kind === 'agent' && Boolean(session.toolExecution)), [sessions])
  function hostName(id: string) {
    const host = config.hosts.find(item => item.id === id)
    if (!host) return id
    return config.hosts.some(item => item.id !== id && item.label === host.label) ? `${host.label} (${id})` : host.label
  }
  const agentName = (session: BoundAgent) => resolveAgentName({ userName: names[session.id], fallback: session.label }).name
  const observedSelected = bindings.find(session => session.id === selectedId)
  // Visibility ends the reader, not the selected component's inspection or reading state.
  const retainedSelected = useRef<BoundAgent | undefined>(undefined)
  if (active) retainedSelected.current = observedSelected
  const selected = active ? observedSelected : retainedSelected.current
  const detailVisible = !narrow || view === 'detail'
  const projectNames = useMemo(() => {
    const names = new Map<string, string[]>()
    for (const project of config.workspaces) {
      const key = JSON.stringify([project.hostId, project.path])
      names.set(key, [...(names.get(key) ?? []), project.name])
    }
    return names
  }, [config.workspaces])
  const resourceProject = (session: BoundAgent) => projectNames.get(JSON.stringify([session.toolExecution.resourceHostId, session.toolExecution.workspacePath]))?.join(' · ')
  const preparedProject = projects.find(project => project.id === projectId)
  const rows = bindings.filter(session => `${agentName(session)} ${session.id} ${session.toolExecution.bindingId} ${hostName(session.control.hostId)} ${session.control.hostId} ${hostName(session.toolExecution.resourceHostId)} ${session.toolExecution.resourceHostId} ${session.toolExecution.workspacePath} ${resourceProject(session) ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  function openHost(id: string) {
    if (navigation) navigation.openHost(id)
    else onNavigate('hosts')
  }
  async function prepare() {
    invalidatePreparation()
    const state = useAppStore.getState(), project = state.config?.workspaces.find(item => item.id === projectId && !isScratchWorkspaceId(item.id))
    const host = state.config?.hosts.find(item => item.id === agentHostId)
    if (!project || !host) { setActionError('Choose the project and the device where the Agent will run.'); return }
    const { label: _label, ...route } = host
    const controller = new AbortController(), selection = fileNavigationSelection(state)
    preparation.current = controller; setPreparing(true)
    let navigationChanged = false
    const stop = useAppStore.subscribe(current => { if (fileNavigationSelection(current) !== selection) { navigationChanged = true; controller.abort() } })
    try {
      const startup = startupId ? state.config?.workspaces.find(item => item.id === startupId && item.hostId === host.id && !isScratchWorkspaceId(item.id))
        : host.id === project.hostId ? null : await useAppStore.getState().prepareAgentHostWorkspace(host.id, { signal: controller.signal })
      if (controller.signal.aborted || preparation.current !== controller || navigationChanged) return
      const current = useAppStore.getState().config, currentProject = current?.workspaces.find(item => item.id === project.id)
      const { label: _currentLabel, ...currentRoute } = current?.hosts.find(item => item.id === host.id) ?? {}
      if (startupId && !startup || !currentProject || currentProject.hostId !== project.hostId || currentProject.path !== project.path || !configValuesEqual(currentRoute, route)) throw new Error('The selected folder or Agent device changed. Choose its current entry and retry.')
      const tabId = useAppStore.getState().openLauncher({ workspaceId: project.id, reveal: true,
        initialExecution: { resourceWorkspaceId: project.id, agentWorkspaceId: startup?.id ?? null } })
      if (!tabId) throw new Error('The original Launcher could not be opened. Existing work and drafts are retained.')
      onClose()
    } catch (cause) { if (!controller.signal.aborted && preparation.current === controller) setActionError(cause instanceof Error ? cause.message : 'The Agent device could not be prepared. Retry this selection.') }
    finally { stop(); if (preparation.current === controller) { preparation.current = null; setPreparing(false) } }
  }
  function openOriginal(session: BoundAgent) {
    setActionError(null)
    if (useAppStore.getState().selectSession(session.id)) onClose()
    else setActionError('The original workface could not be selected. Its Session is retained; check its exact Tab and Region in the workspace notice.')
  }
  return <div ref={container} className="settings-pane-stack remote-execution-settings">
    <section hidden={narrow && view === 'detail'} className="settings-group remote-execution-prepare" data-settings-field="prepare">
      <header><span>Work on your project with another device</span><button type="button" className="small-button" onClick={() => onNavigate('hosts')}>Manage Hosts<OpenIcon size={13} /></button></header>
      <p className="settings-group-note">{preparedProject && config.hosts.find(host => host.id === preparedProject.hostId)?.kind !== 'local' ? `Files and commands stay on ${hostName(preparedProject.hostId)}. Choose where the Agent runs.` : 'Your task and files stay on this Mac. The Agent runs on the device you choose.'}</p>
      <div className="remote-execution-prepare__controls">
        <label><span>{preparedProject && !localProjects.some(item => item.id === preparedProject.id) ? 'Files & tools · Advanced' : 'Project on this Mac'}</span>
          <select aria-label="Project for remote Agent" value={projectId} onChange={event => { invalidatePreparation(); setProjectId(event.target.value) }}>
            <option value="">Choose a project…</option>
            {projectId && !localProjects.some(item => item.id === projectId) ? <option value={projectId}>{preparedProject ? `${preparedProject.name} · ${hostName(preparedProject.hostId)}` : 'Selected project · unavailable'}</option> : null}
            {localProjects.map(project => <option value={project.id} key={project.id}>{project.name}{localProjects.some(other => other.id !== project.id && other.name === project.name) ? ` · ${project.path}` : ''}</option>)}
          </select>
        </label>
        <AgentDeviceSelect hosts={config.hosts} value={agentHostId} busy={preparing} onChange={hostId => { invalidatePreparation(); setAgentHostId(hostId); setStartupId('') }} />
        <button type="button" className="primary-button" data-remote-prepare disabled={preparing || !projectId || !agentHostId} onClick={() => void prepare()}>{preparing ? 'Preparing…' : 'Open in Launcher'}<ArrowIcon size={14} /></button>
      </div>
      {preparedProject ? <div className="remote-execution-prepare__target" aria-label="Selected project identity"><code>{preparedProject.path}</code></div> : <p className="settings-group-note">Choose a local folder to continue. A Git repository is optional.</p>}
      <details className="remote-execution-advanced"><summary>Advanced arrangement</summary><div className="remote-execution-prepare__controls">
        <label><span>Files & tools</span><select aria-label="Files and tools" value={projectId} onChange={event => { invalidatePreparation(); setProjectId(event.target.value) }}>
          <option value="">Choose a folder…</option>{projects.map(project => <option value={project.id} key={project.id}>{hostName(project.hostId)} · {project.name} · {project.path}</option>)}
        </select></label>
        <label><span>Agent startup directory</span><select aria-label="Agent startup directory" value={startupId} disabled={!agentHostId} onChange={event => { invalidatePreparation(); setStartupId(event.target.value) }}>
          <option value="">{agentHostId === preparedProject?.hostId ? 'Follow project directory' : 'Device home'}</option>
          {projects.filter(project => project.hostId === agentHostId).map(project => <option value={project.id} key={project.id}>{project.name} · {project.path}</option>)}
        </select></label>
      </div>{preparedProject ? <div className="remote-execution-prepare__target" aria-label="Files and tools identity"><strong>{preparedProject.name}</strong><span>{hostName(preparedProject.hostId)} · <code>{preparedProject.hostId}</code></span><code>{preparedProject.path}</code></div> : null}<p className="settings-group-note">Startup directory supplies native configuration and Skills. Files and commands use the selected project.</p></details>
      <p className="remote-execution-caption">Choose the Agent configuration and enter your task in the Launcher. No Agent starts here.</p>
      <RemoteExecutionGuide active={active} />
    </section>

    {actionError ? <p className="remote-execution-feedback" role="status">{actionError}</p> : null}
    <section className="settings-group remote-execution-bindings" data-settings-field="bindings">
      <header><span>Cross-device Agents</span><small>{bindings.length} retained in this client</small></header>
      {bindings.length ? <p className="settings-group-note">Open the original work or inspect its two environments. This list reflects this client’s retained Sessions.</p> : null}
      {narrow && view === 'detail' ? <button type="button" className="small-button remote-execution-back" onClick={() => { setView('library'); setReturnFocus({ id: selectedId }) }}><BackIcon size={14} />Back to bindings</button> : null}
      {!bindings.length && !selectedId ? <p className="settings-group-note">No cross-device Agents yet.</p> : <div className="remote-execution-bindings__body">
        <div hidden={narrow && view === 'detail'} className="remote-execution-library">
        <SettingsResourceLibrary label="Cross-device Agents" query={query} onQuery={setQuery} selectedId={selectedId} focusRequest={returnFocus}
          onSelect={id => { setSelectedId(id); setView('detail'); setActionError(null) }} items={rows.map(session => ({ id: session.id, name: agentName(session),
            detail: `Agent: ${hostName(session.control.hostId)}\nTools: ${hostName(session.toolExecution.resourceHostId)}\n${resourceProject(session) ? `${resourceProject(session)} · ` : ''}${session.toolExecution.workspacePath}`,
            mark: <ResolvedAgentAvatar label={agentName(session)} providerId={session.providerId} executorId={session.executorId} state={session.status.state} size={26} /> }))} />
        </div>
        {selected ? <div hidden={!detailVisible} className="remote-execution-detail" data-remote-binding={selected.toolExecution.bindingId}>
          <header><div><h3 ref={detailHeading} tabIndex={-1}>{agentName(selected)}</h3><span>Agent · {sessionStatusLabel(selected)}</span></div>
            <button type="button" className="small-button" data-remote-open onClick={() => openOriginal(selected)}>Open original work<OpenIcon size={13} /></button></header>
          <dl className="remote-execution-endpoints">
            <div><dt><AgentIcon size={16} />Agent runtime</dt><dd><button type="button" onClick={() => openHost(selected.control.hostId)}>{hostName(selected.control.hostId)}<OpenIcon size={12} /></button><code>{selected.control.hostId}</code><span>{selected.workspacePath}</span></dd></div>
            <div><dt><ToolsIcon size={16} />Project &amp; tools</dt><dd><button type="button" onClick={() => openHost(selected.toolExecution.resourceHostId)}>{hostName(selected.toolExecution.resourceHostId)}<OpenIcon size={12} /></button><code>{selected.toolExecution.resourceHostId}</code><span>{selected.toolExecution.workspacePath}</span></dd></div>
          </dl>
          <AgentToolExecutionNotice key={selected.toolExecution.bindingId} session={selected} visible={active && detailVisible} presentation="inline" />
          <details className="remote-execution-identities"><summary>Original identities</summary><dl><dt>Session</dt><dd>{selected.control.agentSessionId}</dd><dt>Binding</dt><dd>{selected.toolExecution.bindingId}</dd></dl></details>
        </div> : <div className="remote-execution-empty"><AgentIcon size={28} aria-hidden="true" /><h3>{selectedId ? 'Binding not observed' : bindings.length ? 'Choose a binding' : 'No cross-device Agents yet'}</h3><p>{selectedId ? 'This client no longer exposes that reference. No Session has been stopped or replaced.' : bindings.length ? 'See where it runs, where its tools work, and what the original service reports.' : 'Open a Launcher above. Its execution binding will appear here when this client receives the original Session.'}</p></div>}
      </div>}
    </section>
  </div>
}
