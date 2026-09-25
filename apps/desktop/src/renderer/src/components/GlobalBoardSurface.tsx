import { ArrowUpRight, Check, CirclePlus, Columns3, List, Search, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { sessionPresentationById } from '../lib/session-presentation'
import { goalNextStep } from '../lib/goal-presentation'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import { executionFocusSessionId } from '../lib/agent-focus'
import { DEMAND_STATUS_IDS, demandColumns, projectDemands, type DemandProjection, type DemandStatus } from '../lib/global-demand-board'
import { requestPmoTeamsTopicFloatingOpen } from '../lib/pmo-teams-topic-floating'
import { ComposerTextarea } from './ComposerTextarea'
import { GoalDetail } from './GoalDetail'
import { EMPTY_GOAL_ACKNOWLEDGEMENT, type GoalAcknowledgementFeedback } from './GoalAlignment'
import { GOAL_EXPLORATION_ACTIONS, goalExplorationNextText, goalExplorationPending, goalExplorationProject, startGoalExploration, subscribeGoalExploration, type GoalExplorationProject } from '../lib/goals-entry-actions'

function GoalsEntryActions() {
  const config = useAppStore(state => state.config)
  const focus = useAppStore(state => state.agentFocus)
  const activeWorkspaceId = useAppStore(state => state.activeWorkspaceId)
  const project = useMemo(() => goalExplorationProject(config, focus, activeWorkspaceId), [config, focus, activeWorkspaceId])
  const pending = useSyncExternalStore(subscribeGoalExploration, goalExplorationPending, goalExplorationPending)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  function start(text: string, context?: GoalExplorationProject) {
    setError(null)
    void startGoalExploration(text, context).catch(cause => {
      // Bound preparation/launch failures already belong to the visible launcher and original notice owner.
      if (mounted.current && useAppStore.getState().mainSurface === 'board') setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  return <section className="goals-entry" aria-label="开始对话">
    <p className="goals-entry__heading">从这里开始</p>
    <div className="goals-entry__actions">
      {GOAL_EXPLORATION_ACTIONS.map(action => <button key={action.id} type="button" data-goals-entry-action={action.id} disabled={pending} onClick={() => start(action.text)}><span>{action.text}</span><ArrowUpRight size={14} /></button>)}
      {project ? <button type="button" data-goals-entry-action="next" disabled={pending} onClick={() => start(goalExplorationNextText(project), project)}><span>{goalExplorationNextText(project)}<small title={`${project.id} · ${project.hostId} · ${project.path}`}>{project.source === 'recent' ? '最近项目' : '当前项目'} · {project.name}</small></span><ArrowUpRight size={14} /></button> : null}
    </div>
    {error ? <p className="goals-service" role="status">对话准备未确认，请求尚未发送。请核对原因后再选择上面的请求。<span>{error}</span></p> : null}
  </section>
}

export const GOAL_STATUS_LABELS: Record<DemandStatus, string> = {
  backlog: 'Backlog', todo: 'Todo', in_progress: 'In progress', in_review: 'In review', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled'
}

function GoalRow({ demand, selected, sessionContext, acknowledgementFailed, onSelect }: { demand: DemandProjection; selected: boolean; sessionContext: boolean; acknowledgementFailed: boolean; onSelect: () => void }) {
  const execution = useAppStore(useShallow((state) => {
    const byId = sessionPresentationById(state.sessions)
    let count = 0; const statuses = new Set<string>()
    for (const id of demand.sessionIds) { const session = byId.get(id); if (session) { count++; statuses.add(session.status.state.replaceAll('_', ' ')) } }
    return { count, status: [...statuses].join(' / ') }
  }))
  const nextStep = acknowledgementFailed ? 'Reload current proposal' : goalNextStep(demand)
  return <div role="button" tabIndex={0} className={`goals-row${selected ? ' goals-row--selected' : ''}`} data-demand-id={demand.id} data-demand-status={demand.status} {...(sessionContext ? { 'data-session-context': true } : {})} aria-pressed={selected} aria-label={`Open goal ${demand.title}. ${nextStep}`} onClick={onSelect} onKeyDown={(event) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() }
  }}>
    <span className="goals-row__copy"><strong title={demand.title}>{demand.title}</strong><span className="goals-row__facts">{demand.projectName ? <span title={demand.projectName}>{demand.projectName}</span> : null}{execution.count ? <span>{execution.count} linked · {execution.status}</span> : null}{sessionContext ? <span>Current execution</span> : null}</span></span>
    <span className="goals-row__next">{nextStep}</span>
    {selected ? <Check className="goals-row__selected" size={13} aria-label="Selected goal" /> : null}
  </div>
}

const EMPTY_EXECUTORS: Record<string, { label: string }> = {}
export function GlobalBoardSurface() {
  const config = useAppStore((state) => state.config)
  const demands = useAppStore((state) => state.demands)
  const selectedDemandId = useAppStore((state) => state.selectedDemandId)
  const selectedSessionId = useAppStore((state) => executionFocusSessionId(state.agentFocus))
  const setSelectedDemand = useAppStore((state) => state.setSelectedDemand)
  const createDemand = useAppStore((state) => state.createDemand)
  const requestDemandPmoTask = useAppStore((state) => state.requestDemandPmoTask)
  const openDemandPmo = useAppStore((state) => state.openDemandPmo)
  const executors = config?.executors ?? EMPTY_EXECUTORS
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'list' | 'board'>('list')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [statusFilter, setStatusFilter] = useState<DemandStatus | 'all'>('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [routingFilter, setRoutingFilter] = useState<'all' | 'unassigned' | 'assigned'>('all')
  const [executorFilter, setExecutorFilter] = useState('all')
  const [showHistory, setShowHistory] = useState(false)
  const [intakeOpen, setIntakeOpen] = useState(false)
  const [intent, setIntent] = useState('')
  const [saving, setSaving] = useState(false)
  const [creationError, setCreationError] = useState<string | null>(null)
  const [moteErrors, setMoteErrors] = useState<Record<string, { message: string; mode: 'open' | 'grill' | 'grounding' }>>({})
  const [motePending, setMotePending] = useState<Record<string, 'open' | 'grill' | 'grounding'>>({})
  const [acknowledgementFeedback, setAcknowledgementFeedback] = useState<Record<string, GoalAcknowledgementFeedback>>({})
  const moteRequests = useRef(new Set<string>())
  const newGoalRef = useRef<HTMLButtonElement>(null)
  const filterRef = useRef<HTMLButtonElement>(null)
  const selectedRowRef = useRef<HTMLElement | null>(null)
  const surfaceRef = useRef<HTMLElement>(null)
  const goalDrafts = useRef(new Map<string, Partial<Record<'title' | 'description', string>>>())
  const projectedDemands = useMemo(() => projectDemands(config, [], demands), [demands, config])
  const selectedDemand = projectedDemands.find((demand) => demand.id === selectedDemandId) ?? null
  const projects = useMemo(() => (config?.workspaces ?? []).filter((workspace) => workspace.id !== SCRATCH_WORKSPACE_ID), [config?.workspaces])
  const filteredDemands = useMemo(() => projectedDemands.filter((demand) => {
    const normalized = query.trim().toLocaleLowerCase()
    const matchesQuery = !normalized || `${demand.title} ${demand.description} ${demand.projectName ?? ''}`.toLocaleLowerCase().includes(normalized)
    const matchesRouting = routingFilter === 'all' || (routingFilter === 'unassigned' ? !demand.projectId || !demand.assigneeExecutorId : Boolean(demand.projectId && demand.assigneeExecutorId))
    const matchesHistory = showHistory || statusFilter !== 'all' || (demand.status !== 'done' && demand.status !== 'cancelled')
    return matchesQuery && matchesHistory && (statusFilter === 'all' || demand.status === statusFilter) && (projectFilter === 'all' || demand.projectId === projectFilter) && matchesRouting && (executorFilter === 'all' || demand.assigneeExecutorId === executorFilter)
  }), [executorFilter, projectFilter, query, routingFilter, statusFilter, showHistory, projectedDemands])
  const columns = useMemo(() => demandColumns(filteredDemands), [filteredDemands])
  const appliedFilters = [
    ...(statusFilter !== 'all' ? [{ label: GOAL_STATUS_LABELS[statusFilter], clear: () => setStatusFilter('all') }] : []),
    ...(projectFilter !== 'all' ? [{ label: projects.find((project) => project.id === projectFilter)?.name ?? projectFilter, clear: () => setProjectFilter('all') }] : []),
    ...(routingFilter !== 'all' ? [{ label: routingFilter === 'unassigned' ? 'Needs routing' : 'Assigned', clear: () => setRoutingFilter('all') }] : []),
    ...(executorFilter !== 'all' ? [{ label: executors[executorFilter]?.label ?? executorFilter, clear: () => setExecutorFilter('all') }] : [])
  ]

  function closeDetail() {
    const row = surfaceRef.current?.querySelector<HTMLElement>('[data-demand-id][aria-pressed="true"]') ?? selectedRowRef.current
    setSelectedDemand(null); queueMicrotask(() => { if (row?.isConnected) row.focus(); else newGoalRef.current?.focus() })
  }
  async function openMote(demandId: string, mode?: 'grill' | 'grounding') {
    if (moteRequests.current.has(demandId)) return
    moteRequests.current.add(demandId); setMotePending(current => ({ ...current, [demandId]: mode ?? 'open' }))
    try {
      const tabId = mode ? await requestDemandPmoTask(demandId, mode) : await openDemandPmo(demandId)
      requestPmoTeamsTopicFloatingOpen({ targetTabId: tabId })
      setMoteErrors(current => { const next = { ...current }; delete next[demandId]; return next })
    } catch (error) { setMoteErrors(current => ({ ...current, [demandId]: { mode: mode ?? 'open', message: error instanceof Error ? error.message : String(error) } })) }
    finally { moteRequests.current.delete(demandId); setMotePending(current => { const next = { ...current }; delete next[demandId]; return next }) }
  }
  async function submitIntent() {
    if (!intent.trim() || saving) return
    setSaving(true); setCreationError(null)
    const project = projects.find((candidate) => candidate.id === projectFilter)
    try {
      const demandId = await createDemand({ title: intent.trim().split('\n')[0]!.slice(0, 100), description: intent, projectId: project?.id ?? null, projectName: project?.name ?? null, status: 'backlog', source: 'default-topic' })
      setSelectedDemand(demandId); setIntakeOpen(false); setIntent('')
      await openMote(demandId, 'grill')
    } catch (error) { setCreationError(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  function renderRow(demand: DemandProjection) { return <GoalRow key={demand.id} demand={demand} selected={demand.id === selectedDemandId} acknowledgementFailed={Boolean(acknowledgementFeedback[demand.id]?.failure)} sessionContext={Boolean(selectedSessionId && demand.sessionIds.includes(selectedSessionId))} onSelect={() => { selectedRowRef.current = document.activeElement as HTMLElement; setSelectedDemand(demand.id) }} /> }

  return <section ref={surfaceRef} className={`global-board-surface goals-surface${selectedDemandId ? ' goals-surface--detail-open' : ''}`} onKeyDown={(event) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
    if (intakeOpen && !saving) { setIntakeOpen(false); queueMicrotask(() => newGoalRef.current?.focus()) }
    else if (filtersOpen) { setFiltersOpen(false); queueMicrotask(() => filterRef.current?.focus()) }
    else if (selectedDemand && !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) closeDetail()
  }}>
    <div className="goals-index">
      <GoalsEntryActions />
      <header className="goals-toolbar">
        <label className="goals-search"><Search size={14} /><input aria-label="Search goals" placeholder="Search goals…" value={query} onChange={(event) => setQuery(event.target.value)} />{query ? <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button> : null}</label>
        <button ref={filterRef} type="button" className={`goals-button${appliedFilters.length ? ' is-active' : ''}`} aria-label="Goal filters" aria-expanded={filtersOpen} aria-controls="goals-filters" onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={13} /><span>Filter</span>{appliedFilters.length ? <span>{appliedFilters.length}</span> : null}</button>
        <div className="goals-view-toggle" role="group" aria-label="Goal view"><button type="button" aria-label="List view" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={14} /></button><button type="button" aria-label="Board view" aria-pressed={view === 'board'} onClick={() => setView('board')}><Columns3 size={14} /></button></div>
        <button ref={newGoalRef} type="button" className="goals-button" onClick={() => setIntakeOpen(true)}><CirclePlus size={13} />New Goal</button>
      </header>
      {filtersOpen ? <div id="goals-filters" className="goals-filters" aria-label="Filter goals">
        <label>Work status<select aria-label="Filter work status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">All active</option>{DEMAND_STATUS_IDS.map((status) => <option key={status} value={status}>{GOAL_STATUS_LABELS[status]}</option>)}</select></label>
        <label>Project<select aria-label="Filter project" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">All projects</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label>Routing<select aria-label="Filter routing" value={routingFilter} onChange={(event) => setRoutingFilter(event.target.value as typeof routingFilter)}><option value="all">All</option><option value="unassigned">Needs routing</option><option value="assigned">Assigned</option></select></label>
        <label>Executor<select aria-label="Filter executor" value={executorFilter} onChange={(event) => setExecutorFilter(event.target.value)}><option value="all">Any executor</option>{Object.entries(executors).map(([id, executor]) => <option key={id} value={id}>{executor.label}</option>)}</select></label>
      </div> : null}
      {appliedFilters.length ? <div className="goals-filter-chips">{appliedFilters.map((filter) => <button type="button" key={filter.label} onClick={filter.clear} aria-label={`Clear ${filter.label} filter`}>{filter.label}<X size={11} /></button>)}</div> : null}
      {intakeOpen ? <form className="goals-intake" aria-label="New goal" onSubmit={(event) => { event.preventDefault(); void submitIntent() }}>
        <label htmlFor="goal-intent">What would you like to achieve?</label>
        <ComposerTextarea id="goal-intent" autoFocus aria-label="Goal intent" placeholder="Describe the outcome in your own words…" value={intent} onValueChange={setIntent} rows={4} disabled={saving} />
        <div className="goals-intake__footer"><span>{projects.find((project) => project.id === projectFilter)?.name ?? 'No project selected'}</span><button type="button" className="goals-button" disabled={saving} onClick={() => { setIntakeOpen(false); newGoalRef.current?.focus() }}>Cancel</button><button type="submit" className="goals-button goals-button--primary" disabled={!intent.trim() || saving}>{saving ? 'Saving…' : 'Save & discuss'}<ArrowUpRight size={13} /></button></div>
        {creationError ? <p className="goals-service" role="status">Goal could not be saved. Your draft is kept. Retry Save &amp; discuss. <span>{creationError}</span></p> : null}
      </form> : null}
      <div className={`goals-collection goals-collection--${view}`} role="region" aria-label="Global goals">
        {filteredDemands.length === 0 ? <p className="goals-empty">{projectedDemands.length ? 'No goals match this view.' : 'Start with an outcome you want to achieve.'}</p> : view === 'list' ? <div className="goals-list">{filteredDemands.map(renderRow)}</div> : <div className="goals-board" aria-label="Goals by work status">{DEMAND_STATUS_IDS.filter((status) => columns[status].length > 0 || !['done', 'cancelled'].includes(status)).map((status) => <section className="goals-board-column" key={status} data-status={status}><header><strong>{GOAL_STATUS_LABELS[status]}</strong><span>{columns[status].length}</span></header>{columns[status].map(renderRow)}{columns[status].length === 0 ? <p className="goals-board-column__empty">—</p> : null}</section>)}</div>}
      </div>
      <footer className="goals-footer"><span>{filteredDemands.length} of {projectedDemands.length} goals{view === 'board' ? ' · Work status' : ''}</span><button type="button" aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}>{showHistory ? 'Hide finished' : 'Show finished'}</button></footer>
    </div>
    {selectedDemand ? <GoalDetail key={selectedDemand.id} demand={selectedDemand} acknowledgementFeedback={acknowledgementFeedback[selectedDemand.id] ?? EMPTY_GOAL_ACKNOWLEDGEMENT} onAcknowledgementFeedbackChange={(patch) => setAcknowledgementFeedback(current => ({ ...current, [selectedDemand.id]: { ...(current[selectedDemand.id] ?? EMPTY_GOAL_ACKNOWLEDGEMENT), ...patch } }))} draft={goalDrafts.current.get(selectedDemand.id) ?? {}} onDraftChange={(field, value) => { const current = goalDrafts.current.get(selectedDemand.id) ?? {}; goalDrafts.current.set(selectedDemand.id, { ...current, [field]: value }) }} onDraftSaved={(field, value) => { const current = goalDrafts.current.get(selectedDemand.id); if (current?.[field] === value) { delete current[field]; if (!Object.keys(current).length) goalDrafts.current.delete(selectedDemand.id) } }} onClose={closeDetail} onOpenMote={() => void openMote(selectedDemand.id)} onGrill={() => void openMote(selectedDemand.id, 'grill')} onGrounding={() => void openMote(selectedDemand.id, 'grounding')} motePending={motePending[selectedDemand.id] ?? null} moteError={moteErrors[selectedDemand.id] ?? null} onRetryMote={() => { const mode = moteErrors[selectedDemand.id]?.mode; void openMote(selectedDemand.id, mode === 'open' ? undefined : mode) }} /> : selectedDemandId ? <aside className="goals-detail"><button className="goals-button" onClick={closeDetail}>Back to goals</button><p className="goals-service">The selected goal is not available yet. Its identity is kept while recovery continues.</p></aside> : null}
  </section>
}
