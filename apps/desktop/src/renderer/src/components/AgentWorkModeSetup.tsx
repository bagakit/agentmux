import { useContext, useEffect, useId, useRef, useState, type RefObject } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import type { AppConfig } from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import { configValuesEqual } from '../../../shared/config-edit'
import { fileNavigationSelection, useAppStore, type LauncherExecutionSelection } from '../store'
import { AGENT_WORK_MODES, agentWorkMode, workHostLabel, workReferenceHostId, type AgentWorkMode } from '../lib/agent-work-mode'
import { SelectionField } from './SelectionField'
import { AgentWorkModePlacement } from './AgentWorkModePlacement'
import { SettingsNavigation } from './SettingsNavigation'
import './agent-work-mode.css'
import { SourceAgentTargetSetup } from './SourceAgentTargetSetup'
import { AgentWorkProjectAnchor } from './AgentWorkProjectAnchor'

type Config = Pick<AppConfig, 'hosts' | 'workspaces'>

/** Edits one prospective arrangement. The original Store owns addresses, registration and creation. */
export function AgentWorkModeSetup(props: AgentWorkModeSetupProps) {
  const settings = useContext(SettingsNavigation)
  const [sourceSelection, setSourceSelection] = useState(Boolean(props.sourceTargets && (!props.initialSelection?.agentWorkspaceId || props.initialSelection.source)))
  const anchored = props.presentation === 'anchored-editor'
  const setupRef = useRef<HTMLDivElement>(null), previousSourceSelection = useRef(sourceSelection)
  useEffect(() => {
    const changed = previousSourceSelection.current !== sourceSelection
    previousSourceSelection.current = sourceSelection
    if (!changed || !props.active) return
    const ownerDocument = setupRef.current?.ownerDocument
    const ownerWindow = ownerDocument?.defaultView ?? window
    const focusAtSchedule = ownerDocument?.activeElement
    const frame = ownerWindow.requestAnimationFrame(() => {
      if (ownerDocument?.activeElement !== focusAtSchedule) return
      const target = setupRef.current?.querySelector<HTMLButtonElement>('[aria-label="Agent runs on"]:not([disabled])')
        ?? setupRef.current?.querySelector<HTMLButtonElement>('.agent-work-setup__actions button:not([disabled])')
        ?? setupRef.current
      target?.focus({ preventScroll: true })
    })
    return () => ownerWindow.cancelAnimationFrame(frame)
  }, [sourceSelection, props.active])
  if (props.sourceTargets && sourceSelection) return <>
    <SourceAgentTargetSetup {...props} setupRef={setupRef} onChooseCustom={anchored ? () => setSourceSelection(false) : undefined} onOpenHost={props.onOpenHost ?? (settings ? id => settings.openHost(id) : undefined)} />
    {!anchored ? <button className="agent-work-text-action" type="button" onClick={() => setSourceSelection(false)}>Choose a custom startup directory</button> : null}
  </>
  return <><LegacyAgentWorkModeSetup {...props} setupRef={setupRef} onChooseSource={anchored ? () => setSourceSelection(true) : undefined} />{props.sourceTargets && !anchored ? <button className="agent-work-text-action" type="button"
    onClick={() => setSourceSelection(true)}>Choose through the project device and its saved routes</button> : null}</>
}
type AgentWorkModeSetupProps = {
  config: Config
  active: boolean
  initialSelection?: LauncherExecutionSelection | undefined
  initialMode?: AgentWorkMode | undefined
  /** A project Launcher changes only its Agent end; global preparation leaves this unset. */
  fixedResourceWorkspaceId?: string | undefined
  allowLocal?: boolean
  actionLabel: string
  preparationNote?: string | undefined
  disabled?: boolean
  /** Ordinary Launcher/Remote only. Goal keeps its original finite arrangement contract. */
  sourceTargets?: boolean
  onApply(selection: LauncherExecutionSelection): boolean | void | Promise<boolean | void>
  onCancel?: (() => void) | undefined
  onOpenHost?: ((hostId: string) => void) | undefined
  presentation?: 'anchored-editor' | undefined
  menuBoundary?: HTMLElement | null | undefined
  onChooseCustom?: (() => void) | undefined
  onChooseSource?: (() => void) | undefined
  setupRef?: RefObject<HTMLDivElement | null> | undefined
}
function LegacyAgentWorkModeSetup({ config, active, initialSelection, initialMode, fixedResourceWorkspaceId, allowLocal = false, actionLabel, preparationNote, disabled = false, onApply, onCancel, onOpenHost, presentation, menuBoundary, onChooseSource, setupRef }: AgentWorkModeSetupProps) {
  const settings = useContext(SettingsNavigation), group = useId()
  const fixedProject = fixedResourceWorkspaceId !== undefined
  const initialProject = config.workspaces.find(item => item.id === (fixedResourceWorkspaceId ?? initialSelection?.resourceWorkspaceId))
  const reference = fixedProject ? initialProject?.hostId ?? null : workReferenceHostId(config.hosts)
  const initialAgent = config.workspaces.find(item => item.id === (initialSelection?.agentWorkspaceId ?? initialProject?.id))
  const observedMode = agentWorkMode(reference, initialAgent?.hostId ?? null, initialProject?.hostId ?? null)
  const modeOptions = AGENT_WORK_MODES.filter(item => allowLocal || item.id !== 'local')
  const [mode, setMode] = useState<AgentWorkMode>(() => initialMode ?? (observedMode === 'unknown' || !fixedProject && !allowLocal && observedMode === 'local' ? 'remote-agent' : observedMode))
  const [projectId, setProjectId] = useState(initialProject?.id ?? '')
  const [folderHostId, setFolderHostId] = useState(initialProject?.hostId ?? '')
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
  const project = fixedProject ? initialProject : projects.find(item => item.id === projectId)
  const projectHostId = project?.hostId ?? (fixedProject ? null : wantsLocalProject ? reference : folderHostId && folderHostId !== reference ? folderHostId : null)
  const projectHost = config.hosts.find(item => item.id === projectHostId)
  const agentHostId = mode === 'local' || mode === 'remote-project' ? reference : mode === 'remote-workspace' && !agentId ? projectHostId : agentId || null
  const agentHost = config.hosts.find(item => item.id === agentHostId)
  const startup = config.workspaces.find(item => item.id === startupId && item.hostId === agentHostId)
  const projectOptions = [{ value: '', label: 'The device home', description: 'No project needed · confirmed when you prepare' },
    ...projects.map(item => ({ value: item.id, label: item.name, description: `${workHostLabel(config.hosts, item.hostId)} · ${item.path}` }))]
  const agentOptions = [
    { value: '', label: mode === 'remote-workspace' ? 'The working folder’s device' : 'Choose a remote device…' },
    ...config.hosts.filter(host => host.id !== reference).map(host => ({ value: host.id, label: workHostLabel(config.hosts, host.id) }))
  ]
  const fixedAgentOptions = [{ value: '', label: 'Choose an Agent device…' }, ...config.hosts.map(host => ({
    value: host.id, label: workHostLabel(config.hosts, host.id),
    description: host.id === projectHostId ? 'Project device' : 'Outpost · files stay with this project'
  }))]
  function changeAgentDevice(id: string) {
    // Re-selecting a device preserves its chosen startup directory and pending preparation.
    if (id === (agentHostId ?? '')) return
    invalidate(); setMode(id === reference ? 'local' : 'remote-agent'); setAgentId(id === reference ? '' : id); setStartupId('')
  }
  function changeMode(next: AgentWorkMode) {
    invalidate(); setMode(next); setStartupId(''); setAgentId('')
    if (fixedProject) return
    const localProject = next === 'local' || next === 'remote-agent'
    const selected = config.workspaces.find(item => item.id === projectId)
    if (!selected || (selected.hostId === reference) !== localProject) { setProjectId(''); setFolderHostId('') }
  }
  const hostRoute = (host: Config['hosts'][number]) => { if (host.kind === 'local') return { id: host.id, kind: host.kind }; const { label: _label, ...route } = host; return route }
  async function prepare() {
    if (disabled || pending || !active || !projectHost || !agentHost || unavailableProject) return
    invalidate()
    const controller = new AbortController(), originalProject = project ? { ...project } : null,
      originalFolderHost = hostRoute(projectHost), originalAgent = hostRoute(agentHost)
    request.current = controller; setPending(true)
    const state = useAppStore.getState(), navigation = fileNavigationSelection(state)
    const stop = useAppStore.subscribe(current => { if (fileNavigationSelection(current) !== navigation) controller.abort() })
    try {
      const selectedStartup = startupId ? startup : null
      if (startupId && !selectedStartup) throw new Error('The selected Agent startup directory is unavailable. Choose its current entry.')
      const folder = project ?? await useAppStore.getState().prepareAgentHostWorkspace(projectHost.id, { signal: controller.signal })
      if (controller.signal.aborted || request.current !== controller || !visible.current) return
      const prepared = selectedStartup ?? (agentHost.id === folder.hostId ? null
        : await useAppStore.getState().prepareAgentHostWorkspace(agentHost.id, { signal: controller.signal }))
      if (controller.signal.aborted || request.current !== controller || !visible.current) return
      const current = useAppStore.getState().config
      const currentProject = current?.workspaces.find(item => item.id === folder.id)
      const currentFolderHost = current?.hosts.find(item => item.id === projectHost.id)
      const currentAgent = current?.hosts.find(item => item.id === agentHost.id)
      const currentStartup = prepared ? current?.workspaces.find(item => item.id === prepared.id) : null
      if (!currentProject || currentProject.hostId !== folder.hostId || currentProject.path !== folder.path ||
        originalProject && (currentProject.id !== originalProject.id || currentProject.hostId !== originalProject.hostId || currentProject.path !== originalProject.path) ||
        !currentFolderHost || !configValuesEqual(hostRoute(currentFolderHost), originalFolderHost) ||
        !currentAgent || !configValuesEqual(hostRoute(currentAgent), originalAgent) ||
        prepared && (!currentStartup || currentStartup.hostId !== agentHost.id || currentStartup.path !== prepared.path))
        throw new Error('The selected folder or device changed. Your original arrangement is kept; choose its current entry.')
      const selection = { resourceWorkspaceId: currentProject.id, agentWorkspaceId: prepared?.id ?? null }
      const applied = await onApply(selection)
      if (applied === false) throw new Error('The original Launcher could not accept this arrangement. Your selection and draft are kept.')
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller && visible.current)
        setError(cause instanceof Error ? cause.message : 'This arrangement could not be prepared. Retry the same selection.')
    } finally { stop(); if (request.current === controller) { request.current = null; setPending(false) } }
  }
  function openHost(id: string | null) { if (id) { if (onOpenHost) onOpenHost(id); else settings?.openHost(id) } }
  const hostActionClass = presentation === 'anchored-editor' ? 'small-button' : 'agent-work-text-action'
  const hostLinks = projectHost ? <div className="agent-work-setup__host-links"><button type="button" className={hostActionClass} onClick={() => openHost(projectHost.id)}>Project device settings</button>
    {agentHostId && agentHostId !== projectHost.id ? <button type="button" className={hostActionClass} onClick={() => openHost(agentHostId)}>Agent device settings</button> : null}</div> : null
  const unavailableProject = fixedProject ? !project || mode !== 'local' && mode !== 'remote-agent' : projectId && !projects.some(item => item.id === projectId)
  return <div ref={setupRef} tabIndex={-1} className={`agent-work-setup${allowLocal ? ' agent-work-setup--local' : ''}`} data-work-mode={mode} data-fixed-project={fixedProject || undefined} data-presentation={presentation} aria-busy={pending || undefined}>
    <div className="agent-work-setup__body">
    {fixedProject ? <>
      <AgentWorkProjectAnchor project={project} hostLabel={workHostLabel(config.hosts, projectHostId)} compact={presentation === 'anchored-editor'} showIcon />
      <div className="agent-work-device-choice"><span className="agent-work-end__label">Agent runs on</span>
        <SelectionField label="Agent runs on" value={agentHostId ?? ''} options={fixedAgentOptions} disabled={disabled || !active} onValueChange={changeAgentDevice} menuBoundary={menuBoundary ?? null} />
        <span className="agent-work-setup__note">{agentHostId === projectHostId ? 'Agent and files on this project’s device.'
          : agentHostId ? 'Outpost · files and tools stay with this project.' : 'Choose the device that will run the Agent.'}</span>
      </div>
    </> : <>
    <fieldset className="agent-work-mode-choices" disabled={disabled || !active}>
      <legend>Work mode <span>From {workHostLabel(config.hosts, reference)}</span></legend>
      <div className="agent-work-mode-choices__options">{modeOptions.map(item =>
        <label className="agent-work-mode-choice" data-selected={mode === item.id || undefined} key={item.id}>
          <AgentWorkModePlacement mode={item.id} />
          <span className="agent-work-mode-choice__copy"><span className="agent-work-mode-choice__name"><strong>{item.brand}</strong>{item.brand !== item.label ? <span>{item.label}</span> : null}</span><small>{item.description}</small></span>
          <input type="radio" name={group} value={item.id} checked={mode === item.id} aria-label={`${item.brand === item.label ? item.label : `${item.brand} · ${item.label}`}: ${item.description}`} onChange={() => changeMode(item.id)} />
        </label>)}</div>
    </fieldset>
    <div className="agent-work-ends" aria-label="Files and Agent placement">
      <div className="agent-work-end"><span className="agent-work-end__label">Working folder</span>
        <SelectionField label="Working folder for this arrangement" value={projectId} options={projectOptions} disabled={disabled || !active} menuBoundary={menuBoundary ?? null}
          onValueChange={id => { invalidate(); setProjectId(id); setStartupId(''); const selected = projects.find(item => item.id === id); if (selected) setFolderHostId(selected.hostId) }} />
        {!project && !wantsLocalProject ? <SelectionField label="Working folder device" value={folderHostId} disabled={disabled || !active} menuBoundary={menuBoundary ?? null}
          options={[{ value: '', label: 'Choose a remote device…' }, ...config.hosts.filter(host => host.id !== reference).map(host => ({ value: host.id, label: workHostLabel(config.hosts, host.id) }))]}
          onValueChange={id => { invalidate(); setFolderHostId(id); setStartupId('') }} /> : null}
        <span className="agent-work-end__host">{workHostLabel(config.hosts, projectHostId)}</span>
        {project ? <code title={project.path}>{project.path}</code> : <span className="agent-work-end__empty">{unavailableProject ? 'The original folder is not available in this mode.' : 'Files and commands use this folder. The device home is read only when you prepare.'}</span>}
      </div>
      <div className="agent-work-end"><span className="agent-work-end__label">Agent</span>
        {mode === 'remote-agent' || mode === 'remote-workspace'
          ? <SelectionField label="Agent runs on" value={agentId} options={agentOptions} disabled={disabled || !active} menuBoundary={menuBoundary ?? null}
            onValueChange={id => { invalidate(); setAgentId(id); setStartupId('') }} />
          : <span className="agent-work-end__fixed">{workHostLabel(config.hosts, reference)}</span>}
        {!agentHost ? <span className="agent-work-end__empty">Choose the Agent device</span> : null}
        <code>{startup?.path ?? (agentHostId && agentHostId === projectHostId && project ? project.path : 'Confirmed device home at preparation')}</code>
      </div>
    </div>
    </>}
    <details className="agent-work-startup"><summary>{presentation === 'anchored-editor' ? 'Startup & device details' : <>Agent startup directory <span>Configuration &amp; Skills</span></>}</summary>
      <div className="agent-work-setup__details-body">
      <SelectionField label="Agent starts in" value={startupId} disabled={disabled || !agentHostId || !active} menuBoundary={menuBoundary ?? null}
        options={[{ value: '', label: agentHostId === projectHostId ? 'The working folder' : 'The device home' },
          ...config.workspaces.filter(item => item.hostId === agentHostId && !isScratchWorkspaceId(item.id)).map(item => ({ value: item.id, label: item.name, description: item.path }))]}
        onValueChange={id => { invalidate(); setStartupId(id) }} />
      <p className="agent-work-setup__note">Native settings and Skills load here. Files and commands use the working folder.</p>
      {fixedProject ? hostLinks : null}
      {onChooseSource ? <div className="agent-work-setup__utility-actions"><Button type="button" className="agent-work-setup__source-routes" onClick={onChooseSource}>Choose through the project device and its saved routes</Button></div> : null}
      </div>
    </details>
    {!fixedProject ? hostLinks : null}
    {error ? <p className="agent-work-setup__error" role="status">{error}</p> : null}
    </div>
    <footer className="agent-work-setup__actions"><span>{preparationNote ?? (fixedProject ? 'Applies to this Launcher. Launch starts the task.' : initialSelection?.resourceWorkspaceId && project && project.id !== initialSelection.resourceWorkspaceId ? 'A different project opens its own Launcher. Original drafts stay with their project.' : 'Preparing this arrangement starts no Agent.')}</span><div>
      {onCancel ? <Button type="button" onClick={onCancel}>Cancel</Button> : null}
      <Button type="button" variant="primary" disabled={disabled || pending || !active || !projectHost || !agentHost || Boolean(unavailableProject)} onClick={() => void prepare()}>{pending ? 'Preparing…' : actionLabel}</Button>
    </div></footer>
  </div>
}
