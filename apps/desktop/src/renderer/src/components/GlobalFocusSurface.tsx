import { CheckCircle2, CirclePause, Inbox, PlayCircle, Search, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { createTerminalFocusProjectionSelector, type FocusBucket } from '../lib/focus-context'
import { FocusContextRow } from './FocusContextRow'
import { useFocusHierarchy } from '../lib/use-focus-hierarchy'
import { FocusRecoveryGroup } from './FocusRecoveryGroup'
import { FocusDisconnectedProjects } from './FocusDisconnectedProjects'
import { deriveFocusProjectLanes } from '../lib/focus-project-lanes'
import { tabForFocusedSession } from '../lib/focus-tab-projection'
import { AttentionRequestPanel } from './AttentionRequestPanel'
import { SessionObservationRegions } from './SessionObservationRegions'
import { AgentTopologySummary } from './AgentTopologySummary'
import { FocusProjectLanes } from './FocusProjectLanes'
import { FocusToolbar } from './FocusToolbar'
import { RecentFocusTimeline } from './RecentFocusTimeline'
import { requestPmoTeamsTopicFloatingOpen } from '../lib/pmo-teams-topic-floating'
import { isMacPlatform } from '../lib/host-platform'
import { executionFocusSessionId } from '../lib/agent-focus'
import { sessionPresentationById } from '../lib/session-presentation'

export function GlobalFocusSurface() {
  const contextSelector = useMemo(createTerminalFocusProjectionSelector, [])
  const {contexts: executionRows, laneContexts, pmoAttention} = useAppStore(useShallow(contextSelector))
  const config = useAppStore((state) => state.config)
  const tabs = useAppStore((state) => state.tabs)
  const selectedId = useAppStore((state) => executionFocusSessionId(state.agentFocus))
  const selectedTab = useMemo(() => tabForFocusedSession(tabs, selectedId), [selectedId, tabs])
  const selectedSessionIds = useMemo(() => selectedId ? [selectedId] : [], [selectedId])
  const sessions = useAppStore(useShallow(state => selectedTab ? [] : selectedSessionIds.flatMap(id => { const session = sessionPresentationById(state.sessions).get(id); return session ? [session] : [] })))
  const executionHistory = useAppStore((state) => state.agentFocus.execution.history)
  const focusPmoSession = useAppStore(state => state.focusPmoSession)
  const focusRegion = useAppStore(state => state.focusRegion)
  const focusExecutionSession = useAppStore((state) => state.focusExecutionSession)
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('all')
  const [bucketFilter, setBucketFilter] = useState<FocusBucket | 'all'>('all')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [workspaceRatio, setWorkspaceRatio] = useState(0.618)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const closeWorkspaceReturnRef = useRef(false)
  const closeWorkspace = () => { closeWorkspaceReturnRef.current = true; focusExecutionSession(null) }
  useEffect(() => {
    if (!closeWorkspaceReturnRef.current) return
    closeWorkspaceReturnRef.current = false
    if (selectedId === null) searchRef.current?.focus()
  }, [selectedId])
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
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stop)
    return () => { window.removeEventListener('pointermove', onPointerMove); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); window.removeEventListener('blur', stop) }
  }, [])
  const { facts, errors: hierarchyErrors } = useFocusHierarchy(laneContexts, config)
  const allLanes = useMemo(() => deriveFocusProjectLanes(laneContexts, config, facts, tabs), [laneContexts, config, facts, tabs])
  const search = query.trim().toLocaleLowerCase()
  const laneByContext = new Map(allLanes.flatMap(lane => lane.contextIds.map(id => [id, lane] as const)))
  const matching = executionRows.filter(row => (project === 'all' || laneByContext.get(row.id)?.projectId === project) && `${row.name} ${row.detail} ${row.stateLabel} ${row.workspacePath} ${laneByContext.get(row.id)?.name ?? row.workspaceName} ${row.providerId ?? ''}`.toLocaleLowerCase().includes(search))
  const filtered = matching.filter(row => bucketFilter === 'all' || row.bucket === bucketFilter)
  const selected = executionRows.find(row => row.id === selectedId)
  const filteredIds = new Set(filtered.map(row => row.id))
  const focusProjectLanes = allLanes.filter(lane => lane.contextIds.some(id => filteredIds.has(id)))
  const rowsById = new Map(filtered.map(row => [row.id, row]))
  // Qualification uses the original project membership, before state/search filters.
  const liveProjects = new Set(executionRows.filter(row => row.state !== 'disconnected').map(row => laneByContext.get(row.id)?.projectId))
  const disconnectedLanes = focusProjectLanes.filter(lane => !liveProjects.has(lane.projectId))
  const boardLanes = focusProjectLanes.filter(lane => liveProjects.has(lane.projectId))
  const bucketMeta = { attention: { label: 'Attention', icon: Inbox }, working: { label: 'Working', icon: PlayCircle }, results: { label: 'Results', icon: CheckCircle2 }, idle: { label: 'Idle / Recovery', icon: CirclePause } }
  const buckets = Object.keys(bucketMeta) as FocusBucket[]
  const laneRows = (lane: typeof focusProjectLanes[number], heading: ReactNode) => {
    const rows = lane.contextIds.flatMap(id => { const row = rowsById.get(id); return row ? [row] : [] })
    const columnStyle = { '--focus-state-columns': buckets.map(bucket => {
      const count = rows.filter(row => row.bucket === bucket).length
      return count ? `minmax(160px, ${Math.min(count, 3)}fr)` : '36px'
    }).join(' ') } as CSSProperties
    return <>{heading}<div className="focus-project-lanes__groups" style={columnStyle}>
      {buckets.map(bucket => {
        const meta = bucketMeta[bucket], Icon = meta.icon, grouped = rows.filter(row => row.bucket === bucket)
        return <section className="focus-context-group global-agents-group" aria-label={meta.label} data-bucket={bucket} data-empty={grouped.length === 0 ? 'true' : undefined} key={bucket}>
          <header className="focus-context-group__header" title={`${meta.label} · ${grouped.length}`} aria-label={`${meta.label} · ${grouped.length}`}><span className="focus-context-group__bucket"><Icon size={12} /><strong>{meta.label}</strong><span>{grouped.length}</span></span></header>
          <div className="focus-context-group__cards">{bucket === 'idle' ? <FocusRecoveryGroup contexts={grouped} selectedId={selectedId} searching={Boolean(search)} onSelect={focusExecutionSession} /> : grouped.map(context => <FocusContextRow key={context.id} context={context} selected={selectedId === context.id} onSelect={focusExecutionSession} />)}</div>
        </section>
      })}
    </div></>
  }
  return <section className={`global-board-surface global-focus-surface ${selectedId ? 'global-board-surface--session-open' : ''}`} aria-label="Focus" style={{ '--focus-workspace-width': `calc(${workspaceRatio * 100}% - 6px)` } as CSSProperties}>
    <FocusToolbar selectedId={selectedId} selected={selected} tab={selectedTab} onReview={() => setRequestId(selectedId)} onCloseWorkspace={closeWorkspace}>
      <div className={`focus-filters${isMacPlatform() ? ' focus-filters--mac' : ''}`}>
        <div className="global-board-toolbar__controls">
          <label className="global-board-search"><Search size={13} /><input ref={searchRef} aria-label="Search contexts" placeholder="Search contexts" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label className="global-board-select"><select aria-label="Focus project filter" value={project} onChange={(event) => setProject(event.target.value)}><option value="all">All projects</option>{[...new Map(allLanes.map(lane => [lane.projectId, { id: lane.projectId, name: lane.labels[0]! }])).values()].map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
          <label className="global-board-select"><select aria-label="Focus state filter" value={bucketFilter} onChange={event => setBucketFilter(event.target.value as FocusBucket | 'all')}><option value="all">All states</option>{(Object.keys(bucketMeta) as FocusBucket[]).map(bucket => <option key={bucket} value={bucket}>{bucketMeta[bucket].label} · {matching.filter(row => row.bucket === bucket).length}</option>)}</select></label>
        </div>
      </div>
    </FocusToolbar>
    <div ref={focusLayoutRef} className="global-focus-layout">
      <div className="global-board-main global-focus-main">
      {hierarchyErrors.length ? <p className="focus-hierarchy-warning" role="status" title={hierarchyErrors.join('\n')}>Some lane details could not load. Contexts remain available.</p> : null}
      {pmoAttention.length ? <button type="button" className="focus-pmo-attention" onClick={() => {
        const id = pmoAttention[0]!
        focusPmoSession(id)
        const tab = tabForFocusedSession(tabs, id)
        const region = tab && Object.values(tab.regions).find(region => region.kind === 'agent' && region.sessionId === id)
        if (tab && region && tab.layout.activeRegionId !== region.regionId) focusRegion(tab.workspaceId, tab.id, region.regionId)
        requestPmoTeamsTopicFloatingOpen({ ...(tab ? { targetTabId: tab.id } : {}), onReturnFocus: () => {
          if (useAppStore.getState().mainSurface === 'agents') searchRef.current?.focus({ preventScroll: true })
        } })
      }}>Mote · {pmoAttention.length} to review <span>Open context ↗</span></button> : null}
      {executionRows.length === 0 ? <div className="global-agents-empty" role="status"><Users size={20} /><strong>No execution contexts yet</strong><span>Open an Agent or Terminal from a Workspace to make it appear here.</span></div> : <div className="global-board-columns" aria-label="Global execution contexts">
        <div className="focus-project-board">
          {boardLanes.length ? <FocusProjectLanes lanes={boardLanes} selectedWorkspaceId={project} onSelect={setProject} renderLane={laneRows} /> : null}
          {filtered.length === 0 ? <p className="focus-project-lanes__empty">No matching contexts</p> : null}
          <FocusDisconnectedProjects lanes={disconnectedLanes} contexts={rowsById} selectedId={selectedId} projectId={project} searching={Boolean(search)} onProject={setProject} onSelect={focusExecutionSession} />
        </div>
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
        if (event.button !== 0) return
        event.preventDefault()
        resizingFocusRef.current = true
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); adjustWorkspaceRatio(workspaceRatio + 0.02) }
        if (event.key === 'ArrowRight') { event.preventDefault(); adjustWorkspaceRatio(workspaceRatio - 0.02) }
        if (event.key === 'Home') { event.preventDefault(); adjustWorkspaceRatio(0.38) }
        if (event.key === 'End') { event.preventDefault(); adjustWorkspaceRatio(0.76) }
      }}
    /><aside className="global-session-workspace" aria-label="Focus workspace">
      {selectedTab
        ? <div id="focus-workspace-slot" className="focused-tab-workspace" data-focus-tab-id={selectedTab.id} />
        : <><AgentTopologySummary sessionIds={selectedSessionIds} sessions={sessions} tabs={tabs} config={config} /><SessionObservationRegions sessionIds={selectedSessionIds} contextId={`agent:${selectedId}`} /></>}
    </aside></> : null}
    </div>
    <RecentFocusTimeline entries={executionHistory} currentSessionId={selectedId} contexts={executionRows} lanes={allLanes} hierarchy={facts} onSelect={focusExecutionSession} />
    {requestId ? <AttentionRequestPanel sessionId={requestId} onClose={() => setRequestId(null)} onReturnFocus={() => {
      if (useAppStore.getState().mainSurface === 'agents') searchRef.current?.focus()
    }} onSessionChange={focusExecutionSession} /> : null}
  </section>
}
