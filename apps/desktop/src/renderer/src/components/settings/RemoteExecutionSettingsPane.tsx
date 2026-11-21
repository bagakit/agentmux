import { Button } from '@agentmux/client-ui/components/Button'
import { Tabs } from '@agentmux/client-ui/components/Tabs'
import { useLauncherState } from '../../lib/launcher-state'
import { warmLauncherId } from '../../lib/warm-terminal-preview'
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import remoteArt from '@agentmux/client-ui/brand/illustrations/concepts/remote-project-agent.jpg'
import { resolveAgentName } from '@agentmux/client-ui/display-name'
import { isScratchWorkspaceId, type SessionSnapshot } from '../../../../shared/contracts'
import { useAppStore, type LauncherExecutionSelection } from '../../store'
import { agentWorkModeLabel, agentWorkPlacement, workHostLabel, workReferenceHostId } from '../../lib/agent-work-mode'
import { sessionStatusLabel } from '../../lib/session-presentation'
import { AgentWorkModeBadge } from '../AgentWorkModeBadge'
import { AgentWorkModeSetup } from '../AgentWorkModeSetup'
import { AgentToolExecutionNotice } from '../AgentToolExecutionNotice'
import { ResolvedAgentAvatar } from '../AgentAvatar'
import { SettingsNavigation } from '../SettingsNavigation'
import { SettingsResourceLibrary } from './SettingsResourceLibrary'
import { RemoteExecutionGuide } from './RemoteExecutionGuide'
import { RemoteRoutesPane } from './RemoteRoutesPane'
import type { SettingsPaneProps } from './settings-catalog'

const AgentIcon = semanticIconComponent('object.agent')
const ToolsIcon = semanticIconComponent('object.folder')
const BackIcon = semanticIconComponent('navigation.back')
const RoutesIcon = semanticIconComponent('object.topology')
const remoteTasks = [
  { value: 'routes', Icon: RoutesIcon, title: 'Work routes', description: 'Direct and delegated access' },
  { value: 'start', Icon: ToolsIcon, title: 'Prepare', description: 'Choose a Space and Agent' },
  { value: 'existing', Icon: AgentIcon, title: 'Work', description: 'Return to original Sessions' }
] as const
type RemoteTask = (typeof remoteTasks)[number]['value']

const NO_SESSIONS: SessionSnapshot[] = []
const NO_NAMES: Record<string, string> = {}
type WorkAgent = Extract<SessionSnapshot, { kind: 'agent' }>
type WorkItem = { session: WorkAgent; placement: ReturnType<typeof agentWorkPlacement>; name: string }

/** Work discovery includes ordinary remote Sessions; a tool binding is one supported arrangement. */
export function RemoteExecutionSettingsPane({ config, active, onClose, onNavigate, navigationRequest, embedded = false }: SettingsPaneProps & { embedded?: boolean }) {
  const sessions = useAppStore(state => active ? state.sessions : NO_SESSIONS)
  const names = useAppStore(state => active ? state.agentNames : NO_NAMES)
  const activeWorkspaceId = useAppStore(state => state.activeWorkspaceId)
  const navigation = useContext(SettingsNavigation)
  const referenceHostId = workReferenceHostId(config.hosts)
  const initialProject = config.workspaces.find(project => project.id === activeWorkspaceId && !isScratchWorkspaceId(project.id))
  const initialSelection = initialProject ? { resourceWorkspaceId: initialProject.id, agentWorkspaceId: null } : undefined
  const work = useMemo(() => sessions.flatMap(session => {
    if (session.kind !== 'agent') return []
    const placement = agentWorkPlacement(session, referenceHostId)
    return placement.mode === 'local' ? [] : [{ session, placement, name: resolveAgentName({ userName: names[session.id], fallback: session.label }).name }]
  }), [sessions, names, referenceHostId])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'library' | 'detail'>('library')
  const requestedTask = navigationRequest?.field === 'prepare' || navigationRequest?.field === 'guide' ? 'start' : navigationRequest?.field === 'routes' ? 'routes' : 'existing'
  const [chosenTask, setTask] = useState<RemoteTask | null>(null)
  const appliedNavigation = useRef<SettingsPaneProps['navigationRequest']>(undefined)
  const pendingNavigation = appliedNavigation.current !== navigationRequest
  const task = active && pendingNavigation && navigationRequest?.field ? requestedTask : chosenTask ?? (work.length ? 'existing' : 'start')
  const [routesVisited, setRoutesVisited] = useState(false)
  const [prepareVisited, setPrepareVisited] = useState(false)
  const taskId = useId()
  useLayoutEffect(() => {
    if (!active) return
    appliedNavigation.current = navigationRequest
    const next = navigationRequest?.field ? requestedTask : task
    setTask(next)
    if (next === 'start') setPrepareVisited(true)
    if (next === 'routes') setRoutesVisited(true)
    if (navigationRequest?.field) setView('library')
  }, [active, navigationRequest])
  const [narrow, setNarrow] = useState(false)
  const [returnFocus, setReturnFocus] = useState<{ id: string | null } | null>(null)
  const container = useRef<HTMLDivElement>(null), detailHeading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => { const width = element.getBoundingClientRect().width; if (width > 0) setNarrow(width <= 720) }
    measure(); const observer = new ResizeObserver(measure); observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (active && task === 'existing' && narrow && view === 'detail') detailHeading.current?.focus({ preventScroll: true })
  }, [active, task, narrow, view, selectedId])
  const [query, setQuery] = useState(''), [actionError, setActionError] = useState<string | null>(null)
  const observedSelected = work.find(item => item.session.id === selectedId)
  // Hiding the retained pane releases its reader, without discarding the original selected reference.
  const retainedSelected = useRef<WorkItem | undefined>(undefined)
  const lastObservedSelection = useRef<{ id: string; agentHostId: string | null } | undefined>(undefined)
  if (active) retainedSelected.current = observedSelected
  useLayoutEffect(() => {
    if (observedSelected) lastObservedSelection.current = { id: observedSelected.session.id, agentHostId: observedSelected.placement.agentHostId }
  }, [observedSelected])
  const selected = active ? observedSelected : retainedSelected.current
  const missingHost = lastObservedSelection.current?.id === selectedId ? lastObservedSelection.current.agentHostId : null
  const detailVisible = !narrow || view === 'detail'
  const hostName = (id: string | null) => workHostLabel(config.hosts, id)
  const projectNames = useMemo(() => {
    const result = new Map<string, string[]>()
    for (const project of config.workspaces) {
      const key = JSON.stringify([project.hostId, project.path])
      result.set(key, [...(result.get(key) ?? []), project.name])
    }
    return result
  }, [config.workspaces])
  const projectName = (item: WorkItem) => projectNames.get(JSON.stringify([item.placement.projectHostId, item.placement.projectPath]))?.join(' · ')
  const rows = work.filter(item => `${item.name} ${item.session.id} ${item.session.toolExecution?.bindingId ?? ''} ${agentWorkModeLabel(item.placement.mode)} ${hostName(item.placement.agentHostId)} ${item.placement.agentHostId} ${hostName(item.placement.projectHostId)} ${item.placement.projectHostId} ${item.placement.projectPath} ${projectName(item) ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  function openHost(id: string | null) { if (!id) return; if (navigation) navigation.openHost(id); else onNavigate('network-node', 'connection', id) }
  function connectDevice() { onNavigate('remote-execution', 'mesh-join') }
  function prepare(selection: LauncherExecutionSelection) {
    setActionError(null)
    const tabId = useAppStore.getState().openLauncher({ workspaceId: selection.resourceWorkspaceId, reveal: true, initialExecution: selection })
    if (!tabId) { setActionError('The Launcher could not be opened. Your selection and existing work are kept.'); return false }
    if (selection.source) {
      const tab = useAppStore.getState().tabs[tabId]
      if (!tab || !useLauncherState.getState().setSourceExecution(warmLauncherId({ tabGroupId: '', regionId: tab.layout.activeRegionId }), selection.source)) return false
    }
    onClose(); return true
  }
  function openOriginal(session: WorkAgent) {
    setActionError(null)
    if (useAppStore.getState().selectSession(session.id)) onClose()
    else setActionError('The original workface could not be opened. Check the Agent device and try opening this Session again.')
  }
  function changeTask(next: RemoteTask) { setTask(next); if (next === 'start') setPrepareVisited(true); if (next === 'routes') setRoutesVisited(true); setActionError(null) }
  return <div ref={container} className="settings-pane-stack remote-execution-settings">
    {!embedded ? <><header className="remote-work-header"><div><h3>Work across your machines</h3><p>Start work on a connected device or return to an original Session.</p></div><button type="button" className="remote-work-hosts" onClick={() => onNavigate('network-node', 'mesh-devices')}>Manage connections</button></header>
    <div className="remote-work-toolbar">
      <Tabs as="nav" className="remote-work-tasks remote-work-tasks--primary" aria-label="Remote work task"
        value={task} onValueChange={changeTask} options={remoteTasks.map(({ value, Icon, title, description }) => ({
          value, panelId: `${taskId}-${value}`, button: { id: `${taskId}-${value}-tab` },
          label: <><Icon size={18} /><span><strong>{title}{value === 'existing' ? <> <small>{work.length}</small></> : null}</strong><small>{description}</small></span></>
        }))} />
    </div></> : null}
    <section hidden={task !== 'start'} id={`${taskId}-start`} role={embedded ? undefined : "tabpanel"} aria-labelledby={embedded ? undefined : `${taskId}-start-tab`} className="remote-execution-prepare" data-settings-field="prepare">
      {!embedded ? <div className="remote-work-intro remote-work-intro--illustrated"><div><h3>Choose where work happens.</h3><p>Run the Agent where the project lives, or run it elsewhere while the files and tools stay with the project.</p></div>
        <figure className="remote-work-placement-art" aria-hidden="true"><img src={remoteArt} alt="" width="1100" height="619" loading="lazy" decoding="async" draggable={false} />
          <figcaption><span><ToolsIcon size={14} />Project &amp; tools</span><span><AgentIcon size={14} />Agent</span></figcaption></figure></div> : null}
      {!config.hosts.some(host => host.id !== referenceHostId) ? <div className="remote-execution-feedback" role="status"><p>Connect another device to work across machines.</p>
        <Button type="button" variant="primary" onClick={connectDevice}>Connect another device</Button></div> : null}
      {prepareVisited || task === 'start' ? <AgentWorkModeSetup sourceTargets showRoleLabels config={config} active={active && task === 'start'} initialMode={initialProject && initialProject.hostId !== referenceHostId ? 'remote-project' : 'remote-agent'} initialSelection={initialSelection} actionLabel="Open in Launcher" onApply={prepare} onOpenHost={openHost} /> : null}
    </section>
    {actionError ? <div className="remote-execution-feedback" role="status"><p>{actionError}</p>
      {task === 'existing' && selected ? <Button type="button" onClick={() => openHost(selected.placement.agentHostId)}>Check the Agent device</Button> : null}
    </div> : null}
    <section hidden={task !== 'existing'} id={`${taskId}-existing`} role={embedded ? undefined : "tabpanel"} aria-labelledby={embedded ? undefined : `${taskId}-existing-tab`} className="remote-execution-bindings" data-settings-field="bindings">
      <p className="remote-work-scope">Continue work in its original workspace. Connecting to or browsing a Host does not require a project.</p>
      {narrow && view === 'detail' ? <Button type="button" className="remote-execution-back" onClick={() => { setView('library'); setReturnFocus({ id: selectedId }) }}><BackIcon size={14} />Back to work</Button> : null}
      {!work.length && !selectedId ? <div className="remote-execution-empty"><h3>No remote work is visible here yet</h3><p>Connect the device that has your work, or choose where to start a new task.</p><div className="remote-execution-empty__actions">
        <Button type="button" variant="primary" onClick={connectDevice}>Connect another device</Button><Button type="button" onClick={() => embedded ? onNavigate('remote-execution', 'prepare') : changeTask('start')}>Set up new work</Button>
      </div></div> : <div className="remote-execution-bindings__body">
        <div hidden={narrow && view === 'detail'} className="remote-execution-library">
          <SettingsResourceLibrary label="Remote work" query={query} onQuery={setQuery} selectedId={selectedId} focusRequest={returnFocus}
            onSelect={id => { setSelectedId(id); setView('detail'); setActionError(null) }} items={rows.map(item => ({ id: item.session.id, name: item.name,
              detail: `${projectName(item) ? `${projectName(item)} · ` : ''}${item.placement.projectPath} · ${hostName(item.placement.projectHostId)}\nAgent · ${hostName(item.placement.agentHostId)}`,
              status: <AgentWorkModeBadge source={item.session} hosts={config.hosts} embedded />,
              mark: <ResolvedAgentAvatar label={item.name} providerId={item.session.providerId} executorId={item.session.executorId} state={item.session.status.state} size={26} /> }))} />
        </div>
        {selected ? <div hidden={!detailVisible} className="remote-execution-detail" data-remote-session={selected.session.id} data-remote-binding={selected.session.toolExecution?.bindingId}>
          <header><div><h3 ref={detailHeading} tabIndex={-1}>{selected.name}</h3><AgentWorkModeBadge source={selected.session} hosts={config.hosts} /><span>{sessionStatusLabel(selected.session)}</span></div><Button type="button" data-remote-open onClick={() => openOriginal(selected.session)}>Open original work</Button></header>
          <dl className="remote-execution-endpoints">
            <div><dt><AgentIcon size={16} />Agent runs on</dt><dd><button type="button" onClick={() => openHost(selected.placement.agentHostId)}>{hostName(selected.placement.agentHostId)}</button><span>{selected.placement.agentPath}</span></dd></div>
            <div><dt><ToolsIcon size={16} />Project &amp; tools</dt><dd><button type="button" disabled={!selected.placement.projectHostId} onClick={() => openHost(selected.placement.projectHostId)}>{hostName(selected.placement.projectHostId)}</button><span>{selected.placement.projectPath}</span></dd></div>
          </dl>
          {selected.session.toolExecution ? <AgentToolExecutionNotice key={selected.session.toolExecution.bindingId} session={selected.session} visible={active && task === 'existing' && detailVisible} presentation="inline" /> : null}
          <details className="remote-execution-identities"><summary>Original identities</summary><dl><dt>Session</dt><dd>{selected.session.control.agentSessionId}</dd><dt>Agent Host</dt><dd>{selected.placement.agentHostId}</dd><dt>Project Host</dt><dd>{selected.placement.projectHostId ?? 'Unobserved'}</dd>{selected.session.toolExecution ? <><dt>Binding</dt><dd>{selected.session.toolExecution.bindingId}</dd></> : null}</dl></details>
        </div> : <div hidden={!detailVisible && Boolean(selectedId)} className="remote-execution-empty"><h3>{selectedId ? 'Work not observed' : 'Choose a Session'}</h3><p>{selectedId ? 'The original Session is outside the current view. Check its Agent device and come back here.' : 'See its Agent, project and original continuation entry.'}</p>
          {selectedId ? <Button type="button" variant="primary" onClick={missingHost ? () => openHost(missingHost) : connectDevice}>{missingHost ? 'Check the original Agent device' : 'Connect another device'}</Button> : null}</div>}
      </div>}
    </section>
    <section hidden={task !== 'routes'} id={`${taskId}-routes`} role={embedded ? undefined : "tabpanel"} aria-labelledby={embedded ? undefined : `${taskId}-routes-tab`} data-settings-field="routes">
      {routesVisited || task === 'routes' ? <RemoteRoutesPane config={config} active={active && task === 'routes'} /> : null}
    </section>
    {!embedded || navigationRequest?.field === 'guide' ? <RemoteExecutionGuide active={active} /> : null}
  </div>
}
