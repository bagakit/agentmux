import { mintObjectId } from '@agentmux/core/object-id'
import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { HostIcon } from '../HostBadge'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useResourceDrafts } from './use-resource-drafts'
import { HostConnectionLibrary, HOST_PANELS, type HostConnectionPanel } from './HostConnectionLibrary'
import { HostProjectsPane } from './HostProjectsPane'
import type { AppConfig, HostConfig, SessionSnapshot, SshHostConfig, WorkspaceRecord } from '../../../../shared/contracts'
import { useAppStore, type HostCheckState } from '../../store'
import { currentHostCheck, hostCheckLabel } from '../../lib/host-check'
import { projectRailNavigation } from '../../lib/workspace-projects'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { ConfirmationDialog } from '../ConfirmationDialog'
import type { SettingsNavigationRequest } from '../SettingsNavigation'
import { HostUpgradePanel } from './HostUpgradePanel'
import { HostCreationTrustPanel } from './HostCreationTrustPanel'
import { HostTopology } from './HostTopology'
import { HostRuntimePanel } from './HostRuntimePanel'
import { HostNetworkPanel } from './HostNetworkPanel'
import { hostNetworkSummary } from './host-network-view'
import { HostNetworkMap } from './HostNetworkMap'
import { currentHostNetwork, useHostNetworkObservation } from './use-host-network-observation'
import { HostApplicationAccessPanel } from './HostApplicationAccessPanel'
import { HostSessionSummary, HostExecutorsSummary } from './HostWorkSummary'
import '../../styles/remote-management.css'
import './hosts-settings.css'

const ThemeObjectTopologyIcon = semanticIconComponent('object.topology')
const ThemeLayoutListIcon = semanticIconComponent('object.list')
const ThemeActionSearchIcon = semanticIconComponent('action.search')
const ThemeActionCreateHostIcon = semanticIconComponent('action.create-host')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')
const ThemeStatusInfoIcon = semanticIconComponent('status.info')
const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeActionRemoveIcon = semanticIconComponent('action.remove')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeObjectHostIcon = semanticIconComponent('object.host')


const NO_SESSIONS: SessionSnapshot[] = []
const NO_HOST_CHECKS: Record<string, HostCheckState> = {}

export function HostSettingsPane({ config, onSave, active, onClose, navigationRequest }: {
  config: AppConfig
  active: boolean
  onClose?: (() => void) | undefined
  navigationRequest?: SettingsNavigationRequest | undefined
  onSave: (hosts: HostConfig[], workspaces: WorkspaceRecord[], expected: Pick<AppConfig, 'hosts' | 'workspaces'>) => Promise<void>
}) {
  const resource = useResourceDrafts(Object.fromEntries(config.hosts.map((host) => [host.id, host])))
  // Host order belongs to the existing config array; a record's integer-like keys must not reorder it.
  function orderedHosts(records: Record<string, HostConfig>): HostConfig[] {
    const ids = new Set([...config.hosts.map((host) => host.id), ...Object.keys(records)])
    return [...ids].flatMap((id) => Object.hasOwn(records, id) ? [records[id]!] : [])
  }
  const hosts = orderedHosts(resource.value)
  const setHosts = (update: (current: HostConfig[]) => HostConfig[]) => resource.setValue((current) =>
    Object.fromEntries(update(orderedHosts(current)).map((host) => [host.id, host])))
  const requestedHostId = navigationRequest?.section === 'hosts' ? navigationRequest.hostId : undefined
  const [selectedId, setSelectedId] = useState<string | null>(() => requestedHostId ?? config.hosts[0]?.id ?? null)
  const [panel, setPanel] = useState<HostConnectionPanel>(() => requestedHostId === undefined ? 'overview' : 'connection')
  const [projectHosts, setProjectHosts] = useState<string[]>([])
  const [maintenanceHosts, setMaintenanceHosts] = useState<string[]>([])
  const [mode, setMode] = useState<'topology' | 'list'>('topology')
  const [measuredWide, setWide] = useState<boolean | null>(null)
  const wide = measuredWide !== false
  const container = useRef<HTMLDivElement>(null)
  const showTopology = mode === 'topology' && wide
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => { const width = element.getBoundingClientRect().width; if (width > 0) setWide(width >= 800) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const [view, setView] = useState<'library' | 'editor'>(() => requestedHostId === undefined ? 'library' : 'editor')
  const [filter, setFilter] = useState({ query: '', snapshot: [] as string[] })
  const [pendingEdit, setPendingEdit] = useState<{ id: string; select: boolean } | null>(null)
  const [returnFocus, setReturnFocus] = useState<{ id: string | null } | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState<Record<string, boolean>>({})
  const [requestedHost, setRequestedHost] = useState<string | null>(null)
  const appliedNavigation = useRef(navigationRequest)
  const pendingHostNavigation = requestedHostId !== undefined && appliedNavigation.current !== navigationRequest
  const network = useHostNetworkObservation(active && panel === 'overview' && !pendingHostNavigation && (measuredWide === true || view === 'editor')
    ? hosts.find(host => host.id === selectedId) ?? null : null)
  const editor = useRef<HTMLDivElement>(null)
  const [removeRequest, setRemoveRequest] = useState<SshHostConfig | null>(null)
  useEffect(() => { if (!active) setRemoveRequest(null) }, [active])
  const saveState = useSettingsSave()
  const { saving } = saveState
  const dirty = resource.dirty
  const checks = useAppStore((state) => active ? state.hostChecks : NO_HOST_CHECKS)
  const checkHost = useAppStore((state) => state.checkHost)
  const sessions = useAppStore((state) => active ? state.sessions : NO_SESSIONS)
  const projectFacts = useMemo(() => {
    const grouped = new Map<string, { count: number; search: string }>()
    for (const project of projectRailNavigation(config.workspaces).projects) {
      const previous = grouped.get(project.hostId)
      grouped.set(project.hostId, { count: (previous?.count ?? 0) + 1, search: `${previous?.search ?? ''} ${project.name} ${project.repoPath} ${project.workspaces.map(item => `${item.name} ${item.path}`).join(' ')}` })
    }
    return grouped
  }, [config.workspaces])
  const sessionsByHost = useMemo(() => {
    const grouped = new Map<string, SessionSnapshot[]>()
    for (const session of sessions) {
      const group = grouped.get(session.hostId)
      if (group) group.push(session)
      else grouped.set(session.hostId, [session])
    }
    return grouped
  }, [sessions])
  const selectTopologyHost = useCallback((id: string): void => {
    setRequestedHost(null)
    setSelectedId(id)
    setPanel('overview')
    setView('editor')
    setPendingEdit(null)
  }, [])

  useEffect(() => {
    appliedNavigation.current = navigationRequest
    if (navigationRequest?.section !== 'hosts' || navigationRequest.hostId === undefined) return
    const id = navigationRequest.hostId
    setRequestedHost(id)
    setMaintenanceHosts(current => current.includes(id) ? current : [...current, id])
    setSelectedId(id)
    setPanel('connection')
    setView('editor')
    setFilter({ query: '', snapshot: [] })
    setPendingEdit({ id, select: false })
  }, [navigationRequest])

  useEffect(() => {
    if (!pendingEdit || pendingEdit.id !== selectedId) return
    const name = editor.current?.querySelector<HTMLInputElement>('[data-host-name]')
    const target = name ?? editor.current?.querySelector<HTMLElement>('[data-resource-editor]')
    if (!target) return
    target.focus()
    if (name && pendingEdit.select) name.select()
    setPendingEdit(null)
  }, [pendingEdit, selectedId])

  const matches = (id: string) => !filter.query.trim() || filter.snapshot.includes(id)
  function filterHosts(query: string): void {
    const normalized = query.trim().toLowerCase()
    setFilter({ query, snapshot: hosts.filter((host) =>
      `${host.label} ${host.id} ${host.kind === 'ssh' ? `${host.hostname} ${host.user ?? ''}` : 'local computer'} ${projectFacts.get(host.id)?.search ?? ''}`.toLowerCase().includes(normalized)
    ).map((host) => host.id) })
  }
  function selectHost(id: string): void {
    setRequestedHost(null)
    setMaintenanceHosts(current => current.includes(id) ? current : [...current, id])
    setSelectedId(id)
    setView('editor')
    setPendingEdit({ id, select: false })
  }
  function selectHostPanel(id: string, panel: HostConnectionPanel): void {
    if (panel === 'projects') setProjectHosts(current => current.includes(id) ? current : [...current, id])
    setPanel(panel)
    selectHost(id)
  }
  function backToLibrary(): void {
    setView('library')
    if (selectedId) {
      if (!matches(selectedId)) setFilter({ query: '', snapshot: [] })
      setReturnFocus({ id: selectedId })
    }
  }

  function update(id: string, patch: Partial<SshHostConfig>): void {
    setHosts((current) => current.map((host) => host.id === id && host.kind === 'ssh' ? { ...host, ...patch } : host))
  }

  function clear(id: string, field: 'user' | 'port' | 'identityFile' | 'remoteCommand' | 'remoteSocketPath'): void {
    setHosts((current) => current.map((host) => {
      if (host.id !== id || host.kind !== 'ssh') return host
      const next = { ...host }
      delete next[field]
      return next
    }))
  }

  function addHost(): void {
    const id = mintObjectId()
    setMaintenanceHosts(current => [...current, id])
    setHosts((current) => [...current, {
      id,
      kind: 'ssh',
      label: 'Remote host',
      hostname: ''
    }])
    setSelectedId(id)
    setPanel('connection')
    setView('editor')
    setFilter({ query: '', snapshot: [] })
    setPendingEdit({ id, select: true })
  }

  async function save(nextHosts = hosts, nextWorkspaces = config.workspaces): Promise<boolean> {
    const submitted = resource.beginSave(Object.fromEntries(nextHosts.map((host) => [host.id, host])))
    const committed = await saveState.run(async () => {
      if (nextHosts.some((host) => host.kind === 'ssh' && (!host.label.trim() || !host.hostname.trim()))) {
        throw new Error('Every SSH host needs a name and hostname.')
      }
      await onSave(nextHosts, nextWorkspaces, { hosts: orderedHosts(submitted.expected), workspaces: config.workspaces })
    })
    submitted.finish(committed ? submitted.value : undefined)
    return committed
  }

  async function confirmRemove(): Promise<void> {
    const target = removeRequest
    if (!target) return
    const nextHosts = hosts.filter((host) => host.id !== target.id)
    const nextWorkspaces = config.workspaces.filter((workspace) => workspace.hostId !== target.id)
    if (await save(nextHosts, nextWorkspaces)) {
      setHosts((current) => current.filter((host) => host.id !== target.id))
      const next = nextHosts[0]?.id ?? null
      setSelectedId(next)
      setPanel('connection')
      setFilter({ query: '', snapshot: [] })
      setView('library')
      setReturnFocus({ id: next })
      setRemoveRequest(null)
    }
  }

  const selectedNetworkHost = hosts.find(host => host.id === selectedId)
  return (
    <div ref={container} className="settings-pane-stack settings-resource-workbench remote-management" data-resource-view={view} data-remote-mode={showTopology ? 'topology' : 'list'} data-remote-wide={wide}>
      <div className="settings-pane-toolbar remote-management__toolbar">
        {view === 'editor' && <button type="button" className="settings-resource-back small-button" onClick={backToLibrary}><ThemeNavigationBackIcon size={14} /> All hosts</button>}
        <div className="remote-management__scope"><strong>{hosts.length}</strong><span>hosts</span><small>{hosts.filter(host => host.kind === 'ssh').length} SSH</small></div>
        {showTopology ? <label className="settings-resource-search remote-management__search"><ThemeActionSearchIcon size={14} aria-hidden="true" /><TextInput type="search" aria-label="Filter hosts" placeholder="Find a host or project…" value={filter.query} onChange={event => filterHosts(event.target.value)} /></label> : null}
        {wide ? <div className="remote-management__modes" aria-label="Host view">
          <button type="button" aria-label="Topology" aria-pressed={showTopology} onClick={() => setMode('topology')}><ThemeObjectTopologyIcon size={14} /><span>Topology</span></button>
          <button type="button" aria-label="List" aria-pressed={!showTopology} onClick={() => setMode('list')}><ThemeLayoutListIcon size={14} /><span>List</span></button>
        </div> : null}
        <button className="small-button" data-add-host disabled={saving} onClick={addHost}><ThemeActionCreateHostIcon size={13} /> Add SSH host</button>
      </div>
      {filter.query.trim() ? <p className="remote-management__filter" role="status">{hosts.filter(host => matches(host.id)).length} of {hosts.length} configured hosts match “{filter.query}”{selectedId && !matches(selectedId) ? ' · Selected host remains open' : ''}</p> : null}
      <div className="settings-resource-split remote-management__body">
        {showTopology ? active ? <HostTopology selectedId={selectedId} onSelect={selectTopologyHost}
          onOpenLink={() => { if (selectedNetworkHost) selectTopologyHost(selectedNetworkHost.id) }}
          linkView={selectedNetworkHost ? <HostNetworkMap key={selectedNetworkHost.id} host={selectedNetworkHost} committed={config.hosts.find(host => host.id === selectedNetworkHost.id)} state={network.reads[selectedNetworkHost.id]} onRead={network.read} active={active && !pendingHostNavigation && panel === 'overview'} visible={network.visible} /> : null}
          items={hosts.filter(host => matches(host.id)).map(host => ({ host, network: hostNetworkSummary(currentHostNetwork(network.reads[host.id], host)), check: currentHostCheck(checks[host.id], host), projectCount: projectFacts.get(host.id)?.count ?? 0, sessionCount: sessionsByHost.get(host.id)?.length ?? 0 }))} /> : <div /> : <HostConnectionLibrary selectedId={selectedId} panel={panel} query={filter.query} onQuery={filterHosts} onSelect={selectHostPanel} focusRequest={returnFocus}
          items={hosts.filter((host) => matches(host.id)).map((host) => {
            const check = currentHostCheck(checks[host.id], host)
            const projects = projectFacts.get(host.id)?.count ?? 0
            return {
              id: host.id, name: host.label,
              projectCount: projects,
              detail: `${host.kind === 'ssh' ? host.hostname || 'SSH · Host required' : 'Local machine'}${projects ? ` · ${projects} ${projects === 1 ? 'project' : 'projects'}` : ''}`,
              mark: <HostIcon kind={host.kind} size={18} />,
              status: <span className={`settings-resource-row__check check-pill--${check?.state === 'error' ? check.result?.outcome ?? 'check-failed' : check?.state ?? 'idle'}`} role="img" aria-label={hostCheckLabel(check ?? { state: 'idle' })} title={hostCheckLabel(check ?? { state: 'idle' })}>{check?.state === 'checking' ? <ThemeStatusLoadingIcon animation="spin" size={13} /> : check?.state === 'ready' ? <ThemeStatusCompletedIcon size={13} /> : <ThemeStatusInfoIcon size={13} />}<span>{hostCheckLabel(check ?? { state: 'idle' })}</span></span>
            }
          })} />}
        <div ref={editor} className="settings-resource-editor">
        {hosts.filter((host) => host.id === selectedId).map((host) => {
          const check = currentHostCheck(checks[host.id], host)
          const hostSessions = sessionsByHost.get(host.id) ?? NO_SESSIONS
          const sessionCount = hostSessions.length
          return (
            <section className="host-settings-card" key={host.id} data-resource-editor={host.id} data-host-view={panel} tabIndex={-1}>
              <header className="settings-resource-editor__header">
                <span className="host-card__icon"><HostIcon kind={host.kind} size={16} /></span>
                <div><strong>{host.label}</strong><small>{host.kind === 'ssh' ? `${host.user ? `${host.user}@` : ''}${host.hostname || 'hostname required'}${host.port ? `:${host.port}` : ''}` : 'Local machine'}</small></div>
                {check ? (
                  <span role="status" className={`check-pill check-pill--${check.state === 'error' ? check.result?.outcome ?? 'check-failed' : check.state}`}>
                    {check.state === 'checking' ? <ThemeStatusLoadingIcon animation="spin" size={13} /> :
                      check.state === 'ready' ? <ThemeStatusCompletedIcon size={13} /> : check.state === 'error' ? <ThemeStatusInfoIcon size={13} /> : null}
                    {hostCheckLabel(check)}
                  </span>
                ) : null}
                {panel === 'connection' ? <button className="small-button" disabled={check?.state === 'checking' || (host.kind === 'ssh' && !host.hostname.trim())} onClick={() => void checkHost(host)}>Test</button> : null}
                {host.kind === 'ssh' ? <button className="icon-button icon-button--danger" aria-label={`Remove ${host.label}`} title={`Remove ${host.label}`} disabled={sessionCount > 0} onClick={() => setRemoveRequest(host)}><ThemeActionRemoveIcon size={14} /></button> : null}
              </header>
              <nav className="remote-detail-tabs" aria-label={`Sections for ${host.label}`}>
                {HOST_PANELS.map(({ id: page, title }) => <button type="button" key={page} data-host-panel={page}
                  aria-current={panel === page ? 'page' : undefined} onClick={() => selectHostPanel(host.id, page)}>
                  {title}</button>)}
              </nav>
              {panel === 'overview' ? <div className="remote-overview">
                <dl className="remote-overview__facts"><div><dt>Projects</dt><dd>{projectFacts.get(host.id)?.count ?? 0}<small>registered</small></dd></div>
                  <div><dt>Sessions</dt><dd>{sessionCount}<small>client references</small></dd></div></dl>
                <div className="remote-overview__identity"><span>Last connection test</span><strong>{hostCheckLabel(check ?? { state: 'idle' })}</strong>
                  {check?.observedAt ? <time dateTime={new Date(check.observedAt).toISOString()}>{new Date(check.observedAt).toLocaleString()}</time> : null}
                  {check?.state === 'error' ? <button type="button" className="small-button remote-overview__connection-action" onClick={() => selectHostPanel(host.id, 'connection')}>Review connection</button> : null}
                  {check?.detail && check.state === 'error' ? <details className="remote-overview__check-details"><summary>Connection test details</summary><p>{check.detail}</p></details> : null}</div>
                <HostSessionSummary sessions={hostSessions} active={active && (wide || view === 'editor')} onOpen={id => { if (useAppStore.getState().selectSession(id)) onClose?.() }} />
                <HostRuntimePanel host={host} committed={config.hosts.find(item => item.id === host.id)} active={active && !pendingHostNavigation && (measuredWide === true || view === 'editor')} />
                <HostNetworkPanel host={host} committed={config.hosts.find(item => item.id === host.id)} state={network.reads[host.id]} onRead={network.read}
                  active={active && !pendingHostNavigation && (measuredWide === true || view === 'editor')} visible={network.visible} />
              </div> : null}
              {panel === 'connection' && check?.detail && check.state !== 'checking' ? check.state === 'ready' ? (
                <details className="host-check-details">
                  <summary>Test details <ThemeNavigationDownIcon size={13} /></summary>
                  <p className="host-check-detail">{check.detail}</p>
                </details>
              ) : <p className="host-check-detail">{check.detail}</p> : null}
              {panel === 'connection' ? host.kind === 'ssh' ? (
                <HostConnectionFields
                  host={host}
                  open={advancedOpen[host.id] ?? false}
                  onOpenChange={(open) => setAdvancedOpen((current) => current[host.id] === open ? current : { ...current, [host.id]: open })}
                  onChange={(patch) => update(host.id, patch)}
                  onClear={(field) => clear(host.id, field)}
                />
              ) : <div className="settings-local-host"><strong>Your local host</strong><p>Uses this computer’s installed agents and registered projects. No SSH configuration needed.</p></div> : null}
              {panel === 'connection' && sessionCount > 0 ? <p className="field-hint">{sessionCount} Session reference{sessionCount === 1 ? '' : 's'}. Removal is protected while this connection is referenced.</p> : null}
            </section>
          )
        })}
          {maintenanceHosts.map(id => {
            const draft = hosts.find(host => host.id === id)
            if (!draft) return null
            return <div key={`applications-${id}`} hidden={selectedId !== id || panel !== 'agents'} inert={selectedId !== id || panel !== 'agents'}>
              <HostApplicationAccessPanel host={draft} committed={config.hosts.find(host => host.id === id)} hosts={config.hosts}
                active={active && selectedId === id && panel === 'agents' && (wide || view === 'editor')} />
              <HostExecutorsSummary config={config} host={draft} active={active && selectedId === id && panel === 'agents' && (wide || view === 'editor')} />
            </div>
          })}
          {maintenanceHosts.map(id => {
            const draft = hosts.find(host => host.id === id)
            const committed = config.hosts.find(host => host.id === id)
            return draft?.kind === 'ssh' ? <div key={id}>
              <div hidden={selectedId !== id || panel !== 'connection'} inert={selectedId !== id || panel !== 'connection'}>
                <HostUpgradePanel host={draft} committed={committed?.kind === 'ssh' ? committed : undefined} active={active && view === 'editor' && selectedId === id && panel === 'connection'} />
              </div>
              <div data-host-access={id} hidden={selectedId !== id || panel !== 'agents'} inert={selectedId !== id || panel !== 'agents'}>
                <HostCreationTrustPanel host={draft} committed={committed?.kind === 'ssh' ? committed : undefined} active={active && view === 'editor' && selectedId === id && panel === 'agents'} />
              </div>
            </div> : null
          })}
          {projectHosts.filter(id => hosts.some(host => host.id === id)).map(id => {
            const draft = hosts.find(host => host.id === id)
            const committed = config.hosts.find(host => host.id === id)
            return <HostProjectsPane key={id} config={config} hostId={id}
              connectionChanged={JSON.stringify(draft) !== JSON.stringify(committed)}
              active={active && selectedId === id && panel === 'projects'} hidden={selectedId !== id || panel !== 'projects'} onClose={onClose} />
          })}
          {!hosts.some((host) => host.id === selectedId) ? <div className="settings-resource-editor__empty" role="status"><ThemeObjectHostIcon size={28} aria-hidden="true" /><strong>{requestedHost !== null ? 'Connection no longer available' : 'Connect your hosts'}</strong><p>{requestedHost !== null ? `The requested connection (${requestedHost}) is no longer in these settings. Choose another connection to review it.` : 'Choose a connection, or add an SSH host to reuse across your projects.'}</p></div> : null}
        </div>
      </div>
      <SettingsSaveBar save={saveState} dirty={dirty} label="Save hosts" onSave={() => void save()} />
      <ConfirmationDialog
        open={active && removeRequest !== null}
        title="Remove SSH host?"
        description={`This removes the host and ${config.workspaces.filter((workspace) => workspace.hostId === removeRequest?.id).length} linked workspace registrations. Remote files are not deleted.`}
        {...(removeRequest ? { subject: removeRequest.label } : {})}
        confirmLabel="Remove Host"
        busy={saving}
        onCancel={() => {
          if (!saving) setRemoveRequest(null)
        }}
        onConfirm={() => void confirmRemove()}
      />
    </div>
  )
}

function HostConnectionFields({ host, open, onOpenChange, onChange, onClear }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  host: SshHostConfig
  onChange: (patch: Partial<SshHostConfig>) => void
  onClear: (field: 'user' | 'port' | 'identityFile' | 'remoteCommand' | 'remoteSocketPath') => void
}) {
  return (
    <div className="host-connection-fields">
      <div className="host-edit-grid host-edit-grid--basic">
        <label><span>Name</span><TextInput data-host-name value={host.label} onChange={(event) => onChange({ label: event.target.value })} /></label>
        <label><span>Host or SSH alias</span><TextInput value={host.hostname} onChange={(event) => onChange({ hostname: event.target.value })} placeholder="devbox or dev.example.com" /></label>
      </div>
      <p className="settings-group-note">Use an alias from your SSH config, or a hostname. Connects to an existing AgentMux service; Test verifies this connection.</p>
      <details className="host-edit-disclosure" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
        <summary><span><strong>Connection options</strong><small>User, key, and service overrides</small></span><ThemeNavigationDownIcon size={13} /></summary>
        <div className="host-edit-grid">
        <label><span>User</span><TextInput value={host.user ?? ''} onChange={(event) => event.target.value ? onChange({ user: event.target.value }) : onClear('user')} placeholder="From SSH config" /></label>
        <label><span>Port</span><TextInput type="number" min={1} max={65535} value={host.port ?? ''} onChange={(event) => event.target.value ? onChange({ port: Number(event.target.value) }) : onClear('port')} placeholder="From SSH config" /></label>
        <label className="host-edit-grid__wide"><span>Identity file path <small>optional; key contents are never stored</small></span><TextInput value={host.identityFile ?? ''} onChange={(event) => event.target.value ? onChange({ identityFile: event.target.value }) : onClear('identityFile')} placeholder="~/.ssh/id_ed25519" /></label>
        <label className="host-edit-grid__wide"><span>Service command <small>optional</small></span><TextInput value={host.remoteCommand ?? ''} onChange={(event) => event.target.value ? onChange({ remoteCommand: event.target.value }) : onClear('remoteCommand')} placeholder="Use the installed AgentMux service" /></label>
        <label className="host-edit-grid__wide"><span>Service socket path <small>optional; remote absolute path</small></span><TextInput value={host.remoteSocketPath ?? ''} onChange={(event) => event.target.value ? onChange({ remoteSocketPath: event.target.value }) : onClear('remoteSocketPath')} placeholder="Use the service's default socket" /></label>
        <label className="host-edit-grid__wide"><span>Bound Runtime ID</span><TextInput value={host.runtimeId ?? ''} readOnly placeholder="Confirmed on the first trusted connection" /></label>
        <p className="field-hint host-edit-grid__wide">Connects to an existing service over SSH. Changing this connection keeps its Runtime binding; a different Runtime must be added as a separate host.</p>
        </div>
      </details>
    </div>
  )
}
