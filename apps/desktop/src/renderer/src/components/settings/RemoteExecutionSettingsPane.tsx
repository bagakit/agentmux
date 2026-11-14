import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
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
import type { SettingsPaneProps } from './settings-catalog'

const AgentIcon = semanticIconComponent('object.agent')
const ToolsIcon = semanticIconComponent('object.folder')
const BackIcon = semanticIconComponent('navigation.back')
const NO_SESSIONS: SessionSnapshot[] = []
const NO_NAMES: Record<string, string> = {}
type WorkAgent = Extract<SessionSnapshot, { kind: 'agent' }>
type WorkItem = { session: WorkAgent; placement: ReturnType<typeof agentWorkPlacement>; name: string }

/** Work discovery includes ordinary remote Sessions; a tool binding is one supported arrangement. */
export function RemoteExecutionSettingsPane({ config, active, onClose, onNavigate, navigationRequest }: SettingsPaneProps) {
  const sessions = useAppStore(state => active ? state.sessions : NO_SESSIONS)
  const names = useAppStore(state => active ? state.agentNames : NO_NAMES)
  const activeWorkspaceId = useAppStore(state => state.activeWorkspaceId)
  const navigation = useContext(SettingsNavigation)
  const referenceHostId = workReferenceHostId(config.hosts)
  const initialProject = config.workspaces.find(project => project.id === activeWorkspaceId && project.hostId === referenceHostId && !isScratchWorkspaceId(project.id))
  const initialSelection = initialProject ? { resourceWorkspaceId: initialProject.id, agentWorkspaceId: null } : undefined
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'library' | 'detail'>('library')
  const [task, setTask] = useState<'start' | 'existing'>('start')
  const taskId = useId()
  useLayoutEffect(() => {
    if (!active || !navigationRequest?.field) return
    setTask(navigationRequest.field === 'bindings' ? 'existing' : 'start')
    setView('library')
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
  const work = useMemo(() => sessions.flatMap(session => {
    if (session.kind !== 'agent') return []
    const placement = agentWorkPlacement(session, referenceHostId)
    return placement.mode === 'local' ? [] : [{ session, placement, name: resolveAgentName({ userName: names[session.id], fallback: session.label }).name }]
  }), [sessions, names, referenceHostId])
  const observedSelected = work.find(item => item.session.id === selectedId)
  // Hiding the retained pane releases its reader, without discarding the original selected reference.
  const retainedSelected = useRef<WorkItem | undefined>(undefined)
  if (active) retainedSelected.current = observedSelected
  const selected = active ? observedSelected : retainedSelected.current
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
  function openHost(id: string | null) { if (!id) return; if (navigation) navigation.openHost(id); else onNavigate('hosts') }
  function prepare(selection: LauncherExecutionSelection) {
    setActionError(null)
    const tabId = useAppStore.getState().openLauncher({ workspaceId: selection.resourceWorkspaceId, reveal: true, initialExecution: selection })
    if (!tabId) { setActionError('The Launcher could not be opened. Your selection and existing work are kept.'); return false }
    onClose(); return true
  }
  function openOriginal(session: WorkAgent) {
    setActionError(null)
    if (useAppStore.getState().selectSession(session.id)) onClose()
    else setActionError('The original workface could not be opened. This Session is kept; use its original workspace to continue.')
  }
  function changeTask(next: 'start' | 'existing') { setTask(next); setActionError(null) }
  return <div ref={container} className="settings-pane-stack remote-execution-settings">
    <div className="remote-work-toolbar"><nav className="remote-work-tasks" role="tablist" aria-label="Remote work task">
      {(['start', 'existing'] as const).map((id, index) => <button key={id} type="button" role="tab" id={`${taskId}-${id}-tab`}
        aria-controls={`${taskId}-${id}`} aria-selected={task === id} tabIndex={task === id ? 0 : -1}
        onClick={() => changeTask(id)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'start' : event.key === 'End' ? 'existing' : index === 0 ? 'existing' : 'start'
          changeTask(next); document.getElementById(`${taskId}-${next}-tab`)?.focus()
        }}>{id === 'start' ? 'Start work' : <>Existing work <span>{work.length}</span></>}</button>)}
    </nav><button type="button" className="remote-work-hosts" onClick={() => onNavigate('hosts')}>Manage Hosts</button></div>
    <section hidden={task !== 'start'} id={`${taskId}-start`} role="tabpanel" aria-labelledby={`${taskId}-start-tab`} className="remote-execution-prepare" data-settings-field="prepare">
      <div className="remote-work-intro"><h3>Where will you work?</h3><p>Choose an arrangement. Continue in Launcher to pick an Agent and write your task.</p></div>
      <AgentWorkModeSetup config={config} active={active && task === 'start'} initialMode="remote-agent" initialSelection={initialSelection} actionLabel="Open in Launcher" onApply={prepare} onOpenHost={openHost} />
      <RemoteExecutionGuide active={active && task === 'start'} />
    </section>
    {actionError ? <p className="remote-execution-feedback" role="status">{actionError}</p> : null}
    <section hidden={task !== 'existing'} id={`${taskId}-existing`} role="tabpanel" aria-labelledby={`${taskId}-existing-tab`} className="remote-execution-bindings" data-settings-field="bindings">
      <p className="remote-work-scope">Work observed by this app. Continue in its original workspace.</p>
      {narrow && view === 'detail' ? <button type="button" className="small-button remote-execution-back" onClick={() => { setView('library'); setReturnFocus({ id: selectedId }) }}><BackIcon size={14} />Back to work</button> : null}
      {!work.length && !selectedId ? <div className="remote-execution-empty"><AgentIcon size={24} aria-hidden="true" /><h3>No remote work yet</h3><p>Start with an arrangement. Your Agent appears here once this app observes its Session.</p><button type="button" className="small-button" onClick={() => changeTask('start')}>Start remote work</button></div> : <div className="remote-execution-bindings__body">
        <div hidden={narrow && view === 'detail'} className="remote-execution-library">
          <SettingsResourceLibrary label="Remote work" query={query} onQuery={setQuery} selectedId={selectedId} focusRequest={returnFocus}
            onSelect={id => { setSelectedId(id); setView('detail'); setActionError(null) }} items={rows.map(item => ({ id: item.session.id, name: item.name,
              detail: `${projectName(item) ?? item.placement.projectPath} · ${hostName(item.placement.projectHostId)}\nAgent · ${hostName(item.placement.agentHostId)}`,
              status: <AgentWorkModeBadge source={item.session} hosts={config.hosts} embedded />,
              mark: <ResolvedAgentAvatar label={item.name} providerId={item.session.providerId} executorId={item.session.executorId} state={item.session.status.state} size={26} /> }))} />
        </div>
        {selected ? <div hidden={!detailVisible} className="remote-execution-detail" data-remote-session={selected.session.id} data-remote-binding={selected.session.toolExecution?.bindingId}>
          <header><div><h3 ref={detailHeading} tabIndex={-1}>{selected.name}</h3><AgentWorkModeBadge source={selected.session} hosts={config.hosts} /><span>{sessionStatusLabel(selected.session)}</span></div><button type="button" className="small-button" data-remote-open onClick={() => openOriginal(selected.session)}>Open original work</button></header>
          <dl className="remote-execution-endpoints">
            <div><dt><AgentIcon size={16} />Agent runs on</dt><dd><button type="button" onClick={() => openHost(selected.placement.agentHostId)}>{hostName(selected.placement.agentHostId)}</button><span>{selected.placement.agentPath}</span></dd></div>
            <div><dt><ToolsIcon size={16} />Project &amp; tools</dt><dd><button type="button" disabled={!selected.placement.projectHostId} onClick={() => openHost(selected.placement.projectHostId)}>{hostName(selected.placement.projectHostId)}</button><span>{selected.placement.projectPath}</span></dd></div>
          </dl>
          {selected.session.toolExecution ? <AgentToolExecutionNotice key={selected.session.toolExecution.bindingId} session={selected.session} visible={active && task === 'existing' && detailVisible} presentation="inline" /> : null}
          <details className="remote-execution-identities"><summary>Original identities</summary><dl><dt>Session</dt><dd>{selected.session.control.agentSessionId}</dd><dt>Agent Host</dt><dd>{selected.placement.agentHostId}</dd><dt>Project Host</dt><dd>{selected.placement.projectHostId ?? 'Unobserved'}</dd>{selected.session.toolExecution ? <><dt>Binding</dt><dd>{selected.session.toolExecution.bindingId}</dd></> : null}</dl></details>
        </div> : <div className="remote-execution-empty"><AgentIcon size={24} aria-hidden="true" /><h3>{selectedId ? 'Work not observed' : 'Choose a Session'}</h3><p>{selectedId ? 'The original reference is not in this app’s current observation. No Session has been stopped or replaced.' : 'See its Agent, project and original continuation entry.'}</p></div>}
      </div>}
    </section>
  </div>
}
