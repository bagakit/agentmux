import { Check, CheckCircle2, CirclePause, Inbox, ListFilter, PlayCircle, Search, Unplug, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { createFocusProjectionSelector, type FocusBucket, type FocusContext } from '../lib/focus-context'
import { FocusContextRow } from './FocusContextRow'
import { useFocusHierarchy } from '../lib/use-focus-hierarchy'
import { FocusDisconnectedGroup } from './FocusDisconnectedGroup'
import { FocusDisconnectedProjects } from './FocusDisconnectedProjects'
import { deriveFocusProjectLanes } from '../lib/focus-project-lanes'
import { tabForFocusedSession, type ExecutionFocusPresentation } from '../lib/focus-tab-projection'
import { AttentionRequestPanel } from './AttentionRequestPanel'
import { SessionObservationRegions } from './SessionObservationRegions'
import { AgentTopologySummary } from './AgentTopologySummary'
import { FocusProjectLanes } from './FocusProjectLanes'
import { FocusToolbar } from './FocusToolbar'
import * as FilterMenu from './HoverDropdownMenu'
import { RecentFocusTimeline } from './RecentFocusTimeline'
import { requestPmoTeamsTopicFloatingOpen } from '../lib/pmo-teams-topic-floating'
import { isMacPlatform } from '../lib/host-platform'
import { executionFocusSessionId } from '../lib/agent-focus'
import { sessionPresentationById } from '../lib/session-presentation'
import { topicIdForSession, workspaceForSession } from '../lib/workbench-tabs'
import { scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import type { WorkbenchViewTarget } from '../lib/workbench-presentation'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { groupIds, regionIds } from '@agentmux/layout'

type FocusColumn = FocusBucket | 'disconnected'
// Presentation only: an observation connection loss cannot retire a running Run.
function columnFor(context: FocusContext): FocusColumn {
  return context.bucket !== 'attention' && context.state === 'disconnected' && context.processState !== 'running'
    ? 'disconnected' : context.bucket
}

export function GlobalFocusSurface({ presentation, directoryIssue = null, viewTargets }: {
  presentation?: ExecutionFocusPresentation
  directoryIssue?: string | null
  viewTargets?: Readonly<Record<string, WorkbenchViewTarget>>
} = {}) {
  const contextSelector = useMemo(createFocusProjectionSelector, [])
  const {contexts: executionRows, laneContexts, pmoAttention} = useAppStore(useShallow(contextSelector))
  const moteIdentity = useAppStore(useShallow(state => {
    const session = state.sessions.find(item => item.id === pmoAttention[0])
    const workspace = session && workspaceForSession(state.config, session)
    const id = session && topicIdForSession(state.config, session)
    const topic = id && scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)?.find(item => item.id === id)
    const target = workspace && topic && !topic.readError ? topicSpaceIconTarget(workspace, topic) : null
    const key = target?.key
    return { name: topic && !topic.readError ? topic.title || 'Mote' : 'Mote', icon: key ? state.spaceObjectIcons[key] ?? null : null, avatarWorkspaceId: target?.avatarTarget?.workspaceId, avatarTopicId: target?.avatarTarget?.topicId, avatarObjectKey: key }
  }))
  const config = useAppStore((state) => state.config)
  const topicSnapshots = useAppStore(state => state.scratchTopicSnapshots)
  const tabs = useAppStore((state) => state.tabs)
  const layouts = useAppStore(state => state.layouts)
  const selectedId = useAppStore((state) => executionFocusSessionId(state.agentFocus))
  const projection = presentation?.projection ?? null
  const selectedTab = projection?.entity.kind === 'tab' ? tabs[projection.entity.tabId] ?? null : null
  const selectedSessionIds = useMemo(() => selectedId ? [selectedId] : [], [selectedId])
  const sessions = useAppStore(useShallow(state => selectedTab ? [] : selectedSessionIds.flatMap(id => { const session = sessionPresentationById(state.sessions).get(id); return session ? [session] : [] })))
  const executionHistory = useAppStore((state) => state.agentFocus.execution.history)
  const focusPmoSession = useAppStore(state => state.focusPmoSession)
  const focusRegion = useAppStore(state => state.focusRegion)
  const focusExecutionSession = useAppStore((state) => state.focusExecutionSession)
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('all')
  const [bucketFilter, setBucketFilter] = useState<FocusColumn | 'all'>('all')
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
  const allLanes = useMemo(() => deriveFocusProjectLanes(laneContexts, config, facts, tabs, Date.now(), topicSnapshots), [laneContexts, config, facts, tabs, topicSnapshots])
  const trimmedQuery = query.trim()
  const search = trimmedQuery.toLocaleLowerCase()
  const laneByContext = new Map(allLanes.flatMap(lane => lane.contextIds.map(id => [id, lane] as const)))
  const matching = executionRows.filter(row => (project === 'all' || laneByContext.get(row.id)?.projectId === project) &&
    ((row.kind === 'agent' && row.id.includes(trimmedQuery)) || `${row.name} ${row.detail} ${row.stateLabel} ${row.workspacePath} ${laneByContext.get(row.id)?.name ?? row.workspaceName} ${row.providerId ?? ''}`.toLocaleLowerCase().includes(search)))
  const filtered = matching.filter(row => bucketFilter === 'all' || columnFor(row) === bucketFilter)
  const selected = executionRows.find(row => row.id === selectedId)
  const filteredIds = new Set(filtered.map(row => row.id))
  const focusProjectLanes = allLanes.filter(lane => lane.contextIds.some(id => filteredIds.has(id)))
  const rowsById = new Map(filtered.map(row => [row.id, row]))
  // Qualification uses the original project membership, before state/search filters.
  const liveProjects = new Set(executionRows.filter(row => columnFor(row) !== 'disconnected').map(row => laneByContext.get(row.id)?.projectId))
  const disconnectedLanes = focusProjectLanes.filter(lane => !liveProjects.has(lane.projectId))
  const boardLanes = focusProjectLanes.filter(lane => liveProjects.has(lane.projectId))
  const bucketMeta = { attention: { label: 'Attention', icon: Inbox }, working: { label: 'Working', icon: PlayCircle }, results: { label: 'Results', icon: CheckCircle2 }, idle: { label: 'Idle / Recovery', icon: CirclePause }, disconnected: { label: 'Disconnected', icon: Unplug } }
  const buckets = Object.keys(bucketMeta) as FocusColumn[]
  const projectOptions = [...new Map(allLanes.map(lane => [lane.projectId, { id: lane.projectId, name: lane.labels[0]! }])).values()]
  const filterSummary = `${projectOptions.find(option => option.id === project)?.name ?? 'All projects'} · ${bucketFilter === 'all' ? 'All states' : bucketMeta[bucketFilter].label}`
  const filterCount = Number(project !== 'all') + Number(bucketFilter !== 'all')
  const laneRows = (lane: typeof focusProjectLanes[number], heading: ReactNode) => {
    const rows = lane.contextIds.flatMap(id => { const row = rowsById.get(id); return row ? [row] : [] })
    const columnStyle = { '--focus-state-columns': buckets.map(bucket => {
      const count = rows.filter(row => columnFor(row) === bucket).length
      return count ? bucket === 'disconnected' ? 'minmax(128px, 1fr)' : `minmax(160px, ${Math.min(count, 3)}fr)` : '36px'
    }).join(' ') } as CSSProperties
    return <>{heading}<div className="focus-project-lanes__groups" style={columnStyle}>
      {buckets.map(bucket => {
        const meta = bucketMeta[bucket], Icon = meta.icon, grouped = rows.filter(row => columnFor(row) === bucket)
        return <section className="focus-context-group global-agents-group" aria-label={meta.label} data-bucket={bucket} data-empty={grouped.length === 0 ? 'true' : undefined} key={bucket}>
          <header className="focus-context-group__header" title={`${meta.label} · ${grouped.length}`} aria-label={`${meta.label} · ${grouped.length}`}><span className="focus-context-group__bucket"><Icon size={12} /><strong>{meta.label}</strong><span>{grouped.length}</span></span></header>
          <div className="focus-context-group__cards">{bucket === 'disconnected' ? <FocusDisconnectedGroup contexts={grouped} selectedId={selectedId} searching={Boolean(search)} onSelect={focusExecutionSession} /> : grouped.map(context => <FocusContextRow key={context.id} context={context} selected={selectedId === context.id} onSelect={focusExecutionSession} />)}</div>
        </section>
      })}
    </div></>
  }
  return <section className={`global-board-surface global-focus-surface ${selectedId ? 'global-board-surface--session-open' : ''}`} aria-label="Focus" style={{ '--focus-workspace-width': `calc(${workspaceRatio * 100}% - 6px)` } as CSSProperties}>
    <FocusToolbar selectedId={selectedId} selected={selected} tab={selectedTab} onReview={() => setRequestId(selectedId)} onCloseWorkspace={closeWorkspace}>
      <div className={`focus-filters${isMacPlatform() ? ' focus-filters--mac' : ''}`}>
        <div className="global-board-toolbar__controls">
          <label className="global-board-search"><Search size={13} /><input ref={searchRef} aria-label="Search contexts" placeholder="Search contexts or amux ID" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <FilterMenu.Root>
            <FilterMenu.Trigger asChild><button type="button" className="focus-filter-trigger" aria-label="Focus filters" aria-description={filterSummary} title={filterSummary} data-active={filterCount > 0 ? 'true' : undefined}>
              <ListFilter size={14} aria-hidden="true" /><span className="focus-filter-trigger__summary">{filterSummary}</span>{filterCount ? <span className="focus-filter-trigger__count" aria-hidden="true">{filterCount}</span> : null}
            </button></FilterMenu.Trigger>
            <FilterMenu.Portal><FilterMenu.Content className="tab-context-menu focus-filter-menu" align="end" sideOffset={4} collisionPadding={8} onCloseAutoFocus={event => {
              // Preserve a later deliberate focus; explicit Escape still returns to this trigger.
              const focused = document.activeElement
              if (focused instanceof HTMLElement && focused.isConnected && focused !== document.body
                && !focused.closest('[hidden], [inert]') && event.target instanceof HTMLElement && !event.target.contains(focused)) event.preventDefault()
            }}>
              <FilterMenu.Label className="focus-filter-menu__label">Project</FilterMenu.Label>
              <FilterMenu.RadioGroup className="focus-filter-menu__projects" aria-label="Focus project filter" value={project} onValueChange={setProject}>
                {[{ id: 'all', name: 'All projects' }, ...projectOptions].map(option => <FilterMenu.RadioItem key={option.id} value={option.id} data-focus-project={option.id} className="tab-context-menu__item focus-filter-menu__item">
                  <span className="focus-filter-menu__check"><FilterMenu.ItemIndicator><Check size={13} /></FilterMenu.ItemIndicator></span><span>{option.name}</span>
                </FilterMenu.RadioItem>)}
              </FilterMenu.RadioGroup>
              <FilterMenu.Separator className="tab-context-menu__separator" />
              <FilterMenu.Label className="focus-filter-menu__label">State</FilterMenu.Label>
              <FilterMenu.RadioGroup aria-label="Focus state filter" value={bucketFilter} onValueChange={value => setBucketFilter(value as FocusColumn | 'all')}>
                {[{ id: 'all', label: 'All states' }, ...buckets.map(bucket => ({ id: bucket, label: `${bucketMeta[bucket].label} · ${matching.filter(row => columnFor(row) === bucket).length}` }))].map(option => <FilterMenu.RadioItem key={option.id} value={option.id} data-focus-state={option.id} className="tab-context-menu__item focus-filter-menu__item">
                  <span className="focus-filter-menu__check"><FilterMenu.ItemIndicator><Check size={13} /></FilterMenu.ItemIndicator></span><span>{option.label}</span>
                </FilterMenu.RadioItem>)}
              </FilterMenu.RadioGroup>
            </FilterMenu.Content></FilterMenu.Portal>
          </FilterMenu.Root>
        </div>
      </div>
    </FocusToolbar>
    <div ref={focusLayoutRef} className="global-focus-layout">
      <div className="global-board-main global-focus-main">
      {hierarchyErrors.length ? <p className="focus-hierarchy-warning" role="status" title={hierarchyErrors.join('\n')}>Some lane details could not load. Contexts remain available.</p> : null}
      {pmoAttention.length ? <button type="button" className="focus-pmo-attention" onClick={() => {
        const id = pmoAttention[0]!
        const current = useAppStore.getState()
        const tab = tabForFocusedSession(current.tabs, id)
        const session = sessionPresentationById(current.sessions).get(id)
        const topicId = tab?.topicId ?? (session ? topicIdForSession(current.config, session) : null)
        if (!topicId) {
          current.reportError(new Error('Mote context identity is not confirmed. The original work surface is retained.'))
          return
        }
        focusPmoSession(id)
        const region = tab && Object.values(tab.regions).find(region => region.kind === 'agent' && region.sessionId === id)
        if (tab && region && tab.layout.activeRegionId !== region.regionId) focusRegion(tab.workspaceId, tab.id, region.regionId)
        requestPmoTeamsTopicFloatingOpen({ targetTopicId: topicId, ...(tab ? { targetTabId: tab.id } : {}), onReturnFocus: () => {
          if (useAppStore.getState().mainSurface === 'agents') searchRef.current?.focus({ preventScroll: true })
        } })
      }}><span className="focus-pmo-attention__identity"><SpaceObjectIcon kind="mote" name={moteIdentity.name} manualIcon={moteIdentity.icon} avatarWorkspaceId={moteIdentity.avatarWorkspaceId} avatarTopicId={moteIdentity.avatarTopicId} avatarObjectKey={moteIdentity.avatarObjectKey} /><strong>{moteIdentity.name}</strong><span>· {pmoAttention.length} to review</span></span><span>Open context ↗</span></button> : null}
      {executionRows.length === 0 ? <div className="global-agents-empty" role="status"><Users size={20} /><strong>No execution contexts yet</strong><span>Open an Agent from a Workspace to make it appear here.</span></div> : <div className="global-board-columns" aria-label="Global execution contexts">
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
      {selectedTab && projection
        ? <div className="focused-tab-workspace" data-focus-tab-id={selectedTab.id}>
          <WorkspaceWorkbench workspaceId={projection.displayWorkspaceId} projection={projection}
            viewOwnership="projection" viewTargets={viewTargets} visible />
        </div>
        : presentation?.issue || directoryIssue
          ? <div className="global-session-workspace__empty focus-location-recovery">
            <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
              step: 'Focus work surface', mode: directoryIssue ?? presentation!.issue!,
              restore: 'Choose a confirmed location. The original Session and work surfaces are retained.'
            } }} />
            {presentation?.references.length ? <div className="focus-location-choices" aria-label="Choose Focus location">{presentation.references.map(reference => {
              const layout = layouts[reference.displayWorkspaceId], tab = tabs[reference.tabId]
              const groupIndex = layout ? groupIds(layout.root).indexOf(reference.groupId) : -1
              const regionIndex = tab ? regionIds(tab.layout.root).indexOf(reference.regionId) : -1
              return <button type="button" className="small-button focus-location-choice" key={JSON.stringify(reference)} onClick={() => focusExecutionSession(selectedId, reference)}
                title={`${reference.displayWorkspaceId} / ${reference.groupId} / ${reference.tabId} / ${reference.regionId}`}>
                <strong>{tab?.name ?? reference.tabId}</strong>
                <small>{config?.workspaces.find(workspace => workspace.id === reference.displayWorkspaceId)?.name ?? reference.displayWorkspaceId}
                  {' · '}{groupIndex >= 0 ? `Group ${groupIndex + 1}` : reference.groupId}
                  {' · '}{regionIndex >= 0 ? `Region ${regionIndex + 1}` : reference.regionId}</small>
              </button>
            })}</div> : null}
          </div>
          : <><AgentTopologySummary sessionIds={selectedSessionIds} sessions={sessions} tabs={tabs} config={config} /><SessionObservationRegions sessionIds={selectedSessionIds} contextId={`agent:${selectedId}`} /></>}
    </aside></> : null}
    </div>
    <RecentFocusTimeline entries={executionHistory} currentSessionId={selectedId} contexts={executionRows} lanes={allLanes} hierarchy={facts} onSelect={focusExecutionSession} />
    {requestId ? <AttentionRequestPanel sessionId={requestId} onClose={() => setRequestId(null)} onReturnFocus={() => {
      if (useAppStore.getState().mainSurface === 'agents') searchRef.current?.focus()
    }} onSessionChange={focusExecutionSession} /> : null}
  </section>
}
