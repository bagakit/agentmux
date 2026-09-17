import { CheckCircle2, CirclePause, Inbox, PanelRightClose, PlayCircle, Search, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { createFocusContextSelector, type FocusBucket } from '../lib/focus-context'
import { FocusContextRow } from './FocusContextRow'
import { deriveFocusProjectLanes } from '../lib/focus-project-lanes'
import { tabForFocusedSession } from '../lib/focus-tab-projection'
import { AttentionRequestPanel } from './AttentionRequestPanel'
import { SessionObservationRegions } from './SessionObservationRegions'
import { AgentTopologySummary } from './AgentTopologySummary'
import { FocusProjectLanes } from './FocusProjectLanes'
import { RecentFocusTimeline } from './RecentFocusTimeline'
import { executionFocusHistory, executionFocusSessionId } from '../lib/agent-focus'

export function GlobalFocusSurface() {
  const contextSelector = useMemo(createFocusContextSelector, [])
  const executionRows = useAppStore(useShallow(contextSelector))
  const sessions = useAppStore((state) => state.sessions)
  const config = useAppStore((state) => state.config)
  const tabs = useAppStore((state) => state.tabs)
  const selectedId = useAppStore((state) => executionFocusSessionId(state.agentFocus))
  const executionHistory = useAppStore((state) => executionFocusHistory(state.agentFocus))
  const focusExecutionSession = useAppStore((state) => state.focusExecutionSession)
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('all')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [workspaceRatio, setWorkspaceRatio] = useState(0.618)
  const focusLayoutRef = useRef<HTMLDivElement | null>(null)
  const resizingFocusRef = useRef(false)
  const adjustWorkspaceRatio = (next: number) => setWorkspaceRatio(Math.min(0.76, Math.max(0.38, next)))
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (!resizingFocusRef.current || !focusLayoutRef.current) return
      const rect = focusLayoutRef.current.getBoundingClientRect()
      if (rect.width <= 0) return
      adjustWorkspaceRatio((rect.right - event.clientX) / rect.width)
    }
    const stop = () => { resizingFocusRef.current = false; document.body.style.cursor = ''; document.body.style.userSelect = '' }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('blur', stop)
    return () => { window.removeEventListener('pointermove', onPointerMove); window.removeEventListener('pointerup', stop); window.removeEventListener('blur', stop) }
  }, [])
  const filtered = executionRows.filter(row => (project === 'all' || row.workspaceId === project) && `${row.name} ${row.detail} ${row.workspaceName} ${row.providerId ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const selected = executionRows.find(row => row.id === selectedId)
  const focusProjectLanes = useMemo(() => deriveFocusProjectLanes(executionRows).filter(lane => project === 'all' || lane.workspaceId === project), [executionRows, project])
  const rowsByProject = new Map<string, typeof filtered>()
  for (const row of filtered) { const group = rowsByProject.get(row.workspaceId) ?? []; group.push(row); rowsByProject.set(row.workspaceId, group) }
  const selectedTab = useMemo(() => tabForFocusedSession(tabs, selectedId), [selectedId, tabs])
  const bucketMeta = { attention: { label: 'Attention', icon: Inbox }, working: { label: 'Working', icon: PlayCircle }, results: { label: 'Results', icon: CheckCircle2 }, idle: { label: 'Idle / Recovery', icon: CirclePause } }
  const laneRows = (lane: typeof focusProjectLanes[number]) => {
    const rows = rowsByProject.get(lane.workspaceId) ?? []
    return <div className="focus-project-lanes__groups">
      {(Object.keys(bucketMeta) as FocusBucket[]).map(bucket => {
        const meta = bucketMeta[bucket], Icon = meta.icon, grouped = rows.filter(row => row.bucket === bucket)
        return <section className="focus-context-group global-agents-group" data-bucket={bucket} data-empty={grouped.length === 0 ? 'true' : undefined} key={bucket}>
          <header className="focus-context-group__header"><Icon size={12} /><strong>{meta.label}</strong><span>{grouped.length}</span></header>
          {grouped.map(context => <FocusContextRow key={context.id} context={context} selected={selectedId === context.id} onSelect={focusExecutionSession} />)}
        </section>
      })}
    </div>
  }
  return <section className={`global-board-surface global-focus-surface ${selectedId ? 'global-board-surface--session-open' : ''}`} aria-label="Focus">
    <div ref={focusLayoutRef} className="global-focus-layout" style={{ '--focus-workspace-width': `calc(${workspaceRatio * 100}% - 6px)` } as CSSProperties}>
      <div className="global-board-main global-focus-main">
      <header className="focus-filters">
        <div className="global-board-toolbar__controls">
          <label className="global-board-search"><Search size={13} /><input aria-label="Search contexts" placeholder="Search contexts" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label className="global-board-select">Project<select aria-label="Focus project filter" value={project} onChange={(event) => setProject(event.target.value)}><option value="all">All</option>{config?.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
        </div>
      </header>
      {executionRows.length === 0 ? <div className="global-agents-empty" role="status"><Users size={20} /><strong>No execution contexts yet</strong><span>Open an Agent or Terminal from a Workspace to make it appear here.</span></div> : <div className="global-board-columns" aria-label="Global execution contexts">
        <FocusProjectLanes lanes={focusProjectLanes} selectedWorkspaceId={project} onSelect={setProject} renderLane={laneRows} />
      </div>}
      </div>
    {selectedId ? <><div
      className="focus-workspace-resize-handle"
      role="separator"
      tabIndex={0}
      aria-label="Resize Focus workspace"
      aria-orientation="vertical"
      aria-valuemin={38}
      aria-valuemax={76}
      aria-valuenow={Math.round(workspaceRatio * 100)}
      onPointerDown={(event) => {
        event.preventDefault()
        resizingFocusRef.current = true
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); adjustWorkspaceRatio(workspaceRatio - 0.02) }
        if (event.key === 'ArrowRight') { event.preventDefault(); adjustWorkspaceRatio(workspaceRatio + 0.02) }
        if (event.key === 'Home') { event.preventDefault(); adjustWorkspaceRatio(0.38) }
        if (event.key === 'End') { event.preventDefault(); adjustWorkspaceRatio(0.76) }
      }}
    /><aside className="global-session-workspace" aria-label="Focus workspace">
      <header className="global-session-workspace__header"><div className="global-session-workspace__identity"><strong>{selected?.name ?? 'Session awaiting recovery'}</strong><small>{selected?.stateLabel}</small></div>{selected?.actionable ? <button type="button" className="global-board-action" onClick={() => setRequestId(selectedId)}>Review request</button> : null}<button type="button" className="icon-button" aria-label="Close Focus workspace" onClick={() => focusExecutionSession(null)}><PanelRightClose size={15} /></button></header>
      
      {selectedTab
        ? <div id="focus-workspace-slot" className="focused-tab-workspace" data-focus-tab-id={selectedTab.id} />
        : <><AgentTopologySummary sessionIds={[selectedId]} sessions={sessions} tabs={tabs} config={config} /><SessionObservationRegions sessionIds={[selectedId]} contextId={`agent:${selectedId}`} /></>}
    </aside></> : null}
    </div>
    <RecentFocusTimeline entries={executionHistory} currentSessionId={selectedId} contexts={executionRows} onSelect={focusExecutionSession} />
    {requestId ? <AttentionRequestPanel sessionId={requestId} onClose={() => setRequestId(null)} onSessionChange={focusExecutionSession} /> : null}
  </section>
}
