import { useContext, useEffect, useId, useRef, useState } from 'react'
import type { AppConfig } from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import { configValuesEqual } from '../../../shared/config-edit'
import { fileNavigationSelection, useAppStore, type LauncherExecutionSelection } from '../store'
import { AGENT_WORK_MODES, agentWorkMode, workHostLabel, workReferenceHostId, type AgentWorkMode } from '../lib/agent-work-mode'
import { SelectionField } from './SelectionField'
import { SettingsNavigation } from './SettingsNavigation'
import './agent-work-mode.css'

type Config = Pick<AppConfig, 'hosts' | 'workspaces'>

/** Edits one prospective arrangement. The original Store owns addresses, registration and creation. */
export function AgentWorkModeSetup({ config, active, initialSelection, initialMode, allowLocal = false, actionLabel, preparationNote, disabled = false, onApply, onCancel, onOpenHost }: {
  config: Config
  active: boolean
  initialSelection?: LauncherExecutionSelection | undefined
  initialMode?: AgentWorkMode | undefined
  allowLocal?: boolean
  actionLabel: string
  preparationNote?: string | undefined
  disabled?: boolean
  onApply(selection: LauncherExecutionSelection): boolean | void | Promise<boolean | void>
  onCancel?: (() => void) | undefined
  onOpenHost?: ((hostId: string) => void) | undefined
}) {
  const settings = useContext(SettingsNavigation), group = useId()
  const reference = workReferenceHostId(config.hosts)
  const initialProject = config.workspaces.find(item => item.id === initialSelection?.resourceWorkspaceId)
  const initialAgent = config.workspaces.find(item => item.id === (initialSelection?.agentWorkspaceId ?? initialProject?.id))
  const observedMode = agentWorkMode(reference, initialAgent?.hostId ?? null, initialProject?.hostId ?? null)
  const [mode, setMode] = useState<AgentWorkMode>(() => initialMode ?? (observedMode === 'unknown' || !allowLocal && observedMode === 'local' ? 'remote-agent' : observedMode))
  const [projectId, setProjectId] = useState(initialProject?.id ?? '')
  const [agentId, setAgentId] = useState(initialAgent && initialAgent.hostId !== reference && initialAgent.hostId !== initialProject?.hostId ? initialAgent.hostId
    : observedMode === 'remote-agent' ? initialAgent?.hostId ?? '' : '')
  const [startupId, setStartupId] = useState(initialSelection?.agentWorkspaceId ?? '')
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const visible = useRef(active); visible.current = active
  function invalidate() { request.current?.abort(); request.current = null; setPending(false); setError(null) }
  useEffect(() => { if (!active) invalidate(); return () => { request.current?.abort(); request.current = null } }, [active])

  const wantsLocalProject = mode === 'local' || mode === 'remote-agent'
  const projects = config.workspaces.filter(item => !isScratchWorkspaceId(item.id) &&
    (wantsLocalProject ? item.hostId === reference : item.hostId !== reference))
  const project = projects.find(item => item.id === projectId)
  const agentHostId = mode === 'local' || mode === 'remote-project' ? reference : mode === 'remote-workspace' && !agentId ? project?.hostId ?? null : agentId || null
  const agentHost = config.hosts.find(item => item.id === agentHostId)
  const startup = config.workspaces.find(item => item.id === startupId && item.hostId === agentHostId)
  const projectOptions = [{ value: '', label: wantsLocalProject ? 'Choose a project on this device…' : 'Choose a remote project…' },
    ...projects.map(item => ({ value: item.id, label: item.name, description: `${workHostLabel(config.hosts, item.hostId)} · ${item.path}` }))]
  const agentOptions = [
    { value: '', label: mode === 'remote-workspace' ? 'The project device' : 'Choose a remote device…' },
    ...config.hosts.filter(host => host.id !== reference).map(host => ({ value: host.id, label: workHostLabel(config.hosts, host.id) }))
  ]
  function changeMode(next: AgentWorkMode) {
    invalidate(); setMode(next); setStartupId(''); setAgentId('')
    const localProject = next === 'local' || next === 'remote-agent'
    const selected = config.workspaces.find(item => item.id === projectId)
    if (!selected || (selected.hostId === reference) !== localProject) setProjectId('')
  }
  const hostRoute = (host: Config['hosts'][number]) => { if (host.kind === 'local') return { id: host.id, kind: host.kind }; const { label: _label, ...route } = host; return route }
  async function prepare() {
    if (disabled || pending || !active || !project || !agentHost) return
    invalidate()
    const controller = new AbortController(), originalProject = { ...project }, originalAgent = hostRoute(agentHost)
    request.current = controller; setPending(true)
    const state = useAppStore.getState(), navigation = fileNavigationSelection(state)
    const stop = useAppStore.subscribe(current => { if (fileNavigationSelection(current) !== navigation) controller.abort() })
    try {
      const selectedStartup = startupId ? startup : null
      if (startupId && !selectedStartup) throw new Error('The selected Agent startup directory is unavailable. Choose its current entry.')
      const prepared = selectedStartup ?? (agentHost.id === project.hostId ? null
        : await useAppStore.getState().prepareAgentHostWorkspace(agentHost.id, { signal: controller.signal }))
      if (controller.signal.aborted || request.current !== controller || !visible.current) return
      const current = useAppStore.getState().config
      const currentProject = current?.workspaces.find(item => item.id === originalProject.id)
      const currentAgent = current?.hosts.find(item => item.id === agentHost.id)
      const currentStartup = prepared ? current?.workspaces.find(item => item.id === prepared.id) : null
      if (!currentProject || currentProject.hostId !== originalProject.hostId || currentProject.path !== originalProject.path ||
        !currentAgent || !configValuesEqual(hostRoute(currentAgent), originalAgent) ||
        prepared && (!currentStartup || currentStartup.hostId !== agentHost.id || currentStartup.path !== prepared.path))
        throw new Error('The selected project or Agent device changed. Your original arrangement is kept; choose its current entry.')
      const selection = { resourceWorkspaceId: currentProject.id, agentWorkspaceId: prepared?.id ?? null }
      const applied = await onApply(selection)
      if (applied === false) throw new Error('The original Launcher could not accept this arrangement. Your selection and draft are kept.')
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller && visible.current)
        setError(cause instanceof Error ? cause.message : 'This arrangement could not be prepared. Retry the same selection.')
    } finally { stop(); if (request.current === controller) { request.current = null; setPending(false) } }
  }
  function openHost(id: string | null) { if (id) { if (onOpenHost) onOpenHost(id); else settings?.openHost(id) } }
  const unavailableProject = projectId && !projects.some(item => item.id === projectId)
  return <div className={`agent-work-setup${allowLocal ? ' agent-work-setup--local' : ''}`} data-work-mode={mode} aria-busy={pending || undefined}>
    <fieldset className="agent-work-mode-choices" disabled={disabled || !active}>
      <legend>Work mode <span>From {workHostLabel(config.hosts, reference)}</span></legend>
      <div className="agent-work-mode-choices__options">{AGENT_WORK_MODES.filter(item => allowLocal || item.id !== 'local').map(item =>
        <label className="agent-work-mode-choice" data-selected={mode === item.id || undefined} key={item.id}>
          <input type="radio" name={group} value={item.id} checked={mode === item.id} onChange={() => changeMode(item.id)} />
          <span><strong>{item.label}</strong><small>{item.description}</small></span>
        </label>)}</div>
    </fieldset>
    <div className="agent-work-ends" aria-label="Project and Agent placement">
      <div className="agent-work-end"><span className="agent-work-end__label">Project</span>
        <SelectionField label="Project for this arrangement" value={projectId} options={projectOptions} disabled={disabled || !active}
          onValueChange={id => { invalidate(); setProjectId(id); setStartupId('') }} />
        <span className="agent-work-end__host">{project ? workHostLabel(config.hosts, project.hostId) : wantsLocalProject ? 'On this device' : 'On a remote Host'}</span>
        {project ? <code title={project.path}>{project.path}</code> : <span className="agent-work-end__empty">{unavailableProject ? 'The original project is not available in this mode.' : 'Choose an exact registered folder.'}</span>}
      </div>
      <div className="agent-work-end"><span className="agent-work-end__label">Agent</span>
        {mode === 'remote-agent' || mode === 'remote-workspace'
          ? <SelectionField label="Agent runs on" value={agentId} options={agentOptions} disabled={disabled || !active}
            onValueChange={id => { invalidate(); setAgentId(id); setStartupId('') }} />
          : <span className="agent-work-end__fixed">{workHostLabel(config.hosts, reference)}</span>}
        <span className="agent-work-end__host">{agentHost ? workHostLabel(config.hosts, agentHost.id) : 'Choose the Agent device'}</span>
        <code>{startup?.path ?? (agentHostId && agentHostId === project?.hostId ? project.path : 'Confirmed device home at preparation')}</code>
      </div>
    </div>
    {!projects.length ? <p className="agent-work-setup__note">No registered {wantsLocalProject ? 'local' : 'remote'} project is available. <button type="button" className="agent-work-text-action" onClick={() => settings?.open('hosts')}>Register a folder in Hosts</button></p> : null}
    <details className="agent-work-startup"><summary>Agent startup directory <span>Configuration &amp; Skills</span></summary>
      <SelectionField label="Agent starts in" value={startupId} disabled={disabled || !agentHostId || !active}
        options={[{ value: '', label: agentHostId === project?.hostId ? 'The project folder' : 'The device home' },
          ...config.workspaces.filter(item => item.hostId === agentHostId && !isScratchWorkspaceId(item.id)).map(item => ({ value: item.id, label: item.name, description: item.path }))]}
        onValueChange={id => { invalidate(); setStartupId(id) }} />
      <p className="agent-work-setup__note">Native settings and Skills load here. Files and commands use the project.</p>
    </details>
    {project ? <div className="agent-work-setup__host-links"><button type="button" className="agent-work-text-action" onClick={() => openHost(project.hostId)}>Project Host</button>
      {agentHostId && agentHostId !== project.hostId ? <button type="button" className="agent-work-text-action" onClick={() => openHost(agentHostId)}>Agent Host</button> : null}</div> : null}
    {error ? <p className="agent-work-setup__error" role="status">{error}</p> : null}
    <footer className="agent-work-setup__actions"><span>{preparationNote ?? (initialSelection?.resourceWorkspaceId && project && project.id !== initialSelection.resourceWorkspaceId ? 'A different project opens its own Launcher. Original drafts stay with their project.' : 'Preparing this arrangement starts no Agent.')}</span><div>
      {onCancel ? <button type="button" className="small-button" onClick={onCancel}>Cancel</button> : null}
      <button type="button" className="primary-button" disabled={disabled || pending || !active || !project || !agentHost} onClick={() => void prepare()}>{pending ? 'Preparing…' : actionLabel}</button>
    </div></footer>
  </div>
}
